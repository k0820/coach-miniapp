// M3-P2 · 会员自助预约的**受控窄写通道**（2026-09-30，本轮只落地不开放、不部署）。
//
// ★★ 为什么这个文件放在 `coachBusinessCommand` 里（写给下一个接手的人）★★
//   微信云函数**按目录独立部署**，跨目录 require 在真机上会找不到文件；
//   而 M2 的预约规则（authorization / occupancy / teaching / 预约内核）全部在这个目录里。
//   ⇒ 把会员写通道放在**同一个目录**，才能真正复用同一份规则；放到新云函数就必须复制一份，
//     复制的第一天起两条链就开始漂移（这正是 M2 当年宁可把 occupancy 做成孪生的原因）。
//
// ★★ 它不是"教练命令的一个别名"★★
//   · 入口独立：`event.action === 'memberBooking'`，**不经过** `execute()` 的 31 条教练命令分发表；
//   · 身份独立：只认**服务端**从可信 OPENID 推导的 `memberId`，**绝不**调用 `coachIdFor(openId)`
//     （那会凭空生成一个教练身份，是事故级错误）；
//   · 白名单只有一条命令：`createMemberBooking`；
//   · 客户端能提交的只有三个"服务端派生的不透明标识"：`coachKey` / `packageViewId` / 时间。
//     studentId / packageId / 账本位置 / 授课教练**全部由服务端推导**，客户端提交一律拒绝。
//
// ★★ 复用清单（一个字都没有复制）★★
//   authorization.resolveBookingPlace / assertMayBook（双层授课权限）
//   occupancy.* （余额 / 占座 / 最晚 24:00 结束）
//   teaching.findMemberTimeConflict （会员跨账时间冲突）
//   handlers.createBooking + createBookingOnForeignPackage （预约内核，**同一段代码**）
//   core.execute （事务 / revision / receipt 幂等 / 对端 peer 收据）
//
// ✅【已定稿 · 2026-09-30 M3-P3】三条产品规则落在本文件的哪里：
//   · 规则 1「要不要教练确认」⇒ **不需要** ⇒ 默认 policy = `direct`（`SELECTED_POLICY` 见下）。
//     通过全部服务端校验后**直接**创建真实预约、直接进教练课表（不再有"待教练确认"这一档默认态）；
//   · 规则 3「没有档案能否自助建档」⇒ **禁止**。只认已认领（`claims.status='verified'`）的档案，
//     无 claim 直接 `MEMBER_CLAIM_NOT_FOUND`，**绝不**写 students / claims（见 `resolveMemberTarget`）；
//   · 规则 4「可提前几天」⇒ **未来 30 天**（今天 = 第 0 天，+30 合法、+31 非法）。
//     30 这个数字**只在 `occupancy.MEMBER_BOOKING_MAX_DAYS` 定义一次**（与本机孪生同口径），
//     服务端在**事务内**终判（`MEMBER_BOOKING_BEYOND_WINDOW`）。
//
// ✅【已定稿 · 2026-09-30 M3-P6】会员**取消 / 改期**的六条产品规则（用户已全部拍板）：
//   · 规则 1「什么时候能取消」⇒ **任何时间都能取消**（含临近开课、开课之后）⇒ `CANCEL_DEADLINE_MINUTES = null`，
//     代码里**没有**截止时间这一支。⛔ 不许退化成"距开课 N 小时前才能取消"。
//   · 规则 2「取消扣不扣课」⇒ **不扣**。沿用既有课时事实模型：预约只 `reserved +1`；
//     取消**只把 reserved 放回去**（−1），`remaining / used / total` 一个字不动，不产生也不删除任何收入。
//   · 规则 3「临时取消算不算违约」⇒ **不算**。没有违约计数器、不因为取消限制会员 ⇒ 代码里没有这一支。
//   · 规则 4「改期次数」⇒ **不限**（`RESCHEDULE_MAX_TIMES = Infinity`）。
//   · 规则 5「改期要不要教练确认」⇒ **不需要**（`RESCHEDULE_NEEDS_COACH_CONFIRM = false`）⇒ 校验通过即生效。
//   · 规则 6「要不要通知另一方」⇒ **必须**（`NOTIFY_ON_CHANGE = true`）：会员动 ⇒ 通知这节课的授课教练；
//     教练动 ⇒ 通知这位会员。⛔ 本轮只落**事件事实**（`notify.js`），**不发微信订阅消息**（那是 M4）。
//
// ★★ 六条规则**只有这一处**是权威来源（`MANAGE_POLICY`），客户端 `utils/member-booking-manage.js` 的
//    `POLICY_VALUES` 是它的**孪生**，由 `m3-p6-member-manage-write` 的契约断言双向锁死
//    （改一处不改另一处 ⇒ 测试红）。⛔ 别把其中任何一条散成 if scattered 到页面里。
//
// ⛔ 本通道**只做预约本身**这三件事（创建 / 取消 / 改期）：sales / incomes / settings 一个字节都不碰。
//    ⛔ 特别地：**取消与改期都不产生收入、也不删除收入**；`done` 的课不许被取消成"没上过"。

const crypto = require('crypto')
const core = require('./core')
const occupancy = require('./occupancy')
const authorization = require('./authorization')
const teaching = require('./teaching')
const notify = require('./notify')
// ⭐⭐ 2026-10-07（1.3.38）：预约变动的**统一通知分发器**（会员侧与教练侧共用一套）。
const notifyBooking = require('./notify-booking')
const memberIdentity = require('./member-identity')
const { handlers, createBookingOnForeignPackage, bookingMoment, businessData, bookingPackageSpace, writableRow } = require('./handlers')

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
// ⭐ 与 `memberIdentityCommand` / `readMyMemberData` **同一个公式**（三处一致由
//    `m3-p2-member-booking-write-channel` 的契约断言锁死，改一处必须改三处）。
const memberIdFor = openId => sha(`member:${openId}`).slice(0, 32)
const fixedId = (...parts) => sha(parts.join(':')).slice(0, 32)

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })
const commandError = (code, message, extra = {}) => Object.assign(new Error(message), { commandCode: code, extra })
const cleanText = (value, max) => String(value == null ? '' : value).trim().slice(0, max)

