// 教练端「我的联系人二维码」（2026-10-06 新会员方案）
//
// ⭐ 会员扫这张码 ⇒ 只得到一张**确认卡**（昵称 / 身份 / 手机尾号），点了「添加」才建立关系。
// ⛔ 二维码里没有手机号、没有教练编号、没有任何会员资料 —— 只有一个随机票据。
const directory = require('../../utils/member-directory')

Page({
  data: { drawing: false, saving: false, imageUrl: '', note: '', publicCode: '' },
  onShow() { this.draw() },
  async draw() {
    if (this.data.drawing) return
    this.setData({ drawing: true, note: '' })
    try {
      const result = await directory.drawQr()
      this.setData({ publicCode: String((result && result.publicCode) || this.data.publicCode || '') })
      if (!result || result.ok !== true || !result.imageUrl) {
        return this.setData({ imageUrl: '', note: (result && result.message) || '暂时生成不了二维码，请把教练编号发给会员。' })
      }
      this.setData({ imageUrl: result.imageUrl, publicCode: String(result.publicCode || ''), note: '' })
    } finally { this.setData({ drawing: false }) }
  },
  async save() {
    const url = String(this.data.imageUrl || '')
    if (!url || this.data.saving) return
    this.setData({ saving: true })
    try {
      const downloaded = await new Promise((resolve, reject) => { wx.downloadFile({ url, success: resolve, fail: reject }) })
      const file = downloaded && downloaded.tempFilePath
      if (!file) return wx.showToast({ title: '图片没下载下来，请重试。', icon: 'none' })
      wx.saveImageToPhotosAlbum({ filePath: file, success: () => wx.showToast({ title: '已保存到相册', icon: 'none' }), fail: () => wx.showToast({ title: '没有保存到相册，请重试。', icon: 'none' }) })
    } catch (error) { wx.showToast({ title: '保存失败，请重试。', icon: 'none' }) }
    finally { this.setData({ saving: false }) }
  }
})
