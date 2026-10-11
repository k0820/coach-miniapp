// M2 V1｜开课时间窗口（2026-10-01 **用户最终确认口径**）—— ⛔ **本文件取代** `latest-end-2400.test.js`。
//
// 📌 订正记录（写清楚旧契约是怎么被取代的，防止有人照旧文件改回去）：
//   上一版文件叫 `latest-end-2400.test.js`，钉的是 2026-09-29 口径：
//     「课程**最晚 24:00 结束**」⇒ 23:00 + 60 = 24:00 ✅，23:30 + 60 = 24:30 ⛔。
//   2026-10-01 用户明确最终规则：
//     ① 每天最早开课 **07:00**；
//     ② 起始时间**步长 30 分钟**（07:00 / 07:30 / 08:00 / 08:30 …）；
//     ③ 当天**最后一个开课时间 23:30**；
//     ④ 课程**允许跨午夜结束**（23:30 + 60 ⇒ 次日 00:30 合法）。
//   ⇒ 旧口径与 ④ 直接冲突（它把用户点名要的 23:30 判成非法），因此**旧契约作废**，
//     不是"为了保持旧测试全绿而保留错误规则"。按项目惯例**连文件名一起改**，
//     避免留下一个与规则不符的名字误导后来的人。
//
// 📌 **二次订正（同一天，1.3.5 真机体验后）**：产品决定**取消 23:30 开课**（简化 MVP）⇒
//     ③ 改为「当天最后一个开课时间 **23:00**」（23:00 + 60 ⇒ **24:00 结束**，正好卡在界上 ✅）；
//     ④ 作废 —— 不再把"能跨午夜"当能力卖，课表也不再画次日「接上节」片段。
//   ⛔ 但**存量**的 23:30 跨午夜课**不是非法数据**：不删、不改、不迁移，
//     仍能从开始日打开详情，并**照旧占用**次日 00:00–00:30（见本文件 ⑧ 与
//     `latest-start-2300.test.js`）。闸门管的是**入口**（新开 / 改期），不是存量。
//
// ⛳ 为什么单独一个文件：
//   这条规则散在**六七个入口**（云端三条命令 / 本机引擎四处 / 三个页面的选择器与小时列 /
//   会员预约与改期两处预检 / 分享可约窗口）。分散在各测试里写，很容易出现
//   "某一条路径漏了闸但没人发现" —— 先约 10:00 再改到 23:45 就能绕过；跨教练排课走的是另一段内核。
//
// ⚠️ 三个码不许混（这正是"客户端允许但云端拒绝"的照妖镜）：
//   INVALID_PAYLOAD         = 这个时刻本身不存在（hour 25 / minute 60 / 24:30）
//   BOOKING_START_TOO_LATE  = 时刻合法，但开课晚于 23:00
//   BOOKING_START_TOO_EARLY = 时刻合法，但开课早于 **06:00**（⭐ 教练端与会员端**同一条规则**）
//   BOOKING_START_OFF_GRID  = 不在 30 分钟网格上（⛔ **只有会员自助通道**判这一条）
//
// ⭐ 2026-10-03（**第四次口径**）：最早开课 07:00 → **06:00**，并且**教练端的闸门也判最早**。
//   ⛔ 上一版刻意留的那个"补录通道不判最早开课"的口子，已按用户要求关闭 ⇒
//      `occupancy.lessonWindowGateOf()` 现在一次判三条（开始过早 / 开始过晚 / 结束跨午夜），
//      教练新建与改期、会员预约与改期全部只问它一个。
//   ✅ **只关入口**：存量 00:00–05:59 的历史课不删、不改、不迁移 —— 课表凌晨段（LATE_HOURS）
//      照旧按"有课才渲染"展示它们（见 `tests/week-grid-bottom.test.js`）。
//   ⛔ 30 分钟网格仍然**只**在会员自助通道判：教练的精确时间选择器允许非整点
//      （那是"补录真实上过的课"的必要能力，与"最早 06:00"是两件事）。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const geom = require('./helpers/week-grid-geometry')
const { createWorld, runner } = require('./helpers/m2-business-world')
const { todayKey, addDays } = require('../utils/beijing-date')
const cloudOccupancy = require('../cloudfunctions/coachBusinessCommand/occupancy')
const localOccupancy = require('../utils/package-occupancy')
const view = require('../utils/member-booking-view')
const request = require('../utils/member-booking-request')
const manage = require('../utils/member-booking-manage')
const scheduleView = require('../utils/schedule-view')
const { InMemoryCommandEngine } = require('../utils/cloud-command-engine')

const world = createWorld()
const ROOT = path.join(__dirname, '..')
const EARLIEST = 6 * 60
const STEP = 30
const LATEST = 23 * 60

async function seed(options = {}) {
  require('../utils/data-runtime').setEnvironment('sandbox')
  world.installRuntime()
  const A = world.seedCoach('openid-a', 'ds-a', 'PUBCODEA')
  const B = world.seedCoach('openid-b', 'ds-b', 'PUBCODEB')
  world.seedStudent(A, 'stu-1', '开课窗口学员')
  const sold = await world.execute(A, 'createCourseSale', {
    studentId: 'stu-1', type: '常规训练', total: 6, remaining: 6,
    quantity: 6, unitPrice: 100, amount: 600, date: todayKey(),
    ...(options.withB ? { teachingPublicCodes: [B.publicCode] } : {})
  })
  assert.equal(sold.ok, true, JSON.stringify(sold))
  return { A, B, packageId: sold.result.packageId }
}

