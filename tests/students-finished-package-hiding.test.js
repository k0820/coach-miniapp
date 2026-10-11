// 【发布前体验优化 · 问题2】已经用完的课时包不要再继续占据「学员」页面。
//
// 背景（真机反馈）：学员卡片下面会把该学员的每一个课时包都列出来，
// 一个买过多次课（或买过单次课）的学员，页面上会堆着越来越多「剩余 0 / 已上完」的课时包行。
// 用户确认的目标：**用完的（剩余 0）就收起来，不再占地方**。
//
// 本测试钉住的契约：
//   ① 学员卡片只展示「还有剩余的」课时包；剩余 0 的不再进入渲染数据（只是不渲染，数据一个字不动）；
//   ② 只能过滤**渲染数据**：云端快照、缓存、续费提醒、统计口径全部保持完整，
//      尤其是「用完的课时包」必须仍然触发续费提醒，否则等于静默丢掉一条续费线索；
//   ③ 已经在编辑页打开时，用完的课时包默认收起、但**必须可展开查看/管理**
//      （撤销入口不能因为这次改动而消失），且它是纯视图开关，`form.packages` 一字不少；
//   ④ 历史事实（done booking / income / 训练动作 / 备注 / 快照姓名）一个字段都不许被这次过滤碰到。
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const { createWorld, copy, settle } = require('./helpers/local-first-world')

const PROJ = path.join(__dirname, '..')
const SETTINGS = { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 0, salesCommissionRate: 0 }

const pkg = (id, type, total, remaining, extra = {}) => ({ id, type, total, used: total - remaining, remaining, price: 300, status: 'active', createdAt: 1, ...extra })
const STUDENTS = [
  {
    id: 'stu-many', name: '多次购课学员', phone: '', createdAt: 1,
    packages: [
      pkg('pk-active', '常规训练', 20, 19, { saleId: 'sale-active', saleDate: '2026-09-01' }),
      pkg('pk-done-1', '常规训练', 1, 0, { saleId: 'sale-done-1', saleDate: '2026-06-01' }),
      pkg('pk-done-2', '普拉提', 5, 0, { saleId: 'sale-done-2', saleDate: '2026-07-01' })
    ]
  },
  { id: 'stu-used-up', name: '已上完学员', phone: '', createdAt: 1, packages: [pkg('pk-only', '常规训练', 10, 0, { saleId: 'sale-only', saleDate: '2026-05-01' })] },
  { id: 'stu-empty', name: '还没有买课的学员', phone: '', createdAt: 1, packages: [] }
]
// 历史事实：已完成课程 + 收入 + 训练动作 + 备注 + 姓名快照。这次改动**一个字段都不许碰**。
const DONE_BOOKING = {
  id: 'bk-done', studentId: 'stu-many', studentName: '多次购课学员', packageId: 'pk-done-1', date: '2026-06-08', hour: 10, minute: 30,
  typeName: '常规训练', price: 300, status: 'done', notes: '膝盖略酸', category: '常规训练', duration: 60,
  items: [{ name: '深蹲', group: '臀腿', sets: 4, reps: 12, weight: 40 }, { name: '臀桥', group: '臀腿', sets: 3, reps: 15, weight: '' }]
}
const DONE_INCOME = { id: 'inc-done', bookingId: 'bk-done', studentId: 'stu-many', studentName: '多次购课学员', packageId: 'pk-done-1', typeName: '常规训练', amount: 300, date: '2026-06-08' }
const SALES = [
  { id: 'sale-active', source: 'course', studentId: 'stu-many', packageId: 'pk-active', typeName: '常规训练', quantity: 20, unitPrice: 300, amount: 5800, date: '2026-09-01' },
  { id: 'sale-done-1', source: 'course', studentId: 'stu-many', packageId: 'pk-done-1', typeName: '常规训练', quantity: 1, unitPrice: 300, amount: 300, date: '2026-06-01' },
  { id: 'sale-done-2', source: 'course', studentId: 'stu-many', packageId: 'pk-done-2', typeName: '普拉提', quantity: 5, unitPrice: 300, amount: 1500, date: '2026-07-01' },
  { id: 'sale-only', source: 'course', studentId: 'stu-used-up', packageId: 'pk-only', typeName: '常规训练', quantity: 10, unitPrice: 300, amount: 2900, date: '2026-05-01' }
]

