// M3 P1 · 会员自主约课第一批（**只读**）—— 永久回归测试。
//
// 本批的四条硬红线（每条都有对应断言，不是靠"看起来对"）：
//   ① **零写入**：确认按钮只弹提示，一个字节都不写（⑨ 用假 wx.cloud 计数咬住）；
//   ② **只认可信 memberId**：不按姓名/手机号匹配，换一个 openId 就读不到别人的数据（①②⑩）；
//   ③ **缺字段显示「未记录」**：绝不拿当前时间顶替历史课程时间（⑥）；
//   ④ **日期切换真的生效**：dateIndex 是唯一真相源，切了日期内容必须变（⑦，BUG05 的形状）。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const { runner } = require('./helpers/m2-business-world')
const view = require('../utils/member-booking-view')
const occupancy = require('../utils/package-occupancy')
const beijingDate = require('../utils/beijing-date')
const { createService: readService, memberIdFor, fixedId } = require('../cloudfunctions/readMyMemberData/service')

// ------------------------------------------------------------------ 假云端（只读路径用到的集合）
function createCloud(openId) {
  const stores = {}
  let current = openId
  const scope = target => ({
    collection(name) {
      const store = target[name] || (target[name] = new Map())
      return {
        doc(id) { return { async set({ data }) { store.set(id, { ...data, _id: id }) }, async remove() { store.delete(id) } } },
        where(query) {
          let skip = 0, limit = 100
          const api = {
            skip(n) { skip = n; return api },
            limit(n) { limit = n; return api },
            async get() {
              const rows = [...store.values()].filter(row => Object.keys(query).every(key => row && row[key] === query[key]))
              return { data: rows.slice(skip, skip + limit).map(row => JSON.parse(JSON.stringify(row))) }
            }
          }
          return api
        }
      }
    }
  })
  const db = scope(stores)
  return {
    stores, db,
    setOpenId(value) { current = value },
    getOpenId: () => current,
    put(name, id, row) { const store = stores[name] || (stores[name] = new Map()); store.set(id, { ...row, _id: id }) },
    rows(name) { return [...(stores[name] || new Map()).values()] }
  }
}

const ENV = 'sandbox'
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const memberIdOf = openId => sha(`member:${openId}`).slice(0, 32)
const coachIdOf = openId => sha(`coach:${openId}`).slice(0, 32)

// 会员 A 认领了教练甲账里的学员 S1；教练乙被授予了课包级授课权（M2 双层授权）。
function seed(cloud) {
  const memberOpenId = 'member-a', coachA = 'coach-a', coachB = 'coach-b'
  const memberId = memberIdOf(memberOpenId), coachAId = coachIdOf(coachA), coachBId = coachIdOf(coachB)
  const studentId = 'student-s1', datasetA = 'ds-a', datasetB = 'ds-b'
  cloud.put('member_sandbox_accounts', fixedId('member_sandbox_accounts', memberId), { memberId, status: 'active', displayName: '小蓝' })
  cloud.put('member_sandbox_student_claims', 'claim-1', { claimId: 'claim-1', memberId, studentId, coachId: coachAId, status: 'verified' })
  cloud.put('member_sandbox_coach_profiles', 'profile-a', { coachId: coachAId, displayName: '甲教练', discoverable: true })
  cloud.put('member_sandbox_coach_profiles', 'profile-b', { coachId: coachBId, displayName: '乙教练', discoverable: true })
  cloud.put('coach_sandbox_heads', 'head-a', { ownerCoachId: coachAId, environment: 'sandbox', activeDatasetId: datasetA })
  cloud.put('coach_sandbox_heads', 'head-b', { ownerCoachId: coachBId, environment: 'sandbox', activeDatasetId: datasetB })
  cloud.put('coach_sandbox_package_grants', 'grant-b', { studentId, coachId: coachBId, packageId: 'pkg-1', ownerCoachId: coachAId, datasetId: datasetA, status: 'active' })
  cloud.put('packages', 'pkg-1', { packageId: 'pkg-1', ownerCoachId: coachAId, datasetId: datasetA, studentId, type: '常规课', total: 10, used: 2, remaining: 8, reserved: 1, status: 'active' })
  cloud.put('packages', 'pkg-old', { packageId: 'pkg-old', ownerCoachId: coachAId, datasetId: datasetA, studentId, type: '赠课', total: 1, used: 1, remaining: 0, reserved: 0, status: 'active' })
  return { memberId, coachAId, coachBId, studentId, datasetA, datasetB }
}

