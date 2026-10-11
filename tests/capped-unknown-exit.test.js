// 【2026-09-28 真机事故永久回归（第 5 次修正）】到顶（冷却）条目必须**仍能被安全收口**
//
// 真机账本：未落定 8（unknown 4 + pending 4），最老一条
//   `updateBookingContent / unknown / 已试 47 次 / COMMAND_RESULT_UNKNOWN / RETRY_COOLDOWN`。
//
// 上一版（§108）造了三个安全出口（事实已在 / TARGET_GONE / SUPERSEDED_BY_NEWER_WRITE），
// 却在**查回执之前**就把 `attempts >= 10` 的条目 stall 掉了 ⇒ 47 次历史重发反而成了终身监禁：
//   那条从新版本落地起，一次回执都没查过、三个出口一次都没评估过（本地复现 `tests/_repro108-capped.js` 已证）。
// 配套的两个坑：
//   · 「慢速重试」写了 nextAttemptAt 却**永远走不到**（静止，不是重试）；
//   · 查回执失败（`!ok`）被当成"云端没收到"处理 ⇒ 永不重发 + 进 blocked ⇒ 同实体后续**永久冻结**；
//   · 冷却写入时**覆写了 lastError** ⇒ 原始的 `CLOUD_FUNCTION_TIMEOUT` / `CLOUD_CALL_FAILED` /
//     云端 errMsg 全被抹掉，页面上永远只剩 RETRY_COOLDOWN，诊断被自己毁掉。
//
// 本文件守的七条（每一条都对应真机上的一种"死法"）：
//   ① 历史 attempts=47 的 unknown **必须仍能进入安全出口判断**；
//   ② 到顶后**不许高频重发**（attempts 只限制"发送"，不限制"判断"）；
//   ③ 冷却**到期后必须真的再评估一次**（写了 nextAttemptAt 就必须有代码走到它）；
//   ④ 回执查询失败**不许冻结**同实体后续命令；
//   ⑤ 回执「查询失败」与「云端明确 found=false」**严格不同**；
//   ⑥ 原始 lastError.reason / technicalMessage **不许被冷却覆写**（冷却写独立字段）；
//   ⑦ **不许**因为"云端当前内容不同"就擅自判 SUPERSEDED（内容不同 ≠ 被更晚版本接管）。
// ⚠️ 全程：原 requestId 一字不改、不猜成功、不删条目。
//
// 只替换「云」与 ui-cloud-command 门面，其余全部是真模块。
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const PROJ = path.join(__dirname, '..')
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const settle = async (rounds = 12) => { for (let i = 0; i < rounds; i++) await delay(1) }

const DATASET = 'ds-sandbox-77548e'
const SCOPE = { environment: 'sandbox', datasetId: DATASET }

const store = {}
const ui = { calls: [], modals: [] }
global.wx = {
  getStorageSync: key => copy(store[key]),
  setStorageSync: (key, value) => { store[key] = copy(value) },
  removeStorageSync: key => { delete store[key] },
  showToast() {}, showModal: options => ui.modals.push(options), showLoading() {}, hideLoading() {},
  getNetworkType: options => options.success({ networkType: 'wifi' }),
  onNetworkStatusChange() {},
  setClipboardData: options => { if (options && options.success) options.success({}) },
  cloud: { callFunction: () => Promise.resolve({ result: { ok: false, code: 'NOT_USED' } }) }
}

const cloud = { revision: 100, memoryRevision: 100, receipts: new Map(), applied: [], online: true, bookings: [], unknownFor: new Set(), receiptFails: false }
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
    if (cloud.unknownFor.has(command)) return { ok: false, code: 'COMMAND_RESULT_UNKNOWN', retrySafe: true, reason: 'CLOUD_FUNCTION_TIMEOUT', technicalMessage: 'cloud call timed out' }
    const existing = cloud.receipts.get(requestId)
    if (existing) return copy(existing.response)
    cloud.revision += 1
    cloud.applied.push({ command, payload: copy(payload), requestId })
    // 让云端快照**真的跟着写命令变**（否则"事实已在云端"这条出口永远测不出真实形状）
    if (command === 'updateBookingContent') {
      const list = cloud.bookings
      const row = list.find(item => item && item.id === payload.bookingId)
      if (row && row.id) { row.items = copy(payload.items || []); if (payload.notes != null) row.notes = String(payload.notes) }
    }
    const result = { ok: true, result: {}, datasetRevision: cloud.revision }
    cloud.receipts.set(requestId, { status: 'succeeded', response: copy(result) })
    cloud.memoryRevision = cloud.revision
    writeCache()
    return { ...copy(result), refreshed: { ok: true } }
  }
}

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

