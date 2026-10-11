const assert = require('assert')
const {
  createBackupEnvelope,
  inspectBackupText,
  restoreClipboardBackup
} = require('../utils/local-backup')

const snapshot = label => ({
  students: [{ id: `student-${label}`, name: '测试学员', packages: [{ id: `package-${label}`, type: '常规训练', total: 10, used: 1, remaining: 9, price: 300 }] }],
  bookings: [{ id: `booking-${label}`, studentId: `student-${label}`, packageId: `package-${label}`, status: 'done', items: [] }],
  incomes: [{ id: `income-${label}`, bookingId: `booking-${label}`, studentId: `student-${label}`, amount: 300 }],
  sales: [{ id: `sale-${label}`, source: 'course', studentId: `student-${label}`, packageId: `package-${label}`, date: '2026-09-01', amount: 3000 }],
  customExercises: [{ name: '测试动作', group: '胸' }],
  settings: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 30, salesCommissionRate: 5 }
})

function memoryStorage(initial, behavior = {}) {
  const values = JSON.parse(JSON.stringify(initial))
  const writes = []
  return {
    writes,
    get(key) { return values[key] == null ? values[key] : JSON.parse(JSON.stringify(values[key])) },
    set(key, value) {
      writes.push(key)
      if (behavior.failSafety && key === 'coachDBRestoreSafetyBackup') throw new Error('storage full')
      values[key] = JSON.parse(JSON.stringify(value))
      if (behavior.corruptRestore && key === 'coachDB' && writes.filter(item => item === 'coachDB').length === 1) values[key].students[0].name = '损坏'
    }
  }
}

async function run() {
  assert.strictEqual(inspectBackupText('not-json').code, 'INVALID_JSON')
  assert.strictEqual(inspectBackupText('{}').ok, false)
  for (const key of ['students', 'bookings', 'incomes']) {
    const bad = snapshot('bad'); bad[key] = {}
    assert.strictEqual(inspectBackupText(JSON.stringify(bad)).ok, false)
  }

  const created = createBackupEnvelope(snapshot('cloud'), '2026-09-09T00:00:00.000Z')
  assert.strictEqual(created.ok, true)
  const legacyCourseSnapshot = snapshot('legacy-course')
  const legacyCourseSale = { id: 'sale-legacy-course', source: 'course', studentId: 'student-legacy-course', date: '2026-08-01', amount: 3000, typeName: '常规训练', note: '历史课程销售' }
  legacyCourseSnapshot.sales = [legacyCourseSale]
  const legacyCourseEnvelope = createBackupEnvelope(legacyCourseSnapshot, '2026-09-09T00:00:00.000Z')
  assert.strictEqual(legacyCourseEnvelope.ok, true)
  assert.deepStrictEqual(legacyCourseEnvelope.envelope.snapshot.sales[0], legacyCourseSale)
  assert.strictEqual(inspectBackupText(JSON.stringify(legacyCourseEnvelope.envelope)).ok, true)

  const badChecksum = JSON.parse(JSON.stringify(created.envelope)); badChecksum.checksum = '0'.repeat(64)
  assert.strictEqual(inspectBackupText(JSON.stringify(badChecksum)).code, 'CHECKSUM_MISMATCH')
  const badSize = JSON.parse(JSON.stringify(created.envelope)); badSize.byteSize += 1
  assert.strictEqual(inspectBackupText(JSON.stringify(badSize)).code, 'BYTE_SIZE_MISMATCH')

  let storage = memoryStorage({ coachDB: snapshot('old') })
  let result = await restoreClipboardBackup({ text: JSON.stringify(created.envelope), storage, confirm: async () => false })
  assert.strictEqual(result.code, 'CANCELLED_FIRST'); assert.deepStrictEqual(storage.writes, [])

  storage = memoryStorage({ coachDB: snapshot('old') })
  let confirmations = 0
  result = await restoreClipboardBackup({ text: JSON.stringify(created.envelope), storage, confirm: async () => ++confirmations === 1 })
  assert.strictEqual(result.code, 'CANCELLED_SECOND'); assert.deepStrictEqual(storage.writes, ['coachDBRestoreSafetyBackup'])

  storage = memoryStorage({ coachDB: snapshot('old') }, { failSafety: true })
  result = await restoreClipboardBackup({ text: JSON.stringify(created.envelope), storage, confirm: async () => true })
  assert.strictEqual(result.code, 'SAFETY_BACKUP_FAILED'); assert.strictEqual(storage.writes.includes('coachDB'), false)

  storage = memoryStorage({ coachDB: snapshot('old') })
  result = await restoreClipboardBackup({ text: JSON.stringify(created.envelope), storage, confirm: async () => true })
  assert.strictEqual(result.ok, true); assert.strictEqual(storage.get('coachDB').students[0].id, 'student-cloud')

  storage = memoryStorage({ coachDB: snapshot('old') }, { corruptRestore: true })
  result = await restoreClipboardBackup({ text: JSON.stringify(created.envelope), storage, confirm: async () => true })
  assert.strictEqual(result.code, 'RESTORE_FAILED_ROLLED_BACK'); assert.strictEqual(result.rolledBack, true); assert.strictEqual(storage.get('coachDB').students[0].id, 'student-old')

  storage = memoryStorage({ coachDB: snapshot('old') })
  result = await restoreClipboardBackup({ text: JSON.stringify(snapshot('legacy')), storage, confirm: async () => true })
  assert.strictEqual(result.ok, true); assert.strictEqual(result.legacy, true); assert.strictEqual(result.verified, false)

  storage = memoryStorage({ coachDB: snapshot('old') })
  result = await restoreClipboardBackup({ text: JSON.stringify(legacyCourseEnvelope.envelope), storage, confirm: async () => true })
  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(storage.get('coachDB').sales[0], legacyCourseSale)

  const damagedAssociation = snapshot('damaged-association')
  damagedAssociation.sales[0].packageId = { invalid: true }
  assert.strictEqual(createBackupEnvelope(damagedAssociation).ok, false)

  const source = restoreClipboardBackup.toString()
  assert.strictEqual(/wx\.cloud|callFunction|cloud\.database/.test(source), false)
  console.log('local-backup tests: PASS (17 scenarios)')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
