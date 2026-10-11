// 「我的」（2026-10-06 新会员方案）
//
// ⭐⭐ 与旧版最大的区别：这里**不再出现**「已认领训练档案 / 查看或切换档案 / 解除认领 / 认领已有训练记录」。
//    那些东西整套拿掉了 —— 一位会员只有一份资料，不需要"选档案"。
//
// ⭐ 当前产品为单教练：会员资料直接归属唯一教练，不再展示添加 / 切换教练入口。
// 菜单保留课时、预约、训练记录，以及测试区可用的站内消息入口。
//
// ⛔ memberId / 手机号全文都不出现在页面上：这里只显示昵称与手机号**尾号**。
const directory = require('../../utils/member-directory')
const theme = require('../../utils/member-theme')
const runtime = require('../../utils/data-runtime')
const { switchEnvironment } = require('../../utils/ui-cloud-command')
const memberEnvironment = require('../../utils/member-environment')
const routing = require('../../utils/sandbox-cloud-functions')
// 📥 站内消息中心（⛔ 正式区没有 ⇒ 入口整个藏起来）
const inbox = require('../../utils/notification-inbox')

Page({
  data: {
    member: {}, initial: '我', publicCode: '', busy: false, themeStyle: theme.cssVars(),
    nameOpen: false, nameDraft: '', nameBusy: false, sandboxHint: '',
    inboxAvailable: false, inboxUnread: 0, directoryAvailable: directory.available(), errorText: ''
  },
  async loadInboxUnread() {
    this.setData({ inboxAvailable: inbox.available() })
    if (!inbox.available()) return this.setData({ inboxUnread: 0 })
    this.setData({ inboxUnread: await inbox.unread('member') })
  },
  onShow() {
    require('../../utils/auto-refresh').request('pageShow')
    this.setData({ sandboxHint: routing.hint(runtime.environment()), themeStyle: theme.cssVars(), directoryAvailable: directory.available() })
    this.load()
    this.loadInboxUnread()
  },
  async load() {
    const result = await directory.dashboard()
    if (!result || result.ok !== true) {
      if (result && (result.code === 'MEMBER_NOT_FOUND' || result.code === 'ACTOR_UNKNOWN' || result.code === 'MEMBER_BINDING_REQUIRED')) {
        wx.redirectTo({ url: '/pages/member-login/member-login' })
        return
      }
      return this.setData({ errorText: (result && result.message) || '暂时读不到你的资料，请下拉刷新重试。' })
    }
    const member = result.member || {}
    this.setData({
      member, initial: (String(member.displayName || '我')).slice(0, 1), publicCode: String(member.publicCode || ''),
      errorText: ''
    })
  },
  openInbox() { inbox.open('member') },
  go(url) { wx.navigateTo({ url }) },
  packages() { return this.go('/pages/member-packages/member-packages') },
  bookings() { return this.go('/pages/member-bookings/member-bookings') },
  history() { wx.navigateTo({ url: '/pages/member-history/member-history' }) },

  // ── 编辑昵称（⛔ 只能改昵称；手机号会不会错位是你这个会员的唯一标识，改不得） ──
  openName() {
    if (!directory.available()) return wx.showToast({ title: directory.SANDBOX_ONLY_NOTE, icon: 'none' })
    this.setData({ nameOpen: true, nameDraft: String((this.data.member && this.data.member.displayName) || '') })
  },
  closeName() { if (!this.data.nameBusy) this.setData({ nameOpen: false }) },
  onNameInput(e) { this.setData({ nameDraft: String((e && e.detail && e.detail.value) || '') }) },
  noop() {},
  async saveName() {
    const next = String(this.data.nameDraft || '').trim().slice(0, 30)
    if (!next) return wx.showToast({ title: '昵称不能为空', icon: 'none' })
    if (this.data.nameBusy) return
    this.setData({ nameBusy: true })
    try {
      const result = await directory.renameSelf(next)
      if (!result || result.ok !== true) {
        return wx.showModal({ title: '没有保存成功', content: (result && result.message) || '请稍后重试。', showCancel: false })
      }
      this.setData({ nameOpen: false })
      await this.load()
      wx.showToast({ title: '已改好', icon: 'none' })
    } finally { this.setData({ nameBusy: false }) }
  },
  async coachMode() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      const switched = await switchEnvironment(runtime.ENVIRONMENTS.PRODUCTION)
      if (!switched.ok) return wx.showToast({ title: '正式区暂时无法加载', icon: 'none' })
      memberEnvironment.exitToCoach()
      getApp().globalData.activeRole = 'coach'
      require('../../utils/sync-engine').resume()
      require('../../utils/cloud-bootstrap').maybeRun('member-switch')
      wx.reLaunch({ url: '/pages/schedule/schedule' })
    } finally { this.setData({ busy: false }) }
  }
})

