// 课表「多设备刷新」永久回归（1.1.7）。
//
// 用户真机现象：**电脑版已经预约、手机版课表上看不到**，顶部还挂着一行
// 「课表暂未更新，可点此重试」。本文件把这条链路钉死。
//
// 真实链路（不是推测，是代码里逐行读出来的）：
//   下拉刷新 / 进入课表 → ui.refreshActiveView() → adapter.readActive()
//     → ⓪ 【1.1.9 第 2 轮新增】本机有已验缓存时，先发一跳
//          `{action:'integrity'}` 做**校验式首跳**：云端的 integrity 会现场把八个集合
//          重读一遍、算出真实指纹，客户端拿它与本机缓存的
//          datasetId / revision / checksum / byteSize / summary 逐项比；
//          五项全等 → 直接吃缓存，**不再做下面的完整读取**；
//          有一项不等（世界动了 / 缓存过期 / 指纹损坏）→ **继续走完整读取**。
//          ⚠️ 首跳不经过 metadata，所以"完整读取发生了几次"要看 metadata 计数。
//     → ① {action:'metadata'}  拿 dataRevision = R
//     → ② {action:'page'} × 8 个集合（解 base64 分页）
//     → ③ {action:'integrity'} —— 云端**重新**读一遍 8 个集合算指纹，客户端再拿
//          自己算出来的 checksum / byteSize / summary / revision 与 ③ 比。
//   只有**整份逐项一致**，客户端才把新快照落进 coachCloudActiveCache。
//
// ★ 1.1.9 第 3 轮（真机账本定案）在此之上又钉两件：
//   · 用户下拉那一跳的**只读校验首跳不进航位** —— 在途后台整读还挂着时它就已经发出去了
//     （真机账本：用户那轮 queueMs=8021ms、totalMs=1022ms、pages=0，8 秒全在排队干等）；
//   · 三个点（stopPullDownRefresh）与"页面可交互状态"**不再绑在整条后台同步链上** ——
//     一下拉就收掉，读取照旧在后台跑完（换视图的判据一个字没改：仍然只有 ok 之后才 render）。
//
// 于是「A 设备的写入正好落在 B 的读取窗口里」时：
//   ③ 的 revision 已经是 R+1，而 ① 说的是 R → mismatch.revision = true
//   → 整次刷新判失败（ACTIVE_READ_INTEGRITY_FAILED）→ **一次都不重试**
//   → B 的 cache 保持旧值 → 课表继续把 A 刚约走的时间显示成空闲。
// 这就是「电脑版已预约、手机版没有显示」：不是没拉到，是**拉到一半被判失败后原地放弃**。
//
// 本测试同时钉住重试边界的两侧：**只有「世界在我读的时候动了」才重试**。
//   · 真·数据不一致（checksum 对不上但 revision 没变）**不许重试**，否则会把损坏掩盖成"网络抖动"。
//   · 传输被打断同样**不许重试**，而且整次回读必须照旧抛出去（既有契约：
//     `active-read-failure-drain` 的"失败后不许继续启动剩余集合"、
//     `session-sequential-courses` ⑧ 的"整次回读只有一个 integrity 读，抛了整次就失败"）。
//
// 全部跑**真实模块**：真 data-runtime / 真 ui-cloud-command / 真 cloud-primary-adapter /
// 真 local-outbox + local-projection / 真 pages/schedule。只有云端 API 是替身，
// 且替身严格按 readMyActiveCoachData 的协议与分页格式回话。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { buildCandidateDataset } = require('../utils/candidate-dataset')
const { applyPatch } = require('./helpers/set-data')

