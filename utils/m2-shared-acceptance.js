// M2 第四批：Sandbox 真机验收辅助（**纯函数** —— 不碰 wx、不读库、不写库、不发命令）。
//
// 为什么单独抽一层：
//   页面的 `Page({...})` 里的方法没法被 node 直接调用，只能靠"读源码字符串"做静态断言 ——
//   那测不出"共享码被规范化了吗""默认时长到底是不是 60""可用课时的公式对不对"。
//   把这几件**能被算错**的事抽成纯函数，就能写真正的断言（见 tests/m2-shared-sandbox-ui.test.js）。
//
// ⛳ 产品定位（与 sharing.js 头部一致）：共享码是**过渡期技术桥梁**，不是正式业务流程。
//   最终模型是会员靠微信身份认自己的课时、自由选择 A/B/C 教练。M3 上线后这条入口应下线。
//   本模块只服务 **Sandbox 验收**，不参与任何正式产品路径。

// ⭐ 最晚 24:00 结束：公式只有一份，直接复用本机孪生模块（绝不写第三份 —— 写第三份的那天起就漂移了）。
const occupancy = require('./package-occupancy')

const DEFAULT_PLANNED_MINUTES = 60
// 可选小时：06:00 起（本页是 Sandbox 验收辅助，起点沿用既有设计），
// 上界收到**最晚开始时间** = 24:00 − 默认时长 60 ⇒ 23:00（取自 occupancy，与云端同一把尺）。
// 📌 口径从 22:00 改成 24:00 时这里一行没动，小时列自动从 06:00–21:00 变成 06:00–23:00。
const HOURS = Array.from({ length: Math.floor(occupancy.latestStartMinutes() / 60) - 6 + 1 }, (_, index) => index + 6)
const MINUTES = [0, 15, 30, 45]

// 共享码：人手抄 / 口头传达，允许大小写与空格，统一成大写无空格。
function normalizeShareCode(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, '').toUpperCase()
}
const SHARE_CODE_PATTERN = /^[A-Z0-9]{6,32}$/
function validShareCode(code) { return SHARE_CODE_PATTERN.test(normalizeShareCode(code)) }

// 预计时长：不填就是 60；填了必须是 1–1440 的整数分钟（与云端 occupancy 同一口径）。
function plannedMinutesOf(raw) {
  if (raw == null || raw === '') return DEFAULT_PLANNED_MINUTES
  const minutes = Number(raw)
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) return null
  return minutes
}

// ⭐ 唯一公式（与 cloudfunctions/coachBusinessCommand/occupancy.js 逐字同口径）：
//   availableToBook = max(remaining − reserved, 0)。**派生值，绝不落库。**
//   契约测试会拿同一组输入分别喂给两边，要求结果一致（改了一边忘了另一边当场变红）。
function availableToBook(pkg, reservedOverride) {
  const remainingValue = Number(pkg && pkg.remaining)
  const remaining = Number.isFinite(remainingValue) ? remainingValue : 0
  let reserved
  if (Number.isInteger(reservedOverride)) reserved = reservedOverride
  else {
    const value = Number(pkg && pkg.reserved)
    reserved = Number.isInteger(value) && value >= 0 ? value : 0
  }
  return Math.max(remaining - reserved, 0)
}
function occupancyOf(pkg, reservedOverride) {
  const remainingValue = Number(pkg && pkg.remaining)
  const remaining = Number.isFinite(remainingValue) ? remainingValue : 0
  const reservedValue = Number.isInteger(reservedOverride) ? reservedOverride : Number(pkg && pkg.reserved)
  const reserved = Number.isInteger(reservedValue) && reservedValue >= 0 ? reservedValue : 0
  return { remaining, reserved, availableToBook: Math.max(remaining - reserved, 0) }
}

