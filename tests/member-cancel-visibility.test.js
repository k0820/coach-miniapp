// 会员取消后「教练端仍看到这节课 / 会员端把已取消算成已完成」· 永久回归（2026-10-01 真机事故）
//
// 【真机事实】
//   1. A 把「M2共享测试学员」授权给 B       2. 会员用 M2 的课包约 B，10-01 18:00
//   3. B 端收到课                            4. 会员取消 ⇒ 会员端「待上课」3→2（取消成功）
//   5. B 端切换页面 / 下拉刷新后 18:00 那节**仍在**
//   6. 会员端「已完成」16→17（把已取消统计成了已完成）
//
// 【审计结论（四选一，必须有证据）】
//   ❌ 不是取消命令的错：Sandbox 复现证明云端把 B 账里那一行**正确**写成 `status='cancelled'`，
//      并释放了占座（①）。
//   ❌ 不是被授权教练投影的错：预约本来就该落在授课教练 B 的账里（③）。
//   ❌ 不是缓存 / 跨教练同步的错：云端写入在事务内完成、revision 已推进（①）。
//   ✅ **是呈现层的口径缺失**：会员自助取消**保留** `cancelled` 行（用户拍板的产品规则），
//      而所有消费端都是按"取消 = 物理删除"写出来的 ⇒ 没人认识 `cancelled`：
//        · 教练课表把它渲染成「待上」的课（症状 5）；
//        · 学员详情把它列进"还没上的课"；
//        · 会员端历史页签直接叫「已完成」（症状 6）。
//      ⇒ 三处同一个根因：「这条预约算不算一节要上的课 / 算不算已完成」没有**唯一答案**。
//
// 【修法】`utils/package-occupancy.js` 加 `isCancelled` / `countsAsCompleted`（唯一口径），
//   三个消费端全部改用它；并从页面里抽出纯函数 `utils/schedule-view.js`，让测试能直接咬住。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const { createWorld, runner } = require('./helpers/m2-business-world')
const memberBooking = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
const cloudOccupancy = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/occupancy'))
const occupancy = require(path.join(ROOT, 'utils/package-occupancy'))
const scheduleView = require(path.join(ROOT, 'utils/schedule-view'))
const bookingView = require(path.join(ROOT, 'utils/member-booking-view'))

const ENV = 'sandbox'
const CLAIMS = 'member_sandbox_student_claims'
const CLOCK0 = 1900000000000
const TODAY = memberBooking.beijingDateKey(CLOCK0)
const world = createWorld()

const D = offset => cloudOccupancy.addDateDays(TODAY, offset)
const coachKeyOf = coachId => memberBooking.fixedId('member-coach-view', coachId)
const payloadOf = response => (response && response.result) || {}
const codeOf = response => String((response && response.code) || '')
const readFile = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')
// ⛔ 扫"代码里有没有手写判断"时必须先去掉注释行：注释里为了说明原因会**原样写出**那条判断，
//    不剥掉的话静态扫描永远命中自己的注释（假红）。
const codeOf2 = relative => readFile(relative).split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')

let A, B, CLAIM, PKG
function setup() {
  world.reset()
  A = world.seedCoach('open-a', 'ds-a', 'PUBA')
  B = world.seedCoach('open-b', 'ds-b', 'PUBB')
  world.seedStudent(A, 'stu-1', 'M2 共享测试学员')
  world.put('packages', world.businessId('packages', A.owner, A.datasetId, 'pkg-1'), {
    ownerCoachId: A.owner, datasetId: A.datasetId, packageId: 'pkg-1', studentId: 'stu-1',
    data: { id: 'pkg-1', type: '常规训练', total: 10, remaining: 10, used: 0, reserved: 0, reservedVersion: 2, price: 300, status: 'active', saleDate: TODAY }
  })
  const claimId = memberBooking.fixedId(CLAIMS, A.owner, 'stu-1')
  world.put(CLAIMS, claimId, { claimId, memberId: memberBooking.memberIdFor('open-m'), coachId: A.owner, studentId: 'stu-1', status: 'verified' })
  CLAIM = { claimId }
  PKG = 'pkg-1'
  memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
  return claimId
}

const bookingRows = coach => world.rows('bookings', coach.owner, coach.datasetId).map(row => ({ ...(row.data || {}), id: row.bookingId }))
const pkgOf = () => (world.rows('packages', A.owner, A.datasetId)[0] || {}).data || {}

