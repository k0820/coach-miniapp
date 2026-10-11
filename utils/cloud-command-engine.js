// 阶段 2 起，本文件里的 **纯业务规则** 被「本机业务事务」（utils/local-transaction.js）直接复用 ——
// 小程序的同一条规则只有这一份实现，不再产生第二份拷贝。
// 因此这里不能再无条件 require('crypto')（小程序没有 Node 内置模块）：
// 有 Node 就用 Node（保持测试里的字节完全一致），没有就用仓库自带的纯 JS sha256（同一个 hex）。
const hasNodeCrypto = typeof process !== 'undefined' && !!(process.versions && process.versions.node)
const crypto = hasNodeCrypto ? require('crypto') : null
const { sha256: pureSha256 } = require('./sha256')
const { validateCommandEnvelope, failure, isPlainObject } = require('./cloud-command-contract')
// M2 课时占用规则（reserved / availableToBook / plannedMinutes / 待确认）本机孪生实现。
// ⚠️ 必须与 cloudfunctions/coachBusinessCommand/occupancy.js 同口径（由 m2-occupancy-contract 测试锁死）。
const occupancy = require('./package-occupancy')

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function hashCommand(command, payload) {
  const text = canonicalize({ command, payload })
  if (crypto) return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
  return pureSha256(text)
}

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)) }
function array(value) { return Array.isArray(value) ? value : [] }
function number(value, label, options = {}) {
  const result = Number(value)
  if (!Number.isFinite(result) || (options.integer && !Number.isInteger(result)) || (options.positive ? result <= 0 : result < 0)) {
    throw commandError('INVALID_PAYLOAD', `${label}无效。`)
  }
  return result
}
function text(value, label) {
  const result = String(value == null ? '' : value).trim()
  if (!result) throw commandError('INVALID_PAYLOAD', `${label}不能为空。`)
  return result
}
function validDate(value) {
  const key = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false
  const [year, month, day] = key.split('-').map(Number), date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
}
function date(value, label = '日期', optional = false) {
  if ((value == null || value === '') && optional) return ''
  const result = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw commandError('INVALID_PAYLOAD', `${label}无效。`)
  const [year, month, day] = result.split('-').map(Number), parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) throw commandError('INVALID_PAYLOAD', `${label}无效。`)
  return result
}
function commandError(code, message, extra = {}) { return Object.assign(new Error(message), { commandCode: code, extra }) }

function emptyState(seed = {}) {
  return {
    dataRevision: Number.isInteger(seed.dataRevision) && seed.dataRevision >= 0 ? seed.dataRevision : 0,
    students: clone(array(seed.students)), bookings: clone(array(seed.bookings)), incomes: clone(array(seed.incomes)),
    sales: clone(array(seed.sales)), settings: clone(isPlainObject(seed.settings) ? seed.settings : {}),
    customExercises: clone(array(seed.customExercises))
  }
}

function findStudent(state, id) {
  const student = state.students.find(item => item.id === id)
  if (!student) throw commandError('STUDENT_NOT_FOUND', '学员不存在或不属于当前教练。')
  student.packages = array(student.packages)
  return student
}
function findPackage(state, studentId, packageId) {
  const student = findStudent(state, studentId), pkg = student.packages.find(item => item.id === packageId)
  if (!pkg) throw commandError('PACKAGE_NOT_FOUND', '指定课时包不存在或不属于当前教练。')
  return { student, pkg }
}
// ⭐ 谁发起 / 谁授课（与云端 `teaching.identityFor` 同口径 —— 本机与云端必须给出同一份字段）。
//   课时事实属于会员本人；这里记录的只是「这一节由哪位教练上」，不决定课时归谁。
function bookingIdentity(context, payload) {
  const source = payload && payload.source === 'member' ? 'member' : 'coach'
  return { teachingCoachId: context && context.ownerCoachId ? context.ownerCoachId : null, source, createdByCoachId: source === 'coach' ? (context && context.ownerCoachId) || null : null, createdByMemberId: null }
}

function findBooking(state, bookingId) {
  const booking = state.bookings.find(item => item.id === bookingId)
  if (!booking) throw commandError('BOOKING_NOT_FOUND', '预约不存在或不属于当前教练。')
  return booking
}
// M2 第二批：共享预约用的课时包**不在本机这本账里**（它物理存在另一位教练的数据集）。
// 本机根本没有那一份 remaining / reserved，硬算就是拿假数据记账 ⇒ 明确拒绝，交给云端裁决。
// ⚠️ 这个码已登记进 `mutate.LOCAL_TARGET_MISSING`：它属于"本机落后/看不见"，**不是业务结论**，
//    所以 mutate 会照常入队、送云端按同一份 handlers 判（云端说行就行，说不行才是不行）。
function sharedUsageOf(booking) {
  const usage = booking && booking.packageUsage
  if (!usage || typeof usage !== 'object') return null
  if (!usage.packageId || !usage.ownerCoachId || !usage.datasetId) return null
  return usage
}
function assertNotSharedBooking(booking, action) {
  if (!sharedUsageOf(booking)) return
  throw commandError('SHARED_PACKAGE_NOT_LOCAL', `这节课用的是共享课时包，${action}必须由云端确认后才能生效。`, { retrySafe: true })
}
// 共享码校验：与云端 sharing.normalizeShareCode **同一条正则**（本机没有 crypto，也不需要）。
const SHARE_CODE_PATTERN = /^[A-Z0-9]{6,32}$/
function normalizeShareCode(value) {
  const code = String(value == null ? '' : value).trim().toUpperCase()
  if (!SHARE_CODE_PATTERN.test(code)) throw commandError('INVALID_PAYLOAD', '共享码格式无效。')
  return code
}
function findSale(state, saleId) {
  const sale = state.sales.find(item => item.id === saleId)
  if (!sale) throw commandError('SALE_NOT_FOUND', '销售不存在或不属于当前教练。')
  return sale
}
// 按 packageId 直接找课时包（真实云端的 updatePackage / deletePackage 载荷里**没有** studentId，
// 只有 packageId —— 本机不能要求一个云端根本不发的字段）。
function findPackageById(state, packageId) {
  for (const student of state.students) {
    const pkg = array(student.packages).find(item => item.id === packageId)
    if (pkg) { student.packages = array(student.packages); return { student, pkg } }
  }
  throw commandError('PACKAGE_NOT_FOUND', '指定课时包不存在或不属于当前教练。')
}
function assertUniqueId(state, id) {
  const used = state.students.some(x => x.id === id) || state.bookings.some(x => x.id === id) || state.incomes.some(x => x.id === id) || state.sales.some(x => x.id === id) || state.students.some(s => array(s.packages).some(p => p.id === id)) || state.customExercises.some(x => x.id === id)
  if (used) throw commandError('ID_CONFLICT', '服务端生成的业务 ID 冲突。')
}
// ⭐ 与云端 handlers.overlaps / teaching.overlapsMoment **同一个** occupancy 实现。
//   ⛔ 旧写法 `a.date !== dateKey ⇒ false`（只比同一天）+ 双方时长写死 60 ⇒
//      允许 23:30 跨午夜后会漏判跨日重叠（10-01 23:30–00:30 与 10-02 00:00–01:00）。
function sameSlot(a, dateKey, hour, minute, ignoreId, plannedMinutes) {
  if (a.id === ignoreId) return false
  const left = occupancy.intervalOf(a)
  const right = occupancy.intervalOf({ date: dateKey, hour, minute, plannedMinutes })
  return occupancy.intervalsOverlap(left, right)
}
function bookingTime(booking) { return `${String(booking.hour).padStart(2, '0')}:${String(booking.minute || 0).padStart(2, '0')}` }
// ---------------------------------------------------------------- 与云端「逐字同口径」的三件套
//
// 这份引擎是本机业务事务的执行底座（utils/local-transaction.js 直接复用它的 handlers）。
// 所以它**必须**与 cloudfunctions/coachBusinessCommand/handlers.js 同口径 —— 只要它比云端松一点，
// 本机就会接受一条云端必然拒绝的命令：界面先显示成功，同步时才被拒，用户看到的是"记了又没了"。
// 反过来只要它比云端严一点，用户就会在本机看到一个云端本来会接受的拒绝。
// 三条口径都要对齐：① 允许的载荷字段（requireOnly）② 预约时刻的合法区间 ③ 摘要文本的逐字产出。

