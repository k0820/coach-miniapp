const crypto = require('crypto')

// ⚠️ M2 第二批新增 `packageShares`：共享课时包的**许可**记录。
//    它**不是**第八个业务集合 —— 不进 `BUSINESS`（业务 handler 仍然只能通过 scopedBusiness 访问那八个），
//    也不进 `readMyActiveCoachData` 的八个集合 ⇒ **读链路 / 指纹 / 增量一个字都没动**。
//    只有 `sharing.shareScope()` 这一个窄门能碰它。
const META = Object.freeze({
  coaches: 'coaches', heads: 'coach_data_heads', datasets: 'coach_datasets',
  revisions: 'coach_data_revisions', receipts: 'coach_command_receipts',
  packageShares: 'coach_package_shares',
  // M2 V1 双层授权（**关系**，不是业务事实）：不进 BUSINESS，不参与 checksum / 指纹 / 增量。
  memberAuthorizations: 'coach_member_authorizations', packageGrants: 'coach_package_grants'
})
const SANDBOX_META = Object.freeze({
  coaches: 'coaches', heads: 'coach_sandbox_heads', datasets: 'coach_datasets',
  revisions: 'coach_sandbox_revisions', receipts: 'coach_sandbox_receipts',
  packageShares: 'coach_sandbox_package_shares',
  memberAuthorizations: 'coach_sandbox_member_authorizations', packageGrants: 'coach_sandbox_package_grants'
})
const BUSINESS = Object.freeze(['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises'])
// ⭐ M2 V1：新增 `memberId`。可信会员身份只能由**认领关系**在服务端推导，客户端提交一律视作伪造
//   （与会员端身份云函数的口径一致：那边同样禁止客户端提交 memberId）。
const FORBIDDEN = new Set(['OPENID', 'openId', 'openid', '_openid', 'coachId', 'ownerCoachId', 'documentId', 'datasetId', 'memberId'])

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const coachIdFor = openId => sha(`coach:${openId}`).slice(0, 32)
const fixedId = (kind, owner, suffix = '') => sha(`${kind}:${owner}:${suffix}`).slice(0, 32)
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const payloadHash = envelope => sha(canonical({ command: envelope.command, payload: envelope.payload }))
const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })
const commandError = (code, message, extra = {}) => Object.assign(new Error(message), { commandCode: code, extra })

function forbiddenPath(value, path) {
  if (!value || typeof value !== 'object') return null
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key)) return `${path}.${key}`
    const found = forbiddenPath(value[key], `${path}.${key}`)
    if (found) return found
  }
  return null
}

function forbiddenBusinessInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  for (const key of Object.keys(event)) {
    if (key === 'userInfo') continue
    if (FORBIDDEN.has(key)) return `event.${key}`
    const found = forbiddenPath(event[key], `event.${key}`)
    if (found) return found
  }
  return null
}

function validateRequestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(value)) throw commandError('INVALID_REQUEST_ID', 'requestId 无效。')
  return value
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw commandError('INVALID_COMMAND', '命令格式无效。')
  const forbidden = forbiddenPath(envelope, 'envelope')
  if (forbidden) throw commandError('FORBIDDEN_IDENTITY_INPUT', `客户端不得提交身份或数据集定位字段：${forbidden}`)
  if (typeof envelope.command !== 'string' || !envelope.command) throw commandError('UNKNOWN_COMMAND', '命令名称无效。')
  validateRequestId(envelope.requestId)
  if (!Number.isInteger(envelope.expectedRevision) || envelope.expectedRevision < 0) throw commandError('INVALID_REVISION', 'expectedRevision 必须是非负整数。')
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) throw commandError('INVALID_PAYLOAD', 'payload 必须是对象。')
}

async function one(scope, collection, query) {
  const response = await scope.collection(collection).where(query).limit(1).get(), rows = response && response.data || []
  return rows[0] || null
}