async function memberCreate(date, hour, coach = B) {
  world.setOpenId('open-m')
  return world.main()({
    action: 'memberBooking', command: 'createMemberBooking',
    requestId: `mcv_${crypto.randomBytes(6).toString('hex')}`, environment: ENV,
    payload: {
      coachKey: coachKeyOf(coach.owner),
      packageViewId: memberBooking.fixedId('member-package-view', CLAIM.claimId, PKG),
      date, hour, minute: 0
    }
  })
}
async function memberCancel(bookingId) {
  world.setOpenId('open-m')
  return world.main()({
    action: 'memberBooking', command: 'cancelMemberBooking',
    requestId: `mcx_${crypto.randomBytes(6).toString('hex')}`, environment: ENV,
    payload: { bookingViewId: memberBooking.fixedId(memberBooking.BOOKING_VIEW_KIND, CLAIM.claimId, bookingId) }
  })
}

async function main() {
  // ---------------------------------------------------------------- ① 取消命令本身是对的（排除"取消命令"）
  await runner('① Sandbox 复现：会员取消后，被授权教练 B 账里那一行变成 cancelled 并释放占座', async () => {
    setup()
    await world.execute(A, 'grantPackageTeaching', { packageId: PKG, publicCodes: [B.publicCode] }, 'req_grant_1')
    const booked = await memberCreate(D(1), 18)
    assert.equal(payloadOf(booked).ok !== false, true, JSON.stringify(booked))
    const bookingId = (booked.bookingId || payloadOf(booked).bookingId)
    assert.equal(world.rows('bookings', B.owner, B.datasetId).length, 1, '课落在授课教练 B 的账里')
    assert.equal(pkgOf().reserved, 1, '预约占掉 1 节')

    const cancelled = await memberCancel(bookingId)
    assert.equal(cancelled.ok, true, `取消必须成功：${JSON.stringify(cancelled)}`)
    const row = bookingRows(B).find(item => item.id === bookingId)
    assert.ok(row, 'B 账里那一行还在（保留历史，不物理删除 —— 这是用户拍板的产品规则）')
    assert.equal(row.status, 'cancelled', `⛔ 云端必须把它写成 cancelled（实测 ${row.status}）`)
    assert.equal(cancelled.releasedReserved === true || payloadOf(cancelled).releasedReserved === true, true, '占座必须释放')
    assert.deepStrictEqual(
      { remaining: pkgOf().remaining, used: pkgOf().used, reserved: pkgOf().reserved },
      { remaining: 10, used: 0, reserved: 0 },
      '取消不扣课：remaining / used 一个字不动，只把 reserved 放回去'
    )
    assert.ok(Number(cancelled.datasetRevision || payloadOf(cancelled).datasetRevision) > 1, 'revision 必须推进（证明写入真的落库了）')
  })

  // ---------------------------------------------------------------- ② 共享口径：唯一真相源
  await runner('② 唯一口径：isCancelled / countsAsCompleted 只认状态，且与云端 blocksTimeSlot 同义', async () => {
    assert.equal(occupancy.isCancelled({ status: 'cancelled' }), true)
    assert.equal(occupancy.isCancelled({ status: 'booked' }), false)
    assert.equal(occupancy.isCancelled({ status: 'done' }), false)
    assert.equal(occupancy.isCancelled({ status: 'noshow' }), false)
    assert.equal(occupancy.isCancelled({}), false, '没有状态字段（老数据）一律按"没取消"处理')
    assert.equal(occupancy.countsAsCompleted({ status: 'done' }), true)
    assert.equal(occupancy.countsAsCompleted({ status: 'cancelled' }), false, '⛔ 已取消**不是**已完成')
    assert.equal(occupancy.countsAsCompleted({ status: 'noshow' }), false, '未到场**不是**已完成')
    assert.equal(occupancy.countsAsCompleted({ status: 'booked' }), false)
    // ⛔ 云端那一侧（`blocksTimeSlot`：已取消不占时段）必须与客户端口径一致，不许出现两套答案。
    assert.equal(cloudOccupancy.blocksTimeSlot({ status: 'cancelled' }), false)
    assert.equal(cloudOccupancy.blocksTimeSlot({ status: 'booked' }), true)
  })

  // ---------------------------------------------------------------- ③ 教练课表：已取消的课不再是一节"要上的课"
  await runner('③ 课表索引：cancelled 不进 bySlot / byDate，但**原样保留**在 cancelledByMember（不删数据）', async () => {
    const rows = [
      { id: 'b1', date: '2026-10-01', hour: 18, status: 'booked', studentName: 'M2共享测试学员' },
      { id: 'b2', date: '2026-10-01', hour: 19, status: 'cancelled', studentName: 'M2共享测试学员' },
      { id: 'b3', date: '2026-10-02', hour: 10, status: 'done', studentName: '甲' }
    ]
    const index = scheduleView.buildScheduleIndex(rows)
    assert.deepStrictEqual((index.bySlot['2026-10-01|18'] || []).map(row => row.id), ['b1'])
    assert.ok(!index.bySlot['2026-10-01|19'], '⛔ 已取消的课不许再占课表格子')
    assert.deepStrictEqual((index.byDate['2026-10-01'] || []).map(row => row.id), ['b1'])
    assert.deepStrictEqual((index.byDate['2026-10-02'] || []).map(row => row.id), ['b3'], '已完成的课照旧显示')
    assert.deepStrictEqual(index.cancelledByMember.map(row => row.id), ['b2'], '被排除的那条必须原样留下（不删数据）')
    assert.equal(index.cancelledByMember[0].status, 'cancelled')
  })

  await runner('④ 月视图计数：已取消的课不算进「N 节课程」/「待上」', async () => {
    const rows = [
      { id: 'b1', date: '2026-10-01', hour: 18, status: 'booked' },
      { id: 'b2', date: '2026-10-01', hour: 19, status: 'cancelled' },
      { id: 'b3', date: '2026-10-01', hour: 20, status: 'done' }
    ]
    const byDate = scheduleView.buildScheduleIndex(rows).byDate
    const list = byDate['2026-10-01'] || []
    const done = list.filter(row => occupancy.countsAsCompleted(row)).length
    assert.equal(list.length, 2, '这一天的课表只剩 2 节（已取消的不算）')
    assert.equal(done, 1)
    assert.equal(list.length - done, 1, '⛔ 待上 = 1，不是 2（已取消不许被算成待上）')
  })

  await runner('⑤ 教练必须**看得见**是谁取消了哪几节（不静默隐藏）', async () => {
    const rows = [
      { id: 'b1', date: '2026-10-01', hour: 18, status: 'cancelled', studentName: 'M2共享测试学员' },
      { id: 'b2', date: '2026-10-01', hour: 9, status: 'cancelled', studentName: '甲' },
      { id: 'b3', date: '2026-10-01', hour: 10, status: 'booked', studentName: '乙' }
    ]
    const index = scheduleView.buildScheduleIndex(rows)
    const notice = scheduleView.cancelNoticeOf(index.cancelledByMember, '2026-10-03')
    assert.equal(notice.count, 2, '提示条必须报被取消的节数')
    assert.ok(notice.latest.indexOf('2026-10-01 18:00') === 0, `最新的一节必须写明日期时间（实测 ${notice.latest}）`)
    assert.ok(notice.latest.indexOf('M2共享测试学员') > 0, '必须写明是哪位学员')
    assert.equal(notice.lines.length, 2)
    // ⛔ 7 天窗口外的旧取消不该永远挂在课表顶部。
    const stale = [{ id: 'old', date: '2026-09-01', hour: 10, status: 'cancelled', studentName: '旧学员' }]
    assert.equal(scheduleView.cancelNoticeOf(stale, '2026-10-03').count, 0, '超窗口的旧记录不再打扰')
    assert.equal(scheduleView.cancelNoticeOf(stale, '2026-09-03').count, 1, '窗口内照旧提示')
  })

  await runner('⑥ 学员详情：已取消的课不许再列进「还没上的课」', async () => {
    const rows = [
      { id: 'b1', status: 'booked', date: '2026-10-01' },
      { id: 'b2', status: 'cancelled', date: '2026-10-02' },
      { id: 'b3', status: 'done', date: '2026-09-01' },
      { id: 'b4', status: 'noshow', date: '2026-09-02' }
    ]
    assert.deepStrictEqual(scheduleView.pendingListOf(rows).map(row => row.id), ['b1', 'b4'])
    const source = readFile('pages/students/students.js')
    assert.ok(source.includes('scheduleView.pendingListOf('), '学员详情必须走共享口径，不许自己写 status 判断')
  })

  // ---------------------------------------------------------------- ⑦ 会员端：已取消不许被算成"已完成"
  await runner('⑦ 会员端：取消一节后「已完成」计数**不变**（16→17 是错的口径）', async () => {
    const before = [
      { historyId: 'u1', status: 'booked', date: D(1) },
      { historyId: 'u2', status: 'booked', date: D(2) },
      { historyId: 'u3', status: 'booked', date: D(3) }
    ].concat(Array.from({ length: 16 }, (_, i) => ({ historyId: `h${i}`, status: 'done', date: D(-1 - i) })))
    const splitBefore = bookingView.splitBookings(before, {})
    assert.equal(splitBefore.upcoming.length, 3, '取消前：待上课 3')
    const completedBefore = splitBefore.history.filter(row => occupancy.countsAsCompleted(row)).length
    assert.equal(completedBefore, 16, '取消前：已完成 16')

    const after = before.map(row => (row.historyId === 'u1' ? { ...row, status: 'cancelled' } : row))
    const splitAfter = bookingView.splitBookings(after, {})
    assert.equal(splitAfter.upcoming.length, 2, '取消后：待上课 2（真机一致）')
    assert.equal(splitAfter.history.length, 17, '历史页签会多一条（已取消也是"已经不会再上"的课）')
    // ⭐ 真机事故那一问的答案：17 只是"历史条数"，**不是**"已完成"。
    const completedAfter = splitAfter.history.filter(row => occupancy.countsAsCompleted(row)).length
    assert.equal(completedAfter, 16, '⛔ 已完成仍然必须是 16 —— 已取消不许被统计成已完成')
    assert.equal(splitAfter.history.find(row => row.historyId === 'u1').statusText, '已取消', '这一条必须明确标注「已取消」')
  })

  await runner('⑧ 会员端页签文案：不许再把「已取消」笼统叫成「已完成」', async () => {
    const wxml = readFile('pages/member-bookings/member-bookings.wxml')
    assert.ok(!/已完成\s*\{\{history\.length\}\}/.test(wxml), '⛔ 页签写着「已完成 {{history.length}}」⇒ 把已取消算成已完成')
    assert.ok(/历史\s*\{\{history\.length\}\}/.test(wxml), '页签必须叫「历史」（里面含已完成 / 已取消 / 未到场）')
  })

  await runner('⑨ 页面不许自己写 cancelled 手写判断（一律走共享口径）', async () => {
    const schedule = codeOf2('pages/schedule/schedule.js')
    assert.ok(schedule.includes('scheduleView.buildScheduleIndex('), '课表必须走共享口径建索引')
    assert.ok(!/status\s*===\s*'cancelled'/.test(schedule), '课表里不许再散落手写判断')
    const students = codeOf2('pages/students/students.js')
    assert.ok(students.includes('scheduleView.pendingListOf('), '学员详情必须走共享口径')
  })

  // ---------------------------------------------------------------- ⑩ 端到端：取消后那个时段真的空出来
  await runner('⑩ 端到端：会员取消后，同一位教练同一时段可以重新预约（时段真的释放了）', async () => {
    setup()
    await world.execute(A, 'grantPackageTeaching', { packageId: PKG, publicCodes: [B.publicCode] }, 'req_grant_2')
    const first = await memberCreate(D(1), 18)
    const bookingId = (first.bookingId || payloadOf(first).bookingId)
    await memberCancel(bookingId)
    const again = await memberCreate(D(1), 18)
    assert.equal(again.ok, true, `取消后同一时段必须能重新约：${JSON.stringify(again)}`)
    const live = bookingRows(B).filter(row => row.status !== 'cancelled')
    assert.equal(live.length, 1, 'B 的课表上只剩**一节**要上的课')
    assert.equal(pkgOf().reserved, 1, '占座重新 +1（没有重复占用）')
    // 已取消那条仍然是历史事实。
    assert.equal(bookingRows(B).filter(row => row.status === 'cancelled').length, 1, '已取消的那条仍保留在账里')
  })

  // ---------------------------------------------------------------- ⑪ 财务安全：已取消的课不许被完课
  await runner('⑪ 财务安全：已取消的课不许被教练完课（不许凭空产生收入 / 扣课时）', async () => {
    setup()
    await world.execute(A, 'grantPackageTeaching', { packageId: PKG, publicCodes: [B.publicCode] }, 'req_grant_3')
    const booked = await memberCreate(D(1), 18)
    const bookingId = (booked.bookingId || payloadOf(booked).bookingId)
    await memberCancel(bookingId)
    const done = await world.execute(B, 'completeBooking', { bookingId }, 'req_complete_1')
    assert.equal(done.ok, false, `⛔ 已取消的课不许被完课：${JSON.stringify(done)}`)
    assert.equal(codeOf(done), 'BOOKING_STATUS_INVALID', `实测 ${codeOf(done)}`)
    assert.deepStrictEqual(
      { remaining: pkgOf().remaining, used: pkgOf().used }, { remaining: 10, used: 0 },
      '被拒 ⇒ 一个课时都没扣'
    )
    assert.equal(world.rows('incomes', B.owner, B.datasetId).length, 0, '被拒 ⇒ 一笔收入都不许多')
  })
}

main().then(() => {
  if (process.exitCode) { console.error('\n[member-cancel-visibility] FAILED'); return }
  console.log('\n[member-cancel-visibility] ALL PASS')
}).catch(error => {
  console.error('\n[member-cancel-visibility] FAILED:', error && error.message)
  process.exit(1)
})
