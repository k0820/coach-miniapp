const assert = require('assert')
const { META, coachIdFor, fixedId, createService } = require('../cloudfunctions/coachBusinessCommand/core')
const { handlers } = require('../cloudfunctions/coachBusinessCommand/handlers')
const { COMMANDS } = require('../utils/cloud-command-contract')

const copy = value => JSON.parse(JSON.stringify(value))
const names = [...Object.values(META), 'students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
const stores = Object.fromEntries(names.map(name => [name, new Map()]))
let failCollection = '', queue = Promise.resolve(), openId = 'openid-a', clock = 1900000000000

function scope(target) {
  return {
    collection(name) {
      if (!target[name]) target[name] = new Map()
      return {
        doc(id) {
          return {
            async set({ data }) {
              if (failCollection === name) throw new Error(`injected ${name} failure`)
              target[name].set(id, { ...copy(data), _id: id }); return { _id: id }
            },
            async remove() {
              if (failCollection === name) throw new Error(`injected ${name} failure`)
              const removed = target[name].delete(id) ? 1 : 0; return { stats: { removed } }
            }
          }
        },
        where(query) {
          let limit = Infinity, offset = 0
          const api = {
            limit(value) { limit = value; return api },
            skip(value) { offset = value; return api },
            async get() { return { data: [...target[name].values()].filter(row => Object.keys(query).every(key => row[key] === query[key])).slice(offset, offset + limit).map(copy) } }
          }
          return api
        }
      }
    }
  }
}

const db = {
  ...scope(stores),
  runTransaction(work) {
    const run = queue.then(async () => {
      const draft = Object.fromEntries(Object.entries(stores).map(([name, rows]) => [name, new Map([...rows].map(([id, row]) => [id, copy(row)]))]))
      const result = await work(scope(draft))
      for (const name of Object.keys(stores)) { stores[name].clear(); for (const [id, row] of draft[name]) stores[name].set(id, copy(row)) }
      return result
    })
    queue = run.catch(() => {})
    return run
  }
}

const put = (name, id, data) => stores[name].set(id, { ...copy(data), _id: id })
const clear = () => { Object.values(stores).forEach(store => store.clear()); failCollection = ''; queue = Promise.resolve(); openId = 'openid-a' }
const businessId = (name, owner, datasetId, id) => fixedId(`coach-business-${name}`, owner, `${datasetId}:${id}`)

function seed(open = openId, datasetId = 'dataset-active', revision = 0) {
  const owner = coachIdFor(open)
  put(META.coaches, owner, { openId: open, status: 'active' })
  put(META.datasets, fixedId('coach-dataset', owner, datasetId), { ownerCoachId: owner, datasetId, status: 'active', integrityStatus: 'verified', checksum: 'ok', byteSize: 1, summary: {}, schemaVersion: 1 })
  put(META.heads, fixedId('coach-data-head', owner), { ownerCoachId: owner, activeDatasetId: datasetId, headVersion: 1 })
  put(META.revisions, fixedId('coach-data-revision', owner, datasetId), { ownerCoachId: owner, datasetId, dataRevision: revision })
  return { owner, datasetId }
}

const main = () => createService({ db, getOpenId: () => openId, handlers, now: () => ++clock })
const execute = (command, requestId, expectedRevision, payload) => ({ action: 'execute', envelope: { command, requestId, expectedRevision, payload } })
const rows = name => [...stores[name].values()]

async function test(name, fn) {
  try { clear(); await fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}

;(async () => {
  await test('正式写入口收口后的二十二个命令均已实现', async () => {
    assert.equal(COMMANDS.length, 31); assert.equal(new Set(COMMANDS).size, 31)
    assert.deepEqual(Object.keys(handlers).sort(), COMMANDS.slice().sort())
    assert.deepEqual(Object.keys(handlers).sort(), ['createStudent', 'updateStudent', 'deleteStudent', 'createPackage', 'createCourseSale', 'updateCourseSale', 'reverseCourseSale', 'updatePackage', 'deletePackage', 'createBooking', 'setPackageShare', 'createSharedBooking', 'createAuthorizedBooking', 'updateBookingContent', 'rescheduleBooking', 'cancelBooking', 'completeBooking', 'deleteCompletedBooking', 'markBookingNotHeld', 'createCustomExercise', 'createManualSale', 'updateManualSale', 'deleteCustomExercise', 'deleteManualSale', 'saveSettings', 'updateCustomExercise', 'grantMemberService', 'revokeMemberService', 'grantPackageTeaching', 'revokePackageTeaching', 'transferPackageManagement'].sort())
  })

  await test('createStudent 由服务端生成 ID，重试不重复创建', async () => {
    seed(); const service = main(), call = execute('createStudent', 'student_retry_001', 0, { name: ' 张三 ', phone: '13800138000' })
    const first = await service(call), retry = await service(call)
    assert.equal(first.ok, true); assert.equal(retry.idempotent, true); assert.equal(rows('students').length, 1)
    assert.equal(rows('students')[0].data.name, '张三'); assert.equal(rows('students')[0].data.phone, '13800138000'); assert.equal(rows('students')[0].data.packages, undefined)
  })

  await test('updateStudent 只改当前 student，不重写历史姓名快照', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, sortIndex: 0, data: { id: studentId, name: '旧姓名', phone: '1', abbr: 'JXM' } })
    put('bookings', businessId('bookings', owner, datasetId, 'booking-1'), { ownerCoachId: owner, datasetId, bookingId: 'booking-1', data: { id: 'booking-1', studentId, studentName: '历史姓名', status: 'done' } })
    put('incomes', businessId('incomes', owner, datasetId, 'income-1'), { ownerCoachId: owner, datasetId, incomeId: 'income-1', data: { id: 'income-1', studentId, studentName: '历史姓名' } })
    const result = await main()(execute('updateStudent', 'student_update_001', 0, { studentId, name: '新姓名', phone: '2' }))
    assert.equal(result.ok, true); assert.equal(rows('students')[0].data.name, '新姓名'); assert.equal(rows('bookings')[0].data.studentName, '历史姓名'); assert.equal(rows('incomes')[0].data.studentName, '历史姓名')
  })

  await test('付费 package 不能绕过 sale 单独创建', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, data: { id: studentId, name: '张三' } })
    const result = await main()(execute('createPackage', 'paid_package_reject_001', 0, { studentId, type: '常规训练', total: 10, remaining: 10 }))
    assert.equal(result.code, 'PAID_PACKAGE_REQUIRES_SALE'); assert.equal(rows('packages').length, 0); assert.equal(rows('sales').length, 0)
  })

  await test('赠送 package 独立创建且不生成 sale', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, sortIndex: 0, data: { id: studentId, name: '张三' } })
    const call = execute('createPackage', 'gift_package_retry_001', 0, { studentId, type: '赠送课程', total: 5, remaining: 3, isGift: true }), service = main()
    assert.equal((await service(call)).ok, true); assert.equal((await service(call)).idempotent, true); assert.equal(rows('packages').length, 1); assert.equal(rows('sales').length, 0)
    assert.deepEqual(rows('packages')[0].data, { id: rows('packages')[0].packageId, type: '赠送课程', total: 5, used: 0, remaining: 3, price: 80, status: 'active', isGift: true, createdAt: rows('packages')[0].data.createdAt })
  })

  await test('同类型两次购买创建两组独立 package/sale 并精确互绑', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, sortIndex: 0, data: { id: studentId, name: '张三' } })
    const service = main(), first = await service(execute('createCourseSale', 'course_purchase_001', 0, { studentId, type: '常规训练', total: 10, remaining: 7, quantity: 9, unitPrice: 400, amount: 3800, date: '2026-06-01' })), second = await service(execute('createCourseSale', 'course_purchase_002', 1, { studentId, type: '常规训练', total: 20, remaining: 25, quantity: 18, unitPrice: 450, amount: 8500, date: '2026-09-01' }))
    assert.equal(first.ok, true); assert.equal(second.ok, true); assert.equal(rows('packages').length, 2); assert.equal(rows('sales').length, 2)
    for (const packageRow of rows('packages')) {
      const saleRow = rows('sales').find(row => row.saleId === packageRow.data.saleId)
      assert(saleRow); assert.equal(saleRow.data.packageId, packageRow.packageId); assert.equal(saleRow.packageId, packageRow.packageId)
    }
    const one = rows('packages').find(row => row.data.total === 10), two = rows('packages').find(row => row.data.total === 20)
    assert.equal(one.data.remaining, 7); assert.equal(rows('sales').find(row => row.packageId === one.packageId).data.quantity, 9); assert.equal(rows('sales').find(row => row.packageId === one.packageId).data.amount, 3800)
    assert.equal(two.data.remaining, 25); assert.equal(rows('sales').find(row => row.packageId === two.packageId).data.amount, 8500)
  })

  await test('createCourseSale 相同 requestId 重试不产生孤立 package 或重复 sale', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, data: { id: studentId, name: '张三' } })
    const service = main(), call = execute('createCourseSale', 'course_retry_001', 0, { studentId, type: '普拉提', total: 8, remaining: 6, quantity: 7, unitPrice: 300, amount: 1999, date: '2026-09-02' })
    assert.equal((await service(call)).ok, true); assert.equal((await service(call)).idempotent, true); assert.equal(rows('packages').length, 1); assert.equal(rows('sales').length, 1)
  })

  await test('createCourseSale 不从 total 静默推导独立 quantity', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, data: { id: studentId, name: '张三' } })
    const result = await main()(execute('createCourseSale', 'course_missing_quantity', 0, { studentId, type: '常规训练', total: 10, remaining: 10, unitPrice: 400, amount: 3800, date: '2026-09-01' }))
    assert.equal(result.code, 'INVALID_PAYLOAD'); assert.equal(rows('packages').length, 0); assert.equal(rows('sales').length, 0); assert.equal(rows(META.receipts).length, 0)
  })

  await test('sale 写入失败时 package/revision/receipt 全部回滚', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, data: { id: studentId, name: '张三' } }); failCollection = 'sales'
    const result = await main()(execute('createCourseSale', 'course_rollback_001', 0, { studentId, type: '常规训练', total: 10, remaining: 10, quantity: 10, unitPrice: 400, amount: 3800, date: '2026-09-01' }))
    assert.equal(result.code, 'COMMAND_TRANSACTION_FAILED'); assert.equal(rows('packages').length, 0); assert.equal(rows('sales').length, 0); assert.equal(rows(META.receipts).length, 0); assert.equal(rows(META.revisions).find(row => row.datasetId === datasetId).dataRevision, 0)
  })

  await test('revision 冲突不会产生半条课程购买', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, data: { id: studentId, name: '张三' } })
    const service = main(), payload = { studentId, type: '常规训练', total: 10, remaining: 10, quantity: 10, unitPrice: 400, amount: 3800, date: '2026-09-01' }
    const results = await Promise.all([service(execute('createCourseSale', 'course_parallel_001', 0, payload)), service(execute('createCourseSale', 'course_parallel_002', 0, payload))])
    assert.equal(results.filter(result => result.ok).length, 1); assert.equal(results.find(result => !result.ok).code, 'REVISION_CONFLICT'); assert.equal(rows('packages').length, 1); assert.equal(rows('sales').length, 1)
  })

  await test('deleteStudent 软撤销资格并保留 done/income/训练快照与手工业绩', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1', packageId = 'package-1', saleId = 'sale-1'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, data: { id: studentId, name: '张三' } })
    put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId, saleId, data: { id: packageId, used: 4, remaining: 6, status: 'active', saleId } })
    put('sales', businessId('sales', owner, datasetId, saleId), { ownerCoachId: owner, datasetId, saleId, studentId, packageId, data: { id: saleId, source: 'course', status: 'active', studentId, packageId } })
    put('sales', businessId('sales', owner, datasetId, 'manual-1'), { ownerCoachId: owner, datasetId, saleId: 'manual-1', studentId, packageId: '', data: { id: 'manual-1', source: 'manual', amount: 100 } })
    put('bookings', businessId('bookings', owner, datasetId, 'booked-1'), { ownerCoachId: owner, datasetId, bookingId: 'booked-1', studentId, packageId, data: { id: 'booked-1', status: 'booked' } })
    put('bookings', businessId('bookings', owner, datasetId, 'done-1'), { ownerCoachId: owner, datasetId, bookingId: 'done-1', studentId, packageId, data: { id: 'done-1', status: 'done', items: [{ name: '卧推' }], notes: '备注', summary: '总结' } })
    put('incomes', businessId('incomes', owner, datasetId, 'income-1'), { ownerCoachId: owner, datasetId, incomeId: 'income-1', studentId, bookingId: 'done-1', data: { id: 'income-1', amount: 400 } })
    const result = await main()(execute('deleteStudent', 'delete_student_001', 0, { studentId }))
    assert.equal(result.ok, true); assert.equal(rows('students').length, 0); assert.equal(rows('packages')[0].data.status, 'reversed'); assert.equal(rows('packages')[0].data.remaining, 0); assert.equal(rows('packages')[0].data.used, 4)
    assert.equal(rows('student_tombstones').length, 1)
    assert.equal(rows('student_tombstones')[0].data.id, studentId)
    assert.equal(rows('student_tombstones')[0].data.status, 'deleted')
    assert.equal(rows('sales').find(row => row.saleId === saleId).data.status, 'reversed'); assert.equal(rows('sales').find(row => row.saleId === 'manual-1').data.source, 'manual'); assert.equal(rows('bookings').length, 1); assert.equal(rows('bookings')[0].data.studentName, '张三'); assert.deepEqual(rows('bookings')[0].data.items, [{ name: '卧推' }]); assert.equal(rows('bookings')[0].data.notes, '备注'); assert.equal(rows('bookings')[0].data.summary, '总结'); assert.equal(rows('incomes')[0].data.studentName, '张三')
  })

  await test('deleteStudent 中途失败时全部回滚', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1', packageId = 'package-1'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, data: { id: studentId, name: '张三' } }); put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId, data: { id: packageId, used: 2, remaining: 3, status: 'active' } }); failCollection = 'packages'
    const result = await main()(execute('deleteStudent', 'delete_student_fail_001', 0, { studentId }))
    assert.equal(result.code, 'COMMAND_TRANSACTION_FAILED'); assert.equal(rows('students').length, 1); assert.equal(rows('packages')[0].data.status, 'active'); assert.equal(rows(META.receipts).length, 0)
  })

  await test('deleteStudent 墓碑写入失败时学员/课包/回执/revision 全部回滚', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-marker-failure', packageId = 'package-marker-failure'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, data: { id: studentId, name: '隔离墓碑测试' } })
    put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId, data: { id: packageId, used: 2, remaining: 3, status: 'active' } })
    const before = copy(Object.fromEntries(names.map(name => [name, rows(name)])))
    failCollection = 'student_tombstones'
    const result = await main()(execute('deleteStudent', 'delete_marker_fail_001', 0, { studentId }))
    assert.equal(result.code, 'COMMAND_TRANSACTION_FAILED')
    assert.deepEqual(Object.fromEntries(names.map(name => [name, rows(name)])), before)
  })

  await test('updateCourseSale 独立字段、未来快照同步及 total<used 明确确认', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1', packageId = 'package-1', saleId = 'sale-1'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, data: { id: studentId, name: '张三' } }); put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId, saleId, data: { id: packageId, type: '常规训练', total: 10, used: 5, remaining: 8, price: 400, status: 'active', saleDate: '2026-08-01', saleId } }); put('sales', businessId('sales', owner, datasetId, saleId), { ownerCoachId: owner, datasetId, saleId, studentId, packageId, data: { id: saleId, source: 'course', status: 'active', studentId, packageId, quantity: 10, unitPrice: 400, amount: 3800, date: '2026-08-01' } })
    put('bookings', businessId('bookings', owner, datasetId, 'future-1'), { ownerCoachId: owner, datasetId, bookingId: 'future-1', studentId, packageId, data: { id: 'future-1', status: 'booked', typeName: '常规训练', price: 400 } }); put('bookings', businessId('bookings', owner, datasetId, 'done-1'), { ownerCoachId: owner, datasetId, bookingId: 'done-1', studentId, packageId, data: { id: 'done-1', status: 'done', typeName: '常规训练', price: 400, items: [{ name: '历史动作' }] } }); put('incomes', businessId('incomes', owner, datasetId, 'income-1'), { ownerCoachId: owner, datasetId, incomeId: 'income-1', bookingId: 'done-1', data: { id: 'income-1', bookingId: 'done-1', amount: 400 } })
    const service = main(), base = { saleId, packageId, type: '普拉提', total: 3, remaining: 9, quantity: 7, unitPrice: 450, amount: 2345, date: '2026-09-01' }
    assert.equal((await service(execute('updateCourseSale', 'update_confirm_001', 0, base))).code, 'TOTAL_BELOW_USED_CONFIRM_REQUIRED'); assert.equal(rows(META.receipts).length, 0)
    assert.equal((await service(execute('updateCourseSale', 'update_confirm_002', 0, { ...base, confirmTotalBelowUsed: true }))).ok, true)
    const pkg = rows('packages')[0].data, sale = rows('sales')[0].data, future = rows('bookings').find(row => row.bookingId === 'future-1').data, done = rows('bookings').find(row => row.bookingId === 'done-1').data
    assert.equal(pkg.total, 3); assert.equal(pkg.used, 5); assert.equal(pkg.remaining, 9); assert.equal(sale.quantity, 7); assert.equal(sale.unitPrice, 450); assert.equal(sale.amount, 2345); assert.equal(sale.date, '2026-09-01'); assert.equal(future.typeName, '普拉提'); assert.equal(future.price, 450); assert.equal(done.typeName, '常规训练'); assert.equal(done.price, 400); assert.deepEqual(done.items, [{ name: '历史动作' }]); assert.equal(rows('incomes')[0].data.amount, 400)
  })

  await test('updateCourseSale 对一包多 sale 明确拒绝', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1', packageId = 'package-1', saleId = 'sale-1'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, data: { id: studentId, name: '张三' } }); put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId, saleId, data: { id: packageId, type: '常规训练', total: 10, used: 0, remaining: 10, price: 400, status: 'active', saleId } })
    for (const id of [saleId, 'sale-2']) put('sales', businessId('sales', owner, datasetId, id), { ownerCoachId: owner, datasetId, saleId: id, studentId, packageId, data: { id, source: 'course', status: 'active', studentId, packageId, quantity: 10, unitPrice: 400, amount: 4000, date: '2026-09-01' } })
    const result = await main()(execute('updateCourseSale', 'ambiguous_update_001', 0, { saleId, packageId, amount: 3000 })); assert.equal(result.code, 'SALE_RELATION_AMBIGUOUS'); assert.equal(rows('sales')[0].data.amount, 4000); assert.equal(rows(META.receipts).length, 0)
  })

  await test('reverseCourseSale 只撤销 exact package 并保留 done/income', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1', packageId = 'package-1', saleId = 'sale-1'
    put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId, saleId, data: { id: packageId, used: 4, remaining: 6, status: 'active', saleId } }); put('packages', businessId('packages', owner, datasetId, 'package-2'), { ownerCoachId: owner, datasetId, packageId: 'package-2', studentId, data: { id: 'package-2', type: '常规训练', remaining: 10, status: 'active' } }); put('sales', businessId('sales', owner, datasetId, saleId), { ownerCoachId: owner, datasetId, saleId, studentId, packageId, data: { id: saleId, source: 'course', status: 'active', studentId, packageId } })
    put('bookings', businessId('bookings', owner, datasetId, 'booked-1'), { ownerCoachId: owner, datasetId, bookingId: 'booked-1', studentId, packageId, data: { id: 'booked-1', status: 'booked' } }); put('bookings', businessId('bookings', owner, datasetId, 'done-1'), { ownerCoachId: owner, datasetId, bookingId: 'done-1', studentId, packageId, data: { id: 'done-1', status: 'done', items: [{ name: '历史动作' }] } }); put('incomes', businessId('incomes', owner, datasetId, 'income-1'), { ownerCoachId: owner, datasetId, incomeId: 'income-1', bookingId: 'done-1', data: { id: 'income-1', amount: 400 } })
    const service = main(), call = execute('reverseCourseSale', 'reverse_course_001', 0, { saleId, packageId }); assert.equal((await service(call)).ok, true); assert.equal((await service(call)).idempotent, true)
    assert.equal(rows('packages').find(row => row.packageId === packageId).data.remaining, 0); assert.equal(rows('packages').find(row => row.packageId === packageId).data.used, 4); assert.equal(rows('packages').find(row => row.packageId === 'package-2').data.remaining, 10); assert.equal(rows('sales')[0].data.status, 'reversed'); assert.equal(rows('bookings').length, 1); assert.equal(rows('bookings')[0].data.status, 'done'); assert.equal(rows('incomes').length, 1)
  })

  await test('reverseCourseSale 孤立 sale 只撤销自身，中途失败整体回滚', async () => {
    let context = seed(), saleId = 'orphan-sale'; put('sales', businessId('sales', context.owner, context.datasetId, saleId), { ownerCoachId: context.owner, datasetId: context.datasetId, saleId, studentId: 'deleted', packageId: '', data: { id: saleId, source: 'course', status: 'active', studentId: 'deleted' } }); put('packages', businessId('packages', context.owner, context.datasetId, 'other'), { ownerCoachId: context.owner, datasetId: context.datasetId, packageId: 'other', studentId: 'other', data: { id: 'other', remaining: 10, status: 'active' } })
    let result = await main()(execute('reverseCourseSale', 'reverse_orphan_001', 0, { saleId })); assert.equal(result.ok, true); assert.equal(result.result.orphan, true); assert.equal(rows('sales')[0].data.status, 'reversed'); assert.equal(rows('packages')[0].data.remaining, 10)
    clear(); context = seed(); saleId = 'sale-1'; const packageId = 'package-1'; put('packages', businessId('packages', context.owner, context.datasetId, packageId), { ownerCoachId: context.owner, datasetId: context.datasetId, packageId, studentId: 'student-1', saleId, data: { id: packageId, used: 2, remaining: 8, status: 'active', saleId } }); put('sales', businessId('sales', context.owner, context.datasetId, saleId), { ownerCoachId: context.owner, datasetId: context.datasetId, saleId, studentId: 'student-1', packageId, data: { id: saleId, source: 'course', status: 'active', studentId: 'student-1', packageId } }); failCollection = 'packages'
    result = await main()(execute('reverseCourseSale', 'reverse_fail_001', 0, { saleId, packageId })); assert.equal(result.code, 'COMMAND_TRANSACTION_FAILED'); assert.equal(rows('sales')[0].data.status, 'active'); assert.equal(rows('packages')[0].data.remaining, 8); assert.equal(rows(META.receipts).length, 0)
  })

  await test('owner、旧 dataset 与无 datasetId student 均不能被更新或挂包', async () => {
    const a = seed('openid-a', 'dataset-a'), b = seed('openid-b', 'dataset-b'), studentId = 'student-b'
    put('students', businessId('students', b.owner, b.datasetId, studentId), { ownerCoachId: b.owner, datasetId: b.datasetId, studentId, data: { id: studentId, name: 'B' } })
    put('students', businessId('students', a.owner, 'dataset-old', 'student-old'), { ownerCoachId: a.owner, datasetId: 'dataset-old', studentId: 'student-old', data: { id: 'student-old', name: '旧代次' } })
    put('students', fixedId('students', a.owner, 'phase63'), { ownerCoachId: a.owner, studentId: 'phase63', data: { id: 'phase63', name: '老记录' } })
    openId = 'openid-a'; const service = main()
    for (const id of [studentId, 'student-old', 'phase63']) {
      assert.equal((await service(execute('updateStudent', `isolated_update_${id}`, 0, { studentId: id, name: '越权' }))).code, 'STUDENT_NOT_FOUND')
      assert.equal((await service(execute('createPackage', `isolated_package_${id}`, 0, { studentId: id, type: '赠送课程', total: 1, remaining: 1 }))).code, 'STUDENT_NOT_FOUND')
    }
    assert.equal(rows('packages').length, 0); assert.equal(rows('sales').length, 0); assert.equal(rows('students').find(row => row.studentId === studentId).data.name, 'B')
  })

  await test('A owner 无法读取或修改 B owner 的数据', async () => {
    const a = seed('openid-a', 'dataset-a'), b = seed('openid-b', 'dataset-b')
    put('sales', businessId('sales', b.owner, b.datasetId, 'sale-b'), { ownerCoachId: b.owner, datasetId: b.datasetId, saleId: 'sale-b', data: { id: 'sale-b', source: 'manual', amount: 100, date: '2026-09-01' } })
    openId = 'openid-a'
    const result = await main()(execute('deleteManualSale', 'owner_isolation_001', 0, { saleId: 'sale-b' }))
    assert.equal(result.code, 'SALE_NOT_FOUND'); assert.equal(rows('sales').length, 1); assert.equal(rows(META.revisions).find(x => x.ownerCoachId === a.owner).dataRevision, 0)
  })

  await test('active dataset 不读取同 owner 的旧 dataset 或无 datasetId 记录', async () => {
    const { owner, datasetId } = seed()
    put('sales', businessId('sales', owner, 'dataset-old', 'old-sale'), { ownerCoachId: owner, datasetId: 'dataset-old', saleId: 'old-sale', data: { id: 'old-sale', source: 'manual' } })
    put('sales', fixedId('sales', owner, 'phase63-sale'), { ownerCoachId: owner, saleId: 'phase63-sale', data: { id: 'phase63-sale', source: 'manual' } })
    let result = await main()(execute('deleteManualSale', 'old_dataset_sale_001', 0, { saleId: 'old-sale' }))
    assert.equal(result.code, 'SALE_NOT_FOUND')
    result = await main()(execute('deleteManualSale', 'phase63_sale_001', 0, { saleId: 'phase63-sale' }))
    assert.equal(result.code, 'SALE_NOT_FOUND'); assert.equal(rows('sales').length, 2); assert.equal(rows(META.revisions).find(x => x.datasetId === datasetId).dataRevision, 0)
  })

  await test('相同 requestId 不重复新增 manual sale', async () => {
    seed(); const call = execute('createManualSale', 'manual_retry_001', 0, { name: '月卡', amount: 234.34, date: '2026-08-31', validFrom: '2026-08-31', validTo: '', note: '测试' }), service = main()
    const first = await service(call), retry = await service(call)
    assert.equal(first.ok, true); assert.equal(retry.idempotent, true); assert.equal(rows('sales').length, 1); assert.equal(rows('sales')[0].data.source, 'manual'); assert.equal(rows(META.receipts).length, 1)
  })

  await test('相同 requestId 不重复新增 custom exercise，异 payload 冲突', async () => {
    seed(); const service = main(), call = execute('createCustomExercise', 'exercise_retry_001', 0, { name: '哈克推肩', group: '肩' })
    assert.equal((await service(call)).ok, true); assert.equal((await service(call)).idempotent, true)
    assert.equal((await service(execute('createCustomExercise', 'exercise_retry_001', 0, { name: '另一个动作', group: '肩' }))).code, 'REQUEST_ID_CONFLICT')
    assert.equal(rows('customExercises').length, 1)
  })

  await test('revision 冲突不会覆盖设置', async () => {
    const { owner, datasetId } = seed(); put('settings', businessId('settings', owner, datasetId, 'settings'), { ownerCoachId: owner, datasetId, settingsId: 'settings', data: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 20, salesCommissionRate: 5 } })
    const service = main(), responses = await Promise.all([
      service(execute('saveSettings', 'settings_parallel_a', 0, { renewThreshold: 8 })),
      service(execute('saveSettings', 'settings_parallel_b', 0, { renewThreshold: 6 }))
    ])
    assert.equal(responses.filter(x => x.ok).length, 1); assert.equal(responses.find(x => !x.ok).code, 'REVISION_CONFLICT'); assert([8, 6].includes(rows('settings')[0].data.renewThreshold))
  })

  await test('handler 写入失败时业务、revision、receipt 全部回滚', async () => {
    const { datasetId } = seed(); failCollection = 'sales'
    const result = await main()(execute('createManualSale', 'manual_rollback_001', 0, { amount: 100, date: '2026-09-01' }))
    assert.equal(result.code, 'COMMAND_TRANSACTION_FAILED'); assert.equal(rows('sales').length, 0); assert.equal(rows(META.receipts).length, 0); assert.equal(rows(META.revisions).find(x => x.datasetId === datasetId).dataRevision, 0)
  })

  await test('deleteManualSale 拒绝 course sale', async () => {
    const { owner, datasetId } = seed(); put('sales', businessId('sales', owner, datasetId, 'course-sale'), { ownerCoachId: owner, datasetId, saleId: 'course-sale', data: { id: 'course-sale', source: 'course' } })
    const result = await main()(execute('deleteManualSale', 'reject_course_sale_001', 0, { saleId: 'course-sale' }))
    assert.equal(result.code, 'NOT_MANUAL_SALE'); assert.equal(rows('sales').length, 1); assert.equal(rows(META.receipts).length, 0)
  })

  await test('custom exercise 更新删除不触碰历史 booking 快照', async () => {
    const { owner, datasetId } = seed(); const exerciseId = 'exercise-1'
    put('customExercises', businessId('customExercises', owner, datasetId, exerciseId), { ownerCoachId: owner, datasetId, customExerciseId: exerciseId, sortIndex: 0, data: { id: exerciseId, name: '旧动作名', group: '胸' } })
    put('bookings', businessId('bookings', owner, datasetId, 'booking-1'), { ownerCoachId: owner, datasetId, bookingId: 'booking-1', data: { id: 'booking-1', status: 'done', items: [{ name: '旧动作名', sets: 4, reps: 12 }], notes: '历史备注', summary: '历史总结' } })
    const service = main(); assert.equal((await service(execute('updateCustomExercise', 'exercise_update_001', 0, { customExerciseId: exerciseId, name: '新动作名' }))).ok, true)
    assert.equal((await service(execute('deleteCustomExercise', 'exercise_delete_001', 1, { customExerciseId: exerciseId }))).ok, true)
    assert.deepEqual(rows('bookings')[0].data, { id: 'booking-1', status: 'done', items: [{ name: '旧动作名', sets: 4, reps: 12 }], notes: '历史备注', summary: '历史总结' })
  })

  await test('saveSettings 只允许既有四项且保留未提交值', async () => {
    const { owner, datasetId } = seed(); put('settings', businessId('settings', owner, datasetId, 'settings'), { ownerCoachId: owner, datasetId, settingsId: 'settings', data: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 20, salesCommissionRate: 5 } })
    const service = main(); assert.equal((await service(execute('saveSettings', 'settings_allowed_001', 0, { renewThreshold: 7, salesCommissionRate: 6 }))).ok, true)
    assert.deepEqual(rows('settings')[0].data, { renewThreshold: 7, monthlyGoalSessions: 40, classCommissionRate: 20, salesCommissionRate: 6 })
    assert.equal((await service(execute('saveSettings', 'settings_forbidden_001', 1, { unknownSetting: 1 }))).code, 'INVALID_PAYLOAD')
  })

  await test('客户端伪造身份与 dataset 字段仍被拒绝', async () => {
    seed(); const service = main()
    for (const payload of [{ ownerCoachId: 'b' }, { datasetId: 'old' }, { coachId: 'b' }, { OPENID: 'b' }, { documentId: 'x' }]) {
      const result = await service(execute('saveSettings', `forged_lowrisk_${Object.keys(payload)[0]}`, 0, payload)); assert.equal(result.code, 'FORBIDDEN_IDENTITY_INPUT')
    }
    assert.equal(rows(META.receipts).length, 0)
  })

  await test('createBooking 精确绑定所选 package，同类型包不自动替换，gift 可预约', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, data: { id: studentId, name: '张三' } })
    for (const [id, type, remaining, status] of [['package-empty', '常规训练', 0, 'active'], ['package-invalid', '常规训练', '坏数据', 'active'], ['package-paid', '常规训练', 5, 'active'], ['package-gift', '赠送课程', 2, 'active'], ['package-reversed', '常规训练', 9, 'reversed']]) put('packages', businessId('packages', owner, datasetId, id), { ownerCoachId: owner, datasetId, packageId: id, studentId, data: { id, type, remaining, price: 400, status } })
    const service = main()
    assert.equal((await service(execute('createBooking', 'book_empty', 0, { studentId, packageId: 'package-empty', date: '2026-09-15', hour: 9, minute: 0 }))).code, 'PACKAGE_NO_REMAINING')
    assert.equal((await service(execute('createBooking', 'book_invalid', 0, { studentId, packageId: 'package-invalid', date: '2026-09-15', hour: 9, minute: 0 }))).code, 'PACKAGE_NO_REMAINING')
    assert.equal((await service(execute('createBooking', 'book_reversed', 0, { studentId, packageId: 'package-reversed', date: '2026-09-15', hour: 9, minute: 0 }))).code, 'PACKAGE_UNAVAILABLE')
    const call = execute('createBooking', 'book_gift', 0, { studentId, packageId: 'package-gift', date: '2026-09-15', hour: 10, minute: 0 })
    assert.equal((await service(call)).ok, true); assert.equal((await service(call)).idempotent, true); assert.equal(rows('bookings').length, 1)
    assert.equal(rows('bookings')[0].packageId, 'package-gift'); assert.equal(rows('bookings')[0].data.price, 80); assert.equal(rows('bookings')[0].data.typeName, '赠送课程')
  })

  await test('createBooking 校验 student/package 关系、owner/dataset，并在并发与失败时无半成品', async () => {
    const a = seed('openid-a', 'dataset-a'), b = seed('openid-b', 'dataset-b'), studentId = 'student-a'
    put('students', businessId('students', a.owner, a.datasetId, studentId), { ownerCoachId: a.owner, datasetId: a.datasetId, studentId, data: { id: studentId, name: 'A' } })
    put('packages', businessId('packages', a.owner, a.datasetId, 'package-other-student'), { ownerCoachId: a.owner, datasetId: a.datasetId, packageId: 'package-other-student', studentId: 'other', data: { id: 'package-other-student', type: '常规训练', remaining: 5, price: 300, status: 'active' } })
    put('packages', businessId('packages', b.owner, b.datasetId, 'package-b'), { ownerCoachId: b.owner, datasetId: b.datasetId, packageId: 'package-b', studentId, data: { id: 'package-b', type: '常规训练', remaining: 5, price: 300, status: 'active' } })
    put('packages', businessId('packages', a.owner, 'dataset-old', 'package-old'), { ownerCoachId: a.owner, datasetId: 'dataset-old', packageId: 'package-old', studentId, data: { id: 'package-old', type: '常规训练', remaining: 5, status: 'active' } })
    put('packages', fixedId('packages', a.owner, 'phase63-package'), { ownerCoachId: a.owner, packageId: 'phase63-package', studentId, data: { id: 'phase63-package', type: '常规训练', remaining: 5, status: 'active' } })
    openId = 'openid-a'; const service = main(), base = { studentId, date: '2026-09-16', hour: 9, minute: 0 }
    assert.equal((await service(execute('createBooking', 'wrong_student_pkg', 0, { ...base, packageId: 'package-other-student' }))).code, 'PACKAGE_STUDENT_MISMATCH')
    for (const id of ['package-b', 'package-old', 'phase63-package']) assert.equal((await service(execute('createBooking', `isolated_${id}`, 0, { ...base, packageId: id }))).code, 'PACKAGE_NOT_FOUND')
    put('packages', businessId('packages', a.owner, a.datasetId, 'package-a'), { ownerCoachId: a.owner, datasetId: a.datasetId, packageId: 'package-a', studentId, data: { id: 'package-a', type: '常规训练', remaining: 5, price: 300, status: 'active' } })
    const results = await Promise.all([service(execute('createBooking', 'parallel_booking_a', 0, { ...base, packageId: 'package-a' })), service(execute('createBooking', 'parallel_booking_b', 0, { ...base, packageId: 'package-a', hour: 11 }))])
    assert.equal(results.filter(x => x.ok).length, 1); assert.equal(results.find(x => !x.ok).code, 'REVISION_CONFLICT'); assert.equal(rows('bookings').length, 1)
    failCollection = 'bookings'; const failed = await service(execute('createBooking', 'booking_write_fail', 1, { ...base, packageId: 'package-a', hour: 13 })); assert.equal(failed.code, 'COMMAND_TRANSACTION_FAILED'); assert.equal(rows('bookings').length, 1); assert.equal(rows(META.receipts).length, 1)
  })

  await test('reschedule booked 只改日期时间，cancel booked 不动课时收入且拒绝 done', async () => {
    const { owner, datasetId } = seed(), bookingId = 'booked-1', packageId = 'package-1'
    put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId: 'student-1', data: { id: packageId, used: 2, remaining: 8 } })
    put('bookings', businessId('bookings', owner, datasetId, bookingId), { ownerCoachId: owner, datasetId, bookingId, studentId: 'student-1', packageId, data: { id: bookingId, studentId: 'student-1', packageId, date: '2026-09-10', hour: 9, minute: 0, typeName: '常规训练', price: 400, status: 'booked', marker: '保留' } })
    const service = main(); assert.equal((await service(execute('rescheduleBooking', 'reschedule_booked', 0, { bookingId, date: '2026-09-11', hour: 10, minute: 30 }))).ok, true)
    const moved = rows('bookings')[0].data; assert.equal(moved.date, '2026-09-11'); assert.equal(moved.hour, 10); assert.equal(moved.minute, 30); assert.equal(moved.packageId, packageId); assert.equal(moved.typeName, '常规训练'); assert.equal(moved.price, 400); assert.equal(moved.marker, '保留')
    assert.equal((await service(execute('cancelBooking', 'cancel_booked', 1, { bookingId }))).ok, true); assert.equal(rows('bookings').length, 0); // M2：取消不动 remaining / used，但会登记 reserved（释放占座后的真实值 0）与 reservedVersion。
    assert.deepEqual(rows('packages')[0].data, { id: packageId, used: 2, remaining: 8, reserved: 0, reservedVersion: 2 }); assert.equal(rows('incomes').length, 0)
    put('bookings', businessId('bookings', owner, datasetId, 'done-1'), { ownerCoachId: owner, datasetId, bookingId: 'done-1', data: { id: 'done-1', status: 'done' } })
    assert.equal((await service(execute('cancelBooking', 'cancel_done', 2, { bookingId: 'done-1' }))).code, 'BOOKING_ALREADY_DONE'); assert.equal(rows('bookings').length, 1)
  })

  await test('reschedule done 原子同步唯一 income 时间并保留训练历史', async () => {
    const { owner, datasetId } = seed(), bookingId = 'done-1'
    const history = { items: [{ name: '卧推', sets: 4, reps: 12, weight: 40 }, { name: '划船', sets: 3, reps: 10 }], notes: '历史备注', category: '胸', duration: 60 }
    put('bookings', businessId('bookings', owner, datasetId, bookingId), { ownerCoachId: owner, datasetId, bookingId, studentId: 'student-1', packageId: 'package-1', data: { id: bookingId, studentId: 'student-1', studentName: '张三', packageId: 'package-1', date: '2026-09-10', hour: 9, minute: 0, typeName: '常规训练', price: 400, status: 'done', summary: '旧总结', ...copy(history) } })
    put('incomes', businessId('incomes', owner, datasetId, 'income-1'), { ownerCoachId: owner, datasetId, incomeId: 'income-1', studentId: 'student-1', bookingId, data: { id: 'income-1', bookingId, date: '2026-09-10', time: '09:00', amount: 400 } })
    const result = await main()(execute('rescheduleBooking', 'reschedule_done', 0, { bookingId, date: '2026-09-12', hour: 11, minute: 30 })); assert.equal(result.ok, true)
    const booking = rows('bookings')[0].data, income = rows('incomes')[0].data; assert.deepEqual(booking.items, history.items); assert.equal(booking.notes, history.notes); assert.equal(booking.duration, 60); assert(booking.summary.includes('9月12日')); assert(booking.summary.includes('卧推')); assert(booking.summary.includes('历史备注')); assert.equal(income.date, '2026-09-12'); assert.equal(income.time, '11:30'); assert.equal(income.amount, 400)
  })

  await test('reschedule done 的 income 歧义或写入失败会整体回滚', async () => {
    let context = seed(), bookingId = 'done-1'
    const addDone = () => put('bookings', businessId('bookings', context.owner, context.datasetId, bookingId), { ownerCoachId: context.owner, datasetId: context.datasetId, bookingId, data: { id: bookingId, date: '2026-09-10', hour: 9, minute: 0, status: 'done', typeName: '常规训练', items: [], notes: '', summary: '旧总结' } })
    addDone(); for (const id of ['income-1', 'income-2']) put('incomes', businessId('incomes', context.owner, context.datasetId, id), { ownerCoachId: context.owner, datasetId: context.datasetId, incomeId: id, bookingId, data: { id, bookingId, date: '2026-09-10', time: '09:00' } })
    let result = await main()(execute('rescheduleBooking', 'ambiguous_income', 0, { bookingId, date: '2026-09-12', hour: 10, minute: 0 })); assert.equal(result.code, 'INCOME_RELATION_AMBIGUOUS'); assert.equal(rows('bookings')[0].data.date, '2026-09-10'); assert.equal(rows(META.receipts).length, 0)
    clear(); context = seed(); addDone(); put('incomes', businessId('incomes', context.owner, context.datasetId, 'income-1'), { ownerCoachId: context.owner, datasetId: context.datasetId, incomeId: 'income-1', bookingId, data: { id: 'income-1', bookingId, date: '2026-09-10', time: '09:00' } }); failCollection = 'incomes'
    result = await main()(execute('rescheduleBooking', 'income_write_fail', 0, { bookingId, date: '2026-09-12', hour: 10, minute: 0 })); assert.equal(result.code, 'COMMAND_TRANSACTION_FAILED'); assert.equal(rows('bookings')[0].data.date, '2026-09-10'); assert.equal(rows('incomes')[0].data.date, '2026-09-10'); assert.equal(rows(META.receipts).length, 0)
  })

  await test('completeBooking 使用 exact package 与 booking.price，重试不重复扣课或收入', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1', packageId = 'package-1', bookingId = 'booking-1'
    put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId, data: { id: packageId, type: '常规训练', used: 2, remaining: 8, price: 999, status: 'active' } })
    put('packages', businessId('packages', owner, datasetId, 'package-same-type'), { ownerCoachId: owner, datasetId, packageId: 'package-same-type', studentId, data: { id: 'package-same-type', type: '常规训练', used: 0, remaining: 20, price: 100, status: 'active' } })
    const history = { items: [{ name: '卧推', sets: 4, reps: 12, weight: 40 }, { name: '划船', sets: 3, reps: 10 }], notes: '按顺序保留', duration: 60, category: '胸' }
    put('bookings', businessId('bookings', owner, datasetId, bookingId), { ownerCoachId: owner, datasetId, bookingId, studentId, packageId, data: { id: bookingId, studentId, studentName: '张三', packageId, date: '2026-09-13', hour: 9, minute: 30, typeName: '常规训练', price: 380, status: 'booked', ...copy(history) } })
    const service = main(), call = execute('completeBooking', 'complete_retry_001', 0, { bookingId }), first = await service(call), retry = await service(call)
    assert.equal(first.ok, true); assert.equal(retry.idempotent, true); assert.equal(rows('incomes').length, 1); assert.equal(rows('incomes')[0].data.amount, 380)
    assert.equal(rows('packages').find(row => row.packageId === packageId).data.used, 3); assert.equal(rows('packages').find(row => row.packageId === packageId).data.remaining, 7); assert.equal(rows('packages').find(row => row.packageId === 'package-same-type').data.remaining, 20)
    const done = rows('bookings')[0].data; assert.equal(done.status, 'done'); assert.deepEqual(done.items, history.items); assert.equal(done.notes, history.notes); assert(done.summary.includes('卧推')); assert(done.summary.indexOf('卧推') < done.summary.indexOf('划船'))
  })

  await test('completeBooking gift 固定 80，并拒绝 reversed、无余额、done 与缺动作', async () => {
    const { owner, datasetId } = seed(), studentId = 'student-1'
    const add = (id, pkg, booking) => { put('packages', businessId('packages', owner, datasetId, id), { ownerCoachId: owner, datasetId, packageId: id, studentId, data: { id, used: 0, price: 500, ...pkg } }); put('bookings', businessId('bookings', owner, datasetId, `b-${id}`), { ownerCoachId: owner, datasetId, bookingId: `b-${id}`, studentId, packageId: id, data: { id: `b-${id}`, studentId, studentName: '张三', packageId: id, date: '2026-09-13', hour: 10, minute: 0, price: 500, status: 'booked', ...booking } }) }
    add('gift', { type: '赠送课程', remaining: 2, status: 'active' }, { typeName: '赠送课程', items: [{ name: '赠课训练' }] }); add('reversed', { type: '常规训练', remaining: 5, status: 'reversed' }, { typeName: '常规训练', items: [{ name: '动作' }] }); add('empty', { type: '常规训练', remaining: 0, status: 'active' }, { typeName: '常规训练', items: [{ name: '动作' }] }); add('no-items', { type: '常规训练', remaining: 2, status: 'active' }, { typeName: '常规训练', items: [] })
    const service = main(); assert.equal((await service(execute('completeBooking', 'gift_complete', 0, { bookingId: 'b-gift' }))).ok, true); assert.equal(rows('incomes')[0].data.amount, 80)
    assert.equal((await service(execute('completeBooking', 'reversed_complete', 1, { bookingId: 'b-reversed' }))).code, 'PACKAGE_UNAVAILABLE'); assert.equal((await service(execute('completeBooking', 'empty_complete', 1, { bookingId: 'b-empty' }))).code, 'PACKAGE_NO_REMAINING'); assert.equal((await service(execute('completeBooking', 'no_items_complete', 1, { bookingId: 'b-no-items' }))).code, 'TRAINING_ITEMS_REQUIRED'); assert.equal((await service(execute('completeBooking', 'done_again', 1, { bookingId: 'b-gift' }))).code, 'BOOKING_ALREADY_DONE')
  })

  await test('completeBooking package 或 income 写入失败时 booking/package/income 全部回滚', async () => {
    for (const failedCollection of ['packages', 'incomes']) {
      clear(); const { owner, datasetId } = seed(), bookingId = 'booking-1', packageId = 'package-1'
      put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId: 'student-1', data: { id: packageId, type: '常规训练', used: 0, remaining: 2, status: 'active' } }); put('bookings', businessId('bookings', owner, datasetId, bookingId), { ownerCoachId: owner, datasetId, bookingId, studentId: 'student-1', packageId, data: { id: bookingId, studentId: 'student-1', packageId, date: '2026-09-13', hour: 9, minute: 0, typeName: '常规训练', price: 300, status: 'booked', items: [{ name: '动作' }] } }); failCollection = failedCollection
      const result = await main()(execute('completeBooking', `complete_fail_${failedCollection}`, 0, { bookingId })); assert.equal(result.code, 'COMMAND_TRANSACTION_FAILED'); assert.equal(rows('bookings')[0].data.status, 'booked'); assert.equal(rows('packages')[0].data.used, 0); assert.equal(rows('packages')[0].data.remaining, 2); assert.equal(rows('incomes').length, 0); assert.equal(rows(META.receipts).length, 0)
    }
  })

  await test('deleteCompletedBooking active/reversed/missing package 分别按精确规则返课', async () => {
    for (const mode of ['active', 'reversed', 'missing']) {
      clear(); const { owner, datasetId } = seed(), bookingId = `done-${mode}`, packageId = `package-${mode}`
      if (mode !== 'missing') put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId: 'student-1', data: { id: packageId, used: 3, remaining: mode === 'active' ? 4 : 0, status: mode } })
      put('packages', businessId('packages', owner, datasetId, 'same-type-other'), { ownerCoachId: owner, datasetId, packageId: 'same-type-other', studentId: 'student-1', data: { id: 'same-type-other', used: 0, remaining: 10, status: 'active' } })
      put('bookings', businessId('bookings', owner, datasetId, bookingId), { ownerCoachId: owner, datasetId, bookingId, studentId: 'student-1', packageId, data: { id: bookingId, studentId: 'student-1', packageId, status: 'done', items: [{ name: '历史动作' }], notes: '历史备注', summary: '历史总结' } }); put('incomes', businessId('incomes', owner, datasetId, `income-${mode}`), { ownerCoachId: owner, datasetId, incomeId: `income-${mode}`, bookingId, data: { id: `income-${mode}`, bookingId, amount: 300 } })
      const service = main(), call = execute('deleteCompletedBooking', `delete_${mode}`, 0, { bookingId }); assert.equal((await service(call)).ok, true); assert.equal((await service(call)).idempotent, true); assert.equal(rows('bookings').length, 0); assert.equal(rows('incomes').length, 0); assert.equal(rows('packages').find(row => row.packageId === 'same-type-other').data.remaining, 10)
      if (mode === 'active') { const pkg = rows('packages').find(row => row.packageId === packageId).data; assert.equal(pkg.used, 2); assert.equal(pkg.remaining, 5) }
      if (mode === 'reversed') { const pkg = rows('packages').find(row => row.packageId === packageId).data; assert.equal(pkg.used, 2); assert.equal(pkg.remaining, 0) }
    }
  })

  await test('deleteCompletedBooking 拒绝非 done、无/多 income、used=0，失败不留半成品', async () => {
    const setup = (incomeCount, used = 1, status = 'done') => { const { owner, datasetId } = seed(), bookingId = 'booking-1', packageId = 'package-1'; put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId: 'student-1', data: { id: packageId, used, remaining: 2, status: 'active' } }); put('bookings', businessId('bookings', owner, datasetId, bookingId), { ownerCoachId: owner, datasetId, bookingId, studentId: 'student-1', packageId, data: { id: bookingId, studentId: 'student-1', packageId, status } }); for (let i = 0; i < incomeCount; i++) put('incomes', businessId('incomes', owner, datasetId, `income-${i}`), { ownerCoachId: owner, datasetId, incomeId: `income-${i}`, bookingId, data: { id: `income-${i}`, bookingId } }); return { bookingId } }
    let context = setup(1, 1, 'booked'), result = await main()(execute('deleteCompletedBooking', 'delete_not_done', 0, context)); assert.equal(result.code, 'BOOKING_NOT_DONE')
    clear(); context = setup(0); result = await main()(execute('deleteCompletedBooking', 'delete_no_income', 0, context)); assert.equal(result.code, 'INCOME_RELATION_AMBIGUOUS')
    clear(); context = setup(2); result = await main()(execute('deleteCompletedBooking', 'delete_multi_income', 0, context)); assert.equal(result.code, 'INCOME_RELATION_AMBIGUOUS')
    clear(); context = setup(1, 0); result = await main()(execute('deleteCompletedBooking', 'delete_used_zero', 0, context)); assert.equal(result.code, 'PACKAGE_USAGE_INVALID'); assert.equal(rows('bookings').length, 1); assert.equal(rows('incomes').length, 1)
    clear(); context = setup(1); failCollection = 'incomes'; result = await main()(execute('deleteCompletedBooking', 'delete_income_fail', 0, context)); assert.equal(result.code, 'COMMAND_TRANSACTION_FAILED'); assert.equal(rows('bookings').length, 1); assert.equal(rows('incomes').length, 1); assert.equal(rows('packages')[0].data.used, 1); assert.equal(rows(META.receipts).length, 0)
  })

  await test('complete/deleteCompleted 继续遵守 owner、active dataset 与 revision 隔离', async () => {
    const a = seed('openid-a', 'dataset-a'), b = seed('openid-b', 'dataset-b'), bookingId = 'booking-b', packageId = 'package-b'
    put('packages', businessId('packages', b.owner, b.datasetId, packageId), { ownerCoachId: b.owner, datasetId: b.datasetId, packageId, studentId: 'student-b', data: { id: packageId, used: 0, remaining: 2, status: 'active' } }); put('bookings', businessId('bookings', b.owner, b.datasetId, bookingId), { ownerCoachId: b.owner, datasetId: b.datasetId, bookingId, studentId: 'student-b', packageId, data: { id: bookingId, studentId: 'student-b', packageId, status: 'booked', items: [{ name: '动作' }], typeName: '常规训练', price: 300 } })
    put('bookings', businessId('bookings', a.owner, 'dataset-old', 'old-booking'), { ownerCoachId: a.owner, datasetId: 'dataset-old', bookingId: 'old-booking', data: { id: 'old-booking', status: 'done' } }); put('bookings', fixedId('bookings', a.owner, 'phase63'), { ownerCoachId: a.owner, bookingId: 'phase63', data: { id: 'phase63', status: 'done' } })
    openId = 'openid-a'; const service = main(); assert.equal((await service(execute('completeBooking', 'complete_owner_block', 0, { bookingId }))).code, 'BOOKING_NOT_FOUND'); assert.equal((await service(execute('deleteCompletedBooking', 'delete_old_block', 0, { bookingId: 'old-booking' }))).code, 'BOOKING_NOT_FOUND'); assert.equal((await service(execute('deleteCompletedBooking', 'delete_phase63_block', 0, { bookingId: 'phase63' }))).code, 'BOOKING_NOT_FOUND')
    assert.equal(rows('bookings').find(row => row.bookingId === bookingId).data.status, 'booked'); assert.equal(rows(META.revisions).find(row => row.ownerCoachId === a.owner).dataRevision, 0)
  })

  await test('updateBookingContent 只按白名单保存并原样保持动作顺序', async () => {
    const { owner, datasetId } = seed(), bookingId = 'draft-1'
    put('bookings', businessId('bookings', owner, datasetId, bookingId), { ownerCoachId: owner, datasetId, bookingId, studentId: 'student-1', packageId: 'package-1', data: { id: bookingId, studentId: 'student-1', packageId: 'package-1', status: 'booked', typeName: '常规训练', price: 300 } })
    const items = [{ name: '第三项' }, { name: '第一项' }, { name: '第二项' }], service = main(), call = execute('updateBookingContent', 'booking_content_001', 0, { bookingId, items, notes: '备注', category: '综合训练', duration: 60 })
    assert.equal((await service(call)).ok, true); assert.equal((await service(call)).idempotent, true)
    assert.deepEqual(rows('bookings')[0].data.items, items); assert.equal(rows('bookings')[0].data.packageId, 'package-1'); assert.equal(rows('bookings')[0].data.status, 'booked')
    const bad = await service(execute('updateBookingContent', 'booking_content_bad', 1, { bookingId, packageId: 'other' })); assert.equal(bad.code, 'INVALID_PAYLOAD')
  })
  await test('已完成课程可只修改训练内容，不改变完课、课时或收入事实', async () => {
    const { owner, datasetId } = seed(), bookingId = 'done-content', packageId = 'done-package'
    const booking = { id: bookingId, studentId: 'student-1', studentName: '假学员', packageId, status: 'done', date: '2026-09-16', hour: 9, minute: 30, completedAt: 123456, typeName: '常规训练', price: 150, items: [{ name: '历史动作' }], notes: '历史备注', summary: '旧总结', duration: 60 }
    put('bookings', businessId('bookings', owner, datasetId, bookingId), { ownerCoachId: owner, datasetId, bookingId, studentId: booking.studentId, packageId, data: booking })
    put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId: booking.studentId, data: { id: packageId, used: 2, remaining: 8, status: 'active' } })
    put('incomes', businessId('incomes', owner, datasetId, 'done-income'), { ownerCoachId: owner, datasetId, incomeId: 'done-income', bookingId, data: { id: 'done-income', bookingId, studentId: booking.studentId, amount: 150, date: booking.date, time: '09:30' } })
    const service = main(), beforeIncome = JSON.parse(JSON.stringify(rows('incomes'))), beforePackage = JSON.parse(JSON.stringify(rows('packages')))
    const items = [{ name: '高位下拉', group: '背部', sets: 5, reps: 10, weight: 30 }]
    const change = execute('updateBookingContent', 'done_content_edit_001', 0, { bookingId, items, notes: '修正训练备注', category: '背部训练', duration: 45 })
    assert.equal((await service(change)).ok, true)
    assert.equal((await service(change)).idempotent, true)
    const after = rows('bookings')[0].data
    assert.equal(after.status, 'done'); assert.equal(after.completedAt, 123456)
    assert.deepEqual(after.items, items); assert.equal(after.notes, '修正训练备注'); assert.equal(after.duration, 45)
    assert(after.summary.includes('高位下拉') && after.summary.includes('修正训练备注'))
    assert.deepEqual(rows('incomes'), beforeIncome); assert.deepEqual(rows('packages'), beforePackage)
    assert.equal((await service(execute('updateBookingContent', 'done_content_invalid', 1, { bookingId, status: 'booked' }))).code, 'INVALID_PAYLOAD')
  })

  await test('updateManualSale 只改手工业绩日期且不能修改课程销售', async () => {
    const { owner, datasetId } = seed()
    put('sales', businessId('sales', owner, datasetId, 'manual-1'), { ownerCoachId: owner, datasetId, saleId: 'manual-1', data: { id: 'manual-1', source: 'manual', date: '2026-08-01', amount: 123, note: '保留' } })
    put('sales', businessId('sales', owner, datasetId, 'course-1'), { ownerCoachId: owner, datasetId, saleId: 'course-1', data: { id: 'course-1', source: 'course', date: '2026-08-01', amount: 999 } })
    const service = main(), call = execute('updateManualSale', 'manual_date_001', 0, { saleId: 'manual-1', date: '2026-09-01' })
    assert.equal((await service(call)).ok, true); assert.equal((await service(call)).idempotent, true); assert.equal(rows('sales').find(x => x.saleId === 'manual-1').data.amount, 123); assert.equal(rows('sales').find(x => x.saleId === 'manual-1').data.note, '保留')
    assert.equal((await service(execute('updateManualSale', 'course_date_reject', 1, { saleId: 'course-1', date: '2026-09-01' }))).code, 'NOT_MANUAL_SALE')
  })

  await test('清除赠送课剩余权益会取消未上预约并保留已上历史与收入', async () => {
    const { owner, datasetId } = seed(), packageId = 'gift-1', studentId = 'student-1'
    put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId, data: { id: packageId, type: '赠送课程', total: 5, used: 0, remaining: 5, price: 80, status: 'active' } })
    const service = main(); assert.equal((await service(execute('updatePackage', 'gift_update_001', 0, { packageId, total: 8, remaining: 3 }))).ok, true)
    assert.deepEqual({ total: rows('packages')[0].data.total, used: rows('packages')[0].data.used, remaining: rows('packages')[0].data.remaining, price: rows('packages')[0].data.price }, { total: 8, used: 0, remaining: 3, price: 80 })
    put('bookings', businessId('bookings', owner, datasetId, 'future-1'), { ownerCoachId: owner, datasetId, bookingId: 'future-1', studentId, packageId, data: { id: 'future-1', studentId, packageId, status: 'booked' } })
    put('bookings', businessId('bookings', owner, datasetId, 'done-1'), { ownerCoachId: owner, datasetId, bookingId: 'done-1', studentId, packageId, data: { id: 'done-1', studentId, packageId, status: 'done' } })
    put('incomes', businessId('incomes', owner, datasetId, 'income-1'), { ownerCoachId: owner, datasetId, incomeId: 'income-1', studentId, packageId, data: { id: 'income-1', bookingId: 'done-1', studentId, packageId, typeName: '赠送课程', amount: 80 } })
    const call = execute('deletePackage', 'gift_delete_001', 1, { packageId }), first = await service(call)
    assert.equal(first.ok, true); assert.equal((await service(call)).idempotent, true)
    assert.equal(rows('packages').length, 1); assert.equal(rows('packages')[0].data.remaining, 0); assert.equal(rows('packages')[0].data.status, 'reversed')
    assert.deepEqual(rows('bookings').map(row => row.bookingId), ['done-1']); assert.equal(rows('incomes').length, 1)
  })

  await test('删除付费课包后从当前资料消失，同时保留销售业绩、已完成课程和收入', async () => {
    const { owner, datasetId } = seed(), packageId = 'paid-close-1', saleId = 'sale-close-1', studentId = 'student-1'
    put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId, saleId, data: { id: packageId, type: '常规训练', total: 10, used: 3, remaining: 7, price: 300, status: 'active', saleId } })
    put('sales', businessId('sales', owner, datasetId, saleId), { ownerCoachId: owner, datasetId, saleId, studentId, packageId, data: { id: saleId, source: 'course', studentId, packageId, typeName: '常规训练', amount: 3000, status: 'active' } })
    put('bookings', businessId('bookings', owner, datasetId, 'future-paid'), { ownerCoachId: owner, datasetId, bookingId: 'future-paid', studentId, packageId, data: { id: 'future-paid', studentId, packageId, status: 'booked' } })
    put('bookings', businessId('bookings', owner, datasetId, 'done-paid'), { ownerCoachId: owner, datasetId, bookingId: 'done-paid', studentId, packageId, data: { id: 'done-paid', studentId, packageId, status: 'done' } })
    put('incomes', businessId('incomes', owner, datasetId, 'income-paid'), { ownerCoachId: owner, datasetId, incomeId: 'income-paid', studentId, packageId, data: { id: 'income-paid', bookingId: 'done-paid', studentId, packageId, amount: 300 } })
    const result = await main()(execute('deletePackage', 'paid_close_001', 0, { packageId }))
    assert.equal(result.ok, true); assert.equal(result.result.deleted, true); assert.equal(result.result.archived, true); assert.deepEqual(result.result.cancelledBookingIds, ['future-paid'])
    assert.equal(rows('packages')[0].data.remaining, 0); assert.equal(rows('packages')[0].data.status, 'reversed')
    assert.equal(rows('packages')[0].data.closedReason, 'package-deleted')
    assert.equal(rows('sales')[0].data.status, 'active'); assert.equal(rows('sales')[0].data.amount, 3000)
    assert.deepEqual(rows('bookings').map(row => row.bookingId), ['done-paid']); assert.equal(rows('incomes').length, 1)
  })

  await test('新增命令继续隔离 owner/dataset，失败不留 revision/receipt 半成品', async () => {
    const a = seed('openid-a', 'dataset-a'), b = seed('openid-b', 'dataset-b')
    put('sales', businessId('sales', b.owner, b.datasetId, 'manual-b'), { ownerCoachId: b.owner, datasetId: b.datasetId, saleId: 'manual-b', data: { id: 'manual-b', source: 'manual', date: '2026-08-01' } })
    put('bookings', businessId('bookings', a.owner, 'dataset-old', 'old-booking'), { ownerCoachId: a.owner, datasetId: 'dataset-old', bookingId: 'old-booking', data: { id: 'old-booking', status: 'booked' } })
    openId = 'openid-a'; const service = main(); assert.equal((await service(execute('updateManualSale', 'cross_sale_update', 0, { saleId: 'manual-b', date: '2026-09-01' }))).code, 'SALE_NOT_FOUND'); assert.equal((await service(execute('updateBookingContent', 'old_booking_update', 0, { bookingId: 'old-booking', notes: 'x' }))).code, 'BOOKING_NOT_FOUND')
    const packageId = 'gift-a'; put('packages', businessId('packages', a.owner, a.datasetId, packageId), { ownerCoachId: a.owner, datasetId: a.datasetId, packageId, studentId: 'student-a', data: { id: packageId, type: '赠送课程', total: 2, used: 0, remaining: 2, price: 80 } }); failCollection = 'packages'
    const result = await service(execute('updatePackage', 'gift_update_fail', 0, { packageId, remaining: 1 })); assert.equal(result.code, 'COMMAND_TRANSACTION_FAILED'); assert.equal(rows('packages').find(x => x.packageId === packageId).data.remaining, 2); assert.equal(rows(META.receipts).filter(x => x.ownerCoachId === a.owner).length, 0)
  })

  await test('legacy orphan course sale 只读，不参与编辑、撤销或课时包操作', async () => {
    const { owner, datasetId } = seed(), saleId = 'legacy-orphan-1'
    put('sales', businessId('sales', owner, datasetId, saleId), { ownerCoachId: owner, datasetId, saleId, studentId: 'legacy-student', packageId: '', data: { id: saleId, source: 'course', studentId: 'legacy-student', amount: 3000, legacyRelationStatus: 'orphan', legacyRelationReason: 'missing_packageId_without_unique_package.saleId' } })
    const service = main()
    assert.equal((await service(execute('reverseCourseSale', 'orphan_reverse_reject', 0, { saleId }))).code, 'LEGACY_ORPHAN_SALE_READ_ONLY')
    assert.equal(rows('sales')[0].data.status, undefined)
    assert.equal(rows('packages').length, 0)
    assert.equal(rows(META.receipts).length, 0)
  })

  await test('legacy orphan done booking 只读，不能删除或向任意 package 返课', async () => {
    const { owner, datasetId } = seed(), bookingId = 'legacy-booking-1'
    put('bookings', businessId('bookings', owner, datasetId, bookingId), { ownerCoachId: owner, datasetId, bookingId, studentId: 'historical-student', packageId: '', data: { id: bookingId, status: 'done', studentId: 'historical-student', studentName: '历史学员', items: [{ name: '历史动作' }], notes: '保留', summary: '保留', legacyRelationStatus: 'orphan', legacyRelationReason: 'PACKAGE_ID_MISSING' } })
    put('incomes', businessId('incomes', owner, datasetId, 'legacy-income-1'), { ownerCoachId: owner, datasetId, incomeId: 'legacy-income-1', bookingId, studentId: 'historical-student', data: { id: 'legacy-income-1', bookingId, studentId: 'historical-student', amount: 300 } })
    put('packages', businessId('packages', owner, datasetId, 'same-type-package'), { ownerCoachId: owner, datasetId, packageId: 'same-type-package', studentId: 'historical-student', data: { id: 'same-type-package', type: '常规训练', used: 2, remaining: 8, status: 'active' } })
    const result = await main()(execute('deleteCompletedBooking', 'legacy_booking_delete_reject', 0, { bookingId }))
    assert.equal(result.code, 'LEGACY_ORPHAN_BOOKING_READ_ONLY'); assert.equal(rows('bookings').length, 1); assert.equal(rows('incomes').length, 1); assert.equal(rows('packages')[0].data.remaining, 8); assert.equal(rows(META.receipts).length, 0)
  })

  if (!process.exitCode) process.stdout.write('ALL LOW-RISK FORMAL COMMAND TESTS PASSED\n')
})()
