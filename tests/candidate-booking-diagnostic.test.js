const assert = require('assert')
const { analyzeHistoricalBookings } = require('../utils/candidate-booking-diagnostic')

const source = () => ({
  students: [
    { id: 'active', packages: [{ id: 'p-active', status: 'active' }, { id: 'p-income', status: 'reversed' }] },
    { id: 'deleted', status: 'deleted', packages: [{ id: 'p-deleted', status: 'reversed' }] }
  ],
  bookings: [
    { id: 'a', status: 'done', studentId: 'active', packageId: 'p-active', typeName: '常规训练', date: '2026-09-01', items: [{ name: '深蹲' }] },
    { id: 'b', status: 'done', packageId: 'p-deleted', studentName: '历史学员' },
    { id: 'c', status: 'done', studentId: 'active', studentName: '历史', typeName: '常规训练' },
    { id: 'd', status: 'done', studentId: 'active', packageId: 'missing' },
    { id: 'e', status: 'done', studentId: 'active', packageId: 'p-active' },
    { id: 'f', status: 'booked', studentId: 'active', packageId: 'missing' },
    { id: 'g', status: 'done', studentId: 'active' }
  ],
  incomes: [
    { id: 'ia', bookingId: 'a', studentId: 'active' },
    { id: 'ib', bookingId: 'b', studentId: 'deleted' },
    { id: 'ic', bookingId: 'c', studentId: 'active' },
    { id: 'id', bookingId: 'd', studentId: 'active' },
    { id: 'ie1', bookingId: 'e', studentId: 'active' }, { id: 'ie2', bookingId: 'e', studentId: 'active' },
    { id: 'ig', bookingId: 'g', studentId: 'active', packageId: 'p-income' },
    { id: 'orphan-income', bookingId: 'missing-booking', studentId: 'active' }
  ]
})

const input = source(), before = JSON.stringify(input), result = analyzeHistoricalBookings(input), byId = id => result.records.find(item => item.bookingId === id)
assert.strictEqual(JSON.stringify(input), before)
assert.strictEqual(byId('a').category, 'A')
assert.strictEqual(byId('b').category, 'B'); assert.strictEqual(byId('b').deterministicRepairs[0].value, 'deleted')
assert.strictEqual(byId('c').category, 'C'); assert.ok(byId('c').reasons.some(item => item.code === 'PACKAGE_ID_MISSING'))
assert.strictEqual(byId('d').category, 'C'); assert.ok(byId('d').reasons.some(item => item.code === 'PACKAGE_NOT_FOUND'))
assert.strictEqual(byId('e').category, 'D'); assert.ok(byId('e').reasons.some(item => item.code === 'DONE_INCOME_AMBIGUOUS'))
assert.strictEqual(byId('f').category, 'D')
assert.strictEqual(byId('g').category, 'B'); assert.ok(byId('g').deterministicRepairs.some(item => item.field === 'packageId' && item.value === 'p-income'))
assert.deepStrictEqual(result.counts, { A: 1, B: 2, C: 2, D: 2 })
assert.deepStrictEqual(result.orphanIncomes, [{ incomeId: 'orphan-income', bookingId: 'missing-booking', studentId: 'active', reason: 'INCOME_BOOKING_NOT_FOUND' }])
console.log('candidate booking diagnostic tests: PASS (A/B/C/D, deleted student, missing package, income evidence, ambiguity, immutable source)')