// 白名单：会员能发的命令只有这三条；每条命令能提交的字段**一条一行**写在下面那张表里。
const CREATE_COMMAND = 'createMemberBooking'
const CANCEL_COMMAND = 'cancelMemberBooking'
const RESCHEDULE_COMMAND = 'rescheduleMemberBooking'
const MEMBER_COMMANDS = Object.freeze([CREATE_COMMAND, CANCEL_COMMAND, RESCHEDULE_COMMAND])
// ⭐ **按命令**分表（不是一张大表）：取消只许提交一个视图 ID，改期才许提交新时间。
//   ⛔ 一张大表的坏处是"取消也允许夹带 date/hour" ⇒ 一条永远不会被读的字段进了请求，没人会去查它有没有副作用。
const MEMBER_PAYLOAD_KEYS = Object.freeze({
  [CREATE_COMMAND]: Object.freeze(['coachKey', 'packageViewId', 'date', 'hour', 'minute', 'plannedMinutes']),
  [CANCEL_COMMAND]: Object.freeze(['bookingViewId']),
  [RESCHEDULE_COMMAND]: Object.freeze(['bookingViewId', 'date', 'hour', 'minute'])
})
// ⛔ 身份 / 定位字段：客户端提交任何一个都直接拒（伪造 memberId 是最典型的攻击）。
//   M3-P6 追加 `bookingId`：会员只许提交**服务端派生**的 `bookingViewId`，真实主键一律不许出现。
const FORBIDDEN_KEYS = Object.freeze(['memberId', 'studentId', 'coachId', 'ownerCoachId', 'datasetId', 'documentId', 'packageId', 'bookingId', 'openId', 'OPENID', 'openid', '_openid', '_id', 'teachingCoachId', 'place'])
// ⭐ 会员预约视图 ID 的前缀（与 `readMyMemberData/service.js` 的 `fixedId('member-training-view', …)` **逐字一致**）。
//   ⛔ 改这里必须同时改那边 —— 否则会员点"取消"会永远找不到自己的预约（而名单里明明看得见）。
const BOOKING_VIEW_KIND = 'member-training-view'

// ------------------------------------------------------------------ 【待用户决定】规则 1：两种 policy
//
// 两种模式在**数据层**都能表达，且**共用同一套占座口径**（都写 status='booked'、都 reserved+1）
//   ⇒ 绝不会出现"待确认不占座 ⇒ 两个人抢到同一节"的漏洞。
// 区别只落在 `booking.memberRequest.status` 这一个字段上：
//   direct        → 'confirmed'       会员提交即生效（教练被动收到通知）
//   coach-confirm → 'awaiting-coach'  会员提交后等教练确认（教练拒绝/取消时释放占座，属后续批次）
const POLICY_DIRECT = 'direct'
const POLICY_COACH_CONFIRM = 'coach-confirm'
const POLICIES = Object.freeze([POLICY_DIRECT, POLICY_COACH_CONFIRM])
const REQUEST_STATUS_OF_POLICY = Object.freeze({ [POLICY_DIRECT]: 'confirmed', [POLICY_COACH_CONFIRM]: 'awaiting-coach' })
// ✅ 规则 1 已定稿：**会员预约不需要教练确认** ⇒ 默认 `direct`。
//   ⛔ 两种 policy 在数据层**都**保留（`coach-confirm` 由 `setPolicy` 显式开启 ⇒ 以后改口径不用改结构），
//      但**运行状态不再有"未选择"这一档**：真机上"未选择"只会让用户拿到一句看不懂的拒绝码。
//   ⛔ `null` 仍然表示"明确关掉"：**fail closed**，一次写都不许发生（只有测试会显式传 null）。
let SELECTED_POLICY = POLICY_DIRECT
function setPolicy(value) {
  // `null` 是**合法的**：表示"回到未选择"（测试用完要还原，别把规则偷偷留在"已选"状态）。
  if (value !== null && !POLICIES.includes(value)) throw commandError('INVALID_POLICY', `未知的会员预约规则：${value}`)
  SELECTED_POLICY = value
  return SELECTED_POLICY
}
function currentPolicy() { return SELECTED_POLICY }
function requestStatusOf(policy) { return REQUEST_STATUS_OF_POLICY[policy] || null }

// ------------------------------------------------------------------ 规则 2-6：取消 / 改期的**唯一真相源**
//
// ⛔ 六条规则集中在这一个冻结对象里，一条都不许散进业务代码的 if 里：
//     散出去之后"改口径"就变成"记得改七个地方"，而漏掉的那一处会静默地按老规则跑。
// ⛔ 客户端孪生 = `utils/member-booking-manage.js` 的 `POLICY_VALUES`（由契约测试逐字段比对）。
const MANAGE_POLICY = Object.freeze({
  // 规则 1：`null` = **没有截止时间** ⇒ 任何时间都能取消（含开课后）。⛔ 别改成数字。
  CANCEL_DEADLINE_MINUTES: null,
  // 规则 2：取消**释放占座**（reserved −1）；remaining / used / total 一个字不动。
  CANCEL_RELEASES_RESERVED: true,
  // 规则 3：取消**不算违约** ⇒ 没有计数器、也没有"取消太多次不许约"这一支。
  CANCEL_COUNTS_AS_BREACH: false,
  // 规则 4：改期**不限次数**。
  RESCHEDULE_MAX_TIMES: Infinity,
  // 规则 5：改期**不需要教练确认** ⇒ 校验通过即生效。
  RESCHEDULE_NEEDS_COACH_CONFIRM: false,
  // 规则 6：必须通知另一方（落事件；微信订阅消息是 M4）。
  NOTIFY_ON_CHANGE: true
})

function forbiddenIn(value, path) {
  if (!value || typeof value !== 'object') return ''
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.includes(key)) return `${path}.${key}`
    const nested = forbiddenIn(value[key], `${path}.${key}`)
    if (nested) return nested
  }
  return ''
}

function validateRequestId(value) {
  const text = cleanText(value, 90)
  if (!/^[A-Za-z0-9:_-]{8,90}$/.test(text)) throw commandError('INVALID_REQUEST_ID', '请求编号无效。')
  return text
}

async function listWhere(scope, name, query, limit = 200) {
  const response = await scope.collection(name).where(query).limit(limit).get()
  return (response && response.data || []).map(clone)
}

// ⛔ 客户端提交的对象里出现白名单外的字段 ⇒ **直接拒**，不做"忽略多余字段"的宽容处理
//    （宽容会让"客户端多塞一个字段看看会不会生效"变成可试探的行为）。
function assertAllowedKeys(payload, command) {
  const allowed = MEMBER_PAYLOAD_KEYS[command] || []
  const extra = Object.keys(payload || {}).filter(key => !allowed.includes(key))
  if (extra.length) throw commandError('INVALID_PAYLOAD', `包含不允许的字段：${extra.join('、')}`)
  return payload
}

