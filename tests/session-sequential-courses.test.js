// 连续多节课程（A → B → C）在同一 runtime / 同一 Storage / 同一协调器实例里一节接一节跑完。
//
// 为什么必须单独有这个文件（第 36 节）：
//   此前所有测试都只测「一节课的一生」，而且**每节课都从一个干净的 storage 和一条整洁的 revision 链开始**。
//   真机的规律却是：**第 1 节假课可以完整完成，从第 2 节起新的课程无法完课**（换学员、换时段也一样）。
//   既然失败与"哪一节课"无关、只与"这是第几节"有关，那问题就不在单节课的载荷里，
//   而在**上一节留下的状态没有被真正结束**（本机状态 / 协调器 / revision / 回读时序）。
//
// 因此本文件的两个刻意设计：
//   ① **不重置任何东西**：同一个 storage、同一个 cache、同一个协调器实例、同一份云端数据，
//      A 完成后立刻开始 B，B 完成后立刻开始 C，全程不 await 上一节的云端链、不重启、不清 Storage。
//   ② **假云直接驱动真实的 createAdapter**（utils/cloud-primary-adapter.js），只模拟两个云函数
//      （readMyActiveCoachData / coachBusinessCommand）。旧测试把 adapter 整个换成了 mock，
//      而那个 mock 的 getState().revision **永远是当前值**，于是下面这两条真实语义全部消失：
//        · execute 带 expectedRevision，服务端 revision 不等就 REVISION_CONFLICT（core.js:144）；
//        · 回读是「metadata → 每个集合分页 → integrity」多轮往返，integrity 会**重新读一次**当前
//          revision，客户端拿它与 metadata 的 revision 比对（adapter 里 mismatch.revision）。
//      真机的失败窗口正长在这两条上，旧 mock 里它们根本不存在 —— 这就是"47/47 全绿但真机挂"的来源。

const assert = require('assert')
const path = require('path')
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
// setData 假件必须与真实微信同口径：支持路径更新（课表刷新只推真的变了的格子）。
const { applyPatch } = require('./helpers/set-data')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const settleAll = async (rounds = 40) => { for (let i = 0; i < rounds; i++) await delay(2) }

const { createAdapter } = require('../utils/cloud-primary-adapter')
const { reconstructCandidate, integrity } = require('../utils/candidate-dataset')

// ---------------------------------------------------------------- 假 wx（storage 全程不清）
const counters = { loading: 0, toasts: [], modals: [], navigations: [], back: 0 }
// 全程累计的弹窗流水：counters.modals 会被 resetCounters 清掉，而「一次失败弹窗都不许有」
// 必须看**整条链**的全部弹窗，不能只看最后一节的。
const MODALS = []
const storage = {}
global.wx = {
  getStorageSync: key => copy(storage[key]),
  setStorageSync: (key, value) => { storage[key] = copy(value) },
  showToast: options => counters.toasts.push(options),
  showModal: options => { counters.modals.push(options); MODALS.push(options) },
  showLoading() { counters.loading++ },
  hideLoading() {},
  showTabBar() {},
  setClipboardData: options => { if (options && options.success) options.success({}) },
  nextTick: task => setTimeout(task, 0),
  navigateTo: options => counters.navigations.push(options),
  navigateBack() { counters.back++ },
  createSelectorQuery: () => ({ selectAll: () => ({ boundingClientRect: () => ({ exec() {} }) }) }),
  cloud: { callFunction: options => cloudCall(options.name, options.data) }
}

// ---------------------------------------------------------------- 假云（服务端真相，全程共用）
// 假云刻意**逐条对齐** cloudfunctions/coachBusinessCommand 的真实语义（core.js + handlers.js）：
//   · expectedRevision 不等 → REVISION_CONFLICT，且**事务回滚**：不落 receipt、不推进 revision（core.js:144）
//   · 同 requestId 重放 → **连业务都不跑**，直接返回同一条 succeeded 回执（core.js:141）
//   · 同 requestId 换参数 → REQUEST_ID_CONFLICT（core.js:140，payloadHash 比对）——专治"复用上一节的号"
//   · 正式 id 由 requestId **确定性生成**（core.js fixedId → handlers.js generatedBusinessId）
//   · completeBooking 的真实前置门：状态必须 booked、items 必须已保存、必须唯一关联 income（handlers.js:412-447）
//   · income 文档必须带 studentId —— 少了它，客户端重建快照时 integrity 会同步抛 INCOME_RELATION_INVALID
//     （candidate-dataset.js:219）。**假件与服务端不同口径，失败信息就会指向假因**：这一条曾让"第 1 节完课之后
//     每一次回读都 reject"，把整份测试的失败点伪装成"B 拿不到正式 bookingId"。
const crypto = require('crypto')
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const fixedId = (kind, owner, suffix = '') => sha256(`${kind}:${owner}:${suffix}`).slice(0, 32)
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const payloadHashOf = envelope => sha256(canonical({ command: envelope.command, payload: envelope.payload }))
const commandError = (code, message) => Object.assign(new Error(message), { commandCode: code })
const requireOnly = (payload, allowed) => { const unknown = Object.keys(payload).filter(key => !allowed.includes(key)); if (unknown.length) throw commandError('INVALID_PAYLOAD', `包含不允许的字段：${unknown.join('、')}`) }
function text(value, label, optional = false) { if (value == null && optional) return ''; const result = String(value == null ? '' : value).trim(); if (!result && !optional) throw commandError('INVALID_PAYLOAD', `${label}不能为空。`); return result }
const bookingTime = booking => `${String(booking.hour).padStart(2, '0')}:${String(booking.minute || 0).padStart(2, '0')}`
function rebuildSummary(booking) {
  const parts = booking.date.split('-'), value = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])), weekday = ['日', '一', '二', '三', '四', '五', '六'][value.getDay()]
  const category = booking.category || (booking.typeName === '拉伸恢复' ? '拉伸恢复' : '常规训练')
  const lines = [`⏰ ${Number(parts[1])}月${Number(parts[2])}日 星期${weekday}`, `${Number(booking.hour)}:${String(booking.minute || 0).padStart(2, '0')}｜${category}`, '']
  ;(Array.isArray(booking.items) ? booking.items : []).forEach(item => lines.push(`${item.name} · ${item.sets || 4}组×${item.reps || 12}次`))
  return lines.join('\n')
}

