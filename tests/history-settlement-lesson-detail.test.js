// 统计 → 历史结算 → 课时结算：**会员那一行展开之后的课程明细**（2026-09-29）。
//
// 需求落在六件可断言的事上：
//   ① 同一会员多节不同日期 ⇒ 逐节显示正确的日期 / 开始 / 结束 / 类型 / 金额 / 完课状态；
//   ② M2 共享（跨教练）学员的课 ⇒ **实际授课的 B** 看得到，且金额是 B 的教学收入；
//   ③ 取消的、还没上的课 ⇒ 不许混进已完成收入；
//   ④ 历史数据缺字段 ⇒ 写「未记录」，**不许拿当前时间顶、也不许自己补 60 分钟**；
//   ⑤ 汇总金额必须与展开明细逐笔对得上；
//   ⑥ 关联只走 `bookingId`，不许按姓名 / 金额 / 数组顺序猜。
//
// ⛔ 服务端是真的 `createService` + 真 handlers（只替网络）；统计页是真的 `pages/stats/stats.js`。
//    渲染层用真的统计页，才能把"手机上到底看到什么"变成可断言的数字。

const assert = require('assert')
const path = require('path')
const { createWorld, runner, copy } = require('./helpers/m2-business-world')
const settlement = require('../utils/settlement-detail')
const { todayKey, dateParts } = require('../utils/beijing-date')
const { setEnvironment } = require('../utils/data-runtime')

const world = createWorld()
const STATS_PAGE = path.join(__dirname, '..', 'pages', 'stats', 'stats.js')
const UNIT_PRICE = 100, SALE_AMOUNT = 500, TOTAL = 5
const UNRECORDED = settlement.UNRECORDED
const PARTS = dateParts(todayKey())
const MONTH = `${PARTS.year}-${String(PARTS.month).padStart(2, '0')}`
const DAY = day => `${MONTH}-${String(day).padStart(2, '0')}`

const baseSettings = () => ({ classCommissionRate: 0, salesCommissionRate: 0, renewThreshold: 10, monthlyGoalSessions: 40 })

// ---------------------------------------------------------------- A. 翻译层（不经过页面，口径逐条钉死）

