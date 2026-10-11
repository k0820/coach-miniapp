// ─────────────────────────────────────────────────────────────────────────────
// 📮 微信**订阅消息**投递层（2026-10-05 需求五）—— M4 的那个唯一接入口
//
// ⭐⭐ 它只做一件事：把 `notify.js` 已经落库的「该通知谁」事件，**真的**发出去。
//   ⛔ 绝不另建第二套通知系统：事件类型、recipient、actor、幂等 eventId、集合隔离
//      **全部沿用 `notify.js`**（`pending()` / `markDelivered()` 就是它的两条腿）。
//
// 🚨🚨 五条硬纪律（tests/member-notify-subscribe.test.js 逐条钉死）：
//   ① **缺模板必须如实报「模板尚未配置」**（`TEMPLATE_NOT_CONFIGURED`），
//      ⛔ 绝不返回"已发送"、绝不假装成功 —— 那比不发更坏（教练以为会员收到了）。
//   ② **只通知另一方**：自己动的手绝不通知自己（不会出现"你的课程被你本人修改"）。
//   ③ **一个业务事件最多发一次**：成功后立刻 `markDelivered`，重试只补**失败**的那些。
//   ④ **失败保留记录、可安全重试**：失败不改 `delivered`，只累加 `attempts` 并留下失败码。
//   ⑤ **Sandbox 只用 Sandbox 数据**：集合由 `notify.collectionFor(environment)` 决定，
//      ⛔ 投递层绝不自己拼集合名，也绝不跨环境读。
//
// 📌 开通的**外部**前提（都要用户本人在微信后台做，本文件不替用户假装已经做完）：
//   1. 公众平台 → 订阅消息 → 公共模板库 → 选用 **3 个**模板（搜索词见 `notify-templates.js`）；
//   2. 把拿到的 3 个模板 ID 填进 `notify-templates.js` 的 `TEMPLATE_IDS`；
//   3. 部署本云函数（测试区那份同名镜像也要一起部署）；
//   4. 真机验收：会员预约/改期/取消 ⇒ 教练收到；教练安排/改期/取消 ⇒ 会员收到。
// ----------------------------------------------------------------------------
const notify = require('./notify')
// ⭐ 模板（3 个）+ 消息组装 + 错误翻译的**唯一真源**，四份孪生副本之一。
const templates = require('./notify-templates')

// ⛔⛔ 模板 ID 在 `notify-templates.js` 里（**只有 3 个**），这里只是转出去：
//   缺模板时投递**必须**回 `TEMPLATE_NOT_CONFIGURED`，⛔ 绝不装作已发送。
const TEMPLATE_IDS = templates.TEMPLATE_IDS
const SUBJECT_OF = templates.SUBJECT_OF
const PAGE_OF = templates.PAGE_OF

const CHANNEL = 'wechat-subscribe'

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const fail = (code, message, extra) => Object.assign(new Error(message), { code, ...(extra || {}) })

// 🗺️ 一个事件种类 → 它共用哪一枚模板 ID（**多个业务事件共用同一个模板**就是靠这一层映射）。
const templateIdFor = kind => templates.templateIdFor(kind)
const configuredTypes = () => templates.KIND_LIST.filter(kind => !!templateIdFor(kind))
const missingTypes = () => templates.KIND_LIST.filter(kind => !templateIdFor(kind))

// 🎯 只通知**另一方**。⛔ 这一条防止"你的课程被你本人修改"这种荒唐通知：
//    recipient 的设计本来就是对方，但投递层必须**再判一次** —— 万一事件被写错方向，
//    这里就是最后一道闸（宁可不发，绝不错发）。
function isSelfAction(event) {
  const actor = (event && event.actor) || {}, target = (event && event.recipient) || {}
  if (!actor.kind || actor.kind !== target.kind) return false
  if (actor.kind === 'member') return !!actor.memberId && String(actor.memberId) === String(target.memberId || '')
  if (actor.kind === 'coach') return !!actor.coachId && String(actor.coachId) === String(target.coachId || '')
  return false
}

