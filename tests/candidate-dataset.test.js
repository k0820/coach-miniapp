const assert = require('assert')
const { buildCandidateDataset, analyzeLegacyCourseSales, reconstructCandidate, integrity, COLLECTIONS } = require('../utils/candidate-dataset')

function fixture() {
  const bookings = [], incomes = []
  for (let index = 0; index < 145; index++) {
    const gift = index === 1, deleted = index === 2
    const studentId = deleted ? 'student-deleted' : 'student-active'
    const packageId = deleted ? 'package-deleted' : gift ? 'package-gift' : index % 2 ? 'package-paid-2' : 'package-paid-1'
    const booking = { id: `booking-${index}`, studentId, studentName: deleted ? '历史学员' : '张三', packageId, typeName: index === 0 ? '力量训练' : gift ? '赠送课程' : '常规训练', status: 'done', date: '2026-09-01', items: index === 0 ? [{ name: '深蹲', notes: '完整保留'.repeat(20000) }, { name: '卧推' }] : [], notes: `notes-${index}`, summary: `summary-${index}` }
    bookings.push(booking)
    incomes.push({ id: `income-${index}`, bookingId: booking.id, studentId, studentName: booking.studentName, amount: gift ? 80 : 300, typeName: booking.typeName })
  }
  return {
    students: [
      { id: 'student-active', name: '张三', packages: [
        { id: 'package-paid-1', type: '力量训练', total: 10, used: 4, remaining: 3, price: 300 },
        { id: 'package-paid-2', type: '常规训练', total: 20, used: 3, remaining: 15, price: 450, saleId: 'sale-course-2' },
        { id: 'package-gift', type: '赠送课程', total: 3, used: 1, remaining: 2, price: 80 },
        { type: '赠送课程', total: 2, used: 1 }
      ] },
      { id: 'student-deleted', name: '历史学员', status: 'deleted', deletedAt: 123, packages: [{ id: 'package-deleted', type: '常规训练', total: 10, used: 2, remaining: 0, status: 'reversed', saleId: 'sale-deleted' }] }
    ],
    bookings,
    incomes,
    sales: [
      { id: 'sale-course-1', source: 'course', studentId: 'student-active', packageId: 'package-paid-1', quantity: 10, unitPrice: 300, amount: 2800, date: '2026-06-01' },
      { id: 'sale-course-2', source: 'course', studentId: 'student-active', packageId: 'package-paid-2', quantity: 20, unitPrice: 450, amount: 7600, date: '2026-09-01' },
      { id: 'sale-deleted', source: 'course', studentId: 'student-deleted', packageId: 'package-deleted', quantity: 10, unitPrice: 300, amount: 3000, status: 'reversed' },
      { id: 'sale-manual', source: 'manual', date: '2026-09-02', amount: 99, note: '其他业绩' }
    ],
    settings: { renewThreshold: 8, commissionRate: 5 },
    customExercises: [{ name: '自定义A', group: '胸' }, { id: 'exercise-b', name: '自定义B', group: '背' }],
    futureField: { preserved: true }
  }
}

function expectCode(fn, code) {
  assert.throws(fn, error => error && error.code === code)
}