// 北京时间日期键（服务端口径：`now` 由调用方注入，测试可控）。
function beijingDateKey(nowMs) {
  const at = new Date(Number(nowMs) + 8 * 60 * 60 * 1000)
  const year = at.getUTCFullYear(), month = at.getUTCMonth() + 1, day = at.getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// ------------------------------------------------------------------ 服务端推导：这位会员能约谁、能约哪份课包
//
// ⛔ 全部来自服务端已知事实：认领关系（claims）+ M2 授权表（package_grants）。
//    客户端只拿着两个**服务端派生**的不透明标识（coachKey / packageViewId）回来；
//    匹配不上 ⇒ 一律失败。⇒ 换一个会员的 openId、或乱猜一个标识，都拿不到别人的课包。
async function resolveMemberTarget({ db, environment, memberId, coachKey, packageViewId }) {
  const names = authorization.collectionsFor(environment)
  const auths = authorization.authScope(db, environment)
  const claims = await memberIdentity.resolveMemberScopes({ db, environment, memberId, claimsCollection: names.claims })
  // ⛔ 没有认领 = 没有档案 ⇒ 失败。**绝不**自动建档（规则 3，禁止自助建档）。
  if (!claims.length) throw commandError('MEMBER_CLAIM_NOT_FOUND', '还没有认领你的学员档案，暂时不能自助约课。请让你的教练生成认领码。')
  // ⭐ 2026-10-01 性能专项：**同一次请求内**的备忘录。
  //   `activePlaceOf(coachId)` 原本在"每个 claim 一次 + 每个 grant 一次"里被重复调用 ⇒ 教练一多就是 N+1 趟数据库读。
  //   ⛔ 这只是**请求内缓存**（`Map` 随函数结束即销毁），不改变任何判定结果 —— 同一个教练在同一次请求里
  //      的"当前账本位置"本来就应该是同一个答案。
  const placeMemo = new Map()
  const placeOf = async coachId => {
    if (!coachId) return null
    if (placeMemo.has(coachId)) return placeMemo.get(coachId)
    const place = await auths.activePlaceOf(coachId)
    placeMemo.set(coachId, place)
    return place
  }
  const packages = [], eligible = new Map(), revoked = new Map()
  const remember = (coachId, place) => {
    if (!coachId || !place || eligible.has(coachId)) return
    eligible.set(coachId, { coachId, place, coachKey: fixedId('member-coach-view', coachId) })
  }
  const rememberRevoked = (coachId, place) => {
    if (!coachId || !place || eligible.has(coachId)) return
    revoked.set(fixedId('member-coach-view', coachId), { coachId, place })
  }
  for (const claim of claims) {
    if (!claim || !claim.coachId || !claim.studentId) continue
    const place = claim.datasetId
      ? { ownerCoachId: claim.coachId, datasetId: claim.datasetId }
      : await placeOf(claim.coachId)
    if (!place) continue
    const claimId = claim.claimId || fixedId(names.claims, claim.coachId, claim.studentId)
    // ① 账本所有者：自己账里的会员，天然可约（旧数据零迁移的支点）。
    remember(claim.coachId, place)
    // ② 课包只从**认领的那本账**里取（M2 授权不复制数据 ⇒ 课包物理只有一份）。
    // ③ 被授予授课权的其他教练（M2 双层授权的课包级那层）⇒ 会员也可以约他们。
    //   ⚠️ 这里**故意不按 status 过滤**：撤销过的教练也要被认出来，
    //     好在会员拿着旧页面的标识点过来时报**与教练端同一个码**（PACKAGE_TEACHING_NOT_AUTHORIZED），
    //     而不是一句含糊的"不能约"（会员不知道该找谁）。
    // ⭐ 两趟查询**互不依赖** ⇒ 并发发出（省一个 RTT）；后续两个循环的**顺序一字未改**。
    const [rows, grants] = await Promise.all([
      listWhere(db, 'packages', { ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId: claim.studentId }),
      listWhere(db, names.package, { ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId: claim.studentId })
    ])
    for (const row of rows) {
      const packageId = String(row.packageId || (row.data && row.data.id) || '')
      if (!packageId) continue
      packages.push({ claimId, studentId: claim.studentId, packageId, place, packageViewId: fixedId('member-package-view', claimId, packageId) })
    }
    for (const grant of grants) {
      const target = await placeOf(grant.coachId)
      if (!target) continue
      if (grant.status === authorization.STATUS_ACTIVE) remember(grant.coachId, target)
      else rememberRevoked(grant.coachId, target)
    }
  }
  const wanted = String(coachKey == null ? '' : coachKey).trim()
  const coach = wanted ? [...eligible.values()].find(row => row.coachKey === wanted) : null
  if (!coach) {
    // ⛔ 同一个错误码词汇表：授权被撤销 ⇒ 与教练代约报**同一个码**（判据仍由云端 assertMayBook 最终执行）。
    if (revoked.has(wanted)) throw commandError('PACKAGE_TEACHING_NOT_AUTHORIZED', '这位教练的授课授权已经撤销，不能约课。')
    // ⛔ 认不出这位教练 ⇒ 一律拒（"这位教练还没获得授权"与"这个标识是假的"对会员是同一句话）。
    throw commandError('COACH_NOT_AVAILABLE', '这位教练还不能给你约课，请让管理你课时的教练先授权。')
  }
  const wantedPackage = String(packageViewId == null ? '' : packageViewId).trim()
  const pkg = wantedPackage ? packages.find(row => row.packageViewId === wantedPackage) : null
  if (!pkg) throw commandError('PACKAGE_NOT_AVAILABLE_FOR_MEMBER', '这份课时包不可用，或不属于你。')
  return {
    teachingCoachId: coach.coachId, teachingPlace: coach.place,
    studentId: pkg.studentId, packageId: pkg.packageId, packagePlace: pkg.place, claimId: pkg.claimId,
  }
}

// ------------------------------------------------------------------ 服务端推导：这条预约真的是这位会员的吗
//
// ★★ 取消 / 改期的**唯一安全边界**就在这里 ★★
//   会员提交的只有 `bookingViewId`（服务端派生的不透明串，客户端无法反推）。
//   服务端拿它去**自己**枚举"这位会员名下的预约"，反算视图 ID 比对 ⇒ 对不上就是 `BOOKING_NOT_MINE`。
//   ⛔ 客户端提交不了 bookingId（在 FORBIDDEN_KEYS 里）⇒ 伪造、乱猜、拿别人的视图 ID 都拿不到别人的预约。
//   ⛔ 视图 ID 的算法与 `readMyMemberData/service.js` **同源**（`member-training-view` + claimId + bookingId）——
//      两边不一致会出现"名单里看得见、点下去说不是你的"这种最难查的故障。
async function resolveOwnBooking({ db, environment, memberId, bookingViewId }) {
  const wanted = String(bookingViewId == null ? '' : bookingViewId).trim()
  if (!wanted) throw commandError('INVALID_PAYLOAD', '缺少预约标识。')
  const names = authorization.collectionsFor(environment)
  const claims = await memberIdentity.resolveMemberScopes({ db, environment, memberId, claimsCollection: names.claims })
  if (!claims.length) throw commandError('MEMBER_CLAIM_NOT_FOUND', '还没有认领你的学员档案，暂时不能自助调整预约。请让你的教练生成认领码。')
  // ⛔ 集合名**只从 core 的元集合推导**，⛔ 绝不在这里写死任何集合名字面量
  //    （连注释里都不许抄一份）：写死正式区那张账本清单的名字，会让**测试区那份镜像里
  //    出现正式区集合名** —— tests/sandbox-cloud-isolation.test.js 判据⑦ 就是抓这个的。
  const headName = core.metaFor(environment).heads
  // ⚠️ 环境隔离：只认**本环境** head 里登记着的那本账（跨环境绝不是同一条数据）。
  const headQuery = core.environmentOf(environment) === 'sandbox' ? { environment: 'sandbox' } : {}
  // ⚠️ 这里**不是** N+1：head 只在"视图 ID 对上了"之后才查，而一旦对上就 `return` ⇒ 最多一次。
  //    （本轮审计一开始误判这里有 N+1 并加了备忘录，被"操作数随规模变化"的执行式判据证伪后已撤回 ——
  //     不许留一段没有收益的死代码，更不许在文档里写一个没发生的优化。）
  for (const claim of claims) {
    if (!claim || !claim.coachId || !claim.studentId) continue
    // 视图 ID 的 claimId 两种写法都算（认领行生成时写过 claimId；老行没有时按同一个公式补）。
    const claimIds = [claim.claimId, fixedId(names.claims, claim.coachId, claim.studentId)].filter(Boolean)
    // 这位会员的预约**可能落在多本账**里（谁上这节课，课就记在谁的课表）⇒ 按 studentId 跨账找同一条真实数据。
    const rows = await listWhere(db, 'bookings', { studentId: claim.studentId }, 500)
    for (const row of rows) {
      const bookingId = String(row.bookingId || (row.data && row.data.id) || '')
      if (!bookingId) continue
      if (!claimIds.some(claimId => fixedId(BOOKING_VIEW_KIND, claimId, bookingId) === wanted)) continue
      const heads = await listWhere(db, headName, { ownerCoachId: row.ownerCoachId, ...headQuery }, 5)
      const head = heads.find(item => item && item.activeDatasetId === row.datasetId)
      if (!head) continue                                  // 不是本环境的账本 ⇒ 当作"不是你的"
      return { bookingId, row, claim, studentId: claim.studentId, ownerCoachId: row.ownerCoachId, datasetId: row.datasetId }
    }
  }
  // ⛔ 一句与客户端 `FRIENDLY_MESSAGES.BOOKING_NOT_MINE` 同一个意思的话（别让两端说两种话）。
  throw commandError('BOOKING_NOT_MINE', '这条预约不在你的名单里。')
}

// 会员侧的事件记录（规则 6）：actor = 该会员，recipient = **这节课的授课教练**这个人。
//   ⛔ 只写一个人 —— 绝不广播给 B/C/D/E/F 全部教练。
async function recordMemberChange(context, business, booking, { type, memberId }) {
  if (MANAGE_POLICY.NOTIFY_ON_CHANGE !== true) return null
  // ⭐⭐ 2026-10-07（1.3.38）：**与教练侧共用同一个分发器**。
  //   ⛔ 这一条是 1.3.36 真机 PASS 的黄金链路，改造的**唯一**目标是让它和"教练 ⇒ 会员"
  //     走同一段代码；方向判定（actor=member ⇒ recipient=coach）与"教练 ID 从业务上下文直接取"
  //     这两点**一个字都没变**，所以真机行为不变。
  return notifyBooking.notifyBookingChange(context, {
    actorRole: notifyBooking.ACTOR_MEMBER,
    act: notifyBooking.actForType(type),
    booking, business, memberId,
    requestId: context && context.requestId,
    now: context && context.now,
    extra: { ownerCoachId: business.ownerCoachId, datasetId: business.datasetId, teachingCoachId: business.ownerCoachId }
  })
}

// ------------------------------------------------------------------ 命令本体（唯一的写操作）
//
// 由 `core.execute` 在同一事务内调用 ⇒ 事务 / revision / receipt 幂等 / 对端收据全部由它兜住。
// ⛔ 会员身份与 policy **只从 context 注入**（服务端），客户端 payload 里根本没有这两个字段。
async function createMemberBookingHandler(business, payload, context) {
  const memberId = context && context.memberId
  const policy = context && context.policy
  if (!memberId || !POLICIES.includes(policy)) {
    // fail closed：拿不到可信会员身份或规则 ⇒ 一次写都不许发生。
    throw commandError('COMMAND_TRANSACTION_FAILED', '会员预约通道缺少可信身份或规则，已阻止写入。')
  }
  const auths = context.authorizations
  if (!auths) throw commandError('COMMAND_TRANSACTION_FAILED', '当前执行环境不支持多教练授权。')
  const studentId = String(payload.studentId || ''), packageId = String(payload.packageId || '')
  if (!studentId || !packageId) throw commandError('INVALID_PAYLOAD', '预约缺少学员或课时包。')
  const moment = bookingMoment(payload)
  // ⭐⭐ 规则 4（未来 30 天）：**服务端最终判定**。这里在**事务内**、用**服务端**的 `context.now`
  //    ⇒ 客户端把日期改到天边也没用；入口那次早拒只是为了让绝大多数越界请求**少跑一趟**。
  //    30 这个数字只在 `occupancy.MEMBER_BOOKING_MAX_DAYS` 定义一次（与本机孪生同口径）。
  const verdict = occupancy.memberBookingDateAllowed(moment.date, beijingDateKey(context.now))
  if (verdict === 'invalid') throw commandError('INVALID_PAYLOAD', '预约日期无效。')
  if (verdict === 'past') throw commandError('BOOKING_DATE_IN_PAST', '不能预约已经过去的时间。')
  if (verdict === 'beyond') throw commandError('MEMBER_BOOKING_BEYOND_WINDOW', occupancy.MEMBER_BOOKING_WINDOW_MESSAGE)
  // ⭐⭐ 开课时间窗口（2026-10-03 用户口径）：**每天 06:00–23:00，每 30 分钟一档**。
  //   ⛔ 这道闸**只加在会员自助通道**：会员预约按定义一定是"未来的课"（上面已经拒掉过去），
  //      所以 06:00 / 30 分钟网格对它成立。
  //   ⭐ 2026-10-03：教练端入口也已统一到 06:00 —— `handlers.createBooking` / 改期走的
  //      `lessonWindowGateOf()` 现在同样拦"开始过早"。两侧同一条常量（EARLIEST_START_MINUTES），
  //      两边不可能各写一个数字。这里保留 verdict 这条通道是因为会员端还要额外判 30 分钟网格。
  const startVerdict = occupancy.startVerdictOf(moment)
  if (startVerdict === 'invalid') throw commandError('INVALID_PAYLOAD', '预约时间无效。')
  if (startVerdict === 'too-early') throw commandError('BOOKING_START_TOO_EARLY', occupancy.START_TOO_EARLY_MESSAGE)
  if (startVerdict === 'too-late') throw commandError('BOOKING_START_TOO_LATE', occupancy.START_TOO_LATE_MESSAGE)
  if (startVerdict === 'off-grid') throw commandError('BOOKING_START_OFF_GRID', occupancy.START_OFF_GRID_MESSAGE)
  // ⭐⭐ 2026-10-02 三次口径：**课程必须在当天 24:00 前结束**（与「开始 ≤ 23:00」同时判）。
  //   会员自助预约 / 会员改期的时长**恒为 60 分钟** ⇒ 23:00 + 60 = 24:00 正好卡在界上，不会触发；
  //   但这一句让"结束 ≤ 24:00"在会员通道也是**显式规则**而不是隐式巧合 ——
  //   将来若放开会员可选时长，这里会立刻顶住（不必有人记得回来补）。
  if (startVerdict === 'end-too-late') throw commandError('BOOKING_END_TOO_LATE', occupancy.END_TOO_LATE_MESSAGE)
  // 会员自助预约的课程时长**固定 60 分钟**（与教练端排课界面一致：那里没有时长输入）。
  const plannedMinutes = payload.plannedMinutes == null || payload.plannedMinutes === ''
    ? occupancy.DEFAULT_PLANNED_MINUTES : Number(payload.plannedMinutes)
  if (plannedMinutes !== occupancy.DEFAULT_PLANNED_MINUTES) throw commandError('INVALID_PAYLOAD', '会员自助预约的课程时长固定为 60 分钟。')
  // ⭐ 与教练代约**同一条**位置推导（客户端永远指定不了别人的账本）。
  const { place, shared, grant } = await authorization.resolveBookingPlace({
    auths, business, context, studentId, packageId, coachId: business.ownerCoachId
  })
  // ⭐ 与教练代约**同一道**双层权限闸（会员级 + 课包级，两层都过，缺哪层报哪个码）。
  await authorization.assertMayBook(auths, place, studentId, packageId, business.ownerCoachId)
  let result
  if (!shared) {
    // 课包就在授课教练自己那本账 ⇒ 走既有 createBooking（老流程逐字不变）。
    // ⛔ `suppressBookingChangeNotify: true` 是**必须的**（与改期那条同一个道理）：
    //    `handlers.createBooking` 尾部会记 `coach-booking-created`（教练安排课程 ⇒ 通知会员）。
    //    而**会员自己约的课不是"教练安排的"** ⇒ 不抑制就会出现两条事故级后果：
    //      ① actor 被伪造成"教练"，而教练什么都没做（审计不可信）；
    //      ② **给自己发通知**：会员约了自己的课，却收到一条"教练为你安排了课程"。
    //    ⇒ 会员通道只由下面那**一处**按会员口径记 `member-booking-created`（通知教练）。
    result = await handlers.createBooking(business, { studentId, packageId, date: moment.date, hour: moment.hour, minute: moment.minute, plannedMinutes }, { ...context, suppressBookingChangeNotify: true })
  } else {
    result = await createBookingOnForeignPackage({
      business, context, peer: context.businessAt(place.ownerCoachId, place.datasetId),
      usage: { packageId, studentId, ownerCoachId: place.ownerCoachId, datasetId: place.datasetId },
      studentId, packageId, moment, plannedMinutes,
      // ⭐ 会员时间冲突要查**所有已知服务这位会员的教练**的账本（与教练代约同一份 places 推导）。
      extraPlaces: await authorization.knownMemberPlaces({ auths, place, studentId, packageId })
    })
    context.attachPeer({ ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, result: { packageId, bookingId: result.bookingId } })
  }
  const booked = await markMemberBooking(business, result.bookingId, memberId, policy, context.now)
  // ⭐ 规则 6（M4 · 2026-10-05 补上）：**预约成功**也必须让授课教练知道。
  //   这是三类目标通知（预约成功 / 改期 / 取消）里**唯一**一直缺失的一类 ——
  //   `MEMBER_CREATED` 这个常量早就定义好了却零引用（见 hxc/NOTIFY-AUDIT-20261004.md §D0），
  //   结果就是：会员约好了课，教练端毫无感知，只能等会员口头告知。
  //   ⛔ 铁律不变：**业务全部写完之后**才记事件；`record()` 只是入队（事务内零 IO，
  //      通知链路的任何故障都不可能把已经合法的预约拖回滚）。
  await recordMemberChange(context, business, booked, { type: notify.EVENT_TYPES.MEMBER_CREATED, memberId })
  return { ...result, memberBooking: true, policy, memberRequestStatus: requestStatusOf(policy), managedByMe: !!(grant && grant.canManage) }
}

// 把这条预约**标明**是会员自助发起的（与 `teaching.identityFor` 早已预留的形状一致：
// `source` / `createdByMemberId` 从 M2 起就写在设计里，不需要到此改结构）。
// ⛔ 只加标记，**不改** status / plannedMinutes / price / packageUsage 任何一个业务字段
//    ⇒ 占座、冲突、完课、收入的全部口径与教练代约**逐字相同**。
async function markMemberBooking(business, bookingId, memberId, policy, now) {
  if (!bookingId) return null
  const row = await business.collection('bookings').get(bookingId)
  if (!row) throw commandError('BOOKING_NOT_FOUND', '预约写入异常，本次预约没有生效。')
  const booking = { ...businessData(row) }
  booking.source = teaching.SOURCE_MEMBER
  booking.createdByCoachId = null
  booking.createdByMemberId = memberId
  booking.memberRequest = { memberId, policy, status: requestStatusOf(policy), requestedAt: now }
  await business.collection('bookings').set(bookingId, {
    bookingId: row.bookingId || bookingId, studentId: row.studentId, packageId: row.packageId, sortIndex: row.sortIndex,
    data: booking
  })
  return booking
}

// ------------------------------------------------------------------ 命令本体 · 取消预约（规则 1/2/3/6）
//
// ★ 与教练端 `handlers.cancelBooking` 的**唯一区别**：这条**保留**预约文档（`status='cancelled'`），
//   教练端那条是物理删除。用户明确要求"保留 cancelled 历史记录，不物理删除"。
//   ⛔ 除了"删还是留"，释放占座的算法**逐字相同**（同一个 `bookingPackageSpace` + `occupancy.applyDelta(-1)`）
//      ⇒ 绝不出现"会员取消释放一套、教练取消释放另一套"。
//
// ★ 幂等：已取消的再取消 ⇒ **成功返回、零副作用**（不重复释放 reserved、不产生第二条通知）。
//   ⛔ 这里不是"宽容"，是正确性：重复释放会把 reserved 打到负数，凭空多出一节课的可用额度。
async function cancelMemberBookingHandler(business, payload, context) {
  const memberId = context && context.memberId
  if (!memberId) throw commandError('COMMAND_TRANSACTION_FAILED', '会员预约通道缺少可信身份，已阻止写入。')
  const bookingId = String(payload.bookingId || '')
  const bookings = business.collection('bookings'), row = await bookings.get(bookingId)
  if (!row) throw commandError('BOOKING_NOT_FOUND', '预约不存在或不属于当前数据集。')
  const booking = businessData(row)
  if (row.bookingId !== bookingId || booking.id !== bookingId) throw commandError('BOOKING_RELATION_INVALID', '预约标识关系不一致。')
  // ⭐ 已完成（含"未进行"）的课**不许**被取消成"没上过" —— 那是改历史，不是取消。
  if (booking.status === 'done') throw commandError('BOOKING_ALREADY_DONE', '已完成课程不能取消。')
  if (booking.status === 'noshow') throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能取消。')
  if (booking.status === occupancy.CANCELLED_STATUS) {
    // ⭐ 幂等：**零副作用**返回（不释放、不通知、不改任何字段）。
    return { bookingId, status: occupancy.CANCELLED_STATUS, cancelled: false, alreadyCancelled: true }
  }
  if (booking.status !== occupancy.OUTSTANDING_STATUS) throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能取消。')
  // 规则 1：**任何时间都能取消** ⇒ 这里没有、也不许有"距开课不足 N 小时不许取消"的判定。
  if (MANAGE_POLICY.CANCEL_DEADLINE_MINUTES != null) throw commandError('COMMAND_TRANSACTION_FAILED', '取消截止时间的实现已失效，请联系维护者。')
  // 规则 2：**只释放占座**。顺序铁律（与教练端逐字相同）：**先数（这条还是 booked，会被算进 reserved）→ 再 −1 → 再改状态**。
  //   共享预约的课时包在别人的账里 ⇒ 释放在那一本账上（同一个事务）。
  const packageId = String(booking.packageId || row.packageId || '')
  let released = false
  if (packageId && MANAGE_POLICY.CANCEL_RELEASES_RESERVED === true) {
    const { space, packageRow, shared, attach } = await bookingPackageSpace(business, context, row, booking)
    if (packageRow) {
      const pkg = businessData(packageRow)
      await occupancy.applyDelta(space, pkg, -1)
      await space.collection('packages').set(packageId, writableRow(packageRow, { packageId, studentId: booking.studentId, ...(packageRow.saleId || pkg.saleId ? { saleId: packageRow.saleId || pkg.saleId } : {}), data: pkg }))
      if (shared) attach({ bookingId })
      released = true
    }
  }
  // ⭐ 保留历史：**改状态**，不删文档（`bookings.remove` 在这里是绝对禁止的）。
  booking.status = occupancy.CANCELLED_STATUS
  booking.cancelledAt = context.now
  booking.cancelledByMemberId = memberId
  await bookings.set(bookingId, writableRow(row, { bookingId, studentId: row.studentId || booking.studentId, packageId: row.packageId || booking.packageId, data: booking }))
  // 规则 3：这里**没有**违约计数 —— 取消不留下任何"这个人取消过几次"的痕迹（`MANAGE_POLICY.CANCEL_COUNTS_AS_BREACH === false`）。
  // 规则 6：最后一步才记事件（业务真的成功了）。
  await recordMemberChange(context, business, booking, { type: notify.EVENT_TYPES.MEMBER_CANCELLED, memberId })
  // ⚠️ 返回值里**没有** remaining / used / total —— 它们本来就不该因为一次取消而变化，
  //    写进返回值只会让人以为"这里改过余额"。
  return { bookingId, packageId, status: occupancy.CANCELLED_STATUS, cancelled: true, releasedReserved: released, alreadyCancelled: false }
}

// ------------------------------------------------------------------ 命令本体 · 改期（规则 4/5/6）
//
// ★ 预约内核**一个字都没复制**：直接调 `handlers.rescheduleBooking`（教练端改期走的就是这一段）
//   ⇒ 24:00 结束、教练账本冲突、会员跨账冲突、`done` 的收入同步，全部同一套口径。
// ★ 会员侧**额外**的两道与教练端不同（因为方向不同）：**30 天窗口**与**"不能改到过去"**。
//   ⛔ 30 天只来自 `occupancy.MEMBER_BOOKING_MAX_DAYS`（唯一常量），不在这里写 30。
// ★ 规则 4（不限次数）：**没有任何次数计数器**；连点两次是两个 requestId ⇒ 两条命令（都是合法的改期）。
// ★ 规则 5（不需要教练确认）：校验通过即生效。
async function rescheduleMemberBookingHandler(business, payload, context) {
  const memberId = context && context.memberId
  if (!memberId) throw commandError('COMMAND_TRANSACTION_FAILED', '会员预约通道缺少可信身份，已阻止写入。')
  const bookingId = String(payload.bookingId || '')
  const moment = bookingMoment(payload)
  // 会员改期的窗口判据与"创建预约"同一条（服务端 `context.now`，事务内终判）。
  const verdict = occupancy.memberBookingDateAllowed(moment.date, beijingDateKey(context.now))
  if (verdict === 'invalid') throw commandError('INVALID_PAYLOAD', '预约日期无效。')
  if (verdict === 'past') throw commandError('BOOKING_DATE_IN_PAST', '不能改到已经过去的时间。')
  if (verdict === 'beyond') throw commandError('MEMBER_BOOKING_BEYOND_WINDOW', occupancy.MEMBER_BOOKING_WINDOW_MESSAGE)
  // ⭐⭐ 改期与预约**同一套**开课时间窗口（07:00–23:00 / 30 分钟一档）—— 少了它，
  //      先约一个正常的 10:00 再改到 06:15 就能绕过窗口；两端口径必须一致。
  const startVerdict = occupancy.startVerdictOf(moment)
  if (startVerdict === 'invalid') throw commandError('INVALID_PAYLOAD', '预约时间无效。')
  if (startVerdict === 'too-early') throw commandError('BOOKING_START_TOO_EARLY', occupancy.START_TOO_EARLY_MESSAGE)
  if (startVerdict === 'too-late') throw commandError('BOOKING_START_TOO_LATE', occupancy.START_TOO_LATE_MESSAGE)
  if (startVerdict === 'off-grid') throw commandError('BOOKING_START_OFF_GRID', occupancy.START_OFF_GRID_MESSAGE)
  // ⭐⭐ 2026-10-02 三次口径：**课程必须在当天 24:00 前结束**（与「开始 ≤ 23:00」同时判）。
  //   会员自助预约 / 会员改期的时长**恒为 60 分钟** ⇒ 23:00 + 60 = 24:00 正好卡在界上，不会触发；
  //   但这一句让"结束 ≤ 24:00"在会员通道也是**显式规则**而不是隐式巧合 ——
  //   将来若放开会员可选时长，这里会立刻顶住（不必有人记得回来补）。
  if (startVerdict === 'end-too-late') throw commandError('BOOKING_END_TOO_LATE', occupancy.END_TOO_LATE_MESSAGE)
  const row = await business.collection('bookings').get(bookingId)
  if (!row) throw commandError('BOOKING_NOT_FOUND', '预约不存在或不属于当前数据集。')
  const before = businessData(row)
  if (before.status === occupancy.CANCELLED_STATUS) throw commandError('BOOKING_ALREADY_CANCELLED', '这节课已经取消了，不能改期。')
  if (before.status !== occupancy.OUTSTANDING_STATUS) throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能改期。')
  // ⭐ 复用教练端改期的**全部**规则（冲突检测会排除这一节自己、但不会排除别的预约）。
  //   ⛔ `suppressBookingChangeNotify: true` 是**必须的**：`handlers.rescheduleBooking` 尾部挂着
  //      **教练侧**的通知接入点，它会按"教练改期"记一条事件（actor=教练、recipient=会员，两个都错）
  //      ⇒ 不抑制的话，一次会员改期会落下两条事件，其中一条**伪造了 actor**并**通知了会员本人**。
  //      本案由下面的 `recordMemberChange` 按会员口径记**唯一**那一条（两条命令方向对称）。
  const result = await handlers.rescheduleBooking(business, { bookingId, date: moment.date, hour: moment.hour, minute: moment.minute }, { ...context, suppressBookingChangeNotify: true })
  const after = businessData(await business.collection('bookings').get(bookingId))
  // ⛔ 改期**绝不碰 reserved**（没有第二次 +1，也不 −1）—— 这一节课从头到尾都只占一格。
  await recordMemberChange(context, business, after, { type: notify.EVENT_TYPES.MEMBER_RESCHEDULED, memberId })
  return { bookingId, status: after.status, from: { date: before.date, hour: before.hour, minute: before.minute }, to: { date: after.date, hour: after.hour, minute: after.minute }, reservedTouched: false, incomeSynced: result.incomeSynced === true }
}

// ------------------------------------------------------------------ 入口
async function runMemberBooking({ db, getOpenId, now, event, policy, delivery = null }) {
  try {
    const command = cleanText(event.command, 48)
    const openId = getOpenId()
    if (!openId) return fail('IDENTITY_MISSING', '未能确认当前微信身份。')
    const environment = core.environmentOf(event.environment)
    // ⛔ 第一道闸：身份 / 定位字段一个都不许从客户端进来（core 已在更外层拦过一次，这里再拦一次）。
    const forbidden = forbiddenIn(event.payload || {}, 'payload')
    if (forbidden) return fail('FORBIDDEN_IDENTITY_INPUT', `客户端不得提交身份或数据定位字段：${forbidden}`)
    // ⛔ 第二道闸：命令白名单（三条，每条的字段白名单见 `MEMBER_PAYLOAD_KEYS`）。
    //    这里**不是**教练那 31 条命令的分发口。
    if (!MEMBER_COMMANDS.includes(command)) return fail('UNKNOWN_COMMAND', '不支持的会员命令。')
    const requestId = validateRequestId(event.requestId)
    assertAllowedKeys(event.payload || {}, command)
    // ⛔ 第三道闸：规则 1 未由用户决定 ⇒ 不替她选，直接拒（测试要验两种 policy 时会显式传入）。
    const resolvedPolicy = policy || currentPolicy()
    if (!resolvedPolicy) return fail('MEMBER_BOOKING_POLICY_NOT_SELECTED', '会员自助预约的规则尚未确定，暂不开放提交。')
    const payload = event.payload || {}
    // ⭐ 会员身份：**只**从服务端可信 OPENID 推导（三条命令共用这一段，没有第二条身份来源）。
    const identity = await memberIdentity.resolveMemberIdentity({ db, environment, openId })
    const memberId = identity.memberId
    if (command === CANCEL_COMMAND || command === RESCHEDULE_COMMAND) {
      return await runManage({ db, environment, memberId, command, payload, requestId, now, delivery })
    }
    const target = await resolveMemberTarget({
      db, environment, memberId, coachKey: payload.coachKey, packageViewId: payload.packageViewId
    })
    // ⭐ 规则 4（未来 30 天）：入口**早拒**（最终判定在事务内的 handler，那里才是真相源）。
    //    ⛔ 过去的日期不能自助约（事后补录是教练端的录入动作，不是会员的预约动作）。
    const moment = bookingMoment(payload)
    const verdict = occupancy.memberBookingDateAllowed(moment.date, beijingDateKey(now))
    if (verdict === 'invalid') return fail('INVALID_PAYLOAD', '预约日期无效。')
    if (verdict === 'past') return fail('BOOKING_DATE_IN_PAST', '不能预约已经过去的时间。')
    if (verdict === 'beyond') return fail('MEMBER_BOOKING_BEYOND_WINDOW', occupancy.MEMBER_BOOKING_WINDOW_MESSAGE)
    // ⭐ 授课教练那本账的当前 revision（会员不可能知道 ⇒ 服务端读）。并发时这里会 REVISION_CONFLICT ⇒ 安全失败。
    const context = await core.activeContext(db, target.teachingCoachId, environment)
    // ⛔ 注入给 execute 的 handler 表**只有一条命令** ⇒ 即便外层判断被绕过，也发不出第二条命令。
    const scoped = {
      [CREATE_COMMAND]: (business, commandPayload, commandContext) => createMemberBookingHandler(
        business, commandPayload, { ...commandContext, memberId, policy: resolvedPolicy }
      )
    }
    const response = await core.execute(db, target.teachingCoachId, {
      // ⭐ requestId 按会员**命名空间**：不同会员用同一个号也不会互相覆盖 receipt。
      command, requestId: `mbk:${memberId.slice(0, 12)}:${requestId}`,
      expectedRevision: context.revision.dataRevision,
      payload: {
        studentId: target.studentId, packageId: target.packageId,
        date: moment.date, hour: moment.hour, minute: moment.minute, plannedMinutes: occupancy.DEFAULT_PLANNED_MINUTES
      }
      // ⭐ M4：把投递适配器一路带到 `core.execute`（未开通时是 null ⇒ 只落事件、不发送）。
    }, scoped, now, environment, delivery)
    if (!response || !response.ok) return response
    const result = response.result || {}
    return {
      ok: true, memberBooking: true, environment, requestId,
      bookingId: result.bookingId || '', policy: resolvedPolicy,
      memberRequestStatus: result.memberRequestStatus || requestStatusOf(resolvedPolicy),
      teachingCoachId: target.teachingCoachId, datasetRevision: response.datasetRevision,
      replayed: response.idempotent === true,
      // ⭐ 2026-10-05：创建路径**现在也记事件**（预约成功要通知教练），所以这里不再恒为 null。
      notify: response.notify || null
    }
  } catch (error) {
    return fail(error.commandCode || 'MEMBER_BOOKING_FAILED', error.message || '会员预约失败。', error.extra || {})
  }
}

// 取消 / 改期的公共入口：**先证明这条预约是这位会员的**，再去它所在那本账里写。
//   ⛔ 两条命令走的账本由 `resolveOwnBooking` 服务端推导 ⇒ 客户端连"我要改谁的账"都表达不了。
//   ⛔ requestId 用 `mbm:` 命名空间（与创建的 `mbk:` 分开）⇒ 两个通道的收据永不互相覆盖。
async function runManage({ db, environment, memberId, command, payload, requestId, now, delivery = null }) {
  // ⭐ 安全边界：这条预约必须在**这位会员自己的名单**里（服务端反算视图 ID，对不上就拒）。
  const own = await resolveOwnBooking({ db, environment, memberId, bookingViewId: payload.bookingViewId })
  const envelopePayload = command === CANCEL_COMMAND
    ? { bookingId: own.bookingId }
    : (() => {
      const moment = bookingMoment(payload)
      const verdict = occupancy.memberBookingDateAllowed(moment.date, beijingDateKey(now))
      if (verdict === 'invalid') throw Object.assign(new Error('预约日期无效。'), { commandCode: 'INVALID_PAYLOAD' })
      if (verdict === 'past') throw Object.assign(new Error('不能改到已经过去的时间。'), { commandCode: 'BOOKING_DATE_IN_PAST' })
      if (verdict === 'beyond') throw Object.assign(new Error(occupancy.MEMBER_BOOKING_WINDOW_MESSAGE), { commandCode: 'MEMBER_BOOKING_BEYOND_WINDOW' })
      return { bookingId: own.bookingId, date: moment.date, hour: moment.hour, minute: moment.minute }
    })()
  const context = await core.activeContext(db, own.ownerCoachId, environment)
  const scoped = command === CANCEL_COMMAND
    ? { [CANCEL_COMMAND]: (business, commandPayload, commandContext) => cancelMemberBookingHandler(business, commandPayload, { ...commandContext, memberId }) }
    : { [RESCHEDULE_COMMAND]: (business, commandPayload, commandContext) => rescheduleMemberBookingHandler(business, commandPayload, { ...commandContext, memberId }) }
  const response = await core.execute(db, own.ownerCoachId, {
    command, requestId: `mbm:${memberId.slice(0, 12)}:${requestId}`,
    expectedRevision: context.revision.dataRevision, payload: envelopePayload
  }, scoped, now, environment, delivery)
  if (!response || !response.ok) return response
  const result = response.result || {}
  return {
    ok: true, memberManage: true, environment, requestId, command,
    bookingId: result.bookingId || own.bookingId,
    status: result.status || '', cancelled: result.cancelled === true, alreadyCancelled: result.alreadyCancelled === true,
    releasedReserved: result.releasedReserved === true, reservedTouched: result.reservedTouched === true,
    // 改期时把「从哪改到哪」如实带出来（handler 已经算好，别在这里丢掉）；
    // ⛔ 取消没有 from/to ⇒ 保持 `null`，不要拿今天的日期顶替（凭空造时间是 §128 钉过的老坑）。
    from: result.from || null, to: result.to || null,
    teachingCoachId: own.ownerCoachId, datasetRevision: response.datasetRevision,
    replayed: response.idempotent === true,
    // ⭐ M3-P0：通知事件的落库结果**必须如实带给调用方**（不许静默）——
    //   `ok:false` = "预约本身已成功、通知事件没记上"，`failures` 里带可追踪的错误码与集合名。
    //   ⛔ 这里绝不能吞成 `null`：真机事故时用户看到的就是一句莫名其妙的报错，
    //      如果连"通知没记上"都不说，M4 接微信后就会变成"课改了但谁都没被告知"且无人知晓。
    notify: response.notify || null
  }
}

module.exports = {
  CREATE_COMMAND, CANCEL_COMMAND, RESCHEDULE_COMMAND,
  MEMBER_COMMANDS, MEMBER_PAYLOAD_KEYS, FORBIDDEN_KEYS, BOOKING_VIEW_KIND,
  POLICY_DIRECT, POLICY_COACH_CONFIRM, POLICIES, REQUEST_STATUS_OF_POLICY,
  setPolicy, currentPolicy, requestStatusOf,
  // M3-P6：六条已定稿的取消 / 改期规则（**唯一真相源**，客户端孪生逐字段比对）。
  MANAGE_POLICY,
  memberIdFor, fixedId, beijingDateKey, forbiddenIn, validateRequestId,
  resolveMemberTarget, resolveOwnBooking, createMemberBookingHandler,
  cancelMemberBookingHandler, rescheduleMemberBookingHandler,
  markMemberBooking, runMemberBooking, runManage
}
