// 「我的联系人二维码」（2026-10-06 新会员方案）
//
// ⭐ 这张码只做一件事：让教练扫了之后**得到一张确认卡**（昵称 / 身份 / 手机尾号），
//    他点了「添加」才建立关系。⛔ 二维码里**没有**手机号、没有会员编号、没有任何联系方式。
//
// ⛔⛔ 两条硬纪律：
//   ① 页面**不显示**完整手机号与内部编号（服务端只下发手机尾号，这里原样渲染）；
//   ② 出码失败必须如实报缺口 ⇒ 提示改用公开编号添加，⛔ 绝不给一张能扫但没内容的占位图。
const directory = require('../../utils/member-directory')
const theme = require('../../utils/member-theme')

Page({
  data: {
    busy: false, drawing: false, saving: false, profile: null, publicCode: '', note: '',
    imageUrl: '', themeStyle: theme.cssVars()
  },
  onShow() { this.load() },
  copyCode() {
    const code = String(this.data.publicCode || '').trim()
    if (!code) return wx.showToast({ title: '会员编号还在生成，请稍后再试。', icon: 'none' })
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '会员编号已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请再长按一次。', icon: 'none' })
    })
  },
  async load() {
    const result = await directory.dashboard()
    if (result && result.ok && result.member) {
      this.setData({ profile: result.member, publicCode: String(result.member.publicCode || '') })
    }
    this.draw()
  },
  async draw() {
    if (this.data.drawing) return
    this.setData({ drawing: true, note: '' })
    try {
      const result = await directory.drawQr()
      if (!result || result.ok !== true || !result.imageUrl) {
        return this.setData({ imageUrl: '', note: (result && result.message) || '暂时生成不了二维码，请把会员编号发给教练。' })
      }
      this.setData({ imageUrl: result.imageUrl, note: '' })
    } finally { this.setData({ drawing: false }) }
  },
  async save() {
    const url = String(this.data.imageUrl || '')
    if (!url || this.data.saving) return
    this.setData({ saving: true })
    try {
      const downloaded = await new Promise((resolve, reject) => {
        wx.downloadFile({ url, success: resolve, fail: reject })
      })
      const file = downloaded && downloaded.tempFilePath
      if (!file) return wx.showToast({ title: '图片没下载下来，请重试。', icon: 'none' })
      wx.saveImageToPhotosAlbum({ filePath: file, success: () => wx.showToast({ title: '已保存到相册', icon: 'none' }), fail: () => wx.showToast({ title: '没有保存到相册，请重试。', icon: 'none' }) })
    } catch (error) {
      wx.showToast({ title: '保存失败，请重试。', icon: 'none' })
    } finally { this.setData({ saving: false }) }
  }
})

