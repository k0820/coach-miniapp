const { sha256, utf8ByteLength } = require('./sha256')
const { canonicalize } = require('./cloud-migration')
const { COLLECTIONS, reconstructCandidate, integrity, normalizeSnapshot } = require('./candidate-dataset')

const PHYSICAL_COLLECTIONS = Object.freeze({ students: 'students', studentTombstones: 'student_tombstones', packages: 'packages', bookings: 'bookings', incomes: 'incomes', sales: 'sales', settings: 'settings', customExercises: 'customExercises' })
const DEFAULT_RPC_LIMIT = 80 * 1024
const DEFAULT_FRAGMENT_LIMIT = 24 * 1024

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function canonicalJson(value) { return JSON.stringify(canonicalize(value)) }
function fail(code, message) { const error = new Error(message); error.code = code; throw error }
function same(a, b) { return canonicalJson(a) === canonicalJson(b) }
function splitUtf8(text, maxBytes) {
  const parts = []; let current = '', size = 0
  for (const char of text) { const bytes = utf8ByteLength(char); if (current && size + bytes > maxBytes) { parts.push(current); current = ''; size = 0 } current += char; size += bytes }
  if (current || !parts.length) parts.push(current)
  return parts
}
function businessKey(collection, row) {
  const keys = { students: 'studentId', studentTombstones: 'studentId', packages: 'packageId', bookings: 'bookingId', incomes: 'incomeId', sales: 'saleId', settings: 'settingsId', customExercises: 'customExerciseId' }
  const value = row && row[keys[collection]]
  if (typeof value !== 'string' || !value) fail('CANDIDATE_DOCUMENT_ID_INVALID', `${collection} 记录缺少稳定业务 ID。`)
  return value
}
function documentId(collection, owner, datasetId, row) {
  const kind = collection === 'studentTombstones' ? 'coach-student-tombstone' : `coach-business-${collection}`
  return sha256(`${kind}:${owner}:${datasetId}:${businessKey(collection, row)}`).slice(0, 32)
}
function chunkId(owner, datasetId, collection, chunkIndex) { return sha256(`candidate-chunk:${owner}:${datasetId}:${collection}:${chunkIndex}`).slice(0, 40) }
function deriveCandidateDatasetId(owner, sourceChecksum) {
  if (typeof owner !== 'string' || !owner || !/^[a-f0-9]{64}$/.test(String(sourceChecksum || ''))) fail('CANDIDATE_ID_INPUT_INVALID', '候选 dataset 派生参数无效。')
  return `candidate_${sha256(`candidate-dataset:${owner}:${sourceChecksum}`).slice(0, 32)}`
}

function entriesFor(collection, rows, fragmentLimit) {
  const entries = []
  rows.forEach(row => {
    const key = businessKey(collection, row), json = JSON.stringify(row)
    if (utf8ByteLength(json) <= fragmentLimit) entries.push({ kind: 'record', recordKey: key, json })
    else splitUtf8(json, fragmentLimit).forEach((jsonPart, partIndex, parts) => entries.push({ kind: 'fragment', recordKey: key, partIndex, totalParts: parts.length, jsonPart }))
  })
  return entries
}
function parseEntries(entries) {
  const order = [], fragments = new Map()
  entries.forEach(entry => {
    if (entry.kind === 'record') order.push({ value: JSON.parse(entry.json) })
    else if (entry.kind === 'fragment') {
      let item = fragments.get(entry.recordKey)
      if (!item) { item = { parts: new Array(entry.totalParts) }; fragments.set(entry.recordKey, item); order.push({ fragment: item }) }
      if (item.parts.length !== entry.totalParts || item.parts[entry.partIndex] != null) fail('CANDIDATE_FRAGMENT_CONFLICT', '候选记录分片重复或不一致。')
      item.parts[entry.partIndex] = entry.jsonPart
    } else fail('CANDIDATE_CHUNK_INVALID', '候选分块记录类型无效。')
  })
  fragments.forEach(item => { if (item.parts.some(part => typeof part !== 'string')) fail('CANDIDATE_FRAGMENT_MISSING', '候选记录分片不完整。') })
  return order.map(item => item.value || JSON.parse(item.fragment.parts.join('')))
}

