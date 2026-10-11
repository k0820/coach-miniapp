// M3 P1-2 / P1-3 · 会员「可约时间」+ 预约确认（M3-P3 起：**真实提交**）
//
// ✅ 2026-09-30 M3-P3：确认按钮已接通 `submitMemberBooking()`（真实 `createMemberBooking`）。
//    三条铁律（改这个页面前先读）：
//      · **不许假成功**：只有服务端返回 ok 才说「预约成功」；失败必须明说原因并**保留用户的选择**；
//      · **不许重复提交**：loading 期间再次点击直接返回（`submitting` + 实例锁两道），
//        云端还有 requestId 幂等兜底 ⇒ 双击最多一条预约；
//      · **不许本地判权限**：能不能约全由云端裁决，这里只负责把界面追上裁决结果。
//    ⛔ 云端 `coachBusinessCommand` 尚未部署 ⇒ 真机上现在点确认会失败（这是预期，不是 bug）；
//       部署之前本页不许开给会员点（见 `release-flags.MEMBER_BOOKING_SUBMIT` 的注释）。
//
// ⭐ 日期的**唯一真相源是 `dateIndex`**（BUG05 的形状：写 index、读另一份只在打开时赋一次的快照 ⇒
//    选了 9-30、提交/显示却是 9-29）。这里所有取日期的地方一律 `dates[dateIndex].key`，不存第二份。
const member = require('../../utils/member-runtime')
const theme = require('../../utils/member-theme')
const view = require('../../utils/member-booking-view')
const beijingDate = require('../../utils/beijing-date')
const requestBuilder = require('../../utils/member-booking-request')
const flags = require('../../utils/release-flags')
// ⭐⭐ 当前这位会员的资料（2026-10-06 新方案：**始终只有一份**）：约课页的教练与课时包**必须**都属于它。
//   ⛔ 全站唯一的会员资料状态出口，⛔ 本页不许自己写第二套 filter。
const archiveState = require('../../utils/member-archive-state')

// 还没有会员资料时说的那句人话（⛔ 不许显示成"没有可预约的教练" —— 那是另一件事）。
const NO_ARCHIVE_TEXT = '还没有会员资料，请先从会员入口填写昵称创建账号。'
// ⭐ 2026-10-07（1.3.36）：**技术失败不许伪装成"没有可约时间"**（真机 1.3.35 的形状之一：
//   服务端其实没读到东西，界面却说"这一天没有可约时间" ⇒ 会员以为教练那天真的满了）。
const READ_FAILED_TEXT = '暂时读取失败，请下拉重试。'
// ⭐ 「有会员资料、但没有可约教练」—— 与"还没绑定资料"是两件事，不许混成一句。
const NO_COACH_TEXT = '还没有绑定教练录入的会员资料。'

function nowBeijingMinutes() {
  const at = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return at.getUTCHours() * 60 + at.getUTCMinutes()
}

// ⭐ 等待期间那句话：**必须**写明"还在占"，不许让用户误读成已经成功。
const ECHO_NOTE = '正在让教练的排课表让出这个时间，稍等一下…'

