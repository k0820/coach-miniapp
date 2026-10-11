const { getDB, pad, typeOf, isSandbox } = require('../../utils/data-runtime')
const { todayKey, currentHour, dateParts, addDays, addMonths, startOfWeek, daysInMonth, monthDateKey } = require('../../utils/beijing-date')
const { mergePendingBookings, subscribePendingBookings, pendingBookingRecords, bookingBindings } = require('../../utils/ui-cloud-command')
const mutate = require('../../utils/mutate')
const pendingCompletion = require('../../utils/pending-completion')
const releaseFlags = require('../../utils/release-flags')
// ⭐ 开课时间窗口：06:00–23:00 开课、每 30 分钟一档、且当天 24:00 前结束（教练新建与会员自助同一条规则）。
//   与云端 occupancy.js 同一把尺（本机孪生）。
const occupancy = require('../../utils/package-occupancy')
const scheduleView = require('../../utils/schedule-view')
const WEEK_NAMES = ['日','一','二','三','四','五','六']
// 弹层一次最多列几行（再多 modal 会截断，宁可写"还有 N 节"）。
const NOTICE_LINES_IN_MODAL = 6
// ⭐⭐ 2026-10-02 · 本轮 UI 整理：课表默认只铺 06:00–23:00（18 行），凌晨那 6 行改成"有课才出现"。
//
//    ⛔ 为什么可以砍掉凌晨 6 行（有据可查，不是拍脑袋，见 OVERNIGHT-CHECK-20261002.md）：
//       · 现存 168 条生产预约里 hour ∈ [0,6) 的记录 0 条（最早 09:00）；
//         全仓静态扫描（1233 个文件）同样 0 条 ⇒ 这 6 行现在每天都是纯空白。
//       · 原来 24 行 × 44rpx ⇒ 一行只有 22px，格子挤得连课程卡片的字都发虚。
//         砍到 18 行后行高能提到 50rpx（26px），常规屏仍然一屏全见 ——
//         这才是"用更少的行换回可读性"，不是单纯地删内容。
//
//    ⛔ 但不能把这 6 行删死（那正是本项目点名要消除的"数据在、课表看不见"）：
//       补录通道只判最晚 23:00、不判最早（tests/past-lesson-backfill.test.js ⑤ 明文钉死），
//       新建课程弹层的时段卡片起点也是 00:00 ⇒ 今天 0 条 ≠ 明天 0 条。
//       ⇒ 所以凌晨 6 行留在 LATE_HOURS 里，该周真有凌晨课时自动渲染并展开，没有就一行都不占。
//       （早于 06:00 的课照样有格子装它 ⇒ 历史课不会凭空消失。）
const HOURS = Array.from({ length: 18 }, (_, i) => i + 6)
// ⭐ 凌晨时段：00:00–05:59 共 6 行。整段一起渲染（不是"只造有课的那一行"）——
//    课表是一根连续时间轴，这 6 行是可点的（能在任意凌晨整点补录）。跳着渲染会把
//    00:45 与 05:30 显示成上下相邻两行，时间轴一断，教练就不敢在这儿补录了。
const LATE_HOURS = Array.from({ length: 6 }, (_, i) => i)

// ═══ 2026-10-03 · 课表响应式行高（1.3.10 真机 Bug：删掉右下胶囊后课表下方留一大块空白）═══
//
//   ⛔ 根因：小时行原来是写死的固定行高 --hour-row-h(50rpx)，18 行恒定 900rpx。
//      行区（.rows-scroll）吃到的高度取决于机型：iPhone 6/7/8 约 459px、iPhone 12/13 Pro 约 557px、
//      iPhone 14 Pro Max 还要更高 ⇒ 一模一样的课表，屏幕越大、底部空白越多。
//      胶囊在的时候那 104rpx 安全带刚好把大部分机型的空白"吃掉"，胶囊一删就露出来了。
//
//   ⭐ 修法：按真实可用高度 ÷ 当前行数算行高，由页面下发到每一行（rowHeightStyle）：
//       · measureRowHeight() 实测「**行区顶部到视口底**」的距离，除以当前实际渲染的行数
//         （18 行；凌晨段展开时 24 行）⇒ 严格等高、课表铺满 tabBar 上方；
//       · --hour-row-h 降级成最小可读行高（MIN_ROW_RPX）：空间不足时用它顶住，
//         宁可让**整页**轻微滚动，也不把行压到点不中 / 字看不清（见要求 3、7）；
//       · 因此它不是写死的高度 ⇒ 课程卡片（slotStyle 的百分比 top/height）、
//         半小时片段、空白格点击全部自动跟着实际行高走（要求 6 天然满足，无需另算第二遍）。
//
//   ⭐⭐ 七次口径（1.3.11 真机：下拉刷新"只有时间网格下移 + 一大块三点空白"）——
//       ⛔ 三个改动，都是为了"整块课表作为一个整体刷新 / 滚动"：
//       ① 刷新容器**只有一个** = 页面级 `onPullDownRefresh`（下拉刷新由整页承担）。
//          `.rows-scroll` 不再是 `scroll-view`、不再带 `refresher-enabled` ⇒ 手指落在网格上也是整页下拉，
//          月份标题 / 月周日 / 选择日期 / 分享可约 / 星期标题 / 时间网格**一起**下移。
//          "正在进行"的反馈改由页面顶部的**紧凑提示条**（`.refresh-hint`，44rpx，完成自动收回）承担，
//          替掉原来那个占据大块高度的三点加载区。
//       ② 行区不再内部滚动：`.rows-scroll` 是 `flex:none` 的普通容器，高度 = 行数 × 下发行高。
//          空间不足（小屏 / 横幅 / 通知条）时是**整页**轻微滚动，不是"只有时间格滚"。
//       ③ 量测口径换成「**视口底 − 行区顶**」：
//          ⛔ 旧口径量的是 `.rows-scroll` 容器高度，而那个高度由 flex 分配 —— 一旦行区不再吃 flex
//             剩余高度，容器高就等于"上一帧自己发下去的行高之和" ⇒ **自己量自己**（自锁，永不更新）。
//          新口径只量**位置**（行区顶在视口里的 y，配 scrollTop 换成内容坐标），与行高无关 ⇒ 无循环依赖；
//          再顺手把课表卡片高度（= 表头 + 凌晨条 + 行区内容高）一起下发，卡片才能被内容"撑开"。
//
//   ⛔ 什么时候必须重算（漏一处就会重新出现"空白 / 被压扁"）：
//       · 进入页面 / 切视图（周 ⇄ 日）/ 切周 / 凌晨段展开收起 —— 走 renderCurrentView ⇒ 统一兜住；
//       · 测试环境横幅出现或消失（.with-banner 扣掉 --sandbox-banner-h）；
//       · 会员取消通知条出现或被「知道了」收掉（它占流）；
//       · 下拉刷新的紧凑提示条出现 / 收回（它占 44rpx 的流）；
//       · 窗口尺寸变化（开发者工具切机型、真机旋转）⇒ wx.onWindowResize。
const ROWS_VIEWPORT_SELECTOR = '.rows-scroll'
// ⭐ 课表卡片（周视图是 swiper 本身、日视图是 day-calendar）：它的高度由行高反推后下发，
//   这样"空间不足 ⇒ 卡片被内容撑高 ⇒ 整页滚动"才成立（卡片若被 flex-shrink 压回剩余空间，末行会被裁）。
const CARD_SELECTORS = ['.week-swiper', '.day-calendar']
// swiper 三屏都在 DOM 里（left 分别是 −窗口宽 / 0 / +窗口宽）⇒ 只认当前屏那一个。
// ⛔ 不筛的话会量到邻屏（邻屏可能有凌晨提示条，高度不同）⇒ 行高算错。日 / 月视图不在 swiper 里，left 本身就是 0。
function pickCurrentScreen(list) {
  const arr = (Array.isArray(list) ? list : []).filter(r => r && typeof r.top === 'number')
  return arr.filter(r => Math.abs(r.left) < 1)[0] || arr[0] || null
}
// 最小可读行高（rpx）。与 app.wxss 的 --hour-row-h 同源：那里是 CSS 兜底（JS 还没测出来时的第一帧），
// 这里是 JS 的下限。改一处请两处一起改 —— tests/schedule-grid-responsive.test.js 盯着这条同源关系。
const MIN_ROW_RPX = 50
// ⭐ M2 自动刷新补线：课表页自己的 onShow 已经会读一次；installPage 只把它接上总线，
//    这样"从后台回到前台 / 别的页面写成功 / 从课程详情返回"时，当前可见的课表也会真的重读。
const installAutoRefresh = require('../../utils/auto-refresh').installPage

