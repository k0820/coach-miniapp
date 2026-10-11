const assert = require('assert')
const { InMemoryCommandEngine } = require('../utils/cloud-command-engine')

let requestSequence = 0
const command = (name, revision, payload = {}, requestId) => ({ command: name, requestId: requestId || `request_${String(++requestSequence).padStart(4, '0')}`, expectedRevision: revision, payload })
const ownerA = { ownerCoachId: 'coach_a' }, ownerB = { ownerCoachId: 'coach_b' }
const base = () => ({
  dataRevision: 0,
  students: [{ id: 'student_a', name: '张三', phone: '', packages: [
    { id: 'package_paid', saleId: 'sale_paid', type: '常规训练', total: 10, used: 0, remaining: 10, price: 300, saleDate: '2026-09-01', status: 'active' },
    { id: 'package_same_type', saleId: 'sale_same', type: '常规训练', total: 20, used: 0, remaining: 20, price: 400, saleDate: '2026-09-02', status: 'active' },
    { id: 'package_gift', type: '赠送课程', total: 2, used: 0, remaining: 2, price: 80, status: 'active', isGift: true }
  ] }],
  bookings: [
    { id: 'booking_paid', studentId: 'student_a', studentName: '张三', packageId: 'package_paid', typeName: '常规训练', price: 300, date: '2026-09-10', hour: 10, minute: 0, status: 'booked', items: [{ name: '卧推', group: '胸', sets: 4, reps: 12, weight: 40 }] },
    { id: 'booking_gift', studentId: 'student_a', studentName: '张三', packageId: 'package_gift', typeName: '赠送课程', price: 80, date: '2026-09-11', hour: 10, minute: 0, status: 'booked', items: [{ name: '赠课动作', group: '腿', sets: 3, reps: 12, weight: 20 }] }
  ],
  incomes: [],
  sales: [
    { id: 'sale_paid', source: 'course', studentId: 'student_a', packageId: 'package_paid', typeName: '常规训练', quantity: 10, unitPrice: 300, amount: 2800, date: '2026-09-01' },
    { id: 'sale_same', source: 'course', studentId: 'student_a', packageId: 'package_same_type', typeName: '常规训练', quantity: 20, unitPrice: 400, amount: 7600, date: '2026-09-02' }
  ],
  settings: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 10, salesCommissionRate: 5 },
  customExercises: [{ id: 'exercise_legacy_mapped', name: '自定义动作', group: '胸' }]
})

function engineWithBase() {
  let id = 0
  const engine = new InMemoryCommandEngine({ now: () => 1789000000000, idFactory: kind => `${kind}_generated_${++id}` })
  engine.seed('coach_a', base()); engine.seed('coach_b', { dataRevision: 0, students: [], bookings: [], incomes: [], sales: [], settings: {}, customExercises: [] })
  return engine
}

