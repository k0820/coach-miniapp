// 课表「安全数据已到达 → 立即显示」永久回归（1.1.9 第 4 轮）。
//
// 真机形状：读取层账本那一行（校验通过、cache 已落盘）出现在约 3 秒，课程块却要到约 5 秒
// 才出现 —— 差的这约 2 秒整个落在「拿到 result.ok 之后」这一段。同步层已冻结（不再动首跳 /
// integrity / 分页 / 并发 / 云函数 / 读取安全规则），所以这一轮只允许改这一段。
//
// 旧实现在这一段里做了两件事，两件都是刷新专属的额外工作：
//   ① **做了两遍整屏重绘**：notifyView → 订阅回调 saved() 一次，refreshSchedule 自己再一次；
//   ② 每一遍都**整份重推三屏 378 个格子 / 约 50KB**，并顺带把 swiperCurrent=1、
//      swiperDuration 0→280 重写一遍 —— 等于每次数据刷新都让 swiper 把三屏子节点重排一遍。
// 工作量实测见 _p22/measure-ui.js：一次刷新在这一段 = 2 次装载 + 2 次整屏推送（101 092 B / 756 格）。
//
// 现在这一段只允许做一次最小推送：逐格比对，只把真的变了的格子按路径推下去；一个格子都没变
// 就**一次 setData 都不发**；并且**绝不碰 swiperCurrent / swiperDuration**。
//
// ⚠️ 一边都不许放松的边界（本文件逐条钉住）：
//   · 只有 result.ok（读过云端且通过全部校验）之后才推 —— 读取失败必须逐字保留本机课表；
//   · 第一次进入 / 换过周或切过视图（结构对不上）照旧走完整重绘，那里才需要重置 swiper；
//   · 数据是真的变了才推：少推不许变成"不推"，块该出现必须出现。
//
// 全部跑**真实模块**：真 data-runtime / 真 ui-cloud-command / 真 cloud-primary-adapter /
// 真 local-outbox + local-projection / 真 utils/ui-timing / 真 pages/schedule。
// setData 假件与真实微信同口径：支持**路径**更新（tests/helpers/set-data.js）。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { buildCandidateDataset } = require('../utils/candidate-dataset')
const { applyPatch } = require('./helpers/set-data')

