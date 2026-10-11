// M2 第三批：**跨教练共享课时的只读取证**（2026-09-26）。
//
// ★★ 它解决什么问题 ★★
//   M2 第二批新增的两条命令（`setPackageShare` / `createSharedBooking`）在核验策略里是
//   「必须做写入后读回核验，但没有可用核验器 ⇒ 抢修 / 自动续跑通道拒发」。
//   根因很清楚：这两条命令改的是**两位教练**的数据，而现有只读读入口（`readMyActiveCoachData`
//   `page` / `diagnoseCoachCompletion`）只能读**调用方自己**那本账 —— 对端的课时包
//   `reserved` 到底变没变，本机根本看不到。
//   本函数就是那把"能看到对端证据"的尺子，但它比别的多了一层约束（见下）。
//
// ★★ 安全模型（这一节每个字都不能改）★★
//   ① **客户端永远不提交任何跨教练定位字段**：`ownerCoachId` / `datasetId` / `openId` 等一律
//      `FORBIDDEN_IDENTITY_INPUT`（与 readMyActiveCoachData / diagnoseCoachCompletion 同一套黑名单）。
//      ⇒ 想读谁的账，**只能由服务端从可信身份 + 共享关系推导**，客户端猜也猜不到别人。
//   ② 唯一的两种**派生授权**（服务端自己翻译，不是客户端输入）：
//        · `bookingId` —— 调用方**自己账里**的那条共享预约。它身上带着 `packageUsage`，
//          服务端顺着这枚指针找到对端位置。没有 packageUsage ⇒ `NOT_A_SHARED_BOOKING`。
//        · `shareCode` —— 一段共享关系本身（持有它就能用这份课时）。**只用于发送前取基线**，
//          且响应是 `minimal`：只有 readonly 的状态与课时计数，**不含任何 id / 姓名 / 金额**。
//   ③ **零写入**：全文只有 `.get()`。没有任何 set / update / remove，也不推进 revision。
//   ④ 环境隔离：Sandbox 读 `coach_sandbox_package_shares`，Production 读 `coach_package_shares`
//      （两个物理集合）⇒ 沙箱里的共享码在正式环境**查不到**，反之亦然。
//
// ⚠️ 为什么单独一个云函数、不往 `readMyActiveCoachData` 里加 action：
//      读链路是 Frozen 区，加 action 要动它的分发主体；新建一个零写入的只读函数，
//      对既有读链路**一个字都不改**（这是不扩大 Frozen 触碰范围的最省做法）。

const crypto = require('crypto')

// ⚠️ 下面这批常量是 `coachBusinessCommand/core.js`、`sharing.js` 里同名事实的**第二个副本**
//    （云函数各自独立部署，不能 require 彼此目录）。
//    `tests/m2-shared-verification.test.js` 有一条**漂移即红**的契约断言盯着它们 ——
//    改了那边忘了这边（或反过来）会当场变红，别手两边都改而绕过测试。
const SHARE_COLLECTIONS = Object.freeze({ production: 'coach_package_shares', sandbox: 'coach_sandbox_package_shares' })
const HEAD_COLLECTIONS = Object.freeze({ production: 'coach_data_heads', sandbox: 'coach_sandbox_heads' })
const REVISION_COLLECTIONS = Object.freeze({ production: 'coach_data_revisions', sandbox: 'coach_sandbox_revisions' })
const RECEIPT_COLLECTIONS = Object.freeze({ production: 'coach_command_receipts', sandbox: 'coach_sandbox_receipts' })
const HEAD_KINDS = Object.freeze({ production: 'coach-data-head', sandbox: 'coach-sandbox-head' })
const REVISION_KINDS = Object.freeze({ production: 'coach-data-revision', sandbox: 'coach-sandbox-revision' })
const SHARE_KIND = 'coach-package-share'
const SHARE_ACTIVE = 'active'
const SHARE_CODE_PATTERN = /^[A-Z0-9]{6,32}$/

const FORBIDDEN = new Set(['OPENID', 'openId', 'openid', '_openid', 'coachId', 'ownerCoachId', 'datasetId', 'documentId', 'booking_ref', 'share', 'shareRow', 'usage', 'packageUsage'])

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const coachIdFor = openId => sha(`coach:${openId}`).slice(0, 32)
const fixedId = (kind, owner, suffix = '') => sha(`${kind}:${owner}:${suffix}`).slice(0, 32)

