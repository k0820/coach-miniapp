// M2 业务模型校正（2026-09-27）永久回归：**会员拥有自己的真实课时事实**。
//
// 这个文件盯的是新模型本身，不是旧模型：
//   · 不存在「课时包所属教练」—— 课时属于会员本人；
//   · A / B / C 只是**授课教练**：一条预约必须记清「谁发起」「谁授课」；
//   · remaining / reserved / availableToBook 全项目只有一份，任何教练都不能复制出第二套余额；
//   · 预约成功前服务端必须最终校验三件事：教练时间、会员时间、还有可约课时（**不信任客户端页面数据**）。
//
// ⭐ 与 m2-shared-package 一样：跑**真实云端 handlers + 真实 core.execute**（假 DB 只替网络），
//    A / B 是真的两本账（不同 ownerCoachId、不同 datasetId、各自 revision 与收据）。

const assert = require('assert')
const { META, SANDBOX_META, coachIdFor, fixedId, createService } = require('../cloudfunctions/coachBusinessCommand/core')
const { handlers } = require('../cloudfunctions/coachBusinessCommand/handlers')
const occupancy = require('../cloudfunctions/coachBusinessCommand/occupancy')
const teaching = require('../cloudfunctions/coachBusinessCommand/teaching')

const copy = value => JSON.parse(JSON.stringify(value))
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

function seedCoach(open, datasetId) {
  const owner = coachIdFor(open)
  put('coaches', owner, { openId: open, status: 'active' })
  put(SANDBOX_META.datasets, fixedId('coach-dataset', owner, datasetId), { ownerCoachId: owner, datasetId, status: 'active', integrityStatus: 'verified', checksum: 'ok', byteSize: 1, summary: {}, schemaVersion: 1 })
  put(SANDBOX_META.heads, fixedId('coach-sandbox-head', owner), { ownerCoachId: owner, environment: 'sandbox', activeDatasetId: datasetId, headVersion: 1 })
  put(SANDBOX_META.revisions, fixedId('coach-sandbox-revision', owner, datasetId), { ownerCoachId: owner, datasetId, dataRevision: 0 })
  return { open, owner, datasetId }
}
// 会员的课时事实：**只有一份**，物理落在 A 那本账里（A 只是记录了这笔销售，并不"拥有"课时）。
function seedPackage(coach, ids, { remaining = 12, total = 12 } = {}) {
  const { studentId, packageId, saleId } = ids
  put('students', businessId('students', coach.owner, coach.datasetId, studentId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, studentId,
    data: { id: studentId, name: '小蓝', phone: '13800138000', packages: [{ id: packageId }] }
  })
  put('packages', businessId('packages', coach.owner, coach.datasetId, packageId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, packageId, studentId, saleId,
    data: { id: packageId, studentId, type: '常规训练', total, remaining, used: total - remaining, price: 300, status: 'active', saleDate: '2026-09-01', saleId }
  })
  put('sales', businessId('sales', coach.owner, coach.datasetId, saleId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, saleId, studentId, packageId,
    data: { id: saleId, source: 'course', status: 'active', studentId, packageId, typeName: '常规训练', quantity: total, unitPrice: 300, amount: total * 300, date: '2026-09-01', note: '小蓝 · 常规训练' }
  })
  return ids
}

const main = () => createService({ db, getOpenId: () => openId, handlers, now: () => ++clock })
async function raw(open, command, requestId, expectedRevision, payload) {
  openId = open
  return main()({ action: 'execute', environment: 'sandbox', envelope: { command, requestId, expectedRevision, payload } })
}
const revOf = coach => revisionOf(coach.owner, coach.datasetId)
// 用**当前** revision 发命令（共享预约会同时推两本账的 revision）⇒ 避免把 revision 冲突误读成业务结果。
const cmd = (coach, command, requestId, payload) => raw(coach.open, command, requestId, revOf(coach), payload)