const ROOT = path.resolve(__dirname, '..')
const COLORS = { 常规训练: { color: '#3b82f6' } }
const OWNER = 'owner-instant-render'
const DATASET = 'dataset-instant-render'
const DATE = '2026-09-25'
const CTX = { trustedOwnerCoachId: OWNER, trustedDatasetId: DATASET }
const PHYSICAL = ['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
const LOGICAL = name => (name === 'student_tombstones' ? 'studentTombstones' : name)
const copy = value => JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// ——————————————————————————————————————————————————————————————
// 1. 云端替身：严格按 readMyActiveCoachData 的协议回话
// ——————————————————————————————————————————————————————————————
const snapshot = {
  students: [{ id: 's1', name: '假学员', phone: '13800000000', packages: [{ id: 'p1', type: '常规训练', total: 10, used: 0, remaining: 10, price: 150, status: 'active' }] }],
  bookings: [], incomes: [], sales: [],
  settings: { renewThreshold: 3, monthlyGoalSessions: 20, classCommissionRate: 40, salesCommissionRate: 10 },
  customExercises: []
}
const cloud = { revision: 1, built: null, corruptIntegrity: false, counts: { metadata: 0, page: 0, integrity: 0 } }
const rebuild = () => { cloud.built = buildCandidateDataset(copy(snapshot), CTX) }
rebuild()
function deviceABooks(hour, id) {
  snapshot.bookings.push({ id, studentId: 's1', studentName: '假学员', packageId: 'p1', date: DATE, hour, minute: 0, typeName: '常规训练', price: 150, status: 'booked', items: [], notes: '' })
  cloud.revision += 1
  rebuild()
}
async function callFunction({ name, data }) {
  if (name !== 'readMyActiveCoachData') return { result: { ok: false, code: 'UNKNOWN_FUNCTION' } }
  if (data.action === 'metadata') {
    cloud.counts.metadata += 1
    return { result: { ok: true, environment: 'production', datasetId: DATASET, dataRevision: cloud.revision, headVersion: 1, collections: PHYSICAL.slice() } }
  }
  if (data.action === 'page') {
    cloud.counts.page += 1
    const rows = cloud.built.collections[LOGICAL(data.collection)] || []
    return { result: { ok: true, environment: 'production', collection: data.collection, datasetId: DATASET, dataRevision: cloud.revision, done: true, cursor: 0, nextCursor: rows.length, nextFragmentIndex: 0, encoding: 'base64-json', payload: Buffer.from(JSON.stringify(rows), 'utf8').toString('base64') } }
  }
  if (data.action === 'integrity') {
    cloud.counts.integrity += 1
    const integrity = copy(cloud.built.integrity)
    if (cloud.corruptIntegrity) integrity.checksum = 'corrupted-' + integrity.checksum
    return { result: { ok: true, environment: 'production', datasetId: DATASET, dataRevision: cloud.revision, ...integrity } }
  }
  return { result: { ok: false, code: 'INVALID_ACTION' } }
}

// ——————————————————————————————————————————————————————————————
// 2. 本机替身：真 Storage 行为 + 会记账的 setData
// ——————————————————————————————————————————————————————————————
const storage = new Map()
storage.set('coachDataSourceMode', 'cloud-primary')
storage.set('coachCloudCutoverState', { status: 'cloud-primary', updatedAt: Date.now() })
const log = { pullDownStops: 0, loading: 0, toasts: [], modals: [] }
global.wx = {
  cloud: { callFunction },
  getStorageSync: key => { const value = storage.get(key); return value === undefined ? undefined : copy(value) },
  setStorageSync: (key, value) => storage.set(key, copy(value)),
  removeStorageSync: key => storage.delete(key),
  showLoading() { log.loading += 1 }, hideLoading() {},
  showToast(options) { log.toasts.push(options) }, showModal(options) { log.modals.push(options) },
  showTabBar() {}, hideTabBar() {}, nextTick(fn) { fn() },
  navigateTo() {}, stopPullDownRefresh() { log.pullDownStops += 1 },
  getNetworkType() {}, onNetworkStatusChange() {}
}

let capturedPage = null
global.Page = config => { capturedPage = config }
const ui = require('../utils/ui-cloud-command')
const uiTiming = require('../utils/ui-timing')
require('../pages/schedule/schedule')

// 会记账的 setData：记下每一次推给视图层的**键**与**字节数**（真实微信里这两样就是传输量）。
// ⭐ 1.3.11：下拉刷新的紧凑提示条是**页头视图状态**（`refreshing`），不是课表数据。
//   ⇒ 记账只统计**数据推送**：否则"松手出现 / 完成收回"这两次纯视图 setData 会被误算成
//     "重复重绘"。下面那几条判据的本意是「**数据**到达 → 课表显示 只许推一次」（旧实现整份重推
//     三屏 378 格），它管不到、也不该管页头那一个布尔量。⛔ 判别力没被削弱：数据推送的键与字节
//     照旧全记（`weekSlides` 整份重推、>4KB、swiperCurrent 重写这些都会当场变红）。
const VIEW_ONLY_KEYS = ['refreshing']
let pushes = []
const isDataPush = keys => keys.some(key => VIEW_ONLY_KEYS.indexOf(key) < 0)
function makePage() {
  const page = {
    data: copy(capturedPage.data), _visible: true,
    setData(patch, callback) {
      const keys = Object.keys(patch)
      if (isDataPush(keys)) pushes.push({ keys, bytes: JSON.stringify(patch).length })
      applyPatch(this.data, copy(patch))
      if (callback) callback()
    }
  }
  for (const [name, fn] of Object.entries(capturedPage)) if (typeof fn === 'function') page[name] = fn.bind(page)
  page.data.selectedDate = DATE
  page.data.viewMode = 'week'
  return page
}
const reset = () => { pushes = [] }
const totalBytes = () => pushes.reduce((n, p) => n + p.bytes, 0)
const allKeys = () => pushes.reduce((list, p) => list.concat(p.keys), [])
// 从三屏里找出某天某小时那一格（周视图的块都在这里）。
function cellFor(page, date, hour) {
  for (let i = 0; i < (page.data.weekSlides || []).length; i++) {
    const slide = page.data.weekSlides[i]
    for (let j = 0; j < slide.rows.length; j++) {
      if (slide.rows[j].hour !== hour) continue
      for (let k = 0; k < slide.rows[j].cells.length; k++) {
        const cell = slide.rows[j].cells[k]
        if (cell.date === date) return cell
      }
    }
  }
  return null
}
async function until(predicate, label, ms = 4000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return true
    if (Date.now() - started > ms) throw new Error(`等待超时：${label}`)
    await delay(10)
  }
}

