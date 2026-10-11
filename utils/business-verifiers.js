// 「业务级核验器」——**纯编排 + 注入式只读 I/O**（2026-09-23 第 23 轮）。
//
// 为什么单独一个文件：核验的判据必须能被**离线断言**（本项目的教训：假件与真服务端要同口径），
// 所以这里不 require 任何 wx / Storage / adapter —— 读云端的两件事（逐条只读诊断、按集合读回）
// 由调用方注入。页面上线时注入真实现，测试里注入假件，跑的是同一段判据。
//
// 本文件修掉了 VERIFY_FAILED 的**口径根因**：
//   旧版用"该 booking 的回执总数恰好 +1"证明"这条完课只写了一次"，而基线是**整批开始前一次性取的**。
//   恢复计划里 `updateBookingContent`（内容）就在 `completeBooking`（完课）前一条、且是同一条 booking，
//   于是跑完完课时该 booking 的回执是 **+2**（内容一条 + 完课一条）⇒ 判否 ⇒ 停手。
//   真正的账其实是平的（课时 +1 / 收入一笔 / 状态 done），被判否的只是这条**把合法前置写入当异常**的计数判据。
//   修法两条：
//     ① 基线**改为发送前即时读取**（页面侧），差量只覆盖"这一条命令"；
//     ② 回执判据从"总数 +1"改成**集合差**："新增的回执恰好一条、且就是本次 requestId"
//        （不再依赖数量，也不再被 diagnose 的 20 条窗口截断误伤）。
const POLICY_MODULE = require('./business-verification-policy')

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const text = value => value === null || value === undefined || value === '' ? '—' : String(value)
// 🩸 这里原本有一个 `sameJson = (a,b) => JSON.stringify(a) === JSON.stringify(b)`，并用于 items 比对。
//    它已删除：`JSON.stringify` 的相等是**键序敏感**的，而"字段顺序"不是业务语义
//    ⇒ 只要云端读回的 item 键序与本机 payload 的构造序不同（本项目实测就是如此），
//      它会**每一次都把正确的内容判成不一致**。嵌套结构一律用下面的 `canonicalJson` 比。
//    ⚠️ 不要因为"就一个字段"而重新引入等价的字符串相等判断。
// ── 键序无关的规范化 ──
// 🩸 2026-09-23 一手事故：`ob_2y`（updateBookingContent）**回执 succeeded、revision 155→156**，
//    却被 `booking-content` 核验器判为"items 不一致"而停手 —— 账其实全对。
//    原因：服务端 `booking.items = clone(payload.items)` 确实原样落库，但**读回来的 item 对象键序是字母序**
//    （`group,minutes,name,reps,sets,weight`），而本机 payload 的键序是 App 的构造序
//    （`exercise-picker` 抛 `{name,group}` + `session.js:163` 补 `sets,reps,weight,minutes`
//     ⇒ `name,group,sets,reps,weight,minutes`）。**字段顺序不是业务语义**，而旧判据用的
//    `JSON.stringify(a) === JSON.stringify(b)` 是**键序敏感**的 ⇒ 必然误判。
//    修法：对象比**键序无关**的规范形（与服务端 `core.js` 的 `canonical` 同一口径 —— 它本来就是
//    服务端用来定义"这两份 payload 是不是同一份"的函数）；**数组仍保序**（动作顺序是她拖出来的业务含义）。
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  return JSON.stringify(value === undefined ? null : value)
}
// 原始字符串的**首个差异字符位置**（0 基；-1 = 逐字符相同）。
// 用途：把"键序/序列化差异"与"业务内容真实不同"在同一份报告里区分开，并给出可复算的位置。
function firstDiffIndex(left, right) {
  const a = String(left == null ? '' : left), b = String(right == null ? '' : right)
  const max = Math.min(a.length, b.length)
  for (let index = 0; index < max; index += 1) if (a[index] !== b[index]) return index
  return a.length === b.length ? -1 : max
}