async function put(scope, collection, id, data) {
  const { _id, ...body } = data
  return scope.collection(collection).doc(id).set({ data: body })
}

async function currentCoach(db, openId, ownerCoachId) {
  return one(db, META.coaches, { _id: ownerCoachId, openId, status: 'active' })
}

const environmentOf = value => value === 'sandbox' ? 'sandbox' : 'production'
const metaFor = environment => environmentOf(environment) === 'sandbox' ? SANDBOX_META : META
const headKindFor = environment => environmentOf(environment) === 'sandbox' ? 'coach-sandbox-head' : 'coach-data-head'
const revisionKindFor = environment => environmentOf(environment) === 'sandbox' ? 'coach-sandbox-revision' : 'coach-data-revision'
const receiptKindFor = environment => environmentOf(environment) === 'sandbox' ? 'coach-sandbox-receipt' : 'coach-command-receipt'

async function activeContext(scope, ownerCoachId, environment = 'production') {
  const resolvedEnvironment = environmentOf(environment), meta = metaFor(resolvedEnvironment), headId = fixedId(headKindFor(resolvedEnvironment), ownerCoachId)
  const head = await one(scope, meta.heads, resolvedEnvironment === 'sandbox' ? { _id: headId, ownerCoachId, environment: 'sandbox' } : { _id: headId, ownerCoachId })
  if (!head || !head.activeDatasetId) throw commandError('DATASET_HEAD_NOT_FOUND', '当前账号尚未建立可写云端数据基线。')
  const datasetId = head.activeDatasetId, datasetDocId = fixedId('coach-dataset', ownerCoachId, datasetId)
  const dataset = await one(scope, meta.datasets, { _id: datasetDocId, ownerCoachId, datasetId })
  if (!dataset || dataset.status !== 'active' || dataset.integrityStatus !== 'verified') throw commandError('ACTIVE_DATASET_INVALID', '当前云端数据代次未通过完整性验证。')
  const revisionId = fixedId(revisionKindFor(environment), ownerCoachId, datasetId)
  const revision = await one(scope, meta.revisions, { _id: revisionId, ownerCoachId, datasetId })
  if (!revision || !Number.isInteger(revision.dataRevision) || revision.dataRevision < 0) throw commandError('DATA_REVISION_INVALID', '当前云端数据 revision 异常。')
  return { ownerCoachId, datasetId, environment: resolvedEnvironment, meta, headId, head, dataset, revisionId, revision }
}

function scopedBusiness(tx, ownerCoachId, datasetId) {
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
  const collection = name => {
    if (!BUSINESS.includes(name)) throw commandError('COLLECTION_NOT_ALLOWED', '命令尝试访问未授权业务集合。')
    return {
      async get(businessId) {
        return one(tx, name, { _id: fixedId(`coach-business-${name}`, ownerCoachId, `${datasetId}:${businessId}`), ownerCoachId, datasetId })
      },
      async set(businessId, data) {
        if (!data || typeof data !== 'object' || Array.isArray(data) || has(data, '_id') || has(data, 'ownerCoachId') || has(data, 'datasetId')) throw commandError('RESERVED_FIELD_INPUT', '业务 handler 不得覆盖归属或数据集字段。')
        const id = fixedId(`coach-business-${name}`, ownerCoachId, `${datasetId}:${businessId}`)
        return put(tx, name, id, { ...clone(data), ownerCoachId, datasetId })
      },
      async remove(businessId) {
        const id = fixedId(`coach-business-${name}`, ownerCoachId, `${datasetId}:${businessId}`), old = await one(tx, name, { _id: id, ownerCoachId, datasetId })
        if (!old) return { removed: 0 }
        await tx.collection(name).doc(id).remove()
        return { removed: 1 }
      },
      where(query = {}) {
        if (has(query, 'ownerCoachId') || has(query, 'datasetId') || has(query, '_id')) throw commandError('RESERVED_FIELD_INPUT', '业务 handler 不得覆盖查询归属。')
        return tx.collection(name).where({ ownerCoachId, datasetId, ...clone(query) })
      },
      async list(query = {}) {
        if (has(query, 'ownerCoachId') || has(query, 'datasetId') || has(query, '_id')) throw commandError('RESERVED_FIELD_INPUT', '业务 handler 不得覆盖查询归属。')
        const result = []
        for (let offset = 0; ; offset += 100) {
          const response = await tx.collection(name).where({ ownerCoachId, datasetId, ...clone(query) }).skip(offset).limit(100).get()
          const page = response && Array.isArray(response.data) ? response.data : []
          result.push(...page)
          if (page.length < 100) return result
        }
      }
    }
  }
  return Object.freeze({ ownerCoachId, datasetId, collection })
}

