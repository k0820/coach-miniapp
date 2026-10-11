const crypto = require('crypto')

const NAMES = Object.freeze({
  revisions: 'coach_command_test_revisions', receipts: 'coach_command_test_receipts',
  students: 'coach_command_test_students', packages: 'coach_command_test_packages',
  bookings: 'coach_command_test_bookings', incomes: 'coach_command_test_incomes',
  sales: 'coach_command_test_sales', settings: 'coach_command_test_settings',
  exercises: 'coach_command_test_custom_exercises'
})
const ALL_NAMES = Object.values(NAMES)
const FORBIDDEN = new Set(['OPENID', 'openId', 'openid', '_openid', 'coachId', 'ownerCoachId', 'documentId'])

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const coachIdFor = openId => sha(`coach:${openId}`).slice(0, 32)
const docId = (owner, kind, id) => sha(`command-test:${owner}:${kind}:${id}`).slice(0, 32)
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const commandHash = envelope => sha(canonical({ command: envelope.command, payload: envelope.payload }))
const result = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })
const error = (code, message, extra = {}) => Object.assign(new Error(message), { commandCode: code, extra })

function forbiddenPath(value, path = 'event') {
  if (!value || typeof value !== 'object') return null
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key)) return `${path}.${key}`
    const found = forbiddenPath(value[key], `${path}.${key}`)
    if (found) return found
  }
  return null
}

// CloudBase may append event.userInfo (including openId) to the invocation
// event. It is platform metadata, not part of this function's business input:
// never trust it for identity, but do not reject an otherwise valid call merely
// because the runtime supplied it. All caller-controlled business fields remain
// subject to the recursive forbidden-field check below.
function forbiddenBusinessInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  for (const key of Object.keys(event)) {
    if (key === 'userInfo') continue
    if (FORBIDDEN.has(key)) return `event.${key}`
    const found = forbiddenPath(event[key], `event.${key}`)
    if (found) return found
  }
  return null
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw error('INVALID_COMMAND', '命令格式无效。')
  const forbidden = forbiddenPath(envelope, 'envelope')
  if (forbidden) throw error('FORBIDDEN_IDENTITY_INPUT', `客户端不得提交身份或云文档定位字段：${forbidden}`)
  if (!['completeBooking', 'reverseCourseSale'].includes(envelope.command)) throw error('UNKNOWN_COMMAND', '隔离测试只开放指定事务命令。')
  if (typeof envelope.requestId !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(envelope.requestId)) throw error('INVALID_REQUEST_ID', 'requestId 无效。')
  if (!Number.isInteger(envelope.expectedRevision) || envelope.expectedRevision < 0) throw error('INVALID_REVISION', 'expectedRevision 无效。')
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) throw error('INVALID_PAYLOAD', 'payload 无效。')
}

async function getDoc(scope, name, id) {
  const response = await scope.collection(name).where({ _id: id }).limit(1).get(), rows = response && response.data || []
  return rows[0] || null
}
async function setDoc(scope, name, id, data) { const { _id, ...body } = data; return scope.collection(name).doc(id).set({ data: body }) }
async function removeOwned(db, name, owner) {
  while (true) {
    const response = await db.collection(name).where({ ownerCoachId: owner }).limit(100).get(), rows = response.data || []
    if (!rows.length) return
    await Promise.all(rows.map(row => db.collection(name).doc(row._id).remove()))
  }
}
function fixtures(owner, now) {
  const studentId = 'student-main', paidPackageId = 'package-paid', reversePackageId = 'package-reverse'
  return {
    revision: { ownerCoachId: owner, dataRevision: 0, updatedAt: now },
    students: [{ businessId: studentId, ownerCoachId: owner, studentId, name: '事务测试学员' }],
    packages: [
      { businessId: paidPackageId, ownerCoachId: owner, packageId: paidPackageId, studentId, type: '常规训练', total: 10, used: 2, remaining: 8, price: 300, status: 'active' },
      { businessId: reversePackageId, ownerCoachId: owner, packageId: reversePackageId, studentId, saleId: 'sale-reverse', type: '常规训练', total: 10, used: 2, remaining: 8, price: 300, status: 'active' }
    ],
    bookings: [
      { businessId: 'booking-complete', ownerCoachId: owner, bookingId: 'booking-complete', studentId, studentName: '事务测试学员', packageId: paidPackageId, typeName: '常规训练', price: 300, date: '2026-09-12', hour: 10, minute: 0, status: 'booked' },
      { businessId: 'booking-history', ownerCoachId: owner, bookingId: 'booking-history', studentId, studentName: '事务测试学员', packageId: reversePackageId, typeName: '常规训练', price: 300, date: '2026-09-10', hour: 10, minute: 0, status: 'done', items: [{ name: '历史动作' }] },
      { businessId: 'booking-future', ownerCoachId: owner, bookingId: 'booking-future', studentId, studentName: '事务测试学员', packageId: reversePackageId, typeName: '常规训练', price: 300, date: '2026-09-20', hour: 10, minute: 0, status: 'booked' }
    ],
    incomes: [{ businessId: 'income-history', ownerCoachId: owner, incomeId: 'income-history', bookingId: 'booking-history', studentId, amount: 300 }],
    sales: [{ businessId: 'sale-reverse', ownerCoachId: owner, saleId: 'sale-reverse', packageId: reversePackageId, studentId, source: 'course', amount: 3000, status: 'active' }],
    settings: [{ businessId: 'settings', ownerCoachId: owner, classCommissionRate: 10, salesCommissionRate: 5 }], exercises: []
  }
}

