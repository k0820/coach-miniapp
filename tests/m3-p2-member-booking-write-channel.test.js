// M3-P2 · 会员预约**写通道**永久测试（2026-09-30）
//
// 这一份测的是"会员真的要提交预约时，底层到底安不安全"，**不是**界面。
// ⛔ 全部走**真**云函数代码（`coachBusinessCommand` 的 core / authorization / occupancy / 预约内核）
//    跑在假 CloudBase 上 —— 假件只有网络与存储那一层，业务那一层是真的。
//
// 关键判据（每一条都对应一个真实事故形状）：
//   · 伪造 memberId ⇒ 拒；越权用别人的课包 ⇒ 拒；没授权 ⇒ 拒；撤销后 ⇒ 拒；
//   · 时间冲突 / 超过 24:00 / 没余量 ⇒ 拒，且错误码与**教练代约**完全相同；
//   · 重复提交（连点 / 超时重发）⇒ 只落一条；两个会员抢同一时段 ⇒ 只有一个成功；
//   · sales / incomes **一个字节都不许变**；
//   · 前端确认按钮**已接通真实提交**（M3-P3 起）：点确认真的发一次 createMemberBooking；
//   · policy 已定稿为 **direct**（规则 1：不需要教练确认），两种 policy 底层仍可表达。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createWorld, runner } = require('./helpers/m2-business-world')

const ROOT = path.join(__dirname, '..')
const memberBooking = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
const core = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/core'))
const authorization = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/authorization'))
const occupancy = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/occupancy'))
const requestBuilder = require(path.join(ROOT, 'utils/member-booking-request'))
const flags = require(path.join(ROOT, 'utils/release-flags'))

const beijingDate = require(path.join(ROOT, 'utils/beijing-date'))

const CLAIMS = 'member_sandbox_student_claims'
const ENV = 'sandbox'
const TODAY = '2030-03-17'   // 假世界的 clock 起点对应的北京时间（见 beijingDateKey）
const DATE = '2030-03-20'
// ⭐ 真页面那段要用**真实今天**（客户端预检按北京时间真实今天判 30 天窗口，2030 年会被判越界）。
const LIVE_DATE = beijingDate.addDays(beijingDate.todayKey(), 3)

const world = createWorld()

// 静态断言用：先剥注释再匹配（注释里常常引用"被禁止的写法"来解释为什么禁止）。
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
}

function seedCoach(open, datasetId, publicCode) { return world.seedCoach(open, datasetId, publicCode) }

function seedPackage(coach, studentId, packageId, extra = {}) {
  world.put('packages', world.businessId('packages', coach.owner, coach.datasetId, packageId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, packageId, studentId,
    data: { id: packageId, type: '常规训练', total: 10, remaining: 2, used: 0, reserved: 0, reservedVersion: 2, price: 300, status: 'active', ...extra }
  })
  return packageId
}

function seedSale(coach, studentId, saleId) {
  world.put('sales', world.businessId('sales', coach.owner, coach.datasetId, saleId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, saleId, studentId,
    data: { id: saleId, studentId, amount: 3000, date: '2030-01-01', source: 'manual' }
  })
}
function seedIncome(coach, incomeId) {
  world.put('incomes', world.businessId('incomes', coach.owner, coach.datasetId, incomeId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, incomeId,
    data: { id: incomeId, amount: 300, date: '2030-01-02' }
  })
}

// 认领关系 = 会员身份与"某本账里某条学员记录"的**唯一**绑定（服务端推导身份的支点）。
function seedClaim(memberOpenId, coach, studentId) {
  const memberId = memberBooking.memberIdFor(memberOpenId)
  const claimId = memberBooking.fixedId(CLAIMS, coach.owner, studentId)
  world.put(CLAIMS, memberBooking.fixedId(CLAIMS, coach.owner, studentId), {
    claimId, memberId, coachId: coach.owner, studentId, status: 'verified'
  })
  return { memberId, claimId, studentId }
}

function seedGrants(place, studentId, packageId, coachId, status = authorization.STATUS_ACTIVE) {
  const names = authorization.collectionsFor(ENV)
  world.put(names.package, authorization.packageGrantId(place, packageId, coachId), {
    ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, packageId, studentId, coachId,
    status, canManage: false, grantedByCoachId: place.ownerCoachId
  })
  world.put(names.member, authorization.memberAuthId(place, studentId, coachId), {
    ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId, coachId,
    status, source: authorization.SOURCE_PACKAGE_DERIVED, grantedByCoachId: place.ownerCoachId
  })
}

// 双层权限**分别**播种（课包级 active、会员级 revoked ⇒ 只有 assertMayBook 能拦住 ⇒ 专治"另一道闸挡住反证"的假绿）
function seedGrantsSplit(place, studentId, packageId, coachId, packageStatus, memberStatus) {
  const names = authorization.collectionsFor(ENV)
  world.put(names.package, authorization.packageGrantId(place, packageId, coachId), {
    ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, packageId, studentId, coachId,
    status: packageStatus, canManage: false, grantedByCoachId: place.ownerCoachId
  })
  world.put(names.member, authorization.memberAuthId(place, studentId, coachId), {
    ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId, coachId,
    status: memberStatus, source: authorization.SOURCE_EXPLICIT, grantedByCoachId: place.ownerCoachId
  })
}

const coachKeyOf = coachId => memberBooking.fixedId('member-coach-view', coachId)
const packageViewIdOf = (claimId, packageId) => memberBooking.fixedId('member-package-view', claimId, packageId)

