// ─────────────────────────────────────────────────────────────────────────────
// ⏰ 课前提醒（上课前 3 小时 / 1 小时）的**纯逻辑核心**（2026-10-05 需求二）
//
// ⭐⭐ 这份文件**不碰** `wx-server-sdk`：数据库句柄、发送函数、集合名**全部由调用方注入**
//    ⇒ 它可以在 Node 里被直接测试（tests/class-reminder-scheduler.test.js）。
//
// 🎯 用户定稿的 16 条要求，本文件逐条对应（括号里是实现的段落）：
//   1. 每 5 分钟跑一次              —— 由 `config.json` 的定时触发器声明（本文件不负责）
//   2. 3 小时后上课 ⇒ 发 3 小时提醒 —— `dueKindsOf()`
//   3. 1 小时后上课 ⇒ 发 1 小时提醒 —— 同上
//   4. 每节课分别记录 4 个标记      —— `sent['<kind>:<role>']`（教练3h/会员3h/教练1h/会员1h）
//   5. 同一人同一节同一种最多一次   —— 发送前查 `sent`，成功后才写 `sent`
//   6. 取消后未发的全部作废         —— 预约不再"待上课" ⇒ 整行标 `void`
//   7. 改期后旧提醒作废、按新时间重算 —— `startAt` 变了 ⇒ 清空 `sent` / `lease` / `lastFailure`
//   8. 已完课 / 已取消 / 已过期不发 —— `eligibleOf()`
//   9. 没授权不发送、记"没有授权"   —— 43101 ⇒ `SUBSCRIBE_NOT_AUTHORIZED`，⛔ 绝不假成功
//  10. 失败留记录、可安全重试       —— `lastFailure` + `attempts`，⛔ `sent` 不动
//  11. 成功后不再重试               —— `sent` 已置位 ⇒ 直接跳过
//  12. Sandbox 只扫 Sandbox         —— 集合与"账本清单来源"由调用方注入（本文件零集合字面量）
//  13. Production 只扫 Production   —— 同上
//  14. 测试区消息绝不给正式用户     —— 同上（两份副本各注入自己那一套集合）
//  15. 北京时间计算                 —— `beijingPartsOf()` / `startAtOf()`，⛔ 不用本机时区
//  16. 重复运行 / 重复启动不重复发  —— `sent` 幂等 + `lease` 并发租约
//
// ⛔⛔ 为什么提醒状态**不能**写回 `bookings`：
//   `bookings` 是**业务集合**，参与 checksum / 指纹 / 增量 / revision。
//   往里面写"提醒发没发过"会改动业务数据（revision 推进、跨设备同步出增量）⇒ 直接踩到
//   Frozen（已真机通过的同步链）。⇒ 提醒状态单独放一张**元集合**（`reminders`），
//   不进 `BUSINESS`、不参与指纹，读链路一个字都不用改。
// ----------------------------------------------------------------------------
const crypto = require('crypto')
const templates = require('./notify-templates')

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const fixedId = (kind, owner, suffix = '') => sha(`${kind}:${owner}:${suffix}`).slice(0, 32)
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))

// ── 北京时间（⛔ 云函数默认时区常常是 UTC，直接用 `new Date().getHours()` 会整整差 8 小时）
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const pad2 = value => String(value).padStart(2, '0')
function beijingPartsOf(timestamp) {
  const shifted = new Date(Number(timestamp) + BEIJING_OFFSET_MS)
  if (Number.isNaN(shifted.getTime())) return null
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() }
}
// "YYYY-MM-DD"（北京时间）
function beijingDateKeyOf(timestamp) {
  const parts = beijingPartsOf(timestamp)
  return parts ? `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` : ''
}
// 课程开始时刻（**北京时间**的 YYYY-MM-DD + HH:mm ⇒ 毫秒时间戳）
//   ⛔ 写法是 `Date.UTC(年, 月-1, 日, 时-8, 分)`：把北京时间换算回 UTC 毫秒。
//      hour-8 为负数时 `Date.UTC` 会自动向前借一天 ⇒ 跨日也正确。
function startAtOf(booking) {
  const source = booking || {}
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(source.date || ''))
  if (!matched) return 0
  const hour = Number(source.hour || 0), minute = Number(source.minute || 0)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0
  const at = Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]), hour - 8, minute)
  return Number.isNaN(at) ? 0 : at
}

