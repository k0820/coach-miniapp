// M3 P1-1 · 会员「我的预约」（**只读**）
// M3-P4 · 新增**取消 / 修改时间**的管理区（⛔ UI + 选择流程 + 请求构造都完整，**但零写入**）
//
// ⛔ 本页不写入任何东西：没有 command、没有 mutate、没有本地"假成功"。
// 数据只来自当前可信 memberId 那一帧 ⇒ 看不到别人的预约。
//
// ✅【2026-09-30 M3-P6】取消 / 改期**已正式开放**（六条规则用户已定稿 + 云端命令已实现）：
//   · 「取消预约」⇒ **二次确认** ⇒ 真写入 ⇒ 成功后**乐观更新列表**（立刻改到新状态）+ 后台 `load(true)` 对账；与改期共用 `runManage`，防连点靠 `managing`；
//   · 「修改时间」⇒ 点选新时间即直接提交（无第二个「确认修改」按钮）⇒ 真写入；
//   · ⭐ P-1（2026-09-30 晚，**真机 TRUE DEVICE PASS ⇒ ⛔ 禁止改动/重构**）：改期面板**缓存优先 +
//     邻日预加载**（点「修改时间」接近秒进），只复用 M3-P1 已真机验证的
//     `cachedAvailability` / `preloadAvailability`，**不另造架构**、不碰云端。
//   · ⭐ P-2 第二轮（2026-10-01，Local-first）：点新时间后**首帧**就更新列表 + 收起面板，
//     云端提交转为**后台**；⛔ 全程**没有** `wx.showLoading({ mask:true })`，主流程不被阻塞。
//       服务端 `ok` ⇒ **静默确认**（非阻塞轻提示）+ 后台对账；
//       服务端**明确拒绝**（冲突 / revision）⇒ 用**深拷贝快照无损回滚** + 明示「改期失败，已恢复原时间」；
//       结果 **UNKNOWN** ⇒ **不宣告成功、也不宣告失败** ⇒ 同一 requestId 幂等重放 + 服务端回读终裁，
//       **始终以服务端真相覆盖本地临时值**。
//   · ⭐【2026-10-01 · 统一根因优化】取消与改期**合并为同一套** Local-first（`runLocalFirst`）：
//       ① 深拷贝快照 → ② 首帧改列表 + 收起面板 → ③ 云端后台提交 → ④ 成功静默 / 明确失败无损回滚 / UNKNOWN 回读终裁。
//       ⛔ 取消**不再**走阻塞 `showLoading({ mask:true })`，也不再硬等两趟串行云端往返。
//       同时 `load()` 改为 **stale-while-revalidate**（首帧本地/缓存出列表，云端后台覆盖），
//       修掉"进页面 ≈3s 白屏"与"改期返回后 ≈2s 才显示新时间"——三者同源，一次解决。
//   · ⛔ 失败的铁律**不变**：只有 `result.ok` 才显示成功并乐观更新；冲突 / 余额 / 占位 / 跨设备一致**仍由云端终判**（后台 load 覆盖）；
//   · 失败/未开放时**保留用户当前选择**（不关面板、不清 selected）⇒ 她可以直接换时间再试；
//   · ⛔ 两道锁**仍然保留**（总闸 `release-flags.MEMBER_MANAGE_SUBMIT` × 规则 `policyBlocked()`），
//     任一道为真 ⇒ 只弹「暂未开放」、零云调用。回滚不需要改这个文件。
//
// 两条数据来源（**同一份数据，两个读法**，不是两套口径）：
//   ① `member.availability()` —— M3 P1 新只读投影，能给出**全部**待上课 + 历史（云端部署后生效）；
//   ② `member.read()` —— M1 已在跑的读取，只给「下一节预约」+「已完成训练」（今天的兜底）。
// ⚠️ ① 拿不到就退回 ②，并且**明说**只看得到下一节；绝不把「只看到一节」包装成「只有一节」。
const member = require('../../utils/member-runtime')
const phoneCalendar = require('../../utils/phone-calendar')
const theme = require('../../utils/member-theme')
const view = require('../../utils/member-booking-view')
const manage = require('../../utils/member-booking-manage')
const beijingDate = require('../../utils/beijing-date')
const flags = require('../../utils/release-flags')

