// 会员首页（2026-10-06 新会员方案）
//
// ⭐⭐ 与旧版的根本区别：这里**不再有**「训练档案 / 当前档案 / 切换档案」这几个概念。
//    一位会员只有一份资料：当前微信 ⇒ 唯一的会员；他的课时、预约、训练记录都跟着这份资料走。
//
// ⭐ 三张卡（用户要求）：第一张「课时概况」/ 第二张「下一节课」/ 第三张「我的教练」。
//    下面三个快捷按钮：约一节课 / 查看预约 / 消息中心。
//
// ⛔ 显示成功必须来自云端：这里的所有数字**只有一次来源** —— `member-directory.dashboard()`。
//    ⛔ 读失败必须明说，⛔ 绝不让用户对着"0 课时"以为账号是空的。
const directory = require('../../utils/member-directory')
const runtime = require('../../utils/data-runtime')
const theme = require('../../utils/member-theme')
// ⛔ 环境 / 读取异常提示：仍然来自既有的会员读服务（`readMyMemberData`）那一套翻译层，
//    ⛔ 绝不静默 —— 少读一份、环境不对、账号没激活，都必须在首页说成人话。
const member = require('../../utils/member-runtime')
const view = require('../../utils/member-view-model')
const memberEnvironment = require('../../utils/member-environment')
// ⛔ 自动刷新总线：全项目共用一条广播（缺订阅者那次事故之后，每页都必须真的订阅）。
const installAutoRefresh = require('../../utils/auto-refresh').installPage
// 📥 站内消息中心（⛔ 正式区没有 ⇒ 入口整个藏起来）
const inbox = require('../../utils/notification-inbox')

Page(installAutoRefresh({
  data: {
    vm: directory.homeView(null), sandbox: false, busy: false, errorText: '', incompleteText: '', notice: [],
    themeStyle: theme.cssVars(), inboxAvailable: false, inboxUnread: 0
  },
  // ⛔ 异常不得静默：把「没读到 / 环境不一致 / 少读一份」翻成人话挂在首页顶部。
  renderNotice() {
    const raw = member.cached()
    const context = { environment: member.environment(), expected: memberEnvironment.read() }
    this.setData({
      notice: view.notice(raw, context),
      incompleteText: view.incompleteTextOf(raw || {})
    })
  },
  async loadInboxUnread() {
    this.setData({ inboxAvailable: inbox.available() })
    if (!inbox.available()) return this.setData({ inboxUnread: 0 })
    this.setData({ inboxUnread: await inbox.unread('member') })
  },
  onShow() {
    require('../../utils/auto-refresh').request('pageShow')
    this.setData({ sandbox: runtime.environment() === 'sandbox' })
    this.renderNotice()
    this.load()
    this.loadInboxUnread()
  },
  onPullDownRefresh() {
    this.load().then(noop => (wx.stopPullDownRefresh && wx.stopPullDownRefresh()), () => (wx.stopPullDownRefresh && wx.stopPullDownRefresh()))
  },
  async load() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      const result = await directory.dashboard()
      if (!result || result.ok !== true) {
        const code = (result && result.code) || ''
        // ⛔ 认不出"我是谁" ⇒ 回到登录页，⛔ 绝不停留在首页显示一堆 0。
        if (code === 'MEMBER_NOT_FOUND' || code === 'ACTOR_UNKNOWN' || code === 'MEMBER_BINDING_REQUIRED') {
          wx.redirectTo({ url: '/pages/member-login/member-login' })
          return
        }
        this.setData({ errorText: (result && result.message) || '暂时读不到你的课时，请下拉刷新重试。' })
        return
      }
      this.setData({ vm: directory.homeView(result), errorText: '' })
    } finally {
      this.setData({ busy: false })
    }
  },
  openInbox() { inbox.open('member') },
  go(url) { wx.navigateTo({ url }) },
  packages() { return this.go('/pages/member-packages/member-packages') },
  bookings() { return this.go('/pages/member-bookings/member-bookings') },
  history() { wx.navigateTo({ url: '/pages/member-history/member-history' }) },
  bookSlots() { return this.go('/pages/member-book-slots/member-book-slots') },
  bookCoach(e) {
    const contactKey = String((e && e.currentTarget && e.currentTarget.dataset.key) || '')
    if (!contactKey) return
    wx.navigateTo({ url: `/pages/member-book-slots/member-book-slots?coach=${encodeURIComponent(contactKey)}` })
  }
}, { refresh() { return this.load() } }))