// ── 提醒种类与角色
const REMINDER_KINDS = Object.freeze([templates.KINDS.REMINDER_3H, templates.KINDS.REMINDER_1H])
const ROLES = Object.freeze(['coach', 'member'])
const OUTSTANDING_STATUS = 'booked'          // 与 `occupancy.OUTSTANDING_STATUS` 同义：还没上、还没取消
const MAX_LEAD_MINUTES = 180                 // 扫描窗口：只看"最多 3 小时后就开始"的课
const LEASE_MS = 5 * 60 * 1000               // 并发租约：5 分钟内的重复跑不再发第二次
const keyOf = (kind, role) => `${kind}:${role}`

// 🎯 这一刻哪些提醒**该发**了。
//   ⛔ 判据是"现在 >= 开始 - 提前量 且 现在 < 开始"：
//      · 到点就发（3 小时前那一次运行命中 3 小时提醒，1 小时前那一次命中 1 小时提醒）；
//      · ⭐ 万一某一次定时没跑成（冷启动 / 限流），下一次运行会**补发**还没发的那种
//        （比如 3 小时那次没跑，2 小时时补一条"还有 3 小时其实已过"⇒ 仍然提醒，不会漏课）。
//      · ⛔ 课程一旦开始（`now >= startAt`）就一律不发 —— 迟到的提醒没有意义。
function dueKindsOf(startAt, now) {
  const due = []
  if (!startAt || !now) return due
  if (now >= startAt) return due                              // 已开始 / 已过期
  REMINDER_KINDS.forEach(kind => {
    const lead = Number(templates.LEAD_MINUTES_OF[kind] || 0)
    if (now >= startAt - lead * 60 * 1000) due.push(kind)
  })
  return due
}

// 🎯 这节课**值不值得**提醒（已完课 / 已取消 / 时间解析不出来 ⇒ 不值得）。
function eligibleOf(booking, startAt, now) {
  if (!booking) return { ok: false, reason: 'missing' }
  if (String(booking.status || '') !== OUTSTANDING_STATUS) {
    return { ok: false, reason: String(booking.status || '') === 'cancelled' ? 'cancelled' : 'completed' }
  }
  if (!startAt) return { ok: false, reason: 'bad-time' }
  if (now >= startAt) return { ok: false, reason: 'expired' }
  return { ok: true, reason: '' }
}

function blankRow({ environment, place, bookingId, booking, startAt, now }) {
  return {
    environment, ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, bookingId,
    studentId: String((booking && booking.studentId) || ''),
    date: String((booking && booking.date) || ''), hour: Number((booking && booking.hour) || 0), minute: Number((booking && booking.minute) || 0),
    startAt, status: 'scheduled', sent: {}, lease: {}, lastFailure: {}, attempts: 0,
    createdAt: now, updatedAt: now
  }
}

// 🔁 改期：原时间那些提醒**全部作废**（已发出的没法收回，但新时间要重新算一遍）。
function resetForReschedule(row, booking, startAt, now) {
  const next = clone(row)
  next.date = String((booking && booking.date) || '')
  next.hour = Number((booking && booking.hour) || 0)
  next.minute = Number((booking && booking.minute) || 0)
  next.startAt = startAt
  next.sent = {}
  next.lease = {}
  next.lastFailure = {}
  next.attempts = 0
  next.status = 'scheduled'
  next.rescheduledAt = now
  next.updatedAt = now
  return next
}

