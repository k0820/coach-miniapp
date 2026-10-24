// 「我的」（2026-10-06 新会员方案）
//
// ⭐⭐ 与旧版最大的区别：这里**不再出现**「已认领训练档案 / 查看或切换档案 / 解除认领 / 认领已有训练记录」。
//    那些东西整套拿掉了 —— 一位会员只有一份资料，不需要"选档案"。
//
// ⭐ 当前产品为单教练：会员资料直接归属唯一教练，不再展示添加 / 切换教练入口。
// 菜单只保留课包与训练记录；预约已在首页，消息卡片按产品决定撤下。
//
// ⛔ memberId / 手机号全文都不出现在页面上：这里只显示昵称与手机号**尾号**。
const directory = require('../../utils/member-directory')
const theme = require('../../utils/member-theme')
const runtime = require('../../utils/data-runtime')
const memberRuntime = require('../../utils/member-runtime')
const archiveState = require('../../utils/member-archive-state')
const trainingView = require('../../utils/member-training-view')
Page({
  data: {
    member: {}, initial: '我', publicCode: '', busy: false, themeStyle: theme.cssVars(),
    nameOpen: false, nameDraft: '', nameBusy: false, canRename: false,
    directoryAvailable: directory.available(), errorText: '', snapshotReady: false,
    trainingSummary: trainingView.recentSummary([])
  },
  onShow() {
    require('../../utils/auto-refresh').request('pageShow')
    this.setData({ canRename: runtime.isSandbox(), themeStyle: theme.cssVars(), directoryAvailable: directory.available() })
    const cached = directory.cachedDashboard()
    if (cached) this.applyDashboard(cached)
    this.load({ silent: !!cached })
    this.refreshTraining()
  },
  applyDashboard(result) {
    const member = result.member || {}
    this.setData({
      member, initial: (String(member.displayName || '我')).slice(0, 1), publicCode: String(member.publicCode || ''),
      errorText: '', snapshotReady: true
    })
  },
  async load(options = {}) {
    if (!options.silent) this.setData({ snapshotReady: false })
    const result = await directory.dashboard()
    if (!result || result.ok !== true) {
      if (result && (result.code === 'MEMBER_NOT_FOUND' || result.code === 'ACTOR_UNKNOWN' || result.code === 'MEMBER_BINDING_REQUIRED')) {
        wx.redirectTo({ url: '/pages/member-login/member-login' })
        return
      }
      return this.setData({ errorText: (result && result.message) || '暂时读不到你的资料，请下拉刷新重试。' })
    }
    this.applyDashboard(result)
  },
  applyTraining(raw) {
    const scoped = archiveState.narrow(raw || {}) || {}
    this.setData({ trainingSummary: trainingView.recentSummary(trainingView.rowsOf(scoped)) })
  },
  async refreshTraining() {
    this.applyTraining(memberRuntime.cached())
    try { this.applyTraining(await memberRuntime.read({ allowCache: true })) } catch (error) { /* 首页资料仍可正常显示，训练记录保留本机最近一次内容 */ }
  },
  go(url) { wx.navigateTo({ url }) },
  packages() { return this.go('/pages/member-packages/member-packages') },
  history() { wx.navigateTo({ url: '/pages/member-history/member-history' }) },

  // ── 编辑昵称（⛔ 只能改昵称；手机号会不会错位是你这个会员的唯一标识，改不得） ──
  openName() {
    if (!this.data.canRename) return
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
  }
})

