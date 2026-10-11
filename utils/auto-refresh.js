// M2 第七项：自动刷新的**基础能力**（2026-09-27）。
//
// 产品原则：【自动更新为默认，下拉刷新为兜底，最终写操作由服务端再次校验。】
//
// 这个文件只做三件事，**不重写同步架构**（增量 / revision / 回读依然是 cloud-primary-adapter 的活）：
//   ① 把「什么时候该刷新」变成一份**可枚举、可测试**的清单（REFRESH_TRIGGERS）；
//   ② 提供一个极简广播总线：任何一处发生关键变化 ⇒ request(触发点) ⇒ 订阅者各自刷新；
//   ③ 记录每次刷新的耗时，并给出**性能预算**（PERFORMANCE_BUDGET_MS），让"≤2 秒"是可断言的，不是口号。
//
// ⛔ 明确不做：不做"每几秒全量轮询"。轮询会把 Local-first 的增量/revision 机制架空，
//    还会把"数据没变"伪装成"数据已刷新"。触发点刷新 + 用户下拉兜底才是本项目要的形状。

const REFRESH_TRIGGERS = Object.freeze([
  'appLaunch',        // 小程序启动
  'appForeground',    // 从后台重新回到前台
  'pageShow',         // 进入关键页面
  'sessionReturn',    // 从课程详情返回
  'bookingCreated',   // 预约成功
  'bookingRescheduled', // 改期成功
  'bookingCancelled', // 取消成功
  'bookingCompleted', // 完成课程
  'packageChanged',   // 课时购买 / 修改后
  'permissionChanged' // M2 V1：多教练授权（会员级服务关系 / 课包级授课授权 / 接管）变化
])

// 性能验收目标：从刷新触发点开始，到关键最新数据出现在页面，正常网络下 ≤ 2 秒。
const PERFORMANCE_BUDGET_MS = 2000
// 同一个触发点在这么短的时间内重复发生（例如 onShow 被连续触发）⇒ 合并成一次，避免打爆云端。
const DEDUPE_MS = 400

// 命令 → 触发点：**写操作成功后**必须让关键数据重新出现。
const COMMAND_TRIGGERS = Object.freeze({
  createBooking: 'bookingCreated',
  createSharedBooking: 'bookingCreated',
  createAuthorizedBooking: 'bookingCreated',
  rescheduleBooking: 'bookingRescheduled',
  cancelBooking: 'bookingCancelled',
  completeBooking: 'bookingCompleted',
  markBookingNotHeld: 'bookingCompleted',
  deleteCompletedBooking: 'bookingCompleted',
  createPackage: 'packageChanged',
  updatePackage: 'packageChanged',
  deletePackage: 'packageChanged',
  createCourseSale: 'packageChanged',
  updateCourseSale: 'packageChanged',
  reverseCourseSale: 'packageChanged',
  // ⭐ 授权一变，"我能服务谁 / 谁能用这份课时"就变了 ⇒ 必须让授权目录重新读一次。
  grantMemberService: 'permissionChanged',
  revokeMemberService: 'permissionChanged',
  grantPackageTeaching: 'permissionChanged',
  revokePackageTeaching: 'permissionChanged',
  transferPackageManagement: 'permissionChanged'
})

let listeners = []
const lastRequestedAt = new Map()
let lastSample = null

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.push(listener)
  return () => { listeners = listeners.filter(item => item !== listener) }
}

// 「广播到底有没有人听」必须**可断言** —— 本次事故就是零订阅者、广播空转。
const subscriberCount = () => listeners.length

function unsubscribeAll() { listeners = []; lastRequestedAt.clear(); lastSample = null }

// 触发一次刷新广播。返回是否真的广播了（未知触发点 / 被合并 ⇒ false）。
function request(reason, now = Date.now()) {
  if (!REFRESH_TRIGGERS.includes(reason)) return false
  const previous = Number(lastRequestedAt.get(reason) || 0)
  if (now - previous < DEDUPE_MS) return false
  lastRequestedAt.set(reason, now)
  // 订阅者里抛错不能打断别人，也不能静默吞掉整个刷新链。
  listeners.slice().forEach(listener => {
    // `now` 一起传下去：页面侧的合并窗口必须与总线用**同一个时钟**，否则两边各算一套会错开。
    try { listener(reason, now) } catch (error) { if (typeof console !== 'undefined' && console.warn) console.warn('[auto-refresh] listener failed', reason, error) }
  })
  return true
}

function refreshTriggerFor(command) { return COMMAND_TRIGGERS[command] || null }

