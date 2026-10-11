const assert = require('assert')
const { createWorld, loadSessionPage } = require('./helpers/local-first-world')
const mutate = require('../utils/mutate')
const sync = require('../utils/sync-engine')
const guard = require('../utils/production-recovery-guard')
const inspect = require('../utils/production-recovery-inspect')
const outbox = require('../utils/local-outbox')

const scope = { environment: 'production', datasetId: 'ds-test' }
const target = 'old-booking'
const seed = () => ({ students: [{ id: 'fake-student', name: '假学员', status: 'active', packages: [{ id: 'exact-package', type: '常规训练', price: 100, total: 8, used: 1, remaining: 7, status: 'active' }] }], bookings: [
  { id: 'other-booking', studentId: 'fake-student', studentName: '假学员', packageId: 'exact-package', date: '2026-09-18', hour: 8, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: [] },
  { id: target, studentId: 'fake-student', studentName: '假学员', packageId: 'exact-package', date: '2026-09-18', hour: 9, minute: 30, typeName: '常规训练', price: 100, status: 'booked', items: [] }
], incomes: [], sales: [], settings: {}, customExercises: [] })

async function main() {
  const world = createWorld()
  world.seed(seed())
  world.online = false
  // 新体验版启动前的旧 Production 队列。顺序：其他正常课程 → 目标课程。
  assert((await mutate('updateBookingContent', { bookingId: 'other-booking', notes: '正常课程' })).ok)
  assert((await mutate('updateBookingContent', { bookingId: target, items: [{ name: '高位下拉', sets: 4, reps: 12, weight: 35 }], notes: '上午训练' })).ok)
  const beforeBusiness = JSON.stringify(world.snapshot())
  const beforeOutbox = JSON.stringify(outbox.list(scope))
  world.online = true
  guard.arm()
  // ⚠️ 语义修正（⑧ 发布前清理发现的**发布阻断**）：默认值只能是「已选定救援目标且尚未解除」，
  //    不能是「没有任何标记」。历史写法把从未做过救援的**干净设备**也当成「核查中」，
  //    于是新用户装上正式版后 `blocksBusiness('production')` 恒为 true —— 整个小程序只读。
  //    （本机没暴露，只因它身上已经留着 status:'released' 的救援标记。）
  assert.equal(guard.inspectingNow(), false, '从未做过救援的干净设备必须按正常生产运行')
  // 进入救援流程（诊断页 onLoad 会显式调用 enter()）后才打开整面冻结。
  guard.enter()
  assert.equal(guard.inspectingNow(), true, '进入救援流程后必须先冻结 Production')
  assert.equal((await sync.resume()).code, 'PRODUCTION_RECOVERY_READ_ONLY')
  assert.equal(world.counters.calls.length, 0, '救援流程中不发送 outbox')

  const local = inspect.inspectLocal(target)
  assert.equal(local.ok, true)
  assert.equal(local.booking.status, 'booked')
  assert.equal(local.package.remaining, 7)
  assert.equal(local.entries.length, 1)
  assert.equal(local.entries[0].command, 'updateBookingContent')
  assert.equal(JSON.stringify(outbox.list(scope)), beforeOutbox, '本机核查不得改队列')
  assert.equal(JSON.stringify(world.snapshot()), beforeBusiness, '本机核查不得改云业务数据')
  guard.select(target, local.datasetId)
  assert.equal(guard.held().bookingId, target)
  assert.equal((await sync.flush()).code, 'PRODUCTION_RECOVERY_READ_ONLY')
  assert.equal(world.counters.calls.length, 0, '诊断过程中显式 flush 也不得发送')
  assert.equal((await mutate('completeBooking', { bookingId: target })).code, 'PRODUCTION_RECOVERY_READ_ONLY', '诊断期间业务写入口被拦')

  let app
  global.App = definition => { app = definition }
  wx.cloud.init = () => {}
  require('../app.js')
  delete global.App
  app.onLaunch()
  app.onHide()
  await app.onShow()
  assert.equal(world.counters.calls.length, 0, '启动及前后台切换不能偷偷同步')
  const diagnosticCalls = []
  wx.cloud.callFunction = async ({ name, data }) => {
    diagnosticCalls.push({ name, action: data.action })
    if (name === 'diagnoseCoachCompletion') return { result: { ok: true, booking: { status: 'booked' }, incomes: [], package: { remaining: 7, used: 1 }, dataRevision: world.revision(), receipts: [] } }
    if (name === 'coachBusinessCommand' && data.action === 'getReceipt') return { result: { ok: true, found: false } }
    throw new Error('诊断不得调用任何业务写云函数')
  }
  let pageDefinition
  global.Page = definition => { pageDefinition = definition }
  require('../pkg-diag/production-recovery-diagnostic/production-recovery-diagnostic.js')
  delete global.Page
  const page = { data: { ...pageDefinition.data }, setData(patch) { Object.assign(this.data, patch) } }
  for (const [name, method] of Object.entries(pageDefinition)) if (typeof method === 'function') page[name] = method.bind(page)
  await page.onLoad()
  assert.equal(page.data.selectedId, target)
  assert.equal(page.data.plain.includes('C：本机有 1 条未结清命令'), true)
  assert.equal(diagnosticCalls[0].name, 'diagnoseCoachCompletion')
  assert.equal(diagnosticCalls.every(row => row.action === 'diagnose' || row.action === 'getReceipt'), true, '页面只调用只读 action')
  assert.equal(JSON.stringify(world.snapshot()), beforeBusiness, '页面诊断不能改 booking/package/income')
  assert.equal(JSON.stringify(outbox.list(scope)), beforeOutbox, '页面诊断不能改本机队列')
  page.onUnload()
  assert.equal(world.counters.calls.length, 0, '退出不自动补发')
  await sync.flush()
  assert.equal(world.counters.calls.filter(row => row.payload.bookingId === target).length, 0, '退出后目标仍冻结')
  assert.equal(world.counters.calls.filter(row => row.payload.bookingId === 'other-booking').length, 1, '排在目标前的其他正常课程照常同步')
  assert.equal(world.snapshot().bookings.find(row => row.id === target).status, 'booked')
  assert.equal(world.snapshot().incomes.length, 0)
  assert.equal(outbox.list(scope).some(row => row.payload.bookingId === target), true, '目标原号原队列保留')
  assert.equal(guard.blocksBusiness('sandbox'), false, 'Sandbox 不受 Production 救援门禁影响')
  console.log('production recovery diagnostic: PASS')
}
main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1 })
