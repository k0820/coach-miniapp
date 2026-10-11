const assert = require('assert')
const { findLegacyOrphanBooking } = require('../utils/legacy-orphan-locator')

const snapshot = {
  bookings: [
    { id: 'normal', status: 'done', studentName: '正常学员' },
    { id: 'legacy-1', status: 'done', date: '2026-01-02', hour: 9, minute: 5, studentName: '历史学员', typeName: '常规训练', legacyRelationStatus: 'orphan', legacyRelationReason: 'package_missing' }
  ]
}
const before = JSON.stringify(snapshot)
assert.deepEqual(findLegacyOrphanBooking(snapshot), { bookingId: 'legacy-1', date: '2026-01-02', time: '09:05', studentName: '历史学员', typeName: '常规训练', status: 'done', legacyRelationReason: 'package_missing' })
assert.equal(JSON.stringify(snapshot), before)
assert.equal(findLegacyOrphanBooking({ bookings: [] }), null)
assert.equal(findLegacyOrphanBooking(null), null)
process.stdout.write('legacy orphan locator tests: PASS (read-only, exact marker, immutable snapshot)\n')
