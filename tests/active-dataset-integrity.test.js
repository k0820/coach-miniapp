const assert = require('assert')
const { buildCandidateDataset, integrity } = require('../utils/candidate-dataset')
const { reconstruct, fingerprint, classifyCompletionReceipts } = require('../cloudfunctions/readMyActiveCoachData/integrity')

const source = { students: [{ id: 's1', name: 'A', packages: [{ id: 'p1', type: '赠送课程', total: 2, used: 0, remaining: 2, price: 80, status: 'active' }] }], bookings: [{ id: 'b1', studentId: 's1', studentName: 'A', packageId: 'p1', typeName: '赠送课程', status: 'booked', price: 80, items: [] }], incomes: [], sales: [], settings: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 10, salesCommissionRate: 2 }, customExercises: [] }
const built = buildCandidateDataset(source, { trustedOwnerCoachId: 'owner', trustedDatasetId: 'dataset' })
const groups = { students: built.collections.students, student_tombstones: built.collections.studentTombstones, packages: built.collections.packages, bookings: built.collections.bookings, incomes: built.collections.incomes, sales: built.collections.sales, settings: built.collections.settings, customExercises: built.collections.customExercises }
const initial = fingerprint(reconstruct(groups))
assert.equal(initial.checksum, built.integrity.checksum)
assert.equal(initial.byteSize, built.integrity.byteSize)
assert.deepEqual(initial.summary, built.integrity.summary)

groups.bookings[0] = { ...groups.bookings[0], data: { ...groups.bookings[0].data, status: 'done', items: [{ name: '深蹲' }] } }
groups.packages[0] = { ...groups.packages[0], data: { ...groups.packages[0].data, used: 1, remaining: 1 } }
groups.incomes.push({ ownerCoachId: 'owner', datasetId: 'dataset', sortIndex: 0, incomeId: 'i1', bookingId: 'b1', studentId: 's1', data: { id: 'i1', bookingId: 'b1', studentId: 's1', amount: 80 } })
const currentSnapshot = reconstruct(groups), current = fingerprint(currentSnapshot), client = integrity(currentSnapshot)
assert.notEqual(current.checksum, built.integrity.checksum)
assert.equal(current.checksum, client.checksum)
assert.equal(current.byteSize, client.byteSize)
assert.deepEqual(current.summary, client.summary)
assert.equal(current.summary.completedBookings, 1)
assert.equal(current.summary.incomes, 1)
assert.strictEqual(classifyCompletionReceipts([]), 'A_COMMAND_NOT_SUCCEEDED')
assert.strictEqual(classifyCompletionReceipts([{ command: 'updateBookingContent', status: 'succeeded' }]), 'C_CONTENT_SAVED_NOT_COMPLETED')
assert.strictEqual(classifyCompletionReceipts([
  { command: 'updateBookingContent', status: 'succeeded' },
  { command: 'completeBooking', status: 'succeeded' }
]), 'B_COMMAND_SUCCEEDED_REFRESH_FAILED')
process.stdout.write('active dataset integrity tests: PASS (mutable revision fingerprint, activation baseline preserved)\n')
