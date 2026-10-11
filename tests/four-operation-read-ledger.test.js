const assert = require('assert')
const { createWorld } = require('./helpers/sandbox-command-world')

const tally = calls => ({
  commands: calls.filter(call => call.data.action === 'execute').length,
  reads: calls.filter(call => call.name === 'readMyActiveCoachData' && call.data.action === 'metadata').length,
  readRpc: calls.filter(call => call.name === 'readMyActiveCoachData').length,
  receipts: calls.filter(call => call.data.action === 'getReceipt').length
})
const subtract = (after, before) => Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]]))

// ★ 1.1.9 第 6 轮：逐条命令的口径由**写后确认账本**给出（utils/read-timing.js 的写账本）。
//   为什么不能只看这一段里的 metadata 次数：命令自己已经不翻分页了，但**同步引擎**会在同一段里
//   为「已确认、只等一次完整回读就出队」的 settled 条目做一次**共享**收尾读取（purgeSettled 一次读、
//   多条一起出队）。把两者混在一个数字里，就会既看不出"命令变轻了"，也会把共享读取误读成"每条命令各付一次"。
const writeLedger = world => (world.store.coachWriteTimings || [])
const lastWrite = (world, command) => writeLedger(world).filter(row => row.command === command).slice(-1)[0] || null

async function run() {
  const world = createWorld(), { mutate, runtime, ui } = world
  assert.equal((await ui.adapter.readActive()).ok, true)
  const page = world.page('students')
  page.onShow()
  const ledger = {}
  let before = tally(world.calls)

  page.add()
  page.data.form.name = '四项连续假学员'
  Object.assign(page.data.form.packages[0], { total: '20', remaining: '17', price: '300', saleAmount: '5800' })
  await Promise.all([page.save(), page.save()])
  await world.idle()
  ledger.create = subtract(tally(world.calls), before)
  assert.equal(world.rows('students').length, 1)
  assert.equal(world.rows('packages').length, 1)
  assert.equal(world.rows('sales').length, 1)
  assert.equal(world.rows('packages')[0].data.remaining, 17)
  assert.equal(world.rows('sales')[0].data.amount, 5800)
  assert.equal(world.executeCalls('createStudent').length, 1)
  assert.equal(world.executeCalls('createCourseSale').length, 1)

  const studentId = world.rows('students')[0].studentId, packageId = world.rows('packages')[0].packageId
  const input = { studentId, packageId, date: '2026-10-07', hour: 10, minute: 0 }
  before = tally(world.calls)
  assert.equal((await mutate.submitBooking(input)).ok, true)
  await world.idle()
  ledger.book = subtract(tally(world.calls), before)
  assert.equal(world.rows('bookings').length, 1)
  const bookingId = world.rows('bookings')[0].bookingId
  assert.equal(world.executeCalls('createBooking').length, 1)
  // ★ 1.1.9 第 6 轮契约：命令成功后**不再由命令自己翻分页**，只发一跳只读校验确认云端已处于
  //   本命令提交后的 revision。**逐条命令**的口径看写后确认账本（mode），因为这一段里还可能包含
  //   同步引擎给 settled 条目做的**一次共享**收尾读取（不是每条命令各付一次）。
  assert.equal(lastWrite(world, 'createBooking').mode, 'lightweight',
    'createBooking 成功后必须走轻量确认（不翻分页）：' + JSON.stringify(lastWrite(world, 'createBooking')))
  assert.equal(lastWrite(world, 'createBooking').fallback, '')
  assert.ok(Number(lastWrite(world, 'createBooking').refreshMs) < 2000,
    '写后确认必须是一次往返的量级，不能是 8–10 秒的完整分页回读：' + lastWrite(world, 'createBooking').refreshMs + 'ms')

  before = tally(world.calls)
  const booking = runtime.getDB().bookings.find(row => row.id === bookingId)
  assert.equal((await mutate.cancelBooking({ officialId: bookingId, booking })).ok, true)
  await world.idle()
  ledger.cancel = subtract(tally(world.calls), before)
  assert.equal(world.rows('bookings').length, 0)
  assert.equal(lastWrite(world, 'cancelBooking').mode, 'lightweight',
    'cancelBooking 成功后同样必须走轻量确认：' + JSON.stringify(lastWrite(world, 'cancelBooking')))
  assert.equal(lastWrite(world, 'cancelBooking').fallback, '')
  assert.equal(world.executeCalls('cancelBooking').length, 1, '取消命令本身仍然恰好一次')
  // ★ 安全边界（同一轮的地基，绝不能为了"快"丢掉）：轻量确认之后本机 cache 仍是旧值，
  //   所以 tombstone 必须**继续留着** —— 它才是"块隐藏"的唯一依据。此刻就撤掉它，
  //   stale cache 会立刻把这条已经被取消的预约画回来（幽灵）。它只能由一次**成功的完整回读**收尾，
  //   而真实路径上那次回读就是「重新进页面 / 下拉」时的 resume()。
  assert.equal(ui.pendingCancellationRecords().length, 1, '完整回读之前 tombstone 必须留着，否则 stale cache 会复活已取消的块')
  await mutate.resumePendingBookings()
  assert.equal(ui.pendingCancellationRecords().length, 0, '一次成功的完整回读之后 tombstone 必须被撤下')
  assert.equal(world.rows('incomes').length, 0)
  assert.equal(world.rows('packages')[0].data.remaining, 17)

  before = tally(world.calls)
  const deleted = await mutate(null, null, { command: 'deleteStudent', key: `deleteStudent:${studentId}`, payload: { studentId } })
  await world.idle()
  ledger.delete = subtract(tally(world.calls), before)
  assert.equal(deleted.ok, true)
  assert.equal(world.rows('students').length, 0)
  assert.equal(world.rows('student_tombstones').length, 1)
  assert.equal(world.rows('packages').length, 1)
  assert.equal(world.rows('sales').length, 1)
  assert.equal(world.rows('packages')[0].data.status, 'reversed')
  assert.equal((await ui.adapter.readActive()).ok, true, '删除后完整回读仍必须成立')
  assert.equal(world.rows('incomes').length, 0)
  assert.equal(world.executeCalls('deleteStudent').length, 1)
  console.log('four-operation baseline RPC ledger PASS:', JSON.stringify(ledger))
}

run().catch(error => { console.error(error); process.exitCode = 1 })
