// M3-P4 建立 · M3-P6 正式接线（2026-09-30）：会员「取消预约 / 修改时间」的**安全纯函数层**
//
// 这个文件只做四件事，一件都不越界：
//   ① 把"管理动作"表达成**结构完整的请求**（云端收的就是这个形状，字段白名单与云端逐字一致）；
//   ② 出网前自检（**只为了减少一次白跑**，⛔ 绝不是安全边界 —— 所有判定都在云端）；
//   ③ 把六条产品规则收成**具名扩展点**（`POLICY_DEFAULTS`，与云端 `MANAGE_POLICY` 逐字段相同）；
//   ④ 生成幂等号（连点 / 超时重发 ⇒ 同一个号 ⇒ 云端只落一条）。
//
// ✅【2026-09-30 M3-P6】取消 / 改期**已经正式开放**（用户定稿六条规则 + 云端命令已实现）：
//     · `release-flags.MEMBER_MANAGE_SUBMIT === true`（写链总闸已开）；
//     · `policyBlocked() === false`（六条规则已定）。
//   ⛔ 两道锁**仍然保留**：任何一道为真 ⇒ 零云调用。撤回规则用 `undecidePolicy()`，
//      关总闸改 `release-flags` 那一处 —— 两者都不需要改页面。
//   ⛔ 失败**绝不允许假成功**（词表 `FORBIDDEN_SUCCESS_WORDS` 仍在，有测试钉住）。
//
// ⛔ 身份与定位字段**一律不提交**：请求里只有 `bookingViewId`（服务端派生的不透明视图 ID）
//     + 必要的新时间参数。真实 bookingId / studentId / packageId / coachId 只在服务端解析。

const occupancy = require('./package-occupancy')
const view = require('./member-booking-view')
const create = require('./member-booking-request')
const { sha256 } = require('./sha256')

const ACTION = create.ACTION
const CANCEL_COMMAND = 'cancelMemberBooking'
const RESCHEDULE_COMMAND = 'rescheduleMemberBooking'
const MANAGE_COMMANDS = Object.freeze([CANCEL_COMMAND, RESCHEDULE_COMMAND])
// ⛔ 白名单：多一个键都不许出网（服务端将来照这张表收，前端别自作主张加字段）。
const CANCEL_PAYLOAD_KEYS = Object.freeze(['bookingViewId'])
const RESCHEDULE_PAYLOAD_KEYS = Object.freeze(['bookingViewId', 'date', 'hour', 'minute'])
const IDENTITY_KEYS = create.IDENTITY_KEYS
const FIXED_MINUTES = create.FIXED_MINUTES

// ------------------------------------------------------------------ §8 未定产品规则 ⇒ **具名扩展点**
//
// ✅【2026-09-30 M3-P6 · 用户已全部拍板】六条规则的**客户端孪生**。
//   ⛔ 权威来源是云端 `cloudfunctions/coachBusinessCommand/memberBooking.js` 的 `MANAGE_POLICY`；
//      这里必须**逐字段相同**，由 `m3-p6-member-manage-write` 的契约断言双向锁死（改一处不改另一处 ⇒ 测试红）。
//   ⛔ 仍然不许把这些规则散成各处 if —— 散下去就是"某个页面悄悄按了另一个值"。
const POLICY_POINTS = Object.freeze([
  { key: 'CANCEL_DEADLINE_MINUTES', question: '最晚提前多久可以取消' },
  { key: 'CANCEL_RELEASES_RESERVED', question: '取消后是否立即释放 reserved' },
  { key: 'CANCEL_COUNTS_AS_BREACH', question: '临时取消是否记违约' },
  { key: 'RESCHEDULE_MAX_TIMES', question: '改期是否限制次数' },
  { key: 'RESCHEDULE_NEEDS_COACH_CONFIRM', question: '改期是否需要教练确认' },
  { key: 'NOTIFY_ON_CHANGE', question: '是否发送订阅通知' }
])

