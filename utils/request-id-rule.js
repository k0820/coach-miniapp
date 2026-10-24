// requestId 的**格式口径**：服务端唯一裁判是
//   cloudfunctions/coachBusinessCommand/core.js 的 validateRequestId()
//   = typeof value === 'string' && /^[A-Za-z0-9:_-]{8,128}$/
// 客户端也有一份**逐字相同**的副本：utils/cloud-command-contract.js 的 validateCommandEnvelope()。
// 本模块把它抽出来，供**只读自检**与**受控迁移**共用同一份判定 —— 不允许任何地方再手抄一份正则
// （历史上 `tbdContext` 那次就是因为两份口径不同步，白烧了一轮部署）。
//
// 为什么要有它：历史真机上曾有一条旧格式 requestId 查回执时被云端拒绝 `INVALID_REQUEST_ID`。
// 根因是**历史生成规则**（不是数据损坏）：
//   session.js 把「本机身份」拼成 commandKey → operationId(commandKey) → 持久化成 requestId，
//   而本机身份在「预约尚未转正」时是 pending:<bookingKey>，
//   bookingKey = [studentId, packageId, date, hour, minute].join('|')  （pending-booking-request.js:33）
//   ⇒ requestId 里出现了 `|`（U+007C），而白名单 `[A-Za-z0-9:_-]` **不含它**。
// 这类号**结构性无法被服务端识别**：它连"被受理"这件事都做不到 —— execute 与 getReceipt 都在
// validateRequestId 上先抛错（core.js:45 / core.js:196），事务根本不会开始。
const REQUEST_ID_PATTERN = '^[A-Za-z0-9:_-]{8,128}$'
const REQUEST_ID_RULE = /^[A-Za-z0-9:_-]{8,128}$/
const REQUEST_ID_MIN = 8
const REQUEST_ID_MAX = 128
// 迁移号的前缀。存在的意义是**可证明的新颖性**：带这个前缀的号必然等于"本机自己造的、从未出过网"的号，
// 因为本项目所有历史生成器（mutate.generatedRequestId / factRequestId / ui-cloud-command.newId /
// adapter 默认 requestId / activate_ 前缀）都不会产出以 `mig1_` 开头的串。
const MIGRATION_PREFIX = 'mig1_'
// 非法字符的确定性命转义：`_x` + 4 位十六进制 + `_`。这些字符（`_`、`x`、0-9a-f）全部在白名单里，
// 所以转义后的串一定合法；而 `_` 本身不需要转义 ⇒ 合法字符原样保留、只动非法的那几个。
const ESCAPE_HEAD = '_x'
const ESCAPE_TAIL = '_'

function isLegalRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_RULE.test(value)
}

// ============ ★ 唯一 requestId 契约（2026-09-28 §110）============
// 真机第 6 次同型事故：`draft_pending:stu|pkg|date|11|0_mu6mr…` / `completeBooking:pending:…|…_mu6ms…`
// 被云端 `requestId 无效。` 拒收，而**没有任何一处客户端代码挡住它**。三条彼此独立的缺口：
//   ① 生成端：requestId 由「业务 key」直接拼出，而业务 key 用 `|` 分隔（pending-booking-request.js 的 bookingKey），
//      `|` 不在白名单 ⇒ 出生的那一刻就是非法号（`|` 是业务键的分隔符，不能改，只能改 requestId 的派生方式）；
//   ② 发送端：`cloud-primary-adapter.execute()` **只校验 command 白名单，不校验 requestId** ⇒ 非法号照发出网；
//   ③ 校验副本：`cloud-command-contract.validateCommandEnvelope()` 确实有这道闸，但它**只被本地假引擎
//      cloud-command-engine.js:583 调用**（测试用）⇒ 真实出网路径从来没走过它。锁挂在一扇没人走的门上。
//
// 修法：**全项目只允许这一处产出 requestId 的最终形态**——`normalizeRequestId()` / `wireRequestId()`。
// 关键设计 = **不改盘上的号，只在出网边界用「确定性别名」**：
//   · 盘上 requestId 保持原样 ⇒ 原号继续是业务幂等身份，可诊断、可溯源、绝不「失败后换号」；
//   · 出网时用一个从原号**确定性派生**的合法别名发送 + 查回执 ⇒ 同一原号永远得到同一别名，
//     杀进程、重启、换设备都一致 ⇒ 幂等身份不靠记忆维持；
//   · 为什么这条是安全的：非法号在云端是**结构性不可能被受理**的（core.js 的 validateRequestId
//     在 db.runTransaction 之前抛错 ⇒ 事务从未开始 ⇒ 不可能留下任何业务事实或回执）
//     ⇒ 用别名送达是这条业务事实的**第一次**送达，不是重放，不会重复扣课 / 重复收入。
const sha256 = require('./sha256').sha256
const WIRE_HASH_PREFIX = MIGRATION_PREFIX + 'h_'   // 超长号的确定性哈希兜底（`mig1_h_<hex40>`）
const WIRE_HASH_HEX = 40