const shareCollectionOf = environment => (environment === 'sandbox' ? SHARE_COLLECTIONS.sandbox : SHARE_COLLECTIONS.production)
const headCollectionOf = environment => (environment === 'sandbox' ? HEAD_COLLECTIONS.sandbox : HEAD_COLLECTIONS.production)
const revisionCollectionOf = environment => (environment === 'sandbox' ? REVISION_COLLECTIONS.sandbox : REVISION_COLLECTIONS.production)
const receiptCollectionOf = environment => (environment === 'sandbox' ? RECEIPT_COLLECTIONS.sandbox : RECEIPT_COLLECTIONS.production)
const headKindOf = environment => (environment === 'sandbox' ? HEAD_KINDS.sandbox : HEAD_KINDS.production)
const revisionKindOf = environment => (environment === 'sandbox' ? REVISION_KINDS.sandbox : REVISION_KINDS.production)

const fail = (code, message) => ({ ok: false, code, message: message || code })
const num = value => (Number.isFinite(Number(value)) ? Number(value) : null)
const textOf = value => (value === null || value === undefined ? '' : String(value))

async function one(db, name, query) {
  const answer = await db.collection(name).where(query).limit(1).get()
  const rows = (answer && answer.data) || []
  return rows[0] || null
}
// 服务端单次读取上限 100 条，老实翻页。
// ⚠️ 这条路径只用来**计数/去重**，不把整本账搬回客户端。
async function all(db, name, query) {
  const rows = []
  let skip = 0
  for (let round = 0; round < 200; round += 1) {
    const answer = await db.collection(name).where(query).skip(skip).limit(100).get()
    const page = (answer && answer.data) || []
    rows.push(...page)
    if (page.length < 100) break
    skip += page.length
  }
  return rows
}
// 「这份业务数据在几本账里有物理行」——**唯一能证明"课时没被复制"的判据**。
//   若某个实现把会员 / 课时包 / 销售复制了一份到另一位教练的数据集里，这个数就会变成 2，
//   核验器当场变红。⇒ 不需要客户端提交别人的 coachId，也能证明"没复制"。
function distinctLocations(rows) {
  const seen = new Set()
  rows.forEach(row => { if (row) seen.add(`${textOf(row.ownerCoachId)}@${textOf(row.datasetId)}`) })
  return seen.size
}
async function locations(db, name, query) { return distinctLocations(await all(db, name, query)) }
async function countRows(db, name, query) { return (await all(db, name, query)).length }

// 回执只取**能用来对账**的四个字段（整份 response 不外带）。
function receiptFacts(row) {
  if (!row) return { found: false, status: null, command: null, revisionBefore: null, revisionAfter: null }
  return {
    found: true,
    status: row.status || null,
    command: row.command || null,
    revisionBefore: Number.isInteger(row.revisionBefore) ? row.revisionBefore : null,
    revisionAfter: Number.isInteger(row.revisionAfter) ? row.revisionAfter : null
  }
}
function packageFacts(row, packageId) {
  if (!row) return null
  const data = row.data || {}
  return {
    packageId: textOf(packageId),
    studentId: textOf(row.studentId || data.studentId),
    remaining: num(data.remaining),
    used: num(data.used),
    // reserved 为 null 表示"这份课时包从来没被占座逻辑碰过" —— 与 0（占座为 0）必须能分开。
    reserved: data.reserved === undefined || data.reserved === null ? null : num(data.reserved),
    reservedVersion: data.reservedVersion === undefined || data.reservedVersion === null ? null : num(data.reservedVersion),
    status: data.status || null
  }
}

