// 教练端「会员详情」（2026-10-06 新会员方案）
//
// ⭐⭐ 权限只有**服务端**说了算：`readMemberDetail` 会按真实创建记录判 `isOwner`。
//    · 主管教练（第一个录入这位会员的人）：能改手机号、能建/改课时包、能充值、能改价格；
//    · 其他教练：只能排课与记录训练，页面明说「课时包由主管教练管理」。
// ⛔ 客户端改 `isOwner` 没用 —— 它来自服务端那一行 `ownerCoachId`。
const directory = require('../../utils/member-directory')

Page({
  data: {
    memberId: '', member: null, summary: null, isOwner: false, note: '', history: [],
    loading: false, busy: false, editOpen: false, draftName: '', errorText: ''
  },
  onLoad(query) {
    query = query || {}
    this.setData({ memberId: String(query.memberId || '') })
    this.load()
  },
  onPullDownRefresh() {
    this.load().then(() => (wx.stopPullDownRefresh && wx.stopPullDownRefresh()), () => (wx.stopPullDownRefresh && wx.stopPullDownRefresh()))
  },
  async load() {
    if (!this.data.memberId) return this.setData({ errorText: '没有指定要查看的会员。' })
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const result = await directory.readMemberDetail(this.data.memberId)
      if (!result || result.ok !== true) return this.setData({ errorText: (result && result.message) || '暂时读不到这位会员，请下拉刷新重试。' })
      this.setData({
        member: result.member, summary: result.summary, isOwner: result.isOwner === true,
        note: result.note || '', history: Array.isArray(result.history) ? result.history : [], errorText: ''
      })
    } finally { this.setData({ loading: false }) }
  },
  openEdit() {
    if (!this.data.isOwner) return wx.showToast({ title: directory.TEXTS.NOT_OWNER, icon: 'none' })
    const member = this.data.member || {}
    this.setData({ editOpen: true, draftName: String(member.displayName || '') })
  },
  closeEdit() { if (!this.data.busy) this.setData({ editOpen: false }) },
  onDraftName(e) { this.setData({ draftName: String((e && e.detail && e.detail.value) || '') }) },
  async save() {
    if (this.data.busy) return
    const patch = { memberId: this.data.memberId, displayName: String(this.data.draftName || '').trim() }
    if (!patch.displayName) return wx.showToast({ title: '昵称不能为空', icon: 'none' })
    this.setData({ busy: true })
    try {
      const result = await directory.updateMemberCore(patch, directory.newRequestId('edit'))
      if (!result || result.ok !== true) return wx.showModal({ title: '没有保存成功', content: (result && result.message) || '请稍后重试。', showCancel: false })
      this.setData({ editOpen: false })
      await this.load()
      wx.showToast({ title: '已保存', icon: 'none' })
    } finally { this.setData({ busy: false }) }
  },
  schedule() {
    wx.navigateTo({ url: `/pages/member-book-slots/member-book-slots?coachView=1&memberId=${encodeURIComponent(this.data.memberId)}` })
  }
})