Page({
  data: {
    themeStyle: '', dates: [], dateIndex: 0, dateKey: '', dateLabel: '',
    slots: [], coaches: [], coachIndex: 0, packages: [], selected: null,
    // ⭐ 2026-10-01 真机阻断 Bug 修复：会员有多份档案 ⇒ 多个课时包**必须能点选**，
    //   确认框与提交都**只能用用户实际选中的那一个**（原来写死 `packages[0]`）。
    packageIndex: 0, packagesSelectable: false, packageHint: '', confirmPackage: null,
    confirmOpen: false, loading: true, refreshing: false, error: '', notice: '', hint: '', degraded: false, canPrev: false, canNext: true,
    submitting: false, submitNote: '',
    // ⭐ 2026-10-06 档案维度：当前档案（空 = 还没认领 / 多份但没选过）
    archiveId: '', archiveName: '', archiveEmpty: '', noPackageText: ''
  },
  source: { bookings: [], coachBusy: [], packages: [], coaches: [] },
  // ⭐ 学员档案名索引（`{archiveId: name}`）：**只有多份档案**才有内容 ⇒ 单档案用户一行档案名都不多显示。
  archivesById: {},
  // ⭐ 当前选中的课包（`packageViewId`）—— 跨刷新保持选择，绝不回落到"第一个"。
  selectedPackageId: '',

  onLoad(options) {
    // ⭐ 会员首页点了某一位教练跳进来 ⇒ 默认选中**那一位**。
    //   ⛔ 用 `contactKey` 认人（与首页教练卡、服务端 `coachContactKey` 同一个算法），
    //      ⛔ 不能用 `coachKey` —— 首页卡片上没有它，两边串不上就会"点了 A 却选中 B"。
    this.wantedCoachKey = String((options && options.coach) || '')
  },
  onShow() { this.load() },
  async onPullDownRefresh() {
    await this.refresh({ force: true })
    wx.stopPullDownRefresh && wx.stopPullDownRefresh()
  },

  async load(options = {}) {
    const today = beijingDate.todayKey()
    // ⭐ 可约天数**不写死**：来自 `occupancy.MEMBER_BOOKING_MAX_DAYS`（今天 + 30 天 = 31 个选项）。
    const dates = view.dateOptions(today, view.MEMBER_DATE_COUNT)
    this.setData({
      themeStyle: theme.cssVars(),
      dates, dateIndex: 0, dateKey: dates[0].key, dateLabel: dates[0].label,
      canPrev: false, canNext: dates.length > 1
    })
    // ⭐ M3-P1 预加载：把「今天 / 明天」两天的可约时间**提前**发出去（不 await、不阻塞渲染）
    //   ⇒ 用户点进日期时多半已经在路上或已到，省掉一整趟等待。
    member.preloadAvailability([dates[0].key, dates[1] && dates[1].key])
    await this.refresh({ force: options.force !== false })
  },

  // 把一份 availability 投影落到页面上。缓存命中时先调它（画面立刻出来），
  // 拿到服务端最新结果后再调一次（覆盖）—— 所以**永远不会**停在旧数据上。
  // ⭐ 当前使用哪一份档案（⛔ **绝不猜**：多份且用户还没选过 ⇒ 空 ⇒ 页面明说"请先选择"）。
  //   ⛔ 只有一份 ⇒ 与 `member-archive-state` 的「单份自动选中」同口径；多份 ⇒ 空（不替用户决定）。
  currentArchiveId(live) {
    const archives = Array.isArray(live && live.archives) ? live.archives : []
    try {
      const cached = member.cached()
      if (cached) {
        const state = archiveState.current(cached)
        if (state && state.archiveId) return { id: state.archiveId, count: archives.length || archiveState.archivesOf(cached).length }
        if (state && state.mode === 'none') return { id: '', count: 0 }
      }
    } catch (error) { /* 读不到缓存 ⇒ 退回 live.archives 那一份 */ }
    if (archives.length === 1) return { id: String(archives[0].archiveId || ''), count: 1 }
    return { id: '', count: archives.length }
  },

  // ⭐ 默认选中哪一位教练（优先级从上到下）：
  //   ① 会员在首页点的那一位（`?coach=contactKey`）⇒ 点谁就是谁；
  //   ② 本页上一次选过、而且这一位还在 ⇒ 保持；
  //   ③ 第 0 位。
  //   ⛔ 没有名单时返回 0 ⇒ 界面自己会显示"还没有教练"，不画任何假的卡片。
  pickCoachIndex(coaches) {
    const list = Array.isArray(coaches) ? coaches : []
    if (!list.length) return 0
    const wanted = String(this.wantedCoachKey || '')
    if (wanted) {
      const at = list.findIndex(row => row && String(row.contactKey || '') === wanted)
      if (at >= 0) return at
    }
    const current = Number(this.data.coachIndex)
    return current > 0 && current < list.length ? current : 0
  },

  applyAvailability(live) {
    const degraded = !live || live.availability !== true
    const bookings = Array.isArray(live && live.bookings) ? live.bookings : []
    let coaches = Array.isArray(live && live.coaches) ? live.coaches : []
    const packages = Array.isArray(live && live.packages) ? live.packages : []
    const coachBusy = Array.isArray(live && live.busy) ? live.busy : []
    // ⭐⭐ 2026-10-06：先定**当前档案**，再用它同时约束教练与课时包。
    //   ⛔ 顺序不能反：先筛教练后定档案 ⇒ 历史档案的教练会被当成"当前档案的教练"留下来。
    const picked = this.currentArchiveId(live)
    this.archiveId = picked.id
    // ⛔ 档案维度**拿不到**（`archives` 一次都没下发过，例如退化只读路径）⇒ **走老路**：
    //    不缩教练、不缩课时包、也不报错。理由与 `coachesForArchive` 的老云端退化一致 ——
    //    「为了保险把画面清空」比显示错更糟（界面说没教练，其实有）。
    // ⛔⛔ 2026-10-07（1.3.36）：**档案闸门撤掉**。
    //   新会员方案里一位会员恒一份资料（§19：会员端不再暴露 archive / claim 这类词）。
    //   ⇒ 课时包与教练直接采用服务端下发的全量（服务端已经按"这位会员"筛过了），
    //   ⛔ 不许再因为"档案读不到 / 还没选档案"把整页变成一个错误页 ——
    //      那正是 1.3.35 真机「首页看得到张三与10节、约课页却整页空白」的第二道放大器。
    const ownPackages = packages
    // ⛔ 空态必须**明说原因**，⛔ 绝不塞一个假的「教练」占位（那会让会员点了才被云端拒绝）。
    const archiveEmpty = coaches.length
      ? ''
      : (live && live.state === 'unregistered' ? NO_ARCHIVE_TEXT : NO_COACH_TEXT)
    // ⭐ 同名教练 ⇒ 补**身份标签**（管理人 / 授课教练）；同名又同身份才再补教练码尾号。
    //   ⛔ 只加工展示字段，**不动顺序、不动 coachIndex、不动授权判定**。
    // 单教练产品：优先使用资料所属的管理教练；旧的多教练关系只保留在历史数据中。
    coaches = view.coachOptionsView(coaches)
    const primary = coaches.find(row => row && (row.roleKey === 'owner' || row.roleKey === 'manager' || /管理/.test(String(row.role || '')))) || coaches[0]
    coaches = primary ? [primary] : []
    this.source = { bookings, coachBusy, packages: ownPackages, coaches }
    const coachIndex = this.pickCoachIndex(coaches)
    // ⭐ 多份学员档案时，可用课时包要能看出"这份包属于哪份档案"（会员点错档案就约错人）。
    this.archivesById = view.archiveNameIndex(Array.isArray(live && live.archives) ? live.archives : [])
    const currentName = (this.archivesById && picked.id && this.archivesById[picked.id]) || ''
    this.setData({
      coaches, coachIndex, degraded,
      archiveId: picked.id, archiveName: currentName, archiveEmpty,
      // ⛔ 这位学员一份课时包都没有 ⇒ 明说（空壳测试学员就是这个形状，⛔ 不许伪造课包顶上）。
      noPackageText: picked.id && !ownPackages.length ? view.NO_PACKAGE_FOR_ARCHIVE : '',
      hint: degraded ? '现在只按你已排的课排除冲突，教练的其他安排暂时读不到。' : ''
    })
    // ⭐ 课包名单**先落到 data.coaches 之后**再筛 ⇒ 换教练只影响"能选哪些包"，不影响时段。
    //   ⛔ `usablePackages` 过滤过（未作废 + 还有可约余额）的那份**存下来**：换教练时复用它，
    //      绝不拿 `source.packages`（原始投影）去筛 —— 那会把已作废 / 余额为 0 的课包重新放出来。
    //   ⛔ 而且只喂**当前档案**的那几份：`packagesForArchive` 已经把别的档案摘掉了。
    this.packageRows = view.usablePackages(ownPackages, this.archivesById)
    this.applyPackages(this.packageRows, { reset: false })
  },

  // ---------------------------------------------------------------- 课时包选择（可点选 / 记选择 / 提示）
  //
  // ⛳ 真机阻断 Bug：3 份档案 ⇒ 3 个课时包，界面却一个都点不动，确认与提交永远是 `packages[0]`。
  //   这里把"选哪个包"变成页面状态（`packageIndex` + `selectedPackageId`），
  //   ⛔ 提交恒读它，⛔ 再也不写死第一个。
  applyPackages(rows, options = {}) {
    const coach = this.data.coaches[this.data.coachIndex] || {}
    // ⛔ 带上当前档案 id：换教练只影响"能选哪些包"，⛔ 绝不能把别份档案的课包放进来。
    const rowsForCoach = view.packagesForCoach(rows, coach.coachKey, this.archiveId || this.data.archiveId || '')
    const index = options.reset ? 0 : this.keepPackageSelection(rowsForCoach)
    this.selectedPackageId = rowsForCoach.length ? (rowsForCoach[index] || {}).packageViewId || '' : ''
    // ⛔ 只有**一个**可点的包时 `packagesSelectable=false`：单课包用户不多一个动作、不多一句提示。
    const selectable = rowsForCoach.length > 1
    this.setData({
      packages: rowsForCoach.map((row, at) => Object.assign({}, row, { selected: at === index })),
      packageIndex: index, packagesSelectable: selectable,
      // ⭐ 两种"没有课包"必须分开说（⛔ 混成一句 ⇒ 会员不知道该找教练建包还是换教练）：
      //   ① 这份档案一份课包都没有 ⇒ 让教练去创建；
      //   ② 有课包但这位教练没被授权 ⇒ 换教练或让管理人开通授权。
      packageHint: !rowsForCoach.length
        ? (!rows.length ? view.NO_PACKAGE_FOR_ARCHIVE : '这位教练暂时没有可用于你课时包的授课授权，换一位教练，或让管理你课时的教练先开通授权。')
        : ''
    })
  },
  // 换教练 / 刷新后：优先保持原来那个包，还在就继续用；不在了退回第一个（⛔ 绝不静默选成"别人的包"）。
  keepPackageSelection(rows) {
    const wanted = String(this.selectedPackageId || '')
    if (wanted) {
      const at = rows.findIndex(row => row && row.packageViewId === wanted)
      if (at >= 0) return at
    }
    const current = Number(this.data.packageIndex)
    return rows.length && current > 0 && current < rows.length ? current : 0
  },
  // ⛔ 取值规则只有**一处**（`view.selectedPackageOf`）⇒ 提交、确认框、选中态不可能各说一套。
  currentPackage() { return view.selectedPackageOf(this.data.packages, this.data.packageIndex) },
  pickPackage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const row = (this.data.packages || [])[index]
    if (!row || !this.data.packagesSelectable) return
    this.selectedPackageId = row.packageViewId || ''
    this.setData({
      packageIndex: index,
      packages: this.data.packages.map((item, at) => Object.assign({}, item, { selected: at === index })),
      confirmPackage: this.confirmPackageOf()
    })
  },
  // 确认框里的"课包"那一行 ⇒ **用户实际选中的**那一个（含档案名，多档案时能看出用谁的课时）。
  confirmPackageOf() {
    const row = this.currentPackage()
    if (!row) return null
    return { typeName: row.typeName || '', archiveName: row.archiveName || '', coachName: row.coachName || '', remaining: row.remaining || 0, packageViewId: row.packageViewId || '' }
  },

  async refresh(options = {}) {
    const option = this.data.dates[this.data.dateIndex]
    if (!option) return
    const dateKey = option.key
    const cached = member.cachedAvailability(dateKey)
    this.setData({
      dateKey, dateLabel: option.label, confirmOpen: false, selected: null, error: '',
      // ⭐ M3-P1：命中缓存 ⇒ **立刻结束 loading**，画面马上出来。
      //   ⛔ 这不是"隐藏 loading 造假"：缓存里是 20 秒内的**真实快照**，而且同时用 `refreshing`
      //      明写「正在核对最新排课…」；下面这一趟服务端请求**一定会发**，回来就覆盖。
      loading: !cached, refreshing: !!cached
    })
    if (cached) { this.applyAvailability(cached); this.renderSlots() }
    let live = null
    try { live = await member.availability(dateKey, { force: options.force === true }) } catch (error) { live = null }
    if (live) this.applyAvailability(live)
    else if (!cached) {
      // ⛔ 拿不到新版只读投影 ⇒ **明说退化**，绝不假装"教练全天有空"。
      let data = null
      try { data = await member.read({ allowCache: true }) } catch (error) { data = null }
      const bookings = [].concat((data && data.nextBooking) ? [data.nextBooking] : []).concat((data && data.recentTraining) || [])
      // ⛔ 2026-10-01 审计修复：退化路径原来把 `data.coaches`（含会员自己添加的「常用教练」）
      //    整份当成可约教练 ⇒ 会员选了一位**从未被授权**的教练去提交 ⇒ 云端报 COACH_NOT_AVAILABLE
      //    ⇒ "界面看得见、点了说不能"。可约教练**只**认服务端下发的 `bookable === true`。
      const bookable = ((data && data.coaches) || []).filter(row => row && row.bookable === true)
      // ⛔ 2026-10-07（1.3.36）：两种"读不到"必须**分开说**：
      //   ① 服务端明确回答「还没绑定会员资料」 ⇒ 会员名下真的没东西可读 ⇒ 说人话让他去绑定；
      //   ② 其余（网络失败 / 服务端异常 / 投影拿不到）⇒ 明写「读取失败，请重试」。
      //   ⛔ 绝不再统一说成"没有可约的教练"/"没有可约时间" —— 那是把**故障**伪装成**教练满了**。
      if (!data || !bookable.length) {
        const unregistered = !data || data.state === 'unregistered'
        this.setData({ loading: false, refreshing: false, error: unregistered ? NO_ARCHIVE_TEXT : READ_FAILED_TEXT, slots: [], selected: null, confirmOpen: false })
        return
      }
      this.applyAvailability({ availability: false, bookings, coaches: bookable, packages: (data && data.packages) || [], archives: (data && data.archives) || [], busy: [] })
    }
    // ⛔ 档案为空**不再**把整页变成一个错误页（⛔ 那是 1.3.35 真机症状的放大器）。
    //   选择教练 / 可约时间 / 课时包三块照常渲染，由界面各自明说"为什么没有"。
    this.setData({ loading: false, refreshing: false, error: '' })
    this.renderSlots()
  },

  renderSlots() {
    const option = this.data.dates[this.data.dateIndex]
    if (!option) return
    // ⛔ 没有可约教练 ⇒ 一节课都不画（课表空着会被读成"教练全天有空"）。
    if (!this.data.coaches.length) { this.setData({ slots: [], selected: null }); return }
    const coach = this.data.coaches[this.data.coachIndex] || {}
    const coachBusy = this.source.coachBusy.filter(row => !row || !row.coachKey || !coach.coachKey || row.coachKey === coach.coachKey)
    const busy = view.busyOf({ bookings: this.source.bookings, coachBusy, dateKey: option.key })
    const slots = view.slotsFor({
      dateKey: option.key, busy,
      todayKey: beijingDate.todayKey(), nowMinutes: nowBeijingMinutes(),
      dayStart: view.DAY_START_MINUTES, latestStart: view.LATEST_START_MINUTES, step: view.SLOT_STEP_MINUTES
    })
    this.setData({ slots, selected: null })
  },

  // ⭐ 只改 `dateIndex`，下面所有显示都**从它派生** ⇒ 不可能出现"选了 A、显示 B"。
  //    ⚠️ 必须是 async 并 await refresh：不 await 的话，调用方会在刷新完成前就读到上一帧的时段。
  async pickDate(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.dates.length) return
    this.setData({ dateIndex: index, canPrev: index > 0, canNext: index < this.data.dates.length - 1 })
    await this.refresh()
  },

  prevDay() { this.pickDate({ currentTarget: { dataset: { index: this.data.dateIndex - 1 } } }) },
  nextDay() { this.pickDate({ currentTarget: { dataset: { index: this.data.dateIndex + 1 } } }) },

  pickCoach(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.coaches.length) return
    this.setData({ coachIndex: index })
    // ⭐ 换教练 ⇒ 候选课包换成**这位教练被授权的那些**，原先选中的包多半已经不适用 ⇒ 重新起选。
    this.applyPackages(this.packageRows || [], { reset: true })
    this.renderSlots()
  },

  pickSlot(e) {
    const key = e.currentTarget.dataset.key
    const slot = this.data.slots.find(row => row.key === key)
    if (!slot) return
    if (!slot.available) {
      const text = slot.reason === 'booked' ? '这段时间已经排了课，换一个时间试试' : slot.reason === 'past' ? '这个时间已经过去了' : '这个时间上完课会超过 24:00'
      wx.showToast && wx.showToast({ title: text, icon: 'none' })
      return
    }
    // ⭐ 确认框里的课包/档案必须是**打开这一刻**用户选中的那一个（不是 packages[0]）。
    this.setData({ selected: slot, confirmOpen: true, confirmPackage: this.confirmPackageOf() })
    // ⭐ 打开确认层 = 开启一次「提交会话」⇒ 生成**这一个会话**的幂等号
    //   （连点两次 / 超时重发都用同一个号 ⇒ 云端只落一条；关掉再开会重新取号 ⇒ 取消后能重约同一时段）。
    this.submitRequest = this.buildRequest(slot)
  },

  closeConfirm() { this.setData({ confirmOpen: false }); this.submitRequest = null },

  // 把页面当前的选择拼成**服务端要的那一个请求结构**（⛔ 不含任何身份/定位字段）。
  //   ⛔ 只提交服务端派生的不透明标识：coachKey / packageViewId。
  buildRequest(slot) {
    const option = this.data.dates[this.data.dateIndex]
    if (!option || !slot) return null
    const coach = this.data.coaches[this.data.coachIndex] || {}
    // ⛔ 真机阻断 Bug 的修复点：**提交用户实际选中的那一份课包**，绝不写死 `packages[0]`。
    //   ⛔ 顺带守住"所选课包真的授权给当前教练"：`currentPackage()` 的名单已经过
    //      `packagesForCoach` 过滤 ⇒ 没被授权的那一包根本不在这份 `data.packages` 里。
    const chosen = this.currentPackage()
    const request = requestBuilder.buildBookingRequest({
      dateKey: option.key, slot,
      // ⭐ 客户端预检（30 天窗口 / 24:00）：只为了减少一次白跑，**不是**安全边界。
      todayKey: beijingDate.todayKey(),
      coachKey: coach.coachKey || '',
      packageViewId: chosen ? chosen.packageViewId : '',
      nonce: requestBuilder.newNonce()
    })
    return request.ok ? request : null
  },

  // ⛔ 未开放（总闸关掉）时**一律**先明说"暂未开放" —— 不许用 toast 或假成功糊过去。
  submit() {
    if (!flags.memberBookingSubmitEnabled()) {
      wx.showModal({
        title: requestBuilder.SUBMIT_NOTICE_TITLE,
        content: requestBuilder.SUBMIT_NOTICE,
        showCancel: false, confirmText: '知道了'
      })
      return
    }
    // ⛔ 防连点两道：① 按钮 `disabled="{{submitting}}"`（界面层，微信小程序自己拦）；
    //    ② `runSubmit` 里的实例锁（逻辑层，直接调方法也拦得住）。两层都要在，
    //    ⚠️ 但判据只有一个 ⇒ 反证脚本拆掉实例锁就必须变红（拆掉界面层那道测不出来 ⇒ 会假绿）。
    const request = this.submitRequest || this.buildRequest(this.data.selected)
    if (!request) {
      wx.showToast && wx.showToast({ title: '先选好教练和可用的课时包', icon: 'none' })
      return
    }
    return this.runSubmit(request)
  },

  // ✅ 真实提交（M3-P3）。四条纪律：
  //   ① 只有服务端 `ok` 才说「预约成功」；失败不许弹成功（假成功比不做更糟）；
  //   ② 失败**保留用户当前选择**（不关弹层、不清 selected）⇒ 他可以立刻换一个时间再来；
  //   ③ 点下去的**同一帧**界面就要有反应 —— 不许让用户盯着一个毫无变化的弹窗等云端；
  //   ④ 成功后本机先把这一格标成"已排课"，不再卡一整趟整页刷新。
  //
  // ⭐⭐ 2026-10-01「提交要 2 秒」必须拆成两件事讲清楚（用户要求 ⑧）：
  //   · **界面响应时间** = 手指离开屏幕 ⇒ 屏幕上出现明确状态（纯本机渲染，应当接近 0）；
  //   · **云端确认时间** = 真实网络往返 + 云函数执行（这段改不了，也不许拿本地回声冒充）。
  //   ⛔ 「已经帮你排好」这句话**只能**在服务端返回 ok 之后出现；
  //      等待期间那句文案必须写明"还在占这个时间"，而不是"已成功"。
  async runSubmit(request) {
    if (this.submitLock) return { ok: false, code: 'MEMBER_BOOKING_SUBMITTING' }
    this.submitLock = true
    // ⭐ 第一帧就给反馈：先 setData，**然后**才去发网络请求（中间不许夹任何 await）。
    this.setEcho(request, 'pending')
    this.setData({ submitting: true, submitNote: ECHO_NOTE })
    let result = null
    try {
      result = await member.submitMemberBooking(request)
    } finally {
      this.submitLock = false
      this.setData({ submitting: false, submitNote: '' })
    }
    if (result && result.ok) {
      // ⭐ 服务端真的建好了 ⇒ 本地回声"转正"：这一格就是被这条路排掉的。
      this.setEcho(request, 'confirmed')
      wx.showModal({ title: requestBuilder.SUCCESS_TITLE, content: requestBuilder.SUCCESS_TEXT, showCancel: false, confirmText: '好的' })
      this.setData({ confirmOpen: false, selected: null })
      this.submitRequest = null
      // ⛔ **不再**在这里 `await this.refresh({force:true})`：
      //    旧写法成功之后还要硬等多一整趟往返（那是真机"还在转"的一部分）。
      //    真正的数据由 runtime 的后台对账补齐；下次进屏 `onShow` 也会拉最新。
      return result
    }
    // ⛔ 失败 ⇒ **立刻撤回**本地回声：界面不许留着一个其实没约上的"已排课"（那是最糟的假成功）。
    this.setEcho(request, 'revert')
    wx.showModal({
      title: requestBuilder.FAIL_TITLE,
      content: requestBuilder.friendlyMessageOf(result && result.code, result && result.message),
      showCancel: false, confirmText: '知道了'
    })
    return result
  },

  // ⭐ 本地回声：把"刚刚点下去的那一格"本机标成占住。三种动作：
  //   · pending   ⇒ 还没收到服务端结论（意思是"正在帮你占"，**不是**成功）；
  //   · confirmed ⇒ 服务端已确认（这句话才允许用户理解成已排课）；
  //   · revert    ⇒ 撤回（`this.echoBackup` 里存的就是点下去之前那一格的**原样**）。
  // ⛔ 只改这一帧的显示，**不写 storage、不动 source、不改任何判定数据** ⇒
  //    下一趟服务端结果过来会被整份覆盖，回声不可能长期冒充真相。
  setEcho(request, action) {
    const key = this.echoKeyOf(request)
    if (!key) return
    const index = this.data.slots.findIndex(row => row && row.key === key)
    if (index < 0) return
    if (action === 'revert') {
      const backup = this.echoBackup && this.echoBackup.key === key ? this.echoBackup.slot : null
      if (!backup) return
      this.echoBackup = null
      this.setData({ slots: this.data.slots.map((row, at) => (at === index ? backup : row)) })
      return
    }
    const current = this.data.slots[index]
    if (!this.echoBackup) this.echoBackup = { key, slot: { ...current } }
    // ⛔ reasonText 与 stateText **必须一起改**：前者服务于既有断言（且区分"已排课/正在占"），
    //    后者是画面真正读的那个字段（`{{stateText}}`）。只改一个 ⇒ 那一格会显示成"可约"。
    const echo = action === 'confirmed'
      ? { ...current, available: false, reason: 'booked', reasonText: '已排课', stateText: '已排课', echo: true }
      : { ...current, available: false, reason: 'booked', reasonText: '正在占', stateText: '正在占', echo: true }
    this.setData({ slots: this.data.slots.map((row, at) => (at === index ? echo : row)) })
  },

  // ⭐ 回声落在哪一格：从**提交的内容本身**算出来（不需要任何猜测，也不需要云端返回）。
  echoKeyOf(request) {
    const payload = (request && request.payload) || {}
    const pad = value => String(value).padStart(2, '0')
    const date = String(payload.date || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ''
    return `${date}#${pad(payload.hour)}:${pad(payload.minute || 0)}`
  },

  goBookings() { wx.navigateTo({ url: '/pages/member-bookings/member-bookings' }) },
  noop() { }
})