function run() {
  const source = fixture(), before = JSON.stringify(source)
  const context = { trustedOwnerCoachId: 'coach-a', trustedDatasetId: 'dataset-candidate-a' }
  const first = buildCandidateDataset(source, context)
  const second = buildCandidateDataset(source, context)

  assert.strictEqual(JSON.stringify(source), before, '输入 snapshot 被修改')
  assert.strictEqual(first.integrity.checksum, second.integrity.checksum)
  assert.strictEqual(first.integrity.byteSize, second.integrity.byteSize)
  assert.deepStrictEqual(first.normalizedSnapshot, second.normalizedSnapshot)
  assert.strictEqual(first.status, 'verified')
  assert.ok(COLLECTIONS.includes('studentTombstones'))
  assert.strictEqual(first.collections.students.length, 1)
  assert.strictEqual(first.collections.studentTombstones.length, 1)
  assert.strictEqual(first.integrity.summary.students, 1)
  assert.strictEqual(first.integrity.summary.deletedStudents, 1)
  assert.ok(first.collections.studentTombstones[0].data.status === 'deleted')
  assert.ok(first.collections.packages.some(row => row.studentId === 'student-deleted' && row.packageId === 'package-deleted'))
  assert.ok(first.collections.bookings.some(row => row.data.studentId === 'student-deleted'))
  assert.ok(first.collections.incomes.some(row => row.data.studentId === 'student-deleted'))

  // trusted context 覆盖归属，候选文档不从业务 snapshot 读取身份。
  Object.values(first.collections).flat().forEach(row => {
    assert.strictEqual(row.ownerCoachId, 'coach-a')
    assert.strictEqual(row.datasetId, 'dataset-candidate-a')
  })

  const normalized = first.normalizedSnapshot
  assert.strictEqual(normalized.students[0].abbr, 'ZS')
  assert.strictEqual(normalized.students[0].packages[0].type, '常规训练')
  assert.strictEqual(normalized.students[0].packages[0].saleId, 'sale-course-1')
  assert.ok(/^pkg_legacy_/.test(normalized.students[0].packages[3].id))
  assert.strictEqual(normalized.students[0].packages[3].remaining, 1)
  assert.strictEqual(normalized.students[0].packages[3].status, 'active')
  assert.ok(/^exercise_legacy_/.test(normalized.customExercises[0].id))
  assert.strictEqual(normalized.settings.classCommissionRate, 0)
  assert.strictEqual(normalized.settings.salesCommissionRate, 5)

  // 模拟 CloudBase 分页乱序回读：reconstruct 只依赖 sourceOrder。
  const paged = {}
  COLLECTIONS.forEach(name => {
    const rows = first.collections[name]
    const pages = []
    for (let at = 0; at < rows.length; at += 17) pages.push(rows.slice(at, at + 17))
    paged[name] = pages.reverse().flat()
  })
  const rebuilt = reconstructCandidate(paged)
  const rebuiltIntegrity = integrity(rebuilt)
  assert.strictEqual(rebuiltIntegrity.checksum, first.integrity.checksum)
  assert.strictEqual(rebuiltIntegrity.byteSize, first.integrity.byteSize)
  assert.deepStrictEqual(rebuiltIntegrity.summary, first.integrity.summary)
  assert.deepStrictEqual(rebuilt, normalized)
  assert.deepStrictEqual(rebuilt.bookings[0].items.map(item => item.name), ['深蹲', '卧推'])
  assert.strictEqual(rebuilt.bookings[0].items[0].notes.length, '完整保留'.length * 20000)
  assert.deepStrictEqual(rebuilt.customExercises.map(item => item.name), ['自定义A', '自定义B'])

  const ambiguous = fixture()
  ambiguous.sales.push({ id: 'sale-course-duplicate', source: 'course', studentId: 'student-active', packageId: 'package-paid-1', amount: 1 })
  const multiSaleCandidate = buildCandidateDataset(ambiguous, context)
  const sharedPackage = multiSaleCandidate.normalizedSnapshot.students[0].packages.find(item => item.id === 'package-paid-1')
  const sharedSales = multiSaleCandidate.normalizedSnapshot.sales.filter(item => item.packageId === 'package-paid-1')
  assert.strictEqual(sharedPackage.saleId, undefined)
  assert.strictEqual(sharedSales.length, 2)
  assert.ok(sharedSales.every(item => item.legacyRelationStatus === 'orphan' && item.legacyRelationReason === 'multiple_course_sales_for_package'))
  const multiAnalysis = analyzeLegacyCourseSales(ambiguous)
  assert.strictEqual(multiAnalysis.counts.C, 2)
  assert.ok(multiAnalysis.records.filter(item => item.reason === 'multiple_course_sales_for_package').every(item => item.packageEvidence[0].originalPackage.id === 'package-paid-1'))

  const brokenGift = fixture()
  brokenGift.students[0].packages[2].saleId = 'sale-manual'
  expectCode(() => buildCandidateDataset(brokenGift, context), 'SALE_PACKAGE_RELATION_INVALID')

  const duplicateExercise = fixture()
  duplicateExercise.customExercises = [{ name: '重复', group: '胸' }, { name: '重复', group: '胸' }]
  expectCode(() => buildCandidateDataset(duplicateExercise, context), 'AMBIGUOUS_CUSTOM_EXERCISE_ID')

  const forged = fixture()
  forged.ownerCoachId = 'coach-b'
  expectCode(() => buildCandidateDataset(forged, context), 'UNTRUSTED_IDENTITY_FIELD')

  // 旧 course sale 只在存在唯一 ID 反向证据时补齐，不用名称/日期/金额猜测。
  const missingSalePackage = fixture()
  delete missingSalePackage.sales[0].packageId
  delete missingSalePackage.sales[0].studentId
  missingSalePackage.students[0].packages[0].saleId = 'sale-course-1'
  const repairedSale = buildCandidateDataset(missingSalePackage, context).normalizedSnapshot
  assert.strictEqual(repairedSale.sales[0].packageId, 'package-paid-1')
  assert.strictEqual(repairedSale.sales[0].studentId, 'student-active')

  const missingPackageSale = fixture()
  delete missingPackageSale.students[0].packages[1].saleId
  assert.strictEqual(buildCandidateDataset(missingPackageSale, context).normalizedSnapshot.students[0].packages[1].saleId, 'sale-course-2')

  const unresolved = fixture()
  delete unresolved.sales[0].packageId
  delete unresolved.students[0].packages[0].saleId
  const orphanCandidate = buildCandidateDataset(unresolved, context)
  assert.strictEqual(orphanCandidate.normalizedSnapshot.sales[0].legacyRelationStatus, 'orphan')
  assert.strictEqual(orphanCandidate.normalizedSnapshot.sales[0].legacyRelationReason, 'missing_packageId_without_unique_package.saleId')
  assert.strictEqual(orphanCandidate.normalizedSnapshot.sales[0].packageId, undefined)
  const analysis = analyzeLegacyCourseSales(unresolved)
  assert.strictEqual(analysis.counts.C, 1)
  assert.strictEqual(analysis.records.find(item => item.saleId === 'sale-course-1').candidateCount, 0)
  assert.deepStrictEqual(analysis.records.find(item => item.saleId === 'sale-course-1').missing, ['packageId'])

  const multipleReverseLinks = fixture()
  delete multipleReverseLinks.sales[0].packageId
  multipleReverseLinks.students[0].packages[0].saleId = 'sale-course-1'
  multipleReverseLinks.students[0].packages[2].saleId = 'sale-course-1'
  assert.throws(() => buildCandidateDataset(multipleReverseLinks, context), error => error.code === 'UNRESOLVED_COURSE_SALE_RELATION' && error.details.issues[0].candidateCount === 2)

  const legacyBooking = fixture(), historical = legacyBooking.bookings[0], historicalIncome = legacyBooking.incomes[0]
  delete historical.packageId
  Object.assign(historical, { items: [{ name: '历史动作一' }, { name: '历史动作二' }], notes: '历史备注', summary: '历史总结', duration: 75, minute: 15 })
  const legacyBookingBefore = JSON.stringify(legacyBooking)
  const legacyCandidate = buildCandidateDataset(legacyBooking, context), preserved = legacyCandidate.normalizedSnapshot.bookings[0]
  assert.strictEqual(JSON.stringify(legacyBooking), legacyBookingBefore)
  assert.strictEqual(preserved.legacyRelationStatus, 'orphan')
  assert.ok(preserved.legacyRelationReason.includes('PACKAGE_ID_MISSING'))
  assert.deepStrictEqual(preserved.items.map(item => item.name), ['历史动作一', '历史动作二'])
  assert.strictEqual(preserved.notes, '历史备注'); assert.strictEqual(preserved.summary, '历史总结'); assert.strictEqual(preserved.duration, 75); assert.strictEqual(preserved.minute, 15)
  assert.ok(legacyCandidate.normalizedSnapshot.incomes.some(item => item.id === historicalIncome.id && item.bookingId === historical.id))

  const conflictingBooking = fixture()
  conflictingBooking.bookings[0].studentId = 'student-deleted'
  assert.throws(() => buildCandidateDataset(conflictingBooking, context), error => error.code === 'UNRESOLVED_BOOKING_RELATION' && error.details.records[0].reasons.some(item => item.code === 'PACKAGE_STUDENT_CONFLICT'))

  console.log('candidate-dataset tests: PASS (deterministic normalization, tombstones, pagination/order, large booking, relations, immutability)')
}

run()
