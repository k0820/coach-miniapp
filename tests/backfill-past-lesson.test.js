// 事后补录（2026-09-29，只读检查的**落地版**）：
//   教练能不能在当天 17:00 建一条"当天 15:00 已经上完"的课，再补动作 / 组数 / 次数 / 重量并完成？
//
// ⛳ 结论（逐条查过 client 与云端，见文件末尾注释）：
//   · **能补** —— 全链路**没有任何**"过去时间不许建 / 不许完成"的校验；
//   · 收入的日期取**这节课自己的日期**（不是补录那一刻）⇒ 事后补录不会把钱算错月份；
//   · ✅ 2026-09-29 业务口径已确认：**07:00 之前的清晨课也能录**（含事后补录），
//       服务端 / 本机 / 选择器三处统一为"一天 00:00–24:00"，只保留真正非法时间的闸门；
//   · ⛔ 仍有一处硬限制（这是已经确认的业务规则，不是待办）：
//       课时包剩余必须 > 0 ⇒ "最后一节已经上完"之后再补录会被挡
//       （先处理课时余额，再正常录入；详见下面第 ⑥ 段）。
//
// ⛔ 本文件只钉事实，**不改任何业务规则**。
//
// ⚠️ 分工（别把它和 past-lesson-backfill.test.js 当成重复）：
//   · 本文件 = **云端那条链**（补录照扣课时、跨教练补录收入归授课教练、"剩余归零"补不进去）；
//   · past-lesson-backfill.test.js = **客户端有没有拦**（排课弹窗 / validateBookingCreation / 本机引擎口径 / 冲突）。

const assert = require('assert')
const { createWorld, runner } = require('./helpers/m2-business-world')
const { todayKey } = require('../utils/beijing-date')

const world = createWorld()
const PAST_HOUR = 15

async function seed(options = {}) {
  require('../utils/data-runtime').setEnvironment('sandbox')
  world.installRuntime()
  const A = world.seedCoach('openid-a', 'ds-a', 'PUBCODEA')
  const B = world.seedCoach('openid-b', 'ds-b', 'PUBCODEB')
  world.seedStudent(A, 'stu-1', '事后补录学员')
  const sold = await world.execute(A, 'createCourseSale', {
    studentId: 'stu-1', type: '常规训练', total: options.total || 5, remaining: options.remaining == null ? 5 : options.remaining,
    quantity: options.total || 5, unitPrice: 100, amount: 500, date: todayKey(),
    ...(options.withB ? { teachingPublicCodes: [B.publicCode] } : {})
  })
  assert.equal(sold.ok, true, JSON.stringify(sold))
  return { A, B, packageId: sold.result.packageId, saleId: sold.result.saleId }
}
async function backfill(params) {
  const { actor, packageId, hour, minute } = params
  const booked = await world.execute(actor, params.command || 'createBooking', {
    studentId: 'stu-1', packageId, date: todayKey(), hour, minute: minute || 0
  })
  if (!booked.ok) return booked
  await world.execute(actor, 'updateBookingContent', {
    bookingId: booked.result.bookingId, items: [{ name: '卧推', sets: 4, reps: 12, weight: '40' }]
  })
  return { booked, completed: await world.execute(actor, 'completeBooking', { bookingId: booked.result.bookingId }) }
}

