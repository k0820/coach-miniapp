// M3-P4 · 会员「我的预约」管理能力（取消 / 改期）—— 永久回归测试（2026-09-30）
//
// ★★ 本轮订正（2026-09-30 故障恢复：M3-P6 落地后）★★
//   P4 当时的红线是"UI 完整但**零写入**"（六条规则未定）。**P6 已把写链打开** ⇒
//   本文件里那些"零写入 / 双锁必须关 / 云端只认一条命令 / 六条规则全未定"的断言**已被新契约取代**，
//   已在本轮改成：
//     · ⑬⑭ 从"零写入"改成"**恰好一次**写调用、且命令/payload 正确"（真写链在 `m3-p6-member-manage-write` 里测）；
//     · ⑱ 命令白名单从 1 条 → **3 条**（这是有意变化，不是被"加宽"）；
//     · ⑲ 六条规则**已定**，但**扩展点机制仍在**（撤回一条 ⇒ 立刻重新锁上）；
//     · ⑳ 两道锁**仍然在**，改成验"任一为真 ⇒ 零云调用"（回滚路径不许被拆掉）。
//
// 覆盖（与需求逐条对应）：
//   ① 待上课有按钮 ② 已完成没有 ③ 已取消没有/不可操作 ④ 改期复用 30 天唯一常量
//   ⑤ +30 可 / +31 拒 ⑥ 23:00+60 合法 ⑦ 超 24:00 拒 ⑧ 已占用不可选
//   ⑨ 改期忽略自己这一节的占用 ⑩ 不能操作别人的预约 ⑪ bookingId 被篡改明确拒绝
//   ⑫ 缺字段显示「未记录」⑬ 取消恰好一次写 ⑭ 改期恰好一次写 ⑮ 不许假成功
//   ⑯ bindtap 都有真实 handler ⑰ 返回后原预约仍在 ⑱ 创建链不受影响
//   ⑲ 六个 policy 扩展点 ⑳ 两道锁 ㉑ 白名单与身份键 ㉒ 幂等与新身份 ㉓ 已取消不再占时间

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { runner } = require('./helpers/m2-business-world')

const ROOT = path.join(__dirname, '..')
const view = require('../utils/member-booking-view')
const manage = require('../utils/member-booking-manage')
const occupancy = require('../utils/package-occupancy')
const beijingDate = require('../utils/beijing-date')
const flags = require('../utils/release-flags')
const requestBuilder = require('../utils/member-booking-request')
const cloudMemberBooking = require('../cloudfunctions/coachBusinessCommand/memberBooking')
const memberRuntime = require('../cloudfunctions/../utils/member-runtime')

const UNRECORDED = view.UNRECORDED
const TODAY = beijingDate.todayKey()
const MAX = occupancy.MEMBER_BOOKING_MAX_DAYS
const plus = days => beijingDate.addDays(TODAY, days)

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
}
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')

const PAGE = 'pages/member-bookings/member-bookings'
const bookingRow = (extra = {}) => Object.assign({
  historyId: 'h1', date: plus(3), hour: 10, minute: 0, status: 'booked', plannedMinutes: 60,
  coach: { coachKey: 'ck-1', displayName: '甲教练' },
  packageViewId: 'pv-1', typeName: '力量训练'
}, extra)

// ------------------------------------------------------------------ 真页面（假 wx）：读写调用分开计数
function buildPage(options = {}) {
  const state = { calls: [], modals: [], toasts: [], loadings: [], storage: {}, availability: options.availability || null, coachResult: options.coachResult || null }
  // ⭐ P-2 第二轮：需要能"卡住"云端写调用 ⇒ 用来验证「云端还没返回，界面已经首帧更新」。
  let releaseGate = null
  const gate = options.holdCoach ? new Promise(resolve => { releaseGate = resolve }) : null
  // ⭐ P-3（2026-10-01）：需要能"卡住"云端**读**调用 ⇒ 用来验证「进页面不等云 Promise 就出列表」。
  let releaseRead = null
  const readGate = options.holdRead ? new Promise(resolve => { releaseRead = resolve }) : null
  global.wx = {
    getStorageSync: key => state.storage[key],
    setStorageSync: (key, value) => { state.storage[key] = value },
    navigateTo: () => { }, redirectTo: () => { },
    showModal: option => {
      state.modals.push(option)
      // ⭐ M3-P6：取消有**二次确认**（`askConfirm` 等 `success({confirm})`）⇒ 假 wx 必须能应答，
      //    否则页面会一直 await 一个永不 resolve 的 Promise（表现为测试挂住，而不是断言失败）。
      //    `autoConfirm` 不传 ⇒ 只记录不回答（用于验"确认之前不发写调用"）。
      if (options.autoConfirm && typeof option.success === 'function') {
        setImmediate(() => option.success({ confirm: true }))
      }
    },
    showToast: option => state.toasts.push(option),
    // ⭐ P-2：记录阻塞式 loading ⇒ 改期链路**必须一个都没有**（`state.loadings.length === 0`）。
    showLoading: option => { state.loadings.push(option) },
    hideLoading: () => { state.loadings.push({ hide: true }) },
    stopPullDownRefresh: () => { },
    cloud: {
      callFunction: async option => {
        state.calls.push(option)
        if ((option.name === 'readMyMemberData' && option.data && option.data.action === 'availability') ||
            (option.name === 'coachBusinessCommand' && option.data && option.data.action === 'memberRead' && option.data.readAction === 'availability')) {
          if (readGate) await readGate               // ⛔ 卡住 ⇒ 读 Promise 不 resolve（模拟"云端还在读"）
          // ⭐ 真云端可用性投影**会返回 environment**（`readMyMemberData` 的 availabilityView 在 176 行带 environment）⇒
          //    缓存命中判定 `cachedAvailability` 依赖它，测试必须如实模拟，否则缓存永远不命中、P-1 测不出。
          return { result: Object.assign({}, state.availability || {}, { environment: memberRuntime.environment() }) }
        }
        if (option.name === 'coachBusinessCommand') {
          if (gate) await gate                      // ⛔ 卡住 ⇒ 提交 Promise 不 resolve（模拟"云端还在跑"）
          // ⭐ 允许"按第几次调用"返回不同结果 ⇒ 才能测 UNKNOWN 之后的幂等重放与最终裁决。
          const configured = state.coachResult
          const result = typeof configured === 'function'
            ? configured(state.calls.filter(call => call.name === 'coachBusinessCommand' && call.data && call.data.action === 'memberBooking').length, option)
            : (configured || { ok: true })
          return { result }
        }
        return { result: {} }
      }
    }
  }
  let captured = null
  global.Page = config => { captured = config }
  const full = require.resolve(path.join(ROOT, PAGE))
  delete require.cache[full]
  require(full)
  const page = Object.assign({}, captured, { data: JSON.parse(JSON.stringify(captured.data)) })
  // ⭐ 2026-10-04（H）：取消的二次确认已从 `wx.showModal` 换成**统一弹层** `member-sheet`
  //    （页面状态驱动，⛔ 不再走系统 modal）。⇒ 假 wx 的 `showModal` 自动应答**对它无效**了，
  //    `autoConfirm` 改为模拟"用户在弹层上按了确认取消"。
  //    ⚠️ 必须真的经过 `confirmCancel`（⛔ 不许在夹具里直接绕过页面把 Promise 判成 true：
  //    那样"弹层点了没反应"这类漂移实现会假绿）。
  // ⚠️ 真机上 `setData` 由框架注入，页面配置对象里**没有**它 ⇒ 这里自己提供一份最简实现。
  const rawSetData = function (patch) { Object.assign(this.data, patch) }
  page.setData = function (patch) {
    rawSetData.call(this, patch)
    if (options.autoConfirm && patch && patch.cancelOpen === true && typeof this.confirmCancel === 'function') {
      setImmediate(() => this.confirmCancel())
    }
  }
  page.rows = options.rows || []
  page.packagesById = view.packageNameIndex(options.packages || [])
  return {
    state, captured, page,
    writes: () => state.calls.filter(call => call.name === 'coachBusinessCommand' && call.data && call.data.action === 'memberBooking'),
    releaseCoach: () => { if (releaseGate) releaseGate() },
    releaseRead: () => { if (releaseRead) releaseRead() }
  }
}

// 把页面带到"详情已打开、当前是这一节"的状态（**不经过 load**，直接注入可信的一帧）。
function openDetailOn(ctx, row, packages = []) {
  const { page, captured } = ctx
  page.rows = ctx.rows || [row]
  page.packagesById = view.packageNameIndex(packages)
  captured.openDetail.call(page, { currentTarget: { dataset: { id: row.historyId } } })
  return page
}

// ⭐ 深拷贝：真云端返回的是**独立的**投影对象，客户端改本地行不会影响"服务器真相"。
//    不拷贝的话，乐观更新把 `ctx.rows[0]` 改了，会顺着同一引用污染 `state.availability.bookings`，
//    导致 ⑰（改期后回读应当还是服务器原值）误判。
const availabilityWith = (rows, busy = []) => ({ ok: true, availability: true, bookings: JSON.parse(JSON.stringify(rows)), packages: [], coaches: [], busy: JSON.parse(JSON.stringify(busy)), warnings: [] })

// ⭐ 推进一轮 microtask：让"已经调用但还没 await 完"的异步步骤往前走（例如取消的二次确认回调）。
const tick = () => new Promise(resolve => setImmediate(resolve))

