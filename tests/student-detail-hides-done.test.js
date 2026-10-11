// 学员当前详情：已完成的单节课不再堆在这里（1.1.7）。
//
// 用户要求：已完成的单节预约不要继续出现在学员**当前**详情里，但**只允许改展示层**。
//   · completed booking / 训练记录 / Income / 扣课 / 统计 / 结算 —— 历史事实全部保留；
//   · 课时包继续显示，并且照常显示剩余课时。
//
// 本测试钉住三件事：
//   ① detail() 产出的渲染数据里没有 done 的 booking；
//   ② 调用前后**整份 db 逐字未变**，而且 detail() 里一次写操作都没有（saveDB / mutate 都不许出现）；
//   ③ 课时包（含剩余课时）照旧显示；已撤销的包照旧不显示。
//
// 静态断言钉契约不钉拼写：断言前统一剥掉注释。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const PROJ = path.join(__dirname, '..')
const copy = value => JSON.parse(JSON.stringify(value))
const pad = number => String(number).padStart(2, '0')

// 假学员：两条已完成、一条待上，外加另一位学员的一条（必须不被算进来）。
const db = {
  students: [{
    id: 'stu-1', name: '假学员', phone: '13800000000',
    packages: [
      { id: 'pkg-1', type: '常规训练', total: 10, used: 3, remaining: 7, price: 150, status: 'active' },
      // 已用完又被撤销的包：既有逻辑本来就不显示，不能被这次改动顺手改掉
      { id: 'pkg-2', type: '赠送课程', total: 2, used: 2, remaining: 0, price: 80, status: 'reversed' }
    ]
  }, { id: 'stu-2', name: '另一位学员', packages: [] }],
  bookings: [
    { id: 'b-done-1', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-10', hour: 10, minute: 0, typeName: '常规训练', price: 150, status: 'done', items: [{ name: '卧推', sets: 4, reps: 12, weight: 40 }], notes: '历史备注' },
    { id: 'b-done-2', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-12', hour: 11, minute: 0, typeName: '常规训练', price: 150, status: 'done', items: [] },
    { id: 'b-booked', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-26', hour: 9, minute: 0, typeName: '常规训练', price: 150, status: 'booked', items: [] },
    // ⭐ 2026-10-01 追加：会员自助取消**保留**这一行（status='cancelled'）。
    //    它同样**不是**"还没上的课" ⇒ 不许出现在学员当前详情里（真机：教练端把取消的课当待上）。
    { id: 'b-cancelled', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-20', hour: 14, minute: 0, typeName: '常规训练', price: 150, status: 'cancelled', items: [] },
    { id: 'b-other', studentId: 'stu-2', studentName: '另一位学员', packageId: '', date: '2026-09-26', hour: 9, minute: 0, typeName: '常规训练', price: 150, status: 'booked', items: [] }
  ],
  incomes: [{ id: 'inc-1', bookingId: 'b-done-1', studentId: 'stu-1', amount: 150, date: '2026-09-10' }],
  sales: [{ id: 'sale-1', studentId: 'stu-1', packageId: 'pkg-1', amount: 1500 }],
  settings: {}, customExercises: []
}
const dbBefore = JSON.stringify(db)

let localWrites = 0
const storage = new Map()
global.wx = {
  getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
  showToast() {}, showModal() {}, hideTabBar() {}, showTabBar() {}, nextTick(fn) { fn() }
}

const runtimePath = require.resolve('../utils/data-runtime')
const previousRuntime = require.cache[runtimePath]
require.cache[runtimePath] = {
  id: runtimePath, filename: runtimePath, loaded: true,
  exports: {
    getDB: () => copy(db),
    // 展示层过滤一旦顺手写了存储，这里会当场炸掉 —— 比事后比对更早暴露。
    saveDB: () => { localWrites += 1; throw new Error('展示层不得写本机数据') },
    uid: () => 'unexpected-id',
    timeStr: booking => `${pad(booking.hour)}:${pad(booking.minute || 0)}`,
    pad, typeOf: () => ({ color: '#3b82f6' })
  }
}

let captured = null
global.Page = config => { captured = config }
require('../pages/students/students')

const page = { data: copy(captured.data), setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback() } }
for (const [name, fn] of Object.entries(captured)) if (typeof fn === 'function') page[name] = fn.bind(page)

;(async () => {
  page.detail({ currentTarget: { dataset: { id: 'stu-1' } } })
  const detail = page.data.detail

  // ① 只列还没完成的约课
  assert.deepEqual(detail.history.map(item => item.id), ['b-booked'],
    '当前详情只能列未完成的约课；已完成的单节课不许再堆在这里')
  assert.equal(detail.history.some(item => item.status === 'done'), false, '列表里不允许残留 done 记录')
  assert.equal(detail.history.some(item => item.status === 'cancelled'), false, '⛔ 已取消的课不是"还没上的课"，不许出现在学员当前详情里')
  assert.equal(detail.history.some(item => item.id === 'b-other'), false, '不能把别的学员的约课算进来')
  assert.equal(detail.history[0].time, '09:00', '渲染字段（time）必须照旧算出来')

  // ② 课时包照旧：正常包显示并带剩余课时，已撤销的包照旧不显示
  assert.deepEqual(detail.packages.map(item => item.id), ['pkg-1'], '已撤销的课时包照旧不显示，正常课时包必须继续显示')
  assert.equal(detail.packages[0].remaining, 7, '剩余课时必须照常显示')
  assert.equal(detail.initial, '假', '详情首字头像照旧')

  // ③ 展示层不许写：整份 db 逐字未变，且一次 saveDB 都没有
  assert.equal(localWrites, 0, '详情渲染不得写本机数据（一次 saveDB 都不许有）')
  assert.equal(JSON.stringify(db), dbBefore, '已完成的 booking / Income / Sale 等历史事实必须逐字保留')

  // ④ 静态契约：过滤只发生在 detail() 这一份渲染数据里
  const source = fs.readFileSync(path.join(PROJ, 'pages/students/students.js'), 'utf8')
  const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')
  const bare = strip(source)
  const detailBlock = bare.slice(bare.indexOf('detail(e){'), bare.indexOf('editFromDetail()'))
  assert.ok(detailBlock.length > 0, '找不到 detail() 实现')
  // ⛔ 2026-10-01 修订：这一条原来钉的是**拼写**（`status!=='done'`），不是语义。
  //    语义没变（已完成的课不列），但口径必须走共享函数 —— 否则"已取消的课"又会被各页面各判一次。
  assert.ok(/scheduleView\.pendingListOf\(/.test(detailBlock), 'detail() 必须走共享口径（已完成 + 已取消都不算"还没上"）')
  assert.equal(/saveDB\s*\(/.test(detailBlock), false, 'detail() 里不许出现 saveDB（只允许改展示层）')
  assert.equal(/mutate\s*\(/.test(detailBlock), false, 'detail() 里不许出现写命令（只允许改展示层）')
  assert.equal(/delete\s|reverseSale|updateCourseSale/.test(detailBlock), false, 'detail() 里不许出现删除/撤销动作')
  const wxml = fs.readFileSync(path.join(PROJ, 'pages/students/students.wxml'), 'utf8')
  assert.ok(/当前 \{\{detail\.history\.length\}\} 条约课/.test(wxml), '详情头部的计数必须与"只列当前约课"一致，不能继续说"共…记录"')
  assert.ok(/wx:for="\{\{detail\.history\}\}"/.test(wxml), '详情列表照旧渲染 detail.history')

  console.log('student detail hides done: PASS (只过滤展示层；done booking / 训练记录 / Income / Sale 逐字保留；课时包与剩余课时照旧；零写入)')
})().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 })
  .finally(() => { if (previousRuntime) require.cache[runtimePath] = previousRuntime; else delete require.cache[runtimePath] })
