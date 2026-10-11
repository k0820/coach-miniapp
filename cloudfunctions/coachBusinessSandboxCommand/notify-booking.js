// ─────────────────────────────────────────────────────────────────────────────
// 🔔 预约变动的**统一通知分发器**（2026-10-07 · 1.3.38）
//
// ⭐⭐ 它要解决的正是用户点名的那个结构性问题：
//      「**会员约教练怎么通知，教练约会员就该用同一套机制反过来通知。**」
//
//   在此之前项目里有**两个**各写各的入口：
//     · `handlers.recordBookingChange()`    —— 教练动 ⇒ 通知会员（**要反查"这个学员是哪个会员"**）
//     · `memberBooking.recordMemberChange()` —— 会员动 ⇒ 通知教练（教练 ID **业务上下文里就有**）
//   ⇒ 两条链唯一的分叉点就在「收件人从哪来」：一边是**现成的**，一边是**猜出来的**。
//     "猜"的那条一旦猜不中，就 `return null` **静默返回** ⇒ 事件根本不产生 ⇒ 会员什么都没有，
//     而云端日志里**一行痕迹都没有**。这正是 1.3.36 / 1.3.37 两轮真机都没能定位住的根因。
//
// ⛔⛔ 本文件的三条铁律：
//   ① **只有这一个分发器**决定"谁动了 ⇒ 通知谁"。两个入口只是把 `actorRole` 传进来，
//      ⛔ 绝不允许再出现第二套"按角色分别实现"的通知路径。
//   ② **收件人一律由业务上下文决定，绝不靠通知层自己回忆身份**：
//        actor=coach  ⇒ recipient = 这本账里 `studentId` 对应的**会员**（canonical resolver，见下）
//        actor=member ⇒ recipient = `business.ownerCoachId`（**零解析**，与真机通过的那条逐字一致）
//   ③ **认不出人就留痕，绝不静默**：`notify.noteUnresolved()` 会把它写进事件台账与云函数日志，
//      这样真机一眼就能区分"没找到人"和"微信没额度"。
//
// 📌 `canonical recipient resolver`（统一收件人解析器）的取值顺序：
//     「**coach + dataset + student** ⇒ 会员绑定 ⇒ 会员 ID ⇒ 会员 OPENID」
//   ① `booking.createdByMemberId` —— 业务**已经确定**的会员（会员自己约的课），最可信，直接用；
//   ② 会员主资料按 **(ownerCoachId + ownerDatasetId + studentId)** 三元组 ——
//      ⛔ 这个三元组与 `member-directory.bindMember()` 写入时的字段**逐字一致**，
//      是"教练 A 建了张三、张三微信绑上去"这件事在数据库里的**唯一落点**；
//   ③ 主资料按 (ownerCoachId + studentId) —— datasetId 缺失时的退路；
//   ④ 主资料按 (studentId) —— B 教练给张三排课（张三登记在 A 名下）时的退路；
//   ⑤ 旧认领表 —— 历史会员的兼容层（⛔ 保留，不删不改）。
//
// ⛔ 与 `notify.js` 一样，本文件是**孪生副本**：正式区与测试区各一份、逐字节相同。
//    ⇒ ⛔ 不许出现任何一侧的集合名字面量，集合名一律由 `notify` / `authorization` 按环境给出。
// ----------------------------------------------------------------------------
const notify = require('./notify')

const ACTOR_MEMBER = notify.ACTOR_MEMBER
const ACTOR_COACH = notify.ACTOR_COACH

// 🎯 三种预约变动（⛔ 只此一处命名，事件类型由 `actorRole + act` 唯一决定）
const ACTS = Object.freeze({ CREATE: 'create', CANCEL: 'cancel', RESCHEDULE: 'reschedule' })
const ACT_LIST = Object.freeze(Object.values(ACTS))

