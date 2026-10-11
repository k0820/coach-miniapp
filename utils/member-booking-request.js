// M3-P2 · 会员预约**请求构造器**（纯函数：不碰 wx、不碰云端、⛔ 零写入）
//
// 这个文件只做三件事：
//   ① 把页面里选好的「日期 / 时段 / 教练 / 课时包」拼成**服务端要求的那一个请求结构**；
//   ② 出网前先自检一遍（**只为了减少一次白跑**，⛔ 绝不是安全边界 —— 所有判定都在云端）；
//   ③ 生成**稳定幂等号**（同一个确认会话里重复提交 ⇒ 同一个号 ⇒ 云端只落一条预约）。
//
// ⛔ 三条硬约束（改这个文件前先读）：
//   · 客户端**只能**提交服务端派生的不透明标识：`coachKey` / `packageViewId`；
//     身份（memberId）与定位（studentId / packageId / coachId / 账本）**一律不提交** ⇒ 由服务端推导。
//   · 幂等号在**一次确认会话内**保持不变（连点两次 / 网络超时重发都是同一个号）；
//     关掉弹层再打开 ⇒ 换新号（否则取消后重新约同一时段会被旧号"重放"成上一次的结果）。
//   · 真实提交链已于 **M3-P3（2026-09-30）** 打开（`release-flags.MEMBER_BOOKING_SUBMIT = true`）：
//     点确认会真的发一次 `createMemberBooking`；总闸一旦关回去，则只弹"暂未开放"、**零云调用**。

const occupancy = require('./package-occupancy')
const { sha256 } = require('./sha256')

const ACTION = 'memberBooking'
const COMMAND = 'createMemberBooking'
const PAYLOAD_KEYS = Object.freeze(['coachKey', 'packageViewId', 'date', 'hour', 'minute', 'plannedMinutes'])
// ⛔ 这些字段只要出现在请求里就是**伪造身份/越权**的企图（服务端口同样会拒，这里先自检一遍）。
const IDENTITY_KEYS = Object.freeze(['memberId', 'studentId', 'coachId', 'packageId', 'ownerCoachId', 'datasetId', 'documentId', 'openId', 'OPENID', 'openid', '_openid', '_id', 'teachingCoachId', 'place'])

const FIXED_MINUTES = occupancy.DEFAULT_PLANNED_MINUTES
// ⛔ 总闸被关掉时（回滚用）**必须明说还没开放**，绝不做"看起来成功"的假提交。
const SUBMIT_NOTICE_TITLE = '预约提交暂未开放'
const SUBMIT_NOTICE = '预约提交暂未开放：这一版还不能自助提交，请把选好的时间告诉教练，让教练帮你排课。'
// ✅ 真实成功才能说这句（服务端返回 ok 才算）。
const SUCCESS_TITLE = '预约成功'
const SUCCESS_TEXT = '已经帮你排好这一节课，去「我的预约」里可以看到。'
const FAIL_TITLE = '预约没有成功'

const pad = value => String(value).padStart(2, '0')

function stableKeyOf(input = {}) {
  const parts = [input.coachKey, input.packageViewId, input.date, input.hour, input.minute]
  return sha256(parts.map(value => String(value == null ? '' : value)).join('|')).slice(0, 24)
}

// 一次"确认会话"一个号：连点两次确认、网络超时后重发 ⇒ 同一个号 ⇒ 云端幂等只落一条。
// 关掉弹层再打开 ⇒ 调用方重新取号（`newNonce()`）⇒ 取消后重约同一时段不会被旧号重放。
function newNonce() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.replace(/[^a-z0-9]/gi, '').slice(-10).toLowerCase()
}

function requestIdFor(input = {}) {
  const nonce = String(input.nonce || '').replace(/[^A-Za-z0-9_-]/g, '') || 'n0'
  return `mbk_${stableKeyOf(input)}_${nonce}`
}

