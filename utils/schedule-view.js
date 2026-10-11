// 教练课表的**取数口径**（纯函数：不碰 wx、不碰云端、不写任何数据）
//
// ⭐ 为什么把这一段从 `pages/schedule/schedule.js` 里抽出来：
//   2026-10-01 真机事故的根因在**呈现层的取值逻辑里**（已取消的课被当成"一节要上的课"渲染），
//   而页面方法依赖 `this.data` ⇒ 测试调不到 ⇒ 只能让测试自己重算一遍同样的表达式 ⇒
//   页面改坏了测试照样绿（假绿）。抽成纯函数后，页面与测试**调同一个函数**，变异一改就红。
//
// ⛔ 本文件**只决定"课表显不显示"**，绝不删数据：
//   被排除的那几行仍然原样留在 db / cache / 云端里（一条字节都不动），
//   并由 `cancelNoticeOf()` 给出明确交代（教练必须知道自己哪节课被取消了）。

const occupancy = require('./package-occupancy')

// ---------------------------------------------------------------------------------------------
// ⭐ 2026-10-01 真机 Bug（1.3.3）修复的共同根因：**已占用的时间片点它必须打开那一节课**
//
// 现象（Sandbox 真机）：会员约到 **23:30**、跨午夜到次日 00:30 的那节课，
//   课表上显示得明明白白，**点它却进不去详情**，反而弹「这个时间排不了，每天最晚 23:00 开课」。
//
// 根因链：
//   ① 23:30 + 60 分钟 = 次日 00:30 ⇒ 在**当天的分钟轴**上它占到 1470，**跨过了 1440（=24:00）**；
//   ② 课表的一天铺了 25 个格子（00:00–24:00），`hour=24` 这一格之所以存在，
//      就是为了**看得见**跨午夜的那半截课；
//   ③ 而"能不能新建"的时间闸挂在**格子的 tap** 上，判据是这个格子的整点 `hour`
//      （`24 > 23:30` ⇒ 判为非法）；
//      ⇒ 落到这一格的那一下被当成"要在 24:00 新建"，被时间闸拒掉 ——
//         可实际上这一格**正被 23:30 那节课占着**，用户要的是进详情。
//
// 修法（产品规则，不是补丁）：**已经被占着的时间片，点击 = 打开那一节课**，
//   永远不去走"新建校验"。于是「最晚 23:00 开课」这条闸只剩它本来的职责：
//   **约束新建 / 改期的开始时间**（23:00 本身是合法的最后一节：23:00 + 60 ⇒ 24:00 结束）。
//   ⛔ 存量的 23:30 旧课**不经过**这道闸（它只管"新开 / 改到几点"，不改存量）⇒ 仍然打得开。
//
// ⛔ 已取消的课**不占座**（与 `buildScheduleIndex` 同一口径）：它不会再上，也不该挡住新建。
// ⛔ 本函数只看 row，**不写任何数据**（纯函数）。
function occupyingAt(rows, minuteOfDay) {
  const at = Number(minuteOfDay)
  if (!Number.isInteger(at)) return null
  const hits = (Array.isArray(rows) ? rows : []).filter(row => {
    if (!row || occupancy.isCancelled(row)) return false
    const start = occupancy.startMinutesOf(row)
    if (start == null) return false
    // 时长用这节课**自己**的快照（90 分钟的课占 90 分钟），缺失才回落到默认 60。
    const end = occupancy.plannedEndMinutes(row, occupancy.plannedMinutesOf(row) || undefined)
    if (end == null) return false
    return start <= at && at < end
  })
  if (!hits.length) return null
  // 同一刻叠了多条（异常数据 / 撞课）：取**最晚开始**的那一条（最贴近用户点的位置），
  // 再按 id 兜底 ⇒ 结果稳定，不会因为行序不同而抖动。
  return hits.slice().sort((a, b) => {
    const diff = occupancy.startMinutesOf(b) - occupancy.startMinutesOf(a)
    if (diff) return diff
    return String(a.id || '').localeCompare(String(b.id || ''))
  })[0]
}

// ⭐ 课表**空格子被点**时的唯一意图判据（页面 `cell()` 与测试共用同一份）：
//   · 'open'    ⇒ 这一刻有人在上课 ⇒ **打开那一节课**（存量的 23:30 跨午夜课靠这一条：
//                  点在**次日 00:00** 那片空白上，也能进它的详情，而不是"新建"）；
//   · 'too-late'⇒ 这一格空着、且晚于最后一个开课时间 23:00 ⇒ 明确告知不能从这里新建；
//   · 'create'  ⇒ 这一格空着、可以新建。
// ⛔ 顺序就是规则本身：**先问有没有课，再问时间合不合法**。反过来实现，就是 1.3.3 那个 Bug。
//
// ⭐ 2026-10-01 第二次修正（跨午夜显示）：`rows` 是**整份**预约名单（不是某一天的那几节），
//    occupancy 的真区间算法（`intervalOf`）会自己处理"跨到次日" ⇒ 次日 00:00 这一格也能认出
//    "正被昨晚那节课占着"（落到有效地要求 ⑤：10-03 00:00 必须判为已占用）。
function cellTapIntentOf(rows, dateKey, hour) {
  const covering = cellOccupantsOf(rows, dateKey, hour)
  if (covering) return { kind: 'open', row: covering }
  if (occupancy.startsAfterLatest({ hour: Number(hour), minute: 0 })) return { kind: 'too-late', row: null }
  return { kind: 'create', row: null }
}

