// M2 真机 BUG 05：跨教练排课**选了 9-30 却排到 9-29**（2026-09-29）。
//
// ★★ 真机复现（用户实测，两次）★★
//   第一次：B 在「多教练服务 → 用授权课包排课」里选 2026-09-30 → 点确认排课，
//           课表上那节课却出现在 **2026-09-29**（用户以为自己点错，手动取消了）。
//   第二次：重新打开排课弹窗，选 2026-09-30，**日期输入框立刻又变回 2026-09-29**（这次还没点确认）。
//
// ★★ 根因（一处，两次现象同源）★★
//   旧工作台的日期选择器把结果写进 `booking.dateIndex`，
//   但**显示**和**提交**都读 `booking.date`，而 `booking.date` 只在 openBooking() 里
//   被赋一次值（= dates[0]，也就是今天），此后**没有任何人更新过它**。
//   ⇒ 选了 9-30：显示纹丝不动（第二次现象），提交仍是 9-29（第一次现象）。
//   ⚠️ 这是「两个真相源」的经典形状：写 A 读 B，且 B 是个只初始化一次的快照。
//
// ⭐⭐ 2026-10-06：出口换了，根因形状**一个字都没换** ⭐⭐
//   旧工作台 `pages/coach-authorization` 已随认领方案下线；跨教练排课现在走**学员列表页**
//   （点那张授权会员卡 → 只读详情 → 排课）。新出口只有一个 `booking.date`，
//   picker 直接写它、显示直接读它、提交直接读它 ⇒ 这个 BUG 的形状被**结构性消灭**了。
//   ⇒ 本文件改成钉住"新出口不许再把两个真相源带回来"：
//      · 显示 = 提交 = 落库（三方同一个值）；
//      · 静态：不许再出现 `dateIndex` / `dates[0]` 那种只初始化一次的快照字段。
//
// ★★ 本文件怎么测（不靠手工构造 payload）★★
//   · 真的 `pages/students`（stub Page/wx）+ 真 handlers + 假 DB；
//   · **从 wxml 里抽出那一格的表达式，在页面的真实 data 上求值** ⇒ 测的是"用户看到的那一格"；
//   · 端到端：渲染出来的日期 必须 === 发出去的 payload.date 必须 === 云端落库的那条 date。
//
// 覆盖：① 第一次现象（提交的日期）② 第二次现象（显示的日期）③ picker value 跟着真实日期
//       ④ 逐日期三方一致（最硬的一条）⑤ 关掉再开仍然正常 ⑥ 取不到日期明确拒绝、零命令
//       ⑦ 不破坏 BUG03 ⑧ 不破坏 BUG04 ⑨ 时辰链路未被带坏 ⑩ 不许再有第二个真相源

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createStudentsBookingWorld, test } = require('./helpers/students-booking-world')
const { addDateDays } = require('../cloudfunctions/coachBusinessCommand/occupancy')
const { todayKey } = require('../utils/beijing-date')

const WXML_PATH = path.join(__dirname, '..', 'pages', 'students', 'students.wxml')
const PAGE_PATH = path.join(__dirname, '..', 'pages', 'students', 'students.js')
const world = createStudentsBookingWorld()

// ⭐ 从 wxml 里**抽出日期那一格**，在真实 data 上求值 ⇒ 测的是"用户看到的那一格"，不是我复算的。
//    只测 data 层（booking.date）抓不到 BUG05：当时写进去的那个字段也是对的，
//    错的是"显示/提交读的是另一个字段"。
function datePickerParts() {
  const wxml = fs.readFileSync(WXML_PATH, 'utf8')
  const block = wxml.match(/<picker[^>]*mode="date"[\s\S]*?<\/picker>/)
  assert.ok(block, '学员页 wxml 里必须有一个 mode="date" 的日期选择器')
  const tag = block[0]
  const valueMatch = tag.match(/value="\{\{([^}]+)\}\}"/)
  const cellMatch = tag.match(/<view[^>]*>\{\{([^}]+)\}\}<\/view>/)
  assert.ok(valueMatch, `日期 picker 的 value 必须绑定表达式（实测 ${tag.slice(0, 160)}）`)
  assert.ok(cellMatch, `日期那一格必须有显示表达式（实测 ${tag.slice(0, 160)}）`)
  return { valueExpr: valueMatch[1], cellExpr: cellMatch[1], tag }
}
function evalOn(expr, data) {
  return new Function('data', `with (data) { return (${expr}) }`)(data)
}
// 模拟用户在日期选择器里选了某一天（新出口：picker 直接给日期字符串）
const pickDate = (page, date) => page.onBookingDate({ detail: { value: date } })
const plusDays = n => addDateDays(todayKey(), n)