;(async () => {
  // ————————————————————————————————————————————————————————————
  // 第 0 步：建立已验缓存（走真实回读），再建课表页并让它渲染出三屏
  // ————————————————————————————————————————————————————————————
  const first = await ui.refreshActiveView()
  assert.equal(first.ok, true, '首次回读必须成功（后续判据都在这份已验缓存上）')
  const page = makePage()
  page.onLoad()
  reset()
  page.onShow()
  await until(() => page.data.weekSlides.length === 3, 'onShow 必须渲染出三屏周课表')
  assert.equal(cellFor(page, DATE, 17).bookings.length, 0, '此刻 17:00 还是空闲的')

  // ————————————————————————————————————————————————————————————
  // 第 1 步（本轮核心）：另一台设备新增一条预约 → 下拉刷新
  //   判据：这一次刷新推给视图层的必须是**那一格**，而不是整份三屏 378 个格子。
  //   判别力：旧的 renderCurrentView 会推 {weekSlides: 三屏…}（约 50KB），
  //          下面的"整份键必须不出现"和"总字节 < 4KB"会当场变红。
  // ————————————————————————————————————————————————————————————
  deviceABooks(17, 'b-instant-1')
  reset()
  log.pullDownStops = 0
  await page.onPullDownRefresh()

  const cell = cellFor(page, DATE, 17)
  assert.equal(cell.bookings.length, 1, '少推不许变成不推：A 刚建的预约必须已经出现在课表上')
  assert.equal(cell.bookings[0].id, 'b-instant-1')
  assert.equal(log.pullDownStops, 1, '下拉刷新必须自己收尾（stopPullDownRefresh）')

  const keys = allKeys()
  assert.equal(keys.includes('weekSlides'), false,
    '★ 数据到达这一段绝不许再整份重推 weekSlides（三屏 378 个格子）—— 只许按路径推变了的那几格，实得键：' + JSON.stringify(keys))
  assert.ok(totalBytes() < 4096,
    '★ 一条新预约到达时，推给视图层的总字节必须很小（只那一格），实得 ' + totalBytes() + ' B')
  const hit = keys.find(key => /^weekSlides\[\d+\]\.rows\[\d+\]\.cells\[\d+\]\.bookings$/.test(key))
  assert.ok(hit, '必须有一条"精确落在某一格课程块上"的路径推送，实得键：' + JSON.stringify(keys))
  assert.equal(keys.includes('swiperCurrent'), false,
    '★ 数据刷新绝不许重写 swiperCurrent —— 那会让 swiper 在每次刷新时重排三屏子节点（"数据早就到了、块却晚一拍"的来源）')
  assert.equal(keys.includes('swiperDuration'), false, '★ 数据刷新绝不许重写 swiperDuration')

  // 重复重绘必须已经收掉：这一段（订阅回调 + refreshSchedule 各一次）总共只许发生 **1 次** setData。
  // 旧实现是 2 次、每次约 50KB。
  assert.equal(pushes.length, 1,
    '★ "安全数据到达 → 课表显示"这一段只许发生一次 setData（订阅回调先做，refreshSchedule 再来看时数据没变 ⇒ 一次都不发），实得 ' + pushes.length + ' 次')

  // ————————————————————————————————————————————————————————————
  // 第 2 步：云端没有任何变化时，视图层必须零开销
  //   （VERIFIED_UNCHANGED ⇒ 数据一字不变 ⇒ 一次 setData 都不该发。
  //    判别力：旧实现每次刷新都整份重推，这里会是 1 次 + 约 50KB。）
  // ————————————————————————————————————————————————————————————
  reset()
  await page.onPullDownRefresh()
  assert.equal(cellFor(page, DATE, 17).bookings.length, 1, '没变化时块必须照旧在')
  assert.equal(pushes.length, 0,
    '★ 数据一字未变时，视图层必须零改动（一次 setData 都不发），实得 ' + pushes.length + ' 次 / ' + totalBytes() + ' B')

  // ————————————————————————————————————————————————————————————
  // 第 3 步：安全边界一个字不放松 —— 读取失败时绝不推任何新数据，逐字保留本机课表
  // ————————————————————————————————————————————————————————————
  deviceABooks(9, 'b-instant-must-not-show')
  cloud.corruptIntegrity = true
  reset()
  log.toasts.length = 0; log.modals.length = 0; log.loading = 0
  await page.onPullDownRefresh()
  cloud.corruptIntegrity = false
  assert.equal(cellFor(page, DATE, 9).bookings.length, 0,
    '校验失败时绝不许把未经校验的数据画上课表（失败率再高也一样）')
  assert.equal(pushes.length, 0, '校验失败时视图层必须零改动')
  assert.equal(cellFor(page, DATE, 17).bookings.length, 1, '失败时必须保留本机当前课表，绝不清空')
  assert.equal(log.toasts.length, 0, '失败时不得弹提示')
  assert.equal(log.modals.length, 0, '失败时不得弹对话框')
  assert.equal(log.loading, 0, '失败时不得出现遮罩')
  // 恢复后必须能拉到 —— 上面那条"不显示"不能是"永远显示不出来"
  reset()
  await page.onPullDownRefresh()
  assert.equal(cellFor(page, DATE, 9).bookings.length, 1, '网络恢复后再次下拉必须把这条渲染出来')

  // ————————————————————————————————————————————————————————————
  // 第 4 步：结构对不上时照旧走完整重绘（swiper 复位语义没丢）
  //   —— 第一次进入页面、换过周、切过视图都属于这一类。
  // ————————————————————————————————————————————————————————————
  const fresh = makePage()          // 初始 data 里 weekSlides = []
  fresh.onLoad()
  const beforeFallbackRows = (storage.get(uiTiming.KEY) || []).length
  reset()
  fresh.saved()
  assert.ok(allKeys().includes('weekSlides'),
    '第一次建立周视图必须走完整重绘（那时才需要重置 swiper），实得键：' + JSON.stringify(allKeys()))
  assert.equal(fresh.data.weekSlides.length, 3, '完整重绘必须真的把三屏建出来')
  assert.equal(cellFor(fresh, DATE, 17).bookings.length, 1, '完整重绘也必须把已有课程渲染出来')
  // 账本契约：兜底整屏重绘**要么不落盘**（它是页面首帧 / 切视图的常规路径，落盘只会淹掉账本），
  // **要么一旦落盘就必须带 `:full` 标记** —— 绝不许被记成 applied=false / cellsChanged=0 的
  // "什么都没做"的样子（那会让账本把"只推了几格"和"整屏重绘"混成同一种记录）。
  const rowsForFallback = (storage.get(uiTiming.KEY) || []).slice(beforeFallbackRows)
  assert.ok(rowsForFallback.every(row => /:full$/.test(String(row.reason || ''))),
    '兜底那一轮若落盘，必须如实标成 :full，实得 reason：' + JSON.stringify(rowsForFallback.map(r => r.reason)))

  // ————————————————————————————————————————————————————————————
  // 第 5 步：这一段的账本必须真的能定位那 2 秒
  //   真机形状：读取层那一行（cache 已落盘）在 3 秒，块在 5 秒 —— 差的这 2 秒必须在
  //   coachUiTimings 里被拆成 gapMs（数据已到达 → 开始装载）与 setDataMs（setData → 真上屏）两列。
  // ————————————————————————————————————————————————————————————
  const rows = storage.get(uiTiming.KEY)
  assert.ok(Array.isArray(rows) && rows.length, 'UI 账本必须已经落盘（否则真机上那 2 秒还是只能靠猜）')
  const last = rows[rows.length - 1]
  assert.deepEqual(Object.keys(last), uiTiming.FIELDS, 'UI 账本必须是定长记录（字段集合与顺序固定，按列读）')
  assert.ok(rows.some(row => row.applied === true && row.cellsChanged > 0),
    '账本必须记下"真的推了几格"')
  assert.ok(rows.some(row => row.applied === false), '账本必须记下"数据没变、一次都没推"的那一轮')

  // ————————————————————————————————————————————————————————————
  // 第 6 步：结构契约（静态，剥注释后再断言）
  // ————————————————————————————————————————————————————————————
  const logic = fs.readFileSync(path.join(ROOT, 'pages/schedule/schedule.js'), 'utf8')
  const bare = logic.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')
  assert.ok(/applyLatestData\s*\(/.test(bare), '必须有"数据到达 → 显示"的唯一入口 applyLatestData')
  assert.ok(/saved\s*\(\)\s*\{[\s\S]{0,400}?applyLatestData/.test(bare), '订阅回调 / 保存回调必须走 applyLatestData')
  const refreshStart = bare.indexOf('async refreshSchedule')
  // 区间必须**只取 refreshSchedule 的函数体**：取到 applyLatestData 的定义为止会把中间十几个方法
  // 定义一起框进来（renderCurrentView 就在其中），判据会变成永远为假的红。
  const loadDef = bare.indexOf('loadScheduleData()', refreshStart)
  assert.ok(refreshStart >= 0 && loadDef > refreshStart, '找不到 refreshSchedule 的函数体边界，静态判据无法成立')
  const refreshBlock = bare.slice(refreshStart, loadDef)
  assert.ok(/applyLatestData/.test(refreshBlock), 'refreshSchedule 拿到 ok 之后必须走 applyLatestData')
  assert.equal(/renderCurrentView/.test(refreshBlock), false,
    '★ refreshSchedule 里不许再出现整份 renderCurrentView —— 那正是"数据早就到了、块却晚一拍"的重复重绘')
  const applyDef = bare.indexOf('applyLatestData(reason')
  assert.ok(applyDef >= 0, '找不到 applyLatestData 的定义')
  const reportDef = bare.indexOf('reportRender(', applyDef)
  const applyBlock = bare.slice(applyDef, reportDef > applyDef ? reportDef : applyDef + 4000)
  assert.ok(/loadScheduleData/.test(applyBlock), 'applyLatestData 必须先装载本机投影')
  assert.equal(/setData\(/.test(applyBlock), false, 'applyLatestData 本身不许直接 setData（推送只能经 reportRender，保证记账不漏）')
  assert.equal(/swiperCurrent|swiperDuration/.test(applyBlock), false,
    '★ 数据到达这一段绝不许碰 swiper（swiper 的位置只由用户滑动与切周决定）')
  assert.ok(/:full/.test(bare), '兜底那一轮必须在账本里如实标成整屏重绘（:full），不能和"只推了几格"混成一种记录')

  console.log('schedule instant render: PASS（安全数据到达后只推变了的格子、数据没变则零推送、刷新不动 swiper、失败零推送且逐字保留本机课表、结构对不上仍走完整重绘、这一段已落账本）')
})().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 })
