const { sha256, utf8ByteLength } = require('./sha256')
const { canonicalize, migrationMetadata } = require('./cloud-migration')

const BACKUP_FORMAT_VERSION = 2
const CHUNK_PROTOCOL_VERSION = 1
const DEFAULT_MAX_CHUNK_BYTES = 192 * 1024
const MAX_FRAGMENT_BYTES = 64 * 1024
const MIN_CHUNK_BYTES = 8 * 1024
const COLLECTION_ORDER = ['students', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function chunkJson(records) { return JSON.stringify(canonicalize(records)) }

function recordKey(collection, record, index) {
  const data = record && record.data || {}
  return String(data.id || record.studentId || record.packageId || record.bookingId || record.incomeId || record.saleId || record.customExerciseId || `${collection}-${index}`)
}

function logicalRecords(snapshot) {
  const result = Object.fromEntries(COLLECTION_ORDER.map(name => [name, []]))
  ;(snapshot.students || []).forEach((student, studentIndex) => {
    const data = clone(student)
    const packages = Array.isArray(data.packages) ? data.packages : []
    delete data.packages
    result.students.push({ sortIndex: studentIndex, studentId: student.id, data })
    packages.forEach((pkg, sortIndex) => result.packages.push({ studentId: student.id, studentSortIndex: studentIndex, sortIndex, packageId: pkg.id, data: clone(pkg) }))
  })
  ;['bookings', 'incomes', 'sales'].forEach(collection => {
    ;(snapshot[collection] || []).forEach((data, sortIndex) => result[collection].push({ sortIndex, data: clone(data) }))
  })
  const known = new Set(['students', 'bookings', 'incomes', 'sales', 'settings', 'customExercises'])
  const rootExtras = {}
  Object.keys(snapshot).forEach(key => { if (!known.has(key)) rootExtras[key] = clone(snapshot[key]) })
  result.settings.push({ sortIndex: 0, data: clone(snapshot.settings || {}), rootExtras })
  ;(snapshot.customExercises || []).forEach((data, sortIndex) => result.customExercises.push({ sortIndex, data: clone(data) }))
  return result
}

function splitTextByUtf8(text, maxBytes) {
  const parts = []
  let current = ''
  let size = 0
  for (const char of text) {
    const charSize = utf8ByteLength(char)
    if (current && size + charSize > maxBytes) { parts.push(current); current = ''; size = 0 }
    current += char
    size += charSize
  }
  if (current || !parts.length) parts.push(current)
  return parts
}

function transportEntries(collection, records, maxFragmentBytes = MAX_FRAGMENT_BYTES) {
  const entries = []
  records.forEach((record, index) => {
    const json = JSON.stringify(record)
    if (utf8ByteLength(json) <= maxFragmentBytes) {
      entries.push({ kind: 'record', recordKey: recordKey(collection, record, index), json })
      return
    }
    const parts = splitTextByUtf8(json, maxFragmentBytes)
    const key = recordKey(collection, record, index)
    parts.forEach((jsonPart, partIndex) => entries.push({ kind: 'fragment', recordKey: key, partIndex, totalParts: parts.length, jsonPart }))
  })
  return entries
}

function buildChunks(snapshot, maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES) {
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < MIN_CHUNK_BYTES) throw new Error('分块容量配置过小。')
  const logical = logicalRecords(snapshot)
  const chunks = []
  COLLECTION_ORDER.forEach(collection => {
    const maxFragmentBytes = Math.min(MAX_FRAGMENT_BYTES, Math.max(1024, Math.floor(maxChunkBytes / 3)))
    const entries = transportEntries(collection, logical[collection], maxFragmentBytes)
    const groups = []
    let current = []
    for (const entry of entries) {
      const candidate = current.concat(entry)
      if (current.length && utf8ByteLength(chunkJson(candidate)) > maxChunkBytes) { groups.push(current); current = [entry] } else current = candidate
    }
    if (current.length || !groups.length) groups.push(current)
    groups.forEach((records, chunkIndex) => {
      const json = chunkJson(records)
      if (utf8ByteLength(json) > maxChunkBytes) {
        const label = collection === 'bookings' ? `booking ${records[0] && records[0].recordKey || ''}` : collection
        throw new Error(`${label} 无法安全分块。`)
      }
      chunks.push({ collection, chunkIndex, totalChunks: groups.length, chunkChecksum: sha256(json), chunkByteSize: utf8ByteLength(json), records })
    })
  })
  return chunks
}