function book(options = {}) {
  // ⚠️ `world.execute()` 会把"我是谁"换成教练 ⇒ 每个会员请求前必须把身份切回这位会员。
  world.setOpenId(options.openId || M1 || 'open-m1')
  return world.main()({
    action: 'memberBooking', command: options.command || 'createMemberBooking',
    requestId: options.requestId || `mbk_test_${Math.random().toString(36).slice(2, 10)}`,
    environment: ENV,
    payload: options.payload || {}
  })
}

function bookingRows(coach) { return world.rows('bookings', coach.owner, coach.datasetId) }
function bookingData(coach) { return world.dataRows('bookings', coach.owner, coach.datasetId) }
function packageRow(coach, packageId) {
  return world.rows('packages', coach.owner, coach.datasetId).find(row => row.packageId === packageId)
}
// 销售 / 收入的**逐字节**快照（键序无关由 JSON.stringify 无关 ⇒ 这里按字符串排序后整体比对）。
function snapshot() {
  return JSON.stringify(['sales', 'incomes', 'settings'].map(name => [...world.stores[name].values()].map(row => JSON.stringify(row)).sort()))
}

// ------------------------------------------------------------------ 标准场景
let A, B, M1, claim1, PKG
function setupBase() {
  world.reset()
  A = seedCoach('open-a', 'ds-a', 'PUBA')
  B = seedCoach('open-b', 'ds-b', 'PUBB')
  world.seedStudent(A, 'stu-a', '会员甲')
  world.seedStudent(B, 'stu-b', '会员乙')
  seedPackage(A, 'stu-a', 'pkg-a')
  seedSale(A, 'stu-a', 'sale-a')
  seedIncome(A, 'income-a')
  M1 = 'open-m1'
  claim1 = seedClaim(M1, A, 'stu-a')
  PKG = 'pkg-a'
}

