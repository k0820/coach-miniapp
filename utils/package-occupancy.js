// M2 课时占用规则 —— **本机口径**（2026-09-26）。
//
// ⚠️ 这是 `cloudfunctions/coachBusinessCommand/occupancy.js` 的本机孪生文件。
//    云函数目录**不能** require 本项目 utils（云端只上传各自目录），所以同一套规则有两份。
//    两份必须逐字同口径 —— 由永久测试 `m2-occupancy-contract.test.js` 用同一组样本双向比对，
//    改任何一份都必须两边一起改，否则测试会红。
//
// 三个值（与云端完全一致）：
//   remaining        真实剩余课时（人工维护，唯一权威余额）
//   reserved         已被有效预约占用、尚未结算的课时数（统一计数器，不分谁创建）
//   availableToBook  max(remaining − reserved, 0)，**派生值，绝不落库**
//
// 待确认（pending）：仍然 booked + 有 plannedMinutes + 超过「预计结束 + 3 小时」。
//   ⚠️ 老 booking 没有 plannedMinutes ⇒ 返回 null ⇒ **不参与**待确认规则（不补默认值）。

const DEFAULT_PLANNED_MINUTES = 60
const PENDING_GRACE_MINUTES = 180
const RESERVED_VERSION = 2
const MINUTE_MS = 60000
const OUTSTANDING_STATUS = 'booked'

// ⭐ 2026-10-01 业务口径（**当日第二次变更**：1.3.5 真机体验后产品定稿，**取消 23:30 开课**）——
//   ⛔ 本条**再取代**同日早些时候那条「23:30 是最后一档」的口径：
//      跨午夜课程**不再作为 MVP 能力**提供 ⇒ 课表也不再画次日「接上节」片段（见 utils/schedule-view.js）。
//
//   ① 每天最早开课 **06:00**（2026-10-03 用户定稿：教练新建与会员自助**同一条规则**）；
//   ② 起始时间**步长 30 分钟**（06:00 / 06:30 / 07:00 / 07:30 …）；
//   ③ 当天**最后一个开课时间 23:00**（23:00 + 60 分钟 ⇒ **24:00 结束，正好卡在当天界上** ✅）；
//   ④ ⛔ **已经存在**的 23:30 跨午夜课程**不是非法数据**：不删、不改、不迁移，
//      仍可从开始日的卡片打开详情，并**照旧占用**次日 00:00–00:30（谁也不能在那段时间排新课）。
//      上面这几条只是**不再允许新建 / 改期出**这种课 —— 闸门管的是"入口"，不是"存量"。
//
//   ⛔ 判据挂在「**开始时间**」上，**不再**挂在「结束时间」上 ——
//      旧口径那个「结束不得晚于 24:00」的阈值常量已被用户最新规则明确取代（已**删除**，不是保留），
//      继续保留它会把 23:00 这一节（23:00+60=24:00，合法的最后一节）判成非法。
//
//   ⭐ 2026-10-03（第四次变更）：最早开课从 07:00 **提前到 06:00**，并且**教练端也受这条约束**。
//      ⛔ 上一版刻意给教练端留了"补录通道不判最早"的口子（好把真实上过的凌晨课录进来）。
//         用户 2026-10-03 要求"教练新建课程与会员自助预约最早都为 06:00"⇒ 口子关闭，
//         `lessonWindowGateOf()` 现在也会拦"开始过早"（与会员端的 `startVerdictOf` 同一条常量）。
//      ✅ 只关"入口"：**存量** 00:00–05:59 的历史课不删、不改、不迁移；
//         课表的「凌晨段条件渲染」原样保留（有课才出现、可展开、可收起）。
//
//   📌 为什么三个值都收在这里：改口径就是改这三行 —— 这正是当初坚持把阈值收成单点的原因
//      （散在各处的数字改不干净）。本文件与 cloudfunctions/coachBusinessCommand/occupancy.js 是**孪生**，
//      常量 / 文案 / 公式必须逐字相同（由 m2-occupancy-contract 双向比对锁死）。
const EARLIEST_START_MINUTES = 6 * 60
const SLOT_STEP_MINUTES = 30
const LATEST_START_MINUTES = 23 * 60
const EARLIEST_START_LABEL = '06:00'
const LATEST_START_LABEL = '23:00'
const SLOT_STEP_LABEL = '30 分钟'
const START_WINDOW_MESSAGE = '每天 06:00–23:00 可以开课，每 30 分钟一个起始时间。'
const START_TOO_EARLY_MESSAGE = '每天最早 06:00 开课，请选择 06:00 或更晚的时间。'
const START_TOO_LATE_MESSAGE = '每天最晚 23:00 开课，请选择 23:00 或更早的时间。'
const START_OFF_GRID_MESSAGE = '开课时间请选在整点或半点（每 30 分钟一档）。'