function requestForCommand(command, now) {
  const reason = refreshTriggerFor(command)
  return reason ? request(reason, now) : false
}

// 记录一次真实刷新的耗时（由调用方在拿到数据并渲染后调用）。
function recordSample({ reason, startedAt, endedAt = Date.now() } = {}) {
  const durationMs = Math.max(Number(endedAt) - Number(startedAt), 0)
  lastSample = { reason, startedAt: Number(startedAt), endedAt: Number(endedAt), durationMs, withinBudget: durationMs <= PERFORMANCE_BUDGET_MS }
  return lastSample
}

const lastRefreshSample = () => lastSample
const withinBudget = durationMs => Number(durationMs) <= PERFORMANCE_BUDGET_MS

// 页面接入：**这就是本次缺口缺失的那条线**。
//
// 事故：总线上 `request('appForeground')` 一直在发，但全项目**零个** `subscribe()` 调用
//   ⇒ 广播空转，从后台回到前台后当前页面不会重读，只有"进页面 / 下拉"才会更新。
//
// installPage 只补一件事：把「**当前可见**的页面 + 它自己的读取函数」接到总线上。
// 它**不替页面决定怎么读**（refresh 由页面给），也**不新增任何触发点**。
//
// ⭐ 三条防重复原则（缺一条就会出现"一次事件打两三遍云端"）：
//   ① **只有可见页面响应广播**：onHide / onUnload 立刻失活。
//      四个 tab 页同时在页面栈里，否则一次回前台会让它们一起发请求。
//   ② **同一页面上一轮没回来就不再叠加**（in-flight 直接跳过，不排队）。
//   ③ 与总线同一拍的 400ms 合并（DEDUPE_MS）。
//
// ⭐ 'pageShow' **不进订阅回调**：每个页面的 onShow 本来就自己读一次，
//    再让总线刷一遍就是同一件事做两遍 —— 这是"重复请求"最容易踩的坑。
function installPage(page, options = {}) {
  const refresh = options.refresh
  if (!page || typeof refresh !== 'function') return page
  let instance = null, active = false, running = null, lastRunAt = 0, unsubscribe = null

  const run = (reason, broadcastAt) => {
    if (!active || !instance) return false
    if (running) return false                                     // ② 上一轮还没回来
    const now = Number.isFinite(broadcastAt) ? broadcastAt : Date.now()
    if (now - lastRunAt < DEDUPE_MS) return false                 // ③ 与总线同一拍的合并（同一时钟）
    lastRunAt = now
    let outcome = null
    try { outcome = refresh.call(instance, reason) } catch (error) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[auto-refresh] page refresh failed', reason, error)
      return false
    }
    if (outcome && typeof outcome.then === 'function') {
      running = outcome
      const done = () => { running = null }
      outcome.then(done, done)
    }
    return true
  }

  const listener = (reason, broadcastAt) => { if (reason !== 'pageShow') run(reason, broadcastAt) }  // ① onShow 自己已经读过

  const originalShow = page.onShow, originalHide = page.onHide, originalUnload = page.onUnload
  page.onShow = function onShowWithRefresh(...args) {
    instance = this
    active = true
    if (!unsubscribe) unsubscribe = subscribe(listener)
    request('pageShow')
    if (typeof originalShow === 'function') return originalShow.apply(this, args)  // 页面自己的 onShow 已经负责读
    run('pageShow')                                                               // 没有 onShow 的页面，本模块兜底读一次
    return undefined
  }
  page.onHide = function onHideWithRefresh(...args) {
    active = false                                                               // ① 不可见 ⇒ 不响应广播
    if (typeof originalHide === 'function') return originalHide.apply(this, args)
    return undefined
  }
  page.onUnload = function onUnloadWithRefresh(...args) {
    active = false
    if (unsubscribe) { unsubscribe(); unsubscribe = null }
    if (typeof originalUnload === 'function') return originalUnload.apply(this, args)
    return undefined
  }
  if (options.pullDown !== false && typeof page.onPullDownRefresh !== 'function') {
    page.onPullDownRefresh = function onPullDownRefresh() {
      const outcome = refresh.call(this, 'pullDown')
      const done = () => { if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) wx.stopPullDownRefresh() }
      if (outcome && typeof outcome.then === 'function') outcome.then(done, done)
      else done()
    }
  }
  return page
}

module.exports = {
  REFRESH_TRIGGERS, PERFORMANCE_BUDGET_MS, DEDUPE_MS, COMMAND_TRIGGERS,
  subscribe, unsubscribeAll, subscriberCount, request, requestForCommand, refreshTriggerFor,
  recordSample, lastRefreshSample, withinBudget, installPage
}
