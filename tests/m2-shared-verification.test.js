// M2 第三批永久回归：**跨教练共享课时的只读取证 + 两条共享命令的写入后回读核验**（2026-09-26）。
//
// 防的事故（每一条都对应一类真实损失）：
//  ① 为了"能核验"而顺手开一道"客户端任意读别人数据"的门 —— 那比核验不了更糟；
//  ② 把 readonly 取证写成能写的东西 —— 取证本身成为第二个写入面；
//  ③ 沙箱共享码能读到正式数据（或反过来）—— 环境隔离被打通；
//  ④ 对端课时包 reserved 没变 / 变多了，却因为没有 has 对端读路径而"看着像成功"；
//  ⑤ 课时 / 会员 / 销售被复制一份到另一位教练账里 —— 会员的课被扣两遍；
//  ⑥ 对端没收据 ⇒ 对方设备增量同步出现空洞，每次刷新退回全量读。
//
// ⭐ 本文件跑的是**真实云端 handlers + 真实 core.execute + 真实只读取证 service**
//    （假 DB 替身只替网络），所以"A / B 两本账"是真的两本账。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {
  createService: createReadService, SHARE_COLLECTIONS, SHARE_KIND, SHARE_ACTIVE, HEAD_KINDS, REVISION_KINDS
} = require('../cloudfunctions/diagnoseSharedUsage/service')
const core = require('../cloudfunctions/coachBusinessCommand/core')
const { handlers } = require('../cloudfunctions/coachBusinessCommand/handlers')
const sharing = require('../cloudfunctions/coachBusinessCommand/sharing')
const sharingSource = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'coachBusinessCommand', 'sharing.js'), 'utf8')
const readSource = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'diagnoseSharedUsage', 'service.js'), 'utf8')
const readIndexSource = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'diagnoseSharedUsage', 'index.js'), 'utf8')
const verifiers = require('../utils/business-verifiers')
const policy = require('../utils/business-verification-policy')

const { META, SANDBOX_META, coachIdFor, fixedId } = core
const copy = value => JSON.parse(JSON.stringify(value))

// ── 假 DB（只替代网络层；logic 全是真的）──
const COLLECTION_NAMES = [...new Set([
  ...Object.values(META), ...Object.values(SANDBOX_META)
])].concat(['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises'])
const stores = Object.fromEntries([...new Set(COLLECTION_NAMES)].map(name => [name, new Map()]))
let queue = Promise.resolve(), openId = 'openid-a', clock = 1900000000000

