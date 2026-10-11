// 【1.1.9 第 10 轮永久回归】唯一的业务不变量：
//
//   预约 A → 立即取消 A → 不等待 → 同一时间立即预约 B
//
//   界面必须当场完成；后台必须自己保证云端最终顺序是
//       create A（若尚未完成） → cancel A 成功 → create B 成功
//   用户不得看到 BOOKING_TIME_CONFLICT，不得需要第二次取消，也不得需要第二次预约。
//
// 真机为什么原来做不到（2026-09-23 23:23 实测，`coachWriteTimings` 原始账本）：
//   23:23:02  createBooking(A) 成功      rev 228
//   23:23:09  B 入队
//   23:23:12  一次 9664ms 的完整回读（只为拿到 A 的正式 id）
//   23:23:13  ✗ B 被 BOOKING_TIME_CONFLICT 拒绝
//   23:23:27  ✓ cancelBooking(A) 落云    rev 229   ← 比 B 晚 13.5 秒
//   23:23:37  再点一次才约上
//   ⇒ 「本机释放」从不等于「云端已删除」；两条链没被真正排序，B 永远先到云端。
//
// 本文件只替换「云」（假 adapter，语义与真服务端逐条同口径）与 ui-cloud-command 的门面，
// 其余全部是真模块：协调器 / pending-cancellation / local-projection / local-outbox / mutate / sync-engine。
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const PROJ = path.join(__dirname, '..')
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const settle = async (rounds = 40) => { for (let i = 0; i < rounds; i++) await delay(1) }

