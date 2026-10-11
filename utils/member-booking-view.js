// M3 P1 · 会员端预约视图（**纯函数**：不碰 wx、不碰云端、不写任何数据）
//
// 这一层只做一件事：把**已经读到的**会员数据翻译成"界面上要显示的那些话"。
// 它不做任何写入，也不做任何"补全"——
//   ⭐ 缺字段一律显示「未记录」，**绝不用当前时间顶替历史课程时间**（这是 §124 定下的铁律）。
//
// 时间口径与教练端同源（`utils/package-occupancy.js` 是云端 occupancy.js 的孪生）：
//   · ⭐ 2026-10-01 二次口径（1.3.5 真机后定稿，**取消 23:30 开课**）：
//     **每天 06:00–23:00 开课，每 30 分钟一个起始时间**，**23:00 是当天最后一个开课时间**
//     （23:00 + 60 ⇒ **24:00 结束，正好卡在当天界上** ✅）。
//   · ⛔ 判据挂在「**开始**」上，不再挂在「结束」上（旧口径"结束不得超 24:00"已被取代）。
//   · ⛔ 三个值全部取自 occupancy —— 写死数字就会出现两套口径。
//   · ⛔ **存量**的 23:30 跨午夜课（1.3.5 之前约的）仍然合法存在：这里只是**不再生成** 23:30 这一格，
//      那条旧课本身不会被删、不会被改，照旧占用次日 00:00–00:30。
//
// 跨午夜分钟的显示：**存量旧课**的结束可能是 1470 分钟（= 次日 00:30），
//   `Math.min(end, 24*60)` 会把它压成 "24:00" ⇒ 会员看到的是错的结束时间。统一走 `crossMinuteText()`。

const occupancy = require('./package-occupancy')
const beijingDate = require('./beijing-date')

const UNRECORDED = '未记录'

// ─────────────────────────────────────────────────────────────────────────────
// ⭐⭐ 2026-10-06 真机（空壳学员 0 课时包 + 约课页混入历史教练）之后新增的**档案维度**
//
// ⛔ 根因（服务端已经把 `archiveId` 下发给每一份课包，但客户端从来没用它隔离）：
//   · `data.coaches` = 这位会员**所有认领档案**的教练**并集**（服务端不按档案分）；
//   · `data.packages[]` 每行才带 `archiveId` ⇒ 客户端只按 `coachKey` 过滤 ⇒
//     历史档案的教练与课包被一起带进当前档案的预约页。
//
// ⇒ 规则（本文件是**唯一**出口，页面不许再各写一遍 filter）：
//   ① **教练必须同时属于当前档案**：先由当前档案的课包算出"这份档案真正可用的 coachKey 集合"，
//      再用它去筛 `coaches`。⛔ 绝不直接把整份 `coaches` 丢给界面；
//   ② **课时包必须属于当前档案**：`packagesForCoach` 增加第三个参数 `archiveId`；
//   ③ **没有当前档案（多份但还没选）⇒ 一个教练都不给**（⛔ 绝不退化成"全部教练"，
//      那正是"混入历史档案"的形状）；由页面提示"请先选择当前使用的训练档案"；
//   ④ **老云端兼容**：当前档案有课包但**一行 coachKeys 都没有**（退化投影）⇒ 不缩名单
//      （⛔ 为了兼容把画面清空，比显示错更糟：界面说没教练，其实有）。
// ─────────────────────────────────────────────────────────────────────────────
const NO_COACH_FOR_ARCHIVE = '这份训练档案暂时没有可预约的教练'
const NO_PACKAGE_FOR_ARCHIVE = '这位学员还没有课时包，请联系教练创建'
const NEED_ARCHIVE_CHOICE = '请先选择当前使用的训练档案'

// ⭐⭐⭐ 2026-10-06 真机回归（1.3.20 体验版）修的**共同根因**
//
// ⛔ 真机症状：会员档案「测试1」、教练 A 早就建好了剩余 > 0 的课时包，1.3.18 认领后能正常显示，
//    1.3.20 的约课确认页却写「暂无可用课时包」，点确认弹「先选好教练和可用的课时包」。
//
// ⛔ 根因不在"过滤太严"，而在**档案归属这条链断了一次**：
//     服务端下发 packages[]（每行**都带** archiveId）
//       → `packagesForArchive()` 按 archiveId 精确筛（✅ 对的）
//       → `usablePackages()` 把每行**重新投影成视图对象**，而这次投影**没有带上 archiveId**
//       → `packagesForCoach()` 又按 archiveId 精确筛 ⇒ 全部落空 ⇒ 课包"凭空消失"。
//    ⇒ 换句话说：不是历史档案混进来了，而是**当前档案自己的课包被自己筛掉了**。
//
// ⛔ 治本做法：档案归属只准有**一个**出口（`archiveScopeOf` / `belongsToArchive`），
//    三处过滤（packagesForArchive / packagesForCoach / coachesForArchive）全部走它 ⇒ 不可能再各写一套。
//    ⛔ 并且投影（`usablePackages`）**必须把归属字段带过去** —— 断一次就是真机阻断级事故。
//
// 三条判定规则（顺序即优先级）：
//   ① **有 archiveId ⇒ 直接精确匹配**（服务端不透明下发，最可信，老行为不变）；
//   ② **没有 archiveId ⇒ 只允许「服务端可信三项」兜底**：
//      `ownerCoachId + datasetId + studentId` **三项全部**等于当前档案那三项才算数；
//      ⛔ 缺任一项 / 任一项不等 ⇒ **不认**；
//      ⛔ **绝不**只按 coachKey 兜底 —— 同一位教练可以同时带多名学员
//         （本次真机就是「教练A + 测试1」这个形状，只按教练猜会把别人的课时包放出来）；
//   ③ **整份名单一行 archiveId 都没有**（老云端还没下发这个字段）⇒ **不缩名单**，
//      与 `coachesForArchive` 的老云端退化同一口径：为了兼容把画面清空，比显示错更糟
//      （界面说没课包，其实有）。

