// 一次性**单条** requestId 安全迁移（`mig1_`）—— 只改本机 outbox，**不发送、不调用 execute、不解冻**。
//
// 为什么需要它：2026-09-22 真机只读自检（整队一次扫完）结果是
//   **总计 15 条 ｜ ✅合法 14 ｜ ❌非法 1**，唯一非法条目 `ob_29_l5cmqb`（completeBooking）。
// 这条号的生成规则是**历史规则**（不是数据损坏）：预约未转正时
//   localId = `pending:<bookingKey>`、bookingKey = studentId|packageId|date|hour|minute
//   ⇒ requestId 里带 `|`（U+007C），而服务端白名单 `/^[A-Za-z0-9:_-]{8,128}$/` 不含它。
// 更关键的是**拒收发生在事务之前**（`coachBusinessCommand/core.js`：validateEnvelope 在 db.runTransaction 之前
// ⇒ 事务根本不会开始）⇒ 这条号**不可能**在云端留下过任何业务事实，原号重发 100% 无效。
//
// 于是处置只有一条路：**给这一条换一个"从未出过网"的合法幂等号**，让它有机会被服务端识别。
// 但换号 = 换一次全新的幂等身份 —— 只有在"能证明云端确实没有这条业务事实"时才安全。所以本模块把
// 「能不能换」写成**一处**判据（`migrationGateOf`，页面与测试共用同一份），并要求三类证据齐全：
//   ① 结构性：旧号在事务开始前就被拒（本文件 STRUCTURAL_EVIDENCE；该顺序由自动化测试对着云函数源码逐次核验）；
//   ② 回执级：对**旧号**查回执得到的是"服务端拒答"（非法号的预期形状），而不是任何一种结论；
//   ③ 业务级：booking 级只读诊断 —— 无 completeBooking succeeded 回执 / booking 仍 booked / 无 income /
//      机器分类落在 C_CONTENT_SUCCEEDED_COMPLETE_NOT_SUCCEEDED。
// ⚠️「旧号查不到回执」**不是**"云端没有"的证据（服务端是**拒收**它，当然查不到）—— 上面②只有与①③合起来才有意义。
//
// 范围铁律（用户明确要求）：
//   · 目标**硬编码**在这一个 entryId 上，**禁止模糊匹配、禁止批量改**（不接受"队首""唯一非法那条""前缀匹配"）；
//   · 执行前**再次**验证旧号确实非法；新号必须合法、≠旧号、不与队列撞、不与 failed 归档撞；
//   · 改前**完整备份这一条**，改后**立即回读**：除 `requestId` 与 `migration` 审计字段外，其它字段逐字节不变；
//   · 只改本机 outbox —— 本模块**不 require** sync-engine / adapter / 任何云调用，结构上就没有发送路径。
const requestIdRule = require('./request-id-rule')
const { sha256 } = require('./sha256')

// 留档键：preview（只读预演）与 commit（已执行）共用一条记录；备份单独一把键。
const MIGRATION_LOG_KEY = 'coachRepairMigrate:production'
const MIGRATION_BACKUP_KEY = 'coachRepairMigrateBackup:production'
const MIGRATION_RULE = 'mig1'
const BACKUP_FORMAT = 'repair-request-id-migration-1'
// 预演记录的新鲜度：执行时要求预演是**最近**做的，避免"拿一小时前的证据去改现在的队列"。
const PREVIEW_TTL_MS = 10 * 60 * 1000
// 允许被迁移的入队状态。`inflight` **不在**里面：那表示本轮机正在发这条命令，
// 可能有一条请求正拿着旧号在飞 —— 此时改盘上的号，账立刻对不上。
const MIGRATABLE_STATUS = Object.freeze(['pending', 'unknown'])
// 唯一允许变化的字段。其它任何字段变了都算"改坏了"，会触发自动回滚。
const ALLOWED_CHANGED_FIELDS = Object.freeze(['requestId', 'migration'])
// 结构性证据：服务端在校验信封（含 requestId 格式）时就抛错，**事务从未开始**。
// 这条论断不靠"我记得"，而由 tests/request-id-migration-apply.test.js 直接读
// cloudfunctions/coachBusinessCommand/core.js 的源码，逐次断言 validateEnvelope 出现在 runTransaction 之前
// —— 顺序一旦被人改动，测试立刻变红，本模块的放行前提就随之失效。
const STRUCTURAL_EVIDENCE = 'VALIDATE_ENVELOPE_BEFORE_RUN_TRANSACTION'

// ⚠️ 目标 = **硬编码白名单**。它是本模块唯一的"可迁移对象"，
//    故意不提供任何按形状筛选的入口（那等于给了"批量迁移 14 条合法命令"的后门）。
const MIGRATION_TARGET = Object.freeze({
  entryId: 'ob_29_l5cmqb',
  command: 'completeBooking',
  bookingId: 'booking_d4149d6670a3d944adfd',
  label: '诸葛逍遥 · 完课（2026-09-19 12:00）'
})

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const text = value => (value === null || value === undefined || value === '' ? '—' : String(value))

