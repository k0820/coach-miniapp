// M3-P3 · 会员**真实预约**永久测试（2026-09-30，三条产品规则定稿后）
//
// 与 M3-P2 那份的分工：
//   · P2 测的是"通道安不安全"（伪造身份 / 越权 / 幂等 / 不动账 / 零写入）；
//   · P3 测的是"规则落地得对不对 + 真页面真的接通了吗"：
//       direct policy、未来 30 天窗口、无档案禁止、双击只一条、成功后刷新、失败保留选择。
//
// ⛔ 全部走**真**云函数代码（core / authorization / occupancy / 预约内核）跑在假 CloudBase 上；
//    真页面那段更狠：页面 → `wx.cloud.callFunction` → **同一个假世界** ⇒ 端到端，不是打桩。
//
// ⛔ 本批仍然**不部署**：真机上点确认会失败（云函数还不认识 `memberBooking`），这是预期，不是 bug。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createWorld, runner } = require('./helpers/m2-business-world')

const ROOT = path.join(__dirname, '..')
const memberBooking = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
const cloudOccupancy = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/occupancy'))
const authorization = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/authorization'))
const requestBuilder = require(path.join(ROOT, 'utils/member-booking-request'))
const beijingDate = require(path.join(ROOT, 'utils/beijing-date'))
const memberView = require(path.join(ROOT, 'utils/member-booking-view'))

const CLAIMS = 'member_sandbox_student_claims'
const ENV = 'sandbox'
// ⭐ 2026-10-05：测试区现在走**测试区专用**的云函数（名字的唯一出处：utils/sandbox-cloud-functions.js）。
const BUSINESS_FN = require(path.join(ROOT, 'utils/sandbox-cloud-functions')).businessFunction(ENV)
// 假世界的时钟起点（helpers/m2-business-world.js: `let clock = 1900000000000`）。
const CLOCK0 = 1900000000000
// ⭐ "今天"必须按**北京时间**算（不是 UTC）：这个钟点对应的北京时间当天。
const TODAY = memberBooking.beijingDateKey(CLOCK0)
const DAY = 30                                    // 规则 4：未来 30 天（数字本身来自 occupancy，这里只是给测试用的别名）
const DATE_IN = cloudOccupancy.addDateDays(TODAY, 3)

const world = createWorld()

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
}

function seedPackage(coach, studentId, packageId, extra = {}) {
  world.put('packages', world.businessId('packages', coach.owner, coach.datasetId, packageId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, packageId, studentId,
    data: { id: packageId, type: '常规训练', total: 10, remaining: 2, used: 0, reserved: 0, reservedVersion: 2, price: 300, status: 'active', ...extra }
  })
  return packageId
}
function seedSale(coach, studentId, saleId) {
  world.put('sales', world.businessId('sales', coach.owner, coach.datasetId, saleId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, saleId, studentId,
    data: { id: saleId, studentId, amount: 3000, date: '2030-01-01', source: 'manual' }
  })
}
function seedIncome(coach, incomeId) {
  world.put('incomes', world.businessId('incomes', coach.owner, coach.datasetId, incomeId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, incomeId,
    data: { id: incomeId, amount: 300, date: '2030-01-02' }
  })
}
function seedClaim(memberOpenId, coach, studentId) {
  const memberId = memberBooking.memberIdFor(memberOpenId)
  const claimId = memberBooking.fixedId(CLAIMS, coach.owner, studentId)
  world.put(CLAIMS, claimId, { claimId, memberId, coachId: coach.owner, studentId, status: 'verified' })
  return { memberId, claimId, studentId }
}
function seedGrantsSplit(place, studentId, packageId, coachId, packageStatus, memberStatus) {
  const names = authorization.collectionsFor(ENV)
  world.put(names.package, authorization.packageGrantId(place, packageId, coachId), {
    ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, packageId, studentId, coachId,
    status: packageStatus, canManage: false, grantedByCoachId: place.ownerCoachId
  })
  world.put(names.member, authorization.memberAuthId(place, studentId, coachId), {
    ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId, coachId,
    status: memberStatus, source: authorization.SOURCE_EXPLICIT, grantedByCoachId: place.ownerCoachId
  })
}

const coachKeyOf = coachId => memberBooking.fixedId('member-coach-view', coachId)
const packageViewIdOf = (claimId, packageId) => memberBooking.fixedId('member-package-view', claimId, packageId)

let A, B, M1, claim1, PKG
function setupBase(openId = 'open-m1') {
  world.reset()
  A = world.seedCoach('open-a', 'ds-a', 'PUBA')
  B = world.seedCoach('open-b', 'ds-b', 'PUBB')
  world.seedStudent(A, 'stu-a', '会员甲')
  world.seedStudent(B, 'stu-b', '会员乙')
  seedPackage(A, 'stu-a', 'pkg-a')
  seedSale(A, 'stu-a', 'sale-a')
  seedIncome(A, 'income-a')
  M1 = openId
  claim1 = seedClaim(M1, A, 'stu-a')
  PKG = 'pkg-a'
  memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
}