// ★★ 跨教练共享预约：课时包那一侧的「对端收据」命令名（M2 第二批）★★
// 为什么必须单独一个名字：一条共享预约会同时改**两本账**（授课教练 B 的 bookings、
// 销售教练 A 的 packages）。A 那一侧必须也有一张 succeeded 收据 ——
// 否则 A 设备的增量同步会在 `revisionAfter` 序列里看到一个空洞 ⇒ `CHANGES_GAP` ⇒ 每次都退回全量读。
// 用独立的名字，A 侧的增量就能精确地只补 `packages` 那一行（见 readMyActiveCoachData/changes.js 的 NARROW）。
const PEER_RECEIPT_COMMAND = 'sharedPackageSync'

function dedupePeers(peers) {
  const seen = new Set(), result = []
  for (const peer of peers || []) {
    const owner = String(peer && peer.ownerCoachId || ''), dataset = String(peer && peer.datasetId || '')
    if (!owner || !dataset) continue
    const key = `${owner}:${dataset}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ ownerCoachId: owner, datasetId: dataset, result: clone(peer.result || {}) })
  }
  return result
}

// 把对端（课时包所属教练）的 revision 推进一格，并补上它那张收据。
// ⚠️ 顺序：handler 已经在同一事务里写完了对端的业务行，这里只负责记账（revision + receipt）。
// ⚠️ 对端**没有** expectedRevision：调用方 B 不可能知道 A 现在第几版。
//    并发安全由**事务本身**保证 —— 同一条 revision 文档被两个事务同时改写时，后提交者整体失败回滚。
async function commitPeers(tx, peers, { environment, requestId, payloadHash, now }) {
  for (const peer of peers) {
    if (peer.ownerCoachId === peers.selfOwnerCoachId) continue
    const context = await activeContext(tx, peer.ownerCoachId, environment)
    // 共享码里记的是"建码那一刻 A 用哪本账"。A 换了数据代次就必须重新建码 ——
    // 绝不拿一个过期的位置去写一本已经退休的账。
    if (context.datasetId !== peer.datasetId) throw commandError('SHARE_DATASET_MOVED', '共享课时包所属数据空间已切换，请让课时包所属教练重新生成共享码。')
    const nextRevision = context.revision.dataRevision + 1
    await put(tx, context.meta.revisions, context.revisionId, { ...context.revision, ownerCoachId: peer.ownerCoachId, datasetId: context.datasetId, environment: context.environment, dataRevision: nextRevision, updatedAt: now })
    const peerResponse = { ok: true, command: PEER_RECEIPT_COMMAND, requestId, datasetRevision: nextRevision, result: peer.result }
    await put(tx, context.meta.receipts, fixedId(receiptKindFor(environment), peer.ownerCoachId, `${context.datasetId}:${requestId}`), {
      ownerCoachId: peer.ownerCoachId, datasetId: context.datasetId, environment: context.environment, requestId,
      command: PEER_RECEIPT_COMMAND, payloadHash, status: 'succeeded',
      revisionBefore: context.revision.dataRevision, revisionAfter: nextRevision, response: peerResponse, completedAt: now
    })
  }
}

// ⭐ `delivery`（可选）＝ M4 的投递适配器：`{ enabled, send, openIdFor }`。
//   ⛔ 不传 ⇒ 只落事件、不投递（与 M3-P6 的既有行为逐字一致）。
async function execute(db, ownerCoachId, envelope, handlers, now, environment = 'production', delivery = null) {
  validateEnvelope(envelope)
  const handler = handlers[envelope.command]
  if (typeof handler !== 'function') return fail('COMMAND_NOT_IMPLEMENTED', '该正式业务命令尚未在 Phase 6.5C2 启用。')
  const sharing = require('./sharing')
  // ⭐ M3-P0（2026-09-30 真机事故）：通知窄门必须在**事务外**持有引用 ——
  //   事务内只入队（纯内存），真正的落库推迟到 `runTransaction` 成功返回之后。
  const notify = require('./notify')
  try {
    let notifyScope = null
    const committed = await db.runTransaction(async tx => {
      const context = await activeContext(tx, ownerCoachId, environment)
      const receiptId = fixedId(receiptKindFor(environment), ownerCoachId, `${context.datasetId}:${envelope.requestId}`), fingerprint = payloadHash(envelope)
      const receipt = await one(tx, context.meta.receipts, { _id: receiptId, ownerCoachId, datasetId: context.datasetId, requestId: envelope.requestId })
      if (receipt) {
        if (receipt.command !== envelope.command || receipt.payloadHash !== fingerprint) throw commandError('REQUEST_ID_CONFLICT', '同一 requestId 对应了不同命令或参数。')
        if (receipt.status === 'succeeded') return { ...clone(receipt.response), idempotent: true }
        throw commandError('REQUEST_PROCESSING', '请求正在处理中，可安全重试。', { retrySafe: true })
      }
      if (context.revision.dataRevision !== envelope.expectedRevision) throw commandError('REVISION_CONFLICT', '云端数据已被其他请求更新。', { currentRevision: context.revision.dataRevision })
      await put(tx, context.meta.receipts, receiptId, { ownerCoachId, datasetId: context.datasetId, environment: context.environment, requestId: envelope.requestId, command: envelope.command, payloadHash: fingerprint, status: 'processing', revisionBefore: context.revision.dataRevision, createdAt: now })
      // M2 第二批：handler 多拿到三样东西（都是**服务端派生**，客户端提交不了）：
      //   ① businessAt  —— 另一位教练那本账的**同一个事务**内的读写门面（跨存储位置事务）
      //   ② shares      —— 共享许可的窄门（只认共享码）
      //   ③ attachPeer  —— 声明"这一笔同时动了谁那本账"，由 execute 统一补 revision + receipt
      const peers = []
      const commandResult = await handler(scopedBusiness(tx, ownerCoachId, context.datasetId), clone(envelope.payload), {
        now, requestId: envelope.requestId,
        businessAt: (peerOwnerCoachId, peerDatasetId) => scopedBusiness(tx, peerOwnerCoachId, peerDatasetId),
        shares: sharing.shareScope(tx, environment, ownerCoachId, context.datasetId),
        // M2 V1：双层授权窄门（**事务内**，与业务行同生同死）。handler 只能用它读写授权表。
        authorizations: require('./authorization').authScope(tx, environment),
        // M3-P6：通知事件窄门。⛔【M3-P0 订正】它现在**只入队**（`record()` 里一个 await 都没有）
        //   ⇒ 集合缺失 / 权限 / 网络任何故障都**不可能**把业务事务拖回滚 ——
        //     真机事故正是这里回滚的（`-502005 Db or Table not exist: member_sandbox_notification_events`）。
        //   ⛔ 它只写 `member[_sandbox]_notification_events`（元集合，不进 BUSINESS、不进 checksum）；
        //      本轮**不发微信订阅消息**（`notify.ACTIVE_CHANNEL === null`），只把"需要通知谁"记成事实。
        //   真正落库在下面的 `notifyScope.flush(db)` —— **事务提交成功之后**。
        // ⭐ 第 5 个参数是**备读句柄**（裸 `db`）：事务内那条读万一在真机上不可用，
        //    收件人解析还能退到普通读，⛔ 绝不让"读不到"变成"整条通知链静默断掉"
        //    （1.3.39：站内消息与微信双双落空，根因就在这条链的输入为空）。
        notify: (notifyScope = notify.scope(tx, environment, ownerCoachId, context.datasetId)),
        attachPeer: peer => { if (peer && peer.ownerCoachId && peer.datasetId) peers.push(peer) }
      })
      const nextRevision = context.revision.dataRevision + 1
      await put(tx, context.meta.revisions, context.revisionId, { ...context.revision, ownerCoachId, datasetId: context.datasetId, environment: context.environment, dataRevision: nextRevision, updatedAt: now })
      const response = { ok: true, command: envelope.command, requestId: envelope.requestId, datasetRevision: nextRevision, result: commandResult }
      const uniquePeers = dedupePeers(peers)
      if (uniquePeers.length) {
        uniquePeers.selfOwnerCoachId = ownerCoachId
        await commitPeers(tx, uniquePeers, { environment, requestId: envelope.requestId, payloadHash: fingerprint, now })
      }
      await put(tx, context.meta.receipts, receiptId, { ownerCoachId, datasetId: context.datasetId, environment: context.environment, requestId: envelope.requestId, command: envelope.command, payloadHash: fingerprint, status: 'succeeded', revisionBefore: context.revision.dataRevision, revisionAfter: nextRevision, response, completedAt: now })
      return response
    })
    // ⭐⭐ M3-P0：通知事件**只在业务事务确认提交之后**才落库。
    //   · 业务回滚（校验失败 / 冲突 / 任何异常）⇒ 根本走不到这里 ⇒ 依然"绝不留下假通知"，原子性语义未变；
    //   · 通知落库失败 ⇒ **绝不回滚业务**（业务已经合法成功），但必须**可追踪**：
    //     进响应的 `notify` 字段 + `console.error` 云函数日志；
    //   · 全程 try 到底 —— 连兜底都不许把一件已经成功的业务变成失败。
    if (notifyScope && notifyScope.hasPending()) {
      try {
        const outcome = await notifyScope.flush(db)
        committed.notify = {
          ok: outcome.failures.length === 0,
          collection: notifyScope.collection,
          attempted: outcome.attempted, written: outcome.written, skipped: outcome.skipped,
          failures: outcome.failures
        }
      } catch (error) {
        console.error('[notify] flush 兜底异常（业务已成功，不回滚）', String(error && error.message || error))
        committed.notify = {
          ok: false, collection: notifyScope.collection,
          attempted: 0, written: 0, skipped: 0,
          failures: [{ stage: 'flush', code: 'NOTIFY_FLUSH_CRASHED', message: String(error && error.message || error), collection: notifyScope.collection, environment }]
        }
      }
      // ───────────────────────────────────────────────────────────────────────
      // 📮 M4（2026-10-05）：事件落库之后**顺手投递一次**（省一个定时触发器）。
      //   ⛔ 与 flush 同一条铁律：这里任何失败都**绝不回滚业务**，也绝不静默 ——
      //      结果原样进响应的 `notify.delivery`，云函数日志另有一行。
      //   ⛔ 模板没配置 ⇒ 会如实回 `TEMPLATE_NOT_CONFIGURED`（不是"发送成功"）。
      //   ⛔ 只有 index.js 显式注入 `delivery` 才会投递 ⇒ 未开通时这里根本不执行。
      // ⛔ `events()` 在这里取一次：微信投递与站内消息**必须**是同一批事件（否则会对不上号）。
      const pendingEvents = notifyScope.events()
      if (delivery && delivery.enabled && notifyScope && notifyScope.hasPending()) {
        try {
          const subscribe = require('./subscribe-delivery')
          committed.notify.delivery = await subscribe.deliverEvents({
            db, environment, events: pendingEvents,
            send: delivery.send, openIdFor: delivery.openIdFor, now: Date.now()
          })
        } catch (error) {
          console.error('[subscribe] 投递兜底异常（业务已成功，不回滚）', String(error && error.message || error))
          committed.notify.delivery = { ok: false, code: 'NOTIFY_DELIVERY_CRASHED', message: String(error && error.message || error) }
        }
      }
      // ───────────────────────────────────────────────────────────────────────
    }
    return committed
  } catch (e) { return fail(e.commandCode || 'COMMAND_TRANSACTION_FAILED', e.message || '正式业务命令事务失败。', e.extra || {}) }
}

async function activateVerifiedDataset(db, ownerCoachId, datasetId, expectedHeadVersion, now) {
  if (!ownerCoachId || !datasetId || !Number.isInteger(expectedHeadVersion) || expectedHeadVersion < 0) return fail('INVALID_ACTIVATION_INPUT', '数据代次切换参数无效。')
  try {
    return await db.runTransaction(async tx => {
      const headId = fixedId('coach-data-head', ownerCoachId), head = await one(tx, META.heads, { _id: headId, ownerCoachId })
      const currentHeadVersion = head ? Number(head.headVersion) : 0
      if (currentHeadVersion !== expectedHeadVersion) throw commandError('HEAD_REVISION_CONFLICT', '数据 head 已被其他操作更新。', { currentHeadVersion })
      const datasetDocId = fixedId('coach-dataset', ownerCoachId, datasetId), candidate = await one(tx, META.datasets, { _id: datasetDocId, ownerCoachId, datasetId })
      if (!candidate || candidate.status !== 'verified' || candidate.integrityStatus !== 'verified' || !candidate.checksum || !Number.isFinite(candidate.byteSize) || !candidate.summary) throw commandError('DATASET_NOT_VERIFIED', '候选数据代次尚未完成全量完整性验证。')
      const revisionId = fixedId('coach-data-revision', ownerCoachId, datasetId), oldRevision = await one(tx, META.revisions, { _id: revisionId, ownerCoachId, datasetId })
      if (oldRevision && oldRevision.dataRevision !== 0) throw commandError('DATASET_ALREADY_MUTATED', '候选数据代次已经产生业务写入，不能作为新基线切换。')
      if (head && head.activeDatasetId && head.activeDatasetId !== datasetId) {
        const oldId = fixedId('coach-dataset', ownerCoachId, head.activeDatasetId), oldDataset = await one(tx, META.datasets, { _id: oldId, ownerCoachId, datasetId: head.activeDatasetId })
        if (oldDataset) await put(tx, META.datasets, oldId, { ...oldDataset, status: 'retired', retiredAt: now })
      }
      await put(tx, META.revisions, revisionId, { ownerCoachId, datasetId, dataRevision: 0, createdAt: oldRevision ? oldRevision.createdAt : now, updatedAt: now })
      await put(tx, META.datasets, datasetDocId, { ...candidate, status: 'active', activatedAt: now })
      const nextHeadVersion = currentHeadVersion + 1
      await put(tx, META.heads, headId, { ownerCoachId, activeDatasetId: datasetId, headVersion: nextHeadVersion, schemaVersion: candidate.schemaVersion, datasetChecksum: candidate.checksum, updatedAt: now, createdAt: head ? head.createdAt : now })
      return { ok: true, ownerCoachId, activeDatasetId: datasetId, headVersion: nextHeadVersion, dataRevision: 0 }
    })
  } catch (e) { return fail(e.commandCode || 'DATASET_ACTIVATION_FAILED', e.message || '数据代次切换失败。', e.extra || {}) }
}

function createService({ db, getOpenId, handlers = {}, now = () => Date.now(), delivery = null }) {
  return async function main(event = {}) {
    const openId = getOpenId()
    if (!openId) return fail('IDENTITY_MISSING', '未能确认当前微信身份。')
    const forbidden = forbiddenBusinessInput(event)
    if (forbidden) return fail('FORBIDDEN_IDENTITY_INPUT', `客户端不得提交身份或数据集定位字段：${forbidden}`)
    if (event.environment != null && event.environment !== 'production' && event.environment !== 'sandbox') return fail('INVALID_ENVIRONMENT', '数据环境无效。')
    // M3-P2：**会员自助预约的受控窄通道**（唯一命令 `createMemberBooking`）。
    //   ⛔ 位置很关键：它必须在**教练身份校验之前**就返回 —— 会员不是教练，
    //      若先判 `currentCoach()`，会员永远只能拿到 COACH_NOT_FOUND（那不是"被拒"，那是"没人听懂"）。
    //   ⛔ 它也不经过 `execute()` 的 31 条教练命令分发表：
    //      身份只由服务端从可信 OPENID 推导 memberId（绝不调用 coachIdFor(openId) ⇒ 不生成教练身份），
    //      命令白名单只有一条，业务判定全部复用本目录的 authorization / occupancy / 预约内核。
    //   ✅ 放在同一个云函数里的唯一理由：微信云函数按目录独立部署，跨目录 require 在真机上找不到文件，
    //      复制一份规则就等于两套口径（详见 memberBooking.js 顶部）。
    if (event.action === 'memberBooking') return require('./memberBooking').runMemberBooking({ db, getOpenId, now: now(), event, delivery })
    const ownerCoachId = coachIdFor(openId)
    if (!await currentCoach(db, openId, ownerCoachId)) return fail('COACH_NOT_FOUND', '未找到当前有效 coach。')
    try {
      const environment = environmentOf(event.environment)
      if (event.action === 'status') {
        const context = await activeContext(db, ownerCoachId, environment)
        return { ok: true, datasetRevision: context.revision.dataRevision, headVersion: context.head.headVersion, schemaVersion: context.dataset.schemaVersion }
      }
      if (event.action === 'getReceipt') {
        const requestId = validateRequestId(event.requestId), context = await activeContext(db, ownerCoachId, environment), id = fixedId(receiptKindFor(environment), ownerCoachId, `${context.datasetId}:${requestId}`)
        const receipt = await one(db, context.meta.receipts, { _id: id, ownerCoachId, datasetId: context.datasetId, requestId })
        return receipt ? { ok: true, found: true, status: receipt.status, response: clone(receipt.response || null) } : { ok: true, found: false }
      }
      if (event.action === 'execute') return execute(db, ownerCoachId, event.envelope, handlers, now(), environment, delivery)
      // M2 V1：授权目录**只读**（不写任何文档、不推进 revision、不产生收据、不碰业务集合）。
      //   放在这里而不是新开一个云函数，是为了让 authorization.js 只有**一份**实现
      //   （云函数之间无法共享代码文件，复制一份就必然漂移）。
      if (event.action === 'authorization') {
        const authorization = require('./authorization')
        if (event.read !== 'directory') return fail('INVALID_ACTION', '不支持的授权读取操作。')
        try { return await authorization.readDirectory({ db, ownerCoachId, environment }) }
        catch (e) { return fail(e.commandCode || 'AUTHORIZATION_READ_FAILED', e.message || '授权目录读取失败。') }
      }
      return fail('UNKNOWN_ACTION', '不支持的正式命令操作。')
    } catch (e) { return fail(e.commandCode || 'COMMAND_SERVICE_FAILED', e.message || '正式命令服务失败。', e.extra || {}) }
  }
}

// `one` / `put` / `receiptKindFor` 一并导出，供 repair.js 复用同一套行读写与回执口径。
module.exports = { META, SANDBOX_META, BUSINESS, PEER_RECEIPT_COMMAND, coachIdFor, fixedId, payloadHash, forbiddenBusinessInput, environmentOf, metaFor, activeContext, scopedBusiness, execute, activateVerifiedDataset, createService, one, put, receiptKindFor }