;(async () => {
  await runner('① 过去时间也能建预约：服务端**没有**"不许补录"的时间校验', async () => {
    world.reset()
    const { A, packageId } = await seed()
    const written = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: PAST_HOUR, minute: 0 })
    assert.equal(written.ok, true, `补录应当被允许（实测 ${JSON.stringify(written)}）`)
    const row = world.dataRows('bookings', A.owner, A.datasetId)[0]
    assert.equal(row.hour, PAST_HOUR)
    assert.equal(row.status, 'booked')
  })

  await runner('② 补动作之后能完成：收入日期 = **那节课的日期**，不是补录那一刻', async () => {
    world.reset()
    const { A, packageId } = await seed()
    const { completed } = await backfill({ actor: A, packageId, hour: PAST_HOUR })
    assert.equal(completed.ok, true, `补录之后必须能完成（实测 ${JSON.stringify(completed)}）`)
    const income = world.dataRows('incomes', A.owner, A.datasetId)[0]
    assert.equal(income.date, todayKey(), `收入的日期必须是这节课自己的日期（实测 ${JSON.stringify(income)}）`)
    assert.equal(income.time, '15:00', '时间也必须照这节课写')
    assert.equal(income.amount, 100)
  })

  await runner('③ 补录一样扣课时：used +1 / remaining -1，占座一并释放', async () => {
    world.reset()
    const { A, packageId } = await seed()
    await backfill({ actor: A, packageId, hour: PAST_HOUR })
    const pkg = world.dataRows('packages', A.owner, A.datasetId).find(item => item.id === packageId)
    assert.equal(pkg.used, 1, `实测 ${JSON.stringify(pkg)}`)
    assert.equal(pkg.remaining, 4)
    assert.equal(Number(pkg.reserved || 0), 0, '完课必须把占座释放掉')
  })

  await runner('④ 跨教练补录同样可行：B 用 A 的课补一节过去时间的课 ⇒ 收入仍归 B', async () => {
    world.reset()
    const { A, B, packageId } = await seed({ withB: true })
    const { completed } = await backfill({ actor: B, packageId, hour: PAST_HOUR, command: 'createAuthorizedBooking' })
    assert.equal(completed.ok, true, `跨教练补录也必须可行（实测 ${JSON.stringify(completed)}）`)
    const incomeInA = world.dataRows('incomes', A.owner, A.datasetId)
    const incomeInB = world.dataRows('incomes', B.owner, B.datasetId)
    assert.equal(incomeInA.length, 0, '收入不许记回卖课的人')
    assert.equal(incomeInB.length, 1, '授课教练拿到这一笔')
    assert.equal(incomeInB[0].date, todayKey(), '日期照这节课写')
    const pkg = world.dataRows('packages', A.owner, A.datasetId).find(item => item.id === packageId)
    assert.equal(pkg.remaining, 4, '课时扣在课包所在那本账')
  })

  await runner('⑤ 清晨补录（2026-09-29 放开）：06:00 那节课事后也能补进来', async () => {
    world.reset()
    const { A, packageId } = await seed()
    const early = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 6, minute: 0 }, 'm2w_backfill_6am')
    assert.equal(early.ok, true, `06:00 必须能补（实测 ${JSON.stringify(early)}）`)
    // 补录后照常完成 ⇒ 收入按当天记，课时照扣（这条链与下午的课没有区别）。
    const bookingId = early.result.bookingId
    await world.execute(A, 'updateBookingContent', {
      bookingId, items: [{ name: '卧推', sets: 4, reps: 12, weight: '40' }]
    })
    const done = await world.execute(A, 'completeBooking', { bookingId }, 'm2w_backfill_6am_done')
    assert.equal(done.ok, true, `清晨补录的课必须能完成（实测 ${JSON.stringify(done)}）`)
    const incomes = world.dataRows('incomes', A.owner, A.datasetId)
    assert.equal(incomes.length, 1, '记一笔收入')
    assert.equal(incomes[0].date, todayKey(), '日期照这节课写，不写补录那一刻')
    const pkg = world.dataRows('packages', A.owner, A.datasetId).find(item => item.id === packageId)
    assert.equal(pkg.remaining, 4, '课时照扣')
  })

  await runner('⑥ 余额不足：remaining = 0 ⇒ 事后补录一律不许（普通课包与授权课包同一条规则）', async () => {
    world.reset()
    const { A, packageId } = await seed({ total: 1, remaining: 0 })
    const written = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: PAST_HOUR, minute: 0 }, 'm2w_backfill_zero')
    assert.equal(written.ok, false, '剩余 0 ⇒ 补不进去')
    assert.equal(written.code, 'PACKAGE_NO_REMAINING', `实测 ${JSON.stringify(written)}`)
    assert.ok(String(written.message || '').includes('没有剩余课时') && String(written.message || '').includes('事后补录'),
      `提示必须说清楚"为什么 + 下一步"（实测 ${JSON.stringify(written.message)}）`)
    // ① 一个字节都不许写：不能出现负数余额，也不能凭空多一条预约。
    assert.equal(world.dataRows('bookings', A.owner, A.datasetId).length, 0, '被拒 ⇒ 零写入')
    const pkg0 = world.dataRows('packages', A.owner, A.datasetId).find(item => item.id === packageId)
    assert.equal(pkg0.remaining, 0, '剩余不许变成负数')
    assert.equal(Number(pkg0.reserved || 0), 0, '也不许悄悄占座')

    // ② 授权课包走的是同一条规则 —— B 用这份"余额已经归零"的课补录，也必须被挡。
    world.reset()
    const shared = await seed({ withB: true, total: 1, remaining: 0 })
    const cross = await world.execute(shared.B, 'createAuthorizedBooking', {
      studentId: 'stu-1', packageId: shared.packageId, date: todayKey(), hour: PAST_HOUR, minute: 0
    }, 'm2w_backfill_zero_cross')
    assert.equal(cross.ok, false, '授权课包余额不足 ⇒ 同样补不进去')
    assert.equal(cross.code, 'PACKAGE_NO_REMAINING', `实测 ${JSON.stringify(cross)}`)
    assert.equal(world.dataRows('bookings', shared.B.owner, shared.B.datasetId).length, 0, 'B 那边也要零写入')

    // ③ 先补足余额 ⇒ 同一条链立刻通（证明上面拒的是"余额"，不是别的东西）。
    const topped = await world.execute(shared.A, 'updateCourseSale', {
      saleId: shared.saleId, packageId: shared.packageId, type: '常规训练', total: 2, remaining: 1,
      quantity: 2, unitPrice: 100, amount: 500, date: todayKey(), confirmTotalBelowUsed: true
    }, 'm2w_topup')
    assert.equal(topped.ok, true, JSON.stringify(topped))
    const retry = await world.execute(shared.B, 'createAuthorizedBooking', {
      studentId: 'stu-1', packageId: shared.packageId, date: todayKey(), hour: PAST_HOUR, minute: 0
    }, 'm2w_backfill_after_topup')
    assert.equal(retry.ok, true, `补上余额之后必须能补录（实测 ${JSON.stringify(retry)}）`)
  })

  require('../utils/data-runtime').setEnvironment('production')
  if (!process.exitCode) process.stdout.write('ALL BACKFILL PAST LESSON TESTS PASSED\n')
})().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
