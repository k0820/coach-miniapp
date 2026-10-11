// M2 课时占用规则 —— **云端唯一权威来源**（2026-09-26）。
//
// 三个值，全项目只有这一处定义：
//   remaining        会员真实剩余课时（人工维护，唯一权威余额，允许人工改，不强制 = total − used）
//   reserved         已被「有效预约」占用、但尚未最终结算的课时数
//   availableToBook  max(remaining − reserved, 0) —— 当前还能预约几节，**派生值，绝不落库**
//
// ⚠️ 两条铁律（写给下一个改这个文件的人）：
//  ① `availableToBook` 只算不存。它一旦落库就成了"第二套余额"，M2 其余规则全部失效。
//  ② `reserved` 是**统一计数器**：不分谁创建的预约、不分这条预约存在哪个 (ownerCoachId, datasetId)，
//     只要它还是一条"有效预约"就占 1 节。**不存在"旧预约一套算法、共享预约另一套算法"**。
//
// 惰性初始化（零迁移的关键）：
//   历史 package 没有 reserved / reservedVersion。第一次被任何占用命令触碰时，
//   在**同一事务内**把 reserved 设为"当前有效预约条数"，并打上 reservedVersion = 2。
//   之后一律增量 ±1。⇒ 不需要全量 Migration，也不需要批量改写历史数据。
//
// ⚠️ 顺序铁律：**先数 → 再改状态 → 再 ±1**。
//    若先把 booking 改成 done / 先删掉 booking 再数，就会少数一条（典型 off-by-one 事故）。

const DEFAULT_PLANNED_MINUTES = 60
const PENDING_GRACE_MINUTES = 180
const RESERVED_VERSION = 2
const MINUTE_MS = 60000

// ⭐ 2026-10-01 业务口径（**当日第二次变更**：1.3.5 真机体验后产品定稿，**取消 23:30 开课**）——
//   ⛔ 本条**再取代**同日早些时候的"最后一个开课时间 23:00"：
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
//         课表的「凌晨段条件渲染」原样保留。
//
//   📌 为什么三个值都收在这里：改口径就是改这三行 —— 这正是当初坚持把阈值收成单点的原因
//      （散在各处的数字改不干净）。本文件与 utils/package-occupancy.js 是**孪生**，
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

// 有效预约：仍然占着一节课、还没结算的预约。旧模型里只有 'booked' 一种
// （教练端取消 = 删除整条文档；完成 = 改成 'done'；待确认 = 仍是 'booked'）。
const OUTSTANDING_STATUS = 'booked'

// ⭐⭐ M3-P6（2026-09-30 用户定稿）：**会员自助取消要保留这条预约的历史**（不物理删除）。
//   ⇒ 从这一刻起，`bookings` 里会出现 `status === 'cancelled'` 的行 —— 这是一个**新状态**，
//      而新状态最容易出的错是"没人把它从旧判据里排除掉"。
//   ⛔ 关键判据：**已取消的课不再占用时间**。
//      少了这一条，会员取消之后**约不回原来那个时间**（冲突检测还看得见那条行）⇒
//      表现是"取消成功了，但那个时段永远说已排课"，用户只会以为取消没生效。
//   ⚠️ 只排除 `cancelled`：`done` 的既有口径**一个字不动**（历史课仍按原样参与冲突判定）。
//      改 `done` 就是改 M1/M2 的既有语义，不属本轮范围。
const CANCELLED_STATUS = 'cancelled'
function blocksTimeSlot(booking) { return String((booking && booking.status) || '') !== CANCELLED_STATUS }