// ⭐ 2026-10-02 业务口径（**第三次变更**：堵掉"不再画跨午夜片段"留下的缺口）——
//   ⛔ 本条**补充**（不是取代）上面的二次口径：只钉「开始 ≤ 23:00」留了一个洞 ——
//      **23:00 + 90 分钟 = 次日 00:30**，它开始时间合法、但结束跨了午夜；
//      而课表**不再画**次日片段 ⇒ 会造出一节"看不见却占用着时间"的课（比显示出来更糟）。
//
//   ① **开始**不晚于 23:00（二次口径，不变）；
//   ② **结束**不晚于当天 24:00（本次新增）—— 两条**同时**满足才放行。
//      · 23:00 + 60 ⇒ 24:00 ✅（正好卡在当天界上）
//      · 23:00 + 90 ⇒ 次日 00:30 ⛔
//      · 22:30 + 90 ⇒ 24:00 ✅（开始更早，换来的时长）
//   ③ ⛔ **存量**的 23:30 跨午夜旧课**不是非法数据**：不删、不改、不迁移，
//      仍可从开始日卡片打开详情，并**照旧占用**次日 00:00–00:30。
//      闸门管的是"入口"（新建 / 预约 / 改期），碰不到存量。
//
//   📌 两个阈值都收在这里，两端孪生由 `m2-occupancy-contract` 双向比对锁死。
const DAY_END_MINUTES = 24 * 60
const END_TOO_LATE_MESSAGE = '课程必须在当天 24:00 前结束，请把开课时间提前或缩短课程时长。'