// ⏰ 一次扫描。所有外部依赖都从参数注入（`db` / `collections` / `send` / `openIdFor` / `now`）。
async function scanOnce({ db, environment = 'production', collections, send, openIdFor, now = Date.now(), pages = 5 }) {
  const outcome = { environment, now: Number(now) || Date.now(), scanned: 0, sent: 0, skipped: 0, voided: 0, rescheduled: 0, results: [] }
  if (!db || !collections) return outcome
  const at = Number(now) || Date.now()

  // ① 账本清单（**只来自本环境那张 heads 表** ⇒ 正式区跑不会读到测试区，反之亦然）
  const places = []
  for (let offset = 0; offset < pages; offset += 1) {
    const response = await db.collection(collections.heads).skip(offset * 100).limit(100).get()
    const rows = (response && response.data) || []
    rows.forEach(row => {
      if (row && row.ownerCoachId && row.activeDatasetId) places.push({ ownerCoachId: String(row.ownerCoachId), datasetId: String(row.activeDatasetId) })
    })
    if (rows.length < 100) break
  }

  // ② 只看"北京时间"这两天的课（跨度最多 3 小时 ⇒ 最多跨一个日界）
  const dateKeys = []
  ;[at, at + MAX_LEAD_MINUTES * 60 * 1000].forEach(ts => {
    const key = beijingDateKeyOf(ts)
    if (key && dateKeys.indexOf(key) < 0) dateKeys.push(key)
  })

  for (const place of places) {
    for (const dateKey of dateKeys) {
      const response = await db.collection(collections.bookings)
        .where({ ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, 'data.date': dateKey })
        .limit(200).get()
      const rows = (response && response.data) || []
      for (const row of rows) {
        const booking = clone((row && row.data) || {})
        const bookingId = String(booking.id || (row && row.bookingId) || '')
        if (!bookingId) continue
        const startAt = startAtOf(booking)
        // ③ 窗口：只看"还没开始、且最多 3 小时后开始"的课（更早的课轮不到这一轮）
        if (startAt <= at || startAt > at + MAX_LEAD_MINUTES * 60 * 1000) continue
        outcome.scanned += 1
        const reminderId = fixedId('class-reminder', environment, `${place.ownerCoachId}:${place.datasetId}:${bookingId}`)
        const existing = await db.collection(collections.reminders).doc(reminderId).get()
        let current = clone((existing && existing.data) || null)

        const eligible = eligibleOf(booking, startAt, at)
        if (!eligible.ok) {
          // ④ 取消 / 完课 / 已过期 ⇒ 还没发的提醒**全部作废**（⛔ 一行都不再发）
          if (current && current.status !== 'void') {
            const next = clone(current)
            next.status = 'void'; next.voidReason = eligible.reason; next.voidedAt = at; next.updatedAt = at
            await db.collection(collections.reminders).doc(reminderId).set({ data: next })
            outcome.voided += 1
          }
          outcome.skipped += 1
          continue
        }
        if (!current) current = blankRow({ environment, place, bookingId, booking, startAt, now: at })
        else if (Number(current.startAt || 0) !== startAt) {
          // ⑤ 改期：原时间的提醒全部作废，按新时间重新计算
          current = resetForReschedule(current, booking, startAt, at)
          outcome.rescheduled += 1
        }
        if (current.status === 'void') { current.status = 'scheduled'; current.voidReason = ''; current.updatedAt = at }

        const due = dueKindsOf(startAt, at)
        if (!due.length) { await persist(db, collections, reminderId, current); continue }

        for (const kind of due) {
          for (const role of ROLES) {
            const key = keyOf(kind, role)
            // ⑥ 一个业务事件最多发一次
            if (current.sent && current.sent[key]) { outcome.skipped += 1; outcome.results.push({ bookingId, kind, role, ok: false, code: 'ALREADY_SENT', sent: false }); continue }
            // ⑦ 并发租约：重复运行 / 云函数重复启动不会发第二次
            if (current.lease && current.lease[key] && at - Number(current.lease[key]) < LEASE_MS) {
              outcome.skipped += 1
              outcome.results.push({ bookingId, kind, role, ok: false, code: 'LEASE_HELD', sent: false })
              continue
            }
            // ⑧ 收件人：教练 = 授课教练（没有就账本所有者）；会员 = 认领关系推导出来的那个会员
            const recipient = await recipientOf({ db, collections, place, booking, role })
            if (!recipient) {
              outcome.skipped += 1
              outcome.results.push({ bookingId, kind, role, ok: false, code: role === 'coach' ? 'RECIPIENT_COACH_MISSING' : 'RECIPIENT_MEMBER_MISSING', sent: false })
              continue
            }
            // ⑨ 模板没配置 ⇒ 明确报缺口，⛔ 一次 send 都不许调（否则就是伪造发送）
            const templateId = templates.templateIdFor(kind)
            if (!templateId) {
              outcome.skipped += 1
              outcome.results.push({ bookingId, kind, role, ok: false, code: 'TEMPLATE_NOT_CONFIGURED', sent: false, retryable: true })
              continue
            }
            const openId = String((openIdFor && await openIdFor(recipient)) || '')
            if (!openId) {
              current.lastFailure[key] = { code: 'RECIPIENT_OPENID_MISSING', message: '查不到这位收件人的微信标识，本次不发。', at }
              outcome.skipped += 1
              outcome.results.push({ bookingId, kind, role, ok: false, code: 'RECIPIENT_OPENID_MISSING', sent: false, retryable: true })
              continue
            }
            // ⑩ 先占位（租约）再发 ⇒ 中途崩溃也不会在下一轮重复发
            current.lease[key] = at
            await persist(db, collections, reminderId, current)
            const { data, page } = templates.messageOf({ type: kind, booking, recipient })
            try {
              await send({ touser: openId, templateId, page, data, miniprogramState: 'formal' })
            } catch (error) {
              const mapped = templates.mapSendError(error)
              // ⛔ 失败：清掉租约（下一轮可以安全重试）+ 留痕，⛔ `sent` 绝不置位
              delete current.lease[key]
              current.lastFailure[key] = { code: mapped.code, message: mapped.message, at }
              current.attempts = Number(current.attempts || 0) + 1
              current.updatedAt = at
              await persist(db, collections, reminderId, current)
              outcome.skipped += 1
              outcome.results.push({ bookingId, kind, role, ok: false, sent: false, ...mapped })
              continue
            }
            // ⑪ 只有真的发成功才置位 ⇒ 以后永远不再重发
            delete current.lease[key]
            current.sent[key] = { at, ok: true }
            current.attempts = Number(current.attempts || 0) + 1
            current.updatedAt = at
            await persist(db, collections, reminderId, current)
            outcome.sent += 1
            outcome.results.push({ bookingId, kind, role, ok: true, sent: true, code: 'SENT' })
          }
        }
        await persist(db, collections, reminderId, current)
      }
    }
  }
  return outcome
}

