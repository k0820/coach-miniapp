// 会员端底部导航：首页 / 约课。
//
// ⭐ 为什么改：三栏里「训练记录」单独占一栏，但它只是「我的」下面的一条内容 ——
//    课包和训练记录已经并入首页，不再用一个独立“我的”页面占据底部位置。
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
        book: '/pages/member-book-slots/member-book-slots'
      }
      wx.redirectTo({ url: pages[target] || pages.home })
    }
  }
})
