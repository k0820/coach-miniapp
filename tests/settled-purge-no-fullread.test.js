// 【1.1.9 第 14 轮永久回归】命令成功后**不许再为了出队做一次 10 页完整读取**。
//
// 真机账本（2026-09-24 23:38，`coachWriteTimings`，见 PROJECT_MEMORY §85.1）：
//   23:38:15.117  A create 落云（rev 274）
//   23:38:18.020  ← 命令结束后 30ms 自动起一条 **10 页全量读**（12.1s），占住写航位
//   23:38:22.150  用户点「取消 A」⇒ 干等 7929ms，出网只要 3156ms（commandMs 11085）
//   23:38:30.162  用户点「约 B」⇒ 排在 cancel 后面再等 4819ms，出网只要 1991ms
//   23:38:36.972  云端才有 B
//   ⇒ 界面出现 A 到云端真有 B 隔了 **21.9 秒** ⇒ 手机第一次下拉只能**正确地**拿到"只有 A"。
//
// 根因（`utils/sync-engine.js`）：`purgeSettled()` 只要看到 settled 条目就**无条件**先
//   `ui.adapter.readActive()` —— 一次 10 页完整读取，而它经 adapter 的 `serialize`
//   与**写命令共用同一条航位**，于是把下一条命令堵在门外。
//
// 修法（本文件守的就是它）：出队改判「cache 已追上」= `cache.revision >= settledRevision`，
//   **零云调用**；没追上的条目继续留在队列里承担投影（它是界面上"看得见这条事实"的唯一载体），
//   等一次自然读取（页面 onShow / 用户下拉 / 启动）把 cache 推上来之后，任何一轮 flush
//   都会**免费**把它清掉。
//
// 本文件只替换「云」与 ui-cloud-command 门面，其余全部是真模块：
//   sync-engine / local-outbox / local-projection / pending-cancellation /
//   pending-completion / mutate / booking-optimistic / data-runtime。
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const PROJ = path.join(__dirname, '..')
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const settle = async (rounds = 40) => { for (let i = 0; i < rounds; i++) await delay(1) }

const DATASET = 'ds-purge'
const DATE = '2026-09-24'
const HOUR = 14

// ---------------------------------------------------------------- Storage / wx
const store = {}
const ui = { toasts: [], modals: [], calls: [] }
global.wx = {
  getStorageSync: key => copy(store[key]),
  setStorageSync: (key, value) => { store[key] = copy(value) },
  removeStorageSync: key => { delete store[key] },
  showToast: options => ui.toasts.push(options),
  showModal: options => ui.modals.push(options),
  showLoading() {}, hideLoading() {}, showTabBar() {}, hideTabBar() {},
  nextTick: task => setTimeout(task, 0),
  navigateTo() {}, navigateBack() {}, setClipboardData: options => { if (options && options.success) options.success({}) },
  getNetworkType: options => options.success({ networkType: 'wifi' }),
  onNetworkStatusChange() {},
  createSelectorQuery: () => ({ selectAll: () => ({ boundingClientRect: () => ({ exec() {} }) }) }),
  cloud: { callFunction: () => Promise.resolve({ result: { ok: false, code: 'NOT_USED' } }) }
}