function buildCandidateUploadPlan(candidate, options = {}) {
  const rpcLimit = Number(options.rpcLimit || DEFAULT_RPC_LIMIT), fragmentLimit = Math.min(Number(options.fragmentLimit || DEFAULT_FRAGMENT_LIMIT), Math.floor(rpcLimit / 3))
  const chunks = []
  COLLECTIONS.forEach(collection => {
    const entries = entriesFor(collection, candidate.collections[collection], fragmentLimit), groups = []; let current = []
    const envelope = value => ({ action: 'uploadChunk', sessionId: candidate.datasetId, collection, chunkIndex: 999999, totalChunks: 999999, entries: value, chunkChecksum: 'x'.repeat(64), chunkByteSize: 999999 })
    entries.forEach(entry => {
      const next = current.concat(entry)
      if (current.length && utf8ByteLength(JSON.stringify(envelope(next))) > rpcLimit) { groups.push(current); current = [entry] } else current = next
    })
    if (current.length || !groups.length) groups.push(current)
    groups.forEach((group, index) => {
      const json = canonicalJson(group), chunk = { action: 'uploadChunk', sessionId: candidate.datasetId, collection, chunkIndex: index, totalChunks: groups.length, entries: group, chunkChecksum: sha256(json), chunkByteSize: utf8ByteLength(json) }
      const rpcByteSize = utf8ByteLength(JSON.stringify(chunk))
      if (rpcByteSize > rpcLimit) fail('CANDIDATE_RPC_TOO_LARGE', `${collection}[${index}] RPC ${rpcByteSize} 字节超过安全上限。`)
      chunks.push({ ...chunk, rpcByteSize })
    })
  })
  return { datasetId: candidate.datasetId, checksum: candidate.integrity.checksum, byteSize: candidate.integrity.byteSize, summary: clone(candidate.integrity.summary), counts: clone(candidate.integrity.counts), totalChunks: chunks.length, collections: Object.fromEntries(COLLECTIONS.map(name => [name, chunks.filter(chunk => chunk.collection === name).length])), chunks }
}

