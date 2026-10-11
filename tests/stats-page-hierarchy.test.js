// 本轮 UI 整理 · 统计页「只整理外观与层级」。
//
// 用户的四条要求（本文件逐条钉死）：
//   ① 月份切换：从卡片内「历史结算」按钮上移到页首「{{月份}} + 按月查看 ›」；
//   ② 紧凑数据卡：原来的 3 列摘要 + 一条独立进度条，压成一行四格 .stat-mini；
//   ③ 统一入口：月份切换与「按日期查询」共用同一个 .stats-head-entry（同一套尺寸/层级）；
//   ④ 弱化设置：设置与数据改成虚线透明的轻量入口。
//
// ⛔ 硬约束：**只改外观与层级**。统计口径、字段来源、四个弹层、每一个入口都不许动。
//    所以本文件除了静态契约，还会把页面**真的跑起来**，验证：
//      · monthTitle 是由北京时区当前月份现算的纯视图字段；
//      · 四格数据卡引用的 monthSessions / ranking.length / monthlyGoalSessions 仍然是原来那套口径。
//
// ⛔ 本文件只读：不写 Storage、不碰 Production / Sandbox、不发起任何云端写入。
// ⛔ 反证见 tests/_stats-page-hierarchy-mutate.js（只改内存文本副本，磁盘一个字节不动）。
// ⭐ 静态契约与反证共用 tests/helpers/ui-round5-contract.js 里的**同一份判据函数**。

const assert = require('assert')
const path = require('path')
const fs = require('fs')
const contract = require('./helpers/ui-round5-contract')

const PROJ = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(PROJ, p), 'utf8')

const SOURCES = {
  wxml: read('pages/stats/stats.wxml'),
  wxss: read('pages/stats/stats.wxss'),
  js: read('pages/stats/stats.js')
}

// ══════════════════ 一、静态契约（与反证同一份判据） ══════════════════

const ITEMS = contract.statsContract(SOURCES)
const failed = ITEMS.filter(entry => !entry.pass)
assert.strictEqual(failed.length, 0,
  '统计页静态契约未通过（' + failed.length + '/' + ITEMS.length + '）：\n'
  + failed.map(entry => '  ✗ ' + entry.name + ' → ' + entry.detail).join('\n'))
console.log('① 统计页静态契约：' + ITEMS.length + ' 条全过')

// ══════════════════ 二、语义：月分标题与四格数据都是真算出来的 ══════════════════
// 用测试替身喂一份"能算出确定数字"的本机数据，再真的调用 render() 读 data。
// 只有这样才能挡住"为了排版把口径悄悄换掉"——那是最容易发生、也最难在截图里看出来的退化。

const dateUtil = require(path.join(PROJ, 'utils', 'beijing-date'))
const TODAY = dateUtil.dateParts(dateUtil.todayKey())
const MONTH_START = dateUtil.monthDateKey(TODAY.year, TODAY.month, 1)
const PREV_MONTH_DATE = (() => {
  // 上个月的同一天（用来证明"只统计本月"这条口径没被排版顺手改掉）
  const year = TODAY.month === 1 ? TODAY.year - 1 : TODAY.year
  const month = TODAY.month === 1 ? 12 : TODAY.month - 1
  return dateUtil.monthDateKey(year, month, 10)
})()

const DOCTOR = {
  students: [{ id: 'stu-1', name: '甲会员', packages: [] }, { id: 'stu-2', name: '乙会员', packages: [] }],
  bookings: [
    // 本月：甲 2 节、乙 1 节 ⇒ monthSessions = 3、ranking.length = 2
    { id: 'bk-1', studentId: 'stu-1', studentName: '甲会员', date: MONTH_START, hour: 10, minute: 0, status: 'done', typeName: '常规训练', category: '常规训练' },
    { id: 'bk-2', studentId: 'stu-1', studentName: '甲会员', date: MONTH_START, hour: 11, minute: 0, status: 'done', typeName: '常规训练', category: '常规训练' },
    { id: 'bk-3', studentId: 'stu-2', studentName: '乙会员', date: MONTH_START, hour: 12, minute: 0, status: 'done', typeName: '常规训练', category: '常规训练' },
    // 上月：不计入本月
    { id: 'bk-old', studentId: 'stu-2', studentName: '乙会员', date: PREV_MONTH_DATE, hour: 10, minute: 0, status: 'done', typeName: '常规训练', category: '常规训练' },
    // 未完成：不计入
    { id: 'bk-todo', studentId: 'stu-1', studentName: '甲会员', date: MONTH_START, hour: 15, minute: 0, status: 'booked', typeName: '常规训练', category: '常规训练' }
  ],
  incomes: [
    { id: 'inc-1', bookingId: 'bk-1', studentId: 'stu-1', studentName: '甲会员', typeName: '常规训练', amount: 300, date: MONTH_START },
    { id: 'inc-2', bookingId: 'bk-2', studentId: 'stu-1', studentName: '甲会员', typeName: '常规训练', amount: 300, date: MONTH_START },
    { id: 'inc-3', bookingId: 'bk-3', studentId: 'stu-2', studentName: '乙会员', typeName: '常规训练', amount: 300, date: MONTH_START }
  ],
  sales: [],
  customExercises: [],
  settings: { renewThreshold: 10, monthlyGoalSessions: 42, classCommissionRate: 30, salesCommissionRate: 5 }
}