// ---------------------------------------------------------------- 「云」
const cloud = {
  revision: 7,
  memoryRevision: 7,
  students: [
    { id: 'stu-A', name: '甲学员', packages: [{ id: 'pkg-A', type: '常规训练', price: 100, used: 0, remaining: 5 }] },
    { id: 'stu-B', name: '乙学员', packages: [{ id: 'pkg-B', type: '常规训练', price: 100, used: 0, remaining: 5 }] }
  ],
  bookings: [],
  receipts: new Map(),
  applied: [],
  rejections: [],
  deductions: [],
  // 让外部读取失败（用来验证"读取失败时完课意图绝不撤"这条安全边界）
  readFails: false,
  online: true
}
const slotOf = row => Number(row.hour) * 60 + Number(row.minute || 0)
const overlaps = (row, moment) => row.date === moment.date && Math.abs(slotOf(row) - slotOf(moment)) < 60
function writeCache() {
  store.coachCloudActiveCache = {
    environment: 'production', datasetId: DATASET, revision: cloud.revision,
    checksum: `chk${cloud.revision}`, byteSize: JSON.stringify(cloud.bookings).length,
    snapshot: { students: copy(cloud.students), bookings: copy(cloud.bookings), incomes: [], customExercises: [] }
  }
}
const cloudState = () => ({ students: copy(cloud.students), bookings: copy(cloud.bookings), incomes: [], customExercises: [], settings: {} })
function seedCloud(bookings) {
  cloud.bookings = copy(bookings)
  cloud.receipts = new Map()
  cloud.applied = []
  cloud.rejections = []
  cloud.deductions = []
  cloud.revision = 7
  cloud.memoryRevision = 7
  writeCache()
}
store.coachDataSourceMode = 'cloud-primary'
store.coachCloudCutoverState = { status: 'cloud-primary' }
const SEED_A = { id: 'bk-A', studentId: 'stu-A', studentName: '甲学员', packageId: 'pkg-A', date: DATE, hour: HOUR, minute: 0, typeName: '常规训练', price: 100, status: 'booked' }
seedCloud([SEED_A])

const adapter = {
  getState: () => ({ datasetId: DATASET, revision: cloud.memoryRevision }),
  resetState() {},
  // ★ 与真 readActive 同形：一次成功就把 cache 推到云端当前那一版（本测试里它是"外部刷新"的替身）。
  async readActive() {
    ui.calls.push({ name: 'readActive' })
    if (!cloud.online) return { ok: false, code: 'OFFLINE_CACHE_MISSING' }
    if (cloud.readFails) return { ok: false, code: 'READ_BLOCKED' }
    cloud.memoryRevision = cloud.revision
    writeCache()
    return { ok: true, environment: 'production', datasetId: DATASET, revision: cloud.revision, checksum: `chk${cloud.revision}`, byteSize: 1, snapshot: cloudState() }
  },
  async getReceipt(requestId) {
    ui.calls.push({ name: 'getReceipt', requestId })
    const hit = cloud.receipts.get(requestId)
    if (!hit) return { ok: true, found: false }
    return { ok: true, found: true, status: hit.status, response: copy(hit.response) }
  },
  async execute(command, payload, options = {}) {
    const requestId = options.requestId
    if (!cloud.online) return { ok: false, code: 'OFFLINE_READ_ONLY' }
    if (!Number.isInteger(cloud.memoryRevision)) return { ok: false, code: 'REVISION_UNKNOWN' }
    ui.calls.push({ name: 'execute', command, payload: copy(payload), requestId })
    // 幂等：同号重发直接回同一份结果（真云端 receipt 与业务写在同一事务里）。
    const existing = cloud.receipts.get(requestId)
    if (existing) return copy(existing.response)
    let result
    if (command === 'cancelBooking') {
      const hit = cloud.bookings.find(row => row.id === payload.bookingId)
      if (!hit) result = { ok: false, code: 'BOOKING_NOT_FOUND' }
      else {
        cloud.bookings = cloud.bookings.filter(row => row.id !== payload.bookingId)
        cloud.revision += 1
        cloud.applied.push({ command, payload: copy(payload), requestId, at: cloud.applied.length })
        result = { ok: true, result: { bookingId: payload.bookingId, cancelled: true }, datasetRevision: cloud.revision }
      }
    } else if (command === 'createBooking') {
      if (cloud.bookings.some(row => overlaps(row, payload))) result = { ok: false, code: 'BOOKING_TIME_CONFLICT' }
      else {
        const id = `bk-${cloud.bookings.length + 1}-${payload.studentId}`
        cloud.bookings.push({ id, studentId: payload.studentId, studentName: '学员', packageId: payload.packageId, date: payload.date, hour: payload.hour, minute: payload.minute || 0, typeName: '常规训练', price: 100, status: 'booked' })
        cloud.revision += 1
        cloud.applied.push({ command, payload: copy(payload), requestId, at: cloud.applied.length })
        cloud.deductions.push({ studentId: payload.studentId, packageId: payload.packageId, bookingId: id, requestId })
        result = { ok: true, result: { bookingId: id }, datasetRevision: cloud.revision }
      }
    } else if (command === 'completeBooking') {
      const hit = cloud.bookings.find(row => row.id === payload.bookingId)
      if (!hit) result = { ok: false, code: 'BOOKING_NOT_FOUND' }
      else {
        hit.status = 'done'
        cloud.revision += 1
        cloud.applied.push({ command, payload: copy(payload), requestId, at: cloud.applied.length })
        cloud.deductions.push({ studentId: hit.studentId, packageId: hit.packageId, bookingId: hit.id, requestId })
        result = { ok: true, result: { bookingId: payload.bookingId, completed: true }, datasetRevision: cloud.revision }
      }
    } else result = { ok: false, code: 'COMMAND_NOT_ALLOWED' }
    if (result.ok) {
      cloud.receipts.set(requestId, { status: 'succeeded', response: copy(result) })
      cloud.memoryRevision = cloud.revision
      // ⚠️ 与真 adapter 同形：写成功**不再顺手做一次完整回读**，只给一跳只读校验
      //    ⇒ 本机 cache 此刻仍然是旧的（这正是 settled 条目必须继续承担投影的原因）。
      return { ...copy(result), confirmed: { ok: true } }
    }
    cloud.rejections.push({ command, code: result.code, requestId })
    return copy(result)
  }
}