// ── 完课账本：只取**能对账**的字段 ──
function completionLedgerOf(diagnose) {
  if (!diagnose || !diagnose.booking) return null
  const incomes = Array.isArray(diagnose.incomes) ? diagnose.incomes : []
  const receipts = Array.isArray(diagnose.receipts) ? diagnose.receipts : []
  const completion = receipts.filter(item => item && item.command === 'completeBooking')
  return {
    state: diagnose.state === undefined ? null : diagnose.state,
    dataRevision: Number.isInteger(diagnose.dataRevision) ? diagnose.dataRevision : null,
    status: (diagnose.booking && diagnose.booking.status) || null,
    packageId: (diagnose.package && diagnose.package.packageId) || null,
    used: diagnose.package ? Number(diagnose.package.used) : null,
    remaining: diagnose.package ? Number(diagnose.package.remaining) : null,
    incomeCount: incomes.length,
    incomeIds: incomes.map(item => String((item && item.incomeId) || '')).sort(),
    receiptCount: receipts.length,
    receiptIds: receipts.map(item => String((item && item.requestId) || '')).sort(),
    completionReceiptIds: completion.map(item => String((item && item.requestId) || '')).sort()
  }
}
const LEDGER_LABELS = Object.freeze({
  statusChangedToDone: 'booking 没有变成 done',
  usedPlusOne: '课时包 used 不是恰好 +1（可能重复扣课）',
  remainingMinusOne: '课时包 remaining 不是恰好 −1',
  packageSame: '扣的不是同一个课时包（或课时包定位不到）',
  incomePlusOne: 'income 不是恰好 +1 条（可能重复记收入）',
  incomeNewId: 'income 条数对不上（未新增或新增了多条）',
  completionReceiptPlusOne: '本次的完课回执不是恰好新增一条（或不是本次 requestId）',
  thisRequestIdExactlyOnce: '本次 requestId 对应的完课回执不是恰好 1 条（存在重复回执或根本没落）',
  newReceiptExactlyOnce: '本次新增的回执不是恰好一条，或不是本次 requestId（同时段有别的写入 / 重复落条）'
})
function ledgerLabelOf(name) { return LEDGER_LABELS[name] || name }
// 差量必须是"集合差"，不能是"数量 +1"：
//   集合差不受 diagnose 的 20 条窗口截断影响，也不会把"别的时间点落下的合法回执"算成异常。
function newIdsOf(before, after) {
  const seen = new Set(Array.isArray(before) ? before.map(String) : [])
  return (Array.isArray(after) ? after.map(String) : []).filter(id => !seen.has(id))
}
function completionLedgerDelta(before, after, requestId) {
  if (!before || !after) {
    return { ok: false, checks: {}, notes: ['缺"补发前基线"或"补发后读数" ⇒ 不做无基线的差量判断（按未通过处理）。'] }
  }
  const wanted = String(requestId == null ? '' : requestId)
  const newReceiptIds = newIdsOf(before.receiptIds, after.receiptIds)
  const newCompletionIds = newIdsOf(before.completionReceiptIds, after.completionReceiptIds)
  const checks = {
    statusChangedToDone: after.status === 'done',
    usedPlusOne: Number.isInteger(before.used) && Number.isInteger(after.used) && after.used === before.used + 1,
    remainingMinusOne: Number.isInteger(before.remaining) && Number.isInteger(after.remaining) && after.remaining === before.remaining - 1,
    packageSame: !!before.packageId && before.packageId === after.packageId,
    incomePlusOne: after.incomeCount === before.incomeCount + 1,
    incomeNewId: after.incomeIds.length === before.incomeIds.length + 1,
    completionReceiptPlusOne: newCompletionIds.length === 1 && newCompletionIds[0] === wanted,
    thisRequestIdExactlyOnce: (after.completionReceiptIds || []).filter(id => id === wanted).length === 1,
    newReceiptExactlyOnce: newReceiptIds.length === 1 && newReceiptIds[0] === wanted
  }
  const notes = Object.keys(checks).filter(name => !checks[name]).map(name => ledgerLabelOf(name))
  return { ok: notes.length === 0, checks, notes, newReceiptIds, newCompletionIds }
}
// 完课目标预约的**云端正式** id（解析不出就如实说"定位不到"，绝不猜）。
function resolveBookingIdOf(entry, deps) {
  const raw = String(((entry && entry.payload) || {}).bookingId || '')
  if (!raw) return ''
  if (typeof deps.resolveId !== 'function') return /^booking_[0-9a-f]{8,}$/.test(raw) ? raw : ''
  let resolved = ''
  try { resolved = String(deps.resolveId(raw) || '') } catch (error) { resolved = '' }
  return /^booking_[0-9a-f]{8,}$/.test(resolved) ? resolved : ''
}
// 只读读回一个集合（缺读取器 / 读失败都要如实报，不许当成"通过"）。
async function readRowsOf(deps, collection) {
  if (typeof deps.readCollection !== 'function') return { ok: false, code: 'NO_READER', rows: [] }
  let answer = null
  try { answer = await deps.readCollection(collection) } catch (error) { return { ok: false, code: 'READ_THREW', message: String((error && error.message) || error), rows: [] } }
  if (!answer || answer.ok !== true) return { ok: false, code: (answer && answer.code) || 'READ_FAILED', rows: [] }
  return { ok: true, rows: Array.isArray(answer.rows) ? answer.rows : [] }
}
async function diagnoseOf(deps, bookingId) {
  if (typeof deps.diagnose !== 'function') return { ok: false, code: 'NO_DIAGNOSE' }
  let answer = null
  try { answer = await deps.diagnose(bookingId) } catch (error) { return { ok: false, code: 'DIAGNOSE_THREW', message: String((error && error.message) || error) } }
  if (!answer || answer.ok !== true) return { ok: false, code: (answer && answer.code) || 'DIAGNOSE_FAILED' }
  return { ok: true, result: answer.result || {} }
}
const rowData = row => (row && row.data) || {}
const rowBookingId = row => (row && row.bookingId) || rowData(row).id || ''
const momentMatches = (row, payload) => {
  const data = rowData(row)
  return String(data.date || '') === String(payload.date == null ? '' : payload.date) &&
    Number(data.hour) === Number(payload.hour) && Number(data.minute == null ? 0 : data.minute) === Number(payload.minute == null ? 0 : payload.minute)
}
const momentText = payload => text(payload.date) + ' ' + text(payload.hour) + ':' + text(payload.minute == null ? 0 : payload.minute)
const momentOfRow = row => {
  const data = rowData(row)
  return text(data.date) + ' ' + text(data.hour) + ':' + text(data.minute == null ? 0 : data.minute)
}
// 内容比对：**只比 payload 里给了的字段**（没给的字段不该被这条命令改）。
// 返回 `{ ok, problems, notes }`：
//   problems = **真实不一致**（键序无关口径下仍不同）⇒ 判否、停手；
//   notes    = **只是序列化/键序差异**（逐值相同）⇒ 不是业务不一致，判过，但把位置的原文报出来。
const CONTENT_FIELDS = ['items', 'notes', 'category', 'duration', 'summary']
function contentDiffOf(payload, data) {
  const problems = [], notes = []
  CONTENT_FIELDS.forEach(field => {
    if (!Object.prototype.hasOwnProperty.call(payload || {}, field)) return
    if (field === 'items') {
      const left = JSON.stringify(payload.items === undefined ? null : payload.items)
      const right = JSON.stringify(data.items === undefined ? null : data.items)
      if (left === right) return
      const index = firstDiffIndex(left, right)
      if (canonicalJson(payload.items) === canonicalJson(data.items)) {
        notes.push('items 与云端**逐值相同**，只是字段顺序（键序）不同：原始字符串长度相同（' + left.length + ' 字）' +
          (index < 0 ? '' : '、首个差异在第 ' + index + ' 个字符') + ' ⇒ 判为通过（字段顺序不是业务语义）')
        return
      }
      problems.push('items 内容**真实不一致**（键序无关口径下仍不同）：本机 ' + left.length + ' 字 vs 云端 ' + right.length + ' 字' +
        (index < 0 ? '' : '、原始字符串首个差异在第 ' + index + ' 个字符'))
      return
    }
    if (field === 'duration') {
      if (Number(payload.duration) !== Number(data.duration)) problems.push('duration 期望 ' + text(payload.duration) + ' 实际 ' + text(data.duration))
      return
    }
    if (String(payload[field] == null ? '' : payload[field]) !== String(data[field] == null ? '' : data[field])) {
      problems.push(field + ' 期望「' + String(payload[field] == null ? '' : payload[field]).slice(0, 40) + '」实际「' + String(data[field] == null ? '' : data[field]).slice(0, 40) + '」')
    }
  })
  return { ok: problems.length === 0, problems, notes }
}