// 已定稿的默认值（= 产品真实状态）：任何时间可取消 / 取消只释放 reserved / 不计违约 /
// 改期不限次数 / 不改期不需教练确认 / 必须通知另一方。
const POLICY_DEFAULTS = Object.freeze({
  CANCEL_DEADLINE_MINUTES: null,        // ⭐ null = **没有截止时间**（任何时间都能取消）
  CANCEL_RELEASES_RESERVED: true,
  CANCEL_COUNTS_AS_BREACH: false,
  RESCHEDULE_MAX_TIMES: Infinity,       // ⭐ 不限次数
  RESCHEDULE_NEEDS_COACH_CONFIRM: false,
  NOTIFY_ON_CHANGE: true
})

const POLICY_VALUES = {}
Object.keys(POLICY_DEFAULTS).forEach(key => { POLICY_VALUES[key] = POLICY_DEFAULTS[key] })

// 扩展点：改一条规则就调一次；传 `undefined` = 撤回到"未定"。
function setPolicyValue(key, value) {
  if (value === undefined) delete POLICY_VALUES[key]
  else POLICY_VALUES[key] = value
}
function policyValueOf(key) { return Object.prototype.hasOwnProperty.call(POLICY_VALUES, key) ? POLICY_VALUES[key] : null }
// ⭐ "已定"的判据是**有没有这个键**，不是"值是不是 null" —— 规则 1 与规则 4 的合法值就是 `null` / `Infinity`，
//   用 `== null` 判断会把"已经定好：任何时间都能取消"误读成"还没定"（那正是上一版的形状）。
function policyDecided(key) { return Object.prototype.hasOwnProperty.call(POLICY_VALUES, key) }
function openPolicyPoints() { return POLICY_POINTS.filter(point => !policyDecided(point.key)).map(point => point.key) }
// 恢复**已定稿**的默认值（产品真实状态）。⛔ 这不是"清空"。
function resetPolicy() { Object.keys(POLICY_VALUES).forEach(key => { delete POLICY_VALUES[key] }); Object.keys(POLICY_DEFAULTS).forEach(key => { POLICY_VALUES[key] = POLICY_DEFAULTS[key] }) }
// 只给测试 / 回滚用：撤回到"一条都没定"（写链立刻关闭）。
function undecidePolicy() { Object.keys(POLICY_VALUES).forEach(key => { delete POLICY_VALUES[key] }) }
// ⭐ 写链的**第二道锁**：还有未定规则 ⇒ 不许写。
function policyBlocked() { return openPolicyPoints().length > 0 }

// ------------------------------------------------------------------ 文案
const NOTICE_TITLE = '预约管理暂未开放'
const CANCEL_NOTICE = '取消预约功能暂未开放：这一版还不能自助取消，请直接联系你的教练帮你调整。'
const RESCHEDULE_NOTICE = '修改时间功能暂未开放：这一版还不能自助改期。可以先在这里选好新时间，再把时间告诉你的教练。'
// ⛔ 假成功词表：页面源码里**不许**出现这些字（出现就是"点了没写却说成功了"）。
const FORBIDDEN_SUCCESS_WORDS = Object.freeze(['取消成功', '修改成功', '改期成功', '预约已取消', '已经取消', '已为你改期', '已帮你改期'])

// ⭐ 2026-10-01 · 成功提示**统一**（只在服务端明确 `ok` 之后出现，简短、非阻塞）。
//   ⛔ 这三句话**不许**硬编码在页面里：页面源码被 `FORBIDDEN_SUCCESS_WORDS` 扫描，
//      而且文案必须只有一个地方能改 ⇒ 走常量。
//   ⛔ 不要再写「已改到新的时间」那种"像后台迟到通知"的说法。
const SUCCESS_TEXT = Object.freeze({ cancel: '预约已取消', reschedule: '时间更改成功' })

