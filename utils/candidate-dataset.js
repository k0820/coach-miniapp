const { sha256, utf8ByteLength } = require('./sha256')
const { canonicalize } = require('./cloud-migration')
const { initials } = require('./pinyin')
const { analyzeHistoricalBookings } = require('./candidate-booking-diagnostic')

const CANDIDATE_SCHEMA_VERSION = 1
const COLLECTIONS = ['students', 'studentTombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
const DEFAULT_SETTINGS = { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 0, salesCommissionRate: 0 }
const IDENTITY_KEYS = new Set(['openId', 'OPENID', '_openid', 'coachId', 'ownerCoachId', 'datasetId', 'documentId'])

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function assert(condition, code, message) { if (!condition) { const error = new Error(message); error.code = code; throw error } }
function renameType(name) { return name === '力量训练' ? '常规训练' : name === '体能训练' ? '拳击训练' : name }
function stableId(prefix, value) { return `${prefix}_legacy_${sha256(JSON.stringify(canonicalize(value))).slice(0, 24)}` }
function idOf(item, label) { const id = item && item.id; assert(typeof id === 'string' && id, 'MISSING_ID', `${label} 缺少稳定 ID。`); return id }
function rejectIdentityFields(value, path = 'snapshot') {
  if (!value || typeof value !== 'object') return
  Object.keys(value).forEach(key => {
    assert(!IDENTITY_KEYS.has(key), 'UNTRUSTED_IDENTITY_FIELD', `${path}.${key} 不得决定数据归属。`)
    rejectIdentityFields(value[key], `${path}.${key}`)
  })
}

function resolveLegacyCourseSaleRelations(snapshot) {
  const refs = []
  snapshot.students.forEach(student => (student.packages || []).forEach(pkg => refs.push({ student, pkg })))
  const courseSales = snapshot.sales.filter(sale => sale.source === 'course'), issues = [], repairs = [], records = []
  courseSales.forEach(sale => {
    const originalSale = clone(sale)
    let candidates = sale.packageId ? refs.filter(ref => ref.pkg.id === sale.packageId) : refs.filter(ref => ref.pkg.saleId === sale.id)
    const diagnostic = { saleId: sale.id || '', source: sale.source, missing: [!sale.packageId ? 'packageId' : null, !sale.studentId ? 'studentId' : null].filter(Boolean), studentIdPresent: !!sale.studentId, studentId: sale.studentId || '', packageId: sale.packageId || '', quantity: sale.quantity, unitPrice: sale.unitPrice, amount: sale.amount, date: sale.date, status: sale.status, typeName: sale.typeName, originalSale, packageEvidence: candidates.map(ref => ({ packageId: ref.pkg.id, studentId: ref.student.id, evidence: sale.packageId ? 'sale.packageId' : 'package.saleId', originalPackage: clone(ref.pkg) })), candidateCount: candidates.length }
    if (candidates.length === 0) {
      const reason = sale.packageId ? 'package_not_found' : 'missing_packageId_without_unique_package.saleId'
      Object.assign(sale, { legacyRelationStatus: 'orphan', legacyRelationReason: reason })
      records.push({ ...diagnostic, category: 'C', reason, resolution: 'preserve_as_read_only_legacy_orphan' })
      return
    }
    if (candidates.length !== 1) {
      const issue = { ...diagnostic, reason: 'package_relation_ambiguous' }
      issues.push(issue); records.push({ ...issue, category: 'C', resolution: 'unresolved_conflict' })
      return
    }
    const ref = candidates[0]
    const repaired = []
    if (!sale.packageId) { sale.packageId = ref.pkg.id; const item = { saleId: sale.id, field: 'packageId', value: ref.pkg.id, evidence: 'unique package.saleId' }; repairs.push(item); repaired.push(item) }
    if (!sale.studentId) { sale.studentId = ref.student.id; const item = { saleId: sale.id, field: 'studentId', value: ref.student.id, evidence: 'unique package owner studentId' }; repairs.push(item); repaired.push(item) }
    if (sale.studentId !== ref.student.id) { const issue = { ...diagnostic, missing: [], reason: 'studentId_conflicts_with_package_owner', expectedStudentId: ref.student.id, actualStudentId: sale.studentId }; issues.push(issue); records.push({ ...issue, category: 'C', resolution: 'unresolved_conflict' }); return }
    if (ref.pkg.saleId && ref.pkg.saleId !== sale.id) { const issue = { ...diagnostic, packageId: ref.pkg.id, missing: [], reason: 'package.saleId_conflict', expectedSaleId: ref.pkg.saleId }; issues.push(issue); records.push({ ...issue, category: 'C', resolution: 'unresolved_conflict' }); return }
    records.push({ ...diagnostic, packageId: sale.packageId, studentId: sale.studentId, category: repaired.length ? 'B' : 'A', reason: repaired.length ? 'unique_id_evidence' : 'complete_bidirectional_relation', resolution: repaired.length ? repaired : 'none' })
  })
  refs.forEach(ref => {
    if (ref.pkg.saleId) return
    const matches = courseSales.filter(sale => sale.packageId === ref.pkg.id && sale.studentId === ref.student.id)
    if (matches.length === 1) { ref.pkg.saleId = matches[0].id; const repair = { saleId: matches[0].id, packageId: ref.pkg.id, field: 'package.saleId', value: matches[0].id, evidence: 'unique sale.packageId + sale.studentId' }; repairs.push(repair); const record = records.find(item => item.saleId === matches[0].id); if (record) { record.category = 'B'; record.reason = 'unique_id_evidence'; record.resolution = Array.isArray(record.resolution) ? record.resolution.concat(repair) : [repair] } }
    else if (matches.length > 1) matches.forEach(sale => {
      Object.assign(sale, { legacyRelationStatus: 'orphan', legacyRelationReason: 'multiple_course_sales_for_package' })
      const record = records.find(item => item.saleId === sale.id)
      if (record) Object.assign(record, { category: 'C', reason: 'multiple_course_sales_for_package', resolution: 'preserve_as_read_only_legacy_orphan', candidateCount: matches.length, missing: ['package.saleId'], packageEvidence: [{ packageId: ref.pkg.id, studentId: ref.student.id, evidence: 'shared sale.packageId', originalPackage: clone(ref.pkg) }] })
    })
  })
  if (issues.length) {
    const first = issues[0], missing = first.missing.length ? `缺少 ${first.missing.join('/')}` : '关联冲突'
    const error = new Error(`course sale ${first.saleId || '未知 ID'} 无法确定性恢复：${missing}（${first.reason}）；共 ${issues.length} 条 unresolved。`)
    error.code = 'UNRESOLVED_COURSE_SALE_RELATION'; error.details = { issues, repairs }; throw error
  }
  return { issues, repairs, records, counts: { A: records.filter(item => item.category === 'A').length, B: records.filter(item => item.category === 'B').length, C: records.filter(item => item.category === 'C').length } }
}

function normalizeSnapshot(input, options = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_SNAPSHOT', '备选数据顶层必须是对象。')
  const snapshot = clone(input)
  rejectIdentityFields(snapshot)
  assert(Array.isArray(snapshot.students), 'INVALID_STUDENTS', 'students 必须是数组。')
  assert(Array.isArray(snapshot.bookings), 'INVALID_BOOKINGS', 'bookings 必须是数组。')
  assert(Array.isArray(snapshot.incomes), 'INVALID_INCOMES', 'incomes 必须是数组。')
  snapshot.sales = snapshot.sales == null ? [] : snapshot.sales
  snapshot.customExercises = snapshot.customExercises == null ? [] : snapshot.customExercises
  assert(Array.isArray(snapshot.sales), 'INVALID_SALES', 'sales 必须是数组。')
  assert(Array.isArray(snapshot.customExercises), 'INVALID_CUSTOM_EXERCISES', 'customExercises 必须是数组。')
  const legacySettings = snapshot.settings && typeof snapshot.settings === 'object' && !Array.isArray(snapshot.settings) ? snapshot.settings : {}
  snapshot.settings = { ...DEFAULT_SETTINGS, ...legacySettings }
  if (legacySettings.salesCommissionRate == null && legacySettings.commissionRate != null) snapshot.settings.salesCommissionRate = Number(legacySettings.commissionRate) || 0

  const generatedPackageIds = new Set()
  snapshot.students.forEach((student, studentIndex) => {
    idOf(student, `students[${studentIndex}]`)
    student.abbr = student.abbr || initials(student.name || '')
    student.packages = Array.isArray(student.packages) ? student.packages : []
    student.packages.forEach((pkg, packageIndex) => {
      pkg.type = renameType(pkg.type)
      if (!pkg.id) {
        const fingerprint = { studentId: student.id, package: pkg }
        pkg.id = stableId('pkg', fingerprint)
        assert(!generatedPackageIds.has(pkg.id), 'AMBIGUOUS_LEGACY_PACKAGE_ID', `学员 ${student.id} 存在无法区分的无 ID 历史课时包。`)
        generatedPackageIds.add(pkg.id)
      }
      if (pkg.remaining === undefined) pkg.remaining = Math.max(0, Number(pkg.total || 0) - Number(pkg.used || 0))
      if (!pkg.status) pkg.status = 'active'
    })
  })
  const relationReport = resolveLegacyCourseSaleRelations(snapshot)
  if (options.relationReport) options.relationReport.push(clone(relationReport))
  const bookingReport = analyzeHistoricalBookings(snapshot)
  if (bookingReport.counts.D) {
    const error = new Error(`存在 ${bookingReport.counts.D} 条历史 booking 关系冲突，不能自动处理。`)
    error.code = 'UNRESOLVED_BOOKING_RELATION'; error.details = { counts: bookingReport.counts, records: bookingReport.records.filter(item => item.category === 'D'), orphanIncomes: bookingReport.orphanIncomes }; throw error
  }
  bookingReport.records.forEach(record => {
    const booking = snapshot.bookings.find(item => item.id === record.bookingId)
    if (!booking) return
    if (record.category === 'B') record.deterministicRepairs.forEach(repair => { booking[repair.field] = repair.value })
    if (record.category === 'C') {
      booking.legacyRelationStatus = 'orphan'
      booking.legacyRelationReason = record.reasons.map(item => item.code).join(',')
    }
  })
  snapshot.bookings.forEach(item => { item.typeName = renameType(item.typeName) })
  snapshot.incomes.forEach(item => { item.typeName = renameType(item.typeName) })
  snapshot.sales.forEach(item => { item.typeName = renameType(item.typeName) })
  const generatedExerciseIds = new Set()
  snapshot.customExercises.forEach((exercise, index) => {
    if (!exercise.id) {
      exercise.id = stableId('exercise', exercise)
      assert(!generatedExerciseIds.has(exercise.id), 'AMBIGUOUS_CUSTOM_EXERCISE_ID', `customExercises[${index}] 与其他无 ID 动作无法稳定区分。`)
      generatedExerciseIds.add(exercise.id)
    }
  })
  return snapshot
}

function analyzeLegacyCourseSales(input) {
  const reports = []
  const normalizedSnapshot = normalizeSnapshot(input, { relationReport: reports })
  return { ...reports[0], normalizedSnapshot }
}

function document(ownerCoachId, datasetId, sourceOrder, data, extra = {}) {
  return { ownerCoachId, datasetId, sourceOrder, ...extra, data: clone(data) }
}

function candidateCollections(snapshot, ownerCoachId, datasetId) {
  const collections = Object.fromEntries(COLLECTIONS.map(name => [name, []]))
  snapshot.students.forEach((student, studentOrder) => {
    const data = clone(student), packages = data.packages
    delete data.packages
    const target = student.status === 'deleted' ? 'studentTombstones' : 'students'
    collections[target].push(document(ownerCoachId, datasetId, studentOrder, data, { studentId: student.id }))
    packages.forEach((pkg, packageOrder) => collections.packages.push(document(ownerCoachId, datasetId, packageOrder, pkg, { studentId: student.id, studentSourceOrder: studentOrder, packageId: pkg.id })))
  })
  ;['bookings', 'incomes', 'sales', 'customExercises'].forEach(name => snapshot[name].forEach((item, index) => {
    const key = name === 'bookings' ? 'bookingId' : name === 'incomes' ? 'incomeId' : name === 'sales' ? 'saleId' : 'customExerciseId'
    collections[name].push(document(ownerCoachId, datasetId, index, item, { [key]: item.id }))
  }))
  const known = new Set(['students', 'bookings', 'incomes', 'sales', 'settings', 'customExercises'])
  const rootExtras = {}
  Object.keys(snapshot).forEach(key => { if (!known.has(key)) rootExtras[key] = clone(snapshot[key]) })
  collections.settings.push(document(ownerCoachId, datasetId, 0, snapshot.settings, { settingsId: 'settings', rootExtras }))
  return collections
}

function reconstructCandidate(collections) {
  COLLECTIONS.forEach(name => assert(Array.isArray(collections[name]), 'INVALID_CANDIDATE_COLLECTION', `${name} 集合无效。`))
  const orderOf = row => Number.isFinite(Number(row.sourceOrder)) ? Number(row.sourceOrder) : Number.isFinite(Number(row.sortIndex)) ? Number(row.sortIndex) : Number.MAX_SAFE_INTEGER
  const studentOrderOf = row => Number.isFinite(Number(row.studentSourceOrder)) ? Number(row.studentSourceOrder) : Number.isFinite(Number(row.studentSortIndex)) ? Number(row.studentSortIndex) : Number.MAX_SAFE_INTEGER
  const people = collections.students.concat(collections.studentTombstones).sort((a, b) => orderOf(a) - orderOf(b)).map(row => ({ ...clone(row.data), packages: [] }))
  const byStudent = new Map(people.map(student => [student.id, student]))
  collections.packages.slice().sort((a, b) => studentOrderOf(a) - studentOrderOf(b) || orderOf(a) - orderOf(b)).forEach(row => {
    const student = byStudent.get(row.studentId)
    assert(student, 'ORPHAN_PACKAGE', `package ${row.packageId} 缺少学员或删除墓碑。`)
    student.packages.push(clone(row.data))
  })
  const ordered = name => collections[name].slice().sort((a, b) => orderOf(a) - orderOf(b)).map(row => clone(row.data))
  const settings = collections.settings[0] || { data: {}, rootExtras: {} }
  return { ...(clone(settings.rootExtras || {})), students: people, bookings: ordered('bookings'), incomes: ordered('incomes'), sales: ordered('sales'), settings: clone(settings.data), customExercises: ordered('customExercises') }
}

function unique(records, field, label) {
  const seen = new Set()
  records.forEach((item, index) => { const id = idOf(item, `${label}[${index}]`); assert(!seen.has(id), 'DUPLICATE_ID', `${label} ID 重复：${id}`); seen.add(id) })
  return seen
}

// ------------------------------------------------------------------ 跨账预约（M2 共享 / 授权排课）
//
// ⭐ BUG04（2026-09-28 真机）：用授权课包排出来的那条预约，**文档物理落在授课教练 B 这本账里**，
//   而它消耗的那份课时包、那位会员的档案，**物理存在课时包所属教练 A 那本账里**。
//   这不是关系损坏，而是 `createBookingOnForeignPackage` 在**同一个云端事务**里写出来的合法形状
//   —— 唯一的跨账定位标记就是行里的 `booking.packageUsage`。
//   ⇒ 在这本账里重建（`reconstructCandidate`）之后**必然**查不到它的 package / student，
//     下面那条严格断言就会抛 `BOOKING_RELATION_INVALID` ⇒ **整次完整回读失败** ⇒ cache 一个字节都不更新
//     ⇒ B 的课表永远看不到自己刚排成功的那一节课（云端早就是 ok:true —— 两端判据不一致）。
//
// ⛔ 这个口子必须窄，而且只能是"认服务端写出来的事实"：
//    `packageUsage` **只有**云端内核会写（core.js 的 FORBIDDEN 已禁客户端提交 ownerCoachId / datasetId），
//    所以"这条预约的课时事实在另一本账"是**可信判断**，不是猜出来的。
//    反过来，安全边界一个字没松：**没有** packageUsage 的预约，仍必须满足完整 student / package 关系。
function sharedUsageOf(booking) {
  const usage = booking && booking.packageUsage
  if (!usage || typeof usage !== 'object') return null
  if (!usage.packageId || usage.packageId !== booking.packageId) return null
  if (!usage.ownerCoachId || !usage.datasetId) return null
  if (usage.studentId && booking.studentId && usage.studentId !== booking.studentId) return null
  return usage
}

function validateRelations(snapshot) {
  const students = new Map(snapshot.students.map(item => [item.id, item]))
  const packages = [], packageById = new Map()
  snapshot.students.forEach(student => (student.packages || []).forEach(pkg => { packages.push({ ...pkg, studentId: student.id }); packageById.set(pkg.id, { ...pkg, studentId: student.id }) }))
  unique(snapshot.students, 'id', 'students'); unique(packages, 'id', 'packages'); unique(snapshot.bookings, 'id', 'bookings'); unique(snapshot.incomes, 'id', 'incomes'); unique(snapshot.sales, 'id', 'sales'); unique(snapshot.customExercises, 'id', 'customExercises')
  assert(packageById.size === packages.length, 'DUPLICATE_ID', 'package ID 重复。')
  const saleById = new Map(snapshot.sales.map(item => [item.id, item]))
  packages.forEach(pkg => {
    assert(students.has(pkg.studentId), 'ORPHAN_PACKAGE', `package ${pkg.id} 缺少学员或墓碑。`)
    if (pkg.status === 'reversed') assert(Number(pkg.remaining) === 0, 'REVERSED_PACKAGE_REMAINING', `reversed package ${pkg.id} remaining 必须为 0。`)
    if (pkg.saleId) { const sale = saleById.get(pkg.saleId); assert(sale && sale.source === 'course' && sale.packageId === pkg.id && sale.studentId === pkg.studentId, 'SALE_PACKAGE_RELATION_INVALID', `package ${pkg.id} 与 sale ${pkg.saleId} 关系不一致。`) }
    if (pkg.type === '赠送课程') assert(!pkg.saleId && !snapshot.sales.some(sale => sale.source === 'course' && sale.packageId === pkg.id), 'GIFT_HAS_SALE', `赠送 package ${pkg.id} 不应有 course sale。`)
  })
  snapshot.sales.forEach(sale => {
    if (sale.source === 'manual') { assert(!sale.packageId, 'MANUAL_SALE_HAS_PACKAGE', `manual sale ${sale.id} 不应关联 package。`); return }
    assert(sale.source === 'course', 'INVALID_SALE_SOURCE', `sale ${sale.id} source 无效。`)
    if (sale.legacyRelationStatus === 'orphan') {
      assert(['missing_packageId_without_unique_package.saleId', 'package_not_found', 'multiple_course_sales_for_package'].includes(sale.legacyRelationReason), 'INVALID_LEGACY_ORPHAN', `legacy orphan sale ${sale.id} 标记无效。`)
      assert(!Array.from(packageById.values()).some(pkg => pkg.saleId === sale.id), 'INVALID_LEGACY_ORPHAN', `legacy orphan sale ${sale.id} 实际仍存在 package 反向关联。`)
      return
    }
    const pkg = packageById.get(sale.packageId)
    assert(pkg && pkg.saleId === sale.id && pkg.studentId === sale.studentId, 'SALE_PACKAGE_RELATION_INVALID', `course sale ${sale.id} 关系不完整。`)
  })
  snapshot.bookings.forEach(booking => {
    if (booking.legacyRelationStatus === 'orphan') {
      assert(booking.status === 'done' && typeof booking.legacyRelationReason === 'string' && booking.legacyRelationReason, 'INVALID_LEGACY_ORPHAN', `legacy orphan booking ${booking.id} 标记无效。`)
      return
    }
    // ⭐ 跨账预约：课时事实在**另一本账** ⇒ 本账里没有它的 package / student 是**正常形状**，不许拦。
    //    拦下来的代价不是"少显示一节课"，而是**整次回读失败 ⇒ 本机课表被永久冻结**（真机 BUG04）。
    if (sharedUsageOf(booking)) return
    const pkg = packageById.get(booking.packageId)
    assert(pkg && pkg.studentId === booking.studentId && students.has(booking.studentId), 'BOOKING_RELATION_INVALID', `booking ${booking.id} 关系无效。`)
  })
  const bookings = new Map(snapshot.bookings.map(item => [item.id, item])), incomeCounts = new Map()
  snapshot.incomes.forEach(income => {
    const booking = bookings.get(income.bookingId)
    const legacyCompatible = booking && booking.status === 'done' && booking.legacyRelationStatus === 'orphan' && (!booking.studentId || !income.studentId || booking.studentId === income.studentId)
    assert(legacyCompatible || (booking && booking.status === 'done' && booking.studentId === income.studentId), 'INCOME_RELATION_INVALID', `income ${income.id} 关系无效。`)
    incomeCounts.set(income.bookingId, (incomeCounts.get(income.bookingId) || 0) + 1)
  })
  snapshot.bookings.filter(item => item.status === 'done').forEach(booking => {
    const count = incomeCounts.get(booking.id) || 0
    if (booking.legacyRelationStatus === 'orphan') assert(count <= 1, 'INCOME_RELATION_AMBIGUOUS', `legacy orphan done booking ${booking.id} 不能关联多条 income。`)
    else assert(count === 1, 'INCOME_RELATION_AMBIGUOUS', `done booking ${booking.id} 必须唯一关联 income。`)
  })
  return { valid: true }
}

function integrity(snapshot) {
  const canonicalJson = JSON.stringify(canonicalize(snapshot))
  const packages = snapshot.students.flatMap(student => student.packages || [])
  const incomesAmount = Number(snapshot.incomes.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2))
  const salesAmount = Number(snapshot.sales.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2))
  return {
    checksum: sha256(canonicalJson), byteSize: utf8ByteLength(canonicalJson),
    summary: { students: snapshot.students.filter(item => item.status !== 'deleted').length, deletedStudents: snapshot.students.filter(item => item.status === 'deleted').length, packages: packages.length, bookings: snapshot.bookings.length, completedBookings: snapshot.bookings.filter(item => item.status === 'done').length, incomes: snapshot.incomes.length, sales: snapshot.sales.length, customExercises: snapshot.customExercises.length, incomeAmount: incomesAmount, salesAmount },
    counts: { students: snapshot.students.length, packages: packages.length, bookings: snapshot.bookings.length, incomes: snapshot.incomes.length, sales: snapshot.sales.length, customExercises: snapshot.customExercises.length },
    amounts: { incomes: incomesAmount, sales: salesAmount }, relations: validateRelations(snapshot), order: { strategy: 'sourceOrder', valid: true }
  }
}