function reservedOf(pkg) {
  const value = Number(pkg && pkg.reserved)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function remainingOf(pkg) {
  const value = Number(pkg && pkg.remaining)
  return Number.isFinite(value) ? value : 0
}

function availableToBook(pkg, reservedOverride) {
  const reserved = Number.isInteger(reservedOverride) ? reservedOverride : reservedOf(pkg)
  return Math.max(remainingOf(pkg) - reserved, 0)
}

function occupancyOf(pkg, reservedOverride) {
  const remaining = remainingOf(pkg), reserved = Number.isInteger(reservedOverride) ? reservedOverride : reservedOf(pkg)
  return { remaining, reserved, availableToBook: Math.max(remaining - reserved, 0) }
}

// ------------------------------------------------------------------ ⭐ 已取消预约的**唯一口径**
//
// 【为什么会有这一段】2026-10-01 真机事故：
//   会员自助取消**保留**这行预约（`status='cancelled'`）—— 这是用户拍板的产品规则
//   （教练端自己取消是物理删除，两条通道形状不同，但都是"取消"）。
//   于是教练那本账里第一次出现了 `cancelled` 行，而**没有一个消费端认识它**：
//     · 教练课表把它渲染成「待上」的课（真机：会员取消了，教练端 18:00 那节还在）；
//     · 学员详情把它列进"还没上的课"；
//     · 会员端历史页签直接叫「已完成」⇒ 已取消被当成已完成计数（16→17）。
//   ⛔ 这三处事故是**同一个根因**：「这条预约算不算一节要上的课 / 算不算已完成」没有唯一答案。
//
// ⇒ 从今往后，**任何页面**都不许自己写 `status === 'cancelled'` / `status !== 'done'` 这类判断，
//   一律来问下面这两个函数。云端孪生是 `cloudfunctions/coachBusinessCommand/occupancy.js`
//   （那里 `blocksTimeSlot` 与这两个函数同义：已取消不占时段、也不算已完成）。
const CANCELLED_STATUS = 'cancelled'
const DONE_STATUS = 'done'
// 这节课**已被取消**（不再上、不再占时段、不许完课）。
function isCancelled(booking) { return String((booking && booking.status) || '') === CANCELLED_STATUS }
// 这节课**真的上过了**（只有 `done` 才算 —— 已取消 / 未到场都不是"已完成"）。
function countsAsCompleted(booking) { return String((booking && booking.status) || '') === DONE_STATUS }

// 本机版"数有效预约"：state.bookings 是数组（取消 = 从数组移除，完成 = status 改 done）。
function countOutstanding(state, packageId) {
  return (state && Array.isArray(state.bookings) ? state.bookings : []).filter(booking => booking.packageId === packageId && booking.status === OUTSTANDING_STATUS).length
}

// 惰性初始化：与云端同口径 —— 先数（含本次涉及的那条）→ 再改状态 → 再 ±1。
function syncReserved(state, pkg) {
  if (Number(pkg && pkg.reservedVersion) === RESERVED_VERSION) return reservedOf(pkg)
  const counted = countOutstanding(state, pkg.id)
  pkg.reserved = counted
  pkg.reservedVersion = RESERVED_VERSION
  return counted
}

function applyDelta(state, pkg, delta) {
  const current = syncReserved(state, pkg)
  pkg.reserved = Math.max(current + delta, 0)
  pkg.reservedVersion = RESERVED_VERSION
  return pkg.reserved
}

function plannedMinutesOf(booking) {
  if (!booking) return null
  const value = Number(booking.plannedMinutes)
  if (!Number.isInteger(value) || value <= 0 || value > 1440) return null
  return value
}

function normalizePlannedMinutes(value) {
  if (value == null || value === '') return DEFAULT_PLANNED_MINUTES
  const minutes = Number(value)
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) throw new Error('INVALID_PLANNED_MINUTES')
  return minutes
}

// ------------------------------------------------------------------ 最晚 24:00 结束（同一套公式，两端共用）
//
// 结束分钟（当天内的偏移，不跨日）= 开始分钟 + 预计时长。
// ⚠️ 时长缺失/非法时**按默认 60 兜底** —— 这里是**准入闸**，与「待确认」性质不同，别混：
//    · 待确认是**派生展示状态** ⇒ 不补默认值（否则历史老预约一夜之间全变成"待确认"）；
//    · 24:00 结束是**准入闸** ⇒ 不兜底就等于放行（老预约改期能挪到 23:30，规则被绕过）。
function startMinutesOf(moment) {
  const hour = Number(moment && moment.hour), minute = Number(moment && moment.minute || 0)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  return hour * 60 + minute
}

function plannedEndMinutes(moment, plannedMinutes) {
  const start = startMinutesOf(moment)
  if (start == null) return null
  const minutes = Number.isInteger(plannedMinutes) && plannedMinutes > 0 ? plannedMinutes : DEFAULT_PLANNED_MINUTES
  return start + minutes
}

// ⛔ 二次口径（2026-10-01）曾把「结束不得晚于 24:00」删掉 —— 三次口径（2026-10-02）**把它加回来**，
//    因为只钉开始时间留了个洞：23:00 + 90 ⇒ 次日 00:30（详见下面 `lessonWindowGateOf` 的说明）。
//    ⛔ 注意区别：这次它不是**取代**"开始 ≤ 23:00"，而是与它**同时**成立。

