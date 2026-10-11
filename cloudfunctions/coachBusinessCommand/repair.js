// 一次性数据修复通道 —— **独立于 22 条正式业务命令**，不经过 execute()。
//
// 为什么需要它：`handlers.js` 的 deleteStudent 在 2026-09-21 11:08 之前**不写墓碑**。
// Production 里学员 `student_aff17e8f86dd642b75d9`（胡秀明）被删除时没留墓碑，而它的
// 两条 reversed 课时包仍然引用它 —— 两个读端（云端 integrity.js / 客户端
// candidate-dataset.js）都要求 package.studentId 能在 students + student_tombstones 里
// 找到，于是**整个账号的全量读取永久失败**（ACTIVE_RELATION_INVALID）：
// readActive 失败 → 本机 revision 永远拿不到 → 所有写命令在出网之前被 REVISION_UNKNOWN
// 拒掉 → 电脑预约上不了云、手机刷不到、云端 BOOKING_TIME_CONFLICT 从未触发。
//
// 同一个事故有**两条互斥的修法**，一次只走其中一条：
//
//   ── 通道一（补 1 行墓碑）── 需要**保留**该学员历史时用：
//     · repairInspect           只读：把「准备写入的那一行 + 每个值的来源」摊开给人看
//     · repairStudentTombstone  补写一条墓碑（结构逐字段对齐 deleteStudent 的写法）
//     · repairTombstoneRollback 撤销上面**那一条**墓碑（唯一的回滚动作）
//
//   ── 通道二（清掉 4 行测试遗留）── **现行方案**：2026-09-22 用户重新判定
//      「胡秀明是测试数据，可以彻底删除，不需要保留历史」，于是不再往数据里补行，
//      而是把 4 行唯一引用它的测试遗留记录整组清掉 —— 现场自己就干净了，两个读端自然恢复。
//     · purgeTestRowsInspect    只读：摊开 4 行镜像 + 引用闭包 + 影响面
//     · purgeTestRows           删除钉死的 4 行（同事务：4 行 + revision + 回执）
//     · purgeTestRowsRollback   把模块内嵌的恢复点镜像按原 _id 插回
//       （两条通道互斥：通道二的前置之一就是「不得已存在墓碑」，见下）
//
// 通道一的硬约束（全部 fail-closed）：
//   ① 只在 student 行不存在、且确有 package 引用它时才动手；
//   ② 引用它的 package 必须全部是 reversed 且 remaining=0（活跃余额是另一类问题，交给人判断）；
//   ③ 墓碑 data 的字段集合被**白名单**钉死为 {id,name,phone,abbr,createdAt}+{status,deletedAt}，
//      客户端多送任何一个字段都会被拒 —— 不允许往业务数据里注入任意内容；
//   ④ name 必须与云端既有证据（course sale 的 note / done booking 的 studentName）一致；
//   ⑤ abbr 由 handlers.initials(name) 服务端重算；sortIndex 由 handlers.nextSortIndex 服务端推导；
//      deletedAt 由 coach_data_revisions.updatedAt 推导（= 那次删除事务的时间戳）。
//   ⑥ 绝不修改任何 package / sale / booking / income 的 used / remaining / amount / status。
const { one, put, activeContext, coachIdFor, fixedId, payloadHash, forbiddenBusinessInput, receiptKindFor } = require('./core')
const { initials, nextSortIndex } = require('./handlers')

// core 没有导出 clone（原修法是直接写 JSON.parse(JSON.stringify(data))）。通道二要把整行
// 当「只读镜像」搬运并逐字段比对，这里统一成一个深拷贝，口径与 handlers.js 的 clone 一致。
const clone = value => (value == null ? value : JSON.parse(JSON.stringify(value)))

const STUDENT_ID_PATTERN = /^student_[a-f0-9]{20}$/
const COLLECTION = Object.freeze({
  students: 'students', tombstones: 'student_tombstones', packages: 'packages',
  sales: 'sales', bookings: 'bookings', incomes: 'incomes'
})
const BASELINE_FIELDS = Object.freeze(['id', 'name', 'phone', 'abbr', 'createdAt'])
const MAX_REFERENCING = 32
const MAX_STUDENTS_SCAN = 2000
const ROLLBACK_CLOCK_TOLERANCE_MS = 5 * 60 * 1000

// ⚠️ `ok` / `code` / `message` 必须写在 **extra 之后**：本模块的调用方经常把一整个派生结果
//    （`derived` / `facts`）当 extra 传进来，而那些对象自带 `ok: true` 与 `code`。
//    旧写法 `{ ok:false, ..., ...extra }` 会被 extra 里的 `ok:true` 覆盖 ⇒ **明明是"拒绝"，
//    接口却回 `ok:true`**，调用方据此继续往下走：预演判定"不通过"却当成通过、回滚"行 id 已被
//    别人占用"却照样覆盖写入。这正是本项目反复强调的**静默故障**，这里是唯一的兜底点。
//    （对照：core.js 的 fail 是同一形状，但它的 extra 恒为 `{}`，属潜性，未改。）
const fail = (code, message, extra = {}) => ({ ...extra, ok: false, code, message })
const dataOf = row => (row && row.data && typeof row.data === 'object' && !Array.isArray(row.data)) ? row.data : {}
const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max

async function allRows(scope, collection, query, limit = 500) {
  const output = []
  for (let skip = 0; skip < limit; skip += 100) {
    const response = await scope.collection(collection).where(query).skip(skip).limit(100).get()
    const page = (response && response.data) || []
    output.push(...page)
    if (page.length < 100) return output
  }
  throw Object.assign(new Error(`集合 ${collection} 行数超过安全上限。`), { commandCode: 'REPAIR_SCAN_OVERFLOW' })
}

// 客户端送来的是「删除前那一份权威快照」（本机 rev 144 的 coachCloudActiveCache）。
// 它不是自由输入：字段集合、类型、以及 name 与云端证据的一致性都要过。
function validateBaseline(payload, studentId) {
  const baseline = payload && payload.baseline
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return fail('REPAIR_BASELINE_REQUIRED', '缺少删除前的学员基线。')
  const keys = Object.keys(baseline)
  const unknown = keys.filter(key => !BASELINE_FIELDS.includes(key))
  if (unknown.length) return fail('REPAIR_BASELINE_FIELD_UNKNOWN', `删除前基线包含不允许的字段：${unknown.join('、')}`, { unknown })
  const missing = BASELINE_FIELDS.filter(key => !Object.prototype.hasOwnProperty.call(baseline, key))
  if (missing.length) return fail('REPAIR_BASELINE_FIELD_MISSING', `删除前基线缺少字段：${missing.join('、')}`, { missing })
  if (baseline.id !== studentId) return fail('REPAIR_BASELINE_ID_MISMATCH', '删除前基线的 id 与目标学员不一致。')
  const name = typeof baseline.name === 'string' ? baseline.name.trim() : ''
  if (!isText(name, 64) || /[\u0000-\u001f\u007f]/.test(name)) return fail('REPAIR_BASELINE_NAME_INVALID', '删除前基线的姓名无效。')
  if (typeof baseline.phone !== 'string' || baseline.phone.length > 32) return fail('REPAIR_BASELINE_PHONE_INVALID', '删除前基线的手机号无效。')
  if (!Number.isInteger(baseline.createdAt) || baseline.createdAt <= 0) return fail('REPAIR_BASELINE_CREATED_AT_INVALID', '删除前基线的 createdAt 无效。')
  if (!isText(baseline.abbr, 16)) return fail('REPAIR_BASELINE_ABBR_INVALID', '删除前基线的 abbr 无效。')
  // abbr 必须与 handlers.initials(name) 一致 —— 客户端送什么都不算数，服务端重算。
  const computed = initials(name)
  if (baseline.abbr !== computed) return fail('REPAIR_ABBR_MISMATCH', '删除前基线的 abbr 与姓名不一致。', { supplied: baseline.abbr, computed })
  return { ok: true, baseline: { id: baseline.id, name, phone: baseline.phone, abbr: computed, createdAt: baseline.createdAt }, name }
}