// 稳定序列化（键排序）—— 指纹与 diff 都靠它，避免"同一份内容因键序不同被判成变了"。
function stableStringify(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
}

// ── 目标闸门：四道判据，任一不成立就不许动 ────────────────────────────────
// ① entryId **精确相等**（不做前缀/包含匹配 ⇒ 结构上无法"顺手多迁几条"）；
// ② command 必须是目标命令；
// ③ 旧号必须**确实非法**（每次执行都重新验证一遍，不信任上一次的结论）；
// ④ 状态必须在允许集合里（`inflight` 一律拒绝）。
function targetGateOf(entry) {
  if (!entry || typeof entry !== 'object') {
    return { ok: false, code: 'NO_ENTRY', message: '队列里找不到这条目标条目。' }
  }
  if (String(entry.entryId || '') !== MIGRATION_TARGET.entryId) {
    return {
      ok: false, code: 'NOT_THE_TARGET',
      message: '本功能只允许迁移唯一指定的那一条（' + MIGRATION_TARGET.entryId + '），当前条目 ' + text(entry.entryId) +
        ' 不在白名单内 —— 绝不做模糊匹配、绝不批量迁移。'
    }
  }
  if (String(entry.command || '') !== MIGRATION_TARGET.command) {
    return { ok: false, code: 'COMMAND_MISMATCH', message: '命令不是 ' + MIGRATION_TARGET.command + '（实际 ' + text(entry.command) + '）⇒ 拒绝。' }
  }
  const verdict = requestIdRule.requestIdVerdict(entry.requestId)
  if (verdict.ok) {
    return { ok: false, code: 'ID_ALREADY_LEGAL', message: '这条的号**本身合法**（' + verdict.reason + '）⇒ 根本不需要迁移，走受控补发。', verdict }
  }
  if (verdict.code !== 'ILLEGAL_CHARS') {
    return {
      ok: false, code: 'VERDICT_' + verdict.code, verdict,
      message: '不合法但不是「含非法字符」这一支（' + verdict.code + '：' + verdict.reason + '）⇒ 换号不一定是对策，人工判断。'
    }
  }
  if (MIGRATABLE_STATUS.indexOf(String(entry.status || '')) < 0) {
    return {
      ok: false, code: 'STATUS_NOT_MIGRATABLE', verdict,
      message: 'status=' + text(entry.status) + '，不在允许迁移的集合（' + MIGRATABLE_STATUS.join(' / ') +
        '）里 —— `inflight` 表示本轮机可能正拿着旧号在发，此时改号账就乱了。'
    }
  }
  return { ok: true, code: 'TARGET_OK', verdict, message: '目标校验通过：' + MIGRATION_TARGET.entryId + '，旧号' + verdict.reason }
}

// ── 业务级只读证据压缩：把诊断响应压成"五个事实 + 一个推论" ────────────────
function factsOf(input) {
  const source = input || {}
  const diagnose = source.diagnose || null
  const receipt = source.receipt || null
  const rows = diagnose && Array.isArray(diagnose.receipts) ? diagnose.receipts : []
  const completeReceipts = rows.filter(row => row && row.command === 'completeBooking' && row.status === 'succeeded')
  const contentReceipts = rows.filter(row => row && row.command === 'updateBookingContent' && row.status === 'succeeded')
  const bookingStatus = diagnose && diagnose.booking ? (diagnose.booking.status || null) : null
  const incomeCount = diagnose && Array.isArray(diagnose.incomes) ? diagnose.incomes.length : null
  const pkg = diagnose && diagnose.package ? diagnose.package : null
  const state = diagnose ? (diagnose.state || null) : null
  const diagnoseOk = !!(diagnose && diagnose.ok === true)
  const receiptShape = receipt === null ? null : {
    ok: receipt.ok === true, found: receipt.found === true,
    code: receipt.code || null, status: receipt.status || null
  }
  // 「云端**已有**这条业务事实」—— 任一为真即**禁止换号**（换了就是第二次扣课时 / 第二次记收入）。
  const factPresent = completeReceipts.length > 0 || bookingStatus === 'done' || Number(incomeCount || 0) > 0
  // 「云端**确实没有**这条业务事实」—— 必须**全部**成立，任一条不成立都要如实列出原因。
  const reasons = []
  if (!diagnoseOk) reasons.push('booking 级只读诊断没有拿到结论（ok≠true）')
  if (completeReceipts.length) reasons.push('云端已有 ' + completeReceipts.length + ' 条 completeBooking succeeded 回执')
  if (bookingStatus !== 'booked') reasons.push('booking.status=' + text(bookingStatus) + '（预期 booked）')
  if (Number(incomeCount || 0) !== 0) reasons.push('incomes 有 ' + text(incomeCount) + ' 条（预期 0）')
  if (state !== 'C_CONTENT_SUCCEEDED_COMPLETE_NOT_SUCCEEDED') reasons.push('机器分类=' + text(state) + '（预期 C_CONTENT_SUCCEEDED_COMPLETE_NOT_SUCCEEDED）')
  if (!(receiptShape && receiptShape.ok === false)) {
    reasons.push('旧号的回执不是「服务端拒答」（ok=' + text(receiptShape && receiptShape.ok) + '）—— 非法号的预期形状恰恰是被拒')
  }
  return {
    diagnoseOk, state, strictState: !!(diagnose && diagnose.strict === true),
    bookingStatus, incomeCount: incomeCount === null ? null : Number(incomeCount),
    completeReceiptCount: completeReceipts.length, contentReceiptCount: contentReceipts.length, receiptTotal: rows.length,
    packageUsed: pkg ? pkg.used : null, packageRemaining: pkg ? pkg.remaining : null, packageStatus: pkg ? pkg.status : null,
    receipt: receiptShape,
    // ⚠️ 诚实标注：**「这一课没扣课时」是推论，不是直读字段**。
    //    完课在业务上 = 改状态 + 扣课时 + 记收入 三件套；三者都没有 ⇒ 没发生（附当前余量快照供人核对）。
    packageVerdict: (bookingStatus === 'booked' && Number(incomeCount || 0) === 0 && !completeReceipts.length)
      ? 'NOT_DEDUCTED_INFERRED' : 'UNKNOWN',
    factPresent, factAbsentProven: reasons.length === 0, reasons
  }
}