const DAY_START_MINUTES = occupancy.EARLIEST_START_MINUTES
// ⛔ 终点 = **最晚开课时间**（不是最晚结束时间），必须取自 occupancy（口径只有一份）。
const LATEST_START_MINUTES = occupancy.LATEST_START_MINUTES
const SLOT_STEP_MINUTES = occupancy.SLOT_STEP_MINUTES
const DAY_MINUTES = 24 * 60

// 跨午夜分钟的显示：≤ 24:00 照常（24:00 仍写 24:00，与历史文案一致）；
//   > 24:00 ⇒ 减去一天后显示（1470 ⇒ "00:30"）。
const crossMinuteText = total => total <= DAY_MINUTES ? minuteText(total) : minuteText(total - DAY_MINUTES)
const WEEK_NAMES = ['日', '一', '二', '三', '四', '五', '六']

// ⭐⭐ 规则 4（未来 30 天）：**客户端这一侧也不许写死 30**。
//   30 只定义在 `occupancy.MEMBER_BOOKING_MAX_DAYS`（云端与本机孪生同口径），
//   日期选项 = 今天（第 0 天）…今天+30 天 ⇒ 共 `MAX + 1` 个选项。
//   ⛔ 客户端这份只是"别让用户选完再被服务端拒"；服务端仍然是最终真相源。
const MEMBER_BOOKING_MAX_DAYS = occupancy.MEMBER_BOOKING_MAX_DAYS
const MEMBER_DATE_COUNT = MEMBER_BOOKING_MAX_DAYS + 1

const pad = value => String(value).padStart(2, '0')
const minuteText = total => `${pad(Math.floor(total / 60))}:${pad(total % 60)}`

function dateTextOf(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return UNRECORDED
  const parts = beijingDate.dateParts(key)
  if (!parts || !Number.isFinite(parts.month)) return UNRECORDED
  return `${parts.month}月${parts.day}日 周${WEEK_NAMES[parts.weekday] || ''}`
}

