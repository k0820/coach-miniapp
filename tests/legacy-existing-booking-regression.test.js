// Stage 2 前已有正式 booking：旧 Cloud-primary submission 不能阻断新的持久 outbox。
const assert = require('assert')
const { createWorld, loadSessionPage, settle } = require('./helpers/local-first-world')
const pendingDraft = require('../utils/pending-training-draft')
const outbox = require('../utils/local-outbox')
const sync = require('../utils/sync-engine')

const scope = { environment: 'production', datasetId: 'ds-test' }
const bookingId = 'pre-stage2-booking'
const seed = () => ({
  students: [{ id: 'student-1', name: '假学员', status: 'active', packages: [{ id: 'package-1', type: '常规训练', price: 100, total: 8, used: 2, remaining: 6, status: 'active' }] }],
  bookings: [{ id: bookingId, studentId: 'student-1', studentName: '假学员', packageId: 'package-1', date: '2026-09-18', hour: 9, minute: 30, typeName: '常规训练', price: 100, status: 'booked', items: [], notes: '' }],
  incomes: [], sales: [], settings: {}, customExercises: []
})
const items = [
  { name: '高位下拉', group: '背', sets: 4, reps: 12, weight: 35 },
  { name: '划船', group: '背', sets: 3, reps: 10, weight: 40 }
]

async function main() {
  const world = createWorld()
  world.seed(seed())
  world.online = false
  // 升级前留下的旧 submission 没有可查 receipt；Stage 2 的本机草稿和队列才是当前事实。
  pendingDraft.write(scope.environment, scope.datasetId, bookingId, { items: [], notes: '旧草稿', category: '综合训练', duration: 60 })
  const legacy = pendingDraft.begin(scope.environment, scope.datasetId, bookingId, () => 'old-cloud-primary-request')
  pendingDraft.settle(scope.environment, scope.datasetId, bookingId, legacy.requestId, 'unknown')

  const page = loadSessionPage()
  page.onLoad({ id: bookingId })
  page.onShow()
  page.setData({ items, groupSections: [], notes: '本节新备注', category: '背部训练', duration: 60 })
  page.queueDraft()
  assert.deepStrictEqual(pendingDraft.get(scope.environment, scope.datasetId, bookingId).content.items, items, '第一帧写入本机草稿')
  const handle = await page.complete()
  const result = await handle.settled
  assert.strictEqual(result.code, 'COMPLETED_LOCAL_FIRST', `既有正式 booking 应本机先行完课，实际 ${result.code}`)
  const local = world.localDB()
  assert.deepStrictEqual(local.bookings[0].items, items)
  assert.strictEqual(local.bookings[0].status, 'done')
  assert.strictEqual(local.students[0].packages[0].used, 3)
  assert.strictEqual(local.students[0].packages[0].remaining, 5)
  assert.strictEqual(local.incomes.length, 1)
  assert.deepStrictEqual(outbox.list(scope).map(entry => entry.command), ['updateBookingContent', 'completeBooking'])
  assert.strictEqual(world.counters.modals.filter(modal => /课程未完成|待确认|没有同步/.test(String(modal.title))).length, 0)

  world.restartProcess()
  assert.strictEqual(world.localDB().bookings[0].status, 'done', '杀进程后投影仍在')
  world.online = true
  await sync.flush()
  await settle(80)
  const cloud = world.snapshot()
  assert.strictEqual(cloud.bookings[0].status, 'done')
  assert.deepStrictEqual(cloud.bookings[0].items, items)
  assert.strictEqual(cloud.students[0].packages[0].used, 3)
  assert.strictEqual(cloud.incomes.length, 1)
  assert.strictEqual(outbox.count(scope), 0)
  console.log('legacy existing booking regression: PASS')
}
main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1 })
