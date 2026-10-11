// M2 V1 真机 BUG 03：跨教练预约 packageId 为空（2026-09-28）。
//
// ★★ 事故回顾 ★★
//   真机：A 在 Sandbox 创建会员与「常规训练」课包（总 5 / 剩 5 / 单价 100 / 业绩 500），
//   创建销售时填了 B 的公开邀请码 => B 手机上正确显示会员与「剩余 5 · 已占 0 · 还能约 5」；
//   进入「多教练服务 → 用授权课包排课」，页面正确列出那份课包，
//   但点「确认排课」 => **排课未成功 · packageId不能为空**。
//
// ★★ 根因 ★★
//   课时包在库里是**两层**：row 层有 `packageId`，而 data 层里这个字段叫 `id`。
//   授权目录投影的是 **data 层**，取 `pkg.packageId` => 恒为 undefined => 整个字段被丢掉。
//   前端拿不到真实 ID => 提交空 packageId => 云端 `text(payload.packageId,'packageId')` 抛「packageId不能为空」。
//
// ⭐⭐ 2026-10-06：出口换了，故障形状**一个字都没换** ⭐⭐
//   旧工作台 `pages/coach-authorization` 已随认领方案下线；跨教练排课现在走**学员列表页**
//   （点那张授权会员卡 → 只读详情 → 排课）。课时包仍然来自**同一份云端目录投影**，
//   ⇒ "投影里少了 packageId / 客户端提交空值"这两处缺口仍然必须各自独立成立。
//
// ★★ 本文件的核心：**真实 Page 事件链** ★★
//   · 真的 `pages/students/students.js`（stub `Page` / `wx`）；
//   · 云端是真的 `createService` + 真 handlers + 假 DB（只替网络）；
//   · **默认选中**后直接 confirmBooking（不手工挑课包）=> 记录 mutate 真正发出的 payload；
//   => 只测「手工构造正确 payload」的那种测试在这里过不去，字段一断当场红。
//
// 覆盖：① 默认选中带着真实 packageId ② 排课成功 ③ A/B 同一份余额（剩 5 / 占 1 / 还能约 4）
//       ④ 重复提交不产生重复预约 ⑤ 未授权教练被拒 ⑥ 缺真实 packageId 必须明确失败
//       ⑦ 不写第二份会员 / 课包 / 余额。

const assert = require('assert')
const { createStudentsBookingWorld, test } = require('./helpers/students-booking-world')

const world = createStudentsBookingWorld()

