// 【2026-09-28 真机事故永久回归】unknown 的**出口**（更新版）
//
// 真机账本（M2 验收页）：06:56 26 条 → 06:58 8 条 ⇒ 上一批修复（队首不再拖死全队 / 读取后排同步）确实生效。
// 但**剩下的 8 条没有出口**：unknown 3 + pending 5，最老一条
//   `updateBookingContent / unknown / 已试 47 次 / COMMAND_RESULT_UNKNOWN`
//
// 根因（三条，全部是**缺出口**，不是业务规则）：
//   ① 「云端没有这个编号」之后**直接原号重发**，中间再没有第二道闸 ——
//       attempts 每 +1 都是一次真的出网，退避曲线第 6 次之后就封顶 30 秒 ⇒ 47 次就这么烧出来；
//   ② `factVisibleInSnapshot` 只覆盖 create/cancel/complete，**内容类命令从来不看业务事实**，
//      于是"这份内容其实已经在云端了"这种情况仍会被一遍遍重发（内容命令是**覆写**，会把更新的内容盖回去）；
//   ③ 目标已经消失 / 已被更晚版本接管这两种**可判定的终局**，当时没有任何 Handler ⇒ 永远不会离开队列。
//
// 本文件守的是「每一条都有确定、安全、可解释的出口」：
//   ① 事实已在云端 ⇒ **零重发**，按已认可收敛（内容类：同一套规则重算一遍，逐字段比对）；
//   ② 目标还在、事实没到 ⇒ 允许原号重发，但**有上限**，到顶转 30 分钟一次的慢速重试并写明 reason；
//   ③ 目标已消失 / 已被更晚的同字段命令接管 ⇒ 归档**留档**（payload+requestId+理由永久可查），不静默丢弃；
//   ④ 慢速重试的条目**不再阻挡**同实体的后续命令（否则整条实体链被永久冻住）。
// ⚠️ 全程不许换 requestId、不许猜成功、不许为了把数字变短删条目。
//
// 只替换「云」与 ui-cloud-command 门面，其余全部是真模块：sync-engine / local-outbox /
// local-projection / local-transaction / data-runtime / cloud-command-engine。
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const PROJ = path.join(__dirname, '..')
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const settle = async (rounds = 12) => { for (let i = 0; i < rounds; i++) await delay(1) }

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
  // 云端那份快照里的 bookings（刻意做成**可控**，用来造"事实已在/未在/目标消失"三种地形）
  bookings: [],
  unknownFor: new Set(),
  receiptFails: false,
  refreshAfterWrite: true
}
function writeCache() {
  store.coachSandboxActiveCache = {
    environment: 'sandbox', datasetId: DATASET, revision: cloud.revision,
    checksum: `chk${cloud.revision}`, byteSize: 10,
    snapshot: { students: [], bookings: copy(cloud.bookings), incomes: [], customExercises: [], settings: {} }
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
    return { ok: true, environment: 'sandbox', datasetId: DATASET, revision: cloud.revision, checksum: `chk${cloud.revision}`, byteSize: 10, snapshot: { students: [], bookings: copy(cloud.bookings), incomes: [], customExercises: [], settings: {} } }
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
    // 刻意让这条命令**永远拿不到结论**（真机上就是云端超时 / 调用失败这一个形状）
    if (cloud.unknownFor.has(command)) return { ok: false, code: 'COMMAND_RESULT_UNKNOWN', retrySafe: true, reason: 'CLOUD_FUNCTION_TIMEOUT' }
    const existing = cloud.receipts.get(requestId)
    if (existing) return copy(existing.response)
    cloud.revision += 1
    cloud.applied.push({ command, payload: copy(payload), requestId, at: cloud.applied.length })
    const result = { ok: true, result: {}, datasetRevision: cloud.revision }
    cloud.receipts.set(requestId, { status: 'succeeded', response: copy(result) })
    cloud.memoryRevision = cloud.revision
    writeCache()
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

const ITEMS_A = [{ name: '深蹲', sets: 3, reps: 12 }]
const ITEMS_B = [{ name: '硬拉', sets: 4, reps: 8 }]

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
  cloud.bookings = []
  writeCache()
  projection.invalidate()
}
const executedFor = command => ui.calls.filter(call => call.name === 'execute' && call.command === command)
const openRows = () => outbox.openEntries(SCOPE)
const failedRows = () => outbox.failed(SCOPE)
const rowOf = requestId => openRows().find(row => row.requestId === requestId) || null
// 模拟"回到前台 / 网络恢复"：引擎自己也会清退避（`resume()`），不清的话测试方法就退化成"等墙上时钟"。
// ⚠️ **冷却条目不清退避**（2026-09-28 第 5 次修正）：真机上 flush 不会替冷却条目清 nextAttemptAt，
//   只有 `resume()`（回前台 / 网络恢复这类**用户动作**）才会。
//   旧写法连冷却一起清 ⇒ 冷却分支永远走不到 ⇒ 场景⑥其实是在"清完退避"的假地形下通过的，
//   于是"冷却条目会不会拖死同实体后续"这条判据在测试里根本没被真正验证过（判别力漏洞）。
function clearBackoff() {
  openRows().forEach(row => {
    if (Number(row.nextAttemptAt || 0) <= 0) return
    if (Number(row.attempts || 0) >= 10) return      // 冷却中：保留 nextAttemptAt
    outbox.patch(SCOPE, row.entryId, { nextAttemptAt: 0 })
  })
}
async function drain(rounds) {
  for (let i = 0; i < rounds; i++) { clearBackoff(); await sync.flush(); await settle(10) }
}
// 一条「已按我记得的样子把内容保存过」的历史命令（unknown 状态， attempts 已很高）。
function enqueueStuckContent(requestId, bookingId, items, attempts = 5) {
  const { entry } = outbox.enqueue(SCOPE, {
    command: 'updateBookingContent', payload: { bookingId, items, notes: '备注' },
    requestId, entityKey: `booking:${bookingId}`
  })
  return outbox.patch(SCOPE, entry.entryId, {
    status: 'unknown', attempts, nextAttemptAt: 0,
    lastError: { code: 'COMMAND_RESULT_UNKNOWN', reason: 'CLOUD_FUNCTION_TIMEOUT', message: '云端调用中断。' }
  })
}

async function run() {
  // =============================================== ① 事实已在云端 ⇒ 零重发 + 按已认可收敛
  {
    reset()
    // 云端那版里，这份内容**已经在**（正是这条命令要写的那份）
    cloud.bookings = [{ id: 'bk-landed', status: 'booked', items: copy(ITEMS_A), notes: '备注', category: '力量', duration: 60, summary: 'x' }]
    writeCache()
    enqueueStuckContent('req-landed-1', 'bk-landed', ITEMS_A, 8)
    cloud.unknownFor.add('updateBookingContent')
    await drain(6)
    assert.equal(executedFor('updateBookingContent').length, 0,
      '★★★ 云端里已经有这一份内容 ⇒ 一次都不许再发（内容命令是覆写，重发会把更新的内容盖回旧版本）')
    assert.equal(rowOf('req-landed-1'), null, '★ 事实已确认存在 ⇒ 必须收敛出队')
    assert.equal(failedRows().length, 0, '★ 这不是失败，不许留进失败档案')
  }

  // =============================================== ② 事实没到 ⇒ 允许有界重发，到顶转慢速重试
  {
    reset()
    // 同一节课在云端存在，但内容是**别的版本** ⇒ 判不出"已存在"，只能继续送
    cloud.bookings = [{ id: 'bk-open', status: 'booked', items: copy(ITEMS_B), notes: '别的备注' }]
    writeCache()
    cloud.unknownFor.add('updateBookingContent')   // 每次发都拿不到结论
    enqueueStuckContent('req-loop-1', 'bk-open', ITEMS_A, 0)
    await drain(30)
    const row = rowOf('req-loop-1')
    assert.ok(row, '★ 还没确认的业务事实必须**保留**在队列里，绝不为了把数字变短删掉它')
    assert.equal(row.requestId, 'req-loop-1', '★ requestId 一个字都不许改（它是幂等的唯一凭据）')
    assert.equal(row.status, 'unknown')
    assert.ok(Number(row.attempts) <= 10,
      '★★★ 自动重发必须有上限：真机上就是因为没有上限才烧到 47 次，实得 ' + row.attempts)
    assert.equal(executedFor('updateBookingContent').length, Number(row.attempts),
      '★ attempts 每 +1 都必须对应**一次真的出网**：账面与实发要能对上')
    // ⚠️ 2026-09-28 第 5 次修正：冷却**不许再覆写 lastError**（覆写会把
    //    CLOUD_FUNCTION_TIMEOUT / CLOUD_CALL_FAILED / 云端原始 errMsg 全部抹掉，
    //    页面上永远只剩 RETRY_COOLDOWN ⇒ 再也分不清"云端在算"还是"根本没发出去"）。
    //    ⇒ 原失败原因必须原样留着；冷却状态写在**独立字段** `cooldown` 上。
    assert.equal((row.lastError || {}).reason, 'CLOUD_FUNCTION_TIMEOUT',
      '★★★ 原始失败原因必须原样保留，绝不能被 RETRY_COOLDOWN 覆写（覆写 = 毁掉诊断凭据）')
    assert.ok(row.cooldown && Number(row.cooldown.rounds) >= 1,
      '★ 到顶之后必须把冷却状态写进独立字段（人和代码都要知道它为什么不急着发了）')
    assert.ok(Number(row.nextAttemptAt) > Date.now(), '★ 冷却必须排下一次评估时机')
    const before = executedFor('updateBookingContent').length
    await drain(6)
    assert.equal(executedFor('updateBookingContent').length, before,
      '★★★ 转慢速重试之后不许再每一轮都发一次（那才是"无意义重复发送"）')
    assert.equal(failedRows().length, 0, '★ 拿不到结论 ≠ 业务失败，绝不许归档成失败')
  }

  // =============================================== ③ 目标已经消失 ⇒ 归档留档（TARGET_GONE），不许重发
  {
    reset()
    cloud.bookings = [{ id: 'bk-other', status: 'booked', items: [] }]   // 目标 bk-gone 不在里面
    writeCache()
    enqueueStuckContent('req-gone-1', 'bk-gone', ITEMS_A, 4)
    cloud.unknownFor.add('updateBookingContent')
    await drain(4)
    assert.equal(executedFor('updateBookingContent').length, 0,
      '★★★ 目标课程在云端已经不存在 ⇒ 这条事实永远送不到，不许再白发一次')
    const failed = failedRows()
    assert.equal(failed.length, 1, '★ 必须留档（不是静默消失）')
    assert.equal(failed[0].code, 'TARGET_GONE', '★ 归档理由必须写死在数据里')
    assert.equal(failed[0].requestId, 'req-gone-1', '★ 留档里 requestId 必须原样保留，事后可查')
    assert.ok(failed[0].payload && failed[0].payload.bookingId === 'bk-gone', '★ 留档里 payload 也要留着')
  }

  // =============================================== ④ 已被更晚的同字段命令接管 ⇒ 归档留档（SUPERSEDED）
  {
    reset()
    cloud.bookings = [{ id: 'bk-sup', status: 'booked', items: copy(ITEMS_B), notes: '新备注' }]
    writeCache()
    const older = enqueueStuckContent('req-old-1', 'bk-sup', ITEMS_A, 3)
    // 更晚的那一条**已经确认落云**（settled），且它写的字段覆盖老的那条
    const { entry } = outbox.enqueue(SCOPE, {
      command: 'updateBookingContent', payload: { bookingId: 'bk-sup', items: copy(ITEMS_B), notes: '新备注' },
      requestId: 'req-new-1', entityKey: 'booking:bk-sup'
    })
    outbox.patch(SCOPE, entry.entryId, { status: 'settled', settledRevision: cloud.revision, attempts: 0, nextAttemptAt: 0 })
    await drain(3)
    assert.equal(executedFor('updateBookingContent').length, 0,
      '★★★ 已经有更晚的一版内容确认落云 ⇒ 老的那条补发只会把新内容盖回旧版本，绝不许发')
    const failed = failedRows()
    assert.equal(failed.length, 1)
    assert.equal(failed[0].code, 'SUPERSEDED_BY_NEWER_WRITE')
    assert.equal(failed[0].requestId, 'req-old-1')
    assert.equal(rowOf('req-new-1') && rowOf('req-new-1').status || 'settled', 'settled', '★ 更晚那条的分工不受影响')
    void older
  }

  // =============================================== ⑤ 字段不同 ⇒ **不算**接管（不许乱归档）
  {
    reset()
    cloud.bookings = [{ id: 'bk-diff', status: 'booked', items: copy(ITEMS_B), notes: 'x' }]
    writeCache()
    enqueueStuckContent('req-note-1', 'bk-diff', ITEMS_A, 2)
    const { entry } = outbox.enqueue(SCOPE, {
      command: 'updateBookingContent', payload: { bookingId: 'bk-diff', summary: '只改了小结' },
      requestId: 'req-sum-1', entityKey: 'booking:bk-diff'
    })
    outbox.patch(SCOPE, entry.entryId, { status: 'settled', settledRevision: cloud.revision, attempts: 0, nextAttemptAt: 0 })
    await drain(2)
    const sent = executedFor('updateBookingContent').filter(call => call.requestId === 'req-note-1')
    assert.equal(failedRows().length, 0,
      '★★★ 更晚那条改的是**别的字段** ⇒ 老的内容没有被接管，绝不能拿 SUPERSEDED 当借口把它归档掉')
    assert.ok(sent.length >= 1,
      '★ 没被接管的内容必须照常往云端送（送达才是它的出口，悄悄归档等于丢内容）')
  }

  // =============================================== ⑥ 慢速重试的条目不再拖死同实体后续命令
  {
    reset()
    cloud.bookings = [{ id: 'bk-chain', status: 'booked', items: copy(ITEMS_B) }]
    writeCache()
    cloud.unknownFor.add('updateBookingContent')
    enqueueStuckContent('req-chain-1', 'bk-chain', ITEMS_A, 0)
    await drain(30)                     // 让它走到"慢速重试"
    const blocker = rowOf('req-chain-1')
    // 同上：冷却状态看**独立字段**，lastError 保持原始失败原因
    assert.ok(blocker.cooldown && Number(blocker.cooldown.rounds) >= 1, '（前置）老大那条必须已进入冷却（慢速重试）')
    // 同一节课的**完课**排在它后面：以前会被永久冻住，现在必须能先走
    outbox.enqueue(SCOPE, { command: 'completeBooking', payload: { bookingId: 'bk-chain' }, requestId: 'req-chain-2', entityKey: 'booking:bk-chain' })
    await drain(3)
    assert.equal(executedFor('completeBooking').length, 1,
      '★★★ 一条进入慢速重试的命令不许把同一节课的后续命令永久冻住（它自己还在队列里，随时会补）')
    assert.ok(rowOf('req-chain-1'), '★ 但它自己必须还在 —— 松手不是放弃')
  }

  // =============================================== ⑦ 没到上限之前，同实体仍必须严格保序
  {
    reset()
    cloud.bookings = [{ id: 'bk-order', status: 'booked', items: copy(ITEMS_B) }]
    writeCache()
    // 队首 unknown 处于**正常退避**中（attempts 还没到顶）⇒ 它是真 blocker
    enqueueStuckContent('req-order-1', 'bk-order', ITEMS_A, 4)
    outbox.patch(SCOPE, rowOf('req-order-1').entryId, { nextAttemptAt: Date.now() + 600000 })
    outbox.enqueue(SCOPE, { command: 'completeBooking', payload: { bookingId: 'bk-order' }, requestId: 'req-order-2', entityKey: 'booking:bk-order' })
    await sync.flush(); await settle(10)
    assert.equal(executedFor('completeBooking').length, 0,
      '★ 没到底之前顺序仍然是硬要求：内容必须先于完课落云（真人到了这一步才有证据松手）')
  }

  // =============================================== ⑧ dependencyBlockers：页面上能答出"在等谁"
  {
    reset()
    cloud.bookings = [{ id: 'bk-dep', status: 'booked', items: [] }]
    writeCache()
    const a = enqueueStuckContent('req-dep-1', 'bk-dep', ITEMS_A, 1)
    const b = outbox.enqueue(SCOPE, { command: 'completeBooking', payload: { bookingId: 'bk-dep' }, requestId: 'req-dep-2', entityKey: 'booking:bk-dep' }).entry
    const independent = outbox.enqueue(SCOPE, { command: 'createCustomExercise', payload: { name: '孤立动作' }, requestId: 'req-dep-3', entityKey: 'exercise:loc_ex_dep' }).entry
    assert.equal(sync.dependencyBlockers(SCOPE, b).length, 1, '★ 同一节课后面的完课必须答出"在等那条内容命令"')
    assert.equal(sync.dependencyBlockers(SCOPE, b)[0].requestId === undefined, true)
    assert.equal(sync.dependencyBlockers(SCOPE, b)[0].command, 'updateBookingContent')
    assert.equal(sync.dependencyBlockers(SCOPE, independent).length, 0, '★ 无关实体的条目不该背依赖')
    assert.equal(sync.dependencyBlockers(SCOPE, a).length, 0, '★ 队首自己没有依赖')
    const before = copy(openRows())
    sync.dependencyBlockers(SCOPE, b)
    assert.deepEqual(openRows(), before, '★ 依赖查询必须**只读**：一个字节都不许改')
  }

  // =============================================== ⑨ 静态：这些出口必须在源码里真的存在
  {
    const src = fs.readFileSync(path.join(PROJ, 'utils', 'sync-engine.js'), 'utf8')
    assert.ok(src.includes('function decideAfterNoReceipt'), '★ 必须有"回执说没受理 ⇒ 先看业务事实"的收口')
    assert.ok(src.includes('function contentFactVisible'), '★ 内容类命令必须能判业务事实')
    assert.ok(src.includes('UNKNOWN_ATTEMPT_CAP') && src.includes('LONG_RETRY_MS'), '★ 重发必须有上限 + 慢速重试')
    assert.ok(src.includes("if (entry.command === 'updateBookingContent') return contentFactVisible"), '★ factVisibleInSnapshot 必须覆盖内容类')
    assert.ok(src.includes('SUPERSEDED_BY_NEWER_WRITE') && src.includes('TARGET_GONE'), '★ 两个终局出口必须存在')
    // ⚠️ 盯**归档那一句**而不是裸字符串：TARGET_GONE 现在也出现在注释/诊断文案里，
    //   裸 indexOf 会先命中注释 ⇒ 断言变成永远为真的空壳（第五次同型教训：先比粗特征再看字段）。
    const goneJudge = src.indexOf('function bookingTargetGone')
    const goneUse = src.indexOf("archiveWithReason(current, entry, 'TARGET_GONE'")
    assert.ok(goneJudge > 0 && goneUse > goneJudge,
      '★ 目标消失的**判定**必须写在用它下结论之前（先看证据，再宣判）')
    assert.ok(src.indexOf('function neededAsSupersedeEvidence') < src.indexOf('readyOut'),
      '★ "已被更晚版本接管"这条证据必须由 settled 条目撑住：它的证据不能被提前出队抹掉')
    // 页面要把 reason 印出来：同一个 COMMAND_RESULT_UNKNOWN 底下藏着好几种完全不同的故障
    const page = fs.readFileSync(path.join(PROJ, 'pages', 'sandbox-shared-test', 'sandbox-shared-test.js'), 'utf8')
    // ⚠️ 盯**reasonOf 这个打印函数本身**，不盯裸的 `lastError.reason`（页面别处也会出现这个字段，
    //    裸匹配会让"页面上不印 reason"这个变异照样全绿）
    assert.ok(/const reasonOf = row => \(row\.lastError && row\.lastError\.reason\)/.test(page),
      '★★★ 页面必须印出 reason：只看 code 分不清"云函数超时"和"根本没发出去"')
    assert.ok(/dependencyBlockers/.test(page), '★ 页面必须能显示"这几条在等谁"')
  }
}

run().then(() => { console.log('unknown outbox exit: PASS') }, error => { console.error('unknown outbox exit: FAIL'); console.error(error); process.exit(1) })