// 🧾 消息内容（含两个课前提醒）与错误翻译都在 `notify-templates.js`（四份副本逐字一致）。
const messageOf = event => templates.messageOf(event)
const mapSendError = error => templates.mapSendError(error)

// 📮 投递**一条**事件。
//   `openIdFor(recipient)` 由调用方注入（会员读 account、教练读 coaches）⇒ 本文件不碰任何集合
//   （除了 `notify` 那两个已经存在的出口），也**不假设** openId 存在哪张表里。
async function deliverEvent({ db, environment, event, send, openIdFor, now }) {
  const eventId = String((event && event.eventId) || '')
  if (!eventId) return { eventId, ok: false, code: 'NOTIFY_EVENT_ID_MISSING', sent: false }
  // ⓪ 已投递 ⇒ 直接跳过（"一个业务事件最多发一次"的第二道闸）
  if (event.delivered === true) return { eventId, ok: true, code: 'ALREADY_DELIVERED', sent: false }
  // ① 只通知另一方
  if (isSelfAction(event)) return { eventId, ok: false, code: 'SELF_ACTION_SKIPPED', sent: false }
  // ② 模板缺 ⇒ 明确报"尚未配置"，⛔ 绝不调用 send（否则就是伪造发送）
  const templateId = templateIdFor(event.type)
  if (!templateId) return { eventId, ok: false, code: 'TEMPLATE_NOT_CONFIGURED', sent: false, retryable: true }
  // ③ 收件人的微信标识
  let openId = ''
  try { openId = String((openIdFor && await openIdFor(event.recipient)) || '') } catch (error) { openId = '' }
  if (!openId) return { eventId, ok: false, code: 'RECIPIENT_OPENID_MISSING', sent: false, retryable: true }
  // ④ 真的发
  const { data, page } = messageOf(event)
  try {
    // ⭐ `miniprogram_state`（通知卡片点开后进哪个版本）：测试区在**体验版**上验收 ⇒ 必须 `trial`；
    //   正式区才是 `formal`。⛔ 传错版本会让通知卡片跳到一个"还没发布的页面"。
    const miniprogramState = environment === 'sandbox' ? 'trial' : 'formal'
    await send({ touser: openId, templateId, page, data, miniprogramState })
  } catch (error) {
    const mapped = mapSendError(error)
    // ⛔ 失败**不改** delivered ⇒ 这条事件仍然是"待投递"，可以安全重试（重试也只会补它）。
    await bumpAttempt(db, environment, event, mapped, now)
    return { eventId, ok: false, sent: false, ...mapped }
  }
  await notify.markDelivered(db, environment, eventId, CHANNEL, now)
  return { eventId, ok: true, sent: true, code: 'SENT', attempts: Number(event.delivery && event.delivery.attempts || 0) + 1 }
}

// 📝 失败也要**留痕**（`attempts` + 最后一次失败码），这样"为什么这条没发出去"是可查的。
async function bumpAttempt(db, environment, event, mapped, now) {
  try {
    const name = notify.collectionFor(environment)
    const response = await db.collection(name).where({ _id: event.eventId }).limit(1).get()
    const row = response && response.data && response.data[0]
    if (!row) return null
    const next = clone(row.data || row)
    next.delivered = false
    next.delivery = {
      channel: next.delivery && next.delivery.channel ? next.delivery.channel : CHANNEL,
      sentAt: null,
      attempts: Number(next.delivery && next.delivery.attempts || 0) + 1,
      lastAttemptAt: now, lastFailure: { code: mapped.code, message: mapped.message, at: now }
    }
    await db.collection(name).doc(event.eventId).set({ data: next })
    return next
  } catch (error) {
    console.error('[subscribe] 记录投递失败状态时出错（事件本身不受影响）', String(error && error.message || error))
    return null
  }
}

