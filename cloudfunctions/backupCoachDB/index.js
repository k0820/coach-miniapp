const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const legacyBackups = db.collection('coach_db_backups')
const manifests = db.collection('coach_backup_manifests')
const chunksCollection = db.collection('coach_backup_chunks')
const COLLECTIONS = ['students', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const bytes = value => Buffer.byteLength(value, 'utf8')
const coachIdFor = openId => digest(`coach:${openId}`).slice(0, 32)
const legacyIdFor = openId => digest(`coach-db-backup:${openId}`).slice(0, 32)
const manifestIdFor = (coachId, version) => digest(`coach-backup:${coachId}:${version}`).slice(0, 32)
const chunkIdFor = (sessionId, collection, index) => digest(`coach-backup-chunk:${sessionId}:${collection}:${index}`).slice(0, 32)
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.keys(value).sort().reduce((out, key) => { out[key] = canonical(value[key]); return out }, {}) : value
const chunkJson = records => JSON.stringify(canonical(records))
function summaryDifferences(expected, actual) {
  const fields = {}
  const keys = new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})])
  ;[...keys].sort().forEach(key => {
    if (JSON.stringify(canonical(expected && expected[key])) !== JSON.stringify(canonical(actual && actual[key]))) fields[key] = { expected: expected && expected[key], actual: actual && actual[key] }
  })
  return fields
}

async function all(collection, filter) {
  const output = []
  for (let skip = 0; ; skip += 100) {
    const result = await collection.where(filter).skip(skip).limit(100).get()
    const page = result && result.data || []
    output.push(...page)
    if (page.length < 100) return output
  }
}

async function currentBackup(openId, coachId) {
  const legacyResult = await legacyBackups.where({ _id: legacyIdFor(openId), ownerOpenId: openId }).limit(1).get()
  const legacy = legacyResult.data && legacyResult.data[0]
  const completed = await all(manifests, { ownerCoachId: coachId, status: 'completed' })
  const newestManifest = completed.sort((a, b) => Number(b.backupVersion) - Number(a.backupVersion))[0]
  if (!newestManifest) return legacy || null
  if (!legacy || Number(newestManifest.backupVersion) >= Number(legacy.backupVersion || 0)) return newestManifest
  return legacy
}

function validateMeta(event) {
  if (event.protocolVersion !== 1 || event.backupFormatVersion !== 2 || event.schemaVersion !== 1) return '不支持的分块备份协议。'
  if (!/^[a-f0-9]{64}$/.test(String(event.checksum || ''))) return '完整快照 checksum 无效。'
  if (!Number.isInteger(Number(event.byteSize)) || Number(event.byteSize) < 2) return '完整快照 byteSize 无效。'
  if (!event.summary || typeof event.summary !== 'object' || Array.isArray(event.summary)) return '完整快照摘要无效。'
  if (!Number.isInteger(Number(event.totalChunks)) || Number(event.totalChunks) < COLLECTIONS.length) return '分块总数无效。'
  if (!event.collections || COLLECTIONS.some(name => !Number.isInteger(Number(event.collections[name])) || Number(event.collections[name]) < 1)) return '分块集合计划无效。'
  return ''
}

function parseEntries(entries) {
  const ordered = [], fragments = new Map()
  for (const entry of entries) {
    if (entry.kind === 'record' && typeof entry.json === 'string') ordered.push({ kind: 'record', value: JSON.parse(entry.json) })
    else if (entry.kind === 'fragment' && typeof entry.jsonPart === 'string' && Number.isInteger(entry.partIndex) && Number.isInteger(entry.totalParts)) {
      if (!fragments.has(entry.recordKey)) {
        const item = { total: entry.totalParts, parts: [] }
        fragments.set(entry.recordKey, item)
        ordered.push({ kind: 'fragment', item })
      }
      const item = fragments.get(entry.recordKey)
      if (item.total !== entry.totalParts || item.parts[entry.partIndex] != null) throw new Error('记录分片重复或不一致。')
      item.parts[entry.partIndex] = entry.jsonPart
    } else throw new Error('分块记录结构无效。')
  }
  fragments.forEach(item => {
    if (item.parts.length !== item.total || item.parts.some(part => typeof part !== 'string')) throw new Error('记录分片不完整。')
  })
  return ordered.map(item => item.kind === 'record' ? item.value : JSON.parse(item.item.parts.join('')))
}