const runtime = require(path.join(PROJ, 'utils', 'data-runtime'))
const outbox = require(path.join(PROJ, 'utils', 'local-outbox'))
const projection = require(path.join(PROJ, 'utils', 'local-projection'))
const sync = require(path.join(PROJ, 'utils', 'sync-engine'))

runtime.setEnvironment(runtime.ENVIRONMENTS.SANDBOX)
store.coachDataSourceMode = 'cloud-primary'
store.coachCloudCutoverState = { status: 'cloud-primary' }
store.coachMemberEnvironment = 'sandbox'

const ITEMS_OLD = [{ name: '深蹲', sets: 3, reps: 12 }]
const ITEMS_NEW = [{ name: '硬拉', sets: 4, reps: 8 }]

const reset = () => {
  ui.calls.length = 0; ui.modals.length = 0
  for (const key of Object.keys(store)) delete store[key]
  store.coachDataSourceMode = 'cloud-primary'
  store.coachCloudCutoverState = { status: 'cloud-primary' }
  store.coachMemberEnvironment = 'sandbox'
  cloud.revision = 100; cloud.memoryRevision = 100
  cloud.receipts = new Map(); cloud.applied = []
  cloud.online = true; cloud.unknownFor = new Set()
  cloud.receiptFails = false
  cloud.bookings = []
  writeCache()
  projection.invalidate()
}
const callsFor = requestId => ui.calls.filter(call => call.requestId === requestId)
const sendsFor = requestId => callsFor(requestId).filter(call => call.name === 'execute')
const receiptsFor = requestId => callsFor(requestId).filter(call => call.name === 'getReceipt')
const openRows = () => outbox.openEntries(SCOPE)
const rowOf = requestId => openRows().find(row => row.requestId === requestId) || null
const failedRows = () => outbox.failed(SCOPE)
const failedOf = requestId => failedRows().filter(row => row.requestId === requestId)
// 只清**非冷却**条目的退避（冷却条目要保留 nextAttemptAt 才能测"到期才评估"）
function clearBackoff() {
  openRows().forEach(row => {
    if (Number(row.nextAttemptAt || 0) > 0 && Number(row.attempts || 0) < 10) outbox.patch(SCOPE, row.entryId, { nextAttemptAt: 0 })
  })
}
async function drain(rounds) {
  for (let i = 0; i < rounds; i++) { clearBackoff(); await sync.flush(); await settle(10) }
}
// 历史形状：入场就是 **attempts=47** 的 unknown（真机 #5 的原样）
function enqueueCapped(requestId, bookingId, items, opts = {}) {
  const { entry } = outbox.enqueue(SCOPE, {
    command: 'updateBookingContent', payload: { bookingId, items, notes: opts.notes || '旧备注' },
    requestId, entityKey: `booking:${bookingId}`
  })
  return outbox.patch(SCOPE, entry.entryId, {
    status: 'unknown', attempts: 47, nextAttemptAt: 0,
    lastError: {
      code: 'COMMAND_RESULT_UNKNOWN', reason: 'CLOUD_FUNCTION_TIMEOUT',
      message: '云函数运行超时。', technicalMessage: 'errCode:-504003 cloud function execution timed out'
    }
  })
}