;(async () => {
await runner('① 半截数据一律写「未记录」：不补默认值、不拿今天顶', async () => {
  const lesson = settlement.lessonDetailOf({ id: 'i1', bookingId: 'b1', amount: 100 }, { id: 'b1' })
  assert.equal(lesson.date, UNRECORDED)
  assert.equal(lesson.startTime, UNRECORDED)
  assert.equal(lesson.endTime, UNRECORDED)
  assert.equal(lesson.timeText, UNRECORDED)
  assert.equal(lesson.typeName, UNRECORDED)
  assert.equal(lesson.statusText, UNRECORDED)
  assert.equal(lesson.durationText, settlement.DURATION_UNRECORDED)
  assert.equal(lesson.amount, 100, '金额取自收入记录本身，与缺字段无关')
  assert.ok(!/^\d{4}-\d{2}-\d{2}$/.test(lesson.date), `日期绝不能被填成一个真的日期（实测 ${lesson.date}）`)
})

await runner('② 时长没保存 ⇒ 结束时间「未记录」，绝不是「开始 + 60」', async () => {
  const lesson = settlement.lessonDetailOf({ bookingId: 'b2', amount: 120 }, { id: 'b2', date: '2026-09-05', hour: 10, minute: 0 })
  assert.equal(lesson.startTime, '10:00', '开始时间是排课时留下来的真数据')
  assert.equal(lesson.endTime, UNRECORDED, '没存过时长就不许算结束时间')
  assert.notEqual(lesson.endTime, '11:00', '⛔ 不许把 60 分钟兜底当成这节课的真实时长')
  assert.equal(lesson.durationText, settlement.DURATION_UNRECORDED)
})

await runner('③ 时长真的存过 ⇒ 结束 = 开始 + 那个时长；跨 24:00 照实写', async () => {
  const normal = settlement.lessonDetailOf({}, { id: 'b', date: '2026-09-05', hour: 9, minute: 30, plannedMinutes: 90 })
  assert.equal(normal.startTime, '09:30')
  assert.equal(normal.endTime, '11:00')
  assert.equal(normal.durationText, '90 分钟')
  const late = settlement.lessonDetailOf({}, { id: 'b', date: '2026-09-05', hour: 23, minute: 30, plannedMinutes: 60 })
  assert.equal(late.startTime, '23:30')
  assert.equal(late.endTime, '24:30', '不回绕、不截断 —— 怎么排的怎么写')
})

await runner('④ booking 已经不在 ⇒ 退回收入快照上的日期，状态写「未记录」，金额照记', async () => {
  const lesson = settlement.lessonDetailOf(
    { id: 'i', bookingId: 'gone', date: '2026-09-06', time: '08:30', amount: 80, typeName: '赠送课程' },
    null
  )
  assert.equal(lesson.date, '2026-09-06')
  assert.equal(lesson.startTime, '08:30')
  assert.equal(lesson.endTime, UNRECORDED, '没有 booking 就没有时长 ⇒ 不许算结束时间')
  assert.equal(lesson.statusText, UNRECORDED, '看不到的状态不许猜成"已完成"')
  assert.equal(lesson.typeName, '赠送课程')
  assert.equal(lesson.amount, 80)
})

await runner('⑤ 排序按日期 + 开始时间，与收入数组原本的顺序无关', async () => {
  // 故意倒着给：收入顺序 c(07) → a(05,15:00) → b(05,09:30)。
  const rows = settlement.lessonListOf([
    { id: 'c', bookingId: 'b3', date: '2026-09-07' },
    { id: 'a', bookingId: 'b1', date: '2026-09-05' },
    { id: 'b', bookingId: 'b2', date: '2026-09-05' }
  ], [
    { id: 'b3', date: '2026-09-07', hour: 8, minute: 0, plannedMinutes: 60 },
    { id: 'b1', date: '2026-09-05', hour: 15, minute: 0, plannedMinutes: 60 },
    { id: 'b2', date: '2026-09-05', hour: 9, minute: 30, plannedMinutes: 60 }
  ])
  assert.deepEqual(rows.map(row => row.date), ['2026-09-05', '2026-09-05', '2026-09-07'])
  assert.deepEqual(rows.map(row => row.startTime), ['09:30', '15:00', '08:00'])
})

await runner('⑥ 关联只认 bookingId：两条收入对调 ⇒ 明细跟着对调（不跟金额、不跟顺序）', async () => {
  const rows = settlement.lessonListOf([
    { id: 'i1', bookingId: 'b2', amount: 100 },
    { id: 'i2', bookingId: 'b1', amount: 200 }
  ], [
    { id: 'b1', date: '2026-09-01', hour: 7, minute: 0, plannedMinutes: 60, typeName: '力量训练', status: 'done' },
    { id: 'b2', date: '2026-09-02', hour: 20, minute: 0, plannedMinutes: 60, typeName: '燃脂训练', status: 'done' }
  ])
  assert.equal(rows[0].date, '2026-09-01')
  assert.equal(rows[0].amount, 200, '金额跟着 bookingId 走，不跟着数组位置走')
  assert.equal(rows[0].typeName, '力量训练')
  assert.equal(rows[1].date, '2026-09-02')
  assert.equal(rows[1].amount, 100)
  assert.equal(rows[1].typeName, '燃脂训练')
})

// ---------------------------------------------------------------- B. 真页面 + 手工快照（汇总一致 / 取消不混入 / 缺字段）

function statsPageFor(snapshot) {
  setEnvironment('sandbox')
  world.storage.coachSandboxActiveCache = { environment: 'sandbox', datasetId: 'ds-detail', revision: 0, snapshot: copy(snapshot) }
  const page = world.enterPage(STATS_PAGE)
  page.setData({ historyMonth: MONTH })
  page.renderHistory()
  return page
}

const studentRow = () => ({ id: 'stu-1', name: '测试学员小蓝', packages: [{ id: 'pk-1', type: '常规训练', total: 10, used: 2, remaining: 8 }] })

await runner('⑦ 同一会员两节不同日期：逐节显示日期/时间/金额，且明细合计 == 会员小计 == 月份总额', async () => {
  world.reset(); world.installRuntime()
  const page = statsPageFor({
    students: [studentRow()],
    bookings: [
      { id: 'b1', studentId: 'stu-1', packageId: 'pk-1', date: DAY(12), hour: 9, minute: 30, plannedMinutes: 60, typeName: '常规训练', status: 'done' },
      { id: 'b2', studentId: 'stu-1', packageId: 'pk-1', date: DAY(20), hour: 18, minute: 0, plannedMinutes: 90, typeName: '力量训练', status: 'done' }
    ],
    // 故意倒着放：明细里仍然必须按日期升序。
    incomes: [
      { id: 'i2', bookingId: 'b2', studentId: 'stu-1', date: DAY(20), typeName: '力量训练', amount: 100 },
      { id: 'i1', bookingId: 'b1', studentId: 'stu-1', date: DAY(12), typeName: '常规训练', amount: 140 }
    ],
    sales: [], settings: baseSettings()
  })
  const list = page.data.historyClassList
  assert.equal(list.length, 1)
  assert.equal(list[0].name, '测试学员小蓝')
  assert.equal(list[0].count, 2)
  assert.equal(list[0].amount, 240)
  assert.equal(page.data.historyClass, 240)
  assert.equal(page.data.historyClassCount, 2)
  const lessons = list[0].lessons
  assert.equal(lessons.length, 2)
  assert.equal(lessons[0].date, DAY(12))
  assert.equal(lessons[0].timeText, '09:30–10:30')
  assert.equal(lessons[0].amount, 140)
  assert.equal(lessons[0].durationText, '60 分钟')
  assert.equal(lessons[0].statusText, '已完成')
  assert.equal(lessons[1].date, DAY(20))
  assert.equal(lessons[1].timeText, '18:00–19:30')
  assert.equal(lessons[1].amount, 100)
  assert.equal(lessons[1].durationText, '90 分钟')
  assert.equal(settlement.lessonAmountTotal(lessons), list[0].amount, '⛔ 汇总金额必须与展开明细逐笔一致')
  assert.equal(settlement.lessonAmountTotal(lessons), page.data.historyClass, '明细合计必须等于月份总额')
  // 展开开关：默认收起，点一下展开，再点一下收起。
  assert.equal(list[0].open, false)
  page.toggleHistoryStudent({ currentTarget: { dataset: { i: 0 } } })
  assert.equal(page.data.historyClassList[0].open, true)
  page.toggleHistoryStudent({ currentTarget: { dataset: { i: 0 } } })
  assert.equal(page.data.historyClassList[0].open, false)
})

await runner('⑧ 取消的、还没上的课不许混进已完成收入', async () => {
  world.reset(); world.installRuntime()
  const page = statsPageFor({
    students: [studentRow()],
    bookings: [
      { id: 'b1', studentId: 'stu-1', packageId: 'pk-1', date: DAY(12), hour: 9, minute: 30, plannedMinutes: 60, typeName: '常规训练', status: 'done' },
      { id: 'b2', studentId: 'stu-1', packageId: 'pk-1', date: DAY(15), hour: 10, minute: 0, plannedMinutes: 60, typeName: '常规训练', status: 'booked' },
      { id: 'b3', studentId: 'stu-1', packageId: 'pk-1', date: DAY(18), hour: 11, minute: 0, plannedMinutes: 60, typeName: '常规训练', status: 'cancelled' }
    ],
    incomes: [{ id: 'i1', bookingId: 'b1', studentId: 'stu-1', date: DAY(12), typeName: '常规训练', amount: 140 }],
    sales: [], settings: baseSettings()
  })
  const lessons = page.data.historyClassList[0].lessons
  assert.equal(lessons.length, 1, `只有已完课的那节才能出现在收入明细里（实测 ${JSON.stringify(lessons)}）`)
  assert.equal(lessons[0].bookingId, 'b1')
  assert.ok(lessons.every(lesson => lesson.statusText === '已完成'), '⛔ 待上课 / 已取消不许混入')
  assert.equal(settlement.lessonAmountTotal(lessons), 140)
})

await runner('⑨ 真页面上的缺字段：时间写「未记录」，booking 缺失写「未记录」，但金额与汇总照旧', async () => {
  world.reset(); world.installRuntime()
  const page = statsPageFor({
    students: [studentRow()],
    bookings: [{ id: 'b1', studentId: 'stu-1', packageId: 'pk-1', date: DAY(8), typeName: '常规训练', status: 'done' }],
    incomes: [
      { id: 'i1', bookingId: 'b1', studentId: 'stu-1', date: DAY(8), typeName: '常规训练', amount: 100 },
      { id: 'i2', bookingId: 'gone', studentId: 'stu-1', date: DAY(9), typeName: '常规训练', amount: 100 }
    ],
    sales: [], settings: baseSettings()
  })
  const list = page.data.historyClassList
  const lessons = list[0].lessons
  assert.equal(lessons.length, 2)
  assert.equal(lessons[0].date, DAY(8), 'booking 有日期 ⇒ 用 booking 的日期')
  assert.equal(lessons[0].startTime, UNRECORDED, 'booking 没存 hour/minute ⇒ 开始时间「未记录」')
  assert.equal(lessons[0].endTime, UNRECORDED, 'booking 没存时长 ⇒ 结束时间「未记录」')
  assert.equal(lessons[0].statusText, '已完成')
  assert.equal(lessons[1].date, DAY(9), 'booking 不见了 ⇒ 退回收入快照上的日期')
  assert.equal(lessons[1].statusText, UNRECORDED, 'booking 不见了 ⇒ 完课状态不许猜')
  assert.equal(list[0].amount, 200)
  assert.equal(settlement.lessonAmountTotal(lessons), 200, '缺字段也不许影响合计')
})

// ---------------------------------------------------------------- C. M2 跨教练（真云 handlers + 真页面）

function localDbFor(coach) {
  const dataOf = name => world.dataRows(name, coach.owner, coach.datasetId).map(row => copy(row))
  const packages = dataOf('packages')
  const students = dataOf('students').map(student => ({ ...student, packages: packages.filter(pkg => pkg.studentId === student.id) }))
  return { students, packages, bookings: dataOf('bookings'), incomes: dataOf('incomes'), sales: dataOf('sales'), settings: baseSettings() }
}

function enterStats(coach) {
  world.setActor(coach)
  world.storage.coachSandboxActiveCache = { environment: 'sandbox', datasetId: coach.datasetId, revision: 0, snapshot: localDbFor(coach) }
  const page = world.enterPage(STATS_PAGE)
  page.setData({ historyMonth: MONTH })
  page.renderHistory()
  return page
}

async function seedTwoTaughtLessons() {
  setEnvironment('sandbox')
  const A = world.seedCoach('openid-a', 'ds-a', 'PUBCODEA')
  const B = world.seedCoach('openid-b', 'ds-b', 'PUBCODEB')
  world.seedStudent(A, 'stu-1', 'M2 共享测试学员')
  const sold = await world.execute(A, 'createCourseSale', {
    studentId: 'stu-1', type: '常规训练', total: TOTAL, remaining: TOTAL, quantity: TOTAL,
    unitPrice: UNIT_PRICE, amount: SALE_AMOUNT, date: todayKey(), teachingPublicCodes: [B.publicCode]
  })
  assert.equal(sold.ok, true, JSON.stringify(sold))
  const packageId = sold.result.packageId
  const teach = async (day, hour, minute, plannedMinutes) => {
    const booked = await world.execute(B, 'createAuthorizedBooking', { studentId: 'stu-1', packageId, date: DAY(day), hour, minute, plannedMinutes })
    assert.equal(booked.ok, true, JSON.stringify(booked))
    const bookingId = booked.result.bookingId
    await world.execute(B, 'updateBookingContent', { bookingId, items: [{ name: '卧推', sets: 4, reps: 12, weight: '40' }] })
    const done = await world.execute(B, 'completeBooking', { bookingId })
    assert.equal(done.ok, true, JSON.stringify(done))
    return bookingId
  }
  // 先上 2 号再上 1 号 ⇒ 明细顺序不能靠"收入的写入顺序"，只能靠日期。
  const second = await teach(2, 14, 0, 90)
  const first = await teach(1, 9, 30, 60)
  // 第三节排了又取消 ⇒ 不许产生收入，也不许出现在明细里。
  const third = await world.execute(B, 'createAuthorizedBooking', { studentId: 'stu-1', packageId, date: DAY(3), hour: 16, minute: 0, plannedMinutes: 60 })
  assert.equal(third.ok, true, JSON.stringify(third))
  const cancelled = await world.execute(B, 'cancelBooking', { bookingId: third.result.bookingId })
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
  return { A, B, packageId, first, second, cancelledId: third.result.bookingId }
}

await runner('⑩ B 手机上：M2 共享学员的两节课都在，金额是 B 的教学收入（不是 A 的销售业绩）', async () => {
  world.reset(); world.installRuntime()
  const { B, first, second } = await seedTwoTaughtLessons()
  const page = enterStats(B)
  const list = page.data.historyClassList
  assert.equal(list.length, 1, `B 的课时结算里只能有这一个会员（实测 ${JSON.stringify(list.map(x => x.name))}）`)
  assert.equal(list[0].name, 'M2 共享测试学员')
  assert.equal(list[0].count, 2)
  assert.equal(list[0].amount, UNIT_PRICE * 2, `两节 × 单价快照（实测 ${list[0].amount}）`)
  const lessons = list[0].lessons
  assert.equal(lessons.length, 2)
  assert.deepEqual(lessons.map(lesson => lesson.bookingId).sort(), [first, second].sort(), '⛔ 明细必须挂在真 bookingId 上')
  assert.equal(lessons[0].date, DAY(1))
  assert.equal(lessons[0].timeText, '09:30–10:30')
  assert.equal(lessons[0].amount, UNIT_PRICE)
  assert.equal(lessons[0].durationText, '60 分钟')
  assert.equal(lessons[0].statusText, '已完成')
  assert.equal(lessons[1].date, DAY(2))
  assert.equal(lessons[1].timeText, '14:00–15:30')
  assert.equal(lessons[1].amount, UNIT_PRICE)
  assert.equal(lessons[1].durationText, '90 分钟')
  assert.equal(settlement.lessonAmountTotal(lessons), list[0].amount)
  assert.equal(page.data.historyClass, UNIT_PRICE * 2, 'B 的教学收入只数自己上的课')
  assert.equal(page.data.historySales, 0, '⛔ A 的 500 元销售业绩不许出现在 B 的账上')
  assert.ok(!JSON.stringify(page.data.historyClassList).includes(String(SALE_AMOUNT)), '明细里不许出现销售金额')
})

await runner('⑪ 取消的那节课不进明细（跨教练同样成立）', async () => {
  world.reset(); world.installRuntime()
  const { B, cancelledId } = await seedTwoTaughtLessons()
  const lessons = enterStats(B).data.historyClassList[0].lessons
  assert.equal(lessons.length, 2)
  assert.ok(!lessons.some(lesson => lesson.bookingId === cancelledId), '取消的课不许产生收入明细')
  assert.ok(lessons.every(lesson => lesson.statusText === '已完成'))
})

await runner('⑫ A 手机上：教学收入 0 · 销售业绩 500 ⇒ 两边的钱没有被串账', async () => {
  world.reset(); world.installRuntime()
  const { A } = await seedTwoTaughtLessons()
  const page = enterStats(A)
  assert.equal(page.data.historyClassList.length, 0, 'A 没上课 ⇒ A 的课时明细必须是空的')
  assert.equal(page.data.historyClass, 0)
  assert.equal(page.data.historySales, SALE_AMOUNT, 'A 的原始销售业绩一个字都不许被改写')
})

await runner('⑬ wxml 里引用的每个字段都真实存在（防"真机一片空白" / 两个真相源）', async () => {
  world.reset(); world.installRuntime()
  const page = statsPageFor({
    students: [studentRow()],
    bookings: [
      { id: 'b1', studentId: 'stu-1', packageId: 'pk-1', date: DAY(12), hour: 9, minute: 30, plannedMinutes: 60, typeName: '常规训练', status: 'done' },
      { id: 'b2', studentId: 'stu-1', packageId: 'pk-1', date: DAY(20), hour: 18, minute: 0, plannedMinutes: 90, typeName: '力量训练', status: 'done' }
    ],
    incomes: [
      { id: 'i2', bookingId: 'b2', studentId: 'stu-1', date: DAY(20), typeName: '力量训练', amount: 100 },
      { id: 'i1', bookingId: 'b1', studentId: 'stu-1', date: DAY(12), typeName: '常规训练', amount: 140 }
    ],
    sales: [], settings: baseSettings()
  })
  const wxml = require('fs').readFileSync(path.join(__dirname, '..', 'pages', 'stats', 'stats.wxml'), 'utf8')
  const lesson = page.data.historyClassList[0].lessons[0]
  const fields = [...wxml.matchAll(/\{\{lesson\.([A-Za-z0-9_]+)\}\}/g)].map(match => match[1])
  assert.ok(fields.length >= 5, `明细至少要展示 5 个字段（实测 ${fields.join(',')}）`)
  fields.forEach(field => {
    assert.ok(Object.prototype.hasOwnProperty.call(lesson, field), `wxml 用了 lesson.${field}，但明细数据里没有这个字段`)
    assert.notEqual(lesson[field], undefined, `lesson.${field} 不许是 undefined`)
  })
  assert.ok(wxml.includes(`wx:for="{{item.lessons}}"`), '明细必须遍历 item.lessons')
  assert.ok(wxml.includes(`wx:if="{{item.open}}"`), '展开状态只有一个来源：item.open')
  assert.ok(wxml.includes('bindtap="toggleHistoryStudent"'), '会员行必须能点开')
  assert.equal(typeof page.toggleHistoryStudent, 'function', '页面必须有这个展开方法')
})

  setEnvironment('production')
  if (!process.exitCode) process.stdout.write('ALL HISTORY SETTLEMENT LESSON DETAIL TESTS PASSED\n')
})().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