// 📥 站内消息中心（2026-10-06）：**与微信投递完全解耦**的一条独立写入。
//   ⛔ 顺序很重要：**先**让微信投递跑完（`delivery` 结果按 eventId 配对），**再**写站内消息。
//      ⇒ 每一条站内消息都能带上"**这一次微信到底发出去了没有**"的真实结果。
//   ⛔⛔ 但"发没发出去"**绝不影响**写不写：额度用完 / 被拒绝 / 模板没配 / 通道没开 ——
//      站内消息**一律照写**（这正是"不限次数、不漏消息"的唯一兜底）。
//   ⛔ 两个人的结果**各记各的**：`inbox.note()` 内部会按 actor / recipient 各生成一行。
async function writeInbox({ db, environment, events, inbox, delivery }) {
  const outcome = { environment, attempted: (events || []).length, written: 0, rows: [], failures: [] }
  if (!inbox || typeof inbox.note !== 'function') return outcome
  const byId = new Map()
  ;((delivery && delivery.results) || []).forEach(row => byId.set(String((row && row.eventId) || ''), row))
  for (const event of events || []) {
    const hit = byId.get(String((event && event.eventId) || '')) || null
    const wechat = hit
      ? { sent: hit.sent === true, code: String(hit.code || ''), message: String(hit.message || '') }
      : { sent: false, code: delivery ? 'WECHAT_NOT_ATTEMPTED' : 'WECHAT_CHANNEL_DISABLED', message: delivery ? '这一条微信没有尝试发送。' : '微信提醒通道未开通，站内消息照旧保存。' }
    try {
      const written = await inbox.note(event, wechat)
      outcome.written += Number((written && written.written) || 0)
      if (written && Array.isArray(written.rows)) outcome.rows = outcome.rows.concat(written.rows)
      if (written && Array.isArray(written.failures) && written.failures.length) outcome.failures = outcome.failures.concat(written.failures)
    } catch (error) {
      // ⛔ 站内消息写失败**绝不抛**：业务已经成功了（与 flush / deliverEvents 同一把尺）。
      console.error('[inbox] 写入兜底异常（业务已成功，不回滚）', String(error && error.message || error))
      outcome.failures.push({ code: 'INBOX_WRITE_CRASHED', message: String(error && error.message || error) })
    }
  }
  return outcome
}

// 📮 投递某个人**所有还没发出去**的事件（重试入口：只补失败的，成功过的不会再发）。
async function deliverPending({ db, environment, recipient, send, openIdFor, now, limit = 20 }) {
  const events = await notify.pending(db, environment, recipient, limit)
  const outcome = { environment, collection: notify.collectionFor(environment), attempted: events.length, sent: 0, skipped: 0, results: [] }
  for (const event of events) {
    const result = await deliverEvent({ db, environment, event, send, openIdFor, now })
    outcome.results.push(result)
    if (result.sent) outcome.sent += 1; else outcome.skipped += 1
  }
  return outcome
}

// 📮 投递一批**已知**事件（core.execute 在业务提交之后用它"顺手发一次"，省一个定时器）。
async function deliverEvents({ db, environment, events, send, openIdFor, now }) {
  const outcome = { environment, collection: notify.collectionFor(environment), attempted: (events || []).length, sent: 0, skipped: 0, results: [] }
  for (const event of events || []) {
    const result = await deliverEvent({ db, environment, event, send, openIdFor, now })
    outcome.results.push(result)
    if (result.sent) outcome.sent += 1; else outcome.skipped += 1
  }
  return outcome
}

module.exports = {
  CHANNEL, TEMPLATE_IDS, SUBJECT_OF, PAGE_OF,
  templateIdFor, configuredTypes, missingTypes,
  isSelfAction, messageOf, mapSendError,
  deliverEvent, deliverPending, deliverEvents, writeInbox,
  // ⭐ 转出模板真源，方便调用方（与测试）只 require 一处就能拿到 3 个模板的全部口径。
  templates
}
