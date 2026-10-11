// 【2026-09-27 真机事故永久回归】Sandbox Outbox 长期不收敛（真机：unknown=1 / pending=25）。
//
// 真机账本（M2 验收页「数据源与读取状态」卡）：
//   open=26（unknown 1 + pending 25）· inProjection=24 · settledStuck=0
//   updateBookingContent 12 / createCustomExercise 9 / completeBooking 5 · failed 里有 ENVIRONMENT_CHANGED
//   ⇒ 25 条 pending **一次都没出过网**：队首那条 unknown 在
//      `if (status==='unknown' && attempts>=3 && nextAttemptAt>now) break` 把**整轮**结束掉，
//      于是排在它后面的 25 条永远轮不到（全局 FIFO，每轮只推 entries[0]）。
//
// 本文件守的是四条硬规矩（缺一条就会重新积累）：
//   ① 队首一条卡住 ⇒ **只 stall 它**，与它无依赖的条目照常推进（按实体 / 依赖链分组）；
//   ② unknown 必须先按**原 requestId** 查回执：succeeded 收敛 / failed 归档 / 查不到保留等待；
//      绝不为了清队列丢业务事实，也绝不换 requestId 重发；
//   ③ 引用了"尚未转正的本机 id"的条目必须等，不许越过它依赖的那条命令；
//   ④ 条目所属环境与当前作用域不同 ⇒ **一次都不许出网**（Sandbox 条目绝不能进 Production）。
//
// 只替换「云」与 ui-cloud-command 门面，其余全部是真模块：sync-engine / local-outbox /
// local-projection / local-transaction / data-runtime。
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const PROJ = path.join(__dirname, '..')
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const settle = async (rounds = 30) => { for (let i = 0; i < rounds; i++) await delay(1) }

const DATASET = 'ds-sandbox-77548e'
const SCOPE = { environment: 'sandbox', datasetId: DATASET }

// ---------------------------------------------------------------- Storage / wx
const store = {}
const ui = { calls: [], toasts: [], modals: [] }
global.wx = {
  getStorageSync: key => copy(store[key]),
  setStorageSync: (key, value) => { store[key] = copy(value) },
  removeStorageSync: key => { delete store[key] },
  showToast: options => ui.toasts.push(options),
  showModal: options => ui.modals.push(options),
  showLoading() {}, hideLoading() {},
  getNetworkType: options => options.success({ networkType: 'wifi' }),
  onNetworkStatusChange() {},
  setClipboardData: options => { if (options && options.success) options.success({}) },
  cloud: { callFunction: () => Promise.resolve({ result: { ok: false, code: 'NOT_USED' } }) }
}

// ---------------------------------------------------------------- 「云」
const cloud = {
  revision: 100,
  memoryRevision: 100,
  receipts: new Map(),
  applied: [],
  online: true,
  // 让指定命令"结果未知"（用来造真机那种 unknown 队首）
  unknownFor: new Set(),
  // 让回执查询失败（网络问题）⇒ 必须保留等待
  receiptFails: false,
  // 命令成功后是否给 refreshed（false ⇒ 走 settled 路径）
  refreshAfterWrite: true
}
function writeCache() {
  store.coachSandboxActiveCache = {
    environment: 'sandbox', datasetId: DATASET, revision: cloud.revision,
    checksum: `chk${cloud.revision}`, byteSize: 10,
    snapshot: { students: [], bookings: [], incomes: [], customExercises: [], settings: {} }
  }
}
const adapter = {
  getState: () => ({ datasetId: DATASET, revision: cloud.memoryRevision }),
  resetState() {},
  async readActive() {
    ui.calls.push({ name: 'readActive' })
    if (!cloud.online) return { ok: false, code: 'OFFLINE_CACHE_MISSING' }
    cloud.memoryRevision = cloud.revision
    writeCache()
    return { ok: true, environment: 'sandbox', datasetId: DATASET, revision: cloud.revision, checksum: `chk${cloud.revision}`, byteSize: 10, snapshot: { students: [], bookings: [], incomes: [], customExercises: [], settings: {} } }
  },
  async getReceipt(requestId) {
    ui.calls.push({ name: 'getReceipt', requestId })
    if (cloud.receiptFails) return { ok: false, code: 'RECEIPT_TRANSPORT_FAILED' }
    const hit = cloud.receipts.get(requestId)
    if (!hit) return { ok: true, found: false }
    return { ok: true, found: true, status: hit.status, response: copy(hit.response) }
  },
  async execute(command, payload, options = {}) {
    const requestId = options.requestId
    if (!cloud.online) return { ok: false, code: 'OFFLINE_READ_ONLY' }
    if (!Number.isInteger(cloud.memoryRevision)) return { ok: false, code: 'REVISION_UNKNOWN' }
    ui.calls.push({ name: 'execute', command, payload: copy(payload), requestId })
    if (cloud.unknownFor.has(command)) return { ok: false, code: 'COMMAND_RESULT_UNKNOWN', requestId, retrySafe: true }
    const existing = cloud.receipts.get(requestId)
    if (existing) return copy(existing.response)     // 幂等：同号重发回同一份结果
    cloud.revision += 1
    cloud.applied.push({ command, payload: copy(payload), requestId, at: cloud.applied.length })
    const result = { ok: true, result: {}, datasetRevision: cloud.revision }
    cloud.receipts.set(requestId, { status: 'succeeded', response: copy(result) })
    cloud.memoryRevision = cloud.revision
    return cloud.refreshAfterWrite ? { ...copy(result), refreshed: { ok: true } } : copy(result)
  }
}