// ---------------------------------------------------------------- ui-cloud-command 门面
const ACTIVE = { coordinator: null }
const uiPath = require.resolve(path.join(PROJ, 'utils', 'ui-cloud-command.js'))
require.cache[uiPath] = {
  id: uiPath, filename: uiPath, loaded: true,
  exports: {
    get adapter() { return adapter },
    isCloudPrimary: () => true,
    isCloudWritable: () => cloud.online,
    setOnline: value => { cloud.online = value !== false },
    switchEnvironment: async () => ({ ok: false, code: 'NOT_USED' }),
    runCommand: async () => ({ ok: false, code: 'NOT_USED' }),
    runCommandSilent: async () => ({ ok: false, code: 'NOT_USED' }),
    operationId: key => `op_${key}`,
    clearPending() {},
    submitBooking: async () => ({ ok: false, code: 'NOT_USED' }),
    cancelBookingRequest: input => ACTIVE.coordinator.cancel(input),
    retryPendingCancellation: key => ACTIVE.coordinator.retryCancel(key),
    advancePendingCancellations: input => ACTIVE.coordinator.advanceCancellations(input),
    resumePendingBookings: () => ACTIVE.coordinator.resume(),
    pendingBookingRecords: () => [],
    mergePendingBookings: list => list,
    subscribePendingBookings: () => () => {},
    notifyPendingBookings() {},
    pendingCancellationRecords: () => ACTIVE.coordinator.cancelRecords(),
    officialIdForBooking: key => ACTIVE.coordinator.officialIdFor(key),
    awaitOfficialBooking: key => ACTIVE.coordinator.awaitOfficial(key),
    bindingForOfficialId: () => null,
    bookingBindings: () => [],
    getTimings: () => [], setTimingSink() {},
    __writeFunnel: { enter() {}, exit() {} },
    __assertWriteFunnel() {}
  }
}

// ---------------------------------------------------------------- 真模块
const runtime = require(path.join(PROJ, 'utils', 'data-runtime'))
const mutate = require(path.join(PROJ, 'utils', 'mutate'))
const outbox = require(path.join(PROJ, 'utils', 'local-outbox'))
const projection = require(path.join(PROJ, 'utils', 'local-projection'))
const cancellation = require(path.join(PROJ, 'utils', 'pending-cancellation'))
const pending = require(path.join(PROJ, 'utils', 'pending-booking-request'))
const completions = require(path.join(PROJ, 'utils', 'pending-completion'))
const sync = require(path.join(PROJ, 'utils', 'sync-engine'))
const { createBookingOptimistic } = require(path.join(PROJ, 'utils', 'booking-optimistic'))

const SCOPE = { environment: 'production', datasetId: DATASET }
let requestSeq = 0
const coordinator = createBookingOptimistic({
  runtime, pending, cancellation, adapter,
  isOnline: () => cloud.online,
  newRequestId: () => `req-p${++requestSeq}`,
  readDatasetId: () => DATASET,
  readSnapshot: () => { const cache = wx.getStorageSync(runtime.cacheKey()); return cache && cache.snapshot },
  showToast: options => ui.toasts.push(options),
  showModal: options => ui.modals.push(options)
})
ACTIVE.coordinator = coordinator