function reservedOf(pkg) {
  const value = Number(pkg && pkg.reserved)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function remainingOf(pkg) {
  const value = Number(pkg && pkg.remaining)
  return Number.isFinite(value) ? value : 0
}

// ⭐ 唯一公式。第二个参数允许传入"已经算好的 reserved"，避免重复读库。
function availableToBook(pkg, reservedOverride) {
  const reserved = Number.isInteger(reservedOverride) ? reservedOverride : reservedOf(pkg)
  return Math.max(remainingOf(pkg) - reserved, 0)
}

function occupancyOf(pkg, reservedOverride) {
  const remaining = remainingOf(pkg), reserved = Number.isInteger(reservedOverride) ? reservedOverride : reservedOf(pkg)
  return { remaining, reserved, availableToBook: Math.max(remaining - reserved, 0) }
}

// 数"当前有效预约"条数 —— 只在惰性初始化时用一次。必须在改动 booking 之前调用。
async function countOutstanding(bookings, packageId) {
  const list = await bookings.list({ packageId })
  return list.filter(row => {
    const booking = row && row.data && typeof row.data === 'object' ? row.data : row || {}
    return booking.packageId === packageId && booking.status === OUTSTANDING_STATUS
  }).length
}

// 惰性初始化：返回"当前 reserved"（已含本次涉及的那条预约，因为调用点在改动 booking 之前）。
async function syncReserved(business, pkg) {
  if (Number(pkg && pkg.reservedVersion) === RESERVED_VERSION) return reservedOf(pkg)
  const counted = await countOutstanding(business.collection('bookings'), pkg.id)
  pkg.reserved = counted
  pkg.reservedVersion = RESERVED_VERSION
  return counted
}

// 统一出口：先同步（必要时初始化），再施加增量，并把结果写回 pkg（调用方负责 set）。
async function applyDelta(business, pkg, delta) {
  const current = await syncReserved(business, pkg)
  pkg.reserved = Math.max(current + delta, 0)
  pkg.reservedVersion = RESERVED_VERSION
  return pkg.reserved
}

// ------------------------------------------------------------------ 课程时长 / 待确认
//
// plannedMinutes：这节课**预约时确定的**预计时长快照，落库在 booking 上。
//   新预约默认 60；老 booking 没有这个字段 ⇒ **不参与**"超时待确认"规则（用户明确要求：不补默认值）。
// 预计结束时间 = 开始时间 + plannedMinutes；进入待确认 = 预计结束时间 + 3 小时。
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

// ------------------------------------------------------------------ 开课时间窗口（同一套公式，两端共用）
//
// 开始分钟（当天内的偏移，不跨日）= hour * 60 + minute。
function startMinutesOf(moment) {
  const hour = Number(moment && moment.hour), minute = Number(moment && moment.minute || 0)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  return hour * 60 + minute
}

// 结束分钟（**当天内偏移，可以 > 1440** ⇒ 那就是跨到了次日）。
// ⚠️ 时长缺失/非法时按默认 60 兜底 —— 这里是**准入闸**，与「待确认」性质不同，别混。
function plannedEndMinutes(moment, plannedMinutes) {
  const start = startMinutesOf(moment)
  if (start == null) return null
  const minutes = Number.isInteger(plannedMinutes) && plannedMinutes > 0 ? plannedMinutes : DEFAULT_PLANNED_MINUTES
  return start + minutes
}

// ⛔ 二次口径（2026-10-01）曾把「结束不得晚于 24:00」删掉 —— 三次口径（2026-10-02）**把它加回来**，
//    因为只钉开始时间留了个洞：23:00 + 90 ⇒ 次日 00:30（详见下面 `lessonWindowGateOf` 的说明）。
//    ⛔ 注意区别：这次它不是**取代**"开始 ≤ 23:00"，而是与它**同时**成立。

// 唯一判据：开始时间是不是晚于 23:00。创建 / 改期 / 任何入口都必须过这一条。
// ⛔ 这条闸管的是**入口**（能不能新开 / 改成这个点），**不审判存量**：
//    已经存在的 23:30 跨午夜课不会经过这里 ⇒ 它照旧合法、照旧占用次日 00:00–00:30。
function startsAfterLatest(moment) {
  const start = startMinutesOf(moment)
  return start != null && start > LATEST_START_MINUTES
}

// 最早开课闸门（06:00，2026-10-03 起）。⛔ 教练端（lessonWindowGateOf）与会员端（startVerdictOf）**同一条**。
//   上一版这里写的是"只用于未来预约通道 —— 历史补录不过这一条"，用户 2026-10-03 要求入口统一 ⇒ 该口子关闭。
//   ✅ 只关入口：**存量** 00:00–05:59 的历史课不删、不改、不迁移（闸门管的是入口，不是存量）。
function startsBeforeEarliest(moment) {
  const start = startMinutesOf(moment)
  return start != null && start < EARLIEST_START_MINUTES
}

// 步长闸门：起始时间必须落在 30 分钟网格上（整点 / 半点）。
function offStartGrid(moment) {
  const start = startMinutesOf(moment)
  return start != null && start % SLOT_STEP_MINUTES !== 0
}

// ⭐ 未来预约的**唯一入口判据**（会员预约 / 会员改期共用）：
//   返回 'ok' | 'invalid' | 'too-early' | 'too-late' | 'off-grid' —— ⛔ 不返回布尔值：
//   四种拒绝要给用户四句不同的话，"不行"两个字等于没说。
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

// 给 UI 用：最晚开课分钟（23:00）。小时列 / 选择器用它算上界 ⇒ UI 与云端同一条公式，
//   不会再出现"前端能选、云端拒绝"。⛔ 旧语义是"按结束时间倒推的开始上界"，已随口径变更去掉时长参数。
function latestStartMinutes() {
  return LATEST_START_MINUTES
}

// ------------------------------------------------------------------ 跨午夜区间（冲突检测的唯一正确算法）
//
// ⛔ 为什么必须引入"绝对分钟轴"：旧冲突检测里 `booking.date !== moment.date ⇒ return false`，
//    也就是**只比同一天**。一旦允许 23:30 → 次日 00:30，这一条会直接漏判：
//      · 10-01 23:30–00:30  与  10-02 00:00–01:00  真重叠，但日期字段不同 ⇒ 旧算法说"没冲突"。
//    必须按**真实时间区间**判定，不能因为日期字段不同就漏掉。
//
// 绝对分钟 = 该日期的"天序号 × 1440" + 当天分钟偏移（时区无关，只用于相对比较）。
function absoluteStartMinutes(dateKey, hour, minute) {
  const dayMs = dateKeyToMs(dateKey)
  if (dayMs == null) return null
  const h = Number(hour), m = Number(minute == null ? 0 : minute)
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null
  return dayMs / 60000 + h * 60 + m
}

// 一条预约在绝对分钟轴上的真实占用区间 [start, end)。
function intervalOf(row) {
  if (!row) return null
  const start = absoluteStartMinutes(row.date, row.hour, row.minute)
  if (start == null) return null
  const minutes = plannedMinutesOf(row)
  return { start, end: start + (minutes == null ? DEFAULT_PLANNED_MINUTES : minutes) }
}

// 区间相交（半开区间 ⇒ 首尾相接**不算**冲突：23:00–24:00 与次日 00:00–01:00 相邻不重叠）。
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

// 「待确认」是**派生状态**，不落库、不需要定时任务：
//   仍然 booked + 有 plannedMinutes + 已超过（预计结束 + 3 小时）⇒ 待确认。
//   待确认**继续占用 reserved**，不自动扣课、不自动退课、不产生收入、不自动判缺席。
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
  DEFAULT_PLANNED_MINUTES, PENDING_GRACE_MINUTES, RESERVED_VERSION, OUTSTANDING_STATUS,
  CANCELLED_STATUS, blocksTimeSlot,
  EARLIEST_START_MINUTES, SLOT_STEP_MINUTES, LATEST_START_MINUTES,
  EARLIEST_START_LABEL, LATEST_START_LABEL, SLOT_STEP_LABEL,
  START_WINDOW_MESSAGE, START_TOO_EARLY_MESSAGE, START_TOO_LATE_MESSAGE, START_OFF_GRID_MESSAGE,
  DAY_END_MINUTES, END_TOO_LATE_MESSAGE, endsAfterDayEnd, lessonWindowGateOf,
  reservedOf, remainingOf, availableToBook, occupancyOf,
  countOutstanding, syncReserved, applyDelta,
  plannedMinutesOf, normalizePlannedMinutes, startMs, plannedEndMs, isPendingConfirmation, pendingStateOf,
  plannedEndMinutes, startMinutesOf, startsAfterLatest, startsBeforeEarliest, offStartGrid, startVerdictOf,
  latestStartMinutes, absoluteStartMinutes, intervalOf, intervalsOverlap,
  MEMBER_BOOKING_MAX_DAYS, MEMBER_BOOKING_WINDOW_MESSAGE, DAY_MS,
  dateKeyToMs, msToDateKey, addDateDays, memberBookingWindowOf, memberBookingDateAllowed
}