// ── 逐个核验器 ──
// 返回一律是 `{ checked, ok, reason, evidence }`：
//   checked=true 表示"真的做了核验"（ok 可能是 false）；
//   做不了（缺基线 / 定位不到 / 读不到）**也算 checked=true + ok=false** —— 动钱的命令不接受"核不了就放过"。
async function verifyCompletionLedger(entry, input) {
  const deps = input.deps || {}
  const official = resolveBookingIdOf(entry, deps)
  if (!official) return { checked: true, ok: false, reason: '这条完课的云端 bookingId 定位不到（本机临时 id 尚未转正）⇒ 动钱的命令做不了对账，按未通过处理' }
  if (!input.baseline) return { checked: true, ok: false, reason: '缺少补发前的基线读数（发送前的只读诊断没取到）⇒ 不做无基线的差量判断，按未通过处理' }
  const now = await diagnoseOf(deps, official)
  if (!now.ok) return { checked: true, ok: false, reason: '补发后只读诊断失败：' + text(now.code) }
  const after = completionLedgerOf(now.result)
  const delta = completionLedgerDelta(input.baseline, after, entry.requestId)
  return {
    checked: true, ok: delta.ok,
    reason: delta.ok ? '课时恰好扣一次、收入恰好记一笔、本次回执恰好一条' : delta.notes.join('；'),
    evidence: { bookingId: official, before: input.baseline, after, newReceiptIds: delta.newReceiptIds, checks: delta.checks }
  }
}
async function verifyBookingMoment(entry, input) {
  const deps = input.deps || {}
  const payload = (entry && entry.payload) || {}
  const official = resolveBookingIdOf(entry, deps)
  if (!official) return { checked: true, ok: false, reason: '这条改期的云端 bookingId 定位不到（本机临时 id 尚未转正）⇒ 不做无定位的判断，按未通过处理' }
  const read = await readRowsOf(deps, 'bookings')
  if (!read.ok) return { checked: true, ok: false, reason: '读回 bookings 失败：' + text(read.code) }
  const hits = read.rows.filter(row => String(rowBookingId(row)) === official)
  if (hits.length !== 1) return { checked: true, ok: false, reason: '云端按 bookingId=' + official + ' 找到 ' + hits.length + ' 条预约（必须恰好 1 条）' }
  const data = rowData(hits[0])
  const okDate = String(data.date || '') === String(payload.date == null ? '' : payload.date)
  const okHour = Number(data.hour) === Number(payload.hour)
  const okMinute = Number(data.minute == null ? 0 : data.minute) === Number(payload.minute == null ? 0 : payload.minute)
  const ok = okDate && okHour && okMinute
  return {
    checked: true, ok,
    reason: ok ? ('目标预约的时间就是 payload 指定的 ' + momentText(payload)) : ('时间没变成 payload 指定的值：期望 ' + momentText(payload) + '，云端实际 ' + momentOfRow(hits[0])),
    evidence: { bookingId: official, expected: { date: payload.date, hour: payload.hour, minute: payload.minute }, actual: { date: data.date, hour: data.hour, minute: data.minute } }
  }
}
async function verifyBookingContent(entry, input) {
  const deps = input.deps || {}
  const payload = (entry && entry.payload) || {}
  const official = resolveBookingIdOf(entry, deps)
  if (!official) return { checked: true, ok: false, reason: '这条内容的云端 bookingId 定位不到（本机临时 id 尚未转正）⇒ 按未通过处理' }
  const now = await diagnoseOf(deps, official)
  if (!now.ok) return { checked: true, ok: false, reason: '读回该预约失败：' + text(now.code) }
  const booking = (now.result && now.result.booking) || {}
  const comparison = contentDiffOf(payload, booking)
  const fields = CONTENT_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(payload, field))
  return {
    checked: true, ok: comparison.ok,
    reason: !comparison.ok ? comparison.problems.join('；')
      : (comparison.notes.length ? ('云端该预约的内容字段与 payload 逐字段一致；' + comparison.notes.join('；')) : '云端该预约的内容字段与 payload 逐字段一致'),
    evidence: { bookingId: official, problems: comparison.problems, notes: comparison.notes, fields }
  }
}
async function verifyBookingCreated(entry, input) {
  const deps = input.deps || {}
  const payload = (entry && entry.payload) || {}
  const resolve = raw => {
    const value = String(raw == null ? '' : raw)
    if (!value) return ''
    if (typeof deps.resolveId !== 'function') return value
    try { return String(deps.resolveId(value) || value) } catch (error) { return value }
  }
  const studentId = resolve(payload.studentId), packageId = resolve(payload.packageId)
  const read = await readRowsOf(deps, 'bookings')
  if (!read.ok) return { checked: true, ok: false, reason: '读回 bookings 失败：' + text(read.code) }
  // 业务键：学员 + 课时包 + 日期 + 时刻。**多一条就是重复建**（跨批次也看得出）。
  const hits = read.rows.filter(row => {
    const data = rowData(row)
    const rowStudent = String(data.studentId || (row && row.studentId) || '')
    const rowPackage = String(data.packageId || (row && row.packageId) || '')
    return rowStudent === String(studentId) && rowPackage === String(packageId) && momentMatches(row, payload)
  })
  if (hits.length !== 1) {
    return { checked: true, ok: false, reason: '按业务键（学员 ' + text(studentId) + ' + 课时包 ' + text(packageId) + ' + ' + momentText(payload) + '）在云端找到 ' + hits.length + ' 条预约（必须恰好 1 条' + (hits.length === 0 ? '，说明没建出来' : '，说明重复建了') + '）', evidence: { hits: hits.map(row => rowBookingId(row)) } }
  }
  const receiptBookingId = String((input.receiptResult && input.receiptResult.bookingId) || '')
  if (receiptBookingId && String(rowBookingId(hits[0])) !== receiptBookingId) {
    return { checked: true, ok: false, reason: '找到的那条预约 id=' + text(rowBookingId(hits[0])) + ' 与回执报告的 ' + receiptBookingId + ' 不是同一条', evidence: {} }
  }
  return { checked: true, ok: true, reason: '按业务键恰好一条，且就是回执报告的那条（' + text(rowBookingId(hits[0])) + '）', evidence: { bookingId: rowBookingId(hits[0]) } }
}
async function verifyExerciseCreated(entry, input) {
  const deps = input.deps || {}
  const payload = (entry && entry.payload) || {}
  const read = await readRowsOf(deps, 'customExercises')
  if (!read.ok) return { checked: true, ok: false, reason: '读回 customExercises 失败：' + text(read.code) }
  const hits = read.rows.filter(row => {
    const data = rowData(row)
    return String(data.name || '') === String(payload.name == null ? '' : payload.name) && String(data.group || '') === String(payload.group == null ? '' : payload.group)
  })
  if (hits.length !== 1) {
    return { checked: true, ok: false, reason: '按业务键（动作名「' + text(payload.name) + '」+ 部位「' + text(payload.group) + '」）在云端找到 ' + hits.length + ' 条（必须恰好 1 条' + (hits.length === 0 ? '，说明没建出来' : '，说明重复建了') + '）', evidence: { hits: hits.map(row => (row && row.customExerciseId) || rowData(row).id) } }
  }
  const receiptId = String((input.receiptResult && input.receiptResult.customExerciseId) || '')
  const actualId = String((hits[0] && hits[0].customExerciseId) || rowData(hits[0]).id || '')
  if (receiptId && actualId !== receiptId) {
    return { checked: true, ok: false, reason: '找到的动作 id=' + actualId + ' 与回执报告的 ' + receiptId + ' 不是同一条', evidence: {} }
  }
  return { checked: true, ok: true, reason: '按业务键恰好一条，且与回执报告的是同一条（' + actualId + '）', evidence: { customExerciseId: actualId } }
}