;(async () => {
  // ————— ① 第一次现象：选了明天，**提交并落库**的必须是明天，不是今天
  await test('① BUG05 第一次：选明天 → 排出来的课必须在明天（不是今天）', async () => {
    world.reset()
    const { B } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    const tomorrow = plusDays(1)
    world.openBooking(page)
    pickDate(page, tomorrow)
    await page.confirmBooking()
    const sent = world.calls.find(item => item.command === 'createAuthorizedBooking')
    assert.ok(sent, '页面必须真的发出 createAuthorizedBooking')
    assert.equal(sent.payload.date, tomorrow, `⛔ 提交的日期必须是选的那天（实测 ${JSON.stringify(sent.payload)}）`)
    assert.ok(!world.modals.length, `不该弹错（实测 ${JSON.stringify(world.modals)}）`)
    // 云端落库的那一条（课表的数据源）
    const booked = world.dataRows('bookings', B.owner, B.datasetId)
    assert.equal(booked.length, 1, '必须只排出一节课')
    assert.equal(booked[0].date, tomorrow, `⛔ 落库日期必须是选的那天（实测 ${JSON.stringify(booked[0])}）`)
  })

  // ————— ② 第二次现象：选完那一瞬间，**显示**的就必须已经是明天
  await test('② BUG05 第二次：选完明天，日期那一格必须立刻显示明天（不许弹回今天）', async () => {
    world.reset()
    const { B } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    world.openBooking(page)
    const parts = datePickerParts()
    const today = todayKey(), tomorrow = plusDays(1)
    assert.equal(evalOn(parts.cellExpr, page.data), today, '刚打开时显示今天')
    pickDate(page, tomorrow)
    assert.equal(page.data.booking.date, tomorrow, 'booking.date 必须被更新（且它就是唯一那个真相源）')
    assert.equal(evalOn(parts.cellExpr, page.data), tomorrow,
      `⛔ 选完必须显示选的那天（实测渲染值 ${JSON.stringify(evalOn(parts.cellExpr, page.data))}，表达式 ${parts.cellExpr}）`)
  })

  // ————— ③ picker 的 value 必须跟着真实日期（写死就是"表面能选、实际没选"）
  await test('③ 日期 picker 的 value 必须绑定 booking.date，不许写死', async () => {
    const parts = datePickerParts()
    assert.ok(!/value="\d{4}-\d{2}-\d{2}"/.test(parts.tag), `value 不许写死某个日期（实测 ${parts.tag.slice(0, 160)}）`)
    assert.equal(parts.valueExpr, 'booking.date', `value 必须读 booking.date（实测 ${parts.valueExpr}）`)
    world.reset()
    const { B } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    world.openBooking(page)
    assert.equal(evalOn(parts.valueExpr, page.data), todayKey())
    const target = plusDays(6)
    pickDate(page, target)
    assert.equal(evalOn(parts.valueExpr, page.data), target, `value 必须跟着真实日期（实测 ${evalOn(parts.valueExpr, page.data)}）`)
  })

  // ————— ④ 最硬的一条：逐日期，**渲染值 === payload.date === 落库 date**
  //        只要再出现"显示读 A、提交读 B"，这三方立刻对不上。
  await test('④ 逐日期三方一致：看到的 = 提交的 = 落库的（显示与提交不许两个源）', async () => {
    for (const offset of [0, 1, 3, 7, 20]) {
      // ⚠️ 每个日期都要**重开一份世界**：否则 `calls.find` 抓到的是上一次迭代的记录（假绿），
      //    残留的 receipt 还会让第二次迭代被"同一 requestId"拒掉 —— 两件事都测不到真实行为。
      world.reset()
      const { B } = await world.seedSharedScenario()
      const page = await world.openAs(B)
      world.openBooking(page)
      const expect = plusDays(offset)
      pickDate(page, expect)
      const parts = datePickerParts()
      const rendered = evalOn(parts.cellExpr, page.data)
      await page.confirmBooking()
      const sentAll = world.calls.filter(item => item.command === 'createAuthorizedBooking')
      assert.equal(sentAll.length, 1, `+${offset} 天必须只发一条（实测 ${sentAll.length}）`)
      const sent = sentAll[0]
      assert.ok(!world.modals.length, `+${offset} 天不该弹错（实测 ${JSON.stringify(world.modals)}）`)
      const booked = world.dataRows('bookings', B.owner, B.datasetId)[0]
      assert.equal(rendered, expect, `+${offset} 天渲染值不对（实测 ${rendered}）`)
      assert.equal(sent.payload.date, expect, `+${offset} 天 payload 日期不对（实测 ${sent.payload.date}｜booking=${JSON.stringify(page.data.booking)}｜modals=${JSON.stringify(world.modals)}）`)
      assert.equal(booked.date, expect, `+${offset} 天落库日期不对（实测 ${booked.date}）`)
      assert.ok(rendered === sent.payload.date && sent.payload.date === booked.date,
        `+${offset} 天 ⛔ 三方必须同一个值（渲染 ${rendered} / payload ${sent.payload.date} / 落库 ${booked.date}）`)
    }
  })

  // ————— ⑤ 关掉再开：日期复位到今天，且能再次正常选择并提交
  await test('⑤ 关掉排课面板再打开：日期复位到今天，且能再次正常选择并提交', async () => {
    world.reset()
    const { B } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    world.openBooking(page)
    pickDate(page, plusDays(5))
    page.closeBooking()
    assert.equal(page.data.booking.open, false, '必须真的收起')
    page.openBooking()
    const parts = datePickerParts()
    assert.equal(evalOn(parts.cellExpr, page.data), todayKey(), '重新打开必须复位到今天')
    const target = plusDays(2)
    pickDate(page, target)
    await page.confirmBooking()
    const sent = world.calls.find(item => item.command === 'createAuthorizedBooking')
    assert.equal(sent.payload.date, target, `重开后仍必须提交选的那天（实测 ${sent.payload.date}）`)
  })

  // ————— ⑥ 日期取不到 ⇒ 明确拒绝 + 零命令（绝不静默退化成今天）
  await test('⑥ 日期取不到时必须明确提示，且一条命令都不许发', async () => {
    world.reset()
    const { B } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    world.openBooking(page)
    page.setData({ 'booking.date': '' })   // 模拟日期没读到
    await page.confirmBooking()
    assert.equal(world.calls.filter(item => item.command === 'createAuthorizedBooking').length, 0, '⛔ 日期不明不许出网')
    assert.equal(world.modals.length, 1, `⛔ 必须明确提示（实测 ${JSON.stringify(world.modals)}）`)
    assert.ok(/日期/.test(world.modals[0].content), `提示必须说清是日期的问题（实测 ${world.modals[0].content}）`)
  })

  // ————— ⑦ 不破坏 BUG03：payload 仍带真实 packageId，A 的余额正确占座
  await test('⑦ 不破坏 BUG03：payload 带真实 packageId，A 那本账 剩5/占1/还能约4', async () => {
    world.reset()
    const { A, B, packageId } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    world.openBooking(page)
    pickDate(page, plusDays(1))
    await page.confirmBooking()
    const sent = world.calls.find(item => item.command === 'createAuthorizedBooking')
    assert.equal(sent.payload.packageId, packageId, 'packageId 必须仍然是真实 ID')
    assert.deepStrictEqual(world.occOf(A, packageId), { remaining: 5, reserved: 1, availableToBook: 4 }, 'A 那本账必须正确')
  })

  // ————— ⑧ 不破坏 BUG04：B 能读回这条预约（课表数据源），且日期正确
  await test('⑧ 不破坏 BUG04：B 读回的课表里，这节课在**选的那天**', async () => {
    world.reset()
    const { A, B } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    world.openBooking(page)
    const target = plusDays(4)
    pickDate(page, target)
    await page.confirmBooking()
    // 跨账预约**物理落在授课教练 B 这本账**（BUG04 已定案；A 账 0 条）⇒ 这就是 B 课表的数据源。
    const back = world.dataRows('bookings', B.owner, B.datasetId)
    assert.equal(back.length, 1, 'B 的课表必须有这节课')
    assert.equal(back[0].date, target, `⛔ 课表这节课必须在选的那天（实测 ${back[0].date}，期望 ${target}）`)
    assert.equal(back[0].teachingCoachId, B.owner, '授课教练必须是 B')
    assert.equal(world.rows('bookings', A.owner, A.datasetId).length, 0, 'A 账里一条预约都不能有')
    // 课表按日期分组（schedule.js 的 byDate）⇒ 选的那天必须能取到它，今天必须取不到。
    const byDate = {}
    for (const item of back) (byDate[item.date] = byDate[item.date] || []).push(item)
    assert.ok((byDate[target] || []).length === 1, `课表在 ${target} 必须显示这节课`)
    assert.ok(!(byDate[todayKey()] || []).length, '⛔ 今天那一格不该出现它（BUG05 的症状就是它跑到今天去）')
  })

  // ————— ⑨ 时辰链路没被带坏（日期 / 时间 / 时长三条共用同一个 booking 对象）
  await test('⑨ 时辰与时长链路未受伤：time / minutes 仍正确进 payload', async () => {
    world.reset()
    const { B } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    world.openBooking(page)
    const target = plusDays(1)
    pickDate(page, target)
    page.onBookingTime({ detail: { value: '09:30' } })
    page.onBookingMinutes({ detail: { value: '90' } })
    await page.confirmBooking()
    const sent = world.calls.find(item => item.command === 'createAuthorizedBooking')
    assert.equal(sent.payload.hour, 9, `小时必须来自时间字符串（实测 ${sent.payload.hour}）`)
    assert.equal(sent.payload.minute, 30, `分钟必须来自时间字符串（实测 ${sent.payload.minute}）`)
    assert.equal(sent.payload.plannedMinutes, 90, `时长必须来自时长选择（实测 ${sent.payload.plannedMinutes}）`)
    assert.equal(sent.payload.date, target, '日期同时仍然正确')
  })

  // ————— ⑩ 静态：不许再有第二个真相源
  await test('⑩ 静态：排课链路里不许再出现「dateIndex / dates[0]」这种只初始化一次的快照', async () => {
    const js = fs.readFileSync(PAGE_PATH, 'utf8').split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))   // 先剥注释，注释里讲根因不算
      .join('\n')
    assert.ok(!/dateIndex/.test(js), '⛔ 不许再有 dateIndex（它是 BUG05 的根因形状：写 A 读 B）')
    assert.ok(!/date:\s*dates\[0\]/.test(js), '⛔ 不许再用一个只在开弹窗时赋一次的日期快照')
    // ⛔ 反过来必须成立：**只有一个**赋值点，且显示 / 提交都读它。
    const writes = js.match(/'booking\.date'/g) || []
    const reads = js.match(/booking\.date\b/g) || []
    assert.ok(writes.length >= 1, '必须真的写了 booking.date')
    assert.ok(reads.length >= 2, `显示与提交必须都读同一个字段（实测读到 ${reads.length} 处）`)
    const parts = datePickerParts()
    assert.equal(parts.cellExpr, 'booking.date', `⛔ 那一格必须渲染 booking.date（实测 ${parts.cellExpr}）`)
  })

  world.runtime.setEnvironment('production')
  if (!process.exitCode) process.stdout.write('ALL BUG05 AUTHORIZED BOOKING DATE TESTS PASSED\n')
})().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