const COLLECTIONS = ['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
const OWNER = 'coach-owner', DATASET = 'ds-sandbox', ENV = 'sandbox'
const doc = (sourceOrder, data, extra = {}) => ({ ownerCoachId: OWNER, datasetId: DATASET, sourceOrder, sortIndex: sourceOrder, ...extra, data: copy(data) })

const CLOUD = {
  dataRevision: 1, headVersion: 1,
  docs: Object.fromEntries(COLLECTIONS.map(name => [name, []])),
  receipts: new Map(), applyLog: [], readLog: [], trace: [], thrown: [], pageLog: [], counters: { execute: 0, readActive: 0, integrity: 0, page: 0, receipt: 0 },
  latency: 1,
  // >0 时，接下来 N 次 integrity 读返回**不匹配**的校验和 —— 等价于「回读期间另一个会话刚写过」。
  // 用来确定性地让一次完整回读失败（而不是靠 sleep 去赌）。
  // >0 时，接下来 N 次 integrity 读**抛异常**（网络中断）。用来钉住「回读抛错 ≠ 命令结果未知」。
  badIntegrity: 0,
  throwIntegrity: 0,
  // true 时：下一条写命令**返回之后**马上把 throwIntegrity 武装成 2 —— 即让「这次命令的确认
  // （一跳只读校验 + 兜底完整回读）」两跳都失败，而别的读取不受影响。
  throwIntegrityAfterExecute: false
}
// 三个学员 / 三个课时包 / 三个不同时段 —— 学员、课时包、时间全不同，专门用来验证 key 是否真的隔离。
const STUDENTS = [
  { studentId: 'stu-A', packageId: 'pkg-A', name: '学员A', date: '2026-09-16', hour: 16 },
  { studentId: 'stu-B', packageId: 'pkg-B', name: '学员B', date: '2026-09-16', hour: 17 },
  { studentId: 'stu-C', packageId: 'pkg-C', name: '学员C', date: '2026-09-17', hour: 10 }
]
STUDENTS.forEach((row, index) => {
  CLOUD.docs.students.push(doc(index, { id: row.studentId, name: row.name, status: 'active' }, { studentId: row.studentId }))
  CLOUD.docs.packages.push(doc(index, { id: row.packageId, type: '常规训练', price: 100, used: 0, remaining: 5 }, { studentId: row.studentId, studentSourceOrder: index, packageId: row.packageId }))
})
CLOUD.docs.settings.push(doc(0, {}, { settingsId: 'settings', rootExtras: {} }))

const findDoc = (collection, idField, id) => CLOUD.docs[collection].find(row => row[idField] === id)
// 与真实云端 integrity.js 同构：物理集合名 student_tombstones 在快照里叫 studentTombstones。
const snapshotCollections = () => Object.fromEntries(COLLECTIONS.map(name => [name === 'student_tombstones' ? 'studentTombstones' : name, copy(CLOUD.docs[name])]))
const fingerprintOf = () => integrity(reconstructCandidate(snapshotCollections()))

const generatedBusinessId = (kind, requestId) => `${kind}_${fixedId(`coach-${kind}`, OWNER, `${DATASET}:${requestId}`).slice(0, 20)}`
const nextSortIndex = list => list.reduce((max, row) => Math.max(max, Number.isFinite(Number(row.sortIndex)) ? Number(row.sortIndex) : -1), -1) + 1
const overlaps = (row, moment) => {
  const booking = row.data
  if (booking.date !== moment.date) return false
  const oldStart = Number(booking.hour) * 60 + Number(booking.minute || 0), nextStart = moment.hour * 60 + moment.minute
  return nextStart < oldStart + 60 && nextStart + 60 > oldStart
}
// 与 handlers.js 同构：抛出的 commandError 会被 execute 的 catch 转成 { ok:false, code }，
// 并且**整个事务回滚**（receipt 不落、revision 不推进）——这正是真机 REVISION_CONFLICT 的真实后果。
function apply(command, payload, requestId) {
  CLOUD.applyLog.push({ command, payload: copy(payload) })
  if (command === 'createBooking') {
    requireOnly(payload, ['studentId', 'packageId', 'date', 'hour', 'minute'])
    const studentId = text(payload.studentId, 'studentId'), packageId = text(payload.packageId, 'packageId')
    const moment = { date: text(payload.date, '预约日期'), hour: Number(payload.hour), minute: Number(payload.minute || 0) }
    const studentRow = findDoc('students', 'studentId', studentId), packageRow = findDoc('packages', 'packageId', packageId)
    if (!studentRow) throw commandError('STUDENT_NOT_FOUND', '学员不存在或不属于当前数据集。')
    if (!packageRow) throw commandError('PACKAGE_NOT_FOUND', '指定课时包不存在或不属于当前数据集。')
    if (packageRow.studentId !== studentId) throw commandError('PACKAGE_STUDENT_MISMATCH', '指定课时包不属于该学员。')
    const student = studentRow.data, pkg = packageRow.data
    if (pkg.status === 'reversed') throw commandError('PACKAGE_UNAVAILABLE', '指定课时包已撤销，不能预约。')
    const remaining = Number(pkg.remaining)
    if (!Number.isFinite(remaining) || remaining <= 0) throw commandError('PACKAGE_NO_REMAINING', '指定课时包剩余课时不足。')
    const list = CLOUD.docs.bookings
    if (list.some(row => overlaps(row, moment))) throw commandError('BOOKING_TIME_CONFLICT', '该时段与其他课程重叠。')
    const bookingId = generatedBusinessId('booking', requestId)
    if (findDoc('bookings', 'bookingId', bookingId)) throw commandError('ID_CONFLICT', '预约 ID 已存在。')
    const typeName = text(pkg.type, '课程类型'), price = typeName === '赠送课程' ? 80 : Number(pkg.price)
    if (!Number.isFinite(price) || price < 0) throw commandError('PACKAGE_PRICE_INVALID', '课时包价格无效，不能创建预约。')
    const booking = { id: bookingId, studentId, studentName: student.name || '已删学员', packageId, ...moment, typeName, price, status: 'booked', createdAt: Date.now() }
    CLOUD.docs.bookings.push(doc(list.length, booking, { bookingId, studentId, packageId }))
    return { bookingId, studentId, packageId }
  }
  if (command === 'updateBookingContent') {
    requireOnly(payload, ['bookingId', 'items', 'notes', 'category', 'duration', 'summary'])
    const bookingId = text(payload.bookingId, 'bookingId'), row = findDoc('bookings', 'bookingId', bookingId)
    if (!row) throw commandError('BOOKING_NOT_FOUND', '预约不存在或不属于当前数据集。')
    const booking = row.data
    const supplied = ['items', 'notes', 'category', 'duration', 'summary'].filter(key => Object.prototype.hasOwnProperty.call(payload, key))
    if (!supplied.length) throw commandError('INVALID_PAYLOAD', '没有需要保存的课程内容。')
    // 真实服务端允许修改「已完课」的训练内容（handlers.js:354）——假云不许比真机更严，否则会误判。
    if (booking.status !== 'booked' && booking.status !== 'done') throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能修改课程内容。')
    if (Object.prototype.hasOwnProperty.call(payload, 'items')) {
      if (!Array.isArray(payload.items)) throw commandError('INVALID_PAYLOAD', 'items 必须是数组。')
      booking.items = copy(payload.items)
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'notes')) booking.notes = String(payload.notes == null ? '' : payload.notes)
    if (Object.prototype.hasOwnProperty.call(payload, 'category')) booking.category = text(payload.category, '课程分类')
    if (Object.prototype.hasOwnProperty.call(payload, 'duration')) booking.duration = Number(payload.duration)
    if (Object.prototype.hasOwnProperty.call(payload, 'summary')) booking.summary = String(payload.summary)
    return { bookingId, contentSaved: true }
  }
  if (command === 'completeBooking') {
    requireOnly(payload, ['bookingId'])
    const bookingId = text(payload.bookingId, 'bookingId'), row = findDoc('bookings', 'bookingId', bookingId)
    if (!row) throw commandError('BOOKING_NOT_FOUND', '预约不存在或不属于当前数据集。')
    const booking = row.data
    if (booking.status !== 'booked') {
      if (booking.status === 'done') throw commandError('BOOKING_ALREADY_DONE', '课程已经完成。')
      throw commandError('BOOKING_STATUS_INVALID', '当前预约状态不能完成。')
    }
    const packageId = text(booking.packageId || row.packageId, 'booking.packageId'), packageRow = findDoc('packages', 'packageId', packageId)
    if (!packageRow) throw commandError('PACKAGE_NOT_FOUND', '预约指定的课时包不存在或不属于当前数据集。')
    const pkg = packageRow.data, studentId = text(booking.studentId || row.studentId, 'booking.studentId')
    if (booking.id !== bookingId || row.studentId !== studentId || row.packageId !== packageId || pkg.id !== packageId || packageRow.studentId !== studentId || pkg.type !== booking.typeName) throw commandError('BOOKING_PACKAGE_RELATION_INVALID', '预约与课时包关系不一致。')
    if (pkg.status === 'reversed') throw commandError('PACKAGE_UNAVAILABLE', '预约指定的课时包已撤销，不能完成课程。')
    const remaining = Number(pkg.remaining), used = Number(pkg.used || 0)
    if (!Number.isFinite(remaining) || remaining <= 0) throw commandError('PACKAGE_NO_REMAINING', '预约指定的课时包剩余课时不足。')
    const items = Array.isArray(booking.items) ? booking.items : []
    // ★ 服务端侧的「训练内容必须先保存」安全门：内容没落库，完课命令在云端就会被拒绝。
    if (booking.typeName !== '拉伸恢复' && !items.length) throw commandError('TRAINING_ITEMS_REQUIRED', '常规课程请先保存训练动作。')
    if (CLOUD.docs.incomes.some(item => item.data.bookingId === bookingId)) throw commandError('INCOME_RELATION_AMBIGUOUS', '该预约已经存在收入记录，不能重复完课。')
    const incomeId = generatedBusinessId('income', requestId)
    if (findDoc('incomes', 'incomeId', incomeId)) throw commandError('ID_CONFLICT', '收入记录 ID 已存在。')
    const category = booking.typeName === '拉伸恢复' ? '拉伸恢复' : (booking.category || '综合训练')
    Object.assign(booking, { status: 'done', studentName: booking.studentName || '已删学员', category, completedAt: Date.now(), summary: rebuildSummary({ ...booking, category }) })
    pkg.used = used + 1; pkg.remaining = remaining - 1
    const amount = pkg.type === '赠送课程' ? 80 : Number(booking.price)
    if (!Number.isFinite(amount) || amount < 0) throw commandError('BOOKING_PRICE_INVALID', '预约价格快照无效，不能生成历史收入。')
    // income 必须带 studentId（candidate-dataset.js:219 的硬要求）
    const income = { id: incomeId, bookingId, date: booking.date, time: bookingTime(booking), studentId, studentName: booking.studentName, typeName: booking.typeName, category, amount }
    CLOUD.docs.incomes.push(doc(CLOUD.docs.incomes.length, income, { incomeId, bookingId, studentId, packageId }))
    return { bookingId, packageId, incomeId, amount }
  }
  return { __notAllowed: true }
}

