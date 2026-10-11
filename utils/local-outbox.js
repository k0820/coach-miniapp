// 持久化 Outbox（阶段 2：Local-first + Cloud Sync）。
//
// 职责：把「本机已经算完、但云端还不知道」的业务事实**持久**排在这里，由 utils/sync-engine.js
// 按顺序送到 coachBusinessCommand。杀掉小程序再打开，队列还在，号还是原来那个号 ——
// 这是「不会重复扣课时 / 不会重复记收入」的地基。
//
// 隔离：按 environment（production / sandbox）分桶，桶内按 datasetId 过滤。绝不跨环境、绝不跨数据集。
// 存储：只写自己的 key（coachLocalOutbox:*），**一个字都不写** coachCloudActiveCache / coachDB。
const { hashCommand } = require('./cloud-command-engine')
const { isLocalId } = require('./local-transaction')

const PREFIX = 'coachLocalOutbox:'
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const bucketKey = environment => PREFIX + (environment === 'sandbox' ? 'sandbox' : 'production')
// `bookingKeyIndex`：预约**业务键 → 本机临时 bookingId** 的持久索引（1.1.9 第 10 轮）。
//   为什么需要它：正式 id 的对应关系存在 `idMap`（本机临时 id → 正式 id），可 `idMap` 的
//   键是**本机临时 id**，而取消链手上只有"业务键"（学员+课时包+日期+时刻）。
//   队列条目还在时可以从 `entry.localIds.booking` 反查；条目一旦出队（命令成功 + cache 已同步）
//   这条线索就没了 —— 而取消恰恰可能在那之后才被推进。
//   ⇒ 入队时顺手记一笔，量极小（一条预约一行），且**只增不删**（重约同一时段直接覆盖）。
const emptyBucket = () => ({ version: 0, seq: 0, entries: [], idMap: {}, bookingKeyIndex: {}, failed: [], batches: {} })
// 「还在空中（云端尚未确认）」的状态。done 的条目直接出队。
//   pending  —— 待发送
//   inflight —— 本轮机正在发（只用于诊断，杀进程后会被复位成 pending）
//   unknown  —— 结果未知（网络断/回执丢）：保留原号，先查回执，绝不换号盲目重发
//   settled  —— 云端**已经确认**，只是本机 cache 还没跟上；本机继续按它投影，
//               直到一次成功的完整回读把 cache 刷新到位（避免"命令已成功、界面却回退"）
const OPEN_STATUS = Object.freeze(['pending', 'inflight', 'unknown', 'settled'])
// 需要真正发出去的（settled 已经确认过了，不再重发）
const SENDABLE_STATUS = Object.freeze(['pending', 'unknown'])

function readBucket(environment) {
  const value = wx.getStorageSync(bucketKey(environment))
  if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) return emptyBucket()
  const bucket = clone(value)
  bucket.entries = bucket.entries.filter(entry => entry && typeof entry.entryId === 'string')
  bucket.idMap = bucket.idMap && typeof bucket.idMap === 'object' ? bucket.idMap : {}
  bucket.failed = Array.isArray(bucket.failed) ? bucket.failed : []
  bucket.batches = bucket.batches && typeof bucket.batches === 'object' && !Array.isArray(bucket.batches) ? bucket.batches : {}
  bucket.bookingKeyIndex = bucket.bookingKeyIndex && typeof bucket.bookingKeyIndex === 'object' ? bucket.bookingKeyIndex : {}
  bucket.seq = Number.isFinite(Number(bucket.seq)) ? Number(bucket.seq) : bucket.entries.length
  bucket.version = Number.isFinite(Number(bucket.version)) ? Number(bucket.version) : 0
  return bucket
}

// 写入并回读校验：队列是「用户已经看到结果了」的那份事实的唯一凭据，写丢了就等于把用户的课丢了。
function writeBucket(environment, bucket) {
  bucket.version = Number(bucket.version || 0) + 1
  wx.setStorageSync(bucketKey(environment), clone(bucket))
  const verified = readBucket(environment)
  if (verified.version !== bucket.version) throw new Error('Outbox 写入回读失败。')
  if (Object.keys(bucket.batches || {}).some(id => !verified.batches[id] || verified.batches[id].fingerprint !== bucket.batches[id].fingerprint)) throw new Error('Outbox 批次回读失败。')
  return verified
}

const scopeEnvironment = scope => (scope && scope.environment === 'sandbox' ? 'sandbox' : 'production')
const inScope = (entry, scope) => !!entry && (!scope.datasetId || entry.datasetId === scope.datasetId)