async function persist(db, collections, reminderId, row) {
  await db.collection(collections.reminders).doc(reminderId).set({ data: clone(row) })
}

// 👤 收件人。**只从服务端自己的表推导**，⛔ 绝不信任任何客户端字段。
async function recipientOf({ db, collections, place, booking, role }) {
  if (role === 'coach') {
    const coachId = String((booking && booking.teachingCoachId) || '') || String(place.ownerCoachId || '')
    return coachId ? { kind: 'coach', coachId } : null
  }
  const studentId = String((booking && booking.studentId) || '')
  if (!studentId) return null
  try {
    const response = await db.collection(collections.claims).where({ studentId, status: 'verified' }).limit(20).get()
    const list = ((response && response.data) || []).map(clone)
    // ⭐ 优先"这本账自己认领的那条"，再退到任意一条（同一位学员可能被多位教练各自认领）。
    const preferred = list.find(row => row && row.memberId && String(row.coachId || '') === String(place.ownerCoachId || '')) || list.find(row => row && row.memberId)
    return preferred ? { kind: 'member', memberId: String(preferred.memberId) } : null
  } catch (error) {
    return null
  }
}

module.exports = {
  BEIJING_OFFSET_MS, REMINDER_KINDS, ROLES, OUTSTANDING_STATUS, MAX_LEAD_MINUTES, LEASE_MS,
  beijingPartsOf, beijingDateKeyOf, startAtOf, dueKindsOf, eligibleOf, keyOf,
  blankRow, resetForReschedule, recipientOf, scanOnce, fixedId
}