// 云端自己的姓名证据：course sale 的 note 前缀（handlers.js:273 写的就是 `${student.name} · ...`）、
// done booking / income 的 studentName 快照。
function cloudNameEvidence(rows, studentId) {
  const candidates = []
  rows.sales.forEach(row => {
    if (String(row.studentId || '') !== studentId) return
    const data = dataOf(row)
    if (data.source !== 'course') return
    const note = typeof data.note === 'string' ? data.note : ''
    const head = note.split('·')[0].trim()
    if (head && head !== '已删学员') candidates.push({ source: 'sale.note', saleId: row.saleId || data.id || '', value: head })
  })
  rows.bookings.forEach(row => {
    if (String(row.studentId || '') !== studentId) return
    const value = String(dataOf(row).studentName || '').trim()
    if (value) candidates.push({ source: 'booking.studentName', bookingId: row.bookingId || '', value })
  })
  rows.incomes.forEach(row => {
    if (String(row.studentId || '') !== studentId) return
    const value = String(dataOf(row).studentName || '').trim()
    if (value) candidates.push({ source: 'income.studentName', incomeId: row.incomeId || '', value })
  })
  return candidates
}

function packageImage(row) {
  const data = dataOf(row)
  return {
    packageId: row.packageId || data.id || '', studentId: row.studentId || '',
    status: data.status, remaining: data.remaining, used: data.used, total: data.total,
    saleId: data.saleId || row.saleId || '', type: data.type, price: data.price,
    reversedAt: data.reversedAt, data: JSON.parse(JSON.stringify(data))
  }
}

// 全部派生都集中在这里：inspect 与 repair 走**同一条**代码路径，所以「你看到的」
// 就是「即将写入的」，不存在两份实现漂移。
async function derive(scope, ownerCoachId, context, payload) {
  const environment = context.environment, datasetId = context.datasetId
  const studentId = typeof payload.studentId === 'string' ? payload.studentId.trim() : ''
  if (!STUDENT_ID_PATTERN.test(studentId)) return fail('REPAIR_STUDENT_ID_INVALID', '目标学员 ID 形状不合法。')

  const students = await allRows(scope, COLLECTION.students, { ownerCoachId, datasetId }, MAX_STUDENTS_SCAN)
  const tombstones = await allRows(scope, COLLECTION.tombstones, { ownerCoachId, datasetId }, MAX_STUDENTS_SCAN)
  const allPackages = await allRows(scope, COLLECTION.packages, { ownerCoachId, datasetId }, MAX_STUDENTS_SCAN)
  const existingStudent = students.find(row => String(row.studentId || '') === studentId)
  const existingTombstone = tombstones.find(row => String(row.studentId || '') === studentId)
  const referencingPackages = allPackages.filter(row => String(row.studentId || '') === studentId).map(packageImage)

  const counts = {
    studentsBefore: students.length, tombstonesBefore: tombstones.length, packagesBefore: allPackages.length
  }
  const revision = context.revision
  const shared = {
    environment, datasetId, studentId, counts,
    revisionBefore: revision.dataRevision,
    referencingPackages,
    existingStudent: !!existingStudent,
    existingTombstone: !!existingTombstone,
    tombstoneRowId: fixedId(`coach-business-${COLLECTION.tombstones}`, ownerCoachId, `${datasetId}:${studentId}`)
  }

  // 墓碑已经在了 ⇒ 直接幂等返回。**这一步在基线校验之前**，于是「补完再点一次」
  // 不会因为本机缓存已经被成功回读覆盖（学员从快照里消失）而失败。
  if (existingTombstone) {
    const data = dataOf(existingTombstone)
    const matches = data.id === studentId && data.status === 'deleted'
    return { ok: true, alreadyRepaired: true, tombstone: { studentId: existingTombstone.studentId || '', sortIndex: existingTombstone.sortIndex, data }, ...shared, matches }
  }
  const checked = validateBaseline(payload, studentId)
  if (!checked.ok) return checked
  // 期望的形态只有一种：**学员行不存在 + 没有墓碑 + 确实有课时包引用它**。
  // 任何偏离都 fail-closed，交给人判断。
  if (existingStudent) return fail('REPAIR_STUDENT_STILL_EXISTS', '该学员仍然存在，不属于「缺墓碑」场景。', shared)
  if (!referencingPackages.length) return fail('REPAIR_NOT_ORPHANED', '没有任何课时包引用该学员；不需要补墓碑。', shared)
  if (referencingPackages.length > MAX_REFERENCING) return fail('REPAIR_REFERENCE_TOO_MANY', '引用的课时包数量超出安全上限。', shared)
  const notReversed = referencingPackages.filter(item => item.status !== 'reversed' || Number(item.remaining) !== 0)
  if (notReversed.length) {
    return fail('REPAIR_REFERENCE_NOT_REVERSED', '该学员名下仍有未冲正/仍有余额的课时包 —— 这是另一类问题，需要人工判断，本工具拒绝继续。', { ...shared, notReversed: notReversed.map(item => ({ packageId: item.packageId, status: item.status, remaining: item.remaining })) })
  }

  const salesRows = await allRows(scope, COLLECTION.sales, { ownerCoachId, datasetId, studentId }, 200)
  const bookingRows = await allRows(scope, COLLECTION.bookings, { ownerCoachId, datasetId, studentId }, 200)
  const incomeRows = await allRows(scope, COLLECTION.incomes, { ownerCoachId, datasetId, studentId }, 200)
  const evidence = cloudNameEvidence({ sales: salesRows, bookings: bookingRows, incomes: incomeRows }, studentId)
  const distinct = [...new Set(evidence.map(item => item.value))]
  if (distinct.length > 1) return fail('REPAIR_NAME_EVIDENCE_AMBIGUOUS', '云端存在互相冲突的姓名证据，请人工确认。', { ...shared, evidence })
  const cloudName = distinct[0] || ''
  if (cloudName && cloudName !== checked.name) {
    return fail('REPAIR_EVIDENCE_NAME_MISMATCH', '删除前基线的姓名与云端既有证据不一致 —— 拒绝写入。', { supplied: checked.name, cloudName, evidence })
  }

  const sortIndex = nextSortIndex(students)
  const maxReversedAt = referencingPackages.reduce((max, item) => Math.max(max, Number(item.reversedAt) || 0), 0)
  const deletedAt = Number(revision.updatedAt)
  if (!Number.isFinite(deletedAt) || deletedAt <= 0) return fail('REPAIR_DELETED_AT_UNKNOWN', '无法从 coach_data_revisions.updatedAt 取得删除时间。', shared)
  if (maxReversedAt && deletedAt <= maxReversedAt) return fail('REPAIR_DELETED_AT_BEFORE_REVERSAL', '删除时间早于课时包冲正时间，与预期不符。', { ...shared, deletedAt, maxReversedAt })
  if (deletedAt > Date.now() + ROLLBACK_CLOCK_TOLERANCE_MS) return fail('REPAIR_DELETED_AT_IN_FUTURE', '删除时间在未来，与预期不符。', { ...shared, deletedAt })

  // 与 handlers.js deleteStudent 的写法逐字段对齐：
  //   writableRow(studentRow, { studentId, data: { ...student, status:'deleted', deletedAt } })
  // studentRow 原本就是 { studentId, sortIndex, data }（见 createStudent），
  // writableRow 会剥掉 _id/ownerCoachId/datasetId，再由 set() 补回 ownerCoachId/datasetId。
  const data = { ...checked.baseline, status: 'deleted', deletedAt }
  return {
    ok: true, ...shared,
    sortIndex, deletedAt, data,
    tombstone: { studentId, sortIndex, data },
    evidence: {
      name: checked.name, nameSource: cloudName ? '云端 course sale note / done booking studentName（与删除前基线一致）' : '删除前基线（本机 rev 快照，云端无独立证据）',
      abbr: checked.baseline.abbr, abbrSource: 'handlers.initials(name) 服务端重算',
      phone: checked.baseline.phone, phoneSource: '删除前基线（本机 rev 快照）',
      createdAt: checked.baseline.createdAt, createdAtSource: '删除前基线（本机 rev 快照）',
      sortIndexSource: 'handlers.nextSortIndex(students)',
      deletedAtSource: 'coach_data_revisions.updatedAt',
      cloudNameEvidence: evidence, baselineKeys: Object.keys(checked.baseline).sort()
    }
  }
}