async function main() {
  await runner('① 待上课的预约**有**「取消预约 / 修改时间」；终态一律没有', async () => {
    const booked = view.bookingView(bookingRow())
    assert.strictEqual(booked.status, 'booked')
    assert.strictEqual(booked.statusText, '待上课')
    assert.strictEqual(booked.canManage, true, '待上课必须可管理')
    assert.strictEqual(view.canManageOf({ status: 'done' }), false)
    assert.strictEqual(view.canManageOf({ status: 'cancelled' }), false)
    assert.strictEqual(view.canManageOf({ status: 'noshow' }), false)
    assert.strictEqual(view.canManageOf({}), false, '状态缺失 ⇒ 不许给按钮')
    assert.strictEqual(view.canManageOf(null), false)
  })

  await runner('② 已完成（done）不进待上课、不显示管理区', async () => {
    const split = view.splitBookings([bookingRow({ historyId: 'h-done', status: 'done' }), bookingRow()])
    assert.strictEqual(split.upcoming.length, 1)
    assert.strictEqual(split.history.length, 1)
    assert.strictEqual(split.history[0].canManage, false, '历史课不许出现取消/改期')
    assert.strictEqual(split.history[0].statusText, '已完成')
    // 管理动作本身也拒绝
    const request = manage.buildCancelRequest({ bookingViewId: 'h-done', ownViewIds: ['h-done'], row: bookingRow({ status: 'done' }) })
    assert.strictEqual(request.ok, false)
    assert.strictEqual(request.code, 'BOOKING_NOT_MANAGEABLE')
  })

  await runner('③ 已取消：显示「已取消」、进历史、不可再次取消', async () => {
    const cancelled = view.bookingView(bookingRow({ historyId: 'h-cx', status: 'cancelled' }))
    assert.strictEqual(cancelled.statusText, '已取消')
    assert.strictEqual(cancelled.canManage, false)
    const split = view.splitBookings([bookingRow({ historyId: 'h-cx', status: 'cancelled' })])
    assert.strictEqual(split.upcoming.length, 0)
    assert.strictEqual(split.history.length, 1, '已取消要看得见（不能凭空消失），但不给按钮')

    const request = manage.buildCancelRequest({ bookingViewId: 'h-cx', ownViewIds: ['h-cx'], row: bookingRow({ status: 'cancelled' }) })
    assert.strictEqual(request.ok, false)
    assert.strictEqual(request.code, 'BOOKING_ALREADY_CANCELLED', '已取消的课再次取消必须有专门的拒绝码')
    const reschedule = manage.buildRescheduleRequest({
      bookingViewId: 'h-cx', ownViewIds: ['h-cx'], row: bookingRow({ status: 'cancelled' }),
      dateKey: plus(5), slot: { start: 600, end: 660, available: true }, todayKey: TODAY
    })
    assert.strictEqual(reschedule.code, 'BOOKING_ALREADY_CANCELLED')
  })

  await runner('④ 改期日期范围**复用 30 天唯一常量**（客户端不写死 30）', async () => {
    assert.strictEqual(view.MEMBER_DATE_COUNT, MAX + 1)
    const dates = view.dateOptions(TODAY, view.MEMBER_DATE_COUNT)
    assert.strictEqual(dates.length, MAX + 1, `今天 + 未来 ${MAX} 天 = ${MAX + 1} 个选项`)
    assert.strictEqual(dates[0].key, TODAY)
    assert.strictEqual(dates[dates.length - 1].key, plus(MAX))
    assert.strictEqual(occupancy.memberBookingDateAllowed(dates[dates.length - 1].key, TODAY), 'ok', '最后一个选项必须真的能约')
    assert.ok(!dates.some(option => option.key === plus(MAX + 1)), `+${MAX + 1} 天不该出现在选项里`)

    const pageSource = stripComments(read(`${PAGE}.js`))
    assert.ok(/dateOptions\([^\n]*MEMBER_DATE_COUNT/.test(pageSource), '页面必须从 view.MEMBER_DATE_COUNT 取天数')
    assert.ok(!/dateOptions\([^\n]*\b30\b/.test(pageSource), '页面不许把天数写成 30')
    const manageSource = stripComments(read('utils/member-booking-manage.js'))
    assert.ok(!/\b30\b/.test(manageSource), 'manage 层也不许出现 30 这个数字')
  })

  await runner('⑤ 改期：今天可 / +30 天可 / +31 天拒 / 过去拒', async () => {
    const row = bookingRow()
    const slot = { start: 600, end: 660, available: true }
    const at = days => manage.buildRescheduleRequest({ bookingViewId: 'h1', ownViewIds: ['h1'], row, dateKey: plus(days), slot, todayKey: TODAY })
    assert.strictEqual(at(0).ok, true, '今天可以改')
    assert.strictEqual(at(MAX).ok, true, `第 ${MAX} 天可以改`)
    assert.strictEqual(at(MAX + 1).ok, false, `第 ${MAX + 1} 天必须拒`)
    assert.strictEqual(at(MAX + 1).code, 'MEMBER_BOOKING_BEYOND_WINDOW')
    assert.strictEqual(at(-1).ok, false, '过去必须拒')
    assert.strictEqual(at(-1).code, 'BOOKING_DATE_IN_PAST')
  })

  await runner('⑥ 23:00 开课 ⇒ 合法（最后一个开课时间；23:30 已取消）', async () => {
    const row = bookingRow()
    const request = manage.buildRescheduleRequest({
      bookingViewId: 'h1', ownViewIds: ['h1'], row, dateKey: plus(2),
      slot: { start: 23 * 60, end: 24 * 60, available: true }, todayKey: TODAY
    })
    assert.strictEqual(request.ok, true, '23:00 开课 ⇒ 合法')
    assert.strictEqual(request.payload.hour, 23)
    // ⭐ 用户点名要的最后一节：23:00 开课 + 60 ⇒ 24:00 结束，合法（正好卡在当天界上）
    const last = manage.buildRescheduleRequest({
      bookingViewId: 'h1', ownViewIds: ['h1'], row, dateKey: plus(2),
      slot: { start: 23 * 60, end: 24 * 60, available: true }, todayKey: TODAY
    })
    assert.strictEqual(last.ok, true, '23:00 是当天最后一个开课时间 ⇒ 必须能改过去')
    assert.strictEqual(last.payload.hour, 23)
    assert.strictEqual(last.payload.minute, 0)
    // ⛔ 23:30 这一档已取消 ⇒ 改期也不许改过去
    const halfPast = manage.buildRescheduleRequest({
      bookingViewId: 'h1', ownViewIds: ['h1'], row, dateKey: plus(2),
      slot: { start: 23 * 60 + 30, end: 24 * 60 + 30, available: true }, todayKey: TODAY
    })
    assert.strictEqual(halfPast.ok, false, '23:30 已取消 ⇒ 必须拒')
    assert.strictEqual(halfPast.code, 'BOOKING_START_TOO_LATE')
  })

  await runner('⑦ 晚于 23:00 开课 ⇒ 拒绝；早于 06:00 与不在半点上也拒', async () => {
    // ⛔ 本段原钉 2026-09-29 旧口径（"结束不得晚于 24:00"），已被 2026-10-01 用户最终规则取代。
    // ⭐ 2026-10-03 四次口径：最早开课 07:00 → **06:00** ⇒ "太早"的下界跟着常量走（06:30 现在必须放行）。
    const row = bookingRow()
    const at = start => manage.buildRescheduleRequest({
      bookingViewId: 'h1', ownViewIds: ['h1'], row, dateKey: plus(2),
      slot: { start, end: start + 60, available: true }, todayKey: TODAY
    })
    const tooLate = at(23 * 60 + 45)
    assert.strictEqual(tooLate.ok, false, '23:45 开课 ⇒ 晚于 23:00，必须拒')
    assert.strictEqual(tooLate.code, 'BOOKING_START_TOO_LATE')
    const tooEarly = at(5 * 60 + 30)
    assert.strictEqual(tooEarly.ok, false, '05:30 开课 ⇒ 早于 06:00，必须拒')
    assert.strictEqual(tooEarly.code, 'BOOKING_START_TOO_EARLY')
    // ⭐ 边界正例：06:00 恰好是下界 ⇒ 必须放行（否则"改早"与"改晚"两条规则不对称）
    assert.strictEqual(at(6 * 60).ok, true, '06:00 开课 ⇒ 正好在下界上，必须放行')
    assert.strictEqual(at(6 * 60 + 30).ok, true, '06:30 开课 ⇒ 新口径下必须放行（旧口径才拒）')
    const offGrid = at(8 * 60 + 15)
    assert.strictEqual(offGrid.ok, false, '08:15 不在 30 分钟网格上，必须拒')
    assert.strictEqual(offGrid.code, 'BOOKING_START_OFF_GRID')
    // ⛔ 已标不可选的格子：只可能是「已过时间」或「已排课」两种派生理由 ⇒ 不许退化成窗口码。
    const flagged = manage.buildRescheduleRequest({
      bookingViewId: 'h1', ownViewIds: ['h1'], row, dateKey: plus(2),
      slot: { start: 8 * 60 + 15, end: 9 * 60 + 15, available: false }, todayKey: TODAY
    })
    assert.strictEqual(flagged.code, 'BOOKING_TIME_CONFLICT')
  })

  await runner('⑧ 已占用的时间不可选（冲突必须拒，不能"先发出去让云端判"）', async () => {
    const row = bookingRow()
    const request = manage.buildRescheduleRequest({
      bookingViewId: 'h1', ownViewIds: ['h1'], row, dateKey: plus(4),
      slot: { start: 840, end: 900, available: false, reason: 'booked' }, todayKey: TODAY
    })
    assert.strictEqual(request.ok, false)
    assert.strictEqual(request.code, 'BOOKING_TIME_CONFLICT')
    // 页面点不可约的格子：给原因 + 不选中
    const ctx = buildPage({ availability: availabilityWith([bookingRow()], [{ coachKey: 'ck-1', start: 840, end: 900 }]) })
    const page = openDetailOn(ctx, bookingRow())
    await ctx.captured.openReschedule.call(page)
    const busy = page.data.rSlots.find(slot => slot.start === 840)
    assert.ok(busy && busy.available === false, '14:00 被占 ⇒ 不可选')
    ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: busy.key } } })
    assert.strictEqual(page.data.rSelected, null, '不可约的时段不许被选中')
    assert.strictEqual(ctx.state.toasts.length, 1, '必须说出原因，不能静默')
  })

  await runner('⑨ 改期时**忽略这一节自己的占用**（否则候选时间被自己锁死）', async () => {
    const row = bookingRow({ date: plus(3), hour: 10, minute: 0 })
    const other = bookingRow({ historyId: 'h2', date: plus(3), hour: 14, minute: 0 })
    const rows = [row, other]
    const withSelf = view.busyOf({ bookings: rows, coachBusy: [], dateKey: plus(3) })
    const withoutSelf = view.rescheduleBusyOf({ bookings: rows, coachBusy: [], dateKey: plus(3), excludeHistoryId: 'h1' })
    assert.deepEqual(withSelf, [{ start: 600, end: 660 }, { start: 840, end: 900 }])
    assert.deepEqual(withoutSelf, [{ start: 840, end: 900 }], '只摘掉这一节，别人的课一节都不放过')

    // ⭐ 真正的界面效果：自己的原时段重新可选
    const slots = view.slotsFor({ dateKey: plus(3), busy: withoutSelf, todayKey: '2000-01-01' })
    const own = slots.find(slot => slot.start === 600)
    assert.ok(own && own.available === true, '改期面板里「原来这个时间」必须还能选')
    const blocked = view.slotsFor({ dateKey: plus(3), busy: withSelf, todayKey: '2000-01-01' }).find(slot => slot.start === 600)
    assert.strictEqual(blocked.available, false, '（反证基线）不排除自己时它确实是被占的')
  })

  await runner('⑩ 不能操作**其他会员**的预约（名单外的 ID 明确拒绝）', async () => {
    const request = manage.buildCancelRequest({ bookingViewId: 'h-other', ownViewIds: ['h1'], row: null })
    assert.strictEqual(request.ok, false)
    assert.strictEqual(request.code, 'BOOKING_NOT_MINE')
    const reschedule = manage.buildRescheduleRequest({
      bookingViewId: 'h-other', ownViewIds: ['h1'], row: null,
      dateKey: plus(2), slot: { start: 600, end: 660, available: true }, todayKey: TODAY
    })
    assert.strictEqual(reschedule.code, 'BOOKING_NOT_MINE')
  })

  await runner('⑪ bookingId 被篡改（空 / 改一位 / 换类型）⇒ 明确拒绝，不发出请求', async () => {
    assert.strictEqual(manage.buildCancelRequest({ bookingViewId: '', ownViewIds: ['h1'] }).code, 'INVALID_PAYLOAD')
    assert.strictEqual(manage.buildCancelRequest({ bookingViewId: 'h2', ownViewIds: ['h1'] }).code, 'BOOKING_NOT_MINE')
    assert.strictEqual(manage.buildCancelRequest({ bookingViewId: null, ownViewIds: ['h1'] }).code, 'INVALID_PAYLOAD')
    assert.strictEqual(manage.buildCancelRequest({ bookingViewId: { a: 1 }, ownViewIds: ['h1'] }).code, 'INVALID_PAYLOAD')
    // 真页面：把当前这节换成一个不在名单里的 ID ⇒ 拒绝 + 零写入
    const ctx = buildPage({ availability: availabilityWith([bookingRow()]) })
    const page = openDetailOn(ctx, bookingRow())
    page.current = bookingRow({ historyId: 'h-forged' })
    ctx.captured.requestCancel.call(page)
    assert.deepEqual(ctx.writes(), [], '越权请求不许出网')
    assert.strictEqual(ctx.state.toasts.length, 1, '必须明说拒绝')
  })

  await runner('⑫ 缺字段一律显示「未记录」（不许用今天补日期、不许用 60 分钟冒充时长）', async () => {
    const bare = view.bookingView({ historyId: 'x', status: 'booked' })
    assert.strictEqual(bare.dateText, UNRECORDED)
    assert.strictEqual(bare.startText, UNRECORDED)
    assert.strictEqual(bare.endText, UNRECORDED)
    assert.strictEqual(bare.durationText, UNRECORDED, '缺时长必须显示未记录，不许按 60 补')
    assert.strictEqual(bare.packageText, UNRECORDED, '缺课包必须显示未记录')
    assert.strictEqual(bare.coachName, UNRECORDED)
    assert.strictEqual(bare.typeText, UNRECORDED)
    // 有 packageViewId 但对不上课包名单 ⇒ 仍然是「未记录」（不许拿第一个课包顶替）
    const unknown = view.bookingView({ historyId: 'x', status: 'booked', packageViewId: 'pv-unknown' }, { 'pv-1': '力量训练' })
    assert.strictEqual(unknown.packageText, UNRECORDED)
    const known = view.bookingView({ historyId: 'x', status: 'booked', packageViewId: 'pv-1' }, { 'pv-1': '力量训练' })
    assert.strictEqual(known.packageText, '力量训练')
  })

  await runner('⑬ 点「取消预约」：先二次确认（此之前零写）；确认后**恰好一次** cancelMemberBooking', async () => {
    // A 段：不回答确认框 ⇒ 一次写调用都不许发（点一下就把课取消了是事故）
    const pending = buildPage({ availability: availabilityWith([bookingRow()]) })
    const pendingPage = openDetailOn(pending, bookingRow())
    pending.captured.requestCancel.call(pendingPage)
    assert.deepEqual(pending.writes(), [], `二次确认之前不得发写调用（实测 ${pending.writes().length} 次）`)
    // ⭐ 2026-10-04（H）：确认框从系统 modal 变成**统一弹层** `member-sheet`（danger 红色主按钮）。
    //    契约没变 ——「用户明确按下确认之前，一次云调用都不许发」仍然是这一段要钉的东西；
    //    变的只是"确认这件事由谁承载"。
    assert.strictEqual(pendingPage.data.cancelOpen, true, '必须先弹出二次确认弹层')
    assert.ok(String(pendingPage.data.cancelDesc || '').length > 0, '确认弹层必须有文案')
    // ⛔ 文案必须说清**真实后果**（按六条规则：取消只释放占座，课时不减少、不计违约），
    //    ⛔ 也不许用"物理删除/级联/软删"这类技术术语糊弄用户。
    assert.ok(/不会减少/.test(pendingPage.data.cancelDesc), '必须说明课时不会减少（否则用户以为课时被扣了）')
    assert.ok(!/物理删除|级联|软删|硬删/.test(pendingPage.data.cancelDesc), '⛔ 确认文案不许用技术术语掩盖真实行为')
    assert.ok(pendingPage.data.detail, '确认之前详情要留着（保留用户当前位置）')
    assert.deepEqual(pending.state.toasts, [], '不许用 toast 伪装成功')
    // ⛔ 走"再想想"这条出口 ⇒ 同样零写调用，且弹层必须收起
    //   （member-sheet 只派发事件、**不自己隐藏** ⇒ 收起必须由页面做，否则用户被关在弹层里）。
    pending.captured.closeCancel.call(pendingPage)
    assert.deepEqual(pending.writes(), [], '点「再想想」不许发写调用')
    assert.strictEqual(pendingPage.data.cancelOpen, false, '⛔ 取消之后必须由页面把弹层收起')

    // B 段：点「确认取消」⇒ 恰好一次云端调用，命令与 payload 都必须正确
    const ctx = buildPage({ availability: availabilityWith([bookingRow()]), autoConfirm: true })
    const page = openDetailOn(ctx, bookingRow())
    await ctx.captured.requestCancel.call(page)
    const writes = ctx.writes()
    assert.strictEqual(writes.length, 1, `确认后必须**恰好一次**云端调用（实测 ${writes.length}）`)
    assert.strictEqual(writes[0].data.action, 'memberBooking', '必须走会员窄通道，不是教练命令入口')
    assert.strictEqual(writes[0].data.command, 'cancelMemberBooking')
    assert.deepEqual(Object.keys(writes[0].data.payload).sort(), ['bookingViewId'], '取消只许提交一个视图 ID')
    assert.deepEqual(manage.identityKeysIn({ payload: writes[0].data.payload }), [], '⛔ 不许带任何身份 / 定位字段')
    // 绕过页面直接调 runtime ⇒ 同样真的写（证明锁开着时通道是通的）
    // ⚠️ 只数 `coachBusinessCommand`（`submitMemberManage` 成功后会顺手回读一次，
    //    把回读也算进来会数成 2 —— 那是**读**，不是第二次写）。
    const runtime = require('../utils/member-runtime')
    const request = manage.buildCancelRequest({ bookingViewId: 'h1', ownViewIds: ['h1'], row: bookingRow() })
    const before = ctx.writes().length
    const direct = await runtime.submitMemberManage(request)
    assert.strictEqual(direct.ok, true, '两道锁都开着 ⇒ 直接调也必须真的写')
    assert.strictEqual(ctx.writes().length, before + 1, '恰好一次**写**调用（回读不计）')
  })

  await runner('⑭ 改期点选即提交：**恰好一次** rescheduleMemberBooking（无「确认修改」按钮）', async () => {
    const ctx = buildPage({ availability: availabilityWith([bookingRow()], [{ coachKey: 'ck-1', start: 840, end: 900 }]) })
    const page = openDetailOn(ctx, bookingRow())
    await ctx.captured.openReschedule.call(page)
    assert.strictEqual(page.data.rescheduleOpen, true)
    assert.ok(page.data.rDates.length === MAX + 1, '日期选项必须只有今天…+30 天')
    const free = page.data.rSlots.find(slot => slot.available)
    assert.ok(free, '应当至少有一个可约时段')

    const before = ctx.writes().length
    // ⭐ 点选即可约时间 ⇒ 直接提交（pickRescheduleSlot 内部调 confirmReschedule）。
    //   ⛔ P-2 第二轮：选中是**瞬时的** —— 首帧就改列表 + 收起面板，`rSelected` 随即清空 ⇒
    //     这里改验"首帧已经提交 + 面板已收起"（这才是"点选即提交、没有第二个确认按钮"的证据）。
    const pick = ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: free.key } } })
    assert.strictEqual(page.data.rescheduleOpen, false, '点选即提交 ⇒ 首帧就收起改期面板（没有第二个「确认修改」按钮）')
    assert.strictEqual(ctx.writes().length, before + 1, '点选即提交 ⇒ 首帧（云端返回前）就已经发出写调用')
    await pick
    const writes = ctx.writes()
    assert.strictEqual(writes.length, before + 1, `点选即提交必须**恰好一次**写调用（实测多出 ${writes.length - before} 次）`)
    const call = writes[writes.length - 1]
    assert.strictEqual(call.data.action, 'memberBooking')
    assert.strictEqual(call.data.command, 'rescheduleMemberBooking')
    assert.deepEqual(Object.keys(call.data.payload).sort(), ['bookingViewId', 'date', 'hour', 'minute'].sort())
    assert.deepEqual(manage.identityKeysIn({ payload: call.data.payload }), [], '⛔ 不许带任何身份 / 定位字段')
  })

  await runner('⑮ 源码与提示里都**不许出现**「取消成功 / 修改成功」这类假成功', async () => {
    // ⚠️ 注释里会**引用**这些词（"不许出现取消成功"）⇒ 必须先剥注释再比对，否则是假红。
    const pageSource = stripComments(read(`${PAGE}.js`))
    manage.FORBIDDEN_SUCCESS_WORDS.forEach(word => {
      assert.ok(!pageSource.includes(word), `页面源码里不许出现「${word}」`)
    })
    const wxml = read(`${PAGE}.wxml`)
    manage.FORBIDDEN_SUCCESS_WORDS.forEach(word => {
      assert.ok(!wxml.includes(word), `wxml 里不许出现「${word}」`)
    })
    // ⭐ 2026-10-02 补的缺口：**提示常量本身**也要扫。
    //    ⛔ 原来的 ⑮ 只扫页面源码 / wxml / 运行期弹窗 ⇒ 只要页面改成直接引用 `manage.CANCEL_NOTICE`，
    //       "假成功"文案就能从常量里漏出来而 ⑮ 全绿（反证 `_m3-p4` ⑬ 当时就是这个形状：假绿）。
    //       ⇒ 直接把常量值拿出来比对，这一层与页面写法无关。
    const notices = [manage.CANCEL_NOTICE, manage.RESCHEDULE_NOTICE, manage.NOTICE_TITLE].filter(Boolean)
    manage.FORBIDDEN_SUCCESS_WORDS.forEach(word => {
      notices.forEach(text => {
        assert.ok(!String(text).includes(word), `提示常量里不许出现「${word}」（实测：${text}）`)
      })
    })
    // 运行期：取消与改期弹出来的话里也不许有
    const ctx = buildPage({ availability: availabilityWith([bookingRow()]) })
    const page = openDetailOn(ctx, bookingRow())
    ctx.captured.requestCancel.call(page)
    await ctx.captured.openReschedule.call(page)
    const free = page.data.rSlots.find(slot => slot.available)
    ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: free.key } } })
    const texts = ctx.state.modals.map(modal => `${modal.title || ''}${modal.content || ''}`).join('|')
    manage.FORBIDDEN_SUCCESS_WORDS.forEach(word => {
      assert.ok(!texts.includes(word), `提示里不许出现「${word}」`)
    })
  })

  await runner('⑯ 页面 wxml 里的每个 bindtap 都有**真实 handler**（点了不能没反应）', async () => {
    let captured = null
    global.Page = config => { captured = config }
    const full = require.resolve(path.join(ROOT, PAGE))
    delete require.cache[full]
    require(full)
    const wxml = read(`${PAGE}.wxml`)
    const taps = [...new Set([...wxml.matchAll(/bindtap="([A-Za-z_][\w]*)"/g)].map(match => match[1]))]
    const missing = taps.filter(name => typeof captured[name] !== 'function')
    assert.deepEqual(missing, [], `这些按钮点了没反应：${missing.join('、')}`)
    // 本轮新增的几个必须在
    ;['openReschedule', 'pickRescheduleDate', 'pickRescheduleSlot', 'confirmReschedule', 'closeReschedule', 'requestCancel']
      .forEach(name => assert.strictEqual(typeof captured[name], 'function', `缺少 ${name}`))
    // ⭐ 2026-10-04（H）：本页三处弹层里，**改期**与**取消二次确认**已换成 `member-sheet`，
    //    只剩「预约详情」是自建的（信息展示型，理由见 wxml 注释）。
    // ⇒ 这里要钉的契约是"**每一个弹层都要挡滚动穿透**"，而不是"必须有 N 块自建遮罩"：
    //    自建的那块自己带 catchtouchmove，用组件的那两块由组件统一负责。
    const ownMasks = wxml.match(/class="[^"]*mask"/g) || []
    assert.strictEqual((wxml.match(/catchtouchmove="noop"/g) || []).length, ownMasks.length,
      '每个**自建**弹层都要挡滚动穿透')
    const sheetUses = (wxml.match(/<member-sheet/g) || []).length
    assert.ok(sheetUses >= 2, `改期与取消二次确认必须都用 member-sheet（实测 ${sheetUses} 处）`)
    // ⛔ 取消是危险操作：确认按钮必须走 `danger`（红），⛔ 不许与「改期」用同一个中性按钮。
    const cancelSheet = wxml.slice(wxml.indexOf('bindconfirm="confirmCancel"') - 800)
    assert.ok(/danger/.test(cancelSheet.slice(0, 800)), '取消预约的弹层必须声明 danger（危险层级）')
  })

  await runner('⑰ 改期流程走完再回到页面，**原预约仍然在**（日期时间一个字都没变）', async () => {
    const row = bookingRow()
    const ctx = buildPage({ availability: availabilityWith([row]) })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    const before = { date: page.data.detail.dateText, time: page.data.detail.timeText }
    await ctx.captured.openReschedule.call(page)
    const free = page.data.rSlots.find(slot => slot.available)
    await ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: free.key } } })
    ctx.captured.closeReschedule.call(page)

    // ⭐ 模拟"返回页面"：重新走一遍 onShow ⇒ load()
    await page.load()
    assert.strictEqual(page.data.upcoming.length, 1, '原预约不许消失')
    assert.strictEqual(page.data.upcoming[0].dateText, before.date)
    assert.strictEqual(page.data.upcoming[0].timeText, before.time)
    assert.strictEqual(page.rows[0].date, row.date, '内存里的原始行不许被改')
    assert.strictEqual(page.rows[0].hour, 10)
  })

  await runner('⑱ M3-P3 的创建链**不受影响**（创建总闸仍开、policy 仍 direct、窄通道仍是闭集）', async () => {
    assert.strictEqual(flags.memberBookingSubmitEnabled(), true, '创建链总闸必须保持打开')
    assert.strictEqual(cloudMemberBooking.currentPolicy(), 'direct')
    // ⭐ P6 把会员命令白名单从 1 条扩到 **3 条**（创建 + 取消 + 改期）—— 这是**本轮的有意变化**。
    //    ⛔ 仍然是**闭集**：多出第四条就要在这里变红（不许被悄悄加宽）。
    assert.deepStrictEqual([...cloudMemberBooking.MEMBER_COMMANDS],
      ['createMemberBooking', 'cancelMemberBooking', 'rescheduleMemberBooking'], '窄通道恰好这三条，一条不多')
    const built = requestBuilder.buildBookingRequest({
      dateKey: plus(3), slot: { start: 600, end: 660 },
      coachKey: 'ck-1', packageViewId: 'pv-1', nonce: 'abc'
    })
    assert.strictEqual(built.ok, true, '创建预约的请求构造必须照旧可用')
    assert.strictEqual(built.command, 'createMemberBooking')
    assert.deepEqual(requestBuilder.identityKeysIn(built), [])
  })

  await runner('⑲ 六条产品规则**已定稿**，但**扩展点机制仍在**（撤回一条 ⇒ 立刻重新锁上）', async () => {
    assert.strictEqual(manage.POLICY_POINTS.length, 6)
    assert.deepEqual(manage.openPolicyPoints(), [], '六条都已定 ⇒ 没有未定点')
    assert.strictEqual(manage.policyBlocked(), false)
    // ⛔ 撤回一条 ⇒ 立刻重新锁上（fail closed 机制不许被拆掉：紧急回滚就靠它）
    manage.setPolicyValue('CANCEL_DEADLINE_MINUTES', undefined)
    assert.strictEqual(manage.policyBlocked(), true, '撤回一条必须重新阻塞')
    assert.deepEqual(manage.openPolicyPoints(), ['CANCEL_DEADLINE_MINUTES'])
    manage.resetPolicy()
    assert.strictEqual(manage.policyBlocked(), false, '测试结束必须回到"全部已定"')
    assert.deepEqual(manage.openPolicyPoints(), [])
  })

  await runner('⑳ 两道锁**仍然在**：规则被撤回 / 总闸被关 ⇒ 任一为真即零云调用（回滚路径）', async () => {
    const runtime = require('../utils/member-runtime')
    const request = manage.buildCancelRequest({ bookingViewId: 'h1', ownViewIds: ['h1'], row: bookingRow() })
    const ctx = buildPage({ availability: availabilityWith([bookingRow()]) })

    // 组合 A：总闸开着，但**规则被撤回** ⇒ 零云调用
    manage.setPolicyValue('CANCEL_RELEASES_RESERVED', undefined)
    try {
      assert.strictEqual(manage.policyBlocked(), true)
      const before = ctx.state.calls.length
      const result = await runtime.submitMemberManage(request)
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.code, 'MEMBER_MANAGE_POLICY_NOT_SELECTED')
      assert.strictEqual(ctx.state.calls.length, before, '规则没定 ⇒ 零云调用')
    } finally { manage.resetPolicy() }

    // 组合 B：规则全定，但**总闸关** ⇒ 零云调用（回滚只需改这一处）
    const original = flags.memberManageSubmitEnabled
    flags.memberManageSubmitEnabled = () => false
    try {
      const before = ctx.state.calls.length
      const result = await runtime.submitMemberManage(request)
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.code, 'MEMBER_MANAGE_SUBMIT_DISABLED')
      assert.strictEqual(ctx.state.calls.length, before, '总闸关 ⇒ 零云调用')
    } finally { flags.memberManageSubmitEnabled = original }

    // 组合 C：两道都开 ⇒ **真的发**（证明上面两条不是"因为永远发不出去所以零调用"）
    const before = ctx.writes().length
    const sent = await runtime.submitMemberManage(request)
    assert.strictEqual(sent.ok, true, '两道都开时必须真的写')
    assert.strictEqual(ctx.writes().length, before + 1, '恰好一次**写**调用（回读不计）')
    assert.strictEqual(manage.policyBlocked(), false, '必须回到全部已定')
  })

  await runner('㉑ 请求只含白名单键、且**不含任何身份/定位字段**', async () => {
    const row = bookingRow()
    const cancel = manage.buildCancelRequest({ bookingViewId: 'h1', ownViewIds: ['h1'], row })
    assert.deepEqual(Object.keys(cancel.payload).sort(), [...manage.CANCEL_PAYLOAD_KEYS].sort())
    assert.deepEqual(manage.extraKeysIn(manage.CANCEL_COMMAND, cancel.payload), [])
    assert.deepEqual(manage.identityKeysIn(cancel), [])

    const reschedule = manage.buildRescheduleRequest({
      bookingViewId: 'h1', ownViewIds: ['h1'], row, dateKey: plus(2),
      slot: { start: 600, end: 660, available: true }, todayKey: TODAY
    })
    assert.deepEqual(Object.keys(reschedule.payload).sort(), [...manage.RESCHEDULE_PAYLOAD_KEYS].sort())
    assert.deepEqual(manage.extraKeysIn(manage.RESCHEDULE_COMMAND, reschedule.payload), [])
    assert.deepEqual(manage.identityKeysIn(reschedule), [])
    // 混进身份字段 ⇒ 认得出来
    assert.ok(manage.extraKeysIn(manage.CANCEL_COMMAND, { bookingViewId: 'h1', studentId: 's-1' }).includes('studentId'))
    assert.ok(manage.identityKeysIn({ payload: { bookingViewId: 'h1', memberId: 'm-1' } }).includes('payload.memberId'))
  })

  await runner('㉒ 幂等：连点两次同一个号；改了参数 ⇒ 新号（不会错误 replay）', async () => {
    const row = bookingRow()
    const nonce = 'n-once'
    const first = manage.buildCancelRequest({ bookingViewId: 'h1', ownViewIds: ['h1'], row, nonce })
    const second = manage.buildCancelRequest({ bookingViewId: 'h1', ownViewIds: ['h1'], row, nonce })
    assert.strictEqual(first.requestId, second.requestId, '同一会话连点两次必须是同一个幂等号')

    const moved = manage.buildRescheduleRequest({
      bookingViewId: 'h1', ownViewIds: ['h1'], row, dateKey: plus(2),
      slot: { start: 600, end: 660, available: true }, todayKey: TODAY, nonce
    })
    const movedAgain = manage.buildRescheduleRequest({
      bookingViewId: 'h1', ownViewIds: ['h1'], row, dateKey: plus(2),
      slot: { start: 720, end: 780, available: true }, todayKey: TODAY, nonce
    })
    assert.notStrictEqual(moved.requestId, movedAgain.requestId, '换了时间 ⇒ 必须是新的请求身份')
    const otherBooking = manage.buildCancelRequest({ bookingViewId: 'h2', ownViewIds: ['h1', 'h2'], row, nonce })
    assert.notStrictEqual(otherBooking.requestId, first.requestId, '换了预约 ⇒ 必须是新的请求身份')
    assert.ok(moved.requestId.startsWith('mbm_'), '管理动作的号与创建（mbk_）分开命名空间')
  })

  await runner('㉓ 已取消的课**不再占用时间**（否则空档被白白锁死）', async () => {
    const date = plus(3)
    const rows = [
      bookingRow({ historyId: 'h-keep', date, hour: 10, minute: 0 }),
      bookingRow({ historyId: 'h-cx', date, hour: 14, minute: 0, status: 'cancelled' })
    ]
    const busy = view.busyOf({ bookings: rows, coachBusy: [], dateKey: date })
    assert.deepEqual(busy, [{ start: 600, end: 660 }], '已取消的 14:00 不该再占时间')
  })

  await runner('㉔ 静态契约：管理区的按钮只挂在「可管理」分支里，历史课永不渲染', async () => {
    const wxml = read(`${PAGE}.wxml`)
    assert.ok(wxml.includes('wx:if="{{detail.canManage}}"'), '取消/改期按钮必须整体挂在 canManage 分支内')
    const manageBlock = wxml.slice(wxml.indexOf('wx:if="{{detail.canManage}}"'))
    assert.ok(manageBlock.includes('bindtap="requestCancel"') && manageBlock.includes('bindtap="openReschedule"'))
    const beforeBlock = wxml.slice(0, wxml.indexOf('wx:if="{{detail.canManage}}"'))
    assert.ok(!beforeBlock.includes('bindtap="requestCancel"'), '别处不许再挂一个取消按钮')
    // 详情里把「使用课包」显示出来
    assert.ok(wxml.includes('使用课包'), '详情必须显示使用的课包')
    // UI 底线：文字块 min-width:0 + 可换行 + 字号 ≥21rpx + 格子高度 ≥88rpx
    const wxss = read(`${PAGE}.wxss`)
    assert.ok(/\.booking-manage-btn\{[^}]*min-width:0/.test(wxss), '管理按钮必须 min-width:0（长文案不炸版）')
    // ⛔ 旧写法 `/min-height:1\d\drpx/` 把"三位数高度"当成了契约本身 ⇒ 2026-10-01 把格子收到 90rpx 时它误红。
    //    真正的契约是**下限**（手指点得到），不是位数。
    const cellFloor = Number((wxss.match(/\.reschedule-cell\{[^}]*min-height:(\d+)rpx/) || [])[1] || 0)
    assert.ok(cellFloor >= 88, `时段格子最小高度 ${cellFloor}rpx 必须 ≥88rpx（手指点得到）`)
    const sizes = [...wxss.matchAll(/font-size:(\d+)rpx/g)].map(match => Number(match[1]))
    assert.ok(sizes.length && Math.min(...sizes) >= 21, `字号不得小于 21rpx（实测最小 ${Math.min(...sizes)}）`)
    // ⭐ 2026-10-04（H）：改期面板的遮罩/面板外壳已交给 `member-sheet` ⇒ 层级由组件的
    //    `.member-sheet-mask{z-index:60}` 统一提供（原先是本页 `.reschedule-mask{z-index:40}`）。
    //    这里钉的是**层级必须存在且够高**（改期要盖在详情弹层之上），到哪一行找随架构走。
    const sheetWxss = read('components/member-sheet/member-sheet.wxss')
    const sheetZ = Number((sheetWxss.match(/\.member-sheet-mask\{[^}]*z-index:(\d+)/) || [])[1] || 0)
    const ownZ = Number((wxss.match(/\.booking-detail-mask\{[^}]*z-index:(\d+)/) || [])[1] || 0)
    assert.ok(sheetZ > 0, '统一弹层必须声明 z-index（否则会被页面内容盖住）')
    assert.ok(sheetZ > ownZ, `改期弹层层级(${sheetZ}) 必须高于详情弹层(${ownZ})`)
  })

  await runner('㉕ UI 工程：长文本 / 窄屏 / 状态齐全 / 点击区域（不新增设计规范，只做底线检查）', async () => {
    const wxml = read(`${PAGE}.wxml`)
    const wxss = read(`${PAGE}.wxss`)

    // ① 长教练名 / 长课程名 / 长课包名：**一个字都不许截断**（截断就是"看起来是另一个人"）
    const long = '超长教练名字测试一二三四五六七八九十甲乙丙丁'
    const longPkg = '超长课程包名称测试一二三四五六七八九十'
    const row = bookingRow({ coach: { coachKey: 'ck-1', displayName: long }, typeName: longPkg })
    const shown = view.bookingView(row, { 'pv-1': longPkg })
    assert.strictEqual(shown.coachName, long, '教练名不许被截断')
    assert.strictEqual(shown.typeText, longPkg)
    assert.strictEqual(shown.packageText, longPkg)

    // ② 窄屏（320/375/390/414）：rpx 是等比的 ⇒ 真正的变量是"文字块会不会被压成一字一行"。
    //    只有 **flex 容器的文字子项** 需要 `min-width:0`（块级元素本来就会换行）⇒ 只钉这三类。
    const flexTextBlocks = ['booking-copy', 'booking-manage-btn', 'booking-detail-value']
    flexTextBlocks.forEach(name => {
      const rule = new RegExp(`\\.${name}\\{[^}]*min-width:0`)
      assert.ok(rule.test(wxss), `.${name} 是 flex 子项，必须 min-width:0（否则中文被压成一字一行）`)
    })
    // 长文案块（块级）需要的是可换行，不是 min-width
    assert.ok(/\.booking-manage-note\{[^}]*overflow-wrap:break-word/.test(wxss), '说明文字要允许换行')
    assert.ok(/\.reschedule-picked\{[^}]*overflow-wrap:break-word/.test(wxss), '选中的新时间要允许换行')
    assert.ok(/\.reschedule-date\{[^}]*flex:0 0 auto/.test(wxss), '日期格子不许被压缩（否则窄屏上日期挤成一团）')

    // ③ 时段格子的 750rpx 预算：两侧留白 + 间距之后仍要够宽。
    //    ⭐ 列数改为**跨页契约**：改期面板必须与约课页 `.slot-grid` 同一套排版。
    //      （2026-10-01 实测踩到：§134 只把约课页改成 4 栏，改期面板仍是 3 栏 112rpx，
    //       而旧断言写死"必须三栏" ⇒ 契约自己把漂移钉成了"正确"。改成两页比对，任一侧单独改都会红。）
    // ⭐ 2026-10-02 三态时段卡片**单源化**：`.slot-grid` 已从 member-book-slots.wxss 移到
    //    唯一样式源 styles/slots.wxss。跨页契约不变（改期面板必须与约课页同一套排版），
    //    但"约课页几栏"现在必须**从唯一来源读**——这样两页比对才是真的比对。
    const slotsWxss = read('styles/slots.wxss')
    const colsOf = css => Number((css.match(/repeat\((\d+),\s*1fr\)/) || [])[1] || 0)
    const bookGrid = (slotsWxss.match(/\.slot-grid\{[^}]*\}/) || [])[0]
    assert.ok(bookGrid, 'styles/slots.wxss 必须定义 .slot-grid（三态时段卡片唯一样式源）')
    const bookCols = colsOf(bookGrid)
    const grid = wxss.match(/\.reschedule-grid\{[^}]*\}/)[0]
    const reschCols = colsOf(grid)
    assert.ok(bookCols >= 4 && reschCols === bookCols, `改期面板 ${reschCols} 栏 / 约课页 ${bookCols} 栏 ⇒ 两页必须同一套排版`)
    const gap = Number((grid.match(/gap:(\d+)rpx/) || [])[1] || 0)
    // ⚠️ 2026-10-04（H）：面板左右留白已随外壳一起交给 `member-sheet`（`.member-sheet-body` 的
    //    `padding:8rpx 32rpx 0`）⇒ 窄屏预算必须从**组件**读，不是从本页的 `.reschedule-panel` 读
    //    （那个类名连同它的遮罩已经删掉了）。留白变大 ⇒ 每格更窄 ⇒ 这里才是真的会红。
    const sheetWxss2 = read('components/member-sheet/member-sheet.wxss')
    const bodyPad = (sheetWxss2.match(/\.member-sheet-body\{[^}]*padding:([^;}]+)/) || [])[1] || ''
    const padSide = Number((bodyPad.match(/(\d+)rpx\s+\d+rpx\s+0/) || [])[1] || 0)
    assert.ok(padSide > 0, `统一弹层内容区必须声明左右留白（实测 padding:${bodyPad}）`)
    const cellWidth = (750 - padSide * 2 - gap * (reschCols - 1)) / reschCols
    assert.ok(cellWidth >= 150, `窄屏时段格子只剩 ${cellWidth.toFixed(0)}rpx，太窄了`)

    // ④ 点击区域：时段格子与管理按钮都要够大（手指点得到）
    const cellHeight = Number((wxss.match(/\.reschedule-cell\{[^}]*min-height:(\d+)rpx/) || [])[1] || 0)
    assert.ok(cellHeight >= 88, `时段格子最小高度 ${cellHeight}rpx < 88rpx`)
    const btnHeight = Number((wxss.match(/\.booking-manage-btn\{[^}]*line-height:(\d+)rpx/) || [])[1] || 0)
    assert.ok(btnHeight >= 72, `管理按钮高度 ${btnHeight}rpx 太小`)

    // ⑤ 三种状态都得有话说：loading / 空 / 错误
    assert.ok(wxml.includes('正在读取'), '必须有 loading 文案')
    assert.ok(wxml.includes('还没有待上课的预约'), '必须有空状态文案')
    assert.ok(wxml.includes('{{error}}'), '必须有错误状态')
    assert.ok(wxml.includes('这一天没有可约时间'), '改期面板也要有空状态')
  })

  await runner('㉖ 改期面板切日期**真的生效**（dateIndex 是唯一真相源，BUG05 的形状）', async () => {
    const row = bookingRow({ date: plus(1) })
    const busy = [{ coachKey: 'ck-1', start: 600, end: 660 }]
    const ctx = buildPage({ availability: availabilityWith([row], busy) })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    await ctx.captured.openReschedule.call(page)

    const firstKey = page.data.rDateKey
    const target = page.data.rDates[5]
    await ctx.captured.pickRescheduleDate.call(page, { currentTarget: { dataset: { index: 5 } } })
    assert.strictEqual(page.data.rIndex, 5)
    assert.strictEqual(page.data.rDateKey, target.key, '显示的日期必须跟着 index 变（不许留第二份"当前日期"）')
    assert.notStrictEqual(page.data.rDateKey, firstKey)
    assert.strictEqual(page.data.rSelected, null, '换日期要清掉上一次选的时段')

    // ⭐ 越界 / 非法 index 直接忽略，不许把状态改坏
    await ctx.captured.pickRescheduleDate.call(page, { currentTarget: { dataset: { index: 999 } } })
    assert.strictEqual(page.data.rIndex, 5, '越界 index 必须被忽略')
    await ctx.captured.pickRescheduleDate.call(page, { currentTarget: { dataset: { index: -1 } } })
    assert.strictEqual(page.data.rIndex, 5)
  })

  // ★★ 本轮（2026-09-30 晚）新增：P-1 缓存优先 / P-2 乐观更新 的永久回归测试（含判别力） ★★
  //   判别力证明方式：临时把 `loadRescheduleSlots` 改回"先 await 再渲染"、或把 `runManage` 的乐观更新删掉，
  //   这两条测试会立刻变红（本文件末尾的临时实验已验证），说明它们不是测空气。
  await runner('P-1 缓存优先：命中缓存时可选时段**同步**渲染、不转圈、弱网下也用缓存（不假"全天有空"）', async () => {
    const row = bookingRow({ date: plus(1) })
    const ctx = buildPage({ availability: availabilityWith([row], []) })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    await ctx.captured.openReschedule.call(page)        // 首次冷调用：把 plus(1) 写进缓存
    assert.ok(page.data.rSlots.length > 0, '首次打开应有可选时段')
    // ⭐ 把可选时段清空，并让"网络"返回空（模拟弱网 / 退化）
    page.setData({ rSlots: [] })
    ctx.state.availability = null
    // ⭐ 再次 loadRescheduleSlots：plus(1) 缓存已热（20s 内）⇒ 同步即从缓存渲染
    const promise = ctx.captured.loadRescheduleSlots.call(page)
    assert.ok(page.data.rSlots.length > 0, '命中缓存 ⇒ 同步渲染，不等网络（弱网下也能立刻出时段）')
    assert.strictEqual(page.data.rLoading, false, '命中缓存 ⇒ 不转圈')
    await promise
    assert.ok(page.data.rSlots.length > 0, '弱网 / 退化下仍用缓存填充时段（绝不假"全天有空"）')
  })

  // ★★ P-2 第二轮（2026-10-01）· Local-first 契约 ★★
  //   ⛔ 判别力：把首帧的乐观更新挪回 `await` 之后（改回旧的 Optimistic-after-cloud）⇒ ①② 必须变红；
  //      把回滚换成"不回滚"或把快照改成**引用赋值** ⇒ ③④⑤⑦ 必须变红；拆掉 `managing` 锁 ⇒ ⑧ 必须变红。
  // 把页面带到"改期面板已打开、已切到目标日期"，返回第一个可约时段。
  async function freeSlotOn(ctx, page, dateKey) {
    await ctx.captured.openReschedule.call(page)
    const target = page.data.rDates.find(d => d.key === dateKey)
    if (target && Number.isInteger(target.index)) {
      await ctx.captured.pickRescheduleDate.call(page, { currentTarget: { dataset: { index: target.index } } })
    }
    return page.data.rSlots.find(slot => slot.available) || null
  }

  await runner('P-2① 首帧 Local-first：云端**还没返回**，列表已是新时间 + 面板已收起 + 无阻塞 loading', async () => {
    const row = bookingRow({ date: plus(1), hour: 10, minute: 0 })
    const ctx = buildPage({ availability: availabilityWith([row], []), holdCoach: true })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    const free = await freeSlotOn(ctx, page, plus(2))
    assert.ok(free, '应当有可约时段')
    // ⭐ **不 await**：云端被卡住，模拟"请求还在飞"
    const pending = ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: free.key } } })
    assert.strictEqual(ctx.writes().length, 1, '写调用已发出（恰好一次）')
    // ⛔ 关键断言：云端 Promise 尚未 resolve，界面已经完成
    assert.strictEqual(page.rows[0].date, plus(2), '首帧：内存行已改到新日期（不等云端）')
    assert.strictEqual(page.rows[0].hour, Math.floor(free.start / 60), '首帧：新小时已生效')
    assert.strictEqual(page.data.rescheduleOpen, false, '首帧：改期面板立即收起')
    assert.strictEqual(page.data.rSelected, null, '首帧：清空选中')
    assert.strictEqual(ctx.state.loadings.length, 0, '⛔ P-2 不许有阻塞式「正在提交…」loading')
    assert.strictEqual(ctx.state.toasts.length, 0, '云端还没成功 ⇒ 不许出现成功提示')
    const item = page.data.upcoming.find(u => u.historyId === 'h1')
    assert.strictEqual(item.dateText, view.dateTextOf(plus(2)), '首帧：列表已显示新日期')
    ctx.releaseCoach()
    await pending
  })

  await runner('P-2② 服务端 ok：**静默**确认（非阻塞轻提示）+ 后台对账 + 不重复提交/不重复占位', async () => {
    const row = bookingRow({ date: plus(1), hour: 10, minute: 0 })
    const ctx = buildPage({ availability: availabilityWith([row], []) })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    const free = await freeSlotOn(ctx, page, plus(2))
    const newHour = Math.floor(free.start / 60)
    // ⭐ 服务端真相：改期成功后服务端这一节确实在新时间 ⇒ 对账必须以此为准（不能被旧投影覆盖回去）
    ctx.state.availability = availabilityWith([bookingRow({ date: plus(2), hour: newHour, minute: 0 })], [])
    await ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: free.key } } })
    assert.strictEqual(ctx.writes().length, 1, '恰好一次写调用（不重复提交 / 不重复占位）')
    assert.strictEqual(page.rows[0].date, plus(2), '保留新时间')
    // ⛔ 成功**不再**弹阻塞 modal，只给非阻塞轻提示
    const modalTexts = ctx.state.modals.map(m => `${m.title || ''}${m.content || ''}`).join('|')
    assert.ok(!/时间更改成功/.test(modalTexts), '成功不许再弹阻塞式 modal')
    assert.ok(ctx.state.toasts.some(t => /时间更改成功/.test(t.title || '')), '成功要有非阻塞轻提示')
    assert.strictEqual(ctx.state.loadings.length, 0, '全程无阻塞 loading')
    assert.strictEqual(page.data.managing, false, '落定后释放防连点锁')
  })

  await runner('P-2③ BOOKING_TIME_CONFLICT：先乐观显示，随后**完整回滚**到原时间，绝不假成功', async () => {
    const row = bookingRow({ date: plus(1), hour: 10, minute: 0 })
    const ctx = buildPage({ availability: availabilityWith([row], []), coachResult: { ok: false, code: 'BOOKING_TIME_CONFLICT', message: '这个时间刚被占用了' } })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    const free = await freeSlotOn(ctx, page, plus(2))
    await ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: free.key } } })
    // ⛔ 无损回滚：日期 / 小时 / 分钟 / 状态全部还原
    assert.strictEqual(page.rows[0].date, plus(1), '回滚：日期还原')
    assert.strictEqual(page.rows[0].hour, 10, '回滚：小时还原')
    assert.strictEqual(page.rows[0].minute, 0, '回滚：分钟还原')
    assert.strictEqual(page.rows[0].status, 'booked', '回滚：状态还原（原预约没丢）')
    const item = page.data.upcoming.find(u => u.historyId === 'h1')
    assert.ok(item, '原预约必须还在待上课里（不能因为失败而丢失）')
    assert.strictEqual(item.dateText, view.dateTextOf(plus(1)), '列表也回到原时间')
    const texts = ctx.state.modals.map(m => `${m.title || ''}${m.content || ''}`).join('|')
    assert.ok(/改期失败，已恢复原时间/.test(texts), '必须明说「改期失败，已恢复原时间」')
    assert.ok(ctx.state.toasts.every(t => !/时间更改成功/.test(t.title || '')), '失败不许出现成功提示')
  })

  await runner('P-2④ REVISION_CONFLICT：同样**完整回滚**到原时间', async () => {
    const row = bookingRow({ date: plus(1), hour: 14, minute: 30 })
    const ctx = buildPage({ availability: availabilityWith([row], []), coachResult: { ok: false, code: 'REVISION_CONFLICT', message: '数据已被其他请求更新' } })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    const free = await freeSlotOn(ctx, page, plus(2))
    await ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: free.key } } })
    assert.strictEqual(page.rows[0].date, plus(1), 'REVISION_CONFLICT ⇒ 日期还原')
    assert.strictEqual(page.rows[0].hour, 14, 'REVISION_CONFLICT ⇒ 小时还原')
    assert.strictEqual(page.rows[0].minute, 30, 'REVISION_CONFLICT ⇒ 分钟还原')
    const texts = ctx.state.modals.map(m => `${m.title || ''}${m.content || ''}`).join('|')
    assert.ok(/改期失败，已恢复原时间/.test(texts))
  })

  await runner('P-2⑤ UNKNOWN 最终**成功**：中途不假失败、不假成功，最后保留新时间', async () => {
    const row = bookingRow({ date: plus(1), hour: 10, minute: 0 })
    let ctx = null
    let modalsAtUnknown = -1, toastsAtUnknown = -1, dateAtUnknown = null, newHour = null
    ctx = buildPage({
      availability: availabilityWith([row], []),
      coachResult: n => {
        if (n === 1) {
          // ⭐ 第一次返回"结果不确定"的**那一瞬间**取证：不许已经宣告成功、也不许已经宣告失败
          modalsAtUnknown = ctx.state.modals.length
          toastsAtUnknown = ctx.state.toasts.length
          dateAtUnknown = ctx.rows[0].date
          return { ok: false, code: 'MEMBER_MANAGE_RESULT_UNKNOWN', message: '结果待确认' }
        }
        // 幂等重放 ⇒ 服务端最终成功，服务端真相也变成新时间
        ctx.state.availability = availabilityWith([bookingRow({ date: plus(2), hour: newHour, minute: 0 })], [])
        return { ok: true }
      }
    })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    const free = await freeSlotOn(ctx, page, plus(2))
    newHour = Math.floor(free.start / 60)
    await ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: free.key } } })
    // ⛔ UNKNOWN 的那一刻：不宣告失败（无 modal）、不宣告成功（无 toast）、也不提前回滚
    assert.strictEqual(modalsAtUnknown, 0, 'UNKNOWN 时**不许**立刻宣告失败')
    assert.strictEqual(toastsAtUnknown, 0, 'UNKNOWN 时**不许**宣告成功')
    assert.strictEqual(dateAtUnknown, plus(2), 'UNKNOWN 时**不许**提前回滚（仍显示新时间待裁决）')
    // 最终裁决：服务端成功 ⇒ 保留新时间
    assert.strictEqual(page.rows[0].date, plus(2), '服务端最终成功 ⇒ 保留新时间')
    assert.strictEqual(ctx.writes().length, 2, '原请求 + 同一 requestId 的幂等重放（不会变成两笔改期）')
    const texts = ctx.state.modals.map(m => `${m.title || ''}${m.content || ''}`).join('|')
    assert.ok(!/改期失败/.test(texts), '服务端最终成功 ⇒ 不出现失败提示')
    assert.ok(ctx.state.toasts.some(t => /时间更改成功/.test(t.title || '')), '最终成功 ⇒ 静默确认')
  })

  await runner('P-2⑥ UNKNOWN 最终**失败**：先用幂等重放裁决，确认失败后回滚原快照', async () => {
    const row = bookingRow({ date: plus(1), hour: 10, minute: 0 })
    const ctx = buildPage({
      availability: availabilityWith([row], []),
      coachResult: n => (n === 1
        ? { ok: false, code: 'MEMBER_MANAGE_RESULT_UNKNOWN', message: '结果待确认' }
        : { ok: false, code: 'BOOKING_TIME_CONFLICT', message: '这个时间刚被占用了' })
    })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    const free = await freeSlotOn(ctx, page, plus(2))
    await ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: free.key } } })
    assert.strictEqual(page.rows[0].date, plus(1), '服务端最终失败 ⇒ 回滚原时间')
    assert.strictEqual(page.rows[0].hour, 10)
    const texts = ctx.state.modals.map(m => `${m.title || ''}${m.content || ''}`).join('|')
    assert.ok(/改期失败，已恢复原时间/.test(texts), '必须明说已恢复原时间')
  })

  await runner('P-2⑦ 快照是**真正深拷贝**：乐观修改**不污染**回滚源（污染则回滚失效）', async () => {
    const row = bookingRow({ date: plus(1), hour: 10, minute: 0 })
    const ctx = buildPage({ availability: availabilityWith([row], []), coachResult: { ok: false, code: 'BOOKING_TIME_CONFLICT', message: '冲突' } })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    const free = await freeSlotOn(ctx, page, plus(2))
    // 乐观更新已经把行改成新时间了；若快照是**引用**，回滚源会跟着变成新时间 ⇒ 回滚等于没回滚
    await ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: free.key } } })
    assert.notStrictEqual(page.rows[0].date, plus(2), '回滚后**不许**还停在新时间（停住＝快照被污染）')
    assert.strictEqual(page.rows[0].date, plus(1), '必须真的回到提交前的值')
    // 直接验一次 `restoreRescheduleSnapshot` 本身：给它一份旧值，必须把当前行改回去
    page.rows = [Object.assign(bookingRow(), { date: plus(9), hour: 21, minute: 45 })]
    ctx.captured.restoreRescheduleSnapshot.call(page, { historyId: 'h1', date: plus(1), hour: 10, minute: 0, status: 'booked' })
    assert.strictEqual(page.rows[0].date, plus(1), 'restore 必须按快照还原日期')
    assert.strictEqual(page.rows[0].hour, 10, 'restore 必须按快照还原小时')
    assert.strictEqual(page.rows[0].minute, 0, 'restore 必须按快照还原分钟')
  })

  await runner('P-2⑧ 防连点：一笔在飞时再点 ⇒ 云端**只提交一次**（`managing` 锁不因 UI 已返回而失效）', async () => {
    const row = bookingRow({ date: plus(1), hour: 10, minute: 0 })
    const ctx = buildPage({ availability: availabilityWith([row], []), holdCoach: true })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    const free = await freeSlotOn(ctx, page, plus(2))
    const first = ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: free.key } } })
    assert.strictEqual(page.data.managing, true, '在飞期间锁必须保持')
    // ⭐ 界面已经"秒回"了，但立刻再点一次 ⇒ 锁必须拦住
    const second = ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: free.key } } })
    assert.strictEqual(ctx.writes().length, 1, '连点 ⇒ 云端只提交一次')
    ctx.releaseCoach()
    await Promise.all([first, second])
    assert.strictEqual(ctx.writes().length, 1, '全程只有一次写调用')
  })

  await runner('P-2⑨ 后台对账：最终以**服务端数据**覆盖客户端临时值', async () => {
    const row = bookingRow({ date: plus(1), hour: 10, minute: 0 })
    const ctx = buildPage({ availability: availabilityWith([row], []), holdCoach: true })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    const free = await freeSlotOn(ctx, page, plus(2))
    const pending = ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: free.key } } })
    assert.strictEqual(page.rows[0].date, plus(2), '首帧先显示新时间（临时值）')
    // ⭐ 服务端真相：这一节其实在 +7 天 16:00（例如别的设备已改过）
    ctx.state.availability = availabilityWith([bookingRow({ date: plus(7), hour: 16, minute: 0 })], [])
    ctx.releaseCoach()
    await pending
    assert.strictEqual(page.rows[0].date, plus(7), '后台对账 ⇒ 以服务端真相覆盖本地临时值')
    assert.strictEqual(page.rows[0].hour, 16, '小时也以服务端为准')
    const item = page.data.upcoming.find(u => u.historyId === 'h1')
    assert.strictEqual(item.dateText, view.dateTextOf(plus(7)), '列表最终显示服务端时间')
  })

  // ==================================================================
  // P-3（2026-10-01）·「我的预约」整页 Local-first / SWR
  //   三个慢点（进页 ≈3s / 改期返回 ≈2s / 取消 ≈2s）**同源**：旧 `load()` 无条件 `loading:true`，
  //   而 wxml 的 loading 是 `wx:if/wx:elif` 链 ⇒ 一真就顶掉整个列表。本组把"首帧必须有东西可看"钉死。
  // ==================================================================
  await runner('P-3① 进入「我的预约」：本地已有可信数据 ⇒ 首帧直接出列表，**不等待**云 Promise', async () => {
    const row = bookingRow({ date: plus(1), hour: 10, minute: 0 })
    const ctx = buildPage({ availability: availabilityWith([row], []), holdRead: true, rows: [row] })
    const page = ctx.page
    const pending = ctx.captured.load.call(page)
    assert.strictEqual(page.data.loading, false, '⛔ 有本地数据 ⇒ 不许出现「正在读取你的预约…」遮罩')
    assert.strictEqual((page.data.upcoming || []).length, 1, '首帧就有待上课列表（一帧都不等网络）')
    assert.strictEqual(page.data.upcoming[0].historyId, 'h1', '首帧内容正确')
    ctx.releaseRead()
    await pending
    assert.strictEqual(page.data.loading, false, '云端回来后仍然不是 loading')
  })

  await runner('P-3② 进入「我的预约」：本地无 rows 但有上次全量投影缓存 ⇒ 首帧用缓存出列表', async () => {
    const row = bookingRow({ date: plus(2), hour: 15, minute: 0 })
    const ctx = buildPage({ availability: availabilityWith([row], []), holdRead: true })
    // ⭐ 预置"上一次进页面时存下的全量投影"（key 与 `member-runtime` 的 availability 缓存一致）
    const cacheKey = `coachMemberAvailability:${memberRuntime.environment()}:`
    ctx.state.storage[cacheKey] = Object.assign(availabilityWith([row], []), {
      cachedAt: Date.now(), environment: memberRuntime.environment()
    })
    const page = ctx.page
    const pending = ctx.captured.load.call(page)
    assert.strictEqual(page.data.loading, false, '⛔ 有缓存 ⇒ 不许白屏等云端')
    assert.strictEqual((page.data.upcoming || []).length, 1, '缓存首帧就出列表')
    assert.strictEqual(page.rows[0].hour, 15, '缓存内容被正确采用')
    ctx.releaseRead()
    await pending
  })

  await runner('P-3③ 防闪烁：云端**未决**时后台刷新拿回旧投影 ⇒ 不许把改期的新时间顶回去', async () => {
    const row = bookingRow({ date: plus(1), hour: 10, minute: 0 })
    const ctx = buildPage({ availability: availabilityWith([row], []), holdCoach: true })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    const free = await freeSlotOn(ctx, page, plus(2))
    const newHour = Math.floor(free.start / 60)
    const pending = ctx.captured.pickRescheduleSlot.call(page, { currentTarget: { dataset: { key: free.key } } })
    assert.strictEqual(page.rows[0].date, plus(2), '首帧已是新时间')
    // ⭐ 云写在飞、后台 load 却先回来了（写已成功、读还没同步的典型场景）⇒ 服务端投影仍是 **旧** 的
    await ctx.captured.load.call(page, true)
    assert.strictEqual(page.rows[0].date, plus(2), '⛔ 未决期间不许被旧投影顶回 +1（防闪烁保护窗口）')
    assert.strictEqual(page.rows[0].hour, newHour, '小时也不许被顶回去')
    // 落定后 ⇒ 一律以服务端真相为准（保护窗口已清）
    ctx.state.availability = availabilityWith([bookingRow({ date: plus(2), hour: newHour, minute: 0 })], [])
    ctx.releaseCoach()
    await pending
    assert.strictEqual(page.rows[0].date, plus(2), '落定后以服务端真相为准')
    assert.strictEqual(page.optimistic, null, '⛔ 落定后保护窗口必须清空（否则会变成永久假状态）')
  })

  // ------------------------------------------------------------------ 取消：与改期共用同一套 Local-first
  await runner('P-3④ 取消首帧 Local-first：立即反映取消 / 移出待上课 / **无阻塞 loading**', async () => {
    const row = bookingRow({ date: plus(1), hour: 10, minute: 0 })
    const ctx = buildPage({ availability: availabilityWith([row], []), autoConfirm: true, holdCoach: true })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    const pending = ctx.captured.requestCancel.call(page)
    await tick(); await tick(); await tick()
    assert.strictEqual(page.rows[0].status, 'cancelled', '⛔ 云端**还没返回**，本地已经反映取消')
    assert.ok(!(page.data.upcoming || []).some(u => u.historyId === 'h1'), '首帧就移出「待上课」')
    assert.ok((page.data.history || []).some(u => u.historyId === 'h1'), '进入已完成/历史（不是凭空消失）')
    assert.strictEqual(ctx.state.loadings.length, 0, '⛔ 取消不许再有阻塞式「正在提交…」')
    assert.strictEqual(page.data.detail, null, '详情立即收起')
    ctx.releaseCoach()
    await pending
    assert.strictEqual(ctx.writes().length, 1, '恰好一次写调用')
    assert.ok(ctx.state.toasts.some(t => /预约已取消/.test(t.title || '')), '成功给**非阻塞**轻提示')
    const modalTexts = ctx.state.modals.map(m => `${m.title || ''}${m.content || ''}`).join('|')
    assert.ok(!/预约已取消/.test(modalTexts), '成功不许再弹阻塞式 modal')
  })

  await runner('P-3⑤ 取消失败：**完整回滚**原预约（还在待上课里），明说「取消失败，已恢复原预约」', async () => {
    const row = bookingRow({ date: plus(1), hour: 10, minute: 0 })
    const ctx = buildPage({
      availability: availabilityWith([row], []), autoConfirm: true,
      coachResult: { ok: false, code: 'REVISION_CONFLICT', message: '数据已被其他请求更新' }
    })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    await ctx.captured.requestCancel.call(page)
    assert.strictEqual(page.rows[0].status, 'booked', '回滚：状态还原（原预约没丢）')
    assert.strictEqual(page.rows[0].date, plus(1), '回滚：日期还原')
    assert.strictEqual(page.rows[0].hour, 10, '回滚：小时还原')
    assert.ok((page.data.upcoming || []).some(u => u.historyId === 'h1'), '原预约必须回到待上课')
    const texts = ctx.state.modals.map(m => `${m.title || ''}${m.content || ''}`).join('|')
    assert.ok(/取消失败，已恢复原预约/.test(texts), '必须明说「取消失败，已恢复原预约」')
    assert.ok(!ctx.state.toasts.some(t => /已取消/.test(t.title || '')), '失败不许出现成功提示')
  })

  await runner('P-3⑥ 取消 UNKNOWN：不假成功也不假失败，最终由服务端裁决', async () => {
    const row = bookingRow({ date: plus(1), hour: 10, minute: 0 })
    let ctx = null
    ctx = buildPage({
      availability: availabilityWith([row], []), autoConfirm: true,
      coachResult: n => {
        if (n === 1) return { ok: false, code: 'MEMBER_MANAGE_RESULT_UNKNOWN', message: '结果待确认' }
        // 幂等重放 ⇒ 服务端最终成功；服务端真相也变成已取消
        ctx.state.availability = availabilityWith([bookingRow({ status: 'cancelled' })], [])
        return { ok: true }
      }
    })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    await ctx.captured.requestCancel.call(page)
    assert.strictEqual(page.rows[0].status, 'cancelled', '服务端最终成功 ⇒ 保持已取消')
    assert.strictEqual(ctx.writes().length, 2, '原请求 + 同一 requestId 的幂等重放（不会变成两笔）')
    const texts = ctx.state.modals.map(m => `${m.title || ''}${m.content || ''}`).join('|')
    assert.ok(!/取消失败/.test(texts), '最终成功 ⇒ 不出现失败提示')
  })

  await runner('P-3⑦ 取消防连点：UI 已秒回，但云端**只提交一次**', async () => {
    const row = bookingRow({ date: plus(1), hour: 10, minute: 0 })
    const ctx = buildPage({ availability: availabilityWith([row], []), autoConfirm: true, holdCoach: true })
    ctx.rows = [row]
    const page = openDetailOn(ctx, row)
    const first = ctx.captured.requestCancel.call(page)
    await tick(); await tick(); await tick()
    assert.strictEqual(page.data.managing, true, '在飞期间锁必须保持')
    // ⭐ 第一次已经把这一节乐观改成 cancelled，而"已取消的课不能再取消"是**另一条**业务校验
    //    ⇒ 不还原的话，第二次会被业务规则拦住，**防连点锁根本没被检验到**（测试会假绿）。
    //    这里还原 status，是为了把"锁"这一个变量**单独**隔离出来验。
    page.rows[0].status = 'booked'
    const second = ctx.captured.requestCancel.call(page)   // ⭐ 界面已"秒回"，立刻再点一次
    await tick(); await tick(); await tick()
    assert.strictEqual(ctx.writes().length, 1, '连点 ⇒ 云端只提交一次')
    ctx.releaseCoach()
    await Promise.all([first, second])
    assert.strictEqual(ctx.writes().length, 1, '全程只有一次写调用')
  })

  // ------------------------------------------------------------------ P-4 · 时段口径与历史补录（以磁盘代码为准）
  // ⭐ 2026-10-03 四次口径：最早开课 **06:00**（07:00 → 06:00），上界仍是 23:00 ⇒ 06:00–23:00 共 35 格。
  await runner('P-4① 06:00 是当天最早可约时间；05:30 不可约', async () => {
    const slots = view.slotsFor({ dateKey: plus(1), busy: [] })
    assert.ok(slots.length > 0, '必须有可约时段')
    assert.strictEqual(slots[0].start, 6 * 60, '最早开课时间必须是 06:00')
    assert.ok(slots.every(slot => slot.start >= 6 * 60), '不许出现 06:00 之前的时段')
    assert.ok(!slots.some(slot => slot.start === 5 * 60 + 30), '05:30 不许可约')
  })

  await runner('P-4② ⭐ 23:00 是当天最后一个开课时间（23:00 + 60 ⇒ 24:00 结束）', async () => {
    const slots = view.slotsFor({ dateKey: plus(1), busy: [] })
    const last = slots[slots.length - 1]
    assert.strictEqual(last.start, 23 * 60, '当天最后一个开课时间必须是 23:00')
    assert.strictEqual(last.available, true, '23:00 必须可约')
    assert.strictEqual(last.end, 24 * 60, '23:00 + 60 ⇒ 24:00')
    assert.strictEqual(last.label, '23:00–24:00', '结束必须显示成 24:00')
    // ⭐ 半点步长真的生效（不只是"最后一格凑巧是半点"）
    assert.ok(slots.some(slot => slot.start === 6 * 60 + 30), '06:30 半点必须可约')
    assert.ok(slots.some(slot => slot.start === 12 * 60 + 30), '12:30 半点必须可约')
    assert.strictEqual(slots.length, 35, `06:00–23:00 每 30 分钟一格 ⇒ 35 格（实测 ${slots.length}）`)
    // 23:00 之后不许再生成；也不许出现"太晚"的理由（超过 23:00 的格子压根不生成）
    assert.ok(!slots.some(slot => slot.start > 23 * 60), '23:00 之后（含 23:30）不许出现起点')
    assert.ok(!slots.some(slot => slot.reason === 'late'), '不再存在 late 理由')
  })

  await runner('P-4③ 旧口径已作废：常量与函数都不许残留（防止有人照旧文件改回去）', async () => {
    // 📌 这一段原本是"现状钉子"，钉的是 23:30 尚不可约（与最新用户规则不符）。
    //    2026-10-01 口径已按用户最终规则落地 ⇒ 钉子摘除，改钉"旧口径不许残留"。
    assert.strictEqual(view.SLOT_STEP_MINUTES, 30, '步长必须是 30 分钟（旧值 60 已作废）')
    assert.strictEqual(view.LATEST_START_MINUTES, 23 * 60, '最晚开课必须是 23:00')
    const occupancy = require('../utils/package-occupancy')
    assert.strictEqual(occupancy.endsAfterLatest, undefined, '旧判据 endsAfterLatest 必须已删除')
    assert.strictEqual(occupancy.LATEST_END_MINUTES, undefined, '旧常量 LATEST_END_MINUTES 必须已删除')
    // ⛔ 全项目（产品代码）不许再引用旧口径
    const fs = require('fs'), path = require('path')
    const ROOT = path.join(__dirname, '..')
    const files = [
      'cloudfunctions/coachBusinessCommand/occupancy.js', 'cloudfunctions/coachBusinessCommand/handlers.js',
      'cloudfunctions/coachBusinessCommand/memberBooking.js', 'cloudfunctions/coachBusinessCommand/teaching.js',
      'utils/package-occupancy.js', 'utils/member-booking-view.js', 'utils/member-booking-request.js',
      'utils/member-booking-manage.js', 'utils/cloud-command-engine.js'
    ]
    for (const relative of files) {
      const text = fs.readFileSync(path.join(ROOT, relative), 'utf8')
      // ⛔ 旧口径（2026-09-29 那版）的**常量 / 函数**不许残留。
      //    📌 2026-10-02 **三次口径**把"结束不得晚于 24:00"这条规则**加了回来**（不是旧口径复活）：
      //       新实现叫 `DAY_END_MINUTES` + `endsAfterDayEnd` + `lessonWindowGateOf`，错误码 `BOOKING_END_TOO_LATE`。
      //       ⇒ 它是**现行规则**，不能再当作"旧口径残留"禁掉（那等于把跨午夜的口子重新打开）。
      assert.ok(!/LATEST_END_MINUTES|endsAfterLatest/.test(text),
        `${relative} 不许再引用旧的"最晚 24:00 结束"口径`)
    }
    // ⭐ 反向钉一层：孪生两份 occupancy 必须**真的带着**三次口径的结束闸
    for (const relative of ['cloudfunctions/coachBusinessCommand/occupancy.js', 'utils/package-occupancy.js']) {
      const text = fs.readFileSync(path.join(ROOT, relative), 'utf8')
      assert.ok(/DAY_END_MINUTES/.test(text) && /endsAfterDayEnd/.test(text) && /lessonWindowGateOf/.test(text),
        `${relative} 必须有三次口径的"结束 ≤ 当天 24:00"闸门`)
    }
  })

  await runner('P-4④ 历史补录**不受**未来 +30 天窗口限制（窗口只判上界）', async () => {
    const occupancy = require('../utils/package-occupancy')
    const beijingDate = require('../utils/beijing-date')
    const today = beijingDate.todayKey()
    // ⛔ 会员预约窗口只拦"超过 +30 天"，**不拦过去** ⇒ 教练事后补录已上过的课不受影响。
    assert.notStrictEqual(occupancy.memberBookingDateAllowed(beijingDate.addDays(today, -1), today), 'beyond', '昨天的课必须允许（补录）')
    assert.notStrictEqual(occupancy.memberBookingDateAllowed(beijingDate.addDays(today, -30), today), 'beyond', '30 天前的课也必须允许（补录）')
    assert.strictEqual(occupancy.memberBookingDateAllowed(beijingDate.addDays(today, 31), today), 'beyond', '+31 天仍然要拦（未来窗口没被误放开）')
    assert.strictEqual(occupancy.memberBookingDateAllowed(beijingDate.addDays(today, 30), today) !== 'beyond', true, '+30 天仍允许')
  })
}

manage.resetPolicy()
main()
