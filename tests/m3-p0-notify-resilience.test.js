// M3-P0 · 「通知事件**不得**阻断预约主事务」—— 真机事故的永久回归（2026-09-30）
//
// ★★ 事故现场（A/B 双手机真机验收，B 手机点「取消预约」）★★
//   `collection.get:fail -502005` / `Db or Table not exist: member_sandbox_notification_events`
//   ⇒ 会员**连取消都点不动**：业务明明完全合法，却被一个**附属**功能（通知）拖死。
//
// ★★ 三层根因（本文件逐层钉住）★★
//   ① **Sandbox collection 初始化遗漏**：`member_sandbox_notification_events` 从未在真环境创建。
//      命名与环境路由**都是对的**（与 `member_sandbox_student_claims` / `member_sandbox_coach_profiles`
//      同一口径），所以这不是"名字写错"，是"集合忘了建"。
//   ② **旧实现把通知写在了业务事务内部**（`record()` 里直接 `tx.collection(...).get()/set()`）
//      ⇒ 集合缺失时 `-502005` 把**整个预约事务**一起回滚。
//   ③ **旧假件永远不报 `-502005`**（`collection(name)` 不存在就自动新建 Map）
//      ⇒ 真机上"集合忘了建"这类故障在本地 151 个测试里**一次都测不到** —— P0 就是这么逃逸的。
//
// ★★ 修法（本文件锁死的契约）★★
//   · `notify.scope().record()` 事务内**只入队**（纯内存，一个 await 都没有）⇒ 通知链任何故障都
//     不可能回滚业务；
//   · 真正落库推迟到 `core.execute` 里 `runTransaction` **成功返回之后**的 `flush(db)`；
//   · 业务回滚 ⇒ `flush` 根本不被执行 ⇒ 依然"绝不留假通知"（原子性语义**没有**被削弱）；
//   · 落库失败 ⇒ **不回滚业务**，但**绝不静默**：进响应的 `notify` 字段 + `console.error` 日志。
//
// ★★ 用户的四条硬要求（逐条对应）★★
//   · 取消预约核心事务必须可靠完成 ……………… ②③④⑤⑥⑰
//   · 课时退回 / 状态 / 教练课表 / 可约时段一致 … ③⑥（reserved 释放、remaining/used/total 不动）
//   · 通知失败不许破坏业务，但不许简单吞掉 ……… ④（可追踪）+ ⑬（源码锚：不允许回退成事务内直写）
//   · 「修改时间」是否同源 …………………………… ⑥（改期走同一个 flush，同一个集合）

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createWorld, runner } = require('./helpers/m2-business-world')

const ROOT = path.join(__dirname, '..')
const memberBooking = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
const cloudOccupancy = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/occupancy'))
const notify = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/notify'))

const CLAIMS = 'member_sandbox_student_claims'
const EVENTS = 'member_sandbox_notification_events'
const PRODUCTION_EVENTS = 'member_notification_events'
const ENV = 'sandbox'
// 假世界的时钟起点（helpers/m2-business-world.js: `let clock = 1900000000000`）。
const CLOCK0 = 1900000000000
const TODAY = memberBooking.beijingDateKey(CLOCK0)
const D = n => cloudOccupancy.addDateDays(TODAY, n)

const world = createWorld()

const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
}
function blockOf(source, startMarker, endMarker) {
  const from = source.indexOf(startMarker)
  assert.ok(from >= 0, `源码里找不到 ${startMarker}`)
  const to = endMarker ? source.indexOf(endMarker, from + startMarker.length) : -1
  return source.slice(from, to > from ? to : undefined)
}

// 静音 console.error（云函数侧那条可追踪日志），同时把它捕获下来供断言。
async function quiet(fn) {
  const original = console.error
  const logs = []
  console.error = (...args) => { logs.push(args.map(String).join(' ')) }
  try { return { value: await fn(), logs } } finally { console.error = original }
}

