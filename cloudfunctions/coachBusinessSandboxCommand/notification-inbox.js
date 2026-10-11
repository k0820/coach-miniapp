// ─────────────────────────────────────────────────────────────────────────────
// 📥 **站内消息中心**（2026-10-06 需求五 / 需求六）—— 不限次数、不依赖微信授权的兜底
//
// ⭐⭐ 它存在的唯一理由：微信「一次性订阅」**一条授权只够一条提醒**。
//    ⇒ 额度用完了、用户拒绝过、模板没配置、openid 查不到 …… 任何一种情况下，
//      **站内消息都必须存在**（⛔ 微信发不出去 ⇒ 业务消息绝不能跟着一起消失）。
//
// ⛔⛔ 六条硬纪律（tests/notification-inbox-sandbox.test.js 逐条钉死）：
//   ① **只写 Sandbox 集合**：`member_sandbox_notification_inbox` / `coach_sandbox_notification_inbox`。
//      `environment !== 'sandbox'` ⇒ `createInbox` 直接返回 `null` ⇒ 一次写都不可能发生。
//   ② **一个业务事件 = 两条独立消息**：操作者一条（"你做了什么"）+ 另一方一条（"对方做了什么"）。
//      ⛔ 两条的**微信发送结果各记各的**：一方成功**绝不**把另一方也标成成功。
//   ③ **收件人由服务端关系确定**：`ownerId` 只来自事件里的 `actor` / `recipient`（服务端写的），
//      ⛔ 客户端提交不了任何 openId / coachId / memberId；读消息时也按 OPENID 反查自己的 id。
//   ④ **微信失败不影响站内消息**：`note()` 在投递层之后调用，`wechat` 结果只是**记录**，
//      ⛔ 绝不因为 `sent === false` 就不写这一条。
//   ⑤ **幂等**：`_id` = hash(eventId + audience) ⇒ 同一事件重复登记只会覆盖同一行。
//   ⑥ **写失败绝不抛**：与 `notify.js` 同一把尺 —— 业务已经成功了，附属功能不许把它拖下水。
//
// ⛔ 本文件**只在测试区函数目录里**（正式区那份没有它）⇒ 集合名可以放心写沙盒字面量。
//    ⛔ 反过来：本文件里**绝不出现**任何正式区集合名（隔离护栏会静态扫描）。
// ----------------------------------------------------------------------------
const crypto = require('crypto')
const templates = require('./notify-templates')

const COLLECTIONS = Object.freeze({
  member: 'member_sandbox_notification_inbox',
  coach: 'coach_sandbox_notification_inbox'
})
// 会员账号表（用来把会员的 OPENID 反查成 memberId；⛔ 只认沙盒那一份）
const ACCOUNTS = 'member_sandbox_accounts'
// 教练表（两个环境共用，靠 openId 定位）⇒ 属"中性集合"，不算落到正式区
const COACHES = 'coaches'

const KIND_MEMBER = 'member'
const KIND_COACH = 'coach'
const AUDIENCE_ACTOR = 'actor'             // 操作者本人 ⇒ 收到"操作结果确认"
const AUDIENCE_COUNTERPART = 'counterpart' // 另一方 ⇒ 收到"对方动了你的课"
const LIMIT = 50

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const fixedId = (...parts) => sha(parts.join(':')).slice(0, 32)
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const collectionFor = kind => (kind === KIND_MEMBER ? COLLECTIONS.member : COLLECTIONS.coach)
// ⭐ 与 `readMyMemberData` 的 `memberIdFor` **同一个公式**（客户端提交不了，只由 OPENID 推导）。
const memberIdFor = openId => sha(`member:${openId}`).slice(0, 32)

// 🗣️ 一句话说清"谁动了什么课"（⛔ 用真名，⛔ 绝不写笼统的"会员"）
const VERB_OF = Object.freeze({
  'member-booking-created': '预约了',
  'member-booking-cancelled': '取消了',
  'member-booking-rescheduled': '改到了',
  'coach-booking-created': '安排了',
  'coach-booking-cancelled': '取消了',
  'coach-booking-rescheduled': '改到了'
})
const TITLE_OF = Object.freeze({
  'member-booking-created': '新的预约',
  'member-booking-cancelled': '课程已取消',
  'member-booking-rescheduled': '课程已改期',
  'coach-booking-created': '教练安排了课程',
  'coach-booking-cancelled': '课程已取消',
  'coach-booking-rescheduled': '课程已改期'
})

