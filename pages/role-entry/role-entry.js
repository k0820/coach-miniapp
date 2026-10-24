const role = require('../../utils/app-role')
const memberEnvironment = require('../../utils/member-environment')
const theme = require('../../utils/member-theme')

Page({
  data: { themeStyle: theme.cssVars(), routing: false },
  onShow() {
    // 第一次使用才选择身份。认领成功后角色已经落盘，今后从搜索、小房子或后台恢复
    // 都应直接回自己的端，不能每次再让用户选择一次。
    if (!role.hasChoice()) {
      if (this.data.routing) this.setData({ routing: false })
      return
    }
    if (this.data.routing) return
    this.setData({ routing: true })
    wx.reLaunch({
      url: role.stored() === 'member' ? '/pages/member-home/member-home' : '/pages/schedule/schedule',
      fail: () => this.setData({ routing: false })
    })
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
    // 选择身份本身就是明确授权：立即记住“教练”，不要等下一页的云端
    // 初始化结束后才落盘。之后扫码进入或冷启动都会直接回课表。
    memberEnvironment.exitToCoach()
    getApp().globalData.activeRole = 'coach'
    wx.navigateTo({
      url: '/pages/coach-entry/coach-entry',
      fail: () => this.setData({ routing: false })
    })
  }
})
