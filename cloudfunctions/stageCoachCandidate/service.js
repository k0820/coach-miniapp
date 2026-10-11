const crypto = require('crypto')
const LOGICAL = ['students', 'studentTombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
const PHYSICAL = { students: 'students', studentTombstones: 'student_tombstones', packages: 'packages', bookings: 'bookings', incomes: 'incomes', sales: 'sales', settings: 'settings', customExercises: 'customExercises' }
const FORBIDDEN = new Set(['OPENID', 'openId', 'openid', '_openid', 'coachId', 'ownerCoachId', 'datasetId', 'activeDatasetId', 'documentId'])
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const bytes = value => Buffer.byteLength(String(value), 'utf8')
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.keys(value).sort().reduce((out, key) => { out[key] = canonical(value[key]); return out }, {}) : value
const json = value => JSON.stringify(canonical(value))
const same = (a, b) => json(a) === json(b)
const coachIdFor = openId => sha(`coach:${openId}`).slice(0, 32)
const fixedId = (kind, owner, suffix = '') => sha(`${kind}:${owner}:${suffix}`).slice(0, 32)
const datasetIdFor = (owner, checksum) => `candidate_${sha(`candidate-dataset:${owner}:${checksum}`).slice(0, 32)}`
const datasetDocId = (owner, dataset) => fixedId('coach-dataset', owner, dataset)
const chunkDocId = (owner, dataset, collection, index) => sha(`candidate-chunk:${owner}:${dataset}:${collection}:${index}`).slice(0, 40)
const keyOf = (collection, row) => row[{ students: 'studentId', studentTombstones: 'studentId', packages: 'packageId', bookings: 'bookingId', incomes: 'incomeId', sales: 'saleId', settings: 'settingsId', customExercises: 'customExerciseId' }[collection]]
const businessDocId = (collection, owner, dataset, row) => fixedId(collection === 'studentTombstones' ? 'coach-student-tombstone' : `coach-business-${collection}`, owner, `${dataset}:${keyOf(collection, row)}`)
const failure = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })
const error = (code, message) => Object.assign(new Error(message), { code })