// ── 唯一的"能不能换号"判据（页面与测试共用同一份，不允许任何地方再写第二份）──
function migrationGateOf(input) {
  const row = input || {}
  const verdict = row.verdict || {}
  const receiptState = row.receiptState || null
  if (verdict.ok) return { allow: false, code: 'ID_ALREADY_LEGAL', message: '号本身合法 ⇒ 不需要迁移，走受控补发（回执说了算）。' }
  if (verdict.code !== 'ILLEGAL_CHARS') {
    return { allow: false, code: 'VERDICT_' + (verdict.code || 'UNKNOWN'), message: '不是「含非法字符」这一支（' + (verdict.code || '?') + '）⇒ 不迁移，人工决策。' }
  }
  if (receiptState && receiptState.state !== 'QUERY_FAILED') {
    return { allow: false, code: 'RECEIPT_UNEXPECTEDLY_ANSWERED', message: '非法号居然查到了回执结论（' + (receiptState.state || '?') + '）⇒ 先人工看清楚，不迁移。' }
  }
  if (row.factPresent === true) {
    return { allow: false, code: 'FACT_ALREADY_PRESENT', message: '云端**已有**这条业务事实 ⇒ 禁止换号重发（会重复扣课时 / 重复记收入），只能收敛出队。' }
  }
  if (row.structuralProven !== true) {
    return { allow: false, code: 'STRUCTURAL_NOT_PROVEN', message: '还没有「旧号在事务开始前就被服务端拒绝」的结构性证据 ⇒ 不迁移。' }
  }
  if (row.factAbsentProven !== true) {
    return { allow: false, code: 'FACT_NOT_PROVEN_ABSENT', message: '还没有「云端确实没有这条业务事实」的证据 ⇒ 不迁移。' }
  }
  return { allow: true, code: 'ALLOW_ONE_TIME_MIGRATION', message: '号结构上无法送达 + 云端已证明无此事实 ⇒ 允许**一次性**换迁移号（业务内容与队列顺序不变）。' }
}

// ── 四项冲突检查的**展示**（放行依据仍只有一处：requestIdRule.migrationPlanOf）──
// ⚠️ 这里必须用**整队**参与判定：新号一旦与队列里别的条目撞号，就会把两条业务并成一条。
//    上一版只把「目标条目 + 归档」喂给 migrationPlanOf，**漏掉了队列里的其它号** —— 测试当场抓到。
//    现在把"整队"作为硬输入，并在 precheckOf 里显式要求调用方传的队列**确实包含目标条目**
//    （漏传会让这道检查静默空转，比少写一行代码更危险）。
function collisionOf(entry, entries, failed, planRow) {
  const queueIds = new Set()
  ;(Array.isArray(entries) ? entries : []).forEach(item => { if (item && typeof item.requestId === 'string') queueIds.add(item.requestId) })
  const failedIds = new Set()
  ;(Array.isArray(failed) ? failed : []).forEach(item => { if (item && typeof item.requestId === 'string') failedIds.add(item.requestId) })
  const planned = planRow ? planRow.newRequestId : null
  const oldId = entry ? entry.requestId : null
  return {
    legal: requestIdRule.isLegalRequestId(planned),
    differs: !!planned && planned !== oldId,
    notInQueue: !!planned && !queueIds.has(planned),
    notInFailed: !!planned && !failedIds.has(planned),
    planCount: planRow ? 1 : 0,
    queueCount: queueIds.size, failedCount: failedIds.size,
    refusals: []
  }
}