// ── M2 第三批：跨教练共享课时的两条核验器 ──
//
// 它们依赖一类**新的只读 I/O**：`deps.readSharedUsage(payload)` —— 对应云端
// `diagnoseSharedUsage`（一个零写入的只读云函数）。
// 为什么不能复用既有的 `readCollection`：那一条路只能读**调用方自己**那本账，
// 而这两条命令改的是**两位教练**的数据 —— 对端课时包的 reserved 变没变、对方的收据补没补，
// 本机在本账里永远看不到。
// ⚠️ 安全边界（这一条不允许放松）：`readSharedUsage` 的入参**只准**是
//    `bookingId`（本人账里的那条共享预约）/ `packageId`（本人账里的课时包）/ `shareCode`（共享码）。
//    任何 ownerCoachId / datasetId 都由**服务端**从可信身份 + 共享关系推导，
//    客户端提交定位字段会被云端直接判 `FORBIDDEN_IDENTITY_INPUT`。
const PEER_RECEIPT_COMMAND = 'sharedPackageSync'
// 跨账只读取证（注入式）。读不到 / 抛错一律按"未通过"处理 —— 读不到证据 ≠ 账是平的。
async function sharedUsageOf(deps, payload) {
  if (typeof deps.readSharedUsage !== 'function') return { ok: false, code: 'NO_SHARED_READER', fact: null }
  let answer = null
  try { answer = await deps.readSharedUsage(payload) } catch (error) { return { ok: false, code: 'SHARED_READ_THREW', message: String((error && error.message) || error), fact: null } }
  if (!answer || answer.ok !== true) return { ok: false, code: (answer && answer.code) || 'SHARED_READ_FAILED', message: (answer && answer.message) || '', fact: null }
  return { ok: true, fact: answer }
}
const stop = (checked, ok, reason, evidence) => ({ checked, ok, reason, evidence })