function book(options = {}) {
  world.setOpenId(options.openId || M1)
  return world.main()({
    action: 'memberBooking', command: 'createMemberBooking',
    requestId: options.requestId || `mbk_p3_${Math.random().toString(36).slice(2, 10)}`,
    environment: ENV,
    payload: options.payload || {}
  })
}
const slotPayload = (date, hour, extra = {}) => ({
  coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date, hour, minute: 0, ...extra
})

function bookingRows(coach) { return world.rows('bookings', coach.owner, coach.datasetId) }
function bookingData(coach) { return world.dataRows('bookings', coach.owner, coach.datasetId) }
function packageRow(coach, packageId) {
  return world.rows('packages', coach.owner, coach.datasetId).find(row => row.packageId === packageId)
}
function snapshotOf(...names) {
  return JSON.stringify(names.map(name => [...world.stores[name].values()].map(row => JSON.stringify(row)).sort()))
}
const ledgerSnapshot = () => snapshotOf('sales', 'incomes', 'settings')
const relationSnapshot = () => snapshotOf('students', CLAIMS)

// ------------------------------------------------------------------ 真页面：直接把假世界接进 wx.cloud
// ⭐ 这不是打桩：页面发出的每一次 callFunction 都真的跑一遍云函数代码。
let realTodayKey = null
function buildPage(options = {}) {
  const state = { calls: [], modals: [], toasts: [], storage: {} }
  const runtime = require(path.join(ROOT, 'utils/data-runtime'))
  runtime.setEnvironment('sandbox')          // 假世界的数据都在 sandbox 环境里
  // ⭐ 客户端预检按"真实今天"算 30 天窗口；假世界的今天在 2030 年 ⇒ 把时钟口径对齐到假世界，
  //    否则页面会先把请求判成越界、一次云调用都不发（那就测不到端到端那条链了）。
  if (!realTodayKey) realTodayKey = beijingDate.todayKey
  beijingDate.todayKey = () => TODAY
  if (options.openId) world.setOpenId(options.openId)
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
        world.setOpenId(options.openId || 'open-m1')
        if (option.name === BUSINESS_FN && option.data.action === 'memberRead') {
          return { result: { ok: true, environment: 'sandbox', availability: true, date: option.data.date,
            coaches: [{ coachKey: coachKeyOf(A.owner), displayName: '甲教练' }],
            packages: [{ packageViewId: packageViewIdOf(claim1.claimId, PKG), status: 'active', type: '常规训练', remaining: 2, used: 0, total: 10, coach: { displayName: '甲教练' } }],
            bookings: [], busy: [], warnings: [] } }
        }
        if (option.name === BUSINESS_FN) {
          if (options.failWith) return { result: { ok: false, code: options.failWith, message: '' } }
          return { result: await world.main()(option.data) }
        }
        if (option.name === 'readMyMemberData') {
          return {
            result: {
              ok: true, environment: 'sandbox', availability: true, date: option.data.date,
              coaches: [{ coachKey: coachKeyOf(A.owner), displayName: '甲教练' }],
              packages: [{ packageViewId: packageViewIdOf(claim1.claimId, PKG), status: 'active', type: '常规训练', remaining: 2, used: 0, total: 10, coach: { displayName: '甲教练' } }],
              bookings: [], busy: [], warnings: []
            }
          }
        }
        return { result: { ok: true } }
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
  // ⛔ 注意：这里的日期必须落在**假世界**的 30 天窗口里（否则服务端判过去/越界，测不到成功路径）。
  const dateKey = options.dateKey || DATE_IN
  page.data.dates = [{ index: 0, key: dateKey, label: '三天后' }]
  page.data.dateIndex = 0
  page.data.coaches = [{ coachKey: coachKeyOf(A.owner), displayName: '甲教练' }]
  page.data.packages = [{ packageViewId: packageViewIdOf(claim1.claimId, PKG), typeName: '常规训练', availableToBook: 2 }]
  page.data.slots = [
    { key: `${dateKey}#10:00`, start: 600, end: 660, label: '10:00–11:00', available: true },
    { key: `${dateKey}#14:00`, start: 840, end: 900, label: '14:00–15:00', available: true }
  ]
  page.data.selected = page.data.slots[0]
  page.data.confirmOpen = true
  captured.pickSlot.call(page, { currentTarget: { dataset: { key: page.data.slots[0].key } } })
  return { page, captured, state }
}