// ── 只读预演：把"这一次要做什么、凭什么能做"完整摊开（**不写任何东西**）──
// 入参：entry（目标条目）、entries（整队）、failed（归档）、diagnose（booking 级只读诊断原始响应）、
//        receiptState（由页面用同一份回执结论函数判好，避免这里再抄一份）。
function precheckOf(input) {
  const source = input || {}
  const at = Number(source.at || Date.now())
  const entry = source.entry || null
  const entries = Array.isArray(source.entries) ? source.entries : []
  const failed = Array.isArray(source.failed) ? source.failed : []
  const gate = targetGateOf(entry)
  const facts = factsOf({ diagnose: source.diagnose, receipt: source.receipt })
  // 硬前提：队列清单**必须包含目标条目**。否则"不与队列撞号"这道检查会**静默空转**
  // （少了那道保险却不报错，比少写一行代码危险得多）⇒ 直接拒绝，让人把队列传全。
  // ⚠️ 这一道只挡得住"漏掉目标条目"；**"只传了队列的一部分"在入参层面挡不住**
  //    （函数无从知道真实队列有多长）⇒ 页面必须传整队（outbox.list）；而**执行阶段**是从桶里整份读的，
  //    那一步天然完整，所以"最终判定"不依赖调用方自觉。
  const listed = entries.some(item => String(item && item.entryId) === MIGRATION_TARGET.entryId)
  const planAll = requestIdRule.migrationPlanOf(entries, failed)
  const planRow = (planAll.plans || []).filter(row => String(row.entryId) === MIGRATION_TARGET.entryId)[0] || null
  const refusal = (planAll.refusals || []).filter(row => String(row.entryId) === MIGRATION_TARGET.entryId)[0] || null
  const collision = collisionOf(entry, entries, failed, planRow)
  collision.refusals = planAll.refusals || []
  const base = {
    mode: 'preview', at, rule: MIGRATION_RULE, target: clone(MIGRATION_TARGET),
    structuralEvidence: STRUCTURAL_EVIDENCE, structuralProven: true,
    facts, gate, collision,
    queueCount: entries.length, failedCount: failed.length,
    // 目标那条被判定的结果：1 = 已算出可用的新号（四项检查全过）；0 = 被拒（原因在 refusals 里）。
    // 它与 collision 的四项是"同一件事的两种呈现"，测试里有一条等价断言钉住二者永远一致。
    planCount: planRow ? 1 : 0,
    refusal: refusal || null,
    oldRequestId: entry ? (entry.requestId === undefined ? null : entry.requestId) : null,
    newRequestId: planRow ? planRow.newRequestId : null,
    escapers: planRow ? planRow.escapers : null
  }
  if (!gate.ok) return { ...base, ok: false, code: gate.code, message: gate.message, decision: null, refusals: planAll.refusals }
  if (!listed) {
    return {
      ...base, ok: false, code: 'ENTRY_LIST_INCOMPLETE', decision: null, refusals: planAll.refusals,
      message: '传入的队列清单里没有目标条目 ⇒ 「新号不与队列撞号」这道检查做不了 ⇒ 拒绝（宁可停手，也不静默少一道保险）。'
    }
  }
  const decision = migrationGateOf({
    verdict: gate.verdict, receiptState: source.receiptState,
    factPresent: facts.factPresent, factAbsentProven: facts.factAbsentProven, structuralProven: true
  })
  if (!decision.allow) return { ...base, ok: false, code: decision.code, message: decision.message, decision, refusals: planAll.refusals }
  if (!planRow) {
    return {
      ...base, ok: false, code: 'PLAN_REFUSED', decision, refusals: planAll.refusals,
      message: '新号没能通过四项检查：' + (refusal ? text(refusal.code) + ' ' + text(refusal.reason) : '这条没有被算出迁移计划')
    }
  }
  return { ...base, ok: true, code: 'PREVIEW_OK', message: '预演通过：' + MIGRATION_TARGET.label + ' 可做一次性换号（' + decision.message + '）', decision, refusals: [] }
}

// ── 指纹 / diff：用来证明"只动了该动的两处" ────────────────────────────────
// 除 `requestId` 与 `migration` 之外的**所有字段**（payload / command / entryId / 业务引用 / createdAt /
// status / attempts / seq …）都参与指纹 —— 任何一个字节变了都算改坏了。
function entryDigestOf(entry) {
  const copy = Object.assign({}, entry || {})
  delete copy.requestId
  delete copy.migration
  return sha256(stableStringify(copy))
}
// 队列里**除目标条目外**的全部内容指纹（含顺序）。用它证明"没顺手动别的条目"。
function othersDigestOf(bucket, entryId) {
  const rows = (bucket && Array.isArray(bucket.entries) ? bucket.entries : [])
    .filter(entry => String(entry && entry.entryId) !== String(entryId))
  return { count: rows.length, digest: sha256(stableStringify(rows)) }
}
// 逐字段 diff：缺了哪些键、多了哪些键、改了哪些键；只有"改动 ⊆ {requestId, migration}"才算干净。
function diffOf(before, after) {
  const a = before || {}, b = after || {}
  const keysBefore = Object.keys(a)
  const keysAfter = Object.keys(b)
  const missing = keysBefore.filter(key => !Object.prototype.hasOwnProperty.call(b, key))
  const added = keysAfter.filter(key => !Object.prototype.hasOwnProperty.call(a, key))
  const changed = keysBefore.filter(key => Object.prototype.hasOwnProperty.call(b, key) && stableStringify(a[key]) !== stableStringify(b[key]))
  const unexpected = changed.filter(key => ALLOWED_CHANGED_FIELDS.indexOf(key) < 0)
  const addedUnexpected = added.filter(key => ALLOWED_CHANGED_FIELDS.indexOf(key) < 0)
  return {
    missing, added, changed, unexpected, addedUnexpected,
    ok: !missing.length && !unexpected.length && !addedUnexpected.length,
    digestBefore: entryDigestOf(a), digestAfter: entryDigestOf(b)
  }
}

