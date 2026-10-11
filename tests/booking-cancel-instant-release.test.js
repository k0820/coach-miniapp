// 【1.1.9 第 7 轮永久回归】取消：本机秒释放时段 + 可靠上云 + 「先取消后重约」的排序。
//
// 钉住四件事（每一件都对应一条真机现象）：
//   ① **本机秒取消**：`11:00 约 A → 取消 A → 不等待云端 → 立即 11:00 约 B` 必须直接成功。
//      修前这句话会得到「该时段的取消尚未确认 / 这条预约仍可能占用该时段」——
//      因为 tombstone 只被视图层认识，弹层的冲突检测与本机业务事务（createBooking 的
//      BOOKING_TIME_CONFLICT，与云端同一份 handlers）都还在把 A 当成占用。
//   ② **取消上云与新增同等级**：首次取消**不查回执**（那条取消命令从未出网 ⇒ 云端一定没有它），
//      于是与新增一样是「一次写 + 一次只读校验」，不再多欠一跳。
//   ③ **可靠上云**：第一次发送的响应丢了、而云端**明确**没有这条 requestId 时，用**同一个号**补发
//      （号不变 ⇒ 幂等）。修前它只查单、永不重发，于是"抖动一次"就等于"这条取消永远上不了云"，
//      而 tombstone 永远留在本机。
//   ④ **排序**：同一时段的新预约绝不允许抢在被取消的那条之前出网 —— 否则云端会以
//      BOOKING_TIME_CONFLICT 明确拒绝它，而那条拒绝会被当成"业务失败"归档，用户得再点一次。
//
// 只替换「云」（假 adapter，真实语义：receipt / 幂等 / 回读）与 ui-cloud-command 的门面，
// 其余全部是真模块：协调器 / pending-cancellation / local-projection / local-outbox / mutate / sync-engine。
const assert = require('assert')
const path = require('path')
const PROJ = path.join(__dirname, '..')
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const settle = async (rounds = 40) => { for (let i = 0; i < rounds; i++) await delay(1) }

const DATASET = 'ds-cancel'
const DATE = '2026-09-24'

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

// ---------------------------------------------------------------- 「云」：只认这些命令，语义与真服务端同口径
const cloud = {
  revision: 7,
  memoryRevision: 7,
  students: [
    { id: 'stu-A', name: '甲学员', packages: [{ id: 'pkg-A', type: '常规训练', price: 100, used: 0, remaining: 5 }] },
    { id: 'stu-B', name: '乙学员', packages: [{ id: 'pkg-B', type: '常规训练', price: 100, used: 0, remaining: 5 }] }
  ],
  bookings: [],
  receipts: new Map(),
  // 闸门（造确定性窗口，不靠 sleep）：
  holdCancel: false, _releaseCancel: null,
  // create 的闸门：用来稳定地造出"这条 create 已经出网、但还没落定"这一刻。
  holdCreate: false, _releaseCreate: null,
  // 第一次取消命令「云端从未受理」（响应丢失且根本没执行）：
  dropCancelBeforeApply: 0,
  online: true
}
function slotOf(row) { return Number(row.hour) * 60 + Number(row.minute || 0) }
function writeCache() {
  store.coachCloudActiveCache = {
    environment: 'production', datasetId: DATASET, revision: cloud.revision,
    checksum: `chk${cloud.revision}`, byteSize: JSON.stringify(cloud.bookings).length,
    snapshot: { students: copy(cloud.students), bookings: copy(cloud.bookings), incomes: [], customExercises: [] }
  }
}
function cloudState() {
  return { students: copy(cloud.students), bookings: copy(cloud.bookings), incomes: [], customExercises: [], settings: {} }
}
function seedCloud(bookings) {
  cloud.bookings = copy(bookings)
  cloud.receipts = new Map()
  cloud.revision = 7
  cloud.memoryRevision = 7
  writeCache()
}
store.coachDataSourceMode = 'cloud-primary'
store.coachCloudCutoverState = { status: 'cloud-primary' }
seedCloud([{ id: 'bk-A', studentId: 'stu-A', studentName: '甲学员', packageId: 'pkg-A', date: DATE, hour: 11, minute: 0, typeName: '常规训练', price: 100, status: 'booked' }])

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
    if (command === 'cancelBooking') {
      if (cloud.dropCancelBeforeApply > 0) {
        cloud.dropCancelBeforeApply -= 1
        return { ok: false, code: 'COMMAND_RESULT_UNKNOWN', retrySafe: true }
      }
      if (cloud.holdCancel) await new Promise(resolve => { cloud._releaseCancel = resolve })
    }
    const existing = cloud.receipts.get(requestId)
    if (existing) return copy(existing.response)
    let result
    if (command === 'cancelBooking') {
      const hit = cloud.bookings.find(row => row.id === payload.bookingId)
      if (!hit) result = { ok: false, code: 'BOOKING_NOT_FOUND' }
      else {
        cloud.bookings = cloud.bookings.filter(row => row.id !== payload.bookingId)
        cloud.revision += 1
        result = { ok: true, result: { bookingId: payload.bookingId, cancelled: true }, datasetRevision: cloud.revision }
      }
    } else if (command === 'createBooking') {
      if (cloud.holdCreate) await new Promise(resolve => { cloud._releaseCreate = resolve })
      const occupied = cloud.bookings.some(row => row.date === payload.date && Math.abs(slotOf(row) - slotOf(payload)) < 60)
      if (occupied) result = { ok: false, code: 'BOOKING_TIME_CONFLICT' }
      else {
        const id = `bk-${cloud.bookings.length + 1}`
        cloud.bookings.push({ id, studentId: payload.studentId, studentName: '乙学员', packageId: payload.packageId, date: payload.date, hour: payload.hour, minute: payload.minute || 0, typeName: '常规训练', price: 100, status: 'booked' })
        cloud.revision += 1
        result = { ok: true, result: { bookingId: id }, datasetRevision: cloud.revision }
      }
    } else result = { ok: false, code: 'COMMAND_NOT_ALLOWED' }
    cloud.receipts.set(requestId, { status: result.ok ? 'succeeded' : 'failed', response: copy(result) })
    if (result.ok) { cloud.memoryRevision = cloud.revision; writeCache(); return { ...copy(result), refreshed: { ok: true } } }
    return copy(result)
  }
}

