const crypto = require('crypto')
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const coachIdFor = openId => sha(`coach:${openId}`).slice(0, 32)
const fixedId = (kind, owner, suffix = '') => sha(`${kind}:${owner}:${suffix}`).slice(0, 32)
const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })
const error = (code, message, extra = {}) => Object.assign(new Error(message), { code, extra })
const same = (a, b) => canonical(a) === canonical(b)

async function one(scope, name, query) { const r = await scope.collection(name).where(query).limit(2).get(); return r.data || [] }
async function put(scope, name, id, data) { const { _id, ...body } = data; return scope.collection(name).doc(id).set({ data: body }) }

function validate(event) {
  for (const key of ['OPENID', 'openId', 'openid', '_openid', 'coachId', 'ownerCoachId', 'datasetId', 'documentId']) if (Object.prototype.hasOwnProperty.call(event || {}, key)) throw error('FORBIDDEN_IDENTITY_INPUT', `客户端不得提交 ${key}。`)
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(String(event.requestId || ''))) throw error('INVALID_REQUEST_ID', 'requestId 无效。')
  if (!Number.isInteger(event.expectedHeadVersion) || event.expectedHeadVersion < 0) throw error('INVALID_HEAD_VERSION', 'expectedHeadVersion 无效。')
  if (!/^[a-f0-9]{64}$/.test(String(event.sourceChecksum || '')) || !Number.isInteger(event.sourceByteSize) || event.sourceByteSize < 2 || !event.sourceSummary || typeof event.sourceSummary !== 'object') throw error('INVALID_SOURCE_FINGERPRINT', '源数据指纹无效。')
}

function createService({ db, getOpenId, now = () => Date.now() }) {
  return async function main(event = {}) {
    const openId = getOpenId(), owner = openId && coachIdFor(openId)
    if (!openId) return fail('IDENTITY_MISSING', '未能确认当前微信身份。')
    try {
      const coaches = await one(db, 'coaches', { _id: owner, openId, status: 'active' })
      if (coaches.length !== 1) throw error('COACH_NOT_FOUND', '未找到当前有效 coach。')
      if (event.action === 'getReceipt') {
        if (!/^[A-Za-z0-9:_-]{8,128}$/.test(String(event.requestId || ''))) throw error('INVALID_REQUEST_ID', 'requestId 无效。')
        const id = fixedId('coach-dataset-activation-receipt', owner, event.requestId), rows = await one(db, 'coach_dataset_activation_receipts', { _id: id, ownerCoachId: owner, requestId: event.requestId })
        return rows[0] ? { ok: true, found: true, status: rows[0].status, result: rows[0].result || null } : { ok: true, found: false }
      }
      if (event.action !== 'activate') throw error('UNKNOWN_ACTION', '不支持的 activation 操作。')
      validate(event)
      const payload = { sourceChecksum: event.sourceChecksum, sourceByteSize: event.sourceByteSize, sourceSummary: event.sourceSummary, expectedHeadVersion: event.expectedHeadVersion }, payloadHash = sha(canonical(payload)), receiptId = fixedId('coach-dataset-activation-receipt', owner, event.requestId)
      return await db.runTransaction(async tx => {
        const prior = (await one(tx, 'coach_dataset_activation_receipts', { _id: receiptId, ownerCoachId: owner, requestId: event.requestId }))[0]
        if (prior) {
          if (prior.payloadHash !== payloadHash) throw error('REQUEST_ID_CONFLICT', '同一 requestId 对应了不同 activation 参数。')
          if (prior.status === 'succeeded') return { ...prior.result, idempotent: true }
          throw error('ACTIVATION_PROCESSING', '激活正在处理中，可安全查单或重试。', { retrySafe: true })
        }
        const headId = fixedId('coach-data-head', owner), head = (await one(tx, 'coach_data_heads', { _id: headId, ownerCoachId: owner }))[0] || null
        const headBefore = head ? Number(head.headVersion || 0) : 0
        if (headBefore !== event.expectedHeadVersion) throw error('HEAD_REVISION_CONFLICT', '数据 head 已变化。', { currentHeadVersion: headBefore })
        const candidates = await one(tx, 'coach_datasets', { ownerCoachId: owner, sourceChecksum: event.sourceChecksum, status: 'verified', integrityStatus: 'verified' })
        if (candidates.length !== 1) throw error(candidates.length ? 'CANDIDATE_AMBIGUOUS' : 'DATASET_NOT_VERIFIED', '未找到唯一且已验证的 Candidate。')
        const candidate = candidates[0], datasetId = candidate.datasetId
        if (candidate.byteSize !== event.sourceByteSize || !same(candidate.summary, event.sourceSummary)) throw error('SOURCE_FINGERPRINT_MISMATCH', 'Candidate 与激活前源数据指纹不一致。')
        const revisionId = fixedId('coach-data-revision', owner, datasetId), revisions = await one(tx, 'coach_data_revisions', { _id: revisionId, ownerCoachId: owner, datasetId })
        if (revisions[0] && revisions[0].dataRevision !== 0) throw error('DATASET_ALREADY_MUTATED', 'Candidate 已产生业务写入。')
        await put(tx, 'coach_dataset_activation_receipts', receiptId, { ownerCoachId: owner, requestId: event.requestId, payloadHash, sourceChecksum: event.sourceChecksum, expectedHeadVersion: event.expectedHeadVersion, status: 'processing', headVersionBefore: headBefore, createdAt: now() })
        if (head && head.activeDatasetId && head.activeDatasetId !== datasetId) {
          const oldId = fixedId('coach-dataset', owner, head.activeDatasetId), old = (await one(tx, 'coach_datasets', { _id: oldId, ownerCoachId: owner, datasetId: head.activeDatasetId }))[0]
          if (old) await put(tx, 'coach_datasets', oldId, { ...old, status: 'retired', retiredAt: now() })
        }
        await put(tx, 'coach_data_revisions', revisionId, { ownerCoachId: owner, datasetId, dataRevision: 0, createdAt: revisions[0] ? revisions[0].createdAt : now(), updatedAt: now() })
        await put(tx, 'coach_datasets', candidate._id, { ...candidate, status: 'active', activatedAt: now() })
        const headAfter = headBefore + 1
        await put(tx, 'coach_data_heads', headId, { ownerCoachId: owner, activeDatasetId: datasetId, headVersion: headAfter, schemaVersion: candidate.schemaVersion, datasetChecksum: candidate.checksum, createdAt: head ? head.createdAt : now(), updatedAt: now() })
        const result = { ok: true, activeDatasetId: datasetId, dataRevision: 0, headVersionBefore: headBefore, headVersionAfter: headAfter, sourceChecksum: event.sourceChecksum }
        await put(tx, 'coach_dataset_activation_receipts', receiptId, { ownerCoachId: owner, requestId: event.requestId, payloadHash, sourceChecksum: event.sourceChecksum, expectedHeadVersion: event.expectedHeadVersion, status: 'succeeded', headVersionBefore: headBefore, headVersionAfter: headAfter, result, completedAt: now() })
        return result
      })
    } catch (e) { return fail(e.code || 'ACTIVATION_FAILED', e.message || '激活失败。', e.extra || {}) }
  }
}

module.exports = { coachIdFor, fixedId, createService }