// ── 备份（只备份**这一条**）＋ 回读校验 ────────────────────────────────────
function backupOf(entry, bucketVersion, at) {
  return {
    format: BACKUP_FORMAT, at, entryId: String((entry && entry.entryId) || ''),
    bucketVersion: Number(bucketVersion || 0), rule: MIGRATION_RULE,
    entry: clone(entry), checksum: sha256(stableStringify(entry))
  }
}
function verifyBackupOf(backup) {
  const row = backup || {}
  if (row.format !== BACKUP_FORMAT) return { ok: false, code: 'BACKUP_FORMAT_INVALID', message: '备份格式不对。' }
  if (!row.entry || typeof row.entry !== 'object') return { ok: false, code: 'BACKUP_ENTRY_MISSING', message: '备份里没有条目内容。' }
  if (String(row.entry.entryId || '') !== String(row.entryId || '')) return { ok: false, code: 'BACKUP_ENTRY_MISMATCH', message: '备份的 entryId 与内容不一致。' }
  const checksum = sha256(stableStringify(row.entry))
  if (checksum !== row.checksum) return { ok: false, code: 'BACKUP_CHECKSUM_MISMATCH', message: '备份校验和不符（内容可能损坏）—— 拒绝继续。' }
  return { ok: true, code: 'BACKUP_OK', message: '备份回读校验通过。', checksum }
}

// 迁移后的条目 = 原条目 + 新号 + **审计字段**（其余字段逐字节不动；`updatedAt` 也不动 —— 让 diff 最强）。
function migratedEntryOf(entry, newRequestId, evidence, at) {
  const next = clone(entry) || {}
  const from = next.requestId
  next.requestId = newRequestId
  next.migration = {
    rule: MIGRATION_RULE, from: from === undefined ? null : from, to: newRequestId, at,
    reason: 'INVALID_REQUEST_ID_CHARS', structuralEvidence: STRUCTURAL_EVIDENCE, evidence: clone(evidence) || null
  }
  return next
}

function readBucketOf(storage, bucketKey) {
  const raw = storage.get(bucketKey)
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return null
  return clone(raw)
}