;(async () => {
  // ————— ① 默认选中就必须带着**真实** packageId（不点第二下、不手工挑）
  await test('① B 打开授权会员卡：默认选中的那份课包必须带着真实 packageId', async () => {
    world.reset()
    const { B, packageId } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    const card = (page.data.students || []).find(item => item && item.authorized)
    assert.ok(card, `学员列表里必须有那张授权会员卡（实测 ${JSON.stringify((page.data.students || []).map(i => i && i.id))}）`)
    assert.equal(card.packages[0].packageId, packageId, `授权目录必须给出真实课包 ID（实测 ${JSON.stringify(card.packages[0])}）`)
    const booking = world.openBooking(page)
    assert.equal(booking.packageId, packageId, `默认选中的提交用 ID 不能是空的（实测 ${JSON.stringify(booking)}）`)
  })

  // ————— ② 直接确认排课成功（payload 由页面自己组装，不是我手工写的）
  await test('② 默认选中后直接确认排课：payload 带真实 packageId 且排课成功', async () => {
    world.reset()
    const { B, packageId } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    world.openBooking(page)
    await page.confirmBooking()
    const sent = world.calls.find(item => item.command === 'createAuthorizedBooking')
    assert.ok(sent, '页面必须真的发出 createAuthorizedBooking')
    assert.equal(sent.payload.packageId, packageId, `payload 必须携带真实 packageId（实测 ${JSON.stringify(sent.payload)}）`)
    assert.ok(!world.modals.length, `不该弹错（实测 ${JSON.stringify(world.modals)}）`)
    assert.equal(page.data.booking.open, false, '成功后要收起排课面板')
  })

  // ————— ③ A / B 看到的是同一份余额：剩 5 · 已占 1 · 还能约 4
  await test('③ 排课后 A / B 读到同一份课时事实（剩 5 / 占 1 / 还能约 4）', async () => {
    world.reset()
    const { A, B, packageId } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    world.openBooking(page)
    await page.confirmBooking()
    // ① A 那本账（课时包物理所在）：remaining 是权威值，reserved 是占座计数器。
    assert.deepStrictEqual(world.occOf(A, packageId), { remaining: 5, reserved: 1, availableToBook: 4 }, 'A 那本账必须是同一份真值')
    // ② 云端目录（B 唯一的读取通道）：同一行的三值，不是本地推算出来的第二套余额。
    const directory = await world.readDirectory(B)
    const shared = directory.serving[0].packages.find(item => item.packageId === packageId)
    assert.strictEqual(shared.remaining, 5)
    assert.strictEqual(shared.reserved, 1)
    assert.strictEqual(shared.availableToBook, 4)
    // ③ 页面最终渲染出来的那一行（学员列表里那张授权会员卡）。
    const card = (page.data.students || []).find(item => item && item.authorized)
    assert.ok(card, '排完课之后那张卡必须还在列表里')
    assert.strictEqual(card.packages[0].left, 5, '卡片上的剩余课时必须是同一份真值')
    assert.strictEqual(card.packages[0].occupancy, '剩余 5 · 已占 1 · 还能约 4')
  })

  // ————— ④ 重复提交不能产生重复预约
  await test('④ 重复提交：不产生第二条预约、占座不翻倍', async () => {
    world.reset()
    const { A, B, packageId } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    world.openBooking(page)
    await page.confirmBooking()
    page.openBooking()
    await page.confirmBooking()
    assert.equal(world.rows('bookings', B.owner, B.datasetId).length, 1, 'B 账里只能有一条预约')
    assert.deepStrictEqual(world.occOf(A, packageId), { remaining: 5, reserved: 1, availableToBook: 4 }, '占座不许翻倍')
    const directory = await world.readDirectory(B)
    assert.equal(directory.serving[0].upcoming.length, 1, '未来预约也只能有一条')
  })

  // ————— ⑤ 未授权教练不能用这份课包
  await test('⑤ 未授权教练拿着同一个 packageId 必须被双层权限挡住', async () => {
    world.reset()
    const { packageId } = await world.seedSharedScenario()
    const C = world.seedCoach('openid-c', 'ds-c', 'PUBCODEC')
    const denied = await world.execute(C, 'createAuthorizedBooking', { studentId: 'stu-1', packageId, date: '2030-01-01', hour: 10, minute: 0 })
    assert.equal(denied.ok, false, '未授权教练不许跨账排课')
    // 两层都缺时先撞到哪一层由服务端定，但必须是双层里的某一个码 —— 绝不许放行，也不许猜 ID。
    assert.ok(['MEMBER_SERVICE_NOT_AUTHORIZED', 'PACKAGE_TEACHING_NOT_AUTHORIZED'].includes(denied.code), `必须报双层授权码（实测 ${denied.code}）`)
    assert.equal(world.rows('bookings', C.owner, C.datasetId).length, 0)
  })

  // ————— ⑥ 缺少真实 packageId 必须明确失败，不许伪造 / 猜测
  //   ⭐ 两层都要判：① 客户端**出网前**就拒绝（不许带空值出去，也不许拿课程类型顶替）；
  //      ② 服务端闸门仍然独立成立（客户端不是安全边界 —— 绕过它直接发空值也要被拒）。
  await test('⑥ packageId 为空必须明确失败：客户端零发送 + 服务端明确拒绝', async () => {
    world.reset()
    const { B } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    world.openBooking(page)
    page.setData({ 'booking.packageId': '' })
    await page.confirmBooking()
    // ① 客户端：一条命令都不许发出去。
    assert.equal(world.calls.filter(item => item.command === 'createAuthorizedBooking').length, 0, '不许带着空 packageId 出网')
    assert.ok(world.toasts.length || world.modals.length, '必须给出明确的失败提示，不许静默')
    const said = [...world.toasts.map(item => item.title), ...world.modals.map(item => `${item.title}${item.content || ''}`)].join('｜')
    assert.ok(/课时包/.test(said), `失败原因要说到课时包（实测 ${said}）`)
    // ② 服务端：绕过客户端直接发空值，也必须被 `text(payload.packageId,'packageId')` 拒。
    const denied = await world.execute(B, 'createAuthorizedBooking', { studentId: 'stu-1', packageId: '', date: '2030-01-01', hour: 10, minute: 0 })
    assert.equal(denied.ok, false, '服务端必须拒绝空 packageId')
    assert.ok(/packageId/.test(String(denied.message || '')), `服务端必须说出是 packageId（实测 ${denied.message}）`)
    assert.equal(world.rows('bookings', B.owner, B.datasetId).length, 0, '被拒绝的排课不许留下任何预约')
  })

  // ————— ⑦ 全程不产生第二份会员 / 课包 / 余额
  await test('⑦ B 账里始终没有复制出来的会员 / 课时包 / 销售', async () => {
    world.reset()
    const { B } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    world.openBooking(page)
    await page.confirmBooking()
    assert.equal(world.rows('students', B.owner, B.datasetId).length, 0, '不许复制会员')
    assert.equal(world.rows('packages', B.owner, B.datasetId).length, 0, '不许产生第二份课时包 / 余额')
    assert.equal(world.rows('sales', B.owner, B.datasetId).length, 0, '销售业绩不转移到 B')
  })

  world.runtime.setEnvironment('production')
  if (!process.exitCode) process.stdout.write('ALL M2 AUTHORIZED BOOKING PAGE TESTS PASSED\n')
})().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
