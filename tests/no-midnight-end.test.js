// 2026-10-02 **三次口径**：**禁止新课跨午夜** —— 堵掉二次口径留下的缺口。
//
// 起因：二次口径把「开始 ≤ 23:00」钉住了，但没有约束**结束**。于是留下了这个形状：
//     23:00 起 + **90 分钟** ⇒ 次日 00:30
//   它开课时间合法 ⇒ 闸门放行；而课表已经不画次日「接上节」片段 ⇒
//   **看不见，却占着时间** —— 比显示出来更糟（用户找不到它，也不知道自己为什么排不了那节课）。
//
// 规则（用户逐条确认）：
//   ① 新建 / 会员预约 / 改期，**开始 ≤ 23:00 且 结束 ≤ 当天 24:00**，两条同时满足；
//   ② 23:00 + 60 ⇒ 24:00 ✅（正好卡在当天界上）；
//   ③ 23:00 + 90 ⇒ 次日 00:30 ⛔；
//   ④ 22:30 + 90 ⇒ 24:00 ✅（开始更早，换来的时长）；
//   ⑤ 本机 package-occupancy 与云端 coachBusinessCommand/occupancy **孪生完全一致**；
//   ⑥ 六个入口同一规则：会员预约 / 教练新建 / 改期 / 跨教练共享码 / 跨教练授权 / 分享可约；
//   ⑦ ⛔ **存量** 23:30 跨午夜旧课照旧兼容：能查看详情、照旧占用次日时间，不迁移不删不改；
//   ⑧ 提示文案必须说明「课程必须在当天 24:00 前结束」。
//
// ⛔ 本文件**不碰** Production / Sandbox：所有写入都发生在测试世界的内存账本里。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createWorld, runner } = require('./helpers/m2-business-world')
const { todayKey, addDays } = require('../utils/beijing-date')
const cloudOccupancy = require('../cloudfunctions/coachBusinessCommand/occupancy')
const localOccupancy = require('../utils/package-occupancy')
const view = require('../utils/member-booking-view')
const manage = require('../utils/member-booking-manage')

const world = createWorld()
const ROOT = path.join(__dirname, '..')
const DAY_END = 24 * 60

async function seed() {
  require('../utils/data-runtime').setEnvironment('sandbox')
  world.installRuntime()
  const A = world.seedCoach('openid-endday', 'ds-endday', 'PUBENDDAY')
  world.seedStudent(A, 'stu-1', '跨午夜学员')
  const sold = await world.execute(A, 'createCourseSale', {
    studentId: 'stu-1', type: '常规训练', total: 8, remaining: 8,
    quantity: 8, unitPrice: 100, amount: 800, date: todayKey()
  })
  assert.equal(sold.ok, true, JSON.stringify(sold))
  return { A, packageId: sold.result.packageId }
}

const readFile = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')
// ⭐ 一条**存量**的跨午夜旧课（Sandbox 里真实存在的那条：10-02 23:30 → 10-03 00:30）。
const LEGACY = { id: 'legacy-2330', date: '2026-10-02', hour: 23, minute: 30, plannedMinutes: 60, status: 'booked' }
const LEGACY_SNAPSHOT = JSON.parse(JSON.stringify(LEGACY))