function buildCandidateDataset(input, context) {
  assert(context && typeof context.trustedOwnerCoachId === 'string' && context.trustedOwnerCoachId, 'TRUSTED_OWNER_REQUIRED', '缺少可信 ownerCoachId。')
  assert(typeof context.trustedDatasetId === 'string' && context.trustedDatasetId, 'TRUSTED_DATASET_REQUIRED', '缺少可信 datasetId。')
  const normalizedSnapshot = normalizeSnapshot(input)
  const collections = candidateCollections(normalizedSnapshot, context.trustedOwnerCoachId, context.trustedDatasetId)
  const rebuilt = reconstructCandidate(collections)
  const expected = integrity(normalizedSnapshot), actual = integrity(rebuilt)
  assert(expected.checksum === actual.checksum && expected.byteSize === actual.byteSize && JSON.stringify(expected.summary) === JSON.stringify(actual.summary), 'ROUND_TRIP_MISMATCH', 'candidate round-trip 完整性校验失败。')
  return { schemaVersion: CANDIDATE_SCHEMA_VERSION, status: 'verified', ownerCoachId: context.trustedOwnerCoachId, datasetId: context.trustedDatasetId, collections, integrity: expected, normalizedSnapshot: clone(normalizedSnapshot), metadata: { status: 'verified', schemaVersion: CANDIDATE_SCHEMA_VERSION, checksum: expected.checksum, byteSize: expected.byteSize, summary: clone(expected.summary) } }
}

module.exports = { CANDIDATE_SCHEMA_VERSION, COLLECTIONS, DEFAULT_SETTINGS, normalizeSnapshot, analyzeLegacyCourseSales, resolveLegacyCourseSaleRelations, candidateCollections, reconstructCandidate, sharedUsageOf, validateRelations, integrity, buildCandidateDataset }
