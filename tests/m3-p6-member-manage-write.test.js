// M3-P6 · 会员「取消 / 改期」安全写链 —— 永久回归测试（2026-09-30）
//
// 与 P4 那份的分工（**重要，别混**）：
//   · `m3-p4-member-booking-manage` 测的是 P4 时代的**锁死态**（UI 完整、零写入、双锁拦住）；
//     本轮 P6 把写链打开了 ⇒ 那份测试里"零写入 / 双锁 / 只认一条命令"的断言**已被本轮取代**，
//     已在同一轮改成测"新契约"（见该文件顶部的「本轮订正」）。
//   · 本文件测的是 P6 的新事实：**云端真的能取消 / 改期，且只按已定稿的六条规则改。**
//
// ⛔ 全部走**真**云函数代码（core / occupancy / authorization / 预约内核 / notify）跑在假 CloudBase 上。
//
// 覆盖（与用户交代的判据逐条对应）：
//   ① 基线：会员创建预约落库 ② 任意时间取消（无截止时间）③ reserved 正确释放 ④ remaining/used/total 不变
//   ⑤ 取消不动 sales/incomes ⑥ done 不许被取消成"没上过" ⑦ 重复取消幂等 ⑧ requestId 幂等与同号换参
//   ⑨ 越权取消拒绝 ⑩ 越权改期拒绝 ⑪ 改期不限次数 ⑫ 改期无需确认 ⑬ 改期忽略自身旧时段
//   ⑭ 新时段冲突拒绝 ⑮ +30 允许 / +31 拒绝 ⑯ 23:00+60 合法 / 23:30+60 拒绝
//   ⑰ 会员动 ⇒ 通知教练事件 ⑱ 教练动 ⇒ 通知会员事件 ⑲ 一次会员改期只落一条事件（不改 actor）
//   ⑳ 不得伪造"微信已发送" ㉑ 无档案不能操作 ㉒ 身份字段提交即拒 ㉓ 命令/字段白名单按命令分表
//   ㉔ 六条规则云端↔客户端孪生一致 ㉕ 没有违约计数器 ㉖ 取消保留历史（不物理删除）
//   ㉗ 已取消不许再改期 ㉘ 并发 fail closed ㉙ 连续取消三节 ㉚ 总闸与云端能力一致

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createWorld, runner } = require('./helpers/m2-business-world')

const ROOT = path.join(__dirname, '..')
const memberBooking = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
const cloudOccupancy = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/occupancy'))
const notify = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/notify'))
const core = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/core'))
const manage = require(path.join(ROOT, 'utils/member-booking-manage'))
const flags = require(path.join(ROOT, 'utils/release-flags'))

const CLAIMS = 'member_sandbox_student_claims'
const EVENTS = 'member_sandbox_notification_events'
const ENV = 'sandbox'
// 假世界的时钟起点（helpers/m2-business-world.js: `let clock = 1900000000000`）。
const CLOCK0 = 1900000000000
// ⭐ "今天"必须按**北京时间**算（不是 UTC）。
const TODAY = memberBooking.beijingDateKey(CLOCK0)
const DAY = cloudOccupancy.MEMBER_BOOKING_MAX_DAYS        // 30 —— 数字只有一个来源
const D = n => cloudOccupancy.addDateDays(TODAY, n)

const world = createWorld()

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
}
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const stripped = relative => stripComments(read(relative))
// 把源码里**某一个函数**抠出来（⛔ 断言必须钉在这一段上，不能钉整文件：别处的调用会假绿）。
function blockOf(source, startMarker, endMarker) {
  const from = source.indexOf(startMarker)
  assert.ok(from >= 0, `源码里找不到 ${startMarker}`)
  const to = endMarker ? source.indexOf(endMarker, from + startMarker.length) : -1
  return source.slice(from, to > from ? to : undefined)
}
const MEMBER_SRC = 'cloudfunctions/coachBusinessCommand/memberBooking.js'