const ROOT = path.resolve(__dirname, '..')
const COLORS = { 常规训练: { color: '#3b82f6' } }
const OWNER = 'owner-cross-device'
const DATASET = 'dataset-cross-device'
const DATE = '2026-09-25'
const TODAY_ISH = '2026-09-25'
const CTX = { trustedOwnerCoachId: OWNER, trustedDatasetId: DATASET }
const PHYSICAL = ['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
const LOGICAL = name => (name === 'student_tombstones' ? 'studentTombstones' : name)
const copy = value => JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// ——————————————————————————————————————————————————————————————
// 1. 云端替身：只实现 readMyActiveCoachData 的 metadata / page / integrity
// ——————————————————————————————————————————————————————————————
const snapshot = {
  students: [{ id: 's1', name: '假学员', phone: '13800000000', packages: [{ id: 'p1', type: '常规训练', total: 10, used: 0, remaining: 10, price: 150, status: 'active' }] }],
  bookings: [], incomes: [], sales: [],
  settings: { renewThreshold: 3, monthlyGoalSessions: 20, classCommissionRate: 40, salesCommissionRate: 10 },
  customExercises: []
}
const cloud = {
  revision: 1,
  built: null,
  // 注入点（每个都是"一整次读取里只触发一次"）
  raceIntegrityOnce: false,   // A 的写入落在 B 的 integrity 那一步（真机形状）
  revisionChangedOnce: false, // 云端自己发现 revision 变了（ACTIVE_READ_REVISION_CHANGED）
  failPageOnce: false,        // 某个集合分页的传输失败（callFunction reject）
  corruptIntegrity: false,    // 真·数据不一致：revision 没变但 checksum 对不上
  counts: { metadata: 0, page: 0, integrity: 0, business: 0 },
  // 只读通道的闸门（只读，用来造"云端还没回来"的确定性窗口，不靠 sleep 猜时长）。
  gate: null,
  raceSeq: 0
}
function rebuild() { cloud.built = buildCandidateDataset(copy(snapshot), CTX) }
rebuild()
function deviceABooks(hour, id) {
  snapshot.bookings.push({ id, studentId: 's1', studentName: '假学员', packageId: 'p1', date: DATE, hour, minute: 0, typeName: '常规训练', price: 150, status: 'booked', items: [], notes: '' })
  cloud.revision += 1
  rebuild()
}

async function callFunction({ name, data }) {
  if (name === 'coachBusinessCommand') {
    cloud.counts.business += 1
    // B 自己的写命令一律"结果未知"（模拟**本机尚未同步**的预约）。
    // 这样 Outbox 条目会留在队列里、继续参与投影 —— 正是要验的合并场景。
    return { result: data.action === 'getReceipt' ? { ok: false, found: false, code: 'RECEIPT_NOT_FOUND' } : { ok: false, code: 'COMMAND_RESULT_UNKNOWN', retrySafe: true } }
  }
  if (name !== 'readMyActiveCoachData') return { result: { ok: false, code: 'UNKNOWN_FUNCTION' } }
  const action = data.action
  // 闸门：把这一次只读调用挂住（每次只挂第一条），用来断言"云端还没回来时的那一段"里页面是什么状态。
  if (cloud.gate) { const held = cloud.gate; cloud.gate = null; await held }
  if (action === 'metadata') {
    cloud.counts.metadata += 1
    return { result: { ok: true, environment: 'production', datasetId: DATASET, dataRevision: cloud.revision, headVersion: 1, collections: PHYSICAL.slice() } }
  }
  if (action === 'page') {
    cloud.counts.page += 1
    if (cloud.failPageOnce) { cloud.failPageOnce = false; throw new Error('cloud call interrupted') }
    const rows = cloud.built.collections[LOGICAL(data.collection)] || []
    return { result: { ok: true, environment: 'production', collection: data.collection, datasetId: DATASET, dataRevision: cloud.revision, done: true, cursor: 0, nextCursor: rows.length, nextFragmentIndex: 0, encoding: 'base64-json', payload: Buffer.from(JSON.stringify(rows), 'utf8').toString('base64') } }
  }
  if (action === 'integrity') {
    cloud.counts.integrity += 1
    // A 的写入落在读取窗口内：此刻 revision 与集合都已经前进，而客户端手里的是旧那一份。
    if (cloud.raceIntegrityOnce) { cloud.raceIntegrityOnce = false; cloud.raceSeq += 1; deviceABooks(23, 'b-raced-' + cloud.raceSeq) }
    if (cloud.revisionChangedOnce) { cloud.revisionChangedOnce = false; return { result: { ok: false, code: 'ACTIVE_READ_REVISION_CHANGED', expectedRevision: cloud.revision - 1, actualRevision: cloud.revision } } }
    const integrity = copy(cloud.built.integrity)
    // 真·不一致：revision / datasetId / environment 都没变，只有指纹对不上。
    if (cloud.corruptIntegrity) integrity.checksum = 'corrupted-' + integrity.checksum
    return { result: { ok: true, environment: 'production', datasetId: DATASET, dataRevision: cloud.revision, ...integrity } }
  }
  return { result: { ok: false, code: 'INVALID_ACTION' } }
}

// ——————————————————————————————————————————————————————————————
// 2. 设备 B：真 Storage + 真 wx 替身 + 真云端 API 形态
// ——————————————————————————————————————————————————————————————
const storage = new Map()
const log = { loading: 0, hideLoading: 0, toasts: [], modals: [], pullDownStops: 0, navigations: [] }
storage.set('coachDataSourceMode', 'cloud-primary')
storage.set('coachCloudCutoverState', { status: 'cloud-primary', updatedAt: Date.now() })
global.wx = {
  cloud: { callFunction },
  getStorageSync: key => { const value = storage.get(key); return value === undefined ? undefined : copy(value) },
  setStorageSync: (key, value) => storage.set(key, copy(value)),
  showLoading() { log.loading += 1 }, hideLoading() { log.hideLoading += 1 },
  showToast(options) { log.toasts.push(options) }, showModal(options) { log.modals.push(options) },
  showTabBar() {}, hideTabBar() {}, nextTick(fn) { fn() },
  navigateTo(options) { log.navigations.push(options) },
  stopPullDownRefresh() { log.pullDownStops += 1 },
  getNetworkType() {}, onNetworkStatusChange() {}
}

let capturedPage = null
global.Page = config => { capturedPage = config }
const ui = require('../utils/ui-cloud-command')
const runtime = require('../utils/data-runtime')
const outbox = require('../utils/local-outbox')
const projection = require('../utils/local-projection')
const mutate = require('../utils/mutate')
require('../pages/schedule/schedule')

const cacheOf = () => storage.get('coachCloudActiveCache')
const cacheBookings = () => ((cacheOf() || {}).snapshot || {}).bookings || []
const bookingIds = list => list.map(item => item.id).sort()
// ⚠️ 1.1.9 第 2 轮加入「校验式首跳」之后，一次回读的**第一跳是 `integrity`**（本机有已验缓存时），
//    完整读取才从 `metadata` 起。所以这两个计数器的口径要分清：
//    · readAttempts() = metadata 次数 = **真正开始的完整读取**次数（首跳不经过 metadata）
//    · totalReads()   = 只读通道总调用数 = 首跳 + 完整读取的每一条
const readAttempts = () => cloud.counts.metadata
const totalReads = () => cloud.counts.metadata + cloud.counts.page + cloud.counts.integrity

function makePage() {
  // setData 必须与真实微信同口径：支持**路径**更新（'weekSlides[1].rows[3].cells[2].bookings'）。
  // 课表刷新就是用路径把"真的变了的格子"推给视图层的（pages/schedule/schedule.js applyLatestData）。
  const page = { data: copy(capturedPage.data), setData(patch, callback) { applyPatch(this.data, copy(patch)); if (callback) callback() } }
  for (const [name, fn] of Object.entries(capturedPage)) if (typeof fn === 'function') page[name] = fn.bind(page)
  page.data.selectedDate = TODAY_ISH
  page.data.viewMode = 'week'
  return page
}
const cellFor = (page, hour) => page.data.weekSlides[1].rows.find(row => row.hour === hour).cells.find(cell => cell.date === DATE)
async function until(predicate, label, ms = 4000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return true
    if (Date.now() - started > ms) throw new Error(`等待超时：${label}`)
    await delay(10)
  }
}
const settle = (ms = 60) => delay(ms)