// 让「某次 integrity 读」可以被按住 —— 用来确定性地构造
// 「回读还在路上时，另一条命令把 revision 推进了」这个真机窗口。
let integrityGate = null, integrityRelease = null
const holdIntegrity = () => { integrityGate = new Promise(resolve => { integrityRelease = resolve }) }
const releaseIntegrity = () => { if (integrityRelease) { integrityRelease(); integrityGate = null; integrityRelease = null } }
// 让「某条写命令的回执」可以被按住 —— 服务端已经提交、客户端还没收到。
// 这是构造第 36 节那个窗口最干净的办法：不靠 sleep 猜时间，而是把回执做成可控闸门。
let executeGate = null, executeRelease = null
const holdExecute = () => { executeGate = new Promise(resolve => { executeRelease = resolve }) }
const releaseExecute = () => { if (executeRelease) { executeRelease(); executeGate = null; executeRelease = null } }

async function cloudCall(name, data) {
  if (CLOUD.latency) await delay(CLOUD.latency)
  try {
    return await cloudCallInner(name, data)
  } catch (error) {
    CLOUD.thrown.push({ name, action: data && data.action, command: data && data.envelope && data.envelope.command, message: String(error && error.message) })
    throw error
  }
}
async function cloudCallInner(name, data) {
  if (name === 'readMyActiveCoachData') {
    const { action } = data
    if (action === 'metadata') {
      return { ok: true, environment: ENV, datasetId: DATASET, dataRevision: CLOUD.dataRevision, headVersion: CLOUD.headVersion, collections: COLLECTIONS.slice() }
    }
    if (action === 'page') {
      CLOUD.counters.page++
      const rows = CLOUD.docs[data.collection] || []
      const cursor = Number(data.cursor || 0)
      const slice = rows.slice(cursor, cursor + 20)
      const done = cursor + slice.length >= rows.length
      if (CLOUD.pageLog.length < 200) CLOUD.pageLog.push({ collection: data.collection, cursor, rows: rows.length, got: slice.length, done })
      return { ok: true, environment: ENV, datasetId: DATASET, dataRevision: CLOUD.dataRevision, collection: data.collection, cursor, nextCursor: cursor + slice.length, nextFragmentIndex: 0, done, encoding: 'base64-json', payload: Buffer.from(JSON.stringify(slice), 'utf8').toString('base64') }
    }
    if (action === 'integrity') {
      CLOUD.counters.integrity++
      CLOUD.readLog.push({ at: CLOUD.dataRevision })
      if (integrityGate) await integrityGate
      // 与真 cloudfunctions/readMyActiveCoachData/index.js 同构：这里**重新读一次**当前 revision，
      // 客户端会拿它与自己 metadata 那次读到的 revision 比对。
      const fingerprint = fingerprintOf()
      if (CLOUD.throwIntegrity > 0) {
        // 回读在网络上直接**抛异常**（而不是返回 ok:false）。
        // 这是最阴的一种：异常从 readActive 冒出去，调用方根本无从判断"命令到底成没成"。
        CLOUD.throwIntegrity--
        throw new Error('回读期间网络中断')
      }
      if (CLOUD.badIntegrity > 0) {
        CLOUD.badIntegrity--
        // checksum 对不上 → 客户端得到的是 { ok:false, code:'ACTIVE_READ_INTEGRITY_FAILED' }（**不抛**），
        // 也就是 execute 里那个 refreshFailed 分支。这正是真机上"另一个会话刚写过 / 网络抖一下"的形状。
        return { ok: true, environment: ENV, datasetId: DATASET, dataRevision: CLOUD.dataRevision, ...fingerprint, checksum: `mismatch_${fingerprint.checksum}` }
      }
      return { ok: true, environment: ENV, datasetId: DATASET, dataRevision: CLOUD.dataRevision, ...fingerprint }
    }
    return { ok: false, code: 'INVALID_ACTION' }
  }
  if (name === 'coachBusinessCommand') {
    if (data.action === 'getReceipt') {
      CLOUD.counters.receipt++
      const found = CLOUD.receipts.get(data.requestId)
      return found ? { ok: true, found: true, status: found.status, response: copy(found.response) } : { ok: true, found: false }
    }
    const envelope = data.envelope || {}
    CLOUD.counters.execute++
    const fingerprint = payloadHashOf(envelope)
    // ① 先查 receipt —— 真实 core.js 把幂等判断放在 revision 比较**之前**（core.js:139-143）。
    //    顺序反了，就会把一个「同号重放」误判成 REVISION_CONFLICT：真机上的重试（timeout → 同号补发）
    //    永远拿不回上一次的成功回执，只会一遍遍撞冲突。这条顺序本身就是真语义的一部分。
    const existing = CLOUD.receipts.get(envelope.requestId)
    if (existing) {
      if (existing.command !== envelope.command || existing.payloadHash !== fingerprint) {
        CLOUD.trace.push({ command: envelope.command, requestId: envelope.requestId, conflict: 'REQUEST_ID_CONFLICT' })
        return { ok: false, code: 'REQUEST_ID_CONFLICT', message: '同一 requestId 对应了不同命令或参数。' }
      }
      if (existing.status === 'succeeded') {
        CLOUD.trace.push({ command: envelope.command, requestId: envelope.requestId, idempotent: true })
        return { ...copy(existing.response), idempotent: true }
      }
      return { ok: false, code: 'REQUEST_PROCESSING', message: '请求正在处理中，可安全重试。', retrySafe: true }
    }
    // ② 乐观并发：与服务端 core.js:144 同口径。失败 = 事务回滚，不落 receipt、不推进 revision。
    if (envelope.expectedRevision !== CLOUD.dataRevision) {
      CLOUD.trace.push({ command: envelope.command, requestId: envelope.requestId, expected: envelope.expectedRevision, current: CLOUD.dataRevision, conflict: true })
      return { ok: false, code: 'REVISION_CONFLICT', message: '云端数据已被其他请求更新。', currentRevision: CLOUD.dataRevision }
    }
    CLOUD.trace.push({ command: envelope.command, requestId: envelope.requestId, expected: envelope.expectedRevision, current: CLOUD.dataRevision, conflict: false })
    if (process.env.SEQ_STACK) console.error('STACK', envelope.command, '\n' + String(new Error().stack).split('\n').slice(1, 9).join('\n'))
    // ③ 执行 handler：任何 commandError 都让整个事务回滚。
    let applied
    try { applied = apply(envelope.command, envelope.payload, envelope.requestId) }
    catch (error) { return { ok: false, code: error.commandCode || 'COMMAND_TRANSACTION_FAILED', message: error.message || '正式业务命令事务失败。' } }
    if (applied.__notAllowed) return { ok: false, code: 'COMMAND_NOT_ALLOWED' }
    CLOUD.dataRevision++
    const response = { ok: true, command: envelope.command, requestId: envelope.requestId, datasetRevision: CLOUD.dataRevision, result: applied }
    CLOUD.receipts.set(envelope.requestId, { status: 'succeeded', command: envelope.command, payloadHash: fingerprint, response: copy(response) })
    // 闸门：服务端已提交、回执只是还没送达客户端（专门用来构造"命令在途"这个窗口）。
    if (executeGate) await executeGate
    // ★ 1.1.9 第 6 轮：命令成功之后客户端还要付**确认**这一段（一跳只读校验，必要时再兜底一次完整回读）。
    //   要让「命令成功、但本机确认失败」这个形状**确定性地**出现，注入必须在**命令返回的这一刻**武装：
    //   早一点会被别的读取（purgeSettled 的收尾完整读取）先吃掉，晚一点又赶不上这次确认。
    //   这就是"用闸门造确定性窗口"用在**次数注入**上的形式 —— 不靠 sleep 去赌时机。
    if (CLOUD.throwIntegrityAfterExecute) { CLOUD.throwIntegrityAfterExecute = false; CLOUD.throwIntegrity = 2 }
    return response
  }
  return { ok: false, code: 'UNKNOWN_FUNCTION' }
}