// ═══ 执行：备份 → 只改这一条 → 立即回读 → （不通过就自动回滚）═══════════════
// **本函数不会发送任何东西**：它只 read/write 本机 Storage。
function applyMigration(input) {
  const source = input || {}
  const storage = source.storage
  const bucketKey = source.bucketKey
  const at = Number(source.at || Date.now())
  const preview = source.preview || null
  const fail = (code, message, extra) => Object.assign({ ok: false, mode: 'commit', at, code, message }, extra || {})
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') return fail('NO_STORAGE', '缺少本机存储入口。')
  const bucket = readBucketOf(storage, bucketKey)
  if (!bucket) return fail('BUCKET_INVALID', '本机队列读不出来（结构无效）⇒ 一动不动。')
  const index = bucket.entries.findIndex(entry => String(entry && entry.entryId) === MIGRATION_TARGET.entryId)
  if (index < 0) return fail('TARGET_NOT_IN_QUEUE', '队列里没有 ' + MIGRATION_TARGET.entryId + ' ⇒ 不新建、不猜测。')
  const entry = bucket.entries[index]
  // 执行前**再次**验证：目标 + 旧号确实非法 + 状态允许（不信任任何上一次的结论）。
  const gate = targetGateOf(entry)
  if (!gate.ok) return fail(gate.code, gate.message, { gate })
  // 预演必须新鲜且指向同一条、同一个旧号、同一个新号 —— 否则"证据"就不是针对当前这条的。
  if (!preview || preview.mode !== 'preview' || preview.ok !== true) return fail('NO_FRESH_PREVIEW', '没有"已通过的只读预演"⇒ 拒绝执行（先点「预演迁移（只读）」）。')
  if (!(at - Number(preview.at || 0) >= 0) || at - Number(preview.at || 0) > PREVIEW_TTL_MS) {
    return fail('PREVIEW_STALE', '预演已过期（超过 ' + Math.round(PREVIEW_TTL_MS / 60000) + ' 分钟）⇒ 请重新预演。')
  }
  if (String(preview.target ? preview.target.entryId : '') !== MIGRATION_TARGET.entryId || preview.oldRequestId !== entry.requestId) {
    return fail('PREVIEW_MISMATCH', '预演针对的不是当前这条（旧号已变）⇒ 拒绝执行。')
  }
  const failedRows = typeof source.failed === 'function' ? source.failed() : source.failed
  // 新号：**重新算一遍**四项检查（队列/归档都可能已变），并要求与预演算出的新号一致。
  // ⚠️ 必须把**整队**喂进去：只喂目标条目会整类漏掉"新号与队列里别的条目撞号"
  //    （测试当场抓到过：那种情况下新号被放行，两件事会并成一条业务）。
  const planAll = requestIdRule.migrationPlanOf(bucket.entries, failedRows)
  const planRow = (planAll.plans || []).filter(row => String(row.entryId) === MIGRATION_TARGET.entryId)[0] || null
  const refusal = (planAll.refusals || []).filter(row => String(row.entryId) === MIGRATION_TARGET.entryId)[0] || null
  if (!planRow) {
    return fail('PLAN_REFUSED', '新号没通过四项检查：' + text(refusal && refusal.code) + ' ' + text(refusal && refusal.reason), { refusals: planAll.refusals })
  }
  if (!preview.newRequestId || preview.newRequestId !== planRow.newRequestId) {
    return fail('PREVIEW_NEW_ID_MISMATCH', '当前算出的新号与预演时不一致（队列内容已变）⇒ 请重新预演。')
  }
  // 备份（只备份这一条）+ 回读校验；备份没落稳就绝不进入写阶段。
  const backup = backupOf(entry, bucket.version, at)
  storage.set(MIGRATION_BACKUP_KEY, backup)
  const backupCheck = verifyBackupOf(storage.get(MIGRATION_BACKUP_KEY))
  if (!backupCheck.ok) return fail('BACKUP_NOT_PERSISTED', '备份没有落盘或回读校验失败 ⇒ 队列一个字都没动。', { backupCheck })
  // 写：**只替换这一条的 requestId**（外加审计字段），version +1（与 outbox 自身的写入口径一致）。
  const before = clone(entry) || {}
  const othersBefore = othersDigestOf(bucket, MIGRATION_TARGET.entryId)
  const versionBefore = Number(bucket.version || 0)
  const evidence = {
    structural: STRUCTURAL_EVIDENCE,
    decision: preview.decision ? preview.decision.code : null,
    receipt: (preview.facts && preview.facts.receipt) || null,
    facts: clone(preview.facts) || null,
    previewAt: preview.at || null
  }
  const next = Object.assign({}, bucket, {
    version: versionBefore + 1,
    entries: bucket.entries.map((item, position) => position === index ? migratedEntryOf(item, planRow.newRequestId, evidence, at) : item)
  })
  storage.set(bucketKey, next)
  // **立即回读**：五道校验全过才算成功。
  const after = readBucketOf(storage, bucketKey)
  if (!after) return rollbackNow(storage, bucketKey, bucket, 'READBACK_INVALID')
  const found = after.entries.filter(item => String(item && item.entryId) === MIGRATION_TARGET.entryId)[0] || null
  const diff = diffOf(before, found)
  const othersAfter = othersDigestOf(after, MIGRATION_TARGET.entryId)
  const checks = {
    versionAdvanced: Number(after.version || 0) === versionBefore + 1,
    countSame: after.entries.length === bucket.entries.length,
    entryStillThere: !!found,
    newIdApplied: !!found && found.requestId === planRow.newRequestId,
    diffClean: diff.ok,
    othersUnchanged: othersAfter.digest === othersBefore.digest && othersAfter.count === othersBefore.count
  }
  const allOk = Object.keys(checks).every(key => checks[key] === true)
  if (!allOk) return rollbackNow(storage, bucketKey, bucket, 'VERIFY_FAILED', { checks, diff, versionBefore, versionAfter: Number(after.version || 0) })
  return {
    ok: true, mode: 'commit', at, code: 'MIGRATED_ONE', message: '已迁移 1 条（只改本机队列，**未发送**）。',
    entryId: MIGRATION_TARGET.entryId, oldRequestId: before.requestId, newRequestId: planRow.newRequestId,
    escapers: planRow.escapers, changedFields: diff.changed, addedFields: diff.added,
    untouchedFields: Object.keys(before).length - diff.changed.length, checks,
    versionBefore, versionAfter: Number(after.version || 0),
    allFieldsDigestBefore: diff.digestBefore, allFieldsDigestAfter: diff.digestAfter,
    backupAt: backup.at, backupChecksum: backup.checksum, gate, decision: preview.decision || null
  }
}