// ------------------------------------------------------------------ 落库助手
function seedPackage(coach, studentId, packageId, extra = {}) {
  world.put('packages', world.businessId('packages', coach.owner, coach.datasetId, packageId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, packageId, studentId,
    data: { id: packageId, type: '常规训练', total: 10, remaining: 8, used: 1, reserved: 0, reservedVersion: 2, price: 300, status: 'active', ...extra }
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
function seedClaim(memberOpenId, coach, studentId) {
  const memberId = memberBooking.memberIdFor(memberOpenId)
  const claimId = memberBooking.fixedId(CLAIMS, coach.owner, studentId)
  world.put(CLAIMS, claimId, { claimId, memberId, coachId: coach.owner, studentId, status: 'verified' })
  return { memberId, claimId, studentId }
}

const coachKeyOf = coachId => memberBooking.fixedId('member-coach-view', coachId)
const packageViewIdOf = (claimId, packageId) => memberBooking.fixedId('member-package-view', claimId, packageId)
const bookingViewIdOf = (claimId, bookingId) => memberBooking.fixedId(memberBooking.BOOKING_VIEW_KIND, claimId, bookingId)

let A, B, claim1, PKG
function setupBase() {
  world.reset()
  A = world.seedCoach('open-a', 'ds-a', 'PUBA')
  B = world.seedCoach('open-b', 'ds-b', 'PUBB')
  world.seedStudent(A, 'stu-a', '会员甲')
  world.seedStudent(B, 'stu-b', '会员乙')
  seedPackage(A, 'stu-a', 'pkg-a')
  seedSale(A, 'stu-a', 'sale-a')
  seedIncome(A, 'income-a')
  claim1 = seedClaim('open-m1', A, 'stu-a')
  PKG = 'pkg-a'
  memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
}

function member(event, openId = 'open-m1') {
  world.setOpenId(openId)
  return world.main()(Object.assign({ action: 'memberBooking', environment: ENV }, event))
}
let seq = 0
const rid = prefix => `${prefix}_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`

const slot = (date, hour, minute = 0) => ({
  coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date, hour, minute
})
async function create(date, hour, minute = 0, requestId) {
  return member({ command: 'createMemberBooking', requestId: requestId || rid('mbk'), payload: slot(date, hour, minute) })
}
async function cancel(bookingId, requestId, openId = 'open-m1') {
  return member({
    command: 'cancelMemberBooking', requestId: requestId || rid('mbm'),
    payload: { bookingViewId: bookingViewIdOf(claim1.claimId, bookingId) }
  }, openId)
}
async function resched(bookingId, date, hour, minute = 0, requestId) {
  return member({
    command: 'rescheduleMemberBooking', requestId: requestId || rid('mbm'),
    payload: { bookingViewId: bookingViewIdOf(claim1.claimId, bookingId), date, hour, minute }
  })
}

const pkgData = () => (world.rows('packages', A.owner, A.datasetId).find(r => r.packageId === PKG) || {}).data || {}
const counts = () => { const d = pkgData(); return { remaining: d.remaining, used: d.used, total: d.total, reserved: d.reserved } }
const reserved = () => pkgData().reserved
const bookingRowOf = id => world.rows('bookings', A.owner, A.datasetId).find(r => r.bookingId === id)
const bookingDataOf = id => (bookingRowOf(id) || {}).data || null
const bookingCount = () => world.rows('bookings', A.owner, A.datasetId).length
// ⚠️ 事件集合是**元集合**（行上没有 ownerCoachId / datasetId）⇒ 直接从 store 取，不用按账本过滤。
function events() { return [...world.stores[EVENTS].values()].map(row => row.data || row) }
const eventsOf = type => events().filter(event => event.type === type)
function snapshotOf(...names) {
  return JSON.stringify(names.map(name => [...world.stores[name].values()].map(row => JSON.stringify(row)).sort()))
}
const ledgerSnapshot = () => snapshotOf('sales', 'incomes', 'settings')
const durableSnapshot = () => snapshotOf('sales', 'incomes', 'settings', 'students', CLAIMS)

async function main() {
  memberBooking.setPolicy(memberBooking.POLICY_DIRECT)

  // ---------------------------------------------------------------- 基线
  await runner('① 基线：会员创建预约真的落库，reserved +1', async () => {
    setupBase()
    const created = await create(D(3), 10)
    assert.strictEqual(created.ok, true, `创建必须成功：${created.code || ''} ${created.message || ''}`)
    assert.ok(created.bookingId, '必须返回 bookingId')
    assert.deepStrictEqual(counts(), { remaining: 8, used: 1, total: 10, reserved: 1 })
    assert.strictEqual(bookingDataOf(created.bookingId).status, 'booked')
  })

  // ---------------------------------------------------------------- 规则 1
  await runner('② 规则1：任何时间都能取消 —— 开课当天 / 已开课的时段都能取消（没有截止时间）', async () => {
    setupBase()
    // ⛔ 2026-10-01 起：00:00–06:59 **不能**作为会员新预约的起始 ⇒ 改用 07:00（同样早已开课，
    //    仍然验证"已开课的时段也能取消"这条规则本身）。
    const early = await create(TODAY, 7)                  // 今天 07:00 = 早就开课了
    assert.strictEqual(early.ok, true, `今天 07:00 应可预约：${early.code || ''}`)
    const done = await cancel(early.bookingId)
    assert.strictEqual(done.ok, true, `今天 07:00 的课必须能取消（任何时间都能取消）：${done.code || ''} ${done.message || ''}`)
    assert.strictEqual(done.status, 'cancelled')

    assert.strictEqual(memberBooking.MANAGE_POLICY.CANCEL_DEADLINE_MINUTES, null, '规则1 ⇒ 截止时间必须是 null')
    const block = blockOf(stripped(MEMBER_SRC), 'async function cancelMemberBookingHandler', 'async function rescheduleMemberBookingHandler')
    assert.ok(!/(Date\.now|context\.now)\s*[-+]/.test(block), '⛔ 取消路径不许用"现在 vs 开课时间"的距离做判定')
    // ⛔ 不许出现任何"分钟阈值"比较（例如 `> 240`、`< 120`）；`CANCEL_DEADLINE_MINUTES != null` 那道
    //    fail-closed 守卫是**必须保留**的（它确认规则仍是 null），所以这里只钉"没有数字阈值"。
    assert.ok(!/[<>]=?\s*\d{2,5}/.test(block), '⛔ 取消路径不许出现任何分钟/小时阈值比较')
    assert.ok(/CANCEL_DEADLINE_MINUTES\s*!=\s*null/.test(block), '必须保留 fail-closed 守卫（规则一旦被改成数字就报错，而不是悄悄生效）')
  })

  // ---------------------------------------------------------------- 规则 2
  await runner('③ 规则2：取消只释放 reserved（−1），remaining / used / total 一个字不动', async () => {
    setupBase()
    const before = counts()
    const created = await create(D(3), 10)
    assert.strictEqual(reserved(), before.reserved + 1, '创建后 reserved 应 +1')
    const done = await cancel(created.bookingId)
    assert.strictEqual(done.ok, true)
    assert.strictEqual(done.releasedReserved, true, '必须如实报告"释放了占座"')
    const after = counts()
    assert.strictEqual(after.reserved, before.reserved, 'reserved 必须回到取消前的值')
    assert.strictEqual(after.remaining, before.remaining, 'remaining 不许变')
    assert.strictEqual(after.used, before.used, 'used 不许变')
    assert.strictEqual(after.total, before.total, 'total 不许变')
    assert.ok(!('remaining' in done) && !('used' in done) && !('total' in done), '取消的返回值不许带余额字段（会让人以为这里改过余额）')
  })

  await runner('④ 规则2：取消不动 sales / incomes（逐字节快照），也不产生任何收入', async () => {
    setupBase()
    const created = await create(D(3), 10)
    const ledgerBefore = ledgerSnapshot()
    const incomeCountBefore = world.rows('incomes', A.owner, A.datasetId).length
    await cancel(created.bookingId)
    assert.strictEqual(ledgerSnapshot(), ledgerBefore, 'sales / incomes / settings 必须逐字节不变')
    assert.strictEqual(world.rows('incomes', A.owner, A.datasetId).length, incomeCountBefore, '不许产生收入记录')
    const block = blockOf(stripped(MEMBER_SRC), 'async function cancelMemberBookingHandler', 'async function rescheduleMemberBookingHandler')
    assert.ok(!/collection\('incomes'\)|collection\('sales'\)/.test(block), '⛔ 取消路径不许碰 incomes / sales')
  })

  await runner('⑤ 已完成的课不许被取消成"没上过"（BOOKING_ALREADY_DONE，且一个字不改）', async () => {
    setupBase()
    const created = await create(D(3), 10)
    const row = bookingRowOf(created.bookingId)
    world.put('bookings', row._id, { ...row, data: { ...row.data, status: 'done' } })
    const rejected = await cancel(created.bookingId)
    assert.strictEqual(rejected.ok, false)
    assert.strictEqual(rejected.code, 'BOOKING_ALREADY_DONE')
    assert.strictEqual(reserved(), 1, '被拒时不许动 reserved')
    assert.strictEqual(bookingDataOf(created.bookingId).status, 'done', '状态不许被改')
  })

  // ---------------------------------------------------------------- 幂等
  await runner('⑥ 重复取消幂等：第二次成功返回、零副作用、不重复释放、不产生第二条事件', async () => {
    setupBase()
    const created = await create(D(3), 10)
    const first = await cancel(created.bookingId)
    assert.strictEqual(first.ok, true)
    assert.strictEqual(first.cancelled, true)
    const reservedAfterFirst = reserved()
    const eventsAfterFirst = events().length
    const ledgerAfterFirst = ledgerSnapshot()
    const second = await cancel(created.bookingId)
    assert.strictEqual(second.ok, true, '重复取消必须成功返回（这是正确性，不是宽容）')
    assert.strictEqual(second.alreadyCancelled, true)
    assert.strictEqual(second.cancelled, false, '第二次不许报告"又取消了一次"')
    assert.strictEqual(reserved(), reservedAfterFirst, '⛔ 不许重复释放（会把 reserved 打到负数）')
    assert.strictEqual(events().length, eventsAfterFirst, '⛔ 不许产生第二条通知事件')
    assert.strictEqual(ledgerSnapshot(), ledgerAfterFirst, '账本必须不变')
  })

  await runner('⑦ requestId 幂等：同号重放不产生第二次释放；同号换参 ⇒ REQUEST_ID_CONFLICT', async () => {
    setupBase()
    const created = await create(D(3), 10)
    const requestId = 'mbm_idem_0001'
    const first = await cancel(created.bookingId, requestId)
    assert.strictEqual(first.ok, true)
    const reservedAfterFirst = reserved()
    const replay = await cancel(created.bookingId, requestId)
    assert.strictEqual(replay.ok, true, '同号重放必须命中收据')
    assert.strictEqual(replay.replayed, true, '必须如实报告"这是重放"')
    assert.strictEqual(reserved(), reservedAfterFirst, '⛔ 重放不许再动 reserved')
    // 同号换参 ⇒ 拒绝（否则"拿老号发新请求"就绕过幂等了）
    const created2 = await create(D(4), 11)
    const conflict = await cancel(created2.bookingId, requestId)
    assert.strictEqual(conflict.ok, false)
    assert.strictEqual(conflict.code, 'REQUEST_ID_CONFLICT')
    assert.strictEqual(reserved(), reservedAfterFirst + 1, '被拒时不许动 reserved')
    assert.strictEqual(bookingDataOf(created2.bookingId).status, 'booked', '被拒时那节课不许被取消')
  })

  // ---------------------------------------------------------------- 越权
  await runner('⑧ 越权取消：另一位会员拿别人的 bookingViewId ⇒ BOOKING_NOT_MINE，零写入', async () => {
    setupBase()
    const created = await create(D(3), 10)
    seedClaim('open-m2', A, 'stu-b')                       // 另一位会员（也有本账的认领关系）
    const reservedBefore = reserved()
    // 本人取消 ⇒ 成功（自证：这条预约确实存在且可取消，不是"因为不存在所以拒"）
    const mine = await cancel(created.bookingId)
    assert.strictEqual(mine.ok, true)
    assert.strictEqual(bookingDataOf(created.bookingId).status, 'cancelled')
    assert.strictEqual(reserved(), reservedBefore - 1)
    // 另一位会员拿同一条预约的视图 ID 过来 ⇒ 必须被拒，且零写入
    const created2 = await create(D(4), 10)
    const durableBefore = durableSnapshot()
    const reservedBeforeTheft = reserved()
    world.setOpenId('open-m2')
    const theft = await world.main()({
      action: 'memberBooking', environment: ENV, command: 'cancelMemberBooking', requestId: rid('mbm'),
      payload: { bookingViewId: bookingViewIdOf(claim1.claimId, created2.bookingId) }
    })
    assert.strictEqual(theft.ok, false, '别人必须取消不了')
    assert.strictEqual(theft.code, 'BOOKING_NOT_MINE')
    assert.strictEqual(bookingDataOf(created2.bookingId).status, 'booked', '别人的课必须原样不动')
    assert.strictEqual(reserved(), reservedBeforeTheft, 'reserved 不许变')
    assert.strictEqual(durableSnapshot(), durableBefore, '学生 / 认领 / 账本零写入')
  })

  await runner('⑨ 越权改期：另一位会员拿别人的 bookingViewId ⇒ BOOKING_NOT_MINE，时间一个字不改', async () => {
    setupBase()
    const created = await create(D(3), 10)
    seedClaim('open-m2', A, 'stu-b')
    world.setOpenId('open-m2')
    const stolen = await world.main()({
      action: 'memberBooking', environment: ENV, command: 'rescheduleMemberBooking', requestId: rid('mbm'),
      payload: { bookingViewId: bookingViewIdOf(claim1.claimId, created.bookingId), date: D(5), hour: 15, minute: 0 }
    })
    assert.strictEqual(stolen.ok, false)
    assert.strictEqual(stolen.code, 'BOOKING_NOT_MINE')
    const data = bookingDataOf(created.bookingId)
    assert.strictEqual(data.date, D(3), '日期不许被别人改')
    assert.strictEqual(data.hour, 10, '时间不许被别人改')
    assert.strictEqual(reserved(), 1, 'reserved 不许变')
  })

  // ---------------------------------------------------------------- 改期规则
  await runner('⑩ 规则4：改期不限次数（连改 5 次全成功，reserved 全程不动）', async () => {
    setupBase()
    const created = await create(D(2), 8)
    const reservedAfterCreate = reserved()
    const hours = [9, 11, 13, 15, 17]
    for (let i = 0; i < hours.length; i++) {
      const moved = await resched(created.bookingId, D(3 + i), hours[i])
      assert.strictEqual(moved.ok, true, `第 ${i + 1} 次改期必须成功：${moved.code || ''} ${moved.message || ''}`)
      assert.strictEqual(moved.reservedTouched, false, '改期**绝不碰** reserved')
      assert.strictEqual(reserved(), reservedAfterCreate, `第 ${i + 1} 次改期后 reserved 必须不变`)
    }
    assert.strictEqual(bookingDataOf(created.bookingId).hour, hours[hours.length - 1])
    const block = blockOf(stripped(MEMBER_SRC), 'async function rescheduleMemberBookingHandler', 'async function runMemberBooking')
    assert.ok(!/rescheduleCount|rescheduleTimes|timesRescheduled/.test(block), '⛔ 不许有改期次数计数器')
    assert.strictEqual(memberBooking.MANAGE_POLICY.RESCHEDULE_MAX_TIMES, Infinity)
  })

  await runner('⑪ 规则5：改期不需要教练确认 —— 一次调用即生效，且如实带出 from / to', async () => {
    setupBase()
    const created = await create(D(3), 10)
    const moved = await resched(created.bookingId, D(3), 16)
    assert.strictEqual(moved.ok, true)
    const data = bookingDataOf(created.bookingId)
    assert.strictEqual(data.hour, 16, '改期必须立即生效')
    assert.notStrictEqual(data.status, 'awaiting-coach', '⛔ 不许出现"等教练确认"这一档')
    assert.notStrictEqual((data.memberRequest || {}).status, 'awaiting-coach', '⛔ 会员请求状态也不许是"待确认"')
    assert.strictEqual(memberBooking.MANAGE_POLICY.RESCHEDULE_NEEDS_COACH_CONFIRM, false)
    assert.deepStrictEqual(moved.from, { date: D(3), hour: 10, minute: 0 }, '必须如实带出"从哪改"')
    assert.deepStrictEqual(moved.to, { date: D(3), hour: 16, minute: 0 }, '必须如实带出"改到哪"')
  })

  await runner('⑫ 改期忽略自身旧时段：改到自己原来那一格必须成功（不被自己锁死）', async () => {
    setupBase()
    const created = await create(D(3), 10)
    const same = await resched(created.bookingId, D(3), 10)   // 同一天同一格，连 minute 都一样
    assert.strictEqual(same.ok, true, `改到自己原来那一格必须成功：${same.code || ''} ${same.message || ''}`)
    assert.strictEqual(reserved(), 1, 'reserved 必须还是 1')
    assert.strictEqual(bookingCount(), 1, '不许变成两条预约')
    const next = await resched(created.bookingId, D(3), 11)   // 10:00+60 与 11:00 不重叠
    assert.strictEqual(next.ok, true, '相邻不重叠的时段必须可改')
  })

  await runner('⑬ 新时段冲突拒绝：与教练同账的另一节课重叠 ⇒ BOOKING_TIME_CONFLICT，原时段不变', async () => {
    setupBase()
    const first = await create(D(3), 10)
    const second = await create(D(3), 14)
    const firstBefore = bookingDataOf(first.bookingId)
    const conflict = await resched(first.bookingId, D(3), 14)
    assert.strictEqual(conflict.ok, false, '撞上教练已有的课必须被拒')
    assert.strictEqual(conflict.code, 'BOOKING_TIME_CONFLICT')
    const after = bookingDataOf(first.bookingId)
    assert.strictEqual(after.date, firstBefore.date, '被拒时原日期不许变')
    assert.strictEqual(after.hour, firstBefore.hour, '被拒时原时间不许变')
    assert.strictEqual(bookingDataOf(second.bookingId).hour, 14, '别人的课不许被动')
    assert.strictEqual(reserved(), 2, 'reserved 不许变')
  })

  await runner('⑭ 窗口：+30 天允许、+31 天拒绝、过去拒绝（创建与改期同一条判据）', async () => {
    setupBase()
    const onBoundary = await create(D(DAY), 10)
    assert.strictEqual(onBoundary.ok, true, `+${DAY} 天必须允许：${onBoundary.code || ''}`)
    const beyondCreate = await create(D(DAY + 1), 10)
    assert.strictEqual(beyondCreate.ok, false, `+${DAY + 1} 天必须拒绝`)
    assert.strictEqual(beyondCreate.code, 'MEMBER_BOOKING_BEYOND_WINDOW')
    const beyondResched = await resched(onBoundary.bookingId, D(DAY + 1), 11)
    assert.strictEqual(beyondResched.ok, false, '改期走同一条判据')
    assert.strictEqual(beyondResched.code, 'MEMBER_BOOKING_BEYOND_WINDOW')
    assert.strictEqual(bookingDataOf(onBoundary.bookingId).date, D(DAY), '被拒时日期不许变')
    const past = await resched(onBoundary.bookingId, D(-1), 11)
    assert.strictEqual(past.ok, false)
    assert.strictEqual(past.code, 'BOOKING_DATE_IN_PAST')
    assert.strictEqual(bookingDataOf(onBoundary.bookingId).date, D(DAY), '被拒时日期不许变')
  })

  await runner('⑮ ⭐ 开课窗口（2026-10-01 **二次**口径）：23:00 可约、23:30 / 23:45 拒（创建与改期同一把尺）', async () => {
    // ⛔ 本段原钉 2026-09-29 旧口径（"结束不得晚于 24:00"），已被用户 2026-10-01 最终规则取代。
    setupBase()
    const okSlot = await create(D(2), 23, 0)
    assert.strictEqual(okSlot.ok, true, `23:00 开课应合法：${okSlot.code || ''} ${okSlot.message || ''}`)
    // ⭐ 23:00 + 60 ⇒ 24:00 结束 ⇒ **合法**（正好卡在当天界上）
    //    注意：换到别的日期排，否则会和上面那节 23:00（结束于次日 00:00）真实重叠 ——
    //    那个重叠是**判据正确的表现**，单独在第 15b 段钉死。
    const last = await create(D(3), 23, 0)
    assert.strictEqual(last.ok, true, `23:00 是当天最后一个开课时间 ⇒ 必须可约（实测 ${JSON.stringify(last)}）`)
    // ⛔ 23:30 这一档已取消
    const halfPast = await create(D(4), 23, 30)
    assert.strictEqual(halfPast.ok, false, '23:30 已取消 ⇒ 必须拒')
    assert.strictEqual(halfPast.code, 'BOOKING_START_TOO_LATE')
    const tooLate = await create(D(3), 23, 45)
    assert.strictEqual(tooLate.ok, false, '23:45 开课 ⇒ 晚于 23:00，必须拒绝')
    assert.strictEqual(tooLate.code, 'BOOKING_START_TOO_LATE')
    const moved = await resched(okSlot.bookingId, D(2), 23, 45)
    assert.strictEqual(moved.ok, false, '改期也必须被同一道闸拦住（否则先约 10:00 再改到 23:45 就绕过了）')
    assert.strictEqual(moved.code, 'BOOKING_START_TOO_LATE')
    assert.strictEqual(bookingDataOf(okSlot.bookingId).hour, 23, '被拒时时间不许变')
  })

  await runner('⑮b ⭐ 冲突按**真实时长**判定：22:30 那节与 23:00 那节真实重叠 ⇒ 必须互斥', async () => {
    // 判别力：A：22:30–23:30；B：23:00–24:00 ⇒ 两段真实重叠 30 分钟。
    //   若冲突检测按"起始小时不同就是没冲突"判（旧写法），这里会漏判 ⇒ 两个会员撞在同一节课。
    //   ⛔ 23:30 那一档取消后，"跨午夜漏判"（日期字段不同）改由下面两处钉死 —— 别在这段里重复造：
    //     · `booking-start-window.test.js` ⑧（22:30 开 + 120 分钟 ⇒ 跨到次日 00:30）
    //     · `latest-start-2300.test.js` ⑥（存量的 23:30 旧课仍占用次日 00:00–00:30）
    setupBase()
    const first = await create(D(2), 23, 0)
    assert.strictEqual(first.ok, true, `23:00 第一节必须排得上：${first.code || ''}`)
    const clash = await create(D(2), 22, 30)
    assert.strictEqual(clash.ok, false, '22:30–23:30 与 23:00–24:00 真实重叠 ⇒ 必须冲突拒绝')
    assert.strictEqual(clash.code, 'BOOKING_TIME_CONFLICT', `重叠必须报时间冲突（实测 ${JSON.stringify(clash)}）`)
    // 相邻但不重叠：22:00 → 23:00 与 23:00 → 次日 00:00 首尾相接 ⇒ 不算冲突
    const adjacent = await create(D(2), 22, 0)
    assert.strictEqual(adjacent.ok, true, `22:00–23:00 与 23:00–00:00 首尾相接 ⇒ 不算冲突（实测 ${JSON.stringify(adjacent)}）`)
  })

  // ---------------------------------------------------------------- 通知
  await runner('⑯ 规则6：会员取消 / 改期 ⇒ "通知这节课的授课教练"事件（一个人，不是广播）', async () => {
    setupBase()
    const created = await create(D(3), 10)
    await cancel(created.bookingId)
    const cancelled = eventsOf(notify.EVENT_TYPES.MEMBER_CANCELLED)
    assert.strictEqual(cancelled.length, 1, '会员取消必须恰好产生一条事件')
    assert.deepStrictEqual(cancelled[0].actor, { kind: 'member', memberId: claim1.memberId })
    assert.deepStrictEqual(cancelled[0].recipient, { kind: 'coach', coachId: A.owner }, 'recipient = 授课教练本人')
    assert.strictEqual(cancelled[0].booking.bookingId, created.bookingId, '事件必须指向这条预约')

    const created2 = await create(D(4), 10)
    await resched(created2.bookingId, D(4), 15)
    const moved = eventsOf(notify.EVENT_TYPES.MEMBER_RESCHEDULED)
    assert.strictEqual(moved.length, 1, '会员改期必须恰好产生一条事件')
    assert.deepStrictEqual(moved[0].actor, { kind: 'member', memberId: claim1.memberId })
    assert.deepStrictEqual(moved[0].recipient, { kind: 'coach', coachId: A.owner })
    assert.strictEqual(moved[0].booking.hour, 15, '事件必须带**改后**的时间')
  })

  await runner('⑰ 规则6：教练取消 / 改期 ⇒ "通知这位会员"事件（actor 是教练）', async () => {
    setupBase()
    const created = await create(D(3), 10)
    const coachMoved = await world.execute(A, 'rescheduleBooking', { bookingId: created.bookingId, date: D(3), hour: 16, minute: 0 })
    assert.strictEqual(coachMoved.ok, true, `教练改期应成功：${coachMoved.code || ''}`)
    const coachResched = eventsOf(notify.EVENT_TYPES.COACH_RESCHEDULED)
    assert.strictEqual(coachResched.length, 1)
    assert.deepStrictEqual(coachResched[0].actor, { kind: 'coach', coachId: A.owner })
    assert.deepStrictEqual(coachResched[0].recipient, { kind: 'member', memberId: claim1.memberId })

    const coachCancelled = await world.execute(A, 'cancelBooking', { bookingId: created.bookingId })
    assert.strictEqual(coachCancelled.ok, true)
    const coachCancel = eventsOf(notify.EVENT_TYPES.COACH_CANCELLED)
    assert.strictEqual(coachCancel.length, 1)
    assert.deepStrictEqual(coachCancel[0].recipient, { kind: 'member', memberId: claim1.memberId })
  })

  await runner('⑱ ⛔ 一次会员改期只落**一条**事件，actor 不许被伪造成教练（故障恢复时发现并修掉的缺陷）', async () => {
    setupBase()
    const created = await create(D(3), 10)
    await resched(created.bookingId, D(3), 15)
    // ⚠️ 2026-10-05 口径变更：**预约成功**现在也会记一条（M4 需求五，补上 D0 缺口）⇒
    //    库里会有 2 条（预约成功 + 改期）。本条判的是"**改期**只落一条、且 actor 不被伪造成教练"。
    const all = eventsOf(notify.EVENT_TYPES.MEMBER_RESCHEDULED)
    assert.strictEqual(all.length, 1, `一次会员改期只能有 1 条改期事件，实测 ${all.length} 条（多出来的那条会把 actor 伪造成教练、并给会员自己发通知）`)
    assert.strictEqual(eventsOf(notify.EVENT_TYPES.MEMBER_CREATED).length, 1, '（口径）预约成功另有一条')
    assert.strictEqual(all[0].type, notify.EVENT_TYPES.MEMBER_RESCHEDULED)
    assert.strictEqual(all[0].actor.kind, 'member', '⛔ actor 不许是 coach')
    assert.notDeepStrictEqual(all[0].recipient, { kind: 'member', memberId: claim1.memberId }, '⛔ 不许通知会员本人自己刚做的事')
    // 教练通道**没有**被一起抑制（否则上面这条会假绿）
    const created2 = await create(D(4), 10)
    await world.execute(A, 'rescheduleBooking', { bookingId: created2.bookingId, date: D(4), hour: 12, minute: 0 })
    assert.strictEqual(eventsOf(notify.EVENT_TYPES.COACH_RESCHEDULED).length, 1, '教练通道必须仍然记事件')
    assert.ok(/suppressBookingChangeNotify/.test(stripped('cloudfunctions/coachBusinessCommand/handlers.js')), '抑制开关必须真的在 handlers 里生效')
    assert.ok(/suppressBookingChangeNotify:\s*true/.test(stripped(MEMBER_SRC)), '会员改期必须显式抑制教练侧那条')
  })

  await runner('⑲ ⛔ 不得伪造"微信通知已发送"：事件恒为未投递，且没有任何真实渠道', async () => {
    setupBase()
    assert.strictEqual(notify.ACTIVE_CHANNEL, null, '本轮不许有真实投递渠道')
    assert.strictEqual(notify.deliverable(), false)
    const created = await create(D(3), 10)
    await cancel(created.bookingId)
    const all = events()
    assert.ok(all.length > 0)
    for (const event of all) {
      assert.strictEqual(event.delivered, false, '⛔ 一条都不许写成"已投递"')
      assert.strictEqual(event.delivery.channel, null, '⛔ 不许写成 wechat-subscribe 之类')
      assert.strictEqual(event.delivery.sentAt, null)
    }
    const source = stripped('cloudfunctions/coachBusinessCommand/notify.js')
    assert.ok(!/wechat-subscribe|sendSubscribeMessage|sent:\s*true/.test(source), '⛔ notify.js 里不许出现真实发送渠道')
    assert.ok(!/delivered:\s*true/.test(source), '⛔ 不允许把 delivered 硬写成 true')
    assert.ok(!Object.values(core.BUSINESS).includes(EVENTS), '事件集合必须是元集合，不进 BUSINESS（读链 / checksum 零影响）')
  })

  // ---------------------------------------------------------------- 安全边界
  await runner('⑳ 无档案不能操作（MEMBER_CLAIM_NOT_FOUND，零写入，绝不自助建档）', async () => {
    setupBase()
    const created = await create(D(3), 10)
    const before = durableSnapshot()
    world.setOpenId('open-nobody')                        // 一个**没有认领关系**的 openId
    const byCreate = await world.main()({
      action: 'memberBooking', environment: ENV, command: 'createMemberBooking', requestId: rid('mbk'),
      payload: slot(D(3), 12)
    })
    assert.strictEqual(byCreate.ok, false)
    assert.strictEqual(byCreate.code, 'MEMBER_CLAIM_NOT_FOUND')
    const fakeClaimId = memberBooking.fixedId(CLAIMS, A.owner, 'stu-a')
    const byCancel = await world.main()({
      action: 'memberBooking', environment: ENV, command: 'cancelMemberBooking', requestId: rid('mbm'),
      payload: { bookingViewId: bookingViewIdOf(fakeClaimId, created.bookingId) }
    })
    assert.strictEqual(byCancel.ok, false)
    assert.strictEqual(byCancel.code, 'MEMBER_CLAIM_NOT_FOUND', '没档案的人连"这条是不是我的"都不许被回答')
    const byResched = await world.main()({
      action: 'memberBooking', environment: ENV, command: 'rescheduleMemberBooking', requestId: rid('mbm'),
      payload: { bookingViewId: bookingViewIdOf(fakeClaimId, created.bookingId), date: D(5), hour: 9, minute: 0 }
    })
    assert.strictEqual(byResched.ok, false)
    assert.strictEqual(byResched.code, 'MEMBER_CLAIM_NOT_FOUND')
    assert.strictEqual(durableSnapshot(), before, '⛔ 零写入（students / claims 一个字节都不动）')
    assert.strictEqual(world.rows('students', A.owner, A.datasetId).length, 1, '⛔ 绝不按姓名 / 手机号自动建档')
  })

  await runner('㉑ 身份 / 定位字段：客户端提交 memberId / coachId / bookingId 一律拒（服务端反解才是唯一来源）', async () => {
    setupBase()
    const created = await create(D(3), 10)
    const viewId = bookingViewIdOf(claim1.claimId, created.bookingId)
    const cases = [
      { command: 'cancelMemberBooking', field: 'memberId', value: claim1.memberId },
      { command: 'cancelMemberBooking', field: 'coachId', value: A.owner },
      { command: 'cancelMemberBooking', field: 'bookingId', value: created.bookingId },
      { command: 'rescheduleMemberBooking', field: 'studentId', value: 'stu-a' },
      { command: 'rescheduleMemberBooking', field: 'openId', value: 'open-a' }
    ]
    for (const item of cases) {
      const payload = item.command === 'cancelMemberBooking'
        ? { bookingViewId: viewId, [item.field]: item.value }
        : { bookingViewId: viewId, date: D(4), hour: 9, minute: 0, [item.field]: item.value }
      const rejected = await member({ command: item.command, requestId: rid('mbm'), payload })
      assert.strictEqual(rejected.ok, false, `提交 ${item.field} 必须被拒`)
      assert.strictEqual(rejected.code, 'FORBIDDEN_IDENTITY_INPUT', `提交 ${item.field} 应报 FORBIDDEN_IDENTITY_INPUT，实际 ${rejected.code}`)
    }
    assert.strictEqual(memberBooking.FORBIDDEN_KEYS.includes('bookingId'), true, 'bookingId 必须在禁用清单里')
    assert.strictEqual(reserved(), 1, '全部被拒 ⇒ 不许有任何写入')
    assert.strictEqual(bookingDataOf(created.bookingId).hour, 10)
  })

  await runner('㉒ 命令 / 字段白名单：只有三条会员命令；字段按命令分表（取消不许夹带时间）', async () => {
    setupBase()
    assert.deepStrictEqual([...memberBooking.MEMBER_COMMANDS],
      ['createMemberBooking', 'cancelMemberBooking', 'rescheduleMemberBooking'])
    const created = await create(D(3), 10)
    const viewId = bookingViewIdOf(claim1.claimId, created.bookingId)
    const sneaky = await member({ command: 'cancelMemberBooking', requestId: rid('mbm'), payload: { bookingViewId: viewId, date: D(5) } })
    assert.strictEqual(sneaky.ok, false, '取消夹带 date ⇒ 必须拒（否则一条永远不会被读的字段进了请求）')
    assert.strictEqual(sneaky.code, 'INVALID_PAYLOAD')
    const missing = await member({ command: 'rescheduleMemberBooking', requestId: rid('mbm'), payload: { bookingViewId: viewId } })
    assert.strictEqual(missing.ok, false, '改期缺时间 ⇒ 必须拒')
    for (const name of ['cancelBooking', 'rescheduleBooking', 'createBooking', 'deleteManualSale']) {
      const wrong = await member({ command: name, requestId: rid('x'), payload: { bookingViewId: viewId } })
      assert.strictEqual(wrong.ok, false, `${name} 不许从会员入口进来`)
      assert.strictEqual(wrong.code, 'UNKNOWN_COMMAND', `${name} 的返回码必须是 UNKNOWN_COMMAND`)
    }
    assert.strictEqual(reserved(), 1, '全部被拒 ⇒ reserved 不许变')
  })

  await runner('㉓ 六条规则**唯一真相源**：云端 MANAGE_POLICY ↔ 客户端 POLICY_DEFAULTS 逐字段一致', async () => {
    const cloud = memberBooking.MANAGE_POLICY
    const client = manage.POLICY_DEFAULTS
    const keys = new Set([...Object.keys(cloud), ...Object.keys(client)])
    assert.ok(keys.size >= 6, '六条规则一条都不能少')
    for (const key of keys) {
      const a = cloud[key], b = client[key]
      assert.ok(a === b || (a === Infinity && b === Infinity), `规则 ${key} 云端与客户端不一致：cloud=${a} client=${b}`)
    }
    assert.strictEqual(cloud.CANCEL_DEADLINE_MINUTES, null, '规则1：没有截止时间')
    assert.strictEqual(cloud.CANCEL_RELEASES_RESERVED, true, '规则2：取消释放占座')
    assert.strictEqual(cloud.CANCEL_COUNTS_AS_BREACH, false, '规则3：不计违约')
    assert.strictEqual(cloud.RESCHEDULE_MAX_TIMES, Infinity, '规则4：不限次数')
    assert.strictEqual(cloud.RESCHEDULE_NEEDS_COACH_CONFIRM, false, '规则5：不需要教练确认')
    assert.strictEqual(cloud.NOTIFY_ON_CHANGE, true, '规则6：必须通知另一方')
    // 两条最容易被人改口径的规则，钉进源码（改一处不改另一处 ⇒ 红）
    assert.ok(/CANCEL_DEADLINE_MINUTES:\s*null/.test(stripped(MEMBER_SRC)), '截止时间必须字面写成 null')
    assert.ok(/RESCHEDULE_NEEDS_COACH_CONFIRM:\s*false/.test(stripped(MEMBER_SRC)))
    assert.strictEqual(manage.policyBlocked(), false, '六条已定 ⇒ 不再阻塞')
  })

  await runner('㉔ 规则3：没有任何违约计数 / 惩罚机制（源码级，不许有计数器）', async () => {
    const source = stripped(MEMBER_SRC)
    assert.ok(!/breachCount|violationCount|penaltyCount|cancelCount\s*[+]{2}|cancelTimes/.test(source), '⛔ 不许出现违约 / 惩罚计数器')
    assert.strictEqual(memberBooking.MANAGE_POLICY.CANCEL_COUNTS_AS_BREACH, false)
    const block = blockOf(source, 'async function cancelMemberBookingHandler', 'async function rescheduleMemberBookingHandler')
    assert.ok(!/breach|violation|penalty/.test(block), '取消路径不许出现违约概念')
  })

  await runner('㉕ 取消保留历史：改状态而不是物理删除（bookings.remove 不在会员取消路径上）', async () => {
    setupBase()
    const created = await create(D(3), 10)
    const before = bookingCount()
    await cancel(created.bookingId)
    assert.strictEqual(bookingCount(), before, '⛔ 预约文档不许被删掉（历史必须留着）')
    const data = bookingDataOf(created.bookingId)
    assert.strictEqual(data.status, 'cancelled', '状态必须明确记录为 cancelled')
    assert.ok(data.cancelledAt, '必须记录取消时间')
    assert.strictEqual(data.cancelledByMemberId, claim1.memberId, '必须记录是谁取消的')
    const block = blockOf(stripped(MEMBER_SRC), 'async function cancelMemberBookingHandler', 'async function rescheduleMemberBookingHandler')
    assert.ok(!/\.remove\(/.test(block), '⛔ 会员取消路径不许物理删除')
  })

  await runner('㉖ 已取消的课不许再改期（BOOKING_ALREADY_CANCELLED，一个字不改）', async () => {
    setupBase()
    const created = await create(D(3), 10)
    await cancel(created.bookingId)
    const moved = await resched(created.bookingId, D(5), 15)
    assert.strictEqual(moved.ok, false)
    assert.strictEqual(moved.code, 'BOOKING_ALREADY_CANCELLED')
    const data = bookingDataOf(created.bookingId)
    assert.strictEqual(data.status, 'cancelled', '状态不许被改回来')
    assert.strictEqual(data.hour, 10, '时间一个字不许动')
    assert.strictEqual(reserved(), 0, 'reserved 不许被改期改动')
  })

  await runner('㉗ 并发 fail closed：revision 由服务端读，客户端提交不了', async () => {
    const source = stripped(MEMBER_SRC)
    assert.ok(/expectedRevision:\s*context\.revision\.dataRevision/.test(source), 'revision 必须由服务端读')
    assert.ok(!/event\.expectedRevision|payload\.expectedRevision/.test(source), '⛔ 客户端不许提交 revision')
    assert.ok(/core\.activeContext/.test(source), '必须走 core.activeContext 取可信账本状态')
    // 事务内终判：30 天 / 余额 / 冲突都在 handler 里再判一次（不是只靠入口早拒）
    const handler = blockOf(source, 'async function createMemberBookingHandler', 'async function markMemberBooking')
    assert.ok(/memberBookingDateAllowed/.test(handler), '30 天必须在**事务内**终判')
    assert.ok(/assertMayBook/.test(handler), '双层权限必须在事务内终判')
  })

  await runner('㉘ 连续取消三节课全部成功，reserved 回零而 remaining 不动', async () => {
    setupBase()
    const a = await create(D(2), 8)
    const b = await create(D(3), 9)
    const c = await create(D(4), 10)
    assert.strictEqual(reserved(), 3)
    assert.strictEqual((await cancel(a.bookingId)).ok, true)
    assert.strictEqual((await cancel(b.bookingId)).ok, true)
    assert.strictEqual((await cancel(c.bookingId)).ok, true)
    assert.strictEqual(reserved(), 0, '三节全部释放 ⇒ reserved 回零')
    assert.deepStrictEqual([a, b, c].map(x => bookingDataOf(x.bookingId).status), ['cancelled', 'cancelled', 'cancelled'])
    assert.strictEqual(pkgData().remaining, 8, 'remaining 一个字不动')
  })

  await runner('㉙ 前端写链总闸与云端能力一致（P6 打开总闸的前提已成立）', async () => {
    assert.strictEqual(flags.MEMBER_MANAGE_SUBMIT, true, '总闸已开（前提：云端写链 + 客户端接线 + 测试 + 反证齐备）')
    assert.strictEqual(flags.memberManageSubmitEnabled(), true)
    assert.strictEqual(manage.policyBlocked(), false, '六条规则必须全部已定')
    assert.deepStrictEqual([...memberBooking.MEMBER_COMMANDS].sort(),
      ['cancelMemberBooking', 'createMemberBooking', 'rescheduleMemberBooking'].sort())
  })

  // 归还全局状态（其它测试文件也会 require 同一个模块实例）
  memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
  process.stdout.write('m3-p6-member-manage-write: 29 sections PASS\n')
}

main().catch(error => { process.stderr.write(`FATAL ${error && error.stack}\n`); process.exitCode = 1 })
