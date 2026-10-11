const assert = require('assert')
const { createWorld, settle } = require('./helpers/local-first-world')
const empty = () => ({ students: [], bookings: [], incomes: [], sales: [], settings: { renewThreshold: 3 }, customExercises: [] })
const input = key => ({ draftKey: key, name: '隔离故障学员', phone: '', packages: [{
  command: 'createCourseSale', clientKey: 'course-1', payload: {
    type: '常规训练', total: 20, remaining: 17, unitPrice: 300, amount: 5800,
    quantity: 20, date: '2026-09-21'
  }
}] })
async function run() {
  // Five-second cloud hold, offline restart, lost response, partial success and
  // failed readback all use the real local Outbox/Projection/Sync modules.
  const world = createWorld()
  world.seed(empty())
  world.memoryRevision = 0
  world.online = false
  let mutate = require('../utils/mutate')
  const start = Date.now()
  const first = await mutate.createStudentWithPackages(input('fault-draft'))
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.ok(Date.now() - start < 250, 'offline save cannot await Cloud')
  assert.equal(world.localDB().students.length, 1)
  assert.equal(world.localDB().students[0].packages[0].remaining, 17)
  assert.equal(world.localDB().sales[0].amount, 5800)
  assert.equal(world.snapshot().students.length, 0)
  assert.equal(world.outboxEntries().length, 2)
  const requestIds = world.outboxEntries().map(row => row.requestId)
  const repeated = await mutate.createStudentWithPackages(input('fault-draft'))
  assert.equal(repeated.duplicate, true)
  assert.deepEqual(world.outboxEntries().map(row => row.requestId), requestIds)
  assert.equal((await mutate.createStudentWithPackages({ ...input('fault-draft'), name: '另一个名字' })).code, 'REQUEST_ID_CONFLICT')

  world.restartProcess()
  mutate = require('../utils/mutate')
  assert.equal(world.localDB().students.length, 1, 'restart keeps the entire local purchase')
  assert.deepEqual(world.outboxEntries().map(row => row.requestId), requestIds)
  world.online = true
  world.dropResponse = 2
  world.failRefresh = 1
  await require('../utils/sync-engine').resume()
  await settle(60)
  assert.equal(world.snapshot().students.length, 1)
  assert.equal(world.snapshot().students[0].packages.length, 1)
  assert.equal(world.snapshot().sales.length, 1)
  assert.equal(world.snapshot().sales[0].amount, 5800)
  assert.equal(world.outboxEntries().length, 0)
  assert.equal(world.localDB().students.length, 1)
  assert.equal(world.localDB().students[0].packages[0].remaining, 17)
  assert.deepEqual(world.outboxEntries().map(row => row.requestId), [])
  assert.ok(world.counters.receipts >= 2, 'student and sale lost responses must both be resolved through their original receipts')
  world.restoreUi()

  const large = createWorld()
  const students = Array.from({ length: 36 }, (_, i) => ({ id: `historic-student-${i}`, name: `历史学员${i}`, packages: [{ id: `historic-package-${i}`, studentId: `historic-student-${i}`, type: '常规训练', total: 20, used: 4, remaining: 16, status: 'active', price: 300 }] }))
  const bookings = Array.from({ length: 146 }, (_, i) => ({ id: `historic-booking-${i}`, studentId: `historic-student-${i % 36}`, packageId: `historic-package-${i % 36}`, status: i < 144 ? 'done' : 'booked', date: '2026-09-01', items: [{ name: '历史动作', sets: 3 }] }))
  const incomes = bookings.slice(0, 144).map((row, i) => ({ id: `historic-income-${i}`, bookingId: row.id, studentId: row.studentId, amount: 300, date: row.date }))
  large.seed({ students, bookings, incomes, sales: Array.from({ length: 47 }, (_, i) => ({ id: `historic-sale-${i}`, source: 'manual', amount: 500, date: '2026-09-01' })), settings: { renewThreshold: 3 }, customExercises: [] })
  large.memoryRevision = 0
  large.online = false
  const added = await require('../utils/mutate').createStudentWithPackages(input('large-history'))
  assert.equal(added.ok, true, JSON.stringify(added))
  assert.equal(large.localDB().students.length, 37)
  assert.equal(large.localDB().bookings.length, 146)
  assert.equal(large.localDB().incomes.length, 144)
  assert.equal(large.localDB().sales.length, 48)
  assert.equal(large.snapshot().students.length, 36, 'large historical cloud fixture is never written while offline')
  large.restoreUi()

  const partial = createWorld()
  partial.seed(empty())
  partial.memoryRevision = 0
  const originalExecute = partial.adapter.execute
  let cutAfterStudent = false
  partial.adapter.execute = async (command, payload, options) => {
    if (command === 'createCourseSale' && !cutAfterStudent) { cutAfterStudent = true; partial.online = false }
    return originalExecute(command, payload, options)
  }
  assert.equal((await require('../utils/mutate').createStudentWithPackages(input('partial-sale'))).ok, true)
  await settle(30)
  assert.equal(partial.snapshot().students.length, 1, 'student may reach Cloud before the sale')
  assert.equal(partial.snapshot().sales.length, 0)
  assert.equal(partial.outboxEntries().length, 1, 'only the unfinished sale remains queued')
  assert.equal(partial.localDB().students.length, 1)
  assert.equal(partial.localDB().sales.length, 1, 'local projection keeps the intended sale after student ID mapping')
  partial.adapter.execute = originalExecute
  await partial.restoreNetwork()
  await settle(30)
  assert.equal(partial.snapshot().students.length, 1)
  assert.equal(partial.snapshot().sales.length, 1)
  assert.equal(partial.outboxEntries().length, 0)
  partial.restoreUi()
  console.log('student local-first faults PASS: offline, restart, duplicate, response loss, receipt, failed readback')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