;(async () => {
  await runner('① 公式只有一份：云端 occupancy 与本机 package-occupancy 逐样本一致（含常量与文案）', async () => {
    assert.equal(cloudOccupancy.EARLIEST_START_MINUTES, EARLIEST, '云端最早开课必须是 06:00')
    assert.equal(localOccupancy.EARLIEST_START_MINUTES, EARLIEST, '本机最早开课必须是 06:00')
    assert.equal(cloudOccupancy.SLOT_STEP_MINUTES, STEP, '云端步长必须是 30 分钟')
    assert.equal(localOccupancy.SLOT_STEP_MINUTES, STEP, '本机步长必须是 30 分钟')
    assert.equal(cloudOccupancy.LATEST_START_MINUTES, LATEST, '云端最晚开课必须是 23:00')
    assert.equal(localOccupancy.LATEST_START_MINUTES, LATEST, '本机最晚开课必须是 23:00')
    for (const key of ['START_WINDOW_MESSAGE', 'START_TOO_EARLY_MESSAGE', 'START_TOO_LATE_MESSAGE', 'START_OFF_GRID_MESSAGE']) {
      assert.equal(cloudOccupancy[key], localOccupancy[key], `文案 ${key} 两端必须逐字相同`)
      assert.ok(String(localOccupancy[key]).length > 0, `文案 ${key} 不许为空`)
    }
    assert.ok(localOccupancy.START_TOO_LATE_MESSAGE.includes('23:00'), '最晚开课的提示必须说出 23:00')
    assert.ok(localOccupancy.START_TOO_EARLY_MESSAGE.includes('06:00'), '最早开课的提示必须说出 06:00')
    // ⛔ 旧口径的**函数**必须已经不存在 —— 留着就是"看起来还是闸门"的陷阱。
    assert.equal(cloudOccupancy.endsAfterLatest, undefined, '旧判据 endsAfterLatest 必须已删除（不删就会有人继续调它）')
    assert.equal(localOccupancy.endsAfterLatest, undefined, '本机同样不许残留 endsAfterLatest')
    // 两端公式逐样本一致
    const samples = [
      [{ hour: 5, minute: 30 }, 'too-early'],
      [{ hour: 6, minute: 0 }, 'ok'],
      [{ hour: 6, minute: 30 }, 'ok'],
      [{ hour: 7, minute: 0 }, 'ok'],
      [{ hour: 7, minute: 30 }, 'ok'],
      [{ hour: 8, minute: 0 }, 'ok'],
      [{ hour: 8, minute: 15 }, 'off-grid'],
      [{ hour: 12, minute: 30 }, 'ok'],
      [{ hour: 23, minute: 0 }, 'ok'],
      [{ hour: 23, minute: 30 }, 'too-late'],
      [{ hour: 23, minute: 45 }, 'too-late'],
      [{ hour: 24, minute: 0 }, 'too-late'],
      [{ hour: 0, minute: 0 }, 'too-early'],
      [{ hour: 0, minute: 30 }, 'too-early']
    ]
    for (const [moment, expected] of samples) {
      assert.equal(cloudOccupancy.startVerdictOf(moment), expected, `云端 ${JSON.stringify(moment)}`)
      assert.equal(localOccupancy.startVerdictOf(moment), expected, `本机 ${JSON.stringify(moment)}`)
    }
    assert.equal(localOccupancy.latestStartMinutes(), LATEST, 'UI 上界 = 最晚开课 23:00（不再按结束时间倒推）')
  })

  await runner('② 云端 createBooking（教练新建）：⭐ 与会员端同一把尺 —— 最早 06:00、最晚 23:00；仍不判 30 分钟网格', async () => {
    // ⭐ 2026-10-03：教练新建的最早也收到 **06:00**（用户口径）。
    //    ⛔ 上一版这里断言 00:15 / 06:30 都能排，理由是"补录通道不判最早"；该口子已关闭
    //      ⇒ 这两个时刻现在**必须被拒**，而且码是「开课太早」。
    //    ⛔ 但**网格仍不判**：08:15 这种非整点必须还能排 —— 教练的精确时间是"把真实上过的课录进来"
    //      的必要能力，与"最早 06:00"是两件事，不许一起收掉。
    const cases = [
      [0, 15, false, 'BOOKING_START_TOO_EARLY'],
      [5, 30, false, 'BOOKING_START_TOO_EARLY'],
      [6, 0, true, ''],
      [6, 30, true, ''],
      [7, 0, true, ''],
      [8, 15, true, ''],
      [23, 0, true, ''],
      [23, 30, false, 'BOOKING_START_TOO_LATE'],
      [23, 45, false, 'BOOKING_START_TOO_LATE'],
      [24, 0, false, 'BOOKING_START_TOO_LATE']
    ]
    for (const [hour, minute, expectedOk, expectedCode] of cases) {
      world.reset()
      const { A, packageId } = await seed()
      const result = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour, minute }, `bsw_c_${hour}_${minute}`)
      assert.equal(result.ok, expectedOk, `云端对 ${hour}:${String(minute).padStart(2, '0')} 的判定（实测 ${JSON.stringify(result)}）`)
      if (!expectedOk) {
        assert.equal(result.code, expectedCode,
          `${hour}:${String(minute).padStart(2, '0')} 时刻本身合法 ⇒ 必须是「开课太早 / 太晚」这个码，不是 INVALID_PAYLOAD（实测 ${JSON.stringify(result)}）`)
      }
    }
    // ⛔ 真正不存在的时刻仍然报 INVALID_PAYLOAD ⇒ 三层判据不许被合成一层。
    world.reset()
    const { A, packageId } = await seed()
    const badMoment = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 25, minute: 0 }, 'bsw_c_bad25')
    assert.equal(badMoment.code, 'INVALID_PAYLOAD', `25:00 是"时刻不存在"，不是"开课太晚"（实测 ${JSON.stringify(badMoment)}）`)
    const offHour = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 24, minute: 30 }, 'bsw_c_2430')
    assert.equal(offHour.code, 'INVALID_PAYLOAD', `24:30 越过了当天最后一格（实测 ${JSON.stringify(offHour)}）`)
  })

  await runner('③ ⭐ 23:00 开课 + 60 分钟 ⇒ **24:00 结束合法**；23:30 已取消 ⇒ 必须被拒', async () => {
    world.reset()
    const { A, packageId } = await seed()
    const late = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 23, minute: 0 }, 'bsw_c_2300')
    assert.equal(late.ok, true, `23:00 是当天最后一个开课时间（23:00+60 ⇒ 24:00，正好卡在界上），必须能排（实测 ${JSON.stringify(late)}）`)
    const row = world.dataRows('bookings', A.owner, A.datasetId).find(item => item.hour === 23)
    assert.ok(row, '这一节必须真的落库')
    assert.equal(row.minute, 0)
    assert.equal(localOccupancy.plannedEndMinutes({ hour: 23, minute: 0 }, 60), 24 * 60, '结束分钟 = 1440（当天 24:00）')
    // ⛔ 23:30 这一档已取消（1.3.5 真机后二次口径）
    const gone = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 23, minute: 30 }, 'bsw_c_2330')
    assert.equal(gone.ok, false, '23:30 开课必须被拒（跨午夜不再作为 MVP 能力）')
    assert.equal(gone.code, 'BOOKING_START_TOO_LATE', `23:30 是"开课太晚"，不是时刻不存在（实测 ${JSON.stringify(gone)}）`)
  })

  await runner('④ 跨教练路径（createBookingOnForeignPackage 内核）同一把尺：B 排 23:00 成功、23:30 / 23:45 被拒', async () => {
    world.reset()
    const { A, B, packageId } = await seed({ withB: true })
    const tooLate = await world.execute(B, 'createAuthorizedBooking',
      { studentId: 'stu-1', packageId, date: todayKey(), hour: 23, minute: 45 }, 'bsw_auth_late')
    assert.equal(tooLate.ok, false, '跨教练排课也不能晚于 23:00 开课')
    assert.equal(tooLate.code, 'BOOKING_START_TOO_LATE', `必须与普通课包同一个码（实测 ${JSON.stringify(tooLate)}）`)
    const rows = world.dataRows('bookings', B.owner, B.datasetId)
    assert.equal(rows.length, 0, '被拒 ⇒ 授课教练这边一条预约都不许留下')
    // ⛔ 23:30 已取消 ⇒ 跨教练路径同样不许（口径只有一把）
    const halfPast = await world.execute(B, 'createAuthorizedBooking',
      { studentId: 'stu-1', packageId, date: todayKey(), hour: 23, minute: 30 }, 'bsw_auth_2330')
    assert.equal(halfPast.ok, false, '23:30 开课 ⇒ 跨教练也要被拒')
    assert.equal(halfPast.code, 'BOOKING_START_TOO_LATE', `实测 ${JSON.stringify(halfPast)}`)
    const fine = await world.execute(B, 'createAuthorizedBooking',
      { studentId: 'stu-1', packageId, date: todayKey(), hour: 23, minute: 0 }, 'bsw_auth_ok_2300')
    assert.equal(fine.ok, true, `23:00 开课 ⇒ 跨教练也要能排（实测 ${JSON.stringify(fine)}）`)
    const pkg = world.dataRows('packages', A.owner, A.datasetId)[0]
    assert.equal(pkg.reserved, 1, '只占了一节（被拒那次不许留下占座）')
  })

  await runner('⑤ 改期不能绕过：改到 23:00 ✅；改到 23:30 / 23:45 ⛔ 且**原时间不许被改掉**', async () => {
    world.reset()
    const { A, packageId } = await seed()
    const booked = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 10, minute: 0 }, 'bsw_rs_first')
    assert.equal(booked.ok, true, JSON.stringify(booked))
    const id = booked.result.bookingId
    const moved = await world.execute(A, 'rescheduleBooking', { bookingId: id, date: todayKey(), hour: 23, minute: 45 }, 'bsw_rs_to_2345')
    assert.equal(moved.ok, false, '改期到 23:45 必须被拒（否则先约早的再改晚的就绕过去了）')
    assert.equal(moved.code, 'BOOKING_START_TOO_LATE', `实测 ${JSON.stringify(moved)}`)
    const stillThere = world.dataRows('bookings', A.owner, A.datasetId).find(row => row.id === id)
    assert.equal(stillThere.hour, 10, '被拒的改期不许把原时间改掉')
    // ⛔ 23:30 这一档已取消 ⇒ 改期也不能绕过去（先约早的再改晚的必须同样被拒）
    const halfPast = await world.execute(A, 'rescheduleBooking', { bookingId: id, date: todayKey(), hour: 23, minute: 30 }, 'bsw_rs_to_2330')
    assert.equal(halfPast.ok, false, '改到 23:30 必须被拒（否则先约早的再改晚的就绕过去了）')
    assert.equal(halfPast.code, 'BOOKING_START_TOO_LATE', `实测 ${JSON.stringify(halfPast)}`)
    assert.equal(world.dataRows('bookings', A.owner, A.datasetId).find(row => row.id === id).hour, 10, '被拒的改期同样不许把原时间改掉')
    const fine = await world.execute(A, 'rescheduleBooking', { bookingId: id, date: todayKey(), hour: 23, minute: 0 }, 'bsw_rs_to_2300')
    assert.equal(fine.ok, true, `改到 23:00 必须可以（实测 ${JSON.stringify(fine)}）`)
  })

  await runner('⑥ ⭐ 会员预约与改期**同一套**窗口（客户端预检逐样本一致）', async () => {
    const dateKey = addDays(todayKey(), 2)
    const row = { historyId: 'h1', bookingViewId: 'h1', date: addDays(todayKey(), 1), hour: 10, minute: 0, status: 'booked' }
    const samples = [
      [5 * 60 + 30, false, 'BOOKING_START_TOO_EARLY', '05:30 太早'],
      [6 * 60, true, '', '⭐ 06:00 第一档'],
      [6 * 60 + 30, true, '', '06:30 半点'],
      [7 * 60, true, '', '07:00'],
      [7 * 60 + 30, true, '', '07:30 半点'],
      [8 * 60, true, '', '08:00 整点'],
      [12 * 60 + 30, true, '', '普通半点'],
      [23 * 60, true, '', '23:00'],
      [23 * 60 + 30, false, 'BOOKING_START_TOO_LATE', '⛔ 23:30 这一档已取消'],
      [23 * 60 + 45, false, 'BOOKING_START_TOO_LATE', '23:45 太晚'],
      [0, false, 'BOOKING_START_TOO_EARLY', '⛔ 00:00 不能作为新一天普通预约起始'],
      [8 * 60 + 15, false, 'BOOKING_START_OFF_GRID', '08:15 不在 30 分钟网格上']
    ]
    // ⛔ 两条通道的**拒绝形状**不同（预约给 `errors[]`、改期给 `code`），但**判据与文案必须是同一套**
    //    ⇒ 用 occupancy 那一份文案做比对基准，两边都得说出同一句话。
    const messageOf = code => ({
      BOOKING_START_TOO_EARLY: localOccupancy.START_TOO_EARLY_MESSAGE,
      BOOKING_START_TOO_LATE: localOccupancy.START_TOO_LATE_MESSAGE,
      BOOKING_START_OFF_GRID: localOccupancy.START_OFF_GRID_MESSAGE
    }[code])
    for (const [start, expectedOk, expectedCode, label] of samples) {
      const slot = { start, end: start + 60, available: true }
      // 预约通道
      const bookReq = request.buildBookingRequest({ dateKey, slot, coachKey: 'coach-a', packageViewId: 'pv-1', todayKey: todayKey() })
      assert.equal(bookReq.ok, expectedOk, `预约 ${label}（实测 ${JSON.stringify(bookReq)}）`)
      if (!expectedOk) {
        assert.ok(String((bookReq.errors || []).join('|')).includes(messageOf(expectedCode)),
          `预约 ${label} 必须给出与 occupancy 同一句话（实测 ${JSON.stringify(bookReq.errors)}）`)
      }
      // 改期通道（⛔ 必须与预约同一个结论、同一个码）
      const moveReq = manage.buildRescheduleRequest({
        bookingViewId: 'h1', ownViewIds: ['h1'], row, dateKey, slot, todayKey: todayKey()
      })
      assert.equal(moveReq.ok, expectedOk, `改期 ${label}（实测 ${JSON.stringify(moveReq)}）`)
      if (!expectedOk) assert.equal(moveReq.code, expectedCode, `改期 ${label} 的码（实测 ${JSON.stringify(moveReq)}）`)
    }
  })

  await runner('⑦ 两条通道的闸门分工：会员端走 startVerdictOf（多判网格），教练端走 lessonWindowGateOf（判最早，不判网格）', async () => {
    // ⭐ 2026-10-03：两边**都判最早 06:00** 了（同一条常量 EARLIEST_START_MINUTES）。
    //    差别只剩"30 分钟网格"这一条：会员自助只能选整/半点，教练的精确时间允许非整点
    //    （那是"把真实上过的课录进来"的必要能力，与最早开课是两件事）。
    const memberSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'coachBusinessCommand', 'memberBooking.js'), 'utf8')
    assert.ok(/startVerdictOf\(moment\)/.test(memberSrc), '会员通道必须调 occupancy.startVerdictOf')
    assert.ok(/BOOKING_START_TOO_EARLY/.test(memberSrc) && /BOOKING_START_OFF_GRID/.test(memberSrc),
      '会员通道必须同时有"太早"与"不在网格上"两个码')
    assert.equal((memberSrc.match(/startVerdictOf\(moment\)/g) || []).length, 2,
      `预约与改期**两条**会员命令都必须过窗口（实测 ${(memberSrc.match(/startVerdictOf\(moment\)/g) || []).length} 处）`)
    const handlersSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'coachBusinessCommand', 'handlers.js'), 'utf8')
    assert.ok(!/startVerdictOf|offStartGrid/.test(handlersSrc),
      '⛔ 教练通道**不许**判 30 分钟网格 —— 精确时间要能选非整点（早/晚由下面的闸门判）')
    assert.ok(/lessonWindowGateOf\(moment/.test(handlersSrc), '教练通道必须走唯一的窗口闸门（开始 06:00–23:00 且 结束 ≤ 24:00）')
    // ⭐ 2026-10-03 新增判据：最早 06:00 现在**也由教练通道的闸门判**。
    //    ⛔ 上一版这里是"handlers 里不许出现 startsBeforeEarliest"；口径变了，判据必须跟着翻过来，
    //      否则会留下一条"保护旧行为"的护栏，下次谁想改都会被它挡住。
    const occupancySrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'coachBusinessCommand', 'occupancy.js'), 'utf8')
    const gateBody = occupancySrc.match(/function lessonWindowGateOf\([\s\S]*?\n\}/)
    assert.ok(gateBody, '云端必须能找到 lessonWindowGateOf 的实现')
    assert.ok(/startsBeforeEarliest\(moment\)/.test(gateBody[0]),
      '⭐ 教练通道的闸门必须判「开始过早」—— 否则教练仍能建出 06:00 之前的课，与会员端口径不一致')
    assert.ok(/startsAfterLatest\(moment\)/.test(gateBody[0]) && /endsAfterDayEnd\(/.test(gateBody[0]),
      '⛔ 最晚 23:00 与"不跨 24:00"两条不许因为加了最早判定而被挤掉')
  })

  await runner('⑧ ⭐ 存量跨午夜旧课**仍然占用**次日 00:00–00:30（入口关了，占用没消失）', async () => {
    // ⛔ 日期字段不同 ≠ 不冲突。旧算法按 `date` 短路 ⇒ 这位会员会同时上两节课。
    // ⭐ 2026-10-03 口径再收紧：**入口**已经造不出凌晨课了（00:00 会被"开课太早"拒），
    //    但**存量**不会消失 —— Sandbox 里真实存在着 10-02 23:30 → 10-03 00:30 这样的课。
    //    ⇒ 本段改成从**占用**这一侧钉死它（绝对时间轴），比"尝试新建被拒"更贴近语义；
    //      同时把入口侧的新行为（被最早闸门拦住）也钉住。判据一条都没放松。
    world.reset()
    const { A, B, packageId } = await seed({ withB: true })
    const day1 = addDays(todayKey(), 1), day2 = addDays(todayKey(), 2)
    // ⚠️ 注入的行必须**带顶层冗余字段**（`studentId` / `packageId`）—— 服务端的
    //    `business.collection('bookings').list({ studentId })` 查的是**顶层**字段，不是 `data` 里的那份
    //    ⇒ 只塞 `data` 会让这条课对会员冲突查询"隐形"（这正是注入式测试最危险的坑）。
    world.put('bookings', world.businessId('bookings', A.owner, A.datasetId, 'legacy-2330'), {
      ownerCoachId: A.owner, datasetId: A.datasetId, bookingId: 'legacy-2330',
      studentId: 'stu-1', packageId,
      data: {
        id: 'legacy-2330', studentId: 'stu-1', studentName: '跨午夜学员', packageId,
        date: day1, hour: 23, minute: 30, plannedMinutes: 60, status: 'booked', typeName: '常规训练', price: 100
      }
    })
    const rows = world.dataRows('bookings', A.owner, A.datasetId)
    assert.ok(rows.some(row => row.id === 'legacy-2330'), '存量旧课已注入')
    // ① 绝对时间轴：次日 00:00–00:30 仍然被它占着（课表与"分享可约"都读这一份）
    assert.deepStrictEqual(scheduleView.busyRangesOf(rows, day2), [{ start: 0, end: 30 }],
      `次日 00:00–00:30 必须仍被存量旧课占用（实测 ${JSON.stringify(scheduleView.busyRangesOf(rows, day2))}）`)
    // ② 算法层：次日 00:00 起 ⇒ 真重叠；00:30 起 ⇒ 首尾相接不重叠
    const legacy = localOccupancy.intervalOf({ date: day1, hour: 23, minute: 30, plannedMinutes: 60 })
    assert.strictEqual(localOccupancy.intervalsOverlap(legacy,
      localOccupancy.intervalOf({ date: day2, hour: 0, minute: 0, plannedMinutes: 60 })), true,
      '00:00–00:30 与旧课真重叠 ⇒ 冲突判定不许漏（这是"会员不会分身乏术"的底座）')
    assert.strictEqual(localOccupancy.intervalsOverlap(legacy,
      localOccupancy.intervalOf({ date: day2, hour: 0, minute: 30, plannedMinutes: 60 })), false,
      '00:30 起首尾相接 ⇒ 不算冲突')
    // ③ 入口侧的新行为：凌晨课已经不能从任何入口新建 —— 而且是**先被"开课太早"拦**，不是没人管
    const dawn = await world.execute(B, 'createAuthorizedBooking',
      { studentId: 'stu-1', packageId, date: day2, hour: 0, minute: 0 }, 'bsw_mc_overlap')
    assert.equal(dawn.ok, false, '凌晨课不再能从入口新建')
    assert.equal(dawn.code, 'BOOKING_START_TOO_EARLY', `必须是"开课太早"这个码（实测 ${JSON.stringify(dawn)}）`)
    // ④ 与旧课不重叠的合法时段照常；且新建之后那段占用**还是只有存量旧课**（没被改写）
    const morning = await world.execute(B, 'createAuthorizedBooking',
      { studentId: 'stu-1', packageId, date: day2, hour: 6, minute: 0 }, 'bsw_mc_morning')
    assert.equal(morning.ok, true, `06:00 与存量旧课不重叠 ⇒ 必须能排（实测 ${JSON.stringify(morning)}）`)
    assert.deepStrictEqual(scheduleView.busyRangesOf(world.dataRows('bookings', A.owner, A.datasetId), day2), [{ start: 0, end: 30 }],
      '⛔ 新增 06:00 之后，次日那段占用必须依旧只有存量旧课那半小时')
  })

  await runner('⑨ 会员端可选时段：06:00 起、23:00 收尾、步长 30 ⇒ 35 格，最后一格 24:00 结束（不跨午夜）', async () => {
    const slots = view.slotsFor({ dateKey: addDays(todayKey(), 1), busy: [] })
    assert.equal(slots[0].start, EARLIEST, '第一格必须是 06:00')
    assert.equal(slots[slots.length - 1].start, LATEST, '最后一格必须是 23:00')
    assert.equal(slots.length, (LATEST - EARLIEST) / STEP + 1, `06:00–23:00 每 30 分钟一格 ⇒ 35 格（实测 ${slots.length}）`)
    assert.ok(slots.every(slot => slot.start % STEP === 0), '每一格都必须落在 30 分钟网格上')
    assert.ok(!slots.some(slot => slot.start === 5 * 60 + 30), '⛔ 05:30 不许出现（最早 06:00）')
    assert.ok(!slots.some(slot => slot.start > LATEST), '⛔ 23:00 之后（含 23:30）不许再出现起点')
    const last = slots[slots.length - 1]
    assert.equal(last.end, 24 * 60, '23:00 那格的结束是 24:00（1440 分钟，正好卡在当天界上）')
    assert.equal(last.label, '23:00–24:00', `结束必须显示成 24:00（实测 ${last.label}）`)
    assert.equal(last.crossesMidnight, false, '⛔ 新生成的格子不再跨午夜（23:30 那一档已取消）')
    // ⛔ 旧口径里那个 `late` 理由已经不存在了（超过 23:00 的格子压根不生成）
    assert.ok(!slots.some(slot => slot.reason === 'late'), '不再存在 late 理由（旧口径残留）')
  })

  await runner('⑩ UI 下界 / 上界全部取自同一公式（不写死数字）；分享可约起点同步到 06:00', async () => {
    const schedule = fs.readFileSync(path.join(ROOT, 'pages', 'schedule', 'schedule.js'), 'utf8')
    assert.ok(/dayStart=occupancy\.EARLIEST_START_MINUTES/.test(schedule), '分享可约起点必须取自 occupancy（现在是 06:00）')
    assert.ok(/dayEnd=occupancy\.LATEST_START_MINUTES\+occupancy\.DEFAULT_PLANNED_MINUTES/.test(schedule),
      '分享可约终点必须 = 最晚开课 + 一节课（23:00 + 60 ⇒ 24:00），两端不写死数字')
    // ⭐ 2026-10-06：跨教练排课的出口从旧「多教练服务（授权）工作台」搬到 **学员列表**（`pages/students`）
    //    ⇒ 时间选择器的上下界同样必须取自 occupancy 同一把尺（⛔ 不许写死数字，也不许"能选却被闸门拒"）。
    const auth = fs.readFileSync(path.join(ROOT, 'pages', 'students', 'students.js'), 'utf8')
    assert.ok(/LATEST_START_MINUTES/.test(auth) && /EARLIEST_START_MINUTES/.test(auth), '跨教练排课的时间范围必须取自 occupancy（不写死数字）')
    assert.ok(/timeEnd:/.test(auth) && /timeStart:/.test(auth), '排课表单必须把上下界下发给时间选择器')
    const authWxml = fs.readFileSync(path.join(ROOT, 'pages', 'students', 'students.wxml'), 'utf8')
    assert.ok(/start="\{\{booking\.timeStart\}\}"\s+end="\{\{booking\.timeEnd\}\}"/.test(authWxml), '时间选择器必须真的用上这两个界')
    // ⭐ 2026-10-03 四次口径：跨教练排课的**下界**也必须取自 occupancy ——
    //    ⛔ 原来从 0 点列起 ⇒ 00:00–05:59 六个小时"能选却被闸门拒"，且与"教练最早 06:00"矛盾。
    assert.ok(/hhmm\(occupancy\.EARLIEST_START_MINUTES\)/.test(auth),
      '⭐ 跨教练排课小时**下界**必须取自 occupancy.EARLIEST_START_MINUTES（现在是 06:00），不许从 0 点列起')
    // ⭐ 2026-10-06 再改：新出口**不再自己列小时数组** —— 用 `<picker mode="time">` 的 start/end
    //    把"哪些档能选"交给系统（客户端只负责把上下界喂进去）⇒ 判据也要跟着换形状：
    //    ① 不许再造一份小时数组（再造一份就会与 start/end 漂移）；
    //    ② **默认时间必须落在上下界之内** —— 写死一个界外默认值，就是"一打开就被闸门拒"。
    assert.ok(!/HOURS\s*=\s*Array\.from/.test(auth), '⛔ 新出口不许再造一份小时数组（上下界交给选择器的 start/end，两处会漂移）')
    const defaultTime = /time:'(\d{2}):(\d{2})'/.exec(auth)
    assert.ok(defaultTime, '要能读出排课表单的默认时间')
    const defaultMinutes = Number(defaultTime[1]) * 60 + Number(defaultTime[2])
    assert.ok(
      defaultMinutes >= localOccupancy.EARLIEST_START_MINUTES && defaultMinutes <= localOccupancy.LATEST_START_MINUTES,
      `⛔ 默认时间 ${defaultTime[0]} 必须落在 ${localOccupancy.EARLIEST_START_MINUTES}–${localOccupancy.LATEST_START_MINUTES} 分钟内（否则一打开就被闸门拒）`
    )
    // ⭐ 改期弹层的精确时间选择器：**下界同样是 06:00**（改期也是入口，与新建同一把尺）
    const sessionWxml = fs.readFileSync(path.join(ROOT, 'pages', 'session', 'session.wxml'), 'utf8')
    assert.ok(/start="06:00"/.test(sessionWxml),
      '⭐ 改期时间选择器下界必须也是 06:00（闸门放行 06:00 而选择器从 07:00 起 ⇒ 用户选不到合法时间）')
    assert.ok(!/start="07:00"/.test(sessionWxml), '⛔ 改期选择器下界不许还是 07:00')
    assert.ok(/end="23:00"/.test(sessionWxml),
      `改期选择器上界必须等于最晚开课 23:00（实测 ${(sessionWxml.match(/end="\d\d:\d\d"/g) || []).join(',')}）`)
    const modal = fs.readFileSync(path.join(ROOT, 'components', 'booking-modal', 'booking-modal.js'), 'utf8')
    assert.ok(/latestHour = Math\.floor\(occupancy\.latestStartMinutes\(\) \/ 60\)/.test(modal), '排课弹窗小时列上界必须取自同一公式')
    // 排课弹窗的时间选择器：**下界 06:00、上界 23:00**，两者都必须与闸门同口径。
    const wxml = fs.readFileSync(path.join(ROOT, 'components', 'booking-modal', 'booking-modal.wxml'), 'utf8')
    assert.ok(/start="06:00"/.test(wxml), '⭐ 精确时间的下界必须收在 06:00（与三态卡片、与云端闸门同一条规则）')
    assert.ok(!/start="00:00"/.test(wxml), '⛔ 下界不许还是 00:00 —— 那会出现"能选却被云端拒"，且教练端比会员端更宽')
    assert.ok(/end="23:00"/.test(wxml), `时间选择器上界必须等于最晚开课 23:00（实测 ${(wxml.match(/end="\d\d:\d\d"/g) || []).join(',')}）`)
    // ⛔ 课表**显示**用的格子必须覆盖到最晚开课那一档：任何一节课的 `hour` 都必须有格子装它
    //    ⇒ 历史课不会凭空消失。判据是"**主网格 + 凌晨段合起来**覆盖 00:00–23:00 共 24 档"，
    //    **不是**写死某个数字：
    //    2026-10-02 删掉了第 25 格（24:00）—— 最晚开课 23:00 ⇒ 不存在 hour=24 的课，
    //    那一格是随「跨午夜次日片段」一起作废的**空行**，留着只会白占课表高度
    //    （真机后果：23:00 行被裁、23:30 旧课卡片看不见，见 tests/week-grid-bottom.test.js）。
    //    ⭐ 四次口径又把"主网格"收成 06:00 起的 18 行，凌晨 00:00–05:59 那 6 行改成
    //    "真有课才渲染"（LATE_HOURS）⇒ 覆盖判据必须**两段合起来看**，否则有人把 LATE_HOURS
    //    删掉、凌晨补录进来的课就永远没有格子装它了。
    const hours = geom.hoursOf(schedule)
    const latestHour = Math.floor(require('../utils/package-occupancy').latestStartMinutes() / 60)
    const mainLast = hours.mainStart + hours.mainCount - 1
    assert.strictEqual(mainLast, latestHour,
      `主网格最后一行必须就是最晚开课 ${latestHour}:00 ⇒ 历史课不会凭空消失（实测 ${mainLast}:00）`)
    assert.strictEqual(hours.lateStart, 0, `凌晨段必须从 00:00 起（**存量历史课**的展示位，不是新建入口），实测 ${hours.lateStart}`)
    assert.strictEqual(hours.lateStart + hours.lateCount, hours.mainStart,
      `凌晨段必须紧挨主网格：${hours.lateStart}..${hours.lateStart + hours.lateCount - 1} 之后正好是 ${hours.mainStart}:00`)
    assert.strictEqual(mainLast - hours.lateStart + 1, 24, `两段合起来必须正好 24 档（00:00–23:00），实测 ${mainLast - hours.lateStart + 1}`)
    // 占用判定与格子数无关（绝对时间轴）⇒ 删掉 24:00 那一行不会让任何课"不再占用"
    assert.ok(!/length: 25/.test(schedule), '24:00 空行回来了（它没有任何课可以装）')
    assert.ok(!/length: 19/.test(schedule), '主网格被扩成 19 行 ⇒ 多出来的就是 24:00 那行空行')
  })

  await runner('⑪ 提示文案只有一份：所有 UI 引用同一个常量，不许另写一句', async () => {
    const files = [
      'components/booking-modal/booking-modal.js',
      'pages/schedule/schedule.js',
      'pages/session/session.js',
      'pages/students/students.js',
      'pages/students/students.js',
      'pages/sandbox-shared-test/sandbox-shared-test.js'
    ]
    for (const relative of files) {
      const text = fs.readFileSync(path.join(ROOT, relative), 'utf8')
      // ⭐ 2026-10-02 三次口径：UI 现在有**两种**合规写法 ——
      //    ① 直接引用 occupancy 的文案常量（`START_TOO_LATE_MESSAGE` 那一族）；
      //    ② ⭐ 更彻底的写法：问 `occupancy.lessonWindowGateOf` 要 `gate.message`
      //       —— 连"该说开始太晚还是跨午夜"都不用 UI 自己挑，口径天生不会分裂。
      //   ⛔ 两种都必须经 occupancy ⇒ 不许出现第三种"UI 自己手写一句提示"。
      assert.ok(text.includes('occupancy.lessonWindowGateOf') || text.includes('occupancy.START_TOO_LATE_MESSAGE') || text.includes('occupancy.startsAfterLatest'),
        `${relative} 必须复用 occupancy 的唯一闸门/文案（不许自己再写一句提示）`)
      // ⛔ 上面那条的真正防线在这里：**手写的提示句**（不是变量引用）一律不许出现。
      //    ⛔ 防线：凡是**手写**的提示句（不是 occupancy 变量引用）一律不许出现。
      const handWritten = (text.match(/content:\s*'[^']{6,}'/g) || []).filter(literal => /开课|24:00|最晚|宵|跨午夜/.test(literal))
      assert.deepStrictEqual(handWritten, [], `${relative} ⛔ 不许手写时间提示文案（实测 ${handWritten.join(' | ')}）`)
      // ⛔ 旧口径的**函数**不许残留（`endsAfterLatest` 是 2026-09-29 那版的实现，已删除）。
      //    📌 注意：`BOOKING_END_TOO_LATE` 现在是**三条口径之一的错误码**，不是旧口径残留 ⇒ 允许。
      assert.ok(!/LATEST_END_MESSAGE|LATEST_END_MINUTES|endsAfterLatest/.test(text),
        `${relative} 不许再引用旧的"最晚 24:00 结束"常量/函数`)
    }
  })

  await runner('⑫ 端到端：06:00 起能排，23:00 能排（24:00 结束），05:30 / 23:30 / 23:45 排不进', async () => {
    world.reset()
    const { A, packageId } = await seed()
    const early = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 6, minute: 30 }, 'bsw_e2e_early')
    assert.equal(early.ok, true, `06:30 必须能排（边界之上，实测 ${JSON.stringify(early)}）`)
    // ⭐ 2026-10-03 新增：教练端也受最早 06:00 约束 ⇒ 05:30 必须被拒
    const tooEarly = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 5, minute: 30 }, 'bsw_e2e_0530')
    assert.equal(tooEarly.ok, false, '⛔ 05:30 太早 ⇒ 教练新建也必须被拒（与会员端同一条规则）')
    assert.equal(tooEarly.code, 'BOOKING_START_TOO_EARLY', `实测 ${JSON.stringify(tooEarly)}`)
    const edge = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 23, minute: 0 }, 'bsw_e2e_edge')
    assert.equal(edge.ok, true, '⭐ 23:00 开课、24:00 结束 ⇒ 必须能排（取消 23:30 之后合法的最后一节）')
    const halfPast = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 23, minute: 30 }, 'bsw_e2e_2330')
    assert.equal(halfPast.ok, false, '⭐ 23:30 开课 ⇒ 必须被拒（这一档已取消）')
    const late = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 23, minute: 45 }, 'bsw_e2e_late')
    assert.equal(late.ok, false, '⭐ 23:45 开课 ⇒ 必须被拒')
    const rows = world.dataRows('bookings', A.owner, A.datasetId)
    assert.equal(rows.length, 2, '只有清晨与 23:00 那两条真的落库')
    await world.execute(A, 'updateBookingContent', { bookingId: early.result.bookingId, items: [{ name: '卧推', sets: 4, reps: 12, weight: '40' }] })
    const done = await world.execute(A, 'completeBooking', { bookingId: early.result.bookingId })
    assert.equal(done.ok, true, JSON.stringify(done))
    const incomes = world.dataRows('incomes', A.owner, A.datasetId)
    assert.equal(incomes.length, 1)
    assert.equal(incomes[0].date, todayKey(), '收入日期仍是上课那天 ⇒ 月度归属正确')
  })

  await runner('⑬ 本机引擎与云端逐 case 同口径（含改期）：任何一条松一格都会"本机先收下、出网才被拒"', async () => {
    const cases = [[5, 30, false], [6, 0, true], [6, 30, true], [7, 0, true], [23, 0, true], [23, 30, false], [23, 45, false], [24, 0, false], [25, 0, false]]
    for (const [hour, minute, expectedOk] of cases) {
      world.reset()
      const { A, packageId } = await seed()
      const cloud = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour, minute }, `bsw_p_${hour}_${minute}`)
      assert.equal(cloud.ok, expectedOk, `云端 ${hour}:${minute}（实测 ${JSON.stringify(cloud)}）`)
      const engine = new InMemoryCommandEngine({ now: () => Date.now(), idFactory: kind => `${kind}_bsw_${Math.random().toString(36).slice(2, 8)}` })
      engine.seed('coach_a', {
        dataRevision: 0,
        students: [{ id: 'stu-1', name: 'x', status: 'active', packages: [{ id: packageId, type: '常规训练', total: 6, used: 0, remaining: 6, price: 100, status: 'active' }] }],
        bookings: [], incomes: [], sales: [], settings: {}, customExercises: []
      })
      let local = null
      try {
        local = engine.execute({ ownerCoachId: 'coach_a' }, {
          command: 'createBooking', requestId: `bsw_local_${hour}_${minute}`, expectedRevision: 0,
          payload: { studentId: 'stu-1', packageId, date: todayKey(), hour, minute }
        })
      } catch (error) { local = { ok: false, code: error && error.code } }
      assert.equal(local && local.ok === true, expectedOk, `本机引擎 ${hour}:${minute}（实测 ${JSON.stringify(local)}）`)
      if (!expectedOk) assert.equal(local && local.code, cloud.code, `本机与云端对 ${hour}:${minute} 必须是同一个码（本机 ${local && local.code} / 云端 ${cloud.code}）`)
    }
  })

  await runner('⑭ ⭐ 冲突按**真实时长**判定：90 分钟的课尾部重叠不许漏判', async () => {
    // ⛔ 旧算法双方时长写死 60 ⇒ 22:00 的 90 分钟课只被当成 60 分钟（22:00–23:00），
    //    于是 23:00 那一节会被判成"没冲突"（实际 22:00–23:30 与 23:00–00:00 重叠半小时）。
    // ⛔ 场景整体前移一小时：23:30 这一档已取消，不能再拿它当"首尾相接"的那一节。
    world.reset()
    const { A, packageId } = await seed()
    const long = await world.execute(A, 'createBooking',
      { studentId: 'stu-1', packageId, date: todayKey(), hour: 21, minute: 0, plannedMinutes: 90 }, 'bsw_dur_long')
    assert.equal(long.ok, true, `90 分钟的课 21:00 开 ⇒ 22:30 结束，必须能排（实测 ${JSON.stringify(long)}）`)
    const overlap = await world.execute(A, 'createBooking',
      { studentId: 'stu-1', packageId, date: todayKey(), hour: 22, minute: 0 }, 'bsw_dur_overlap')
    assert.equal(overlap.ok, false, '22:00 与 21:00–22:30 真重叠 ⇒ 必须被拒')
    assert.equal(overlap.code, 'BOOKING_TIME_CONFLICT', `实测 ${JSON.stringify(overlap)}`)
    // 22:30 起（与 21:00–22:30 首尾相接）⇒ 不冲突
    const adjacent = await world.execute(A, 'createBooking',
      { studentId: 'stu-1', packageId, date: todayKey(), hour: 22, minute: 30 }, 'bsw_dur_adjacent')
    assert.equal(adjacent.ok, true, `22:30 起首尾相接 ⇒ 不冲突（实测 ${JSON.stringify(adjacent)}）`)
  })

  await runner('⑮ ⭐ 通道级跨日占用（**可达**版）：存量长时段旧课跨到次日早晨 ⇒ 两条通道都必须判冲突', async () => {
    // ⛔ 为什么必须有这一段（2026-10-03 修的一处真覆盖真空）：
    //    ⑧ 只在**算法层**（`intervalOf` / `intervalsOverlap`）钉住了跨日重叠；
    //    而真正会伤到用户的是**通道层**那两个调用方 ——
    //      · `handlers.overlaps`        = 教练时间（教练端新建 / 改期）
    //      · `teaching.overlapsMoment`  = 会员时间（会员预约 / 改期 / 跨教练授权预约）
    //    四次口径把入口收到 06:00 之后，"从入口新建一节凌晨课"再也造不出来
    //    ⇒ 若不补这一段，那两个调用方里的 `date` 短路**再长回来也没人发现**
    //       （反证 `_booking-start-window-mutate` ⑥⑦ 会双双退化成假绿 —— 实测就是如此）。
    //    构造方式：注入一条**真实时长很长**的存量旧课（20:00 开 660 分钟 ⇒ 次日 07:00 结束）。
    //    它跨到**次日早晨**，而次日早晨**是入口可达的** ⇒ 通道层的跨日分支被真正走到。
    //    ⚠️ 两个通道各自开一个新世界，用**隔离变量**把"到底是谁拦下来的"分开：
    //       · 会员通道：旧课属于**同一个学员**（而且归 A 的账）⇒ B 的账里查不到它；
    //       · 教练通道：旧课属于**另一位学员** ⇒ 会员时间侧不该冲突。
    //       否则两条断言都会"被另一条规则顺手拦下"而看不出是哪一边失效。

    // ---------------- ① 会员时间侧（teaching.overlapsMoment） ----------------
    world.reset()
    const { A, B, packageId } = await seed({ withB: true })
    const day1 = addDays(todayKey(), 1), day2 = addDays(todayKey(), 2)
    // ⚠️ 注入的行必须带**顶层** `studentId` / `packageId`：服务端的会员冲突查询按顶层字段索引。
    world.put('bookings', world.businessId('bookings', A.owner, A.datasetId, 'legacy-long'), {
      ownerCoachId: A.owner, datasetId: A.datasetId, bookingId: 'legacy-long',
      studentId: 'stu-1', packageId,
      data: {
        id: 'legacy-long', studentId: 'stu-1', studentName: '跨日学员', packageId,
        date: day1, hour: 20, minute: 0, plannedMinutes: 660, status: 'booked', typeName: '常规训练', price: 100
      }
    })
    const legacy = localOccupancy.intervalOf({ date: day1, hour: 20, minute: 0, plannedMinutes: 660 })
    assert.strictEqual(localOccupancy.intervalOf({ date: day2, hour: 6, minute: 0, plannedMinutes: 60 }).start < legacy.end, true,
      '（前提自检）次日 06:00 确实落在旧课区间内 —— 否则下面两条断言测的是空气')
    const memberClash = await world.execute(B, 'createAuthorizedBooking',
      { studentId: 'stu-1', packageId, date: day2, hour: 6, minute: 0 }, 'bsw_cross_member')
    assert.equal(memberClash.ok, false,
      `存量旧课跨日占着次日 06:00 ⇒ 会员通道必须拒（实测 ${JSON.stringify(memberClash)}）`)
    // ⭐ 必须恰好是**会员侧**那个码：教练侧的码是 `BOOKING_TIME_CONFLICT`。
    //    钉住码就等于钉住"是谁拦下来的" ⇒ 这条断言不会因为另一条规则顺手拦下而假绿。
    assert.equal(memberClash.code, 'MEMBER_TIME_CONFLICT', `实测 ${JSON.stringify(memberClash)}`)
    // 反证（同一世界内）：旧课 **07:00 结束** ⇒ 07:00 首尾相接，必须放行
    //   ⇒ 上面那一拒不可能是"这半小时被无脑锁死"造成的假象。
    const adjacent = await world.execute(B, 'createAuthorizedBooking',
      { studentId: 'stu-1', packageId, date: day2, hour: 7, minute: 0 }, 'bsw_cross_adjacent')
    assert.equal(adjacent.ok, true, `07:00 与「20:00 + 660 分钟」首尾相接 ⇒ 不冲突（实测 ${JSON.stringify(adjacent)}）`)

    // ---------------- ② 教练时间侧（handlers.overlaps） ----------------
    world.reset()
    const { A: A2, packageId: pkg2 } = await seed()
    const d1 = addDays(todayKey(), 1), d2 = addDays(todayKey(), 2)
    world.seedStudent(A2, 'stu-2', '另一位学员')
    world.put('bookings', world.businessId('bookings', A2.owner, A2.datasetId, 'legacy-other-student'), {
      ownerCoachId: A2.owner, datasetId: A2.datasetId, bookingId: 'legacy-other-student',
      studentId: 'stu-2', packageId: pkg2,
      data: {
        id: 'legacy-other-student', studentId: 'stu-2', studentName: '另一位学员', packageId: pkg2,
        date: d1, hour: 20, minute: 0, plannedMinutes: 660, status: 'booked', typeName: '常规训练', price: 100
      }
    })
    // 旧课属于**另一位学员** ⇒ 会员时间侧不冲突 ⇒ 这一拒只可能来自「教练时间」
    const coachClash = await world.execute(A2, 'createBooking',
      { studentId: 'stu-1', packageId: pkg2, date: d2, hour: 6, minute: 0 }, 'bsw_cross_coach')
    assert.equal(coachClash.ok, false,
      `同一位教练在次日 06:00 与跨日旧课重叠 ⇒ 教练通道必须拒（实测 ${JSON.stringify(coachClash)}）`)
    assert.equal(coachClash.code, 'BOOKING_TIME_CONFLICT', `实测 ${JSON.stringify(coachClash)}`)
    // 反证：那位学员在**不重叠**的次日早晨照常排得进 ⇒ 证明拒的是"跨日那半小时"，不是整天被锁。
    const later = await world.execute(A2, 'createBooking',
      { studentId: 'stu-1', packageId: pkg2, date: d2, hour: 7, minute: 0 }, 'bsw_cross_coach_later')
    assert.equal(later.ok, true, `次日 07:00 起首尾相接 ⇒ 必须能排（实测 ${JSON.stringify(later)}）`)
  })

  require('../utils/data-runtime').setEnvironment('production')
  if (!process.exitCode) process.stdout.write('ALL BOOKING START WINDOW TESTS PASSED\n')
})().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
