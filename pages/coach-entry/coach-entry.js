const memberEnvironment = require('../../utils/member-environment')
const theme = require('../../utils/member-theme')

Page({
  data: { busy: false, note: '', themeStyle: theme.cssVars() },
  async loginWechat() {
    if (this.data.busy) return
    this.setData({ busy: true, note: '' })
    memberEnvironment.exitToCoach()
    const app = getApp()
    app.globalData.activeRole = 'coach'
    let result
    try { result = await app.startCoachRuntime('coach-login') }
    catch (error) { result = { ok: false, code: 'LOGIN_FAILED', message: String(error && error.message || error) } }
    const usable = result && (result.ok === true || result.code === 'BOOTSTRAP_LOCAL_DATA_PRESENT' || result.code === 'BOOTSTRAP_ALREADY_CLOUD')
    if (usable) return wx.reLaunch({ url: '/pages/schedule/schedule' })
    this.setData({ busy: false, note: (result && result.message) || '暂时无法登录，请检查网络后再试。' })
  },
  back() { wx.navigateBack() }
})