const FRIENDLY_MESSAGES = {
  BOOKING_NOT_MINE: '这条预约不在你的名单里。',
  BOOKING_NOT_FOUND: '这条预约已经不在了，下拉刷新看看。',
  BOOKING_NOT_MANAGEABLE: '只有「待上课」的预约才能取消或修改时间。',
  BOOKING_ALREADY_CANCELLED: '这节课已经取消了。',
  BOOKING_ALREADY_DONE: '这节课已经完成了，不能取消或改期。',
  MEMBER_CLAIM_NOT_FOUND: '还没有认领你的学员档案，暂时不能自助调整预约。',
  BOOKING_TIME_CONFLICT: '这个时间刚被占用了，换一个时间试试。',
  BOOKING_START_TOO_EARLY: occupancy.START_TOO_EARLY_MESSAGE,
  BOOKING_START_TOO_LATE: occupancy.START_TOO_LATE_MESSAGE,
  BOOKING_START_OFF_GRID: occupancy.START_OFF_GRID_MESSAGE,
  BOOKING_END_TOO_LATE: occupancy.END_TOO_LATE_MESSAGE,
  BOOKING_DATE_IN_PAST: '不能改到已经过去的时间。',
  MEMBER_BOOKING_BEYOND_WINDOW: `目前只能改到未来 ${occupancy.MEMBER_BOOKING_MAX_DAYS} 天内的时间，换一个更早的日期试试。`,
  PACKAGE_TEACHING_NOT_AUTHORIZED: '这位教练的授课授权已经变更，请重新选择教练或联系你的教练。',
  MEMBER_SERVICE_NOT_AUTHORIZED: '服务关系已经变更，暂时不能调整这节课。',
  PACKAGE_NO_REMAINING: '这个课时包已经没有剩余课时了。',
  PACKAGE_NO_AVAILABLE: '这个课时包的课时已经全部排满了。',
  MEMBER_MANAGE_POLICY_NOT_SELECTED: '取消与改期的规则还没定，暂时不能自助调整。',
  MEMBER_MANAGE_SUBMIT_DISABLED: '预约管理功能暂未开放。'
}

function friendlyMessageOf(code, fallback) {
  const known = FRIENDLY_MESSAGES[String(code || '')]
  if (known) return known
  const text = String(fallback == null ? '' : fallback).trim()
  return text || '这次调整没有完成，请稍后重试，或联系你的教练。'
}

// ------------------------------------------------------------------ 幂等号
// 与"创建预约"的 `mbk_` 命名空间分开 ⇒ 取消/改期的号永远不会和创建的号撞上。
function stableKeyOf(command, parts = {}) {
  const raw = [command, parts.bookingViewId, parts.date, parts.hour, parts.minute]
    .map(value => String(value == null ? '' : value)).join('|')
  return sha256(raw).slice(0, 24)
}

function requestIdFor(command, input = {}) {
  const nonce = String(input.nonce || '').replace(/[^A-Za-z0-9_-]/g, '') || 'n0'
  return `mbm_${stableKeyOf(command, input)}_${nonce}`
}

// ------------------------------------------------------------------ 校验
// ⛔ 这三条是客户端**能做**的硬校验；授权 / 余额 / 真正的冲突判定**只能在云端**（云端是终判）。
function ownProblemOf(bookingViewId, ownViewIds) {
  // ⭐ 非字符串（对象 / 数字 / 数组）也当"篡改"处理：`String({})` 会得到 `[object Object]`，
  //    那是一个**看起来像 id 的假值**，绝不能让它进名单比对。
  if (typeof bookingViewId !== 'string') return { code: 'INVALID_PAYLOAD', message: '预约标识不是合法的文本' }
  const id = bookingViewId.trim()
  if (!id) return { code: 'INVALID_PAYLOAD', message: '缺少预约标识' }
  const ids = Array.isArray(ownViewIds) ? ownViewIds.map(value => String(value == null ? '' : value)) : null
  // ⛔ 名单非空却不在名单里 ⇒ **明确拒绝**（不许"先发出去让云端判"——那是把越权请求放出去）。
  if (ids && ids.length && ids.indexOf(id) < 0) return { code: 'BOOKING_NOT_MINE', message: '这条预约不在你的名单里' }
  return null
}