async function main() {
  await runner('① **默认就是 direct**：预约直接生效进课表（不等教练确认）', async () => {
    setupBase()
    // ⛔ 不显式 setPolicy ⇒ 走模块默认值，验证"定稿值真的生效"。
    const memberPath = require.resolve(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
    const cached = require.cache[memberPath]
    delete require.cache[memberPath]
    const fresh = require(memberPath)
    assert.strictEqual(fresh.currentPolicy(), 'direct')
    require.cache[memberPath] = cached

    const result = await book({ payload: slotPayload(DATE_IN, 10) })
    assert.strictEqual(result.ok, true, `预约应当直接成功：${result.code}`)
    assert.strictEqual(result.policy, 'direct')
    assert.strictEqual(result.memberRequestStatus, 'confirmed')
    const row = bookingData(A)[0]
    assert.strictEqual(row.status, 'booked', '会员自约成功后就是一条**普通的 booked 预约**')
    assert.strictEqual(row.memberRequest.status, 'confirmed')
    assert.strictEqual(row.memberRequest.policy, 'direct')
    assert.strictEqual(row.source, 'member')
    assert.strictEqual(row.createdByMemberId, memberBooking.memberIdFor('open-m1'))
    assert.strictEqual(row.createdByCoachId, null)
    assert.strictEqual(row.plannedMinutes, 60)
    // ⛔ 不许出现"会员专属状态"（那会逼教练端写第二套展示/完成逻辑）
    assert.ok(!/awaiting|pending/.test(String(row.status)), `不许造出一个教练端不认识的状态：${row.status}`)
  })

  await runner('② 今天（第 0 天）可约', async () => {
    setupBase()
    const result = await book({ payload: slotPayload(TODAY, 10) })
    assert.strictEqual(result.ok, true, `今天必须可约：${result.code}`)
    assert.strictEqual(bookingData(A)[0].date, TODAY)
  })

  await runner('③ 第 30 天可约（+30 = 边界内）', async () => {
    setupBase()
    const edge = cloudOccupancy.addDateDays(TODAY, DAY)
    const result = await book({ payload: slotPayload(edge, 10) })
    assert.strictEqual(result.ok, true, `第 30 天必须可约：${result.code}`)
    assert.strictEqual(bookingData(A)[0].date, edge)
  })

  await runner('④ 第 31 天拒绝（+31 = 越界），且零写入', async () => {
    setupBase()
    const beyond = cloudOccupancy.addDateDays(TODAY, DAY + 1)
    const before = ledgerSnapshot()
    const result = await book({ requestId: 'mbk_p3_31', payload: slotPayload(beyond, 10) })
    assert.strictEqual(result.ok, false, '第 31 天不许约')
    assert.strictEqual(result.code, 'MEMBER_BOOKING_BEYOND_WINDOW', `实际：${result.code}`)
    assert.ok(String(result.message).includes('30'), '拒绝原因必须说清是多少天')
    assert.strictEqual(bookingRows(A).length, 0, '越界时一次写都不许发生')
    assert.strictEqual(ledgerSnapshot(), before)
  })

  await runner('⑤ 过去的日期拒绝（事后补录不是会员的动作）', async () => {
    setupBase()
    const past = cloudOccupancy.addDateDays(TODAY, -1)
    const result = await book({ payload: slotPayload(past, 10) })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'BOOKING_DATE_IN_PAST')
    assert.strictEqual(bookingRows(A).length, 0)
  })

  await runner('⑥ 30 天按**北京时间**算：UTC 已跨日、北京还没跨日 ⇒ 仍算今天', async () => {
    // 2026-09-30T15:30Z = 北京 09-30 23:30（UTC 与北京同一天）
    // 2026-09-30T16:30Z = 北京 10-01 00:30（UTC 还是 09-30，北京已经是 10-01）
    const lateBeijing = Date.UTC(2026, 8, 30, 15, 30)      // 北京 09-30 23:30
    const crossedBeijing = Date.UTC(2026, 8, 30, 16, 30)   // 北京 10-01 00:30
    assert.strictEqual(memberBooking.beijingDateKey(lateBeijing), '2026-09-30')
    assert.strictEqual(memberBooking.beijingDateKey(crossedBeijing), '2026-10-01', '北京时间跨日要以北京为准')
    // ⛔ 用 UTC 判会把"北京还是今天"的预约错判成过去（这正是要防的事故）
    assert.strictEqual(new Date(crossedBeijing).toISOString().slice(0, 10), '2026-09-30', 'UTC 角度确实是 09-30（说明这条判据有判别力）')
    // 客户端（utils/beijing-date）与云端必须同口径
    assert.strictEqual(beijingDate.todayKey(lateBeijing), memberBooking.beijingDateKey(lateBeijing))
    assert.strictEqual(beijingDate.todayKey(crossedBeijing), memberBooking.beijingDateKey(crossedBeijing))
    // 窗口也按北京：北京今天 = 10-01 ⇒ 10-31 越界、10-30 不越界
    assert.strictEqual(cloudOccupancy.memberBookingDateAllowed('2026-10-01', '2026-10-01'), 'ok')
    assert.strictEqual(cloudOccupancy.memberBookingDateAllowed('2026-10-31', '2026-10-01'), 'ok')
    assert.strictEqual(cloudOccupancy.memberBookingDateAllowed('2026-11-01', '2026-10-01'), 'beyond')
    assert.strictEqual(memberBooking.beijingDateKey(CLOCK0), memberBooking.beijingDateKey(CLOCK0 + 10 * 60 * 1000), '测试期间时钟前进不会跨日（判据稳定）')
  })

  await runner('⑦ 没有该教练的学员档案 ⇒ 拒，且**零写入**（不许自动建档 / 自动认领）', async () => {
    setupBase()
    const before = relationSnapshot()
    const stranger = await book({
      openId: 'open-stranger',
      payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE_IN, hour: 10, minute: 0 }
    })
    assert.strictEqual(stranger.ok, false)
    assert.strictEqual(stranger.code, 'MEMBER_CLAIM_NOT_FOUND', `实际：${stranger.code}`)
    assert.strictEqual(relationSnapshot(), before, 'students / claims 一个字节都不许动')
    assert.strictEqual(bookingRows(A).length, 0)
    // ⛔ 也不许按姓名/手机号去猜关联（静态：源码里不许出现姓名匹配）
    const source = stripComments(fs.readFileSync(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking.js'), 'utf8'))
    assert.ok(!/studentName|phone|mobile/.test(source), '会员通道不许按姓名/手机号猜关联')
  })

  await runner('⑧ 有档案但**没有可用课包** ⇒ 拒', async () => {
    setupBase()
    // 把课包从 A 那本账里删掉（认领还在）⇒ 会员拿不到任何可约课包
    world.stores.packages.delete(world.businessId('packages', A.owner, A.datasetId, PKG))
    const result = await book({ payload: slotPayload(DATE_IN, 10) })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'PACKAGE_NOT_AVAILABLE_FOR_MEMBER')
    assert.strictEqual(bookingRows(A).length, 0)
  })

  await runner('⑨ 没有**会员级**服务关系 ⇒ 拒（与教练代约同一个错误码）', async () => {
    setupBase()
    const place = { ownerCoachId: A.owner, datasetId: A.datasetId }
    seedGrantsSplit(place, 'stu-a', PKG, B.owner, authorization.STATUS_ACTIVE, authorization.STATUS_REVOKED)
    const memberResult = await book({
      payload: { coachKey: coachKeyOf(B.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE_IN, hour: 10, minute: 0 }
    })
    assert.strictEqual(memberResult.ok, false)
    assert.strictEqual(memberResult.code, 'MEMBER_SERVICE_NOT_AUTHORIZED')
    const coachResult = await world.execute(B, 'createAuthorizedBooking', { studentId: 'stu-a', packageId: PKG, date: DATE_IN, hour: 10, minute: 0 })
    assert.strictEqual(coachResult.code, 'MEMBER_SERVICE_NOT_AUTHORIZED', '会员自约与教练代约必须报同一个码')
    assert.strictEqual(bookingRows(B).length, 0)
  })

  await runner('⑩ 没有**课包级**授课授权 ⇒ 拒（与教练代约同一个错误码）', async () => {
    setupBase()
    const place = { ownerCoachId: A.owner, datasetId: A.datasetId }
    seedGrantsSplit(place, 'stu-a', PKG, B.owner, authorization.STATUS_REVOKED, authorization.STATUS_ACTIVE)
    const memberResult = await book({
      payload: { coachKey: coachKeyOf(B.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE_IN, hour: 10, minute: 0 }
    })
    assert.strictEqual(memberResult.ok, false)
    assert.strictEqual(memberResult.code, 'PACKAGE_TEACHING_NOT_AUTHORIZED')
    const coachResult = await world.execute(B, 'createAuthorizedBooking', { studentId: 'stu-a', packageId: PKG, date: DATE_IN, hour: 10, minute: 0 })
    assert.strictEqual(coachResult.code, 'PACKAGE_TEACHING_NOT_AUTHORIZED', '会员自约与教练代约必须报同一个码')
    assert.strictEqual(bookingRows(B).length, 0)
  })

  await runner('⑪ 时间冲突 ⇒ 拒；且**教练端随后排同一时段也被拒**（说明它真的进了教练课表）', async () => {
    setupBase()
    const seeded = await world.execute(A, 'createBooking', { studentId: 'stu-a', packageId: PKG, date: DATE_IN, hour: 10, minute: 0, plannedMinutes: 60 })
    assert.strictEqual(seeded.ok, true, '前置：教练端先排上一节')
    const result = await book({ requestId: 'mbk_p3_conflict', payload: slotPayload(DATE_IN, 10) })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'BOOKING_TIME_CONFLICT')
    assert.strictEqual(bookingRows(A).length, 1, '失败的提交不许产生第二条预约')
    // 反过来：会员先约，教练端再排同一时段 ⇒ 也要被冲突拦住（同一份占用事实）
    setupBase()
    const first = await book({ payload: slotPayload(DATE_IN, 14) })
    assert.strictEqual(first.ok, true)
    const coachLater = await world.execute(A, 'createBooking', { studentId: 'stu-a', packageId: PKG, date: DATE_IN, hour: 14, minute: 0, plannedMinutes: 60 })
    assert.strictEqual(coachLater.ok, false)
    assert.strictEqual(coachLater.code, 'BOOKING_TIME_CONFLICT', '会员约的课必须占用教练的时段')
  })

  await runner('⑫ 余额不足 / 已排满 ⇒ 拒（两种 0 说两句不同的话）', async () => {
    setupBase()
    const row = packageRow(A, PKG); row.data.remaining = 0
    world.put('packages', world.businessId('packages', A.owner, A.datasetId, PKG), row)
    const empty = await book({ requestId: 'mbk_p3_no_remain', payload: slotPayload(DATE_IN, 10) })
    assert.strictEqual(empty.ok, false)
    assert.strictEqual(empty.code, 'PACKAGE_NO_REMAINING')
    setupBase()
    const row2 = packageRow(A, PKG); row2.data.remaining = 1
    world.put('packages', world.businessId('packages', A.owner, A.datasetId, PKG), row2)
    assert.strictEqual((await book({ payload: slotPayload(DATE_IN, 10) })).ok, true, '最后一节应当能被约走')
    const full = await book({ requestId: 'mbk_p3_no_avail', payload: slotPayload(DATE_IN, 14) })
    assert.strictEqual(full.ok, false)
    assert.strictEqual(full.code, 'PACKAGE_NO_AVAILABLE', '余量被排满要说"排满了"，不能说"没有课时了"')
    assert.strictEqual(bookingRows(A).length, 1)
  })

  await runner('⑬ ⭐ 开课窗口（2026-10-01 **二次**口径）：23:00 是最后一节；23:30 / 23:45 起拒', async () => {
    // ⛔ 本段原钉"23:00 + 60 = 24:00 合法；23:30 起 ⇒ 结束超过 24:00 拒"。
    //    用户 2026-10-01 最终规则**取代**了那条口径：判据改挂「开课时间」，23:30 是当天最后一节。
    setupBase()
    const ok = await book({ payload: slotPayload(DATE_IN, 23) })
    assert.strictEqual(ok.ok, true, '23:00 开课必须允许')
    setupBase()
    // ⛔ 23:30 这一档已取消（二次口径）⇒ 必须不可约
    const halfPast = await book({ requestId: 'mbk_p3_2330', payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE_IN, hour: 23, minute: 30 } })
    assert.strictEqual(halfPast.ok, false, `23:30 已取消 ⇒ 必须不可约（实测 ${JSON.stringify(halfPast)}）`)
    assert.strictEqual(halfPast.code, 'BOOKING_START_TOO_LATE')
    setupBase()
    const late = await book({ requestId: 'mbk_p3_late', payload: { coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date: DATE_IN, hour: 23, minute: 45 } })
    assert.strictEqual(late.ok, false, '23:45 开课 ⇒ 晚于 23:00，必须拒')
    assert.strictEqual(late.code, 'BOOKING_START_TOO_LATE')
    assert.strictEqual(bookingRows(A).length, 0)
  })

  await runner('⑭ **双击确认** ⇒ 云端只有一条预约（真页面 → 真云函数，端到端）', async () => {
    setupBase()
    const { page, captured, state } = buildPage()
    assert.ok(page.submitRequest, '打开确认层就要准备好请求')
    // ⚠️ 两次 submit **不 await**（模拟用户连点）⇒ 只有第一次真的出网
    const both = Promise.all([captured.submit.call(page), captured.submit.call(page)])
    await both
    const writes = state.calls.filter(row => row.name === BUSINESS_FN && row.data.action !== 'memberRead')
    assert.strictEqual(writes.length, 1, `连点两次只许发一次写调用（实测 ${writes.length} 次）`)
    assert.strictEqual(bookingRows(A).length, 1, `云端只许有一条预约（实测 ${bookingRows(A).length} 条）`)
    assert.ok(state.modals.some(row => String(row.title || '').includes('预约成功')), '成功必须明说')
  })

  await runner('⑮ 网络超时后**同号重发** ⇒ 不产生第二条（replay）', async () => {
    setupBase()
    const requestId = 'mbk_p3_replay_0001'
    const payload = slotPayload(DATE_IN, 10)
    const first = await book({ requestId, payload })
    assert.strictEqual(first.ok, true)
    const again = await book({ requestId, payload })
    assert.strictEqual(again.ok, true, '同号重发要返回上一次的结果，不能报错')
    assert.strictEqual(again.replayed, true)
    assert.strictEqual(again.bookingId, first.bookingId)
    assert.strictEqual(bookingRows(A).length, 1)
  })

  await runner('⑯ 改了时间再提交 ⇒ **新请求身份** ⇒ 真的排第二节（不会被旧号 replay）', async () => {
    setupBase()
    const first = await book({ requestId: 'mbk_p3_change_a', payload: slotPayload(DATE_IN, 10) })
    assert.strictEqual(first.ok, true)
    // ⭐ 页面换时段 ⇒ 重新取号（pickSlot ⇒ newNonce），所以这里是另一个 requestId
    const second = await book({ requestId: 'mbk_p3_change_b', payload: slotPayload(DATE_IN, 14) })
    assert.strictEqual(second.ok, true, '换了时间就应当真的排第二节')
    assert.notStrictEqual(second.bookingId, first.bookingId)
    assert.notStrictEqual(second.replayed, true, '不许把上一次的结果 replay 回来')
    assert.strictEqual(bookingRows(A).length, 2)
    // 幂等号本身：换参数 ⇒ 换号
    const a = requestBuilder.requestIdFor({ coachKey: 'ck', packageViewId: 'pv', date: DATE_IN, hour: 10, minute: 0, nonce: 'n1' })
    const b = requestBuilder.requestIdFor({ coachKey: 'ck', packageViewId: 'pv', date: DATE_IN, hour: 14, minute: 0, nonce: 'n1' })
    assert.notStrictEqual(a, b, '换时间必须换号')
  })

  await runner('⑰ 会员自约的预约与**教练代约同形状** ⇒ 教练端现有课表/完课/收入逻辑照原样跑', async () => {
    setupBase()
    const mine = await book({ payload: slotPayload(DATE_IN, 10) })
    assert.strictEqual(mine.ok, true)
    const memberRow = bookingData(A)[0]
    setupBase()
    const coachSide = await world.execute(A, 'createBooking', { studentId: 'stu-a', packageId: PKG, date: DATE_IN, hour: 10, minute: 0, plannedMinutes: 60 })
    assert.strictEqual(coachSide.ok, true)
    const coachRow = bookingData(A)[0]
    const fields = ['studentId', 'packageId', 'date', 'hour', 'minute', 'plannedMinutes', 'status', 'typeName', 'price']
    fields.forEach(field => assert.deepEqual(memberRow[field], coachRow[field], `字段 ${field} 必须与教练代约一致`))
    // ⛔ 只多出"标明来源"的那几个字段，业务字段一个都没变
    const allowedExtra = ['source', 'createdByCoachId', 'createdByMemberId', 'memberRequest']
    const extra = Object.keys(memberRow).filter(key => !(key in coachRow))
    assert.deepEqual(extra.filter(key => !allowedExtra.includes(key)), [], `只许多出来源标记，实际多出：${extra.join('、')}`)
    assert.ok(memberRow.memberRequest && memberRow.memberRequest.status === 'confirmed', '会员自约必须带来源标记')
    // 增量同步认识这条命令（教练端刷新不会退回全量读）
    const changes = fs.readFileSync(path.join(ROOT, 'cloudfunctions/readMyActiveCoachData/changes.js'), 'utf8')
    assert.ok(/createMemberBooking:/.test(changes))
  })

  await runner('⑱ reserved +1；remaining / used / total 不变；sales 与 incomes **一个字节都不动**', async () => {
    setupBase()
    const ledgers = ledgerSnapshot()
    const before = JSON.parse(JSON.stringify(packageRow(A, PKG).data))
    const result = await book({ payload: slotPayload(DATE_IN, 10) })
    assert.strictEqual(result.ok, true)
    const after = packageRow(A, PKG).data
    assert.strictEqual(after.reserved, before.reserved + 1, '预约只占座（reserved +1），与教练代约同一口径')
    assert.strictEqual(after.remaining, before.remaining, 'remaining 不许变')
    assert.strictEqual(after.used, before.used, 'used 不许变（上课才扣）')
    assert.strictEqual(after.total, before.total)
    assert.strictEqual(ledgerSnapshot(), ledgers, '创建预约本身不许碰 sales / incomes / settings')
    const incomes = world.rows('incomes', A.owner, A.datasetId)
    assert.strictEqual(incomes.length, 1, '创建预约本身不产生收入（收入仍由完课产生）')
  })

  await runner('⑲ 全程不自动创建 student / claim / 任何关系', async () => {
    setupBase()
    const before = relationSnapshot()
    const ok = await book({ payload: slotPayload(DATE_IN, 10) })
    assert.strictEqual(ok.ok, true)
    assert.strictEqual(relationSnapshot(), before, '成功路径也不许顺手建档')
    const failed = await book({ requestId: 'mbk_p3_fail', payload: slotPayload(cloudOccupancy.addDateDays(TODAY, DAY + 5), 10) })
    assert.strictEqual(failed.ok, false)
    assert.strictEqual(relationSnapshot(), before, '失败路径更不许建档')
  })

  await runner('⑳ 成功后：弹「预约成功」+ 关闭弹层 + **刷新我的预约** + 刷新可约时段', async () => {
    setupBase()
    const { page, captured, state } = buildPage()
    await captured.submit.call(page)
    assert.ok(state.modals.some(row => String(row.title || '').includes('预约成功')), '必须明说预约成功')
    assert.strictEqual(page.data.confirmOpen, false, '成功后要收起确认层')
    assert.strictEqual(page.data.submitting, false, 'loading 必须收回去（否则按钮永远转圈）')
    const reads = state.calls.filter(row => row.name === 'readMyMemberData' || (row.name === BUSINESS_FN && row.data.action === 'memberRead'))
    assert.ok(reads.length >= 1, '成功后必须**后台**回读一次「我的预约」（否则返回列表看不到这一条）')
    // ⭐ 2026-10-01「提交 2 秒」：这里**不再**要求"成功后再来一趟 availability 整页刷新"。
    //    旧断言钉的是**实现**（必须发某一种请求），而用户要的是**结果**（刚约掉那一格不许还能点）。
    //    现在结果由**本机回声**立刻给出（服务端已经 ok ⇒ 这一格确实被排掉了），真实数据由后台对账补齐。
    //    ⇒ 钉"整页刷新必须发生"会把"把刷新移出关键路径"这个合法优化判成违规 ⇒ 改为钉结果。
    const booked = (page.data.slots || []).find(row => row.key === `${DATE_IN}#10:00`)
    assert.ok(booked, '成功后那一格还在名单里')
    assert.strictEqual(booked.available, false, '刚约掉的那一格**立刻**不可约（不许还能再点一次）')
    // ⭐ 2026-10-03 补（覆盖真空修复）：只查 `available === false` 是**抓不到**"确认那一步被拆掉"的 ——
    //    `pending` 那道回声（第一帧就发）已经把它置成不可约了 ⇒ 少了 `confirmed` 也照样 false。
    //    真正区分"服务端已确认"与"还在占"的是**文案**。
    //    （证据：`_m3-p3-member-booking-live-mutate` ⑧「把 confirmed 那道回声拆掉」曾因此漏网，
    //      那一格会永远停在「正在占」—— 用户不知道到底约上没有。）
    assert.strictEqual(booked.stateText, '已排课',
      `服务端已 ok ⇒ 那一格必须写「已排课」（实测「${booked.stateText}」= 停在"还在占"）`)
    assert.strictEqual(booked.reasonText, '已排课',
      'reasonText 与 stateText 必须同步（老消费者读前者、画面读后者，只改一个会出现"可约"）')
    assert.strictEqual(booked.echo, true, '这一格必须标成"本机回声" ⇒ 下一趟服务端结果能整份覆盖它')
    assert.strictEqual(page.data.refreshing, false, '成功后不许把页面挂在「正在核对…」上（那是真机"还在转"的一部分）')
    assert.strictEqual(bookingRows(A).length, 1)
  })

  await runner('㉑ 失败后：**保留用户当前选择** + 给一句人话（不同原因说不同的话）', async () => {
    setupBase()
    const { page, captured, state } = buildPage({ failWith: 'BOOKING_TIME_CONFLICT' })
    await captured.submit.call(page)
    assert.deepEqual(state.modals.filter(row => String(row.title || '').includes('预约成功')), [], '失败绝不许弹成功（假成功比不做更糟）')
    assert.strictEqual(page.data.confirmOpen, true, '失败要保留确认层，让用户可以立刻换一个时间')
    assert.ok(page.data.selected, '失败要保留当前选中的时段')
    assert.ok(page.submitRequest, '失败要保留已经构造好的请求')
    const modal = state.modals[state.modals.length - 1]
    assert.ok(String(modal.content).includes('时间'), `冲突要给"换时间"的提示：${modal.content}`)
    assert.strictEqual(bookingRows(A).length, 0)

    // ⭐ 不同原因 ⇒ 不同的话（一句"失败"会让会员反复重试，还不知道该换时间还是换教练）
    const codes = ['MEMBER_CLAIM_NOT_FOUND', 'PACKAGE_NO_REMAINING', 'BOOKING_TIME_CONFLICT', 'MEMBER_BOOKING_BEYOND_WINDOW', 'PACKAGE_TEACHING_NOT_AUTHORIZED']
    const texts = codes.map(code => requestBuilder.friendlyMessageOf(code, ''))
    assert.strictEqual(new Set(texts).size, texts.length, `五种原因必须给出五句不同的话：${texts.join(' / ')}`)
    assert.ok(requestBuilder.friendlyMessageOf('MEMBER_BOOKING_BEYOND_WINDOW', '').includes('30'))
    assert.ok(requestBuilder.friendlyMessageOf('PACKAGE_NO_REMAINING', '').includes('课时'))
    assert.ok(requestBuilder.friendlyMessageOf('BOOKING_TIME_CONFLICT', '').includes('时间'))
  })

  await runner('㉒ loading 期间再点 ⇒ 不产生第二次真实提交（按钮也不会永远转圈）', async () => {
    setupBase()
    const { page, captured, state } = buildPage()
    const pending = captured.submit.call(page)          // 不 await：提交还在路上
    assert.strictEqual(page.data.submitting, true, '提交期间必须进 loading')
    captured.submit.call(page)                          // 用户手快又点了一次
    await pending
    assert.strictEqual(page.data.submitting, false, '结束后 loading 必须收回')
    const writes = state.calls.filter(row => row.name === BUSINESS_FN && row.data.action !== 'memberRead')
    assert.strictEqual(writes.length, 1, `loading 期间再点也不许发第二次（实测 ${writes.length} 次）`)
    assert.strictEqual(bookingRows(A).length, 1)
  })

  await runner('㉓ 会员伪造 memberId / coachId / studentId ⇒ 一律拒，零写入', async () => {
    setupBase()
    const payload = slotPayload(DATE_IN, 10)
    for (const key of ['memberId', 'coachId', 'studentId', 'packageId', 'ownerCoachId']) {
      const result = await book({
        requestId: `mbk_p3_fake_${key}`,
        payload: { ...payload, [key]: 'forged' }
      })
      assert.strictEqual(result.ok, false, `payload 里塞 ${key} 必须被拒`)
      assert.strictEqual(result.code, 'FORBIDDEN_IDENTITY_INPUT', `实际：${result.code}`)
    }
    const top = await world.main()({
      action: 'memberBooking', command: 'createMemberBooking', requestId: 'mbk_p3_fake_top', environment: ENV,
      memberId: 'forged', payload
    })
    assert.strictEqual(top.ok, false)
    assert.strictEqual(top.code, 'FORBIDDEN_IDENTITY_INPUT')
    assert.strictEqual(bookingRows(A).length, 0, '伪造身份时一次写都不许发生')
  })

  await runner('㉔ 静态契约：三条规则各自只有一个落点；30 不许散在别处', async () => {
    const memberSrc = stripComments(fs.readFileSync(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking.js'), 'utf8'))
    // 规则 1：direct
    assert.ok(/let SELECTED_POLICY = POLICY_DIRECT/.test(memberSrc), 'policy 默认值必须是 direct')
    // 规则 3：无档案拦截（不许被"自动建档"替换）
    assert.ok(/MEMBER_CLAIM_NOT_FOUND/.test(memberSrc), '必须保留"没有档案 ⇒ 拒绝"这条拦截')
    assert.ok(!/claims\.push\(/.test(memberSrc), '不许自动补一条认领')
    // 规则 4：30 天只在 occupancy 里定义；服务端**事务内**也判一次
    assert.ok(/memberBookingDateAllowed/.test(memberSrc), '服务端必须判 30 天窗口')
    assert.ok((memberSrc.match(/memberBookingDateAllowed/g) || []).length >= 2, '入口早拒 + 事务内终判，两处都要有')
    assert.ok(!/MEMBER_BOOKING_MAX_DAYS\s*=\s*\d/.test(memberSrc), '会员通道不许再定义一个 30')
    // 不碰销售 / 收入 / 完课 / 结算
    assert.ok(!/['"]sales['"]|['"]incomes['"]/.test(memberSrc))
    assert.ok(!/completeBooking|createIncome|settlement/i.test(memberSrc), '不许为会员预约再写一套完课/收入逻辑')
    // 客户端：可选天数来自同一个常量
    assert.strictEqual(memberView.MEMBER_BOOKING_MAX_DAYS, cloudOccupancy.MEMBER_BOOKING_MAX_DAYS)
    assert.strictEqual(memberView.MEMBER_DATE_COUNT, 31)
    const dates = memberView.dateOptions('2026-09-30')
    assert.strictEqual(dates.length, 31)
    assert.strictEqual(dates[0].key, '2026-09-30')
    assert.strictEqual(dates[30].key, '2026-10-30', '最后一个可选日期 = 今天 + 30 天')
    assert.strictEqual(cloudOccupancy.memberBookingDateAllowed(dates[30].key, '2026-09-30'), 'ok', '页面最后一个选项必须真的能约')
    assert.strictEqual(cloudOccupancy.memberBookingDateAllowed(cloudOccupancy.addDateDays('2026-09-30', 31), '2026-09-30'), 'beyond')
    // ⭐ 客户端预检也要拦越界（不是安全边界，但能让用户少白跑一趟）
    const problems = requestBuilder.problemsOf({
      dateKey: cloudOccupancy.addDateDays('2026-09-30', 31), todayKey: '2026-09-30',
      slot: { start: 600, end: 660 }, coachKey: 'ck', packageViewId: 'pv'
    })
    assert.ok(problems.some(text => String(text).includes('30')), `客户端必须拦住第 31 天：${problems.join('、')}`)
  })

  beijingDate.todayKey = realTodayKey || beijingDate.todayKey
  memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
}

main().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