async function one(scope, name, filter) { const result = await scope.collection(name).where(filter).limit(1).get(); return result.data && result.data[0] || null }
async function all(scope, name, filter) { const rows = []; for (let skip = 0; ; skip += 100) { const result = await scope.collection(name).where(filter).skip(skip).limit(100).get(), page = result.data || []; rows.push(...page); if (page.length < 100) return rows } }
async function put(scope, name, id, data) { const { _id, ...body } = data; return scope.collection(name).doc(id).set({ data: body }) }
function directForbidden(event) { for (const key of Object.keys(event || {})) if (key !== 'userInfo' && FORBIDDEN.has(key)) return key; return '' }
function validateBegin(event) {
  if (!/^[a-f0-9]{64}$/.test(String(event.sourceChecksum || '')) || !Number.isInteger(event.sourceByteSize) || event.sourceByteSize < 2) throw error('INVALID_SOURCE_FINGERPRINT', '源数据指纹无效。')
  if (!event.sourceSummary || !event.counts || !event.collections || !Number.isInteger(event.totalChunks) || LOGICAL.some(name => !Number.isInteger(event.collections[name]) || event.collections[name] < 1)) throw error('INVALID_CANDIDATE_PLAN', 'candidate 摘要或分块计划无效。')
}
function parseEntries(entries) {
  const ordered = [], fragments = new Map()
  entries.forEach(entry => {
    if (entry.kind === 'record') ordered.push({ value: JSON.parse(entry.json) })
    else if (entry.kind === 'fragment') { let item = fragments.get(entry.recordKey); if (!item) { item = { parts: new Array(entry.totalParts) }; fragments.set(entry.recordKey, item); ordered.push({ fragment: item }) } if (item.parts.length !== entry.totalParts || item.parts[entry.partIndex] != null) throw error('CANDIDATE_FRAGMENT_CONFLICT', '记录分片不一致。'); item.parts[entry.partIndex] = entry.jsonPart }
    else throw error('CANDIDATE_CHUNK_INVALID', '分块记录无效。')
  })
  fragments.forEach(item => { if (item.parts.some(part => typeof part !== 'string')) throw error('CANDIDATE_FRAGMENT_MISSING', '记录分片不完整。') })
  return ordered.map(item => item.value || JSON.parse(item.fragment.parts.join('')))
}
function rebuild(groups) {
  const people = groups.students.concat(groups.studentTombstones).sort((a, b) => a.sourceOrder - b.sourceOrder).map(row => ({ ...clone(row.data), packages: [] })), map = new Map(people.map(item => [item.id, item]))
  groups.packages.sort((a, b) => a.studentSourceOrder - b.studentSourceOrder || a.sourceOrder - b.sourceOrder).forEach(row => { const student = map.get(row.studentId); if (!student) throw error('ORPHAN_PACKAGE', '课时包缺少学员或墓碑。'); student.packages.push(clone(row.data)) })
  const ordered = name => groups[name].sort((a, b) => a.sourceOrder - b.sourceOrder).map(row => clone(row.data)), setting = groups.settings[0] || { data: {}, rootExtras: {} }
  return { ...(clone(setting.rootExtras || {})), students: people, bookings: ordered('bookings'), incomes: ordered('incomes'), sales: ordered('sales'), settings: clone(setting.data), customExercises: ordered('customExercises') }
}
function metadata(snapshot) {
  const canonicalJson = json(snapshot), packages = snapshot.students.flatMap(item => item.packages || []), incomeAmount = Number(snapshot.incomes.reduce((n, x) => n + Number(x.amount || 0), 0).toFixed(2)), salesAmount = Number(snapshot.sales.reduce((n, x) => n + Number(x.amount || 0), 0).toFixed(2))
  const summary = { students: snapshot.students.filter(x => x.status !== 'deleted').length, deletedStudents: snapshot.students.filter(x => x.status === 'deleted').length, packages: packages.length, bookings: snapshot.bookings.length, completedBookings: snapshot.bookings.filter(x => x.status === 'done').length, incomes: snapshot.incomes.length, sales: snapshot.sales.length, customExercises: snapshot.customExercises.length, incomeAmount, salesAmount }
  return { checksum: sha(canonicalJson), byteSize: bytes(canonicalJson), summary, counts: { students: snapshot.students.length, packages: packages.length, bookings: snapshot.bookings.length, incomes: snapshot.incomes.length, sales: snapshot.sales.length, customExercises: snapshot.customExercises.length }, amounts: { incomes: incomeAmount, sales: salesAmount } }
}
function validateRelations(snapshot) {
  const students = new Set(), packages = new Map(), sales = new Map(), bookings = new Map(), incomes = new Map()
  snapshot.students.forEach(s => { if (students.has(s.id)) throw error('DUPLICATE_ID', `student ${s.id} 重复。`); students.add(s.id); (s.packages || []).forEach(p => { if (packages.has(p.id)) throw error('DUPLICATE_ID', `package ${p.id} 重复。`); packages.set(p.id, { ...p, studentId: s.id }) }) })
  snapshot.sales.forEach(s => { if (sales.has(s.id)) throw error('DUPLICATE_ID', `sale ${s.id} 重复。`); sales.set(s.id, s) })
  packages.forEach(p => { if (p.status === 'reversed' && Number(p.remaining) !== 0) throw error('RELATION_INVALID', `reversed package ${p.id} remaining 非 0。`); if (p.saleId) { const s = sales.get(p.saleId); if (!s || s.packageId !== p.id || s.studentId !== p.studentId) throw error('RELATION_INVALID', `package ${p.id} sale 关系错误。`) } })
  snapshot.sales.filter(s => s.source === 'course').forEach(s => {
    if (s.legacyRelationStatus === 'orphan') {
      if (!['missing_packageId_without_unique_package.saleId', 'package_not_found', 'multiple_course_sales_for_package'].includes(s.legacyRelationReason) || [...packages.values()].some(p => p.saleId === s.id)) throw error('RELATION_INVALID', `legacy orphan sale ${s.id} 标记错误。`)
      return
    }
    const p = packages.get(s.packageId); if (!p || p.saleId !== s.id || p.studentId !== s.studentId) throw error('RELATION_INVALID', `sale ${s.id} package 关系错误。`)
  })
  snapshot.bookings.forEach(b => {
    if (bookings.has(b.id)) throw error('DUPLICATE_ID', `booking ${b.id} 重复。`); bookings.set(b.id, b)
    if (b.legacyRelationStatus === 'orphan') { if (b.status !== 'done' || !b.legacyRelationReason) throw error('RELATION_INVALID', `legacy orphan booking ${b.id} 标记错误。`); return }
    const p = packages.get(b.packageId); if (!p || p.studentId !== b.studentId) throw error('RELATION_INVALID', `booking ${b.id} package 关系错误。`)
  })
  snapshot.incomes.forEach(i => { if (incomes.has(i.id)) throw error('DUPLICATE_ID', `income ${i.id} 重复。`); incomes.set(i.id, i); const b = bookings.get(i.bookingId), legacyCompatible = b && b.status === 'done' && b.legacyRelationStatus === 'orphan' && (!b.studentId || !i.studentId || b.studentId === i.studentId); if (!legacyCompatible && (!b || b.status !== 'done' || b.studentId !== i.studentId)) throw error('RELATION_INVALID', `income ${i.id} booking 关系错误。`) })
  snapshot.bookings.filter(b => b.status === 'done').forEach(b => { const count = [...incomes.values()].filter(i => i.bookingId === b.id).length; if (b.legacyRelationStatus === 'orphan' ? count > 1 : count !== 1) throw error('RELATION_INVALID', `done booking ${b.id} income 非唯一。`) })
}