class CandidateStagingMock {
  constructor() { this.datasets = new Map(); this.chunks = new Map(); this.business = Object.fromEntries(COLLECTIONS.map(name => [name, new Map()])); this.heads = new Map(); this.revisions = new Map() }
  start(owner, candidate, plan) {
    const trustedDatasetId = deriveCandidateDatasetId(owner, candidate.integrity.checksum)
    if (candidate.ownerCoachId !== owner || candidate.datasetId !== trustedDatasetId || plan.datasetId !== trustedDatasetId) fail('UNTRUSTED_CANDIDATE_SCOPE', 'candidate 归属或 datasetId 不是可信云端派生结果。')
    const key = `${owner}:${candidate.datasetId}`, old = this.datasets.get(key)
    const metadata = { ownerCoachId: owner, datasetId: candidate.datasetId, status: 'candidate', schemaVersion: candidate.schemaVersion, checksum: candidate.integrity.checksum, byteSize: candidate.integrity.byteSize, summary: clone(candidate.integrity.summary), counts: clone(candidate.integrity.counts), sourceChecksum: candidate.integrity.checksum, sourceByteSize: candidate.integrity.byteSize, sourceSummary: clone(candidate.integrity.summary), integrityStatus: 'pending', totalChunks: plan.totalChunks, collections: clone(plan.collections), createdAt: 'server-time' }
    if (old) {
      if (!['candidate', 'verified', 'cleanup'].includes(old.status)) fail('CANDIDATE_DATASET_STATUS_INVALID', '已存 dataset 不是可续传的 candidate。')
      const immutable = value => ({ ownerCoachId: value.ownerCoachId, datasetId: value.datasetId, schemaVersion: value.schemaVersion, checksum: value.checksum, byteSize: value.byteSize, summary: value.summary, counts: value.counts, sourceChecksum: value.sourceChecksum, sourceByteSize: value.sourceByteSize, sourceSummary: value.sourceSummary, totalChunks: value.totalChunks, collections: value.collections })
      if (!same(immutable(old), immutable(metadata))) fail('CANDIDATE_SESSION_CONFLICT', '同一 candidate dataset 已有不同元数据。')
      return { reused: true, metadata: clone(old) }
    }
    this.datasets.set(key, metadata); return { reused: false, metadata: clone(metadata) }
  }
  upload(owner, event) {
    const meta = this.datasets.get(`${owner}:${event.sessionId}`)
    if (!meta || meta.status !== 'candidate') fail('CANDIDATE_SESSION_NOT_FOUND', '候选会话不存在。')
    if (!COLLECTIONS.includes(event.collection) || event.totalChunks !== meta.collections[event.collection]) fail('CANDIDATE_CHUNK_INVALID', '候选分块计划不一致。')
    const json = canonicalJson(event.entries)
    if (sha256(json) !== event.chunkChecksum || utf8ByteLength(json) !== Number(event.chunkByteSize)) fail('CANDIDATE_CHUNK_INTEGRITY_FAILED', '候选分块校验失败。')
    const id = chunkId(owner, event.sessionId, event.collection, event.chunkIndex), old = this.chunks.get(id), value = { ownerCoachId: owner, datasetId: event.sessionId, collection: event.collection, chunkIndex: event.chunkIndex, totalChunks: event.totalChunks, checksum: event.chunkChecksum, byteSize: event.chunkByteSize, entries: clone(event.entries) }
    if (old) { if (!same(old, value)) fail('CANDIDATE_CHUNK_CONFLICT', '同一 candidate chunk 内容不一致。'); return { reused: true } }
    this.chunks.set(id, value); return { reused: false }
  }
  materializeCollection(owner, datasetId, collection) {
    const meta = this.datasets.get(`${owner}:${datasetId}`); if (!meta) fail('CANDIDATE_SESSION_NOT_FOUND', '候选会话不存在。')
    const chunks = [...this.chunks.values()].filter(item => item.ownerCoachId === owner && item.datasetId === datasetId && item.collection === collection).sort((a, b) => a.chunkIndex - b.chunkIndex)
    if (chunks.length !== meta.collections[collection] || chunks.some((item, index) => item.chunkIndex !== index)) fail('CANDIDATE_CHUNKS_MISSING', `${collection} 分块不完整。`)
    const rows = parseEntries(chunks.flatMap(item => item.entries)), store = this.business[collection]; let created = 0, reused = 0
    rows.forEach(row => {
      const expected = { ...clone(row), _id: documentId(collection, owner, datasetId, row), ownerCoachId: owner, datasetId }, old = store.get(expected._id)
      if (old) { if (!same(old, expected)) fail('CANDIDATE_DOCUMENT_CONFLICT', `${collection} 已存在同 ID 但内容不同的 candidate 文档。`); reused++ } else { store.set(expected._id, expected); created++ }
    })
    return { created, reused }
  }
  readPage(owner, datasetId, collection, offset = 0, limit = 25) {
    return [...this.business[collection].values()].filter(item => item.ownerCoachId === owner && item.datasetId === datasetId).sort((a, b) => Number(a.sourceOrder) - Number(b.sourceOrder) || String(a._id).localeCompare(String(b._id))).slice(offset, offset + limit).map(item => { const value = clone(item); delete value._id; return value })
  }
  readAll(owner, datasetId) {
    const out = {}; COLLECTIONS.forEach(name => { out[name] = []; for (let offset = 0; ; offset += 25) { const page = this.readPage(owner, datasetId, name, offset, 25); out[name].push(...page); if (page.length < 25) break } }); return out
  }
  verify(owner, datasetId, currentSourceSnapshot) {
    const key = `${owner}:${datasetId}`, meta = this.datasets.get(key); if (!meta) fail('CANDIDATE_SESSION_NOT_FOUND', '候选会话不存在。')
    const rebuilt = reconstructCandidate(this.readAll(owner, datasetId)), actual = integrity(rebuilt)
    if (actual.checksum !== meta.checksum || actual.byteSize !== meta.byteSize || !same(actual.summary, meta.summary) || !same(actual.counts, meta.counts)) fail('CANDIDATE_READBACK_FAILED', 'candidate 云端回读完整性不一致。')
    const sourceNow = integrity(normalizeSnapshot(currentSourceSnapshot))
    if (sourceNow.checksum !== meta.sourceChecksum || sourceNow.byteSize !== meta.sourceByteSize || !same(sourceNow.summary, meta.sourceSummary)) fail('SOURCE_CHANGED_DURING_MIGRATION', '本机源数据在 candidate 构建期间已变化。')
    meta.status = 'verified'; meta.integrityStatus = 'verified'; meta.verifiedAt = 'server-time-verified'; meta.verification = clone(actual)
    return { valid: true, rebuilt, integrity: actual }
  }
  cleanup(owner, datasetId) {
    const key = `${owner}:${datasetId}`, meta = this.datasets.get(key)
    if (meta && meta.status === 'active') fail('ACTIVE_DATASET_CLEANUP_FORBIDDEN', '不得清理 active dataset。')
    COLLECTIONS.forEach(name => { for (const [id, row] of this.business[name]) if (row.ownerCoachId === owner && row.datasetId === datasetId) this.business[name].delete(id) })
    for (const [id, row] of this.chunks) if (row.ownerCoachId === owner && row.datasetId === datasetId) this.chunks.delete(id)
    this.datasets.delete(key)
    return { cleaned: true }
  }
}

module.exports = { PHYSICAL_COLLECTIONS, DEFAULT_RPC_LIMIT, buildCandidateUploadPlan, CandidateStagingMock, deriveCandidateDatasetId, documentId, chunkId }