function booking(id, extra) {
  return Object.assign({ bookingId: id, date: '2026-09-30', hour: 10, minute: 0, status: 'booked', plannedMinutes: 60, typeName: '力量训练' }, extra)
}

const read = cloud => readService({ db: cloud.db, getOpenId: cloud.getOpenId })

;(async () => {
  await runner('① 「我的预约」只返回**当前可信 memberId** 认领到的那几条（换 openId ⇒ 一条都读不到）', async () => {
    const cloud = createCloud('member-a'), ids = seed(cloud)
    cloud.put('bookings', 'b1', { ...booking('b1'), ownerCoachId: ids.coachAId, datasetId: ids.datasetA, studentId: ids.studentId })
    const mine = await read(cloud)({ action: 'availability', environment: ENV })
    assert.strictEqual(mine.ok, true)
    assert.strictEqual(mine.availability, true, '新版只读投影必须带 availability 标记（旧版云端靠它判别）')
    assert.strictEqual(mine.bookings.length, 1, '本人应当读到 1 条自己的预约')

    // 另一位**已注册**会员（有账号、但没有任何认领关系）⇒ 一样要读到空。
    const other = createCloud('member-other')
    seed(other)
    const otherMemberId = memberIdOf('member-other')
    other.put('member_sandbox_accounts', fixedId('member_sandbox_accounts', otherMemberId), { memberId: otherMemberId, status: 'active', displayName: '另一位' })
    const stranger = await read(other)({ action: 'availability', environment: ENV })
    assert.strictEqual(stranger.availability, true, '另一位会员也走新版只读投影（下面才是在验"他读到什么"）')
    assert.deepEqual(stranger.bookings, [], '没有认领关系的会员必须读到空，而不是别人的预约')
    assert.deepEqual(stranger.coaches, [], '也不该看到任何教练')
    assert.deepEqual(stranger.packages, [], '更不该看到别人的课时包')
  })

  await runner('② 教练占用时段**不含任何学员信息**（只投影分钟区间）', async () => {
    const cloud = createCloud('member-a'), ids = seed(cloud)
    cloud.put('bookings', 'm1', { ...booking('m1'), ownerCoachId: ids.coachAId, datasetId: ids.datasetA, studentId: ids.studentId })
    cloud.put('bookings', 'o1', { ...booking('o1'), ownerCoachId: ids.coachAId, datasetId: ids.datasetA, studentId: 'student-other', hour: 15 })
    const result = await read(cloud)({ action: 'availability', date: '2026-09-30', environment: ENV })
    assert.strictEqual(result.busy.length, 1, '别人的课要投影成 1 段占用')
    const keys = Object.keys(result.busy[0]).sort()
    assert.deepEqual(keys, ['coachKey', 'end', 'start'], `占用投影只能有这三个字段，实测：${keys.join(',')}`)
    assert.deepEqual(result.busy[0], { coachKey: fixedId('member-coach-view', ids.coachAId), start: 900, end: 960 })
    const dump = JSON.stringify(result)
    ;['student-other', 'studentId', 'openId', 'memberId', 'coachId'].forEach(secret => {
      assert.ok(!dump.includes(secret), `返回里出现了不该下发的字段：${secret}`)
    })
    // 会员自己的课单独在 own 里（不与别人混在一起）
    assert.strictEqual(result.own.length, 1)
  })

  await runner('③ 已占用的时段**不能显示为可约**（10:00–11:00 被占，其余仍可约）', async () => {
    const rows = [{ historyId: 'h1', date: '2026-09-30', hour: 10, minute: 0, status: 'booked', plannedMinutes: 60 }]
    const busy = view.busyOf({ bookings: rows, coachBusy: [], dateKey: '2026-09-30' })
    const slots = view.slotsFor({ dateKey: '2026-09-30', busy, todayKey: '2026-01-01', dayStart: view.DAY_START_MINUTES, dayEnd: view.DAY_END_MINUTES })
    const target = slots.find(row => row.start === 600)
    assert.ok(target, '应当有 10:00 这一段')
    assert.strictEqual(target.available, false, '被占用的时段不许显示成可约')
    assert.strictEqual(target.reason, 'booked')
    const nine = slots.find(row => row.start === 540)
    assert.strictEqual(nine.available, true, '09:00 没有被占，必须可约')
    // 90 分钟的课只占 90 分钟，不会多占也不会少占
    const longBusy = view.busyOf({ bookings: [{ historyId: 'h2', date: '2026-09-30', hour: 14, minute: 0, status: 'booked', plannedMinutes: 90 }], coachBusy: [], dateKey: '2026-09-30' })
    const slots2 = view.slotsFor({ dateKey: '2026-09-30', busy: longBusy, todayKey: '2026-01-01' })
    assert.strictEqual(slots2.find(row => row.start === 840).available, false, '14:00 被占')
    assert.strictEqual(slots2.find(row => row.start === 900).available, false, '15:00 仍被 90 分钟那节课占着')
    assert.strictEqual(slots2.find(row => row.start === 960).available, true, '16:00 已经空出来')
  })

  await runner('④ ⭐ 开课窗口边界（2026-10-03 **四次**口径）：06:00 起、23:00 收尾、步长 30 ⇒ 35 格', async () => {
    // ⛔ 本段原钉"最晚 24:00 结束 ⇒ 最后一个起点 23:00"；随后 2026-10-01 定为 23:30 收尾（允许跨午夜）；
    //    1.3.5 真机后**再定**：取消 23:30 开课 ⇒ 最后一个起点回到 **23:00**（23:00+60 ⇒ 24:00 结束，正好卡界）。
    //    ⭐ 2026-10-03 **四次口径**：起点从 07:00 提到 **06:00**（教练新建与会员自助同一条规则）。
    const slots = view.slotsFor({ dateKey: '2026-09-30', busy: [], todayKey: '2026-01-01', dayStart: view.DAY_START_MINUTES, latestStart: view.LATEST_START_MINUTES })
    assert.strictEqual(view.LATEST_START_MINUTES, occupancy.LATEST_START_MINUTES, '会员端上界必须取自 occupancy，不得写死')
    assert.strictEqual(view.DAY_START_MINUTES, occupancy.EARLIEST_START_MINUTES, '会员端下界必须取自 occupancy，不得写死')
    assert.strictEqual(view.DAY_START_MINUTES, 6 * 60, '分享可约起点保持 06:00')
    assert.strictEqual(view.SLOT_STEP_MINUTES, 30, '步长必须是 30 分钟')
    assert.ok(slots.length, '06:00 之后必须有可约时段')
    assert.strictEqual(slots[0].startText, '06:00', `最早可约起点应为 06:00，实测 ${slots[0].startText}`)
    assert.ok(!slots.some(slot => slot.start === 5 * 60 + 30), '⛔ 05:30 不许出现（最早 06:00）')
    const last = slots[slots.length - 1]
    assert.strictEqual(last.startText, '23:00', `最后一个可约起点应为 23:00，实测 ${last.startText}`)
    // ⭐ 23:00 起 60 分钟 ⇒ 24:00 结束，**正好卡在当天界上**（这就是"取消 23:30"之后合法的最后一节）。
    assert.strictEqual(last.endText, '24:00', `23:00 那格结束应显示 24:00，实测 ${last.endText}`)
    assert.strictEqual(last.end, 24 * 60)
    assert.strictEqual(last.crossesMidnight, false, '⛔ 新生成的最后一格不再跨午夜')
    assert.strictEqual(slots.length, (23 * 60 - 6 * 60) / 30 + 1, '06:00–23:00 每 30 分钟一格 ⇒ 35 格')
    // 23:00 之后（含 23:30）不许再有起点；05:59 及更早也不许（那是补录通道的事，不出现在会员可选列表）
    assert.ok(!slots.some(slot => slot.start > 23 * 60), '23:00 之后（含 23:30）不许出现起点')
    assert.ok(!slots.some(slot => slot.start < 6 * 60), '06:00 之前不许出现起点')
    assert.ok(slots.every(slot => slot.start % 30 === 0), '每一格都必须落在整点或半点')
  })

  await runner('⑤ 空状态：整天被占满 ⇒ 每一段都不可约，且给出原因（不是空白）', async () => {
    const busy = [{ start: 0, end: 24 * 60 }]
    const slots = view.slotsFor({ dateKey: '2026-09-30', busy, todayKey: '2026-01-01' })
    assert.ok(slots.length, '整天被占也要渲染出时间段（否则会员看到的是一片空白，不知道为什么）')
    assert.ok(slots.every(slot => !slot.available), '被占满时每一段都必须不可约')
    assert.ok(slots.every(slot => slot.reasonText), '每一段都要有可显示的原因文案')
  })

  await runner('⑥ 缺字段 / 旧数据：一律显示「未记录」，**绝不拿当前时间顶替**', async () => {
    const broken = view.bookingView({ historyId: 'x1', status: 'done', date: '', hour: null, minute: null })
    assert.strictEqual(broken.dateText, view.UNRECORDED)
    assert.strictEqual(broken.startText, view.UNRECORDED)
    assert.strictEqual(broken.endText, view.UNRECORDED)
    assert.strictEqual(broken.durationText, view.UNRECORDED)
    assert.strictEqual(broken.coachName, view.UNRECORDED)
    const today = beijingDate.todayKey()
    const dump = JSON.stringify(broken)
    assert.ok(!dump.includes(today), `缺字段时把今天（${today}）当成课程时间写进了展示`)
    assert.ok(!dump.includes(String(new Date().getFullYear())), '不许出现当前年份')
    // 已过时间的判定：今天的情况下，过去的时段要标 past
    const slots = view.slotsFor({ dateKey: '2026-09-30', busy: [], todayKey: '2026-09-30', nowMinutes: 10 * 60 })
    const past = slots.find(row => row.start === 9 * 60)
    assert.strictEqual(past.available, false)
    assert.strictEqual(past.reason, 'past')
  })

  await runner('⑦ 日期切换必须真的改变内容（BUG05 形状：切了日期、显示还是旧的那天）', async () => {
    const options = view.dateOptions('2026-09-30', 5)
    assert.deepEqual(options.map(row => row.key), ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
    assert.deepEqual(options.map(row => row.index), [0, 1, 2, 3, 4], 'index 必须连续且与 key 一一对应（页面只存 index）')
    const bookings = [{ historyId: 'h1', date: '2026-10-02', hour: 10, minute: 0, status: 'booked', plannedMinutes: 60 }]
    const at = key => view.slotsFor({ dateKey: key, busy: view.busyOf({ bookings, dateKey: key }), todayKey: '2026-01-01' })
    assert.strictEqual(at('2026-10-01').find(row => row.start === 600).available, true, '10-01 这天 10:00 没课 ⇒ 可约')
    assert.strictEqual(at('2026-10-02').find(row => row.start === 600).available, false, '10-02 这天 10:00 有课 ⇒ 不可约')
  })

  await runner('⑧ 页面入口与事件绑定：每一处 bindtap 都有真 handler，且页面已注册', async () => {
    const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
    const targets = ['pages/member-bookings/member-bookings', 'pages/member-book-slots/member-book-slots', 'pages/member-home/member-home']
    targets.forEach(page => assert.ok(app.pages.includes(page), `app.json 必须注册 ${page}`))
    for (const page of targets) {
      let captured = null
      global.Page = config => { captured = config }
      const full = require.resolve(path.join(ROOT, page))
      delete require.cache[full]
      require(full)
      const wxml = fs.readFileSync(path.join(ROOT, `${page}.wxml`), 'utf8')
      const taps = [...new Set([...wxml.matchAll(/bindtap="([A-Za-z_][\w]*)"/g)].map(m => m[1]))]
      assert.ok(taps.length, `${page} 的 wxml 里应当有 bindtap`)
      const missing = taps.filter(name => typeof captured[name] !== 'function')
      assert.deepEqual(missing, [], `${page}：这些按钮点了没反应：${missing.join('、')}`)
    }
    const homeWxml = fs.readFileSync(path.join(ROOT, 'pages/member-home/member-home.wxml'), 'utf8')
    assert.ok(homeWxml.includes('bindtap="bookings"') && homeWxml.includes('bindtap="bookSlots"'), '会员首页必须有「我的预约 / 去约课」两个入口')
  })

  // M3-P3（2026-09-30）：真实提交链已打开 ⇒ 这里把**总闸按回关闭**来验证"未开放"这条路径仍然诚实：
  //   ⛔ 关掉总闸 ⇒ 只弹提示、**一次云调用都不发**（真提交那条链由 `m3-p3-member-booking-live` 验）。
  await runner('⑨ 总闸关掉时点「确认」：零云调用 + 明说未开放（不许假成功）', async () => {
    const state = { calls: [], modals: [], toasts: [], storage: {}, next: null }
    global.wx = {
      getStorageSync: key => state.storage[key],
      setStorageSync: (key, value) => { state.storage[key] = value },
      navigateTo: () => { }, redirectTo: () => { },
      showModal: option => state.modals.push(option),
      showToast: option => state.toasts.push(option),
      stopPullDownRefresh: () => { },
      cloud: { callFunction: async option => { state.calls.push(option); return { result: state.next || {} } } }
    }
    let captured = null
    global.Page = config => { captured = config }
    const full = require.resolve(path.join(ROOT, 'pages/member-book-slots/member-book-slots'))
    delete require.cache[full]
    require(full)
    const page = Object.assign({}, captured, { data: JSON.parse(JSON.stringify(captured.data)) })
    page.setData = function (patch) { Object.assign(this.data, patch) }
    page.data.slots = view.slotsFor({ dateKey: '2026-10-05', busy: [], todayKey: '2026-01-01' })
    page.data.confirmOpen = true
    page.data.selected = page.data.slots[0]

    const flags = require(path.join(ROOT, 'utils/release-flags'))
    const original = flags.memberBookingSubmitEnabled
    flags.memberBookingSubmitEnabled = () => false
    try {
      const before = state.calls.length
      captured.submit.call(page)
      assert.strictEqual(state.calls.length, before, `总闸关掉后不得发起任何云调用（实测新增 ${state.calls.length - before} 次）`)
      assert.strictEqual(state.modals.length, 1, '必须明确告诉会员预约提交还没开放')
      assert.ok(state.modals[0].content.includes('未开放'), '提示文案必须明说还没开放')
      assert.deepEqual(state.toasts, [], '不该用 toast 伪装成功')
    } finally {
      flags.memberBookingSubmitEnabled = original
    }

    // 选到不可约的时段：给提示 + **不打开确认层**
    page.data.confirmOpen = false
    page.data.slots[0].available = false
    page.data.slots[0].reason = 'booked'
    page.data.slots[0].reasonText = '已排课'
    captured.pickSlot.call(page, { currentTarget: { dataset: { key: page.data.slots[0].key } } })
    assert.strictEqual(state.toasts.length, 1, '点到不可约时段必须给出原因，不能静默')
    assert.strictEqual(page.data.confirmOpen, false, '不可约的时段不许打开确认层')
  })

  await runner('⑩ 详情只按 historyId 精确匹配（同名同时间的课也不会串）', async () => {
    const rows = [
      { historyId: 'h-a', date: '2026-09-30', hour: 10, minute: 0, status: 'booked', plannedMinutes: 60, coach: { displayName: '甲教练' } },
      { historyId: 'h-b', date: '2026-09-30', hour: 10, minute: 0, status: 'booked', plannedMinutes: 60, coach: { displayName: '甲教练' } }
    ]
    const detail = view.detailOf(rows, 'h-b')
    assert.ok(detail && detail.historyId === 'h-b')
    assert.strictEqual(view.detailOf(rows, 'h-not-exist'), null)
    assert.strictEqual(view.detailOf(rows, ''), null, '空 id 不许匹配到第一条')
    const split = view.splitBookings(rows)
    assert.strictEqual(split.upcoming.length, 2)
    assert.strictEqual(split.history.length, 0)
  })

  await runner('⑫ 真页面日期切换：点第 3 个日期 ⇒ 请求这个日期、内容跟着变（dateIndex 是唯一真相源）', async () => {
    const state = { calls: [], modals: [], toasts: [], storage: {} }
    // ⭐ "被占的那天"**不许写死成具体月日**：硬编码 2026-10-02 ⇒ 一跨天这条测试就自己失效
    //   （2026-10-01 真实踩到：dates[2] 从 10-02 变成 10-03，断言必然红）。
    //   ⇒ 改成"第 3 个日期选项"本身，永远跟着今天走，语义（同段不同日 ⇒ 结果不同）完全不变。
    let busyDate = null
    global.wx = {
      getStorageSync: key => state.storage[key],
      setStorageSync: (key, value) => { state.storage[key] = value },
      navigateTo: () => { }, redirectTo: () => { },
      showModal: option => state.modals.push(option),
      showToast: option => state.toasts.push(option),
      stopPullDownRefresh: () => { },
      cloud: {
        callFunction: async option => {
          state.calls.push(option)
          const date = option.data.date
          // 只有"被占的那天"（= 第 3 个日期选项）10:00–11:00 被占 ⇒ 用来验证"切了日期，内容真的变了"
          const busy = date === busyDate ? [{ coachKey: 'coach-a', start: 600, end: 660 }] : []
          return { result: { ok: true, availability: true, environment: 'sandbox', date, coaches: [{ coachKey: 'coach-a', displayName: '甲教练' }], packages: [], bookings: [], own: [], busy, warnings: [] } }
        }
      }
    }
    let captured = null
    global.Page = config => { captured = config }
    const full = require.resolve(path.join(ROOT, 'pages/member-book-slots/member-book-slots'))
    delete require.cache[full]
    require(full)
    const page = Object.assign({}, captured, { data: JSON.parse(JSON.stringify(captured.data)) })
    page.setData = function (patch) { Object.assign(this.data, patch) }

    await captured.load.call(page)
    const dates = page.data.dates
    busyDate = dates[2].key                 // ⭐ 被占的那天 = 第 3 个日期选项（不写死月日）
    assert.ok(dates.length >= 4)
    assert.strictEqual(page.data.dateIndex, 0)
    assert.strictEqual(page.data.dateKey, dates[0].key)

    // ⚠️ 不拿"今天"断言：今天几点可约取决于跑测试时的时钟 ⇒ 只比对**同一段 10:00 在不同日期的差异**。
    await captured.pickDate.call(page, { currentTarget: { dataset: { index: 2 } } })
    assert.strictEqual(page.data.dateIndex, 2)
    assert.strictEqual(page.data.dateKey, dates[2].key, '显示的日期必须跟着 index 走（BUG05 的形状：选了 A、显示 B）')
    let last = state.calls[state.calls.length - 1]
    assert.strictEqual(last.data.date, dates[2].key, '必须按新日期去读，而不是沿用第一次的结果')
    const busyDay = page.data.slots.find(row => row.start === 600)
    assert.strictEqual(busyDay.available, false, '被占的那天 10:00 ⇒ 不可约')

    await captured.pickDate.call(page, { currentTarget: { dataset: { index: 3 } } })
    assert.strictEqual(page.data.dateIndex, 3)
    assert.strictEqual(page.data.dateKey, dates[3].key)
    last = state.calls[state.calls.length - 1]
    assert.strictEqual(last.data.date, dates[3].key)
    const freeDay = page.data.slots.find(row => row.start === 600)
    assert.strictEqual(freeDay.available, true, '下一天 10:00 没被占 ⇒ 可约')
    assert.notStrictEqual(busyDay.available, freeDay.available, '同一个时段、不同日期必须给出不同结果 ⇒ 证明内容真的跟着日期变')
  })

  await runner('⑪ 可用课时包：只展示还有余量的（余额为 0 的不出现），且不暴露销售信息', async () => {
    const usable = view.usablePackages([
      { packageViewId: 'p1', typeName: '常规课', remaining: 8, reserved: 1, coach: { displayName: '甲教练' } },
      { packageViewId: 'p2', typeName: '赠课', remaining: 0, reserved: 0 },
      { packageViewId: 'p3', typeName: '已作废', remaining: 5, reserved: 0, status: 'reversed' }
    ])
    assert.deepEqual(usable.map(row => row.packageViewId), ['p1'])
    assert.strictEqual(usable[0].availableToBook, 7, '可约数 = remaining − reserved')
    const dump = JSON.stringify(usable)
    ;['price', 'amount', 'saleId', 'commission'].forEach(word => assert.ok(!dump.includes(word), `课时包视图里出现了不该给会员看的字段：${word}`))
  })
})()
