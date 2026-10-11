const { migrationMetadata, canonicalize } = require('./cloud-migration')

const COLLECTIONS = ['students', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']

function base64Bytes(value) {
  if (typeof wx !== 'undefined' && wx.base64ToArrayBuffer) return new Uint8Array(wx.base64ToArrayBuffer(value))
  return new Uint8Array(Buffer.from(value, 'base64'))
}

function utf8Decode(bytes) {
  let output = '', index = 0
  while (index < bytes.length) {
    const first = bytes[index++]
    if (first < 0x80) output += String.fromCharCode(first)
    else if (first < 0xe0) output += String.fromCharCode(((first & 31) << 6) | (bytes[index++] & 63))
    else if (first < 0xf0) output += String.fromCharCode(((first & 15) << 12) | ((bytes[index++] & 63) << 6) | (bytes[index++] & 63))
    else {
      const point = ((first & 7) << 18) | ((bytes[index++] & 63) << 12) | ((bytes[index++] & 63) << 6) | (bytes[index++] & 63)
      const adjusted = point - 0x10000
      output += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 1023))
    }
  }
  return output
}

function joinBytes(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0), output = new Uint8Array(length)
  let offset = 0
  parts.forEach(part => { output.set(part, offset); offset += part.length })
  return output
}

function rebuildCloudSnapshot(groups) {
  const students = groups.students.slice().sort((a, b) => a.sortIndex - b.sortIndex).map(item => ({ ...item.data, packages: [] }))
  const studentsById = new Map(students.map(student => [student.id, student]))
  groups.packages.slice().sort((a, b) => a.studentSortIndex - b.studentSortIndex || a.sortIndex - b.sortIndex).forEach(item => {
    const student = studentsById.get(item.studentId)
    if (!student) throw new Error(`云端课时包 ${item.packageId || '-'} 缺少关联学员。`)
    student.packages.push(item.data)
  })
  const ordered = name => groups[name].slice().sort((a, b) => a.sortIndex - b.sortIndex).map(item => item.data)
  const settingRecord = groups.settings[0] || {}
  return { ...(settingRecord.rootExtras || {}), students, bookings: ordered('bookings'), incomes: ordered('incomes'), sales: ordered('sales'), settings: settingRecord.data || {}, customExercises: ordered('customExercises') }
}

function same(valueA, valueB) {
  return JSON.stringify(canonicalize(valueA)) === JSON.stringify(canonicalize(valueB))
}

function orderView(snapshot) {
  const fallback = value => JSON.stringify(canonicalize(value))
  return {
    students: snapshot.students.map(item => item.id || fallback(item)),
    packages: snapshot.students.map(student => ({ studentId: student.id || '', ids: (student.packages || []).map(item => item.id || fallback(item)) })),
    bookings: snapshot.bookings.map(item => item.id || fallback(item)),
    incomes: snapshot.incomes.map(item => item.id || fallback(item)),
    sales: snapshot.sales.map(item => item.id || fallback(item)),
    customExercises: snapshot.customExercises.map(item => item.id || fallback(item))
  }
}

function relationView(snapshot) {
  return {
    packages: snapshot.students.flatMap(student => (student.packages || []).map(item => [student.id || '', item.id || '', item.saleId || ''])),
    bookings: snapshot.bookings.map(item => [item.id || '', item.studentId || '', item.packageId || '']),
    incomes: snapshot.incomes.map(item => [item.id || '', item.bookingId || '', item.studentId || '']),
    sales: snapshot.sales.map(item => [item.id || '', item.studentId || '', item.packageId || ''])
  }
}

function compareSummary(expected, actual) {
  const keys = [...new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})])]
  return keys.filter(key => !same(expected && expected[key], actual && actual[key])).map(key => ({ key, expected: expected && expected[key], actual: actual && actual[key] }))
}

function compareCloudAndLocal(cloudSnapshot, localSnapshot, expectedMetadata) {
  const cloud = migrationMetadata(cloudSnapshot), local = migrationMetadata(localSnapshot)
  const summaryDifferences = compareSummary(local.summary, cloud.summary)
  const expectedSummaryDifferences = compareSummary(expectedMetadata.summary, cloud.summary)
  const cloudIntegrity = cloud.checksum === expectedMetadata.checksum && cloud.byteSize === Number(expectedMetadata.byteSize) && expectedSummaryDifferences.length === 0
  return {
    cloudIntegrity,
    localMatchesCloud: cloud.checksum === local.checksum && cloud.byteSize === local.byteSize && summaryDifferences.length === 0,
    checksum: { expected: expectedMetadata.checksum, cloud: cloud.checksum, local: local.checksum, cloudMatchesExpected: cloud.checksum === expectedMetadata.checksum, localMatchesCloud: local.checksum === cloud.checksum },
    byteSize: { expected: Number(expectedMetadata.byteSize), cloud: cloud.byteSize, local: local.byteSize, cloudMatchesExpected: cloud.byteSize === Number(expectedMetadata.byteSize), localMatchesCloud: local.byteSize === cloud.byteSize },
    summary: { expectedDifferences: expectedSummaryDifferences, localDifferences: summaryDifferences, cloud: cloud.summary, local: local.summary },
    orderMatches: same(orderView(cloudSnapshot), orderView(localSnapshot)),
    relationMatches: same(relationView(cloudSnapshot), relationView(localSnapshot))
  }
}

async function readMyCoachCloudSnapshot({ call, onProgress }) {
  const metadata = await call('readMyCoachCloudData', { action: 'metadata' })
  if (!metadata || !metadata.ok || !metadata.ownerVerified) return metadata || { ok: false, code: 'INVALID_METADATA', message: '云端未返回可信迁移信息。' }
  const groups = Object.fromEntries(COLLECTIONS.map(name => [name, []]))
  for (let collectionIndex = 0; collectionIndex < COLLECTIONS.length; collectionIndex++) {
    const collection = COLLECTIONS[collectionIndex]
    let cursor = 0, fragmentIndex = 0, fragmentParts = [], guard = 0
    while (guard++ < 10000) {
      const result = await call('readMyCoachCloudData', { action: 'page', collection, cursor, fragmentIndex })
      if (!result || !result.ok) return result || { ok: false, code: 'PAGE_READ_FAILED', message: `${collection} 读取失败。` }
      if (result.payload) {
        const bytes = base64Bytes(result.payload)
        if (result.encoding === 'base64-fragment') {
          fragmentParts[result.fragmentIndex] = bytes
          if (result.nextCursor > cursor) {
            if (fragmentParts.length !== result.totalFragments || fragmentParts.some(part => !part)) throw new Error(`${collection} 超大记录分片不完整。`)
            groups[collection].push(JSON.parse(utf8Decode(joinBytes(fragmentParts))))
            fragmentParts = []
          }
        } else groups[collection].push(...JSON.parse(utf8Decode(bytes)))
      }
      cursor = Number(result.nextCursor)
      fragmentIndex = Number(result.nextFragmentIndex || 0)
      if (onProgress) onProgress(collectionIndex + 1, COLLECTIONS.length, collection, cursor)
      if (result.done) break
    }
    if (guard >= 10000) throw new Error(`${collection} 分页读取未能正常结束。`)
  }
  const snapshot = rebuildCloudSnapshot(groups)
  return { ok: true, metadata, snapshot, actual: migrationMetadata(snapshot) }
}

module.exports = { COLLECTIONS, utf8Decode, rebuildCloudSnapshot, compareCloudAndLocal, readMyCoachCloudSnapshot }
