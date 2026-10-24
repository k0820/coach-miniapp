const memberEnvironment = require('../../utils/member-environment')
const theme = require('../../utils/member-theme')

Page({
  data: { busy: false, note: '', themeStyle: theme.cssVars() },
  loginWechat() {
    if (this.data.busy) return
    this.setData({ busy: true, note: '' })
    memberEnvironment.exitToCoach()
    const app = getApp()
    app.globalData.activeRole = 'coach'
    // 课表先打开，云端开通与完整读取在后台继续。已有账号立即显示本机缓存，
    // 新账号先显示空课表并在同步完成后刷新，不再把登录页卡在完整云读取上。
    try {
      const boot = app.startCoachRuntime('coach-login')
      Promise.resolve(boot).catch(error => console.error('[coach-login] background bootstrap failed', error))
    } catch (error) {
      console.error('[coach-login] runtime start failed', error)
    }
    wx.reLaunch({
      url: '/pages/schedule/schedule',
      fail: () => this.setData({ busy: false, note: '暂时无法进入课表，请重试。' })
    })
  },
  back() { wx.navigateBack() }
})
