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
const trainingView = require('../../utils/member-training-view')
const insights = require('../../utils/training-insights')
Page({
  data: { rows: [], month: '', monthLabel: '', summary: null, chart: { width: 560, points: [], lines: [] }, selected: null, themeStyle: theme.cssVars(), scopedTo: '', multiple: false, errorText: '', busy: false },
  onShow() {
    this.render(member.cached() || {})
    this.refresh()
  },
  render(raw) {
    const data = archiveState.narrow(raw)
    const rows = trainingView.rowsOf(data)
    const current = archiveState.archiveById(archiveState.archivesOf(raw), archiveState.readStored())
    const fallbackMonth = rows.length ? String(rows[0].date || '').slice(0, 7) : new Date().toISOString().slice(0, 7)
    const month = this.data.month && rows.some(row => String(row.date || '').startsWith(this.data.month)) ? this.data.month : fallbackMonth
    const summary = insights.memberMonthSummary(rows, month)
    const chart = insights.chartModel(summary.records)
    this.setData({
      rows, month, monthLabel: /^\d{4}-\d{2}$/.test(month) ? `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月` : month,
      summary, chart, selected: chart.points.length ? chart.points[chart.points.length - 1] : null, themeStyle: theme.cssVars(),
      scopedTo: current ? current.name : '',
      multiple: archiveState.archivesOf(raw).length > 1
    })
  },
  async refresh() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try { this.render(await member.read({ allowCache: true })); this.setData({ errorText: '' }) }
    catch (error) { if (!this.data.rows.length) this.setData({ errorText: '暂时读不到最新训练记录，请稍后重试。' }) }
    finally { this.setData({ busy: false }) }
  },
  changeMonth(e) { this.setData({ month: String(e.detail.value || '').slice(0, 7) }); this.render(member.cached() || {}) },
  selectPoint(e) { const row = (this.data.chart.points || []).find(item => item.historyId === e.currentTarget.dataset.id); if (row) this.setData({ selected: row }) },
  detail(e) { wx.navigateTo({ url: `/pages/member-history-detail/member-history-detail?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }) }
})
