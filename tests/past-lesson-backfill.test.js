// M2 · 只读检查（2026-09-29）：**教练能不能事后补录一节已经上过的课**。
//
// ⛳ 场景：17:00 才发现当天 15:00 那节课没记 ⇒ 现在建一条 15:00 的预约，录动作/组数/次数/重量，然后完成。
//    本文件的目的是把这个问题的答案**钉成可断言的事实**（而不是写进一份会过期的文档）：
//    · 哪些地方真的没有时间校验 ⇒ 补录走得通；
//    · 哪些地方是硬约束 ⇒ 补录会撞墙（并写明文件与行号）。
//
// ⛔ 本文件**不改任何业务规则**，只做断言。真结论见文件末尾的注释与下面的每一段标题。
//
// ⚠️ 分工（别把它和 backfill-past-lesson.test.js 当成重复）：
//   · 本文件 = **客户端有没有拦**（排课弹窗日期选择 / validateBookingCreation / 冲突校验 / 本机引擎口径）；
//   · backfill-past-lesson.test.js = **云端那条链**（扣课时、跨教练补录、"剩余归零"补不进去）。
//   判别力反证：`tests/_past-lesson-backfill-mutate.js`（6 个变异，全红）。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createWorld, runner, copy } = require('./helpers/m2-business-world')
const { todayKey, addDays } = require('../utils/beijing-date')
const { validateBookingCreation } = require('../utils/local-business-rules')
// ⭐ 最晚 24:00 结束：选择器上界必须取自这一份（与云端同一把尺），不许在 wxml 里写死数字。
const localOccupancy = require('../utils/package-occupancy')

const world = createWorld()
const MODAL_WXML = path.join(__dirname, '..', 'components', 'booking-modal', 'booking-modal.wxml')
const MODAL_JS = path.join(__dirname, '..', 'components', 'booking-modal', 'booking-modal.js')

const ITEMS = [{ name: '卧推', group: '胸', sets: 4, reps: 12, weight: '40' }]

async function seed() {
  require('../utils/data-runtime').setEnvironment('sandbox')
  const A = world.seedCoach('openid-a', 'ds-a', 'PUBCODEA')
  world.seedStudent(A, 'stu-1', 'M2 补录学员')
  const sold = await world.execute(A, 'createCourseSale', {
    studentId: 'stu-1', type: '常规训练', total: 5, remaining: 5, quantity: 5, unitPrice: 100, amount: 500, date: todayKey()
  })
  assert.equal(sold.ok, true, JSON.stringify(sold))
  return { A, packageId: sold.result.packageId }
}