function applyPath(target, key, value) {
  const tokens = String(key).replace(/\[(\d+)\]/g, '.$1').split('.')
  let node = target
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]
    if (node[token] == null) node[token] = /^\d+$/.test(tokens[i + 1]) ? [] : {}
    node = node[token]
  }
  node[tokens[tokens.length - 1]] = value
}
function loadStudentsPage() {
  const file = path.join(PROJ, 'pages', 'students', 'students.js')
  let captured = null
  global.Page = definition => { captured = definition }
  delete require.cache[require.resolve(file)]
  require(file)
  delete global.Page
  if (!captured) throw new Error('学员页没有被注册。')
  const instance = {
    data: copy(captured.data),
    setData(patch, callback) { Object.keys(patch).forEach(key => applyPath(this.data, key, copy(patch[key]))); if (callback) callback() }
  }
  Object.keys(captured).forEach(key => { if (typeof captured[key] === 'function' && key !== 'data') instance[key] = captured[key].bind(instance) })
  return instance
}
const studentOf = (page, id) => page.data.students.find(item => item.id === id)

const world = createWorld({ allowMaskedCommands: true })
world.seed({ students: copy(STUDENTS), bookings: [copy(DONE_BOOKING)], incomes: [copy(DONE_INCOME)], sales: copy(SALES), settings: copy(SETTINGS), customExercises: [] })

