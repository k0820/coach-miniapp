const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { reconstruct, fingerprint, classifyCompletionReceipts } = require('./integrity')
const { planChanges, MAX_WINDOW } = require('./changes')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLLECTIONS = ['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
// —— 一页装多少（1.1.9）——
// 只改这两个数：读什么（metadata + 八集合 + integrity）、校验什么（checksum/byteSize/summary/
// counts/amounts）、分片逻辑（PAGE_BYTES 超限切 base64-fragment）**一个字都没动**。
//
// 为什么是这两个数：一次「完整回读」的往返次数几乎完全由页数决定，而页数由「每页装多少」决定。
// 用真实数据（bookings 173 / incomes 160 / 物理行 526 条）离线复刻本文件的分页口径算过：
//   20 条 / 24KB → 31 次 page 往返（bookings 9 + incomes 9 + packages 3 + sales 3 + …）
//                 合计 33 次云函数往返，客户端并发 2 ⇒ 17 轮串行
//   100 条 / 192KB → 10 次 page 往返（bookings 2 + incomes 2 + 其余各 1）
//                 合计 12 次云函数往返 ⇒ 5 轮串行
// 单页 192KB 的 base64 约 256KB，离 callFunction 的返回体上限还很远；
// 最大单行实测 1395 字节，远小于 192KB ⇒ 现有分片路径在这批数据上根本不会被触发。
const PAGE_LIMIT = 100, PAGE_BYTES = 192 * 1024
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const coachIdFor = openId => sha(`coach:${openId}`).slice(0, 32)
const fixedId = (kind, owner, suffix = '') => sha(`${kind}:${owner}:${suffix}`).slice(0, 32)
const forbidden = new Set(['OPENID', 'openId', 'openid', '_openid', 'coachId', 'ownerCoachId', 'datasetId', 'documentId'])
const safeInt = value => Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0
async function one(name, query) { const r = await db.collection(name).where(query).limit(1).get(); return r.data && r.data[0] }
async function all(name, query) { const rows = []; let cursor = 0; for (;;) { const result = await db.collection(name).where(query).orderBy('_id', 'asc').skip(cursor).limit(100).get(), page = result.data || []; rows.push(...page); cursor += page.length; if (page.length < 100) return rows } }
const summaryDiff = (current = {}, baseline = {}) => Object.fromEntries([...new Set([...Object.keys(current), ...Object.keys(baseline)])].filter(key => JSON.stringify(current[key]) !== JSON.stringify(baseline[key])).map(key => [key, { current: current[key], baseline: baseline[key] }]))

// 八个集合**现读**一遍。integrity 与 changes 两条路用的是同一批行、同一套顺序，
// 所以「先算指纹、再算增量」看到的是同一个瞬间的数据（不是两次不同的读）。
async function readAllGroups(owner, datasetId) {
  return Object.fromEntries(await Promise.all(COLLECTIONS.map(async name => [name, await all(name, { ownerCoachId: owner, datasetId })])))
}

async function liveIntegrity(owner, datasetId, revisionBefore, environment = 'production') {
  const groups = await readAllGroups(owner, datasetId)
  environment = environment === 'sandbox' ? 'sandbox' : 'production'
  const revisionCollection = environment === 'sandbox' ? 'coach_sandbox_revisions' : 'coach_data_revisions'
  const revisionKind = environment === 'sandbox' ? 'coach-sandbox-revision' : 'coach-data-revision'
  const revision = await one(revisionCollection, { _id: fixedId(revisionKind, owner, datasetId), ownerCoachId: owner, datasetId })
  if (!revision || revision.dataRevision !== revisionBefore) return { ok: false, code: 'ACTIVE_READ_REVISION_CHANGED', expectedRevision: revisionBefore, actualRevision: revision && revision.dataRevision }
  const snapshot = reconstruct(groups), actual = fingerprint(snapshot)
  return { ok: true, environment, datasetId, dataRevision: revision.dataRevision, ...actual, physicalCounts: Object.fromEntries(COLLECTIONS.map(name => [name, groups[name].length])) }
}

// 这一段 revision 的命令收据。收据与业务写在**同一个事务**里（见 coachBusinessCommand/core.js
// 的 execute），所以「succeeded 收据的 revisionAfter 连续覆盖 since+1…to」就等于
// 「这段时间的业务变化一条不漏」。反过来，收据被清理必然在序列里留下空洞 ⇒ 客户端退回完整读取。
// ⚠️ 只取 succeeded：processing 的收据还没有 revisionAfter（那条命令的结果本身尚未定论），
//    而且它一旦失败会整份回滚 —— 既不会推进 revision，也不该被算进变更集。
async function receiptsBetween(environment, owner, datasetId, sinceRevision) {
  const collection = environment === 'sandbox' ? 'coach_sandbox_receipts' : 'coach_command_receipts'
  const result = await db.collection(collection)
    .where({ ownerCoachId: owner, datasetId, status: 'succeeded', revisionAfter: db.command.gt(sinceRevision) })
    .orderBy('revisionAfter', 'asc')
    .limit(MAX_WINDOW + 5)
    .get()
  return result.data || []
}

// ★★ HEAD revision：**再一次**读那张 revision 文档（1.1.9 第 16 轮，§90）★★
//
// 为什么需要它：客户端原来在套完增量之后，必须再花一次 `integrity` 去问
// 「云端此刻最新是哪一版」—— 那一次调用与 `changes` **串行**，真机上一路下拉因此
// 固定要 3.8–5.0 秒（两次「云端现读八个集合」首尾相接）。
// 现在由云端在**算完 delta 之后**顺手再读一次 revision（单文档，几十毫秒），
// 把它一起回给客户端：
//   headRevision === dataRevision ⇒ 这一版就是云端最后一次检查时的最新版 ⇒ 这一次下拉到此结束；
//   headRevision >  dataRevision ⇒ 云端在算 delta 期间又被人写了 ⇒ 同一次下拉内部再追一跳。
// ⚠️ 顺序是刻意的：先确定本次数据版本（revisionBefore 自证）→ 算完 delta → **最后**才读 HEAD。
//    反过来（先读 HEAD 再算 delta）会把"算 delta 期间发生的写入"漏掉，那正是要抓的东西。
// ⚠️ 它**只是一个"还要不要追"的提示**，绝不参与任何安全判据：
//    checksum / byteSize / summary / counts / amounts / datasetId / revision 自证 /
//    trusted OPENID / dataset isolation / CHANGES_* fallback —— 一个字都没动。
//    客户端拿到**不可信**的 headRevision（旧云函数没有这个字段 / 不是整数 / 比 dataRevision
//    还小）时，一律退回原有的 `integrity` 确认路径，与部署新云函数之前逐字一致。
async function readHeadRevision(environment, owner, datasetId) {
  const collection = environment === 'sandbox' ? 'coach_sandbox_revisions' : 'coach_data_revisions'
  const kind = environment === 'sandbox' ? 'coach-sandbox-revision' : 'coach-data-revision'
  const doc = await one(collection, { _id: fixedId(kind, owner, datasetId), ownerCoachId: owner, datasetId })
  return doc && Number.isInteger(doc.dataRevision) ? doc.dataRevision : null
}

// ★★ 增量读取（1.1.9 第 7 轮）★★
//
// 与 `liveIntegrity` 的是同一批 `groups`、同一个指纹；多出来的只是「把这一段变更集算出来」。
// 因此这一次调用的成本与 integrity 同量级（云端现读八个集合，实测 1.2–1.4 秒），
// 但**回传的体积从整份数据（约 250KB）降到那几行**，客户端的往返次数从 13 次降到 1 次。
//
// ⚠️ 这里返回的指纹不是"装饰"：客户端把增量套在本机缓存上之后，会用**同一套五项**
//    （checksum / byteSize / summary / counts / amounts）重算一遍并与它逐项比对。
//    对不上就整份退回完整读取 —— 所以"增量算漏了一条"的后果是那一次刷新变慢，
//    绝不会是"手机显示了错的课表"。
async function liveChanges(owner, datasetId, revisionBefore, sinceRevision, environment = 'production') {
  const groups = await readAllGroups(owner, datasetId)
  environment = environment === 'sandbox' ? 'sandbox' : 'production'
  const revisionCollection = environment === 'sandbox' ? 'coach_sandbox_revisions' : 'coach_data_revisions'
  const revisionKind = environment === 'sandbox' ? 'coach-sandbox-revision' : 'coach-data-revision'
  const revision = await one(revisionCollection, { _id: fixedId(revisionKind, owner, datasetId), ownerCoachId: owner, datasetId })
  if (!revision || revision.dataRevision !== revisionBefore) return { ok: false, code: 'ACTIVE_READ_REVISION_CHANGED', expectedRevision: revisionBefore, actualRevision: revision && revision.dataRevision }
  const to = revision.dataRevision
  const snapshot = reconstruct(groups), actual = fingerprint(snapshot)
  const base = { ok: true, environment, datasetId, dataRevision: to, ...actual, physicalCounts: Object.fromEntries(COLLECTIONS.map(name => [name, groups[name].length])) }
  // 已经是最新：一次收据查询都省掉，直接回指纹（等价于原来那一跳 integrity）。
  const receipts = sinceRevision === to ? [] : await receiptsBetween(environment, owner, datasetId, sinceRevision)
  const planned = planChanges({ groups, receipts, sinceRevision, toRevision: to })
  if (!planned.ok) return planned
  // ★★ 「算完 delta 之后」再读一次 HEAD（顺序见 `readHeadRevision` 上方的说明）。
  //    读不到 / 不是整数 / 比 `to` 还小（倒退，只可能是换了数据集或文档被改坏）
  //    ⇒ 一律回 `null`，客户端据此退回原有的 integrity 确认路径 —— 宁慢，绝不假装追平。
  const head = await readHeadRevision(environment, owner, datasetId)
  const headRevision = Number.isInteger(head) && head >= to ? head : null
  if (planned.unchanged) return { ...base, unchanged: true, from: sinceRevision, headRevision }
  return { ...base, from: sinceRevision, to, delta: planned.delta, headRevision }
}

async function diagnoseCompletion(owner, datasetId, revision, bookingId, dataset) {
  const booking = await one('bookings', { ownerCoachId: owner, datasetId, bookingId })
  if (!booking) return { ok: false, code: 'BOOKING_NOT_FOUND' }
  const receipts = (await all('coach_command_receipts', { ownerCoachId: owner, datasetId })).filter(row => ['updateBookingContent', 'completeBooking'].includes(row.command) && row.response && row.response.result && row.response.result.bookingId === bookingId).sort((a, b) => Number(b.completedAt || b.createdAt || 0) - Number(a.completedAt || a.createdAt || 0))
  const packageId = booking.packageId || booking.data && booking.data.packageId, pkg = packageId ? await one('packages', { ownerCoachId: owner, datasetId, packageId }) : null
  const incomes = await all('incomes', { ownerCoachId: owner, datasetId, bookingId })
  const current = await liveIntegrity(owner, datasetId, revision.dataRevision)
  if (!current.ok) return current
  const state = classifyCompletionReceipts(receipts)
  return {
    ok: true, readOnly: true, state, datasetId, dataRevision: revision.dataRevision,
    activationBaseline: { checksum: dataset.checksum, byteSize: dataset.byteSize, summary: dataset.summary, counts: dataset.counts, amounts: dataset.amounts },
    currentIntegrity: current,
    integrityDifference: {
      checksumMatch: current.checksum === dataset.checksum,
      byteSizeMatch: current.byteSize === dataset.byteSize,
      summaryMatch: !Object.keys(summaryDiff(current.summary, dataset.summary)).length,
      countsMatch: !Object.keys(summaryDiff(current.counts, dataset.counts)).length,
      amountsMatch: !Object.keys(summaryDiff(current.amounts, dataset.amounts)).length,
      summaryDiff: summaryDiff(current.summary, dataset.summary),
      countsDiff: summaryDiff(current.counts, dataset.counts),
      amountsDiff: summaryDiff(current.amounts, dataset.amounts)
    },
    booking: { bookingId, status: booking.data && booking.data.status, packageId, hasItems: !!(booking.data && Array.isArray(booking.data.items) && booking.data.items.length), notesSaved: !!(booking.data && booking.data.notes), summarySaved: !!(booking.data && booking.data.summary) },
    package: pkg ? { packageId, used: pkg.data && pkg.data.used, remaining: pkg.data && pkg.data.remaining, status: pkg.data && pkg.data.status } : null,
    incomes: incomes.map(row => ({ incomeId: row.incomeId, bookingId: row.bookingId || row.data && row.data.bookingId, amount: row.data && row.data.amount })),
    receipts: receipts.slice(0, 20).map(row => ({ requestId: row.requestId, command: row.command, status: row.status, revisionBefore: row.revisionBefore, revisionAfter: row.revisionAfter, result: row.response && row.response.result, completedAt: row.completedAt }))
  }
}

function pagePayload(docs, cursor, fragmentIndex) {
  if (!docs.length) return { done: true, cursor, nextCursor: cursor, encoding: 'base64-json', payload: '' }
  const first = Buffer.from(JSON.stringify(docs[0]), 'utf8')
  if (first.length > PAGE_BYTES) {
    const totalFragments = Math.ceil(first.length / PAGE_BYTES), start = fragmentIndex * PAGE_BYTES
    if (fragmentIndex >= totalFragments) return { ok: false, code: 'INVALID_FRAGMENT' }
    return { done: false, cursor, nextCursor: fragmentIndex + 1 === totalFragments ? cursor + 1 : cursor, nextFragmentIndex: fragmentIndex + 1 === totalFragments ? 0 : fragmentIndex + 1, fragmentIndex, totalFragments, encoding: 'base64-fragment', payload: first.subarray(start, Math.min(first.length, start + PAGE_BYTES)).toString('base64') }
  }
  const selected = []
  for (const doc of docs) { if (Buffer.byteLength(JSON.stringify(selected.concat(doc)), 'utf8') > PAGE_BYTES) break; selected.push(doc) }
  return { done: docs.length < PAGE_LIMIT && selected.length === docs.length, cursor, nextCursor: cursor + selected.length, nextFragmentIndex: 0, encoding: 'base64-json', payload: Buffer.from(JSON.stringify(selected), 'utf8').toString('base64') }
}

exports.main = async event => {
  const openId = cloud.getWXContext().OPENID
  if (!openId) return { ok: false, code: 'IDENTITY_MISSING' }
  for (const key of Object.keys(event || {})) if (forbidden.has(key)) return { ok: false, code: 'FORBIDDEN_IDENTITY_INPUT' }
  if (event.environment != null && event.environment !== 'production' && event.environment !== 'sandbox') return { ok: false, code: 'INVALID_ENVIRONMENT' }
  const environment = event.environment === 'sandbox' ? 'sandbox' : 'production'
  const owner = coachIdFor(openId), coach = await one('coaches', { _id: owner, openId, status: 'active' })
  if (!coach) return { ok: false, code: 'COACH_NOT_FOUND' }
  const headCollection = environment === 'sandbox' ? 'coach_sandbox_heads' : 'coach_data_heads'
  const headKind = environment === 'sandbox' ? 'coach-sandbox-head' : 'coach-data-head'
  const revisionCollection = environment === 'sandbox' ? 'coach_sandbox_revisions' : 'coach_data_revisions'
  const revisionKind = environment === 'sandbox' ? 'coach-sandbox-revision' : 'coach-data-revision'
  const head = await one(headCollection, environment === 'sandbox' ? { _id: fixedId(headKind, owner), ownerCoachId: owner, environment } : { _id: fixedId(headKind, owner), ownerCoachId: owner })
  if (!head || !head.activeDatasetId) return { ok: false, code: 'ACTIVE_DATASET_NOT_FOUND' }
  const datasetId = head.activeDatasetId, dataset = await one('coach_datasets', { _id: fixedId('coach-dataset', owner, datasetId), ownerCoachId: owner, datasetId, status: 'active', integrityStatus: 'verified' })
  const revision = await one(revisionCollection, { _id: fixedId(revisionKind, owner, datasetId), ownerCoachId: owner, datasetId })
  if (!dataset || !revision || !Number.isInteger(revision.dataRevision)) return { ok: false, code: 'ACTIVE_DATASET_INVALID' }
  if (event.action === 'metadata') return { ok: true, environment, datasetId, dataRevision: revision.dataRevision, headVersion: head.headVersion, activationChecksum: dataset.checksum, activationByteSize: dataset.byteSize, activationSummary: dataset.summary, collections: COLLECTIONS.slice() }
  if (event.action === 'integrity') return liveIntegrity(owner, datasetId, revision.dataRevision, environment)
  // 增量读取（1.1.9 第 7 轮）：只回「自 sinceRevision 起变了的那几行」。
  // 客户端在**用户主动下拉**那一条路上先试它；试不成（CHANGES_* 各种码）就整份退回完整读取。
  // ⚠️ 只读：不写任何文档、不碰 revision、不产生收据 —— 与 integrity 同一条安全等级。
  if (event.action === 'changes') {
    if (!Number.isInteger(event.sinceRevision) || event.sinceRevision < 0) return { ok: false, code: 'CHANGES_INVALID_SINCE' }
    return liveChanges(owner, datasetId, revision.dataRevision, event.sinceRevision, environment)
  }
  if (event.action === 'diagnoseCompletion') {
    const bookingId = String(event.bookingId || '')
    if (!bookingId) return { ok: false, code: 'INVALID_BOOKING_ID' }
    return diagnoseCompletion(owner, datasetId, revision, bookingId, dataset)
  }
  if (event.action !== 'page' || !COLLECTIONS.includes(event.collection)) return { ok: false, code: 'INVALID_ACTION' }
  const cursor = safeInt(event.cursor), fragmentIndex = safeInt(event.fragmentIndex)
  const response = await db.collection(event.collection).where({ ownerCoachId: owner, datasetId }).orderBy('_id', 'asc').skip(cursor).limit(PAGE_LIMIT).get()
  return { ok: true, environment, collection: event.collection, datasetId, dataRevision: revision.dataRevision, ...pagePayload(response.data || [], cursor, fragmentIndex) }
}
