const directory = require('../../utils/member-directory')
const theme = require('../../utils/member-theme')

// 会员身份只由“当前微信 + 教练生成的专属二维码”建立。
// 手机号只是教练通讯资料，不再承担登录，也不再显示手工手机号兜底。
Page({
  data: { themeStyle: theme.cssVars(), busy: false, note: '' },
  onShow() { this.checkBinding() },
  async checkBinding() {
    if (this.data.busy) return
    this.setData({ busy: true, note: '' })
    try {
      const result = await directory.dashboard()
      if (result && result.ok === true) {
        wx.reLaunch({ url: '/pages/member-home/member-home' })
        return
      }
      const code = String(result && result.code || '')
      if (!['MEMBER_NOT_FOUND', 'ACTOR_UNKNOWN', 'MEMBER_BINDING_REQUIRED'].includes(code)) {
        this.setData({ note: (result && result.message) || '网络暂时没有连上，请稍后重试。' })
      }
    } finally { this.setData({ busy: false }) }
  }
})