;(async () => {
  const page = loadStudentsPage()
  page.onShow()

  // ─────────────────── ① 学员卡片：只剩「还有剩余」的课时包 ───────────────────
  const many = studentOf(page, 'stu-many')
  assert.ok(many, '学员必须仍然出现在列表里（用完课时包不等于学员消失）')
  assert.strictEqual(many.packages.length, 3, '数据层必须仍然拿着全部课时包（续费/统计/撤销都靠它）')
  assert.strictEqual(many.usedUpCount, 2, '必须能报出"已收起几个"')
  assert.strictEqual(many.visiblePackages.length, 1, '用完的课时包不得进入卡片渲染数据')
  const active = many.visiblePackages[0]
  assert.strictEqual(active.id, 'pk-active', '留下的是还有剩余的那一个')
  assert.strictEqual(active.left, 19)
  assert.strictEqual(active.balancePercent, 95, '未上完的课时包照常显示剩余/总数与进度')
  assert.strictEqual(many.visiblePackages.some(item => Number(item.left) <= 0), false, '渲染数据里不允许再出现剩余 0 的课时包')

  // ─────────── ② 只能过滤渲染数据：续费提醒 / 快照 / 缓存必须完整 ───────────
  // 用完的课时包 = 最需要续费线索的人，绝不能被这次过滤顺手抹掉。
  assert.ok(page.data.renewList.some(item => item.id === 'stu-used-up'), `只剩用完课时包的学员必须仍然出现在续费提醒里，实测 ${page.data.renewList.map(item => item.id).join('、')}`)
  assert.strictEqual(page.data.renewCount, 2, '两个需要续费的学员都必须在（多次购课学员 + 已上完学员）')
  const cloudState = world.snapshot()
  assert.strictEqual(cloudState.students.find(item => item.id === 'stu-many').packages.length, 3, '云端快照一个字节都不许被渲染层改掉')
  assert.strictEqual(JSON.stringify(world.store.coachCloudActiveCache.snapshot.students.find(item => item.id === 'stu-many').packages.length), '3', '本机缓存也不许被改')
  assert.strictEqual(studentOf(page, 'stu-empty').visiblePackages.length, 0, '没有课时包的学员不能报错')

  // ─────────── ③ 历史事实完整：done booking / income / 动作 / 备注 / 姓名快照 ───────────
  const afterRender = world.snapshot()
  assert.deepStrictEqual(afterRender.bookings, [copy(DONE_BOOKING)], '已完成课程（含训练动作与备注）必须原样存在')
  assert.strictEqual(afterRender.bookings[0].items.length, 2)
  assert.strictEqual(afterRender.bookings[0].studentName, '多次购课学员', '姓名快照不许被动过')
  assert.strictEqual(afterRender.bookings[0].notes, '膝盖略酸')
  assert.deepStrictEqual(afterRender.incomes, [copy(DONE_INCOME)], '已完成课程的收入必须原样存在')
  assert.strictEqual(afterRender.sales.length, 4, '销售记录一条都不能少（用完的课时包也有销售事实）')
  assert.strictEqual(afterRender.students.find(item => item.id === 'stu-many').packages.find(item => item.id === 'pk-done-1').used, 1, '已用课时必须保持原值')

  // ─────────── ④ 编辑页：默认收起，但必须能展开查看/管理（撤销入口不许消失） ───────────
  page.openEditor('stu-many')
  assert.strictEqual(typeof page.toggleFinished, 'function', '编辑页必须提供"展开已用完课时包"的入口（否则撤销/纠错就再也点不到了）')
  assert.strictEqual(page.data.finishedExpanded, false, '默认必须是收起的')
  assert.strictEqual(page.data.finishedCount, 2, '必须报出被收起了几个')
  assert.strictEqual(page.data.form.packages.length, 3, '★ 纯视图收起：form.packages 一字不少（保存/校验/撤销全都依赖它）')
  assert.ok(page.data.form.packages.find(item => item.id === 'pk-done-1'), '被收起的课时包必须仍然带着真实 id 留在表单数据里')
  page.toggleFinished()
  assert.strictEqual(page.data.finishedExpanded, true, '点一下必须能展开查看')
  assert.strictEqual(page.data.form.packages.length, 3, '展开只是视图开关，数据不许变')
  page.toggleFinished()
  assert.strictEqual(page.data.finishedExpanded, false)

  // 新填的课时包永远可见（收藏起开关影响的话，用户会以为自己没加上）。
  page.addPkg()
  assert.strictEqual(page.data.form.packages.length, 4, '新增行必须进表单数据')
  assert.strictEqual(page.data.form.packages[3].isNew, true)

  // ───────────────────────────── ⑤ 静态契约 ─────────────────────────────
  const wxml = fs.readFileSync(path.join(PROJ, 'pages', 'students', 'students.wxml'), 'utf8')
  const source = fs.readFileSync(path.join(PROJ, 'pages', 'students', 'students.js'), 'utf8')
  // 2026-10-02 名单改「一人一行」后，卡片不再逐个渲染 visiblePackages 的每一行，
  // 而是渲染由它**聚合**出来的剩余/总量标量（rowSummaryOf(visiblePackages)）。
  // 契约本身一个字没变：**用完的课时包不许占地方**；只是从"模板过滤"变成"聚合"。
  // 判据跟着收紧 —— 现在连 student.packages 都不许出现在卡片里。
  assert.ok(wxml.includes('student.rowLeft') && wxml.includes('student.rowTotal'),
    '学员卡片必须渲染由 visiblePackages 聚合出的 剩余/总量（rowLeft / rowTotal）')
  assert.ok(!/student\.packages/.test(wxml), '学员卡片不允许渲染全量 packages（用完的课时包会重新占地方）')
  assert.ok(source.includes('...rowSummaryOf(visiblePackages)'), '聚合的分子分母都必须来自 visiblePackages')
  assert.ok(!source.includes('rowSummaryOf(packages)'),
    '聚合不许拿全量 packages 当分母（会把已用完的课时包又算回来，续费提醒的"剩余"就假了）')
  assert.ok(wxml.includes('finishedExpanded'), '编辑页的已用完课时包必须由视图开关控制显隐')
  assert.ok(source.includes('visiblePackages') && source.includes('usedUpCount'), '渲染数据必须由页面提供（数据层不动）')
  assert.ok(!/packages\s*=\s*packages\.filter\([^)]*left\s*>\s*0[^)]*\)[\s\S]{0,40}saveDB/.test(source), '过滤只允许发生在渲染数据上，不许写回存储')

  console.log('students finished-package-hiding tests: PASS (view-only filtering, renewal alert intact, history untouched, finished packages still reachable in the editor)')
})().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 }).finally(() => { world.restoreUi() })