function rowProblemOf(row, action) {
  if (!row) return null
  if (row.status === 'cancelled') return { code: 'BOOKING_ALREADY_CANCELLED', message: '这节课已经取消了' }
  if (!view.canManageOf(row)) {
    return { code: 'BOOKING_NOT_MANAGEABLE', message: action === 'cancel' ? '只有「待上课」的预约才能取消' : '只有「待上课」的预约才能修改时间' }
  }
  return null
}

// ⭐ 改期的时间判据**复用 occupancy 的同一条规则**（30 天 / 24:00），不在这里重抄一遍。
function slotProblemOf(slot, todayKey) {
  if (!slot) return { code: 'INVALID_PAYLOAD', message: '缺少新的时间' }
  if (slot.available === false) {
    if (slot.reason === 'past') return { code: 'BOOKING_DATE_IN_PAST', message: '这个时间已经过去了' }
    return { code: 'BOOKING_TIME_CONFLICT', message: '这个时间已经排了课' }
  }
  const start = Number(slot.start)
  if (!Number.isInteger(start) || start < 0 || start >= 24 * 60) return { code: 'INVALID_PAYLOAD', message: '时段起点不在当天之内' }
  const length = Number.isInteger(slot.end) ? slot.end - start : FIXED_MINUTES
  if (length <= 0) return { code: 'INVALID_PAYLOAD', message: '时段长度不合法' }
  // ⭐ 新课时间窗口（2026-10-02 三次口径）：**06:00–23:00 开课、每 30 分钟一档、且当天 24:00 前结束**。
  //   ⛔ 只看 `slot.start`，**不信** `slot.reason` —— 理由字符串是派生值，起点才是事实。
  //   ⛔ 结束也判：改期时这节课的时长可能不是 60（例如 90 分钟的课挪到 22:30 ⇒ 24:00 合法，
  //      挪到 23:00 ⇒ 次日 00:30 非法）。口径仍只在 occupancy 里有一份。
  const verdict = occupancy.startVerdictOf({ hour: Math.floor(start / 60), minute: start % 60 }, length)
  if (verdict === 'too-early') return { code: 'BOOKING_START_TOO_EARLY', message: occupancy.START_TOO_EARLY_MESSAGE }
  if (verdict === 'too-late') return { code: 'BOOKING_START_TOO_LATE', message: occupancy.START_TOO_LATE_MESSAGE }
  if (verdict === 'off-grid') return { code: 'BOOKING_START_OFF_GRID', message: occupancy.START_OFF_GRID_MESSAGE }
  if (verdict === 'end-too-late') return { code: 'BOOKING_END_TOO_LATE', message: occupancy.END_TOO_LATE_MESSAGE }
  return null
}

function dateProblemOf(dateKey, todayKey) {
  const date = String(dateKey == null ? '' : dateKey)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { code: 'INVALID_PAYLOAD', message: '日期不是 YYYY-MM-DD' }
  if (!String(todayKey || '')) return null
  // ⭐ 30 天只来自 `occupancy.memberBookingDateAllowed`（今天 = 第 0 天；+30 ✅ / +31 ⛔）。
  const verdict = occupancy.memberBookingDateAllowed(date, String(todayKey))
  if (verdict === 'past') return { code: 'BOOKING_DATE_IN_PAST', message: '这个日期已经过去了' }
  if (verdict === 'beyond') return { code: 'MEMBER_BOOKING_BEYOND_WINDOW', message: `最多只能改到未来 ${occupancy.MEMBER_BOOKING_MAX_DAYS} 天内` }
  return null
}