// 🕐 "10月6日16:00"（⛔ 站内消息不受微信 20 字限制 ⇒ 写完整的、人能一眼看懂的时间）
function timeTextOf(booking) {
  const source = booking || {}
  const date = String(source.date || '')
  const parts = date.split('-')
  const hh = String(Number(source.hour || 0)).padStart(2, '0')
  const mm = String(Number(source.minute || 0)).padStart(2, '0')
  if (parts.length < 3) return `${date} ${hh}:${mm}`.trim()
  return `${Number(parts[1])}月${Number(parts[2])}日${hh}:${mm}`
}

// 🧾 消息正文（两条各说各的：操作者是"你…"，另一方是"张三…"）
//   ⛔ 课时变化这一句**直接复用**微信模板那一处口径（`templates.sessionNoteOf`）⇒
//      "已释放 1 节课时"这种话**只有一个出处**，微信推送与站内消息不会说两套。
function bodyOf(event, audience) {
  const source = event || {}
  const booking = source.booking || {}
  const kind = String(source.type || '')
  const verb = VERB_OF[kind] || '更新了'
  const studentName = String(booking.studentName || '') || '学员'
  const coachName = String(booking.coachName || '') || '教练'
  const courseName = String(booking.courseTypeName || '') || templates.DEFAULT_COURSE_NAME
  const when = timeTextOf(booking)
  const sessions = Math.max(1, Math.round(Number(booking.sessions || 1)))
  const sessionTail = templates.sessionNoteOf(kind, sessions)
  // ⛔ 操作者那条**说"你"**，另一方那条说**操作者的真名**（谁动的一目了然）。
  const who = audience === AUDIENCE_ACTOR ? '你' : (kind.indexOf('coach-') === 0 ? coachName : studentName)
  return `${who}${verb}${when}的${courseName}${sessionTail ? `，${sessionTail}` : ''}`
}

// 📝 一条事件 ⇒ 两行待写记录（**各带各的微信结果**）
//   `wechat` 只挂在**另一方**那条上（微信订阅消息本来就是"通知另一方"，⛔ 不给自己发）；
//   操作者那条记成 `SELF_ACTION_NO_PUSH` —— 这是**事实**，不是"发送失败"。
function rowsOf(event, wechat) {
  const source = event || {}
  const actor = source.actor || {}
  const recipient = source.recipient || {}
  const eventId = String(source.eventId || '')
  const booking = clone(source.booking || {})
  const kind = String(source.type || '')
  const occurredAt = Number(source.occurredAt || Date.now())
  const push = wechat || null
  const out = []
  if (recipient.kind === KIND_MEMBER && recipient.memberId) {
    out.push({ kind: KIND_MEMBER, ownerId: String(recipient.memberId), audience: AUDIENCE_COUNTERPART, wechat: push })
  } else if (recipient.kind === KIND_COACH && recipient.coachId) {
    out.push({ kind: KIND_COACH, ownerId: String(recipient.coachId), audience: AUDIENCE_COUNTERPART, wechat: push })
  }
  if (actor.kind === KIND_MEMBER && actor.memberId) {
    out.push({ kind: KIND_MEMBER, ownerId: String(actor.memberId), audience: AUDIENCE_ACTOR, wechat: { sent: false, code: 'SELF_ACTION_NO_PUSH' } })
  } else if (actor.kind === KIND_COACH && actor.coachId) {
    out.push({ kind: KIND_COACH, ownerId: String(actor.coachId), audience: AUDIENCE_ACTOR, wechat: { sent: false, code: 'SELF_ACTION_NO_PUSH' } })
  }
  return out.map(row => ({
    _id: fixedId('notification-inbox', eventId, row.audience),
    environment: 'sandbox',
    kind: row.kind,
    ownerId: row.ownerId,
    audience: row.audience,
    eventId,
    type: kind,
    occurredAt,
    createdAt: occurredAt,
    read: false,
    readAt: null,
    title: TITLE_OF[kind] || '课程变动',
    body: bodyOf(source, row.audience),
    booking,
    // ⛔⛔ 两个人的发送结果**各记各的** ⇒ 一方成功绝不会把另一方也标成成功。
    wechat: {
      sent: !!(row.wechat && row.wechat.sent),
      code: String((row.wechat && (row.wechat.code || row.wechat.status)) || '') || 'NOT_ATTEMPTED',
      message: String((row.wechat && row.wechat.message) || '')
    }
  }))
}