function createService({ db, getOpenId }) {
  return async function main(event = {}) {
    const openId = getOpenId(); if (!openId) return failure('IDENTITY_MISSING', '未能确认当前微信身份。')
    const forbidden = directForbidden(event); if (forbidden) return failure('FORBIDDEN_IDENTITY_INPUT', `客户端不得提交身份字段：${forbidden}`)
    const owner = coachIdFor(openId), coach = await one(db, 'coaches', { _id: owner, openId, status: 'active' }); if (!coach) return failure('COACH_NOT_FOUND', '未找到当前 coach。')
    try {
      if (event.action === 'prepare') {
        if (!/^[a-f0-9]{64}$/.test(String(event.sourceChecksum || ''))) throw error('INVALID_SOURCE_FINGERPRINT', '源数据 checksum 无效。')
        return { ok: true, ownerCoachId: owner, datasetId: datasetIdFor(owner, event.sourceChecksum) }
      }
      if (event.action === 'begin') {
        validateBegin(event); const datasetId = datasetIdFor(owner, event.sourceChecksum), id = datasetDocId(owner, datasetId), old = await one(db, 'coach_datasets', { _id: id, ownerCoachId: owner, datasetId })
        const expected = { ownerCoachId: owner, datasetId, status: 'candidate', integrityStatus: 'pending', schemaVersion: Number(event.schemaVersion || 1), checksum: event.sourceChecksum, byteSize: event.sourceByteSize, summary: clone(event.sourceSummary), counts: clone(event.counts), sourceChecksum: event.sourceChecksum, sourceByteSize: event.sourceByteSize, sourceSummary: clone(event.sourceSummary), totalChunks: event.totalChunks, collections: clone(event.collections) }
        if (old) {
          if (!['candidate', 'verified', 'cleanup'].includes(old.status)) throw error('CANDIDATE_DATASET_STATUS_INVALID', '已存 dataset 不是可续传的 candidate。')
          const immutable = value => ({ ownerCoachId: value.ownerCoachId, datasetId: value.datasetId, schemaVersion: value.schemaVersion, checksum: value.checksum, byteSize: value.byteSize, summary: value.summary, counts: value.counts, sourceChecksum: value.sourceChecksum, sourceByteSize: value.sourceByteSize, sourceSummary: value.sourceSummary, totalChunks: value.totalChunks, collections: value.collections })
          if (!same(immutable(old), immutable(expected))) throw error('CANDIDATE_SESSION_CONFLICT', 'candidate metadata 不一致。')
          return { ok: true, ownerCoachId: owner, datasetId, status: old.status, integrityStatus: old.integrityStatus, reused: true }
        }
        await put(db, 'coach_datasets', id, { ...expected, createdAt: db.serverDate(), updatedAt: db.serverDate() }); return { ok: true, ownerCoachId: owner, datasetId, status: 'candidate', integrityStatus: 'pending', reused: false }
      }
      const datasetId = datasetIdFor(owner, String(event.sourceChecksum || '')), id = datasetDocId(owner, datasetId), meta = await one(db, 'coach_datasets', { _id: id, ownerCoachId: owner, datasetId })
      if (!meta) throw error('CANDIDATE_SESSION_NOT_FOUND', '未找到当前 candidate。')
      if (event.action === 'uploadChunk') {
        if (meta.status !== 'candidate') throw error('CANDIDATE_SESSION_CLOSED', 'candidate 已结束上传。')
        if (!LOGICAL.includes(event.collection) || event.totalChunks !== meta.collections[event.collection] || !Number.isInteger(event.chunkIndex) || !Array.isArray(event.entries)) throw error('CANDIDATE_CHUNK_INVALID', 'candidate chunk 无效。')
        const content = json(event.entries); if (sha(content) !== event.chunkChecksum || bytes(content) !== event.chunkByteSize) throw error('CANDIDATE_CHUNK_INTEGRITY_FAILED', 'candidate chunk 校验失败。')
        const chunkId = chunkDocId(owner, datasetId, event.collection, event.chunkIndex), value = { ownerCoachId: owner, datasetId, collection: event.collection, chunkIndex: event.chunkIndex, totalChunks: event.totalChunks, checksum: event.chunkChecksum, byteSize: event.chunkByteSize, entries: clone(event.entries) }, old = await one(db, 'coach_candidate_chunks', { _id: chunkId, ownerCoachId: owner, datasetId })
        if (old) { const comparable = { ...old }; delete comparable._id; delete comparable.createdAt; if (!same(comparable, value)) throw error('CANDIDATE_CHUNK_CONFLICT', '同一 chunk 内容不一致。'); return { ok: true, reused: true } }
        await put(db, 'coach_candidate_chunks', chunkId, { ...value, createdAt: db.serverDate() }); return { ok: true, reused: false }
      }
      if (event.action === 'materializeNext') {
        if (meta.status !== 'candidate') throw error('CANDIDATE_SESSION_CLOSED', 'candidate 不在可落库状态。')
        const index = Number(meta.materializeCollectionIndex || 0), offset = Number(meta.materializeOffset || 0); if (index >= LOGICAL.length) return { ok: true, materialized: true }
        const name = LOGICAL[index], chunks = (await all(db, 'coach_candidate_chunks', { ownerCoachId: owner, datasetId, collection: name })).sort((a, b) => a.chunkIndex - b.chunkIndex)
        if (chunks.length !== meta.collections[name] || chunks.some((c, i) => c.chunkIndex !== i)) throw error('CANDIDATE_CHUNKS_MISSING', `${name} chunks 不完整。`)
        const rows = parseEntries(chunks.flatMap(c => c.entries)), batch = rows.slice(offset, offset + 20); let created = 0, reused = 0
        for (const raw of batch) { const row = { ...clone(raw), ownerCoachId: owner, datasetId }, docId = businessDocId(name, owner, datasetId, row), old = await one(db, PHYSICAL[name], { _id: docId, ownerCoachId: owner, datasetId }); if (old) { const comparable = { ...old }; delete comparable._id; if (!same(comparable, row)) throw error('CANDIDATE_DOCUMENT_CONFLICT', `${name} candidate 文档冲突。`); reused++ } else { await put(db, PHYSICAL[name], docId, row); created++ } }
        const nextOffset = offset + batch.length, done = nextOffset >= rows.length, update = done ? { materializeCollectionIndex: index + 1, materializeOffset: 0 } : { materializeCollectionIndex: index, materializeOffset: nextOffset }
        await db.collection('coach_datasets').doc(id).update({ data: { ...update, updatedAt: db.serverDate() } }); return { ok: true, collection: name, created, reused, continue: index + (done ? 1 : 0) < LOGICAL.length, ...update }
      }
      if (event.action === 'verify') {
        if (Number(meta.materializeCollectionIndex || 0) < LOGICAL.length) throw error('CANDIDATE_NOT_MATERIALIZED', 'candidate 尚未全部落库。')
        const groups = {}; for (const name of LOGICAL) groups[name] = (await all(db, PHYSICAL[name], { ownerCoachId: owner, datasetId })).map(row => { const copy = clone(row); delete copy._id; return copy })
        const snapshot = rebuild(groups), actual = metadata(snapshot); validateRelations(snapshot)
        if (actual.checksum !== meta.checksum || actual.byteSize !== meta.byteSize || !same(actual.summary, meta.summary) || !same(actual.counts, meta.counts)) throw error('CANDIDATE_READBACK_FAILED', '持久化 candidate 回读校验失败。')
        if (event.currentSourceChecksum !== meta.sourceChecksum || event.currentSourceByteSize !== meta.sourceByteSize || !same(event.currentSourceSummary, meta.sourceSummary)) throw error('SOURCE_CHANGED_DURING_MIGRATION', '源数据在 staging 期间已变化。')
        await db.collection('coach_datasets').doc(id).update({ data: { status: 'verified', integrityStatus: 'verified', verification: actual, verifiedAt: db.serverDate(), updatedAt: db.serverDate() } }); return { ok: true, status: 'verified', integrityStatus: 'verified', datasetId, verification: actual }
      }
      if (event.action === 'getStatus') { const head = await one(db, 'coach_data_heads', { _id: fixedId('coach-data-head', owner), ownerCoachId: owner }); return { ok: true, datasetId, status: meta.status, integrityStatus: meta.integrityStatus, materializeCollectionIndex: Number(meta.materializeCollectionIndex || 0), materializeOffset: Number(meta.materializeOffset || 0), activeDatasetId: head && head.activeDatasetId || null } }
      if (event.action === 'cleanup') {
        const head = await one(db, 'coach_data_heads', { _id: fixedId('coach-data-head', owner), ownerCoachId: owner }); if (head && head.activeDatasetId === datasetId) throw error('ACTIVE_DATASET_CLEANUP_FORBIDDEN', '不得清理 active dataset。')
        const index = Number(meta.cleanupCollectionIndex || 0); if (index < LOGICAL.length) { const name = LOGICAL[index], rows = await all(db, PHYSICAL[name], { ownerCoachId: owner, datasetId }); for (const row of rows) await db.collection(PHYSICAL[name]).doc(row._id).remove(); await db.collection('coach_datasets').doc(id).update({ data: { cleanupCollectionIndex: index + 1, status: 'cleanup', updatedAt: db.serverDate() } }); return { ok: true, continue: true, collection: name } }
        const chunks = await all(db, 'coach_candidate_chunks', { ownerCoachId: owner, datasetId }); for (const row of chunks) await db.collection('coach_candidate_chunks').doc(row._id).remove(); await db.collection('coach_datasets').doc(id).remove(); return { ok: true, cleaned: true }
      }
      return failure('UNKNOWN_ACTION', '不支持的 candidate staging 操作。')
    } catch (e) { return failure(e.code || 'CANDIDATE_STAGING_FAILED', e.message || 'candidate staging 失败。') }
  }
}
module.exports = { createService, coachIdFor, datasetIdFor, LOGICAL, PHYSICAL }