;(async () => {
  // ————————————————————————————————————————————————————————————
  // 第 0 步：设备 B 建立自己的旧缓存（此时云端还没有 A 的预约）
  // ————————————————————————————————————————————————————————————
  const first = await ui.refreshActiveView()
  assert.equal(first.ok, true, '设备 B 首次回读必须成功')
  assert.deepEqual(bookingIds(cacheBookings()), [], 'B 的旧缓存里本来就没有预约')

  // ————————————————————————————————————————————————————————————
  // 第 1 步（**核心故障**）：A 的写入正好落在 B 的读取窗口内
  // ————————————————————————————————————————————————————————————
  deviceABooks(14, 'b-from-device-A')
  cloud.raceIntegrityOnce = true
  const before = totalReads()
  const raced = await ui.refreshActiveView()
  assert.equal(raced.ok, true, '读取窗口内被并发写打断后，必须自动重试并最终拿到一致快照')
  // ★ 判据口径（1.1.9 第 2 轮）：首跳**自己**就是第一次 integrity 调用，正是它撞上了这次并发写。
  //   所以"没有原地放弃"的证据是**它接着把整份数据读了一遍**（8 个集合全量分页 + 收尾校验），
  //   而不是"metadata 被调了 ≥2 次" —— 首跳路径压根不经过 metadata。
  //   （若实现是"发现变了就原地放弃"，上面那行 raced.ok 会直接是 false。）
  assert.ok(totalReads() - before >= PHYSICAL.length,
    '第一次校验发现世界动了以后，必须真的把整份数据再读一遍（绝不原地放弃），实得多出 ' + (totalReads() - before) + ' 次调用')
  assert.ok(cacheBookings().some(item => item.id === 'b-from-device-A'), '重试成功后，A 的预约必须已经落进 B 的缓存')
  assert.ok(cacheBookings().some(item => item.id === 'b-raced-1'), '打断那一次写入的内容也必须一起进来（重试读到的是它之后的一致快照）')

  // 云端自己报 revision 变了（ACTIVE_READ_REVISION_CHANGED）同理必须重试
  deviceABooks(15, 'b-from-device-A2')
  cloud.revisionChangedOnce = true
  const raced2 = await ui.refreshActiveView()
  assert.equal(raced2.ok, true, '云端报 revision 变化时必须重试而不是把整次刷新作废')
  assert.ok(cacheBookings().some(item => item.id === 'b-from-device-A2'))

  // ————————————————————————————————————————————————————————————
  // 第 2 步：边界 —— 传输被打断**不许**重试（那不是"世界动了"，是网络断了）
  //   重置整次回读 ＝ 把已经跑完的分页全部重发一遍：既违反
  //   `active-read-failure-drain`（一个分页失败后不许继续启动剩余集合、不许重启分页），
  //   也会在免费云环境把 RPC 数量翻三倍。旧契约照旧：如实失败 + 保留本机课表，
  //   用户再拉一次即可 —— 所以下面必须接着证明"下一次真的能成功"。
  // ————————————————————————————————————————————————————————————
  deviceABooks(16, 'b-from-device-A3')
  const cacheBeforeHiccup = JSON.stringify(cacheOf())
  const beforeHiccup = readAttempts()
  cloud.failPageOnce = true
  const hiccup = await ui.refreshActiveView()
  assert.equal(hiccup.ok, false, '传输被打断必须如实失败，绝不假装成功')
  assert.equal(readAttempts() - beforeHiccup, 1, '传输中断不是"世界动了"，只允许读一次，绝不重试')
  assert.equal(JSON.stringify(cacheOf()), cacheBeforeHiccup, '失败时必须逐字保留旧缓存，绝不清空')
  // 网络恢复后再拉一次 —— 这才是用户真机上会走的路径，必须能拿到 A 的预约
  const recovered = await ui.refreshActiveView()
  assert.equal(recovered.ok, true, '网络恢复后再次下拉必须成功')
  assert.ok(cacheBookings().some(item => item.id === 'b-from-device-A3'), '恢复后必须把 A 的预约拉进来')

  // ————————————————————————————————————————————————————————————
  // 第 3 步：边界 —— 真·数据不一致**不许**重试（否则会把损坏掩盖成网络抖动）
  // ————————————————————————————————————————————————————————————
  cloud.corruptIntegrity = true
  const cacheBeforeCorrupt = JSON.stringify(cacheOf())
  const beforeCorrupt = readAttempts()
  const corrupt = await ui.refreshActiveView()
  cloud.corruptIntegrity = false
  assert.equal(corrupt.ok, false, '指纹对不上必须如实失败')
  assert.equal(corrupt.code, 'ACTIVE_READ_INTEGRITY_FAILED')
  assert.equal(readAttempts() - beforeCorrupt, 1, 'revision 没变的真·不一致只允许读一次，绝不重试掩盖')
  assert.equal(JSON.stringify(cacheOf()), cacheBeforeCorrupt, '失败时缓存必须逐字保留，绝不能被清空或写坏')

  // ————————————————————————————————————————————————————————————
  // 第 4 步：课表页 —— 进入即显示本机课表，后台静默拉取
  // ————————————————————————————————————————————————————————————
  const page = makePage()
  page.onLoad()
  log.loading = 0; log.hideLoading = 0; log.toasts.length = 0; log.modals.length = 0
  // 云端先有这条（A 已经约了），而 B 的缓存还是旧的 —— 这才是"进入页面"的真实形态。
  deviceABooks(17, 'b-from-device-A4')
  page.onShow()
  // 第一帧必须是「本机已有课表」：后台回读还没返回，所以此刻屏幕上**没有**这条。
  // 这正是不许等待云端的证明 —— 页面先用本机数据渲染完了。
  assert.equal(cellFor(page, 17).bookings.length, 0, '第一帧必须先用本机已有课表渲染，不等待云端')
  await until(() => cellFor(page, 17).bookings.some(item => item.id === 'b-from-device-A4'), '进入课表后的后台静默拉取应把 A 的预约渲染出来')
  assert.equal(log.loading, 0, '刷新全程不得出现等待遮罩')
  assert.equal(log.toasts.length, 0, '正常同步不得弹任何提示')
  assert.equal(log.modals.length, 0, '正常同步不得弹任何对话框')
  assert.equal('refreshHint' in page.data, false, '课表不得再有"正在更新/可点此重试"这类提示字段')

  // ————————————————————————————————————————————————————————————
  // 第 5 步（用户要的永久回归）：设备 A 预约 → 设备 B 旧缓存 → B 下拉刷新 → 出现 A 的预约
  // ————————————————————————————————————————————————————————————
  assert.deepEqual(cellFor(page, 20).bookings, [], '下拉之前，20:00 在 B 屏幕上还是空闲的')
  deviceABooks(20, 'b-from-device-A5')          // A 已经约走 20:00
  cloud.raceIntegrityOnce = true                // 而且 A 这一下正好砸在 B 的读取窗口里
  log.loading = 0; log.toasts.length = 0; log.modals.length = 0
  await page.onPullDownRefresh()
  const pulled = cellFor(page, 20).bookings
  assert.equal(pulled.length, 1, '设备 B 下拉刷新后必须看到设备 A 刚建的预约（不能继续显示为空闲）')
  assert.equal(pulled[0].id, 'b-from-device-A5')
  assert.equal(pulled[0].bookingText, '假学员')
  assert.equal(log.pullDownStops, 1, '下拉刷新必须自己收尾（stopPullDownRefresh）')
  assert.equal(log.loading, 0, '下拉刷新不得出现等待遮罩')
  assert.equal(log.toasts.length, 0, '下拉刷新不得弹提示条')

  // ————————————————————————————————————————————————————————————
  // 第 5b 步（1.1.9 第 3 轮·本轮核心之一）：三个点必须**立刻**收起，不许等整条后台同步链
  //   真机账本定案：课程早在 7.94s（后台那一轮读完）就已经渲染出来了，三个点却还要再挂约 1 秒
  //   （它属于用户那一轮：排队 8.02s + 自己 1.02s），这 9 秒页面被系统钉在下拉态、不能滑不能点。
  //   ⇒ 判据是"云端还没回来时，三个点就必须已经收起"。
  //   ⚠️ 用**闸门**造确定性窗口（不靠 sleep 猜时长）；判别力：把 stopPullDownRefresh 放回
  //      `refreshSchedule(...).finally(...)`（旧实现），这里的 pullDownStops 会是 0，立刻变红。
  // ————————————————————————————————————————————————————————————
  let releasePull
  cloud.gate = new Promise(resolve => { releasePull = resolve })
  log.pullDownStops = 0
  log.loading = 0
  const heldPull = page.onPullDownRefresh()
  await delay(25)
  assert.equal(log.pullDownStops, 1,
    '★ 云端读取还没回来时，三个点就必须已经收起（页面立刻恢复可滑可点）—— 绝不许再等整条后台链')
  assert.equal(log.loading, 0, '提前收尾同样不得引入任何遮罩')
  releasePull()
  await heldPull
  assert.equal(cellFor(page, 20).bookings.length, 1, '提前收尾不得影响数据：该显示的仍然显示')

  // ————————————————————————————————————————————————————————————
  // 第 6 步：云端刷新成功，但**不许覆盖本机还没同步的预约**
  // ————————————————————————————————————————————————————————————
  // 设备 B 自己本机先行约的 21:00：写命令还没被云端确认（替身让它"结果未知"），
  // Outbox 里留着这条，投影必须继续把它叠加在**刷新之后**的新 cache 上。
  const localResult = await mutate('createBooking', { studentId: 's1', packageId: 'p1', date: DATE, hour: 21, minute: 0 }, { key: 'cross-device-local-booking', local: () => {} })
  assert.ok(localResult && localResult.local, 'B 的本机先行预约必须立即成立')
  page.saved()
  assert.equal(cellFor(page, 21).bookings.length, 1, '本机先行预约必须立刻出现在课表上（零等待）')
  const scope = { environment: 'production', datasetId: cacheOf().datasetId, base: cacheOf().snapshot, revision: cacheOf().revision }
  assert.equal(outbox.openEntries(scope).length, 1, '这条本机预约此刻还必须留在 Outbox 里（云端尚未确认）')
  projection.invalidate()

  deviceABooks(22, 'b-from-device-A6')          // 云端又前进了一步
  await page.onPullDownRefresh()
  page.saved()
  assert.ok(cacheBookings().some(item => item.id === 'b-from-device-A6'), '云端新数据必须已经进缓存')
  const localCell = cellFor(page, 21).bookings
  assert.equal(localCell.length, 1, '本机未同步的预约在一次云端刷新之后必须仍然可见，且只有一条')
  assert.equal(outbox.openEntries(scope).length, 1, '云端刷新绝不能把本机的 Outbox 条目冲掉')

  // ————————————————————————————————————————————————————————————
  // 第 7 步：云端持续失败时必须保留本机课表（不清空），且一个字都不提示
  // ————————————————————————————————————————————————————————————
  const keptBefore = cellFor(page, 20).bookings.length
  assert.equal(keptBefore, 1)
  cloud.corruptIntegrity = true
  log.loading = 0; log.toasts.length = 0; log.modals.length = 0
  const failed = await page.onPullDownRefresh()
  cloud.corruptIntegrity = false
  assert.equal(failed === undefined || failed === null || typeof failed === 'object', true)
  assert.equal(cellFor(page, 20).bookings.length, 1, '云端读取失败必须保留本机当前课表，绝不能把页面清空')
  assert.equal(cellFor(page, 21).bookings.length, 1, '本机未同步的预约同样必须保留')
  assert.equal(log.loading, 0, '失败时不得出现阻塞遮罩')
  assert.equal(log.toasts.length, 0, '失败时不得弹提示')
  assert.equal(log.modals.length, 0, '失败时不得弹对话框')

  // ————————————————————————————————————————————————————————————
  // 第 8 步：结构契约（静态）
  // ————————————————————————————————————————————————————————————
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/schedule/schedule.wxml'), 'utf8')
  const logic = fs.readFileSync(path.join(ROOT, 'pages/schedule/schedule.js'), 'utf8')
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'pages/schedule/schedule.json'), 'utf8'))
  // 钉契约不钉拼写：断言前先剥掉注释，避免"注释里提过字样"就算数。
  const strip = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')
  const bareLogic = strip(logic), bareWxml = wxml.replace(/<!--[\s\S]*?-->/g, '')
  assert.equal(/课表暂未更新/.test(bareWxml), false, '「课表暂未更新，可点此重试」整行必须删除')
  assert.equal(/课表暂未更新/.test(bareLogic), false, '逻辑里也不许再产生这句提示')
  assert.equal(/refreshHint/.test(bareWxml) || /refreshHint/.test(bareLogic), false, 'refreshHint 这套提示必须整体移除，不允许换名字保留')
  assert.equal(/正在更新课表/.test(bareLogic), false, '不得再显示"正在更新课表"这类阻塞提示')
  assert.equal(config.enablePullDownRefresh, true, '必须支持微信原生下拉刷新')
  assert.ok(/onPullDownRefresh\s*\(/.test(bareLogic), '必须实现 onPullDownRefresh')
  assert.ok(/settlePullDown/.test(bareLogic), '必须有"立刻收尾"的入口，与后台同步链解绑')
  assert.equal(/\.finally\([^)]*stopPullDownRefresh/.test(bareLogic.replace(/\s+/g, ' ')), false,
    '★ 三个点绝不许再挂在整条刷新链的 finally 上 —— 那正是"课程已经显示、页面还卡着不能滑"的原因')
  assert.ok(/refreshActiveView/.test(bareLogic), '下拉刷新必须走真正读云端的入口，不能只刷本机缓存')
  // ⚠️ 切片必须**只取 refreshSchedule 的函数体**：旧写法是
  //   slice(indexOf('refreshSchedule'), indexOf('loadScheduleData'))——
  //   但 `this.loadScheduleData()` 在 onShow 里就出现过（位置比 refreshSchedule 更靠前），
  //   于是 begin > end ⇒ 切出来是空串 ⇒ 这条断言**永远为真**（假绿）。
  //   现在取下界 = `async refreshSchedule`，上界 = 它之后的 `loadScheduleData()` 定义。
  const refreshStart = bareLogic.indexOf('async refreshSchedule')
  const refreshEnd = bareLogic.indexOf('loadScheduleData()', refreshStart)
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, '找不到 refreshSchedule 的函数体边界，静态判据无法成立')
  const refreshBlock = bareLogic.slice(refreshStart, refreshEnd)
  assert.ok(refreshBlock.length > 200, 'refreshSchedule 函数体切片太短，判据不可信（实得 ' + refreshBlock.length + ' 字符）')
  assert.equal(/showToast|showModal|showLoading/.test(refreshBlock), false, '课表刷新路径不得出现任何提示/遮罩调用')
  assert.equal(/wx\.startPullDownRefresh/.test(bareWxml), false, '不许用"新刷新控件"替代被删掉的那一行')
  assert.equal(/bindtap="refreshSchedule"/.test(bareWxml), false, '被删掉的整行不得留下可点区域')

  // ★ 几何契约：微信原生下拉刷新的硬前提是**页面存在可滚动空间**。
  //   页面高度 == 窗口高度时，系统照旧播下拉动画，但 onPullDownRefresh **一次都不会执行** ——
  //   所以上面那些"入口存在"的断言全都成立、功能却完全不工作。1.1.7 真机就是栽在这里。
  //   自动化里 stopPullDownRefresh 永远会被（被直接调用的）回调调到，因此这条缺陷
  //   同样只有真机能发现 → 必须用几何把它钉死，而不是靠"入口看起来在"。
  const wxss = fs.readFileSync(path.join(ROOT, 'pages/schedule/schedule.wxss'), 'utf8')
  const bareWxss = wxss.replace(/\/\*[\s\S]*?\*\//g, '')
  const pageBodies = []
  const pageRe = /\.schedule-page(?![-\w])\s*\{([^}]*)\}/g
  let pageMatch
  while ((pageMatch = pageRe.exec(bareWxss))) pageBodies.push(pageMatch[1])
  assert.ok(pageBodies.length, '找不到 .schedule-page 规则')
  const height = pageBodies.map(body => /height\s*:\s*calc\(100vh\s*\+\s*([\d.]+)rpx\)/.exec(body)).find(Boolean)
  assert.ok(height,
    '.schedule-page 高度必须是 calc(100vh + Nrpx)：恰好 100vh 时页面无可滚动空间，'
    + '微信的原生下拉刷新回调永远不会触发（手指划下去只播动画，什么都不发生）')
  assert.ok(Number(height[1]) > 0, '可滚动余量必须大于 0，实得 ' + height[1] + 'rpx')
  const padBottom = pageBodies.map(body => /padding\s*:\s*[\d.]+rpx\s+[\d.]+rpx\s+([\d.]+)rpx/.exec(body)).find(Boolean)
  assert.ok(padBottom, '.schedule-page 必须显式写出三段 padding（抬高高度时必须同步补偿 padding-bottom）')
  // ⛔ 三次口径更新（2026-10-02）：padding-bottom 从 40rpx 改成 **42rpx** —— 补的是 `.calendar` 自己的
  //    1rpx content-box 边框（上下共 2rpx）。不减这 2rpx，课表底会推出视口 ⇒ 滑到底 23:00 行被裁 1px
  //    （iPhone 6/7/8 实测 556 > 555）。护栏的**本意**保住两条：① 下拉余量不被吃掉 ⇒ padding-bottom
  //    不得小于 height 多出的余量；② 内容盒不许被悄悄大改 ⇒ 超出余量的部分上限 4rpx（当前用 2rpx，
  //    且在 wxss 注释里写明缘由）。原来是"恰好相等"，那是因为当时不存在边框补偿这件事。
  const pbVal = Number(padBottom[1])
  const extraRpx = Number(height[1])
  assert.ok(pbVal >= extraRpx,
    'padding-bottom（' + pbVal + 'rpx）不得小于页面多出的余量（' + extraRpx + 'rpx）：'
    + '小于它 ⇒ 内容盒比 1.1.9 事故前还高，下拉刷新余量被吃掉（事故复发条件）')
  assert.ok(pbVal - extraRpx <= 4,
    'padding-bottom 比余量多 ' + (pbVal - extraRpx) + 'rpx：允许上限 4rpx（三次口径用 2rpx 补 .calendar 的 '
    + 'content-box 边框，见 wxss 注释），超出 ⇒ 要么悄悄改了观感，要么忘了写注释')

  console.log('schedule cross-device refresh: PASS (A 写入落在 B 读取窗口内仍能拉到；下拉刷新读到云端；失败保留本机；本机 pending 不被覆盖；无任何刷新提示；重试只限 revision 动了)')
})().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 })