const pkgOf = (coach, packageId) => dataRows('packages', coach.owner, coach.datasetId).find(item => item.id === packageId)
const occOf = (coach, packageId) => occupancy.occupancyOf(pkgOf(coach, packageId))
const bookingsOf = coach => dataRows('bookings', coach.owner, coach.datasetId)
const ITEMS = [{ name: '卧推', group: '胸', sets: 4, reps: 12, weight: 40 }]
const IDS = { studentId: 'stu-a-1', packageId: 'pkg-a-1', saleId: 'sale-a-1' }

async function test(name, fn) {
  try { clear(); await fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}
// 完整走一遍：先写训练内容（常规课程必须），再完课。
async function completeBookingOf(coach, bookingId, requestTag) {
  const content = await cmd(coach, 'updateBookingContent', `m2f_${requestTag}_content`, { bookingId, items: ITEMS, category: '综合训练', duration: 60 })
  assert.equal(content.ok, true, `训练内容保存失败 ${JSON.stringify(content)}`)
  return cmd(coach, 'completeBooking', `m2f_${requestTag}_done`, { bookingId })
}

;(async () => {
  // ———————————————————————————————————————————————— A
  await test('A：会员 12 节 —— A 约一节 / B 再约一节 / 各完成一节，三值逐格对得上（12→12→12→11→10）', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const ids = seedPackage(A, IDS, { remaining: 12, total: 12 })
    const share = await cmd(A, 'setPackageShare', 'm2f_a_share', { packageId: ids.packageId })
    assert.equal(share.ok, true, JSON.stringify(share))

    const byA = await cmd(A, 'createBooking', 'm2f_a_book_a', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(byA.ok, true, JSON.stringify(byA))
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 12, reserved: 1, availableToBook: 11 }, 'A 预约后：12 / 1 / 11')

    const byB = await cmd(B, 'createSharedBooking', 'm2f_a_book_b', { shareCode: share.result.shareCode, date: '2026-10-02', hour: 12, minute: 0 })
    assert.equal(byB.ok, true, JSON.stringify(byB))
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 12, reserved: 2, availableToBook: 10 }, 'B 再约一节后：12 / 2 / 10')

    const doneA = await completeBookingOf(A, byA.result.bookingId, 'a_done_a')
    assert.equal(doneA.ok, true, JSON.stringify(doneA))
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 11, reserved: 1, availableToBook: 10 }, 'A 完成后：11 / 1 / 10')

    const doneB = await completeBookingOf(B, byB.result.bookingId, 'a_done_b')
    assert.equal(doneB.ok, true, JSON.stringify(doneB))
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 10, reserved: 0, availableToBook: 10 }, 'B 完成后：10 / 0 / 10')
    assert.equal(pkgOf(A, ids.packageId).used, 2, '已用课时 = 两位教练各上完的一节')
  })

  // ———————————————————————————————————————————————— B
  await test('B：教练时间不共享 —— A 的 14:00 已被占，另一位会员不能抢 A 的这个时间', async () => {
    const A = seedCoach('openid-a', 'ds-a')
    const first = seedPackage(A, IDS, { remaining: 12, total: 12 })
    const second = seedPackage(A, { studentId: 'stu-a-2', packageId: 'pkg-a-2', saleId: 'sale-a-2' }, { remaining: 5, total: 5 })
    const taken = await cmd(A, 'createBooking', 'm2f_b_take', { studentId: first.studentId, packageId: first.packageId, date: '2026-10-02', hour: 14, minute: 0 })
    assert.equal(taken.ok, true, JSON.stringify(taken))
    const clash = await cmd(A, 'createBooking', 'm2f_b_clash', { studentId: second.studentId, packageId: second.packageId, date: '2026-10-02', hour: 14, minute: 0 })
    assert.equal(clash.ok, false, '同一教练同一时间不能排两位会员')
    assert.equal(clash.code, 'BOOKING_TIME_CONFLICT', `挡住它的必须是教练时间冲突（实测 ${clash.code}）`)
    // ⭐ 反过来验证「教练时间不共享」：B 自己那本 14:00 是空的（A 的课不占 B 的时间），
    //    所以 B 给同一位会员约 14:00 被挡住时，**挡住它的只能是会员时间**，绝不是教练时间。
    const B = seedCoach('openid-b', 'ds-b')
    const share = await cmd(A, 'setPackageShare', 'm2f_b_share', { packageId: first.packageId })
    const byB = await cmd(B, 'createSharedBooking', 'm2f_b_clash_member', { shareCode: share.result.shareCode, date: '2026-10-02', hour: 14, minute: 0 })
    assert.equal(byB.ok, false, JSON.stringify(byB))
    assert.equal(byB.code, 'MEMBER_TIME_CONFLICT', `B 自己的 14:00 是空的 ⇒ 必须是会员时间挡的（实测 ${byB.code}）`)
    // 换一天（会员有空）⇒ B 立刻排得进去：A 的课表从来没有占住 B 的时间。
    const nextDay = await cmd(B, 'createSharedBooking', 'm2f_b_ok', { shareCode: share.result.shareCode, date: '2026-10-03', hour: 14, minute: 0 })
    assert.equal(nextDay.ok, true, `教练时间不共享：换个会员有空的时间，B 必须排得进去（${JSON.stringify(nextDay)}）`)
  })

  // ———————————————————————————————————————————————— C / D
  await test('C/D：会员时间共享 —— 小蓝 14:00 已和 A 有课，B 不能再约；换 15:00 就成功', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const ids = seedPackage(A, IDS, { remaining: 12, total: 12 })
    const share = await cmd(A, 'setPackageShare', 'm2f_cd_share', { packageId: ids.packageId })
    const byA = await cmd(A, 'createBooking', 'm2f_cd_a', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 14, minute: 0 })
    assert.equal(byA.ok, true, JSON.stringify(byA))

    const clash = await cmd(B, 'createSharedBooking', 'm2f_cd_clash', { shareCode: share.result.shareCode, date: '2026-10-02', hour: 14, minute: 0 })
    assert.equal(clash.ok, false, '会员 14:00 已经有课 ⇒ 换教练也不能重复占')
    assert.equal(clash.code, 'MEMBER_TIME_CONFLICT', `挡住它的必须是**会员**时间冲突，不是教练时间（实测 ${clash.code}）`)

    const ok = await cmd(B, 'createSharedBooking', 'm2f_cd_ok', { shareCode: share.result.shareCode, date: '2026-10-02', hour: 15, minute: 0 })
    assert.equal(ok.ok, true, `15:00 双方都有空 ⇒ 必须成功（${JSON.stringify(ok)}）`)
    assert.equal(occOf(A, ids.packageId).reserved, 2)
    // 反向也不能漏：B 已占 15:00，A 再给小蓝约 15:00 同样要被挡（会员时间不因换教练而重置）。
    const reverse = await cmd(A, 'createBooking', 'm2f_cd_reverse', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 15, minute: 0 })
    assert.equal(reverse.code, 'MEMBER_TIME_CONFLICT', `反向也必须被会员时间挡住（实测 ${reverse.code}）`)
  })

  // ———————————————————————————————————————————————— E
  await test('E：最后一节课并发 —— A / B 两种顺序抢，都只能成功一个（真实课时绝不变负）', async () => {
    for (const [label, aFirst] of [['A 先', true], ['B 先', false]]) {
      clear()
      const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
      const ids = seedPackage(A, IDS, { remaining: 1, total: 12 })
      const share = await cmd(A, 'setPackageShare', `m2f_e_${aFirst ? 1 : 2}_share`, { packageId: ids.packageId })
      const byA = () => cmd(A, 'createBooking', `m2f_e_${aFirst ? 1 : 2}_a`, { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10, minute: 0 })
      const byB = () => cmd(B, 'createSharedBooking', `m2f_e_${aFirst ? 1 : 2}_b`, { shareCode: share.result.shareCode, date: '2026-10-02', hour: 11, minute: 0 })
      const first = aFirst ? await byA() : await byB()
      const second = aFirst ? await byB() : await byA()
      assert.equal(first.ok, true, `${label}：第一个必须成功 ${JSON.stringify(first)}`)
      assert.equal(second.ok, false, `${label}：第二个必须被挡住`)
      assert.equal(second.code, 'PACKAGE_NO_AVAILABLE', `${label}：挡住它的必须是"排满了"（实测 ${second.code}）`)
      const occ = occOf(A, ids.packageId)
      assert.equal(occ.remaining, 1, '真实课时只有 1 节，绝不能变负')
      assert.equal(occ.reserved, 1, '只占 1 节 —— 绝不允许两节都约上')
      assert.equal(bookingsOf(A).length + bookingsOf(B).length, 1, `${label}：最终全场只有一条预约`)
    }
  })

  // ———————————————————————————————————————————————— F
  await test('F：取消未完成的预约 —— 只释放 reserved，remaining / used 一动不动', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const ids = seedPackage(A, IDS, { remaining: 12, total: 12 })
    const share = await cmd(A, 'setPackageShare', 'm2f_f_share', { packageId: ids.packageId })
    const byB = await cmd(B, 'createSharedBooking', 'm2f_f_book', { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(byB.ok, true)
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 12, reserved: 1, availableToBook: 11 })
    const cancelled = await cmd(B, 'cancelBooking', 'm2f_f_cancel', { bookingId: byB.result.bookingId })
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
    const occ = occOf(A, ids.packageId), pkg = pkgOf(A, ids.packageId)
    assert.deepStrictEqual(occ, { remaining: 12, reserved: 0, availableToBook: 12 }, '取消后：占座归零、真实课时不变')
    assert.equal(pkg.used, 0, '取消绝不动已用课时')
    assert.equal(bookingsOf(B).length, 0, '取消后不该留下幽灵预约')
  })

  // ———————————————————————————————————————————————— G
  await test('G：完课结算 reserved−1 / remaining−1 / used+1，且**不能重复执行**', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const ids = seedPackage(A, IDS, { remaining: 12, total: 12 })
    const share = await cmd(A, 'setPackageShare', 'm2f_g_share', { packageId: ids.packageId })
    const byB = await cmd(B, 'createSharedBooking', 'm2f_g_book', { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    const done = await completeBookingOf(B, byB.result.bookingId, 'g_done')
    assert.equal(done.ok, true, JSON.stringify(done))
    const occ = occOf(A, ids.packageId), pkg = pkgOf(A, ids.packageId)
    assert.deepStrictEqual(occ, { remaining: 11, reserved: 0, availableToBook: 11 }, '完课后：reserved −1、remaining −1')
    assert.equal(pkg.used, 1, 'used +1')
    // 重复完课：必须被拒，绝不能扣第二次。
    const again = await cmd(B, 'completeBooking', 'm2f_g_again', { bookingId: byB.result.bookingId })
    assert.equal(again.ok, false, '同一节课不能完课两次')
    assert.equal(again.code, 'BOOKING_ALREADY_DONE', `重复完课必须被明确拒绝（实测 ${again.code}）`)
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 11, reserved: 0, availableToBook: 11 }, '重复完课不得产生第二次扣课')
    assert.equal(pkgOf(A, ids.packageId).used, 1)
  })

  // ———————————————————————————————————————————————— H
  await test('H：待确认继续占座；「确认已完成」与「课程未进行」分别结算，且都幂等', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const ids = seedPackage(A, IDS, { remaining: 10, total: 12 })
    const share = await cmd(A, 'setPackageShare', 'm2f_h_share', { packageId: ids.packageId })
    const byB = await cmd(B, 'createSharedBooking', 'm2f_h_book', { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0, plannedMinutes: 60 })
    assert.equal(byB.ok, true, JSON.stringify(byB))
    const booking = bookingsOf(B)[0]
    assert.equal(booking.plannedMinutes, 60, '默认 60 分钟快照')
    // 超过「预计结束 + 3 小时」⇒ 派生为待确认（不落库、不自动处理）。
    const deadline = new Date(2026, 9, 2, 15, 0, 0).getTime() // 预计结束 11:00 + 3 小时 = 14:00，此时已超
    assert.equal(occupancy.pendingStateOf(booking, deadline), 'pending', '超过预计结束+3h ⇒ 待确认')
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 10, reserved: 1, availableToBook: 9 }, '待确认期间**继续占座**')

    // 路径一：确认已完成 ⇒ reserved−1 / remaining−1 / used+1，并产生收入。
    const done = await completeBookingOf(B, byB.result.bookingId, 'h_done')
    assert.equal(done.ok, true, JSON.stringify(done))
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 9, reserved: 0, availableToBook: 9 })
    assert.equal(pkgOf(A, ids.packageId).used, 3)

    // 路径二：课程未进行 ⇒ 只释放占座，remaining / used 不变、不产生收入。
    const byB2 = await cmd(B, 'createSharedBooking', 'm2f_h_book2', { shareCode: share.result.shareCode, date: '2026-10-03', hour: 10, minute: 0 })
    assert.equal(byB2.ok, true, JSON.stringify(byB2))
    const before = occOf(A, ids.packageId), usedBefore = pkgOf(A, ids.packageId).used
    const notHeld = await cmd(B, 'markBookingNotHeld', 'm2f_h_nothold', { bookingId: byB2.result.bookingId })
    assert.equal(notHeld.ok, true, JSON.stringify(notHeld))
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: before.remaining, reserved: before.reserved - 1, availableToBook: before.availableToBook + 1 }, '只释放占座')
    assert.equal(pkgOf(A, ids.packageId).used, usedBefore, '「未进行」绝不动已用课时')
    assert.equal(dataRows('incomes', B.owner, B.datasetId).length, 1, '未进行不产生收入（此前只有一条完课收入）')
    const again = await cmd(B, 'markBookingNotHeld', 'm2f_h_nothold2', { bookingId: byB2.result.bookingId })
    assert.equal(again.ok, false, '「未进行」不能重复释放占座')
  })

  // ———————————————————————————————————————————————— I
  await test('I：两位教练操作的是**同一份**会员课时事实 —— B 账里不出现第二套余额', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const ids = seedPackage(A, IDS, { remaining: 12, total: 12 })
    const share = await cmd(A, 'setPackageShare', 'm2f_i_share', { packageId: ids.packageId })
    await cmd(B, 'createSharedBooking', 'm2f_i_book', { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(rows('students', B.owner, B.datasetId).length, 0, 'B 绝不复制一份学员')
    assert.equal(rows('packages', B.owner, B.datasetId).length, 0, 'B 绝不复制一份课时包（第二套余额）')
    assert.equal(rows('sales', B.owner, B.datasetId).length, 0, 'B 绝不复制一份销售')
    // 全库按 packageId / studentId / saleId 数各自出现在几本账里 —— 必须都是 1。
    // 「课时有没有被复制」的唯一硬判据：全库里这份数据出现在几本账（必须 = 1）。
    const placesOf = collection => [...new Set([...stores[collection].values()].map(row => `${row.ownerCoachId}::${row.datasetId}`))]
    assert.equal(placesOf('packages').length, 1, '课时事实在全库只存在于一本账')
    assert.equal(placesOf('students').length, 1, '学员事实在全库只存在于一本账')
    assert.equal(placesOf('sales').length, 1, '销售事实在全库只存在于一本账')
  })

  // ———————————————————————————————————————————————— J
  await test('J：销售仍归记录购买的那位教练 A；授课收入归**实际授课**的教练 B', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const ids = seedPackage(A, IDS, { remaining: 12, total: 12 })
    const share = await cmd(A, 'setPackageShare', 'm2f_j_share', { packageId: ids.packageId })
    const byB = await cmd(B, 'createSharedBooking', 'm2f_j_book', { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(byB.result.teachingCoachId, B.owner, '这条预约的授课教练必须是发起它的 B')
    assert.equal(byB.result.source, 'coach')
    const done = await completeBookingOf(B, byB.result.bookingId, 'j_done')
    assert.equal(done.ok, true, JSON.stringify(done))
    assert.equal(dataRows('sales', A.owner, A.datasetId).length, 1, '销售业绩留在记录购买的那本账（A）')
    assert.equal(dataRows('sales', B.owner, B.datasetId).length, 0, '授课不会把销售业绩搬走')
    const incomesB = dataRows('incomes', B.owner, B.datasetId)
    assert.equal(incomesB.length, 1, '收入落在**实际授课**的教练 B 的账里')
    assert.equal(incomesB[0].bookingId, byB.result.bookingId)
    assert.equal(dataRows('incomes', A.owner, A.datasetId).length, 0, 'A 不该因为卖过课就拿到这节课的收入')
  })

  // ———————————————————————————————————————————————— 授课教练身份
  await test('授课教练身份：教练端创建 ⇒ 授课教练就是当前教练；旧预约按所在账本回落', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const ids = seedPackage(A, IDS, { remaining: 12, total: 12 })
    const own = await cmd(A, 'createBooking', 'm2f_ident_a', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(own.result.teachingCoachId, A.owner, 'A 建的预约 ⇒ 授课教练是 A')
    const share = await cmd(A, 'setPackageShare', 'm2f_ident_share', { packageId: ids.packageId })
    const shared = await cmd(B, 'createSharedBooking', 'm2f_ident_b', { shareCode: share.result.shareCode, date: '2026-10-02', hour: 15, minute: 0 })
    assert.equal(shared.result.teachingCoachId, B.owner, 'B 建的预约 ⇒ 授课教练是 B（课时仍归会员）')
    const bookingA = bookingsOf(A)[0], bookingB = bookingsOf(B)[0]
    assert.equal(bookingA.teachingCoachId, A.owner)
    assert.equal(bookingA.source, 'coach'); assert.equal(bookingA.createdByCoachId, A.owner)
    assert.equal(bookingB.teachingCoachId, B.owner)
    assert.equal(bookingB.source, 'coach'); assert.equal(bookingB.createdByCoachId, B.owner)
    // 旧数据兼容：没有 teachingCoachId 的预约，按它所在那本账的 owner 回落（不需要迁移）。
    assert.equal(teaching.teachingCoachIdOf({ status: 'booked' }, A.owner), A.owner)
    assert.equal(teaching.teachingCoachIdOf({ status: 'booked', teachingCoachId: B.owner }, A.owner), B.owner)
  })

  // ———————————————————————————————————————————————— K
  await test('K：正式区 / Sandbox 严格隔离 —— Sandbox 全流程不碰任何正式区集合', async () => {
    const A = seedCoach('openid-a', 'ds-a'), B = seedCoach('openid-b', 'ds-b')
    const ids = seedPackage(A, IDS, { remaining: 12, total: 12 })
    const share = await cmd(A, 'setPackageShare', 'm2f_k_share', { packageId: ids.packageId })
    await cmd(B, 'createSharedBooking', 'm2f_k_book', { shareCode: share.result.shareCode, date: '2026-10-02', hour: 10, minute: 0 })
    // ⚠️ `coaches` / `datasets` 是**两环境共用**的身份与数据集集合（不是业务数据），不参与本断言。
    const shared = new Set([META.coaches, META.datasets])
    Object.values(META).filter(name => !shared.has(name)).forEach(name => {
      assert.equal([...stores[name].values()].length, 0, `正式区集合 ${name} 必须一个字都没被 Sandbox 流程碰到`)
    })
    assert.ok([...stores[SANDBOX_META.packageShares].values()].length >= 1, '共享许可只写在 Sandbox 集合里')
    assert.equal([...stores[META.packageShares].values()].length, 0, 'Sandbox 的共享许可不得落到正式区集合')
  })

  if (!process.exitCode) process.stdout.write('ALL M2 MEMBER LESSON FACT TESTS PASSED\n')
})()
