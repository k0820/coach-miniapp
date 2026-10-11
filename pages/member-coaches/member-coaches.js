// 「我的教练」（2026-10-06 新会员方案）
//
// ⭐ 这一页只显示**已经添加过的教练**（`listContacts` ⇒ 服务端按 OPENID 反查 ⇒ 客户端不可能指定要看谁）。
//    ⛔ 绝不列全平台教练 ⇒ 会员看不见别人的教练，也就不可能约到。
//
// ⛔ 移除教练只断关系：**历史课程 / 收入 / 训练记录一样都不删** ——
//    这点由服务端保证（`removeContact` 返回 `historyKept:true`），界面负责把这句话说清楚。
const directory = require('../../utils/member-directory')
const theme = require('../../utils/member-theme')

Page({
  data: {
    contacts: [], count: 0, busy: false, loading: false, errorText: '',
    themeStyle: theme.cssVars(), removingKey: ''
  },
  onShow() { this.load() },
  onPullDownRefresh() {
    this.load().then(() => (wx.stopPullDownRefresh && wx.stopPullDownRefresh()), () => (wx.stopPullDownRefresh && wx.stopPullDownRefresh()))
  },
  async load() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const result = await directory.contacts()
      if (!result || result.ok !== true) return this.setData({ errorText: (result && result.message) || '暂时读不到你的教练名单，请下拉刷新重试。' })
      const rows = Array.isArray(result.contacts) ? result.contacts : []
      this.setData({ contacts: rows, count: rows.length, errorText: '' })
    } finally { this.setData({ loading: false }) }
  },
  addByCode() { wx.navigateTo({ url: '/pages/member-add-coach/member-add-coach?way=code' }) },
  addByScan() { wx.navigateTo({ url: '/pages/member-add-coach/member-add-coach?way=scan' }) },
  book(e) {
    const key = String((e && e.currentTarget && e.currentTarget.dataset.key) || '')
    if (!key) return
    wx.navigateTo({ url: `/pages/member-book-slots/member-book-slots?coach=${encodeURIComponent(key)}` })
  },
  // 🗑 移除：⛔ 二次确认，并把"历史全部保留"写在确认框里（不许让用户以为会把课删掉）。
  askRemove(e) {
    const key = String((e && e.currentTarget && e.currentTarget.dataset.key) || '')
    const name = String((e && e.currentTarget && e.currentTarget.dataset.name) || '这位教练')
    wx.showModal({
      title: `移除「${name}」？`,
      content: '只是把这位教练从你的名单里拿掉。已经上过的课、课时和训练记录全部保留，以后还能重新添加。',
      confirmText: '移除', success: answer => { if (answer.confirm) this.remove(key) }
    })
  },
  async remove(key) {
    if (!key || this.data.busy) return
    this.setData({ busy: true, removingKey: key })
    try {
      const result = await directory.removeContact(key)
      if (!result || result.ok !== true) {
        return wx.showModal({ title: '没有移除成功', content: (result && result.message) || '请稍后重试。', showCancel: false })
      }
      wx.showToast({ title: '已移除，历史记录都保留着', icon: 'none' })
      await this.load()
    } finally { this.setData({ busy: false, removingKey: '' }) }
  }
})