// ★ createSharedBooking：booking 在授课教练账里 ／ packageUsage 指向会员真实课时包 ／
//   对端 reserved 恰好 +1 ／ 双方 revision 与收据都对得上 ／ 课时没被复制到第二本账。
async function verifySharedBookingCreated(entry, input) {
  const deps = (input && input.deps) || {}
  const receiptResult = (input && input.receiptResult) || {}
  const bookingId = String(receiptResult.bookingId || '')
  // bookingId 由**服务端**生成并随回执带回（本机没有临时 id 这一说），缺了就定位不到，绝不猜。
  if (!bookingId) return stop(true, false, '回执没带回云端 bookingId ⇒ 定位不到这条共享预约，按未通过处理', {})
  const requestId = String((entry && entry.requestId) || '')
  const read = await sharedUsageOf(deps, { action: 'sharedBooking', bookingId, requestId, environment: deps.environment || 'production' })
  if (!read.ok) return stop(true, false, '跨账只读取证失败（' + text(read.code) + '）：看不到对端那本账 ⇒ 按未通过处理', { code: read.code })
  const fact = read.fact
  const problems = []
  const usage = (fact.self.booking && fact.self.booking.usage) || null
  const peerPackage = fact.peer.package
  // ① booking 确实在授课教练这本账里（且全场只有这一条）。
  if (!fact.self.booking || fact.self.booking.status == null) problems.push('云端在自己这本账里找不到这条预约')
  if (fact.uniqueness.bookingId !== 1) problems.push('这条 bookingId 在 ' + text(fact.uniqueness.bookingId) + ' 本账里有物理行（必须恰好 1 本）')
  // ② packageUsage 指向**会员那份真实课时包**（逐个字段对，不多也不少）。
  if (!usage) problems.push('这条预约没有 packageUsage，不是共享预约')
  else {
    if (receiptResult.packageId && usage.packageId !== String(receiptResult.packageId)) problems.push('packageUsage.packageId=' + text(usage.packageId) + ' 与回执报告的 ' + text(receiptResult.packageId) + ' 不一致')
    if (!fact.peer.found || !peerPackage) problems.push('packageUsage 指向的位置根本没有这个课时包（对端账里查无此行）')
    else {
      if (peerPackage.packageId !== usage.packageId) problems.push('对端课时包 id 与 packageUsage 不一致')
      if (usage.studentId && peerPackage.studentId !== usage.studentId) problems.push('对端课时包不属于 packageUsage 指定的会员（学员被掉包）')
    }
  }
  // ③ 课时没有被复制到第二本账（这是"A/B 共享"和"A 也买一套、B 也买一套"的分水岭）。
  if (fact.uniqueness.packageId !== 1) problems.push('同一个课时包在 ' + text(fact.uniqueness.packageId) + ' 本账里都有物理行 —— 课时被复制了')
  if (fact.uniqueness.studentId !== 1) problems.push('同一个会员在 ' + text(fact.uniqueness.studentId) + ' 本账里都有物理行 —— 会员被复制了')
  if (fact.uniqueness.saleId !== null && fact.uniqueness.saleId !== 1) problems.push('同一笔销售在 ' + text(fact.uniqueness.saleId) + ' 本账里都有物理行')
  // ④ 对端真实 package 的 reserved **恰好 +1**（要有发送前的基线才敢说"恰好"）。
  const baseline = (input && input.baseline) || null
  if (!baseline || !baseline.target) problems.push('缺少发送前的对端基线 ⇒ 无法证明 reserved 恰好 +1')
  else {
    if (peerPackage == null || !Number.isInteger(peerPackage.reserved)) problems.push('对端课时包读不到 reserved（字段缺失）')
    else if (peerPackage.reserved !== baseline.target.reserved + 1) problems.push('对端 reserved ' + text(baseline.target.reserved) + '→' + text(peerPackage.reserved) + '（必须恰好 +1）')
    if (Number.isInteger(baseline.target.remaining) && peerPackage && peerPackage.remaining !== baseline.target.remaining) problems.push('排课不该动 remaining（' + text(baseline.target.remaining) + '→' + text(peerPackage.remaining) + '）')
  }
  // ⑤ 双方 revision / 收据。
  const peerReceipt = fact.peer.receipt || {}
  if (!peerReceipt.found) problems.push('没有给课时包那一侧补收据 ⇒ 对方设备的增量同步会出现空洞')
  else {
    if (peerReceipt.status !== 'succeeded') problems.push('对端收据不是 succeeded（' + text(peerReceipt.status) + '）')
    if (peerReceipt.command !== PEER_RECEIPT_COMMAND) problems.push('对端收据命令名是 ' + text(peerReceipt.command) + '（必须是 ' + PEER_RECEIPT_COMMAND + '）')
    if (Number.isInteger(peerReceipt.revisionAfter) && peerReceipt.revisionAfter !== fact.peer.dataRevision) problems.push('对端收据报的 revision（' + text(peerReceipt.revisionAfter) + '）不等于当前版本（' + text(fact.peer.dataRevision) + '）')
    if (baseline && Number.isInteger(baseline.dataRevision) && fact.peer.dataRevision !== baseline.dataRevision + 1) problems.push('对端 revision ' + text(baseline.dataRevision) + '→' + text(fact.peer.dataRevision) + '（必须恰好 +1）')
  }
  const selfReceipt = fact.self.receipt || {}
  if (!selfReceipt.found) problems.push('自己这侧没有这次 requestId 的收据')
  else {
    if (selfReceipt.status !== 'succeeded') problems.push('本侧收据不是 succeeded（' + text(selfReceipt.status) + '）')
    if (selfReceipt.command !== 'createSharedBooking') problems.push('本侧收据命令名是 ' + text(selfReceipt.command) + '（必须是 createSharedBooking）')
    if (Number.isInteger(selfReceipt.revisionAfter) && selfReceipt.revisionAfter !== fact.self.dataRevision) problems.push('本侧收据报的 revision 不等于当前版本')
  }
  const ok = problems.length === 0
  return {
    checked: true, ok,
    reason: ok ? '共享预约在自己账里恰好一条、packageUsage 指向会员真实课时包、对端 reserved 恰好 +1、双方收据齐备' : problems.join('；'),
    evidence: { bookingId, requestId, self: fact.self, peer: fact.peer, uniqueness: fact.uniqueness, baseline, problems }
  }
}