function receiptIdFor(ownerCoachId, environment, datasetId, requestId) {
  return fixedId(receiptKindFor(environment), ownerCoachId, `${datasetId}:${requestId}`)
}

async function withContext(db, ownerCoachId, environment, work) {
  try {
    return await db.runTransaction(async tx => {
      const context = await activeContext(tx, ownerCoachId, environment)
      return work(tx, context)
    })
  } catch (error) {
    return fail(error.commandCode || 'REPAIR_TRANSACTION_FAILED', error.message || '修复事务失败。')
  }
}

async function inspect(db, ownerCoachId, environment, payload) {
  return withContext(db, ownerCoachId, environment, (tx, context) => derive(tx, ownerCoachId, context, payload))
}

async function repair(db, ownerCoachId, environment, payload) {
  return withContext(db, ownerCoachId, environment, async (tx, context) => {
    if (payload.expectedRevision != null && Number(payload.expectedRevision) !== context.revision.dataRevision) {
      return fail('REVISION_CONFLICT', '云端数据已被其他请求更新。', { currentRevision: context.revision.dataRevision, expectedRevision: Number(payload.expectedRevision) })
    }
    const derived = await derive(tx, ownerCoachId, context, payload)
    if (!derived.ok) return derived
    const studentId = derived.studentId
    const requestId = `repair_tombstone_${studentId}`
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(requestId)) return fail('REPAIR_REQUEST_ID_INVALID', '内部 requestId 不合法。')
    if (derived.alreadyRepaired) {
      if (!derived.matches) return fail('REPAIR_EXISTING_TOMBSTONE_UNEXPECTED', '已存在同 id 的墓碑，但内容不符合预期，请人工确认。', derived)
      return { ok: true, alreadyRepaired: true, idempotent: true, requestId, ...derived, repaired: false, revisionAfter: context.revision.dataRevision }
    }
    const now = Date.now(), environment2 = context.environment, datasetId = context.datasetId
    const receiptId = receiptIdFor(ownerCoachId, environment2, datasetId, requestId)
    const fingerprint = payloadHash({ command: 'repairStudentTombstone', payload: { studentId } })
    const receipt = await one(tx, context.meta.receipts, { _id: receiptId, ownerCoachId, datasetId, requestId })
    if (receipt) {
      if (receipt.status === 'succeeded') return { ok: true, alreadyRepaired: true, idempotent: true, requestId, ...derived, repaired: false, revisionAfter: receipt.revisionAfter }
      return fail('REQUEST_PROCESSING', '同一次修复请求正在处理中。', { requestId })
    }
    await put(tx, context.meta.receipts, receiptId, {
      ownerCoachId, datasetId, environment: environment2, requestId, command: 'repairStudentTombstone',
      payloadHash: fingerprint, status: 'processing', revisionBefore: context.revision.dataRevision, createdAt: now
    })
    // ★ 唯一的写入：一条墓碑。用与 scopedBusiness.set 完全相同的行 id。
    await put(tx, COLLECTION.tombstones, derived.tombstoneRowId, {
      studentId, sortIndex: derived.sortIndex, data: derived.data, ownerCoachId, datasetId
    })
    const nextRevision = context.revision.dataRevision + 1
    await put(tx, context.meta.revisions, context.revisionId, { ...context.revision, ownerCoachId, datasetId, environment: environment2, dataRevision: nextRevision, updatedAt: now })
    const response = {
      ok: true, repaired: true, alreadyRepaired: false, idempotent: false, requestId,
      environment: environment2, datasetId, studentId,
      revisionBefore: context.revision.dataRevision, revisionAfter: nextRevision,
      tombstoneRowId: derived.tombstoneRowId, tombstone: derived.tombstone,
      sortIndex: derived.sortIndex, deletedAt: derived.deletedAt, data: derived.data,
      evidence: derived.evidence, referencingPackages: derived.referencingPackages,
      counts: { ...derived.counts, tombstonesAfter: derived.counts.tombstonesBefore + 1 }
    }
    await put(tx, context.meta.receipts, receiptId, {
      ownerCoachId, datasetId, environment: environment2, requestId, command: 'repairStudentTombstone',
      payloadHash: fingerprint, status: 'succeeded', revisionBefore: context.revision.dataRevision,
      revisionAfter: nextRevision, response, completedAt: now
    })
    return response
  })
}