async function resetOwner(db, owner, now) {
  for (const name of ALL_NAMES) await removeOwned(db, name, owner)
  const seed = fixtures(owner, now), revisionId = docId(owner, 'revision', 'main')
  await setDoc(db, NAMES.revisions, revisionId, seed.revision)
  for (const key of ['students', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'exercises']) {
    for (const row of seed[key]) await setDoc(db, NAMES[key], docId(owner, key, row.businessId), row)
  }
  return { ok: true, ownerCoachId: owner, dataRevision: 0, testIds: { studentId: 'student-main', completeBookingId: 'booking-complete', reverseSaleId: 'sale-reverse' } }
}

async function completeBooking(tx, owner, envelope, controls, now) {
  const bookingId = String(envelope.payload.bookingId || ''), bookingDocId = docId(owner, 'bookings', bookingId), booking = await getDoc(tx, NAMES.bookings, bookingDocId)
  if (!booking || booking.ownerCoachId !== owner) throw error('BOOKING_NOT_FOUND', '测试预约不存在或不属于当前用户。')
  if (booking.status === 'done') throw error('BOOKING_ALREADY_DONE', '测试预约已经完成。')
  const packageDocId = docId(owner, 'packages', booking.packageId), pkg = await getDoc(tx, NAMES.packages, packageDocId)
  if (!pkg || pkg.ownerCoachId !== owner) throw error('PACKAGE_NOT_FOUND', '精确课时包不存在或不属于当前用户。')
  if (pkg.status === 'reversed' || Number(pkg.remaining) <= 0) throw error('PACKAGE_UNAVAILABLE', '精确课时包不可用。')
  const incomeId = `income-${bookingId}`, incomeDocId = docId(owner, 'incomes', incomeId), oldIncome = await getDoc(tx, NAMES.incomes, incomeDocId)
  if (oldIncome) throw error('INCOME_ALREADY_EXISTS', '测试收入已经存在。')
  await setDoc(tx, NAMES.bookings, bookingDocId, { ...booking, status: 'done', completedAt: now, items: copy(envelope.payload.items || [{ name: '事务测试动作' }]) })
  await setDoc(tx, NAMES.packages, packageDocId, { ...pkg, used: Number(pkg.used || 0) + 1, remaining: Number(pkg.remaining || 0) - 1 })
  if (controls.failAt === 'income') throw error('INJECTED_INCOME_FAILURE', '已模拟 income 写入失败。')
  await setDoc(tx, NAMES.incomes, incomeDocId, { ownerCoachId: owner, businessId: incomeId, incomeId, bookingId, studentId: booking.studentId, amount: booking.typeName === '赠送课程' ? 80 : Number(booking.price), createdAt: now })
  return { bookingId, packageId: booking.packageId, incomeId }
}

async function reverseCourseSale(tx, owner, envelope, controls, now) {
  const saleId = String(envelope.payload.saleId || ''), saleDocId = docId(owner, 'sales', saleId), sale = await getDoc(tx, NAMES.sales, saleDocId)
  if (!sale || sale.ownerCoachId !== owner) throw error('SALE_NOT_FOUND', '测试销售不存在或不属于当前用户。')
  if (sale.status === 'reversed') throw error('SALE_ALREADY_REVERSED', '测试销售已经撤销。')
  const packageDocId = docId(owner, 'packages', sale.packageId), pkg = await getDoc(tx, NAMES.packages, packageDocId)
  if (!pkg || pkg.ownerCoachId !== owner || pkg.saleId !== saleId) throw error('SALE_RELATION_INVALID', '测试销售与课时包关联异常。')
  const bookingResponse = await tx.collection(NAMES.bookings).where({ ownerCoachId: owner, packageId: sale.packageId }).get(), linked = bookingResponse.data || []
  await setDoc(tx, NAMES.sales, saleDocId, { ...sale, status: 'reversed', reversedAt: now })
  await setDoc(tx, NAMES.packages, packageDocId, { ...pkg, status: 'reversed', remaining: 0, reversedAt: now })
  if (controls.failAt === 'reverseBookings') throw error('INJECTED_REVERSE_FAILURE', '已模拟撤销销售中途失败。')
  let cancelledBookings = 0
  for (const booking of linked) if (booking.status !== 'done') { await tx.collection(NAMES.bookings).doc(booking._id).remove(); cancelledBookings += 1 }
  return { saleId, packageId: sale.packageId, cancelledBookings }
}