function startsAfterLatest(moment) {
  const start = startMinutesOf(moment)
  return start != null && start > LATEST_START_MINUTES
}

function startsBeforeEarliest(moment) {
  const start = startMinutesOf(moment)
  return start != null && start < EARLIEST_START_MINUTES
}

function offStartGrid(moment) {
  const start = startMinutesOf(moment)
  return start != null && start % SLOT_STEP_MINUTES !== 0
}

// ------------------------------------------------------------------ ⭐⭐ 新课的时间闸（所有写入口的**唯一**判据）
//
// ⛔ 规则（2026-10-02 三次口径）：**开始 ≤ 23:00** 且 **结束 ≤ 当天 24:00**，两条同时满足才放行。
//    少判第二条 ⇒ 23:00 起 90 分钟的课会跨到次日 00:30，而课表不再画次日片段
//    ⇒ 结果是"看不见但占用着"（比显示出来更糟）。
//
// 📌 为什么收成一个函数：六个入口（会员预约 / 教练新建 / 改期 / 跨教练共享码 / 跨教练授权 /
//    分享可约）**全部**只问这一个地方。任何一处漏判，都只会体现在"改这一行却只改了一半"上。
function endsAfterDayEnd(moment, plannedMinutes) {
  const end = plannedEndMinutes(moment, plannedMinutes)
  return end != null && end > DAY_END_MINUTES
}

// 返回 `null` ⇒ 放行；否则返回 `{ code, message }`，调用方直接 `throw commandError(...)`。
//   ⛔ 判**开始**优先于判**结束**：23:45 这种先告诉用户"开课太晚"，比"会跨到明天"更贴他要改的东西。
//   ⭐ 2026-10-03：开始过早也在这里拦（教练端与会员端同一条规则，最早 06:00）。
function lessonWindowGateOf(moment, plannedMinutes) {
  if (startsBeforeEarliest(moment)) return { code: 'BOOKING_START_TOO_EARLY', message: START_TOO_EARLY_MESSAGE }
  if (startsAfterLatest(moment)) return { code: 'BOOKING_START_TOO_LATE', message: START_TOO_LATE_MESSAGE }
  if (endsAfterDayEnd(moment, plannedMinutes)) return { code: 'BOOKING_END_TOO_LATE', message: END_TOO_LATE_MESSAGE }
  return null
}

// ⛔ 旧语义是"按结束时间倒推的开始上界"，已随口径变更去掉时长参数。
function latestStartMinutes() {
  return LATEST_START_MINUTES
}

// ------------------------------------------------------------------ 时段卡片的**三态唯一口径**
//
// 2026-10-02 · 三态时段小卡片 教练端「新建课程」弹层 ↔ 会员端「约课时段」共用这一条规则。
//   ⛔ 为什么必须共用：两边各写一份优先级，就会出现"教练看到可约、会员看到已排课"
//      这种两边打架的形状 —— 本项目对"两套口径"是零容忍（见项目铁律）。
//   三态取值：'' (可约) / 'past' (已过时间) / 'booked' (已排课)。
//   ⛔ 优先级 **past 先于 booked**：这一格时间已经过去了，就不再关心它当时忙不忙。
//      这是会员端 `member-booking-view.slotsFor()` 的既有行为，**原样保留**，不是新定的。
function slotStateOf(options) {
  const o = options || {}
  const start = Number.isInteger(o.start) ? o.start : null
  if (start == null) return ''
  const length = Number.isInteger(o.length) && o.length > 0 ? o.length : DEFAULT_PLANNED_MINUTES
  const end = start + length
  const dateKey = String(o.dateKey || '')
  const today = String(o.todayKey || '')
  const nowMinutes = Number.isInteger(o.nowMinutes) ? o.nowMinutes : null
  if (nowMinutes != null && dateKey && dateKey === today && start <= nowMinutes) return 'past'
  const busy = Array.isArray(o.busy) ? o.busy : []
  if (busy.some(range => start < range.end && end > range.start)) return 'booked'
  return ''
}