// ---------------------------------------------------------------- ui-cloud-command 门面
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
    cancelBookingRequest: async () => ({ ok: false, code: 'NOT_USED' }),
    retryPendingCancellation: async () => ({ ok: false, code: 'NOT_USED' }),
    advancePendingCancellations: async () => ({}),
    resumePendingBookings: async () => ({}),
    retryPendingBooking: async () => ({}),
    pendingBookingRecords: () => [],
    mergePendingBookings: list => list,
    subscribePendingBookings: () => () => {},
    notifyPendingBookings() {},
    pendingCancellationRecords: () => [],
    officialIdForBooking: () => '',
    awaitOfficialBooking: async key => key,
    bindingForOfficialId: () => null,
    bookingBindings: () => [],
    completionIntentFor: () => null,
    getTimings: () => [], setTimingSink() {},
    lastReadDoneAt: () => 0,
    __writeFunnel: { enter() {}, exit() {} },
    __assertWriteFunnel() {}
  }
}

// ---------------------------------------------------------------- 真模块
const runtime = require(path.join(PROJ, 'utils', 'data-runtime'))
const outbox = require(path.join(PROJ, 'utils', 'local-outbox'))
const projection = require(path.join(PROJ, 'utils', 'local-projection'))
const sync = require(path.join(PROJ, 'utils', 'sync-engine'))

runtime.setEnvironment(runtime.ENVIRONMENTS.SANDBOX)
store.coachDataSourceMode = 'cloud-primary'
store.coachCloudCutoverState = { status: 'cloud-primary' }
store.coachMemberEnvironment = 'sandbox'
writeCache()

const reset = () => {
  ui.calls.length = 0; ui.toasts.length = 0
  for (const key of Object.keys(store)) delete store[key]
  store.coachDataSourceMode = 'cloud-primary'
  store.coachCloudCutoverState = { status: 'cloud-primary' }
  store.coachMemberEnvironment = 'sandbox'
  cloud.revision = 100; cloud.memoryRevision = 100
  cloud.receipts = new Map(); cloud.applied = []
  cloud.online = true; cloud.unknownFor = new Set()
  cloud.receiptFails = false; cloud.refreshAfterWrite = true
  writeCache()
  projection.invalidate()
  // ⚠️⚠️ 2026-10-04 修：本段必须**自行清理去重状态**，否则 ⑩ 段会假红。
  //
  // 病根：`utils/auto-refresh.js` 的 `lastRequestedAt` 是**模块级** Map，`request()` 里有
  //   `if (now - previous < DEDUPE_MS) return false`（DEDUPE_MS = 400）的合并窗口。
  //   ①~⑨ 段早就把 `'bookingCompleted'` 写进了那张表（sync-engine 收敛时调的），
  //   ⑩ 段紧接着（同一个 node 进程、几毫秒内）再请求 ⇒ 被去重**吞掉** ⇒ `seen` 是空数组。
  //   实得 `[]` 就是这么来的，**不是**广播逻辑坏了。
  //
  // ⛔ 生产代码一个字都不动：`utils/auto-refresh.js` 与 `utils/sync-engine.js` 属 **Frozen 同步核心**
  //   （真机跨设备约 2 秒已验收）。这里只调它**自己已经导出**的 `unsubscribeAll()`
  //   （其实现里就一句 `lastRequestedAt.clear()`），属测试侧的合法清理口。
  // ⚠️ 必须在各段 `subscribe()` **之前**调用 —— 它也会清 listeners，否则会连本段刚挂的监听一起清掉。
  require(path.join(PROJ, 'utils', 'auto-refresh')).unsubscribeAll()
}
const executedFor = command => ui.calls.filter(call => call.name === 'execute' && call.command === command)
const openRows = () => outbox.openEntries(SCOPE)
async function drain(rounds = 12) {
  for (let i = 0; i < rounds; i++) { await sync.flush(); await settle(12) }
}