const SETTINGS_ID = 'settings'
const SETTING_FIELDS = Object.freeze(['renewThreshold', 'monthlyGoalSessions', 'classCommissionRate', 'salesCommissionRate'])
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

// 真实云函数用 requireOnly 做**硬门禁**：多带一个字段就是 INVALID_PAYLOAD。
// 少了这道门，本机会把「云端必拒的载荷」当成功算完并排进队列。
const PAYLOAD_CONTRACT = Object.freeze({
  createStudent: ['name', 'phone'],
  updateStudent: ['studentId', 'name', 'phone'],
  deleteStudent: ['studentId'],
  // ⭐ 2026-09-29：赠课与普通课包**同一套授课授权机制** ⇒ createPackage 也必须能带 teachingPublicCodes。
  //   本机只放行字段、不生成授权（授权表只在云端，理由同上）。
  createPackage: ['studentId', 'type', 'total', 'remaining', 'isGift', 'teachingPublicCodes'],
  // M2 V1：`teachingPublicCodes` 是「本次课包可授课教练（公开码）」。授权写在云端授权表里，
  //   本机**没有那张表**，所以本机只放行字段、不生成授权（与 setPackageShare 同口径：云端先行）。
  createCourseSale: ['studentId', 'type', 'total', 'remaining', 'quantity', 'unitPrice', 'amount', 'date', 'teachingPublicCodes'],
  updatePackage: ['packageId', 'total', 'remaining'],
  deletePackage: ['packageId'],
  updateCourseSale: ['saleId', 'packageId', 'type', 'total', 'remaining', 'quantity', 'unitPrice', 'amount', 'date', 'confirmTotalBelowUsed'],
  reverseCourseSale: ['saleId', 'packageId'],
  createBooking: ['studentId', 'packageId', 'date', 'hour', 'minute', 'plannedMinutes'],
  setPackageShare: ['packageId', 'enabled'],
  createSharedBooking: ['shareCode', 'date', 'hour', 'minute', 'plannedMinutes'],
  createAuthorizedBooking: ['studentId', 'packageId', 'date', 'hour', 'minute', 'plannedMinutes'],
  grantMemberService: ['studentId', 'publicCodes'],
  revokeMemberService: ['studentId', 'publicCode'],
  grantPackageTeaching: ['packageId', 'publicCodes'],
  revokePackageTeaching: ['packageId', 'publicCode'],
  transferPackageManagement: ['packageId', 'publicCode'],
  markBookingNotHeld: ['bookingId'],
  updateBookingContent: ['bookingId', 'items', 'notes', 'category', 'duration', 'summary'],
  rescheduleBooking: ['bookingId', 'date', 'hour', 'minute'],
  cancelBooking: ['bookingId'],
  completeBooking: ['bookingId'],
  deleteCompletedBooking: ['bookingId'],
  createManualSale: ['name', 'typeName', 'amount', 'date', 'validFrom', 'validTo', 'note'],
  updateManualSale: ['saleId', 'date'],
  deleteManualSale: ['saleId'],
  saveSettings: SETTING_FIELDS,
  createCustomExercise: ['name', 'group', 'builtinKey', 'hidden'],
  updateCustomExercise: ['customExerciseId', 'name', 'group', 'hidden'],
  deleteCustomExercise: ['customExerciseId']
})
function requireOnly(command, payload) {
  const allowed = PAYLOAD_CONTRACT[command]
  if (!allowed) return
  const unknown = Object.keys(payload || {}).filter(key => !allowed.includes(key))
  if (unknown.length) throw commandError('INVALID_PAYLOAD', `包含不允许的字段：${unknown.join('、')}`)
}
// 预约时刻：**语法上**允许 00:00–24:00（24 点必须整点）。
//   ⭐ 2026-10-03 四次口径：业务上的"最早 / 最晚开课"**不在这里判** ——
//      它由 `occupancy.lessonWindowGateOf()`（开始 06:00–23:00 且结束 ≤ 当天 24:00）单独把关，
//      教练端与会员端同一条。这里只做**形状校验**（整数 / 范围 / 24:00 必须整点）。
//   📌 00:00–05:59 这一段语法仍然放行，是留给**存量历史课**的：补录 / 展示旧数据都不能被卡住，
//      而**新建入口**会在闸门那一层被明确拒绝（BOOKING_START_TOO_EARLY）。
// ⛔ 必须与云端 `handlers.js` 的 bookingMoment **逐字同口径**：本机先行会在出网前用这一份拦一遍，
//    两边不一致就会出现"本机先收下、出网才被拒"。改任一边都要同步改另一边。
function bookingMoment(payload) {
  const bookingDate = date(payload.date, '预约日期'), hour = number(payload.hour, '预约小时'), minute = number(payload.minute, '预约分钟')
  if (!Number.isInteger(hour) || hour < 0 || hour > 24 || !Number.isInteger(minute) || minute < 0 || minute > 59 || (hour === 24 && minute !== 0)) throw commandError('INVALID_PAYLOAD', '预约时间无效。')
  return { date: bookingDate, hour, minute }
}
// ⭐ 课程必须**在当天上完**（2026-10-02 三次口径）：**开始 ≤ 23:00 且 结束 ≤ 当天 24:00**。
//   ⛔ 必须与云端 handlers.js 同一把尺（公式与文案都取自 utils/package-occupancy.js，
//     它是云端 occupancy.js 的本机孪生）。跨教练那两条命令（共享码 / 正式授权）也要先过这一条
//     再抛出"需要云端确认" ⇒ 时间不对就不出网，不让用户白等一轮。
//   ⛔ 与云端 handlers 一样**只判窗口、不判最早也不判网格** —— 本机先行这条路径同时承担
//      教练的「历史课程补录」（凌晨 / 非整点的已上课程也要能录），加了就是误伤。
function assertBookingWindow(payload) {
  const moment = bookingMoment({ date: payload.date, hour: payload.hour, minute: payload.minute })
  const plannedMinutes = payload.plannedMinutes == null || payload.plannedMinutes === ''
    ? occupancy.DEFAULT_PLANNED_MINUTES : Number(payload.plannedMinutes)
  const gate = occupancy.lessonWindowGateOf(moment, plannedMinutes)
  if (gate) throw commandError(gate.code, gate.message)
}
// 摘要重建：与云端 rebuildSummary 逐字同源。
// ⚠️ 分类的缺省值是「常规训练」而不是「综合训练」——差两个字就是逐字不一致。
function rebuildSummary(booking) {
  const parts = booking.date.split('-'), value = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])), weekday = ['日','一','二','三','四','五','六'][value.getDay()]
  const category = booking.category || (booking.typeName === '拉伸恢复' ? '拉伸恢复' : '常规训练')
  const lines = [`⏰ ${Number(parts[1])}月${Number(parts[2])}日 星期${weekday}`, `${Number(booking.hour)}:${String(booking.minute || 0).padStart(2, '0')}｜${category}`, '']
  ;(Array.isArray(booking.items) ? booking.items : []).forEach(item => {
    if (booking.typeName === '拉伸恢复' || item.group === '拉伸') lines.push(`${item.name} · ${item.minutes || 15}分钟`)
    else lines.push(`${item.name} · ${item.sets || 4}组×${item.reps || 12}次${item.weight !== '' && item.weight != null ? ` · ${item.weight}kg` : ''}`)
  })
  if (booking.typeName === '拉伸恢复') lines.push(`⏱训练时长：${booking.duration || 60}分钟`)
  if (booking.notes) lines.push(`备注：${booking.notes}`)
  return lines.join('\n')
}