// 🗺️ 「谁动的 + 做了什么」⇒ 唯一一个事件类型。⛔ 别处不许再拼这种字符串。
function eventTypeFor(actorRole, act) {
  const types = notify.EVENT_TYPES
  const role = String(actorRole || '')
  if (role === ACTOR_MEMBER) {
    if (act === ACTS.CREATE) return types.MEMBER_CREATED
    if (act === ACTS.CANCEL) return types.MEMBER_CANCELLED
    if (act === ACTS.RESCHEDULE) return types.MEMBER_RESCHEDULED
    return ''
  }
  if (role === ACTOR_COACH) {
    if (act === ACTS.CREATE) return types.COACH_CREATED
    if (act === ACTS.CANCEL) return types.COACH_CANCELLED
    if (act === ACTS.RESCHEDULE) return types.COACH_RESCHEDULED
    return ''
  }
  return ''
}

// 🔁 反查：既有代码手里拿的是**事件类型**（历史签名），这里翻译成"做了什么"。
//   ⛔ 只为兼容两个老入口的签名，新代码一律直接用 `act`。
function actForType(type) {
  const types = notify.EVENT_TYPES
  const value = String(type || '')
  if (value === types.MEMBER_CREATED || value === types.COACH_CREATED) return ACTS.CREATE
  if (value === types.MEMBER_CANCELLED || value === types.COACH_CANCELLED) return ACTS.CANCEL
  if (value === types.MEMBER_RESCHEDULED || value === types.COACH_RESCHEDULED) return ACTS.RESCHEDULE
  return ''
}

// 🔎 在同一张表里按条件取会员 ID。
//
// ⛔⛔ 返回值必须能区分三种情况（1.3.39：以前只有 `''`，把"读失败"和"确实没有"混成一种
//     ⇒ 真机上整条链静默断掉，云端日志一行痕迹都没有）：
//      · `{ hit: '<id>', error: '' }`       = 找到了
//      · `{ hit: '', error: '' }`           = 这张表里**确实没有**（正常事实，继续退下一条）
//      · `{ hit: '', error: '<码>' }`       = **这一步自己出故障** ⇒ 记进 `errors`，换备读句柄再试
//   ⛔ 三种情况都**不抛**：通知永远是附属能力。
async function memberIdIn(reader, name, cond) {
  if (!reader || typeof reader.collection !== 'function' || !name) return { hit: '', error: 'READER_MISSING' }
  try {
    const response = await reader.collection(name).where(cond).limit(10).get()
    const list = (response && response.data) || []
    const hit = list.find(row => row && String(row.memberId || ''))
    return { hit: hit ? String(hit.memberId) : '', error: '' }
  } catch (error) {
    const code = String((error && (error.errCode || error.code)) || (error && error.message) || 'READ_FAILED')
    return { hit: '', error: code }
  }
}

// 🎯 canonical recipient resolver：**coach + dataset + student ⇒ 会员 ID**
//   ⛔ 这不是"猜会员是谁"，而是读**绑定那一刻就写死的三元组**（`bindMember` 的落点）。
//   ⛔ 返回值**永远**带 `tried`：认不出人时它是唯一的诊断线索。
async function resolveMemberRecipient(reader, options) {
  const opts = options || {}
  const environment = String(opts.environment || 'production')
  const { collectionsFor } = require('./authorization')
  const membersCollection = notify.memberCollectionFor(environment)
  const claimsCollection = collectionsFor(environment).claims
  const ownerCoachId = String(opts.ownerCoachId || '')
  const datasetId = String(opts.datasetId || '')
  const studentId = String(opts.studentId || '')
  const tried = []

  // ① 业务**已经确定**的会员：会员自己创建的预约，`booking` 上就带着。
  //    ⛔ 这是"不要再猜"的第一优先级 —— 有现成的就用现成的。
  const fromBooking = String(opts.createdByMemberId || '')
  if (fromBooking) return { memberId: fromBooking, via: 'booking-context', tried }

  if (!studentId) {
    return { memberId: '', via: '', tried, code: 'STUDENT_ID_MISSING', message: '这条预约里没有学员标识，无法确定要通知哪位会员。' }
  }

  const steps = [
    ['members:place+student', membersCollection, { ownerCoachId, ownerDatasetId: datasetId, studentId }],
    ['members:coach+student', membersCollection, { ownerCoachId, studentId }],
    ['members:student', membersCollection, { studentId }],
    ['claims:legacy', claimsCollection, { studentId, status: 'verified' }]
  ]
  // 📚 备读句柄（裸 `db`）：**只在事务那条读抛错时**才用（优先级永远低于事务快照）。
  //    ⛔ 它不是"多猜一次会员是谁"，而是"同一条线索换一种读法" —— 线索本身一条都没变。
  const readers = [reader, opts.fallback].filter(item => !!item)
  const errors = []
  for (const step of steps) {
    const via = step[0]
    tried.push(via)
    for (const handle of readers) {
      const outcome = await memberIdIn(handle, step[1], step[2])
      if (outcome.hit) return { memberId: outcome.hit, via, tried, errors }
      if (outcome.error) errors.push(`${via}:${outcome.error}`)
    }
  }
  return {
    memberId: '', via: '', tried, errors,
    // ⛔ 两种"没找到"必须分开口径：**每一步都读失败** 与 **确实没有绑定过**，
    //    真机要看云端日志一眼分出"读不到"还是"没绑过"。
    code: errors.length >= steps.length ? 'MEMBER_LOOKUP_READ_FAILED' : 'MEMBER_BINDING_NOT_FOUND',
    message: `这位学员（${studentId.slice(0, 8)}）还没有绑定过微信会员，无法确定通知收件人。` +
      (errors.length ? `（读取过程还报了 ${errors.length} 次错：${errors.slice(0, 3).join(' / ')}）` : '')
  }
}