async function executeCommand(db, owner, envelope, controls, now) {
  validateEnvelope(envelope)
  const revisionId = docId(owner, 'revision', 'main'), receiptId = docId(owner, 'receipt', envelope.requestId), fingerprint = commandHash(envelope)
  try {
    return await db.runTransaction(async tx => {
      const existing = await getDoc(tx, NAMES.receipts, receiptId)
      if (existing) {
        if (existing.ownerCoachId !== owner || existing.command !== envelope.command || existing.payloadHash !== fingerprint) throw error('REQUEST_ID_CONFLICT', '同一 requestId 对应了不同命令或参数。')
        if (existing.status === 'succeeded') return { ...copy(existing.response), idempotent: true }
        throw error('REQUEST_PROCESSING', '请求仍在处理中，可安全重试。', { retrySafe: true })
      }
      const revision = await getDoc(tx, NAMES.revisions, revisionId)
      if (!revision || revision.ownerCoachId !== owner) throw error('TEST_STATE_NOT_FOUND', '请先初始化当前微信的隔离测试数据。')
      if (Number(revision.dataRevision) !== envelope.expectedRevision) throw error('REVISION_CONFLICT', '测试数据已被其他请求更新。', { currentRevision: Number(revision.dataRevision) })
      await setDoc(tx, NAMES.receipts, receiptId, { ownerCoachId: owner, requestId: envelope.requestId, command: envelope.command, payloadHash: fingerprint, status: 'processing', revisionBefore: revision.dataRevision, createdAt: now })
      const commandResult = envelope.command === 'completeBooking' ? await completeBooking(tx, owner, envelope, controls, now) : await reverseCourseSale(tx, owner, envelope, controls, now)
      const nextRevision = Number(revision.dataRevision) + 1
      await setDoc(tx, NAMES.revisions, revisionId, { ...revision, dataRevision: nextRevision, updatedAt: now })
      const response = { ok: true, command: envelope.command, requestId: envelope.requestId, revision: nextRevision, result: commandResult }
      await setDoc(tx, NAMES.receipts, receiptId, { ownerCoachId: owner, requestId: envelope.requestId, command: envelope.command, payloadHash: fingerprint, status: 'succeeded', revisionBefore: revision.dataRevision, revisionAfter: nextRevision, response, completedAt: now })
      return response
    })
  } catch (e) { return result(e.commandCode || 'TRANSACTION_FAILED', e.message || '测试事务执行失败。', e.extra || {}) }
}

async function readOwner(db, owner) {
  const read = async name => (await db.collection(name).where({ ownerCoachId: owner }).limit(100).get()).data || []
  const revision = await getDoc(db, NAMES.revisions, docId(owner, 'revision', 'main'))
  const packages = await read(NAMES.packages), bookings = await read(NAMES.bookings), incomes = await read(NAMES.incomes), sales = await read(NAMES.sales), receipts = await read(NAMES.receipts)
  return { ok: true, ownerCoachId: owner, dataRevision: revision ? Number(revision.dataRevision) : null, packages: packages.map(x => ({ packageId: x.packageId, used: x.used, remaining: x.remaining, status: x.status })), bookings: bookings.map(x => ({ bookingId: x.bookingId, packageId: x.packageId, status: x.status })), incomes: incomes.map(x => ({ incomeId: x.incomeId, bookingId: x.bookingId, amount: x.amount })), sales: sales.map(x => ({ saleId: x.saleId, packageId: x.packageId, status: x.status })), receipts: receipts.map(x => ({ requestId: x.requestId, status: x.status, revisionAfter: x.revisionAfter })) }
}

function createService({ db, getOpenId, now = () => Date.now() }) {
  return async function main(event = {}) {
    const openId = getOpenId()
    if (!openId) return result('IDENTITY_MISSING', '未能确认当前微信身份。')
    const forged = forbiddenBusinessInput(event)
    if (forged) return result('FORBIDDEN_IDENTITY_INPUT', `客户端不得提交身份或云文档定位字段：${forged}`)
    const owner = coachIdFor(openId), action = event.action
    try {
      if (action === 'reset') return resetOwner(db, owner, now())
      if (action === 'execute') return executeCommand(db, owner, event.envelope, { failAt: event.failAt }, now())
      if (action === 'read') return readOwner(db, owner)
      if (action === 'cleanup') { for (const name of ALL_NAMES) await removeOwned(db, name, owner); return { ok: true, cleaned: true } }
      return result('UNKNOWN_ACTION', '不支持的隔离测试操作。')
    } catch (e) { return result(e.commandCode || 'TEST_ACTION_FAILED', e.message || '隔离测试操作失败。', e.extra || {}) }
  }
}

module.exports = { NAMES, ALL_NAMES, coachIdFor, docId, canonical, commandHash, forbiddenBusinessInput, createService }
