const assert = require('assert')
const { deleteStudentAligned, validateBookingCreation, rescheduleBookingAligned, deleteCompletedBookingAligned } = require('../utils/local-business-rules')

const copy = value => JSON.parse(JSON.stringify(value))
function base() {
  return {
    students: [{ id: 's1', name: '张三', packages: [{ id: 'p1', type: '常规训练', total: 10, used: 2, remaining: 8, status: 'active', saleId: 'sale1' }, { id: 'gift1', type: '赠送课程', total: 3, used: 0, remaining: 3, price: 80, status: 'active' }] }],
    bookings: [{ id: 'done1', studentId: 's1', packageId: 'p1', status: 'done', items: [{ name: '卧推' }], notes: '历史' }, { id: 'future1', studentId: 's1', packageId: 'p1', status: 'booked' }],
    incomes: [{ id: 'income1', bookingId: 'done1', studentId: 's1', amount: 400 }],
    sales: [{ id: 'sale1', source: 'course', studentId: 's1', packageId: 'p1', status: 'active' }, { id: 'manual1', source: 'manual', studentId: 's1', amount: 100 }], settings: {}, customExercises: []
  }
}

let db = base(), result = deleteStudentAligned(db, 's1', 123)
assert.equal(result.ok, true); assert.equal(db.students[0].status, 'deleted'); assert.equal(db.students[0].packages[0].status, 'reversed'); assert.equal(db.students[0].packages[0].remaining, 0); assert.equal(db.students[0].packages[0].used, 2)
assert.equal(db.sales[0].status, 'reversed'); assert.equal(db.sales[1].source, 'manual'); assert.equal(db.bookings.length, 1); assert.equal(db.bookings[0].studentName, '张三'); assert.equal(db.incomes[0].studentName, '张三')

db = base(); assert.equal(validateBookingCreation(db, 's1', 'p1').ok, true); db.students[0].packages[0].remaining = 0; assert.equal(validateBookingCreation(db, 's1', 'p1').code, 'PACKAGE_NO_REMAINING'); db.students[0].packages[0].remaining = 5; db.students[0].packages[0].status = 'reversed'; assert.equal(validateBookingCreation(db, 's1', 'p1').code, 'PACKAGE_UNAVAILABLE')

db = base(); result = rescheduleBookingAligned(db, 'done1', { date: '2026-09-20', hour: 11, minute: 30 }, () => '新总结'); assert.equal(result.ok, true); assert.equal(db.incomes[0].date, '2026-09-20'); assert.equal(db.incomes[0].time, '11:30'); assert.equal(db.incomes[0].amount, 400)
db = base(); db.incomes.push({ id: 'income2', bookingId: 'done1', amount: 999 }); assert.equal(rescheduleBookingAligned(db, 'done1', { date: '2026-09-20', hour: 11, minute: 30 }).code, 'INCOME_RELATION_AMBIGUOUS'); assert.equal(db.bookings[0].date, undefined)

for (const mode of ['active', 'reversed', 'missing']) {
  db = base(); db.bookings = [db.bookings[0]]; if (mode === 'missing') db.students[0].packages = []; else { db.students[0].packages[0].status = mode; if (mode === 'reversed') db.students[0].packages[0].remaining = 0 }
  result = deleteCompletedBookingAligned(db, 'done1'); assert.equal(result.ok, true); assert.equal(db.bookings.length, 0); assert.equal(db.incomes.length, 0)
  if (mode === 'active') { assert.equal(db.students[0].packages[0].used, 1); assert.equal(db.students[0].packages[0].remaining, 9) }
  if (mode === 'reversed') { assert.equal(db.students[0].packages[0].used, 1); assert.equal(db.students[0].packages[0].remaining, 0) }
}
db = base(); db.bookings = [db.bookings[0]]; db.students[0].packages[0].used = 0; assert.equal(deleteCompletedBookingAligned(db, 'done1').code, 'PACKAGE_USAGE_INVALID'); assert.equal(db.bookings.length, 1); assert.equal(db.incomes.length, 1)
db = base(); db.bookings = [db.bookings[0]]; db.incomes.push({ id: 'income2', bookingId: 'done1' }); assert.equal(deleteCompletedBookingAligned(db, 'done1').code, 'INCOME_RELATION_AMBIGUOUS')

const stored = { students: [{ id: 's', packages: [{ id: 'p', type: '力量训练', total: 2, used: 0 }] }], bookings: [], incomes: [], settings: {} }, writes = []
global.wx = { getStorageSync: () => copy(stored), setStorageSync: (...args) => writes.push(args) }
delete require.cache[require.resolve('../utils/db')]
const loaded = require('../utils/db').getDB()
assert.equal(loaded.students[0].packages[0].type, '常规训练'); assert.equal(loaded.students[0].packages[0].remaining, 2); assert.equal(writes.length, 0); assert.deepEqual(stored.students[0].packages[0], { id: 'p', type: '力量训练', total: 2, used: 0 })

const studentSource = require('fs').readFileSync(require.resolve('../pages/students/students.js'), 'utf8')
assert(!studentSource.includes('if(changed)saveDB(db)')); assert(studentSource.includes('db.students.filter(currentStudent)'))

console.log('local rule alignment tests: PASS')
