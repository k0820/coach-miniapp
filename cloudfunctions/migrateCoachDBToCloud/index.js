const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const MIGRATION_VERSION = 1
const NAMES = ['students', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
const migrations = db.collection('coach_migrations')
const uploadChunks = db.collection('coach_migration_chunks')
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const bytes = value => Buffer.byteLength(value, 'utf8')
const coachIdFor = openId => digest(`coach:${openId}`).slice(0, 32)
const lockIdFor = coachId => digest(`coach-migration-lock:${coachId}:${MIGRATION_VERSION}`).slice(0, 32)
const chunkIdFor = (sessionId, name, index) => digest(`coach-migration-chunk:${sessionId}:${name}:${index}`).slice(0, 32)
const docId = (name, owner, id) => digest(`${name}:${owner}:${id}`).slice(0, 32)
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.keys(value).sort().reduce((out, key) => { out[key] = canonical(value[key]); return out }, {}) : value
const chunkJson = records => JSON.stringify(canonical(records))
async function all(collection, filter) { const out = []; for (let skip = 0; ; skip += 100) { const result = await collection.where(filter).skip(skip).limit(100).get(), page = result.data || []; out.push(...page); if (page.length < 100) return out } }
async function coach(openId, owner) { const result = await db.collection('coaches').where({ _id: owner, openId, status: 'active' }).limit(1).get(); return result.data && result.data[0] }
function validateMeta(event) {
  if (event.protocolVersion !== 1 || event.schemaVersion !== 1) return '不支持的迁移分块协议。'
  if (!/^[a-f0-9]{64}$/.test(String(event.checksum || '')) || !Number.isInteger(Number(event.byteSize))) return '迁移完整性信息无效。'
  if (!event.summary || !event.collections || NAMES.some(name => !Number.isInteger(Number(event.collections[name])) || Number(event.collections[name]) < 1)) return '迁移摘要或分块计划无效。'
  return ''
}
function parseEntries(entries) {
  const ordered = [], fragments = new Map()
  entries.forEach(entry => {
    if (entry.kind === 'record' && typeof entry.json === 'string') ordered.push({ kind: 'record', value: JSON.parse(entry.json) })
    else if (entry.kind === 'fragment' && typeof entry.jsonPart === 'string') {
      if (!fragments.has(entry.recordKey)) {
        const item = { total: entry.totalParts, parts: [] }
        fragments.set(entry.recordKey, item)
        ordered.push({ kind: 'fragment', item })
      }
      const item = fragments.get(entry.recordKey)
      if (item.total !== entry.totalParts || item.parts[entry.partIndex] != null) throw new Error('记录分片重复或不一致。')
      item.parts[entry.partIndex] = entry.jsonPart
    } else throw new Error('分块记录结构无效。')
  })
  fragments.forEach(item => { if (item.parts.length !== item.total || item.parts.some(part => typeof part !== 'string')) throw new Error('记录分片不完整。') })
  return ordered.map(item => item.kind === 'record' ? item.value : JSON.parse(item.item.parts.join('')))
}
function rebuild(docs) {
  const logical = Object.fromEntries(NAMES.map(name => [name, []]))
  NAMES.forEach(name => {
    const group = docs.filter(item => item.collection === name).sort((a, b) => a.chunkIndex - b.chunkIndex), expected = group[0] && group[0].totalChunks
    if (!expected || group.length !== expected || group.some((item, index) => item.chunkIndex !== index || item.totalChunks !== expected)) throw new Error(`${name} 分块不完整。`)
    const entries = []
    group.forEach(item => { const json = chunkJson(item.records); if (digest(json) !== item.checksum || bytes(json) !== Number(item.byteSize)) throw new Error(`${name} 分块校验失败。`); entries.push(...item.records) })
    logical[name].push(...parseEntries(entries))
  })
  const students = logical.students.sort((a, b) => a.sortIndex - b.sortIndex).map(item => ({ ...item.data, packages: [] })), map = new Map(students.map(student => [student.id, student]))
  logical.packages.sort((a, b) => a.studentSortIndex - b.studentSortIndex || a.sortIndex - b.sortIndex).forEach(item => { const student = map.get(item.studentId); if (!student) throw new Error('课时包缺少关联学员。'); student.packages.push(item.data) })
  const ordered = name => logical[name].sort((a, b) => a.sortIndex - b.sortIndex).map(item => item.data)
  const settingRecord = logical.settings[0] || {}
  return { ...(settingRecord.rootExtras || {}), students, bookings: ordered('bookings'), incomes: ordered('incomes'), sales: ordered('sales'), settings: settingRecord.data || {}, customExercises: ordered('customExercises') }
}
function metadata(snapshot) {
  const json = JSON.stringify(canonical(snapshot)), students = snapshot.students, bookings = snapshot.bookings, incomes = snapshot.incomes, sales = snapshot.sales, customExercises = snapshot.customExercises
  return { checksum: digest(json), byteSize: bytes(json), summary: { students: students.length, packages: students.reduce((n, s) => n + s.packages.length, 0), bookings: bookings.length, completedBookings: bookings.filter(x => x.status === 'done').length, incomes: incomes.length, sales: sales.length, customExercises: customExercises.length, hasSettings: !!snapshot.settings, incomeAmount: Number(incomes.reduce((n, x) => n + Number(x.amount || 0), 0).toFixed(2)), salesAmount: Number(sales.reduce((n, x) => n + Number(x.amount || 0), 0).toFixed(2)) } }
}
async function hasBusiness(owner) { for (const name of NAMES) { const result = await db.collection(name).where({ ownerCoachId: owner }).limit(1).get(); if (result.data && result.data.length) return true } return false }
function documents(snapshot, owner, migrationId) {
  const out = Object.fromEntries(NAMES.map(name => [name, []]))
  snapshot.students.forEach((student, studentIndex) => {
    const data = JSON.parse(JSON.stringify(student)); const packages = data.packages; delete data.packages
    out.students.push({ _id: docId('students', owner, student.id), ownerCoachId: owner, studentId: student.id, migrationId, migrationVersion: 1, sortIndex: studentIndex, data })
    packages.forEach((pkg, sortIndex) => out.packages.push({ _id: docId('packages', owner, pkg.id), ownerCoachId: owner, packageId: pkg.id, studentId: student.id, migrationId, migrationVersion: 1, studentSortIndex: studentIndex, sortIndex, data: pkg }))
  })
  snapshot.bookings.forEach((data, sortIndex) => out.bookings.push({ _id: docId('bookings', owner, data.id), ownerCoachId: owner, bookingId: data.id, studentId: data.studentId || '', packageId: data.packageId || '', migrationId, migrationVersion: 1, sortIndex, data }))
  snapshot.incomes.forEach((data, sortIndex) => out.incomes.push({ _id: docId('incomes', owner, data.id), ownerCoachId: owner, incomeId: data.id, bookingId: data.bookingId || '', migrationId, migrationVersion: 1, sortIndex, data }))
  snapshot.sales.forEach((data, sortIndex) => out.sales.push({ _id: docId('sales', owner, data.id), ownerCoachId: owner, saleId: data.id, studentId: data.studentId || '', packageId: data.packageId || '', migrationId, migrationVersion: 1, sortIndex, data }))
  const known = new Set(['students', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']), rootExtras = {}
  Object.keys(snapshot).forEach(key => { if (!known.has(key)) rootExtras[key] = JSON.parse(JSON.stringify(snapshot[key])) })
  out.settings.push({ _id: docId('settings', owner, 'settings'), ownerCoachId: owner, migrationId, migrationVersion: 1, sortIndex: 0, data: snapshot.settings, rootExtras })
  snapshot.customExercises.forEach((data, sortIndex) => out.customExercises.push({ _id: docId('customExercises', owner, data.id || sortIndex), ownerCoachId: owner, customExerciseId: data.id || `legacy-${sortIndex}`, migrationId, migrationVersion: 1, sortIndex, data }))
  return out
}
function expectedDocumentMatches(existing, expected) {
  return Object.keys(expected).every(key => JSON.stringify(canonical(existing[key])) === JSON.stringify(canonical(expected[key])))
}
async function ensureDocuments(name, records) {
  let reused = 0, created = 0
  for (let offset = 0; offset < records.length; offset += 20) {
    const results = await Promise.all(records.slice(offset, offset + 20).map(async data => {
      const found = await db.collection(name).where({ _id: data._id, ownerCoachId: data.ownerCoachId }).limit(1).get()
      const existing = found.data && found.data[0]
      if (existing) {
        if (!expectedDocumentMatches(existing, data)) {
          const error = new Error(`${name} 中已存在内容不同的迁移记录，已停止迁移。`)
          error.code = 'MIGRATION_DOCUMENT_CONFLICT'
          throw error
        }
        return 'reused'
      }
      await db.collection(name).add({ data })
      return 'created'
    }))
    reused += results.filter(item => item === 'reused').length
    created += results.filter(item => item === 'created').length
  }
  return { reused, created }
}
async function verifyBusiness(owner, migrationId, expected) {
  const groups = {}
  for (const name of NAMES) groups[name] = await all(db.collection(name), { ownerCoachId: owner, migrationId })
  const students = groups.students.sort((a, b) => a.sortIndex - b.sortIndex).map(item => ({ ...item.data, packages: [] })), map = new Map(students.map(item => [item.id, item]))
  groups.packages.sort((a, b) => a.studentSortIndex - b.studentSortIndex || a.sortIndex - b.sortIndex).forEach(item => { const student = map.get(item.studentId); if (!student) throw new Error('云端课时包关联失败。'); student.packages.push(item.data) })
  const ordered = name => groups[name].sort((a, b) => a.sortIndex - b.sortIndex).map(item => item.data)
  const settingRecord = groups.settings[0] || {}
  const rebuilt = { ...(settingRecord.rootExtras || {}), students, bookings: ordered('bookings'), incomes: ordered('incomes'), sales: ordered('sales'), settings: settingRecord.data || {}, customExercises: ordered('customExercises') }
  const actual = metadata(rebuilt)
  return { valid: actual.checksum === expected.checksum && actual.byteSize === Number(expected.byteSize) && JSON.stringify(canonical(actual.summary)) === JSON.stringify(canonical(expected.summary)), ...actual }
}
async function cleanup(owner, migrationId) {
  for (const name of NAMES) { const docs = await all(db.collection(name), { ownerCoachId: owner, migrationId }); await Promise.all(docs.map(item => db.collection(name).doc(item._id).remove())) }
}
async function removeUpload(owner, sessionId) { const docs = await all(uploadChunks, { ownerCoachId: owner, sessionId }); await Promise.all(docs.map(item => uploadChunks.doc(item._id).remove())) }

exports.main = async event => {
  const openId = cloud.getWXContext().OPENID
  if (!openId) return { ok: false, code: 'NO_IDENTITY', message: '未能确认当前微信身份。' }
  const owner = coachIdFor(openId), action = event && event.action
  if (!await coach(openId, owner)) return { ok: false, code: 'COACH_NOT_FOUND', message: '未找到当前 coach。' }
  try {
    if (action === 'start') {
      const error = validateMeta(event); if (error) return { ok: false, code: 'INVALID_PLAN', message: error }
      const lockId = lockIdFor(owner), result = await migrations.where({ _id: lockId, ownerCoachId: owner }).limit(1).get(), old = result.data && result.data[0]
      if (old) {
        if (old.checksum !== event.checksum) return { ok: false, code: 'DIFFERENT_CLOUD_DATA', message: '云端已有不同迁移数据，禁止覆盖。' }
        if (old.status === 'failed') {
          await removeUpload(owner, old.migrationId)
          await cleanup(owner, old.migrationId)
          await migrations.doc(lockId).update({ data: { status: 'uploading', cleanupComplete: false, updatedAt: db.serverDate() } })
        }
        return { ok: true, sessionId: old.migrationId, migrationId: old.migrationId, completed: old.status === 'completed', idempotent: old.status === 'completed', migrationVersion: 1, checksum: old.checksum, byteSize: old.byteSize, summary: old.summary, verification: old.verification }
      }
      if (await hasBusiness(owner)) return { ok: false, code: 'CLOUD_DATA_EXISTS', message: '云端已有无法确认来源的业务数据，禁止覆盖。' }
      const migrationId = digest(`coach-migration:${owner}:1:${event.checksum}`).slice(0, 32)
      await migrations.add({ data: { _id: lockId, ownerCoachId: owner, migrationId, migrationVersion: 1, protocolVersion: 1, checksum: event.checksum, byteSize: Number(event.byteSize), summary: event.summary, totalChunks: Number(event.totalChunks), collections: event.collections, status: 'uploading', createdAt: db.serverDate(), updatedAt: db.serverDate() } })
      return { ok: true, sessionId: migrationId, migrationId, completed: false }
    }
    const sessionId = String(event && event.sessionId || ''), lockId = lockIdFor(owner), result = await migrations.where({ _id: lockId, ownerCoachId: owner, migrationId: sessionId }).limit(1).get(), record = result.data && result.data[0]
    if (!record) return { ok: false, code: 'SESSION_NOT_FOUND', message: '迁移会话不存在。' }
    if (action === 'status') { const docs = await all(uploadChunks, { ownerCoachId: owner, sessionId }); return { ok: true, status: record.status, finalizeCollectionIndex: Number(record.finalizeCollectionIndex || 0), receivedChunks: docs.map(item => `${item.collection}:${item.chunkIndex}`) } }
    if (action === 'uploadChunk') {
      if (record.status !== 'uploading') return { ok: false, code: 'SESSION_CLOSED', message: '迁移会话已关闭。' }
      const name = String(event.collection || ''), index = Number(event.chunkIndex), total = Number(event.totalChunks), records = event.records
      if (!NAMES.includes(name) || !Number.isInteger(index) || index < 0 || total !== Number(record.collections[name]) || !Array.isArray(records)) return { ok: false, code: 'INVALID_CHUNK', message: '迁移分块无效。' }
      const json = chunkJson(records), checksum = digest(json), byteSize = bytes(json)
      if (checksum !== event.chunkChecksum || byteSize !== Number(event.chunkByteSize) || byteSize > 256 * 1024) return { ok: false, code: 'CHUNK_INTEGRITY_FAILED', message: '迁移分块校验失败。' }
      const id = chunkIdFor(sessionId, name, index), found = await uploadChunks.where({ _id: id, ownerCoachId: owner }).limit(1).get(), old = found.data && found.data[0]
      if (old) return old.checksum === checksum && old.byteSize === byteSize ? { ok: true, reused: true } : { ok: false, code: 'CHUNK_CONFLICT', message: '同一迁移分块内容不一致。' }
      await uploadChunks.add({ data: { _id: id, ownerCoachId: owner, sessionId, migrationId: sessionId, collection: name, chunkIndex: index, totalChunks: total, checksum, byteSize, records, createdAt: db.serverDate() } })
      return { ok: true, reused: false }
    }
    if (action === 'finalize') {
      if (record.status === 'completed') return { ok: true, completed: true, idempotent: true, migrationId: sessionId, migrationVersion: 1, checksum: record.checksum, byteSize: record.byteSize, summary: record.summary, verification: record.verification }
      const chunkDocs = await all(uploadChunks, { ownerCoachId: owner, sessionId })
      if (chunkDocs.length !== Number(record.totalChunks)) return { ok: false, code: 'CHUNKS_MISSING', message: '迁移分块尚未全部上传。' }
      const snapshot = rebuild(chunkDocs), source = metadata(snapshot)
      if (source.checksum !== record.checksum || source.byteSize !== Number(record.byteSize) || JSON.stringify(canonical(source.summary)) !== JSON.stringify(canonical(record.summary))) return { ok: false, code: 'FINAL_VERIFY_FAILED', message: '迁移源数据回读校验失败。' }
      const groups = documents(snapshot, owner, sessionId)
      if (record.status === 'uploading') {
        const updated = await migrations.where({ _id: lockId, ownerCoachId: owner, migrationId: sessionId, status: 'uploading' }).update({ data: { status: 'writing', finalizeCollectionIndex: 0, updatedAt: db.serverDate() } })
        if (!updated.stats || updated.stats.updated !== 1) throw Object.assign(new Error('迁移状态并发冲突。'), { code: 'FINALIZE_CONFLICT' })
        return { ok: true, completed: false, continue: true, stage: 'writing', finalizeCollectionIndex: 0, totalCollections: NAMES.length }
      }
      if (record.status === 'writing') {
        const index = Number(record.finalizeCollectionIndex || 0)
        if (!Number.isInteger(index) || index < 0 || index > NAMES.length) throw Object.assign(new Error('迁移写入进度无效。'), { code: 'INVALID_FINALIZE_PROGRESS' })
        if (index < NAMES.length) {
          const name = NAMES[index], writeResult = await ensureDocuments(name, groups[name])
          const nextIndex = index + 1, nextStatus = nextIndex === NAMES.length ? 'verifying' : 'writing'
          const updated = await migrations.where({ _id: lockId, ownerCoachId: owner, migrationId: sessionId, status: 'writing', finalizeCollectionIndex: index }).update({ data: { status: nextStatus, finalizeCollectionIndex: nextIndex, updatedAt: db.serverDate() } })
          if (!updated.stats || updated.stats.updated !== 1) throw Object.assign(new Error('迁移写入进度并发冲突。'), { code: 'FINALIZE_CONFLICT' })
          return { ok: true, completed: false, continue: true, stage: nextStatus, collection: name, finalizeCollectionIndex: nextIndex, totalCollections: NAMES.length, ...writeResult }
        }
      }
      if (record.status === 'verifying' || (record.status === 'writing' && Number(record.finalizeCollectionIndex) === NAMES.length)) {
        const verification = await verifyBusiness(owner, sessionId, record)
        if (!verification.valid) throw Object.assign(new Error('正式业务集合回读校验失败。'), { code: 'CLOUD_VERIFY_FAILED' })
        const updated = await migrations.where({ _id: lockId, ownerCoachId: owner, migrationId: sessionId, status: record.status }).update({ data: { status: 'completed', verification, completedAt: db.serverDate(), updatedAt: db.serverDate() } })
        if (!updated.stats || updated.stats.updated !== 1) throw Object.assign(new Error('迁移状态并发冲突。'), { code: 'FINALIZE_CONFLICT' })
        await db.collection('coaches').doc(owner).update({ data: { migrationVersion: 1, updatedAt: db.serverDate() } })
        return { ok: true, completed: true, idempotent: false, migrationId: sessionId, migrationVersion: 1, checksum: record.checksum, byteSize: record.byteSize, summary: record.summary, verification }
      }
      return { ok: false, code: 'INVALID_FINALIZE_STATUS', message: '迁移状态无法继续，请重新检查迁移。' }
    }
    if (action === 'abort') {
      if (record.status === 'completed') return { ok: false, code: 'COMPLETED_MIGRATION' }
      await removeUpload(owner, sessionId); await cleanup(owner, sessionId)
      await migrations.doc(lockId).update({ data: { status: 'failed', cleanupComplete: true, updatedAt: db.serverDate() } })
      return { ok: true }
    }
    return { ok: false, code: 'INVALID_ACTION', message: '不支持的迁移操作。' }
  } catch (error) {
    const sessionId = String(event && event.sessionId || '')
    if (sessionId && action !== 'finalize') { try { await cleanup(owner, sessionId); await removeUpload(owner, sessionId); await migrations.doc(lockIdFor(owner)).update({ data: { status: 'failed', failureCode: error.code || 'FAILED', cleanupComplete: true, updatedAt: db.serverDate() } }) } catch (cleanupError) {} }
    console.error('[chunk-migration]', error && (error.code || error.message) || 'UNKNOWN')
    return { ok: false, code: error.code || 'MIGRATION_FAILED', message: error.message || '迁移失败，本机数据未改变。' }
  }
}
