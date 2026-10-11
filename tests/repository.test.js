const assert = require('assert')

const clone = value => JSON.parse(JSON.stringify(value))
const initial = {
  students: [],
  bookings: [],
  incomes: [],
  sales: [],
  settings: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 0, salesCommissionRate: 0 },
  customExercises: []
}
const values = { coachDB: clone(initial) }
const writes = []
global.wx = {
  getStorageSync(key) { return values[key] && clone(values[key]) },
  setStorageSync(key, value) { writes.push(key); values[key] = clone(value) }
}

const repository = require('../utils/repository')
repository.saveStudent({ id: 'student-1', name: '测试学员', packages: [] })
assert.strictEqual(repository.getStudents().length, 1)
repository.savePackage('student-1', { id: 'package-1', type: '常规训练', total: 10 })
assert.strictEqual(repository.getPackages('student-1')[0].id, 'package-1')
repository.saveBooking({ id: 'booking-1', studentId: 'student-1', packageId: 'package-1' })
repository.saveIncome({ id: 'income-1', bookingId: 'booking-1', amount: 100 })
repository.saveSale({ id: 'sale-1', studentId: 'student-1', packageId: 'package-1', amount: 1000 })
repository.saveSettings({ renewThreshold: 5 })
repository.saveCustomExercises([{ name: '测试动作', group: '胸' }])

assert.strictEqual(repository.getBookings()[0].packageId, 'package-1')
assert.strictEqual(repository.getIncomes()[0].bookingId, 'booking-1')
assert.strictEqual(repository.getSales()[0].id, 'sale-1')
assert.strictEqual(repository.getSettings().renewThreshold, 5)
assert.strictEqual(repository.getCustomExercises()[0].name, '测试动作')
assert.ok(writes.includes('coachDB'))
assert.ok(writes.includes('coachDBBackup'))

// ⭐ 2026-10-04 主包分包：低频诊断/救援页迁到 pkg-diag，审计覆盖面对齐搬迁前
const pageSources = ['../pages', '../pkg-diag'].flatMap(dir => require('fs').readdirSync(require('path').join(__dirname, dir), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .flatMap(entry => {
    const file = require('path').join(__dirname, dir, entry.name, `${entry.name}.js`)
    return require('fs').existsSync(file) ? [require('fs').readFileSync(file, 'utf8')] : []
  }))
assert.ok(pageSources.every(source => !source.includes('utils/repository')))
console.log('repository tests: PASS (13 checks)')
