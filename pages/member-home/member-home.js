// 会员首页（2026-10-06 新会员方案）
//
// ⭐⭐ 与旧版的根本区别：这里**不再有**「训练档案 / 当前档案 / 切换档案」这几个概念。
//    一位会员只有一份资料：当前微信 ⇒ 唯一的会员；他的课时、预约、训练记录都跟着这份资料走。
//
// ⭐ 首页只回答三件事：还剩多少课、下一节是什么、现在去预约。
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
const archiveState = require('../../utils/member-archive-state')
const trainingView = require('../../utils/member-training-view')
const localAlias = require('../../utils/member-local-alias')
// ⛔ 自动刷新总线：全项目共用一条广播（缺订阅者那次事故之后，每页都必须真的订阅）。
const installAutoRefresh = require('../../utils/auto-refresh').installPage
Page(installAutoRefresh({
  data: {
    vm: directory.homeView(null), sandbox: false, busy: false, errorText: '', incompleteText: '', notice: [],
    themeStyle: theme.cssVars(), snapshotReady: false, refreshing: false,
    trainingSummary: trainingView.recentSummary([]), displayName: '', aliasOpen: false, aliasDraft: ''
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
  onShow() {
    require('../../utils/auto-refresh').request('pageShow')
    this.setData({ sandbox: runtime.environment() === 'sandbox' })
    this.renderNotice()
    this.refreshAlias()
    const cached = directory.cachedDashboard()
    if (cached) this.applyDashboard(cached)
    this.load({ silent: !!cached })
    this.refreshTraining()
  },
  refreshHome() {
    if (this.data.refreshing) return Promise.resolve(false)
    this.setData({ refreshing: true })
    const dashboard = Promise.resolve(this.load({ silent: true })).catch(() => undefined)
    const training = Promise.resolve(this.refreshTraining()).catch(() => undefined)
    return Promise.all([dashboard, training]).then(() => true).finally(() => this.setData({ refreshing: false }))
  },
  onRefresherRefresh() { return this.refreshHome() },
  // 保留页面级刷新入口给旧版基础库兜底；新版界面由无图标的 scroll-view 下拉触发。
  onPullDownRefresh() {
    const done = () => { if (wx.stopPullDownRefresh) wx.stopPullDownRefresh() }
    return this.refreshHome().then(done, done)
  },
  applyDashboard(result) {
    const vm = directory.homeView(result)
    this.setData({ vm, displayName: localAlias.read() || String((vm.member && vm.member.displayName) || ''), errorText: '', snapshotReady: true })
  },
  refreshAlias() {
    const original = String((this.data.vm.member && this.data.vm.member.displayName) || '')
    this.setData({ displayName: localAlias.read() || original })
  },
  openAlias() { this.setData({ aliasOpen: true, aliasDraft: this.data.displayName || '' }) },
  closeAlias() { this.setData({ aliasOpen: false }) },
  aliasInput(e) { this.setData({ aliasDraft: String((e && e.detail && e.detail.value) || '') }) },
  saveAlias() {
    const value = localAlias.write(this.data.aliasDraft)
    const original = String((this.data.vm.member && this.data.vm.member.displayName) || '训练伙伴')
    this.setData({ displayName: value || original, aliasOpen: false })
    wx.showToast({ title: value ? '称呼已保存' : '已恢复原称呼', icon: 'success' })
  },
  applyTraining(raw) {
    const scoped = archiveState.narrow(raw || {}) || {}
    this.setData({ trainingSummary: trainingView.recentSummary(trainingView.rowsOf(scoped)) })
  },
  async refreshTraining() {
    this.applyTraining(member.cached())
    try { this.applyTraining(await member.read({ allowCache: true })) } catch (error) { /* 首页继续显示本机最近一次训练摘要 */ }
  },
  async load(options = {}) {
    if (this.data.busy) return
    this.setData({ busy: true, ...(options.silent ? {} : { snapshotReady: false }) })
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
      this.applyDashboard(result)
    } finally {
      this.setData({ busy: false })
    }
  },
  go(url) { wx.navigateTo({ url }) },
  packages() { return this.go('/pages/member-packages/member-packages') },
  bookings() { return this.go('/pages/member-bookings/member-bookings') },
  history() { return this.go('/pages/member-history/member-history') }
}, { refresh() { return this.load({ silent: true }) } }))