// =============================================================================================
// ⭐⭐ 跨午夜课程：**占用照算，但不再渲染次日片段**（2026-10-01 **二次口径**：取消 23:30 开课）
//
// 历史：1.3.5 曾经画"双片段"—— 23:30 → 次日 00:30 的课，次日再画一条带「接上节」的块。
//   1.3.5 真机体验后产品定稿：**最晚开课 23:00**，跨午夜**不再作为 MVP 能力**，
//   课表因此**恢复简洁布局** ⇒ 一节跨午夜课只在**开始日**画它那一段（截断在 24:00）。
//
// ⛔ 但「不画」**绝不等于**「不占」—— 这是本文件最容易搞错的一处，务必分清：
//   已经存在的 23:30 旧课仍然**占着次日 00:00–00:30**：
//     · `cellOccupantsOf` / `cellTapIntentOf` ⇒ 点次日 00:00 那片空白 ⇒ **打开那一节课**（不是新建）；
//     · `busyRangesOf`                        ⇒ 对外分享的"可约时间"里，那段仍然是 busy；
//     · 云端 `handlers.overlaps` 同算法        ⇒ 谁也别想在那段时间排新课（不产生时间冲突）。
//
// 共同根因（与上面那个 tap Bug 同源）：
//   **课表一度把"一节课"按它自己的 date 字段塞进唯一一天**（`bySlot[date|hour]` / `byDate[date]`），
//   可一节跨午夜的课**同时占着两个日历日** ⇒ 次日那一半在任何口径里都不存在 ⇒
//   既不渲染、也不算占用、点进去还算新建。
//
// 修法：**引入绝对时间轴**（天序号×1440 + 当天分钟），一切**占用判定**都改问它。
//   ⛔ `occupancy.intervalOf` 与云端 `handlers.overlaps` **同一个算法**（孪生由契约测试锁死）
//      ⇒ 这里承认"这半截属于昨晚那节课"，云端也就承认"这段时间排不了别的课"，两边不会打架。
// =============================================================================================

const DAY_MINUTES = 24 * 60
const CELL_MINUTES = 60

// ⛔ 曾经这里有 `spillSegmentsOf` / `buildSpillIndex`（把跨午夜课切成次日片段去**渲染**）。
//    2026-10-01 二次口径已**删除**：课表恢复简洁布局，不再画「接上节」。
//    ⛔ 千万别因为"看不见"就以为"不占用" —— 占用判定在下面的绝对时间轴函数里，与渲染无关。

// 某一天某一整点这一格代表的**那一刻**（绝对时间轴上的分钟）。
function cellMinuteOf(dateKey, hour) {
  const base = occupancy.dateKeyToMs(dateKey)
  const at = Number(hour)
  if (base == null || !Number.isInteger(at)) return null
  return base / 60000 + at * CELL_MINUTES
}

// 这一格里**正在上课**的那节课（绝对时间轴 ⇒ 跨午夜也算）。
//   ⛔ 判据是"**这一整点那一刻**有人在上课"，不是"这一小时内有没有沾到"：
//      23:00 那一格有一半是空的（23:30 的课从中间开始）⇒ 点那片空白仍然是"我想约 23:00"，
//      不能替用户打开 23:30 那节课。**课程块自己有独立点击区域**（`catchtap="booking"`）。
//   ⛔ 已取消的课不占座（与 `buildScheduleIndex` 同口径）；叠课取最晚开始 + id 兜底 ⇒ 结果稳定。
function cellOccupantsOf(rows, dateKey, hour) {
  const minute = cellMinuteOf(dateKey, hour)
  if (minute == null) return null
  const hits = (Array.isArray(rows) ? rows : []).filter(row => {
    if (!row || occupancy.isCancelled(row)) return false
    const span = occupancy.intervalOf(row)
    return !!span && minute >= span.start && minute < span.end
  })
  if (!hits.length) return null
  return hits.slice().sort((a, b) => {
    const diff = occupancy.startMinutesOf(b) - occupancy.startMinutesOf(a)
    if (diff) return diff
    return String(a.id || '').localeCompare(String(b.id || ''))
  })[0]
}