async function rollback(db, ownerCoachId, environment, payload) {
  return withContext(db, ownerCoachId, environment, async (tx, context) => {
    const studentId = typeof payload.studentId === 'string' ? payload.studentId.trim() : ''
    if (!STUDENT_ID_PATTERN.test(studentId)) return fail('REPAIR_STUDENT_ID_INVALID', '目标学员 ID 形状不合法。')
    if (!Number.isFinite(Number(payload.deletedAt)) || Number(payload.deletedAt) <= 0) return fail('REPAIR_ROLLBACK_TARGET_REQUIRED', '撤销必须带上被写入墓碑的 deletedAt，避免误删合法墓碑。')
    const ownerCoachId2 = ownerCoachId, datasetId = context.datasetId, environment2 = context.environment
    const rowId = fixedId(`coach-business-${COLLECTION.tombstones}`, ownerCoachId2, `${datasetId}:${studentId}`)
    const row = await one(tx, COLLECTION.tombstones, { _id: rowId, ownerCoachId: ownerCoachId2, datasetId })
    if (!row) return { ok: true, rolledBack: false, alreadyAbsent: true, studentId, datasetId, revisionAfter: context.revision.dataRevision }
    const data = dataOf(row)
    if (data.id !== studentId || data.status !== 'deleted' || Number(data.deletedAt) !== Number(payload.deletedAt)) {
      return fail('REPAIR_ROLLBACK_TARGET_MISMATCH', '墓碑内容与撤销目标不一致，拒绝删除。', { studentId, tombstoneData: data })
    }
    const requestId = `repair_rollback_${studentId}`
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(requestId)) return fail('REPAIR_REQUEST_ID_INVALID', '内部 requestId 不合法。')
    const now = Date.now()
    await tx.collection(COLLECTION.tombstones).doc(rowId).remove()
    const nextRevision = context.revision.dataRevision + 1
    await put(tx, context.meta.revisions, context.revisionId, { ...context.revision, ownerCoachId: ownerCoachId2, datasetId, environment: environment2, dataRevision: nextRevision, updatedAt: now })
    const receiptId = receiptIdFor(ownerCoachId2, environment2, datasetId, requestId)
    const response = { ok: true, rolledBack: true, alreadyAbsent: false, requestId, studentId, datasetId, revisionBefore: context.revision.dataRevision, revisionAfter: nextRevision, removedTombstoneRowId: rowId }
    await put(tx, context.meta.receipts, receiptId, {
      ownerCoachId: ownerCoachId2, datasetId, environment: environment2, requestId, command: 'repairTombstoneRollback',
      payloadHash: payloadHash({ command: 'repairTombstoneRollback', payload: { studentId, deletedAt: Number(payload.deletedAt) } }),
      status: 'succeeded', revisionBefore: context.revision.dataRevision, revisionAfter: nextRevision, response, completedAt: now
    })
    return response
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// 通道二：一次性测试数据清除（胡秀明 4 行）—— 取代「补 1 行墓碑」
// ═══════════════════════════════════════════════════════════════════════════
// 用户 2026-09-22 重新判定：`student_aff17e8f86dd642b75d9`（胡秀明）是**测试数据**，可以彻底
// 删除、不需要保留他的历史。于是通道一（补墓碑）被这条更干净的方案取代：把这 4 行**唯一
// 引用它**的测试遗留记录整组清掉。现场自己就干净了，两个读端自然恢复，而且**不往生产数据
// 里新增任何一行**。
//
// 为什么不能复用 22 条正式命令（一条都做不到）：
//   · deletePackage     → 明确拒绝有销售关联的包（PACKAGE_HAS_SALE，handlers.js:188）
//   · reverseCourseSale → 对已 reversed 的销售直接拒（SALE_ALREADY_REVERSED，:295）
//   · 没有任何命令可以删 sales
//   · deleteStudent     → 要求学员行存在（它早已不在名册里）
//
// 这条路**没有通用删除接口**：目标是模块内钉死的 4 行，调用方连「删什么」都提交不了 ——
// 允许提交的只有 `expectedRevision`（可选）；集合名 / 行 _id / 查询条件 / 其它任何字段
// 一律被 purgeInputGuard 拒掉。
//
// 四道锁（全部在同一个事务里**重新求值**，任何一条不符即 fail-closed）：
//   ① 白名单自证：4 个字面 _id 必须等于
//      fixedId('coach-business-<集合>', 审计 owner, `<审计 datasetId>:<业务id>`)
//      ⇒ 证明白名单没抄错、且它只属于那一代数据。这一步只用模块内常量，不采信调用方身份；
//   ② 数据代次硬闸：本次调用的 datasetId 必须**就是**审计过的那个代次
//      ⇒ 换代次以后即使业务 id 一模一样也一律拒绝。
//      （调用方身份另有一层天然保护：4 个行 id 是 owner 参与的 hash，且行查询按调用者自己的
//        ownerCoachId 过滤 ⇒ 别人的账号底下这 4 个 _id 根本不存在，只会走到「4 行都不在」。）
//   ③ 行内容逐字段等于恢复点镜像（2026-09-22 15:54:46 / rev 145 只读转储；总量 292,374 字节，
//      checksum 515b7e0d…）
//      ⇒ 只删**被审计过的那一份字节**；任何字段被改过就拒绝；
//   ④ 引用闭包：8 个业务集合逐行重扫，除这 4 行外**不允许任何其它行**引用该学员
//      ⇒ 挡住「审计之后又有人给他建了课 / 写了收入」这类改变现场的事。
// 另有两条前置，同样 fail-closed：
//   · 学员不得还在名册里（在册 = 真人，一律拒绝删除）；
//   · 不得已存在该学员的墓碑（说明事故已被通道一处理；两条通道互斥）。
const PURGE_ROW_COUNT = 4
const PURGE_COLLECTIONS = Object.freeze(['packages', 'sales'])
// 逐行重扫的口径与「只读恢复点」的 8 个集合完全一致（顺序也一致，便于和转储逐段对账）。
const PURGE_SCAN = Object.freeze(['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises'])
// 输入闸分两类关注点：①页面契约字段 ②平台注入字段 ③（在 purgeInputGuard 里）高危名字黑名单。
// ⚠️ 平台注入：微信会把调用方控制不了的字段塞进 event —— `userInfo`（openId/appId）是官方文档写明的；
//    `tcbContext` 是 2026-09-22 在开发者工具 Stable 2.02.2608060 模拟器实测被注入的（tcb = Tencent
//    CloudBase；本项目代码全文不含这个词，正式 22 条命令走 core.js 的黑名单，所以从未拦到过它 ——
//    第一次暴露它的是这道白名单，预演如实回 `PURGE_FIELD_UNKNOWN`，一个字没写）。
//    ⚠️⚠️ 2026-09-22 19:24 的真实预演把这里写成过 `tbdContext`（**手抄错一个字母**）⇒ 白名单等于没加，
//    云上 v2 一字不差地又拒了一次，白跑一轮"部署 → 预演"。**教训：字段名一律从原文复制，不许手打。**
//    实测原文（模拟器 Storage 的 `coachRepairPurge:production` 记录，19:24:46 那次）：
//    "清除通道不接受这些字段：tcbContext" —— 且**只列出了这一个**，说明 event 的完整键集
//    ⊆ {action, environment, userInfo, tcbContext}，没有第三个注入键。
const PLATFORM_INJECTED_EVENT_FIELDS = Object.freeze(['userInfo', 'tcbContext'])
const PURGE_INPUT_FIELDS = Object.freeze(['action', 'environment', 'studentId', 'expectedRevision'])
// 「目标载体」名字黑名单：任何能表达「删哪个集合 / 哪几行 / 什么条件 / 哪个数据集」的名字，命中即硬拒。
// 这是本闸门**真正的保护面**（客户端不许指定"删什么"）。
const PURGE_TARGET_CARRIER_FIELDS = Object.freeze([
  'collection', 'collections', 'dataset', 'datasetid',
  'row', 'rows', 'rowid', 'rowids', 'id', 'ids', '_id', 'doc', 'docs', 'document', 'documents',
  'where', 'filter', 'filters', 'query', 'condition', 'conditions', 'match',
  'target', 'targets', 'businessid', 'businessids', 'student', 'students',
  'select', 'field', 'fields', 'key', 'keys'
])

const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.keys(value).forEach(key => deepFreeze(value[key])); Object.freeze(value) }
  return value
}