// 三态 → 卡片上那几个字（⛔ 同一个词表，教练端 / 会员端显示逐字相同）
const SLOT_STATE_TEXT = { past: '已过时间', booked: '已排课', '': '可约' }
function slotStateTextOf(state) { return SLOT_STATE_TEXT[state] || SLOT_STATE_TEXT[''] }

function startVerdictOf(moment, plannedMinutes) {
  const start = startMinutesOf(moment)
  if (start == null) return 'invalid'
  if (start < EARLIEST_START_MINUTES) return 'too-early'
  if (start > LATEST_START_MINUTES) return 'too-late'
  if (start % SLOT_STEP_MINUTES !== 0) return 'off-grid'
  // 会员自助 / 会员改期这类用 verdict 的入口也走同一条规则（不传时长 ⇒ 按默认 60 兜底）。
  if (endsAfterDayEnd(moment, plannedMinutes)) return 'end-too-late'
  return 'ok'
}

// ------------------------------------------------------------------ 跨午夜区间（冲突检测的唯一正确算法）
//
// ⛔ 旧冲突检测里 `booking.date !== moment.date ⇒ return false`（**只比同一天**）。
//    一旦允许 23:30 → 次日 00:30，这一条会直接漏判 ⇒ 必须按**真实时间区间**判定。
function absoluteStartMinutes(dateKey, hour, minute) {
  const dayMs = dateKeyToMs(dateKey)
  if (dayMs == null) return null
  const h = Number(hour), m = Number(minute == null ? 0 : minute)
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null
  return dayMs / 60000 + h * 60 + m
}

function intervalOf(row) {
  if (!row) return null
  const start = absoluteStartMinutes(row.date, row.hour, row.minute)
  if (start == null) return null
  const minutes = plannedMinutesOf(row)
  return { start, end: start + (minutes == null ? DEFAULT_PLANNED_MINUTES : minutes) }
}

// 半开区间 ⇒ 首尾相接**不算**冲突（23:00–24:00 与次日 00:00–01:00 相邻不重叠）。
function intervalsOverlap(a, b) {
  if (!a || !b) return false
  return a.start < b.end && b.start < a.end
}

function startMs(booking) {
  if (!booking) return null
  const parts = String(booking.date || '').split('-')
  if (parts.length !== 3) return null
  const year = Number(parts[0]), month = Number(parts[1]), day = Number(parts[2])
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  const hour = Number(booking.hour), minute = Number(booking.minute || 0)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  const at = new Date(year, month - 1, day, hour, minute, 0, 0)
  return Number.isFinite(at.getTime()) ? at.getTime() : null
}

function plannedEndMs(booking) {
  const minutes = plannedMinutesOf(booking), start = startMs(booking)
  if (minutes == null || start == null) return null
  return start + minutes * MINUTE_MS
}

function isPendingConfirmation(booking, nowMs) {
  if (!booking || booking.status !== OUTSTANDING_STATUS) return false
  const end = plannedEndMs(booking)
  if (end == null) return false
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  return now > end + PENDING_GRACE_MINUTES * MINUTE_MS
}

function pendingStateOf(booking, nowMs) {
  if (!booking || booking.status !== OUTSTANDING_STATUS) return 'none'
  return isPendingConfirmation(booking, nowMs) ? 'pending' : 'scheduled'
}

// 教练端/会员端展示用的口径：剩余 / 已预约 / 还可预约（reserved=0 时前端可省略"已预约"那半句）。
function displayOf(pkg) {
  const { remaining, reserved, availableToBook } = occupancyOf(pkg)
  return { remaining, reserved, availableToBook, showReserved: reserved > 0 }
}