// 校验不通过 ⇒ **原地回滚**：把改动前那份整桶写回，再回读确认版本号回到原值。
// 绝不"先留着坏状态等人工"，因为这个设施本身就在修一条救命的幂等身份。
function rollbackNow(storage, bucketKey, snapshot, code, extra) {
  let rolled = false
  let mismatches = []
  try {
    storage.set(bucketKey, snapshot)
    const back = readBucketOf(storage, bucketKey)
    // ⚠️ 判据必须**逐字节**。上一版只看「version + 条数」—— 而写入路径本身出问题时（例如有个坏写入
    //    把内容改坏了），回滚写下去的同样会被改坏，version 与条数却照样对得上 ⇒ **把失败报成成功**。
    if (back) {
      rolled = stableStringify(back) === stableStringify(snapshot)
      if (!rolled) mismatches = Object.keys(snapshot).filter(key => stableStringify(snapshot[key]) !== stableStringify(back[key]))
    } else { mismatches = ['READBACK_INVALID'] }
  } catch (error) { rolled = false; mismatches = ['ROLLBACK_WRITE_THREW'] }
  return Object.assign({
    ok: false, mode: 'commit', code: 'VERIFY_FAILED_AUTO_ROLLED_BACK',
    message: rolled
      ? '迁移后回读校验不通过（' + stringifyCode(code) + '），已按备份**自动回滚**：队列回到迁移前。'
      : '迁移后回读校验不通过，且自动回滚也没能回到迁移前（差异字段：' + mismatches.join(' / ') +
        '）⇒ 立即停手并回报，别再对这条队列做任何操作。',
    rolledBack: rolled, rollbackMismatches: mismatches
  }, extra || {})
}

function stringifyCode(code) { return code === 'READBACK_INVALID' ? '回读结构无效' : String(code || '校验未通过') }

// ── 回滚入口：把 requestId 还原成旧号（只动这一条；条目已出队则**拒绝**，绝不复活）──
function rollbackOf(input) {
  const source = input || {}
  const storage = source.storage
  const bucketKey = source.bucketKey
  const at = Number(source.at || Date.now())
  const fail = (code, message, extra) => Object.assign({ ok: false, mode: 'rollback', at, code, message }, extra || {})
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') return fail('NO_STORAGE', '缺少本机存储入口。')
  const backup = storage.get(MIGRATION_BACKUP_KEY)
  const backupCheck = verifyBackupOf(backup)
  if (!backupCheck.ok) return fail(backupCheck.code, '没有可用的迁移备份（' + backupCheck.message + '）⇒ 不执行回滚。')
  if (String(backup.entryId || '') !== MIGRATION_TARGET.entryId) return fail('BACKUP_NOT_THE_TARGET', '备份不是目标条目的 ⇒ 拒绝回滚。')
  const bucket = readBucketOf(storage, bucketKey)
  if (!bucket) return fail('BUCKET_INVALID', '本机队列读不出来 ⇒ 一动不动。')
  const index = bucket.entries.findIndex(entry => String(entry && entry.entryId) === MIGRATION_TARGET.entryId)
  if (index < 0) return fail('ENTRY_NOT_IN_QUEUE', '这条已不在队列里（可能已被补发出队）⇒ **拒绝回滚**，绝不把它复活。')
  const current = bucket.entries[index]
  if (current.requestId === backup.entry.requestId) {
    return { ok: true, mode: 'rollback', at, code: 'ALREADY_ROLLED_BACK', message: '这条的号已经是原始旧号，无需回滚。', requestId: current.requestId }
  }
  const othersBefore = othersDigestOf(bucket, MIGRATION_TARGET.entryId)
  const versionBefore = Number(bucket.version || 0)
  const next = Object.assign({}, bucket, {
    version: versionBefore + 1,
    entries: bucket.entries.map((item, position) => position === index ? clone(backup.entry) : item)
  })
  storage.set(bucketKey, next)
  const after = readBucketOf(storage, bucketKey)
  const found = after ? after.entries.filter(item => String(item && item.entryId) === MIGRATION_TARGET.entryId)[0] || null : null
  const othersAfter = othersDigestOf(after || {}, MIGRATION_TARGET.entryId)
  const checks = {
    versionAdvanced: !!after && Number(after.version || 0) === versionBefore + 1,
    countSame: !!after && after.entries.length === bucket.entries.length,
    entryStillThere: !!found,
    requestIdRestored: !!found && found.requestId === backup.entry.requestId,
    migrationFieldGone: !!found && !Object.prototype.hasOwnProperty.call(found, 'migration'),
    othersUnchanged: othersAfter.digest === othersBefore.digest && othersAfter.count === othersBefore.count,
    digestMatchesBackup: !!found && entryDigestOf(found) === entryDigestOf(backup.entry)
  }
  const allOk = Object.keys(checks).every(key => checks[key] === true)
  if (!allOk) {
    try { storage.set(bucketKey, bucket) } catch (error) { /* 尽力还原；结果如实报出 */ }
    return fail('ROLLBACK_VERIFY_FAILED', '回滚后回读校验不通过（已尝试还原到回滚前状态）⇒ 停手回报。', { checks })
  }
  return {
    ok: true, mode: 'rollback', at, code: 'ROLLED_BACK', message: '已回滚 1 条：requestId 还原为原始旧号（只改本机队列，**未发送**）。',
    entryId: MIGRATION_TARGET.entryId, requestId: found.requestId, checks,
    versionBefore, versionAfter: Number(after.version || 0)
  }
}