function rebuild(chunkDocs) {
  const logical = Object.fromEntries(COLLECTIONS.map(name => [name, []]))
  for (const name of COLLECTIONS) {
    const group = chunkDocs.filter(chunk => chunk.collection === name).sort((a, b) => a.chunkIndex - b.chunkIndex)
    const expected = group[0] && group[0].totalChunks
    if (!expected || group.length !== expected || group.some((chunk, index) => chunk.chunkIndex !== index || chunk.totalChunks !== expected)) throw new Error(`${name} 分块不完整。`)
    const entries = []
    for (const chunk of group) {
      const json = chunkJson(chunk.records)
      if (digest(json) !== chunk.checksum || bytes(json) !== Number(chunk.byteSize)) throw new Error(`${name}[${chunk.chunkIndex}] 完整性失败。`)
      entries.push(...chunk.records)
    }
    logical[name].push(...parseEntries(entries))
  }
  const students = logical.students.sort((a, b) => a.sortIndex - b.sortIndex).map(item => ({ ...item.data, packages: [] }))
  const studentMap = new Map(students.map(student => [student.id, student]))
  logical.packages.sort((a, b) => a.studentSortIndex - b.studentSortIndex || a.sortIndex - b.sortIndex).forEach(item => {
    const student = studentMap.get(item.studentId)
    if (!student) throw new Error(`课时包 ${item.packageId || ''} 缺少关联学员。`)
    student.packages.push(item.data)
  })
  const ordered = name => logical[name].sort((a, b) => a.sortIndex - b.sortIndex).map(item => item.data)
  const settingRecord = logical.settings[0] || {}
  return { ...(settingRecord.rootExtras || {}), students, bookings: ordered('bookings'), incomes: ordered('incomes'), sales: ordered('sales'), settings: settingRecord.data || {}, customExercises: ordered('customExercises') }
}

function metadata(snapshot) {
  const json = JSON.stringify(canonical(snapshot)), students = snapshot.students, bookings = snapshot.bookings, incomes = snapshot.incomes, sales = snapshot.sales, customExercises = snapshot.customExercises
  return { checksum: digest(json), byteSize: bytes(json), summary: { students: students.length, packages: students.reduce((n, s) => n + s.packages.length, 0), bookings: bookings.length, completedBookings: bookings.filter(item => item.status === 'done').length, incomes: incomes.length, sales: sales.length, customExercises: customExercises.length, hasSettings: !!snapshot.settings, incomeAmount: Number(incomes.reduce((n, item) => n + Number(item.amount || 0), 0).toFixed(2)), salesAmount: Number(sales.reduce((n, item) => n + Number(item.amount || 0), 0).toFixed(2)) } }
}

async function removeSession(sessionId, coachId) {
  while (true) {
    const page = await chunksCollection.where({ sessionId, ownerCoachId: coachId }).limit(100).get()
    if (!page.data.length) break
    await Promise.all(page.data.map(item => chunksCollection.doc(item._id).remove()))
  }
}

