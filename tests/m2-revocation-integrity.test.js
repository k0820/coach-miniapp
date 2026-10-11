// M2 V1 · M2 撤销后的完整性加固（2026-09-30）。
//
// ⛳ 背景：真机已经**真的发生过一次** A → B 的撤销（A 移除 B 的授课授权，A 手机可授课教练 2 → 1，
//    B 手机刷新后「授权给我服务的会员 0 / 我管理着的课时包 0」）。这一批测试守的是**撤销之后**那一整条链：
//   ① 云端目录立刻更新  ② 授权行变 revoked 不是删行  ③ 云端**始终**重新校验（旧 packageId 再排课必被拒）
//   ④ 历史教学记录 / 历史收入 / A 的原始销售与剩余课时一个字节都不许动
//   ⑤ 撤销之后 A 自己那本账照旧能排课（账本所有者不需要授权行 —— 旧数据零迁移的支点）
//   ⑥ B 的本地缓存**不会自己消失**（学员页 onShow 零云调用是设计，不是 bug）
//   ⑦ ⭐ 于是 B 用旧帧点排课被云端拒绝后，**页面必须自愈重读**（否则"卡还在、点了才报错、报完错卡还在"）
//   ⑧ ⛔ 不能靠隐藏按钮代替云端校验：判定只在云端，客户端不许本地预判权限
//
// ⭐ 最重要的一条判据：**「云端拒绝了」≠「界面追上了」**。
//    云端是权威，但界面那一帧是设备本地的；被拒之后不重读 ⇒ 用户看到的是"报错了但东西还在"，
//    这正是"静默 = 事故放大器"的同一个形状。所以自愈必须发生在**收到拒绝之后**，而不是靠前端提前藏按钮。
//
// ⭐⭐ 2026-10-06：⑥⑦⑧ 的**出口**换成学员列表页（旧授权工作台已下线），判据一个字没改：
//     撤销之后被拒 ⇒ 那一帧必须自愈；且客户端仍然**不许**本地预判权限。

const assert = require('assert')
const path = require('path')
const { createStudentsBookingWorld, test } = require('./helpers/students-booking-world')
const { todayKey } = require('../utils/beijing-date')

const world = createStudentsBookingWorld()
const authorization = require('../utils/coach-authorization')
const PAGE = path.join(__dirname, '..', 'pages', 'students', 'students.js')
const GRANTS = 'coach_sandbox_package_grants'
const MEMBERS = 'coach_sandbox_member_authorizations'
const copy = world.copy
const runner = test

const TOTAL = 5
const UNIT_PRICE = 100
const SALE_AMOUNT = 500

const grantRows = () => [...(world.stores[GRANTS] || new Map()).values()]
const memberRows = () => [...(world.stores[MEMBERS] || new Map()).values()]

// 键序无关的规范化（项目铁律：JSON.stringify 是键序敏感的）
const canon = value => JSON.stringify(value, (key, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item
  return Object.keys(item).sort().reduce((acc, k) => { acc[k] = item[k]; return acc }, {})
})

async function seed(options = {}) {
  world.reset(); world.installRuntime(); world.installFakeMutate()
  world.runtime.setEnvironment('sandbox')
  const A = world.seedCoach('openid-a', 'ds-a', 'PUBCODEA')
  const B = world.seedCoach('openid-b', 'ds-b', 'PUBCODEB')
  world.seedStudent(A, 'stu-1', 'M2 撤销测试学员')
  const date = todayKey()
  const sold = await world.execute(A, 'createCourseSale', {
    studentId: 'stu-1', type: '常规训练', total: TOTAL, remaining: TOTAL, quantity: TOTAL,
    unitPrice: UNIT_PRICE, amount: SALE_AMOUNT, date, teachingPublicCodes: [B.publicCode]
  })
  assert.equal(sold.ok, true, JSON.stringify(sold))
  const packageId = sold.result.packageId
  let bookingId = ''
  if (options.withLesson) {
    const booked = await world.execute(B, 'createAuthorizedBooking', { studentId: 'stu-1', packageId, date, hour: 9, minute: 0 })
    assert.equal(booked.ok, true, JSON.stringify(booked))
    bookingId = booked.result.bookingId
    await world.execute(B, 'updateBookingContent', { bookingId, items: [{ name: '卧推', sets: 4, reps: 12, weight: '40' }] })
    const done = await world.execute(B, 'completeBooking', { bookingId })
    assert.equal(done.ok, true, JSON.stringify(done))
  }
  return { A, B, packageId, bookingId, date }
}
const revokeTeaching = (A, B, packageId) => world.execute(A, 'revokePackageTeaching', { packageId, publicCode: B.publicCode })