function startMinutesOf(row) {
  if (!row) return null
  // ⚠️ `Number(null) === 0`（不是 NaN！）⇒ 缺 hour 会被算成 00:00，那是**凭空生成一个时间**。
  //    必须先挡掉 null / '' / 非数字，再转 Number。
  if (row.hour == null || row.hour === '') return null
  const hour = Number(row.hour), minute = Number(row.minute == null ? 0 : row.minute)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

// 时长有三个来源，按"谁更可信"排序：**显式 plannedMinutes > 记录里的 duration > 没有**。
// ⛔ 取不到就返回 null（⇒ 显示「未记录」），**绝不**拿默认 60 冒充这节课当时上了多久。
//    （60 是准入闸的兜底值，不是历史事实 —— 见 PROJECT_MEMORY §124。）
function lengthMinutesOf(row) {
  const planned = occupancy.plannedMinutesOf(row)
  if (planned != null) return planned
  const duration = Number(row && row.duration)
  if (Number.isInteger(duration) && duration > 0 && duration <= 1440) return duration
  return null
}

function endMinutesOf(row) {
  const start = startMinutesOf(row), length = lengthMinutesOf(row)
  if (start == null || length == null) return null
  return start + length
}

function startTextOf(row) {
  const start = startMinutesOf(row)
  return start == null ? UNRECORDED : minuteText(start)
}

function endTextOf(row) {
  const end = endMinutesOf(row)
  return end == null ? UNRECORDED : crossMinuteText(end)
}

function durationTextOf(row) {
  const length = lengthMinutesOf(row)
  return length == null ? UNRECORDED : `${length} 分钟`
}

function timeTextOf(row) {
  const start = startMinutesOf(row), end = endMinutesOf(row)
  if (start == null && end == null) return UNRECORDED
  if (start != null && end != null) return `${minuteText(start)}–${crossMinuteText(end)}`
  return start != null ? `${minuteText(start)} 开始（时长${UNRECORDED}）` : `结束 ${crossMinuteText(end)}`
}

// ⭐ M3-P2-2 · 详情弹层首屏的**主信息**用这一条（比 `timeTextOf` 干净）：
//   有结束时间 ⇒ `10:00–11:00 · 60 分钟`；只有开始 ⇒ `10:00 开始`；都没有 ⇒ 「未记录」。
//   ⛔ 目的：不再把「结束时间：未记录」「课程时长：未记录」当**内容**摆给会员看 ——
//     那是后台数据清单的写法。**没记录就不显示这一项**，而不是显示一句"没记录"。
function compactTimeTextOf(row) {
  const start = startMinutesOf(row), end = endMinutesOf(row)
  if (start == null && end == null) return UNRECORDED
  if (start != null && end != null) return `${minuteText(start)}–${crossMinuteText(end)}`
  return start != null ? `${minuteText(start)} 开始` : `结束 ${crossMinuteText(end)}`
}
function timeLineTextOf(row) {
  const span = compactTimeTextOf(row), length = lengthMinutesOf(row)
  if (span === UNRECORDED) return length == null ? UNRECORDED : `${length} 分钟`
  return length == null ? span : `${span} · ${length} 分钟`
}

// M3-P4 · 状态的**唯一口径**（⛔ 缺字段 / 认不出 ⇒ 「未记录」，绝不猜成"待上课"）。
//   · `booked` 是唯一**可管理**（可取消 / 可改期）的状态；
//   · `done` / `cancelled` / `noshow` 都是**终态** ⇒ 进历史、不出现管理按钮。
const MANAGEABLE_STATUS = 'booked'
const TERMINAL_STATUSES = Object.freeze(['done', 'cancelled', 'noshow'])
const KNOWN_STATUSES = Object.freeze([MANAGEABLE_STATUS].concat(TERMINAL_STATUSES))

function statusTextOf(row) {
  const status = row && row.status
  if (status === 'done') return '已完成'
  if (status === 'cancelled') return '已取消'
  if (status === 'noshow') return '未出席'
  if (status === 'booked') return '待上课'
  return UNRECORDED
}

function isTerminalOf(row) { return TERMINAL_STATUSES.indexOf(row && row.status) >= 0 }
// ⛔ 只有 `booked` 才给按钮：`cancelled` 再次取消、`done` 改期都是越权动作。
function canManageOf(row) { return !!(row && row.status === MANAGEABLE_STATUS) }

// ------------------------------------------------------------------ 状态发生时间（历史排序 / 「完成于 · 取消于」）
//
// ⭐ 2026-10-01 真机反馈：「历史」按**课程原定时间**倒序 ⇒ 看不懂（取消的课混在中间）。
//    ⇒ 改为按**状态发生那一刻**倒序（最新操作排最前）。
//
// ⛔ 铁律（与 §124「缺字段一律显示未记录」同源）：**没有可靠时间就不显示，也不许拿别的时刻冒充**。
//   取值链（用户定稿）：已完成 ⇒ `completedAt`；已取消 ⇒ `cancelledAt`；
//   都没有 ⇒ `updatedAt` ⇒ 课程原定开始时刻（只参与排序）。
//   ⛔「完成于 / 取消于」这两句话**只有拿到对应的那一个字段**才显示 ——
//     兜底出来的时刻**绝不**写成「完成于」（那是伪造历史）。
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

// 时间戳归一化：数字毫秒 / 可解析的日期字符串 ⇒ number；其余一律 null（⛔ 绝不返回 0 冒充"有"）。
function timestampOf(value) {
  if (value == null || value === '') return null
  const num = Number(value)
  if (Number.isFinite(num)) return num > 0 ? num : null
  const at = Date.parse(String(value))
  return Number.isFinite(at) && at > 0 ? at : null
}

// 课程原定开始时刻（北京时间）：`date` + `hour/minute`。取不到 ⇒ null。
function scheduledAtOf(row) {
  const date = String((row && row.date) || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const base = Date.parse(`${date}T00:00:00+08:00`)
  if (!Number.isFinite(base)) return null
  const start = startMinutesOf(row)
  return base + (start == null ? 0 : start) * 60 * 1000
}

// 排序键：**状态发生那一刻**（已取消 ⇒ cancelledAt，已完成 ⇒ completedAt，都没有 ⇒ updatedAt ⇒ 原定时间）。
// ⛔ 取不到 ⇒ `-Infinity`（排最后），**绝不**用 `Date.now()` 顶替（那会让"没记录"的课永远排在最前）。
function statusAtOf(row) {
  if (!row) return null
  const status = String(row.status || '')
  if (status === 'cancelled') return timestampOf(row.cancelledAt) || timestampOf(row.updatedAt) || scheduledAtOf(row) || -Infinity
  if (status === 'done') return timestampOf(row.completedAt) || timestampOf(row.updatedAt) || scheduledAtOf(row) || -Infinity
  return timestampOf(row.updatedAt) || scheduledAtOf(row) || -Infinity
}
function historyOrderOf(row) { return statusAtOf(row) }

// ⛔ 只有**真的拿到了那一刻**才返回文本：`done` ⇒ completedAt；`cancelled` ⇒ cancelledAt。
//   兜底（updatedAt / 原定时间）**不产生**任何"完成于 / 取消于"文案。
function eventAtTextOf(row) {
  if (!row) return ''
  const status = String(row.status || '')
  const at = status === 'done' ? timestampOf(row.completedAt)
    : status === 'cancelled' ? timestampOf(row.cancelledAt) : null
  if (at == null) return ''
  const moment = new Date(at + BEIJING_OFFSET_MS)
  const month = moment.getUTCMonth(), day = moment.getUTCDate()
  if (!Number.isFinite(month) || !Number.isFinite(day)) return ''
  const label = status === 'done' ? '完成于' : '取消于'
  return `${label} ${pad(month + 1)}-${pad(day)} ${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}`
}

// ------------------------------------------------------------------ 历史筛选（⛔ 只影响"看哪几条"，绝不改业务数据）
const HISTORY_FILTERS = Object.freeze(['all', 'done', 'cancelled'])
const HISTORY_FILTER_LABELS = Object.freeze({ all: '全部', done: '已完成', cancelled: '已取消' })

function filterHistory(rows, filter) {
  const list = Array.isArray(rows) ? rows : []
  const key = String(filter || 'all')
  if (key === 'all') return list.slice()
  return list.filter(row => row && String(row.status || '') === key)
}
function historyCountsOf(rows) {
  const list = Array.isArray(rows) ? rows : []
  const countOf = status => list.filter(row => row && String(row.status || '') === status).length
  return { all: list.length, done: countOf('done'), cancelled: countOf('cancelled') }
}

function coachNameOf(coach) {
  const name = coach && coach.displayName
  return typeof name === 'string' && name.trim() ? name.trim() : UNRECORDED
}

function typeTextOf(row) {
  const value = String((row && (row.typeName || row.category)) || '')
  return value.trim() ? value.trim() : UNRECORDED
}

// ------------------------------------------------------------------ 学员档案（claim）辨认（**纯展示**）
//
// ⭐ 2026-10-01：一位会员可能认领**多份**学员档案。课包 / 预约混在一张列表里时，
//    必须能一眼看出"这条属于哪份档案" ⇒ 用服务端下发的**不透明** `archiveId` 换成档案名。
//
// ⛔ 只有一份档案 ⇒ 返回**空表** ⇒ 界面一句档案名都不多显示（单档案用户体验与改造前逐字相同）。
//    （"每多一份档案就多一行字"是对多档案用户的补偿，不该变成单档案用户的噪音。）
function archiveNameIndex(rows) {
  const list = Array.isArray(rows) ? rows.filter(row => row && row.archiveId) : []
  const ids = [...new Set(list.map(row => String(row.archiveId)))]
  if (ids.length < 2) return {}
  const index = {}
  list.forEach(row => {
    const id = String(row.archiveId), name = String(row.name || '').trim()
    if (name && !index[id]) index[id] = name
  })
  return index
}
function archiveTextOf(row, archivesById = {}) {
  const id = String((row && row.archiveId) || '')
  if (!id) return ''
  const name = archivesById && archivesById[id]
  return typeof name === 'string' && name.trim() ? name.trim() : ''
}

// 课包名：**只认服务端给的 packageViewId 与课包名单对上的那一个**。
// ⛔ 对不上 / 根本没有 ⇒ 「未记录」。绝不拿"第一个课包"或"默认课包"顶替（那是猜）。
function packageTextOf(row, packagesById = {}) {
  const id = String((row && row.packageViewId) || '')
  if (!id) return UNRECORDED
  const name = packagesById && packagesById[id]
  return typeof name === 'string' && name.trim() ? name.trim() : UNRECORDED
}

// 一节课的完整展示视图（列表项与详情页共用同一份 ⇒ 不会出现"列表一个说法、详情另一个说法"）。
// `packagesById` = `{ packageViewId: typeName }`（页面从同一帧的课包名单里建，不额外读）。
function bookingView(row, packagesById = {}, archivesById = {}) {
  const source = row || {}
  // ⛔ 只算一次：排序用的那一刻（含兜底）与展示用的文案（**只有真拿到了才非空**）分开，
  //    绝不能"因为排得出来就顺手显示一句完成于"。
  const eventAtText = eventAtTextOf(source)
  return {
    historyId: source.historyId || '',
    // ⭐ 这条预约属于哪份学员档案（多档案才有值；单档案恒为空 ⇒ 界面不显示）
    archiveText: archiveTextOf(source, archivesById),
    hasArchive: !!archiveTextOf(source, archivesById),
    status: KNOWN_STATUSES.indexOf(source.status) >= 0 ? source.status : '',
    statusText: statusTextOf(source),
    canManage: canManageOf(source),
    // ⭐ 状态发生那一刻（排序依据，`-Infinity` = 真没记录）
    eventAt: historyOrderOf(source),
    // ⛔ 兜底出来的时刻**不显示** ⇒ 会员看到的每一句"完成于 / 取消于"背后都是真字段。
    eventAtText,
    hasEventAt: !!eventAtText,
    date: String(source.date || ''),
    dateText: dateTextOf(source.date),
    startText: startTextOf(source),
    endText: endTextOf(source),
    timeText: timeTextOf(source),
    // ⭐ M3-P2-2：详情弹层首屏用的干净版时间行（不出现「未记录」当内容）。
    timeLineText: timeLineTextOf(source),
    durationText: durationTextOf(source),
    // ⭐ 次要字段的"到底有没有值"⇒ 页面据此决定**渲不渲染**，而不是渲染一句「未记录」。
    hasEnd: endTextOf(source) !== UNRECORDED,
    hasDuration: durationTextOf(source) !== UNRECORDED,
    hasType: typeTextOf(source) !== UNRECORDED,
    hasPackage: packageTextOf(source, packagesById) !== UNRECORDED,
    hasSummary: !!String(source.memberSummary || '').trim(),
    coachName: coachNameOf(source.coach),
    coachKey: String((source.coach && source.coach.coachKey) || ''),
    typeText: typeTextOf(source),
    packageViewId: String(source.packageViewId || ''),
    packageText: packageTextOf(source, packagesById),
    summary: String(source.memberSummary || '')
  }
}

// 待上课 / 历史：**同一条数据分两栏**，不是两份副本。
// ⛔ 分栏只看 `isTerminal`：**终态一律进历史**，不认识的 status 留在待上课（保守，不丢数据）。
//
// ⭐ 2026-10-01 真机反馈改的排序口径：
//   · **待上课**：仍然按课程原定时间**升序**（最近一节在最前）—— ⛔ 这条不许动（用户要求 ⑧）。
//   · **历史**：改按**状态发生那一刻倒序**（最新完成 / 最新取消排最前）；
//     那一刻取不到 ⇒ 退回课程原定时间；再取不到 ⇒ 排最后（⛔ 绝不拿"现在"冒充）。
//     ⛔ 排序键相等时用 historyId 兜底 ⇒ 顺序**稳定**（不会每次进页面跳来跳去）。
function splitBookings(rows, packagesById = {}, archivesById = {}) {
  const list = Array.isArray(rows) ? rows : []
  const upcoming = list.filter(row => row && !isTerminalOf(row))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || (startMinutesOf(a) || 0) - (startMinutesOf(b) || 0))
    .map(row => bookingView(row, packagesById, archivesById))
  const history = list.filter(row => row && isTerminalOf(row))
    .sort((a, b) => {
      const left = historyOrderOf(b), right = historyOrderOf(a)
      if (left !== right) return left - right              // -Infinity === -Infinity ⇒ 相等，落到下面比 id
      return String((a && a.historyId) || '').localeCompare(String((b && b.historyId) || ''))
    })
    .map(row => bookingView(row, packagesById, archivesById))
  return { upcoming, history }
}

// ------------------------------------------------------------------ 教练**身份**（同名教练分不清时的展示解）
//
// ⭐ 2026-10-01 真机：会员约课页出现**两个一模一样**的「Sandbox教练」 ——
//   一位是管理他课时的管理人，另一位是被授权授课的教练 ⇒ 会员不知道该选哪个。
//
// 产品规则（用户定稿）：
//   ① 先显示**身份**：管理人 / 授课教练；
//   ② 身份还分不开（同名又同身份）⇒ 再显示**教练码尾号**（只显示公开码的后 4 位）；
//   ③ ⛔ 绝不展示完整内部 id；
//   ④ ⛔ 不改排序、不改默认选择、不改授权关系 —— 这里**只加工展示**，名单顺序原样进出。
//
// ⛔ 身份由服务端下发（`roleKey` / `role` / `codeTail`）。**服务端没给就一个字都不编** ⇒
//    老版本云端下不会冒出"管理人"这种凭空显示的话（这正是"不伪造"的形状）。
function coachOptionsView(rows) {
  const list = Array.isArray(rows) ? rows : []
  const keyOf = row => `${String((row && row.displayName) || '教练')}|${String((row && row.roleKey) || '')}`
  const counts = new Map()
  list.forEach(row => { const key = keyOf(row); counts.set(key, (counts.get(key) || 0) + 1) })
  return list.map(row => {
    const source = row || {}
    const duplicated = (counts.get(keyOf(source)) || 0) > 1
    const codeTail = String(source.codeTail || '')
    return {
      ...source,
      roleText: String(source.role || ''),
      hasRole: !!String(source.role || ''),
      // ⭐ 只有"同名又同身份"这条退路都用完了，才亮出尾号 ⇒ 绝大多数会员根本看不到这 4 个字符。
      showCodeTail: duplicated && !!codeTail,
      codeTail
    }
  })
}

// 课包名单 ⇒ `{ packageViewId: typeName }`（给 `bookingView` 做展示用，**不参与任何判定**）。
function packageNameIndex(rows) {
  const list = Array.isArray(rows) ? rows : []
  const index = {}
  list.forEach(row => {
    if (!row) return
    const id = String(row.packageViewId || '')
    if (!id) return
    const name = String(row.typeName || '').trim()
    if (name) index[id] = name
  })
  return index
}

// 详情：**只按 historyId 精确匹配**（historyId 是服务端派生的稳定视图 ID）。
// ⛔ 绝不按姓名 / 手机号 / 数组下标猜 —— 那是 §4 的越权入口。
function detailOf(rows, historyId, packagesById = {}, archivesById = {}) {
  const found = (Array.isArray(rows) ? rows : []).find(row => row && row.historyId && row.historyId === historyId)
  return found ? bookingView(found, packagesById, archivesById) : null
}

// 日期选项：**dateIndex 是唯一真相源**（BUG05 的形状：写 index、读另一份只在打开时赋一次的快照 ⇒ 选了 9-30 排到 9-29）。
// 这里只产出 `{key,index,...}`，页面必须存 index 并按 `options[index].key` 取值，不许再存第二份"当前日期"。
function dateOptions(fromKey, count) {
  const total = Number.isInteger(count) && count > 0 ? count : MEMBER_DATE_COUNT
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(fromKey || '')) ? fromKey : beijingDate.todayKey()
  const options = []
  for (let index = 0; index < total; index++) {
    const key = beijingDate.addDays(start, index)
    const parts = beijingDate.dateParts(key)
    options.push({ index, key, label: dateTextOf(key), short: `${parts.month}/${parts.day}`, weekday: WEEK_NAMES[parts.weekday] || '' })
  }
  return options
}

