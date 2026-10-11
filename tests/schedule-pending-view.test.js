// 课表页渲染回归：待确认预约从第一帧起就使用与正式课程**完全相同**的课程视觉（秒回验收标准），
// 但内部状态完全独立：绝不进 getDB / active cache，点击按待确认处理，转正时沿用同一个渲染 key 不重建节点。
// 本测试跑的是真实的合并器（booking-optimistic.mergeBookings），不是 mock。
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const copy = value => JSON.parse(JSON.stringify(value))
const { applyPatch } = require('./helpers/set-data')

const DATASET = 'sandbox-dataset'
const PENDING_KEY = 'stu-2|pkg-2|2026-09-16|16|0'
const PENDING_PAYLOAD = { studentId: 'stu-2', packageId: 'pkg-2', date: '2026-09-16', hour: 16, minute: 0 }
const PENDING_VIEW = {
  id: `pending:${PENDING_KEY}`, studentId: 'stu-2', studentName: '假学员二', packageId: 'pkg-2', packageIndex: 0,
  date: '2026-09-16', hour: 16, minute: 0, typeName: '拉伸恢复', price: 120, status: 'booked', createdAt: 1
}
const REAL_BOOKING = { id: 'b-real', studentId: 'stu-1', packageId: 'pkg-1', date: '2026-09-16', hour: 14, minute: 0, typeName: '常规训练', price: 100, status: 'done' }
// 与待确认记录完全对应的云端正式记录：模拟「命令已成功、cache 已刷新、本机标记还没清」的那一帧。
const MATCHED_BOOKING = { id: 'b-server-9', studentId: 'stu-2', packageId: 'pkg-2', date: '2026-09-16', hour: 16, minute: 0, typeName: '拉伸恢复', price: 120, status: 'booked' }
const db = {
  students: [{ id: 'stu-1', name: '假学员一' }, { id: 'stu-2', name: '假学员二' }],
  bookings: [copy(REAL_BOOKING)], incomes: [], sales: [], settings: {}, customExercises: []
}
const TYPES = { 常规训练: { color: '#3b82f6' }, 拉伸恢复: { color: '#22a06b' } }

let navigated = [], modals = [], toasts = [], retries = [], resumeCalls = 0, subscriber = null, unsubscribed = 0
const storage = new Map()
global.wx = {
  showTabBar() {}, nextTick(fn) { fn() },
  navigateTo(options) { navigated.push(options) },
  showModal(options) { modals.push(options) },
  showToast(options) { toasts.push(options) },
  getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, copy(value))
}

// 真实的待确认存储 + 真实的合并器。
const { createBookingOptimistic } = require('../utils/booking-optimistic')
const pendingStore = require('../utils/pending-booking-request')
const runtime = {
  environment: () => 'sandbox',
  MODES: { ACTIVATING: 'activating', PENDING: 'cutover-pending', CLOUD: 'cloud' },
  cutoverState: () => ({ status: 'cloud' })
}
const adapter = { getState: () => ({ datasetId: DATASET, revision: 3 }) }
const optimistic = createBookingOptimistic({
  runtime, pending: pendingStore, adapter,
  readDatasetId: () => DATASET, readSnapshot: () => copy(db), showToast() {}, showModal() {}
})
assert.ok(pendingStore.create('sandbox', DATASET, PENDING_KEY, 'req-view', PENDING_PAYLOAD, PENDING_VIEW, 1).created)

const runtimePath = require.resolve('../utils/data-runtime'), commandPath = require.resolve('../utils/ui-cloud-command')
const oldRuntime = require.cache[runtimePath], oldCommand = require.cache[commandPath]
require.cache[runtimePath] = { id: runtimePath, filename: runtimePath, loaded: true, exports: {
  getDB: () => copy(db),
  pad: value => String(value).padStart(2, '0'),
  typeOf: name => TYPES[name] || TYPES['常规训练']
} }
require.cache[commandPath] = { id: commandPath, filename: commandPath, loaded: true, exports: {
  mergePendingBookings: bookings => optimistic.mergeBookings(bookings),
  pendingBookingRecords: () => optimistic.records(),
  resumePendingBookings: () => { resumeCalls++; return Promise.resolve({ ok: true, checked: 0 }) },
  subscribePendingBookings: listener => { subscriber = listener; return () => { unsubscribed++ } },
  retryPendingBooking: key => { retries.push(key); return Promise.resolve({ ok: true }) }
} }
let captured = null
global.Page = page => { captured = page }
require('../pages/schedule/schedule')