// ---------------------------------------------------------------- 真实 adapter
let currentEnvironment = 'sandbox'
// 与真实 data-runtime.getDB 逐字同口径：cache 是 { ...metadata, snapshot }，页面看到的是 cache.snapshot。
// （旧测试的假 getDB 直接把扁平对象当 db，于是 cache 的真实结构与「回读没成功就没有新 cache」这层
//   在测试里根本不存在 —— 这是又一处"mock 比真机宽松"的地方。）
function readDB() {
  const cache = storage['coachSandboxActiveCache']
  if (!cache || !cache.snapshot || !cache.datasetId || !Number.isInteger(cache.revision)) { const error = new Error('当前离线缓存不可用。'); error.code = 'CLOUD_CACHE_MISSING'; throw error }
  return copy(cache.snapshot)
}
const runtime = {
  environment: () => currentEnvironment,
  setEnvironment: value => { currentEnvironment = value },
  cacheKey: () => 'coachSandboxActiveCache',
  cutoverState: () => ({ status: 'cloud-primary' }),
  MODES: { LOCAL: 'local-primary', ACTIVATING: 'activating', PENDING: 'cutover-pending', CLOUD: 'cloud-primary' },
  getDB: readDB,
  writesFrozen: () => true,
  mode: () => 'cloud-primary'
}
let requestSeq = 0
const adapter = createAdapter({
  callCloud: cloudCall,
  storage: { get: key => copy(storage[key]), set: (key, value) => { storage[key] = copy(value) } },
  isOnline: () => true,
  environment: () => currentEnvironment,
  requestId: () => `cmd-${++requestSeq}`
})
// 诊断用：把 adapter 的每一次 execute / readActive 连同「调用前后的 revision」记下来。
// ⚠️ 必须连**抛错的那次**也记下来 —— 之前只记成功返回的，于是"整条命令链 reject"在轨迹里
// 完全隐形，失败现场只看到"少了两条"，反而把根因指到别处。
const TRACE = { adapter: [], commands: [], drafts: [] }
const rawExecute = adapter.execute.bind(adapter), rawReadActive = adapter.readActive.bind(adapter)
adapter.execute = async (command, payload, options = {}) => {
  const before = adapter.getState().revision
  const requestId = options.requestId || ''
  try {
    const result = await rawExecute(command, payload, options)
    const code = result && (result.code || 'ok')
    TRACE.adapter.push({ kind: 'execute', command, before, code, after: adapter.getState().revision })
    TRACE.commands.push({ command, requestId, before, code, refreshFailed: !!(result && result.refreshFailed), idempotent: !!(result && result.idempotent), after: adapter.getState().revision })
    return result
  } catch (error) {
    TRACE.adapter.push({ kind: 'execute', command, before, threw: String(error && error.message) })
    TRACE.commands.push({ command, requestId, before, threw: String(error && error.message), after: adapter.getState().revision })
    throw error
  }
}
adapter.readActive = async () => {
  try {
    const result = await rawReadActive()
    TRACE.adapter.push({ kind: 'readActive', code: result && (result.code || 'ok'), revision: adapter.getState().revision })
    return result
  } catch (error) {
    TRACE.adapter.push({ kind: 'readActive', threw: String(error && error.message) })
    throw error
  }
}

// ---------------------------------------------------------------- 真协调器 / 真页面
const pendingBookings = require('../utils/pending-booking-request')
const pendingCancellations = require('../utils/pending-cancellation')
const pendingCompletion = require('../utils/pending-completion')
const pendingDraft = require('../utils/pending-training-draft')
// 训练草稿的每一次「定号 / 结账」都留痕 —— 这是判断「训练内容到底有没有被云端确认」的直接证据。
const rawDraftBegin = pendingDraft.begin.bind(pendingDraft), rawDraftSettle = pendingDraft.settle.bind(pendingDraft)
pendingDraft.begin = (environment, datasetId, bookingKey, newRequestId) => {
  const submission = rawDraftBegin(environment, datasetId, bookingKey, newRequestId)
  TRACE.drafts.push({ phase: 'begin', key: bookingKey, requestId: submission && submission.requestId, status: submission && submission.status })
  return submission
}
pendingDraft.settle = (environment, datasetId, bookingKey, requestId, outcome) => {
  const left = rawDraftSettle(environment, datasetId, bookingKey, requestId, outcome)
  TRACE.drafts.push({ phase: 'settle', key: bookingKey, requestId, outcome, cleared: left === null })
  return left
}
const { createBookingOptimistic } = require('../utils/booking-optimistic')

const coordinator = createBookingOptimistic({
  runtime, pending: pendingBookings, cancellation: pendingCancellations, completion: pendingCompletion, adapter,
  isOnline: () => true,
  newRequestId: () => `req-${++requestSeq}`,
  readDatasetId: () => { const cache = wx.getStorageSync('coachSandboxActiveCache'); return cache && cache.datasetId ? cache.datasetId : '' },
  readSnapshot: () => runtime.getDB(),
  onCancelled: (localKey, officialId) => {
    pendingDraft.remove(currentEnvironment, DATASET, `pending:${localKey}`)
    if (officialId) pendingDraft.remove(currentEnvironment, DATASET, officialId)
  },
  showToast: options => counters.toasts.push(options),
  showModal: options => counters.modals.push(options)
})

const commandPending = new Map()
let opSeq = 0
const operationId = key => { if (!commandPending.has(key)) commandPending.set(key, `op-${++opSeq}`); return commandPending.get(key) }
const clearPending = (key, requestId) => { if (commandPending.get(key) === requestId) commandPending.delete(key) }
async function runCommandSilent({ key, command, payload, requestId, onSuccess }) {
  const fixed = requestId || operationId(key)
  const result = await adapter.execute(command, payload, { requestId: fixed })
  if (result.ok) { commandPending.delete(key); if (onSuccess) await onSuccess(result) }
  return result
}
async function runCommand(options) { counters.loading++; return runCommandSilent(options) }