// ⚠️ 这 4 行的 `body` 是**原始行的逐字节镜像**（不含 _id / ownerCoachId / datasetId ——
//    归属字段由服务端现算，绝不采信常量里的值）。来源：2026-09-22 15:54:46 的只读转储。
//    不要"顺手修一下"这里的任何字段：它们同时是校验基准和回滚源。
const PURGE = deepFreeze({
  studentId: 'student_aff17e8f86dd642b75d9',
  label: '胡秀明',
  // ⚠️ 这两个是**审计锚**，不是"顺便记一下"：4 个行 _id 就是拿它们 + 业务 id 现算出来的。
  //    ownerCoachId 取自恢复点行自身的 ownerCoachId 字段（= sha256('coach:'+真实 openid).slice(0,32)）；
  //    datasetId 取自恢复点行的 datasetId。任何一条对不上 ⇒ PURGE_WHITELIST_INVALID，一行都不会删。
  ownerCoachId: '9fd6a9a0594da9a9337d923f39ad1b3b',
  datasetId: 'candidate_f971f032ca88dc3a2b656a6654d9a314',
  capturedAtText: '2026-09-22 15:54:46（北京时）',
  capturedRevision: 145,
  capturedChecksum: '515b7e0d802a88be8809fd41c84261c89bb0e156c14f41fa413d65d806b872d1',
  rows: [
    {
      collection: 'packages',
      _id: '0be4b6ce94778d1d323d9dd1e98654f0',
      businessId: 'package_b65ca3885f8275cd8522',
      body: {
        packageId: 'package_b65ca3885f8275cd8522',
        studentId: 'student_aff17e8f86dd642b75d9',
        saleId: 'sale_5a0fd8d0ada348f647f2',
        studentSortIndex: 36,
        sortIndex: 1,
        data: {
          id: 'package_b65ca3885f8275cd8522', type: '常规训练', total: 20, used: 0, remaining: 0,
          price: 300, status: 'reversed', createdAt: 1789827724553, saleDate: '2026-09-19',
          saleId: 'sale_5a0fd8d0ada348f647f2', reversedAt: 1789910559110
        }
      }
    },
    {
      collection: 'packages',
      _id: '32ee907a44e29d0a91436061fb69f509',
      businessId: 'package_1f8bf80bb35e9ba14973',
      body: {
        packageId: 'package_1f8bf80bb35e9ba14973',
        studentId: 'student_aff17e8f86dd642b75d9',
        saleId: 'sale_7d07b388a1f76c973d13',
        studentSortIndex: 36,
        sortIndex: 0,
        data: {
          id: 'package_1f8bf80bb35e9ba14973', type: '常规训练', total: 20, used: 0, remaining: 0,
          price: 300, status: 'reversed', createdAt: 1789827678578, saleDate: '2026-09-19',
          saleId: 'sale_7d07b388a1f76c973d13', reversedAt: 1789910569191
        }
      }
    },
    {
      collection: 'sales',
      _id: '6d96ef507157a273e2a76fc4a8eafed4',
      businessId: 'sale_7d07b388a1f76c973d13',
      body: {
        saleId: 'sale_7d07b388a1f76c973d13',
        studentId: 'student_aff17e8f86dd642b75d9',
        packageId: 'package_1f8bf80bb35e9ba14973',
        sortIndex: 47,
        data: {
          id: 'sale_7d07b388a1f76c973d13', source: 'course', status: 'reversed',
          studentId: 'student_aff17e8f86dd642b75d9', packageId: 'package_1f8bf80bb35e9ba14973',
          typeName: '常规训练', quantity: 20, unitPrice: 300, amount: 5800, date: '2026-09-19',
          note: '胡秀明 · 常规训练 20节', createdAt: 1789827678578, reversedAt: 1789910569191
        }
      }
    },
    {
      collection: 'sales',
      _id: '7ed26de3385df8a49791c2d2f21585df',
      businessId: 'sale_5a0fd8d0ada348f647f2',
      body: {
        saleId: 'sale_5a0fd8d0ada348f647f2',
        studentId: 'student_aff17e8f86dd642b75d9',
        packageId: 'package_b65ca3885f8275cd8522',
        sortIndex: 48,
        data: {
          id: 'sale_5a0fd8d0ada348f647f2', source: 'course', status: 'reversed',
          studentId: 'student_aff17e8f86dd642b75d9', packageId: 'package_b65ca3885f8275cd8522',
          typeName: '常规训练', quantity: 20, unitPrice: 300, amount: 5800, date: '2026-09-19',
          note: '胡秀明 · 常规训练 20节', createdAt: 1789827724553, reversedAt: 1789910559110
        }
      }
    }
  ]
})

// 行镜像的规范哈希：借用 core 的 canonical（`payloadHash` 内部就是 sha256(canonical(...))），
// 于是这里**不存在第二份 canonical 实现**，不会出现两边规则漂移。
const imageHash = value => payloadHash({ command: 'purge-row-image', payload: value })
const purgeKeyOf = (collection, rowId) => `${collection}:${rowId}`
const amountOf = row => Number((dataOf(row).amount) || 0) || 0

// 白名单 × 审计时的 owner + 数据代次 ⇒ 目标列表。**纯函数、无参数**，可离线断言：
//   · `rowId` 就是审计过的那个字面 _id —— 运行时定位行的唯一依据；
//   · `auditRowId` 是按「审计时的 owner + 代次 + 业务 id」现算出来的规范行 id，必须与 rowId 逐字相等。
// 0 参数是刻意的：目标**不接受任何调用方输入**，连 owner / 数据集都不参与推导。
function purgeTargetsOf() {
  return PURGE.rows.map(row => ({
    collection: row.collection,
    businessId: row.businessId,
    rowId: row._id,
    auditRowId: fixedId(`coach-business-${row.collection}`, PURGE.ownerCoachId, `${PURGE.datasetId}:${row.businessId}`),
    body: clone(row.body),
    bodyHash: imageHash(row.body)
  }))
}

// 未知字段的形状摘录：只记**定性所需的最少信息**（类型 / 顶层键名 / 截断预览），
// 不整值回显 —— 拒绝响应里不该搬运一整份未知内容。
function unknownFieldShape(name, value) {
  const preview = (() => {
    try { const text = JSON.stringify(value); return text == null ? String(value) : (text.length > 200 ? text.slice(0, 200) + `…(${text.length}字)` : text) } catch (error) { return '<不可序列化>' }
  })()
  const shape = { field: name, type: Array.isArray(value) ? 'array' : typeof value }
  if (value && typeof value === 'object') shape.keys = Object.keys(value).slice(0, 12)
  shape.preview = preview
  return shape
}

// 客户端输入闸：本通道**不接受**「删什么」。
//   硬拒 = 名字命中 PURGE_TARGET_CARRIER_FIELDS（集合名 / 行 id / 条件 / 数据集 —— 见该常量注释）。
//   其余未知字段（典型：平台新注入的上下文对象）→ **放行，但必须回显**（purgeIgnoredFieldsOf）。
//   为什么不是"未列举一律拒"：`PURGE` 是编译期常量，清除路径只读 event 的 3 个字段
//   （studentId / expectedRevision / environment），**其余字段在结构上惰性** —— 既改变不了"删什么"，
//   也改变不了"删几行"。一律拒防不住删错（删什么本来就不看 event），却会因平台多注入一个字段
//   就让整条通道卡死，逼出"部署 → 预演 → 再部署"的死循环（2026-09-22 真的白跑过一轮）。
//   放行 ≠ 静默：ignoredFields 会出现在预演/提交响应里（形状摘录）。
function purgeInputGuard(event) {
  if (event.studentId != null && String(event.studentId) !== PURGE.studentId) {
    return fail('PURGE_TARGET_IMMUTABLE', '清除目标写死在通道内，不接受客户端指定目标。', { supplied: String(event.studentId) })
  }
  const carrier = purgeExtraEventKeys(event).filter(key => PURGE_TARGET_CARRIER_FIELDS.includes(String(key).toLowerCase()))
  if (carrier.length) {
    return fail('PURGE_FIELD_UNKNOWN', `清除通道不接受这些字段：${carrier.join('、')}`, { unknown: carrier, unknownShapes: carrier.map(name => unknownFieldShape(name, event[name])) })
  }
  return null
}