// 出网前自检：返回问题清单（空数组 = 结构完整）。
// ⛔ 只用于"少白跑一趟"与给用户说清原因，**绝不代替云端判定**（云端那一份才是闸门）。
function problemsOf(options = {}) {
  const problems = []
  const date = String(options.dateKey || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push('日期不是 YYYY-MM-DD')
  else if (String(options.todayKey || '')) {
    // ⭐ 规则 4（未来 30 天）：客户端**预检**（30 来自 occupancy，不在这里写死）。
    //   ⛔ 只是"少白跑一趟"，服务端事务内还有一次终判。
    const verdict = occupancy.memberBookingDateAllowed(date, options.todayKey)
    if (verdict === 'past') problems.push('这个日期已经过去了')
    if (verdict === 'beyond') problems.push(`最多只能预约未来 ${occupancy.MEMBER_BOOKING_MAX_DAYS} 天内的课程`)
  }
  const slot = options.slot || null
  const start = slot && Number.isInteger(slot.start) ? slot.start : null
  if (start == null) problems.push('缺少时段起点')
  else {
    if (start < 0 || start >= 24 * 60) problems.push('时段起点不在当天之内')
    const length = Number.isInteger(slot.end) ? slot.end - start : FIXED_MINUTES
    if (length !== FIXED_MINUTES) problems.push('一节课固定 60 分钟')
    // ⭐ 新课时间窗口（2026-10-02 三次口径）：**06:00–23:00 开课、每 30 分钟一档、且当天 24:00 前结束**。
    //   ⛔ 23:00 开始、24:00 结束是**合法**的（正好卡在当天界上）；
    //   ⛔ 23:30 这一档**已取消**（2026-10-01 二次口径）；存量的 23:30 旧课不动它，不受影响。
    //   ⛔ 三条判据都来自 occupancy —— 这里一行都不许自己写 24:00 / 23:00 这种数字。
    const verdict = occupancy.startVerdictOf({ hour: Math.floor(start / 60), minute: start % 60 }, length)
    if (verdict === 'too-early') problems.push(occupancy.START_TOO_EARLY_MESSAGE)
    if (verdict === 'too-late') problems.push(occupancy.START_TOO_LATE_MESSAGE)
    if (verdict === 'off-grid') problems.push(occupancy.START_OFF_GRID_MESSAGE)
    if (verdict === 'end-too-late') problems.push(occupancy.END_TOO_LATE_MESSAGE)
  }
  if (!String(options.coachKey || '').trim()) problems.push('缺少授课教练标识')
  if (!String(options.packageViewId || '').trim()) problems.push('缺少课时包标识')
  return problems
}

function buildBookingRequest(options = {}) {
  const problems = problemsOf(options)
  if (problems.length) return { ok: false, errors: problems, requestId: '', command: COMMAND, payload: null }
  const slot = options.slot
  const start = slot.start
  const payload = {
    coachKey: String(options.coachKey).trim(),
    packageViewId: String(options.packageViewId).trim(),
    date: String(options.dateKey),
    hour: Math.floor(start / 60),
    minute: start % 60,
    plannedMinutes: Number.isInteger(slot.end) ? slot.end - start : FIXED_MINUTES
  }
  const requestId = options.requestId || requestIdFor({ ...payload, nonce: options.nonce })
  return { ok: true, errors: [], requestId, command: COMMAND, action: ACTION, payload }
}

// 请求里是否混进了身份/定位字段（**必须恒为空**）。
function identityKeysIn(request = {}) {
  const found = []
  const walk = (value, path) => {
    if (!value || typeof value !== 'object') return
    Object.keys(value).forEach(key => {
      if (IDENTITY_KEYS.includes(key)) found.push(path ? `${path}.${key}` : key)
      walk(value[key], path ? `${path}.${key}` : key)
    })
  }
  walk(request.payload || {}, 'payload')
  Object.keys(request || {}).forEach(key => { if (IDENTITY_KEYS.includes(key)) found.push(key) })
  return [...new Set(found)]
}

// 会员能看懂的中文提示：权限变化 / 余额 / 时间被抢 / 超过 30 天必须**分开说**
// （⛔ 一句"提交失败"会让会员反复重试，而且不知道该换时间还是换教练）。
// ⛔ 判定永远在服务端；这里只是把服务端**没带文案**的情况补成一句人话（服务端 message 优先）。
const FRIENDLY_MESSAGES = {
  MEMBER_CLAIM_NOT_FOUND: '还没有你的学员档案，暂时不能自助约课。请让教练先帮你建档。',
  COACH_NOT_AVAILABLE: '这位教练还不能给你约课，请让管理你课时的教练先授权。',
  PACKAGE_TEACHING_NOT_AUTHORIZED: '这位教练的授课授权已经变更，请重新选择教练或联系你的教练。',
  MEMBER_SERVICE_NOT_AUTHORIZED: '服务关系已经变更，暂时不能在这位教练这里约课。',
  PACKAGE_NOT_AVAILABLE_FOR_MEMBER: '这份课时包不可用，或不属于你。',
  PACKAGE_NO_REMAINING: '这个课时包已经没有剩余课时了。',
  PACKAGE_NO_AVAILABLE: '这个课时包的课时已经全部排满了，先上完一节再来约。',
  BOOKING_TIME_CONFLICT: '这个时间刚被占用了，换一个时间试试。',
  BOOKING_START_TOO_EARLY: occupancy.START_TOO_EARLY_MESSAGE,
  BOOKING_START_TOO_LATE: occupancy.START_TOO_LATE_MESSAGE,
  BOOKING_START_OFF_GRID: occupancy.START_OFF_GRID_MESSAGE,
  BOOKING_END_TOO_LATE: occupancy.END_TOO_LATE_MESSAGE,
  BOOKING_DATE_IN_PAST: '不能预约已经过去的时间。',
  MEMBER_BOOKING_BEYOND_WINDOW: `目前只能预约未来 ${occupancy.MEMBER_BOOKING_MAX_DAYS} 天内的课程，换一个更早的日期试试。`,
  REQUEST_ID_CONFLICT: '这次预约的信息变了，请重新选择时间后再提交。',
  REVISION_CONFLICT: '教练课表刚更新过，请重新选择时间后再提交。',
  MEMBER_BOOKING_RESULT_UNKNOWN: '预约结果待确认，请勿重复提交。',
  MEMBER_BOOKING_SUBMIT_DISABLED: SUBMIT_NOTICE,
  MEMBER_BOOKING_SUBMITTING: '正在提交，请不要重复点击。'
}

function friendlyMessageOf(code, fallback) {
  const known = FRIENDLY_MESSAGES[String(code || '')]
  if (known) return known
  const text = String(fallback == null ? '' : fallback).trim()
  return text || '预约没有成功，请稍后重试，或把选好的时间告诉教练。'
}

function timeTextOf(start) {
  if (!Number.isInteger(start)) return ''
  return `${pad(Math.floor(start / 60))}:${pad(start % 60)}`
}

module.exports = {
  ACTION, COMMAND, PAYLOAD_KEYS, IDENTITY_KEYS, FIXED_MINUTES,
  SUBMIT_NOTICE_TITLE, SUBMIT_NOTICE, SUCCESS_TITLE, SUCCESS_TEXT, FAIL_TITLE, FRIENDLY_MESSAGES,
  stableKeyOf, newNonce, requestIdFor, problemsOf, buildBookingRequest, identityKeysIn, timeTextOf,
  friendlyMessageOf
}
