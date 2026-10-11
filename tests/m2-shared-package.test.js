// M2 第二批永久回归：**多教练共享同一份会员真实课时**（2026-09-26）—— 跑真实云端 handlers。
//
// 防的事故（每一条都对应一类真实损失）：
//  ① 复制余额：B 那边也建一份课时包 ⇒ 出现第二套 remaining，会员的课被扣两遍；
//  ② 超额预约：A / B 同时排同一份课时包的最后一节 ⇒ 两节都约上，只剩 1 节却排了 2 节；
//  ③ 收入错人：B 用 A 的课时包上课，收入却记到 A 的账上（或反过来）；
//  ④ 销售错人：销售业绩被挪到授课教练那边；
//  ⑤ 对端 revision 不推进 / 不写收据 ⇒ A 设备的增量同步出现空洞 ⇒ 每次刷新退回全量读；
//  ⑥ 共享预约取消 / 完课时，占座释放在**自己**这本账上（课时包根本不在这儿）⇒ 幽灵占座；
//  ⑦ 撤销共享后旧码还能继续排课。
//
// ⭐ 本文件跑的是**真实云端 handlers + 真实 core.execute**（假 DB 替身只替网络），
//    所以"A / B 两本账"是真的两本账：不同的 ownerCoachId、不同的 datasetId、各自的 revision 与收据。

const assert = require('assert')
const { META, SANDBOX_META, coachIdFor, fixedId, createService, PEER_RECEIPT_COMMAND } = require('../cloudfunctions/coachBusinessCommand/core')
const { handlers } = require('../cloudfunctions/coachBusinessCommand/handlers')
const occupancy = require('../cloudfunctions/coachBusinessCommand/occupancy')
const sharing = require('../cloudfunctions/coachBusinessCommand/sharing')
const { planChanges, NARROW } = require('../cloudfunctions/readMyActiveCoachData/changes')
const { COMMANDS } = require('../utils/cloud-command-contract')
const mutateCommands = require('../utils/mutate').COMMANDS

const copy = value => JSON.parse(JSON.stringify(value))
const SHARE_COLLECTION = SANDBOX_META.packageShares
const names = [...new Set([
  ...Object.values(META), ...Object.values(SANDBOX_META),
  'students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises'
])]
const stores = Object.fromEntries(names.map(name => [name, new Map()]))
let queue = Promise.resolve(), openId = 'openid-a', clock = 1900000000000