const bookANew = { studentId: 'stu-A', packageId: 'pkg-A', date: DATE, hour: HOUR, minute: 0 }
const bookB = { studentId: 'stu-B', packageId: 'pkg-B', date: DATE, hour: HOUR, minute: 0 }
const KEY_A = pending.bookingKey(bookANew)

const reset = () => {
  ui.calls.length = 0; ui.toasts.length = 0; ui.modals.length = 0
  for (const key of Object.keys(store)) delete store[key]
  store.coachDataSourceMode = 'cloud-primary'
  store.coachCloudCutoverState = { status: 'cloud-primary' }
  cloud.online = true
  cloud.readFails = false
  seedCloud([SEED_A])
  projection.invalidate()
}
const aRows = () => cloud.bookings.filter(row => row.studentId === 'stu-A')
const bRows = () => cloud.bookings.filter(row => row.studentId === 'stu-B')
const bApplied = () => cloud.applied.filter(row => row.command === 'createBooking' && row.payload.studentId === 'stu-B')
async function drain(rounds = 14) {
  for (let i = 0; i < rounds; i++) { await sync.flush(); await settle(30) }
}
async function until(condition, rounds = 400) {
  for (let i = 0; i < rounds; i++) { if (condition()) return true; await delay(1) }
  return false
}
// 某一次 execute 在流水里的下标（按 command + 学员 定位）
const execIndex = (command, studentId) => ui.calls.findIndex(call =>
  call.name === 'execute' && call.command === command &&
  (!studentId || (call.payload && call.payload.studentId === studentId)))
const localBookings = () => runtime.getDB().bookings

// —— 最终业务不变量 ——
function invariant(tag) {
  assert.equal(aRows().length, 0, `${tag}：★ 云端必须没有 A`)
  assert.equal(bRows().length, 1, `${tag}：★ 云端必须恰好 1 条 B`)
  assert.equal(bApplied().length, 1, `${tag}：★ B 只落库 1 次`)
  assert.equal(cloud.deductions.filter(row => row.studentId === 'stu-B').length, 1,
    `${tag}：★ B 的课时只被占用 1 次（无重复扣课）`)
  const cancelAt = cloud.applied.filter(row => row.command === 'cancelBooking').map(row => row.at)
  const createBAt = bApplied().map(row => row.at)
  assert.equal(cancelAt.length, 1, `${tag}：★ 云端恰好 1 次取消`)
  assert.ok(cancelAt[0] < createBAt[0], `${tag}：★ 云端顺序必须 cancel A → create B`)
}