function transferPlan(snapshot, maxChunkBytes) {
  const meta = migrationMetadata(snapshot)
  const chunks = buildChunks(snapshot, maxChunkBytes)
  return {
    protocolVersion: CHUNK_PROTOCOL_VERSION,
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: 1,
    ...meta,
    totalChunks: chunks.length,
    collections: Object.fromEntries(COLLECTION_ORDER.map(name => [name, chunks.filter(chunk => chunk.collection === name).length])),
    chunks
  }
}

function parseEntries(entries) {
  const ordered = []
  const fragments = new Map()
  entries.forEach(entry => {
    if (entry.kind === 'record') ordered.push({ kind: 'record', value: JSON.parse(entry.json) })
    else if (entry.kind === 'fragment') {
      if (!fragments.has(entry.recordKey)) {
        const item = { totalParts: entry.totalParts, parts: [] }
        fragments.set(entry.recordKey, item)
        ordered.push({ kind: 'fragment', item })
      }
      const item = fragments.get(entry.recordKey)
      if (item.totalParts !== entry.totalParts || item.parts[entry.partIndex] != null) throw new Error('记录分片重复或不一致。')
      item.parts[entry.partIndex] = entry.jsonPart
    } else throw new Error('未知分块记录类型。')
  })
  fragments.forEach(item => {
    if (item.parts.length !== item.totalParts || item.parts.some(part => typeof part !== 'string')) throw new Error('记录分片不完整。')
  })
  return ordered.map(item => item.kind === 'record' ? item.value : JSON.parse(item.item.parts.join('')))
}

function rebuildSnapshot(chunks) {
  const logical = Object.fromEntries(COLLECTION_ORDER.map(name => [name, []]))
  COLLECTION_ORDER.forEach(collection => {
    const collectionChunks = chunks.filter(chunk => chunk.collection === collection).sort((a, b) => a.chunkIndex - b.chunkIndex)
    const expected = collectionChunks[0] ? collectionChunks[0].totalChunks : 0
    if (!expected || collectionChunks.length !== expected || collectionChunks.some((chunk, index) => chunk.chunkIndex !== index || chunk.totalChunks !== expected)) throw new Error(`${collection} 分块不完整。`)
    const entries = []
    collectionChunks.forEach(chunk => {
      const json = chunkJson(chunk.records)
      if (sha256(json) !== chunk.chunkChecksum || utf8ByteLength(json) !== Number(chunk.chunkByteSize)) throw new Error(`${collection}[${chunk.chunkIndex}] 校验失败。`)
      entries.push(...chunk.records)
    })
    logical[collection].push(...parseEntries(entries))
  })
  const students = logical.students.sort((a, b) => a.sortIndex - b.sortIndex).map(record => ({ ...record.data, packages: [] }))
  const byId = new Map(students.map(student => [student.id, student]))
  logical.packages.sort((a, b) => a.studentSortIndex - b.studentSortIndex || a.sortIndex - b.sortIndex).forEach(record => {
    const student = byId.get(record.studentId)
    if (!student) throw new Error(`课时包 ${record.packageId || ''} 找不到学员。`)
    student.packages.push(record.data)
  })
  const ordered = name => logical[name].sort((a, b) => a.sortIndex - b.sortIndex).map(record => record.data)
  const settingRecord = logical.settings[0] || {}
  return { ...(settingRecord.rootExtras || {}), students, bookings: ordered('bookings'), incomes: ordered('incomes'), sales: ordered('sales'), settings: settingRecord.data || {}, customExercises: ordered('customExercises') }
}

function verifyRebuilt(snapshot, expected) {
  const actual = migrationMetadata(snapshot)
  return { ok: actual.checksum === expected.checksum && actual.byteSize === Number(expected.byteSize) && JSON.stringify(canonicalize(actual.summary)) === JSON.stringify(canonicalize(expected.summary)), actual }
}

module.exports = { BACKUP_FORMAT_VERSION, CHUNK_PROTOCOL_VERSION, DEFAULT_MAX_CHUNK_BYTES, MIN_CHUNK_BYTES, COLLECTION_ORDER, logicalRecords, buildChunks, transferPlan, rebuildSnapshot, verifyRebuilt, chunkJson }