// ★ setPackageShare：共享许可真实存在 ／ 指向正确的课时包 ／ **没有把会员 / 课时包 / 销售
//   复制到任何一本账里**（包括自己这本：行数不许变）。
async function verifyPackageShareState(entry, input) {
  const deps = (input && input.deps) || {}
  const payload = (entry && entry.payload) || {}
  const resolve = raw => {
    const value = String(raw == null ? '' : raw)
    if (!value) return ''
    if (typeof deps.resolveId !== 'function') return value
    try { return String(deps.resolveId(value) || value) } catch (error) { return value }
  }
  const packageId = resolve(payload.packageId)
  if (!packageId) return stop(true, false, '这条命令的 packageId 定位不到 ⇒ 查不到它是哪一份课时包，按未通过处理', {})
  const read = await sharedUsageOf(deps, { action: 'shareForPackage', packageId, environment: deps.environment || 'production' })
  if (!read.ok) return stop(true, false, '共享许可只读取证失败（' + text(read.code) + '）⇒ 按未通过处理', { code: read.code })
  const fact = read.fact
  const enabled = payload.enabled !== false
  const problems = []
  // ① share 真实存在（关闭共享时期望它变成非 active）。
  if (enabled && !fact.share.found) problems.push('云端查不到这枚共享许可')
  if (enabled && fact.share.status !== 'active') problems.push('共享许可状态是 ' + text(fact.share.status) + '（应为 active）')
  if (!enabled && fact.share.activeCount !== 0) problems.push('已经请求关闭共享，但云端仍有 ' + fact.share.activeCount + ' 枚 active 许可')
  if (enabled && fact.share.activeCount !== 1) problems.push('这个课时包名下有 ' + fact.share.activeCount + ' 枚 active 许可（必须恰好 1 枚）')
  // ② 指向正确的课时包（且这枚许可记在**本人**账上 —— 它是一枚指针，不是别人的副本）。
  if (!fact.share.packageIdMatches && fact.share.found) problems.push('共享许可指向的不是这个课时包')
  if (!fact.share.studentIdMatches && fact.share.found) problems.push('共享许可指向的不是同一个会员')
  // ③ **没有复制**：三个"全球唯一性"计数必须都是 1；自己这本账的行数也不许变。
  if (fact.uniqueness.packageId !== 1) problems.push('同一个课时包在 ' + text(fact.uniqueness.packageId) + ' 本账里有物理行 —— 课时被复制了')
  if (fact.uniqueness.studentId !== null && fact.uniqueness.studentId !== 1) problems.push('同一个会员在 ' + text(fact.uniqueness.studentId) + ' 本账里有物理行 —— 会员被复制了')
  if (fact.uniqueness.saleId !== null && fact.uniqueness.saleId !== 1) problems.push('同一笔销售在 ' + text(fact.uniqueness.saleId) + ' 本账里有物理行 —— 销售被复制了')
  // 基线是"发送前立刻读的那一份跨账事实"：`self.counts` 在自己这本账里，
  // `target` / `dataRevision` 在对端那本账里 —— 两者缺一都说不清"多了还是没多"。
  const baseline = (input && input.baseline) || null
  const baseCounts = (baseline && baseline.self && baseline.self.counts) || (baseline && baseline.counts) || null
  const counts = fact.self.counts || {}
  if (!baseCounts) {
    // setPackageShare 会改既有数据 ⇒ **必须**有基线才敢放行（与 completion-ledger 同一条铁律）。
    problems.push('缺少发送前的基线 ⇒ 无法证明"没有新建任何业务行"')
  } else {
    ;['students', 'packages', 'sales'].forEach(name => {
      if (counts[name] !== baseCounts[name]) problems.push(name + ' 行数 ' + text(baseCounts[name]) + '→' + text(counts[name]) + '（开共享不该新增任何业务行）')
    })
    // 自己这侧也必须留下一格版本：没留就等于"改了没人记账"。
    if (Number.isInteger(baseline.self && baseline.self.dataRevision) && fact.self.dataRevision !== baseline.self.dataRevision + 1) {
      problems.push('本侧 revision ' + text(baseline.self && baseline.self.dataRevision) + '→' + text(fact.self.dataRevision) + '（必须恰好 +1）')
    }
  }
  const ok = problems.length === 0
  return {
    checked: true, ok,
    reason: ok ? (enabled ? '共享许可存在且恰好一枚、指向正确的课时包与会员、课时/会员/销售均未被复制' : '共享许可已不再是 active，且课时/会员/销售均未被复制') : problems.join('；'),
    evidence: { packageId, share: fact.share, uniqueness: fact.uniqueness, counts, baseline, problems }
  }
}

