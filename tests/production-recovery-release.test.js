const assert = require('assert')
const { createWorld, loadSessionPage, settle } = require('./helpers/local-first-world')
const guard = require('../utils/production-recovery-guard')
const inspector = require('../utils/production-recovery-inspect')
const readiness = require('../utils/production-recovery-readiness')
const outbox = require('../utils/local-outbox')
const sync = require('../utils/sync-engine')
const bookingId = 'existing-production-style-booking'
const scope = { environment: 'production', datasetId: 'ds-test' }
const seed = () => ({ students: [{ id: 'student-fake', name: '假学员', status: 'active', packages: [{ id: 'package-exact', type: '训练', price: 100, total: 114, used: 5, remaining: 109, status: 'active' }] }], bookings: [{ id: bookingId, studentId: 'student-fake', studentName: '假学员', packageId: 'package-exact', status: 'booked', date: '2026-09-18', hour: 9, minute: 30, typeName: '训练', price: 100, items: [], notes: '' }], incomes: [], sales: [], settings: {}, customExercises: [] })
function cloud(world) { return { ok: true, strict: true, state: 'A_BOTH_COMMANDS_NOT_SUCCEEDED', datasetId: scope.datasetId, dataRevision: world.revision(), booking: { bookingId, status: 'booked', packageId: 'package-exact', items: [] }, package: { packageId: 'package-exact', status: 'active', used: 5, remaining: 109 }, incomes: [], receipts: [] } }
async function main() {
  const world = createWorld(); world.seed(seed()); world.online = false
  guard.arm(); guard.enter(); guard.select(bookingId, scope.datasetId)
  let local = inspector.inspectLocal(bookingId)
  const before = JSON.stringify(world.snapshot())
  const beforeQueue = JSON.stringify(outbox.list(scope))
  assert.equal(readiness.check({ bookingId, hold: guard.held(), local, cloud: cloud(world) }).ready, true)
  for (const changed of [
    { ...cloud(world), state: 'C_CONTENT_SUCCEEDED_COMPLETE_NOT_SUCCEEDED' },
    { ...cloud(world), incomes: [{ amount: 100 }] },
    { ...cloud(world), receipts: [{ command: 'completeBooking', status: 'processing' }] },
    { ...cloud(world), package: { ...cloud(world).package, remaining: 0 } },
    { ...cloud(world), datasetId: 'another-dataset' }
  ]) assert.equal(readiness.check({ bookingId, hold: guard.held(), local, cloud: changed }).ready, false)
  assert.equal(readiness.check({ bookingId, hold: guard.held(), local: { ...local, entries: [{ command: 'completeBooking' }] }, cloud: cloud(world) }).ready, false)
  assert.equal(readiness.check({ bookingId, hold: guard.held(), local: { ...local, draft: { items: [] } }, cloud: cloud(world) }).ready, false)
  assert.equal((await sync.resume()).code, 'PRODUCTION_RECOVERY_READ_ONLY')
  assert.equal(JSON.stringify(world.snapshot()), before)
  assert.equal(JSON.stringify(outbox.list(scope)), beforeQueue)
  const calls = []
  wx.cloud.callFunction = async ({ name, data }) => {
    calls.push({ name, action: data.action })
    if (name === 'diagnoseCoachCompletion' && data.action === 'diagnose') return { result: cloud(world) }
    throw new Error('恢复解除流程不得调用写云函数')
  }
  wx.showModal = ({ success }) => success({ confirm: true })
  let definition
  global.Page = value => { definition = value }
  require('../pkg-diag/production-recovery-diagnostic/production-recovery-diagnostic.js')
  delete global.Page
  const diagnostic = { data: { ...definition.data }, setData(patch) { Object.assign(this.data, patch) } }
  for (const [key, value] of Object.entries(definition)) if (typeof value === 'function') diagnostic[key] = value.bind(diagnostic)
  await diagnostic.onLoad()
  await diagnostic.releaseForRecovery()
  assert.equal(diagnostic.data.released, true)
  assert.equal(calls.length, 3, '初查 + 确认前/后两次只读重查')
  assert(calls.every(row => row.name === 'diagnoseCoachCompletion' && row.action === 'diagnose'))
  assert.equal(guard.held(), null)
  assert.equal(guard.released().bookingId, bookingId)
  assert.equal(guard.blocksBusiness('production'), false)
  assert.equal(guard.blocksEntry(scope, { payload: { bookingId } }), false)
  diagnostic.onUnload(); guard.arm()
  assert.equal(guard.inspectingNow(), false, '重开默认不再冻结全部 Production')
  assert.equal(JSON.stringify(world.snapshot()), before, '解除冻结只写安全 metadata')

  const items = [{ name: '高位下拉', sets: 4, reps: 12, weight: 35 }]
  const page = loadSessionPage(); page.onLoad({ id: bookingId }); page.onShow()
  page.setData({ items, groupSections: [], notes: '重新录入的真实流程模拟', category: '训练', duration: 60 })
  page.queueDraft()
  const handle = await page.complete(); const result = await handle.settled
  assert.equal(result.code, 'COMPLETED_LOCAL_FIRST')
  assert.deepStrictEqual(outbox.list(scope).map(row => row.command), ['updateBookingContent', 'completeBooking'])
  world.online = true; await sync.flush(); await settle(80)
  const final = world.snapshot()
  assert.equal(final.bookings[0].id, bookingId, '保持原 bookingId')
  assert.equal(final.bookings[0].status, 'done')
  assert.deepStrictEqual(final.bookings[0].items, items)
  assert.equal(final.students[0].packages[0].used, 6)
  assert.equal(final.students[0].packages[0].remaining, 108)
  assert.equal(final.incomes.length, 1)
  assert.equal(outbox.count(scope), 0)
  console.log('production recovery release: PASS')
}
main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1 })