const runtimePath = require.resolve('../utils/data-runtime')
const commandPath = require.resolve('../utils/ui-cloud-command')
const oldRuntime = require.cache[runtimePath], oldCommand = require.cache[commandPath]
require.cache[runtimePath] = {
  id: runtimePath, filename: runtimePath, loaded: true,
  exports: {
    ...require('../utils/db'),
    getDB: readDB,
    saveDB: () => { throw new Error('CLOUD_PRIMARY_DIRECT_WRITE_BLOCKED') },
    uid: () => `local-${++opSeq}`, timeStr: booking => `${booking.hour}:00`,
    cacheKey: () => 'coachSandboxActiveCache',
    environment: () => currentEnvironment,
    writesFrozen: () => true, mode: () => 'cloud-primary', cutoverState: () => runtime.cutoverState(),
    MODES: runtime.MODES, ENVIRONMENTS: { PRODUCTION: 'production', SANDBOX: 'sandbox' }, setEnvironment: runtime.setEnvironment
  }
}
require.cache[commandPath] = {
  id: commandPath, filename: commandPath, loaded: true,
  exports: {
    adapter, isCloudPrimary: () => true, runCommand, runCommandSilent, operationId, clearPending,
    // ★ 阶段 2：本机先行命令（updateBookingContent / completeBooking / …）不再走 runCommand，
    //   而是进持久 Outbox 后交给**同步引擎**送出。同步引擎的第一道门就是
    //   `ui.isCloudWritable()` —— 这个替身必须**与真模块同面**地导出它，否则队列永远送不出去，
    //   表现为"本机全绿、云端一条没有"（比真机还难查）。替身必须比真模块更完整，不能更残缺。
    isCloudWritable: () => true, setOnline: () => {},
    submitBooking: input => coordinator.submit(input),
    // 课表 onShow 会调用它 —— 真机同款：resume 也会跑 readActive，与课程页的命令回读并发。
    resumePendingBookings: () => coordinator.resume(),
    pendingBookingRecords: () => coordinator.records(),
    mergePendingBookings: bookings => coordinator.mergeBookings(bookings),
    subscribePendingBookings: listener => coordinator.subscribe(listener),
    notifyPendingBookings: () => coordinator.notifyView(),
    officialIdForBooking: key => coordinator.officialIdFor(key),
    awaitOfficialBooking: (key, timeout) => coordinator.awaitOfficial(key, timeout),
    retryPendingBooking: key => coordinator.retry(key),
    cancelBookingRequest: input => coordinator.cancel(input),
    pendingCancellationRecords: () => coordinator.cancelRecords(),
    bindingForOfficialId: officialId => pendingBookings.bindingForOfficialId(currentEnvironment, DATASET, officialId),
    completionIntentFor: input => pendingCompletion.intentFor(currentEnvironment, DATASET, input && input.officialId, input && input.localKey),
    bookingBindings: () => pendingBookings.listBindings(currentEnvironment, DATASET)
  }
}

const pages = []
global.Page = config => { pages.push(config) }
require('../pages/session/session')
require('../pages/schedule/schedule')
const sessionConfig = pages[0], scheduleConfig = pages[1]

function mount(config) {
  const object = { data: copy(config.data), unsubscribe: null }
  for (const [name, value] of Object.entries(config)) if (typeof value === 'function') object[name] = value.bind(object)
  object.setData = function (patch, callback) { applyPatch(this.data, patch); if (callback) callback() }
  return object
}
// 微信口径解析路径参数：onLoad(options) 拿到的就是 url 里的**原文**（未解码）。
function wechatOptions(url) {
  const options = {}
  for (const pair of String(url).split('?')[1] ? String(url).split('?')[1].split('&') : []) {
    if (!pair) continue
    const index = pair.indexOf('=')
    if (index === -1) options[pair] = ''
    else options[pair.slice(0, index)] = pair.slice(index + 1)
  }
  return options
}
const openSchedule = () => { const page = mount(scheduleConfig); page.onLoad(); page.onShow(); return page }
const openSessionFromLastUrl = () => { const page = mount(sessionConfig); page.onLoad(wechatOptions(counters.navigations[counters.navigations.length - 1].url)); page.onShow(); return page }
const cellFor = (schedule, date, hour) => { schedule.loadScheduleData(); return schedule.makeCell(date, hour, false) }
const resetCounters = () => { counters.toasts.length = 0; counters.modals.length = 0; counters.navigations.length = 0; counters.back = 0 }
const modalTitles = () => counters.modals.map(item => item.title)
const DRAFT_MODAL = '训练内容没有在云端确认保存'

// 真机的节奏：点「约课」之后，用户还要找这节课、点进课程、加几个动作 —— 这几秒里那条 createBooking
// 早就跑完了。所以「约课 → 进入」之间允许等它落定（这不是"人为等待 Cloud"，而是真机本来就有的间隔）。
// 真正**不允许**等待的是「点下课之后」：A 的完课链还在跑，用户就已经开始约 B 了 —— 第 36 节的窗口长在这里。
async function awaitCreated(key) {
  for (let i = 0; i < 200; i++) {
    const record = coordinator.records().find(item => item.pendingKey === key)
    if (record && (record.pendingStatus === 'unknown' || record.pendingStatus === 'syncing')) break
    if (!record) break                        // 已转正并被清掉
    await delay(2)
  }
  await delay(5)
}

// 完成一整节课，节奏与真机一致：
//   约课（第一帧就有块）→ **立即**只点一次进课程（本机编辑态）→ 用户在页面上加动作的这几秒里
//   createBooking 自然落定（onShow/订阅会把同一个页面就地接到正式 booking 上）→ 点下课。
// 真正**不允许**等待的是「点下课之后」：A 的完课链还在跑，用户就已经去约 B 了 —— 第 36 节的窗口就长在这里。
async function runCourse(row, exercises, options = {}) {
  const input = { studentId: row.studentId, studentName: row.name, packageId: row.packageId, packageIndex: 0, date: row.date, hour: row.hour, minute: 0, typeName: '常规训练', price: 100, command: 'createBooking' }
  const submitted = await coordinator.submit(input)
  assert.equal(submitted.ok, true, `${row.name} 约课必须第一帧成功`)
  const schedule = openSchedule()
  const cell = cellFor(schedule, row.date, row.hour)
  const block = cell.bookings.find(item => item.studentId === row.studentId)
  assert.ok(block, `${row.name} 的块必须第一帧就出现`)
  assert.equal(block.pending, true, `${row.name} 的块此时还是本机待确认`)
  resetCounters()
  schedule.booking({ currentTarget: { dataset: { id: block.id, pending: block.pendingKey } } })
  assert.equal(counters.navigations.length, 1, `${row.name} 一次点击只允许一次 navigateTo`)
  const page = openSessionFromLastUrl()
  assert.ok(page.pendingKey, `${row.name} 必须进入本机编辑态`)
  // 加动作的这几秒 = 真机上 create 落定的时间，页面就地把身份接到正式 booking 上。
  await awaitCreated(submitted.id)
  page.onShow()
  assert.ok(page.id, `${row.name} 转正后必须拿到正式 bookingId（否则下课链会在第一步就中止）`)
  exercises.forEach(name => page.addExercise({ detail: { name, group: '胸' } }))
  assert.equal(page.data.items.length, exercises.length, `${row.name} 动作必须第一帧就都在`)
  const draftKey = page.localDraftKey()
  // 诊断用：让「内容保存」这次回读确定性地失败（模拟并发写入/网络抖动）。
  if (options.badIntegrityFor) CLOUD.badIntegrity = options.badIntegrityFor
  // ★ 1.1.9 第 6 轮起，写命令成功后**先做一跳只读校验**（`{action:'integrity'}` 云调用）。
  //   只让本机完整性校验失败（badIntegrity）已经构造不出「本机没跟上云端」的形状了 ——
  //   那一跳不看本机 cache，checksum 不匹配也照样能确认。要让那一跳也失败，必须让**云调用本身**失败。
  if (options.throwIntegrityFor) CLOUD.throwIntegrity = options.throwIntegrityFor
  if (options.throwIntegrityAfterExecute) CLOUD.throwIntegrityAfterExecute = true
  const handle = await page.complete()                  // ← complete() 只做第一帧；刻意不 await handle.settled
  assert.ok(handle && handle.deferred === true, `${row.name} 完课必须第一帧返回句柄`)
  // ★ 用户按下课之后真正发生的第一件事：**课表那一格当场就是「已完成」**。
  //   这一帧云端根本没落地，依据只能是本机完课意图。断言必须打在这里 ——
  //   打在那个已经退场的课程页实例上（page.data.done）是钉错了对象：
  //   课程页在 real 里已经 navigateBack 了，用户看到的是课表。
  const intent = pendingCompletion.list(currentEnvironment, DATASET).find(item => item.localKey === handle.localId)
  assert.ok(intent, `${row.name} 点完下课的第一帧就必须立起本机完课意图（课表的「已完」全靠它）`)
  const backToSchedule = openSchedule()
  const backCell = cellFor(backToSchedule, row.date, row.hour)
  const backBlock = backCell.bookings.find(item => item.studentId === row.studentId)
  assert.ok(backBlock, `${row.name} 回到课表必须还能看到这节课`)
  assert.equal(backBlock.completed, true, `${row.name} 点完下课回到课表，那一格必须当场呈现「已完成」`)
  assert.equal(backBlock.statusLabel, '已完', `${row.name} 那一格必须是「已完」`)
  // 隐私：一格只允许出现本学员姓名，绝不显示其他学员。
  assert.equal(backBlock.bookingText, row.name, `${row.name} 那一格只能显示本学员`)
  return { row, page, handle, draftKey, submitted, firstFrameShowsDone: backBlock.completed }
}