// 某天已被占用的时段（分钟区间，可能跨 24:00 ⇒ 不做裁剪，按真值参与冲突判断）。
// ⛔ 已取消的课**不占时间**（它还占着就是把空档白白锁死）；带 `historyId` 便于改期时排除自己。
function occupiedRanges(rows, dateKey) {
  const list = Array.isArray(rows) ? rows : []
  const ranges = []
  for (const row of list) {
    if (String(row && row.date || '') !== String(dateKey || '')) continue
    if (row && row.status === 'cancelled') continue
    const start = startMinutesOf(row)
    if (start == null) continue
    const length = lengthMinutesOf(row)
    const end = length == null ? start + SLOT_STEP_MINUTES : start + length
    if (end <= start) continue
    ranges.push({ start, end, own: true, historyId: String(row.historyId || '') })
  }
  return ranges.sort((a, b) => a.start - b.start || a.end - b.end)
}

function mergeRanges(ranges) {
  const merged = []
  ;[...ranges].sort((a, b) => a.start - b.start || a.end - b.end).forEach(range => {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ start: range.start, end: range.end })
  })
  return merged
}

// 可约时段：**步长 30 分钟**（06:00 / 06:30 / 07:00 …），**23:00 是当天最后一格**。
//  ⛔ 循环上界是「最晚**开课**时间」不是「最晚结束时间」—— 23:00 那一格结束在 24:00，
//     正好卡在界上；按旧写法（`start + step <= 24:00`）反而会把它挤掉。
//  ⛔ 23:30 那一格**不再生成**（2026-10-01 二次口径：取消 23:30 开课，跨午夜退出 MVP）。
//  ⭐⭐ 2026-10-02 三次口径：**结束会跨过当天 24:00 的格子一律不生成**。
//     例：90 分钟的课，23:00 那格 ⇒ 次日 00:30 ⇒ 不生成（22:30 那格 ⇒ 24:00 ⇒ 生成 ✅）。
//     ⛔ 这不是"换行 ⟹ 顺手优化"，而是堵漏洞：课表不再画次日片段，放过去就是一节
//        **看不见却占着时间**的课 —— 比显示出来更糟。判据用 `occupancy` 的同一份阈值。
//  unavailable 的原因必须分开说清（⛔ 不许笼统写成"不可选" ⇒ 会员不知道该换时间还是换教练）：
//    · booked：教练这段时间已经排了课（含自己已排的课）
//    · past ：这个时间已经过去了
//  ⛔ 旧口径里的 `late`（"按 60 分钟算会超过 24:00 结束"）**已于三次口径复活**，
//     但换成了更彻底的做法：**直接从列表里消失**，不再出现一个"点了才被拒"的格子。
function slotsFor(options = {}) {
  const dateKey = String(options.dateKey || '')
  const dayStart = Number.isInteger(options.dayStart) ? options.dayStart : DAY_START_MINUTES
  const latestStart = Number.isInteger(options.latestStart) ? options.latestStart
    : Number.isInteger(options.dayEnd) && options.dayEnd <= LATEST_START_MINUTES ? options.dayEnd : LATEST_START_MINUTES
  const step = Number.isInteger(options.step) && options.step > 0 ? options.step : SLOT_STEP_MINUTES
  const length = Number.isInteger(options.length) && options.length > 0 ? options.length : occupancy.DEFAULT_PLANNED_MINUTES
  const busy = mergeRanges(Array.isArray(options.busy) ? options.busy : [])
  const today = String(options.todayKey || '')
  const nowMinutes = Number.isInteger(options.nowMinutes) ? options.nowMinutes : null
  const slots = []
  for (let start = dayStart; start <= latestStart; start += step) {
    const end = start + length
    // ⛔ 三条防线合起来才是"这一格能不能存在"：开始过早 / 开始过晚 / 结束跨午夜。
    //    最后一问复用 occupancy 的同一条公式（服务端事务内还会再问一次，这里只是"别让用户白点"）。
    if (occupancy.endsAfterDayEnd({ hour: Math.floor(start / 60), minute: start % 60 }, length)) continue
    // ⭐ 2026-10-02：三态判定**不再写在这里** —— 唯一口径在 `occupancy.slotStateOf()`。
    //    教练端「新建课程」弹层的时段卡片用的是**同一个函数**，两边不可能各写一套优先级。
    //    （原来这 2 行就是那条规则的唯一实现；教练端接入后必须收敛成一份，否则会出现
    //     "教练看到可约、会员看到已排课"的两套口径形状。）
    const reason = occupancy.slotStateOf({ dateKey, todayKey: today, nowMinutes, start, length, busy })
    slots.push({
      key: `${dateKey}#${minuteText(start)}`, start, end,
      // ⛔ 结束**可能**跨到次日（**存量**的 23:30 旧课：23:30 + 60 = 次日 00:30）⇒ 必须走 `crossMinuteText`，
      //    用 `Math.min(end, 24*60)` 会把 00:30 显示成 24:00（错的）。
      startText: minuteText(start), endText: crossMinuteText(end),
      label: `${minuteText(start)}–${crossMinuteText(end)}`,
      crossesMidnight: end > DAY_MINUTES,
      available: !reason, reason,
      // ⛔ 可约时这里**仍是空串**（保持历史行为逐字不变）；只有非可约才写字，词表来自共用常量。
      reasonText: reason ? occupancy.slotStateTextOf(reason) : '',
      // ⭐ 2026-10-03：「这一格显示什么字」的唯一来源 —— **永远有值**（可约 ⇒ '可约'）。
      //    两个消费者 wxml 都只写 {{stateText}}，不许再各自写 `available?'可约':reasonText`
      //    那种本地兜底（那就是"每个页面各打一份补丁"的来源，改词表时必漏一处）。
      stateText: occupancy.slotStateTextOf(reason)
    })
  }
  return slots
}