// 某一天里"被占住"的分钟区间 [**当天内的相对分钟**，可能 > 1440（不截断，按真值参与比较）]。
//   ⭐ 用于「分享可约时间」：昨晚上到今天的课，今天早上这一段**必须**算被占住 ⇒ 不能对外说可约。
function busyRangesOf(rows, dateKey) {
  const base = occupancy.dateKeyToMs(dateKey)
  if (base == null) return []
  const dayStart = base / 60000
  const out = []
  ;(Array.isArray(rows) ? rows : []).forEach(row => {
    if (!row || occupancy.isCancelled(row)) return
    const span = occupancy.intervalOf(row)
    if (!span) return
    const start = Math.max(span.start, dayStart)
    const end = Math.min(span.end, dayStart + DAY_MINUTES)
    if (!(end > start)) return
    out.push({ start: start - dayStart, end: end - dayStart })
  })
  return out.sort((a, b) => a.start - b.start || a.end - b.end)
}

const pad = value => String(Number(value) || 0).padStart(2, '0')
const NOTICE_WINDOW_DAYS = 7
const NOTICE_MAX_LINES = 8
// 已读指纹上限：一条已取消预约的指纹约 40 字节 ⇒ 400 条约 16KB，远低于小程序 Storage 单 key 上限，
// 且足够覆盖"7 天窗口"里能出现的取消量。超出后丢最老的（见 `mergeSeenKeys`）。
const MAX_SEEN_KEYS = 400
const SEEN_KEY_PREFIX = 'coachCancelSeen'

// 课表索引：`bySlot`（某天某整点）/`byDate`（某天）**只含还要上的课**；
// `cancelledByMember` = 被会员取消、因此不再出现在课表上的那些课（仍然完整保留，不删）。
function buildScheduleIndex(bookings) {
  const bySlot = {}, byDate = {}, cancelledByMember = []
  const list = Array.isArray(bookings) ? bookings : []
  list.forEach(booking => {
    if (!booking) return
    if (occupancy.isCancelled(booking)) { cancelledByMember.push(booking); return }
    const slot = `${booking.date}|${booking.hour}`
    ;(bySlot[slot] || (bySlot[slot] = [])).push(booking)
    ;(byDate[booking.date] || (byDate[booking.date] = [])).push(booking)
  })
  // ⭐ `rows` 原样带出 ⇒ 页面算"今天哪些时段被占"不用再重新过滤一遍（同一份口径，不出现第二套）。
  //   ⛔ 这里**不再**产出 `spillBySlot`（次日片段索引已随「接上节」视觉一起删除）；
  //      次日"被占"由 `cellOccupantsOf` / `busyRangesOf` 按**绝对时间轴**现算，与渲染无关。
  return { bySlot, byDate, cancelledByMember, rows: list }
}

// 「还没上的课」名单（学员详情 / 任何"待上课"列表都走这一个口径）：
//   已完成的**不算**，已取消的**也不算**（已取消 = 这节课不会再上，不是"待上"）。
//   ⛔ 2026-10-01 真机之前学员详情自己写 `status!=='done'` ⇒ 会员取消的课被列成"还没上的课"。
function pendingListOf(bookings) {
  return (Array.isArray(bookings) ? bookings : []).filter(row => row && !occupancy.countsAsCompleted(row) && !occupancy.isCancelled(row))
}

function timeTextOf(booking) {
  return `${booking.date || ''} ${pad(booking.hour)}:${pad(booking.minute || 0)}`
}

// 窗口内的已取消课（**按最新时间在前**排序）—— 提示条与"未读提示"共用同一份排序结果。
function recentCancelledOf(rows, todayKey = '', windowDays = NOTICE_WINDOW_DAYS) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean).filter(row => occupancy.isCancelled(row))
  const since = todayKey ? addDaysKey(todayKey, -Math.abs(Number(windowDays) || NOTICE_WINDOW_DAYS)) : ''
  const recent = since ? list.filter(row => String(row.date || '') >= since) : list
  return recent.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (Number(b.hour) || 0) - (Number(a.hour) || 0))
}

const lineOf = row => `${timeTextOf(row)} ${String(row.studentName || '').trim() || '学员'}`

// 提示条：教练必须知道"会员取消了哪几节"，否则把已取消的课从课表拿掉就成了**掩盖事实**。
//   ⛔ 只提示**最近一个窗口内**的课（默认 7 天）：历史上取消过的课不该永远挂在课表顶部。
//   ⛔ 只做告知，不提供任何"恢复/撤销"入口 —— 取消是会员的权利，教练不能替他反悔。
//   ※ 这是**不计已读**的总量口径（历史遗留入口，测试仍在钉它）；页面实际显示走 `unseenCancellationsOf`。
function cancelNoticeOf(rows, todayKey = '', windowDays = NOTICE_WINDOW_DAYS) {
  const sorted = recentCancelledOf(rows, todayKey, windowDays)
  return {
    count: sorted.length,
    latest: sorted.length ? lineOf(sorted[0]) : '',
    lines: sorted.slice(0, NOTICE_MAX_LINES).map(row => lineOf(row))
  }
}