// ⭐ 新出口：学员列表页。授权会员就是列表里那张 `authorized` 卡。
const authorizedCards = page => (page.data.students || []).filter(item => item && item.authorized)
async function enterPage(coach, options = {}) {
  // ⚠️ 默认清缓存（每个用例从头开始）；⑥ 要模拟"B 再次进页面、缓存还在" ⇒ 必须 keepCache。
  if (!options.keepCache) authorization.clearCache()
  // ⚠️ keepCache 就是"B 再次进页面"的真机形状：**只 onShow**（零云调用，读缓存那一帧），
  //    不另外强制刷新 —— 强制刷新当然会追上云端，那就测不到"需要自愈"的这个形状了。
  return world.openAs(coach, { clearStorage: !options.keepCache, force: !options.keepCache })
}

;(async () => {
  await runner('① 撤销之后云端目录立刻更新：A 的课包教练名单里没有 B，B 的目录归零', async () => {
    const { A, B, packageId } = await seed()
    const before = await world.readDirectory(A)
    assert.ok(before.managed.some(row => row.packageId === packageId && row.coaches.some(c => c.coachId === B.owner)), '（前置）撤销前 A 必须看得到 B')
    const revoked = await revokeTeaching(A, B, packageId)
    assert.equal(revoked.ok, true, JSON.stringify(revoked))
    const afterA = await world.readDirectory(A)
    const row = afterA.managed.find(item => item.packageId === packageId)
    assert.ok(row, 'A 仍然管理着这份课包（撤销的是 B 的授课权，不是 A 的管理权）')
    assert.equal(row.coaches.some(c => c.coachId === B.owner), false, 'B 必须从可授课教练名单里消失')
    const afterB = await world.readDirectory(B)
    assert.equal(afterB.serving.length, 0, `B 的「授权给我服务的会员」必须归零（实测 ${afterB.serving.length}）`)
    assert.equal(afterB.managed.length, 0, `B 的「我管理着的课时包」必须归零（实测 ${afterB.managed.length}）`)
  })

  await runner('② 撤销是改状态不是删行：授权行变 revoked，派生的会员级关系一并收掉', async () => {
    const { A, B, packageId } = await seed()
    const revoked = await revokeTeaching(A, B, packageId)
    assert.equal(revoked.ok, true, JSON.stringify(revoked))
    const grant = grantRows().find(row => row.coachId === B.owner && row.packageId === packageId)
    assert.ok(grant, '⛔ 授权行必须还在（撤销是改状态，**绝不**删行 —— 删了就没有"谁在什么时候被撤过"这条事实）')
    assert.equal(grant.status, 'revoked', `状态必须是 revoked（实测 ${grant.status}）`)
    assert.equal(grant.canManage, false, '撤销后不许再留着管理权')
    const member = memberRows().find(row => row.coachId === B.owner && row.studentId === 'stu-1')
    assert.ok(member, '会员级关系那一行也必须还在')
    assert.equal(member.status, 'revoked', `课包授权撤销后，派生的会员级关系要一并收掉（实测 ${member.status}）`)
    assert.equal(member.source, 'package-derived', '这次收掉的是**派生**关系；显式授予的那一条不许被误删')
  })

  await runner('③ 云端始终重新校验：撤销后 B 拿旧 packageId 再排课 ⇒ 命令真发但被拒，且一个预约都不产生', async () => {
    const { A, B, packageId, date } = await seed()
    await revokeTeaching(A, B, packageId)
    const bookingsBefore = world.rows('bookings', A.owner, A.datasetId).length
    const pkgBefore = world.dataRows('packages', A.owner, A.datasetId).find(item => item.id === packageId)
    const tried = await world.execute(B, 'createAuthorizedBooking', { studentId: 'stu-1', packageId, date, hour: 15, minute: 0 })
    assert.equal(tried.ok, false, '⛔ 云端必须拒（本地缓存里那份课包不作数）')
    assert.ok(
      ['MEMBER_SERVICE_NOT_AUTHORIZED', 'PACKAGE_TEACHING_NOT_AUTHORIZED'].includes(tried.code),
      `必须报权限类的码（实测 ${tried.code} ${tried.message}）`
    )
    assert.equal(world.rows('bookings', A.owner, A.datasetId).length, bookingsBefore, '一个预约都不许产生')
    const pkgAfter = world.dataRows('packages', A.owner, A.datasetId).find(item => item.id === packageId)
    assert.equal(pkgAfter.reserved, pkgBefore.reserved, 'reserved 不许被试探性的排课动到')
    assert.equal(pkgAfter.remaining, pkgBefore.remaining, 'remaining 不许被动')
    // ⭐ 双层都要过：**课包授权还在、会员级关系没了** ⇒ 同样必被拒（判据只认云端，不认客户端那张卡）。
    //   （这一条专门给 `assertMayBook` 判别力：少了它，`resolveBookingPlace` 找得到授权行就会放行。）
    const { A: A2, B: B2, packageId: pkg2, date: d2 } = await seed()
    const memberRow = memberRows().find(row => row.coachId === B2.owner && row.studentId === 'stu-1')
    assert.ok(memberRow, '（前置）派生出来的会员级关系存在')
    world.stores[MEMBERS].set(memberRow._id, { ...memberRow, status: 'revoked' })
    const tried2 = await world.execute(B2, 'createAuthorizedBooking', { studentId: 'stu-1', packageId: pkg2, date: d2, hour: 16, minute: 0 })
    assert.equal(tried2.ok, false, '⛔ 课包授权还在也不行 —— 双层缺一都不能排课')
    assert.equal(tried2.code, 'MEMBER_SERVICE_NOT_AUTHORIZED', `必须报**会员级**那一层的码（实测 ${tried2.code}）`)
  })

  await runner('④ 撤销不删历史：B 教过的课与收入、A 的销售与课时**逐字节**不变', async () => {
    const { A, B, packageId, bookingId } = await seed({ withLesson: true })
    const snapshotOf = coach => ({
      bookings: canon(world.dataRows('bookings', coach.owner, coach.datasetId)),
      incomes: canon(world.dataRows('incomes', coach.owner, coach.datasetId)),
      sales: canon(world.dataRows('sales', coach.owner, coach.datasetId)),
      packages: canon(world.dataRows('packages', coach.owner, coach.datasetId).filter(item => item.id === packageId)),
      students: canon(world.dataRows('students', coach.owner, coach.datasetId))
    })
    const beforeA = snapshotOf(A), beforeB = snapshotOf(B)
    assert.equal(world.dataRows('incomes', B.owner, B.datasetId).length, 1, '（前置）B 已经拿到这一节课的教学收入')
    const revoked = await revokeTeaching(A, B, packageId)
    assert.equal(revoked.ok, true, JSON.stringify(revoked))
    assert.equal(canon(snapshotOf(A)), canon(beforeA), '⛔ A 那本账一个字节都不许变（销售 / 课时 / 学员 / 预约）')
    assert.equal(canon(snapshotOf(B)), canon(beforeB), '⛔ B 那本账的历史教学记录与收入也不许变')
    const booking = world.dataRows('bookings', B.owner, B.datasetId).find(item => item.id === bookingId)
    assert.ok(booking && booking.status === 'done', 'B 教过的那节课仍然是 done（撤销权限不是抹掉历史）')
  })

  await runner('⑤ 撤销之后 A 自己那本账照旧能排课（账本所有者不需要授权行）', async () => {
    const { A, B, packageId, date } = await seed()
    await revokeTeaching(A, B, packageId)
    const booked = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date, hour: 11, minute: 0 })
    assert.equal(booked.ok, true, `A 给自己学员排课不该被撤销影响（实测 ${JSON.stringify(booked)}）`)
  })

  await runner('⑥ B 的本地缓存不会自己消失（学员页 onShow 零云调用是设计）—— 所以「被拒之后」必须有人负责重读', async () => {
    const { A, B, packageId } = await seed()
    const page = await enterPage(B)
    assert.equal(authorizedCards(page).length, 1, '（前置）B 这一帧里看得到那位会员')
    assert.equal(authorization.cachedDirectory().data.serving.length, 1, '（前置）缓存里确实有这一帧')
    await revokeTeaching(A, B, packageId)
    // ⛔ 如实陈述：学员页 onShow 走 cachedDirectory()（零云调用）⇒ 这一帧**不会**自己消失。
    assert.equal(authorization.cachedDirectory().data.serving.length, 1, '撤销发生在别人的手机上 ⇒ B 的旧帧不会自己消失')
    const stale = await enterPage(B, { keepCache: true })
    assert.equal(authorizedCards(stale).length, 1, 'B 再次进入页面（非强制）仍然看到旧帧 ⇒ 这正是需要自愈的那个形状')
  })

  await runner('⑦ ⭐ B 用旧帧点排课 ⇒ 云端拒 ⇒ 页面必须自愈重读（不许"报错了但卡还在"）', async () => {
    const { A, B, packageId } = await seed()
    const page = await enterPage(B)
    assert.equal(authorizedCards(page).length, 1, '（前置）旧帧里看得到会员')
    await revokeTeaching(A, B, packageId)
    world.setActor(B)
    world.calls.length = 0
    world.modals.length = 0
    world.openBooking(page)
    assert.ok(page.data.booking, '（前置）排课面板必须打得开（旧帧里那份课包看起来是可用的）')
    await page.confirmBooking()
    const sent = world.calls.filter(item => item.command === 'createAuthorizedBooking')
    assert.equal(sent.length, 1, `命令必须真的发出去（判定在云端，不在前端；实测 ${sent.length} 条）`)
    // ⭐ 核心判据：被拒之后，本地那一帧必须追上云端的裁决
    assert.equal(
      authorization.cachedDirectory().data.serving.length, 0,
      '⛔ 被云端拒绝之后必须自愈重读：否则用户看到的是"报错了、但那张卡还在"'
    )
    assert.equal(authorizedCards(page).length, 0, '⛔ 列表里的那张卡也必须跟着消失（界面追上云端）')
    assert.ok(world.modals.some(item => /授权|权限/.test(String(item.content || ''))), `必须明确告诉用户是权限变了（实测 ${JSON.stringify(world.modals)}）`)
  })

  await runner('⑧ ⛔ 不许用"前端先藏按钮"代替云端校验：页面不做本地权限判定', async () => {
    const source = require('fs').readFileSync(PAGE, 'utf8')
    // 本地若出现这些判定 ⇒ 说明有人把权限闸搬到了客户端（客户端说了不算，云端才算）
    ;['canServeMember', 'canTeachPackage', 'assertMayBook', 'assertCanManagePackage'].forEach(name => {
      assert.ok(!source.includes(name), `页面里不许出现本地权限判定 ${name}`)
    })
    // ⛔ 也不许把云端的授权码**硬编码**在客户端里当判据（那是"客户端提前预判权限"的另一个形状）。
    ;['MEMBER_SERVICE_NOT_AUTHORIZED', 'PACKAGE_TEACHING_NOT_AUTHORIZED'].forEach(code => {
      assert.ok(!source.includes(code), `页面里不许硬编码云端授权码 ${code} 来做本地预判`)
    })
    // 反过来：命令必须真的出网（⑦ 已证明），且失败文案由 mutate 统一按云端响应弹出 ⇒ 页面不自己编。
    assert.ok(/createAuthorizedBooking/.test(source), '排课必须由页面真的发出这条命令（判定在云端）')
  })

  process.stdout.write('M2 revocation integrity tests: PASS (8 blocks)\n')
})()