function createPackageTransaction(state, payload, context, courseOnly) {
  requireOnly(courseOnly ? 'createCourseSale' : 'createPackage', payload)
  const student = findStudent(state, text(payload.studentId, 'studentId'))
  const type = text(payload.type, '课程类型'), isGift = payload.isGift === true || type === '赠送课程'
  if (courseOnly && isGift) throw commandError('INVALID_PAYLOAD', '课程销售不能创建赠送课时包。')
  if (!courseOnly && !isGift) throw commandError('PAID_PACKAGE_REQUIRES_SALE', '付费课时包必须通过 createCourseSale 与销售记录原子创建。')
  const total = number(payload.total, '购买课时', { integer: true, positive: true })
  const remaining = number(payload.remaining, '当前剩余', { integer: true })
  const packageId = context.id('package'), pkg = { id: packageId, type, total, used: 0, remaining, price: isGift ? 80 : number(payload.unitPrice, '单价', { positive: true }), status: 'active', createdAt: context.now() }
  assertUniqueId(state, packageId)
  if (isGift) {
    pkg.isGift = true
    student.packages.push(pkg)
    context.step('package-created')
    return { studentId: student.id, packageId, gift: true, saleId: null }
  }
  const quantity = number(payload.quantity, '销售数量', { integer: true, positive: true }), saleDate = date(payload.date, '业绩归属日期'), amount = Number(number(payload.amount, '实际销售业绩', { positive: true }).toFixed(2)), saleId = context.id('sale')
  assertUniqueId(state, saleId)
  Object.assign(pkg, { saleDate, saleId })
  const sale = { id: saleId, source: 'course', studentId: student.id, packageId, typeName: type, quantity, unitPrice: pkg.price, amount, date: saleDate, note: `${student.name} · ${type} ${quantity}节`, createdAt: context.now() }
  student.packages.push(pkg); context.step('package-created')
  state.sales.push(sale); context.step('sale-created')
  return { studentId: student.id, packageId, saleId, gift: false }
}

const authorizationRequiresCloud = () => commandError('AUTHORIZATION_REQUIRES_CLOUD', '多教练授权需要云端确认（本机没有授权表）。', { retrySafe: true })