;(async () => {
  await runner('① 服务端**没有**"不许约过去的时间"这条校验 ⇒ 补录通道是通的', async () => {
    world.reset(); world.installRuntime()
    const { A, packageId } = await seed()
    const today = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 15, minute: 0 })
    assert.equal(today.ok, true, `当天早些时候的时段必须能建（实测 ${JSON.stringify(today)}）`)
    const yesterday = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: addDays(todayKey(), -1), hour: 15, minute: 0 })
    assert.equal(yesterday.ok, true, `昨天的课也能补（实测 ${JSON.stringify(yesterday)}）`)
  })

  await runner('② 完整补录链：建过去预约 → 录动作 → 完成 ⇒ 扣课时 + 记收入，收入日期就是那天', async () => {
    world.reset(); world.installRuntime()
    const { A, packageId } = await seed()
    const date = addDays(todayKey(), -1)
    const booked = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date, hour: 15, minute: 0 })
    const bookingId = booked.result.bookingId
    const content = await world.execute(A, 'updateBookingContent', { bookingId, items: ITEMS })
    assert.equal(content.ok, true, JSON.stringify(content))
    const done = await world.execute(A, 'completeBooking', { bookingId })
    assert.equal(done.ok, true, `补录的课必须能完成（实测 ${JSON.stringify(done)}）`)
    const pkg = world.dataRows('packages', A.owner, A.datasetId).find(item => item.id === packageId)
    assert.equal(pkg.used, 1, '课时照扣')
    assert.equal(pkg.remaining, 4, '剩余照减')
    const incomes = world.dataRows('incomes', A.owner, A.datasetId)
    assert.equal(incomes.length, 1, '补录的课也要记一笔收入')
    assert.equal(incomes[0].date, date, `收入日期必须是上课那天（实测 ${incomes[0].date}）`)
    assert.equal(incomes[0].amount, 100, '金额取这节课的单价快照')
  })

  await runner('③ 客户端排课弹窗**没有**"只能选未来"的限制（日期不带 start/end，过去时间原样带回）', async () => {
    world.reset(); world.installRuntime()
    const wxml = fs.readFileSync(MODAL_WXML, 'utf8')
    // ⚠️ 整行里同时有日期选择器和时间选择器（时间选择器有 start="07:00" end="23:59"），
    //    所以必须**只切出 mode="date" 那一个 <picker> 元素**来看，否则会把时间选择器的限制误算到日期上（假红）。
    const atDate = wxml.indexOf('mode="date"')
    assert.ok(atDate >= 0, '必须有日期选择器')
    const tagStart = wxml.lastIndexOf('<picker', atDate)
    const tagEnd = wxml.indexOf('>', atDate)
    const datePicker = wxml.slice(tagStart, tagEnd + 1)
    assert.ok(/\smode="date"/.test(datePicker), `必须切到日期选择器本体（实测 ${datePicker.slice(0, 160)}）`)
    assert.ok(!/\sstart=/.test(datePicker), `日期选择器不许有 start 限制（实测 ${datePicker.slice(0, 160)}）`)
    assert.ok(!/\send=/.test(datePicker), `日期选择器不许有 end 限制（实测 ${datePicker.slice(0, 160)}）`)
    // 时间选择器的小时必须与服务端 bookingMoment 同口径（2026-09-29 起是 00:00–23:59 全天）。
    const atTime = wxml.indexOf('mode="time"')
    const timeTag = wxml.slice(wxml.lastIndexOf('<picker', atTime), wxml.indexOf('>', atTime) + 1)
    // ⭐ 2026-10-03：下界收到 **06:00**（教练新建与会员自助同一条规则）；上界是**最晚开始时间**，不是 23:59。
    // ⛔ 两端都必须与闸门同口径：下界更宽 ⇒ 选了凌晨被云端拒；上界更宽 ⇒ 选了 23:30 被拒。
    //    两种都是"前端能选、云端拒绝"，正是要消除的形状。
    const startMatch = timeTag.match(/\sstart="(\d{2}):(\d{2})"/)
    assert.ok(startMatch, `时间选择器必须有明确的下界（实测 ${timeTag.slice(0, 160)}）`)
    assert.equal(Number(startMatch[1]) * 60 + Number(startMatch[2]), localOccupancy.EARLIEST_START_MINUTES,
      `时间选择器的下界必须等于「最早开课时间」= 06:00，不能写死（实测 ${startMatch[0]}）`)
    const endMatch = timeTag.match(/\send="(\d{2}):(\d{2})"/)
    assert.ok(endMatch, `时间选择器必须有明确的上界（实测 ${timeTag.slice(0, 160)}）`)
    // ⭐ 2026-10-01 **二次**口径：上界 = 「**最晚开课 23:00**」
    //   （23:00 是当天最后一个开课时间，课程当天结束）。仍然不许写死 ⇒ 必须取自 occupancy。
    assert.equal(Number(endMatch[1]) * 60 + Number(endMatch[2]), localOccupancy.latestStartMinutes(),
      `时间选择器的上界必须等于「最晚开课时间」= 23:00，不能写死（实测 ${endMatch[0]}）`)
    // 真的组件：给它一个**过去**的日期与时间，它必须原样采用，不许悄悄改到"现在之后"。
    // ⚠️ 组件 init() 走的是**真的** getDB() ⇒ 测试区的权威源只有 `coachSandboxActiveCache` 这一份，
    //    不先灌进去就会抛 CLOUD_CACHE_MISSING（这是真约束，不是测试的毛病）。
    require('../utils/data-runtime').setEnvironment('sandbox')
    world.storage.coachSandboxActiveCache = {
      environment: 'sandbox', datasetId: 'ds-backfill', revision: 0,
      snapshot: { students: [], packages: [], bookings: [], incomes: [], sales: [], settings: {} }
    }
    let captured = null
    global.Component = config => { captured = config }
    delete require.cache[require.resolve(MODAL_JS)]
    require(MODAL_JS)
    assert.ok(captured, '组件必须调用 Component()')
    const comp = Object.assign(Object.create(null), captured.methods, {
      data: copy(captured.data),
      properties: { visible: false, presetDate: addDays(todayKey(), -2), presetHour: 9 },
      setData(patch) { Object.assign(this.data, patch) },
      triggerEvent() {}
    })
    comp.init()
    assert.equal(comp.data.date, addDays(todayKey(), -2), `过去日期必须原样采用（实测 ${comp.data.date}）`)
    assert.equal(comp.data.hour, 9, '过去的小时也必须原样采用')
    assert.ok(comp.data.hours.includes(15), '可选小时里必须包含当天的下午时段')
    // ⭐ 2026-10-03：可选小时的下界 = 最早开课 **06:00** ⇒ 6 点必须在，**5 点 / 0 点不许出现**。
    //    ⛔ 上一版这里断言"必须覆盖清晨（含 0 点）"，那是"补录不判最早开课"时代的判据。
    assert.ok(comp.data.hours.includes(6) && comp.data.hours.includes(15),
      '可选小时必须覆盖 06:00 与当天的下午时段（实测 ' + JSON.stringify(comp.data.hours) + '）')
    assert.ok(!comp.data.hours.includes(5) && !comp.data.hours.includes(0),
      '⛔ 05:00 / 00:00 不许出现在可选小时里（最早 06:00，实测 ' + JSON.stringify(comp.data.hours) + '）')
    // ⭐ 上界同样来自「24:00 − 默认时长」⇒ 不是随手写个 24，也不是 23（那是"最晚 24:00 开始"的错口径）。
    assert.equal(Math.max(...comp.data.hours), Math.floor(localOccupancy.latestStartMinutes() / 60),
      `可选小时的上界必须是「最晚开始时间」的整点（实测 ${JSON.stringify(comp.data.hours)}）`)
  })

  await runner('④ 客户端的业务校验**不看日期**：validateBookingCreation 对补录不会拦', async () => {
    world.reset(); world.installRuntime()
    const { A, packageId } = await seed()
    const db = {
      students: [{ id: 'stu-1', name: 'x', status: 'active', packages: [{ id: packageId, type: '常规训练', total: 5, remaining: 5, price: 100, status: 'active' }] }],
      bookings: [], incomes: [], sales: [], settings: {}
    }
    const checked = validateBookingCreation(db, 'stu-1', packageId)
    assert.equal(checked.ok, true, `这个函数根本不读日期 ⇒ 补录不会被它拦（实测 ${JSON.stringify(checked)}）`)
  })

  await runner('⑤ 时间闸门（2026-10-03 **四次口径**）：教练新建/补录**同样**受「最早 06:00、最晚 23:00」约束', async () => {
    world.reset(); world.installRuntime()
    const { A, packageId } = await seed()
    const date = addDays(todayKey(), -1)
    // ① 06:00 起必须能排（过去日期 ⇒ "补录已经上过的课"这件事本身仍然通）
    //    ⚠️ 两条各自换一天，否则 06:00+60 与 06:30 会互相重叠、被冲突判定拒掉（那就测歪了）。
    const six = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date, hour: 6, minute: 0 }, 'm2w_early_ok')
    assert.equal(six.ok, true, `06:00 必须能排（实测 ${JSON.stringify(six)}）`)
    const sixThirty = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: addDays(todayKey(), -2), hour: 6, minute: 30 }, 'm2w_early_630')
    assert.equal(sixThirty.ok, true, `06:30 必须能排（实测 ${JSON.stringify(sixThirty)}）`)
    // ⭐ 2026-10-03：**凌晨不再能新建了**（上一版这里断言"00:15 也必须能排"）。
    //    用户口径：教练新建与会员自助的最早统一到 06:00 ⇒ 那个口子关闭。
    //    ⛔ 但**存量**凌晨课不受影响：不删、不改、不迁移，课表凌晨段照旧展示它们。
    const midnight = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date, hour: 0, minute: 15 }, 'm2w_mid_rejected')
    assert.equal(midnight.ok, false, '⛔ 00:15 已不能新建（最早 06:00）')
    assert.equal(midnight.code, 'BOOKING_START_TOO_EARLY', `实测 ${JSON.stringify(midnight)}`)
    const fiveThirty = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date, hour: 5, minute: 30 }, 'm2w_0530_rejected')
    assert.equal(fiveThirty.ok, false, '⛔ 05:30 已不能新建（最早 06:00）')
    assert.equal(fiveThirty.code, 'BOOKING_START_TOO_EARLY', `实测 ${JSON.stringify(fiveThirty)}`)
    const taken = await world.dataRows('bookings', A.owner, A.datasetId)
    assert.ok(taken.some(row => row.hour === 6 && row.minute === 0), '清晨这一条必须真的落库')
    assert.ok(!taken.some(row => row.hour === 0 || row.hour === 5), '被拒的那两条一条都不许落库')

    // ② 真正非法的时间**照旧被挡**（不是"把校验删了"）：24 点之后、分钟越界、24 点不整点。
    //    ⚠️ 这两类错误是**两个码、两层判据**，不许混：
    //      INVALID_PAYLOAD        = 这个时刻本身不存在（hour 25 / minute 60 / 24:30 / -1）
    //      BOOKING_START_TOO_LATE = 时刻合法，但开课晚于 23:00
    const tooLate = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date, hour: 25, minute: 0 }, 'm2w_time_hour25')
    assert.equal(tooLate.ok, false, '25:00 不存在，必须被拒')
    assert.equal(tooLate.code, 'INVALID_PAYLOAD', `实测 ${JSON.stringify(tooLate)}`)
    const badMinute = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date, hour: 15, minute: 60 }, 'm2w_time_minute60')
    assert.equal(badMinute.ok, false, '分钟 60 必须被拒')
    assert.equal(badMinute.code, 'INVALID_PAYLOAD', `实测 ${JSON.stringify(badMinute)}`)
    const offHour = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date, hour: 24, minute: 30 }, 'm2w_time_hour24m30')
    assert.equal(offHour.ok, false, '24:30 越过了当天最后一格，必须被拒')
    assert.equal(offHour.code, 'INVALID_PAYLOAD', `实测 ${JSON.stringify(offHour)}`)

    // ③ ⭐ 2026-10-03 四次口径：**每天 06:00–23:00 开课，23:00 是最后一个开课时间**（23:00 + 60 ⇒ 24:00 结束）。
    //    ⛔ 判据挂在「**开始**」上（旧口径"结束不得晚于 24:00"已被取代）。
    //    🔄 与上一版的关键差别：**最早 06:00 现在也判**（上面 00:15 / 05:30 被拒就是证据）；
    //       但**30 分钟网格仍不判** —— 08:15 这种非整点照样能录（真实上过的课可能就不是整点）。
    const at23 = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date, hour: 23, minute: 0 }, 'm2w_end_2300')
    assert.equal(at23.ok, true, `23:00 开课 ⇒ 必须能排（实测 ${JSON.stringify(at23)}）`)
    // ⛔ 23:30 这一档已**取消**（二次口径）⇒ 教练通道同样不许。
    //    📌 三件事互不冲突：教练通道**不判网格**（08:15 能录）、**判最早 06:00**（00:15 / 05:30 被拒）、
    //       **判最晚 23:00**（23:30 / 23:45 被拒）—— "不判网格"不等于"什么都不判"。
    const halfPast = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: addDays(todayKey(), -10), hour: 23, minute: 30 }, 'm2w_start_2330')
    assert.equal(halfPast.ok, false, `23:30 开课 ⇒ 已取消，必须被拒（实测 ${JSON.stringify(halfPast)}）`)
    assert.equal(halfPast.code, 'BOOKING_START_TOO_LATE', `实测 ${JSON.stringify(halfPast)}`)
    // ⛔ 超过 23:00 开课 ⇒ 必须被拒（判"开始"，不是"结束"）。
    const oneMinuteOver = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: addDays(todayKey(), -3), hour: 23, minute: 45 }, 'm2w_start_2345')
    assert.equal(oneMinuteOver.ok, false, '23:45 开课 ⇒ 晚于 23:00，必须被拒')
    assert.equal(oneMinuteOver.code, 'BOOKING_START_TOO_LATE', `实测 ${JSON.stringify(oneMinuteOver)}`)
    const startAtMidnightEnd = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: addDays(todayKey(), -4), hour: 24, minute: 0 }, 'm2w_start_2400')
    assert.equal(startAtMidnightEnd.ok, false, '24:00 开课 ⇒ 晚于 23:00，必须被拒')
    assert.equal(startAtMidnightEnd.code, 'BOOKING_START_TOO_LATE', `实测 ${JSON.stringify(startAtMidnightEnd)}`)
    // 📌 这一条补钉"晚于 23:00 一律拒"（含已取消的 23:30），防有人改回旧口径时没人发现。
    const oldRuleWouldReject = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: addDays(todayKey(), -5), hour: 22, minute: 0 }, 'm2w_end_2200_ok')
    assert.equal(oldRuleWouldReject.ok, true, `22:00 开课 ⇒ 必须能排（实测 ${JSON.stringify(oldRuleWouldReject)}）`)

    // 位置：cloudfunctions/coachBusinessCommand/handlers.js 的 bookingMoment() + occupancy.startsAfterLatest()

    // ⭐ 本机引擎必须与云端**同口径**：utils/cloud-command-engine.js 里还有一份同名 bookingMoment。
    //   只钉住云端那一处是不够的 —— 本机松一格就会出现"本机先收下、出网才被拒"的错位，
    //   用户看到的是"点了有反应，过一会儿又没了"，比直接拒绝难查得多。
    const { InMemoryCommandEngine } = require('../utils/cloud-command-engine')
    // ⚠️ 引擎是有状态的（每成功一次 revision 就往前走）⇒ 每个 case 都要**重新播种**，
    //    否则第二次调用会撞 REVISION_CONFLICT，测出来的就不再是"这个时间能不能排"。
    const freshEngine = id => {
      const engine = new InMemoryCommandEngine({ now: () => Date.now(), idFactory: kind => `${kind}_bf_${Math.random().toString(36).slice(2, 8)}` })
      engine.seed('coach_a', {
        dataRevision: 0,
        students: [{ id: 'stu-1', name: 'x', status: 'active', packages: [{ id, type: '常规训练', total: 5, used: 0, remaining: 5, price: 100, status: 'active' }] }],
        bookings: [], incomes: [], sales: [], settings: {}, customExercises: []
      })
      return engine
    }
    // 本机与云端同一个小时集合 ⇒ 逐小时各走一遍，两边必须给出**同一个**结论。
    // ⚠️ 每个 case 都重开一份世界：连续写会让 revision 往前走，
    //    而"某个时间被拒"这件事本身**不应该依赖这条命令排在第几个** —— 那是把实现细节当成判据。
    //    ⚠️ "被拒"只认两个码（时刻非法 / 结束太晚）；别的码（冲突、余额）说明这个 case 测歪了。
    const REJECT_CODES = ['INVALID_PAYLOAD', 'BOOKING_START_TOO_EARLY', 'BOOKING_START_TOO_LATE']
    // ⭐ 2026-10-03 四次口径下的期望值：06:00 / 06:30 / 22:00 / 23:00 能排；
    //    **00:00 / 05:30 被拒（最早 06:00）**；23:30 / 23:45 / 24:00 之后、分钟越界、小时越界一律拒。
    //    📌 本机引擎与云端必须逐 case 同结论、同码 —— 差一格就是"本机先收下、出网才被拒"。
    for (const [hour, minute, expectedOk] of [[0, 0, false], [5, 30, false], [6, 0, true], [6, 30, true], [22, 0, true], [23, 0, true], [23, 30, false], [23, 45, false], [24, 0, false], [25, 0, false], [15, 60, false], [24, 30, false], [-1, 0, false]]) {
      world.reset()
      const fresh = await seed()
      const result = await world.execute(fresh.A, 'createBooking', { studentId: 'stu-1', packageId: fresh.packageId, date, hour, minute }, `m2w_pair_${hour}_${minute}`)
      const cloudOk = result.ok === true
      assert.equal(cloudOk, expectedOk, `云端对 ${hour}:${minute} 的判定（实测 ${JSON.stringify(result)}）`)
      if (!expectedOk) assert.ok(REJECT_CODES.includes(String(result.code || '')), `云端拒 ${hour}:${minute} 时必须是这两个码之一（实测 ${JSON.stringify(result)}）`)
      let local = null
      try {
        local = freshEngine(fresh.packageId).execute({ ownerCoachId: 'coach_a' }, {
          command: 'createBooking', requestId: `bf_local_${hour}_${minute}`, expectedRevision: 0,
          payload: { studentId: 'stu-1', packageId: fresh.packageId, date, hour, minute }
        })
      } catch (error) { local = { ok: false, code: error && error.code } }
      const localOk = local && local.ok === true
      assert.equal(localOk, expectedOk, `本机引擎对 ${hour}:${minute} 的判定（实测 ${JSON.stringify(local)}）`)
      if (!expectedOk) assert.ok(REJECT_CODES.includes(String((local && local.code) || '')), `本机拒 ${hour}:${minute} 时必须是这两个码之一（实测 ${JSON.stringify(local)}）`)
    }
  })

  await runner('⑥ 补录不能撞已有课：同一时段已有预约 ⇒ 照旧冲突被拒', async () => {
    world.reset(); world.installRuntime()
    const { A, packageId } = await seed()
    const first = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 15, minute: 0 })
    assert.equal(first.ok, true, JSON.stringify(first))
    const second = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 15, minute: 30 }, 'm2w_conflict')
    assert.equal(second.ok, false, '补录撞已有课必须被拒')
    assert.equal(second.code, 'BOOKING_TIME_CONFLICT', `实测 ${JSON.stringify(second)}`)
  })

  await runner('⑦ ⭐ 跨午夜冲突**不能漏判**：22:30 开 120 分钟（跨到次日 00:30）与次日 00:00–01:00 必须冲突', async () => {
    // ⛔ 这是本轮最容易出事的一条：旧冲突检测里 `booking.date !== moment.date ⇒ return false`
    //    （**只比同一天**）⇒ 只要存在跨午夜的课，这两节就会被判成"没冲突"，同一个人同时上两节。
    // 📌 2026-10-03：口径统一到 06:00 之后，**入口**再也造不出凌晨课 ⇒ 这条场景改成从
    //    **存量数据 + 算法层**两侧钉死（比"尝试新建被拒"更贴近语义：占用是数据属性，不是入口属性）。
    //    ⚠️ 注入必须带**顶层** `studentId` / `packageId` —— 服务端按顶层字段索引。
    world.reset(); world.installRuntime()
    const { A, packageId } = await seed()
    const day1 = addDays(todayKey(), 1), day2 = addDays(todayKey(), 2)
    // ① 注入一条**存量**跨午夜课：day1 23:30 → day2 00:30
    world.put('bookings', world.businessId('bookings', A.owner, A.datasetId, 'legacy-2330'), {
      ownerCoachId: A.owner, datasetId: A.datasetId, bookingId: 'legacy-2330',
      studentId: 'stu-1', packageId,
      data: {
        id: 'legacy-2330', studentId: 'stu-1', studentName: '跨午夜学员', packageId, date: day1,
        hour: 23, minute: 30, plannedMinutes: 60, status: 'booked', typeName: '常规训练', price: 100
      }
    })
    assert.ok(world.dataRows('bookings', A.owner, A.datasetId).some(row => row.id === 'legacy-2330'), '存量跨午夜旧课必须真的在账本里')
    // ② ⭐ 核心判据：跨日重叠**必须**判成冲突（日期字段不同 ≠ 不冲突）
    const legacy = localOccupancy.intervalOf({ date: day1, hour: 23, minute: 30, plannedMinutes: 60 })
    const clash = localOccupancy.intervalOf({ date: day2, hour: 0, minute: 0, plannedMinutes: 60 })
    assert.strictEqual(localOccupancy.intervalsOverlap(legacy, clash), true,
      '00:00–00:30 与存量旧课真重叠 ⇒ 冲突判定不许漏（旧算法按 date 短路就会漏掉这一条）')
    // ③ 首尾**相接**不算冲突：day2 00:30 起 ⇒ 不重叠
    const adjacent = localOccupancy.intervalOf({ date: day2, hour: 0, minute: 30, plannedMinutes: 60 })
    assert.strictEqual(localOccupancy.intervalsOverlap(legacy, adjacent), false, '首尾相接不算冲突')
    // ④ 云端侧：那两个凌晨时刻**都进不了入口**（先被最早闸门挡）⇒ "漏判冲突"在入口层也伤不到人
    for (const [hour, minute, requestId] of [[0, 0, 'm2w_cross_overlap'], [0, 30, 'm2w_cross_adjacent']]) {
      const attempt = await world.execute(A, 'createBooking', { studentId: 'stu-1', packageId, date: day2, hour, minute }, requestId)
      assert.equal(attempt.ok, false, `day2 的 ${hour}:${minute} 不能再从入口新建`)
      assert.equal(attempt.code, 'BOOKING_START_TOO_EARLY', `实测 ${JSON.stringify(attempt)}`)
    }
    // ⑤ 存量旧课**一个字节都没被改**（不删、不改、不迁移）
    assert.ok(world.dataRows('bookings', A.owner, A.datasetId)
      .some(row => row.id === 'legacy-2330' && row.status === 'booked'), '⛔ 存量跨午夜旧课必须原样保留')
  })

  require('../utils/data-runtime').setEnvironment('production')
  if (!process.exitCode) process.stdout.write('ALL PAST LESSON BACKFILL TESTS PASSED\n')
})().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