// 合并"会员自己的课"与"教练已排的其它时段"⇒ 一个 busy 数组。
//   教练那部分在服务端就被投影成 `{start,end}`（**不含任何学员信息**），这里只做合并。
function busyOf(options = {}) {
  const own = occupiedRanges(options.bookings, options.dateKey)
  const coachBusy = (Array.isArray(options.coachBusy) ? options.coachBusy : [])
    .filter(range => Number.isFinite(Number(range && range.start)) && Number.isFinite(Number(range && range.end)) && Number(range.end) > Number(range.start))
    .map(range => ({ start: Number(range.start), end: Number(range.end) }))
  return mergeRanges(own.concat(coachBusy))
}

// ⭐ 改期专用：把**这一节自己占的时间**从 busy 里摘掉。
//   不摘的话，改期面板里"自己现在这个时段"永远是"已排课" ⇒ 整页候选时间被自己锁死，
//   会员只能先把课挪走再挪回来（而本轮又没开放取消）⇒ 改期入口事实上不可用。
// ⛔ 只排除**这一条**（按 historyId 精确匹配），别人的课一节都不放过。
function rescheduleBusyOf(options = {}) {
  const exclude = String(options.excludeHistoryId || '')
  const own = occupiedRanges(options.bookings, options.dateKey).filter(range => !(exclude && range.historyId === exclude))
  const coachBusy = (Array.isArray(options.coachBusy) ? options.coachBusy : [])
    .filter(range => Number.isFinite(Number(range && range.start)) && Number.isFinite(Number(range && range.end)) && Number(range.end) > Number(range.start))
    .map(range => ({ start: Number(range.start), end: Number(range.end) }))
  return mergeRanges(own.concat(coachBusy))
}

