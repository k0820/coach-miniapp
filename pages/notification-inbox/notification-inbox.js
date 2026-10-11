// 📥 站内消息中心（2026-10-06 需求五 / 需求六）—— 会员端与教练端**共用**这一页
//
// ⭐⭐ 它解决的是一件微信解决不了的事：微信「一次性订阅」**一条授权只够一条提醒**
//    （已在公众平台核实：长期订阅页面显示「暂时没有可选用的模板」）。
//    ⇒ 站内消息**不限次数、不依赖微信授权**：预约 / 取消 / 改期 / 教练排课 / 取消 / 改期
//      都会给**双方各写一条**独立消息；微信没额度时，这两条**照旧存在**。
//
// ⛔ 三条硬纪律：
//   ① 身份由 `?role=member|coach` 决定，**两个角色的消息箱完全隔离**（服务端按角色分集合）。
//   ② 客户端**只**说"我在看哪一端"，⛔ 绝不提交 openId / coachId / memberId —— 收件人由服务端反查。
//   ③ 正式区**没有**这套集合与读通道 ⇒ 页面如实显示"目前只在测试区开放"，⛔ 绝不装作能用。
const inbox = require('../../utils/notification-inbox')

Page({
  data: {
    role: 'member', roleText: '会员',
    rows: [], unread: 0, loading: false, available: false, emptyText: '', disabledText: ''
  },
  onLoad(options) {
    const role = (options && options.role) === 'coach' ? 'coach' : 'member'
    this.role = role
    this.setData({ role, roleText: role === 'coach' ? '教练' : '会员' })
  },
  onShow() { this.load() },
  async load() {
    // ⛔ 正式区没有站内消息 ⇒ **如实**说，绝不显示一个点了就报错的空列表。
    if (!inbox.available()) {
      this.setData({ available: false, rows: [], unread: 0, emptyText: '', disabledText: '站内消息中心目前只在测试区开放，正式区还没有这套消息。' })
      return
    }
    this.setData({ available: true, loading: true, disabledText: '' })
    const result = await inbox.list(this.role)
    this.setData({
      loading: false,
      rows: inbox.rowsView(result.rows),
      unread: Number(result.unread || 0),
      // ⛔ 空态必须**明说**它是什么：不是"坏了"，是"还没有消息"。
      emptyText: result.rows.length ? '' : '还没有消息。预约、取消、改期、教练排课都会在这里各留一条，不受微信提醒次数限制。'
    })
  },
  // 点一条 ⇒ 标记这一条已读。⛔ 失败也不弹错吓人（下次进来还会再试）。
  async tapRow(e) {
    const id = String((e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) || '')
    if (!id) return
    await inbox.markRead(this.role, [id])
    this.load()
  },
  async markAll() {
    await inbox.markRead(this.role, [])
    this.load()
    wx.showToast({ title: '已全部标为已读', icon: 'none' })
  },
  noop() { }
})