function nowBeijingMinutes() {
  const at = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return at.getUTCHours() * 60 + at.getUTCMinutes()
}

// ⭐ 历史筛选的**唯一出口**：`history`（= 已排好序的**全部**历史）⇒ 当前筛选下要显示的几条 + 三个计数。
// ⛔ 计数按**全部历史**算，不按当前筛选 ⇒ 会员在「全部」里就能看到"已取消 3 节"，点进去才真的只剩 3 条。
// ⛔ 这里只做**切片**：不写回 rows、不产生命令、不动服务端一个字节。
function historyViewOf(history, filter) {
  const list = Array.isArray(history) ? history : []
  return { visibleHistory: view.filterHistory(list, filter), historyCounts: view.historyCountsOf(list) }
}

Page({
  data: {
    themeStyle: '', tab: 'upcoming', upcoming: [], history: [],
    // ⭐ 历史筛选（⛔ 只影响"看哪几条"：**不写回 rows、不碰任何业务数据**）
    historyFilter: 'all', visibleHistory: [], historyCounts: { all: 0, done: 0, cancelled: 0 },
    loading: true, error: '', notice: '', detail: null, partial: false,
    // M3-P4 · 改期面板（⭐ 点选即可约时间 ⇒ 直接提交改期，不再有「确认修改」按钮）
    rescheduleOpen: false, rDates: [], rIndex: 0, rDateKey: '', rDateLabel: '',
    rSlots: [], rSelected: null, rLoading: false, rRefreshing: false, rHint: '', managing: false,
    // ⭐⭐ 2026-10-04（H）取消预约的**统一二次确认弹层**（`member-sheet` + danger）。
    //   `cancelOpen` 只表示"弹层可见"；⛔ 组件不自己隐藏 ⇒ 收起走 `confirmCancel` / `closeCancel`。
    cancelOpen: false, cancelDesc: ''
  },
  rows: [],
  packagesById: {},
  // ⭐ 学员档案名索引（`{archiveId: name}`）：**只有多份档案**才有内容 ⇒ 单档案用户一行档案名都不多显示。
  archivesById: {},
  current: null,
  sessionNonce: '',
  // ⭐ 云端**未决**期间的乐观值保护窗口 `{ historyId: {date,hour,minute,status} }`：
  //   后台对账回来时，若服务端的投影还是旧值（写成功、读未同步）⇒ 不许把刚改好的新状态顶回去。
  //   ⛔ 落定（成功 / 失败）后立即清空 ⇒ 不存在"永久假状态"，之后一律以服务端真相为准。
  optimistic: null,

  onShow() { this.load() },
  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh && wx.stopPullDownRefresh(), () => wx.stopPullDownRefresh && wx.stopPullDownRefresh())
  },

  // ⭐【2026-10-01 · 统一根因优化】「我的预约」整个页面改为 **Local-first / stale-while-revalidate**。
  //   ⛔ 三个慢点（进页 ≈3s / 改期返回 ≈2s / 取消 ≈2s）**同源**：旧 `load()` 无条件 `setData({ loading:true })`，
  //      而 wxml 里 loading 是 `wx:if / wx:elif` 链 ⇒ loading 一真，**整个列表被顶掉**，只剩「正在读取你的预约…」：
  //      · 进页面 ⇒ 先清空再等全量云端投影 ⇒ 白屏 2–3 秒；
  //      · 改期 ⇒ 首帧已经改好了，却被随后的 `load(true)` 重新置 loading ⇒ 新时间要等第二轮云端才出现；
  //      · 取消 ⇒ 阻塞 `showLoading({ mask:true })` + 两趟串行云端往返 ⇒ 硬等 2 秒。
  //   ⇒ 统一做法：**首帧一定先有东西可看**（本地 rows / 上次全量投影缓存 / 老缓存），云端只负责**后台覆盖**。
  //   ⛔ 不是"隐藏 loading 造假"：后台那趟请求**一定会发**，回来就用服务端真相覆盖（见 `renderLive`）。
  async load(force) {
    // ① 首帧：本地已有可信数据（含刚乐观改过的值）⇒ 直接复用，一帧都不等网络。
    let firstFrame = false
    if ((this.rows || []).length) {
      this.renderRows()
      firstFrame = true
    } else {
      const snapshot = member.cachedAvailability('')        // 上次「我的预约」全量投影（**不判 TTL**）
      if (snapshot && Array.isArray(snapshot.bookings)) {
        this.renderLive(snapshot)
        firstFrame = true
      } else {
        const legacy = member.cached()
        if (legacy) { this.renderLegacy(legacy); firstFrame = true }
      }
    }
    // ⛔ 只有"一帧都拿不出来"才允许出现「正在读取…」⇒ 有数据就永远不遮列表。
    this.setData({ loading: !firstFrame, error: '' })
    // ② 后台对账：下拉刷新（`force`）才绕过 20 秒 TTL；其余命中缓存就不重复请求。
    try {
      const live = await member.availability('', { force: force === true })
      if (live && Array.isArray(live.bookings)) this.renderLive(live)
      else if (!firstFrame) this.renderLegacy(await member.read({ allowCache: !force }))
      this.setData({ loading: false })
    } catch (error) {
      this.setData({ loading: false, error: (this.rows || []).length ? '' : '暂时读不到你的预约，请联网后下拉重试。' })
    }
  },

  // ⛔ 防闪烁：云端**未决**期间服务端投影可能还是旧值（写已成功、读还没同步）⇒ 不许把刚乐观改好的新时间顶回去。
  //   ⛔ 这不是永久假状态：落定后 `clearOptimistic()` 立即清掉 ⇒ 之后每次 load 一律以服务端真相为准。
  applyOptimisticGuard(bookings) {
    const guard = this.optimistic
    if (!guard) return bookings
    return (bookings || []).map(row => {
      if (!row || !row.historyId) return row
      const pending = guard[row.historyId]
      return pending ? Object.assign({}, row, pending) : row
    })
  },
  markOptimistic(historyId, patch) {
    if (!historyId || !patch) return
    this.optimistic = Object.assign({}, this.optimistic || {}, { [String(historyId)]: patch })
  },
  clearOptimistic() { this.optimistic = null },

  renderLive(live) {
    this.rows = this.applyOptimisticGuard(Array.isArray(live.bookings) ? live.bookings : [])
    this.packagesById = view.packageNameIndex(live.packages)
    this.archivesById = view.archiveNameIndex(live.archives)
    const split = view.splitBookings(this.rows, this.packagesById, this.archivesById)
    this.setData({
      themeStyle: theme.cssVars(),
      upcoming: split.upcoming, history: split.history, partial: false,
      ...historyViewOf(split.history, this.data.historyFilter),
      notice: live.warnings && live.warnings.length ? '部分教练的数据暂时读不完整，已跳过。' : ''
    })
  },

  renderLegacy(data) {
    const rows = (data && data.recentTraining) || []
    const upcoming = data && data.nextBooking ? [data.nextBooking] : []
    const merged = upcoming.concat(rows).filter(row => row && row.historyId)
    this.rows = merged
    this.packagesById = view.packageNameIndex((data && data.packages) || [])
    this.archivesById = view.archiveNameIndex((data && data.archives) || [])
    const split = view.splitBookings(merged, this.packagesById, this.archivesById)
    this.setData({
      themeStyle: theme.cssVars(),
      upcoming: split.upcoming, history: split.history, partial: true,
      ...historyViewOf(split.history, this.data.historyFilter),
      notice: data && data.state === 'needs-claim'
        ? '还没有认领教练记录，暂时看不到预约。'
        : (data && data.offline ? '当前显示已保存的数据，仅可查看。' : '')
    })
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.tab) return
    this.setData({ tab, detail: null })
  },

  // ⛔ 筛选**只改这一页看哪几条**：不写回 `rows`、不产生任何命令、不碰业务数据。
  //   切到「已完成」只是把已取消的卡片藏起来，历史总数与服务端数据一个字节都不变。
  switchHistoryFilter(e) {
    const filter = String((e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.filter) || '')
    if (view.HISTORY_FILTERS.indexOf(filter) < 0 || filter === this.data.historyFilter) return
    this.setData({ historyFilter: filter, visibleHistory: view.filterHistory(this.data.history || [], filter) })
  },

  openDetail(e) {
    const id = e.currentTarget.dataset.id
    const row = (this.rows || []).find(item => item && item.historyId === id) || null
    const detail = view.detailOf(this.rows, id, this.packagesById, this.archivesById)
    if (!detail || !row) {
      wx.showToast && wx.showToast({ title: '这节课暂时打不开', icon: 'none' })
      return
    }
    this.current = row
    // ⭐ P-1 预加载：打开详情就把"这一节当天 + 次日"的可约时间提前发出（藏在用户看详情的几百毫秒里），
    //   点「修改时间」那一刻多半已在缓存 ⇒ 可选时间接近秒进（复用 M3-P1 已真机验证的预加载机制）。
    if (row.date) member.preloadAvailability([row.date, beijingDate.addDays(row.date, 1)])
    // ⭐ 打开详情 = 开启一次「调整会话」⇒ 取一个 nonce：连点两次是同一个号（幂等只落一条），
    //   关掉再开会重新取号 ⇒ 不会把上一次的结果 replay 成这一次的。
    this.sessionNonce = manage.newNonce()
    this.setData({ detail, rescheduleOpen: false, rSelected: null })
  },

  closeDetail() {
    // ⚠️ 详情关闭时若正挂着"取消二次确认"，必须**先把它判为放弃**：
    //   否则那个 Promise 永远不 resolve ⇒ requestCancel 挂住 ⇒ `managing` 锁永不释放，
    //   之后所有改期/取消都被锁挡住（用户表现为"点什么都没反应"）。
    if (this.confirmResolver) { this.confirmResolver(false); this.confirmResolver = null }
    this.setData({ detail: null, rescheduleOpen: false, rSelected: null, cancelOpen: false, cancelDesc: '' })
    this.current = null
  },

  // ------------------------------------------------------------------ 管理：取消 / 改期（⛔ 本轮零写入）
  // 当前会员**能看到**的预约 ID 名单 ⇒ 请求只许在这份名单里挑（越权在出网前就被拒）。
  ownIds() { return (this.rows || []).map(row => row && row.historyId).filter(Boolean) },

  // ⛔ 双锁：写链总闸 + §8 六条规则未定。任一为真 ⇒ 明说"暂未开放"，**零云调用**。
  blockedNotice(action) {
    if (!flags.memberManageSubmitEnabled()) {
      return { title: manage.NOTICE_TITLE, content: action === 'cancel' ? manage.CANCEL_NOTICE : manage.RESCHEDULE_NOTICE }
    }
    if (manage.policyBlocked()) {
      return { title: manage.NOTICE_TITLE, content: manage.FRIENDLY_MESSAGES.MEMBER_MANAGE_POLICY_NOT_SELECTED }
    }
    return null
  },

  showProblems(problems) {
    const text = (problems || []).map(row => row && row.message).filter(Boolean)[0] || '这次调整没有完成。'
    wx.showToast && wx.showToast({ title: text, icon: 'none' })
  },

  // ⭐ 取消是**不可逆**的动作（取消后这节课就没了）⇒ 真写入前必须有**二次确认**，
  //   而且确认框里要把"退的是占座、不是课时"说清楚（否则用户会以为课时被扣了）。
  //
  // ⭐⭐ 2026-10-04（H）：二次确认从 `wx.showModal` 换成**统一弹层** `member-sheet`。
  //   为什么值得换：系统 modal 是**另一套视觉**（系统蓝按钮、系统圆角、系统字号），
  //   和同页的改期弹层摆在一起像两个产品；而且它盖不住 iOS 的安全区语义。
  //   ⛔ 但**语义不许变**：`askConfirm` 仍然返回一个 Promise（true = 用户确认），
  //      「确认之前一次云调用都不许发」这条铁律（见 tests/m3-p4 ⑬）因此原样保留。
  //
  // ⚠️ member-sheet **只派发事件、不自己隐藏**（见 member-sheet.js 顶部注释），
  //   所以"点确认/点取消"两个出口都必须由本页把 `visible` 置 false，否则弹层关不掉。
  askConfirm(content) {
    return new Promise(resolve => {
      // ⛔ 同一时刻只允许一个待答的二次确认：连点「取消预约」两次时，
      //   第二次会把第一次的 resolver 覆盖掉 ⇒ 第一次那个 Promise 永远不 resolve（挂住的请求）。
      if (this.confirmResolver) this.confirmResolver(false)
      this.confirmResolver = resolve
      this.setData({ cancelOpen: true, cancelDesc: content })
    })
  },

  // 用户在统一弹层上按了主操作（danger 红色那颗）⇒ 真的可以写了。
  confirmCancel() {
    const resolve = this.confirmResolver
    this.confirmResolver = null
    this.setData({ cancelOpen: false, cancelDesc: '' })
    if (resolve) return resolve(true)
  },

  addToCalendar() {
    const detail = this.data.detail
    if (!detail || !detail.canManage) return
    return phoneCalendar.addCourse(detail)
  },

  // 按「再想想」/ 点右上 × / 点遮罩 ⇒ 放弃，且**保留详情与用户的位置**（她可以再点一次别的课）。
  closeCancel() {
    const resolve = this.confirmResolver
    this.confirmResolver = null
    this.setData({ cancelOpen: false, cancelDesc: '' })
    if (resolve) resolve(false)
  },

  async requestCancel() {
    const row = this.current
    if (!row) { this.showProblems([{ message: '先打开一节预约' }]); return }
    const request = manage.buildCancelRequest({ bookingViewId: row.historyId, ownViewIds: this.ownIds(), row, nonce: this.sessionNonce })
    if (!request.ok) { this.showProblems(request.errors); return }
    this.submitRequest = request
    // ⛔ 未开放/规则未定 ⇒ 只弹提示，**一次云调用都不发**（锁仍然保留，回滚只需改回开关）。
    const blocked = this.blockedNotice('cancel')
    if (blocked) { wx.showModal(Object.assign({ showCancel: false, confirmText: '知道了' }, blocked)); return }
    // ⛔ 防连点：确认框还没回来就再点，不产生第二个请求号（同一个 nonce ⇒ 同一个号，云端也只落一条）。
    if (this.data.managing) return
    const when = [row.dateText || row.date || '', row.timeText || row.time || ''].filter(Boolean).join(' ')
    // ⛔ 文案三条纪律：① 说人话（不许"物理删除/级联/软删"这种技术术语）；
    //   ② 说清**真实后果**（按六条规则：取消只释放占座，课时不减少、不计违约）；
    //   ③ 说清**不可撤销**（她需要知道点下去就回不来了）。
    const ok = await this.askConfirm(`要取消 ${when} 这节课吗？取消后这个时段会空出来，可以重新约；已经登记的课时不会减少，也不算违约。取消之后不能恢复，需要的话请重新约。`)
    if (!ok) return
    return this.runManage(request, 'cancel')
  },

  // ⭐ 改期：保留当前预约信息，进入本地日期/时间选择（**复用 M3 已有的 availability**）。
  async openReschedule() {
    const row = this.current
    if (!row) { this.showProblems([{ message: '先打开一节预约' }]); return }
    if (!view.canManageOf(row)) { this.showProblems([{ code: 'BOOKING_NOT_MANAGEABLE', message: '只有「待上课」的预约才能修改时间' }]); return }
    // ⭐ 日期范围**不写死**：来自 `occupancy.MEMBER_BOOKING_MAX_DAYS`（今天 … +30 天）。
    const dates = view.dateOptions(beijingDate.todayKey(), view.MEMBER_DATE_COUNT)
    const at = dates.findIndex(option => option.key === String(row.date || ''))
    const index = at >= 0 ? at : 0
    this.setData({
      rescheduleOpen: true, rDates: dates, rIndex: index,
      rDateKey: dates[index].key, rDateLabel: dates[index].label,
      rSlots: [], rSelected: null, rHint: ''
    })
    await this.loadRescheduleSlots()
  },

  async pickRescheduleDate(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.rDates.length) return
    const option = this.data.rDates[index]
    this.setData({ rIndex: index, rDateKey: option.key, rDateLabel: option.label, rSelected: null })
    await this.loadRescheduleSlots()
  },

  // 把一份 availability 投影翻译成可约时段（与 member-book-slots 的 refresh() 同构）。
  applyRescheduleSlots(row, dateKey, live) {
    const degraded = !live || live.availability !== true
    let bookings = this.rows
    let coachBusy = []
    if (live && live.availability === true) {
      bookings = Array.isArray(live.bookings) ? live.bookings : this.rows
      const key = String((row.coach && row.coach.coachKey) || '')
      coachBusy = (Array.isArray(live.busy) ? live.busy : []).filter(item => !key || !item || !item.coachKey || item.coachKey === key)
    }
    // ⭐ 把**这一节自己占的时间**摘掉 ⇒ 它的时段重新可选（否则整页候选被自己锁死）。
    const busy = view.rescheduleBusyOf({ bookings, coachBusy, dateKey, excludeHistoryId: row.historyId })
    const slots = view.slotsFor({
      dateKey, busy,
      todayKey: beijingDate.todayKey(), nowMinutes: nowBeijingMinutes(),
      dayStart: view.DAY_START_MINUTES, latestStart: view.LATEST_START_MINUTES, step: view.SLOT_STEP_MINUTES
    })
    return { slots, degraded }
  },

  async loadRescheduleSlots() {
    const row = this.current
    const dateKey = this.data.rDateKey
    if (!row || !dateKey) return
    // ⭐ P-1 邻日预加载（不阻塞渲染）：当前日 + 前后一天提前发出 ⇒ 切日期也秒进。
    const neighbors = [this.data.rDates[this.data.rIndex + 1], this.data.rDates[this.data.rIndex - 1]]
      .map(option => option && option.key).filter(Boolean)
    member.preloadAvailability([dateKey].concat(neighbors))

    // ⭐ 命中缓存 ⇒ **立刻出时段**（M3-P1 同款：先填画面，云端请求随后覆盖）。
    //   ⛔ 这不是"隐藏 loading 造假"：缓存里是 20 秒内的真实快照；下面这趟服务端请求**一定会发**，回来就覆盖。
    const cached = member.cachedAvailability(dateKey)
    if (cached) {
      const { slots, degraded } = this.applyRescheduleSlots(row, dateKey, cached)
      this.setData({
        rSlots: slots, rLoading: false, rRefreshing: true, rSelected: this.data.rSelected,
        rHint: degraded ? '现在只按你已排的课排除冲突，教练的其他安排暂时读不到。' : ''
      })
    } else {
      this.setData({ rSlots: [], rLoading: true, rRefreshing: false, rHint: '' })
    }
    // ⭐ 后台拉最新覆盖缓存；失败 / 拿不到 ⇒ 保留已渲染的缓存，绝不假"全天有空"。
    let live = null
    try { live = await member.availability(dateKey) } catch (error) { live = null }
    const { slots, degraded } = this.applyRescheduleSlots(row, dateKey, live || cached)
    this.setData({
      rSlots: slots, rLoading: false, rRefreshing: false,
      rHint: degraded ? '现在只按你已排的课排除冲突，教练的其他安排暂时读不到。' : ''
    })
  },

  pickRescheduleSlot(e) {
    const key = e.currentTarget.dataset.key
    const slot = this.data.rSlots.find(row => row.key === key)
    if (!slot) return
    if (!slot.available) {
      const text = slot.reason === 'booked' ? '这段时间已经排了课，换一个时间试试'
        : slot.reason === 'past' ? '这个时间已经过去了'
          : '这个时间上完课会超过 24:00'
      wx.showToast && wx.showToast({ title: text, icon: 'none' })
      return
    }
    this.setData({ rSelected: slot })
    return this.confirmReschedule()   // ⭐ 点选即提交：不再需要第二个「确认修改」按钮
  },

  closeReschedule() { this.setData({ rescheduleOpen: false, rSelected: null }) },

  confirmReschedule() {
    const row = this.current
    if (!row) { this.showProblems([{ message: '先打开一节预约' }]); return }
    if (!this.data.rSelected) { this.showProblems([{ message: '先选一个新的时间' }]); return }
    const request = manage.buildRescheduleRequest({
      bookingViewId: row.historyId, ownViewIds: this.ownIds(), row,
      dateKey: this.data.rDateKey, slot: this.data.rSelected, todayKey: beijingDate.todayKey(),
      nonce: this.sessionNonce
    })
    if (!request.ok) { this.showProblems(request.errors); return }   // ⛔ 保留选择，让她换时间再试
    this.submitRequest = request
    const blocked = this.blockedNotice('reschedule')
    if (blocked) { wx.showModal(Object.assign({ showCancel: false, confirmText: '知道了' }, blocked)); return }
    return this.runManage(request, 'reschedule')
  },

  // M3-P6 · 真正写云端（取消 / 改期共用）。`action` 只影响**成功后的那句话**，不影响判定。
  //   ⛔ 成功的判据永远是**云端返回 ok**，不是"我们发出去过" —— 假成功在这里是最贵的一种 bug。
  //
  // ⭐ P-2 第二轮（2026-10-01）：**改期**改为 Local-first（首帧更新 + 后台提交）；
  //   **取消**走 `runBlocking` 保持原样（已真机验证，本轮不引入新变量）。
  async runManage(request, action) {
    if (this.data.managing) return                                   // 防连点：同一次会话只允许一笔在飞
    this.setData({ managing: true })
    return this.runLocalFirst(request, action)
  },

  // ⭐ 取消 / 改期 **共用同一套** Local-first 流程（顺序 ⛔ 不许调换）：
  //   ① 提交**前**存深拷贝快照 → ② 首帧改列表 + 收起面板 → ③ 云端**后台**提交 → ④ 按服务端结果落定 / 无损回滚。
  //   ⛔ 本地只是"先显示"，成功与否**永远由云端终判**；`managing` 锁在整个落定过程内保持 ⇒ 不会重复提交。
  //   ⛔ 全程**没有** `wx.showLoading({ mask:true })` ⇒ 用户主流程不被阻塞（取消也一样，不再硬等 2 秒）。
  async runLocalFirst(request, action) {
    const row = this.current
    // ① 快照（**深拷贝**）：回滚源，绝不能被随后的乐观修改污染（引用赋值会让快照跟着一起变）。
    const snapshot = row ? JSON.parse(JSON.stringify(row)) : null
    // ② 首帧 Local-first：列表立即可见新状态 + 面板立即收起（⛔ 不等 `submitMemberManage` 返回）。
    if (action === 'cancel') this.applyOptimisticCancel(row)
    else this.applyOptimisticReschedule(row, request.payload)
    this.setData({ detail: null, rescheduleOpen: false, rSelected: null })
    // ③ 云端后台提交
    let result = null
    try {
      result = await member.submitMemberManage(request)
    } catch (error) {
      result = { ok: false, code: 'MEMBER_MANAGE_RESULT_UNKNOWN', message: '调整结果待确认，请勿重复提交。' }
    }
    // ④ 落定（成功 / 不确定 / 明确失败 三条路互斥）
    if (result && result.ok) return this.settleSuccess(result, action)
    if (result && result.code === 'MEMBER_MANAGE_RESULT_UNKNOWN') return this.settleUnknown(request, snapshot, action)
    return this.settleFailure(result, snapshot, action)
  },

  // ⑤ 服务端已批准 ⇒ **静默**确认（⛔ 不弹阻塞 modal），并对账到服务端真相。
  //   ⭐ `await` 只影响这个 Promise 什么时候 resolve，**不阻塞用户** —— 界面早在首帧就更新完了。
  async settleSuccess(result, action) {
    this.clearOptimistic()                                            // ⛔ 已落定 ⇒ 之后一律以服务端真相为准
    this.setData({ managing: false })                                 // 锁先放 ⇒ 用户可以立刻继续操作
    const cancelled = action === 'cancel'
    // ⭐ 2026-10-01：成功提示统一为「预约已取消」/「时间更改成功」，且**紧跟**服务端 ok（非阻塞轻提示）。
    wx.showToast && wx.showToast({ title: cancelled ? manage.SUCCESS_TEXT.cancel : manage.SUCCESS_TEXT.reschedule, icon: 'none' })  // ⛔ 非阻塞
    await this.load(true).catch(() => {})                             // 对账：以服务端真相覆盖本地临时值
    return result
  },

  // ⑥ 服务端**明确拒绝**（时间冲突 / revision 冲突 / 状态不允许…）⇒ 用快照**无损**恢复 + 明说。
  //   ⛔ 原预约不会丢：回滚把 date/hour/minute/status 全部还原成提交前的值。
  settleFailure(result, snapshot, action) {
    this.clearOptimistic()
    this.restoreRescheduleSnapshot(snapshot)
    this.setData({ managing: false })
    wx.hideLoading && wx.hideLoading()
    wx.showModal && wx.showModal({
      title: action === 'cancel' ? '取消失败，已恢复原预约' : '改期失败，已恢复原时间',
      content: manage.friendlyMessageOf(result && result.code, result && result.message),
      showCancel: false, confirmText: '知道了'
    })
    return result
  },

  // ⑦ 结果**不确定**（网络超时 / UNKNOWN）⇒ ⛔ 不宣告成功、也**不**立刻宣告失败：
  //   ⇒ 用**同一个 requestId** 幂等重放一次（服务端收据终裁：已成功就重放收据，没成功就补做一次，
  //      同一 requestId ⇒ 绝不会产生第二笔）；
  //   ⇒ 仍不确定则以**服务端回读**为准 —— `load(true)` 会用服务端真相覆盖本地临时状态。
  async settleUnknown(request, snapshot, action) {
    let retry = null
    try {
      retry = await member.submitMemberManage(request)              // ⭐ 同 requestId ⇒ 云端幂等
    } catch (error) {
      retry = null
    }
    if (retry && retry.ok) return this.settleSuccess(retry, action)
    if (retry && retry.code && retry.code !== 'MEMBER_MANAGE_RESULT_UNKNOWN') {
      return this.settleFailure(retry, snapshot, action)
    }
    // 仍然不确定 ⇒ 最后一次裁决：**服务端回读**
    //   ⛔ 必须先清乐观保护：否则回读时被自己的乐观值挡住 ⇒ 永远"看起来是新的" ⇒ 把失败误判成成功。
    this.clearOptimistic()
    try { await this.load(true) } catch (error) { /* 读不到就保持现状，下次进屏再对账 */ }
    const current = snapshot ? (this.rows || []).find(item => item && item.historyId === snapshot.historyId) : null
    const unchanged = !!current
      && String(current.date) === String(snapshot.date)
      && Number(current.hour) === Number(snapshot.hour)
      && Number(current.minute) === Number(snapshot.minute)
      && String(current.status || '') === String(snapshot.status || '')
    this.setData({ managing: false })
    if (unchanged) {
      return this.settleFailure(
        { ok: false, code: 'MEMBER_MANAGE_RESULT_UNKNOWN', message: '网络不稳定，这次调整没有完成，已恢复原来的时间。' },
        snapshot, action
      )
    }
    return this.settleSuccess(retry || { ok: true }, action)
  },

  // ⭐ 乐观更新（**首帧**调用，在云端返回**之前**）：把这一节先显示成新状态。
  //   ⛔ 它只改**显示**；成功与否由云端终判 —— 明确失败会被 `restoreRescheduleSnapshot` 完整还原。
  //   ⭐ `markOptimistic` 让后台对账期间不会被服务端的旧投影短暂顶回去（防闪烁）。
  applyOptimisticReschedule(row, payload) {
    if (!row || !payload) return
    const target = (this.rows || []).find(item => item && item.historyId === row.historyId)
    if (!target) return
    const patch = { date: String(payload.date), hour: Number(payload.hour), minute: Number(payload.minute) }
    Object.assign(target, patch)
    this.markOptimistic(row.historyId, patch)
    this.renderRows()
  },
  applyOptimisticCancel(row) {
    if (!row) return
    const target = (this.rows || []).find(item => item && item.historyId === row.historyId)
    if (!target) return
    const patch = { status: 'cancelled' }
    Object.assign(target, patch)
    this.markOptimistic(row.historyId, patch)
    this.renderRows()
  },
  // ⛔ 无损回滚：用提交**前**的深拷贝快照把这一节还原成原样（日期 / 时间 / 状态）⇒ 原预约不会丢。
  //   快照是深拷贝 ⇒ 乐观修改**不可能**污染回滚源（这一条有专门的判别力测试）。
  //   ⭐ 取消与改期**共用**这一条：取消失败同样完整恢复原预约。
  restoreRescheduleSnapshot(snapshot) {
    if (!snapshot) return
    const target = (this.rows || []).find(item => item && item.historyId === snapshot.historyId)
    if (!target) return
    target.date = snapshot.date
    target.hour = snapshot.hour
    target.minute = snapshot.minute
    target.status = snapshot.status
    this.renderRows()
  },
  // ⭐ 只重算待上课 / 历史两栏（不重新读网络、不动课包索引），供乐观更新后即时刷新。
  renderRows() {
    const split = view.splitBookings(this.rows || [], this.packagesById, this.archivesById)
    this.setData({
      upcoming: split.upcoming, history: split.history,
      ...historyViewOf(split.history, this.data.historyFilter)
    })
  },

  goBook() { wx.navigateTo({ url: '/pages/member-book-slots/member-book-slots' }) },
  noop() { }
})