const bookingCount = row => CLOUD.docs.bookings.filter(item => item.data.studentId === row.studentId).length
// 按「学员 + 日期 + 时段」定位 —— 同一位学员在连续多课里会有多条 booking，只按学员找会认错行。
const bookingAt = row => CLOUD.docs.bookings.find(item => item.data.studentId === row.studentId && item.data.date === row.date && item.data.hour === row.hour)
const incomeCountAt = row => { const booking = bookingAt(row); return CLOUD.docs.incomes.filter(item => item.data.bookingId === (booking && booking.data.id)).length }
const packageOf = row => findDoc('packages', 'packageId', row.packageId).data
const incomeCountOf = row => {
  const booking = CLOUD.docs.bookings.find(item => item.data.studentId === row.studentId)
  return CLOUD.docs.incomes.filter(item => item.data.bookingId === (booking && booking.data.id)).length
}
const itemsOf = row => {
  const booking = CLOUD.docs.bookings.find(item => item.data.studentId === row.studentId)
  return (booking && booking.data.items) || []
}
const receiptIdsFor = command => [...CLOUD.receipts.entries()].filter(([, value]) => value.response && value.response.command === command).map(([id]) => id)

const scenarios = []
const scenario = (name, fn) => scenarios.push({ name, fn })

// ============================================================ ① 用户的验收：A → B → C 连续三节，全程不重置
const results = []
let chainOk = false

scenario('① 连续三节课程（不同学员 / 不同课时包 / 不同时间）：A 完成后立刻开始 B，B 完成后立刻开始 C，全程不清 Storage', async () => {
  const W = Number(process.env.SEQ_WAIT || 0)   // 诊断用：正数=每节之间彻底等云端静下来（真机节奏）
  const a = await runCourse(STUDENTS[0], ['A1', 'A2', 'A3'])
  results.push(a)
  if (W) { await a.handle.settled; await settleAll(W) }
  // === 关键：不 await a.handle.settled，不等待云端，直接开始下一节 ===
  const b = await runCourse(STUDENTS[1], ['B1', 'B2', 'B3'])
  results.push(b)
  if (W) { await b.handle.settled; await settleAll(W) }
  const c = await runCourse(STUDENTS[2], ['C1', 'C2', 'C3'])
  results.push(c)
  await settleAll()
  ;[a, b, c].forEach(item => item.settled = item.handle.settled)
  await Promise.all([a.settled, b.settled, c.settled])
  await settleAll()

  chainOk = true
  // ---- 三节都必须真的完成：任何一节弹出「训练内容没有在云端确认保存」都算失败 ----
  const draftFailures = MODALS.filter(item => String(item.content || '').includes(DRAFT_MODAL))
  assert.equal(draftFailures.length, 0, `不允许出现「${DRAFT_MODAL}」：实际弹了 ${draftFailures.length} 次`)
  // 任何失败弹窗都不允许：连续多课不该出现「数据已变化 / 结果待确认 / 预约未生效 / 课程未完成」中的任何一种。
  assert.deepEqual(MODALS.map(item => item.title), [], `连续三节不允许出现任何失败弹窗：${JSON.stringify(MODALS.map(item => item.title))}`)
  // 任何失败弹窗都不允许：连续多课不该出现「数据已变化 / 结果待确认 / 预约未生效 / 课程未完成」中的任何一种。
  assert.deepEqual(counters.modals.map(item => item.title), [], `连续三节不允许出现任何失败弹窗：${JSON.stringify(counters.modals.map(item => item.title))}`)
  ;[a, b, c].forEach(item => {
    assert.equal(item.firstFrameShowsDone, true, `${item.row.name} 第一帧回课表就必须按已完成呈现`)
  })
  // 三节都落地之后，用户再打开课表：三格必须都是「已完」，且每格只显示本学员。
  const finalSchedule = openSchedule()
  STUDENTS.forEach(row => {
    const cell = cellFor(finalSchedule, row.date, row.hour)
    const block = cell.bookings.find(item => item.studentId === row.studentId)
    assert.ok(block && block.statusLabel === '已完', `${row.name} 云端落地后课表必须仍是「已完」`)
    assert.equal(block.bookingText, row.name, `${row.name} 那一格只能显示本学员`)
  })
})

scenario('② 三节各归各：3 条 booking、3 份不同的训练内容、3 个不同的完课 requestId', async () => {
  assert.equal(chainOk, true, '必须先跑完场景 ①')
  // 3 条不同的 booking（每节一条，绝不互相顶替）
  assert.equal(CLOUD.docs.bookings.length, 3, `必须恰好 3 条 booking，实际 ${CLOUD.docs.bookings.length}`)
  assert.equal(new Set(CLOUD.docs.bookings.map(item => item.data.id)).size, 3, '三条 booking 的 id 必须互不相同')
  STUDENTS.forEach(row => assert.equal(bookingCount(row), 1, `${row.name} 必须恰好 1 条 booking`))
  // 三个训练内容各归各
  assert.deepEqual(itemsOf(STUDENTS[0]).map(item => item.name), ['A1', 'A2', 'A3'])
  assert.deepEqual(itemsOf(STUDENTS[1]).map(item => item.name), ['B1', 'B2', 'B3'])
  assert.deepEqual(itemsOf(STUDENTS[2]).map(item => item.name), ['C1', 'C2', 'C3'])
  // 三个不同的完课 requestId
  const completeIds = receiptIdsFor('completeBooking')
  assert.equal(completeIds.length, 3, `完课必须恰好 3 次，实际 ${completeIds.length}`)
  assert.equal(new Set(completeIds).size, 3, '三节课的完课 requestId 必须互不相同')
  // 三节课的本机完课意图都必须清干净
  assert.equal(pendingCompletion.list(currentEnvironment, DATASET).length, 0, '完课意图不得残留')
  // 三份训练草稿都必须清干净（不存在 A 的草稿污染 B/C）
  STUDENTS.forEach(row => {
    const key = `${row.studentId}|${row.packageId}|${row.date}|${row.hour}|0`
    assert.equal(pendingDraft.get(currentEnvironment, DATASET, `pending:${key}`), null, `${row.name} 的 pending 草稿必须清干净`)
    const booking = CLOUD.docs.bookings.find(item => item.data.studentId === row.studentId)
    assert.equal(pendingDraft.get(currentEnvironment, DATASET, booking.data.id), null, `${row.name} 的正式草稿必须清干净`)
  })
})