function list(scope) {
  if (!scope) return []
  return readBucket(scopeEnvironment(scope)).entries.filter(entry => inScope(entry, scope)).sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0)).map(clone)
}
function openEntries(scope) { return list(scope).filter(entry => OPEN_STATUS.includes(entry.status)) }
function sendable(scope) { return list(scope).filter(entry => SENDABLE_STATUS.includes(entry.status)) }
function settled(scope) { return list(scope).filter(entry => entry.status === 'settled') }
function entryById(scope, entryId) { return readBucket(scopeEnvironment(scope)).entries.find(entry => entry.entryId === entryId) || null }
// 按「业务事实号」找**还没定论**的那一条 —— 用于**跑业务之前**去重（同号重放连业务都不跑）。
//
// ⚠️ 只找开启中的条目（pending / unknown / inflight / settled），**刻意不找 failed 归档**。
//   之前的版本连归档一起找，理由是"云端已经明确拒过，重放同号只会得到同样的拒绝"——**这个理由是错的**，
//   而且错得很危险：
//     ① 服务端把 receipt 与业务写放在**同一个事务**里（core.js）。handler 抛错时事务回滚，
//        所以被拒绝的那条**根本没有回执**，同号重发是合法的，条件变了就能成功。
//        拿归档去重 = 把一次失败变成**永久失败**，用户再点多少次都没反应。
//     ② 归档记录是扁平结构，**没有 status / applied 字段**。去重命中它之后，上游读到的
//        `applied` 是 undefined，会被当成 `applied: true` —— 于是一次"其实什么都没做"的重试
//        被上报成**成功**（用户看到「已完成」，云端一节没动）。宁可少去重，绝不能假报成功。
function entryByRequestId(scope, requestId) {
  if (!scope || !requestId) return null
  const open = readBucket(scopeEnvironment(scope)).entries.find(entry => entry.requestId === requestId && inScope(entry, scope))
  return open ? clone(open) : null
}
function version(scope) { return readBucket(scopeEnvironment(scope)).version }

// —— 预约业务键 → 本机临时 bookingId ——
// 只在这里写：入队那一刻（mutate 的 createBooking）。查询侧见 `bookingKeyLocalId`。
function recordBookingKey(scope, bookingKey, localId) {
  if (!scope || !bookingKey || !localId) return false
  const environment = scopeEnvironment(scope)
  const bucket = readBucket(environment)
  if (bucket.bookingKeyIndex[bookingKey] === localId) return true
  bucket.bookingKeyIndex[bookingKey] = localId
  writeBucket(environment, bucket)
  return true
}
function bookingKeyLocalId(scope, bookingKey) {
  if (!scope || !bookingKey) return ''
  const hit = readBucket(scopeEnvironment(scope)).bookingKeyIndex[bookingKey]
  return typeof hit === 'string' ? hit : ''
}
function batchFor(scope, batchId) {
  if (!scope || !scope.datasetId || !batchId) return null
  const row = readBucket(scopeEnvironment(scope)).batches[batchId]
  return row && row.datasetId === scope.datasetId ? clone(row) : null
}
function idMap(scope) { return clone(readBucket(scopeEnvironment(scope)).idMap) }
function resolveId(scope, id) { const map = readBucket(scopeEnvironment(scope)).idMap; return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : id }
function failed(scope) { return readBucket(scopeEnvironment(scope)).failed.map(clone) }
function count(scope) { return openEntries(scope).length }

