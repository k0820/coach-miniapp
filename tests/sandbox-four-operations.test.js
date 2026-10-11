const assert = require('assert')
const { createWorld } = require('./helpers/sandbox-command-world')

async function run() {
  const world = createWorld(), { ui, mutate, runtime } = world
  const readActive = ui.adapter.readActive
  ui.adapter.readActive = async () => { throw new Error('isolated preflight network interruption') }
  const beforeDelete = world.executeCalls('deleteStudent').length
  const preflight = await mutate(null, null, { command: 'deleteStudent', key: 'deleteStudent:preflight', payload: { studentId: 'test-only' } })
  assert.equal(preflight.code, 'ACTIVE_READ_UNAVAILABLE', '读版本号失败不能冒充已经发出的删除命令')
  assert.equal(world.executeCalls('deleteStudent').length, beforeDelete, '前置读取失败时删除命令没有出网')
  assert.equal(world.modals.some(item => item.title === '结果待确认'), false)
  ui.adapter.readActive = readActive
  assert.equal((await ui.adapter.readActive()).ok, true)
  const page = world.page('students')
  page.onShow(); page.add()
  page.data.form.name = '隔离测试学员'
  Object.assign(page.data.form.packages[0], { total: '20', remaining: '17', price: '300', saleAmount: '5800' })
  await Promise.all([page.save(), page.save()])
  await world.idle()
  assert.equal(world.rows('students').length, 1)
  assert.equal(world.rows('packages').length, 1)
  assert.equal(world.rows('sales').length, 1)
  assert.equal(world.rows('sales')[0].data.amount, 5800)
  const studentId = world.rows('students')[0].studentId, packageId = world.rows('packages')[0].packageId
  const input = { studentId, packageId, date: '2026-10-01', hour: 10, minute: 0 }
  const booking = await mutate.submitBooking(input)
  assert.equal(booking.ok, true)
  await world.idle()
  assert.equal(world.rows('bookings').length, 1)
  // ★ 1.1.9 第 6 轮：协调器（booking-optimistic）**成功后不再顺手补齐 cache**，而它又不走 Outbox，
  //   所以 `getDB()`（cache + 队列投影）此刻还看不到这条新预约 —— 直接取就会拿到 undefined。
  //   先补一次**完整读取**再取正式身份，这正是真实路径（用户要看到它也是靠一次完整回读）。
  assert.equal((await ui.adapter.readActive()).ok, true)
  const first = runtime.getDB().bookings[0]
  assert.ok(first && first.id, '一次完整读取之后本机 cache 必须包含刚约的课')
  await mutate.cancelBooking({ officialId: first.id, booking: first })
  await world.idle()
  assert.equal(world.rows('bookings').length, 0)
  // ★ 1.1.9 第 6 轮：取消命令成功后不再补一次完整分页回读，本机 cache 此刻仍是旧值
  //   ⇒ tombstone 必须**继续留着**（它是"块隐藏"的唯一依据；此刻先撤掉，
  //   stale cache 会立即把这条已经被取消的预约画回来）。它由一次**成功的完整回读**收尾 ——
  //   真实路径就是「重新进页面 / 下拉」时那一次 resume()。
  assert.equal(ui.pendingCancellationRecords().length, 1, '完整回读之前 tombstone 必须留着，否则 stale cache 会复活已取消的块')
  await mutate.resumePendingBookings()
  assert.equal(ui.pendingCancellationRecords().length, 0, '一次成功的完整回读之后 tombstone 必须被撤下')
  assert.equal(world.rows('packages')[0].data.remaining, 17)
  assert.equal(world.rows('incomes').length, 0)

  // Same slot becomes bookable only after the cancellation is confirmed.
  assert.equal((await mutate.submitBooking(input)).ok, true)
  await world.idle()
  // ★ 1.1.9 第 6 轮：写命令成功后**不再由命令自己翻分页**，所以 `runtime.getDB()`（cache + Outbox 投影）
  //   不会立刻包含这条新预约 —— cache 由下一次**完整回读**补齐（进页面 / 下拉时的 resume）。
  //   用户看到的那一帧来自**视图层合并**（正式 cache + 本机待确认预约），所以这里按视图层口径取。
  //   正式身份不依赖 cache：它来自命令返回体（settle 里已绑定）。
  const pendingRows = ui.pendingBookingRecords()
  assert.equal(pendingRows.length, 1, '刚约的课必须在本机待确认记录里（视图层正是靠它立刻把块画出来）')
  const secondId = ui.officialIdForBooking(pendingRows[0].pendingKey)
  assert.ok(secondId, '刚约的课必须立刻拿到正式身份（绑定来自命令返回体，不等 cache）')
  assert.notEqual(secondId, first.id, '取消之后再约同一时段必须是一条**新的**预约')
  const content = { bookingId: secondId, items: [{ name: '隔离深蹲', sets: 3, reps: 10, weight: 20 }], notes: '保留历史', category: '常规训练', duration: 60 }
  const contentResult = await mutate(null, null, { command: 'updateBookingContent', payload: content })
  assert.equal(contentResult.ok, true, JSON.stringify(contentResult))
  await world.idle()
  await Promise.all([1, 2].map(() => mutate(null, null, { command: 'completeBooking', payload: { bookingId: secondId } })))
  await world.idle()
  assert.equal(world.rows('bookings')[0].data.status, 'done')
  assert.equal(world.rows('packages')[0].data.used, 1)
  assert.equal(world.rows('packages')[0].data.remaining, 16)
  assert.equal(world.rows('incomes').length, 1)
  const history = JSON.stringify({ bookings: world.rows('bookings'), incomes: world.rows('incomes') })
  const deleted = await mutate(null, null, { command: 'deleteStudent', key: 'deleteStudent:' + studentId, payload: { studentId } })
  // 阶段 2：deleteStudent 已是**本机先行**命令 —— 用户按下删除那一刻本机就完成（UI 立即消失），
  // 云端由后台同步引擎按全局 FIFO 送。所以这里钉的是**本机先行**契约，
  // 而不是云端先行时代那条「本机已拿到 refreshed」的断言（那条只对 adapter.execute 的返回值成立）。
  assert.equal(deleted.ok, true, JSON.stringify(deleted))
  assert.equal(deleted.path, 'local-first', '删除必须是本机先行：' + JSON.stringify(deleted))
  assert.equal(deleted.local, true, '删除必须在本机完成，不等待云端：' + JSON.stringify(deleted))
  assert.equal(runtime.getDB().students.filter(student => student.status !== 'deleted').length, 0, '本机投影必须立刻看不到该学员（秒删）')
  // 后台收敛：等同步引擎把删除送到云端，此后才谈得上「云端墓碑恰好 1 条」。
  await world.idle()
  assert.equal(world.rows('student_tombstones').length, 1)
  assert.equal(JSON.stringify({ bookings: world.rows('bookings'), incomes: world.rows('incomes') }), history)

  // The same receipt must not delete/reverse twice, even with an old revision.
  const originalDelete = world.executeCalls('deleteStudent')[0]
  const replay = await wx.cloud.callFunction({ name: originalDelete.name, data: originalDelete.data })
  assert.equal(replay.result.idempotent, true)
  assert.equal(world.rows('student_tombstones').length, 1)

  // A new cold-start write after deletion still completes the entire page chain.
  ui.adapter.resetState('sandbox')
  page.add(); page.data.form.name = '删除后新增'
  Object.assign(page.data.form.packages[0], { total: '10', remaining: '8', price: '200', saleAmount: '1900' })
  let lostSaleResponse = false
  world.afterCall = async call => {
    if (!lostSaleResponse && call.data.envelope && call.data.envelope.command === 'createCourseSale') {
      lostSaleResponse = true
      throw new Error('committed sale response lost')
    }
  }
  await Promise.all([page.save(), page.save(), page.savePackage({ currentTarget: { dataset: { i: 0 } } })])
  await world.idle()
  world.afterCall = null
  assert.equal(lostSaleResponse, true)
  assert.equal(world.rows('students').length, 1)
  assert.equal(world.rows('sales').filter(row => row.data.status !== 'reversed').length, 1)
  const activeStudent = runtime.getDB().students.find(student => student.status !== 'deleted')
  assert.equal(activeStudent.packages[0].remaining, 8)
  const nextInput = { studentId: activeStudent.id, packageId: activeStudent.packages[0].id, date: '2026-10-02', hour: 10, minute: 0 }
  assert.equal((await mutate.submitBooking(nextInput)).ok, true)
  await world.idle()
  // ★ 1.1.9 第 6 轮：协调器确认成功时**不再**顺手把本机 cache 补齐（只做一跳只读校验），
  //   所以这里按真实路径补一次完整读取（= 用户进课表 / 下拉那一下）。
  //   本节下面的取消正是从 cache 渲染出来的块上点出去的，必须先让 cache 包含这条预约。
  assert.equal((await ui.adapter.readActive()).ok, true)
  const nextBooking = runtime.getDB().bookings.find(row => row.studentId === activeStudent.id)
  assert.ok(nextBooking, '一次完整读取之后本机 cache 必须包含刚约的课')

  // Cancellation commits, but response and receipt query are unavailable.
  let cancelCommitted = false
  world.afterCall = async call => {
    if (call.data.envelope && call.data.envelope.command === 'cancelBooking') { cancelCommitted = true; throw new Error('cancel response lost') }
  }
  world.beforeCall = async call => { if (cancelCommitted && call.data.action === 'getReceipt') throw new Error('receipt unavailable') }
  await mutate.cancelBooking({ officialId: nextBooking.id, booking: nextBooking })
  for(let i=0;i<30&&ui.pendingCancellationRecords()[0]?.status!=='unknown';i++)await new Promise(resolve=>setTimeout(resolve,50))
  await world.idle()
  const cancellation = ui.pendingCancellationRecords()[0]
  assert.equal(cancellation.status, 'unknown')
  assert.equal((await mutate.submitBooking(nextInput)).code, 'CANCELLATION_IN_PROGRESS')
  const cancelCount = world.executeCalls('cancelBooking').length
  await mutate.resumePendingBookings()
  assert.equal(world.executeCalls('cancelBooking').length, cancelCount, 'unknown cancel must only query receipts')
  world.afterCall = null; world.beforeCall = null
  await mutate.resumePendingBookings()
  assert.equal(world.executeCalls('cancelBooking').length, cancelCount)
  assert.equal(ui.pendingCancellationRecords().length, 0)
  assert.equal(runtime.getDB().students.find(row => row.id === activeStudent.id).packages[0].remaining, 8)
  assert.equal(world.rows('incomes').length, 1, 'cancel never deducts or adds Income')

  // Inject exactly the pre-fix missing tombstone in MEMORY ONLY, then break the cold-start read.
  // 阶段 2 之后这里钉的是**新契约**：这条共同回读故障不再挡住本机先行命令（edit/delete 仍秒改秒删），
  // 但**确实**挡住了仍走云端先行的命令。所以下面逐条按新分类断言，而不是笼统地说「四条都被挡住」。
  assert.equal((await mutate.submitBooking(nextInput)).ok, true)
  await world.idle()
  // 同上：先做一次完整读取，让本机 cache 包含这条预约，再取它的正式身份。
  assert.equal((await ui.adapter.readActive()).ok, true)
  const target = runtime.getDB().bookings.find(row => row.studentId === activeStudent.id)
  assert.ok(target, '一次完整读取之后本机 cache 必须包含刚约的课')
  world.cloud.stores.student_tombstones.clear()
  ui.adapter.resetState('sandbox')
  const failedDelete = await mutate(null, null, { command: 'deleteStudent', key: 'corrupt-delete', payload: { studentId: activeStudent.id }, strategy: 'silent' })
  // 删除是本机先行：回读坏了也**照样完成**（这正是「删除秒删」要的），它只是被排进队列等云端恢复。
  assert.equal(failedDelete.ok, true, '本机先行命令不得被云端回读故障挡住：' + JSON.stringify(failedDelete))
  assert.equal(failedDelete.path, 'local-first', '删除必须走本机先行')
  assert.equal(runtime.getDB().students.filter(row => row.id === activeStudent.id).length, 0, '本机投影必须立刻看不到该学员')
  page.add(); page.data.form.name = '被共同回读故障阻止'
  Object.assign(page.data.form.packages[0], { total: '2', remaining: '2', price: '200', saleAmount: '400' })
  await page.save()
  assert.ok(runtime.getDB().students.some(student => student.name === '被共同回读故障阻止'), 'readback 故障不应抹掉本机已保存的新学员')
  // 云端先行命令（预约 / 取消）依旧被同一个回读故障挡在**出网之前**。
  await mutate.submitBooking({ ...nextInput, hour: 12 })
  await mutate.cancelBooking({ officialId: target.id, booking: target })
  await world.idle()
  assert.ok(ui.pendingBookingRecords().length > 0)
  assert.ok(ui.pendingCancellationRecords().length > 0)
  // 云端一条业务都没提交：本机先行的那条删除也还留在队列里等恢复，**没有**半途落云。
  assert.equal(world.cloud.stores.coach_data_heads.size, 0, '回读故障下云端不得提交任何业务事务')
  assert.equal(world.cloud.stores.coach_command_receipts.size, 0, '回读故障下云端不得留下任何回执')
  assert.equal(world.rows('student_tombstones').length, 0, '云端此刻不得有墓碑（删除还在队列里）')
  // ★ 这一节的边界到此为止，**刻意不再往下断言「云端最终收敛」**：
  //   为了让这个场景成立，本节在 125 行把墓碑从云端内存里删掉了 —— 那会让 readActive 永久
  //   以 ORPHAN_PACKAGE 失败（这就是本测试要复现的那类"共同回读故障"）。
  //   在一个**被自己毒化**的读路径上要求收敛，测的是夹具而不是产品。
  //   所以这里只钉**队列完整性**这条真正属于本节的保证：
  //   删除没丢、没被当成失败归档、也没被重复发。
  const queue = require('../utils/local-outbox')
  const scope = { environment: 'sandbox', datasetId: world.datasetId }
  const parked = queue.list(scope).filter(entry => entry.command === 'deleteStudent')
  assert.equal(parked.length, 1, '回读故障期间那条删除必须仍然在队列里，既不能丢也不能重')
  assert.equal(parked[0].status, 'pending', '它必须是 pending（等恢复后重试），不能是被归档的失败')
  assert.equal(parked[0].entityKey, `student:${activeStudent.id}`, '它的实体身份必须仍然是这位学员')
  // 「同一个实体的操作顺序」：删除在队列里必须排在它后面那批写命令**之前**（全局 FIFO 不越序）。
  const order = queue.list(scope).map(entry => entry.command)
  assert.ok(order.indexOf('deleteStudent') === 0, '删除必须排在队列最前（先删后建，不能倒序）：' + order.join('>'))
  assert.equal(queue.failed(scope).length, 0, '回读故障不得把任何命令记成业务失败')
  // 云端最终收敛的完整证明在 tests/student-pending-lifecycle.test.js —— 那边的世界是干净的，
  // 回读能真的恢复，所以「最终恰好一条墓碑、不复活不重复」在那里是可断言的。这里不重复造那个场景。
  console.log('Sandbox four operations PASS: real funnel + adapter + cloud handlers + active read; one sale, exact package, one deduction/income, deletion preserves history')
}
run().catch(error => { console.error(error); process.exitCode = 1 })

