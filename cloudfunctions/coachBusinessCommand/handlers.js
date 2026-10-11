const { fixedId } = require('./core')
// M2 课时占用规则（reserved / availableToBook / plannedMinutes / 待确认）——**唯一权威来源**。
const occupancy = require('./occupancy')
// M2 业务模型校正：谁发起 / 谁授课 + 会员时间冲突（会员拥有真实课时事实，教练只是授课方）。
const teaching = require('./teaching')
// M2 第二批：跨教练共享课时包（共享码 / packageUsage 定位）。
const sharing = require('./sharing')
// M2 V1：正式双层授权（会员级服务关系 + 课包级授课授权）。**唯一权威判定**。
const authorization = require('./authorization')
// M3-P6：通知事件类型名（**唯一**命名处，见 notify.js）。这里只用类型常量，不写事件。
const notifyTypes = require('./notify').EVENT_TYPES
// ⭐⭐ 2026-10-07（1.3.38）：预约变动的**统一通知分发器**（两个方向共用一套）。
const notifyBooking = require('./notify-booking')

const SETTINGS_ID = 'settings'
const SETTING_FIELDS = Object.freeze(['renewThreshold', 'monthlyGoalSessions', 'classCommissionRate', 'salesCommissionRate'])

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
// ⭐ `extra` 会随失败响应一并返回（core 的 fail 把它平铺进返回对象）。
//   M2 V1 起必须支持它：像"还有 N 节未完成预约"这种失败，只给一个码等于让用户去猜冲突在哪。
const commandError = (code, message, extra = {}) => Object.assign(new Error(message), { commandCode: code, extra })

function text(value, label, optional = false) {
  if (value == null && optional) return ''
  const result = String(value == null ? '' : value).trim()
  if (!result && !optional) throw commandError('INVALID_PAYLOAD', `${label}不能为空。`)
  return result
}

function number(value, label, positive = false) {
  const result = Number(value)
  if (!Number.isFinite(result) || result < 0 || (positive && result <= 0)) throw commandError('INVALID_PAYLOAD', `${label}无效。`)
  return result
}

function date(value, label = '日期', optional = false) {
  if ((value == null || value === '') && optional) return ''
  const result = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw commandError('INVALID_PAYLOAD', `${label}无效。`)
  const [year, month, day] = result.split('-').map(Number), parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) throw commandError('INVALID_PAYLOAD', `${label}无效。`)
  return result
}

function businessData(row) {
  return row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? clone(row.data) : {}
}

function writableRow(row, patch) {
  const next = clone(row || {})
  delete next._id
  delete next.ownerCoachId
  delete next.datasetId
  return { ...next, ...clone(patch) }
}

async function rows(collection) {
  return collection.list({})
}

function nextSortIndex(list) {
  return list.reduce((max, row) => Math.max(max, Number.isFinite(Number(row.sortIndex)) ? Number(row.sortIndex) : Number.isFinite(Number(row.sourceOrder)) ? Number(row.sourceOrder) : -1), -1) + 1
}
function rowOrder(row) { return Number.isFinite(Number(row && row.sortIndex)) ? Number(row.sortIndex) : Number.isFinite(Number(row && row.sourceOrder)) ? Number(row.sourceOrder) : 0 }

function generatedBusinessId(kind, business, requestId) {
  return `${kind}_${fixedId(`coach-${kind}`, business.ownerCoachId, `${business.datasetId}:${requestId}`).slice(0, 20)}`
}

const LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ'
const BOUNDS = '阿芭擦搭蛾发噶哈击喀垃妈拿哦啪期然撒塌挖昔压匝'
function initials(name) {
  return String(name || '').split('').map(character => {
    if (/[a-z]/i.test(character)) return character.toUpperCase()
    try {
      for (let index = LETTERS.length - 1; index >= 0; index -= 1) if (character.localeCompare(BOUNDS[index], 'zh-CN') >= 0) return LETTERS[index]
    } catch (error) {}
    return ''
  }).join('')
}

function requireOnly(payload, allowed) {
  const unknown = Object.keys(payload).filter(key => !allowed.includes(key))
  if (unknown.length) throw commandError('INVALID_PAYLOAD', `包含不允许的字段：${unknown.join('、')}`)
}

function bookingTime(booking) {
  return `${String(booking.hour).padStart(2, '0')}:${String(booking.minute || 0).padStart(2, '0')}`
}

// ⭐ 2026-09-29 业务口径变更（已确认）：**一天里 00:00–24:00 任意一小时都可以排课**，
//   包括 07:00 之前的清晨课，也包括事后补录已经上过的课。
//   ⛔ 这里不是"把时间校验删掉" —— 三条真实边界一条都不能少：
//     ① hour 必须是一天内的整点小时（0–24，hour===24 时分钟必须是 0，即"当天最后一格是 24:00"）；
//     ② minute 必须落在 0–59；
//     ③ date 仍必须由 `date()` 把关（跨日 / 跨月的收入归属就系在这一个字段上）。
//   ⛔ 客户端 `utils/cloud-command-engine.js` 里有一份**同名同源**的副本，改了这里必须同时改那里
//     （本机先行会在出网前用那一份拦一遍，两边口径不一致就会出现"本机收下、云端拒绝"）。
function bookingMoment(payload) {
  const bookingDate = date(payload.date, '预约日期'), hour = number(payload.hour, '预约小时'), minute = number(payload.minute, '预约分钟')
  if (!Number.isInteger(hour) || hour < 0 || hour > 24 || !Number.isInteger(minute) || minute < 0 || minute > 59 || (hour === 24 && minute !== 0)) throw commandError('INVALID_PAYLOAD', '预约时间无效。')
  return { date: bookingDate, hour, minute }
}

// ------------------------------------------------------------------ M2：这条预约用的是哪本账里的课时包？
//
// 普通预约  → 自己这本账。
// 共享预约  → `booking.packageUsage` 指向的那本账（**存储位置**，不是所有权）。
//             返回的 `space` 是**与本次同一个事务**内、那位教练那本账的读写门面 ⇒ 跨存储位置事务。
//             `attach()` 声明"这一笔同时动了那本账" ⇒ 由 core.execute 统一补 revision + receipt。
async function bookingPackageSpace(business, context, bookingRow, booking, optional = false) {
  const usage = sharing.usageOfBooking(booking)
  if (!usage) {
    const packageId = text(booking.packageId || bookingRow.packageId || '', 'booking.packageId', true)
    return { space: business, packageRow: packageId ? await business.collection('packages').get(packageId) : null, shared: false, usage: null, attach: () => {} }
  }
  if (!context || typeof context.businessAt !== 'function') throw commandError('COMMAND_TRANSACTION_FAILED', '当前执行环境不支持共享预约。')
  const space = usage.ownerCoachId === business.ownerCoachId ? business : context.businessAt(usage.ownerCoachId, usage.datasetId)
  const packageRow = await space.collection('packages').get(usage.packageId)
  // ⭐ 共享预约指向的课时包**必须**在。少了就如实抛错 —— 绝不能"悄悄跳过释放占座"：
  //    那会让对端课时包的 reserved 永久多占一格，而错误现场却显示"取消成功"。
  //    （唯一例外是 `optional`：删除已完成课程时"原课时包已不存在"是既有的合法形状，按原样继续。）
  if (!packageRow && !optional) throw commandError('PACKAGE_NOT_FOUND', '这条共享预约指向的课时包已不存在，不能继续。')
  return {
    space, packageRow, shared: true, usage,
    attach: result => context.attachPeer({ ownerCoachId: usage.ownerCoachId, datasetId: usage.datasetId, result: { packageId: usage.packageId, ...(result || {}) } })
  }
}

// ------------------------------------------------------------------ 跨教练排课的**唯一内核**
//
// 共享码排课（createSharedBooking）与正式授权排课（createAuthorizedBooking）共用这一段：
//   预约文档落在**授课教练**这本账，占座写在**课时包物理所在**那本账，两本账同一个事务。
// ⚠️ 绝不复制第二份：复制的第一天起，两条路径的 reserved / 会员冲突口径就会开始漂移。
//   入参 `usage` 必须是**服务端派生**的（共享码或授权记录），客户端永远提交不了。
async function createBookingOnForeignPackage({ business, context, peer, usage, studentId, packageId, moment, plannedMinutes, extraPlaces = [] }) {
  const packageRow = await peer.collection('packages').get(packageId)
  if (!packageRow) throw commandError('PACKAGE_NOT_FOUND', '共享码指向的课时包已不存在。')
  const pkg = businessData(packageRow)
  if (packageRow.packageId !== packageId || pkg.id !== packageId || packageRow.studentId !== studentId) throw commandError('PACKAGE_RELATION_INVALID', '共享码与课时包关系不一致，请重新索取共享码。')
  if (pkg.status === 'reversed') throw commandError('PACKAGE_UNAVAILABLE', '该课时包已撤销，不能预约。')
  const remaining = Number(pkg.remaining)
  // ⭐ 与 createBooking **同一条规则、同一句提示**（授权课包与普通课包不许有两套口径）。
  if (!Number.isFinite(remaining) || remaining <= 0) throw commandError('PACKAGE_NO_REMAINING', '这个课时包已经没有剩余课时了。请先给会员续费或增加课时，再录入这节课（事后补录也一样不能透支）。')
  // ⭐ 与 createBooking **同一把尺**：判 availableToBook，不是判 remaining。
  //   这就是"最后一节只能一个人抢到"的支点 —— 谁先落库谁占住，后面的看到 0。
  const reserved = await occupancy.syncReserved(peer, pkg)
  if (occupancy.availableToBook(pkg, reserved) <= 0) throw commandError('PACKAGE_NO_AVAILABLE', '该课时包剩余课时已全部安排课程，如需继续预约请先调整已有预约或续费。')
  if (!Number.isInteger(plannedMinutes) || plannedMinutes <= 0 || plannedMinutes > 1440) throw commandError('INVALID_PAYLOAD', '课程预计时长必须是 1–1440 的整数分钟。')
  // ⭐ 与 createBooking **同一把尺**（共享码排课 / 正式授权排课共用这一段，不许出现第二套口径）。
  //   ⭐ 2026-10-03 起「入口时间窗」= **开始 06:00–23:00 且 结束 ≤ 当天 24:00**（最早也由 `lessonWindowGateOf` 拦）。
  //      ⛔ 上一版这里刻意**不判**最早 07:00，好让"历史课程补录"能把凌晨的课录进来；用户 2026-10-03 要求
  //         入口统一到 06:00 ⇒ 那个口子关闭。**关的只是入口**：存量 00:00–05:59 的历史课不删、不改、不迁移，
  //         课表的「凌晨段条件渲染」原样保留。30 分钟网格仍不在这里判。
  const gate = occupancy.lessonWindowGateOf(moment, plannedMinutes)
  if (gate) throw commandError(gate.code, gate.message)
  const bookings = business.collection('bookings'), list = await bookings.list({})
  // ⭐ 服务端最终校验 ①：授课教练（也就是**发起这次预约的这位教练**）这个时间没冲突。
  //    注意：A 的课表不占 B 的时间 —— 教练时间各管各的，共享的只有**会员的时间**和**课时**。
  if (list.some(row => overlaps(row, moment, null, plannedMinutes))) throw commandError('BOOKING_TIME_CONFLICT', '该教练这个时段已经有课了。')
  // ⭐ 服务端最终校验 ②：会员这个时间没冲突 —— **必须在已知账本里都查**。
  const memberConflict = await teaching.findMemberTimeConflict({
    businessAt: context.businessAt,
    places: [
      { ownerCoachId: business.ownerCoachId, datasetId: business.datasetId },
      { ownerCoachId: usage.ownerCoachId, datasetId: usage.datasetId },
      ...extraPlaces
    ],
    studentId, moment, plannedMinutes
  })
  if (memberConflict) throw commandError('MEMBER_TIME_CONFLICT', '该会员这个时段已经有课了，请换一个时间。')
  const studentRow = await peer.collection('students').get(studentId)
  const studentName = studentRow ? (businessData(studentRow).name || '学员') : '学员'
  const bookingId = generatedBusinessId('booking', business, context.requestId)
  if (await bookings.get(bookingId)) throw commandError('ID_CONFLICT', '预约 ID 已存在。')
  const typeName = text(pkg.type, '课程类型'), price = typeName === '赠送课程' ? 80 : Number(pkg.price)
  if (!Number.isFinite(price) || price < 0) throw commandError('PACKAGE_PRICE_INVALID', '课时包价格无效，不能创建预约。')
  const booking = {
    id: bookingId, studentId, studentName, packageId, ...moment,
    typeName, price, plannedMinutes, status: 'booked', createdAt: context.now,
    // ⭐ 唯一的跨账定位标记：这条预约用的是**这位会员**哪一份课时事实，以及那份事实物理存在哪本账。
    //    ownerCoachId / datasetId 的语义是**存储位置**，不是所有权（会员拥有自己的课时）。
    packageUsage: { packageId, studentId, ownerCoachId: usage.ownerCoachId, datasetId: usage.datasetId },
    // ⭐ 谁发起 / 谁授课：这节课由**发起预约的这位教练**上（他才是授课教练）。
    ...teaching.identityFor(business, {})
  }
  await bookings.set(bookingId, { bookingId, studentId, packageId, sortIndex: nextSortIndex(list), data: booking })
  await occupancy.applyDelta(peer, pkg, 1)
  await peer.collection('packages').set(packageId, writableRow(packageRow, { packageId, studentId, ...(packageRow.saleId || pkg.saleId ? { saleId: packageRow.saleId || pkg.saleId } : {}), data: pkg }))
  const identity = teaching.identityFor(business, {})
  return {
    bookingId, studentId, packageId, plannedMinutes, shared: true,
    ownerCoachId: usage.ownerCoachId, datasetId: usage.datasetId,
    teachingCoachId: identity.teachingCoachId, source: identity.source
  }
}

