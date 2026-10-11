// 会员端底部导航（2026-10-03 重排：首页 / 约课 / 我的）
//
// ⭐ 为什么改：三栏里「训练记录」单独占一栏，但它只是「我的」下面的一条内容 ——
//    底部三个位置应该给**最高频的三件事**（看概况 / 约课 / 管理自己）。
//    ⛔ 旧入口不许因此变死路：首页「最近训练」卡片、我的页、训练记录详情页仍然直达该页，
//       它只是**不再独占底部一栏**（见 tests/member-nav-and-profile.test.js）。
Component({
  data: { sandbox: false },
  properties: { active: { type: String, value: 'home' } },
  lifetimes: { attached() { this.setData({ sandbox: require('../../utils/data-runtime').isSandbox() }) } },
  methods: {
    go(e) {
      const target = e.currentTarget.dataset.target
      if (target === this.data.active) return
      // ⚠️ 约课页需要带日期参数才能定位到今天，所以用 redirectTo + query（不用 navigateTo，避免叠页面栈）
      const pages = {
        home: '/pages/member-home/member-home',
        book: '/pages/member-book-slots/member-book-slots',
        profile: '/pages/member-profile/member-profile'
      }
      wx.redirectTo({ url: pages[target] || pages.home })
    }
  }
})