// 契约字段与平台字段之外的一切键（= 惰性未知字段）。判定只写这一处，闸门与回显共用同一份口径。
function purgeExtraEventKeys(event) {
  return Object.keys(event).filter(key => !PURGE_INPUT_FIELDS.includes(key) && !PLATFORM_INJECTED_EVENT_FIELDS.includes(key))
}

// 惰性未知字段的摘录：**只要名字 / 类型 / 对象的顶层键名 —— 不带 preview、不带值**。
// 被硬拒的字段才给形状摘录（那是"我方契约被人动了"的信号，要看清）；放行的平台字段只登记名字就够了，
// 没必要把它的内容搬进响应、页面与 Storage（与本通道"值一律不读"同一条纪律）。
function purgeIgnoredFieldsOf(event) {
  return purgeExtraEventKeys(event).map(name => {
    const value = event[name]
    const shape = { field: name, type: Array.isArray(value) ? 'array' : typeof value }
    if (value && typeof value === 'object') shape.keys = Object.keys(value).slice(0, 12)
    return shape
  })
}

// 8 个集合逐行重扫：一次读全，后面所有事实（学员状态 / 4 行镜像 / 引用闭包 / 影响面）都从
// 这份结果里取 —— 不存在"读了两遍、两遍不一致"的可能。
async function purgeScan(scope, ownerCoachId, datasetId) {
  const tokens = [PURGE.studentId, ...PURGE.rows.map(row => row.businessId)]
  const collections = {}, counts = {}, hits = []
  for (const name of PURGE_SCAN) {
    const rows = await allRows(scope, name, { ownerCoachId, datasetId }, MAX_STUDENTS_SCAN)
    collections[name] = rows
    counts[name] = rows.length
    rows.forEach(row => {
      const line = JSON.stringify(row)
      const matched = tokens.filter(token => line.indexOf(token) >= 0)
      if (matched.length) hits.push({ collection: name, rowId: String((row && row._id) || ''), matched })
    })
  }
  return { collections, counts, hits }
}

// 事实采集（**不做该不该动手的裁决**，裁决分给两个调用方 —— 清除与回滚的判据不同）。
async function purgeFacts(scope, ownerCoachId, context) {
  const datasetId = context.datasetId
  // ⓪ 模块不变式：白名单必须仍然是审计过的那 4 行。
  if (PURGE.rows.length !== PURGE_ROW_COUNT || !PURGE.rows.every(row => PURGE_COLLECTIONS.includes(row.collection))) {
    return fail('PURGE_WHITELIST_INVALID', '白名单不再是审计过的那 4 行 —— 拒绝继续。', { count: PURGE.rows.length, collections: PURGE.rows.map(row => row.collection) })
  }
  const targets = purgeTargetsOf()
  // ① 白名单自证：4 个字面 _id 必须等于「审计时的 owner + 数据代次 + 业务 id」现算出的规范行 id。
  //    这一步**只用模块内常量、完全不采信调用方身份** —— 它证明的是「白名单没抄错、且只属于那一代数据」。
  const unproven = targets.filter(target => target.auditRowId !== target.rowId)
  if (unproven.length) {
    return fail('PURGE_WHITELIST_INVALID', '白名单字面 _id 与「审计 owner + 审计代次」推导出的规范行 id 不一致 —— 拒绝继续。', {
      unproven: unproven.map(target => ({ collection: target.collection, businessId: target.businessId, rowId: target.rowId, auditRowId: target.auditRowId }))
    })
  }
  // ② 数据代次硬闸：只对审计过的那一代生效（换了代次，即使业务 id 一模一样也一律拒绝）。
  //    调用方身份另有一层天然保护：这 4 个行 id 是 owner 参与的 hash，且行查询按**调用者自己的
  //    ownerCoachId** 过滤 ⇒ 别人的账号底下这 4 个 _id 根本不存在，只会走到「4 行都不在」。
  if (datasetId !== PURGE.datasetId) {
    return fail('PURGE_DATASET_MISMATCH', '当前云端数据代次不是审计过的那一代 —— 拒绝继续。', { datasetId, auditedDatasetId: PURGE.datasetId })
  }
  const scan = await purgeScan(scope, ownerCoachId, datasetId)
  const shared = {
    environment: context.environment, datasetId, studentId: PURGE.studentId, label: PURGE.label,
    capturedAtText: PURGE.capturedAtText, capturedRevision: PURGE.capturedRevision,
    revisionBefore: context.revision.dataRevision,
    countsBefore: { ...scan.counts },
    referenceHits: scan.hits.length,
    referenceClosure: scan.hits.reduce((acc, hit) => { acc[hit.collection] = (acc[hit.collection] || 0) + 1; return acc }, {}),
    targets: targets.map(target => ({ collection: target.collection, businessId: target.businessId, rowId: target.rowId, auditRowId: target.auditRowId, bodyHash: target.bodyHash }))
  }
  // ② 学员前置。
  const studentRow = (scan.collections.students || []).find(row => String((row && row.studentId) || '') === PURGE.studentId)
  if (studentRow) return fail('PURGE_STUDENT_ALIVE', '该学员仍在名册里 —— 属于在册学员，本通道拒绝清除。', { ...shared, studentsOnRoster: scan.counts.students })
  const tombstoneRow = (scan.collections.student_tombstones || []).find(row => String((row && row.studentId) || '') === PURGE.studentId)
  if (tombstoneRow) return fail('PURGE_TOMBSTONE_PRESENT', '云端已存在该学员的墓碑 —— 事故已被通道一处理，两条通道互斥，拒绝继续。', shared)
  // ③ 逐行取回 + 镜像逐字段比对（✓ 幂等：4 行都没了也算一种合法事实，交由调用方裁决）。
  const byKey = new Map()
  ;['packages', 'sales'].forEach(name => (scan.collections[name] || []).forEach(row => byKey.set(purgeKeyOf(name, String((row && row._id) || '')), row)))
  const rows = targets.map(target => {
    const row = byKey.get(purgeKeyOf(target.collection, target.rowId)) || null
    if (!row) return { target, present: false, matches: false, image: null, rowOwner: '' }
    const image = clone(row)
    delete image._id; delete image.ownerCoachId; delete image.datasetId
    const rowOwner = String(image.studentId || (image.data && image.data.studentId) || '')
    return { target, present: true, matches: rowOwner === PURGE.studentId && imageHash(image) === target.bodyHash, image, rowOwner }
  })
  const facts = { ...shared, rows }
  // ④ 引用闭包：除白名单 4 行外，不允许任何其它行引用该学员 / 其课时包 / 其销售。
  const allowed = new Set(PURGE.rows.map(row => purgeKeyOf(row.collection, row._id)))
  const unexpected = scan.hits.filter(hit => !allowed.has(purgeKeyOf(hit.collection, hit.rowId)))
  if (unexpected.length) {
    return fail('PURGE_UNEXPECTED_REFERENCE', '除白名单 4 行外还有别的行引用该学员 —— 现场已经变了，拒绝继续。', { ...facts, unexpectedReferences: unexpected })
  }
  // 影响面（把人要判断的数字直接算好）。
  const removedSales = rows.filter(item => item.present && item.target.collection === 'sales').map(item => item.image)
  const removedPackages = rows.filter(item => item.present && item.target.collection === 'packages')
  const sumOf = (list, pick) => Number(list.reduce((sum, item) => sum + pick(item), 0).toFixed(2))
  const salesRows = scan.collections.sales || []
  const incomeRows = scan.collections.incomes || []
  const activeSales = list => list.filter(row => dataOf(row).status !== 'reversed')
  facts.alreadyPurged = rows.every(item => !item.present)
  facts.impact = {
    countsBefore: { ...scan.counts },
    countsAfter: {
      ...scan.counts,
      packages: scan.counts.packages - removedPackages.length,
      sales: scan.counts.sales - removedSales.length
    },
    salesCountBefore: salesRows.length, salesCountAfter: salesRows.length - removedSales.length,
    salesAmountBefore: sumOf(salesRows, amountOf), salesAmountAfter: sumOf(salesRows, amountOf) - sumOf(removedSales, amountOf),
    // 业绩口径（stats.js 只统计 status !== "reversed"）—— 这两条早就冲正了，所以它**必须一分不变**。
    activeSalesCountBefore: activeSales(salesRows).length, activeSalesCountAfter: activeSales(salesRows).length,
    activeSalesAmountBefore: sumOf(activeSales(salesRows), amountOf),
    activeSalesAmountAfter: sumOf(activeSales(salesRows), amountOf) - sumOf(activeSales(removedSales), amountOf),
    incomeCountBefore: incomeRows.length, incomeCountAfter: incomeRows.length,
    incomeAmountBefore: sumOf(incomeRows, amountOf), incomeAmountAfter: sumOf(incomeRows, amountOf),
    // 事故的量化指标：课时包引用了名册里找不到的学员 = 悬空引用。
    orphanReferencesBefore: (scan.collections.packages || []).filter(row => String((row && row.studentId) || '') === PURGE.studentId).length
  }
  facts.impact.orphanReferencesAfter = facts.alreadyPurged ? 0 : 0
  return { ok: true, ...facts }
}