// 入队。两条幂等保证：
//   ① 同 requestId 已在队列里 → 直接返回那一条（杀进程重开后重放不会变成两条业务）；
//   ② 同 command + 同 payloadHash 已在队列里 → 不重复入队（连点两次下课只会有一条完课意图）。
function enqueue(scope, input) {
  const environment = scopeEnvironment(scope)
  if (!scope || !scope.datasetId) throw new Error('Outbox 入队缺少数据集身份。')
  if (!input || typeof input.command !== 'string' || !input.command) throw new Error('Outbox 入队缺少命令。')
  if (typeof input.requestId !== 'string' || !input.requestId) throw new Error('Outbox 入队缺少稳定的 requestId。')
  const bucket = readBucket(environment)
  const payload = clone(input.payload) || {}
  const hash = hashCommand(input.command, payload)
  const existing = bucket.entries.find(entry => entry.requestId === input.requestId) ||
    bucket.entries.find(entry => entry.command === input.command && entry.payloadHash === hash && entry.datasetId === scope.datasetId)
  if (existing) return { entry: clone(existing), created: false }
  bucket.seq = Number(bucket.seq || 0) + 1
  const entry = {
    entryId: `ob_${bucket.seq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    seq: bucket.seq,
    datasetId: scope.datasetId,
    environment,
    command: input.command,
    payload,
    requestId: input.requestId,
    payloadHash: hash,
    entityKey: input.entityKey || input.command,
    coalesceKey: input.coalesceKey || null,
    ref: input.ref || null,
    // 「本条命令必须等本机某条取消先落云」—— 见 sync-engine 的取消门。
    // 只有 createBooking 会带它：用户取消 A 之后立刻把同一时段约给 B，
    // 若 B 抢在 A 的取消之前送到云端，云端那边 A 还在 ⇒ B 被 BOOKING_TIME_CONFLICT 明确拒绝，
    // 而这条拒绝会被当成"业务失败"归档，用户得再点一次。那不是业务错误，是**排序问题**，
    // 必须在本机解决，不能拿用户的重试来兜。
    afterCancelKey: input.afterCancelKey || '',
    localIds: clone(input.localIds) || {},
    status: input.status || 'pending',
    applied: input.applied !== false,
    attempts: 0,
    createdAt: input.createdAt || Date.now(),
    updatedAt: Date.now(),
    nextAttemptAt: 0,
    lastError: null
  }
  // 同一份本机草稿的**中间版本**没有任何业务含义（updateBookingContent 不是财务事实），
  // 却会在队列里排成一串"已被后来版本覆盖"的旧命令：逐条发送、逐条推进 revision。
  // 真机证据就是这个形状：revision 从 54 一路推到 62，其中大半是同一份草稿的中间态。
  // 更要紧的是：这些旧命令里任意一条撞上「本机尚未取得 revision」这类**可恢复窗口**时，
  // 都会以「疑似同步失败」的名义打扰用户 —— 而云端根本不需要那份旧内容（最终版本才是真相）。
  // 于是入队时**就地取代**同 coalesceKey、同命令、同数据集、且**从未出网**（pending 且 attempts===0）的旧条目。
  // ⚠️ 只取代"还没发出去过"的那些：inflight / unknown / settled 的条目可能已经到过云端，绝不删。
  // ⚠️ 没有 coalesceKey 的命令（尤其 completeBooking 这类会改课时与金额的财务事实）一律不动 ——
  //    它们的幂等靠 requestId，两条内容不同的完课命令在任何情况下都不能互相顶掉。
  if (entry.coalesceKey) {
    const superseded = bucket.entries.filter(item => item && item.coalesceKey === entry.coalesceKey && item.command === entry.command && item.datasetId === scope.datasetId && item.status === 'pending' && Number(item.attempts || 0) === 0)
    if (superseded.length) {
      const replaced = new Set(superseded.map(item => item.entryId))
      bucket.entries = bucket.entries.filter(item => !replaced.has(item.entryId))
    }
  }
  bucket.entries.push(entry)
  writeBucket(environment, bucket)
  return { entry: clone(entry), created: true }
}

// One UI intent can contain createStudent followed by its packages. Validate
// the entire chain first, then persist all commands and their stable IDs with
// one Storage write. A persisted marker prevents a second tap or a restart
// from recreating the student after some entries have already settled.
function enqueueBatch(scope, batchId, inputs, result, intentHash) {
  if (!scope || !scope.datasetId || typeof batchId !== 'string' || !batchId || !Array.isArray(inputs) || !inputs.length) throw new Error('本机批次缺少数据集或操作编号。')
  const environment = scopeEnvironment(scope), bucket = readBucket(environment)
  const fingerprint = hashCommand('localBatch', inputs.map(input => ({ command: input.command, payload: input.payload, requestId: input.requestId })))
  const prior = bucket.batches[batchId]
  if (prior) {
    if (prior.datasetId !== scope.datasetId || prior.fingerprint !== fingerprint || prior.intentHash !== intentHash) throw new Error('本机批次编号与原操作内容不一致。')
    return { created: false, result: clone(prior.result), entries: bucket.entries.filter(entry => prior.requestIds.includes(entry.requestId)).map(clone) }
  }
  const ids = new Set()
  for (const input of inputs) {
    if (!input || typeof input.command !== 'string' || !input.command || typeof input.requestId !== 'string' || !input.requestId || ids.has(input.requestId)) throw new Error('本机批次命令或幂等编号无效。')
    ids.add(input.requestId)
    if (bucket.entries.some(entry => entry.requestId === input.requestId)) throw new Error('本机批次幂等编号已由其他操作占用。')
  }
  const now = Date.now(), entries = inputs.map(input => {
    bucket.seq = Number(bucket.seq || 0) + 1
    return {
      entryId: `ob_${bucket.seq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      seq: bucket.seq, datasetId: scope.datasetId, environment,
      command: input.command, payload: clone(input.payload), requestId: input.requestId,
      payloadHash: hashCommand(input.command, input.payload), entityKey: input.entityKey || input.command,
      coalesceKey: null, ref: null, localIds: clone(input.localIds) || {},
      status: 'pending', applied: true, attempts: 0, createdAt: now, updatedAt: now,
      nextAttemptAt: 0, lastError: null
    }
  })
  bucket.entries.push(...entries)
  bucket.batches[batchId] = { datasetId: scope.datasetId, fingerprint, intentHash, result: clone(result), requestIds: inputs.map(input => input.requestId), createdAt: now }
  writeBucket(environment, bucket)
  return { created: true, result: clone(result), entries: clone(entries) }
}