// ⭐ 冲突检测（**授课教练这一侧**）—— 2026-10-01 重写为「绝对分钟轴上的真区间相交」。
//
// ⛔ 旧实现有两个硬伤，允许 23:30 跨午夜之后**必须**修掉，否则会漏判真实冲突：
//   ① `booking.date !== moment.date ⇒ false`：**只比同一天**。
//      10-01 23:30–00:30 与 10-02 00:00–01:00 真重叠，但日期字段不同 ⇒ 旧算法说"没冲突"。
//   ② 双方时长**写死 60**（`oldStart + 60`）：一条 90 分钟的课只按 60 分钟参与比较 ⇒ 尾部重叠漏判。
//
// 新算法：把每条预约投影到「天序号×1440 + 当天分钟」的绝对轴上，用**各自真实时长**做半开区间相交。
//   · 半开区间 ⇒ 首尾相接不算冲突（23:00–24:00 与次日 00:00–01:00 相邻，合法）；
//   · 时长取各自 `plannedMinutes`，**老预约没有这个字段 ⇒ 按 60 兜底**（与旧行为逐字一致）。
function overlaps(row, moment, ignoredBookingId, plannedMinutes) {
  const booking = businessData(row)
  // M3-P6：**已取消的预约不再占用时间**（会员自助取消后这条行会留在账里当历史）。
  //   ⛔ 少了这一行，取消过的时段会被永久锁死（详见 occupancy.blocksTimeSlot 的说明）。
  if (!occupancy.blocksTimeSlot(booking)) return false
  if (row.bookingId === ignoredBookingId || booking.id === ignoredBookingId) return false   // ⛔ 不再按日期短路
  const a = occupancy.intervalOf(booking)
  const b = occupancy.intervalOf({ date: moment.date, hour: moment.hour, minute: moment.minute, plannedMinutes })
  return occupancy.intervalsOverlap(a, b)
}

function rebuildSummary(booking) {
  const parts = booking.date.split('-'), value = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])), weekday = ['日', '一', '二', '三', '四', '五', '六'][value.getDay()]
  const category = booking.category || (booking.typeName === '拉伸恢复' ? '拉伸恢复' : '常规训练'), lines = [`⏰ ${Number(parts[1])}月${Number(parts[2])}日 星期${weekday}`, `${Number(booking.hour)}:${String(booking.minute || 0).padStart(2, '0')}｜${category}`, '']
  ;(Array.isArray(booking.items) ? booking.items : []).forEach(item => {
    if (booking.typeName === '拉伸恢复' || item.group === '拉伸') lines.push(`${item.name} · ${item.minutes || 15}分钟`)
    else lines.push(`${item.name} · ${item.sets || 4}组×${item.reps || 12}次${item.weight !== '' && item.weight != null ? ` · ${item.weight}kg` : ''}`)
  })
  if (booking.typeName === '拉伸恢复') lines.push(`⏱训练时长：${booking.duration || 60}分钟`)
  if (booking.notes) lines.push(`备注：${booking.notes}`)
  return lines.join('\n')
}

// M2 V1：授课教练闸。「谁上的这节课」由服务端可信身份判定，客户端提交了也不看。
//   旧数据没有 teachingCoachId ⇒ 回落到"这条预约存在谁那本账"（老模型下就是授课教练），语义一致，零迁移。
function assertTeachingCoach(business, booking, action) {
  const owner = teaching.teachingCoachIdOf(booking, business.ownerCoachId)
  if (owner && owner !== business.ownerCoachId) throw commandError('NOT_TEACHING_COACH', `只有这节课的授课教练可以${action}。`)
}

// M2 V1：授权窄门**必须**由事务注入。没有它就是执行环境不支持 ⇒ fail closed，绝不"当作没权限继续"。
function requireAuthorizations(context) {
  if (!context || !context.authorizations) throw commandError('COMMAND_TRANSACTION_FAILED', '当前执行环境不支持多教练授权。')
  return context.authorizations
}

// ------------------------------------------------------------------ M3-P6 · 教练侧「通知另一方」的接入点
//
// 用户定稿的规则 6：**会员取消 / 改期 ⇒ 通知这节课的授课教练；教练取消 / 改期 ⇒ 通知这位会员。**
//   ⛔ 本轮**不发微信订阅消息**（`notify.ACTIVE_CHANNEL === null`），只把"需要通知谁"记成事件事实；
//      微信那一层是 M4，接入口只有 `notify.pending()` / `notify.markDelivered()` 一处。
//   ⛔ 这是**加在既有取消/改期链尾部的一步**，不动预约内核的任何判定 ——
//      写在这里是为了让"教练端取消会员的课"与"会员端取消"走**同一张事件表、同一套幂等**。
//   ⚠️ 认不出这位学员属于哪个会员（还没认领会员身份）⇒ **不产生事件**（没有可通知的对象），
//      这不是故障，是事实：没有会员账号的人，收不到会员端通知。
//
// ★★ 为什么必须有 `suppressBookingChangeNotify`（2026-09-30 故障恢复时发现的真实缺陷）★★
//   会员改期是**复用** `handlers.rescheduleBooking` 实现的（一个字都不复制，见 memberBooking.js）。
//   而本函数是**教练侧**的接入点 ⇒ 若不过滤，一次会员改期会落下**两条**事件：
//     ① 本函数写的 `coach-booking-rescheduled`（actor 被**伪造成教练**、recipient 是**会员本人**）
//     ② `memberBooking.rescheduleMemberChange` 写的 `member-booking-rescheduled`（actor=会员、recipient=教练）
//   ⇒ 后果有两重，都是事故级的：
//     · **actor 被伪造**：事件表里出现"教练改期"，而教练什么都没做（审计不可信）；
//     · **给自己发通知**：会员动了自己的课，却收到一条"你的课被改了" ⇒ M4 接上微信后会真的发出去。
//   ⇒ 会员通道在调 `handlers.rescheduleBooking` 时显式传 `suppressBookingChangeNotify: true`，
//      由 `memberBooking.js` 那**一个**地方按会员口径记事件（两条命令各记一次，方向对称）。
//   ⛔ 教练端命令走 `core.execute` 时**没有**这个标记 ⇒ 教练侧行为一个字没变。
async function recordBookingChange(context, booking, { type, bookingId, now }, business) {
  // ⛔⛔ 会员改期是**复用** `rescheduleBooking` 实现的 ⇒ 会员通道会显式传这个开关。
  //    少了它，一次会员改期会落下**两条**事件：一条把 actor 伪造成"教练"（审计不可信），
  //    另一条还会给会员本人发"你的课被改了"（2026-09-30 故障恢复时发现并修掉的真实缺陷）。
  //    ⛔ 这道闸必须留在**入口层**：分发器里还有一道同款，两道才算真的兜住。
  if (context && context.suppressBookingChangeNotify === true) return null
  // ⭐⭐ 2026-10-07（1.3.38）：**不再自己反查会员**，改走与会员侧**同一个**分发器。
  //   ⇒ 方向判定（actor=coach ⇒ recipient=member）与收件人解析全部交给 `notifyBookingChange`，
  //     这样"会员约教练"和"教练约会员"是同一套代码的两个方向，不会再各自漂移。
  //   ⛔ `recordBookingChange` 这个函数名与签名都保留（既有测试与三个调用点都靠它），
  //      变的只是内部实现：从"猜会员"改成"统一分发 + 认不出就留痕"。
  return notifyBooking.notifyBookingChange(context, {
    actorRole: notifyBooking.ACTOR_COACH,
    act: notifyBooking.actForType(type),
    booking, business,
    requestId: context && context.requestId,
    now: now || (context && context.now)
  })
}

// 会员级关系的「账本位置」：自己账里的学员，或我管理着其课包的会员（派生出的管理权）。
async function resolveMemberPlace({ business, context, auths, studentId }) {
  const own = await business.collection('students').get(studentId)
  if (own) return { place: { ownerCoachId: business.ownerCoachId, datasetId: business.datasetId }, studentRow: own, studentId }
  const grants = (await auths.grantsForCoach(business.ownerCoachId, 'package')).filter(row => row.studentId === studentId && row.canManage === true)
  if (!grants.length) throw commandError('STUDENT_NOT_FOUND', '学员不存在或不属于当前数据集，你也没有该会员的管理权限。')
  const first = grants[0], place = { ownerCoachId: first.ownerCoachId, datasetId: first.datasetId }
  if (grants.some(row => row.ownerCoachId !== place.ownerCoachId || row.datasetId !== place.datasetId)) throw commandError('MEMBER_PLACE_AMBIGUOUS', '该会员的记录位置不唯一，请让权限管理人整理后重试。')
  const studentRow = await context.businessAt(place.ownerCoachId, place.datasetId).collection('students').get(studentId)
  if (!studentRow) throw commandError('STUDENT_NOT_FOUND', '学员不存在或不属于当前数据集。')
  return { place, studentRow, studentId }
}

// 课包授权的「账本位置」：自己这本账里的课包，或我拥有管理权的那一份（授权行 canManage）。
async function resolvePackagePlace({ business, context, auths, packageId, forManage }) {
  const own = await business.collection('packages').get(packageId)
  if (own) return { place: { ownerCoachId: business.ownerCoachId, datasetId: business.datasetId }, studentId: own.studentId || '', packageRow: own }
  const grants = (await auths.grantsForCoach(business.ownerCoachId, 'package')).filter(row => row.packageId === packageId)
  if (!grants.length) throw commandError('PACKAGE_NOT_FOUND', '课时包不存在或不属于当前数据集，你也没有它的管理权。')
  if (grants.length > 1) throw commandError('PACKAGE_GRANT_AMBIGUOUS', '这份课时包存在多条有效授权，请让权限管理人整理后重试。')
  const grant = grants[0], place = { ownerCoachId: grant.ownerCoachId, datasetId: grant.datasetId }
  if (forManage) await authorization.assertCanManagePackage(auths, place, packageId, business.ownerCoachId)
  const packageRow = await context.businessAt(place.ownerCoachId, place.datasetId).collection('packages').get(packageId)
  if (!packageRow) throw commandError('PACKAGE_NOT_FOUND', '课时包不存在或不属于当前数据集。')
  return { place, studentId: packageRow.studentId || grant.studentId || '', packageRow, grant }
}

async function upsertMemberAuth(auths, place, studentId, coachId, grantedByCoachId, source, now) {
  const existing = await auths.findMember(place, studentId, coachId)
  const claim = await auths.findClaim(place.ownerCoachId, studentId)
  const row = {
    ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId, coachId,
    // ⭐ 可信会员身份**只从认领关系推导**：认领过才记 memberId，没认领就是空串。
    //    绝不用姓名 / 手机号去匹配（同名同号的两条档案必须保持两条）。
    //    ⚠️ 认领**优先于**旧值：认领可能发生在授权之后（先授权、会员后来才认领自己的档案），
    //       这时必须把认领出来的 memberId 补上，否则授权行会永远停在"未认领"。
    memberId: (claim && claim.memberId) || (existing && existing.memberId) || '',
    status: authorization.STATUS_ACTIVE, source: (existing && existing.status === authorization.STATUS_ACTIVE && existing.source === authorization.SOURCE_EXPLICIT) ? authorization.SOURCE_EXPLICIT : source,
    grantedByCoachId, createdAt: (existing && existing.createdAt) || now, updatedAt: now
  }
  await auths.writeMember(row)
  const label = await authorization.coachLabel(auths, coachId)
  return { ...row, displayName: label.displayName }
}