// 裁决（只用于清除/预演）：4 行必须齐、且逐字节等于镜像。
function purgeVerdict(derived) {
  const mismatched = derived.rows.filter(item => item.present && !item.matches)
  if (mismatched.length) {
    return fail('PURGE_ROW_MISMATCH', '云端行内容与恢复点镜像不一致 —— 只删被审计过的字节，拒绝继续。', {
      ...derived,
      mismatched: mismatched.map(item => ({ collection: item.target.collection, businessId: item.target.businessId, rowId: item.target.rowId, rowOwner: item.rowOwner, expectedHash: item.target.bodyHash, actualHash: item.image ? imageHash(item.image) : null, actual: item.image }))
    })
  }
  const present = derived.rows.filter(item => item.present).length
  if (present !== 0 && present !== PURGE_ROW_COUNT) {
    return fail('PURGE_PARTIAL_STATE', '白名单 4 行只存在一部分 —— 这个状态无法解释，交给人判断，拒绝继续。', derived)
  }
  return { ok: true, ...derived, presentRows: present }
}

async function derivePurge(scope, ownerCoachId, context) {
  const facts = await purgeFacts(scope, ownerCoachId, context)
  if (!facts.ok) return facts
  return purgeVerdict(facts)
}

async function purgeInspect(db, ownerCoachId, environment, event) {
  const guard = purgeInputGuard(event)
  if (guard) return guard
  // 回显惰性未知字段：放行但**不静默** —— 平台哪天再注入新字段，预演响应里就看得见名字与形状。
  const ignoredFields = purgeIgnoredFieldsOf(event)
  const derived = await withContext(db, ownerCoachId, environment, (tx, context) => derivePurge(tx, ownerCoachId, context))
  return derived && typeof derived === 'object' ? { ...derived, ignoredFields } : derived
}

async function purgeCommit(db, ownerCoachId, environment, event) {
  const guard = purgeInputGuard(event)
  if (guard) return guard
  return withContext(db, ownerCoachId, environment, async (tx, context) => {
    if (event.expectedRevision != null && Number(event.expectedRevision) !== context.revision.dataRevision) {
      return fail('REVISION_CONFLICT', '云端数据已被其他请求更新。', { currentRevision: context.revision.dataRevision, expectedRevision: Number(event.expectedRevision) })
    }
    const derived = await derivePurge(tx, ownerCoachId, context)
    if (!derived.ok) return derived
    const requestId = `purge_test_rows_${derived.studentId}`
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(requestId)) return fail('PURGE_REQUEST_ID_INVALID', '内部 requestId 不合法。')
    const datasetId = context.datasetId, environment2 = context.environment
    const receiptId = receiptIdFor(ownerCoachId, environment2, datasetId, requestId)
    const receipt = await one(tx, context.meta.receipts, { _id: receiptId, ownerCoachId, datasetId, requestId })
    if (receipt) {
      if (receipt.status === 'succeeded') return { ok: true, purged: false, alreadyPurged: true, idempotent: true, requestId, ...derived, revisionAfter: receipt.revisionAfter }
      return fail('REQUEST_PROCESSING', '同一次清除请求正在处理中。', { requestId })
    }
    // 4 行都不在了、却没有本通道的回执 ⇒ 它们是被别的东西删掉的 —— 不是我们干的，不认领。
    if (derived.alreadyPurged) {
      return fail('PURGE_ABSENT_WITHOUT_RECEIPT', '白名单 4 行都已经不在云端，但没有本通道的回执 —— 说明是被别的东西删掉的，交给人判断，本通道不动手。', derived)
    }
    const fingerprint = payloadHash({ command: 'purgeTestRows', payload: { studentId: derived.studentId } })
    const now = Date.now()
    await put(tx, context.meta.receipts, receiptId, {
      ownerCoachId, datasetId, environment: environment2, requestId, command: 'purgeTestRows',
      payloadHash: fingerprint, status: 'processing', revisionBefore: context.revision.dataRevision, createdAt: now
    })
    // ★ 唯一的写入：删掉钉死的 4 行。循环体里没有条件判断、没有查询 —— 目标就是那 4 个 id。
    const removed = []
    for (const target of derived.targets) {
      await tx.collection(target.collection).doc(target.rowId).remove()
      removed.push({ collection: target.collection, businessId: target.businessId, rowId: target.rowId, bodyHash: target.bodyHash })
    }
    const nextRevision = context.revision.dataRevision + 1
    await put(tx, context.meta.revisions, context.revisionId, { ...context.revision, ownerCoachId, datasetId, environment: environment2, dataRevision: nextRevision, updatedAt: now })
    const response = {
      ok: true, purged: true, alreadyPurged: false, idempotent: false, requestId,
      environment: environment2, datasetId, studentId: derived.studentId, label: derived.label,
      revisionBefore: context.revision.dataRevision, revisionAfter: nextRevision,
      removed, removedCount: removed.length,
      capturedAtText: derived.capturedAtText, capturedRevision: derived.capturedRevision,
      referenceClosure: derived.referenceClosure, referenceHits: derived.referenceHits,
      impact: derived.impact,
      ignoredFields: purgeIgnoredFieldsOf(event)
    }
    await put(tx, context.meta.receipts, receiptId, {
      ownerCoachId, datasetId, environment: environment2, requestId, command: 'purgeTestRows',
      payloadHash: fingerprint, status: 'succeeded', revisionBefore: context.revision.dataRevision,
      revisionAfter: nextRevision, response, completedAt: now
    })
    return response
  })
}