// 📮 唯一的入口：预约变动 ⇒ 通知另一方。
//   ⛔ 两个调用方（`handlers` 教练侧 / `memberBooking` 会员侧）**只**负责告诉它"谁动的"，
//      方向判定、收件人解析、事件登记**全部**在这里，一处改两处生效。
async function notifyBookingChange(context, options) {
  const opts = options || {}
  // ─────────────────────────────────────────────────────────────────────────
  // 🚦 出口 ①：调用方没把通知能力交进来（通常是测试桩 / 未注入 delivery 的通道）。
  //   ⛔ 以前是静默 `return null`。现在**必须留痕**：否则真机上"一条通知都没有"时，
  //     根本分不清是"没注入"还是"认不出人"。
  if (!context || !context.notify || typeof context.notify.record !== 'function') {
    console.error('[notify-booking] 出口①：调用方没有可用的通知能力（业务不受影响）', JSON.stringify({
      code: 'NOTIFY_SCOPE_MISSING', hasContext: !!context, hasNotify: !!(context && context.notify)
    }))
    return null
  }
  const scope = context.notify
  // ─────────────────────────────────────────────────────────────────────────
  // 🚦 出口 ②：**显式抑制**（会员改期复用教练侧的改期实现 ⇒ 必须掐掉教练侧那一次登记，
  //    否则一次会员改期会落下两条事件，其中一条把 actor 伪造成教练、还会给会员本人发通知）。
  //   ✅ 这是**设计内**的出口，不是故障；但仍然记一行，避免将来"为什么没通知"查不到。
  if (opts.suppress === true || context.suppressBookingChangeNotify === true) {
    console.error('[notify-booking] 出口②：本次登记被显式抑制（会员改期复用教练改期，⛔ 不许伪造 actor）', JSON.stringify({
      code: 'NOTIFY_SUPPRESSED', actorRole: String(opts.actorRole || ''), act: String(opts.act || '')
    }))
    return null
  }
  const type = eventTypeFor(opts.actorRole, opts.act)
  // 🚦 出口 ③：`actorRole + act` 拼不出事件类型（代码写错，不是业务事实）⇒ 留痕。
  if (!type) {
    scope.noteUnresolved('notify-booking:exit-3', {
      code: 'NOTIFY_EVENT_TYPE_UNRESOLVED',
      message: `无法由 actorRole=${String(opts.actorRole || '')} / act=${String(opts.act || '')} 决定事件类型。`,
      studentId: String((opts.booking && opts.booking.studentId) || opts.studentId || '')
    })
    return null
  }
  const booking = opts.booking || {}
  const business = opts.business || {}
  const ownerCoachId = String(business.ownerCoachId || scope.ownerCoachId || '')
  const datasetId = String(business.datasetId || scope.datasetId || '')
  const now = opts.now || context.now || Date.now()
  const requestId = opts.requestId || context.requestId || ''
  // 🚦 出口 ④：缺 requestId。以前静默返回 ⇒ 事件**连生成都不生成**，而下游（`flush` /
  //    投递 / `writeInbox`）写得再正确也没有输入 ⇒ 真机表现就是"微信没有、站内消息也没有"。
  if (!requestId) {
    scope.noteUnresolved('notify-booking:exit-4', {
      code: 'NOTIFY_REQUEST_ID_MISSING',
      message: '缺少 requestId ⇒ 无法保证幂等，这条通知没有登记（业务不受影响）。',
      studentId: String(booking.studentId || opts.studentId || ''), ownerCoachId, datasetId, tried: []
    })
    return null
  }

  let actor = null, recipient = null, via = ''
  if (String(opts.actorRole) === ACTOR_COACH) {
    actor = { kind: ACTOR_COACH, coachId: ownerCoachId }
    // ⭐ 读事务（与业务同一个事务快照）优先：业务刚刚写进去的东西它一定看得到。
    //    ⛔ 万一事务这条读在真机上不可用 ⇒ 退到备读句柄（`scope.fallbackReader`），
    //       ⛔ 绝不让"读不到"变成"整条通知链静默断掉"。
    const reader = opts.reader || scope.reader || null
    const fallback = opts.fallback || scope.fallbackReader || null
    const resolved = await resolveMemberRecipient(reader, {
      environment: scope.environment,
      ownerCoachId, datasetId,
      studentId: String(booking.studentId || opts.studentId || ''),
      createdByMemberId: String(booking.createdByMemberId || ''),
      fallback
    })
    if (!resolved.memberId) {
      // ⛔⛔ 认不出人 ⇒ **留痕**，⛔ 绝不静默 return（静默就是 1.3.37 定位不住的原因）。
      if (typeof scope.noteUnresolved === 'function') {
        scope.noteUnresolved('resolve-member-recipient', {
          code: resolved.code || 'MEMBER_BINDING_NOT_FOUND',
          message: resolved.message || '没能确定这条通知该发给谁。',
          studentId: String(booking.studentId || opts.studentId || ''),
          ownerCoachId, datasetId, tried: resolved.tried, errors: resolved.errors || []
        })
      }
      return null
    }
    recipient = { kind: ACTOR_MEMBER, memberId: resolved.memberId }
    via = resolved.via
  } else {
    const memberId = String(booking.createdByMemberId || opts.memberId || '')
    // 🚦 出口 ⑤：会员侧却拿不到会员 ID ⇒ 留痕（否则同样表现为"教练什么都没收到"）。
    if (!memberId) {
      scope.noteUnresolved('notify-booking:exit-5', {
        code: 'NOTIFY_MEMBER_ACTOR_ID_MISSING',
        message: '会员发起的变动却没有会员标识，无法确定谁动的手（业务不受影响）。',
        studentId: String(booking.studentId || opts.studentId || ''), ownerCoachId, datasetId, tried: []
      })
      return null
    }
    // ⭐ 教练 ID **就在业务上下文里**（这本账的所有者）⇒ 零解析，与真机通过的那条完全一致。
    actor = { kind: ACTOR_MEMBER, memberId }
    recipient = { kind: ACTOR_COACH, coachId: ownerCoachId }
    via = 'business-owner-coach'
  }
  const event = await scope.record({ type, actor, recipient, booking, requestId, now, extra: opts.extra || {} })
  // ⭐ 把"收件人是怎么定出来的"带回去，方便调用方 / 测试断言（⛔ 不进队列，只做诊断）。
  return event ? { ...event, resolvedVia: via } : null
}

module.exports = {
  ACTS, ACT_LIST, ACTOR_MEMBER, ACTOR_COACH,
  eventTypeFor, actForType, resolveMemberRecipient, notifyBookingChange
}