// 🏭 只有 `environment === 'sandbox'` 才造得出一个真能写的收件箱。
function createInbox({ db, environment }) {
  // ⛔⛔ 硬闸门：任何非 sandbox 的环境 ⇒ 返回 null ⇒ 调用方的 `inbox && …` 一次都不会执行。
  if (environment !== 'sandbox' || !db) return null

  async function note(event, wechat) {
    const outcome = { eventId: String((event && event.eventId) || ''), written: 0, rows: [], failures: [] }
    const rows = rowsOf(event, wechat)
    for (const row of rows) {
      try {
        await db.collection(collectionFor(row.kind)).doc(row._id).set({ data: row })
        outcome.written += 1
        outcome.rows.push({ id: row._id, kind: row.kind, ownerId: row.ownerId, audience: row.audience })
      } catch (error) {
        // ⛔ 不是"吞掉"：云函数日志是可追踪点，业务本身一个字节都不受影响。
        outcome.failures.push({ kind: row.kind, code: 'INBOX_WRITE_FAILED', message: String(error && error.message || error) })
        console.error('[inbox] 站内消息写入失败（业务已成功，不受影响）', JSON.stringify(outcome.failures[outcome.failures.length - 1]))
      }
    }
    return outcome
  }

  async function list({ kind, ownerId, limit }) {
    const name = collectionFor(kind)
    const response = await db.collection(name).where({ environment: 'sandbox', kind, ownerId }).limit(Number(limit) || LIMIT).get()
    const rows = ((response && response.data) || []).map(row => clone(row.data || row))
    rows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    return rows
  }

  async function unreadCount({ kind, ownerId }) {
    const rows = await list({ kind, ownerId, limit: 200 })
    return rows.filter(row => row.read !== true).length
  }

  async function markRead({ kind, ownerId, ids }) {
    const name = collectionFor(kind)
    const wanted = Array.isArray(ids) && ids.length ? ids.map(String) : null
    const rows = await list({ kind, ownerId, limit: 200 })
    const now = Date.now()
    let changed = 0
    for (const row of rows) {
      if (row.read === true) continue
      if (wanted && wanted.indexOf(String(row._id)) < 0) continue
      try {
        await db.collection(name).doc(String(row._id)).set({ data: { ...row, read: true, readAt: now } })
        changed += 1
      } catch (error) {
        console.error('[inbox] 标记已读失败', String(error && error.message || error))
      }
    }
    return changed
  }

  // 🔎 OPENID ⇒ 这个人**在服务端**到底是谁（⛔ 客户端提交不了，也改不动）
  async function resolveOwner({ openId }) {
    const out = { coachId: '', memberId: '' }
    const id = String(openId || '')
    if (!id) return out
    try {
      const found = await db.collection(COACHES).where({ openId: id }).limit(1).get()
      const row = found && found.data && found.data[0]
      if (row && row._id) out.coachId = String(row._id)
    } catch (error) { /* 查不到就不是教练，⛔ 不报错 */ }
    try {
      const memberId = memberIdFor(id)
      const found = await db.collection(ACCOUNTS).where({ memberId }).limit(1).get()
      const row = found && found.data && found.data[0]
      if (row && row.memberId) out.memberId = String(row.memberId)
    } catch (error) { /* 查不到就不是会员，⛔ 不报错 */ }
    return out
  }

  // 📖 读接口（唯一入口，由 index.js 在**环境闸之后**调用）
  //   ⛔ `kind` 只是"当前在看会员端还是教练端"，真正决定能看谁的消息的是 OPENID 反查出的 ownerId。
  //   ⛔ 反查不到 ⇒ 一条都不给（绝不退化成"那就全给你看"）。
  async function handle({ openId, kind, op, ids }) {
    const role = kind === KIND_MEMBER ? KIND_MEMBER : KIND_COACH
    const owner = await resolveOwner({ openId })
    const ownerId = role === KIND_MEMBER ? owner.memberId : owner.coachId
    if (!ownerId) return { ok: false, code: 'INBOX_OWNER_UNRESOLVED', message: '没有找到你这个身份的消息箱。', environment: 'sandbox', role, unread: 0, rows: [] }
    if (op === 'read') {
      const changed = await markRead({ kind: role, ownerId, ids })
      return { ok: true, environment: 'sandbox', role, changed, unread: await unreadCount({ kind: role, ownerId }), rows: [] }
    }
    const rows = op === 'unread' ? [] : await list({ kind: role, ownerId, limit: LIMIT })
    return {
      ok: true, environment: 'sandbox', role,
      collection: collectionFor(role),
      unread: await unreadCount({ kind: role, ownerId }),
      rows: rows.map(row => ({ id: row._id, type: row.type, title: row.title, body: row.body, createdAt: row.createdAt, read: row.read === true, audience: row.audience }))
    }
  }

  return { note, list, unreadCount, markRead, resolveOwner, handle, collectionFor }
}

module.exports = {
  COLLECTIONS, ACCOUNTS, COACHES, LIMIT,
  KIND_MEMBER, KIND_COACH, AUDIENCE_ACTOR, AUDIENCE_COUNTERPART,
  VERB_OF, TITLE_OF,
  createInbox, collectionFor, memberIdFor, timeTextOf, bodyOf, rowsOf
}