// 归一化：合法原样返回；非法 ⇒ 确定性别名。**纯函数**：同输入永远同输出。
function normalizeRequestId(value) {
  if (typeof value !== 'string') return { ok: false, changed: false, requestId: null, code: 'NOT_A_STRING', reason: '不是字符串。' }
  if (isLegalRequestId(value)) return { ok: true, changed: false, requestId: value, code: 'ALREADY_LEGAL', length: value.length }
  const escaped = migratedRequestId(value)
  // 转义后仍然装不下（超长）⇒ 用**确定性哈希**兜底：绝不截断（截断会把两条不同的业务并成一条）。
  if (!escaped.ok || !escaped.requestId || escaped.requestId.length > REQUEST_ID_MAX) {
    const hashed = WIRE_HASH_PREFIX + sha256(value).slice(0, WIRE_HASH_HEX)
    if (!isLegalRequestId(hashed)) return { ok: false, changed: false, requestId: null, code: 'CANNOT_NORMALIZE', reason: '无法在不截断的前提下归一化。' }
    return { ok: true, changed: true, requestId: hashed, code: 'HASHED', length: hashed.length, original: value }
  }
  return { ok: true, changed: true, requestId: escaped.requestId, code: escaped.code, length: escaped.requestId.length, original: value }
}

// 出网边界专用：拿一个**云端一定认得**的号。归一化不了 ⇒ 返回 null（调用方必须 fail closed，不许出网）。
function wireRequestId(value) {
  const normalized = normalizeRequestId(value)
  return normalized.ok ? normalized.requestId : null
}

// 云端是否**明确**说过这个号无效 —— 是 ⇒ 可证明「云端从未受理过它」（校验在事务之前）。
// 判据只能认云端自己吐出来的码/原文，绝不猜：网络失败、超时一律不算。
function cloudRejectedRequestId(lastError) {
  const error = lastError || {}
  const code = String(error.code || '')
  const text = String(error.technicalMessage || error.message || '')
  if (code === 'INVALID_REQUEST_ID') return true
  return /requestId\s*无效|INVALID_REQUEST_ID/i.test(text)
}

// 逐字符找出非法位置（含码点），让人能一眼看到到底是哪个字符在犯规 —— 而不是只知道"不合法"。
function illegalCharsOf(value) {
  if (typeof value !== 'string') return []
  const rows = []
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (!/[A-Za-z0-9:_-]/.test(char)) rows.push({ index, char, codePoint: value.charCodeAt(index) })
  }
  return rows
}

function hex4(value) { return value.toString(16).toUpperCase().padStart(4, '0') }

// 判定 + 人话原因 + 机器可判的 code。**绝不用一个布尔糊过去**：
// 「不是字符串」与「含非法字符」与「长度越界」是三件事，处置也不同。
function requestIdVerdict(value) {
  if (typeof value !== 'string') {
    return {
      ok: false, code: 'NOT_A_STRING', length: null, typeofValue: value === null ? 'null' : typeof value,
      illegal: [], reason: '不是字符串（typeof=' + (value === null ? 'null' : typeof value) + '）⇒ 服务端 typeof 检查直接拒。'
    }
  }
  const length = value.length
  const illegal = illegalCharsOf(value)
  if (illegal.length) {
    const sample = illegal.slice(0, 6).map(row => '[' + row.index + ']="' + row.char + '" U+' + hex4(row.codePoint)).join(' ｜ ')
    return {
      ok: false, code: 'ILLEGAL_CHARS', length, typeofValue: 'string', illegal,
      reason: '含 ' + illegal.length + ' 个白名单外字符：' + sample + (illegal.length > 6 ? ' …' : '')
    }
  }
  if (length < REQUEST_ID_MIN) return { ok: false, code: 'TOO_SHORT', length, typeofValue: 'string', illegal: [], reason: '太短（' + length + ' < ' + REQUEST_ID_MIN + '）。' }
  if (length > REQUEST_ID_MAX) return { ok: false, code: 'TOO_LONG', length, typeofValue: 'string', illegal: [], reason: '太长（' + length + ' > ' + REQUEST_ID_MAX + '）。' }
  return { ok: true, code: 'OK', length, typeofValue: 'string', illegal: [], reason: '合法（长度 ' + length + '）。' }
}