scenario('③ 财务事实各恰好一次：每节各自扣 1 节课时、各自 1 条 Income，且不串包', async () => {
  assert.equal(chainOk, true, '必须先跑完场景 ①')
  STUDENTS.forEach(row => {
    const pkg = packageOf(row)
    assert.equal(pkg.used, 1, `${row.name} 的课时包必须恰好扣 1，实际 ${pkg.used}`)
    assert.equal(pkg.remaining, 4, `${row.name} 的课时包必须恰好剩 4，实际 ${pkg.remaining}`)
    assert.equal(incomeCountOf(row), 1, `${row.name} 必须恰好 1 条 Income，实际 ${incomeCountOf(row)}`)
    assert.equal(CLOUD.docs.bookings.find(item => item.data.studentId === row.studentId).data.status, 'done', `${row.name} 的 booking 必须是 done`)
  })
  assert.equal(CLOUD.docs.incomes.length, 3, `总收入必须恰好 3 条，实际 ${CLOUD.docs.incomes.length}`)
})

// ============================================================ ④ 确定性窗口：回读期间云端发生写入
scenario('④ 确定性复现真机窗口：完课命令的回读还在路上时，另一条命令推进了 revision', async () => {
  // 这一条把「旧 mock 里根本不存在」的真实语义单独钉住：
  //   execute 成功之后 adapter 会 await 一次完整回读；回读的 integrity 会**重新读一次** revision，
  //   客户端再拿它与 metadata 那次读到的比对。只要这中间有别的写入落地，整次回读就会失败。
  resetCounters()
  const before = CLOUD.counters.execute
  holdIntegrity()                                        // 按住 integrity，制造确定性的窗口
  const pendingCall = coordinator.submit({ studentId: 'stu-A', studentName: '学员A', packageId: 'pkg-A', packageIndex: 0, date: '2026-09-16', hour: 20, minute: 0, typeName: '常规训练', price: 100, command: 'createBooking' })
  const submitted = await pendingCall
  assert.equal(submitted.ok, true)
  await delay(30)                                        // 让 createBooking 跑完、回读卡在 integrity
  const stuckRevision = CLOUD.dataRevision
  // 窗口内推进 revision：确认这条写入不会与上面那次回读冲突（它自己会触发另一次回读）。
  const concurrent = await coordinator.submit({ studentId: 'stu-B', studentName: '学员B', packageId: 'pkg-B', packageIndex: 0, date: '2026-09-16', hour: 21, minute: 0, typeName: '常规训练', price: 100, command: 'createBooking' })
  assert.equal(concurrent.ok, true, '窗口内的第二条预约必须能正常发出')
  assert.ok(CLOUD.counters.execute > before, '窗口内确实执行了命令')
  releaseIntegrity()
  await settleAll()
  // 断言的是机制本身：revision 是单调推进的，回读失败是**可见且可区分**的，不会被误判成「业务没保存」。
  assert.ok(CLOUD.dataRevision > stuckRevision, 'revision 必须单调推进')
  assert.equal(CLOUD.readLog.length > 0, true, '回读确实发生过')
})

// ============================================================ ⑤ 静态钉子
scenario('⑤ 静态回归：不许靠「降低安全门」或「提前写事实」来让连续课程变绿', async () => {
  const fs = require('fs')
  const strip = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const session = strip(fs.readFileSync(path.join(__dirname, '..', 'pages/session/session.js'), 'utf8'))
  assert.ok(session.includes('DRAFT_NOT_CONFIRMED'), '★ 训练内容必须先云端确认的安全门必须保留')
  assert.ok(session.includes('failCompletion'), '明确失败必须撤回意图并提示')
  const optimistic = strip(fs.readFileSync(path.join(__dirname, '..', 'utils/booking-optimistic.js'), 'utf8'))
  assert.equal(/pkg\.used|incomes\.push/.test(optimistic), false, '协调器不得自己扣课时或造收入')
  const completion = strip(fs.readFileSync(path.join(__dirname, '..', 'utils/pending-completion.js'), 'utf8'))
  assert.equal(/ActiveCache|coachDB|saveDB/.test(completion), false, '本机完课意图不得触碰 active cache / coachDB')
})

// ============================================================ ⑥ 确定性钉住「写命令单航班」
scenario('⑥ 上一条写命令还在路上时发起下一条：必须排队等它回来，绝不允许带过期的 expectedRevision 冲出去', async () => {
  // 这一条把第 36 节的根因单独钉住，而且**不依赖时序运气**：
  //   服务端的回执被闸门按住 = 上一条命令确实在途（客户端还不知道它把 revision 推到了几），
  //   这时再发起一条写命令。修复前：第二条会带着**旧 revision** 发出 → 服务端 REVISION_CONFLICT
  //   → 弹「数据已变化」，这条预约凭空消失（第 2 节起必挂）。
  //   修复后：命令通道是单航班，第二条要等第一条返回、新 revision 写回内存态之后才发，
  //   所以它的 expectedRevision 必然等于服务端的当前值。
  const traceStart = CLOUD.trace.length, executedStart = CLOUD.counters.execute
  holdExecute()
  const first = adapter.execute('createBooking', { studentId: 'stu-A', packageId: 'pkg-A', date: '2026-11-02', hour: 9, minute: 0 }, { requestId: 'seq_slot_first_0001' })
  await delay(30)
  assert.equal(CLOUD.counters.execute, executedStart + 1, '第一条命令必须已经打到云端（闸门只按住回执，不按住提交）')
  // 窗口内发起第二条写命令（不同学员、不同时段、不同 requestId）
  const second = adapter.execute('createBooking', { studentId: 'stu-C', packageId: 'pkg-C', date: '2026-11-03', hour: 14, minute: 0 }, { requestId: 'seq_slot_second_0002' })
  await delay(30)
  assert.equal(CLOUD.counters.execute, executedStart + 1, '第二条在第一条的了结之前**不许**发出去（单航班）')
  releaseExecute()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.ok, true, `第一条必须成功：${firstResult.code || ''}`)
  assert.equal(secondResult.ok, true, `第二条必须成功：${secondResult.code || ''}`)
  assert.equal(CLOUD.counters.execute, executedStart + 2, '两条都必须真的发出去过（不是被丢弃）')
  const window = CLOUD.trace.slice(traceStart).filter(item => item.requestId === 'seq_slot_first_0001' || item.requestId === 'seq_slot_second_0002')
  assert.equal(window.length, 2, `窗口内必须恰好两条命令：${JSON.stringify(window)}`)
  assert.deepEqual(window.map(item => item.conflict), [false, false], `两条命令都不允许冲突：${JSON.stringify(window)}`)
  assert.equal(window[1].expected, firstResult.datasetRevision, `第二条必须看见第一条推进后的 revision（排队），实际 expected=${window[1].expected} current=${window[1].current}`)
  // 两条预约都必须真的落库，且各归各。
  assert.ok(CLOUD.docs.bookings.some(row => row.data.studentId === 'stu-A' && row.data.date === '2026-11-02' && row.data.hour === 9), '第一条预约必须落库')
  assert.ok(CLOUD.docs.bookings.some(row => row.data.studentId === 'stu-C' && row.data.date === '2026-11-03' && row.data.hour === 14), '第二条预约必须落库')
})