const DATASET = 'ds-order'
const DATE = '2026-09-24'
const HOUR = 11

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
  // 每一次**真正落库**的写（顺序就是云端看到的顺序）
  applied: [],
  // 每一次**被云端拒绝**的写（业务拒绝不留 receipt，见 core.js）
  rejections: [],
  // 每次成功落库的 createBooking 记一笔"课时占用"（真云端在完课时扣，这里用它当"扣了几次"的可观测代理）
  deductions: [],
  holdCancel: false, _releaseCancel: null,
  holdCreate: false, _releaseCreate: null,
  // 只挂住**某个时段**的 create（第 12 轮：造"同步引擎这一轮还在飞"的确定性窗口）
  holdCreateHour: null,
  // 让**某个时段**的 create 直接带一次完整回读回来（不进 settled），
  // 免得它自己的收尾读取混进"取消落云 ⇒ B 出网"这段流水里（第 12 轮）
  refreshedHour: null,
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
  async readActive() {
    ui.calls.push({ name: 'readActive' })
    if (!cloud.online) return { ok: false, code: 'OFFLINE_CACHE_MISSING' }
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
    // 与真 adapter 同口径：本机内存态里没有 revision 时，命令在**出网之前**就被拒。
    if (!Number.isInteger(cloud.memoryRevision)) return { ok: false, code: 'REVISION_UNKNOWN' }
    ui.calls.push({ name: 'execute', command, payload: copy(payload), requestId })
    if (command === 'cancelBooking' && cloud.holdCancel) await new Promise(resolve => { cloud._releaseCancel = resolve })
    if (command === 'createBooking' && cloud.holdCreate) await new Promise(resolve => { cloud._releaseCreate = resolve })
    if (command === 'createBooking' && cloud.holdCreateHour != null && Number(payload.hour) === Number(cloud.holdCreateHour)) {
      await new Promise(resolve => { cloud._releaseCreate = resolve })
    }
    // 幂等：**只有成功**的命令才留下 receipt。
    // 真云端 core.js：业务拒绝在事务里 throw ⇒ 整个事务回滚 ⇒ receipt 一行都没写进去。
    // 所以"被 BOOKING_TIME_CONFLICT 拒过一次、再用同一个号重发"是**真正再执行一次**，不是重放失败。
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
    } else result = { ok: false, code: 'COMMAND_NOT_ALLOWED' }
    if (result.ok) {
      cloud.receipts.set(requestId, { status: 'succeeded', response: copy(result) })
      cloud.memoryRevision = cloud.revision
      // ⚠️ 与 1.1.9 第 6 轮之后的真 adapter 同形：写成功**不再顺手做一次完整回读**，
      //    只给一跳只读校验 ⇒ 本机 cache 此刻仍然是旧的（这正是"A 的正式 id 只存在于本机 idMap"的由来）。
      const withRefresh = cloud.refreshedHour != null && Number(cloud.refreshedHour) === Number(payload.hour)
      return { ...copy(result), confirmed: { ok: true }, ...(withRefresh ? { refreshed: { ok: true } } : {}) }
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
const sync = require(path.join(PROJ, 'utils', 'sync-engine'))
const { createBookingOptimistic } = require(path.join(PROJ, 'utils', 'booking-optimistic'))

const SCOPE = { environment: 'production', datasetId: DATASET }
let requestSeq = 0
const coordinator = createBookingOptimistic({
  runtime, pending, cancellation, adapter,
  isOnline: () => cloud.online,
  newRequestId: () => `req-o${++requestSeq}`,
  readDatasetId: () => DATASET,
  readSnapshot: () => { const cache = wx.getStorageSync(runtime.cacheKey()); return cache && cache.snapshot },
  showToast: options => ui.toasts.push(options),
  showModal: options => ui.modals.push(options)
})
ACTIVE.coordinator = coordinator

const bookA = { id: 'bk-A', studentId: 'stu-A', packageId: 'pkg-A', date: DATE, hour: HOUR, minute: 0 }
const bookANew = { studentId: 'stu-A', packageId: 'pkg-A', date: DATE, hour: HOUR, minute: 0 }
const bookB = { studentId: 'stu-B', packageId: 'pkg-B', date: DATE, hour: HOUR, minute: 0 }
const KEY_A = pending.bookingKey(bookANew)

const reset = () => {
  ui.calls.length = 0; ui.toasts.length = 0; ui.modals.length = 0
  for (const key of Object.keys(store)) delete store[key]
  store.coachDataSourceMode = 'cloud-primary'
  store.coachCloudCutoverState = { status: 'cloud-primary' }
  cloud.holdCancel = false; cloud._releaseCancel = null
  cloud.holdCreate = false; cloud._releaseCreate = null
  cloud.holdCreateHour = null
  cloud.refreshedHour = null
  cloud.online = true
  seedCloud([SEED_A])
  projection.invalidate()
}
const callsFrom = from => ui.calls.slice(from)
const countFrom = (from, name) => callsFrom(from).filter(call => call.name === name).length
const execFrom = (from, command) => callsFrom(from).filter(call => call.name === 'execute' && call.command === command)
async function drain(rounds = 14) {
  for (let i = 0; i < rounds; i++) { await sync.flush(); await settle(30) }
}
// 等到某个状态条件成立（不靠固定 sleep）
async function until(condition, rounds = 400) {
  for (let i = 0; i < rounds; i++) { if (condition()) return true; await delay(1) }
  return false
}
const aRows = () => cloud.bookings.filter(row => row.studentId === 'stu-A')
const bRows = () => cloud.bookings.filter(row => row.studentId === 'stu-B')
const bApplied = () => cloud.applied.filter(row => row.command === 'createBooking' && row.payload.studentId === 'stu-B')

// —— 最终业务不变量（每一个场景结束都要同时成立）——
function invariant(tag) {
  assert.equal(aRows().length, 0, `${tag}：★ 云端必须没有 A（A=0 条）`)
  assert.equal(bRows().length, 1, `${tag}：★ 云端必须恰好 1 条 B`)
  assert.equal(bApplied().length, 1, `${tag}：★ B 只落库 1 次（不能重复创建）`)
  assert.equal(cloud.deductions.filter(row => row.studentId === 'stu-B').length, 1,
    `${tag}：★ B 的课时只被占用 1 次（无重复扣课）`)
  assert.equal(outbox.failed(SCOPE).filter(row => row.command === 'createBooking' && row.payload.studentId === 'stu-B').length, 0,
    `${tag}：★ B 绝不能被归档成"业务失败"（排序问题不是业务冲突）`)
  // 云端顺序：A 的取消必须在 B 的创建**之前**。
  const cancelAt = cloud.applied.filter(row => row.command === 'cancelBooking').map(row => row.at)
  const createBAt = bApplied().map(row => row.at)
  assert.equal(cancelAt.length, 1, `${tag}：★ 云端必须恰好 1 次取消（A 只被取消一次）`)
  assert.ok(cancelAt[0] < createBAt[0], `${tag}：★ 云端顺序必须是 cancel A → create B，实得 ${JSON.stringify(cloud.applied.map(row => row.command))}`)
  // 本机最终事实层
  const db = runtime.getDB()
  assert.equal(db.bookings.filter(row => row.studentId === 'stu-A').length, 0, `${tag}：★ 本机不得残留 A（无幽灵预约）`)
  assert.equal(db.bookings.filter(row => row.studentId === 'stu-B').length, 1, `${tag}：★ 本机恰好 1 条 B`)
}

const stage = name => { if (process.env.ORD_TRACE) console.error('[stage] ' + name) }

async function run() {
  // ============================================================ ① A 已有 officialId → 秒取消 → 秒约 B
  {
    stage('①')
    reset()
    const from = ui.calls.length
    const cancel = await coordinator.cancel({ officialId: 'bk-A', booking: bookA })
    assert.equal(cancel.ok, true, '取消必须当场受理：' + JSON.stringify(cancel))
    assert.equal(cancel.deferred, true, '取消必须前台返回、后台落实（不 await 云端）')
    // 立刻约 B（同一时段、不同学员）—— 界面必须当场完成。
    const created = await mutate('createBooking', bookB, { key: 'k-b1' })
    assert.equal(created.ok, true, '★ 取消之后同一时段必须能立刻约给别人：' + JSON.stringify(created))
    await drain()
    const cancelExec = execFrom(from, 'cancelBooking')
    assert.equal(cancelExec.length, 1, '★ A 的取消必须恰好出网一次，实得 ' + cancelExec.length)
    assert.deepEqual(cancelExec[0].payload, { bookingId: 'bk-A' }, '取消载荷只能有 bookingId')
    assert.equal(countFrom(from, 'readActive') <= 2, true, '已有正式 id 时不许为了取消付多次完整回读')
    invariant('①')
  }

  // ============================================================ ② A 刚创建、officialId 尚未回本机 → 秒取消 → 秒约 B
  {
    stage('②')
    reset()
    seedCloud([])                              // 云端一开始是空的，A 由本机新建
    const queued = await mutate('createBooking', bookANew, { key: 'k-a2' })
    assert.equal(queued.ok, true, '（前置）本机先约上 A：' + JSON.stringify(queued))
    await sync.flush()
    await settle()
    assert.equal(aRows().length, 1, '（前置）A 已经落到云端')
    const officialId = aRows()[0].id
    // ★ 1.1.9 第 14 轮：settled 条目现在会**一直承担投影直到 cache 追上**（这正是"界面上看得见这条事实"的
    //   保证，也是本次修复的核心）。所以要先让 cache 真正追上来（一次外部刷新 + 一轮 flush 免费出队），
    //   再抹掉 cache 里那条 A，才造得出「云端有 A、本机 cache 没有」这个形状。
    //   不这么做的话，投影会正确地继续显示 A —— 断言"本机看不到 A"反而是错的。
    await adapter.readActive()
    projection.invalidate()
    await sync.flush()
    await settle()
    // ★ 把本机 cache 里那条 A 抹掉 —— 刻意造出真机上最常见的形状：
    //   「云端已经有 A、本机 cache 还没同步到位」，也就是"officialId 尚未回本机"。
    const cache = wx.getStorageSync(runtime.cacheKey())
    cache.snapshot.bookings = cache.snapshot.bookings.filter(row => row.id !== officialId)
    wx.setStorageSync(runtime.cacheKey(), cache)
    projection.invalidate()
    assert.equal(runtime.getDB().bookings.filter(row => row.id === officialId).length, 0, '（前置）本机确实看不到 A')
    // ★★ 关键：正式 id 必须**本机就能取到**（Outbox idMap），不需要任何云调用。
    assert.equal(coordinator.officialIdFor(KEY_A), officialId,
      '★★ 正式 id 必须优先从本机 Outbox idMap 取得（零云调用），实得 ' + JSON.stringify(coordinator.officialIdFor(KEY_A)))
    const from = ui.calls.length
    await coordinator.cancel({ booking: bookANew })
    const created = await mutate('createBooking', bookB, { key: 'k-b2' })
    assert.equal(created.ok, true, '★ 同一时段必须能立刻约给别人')
    await drain()
    const cancelExec = execFrom(from, 'cancelBooking')
    assert.equal(cancelExec.length, 1, '★ A 的取消必须出网一次，实得 ' + JSON.stringify(cancelExec))
    assert.deepEqual(cancelExec[0].payload, { bookingId: officialId }, '★ 取消必须用本机 idMap 里那个正式 id')
    // 从"发起取消"到"取消真的出网"之间，不许为了拿 id 付一次完整回读。
    const upto = ui.calls.findIndex((call, index) => index >= from && call.name === 'execute' && call.command === 'cancelBooking')
    assert.equal(ui.calls.slice(from, upto).filter(call => call.name === 'readActive').length, 0,
      '★★ 取消解析正式 id 之前不许先做完整云端回读（真机实测那一次 9664ms，就是 B 抢跑的全部原因）')
    invariant('②')
  }

  // ============================================================ ③ cancel 比 create B 慢（云端把取消挂住）
  {
    stage('③')
    reset()
    cloud.holdCancel = true
    await coordinator.cancel({ officialId: 'bk-A', booking: bookA })
    await until(() => execFrom(0, 'cancelBooking').length === 1)
    assert.equal(aRows().length, 1, '（闸门）取消被云端挂住，A 仍在')
    const created = await mutate('createBooking', bookB, { key: 'k-b3' })
    assert.equal(created.ok, true, '本机秒回不受影响')
    const from = ui.calls.length
    await drain()
    assert.equal(execFrom(from, 'createBooking').length, 0,
      '★★ 取消还没落云时，同一时段的新预约绝不能出网（否则会被云端 BOOKING_TIME_CONFLICT 明确拒绝）')
    assert.equal(bApplied().length, 0, '（闸门期间）云端不能出现 B')
    cloud.holdCancel = false
    if (cloud._releaseCancel) cloud._releaseCancel()
    await drain()
    invariant('③')
  }

  // ============================================================ ④ 网络延迟：create 还在途中 ⇒ 取消停在 waiting，绝不默认回读
  {
    stage('④')
    reset()
    seedCloud([])
    cloud.holdCreate = true
    await mutate('createBooking', bookANew, { key: 'k-a4' })
    await until(() => outbox.list(SCOPE).some(entry => entry.command === 'createBooking' && entry.status === 'inflight'))
    const from = ui.calls.length
    await coordinator.cancel({ booking: bookANew })
    await settle()
    assert.equal(execFrom(from, 'cancelBooking').length, 0,
      '没有正式 id 时绝不许抢先发一条取消（那是一条必然找不到记录的云写）')
    assert.equal(countFrom(from, 'readActive'), 0,
      '★★ 暂时拿不到正式 id 时**不许**默认先做一次完整云端回读（改为 waiting + 有限重试）')
    const row = cancellation.get('production', DATASET, KEY_A)
    assert.equal(row && row.status, 'waiting', '★ 必须停在 waiting，而不是判"云端从来没有过"并撤掉 tombstone')
    assert.equal(outbox.list(SCOPE).some(entry => entry.command === 'createBooking'), true,
      '那条 create 不许被撤掉（它可能已经在云端了）')
    // 同一时段立刻约 B：界面照旧当场完成，后台自己等。
    const created = await mutate('createBooking', bookB, { key: 'k-b4' })
    assert.equal(created.ok, true, '★ 界面必须当场允许预约 B，不能弹冲突')
    // ⚠️ 这里不能 drain：那条 create 正被云端挂住（假云故意不 resolve），
    //    drain 会 await 一个**永不 settle** 的 flush ⇒ 进程饿死（退出码 0、零输出，最难查的假绿）。
    await settle(80)
    assert.equal(bApplied().length, 0, '（create 仍在途中）B 不许抢在 A 的取消之前落库')
    cloud.holdCreate = false
    if (cloud._releaseCreate) cloud._releaseCreate()
    await drain()
    invariant('④')
  }

  // ============================================================ ⑤ B 已提前收到 BOOKING_TIME_CONFLICT ⇒ 原号自动恢复
  {
    stage('⑤')
    reset()
    cloud.holdCancel = true
    await coordinator.cancel({ officialId: 'bk-A', booking: bookA })
    await until(() => execFrom(0, 'cancelBooking').length === 1)
    // 把这条取消的起始时刻推到排序门之外 —— 造出真机上"取消迟迟不落云、门已超时"的窗口，
    // 于是 B 会**先**出网并如实被云端判冲突。这正是不变量里最坏的一档。
    const row = cancellation.get('production', DATASET, KEY_A)
    cancellation.patch('production', DATASET, KEY_A, row.requestId, { startedAt: Date.now() - 60000 })
    const created = await mutate('createBooking', bookB, { key: 'k-b5' })
    assert.equal(created.ok, true)
    const entryB = outbox.list(SCOPE).find(entry => entry.command === 'createBooking')
    const requestIdB = entryB.requestId
    await drain(4)
    assert.equal(cloud.rejections.filter(item => item.requestId === requestIdB && item.code === 'BOOKING_TIME_CONFLICT').length, 1,
      '（前置）B 确实先出网、被云端判了一次时间冲突')
    // ★★ 排序问题不是业务冲突：不许归档、不许换号。
    assert.equal(outbox.failed(SCOPE).filter(item => item.requestId === requestIdB).length, 0,
      '★★ 同一时段存在尚未落云的本机取消 ⇒ 冲突不得归档为普通失败')
    const stillQueued = outbox.list(SCOPE).find(entry => entry.requestId === requestIdB)
    assert.ok(stillQueued, '这条预约必须还在队列里等着')
    assert.equal(stillQueued.requestId, requestIdB, '★★ 必须保持原 requestId（云端幂等靠号，换号等于放弃幂等）')
    // 取消落云 ⇒ B 自动补发，用户一次点击都不用多做。
    cloud.holdCancel = false
    if (cloud._releaseCancel) cloud._releaseCancel()
    await drain()
    invariant('⑤')
    assert.equal(bApplied()[0].requestId, requestIdB, '★★ B 最终落库用的必须是原来那个编号')
  }

  // ============================================================ ⑥ 另一设备：一次主动下拉即可看到最终结果
  {
    stage('⑥')
    reset()
    await coordinator.cancel({ officialId: 'bk-A', booking: bookA })
    await mutate('createBooking', bookB, { key: 'k-b6' })
    await drain()
    invariant('⑥')
    // 另一台设备：它只做**一次**主动读取（下拉），就必须看到"没有 A、恰好 1 条 B"。
    const from = ui.calls.length
    await adapter.readActive()
    assert.equal(countFrom(from, 'readActive'), 1, '（另一设备）只做一次下拉')
    const other = wx.getStorageSync(runtime.cacheKey()).snapshot.bookings
    assert.equal(other.filter(row => row.studentId === 'stu-A').length, 0, '★ 另一设备第一次下拉就看不到 A')
    assert.equal(other.filter(row => row.studentId === 'stu-B').length, 1, '★ 另一设备第一次下拉就看到 B')
    // 本机也得已经清干净：下拉之后不需要再靠 tombstone 去"藏"任何东西。
    await coordinator.resume()
    await settle()
    assert.equal(cancellation.list('production', DATASET).length, 0, '★ 收尾之后本机不得残留取消待确认')
    assert.equal(runtime.getDB().bookings.filter(row => row.studentId === 'stu-A').length, 0, '★ 本机不得残留 A')
  }

  // ============================================================ ⑧ 暂时拿不到正式 id：waiting + 有限重试，绝不默认回读
  {
    stage('⑧')
    reset()
    seedCloud([])                                   // 云端根本没有这条预约
    cancellation.begin('production', DATASET, KEY_A, '', () => 'req-o-ghost', bookANew, Date.now())
    // 第 1、2 次：本机来源都拿不到结论 ⇒ **不许**为此付一次完整回读（真机那一次实测 9664ms）。
    for (const round of [1, 2]) {
      const from = ui.calls.length
      await coordinator.resume()
      assert.equal(countFrom(from, 'readActive'), 0, `★ 第 ${round} 次推进不许先做完整回读（waiting + 有限重试）`)
      assert.equal(cancellation.get('production', DATASET, KEY_A).status, 'waiting',
        `★ 第 ${round} 次：拿不到结论 ⇒ 停在 waiting，tombstone 绝不能撤`)
    }
    // 第 3 次：重试预算用尽 ⇒ 允许**唯一**那一次完整回读来定论；读回来确实没有 ⇒ 才可证明"云端从来没有过"。
    const from = ui.calls.length
    await coordinator.resume()
    assert.equal(countFrom(from, 'readActive'), 1, '★ 有限重试用尽之后才动用那一次回读，而且只用一次')
    assert.equal(cancellation.list('production', DATASET).length, 0,
      '★ 回读成功且快照里确实没有 ⇒ 这才是可证明的"云端从来没有过"，此时才允许 dropLocalOnly')
    assert.equal(aRows().length, 0, '云端本来就没有 A')
    // 全程不许为了这条不存在的预约发出任何取消命令。
    assert.equal(execFrom(0, 'cancelBooking').length, 0, '★ 云端从来没有过 ⇒ 一次云写都不需要')
  }

  // ============================================================ ⑩（第 12 轮 A）取消落云 ⇒ 等待中的 B **立刻**被唤醒
  //
  //   真机（2026-09-24 17:36）：A 的取消 17:36:12 才落云、B 17:36:15 才落云，
  //   而电脑界面 17:36:02 就已经显示 B —— 「本机显示」领先「云端事实」十几秒。
  //   这一段不许靠"下一次后台轮询 / 页面 onShow / 一次完整读取"来收尾：
  //   取消落云的那一刻，**正在飞的那一轮同步**必须被记一次"再跑一轮"，
  //   否则同一时段那条被排序门 stall 住的 B 就一直躺在队列里。
  {
    stage('⑩')
    reset()
    // ⚠️ C 必须用**第三个学员**：bApplied()/invariant() 是按 stu-B 计数的，
    //    而且本机事务会校验学员与课时包真实存在（与云端同口径），所以得先把它建出来。
    if (!cloud.students.some(row => row.id === 'stu-C')) {
      cloud.students.push({ id: 'stu-C', name: '丙学员', packages: [{ id: 'pkg-C', type: '常规训练', price: 100, used: 0, remaining: 5 }] })
    }
    writeCache()
    projection.invalidate()
    const bookC = { studentId: 'stu-C', packageId: 'pkg-C', date: DATE, hour: HOUR + 4, minute: 0 }
    // ① 取消先发起、并且**挂在云端** ⇒ 排序门此刻确实是关着的（确定性，不靠 sleep）
    cloud.holdCancel = true
    const cancel = await coordinator.cancel({ officialId: 'bk-A', booking: bookA })
    assert.equal(cancel.ok, true, '取消必须当场受理')
    assert.equal(cancel.deferred, true, '取消必须前台返回、后台落实')
    // ② B（同时段）入队 —— 界面当场完成
    const createdB = await mutate('createBooking', bookB, { key: 'k-b10' })
    assert.equal(createdB.ok, true, '★ 取消之后同一时段必须能立刻约给别人')
    // ③ 再来一条**不同时段**的 create，并让它挂在云端 ⇒ 同步引擎这一轮会一直"在飞"
    cloud.holdCreateHour = HOUR + 4
    cloud.refreshedHour = HOUR + 4
    const createdC = await mutate('createBooking', bookC, { key: 'k-c10' })
    assert.equal(createdC.ok, true, '（前置）另一条不同时段的预约也要入队')
    const round = sync.flush()
    await until(() => typeof cloud._releaseCreate === 'function', 200)
    assert.equal(typeof cloud._releaseCreate, 'function', '（前置）这一轮必须真的卡在云端（引擎在飞）')
    assert.equal(bApplied().length, 0, '（前置）取消未落云时 B 不许出网')
    assert.equal(outbox.failed(SCOPE).length, 0,
      '（前置）B 必须被**排序门**挡住，而不是被云端当成业务冲突拒掉：' + JSON.stringify(outbox.failed(SCOPE).map(row => row.code || (row.result && row.result.code))))
    assert.equal(cancellation.list('production', DATASET).length, 1, '（前置）那条取消的 tombstone 必须还在')
    // ④ 取消在云端成功 —— 此刻**同步引擎那一轮还在飞**（这才是真机那个形状）
    const from = ui.calls.length
    cloud._releaseCancel()
    await until(() => cloud.applied.some(row => row.command === 'cancelBooking'), 200)
    assert.equal(cloud.applied.filter(row => row.command === 'cancelBooking').length, 1, '（前置）取消恰好落云一次')
    // ⚠️ `schedule()` 是**下一拍**才真正触发，所以必须在这里把这一拍让出来：
    //    让"取消落云 ⇒ 叫醒同步引擎"这件事真的发生，而同步引擎那一轮**此刻还在飞**
    //    （C 仍挂在云端）—— 这正是真机那个形状，也是本场景唯一要钉死的东西。
    await settle(30)
    assert.equal(bApplied().length, 0, '（前置）取消已落云、但引擎这一轮还在飞 ⇒ 此刻 B 还没出网')
    // ★ 与 `runCancel` 收尾那一下**等价**、但**不跨 tick**：直接调 `flush()`。
    //   `schedule()` 要等下一拍才真正去调 flush，会让"叫醒落在这一轮结束前还是后"随时序漂移；
    //   这里用 `sync.flush()` 的**返回值身份**把窗口钉死：它返回的还是 `round`
    //   ⇒ 那一轮确实还在飞，这次叫醒只能靠"记一次补跑"生效。
    const wake = sync.flush()
    assert.equal(wake, round, '（前置）叫醒必须落在"同步引擎这一轮还在飞"的窗口里')
    // ⑤ 放开那条挂着的 create，让在飞的那一轮自己收尾。**不调用** flush / resume / readActive。
    cloud._releaseCreate()
    cloud.holdCreateHour = null
    await round
    await until(() => bApplied().length === 1, 300)
    assert.equal(bApplied().length, 1,
      '★★ 取消落云后，等待中的同段 B 必须**立刻**被唤醒发出（不许等下一次后台轮询 / onShow / 完整读取）')
    // ★ 唤醒必须是**纯本机事件驱动**：B 的出网必须发生在任何一次完整回读**之前**
    //   （队列里别的条目收尾时可能顺带读一次 —— 那是既有行为，但它绝不是唤醒 B 的那个东西）。
    const seq = callsFrom(from)
    const bIdx = seq.findIndex(call => call.name === 'execute' && call.command === 'createBooking' && call.payload && Number(call.payload.hour) === HOUR)
    const readIdx = seq.findIndex(call => call.name === 'readActive')
    assert.ok(bIdx >= 0, '（前置）B 的出网必须能在这一段的调用流水里找到')
    assert.ok(readIdx < 0 || bIdx < readIdx,
      '★ B 必须在任何完整回读之前就出网 —— 唤醒来自"取消落云"这个本机事件，不是回读带来的'
      + `（B 在第 ${bIdx} 次、回读在第 ${readIdx} 次）`)
    invariant('⑩')
  }

  // ============================================================ ⑨ 静态契约：这四条修复各自都有落点
  {
    stage('⑨')
    const syncSource = fs.readFileSync(path.join(PROJ, 'utils', 'sync-engine.js'), 'utf8')
    const optimisticSource = fs.readFileSync(path.join(PROJ, 'utils', 'booking-optimistic.js'), 'utf8')
    const outboxSource = fs.readFileSync(path.join(PROJ, 'utils', 'local-outbox.js'), 'utf8')
    const mutateSource = fs.readFileSync(path.join(PROJ, 'utils', 'mutate.js'), 'utf8')
    assert.ok(/officialIdFromOutbox/.test(optimisticSource), '★ 取消必须有一条"从本机 Outbox 取正式 id"的路径')
    assert.ok(/bookingKeyLocalId/.test(outboxSource) && /recordBookingKey/.test(mutateSource),
      '★ 业务键 → 本机临时 id 的索引必须两头都在（出队之后仍要能反查）')
    assert.ok(/slotRows\(/.test(syncSource) && /heldByCancel/.test(syncSource),
      '★ 排序门必须在**出网前实时**判定同一时段的取消（不能只依赖入队时的快照）')
    assert.ok(/BOOKING_TIME_CONFLICT/.test(syncSource),
      '★ 冲突必须与"同段存在未落云的取消"联动，而不是一律归档')
    assert.ok(/CANCEL_TARGET_PROBES/.test(optimisticSource),
      '★ 拿不到正式 id 时必须是"waiting + 有限重试"，不是直接判 none 撤 tombstone')
    // 第 12 轮 A：在飞的那一轮收到 schedule ⇒ 必须记一次"再跑一轮"，不能把在途 promise 直接交回去。
    assert.ok(/rerunRequested/.test(syncSource),
      '★ 同步引擎必须支持"本轮跑完再补一轮"（取消落云时的那一次唤醒）')
    assert.ok(/queued\.length \|\| probe < CANCEL_TARGET_PROBES/.test(optimisticSource),
      '★ 队列里还有一条**已经出网**的 create 时也必须有限重试（不许无限等 ⇒ 那条取消永远发不出去）')
  }

  console.log('cancel then book ordering: PASS (秒取消秒约 B / 正式 id 取本机 / 实时排序门 / 冲突原号自动恢复 / 云端顺序 cancel A → create B)')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
