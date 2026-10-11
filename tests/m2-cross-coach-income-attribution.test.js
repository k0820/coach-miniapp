// M2 V1 · §118 第 14 项补齐（2026-09-29）：**跨教练的钱到底进了谁的口袋**。
//
// ⛳ 业务定案（不许含糊）：
//   · A 卖出这 5 节课 ⇒ 这 500 元**销售业绩**永远留在 A 的账上；
//   · B 实际上了其中 1 节 ⇒ 这节的**教学收入**（按单价快照）进 B 的账；
//   · 扣课时扣在**课时包物理所在**那本账（A），记账记在**授课教练**那本账（B）；
//   · ⛔ 绝不允许两边各记一份，也不允许把教学收入算回 A。
//
// ⛔ 服务端是真的 `createService` + 真 handlers（只替网络）；统计页是真的 `pages/stats/stats.js`。
//    渲染层用真的统计页，是为了把"完课之后两台手机上到底显示多少钱"变成可断言的数字。

const assert = require('assert')
const path = require('path')
const { createWorld, runner, copy } = require('./helpers/m2-business-world')
const { todayKey } = require('../utils/beijing-date')

const world = createWorld()
const STATS_PAGE = path.join(__dirname, '..', 'pages', 'stats', 'stats.js')
const UNIT_PRICE = 100, SALE_AMOUNT = 500, TOTAL = 5

// 云端 row → 本机那一份数据。**全部取自真实云端文档里的 `data`**，一个数字都没手写：
//   这正是 `readMyActiveCoachData` 回读之后、客户端放进 coachDB 的那一份东西。
function localDbFor(coach) {
  const dataOf = name => world.dataRows(name, coach.owner, coach.datasetId).map(row => copy(row))
  const packages = dataOf('packages')
  const students = dataOf('students').map(student => ({ ...student, packages: packages.filter(pkg => pkg.studentId === student.id) }))
  return {
    students, packages, bookings: dataOf('bookings'), incomes: dataOf('incomes'), sales: dataOf('sales'),
    settings: Object.assign({ classCommissionRate: 0, salesCommissionRate: 0, renewThreshold: 10, monthlyGoalSessions: 40 }, dataOf('settings')[0] || {})
  }
}
// 走**真的**读取路径，而不是绕过去：测试区的权威源只有 `coachSandboxActiveCache` 这一份
// （宁可明确报错也绝不回落正式区 coachDB —— 见 utils/data-runtime.js §sandboxDB 的注释）。
function enterStats(coach) {
  world.setActor(coach)
  world.storage.coachSandboxActiveCache = {
    environment: 'sandbox', datasetId: coach.datasetId, revision: 0, snapshot: localDbFor(coach)
  }
  const page = world.enterPage(STATS_PAGE)
  page.render()
  return page
}
// 全在所有账本里数一遍：**这个 bookingId 对应几条收入**。
function incomeRowsForBooking(bookingId) {
  const found = []
  for (const row of world.stores.incomes.values()) {
    const income = row.data || {}
    if ((row.bookingId || income.bookingId) === bookingId) found.push(row)
  }
  return found
}

async function seedAndTeach(options = {}) {
  require('../utils/data-runtime').setEnvironment('sandbox')
  const A = world.seedCoach('openid-a', 'ds-a', 'PUBCODEA')
  const B = world.seedCoach('openid-b', 'ds-b', 'PUBCODEB')
  world.seedStudent(A, 'stu-1', 'M2 收入归属学员')
  const date = todayKey()
  const sold = await world.execute(A, 'createCourseSale', {
    studentId: 'stu-1', type: '常规训练', total: TOTAL, remaining: TOTAL, quantity: TOTAL,
    unitPrice: UNIT_PRICE, amount: SALE_AMOUNT, date, teachingPublicCodes: [B.publicCode]
  })
  assert.equal(sold.ok, true, JSON.stringify(sold))
  const packageId = sold.result.packageId
  const booked = await world.execute(B, 'createAuthorizedBooking', {
    studentId: 'stu-1', packageId, date, hour: options.hour == null ? 10 : options.hour, minute: 0
  })
  assert.equal(booked.ok, true, JSON.stringify(booked))
  const bookingId = booked.result.bookingId
  await world.execute(B, 'updateBookingContent', { bookingId, items: [{ name: '卧推', sets: 4, reps: 12, weight: '40' }] })
  const completed = await world.execute(B, 'completeBooking', { bookingId })
  if (!options.expectFail) assert.equal(completed.ok, true, JSON.stringify(completed))
  return { A, B, packageId, bookingId, completed, date }
}