// ---------------------------------------------------------------------------------------------
// ⭐ 1.3.1 真机反馈：教练看到的是"7 天里所有取消"，点完「知道了」它还在 ⇒ 提示条等于常驻噪音。
//   产品规则（2026-10-01 定）：
//     ① 顶部**永远只有一条**汇总（不叠加卡片）；
//     ② 只统计**尚未查看的新取消**，历史取消不显示；
//     ③ 点开按**最新时间在前**列出；
//     ④ 点「知道了」⇒ 标记已读，提示条**立即消失**；
//     ⑤ 之后再来新取消 ⇒ 提示条**重新出现并重新累计**；
//     ⑥ 已取消的业务记录**一条都不删**（这里只标记"看过了"，不动数据）。
//     ⑦ 不做完整消息中心。
// ---------------------------------------------------------------------------------------------

// 一条已取消预约的稳定指纹（用于"这条我看过了"）。
//   ⛔ 必须**稳定**：本机临时 bookingId 转正式 id 后不能让已读失效 ⇒ 优先用正式 bookingId/id。
function cancelSeenKeyOf(booking) {
  const row = booking || {}
  const id = String(row.bookingId || row.id || '').trim()
  if (id) return `id:${id}`
  return `slot:${String(row.date || '')}|${Number(row.hour) || 0}|${Number(row.minute) || 0}|${String(row.studentId || row.studentName || '')}`
}

const seenSetOf = seen => new Set((Array.isArray(seen) ? seen : []).map(key => String(key || '')).filter(Boolean))

// **未读**的取消（页面顶部提示条真正显示的那一条汇总）。
//   `seen` = 已经点过「知道了」的指纹列表。
function unseenCancellationsOf(rows, seen, todayKey = '', windowDays = NOTICE_WINDOW_DAYS) {
  const seenSet = seenSetOf(seen)
  const unseen = recentCancelledOf(rows, todayKey, windowDays).filter(row => !seenSet.has(cancelSeenKeyOf(row)))
  return {
    count: unseen.length,
    latest: unseen.length ? lineOf(unseen[0]) : '',
    lines: unseen.slice(0, NOTICE_MAX_LINES).map(row => lineOf(row)),
    // ⭐ 当前这批"未读"的指纹 ⇒ 点「知道了」时整批标记已读（不是只标记第一行）。
    keys: unseen.map(row => cancelSeenKeyOf(row))
  }
}

// 合并已读指纹：旧的保留、新的追加，并**封顶**（`MAX_SEEN_KEYS`）⇒ 用久了不会无限膨胀。
//   超过上限时丢**最老**的那些（它们多半早已滑出 7 天窗口，丢了也不会重新打扰教练）。
function mergeSeenKeys(previous, keys, limit = MAX_SEEN_KEYS) {
  const merged = []
  const push = key => { const text = String(key == null ? '' : key); if (text && merged.indexOf(text) < 0) merged.push(text) }
  ;(Array.isArray(previous) ? previous : []).forEach(push)
  ;(Array.isArray(keys) ? keys : []).forEach(push)
  const cap = Math.max(Number(limit) || MAX_SEEN_KEYS, 1)
  return merged.length > cap ? merged.slice(merged.length - cap) : merged
}

// 已读状态存在**本机**（小程序 Storage）。⛔ 必须按「环境 + 账本」分开存：
//   正式区与测试区、A 教练与 B 教练的"看过了"不能互相串（否则一边点过，另一边就再也收不到提示）。
function seenStorageKeyOf(environment, datasetId) {
  return `${SEEN_KEY_PREFIX}:${String(environment || 'production')}:${String(datasetId || 'unknown')}`
}

// `YYYY-MM-DD` 加/减天数（不依赖 Date 的时区，纯算术，与 `utils/beijing-date.js` 同口径思路）。
function addDaysKey(dateKey, days) {
  const parts = String(dateKey || '').split('-')
  if (parts.length !== 3) return ''
  const at = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + Number(days || 0)))
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`
}

module.exports = {
  buildScheduleIndex, cancelNoticeOf, pendingListOf, timeTextOf, recentCancelledOf, occupyingAt, cellTapIntentOf,
  cellMinuteOf, cellOccupantsOf, busyRangesOf, DAY_MINUTES, CELL_MINUTES,
  cancelSeenKeyOf, unseenCancellationsOf, mergeSeenKeys, seenStorageKeyOf,
  NOTICE_WINDOW_DAYS, NOTICE_MAX_LINES, MAX_SEEN_KEYS, SEEN_KEY_PREFIX
}
