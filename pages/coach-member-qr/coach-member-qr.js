const directory = require('../../utils/member-directory')

Page({
  data: { studentRef: '', member: null, scene: '', imageUrl: '', shareImageUrl: '', bound: false, loading: false, rotating: false, unbinding: false, confirmRotate: false, confirmUnbind: false, errorText: '' },
  onLoad(query) {
    const studentRef = String(query && query.studentRef || '')
    const cached = directory.cachedMemberClaimQr(studentRef)
    this.setData({
      studentRef,
      member: cached && cached.member || null,
      scene: String(cached && cached.scene || ''),
      imageUrl: String(cached && (cached.imageUrl || cached.fileID) || ''),
      bound: !!(cached && cached.bound)
    })
    this.load()
  },
  async load() {
    if (!this.data.studentRef || this.data.loading) return
    this.setData({ loading: true, errorText: '' })
    try {
      const result = await directory.getMemberClaimQr(this.data.studentRef)
      if (!result || result.ok !== true) return this.setData({ errorText: (result && result.message) || '专属二维码生成失败，请稍后重试。' })
      const imageUrl = String(result.imageUrl || result.fileID || '')
      this.setData({ member: result.member || null, bound: result.bound === true, scene: String(result.scene || ''), imageUrl, shareImageUrl: '', errorText: imageUrl ? '' : '二维码已经生成，但图片暂时读取失败，请稍后重试。' })
      // 临时链接只用于分享卡封面，后台补取，不挡住二维码显示。
      directory.tempImageUrl(result.fileID).then(url => { if (url) this.setData({ shareImageUrl: url }) })
    } finally { this.setData({ loading: false }) }
  },
  onShareAppMessage() {
    const scene = encodeURIComponent(this.data.scene || '')
    return { title: '领取你的专属训练资料', path: `/pages/member-claim/member-claim?scene=${scene}`, imageUrl: this.data.shareImageUrl || this.data.imageUrl || '' }
  },
  openRotate() { this.setData({ confirmRotate: true }) },
  closeRotate() { if (!this.data.rotating) this.setData({ confirmRotate: false }) },
  openUnbind() { this.setData({ confirmUnbind: true }) },
  closeUnbind() { if (!this.data.unbinding) this.setData({ confirmUnbind: false }) },
  async unbindWechat() {
    if (this.data.unbinding) return
    this.setData({ unbinding: true, errorText: '' })
    try {
      const result = await directory.unbindMemberWechat(this.data.studentRef, directory.newRequestId('unbind-member-wechat'))
      if (!result || result.ok !== true) return this.setData({ errorText: (result && result.message) || '解除绑定失败，请稍后重试。' })
      this.setData({ confirmUnbind: false, bound: false })
      wx.showToast({ title: result.alreadyUnbound ? '当前没有微信绑定' : '微信绑定已解除', icon: 'none' })
    } finally { this.setData({ unbinding: false }) }
  },
  async rotateCode() {
    if (this.data.rotating) return
    this.setData({ rotating: true, errorText: '' })
    try {
      const result = await directory.rotateMemberClaimQr(this.data.studentRef, directory.newRequestId('rotate-member-qr'))
      if (!result || result.ok !== true) return this.setData({ errorText: (result && result.message) || '换码失败，请稍后重试。' })
      const imageUrl = String(result.imageUrl || result.fileID || '')
      this.setData({ confirmRotate: false, scene: String(result.scene || ''), imageUrl, shareImageUrl: '' })
      directory.tempImageUrl(result.fileID).then(url => { if (url) this.setData({ shareImageUrl: url }) })
      wx.showToast({ title: '新二维码已生成', icon: 'success' })
    } finally { this.setData({ rotating: false }) }
  },
  saveImage() {
    const url = this.data.imageUrl
    if (!url) return wx.showToast({ title: '二维码还没有准备好', icon: 'none' })
    wx.showLoading({ title: '正在保存' })
    const download = /^cloud:\/\//.test(url) && wx.cloud && wx.cloud.downloadFile
      ? options => wx.cloud.downloadFile({ fileID: url, ...options })
      : options => wx.downloadFile({ url, ...options })
    download({
      success: file => wx.saveImageToPhotosAlbum({
        filePath: file.tempFilePath,
        success: () => wx.showToast({ title: '已保存到相册', icon: 'none' }),
        fail: () => wx.showModal({ title: '没有保存成功', content: '请在微信设置中允许保存图片，然后再试一次。', showCancel: false })
      }),
      fail: () => wx.showToast({ title: '图片下载失败', icon: 'none' }),
      complete: () => wx.hideLoading()
    })
  }
})
