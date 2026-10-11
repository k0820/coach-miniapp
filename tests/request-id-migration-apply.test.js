// 「一次性单条 requestId 迁移（mig1_）」的**执行路径**专项测试。
//
// 背景（2026-09-23 真机只读自检）：总计 15 条 ｜ ✅合法 14 ｜ ❌非法 1，唯一非法条目 `ob_29_l5cmqb`
// （completeBooking，attempts=99，旧号含 4 个 `|`）。这份测试钉的是"**允许动它**"这件事的全部前提：
//
//   ① 目标**只能**是硬编码的那一条 —— 非目标一律拒，"队首"不算，前缀相似也不算（结构上无法批量改）；
//   ② 执行前**再次**验证旧号确实非法；`inflight` 一律拒（可能正有一条请求拿着旧号在飞）；
//   ③ 换号的三类证据必须齐全：结构性（校验在事务之前，**本文件直接对云函数源码核验顺序**）
//      + 回执级（非法号的回执必然是"服务端拒答"）+ 业务级（booking 级只读诊断的四项事实）；
//   ④ 写路径：**只备份这一条 → 只改这一条 → 立即回读**；除 `requestId` 与审计字段外逐字节不变，
//      其余条目指纹不变；任何一项不符 ⇒ **自动回滚**；
//   ⑤ 全程**不发送**：模块结构上没有云调用/同步引擎/冻结授权，静态断言 + "只写了两个 Storage 键"双重证明。
const path = require('path')
const fs = require('fs')

const PROJ = path.join(__dirname, '..')
const rule = require(path.join(PROJ, 'utils', 'request-id-rule'))
const migration = require(path.join(PROJ, 'utils', 'request-id-migration'))

const BUCKET_KEY = 'coachLocalOutbox:production'
const OFFICIAL_ID = 'booking_d4149d6670a3d944adfd'
const DATASET = 'candidate_f971f032ca88dc3a2b656a6654d9a314'
// 真实形状：session.js → operationId(`completeBooking:pending:${bookingKey}`)，
// bookingKey = studentId|packageId|date|hour|minute ⇒ 4 个 `|`（U+007C），服务端白名单不含它。
const OLD_ILLEGAL = 'completeBooking:pending:mtfe64ce5l0wwn|mthcl6gmkl9nng|2026-09-19|12|0'