function scope(target) {
  return {
    collection(name) {
      if (!target[name]) target[name] = new Map()
      return {
        doc(id) {
          return {
            async set({ data }) { target[name].set(id, { ...copy(data), _id: id }); return { _id: id } },
            async remove() { const removed = target[name].delete(id) ? 1 : 0; return { stats: { removed } } }
          }
        },
        where(query) {
          let limit = Infinity, offset = 0
          const api = {
            limit(value) { limit = value; return api },
            skip(value) { offset = value; return api },
            async get() { return { data: [...target[name].values()].filter(row => Object.keys(query).every(key => row[key] === query[key])).slice(offset, offset + limit).map(copy) } }
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
const businessId = (name, owner, datasetId, id) => fixedId(`coach-business-${name}`, owner, `${datasetId}:${id}`)
const rows = (name, owner, datasetId) => [...stores[name].values()].filter(row => row.ownerCoachId === owner && row.datasetId === datasetId)
const dataRows = (name, owner, datasetId) => rows(name, owner, datasetId).map(row => row.data || {})
const revisionOf = (owner, datasetId) => (rows(SANDBOX_META.revisions, owner, datasetId)[0] || {}).dataRevision

// —— 两个教练、两本账（Sandbox 环境，与 Production 完全隔离）——
function seedCoach(open, datasetId) {
  const owner = coachIdFor(open)
  put('coaches', owner, { openId: open, status: 'active' })
  put(SANDBOX_META.datasets, fixedId('coach-dataset', owner, datasetId), { ownerCoachId: owner, datasetId, status: 'active', integrityStatus: 'verified', checksum: 'ok', byteSize: 1, summary: {}, schemaVersion: 1 })
  put(SANDBOX_META.heads, fixedId('coach-sandbox-head', owner), { ownerCoachId: owner, environment: 'sandbox', activeDatasetId: datasetId, headVersion: 1 })
  put(SANDBOX_META.revisions, fixedId('coach-sandbox-revision', owner, datasetId), { ownerCoachId: owner, datasetId, dataRevision: 0 })
  return { open, owner, datasetId }
}
// 课时包只建在 A 那里：销售教练 A 卖出 10 节，已上 7 节，还剩 remaining 节。
function seedSoldPackage(A, { remaining = 3, total = 10 } = {}) {
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
    data: { id: saleId, source: 'course', status: 'active', studentId, packageId, typeName: '常规训练', quantity: total, unitPrice: 300, amount: total * 300, date: '2026-09-01', note: '张小满 · 常规训练' }
  })
  return { studentId, packageId, saleId }
}

const main = () => createService({ db, getOpenId: () => openId, handlers, now: () => ++clock })
async function as(open, command, requestId, expectedRevision, payload) {
  openId = open
  return main()({ action: 'execute', environment: 'sandbox', envelope: { command, requestId, expectedRevision, payload } })
}

const pkgOf = (A, packageId) => dataRows('packages', A.owner, A.datasetId).find(item => item.id === packageId)
const occOf = (A, packageId) => occupancy.occupancyOf(pkgOf(A, packageId))
const sharedBookingRows = B => rows('bookings', B.owner, B.datasetId)
const ITEMS = [{ name: '卧推', group: '胸', sets: 4, reps: 12, weight: 40 }]

async function test(name, fn) {
  try { clear(); await fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}

;(async () => {
  await test('生成共享码：只发码，不动 remaining / used，并顺手把占座数对齐', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A, { remaining: 3 })
    const res = await as(A.open, 'setPackageShare', 'm2s_share_001', 0, { packageId })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.ok(/^[A-Z0-9]{6,32}$/.test(res.result.shareCode), '共享码必须是可手抄的大写串')
    const pkg = pkgOf(A, packageId)
    assert.equal(pkg.remaining, 3, '发码绝不改剩余课时')
    assert.equal(pkg.used, 7, '发码绝不改已用课时')
    assert.equal(pkg.reserved, 0, '当前没有有效预约 ⇒ 占座应为 0')
    assert.equal(pkg.reservedVersion, occupancy.RESERVED_VERSION, '发码必须完成占座惰性初始化')
    assert.equal(B.owner !== A.owner, true)
  })

  await test('重复开启返回**同一枚**共享码（不会把已发出的码作废）', async () => {
    const A = seedCoach('openid-a', 'ds-a'); seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A, { remaining: 3 })
    const first = await as(A.open, 'setPackageShare', 'm2s_share_010', 0, { packageId })
    const second = await as(A.open, 'setPackageShare', 'm2s_share_011', 1, { packageId })
    assert.equal(second.ok, true)
    assert.equal(second.result.shareCode, first.result.shareCode, '重复开启必须复用同一枚码')
    assert.equal(second.result.reused, true)
  })

  await test('B 用共享码排课：占的是 A 那份 remaining，B 那边**不复制**任何课时包', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A, { remaining: 3 })
    const share = await as(A.open, 'setPackageShare', 'm2s_share_020', 0, { packageId })
    const res = await as(B.open, 'createSharedBooking', 'm2s_book_020', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(res.ok, true, JSON.stringify(res))
    // B 的账里：多了一条预约，**没有**多出任何学员 / 课时包 / 销售 —— 这就是"不复制余额"
    assert.equal(sharedBookingRows(B).length, 1, '共享预约落在授课教练 B 的账上')
    assert.equal(rows('students', B.owner, B.datasetId).length, 0, 'B 绝不复制一份学员')
    assert.equal(rows('packages', B.owner, B.datasetId).length, 0, 'B 绝不复制一份课时包（第二套余额）')
    assert.equal(rows('sales', B.owner, B.datasetId).length, 0, 'B 绝不复制一份销售业绩')
    // A 的账里：占座 +1，余额一动不动
    assert.equal(occOf(A, packageId).remaining, 3, '预约不扣真实课时')
    assert.equal(occOf(A, packageId).reserved, 1, '预约必须占 1 节')
    assert.equal(occOf(A, packageId).availableToBook, 2)
    // 唯一的跨账定位标记
    const booking = sharedBookingRows(B)[0].data
    assert.deepStrictEqual(booking.packageUsage, { packageId, studentId: 'stu-a-1', ownerCoachId: A.owner, datasetId: A.datasetId })
    assert.equal(booking.packageId, packageId)
    assert.equal(booking.status, 'booked')
    assert.equal(booking.plannedMinutes, 60, '共享预约同样带时长快照（默认 60）')
  })

  await test('A / B 各排一节：用的是同一个 reserved，余额只有一份', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A, { remaining: 3 })
    const share = await as(A.open, 'setPackageShare', 'm2s_share_030', 0, { packageId })
    await as(B.open, 'createSharedBooking', 'm2s_book_030', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    // A 的 revision 已经被 B 那条共享预约推了一格（对端记账）—— 必须用**当前** revision 才能发得出去。
    const own = await as(A.open, 'createBooking', 'm2s_book_031', revisionOf(A.owner, A.datasetId), { studentId: 'stu-a-1', packageId, date: '2026-10-02', hour: 14, minute: 0 })
    assert.equal(own.ok, true, JSON.stringify(own))
    assert.equal(occOf(A, packageId).reserved, 2, '两条预约（分属两本账）占的是同一个计数器')
    assert.equal(occOf(A, packageId).remaining, 3)
    assert.equal(occOf(A, packageId).availableToBook, 1)
  })

  await test('最后一节并发：A 先 / B 先两种顺序，都只能有一个成功', async () => {
    for (const [tag, firstIsA] of [['afirst', true], ['bfirst', false]]) {
      clear()
      const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
      const { packageId } = seedSoldPackage(A, { remaining: 1 })
      const share = await as(A.open, 'setPackageShare', `m2s_race_${tag}_00`, 0, { packageId })
      // ⭐ 关键点：两位教练用的是**各自的 revision**，两条命令的乐观锁**互不干涉**。
      //    所以真正挡住第二个的必须是 availableToBook 那把尺，而不是"恰好撞了 revision"。
      let tally = 0
      const byA = () => as(A.open, 'createBooking', `m2s_race_${tag}_a${++tally}`, revisionOf(A.owner, A.datasetId), { studentId: 'stu-a-1', packageId, date: '2026-10-02', hour: 10, minute: 0 })
      const byB = () => as(B.open, 'createSharedBooking', `m2s_race_${tag}_b${++tally}`, revisionOf(B.owner, B.datasetId), { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
      const r1 = firstIsA ? await byA() : await byB()
      const r2 = firstIsA ? await byB() : await byA()
      assert.equal(r1.ok, true, `${tag}：第一个必须成功 ${JSON.stringify(r1)}`)
      assert.equal(r2.ok, false, `${tag}：第二个必须被挡住 ${JSON.stringify(r2)}`)
      // 第二个可能被 revision 挡住（对方那本账刚被推了一格，本机还是旧号）—— 那是**正常的乐观锁**，
      // 不是判据。所以再拿**当前** revision 重试一次：这一次挡住它的理由必须只剩"排满了"。
      const r3 = (r2.code === 'REVISION_CONFLICT' || r2.code === 'PACKAGE_NO_AVAILABLE') && r2.code !== 'PACKAGE_NO_AVAILABLE'
        ? (firstIsA ? await byB() : await byA()) : r2
      assert.equal(r3.code, 'PACKAGE_NO_AVAILABLE', `${tag}：追平 revision 之后，挡住它的必须只剩"排满了"（实测 ${r3.code}）`)
      assert.equal(occOf(A, packageId).remaining, 1, '真实课时只有 1 节，绝不能变负')
      assert.equal(occOf(A, packageId).reserved, 1, '只占 1 节 —— 绝不允许两节都约上')
      assert.equal(sharedBookingRows(B).length + rows('bookings', A.owner, A.datasetId).length, 1, '最终全场只有一条预约')
    }
  })

  await test('完课：收入归**授课教练 B**，课时从 A 的包扣，销售业绩仍留在 A', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId, saleId } = seedSoldPackage(A, { remaining: 3 })
    const share = await as(A.open, 'setPackageShare', 'm2s_share_040', 0, { packageId })
    const booked = await as(B.open, 'createSharedBooking', 'm2s_book_040', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    const bookingId = booked.result.bookingId
    await as(B.open, 'updateBookingContent', 'm2s_content_040', 1, { bookingId, items: ITEMS, category: '综合训练', duration: 60 })
    const done = await as(B.open, 'completeBooking', `completeBooking:${bookingId}`, 2, { bookingId })
    assert.equal(done.ok, true, JSON.stringify(done))
    // 收入：只在 B 的账里
    const incomesB = dataRows('incomes', B.owner, B.datasetId)
    const incomesA = dataRows('incomes', A.owner, A.datasetId)
    assert.equal(incomesB.length, 1, '收入必须记在**授课教练 B** 的账上')
    assert.equal(incomesA.length, 0, 'A 的账里绝不能出现这笔收入（课是 B 上的）')
    assert.equal(incomesB[0].bookingId, bookingId)
    assert.equal(incomesB[0].amount, 300)
    // 课时：从 A 的包扣（这才是"共享同一份真实课时"）
    assert.equal(occOf(A, packageId).remaining, 2, '真实剩余必须从 3 变 2')
    assert.equal(pkgOf(A, packageId).used, 8)
    assert.equal(occOf(A, packageId).reserved, 0, '完课必须释放占座')
    // 销售业绩：仍然只在 A
    assert.equal(dataRows('sales', A.owner, A.datasetId).length, 1, '销售业绩仍归**销售教练 A**')
    assert.equal(dataRows('sales', A.owner, A.datasetId)[0].id, saleId)
    assert.equal(dataRows('sales', B.owner, B.datasetId).length, 0, 'B 绝不能分走销售业绩')
  })

  await test('双 revision + 双收据：两本账各 +1，且 A 的增量同步不断裂（无 CHANGES_GAP）', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A, { remaining: 3 })
    const share = await as(A.open, 'setPackageShare', 'm2s_share_050', 0, { packageId })
    const beforeA = revisionOf(A.owner, A.datasetId), beforeB = revisionOf(B.owner, B.datasetId)
    const booked = await as(B.open, 'createSharedBooking', 'm2s_book_050', beforeB, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(booked.ok, true, JSON.stringify(booked))
    assert.equal(booked.datasetRevision, beforeB + 1, '授课教练 B 的 revision +1')
    assert.equal(revisionOf(A.owner, A.datasetId), beforeA + 1, '课时包所属教练 A 的 revision 也必须 +1')
    // A 那侧必须有一张 succeeded 收据，且 revisionAfter 连续 —— 否则 A 每次刷新都退回全量读
    const receiptsA = rows(SANDBOX_META.receipts, A.owner, A.datasetId)
    const peer = receiptsA.find(row => row.command === PEER_RECEIPT_COMMAND && row.requestId === 'm2s_book_050')
    assert.ok(peer, 'A 那本账必须有对端收据')
    assert.equal(peer.status, 'succeeded')
    assert.equal(peer.revisionAfter, beforeA + 1)
    assert.equal(peer.response.result.packageId, packageId)
    // 用真实 planChanges 走一遍 A 的增量：必须能算出 delta（不是 CHANGES_GAP）
    const groups = {
      students: rows('students', A.owner, A.datasetId), student_tombstones: [], packages: rows('packages', A.owner, A.datasetId),
      bookings: rows('bookings', A.owner, A.datasetId), incomes: [], sales: rows('sales', A.owner, A.datasetId),
      settings: [], customExercises: []
    }
    const planned = planChanges({ groups, receipts: receiptsA, sinceRevision: beforeA, toRevision: beforeA + 1 })
    assert.equal(planned.ok, true, JSON.stringify(planned))
    const upserted = ((planned.delta || {}).upserts || {}).packages || []
    assert.equal(upserted.length, 1, 'A 的增量必须补 packages 那一行')
    assert.equal(upserted[0].packageId, packageId)
    assert.deepStrictEqual(((planned.delta || {}).upserts || {}).bookings || [], [], 'B 的预约不该出现在 A 的增量里')
  })

  await test('取消共享预约：占座释放在**课时包那一本账**上', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A, { remaining: 3 })
    const share = await as(A.open, 'setPackageShare', 'm2s_share_060', 0, { packageId })
    const booked = await as(B.open, 'createSharedBooking', 'm2s_book_060', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(occOf(A, packageId).reserved, 1)
    const revB = revisionOf(B.owner, B.datasetId)
    const cancelled = await as(B.open, 'cancelBooking', 'm2s_cancel_060', revB, { bookingId: booked.result.bookingId })
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
    assert.equal(occOf(A, packageId).reserved, 0, '占座必须释放回 A 那份课时包')
    assert.equal(occOf(A, packageId).remaining, 3, '取消不扣课时')
    assert.equal(pkgOf(A, packageId).used, 7, '取消不改已用')
    assert.equal(sharedBookingRows(B).length, 0)
  })

  await test('删除已完成共享课程：课时返到 A 那份包，收入从 B 删除', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A, { remaining: 3 })
    const share = await as(A.open, 'setPackageShare', 'm2s_share_070', 0, { packageId })
    const booked = await as(B.open, 'createSharedBooking', 'm2s_book_070', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    const bookingId = booked.result.bookingId
    await as(B.open, 'updateBookingContent', 'm2s_content_070', 1, { bookingId, items: ITEMS, category: '综合训练', duration: 60 })
    await as(B.open, 'completeBooking', `completeBooking:${bookingId}`, 2, { bookingId })
    assert.equal(occOf(A, packageId).remaining, 2)
    const revB = revisionOf(B.owner, B.datasetId)
    const removed = await as(B.open, 'deleteCompletedBooking', `deleteCompletedBooking:${bookingId}`, revB, { bookingId })
    assert.equal(removed.ok, true, JSON.stringify(removed))
    assert.equal(removed.result.refund, 'active-package-refunded', '必须真的返课，不能静默吞掉')
    assert.equal(occOf(A, packageId).remaining, 3, '课时必须退回到 A 那份真实课时包')
    assert.equal(pkgOf(A, packageId).used, 7)
    assert.equal(dataRows('incomes', B.owner, B.datasetId).length, 0, '收入必须从 B 的账里删掉')
  })

  await test('撤销共享：不能再排新课，但**已经排上的**照常能取消 / 上课', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A, { remaining: 3 })
    const share = await as(A.open, 'setPackageShare', 'm2s_share_080', 0, { packageId })
    const booked = await as(B.open, 'createSharedBooking', 'm2s_book_080', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    const revA = revisionOf(A.owner, A.datasetId)
    const revoked = await as(A.open, 'setPackageShare', 'm2s_share_081', revA, { packageId, enabled: false })
    assert.equal(revoked.ok, true, JSON.stringify(revoked))
    assert.equal(revoked.result.revoked, true)
    const again = await as(B.open, 'createSharedBooking', 'm2s_book_081', 1, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 12, minute: 0 })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'SHARE_REVOKED', '撤销后的码不能再排课')
    // 已排上的那条不受影响
    const cancelled = await as(B.open, 'cancelBooking', 'm2s_cancel_081', 1, { bookingId: booked.result.bookingId })
    assert.equal(cancelled.ok, true, '旧预约必须还能正常取消')
    assert.equal(occOf(A, packageId).reserved, 0)
  })

  await test('共享码的三道拒绝：无效 / 自己家的码 / 已撤销', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A, { remaining: 3 })
    const share = await as(A.open, 'setPackageShare', 'm2s_share_090', 0, { packageId })
    const unknown = await as(B.open, 'createSharedBooking', 'm2s_book_090', 0, { shareCode: 'ZZZZZZZZZZ', date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(unknown.ok, false); assert.equal(unknown.code, 'SHARE_NOT_FOUND')
    const self = await as(A.open, 'createSharedBooking', 'm2s_book_091', 1, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(self.ok, false); assert.equal(self.code, 'SHARE_SELF_NOT_ALLOWED', '自己的课时包直接 createBooking，不走共享码')
    const bad = await as(B.open, 'createSharedBooking', 'm2s_book_092', 0, { shareCode: '!!', date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(bad.ok, false); assert.equal(bad.code, 'INVALID_PAYLOAD', '共享码格式必须先校验')
  })

  await test('共享预约同样受「待确认」规则约束，且待确认期间**继续占座**', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A, { remaining: 3 })
    const share = await as(A.open, 'setPackageShare', 'm2s_share_100', 0, { packageId })
    const booked = await as(B.open, 'createSharedBooking', 'm2s_book_100', 0, { shareCode: share.result.shareCode, date: '2026-09-01', hour: 10, minute: 0, plannedMinutes: 60 })
    assert.equal(booked.ok, true)
    const booking = sharedBookingRows(B)[0].data
    // 预计 10:00 开始 + 60 分钟 + 3 小时宽限 = 14:00 之后算待确认
    const at = (day, hour, minute) => new Date(2026, 8, day, hour, minute, 0, 0).getTime()
    assert.equal(occupancy.isPendingConfirmation(booking, at(1, 13, 59)), false)
    assert.equal(occupancy.isPendingConfirmation(booking, at(1, 14, 1)), true)
    assert.equal(occOf(A, packageId).reserved, 1, '待确认**继续占座**：不自动扣、不自动退、不自动判缺席')
    assert.equal(occOf(A, packageId).remaining, 3, '待确认绝不自动扣课时')
    assert.equal(dataRows('incomes', B.owner, B.datasetId).length, 0, '待确认绝不自动产生收入')
  })

  await test('「课程未进行」释放的是 A 那份占座（B 自己账里根本没有那个包）', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const { packageId } = seedSoldPackage(A, { remaining: 3 })
    const share = await as(A.open, 'setPackageShare', 'm2s_share_110', 0, { packageId })
    const booked = await as(B.open, 'createSharedBooking', 'm2s_book_110', 0, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    const revB = revisionOf(B.owner, B.datasetId)
    const notHeld = await as(B.open, 'markBookingNotHeld', 'm2s_nothold_110', revB, { bookingId: booked.result.bookingId })
    assert.equal(notHeld.ok, true, JSON.stringify(notHeld))
    assert.equal(occOf(A, packageId).reserved, 0)
    assert.equal(occOf(A, packageId).remaining, 3, '未进行不扣课时')
    assert.equal(pkgOf(A, packageId).used, 7)
    assert.equal(dataRows('incomes', B.owner, B.datasetId).length, 0)
  })

  await test('本机对共享预约**不下判断**：一律 SHARED_PACKAGE_NOT_LOCAL，交给云端裁决', async () => {
    const { InMemoryCommandEngine } = require('../utils/cloud-command-engine')
    const engine = new InMemoryCommandEngine({ now: () => 1700000000000, idFactory: kind => `${kind}_srv` })
    engine.seed('coach-b', { students: [], bookings: [{ id: 'bk-shared', studentId: 'stu-a-1', studentName: '张小满', packageId: 'pkg-a-1', date: '2026-10-02', hour: 10, minute: 0, typeName: '常规训练', price: 300, status: 'booked', packageUsage: { packageId: 'pkg-a-1', studentId: 'stu-a-1', ownerCoachId: 'coach-a', datasetId: 'ds-a' } }], incomes: [], sales: [], settings: {}, customExercises: [] })
    for (const command of ['cancelBooking', 'completeBooking', 'markBookingNotHeld', 'deleteCompletedBooking']) {
      const res = engine.execute({ ownerCoachId: 'coach-b' }, { command, requestId: `local_${command}`, expectedRevision: 0, payload: { bookingId: 'bk-shared' } })
      assert.equal(res.ok, false, `${command} 本机绝不能自己算`)
      assert.equal(res.code, 'SHARED_PACKAGE_NOT_LOCAL')
    }
  })

  await test('契约：两条新命令已进正式命令清单，且共享命令走在**云端先行**', async () => {
    assert.ok(COMMANDS.includes('setPackageShare') && COMMANDS.includes('createSharedBooking'))
    assert.deepStrictEqual(mutateCommands.slice().sort(), COMMANDS.slice().sort())
    const { NARROW: narrow } = { NARROW }
    assert.ok(narrow.createSharedBooking && narrow.setPackageShare && narrow.sharedPackageSync, '三条增量规则必须都在')
    assert.deepStrictEqual(narrow.createSharedBooking({ bookingId: 'b1', packageId: 'p1' }), [['bookings', 'b1']], '授课教练那侧只补 bookings')
    assert.deepStrictEqual(narrow.sharedPackageSync({ packageId: 'p1', bookingId: 'b1' }), [['packages', 'p1']], '课时包那侧只补 packages')
  })

  if (!process.exitCode) process.stdout.write('ALL M2 SHARED PACKAGE TESTS PASSED\n')
})()