// ── action ①：以**自己账里那条共享预约**为锚，读两侧 ISBN 事实 ──
async function sharedBooking(ctx, bookingId, requestId) {
  const { db, self, environment } = ctx
  if (!bookingId) return fail('INVALID_BOOKING_ID', '缺少预约标识。')
  // ① 先锁定"这条预约属于调用方自己" —— 查询条件里写死本人 (ownerCoachId, datasetId)。
  //    别人的预约在这本账里根本查不到 ⇒ 同一个 NOT_FOUND，**不泄露"它存在但不属于你"**。
  const bookingRow = await one(db, 'bookings', { ownerCoachId: self.ownerCoachId, datasetId: self.datasetId, bookingId })
  if (!bookingRow) return fail('BOOKING_NOT_FOUND', '这条预约不存在，或不属于当前教练。')
  const booking = bookingRow.data || {}
  // ② 服务端**自己**顺着 packageUsage 推导对端位置 —— 客户端一个定位字段都没给。
  const usageRaw = booking.packageUsage && typeof booking.packageUsage === 'object' ? booking.packageUsage : null
  if (!usageRaw || !usageRaw.packageId || !usageRaw.ownerCoachId || !usageRaw.datasetId) return fail('NOT_A_SHARED_BOOKING', '这条预约没有跨账课时使用标记，不是共享预约。')
  const usage = { packageId: textOf(usageRaw.packageId), studentId: textOf(usageRaw.studentId), ownerCoachId: textOf(usageRaw.ownerCoachId), datasetId: textOf(usageRaw.datasetId) }
  const peerOwner = usage.ownerCoachId, peerDataset = usage.datasetId
  const receiptName = receiptCollectionOf(environment)
  const packageRow = await one(db, 'packages', { ownerCoachId: peerOwner, datasetId: peerDataset, packageId: usage.packageId })
  const peerRevision = await one(db, revisionCollectionOf(environment), { _id: fixedId(revisionKindOf(environment), peerOwner, peerDataset), ownerCoachId: peerOwner, datasetId: peerDataset })
  const peerReceipt = requestId ? await one(db, receiptName, { ownerCoachId: peerOwner, datasetId: peerDataset, requestId }) : null
  const selfReceipt = requestId ? await one(db, receiptName, { ownerCoachId: self.ownerCoachId, datasetId: self.datasetId, requestId }) : null
  const saleId = textOf((packageRow && packageRow.saleId) || ((packageRow && packageRow.data) || {}).saleId)
  const uniqueness = {
    bookingId: await locations(db, 'bookings', { bookingId }),
    packageId: await locations(db, 'packages', { packageId: usage.packageId }),
    studentId: await locations(db, 'students', { studentId: usage.studentId }),
    saleId: saleId ? await locations(db, 'sales', { saleId }) : null
  }
  return {
    ok: true, readOnly: true, action: 'sharedBooking', environment,
    self: {
      dataRevision: self.dataRevision,
      booking: { bookingId, status: booking.status || null, studentId: textOf(booking.studentId), packageId: textOf(booking.packageId), usage },
      receipt: receiptFacts(selfReceipt)
    },
    peer: {
      found: !!packageRow,
      dataRevision: peerRevision && Number.isInteger(peerRevision.dataRevision) ? peerRevision.dataRevision : null,
      package: packageFacts(packageRow, usage.packageId),
      receipt: receiptFacts(peerReceipt)
    },
    uniqueness
  }
}

// ── action ②：以**自己账里那个课时包**为锚，读共享许可与"有没有被复制"的证据 ──
async function shareForPackage(ctx, packageId) {
  const { db, self, environment } = ctx
  if (!packageId) return fail('INVALID_PACKAGE_ID', '缺少课时包标识。')
  const packageRow = await one(db, 'packages', { ownerCoachId: self.ownerCoachId, datasetId: self.datasetId, packageId })
  if (!packageRow) return fail('PACKAGE_NOT_FOUND', '课时包不存在，或不属于当前教练。')
  const packageData = packageRow.data || {}
  const studentId = textOf(packageRow.studentId || packageData.studentId)
  const saleId = textOf(packageRow.saleId || packageData.saleId)
  // 共享许可只能查**自己这本账上的**（ownerCoachId/datasetId 是服务端身份，不是输入）。
  const shareRows = await all(db, shareCollectionOf(environment), { ownerCoachId: self.ownerCoachId, datasetId: self.datasetId, packageId })
  const active = shareRows.filter(row => row.status === SHARE_ACTIVE)
  const tailCodes = active.map(row => String(row.shareCode || '').slice(-4))
  const selfScope = { ownerCoachId: self.ownerCoachId, datasetId: self.datasetId }
  const uniqueness = {
    packageId: await locations(db, 'packages', { packageId }),
    studentId: studentId ? await locations(db, 'students', { studentId }) : null,
    saleId: saleId ? await locations(db, 'sales', { saleId }) : null
  }
  return {
    ok: true, readOnly: true, action: 'shareForPackage', environment,
    self: {
      dataRevision: self.dataRevision,
      // 「没有把学员/课时包/销售复制出去」的**本地一半证据**：自己这本账的行数不许变。
      // （另一半是全球唯一性：`uniqueness` 三个计数必须都是 1。）
      counts: {
        students: await countRows(db, 'students', selfScope),
        packages: await countRows(db, 'packages', selfScope),
        sales: await countRows(db, 'sales', selfScope)
      }
    },
    share: {
      found: shareRows.length > 0,
      count: shareRows.length,
      activeCount: active.length,
      status: active[0] ? SHARE_ACTIVE : (shareRows[0] ? (shareRows[0].status || null) : null),
      // 码只回后四位：够人核对"是不是这一枚"，又不会把整枚码再存一份到日志里。
      tail: tailCodes.length === 1 ? tailCodes[0] : tailCodes.slice().sort().join(','),
      packageIdMatches: shareRows.length > 0 && shareRows.every(row => textOf(row.packageId) === packageId),
      studentIdMatches: shareRows.length > 0 && shareRows.every(row => textOf(row.studentId) === studentId)
    },
    uniqueness
  }
}