async function run() {
  // ============================================================ ① 真机形状：1 unknown + 25 pending
  {
    reset()
    // 队首：一条退避中的 unknown（真机上就是它把整队拖死）
    const stuck = outbox.enqueue(SCOPE, { command: 'completeBooking', payload: { bookingId: 'bk-stuck' }, requestId: 'req-stuck-1', entityKey: 'booking:bk-stuck' }).entry
    outbox.patch(SCOPE, stuck.entryId, { status: 'unknown', attempts: 3, nextAttemptAt: Date.now() + 600000, lastError: { code: 'COMMAND_RESULT_UNKNOWN', message: '传输层抛错' } })
    // 后面 25 条：与它**不同实体、无引用依赖**（真机上的 createCustomExercise 就是这种）
    for (let i = 0; i < 25; i++) {
      outbox.enqueue(SCOPE, { command: 'createCustomExercise', payload: { name: `动作${i}` }, requestId: `req-ex-${i}`, entityKey: `exercise:loc_ex_${i}` })
    }
    assert.equal(openRows().length, 26, '（前置）队列里必须是 26 条')
    await drain()
    assert.equal(executedFor('createCustomExercise').length, 25,
      '★★★ 队首那条 unknown 绝不能拖死后面 25 条：它们必须全部出网，实得 ' + executedFor('createCustomExercise').length)
    assert.equal(outbox.count(SCOPE), 1, '★ 卡住的那条必须**保留**在队列里（绝不为了清队列丢业务事实），实得 ' + outbox.count(SCOPE))
    assert.equal(outbox.failed(SCOPE).length, 0, '★ 查不到结论的命令不许被当成"业务失败"归档')
  }

  // ============================================================ ② unknown 查回执：succeeded ⇒ 安全收敛
  {
    reset()
    cloud.refreshAfterWrite = false
    const entry = outbox.enqueue(SCOPE, { command: 'completeBooking', payload: { bookingId: 'bk-1' }, requestId: 'req-ok-1', entityKey: 'booking:bk-1' }).entry
    outbox.patch(SCOPE, entry.entryId, { status: 'unknown', attempts: 1, nextAttemptAt: 0, lastError: { code: 'COMMAND_RESULT_UNKNOWN' } })
    // 云端其实早就成功了（回执写在同一事务里）
    cloud.receipts.set('req-ok-1', { status: 'succeeded', response: { ok: true, result: {}, datasetRevision: cloud.revision + 1 } })
    await drain()
    assert.equal(executedFor('completeBooking').length, 0,
      '★★★ 回执说 succeeded ⇒ 绝不许再发一次命令（重发一条已成功的命令就是重复业务）')
    assert.equal(openRows().filter(row => row.requestId === 'req-ok-1').length, 0,
      '★ 回执确认成功后必须收敛出队，实得 ' + JSON.stringify(openRows().map(r => r.requestId)))
    assert.equal(outbox.failed(SCOPE).length, 0, '★ 成功收敛不得被记成失败')
  }

  // ============================================================ ③ unknown 查回执：failed ⇒ 归档且不许重发
  {
    reset()
    const entry = outbox.enqueue(SCOPE, { command: 'completeBooking', payload: { bookingId: 'bk-2' }, requestId: 'req-fail-1', entityKey: 'booking:bk-2' }).entry
    outbox.patch(SCOPE, entry.entryId, { status: 'unknown', attempts: 1, nextAttemptAt: 0, lastError: { code: 'COMMAND_RESULT_UNKNOWN' } })
    cloud.receipts.set('req-fail-1', { status: 'failed', response: { ok: false, code: 'PACKAGE_NO_REMAINING' } })
    await drain()
    assert.equal(executedFor('completeBooking').length, 0, '★★ 回执说失败 ⇒ 绝不许再发')
    assert.equal(outbox.failed(SCOPE).filter(row => row.requestId === 'req-fail-1').length, 1,
      '★ 明确失败必须归档留档（它是"云端拒过"的唯一证据）')
    assert.equal(openRows().length, 0, '★ 归档后不再计入未落定')
  }

  // ============================================================ ④ unknown 查不到回执 ⇒ 保留等待，绝不换号
  {
    reset()
    cloud.receiptFails = true
    const entry = outbox.enqueue(SCOPE, { command: 'completeBooking', payload: { bookingId: 'bk-3' }, requestId: 'req-wait-1', entityKey: 'booking:bk-3' }).entry
    outbox.patch(SCOPE, entry.entryId, { status: 'unknown', attempts: 1, nextAttemptAt: 0, lastError: { code: 'COMMAND_RESULT_UNKNOWN' } })
    await drain()
    assert.equal(executedFor('completeBooking').length, 0, '★★★ 查不到回执（网络问题）⇒ 绝不许盲目重发')
    const left = openRows().filter(row => row.requestId === 'req-wait-1')
    assert.equal(left.length, 1, '★ 查不到结论的条目必须原样保留在队列里')
    assert.equal(left[0].requestId, 'req-wait-1', '★ requestId 一个字符都不许变（换号 = 放弃幂等）')
    assert.equal(outbox.failed(SCOPE).length, 0, '★ 查不到回执绝不能当成失败归档')
  }

  // ============================================================ ⑤ 有依赖的命令不许越过：引用尚未转正的本机 id
  {
    reset()
    // 队首：一条 unknown（会被 stall+blocked），它"将要产出" booking = loc_booking_dep
    const head = outbox.enqueue(SCOPE, {
      command: 'createBooking', payload: { studentId: 'stu-1', packageId: 'pkg-1', date: '2026-09-27', hour: 10, minute: 0 },
      requestId: 'req-dep-head', entityKey: 'booking:loc_booking_dep', localIds: { booking: 'loc_booking_dep' }
    }).entry
    outbox.patch(SCOPE, head.entryId, { status: 'unknown', attempts: 3, nextAttemptAt: Date.now() + 600000, lastError: { code: 'COMMAND_RESULT_UNKNOWN' } })
    // 第二条：**引用**那条尚未转正的 booking ⇒ 必须等
    outbox.enqueue(SCOPE, {
      command: 'updateBookingContent', payload: { bookingId: 'loc_booking_dep', items: [{ name: '深蹲' }] },
      requestId: 'req-dep-content', entityKey: 'booking:loc_booking_dep'
    })
    // 第三条：与它毫无关系 ⇒ 必须照常推进
    outbox.enqueue(SCOPE, { command: 'createCustomExercise', payload: { name: '腿举' }, requestId: 'req-dep-ex', entityKey: 'exercise:loc_ex_dep' })
    await drain()
    assert.equal(executedFor('updateBookingContent').length, 0,
      '★★★ 引用了尚未转正 id 的命令绝不能越过（否则必然 BOOKING_NOT_FOUND，内容永久丢失）')
    assert.equal(executedFor('createCustomExercise').length, 1,
      '★★ 无关命令必须照常推进（这才是"不拖死全队"的意义）')
    assert.equal(executedFor('createBooking').length, 0, '★ 队首那条仍在等待，不得重发')
  }

  // ============================================================ ⑥ 同 requestId 幂等：只入队一次、只落库一次
  {
    reset()
    const first = outbox.enqueue(SCOPE, { command: 'createCustomExercise', payload: { name: '卧推' }, requestId: 'req-idem-1', entityKey: 'exercise:loc_ex_1' })
    const second = outbox.enqueue(SCOPE, { command: 'createCustomExercise', payload: { name: '卧推' }, requestId: 'req-idem-1', entityKey: 'exercise:loc_ex_1' })
    assert.equal(second.created, false, '★ 同 requestId 重复入队必须命中同一条（幂等）')
    assert.equal(openRows().length, 1, '★ 队列里只能有一条')
    await drain()
    assert.equal(executedFor('createCustomExercise').filter(call => call.requestId === 'req-idem-1').length, 1,
      '★ 同一个号只允许出一次网')
    assert.equal(cloud.applied.filter(row => row.requestId === 'req-idem-1').length, 1,
      '★★ 云端只落库一次（不重复扣课 / 不重复记收入）')
  }

  // ============================================================ ⑦ Sandbox / Production 严格隔离
  {
    reset()
    // 往 sandbox 桶里塞一条"属于 production"的条目（模拟环境切换留下的历史条目）
    const foreign = outbox.enqueue(SCOPE, { command: 'createCustomExercise', payload: { name: '串环境' }, requestId: 'req-foreign-1', entityKey: 'exercise:loc_ex_f' }).entry
    outbox.patch(SCOPE, foreign.entryId, { environment: 'production' })
    // 正常的一条（sandbox）
    outbox.enqueue(SCOPE, { command: 'createCustomExercise', payload: { name: '正常' }, requestId: 'req-local-1', entityKey: 'exercise:loc_ex_l' })
    await drain()
    const sentIds = ui.calls.filter(call => call.name === 'execute').map(call => call.requestId)
    assert.equal(sentIds.includes('req-foreign-1'), false,
      '★★★ 所属环境不是当前环境的条目**一次都不许出网**（Sandbox 条目绝不能被送去 Production）')
    assert.equal(sentIds.includes('req-local-1'), true, '★ 本环境的条目照常发送')
    assert.equal(openRows().filter(row => row.requestId === 'req-foreign-1').length, 1,
      '★ 环境不符的条目必须原样保留（等人处理，绝不丢弃）')
  }

  // ============================================================ ⑧ ENVIRONMENT_CHANGED 不许被当成业务拒绝
  {
    reset()
    const src = fs.readFileSync(path.join(PROJ, 'utils', 'sync-engine.js'), 'utf8')
    assert.ok(src.includes("code === 'ENVIRONMENT_CHANGED'"), '★ 必须显式处理 ENVIRONMENT_CHANGED')
    // 注意取**最后**那处 reject：前面「回执说失败」分支里也有一个同名的归档调用。
    assert.ok(src.indexOf("code === 'ENVIRONMENT_CHANGED'") < src.lastIndexOf('const failure = outbox.reject'),
      '★★★ ENVIRONMENT_CHANGED 必须排在"明确业务拒绝"之前（它不是业务拒绝，不许归档）')
    assert.ok(src.includes('entry.environment !== current.environment'), '★ 必须有环境硬隔离检查')
  }

  // ============================================================ ⑨ 静态：队首不再用 break 结束整轮
  {
    const src = fs.readFileSync(path.join(PROJ, 'utils', 'sync-engine.js'), 'utf8')
    // ⚠️ 判据盯着**退避判定本身**（`attempts >= 3` + stall），不再钉死整行文字：
    //    2026-09-28 第 5 次修正给它加了 `!cooling` 前缀（冷却条目另走"到期就完整评估"的路径）。
    const line = src.split('\n').find(text => text.includes("attempts >= 3") && text.includes('nextAttemptAt'))
    assert.ok(line, '★ 必须保留退避中的 unknown 判定')
    assert.ok(/stall\.add|stall\.add\(/.test(line) || /continue/.test(line),
      '★★★ 退避中的 unknown 必须 stall（跳过它继续推进），绝不能 break 结束整轮：' + line)
    assert.ok(src.includes('function dependsOnEarlier'), '★ 必须有依赖判定函数（按依赖链分组推进）')
    assert.ok(src.includes('function resolveUnknownByReceipt'), '★ unknown 必须有按 requestId 查回执的收口')
    // ★ 权威读取成功后必须排一轮同步 —— 这句话在 ui-cloud-command 的 refreshActiveView 里，
    //   旧行为下 flush 只由「写命令 / 冷启动 / 回前台 / 网络变化」触发，
    //   于是"用户进页面、下拉、回前台读一百次，队列一次都不推进"。
    const uiSrc = fs.readFileSync(path.join(PROJ, 'utils', 'ui-cloud-command.js'), 'utf8')
    const refreshAt = uiSrc.indexOf('async function refreshActiveView')
    const refreshBody = uiSrc.slice(refreshAt, refreshAt + 2200)
    assert.ok(refreshAt >= 0, '★ 必须存在 refreshActiveView')
    assert.ok(/adapter\.readActive/.test(refreshBody), '★ 权威读取必须真的读云端')
    assert.ok(/require\('\.\/sync-engine'\)\.schedule\(\)/.test(refreshBody),
      '★★★ 读取成功后必须排一轮同步：否则用户怎么刷新队列都不动（真机 26 条就是这么攒出来的）')
  }
  // ============================================================ ⑩ 队列收敛 ⇒ 必须广播一次刷新（2026-09-28 真机）
  //
  // 真机形状：命令**提交成功**那一刻已经广播过一次，但那时本机 cache 还没翻完；
  // 真正收敛（条目拿到云端硬证据后出队）是另一次事件，它若不上报，
  // 界面会一直停在「完成同步中」，直到用户重新进页面 / 回前台 / 下拉 —— 用户会以为卡住了。
  {
    reset()
    const autoRefresh = require(path.join(PROJ, 'utils', 'auto-refresh'))
    const seen = []
    const unsubscribe = autoRefresh.subscribe(reason => seen.push(reason))
    try {
      outbox.enqueue(SCOPE, { command: 'completeBooking', payload: { bookingId: 'bk-sync-1' }, requestId: 'req-sync-1', entityKey: 'booking:bk-sync-1' })
      await drain()
      assert.equal(outbox.count(SCOPE), 0, '（前置）完课必须真正收敛出队')
      assert.ok(seen.includes('bookingCompleted'),
        '★★★ 完课条目离开队列时必须广播 bookingCompleted：否则「完成同步中」永远不会自动变成「已完成」（实得 ' + JSON.stringify(seen) + '）')
      // ⛔ 绝不能是轮询：广播只能由"条目真的离开队列"触发，队列空时一次都不许发。
      seen.length = 0
      await drain(3)
      assert.equal(seen.length, 0,
        '★★★ 队列已空时不得再广播 —— 这说明补的是轮询而不是收敛事件（实得 ' + JSON.stringify(seen) + '）')
    } finally { unsubscribe() }
  }

  // ============================================================ ⑪ 静态：广播只挂在"条目真的出队"那两处
  {
    const src = fs.readFileSync(path.join(PROJ, 'utils', 'sync-engine.js'), 'utf8')
    const purgeAt = src.indexOf('async function purgeSettled')
    const body = src.slice(purgeAt, src.indexOf('function errorRecord'))
    assert.ok(/broadcastSettled\(ready\)/.test(body) && /broadcastSettled\(readyOut\)/.test(body),
      '★★★ purgeSettled 的两条出队路径都必须广播（缺一条就有一半收敛事件不上报）')
    // ★ 第三条：命令成功且回读成功时条目在**发送循环里**当场出队，压根不走 purgeSettled ——
    //   少了它，最常见那条路径（网络正常）的收敛就完全不上报（本次就是先漏了这一处）。
    assert.ok(/broadcastSettled\(\[entry\]\)/.test(src),
      '★★★ 发送循环里"回读成功即出队"那条路径也必须广播')
    // 广播必须排在 outbox.remove **之后**：先出队再上报，页面读到的才是"队列已空"的那一帧。
    assert.ok(body.indexOf('outbox.remove') < body.indexOf('broadcastSettled'),
      '★★★ 广播必须排在条目出队之后（先广播会让页面读到还没清空的队列）')
    assert.ok(src.includes("require('./auto-refresh')"), '★ 必须走既有刷新总线，不得新造一套广播')
  }
}

run().then(() => { console.log('sandbox outbox convergence: PASS') }, error => { console.error('sandbox outbox convergence: FAIL'); console.error(error); process.exit(1) })
