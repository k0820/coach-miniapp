// 临时只读诊断页（1.1.9 取证用，用完即删）。
// 逻辑全在 utils/diag-readonly-probe.js —— 本页只负责显示与手动重跑，
// 和 app.js 启动时那次自动诊断走的是**同一份**探针。
const probe = require('../../utils/diag-readonly-probe')

Page({
  data: { running: false, tick: '', steps: [], envInfo: null, local: null, relations: null, verdict: '', controlScope: '', finishedAtText: '', wroteAtText: '', expanded: false },

  onLoad() { this.run() },

  async run() {
    if (this.data.running) return
    this.setData({ running: true, steps: [], verdict: '正在只读诊断…', controlScope: '', tick: '', finishedAtText: '' })
    const startedAt = Date.now()
    const timer = setInterval(() => { this.setData({ tick: '已等待 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒' }) }, 1000)
    let record = null
    try { record = await probe.run() } catch (error) { record = null }
    clearInterval(timer)
    if (!record) {
      this.setData({ running: false, verdict: '诊断本身异常，未取到结果。', tick: '' })
      return
    }
    this.record = record
    this.setData({
      running: false, steps: record.steps, envInfo: record.envInfo, local: record.local, relations: record.relations || null,
      verdict: record.verdict, controlScope: record.controlScope,
      finishedAtText: record.finishedAtText, wroteAtText: probe.bjTime(record.wroteAt || record.finishedAt), tick: ''
    })
  },

  copyAll() {
    const record = this.record || (wx.getStorageSync(probe.RESULT_KEY) || null)
    if (!record) return wx.showToast({ title: '还没有结果', icon: 'none' })
    wx.setClipboardData({ data: JSON.stringify(record, null, 2), success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },

  toggle() { this.setData({ expanded: !this.data.expanded }) }
})