// ── 人读报告（可复制）────────────────────────────────────────────────────
function migrateTextOf(record) {
  const row = record || {}
  const lines = []
  const head = row.mode === 'commit' ? '执行' : row.mode === 'rollback' ? '回滚' : '预演（只读）'
  lines.push('# 单条 requestId 迁移 · ' + head + ' ' + text(row.atText) + ' ｜ 冻结=' + (row.frozen ? '生效' : '★未生效★') +
    ' ｜ 规则=' + MIGRATION_RULE + ' ｜ 只改本机队列，未发送任何命令')
  lines.push('目标：' + (row.target ? row.target.label : MIGRATION_TARGET.label) + ' ｜ entryId=' + text(row.target ? row.target.entryId : MIGRATION_TARGET.entryId))
  lines.push('结论：' + (row.ok ? '✅ ' : '⛔ ') + text(row.code) + ' ｜ ' + text(row.message))
  if (row.oldRequestId !== undefined) lines.push('旧号 = ' + JSON.stringify(row.oldRequestId === undefined ? null : row.oldRequestId))
  if (row.newRequestId) lines.push('新号 = ' + JSON.stringify(row.newRequestId) + (row.escapers ? '（转义 ' + row.escapers + ' 个字符）' : ''))
  const facts = row.facts
  if (facts) {
    lines.push('')
    lines.push('证据（全部只读取得）：')
    lines.push('  · 结构性：' + text(row.structuralEvidence) + '（校验在事务之前 ⇒ 事务从未开始；由测试对云函数源码逐次核验）')
    lines.push('  · 旧号回执：' + text(facts.receipt ? ('ok=' + facts.receipt.ok + ' ｜ code=' + facts.receipt.code) : '未取得'))
    lines.push('  · 云端事实：completeBooking succeeded 回执 ' + facts.completeReceiptCount + ' 条（该 booking 回执共 ' + facts.receiptTotal + ' 条）')
    lines.push('  · booking.status=' + text(facts.bookingStatus) + ' ｜ incomes=' + text(facts.incomeCount) + ' 条 ｜ 机器分类=' + text(facts.state) + (facts.strictState ? '（strict）' : ''))
    lines.push('  · 课时包：used=' + text(facts.packageUsed) + ' / remaining=' + text(facts.packageRemaining) + ' ｜ 本次是否扣课=' + text(facts.packageVerdict) + '（推论：完课三件套皆无 ⇒ 未发生）')
    lines.push('  · 「云端确实没有这条事实」=' + (facts.factAbsentProven ? '成立' : '不成立') + (facts.factAbsentProven ? '' : ' ｜ 原因：' + facts.reasons.join('；')))
    if (facts.factPresent) lines.push('  ⛔ 云端**已有**该业务事实 ⇒ 禁止换号。')
  }
  const collision = row.collision
  if (collision) {
    lines.push('')
    lines.push('新号四项检查：合法=' + (collision.legal ? 'Y' : 'n') + ' ｜ ≠旧号=' + (collision.differs ? 'Y' : 'n') +
      ' ｜ 不撞队列=' + (collision.notInQueue ? 'Y' : 'n') + ' ｜ 不撞归档=' + (collision.notInFailed ? 'Y' : 'n'))
    ;(collision.refusals || []).forEach(item => lines.push('  ⛔ 拒绝 ' + text(item.entryId) + ' ｜ ' + text(item.code) + ' ｜ ' + text(item.reason)))
  }
  if (row.checks) {
    lines.push('')
    lines.push('回读校验：' + Object.keys(row.checks).map(key => key + '=' + (row.checks[key] ? 'Y' : 'n')).join(' ｜ '))
  }
  if (row.changedFields) {
    lines.push('改动字段=' + JSON.stringify(row.changedFields) + ' ｜ 新增字段=' + JSON.stringify(row.addedFields || []) +
      ' ｜ 其余 ' + text(row.untouchedFields) + ' 个字段逐字节未变')
  }
  if (row.versionBefore !== undefined) lines.push('队列 version ' + text(row.versionBefore) + ' → ' + text(row.versionAfter))
  if (row.message && row.code === 'VERIFY_FAILED_AUTO_ROLLED_BACK') lines.push('⚠️ 已自动回滚：' + text(row.rolledBack ? '是' : '否（立即回报）'))
  lines.push('')
  lines.push('（本步**没有发送、没有调用 execute、未解冻**；发送仍需另行点「补发下一条」。）')
  return lines.join('\n')
}

// 收集一次预演所需的只读输入：整队 + 归档 + 目标条目（**只读**，不改任何东西）。
function inspectOf(outboxLike, scope) {
  const entries = outboxLike.list(scope)
  const failed = outboxLike.failed(scope)
  const entry = entries.filter(item => String(item && item.entryId) === MIGRATION_TARGET.entryId)[0] || null
  return { entries, failed, entry }
}

module.exports = {
  MIGRATION_LOG_KEY, MIGRATION_BACKUP_KEY, MIGRATION_RULE, BACKUP_FORMAT, PREVIEW_TTL_MS,
  MIGRATABLE_STATUS, ALLOWED_CHANGED_FIELDS, STRUCTURAL_EVIDENCE, MIGRATION_TARGET,
  stableStringify, targetGateOf, factsOf, migrationGateOf, collisionOf, precheckOf,
  entryDigestOf, othersDigestOf, diffOf, backupOf, verifyBackupOf, migratedEntryOf,
  applyMigration, rollbackOf, migrateTextOf, inspectOf
}