async function run() {
  // ============ ① 历史 attempts=47 ⇒ 必须**仍能进入安全出口判断** + 接管者存在时 SUPERSEDED 结案
  {
    reset()
    cloud.bookings = [{ id: 'bk-x', status: 'booked', items: copy(ITEMS_NEW), notes: '用户后存的新内容' }]
    writeCache()
    enqueueCapped('req-capped-1', 'bk-x', ITEMS_OLD)
    // 更晚、同实体、同命令、**已落云**的接管者（证据就摆在队列里 —— 最理想的取证条件）
    const later = outbox.enqueue(SCOPE, {
      command: 'updateBookingContent', payload: { bookingId: 'bk-x', items: copy(ITEMS_NEW), notes: '用户后存的新内容' },
      requestId: 'req-later-1', entityKey: 'booking:bk-x'
    })
    outbox.patch(SCOPE, later.entry.entryId, { status: 'settled', settledRevision: cloud.revision, attempts: 0, nextAttemptAt: 0 })

    await drain(6)
    assert.ok(receiptsFor('req-capped-1').length >= 1,
      '★★★ ① 到顶条目必须**仍然被查回执、仍然评估安全出口**（旧版在这里短路 ⇒ 终身监禁）')
    const failed = failedOf('req-capped-1')
    assert.equal(failed.length, 1, '★ 接管者已落云 ⇒ 必须留档结案，不许继续悬着')
    assert.equal(failed[0].code, 'SUPERSEDED_BY_NEWER_WRITE', '★ 结案理由必须写清（不是静默消失）')
    assert.equal(failed[0].requestId, 'req-capped-1', '★ 留档里 requestId 原样保留')
    assert.equal(sendsFor('req-capped-1').length, 0,
      '★★★ ① 到顶后**一次都不许再发**（重发会把用户后存的新内容覆盖回旧版本）')
  }

  // ============ ② + ⑥ 到顶后不许高频重发；原始错误不许被冷却覆写
  {
    reset()
    cloud.bookings = [{ id: 'bk-y', status: 'booked', items: copy(ITEMS_NEW), notes: '别的版本' }]
    writeCache()
    enqueueCapped('req-capped-2', 'bk-y', ITEMS_OLD)
    await drain(12)
    const row = rowOf('req-capped-2')
    assert.ok(row, '★ 没有出口的条目必须**保留**在队列里，绝不为了把数字变短删掉它')
    assert.ok(receiptsFor('req-capped-2').length >= 1, '★ 至少评估过一次')
    assert.equal(sendsFor('req-capped-2').length, 0,
      '★★★ ② 到顶后不许高频重发（attempts 只封"发送"，不封"判断"，实发 ' + sendsFor('req-capped-2').length + ' 次）')
    // ⑥ 原始错误必须原样留着
    assert.equal((row.lastError || {}).reason, 'CLOUD_FUNCTION_TIMEOUT',
      '★★★ ⑥ 原始 reason 不许被冷却覆写（覆写了就永远分不清超时还是调用失败）')
    assert.equal((row.lastError || {}).technicalMessage, 'errCode:-504003 cloud function execution timed out',
      '★★★ ⑥ 云端原始 errMsg 必须保留（这是排查的唯一凭据）')
    // 冷却写在**独立字段**上，且真的排了下一次评估时机
    assert.ok(row.cooldown && Number(row.cooldown.rounds) >= 1, '★ 冷却必须写在独立字段上')
    assert.ok(Number(row.nextAttemptAt) > Date.now(), '★ 冷却必须排下一次评估时机')
    assert.ok(Number(row.nextAttemptAt) - Date.now() > 20 * 60 * 1000, '★ 冷却间隔必须是 30 分钟量级，不是每轮都发')
  }

  // ============ ③ 冷却到期后必须**真的再评估一次**（写了 nextAttemptAt 就必须有代码走到）
  {
    reset()
    cloud.bookings = [{ id: 'bk-z', status: 'booked', items: copy(ITEMS_NEW) }]
    writeCache()
    enqueueCapped('req-capped-3', 'bk-z', ITEMS_OLD)
    await drain(3)
    const before = receiptsFor('req-capped-3').length
    const row = rowOf('req-capped-3')
    assert.ok(before >= 1 && Number(row.nextAttemptAt) > Date.now(), '★ 先进入冷却')
    // 模拟"墙上时钟过了 30 分钟"：把评估时机拨到过去
    outbox.patch(SCOPE, row.entryId, { nextAttemptAt: Date.now() - 1 })
    await drain(2)
    assert.ok(receiptsFor('req-capped-3').length > before,
      '★★★ ③ 冷却到期后必须真的再评估一次（旧版写了 nextAttemptAt 却永远走不到 ⇒ 假机制）')
    const after = rowOf('req-capped-3')
    assert.ok(Number(after.cooldown.rounds) > Number(row.cooldown.rounds), '★ 每次评估完要重新排下一次（滚动冷却）')
    assert.ok(Number(after.nextAttemptAt) > Date.now(), '★ 重新排期后仍是未来的时间点')
    assert.equal(sendsFor('req-capped-3').length, 0, '★ 到期评估 ≠ 到顶后又开始重发')
  }

  // ============ ④ 回执查询失败：该条不许重发，也**不许冻结**同实体后续
  {
    reset()
    cloud.bookings = [{ id: 'bk-w', status: 'booked', items: copy(ITEMS_NEW) }]
    writeCache()
    cloud.receiptFails = true
    const e = outbox.enqueue(SCOPE, {
      command: 'updateBookingContent', payload: { bookingId: 'bk-w', items: copy(ITEMS_OLD) },
      requestId: 'req-probe-1', entityKey: 'booking:bk-w'
    })
    outbox.patch(SCOPE, e.entry.entryId, {
      status: 'unknown', attempts: 2, nextAttemptAt: 0,
      lastError: { code: 'COMMAND_RESULT_UNKNOWN', reason: 'CLOUD_CALL_FAILED', message: '云端调用中断。' }
    })
    const succ = outbox.enqueue(SCOPE, {
      command: 'updateBookingContent', payload: { bookingId: 'bk-w', items: copy(ITEMS_NEW), notes: '后来的保存' },
      requestId: 'req-probe-2', entityKey: 'booking:bk-w'
    })
    await drain(6)
    assert.equal(sendsFor('req-probe-1').length, 0,
      '★★★ ④ 查回执失败 = 我这边没问出来 ⇒ **绝不能当成"云端没收到"去重发**（铁律）')
    assert.ok(sendsFor('req-probe-2').length >= 1,
      '★★★ ④ 查回执失败**不许冻结**同实体后续命令（旧版进 blocked ⇒ 后续一条都发不出去）')
    const row = rowOf('req-probe-1')
    assert.ok(row, '★ 拿不到结论 ≠ 失败，必须保留')
    assert.equal(Number(row.attempts), 2, '★ 查询失败不许消耗重发预算（attempts 不许涨）')
    assert.ok(Number(row.probeFails || 0) >= 1, '★ 查询失败次数必须记账（可观测出口）')
    assert.equal(failedOf('req-probe-1').length, 0, '★ 查询失败不许归档成业务失败')
    void succ
  }

  // ============ ⑤ 「查询失败」与「云端明确 found=false」严格不同
  {
    reset()   // 5a：查询失败 + 目标其实已经消失 ⇒ 不许宣判 TARGET_GONE
    cloud.bookings = [{ id: 'bk-other', status: 'booked', items: [] }]
    writeCache()
    cloud.receiptFails = true
    enqueueCapped('req-gone-a', 'bk-missing', ITEMS_OLD)
    await drain(4)
    assert.equal(failedOf('req-gone-a').length, 0,
      '★★★ ⑤ 没问出来 ⇒ 对云端零信息 ⇒ **绝不能**拿"快照里看不见"去宣判目标消失（不可逆结论）')
    assert.equal(sendsFor('req-gone-a').length, 0, '★ 也绝不能因此重发')

    reset()   // 5b：云端明确说没这个号 + 目标已消失 ⇒ 这时才允许 TARGET_GONE
    cloud.bookings = [{ id: 'bk-other', status: 'booked', items: [] }]
    writeCache()
    enqueueCapped('req-gone-b', 'bk-missing', ITEMS_OLD)
    await drain(4)
    const failed = failedOf('req-gone-b')
    assert.equal(failed.length, 1, '★★★ ⑤ 云端**明确**答复没受理过 + 目标已不在 ⇒ 才允许留档结案')
    assert.equal(failed[0].code, 'TARGET_GONE')
    assert.equal(sendsFor('req-gone-b').length, 0, '★ 结案前不许白发一次')
  }

  // ============ ⑦ 云端内容不同 ⇒ 不许擅自判 SUPERSEDED
  {
    reset()
    cloud.bookings = [{ id: 'bk-v', status: 'booked', items: copy(ITEMS_NEW), notes: '别的版本' }]
    writeCache()
    enqueueCapped('req-diff-1', 'bk-v', ITEMS_OLD)
    await drain(6)
    assert.equal(failedOf('req-diff-1').filter(row => row.code === 'SUPERSEDED_BY_NEWER_WRITE').length, 0,
      '★★★ ⑦ 「云端当前内容与本条不同」≠ 被更晚版本接管 —— 不许为了清零扩大接管判断')
    assert.equal(failedOf('req-diff-1').length, 0, '★ 没有任何出口 ⇒ 一条都不许归档')
    assert.ok(rowOf('req-diff-1'), '★ 保留在队列里等真正的证据')
    // 只读诊断必须能把"三个出口各自为什么不成立"说清楚（真机下一步要靠它取证）
    const diag = sync.diagnoseEntry(SCOPE, 'req-diff-1')
    assert.ok(diag, '★ 只读诊断必须可用')
    assert.equal(diag.requestId, 'req-diff-1')
    assert.equal(diag.attempts, 47, '★ 诊断必须原样反映历史条目的真实次数')
    assert.ok(diag.exits && typeof diag.exits.factVisible === 'string' && typeof diag.exits.superseded === 'string',
      '★ 三个出口各自的"为什么不成立"必须能读出来')
    assert.equal(outbox.openEntries(SCOPE).length, 1, '★ 诊断是**只读**的：不许改动队列')
  }

  // ============ ⑦b 更晚那条改的是**别的字段** ⇒ 不算接管（不许借 SUPERSEDED 把内容扔掉）
  {
    reset()
    cloud.bookings = [{ id: 'bk-u', status: 'booked', items: copy(ITEMS_NEW), notes: '后来改的备注' }]
    writeCache()
    enqueueCapped('req-diff-2', 'bk-u', ITEMS_OLD)   // 这条要写 items + notes
    const later = outbox.enqueue(SCOPE, {
      command: 'updateBookingContent', payload: { bookingId: 'bk-u', notes: '后来改的备注' },   // 只改 notes
      requestId: 'req-diff-2-later', entityKey: 'booking:bk-u'
    })
    outbox.patch(SCOPE, later.entry.entryId, { status: 'settled', settledRevision: cloud.revision, attempts: 0, nextAttemptAt: 0 })
    await drain(6)
    assert.equal(failedOf('req-diff-2').filter(row => row.code === 'SUPERSEDED_BY_NEWER_WRITE').length, 0,
      '★★★ ⑦b 更晚那条**没覆盖本条要写的字段** ⇒ 本条内容仍然没送达，绝不能拿"有更晚的一版"当借口归档')
    assert.ok(rowOf('req-diff-2'), '★ 这种情况下这条内容必须保住')
    assert.equal(sync.diagnoseEntry(SCOPE, 'req-diff-2').exits.superseded.indexOf('命中') < 0, true,
      '★ 只读诊断必须把"为什么不算接管"说清楚')
  }

  // ============ ⑦c 越过上限的**那一刻**必须当场装配冷却（否则停在 30 秒退避里永远够不到冷却判定）
  {
    reset()
    cloud.bookings = [{ id: 'bk-c', status: 'booked', items: copy(ITEMS_NEW) }]
    writeCache()
    cloud.unknownFor.add('updateBookingContent')     // 每次发都拿不到结论
    const e = outbox.enqueue(SCOPE, {
      command: 'updateBookingContent', payload: { bookingId: 'bk-c', items: copy(ITEMS_OLD) },
      requestId: 'req-cross-1', entityKey: 'booking:bk-c'
    })
    outbox.patch(SCOPE, e.entry.entryId, {
      status: 'unknown', attempts: 9, nextAttemptAt: 0,
      lastError: { code: 'COMMAND_RESULT_UNKNOWN', reason: 'CLOUD_FUNCTION_TIMEOUT', message: 'x' }
    })
    await drain(8)
    const row = rowOf('req-cross-1')
    assert.ok(row, '★ 没有出口 ⇒ 必须保留')
    assert.equal(Number(row.attempts), 10, '★ 越过上限的这一发就是上限（实得 ' + row.attempts + '）')
    assert.ok(row.cooldown && Number(row.cooldown.rounds) >= 1,
      '★★★ ⑦c 越过上限的那一刻必须**当场**装配冷却：否则它停在 30 秒普通退避里，永远够不到"到期才评估"')
    assert.equal(sendsFor('req-cross-1').length, 1, '★ 装配之后不许再发（冷却期间零重发）')
  }

  // ============ ⑧ 静态：冷却不许短路在查回执之前；旧的错误写法不许回来
  {
    const src = fs.readFileSync(path.join(PROJ, 'utils', 'sync-engine.js'), 'utf8')
    const capGuard = src.indexOf('const cooling = entry.status === \'unknown\' && attempts >= UNKNOWN_ATTEMPT_CAP')
    const receiptCall = src.indexOf('const verdict = await resolveUnknownByReceipt')
    assert.ok(capGuard > 0 && receiptCall > capGuard,
      '★★★ ⑧ 冷却判定必须写在**查回执之后/之前都查得到**的位置：判据是冷却到期后必须仍走到收口')
    assert.ok(src.includes("return 'probe-failed'"), '★ 回执查询失败必须有独立结论')
    assert.ok(!src.includes('attemptsAtCap'), '★ 旧的"到顶即覆写 lastError"函数不许回来')
    assert.ok(src.includes('cooldown: {'), '★ 冷却状态必须写在独立字段上')
    const page = fs.readFileSync(path.join(PROJ, 'pages', 'sandbox-shared-test', 'sandbox-shared-test.js'), 'utf8')
    assert.ok(page.includes('diagnoseQueue'), '★ Sandbox 验收页必须接上只读队列详情')
  }

  console.log('capped unknown exit: PASS')
}

run().then(() => process.exit(0)).catch(error => { console.error('capped unknown exit: FAIL', error && error.message); process.exit(1) })