const clone = value => (value == null ? value : JSON.parse(JSON.stringify(value)))
const values = { coachDB: clone(DOCTOR) }
const writes = []
const previousWx = global.wx
global.wx = {
  getStorageSync: key => clone(values[key]),
  setStorageSync: (key, value) => { writes.push(key); values[key] = clone(value) },
  showToast() {},
  showModal() {},
  stopPullDownRefresh() {},
  cloud: { callFunction() {} }
}

let captured = null
const previousPage = global.Page
global.Page = definition => { captured = definition }
delete require.cache[require.resolve(path.join(PROJ, 'pages', 'stats', 'stats.js'))]
require(path.join(PROJ, 'pages', 'stats', 'stats.js'))
if (previousPage) global.Page = previousPage; else delete global.Page
assert.ok(captured, '统计页没有被注册。')

const page = { ...captured, data: clone(captured.data) }
page.setData = patch => Object.assign(page.data, patch)

page.render()

// ① 月份标题：必须是北京时区"今天"所在月份，不许硬编码、不许用上月
assert.strictEqual(page.data.monthTitle, TODAY.year + '年' + TODAY.month + '月',
  'monthTitle 必须是当前（北京时区）月份，实得 ' + page.data.monthTitle)
assert.strictEqual(page.data.monthTitle, page.data.monthTitle.trim(), 'monthTitle 前后不许有多余空白')

// ② 四格数据卡引用的三个字段，口径与本次排版前完全一致
assert.strictEqual(page.data.monthSessions, 3, '本月完成课时必须是 3 节（上月那节与未完成的都不算）')
assert.strictEqual(page.data.ranking.length, 2, '本月上课会员必须是 2 人（去重）')
assert.strictEqual(page.data.monthlyGoalSessions, 42, '本月目标必须来自 settings.monthlyGoalSessions')
assert.strictEqual(page.data.ranking.reduce((n, item) => n + item.count, 0), 3, '出勤排行的次数合计必须等于完成课时数')

// ③ 数据卡上的四个表达式与 data 字段一一对应（防止"模板写 A、数据算 B"）
const wxml = contract.stripHtml(SOURCES.wxml)
const miniRow = (/<view class="stat-mini-row">([\s\S]*?)<\/view><\/view>/.exec(wxml) || [, ''])[1]
assert.ok(miniRow.includes('{{monthSessions}}'), '第一格必须绑定 {{monthSessions}}')
assert.ok(miniRow.includes('{{ranking.length}}'), '第二格必须绑定 {{ranking.length}}')
assert.ok(miniRow.includes('{{monthlyGoalSessions}}'), '第三格必须绑定 {{monthlyGoalSessions}}')
assert.ok(miniRow.includes('{{monthSessions}}/{{monthlyGoalSessions}}'), '第四格必须绑定 {{monthSessions}}/{{monthlyGoalSessions}}')

// ④ 只读自证：render() 不许顺手写 Storage
assert.deepStrictEqual(writes, [], '统计页 render() 只读，不许写任何 Storage，实测 ' + JSON.stringify(writes))
assert.strictEqual(values.coachDB.bookings.length, DOCTOR.bookings.length, '本机数据不许被 render 改动')

if (previousWx === undefined) delete global.wx; else global.wx = previousWx

console.log('② 语义实测：monthTitle = ' + page.data.monthTitle + '（北京时区当月）· 完成课时 3 · 上课会员 2 · 本月目标 42')
console.log('③ 只读自证：render() 零 Storage 写入、本机数据零改动')
console.log('ALL STATS PAGE HIERARCHY TESTS PASSED（静态契约 ' + ITEMS.length + ' 条 + 语义 + 只读）')