// 回滚：把镜像按原 _id 原样插回。**安全性的来源是模块内嵌的常量**，不是调用方输入 ——
// 所以即使回执丢了、或者根本没执行过清除，这条动作也只会把数据集推回「被审计过的那一份」。
async function purgeRestore(db, ownerCoachId, environment, event) {
  const guard = purgeInputGuard(event)
  if (guard) return guard
  return withContext(db, ownerCoachId, environment, async (tx, context) => {
    if (event.expectedRevision != null && Number(event.expectedRevision) !== context.revision.dataRevision) {
      return fail('REVISION_CONFLICT', '云端数据已被其他请求更新。', { currentRevision: context.revision.dataRevision, expectedRevision: Number(event.expectedRevision) })
    }
    const facts = await purgeFacts(tx, ownerCoachId, context)
    if (!facts.ok) return facts
    // 行 id 已被别的行占用（内容与镜像不符）⇒ 拒绝覆盖。
    const occupied = facts.rows.filter(item => item.present && !item.matches)
    if (occupied.length) {
      return fail('PURGE_ROLLBACK_ROW_OCCUPIED', '白名单行 id 已被内容不符的行占用 —— 拒绝覆盖。', {
        ...facts,
        occupied: occupied.map(item => ({ collection: item.target.collection, businessId: item.target.businessId, rowId: item.target.rowId, rowOwner: item.rowOwner }))
      })
    }
    const datasetId = context.datasetId, environment2 = context.environment
    const present = facts.rows.filter(item => item.present).length
    // 4 行都在且逐字节等于镜像 ⇒ 本来就是我们审计过的样子，不用写。
    if (present === PURGE_ROW_COUNT) {
      return { ok: true, restored: 0, alreadyIntact: true, idempotent: true, ...facts, revisionAfter: context.revision.dataRevision }
    }
    const requestId = `purge_test_rows_rollback_${facts.studentId}`
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(requestId)) return fail('PURGE_REQUEST_ID_INVALID', '内部 requestId 不合法。')
    const receiptId = receiptIdFor(ownerCoachId, environment2, datasetId, requestId)
    const receipt = await one(tx, context.meta.receipts, { _id: receiptId, ownerCoachId, datasetId, requestId })
    if (receipt) {
      if (receipt.status === 'succeeded') return { ok: true, restored: 0, alreadyIntact: true, idempotent: true, requestId, ...facts, revisionAfter: receipt.revisionAfter }
      return fail('REQUEST_PROCESSING', '同一次回滚请求正在处理中。', { requestId })
    }
    const fingerprint = payloadHash({ command: 'purgeTestRowsRollback', payload: { studentId: facts.studentId } })
    const now = Date.now()
    await put(tx, context.meta.receipts, receiptId, {
      ownerCoachId, datasetId, environment: environment2, requestId, command: 'purgeTestRowsRollback',
      payloadHash: fingerprint, status: 'processing', revisionBefore: context.revision.dataRevision, createdAt: now
    })
    const restored = []
    for (const item of facts.rows) {
      if (item.present) continue
      await put(tx, item.target.collection, item.target.rowId, { ...clone(item.target.body), ownerCoachId, datasetId })
      restored.push({ collection: item.target.collection, businessId: item.target.businessId, rowId: item.target.rowId, bodyHash: item.target.bodyHash })
    }
    const nextRevision = context.revision.dataRevision + 1
    await put(tx, context.meta.revisions, context.revisionId, { ...context.revision, ownerCoachId, datasetId, environment: environment2, dataRevision: nextRevision, updatedAt: now })
    const response = {
      ok: true, restored: restored.length, restoredRows: restored, alreadyIntact: false, idempotent: false, requestId,
      environment: environment2, datasetId, studentId: facts.studentId, label: facts.label,
      revisionBefore: context.revision.dataRevision, revisionAfter: nextRevision,
      capturedAtText: facts.capturedAtText, referenceClosure: facts.referenceClosure
    }
    await put(tx, context.meta.receipts, receiptId, {
      ownerCoachId, datasetId, environment: environment2, requestId, command: 'purgeTestRowsRollback',
      payloadHash: fingerprint, status: 'succeeded', revisionBefore: context.revision.dataRevision,
      revisionAfter: nextRevision, response, completedAt: now
    })
    return response
  })
}

const ACTIONS = Object.freeze([
  'repairInspect', 'repairStudentTombstone', 'repairTombstoneRollback',
  'purgeTestRowsInspect', 'purgeTestRows', 'purgeTestRowsRollback'
])

// ⚠️ 通道版本出口：每次响应（成功或拒绝）都带上 —— 目的是让「云上到底跑的是哪一版」**可观测**，
//    不再靠"部署过了应该没问题"来猜（2026-09-22 预演被 tcbContext 拦过一次，无法区分"没重传"
//    还是"重传没生效"）。
//    ⚠️ 但版本号只回答"哪一版在跑"，**不回答"改对了没有"** —— v2 确实上线了（页面上显示 v2）却照旧被拒，
//    因为白名单里把 tcbContext 抄成了 tbdContext。两个问题要分开看。
//    v3 = 修正平台字段名 + 未知字段改为「高危名字硬拒 / 惰性字段放行且回显」。
//    改版本逻辑时必须同步改这里 + 对应测试断言。
const CHANNEL_VERSION = 3

async function runRepair({ db, getOpenId, event = {} }) {
  const openId = getOpenId()
  if (!openId) return { channelVersion: CHANNEL_VERSION, ...fail('IDENTITY_MISSING', '未能确认当前微信身份。') }
  const forbidden = forbiddenBusinessInput(event)
  if (forbidden) return { channelVersion: CHANNEL_VERSION, ...fail('FORBIDDEN_IDENTITY_INPUT', `客户端不得提交身份或数据集定位字段：${forbidden}`) }
  if (event.environment != null && event.environment !== 'production' && event.environment !== 'sandbox') return { channelVersion: CHANNEL_VERSION, ...fail('INVALID_ENVIRONMENT', '数据环境无效。') }
  const environment = event.environment === 'sandbox' ? 'sandbox' : 'production'
  const ownerCoachId = coachIdFor(openId)
  const coach = await one(db, 'coaches', { _id: ownerCoachId, openId, status: 'active' })
  if (!coach) return { channelVersion: CHANNEL_VERSION, ...fail('COACH_NOT_FOUND', '未找到当前有效 coach。') }
  const dispatched = (async () => {
    if (event.action === 'repairInspect') return inspect(db, ownerCoachId, environment, event)
    if (event.action === 'repairStudentTombstone') return repair(db, ownerCoachId, environment, event)
    if (event.action === 'repairTombstoneRollback') return rollback(db, ownerCoachId, environment, event)
    if (event.action === 'purgeTestRowsInspect') return purgeInspect(db, ownerCoachId, environment, event)
    if (event.action === 'purgeTestRows') return purgeCommit(db, ownerCoachId, environment, event)
    if (event.action === 'purgeTestRowsRollback') return purgeRestore(db, ownerCoachId, environment, event)
    return fail('UNKNOWN_REPAIR_ACTION', '不支持的修复操作。')
  })()
  const result = await dispatched
  return { channelVersion: CHANNEL_VERSION, ...result }
}

module.exports = {
  ACTIONS, runRepair, derive, validateBaseline, STUDENT_ID_PATTERN, BASELINE_FIELDS,
  PURGE, PURGE_ROW_COUNT, PURGE_COLLECTIONS, PURGE_SCAN,
  // 输入闸的两份名单必须可导出：测试要对着**真常量**断言。在测试里另抄一份白名单 = 恒真。
  PURGE_INPUT_FIELDS, PURGE_TARGET_CARRIER_FIELDS, PLATFORM_INJECTED_EVENT_FIELDS,
  purgeTargetsOf, purgeInputGuard, purgeExtraEventKeys, purgeIgnoredFieldsOf, purgeFacts, purgeVerdict, derivePurge, imageHash, deepFreeze
}