exports.main = async event => {
  const openId = cloud.getWXContext().OPENID
  if (!openId) return { ok: false, code: 'NO_IDENTITY', message: '未能确认当前微信身份。' }
  const ownerCoachId = coachIdFor(openId), action = event && event.action
  try {
    if (action === 'start') {
      const error = validateMeta(event)
      if (error) return { ok: false, code: 'INVALID_PLAN', message: error }
      const expected = Number(event.expectedBackupVersion)
      if (!Number.isInteger(expected) || expected < 0) return { ok: false, code: 'INVALID_EXPECTED_VERSION', message: '缺少有效云端版本依据。' }
      const current = await currentBackup(openId, ownerCoachId), currentVersion = current ? Number(current.backupVersion || 0) : 0
      if (currentVersion !== expected) return { ok: false, code: 'VERSION_CONFLICT', currentBackupVersion: currentVersion, message: '云端备份已更新，请重新验证。' }
      const backupVersion = currentVersion + 1, sessionId = manifestIdFor(ownerCoachId, backupVersion)
      const existingResult = await manifests.where({ _id: sessionId, ownerCoachId }).limit(1).get(), existing = existingResult.data && existingResult.data[0]
      if (existing) {
        if (existing.checksum !== event.checksum || existing.status === 'failed') return { ok: false, code: 'SESSION_CONFLICT', message: '同版本上传会话与当前数据不一致。' }
        return { ok: true, sessionId, backupId: sessionId, backupVersion, completed: existing.status === 'completed' }
      }
      await manifests.add({ data: { _id: sessionId, ownerCoachId, backupVersion, backupFormatVersion: 2, protocolVersion: 1, schemaVersion: 1, checksumAlgorithm: 'sha256', checksum: event.checksum, byteSize: Number(event.byteSize), summary: event.summary, totalChunks: Number(event.totalChunks), collections: event.collections, status: 'uploading', createdAt: db.serverDate(), updatedAt: db.serverDate() } })
      return { ok: true, sessionId, backupId: sessionId, backupVersion, completed: false }
    }
    const sessionId = String(event && event.sessionId || '')
    if (!sessionId) return { ok: false, code: 'INVALID_SESSION', message: '缺少上传会话。' }
    const manifestResult = await manifests.where({ _id: sessionId, ownerCoachId }).limit(1).get(), manifest = manifestResult.data && manifestResult.data[0]
    if (!manifest) return { ok: false, code: 'SESSION_NOT_FOUND', message: '没有找到当前用户的上传会话。' }
    if (action === 'status') {
      const docs = await all(chunksCollection, { sessionId, ownerCoachId })
      return { ok: true, status: manifest.status, receivedChunks: docs.map(item => `${item.collection}:${item.chunkIndex}`) }
    }
    if (action === 'uploadChunk') {
      if (manifest.status !== 'uploading') return { ok: false, code: 'SESSION_CLOSED', message: '上传会话已关闭。' }
      const collection = String(event.collection || ''), chunkIndex = Number(event.chunkIndex), totalChunks = Number(event.totalChunks), records = event.records
      if (!COLLECTIONS.includes(collection) || !Number.isInteger(chunkIndex) || chunkIndex < 0 || totalChunks !== Number(manifest.collections[collection]) || !Array.isArray(records)) return { ok: false, code: 'INVALID_CHUNK', message: '分块参数无效。' }
      const json = chunkJson(records), checksum = digest(json), byteSize = bytes(json)
      if (checksum !== event.chunkChecksum || byteSize !== Number(event.chunkByteSize) || byteSize > 256 * 1024) return { ok: false, code: 'CHUNK_INTEGRITY_FAILED', message: '分块完整性或容量校验失败。' }
      const chunkId = chunkIdFor(sessionId, collection, chunkIndex), oldResult = await chunksCollection.where({ _id: chunkId, ownerCoachId }).limit(1).get(), old = oldResult.data && oldResult.data[0]
      if (old) return old.checksum === checksum && old.byteSize === byteSize ? { ok: true, reused: true } : { ok: false, code: 'CHUNK_CONFLICT', message: '同一分块编号内容不一致。' }
      await chunksCollection.add({ data: { _id: chunkId, sessionId, backupId: sessionId, ownerCoachId, backupVersion: manifest.backupVersion, collection, chunkIndex, totalChunks, checksum, byteSize, records, createdAt: db.serverDate() } })
      return { ok: true, reused: false }
    }
    if (action === 'finalize') {
      if (manifest.status === 'completed') return { ok: true, completed: true, backupVersion: manifest.backupVersion, schemaVersion: manifest.schemaVersion, checksum: manifest.checksum, byteSize: manifest.byteSize, summary: manifest.summary }
      const chunkDocs = await all(chunksCollection, { sessionId, ownerCoachId })
      if (chunkDocs.length !== Number(manifest.totalChunks)) return { ok: false, code: 'CHUNKS_MISSING', message: '分块尚未全部上传。' }
      const snapshot = rebuild(chunkDocs), actual = metadata(snapshot)
      const checksumMatches = actual.checksum === manifest.checksum
      const byteSizeMatches = actual.byteSize === Number(manifest.byteSize)
      const summaryFields = summaryDifferences(manifest.summary, actual.summary), summaryMatches = Object.keys(summaryFields).length === 0
      if (!checksumMatches || !byteSizeMatches || !summaryMatches) return { ok: false, code: 'FINAL_VERIFY_FAILED', message: '云端回读完整性校验失败。', differences: { checksum: { matches: checksumMatches, expected: manifest.checksum, actual: actual.checksum }, byteSize: { matches: byteSizeMatches, expected: Number(manifest.byteSize), actual: actual.byteSize }, summary: { matches: summaryMatches, fields: summaryFields } } }
      const updated = await manifests.where({ _id: sessionId, ownerCoachId, status: 'uploading' }).update({ data: { status: 'completed', completedAt: db.serverDate(), updatedAt: db.serverDate() } })
      if (!updated.stats || updated.stats.updated !== 1) return { ok: false, code: 'FINALIZE_CONFLICT', message: '备份状态已变化，未完成切换。' }
      return { ok: true, completed: true, backupVersion: manifest.backupVersion, backupFormatVersion: 2, schemaVersion: manifest.schemaVersion, checksum: manifest.checksum, byteSize: manifest.byteSize, summary: manifest.summary, updatedAt: new Date().toISOString() }
    }
    if (action === 'abort') {
      if (manifest.status === 'completed') return { ok: false, code: 'COMPLETED_BACKUP', message: '已完成备份不能作为失败会话清理。' }
      await removeSession(sessionId, ownerCoachId)
      await manifests.doc(sessionId).remove()
      return { ok: true }
    }
    return { ok: false, code: 'INVALID_ACTION', message: '不支持的操作。' }
  } catch (error) {
    console.error('[chunk-backup]', error && (error.code || error.message) || 'UNKNOWN')
    return { ok: false, code: 'BACKUP_FAILED', message: error && error.message || '分块备份失败。' }
  }
}
