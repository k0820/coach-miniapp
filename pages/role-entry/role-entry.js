const role = require('../../utils/app-role')
const memberEnvironment = require('../../utils/member-environment')
const theme = require('../../utils/member-theme')

Page({
  data: { themeStyle: theme.cssVars(), routing: false },
  onShow() {
    // 这个页面被看见，就代表用户明确点了微信左上角“小房子”或主动回到身份选择。
    // 已记住的身份只由 app.js 在真正冷启动时自动恢复；这里绝不能再次把人拉走。
    // 从教练登录页返回时同时解除按钮忙碌态，允许重新选择。
    if (this.data.routing) this.setData({ routing: false })
  },
  chooseMember() {
    if (this.data.routing) return
    this.setData({ routing: true })
    memberEnvironment.enterMember()
    getApp().globalData.activeRole = 'member'
    wx.reLaunch({ url: '/pages/member-login/member-login' })
  },
  chooseCoach() {
    if (this.data.routing) return
    this.setData({ routing: true })
    wx.navigateTo({
      url: '/pages/coach-entry/coach-entry',
      fail: () => this.setData({ routing: false })
    })
  }
})