let pass = 0
let fail = 0
const failures = []
async function test(name, fn) {
  try { await fn(); pass += 1; console.log('PASS  ' + name) }
  catch (error) { fail += 1; failures.push(name + ' :: ' + (error && error.message)); console.log('FAIL  ' + name + '   | ' + (error && error.message)) }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assert failed') }
assert.strictEqual = (actual, expected, message) => assert(actual === expected, (message || '') + ' ｜ 期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual))
assert.deepStrictEqual = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), (message || '') + ' ｜ 期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual))
assert.includes = (list, value, message) => assert((list || []).indexOf(value) >= 0, (message || '') + ' ｜ 缺少 ' + JSON.stringify(value))
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
// 静态断言前必须先剥注释（项目铁律：自己的解释性注释会把断言绊倒）。
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ── 本机 Storage 替身：**只有 get / set**（与页面注入的形状一致，没有删除能力）──
// 未命中的 key 返回 `''`，与 wx.getStorageSync 的真实行为一致（模块必须能容忍它）。
function memoryStorage(initial) {
  const map = Object.assign({}, initial || {})
  return {
    map,
    writes: [],
    get(key) { return Object.prototype.hasOwnProperty.call(map, key) ? clone(map[key]) : '' },
    set(key, value) { this.writes.push(key); map[key] = clone(value) },
    keys() { return Object.keys(map) }
  }
}
function bucketOf(entries, version) {
  return { version: version === undefined ? 95 : version, seq: 120, entries: clone(entries), idMap: {}, failed: [], batches: {} }
}
function targetEntry(over) {
  return Object.assign({
    entryId: 'ob_29_l5cmqb', seq: 41, datasetId: DATASET, environment: 'production',
    command: 'completeBooking',
    payload: { bookingId: OFFICIAL_ID, studentId: 'student_aff17e8f86dd642b75d9', packageId: 'mthcl6gmkl9nng', date: '2026-09-19', hour: 12, minute: 0 },
    requestId: OLD_ILLEGAL, payloadHash: 'ph_1', entityKey: OFFICIAL_ID,
    coalesceKey: null, ref: null, localIds: {}, status: 'unknown', applied: true,
    attempts: 99, createdAt: 1758398400000, updatedAt: 1758398500000, nextAttemptAt: 0, lastError: { code: 'COMMAND_RESULT_UNKNOWN' }
  }, over || {})
}
function otherEntry(over) {
  return Object.assign({
    entryId: 'ob_2m_i35al3', seq: 42, datasetId: DATASET, environment: 'production',
    command: 'updateBookingContent',
    payload: { bookingId: OFFICIAL_ID, items: [{ name: '深蹲' }] },
    requestId: 'updateBookingContent:' + OFFICIAL_ID, payloadHash: 'ph_2', entityKey: OFFICIAL_ID,
    coalesceKey: null, ref: null, localIds: {}, status: 'pending', applied: true,
    attempts: 1, createdAt: 1758398400000, updatedAt: 1758398500000, nextAttemptAt: 0, lastError: null
  }, over || {})
}
// 与 diagnoseCoachCompletion 同形状的**只读**诊断响应（云端没有完课事实）。
function diagnoseAbsent() {
  return {
    ok: true, readOnly: true, state: 'C_CONTENT_SUCCEEDED_COMPLETE_NOT_SUCCEEDED', strict: true,
    datasetId: DATASET, dataRevision: 147,
    booking: { bookingId: OFFICIAL_ID, status: 'booked', packageId: 'mthcl6gmkl9nng', items: [{ name: '深蹲' }], notes: '', category: '臀腿训练', summary: '', duration: 60 },
    package: { packageId: 'mthcl6gmkl9nng', used: 4, remaining: 56, status: 'active' },
    incomes: [],
    receipts: [
      { requestId: 'updateBookingContent:' + OFFICIAL_ID, command: 'updateBookingContent', status: 'succeeded', revisionBefore: 134, revisionAfter: 136, result: { bookingId: OFFICIAL_ID }, completedAt: 1758398000000 }
    ]
  }
}
// 云端**已有**完课事实的形状（用于验证闸门会挡住它）。
function diagnosePresent() {
  const row = diagnoseAbsent()
  row.state = 'B_BOTH_COMMANDS_SUCCEEDED'
  row.booking.status = 'done'
  row.incomes = [{ incomeId: 'income_1', bookingId: OFFICIAL_ID, amount: 200 }]
  row.receipts.push({ requestId: 'completeBooking:' + OFFICIAL_ID, command: 'completeBooking', status: 'succeeded', revisionBefore: 147, revisionAfter: 148, result: { bookingId: OFFICIAL_ID }, completedAt: 1758399000000 })
  return row
}
const QUERY_FAILED_STATE = { state: 'QUERY_FAILED', code: 'INVALID_REQUEST_ID', reason: null, technicalMessage: 'requestId 无效' }
const REJECTED_RECEIPT = { ok: false, found: false, code: 'INVALID_REQUEST_ID', status: null, reason: 'REQUEST_VALIDATION_REJECTED', technicalMessage: 'requestId 无效' }

function previewFor(storage) {
  const bucket = storage.get(BUCKET_KEY)
  const entry = (bucket.entries || []).filter(item => item.entryId === migration.MIGRATION_TARGET.entryId)[0] || null
  return migration.precheckOf({
    entry, entries: bucket.entries, failed: bucket.failed,
    diagnose: diagnoseAbsent(), receipt: REJECTED_RECEIPT, receiptState: QUERY_FAILED_STATE
  })
}

async function main() {
  console.log('=== 单条 requestId 迁移（执行路径）专项 ===')

  // ───────────────── ① 目标白名单（结构上无法批量）─────────────────
  await test('目标硬编码在唯一一条上，且与真机自检结果一致（15 条里那唯一非法的一条）', async () => {
    assert.strictEqual(migration.MIGRATION_TARGET.entryId, 'ob_29_l5cmqb', '目标 entryId')
    assert.strictEqual(migration.MIGRATION_TARGET.command, 'completeBooking', '目标命令')
    assert.strictEqual(migration.MIGRATION_TARGET.bookingId, OFFICIAL_ID, '目标 booking')
    // 白名单是 Object.freeze 的常量，模块不提供任何"按形状筛选"的入口。
    assert.strictEqual(Object.isFrozen(migration.MIGRATION_TARGET), true, '目标必须冻结（防运行期被改写）')
    const names = Object.keys(migration)
    assert.strictEqual(names.filter(name => /migrateAll|batch|each|allEntries/i.test(name)).length, 0, '不得存在批量迁移入口')
  })

  await test('非目标条目一律拒绝：「另一条非法号」「只是队首」「前缀相似」都不算', async () => {
    const other = otherEntry({ requestId: 'completeBooking:pending:a|b|2026-09-19|12|0' })   // 也是非法号，但不是目标
    assert.strictEqual(migration.targetGateOf(other).code, 'NOT_THE_TARGET', '另一条非法号必须拒')
    assert.strictEqual(migration.targetGateOf(otherEntry()).code, 'NOT_THE_TARGET', '普通合法条目必须拒')
    assert.strictEqual(migration.targetGateOf(targetEntry({ entryId: 'ob_29_l5cmqb_extra' })).code, 'NOT_THE_TARGET', '前缀相似必须拒（不许模糊匹配）')
    assert.strictEqual(migration.targetGateOf(null).code, 'NO_ENTRY', '空条目必须拒')
    assert.strictEqual(migration.targetGateOf(targetEntry({ command: 'updateBookingContent' })).code, 'COMMAND_MISMATCH', '命令不符必须拒')
  })

  await test('执行前「旧号确实非法」是**每次都要重新验**的硬闸：合法号 / 长度越界都有各自的结论码', async () => {
    assert.strictEqual(migration.targetGateOf(targetEntry({ requestId: 'completeBooking:' + OFFICIAL_ID })).code, 'ID_ALREADY_LEGAL', '合法号不需要迁移')
    assert.strictEqual(migration.targetGateOf(targetEntry({ requestId: 'short' })).code, 'VERDICT_TOO_SHORT', '不是「含非法字符」那一支 ⇒ 人工决策')
    assert.strictEqual(migration.targetGateOf(targetEntry({ requestId: 12345 })).code, 'VERDICT_NOT_A_STRING', '非字符串 ⇒ 人工决策')
    const ok = migration.targetGateOf(targetEntry())
    assert.strictEqual(ok.ok, true, '目标形状必须通过')
    assert.strictEqual(ok.verdict.code, 'ILLEGAL_CHARS', '结论必须是「含非法字符」')
    assert.strictEqual(ok.verdict.illegal.length, 4, '必须精确报出 4 个非法字符')
  })

  await test('status=inflight 一律拒绝（可能正有一条请求拿着旧号在飞，此时改号账立刻乱）', async () => {
    assert.strictEqual(migration.targetGateOf(targetEntry({ status: 'inflight' })).code, 'STATUS_NOT_MIGRATABLE', 'inflight 必须拒')
    assert.strictEqual(migration.targetGateOf(targetEntry({ status: 'settled' })).code, 'STATUS_NOT_MIGRATABLE', 'settled 必须拒（它已成功，只需出队）')
    assert.strictEqual(migration.targetGateOf(targetEntry({ status: 'unknown' })).ok, true, 'unknown 允许')
    assert.strictEqual(migration.targetGateOf(targetEntry({ status: 'pending' })).ok, true, 'pending 允许')
  })

  // ───────────────── ② 只读证据（五事实 + 一个诚实的推论）─────────────────
  await test('云端没有完课事实时：五事实齐全、factAbsentProven 成立，且「未扣课」被如实标成**推论**', async () => {
    const facts = migration.factsOf({ diagnose: diagnoseAbsent(), receipt: REJECTED_RECEIPT })
    assert.strictEqual(facts.diagnoseOk, true, '诊断必须拿到结论')
    assert.strictEqual(facts.completeReceiptCount, 0, '没有 completeBooking succeeded 回执')
    assert.strictEqual(facts.contentReceiptCount, 1, '内容回执在（背景事实）')
    assert.strictEqual(facts.bookingStatus, 'booked', 'booking 仍 booked')
    assert.strictEqual(facts.incomeCount, 0, '没有收入')
    assert.strictEqual(facts.state, 'C_CONTENT_SUCCEEDED_COMPLETE_NOT_SUCCEEDED', '机器分类')
    assert.strictEqual(facts.strictState, true, '是 strict 分类')
    assert.strictEqual(facts.packageUsed, 4, '课时包 used 快照')
    assert.strictEqual(facts.packageRemaining, 56, '课时包 remaining 快照')
    assert.strictEqual(facts.packageVerdict, 'NOT_DEDUCTED_INFERRED', '「未扣课」必须是 INFERRED（推论），不能伪装成直读事实')
    assert.strictEqual(facts.factPresent, false, '不构成"云端已有事实"')
    assert.strictEqual(facts.factAbsentProven, true, '证据齐全')
    assert.strictEqual(facts.reasons.length, 0, '不该有原因')
  })

  await test('云端**已有**完课事实时（三种各自独立）⇒ factPresent 为真、绝不放行', async () => {
    const present = migration.factsOf({ diagnose: diagnosePresent(), receipt: REJECTED_RECEIPT })
    assert.strictEqual(present.factPresent, true, '有 succeeded 完课回执 ⇒ 已有事实')
    assert.strictEqual(present.factAbsentProven, false, '不得声称"没有"')
    const doneOnly = diagnoseAbsent(); doneOnly.booking.status = 'done'
    assert.strictEqual(migration.factsOf({ diagnose: doneOnly, receipt: REJECTED_RECEIPT }).factPresent, true, 'status=done 也算已有事实')
    const incomeOnly = diagnoseAbsent(); incomeOnly.incomes = [{ incomeId: 'i', amount: 200 }]
    assert.strictEqual(migration.factsOf({ diagnose: incomeOnly, receipt: REJECTED_RECEIPT }).factPresent, true, '有收入也算已有事实')
  })

  await test('缺任何一项证据都**不成立**，且逐条给出原因（不糊成一个"不通过"）', async () => {
    const broken = diagnoseAbsent(); broken.ok = false; broken.code = 'BOOKING_NOT_FOUND'
    const facts = migration.factsOf({ diagnose: broken, receipt: REJECTED_RECEIPT })
    assert.strictEqual(facts.factAbsentProven, false, '诊断没结论 ⇒ 不得放行')
    assert(facts.reasons.some(row => row.indexOf('没有拿到结论') >= 0), '必须点名"诊断没结论"')
    const noReceipt = migration.factsOf({ diagnose: diagnoseAbsent(), receipt: null })
    assert.strictEqual(noReceipt.factAbsentProven, false, '没查回执 ⇒ 不得放行')
    assert(noReceipt.reasons.some(row => row.indexOf('服务端拒答') >= 0), '必须点名"回执不是拒答形状"')
  })

  // ───────────────── ③ 预演（只读）─────────────────
  await test('预演通过：给出旧号原值、确定性新号与完整证据，且明确标注"只读未发送"', async () => {
    const storage = memoryStorage({ [BUCKET_KEY]: bucketOf([targetEntry(), otherEntry()]) })
    const preview = previewFor(storage)
    assert.strictEqual(preview.ok, true, '预演必须通过：' + preview.code + ' ' + preview.message)
    assert.strictEqual(preview.code, 'PREVIEW_OK', '结论码')
    assert.strictEqual(preview.mode, 'preview', '预演模式')
    assert.strictEqual(preview.oldRequestId, OLD_ILLEGAL, '必须原样给出旧号')
    const expected = rule.migratedRequestId(OLD_ILLEGAL).requestId
    assert.strictEqual(preview.newRequestId, expected, '新号必须与确定性迁移规则一致')
    assert.strictEqual(rule.isLegalRequestId(preview.newRequestId), true, '新号必须合法')
    assert(preview.newRequestId !== OLD_ILLEGAL, '新号必须 ≠ 旧号')
    assert.strictEqual(preview.newRequestId.indexOf('|'), -1, '新号里不许再有竖线')
    assert.strictEqual(preview.newRequestId.indexOf(migration.MIGRATION_RULE + '_'), 0, '新号必须带 mig1_ 前缀（可证明新颖性）')
    assert.strictEqual(preview.structuralEvidence, migration.STRUCTURAL_EVIDENCE, '必须写明结构性证据')
    assert.strictEqual(storage.writes.length, 0, '预演**不许写任何东西**')
  })

  await test('预演拒绝：云端已有事实 ⇒ FACT_ALREADY_PRESENT（换号会重复扣课时/记收入）', async () => {
    const storage = memoryStorage({ [BUCKET_KEY]: bucketOf([targetEntry(), otherEntry()]) })
    const preview = migration.precheckOf({
      entry: targetEntry(), entries: [targetEntry(), otherEntry()], failed: [],
      diagnose: diagnosePresent(), receipt: REJECTED_RECEIPT, receiptState: QUERY_FAILED_STATE
    })
    assert.strictEqual(preview.ok, false, '必须拒')
    assert.strictEqual(preview.code, 'FACT_ALREADY_PRESENT', '结论码')
    assert.strictEqual(storage.writes.length, 0, '不许写')
  })

  await test('预演拒绝：非法号却查到了回执结论（反常）⇒ RECEIPT_UNEXPECTEDLY_ANSWERED，人工看', async () => {
    const preview = migration.precheckOf({
      entry: targetEntry(), entries: [targetEntry()], failed: [],
      diagnose: diagnoseAbsent(), receipt: { ok: true, found: false, code: null, status: null },
      receiptState: { state: 'NOT_FOUND', code: null }
    })
    assert.strictEqual(preview.code, 'RECEIPT_UNEXPECTEDLY_ANSWERED', '非法号能被受理本身就是异常 ⇒ 停手')
  })

  await test('预演拒绝：诊断没拿到结论 ⇒ FACT_NOT_PROVEN_ABSENT（"未知"的正解是停手）', async () => {
    const preview = migration.precheckOf({
      entry: targetEntry(), entries: [targetEntry()], failed: [],
      diagnose: { ok: false, code: 'ACTIVE_DATASET_INVALID' }, receipt: REJECTED_RECEIPT, receiptState: QUERY_FAILED_STATE
    })
    assert.strictEqual(preview.ok, false, '必须拒')
    assert.strictEqual(preview.code, 'FACT_NOT_PROVEN_ABSENT', '结论码')
  })

  await test('新号四项检查：撞队列现存号 / 撞 failed 归档 都拒绝', async () => {
    const newId = rule.migratedRequestId(OLD_ILLEGAL).requestId
    const collideQueue = previewCollision([targetEntry(), otherEntry({ requestId: newId })], [])
    assert.strictEqual(collideQueue.ok, false, '撞队列必须拒')
    assert.strictEqual(collideQueue.code, 'PLAN_REFUSED', '结论码')
    assert.includes(collideQueue.refusals.map(row => row.code), 'COLLIDES_WITH_EXISTING', '必须报出冲突码')
    const collideFailed = previewCollision([targetEntry()], [{ entryId: 'ob_old', requestId: newId, command: 'completeBooking' }])
    assert.strictEqual(collideFailed.ok, false, '撞归档必须拒')
    assert.strictEqual(collideFailed.collision.notInFailed, false, '报告里必须看到 notInFailed=n')
  })

  await test('队列清单漏传目标条目 ⇒ ENTRY_LIST_INCOMPLETE（宁可停手，也不让"不与队列撞号"静默空转）', async () => {
    const preview = migration.precheckOf({
      entry: targetEntry(), entries: [otherEntry()],
      failed: [], diagnose: diagnoseAbsent(), receipt: REJECTED_RECEIPT, receiptState: QUERY_FAILED_STATE
    })
    assert.strictEqual(preview.ok, false, '必须拒')
    assert.strictEqual(preview.code, 'ENTRY_LIST_INCOMPLETE', '结论码：漏传整队 = 少一道保险，必须显式失败')
  })

  await test('等价断言：报告里的四项检查与 plan 的放行结论**永远一致**（防两份口径分叉）', async () => {
    const newId = rule.migratedRequestId(OLD_ILLEGAL).requestId
    const cases = [
      { entries: [targetEntry(), otherEntry()], failed: [] },
      { entries: [targetEntry(), otherEntry({ requestId: newId })], failed: [] },
      { entries: [targetEntry()], failed: [{ entryId: 'ob_x', requestId: newId }] }
    ]
    cases.forEach((row, index) => {
      const preview = previewCollision(row.entries, row.failed)
      const allFour = preview.collision.legal && preview.collision.differs && preview.collision.notInQueue && preview.collision.notInFailed
      assert.strictEqual(allFour, preview.planCount === 1, '第 ' + (index + 1) + ' 例：四项全真 ⟺ planCount=1')
      assert.strictEqual(preview.planCount === 1, preview.ok === true, '第 ' + (index + 1) + ' 例：planCount=1 ⟺ 预演通过')
    })
  })

  // ───────────────── ④ 执行路径 ─────────────────
  await test('执行前三道门：没有预演 / 预演过期 / 预演的新号与当前算出的不一致 ⇒ 全部拒绝且队列一字未动', async () => {
    const storage = memoryStorage({ [BUCKET_KEY]: bucketOf([targetEntry(), otherEntry()]) })
    const before = clone(storage.get(BUCKET_KEY))
    const noPreview = migration.applyMigration({ storage, bucketKey: BUCKET_KEY, failed: [] })
    assert.strictEqual(noPreview.code, 'NO_FRESH_PREVIEW', '没有预演必须拒')
    const preview = previewFor(storage)
    const stale = migration.applyMigration({
      storage, bucketKey: BUCKET_KEY, failed: [],
      preview: Object.assign({}, preview, { at: preview.at - migration.PREVIEW_TTL_MS - 1000 })
    })
    assert.strictEqual(stale.code, 'PREVIEW_STALE', '过期预演必须拒')
    const mismatched = migration.applyMigration({
      storage, bucketKey: BUCKET_KEY, failed: [],
      preview: Object.assign({}, preview, { newRequestId: 'mig1_something_else' })
    })
    assert.strictEqual(mismatched.code, 'PREVIEW_NEW_ID_MISMATCH', '新号不一致必须拒')
    assert.deepStrictEqual(storage.get(BUCKET_KEY), before, '三次拒绝之后队列必须**逐字节**没动')
  })

  await test('执行成功：**只有** requestId 与审计字段变，其余字段与其它条目逐字节不变，version +1', async () => {
    const storage = memoryStorage({ [BUCKET_KEY]: bucketOf([otherEntry(), targetEntry()], 95) })
    const bucketBefore = clone(storage.get(BUCKET_KEY))
    const otherDigestBefore = migration.othersDigestOf(bucketBefore, migration.MIGRATION_TARGET.entryId)
    const preview = previewFor(storage)
    const result = migration.applyMigration({ storage, bucketKey: BUCKET_KEY, failed: [], preview })
    assert.strictEqual(result.ok, true, '必须成功：' + result.code + ' ' + result.message)
    assert.strictEqual(result.code, 'MIGRATED_ONE', '结论码')
    assert.deepStrictEqual(result.changedFields.sort(), ['requestId'], '变了的字段只有 requestId（migration 是**新增**）')
    assert.deepStrictEqual(result.addedFields, ['migration'], '新增字段只有 migration（审计）')
    const bucketAfter = storage.get(BUCKET_KEY)
    const entryAfter = bucketAfter.entries.filter(item => item.entryId === migration.MIGRATION_TARGET.entryId)[0]
    const entryBefore = bucketBefore.entries.filter(item => item.entryId === migration.MIGRATION_TARGET.entryId)[0]
    assert.strictEqual(entryAfter.requestId, result.newRequestId, '新号已写入')
    assert.strictEqual(entryAfter.requestId, preview.newRequestId, '写入的号与预演一致')
    assert.strictEqual(migration.entryDigestOf(entryAfter), migration.entryDigestOf(entryBefore), '除号与审计字段外，条目指纹必须完全一致')
    // 业务引用 / 命令 / 创建时间 / 尝试次数 —— 逐条点名，防"哪天顺手多改一个字段"。
    assert.strictEqual(entryAfter.payloadHash, entryBefore.payloadHash, 'payloadHash 不变')
    assert.deepStrictEqual(entryAfter.payload, entryBefore.payload, 'payload 不变')
    assert.strictEqual(entryAfter.entityKey, entryBefore.entityKey, '业务引用不变')
    assert.strictEqual(entryAfter.createdAt, entryBefore.createdAt, '创建时间不变')
    assert.strictEqual(entryAfter.updatedAt, entryBefore.updatedAt, 'updatedAt 也不变（让 diff 最强）')
    assert.strictEqual(entryAfter.attempts, 99, 'attempts 保持 99（补发侧要靠它先查回执）')
    assert.strictEqual(entryAfter.status, 'unknown', 'status 不变')
    assert.strictEqual(entryAfter.lastError.code, 'COMMAND_RESULT_UNKNOWN', 'lastError 原样保留')
    assert.strictEqual(entryAfter.migration.rule, 'mig1', '审计字段写明规则')
    assert.strictEqual(entryAfter.migration.from, OLD_ILLEGAL, '审计字段保留旧号原值')
    assert.strictEqual(entryAfter.migration.to, result.newRequestId, '审计字段记下新号')
    assert.strictEqual(bucketAfter.entries.length, bucketBefore.entries.length, '条数不变')
    assert.strictEqual(bucketAfter.version, 96, 'version +1')
    assert.strictEqual(migration.othersDigestOf(bucketAfter, migration.MIGRATION_TARGET.entryId).digest, otherDigestBefore.digest, '其它条目指纹不变')
    assert.strictEqual(migration.othersDigestOf(bucketAfter, migration.MIGRATION_TARGET.entryId).count, otherDigestBefore.count, '其它条目数不变')
    assert.strictEqual(result.checks.diffClean, true, '回读校验的 diff 必须干净')
  })

  await test('**不发送**的双重证明：只写了"队列 + 备份"两个键，且没有任何发送/云调用形状', async () => {
    const storage = memoryStorage({ [BUCKET_KEY]: bucketOf([targetEntry(), otherEntry()]) })
    const preview = previewFor(storage)
    storage.writes.length = 0
    migration.applyMigration({ storage, bucketKey: BUCKET_KEY, failed: [], preview })
    assert.deepStrictEqual(storage.writes.slice().sort(), [BUCKET_KEY, migration.MIGRATION_BACKUP_KEY].sort(), '写入只允许这两个键')
    // 静态：模块结构上就没有发送路径（先剥注释，再按**调用形状**断言，避免误伤说明文字里的"execute"字样）。
    const code = stripComments(fs.readFileSync(path.join(PROJ, 'utils', 'request-id-migration.js'), 'utf8'))
    const forbidden = [
      [/require\([^)]*sync-engine/, '不得 require 同步引擎'],
      [/require\([^)]*cloud-primary-adapter/, '不得 require 云端适配器'],
      [/\bcallCloud\s*\(/, '不得有 callCloud 调用'],
      [/\bcallFunction\s*\(/, '不得有 callFunction 调用'],
      [/\bexecute\s*\(/, '不得有 execute 调用'],
      [/\bsteps?\s*\(/, '不得调用同步引擎的 step'],
      [/\bgrantResend\s*\(/, '不得授予补发授权'],
      [/\bclearResendGrant\s*\(/, '不得动补发授权'],
      [/\bunfreeze|\bfreezeSync|\bguard\./, '不得碰冻结/门禁'],
      [/\bremove\s*\(/, '不得删除条目（只准改号）']
    ]
    forbidden.forEach(row => assert(!row[0].test(code), row[1]))
    assert.strictEqual(Object.keys(migration).filter(name => /send|execute|flush|sync|call/i.test(name)).length, 0, '导出里不得有发送类入口')
  })

  await test('备份没落稳 ⇒ BACKUP_NOT_PERSISTED，且队列一个字都没动', async () => {
    const storage = memoryStorage({ [BUCKET_KEY]: bucketOf([targetEntry(), otherEntry()]) })
    const before = clone(storage.get(BUCKET_KEY))
    const preview = previewFor(storage)
    const broken = { get: key => (key === migration.MIGRATION_BACKUP_KEY ? '' : storage.get(key)), set: (key, value) => { if (key !== migration.MIGRATION_BACKUP_KEY) storage.set(key, value) } }
    const result = migration.applyMigration({ storage: broken, bucketKey: BUCKET_KEY, failed: [], preview })
    assert.strictEqual(result.code, 'BACKUP_NOT_PERSISTED', '结论码')
    assert.deepStrictEqual(storage.get(BUCKET_KEY), before, '备份没落稳就不许写队列')
  })

  await test('回读不干净（写入被篡改）⇒ **自动回滚**到迁移前，并如实报出 rolledBack', async () => {
    const storage = memoryStorage({ [BUCKET_KEY]: bucketOf([targetEntry(), otherEntry()], 95) })
    const before = clone(storage.get(BUCKET_KEY))
    const preview = previewFor(storage)
    // 模拟"这一次写入把内容弄坏了"：第一次写队列时顺手改掉 payload —— 回读的 diff 立刻不干净。
    // 只坏第一次（一次性故障），好让"自动回滚"这一步本身能被验证成功。
    let tampered = false
    const tampering = {
      get: key => storage.get(key),
      set: (key, value) => {
        if (key === BUCKET_KEY && Array.isArray(value.entries) && !tampered) {
          tampered = true
          value = clone(value)
          value.entries.forEach(item => { if (item.entryId === migration.MIGRATION_TARGET.entryId) item.payload = { tampered: true } })
        }
        storage.set(key, value)
      }
    }
    const result = migration.applyMigration({ storage: tampering, bucketKey: BUCKET_KEY, failed: [], preview })
    assert.strictEqual(result.ok, false, '篡改必须被发现')
    assert.strictEqual(result.code, 'VERIFY_FAILED_AUTO_ROLLED_BACK', '结论码')
    assert.strictEqual(result.rolledBack, true, '必须自动回滚成功')
    assert.strictEqual(result.checks.diffClean, false, '必须报出 diff 不干净')
    assert.deepStrictEqual(storage.get(BUCKET_KEY), before, '自动回滚后队列必须回到迁移前（逐字节）')
  })

  await test('若连回滚写入本身也出问题 ⇒ 必须**如实报"没回到迁移前"**，绝不假报成功', async () => {
    const storage = memoryStorage({ [BUCKET_KEY]: bucketOf([targetEntry(), otherEntry()], 95) })
    const preview = previewFor(storage)
    // 一个"坏写入"持续存在的情形：写入路径每次都会改坏内容（比如某段中间层被改坏了）。
    const alwaysTampering = {
      get: key => storage.get(key),
      set: (key, value) => {
        if (key === BUCKET_KEY && Array.isArray(value.entries)) {
          value = clone(value)
          value.entries.forEach(item => { if (item.entryId === migration.MIGRATION_TARGET.entryId) item.payload = { tampered: true } })
        }
        storage.set(key, value)
      }
    }
    const result = migration.applyMigration({ storage: alwaysTampering, bucketKey: BUCKET_KEY, failed: [], preview })
    assert.strictEqual(result.ok, false, '必须失败')
    assert.strictEqual(result.rolledBack, false, '回滚没能回到迁移前 ⇒ 必须**如实**报 false（这一格假报成功就是灾难）')
    assert(result.rollbackMismatches.length > 0, '必须列出差异字段，便于人排查')
    const text = migration.migrateTextOf(Object.assign({}, result, { atText: 'x', frozen: true }))
    assert(text.indexOf('立即停手') >= 0, '报告必须写明"立即停手"')
  })

  // ───────────────── ⑤ 回滚入口 ─────────────────
  await test('回滚：requestId 还原为原始旧号、审计字段消失、与备份指纹一致，其它条目不变', async () => {
    const storage = memoryStorage({ [BUCKET_KEY]: bucketOf([otherEntry(), targetEntry()], 95) })
    const otherDigestBefore = migration.othersDigestOf(storage.get(BUCKET_KEY), migration.MIGRATION_TARGET.entryId)
    const original = clone(storage.get(BUCKET_KEY).entries.filter(item => item.entryId === migration.MIGRATION_TARGET.entryId)[0])
    const preview = previewFor(storage)
    assert.strictEqual(migration.applyMigration({ storage, bucketKey: BUCKET_KEY, failed: [], preview }).ok, true, '先迁移成功')
    const rolled = migration.rollbackOf({ storage, bucketKey: BUCKET_KEY })
    assert.strictEqual(rolled.ok, true, '回滚必须成功：' + rolled.code + ' ' + rolled.message)
    assert.strictEqual(rolled.code, 'ROLLED_BACK', '结论码')
    const entryAfter = storage.get(BUCKET_KEY).entries.filter(item => item.entryId === migration.MIGRATION_TARGET.entryId)[0]
    assert.strictEqual(entryAfter.requestId, OLD_ILLEGAL, '号必须回到原始旧号')
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entryAfter, 'migration'), false, '审计字段必须消失')
    assert.strictEqual(migration.entryDigestOf(entryAfter), migration.entryDigestOf(original), '除号与审计字段外必须与原件一致')
    assert.strictEqual(migration.othersDigestOf(storage.get(BUCKET_KEY), migration.MIGRATION_TARGET.entryId).digest, otherDigestBefore.digest, '其它条目不变')
    // 再点一次：已经是旧号 ⇒ 幂等返回，不做第二次写。
    assert.strictEqual(migration.rollbackOf({ storage, bucketKey: BUCKET_KEY }).code, 'ALREADY_ROLLED_BACK', '再回滚必须幂等')
  })

  await test('回滚拒绝：条目已出队（可能已被补发）⇒ 绝不复活它', async () => {
    const storage = memoryStorage({ [BUCKET_KEY]: bucketOf([targetEntry(), otherEntry()]) })
    const preview = previewFor(storage)
    migration.applyMigration({ storage, bucketKey: BUCKET_KEY, failed: [], preview })
    // 模拟"这条被补发出队了"：只把它从队列里拿掉（备份仍在）。
    const bucket = storage.get(BUCKET_KEY)
    bucket.entries = bucket.entries.filter(item => item.entryId !== migration.MIGRATION_TARGET.entryId)
    storage.set(BUCKET_KEY, bucket)
    const rolled = migration.rollbackOf({ storage, bucketKey: BUCKET_KEY })
    assert.strictEqual(rolled.ok, false, '必须拒')
    assert.strictEqual(rolled.code, 'ENTRY_NOT_IN_QUEUE', '结论码')
    assert.strictEqual(storage.get(BUCKET_KEY).entries.filter(item => item.entryId === migration.MIGRATION_TARGET.entryId).length, 0, '绝不许复活条目')
  })

  await test('回滚拒绝：没有备份 ⇒ 不猜不算，直接拒', async () => {
    const storage = memoryStorage({ [BUCKET_KEY]: bucketOf([targetEntry()]) })
    assert.strictEqual(migration.rollbackOf({ storage, bucketKey: BUCKET_KEY }).code, 'BACKUP_FORMAT_INVALID', '没备份必须拒')
    const bad = memoryStorage({ [BUCKET_KEY]: bucketOf([targetEntry()]), [migration.MIGRATION_BACKUP_KEY]: { format: 'x', entryId: 'ob_29_l5cmqb', entry: { entryId: 'ob_29_l5cmqb', requestId: OLD_ILLEGAL } } })
    assert.strictEqual(migration.rollbackOf({ storage: bad, bucketKey: BUCKET_KEY }).code, 'BACKUP_FORMAT_INVALID', '格式不对必须拒')
  })

  // ───────────────── ⑥ 放行前提的外部核验（结构性证据）─────────────────
  await test('结构性证据由**云函数源码**逐次核验：校验在事务之前 ⇒ 旧号的事务从未开始', async () => {
    const source = fs.readFileSync(path.join(PROJ, 'cloudfunctions', 'coachBusinessCommand', 'core.js'), 'utf8')
    const callValidate = source.indexOf('validateEnvelope(envelope)')
    const runTx = source.indexOf('db.runTransaction')
    assert(callValidate > 0, 'cloudfunctions 里必须能找到 execute 中的 validateEnvelope 调用')
    assert(runTx > 0, '必须能找到 db.runTransaction')
    assert(callValidate < runTx, '`validateEnvelope` 必须出现在 `db.runTransaction` **之前**（否则"事务从未开始"不成立）')
    const defValidate = source.indexOf('function validateEnvelope')
    assert(defValidate > 0, '必须能找到 validateEnvelope 定义')
    assert(source.indexOf('validateRequestId(envelope.requestId)') > defValidate, 'validateEnvelope 里必须真的校验 requestId')
    assert(source.indexOf('validateRequestId(envelope.requestId)') < runTx, 'requestId 校验必须在事务之前')
    // 读路径同样先校验（getReceipt）⇒ "旧号查不到回执"是因为被**拒**，不是因为没提交。
    const getReceipt = source.indexOf("action === 'getReceipt'")
    assert(getReceipt > 0, '必须能找到 getReceipt 分支')
    assert(source.indexOf('validateRequestId(event.requestId)', getReceipt) > getReceipt, 'getReceipt 也必须先校验 requestId')
    assert(/throw commandError\('INVALID_REQUEST_ID'/.test(source), '必须存在 INVALID_REQUEST_ID 的抛出点')
  })

  // ───────────────── ⑦ 报告 ─────────────────
  await test('执行报告：写明旧号原值、"未发送/未调用 execute/未解冻"、四项检查与回读校验', async () => {
    const storage = memoryStorage({ [BUCKET_KEY]: bucketOf([targetEntry(), otherEntry()]) })
    const preview = previewFor(storage)
    const result = migration.applyMigration({ storage, bucketKey: BUCKET_KEY, failed: [], preview })
    const text = migration.migrateTextOf(Object.assign({}, result, { atText: '2026-09-23 00:40:00（北京时）', frozen: true, facts: preview.facts, collision: preview.collision, structuralEvidence: preview.structuralEvidence }))
    assert(text.indexOf('ob_29_l5cmqb') >= 0, '必须点名条目')
    assert(text.indexOf(OLD_ILLEGAL) >= 0, '必须印出旧号原值')
    assert(text.indexOf('VALIDATE_ENVELOPE_BEFORE_RUN_TRANSACTION') >= 0, '必须印出结构性证据')
    assert(text.indexOf('未发送') >= 0, '必须写明未发送')
    assert(text.indexOf('execute') >= 0, '必须写明未调用 execute')
    assert(text.indexOf('未解冻') >= 0, '必须写明未解冻')
    assert(text.indexOf('四项检查') >= 0, '必须摊开四项检查')
    assert(text.indexOf('回读校验') >= 0, '必须摊开回读校验')
    const previewText = migration.migrateTextOf(Object.assign({}, preview, { atText: '2026-09-23 00:39:00（北京时）', frozen: true }))
    assert(previewText.indexOf('预演（只读）') >= 0, '预演报告必须标明只读')
  })

  console.log('')
  console.log('=== ' + (fail ? 'FAIL' : 'ALL GREEN') + '：' + pass + ' 通过 / ' + fail + ' 失败 ===')
  if (fail) { failures.forEach(row => console.log('  ⛔ ' + row)); process.exitCode = 1 }
}

// 预演的小helper：只用给定队列/归档，其余输入固定为"云端没有事实"。
function previewCollision(entries, failed) {
  return migration.precheckOf({
    entry: (entries || []).filter(item => item.entryId === migration.MIGRATION_TARGET.entryId)[0] || null,
    entries, failed, diagnose: diagnoseAbsent(), receipt: REJECTED_RECEIPT, receiptState: QUERY_FAILED_STATE
  })
}

main().catch(error => { console.log('CRASH ' + (error && error.stack || error)); process.exitCode = 1 })
