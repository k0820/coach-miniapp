// 🔔 统一「微信通知设置」页（2026-10-06 需求三）
//
// ⭐⭐ 为什么必须有这一页（真机证据驱动）：
//   ① 会员原先的通知按钮藏在「我的」里一句小字，教练那份**藏在每个学员的"会员身份认领"页里**
//      ⇒ 两个入口、两套状态，教练根本不知道自己到底授权过没有；
//   ② 会员与教练是**两套完全独立的微信授权**（各自手机、各自额度），
//      ⛔ 共用一个开关 = 一方授权后冒充双方都已开启。
//
// ⛔⛔ 四条不可越界的规则（tests 逐条钉死）：
//   ① **身份隔离**：本页只处理**当前这一个角色**的授权，⛔ 绝不因为教练授权过就显示"会员也开了"；
//   ② **不许自动弹授权框**：`wx.requestSubscribeMessage` **只能**由用户点按钮触发（微信的硬规则）；
//   ③ **不许把一次性订阅写成长期**：按钮恒为「允许下一条微信提醒」，
//      ⛔ 界面上永远不许出现「已开启 / 永久开启 / 长期有效」；
//   ④ **拒绝之后给退路**：显示「去微信设置重新打开」，真的调 `wx.openSetting`。
//
// 📌 能不能长期订阅由**微信公众平台**决定，代码说了不算 ⇒ 本页如实标成
//    「待你在微信公众平台确认」（`notify-consent.LONG_TERM_NOTE`），⛔ 绝不宣布已支持。
const notifyConsent = require('../../utils/notify-consent')

Page({
  data: {
    themeStyle: '',
    role: 'member', roleText: '会员', scopeText: '',
    // 三个模板
    templates: [],
    configured: false, configuredText: '',
    // ⛔ 按钮文案由 notify-consent 统一给（一次性 ⇒ 恒为「允许下一条微信提醒」）
    buttonText: '', openSettingText: '', showOpenSetting: false,
    quotaUsedText: '', statusText: '',
    longTermNote: notifyConsent.LONG_TERM_NOTE,
    busy: false
  },

  onLoad(query) {
    // ⛔ 角色**只**从入口传入，且只认两个值；认不出来一律按会员（⛔ 绝不两边共用一份状态）。
    const role = query && query.role === 'coach' ? 'coach' : 'member'
    this.role = role
    this.last = null
    this.setData({ role })
    this.render()
  },

  // ⭐ 从微信设置页返回（`wx.openSetting`）⇒ **自动刷新**这一页。
  //   ⛔ 微信没有提供"查询订阅消息额度"的接口 ⇒ 这里只能**如实**说清下一步该做什么，
  //      ⛔ 绝不能凭"刚去了一趟设置页"就宣布"通知已开启"（那正是被明令禁止的假实现）。
  onShow() {
    if (this.last && this.last.status === 'settings-opened') {
      this.last = null
      this.returnedFromSettings = true
    }
    this.render()
  },

  render() {
    const view = notifyConsent.settingsView(this.role, { last: this.last })
    const extra = this.returnedFromSettings
      ? '已经从微信设置回来了。如果刚才在那里打开了通知，请再点一次「允许下一条微信提醒」。' : ''
    this.setData({
      roleText: view.roleText, scopeText: view.scopeText, templates: view.templates,
      configured: view.configured, configuredText: view.configuredText,
      buttonText: view.buttonText, openSettingText: view.openSettingText,
      showOpenSetting: view.showOpenSetting, quotaUsedText: view.quotaUsedText,
      statusText: extra || view.statusText
    })
  },

  // 🙋 用户点「允许下一条微信提醒」⇒ 才弹微信授权框（⛔ 绝不在 onLoad / onShow 里自动调）。
  async allow() {
    if (this.data.busy) return
    this.returnedFromSettings = false
    this.setData({ busy: true })
    try {
      const outcome = await notifyConsent.requestConsent(this.role)
      this.last = outcome
      this.render()
      wx.showToast({ title: notifyConsent.explainOf(outcome) || '已完成', icon: 'none' })
    } finally { this.setData({ busy: false }) }
  },

  // 🔧 拒绝过之后再点 ⇒ 去微信设置页（⛔ 由点击触发；回来后 `onShow` 会刷新）。
  async openWechatSetting() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      const outcome = await notifyConsent.openSetting()
      this.last = outcome
      this.render()
    } finally { this.setData({ busy: false }) }
  },

  noop() { }
})