// 会员**有权使用**的课时包：还有余量的、没作废的。
// ⛔ 只展示，不参与任何写入；销售金额 / 提成等教练端私有字段本来就不会下发到这里。
function usablePackages(rows, archivesById = {}) {
  const list = Array.isArray(rows) ? rows : []
  return list
    .filter(row => row && row.status !== 'reversed')
    .map(row => {
      const remaining = Number(row.remaining)
      const reserved = Number.isFinite(Number(row.reserved)) ? Number(row.reserved) : 0
      const available = occupancy.availableToBook({ remaining: Number.isFinite(remaining) ? remaining : 0, reserved })
      return {
        packageViewId: row.packageViewId || '',
        // ⭐⭐ 真机回归修复（2026-10-06）：**档案归属必须跟着投影一起走**。
        //   ⛔ 少了这一行 ⇒ 下游 `packagesForCoach` 拿一个没有 archiveId 的对象去精确匹配
        //      ⇒ 当前档案**自己的**课包被自己筛光（1.3.20 约课页"暂无可用课时包"就是这个形状）。
        archiveId: String(row.archiveId || ''),
        // ⭐⭐ 服务端可信三项（有就带过去）：老课包没有 archiveId 时，兜底判据**只能**是这三项。
        //   ⛔ 服务端不下发 ⇒ 三个空串 ⇒ `archiveTripleOf()` 返回 null ⇒ 兜底**不发生**（绝不猜）。
        ownerCoachId: String(row.ownerCoachId == null ? '' : row.ownerCoachId),
        datasetId: String(row.datasetId == null ? '' : row.datasetId),
        studentId: String(row.studentId == null ? '' : row.studentId),
        // ⭐ 这份课包属于哪份学员档案（多档案才有值，单档案恒为空）
        archiveName: archiveTextOf(row, archivesById),
        // ⭐「哪些教练真能用这份课包」⇒ **服务端下发**（写路径同口径），客户端只照抄、不猜授权。
        coachKeys: Array.isArray(row.coachKeys) ? row.coachKeys.map(value => String(value)) : [],
        coachName: coachNameOf(row.coach),
        typeName: String(row.typeName || '') || UNRECORDED,
        remaining: Number.isFinite(remaining) ? remaining : 0,
        availableToBook: available,
        total: Number(row.total) || 0,
        used: Number(row.used) || 0
      }
    })
    .filter(row => row.availableToBook > 0)
}

