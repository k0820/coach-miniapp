const directory = require('../../utils/member-directory')
const role = require('../../utils/app-role')
const memberEnvironment = require('../../utils/member-environment')

Page({
  data: {
    scene: '', member: null, summary: null, state: '', loading: false, busy: false,
    errorText: '', actionText: '确认领取这份资料'
  },
  onLoad(query) {
    const app = getApp()
    const scene = String(query && query.scene || app && app.globalData && app.globalData.memberEntryScene || '')
    memberEnvironment.enterFromClaimScene(scene)
    // 启动路由的第二道保护：同一微信已经领取过这份资料时，旧二维码入口只负责唤醒小程序，
    // 不再重新走一次性领取流程。
    if (role.raw() === 'member' && memberEnvironment.isRememberedClaimScene(scene)) {
      if (app && app.globalData) { app.globalData.activeRole = 'member'; app.globalData.memberEntryScene = '' }
      wx.reLaunch({ url: '/pages/member-home/member-home' })
      return
    }
    this.setData({ scene })
    this.preview()
  },
  async preview() {
    if (!this.data.scene || this.data.loading) return this.setData({ errorText: '二维码内容不完整，请让教练重新生成。' })
    this.setData({ loading: true, errorText: '' })
    try {
      const result = await directory.previewMemberClaimQr(this.data.scene)
      if (!result || result.ok !== true) return this.setData({ member: null, summary: null, errorText: (result && result.message) || '暂时读不到这份会员资料。' })
      const actionText = result.state === 'mine' ? '进入我的会员端' : (result.state === 'claimed' ? '这份资料已被领取' : '确认领取这份资料')
      const member = result.member ? { ...result.member, initial: String(result.member.displayName || '会').slice(0, 1) } : null
      this.setData({ member, summary: result.summary || null, state: result.state || '', actionText })
      // 本机记忆缺失时，以云端“这份资料就是我的”为可信兜底，自动恢复登录。
      if (result.state === 'mine') {
        role.set('member')
        memberEnvironment.rememberClaimScene(this.data.scene)
        const app = getApp()
        if (app && app.globalData) { app.globalData.activeRole = 'member'; app.globalData.memberEntryScene = '' }
        wx.reLaunch({ url: '/pages/member-home/member-home' })
      }
    } finally { this.setData({ loading: false }) }
  },
  async confirm() {
    if (this.data.busy || this.data.state === 'claimed') return
    this.setData({ busy: true, errorText: '' })
    try {
      const result = await directory.claimMemberByQr(this.data.scene, directory.newRequestId('claim-member-qr'))
      if (!result || result.ok !== true) return this.setData({ errorText: (result && result.message) || '领取失败，请稍后重试。' })
      role.set('member')
      memberEnvironment.enterFromClaimScene(this.data.scene)
      memberEnvironment.rememberClaimScene(this.data.scene)
      const app = getApp()
      if (app && app.globalData) { app.globalData.activeRole = 'member'; app.globalData.memberEntryScene = '' }
      wx.showToast({ title: result.alreadyMine ? '已自动登录' : '领取成功', icon: 'success' })
      setTimeout(() => wx.reLaunch({ url: '/pages/member-home/member-home' }), 450)
    } finally { this.setData({ busy: false }) }
  }
})
