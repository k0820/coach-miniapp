// 训练记录（2026-10-03：随「当前使用档案」裁剪 + 不再独占底部一栏）
//
// ⭐ 原来它在底部导航里独占第二栏；现在它收进「我的」下面，但**页面本身一个字都没删** ——
//    首页「最近训练」卡片、我的页入口、详情页跳转都仍然直达这里（不许出现死路）。
//
// ⛔ 数据必须按**当前使用档案**裁剪：一个会员认领多份档案时，"训练记录"只列当前那一份的。
//    裁剪只走 `member-archive-state.narrow()`（全站唯一出口），本页**不许自己写 filter**。
const member = require('../../utils/member-runtime')
const theme = require('../../utils/member-theme')
const archiveState = require('../../utils/member-archive-state')
Page({
  data: { rows: [], themeStyle: theme.cssVars(), scopedTo: '', multiple: false },
  onShow() {
    const raw = member.cached() || {}
    const data = archiveState.narrow(raw)
    const rows = (data.recentTraining || []).map(row => ({ ...row, actionNames: (row.items || []).map(item => item.name).filter(Boolean).join(' / ') }))
    const current = archiveState.archiveById(archiveState.archivesOf(raw), archiveState.readStored())
    this.setData({
      rows, themeStyle: theme.cssVars(),
      scopedTo: current ? current.name : '',
      multiple: archiveState.archivesOf(raw).length > 1
    })
  },
  detail(e) { wx.navigateTo({ url: `/pages/member-history-detail/member-history-detail?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }) }
})