// ⛳ 换教练 ⇒ **这位教练真正被授权的课包**才能选（本轮真机阻断 Bug：原来换教练后仍然拿 packages[0] 提交）。
//   ⛔ 三条规定：
//     ① 判据**只**来自服务端下发的 `coachKeys`，客户端不自己猜授权；
//     ② 只有一份课包 ⇒ 原样返回（单课包用户的体验一个字都不变，不给他加"选择"这个动作）；
//     ③ 一条 `coachKeys` 都没有（老云端 / 退化投影）⇒ 一条都不筛 —— 老客户端照旧工作，
//        ⛔ 但绝不能反过来"为了兼容把画面清空"（那比显示错更糟：界面说没课包，其实有）。
// ⭐ 服务端可信三项：`ownerCoachId + datasetId + studentId`。
//   ⛔ 三项**缺任一** ⇒ 返回 null（⇒ 兜底不发生）。这是"绝不只按 coachKey 猜"的机械保证。
function archiveTripleOf(row) {
  if (!row) return null
  const ownerCoachId = String(row.ownerCoachId == null ? '' : row.ownerCoachId)
  const datasetId = String(row.datasetId == null ? '' : row.datasetId)
  const studentId = String(row.studentId == null ? '' : row.studentId)
  if (!ownerCoachId || !datasetId || !studentId) return null
  return { ownerCoachId, datasetId, studentId }
}

// ⭐ 「这一行属于当前档案吗」—— **唯一**出口（`trusted` = 当前档案那三项，服务端下发才有）。
function belongsToArchive(row, archiveId, trusted) {
  const id = String(archiveId || '')
  if (!id) return false
  const own = String((row && row.archiveId) || '')
  if (own) return own === id                                  // ① 有 archiveId ⇒ 精确匹配
  const triple = archiveTripleOf(row)                          // ② 没有 ⇒ 只认服务端可信三项
  if (!triple) return false
  const want = archiveTripleOf(trusted)
  if (!want) return false
  return triple.ownerCoachId === want.ownerCoachId
    && triple.datasetId === want.datasetId
    && triple.studentId === want.studentId
}

// ⭐ 「属于当前档案的那几行」—— 三处过滤共用的**唯一**出口。
function archiveScopeOf(rows, archiveId, trusted) {
  const id = String(archiveId || '')
  const list = (Array.isArray(rows) ? rows : []).filter(row => !!row)
  if (!id) return []
  // ③ 老云端：**既没有 archiveId、也没有服务端可信三项** ⇒ 这份名单**无从归属** ⇒ 不缩名单
  //    （⛔ 绝不清空画面：界面说没课包、其实有，比显示错更糟）。
  //    ⛔ 只要有**任意一种**可归属依据（archiveId 或完整三项），就必须真的筛 —— 不能借"老云端"偷懒放行。
  const tagged = list.filter(row => String((row && row.archiveId) || '') !== '')
  const attributable = tagged.length ? tagged : list.filter(row => !!archiveTripleOf(row))
  if (!attributable.length) return list.slice()
  return list.filter(row => belongsToArchive(row, id, trusted))
}

function packagesForCoach(rows, coachKey, archiveId, trusted) {
  // ⭐ 档案维度（2026-10-06）：给了 `archiveId` ⇒ **先**把别的档案的课包摘掉。
  //   ⛔ 这一步必须在"按教练筛"**之前**：否则历史档案那一份课包会因为挂着同一个 coachKey 而被留下来。
  //   ⛔ 判据只允许走 `archiveScopeOf`（精确匹配 / 三项兜底 / 老云端退化）⇒ 三处口径不可能再漂移。
  const id = String(archiveId || '')
  // ⛔ **没有档案维度**的旧调用（老界面 / 单档案且服务端还没下发 archives）⇒ 一个都不按档案筛，
  //    保留既有行为（⛔ 绝不因为"加了档案维度"就把老调用链清空）。
  const list = id ? archiveScopeOf(rows, id, trusted) : (Array.isArray(rows) ? rows : []).filter(row => !!row)
  // ⛔ 只有**不带档案维度**的旧调用才保留"单份课包原样返回"这条老规矩。
  //    带了 archiveId 就必须**真的按教练筛** —— 否则"当前档案只剩一份课包"时，
  //    历史档案那位教练会原样拿到这一份（正是要堵的混入口）。
  if (!id && list.length < 2) return list
  const tagged = list.filter(row => row && Array.isArray(row.coachKeys) && row.coachKeys.length)
  if (!tagged.length) return list
  const key = String(coachKey || '')
  return list.filter(row => Array.isArray(row.coachKeys) && row.coachKeys.indexOf(key) >= 0)
}