const handlers = {
  async createStudent(business, payload, context) {
    requireOnly(payload, ['name', 'phone'])
    const collection = business.collection('students'), list = await rows(collection), studentId = generatedBusinessId('student', business, context.requestId)
    if (await collection.get(studentId)) throw commandError('ID_CONFLICT', '学员 ID 已存在。')
    const name = text(payload.name, '学员姓名'), phone = payload.phone == null ? '' : String(payload.phone)
    await collection.set(studentId, { studentId, sortIndex: nextSortIndex(list), data: { id: studentId, name, phone, abbr: initials(name), createdAt: context.now } })
    return { studentId }
  },

  async updateStudent(business, payload) {
    requireOnly(payload, ['studentId', 'name', 'phone'])
    const studentId = text(payload.studentId, 'studentId'), collection = business.collection('students'), old = await collection.get(studentId)
    if (!old) throw commandError('STUDENT_NOT_FOUND', '学员不存在或不属于当前数据集。')
    if (!has(payload, 'name') && !has(payload, 'phone')) throw commandError('INVALID_PAYLOAD', '没有需要修改的学员字段。')
    const student = businessData(old)
    if (has(payload, 'name')) { student.name = text(payload.name, '学员姓名'); student.abbr = initials(student.name) }
    if (has(payload, 'phone')) student.phone = payload.phone == null ? '' : String(payload.phone)
    await collection.set(studentId, writableRow(old, { studentId, data: student }))
    return { studentId }
  },

  async createPackage(business, payload, context) {
    // ⭐ 2026-09-29：赠课与普通课包**同一套授课授权机制** ⇒ 这里也要能收 `teachingPublicCodes`。
    //   字段的职责与 createCourseSale 完全一致：
    //     · 创建者（这里是发赠课的人）拿到管理权 canManage=true；
    //     · 名单里的人只拿到授课权 canManage=false；
    //     · 会员级服务关系随课包授权自动补齐（derived）。
    requireOnly(payload, ['studentId', 'type', 'total', 'remaining', 'isGift', 'teachingPublicCodes'])
    const studentId = text(payload.studentId, 'studentId'), student = await business.collection('students').get(studentId)
    if (!student) throw commandError('STUDENT_NOT_FOUND', '学员不存在或不属于当前数据集。')
    const type = text(payload.type, '课程类型')
    if (type !== '赠送课程' || (has(payload, 'isGift') && payload.isGift !== true)) throw commandError('PAID_PACKAGE_REQUIRES_SALE', '付费课时包必须通过 createCourseSale 与销售记录原子创建。')
    const total = number(payload.total, '赠送课时', true), remaining = number(payload.remaining, '当前剩余'), collection = business.collection('packages'), list = await collection.list({ studentId }), packageId = generatedBusinessId('package', business, context.requestId)
    if (!Number.isInteger(total) || !Number.isInteger(remaining)) throw commandError('INVALID_PAYLOAD', '课时数必须是整数。')
    if (await collection.get(packageId)) throw commandError('ID_CONFLICT', '课时包 ID 已存在。')
    const pkg = { id: packageId, type: '赠送课程', total, used: 0, remaining, price: 80, status: 'active', isGift: true, createdAt: context.now }
    await collection.set(packageId, { packageId, studentId, studentSortIndex: rowOrder(student), sortIndex: nextSortIndex(list), data: pkg })
    // ⭐ 赠课与销售**共用同一段授权写入**（见 createCourseSale 的注释）：
    //   · 赠课没有销售 ⇒ 这里天然不存在"销售业绩转移"的可能（saleId 恒为 null）；
    //   · 授课收入仍归实际授课教练（completeBooking 写在他那本账），80 元单价写在赠课本身；
    //   · 管理权默认归**发赠课的人**，名单里的人只有授课权。
    const granted = []
    if (context && context.authorizations) {
      const auths = context.authorizations, place = { ownerCoachId: business.ownerCoachId, datasetId: business.datasetId }
      await auths.writeGrant({
        ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, packageId, studentId, coachId: business.ownerCoachId,
        status: authorization.STATUS_ACTIVE, canManage: true, grantedByCoachId: business.ownerCoachId, createdAt: context.now, updatedAt: context.now
      })
      const coaches = await authorization.coachIdsByPublicCodes(auths, payload.teachingPublicCodes)
      for (const coach of coaches) {
        if (authorization.isPlaceOwner(place, coach.coachId)) continue
        await auths.writeGrant({
          ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, packageId, studentId, coachId: coach.coachId,
          status: authorization.STATUS_ACTIVE, canManage: false, grantedByCoachId: business.ownerCoachId, createdAt: context.now, updatedAt: context.now
        })
        await upsertMemberAuth(auths, place, studentId, coach.coachId, business.ownerCoachId, authorization.SOURCE_PACKAGE_DERIVED, context.now)
        granted.push({ coachId: coach.coachId, displayName: coach.displayName })
      }
    }
    return { studentId, packageId, gift: true, saleId: null, teachingCoaches: granted }
  },

  async createCourseSale(business, payload, context) {
    requireOnly(payload, ['studentId', 'type', 'total', 'remaining', 'quantity', 'unitPrice', 'amount', 'date', 'teachingPublicCodes'])
    const studentId = text(payload.studentId, 'studentId'), studentRow = await business.collection('students').get(studentId)
    if (!studentRow) throw commandError('STUDENT_NOT_FOUND', '学员不存在或不属于当前数据集。')
    const student = businessData(studentRow), type = text(payload.type, '课程类型')
    if (type === '赠送课程') throw commandError('INVALID_PAYLOAD', '课程销售不能创建赠送课时包。')
    const total = number(payload.total, '购买课时', true), remaining = number(payload.remaining, '当前剩余'), quantity = number(payload.quantity, '销售数量', true), unitPrice = number(payload.unitPrice, '单价', true), amount = Number(number(payload.amount, '实际销售业绩', true).toFixed(2)), saleDate = date(payload.date, '业绩归属日期')
    if (!Number.isInteger(total) || !Number.isInteger(remaining) || !Number.isInteger(quantity)) throw commandError('INVALID_PAYLOAD', '课时数必须是整数。')
    const packages = business.collection('packages'), sales = business.collection('sales'), packageId = generatedBusinessId('package', business, context.requestId), saleId = generatedBusinessId('sale', business, context.requestId)
    if (await packages.get(packageId) || await sales.get(saleId)) throw commandError('ID_CONFLICT', '课程购买 ID 已存在。')
    const packageRows = await packages.list({ studentId }), saleRows = await sales.list({})
    const pkg = { id: packageId, type, total, used: 0, remaining, price: unitPrice, status: 'active', createdAt: context.now, saleDate, saleId }
    const sale = { id: saleId, source: 'course', status: 'active', studentId, packageId, typeName: type, quantity, unitPrice, amount, date: saleDate, note: `${student.name} · ${type} ${quantity}节`, createdAt: context.now }
    await packages.set(packageId, { packageId, studentId, saleId, studentSortIndex: rowOrder(studentRow), sortIndex: nextSortIndex(packageRows), data: pkg })
    await sales.set(saleId, { saleId, studentId, packageId, sortIndex: nextSortIndex(saleRows), data: sale })
    // ⭐ M2 V1：销售与授权**同一个事务**。
    //   · 创建销售的人 = 本次销售业绩归属人（sale 写在这本账，一条字节都不动）；
    //   · 创建销售的人默认拥有该课包授课权限 **+ 权限管理权**；
    //   · 勾选的可授课教练只获得**授课权**（canManage=false），
    //     ⇒ 被加入名单**不等于**获得销售业绩，也不等于获得管理权（见 §6 收入与业绩分离）。
    //   · 会员级服务关系随课包授权自动补齐（derived），避免"排得了课却看不到会员"。
    const granted = []
    if (context && context.authorizations) {
      const auths = context.authorizations, place = { ownerCoachId: business.ownerCoachId, datasetId: business.datasetId }
      await auths.writeGrant({
        ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, packageId, studentId, coachId: business.ownerCoachId,
        status: authorization.STATUS_ACTIVE, canManage: true, grantedByCoachId: business.ownerCoachId, createdAt: context.now, updatedAt: context.now
      })
      const coaches = await authorization.coachIdsByPublicCodes(auths, payload.teachingPublicCodes)
      for (const coach of coaches) {
        if (authorization.isPlaceOwner(place, coach.coachId)) continue
        await auths.writeGrant({
          ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, packageId, studentId, coachId: coach.coachId,
          status: authorization.STATUS_ACTIVE, canManage: false, grantedByCoachId: business.ownerCoachId, createdAt: context.now, updatedAt: context.now
        })
        await upsertMemberAuth(auths, place, studentId, coach.coachId, business.ownerCoachId, authorization.SOURCE_PACKAGE_DERIVED, context.now)
        granted.push({ coachId: coach.coachId, displayName: coach.displayName })
      }
    }
    return { studentId, packageId, saleId, gift: false, teachingCoaches: granted }
  },

  async updatePackage(business, payload) {
    requireOnly(payload, ['packageId', 'total', 'remaining'])
    const packageId = text(payload.packageId, 'packageId'), collection = business.collection('packages'), row = await collection.get(packageId)
    if (!row) throw commandError('PACKAGE_NOT_FOUND', '课时包不存在或不属于当前数据集。')
    const pkg = businessData(row)
    if (row.packageId !== packageId || pkg.id !== packageId) throw commandError('PACKAGE_RELATION_INVALID', '课时包标识关系不一致。')
    const sales = await business.collection('sales').list({ packageId })
    if (row.saleId || pkg.saleId || sales.length) throw commandError('PACKAGE_HAS_SALE', '有销售关联的课时包必须通过课程销售命令修改。')
    if (pkg.type !== '赠送课程') throw commandError('PACKAGE_EDIT_UNSUPPORTED', '仅允许通过此命令维护无销售关联的赠送课时包。')
    if (!has(payload, 'total') && !has(payload, 'remaining')) throw commandError('INVALID_PAYLOAD', '没有需要修改的课时包字段。')
    if (has(payload, 'total')) {
      const total = number(payload.total, '赠送课时', true)
      if (!Number.isInteger(total)) throw commandError('INVALID_PAYLOAD', '赠送课时必须是整数。')
      pkg.total = total
    }
    if (has(payload, 'remaining')) {
      const remaining = number(payload.remaining, '当前剩余')
      if (!Number.isInteger(remaining)) throw commandError('INVALID_PAYLOAD', '当前剩余必须是整数。')
      pkg.remaining = remaining
    }
    pkg.price = 80
    await collection.set(packageId, writableRow(row, { packageId, studentId: row.studentId, data: pkg }))
    return { packageId, total: pkg.total, used: pkg.used, remaining: pkg.remaining }
  },

  async deletePackage(business, payload) {
    requireOnly(payload, ['packageId'])
    const packageId = text(payload.packageId, 'packageId'), packages = business.collection('packages'), row = await packages.get(packageId)
    if (!row) throw commandError('PACKAGE_NOT_FOUND', '课时包不存在或不属于当前数据集。')
    const pkg = businessData(row), sales = await business.collection('sales').list({ packageId })
    if (row.packageId !== packageId || pkg.id !== packageId) throw commandError('PACKAGE_RELATION_INVALID', '课时包标识关系不一致。')
    if (row.saleId || pkg.saleId || sales.length) throw commandError('PACKAGE_HAS_SALE', '有销售关联的课时包必须通过撤销课程销售处理。')
    if (Number(pkg.used || 0) !== 0) throw commandError('PACKAGE_HAS_HISTORY', '课时包已有使用历史，不能删除。')
    const bookingCollection = business.collection('bookings'), bookings = await bookingCollection.list({}), linkedBookings = bookings.filter(item => item.packageId === packageId || businessData(item).packageId === packageId)
    if (linkedBookings.length) throw commandError('PACKAGE_HAS_HISTORY', '课时包已有预约或课程历史，不能删除。')
    const incomeRows = await business.collection('incomes').list({}), bookingById = new Map(bookings.map(item => [item.bookingId || businessData(item).id, item]))
    const linkedOrAmbiguousIncome = incomeRows.some(item => {
      const income = businessData(item)
      if (item.packageId === packageId || income.packageId === packageId) return true
      if ((item.studentId || income.studentId) !== row.studentId || income.typeName !== pkg.type) return false
      const booking = bookingById.get(item.bookingId || income.bookingId)
      return !booking || !(booking.packageId || businessData(booking).packageId)
    })
    if (linkedOrAmbiguousIncome) throw commandError('PACKAGE_HAS_HISTORY', '课时包存在收入历史或旧关联无法安全排除，不能删除。')
    await packages.remove(packageId)
    return { packageId, deleted: true }
  },

  async deleteStudent(business, payload, context) {
    requireOnly(payload, ['studentId'])
    const studentId = text(payload.studentId, 'studentId'), students = business.collection('students'), studentRow = await students.get(studentId)
    if (!studentRow) throw commandError('STUDENT_NOT_FOUND', '学员不存在或不属于当前数据集。')
    const student = businessData(studentRow), packages = business.collection('packages'), sales = business.collection('sales'), bookings = business.collection('bookings'), incomes = business.collection('incomes')
    const packageRows = await packages.list({ studentId }), saleRows = await sales.list({ studentId }), bookingRows = await bookings.list({ studentId }), incomeRows = await incomes.list({ studentId })
    let reversedPackages = 0, reversedCourseSales = 0, removedPendingBookings = 0, completedSnapshots = 0, incomeSnapshots = 0
    for (const row of packageRows) {
      const pkg = businessData(row)
      if (pkg.status !== 'reversed' || Number(pkg.remaining) !== 0) {
        pkg.status = 'reversed'; pkg.remaining = 0; pkg.reversedAt = context.now
        await packages.set(row.packageId, writableRow(row, { packageId: row.packageId, studentId, data: pkg })); reversedPackages += 1
      }
    }
    for (const row of saleRows) {
      const sale = businessData(row)
      if (sale.source !== 'course') continue
      if (sale.status !== 'reversed') {
        sale.status = 'reversed'; sale.reversedAt = context.now
        await sales.set(row.saleId, writableRow(row, { saleId: row.saleId, studentId, data: sale })); reversedCourseSales += 1
      }
    }
    for (const row of bookingRows) {
      const booking = businessData(row)
      if (booking.status !== 'done') { await bookings.remove(row.bookingId); removedPendingBookings += 1; continue }
      if (!booking.studentName && student.name) {
        booking.studentName = student.name
        await bookings.set(row.bookingId, writableRow(row, { bookingId: row.bookingId, studentId, data: booking })); completedSnapshots += 1
      }
    }
    for (const row of incomeRows) {
      const income = businessData(row)
      if (!income.studentName && student.name) {
        income.studentName = student.name
        await incomes.set(row.incomeId, writableRow(row, { incomeId: row.incomeId, studentId, data: income })); incomeSnapshots += 1
      }
    }
    // Packages and completed history retain this identity. Both active readers
    // require a student or tombstone; removing it alone poisons every full read.
    // Persist the existing deletion representation in the SAME transaction.
    await business.collection('student_tombstones').set(studentId, writableRow(studentRow, {
      studentId, data: { ...student, status: 'deleted', deletedAt: context.now }
    }))
    await students.remove(studentId)
    return { studentId, reversedPackages, reversedCourseSales, removedPendingBookings, completedSnapshots, incomeSnapshots }
  },

  async updateCourseSale(business, payload) {
    requireOnly(payload, ['saleId', 'packageId', 'type', 'total', 'remaining', 'quantity', 'unitPrice', 'amount', 'date', 'confirmTotalBelowUsed'])
    const saleId = text(payload.saleId, 'saleId'), packageId = text(payload.packageId, 'packageId'), sales = business.collection('sales'), packages = business.collection('packages')
    const saleRow = await sales.get(saleId), packageRow = await packages.get(packageId)
    if (!saleRow) throw commandError('SALE_NOT_FOUND', '课程销售不存在或不属于当前数据集。')
    if (!packageRow) throw commandError('PACKAGE_NOT_FOUND', '课时包不存在或不属于当前数据集。')
    const sale = businessData(saleRow), pkg = businessData(packageRow)
    if (sale.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_SALE_READ_ONLY', '历史孤立课程销售只读，不能编辑或关联课时包。')
    if (sale.source !== 'course' || sale.status === 'reversed' || pkg.status === 'reversed') throw commandError('SALE_NOT_EDITABLE', '这笔课程销售不能修改。')
    if (sale.packageId !== packageId || saleRow.packageId !== packageId || pkg.saleId !== saleId || packageRow.saleId !== saleId || sale.studentId !== packageRow.studentId || saleRow.studentId !== packageRow.studentId) throw commandError('SALE_RELATION_AMBIGUOUS', '课程销售与课时包关系不一致。')
    const matches = (await sales.list({ packageId })).filter(row => businessData(row).source === 'course')
    if (matches.length !== 1 || matches[0].saleId !== saleId) throw commandError('SALE_RELATION_AMBIGUOUS', '一个课时包对应的课程销售不唯一。')
    const studentRow = await business.collection('students').get(packageRow.studentId)
    if (!studentRow) throw commandError('STUDENT_NOT_FOUND', '销售对应学员不存在或不属于当前数据集。')
    const oldType = pkg.type, oldPrice = Number(pkg.price), nextType = has(payload, 'type') ? text(payload.type, '课程类型') : pkg.type
    if (nextType === '赠送课程') throw commandError('INVALID_PAYLOAD', '付费课程销售不能改为赠送课程。')
    const nextTotal = has(payload, 'total') ? number(payload.total, '购买课时', true) : Number(pkg.total), nextRemaining = has(payload, 'remaining') ? number(payload.remaining, '当前剩余') : Number(pkg.remaining), nextQuantity = has(payload, 'quantity') ? number(payload.quantity, '销售数量', true) : Number(sale.quantity), nextUnitPrice = has(payload, 'unitPrice') ? number(payload.unitPrice, '单价', true) : Number(sale.unitPrice == null ? pkg.price : sale.unitPrice), nextAmount = has(payload, 'amount') ? Number(number(payload.amount, '实际销售业绩', true).toFixed(2)) : Number(sale.amount), nextDate = has(payload, 'date') ? date(payload.date, '业绩归属日期') : sale.date
    if (![nextTotal, nextRemaining, nextQuantity].every(Number.isInteger)) throw commandError('INVALID_PAYLOAD', '课时数必须是整数。')
    if (nextTotal < Number(pkg.used || 0) && payload.confirmTotalBelowUsed !== true) throw commandError('TOTAL_BELOW_USED_CONFIRM_REQUIRED', '购买课时小于历史已完成课时，需要明确确认后才能保存。')
    Object.assign(pkg, { type: nextType, total: nextTotal, remaining: nextRemaining, price: nextUnitPrice, saleDate: nextDate, saleId })
    const student = businessData(studentRow)
    Object.assign(sale, { typeName: nextType, quantity: nextQuantity, unitPrice: nextUnitPrice, amount: nextAmount, date: nextDate, note: `${student.name || '已删学员'} · ${nextType} ${nextQuantity}节` })
    const bookings = business.collection('bookings'), incomes = business.collection('incomes'), bookingRows = await bookings.list({ studentId: packageRow.studentId, packageId }), incomeBookingIds = new Set((await incomes.list({})).map(row => row.bookingId || businessData(row).bookingId).filter(Boolean))
    for (const row of bookingRows) {
      const booking = businessData(row)
      if (booking.status === 'done') continue
      if (incomeBookingIds.has(row.bookingId)) continue
      if (oldType !== nextType) booking.typeName = nextType
      if (oldPrice !== nextUnitPrice) booking.price = nextUnitPrice
      await bookings.set(row.bookingId, writableRow(row, { bookingId: row.bookingId, studentId: packageRow.studentId, packageId, data: booking }))
    }
    await packages.set(packageId, writableRow(packageRow, { packageId, studentId: packageRow.studentId, saleId, data: pkg }))
    await sales.set(saleId, writableRow(saleRow, { saleId, studentId: packageRow.studentId, packageId, data: sale }))
    return { studentId: packageRow.studentId, packageId, saleId }
  },

  async reverseCourseSale(business, payload, context) {
    requireOnly(payload, ['saleId', 'packageId'])
    const saleId = text(payload.saleId, 'saleId'), sales = business.collection('sales'), saleRow = await sales.get(saleId)
    if (!saleRow) throw commandError('SALE_NOT_FOUND', '课程销售不存在或不属于当前数据集。')
    const sale = businessData(saleRow)
    if (sale.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_SALE_READ_ONLY', '历史孤立课程销售只读，不能撤销或关联课时包。')
    if (sale.source !== 'course') throw commandError('NOT_COURSE_SALE', '手工业绩不能通过课程撤销命令处理。')
    if (sale.status === 'reversed') throw commandError('SALE_ALREADY_REVERSED', '这笔课程销售已经撤销。')
    const linkedPackageId = sale.packageId || saleRow.packageId || ''
    const requestedPackageId = payload.packageId == null ? '' : text(payload.packageId, 'packageId')
    if (linkedPackageId && requestedPackageId !== linkedPackageId) throw commandError('SALE_RELATION_AMBIGUOUS', '撤销课程销售必须提交精确匹配的 packageId。')
    if (!linkedPackageId && requestedPackageId) throw commandError('SALE_RELATION_AMBIGUOUS', '孤立销售不能关联或猜测其他课时包。')
    const packages = business.collection('packages')
    if (!linkedPackageId) {
      sale.status = 'reversed'; sale.reversedAt = context.now
      await sales.set(saleId, writableRow(saleRow, { saleId, studentId: saleRow.studentId || sale.studentId || '', packageId: '', data: sale }))
      return { saleId, packageId: null, orphan: true, removedPendingBookings: 0 }
    }
    const packageRow = await packages.get(linkedPackageId)
    if (!packageRow) {
      sale.status = 'reversed'; sale.reversedAt = context.now
      await sales.set(saleId, writableRow(saleRow, { saleId, studentId: saleRow.studentId || sale.studentId || '', packageId: linkedPackageId, data: sale }))
      return { saleId, packageId: linkedPackageId, orphan: true, removedPendingBookings: 0 }
    }
    const pkg = businessData(packageRow), studentId = packageRow.studentId
    if (saleRow.packageId !== linkedPackageId || sale.packageId !== linkedPackageId || pkg.saleId !== saleId || packageRow.saleId !== saleId || sale.studentId !== studentId || saleRow.studentId !== studentId) throw commandError('SALE_RELATION_AMBIGUOUS', '课程销售与课时包关系不一致。')
    const matches = (await sales.list({ packageId: linkedPackageId })).filter(row => businessData(row).source === 'course')
    if (matches.length !== 1 || matches[0].saleId !== saleId) throw commandError('SALE_RELATION_AMBIGUOUS', '一个课时包对应的课程销售不唯一。')
    sale.status = 'reversed'; sale.reversedAt = context.now
    pkg.status = 'reversed'; pkg.remaining = 0; pkg.reversedAt = context.now
    await sales.set(saleId, writableRow(saleRow, { saleId, studentId, packageId: linkedPackageId, data: sale }))
    await packages.set(linkedPackageId, writableRow(packageRow, { packageId: linkedPackageId, studentId, saleId, data: pkg }))
    const bookings = business.collection('bookings'), bookingRows = await bookings.list({ studentId, packageId: linkedPackageId })
    let removedPendingBookings = 0
    for (const row of bookingRows) {
      if (businessData(row).status === 'done') continue
      await bookings.remove(row.bookingId); removedPendingBookings += 1
    }
    return { saleId, packageId: linkedPackageId, orphan: false, removedPendingBookings }
  },

  async createBooking(business, payload, context) {
    requireOnly(payload, ['studentId', 'packageId', 'date', 'hour', 'minute', 'plannedMinutes'])
    const studentId = text(payload.studentId, 'studentId'), packageId = text(payload.packageId, 'packageId'), moment = bookingMoment(payload)
    const studentRow = await business.collection('students').get(studentId), packageRow = await business.collection('packages').get(packageId)
    if (!studentRow) throw commandError('STUDENT_NOT_FOUND', '学员不存在或不属于当前数据集。')
    if (!packageRow) throw commandError('PACKAGE_NOT_FOUND', '指定课时包不存在或不属于当前数据集。')
    if (packageRow.studentId !== studentId) throw commandError('PACKAGE_STUDENT_MISMATCH', '指定课时包不属于该学员。')
    const student = businessData(studentRow), pkg = businessData(packageRow)
    if (student.id !== studentId || studentRow.studentId !== studentId || pkg.id !== packageId || packageRow.packageId !== packageId) throw commandError('BOOKING_PACKAGE_RELATION_INVALID', '学员与课时包标识关系不一致。')
    if (pkg.status === 'reversed') throw commandError('PACKAGE_UNAVAILABLE', '指定课时包已撤销，不能预约。')
    // ⭐ 2026-09-29 业务口径（已确认）：**余额不足就是不能排课**，课发生在过去也一样 ——
    //    事后补录不许绕过这条闸（先把课时余额处理好，再正常录入）。
    //    ⛔ 校验在云端：客户端先做了一次本机动作，不代表能写进去，云端这一条才是最终闸门。
    const remaining = Number(pkg.remaining)
    if (!Number.isFinite(remaining) || remaining <= 0) throw commandError('PACKAGE_NO_REMAINING', '这个课时包已经没有剩余课时了。请先给会员续费或增加课时，再录入这节课（事后补录也一样不能透支）。')
    // ⭐ M2 第一层门禁：remaining 有货之后，还要看「还能不能预约」。
    //    两种 0 必须分开口径与文案：remaining=0 是"用完了"；remaining>0 但 availableToBook=0 是"排满了"。
    const reserved = await occupancy.syncReserved(business, pkg)
    if (occupancy.availableToBook(pkg, reserved) <= 0) throw commandError('PACKAGE_NO_AVAILABLE', '该课时包剩余课时已全部安排课程，如需继续预约请先调整已有预约或续费。')
    const plannedMinutes = payload.plannedMinutes == null || payload.plannedMinutes === '' ? occupancy.DEFAULT_PLANNED_MINUTES : Number(payload.plannedMinutes)
    if (!Number.isInteger(plannedMinutes) || plannedMinutes <= 0 || plannedMinutes > 1440) throw commandError('INVALID_PAYLOAD', '课程预计时长必须是 1–1440 的整数分钟。')
    // ⭐ 2026-10-02 三次口径：**开始 ≤ 23:00 且 结束 ≤ 当天 24:00**（两条同时判，缺一不可）。
    //    ⛔ 少了第二条 ⇒ 23:00 起 90 分钟的课会跨到次日 00:30，而课表不再画次日片段
    //       ⇒ 造出一节"看不见却占着时间"的课。阈值只有一份（occupancy），改口径不必动这里。
    //    ⛔ **只判窗口、不判最早也不判网格**：本通道同时是「历史课程补录」入口 ——
    //       真实发生过的一节课可能是凌晨或非整点，加了最早/网格闸门就是把补录通道堵死。
    //    ⛔ 客户端 `utils/cloud-command-engine.js` 里有一份同口径副本（本机先行会在出网前拦一遍），
    //      两边必须一致，否则就会出现"本机收下、云端拒绝"。
    const gate = occupancy.lessonWindowGateOf(moment, plannedMinutes)
    if (gate) throw commandError(gate.code, gate.message)
    const bookings = business.collection('bookings'), list = await bookings.list({})
  // ⭐ 服务端最终校验 ①：授课教练这个时间没冲突（**不信任客户端页面当前显示的数据**）。
  if (list.some(row => overlaps(row, moment, null, plannedMinutes))) throw commandError('BOOKING_TIME_CONFLICT', '该教练这个时段已经有课了。')
    // ⭐ 服务端最终校验 ②：会员这个时间没冲突。
    //    这位会员的预约可能还散落在**别的教练**那本账里（别的教练也在给他上课），
    //    账本清单只从服务端登记过的事实推导（本账 + 用过共享码的账），客户端提交不了。
    const share = await context.shares.findActiveByPackage(packageId)
    const memberConflict = await teaching.findMemberTimeConflict({
      businessAt: context.businessAt,
      places: [{ ownerCoachId: business.ownerCoachId, datasetId: business.datasetId }, ...sharing.redeemerPlacesOf(share)],
      studentId, moment, plannedMinutes
    })
    if (memberConflict) throw commandError('MEMBER_TIME_CONFLICT', '该会员这个时段已经有课了，请换一个时间。')
    const bookingId = generatedBusinessId('booking', business, context.requestId)
    if (await bookings.get(bookingId)) throw commandError('ID_CONFLICT', '预约 ID 已存在。')
    const typeName = text(pkg.type, '课程类型'), price = typeName === '赠送课程' ? 80 : Number(pkg.price)
    if (!Number.isFinite(price) || price < 0) throw commandError('PACKAGE_PRICE_INVALID', '课时包价格无效，不能创建预约。')
    // ⭐ 谁发起 / 谁授课：教练端发起 ⇒ 授课教练默认就是当前教练。课时归会员，与谁创建无关。
    const identity = teaching.identityFor(business, payload)
    // plannedMinutes 是这节课**预约时确定的**时长快照（默认 60）。以后改系统默认值也不影响它。
    const booking = { id: bookingId, studentId, studentName: student.name || '已删学员', packageId, ...moment, typeName, price, plannedMinutes, status: 'booked', createdAt: context.now, ...identity }
    await bookings.set(bookingId, { bookingId, studentId, packageId, sortIndex: nextSortIndex(list), data: booking })
    // ⭐ 预约即占座：reserved +1（remaining / used 一律不动）。这是"最后一节只能一个人抢到"的支点。
    await occupancy.applyDelta(business, pkg, 1)
    await business.collection('packages').set(packageId, writableRow(packageRow, { packageId, studentId, ...(packageRow.saleId || pkg.saleId ? { saleId: packageRow.saleId || pkg.saleId } : {}), data: pkg }))
    // ⭐ 2026-10-05（用户最终决定）：**教练安排课程 ⇒ 通知对应会员**（六种状态之一）。
    //   少了这一条，"教练给你排了一节课"根本不会进事件表 ⇒ 会员永远收不到"被安排"的通知。
    //   ⛔ 只是**在事务内登记一条事件**（`recordBookingChange` 认不出会员就返回 null、不产生事件），
    //      不碰预约内核的任何判定；与取消 / 改期那两条走**同一张表、同一套幂等**。
    await recordBookingChange(context, booking, { type: notifyTypes.COACH_CREATED, bookingId, now: context.now }, business)
    return { bookingId, studentId, packageId, plannedMinutes, teachingCoachId: identity.teachingCoachId, source: identity.source }
  },

  // M2：开启 / 关闭"这个课时包允许别的教练排课"。
  //   只做两件事：① 生成（或复用）一枚共享码 ② **顺手完成 reserved 惰性初始化**。
  //   ② 是硬要求，不是顺手：它保证「共享预约出现之前，这份包的占座数已经是准的」，
  //     于是以后所有共享预约只需 ±1，永远不需要跨教练去数别人的预约（见 sharing.js 顶部的不变量）。
  //   幂等：重复开启返回**同一枚**共享码（不会每次点一下就换一个码，把已发出的码作废）。
  async setPackageShare(business, payload, context) {
    requireOnly(payload, ['packageId', 'enabled'])
    const packageId = text(payload.packageId, 'packageId'), collection = business.collection('packages'), row = await collection.get(packageId)
    if (!row) throw commandError('PACKAGE_NOT_FOUND', '课时包不存在或不属于当前数据集。')
    const pkg = businessData(row)
    if (row.packageId !== packageId || pkg.id !== packageId) throw commandError('PACKAGE_RELATION_INVALID', '课时包标识关系不一致。')
    if (pkg.status === 'reversed') throw commandError('PACKAGE_UNAVAILABLE', '课时包已撤销，不能共享。')
    const studentId = text(row.studentId || pkg.studentId || '', 'package.studentId')
    const enabled = payload.enabled !== false
    const existing = await context.shares.findActiveByPackage(packageId)
    if (enabled) {
      if (existing) return { packageId, studentId, shareCode: existing.shareCode, shared: true, reused: true }
      // ⭐ 先把占座数对齐到"当前真有几条有效预约"，再发码。
      await occupancy.syncReserved(business, pkg)
      await collection.set(packageId, writableRow(row, { packageId, studentId, ...(row.saleId || pkg.saleId ? { saleId: row.saleId || pkg.saleId } : {}), data: pkg }))
      // ⭐ M3-P2-3：8 位短码的空间比原来的 10 位十六进制小 ⇒ **生成时必须查重**。
      //   ⛔ 为什么这条不能省：`shares.write` 是 `doc(fixedId(码)).set()` ⇒ 撞码**不是报错**，
      //      而是**静默覆盖**上一条共享许可 —— B 教练手上那枚旧码会突然指向另一位会员的课时包。
      //   查在**同一个事务**里（`context.shares` 就是事务内的那本账）⇒ 查到的一定是已提交的事实。
      let shareCode = sharing.newShareCode()
      for (let attempt = 1; await context.shares.findByCode(shareCode); attempt += 1) {
        if (attempt >= 5) throw commandError('SHARE_CODE_COLLISION', '共享码生成失败，请稍后重试。')
        shareCode = sharing.newShareCode()
      }
      const share = {
        shareCode, ownerCoachId: business.ownerCoachId, datasetId: business.datasetId,
        packageId, studentId, status: sharing.SHARE_ACTIVE, createdAt: context.now
      }
      await context.shares.write(share)
      return { packageId, studentId, shareCode: share.shareCode, shared: true, reused: false }
    }
    if (!existing) return { packageId, studentId, shareCode: '', shared: false, revoked: false }
    await context.shares.write({ ...existing, status: sharing.SHARE_REVOKED, revokedAt: context.now })
    // ⚠️ 撤销**只影响新建**：已经排上的共享预约照常上课 / 取消 / 完课（它们的定位在 booking.packageUsage 上）。
    return { packageId, studentId, shareCode: existing.shareCode, shared: false, revoked: true }
  },

  // M2：用共享码排一节**别人家课时包**的课。
  //   · 预约文档落在**授课教练**（调用方）这本账 ⇒ 出现在他的课表上；完课收入也自然归他。
  //   · 占座 +1 写在**课时包所属教练**那本账的 package 上 ⇒ 用的是同一个 remaining、同一个 reserved。
  //   · 两本账各 +1 个 revision、各写一张收据（对端那张命令名是 sharedPackageSync）。
  async createSharedBooking(business, payload, context) {
    requireOnly(payload, ['shareCode', 'date', 'hour', 'minute', 'plannedMinutes'])
    const shareCode = sharing.normalizeShareCode(payload.shareCode)
    const share = await context.shares.findByCode(shareCode)
    if (!share) throw commandError('SHARE_NOT_FOUND', '共享码无效，请向生成该码的教练重新索取（共享码仅为过渡期测试通道）。')
    if (share.status !== sharing.SHARE_ACTIVE) throw commandError('SHARE_REVOKED', '这个共享码已被撤销，不能继续排课。')
    // 课时事实就在自己这本账里 ⇒ 直接走 createBooking，没必要绕一圈，也避免"同一本账里出现两份定位"。
    if (share.ownerCoachId === business.ownerCoachId) throw commandError('SHARE_SELF_NOT_ALLOWED', '这位会员的课时事实就在你这本账里，请直接预约，不需要用共享码。')
    const peer = context.businessAt(share.ownerCoachId, share.datasetId)
    const plannedMinutes = payload.plannedMinutes == null || payload.plannedMinutes === '' ? occupancy.DEFAULT_PLANNED_MINUTES : Number(payload.plannedMinutes)
    const moment = bookingMoment(payload)
    const result = await createBookingOnForeignPackage({
      business, context, peer, usage: sharing.usageOf(share),
      studentId: share.studentId, packageId: share.packageId, moment, plannedMinutes,
      // 再加上用过这枚码的其他教练的账本。少了任何一本，都会出现"同一会员同一时间上两节课"。
      extraPlaces: sharing.redeemerPlacesOf(share)
    })
    // 登记"这本账用过这枚码" ⇒ 以后任何人给这位会员排课，服务端都知道要来这里查时间冲突。
    await context.shares.markRedeemer(share.shareCode || shareCode, { ownerCoachId: business.ownerCoachId, datasetId: business.datasetId })
    context.attachPeer({ ownerCoachId: share.ownerCoachId, datasetId: share.datasetId, result: { packageId: share.packageId, bookingId: result.bookingId } })
    return result
  },

  // M2 V1 正式多教练服务模型：**用授权课包排课**（不再需要共享码）。
  //   客户端只提交 (studentId, packageId)；**这份课包在哪本账**由服务端从授权记录推导，
  //   客户端永远无法指定别人的账本（与共享码同一条安全边界）。
  //   ⛔ 两层权限都在云端判：会员级服务关系 + 课包级授课授权，缺一层就报对应的码。
  async createAuthorizedBooking(business, payload, context) {
    requireOnly(payload, ['studentId', 'packageId', 'date', 'hour', 'minute', 'plannedMinutes'])
    const auths = requireAuthorizations(context)
    const studentId = text(payload.studentId, 'studentId'), packageId = text(payload.packageId, 'packageId')
    const moment = bookingMoment(payload)
    const plannedMinutes = payload.plannedMinutes == null || payload.plannedMinutes === '' ? occupancy.DEFAULT_PLANNED_MINUTES : Number(payload.plannedMinutes)
    const { place, shared, grant } = await authorization.resolveBookingPlace({
      auths, business, context, studentId, packageId, coachId: business.ownerCoachId
    })
    if (!shared) {
      // 这份课包就在自己这本账 ⇒ 走既有 createBooking（老流程逐字不变，owner 天然有全部权限）。
      return handlers.createBooking(business, { studentId, packageId, date: moment.date, hour: moment.hour, minute: moment.minute, plannedMinutes }, context)
    }
    // ⭐ 双层权限闸：会员级 + 课包级，**都在云端可信身份下判**。
    await authorization.assertMayBook(auths, place, studentId, packageId, business.ownerCoachId)
    const peer = context.businessAt(place.ownerCoachId, place.datasetId)
    const result = await createBookingOnForeignPackage({
      business, context, peer,
      usage: { packageId, studentId, ownerCoachId: place.ownerCoachId, datasetId: place.datasetId },
      studentId, packageId, moment, plannedMinutes,
      // 会员时间冲突要查**所有已知服务这位会员的教练**的账本（不只是课时包所在那本）。
      extraPlaces: await authorization.knownMemberPlaces({ auths, place, studentId, packageId })
    })
    context.attachPeer({ ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, result: { packageId, bookingId: result.bookingId } })
    return { ...result, authorized: true, managedByMe: !!(grant && grant.canManage) }
  },

  // M2 V1：授予**会员级**服务关系（决定谁能在这份档案上看到这位会员）。
  async grantMemberService(business, payload, context) {
    requireOnly(payload, ['studentId', 'publicCodes'])
    const auths = requireAuthorizations(context)
    const studentId = text(payload.studentId, 'studentId')
    const { place } = await resolveMemberPlace({ business, context, auths, studentId })
    const coaches = await authorization.coachIdsByPublicCodes(auths, payload.publicCodes)
    const granted = []
    for (const coach of coaches) {
      if (authorization.isPlaceOwner(place, coach.coachId)) continue
      granted.push(await upsertMemberAuth(auths, place, studentId, coach.coachId, business.ownerCoachId, authorization.SOURCE_EXPLICIT, context.now))
    }
    return { studentId, place, granted: granted.map(row => ({ coachId: row.coachId, displayName: row.displayName })) }
  },

  async revokeMemberService(business, payload, context) {
    requireOnly(payload, ['studentId', 'publicCode'])
    const auths = requireAuthorizations(context)
    const studentId = text(payload.studentId, 'studentId')
    const { place } = await resolveMemberPlace({ business, context, auths, studentId })
    const [target] = await authorization.coachIdsByPublicCodes(auths, [payload.publicCode])
    if (authorization.isPlaceOwner(place, target.coachId)) throw commandError('CANNOT_REVOKE_OWNER', '不能撤销账本所有者自己的权限。')
    // ⛔ 还有有效课包授权 ⇒ 不许撤会员级关系（教学关系还成立，撤了就是"看得见排不了"的死局）。
    const grants = (await auths.grantsForCoach(target.coachId, 'package')).filter(row => row.ownerCoachId === place.ownerCoachId && row.datasetId === place.datasetId && row.studentId === studentId)
    if (grants.length) throw commandError('MEMBER_SERVICE_REQUIRED_BY_PACKAGE_GRANT', '这位教练还有该会员的课时包授课授权，请先撤销课包授权。')
    const row = await auths.findMember(place, studentId, target.coachId)
    if (!row || row.status !== authorization.STATUS_ACTIVE) throw commandError('MEMBER_SERVICE_NOT_FOUND', '这位教练本来就没有该会员的服务关系。')
    await auths.writeMember({ ...row, status: authorization.STATUS_REVOKED, revokedAt: context.now, revokedByCoachId: business.ownerCoachId, updatedAt: context.now })
    return { studentId, coachId: target.coachId, revoked: true }
  },

  // M2 V1：授予**课包级**授课授权（决定谁能用这一份具体课包排课）。
  //   顺带补齐会员级服务关系（derived）—— 有课包授权却看不到会员，是另一种死局。
  async grantPackageTeaching(business, payload, context) {
    requireOnly(payload, ['packageId', 'publicCodes'])
    const auths = requireAuthorizations(context)
    const packageId = text(payload.packageId, 'packageId')
    const { place, studentId } = await resolvePackagePlace({ business, context, auths, packageId, forManage: true })
    const coaches = await authorization.coachIdsByPublicCodes(auths, payload.publicCodes)
    const granted = []
    for (const coach of coaches) {
      if (authorization.isPlaceOwner(place, coach.coachId)) continue
      const existing = await auths.findGrant(place, packageId, coach.coachId)
      await auths.writeGrant({
        ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, packageId, studentId, coachId: coach.coachId,
        status: authorization.STATUS_ACTIVE, canManage: false,
        grantedByCoachId: business.ownerCoachId, createdAt: (existing && existing.createdAt) || context.now, updatedAt: context.now
      })
      // ⭐ 无条件 upsert（而不是"没有才建"）：会员可能是在授权之后才认领自己档案的，
      //    只有每次授予都回读一次认领表，memberId 才会补上（upsert 内部保留 explicit 来源）。
      await upsertMemberAuth(auths, place, studentId, coach.coachId, business.ownerCoachId, authorization.SOURCE_PACKAGE_DERIVED, context.now)
      granted.push({ coachId: coach.coachId, displayName: coach.displayName })
    }
    return { packageId, studentId, place, granted }
  },

  async revokePackageTeaching(business, payload, context) {
    requireOnly(payload, ['packageId', 'publicCode'])
    const auths = requireAuthorizations(context)
    const packageId = text(payload.packageId, 'packageId')
    const { place, studentId } = await resolvePackagePlace({ business, context, auths, packageId, forManage: true })
    const [target] = await authorization.coachIdsByPublicCodes(auths, [payload.publicCode])
    if (authorization.isPlaceOwner(place, target.coachId)) throw commandError('CANNOT_REVOKE_OWNER', '不能撤销账本所有者自己的授课授权。')
    const row = await auths.findGrant(place, packageId, target.coachId)
    if (!row || row.status !== authorization.STATUS_ACTIVE) throw commandError('PACKAGE_GRANT_NOT_FOUND', '这位教练本来就没有这份课时包的授课授权。')
    // ⛔ 铁律：还有未完成预约 ⇒ **必须先处理预约**，绝不静默删除 / 取消 / 改派 / 释放 reserved。
    // ⚠️ 没有 `confirm` 这种"强行放行"开关：一旦开，就等于允许"课还在、人已经被移除"的死局。
    //    未完成预约只能由授课教练先取消或完成 —— 那才是处理预约，不是绕过预约。
    const future = await authorization.futureBookingsOfCoach({ auths, context, packageId, coachId: target.coachId })
    if (future.length) {
      throw commandError('COACH_HAS_FUTURE_BOOKINGS', `这位教练在这份课时包上还有 ${future.length} 节未完成预约，请先取消或完成后再移除。`, { futureBookings: future })
    }
    await auths.writeGrant({ ...row, status: authorization.STATUS_REVOKED, canManage: false, revokedAt: context.now, revokedByCoachId: business.ownerCoachId, updatedAt: context.now })
    // 会员级关系若是"授予课包时自动补的"，且已无其它有效课包授权 ⇒ 一并收掉；
    // 若是教练显式授予的 ⇒ **保留**（显式意图不会被派生关系的撤销误删）。
    const remaining = (await auths.grantsForCoach(target.coachId, 'package')).filter(item => item.ownerCoachId === place.ownerCoachId && item.datasetId === place.datasetId && item.studentId === studentId && item.packageId !== packageId)
    const memberAuth = await auths.findMember(place, studentId, target.coachId)
    if (memberAuth && memberAuth.status === authorization.STATUS_ACTIVE && memberAuth.source === authorization.SOURCE_PACKAGE_DERIVED && !remaining.length) {
      await auths.writeMember({ ...memberAuth, status: authorization.STATUS_REVOKED, revokedAt: context.now, updatedAt: context.now })
    }
    return { packageId, coachId: target.coachId, revoked: true, releasedFutureBookings: future.length }
  },

  // M2 V1：指定接管人 —— **只转移授课权限的管理权**。
  //   历史 sale.owner / 销售金额 / 已完成课程 / 收入**一个字节都不动**。
  async transferPackageManagement(business, payload, context) {
    requireOnly(payload, ['packageId', 'publicCode'])
    const auths = requireAuthorizations(context)
    const packageId = text(payload.packageId, 'packageId')
    const { place } = await resolvePackagePlace({ business, context, auths, packageId, forManage: true })
    const [target] = await authorization.coachIdsByPublicCodes(auths, [payload.publicCode])
    if (authorization.isPlaceOwner(place, target.coachId)) throw commandError('CANNOT_TRANSFER_TO_OWNER', '账本所有者本身就是权限管理人，不需要接管。')
    const targetGrant = await auths.findGrant(place, packageId, target.coachId)
    if (!targetGrant || targetGrant.status !== authorization.STATUS_ACTIVE) throw commandError('GRANT_TARGET_NOT_TEACHING_COACH', '接管人必须先拥有这份课时包的授课授权。')
    await auths.writeGrant({ ...targetGrant, canManage: true, updatedAt: context.now })
    let previousManagerCoachId = place.ownerCoachId
    if (!authorization.isPlaceOwner(place, business.ownerCoachId)) {
      const mine = await auths.findGrant(place, packageId, business.ownerCoachId)
      if (mine) await auths.writeGrant({ ...mine, canManage: false, updatedAt: context.now })
      previousManagerCoachId = business.ownerCoachId
    }
    return { packageId, managerCoachId: target.coachId, previousManagerCoachId, transferred: true }
  },

  async updateBookingContent(business, payload) {
    requireOnly(payload, ['bookingId', 'items', 'notes', 'category', 'duration', 'summary'])
    const bookingId = text(payload.bookingId, 'bookingId'), collection = business.collection('bookings'), row = await collection.get(bookingId)
    if (!row) throw commandError('BOOKING_NOT_FOUND', '预约不存在或不属于当前数据集。')
    const booking = businessData(row), supplied = ['items', 'notes', 'category', 'duration', 'summary'].filter(key => has(payload, key))
    if (booking.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_BOOKING_READ_ONLY', '历史孤立课程只读，不能修改训练内容。')
    if (row.bookingId !== bookingId || booking.id !== bookingId) throw commandError('BOOKING_RELATION_INVALID', '预约标识关系不一致。')
    // ⭐ M2 V1：只有这节课的**授课教练**能改它的训练内容（前端参数冒充不了 —— 判定只用服务端可信身份）。
    assertTeachingCoach(business, booking, '修改训练内容')
    if (!supplied.length) throw commandError('INVALID_PAYLOAD', '没有需要保存的课程内容。')
    if (booking.status !== 'booked' && booking.status !== 'done') throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能修改课程内容。')
    if (has(payload, 'items')) {
      if (!Array.isArray(payload.items)) throw commandError('INVALID_PAYLOAD', 'items 必须是数组。')
      booking.items = clone(payload.items)
    }
    if (has(payload, 'notes')) booking.notes = String(payload.notes == null ? '' : payload.notes)
    if (has(payload, 'category')) booking.category = text(payload.category, '课程分类')
    if (has(payload, 'duration')) {
      const duration = number(payload.duration, '课程时长', true)
      if (!Number.isInteger(duration)) throw commandError('INVALID_PAYLOAD', '课程时长必须是整数分钟。')
      booking.duration = duration
    }
    if (has(payload, 'summary')) booking.summary = String(payload.summary == null ? '' : payload.summary)
    else if (booking.status === 'done' && supplied.some(key => ['items', 'notes', 'category', 'duration'].includes(key))) booking.summary = rebuildSummary(booking)
    await collection.set(bookingId, writableRow(row, { bookingId, studentId: row.studentId || booking.studentId, packageId: row.packageId || booking.packageId, data: booking }))
    return { bookingId, status: booking.status, updatedFields: supplied }
  },

  async rescheduleBooking(business, payload, context) {
    requireOnly(payload, ['bookingId', 'date', 'hour', 'minute'])
    const bookingId = text(payload.bookingId, 'bookingId'), moment = bookingMoment(payload), bookings = business.collection('bookings'), row = await bookings.get(bookingId)
    if (!row) throw commandError('BOOKING_NOT_FOUND', '预约不存在或不属于当前数据集。')
    const original = businessData(row)
    if (original.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_BOOKING_READ_ONLY', '历史孤立课程只读，不能改期。')
    if (row.bookingId !== bookingId || original.id !== bookingId) throw commandError('BOOKING_RELATION_INVALID', '预约标识关系不一致。')
    // ⭐ 改期同样要过「入口时间窗」（与新建同一把尺）。少了它，先约 10:00 再改到 23:45 就能绕过规则。
    //    ⭐ 2026-10-03：与 createBooking 一致 —— 最早也判（06:00），那个"补录不判最早"的口子同样关闭。
    //       存量 00:00–05:59 的历史课不动它就不会经过这道闸（闸门管入口，不改存量）。30 分钟网格仍不在这里判。
    //    ⛔ 23:30 **不再能**改过去（2026-10-01 二次口径：取消 23:30 开课，跨午夜不再作为 MVP 能力）。
    //       存量的 23:30 课只要不动它，就**不会**经过这道闸（闸门管入口，不改存量）。
    //    ⚠️ 改期命令契约里**没有** plannedMinutes ⇒ 用这节课预约时落库的时长快照（老预约按 60 兜底）。
    const gate = occupancy.lessonWindowGateOf(moment, occupancy.plannedMinutesOf(original))
    if (gate) throw commandError(gate.code, gate.message)
    const list = await bookings.list({})
    if (list.some(item => overlaps(item, moment, bookingId, occupancy.plannedMinutesOf(original)))) throw commandError('BOOKING_TIME_CONFLICT', '该教练这个时段已经有课了。')
    // ⭐ 改期同样要做**会员时间**校验（会员的时间是共享的，与哪本账无关）。
    const usage = sharing.usageOfBooking(original)
    const rescheduleShare = await context.shares.findActiveByPackage(row.packageId || original.packageId)
    const memberConflict = await teaching.findMemberTimeConflict({
      businessAt: context.businessAt,
      places: [
        { ownerCoachId: business.ownerCoachId, datasetId: business.datasetId },
        ...(usage ? [{ ownerCoachId: usage.ownerCoachId, datasetId: usage.datasetId }] : []),
        ...sharing.redeemerPlacesOf(rescheduleShare)
      ],
      studentId: row.studentId || original.studentId, moment, ignoredBookingId: bookingId,
      plannedMinutes: occupancy.plannedMinutesOf(original)
    })
    if (memberConflict) throw commandError('MEMBER_TIME_CONFLICT', '该会员这个时段已经有课了，请换一个时间。')
    const booking = original
    if (booking.status !== 'booked' && booking.status !== 'done') throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能改期。')
    Object.assign(booking, moment)
    if (booking.status === 'done') {
      const incomes = business.collection('incomes'), matches = (await incomes.list({ bookingId })).filter(item => (item.bookingId || businessData(item).bookingId) === bookingId)
      if (matches.length !== 1) throw commandError('INCOME_RELATION_AMBIGUOUS', '已完成课程必须且只能关联一条收入记录。')
      const incomeRow = matches[0], income = businessData(incomeRow)
      const incomeBookingMismatch = income.bookingId && income.bookingId !== bookingId
      const incomeIdMismatch = income.id && income.id !== incomeRow.incomeId
      if (incomeRow.bookingId !== bookingId || incomeBookingMismatch || incomeIdMismatch) throw commandError('INCOME_RELATION_AMBIGUOUS', '已完成课程与收入记录关系不一致。')
      income.date = booking.date; income.time = bookingTime(booking)
      booking.summary = rebuildSummary(booking)
      await incomes.set(incomeRow.incomeId, writableRow(incomeRow, { incomeId: incomeRow.incomeId, studentId: incomeRow.studentId || booking.studentId, bookingId, data: income }))
    }
    await bookings.set(bookingId, writableRow(row, { bookingId, studentId: row.studentId || booking.studentId, packageId: row.packageId || booking.packageId, data: booking }))
    // M3-P6 · 规则 6 的接入点：教练改期会员的课 ⇒ 记一条"要通知这位会员"的事件（同一事务）。
    await recordBookingChange(context, booking, { type: notifyTypes.COACH_RESCHEDULED, bookingId, now: context.now }, business)
    return { bookingId, status: booking.status, incomeSynced: booking.status === 'done' }
  },

  async cancelBooking(business, payload, context) {
    requireOnly(payload, ['bookingId'])
    const bookingId = text(payload.bookingId, 'bookingId'), bookings = business.collection('bookings'), row = await bookings.get(bookingId)
    if (!row) throw commandError('BOOKING_NOT_FOUND', '预约不存在或不属于当前数据集。')
    const booking = businessData(row)
    if (booking.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_BOOKING_READ_ONLY', '历史孤立课程只读，不能取消。')
    if (row.bookingId !== bookingId || booking.id !== bookingId) throw commandError('BOOKING_RELATION_INVALID', '预约标识关系不一致。')
    if (booking.status === 'done') throw commandError('BOOKING_ALREADY_DONE', '已完成课程不能取消，请使用删除已完成课程。')
    if (booking.status !== 'booked') throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能取消。')
    // ⭐ M2：取消释放占座（reserved −1；remaining / used 一律不动）。
    //    顺序铁律：**先数（这条还在，会被算进 reserved）→ 再 −1 → 再删文档**。顺序反了会多释放一节。
    //    M2 第二批：共享预约的课时包在**别人的账**里，占座要释放在那一本账上（同一个事务）。
    const packageId = text(booking.packageId || row.packageId || '', 'booking.packageId', true)
    if (packageId) {
      const { space, packageRow, shared, attach } = await bookingPackageSpace(business, context, row, booking)
      if (packageRow) {
        const pkg = businessData(packageRow)
        await occupancy.applyDelta(space, pkg, -1)
        await space.collection('packages').set(packageId, writableRow(packageRow, { packageId, studentId: booking.studentId, ...(packageRow.saleId || pkg.saleId ? { saleId: packageRow.saleId || pkg.saleId } : {}), data: pkg }))
        if (shared) attach({ bookingId })
      }
    }
    await bookings.remove(bookingId)
    // M3-P6 · 规则 6 的接入点：教练取消了会员的课 ⇒ 记一条"要通知这位会员"的事件。
    //   ⛔ 顺序：**先真的写完**（占座释放 + 文档移除），最后才记事件 ——
    //      反过来的话，任何后面的失败都会留下一句"课已取消"的假通知。
    await recordBookingChange(context, booking, { type: notifyTypes.COACH_CANCELLED, bookingId, now: context.now }, business)
    return { bookingId, packageId, cancelled: true }
  },
  // M2：「课程未进行」—— 教练对「待确认」课程的人工处置之一（另一条是直接用 completeBooking 确认完成）。
  //   只释放占座：reserved −1；remaining / used 一律不变；不产生收入。
  //   ⚠️ 系统**永远不会自动**执行它：待确认只负责提醒，绝不替教练判断现实中课程是否发生。
  //   幂等：执行后该预约不再是 booked ⇒ 重复点击命中 BOOKING_STATUS_INVALID，不可能重复释放。
  async markBookingNotHeld(business, payload, context) {
    requireOnly(payload, ['bookingId'])
    const bookingId = text(payload.bookingId, 'bookingId'), bookings = business.collection('bookings'), row = await bookings.get(bookingId)
    if (!row) throw commandError('BOOKING_NOT_FOUND', '预约不存在或不属于当前数据集。')
    const booking = businessData(row)
    if (booking.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_BOOKING_READ_ONLY', '历史孤立课程只读。')
    if (row.bookingId !== bookingId || booking.id !== bookingId) throw commandError('BOOKING_RELATION_INVALID', '预约标识关系不一致。')
    if (booking.status === 'done') throw commandError('BOOKING_ALREADY_DONE', '课程已完成，不能标记为未进行。')
    if (booking.status !== 'booked') throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能标记为未进行。')
    const incomes = business.collection('incomes'), linked = (await incomes.list({ bookingId })).filter(item => (item.bookingId || businessData(item).bookingId) === bookingId)
    if (linked.length) throw commandError('INCOME_RELATION_AMBIGUOUS', '该预约已经存在收入记录，不能标记为未进行。')
    const packageId = text(booking.packageId || row.packageId || '', 'booking.packageId', true)
    if (packageId) {
      const { space, packageRow, shared, attach } = await bookingPackageSpace(business, context, row, booking)
      if (packageRow) {
        const pkg = businessData(packageRow)
        await occupancy.applyDelta(space, pkg, -1)
        await space.collection('packages').set(packageId, writableRow(packageRow, { packageId, studentId: booking.studentId, ...(packageRow.saleId || pkg.saleId ? { saleId: packageRow.saleId || pkg.saleId } : {}), data: pkg }))
        if (shared) attach({ bookingId })
      }
    }
    // 与 cancelBooking 同口径：移除预约文档（避免课表出现"幽灵未进行课程"）。
    // "未进行"这件事本身由命令回执（receipt）留痕 —— 那是本项目既有的事实账本。
    await bookings.remove(bookingId)
    return { bookingId, packageId, notHeld: true }
  },

  async completeBooking(business, payload, context) {
    requireOnly(payload, ['bookingId'])
    const bookingId = text(payload.bookingId, 'bookingId'), bookings = business.collection('bookings'), bookingRow = await bookings.get(bookingId)
    if (!bookingRow) throw commandError('BOOKING_NOT_FOUND', '预约不存在或不属于当前数据集。')
    const booking = businessData(bookingRow)
    if (booking.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_BOOKING_READ_ONLY', '历史孤立课程只读，不能再次完课。')
    if (booking.status !== 'booked') {
      if (booking.status === 'done') throw commandError('BOOKING_ALREADY_DONE', '课程已经完成。')
      throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能完成。')
    }
    // ⭐ M2 V1：只有这节课的**授课教练**能完成它（收入归授课教练这条规则的服务端落地）。
    //    客户端提交 teachingCoachId 毫无用处 —— 判定只认服务端可信身份。
    assertTeachingCoach(business, booking, '完成课程')
    // M2 第二批：共享预约的课时包在**别人的账**里 —— 扣课时 / 释放占座都发生在那一本账（同一个事务）。
    // ⭐ 「收入归授课教练」在这里是自然的：income 写在 `business`（= 授课教练）这本账里，
    //    而课时扣在 `space`（= 课时包所属教练）那本账里。**不会**因为用了 A 的课就把收入记给 A。
    const packageId = text(booking.packageId || bookingRow.packageId, 'booking.packageId')
    const { space, packageRow, shared, attach } = await bookingPackageSpace(business, context, bookingRow, booking)
    if (!packageRow) throw commandError('PACKAGE_NOT_FOUND', '预约指定的课时包不存在或不属于当前数据集。')
    const pkg = businessData(packageRow), studentId = text(booking.studentId || bookingRow.studentId, 'booking.studentId')
    if (booking.id !== bookingId || bookingRow.studentId !== studentId || bookingRow.packageId !== packageId || pkg.id !== packageId || packageRow.packageId !== packageId || packageRow.studentId !== studentId || pkg.type !== booking.typeName) throw commandError('BOOKING_PACKAGE_RELATION_INVALID', '预约与课时包关系不一致。')
    if (pkg.status === 'reversed') throw commandError('PACKAGE_UNAVAILABLE', '预约指定的课时包已撤销，不能完成课程。')
    const remaining = Number(pkg.remaining), used = Number(pkg.used || 0)
    if (!Number.isFinite(remaining) || remaining <= 0) throw commandError('PACKAGE_NO_REMAINING', '预约指定的课时包剩余课时不足。')
    if (!Number.isFinite(used) || used < 0) throw commandError('PACKAGE_USAGE_INVALID', '课时包历史使用数量异常。')
    const items = Array.isArray(booking.items) ? booking.items : []
    if (booking.typeName !== '拉伸恢复' && !items.length) throw commandError('TRAINING_ITEMS_REQUIRED', '常规课程请先保存训练动作。')
    const incomes = business.collection('incomes'), linkedIncomes = (await incomes.list({ bookingId })).filter(row => (row.bookingId || businessData(row).bookingId) === bookingId)
    if (linkedIncomes.length) throw commandError('INCOME_RELATION_AMBIGUOUS', '该预约已经存在收入记录，不能重复完课。')
    const incomeId = generatedBusinessId('income', business, context.requestId)
    if (await incomes.get(incomeId)) throw commandError('ID_CONFLICT', '收入记录 ID 已存在。')
    const category = booking.typeName === '拉伸恢复' ? '拉伸恢复' : (booking.category || '综合训练'), studentName = booking.studentName || '已删学员', completedAt = context.now
    // ⭐ M2：完课释放占座（reserved −1）。顺序：先数（这条仍是 booked）→ 再 −1 → 再改状态。
    //    上方 `remaining <= 0 拒绝` 是第二层数据安全门禁，**保留不动**（预约到完课之间数据可能已变）。
    await occupancy.applyDelta(space, pkg, -1)
    Object.assign(booking, { status: 'done', studentName, category, completedAt, summary: rebuildSummary({ ...booking, category }) })
    pkg.used = used + 1; pkg.remaining = remaining - 1
    const amount = pkg.type === '赠送课程' ? 80 : Number(booking.price)
    if (!Number.isFinite(amount) || amount < 0) throw commandError('BOOKING_PRICE_INVALID', '预约价格快照无效，不能生成历史收入。')
    const income = { id: incomeId, bookingId, date: booking.date, time: bookingTime(booking), studentId, studentName, typeName: booking.typeName, category, amount }
    await bookings.set(bookingId, writableRow(bookingRow, { bookingId, studentId, packageId, data: booking }))
    await space.collection('packages').set(packageId, writableRow(packageRow, { packageId, studentId, ...(packageRow.saleId || pkg.saleId ? { saleId: packageRow.saleId || pkg.saleId } : {}), data: pkg }))
    if (shared) attach({ bookingId, incomeId })
    const incomeRows = await incomes.list({})
    await incomes.set(incomeId, { incomeId, bookingId, studentId, packageId, sortIndex: nextSortIndex(incomeRows), data: income })
    return { bookingId, packageId, incomeId, amount }
  },

  async deleteCompletedBooking(business, payload, context) {
    requireOnly(payload, ['bookingId'])
    const bookingId = text(payload.bookingId, 'bookingId'), bookings = business.collection('bookings'), bookingRow = await bookings.get(bookingId)
    if (!bookingRow) throw commandError('BOOKING_NOT_FOUND', '已完成课程不存在或不属于当前数据集。')
    const booking = businessData(bookingRow)
    if (booking.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_BOOKING_READ_ONLY', '历史孤立课程只读，无法确定原课时包时不能删除或返课。')
    if (booking.status !== 'done') throw commandError('BOOKING_NOT_DONE', '只有已完成课程可以删除。')
    const incomes = business.collection('incomes'), matches = (await incomes.list({ bookingId })).filter(row => (row.bookingId || businessData(row).bookingId) === bookingId)
    if (matches.length !== 1) throw commandError('INCOME_RELATION_AMBIGUOUS', matches.length ? '已完成课程关联了多条收入记录。' : '已完成课程缺少对应收入记录。')
    const incomeRow = matches[0], income = businessData(incomeRow), packageId = booking.packageId || bookingRow.packageId || '', studentId = booking.studentId || bookingRow.studentId || ''
    if (booking.id !== bookingId || bookingRow.studentId !== studentId || bookingRow.packageId !== packageId || incomeRow.bookingId !== bookingId || (income.bookingId && income.bookingId !== bookingId)) throw commandError('BOOKING_RELATION_INVALID', '已完成课程或收入关系不一致。')
    // M2 第二批：共享预约的课时包在**别人的账**里 —— 返课要返到那一本账上（同一个事务）。
    let refund = 'none', packageRow = null, pkg = null, space = business, shared = false, attach = () => {}
    if (packageId) {
      const resolved = await bookingPackageSpace(business, context, bookingRow, booking, true)
      space = resolved.space; packageRow = resolved.packageRow; shared = resolved.shared; attach = resolved.attach
      if (packageRow) {
        pkg = businessData(packageRow)
        if (packageRow.packageId !== packageId || pkg.id !== packageId || packageRow.studentId !== studentId) throw commandError('BOOKING_PACKAGE_RELATION_INVALID', '已完成课程与原课时包关系不一致。')
        const used = Number(pkg.used), remaining = Number(pkg.remaining)
        if (!Number.isFinite(used) || used <= 0) throw commandError('PACKAGE_USAGE_INVALID', '原课时包已用课时异常，不能安全返还。')
        if (!Number.isFinite(remaining) || remaining < 0) throw commandError('PACKAGE_USAGE_INVALID', '原课时包剩余课时异常，不能安全返还。')
        pkg.used = used - 1
        if (pkg.status === 'reversed') { pkg.remaining = 0; refund = 'reversed-package-no-remaining' }
        else { pkg.remaining = remaining + 1; refund = 'active-package-refunded' }
      }
    }
    await bookings.remove(bookingId)
    await incomes.remove(incomeRow.incomeId)
    if (packageRow) {
      await space.collection('packages').set(packageId, writableRow(packageRow, { packageId, studentId, ...(packageRow.saleId || pkg.saleId ? { saleId: packageRow.saleId || pkg.saleId } : {}), data: pkg }))
      if (shared) attach({ bookingId })
    }
    return { bookingId, incomeId: incomeRow.incomeId, packageId: packageRow ? packageId : null, refund }
  },

  async saveSettings(business, payload) {
    requireOnly(payload, SETTING_FIELDS)
    const supplied = SETTING_FIELDS.filter(key => has(payload, key))
    if (!supplied.length) throw commandError('INVALID_PAYLOAD', '请至少提交一项设置。')
    const collection = business.collection('settings'), old = await collection.get(SETTINGS_ID), settings = businessData(old)
    supplied.forEach(key => { settings[key] = number(payload[key], key) })
    await collection.set(SETTINGS_ID, writableRow(old, { settingsId: SETTINGS_ID, sortIndex: old && old.sortIndex != null ? old.sortIndex : 0, data: settings }))
    return { settings: clone(settings) }
  },

  async createCustomExercise(business, payload, context) {
    requireOnly(payload, ['name', 'group', 'builtinKey', 'hidden'])
    const name = text(payload.name, '动作名称'), group = text(payload.group, '动作部位'), collection = business.collection('customExercises'), list = await rows(collection)
    if (list.some(row => { const item = businessData(row); return item.name === name && item.group === group })) throw commandError('CUSTOM_EXERCISE_DUPLICATE', '动作库中已有同名动作。')
    const customExerciseId = generatedBusinessId('exercise', business, context.requestId)
    if (await collection.get(customExerciseId)) throw commandError('ID_CONFLICT', '自定义动作 ID 已存在。')
    const builtinKey = payload.builtinKey == null ? '' : text(payload.builtinKey, '系统动作标识')
    await collection.set(customExerciseId, { customExerciseId, sortIndex: nextSortIndex(list), data: { id: customExerciseId, name, group, ...(builtinKey ? { builtinKey } : {}), ...(payload.hidden === true ? { hidden: true } : {}) } })
    return { customExerciseId }
  },

  async updateCustomExercise(business, payload) {
    requireOnly(payload, ['customExerciseId', 'name', 'group', 'hidden'])
    const customExerciseId = text(payload.customExerciseId, 'customExerciseId'), collection = business.collection('customExercises'), old = await collection.get(customExerciseId)
    if (!old) throw commandError('CUSTOM_EXERCISE_NOT_FOUND', '自定义动作不存在。')
    if (!has(payload, 'name') && !has(payload, 'group') && !has(payload, 'hidden')) throw commandError('INVALID_PAYLOAD', '没有需要修改的动作字段。')
    const item = businessData(old)
    if (has(payload, 'name')) item.name = text(payload.name, '动作名称')
    if (has(payload, 'group')) item.group = text(payload.group, '动作部位')
    if (has(payload, 'hidden')) item.hidden = payload.hidden === true
    const list = await rows(collection)
    if (list.some(row => row.customExerciseId !== customExerciseId && (() => { const other = businessData(row); return other.name === item.name && other.group === item.group })())) throw commandError('CUSTOM_EXERCISE_DUPLICATE', '动作库中已有同名动作。')
    await collection.set(customExerciseId, writableRow(old, { customExerciseId, data: item }))
    return { customExerciseId }
  },

  async deleteCustomExercise(business, payload) {
    requireOnly(payload, ['customExerciseId'])
    const customExerciseId = text(payload.customExerciseId, 'customExerciseId'), collection = business.collection('customExercises'), old = await collection.get(customExerciseId)
    if (!old) throw commandError('CUSTOM_EXERCISE_NOT_FOUND', '自定义动作不存在。')
    await collection.remove(customExerciseId)
    return { customExerciseId }
  },

  async createManualSale(business, payload, context) {
    requireOnly(payload, ['name', 'typeName', 'amount', 'date', 'validFrom', 'validTo', 'note'])
    const collection = business.collection('sales'), list = await rows(collection), saleId = generatedBusinessId('sale', business, context.requestId)
    if (await collection.get(saleId)) throw commandError('ID_CONFLICT', '销售 ID 已存在。')
    const sale = {
      id: saleId,
      source: 'manual',
      typeName: payload.typeName == null ? '其他业绩' : text(payload.typeName, '业绩类型'),
      name: payload.name == null ? '其他业绩' : text(payload.name, '项目名称'),
      amount: Number(number(payload.amount, '销售业绩金额', true).toFixed(2)),
      date: date(payload.date, '业绩归属日期'),
      validFrom: date(payload.validFrom, '生效日期', true),
      validTo: date(payload.validTo, '到期日期', true),
      note: payload.note == null ? '' : String(payload.note),
      createdAt: context.now
    }
    await collection.set(saleId, { saleId, studentId: '', packageId: '', sortIndex: nextSortIndex(list), data: sale })
    return { saleId }
  },

  async updateManualSale(business, payload) {
    requireOnly(payload, ['saleId', 'date'])
    const saleId = text(payload.saleId, 'saleId'), collection = business.collection('sales'), row = await collection.get(saleId)
    if (!row) throw commandError('SALE_NOT_FOUND', '销售不存在或不属于当前数据集。')
    const sale = businessData(row)
    if (row.saleId !== saleId || sale.id !== saleId) throw commandError('SALE_RELATION_INVALID', '销售标识关系不一致。')
    if (sale.source !== 'manual') throw commandError('NOT_MANUAL_SALE', '只能用此命令修改手工业绩。')
    sale.date = date(payload.date, '业绩归属日期')
    await collection.set(saleId, writableRow(row, { saleId, studentId: row.studentId || '', packageId: '', data: sale }))
    return { saleId, date: sale.date }
  },

  async deleteManualSale(business, payload) {
    requireOnly(payload, ['saleId'])
    const saleId = text(payload.saleId, 'saleId'), collection = business.collection('sales'), old = await collection.get(saleId)
    if (!old) throw commandError('SALE_NOT_FOUND', '销售不存在或不属于当前数据集。')
    if (businessData(old).source !== 'manual') throw commandError('NOT_MANUAL_SALE', '只能用此命令删除手工业绩。')
    await collection.remove(saleId)
    return { saleId }
  }
}

// ⚠️ `initials` / `nextSortIndex` 一并导出，**只为让 repair.js 复用同一套算法**，
//    而不是复制一份（复制就会漂移）。正式 22 条命令的 `handlers` 契约一个字没变。
//
// ⚠️ M3-P2 追加：`bookingMoment` / `businessData` / `createBookingOnForeignPackage` 也一并导出，
//    **只为让会员写通道（`memberBooking.js`）复用同一套预约内核** —— 云函数之间无法共享文件，
//    把它复制一份到会员侧就等于造出第二套冲突/余额口径（M2 的血泪）。
//    ⛔ 这几个导出**不改变**任何既有行为：`handlers` 这张分发表与 22 条命令契约一个字没动。
module.exports = {
  SETTING_FIELDS, handlers, initials, nextSortIndex,
  bookingMoment, businessData, createBookingOnForeignPackage,
  // ⚠️ M3-P6 追加：`writableRow` / `bookingPackageSpace` / `overlaps` 一并导出，
  //    只为让会员写通道（`memberBooking.js`）复用**同一段**行读写与"占座释放在哪本账"的推导。
  //    ⛔ 复制一份到会员侧 = 造出第二套 reserved 口径（M2 的血泪，见 createBookingOnForeignPackage 顶部）。
  //    ⛔ 这三个导出**不改变**任何既有行为：`handlers` 分发表与 22 条命令契约一个字没动。
  writableRow, bookingPackageSpace, overlaps
}