function makePage() {
  // setData 与真实微信同口径：支持路径更新（课表刷新用 'weekSlides[1].rows[3].cells[2].bookings'
  // 只推真的变了的格子）。只会 Object.assign 的假件会把路径键当成字面量键，那是假件的缺陷。
  const page = { data: copy(captured.data), setData(patch, callback) { applyPatch(this.data, copy(patch)); if (callback) callback() } }
  for (const [name, fn] of Object.entries(captured)) if (typeof fn === 'function') page[name] = fn.bind(page)
  return page
}
const cellFor = (page, date, hour) => page.data.weekSlides[1].rows.find(row => row.hour === hour).cells.find(cell => cell.date === date)
// 去掉颜色字面量后剩下的就是「视觉模板」，用于断言待确认块与正式块同源。
const templateOf = style => style.replace(/#[0-9a-fA-F]{3,8}/g, '#C')

;(async () => {
  const page = makePage()
  page.onLoad()
  assert.ok(subscriber, 'onLoad 必须订阅待确认预约变化')
  page.setData({ selectedDate: '2026-09-16', viewMode: 'week' })
  page.onShow()

  // 1. 合并发生在 getDB() 之后，且正式快照本身没有被污染
  assert.equal(page.scheduleCache.db.bookings.length, 1, 'getDB() 结果不得包含待确认预约')
  assert.equal(page.scheduleCache.db.bookings.some(item => item.pending), false)

  // 2. 第一帧视觉：待确认块必须与正式块使用同一个视觉模板（这就是「秒回」的核心）
  const pendingCell = cellFor(page, '2026-09-16', 16)
  assert.equal(pendingCell.bookings.length, 1)
  const pending = pendingCell.bookings[0]
  assert.equal(pending.pending, true, '内部待确认标记必须保留')
  assert.equal(pending.id, `pending:${PENDING_KEY}`)
  assert.equal(pending.pendingKey, PENDING_KEY)
  assert.equal(pending.pendingStatus, 'pending', '内部状态必须能区分待确认 / 结果未知 / 同步中')
  const realCell = cellFor(page, '2026-09-16', 14)
  const real = realCell.bookings[0]
  assert.equal(real.pending, false)
  assert.equal(templateOf(pending.blockStyle), templateOf(real.blockStyle), '待确认块必须与正式块同源，不允许另有「待确认」样式')
  assert.equal(pending.blockStyle, 'border-color:#22a06b;background:#22a06b', '待确认块必须是实心类型色')
  assert.equal(real.blockStyle, 'border-color:#3b82f6;background:#3b82f6', '正式块视觉必须保持原样')
  assert.ok(!/dashed|#fff|#ffffff/i.test(pending.blockStyle), '不允许虚线 / 白底等待确认视觉')
  assert.equal(pending.bookingText, '假学员二', '文字不得带「⋯」等未完成标记')
  assert.equal(pending.blockStyle.includes('undefined'), false)

  // 3. 日视图标签同样不得出现「提交中」
  page.setData({ selectedDate: '2026-09-16', viewMode: 'day' })
  page.renderDay()
  const dayPending = page.data.dayRows.find(row => row.hour === 16).cell.bookings[0]
  assert.equal(dayPending.dayLabel, '拉伸恢复', '日视图不得写成「提交中 · 拉伸恢复」')
  assert.equal(page.data.dayRows.find(row => row.hour === 14).cell.bookings[0].dayLabel, '常规训练')

  // 4. 稳定渲染 key：待确认块与它转正后的正式记录必须同名，否则小程序会销毁重建节点（用户看到闪一下）
  assert.equal(pending.viewKey, `stable:${PENDING_KEY}`, '待确认块必须带稳定 key')
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/schedule/schedule.wxml'), 'utf8')
  assert.ok(wxml.includes('wx:key="viewKey"'), '课表必须用稳定渲染 key，不能用会变的 booking.id')

  // 5. 刚约完就点这条课：直接进入「本机编辑态」——用真实时段业务键，绝不伪造 bookingId。
  //    这正是「约课秒回 → 立即能进课」的验收标准：不弹窗、不打断。
  page.setData({ viewMode: 'week' })
  page.booking({ currentTarget: { dataset: { id: pending.id, pending: PENDING_KEY } } })
  assert.equal(navigated.length, 1, '刚约完必须能立即进入课程')
  assert.ok(navigated[0].url.includes('/pages/session/session?pending='), '必须用本机待确认业务键进入')
  assert.ok(navigated[0].url.includes(encodeURIComponent(PENDING_KEY)), '进入课程必须带上该时段业务键')
  assert.equal(navigated[0].url.includes('?id='), false, '本机编辑态不得携带任何 bookingId')
  assert.equal(modals.length, 0, '正常确认中不该打断用户')

  // 6. 确认卡住（status=unknown）时先说明一句，并给出两条安全出口：
  //    「进入课程」继续本机编辑态；「重新确认」只查 receipt 一次（幂等，绝不盲目重发）。
  pendingStore.patch('sandbox', DATASET, PENDING_KEY, 'req-view', { status: 'unknown' })
  page.booking({ currentTarget: { dataset: { id: pending.id, pending: PENDING_KEY } } })
  assert.equal(navigated.length, 1, '卡住时应先说明，不直接跳转')
  assert.equal(modals.length, 1)
  assert.equal(modals[0].title, '预约确认中')
  assert.ok(modals[0].content.includes('重新确认'))
  modals[0].success({ confirm: true })
  assert.equal(navigated.length, 2, '「进入课程」必须能进本机编辑态')
  modals[0].success({ confirm: false, cancel: true })
  assert.deepEqual(retries, [PENDING_KEY], '「重新确认」必须带上该时段业务键并走幂等查单')

  // 7. 点正式块：照旧按 bookingId 进详情页
  page.booking({ currentTarget: { dataset: { id: real.id, pending: undefined } } })
  assert.equal(navigated.length, 3, '第 5 步 1 次 + 第 6 步「进入课程」1 次 + 正式块 1 次')
  assert.ok(navigated[2].url.includes('/pages/session/session?id=b-real'), '正式块必须按 bookingId 进入')

  // 8. 分享可约必须把待确认预约算成已占用，不能把刚约的时段再发出去。
  //    ⛔ 2026-09-29 口径（"结束不得晚于 24:00"、23:00 是最后一个起点）已被
  //       **2026-10-01 二次口径**：30 分钟一档、最晚 **23:00** 开课、课程**当天结束**（23:00 → 24:00）。
  //    ⭐ **2026-10-03 四次口径**：起点 07:00 → **06:00**（教练新建与会员自助同一条规则；
  //       07:00 之前不再是"补录专属"，见 package-occupancy 顶部说明）。
  //       ① 起点 06:00 —— 与入口闸门同一条常量，不写死数字。
  //       ② 终点 = 最晚开课 23:00 再往后一节课 ⇒ 24:00。
  const ranges = page.availableRanges('2026-09-16')
  const occupancy = require('../utils/package-occupancy')
  const startLabel = occupancy.EARLIEST_START_LABEL
  assert.deepEqual(ranges, [`${startLabel}–14:00`, '15:00–16:00', '17:00–24:00'],
    `待确认预约必须占用时段，且窗口必须是 ${startLabel}–24:00（实测 ${JSON.stringify(ranges)}）`)
  assert.equal(ranges[ranges.length - 1].endsWith('24:00'), true,
    '最后一段止于 24:00（最晚开课 23:00 + 一节课；课不再跨午夜）')

  // 8b. ⭐ 课表格子：23:00 之后的格子**不能用来新建**预约，但必须**明确提示** ——
  //     点了一点反应都没有是最难查的一类故障（静默 = 事故放大器）。
  //     格子本身保留显示：历史上若真有跨午夜的课，仍然必须看得见。
  const modalsBefore = modals.length
  page.cell({ currentTarget: { dataset: { date: '2026-09-16', hour: 24 } } })
  assert.equal(page.data.modal, false, '24:00 的格子不许打开预约面板（晚于最晚开课 23:00）')
  assert.equal(modals.length, modalsBefore + 1, '必须给出明确提示，不许静默忽略')
  assert.ok(modals[modals.length - 1].content.includes('23:00'),
    `提示必须说明最晚开课 23:00（实测 ${JSON.stringify(modals[modals.length - 1])}）`)
  // ⭐ 23:00 开始、次日 00:00 结束 ⇒ 必须仍然能新建（跨午夜结束是合法的）。
  page.cell({ currentTarget: { dataset: { date: '2026-09-16', hour: 23 } } })
  assert.equal(page.data.modal, true, '23:00 开始、次日 00:00 结束 ⇒ 必须还能新建预约')
  page.setData({ modal: false })

  // 9. 待确认状态变化时课表自动重绘 —— 判据看**结果**（视图数据必须跟着变），
  //    而不是看它内部调了哪个方法。
  //    ⚠️ 旧判据是"数 renderCurrentView 被调了几次"，那是把实现细节当契约：
  //    1.1.9 第 4 轮把这一段改成"只把真的变了的格子推给视图层、数据没变时一次 setData 都不发"，
  //    "调了几个方法"这个量从此不再说明任何事 —— 有意义的是视图数据有没有跟着变。
  //    判别力：订阅回调若不重绘（或路径推送没落到数据上），下面的 pendingStatus 会停在旧值。
  const statusBefore = cellFor(page, '2026-09-16', 16).bookings[0].pendingStatus
  assert.notEqual(statusBefore, 'syncing', '构造判别力：此刻视图里的状态必须还不是 syncing')
  pendingStore.patch('sandbox', DATASET, PENDING_KEY, 'req-view', { status: 'syncing' })
  subscriber()
  assert.equal(cellFor(page, '2026-09-16', 16).bookings[0].pendingStatus, 'syncing',
    '订阅回调必须让课表跟着本机意图变（这条待确认预约的状态已经变成 syncing，视图必须已经跟上）')

  // 10. 重进页面必须恢复待确认预约；离页解除订阅
  assert.ok(resumeCalls >= 1, 'onShow 必须尝试恢复待确认预约')
  page.onUnload()
  assert.equal(unsubscribed, 1)

  // 11. 月视图把待确认预约计入当天课程数
  page.setData({ selectedDate: '2026-09-16', viewMode: 'month' })
  page.renderMonth()
  const day = page.data.monthDays.find(item => item.date === '2026-09-16')
  assert.equal(day.count, 2, '月视图必须同时反映正式课程与待确认预约')
  assert.equal(day.done, 1)

  // 12. 转正那一帧：cache 已出现正式记录、本机待确认标记还没清 ——
  //     此时必须只渲染一条（否则用户会看到两条），且沿用同一个渲染 key（否则会闪）。
  page.setData({ viewMode: 'week' })
  db.bookings.push(copy(MATCHED_BOOKING))
  page.saved()
  const afterCell = cellFor(page, '2026-09-16', 16)
  assert.equal(afterCell.bookings.length, 1, '转正瞬间不得同时出现正式块与待确认块（重复课程块）')
  assert.equal(afterCell.bookings[0].pending, false, '接管的必须是正式记录')
  assert.equal(afterCell.bookings[0].id, 'b-server-9')
  assert.equal(afterCell.bookings[0].viewKey, `stable:${PENDING_KEY}`, '转正必须沿用同一个渲染 key，节点不重建、零闪烁')
  assert.equal(templateOf(afterCell.bookings[0].blockStyle), templateOf(pending.blockStyle), '转正前后视觉必须逐字相同')

  // 13. 静态：课表不再有任何「待确认专用视觉」
  assert.equal(wxml.includes('pending-block'), false, '不允许再用独立 pending-block 视觉 class')
  assert.ok(wxml.includes('data-pending="{{booking.pendingKey}}"'), '周视图必须传出待确认标识')
  assert.ok(wxml.includes('data-pending="{{item.pendingKey}}"'), '日视图必须传出待确认标识')
  const wxss = fs.readFileSync(path.join(__dirname, '../pages/schedule/schedule.wxss'), 'utf8')
  assert.equal(wxss.includes('pendingBlockPulse'), false, '不允许再用呼吸/闪烁动画把待确认推到用户眼前')

  console.log('schedule pending view tests: PASS (first-frame identical visuals, stable render key, view-layer merge only, pending never enters getDB, tap guard)')
})().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 }).finally(() => {
  if (oldRuntime) require.cache[runtimePath] = oldRuntime; else delete require.cache[runtimePath]
  if (oldCommand) require.cache[commandPath] = oldCommand; else delete require.cache[commandPath]
})