// 一个非法号 → 一个合法的"迁移号"。**纯函数、确定性、只依赖入参**：
//   · 同一个旧号永远得到同一个新号（重跑、重启、换设备都一致）⇒ 幂等身份不靠记忆维持；
//   · 合法号原样返回（`changed=false`）⇒ 不会动任何本来就能用的号；
//   · 非法字符逐个转义，**原来的字符一个不丢**（`|` → `_x007C_`）⇒ 人还能读懂它原来是谁。
// 返回 null 表示"转不出来"（长度越界 / 非字符串）—— 这种情况必须人工决策，绝不悄悄截断。
function migratedRequestId(value) {
  const verdict = requestIdVerdict(value)
  if (verdict.ok) return { ok: true, changed: false, requestId: value, code: 'ALREADY_LEGAL', length: value.length }
  if (verdict.code === 'NOT_A_STRING') return { ok: false, changed: false, requestId: null, code: verdict.code, reason: verdict.reason }
  let escaped = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    escaped += /[A-Za-z0-9:_-]/.test(char) ? char : ESCAPE_HEAD + hex4(value.charCodeAt(index)) + ESCAPE_TAIL
  }
  const requestId = MIGRATION_PREFIX + escaped
  if (requestId.length > REQUEST_ID_MAX) {
    return { ok: false, changed: false, requestId: null, code: 'ESCAPE_TOO_LONG', length: requestId.length,
      reason: '转义后 ' + requestId.length + ' 字符，超过上限 ' + REQUEST_ID_MAX + ' ⇒ 不迁移（必须人工决策，绝不截断）。' }
  }
  if (!isLegalRequestId(requestId)) {
    return { ok: false, changed: false, requestId: null, code: 'ESCAPE_STILL_ILLEGAL', reason: '转义结果仍不合法 ⇒ 不迁移。' }
  }
  return { ok: true, changed: true, requestId, code: 'MIGRATED', length: requestId.length, escapers: verdict.illegal.length }
}

// 把整条队列一次扫完 —— 她要的是"一次性扫描全部，不要逐条踩雷"。
// 只读：只读入参数组，不碰 Storage、不调云。
function auditRequestIds(entries) {
  const rows = Array.isArray(entries) ? entries : []
  const legal = []
  const illegal = []
  rows.forEach(entry => {
    const item = entry || {}
    const verdict = requestIdVerdict(item.requestId)
    const row = {
      entryId: item.entryId || '(缺 entryId)', command: item.command || '(缺 command)',
      status: item.status || null, attempts: Number(item.attempts || 0),
      requestId: typeof item.requestId === 'string' ? item.requestId : item.requestId,
      verdict
    }
    ;(verdict.ok ? legal : illegal).push(row)
  })
  return { total: rows.length, legal, illegal, legalCount: legal.length, illegalCount: illegal.length }
}

// 迁移计划（**只读**）：给每条非法号算好"旧号 → 新号"。
// 三条硬前提（任意一条不成立就拒绝整批，不做部分迁移）：
//   ① 新号必须与旧号不同；
//   ② 新号不得与队列里任何现存 requestId 相同（否则会把两条业务并成一条）；
//   ③ 新号不得与 failed 归档里的任何 requestId 相同（归档里的号是"云端拒绝过"的，不能复用）。
function migrationPlanOf(entries, failed) {
  const rows = Array.isArray(entries) ? entries : []
  const archived = Array.isArray(failed) ? failed : []
  const taken = new Set()
  rows.forEach(entry => { if (entry && typeof entry.requestId === 'string') taken.add(entry.requestId) })
  archived.forEach(row => { if (row && typeof row.requestId === 'string') taken.add(row.requestId) })
  const plans = []
  const refusals = []
  rows.forEach(entry => {
    const item = entry || {}
    const verdict = requestIdVerdict(item.requestId)
    if (verdict.ok) return
    const migrated = migratedRequestId(item.requestId)
    if (!migrated.ok) { refusals.push({ entryId: item.entryId || null, code: migrated.code, reason: migrated.reason || '' }); return }
    if (migrated.requestId === item.requestId) { refusals.push({ entryId: item.entryId || null, code: 'NO_CHANGE', reason: '新旧同号。' }); return }
    if (taken.has(migrated.requestId)) { refusals.push({ entryId: item.entryId || null, code: 'COLLIDES_WITH_EXISTING', reason: '新号与队列/归档里已有的 requestId 相同。' }); return }
    plans.push({
      entryId: item.entryId || null, command: item.command || null, status: item.status || null,
      attempts: Number(item.attempts || 0),
      oldRequestId: item.requestId, newRequestId: migrated.requestId,
      oldReason: verdict.reason, escapers: migrated.escapers, length: migrated.length
    })
  })
  return { ok: refusals.length === 0, plans, refusals, planCount: plans.length }
}

module.exports = {
  REQUEST_ID_PATTERN, REQUEST_ID_RULE, REQUEST_ID_MIN, REQUEST_ID_MAX, MIGRATION_PREFIX,
  isLegalRequestId, illegalCharsOf, requestIdVerdict, migratedRequestId, auditRequestIds, migrationPlanOf,
  // ★ §110：唯一 requestId 契约（生成端与出网端共用同一份）
  normalizeRequestId, wireRequestId, cloudRejectedRequestId
}