function test(name, fn) {
  try { fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}

test('completeBooking 同 requestId 重试只扣一次并只生成一条 income', () => {
  const engine = engineWithBase(), req = command('completeBooking', 0, { bookingId: 'booking_paid' }, 'complete_retry_001')
  const first = engine.execute(ownerA, req), second = engine.execute(ownerA, req), state = engine.read('coach_a')
  assert.equal(first.ok, true); assert.equal(second.ok, true); assert.equal(second.idempotent, true)
  assert.equal(state.students[0].packages[0].used, 1); assert.equal(state.students[0].packages[0].remaining, 9); assert.equal(state.incomes.length, 1); assert.equal(state.dataRevision, 1)
})

test('两个设备使用同 revision 只有第一个命令成功', () => {
  const engine = engineWithBase()
  const a = engine.execute(ownerA, command('saveSettings', 0, { renewThreshold: 8 }, 'device_a_req'))
  const b = engine.execute(ownerA, command('saveSettings', 0, { renewThreshold: 9 }, 'device_b_req'))
  assert.equal(a.ok, true); assert.equal(b.code, 'REVISION_CONFLICT'); assert.equal(engine.read('coach_a').settings.renewThreshold, 8)
})

test('booking.packageId 缺失时整体失败且不会切换同类型包', () => {
  const engine = engineWithBase(), before = engine.read('coach_a')
  const state = engine.read('coach_a'); state.bookings[0].packageId = 'missing_package'; engine.seed('coach_a', state)
  const result = engine.execute(ownerA, command('completeBooking', 0, { bookingId: 'booking_paid' }))
  assert.equal(result.code, 'PACKAGE_NOT_FOUND'); const after = engine.read('coach_a')
  assert.equal(after.students[0].packages[1].remaining, 20); assert.equal(after.incomes.length, 0); assert.equal(after.dataRevision, 0); assert.notDeepEqual(after, before)
})

test('income 创建失败会回滚 booking 和 exact package', () => {
  const engine = engineWithBase(), before = engine.read('coach_a')
  const result = engine.execute(ownerA, command('completeBooking', 0, { bookingId: 'booking_paid' }), { failAtStep: 'income-created' })
  assert.equal(result.code, 'INJECTED_FAILURE'); assert.deepEqual(engine.read('coach_a'), before)
})

test('reverseCourseSale 中途失败会回滚 sale package bookings', () => {
  const engine = engineWithBase(), before = engine.read('coach_a')
  const result = engine.execute(ownerA, command('reverseCourseSale', 0, { saleId: 'sale_paid' }), { failAtStep: 'future-bookings-cancelled' })
  assert.equal(result.code, 'INJECTED_FAILURE'); assert.deepEqual(engine.read('coach_a'), before)
})

test('撤销部分使用销售保留 done booking 与 income，只清零余额和未来预约', () => {
  const engine = engineWithBase(), state = engine.read('coach_a'), pkg = state.students[0].packages[0]
  pkg.used = 1; pkg.remaining = 9; state.bookings[0].status = 'done'; state.bookings[0].items = [{ name: '历史卧推' }]
  state.incomes.push({ id: 'income_history', bookingId: 'booking_paid', amount: 300 })
  state.bookings.push({ id: 'booking_future', studentId: 'student_a', packageId: 'package_paid', typeName: '常规训练', status: 'booked', date: '2026-09-12', hour: 11 })
  engine.seed('coach_a', state)
  const result = engine.execute(ownerA, command('reverseCourseSale', 0, { saleId: 'sale_paid' })), after = engine.read('coach_a')
  assert.equal(result.ok, true); assert.equal(after.sales[0].status, 'reversed'); assert.equal(after.students[0].packages[0].remaining, 0)
  assert(after.bookings.some(x => x.id === 'booking_paid')); assert(!after.bookings.some(x => x.id === 'booking_future')); assert(after.incomes.some(x => x.id === 'income_history'))
})

test('quantity unitPrice amount remaining 独立，total 小于 used 不改历史', () => {
  const engine = engineWithBase(), state = engine.read('coach_a'); state.students[0].packages[0].used = 5; state.students[0].packages[0].remaining = 7; engine.seed('coach_a', state)
  const result = engine.execute(ownerA, command('updateCourseSale', 0, { saleId: 'sale_paid', quantity: 3, remaining: 9, unitPrice: 350, amount: 777, date: '2026-08-31', confirmTotalBelowUsed: true })), after = engine.read('coach_a'), pkg = after.students[0].packages[0], sale = after.sales[0]
  assert.equal(result.ok, true); assert.equal(pkg.total, 3); assert.equal(pkg.used, 5); assert.equal(pkg.remaining, 9); assert.equal(pkg.price, 350); assert.equal(sale.amount, 777); assert.equal(sale.date, '2026-08-31')
})

test('gift package 不产生 sale，完课收入固定 80', () => {
  const engine = engineWithBase()
  const complete = engine.execute(ownerA, command('completeBooking', 0, { bookingId: 'booking_gift' })), after = engine.read('coach_a')
  assert.equal(complete.ok, true); assert.equal(after.incomes[0].amount, 80); assert.equal(after.sales.length, 2)
  const create = engine.execute(ownerA, command('createPackage', 1, { studentId: 'student_a', type: '赠送课程', isGift: true, total: 3, remaining: 3 })), final = engine.read('coach_a')
  assert.equal(create.ok, true); assert.equal(final.sales.length, 2)
})

test('A 无法操作 B 的记录，伪造身份字段被拒绝', () => {
  const engine = engineWithBase()
  const cross = engine.execute(ownerB, command('updateStudent', 0, { studentId: 'student_a', name: '越权' }))
  const forged = engine.execute(ownerA, command('saveSettings', 0, { ownerCoachId: 'coach_b', renewThreshold: 1 }))
  const forgedDocument = engine.execute(ownerA, command('saveSettings', 0, { nested: { documentId: 'anything' } }))
  assert.equal(cross.code, 'STUDENT_NOT_FOUND'); assert.equal(forged.code, 'FORBIDDEN_IDENTITY_INPUT'); assert.equal(forgedDocument.code, 'FORBIDDEN_IDENTITY_INPUT'); assert.equal(engine.read('coach_b').students.length, 0)
})

test('requestId 同 payload 返回首次结果，不同 payload 明确冲突', () => {
  const engine = engineWithBase(), id = 'stable_request_001'
  const first = engine.execute(ownerA, command('saveSettings', 0, { renewThreshold: 7 }, id))
  const retry = engine.execute(ownerA, command('saveSettings', 0, { renewThreshold: 7 }, id))
  const conflict = engine.execute(ownerA, command('saveSettings', 0, { renewThreshold: 6 }, id))
  assert.equal(first.ok, true); assert.equal(retry.idempotent, true); assert.equal(conflict.code, 'REQUEST_ID_CONFLICT'); assert.equal(engine.read('coach_a').dataRevision, 1)
})

test('processing receipt 返回 retry-safe，不执行业务', () => {
  const engine = engineWithBase(), payload = { renewThreshold: 7 }, id = 'processing_req_001'
  const { hashCommand } = require('../utils/cloud-command-engine')
  engine.seedReceipt('coach_a', id, { command: 'saveSettings', payloadHash: hashCommand('saveSettings', payload), status: 'processing' })
  const result = engine.execute(ownerA, command('saveSettings', 0, payload, id))
  assert.equal(result.code, 'REQUEST_PROCESSING'); assert.equal(result.retrySafe, true); assert.equal(engine.read('coach_a').dataRevision, 0)
})

test('deleteCompletedBooking 对 active 返还，对 reversed 不恢复余额', () => {
  const engine = engineWithBase(), state = engine.read('coach_a')
  state.bookings[0].status = 'done'; state.students[0].packages[0].used = 1; state.students[0].packages[0].remaining = 9; state.incomes.push({ id: 'income_1', bookingId: 'booking_paid' }); engine.seed('coach_a', state)
  assert.equal(engine.execute(ownerA, command('deleteCompletedBooking', 0, { bookingId: 'booking_paid' })).ok, true)
  let after = engine.read('coach_a'); assert.equal(after.students[0].packages[0].used, 0); assert.equal(after.students[0].packages[0].remaining, 10); assert.equal(after.incomes.length, 0)
  const reversed = base(); reversed.bookings[0].status = 'done'; reversed.students[0].packages[0].status = 'reversed'; reversed.students[0].packages[0].used = 1; reversed.students[0].packages[0].remaining = 0; reversed.incomes.push({ id: 'income_1', bookingId: 'booking_paid' }); engine.seed('coach_a', reversed)
  assert.equal(engine.execute(ownerA, command('deleteCompletedBooking', 0, { bookingId: 'booking_paid' })).ok, true); after = engine.read('coach_a'); assert.equal(after.students[0].packages[0].remaining, 0)
})

test('deleteStudent 保留 done 历史和 income 快照，删除未完成预约与课程销售', () => {
  const engine = engineWithBase(), state = engine.read('coach_a'); state.bookings[0].status = 'done'; delete state.bookings[0].studentName; state.incomes.push({ id: 'income_1', bookingId: 'booking_paid', studentId: 'student_a' }); engine.seed('coach_a', state)
  const result = engine.execute(ownerA, command('deleteStudent', 0, { studentId: 'student_a' })), after = engine.read('coach_a')
  assert.equal(result.ok, true); assert.equal(after.students.length, 0); assert.ok(after.sales.filter(s => s.source === 'course').every(s => s.status === 'reversed')); assert.equal(after.studentTombstones.length, 1); assert.equal(after.studentTombstones[0].packages[0].remaining, 0); assert.equal(after.bookings.length, 1); assert.equal(after.bookings[0].studentName, '张三'); assert.equal(after.incomes[0].studentName, '张三')
})

test('createCourseSale 同课程仍生成独立 packageId 与 saleId', () => {
  const engine = engineWithBase(), result = engine.execute(ownerA, command('createCourseSale', 0, { studentId: 'student_a', type: '常规训练', total: 10, remaining: 10, quantity: 8, unitPrice: 300, amount: 2700, date: '2026-10-01' })), after = engine.read('coach_a')
  assert.equal(result.ok, true); assert.equal(after.students[0].packages.length, 4); assert.equal(after.sales.length, 3); assert.notEqual(result.result.packageId, 'package_paid'); assert.equal(after.sales[2].packageId, result.result.packageId); assert.equal(after.sales[2].quantity, 8); assert.equal(after.students[0].packages[3].total, 10)
})

test('createPackage 只允许赠课，付费 package 不能脱离 sale 单独创建', () => {
  const engine = engineWithBase(), before = engine.read('coach_a')
  // ⚠️ 载荷只能是真实云函数允许的那几个字段（handlers.js:126 的 requireOnly）。
  // 之前这里多带了一个 unitPrice：真实云端会先以 INVALID_PAYLOAD 拒绝，
  // 于是"付费包必须走 createCourseSale"这条业务规则根本轮不到被执行 —— 测的就成了一条假规则。
  const rejected = engine.execute(ownerA, command('createPackage', 0, { studentId: 'student_a', type: '常规训练', total: 10, remaining: 10 }))
  assert.equal(rejected.code, 'PAID_PACKAGE_REQUIRES_SALE')
  assert.deepEqual(engine.read('coach_a'), before)
})

test('自定义动作库修改删除不改历史 booking 动作快照', () => {
  const engine = engineWithBase(), state = engine.read('coach_a'); state.bookings[0].status = 'done'; state.bookings[0].items = [{ name: '旧动作名', sets: 4, reps: 12 }]; engine.seed('coach_a', state)
  assert.equal(engine.execute(ownerA, command('updateCustomExercise', 0, { customExerciseId: 'exercise_legacy_mapped', name: '新动作名' })).ok, true)
  assert.equal(engine.execute(ownerA, command('deleteCustomExercise', 1, { customExerciseId: 'exercise_legacy_mapped' })).ok, true)
  const after = engine.read('coach_a'); assert.equal(after.customExercises.length, 0); assert.equal(after.bookings[0].items[0].name, '旧动作名')
})

test('真实 wx Storage 和 CloudBase 全程未被访问', () => {
  assert.equal(typeof global.wx, 'undefined')
})

process.on('exit', () => { if (!process.exitCode) process.stdout.write('ALL CLOUD COMMAND ENGINE TESTS PASSED\n') })