const handlers = {
  createStudent(state, payload, context) {
    requireOnly('createStudent', payload)
    const id = context.id('student'); assertUniqueId(state, id)
    const student = { id, name: text(payload.name, '学员姓名'), phone: payload.phone == null ? '' : String(payload.phone), packages: [], createdAt: context.now() }
    state.students.push(student); context.step('student-created'); return { studentId: id }
  },
  updateStudent(state, payload, context) {
    requireOnly('updateStudent', payload)
    const student = findStudent(state, text(payload.studentId, 'studentId'))
    if (!has(payload, 'name') && !has(payload, 'phone')) throw commandError('INVALID_PAYLOAD', '没有需要修改的学员字段。')
    if (has(payload, 'name')) student.name = text(payload.name, '学员姓名')
    if (has(payload, 'phone')) student.phone = String(payload.phone)
    context.step('student-updated'); return { studentId: student.id }
  },
  deleteStudent(state, payload, context) {
    requireOnly('deleteStudent', payload)
    const student = findStudent(state, text(payload.studentId, 'studentId')), id = student.id, name = student.name
    state.bookings.forEach(booking => { if (booking.studentId === id && booking.status === 'done' && !booking.studentName) booking.studentName = name })
    state.incomes.forEach(income => { if (income.studentId === id && !income.studentName) income.studentName = name })
    const deletedCourseSales = state.sales.filter(sale => sale.source === 'course' && sale.studentId === id && sale.status !== 'reversed').length
    const deletedPendingBookings = state.bookings.filter(booking => booking.studentId === id && booking.status !== 'done').length
    const reversedAt = context.now()
    student.packages.forEach(pkg => { pkg.status = 'reversed'; pkg.remaining = 0; pkg.reversedAt = reversedAt })
    state.sales.forEach(sale => { if (sale.source === 'course' && sale.studentId === id) { sale.status = 'reversed'; sale.reversedAt = reversedAt } })
    state.bookings = state.bookings.filter(booking => booking.studentId !== id || booking.status === 'done')
    if (!Array.isArray(state.studentTombstones)) state.studentTombstones = []
    state.studentTombstones.push({ ...student, status: 'deleted', deletedAt: reversedAt })
    state.students = state.students.filter(item => item.id !== id)
    context.step('student-deleted'); return { studentId: id, deletedCourseSales, deletedPendingBookings }
  },
  createPackage(state, payload, context) { return createPackageTransaction(state, payload, context, false) },
  createCourseSale(state, payload, context) { return createPackageTransaction(state, payload, context, true) },
  updatePackage(state, payload, context) {
    requireOnly('updatePackage', payload)
    const { pkg } = findPackageById(state, text(payload.packageId, 'packageId'))
    if (pkg.saleId || state.sales.some(sale => sale.packageId === pkg.id)) throw commandError('PACKAGE_HAS_SALE', '有销售关联的课时包必须通过课程销售命令修改。')
    if (pkg.type !== '赠送课程') throw commandError('PACKAGE_EDIT_UNSUPPORTED', '仅允许维护无销售关联的赠送课时包。')
    if (payload.total != null) pkg.total = number(payload.total, '赠送课时', { integer: true, positive: true })
    if (payload.remaining != null) pkg.remaining = number(payload.remaining, '当前剩余', { integer: true })
    pkg.price = 80; context.step('package-updated'); return { packageId: pkg.id }
  },
  deletePackage(state, payload, context) {
    requireOnly('deletePackage', payload)
    const { student, pkg } = findPackageById(state, text(payload.packageId, 'packageId'))
    if (pkg.saleId || state.sales.some(sale => sale.packageId === pkg.id)) throw commandError('PACKAGE_HAS_SALE', '有销售关联的课时包不能直接删除。')
    if (Number(pkg.used || 0) !== 0 || state.bookings.some(booking => booking.packageId === pkg.id) || state.incomes.some(income => income.packageId === pkg.id || state.bookings.some(booking => booking.id === income.bookingId && booking.packageId === pkg.id))) throw commandError('PACKAGE_HAS_HISTORY', '课时包已有历史关系，不能删除。')
    student.packages = student.packages.filter(item => item.id !== pkg.id); context.step('package-deleted'); return { packageId: pkg.id }
  },
  updateCourseSale(state, payload, context) {
    requireOnly('updateCourseSale', payload)
    const sale = findSale(state, text(payload.saleId, 'saleId'))
    if (sale.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_SALE_READ_ONLY', '历史孤立课程销售只读，不能编辑或关联课时包。')
    if (sale.source !== 'course' || sale.status === 'reversed') throw commandError('SALE_NOT_EDITABLE', '这笔课程销售不能修改。')
    const { student, pkg } = findPackage(state, sale.studentId, sale.packageId)
    const matches = state.sales.filter(item => item.source === 'course' && item.studentId === student.id && item.packageId === pkg.id)
    if (matches.length !== 1 || (pkg.saleId && pkg.saleId !== sale.id)) throw commandError('SALE_RELATION_AMBIGUOUS', '课程销售与课时包不是唯一关联。')
    const quantity = payload.quantity == null ? Number(sale.quantity == null ? pkg.total : sale.quantity) : number(payload.quantity, '购买课时', { integer: true, positive: true })
    const remaining = payload.remaining == null ? Number(pkg.remaining) : number(payload.remaining, '当前剩余', { integer: true })
    const unitPrice = payload.unitPrice == null ? Number(sale.unitPrice == null ? pkg.price : sale.unitPrice) : number(payload.unitPrice, '单价', { positive: true })
    const amount = payload.amount == null ? Number(sale.amount) : Number(number(payload.amount, '实际销售业绩', { positive: true }).toFixed(2))
    const saleDate = payload.date == null ? sale.date : date(payload.date, '业绩归属日期'), type = payload.type == null ? pkg.type : text(payload.type, '课程类型')
    const used = number(pkg.used || 0, '已用课时', { integer: true }), warnings = []
    if (remaining > quantity) warnings.push('当前剩余课时高于购买课时')
    if (quantity < used) warnings.push(`历史已完成${used}节，但购买课时填写为${quantity}节`)
    if (Number((quantity * unitPrice).toFixed(2)) !== amount) warnings.push('销售业绩金额与购买数量×单节价格不一致')
    // ⚠️ 确认字段名必须与真实云函数**逐字一致**：payload 门禁只放行 confirmTotalBelowUsed，
    //    写成别的名字会被 requireOnly 挡在门外（本机/假云都会，真机也一样）。
    if (warnings.length && payload.confirmTotalBelowUsed !== true) throw commandError('TOTAL_BELOW_USED_CONFIRM_REQUIRED', `${warnings.join('；')}。`, { warnings })
    const priceChanged = Number(pkg.price) !== unitPrice, typeChanged = pkg.type !== type
    Object.assign(sale, { typeName: type, quantity, unitPrice, amount, date: saleDate, note: `${student.name} · ${type} ${quantity}节` })
    Object.assign(pkg, { type, total: quantity, remaining, price: unitPrice, saleDate, saleId: sale.id, status: 'active' })
    if (priceChanged || typeChanged) state.bookings.forEach(booking => {
      if (booking.studentId !== student.id || booking.packageId !== pkg.id || booking.status === 'done' || state.incomes.some(income => income.bookingId === booking.id)) return
      if (priceChanged) booking.price = unitPrice
      if (typeChanged) booking.typeName = type
    })
    context.step('course-sale-updated'); return { saleId: sale.id, packageId: pkg.id, warnings }
  },
  reverseCourseSale(state, payload, context) {
    requireOnly('reverseCourseSale', payload)
    const sale = findSale(state, text(payload.saleId, 'saleId'))
    if (sale.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_SALE_READ_ONLY', '历史孤立课程销售只读，不能撤销或关联课时包。')
    if (sale.source !== 'course' || sale.status === 'reversed') throw commandError('SALE_NOT_REVERSIBLE', '这笔课程销售不能撤销。')
    const student = state.students.find(item => item.id === sale.studentId), pkg = student && array(student.packages).find(item => item.id === sale.packageId)
    if (pkg) {
      const matches = state.sales.filter(item => item.source === 'course' && item.studentId === sale.studentId && item.packageId === sale.packageId)
      if (matches.length !== 1 || (pkg.saleId && pkg.saleId !== sale.id)) throw commandError('SALE_RELATION_AMBIGUOUS', '课程销售与课时包不是唯一关联。')
    }
    const reversedAt = context.now(); sale.status = 'reversed'; sale.reversedAt = reversedAt; context.step('sale-reversed')
    let cancelledBookings = 0
    if (pkg) {
      pkg.status = 'reversed'; pkg.remaining = 0; pkg.reversedAt = reversedAt; context.step('package-reversed')
      const before = state.bookings.length
      state.bookings = state.bookings.filter(item => !(item.studentId === sale.studentId && item.packageId === sale.packageId && item.status !== 'done'))
      cancelledBookings = before - state.bookings.length; context.step('future-bookings-cancelled')
    }
    return { saleId: sale.id, packageId: pkg ? pkg.id : null, cancelledBookings, orphan: !pkg }
  },
  createBooking(state, payload, context) {
    requireOnly('createBooking', payload)
    const { student, pkg } = findPackage(state, text(payload.studentId, 'studentId'), text(payload.packageId, 'packageId'))
    if (pkg.status === 'reversed') throw commandError('PACKAGE_UNAVAILABLE', '指定课时包已撤销，不能预约。')
    // ⭐ 与云端 handlers.js **同口径同源**：余额不足一律拒（事后补录也不例外）。
    const remaining = Number(pkg.remaining)
    if (!Number.isFinite(remaining) || remaining <= 0) throw commandError('PACKAGE_NO_REMAINING', '这个课时包已经没有剩余课时了。请先给会员续费或增加课时，再录入这节课（事后补录也一样不能透支）。')
    // ⭐ M2 第一层门禁：与云端同口径 —— 判 availableToBook，不是判 remaining。
    const reserved = occupancy.syncReserved(state, pkg)
    if (occupancy.availableToBook(pkg, reserved) <= 0) throw commandError('PACKAGE_NO_AVAILABLE', '该课时包剩余课时已全部安排课程，如需继续预约请先调整已有预约或续费。')
    const plannedMinutes = payload.plannedMinutes == null || payload.plannedMinutes === '' ? occupancy.DEFAULT_PLANNED_MINUTES : Number(payload.plannedMinutes)
    if (!Number.isInteger(plannedMinutes) || plannedMinutes <= 0 || plannedMinutes > 1440) throw commandError('INVALID_PAYLOAD', '课程预计时长必须是 1–1440 的整数分钟。')
    const moment = bookingMoment({ date: payload.date, hour: payload.hour, minute: payload.minute })
    // ⭐ 与云端 handlers.js **同口径同源**：**开始 ≤ 23:00 且 结束 ≤ 当天 24:00**（2026-10-02 三次口径）。
    //    ⛔ 少了这一条，本机先行会先把 23:45 的课收下、写进本机、排进队列，出网才被云端拒 ⇒
    //      用户看到的是"约成功了，过一会儿又没了"。
    //    ⛔ "结束不许跨午夜"这条同样不能漏 —— 课表已经不画次日片段，放过去就是一节看不见的课。
    const gate = occupancy.lessonWindowGateOf(moment, plannedMinutes)
    if (gate) throw commandError(gate.code, gate.message)
    if (state.bookings.some(item => sameSlot(item, moment.date, moment.hour, moment.minute, null, plannedMinutes))) throw commandError('BOOKING_TIME_CONFLICT', '该教练这个时段已经有课了。')
    // ⭐ 会员时间校验（与云端同口径，同一顺序）：会员的时间是共享的，换教练也不能重复占。
    if (state.bookings.some(item => item.studentId === student.id && sameSlot(item, moment.date, moment.hour, moment.minute, null, plannedMinutes))) throw commandError('MEMBER_TIME_CONFLICT', '该会员这个时段已经有课了，请换一个时间。')
    const id = context.id('booking'); assertUniqueId(state, id)
    const typeName = text(pkg.type, '课程类型'), price = typeName === '赠送课程' ? 80 : Number(pkg.price)
    if (!Number.isFinite(price) || price < 0) throw commandError('PACKAGE_PRICE_INVALID', '课时包价格无效，不能创建预约。')
    // ⭐ 谁发起 / 谁授课：教练端发起 ⇒ 授课教练就是当前教练。课时归会员，与谁创建无关。
    const identity = bookingIdentity(context, payload)
    state.bookings.push({ id, studentId: student.id, studentName: student.name || '已删学员', packageId: pkg.id, packageIndex: student.packages.indexOf(pkg), date: moment.date, hour: moment.hour, minute: moment.minute, typeName, price, plannedMinutes, status: 'booked', createdAt: context.now(), ...identity })
    // ⭐ 预约即占座：reserved +1（与云端同口径；remaining / used 不动）
    occupancy.applyDelta(state, pkg, 1)
    context.step('booking-created'); context.step('package-reserved')
    return { bookingId: id, studentId: student.id, packageId: pkg.id, plannedMinutes, teachingCoachId: identity.teachingCoachId, source: identity.source }
  },
  // M2 第二批：开启 / 关闭"这个课时包允许别的教练排课"。
  //   与云端同口径：**顺手完成 reserved 惰性初始化**（保证共享预约出现之前占座数已经是准的）。
  //   ⚠️ 共享码本身由云端生成并保存在共享许可集合里；本机没有那本账（它不属于八个业务集合），
  //      所以本机**不生成也不保存**共享码 —— 这条命令走云端先行（见 utils/mutate.js 分类）。
  setPackageShare(state, payload, context) {
    requireOnly('setPackageShare', payload)
    const { student, pkg } = findPackageById(state, text(payload.packageId, 'packageId'))
    if (pkg.status === 'reversed') throw commandError('PACKAGE_UNAVAILABLE', '课时包已撤销，不能共享。')
    occupancy.syncReserved(state, pkg)
    context.step('package-share-toggled')
    return { packageId: pkg.id, studentId: student.id, shareCode: context.id('share'), shared: payload.enabled !== false, reused: false }
  },
  // M2 第二批：用共享码排一节**别人家课时包**的课。
  //   ⚠️ 本机算不了：共享课时包的 remaining / reserved 在**另一位教练**的数据集里，
  //      本机根本没有那一份真值 —— 硬算必然是拿假数据记账。
  //      所以本机一律以 SHARE_NOT_FOUND 拒绝（与云端"共享码无效"同一个码），
  //      真实排课永远由云端裁决（这条命令在 mutate 里是云端先行）。
  //   ⚠️ 载荷格式必须先校验再拒绝：否则本机连"格式都不对"的载荷都会当成 SHARE_NOT_FOUND，
  //      比云端松一格（云端会 INVALID_PAYLOAD）⇒ 那正是"本机接受了云端必拒的命令"。
  createSharedBooking(state, payload, context) {
    requireOnly('createSharedBooking', payload)
    normalizeShareCode(payload.shareCode)
    // ⭐ 与云端同口径：**先过时间闸再拒绝**。这条命令最终由云端裁决，但"课程最晚 24:00 结束"
    //    是纯时间判据，本机算得出 ⇒ 出网前就明确拒绝，不让用户等一轮网络才看到失败。
    assertBookingWindow(payload)
    throw commandError('SHARE_NOT_FOUND', '共享预约需要云端确认（本机没有共享课时包的账本）。', { retrySafe: true })
  },
  // M2 V1 正式多教练服务模型：双层授权**只由云端判定**。
  //   本机没有授权表（它在元集合里，不进八个业务集合），也没有对端账本 ⇒ 硬算必然是拿假数据记账。
  //   ⚠️ 载荷格式必须先校验再拒绝：否则本机连"格式都不对"的载荷都会当成 AUTHORIZATION_REQUIRES_CLOUD，
  //      比云端松一格（云端会 INVALID_PAYLOAD）⇒ 那正是"本机接受了云端必拒的命令"。
  createAuthorizedBooking(state, payload) {
    requireOnly('createAuthorizedBooking', payload)
    bookingMoment({ date: payload.date, hour: payload.hour, minute: payload.minute })
    // ⭐ 与云端同口径：**先过时间闸再拒绝**（理由同 createSharedBooking）。
    assertBookingWindow(payload)
    throw commandError('AUTHORIZATION_REQUIRES_CLOUD', '跨教练排课需要云端确认授权与课时（本机没有授权表与对端账本）。', { retrySafe: true })
  },
  grantMemberService(state, payload) { requireOnly('grantMemberService', payload); throw authorizationRequiresCloud() },
  revokeMemberService(state, payload) { requireOnly('revokeMemberService', payload); throw authorizationRequiresCloud() },
  grantPackageTeaching(state, payload) { requireOnly('grantPackageTeaching', payload); throw authorizationRequiresCloud() },
  revokePackageTeaching(state, payload) { requireOnly('revokePackageTeaching', payload); throw authorizationRequiresCloud() },
  transferPackageManagement(state, payload) { requireOnly('transferPackageManagement', payload); throw authorizationRequiresCloud() },
  // M2「课程未进行」：只释放占座（reserved −1），remaining / used 不变，不产生收入。
  // 与 cancelBooking 的区别：这是超时待确认之后的人工判定，系统永远不会自动执行。
  markBookingNotHeld(state, payload, context) {
    requireOnly('markBookingNotHeld', payload)
    const booking = findBooking(state, text(payload.bookingId, 'bookingId'))
    assertNotSharedBooking(booking, '标记为未进行')
    if (booking.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_BOOKING_READ_ONLY', '历史孤立课程只读。')
    if (booking.status === 'done') throw commandError('BOOKING_ALREADY_DONE', '课程已完成，不能标记为未进行。')
    if (booking.status !== 'booked') throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能标记为未进行。')
    if (state.incomes.some(item => item.bookingId === booking.id)) throw commandError('INCOME_RELATION_AMBIGUOUS', '该预约已经存在收入记录，不能标记为未进行。')
    const { pkg } = findPackage(state, booking.studentId, booking.packageId)
    occupancy.applyDelta(state, pkg, -1)
    state.bookings = state.bookings.filter(item => item.id !== booking.id)
    context.step('booking-not-held'); context.step('package-released')
    return { bookingId: booking.id, packageId: pkg.id, notHeld: true }
  },
  updateBookingContent(state, payload, context) {
    requireOnly('updateBookingContent', payload)
    const booking = findBooking(state, text(payload.bookingId, 'bookingId'))
    const supplied = ['items', 'notes', 'category', 'duration', 'summary'].filter(key => has(payload, key))
    if (booking.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_BOOKING_READ_ONLY', '历史孤立课程只读，不能修改训练内容。')
    if (!supplied.length) throw commandError('INVALID_PAYLOAD', '没有需要保存的课程内容。')
    // 已完成课程的内容**可以**安全修改（这是既定业务模型：历史内容可改，财务事实不变）。
    if (booking.status !== 'booked' && booking.status !== 'done') throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能修改课程内容。')
    if (has(payload, 'items')) { if (!Array.isArray(payload.items)) throw commandError('INVALID_PAYLOAD', 'items 必须是数组。'); booking.items = clone(payload.items) }
    if (has(payload, 'notes')) booking.notes = String(payload.notes == null ? '' : payload.notes)
    if (has(payload, 'category')) booking.category = text(payload.category, '课程分类')
    if (has(payload, 'duration')) {
      const duration = number(payload.duration, '课程时长')
      if (!Number.isInteger(duration)) throw commandError('INVALID_PAYLOAD', '课程时长必须是整数分钟。')
      booking.duration = duration
    }
    if (has(payload, 'summary')) booking.summary = String(payload.summary == null ? '' : payload.summary)
    else if (booking.status === 'done' && supplied.some(key => ['items', 'notes', 'category', 'duration'].includes(key))) booking.summary = rebuildSummary(booking)
    context.step('booking-content-updated')
    return { bookingId: booking.id, status: booking.status, updatedFields: supplied }
  },
  rescheduleBooking(state, payload, context) {
    requireOnly('rescheduleBooking', payload)
    const booking = findBooking(state, text(payload.bookingId, 'bookingId'))
    const moment = bookingMoment(payload)
    // ⭐ 改期同样要过「入口时间窗」（与云端同口径）。少了它，先约 10:00 再改到 23:45 就能绕过规则。
    //    改期契约里没有 plannedMinutes ⇒ 用这节课**预约时落库的时长快照**（历史老预约按默认 60 兜底）。
    //    ⛔ 改到 23:30 **不再允许**（2026-10-01 二次口径：取消 23:30 开课，跨午夜不再作为 MVP 能力）。
    //       存量的 23:30 课只要不动它，就**不会**经过这道闸（闸门管入口，不改存量）。
    //    ⛔ 快照时长同样要过"结束 ≤ 24:00"：90 分钟的课改到 23:00 就会跨午夜，而课表不画次日片段。
    const gate = occupancy.lessonWindowGateOf(moment, occupancy.plannedMinutesOf(booking))
    if (gate) throw commandError(gate.code, gate.message)
    if (booking.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_BOOKING_READ_ONLY', '历史孤立课程只读，不能改期。')
    if (state.bookings.some(item => sameSlot(item, moment.date, moment.hour, moment.minute, booking.id, occupancy.plannedMinutesOf(booking)))) throw commandError('BOOKING_TIME_CONFLICT', '该教练这个时段已经有课了。')
    // ⭐ 会员时间校验（与云端同口径）：改期也要避开这位会员已占用的时间。
    if (state.bookings.some(item => item.studentId === booking.studentId && sameSlot(item, moment.date, moment.hour, moment.minute, booking.id, occupancy.plannedMinutesOf(booking)))) throw commandError('MEMBER_TIME_CONFLICT', '该会员这个时段已经有课了，请换一个时间。')
    if (booking.status !== 'booked' && booking.status !== 'done') throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能改期。')
    Object.assign(booking, moment)
    if (booking.status === 'done') {
      // 已完成课程改期：必须且只能关联一条收入，收入日期/时间跟着走，摘要重算。
      const matches = state.incomes.filter(item => item.bookingId === booking.id)
      if (matches.length !== 1) throw commandError('INCOME_RELATION_AMBIGUOUS', '已完成课程必须且只能关联一条收入记录。')
      matches[0].date = booking.date; matches[0].time = bookingTime(booking)
      booking.summary = rebuildSummary(booking)
    }
    context.step('booking-rescheduled')
    return { bookingId: booking.id, status: booking.status, incomeSynced: booking.status === 'done' }
  },
  cancelBooking(state, payload, context) {
    requireOnly('cancelBooking', payload)
    const booking = findBooking(state, text(payload.bookingId, 'bookingId'))
    assertNotSharedBooking(booking, '取消')
    if (booking.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_BOOKING_READ_ONLY', '历史孤立课程只读，不能取消。')
    if (booking.status === 'done') throw commandError('BOOKING_ALREADY_DONE', '已完成课程不能取消，请使用删除已完成课程。')
    if (booking.status !== 'booked') throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能取消。')
    // ⭐ M2：取消释放占座（reserved −1）。顺序：先数（这条还在数组里）→ 再 −1 → 再移除。
    const { pkg } = findPackage(state, booking.studentId, booking.packageId)
    occupancy.applyDelta(state, pkg, -1)
    state.bookings = state.bookings.filter(item => item.id !== booking.id)
    context.step('booking-cancelled'); context.step('package-released')
    return { bookingId: booking.id, packageId: pkg.id, cancelled: true }
  },
  completeBooking(state, payload, context) {
    // ★ 载荷只有 bookingId。训练动作来自**这条预约自己的 items**（由 updateBookingContent 先落库），
    //   不是从完课载荷里带进来 —— 真实云函数就是这么写的（handlers.js:413/430），
    //   而且它用 requireOnly 明确禁止多带字段。本机必须逐字同口径，否则会接受一条云端必拒的命令。
    requireOnly('completeBooking', payload)
    const booking = findBooking(state, text(payload.bookingId, 'bookingId'))
    assertNotSharedBooking(booking, '下课')
    if (booking.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_BOOKING_READ_ONLY', '历史孤立课程只读，不能再次完课。')
    if (booking.status !== 'booked') {
      if (booking.status === 'done') throw commandError('BOOKING_ALREADY_DONE', '课程已经完成。')
      throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能完成。')
    }
    const { pkg } = findPackage(state, booking.studentId, booking.packageId)
    if (pkg.type !== booking.typeName) throw commandError('BOOKING_PACKAGE_RELATION_INVALID', '预约与课时包关系不一致。')
    if (pkg.status === 'reversed') throw commandError('PACKAGE_UNAVAILABLE', '预约指定的课时包已撤销，不能完成课程。')
    const remaining = Number(pkg.remaining), used = Number(pkg.used || 0)
    if (!Number.isFinite(remaining) || remaining <= 0) throw commandError('PACKAGE_NO_REMAINING', '预约指定的课时包剩余课时不足。')
    if (!Number.isFinite(used) || used < 0) throw commandError('PACKAGE_USAGE_INVALID', '课时包历史使用数量异常。')
    const items = array(booking.items)
    if (booking.typeName !== '拉伸恢复' && !items.length) throw commandError('TRAINING_ITEMS_REQUIRED', '常规课程请先保存训练动作。')
    if (state.incomes.some(item => item.bookingId === booking.id)) throw commandError('INCOME_RELATION_AMBIGUOUS', '该预约已经存在收入记录，不能重复完课。')
    const incomeId = context.id('income'); assertUniqueId(state, incomeId)
    const category = booking.typeName === '拉伸恢复' ? '拉伸恢复' : (booking.category || '综合训练'), studentName = booking.studentName || '已删学员', completedAt = context.now()
    // ⭐ M2：完课释放占座（reserved −1）。顺序：先数（这条仍是 booked）→ 再 −1 → 再改状态。
    //    上方 remaining <= 0 的拒绝是第二层数据安全门禁，保留不动。
    occupancy.applyDelta(state, pkg, -1)
    Object.assign(booking, { status: 'done', studentName, category, completedAt, summary: rebuildSummary({ ...booking, category }) })
    pkg.used = used + 1; pkg.remaining = remaining - 1
    const amount = pkg.type === '赠送课程' ? 80 : Number(booking.price)
    if (!Number.isFinite(amount) || amount < 0) throw commandError('BOOKING_PRICE_INVALID', '预约价格快照无效，不能生成历史收入。')
    state.incomes.push({ id: incomeId, bookingId: booking.id, date: booking.date, time: bookingTime(booking), studentId: booking.studentId, studentName, typeName: booking.typeName, category, amount })
    context.step('booking-completed'); context.step('package-consumed'); context.step('income-created')
    return { bookingId: booking.id, packageId: pkg.id, incomeId, amount }
  },
  deleteCompletedBooking(state, payload, context) {
    requireOnly('deleteCompletedBooking', payload)
    const booking = findBooking(state, text(payload.bookingId, 'bookingId'))
    assertNotSharedBooking(booking, '删除已完成课程')
    if (booking.legacyRelationStatus === 'orphan') throw commandError('LEGACY_ORPHAN_BOOKING_READ_ONLY', '历史孤立课程只读，无法确定原课时包时不能删除或返课。')
    if (booking.status !== 'done') throw commandError('BOOKING_NOT_DONE', '只有已完成课程可以删除。')
    // 必须且只能关联一条收入：少了是数据不完整，多了是重复记账 —— 两种都不能悄悄返课。
    const matches = state.incomes.filter(item => item.bookingId === booking.id)
    if (matches.length !== 1) throw commandError('INCOME_RELATION_AMBIGUOUS', matches.length ? '已完成课程关联了多条收入记录。' : '已完成课程缺少对应收入记录。')
    const incomeId = matches[0].id
    const student = state.students.find(item => item.id === booking.studentId)
    const pkg = student && array(student.packages).find(item => item.id === booking.packageId)
    let refund = 'none'
    if (pkg) {
      const used = Number(pkg.used), remaining = Number(pkg.remaining)
      if (!Number.isFinite(used) || used <= 0) throw commandError('PACKAGE_USAGE_INVALID', '原课时包已用课时异常，不能安全返还。')
      if (!Number.isFinite(remaining) || remaining < 0) throw commandError('PACKAGE_USAGE_INVALID', '原课时包剩余课时异常，不能安全返还。')
      pkg.used = used - 1
      if (pkg.status === 'reversed') { pkg.remaining = 0; refund = 'reversed-package-no-remaining' }
      else { pkg.remaining = remaining + 1; refund = 'active-package-refunded' }
    }
    state.bookings = state.bookings.filter(item => item.id !== booking.id)
    state.incomes = state.incomes.filter(item => item.id !== incomeId)
    context.step('income-deleted'); context.step('completed-booking-deleted')
    return { bookingId: booking.id, incomeId, packageId: pkg ? pkg.id : null, refund }
  },
  createManualSale(state, payload, context) {
    requireOnly('createManualSale', payload)
    const id = context.id('sale'); assertUniqueId(state, id)
    state.sales.push({
      id, source: 'manual',
      typeName: payload.typeName == null ? '其他业绩' : text(payload.typeName, '业绩类型'),
      name: payload.name == null ? '其他业绩' : text(payload.name, '项目名称'),
      amount: Number(number(payload.amount, '销售业绩金额', true).toFixed(2)),
      date: date(payload.date, '业绩归属日期'),
      validFrom: date(payload.validFrom, '生效日期', true),
      validTo: date(payload.validTo, '到期日期', true),
      note: payload.note == null ? '' : String(payload.note),
      createdAt: context.now()
    })
    context.step('manual-sale-created'); return { saleId: id }
  },
  updateManualSale(state, payload, context) {
    requireOnly('updateManualSale', payload)
    const sale = findSale(state, text(payload.saleId, 'saleId'))
    if (sale.source !== 'manual') throw commandError('NOT_MANUAL_SALE', '只能用此命令修改手工业绩。')
    sale.date = date(payload.date, '业绩归属日期'); context.step('manual-sale-updated'); return { saleId: sale.id, date: sale.date }
  },
  deleteManualSale(state, payload, context) {
    requireOnly('deleteManualSale', payload)
    const sale = findSale(state, text(payload.saleId, 'saleId'))
    if (sale.source !== 'manual') throw commandError('NOT_MANUAL_SALE', '只能用此命令删除手工业绩。')
    state.sales = state.sales.filter(item => item.id !== sale.id); context.step('manual-sale-deleted'); return { saleId: sale.id }
  },
  saveSettings(state, payload, context) {
    requireOnly('saveSettings', payload)
    const supplied = SETTING_FIELDS.filter(key => has(payload, key))
    if (!supplied.length) throw commandError('INVALID_PAYLOAD', '请至少提交一项设置。')
    supplied.forEach(key => { state.settings[key] = number(payload[key], key) })
    context.step('settings-saved'); return { settings: clone(state.settings) }
  },
  createCustomExercise(state, payload, context) {
    requireOnly('createCustomExercise', payload)
    const name = text(payload.name, '动作名称'), group = text(payload.group, '动作部位')
    // 动作库不允许同名同部位：本机先建的也要挡，否则本机会接受一条云端必拒的命令。
    if (state.customExercises.some(item => item.name === name && item.group === group)) throw commandError('CUSTOM_EXERCISE_DUPLICATE', '动作库中已有同名动作。')
    const id = context.id('exercise'); assertUniqueId(state, id)
    const builtinKey = payload.builtinKey == null ? '' : text(payload.builtinKey, '系统动作标识')
    state.customExercises.push({ id, name, group, ...(builtinKey ? { builtinKey } : {}), ...(payload.hidden === true ? { hidden: true } : {}) }); context.step('exercise-created'); return { customExerciseId: id }
  },
  updateCustomExercise(state, payload, context) {
    requireOnly('updateCustomExercise', payload)
    const id = text(payload.customExerciseId, 'customExerciseId'), item = state.customExercises.find(entry => entry.id === id)
    if (!item) throw commandError('CUSTOM_EXERCISE_NOT_FOUND', '自定义动作不存在。')
    if (!has(payload, 'name') && !has(payload, 'group') && !has(payload, 'hidden')) throw commandError('INVALID_PAYLOAD', '没有需要修改的动作字段。')
    if (has(payload, 'name')) item.name = text(payload.name, '动作名称')
    if (has(payload, 'group')) item.group = text(payload.group, '动作部位')
    if (has(payload, 'hidden')) item.hidden = payload.hidden === true
    if (state.customExercises.some(entry => entry.id !== id && entry.name === item.name && entry.group === item.group)) throw commandError('CUSTOM_EXERCISE_DUPLICATE', '动作库中已有同名动作。')
    context.step('exercise-updated'); return { customExerciseId: id }
  },
  deleteCustomExercise(state, payload, context) {
    requireOnly('deleteCustomExercise', payload)
    const id = text(payload.customExerciseId, 'customExerciseId')
    if (!state.customExercises.some(entry => entry.id === id)) throw commandError('CUSTOM_EXERCISE_NOT_FOUND', '自定义动作不存在。')
    state.customExercises = state.customExercises.filter(entry => entry.id !== id); context.step('exercise-deleted'); return { customExerciseId: id }
  }
}

class InMemoryCommandEngine {
  constructor(options = {}) {
    this.states = new Map(); this.receipts = new Map(); this.sequence = 0
    this.now = options.now || (() => Date.now())
    this.idFactory = options.idFactory || (kind => `${kind}_${++this.sequence}`)
  }
  seed(ownerCoachId, state) { this.states.set(ownerCoachId, emptyState(state)) }
  read(ownerCoachId) { return clone(this.states.get(ownerCoachId) || emptyState()) }
  seedReceipt(ownerCoachId, requestId, receipt) { this.receipts.set(`${ownerCoachId}:${requestId}`, clone(receipt)) }
  // 只读回执查询（阶段 2 的同步引擎/测试用）：与真实云端 coachBusinessCommand 的 getReceipt 同口径。
  receiptFor(ownerCoachId, requestId) { const hit = this.receipts.get(`${ownerCoachId}:${requestId}`); return hit ? clone(hit) : null }
  execute(trustedContext, envelope, options = {}) {
    const ownerCoachId = trustedContext && trustedContext.ownerCoachId
    if (typeof ownerCoachId !== 'string' || !ownerCoachId) return failure('UNTRUSTED_CONTEXT', '缺少可信云端教练身份。')
    const valid = validateCommandEnvelope(envelope); if (!valid.ok) return valid
    const key = `${ownerCoachId}:${envelope.requestId}`, payloadHash = hashCommand(envelope.command, envelope.payload), existing = this.receipts.get(key)
    if (existing) {
      if (existing.command !== envelope.command || existing.payloadHash !== payloadHash) return failure('REQUEST_ID_CONFLICT', '同一 requestId 对应了不同命令或参数。')
      if (existing.status === 'succeeded') return { ...clone(existing.response), idempotent: true }
      return failure('REQUEST_PROCESSING', '该请求正在处理，可安全稍后重试。', { retrySafe: true })
    }
    const current = this.states.get(ownerCoachId) || emptyState()
    if (current.dataRevision !== envelope.expectedRevision) return failure('REVISION_CONFLICT', '数据已被其他设备更新，请刷新后重试。', { currentRevision: current.dataRevision })
    this.receipts.set(key, { ownerCoachId, requestId: envelope.requestId, command: envelope.command, payloadHash, status: 'processing', revisionBefore: current.dataRevision, startedAt: this.now() })
    // ⭐ ownerCoachId 进 context：预约要记「谁授课」（默认 = 当前教练），本机与云端必须同口径。
    const draft = clone(current), context = { now: this.now, ownerCoachId, id: kind => this.idFactory(kind, ownerCoachId), step: name => { if (options.failAtStep === name) throw commandError('INJECTED_FAILURE', `模拟失败：${name}`) } }
    try {
      const result = handlers[envelope.command](draft, clone(envelope.payload), context)
      if (options.failAtStep === 'before-commit') throw commandError('INJECTED_FAILURE', '模拟提交前失败。')
      draft.dataRevision = current.dataRevision + 1
      const response = { ok: true, command: envelope.command, requestId: envelope.requestId, revision: draft.dataRevision, result }
      this.states.set(ownerCoachId, draft)
      this.receipts.set(key, { ...this.receipts.get(key), status: 'succeeded', revisionAfter: draft.dataRevision, completedAt: this.now(), response: clone(response) })
      return response
    } catch (error) {
      this.receipts.delete(key)
      return failure(error.commandCode || 'COMMAND_FAILED', error.message || '命令执行失败。', error.extra || {})
    }
  }
}

// handlers / commandError 一并导出：本机业务事务必须复用**同一份**纯业务规则（阶段 2 的核心约束）。
module.exports = { InMemoryCommandEngine, emptyState, canonicalize, hashCommand, validDate, rebuildSummary, PAYLOAD_CONTRACT, SETTING_FIELDS, requireOnly, handlers, commandError }