async function run() {
  // ============================================================ ① 三条写命令之间不许插进任何完整读取
  {
    reset()
    seedCloud([])                                   // 云端空的，A 由本机新建
    const created = await mutate('createBooking', bookANew, { key: 'k-a' })
    assert.equal(created.ok, true, '（前置）本机先约上 A')
    await sync.flush()
    await settle()
    assert.equal(aRows().length, 1, '（前置）A 已落到云端')
    const officialId = aRows()[0].id

    // ★★★ 核心：A 落云之后，不许自动起一次完整读取（旧行为：命令结束 20~70ms 就来一条 10 页）
    const afterA = execIndex('createBooking', 'stu-A')
    assert.ok(afterA >= 0, '（前置）A 的 create 必须出过网')
    await drain()
    assert.equal(ui.calls.slice(afterA + 1).filter(call => call.name === 'readActive').length, 0,
      '★★★ A create 成功后不许再自动做一次完整读取（真机：那条 10 页读占住写航位 12 秒）')

    // 取消 A（正式 id 来自本机 idMap，零云调用）
    const cancel = await coordinator.cancel({ officialId, booking: bookANew })
    assert.equal(cancel.ok, true, '取消必须当场受理：' + JSON.stringify(cancel))
    await until(() => execIndex('cancelBooking') >= 0)
    const cancelIdx = execIndex('cancelBooking')
    assert.equal(ui.calls.slice(afterA + 1, cancelIdx).filter(call => call.name === 'readActive').length, 0,
      '★★ A 落云 → A 取消出网之间必须零完整读取（旧行为：cancel 干等 7929ms）')

    // 同一时段立刻约 B
    const createdB = await mutate('createBooking', bookB, { key: 'k-b' })
    assert.equal(createdB.ok, true, '★ 取消之后同一时段必须能立刻约给别人')
    await drain()
    const bIdx = execIndex('createBooking', 'stu-B')
    assert.ok(bIdx > cancelIdx, '★ B 必须排在 A 的取消之后出网')
    assert.equal(ui.calls.slice(cancelIdx + 1, bIdx).filter(call => call.name === 'readActive').length, 0,
      '★★ A 取消出网 → B 出网之间必须零完整读取（旧行为：B 再等 4819ms）')
    invariant('①')
  }

  // ============================================================ ② cache 未刷新时：A 不复活、B 不消失
  {
    reset()
    seedCloud([])
    await mutate('createBooking', bookANew, { key: 'k-a2' })
    await drain()
    const officialId = aRows()[0].id
    await coordinator.cancel({ officialId, booking: bookANew })
    await mutate('createBooking', bookB, { key: 'k-b2' })
    await drain()
    // 此刻 cache 仍停在旧版（命令成功后刻意不回读）—— 这是真机上最常见的形状。
    const cacheRev = wx.getStorageSync(runtime.cacheKey()).revision
    assert.ok(cacheRev < cloud.revision, `（前置）本机 cache(${cacheRev}) 必须落后于云端(${cloud.revision})`)
    assert.equal(localBookings().filter(row => row.studentId === 'stu-A').length, 0,
      '★★ A 取消成功后，cache 还没刷新也绝不能复活（幽灵预约）')
    assert.equal(localBookings().filter(row => row.studentId === 'stu-B').length, 1,
      '★★ B 绝不能被旧 cache 覆盖（settled 条目必须继续承担投影）')
    // 承载可见性的就是那些 settled 条目 ⇒ 此刻它们**必须还在队列里**
    assert.ok(outbox.settled(SCOPE).length > 0, '（前置）cache 未追上时 settled 条目必须留在队列里承担投影')
    invariant('②')
  }

  // ============================================================ ③ 队列最终能清空（自然读取之后）
  {
    reset()
    seedCloud([])
    await mutate('createBooking', bookANew, { key: 'k-a3' })
    await drain()
    const officialId = aRows()[0].id
    await coordinator.cancel({ officialId, booking: bookANew })
    await mutate('createBooking', bookB, { key: 'k-b3' })
    await drain()
    assert.ok(outbox.count(SCOPE) > 0, '（前置）此时队列里还有 settled 条目')
    // 页面 onShow / 用户下拉：一次真正的读取把 cache 推到云端最新
    const refreshed = await adapter.readActive()
    assert.equal(refreshed.ok, true, '（前置）外部刷新必须成功')
    projection.invalidate()
    // 追上之后，任何一轮 flush 都必须**免费**（零云调用）把它清掉
    const from = ui.calls.length
    await drain()
    assert.equal(ui.calls.slice(from).filter(call => call.name === 'readActive').length, 0,
      '★★ cache 已追上时出队必须是零云调用')
    assert.equal(outbox.count(SCOPE), 0,
      '★★ 成功命令最终必须安全出队（settled 不得永久留在 outbox），实得 ' + outbox.count(SCOPE))
    // 清空之后事实仍然对
    assert.equal(localBookings().filter(row => row.studentId === 'stu-A').length, 0, '★ 出队后 A 仍不得复活')
    assert.equal(localBookings().filter(row => row.studentId === 'stu-B').length, 1, '★ 出队后 B 仍必须在')
    invariant('③')
  }

  // ============================================================ ④ 完课意图：cache 未追上不许撤，追上后必须撤
  {
    reset()
    seedCloud([SEED_A])
    const REQ = 'req-done-1'
    completions.begin('production', DATASET, KEY_A, 'bk-A', () => REQ, Date.now())
    assert.equal(completions.list('production', DATASET).length, 1, '（前置）完课意图已建立')
    outbox.enqueue(SCOPE, { command: 'completeBooking', payload: { bookingId: 'bk-A' }, requestId: REQ })
    // 先让**读取失败**：完课这类"特殊收尾"确实需要一次读取，但读取失败时绝不允许撤意图
    // （撤早了课表会当场从「已完」退回「已约」，那是比"慢"严重得多的错）。
    cloud.readFails = true
    await drain()
    assert.equal(cloud.applied.filter(row => row.command === 'completeBooking').length, 1,
      '（前置）完课命令必须恰好落库 1 次（幂等：同号重发不重复扣课）')
    assert.equal(cloud.deductions.filter(row => row.bookingId === 'bk-A').length, 1,
      '★ 完课只扣 1 次课时（幂等）')
    assert.equal(completions.list('production', DATASET).length, 1,
      '★★ 读取失败时完课意图绝不能撤（否则课表当场退回"未完成"）')
    // 读取恢复 ⇒ 意图必须被 settleIntents 正确收尾，且 cache 里那条确实是 done
    cloud.readFails = false
    await drain()
    assert.equal(completions.list('production', DATASET).length, 0,
      '★★ 读取成功（cache 追上）之后完课意图必须被收尾，实得 ' + JSON.stringify(completions.list('production', DATASET)))
    const cachedBooking = (wx.getStorageSync(runtime.cacheKey()).snapshot.bookings || []).find(row => row.id === 'bk-A')
    assert.ok(cachedBooking && cachedBooking.status === 'done',
      '★★ 意图撤掉的**同一时刻** cache 里那条必须已经是 done（两者必须是同一个结果，不许出现中间态）')
    assert.equal(outbox.count(SCOPE), 0, '★ 完课命令最终也要出队，实得 ' + outbox.count(SCOPE))
    assert.equal(cloud.deductions.filter(row => row.bookingId === 'bk-A').length, 1,
      '★ 全程只扣 1 次课时（收尾过程不得产生第二次扣课）')
    assert.equal(cloud.applied.filter(row => row.command === 'completeBooking').length, 1,
      '★ 全程只落库 1 次完课（幂等不被收尾破坏）')
  }

  // ============================================================ ⑤ 静态契约：purgeSettled 体内不许有完整读取
  {
    const src = fs.readFileSync(path.join(PROJ, 'utils', 'sync-engine.js'), 'utf8')
    const start = src.indexOf('async function purgeSettled')
    const body = src.slice(start, start + 2600)
    // ① 零云调用的出队路径必须存在，且是**默认路径**（第一行就按 cacheCaughtUp 过滤）
    assert.ok(/(const|let) ready = rows\.filter\(cacheCaughtUp\)/.test(body),
      '★ purgeSettled 必须默认按「cache 已追上」零云调用出队')
    // ② 完整读取只允许出现在 needsRead 闸门**之后**（普通命令绝不能走到它）
    const gate = body.indexOf('if (needsRead.length)')
    assert.ok(gate > 0, '★ 完整读取必须被 needsRead 闸门挡住')
    assert.equal(/\.readActive\s*\(/.test(body.slice(0, gate)), false,
      '★ needsRead 闸门之前不得有任何 adapter.readActive()（普通命令不许为出队付一次 10 页读）')
    assert.ok(/\.readActive\s*\(/.test(body.slice(gate)), '（形态检查）读取只应在闸门内')
    // ③ 闸门条件必须只放行"真的需要读取"的特殊收尾（完课 / 拿不到 settledRevision 的孤儿）
    const cond = body.slice(body.indexOf('const needsRead'), gate)
    assert.ok(/completeBooking/.test(cond), '★ 完课这类特殊收尾才允许读取')
    assert.ok(/settledRevision/.test(cond), '★ settledRevision 缺失的孤儿也允许读取（否则会永久滞留）')
    assert.ok(/function intentPending/.test(src), '★ 完课意图必须单独判定')
    assert.ok(/function cacheCaughtUp/.test(src), '★ 必须有 cacheCaughtUp 判据')
    assert.ok(/function settledRevisionOf/.test(src), '★ settledRevision 必须有可收敛的下界（否则条目永久滞留）')
  }
}

run().then(() => { console.log('settled purge no full read: PASS') }, error => { console.error('settled purge no full read: FAIL'); console.error(error); process.exit(1) })