// ---------------------------------------------------------------- ui-cloud-command 门面（在 require mutate 之前注入）
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
    // 与真 ui-cloud-command 同名的通道：同步引擎在「create 刚落云」那一刻调它推进同一时段的取消。
    // ⚠️ 这是**手写门面**，所以「真门面到底有没有导出它」必须另用静态断言钉住（见场景⑥）。
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
  newRequestId: () => `req-c${++requestSeq}`,
  readDatasetId: () => DATASET,
  readSnapshot: () => { const cache = wx.getStorageSync(runtime.cacheKey()); return cache && cache.snapshot },
  showToast: options => ui.toasts.push(options),
  showModal: options => ui.modals.push(options)
})
ACTIVE.coordinator = coordinator

const bookA = { id: 'bk-A', studentId: 'stu-A', packageId: 'pkg-A', date: DATE, hour: 11, minute: 0 }
// createBooking 的载荷只能是契约允许的恰好五个字段（云端 requireOnly 是硬门禁）——
// 场景⑤ 里这条 A 是本机新建的，正式 id 由云端生成，所以载荷里绝不能带 id。
const bookANew = { studentId: 'stu-A', packageId: 'pkg-A', date: DATE, hour: 11, minute: 0 }
const bookB = { studentId: 'stu-B', packageId: 'pkg-B', date: DATE, hour: 11, minute: 0 }
const reset = () => {
  ui.calls.length = 0; ui.toasts.length = 0; ui.modals.length = 0
  for (const key of Object.keys(store)) delete store[key]
  store.coachDataSourceMode = 'cloud-primary'
  store.coachCloudCutoverState = { status: 'cloud-primary' }
  cloud.holdCancel = false; cloud._releaseCancel = null; cloud.dropCancelBeforeApply = 0; cloud.online = true
  cloud.holdCreate = false; cloud._releaseCreate = null
  seedCloud([{ id: 'bk-A', studentId: 'stu-A', studentName: '甲学员', packageId: 'pkg-A', date: DATE, hour: 11, minute: 0, typeName: '常规训练', price: 100, status: 'booked' }])
  projection.invalidate()
}
const actionsFrom = from => ui.calls.slice(from).filter(call => call.name === 'execute').map(call => call.command)
const countFrom = (from, name) => ui.calls.slice(from).filter(call => call.name === name).length