// ------------------------------------------------------------------ 档案维度：教练名单
//
// ⭐ 当前档案**真正可用**的 coachKey 集合：**只**从"属于这份档案的课包"上读 `coachKeys`
//    （`coachKeys` 由服务端按账本所有者 + 课包级授课授权算好下发，⛔ 客户端自己不猜授权）。
//   ⛔ 没有 archiveId ⇒ 返回空数组（**一个都不给**），绝不是"全部" ——
//      "没有当前档案就给全部教练"正是"历史档案教练混入当前预约页"的形状。
function coachKeysForArchive(packages, archiveId, trusted) {
  const id = String(archiveId || '')
  if (!id) return []
  const keys = []
  // ⛔ 归属判定**只**走 `archiveScopeOf`（精确匹配 / 三项兜底 / 老云端退化），
  //    ⛔ 这里不许再补一条 `archiveId === id` —— 那会把"靠三项兜底认回来的老课包"又踢出去。
  archiveScopeOf(packages, id, trusted).forEach(row => {
    if (!row) return
    ;(Array.isArray(row.coachKeys) ? row.coachKeys : []).forEach(value => {
      const key = String(value || '')
      if (key && keys.indexOf(key) < 0) keys.push(key)
    })
  })
  return keys
}

// ⭐ 当前档案的**可约教练名单**（页面唯一的取数出口）。
//   ⛔ 三条硬规则见文件头那一段（没有档案 ⇒ 空；老云端退化 ⇒ 不缩；绝不混入别的档案）。
function coachesForArchive(coaches, packages, archiveId, trusted) {
  const id = String(archiveId || '')
  const list = Array.isArray(coaches) ? coaches : []
  if (!id) return []
  const own = archiveScopeOf(packages, id, trusted)
  // ⛔ 这份档案**一份课包都没有** ⇒ 没有任何"谁可以上课"的依据 ⇒ 可约教练就是 0。
  //    （⛔ 绝不退化成"全部教练" —— 那就是历史档案教练混进当前档案预约页的形状。）
  if (!own.length) return []
  const tagged = own.filter(row => Array.isArray(row.coachKeys) && row.coachKeys.length)
  // ⛔ 老云端 / 退化投影：这份档案有课包但一行 coachKeys 都没有 ⇒ **不缩名单**。
  //    （⛔ 反过来"为了兼容清空画面"是更坏的错：界面说没教练，其实有。）
  if (!tagged.length) return list
  const keys = coachKeysForArchive(own, id, trusted)
  if (!keys.length) return list
  return list.filter(row => row && keys.indexOf(String((row && row.coachKey) || '')) >= 0)
}

// ⭐ 属于当前档案的课包（在 `usablePackages` **之前**用，避免把别档案的余额算进来）。
function packagesForArchive(rows, archiveId, trusted) {
  return archiveScopeOf(rows, archiveId, trusted)
}

// ⭐ 页面「当前选中的课包」的**唯一出口**（提交与确认框都调它）。
//   ⛔ 真机阻断 Bug 的形状就在这里：原来 `buildRequest` 写的是 `packages[0].packageViewId`
//      ⇒ 会员有 3 份包时，无论选哪个，提交的永远是第一份。
//   ⛔ 下标越界 / 非法一律退到 **0**（保守），但**绝不**凭空造一个不在名单里的包。
function selectedPackageOf(rows, packageIndex) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return null
  const index = Number(packageIndex)
  const at = Number.isInteger(index) && index >= 0 && index < list.length ? index : 0
  return list[at] || null
}

// 这份课包 / 这一份档案**当前能不能被这位会员选**（界面据此决定要不要提示"换一个"）。
function coachMatches(row, coachKey) {
  const keys = row && Array.isArray(row.coachKeys) ? row.coachKeys : []
  return keys.indexOf(String(coachKey || '')) >= 0
}

module.exports = {
  UNRECORDED,
  NO_COACH_FOR_ARCHIVE, NO_PACKAGE_FOR_ARCHIVE, NEED_ARCHIVE_CHOICE,
  DAY_START_MINUTES, LATEST_START_MINUTES, SLOT_STEP_MINUTES, DAY_MINUTES, WEEK_NAMES, crossMinuteText,
  MEMBER_BOOKING_MAX_DAYS, MEMBER_DATE_COUNT,
  MANAGEABLE_STATUS, TERMINAL_STATUSES, KNOWN_STATUSES,
  minuteText, dateTextOf,
  startMinutesOf, lengthMinutesOf, endMinutesOf,
  startTextOf, endTextOf, durationTextOf, timeTextOf, compactTimeTextOf, timeLineTextOf, statusTextOf, coachNameOf, typeTextOf,
  isTerminalOf, canManageOf, packageTextOf, packageNameIndex, archiveNameIndex, archiveTextOf,
  packagesForCoach, packagesForArchive, coachesForArchive, coachKeysForArchive,
  archiveScopeOf, belongsToArchive, archiveTripleOf,
  coachMatches, selectedPackageOf, coachOptionsView,
  bookingView, splitBookings, detailOf,
  BEIJING_OFFSET_MS, timestampOf, scheduledAtOf, statusAtOf, historyOrderOf, eventAtTextOf,
  HISTORY_FILTERS, HISTORY_FILTER_LABELS, filterHistory, historyCountsOf,
  dateOptions, occupiedRanges, mergeRanges, busyOf, rescheduleBusyOf, slotsFor, usablePackages
}