// ------------------------------------------------------------------ 落库助手（与 P6 测试同口径）
function seedPackage(coach, studentId, packageId) {
  world.put('packages', world.businessId('packages', coach.owner, coach.datasetId, packageId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, packageId, studentId,
    data: { id: packageId, type: '常规训练', total: 10, remaining: 8, used: 1, reserved: 0, reservedVersion: 2, price: 300, status: 'active' }
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

let A, claim1
const PKG = 'pkg-a'
function setupBase() {
  world.reset()
  A = world.seedCoach('open-a', 'ds-a', 'PUBA')
  world.seedStudent(A, 'stu-a', '会员甲')
  seedPackage(A, 'stu-a', PKG)
  seedSale(A, 'stu-a', 'sale-a')
  seedIncome(A, 'income-a')
  claim1 = seedClaim('open-m1', A, 'stu-a')
  memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
}

function member(event, openId = 'open-m1') {
  world.setOpenId(openId)
  return world.main()(Object.assign({ action: 'memberBooking', environment: ENV }, event))
}
let seq = 0
const rid = prefix => `${prefix}_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`

async function create(date, hour, minute = 0, requestId) {
  return member({
    command: 'createMemberBooking', requestId: requestId || rid('mbk'),
    payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date, hour, minute }
  })
}
async function cancel(bookingId, requestId) {
  return member({
    command: 'cancelMemberBooking', requestId: requestId || rid('mbm'),
    payload: { bookingViewId: bookingViewIdOf(claim1.claimId, bookingId) }
  })
}
async function resched(bookingId, date, hour, minute = 0, requestId) {
  return member({
    command: 'rescheduleMemberBooking', requestId: requestId || rid('mbm'),
    payload: { bookingViewId: bookingViewIdOf(claim1.claimId, bookingId), date, hour, minute }
  })
}
const coachCancel = (bookingId) => world.execute(A, 'cancelBooking', { bookingId })

const pkgData = () => (world.rows('packages', A.owner, A.datasetId).find(r => r.packageId === PKG) || {}).data || {}
const counts = () => { const d = pkgData(); return { remaining: d.remaining, used: d.used, total: d.total, reserved: d.reserved } }
const bookingRowOf = id => world.rows('bookings', A.owner, A.datasetId).find(r => r.bookingId === id)
const bookingDataOf = id => (bookingRowOf(id) || {}).data || null
const revisionNow = () => world.revisionOf(A.owner, A.datasetId)
// 事件集合是**元集合**（行上没有 ownerCoachId / datasetId）⇒ 直接从 store 取，不按账本过滤。
function events() { return [...world.stores[EVENTS].values()].map(row => row.data || row) }
const eventsOf = type => events().filter(event => event.type === type)
function snapshotOf(...names) {
  return JSON.stringify(names.map(name => [...world.stores[name].values()].map(row => JSON.stringify(row)).sort()))
}
const ledgerSnapshot = () => snapshotOf('sales', 'incomes', 'settings')

async function main() {
  memberBooking.setPolicy(memberBooking.POLICY_DIRECT)

  // ---------------------------------------------------------------- ① 基线：一切正常时，事件如实落库
  await runner('① 基线：取消成功 ⇒ 事件落库一条、notify.ok=true、delivered 恒 false 且无渠道', async () => {
    setupBase()
    const made = await create(D(1), 10)
    assert.strictEqual(made.ok, true, '创建必须成功')
    // ⭐ 2026-10-05 口径变更（M4 需求五 · 补上 D0 缺口）：**预约成功也必须通知教练** ⇒
    //    创建路径现在会记 `member-booking-created`（此前是"定义好了却零引用"的死常量）。
    assert.ok(made.notify, '创建成功后必须有一条"要通知教练"的事件')
    assert.strictEqual(made.notify.written, 1, '创建路径必须记上**一条**预约成功事件')
    const created = eventsOf(notify.EVENT_TYPES.MEMBER_CREATED)
    assert.strictEqual(created.length, 1, '★ 预约成功事件必须落库（否则教练端完全不知道有人约了课）')
    assert.strictEqual(created[0].recipient.coachId, A.owner, '接收方必须是这节课的授课教练')
    assert.strictEqual(created[0].delivered, false, '⛔ 落库 ≠ 已发送（投递层没跑之前 delivered 恒为 false）')

    const before = counts()
    const revisionBefore = revisionNow()
    const result = await cancel(made.bookingId)
    assert.strictEqual(result.ok, true, '取消必须成功')
    assert.strictEqual(result.cancelled, true)
    assert.strictEqual(result.releasedReserved, true, '必须真的释放 reserved')
    assert.strictEqual(revisionNow(), revisionBefore + 1, '业务事务必须真的提交（revision +1）')

    assert.deepStrictEqual(counts(), { remaining: before.remaining, used: before.used, total: before.total, reserved: before.reserved - 1 },
      '取消只把 reserved 放回去，remaining/used/total 一个字不动')

    const list = eventsOf(notify.EVENT_TYPES.MEMBER_CANCELLED)
    assert.strictEqual(list.length, 1, '必须落下**恰好一条**"要通知教练"的事件')
    assert.strictEqual(list[0].actor.kind, 'member', 'actor 是会员本人')
    assert.strictEqual(list[0].recipient.kind, 'coach', 'recipient 是这节课的授课教练')
    assert.strictEqual(list[0].recipient.coachId, A.owner)
    assert.strictEqual(list[0].delivered, false, '⛔ M4 之前 delivered 恒为 false')
    assert.strictEqual(list[0].delivery.channel, null, '⛔ 不许凭空造一个投递渠道')
    assert.deepStrictEqual(result.notify, {
      ok: true, collection: EVENTS, attempted: 1, written: 1, skipped: 0, failures: []
    }, '通知结果必须如实回传（这里应当是全绿）')
  })

  // ---------------------------------------------------------------- ②🎯 事故复现：集合不存在，取消**仍然成功**
  await runner('②🎯 通知集合不存在（真机 -502005 复现）⇒ 取消预约**依然成功**', async () => {
    setupBase()
    const made = await create(D(1), 10)
    const before = counts()
    world.missCollection(EVENTS)                      // ⛔ 复现真机事故现场
    const { value: result, logs } = await quiet(() => cancel(made.bookingId))
    world.restoreCollection(EVENTS)

    assert.strictEqual(result.ok, true, '★ 核心事务必须可靠完成：集合缺失**不许**让取消失败')
    assert.strictEqual(result.cancelled, true)
    assert.strictEqual(result.alreadyCancelled, false)
    assert.strictEqual(bookingDataOf(made.bookingId).status, 'cancelled', '预约状态必须落成 cancelled（保留历史）')
    assert.strictEqual(counts().reserved, before.reserved - 1, '★ 课时必须真的退回（reserved 释放）')
    assert.strictEqual(result.releasedReserved, true)
    assert.ok(logs.some(line => line.includes('[notify]')), '云函数日志里必须留下可追踪的一条')
  })

  // ---------------------------------------------------------------- ③ 事故现场的**数据一致性**：余额/历史一分不动
  await runner('③🎯 同场景：remaining / used / total 不变，sales / incomes 不变（不产生也不删收入）', async () => {
    setupBase()
    const made = await create(D(1), 10)
    const before = counts()
    const ledgerBefore = ledgerSnapshot()
    world.missCollection(EVENTS)
    const { value: result } = await quiet(() => cancel(made.bookingId))
    world.restoreCollection(EVENTS)

    assert.deepStrictEqual(counts(), { remaining: before.remaining, used: before.used, total: before.total, reserved: before.reserved - 1 })
    assert.strictEqual(ledgerSnapshot(), ledgerBefore, '取消**不产生也不删除**任何收入 / 销售记录')
    assert.strictEqual(result.ok, true)
  })

  // ---------------------------------------------------------------- ④🎯 不许静默吞掉：可追踪的错误处理
  await runner('④🎯 通知失败必须**可追踪**：notify.ok=false + 真实错误码 + 集合名（不是简单吞掉）', async () => {
    setupBase()
    const made = await create(D(1), 10)
    world.missCollection(EVENTS)
    const { value: result, logs } = await quiet(() => cancel(made.bookingId))
    world.restoreCollection(EVENTS)

    assert.ok(result.notify, '响应里必须有 notify 字段 —— 吞掉它就等于"课改了但谁都没被告知"且无人知晓')
    assert.strictEqual(result.notify.ok, false, '★ 必须如实说"通知没记上"')
    assert.strictEqual(result.notify.collection, EVENTS, '必须点名是哪个集合')
    assert.strictEqual(result.notify.attempted, 1, '必须如实报告"尝试了 1 条"')
    assert.strictEqual(result.notify.written, 0, '必须如实报告"写成了 0 条"')
    assert.ok(result.notify.failures.length >= 1, 'failures 必须非空')
    const failure = result.notify.failures[0]
    assert.strictEqual(failure.collection, EVENTS)
    assert.strictEqual(failure.environment, 'sandbox')
    assert.strictEqual(failure.stage, 'flush-write')
    assert.strictEqual(failure.code, '-502005', '必须把真机的错误码原样带出来（-502005 = Db or Table not exist）')
    assert.ok(/Table not exist/.test(failure.message), '必须带上原始报错文本')
    assert.ok(logs.length >= 1, '云函数日志里必须有一条 console.error（运维可搜）')
  })

  // ---------------------------------------------------------------- ⑤ 不许留假事件：失败就是真的没写进去
  await runner('⑤🎯 通知写失败 ⇒ 库里**确实没有**这条事件（不许留"没成功却通知了"的假事实）', async () => {
    setupBase()
    const made = await create(D(1), 10)
    world.missCollection(EVENTS)
    const { value: result } = await quiet(() => cancel(made.bookingId))

    // ⚠️ 2026-10-05：创建路径也会记事件（那一条是在集合可用时写进去的）⇒
    //    本条判的是"**取消**这条事件不许留下假事实"，所以按类型过滤。
    assert.strictEqual(eventsOf(notify.EVENT_TYPES.MEMBER_CANCELLED).length, 0, '集合缺失 ⇒ 取消那条事件一条都不许留下')
    assert.strictEqual(result.notify.written, 0)
    assert.strictEqual(bookingDataOf(made.bookingId).status, 'cancelled', '业务照常成立')
    world.restoreCollection(EVENTS)
  })

  // ---------------------------------------------------------------- ⑥🎯 同源检查：改期走同一条链，同样不受影响
  await runner('⑥🎯 「修改时间」走同一个 flush、同一个集合 ⇒ 集合缺失时改期**依然成功**', async () => {
    setupBase()
    const made = await create(D(1), 10)
    const before = counts()
    world.missCollection(EVENTS)
    const { value: result } = await quiet(() => resched(made.bookingId, D(2), 14))
    world.restoreCollection(EVENTS)

    assert.strictEqual(result.ok, true, '★ 改期也必须可靠完成（P0 第二问：同源路径）')
    const after = bookingDataOf(made.bookingId)
    assert.strictEqual(after.date, D(2), '时间必须真的改了')
    assert.strictEqual(after.hour, 14)
    assert.deepStrictEqual(counts(), { remaining: before.remaining, used: before.used, total: before.total, reserved: before.reserved },
      '改期**绝不碰 reserved**（这一节课从头到尾只占一格）')
    assert.strictEqual(result.reservedTouched, false)
    assert.strictEqual(result.notify.ok, false, '通知失败照样如实报告')
    assert.deepStrictEqual(result.from, { date: D(1), hour: 10, minute: 0 }, '必须如实带出"从哪改到哪"')
    assert.deepStrictEqual(result.to, { date: D(2), hour: 14, minute: 0 })
  })

  // ---------------------------------------------------------------- ⑦ 回归：集合恢复后，事件照常落库（修复不许造成漏写）
  await runner('⑦ 回归：集合恢复可用后，事件照常落库（修复**不许**变成"干脆不记事件"）', async () => {
    setupBase()
    const made = await create(D(1), 10)
    // 先失败一次（留下"这一条没记上"的事实）——
    world.missCollection(EVENTS)
    const first = (await quiet(() => cancel(made.bookingId))).value
    world.restoreCollection(EVENTS)
    assert.strictEqual(first.notify.ok, false)
    // ⚠️ 2026-10-05：创建那次（集合可用时）已经落了一条「预约成功」⇒ 这里按类型判"取消那条没记上"。
    assert.strictEqual(eventsOf(notify.EVENT_TYPES.MEMBER_CANCELLED).length, 0, '集合缺失期间取消那条一个字节都没记上')
    assert.strictEqual(eventsOf(notify.EVENT_TYPES.MEMBER_CREATED).length, 1, '（口径）预约成功那一条是集合可用时正常落库的')

    // 再走一条**新的**改期命令（新 requestId）⇒ 必须重新记上事件。
    const second = await create(D(3), 9)
    const moved = await resched(second.bookingId, D(4), 16)
    assert.strictEqual(moved.notify.ok, true, '集合可用后必须恢复正常')
    assert.strictEqual(moved.notify.written, 1, '这一次命令只记改期这一条（预约成功那条是 create 那一次记的）')
    assert.strictEqual(eventsOf(notify.EVENT_TYPES.MEMBER_RESCHEDULED).length, 1, '事件必须真的落库')
  })

  // ---------------------------------------------------------------- ⑧ 原子性语义**没有**被削弱：业务回滚 ⇒ 一个事件都不许留
  await runner('⑧ 业务回滚 ⇒ 一个通知事件都不许留（"没成功却通知了"依然不可能）', async () => {
    setupBase()
    const made = await create(D(1), 10)
    // 把这条课改成"已完成" ⇒ 取消必须被拒（改历史，不是取消）。
    bookingRowOf(made.bookingId).data.status = 'done'
    const result = await cancel(made.bookingId)
    assert.strictEqual(result.ok, false, '已完成的课不许被取消')
    assert.strictEqual(result.code, 'BOOKING_ALREADY_DONE')
    // ⚠️ 2026-10-05：库里已经有一条**创建成功**时记的预约成功事件（那一次业务是真的成功了）；
    //    本条判的是"这次被拒的取消**不许**留下事件"。
    assert.strictEqual(eventsOf(notify.EVENT_TYPES.MEMBER_CANCELLED).length, 0, '★ 业务失败 ⇒ flush 根本不会被执行 ⇒ 绝不留下假通知')

    // 再制造一次**事务内**失败：改到已过去的时间。
    bookingRowOf(made.bookingId).data.status = 'booked'
    const past = await resched(made.bookingId, cloudOccupancy.addDateDays(TODAY, -1), 10)
    assert.strictEqual(past.ok, false)
    assert.strictEqual(past.code, 'BOOKING_DATE_IN_PAST')
    assert.strictEqual(eventsOf(notify.EVENT_TYPES.MEMBER_RESCHEDULED).length, 0, '同样不许留事件')
  })

  // ---------------------------------------------------------------- ⑨ 幂等：同一个 requestId 重放 ⇒ 还是一条事件
  await runner('⑨ 幂等：同一 requestId 重复取消 ⇒ 只有一条事件（不会变成两条通知）', async () => {
    setupBase()
    const made = await create(D(1), 10)
    const same = rid('mbm')
    const first = await cancel(made.bookingId, same)
    const second = await cancel(made.bookingId, same)
    assert.strictEqual(first.ok, true)
    assert.strictEqual(second.ok, true)
    // ⚠️ 同一个 requestId 命中**收据重放**（返回第一次的响应原样），所以这里看的是 `replayed`
    //   而不是 `alreadyCancelled` —— 后者是"换一个 requestId 再取消一次"时才走的那条幂等支路。
    assert.strictEqual(second.replayed, true, '第二次必须是收据重放（幂等）')
    assert.strictEqual(second.cancelled, true, '重放返回的仍是第一次那次成功的结论')
    // ⚠️ 库里现在有两条：创建那次的「预约成功」+ 取消这条 ⇒ 判据按类型分开看。
    assert.strictEqual(eventsOf(notify.EVENT_TYPES.MEMBER_CANCELLED).length, 1, '重放不许产生第二条取消事件')
    assert.strictEqual(eventsOf(notify.EVENT_TYPES.MEMBER_CREATED).length, 1, '预约成功事件也只许一条')
  })

  // ---------------------------------------------------------------- ⑩ 一次会员改期只落一条事件（P6 缺陷的回归）
  await runner('⑩ 一次会员改期只落**一条**事件（actor=会员、recipient=教练，不伪造教练）', async () => {
    setupBase()
    const made = await create(D(1), 10)
    const moved = await resched(made.bookingId, D(2), 11)
    assert.strictEqual(moved.ok, true)
    assert.strictEqual(eventsOf(notify.EVENT_TYPES.MEMBER_RESCHEDULED).length, 1, '★ 改期只许一条（P6 修复过"双事件"缺陷）')
    assert.strictEqual(eventsOf(notify.EVENT_TYPES.MEMBER_CREATED).length, 1, '（口径）预约成功另有一条，不算双写')
    const event = eventsOf(notify.EVENT_TYPES.MEMBER_RESCHEDULED)[0]
    assert.strictEqual(event.type, notify.EVENT_TYPES.MEMBER_RESCHEDULED)
    assert.strictEqual(event.actor.kind, 'member')
    assert.strictEqual(event.recipient.kind, 'coach')
    assert.strictEqual(event.recipient.coachId, A.owner)
  })

  // ---------------------------------------------------------------- ⑪ 教练侧同样不被阻断
  await runner('⑪ 教练侧（教练取消会员的课）在集合缺失时同样成功，且失败可追踪', async () => {
    setupBase()
    const made = await create(D(1), 10)
    world.missCollection(EVENTS)
    const { value: result } = await quiet(() => coachCancel(made.bookingId))
    world.restoreCollection(EVENTS)

    assert.strictEqual(result.ok, true, '教练命令也不许被通知拖死')
    assert.strictEqual(bookingRowOf(made.bookingId), undefined, '教练端取消是物理删除（与会员端"保留历史"不同）')
    assert.ok(result.notify, '教练命令的响应里同样必须带 notify')
    assert.strictEqual(result.notify.ok, false)
    assert.strictEqual(result.notify.failures[0].code, '-502005')
  })

  // ---------------------------------------------------------------- ⑫ 命名与环境路由（不是"名字写错"，是"集合没建"）
  await runner('⑫ 命名口径：收集名与环境路由**本来就是对的**（所以根因是初始化遗漏，不是写错名）', async () => {
    assert.strictEqual(notify.COLLECTIONS.sandbox, EVENTS)
    assert.strictEqual(notify.COLLECTIONS.production, PRODUCTION_EVENTS)
    assert.strictEqual(notify.collectionFor('sandbox'), EVENTS)
    assert.strictEqual(notify.collectionFor('production'), PRODUCTION_EVENTS)
    assert.strictEqual(notify.collectionFor(undefined), PRODUCTION_EVENTS)
    // 与既有的 sandbox 会员集合**同一个前缀口径**（`member_sandbox_*`）。
    assert.ok(EVENTS.startsWith('member_sandbox_'), 'sandbox 事件集合必须沿用 member_sandbox_ 前缀')
    assert.ok(PRODUCTION_EVENTS.startsWith('member_'), 'production 事件集合必须沿用 member_ 前缀')
    // 教案：这套命名与 `authorization.collectionsFor('sandbox').claims` 同源。
    const authorization = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/authorization'))
    assert.strictEqual(authorization.collectionsFor('sandbox').claims, CLAIMS)
  })

  // ---------------------------------------------------------------- ⑬ 源码锚：record 里**一个 await 都不许有**
  await runner('⑬ 源码锚：`scope().record()` 里 0 个 await（不许回退成"事务内直写"）', async () => {
    const source = read('cloudfunctions/coachBusinessCommand/notify.js')
    // ⭐ 锚点随结构迁移（2026-10-08 第 74 轮）：`scope()` 多了第 5 个参数 `fallbackDb`
    //    （备读句柄 —— 事务内那条读万一不可用还能退到裸 `db` 普通读，⛔ 绝不让"读不到"变"静默断链"）。
    //    ⛔ 判据**不降**：下面仍然钉死 record 里 0 个 await、不许碰 tx.collection。
    //    ⛔ 顺带钉死第 5 参真的接到 `fallbackReader` 上（改回 4 参 ⇒ 这里立刻红）。
    const scopeBlock = blockOf(source, 'function scope(tx, environment, ownerCoachId, datasetId, fallbackDb) {',
      '// ------------------------------------------------------------------ M4')
    assert.ok(scopeBlock.includes('fallbackReader: fallbackDb || null'),
      '⛔ scope() 必须把第 5 参接到 fallbackReader（丢了备读句柄 ⇒ 真机读失败时整条通知链静默断掉）')
    const recordBlock = blockOf(scopeBlock, 'async function record(', '  // ⭐ 教练侧')
    assert.strictEqual((recordBlock.match(/\bawait\b/g) || []).length, 0,
      '⛔ record 里出现 await 就意味着它又在碰数据库了 ⇒ 集合缺失会再次回滚业务（事故复发）')
    assert.ok(!/tx\.collection/.test(recordBlock), '⛔ record 里连"读"事务集合都不许')

    // 反证：这个断言真的抓得住 —— 把"事务内直写"塞回 record，上面的断言必须变红。
    const mutated = recordBlock.replace('const eventId = eventIdFor(requestId, type)',
      'const eventId = eventIdFor(requestId, type)\n    await tx.collection(name).where({ _id: eventId }).limit(1).get()')
    const mutatedAwaits = (mutated.match(/\bawait\b/g) || []).length
    assert.ok(mutatedAwaits > 0,
      '反证：变异后 record 里出现了 await ⇒ 上面那条 `=== 0` 的断言必然变红（说明它有判别力）')
    assert.ok(/tx\.collection/.test(mutated), '反证：变异后确实出现了 tx.collection')
  })

  // ---------------------------------------------------------------- ⑭ 源码锚：flush 必须**在** runTransaction 之后
  await runner('⑭ 源码锚：`flush` 在 `runTransaction` **之后**，事务内不许出现 flush', async () => {
    const source = read('cloudfunctions/coachBusinessCommand/core.js')
    const executeBlock = blockOf(source, 'async function execute(', 'async function activateVerifiedDataset')
    const indexCommit = executeBlock.indexOf('await db.runTransaction')
    const indexFlush = executeBlock.indexOf('notifyScope.flush(db)')
    assert.ok(indexCommit >= 0, '找不到 runTransaction')
    assert.ok(indexFlush > indexCommit, '★ flush 必须排在事务提交之后')
    assert.ok(executeBlock.indexOf('= notify.scope(tx,') > indexCommit, '事务内只允许构造 scope（入队），不允许落库')
    // 事务回调（从 runTransaction 到它的 `})`）里不许出现 flush。
    const transactionBody = executeBlock.slice(indexCommit, indexFlush)
    assert.ok(!/\.flush\(/.test(transactionBody), '⛔ 事务内不许调用 flush')
  })

  // ---------------------------------------------------------------- ⑮ 可追踪性必须到达调用方
  await runner('⑮ 可追踪性必须**到达调用方**：memberBooking 不许把 notify 吞成 null', async () => {
    const source = read('cloudfunctions/coachBusinessCommand/memberBooking.js')
    const manageBlock = blockOf(source, 'async function runManage(', 'module.exports = {')
    assert.ok(/notify:\s*response\.notify/.test(manageBlock),
      '取消 / 改期的返回值必须透传 `response.notify`（真机报错时用户至少能看到"哪条通知没记上"）')
    // 反证：把透传删掉必须能被抓出来。
    const mutated = manageBlock.replace('notify: response.notify || null', 'notify: null')
    assert.ok(!/notify:\s*response\.notify/.test(mutated), '反证：变异后断言应当变红')
  })

  // ---------------------------------------------------------------- ⑯ 集合缺失时"通知链"整体故障，业务链仍全通
  await runner('⑯ 集合缺失时连续取消三节 ⇒ 三节全部成功、reserved 回零、事件 0 条（用户体感：点了就能取消）', async () => {
    setupBase()
    const made = [await create(D(1), 9), await create(D(1), 11), await create(D(2), 15)]
    assert.strictEqual(pkgData().reserved, 3, '三节都要占座')
    world.missCollection(EVENTS)
    const results = []
    for (const one of made) results.push((await quiet(() => cancel(one.bookingId))).value)
    world.restoreCollection(EVENTS)

    assert.deepStrictEqual(results.map(r => r.ok), [true, true, true], '★ 三节都必须取消成功')
    assert.deepStrictEqual(results.map(r => r.releasedReserved), [true, true, true])
    assert.strictEqual(pkgData().reserved, 0, 'reserved 必须回零')
    assert.strictEqual(counts().remaining, 8, 'remaining 一个字不动')
    assert.strictEqual(made.filter(one => bookingDataOf(one.bookingId).status === 'cancelled').length, 3, '三节都保留成 cancelled 历史')
    // ⚠️ 三次 create 都发生在集合缺失**之前** ⇒ 那三条预约成功事件是真实落库的；
    //    本条判的是"三次取消在集合缺失期间**一条都没记上**"。
    assert.strictEqual(eventsOf(notify.EVENT_TYPES.MEMBER_CREATED).length, 3, '（口径）创建时集合可用 ⇒ 预约成功事件照常落库')
    assert.strictEqual(eventsOf(notify.EVENT_TYPES.MEMBER_CANCELLED).length, 0, '通知一条都没记上（如实在 notify.failures 里报告）')
    assert.ok(results.every(r => r.notify && r.notify.ok === false && r.notify.failures.length === 1))
  })
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1 })