function scope(target) {
  return {
    collection(name) {
      if (!target[name]) target[name] = new Map()
      return {
        doc(id) {
          return {
            async set({ data }) { target[name].set(id, { ...copy(data), _id: id }); return { _id: id } },
            async remove() { return { stats: { removed: target[name].delete(id) ? 1 : 0 } } }
          }
        },
        where(query) {
          let limit = Infinity, offset = 0
          const api = {
            limit(value) { limit = value; return api },
            skip(value) { offset = value; return api },
            async get() {
              const hits = [...target[name].values()].filter(row => Object.keys(query).every(key => row[key] === query[key]))
              return { data: hits.slice(offset, offset + limit).map(copy) }
            }
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
const clear = () => { Object.values(stores).forEach(store => store.clear()); queue = Promise.resolve(); openId = 'openid-a' }
const rowsOf = (name, owner, datasetId) => [...stores[name].values()].filter(row => row.ownerCoachId === owner && row.datasetId === datasetId)
const businessId = (name, owner, datasetId, id) => fixedId(`coach-business-${name}`, owner, `${datasetId}:${id}`)
const metaFor = environment => (environment === 'sandbox' ? SANDBOX_META : META)
const revisionOf = (owner, datasetId, environment = 'sandbox') => (rowsOf(metaFor(environment).revisions, owner, datasetId)[0] || {}).dataRevision

function seedCoach(open, datasetId, environment = 'sandbox') {
  const owner = coachIdFor(open), meta = metaFor(environment)
  put('coaches', owner, { openId: open, status: 'active' })
  put(meta.datasets, fixedId('coach-dataset', owner, datasetId), { ownerCoachId: owner, datasetId, status: 'active', integrityStatus: 'verified', checksum: 'ok', byteSize: 1, summary: {}, schemaVersion: 1 })
  const head = { ownerCoachId: owner, activeDatasetId: datasetId, headVersion: 1 }
  if (environment === 'sandbox') head.environment = 'sandbox'
  put(meta.heads, fixedId(environment === 'sandbox' ? 'coach-sandbox-head' : 'coach-data-head', owner), head)
  put(meta.revisions, fixedId(environment === 'sandbox' ? 'coach-sandbox-revision' : 'coach-data-revision', owner, datasetId), { ownerCoachId: owner, datasetId, dataRevision: 0 })
  return { open, owner, datasetId }
}
function seedSoldPackage(A, environment = 'sandbox', { remaining = 3, total = 10 } = {}) {
  const studentId = 'stu-a-1', packageId = 'pkg-a-1', saleId = 'sale-a-1'
  put('students', businessId('students', A.owner, A.datasetId, studentId), {
    ownerCoachId: A.owner, datasetId: A.datasetId, studentId,
    data: { id: studentId, name: '张小满', phone: '13800138000', packages: [{ id: packageId }] }
  })
  put('packages', businessId('packages', A.owner, A.datasetId, packageId), {
    ownerCoachId: A.owner, datasetId: A.datasetId, packageId, studentId, saleId,
    data: { id: packageId, studentId, type: '常规训练', total, remaining, used: total - remaining, price: 300, status: 'active', saleDate: '2026-09-01', saleId }
  })
  put('sales', businessId('sales', A.owner, A.datasetId, saleId), {
    ownerCoachId: A.owner, datasetId: A.datasetId, saleId, studentId, packageId,
    data: { id: saleId, source: 'course', status: 'active', studentId, packageId, typeName: '常规训练', quantity: total, unitPrice: 300, amount: total * 300, date: '2026-09-01' }
  })
  return { studentId, packageId, saleId }
}

// ── 两个入口：写命令（真实 handlers）与只读取证（真实 service）──
const writeMain = () => core.createService({ db, getOpenId: () => openId, handlers, now: () => ++clock })
const readMain = () => createReadService({ db, getOpenId: () => openId, now: () => ++clock })
async function as(open, command, requestId, expectedRevision, payload, environment = 'sandbox') {
  openId = open
  return writeMain()({ action: 'execute', environment, envelope: { command, requestId, expectedRevision, payload } })
}
async function readAs(open, payload, environment = 'sandbox') {
  openId = open
  return readMain()({ ...payload, environment })
}
// 整库快照（键序无关），用来证明"只读取证没有写任何东西"。
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
function snapshot() {
  return canonical(Object.keys(stores).sort().map(name => ({ name, rows: [...stores[name].values()].map(row => row).sort((a, b) => String(a._id).localeCompare(String(b._id))) })))
}
const pkgDataOf = (A, packageId, environment = 'sandbox') => (rowsOf('packages', A.owner, A.datasetId).find(row => row.packageId === packageId) || {}).data || {}

async function test(name, fn) {
  try { clear(); await fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}

;(async () => {
  // ═══ 一、先堵住最坏的情况：这条取证通道不能变成"任意读别人数据" ═══
  await test('① 取证拒收任何身份/定位字段 —— 客户端连"想读谁的账"这句话都不准说', async () => {
    const A = seedCoach('openid-a', 'ds-a'), { packageId } = seedSoldPackage(A)
    await as(A.open, 'setPackageShare', 'm2v_share_001', 0, { packageId })
    const probes = [
      { action: 'sharedBooking', bookingId: 'b', requestId: 'r', ownerCoachId: A.owner },
      { action: 'sharedBooking', bookingId: 'b', requestId: 'r', datasetId: A.datasetId },
      { action: 'shareForPackage', packageId, ownerCoachId: A.owner },
      { action: 'shareForPackage', packageId, datasetId: 'ds-x' },
      { action: 'shareStateByCode', shareCode: 'ABCDEF', ownerCoachId: 'x' },
      { action: 'shareForPackage', packageId, openId: 'openid-a' },
      { action: 'shareForPackage', packageId, OPENID: 'openid-a' },
      { action: 'shareForPackage', packageId, packageUsage: { ownerCoachId: 'x' } }
    ]
    for (const probe of probes) {
      const answer = await readAs(A.open, probe)
      assert.strictEqual(answer.ok, false, JSON.stringify(probe) + ' 必须被拒')
      assert.strictEqual(answer.code, 'FORBIDDEN_IDENTITY_INPUT', JSON.stringify(probe) + ' 的结论码')
    }
  })

  await test('② 别人的预约 / 别人的课时包：**读不到**，且被统一成同一个 NOT_FOUND（不泄露"它存在"）', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b'), C = seedCoach('openid-c', 'ds-c')
    const { packageId } = seedSoldPackage(A)
    const share = await as(A.open, 'setPackageShare', 'm2v_share_010', 0, { packageId })
    await as(B.open, 'createSharedBooking', 'm2v_share_011', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    const bookingId = rowsOf('bookings', B.owner, B.datasetId)[0].bookingId
    // 同一个 bookingId，第三方 C 来读 —— 只能得到"查无此预约"，
    // 与"压根没这条预约"**同一个码**，绝不泄露"它其实存在但不属于你"。
    const spy = await readAs(C.open, { action: 'sharedBooking', bookingId, requestId: 'm2v_share_011' })
    assert.strictEqual(spy.ok, false, '第三方必须读不到')
    assert.strictEqual(spy.code, 'BOOKING_NOT_FOUND', '(code 必须与"根本没这条预约"一致，不能是 UNAUTHORIZED)')
    // 猜 packageId 也读不到别人的课时包。
    const guess = await readAs(C.open, { action: 'shareForPackage', packageId })
    assert.strictEqual(guess.ok, false)
    assert.strictEqual(guess.code, 'PACKAGE_NOT_FOUND', '猜别人的 packageId 只能得到"读不到"')
    // 没有 packageUsage 的普通预约 ⇒ NOT_A_SHARED_BOOKING（别让它顺着别的口子读出去）。
    const own = await as(A.open, 'createBooking', 'm2v_share_012', revisionOf(A.owner, A.datasetId), { studentId: 'stu-a-1', packageId, date: '2026-10-02', hour: 9, minute: 0 })
    assert.strictEqual(own.ok, true, JSON.stringify(own))
    const notShared = await readAs(A.open, { action: 'sharedBooking', bookingId: own.result.bookingId, requestId: 'm2v_share_012' })
    assert.strictEqual(notShared.code, 'NOT_A_SHARED_BOOKING', '普通预约不能被当成跨账取证入口')
  })

  await test('③ 只读取证**零写入**：调一次前后整库快照逐字节相同', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A)
    const share = await as(A.open, 'setPackageShare', 'm2v_share_020', 0, { packageId })
    await as(B.open, 'createSharedBooking', 'm2v_share_021', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    const bookingId = rowsOf('bookings', B.owner, B.datasetId)[0].bookingId
    const before = snapshot()
    await readAs(B.open, { action: 'sharedBooking', bookingId, requestId: 'm2v_share_021' })
    await readAs(A.open, { action: 'shareForPackage', packageId })
    await readAs(B.open, { action: 'shareStateByCode', shareCode: share.result.shareCode })
    assert.strictEqual(snapshot(), before, '只读取证之后整库必须一个字节都没变（取证不是第二个写入面）')
    // 源码层面也咬死：两个文件的**代码行**（剥掉注释）里不许出现任何写操作。
    const WRITE_CALLS = ['.doc(', '.add({', '.remove(', '.update({', '.set({']
    ;[readSource, readIndexSource].forEach(source => {
      const code = source.split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
      WRITE_CALLS.forEach(needle => assert.strictEqual(code.includes(needle), false, `只读取证源码里不该出现写操作 ${needle}`))
    })
  })

  await test('④ Sandbox 与 Production 的共享许可**严格隔离**：沙箱码读不到正式账，反之亦然', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'sandbox'), A2 = seedCoach('openid-a', 'ds-a-prod', 'production')
    assert.strictEqual(SHARE_COLLECTIONS.sandbox, SANDBOX_META.packageShares, '沙箱共享集合名必须与 core 一致')
    assert.strictEqual(SHARE_COLLECTIONS.production, META.packageShares, '正式共享集合名必须与 core 一致')
    assert.notStrictEqual(SHARE_COLLECTIONS.sandbox, SHARE_COLLECTIONS.production, '两个环境必须是两个物理集合')
    seedSoldPackage(A, 'sandbox'); seedSoldPackage(A2, 'production')
    const sandboxed = await as(A.open, 'setPackageShare', 'm2v_share_030', 0, { packageId: 'pkg-a-1' }, 'sandbox')
    const produced = await as(A2.open, 'setPackageShare', 'm2v_share_031', 0, { packageId: 'pkg-a-1' }, 'production')
    assert.notStrictEqual(sandboxed.result.shareCode, produced.result.shareCode, '两个环境的码本来就不该是同一枚')
    // 沙箱码 → 正式环境查：查不到。
    assert.strictEqual((await readAs(A2.open, { action: 'shareStateByCode', shareCode: sandboxed.result.shareCode }, 'production')).code, 'SHARE_NOT_FOUND')
    // 正式码 → 沙箱环境查：查不到。
    assert.strictEqual((await readAs(A.open, { action: 'shareStateByCode', shareCode: produced.result.shareCode }, 'sandbox')).code, 'SHARE_NOT_FOUND')
    // 按 packageId 查也是各查各的集合。
    const prodFact = await readAs(A2.open, { action: 'shareForPackage', packageId: 'pkg-a-1' }, 'production')
    assert.strictEqual(prodFact.share.activeCount, 1, '正式环境只有正式那一枚')
    const sandboxFact = await readAs(A.open, { action: 'shareForPackage', packageId: 'pkg-a-1' }, 'sandbox')
    assert.strictEqual(sandboxFact.share.activeCount, 1, '沙箱只有沙箱那一枚')
    // 两个集合各自只有一行。
    assert.strictEqual(stores[SANDBOX_META.packageShares].size, 1)
    assert.strictEqual(stores[META.packageShares].size, 1)
  })

  await test('⑤ 共享码路径是 minimal：只回状态与课时计数，不回任何 id / 姓名 / 金额', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A)
    const share = await as(A.open, 'setPackageShare', 'm2v_share_040', 0, { packageId })
    const fact = await readAs(B.open, { action: 'shareStateByCode', shareCode: share.result.shareCode })
    assert.strictEqual(fact.ok, true)
    assert.deepStrictEqual(Object.keys(fact).sort(), ['action', 'active', 'dataRevision', 'environment', 'minimal', 'ok', 'readOnly', 'status', 'target'].sort(),
      '响应字段被钉死：多一个字段都算泄露')
    assert.deepStrictEqual(Object.keys(fact.target).sort(), ['found', 'remaining', 'reserved', 'used'].sort())
    assert.strictEqual(fact.target.reserved, 0, '这份课时包此刻还没被占座')
    assert.strictEqual(fact.active, true)
  })

  // ═══ 二、取证内容：正好是两条命令需要证明的那些事 ═══
  await test('⑥ createSharedBooking 之后，跨账事实：两侧 revision / 收据 / reserved 全部对得上', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId, studentId } = seedSoldPackage(A)
    const share = await as(A.open, 'setPackageShare', 'm2v_share_050', 0, { packageId })
    const base = await readAs(B.open, { action: 'shareStateByCode', shareCode: share.result.shareCode })
    const peerBefore = revisionOf(A.owner, A.datasetId)
    const res = await as(B.open, 'createSharedBooking', 'm2v_share_051', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    assert.strictEqual(res.ok, true, JSON.stringify(res))
    const bookingId = res.result.bookingId
    const fact = await readAs(B.open, { action: 'sharedBooking', bookingId, requestId: 'm2v_share_051' })
    assert.strictEqual(fact.ok, true, JSON.stringify(fact))
    // booking 在**授课教练**这边的账里，且全场只有一条。
    assert.strictEqual(fact.self.booking.bookingId, bookingId)
    assert.strictEqual(fact.self.booking.status, 'booked')
    assert.strictEqual(fact.uniqueness.bookingId, 1)
    // packageUsage 指向会员那份真实课时包。
    assert.deepStrictEqual(fact.self.booking.usage, { packageId, studentId, ownerCoachId: A.owner, datasetId: A.datasetId })
    assert.strictEqual(fact.peer.found, true)
    assert.strictEqual(fact.peer.package.studentId, studentId, '指向的必须是同一个会员')
    assert.strictEqual(fact.peer.package.reserved, base.target.reserved + 1, 'reserved 恰好 +1')
    assert.strictEqual(fact.peer.package.remaining, base.target.remaining, '排课不动 remaining')
    // 课时 / 会员 / 销售在全球只有一份物理行 —— 没被复制。
    assert.strictEqual(fact.uniqueness.packageId, 1)
    assert.strictEqual(fact.uniqueness.studentId, 1)
    assert.strictEqual(fact.uniqueness.saleId, 1)
    // 双方 revision 与收据。
    assert.strictEqual(fact.peer.dataRevision, peerBefore + 1, '对端 revision 恰好 +1')
    assert.strictEqual(fact.peer.receipt.found, true, '对端必须有一张收据')
    assert.strictEqual(fact.peer.receipt.status, 'succeeded')
    assert.strictEqual(fact.peer.receipt.command, core.PEER_RECEIPT_COMMAND)
    assert.strictEqual(fact.peer.receipt.revisionAfter, fact.peer.dataRevision)
    assert.strictEqual(fact.self.receipt.found, true)
    assert.strictEqual(fact.self.receipt.command, 'createSharedBooking')
    assert.strictEqual(fact.self.receipt.revisionAfter, fact.self.dataRevision)
  })

  await test('⑦ setPackageShare 之后，取证事实：许可存在、指向正确、三个"全球唯一性"计数都是 1', async () => {
    const A = seedCoach('openid-a', 'ds-a')
    const { packageId } = seedSoldPackage(A)
    await as(A.open, 'setPackageShare', 'm2v_share_060', 0, { packageId })
    const fact = await readAs(A.open, { action: 'shareForPackage', packageId })
    assert.strictEqual(fact.ok, true)
    assert.strictEqual(fact.share.found, true)
    assert.strictEqual(fact.share.count, 1)
    assert.strictEqual(fact.share.activeCount, 1)
    assert.strictEqual(fact.share.status, 'active')
    assert.strictEqual(fact.share.packageIdMatches, true)
    assert.strictEqual(fact.share.studentIdMatches, true)
    assert.strictEqual(fact.share.tail.length, 4, '只回后四位')
    assert.strictEqual(fact.uniqueness.packageId, 1)
    assert.strictEqual(fact.uniqueness.studentId, 1)
    assert.strictEqual(fact.uniqueness.saleId, 1)
    assert.deepStrictEqual(fact.self.counts, { students: 1, packages: 1, sales: 1 })
  })

  // ═══ 三、核验器：绿的时候要真绿，红的时候要说清为什么 ═══
  const depsFor = open => ({ readSharedUsage: payload => readAs(open, payload), resolveId: value => value, environment: 'sandbox' })

  async function verifySharedBooking({ open = 'openid-b', baseline = null, receiptResult = null, entry = {} } = {}) {
    return verifiers.verifyEntry({ entry: { requestId: 'm2v_book', ...entry }, deps: depsFor(open), baseline, receiptResult })
  }
  async function verifyShareState({ open = 'openid-a', baseline = null, receiptResult = null, entry = {} } = {}) {
    return verifiers.verifyEntry({ entry: { command: 'setPackageShare', requestId: 'm2v_share', payload: { packageId: 'pkg-a-1' }, ...entry }, deps: depsFor(open), baseline, receiptResult })
  }

  await test('⑧ createSharedBooking：核验证确实通过（checked=true, ok=true）', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A)
    const share = await as(A.open, 'setPackageShare', 'm2v_share_070', 0, { packageId })
    const baseline = await readAs(B.open, { action: 'shareStateByCode', shareCode: share.result.shareCode })
    const res = await as(B.open, 'createSharedBooking', 'm2v_share_071', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    const verdict = await verifiers.verifyEntry({
      entry: { command: 'createSharedBooking', requestId: 'm2v_share_071' },
      deps: depsFor(B.open), baseline, receiptResult: res.result
    })
    assert.strictEqual(verdict.checked, true, '必须真的做了核验')
    assert.strictEqual(verdict.ok, true, '账是平的，必须放行：' + verdict.reason)
  })

  await test('⑨ setPackageShare：核验确实通过（含"关闭共享"那一面）', async () => {
    const A = seedCoach('openid-a', 'ds-a')
    const { packageId } = seedSoldPackage(A)
    const baseline = await readAs(A.open, { action: 'shareForPackage', packageId })
    const shared = await as(A.open, 'setPackageShare', 'm2v_share_080', 0, { packageId })
    assert.strictEqual(shared.ok, true)
    const opened = await verifyShareState({ baseline, receiptResult: shared.result })
    assert.strictEqual(opened.checked, true)
    assert.strictEqual(opened.ok, true, opened.reason)
    // 关闭：期望 active 归零。
    const baseline2 = await readAs(A.open, { action: 'shareForPackage', packageId })
    const revoked = await as(A.open, 'setPackageShare', 'm2v_share_081', revisionOf(A.owner, A.datasetId), { packageId, enabled: false })
    assert.strictEqual(revoked.ok, true)
    const closed = await verifiers.verifyEntry({
      entry: { command: 'setPackageShare', requestId: 'm2v_share_081', payload: { packageId, enabled: false } },
      deps: depsFor(A.open), baseline: baseline2, receiptResult: revoked.result
    })
    assert.strictEqual(closed.ok, true, closed.reason)
  })

  await test('⑩ 课时被复制到第二本账 ⇒ 核验变红（"共享"绝不能变成"一人一套"）', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId, studentId, saleId } = seedSoldPackage(A)
    const share = await as(A.open, 'setPackageShare', 'm2v_share_090', 0, { packageId })
    const baseline = await readAs(B.open, { action: 'shareStateByCode', shareCode: share.result.shareCode })
    const res = await as(B.open, 'createSharedBooking', 'm2v_share_091', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    // 复制一份会员 / 课时包 / 销售到 B 的账里。
    put('students', businessId('students', B.owner, B.datasetId, studentId), { ownerCoachId: B.owner, datasetId: B.datasetId, studentId, data: { id: studentId, name: '张小满' } })
    put('packages', businessId('packages', B.owner, B.datasetId, packageId), { ownerCoachId: B.owner, datasetId: B.datasetId, packageId, studentId, data: { id: packageId, studentId, remaining: 3, used: 7, reserved: 1 } })
    put('sales', businessId('sales', B.owner, B.datasetId, saleId), { ownerCoachId: B.owner, datasetId: B.datasetId, saleId, studentId, packageId, data: { id: saleId } })
    const verdict = await verifiers.verifyEntry({ entry: { command: 'createSharedBooking', requestId: 'm2v_share_091' }, deps: depsFor(B.open), baseline, receiptResult: res.result })
    assert.strictEqual(verdict.checked, true)
    assert.strictEqual(verdict.ok, false, '复制了课时就必须红')
    ;['课时被复制', '会员被复制', '销售'].forEach(needle => assert.ok(verdict.reason.includes(needle), '理由里必须点名：' + needle + '（实测：' + verdict.reason + '）'))
  })

  await test('⑪ 对端没收据 ⇒ 核验变红（这条正是"对方设备每次都退回全量读"的根因）', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A)
    const share = await as(A.open, 'setPackageShare', 'm2v_share_100', 0, { packageId })
    const baseline = await readAs(B.open, { action: 'shareStateByCode', shareCode: share.result.shareCode })
    const res = await as(B.open, 'createSharedBooking', 'm2v_share_101', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    // 把课时包那一侧的收据删掉。
    const peerReceiptId = fixedId(core.receiptKindFor('sandbox'), A.owner, `${A.datasetId}:m2v_share_101`)
    assert.strictEqual(stores[SANDBOX_META.receipts].delete(peerReceiptId), true, '确实删掉了那一侧收据')
    const verdict = await verifiers.verifyEntry({ entry: { command: 'createSharedBooking', requestId: 'm2v_share_101' }, deps: depsFor(B.open), baseline, receiptResult: res.result })
    assert.strictEqual(verdict.checked, true)
    assert.strictEqual(verdict.ok, false)
    assert.ok(verdict.reason.includes('收据'), '理由必须说到收据（实测：' + verdict.reason + '）')
  })

  await test('⑫ 占座没生效（reserved 没 +1）⇒ 核验变红', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A)
    const share = await as(A.open, 'setPackageShare', 'm2v_share_110', 0, { packageId })
    const baseline = await readAs(B.open, { action: 'shareStateByCode', shareCode: share.result.shareCode })
    const res = await as(B.open, 'createSharedBooking', 'm2v_share_111', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    const packageRowId = businessId('packages', A.owner, A.datasetId, packageId)
    const row = stores['packages'].get(packageRowId)
    stores['packages'].set(packageRowId, { ...row, data: { ...row.data, reserved: baseline.target.reserved } })
    const verdict = await verifiers.verifyEntry({ entry: { command: 'createSharedBooking', requestId: 'm2v_share_111' }, deps: depsFor(B.open), baseline, receiptResult: res.result })
    assert.strictEqual(verdict.ok, false, 'reserved 没变必须红')
    assert.ok(verdict.reason.includes('reserved'), '理由必须点出 reserved（实测：' + verdict.reason + '）')
  })

  await test('⑬ 缺基线 / 没注入读取器 / 回执没带回 bookingId —— 一律按"未通过"，绝不"核不了就放过"', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A)
    const share = await as(A.open, 'setPackageShare', 'm2v_share_120', 0, { packageId })
    const res = await as(B.open, 'createSharedBooking', 'm2v_share_121', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    const noBaseline = await verifiers.verifyEntry({ entry: { command: 'createSharedBooking', requestId: 'm2v_share_121' }, deps: depsFor(B.open), baseline: null, receiptResult: res.result })
    assert.strictEqual(noBaseline.checked, true); assert.strictEqual(noBaseline.ok, false)
    assert.ok(noBaseline.reason.includes('基线'), noBaseline.reason)
    const noBooking = await verifiers.verifyEntry({ entry: { command: 'createSharedBooking', requestId: 'm2v_share_121' }, deps: depsFor(B.open), baseline: { target: { reserved: 0, remaining: 3 }, dataRevision: 0 }, receiptResult: {} })
    assert.strictEqual(noBooking.checked, true); assert.strictEqual(noBooking.ok, false)
    const noReader = await verifiers.verifyEntry({ entry: { command: 'createSharedBooking', requestId: 'm2v_share_121' }, deps: { resolveId: v => v }, baseline: { target: { reserved: 0 } }, receiptResult: res.result })
    assert.strictEqual(noReader.checked, true); assert.strictEqual(noReader.ok, false)
    assert.ok(noReader.reason.includes('跨账只读取证失败'), noReader.reason)
    // setPackageShare 同样不许无基线放行。
    const noShareBaseline = await verifyShareState({ baseline: null, receiptResult: { packageId } })
    assert.strictEqual(noShareBaseline.checked, true); assert.strictEqual(noShareBaseline.ok, false)
    assert.ok(noShareBaseline.reason.includes('基线'), noShareBaseline.reason)
  })

  // ═══ 四、策略与常量：不许悄悄降级，也不许两边漂移 ═══
  await test('⑭ 两条共享命令：仍是 required，且核验器已实现 ⇒ 允许发送', async () => {
    ;['setPackageShare', 'createSharedBooking'].forEach(command => {
      const requirement = policy.requirementOf(command)
      assert.strictEqual(requirement.level, 'required', command + ' 绝不能为了"能发"就降成 receipt-only')
      assert.strictEqual(requirement.implemented, true, command + ' 的核验器必须真的已实现')
      assert.strictEqual(policy.preflightOf(command).ok, true, command + ' 现在必须放行（不再被拒发）')
      assert.ok(verifiers.VERIFIER_FUNCS[requirement.verifier], '核验器要有实现函数')
    })
    // 每一条 required 命令要么有实现的核验器、要么**仍在拒发名单里** —— 不存在"要求核验却放行"。
    Object.keys(policy.POLICY).forEach(command => {
      const row = policy.requirementOf(command)
      if (row.level !== 'required' || row.implemented) return
      assert.strictEqual(policy.preflightOf(command).ok, false, command + ' 没有核验器就必须拒发')
    })
  })

  await test('⑮ 常量副本不许漂移：取证函数与 core / sharing 必须是同一份事实', async () => {
    assert.deepStrictEqual(SHARE_COLLECTIONS.production, META.packageShares)
    assert.deepStrictEqual(SHARE_COLLECTIONS.sandbox, SANDBOX_META.packageShares)
    assert.strictEqual(SHARE_KIND, sharing.SHARE_KIND)
    assert.strictEqual(SHARE_ACTIVE, sharing.SHARE_ACTIVE)
    assert.deepStrictEqual(HEAD_KINDS.production, 'coach-data-head')
    assert.deepStrictEqual(HEAD_KINDS.sandbox, 'coach-sandbox-head')
    assert.deepStrictEqual(REVISION_KINDS.production, 'coach-data-revision')
    assert.deepStrictEqual(REVISION_KINDS.sandbox, 'coach-sandbox-revision')
    assert.strictEqual(verifiers.PEER_RECEIPT_COMMAND, core.PEER_RECEIPT_COMMAND, '对端收据命令名两处必须一致')
    // 共享码 → 文档 id 的算法必须一致（错一位就永远查不到对方的许可）。
    const code = 'A1B2C3D4E5'
    assert.strictEqual(fixedId(SHARE_KIND, code), sharing.shareIdFor(code), '共享码 → 文档 id 的算法必须一致')
    // 格式尺也必须一致：放宽一处，就等于可以拿畸形码反复扫库。
    assert.ok(sharingSource.includes('^[A-Z0-9]{6,32}$'), 'sharing 的码格式必须没变')
    assert.ok(readSource.includes('^[A-Z0-9]{6,32}$'), '取证侧必须用同一把格式尺')
  })

  process.stdout.write(`\nM2 第三批跨账取证 + 核验：${process.exitCode === 1 ? '有失败项' : '全部通过'}\n`)
})()