function collect(...problems) { return problems.filter(Boolean) }

function fail(errors) {
  return { ok: false, errors, code: errors.length ? errors[0].code : 'INVALID_PAYLOAD', requestId: '', command: '', action: ACTION, payload: null }
}

// ------------------------------------------------------------------ 请求构造
// ⭐ 幂等号 = 稳定键（命令 + 预约 + 参数）+ 会话 nonce：
//   · **同一会话**内连点两次 / 网络超时重发 ⇒ nonce 不变 ⇒ 同一个号 ⇒ 云端只落一条；
//   · 参数一变（换日期 / 换时段 / 换预约）⇒ 稳定键变 ⇒ 新号（不会错误 replay 上一次）；
//   · 关掉面板再开 ⇒ 页面换一个新的 nonce（`newNonce()`）⇒ 不会 replay 上一次的结果。
function newNonce() { return create.newNonce() }

function buildCancelRequest(options = {}) {
  const errors = collect(ownProblemOf(options.bookingViewId, options.ownViewIds), rowProblemOf(options.row, 'cancel'))
  if (errors.length) return fail(errors)
  const payload = { bookingViewId: String(options.bookingViewId).trim() }
  const requestId = options.requestId || requestIdFor(CANCEL_COMMAND, { ...payload, nonce: options.nonce })
  return { ok: true, errors: [], code: '', requestId, command: CANCEL_COMMAND, action: ACTION, payload }
}

function buildRescheduleRequest(options = {}) {
  const errors = collect(
    ownProblemOf(options.bookingViewId, options.ownViewIds),
    rowProblemOf(options.row, 'reschedule'),
    dateProblemOf(options.dateKey, options.todayKey),
    slotProblemOf(options.slot, options.todayKey)
  )
  if (errors.length) return fail(errors)
  const start = Number(options.slot.start)
  const payload = {
    bookingViewId: String(options.bookingViewId).trim(),
    date: String(options.dateKey),
    hour: Math.floor(start / 60),
    minute: start % 60
  }
  const requestId = options.requestId || requestIdFor(RESCHEDULE_COMMAND, { ...payload, nonce: options.nonce })
  return { ok: true, errors: [], code: '', requestId, command: RESCHEDULE_COMMAND, action: ACTION, payload }
}

// 请求里是否混进了身份/定位字段（**必须恒为空**）—— 直接复用创建通道那一份判据。
function identityKeysIn(request = {}) { return create.identityKeysIn(request) }

// payload 的键是否**只**在白名单里（多一个键就是越权企图）。
function extraKeysIn(command, payload = {}) {
  const allowed = command === RESCHEDULE_COMMAND ? RESCHEDULE_PAYLOAD_KEYS : command === CANCEL_COMMAND ? CANCEL_PAYLOAD_KEYS : []
  return Object.keys(payload).filter(key => allowed.indexOf(key) < 0)
}

module.exports = {
  ACTION, CANCEL_COMMAND, RESCHEDULE_COMMAND, MANAGE_COMMANDS,
  CANCEL_PAYLOAD_KEYS, RESCHEDULE_PAYLOAD_KEYS, IDENTITY_KEYS, FIXED_MINUTES,
  POLICY_POINTS, POLICY_DEFAULTS, setPolicyValue, resetPolicy, undecidePolicy,
  policyValueOf, policyDecided, openPolicyPoints, policyBlocked,
  NOTICE_TITLE, CANCEL_NOTICE, RESCHEDULE_NOTICE, FORBIDDEN_SUCCESS_WORDS, SUCCESS_TEXT, FRIENDLY_MESSAGES, friendlyMessageOf,
  stableKeyOf, requestIdFor, newNonce,
  buildCancelRequest, buildRescheduleRequest, identityKeysIn, extraKeysIn,
  slotProblemOf, dateProblemOf
}