const VERIFIER_FUNCS = Object.freeze({
  'completion-ledger': verifyCompletionLedger,
  'booking-moment': verifyBookingMoment,
  'booking-content': verifyBookingContent,
  'booking-created': verifyBookingCreated,
  'exercise-created': verifyExerciseCreated,
  'shared-booking-created': verifySharedBookingCreated,
  'package-share-state': verifyPackageShareState
})

// 统一入口：按 policy 点名的核验器执行。
// ⚠️ 只处理 `required` 的命令。`receipt-only` 的命令由驱动侧记中性说明（不是"未做"这种红字警报）。
async function verifyEntry(input) {
  const row = input || {}
  const requirement = row.requirement || POLICY_MODULE.requirementOf(row.entry && row.entry.command)
  if (requirement.level !== POLICY_MODULE.LEVELS.REQUIRED) {
    return { checked: false, ok: null, neutral: true, reason: requirement.why || '按策略无需业务级核验' }
  }
  const verify = VERIFIER_FUNCS[requirement.verifier]
  if (!verify) {
    // 走到这里说明门禁被绕过了 —— **按未通过处理**，绝不因为"没实现"而放过。
    return { checked: false, ok: null, reason: '策略要求业务级核验（' + text(requirement.verifier) + '），但没有可用的核验器 ⇒ 按未通过处理（这条本来就不该被发出去）' }
  }
  return verify(row.entry, row)
}

module.exports = {
  completionLedgerOf, completionLedgerDelta, ledgerLabelOf, LEDGER_LABELS, newIdsOf,
  verifyEntry, VERIFIER_FUNCS, CONTENT_FIELDS, PEER_RECEIPT_COMMAND, sharedUsageOf,
  canonicalJson, firstDiffIndex, contentDiffOf,
  verifyCompletionLedger, verifyBookingMoment, verifyBookingContent, verifyBookingCreated, verifyExerciseCreated,
  verifySharedBookingCreated, verifyPackageShareState
}