async function main() {
  await runner('① 伪造 memberId 一律无效（payload 里塞 / 顶层塞都不行），且**零写入**', async () => {
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    world.setOpenId('open-m1')
    const payload = { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    const inside = await world.main()({ action: 'memberBooking', command: 'createMemberBooking', requestId: 'mbk_fake_1', environment: ENV, payload: { ...payload, memberId: 'someone-else' } })
    assert.strictEqual(inside.ok, false)
    assert.strictEqual(inside.code, 'FORBIDDEN_IDENTITY_INPUT', `payload 里塞 memberId 必须被拒，实际：${inside.code}`)
    const top = await world.main()({ action: 'memberBooking', command: 'createMemberBooking', requestId: 'mbk_fake_2', environment: ENV, memberId: 'x', payload })
    assert.strictEqual(top.ok, false)
    assert.strictEqual(top.code, 'FORBIDDEN_IDENTITY_INPUT', '顶层塞 memberId 也必须被拒')
    assert.strictEqual(bookingRows(A).length, 0, '伪造身份时一次写都不许发生')
    // 会员身份必须是**服务端**从 OPENID 推导的（三处公式必须一致）
    assert.strictEqual(memberBooking.memberIdFor('open-m1'), memberBooking.memberIdFor('open-m1'))
    assert.notStrictEqual(memberBooking.memberIdFor('open-m1'), memberBooking.memberIdFor('open-m2'))
  })

  await runner('② 越权使用**其他会员**的课时包 ⇒ 拒，且零写入', async () => {
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    const other = seedClaim('open-m2', B, 'stu-b')
    seedPackage(B, 'stu-b', 'pkg-b')
    const result = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(other.claimId, 'pkg-b'), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(result.ok, false, '别的会员的课时包标识绝不能约上')
    assert.strictEqual(result.code, 'PACKAGE_NOT_AVAILABLE_FOR_MEMBER')
    assert.strictEqual(bookingRows(A).length, 0)
    assert.strictEqual(bookingRows(B).length, 0)
  })

  await runner('③ 没有教练授权 ⇒ 拒（教练不在可约名单里）', async () => {
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    const result = await book({
      payload: { coachKey: coachKeyOf(B.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'COACH_NOT_AVAILABLE', '没有被授权的教练不能出现在可约名单里')
    assert.strictEqual(bookingRows(A).length, 0)
    assert.strictEqual(bookingRows(B).length, 0)
  })

  await runner('④ 课包授课授权被**撤销**后 ⇒ 拒，且与**教练代约**同一个错误码', async () => {
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    const place = { ownerCoachId: A.owner, datasetId: A.datasetId }
    seedGrants(place, 'stu-a', PKG, B.owner, authorization.STATUS_REVOKED)
    const memberResult = await book({
      payload: { coachKey: coachKeyOf(B.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(memberResult.ok, false)
    assert.strictEqual(memberResult.code, 'PACKAGE_TEACHING_NOT_AUTHORIZED')
    // 同一场景走教练端的正式授权排课 ⇒ 必须是**同一个码**（证明共享的是同一道闸）
    const coachResult = await world.execute(B, 'createAuthorizedBooking', { studentId: 'stu-a', packageId: PKG, date: DATE, hour: 10, minute: 0 })
    assert.strictEqual(coachResult.ok, false)
    assert.strictEqual(coachResult.code, 'PACKAGE_TEACHING_NOT_AUTHORIZED', '会员自约与教练代约必须报同一个码')
    assert.strictEqual(bookingRows(A).length, 0)
    assert.strictEqual(bookingRows(B).length, 0)

    // ⭐ 另一半：课包授权还在、**会员级服务关系被撤销** ⇒ 解析阶段看不出来，
    //    只有 `assertMayBook` 这道**双层闸**能拦住（少了断言它就会假绿）。
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    const place2 = { ownerCoachId: A.owner, datasetId: A.datasetId }
    seedGrantsSplit(place2, 'stu-a', PKG, B.owner, authorization.STATUS_ACTIVE, authorization.STATUS_REVOKED)
    const halfRevoked = await book({
      payload: { coachKey: coachKeyOf(B.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(halfRevoked.ok, false, '会员级服务关系被撤销 ⇒ 不能约')
    assert.strictEqual(halfRevoked.code, 'MEMBER_SERVICE_NOT_AUTHORIZED')
    const coachHalf = await world.execute(B, 'createAuthorizedBooking', { studentId: 'stu-a', packageId: PKG, date: DATE, hour: 10, minute: 0 })
    assert.strictEqual(coachHalf.code, 'MEMBER_SERVICE_NOT_AUTHORIZED', '会员自约与教练代约必须报同一个码')
    assert.strictEqual(bookingRows(A).length, 0)
    assert.strictEqual(bookingRows(B).length, 0)
  })

  await runner('⑤ 时间冲突 ⇒ 拒（教练这个时段已经有课），零写入', async () => {
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    // 先用教练端排一节 10:00
    const seeded = await world.execute(A, 'createBooking', { studentId: 'stu-a', packageId: PKG, date: DATE, hour: 10, minute: 0 })
    assert.strictEqual(seeded.ok, true, '前置：教练端先排上一节')
    const result = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'BOOKING_TIME_CONFLICT')
    assert.strictEqual(bookingRows(A).length, 1, '失败的提交不许产生第二条预约')
  })

  await runner('⑥ ⭐ 开课窗口（2026-10-01 **二次**口径）：晚于 23:00 ⇒ 拒；23:00 可约（24:00 结束）', async () => {
    // ⛔ 本段原钉"结束不得晚于 24:00"。用户 2026-10-01 明确最终规则取代了它：
    //    判据改挂「开始」—— 23:00 是最后一个开课时间（二次口径：23:30 已取消），23:00 + 60 ⇒ 24:00。
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    // ① 23:30 / 23:45 开课 ⇒ 晚于 23:00 ⇒ 两个通道都拒，且是同一个码
    const late = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 23, minute: 45 }
    })
    assert.strictEqual(late.ok, false)
    assert.strictEqual(late.code, 'BOOKING_START_TOO_LATE')
    const coachLate = await world.execute(A, 'createBooking', { studentId: 'stu-a', packageId: PKG, date: DATE, hour: 23, minute: 45 })
    assert.strictEqual(coachLate.code, 'BOOKING_START_TOO_LATE', '会员端与教练端同一把尺')
    // ② ⭐ 23:00 开课 ⇒ **允许**（24:00 结束，正好卡在当天界上），两个通道都放行
    const edge = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 23, minute: 0 }
    })
    assert.strictEqual(edge.ok, true, '23:00 是当天最后一个开课时间，必须能约（实测 ' + JSON.stringify(edge) + '）')
    // ⛔ 23:30 这一档已取消 ⇒ 会员端同样不许（不许"云端还认、只有 UI 拦"）
    const halfPast = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 23, minute: 30 }
    })
    assert.strictEqual(halfPast.ok, false, '23:30 已取消 ⇒ 必须被拒（实测 ' + JSON.stringify(halfPast) + '）')
    assert.strictEqual(halfPast.code, 'BOOKING_START_TOO_LATE')
    assert.strictEqual(bookingRows(A).length, 1)
    const coachEdge = await world.execute(A, 'createBooking', { studentId: 'stu-a', packageId: PKG, date: DATE, hour: 7, minute: 30 })
    assert.strictEqual(coachEdge.ok, true, '07:30 半点也必须能排')
  })

  await runner('⑦ 没有剩余课时 / 余量被排满 ⇒ 拒（两句话分得清）', async () => {
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    // remaining = 0 ⇒ 用完了
    const row = packageRow(A, PKG)
    row.data.remaining = 0
    world.put('packages', world.businessId('packages', A.owner, A.datasetId, PKG), row)
    const empty = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(empty.ok, false)
    assert.strictEqual(empty.code, 'PACKAGE_NO_REMAINING')
    // remaining = 1 但已经被排满 ⇒ 排满了
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    const row2 = packageRow(A, PKG)
    row2.data.remaining = 1
    world.put('packages', world.businessId('packages', A.owner, A.datasetId, PKG), row2)
    const first = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(first.ok, true, '最后一节应当能被约走')
    const second = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 14, minute: 0 }
    })
    assert.strictEqual(second.ok, false)
    assert.strictEqual(second.code, 'PACKAGE_NO_AVAILABLE', '余量被排满必须说"排满了"，不能说"没有课时了"')
    assert.strictEqual(bookingRows(A).length, 1)
  })

  await runner('⑧ 重复提交（连点两次 / 超时后重发）⇒ **只落一条**预约', async () => {
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    const requestId = 'mbk_dupe_0001'
    const payload = { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    const first = await book({ requestId, payload })
    assert.strictEqual(first.ok, true)
    const second = await book({ requestId, payload })
    assert.strictEqual(second.ok, true, '同号重发应当返回上一次的结果，而不是报错')
    assert.strictEqual(second.replayed, true)
    assert.strictEqual(second.bookingId, first.bookingId, '重发不能换一个预约号')
    assert.strictEqual(bookingRows(A).length, 1, '重复提交只许产生一条预约')
    // 同一个号换个参数 ⇒ 必须报冲突（不许被静默接受）
    const conflict = await book({ requestId, payload: { ...payload, hour: 15 } })
    assert.strictEqual(conflict.ok, false)
    assert.strictEqual(conflict.code, 'REQUEST_ID_CONFLICT')
    assert.strictEqual(bookingRows(A).length, 1)
  })

  await runner('⑨ 两个会员同时抢同一时段 ⇒ **只有一个成功**（另一个收到冲突）', async () => {
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    world.seedStudent(A, 'stu-c', '会员丙')
    seedPackage(A, 'stu-c', 'pkg-c')
    claim1 = seedClaim('open-m1', A, 'stu-a')
    const claim2 = seedClaim('open-m2', A, 'stu-c')
    const race = await Promise.all([
      book({ openId: 'open-m1', requestId: 'mbk_race_a', payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, 'pkg-a'), date: DATE, hour: 10, minute: 0 } }),
      book({ openId: 'open-m2', requestId: 'mbk_race_b', payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim2.claimId, 'pkg-c'), date: DATE, hour: 10, minute: 0 } })
    ])
    const winners = race.filter(row => row && row.ok)
    assert.strictEqual(winners.length, 1, `两个人抢同一个时段只能有一个成功，实际成功 ${winners.length} 个`)
    const loser = race.find(row => !(row && row.ok))
    assert.ok(['BOOKING_TIME_CONFLICT', 'REVISION_CONFLICT', 'COMMAND_TRANSACTION_FAILED'].includes(loser.code), `失败方必须是冲突类错误，实际 ${loser.code}`)
    assert.strictEqual(bookingRows(A).length, 1)
  })

  await runner('⑩ 历史销售 / 收入**一个字节都不许变**；课时包只改 reserved', async () => {
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    const before = snapshot()
    const pkgBefore = JSON.parse(JSON.stringify(packageRow(A, PKG).data))
    const result = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(result.ok, true)
    assert.strictEqual(snapshot(), before, 'sales / incomes 必须逐字节不变')
    const pkgAfter = packageRow(A, PKG).data
    assert.strictEqual(pkgAfter.remaining, pkgBefore.remaining, 'remaining 不许变（预约只占座，不扣课）')
    assert.strictEqual(pkgAfter.used, pkgBefore.used)
    assert.strictEqual(pkgAfter.total, pkgBefore.total)
    assert.strictEqual(pkgAfter.reserved, pkgBefore.reserved + 1, 'reserved +1（与教练代约同一口径）')
    // 失败路径同样不许动
    const failed = await book({
      requestId: 'mbk_no_write_1',
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(failed.ok, false)
    assert.strictEqual(snapshot(), before, '失败的提交也不许碰销售与收入')
  })

  // M3-P3（2026-09-30 定稿）：真实提交链**已打开** ⇒ 这里改验"请求结构完整 + 真的只发一次写调用"。
  //   （"未开放时零云调用"那条判据搬到 `m3-p1-member-booking-view` ⑨，用把总闸按回去的方式验。）
  await runner('⑪ 前端请求结构完整 + 总闸已打开：点确认真的发**一次** createMemberBooking', async () => {
    assert.strictEqual(flags.MEMBER_BOOKING_SUBMIT, true, 'M3-P3 规则已定稿 ⇒ 总闸打开')
    const flagsSource = fs.readFileSync(path.join(ROOT, 'utils/release-flags.js'), 'utf8')
    assert.ok(/const MEMBER_BOOKING_SUBMIT = true/.test(flagsSource), '总闸必须是源码里唯一的那个开关（不许出现第二处判断）')
    // —— 请求构造器 ——
    const built = requestBuilder.buildBookingRequest({
      dateKey: DATE, slot: { start: 10 * 60, end: 11 * 60 }, coachKey: 'ck-1', packageViewId: 'pv-1'
    })
    assert.strictEqual(built.ok, true)
    assert.deepEqual(Object.keys(built.payload).sort(), [...requestBuilder.PAYLOAD_KEYS].sort())
    assert.deepEqual(requestBuilder.identityKeysIn(built), [], '请求里绝不许出现身份/定位字段')
    assert.strictEqual(built.payload.hour, 10)
    assert.strictEqual(built.payload.minute, 0)
    assert.strictEqual(built.payload.plannedMinutes, 60)
    assert.strictEqual(built.command, 'createMemberBooking')
    // 幂等号：同一会话稳定；换会话 ⇒ 换号（否则取消后重约会被旧号重放）
    const nonce = requestBuilder.newNonce()
    const a = requestBuilder.requestIdFor({ ...built.payload, nonce })
    const b = requestBuilder.requestIdFor({ ...built.payload, nonce })
    assert.strictEqual(a, b, '同一个确认会话里重复提交必须是同一个号')
    assert.notStrictEqual(a, requestBuilder.requestIdFor({ ...built.payload, nonce: requestBuilder.newNonce() }))
    assert.ok(/^[A-Za-z0-9:_-]{8,90}$/.test(a), `幂等号必须能被服务端收下：${a}`)
    // —— 自检（只为了减少白跑，不是安全边界）——
    assert.ok(requestBuilder.problemsOf({ dateKey: 'x', slot: { start: 23 * 60 + 30, end: 24 * 60 + 30 }, coachKey: '', packageViewId: '' }).length >= 3)

    // —— 真页面：点确认 ⇒ 真的发一次写调用（且只有一次）——
    const state = { calls: [], modals: [], toasts: [], storage: {} }
    global.wx = {
      getStorageSync: key => state.storage[key],
      setStorageSync: (key, value) => { state.storage[key] = value },
      navigateTo: () => { }, redirectTo: () => { },
      showModal: option => state.modals.push(option),
      showToast: option => state.toasts.push(option),
      stopPullDownRefresh: () => { },
      cloud: {
        callFunction: async option => {
          state.calls.push(option)
          if (option.name === 'coachBusinessCommand') return { result: { ok: true, bookingId: 'bk-1', memberRequestStatus: 'confirmed' } }
          return { result: { ok: true, environment: 'production', bookings: [], coaches: [], packages: [] } }
        }
      }
    }
    let captured = null
    global.Page = config => { captured = config }
    const full = require.resolve(path.join(ROOT, 'pages/member-book-slots/member-book-slots'))
    delete require.cache[full]
    require(full)
    const page = Object.assign({}, captured, { data: JSON.parse(JSON.stringify(captured.data)) })
    page.setData = function (patch) { Object.assign(this.data, patch) }
    page.data.dates = [{ index: 0, key: LIVE_DATE, label: '三天后' }]
    page.data.dateIndex = 0
    page.data.coaches = [{ coachKey: 'ck-1', displayName: '甲教练' }]
    page.data.packages = [{ packageViewId: 'pv-1', typeName: '常规训练', availableToBook: 2 }]
    page.data.slots = [{ key: `${LIVE_DATE}#10:00`, start: 600, end: 660, label: '10:00–11:00', available: true }]
    page.data.selected = page.data.slots[0]
    page.data.confirmOpen = true
    captured.pickSlot.call(page, { currentTarget: { dataset: { key: page.data.slots[0].key } } })
    assert.ok(page.submitRequest && page.submitRequest.payload, '打开确认层就要把请求结构准备好')
    assert.deepEqual(requestBuilder.identityKeysIn(page.submitRequest), [])
    await captured.submit.call(page)
    const writes = state.calls.filter(row => row.name === 'coachBusinessCommand')
    assert.strictEqual(writes.length, 1, `点确认只许发一次写调用（实测 ${writes.length} 次）`)
    assert.strictEqual(writes[0].data.action, 'memberBooking')
    assert.strictEqual(writes[0].data.command, 'createMemberBooking')
    assert.deepEqual(requestBuilder.identityKeysIn({ payload: writes[0].data.payload }), [], '真实请求里绝不能出现身份/定位字段')
    assert.ok(state.modals.some(row => String(row.title || '').includes('预约成功')), '云端返回成功才许说「预约成功」')
    assert.deepEqual(state.toasts, [], '不许用 toast 伪装成功')

    // —— 直接调 runtime：总闸打开 ⇒ 不再返回 DISABLED，而是真的出网 ——
    const member = require(path.join(ROOT, 'utils/member-runtime'))
    const before = state.calls.length
    const direct = await member.submitMemberBooking(built)
    assert.strictEqual(direct.ok, true, '总闸打开后 runtime 必须真的提交')
    assert.ok(state.calls.length > before, '必须真的发了一次云调用')
  })

  await runner('⑫ policy 已定稿为 **direct**（不再有"未选择"运行态）；两种 policy 底层仍可表达', async () => {
    // ✅ 规则 1 已定稿 ⇒ 默认必须是 direct；⛔ 但仍保留"显式关掉 ⇒ fail closed"的兜底。
    const policySource = stripComments(fs.readFileSync(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking.js'), 'utf8'))
    assert.ok(/let SELECTED_POLICY = POLICY_DIRECT/.test(policySource), 'policy 默认值必须是 direct（规则 1 已定稿：不需要教练确认）')
    assert.ok(!/let SELECTED_POLICY = null/.test(policySource), '不许回到"未选择"的运行状态')
    // 重新 require 一份干净模块 ⇒ 默认就是 direct（不是被上一个用例改出来的）。
    // ⚠️ 验完立刻把缓存**还原**：core.js 是懒加载 require 这份模块的，换掉实例会让后面的用例跑在另一个实例上。
    const memberPath = require.resolve(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
    const cachedEntry = require.cache[memberPath]
    delete require.cache[memberPath]
    const fresh = require(memberPath)
    assert.strictEqual(fresh.currentPolicy(), 'direct', '新进程里的默认 policy 必须是 direct')
    require.cache[memberPath] = cachedEntry

    setupBase()
    memberBooking.setPolicy(null)
    const unset = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(unset.ok, false, '规则未定 ⇒ 不许偷偷按某一种模式执行')
    assert.strictEqual(unset.code, 'MEMBER_BOOKING_POLICY_NOT_SELECTED')
    assert.strictEqual(bookingRows(A).length, 0, '未选择规则时零写入')

    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    const direct = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(direct.ok, true)
    assert.strictEqual(direct.policy, 'direct')
    assert.strictEqual(direct.memberRequestStatus, 'confirmed')
    const bookedDirect = bookingData(A)[0]
    assert.strictEqual(bookedDirect.memberRequest.status, 'confirmed')
    assert.strictEqual(bookedDirect.status, 'booked')
    assert.strictEqual(bookedDirect.source, 'member', '必须标明是会员自助发起的')
    assert.strictEqual(bookedDirect.createdByMemberId, memberBooking.memberIdFor(M1))
    assert.strictEqual(bookedDirect.createdByCoachId, null)

    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_COACH_CONFIRM)
    const pending = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(pending.ok, true)
    assert.strictEqual(pending.memberRequestStatus, 'awaiting-coach')
    const bookedPending = bookingData(A)[0]
    assert.strictEqual(bookedPending.memberRequest.status, 'awaiting-coach')
    // ⛔ 待确认**也必须占座**（否则两个人都能抢到同一节）
    assert.strictEqual(bookedPending.status, 'booked')
    assert.strictEqual(packageRow(A, PKG).data.reserved, 1, '待确认同样占座 ⇒ 不会出现两个人抢到同一节')
  })

  await runner('⑬ 没有档案 ⇒ 拒，且**绝不自动建档**（students / claims 一个字节不动）', async () => {
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    const beforeStudents = JSON.stringify([...world.stores.students.values()].map(row => JSON.stringify(row)).sort())
    const beforeClaims = JSON.stringify([...world.stores[CLAIMS].values()].map(row => JSON.stringify(row)).sort())
    const result = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: 'pv-not-exist', date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(result.ok, false)
    // 没有认领的微信 ⇒ 连课包都匹配不到
    const noClaim = await world.main()({
      action: 'memberBooking', command: 'createMemberBooking', requestId: 'mbk_noclaim_1', environment: ENV,
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: 'pv-x', date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(noClaim.ok, false)
    const stranger = await book({
      openId: 'open-stranger',
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(stranger.ok, false, '没有认领关系的账号一律约不上')
    assert.strictEqual(stranger.code, 'MEMBER_CLAIM_NOT_FOUND')
    assert.strictEqual(JSON.stringify([...world.stores.students.values()].map(row => JSON.stringify(row)).sort()), beforeStudents, '不许自动生成学员档案')
    assert.strictEqual(JSON.stringify([...world.stores[CLAIMS].values()].map(row => JSON.stringify(row)).sort()), beforeClaims, '不许自动生成认领关系')
    assert.strictEqual(bookingRows(A).length, 0)
  })

  await runner('⑭ 篡改日期 / 时间 ⇒ 拒（过去的日期、不存在的时刻）', async () => {
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    const past = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: '2020-01-01', hour: 10, minute: 0 }
    })
    assert.strictEqual(past.ok, false)
    assert.strictEqual(past.code, 'BOOKING_DATE_IN_PAST', '会员不能自助约过去的时间')
    const badHour = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 25, minute: 0 }
    })
    assert.strictEqual(badHour.ok, false)
    assert.strictEqual(badHour.code, 'INVALID_PAYLOAD')
    const badDate = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: '2030-13-45', hour: 10, minute: 0 }
    })
    assert.strictEqual(badDate.ok, false)
    assert.strictEqual(bookingRows(A).length, 0)
  })

  await runner('⑮ 白名单：会员通道只认 createMemberBooking，其它命令一律拒；也不许夹带额外字段', async () => {
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    for (const command of ['createBooking', 'createAuthorizedBooking', 'deleteStudent', 'completeBooking', 'grantPackageTeaching']) {
      const result = await book({ command, payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 } })
      assert.strictEqual(result.ok, false, `命令 ${command} 必须被拒`)
      assert.strictEqual(result.code, 'UNKNOWN_COMMAND')
    }
    const empty = await world.main()({
      action: 'memberBooking', command: '', requestId: 'mbk_empty_cmd', environment: ENV,
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(empty.ok, false, '空命令必须被拒')
    assert.strictEqual(empty.code, 'UNKNOWN_COMMAND')
    const extra = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0, studentId: 'stu-a' }
    })
    assert.strictEqual(extra.ok, false)
    assert.strictEqual(extra.code, 'FORBIDDEN_IDENTITY_INPUT')
    const unknownField = await book({
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0, anything: 1 }
    })
    assert.strictEqual(unknownField.ok, false)
    assert.strictEqual(unknownField.code, 'INVALID_PAYLOAD', '白名单外的字段不许被"忽略后继续执行"')
    assert.strictEqual(bookingRows(A).length, 0)
  })

  await runner('⑯ 与教练代约**同一套内核**：跨账授权场景会员自约成功，且落点与教练代约一致', async () => {
    setupBase()
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    const place = { ownerCoachId: A.owner, datasetId: A.datasetId }
    seedGrants(place, 'stu-a', PKG, B.owner, authorization.STATUS_ACTIVE)
    const result = await book({
      payload: { coachKey: coachKeyOf(B.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE, hour: 10, minute: 0 }
    })
    assert.strictEqual(result.ok, true, '被授权的教练应当能被会员约到')
    assert.strictEqual(result.teachingCoachId, B.owner)
    const mine = bookingData(B)
    assert.strictEqual(mine.length, 1, '预约文档必须落在**授课教练**那本账（M2 的落点规则）')
    assert.strictEqual(mine[0].teachingCoachId, B.owner)
    assert.strictEqual(mine[0].packageUsage.ownerCoachId, A.owner, '课时事实仍在原账里（授权不复制数据）')
    assert.strictEqual(packageRow(A, PKG).data.reserved, 1, '占座写在课包所在那本账')
    // 教练端代约同一个场景 ⇒ 落点必须一致
    setupBase()
    seedGrants(place, 'stu-a', PKG, B.owner, authorization.STATUS_ACTIVE)
    const coachSide = await world.execute(B, 'createAuthorizedBooking', { studentId: 'stu-a', packageId: PKG, date: DATE, hour: 10, minute: 0 })
    assert.strictEqual(coachSide.ok, true)
    assert.strictEqual(bookingData(B).length, 1)
    assert.strictEqual(bookingData(B)[0].packageUsage.ownerCoachId, A.owner)
  })

  await runner('⑰ 静态契约：会员通道不得生成教练身份、不得碰销售/收入、增量同步认识这条命令', async () => {
    // ⚠️ 静态断言**必须先剥注释**（注释里会引用被禁止的写法来说明"为什么不许这么做"）。
    const source = stripComments(fs.readFileSync(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking.js'), 'utf8'))
    assert.ok(!/coachIdFor\s*\(\s*openId/.test(source), '会员通道绝不许拿会员的 OPENID 去算教练身份')
    assert.ok(!/['"]sales['"]|['"]incomes['"]/.test(source), '会员通道不许出现销售/收入集合')
    const changes = fs.readFileSync(path.join(ROOT, 'cloudfunctions/readMyActiveCoachData/changes.js'), 'utf8')
    assert.ok(/createMemberBooking:/.test(changes), '教练端增量同步必须认识这条命令（否则每次刷新都退回全量读）')
    const coreSource = fs.readFileSync(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/core.js'), 'utf8')
    assert.ok(/event\.action === 'memberBooking'/.test(coreSource), '会员通道必须是独立入口（不与教练身份共用）')
    // 会员端页面不许出现"本地判定权限"之类的越权写法
    const pageSource = fs.readFileSync(path.join(ROOT, 'pages/member-book-slots/member-book-slots.js'), 'utf8')
    assert.ok(/memberBookingSubmitEnabled/.test(pageSource), '页面必须走总闸，不许自己决定能不能提交')
    // ⛔ 原断言钉的是 2026-09-29 旧口径（结束不得晚于 24:00），已被 2026-10-01 用户最终规则取代。
    assert.strictEqual(occupancy.LATEST_START_MINUTES, 23 * 60, '最晚开课 23:00 的口径不许漂移')
    // ⭐ 2026-10-03 四次口径：最早从 07:00 提到 **06:00**（教练新建与会员自助同一条规则）
    assert.strictEqual(occupancy.EARLIEST_START_MINUTES, 6 * 60, '最早开课 06:00 的口径不许漂移')
    assert.strictEqual(occupancy.SLOT_STEP_MINUTES, 30, '30 分钟步长的口径不许漂移')
  })

  await runner('⑱ M3-P1 两个页面的 UI 契约：小屏 / 长名称 / 空态 / loading / 弹层穿透 / 开课窗口', async () => {
    const slotsWxss = fs.readFileSync(path.join(ROOT, 'pages/member-book-slots/member-book-slots.wxss'), 'utf8')
    const bookingsWxss = fs.readFileSync(path.join(ROOT, 'pages/member-bookings/member-bookings.wxss'), 'utf8')
    const base = fs.readFileSync(path.join(ROOT, 'styles/member.wxss'), 'utf8')
    const slotsWxml = fs.readFileSync(path.join(ROOT, 'pages/member-book-slots/member-book-slots.wxml'), 'utf8')
    const bookingsWxml = fs.readFileSync(path.join(ROOT, 'pages/member-bookings/member-bookings.wxml'), 'utf8')

    // ⭐ 中文一字一行的根因（M2-UI-02）：flex 行里的文字块没有 `min-width:0`。
    const rule = (source, name) => {
      const match = source.match(new RegExp(`\\.${name}\\{([^}]*)\\}`))
      return match ? match[1] : ''
    }
    // ⚠️ 逐页判：**不许**用"另一个页面里有就算过"（那样改坏一页也会假绿）。
    const pages = [
      { name: '约课页', wxss: slotsWxss, flex: ['booking-copy', 'slot-day-copy', 'booking-detail-value'], wrap: ['slot-coach', 'slot-day', 'booking-detail-value'] },
      { name: '我的预约页', wxss: bookingsWxss, flex: ['booking-copy', 'booking-detail-value', 'booking-tab'], wrap: ['booking-date', 'booking-card-foot', 'booking-detail-value', 'booking-detail-summary'] }
    ]
    for (const entry of pages) {
      for (const name of entry.flex) {
        const found = rule(entry.wxss, name) || rule(base, name)
        assert.ok(found.includes('min-width:0'), `${entry.name} 的 .${name} 必须 min-width:0（没有它中文会被压成一字一行）`)
      }
      for (const name of entry.wrap) {
        const found = rule(entry.wxss, name) || rule(base, name)
        assert.ok(found.includes('overflow-wrap:break-word'), `${entry.name} 的 .${name} 必须可断行（长教练名 / 长课包名会撑破卡片）`)
      }
    }
    // ⛔ 不许用"缩小字号"掩盖布局问题
    for (const source of [slotsWxss, bookingsWxss]) {
      const sizes = [...source.matchAll(/font-size:(\d+)rpx/g)].map(match => Number(match[1]))
      assert.ok(sizes.length, '两个页面都应当有字号声明')
      assert.ok(Math.min(...sizes) >= 21, `不许出现小于 21rpx 的字号（实测最小 ${Math.min(...sizes)}rpx）`)
    }
    // ⭐ 2026-10-02 三态时段卡片**单源化**：`.slot-grid` / `.slot-cell` 已从本页 wxss
    //    移到唯一样式源 `styles/slots.wxss`（会员端约课页与教练端「新建课程」弹层共用）。
    //    所以几何口径要**从唯一来源读**——在哪读不再是实现自由，是契约的一部分
    //    （tests/slot-card-single-source.test.js 钉死了"消费者不许重定义卡片类"）。
    const slotBase = fs.readFileSync(path.join(ROOT, 'styles/slots.wxss'), 'utf8')

    // ⭐ 小屏：rpx 等比 ⇒ 任何手机都是 750rpx 宽；真正的变量是"每格还剩多宽"
    const grid = slotBase.match(/\.slot-grid\{[^}]*grid-template-columns:repeat\((\d+),1fr\);gap:(\d+)rpx/)
    assert.ok(grid, '.slot-grid 必须是等分网格（唯一样式源 styles/slots.wxss 里）')
    const pagePadding = Number((base.match(/\.member-page\{[^}]*padding:(\d+)rpx/) || [])[1] || 0)
    const columns = Number(grid[1]), gap = Number(grid[2])
    const cell = (750 - pagePadding * 2 - gap * (columns - 1)) / columns
    const inner = cell - 16   // .slot-cell 左右各 8rpx
    assert.ok(inner >= 150, `${columns} 列网格每格内容宽必须 ≥150rpx（实测 ${inner.toFixed(1)}rpx）`)
    const cellRule = rule(slotBase, 'slot-cell')
    const minHeight = Number((cellRule.match(/min-height:(\d+)rpx/) || [])[1] || 0)
    assert.ok(minHeight >= 88, `时段格点击区必须 ≥88rpx（实测 ${minHeight}rpx）`)

    // 空状态与 loading：不许出现"一片空白"或"卡在 loading"
    for (const text of ['这一天没有可约时间', '正在读取可约时间']) assert.ok(slotsWxml.includes(text), `约课页缺少：${text}`)
    // ⛔ 2026-10-01 修订：空态原写「还没有已完成的课程」，但那一页签里也含已取消 / 未到场的课
    //    ⇒ 叫"已完成"会把取消统计成完成（真机 16→17）。页签已改名为「历史」，空态同步改。
    for (const text of ['还没有待上课的预约', '还没有上过的课程', '正在读取你的预约']) assert.ok(bookingsWxml.includes(text), `我的预约页缺少：${text}`)
    // 弹层滚动穿透
    // ⭐ 2026-10-04（H 统一弹层）：约课确认已从"本页自建 `.booking-detail-mask`"换成
    //   `components/member-sheet`，**防穿透的那一行随之搬进了组件**（组件规格 ⑥）。
    //   ⇒ 本条的**契约没变**（"这个页面的弹层不许让手指在弹层上滑时把后面的页面带着滚"），
    //     只是"到哪一行去找"变了：自建遮罩看页面 wxml，统一弹层看组件 wxml。
    //   ⚠️ 两种形态都接受，但**必须真的找到 catchtouchmove** ⇒ 换成组件后把组件里那行删掉照样红。
    const sheetWxml = fs.readFileSync(path.join(ROOT, 'components/member-sheet/member-sheet.wxml'), 'utf8')
    assert.ok(/member-sheet-mask[^>]*catchtouchmove/.test(sheetWxml),
      '统一弹层的遮罩必须带 catchtouchmove（否则约课页换成组件后防滚动穿透就失效了）')
    for (const [name, wxml] of [['约课页', slotsWxml], ['我的预约页', bookingsWxml]]) {
      const ownMasks = (wxml.match(/class="[^"]*mask"/g) || [])
      if (ownMasks.length) {
        // 本页仍有自建遮罩（预约详情是信息展示型，保留）⇒ 每一块都必须自己挡住穿透
        assert.strictEqual((wxml.match(/catchtouchmove="noop"/g) || []).length, ownMasks.length,
          `${name} 的自建弹层必须每块都带 catchtouchmove（防滚动穿透）`)
      } else {
        assert.ok(wxml.includes('<member-sheet'), `${name} 既没有自建弹层也没有用 member-sheet ⇒ 弹层去哪了？`)
      }
    }
    // ⭐ 开课窗口边界（2026-10-01 **二次**口径）：最后一格是 23:00–24:00（正好卡在当天界上）
    const slots = require(path.join(ROOT, 'utils/member-booking-view')).slotsFor({ dateKey: DATE, busy: [], todayKey: '2030-01-01' })
    const last = slots[slots.length - 1]
    assert.strictEqual(last.start, 23 * 60, '最后一格必须从 23:00 开课')
    assert.strictEqual(last.end, 24 * 60, '23:00 那格结束在 24:00')
    assert.ok(slots.every(slot => slot.start <= 23 * 60), '不出现 23:00 之后才开课的时段')
    assert.ok(slots.every(slot => slot.start % 30 === 0), '每一格都必须落在整点或半点')
  })

  await runner('⑲ 页面返回后日期状态：显示的那一天 = 读取的那一天（BUG05 形状不复发）', async () => {
    const state = { calls: [], modals: [], toasts: [], storage: {} }
    global.wx = {
      getStorageSync: key => state.storage[key],
      setStorageSync: (key, value) => { state.storage[key] = value },
      navigateTo: () => { }, redirectTo: () => { },
      showModal: option => state.modals.push(option),
      showToast: option => state.toasts.push(option),
      stopPullDownRefresh: () => { },
      cloud: {
        callFunction: async option => {
          state.calls.push(option)
          return {
            result: {
              ok: true, availability: true, environment: 'sandbox', date: option.data.date,
              coaches: [{ coachKey: 'ck-1', displayName: '甲教练' }],
              packages: [{ packageViewId: 'pv-1', status: 'active', type: '常规训练', remaining: 2, used: 0, total: 10, coach: { displayName: '甲教练' } }],
              bookings: [], own: [], busy: [], warnings: []
            }
          }
        }
      }
    }
    let captured = null
    global.Page = config => { captured = config }
    const full = require.resolve(path.join(ROOT, 'pages/member-book-slots/member-book-slots'))
    delete require.cache[full]
    require(full)
    const page = Object.assign({}, captured, { data: JSON.parse(JSON.stringify(captured.data)) })
    page.setData = function (patch) { Object.assign(this.data, patch) }

    await captured.onShow.call(page)
    assert.strictEqual(page.data.dateKey, page.data.dates[page.data.dateIndex].key, '显示的那一天必须就是读取的那一天')
    await captured.pickDate.call(page, { currentTarget: { dataset: { index: 2 } } })
    assert.strictEqual(page.data.dateIndex, 2)
    assert.strictEqual(page.data.dateKey, page.data.dates[2].key)
    assert.strictEqual(state.calls[state.calls.length - 1].data.date, page.data.dates[2].key, '切到第 3 天就必须读第 3 天')
    // 从别的页面返回 ⇒ onShow 重新读取：日期回到今天，且**显示与读取仍然一致**（不许残留上一帧）
    await captured.onShow.call(page)
    assert.strictEqual(page.data.dateIndex, 0, '返回后回到今天（页面重新读取，不拿旧帧当事实）')
    assert.strictEqual(page.data.dateKey, page.data.dates[0].key)
    assert.strictEqual(state.calls[state.calls.length - 1].data.date, page.data.dates[0].key)
    assert.ok(page.data.slots.length, '返回后必须有内容（不是空白页）')
  })

  // 还原成定稿值（direct），别把"policy 被改过"这件事留给下一个用例。
  memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
}

main().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