// ⭐ 2026-09-27 真机事故：验收页顶部只印 remaining / reserved / availableToBook，不印 used。
//   而 `availableToBook = max(remaining − reserved, 0)` 是**派生值** —— 当 remaining 与 reserved
//   同时 −1（完课）时它的结果一动不动，于是一整次完课的位移被这个减法**藏得干干净净**：
//   本机 10/1/9 与云端 11/2/9 看起来"一致"。结论：**凡是派生值，必须把源值一起显示**。
//   used 不进 occupancyOf：那是与云端 occupancy.js 逐字同口径的契约对象（有契约测试做 deepEqual），
//   多一个字段就要两边同时改；used 只是展示口径，单独取。
function usedOf(pkg) {
  const value = Number(pkg && pkg.used)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

// 本侧（授课教练 B）那些"花别人课时"的预约 —— 靠 booking.packageUsage 认。
function sharedBookingRows(db) {
  const rows = (db && db.bookings) || []
  return rows.filter(row => row && row.packageUsage && row.packageUsage.packageId)
}
function timeText(booking) {
  const hour = String(booking && booking.hour == null ? '' : booking.hour).padStart(2, '0')
  const minute = String(booking && booking.minute == null ? 0 : booking.minute).padStart(2, '0')
  return `${hour}:${minute}`
}

// ── 完课的**呈现**状态（2026-09-28 真机，M2 收尾）────────────────────────────────
//
// ⚠ 为什么必须单独判一次，不能只看 `booking.status === 'done'`：
//   LOCAL_FIRST 下「完成课程」先在本机事务成立、再进持久 Outbox；而 `runtime.getDB()`
//   会把 Outbox 里**还没落云**的 completeBooking 一起投影进来 ⇒ 那一瞬间 booking.status 已经是 done，
//   但课时 / 收入只在**云端事务**里产生。真机上就是这么看到「已完成」而 A 侧课时还没扣的。
//   ⇒ 把「本机投影的 done」当成「云端已结算的 done」写进界面，等于替云端宣布了一件它还没做的事。
//
// ⭐ 判据只有一条，而且**不新建任何业务状态**：Outbox 里还有没有这条 booking 的未落定 completeBooking。
//   队列里没有 ⇒ 云端已确认（条目在确认后才出队）；有 ⇒ 还没确认，必须显示成"同步中/异常"。
//
// `unknown` 必须单独一档：它的含义是"出过网、结果未知"（云端可能受理过也可能没有），
//   与"排队待发"不是一回事，绝不能混进普通同步中，更不能显示成已完成 —— 那是在替一个未知结果背书。
const COMPLETION_SYNC_TEXT = Object.freeze({ syncing: '完成同步中', unknown: '完成同步异常' })

// 从 Outbox 未落定条目里算出「哪些 booking 的完课还没被云端确认」。
//   map = outbox.idMap(scope)：本机临时 id → 云端正式 id（未转正的预约靠它对齐）。
function completionSyncRows(entries, map) {
  const rows = {}
  for (const entry of entries || []) {
    if (!entry || entry.command !== 'completeBooking') continue
    const raw = String((entry.payload && entry.payload.bookingId) || (entry.localIds && entry.localIds.booking) || '')
    if (!raw) continue
    const id = map && Object.prototype.hasOwnProperty.call(map, raw) ? map[raw] : raw
    if (!id) continue
    const flag = entry.status === 'unknown' ? 'unknown' : 'syncing'
    // 两条都能命中时取更坏的那一档：unknown 优先（它代表"结果未知"，比"排队中"更不确定）。
    if (flag === 'unknown' || !rows[id]) rows[id] = flag
  }
  return rows
}

// 列表用的状态文案。优先级：同步中 / 异常 > 云端已确认完成 > 待上课。
// ⚠ 前两档必须压过 `status === 'done'`：那一档正是"本机投影出来的 done"，被它就是本次要修的 bug。
function bookingStatusText(booking, syncRows) {
  const id = booking && booking.id
  const flag = id && syncRows ? syncRows[String(id)] : ''
  if (flag === 'unknown') return COMPLETION_SYNC_TEXT.unknown
  if (flag) return COMPLETION_SYNC_TEXT.syncing
  return booking && booking.status === 'done' ? '已完成' : '待上课'
}

// 「没有把学员 / 课时包 / 销售复制到 B 账里」的**本账一半证据**（另一半是全球唯一性计数，
// 由云端 diagnoseSharedUsage 的 uniqueness 给出）：排课前后这三个数一条都不许涨。
function countsOf(db) {
  const students = ((db && db.students) || []).length
  const packages = ((db && db.students) || []).reduce((sum, student) => sum + (((student && student.packages) || []).length), 0)
  const sales = ((db && db.sales) || []).length
  const incomes = ((db && db.incomes) || []).length
  return { students, packages, sales, incomes }
}
function countsDelta(before, after) {
  const keys = ['students', 'packages', 'sales']
  const delta = {}
  keys.forEach(key => { delta[key] = Number(after && after[key] || 0) - Number(before && before[key] || 0) })
  delta.copied = keys.some(key => delta[key] !== 0)
  return delta
}

// 真机上把错误码翻译成人话：看不到理由就没法判断"是规则挡住了"还是"坏了"。
const HINTS = {
  SHARE_NOT_FOUND: '共享码无效，请向课时包所属教练重新索取。',
  INVALID_SHARE_CODE: '共享码格式不对（6–32 位大写字母或数字）。',
  SHARE_REVOKED: '这枚共享码已被撤销，不能继续排课。',
  SHARE_SELF_NOT_ALLOWED: '这是你自己的课时包，请直接预约。M2 要求 A / B 是**两位不同的教练**。',
  PACKAGE_NOT_FOUND: '这枚共享码指向的课时包已不存在。',
  PACKAGE_NO_REMAINING: '这枚共享码对应的课时包已经没有剩余课时了。',
  PACKAGE_NO_AVAILABLE: '剩余课时已全部被预约占用 —— 这正是「最后一节只能一个人约到」。',
  PACKAGE_UNAVAILABLE: '该课时包已撤销，不能预约。',
  BOOKING_TIME_CONFLICT: '这个时段你已经有别的课了，换个时间再试。',
  REVISION_CONFLICT: '云端数据刚被别的操作更新过，请再点一次。',
  REQUEST_ID_CONFLICT: '同一个操作号被用了两次，请重新进入本页。',
  SHARED_PACKAGE_NOT_LOCAL: '共享预约由云端裁决（本机没有对方那本账），已交云端处理，请稍候再刷新。',
  CLOUD_CACHE_MISSING: '本机还没读到云端数据，请先回到课表等同步完成。',
  IDENTITY_MISSING: '未能确认当前微信身份。',
  COACH_NOT_FOUND: '当前微信还不是已注册教练。',
  ACTIVE_DATASET_NOT_FOUND: '当前环境没有在用数据空间，请先进入沙盒。',
  FORBIDDEN_IDENTITY_INPUT: '客户端不得提交身份或数据集定位字段（这条不该发生，请回报）。'
}
function hintOf(code) { return HINTS[code] || (code ? `未通过：${code}` : '未通过，原因不明。') }

// 只读取证的展示口径：把云端回的事实压成一行能念出来的中文。
function shareStateText(fact) {
  if (!fact || !fact.ok) return hintOf(fact && fact.code)
  const target = fact.target || {}
  if (!target.found) return '查到了共享码，但找不到它指向的课时包。'
  const reserved = target.reserved == null ? '尚未初始化' : `${target.reserved} 节`
  const available = availableToBook({ remaining: target.remaining, reserved: target.reserved })
  return `剩余 ${target.remaining} 节 · 已占 ${reserved} · 还能约 ${available} 节（已用 ${target.used} 节）`
}
function peerText(fact) {
  if (!fact || !fact.ok) return hintOf(fact && fact.code)
  const pkg = (fact.peer && fact.peer.package) || {}
  if (!fact.peer || !fact.peer.found) return '对端那本账里找不到这个课时包。'
  const available = availableToBook({ remaining: pkg.remaining, reserved: pkg.reserved })
  return `课时包侧：剩余 ${pkg.remaining} · 已占 ${pkg.reserved} · 还能约 ${available} · 已用 ${pkg.used}`
}

// 验收页自己造一个 requestId（8–128 位，字符集 [A-Za-z0-9:_-]），
// 目的是事后能用同一个号去查两侧回执 —— 否则没法在手机上证明"这条命令真的被受理过"。
function newRequestId(prefix) {
  return `${prefix}_${Date.now()}`
}

module.exports = {
  DEFAULT_PLANNED_MINUTES, HOURS, MINUTES, SHARE_CODE_PATTERN, HINTS,
  normalizeShareCode, validShareCode, plannedMinutesOf,
  availableToBook, occupancyOf, usedOf, sharedBookingRows, timeText,
  countsOf, countsDelta, hintOf, shareStateText, peerText, newRequestId,
  COMPLETION_SYNC_TEXT, completionSyncRows, bookingStatusText
}