async function run() {
  // ============================================================ ① 本机秒取消：同一时段立刻重约
  {
    reset()
    const cancel = await coordinator.cancel({ officialId: 'bk-A', booking: bookA })
    assert.equal(cancel.ok, true, '取消必须当场受理：' + JSON.stringify(cancel))
    assert.equal(cancel.deferred, true, '取消必须前台返回、后台落实（不 await 云端）')
    // ★ 本机事实层：这一条是"不再显示仍占用该时段"的全部依据。
    const db = runtime.getDB()
    assert.equal(db.bookings.filter(row => row.id === 'bk-A').length, 0,
      '★ 取消之后本机投影里必须已经没有这条预约（否则冲突检测照样把它当占用）')
    // 立刻约 B（同一时段、不同学员）—— 修前这里会被 BOOKING_TIME_CONFLICT 挡下。
    const created = await mutate('createBooking', bookB, { key: 'k-b' })
    assert.equal(created.ok, true, '★ 取消之后同一时段必须能立刻约给别人，实得 ' + JSON.stringify(created))
    assert.equal(created.path, 'local-first', '预约必须走本机先行（秒回）')
    const entries = outbox.list(SCOPE)
    assert.equal(entries.length, 1, '新预约必须进队列（本机先行）')
    assert.ok(entries[0].afterCancelKey, '★ 新预约必须记下"要等哪条取消先落云"（排序门）')
    assert.equal(runtime.getDB().bookings.filter(row => row.id === 'bk-A').length, 0, '取消之后 A 不能回来')
    assert.ok(runtime.getDB().bookings.some(row => row.id === entries[0].localIds.booking), '本机投影里必须已经有 B（秒约）')
  }

  // ============================================================ ② 首次取消不查回执：与新增同等级
  {
    reset()
    const from = ui.calls.length
    await coordinator.cancel({ officialId: 'bk-A', booking: bookA })
    await settle()
    assert.deepEqual(actionsFrom(from), ['cancelBooking'], '首次取消恰好一次云写')
    assert.equal(countFrom(from, 'getReceipt'), 0,
      '★ 首次取消不许先查回执 —— 那条取消命令从未出网，云端一定没有它（白查一跳就是"取消比新增慢"的来源）')
    assert.equal(countFrom(from, 'readActive'), 0, '已有正式 id 时不许为了取消补一次完整回读')
    const exec = ui.calls.slice(from).find(call => call.name === 'execute')
    assert.deepEqual(exec.payload, { bookingId: 'bk-A' }, '取消载荷只能有 bookingId（与云端 requireOnly 同口径）')
    assert.equal(cloud.bookings.length, 0, '取消必须真的落到云端')
    assert.equal(cancellation.list('production', DATASET).length, 0, '云端确认 + 回读成功之后 tombstone 必须清除')
  }

  // ============================================================ ③ 排序门：B 绝不抢在 A 的取消之前出网
  {
    reset()
    cloud.holdCancel = true
    await coordinator.cancel({ officialId: 'bk-A', booking: bookA })
    await settle(6)
    assert.equal(cloud.bookings.length, 1, '（闸门：取消被云上挂住，A 仍在）')
    const created = await mutate('createBooking', bookB, { key: 'k-b2' })
    assert.equal(created.ok, true, '本机秒回不受影响')
    const from = ui.calls.length
    const flushed = await sync.flush()
    assert.equal(cancelledCount(flushed), 0)
    assert.equal(actionsFrom(from).includes('createBooking'), false,
      '★ 取消还没落云时，同一时段的新预约绝不能出网（否则会被云端 TIME_CONFLICT 明确拒绝并归档）')
    // 放开闸门：取消落云 → 门打开。
    cloud.holdCancel = false
    if (cloud._releaseCancel) cloud._releaseCancel()
    await settle()
    assert.equal(cloud.bookings.filter(row => row.id === 'bk-A').length, 0, '取消必须已落云')
    await sync.flush()
    await settle()
    // 云端最终事实：A 不存在、B 恰好 1 条、没有幽灵预约。
    assert.equal(cloud.bookings.filter(row => row.id === 'bk-A').length, 0, '★ 最终：A 必须不存在')
    assert.equal(cloud.bookings.filter(row => row.studentId === 'stu-B').length, 1, '★ 最终：B 恰好 1 条')
    assert.equal(cloud.bookings.length, 1, '★ 最终：这个时段上只剩 B 一条（无双预约、无幽灵预约）')
  }

  // ============================================================ ④ 可靠上云：明确未受理 ⇒ 原号补发
  {
    reset()
    cloud.dropCancelBeforeApply = 1
    await coordinator.cancel({ officialId: 'bk-A', booking: bookA })
    await settle()
    const rows = cancellation.list('production', DATASET)
    assert.equal(rows.length, 1, '取消还没落云，tombstone 必须留着（块继续隐藏）')
    assert.equal(rows[0].status, 'unknown', '响应丢失 ⇒ 状态未知')
    assert.equal(cloud.bookings.length, 1, '云端此时还没有受理这条取消')
    const from = ui.calls.length
    await coordinator.resume()
    await settle()
    const sends = ui.calls.slice(from).filter(call => call.name === 'execute' && call.command === 'cancelBooking')
    assert.equal(sends.length, 1, '★ 云端明确未受理（收据查不到）⇒ 自动恢复必须原号补发，不能永远不上云')
    assert.equal(sends[0].requestId, rows[0].requestId, '★ 补发必须用同一个号（幂等：云端只会认作同一次请求）')
    assert.equal(cloud.bookings.length, 0, '★ 补发之后云端必须真的取消了')
    assert.equal(cancellation.list('production', DATASET).length, 0, '落云 + 回读成功后 tombstone 清除')
  }

  // ============================================================ ⑤ 被取消的本机意图不再叠加（刚约完立刻取消）
  {
    reset()
    seedCloud([])
    const key = pending.bookingKey(bookANew)
    // 这条预约的 create 命令"已经发出、结果还没落定"（pending + confirming）——
    // 取消它时必须**先问 create 的结果**，绝不抢先发一条没有正式 id 的 cancelBooking。
    // 于是 tombstone 会停在 waiting（本机语义：还没有正式 id 可用），块继续隐藏。
    pending.create('production', DATASET, key, 'req-create-A', bookANew, { id: `pending:${key}`, ...bookANew }, Date.now())
    pending.patch('production', DATASET, key, 'req-create-A', { status: 'confirming' })
    const queued = await mutate('createBooking', bookANew, { key: 'k-a5' })
    assert.equal(queued.ok, true, '（前置）本机先约上 A：' + JSON.stringify(queued))
    assert.ok(runtime.getDB().bookings.some(row => row.studentId === 'stu-A'),
      '（前置）本机投影里先看得见这条待确认预约')
    await coordinator.cancel({ localKey: key, booking: bookANew })
    assert.equal(runtime.getDB().bookings.filter(row => row.studentId === 'stu-A').length, 0,
      '★ 取消之后这条"还没转正的"预约也必须从投影里消失（本机意图被撤，不再参与冲突判定）')
    const created = await mutate('createBooking', bookB, { key: 'k-b5' })
    assert.equal(created.ok, true, '★ 同一时段必须能立刻约给别人（本机事务不许再拿它当占用）')
    assert.equal(cancellation.get('production', DATASET, key).status, 'waiting',
      'create 结果还没落定 ⇒ tombstone 必须继续留着（块保持隐藏）')
  }

  // ============================================================ ⑥ 静态契约：一条链，不是两条
  {
    const fs = require('fs')
    // 只数**代码**里的调用点（注释里提到增量不算）—— 与 incremental-cross-device-sync 同口径。
    const strip = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const adapterSource = strip(fs.readFileSync(path.join(PROJ, 'utils', 'cloud-primary-adapter.js'), 'utf8'))
    assert.equal((adapterSource.match(/action:\s*'changes'/g) || []).length, 1,
      '增量读取只有一个调用点（新增与取消共用同一套机制，不许再各打一条补丁）')
    const projectionSource = fs.readFileSync(path.join(PROJ, 'utils', 'local-projection.js'), 'utf8')
    assert.ok(/pending-cancellation/.test(projectionSource), '投影必须把取消待确认折进来（本机秒取消的地基）')
    assert.ok(/applyCommand\(db, 'cancelBooking'/.test(projectionSource),
      '投影必须用**同一份** cancelBooking handler 算取消，而不是自己"删一行"（规则只有一份）')
    const syncSource = fs.readFileSync(path.join(PROJ, 'utils', 'sync-engine.js'), 'utf8')
    assert.ok(/heldByCancel/.test(syncSource), '同步引擎必须按"取消是否落云"排序')
    // 「create 刚落云 → 推进同一时段的取消」这条通道必须**两头都在**：
    // 手写门面（本文件里的 ui stub）很容易把真门面漏掉的一件事整个盖住，所以这里直接读真源码。
    const commandSource = fs.readFileSync(path.join(PROJ, 'utils', 'ui-cloud-command.js'), 'utf8')
    assert.ok(/advancePendingCancellations/.test(commandSource),
      '★ 门面必须把「create 落云后推进取消」暴露出去，否则同步引擎调了个空')
    assert.ok(/advancePendingCancellations/.test(syncSource),
      '★ 同步引擎必须在 create 落云那一刻叫它一次（否则等 create 结果的取消永远没人推进）')
    const optimisticSource = fs.readFileSync(path.join(PROJ, 'utils', 'booking-optimistic.js'), 'utf8')
    assert.ok(/advanceCancellations/.test(optimisticSource), '协调器必须提供这个窄入口')
    assert.ok(/queuedCreates/.test(optimisticSource),
      '★ 判「云端从来没有过」之前必须先确认队列里没有一条可能已经出网的 create')
  }

  // ============================================================ ⑦ 幽灵预约闸（一）：队列里那条 create 从未出网
  {
    reset()
    seedCloud([])
    const key = pending.bookingKey(bookANew)
    // 断网时录的课：本机已经记下意图、进了队列，但一条都没发出去（真机：断网 / 恢复期引擎不发）。
    cloud.online = false
    const queued = await mutate('createBooking', bookANew, { key: 'k-a7' })
    assert.equal(queued.ok, true, '（前置）断网也要能本机先记下这条预约：' + JSON.stringify(queued))
    await settle()
    const rows = outbox.list(SCOPE).filter(entry => entry.command === 'createBooking')
    assert.equal(rows.length, 1, '（前置）队列里有一条还没发出的 create')
    assert.equal(Number(rows[0].attempts || 0), 0, '（前置）它从未出网（重试预算一点没被消耗）')
    // 网络回来，用户此刻取消它。云端当然还没有这条 —— 但"云端从来没有过"这句话，
    // 只有在本机**也没有一条正等着发上去的 create** 时才是永久的。
    cloud.online = true
    const from = ui.calls.length
    await coordinator.cancel({ localKey: key, booking: bookANew })
    await settle()
    assert.equal(cancellation.list('production', DATASET).length, 0,
      '从未出网 ⇒「云端从来没有过」成立，tombstone 可以清干净')
    assert.equal(outbox.list(SCOPE).filter(entry => entry.command === 'createBooking').length, 0,
      '★★ 队列里那条 create 必须同时被撤掉 —— 否则它照旧会发上云，另一台设备就多出一条幽灵预约')
    assert.equal(actionsFrom(from).length, 0, '全程零云写（这本来就是本机自己的事）')
    await settle()
    assert.equal(cloud.bookings.length, 0, '★★ 最终云端必须一条都没有（无幽灵预约）')
  }

  // ============================================================ ⑧ 幽灵预约闸（二）+ 事件驱动推进
  {
    reset()
    seedCloud([])
    const key = pending.bookingKey(bookANew)
    cloud.holdCreate = true
    await mutate('createBooking', bookANew, { key: 'k-a8' })
    // 用**状态条件**等它真的出网，不靠固定 sleep。
    let inflight = false
    for (let i = 0; i < 300 && !inflight; i++) {
      await delay(1)
      inflight = outbox.list(SCOPE).some(entry => entry.command === 'createBooking' && entry.status === 'inflight')
    }
    assert.equal(inflight, true, '（前置）队列里那条 create 已经出网、还在等云端结论')
    await coordinator.cancel({ localKey: key, booking: bookANew })
    await settle()
    const row = cancellation.get('production', DATASET, key)
    assert.equal(row && row.status, 'waiting',
      '★ 队列里那条 create 可能已经出网 ⇒ 不许下"云端从来没有过"的结论，必须保持未落定')
    assert.equal(outbox.list(SCOPE).some(entry => entry.command === 'createBooking'), true,
      '★★ 那条 create 不许被撤掉（它可能已经在云端了）')
    assert.equal(actionsFrom(0).filter(command => command === 'cancelBooking').length, 0,
      '没有正式 id 时绝不许抢先发一条取消（那是一条必然找不到记录的云写）')
    // 放开 create 的闸门：它落云 → 同步引擎必须在**这一刻**把那条停在 waiting 的取消推进一次。
    // （没有这一步，那条取消要等到用户再进一次课表页才有人管 —— B 会被云端按冲突拒掉。）
    cloud.holdCreate = false
    if (cloud._releaseCreate) cloud._releaseCreate()
    await settle()
    assert.equal(cloud.bookings.length, 0,
      '★★ 最终云端必须一条都没有：create 落云后被那条取消追上，不许留下 A（幽灵预约）')
    assert.equal(cancellation.list('production', DATASET).length, 0, '取消落云 + 回读成功后 tombstone 清除')
  }

  console.log('booking cancel instant release: PASS (本机秒释放 / 一跳上云 / 原号补发 / 先取消后重约排序 / 无幽灵预约)')
}

function cancelledCount(summary) { return summary && summary.rejected ? summary.rejected : 0 }

run().catch(error => { console.error(error); process.exitCode = 1 })