;(async () => {
  await runner('① B 完课之后：教学收入**只**记在 B 那本账，A 那本账零收入', async () => {
    world.reset(); world.installRuntime()
    const { A, B, bookingId } = await seedAndTeach()
    const incomeInA = world.dataRows('incomes', A.owner, A.datasetId)
    const incomeInB = world.dataRows('incomes', B.owner, B.datasetId)
    assert.equal(incomeInA.length, 0, `A 不该有这笔教学收入（实测 ${JSON.stringify(incomeInA)}）`)
    assert.equal(incomeInB.length, 1, `B 必须有这一笔教学收入（实测 ${JSON.stringify(incomeInB)}）`)
    assert.equal(incomeInB[0].amount, UNIT_PRICE, '金额必须是这节课的单价快照')
  })

  await runner('② 不得重复记账：全账本扫一遍，这个 bookingId 只能对应 1 条收入', async () => {
    world.reset(); world.installRuntime()
    const { bookingId } = await seedAndTeach()
    const found = incomeRowsForBooking(bookingId)
    assert.equal(found.length, 1, `整个云端只能有一条收入挂在它身上（实测 ${found.length} 条：${JSON.stringify(found.map(row => row.ownerCoachId))}）`)
  })

  await runner('③ 课时扣在**课时包所在**那本账（A），B 那本账不产生第二份课时包', async () => {
    world.reset(); world.installRuntime()
    const { A, B, packageId } = await seedAndTeach()
    const pkgInA = world.dataRows('packages', A.owner, A.datasetId).find(item => item.id === packageId)
    assert.ok(pkgInA, '课时包仍然只有 A 那一份')
    assert.equal(pkgInA.used, 1, `A 账上的课时使用必须 +1（实测 ${JSON.stringify(pkgInA)}）`)
    assert.equal(pkgInA.remaining, TOTAL - 1, 'A 账上剩余必须 -1')
    const pkgInB = world.dataRows('packages', B.owner, B.datasetId)
    assert.equal(pkgInB.length, 0, `B 账里不许出现复制出来的课时包（实测 ${JSON.stringify(pkgInB)}）`)
  })

  await runner('④ A 的原始销售业绩**一字不动**：那 500 元还在 A 的销售表里，没被流转到 B', async () => {
    world.reset(); world.installRuntime()
    const { A, B } = await seedAndTeach()
    const salesInA = world.dataRows('sales', A.owner, A.datasetId)
    assert.equal(salesInA.length, 1, `A 的销售记录必须还在（实测 ${JSON.stringify(salesInA)}）`)
    assert.equal(salesInA[0].amount, SALE_AMOUNT, '业绩金额不许被改写')
    assert.notEqual(salesInA[0].status, 'reversed', '完课不许反过来动销售')
    const salesInB = world.dataRows('sales', B.owner, B.datasetId)
    assert.equal(salesInB.length, 0, `B 不该凭空拿到 A 的销售业绩（实测 ${JSON.stringify(salesInB)}）`)
  })

  await runner('⑤ 统计页（A 的手机）：教学收入 0 · 销售业绩 500', async () => {
    world.reset(); world.installRuntime()
    const { A } = await seedAndTeach()
    const page = enterStats(A)
    assert.equal(page.data.classRevenue, 0, `A 没上的课不许算成教学收入（实测 ${page.data.classRevenue}）`)
    assert.equal(page.data.salesRevenue, SALE_AMOUNT, `原始销售业绩必须留着（实测 ${page.data.salesRevenue}）`)
    assert.equal(page.data.monthSessions, 0, 'A 的当月完课节数是 0')
  })

  await runner('⑥ 统计页（B 的手机）：教学收入 100 · 销售业绩 0', async () => {
    world.reset(); world.installRuntime()
    const { B } = await seedAndTeach()
    const page = enterStats(B)
    assert.equal(page.data.classRevenue, UNIT_PRICE, `授课教练必须拿到这节课的收入（实测 ${page.data.classRevenue}）`)
    assert.equal(page.data.salesRevenue, 0, 'B 不该凭空拿到销售业绩')
    assert.equal(page.data.monthSessions, 1, 'B 当月上了 1 节')
  })

  await runner('⑦ 两边加总：这块业务的钱只被数了一遍（收入 100 + 业绩 500，各归各家）', async () => {
    world.reset(); world.installRuntime()
    const { A, B, bookingId } = await seedAndTeach()
    const inA = enterStats(A).data, inB = enterStats(B).data
    assert.equal(inA.classRevenue + inB.classRevenue, UNIT_PRICE, `教学收入合计必须恰好一笔（实测 A=${inA.classRevenue} B=${inB.classRevenue}）`)
    assert.equal(inA.salesRevenue + inB.salesRevenue, SALE_AMOUNT, `销售业绩合计必须恰好一笔（实测 A=${inA.salesRevenue} B=${inB.salesRevenue}）`)
    assert.equal(inA.monthSessions + inB.monthSessions, 1, '完课节数不许被记成两节')
    assert.equal(incomeRowsForBooking(bookingId).length, 1)
  })

  await runner('⑧ 边界：同一节课二次完课必须失败 ⇒ 不产生第二笔收入', async () => {
    world.reset(); world.installRuntime()
    const { B, bookingId } = await seedAndTeach()
    const again = await world.execute(B, 'completeBooking', { bookingId }, 'm2w_retry_complete')
    assert.equal(again.ok, false, '第二次完课必须被拒')
    assert.equal(again.code, 'BOOKING_ALREADY_DONE', `实测 ${JSON.stringify(again)}`)
    assert.equal(incomeRowsForBooking(bookingId).length, 1, '拒绝之后仍然只有一条收入')
  })

  await runner('⑨ 边界：非授课教练（A）去完这节课 ⇒ 被拒，且不许把收入算给 A', async () => {
    world.reset(); world.installRuntime()
    const A = world.seedCoach('openid-a', 'ds-a', 'PUBCODEA')
    const B = world.seedCoach('openid-b', 'ds-b', 'PUBCODEB')
    world.seedStudent(A, 'stu-1', 'M2 越权完课学员')
    const date = todayKey()
    const sold = await world.execute(A, 'createCourseSale', {
      studentId: 'stu-1', type: '常规训练', total: TOTAL, remaining: TOTAL, quantity: TOTAL,
      unitPrice: UNIT_PRICE, amount: SALE_AMOUNT, date, teachingPublicCodes: [B.publicCode]
    })
    const packageId = sold.result.packageId
    const booked = await world.execute(B, 'createAuthorizedBooking', { studentId: 'stu-1', packageId, date, hour: 10, minute: 0 })
    const bookingId = booked.result.bookingId
    await world.execute(B, 'updateBookingContent', { bookingId, items: [{ name: '卧推', sets: 4, reps: 12, weight: '40' }] })
    const stolen = await world.execute(A, 'completeBooking', { bookingId }, 'm2w_steal_complete')
    // 这里拿到的是 BOOKING_NOT_FOUND 而不是 NOT_TEACHING_COACH，原因本身就是一层额外的保护：
    // 这条预约**物理存在** B 那本账里 ⇒ A 在自己的集合里连这一行都看不到。
    // 两层都在 ⇒ 断言只要求"被明确拒绝"，不钉死是哪一个码（钉死反而会把第二层变更脆）。
    assert.equal(stolen.ok, false, `A 不许替 B 完这节课（实测 ${JSON.stringify(stolen)}）`)
    assert.ok(stolen.code, '拒绝必须带得清楚的错误码')
    assert.equal(world.dataRows('incomes', A.owner, A.datasetId).length, 0, '被拒之后 A 账里不许出现这笔收入')
    assert.equal(incomeRowsForBooking(bookingId).length, 0, '这条预约还没完课 ⇒ 一条收入都不许有')
  })

  require('../utils/data-runtime').setEnvironment('production')
  if (!process.exitCode) process.stdout.write('ALL M2 CROSS COACH INCOME ATTRIBUTION TESTS PASSED\n')
})().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
