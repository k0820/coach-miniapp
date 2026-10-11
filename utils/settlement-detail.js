// 统计 → 历史结算 → 课时结算：**会员那一行的课程明细**（2026-09-29）。
//
// 只做一件事：把这个月的**收入记录**（incomes）翻译成"一节一节看得懂的课"。
// 翻译层单独放一个文件，是因为它要能被测试**直接**调用（不经过 Page），
// 而"缺字段时到底显示什么"这种口径必须能逐条钉死。
//
// ⛔ 三条不许（每条都有永久测试对着干）：
//   ① 不许按姓名 / 金额 / 数组顺序猜对应关系 —— 一律用 `income.bookingId` 找 booking；
//   ② 不许用当前时间冒充历史课程时间 —— 取不到就写「未记录」（不是 0 点，也不是今天）；
//   ③ 不许把"时长没保存"当成 60 分钟 —— 结束时间必须来自**这节课真正保存过的**时长快照。
//      ⚠️ `occupancy.plannedEndMinutes()` 里那个 60 兜底是**准入闸**（排课/改期时防绕过规则），
//         那是"未来能不能排"，不是"这节课当时上了多久"。两条性质不同，绝不能借过来当历史事实。
//
// ⛔ 本模块是**只读**的：不写库、不改 income、不碰扣课与收入生成规则。

const occupancy = require('./package-occupancy')

// 唯一的"没记下来"说法。UI 与测试共用这一个常量 ⇒ 不会出现"有的地方写未记录、有的地方写 -"。
const UNRECORDED = '未记录'
const DURATION_UNRECORDED = '时长未记录'

// 完课状态只认 booking.status 的原始值，认不出的写「未记录」，绝不猜成"已完成"。
const STATUS_TEXT = { done: '已完成', booked: '待上课', cancelled: '已取消', noshow: '未到场' }

function pad2(value) { return String(value).padStart(2, '0') }

function textOf(value) {
  if (value == null) return null
  const text = String(value).trim()
  return text || null
}

// 当天内的分钟偏移。hour/minute 缺一个就整体返回 null（半截时间比"未记录"更容易误导）。
//   24 点上界照旧（与排课口径一致），但**不在这里做业务判断**，只做"这数字能不能当时间用"。
function startMinutesOf(booking) {
  if (!booking) return null
  const hour = Number(booking.hour), minute = Number(booking.minute == null ? 0 : booking.minute)
  if (!Number.isInteger(hour) || hour < 0 || hour > 24) return null
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

// 分钟偏移 → HH:MM。跨过 24:00 也照实写（23:30 + 60 = 24:30），不回绕、不截断。
function clockLabel(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0) return null
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`
}

// bookingId → booking 的索引。**键只有 booking.id 这一个**，不掺学员、姓名、顺序。
//   bookings 传数组就现建索引；传已经建好的索引对象就直接用（页面里只建一次）。
function bookingIndex(bookings) {
  if (bookings && !Array.isArray(bookings)) return bookings
  const index = {}
  ;(Array.isArray(bookings) ? bookings : []).forEach(booking => {
    const id = textOf(booking && booking.id)
    if (id && !index[id]) index[id] = booking
  })
  return index
}

// 一条收入 → 一节课程的明细。**唯一**的数据翻译入口。
function lessonDetailOf(income, booking) {
  const record = income || {}
  const start = startMinutesOf(booking)
  // ⚠️ 关键：`plannedMinutesOf` 在"没存过时长"时返回 **null**（不是 60）。
  //    下面据此把结束时间写成「未记录」—— 这就是需求里"不得凭空生成时间"的那一条。
  const minutes = occupancy.plannedMinutesOf(booking)
  const end = start == null || minutes == null ? null : start + minutes
  const incomeAmount = Number(record.amount)
  const lesson = {
    incomeId: textOf(record.id) || '',
    bookingId: textOf(record.bookingId) || '',
    // 日期以 booking 为准（它是排课事实）；booking 被删了才退回收入快照上的日期；都没有就「未记录」。
    date: textOf(booking && booking.date) || textOf(record.date) || UNRECORDED,
    // 开始时间取 booking 的 hour/minute；booking 没了才退回收入快照上的 time 字段。
    startTime: start == null ? (textOf(record.time) || UNRECORDED) : clockLabel(start),
    endTime: end == null ? UNRECORDED : clockLabel(end),
    startMinutes: start,
    endMinutes: end,
    durationText: minutes == null ? DURATION_UNRECORDED : `${minutes} 分钟`,
    typeName: textOf(booking && booking.typeName) || textOf(record.typeName) || textOf(record.category) || UNRECORDED,
    amount: Number.isFinite(incomeAmount) ? Number(incomeAmount.toFixed(2)) : 0,
    statusText: booking ? (STATUS_TEXT[booking.status] || UNRECORDED) : UNRECORDED
  }
  lesson.timeText = lesson.startTime === UNRECORDED && lesson.endTime === UNRECORDED
    ? UNRECORDED
    : `${lesson.startTime}–${lesson.endTime}`
  return lesson
}

// 排序：先按日期升序，再按开始时间升序。两个都没有的（「未记录」）排最后。
function compareLesson(a, b) {
  const left = String(a && a.date), right = String(b && b.date)
  if (left !== right) return left < right ? -1 : 1
  const leftStart = a && a.startMinutes, rightStart = b && b.startMinutes
  if (leftStart == null && rightStart == null) return 0
  if (leftStart == null) return 1
  if (rightStart == null) return -1
  return leftStart - rightStart
}

// 一组收入 → 排好序的明细行。key 给 wxml 的 wx:key 用（收入可能没有 id，不能拿它当唯一键）。
function lessonListOf(incomes, bookings) {
  const index = bookingIndex(bookings)
  return (Array.isArray(incomes) ? incomes : []).map((income, position) => {
    const bookingId = textOf(income && income.bookingId)
    const booking = bookingId ? index[bookingId] || null : null
    return Object.assign(lessonDetailOf(income, booking), { key: `${textOf(income && income.id) || 'income'}-${position}` })
  }).sort(compareLesson)
}

// 明细合计（给"汇总金额必须与展开明细一致"这条断言用；口径与逐行 amount 完全相同）。
function lessonAmountTotal(lessons) {
  return Number((Array.isArray(lessons) ? lessons : []).reduce((sum, lesson) => sum + Number(lesson && lesson.amount || 0), 0).toFixed(2))
}

module.exports = {
  UNRECORDED, DURATION_UNRECORDED, STATUS_TEXT,
  textOf, startMinutesOf, clockLabel, bookingIndex,
  lessonDetailOf, compareLesson, lessonListOf, lessonAmountTotal
}