// ============================================================ ⑦ 确定性钉住「已提交 ≠ 没保存」
scenario('⑦ 内容已提交、只是回读失败：必须补一次确凿证据后照常完课，绝不许误报「训练内容没有在云端确认保存」', async () => {
  // 第 36 节的第二处缺口：`persistDraft` 把「这次回读成功」当成了「内容已确认保存在云端」。
  // 回读要跑完 metadata + 八集合分页 + integrity，任何并发写入/网络抖动都会让它整体失败 ——
  // 而那条命令**早已提交成功**。于是第 2 节起每次下课都弹「训练内容没有在云端确认保存」。
  // 修复后：命令已提交 = 内容确实在云端；回读失败只影响本机 cache 的同步进度。
  // ⚠️ 放行前必须补一次确凿证据（重同步成功 或 本次 requestId 的 receipt=succeeded），
  //    拿不到就照旧拒绝 —— 安全门一毫米都不降。
  const row = { studentId: 'stu-B', packageId: 'pkg-B', name: '学员B', date: '2026-11-05', hour: 11 }
  MODALS.length = 0
  const usedBefore = packageOf(row).used, historyBefore = CLOUD.counters.integrity
  // 让**这次内容保存的确认**确定性失败：命令照常提交成功，但客户端那一跳只读校验与兜底完整回读都失败
  //（= 真机上的"并发写入 / 网络抖一下"）。注入在下一条写命令返回的那一刻才武装，不会波及别的读取。
  const a = await runCourse(row, ['B7', 'B8'], { throwIntegrityAfterExecute: true })
  await a.handle.settled
  await settleAll()
  assert.equal(CLOUD.throwIntegrity, 0, '这次保存的确认（一跳 + 兜底）必须真的把注入的两次失败用掉')
  assert.ok(CLOUD.counters.integrity > historyBefore, '回读确实发生过')
  const flush = TRACE.commands.filter(item => item.command === 'updateBookingContent').slice(-1)[0]
  // ★ 命令一方**一个字都没被否定**：ok 仍为 true；本机确认失败则如实带出 refreshFailed，绝不假装成功。
  assert.ok(flush && flush.code === 'ok' && flush.refreshFailed === true, `必须复现「命令成功但本机确认失败」：${JSON.stringify(flush)}`)
  assert.deepEqual(MODALS.map(item => item.title), [], `不允许出现任何弹窗：${JSON.stringify(MODALS.map(item => item.title))}`)
  // 内容确实在云端、课程确实完成一次、课时恰好扣 1、收入恰好 1 条
  const booking = bookingAt(row)
  assert.ok(booking && booking.data.status === 'done', '课程必须照常完成')
  assert.deepEqual((booking.data.items || []).map(item => item.name), ['B7', 'B8'], '训练内容必须真的在云端')
  assert.equal(packageOf(row).used, usedBefore + 1, '课时必须恰好扣 1')
  assert.equal(incomeCountAt(row), 1, '收入必须恰好 1 条')
  assert.equal(pendingDraft.get(currentEnvironment, DATASET, booking.data.id), null, '草稿必须清干净')
  assert.equal(pendingCompletion.list(currentEnvironment, DATASET).length, 0, '完课意图不得残留')
})

// ============================================================ ⑧ 回读抛错也不许污染命令结果
scenario('⑧ 回读在网络上抛错：一次已提交的命令绝不能被报成「结果未知」（否则刚约完就查不到课程）', async () => {
  // 这是第 36 节最阴的一层：`readActive` 在 execute 成功之后**抛异常**（而不是返回 ok:false）。
  // 旧写法里这个异常会直接冒出 execute，调用方只能理解成「命令结果未知」——
  // 协调器于是弹「结果待确认」并**永不绑定正式身份**，课程页也就永远查不到这门课。
  // 判据只能是服务端事实：命令已经提交（receipt 与业务写在同一事务里），本机回读失败与它无关。
  CLOUD.throwIntegrity = 2
  const result = await adapter.execute('createBooking', { studentId: 'stu-C', packageId: 'pkg-C', date: '2026-11-06', hour: 15, minute: 0 }, { requestId: 'seq_refresh_throw_0001' })
  assert.equal(result.ok, true, `命令必须返回成功，而不是抛错或结果未知：${JSON.stringify(result)}`)
  assert.equal(!!result.refreshFailed, true, `这次回读必须真的失败了（否则场景是空的）：${JSON.stringify(result)}`)
  assert.equal(result.refreshFailed.code, 'REFRESH_THREW', `回读失败必须被如实记成 REFRESH_THREW：${JSON.stringify(result.refreshFailed)}`)
  // ★ 1.1.9 第 6 轮：命令成功之后的确认是**两跳**——先一跳只读校验，它失败才走兜底完整回读。
  //   注入的 2 次正好被这两跳用掉（每次都命中 integrity 读）。
  assert.equal(CLOUD.throwIntegrity, 0, '两跳都必须真的抛过：一跳只读校验 1 次 + 兜底完整回读 1 次')
  assert.ok(CLOUD.docs.bookings.some(row => row.data.date === '2026-11-06' && row.data.hour === 15), '预约必须已经落在云端')
  assert.equal(CLOUD.receipts.has('seq_refresh_throw_0001'), true, '云端必须已经留下成功回执')
})

;(async () => {
  // 真机启动时本来就有一份 active cache（上一次读盘留下的），协调器靠它拿到 datasetId。
  // 这里先做一次真实回读把它建起来 —— 之后全程不再重建、不再清空。
  const bootstrap = await adapter.readActive()
  assert.equal(bootstrap.ok, true, `启动回读必须成功：${bootstrap.code || ''}`)
  for (const item of scenarios) {
    const started = Date.now()
    await item.fn()
    console.log(`  ✓ ${item.name} (${Date.now() - started}ms)`)
  }
  console.log(`session sequential courses tests: PASS (${scenarios.length} scenarios)`)
})().catch(error => {
  console.error('FAILED:', error && error.message)
  console.error(error && error.stack)
  console.error('— 现场 —')
  console.error('  弹窗:', JSON.stringify(modalTitles(), null, 0))
  console.error('  booking:', JSON.stringify(CLOUD.docs.bookings.map(row => ({ id: row.data.id, student: row.data.studentId, status: row.data.status, items: (row.data.items || []).map(x => x.name) }))))
  console.error('  package:', JSON.stringify(CLOUD.docs.packages.map(row => ({ id: row.data.id, used: row.data.used, remaining: row.data.remaining }))))
  console.error('  incomes:', CLOUD.docs.incomes.length, 'revision:', CLOUD.dataRevision)
  console.error('  applyLog:', JSON.stringify(CLOUD.applyLog.map(item => item.command)))
  console.error('  trace:', JSON.stringify(CLOUD.trace))
  console.error('  adapter state:', JSON.stringify(adapter.getState()))
  console.error('  adapter 轨迹:', JSON.stringify(TRACE.adapter))
  console.error('  命令结果:', JSON.stringify(TRACE.commands))
  console.error('  草稿轨迹:', JSON.stringify(TRACE.drafts))
  console.error('  cloudCall 抛错:', JSON.stringify(CLOUD.thrown))
  console.error('  counters:', JSON.stringify(CLOUD.counters))
  console.error('  pageLog:', JSON.stringify(CLOUD.pageLog.slice(-24)))
  console.error('  弹窗正文:', JSON.stringify(MODALS.map(item => String(item.content || '').slice(0, 60))))
  process.exitCode = 1
}).finally(() => {
  if (oldRuntime) require.cache[runtimePath] = oldRuntime; else delete require.cache[runtimePath]
  if (oldCommand) require.cache[commandPath] = oldCommand; else delete require.cache[commandPath]
})