function patch(scope, entryId, changes) {
  const environment = scopeEnvironment(scope)
  const bucket = readBucket(environment)
  const index = bucket.entries.findIndex(entry => entry.entryId === entryId)
  if (index < 0) return null
  bucket.entries[index] = { ...bucket.entries[index], ...clone(changes), updatedAt: Date.now() }
  writeBucket(environment, bucket)
  return clone(bucket.entries[index])
}
const setStatus = (scope, entryId, status, changes = {}) => patch(scope, entryId, { status, ...changes })

function remove(scope, entryId) {
  const environment = scopeEnvironment(scope)
  const bucket = readBucket(environment)
  const before = bucket.entries.length
  bucket.entries = bucket.entries.filter(entry => entry.entryId !== entryId)
  if (bucket.entries.length === before) return false
  writeBucket(environment, bucket)
  return true
}

// 明确同步失败（云端拒了这条业务）：出队，但**留档**，并原样保留 code/message 供人查看。
function reject(scope, entryId, error) {
  const environment = scopeEnvironment(scope)
  const bucket = readBucket(environment)
  const entry = bucket.entries.find(item => item.entryId === entryId)
  if (!entry) return null
  bucket.entries = bucket.entries.filter(item => item.entryId !== entryId)
  const record = { entryId, command: entry.command, requestId: entry.requestId, datasetId: entry.datasetId, payload: clone(entry.payload), createdAt: entry.createdAt, rejectedAt: Date.now(), code: (error && error.code) || 'SYNC_REJECTED', message: (error && error.message) || '云端拒绝了这条操作。' }
  bucket.failed = [record, ...bucket.failed].slice(0, 50)
  writeBucket(environment, bucket)
  return record
}

// 云端转正：本机临时 id → 正式 id。队列里后续命令的载荷会在发送时按这张表改写。
function recordIdMap(scope, pairs) {
  const environment = scopeEnvironment(scope)
  const clean = {}
  Object.keys(pairs || {}).forEach(key => { if (isLocalId(key) && typeof pairs[key] === 'string' && pairs[key]) clean[key] = pairs[key] })
  if (!Object.keys(clean).length) return idMap(scope)
  const bucket = readBucket(environment)
  bucket.idMap = { ...bucket.idMap, ...clean }
  writeBucket(environment, bucket)
  return clone(bucket.idMap)
}

function clear(scope) {
  const environment = scopeEnvironment(scope)
  const bucket = readBucket(environment)
  bucket.entries = scope && scope.datasetId ? bucket.entries.filter(entry => entry.datasetId !== scope.datasetId) : []
  if (scope && scope.datasetId) Object.keys(bucket.batches).forEach(id => { if (bucket.batches[id].datasetId === scope.datasetId) delete bucket.batches[id] })
  else bucket.batches = {}
  if (!scope || !scope.datasetId) bucket.idMap = {}
  writeBucket(environment, bucket)
  return true
}

module.exports = { PREFIX, bucketKey, OPEN_STATUS, SENDABLE_STATUS, list, openEntries, sendable, settled, entryById, entryByRequestId, version, batchFor, idMap, resolveId, bookingKeyLocalId, recordBookingKey, failed, count, enqueue, enqueueBatch, patch, setStatus, remove, reject, recordIdMap, clear }