async function main() {
  // ------------------------------------------------------------------ ① 阈值本身
  await runner('① 口径：**开始 ≤ 23:00 且 结束 ≤ 当天 24:00**（两端孪生逐字一致）', async () => {
    for (const [tag, occ] of [['本机', localOccupancy], ['云端', cloudOccupancy]]) {
      assert.strictEqual(occ.LATEST_START_MINUTES, 23 * 60, `${tag} 最晚开课 23:00`)
      assert.strictEqual(occ.DAY_END_MINUTES, DAY_END, `${tag} 当天结束 24:00`)
      assert.strictEqual(occ.END_TOO_LATE_MESSAGE.includes('24:00 前结束'), true, `${tag} 文案必须说明"当天 24:00 前结束"（实测：${occ.END_TOO_LATE_MESSAGE}）`)
    }
    assert.strictEqual(localOccupancy.DAY_END_MINUTES, cloudOccupancy.DAY_END_MINUTES, '孪生不许漂移')
    assert.strictEqual(localOccupancy.END_TOO_LATE_MESSAGE, cloudOccupancy.END_TOO_LATE_MESSAGE, '孪生文案不许漂移')
  })

  // ------------------------------------------------------------------ ②⭐ 四条样本表（用户点名的组合）
  await runner('② ⭐ 23:00+60 ✅ / 23:00+90 ⛔ / 22:30+90 ✅ / 23:30+60 ⛔（两端同一把尺）', async () => {
    const samples = [
      [{ hour: 23, minute: 0 }, 60, null, '23:00 + 60 ⇒ 24:00，合法'],
      [{ hour: 23, minute: 0 }, 90, 'BOOKING_END_TOO_LATE', '23:00 + 90 ⇒ 次日 00:30，必须拒'],
      [{ hour: 22, minute: 30 }, 90, null, '22:30 + 90 ⇒ 24:00，合法'],
      [{ hour: 23, minute: 30 }, 60, 'BOOKING_START_TOO_LATE', '23:30 开课本身已被取消'],
      [{ hour: 23, minute: 0 }, 120, 'BOOKING_END_TOO_LATE', '23:00 + 120 ⇒ 次日 01:00，必须拒'],
      [{ hour: 7, minute: 0 }, 1440, 'BOOKING_END_TOO_LATE', '极端时长也要被这条闸拦住']
    ]
    for (const [moment, minutes, expected, why] of samples) {
      for (const [tag, occ] of [['本机', localOccupancy], ['云端', cloudOccupancy]]) {
        const gate = occ.lessonWindowGateOf(moment, minutes)
        assert.strictEqual(gate ? gate.code : null, expected, `${tag}：${why}（实测 ${gate ? gate.code : '放行'}）`)
      }
      for (const [tag, occ] of [['本机', localOccupancy], ['云端', cloudOccupancy]]) {
        const verdict = occ.startVerdictOf(moment, minutes)
        assert.strictEqual(verdict, expected ? (expected === 'BOOKING_END_TOO_LATE' ? 'end-too-late' : 'too-late') : 'ok',
          `${tag} verdict：${why}（实测 ${verdict}）`)
      }
    }
  })

  // ------------------------------------------------------------------ ③ 教练新建（端到端写入）
  await runner('③ ⭐ 教练新建：23:00+90 被拒（BOOKING_END_TOO_LATE），22:30+90 成功落库', async () => {
    world.reset()
    const { A, packageId } = await seed()
    const date = addDays(todayKey(), 1)

    const long = await world.execute(A, 'createBooking',
      { studentId: 'stu-1', packageId, date, hour: 23, minute: 0, plannedMinutes: 90 }, 'edw_c_2390')
    assert.equal(long.ok, false, `23:00 + 90 必须被拒（实测 ${JSON.stringify(long)}）`)
    assert.equal(long.code, 'BOOKING_END_TOO_LATE', `实测 ${JSON.stringify(long)}`)

    const fine = await world.execute(A, 'createBooking',
      { studentId: 'stu-1', packageId, date, hour: 22, minute: 30, plannedMinutes: 90 }, 'edw_c_2230_90')
    assert.equal(fine.ok, true, `22:30 + 90 ⇒ 24:00 结束，合法（实测 ${JSON.stringify(fine)}）`)

    const edge = await world.execute(A, 'createBooking',
      { studentId: 'stu-1', packageId, date: addDays(todayKey(), 2), hour: 23, minute: 0, plannedMinutes: 60 }, 'edw_c_2360')
    assert.equal(edge.ok, true, `23:00 + 60 ⇒ 24:00 结束，合法（实测 ${JSON.stringify(edge)}）`)

    const rows = world.dataRows('bookings', A.owner, A.datasetId)
    assert.equal(rows.length, 2, `只有 22:30+90 与 23:00+60 两条真的落库（实测 ${rows.length}）`)
    assert.ok(!rows.some(row => row.hour * 60 + (row.minute || 0) + (row.plannedMinutes || 60) > DAY_END),
      '落库的课一律不许跨午夜')
  })

  // ------------------------------------------------------------------ ④ 改期不许绕过
  await runner('④ ⭐ 改期：先把正常的课改成 23:00（90 分钟的那节）⇒ 必须拒，且**原时间不许被改掉**', async () => {
    world.reset()
    const { A, packageId } = await seed()
    const date = addDays(todayKey(), 1)
    // 建一节 90 分钟的课，落在 10:00
    const created = await world.execute(A, 'createBooking',
      { studentId: 'stu-1', packageId, date, hour: 10, minute: 0, plannedMinutes: 90 }, 'edw_rs_base')
    assert.equal(created.ok, true, JSON.stringify(created))
    const id = created.result.bookingId

    const moved = await world.execute(A, 'rescheduleBooking', { bookingId: id, date, hour: 23, minute: 0 }, 'edw_rs_2300')
    assert.equal(moved.ok, false, '90 分钟的课改到 23:00 ⇒ 次日 00:30 ⇒ 必须拒')
    assert.equal(moved.code, 'BOOKING_END_TOO_LATE', `实测 ${JSON.stringify(moved)}`)

    const still = world.dataRows('bookings', A.owner, A.datasetId).find(row => row.id === id)
    assert.equal(still.hour, 10, '被拒的改期不许把原时间改掉')
    assert.equal(still.minute, 0)

    // 改到 22:30（90 ⇒ 24:00）⇒ 合法
    const ok = await world.execute(A, 'rescheduleBooking', { bookingId: id, date, hour: 22, minute: 30 }, 'edw_rs_2230')
    assert.equal(ok.ok, true, `90 分钟的课改到 22:30 ⇒ 24:00 结束，合法（实测 ${JSON.stringify(ok)}）`)

    // 60 分钟的老快照改到 23:00 ⇒ 合法
    const shortOne = await world.execute(A, 'createBooking',
      { studentId: 'stu-1', packageId, date: addDays(todayKey(), 2), hour: 9, minute: 0 }, 'edw_rs_base60')
    const shortId = shortOne.result.bookingId
    const toEdge = await world.execute(A, 'rescheduleBooking',
      { bookingId: shortId, date: addDays(todayKey(), 2), hour: 23, minute: 0 }, 'edw_rs_short_2300')
    assert.equal(toEdge.ok, true, '60 分钟的课改到 23:00 ⇒ 24:00 结束，合法')
  })

  // ------------------------------------------------------------------ ⑤ 会员入口（可选格子 + 改期预检）
  await runner('⑤ ⭐ 会员：90 分钟的课时包不再出现 23:00 那格；改期预检也明确拒绝', async () => {
    const slots60 = view.slotsFor({ dateKey: '2026-10-20', busy: [], todayKey: '2026-01-01' })
    assert.ok(slots60.some(slot => slot.start === 23 * 60), '60 分钟：23:00 那一格必须还在')
    const slots90 = view.slotsFor({ dateKey: '2026-10-20', busy: [], todayKey: '2026-01-01', length: 90 })
    assert.ok(!slots90.some(slot => slot.start === 23 * 60), '90 分钟：23:00 那一格必须消失')
    assert.ok(slots90.some(slot => slot.start === 22 * 60 + 30), '90 分钟：22:30 那一格必须还在')
    assert.ok(!slots90.some(slot => slot.end > DAY_END), '⛔ 一个会跨午夜的格子都不许生成')
    assert.strictEqual(slots90[slots90.length - 1].end, DAY_END, '最后一格必须正好结束在 24:00')

    // 会员改期预检（本机 slotsProblemOf 那条通道）
    const problem = manage.slotProblemOf({ start: 23 * 60, end: 23 * 60 + 90 }, '2026-01-01')
    assert.ok(problem, '90 分钟改到 23:00 ⇒ 预检必须给出拒绝理由')
    assert.strictEqual(problem.code, 'BOOKING_END_TOO_LATE', `实测 ${JSON.stringify(problem)}`)
    assert.ok(problem.message.includes('24:00 前结束'), `文案必须说明"24:00 前结束"（实测 ${problem.message}）`)
    const allowed = manage.slotProblemOf({ start: 22 * 60 + 30, end: DAY_END }, '2026-01-01')
    assert.strictEqual(allowed, null, `22:30–24:00 必须放行（实测 ${JSON.stringify(allowed)}）`)
  })

  // ------------------------------------------------------------------ ⑥⛔ 存量旧课：能看 + 照旧占用
  await runner('⑥ ⭐⛔ 存量 23:30 旧课：仍能打开详情，**照旧占用**次日 00:00–00:30', async () => {
    const rows = [LEGACY]
    const sv = require('../utils/schedule-view')
    // ① 开始日：**23:30 那一格有它的卡片** ⇒ 点卡片就进详情（详情入口不过任何闸门）。
    //    ⚠️ 注意区分：整点 23:00 那一格点击是 `create` —— 23:00 那一刻还没人在上课，这是对的。
    const index = sv.buildScheduleIndex(rows)
    assert.ok((index.bySlot['2026-10-02|23'] || []).some(row => row.id === LEGACY.id),
      '开始日 23 点那一格必须仍有这一节课的卡片 ⇒ 点它就能进详情')
    assert.strictEqual(sv.cellTapIntentOf(rows, '2026-10-02', 23).kind, 'create',
      '23:00 那一刻还没上课 ⇒ 仍可从整点新建（新课默认 60 分钟，23:00+60=24:00 合法）')
    // 次日 00:00 那一刻仍被占 ⇒ 点空白进去的是这一节课，不是新建
    const onNext = require('../utils/schedule-view').cellTapIntentOf(rows, '2026-10-03', 0)
    assert.strictEqual(onNext.kind, 'open', `次日 00:00 必须判为已占用（实测 ${JSON.stringify(onNext.kind)}）`)
    assert.strictEqual(onNext.row.id, LEGACY.id, '指向的必须是同一节课')
    // 01:00 已经出了它的区间 ⇒ 仍可新建
    assert.strictEqual(require('../utils/schedule-view').cellTapIntentOf(rows, '2026-10-03', 1).kind, 'create')
    // ⛔ 只读函数不许改写对象（它身为"历史数据"连一个字段都不许被碰）
    assert.deepStrictEqual(LEGACY, LEGACY_SNAPSHOT, '占用判定必须是只读的')
  })

  // ------------------------------------------------------------------ ⑦ 六个入口同一处 ∪ 文案
  await runner('⑦ 六个入口**全部**调用同一个闸门函数（不许有人自己写第二个 24:00）', async () => {
    const gateCall = /lessonWindowGateOf\(/
    const files = {
      '教练新建（本机先行）': 'utils/cloud-command-engine.js',
      '跨教练共享码 / 授权（本机先行）': 'utils/cloud-command-engine.js',
      '云端 createBooking': 'cloudfunctions/coachBusinessCommand/handlers.js',
      '云端 createBookingOnForeignPackage': 'cloudfunctions/coachBusinessCommand/handlers.js',
      '云端 rescheduleBooking': 'cloudfunctions/coachBusinessCommand/handlers.js'
    }
    for (const [label, file] of Object.entries(files)) {
      assert.ok(gateCall.test(readFile(file)), `${label} ⇒ ${file} 必须调用 occupancy.lessonWindowGateOf`)
    }
    // 会员端（会员预约预检 / 会员改期 / 可选格子）走的是 `startVerdictOf` + `endsAfterDayEnd`
    // —— 同一个 occupancy，同一份阈值，只是返回形状不同（要给会员四句不同的话）。
    assert.ok(/occupancy\.startVerdictOf\(/.test(readFile('utils/member-booking-request.js')), '会员预约预检必须走 startVerdictOf')
    assert.ok(/occupancy\.startVerdictOf\(/.test(readFile('utils/member-booking-manage.js')), '会员改期预检必须走 startVerdictOf')
    assert.ok(/'end-too-late'/.test(readFile('utils/member-booking-manage.js')), '会员改期必须处理 end-too-late')
    assert.ok(/'end-too-late'/.test(readFile('cloudfunctions/coachBusinessCommand/memberBooking.js')), '云端会员通道必须处理 end-too-late')
    assert.ok(/occupancy\.endsAfterDayEnd\(/.test(readFile('utils/member-booking-view.js')), '会员可选格子必须走 endsAfterDayEnd')
    // UI 三个出网前的最后一道闸也不许绕过
    // （2026-10-06：旧的「多教练服务」授权工作台页面已下线，跨教练排课出口搬到 `pages/students`。）
    for (const file of ['pages/students/students.js', 'pages/session/session.js', 'pages/sandbox-shared-test/sandbox-shared-test.js', 'components/booking-modal/booking-modal.js']) {
      assert.ok(gateCall.test(readFile(file)), `${file} 必须走同一个闸门（不许单独判 startsAfterLatest）`)
    }
    // ⛔ 任何业务文件都不许再直接判「开始」当作唯一闸门（只有 occupancy 内部禁止 examples）
    const leftovers = []
    for (const file of ['utils/cloud-command-engine.js', 'cloudfunctions/coachBusinessCommand/handlers.js', 'pages/session/session.js', 'pages/sandbox-shared-test/sandbox-shared-test.js', 'components/booking-modal/booking-modal.js']) {
      readFile(file).split('\n').forEach((line, index) => {
        if (/startsAfterLatest\(/.test(line)) leftovers.push(`${file}:${index + 1}`)
      })
    }
    assert.deepStrictEqual(leftovers, [], `⛔ 这些地方还在只判"开始"，漏了"结束 ≤ 24:00"：${leftovers.join(', ')}`)
  })

  // ------------------------------------------------------------------ ⑧ 文案：不许再写"最晚 23:30 开课"
  await runner('⑧ 文案：入口提示必须说明「课程必须在当天 24:00 前结束」', async () => {
    assert.ok(localOccupancy.END_TOO_LATE_MESSAGE.includes('24:00 前结束'))
    assert.ok(cloudOccupancy.END_TOO_LATE_MESSAGE.includes('24:00 前结束'))
    // 错误码映射表里必须登记，否则会员端只能看到裸 code
    assert.strictEqual(require('../utils/member-booking-request').FRIENDLY_MESSAGES.BOOKING_END_TOO_LATE, localOccupancy.END_TOO_LATE_MESSAGE)
    assert.strictEqual(require('../utils/member-booking-manage').FRIENDLY_MESSAGES.BOOKING_END_TOO_LATE, localOccupancy.END_TOO_LATE_MESSAGE)
    // 📌 上一轮那条"取消 23:30"的口径描述仍然成立（历史叙事），但**入口提示**不许再出现 23:30
    const forbidden = []
    for (const file of ['utils/package-occupancy.js', 'cloudfunctions/coachBusinessCommand/occupancy.js', 'components/booking-modal/booking-modal.js', 'pages/students/students.js', 'pages/session/session.js', 'pages/sandbox-shared-test/sandbox-shared-test.js']) {
      readFile(file).split('\n').forEach((line, index) => {
        if (/最晚\s*23:30/.test(line) || /23:30 或更早/.test(line)) forbidden.push(`${file}:${index + 1}`)
      })
    }
    assert.deepStrictEqual(forbidden, [], `⛔ 还在写"最晚 23:30 开课"：${forbidden.join(', ')}`)
  })
}

// helper 的 runner 自己负责打印 PASS/FAIL 与退出码（与其它测试同一套口径）。
main().then(() => {
  process.stdout.write('\nALL NO-MIDNIGHT END TESTS PASSED\n')
}).catch(error => {
  process.stderr.write(`\nNO-MIDNIGHT END TESTS FAILED: ${error.stack}\n`)
  process.exitCode = 1
})