Page(installAutoRefresh({
  data: {
    weekSlides: [], swiperCurrent: 1, swiperDuration: 280,
    hours: HOURS, dayRows: [], monthDays: [], modal: false,
    // ⭐ 凌晨时段是否展开。默认 true = 有课即自动展开（没课就不渲染，展开也没东西）。
    //   教练点提示条可以收起（收起 = 那 6 行不进 DOM，一条数据都不动）。
    lateExpanded: true, lateCount: 0, dayLateCount: 0,
    presetDate: '', presetHour: 8, calendarAnim: '',
    viewMode: 'week', viewModeName: '周', selectedDate: todayKey(), datePickMode: '',
    shareSheet: false, shareStage: 'choose', shareDate: '', shareDateLabel: '', shareTodayLabel: '', shareTomorrowLabel: '', shareSlots: [], shareText: '',
    // 开发期入口是否可见（正式发布包为 false）。见 utils/release-flags.js。
    devEntries: releaseFlags.devEntriesVisible(),
    // ⭐ 测试环境横幅是否占位：它在页面顶部占流（sticky），课表高度必须扣掉它
    //   （见 schedule.wxss 的 .schedule-page.with-banner）。进出测试区都要实时跟着变。
    inSandbox: false,
    // ⭐ 1.3.11：刷新容器**只剩页面级这一个**（网格不再自带 refresher）。
    //   下拉时由页面顶部的紧凑提示条反馈"正在进行"，同步完成即收回 ——
    //   它就是原来那个"占大块高度的三点加载区"的替代品（见 schedule.wxml 的 .refresh-hint）。
    refreshing: false,
    // ⭐ 被会员取消的课：不进课表，但必须在这里如实交代（不静默隐藏）。
    //   只报还没看过的；点过「知道了」就消失，之后再来新的会重新出现（见 unseenCancellationsOf）。
    cancelNotice: { count: 0, latest: '', lines: [], keys: [] },
    // ⭐ 响应式小时行高：由 syncRowHeight() 实测「行区顶 → 视口底」的距离后下发（height:NNpx）。
    //   空串 ⇒ 回落到 CSS 兜底（首帧、或还没测出高度时）——那只是"等于旧行为"，不会错位。
    rowHeightStyle: '',
    // ⭐ 课表卡片高度（周 = .week-swiper、日 = .day-calendar）：同样是实测后下发。
    //   它不是"行高之外的第二套数字"：卡片高 = （行区顶 − 卡片顶）+ 行数 × 行高，
    //   和行高**同一次量测、同一个来源**导出。没有它，卡片会被 flex-shrink 压回剩余空间 ⇒ 末行被裁。
    cardHeightStyle: '',
    refreshAllowText: '刷新课表'
  },
  // 「已读」存本机（按 环境+账本 分开存，见 scheduleView.seenStorageKeyOf）。
  cancelSeenScope: '',

  noop() {},

  // ══════════════════════ 响应式小时行高（2026-10-03，见文件头注释）══════════════════════
  // 一次布局变化常常连着好几个 setData（视图切换 + 数据装载 + 动画复位），
  // 逐个测会量到中间态 ⇒ 全部并到下一帧只测一次（syncRowHeight 合并、measureRowHeight 真测）。
  syncRowHeight() {
    if (this._rowHeightPending) return
    this._rowHeightPending = true
    const run = () => {
      this._rowHeightPending = false
      this.measureRowHeight()
    }
    if (wx.nextTick) wx.nextTick(run); else setTimeout(run, 0)
  },

  measureRowHeight() {
    // 行数按当前真正渲染出来的行算：凌晨段收起 = 18 行，展开 = 24 行。
    const rows = this.data.viewMode === 'day'
      ? (this.data.dayRows || []).length
      : ((this.data.weekSlides && this.data.weekSlides[1] && this.data.weekSlides[1].rows) || []).length
    if (!rows) return
    if (!this.createSelectorQuery) return
    // ⭐ 一次性量三样：页面滚动位置、行区顶、课表卡片顶（选择器组按调用顺序回填 res[0..]）。
    //   ⛔ 只量**位置**，绝不量行区容器高度 —— 那个高度现在等于"上一帧自己发下去的行高之和"，
    //      量它就成了自己量自己（自锁）。
    const query = this.createSelectorQuery()
    query.selectViewport().scrollOffset()
    query.selectAll(ROWS_VIEWPORT_SELECTOR).boundingClientRect()
    CARD_SELECTORS.forEach(selector => query.selectAll(selector).boundingClientRect())
    query.exec(res => {
      const scrollTop = (res && res[0] && res[0].scrollTop) || 0
      const rowsRect = pickCurrentScreen(res && res[1])
      let cardRect = null
      for (let i = 0; i < CARD_SELECTORS.length && !cardRect; i++) cardRect = pickCurrentScreen(res && res[2 + i])
      // ⛔ 量不到位置时一个字节都不改（保留上一帧的下发值），绝不猜一个数写下去。
      if (!rowsRect || !cardRect) return
      const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {}
      const windowHeight = info.windowHeight || 0
      const rpxRatio = (info.windowWidth || 375) / 750
      const minPx = MIN_ROW_RPX * rpxRatio
      // 换成**内容坐标**（页面被滚过也一样）：行区顶、卡片顶。
      const rowsTop = rowsRect.top + scrollTop
      const cardTop = cardRect.top + scrollTop
      // ⭐ 行区可用高度 = 视口底 − 行区顶。
      //   ⇒ 行区底正好落在视口底：课表铺满 tabBar 上方（要求 4），且页面比视口多出的那一点点
      //     （padding-bottom 42rpx 大于 40rpx 的下拉余量）天然保证 onPullDownRefresh 仍会被触发。
      const availH = windowHeight - rowsTop
      if (availH <= 0) return
      // ⭐ 严格等高：取"可用高度 ÷ 行数"的实数（不取整、不给末行补差），
      //   18 行的累计舍入误差 < 0.2px ⇒ 网格底与 tabBar 的间隙落在 0–1px 验收口径内。
      const height = Math.max(minPx, availH / rows)
      // ⭐ 卡片高 = （行区顶 − 卡片顶 [= 日期表头 + 凌晨提示条]） + 行区实际内容高。
      //   ⛔ 触底（空间不足）时行区内容比 availH 高 ⇒ 卡片跟着变高 ⇒ 由**整页**滚动接住（要求 5），
      //      而不是把末行裁掉。卡片和行高是同一次量测导出的两个数，不存在第二套高度。
      const cardH = Math.max(0, rowsTop - cardTop) + rows * height
      const rowHeightStyle = 'height:' + (Math.round(height * 100) / 100) + 'px'
      const cardHeightStyle = 'height:' + (Math.round(cardH * 100) / 100) + 'px'
      if (rowHeightStyle !== this.data.rowHeightStyle || cardHeightStyle !== this.data.cardHeightStyle) {
        this.setData({ rowHeightStyle, cardHeightStyle })
      }
    })
  },

  onWindowResize() { this.syncRowHeight() },

  onLoad() {
    // 待确认预约变化（提交中 / 已确认 / 已撤回）时刷新课表视图。
    this.unsubscribePending = subscribePendingBookings(() => { if (this.scheduleCache) this.saved() })
    // ⭐ 机型 / 窗口一变（开发者工具切换模拟器机型、真机横竖屏），课表必须立刻重分行高，
    //   否则又会出现"屏幕变了、行高还停在旧机型上"的空白。
    if (wx.onWindowResize) {
      const off = wx.offWindowResize
      wx.onWindowResize(() => this.onWindowResize())
      this._offWindowResize = off ? () => off(() => this.onWindowResize()) : null
    }
  },
  onUnload() {
    this._visible = false
    if (this.unsubscribePending) this.unsubscribePending()
    if (this._offWindowResize) this._offWindowResize()
  },

  onShow() {
    this._visible=true
    wx.showTabBar()
    // ⭐ 横幅只在测试区出现，而它占流 ⇒ 课表高度要让出同样多（否则底部被裁，见 schedule.wxss）。
    //   放在 onShow：切环境 / 从别的页面返回都会重新对齐，不会出现"横幅还在、课表已经按没有横幅排"。
    const inSandbox = typeof isSandbox === 'function' ? !!isSandbox() : false
    if (this.data.inSandbox !== inSandbox) this.setData({ inSandbox }, () => this.syncRowHeight())
    // ① 第一帧永远是本机已有课表：loadScheduleData 读的是本地投影
    //    （云端已确认快照 + 还在 Outbox 里、云端还不知道的本机意图），不发任何网络请求，
    //    所以进入/返回课表页绝不会为了等云端而空白或转圈。
    this.loadScheduleData()
    this.renderCurrentView()
    // 重新进入页面时恢复待确认预约：只按 receipt 查单，绝不盲目重发已发出的命令。
    // 恢复过程中的任何状态变化都会通过订阅回调触发课表重绘，这里不需要额外刷新。
    mutate.resumePendingBookings().catch(() => {})
    // 阶段 2：顺手把持久 Outbox 里还没送出去的业务事实补发一轮（断网期间录的课不会一直躺在队列里）。
    mutate.sync.schedule()
    // ② 同时在后台静默拉取云端最新数据（多设备场景全靠这一步看到对方刚建的预约）。
    //    成功 → 换掉视图；失败 → 保留本机课表。两种情况都不提示、不遮屏。
    this.refreshSchedule()
    // ③ 下课链的复制阶段若上一次没能确认成功（例如剪贴板调用异常），在这里自动补一次。
    //    「下课 + 复制课程内容」是一个完整动作，用户不需要为此做任何补救操作 ——
    //    补复制只碰剪贴板、绝不碰任何业务命令，因此永远不可能造成二次完课。
    //    没有待复制记录时零开销、零提示。
    this.resumeContentCopy()
  },
  onHide() { this._visible=false;wx.showTabBar() },
  // 微信原生下拉刷新。用户主动刷新时必须真的读一次云端当前 authoritative dataset
  // （readActive 全量回读：metadata → 八个集合分页 → integrity 校验），不是只刷本机缓存。
  // ★ 1.1.9 第 3 轮（真机账本定案）：页面可交互状态与整条后台同步链解绑。
  //   账本显示用户那一轮 9.04s 里 8.02s 是在排队干等，而课程早在 7.94s（后台那一轮读完）
  //   就已经渲染在屏幕上了 —— 三个点却还要再挂约 1 秒，这 9 秒页面被钉在下拉态不能滑不能点。
  //   ⇒ 一下拉就立刻收掉三个点；读取与随后的恢复仍照旧在后台跑完。
  //   ⚠️ 换视图的判据一个字没改：仍然只有 result.ok（读回并通过 integrity 校验）之后才 render。
  // ⭐ 1.3.11 起这是**唯一**的刷新容器：整页下拉 ⇒ 月份标题 / 月周日 / 选择日期 / 分享可约 /
  //   星期标题 / 时间网格**一起**下移（网格自己那套 scroll-view refresher 已整段删除）。
  onPullDownRefresh(){
    // ① 立刻收掉系统下拉指示并恢复页面滑动 —— 1.1.9 真机事故的教训：绝不把页面钉在下拉态
    //    （那一轮用户等了 9 秒，页面不能滑不能点）。"正在进行"的反馈交给下面那条紧凑提示条。
    this.settlePullDown();
    // ② 与后台刷新走**同一条**读取路径（userInitiated ⇒ 真的回读一次云端当前状态），不另起一套逻辑。
    //    ⛔ 这一行必须排在方法体里**任何含右花括号的表达式之前**，且实参写成无空格形式 ——
    //      tests/pull-refresh-fresh-read.test.js 抓方法体用的是朴素的字符类正则（遇第一个右花括号即截断），
    //      不是配平扫描：一旦前面先出现 setData 的对象实参，它抓到的片段里就没有 userInitiated。
    //      1.3.11 就因为这个把"用户主动轮次"这条契约判红过一次。
    //      ⚠️ 本方法体内的注释也**不许出现花括号字符** —— 那同样会把上面那条正则截断。
    const r=this.refreshSchedule({userInitiated:true});
    // ③ 顶部紧凑提示条（44rpx）：占流就得让出高度 ⇒ 出现 / 收回都要重算行高，
    //    否则末行会被顶出视口。它只占一条，不会像原来那样挤出一大块三点空白。
    if(!this.data.refreshing)this.setData({refreshing:true},()=>this.syncRowHeight());
    const done=()=>{if(this.data.refreshing)this.setData({refreshing:false},()=>this.syncRowHeight())};
    // ④ ⛔ 必须**把这一轮的 promise 交出去**：调用方（automator / 回归替身）`await` 的是"这一轮
    //    真的走完并换过视图"。旧实现直接 return undefined ⇒ await 立刻返回 ⇒ 读回来了也没人看到
    //    （tests/schedule-cross-device-refresh.test.js、tests/schedule-instant-render.test.js 都盯这条）。
    if(r&&typeof r.then==='function')return r.then(done,done);
    done();
  },
  // 收掉系统下拉指示（三个点）并恢复页面滑动。用 wx.nextTick 让本帧的下拉态先落地再收；
  // 这里没有任何时长数值（不是"猜一个延时"），只是把这次调用挪到下一个时间片。
  settlePullDown(){const stop=()=>{if(wx.stopPullDownRefresh)wx.stopPullDownRefresh()};if(wx.nextTick)wx.nextTick(stop);else stop()},
  async refreshSchedule(options){
    const ui=require('../../utils/ui-cloud-command')
    if(typeof ui.refreshActiveView!=='function')return
    // 用户主动下拉 = 一条明确指令，绝不能被单航班的防重门吃掉。
    // 1.1.7 的真机故障之一就是这道门：onShow 那一轮（真机上要好几秒）还没回来时，
    // 用户下拉被静默 return，手指白划一次，页面什么都没发生。
    // 后台轮次仍然防重；用户轮次放行，而且必须真的读一次云端当前状态 ——
    // 1.1.9 起用户轮次在读取层另起一次新的完整回读（userInitiated），
    // 不再复用「用户开口之前就已经在飞」的那一份：那份快照可能落在另一台设备的写入之前，
    // 而复用它和「刷新什么都没发生」在界面上一模一样。
    // 1.1.9 第 3 轮：用户轮次在读取层先发一跳只读校验（不进航位，与在途后台整读并存），
    // 只有那一跳证明"缓存已不是云端此刻状态"时才回到同一条航位走完整读取。
    // 写命令 + 它的完整回读照旧独占航位；后台轮次行为逐字不变。
    // 见 utils/cloud-primary-adapter.js 的 userRefreshRead。
    const userInitiated=!!(options&&options.userInitiated)
    const startedAt=Date.now()
    if(!userInitiated&&this._refreshing&&startedAt-Number(this._refreshingAt||0)<8000)return
    this._refreshing=true
    this._refreshingAt=startedAt
    try{
      const result=await ui.refreshActiveView({userInitiated})
      const readDoneAt=Date.now()
      if(!this._visible)return
      // 只有真的读到一份一致快照才换视图。失败一律保留本机当前课表：
      // 绝不因为一次云端读取失败就把页面清空，也绝不提示用户（本机数据一直是可用的，
      // 下一轮——重进页面 / 下拉 / 本机写完之后——还会自动再试）。
      // ★ 1.1.9 第 4 轮：换视图这一步改走 applyLatestData —— 只把真的变了的格子推给视图层，
      //   一个格子都没变就一次 setData 都不发。换视图的判据（result.ok）一个字没改。
      if(result&&result.ok){this.applyLatestData(userInitiated?'user':'background',readDoneAt);await mutate.resumePendingBookings()}
    }catch(error){}
    finally{this._refreshing=false}
  },
  loadScheduleData() {
    const db = getDB(), studentById = {}
    db.students.forEach(student => { studentById[student.id] = student })
    // ⭐ 视图层合并：正式 cache + 本机待确认预约。getDB() 永远看不到待确认数据。
    // ⛔ 已取消的课不再进课表（它不再是一节要上的课）—— 口径在 utils/schedule-view.js，
    //    这里不许自己写 status === 'cancelled'。数据一个字节都没删，只是不渲染成"课"。
    const index = scheduleView.buildScheduleIndex(mergePendingBookings(db.bookings))
    const bySlot = index.bySlot, byDate = index.byDate
    // 正在完课的课程：本机意图，只用于把块呈现成「已完成」（与正式 done 同一视觉）。
    // 完课的财务事实（done / 扣课时 / Income）不在这里产生，cache 也没被改过，所以任何统计都不会算上它。
    // ⭐ cache 在这里读一次：完课意图要用，下面的"已读" scope 也用它里面的 datasetId（零额外开销）。
    let cache = null, datasetId = '', envName = 'production'
    let completionIndex = { officialIds: [], localKeys: [] }
    try {
      const runtime = require('../../utils/data-runtime')
      // ⛔ 防御取值：拿不到就退回默认值 —— 最坏结果是"已读按默认账本存"，
      //    不会让课表崩掉（本机视图层永远不许因为读状态失败而白屏）。
      envName = typeof runtime.environment === 'function' ? runtime.environment() : 'production'
      cache = wx.getStorageSync(runtime.cacheKey())
      if (cache && cache.datasetId) datasetId = String(cache.datasetId)
      // 顺手记下"这一帧装载的是哪一版 cache"（同一个值已经读出来了，零额外开销）：
      // UI 账本要能用它分辨"这一轮到底换掉了哪份数据"，而不是拿当前值去猜。
      this._renderedRevision = cache && Number.isInteger(cache.revision) ? cache.revision : null
      if (cache && cache.datasetId) completionIndex = pendingCompletion.viewIndex(envName, cache.datasetId)
    } catch (error) { this._renderedRevision = null; completionIndex = { officialIds: [], localKeys: [] } }
    // ⛔ 不静默隐藏：把这些课如实交代给教练（哪几节被会员取消了）。
    //   ⭐ 只算还没看过的（1.3.1 真机反馈：算上历史取消 ⇒ 提示条变常驻噪音）。
    //   只在"内容真的变了"时才推这一次 setData（刷新时零额外开销）。
    this.cancelSeenScope = scheduleView.seenStorageKeyOf(envName, datasetId)
    const notice = scheduleView.unseenCancellationsOf(index.cancelledByMember, this.readCancelSeen(), todayKey())
    this.cancelNotice = notice
    if (JSON.stringify(notice) !== JSON.stringify(this._cancelNoticePushed)) {
      this._cancelNoticePushed = notice
      // ⛔ 通知条占流（约 35px）：它一出现/消失，行区可用高度就变了 ⇒ 必须重分行高，
      //    否则要么底部留一条空白、要么最后一行被顶出去。
      this.setData({ cancelNotice: notice }, () => this.syncRowHeight())
    }
    // 完课意图是按「当时那个身份」记下来的。本机先行创建的预约那时只有本机临时 bookingId，
    // 等它转正后在课表上就换成了正式 id —— 若只按记录里的原值比对，块会从「已完」退回「待上」。
    // 所以这里把每条意图的 id 都过一遍「本机临时 id → 正式 id」转正，两种写法都认。
    try {
      if (typeof mutate.resolveLocalId === 'function') {
        const resolved = new Set(completionIndex.officialIds)
        completionIndex.officialIds.forEach(id => { const official = mutate.resolveLocalId(id); if (official && official !== id) resolved.add(official) })
        completionIndex.officialIds = [...resolved]
      }
    } catch (error) {}
    // 正式 bookingId → 本机稳定渲染 key。转正后本机待确认记录会被清掉，
    // 若此时渲染 key 回落到 bookingId，节点会被销毁重建（用户看到闪一下）。
    const boundViewKeys = new Map()
    try {
      if (typeof bookingBindings === 'function') bookingBindings().forEach(item => { if (item && item.officialId) boundViewKeys.set(item.officialId, `stable:${item.bookingKey}`) })
    } catch (error) {}
    // 本机先行建出来的预约（1.1.6「秒约」）：转正前后同样必须共用同一个渲染 key。
    // 协调器的绑定表只覆盖"它自己发起的待确认预约"；本机先行的预约没有协调器记录，
    // 但 Outbox 的 idMap 里留着同一份对应关系（本机临时 bookingId → 正式 bookingId），
    // 用它把「正式 id 那一帧」映射回本机 id 帧所用的 key，节点就不会被销毁重建。
    try {
      if (typeof mutate.bookingViewKeys === 'function') mutate.bookingViewKeys().forEach(item => { if (item && item.officialId && !boundViewKeys.has(item.officialId)) boundViewKeys.set(item.officialId, item.viewKey) })
    } catch (error) {}
    this.scheduleCache = { db, bySlot, byDate, studentById, rows: index.rows, cancelledByMember: index.cancelledByMember, doneIntentOfficialIds: new Set(completionIndex.officialIds), doneIntentLocalKeys: new Set(completionIndex.localKeys), boundViewKeys }
  },

  // 已读指纹（本机）：读失败一律当作"都没看过" ⇒ 最坏只是再提醒一次，不会吞掉新取消。
  readCancelSeen() {
    if (!this.cancelSeenScope) return []
    try {
      const value = wx.getStorageSync(this.cancelSeenScope)
      return Array.isArray(value) ? value : []
    } catch (error) { return [] }
  },

  // 点提示条 ⇒ 列出新取消的课（按最新时间在前），点「知道了」⇒ 整批标记已读、提示条立即消失。
  //   ⛔ 只读告知，不给任何"撤销/恢复"入口：取消是会员的权利，教练不能替他反悔。
  //   ⛔ 业务记录一条都不删 —— 这里只是记下"这几条我看过了"。
  showCancelledNotice() {
    const notice = this.cancelNotice || {}
    if (!notice.count) return
    const lines = (notice.lines || []).slice(0, NOTICE_LINES_IN_MODAL)
    const rest = notice.count - lines.length
    wx.showModal({
      title: `会员新取消了 ${notice.count} 节课`,
      content: (lines.join('\n') + (rest > 0 ? `\n…还有 ${rest} 节` : '')) || '会员取消了预约。',
      showCancel: false, confirmText: '知道了',
      success: () => this.markCancelSeen(notice.keys || [])
    })
  },

  // 标记已读：本机记指纹 ⇒ 顶部提示条立即消失；之后再来新取消会重新出现并重新累计。
  markCancelSeen(keys) {
    if (!this.cancelSeenScope) return
    try {
      wx.setStorageSync(this.cancelSeenScope, scheduleView.mergeSeenKeys(this.readCancelSeen(), keys))
    } catch (error) {}
    const cleared = { count: 0, latest: '', lines: [], keys: [] }
    this.cancelNotice = cleared
    this._cancelNoticePushed = cleared
    this.setData({ cancelNotice: cleared }, () => this.syncRowHeight())
  },

  // ⭐ fragment 只在渲染跨午夜课程的次日片段时才传（普通渲染不传 ⇒ 走原路径）。
  //   ⛔ top / height 由真区间换算，页面绝不自己重算第二遍 ⇒
  //      「画出来的长度」与「这一格到底算不算被占」永远是同一个答案。
  decorateBooking(booking, cache) {
    const student = cache.studentById[booking.studentId], type = typeOf(booking.typeName), minute = booking.minute || 0
    const studentName = student ? student.name : (booking.studentName || '已删学员')
    const pending = !!booking.pending, color = type.color
    // 「已经完成」的呈现有两个来源：正式 cache 已是 done，或本机已有完课意图
    // （用户已经点过下课、云端结果还没落地）。两者在像素上必须完全一致 ——
    // 用户点完下课回到课表，看到的就是一门已完成课程，不存在任何「中间态」；
    // 云端确认落地时视觉也不发生任何变化（中间态不可见的定义）。
    // 财务事实仍然只由云端事务产生：这里一个字都没改 cache，任何统计口径都不受影响。
    const completionPending = !booking.status || booking.status === 'booked'
      ? !!((cache && cache.doneIntentOfficialIds && cache.doneIntentOfficialIds.has(booking.id))
        || (pending && cache && cache.doneIntentLocalKeys && cache.doneIntentLocalKeys.has(`pending:${booking.pendingKey}`)))
      : false
    const completed = booking.status === 'done' || completionPending
    // 本机先行建出来的预约，头一两秒用的是本机临时 id（loc_booking_…）；云端转正后换成正式 id。
    // 两帧必须落到同一个渲染 key，否则小程序会销毁重建这个块（视觉上闪一下），
    // 而「转正那一刻视觉零变化」是 1.1.5 已经验收过的性质。
    // 做法：本机 id 帧直接钉成 stable:<本机 id>，转正后由 boundViewKeys 映射到同一个字符串。
    // ------------------------------------------------------------------------------ ⭐ 跨午夜的几何
    //   ⛔ 只画开始日那一段：跨午夜的课（存量的 23:30 旧课）把高度截断在 24:00 ——
    //     原来是 height:100%，会溢出到格子外面（不同主题 overflow 不一致 ⇒ 时隐时现）。
    //   ⛔ 次日那一段不再画（1.3.5 的「接上节」随跨午夜 MVP 一并取消），
    //      但它仍然占着那个时间 ⇒ 点那片空白会打开这一节课，不是新建（见 cellTapIntentOf）。
    //   不跨午夜的课一个像素都不动。
    const startMinute = Number(booking.hour || 0) * 60 + minute
    const planned = occupancy.plannedMinutesOf(booking) || occupancy.DEFAULT_PLANNED_MINUTES
    const crossesMidnight = startMinute + planned > 24 * 60
    const clippedEnd = Math.min(startMinute + planned, 24 * 60)
    // ⭐⭐ A（2026-10-04）：卡片高度**必须由真实时长算**，不能写死。
    //   ⛔ 旧写法：不跨午夜的一律 `height:100%` —— 也就是**不管这节课是 30 分钟还是 90 分钟，
    //      卡片都画满一整行**。后果有两个，都会被用户一眼看穿：
    //        ① 30 分钟的课看起来像整整一小时（"一节课像占了两个格子"）；
    //        ② 90 分钟的课被**裁在起始那一行里**，图上完全看不出它还要再往后半小时。
    //   ⛔ 这就是把「每行高度」和「课程持续时间」混为一谈 —— 行高是行高，时长是时长，两个数。
    //   ✅ 现在两条分支统一：top = 行内起始偏移，height = 时长 ÷ 行高。
    //      90 分钟 ⇒ height:150%，卡片**跨到下一行**继续画（`.cell` 是 overflow:visible，
    //      `.booking` 带 z-index 保证盖住后一行的格线与文字）。
    //   ⛔ 跨午夜仍然截断在 24:00（`clippedEnd`），次日那一段不画（1.3.5 起取消「接上节」）。
    const slotStyle = `top:${minute / 60 * 100}%;height:${(clippedEnd - startMinute) / 60 * 100}%`
    // ⭐ 跨行卡片（>100%）要显式抬层级：后面的行在 DOM 里更靠后，不抬会被后一行的文字压住。
    const spansRows = (clippedEnd - startMinute) > 60
    const localIdFrame = typeof booking.id === 'string' && booking.id.indexOf('loc_') === 0
    return {
      ...booking, studentName, color, completed,
      // ⛔ 这里曾经有 continuation / continuationText（"接上节"标记）：
      //    2026-10-01 二次口径已删除 ⇒ 课表恢复简洁布局。
      //    一条课现在只有一个视觉块（开始日那一段），点它打开的就是这一节课本身。
      // 稳定渲染 key：同一条预约从「待确认」转「正式」时 key 不变，小程序不会销毁重建节点，因此不会闪、不会重新出现。
      // 转正后靠本机绑定继续沿用它（否则会回落到 bookingId，节点仍会被重建）。
      viewKey: booking.viewKey || (localIdFrame ? `stable:${booking.id}` : '') || (cache && cache.boundViewKeys && booking.id ? cache.boundViewKeys.get(booking.id) : '') || booking.id || `slot:${booking.date}|${booking.hour}|${minute}|${booking.studentId || ''}`,
      displayTime: `${pad(booking.hour)}:${pad(minute)}`,
      // ⭐ A：真实时长超过 1 小时的课会跨到下一行 ⇒ 视图层据此抬层级（见 .booking-spans）
      spansRows,
      statusLabel: completed ? '已完' : '待上',
      slotStyle,
      // 待确认预约从第一帧起就使用与正式预约逐字相同的课程视觉（这就是「秒回」的验收标准）。
      // 状态不画在像素上，但真实保存在 view 数据里：pending / pendingKey / pendingStatus 仍独立存在，
      // 点击时按本机编辑态进入（用真实业务键，不伪造 bookingId），getDB() 与 active cache 也永远看不到它。
      blockStyle: `border-color:${color};background:${color}`,
      bookingText: studentName,
      dayLabel: booking.typeName,
      pending
    }
  },

  // ⭐ 一个格子里只有一种东西：这一刻开始的课。
  //   ⛔ 昨晚延续过来的那半截（存量 23:30 旧课的次日部分）不再渲染（1.3.5「接上节」已取消），
  //      但它仍然占着这个时间 ⇒ 点那片空白走 cellTapIntentOf ⇒ 打开那一节课，不是新建。
  makeCell(date, hour, isToday) {
    const cache = this.scheduleCache
    const source = (cache.bySlot[`${date}|${hour}`] || []).slice().sort((a, b) => (a.minute || 0) - (b.minute || 0))
    return { date, hour, today: isToday, bookings: source.map(booking => this.decorateBooking(booking, cache)) }
  },

  // ⭐ 凌晨那一段（00:00–05:59）的 6 行 + 这一周/这一天到底有几节凌晨课。
  //   复用 makeCell ⇒ 每一格走的是同一条落格逻辑（cache.bySlot[date|hour]），
  //   凌晨课和白天课在数据层没有任何区别，不存在"凌晨格另算一套"。
  lateBlockOf(days) {
    const rows = []
    for (const hour of LATE_HOURS) {
      const cells = days.map(day => this.makeCell(day.date, hour, day.today))
      rows.push({ hour, time: `${pad(hour)}:00`, cells, isLate: true, count: cells.reduce((n, c) => n + c.bookings.length, 0) })
    }
    return { rows, count: rows.reduce((n, r) => n + r.count, 0) }
  },

  makeWeek(weekStart) {
    const today = todayKey()
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i), p = dateParts(date)
      return { date, week: WEEK_NAMES[p.weekday], md:`${p.month}/${p.day}`, today:date===today }
    })
    const mainRows = HOURS.map(hour => ({hour, time:`${pad(hour)}:00`, cells:days.map(day=>this.makeCell(day.date,hour,day.today))}))
    const late = this.lateBlockOf(days)
    const expanded = late.count > 0 && this.data.lateExpanded
    // ⛔ 收起时那 6 行根本不进 rows（不是用 CSS 藏起来）⇒ DOM 里一格都不剩，也不会有影子格子接走点击。
    const rows = expanded ? late.rows.concat(mainRows) : mainRows
    return { key:weekStart, weekStart, days, rows, lateCount: late.count, lateExpanded: expanded }
  },

  weekHeaderPatch(centerWeek, selectedDate) {
    const first = centerWeek.days[0], last = centerWeek.days[6], display = dateParts(selectedDate)
    return { year:display.year, month:display.month, weekRange:`${first.md} — ${last.md}`, selectedLabel:`${display.month}月${display.day}日` }
  },

  renderWeek() {
    const centerStart = startOfWeek(this.data.selectedDate)
    this.currentWeekStart = centerStart
    const weekSlides = [this.makeWeek(addDays(centerStart,-7)),this.makeWeek(centerStart),this.makeWeek(addDays(centerStart,7))]
    this.recyclingSwiper = true
    this.setData({viewMode:'week',viewModeName:'周',weekSlides,swiperCurrent:1,swiperDuration:0,lateCount:weekSlides[1].lateCount,...this.weekHeaderPatch(weekSlides[1],this.data.selectedDate)},()=>{
      wx.nextTick(()=>this.setData({swiperDuration:280},()=>{this.recyclingSwiper=false}))
    })
    this.syncRowHeight()
  },

  renderDay() {
    const selected = this.data.selectedDate, p = dateParts(selected)
    const isToday = selected===todayKey()
    const mainRows = HOURS.map(hour=>({hour,time:`${pad(hour)}:00`,cell:this.makeCell(selected,hour,isToday)}))
    // 日视图与周视图同一口径：凌晨段有课才出现、默认展开、可收起。
    const late = this.lateBlockOf([{date:selected,today:isToday}])
    const expanded = late.count > 0 && this.data.lateExpanded
    const lateRows = late.rows.map(r => ({ hour:r.hour, time:r.time, isLate:true, cell:r.cells[0] }))
    const dayRows = expanded ? lateRows.concat(mainRows) : mainRows
    this.setData({dayRows,dayLateCount:late.count,year:p.year,month:p.month,selectedLabel:`${p.month}月${p.day}日`})
    this.syncRowHeight()
  },

  renderMonth() {
    const selected = dateParts(this.data.selectedDate), today = todayKey(), byDate = this.scheduleCache.byDate
    const firstKey = monthDateKey(selected.year,selected.month,1), leadParts = dateParts(firstKey), lead = leadParts.weekday===0?6:leadParts.weekday-1, monthDays=[]
    for(let i=0;i<lead;i++)monthDays.push({key:`b${i}`,blank:true})
    for(let day=1;day<=daysInMonth(selected.year,selected.month);day++){
      const date=monthDateKey(selected.year,selected.month,day), bookings=byDate[date]||[], done=bookings.filter(b=>b.status==='done').length
      monthDays.push({key:date,date,day,today:date===today,count:bookings.length,pending:bookings.length-done,done})
    }
    this.setData({monthDays,year:selected.year,month:selected.month,selectedLabel:`${selected.month}月${selected.day}日`})
  },

  renderCurrentView() {
    if(this.data.viewMode==='week')this.renderWeek()
    else if(this.data.viewMode==='day')this.renderDay()
    else this.renderMonth()
    // ⭐ 无论走哪一支，行数 / 布局都可能变了（切视图、凌晨段展开收起、切周…）
    //   ⇒ 统一在这里排一次重算。放在 setData 之后、交给下一帧 ⇒ 量到的一定是最终布局。
    this.syncRowHeight()
  },

  // ★ 1.1.9 第 4 轮：「安全数据已到达 → 课表立即显示」这一段收成一次最小推送。
  //
  // 真机形状：读取层账本里那一行（校验通过、cache 已落盘）出现在约 3 秒，课程块却要到约 5 秒
  // 才出现。同步层已冻结，这约 2 秒整个落在「拿到 result.ok 之后」这一段。旧实现在这一段里
  // 做了两遍整屏重绘（notifyView → 订阅回调 saved() 一次；refreshSchedule 自己再一次），
  // 而每一遍都要把三屏 378 个格子 / 约 50KB 整体推给视图层，并顺带把 swiperCurrent=1、
  // swiperDuration 0→280 重写一遍 —— 等于让 swiper 在每次数据刷新时把三屏子节点重排一遍。
  // （工作量实测见 _p22/measure-ui.js：一次刷新在这一段 = 2 次装载 + 2 次整屏推送，101KB / 756 格。）
  //
  // 现在：装载后逐格比对，只把真的变了的格子按路径推下去（通常就是那一格新课程块）；
  // 一个格子都没变时一次 setData 都不发（数据没变时"刷新"在视图层是零开销的，重复的那一遍
  // 因此自动变成免费），且不再碰 swiperCurrent / swiperDuration —— swiper 的位置只由
  // 用户滑动与切周决定，数据刷新绝不去动它。
  // ⚠️ 边界一个字没改：仍然只有 result.ok（读过云端且通过全部校验）或本机意图真的变化之后
  //    才会走到这里；这里只是"少推"，绝不"提前推"，也绝不绕过任何校验、绝不展示未经校验的数据。
  //    结构对不上（第一次进入 / 刚换过周或切过视图）时照旧交给完整重绘，那里才需要重置 swiper。
  applyLatestData(reason, readDoneAt) {
    const uiTiming = require('../../utils/ui-timing')
    const started = Date.now()
    this.loadScheduleData()
    const loadMs = Date.now() - started
    // 日 / 月视图体量很小（18 / 31 个格子），保持整体重绘，零风险。
    // 兜底那一轮在账本里用 reason 后缀 :full 如实标出来 —— 它做的是整屏重绘，
    // 绝不能和"只推了几格"混成同一种记录（否则账本会把整屏重绘记成 cellsChanged=0）。
    const fallbackFull = () => { this.renderCurrentView(); return this.reportRender(uiTiming, (reason || 'view') + ':full', started, loadMs, readDoneAt, 0, 0, false) }
    if (this.data.viewMode !== 'week') return fallbackFull()
    const centerStart = startOfWeek(this.data.selectedDate)
    const current = this.data.weekSlides
    const next = [this.makeWeek(addDays(centerStart,-7)), this.makeWeek(centerStart), this.makeWeek(addDays(centerStart,7))]
    if (!Array.isArray(current) || current.length !== next.length) return fallbackFull()
    for (let i = 0; i < next.length; i++) if (!current[i] || current[i].key !== next[i].key) return fallbackFull()
    const builtAt = Date.now()
    const patch = {}
    let changed = 0
    for (let i = 0; i < next.length; i++) {
      const before = current[i], after = next[i]
      for (let j = 0; j < after.rows.length; j++) {
        const rowBefore = before.rows[j]
        if (!rowBefore) { patch[`weekSlides[${i}].rows[${j}]`] = after.rows[j]; changed++; continue }
        for (let k = 0; k < after.rows[j].cells.length; k++) {
          const cellBefore = rowBefore.cells[k], cellAfter = after.rows[j].cells[k]
          // 「今天」跨零点会翻，整格换；否则只有课程块真的变了才推这一格。
          if (!cellBefore || cellBefore.today !== cellAfter.today) { patch[`weekSlides[${i}].rows[${j}].cells[${k}]`] = cellAfter; changed++; continue }
          if (JSON.stringify(cellBefore.bookings) !== JSON.stringify(cellAfter.bookings)) { patch[`weekSlides[${i}].rows[${j}].cells[${k}].bookings`] = cellAfter.bookings; changed++ }
        }
      }
    }
    this.currentWeekStart = centerStart
    const buildMs = Date.now() - builtAt
    if (!changed) return this.reportRender(uiTiming, reason, started, loadMs, readDoneAt, 0, buildMs, false)
    return this.reportRender(uiTiming, reason, started, loadMs, readDoneAt, changed, buildMs, true, patch)
  },

  // 这一段的每一节如实记账（装载 / 逐格比对 / 推送 / 框架回调＝真上屏），并真正发出这一次 setData。
  // 记账在回调里收尾：setDataMs 只有框架回调才知道，而那正是"块到底哪一刻上屏"的判据。
  reportRender(uiTiming, reason, started, loadMs, readDoneAt, changed, buildMs, applied, patch) {
    let environment = ''
    // 只是账本里的一列，取不到就留空 —— 绝不让记账影响业务结果。
    try { environment = require('../../utils/data-runtime').environment() } catch (error) { environment = '' }
    let bytes = 0
    if (applied && patch) { try { bytes = JSON.stringify(patch).length } catch (error) {} }
    const entry = {
      reason: reason || 'view', environment,
      revision: Number.isInteger(this._renderedRevision) ? this._renderedRevision : null,
      gapMs: readDoneAt ? Math.max(0, started - readDoneAt) : 0,
      loadMs, buildMs, cellsChanged: changed, setDataBytes: bytes, setDataMs: 0, applied
    }
    const write = setDataMs => {
      entry.setDataMs = setDataMs
      entry.totalMs = Date.now() - started
      try { if (uiTiming.worth(entry)) uiTiming.record(entry) } catch (error) {}
    }
    if (!applied || !patch) { write(0); return }
    const sentAt = Date.now()
    // ⛔ 最后一次 setData 的回调里顺手排一次行高重算：这是所有上屏路径的汇聚点，
    //    任何让凌晨提示条出现/消失（行数变了）的刷新都会在这里被兜住。
    try { this.setData(patch, () => { write(Date.now() - sentAt); this.syncRowHeight() }) }
    catch (error) { write(0) }
  },

  swiperChange(e) {
    if(this.recyclingSwiper || e.detail.source!=='touch' || e.detail.current===1)return
    this.data.swiperCurrent=e.detail.current
    const direction=e.detail.current===2?1:-1, oldSlides=this.data.weekSlides, selectedDate=addDays(this.data.selectedDate,direction*7), centerStart=addDays(this.currentWeekStart,direction*7)
    const weekSlides=direction>0?[oldSlides[1],oldSlides[2],this.makeWeek(addDays(centerStart,7))]:[this.makeWeek(addDays(centerStart,-7)),oldSlides[0],oldSlides[1]]
    this.currentWeekStart=centerStart
    this.recyclingSwiper=true
    this.setData({selectedDate,weekSlides,swiperCurrent:1,swiperDuration:0,...this.weekHeaderPatch(weekSlides[1],selectedDate)},()=>{
      wx.nextTick(()=>this.setData({swiperDuration:280},()=>{this.recyclingSwiper=false}))
    })
  },

  // ⭐ 凌晨时段：收起 / 展开。
  //  ⛔ 收起 = 那 6 行不进 rows（不是用 CSS 藏起来）⇒ DOM 里一格都不剩；
  //     但提示条仍然在（写着"有 N 节课"）⇒ 随时点回来，不存在静默隐藏。
  //  ⛔ 一条业务数据都不动：这只是"铺几行"的事，cache.bySlot / 占用判定 / 冲突算法全都不受影响。
  toggleLate() {
    this.setData({ lateExpanded: !this.data.lateExpanded }, () => this.renderCurrentView())
  },

  today() {
    const selectedDate=todayKey()
    this.setData({selectedDate,viewMode:'week',viewModeName:'周',datePickMode:'',calendarAnim:''},()=>this.renderWeek())
  },

  setView(e) {
    const mode=e.currentTarget.dataset.mode,names={month:'月',week:'周',day:'日'}
    this.setData({viewMode:mode,viewModeName:names[mode],datePickMode:''},()=>this.renderCurrentView())
  },

  periodTouchStart(e) { const t=e.touches[0];this.periodTouch={x:t.clientX,y:t.clientY} },
  periodTouchEnd(e) { if(!this.periodTouch)return;const t=e.changedTouches[0],dx=t.clientX-this.periodTouch.x,dy=t.clientY-this.periodTouch.y;this.periodTouch=null;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.2)this.animatePeriod(dx<0?1:-1) },
  animatePeriod(direction) {
    if(this.data.calendarAnim||this.data.viewMode==='week')return
    this.setData({calendarAnim:direction>0?'slide-out-left':'slide-out-right'})
    setTimeout(()=>{
      const selectedDate=this.data.viewMode==='day'?addDays(this.data.selectedDate,direction):addMonths(this.data.selectedDate,direction)
      this.setData({selectedDate},()=>{this.renderCurrentView();this.setData({calendarAnim:direction>0?'slide-in-right':'slide-in-left'});setTimeout(()=>this.setData({calendarAnim:''}),150)})
    },120)
  },

  pickDate(e) { this.setData({selectedDate:e.detail.value},()=>this.renderCurrentView()) },
  openDateCalendar(){this.setData({viewMode:'month',viewModeName:'月',datePickMode:'navigate'},()=>this.renderMonth())},
  monthDay(e){const date=e.currentTarget.dataset.date;if(!date)return;this.setData({selectedDate:date,viewMode:'day',viewModeName:'日',datePickMode:''},()=>this.renderDay())},

  openShareAvailable(){
    const today=todayKey(),tomorrow=addDays(today,1)
    wx.hideTabBar({animation:true})
    this.setData({shareSheet:true,shareStage:'choose',shareDate:today,shareDateLabel:'',shareSlots:[],shareText:'',shareTodayLabel:this.shareDayLabel(today),shareTomorrowLabel:this.shareDayLabel(tomorrow)})
  },
  closeShareAvailable(){wx.showTabBar({animation:true});this.setData({shareSheet:false,shareStage:'choose'})},
  shareDayLabel(date){const p=dateParts(date);return `${p.month}月${p.day}日 · 周${WEEK_NAMES[p.weekday]}`},
  chooseShareToday(){this.prepareShareAvailable(todayKey())},
  chooseShareTomorrow(){this.prepareShareAvailable(addDays(todayKey(),1))},
  chooseShareDate(e){this.prepareShareAvailable(e.detail.value)},
  backShareChoice(){this.setData({shareStage:'choose',shareDate:todayKey(),shareDateLabel:'',shareSlots:[],shareText:''})},
  prepareShareAvailable(date){
    const slots=this.availableRanges(date),p=dateParts(date),title=`${p.month}月${p.day}日（周${WEEK_NAMES[p.weekday]}）`
    const shareText=slots.length?`${title}可预约\n\n${slots.join('\n')}\n\n以上时段都可以选择合适的时间预约，你看几点方便？`:`${title}暂时没有可预约时间，我们再看看其他日期吧。`
    this.setData({shareStage:'preview',shareDate:date,shareDateLabel:this.shareDayLabel(date),shareSlots:slots,shareText})
  },
  availableRanges(date){
    // ⭐ 可约窗口 = 06:00 起、最后一个开课时间 23:00（对外分享用的口径）：
    //   ① 起点直接读 occupancy.EARLIEST_START_MINUTES（不写数字）⇒ 2026-10-03 口径统一到 06:00 后，
    //      这里一行没动就跟着变成 06:00 ⇒ 分享出去的时段与他人自助能约的时段始终是同一套口径。
    //   ② 终点：2026-10-01 二次口径 —— 23:00 是当天最后一个开课时间
    //      （23:00 + 60 ⇒ 24:00 结束）⇒ 窗口下沿算到 1440（当天 24:00）。
    //      ⛔ 旧的 1470（次日 00:30）口径随"取消 23:30 开课"一并作废；
    //         存量的跨午夜课仍由 busyRangesOf 照实带出 ⇒ 只是不再对外扩窗口。
    //      ⛔ 两个端点必须取自 occupancy（写死数字就会出现两套口径）。
    const dayStart=occupancy.EARLIEST_START_MINUTES,dayEnd=occupancy.LATEST_START_MINUTES+occupancy.DEFAULT_PLANNED_MINUTES,minBookable=occupancy.DEFAULT_PLANNED_MINUTES
    // ⭐ 占用区间走 scheduleView.busyRangesOf（绝对时间轴）：
    //   昨晚上到今天的课 ⇒ 今天清晨那一段也算被占住 ⇒ 不会对外说"那会儿可约"（要求 ⑤）。
    const rows=(this.scheduleCache&&this.scheduleCache.rows)||[]
    const occupied=scheduleView.busyRangesOf(rows,date)
      .map(range=>({start:Math.max(dayStart,range.start),end:Math.min(dayEnd,range.end)}))
      .filter(x=>x.start<x.end).sort((a,b)=>a.start-b.start||a.end-b.end)
    const merged=[]
    occupied.forEach(range=>{const last=merged[merged.length-1];if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range})})
    const free=[];let cursor=dayStart
    merged.forEach(range=>{if(range.start-cursor>=minBookable)free.push(`${this.formatShareMinute(cursor)}–${this.formatShareMinute(range.start)}`);cursor=Math.max(cursor,range.end)})
    if(dayEnd-cursor>=minBookable)free.push(`${this.formatShareMinute(cursor)}–${this.formatShareMinute(dayEnd)}`)
    return free
  },
  // ⛔ 存量跨午夜课的分钟可能 > 1440（23:30 + 60 = 1470）⇒ 仍要显示成次日 00:30，不能显示成 24:30。
  formatShareMinute(total){const value=total>24*60?total-24*60:total;return `${pad(Math.floor(value/60))}:${pad(value%60)}`},
  copyShareAvailable(){wx.setClipboardData({data:this.data.shareText,success:()=>{this.closeShareAvailable();wx.showToast({title:'已复制，可直接发送',icon:'success'})}})},
  cell(e){
    const {date,hour}=e.currentTarget.dataset
    // ⭐ 判据要拿整份名单（不是这一天那几节）：跨午夜的课从昨天延过来，
    //   它占用的可是今天（要求 ⑤：10-03 00:00 必须判为已占用，不许从这里新建）。
    const rows=(this.scheduleCache&&this.scheduleCache.rows)||[]
    const intent=scheduleView.cellTapIntentOf(rows,date,hour)
    if(intent.kind==='open')return this.openBooking(intent.row)
    if(intent.kind==='too-late'){
      return wx.showModal({title:'这个时间排不了',content:occupancy.START_TOO_LATE_MESSAGE,showCancel:false})
    }
    this.setData({modal:true,presetDate:date,presetHour:+hour})
  },
  // ⭐ 打开「课程详情」的唯一入口：点课程卡片、点被占用的时间片，都走这一处。
  //   两条路径共用 ⇒ 不会出现"这张卡能进、那一格进不去"的第二种口径。
  //   ⛔ 详情入口不过任何时间闸 —— 「最晚 23:00 开课」只约束新建/改期的开始时间，
  //      绝不能拦住已经约好的课（存量的 23:30 跨午夜课是合法的历史数据，不是非法预约）。
  booking(e){
    const dataset=(e&&e.currentTarget&&e.currentTarget.dataset)||{}
    this.openBooking({id:dataset.id,pendingKey:dataset.pending})
  },
  openBooking(row){
    const pendingKey=row&&row.pendingKey
    // 刚约完就能直接进课程开始录训练内容。云端可能还没转正，页面以「本机编辑态」进入 ——
    // 身份用真实时段业务键（pending:<key>），绝不伪造一个 bookingId 去跑正式命令；
    // 转正后同一个页面实例自动接到正式 booking 上，训练内容不丢、也不会出现第二条预约。
    if(pendingKey){
      const record=pendingBookingRecords().find(item=>item.pendingKey===pendingKey)
      const status=record?record.pendingStatus:'pending'
      // 正常路径（命令刚发出，通常一两秒落定）直接进课程。
      // 只有结果未知 / 同步中才先说明一句，并同时给出幂等的「重新确认」（先查 receipt，绝不盲目重发）。
      if(status==='unknown'||status==='syncing'){
        wx.showModal({title:'预约确认中',content:'这条预约还在云端确认。可以先进入课程录训练内容，内容会安全存在本机，云端确认后自动保存。也可以先向云端重新确认一次结果（不会重复预约）。',confirmText:'进入课程',cancelText:'重新确认',success:res=>{if(res.confirm)wx.navigateTo({url:`/pages/session/session?pending=${encodeURIComponent(pendingKey)}`});else if(res.cancel)mutate.retryPendingBooking(pendingKey)}})
        return
      }
      wx.navigateTo({url:`/pages/session/session?pending=${encodeURIComponent(pendingKey)}`})
      return
    }
    wx.navigateTo({url:`/pages/session/session?id=${(row&&row.id)||''}`})
  },
  add(){this.setData({modal:true,presetDate:todayKey(),presetHour:Math.max(7,Math.min(24,currentHour()))})},
  closeModal(){this.setData({modal:false})},
  // 「下课 + 复制课程内容」一旦出现「完课已成功、内容还没确认进剪贴板」，
  // 就必须有人在用户不动手的前提下把它补完。这就是那个补手：
  // 每次进入课表（也就是每次下课之后回到的第一屏）顺手试一次，只试剪贴板。
  // 幂等：成功即撤掉待复制记录，失败就留着等下一次页面显示 —— 既不假装成功、也不催用户。
  resumeContentCopy(){
    try{
      const runtime=require('../../utils/data-runtime')
      const cache=wx.getStorageSync(runtime.cacheKey())
      if(!cache||!cache.datasetId)return
      const pending=require('../../utils/completion-copy').resumePending(runtime.environment(),cache.datasetId)
      if(!pending||typeof pending.then!=='function')return
      pending.then(result=>{if(result&&result.copied&&result.copied.length)wx.showToast({title:'课程内容已复制',icon:'none',duration:2000})},()=>{})
    }catch(error){}
  },
  // 本机意图 / 云端数据发生变化后的唯一入口。
  // 「数据到达 → 显示」这一段只走 applyLatestData：只推变了的格子，数据没变就一次 setData 都不发。
  saved(){
    let readDoneAt = 0
    try {
      const ui = require('../../utils/ui-cloud-command')
      // lastReadDoneAt = 读取层确认完成的那一刻（与读取账本那一行的时刻同源）。
      // 用它把"读取完成 → 开始装载"单独量成一列；拿不到时记 0，绝不编一个值。
      if (typeof ui.lastReadDoneAt === 'function') readDoneAt = ui.lastReadDoneAt()
    } catch (error) { readDoneAt = 0 }
    this.applyLatestData('view', readDoneAt)
  },
  // 保存事件只负责刷新课表。
  onBookingSaved() {
    this.saved()
  },
  refreshScheduleNow() {
    this.applyLatestData('view', 0)
  }
}, { refresh(reason) { return this.refreshSchedule({ userInitiated: false, reason }) } }))