// ── action ③：**仅用于发送前取基线** —— 以共享码为锚，只读回对端课时计数 ──
// ⚠️ 响应必须保持最小：`minimal:true`，只有 active 状态 / 对端 revision / 课时三个计数。
//    不含 packageId、学员 id、姓名、金额、任何教练标识 —— 给核验器做差量只差这几个数。
async function shareStateByCode(ctx, shareCode) {
  const { db, environment } = ctx
  const code = String(shareCode || '').trim().toUpperCase()
  if (!SHARE_CODE_PATTERN.test(code)) return fail('INVALID_SHARE_CODE', '共享码格式无效。')
  const row = await one(db, shareCollectionOf(environment), { _id: fixedId(SHARE_KIND, code), shareCode: code })
  if (!row) return fail('SHARE_NOT_FOUND', '共享码无效。')
  const targetOwner = textOf(row.ownerCoachId), targetDataset = textOf(row.datasetId)
  const revisionRow = await one(db, revisionCollectionOf(environment), { _id: fixedId(revisionKindOf(environment), targetOwner, targetDataset), ownerCoachId: targetOwner, datasetId: targetDataset })
  const packageRow = await one(db, 'packages', { ownerCoachId: targetOwner, datasetId: targetDataset, packageId: textOf(row.packageId) })
  const facts = packageFacts(packageRow, textOf(row.packageId))
  return {
    ok: true, readOnly: true, action: 'shareStateByCode', environment, minimal: true,
    status: row.status || null,
    active: row.status === SHARE_ACTIVE,
    dataRevision: revisionRow && Number.isInteger(revisionRow.dataRevision) ? revisionRow.dataRevision : null,
    target: { found: !!packageRow, remaining: facts ? facts.remaining : null, used: facts ? facts.used : null, reserved: facts ? facts.reserved : null }
  }
}

function createService({ db, getOpenId, now = () => Date.now() }) {
  return async function main(event = {}) {
    const openId = getOpenId()
    if (!openId) return fail('IDENTITY_MISSING', '未能确认当前微信身份。')
    for (const key of Object.keys(event || {})) if (FORBIDDEN.has(key)) return fail('FORBIDDEN_IDENTITY_INPUT', `客户端不得提交身份或数据集定位字段：${key}`)
    if (event.environment != null && event.environment !== 'production' && event.environment !== 'sandbox') return fail('INVALID_ENVIRONMENT', '数据环境无效。')
    const environment = event.environment === 'sandbox' ? 'sandbox' : 'production'
    const ownerCoachId = coachIdFor(openId)
    const coach = await one(db, 'coaches', { _id: ownerCoachId, openId, status: 'active' })
    if (!coach) return fail('COACH_NOT_FOUND', '未找到当前有效教练身份。')
    const head = await one(db, headCollectionOf(environment), environment === 'sandbox'
      ? { _id: fixedId(headKindOf(environment), ownerCoachId), ownerCoachId, environment }
      : { _id: fixedId(headKindOf(environment), ownerCoachId), ownerCoachId })
    if (!head || !head.activeDatasetId) return fail('ACTIVE_DATASET_NOT_FOUND', '当前环境没有在用数据空间。')
    const datasetId = head.activeDatasetId
    const revision = await one(db, revisionCollectionOf(environment), { _id: fixedId(revisionKindOf(environment), ownerCoachId, datasetId), ownerCoachId, datasetId })
    if (!revision || !Number.isInteger(revision.dataRevision)) return fail('ACTIVE_DATASET_INVALID', '当前数据空间版本不可用。')
    const ctx = { db, environment, self: { ownerCoachId, datasetId, dataRevision: revision.dataRevision }, now }
    if (event.action === 'sharedBooking') return sharedBooking(ctx, String(event.bookingId || ''), String(event.requestId || ''))
    if (event.action === 'shareForPackage') return shareForPackage(ctx, String(event.packageId || ''))
    if (event.action === 'shareStateByCode') return shareStateByCode(ctx, String(event.shareCode || ''))
    return fail('INVALID_ACTION', '不支持的只读取证动作。')
  }
}

module.exports = {
  createService,
  // 导出供契约测试比对（防止云函数之间的常量副本漂移）。
  SHARE_COLLECTIONS, HEAD_COLLECTIONS, REVISION_COLLECTIONS, RECEIPT_COLLECTIONS,
  HEAD_KINDS, REVISION_KINDS, SHARE_KIND, SHARE_ACTIVE, SHARE_CODE_PATTERN, FORBIDDEN,
  coachIdFor, fixedId, shareCollectionOf, distinctLocations, receiptFacts, packageFacts
}