// ⭐⭐ M3-P3（2026-09-30 由用户定稿）：会员自助预约**最多只能约未来 30 天**。
//   全项目**只有这一处**定义 30（云端与本机的孪生由 `m2-occupancy-contract` 双向比对锁死）
//   ⇒ 改口径就是改这一行，页面 / 云端 / 客户端预检全部跟着变，不会散出第二套 30。
//   口径：以**北京时间**"今天"为第 0 天 ⇒ 今天 ✅ / 今天+30 ✅ / 今天+31 ⛔ / 过去 ⛔。
//   ⛔ 服务端是**最终真相源**（事务内再判一次）；客户端那份只是"少白跑一趟"的预检。
const MEMBER_BOOKING_MAX_DAYS = 30
const MEMBER_BOOKING_WINDOW_MESSAGE = '目前只能预约未来 30 天内的课程，换一个更早的日期试试。'
const DAY_MS = 24 * 60 * 60 * 1000
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

function dateKeyToMs(key) {
  if (!DATE_KEY.test(String(key || ''))) return null
  const [year, month, day] = String(key).split('-').map(Number)
  const ms = Date.UTC(year, month - 1, day)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null
  return ms
}

function msToDateKey(ms) {
  const at = new Date(ms)
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`
}

// 按**天**加减（日历语义，跨月跨年都不出错；⛔ 不许把 `+30*86400000` 的心算写法散在各处）。
function addDateDays(key, amount) {
  const ms = dateKeyToMs(key)
  if (ms == null || !Number.isInteger(amount)) return ''
  return msToDateKey(ms + amount * DAY_MS)
}

function memberBookingWindowOf(todayKey) {
  const from = dateKeyToMs(todayKey) == null ? '' : String(todayKey)
  return { from, to: addDateDays(todayKey, MEMBER_BOOKING_MAX_DAYS), maxDays: MEMBER_BOOKING_MAX_DAYS }
}

// 返回 'ok' | 'past' | 'beyond' | 'invalid'（⛔ 不返回布尔值：三种拒绝要给用户三句不同的话）。
function memberBookingDateAllowed(dateKey, todayKey) {
  const target = dateKeyToMs(dateKey), today = dateKeyToMs(todayKey)
  if (target == null || today == null) return 'invalid'
  if (target < today) return 'past'
  if (target > today + MEMBER_BOOKING_MAX_DAYS * DAY_MS) return 'beyond'
  return 'ok'
}

module.exports = {
  DEFAULT_PLANNED_MINUTES, PENDING_GRACE_MINUTES, RESERVED_VERSION, OUTSTANDING_STATUS, CANCELLED_STATUS, DONE_STATUS,
  isCancelled, countsAsCompleted,
  EARLIEST_START_MINUTES, SLOT_STEP_MINUTES, LATEST_START_MINUTES,
  EARLIEST_START_LABEL, LATEST_START_LABEL, SLOT_STEP_LABEL,
  START_WINDOW_MESSAGE, START_TOO_EARLY_MESSAGE, START_TOO_LATE_MESSAGE, START_OFF_GRID_MESSAGE,
  DAY_END_MINUTES, END_TOO_LATE_MESSAGE, endsAfterDayEnd, lessonWindowGateOf,
  reservedOf, remainingOf, availableToBook, occupancyOf,
  countOutstanding, syncReserved, applyDelta,
  plannedMinutesOf, normalizePlannedMinutes, startMs, plannedEndMs, isPendingConfirmation, pendingStateOf, displayOf,
  plannedEndMinutes, startMinutesOf, startsAfterLatest, startsBeforeEarliest, offStartGrid, startVerdictOf,
  latestStartMinutes, absoluteStartMinutes, intervalOf, intervalsOverlap,
  slotStateOf, slotStateTextOf,
  MEMBER_BOOKING_MAX_DAYS, MEMBER_BOOKING_WINDOW_MESSAGE, DAY_MS,
  dateKeyToMs, msToDateKey, addDateDays, memberBookingWindowOf, memberBookingDateAllowed
}
