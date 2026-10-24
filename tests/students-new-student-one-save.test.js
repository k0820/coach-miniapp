// 【发布前体验优化 · 问题1】新增学员：一次「保存」就落「学员 + 课时包 + 对应销售」。
//
// 背景（真机反馈）：新增学员时页面只能填姓名/手机号，课时包区块被 `form.id` 挡着，
// 于是必须先存一个空学员、再回来点一次「保存这笔课程」——不符合操作习惯。
//
// 本测试钉住的契约：
//   ① 云端（cloud-primary）新增学员时，课时包区块**直接可填**（不再要求先存空学员）；
//   ② 一次点击 = 学员 + 页面上每一笔填好的新课时包（+ 销售记录）**一起**落进云端；
//   ③ 时序必须是「先学员、后课时包」（销售必须挂在已存在的学员上）；
//   ④ 任何一步失败都**如实告警**，绝不出现"提示全部成功、实际只有学员"的假成功；
//      且失败后重试**不会**建出第二个学员、不会重复已成功的课时包；
//   ⑤ 业务规则一个字不改：total / remaining / used / sale.amount 全部保持人工输入值，
//      绝不重算 remaining = total - used，也不用 quantity × unitPrice 覆盖 amount；
//   ⑥ 不另造第二套保存逻辑：仍然复用既有 createStudent / createCourseSale / createPackage，
//      并且 payload 只有一个构造入口（保存这笔课程 与 保存资料 共用）。
//
// 假世界用的是项目里那份真实业务引擎（InMemoryCommandEngine），命令真的会执行、真的会回读。
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const { createWorld, copy, settle } = require('./helpers/local-first-world')

const PROJ = path.join(__dirname, '..')
const DATASET = 'ds-test'
const SETTINGS = { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 0, salesCommissionRate: 0 }
const emptyState = () => ({ students: [], bookings: [], incomes: [], sales: [], settings: copy(SETTINGS), customExercises: [] })
const TYPES = require(path.join(PROJ, 'utils', 'constants')).TYPES
const GIFT_INDEX = TYPES.findIndex(item => item.name === '赠送课程')
const todayKey = require(path.join(PROJ, 'utils', 'beijing-date')).todayKey

// 与真机 setData 同口径：支持 'form.id' / 'form.packages[0].total' 这类路径写法。
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
  const page = {
    data: copy(captured.data),
    setData(patch, callback) { Object.keys(patch).forEach(key => applyPath(this.data, key, copy(patch[key]))); if (callback) callback() }
  }
  Object.keys(captured).forEach(key => { if (typeof captured[key] === 'function' && key !== 'data') page[key] = captured[key].bind(page) })
  return page
}
// 模拟真机逐格输入（走页面真实的 input 处理器，不是直接塞 data）。
const input = (page, field, value) => page.field({ currentTarget: { dataset: { field } }, detail: { value } })
const pkgInput = (page, index, key, value) => page.pkg({ currentTarget: { dataset: { i: index, k: key } }, detail: { value } })
const pickType = (page, index, typeName) => page.pkg({ currentTarget: { dataset: { i: index, k: 'type' } }, detail: { value: TYPES.findIndex(item => item.name === typeName) } })
const tapSave = page => Promise.resolve(page.save())
const toastTitles = world => world.counters.toasts.map(item => item.title)
const modalTitles = world => world.counters.modals.map(item => item.title)

const world = createWorld({ allowMaskedCommands: true })
// Keep the pre-existing cloud-first fallback contract covered separately.
// The normal local-first creation path has its own durable-batch test.
const mutation = require(path.join(PROJ, 'utils', 'mutate'))
mutation.localFirstEnabled = () => false

function fillPaid(pkgIndex, { total, remaining, price, amount }) {
  pkgInput(page, pkgIndex, 'total', String(total))
  pkgInput(page, pkgIndex, 'remaining', String(remaining))
  pkgInput(page, pkgIndex, 'price', String(price))
  pkgInput(page, pkgIndex, 'saleAmount', String(amount))
}
let page = null

;(async () => {
  // ───────────────────────── ① 一次保存：学员 + 一笔课时包 + 销售 ─────────────────────────
  world.seed(emptyState())
  require(path.join(PROJ, 'utils', 'mutate')).clearAudit()
  page = loadStudentsPage()
  page.onShow()
  page.add()

  // 契约①：云端新增学员时，课时包区块**直接就能填** —— 不再要求先存一个空学员。
  assert.strictEqual(page.data.form.id, '', '新增学员的起点必须是没有 id 的新表单')
  assert.strictEqual(page.data.form.packages.length, 1, '云端新增学员必须直接给一行可填的课时包（否则又回到"先存空学员"）')
  assert.strictEqual(page.data.form.packages[0].isNew, true)

  input(page, 'name', '端到端学员甲')
  input(page, 'phone', '13800000001')
  // 人工填的值故意与「数量 × 单价」不一致：20 × 300 = 6000，实际业绩 5800。
  fillPaid(0, { total: 20, remaining: 20, price: 300, amount: 5800 })
  assert.strictEqual(page.data.form.packages[0].saleDate, todayKey(), '业绩归属日期默认今天（可改）')

  await tapSave(page)
  await settle(20)

  let state = world.snapshot()
  assert.strictEqual(state.students.length, 1, '一次保存只建一个学员')
  assert.strictEqual(state.students[0].name, '端到端学员甲')
  assert.strictEqual(state.students[0].phone, '13800000001')
  assert.strictEqual(state.students[0].packages.length, 1, '页面上填好的课时包必须跟着一起落下去（这就是问题1的核心）')
  const pkg = state.students[0].packages[0]
  assert.strictEqual(pkg.type, '常规训练')
  assert.strictEqual(pkg.total, 20)
  assert.strictEqual(pkg.remaining, 20)
  assert.strictEqual(pkg.used, 0)
  assert.strictEqual(pkg.price, 300)
  assert.strictEqual(pkg.saleDate, todayKey())
  assert.ok(pkg.saleId, '付费课时包必须带 saleId（销售与课时包原子创建）')
  assert.strictEqual(state.sales.length, 1, '一次保存只产生一条销售记录')
  assert.strictEqual(state.sales[0].amount, 5800, '实际销售业绩必须是人工输入的 5800，不能被 20 × 300 覆盖成 6000')
  assert.strictEqual(state.sales[0].quantity, 20)
  assert.strictEqual(state.sales[0].unitPrice, 300)
  assert.strictEqual(state.sales[0].date, todayKey())
  assert.strictEqual(state.incomes.length, 0, '没上课就不该产生任何收入')

  // 时序 + 写入口：先学员、后课时包，全部经由统一写入口（没有第二条写链路）。
  const commands = require(path.join(PROJ, 'utils', 'mutate')).audit().map(item => item.command)
  assert.deepStrictEqual(commands, ['createStudent', 'createCourseSale'], `云端收到的命令顺序必须是「先学员、后课时包」，实测 ${commands.join(' → ')}`)
  assert.strictEqual(commands.filter(name => name === 'createStudent').length, 1, '一次保存只允许一次 createStudent')

  // 保存后表单已转成"编辑已有学员"：那一行变成既有课时包，再点保存也不会重复建。
  assert.strictEqual(page.data.form.id, state.students[0].id, '保存后表单必须拿到正式学员 id')
  assert.strictEqual(page.data.form.packages[0].isNew, false, '已保存的课时包必须转成既有行（再点保存不会重复创建）')
  assert.ok(toastTitles(world).includes('学员已创建') || modalTitles(world).includes('保存成功'), '成功必须有明确反馈')
  assert.strictEqual(world.counters.loading, world.counters.hides, '不允许留下没关掉的加载遮罩')

  // ───────────────────── ② 一次保存：学员 + 两笔课时包（付费 + 赠送） ─────────────────────
  world.seed(emptyState())
  require(path.join(PROJ, 'utils', 'mutate')).clearAudit()
  page = loadStudentsPage()
  page.onShow()
  page.add()
  input(page, 'name', '端到端学员乙')
  fillPaid(0, { total: 20, remaining: 20, price: 300, amount: 5800 })
  page.addPkg()
  assert.strictEqual(page.data.form.packages.length, 2, '必须能一次填两笔课时包')
  pickType(page, 1, '赠送课程')
  pkgInput(page, 1, 'total', '2')
  pkgInput(page, 1, 'remaining', '2')

  await tapSave(page)
  await settle(20)

  state = world.snapshot()
  assert.strictEqual(state.students.length, 1)
  assert.strictEqual(state.students[0].packages.length, 2, '两笔课时包必须一次全部保存')
  const paid = state.students[0].packages.find(item => item.type === '常规训练')
  const gift = state.students[0].packages.find(item => item.type === '赠送课程')
  assert.ok(paid && gift, '付费与赠送各一笔')
  assert.strictEqual(paid.remaining, 20)
  assert.strictEqual(gift.total, 2)
  assert.strictEqual(gift.remaining, 2)
  assert.strictEqual(gift.price, 80, '赠送课单价固定 80（既有规则未变）')
  assert.strictEqual(gift.isGift, true)
  assert.strictEqual(state.sales.length, 1, '只有付费那笔产生销售记录，赠课不产生 sale')
  assert.strictEqual(state.sales[0].packageId, paid.id)
  assert.strictEqual(state.sales[0].amount, 5800)

  // ───────── ③ 中途失败：不许假报"全部成功"；重试不许建第二个学员 / 不许重复 ─────────
  world.seed(emptyState())
  const audit = require(path.join(PROJ, 'utils', 'mutate'))
  audit.clearAudit()
  page = loadStudentsPage()
  page.onShow()
  page.add()
  input(page, 'name', '端到端学员丙')
  fillPaid(0, { total: 20, remaining: 20, price: 300, amount: 5800 })
  page.addPkg()
  fillPaid(1, { total: 10, remaining: 10, price: 400, amount: 3900 })

  // 闸门：假服务端在第 2 笔销售上明确拒绝（确定性窗口，不靠 sleep 赌时序）。
  const originalExecute = world.engine.execute
  let saleCalls = 0
  world.engine.execute = function (trustedContext, envelope) {
    if (envelope && envelope.command === 'createCourseSale' && ++saleCalls === 2) {
      return { ok: false, code: 'SALE_AMOUNT_INVALID', message: '实际销售业绩无效，云端拒绝。' }
    }
    return originalExecute.apply(this, arguments)
  }
  const toastsBefore = world.counters.toasts.length
  await tapSave(page)
  await settle(20)
  world.engine.execute = originalExecute

  state = world.snapshot()
  assert.strictEqual(state.students.length, 1, '学员已经建成（第一步是成功的）')
  assert.strictEqual(state.students[0].packages.length, 1, '只有成功的那一笔课时包落地')
  assert.strictEqual(state.sales.length, 1)
  // ★ 假成功陷阱：绝不能出现"提示全部保存成功，实际只有一半"。
  const partial = world.counters.modals.slice(-3).map(item => item.title)
  assert.ok(partial.includes('部分保存成功'), `中途失败必须如实告警，实测弹窗：${partial.join('、')}`)
  const partialModal = world.counters.modals.find(item => item.title === '部分保存成功')
  assert.ok(/没有保存成功/.test(partialModal.content), '必须明说哪一笔没成功，而不是笼统报错')
  assert.ok(!world.counters.toasts.slice(toastsBefore).map(item => item.title).includes('学员已创建'), '部分失败时绝不允许报「学员已创建」这种"全部成功"的提示')
  // 失败那一笔必须原地保留她的输入，且表单已经拿到正式学员 id（重试只会 updateStudent）。
  assert.strictEqual(page.data.modal, true, '未完成的保存必须留在表单里，不能把她的输入丢掉')
  assert.strictEqual(page.data.form.id, state.students[0].id, '学员已在云端存在 → 表单必须记下正式 id')
  assert.strictEqual(page.data.form.packages.length, 2, '失败的那一行必须还在表单里')
  assert.strictEqual(page.data.form.packages[1].isNew, true, '失败的那一行仍是"未保存"状态')
  assert.strictEqual(page.data.form.packages[1].saleAmount, '3900', '她的输入必须一字不动地留着')

  // 重试：只补发没成功的那一笔；绝不建第二个学员、绝不重复第一笔。
  audit.clearAudit()
  await tapSave(page)
  await settle(20)
  state = world.snapshot()
  assert.strictEqual(state.students.length, 1, '重试绝不允许建出第二个学员')
  assert.strictEqual(state.students[0].packages.length, 2, '重试后两笔课时包都必须齐')
  assert.strictEqual(state.sales.length, 2, '重试不许把第一笔再存一遍')
  const retryCommands = audit.audit().map(item => item.command)
  assert.strictEqual(retryCommands.includes('createStudent'), false, `重试不允许再发 createStudent，实测 ${retryCommands.join(' → ')}`)
  assert.deepStrictEqual(retryCommands, ['updateStudent', 'createCourseSale'], `重试只该补资料 + 缺的那一笔，实测 ${retryCommands.join(' → ')}`)
  const amounts = state.sales.map(item => item.amount).sort((a, b) => a - b)
  assert.deepStrictEqual(amounts, [3900, 5800], '两笔销售金额必须各自保持人工输入值')

  // ───────────────── ④ 编辑已有学员：单笔保存照旧可用；保存资料也会收尾新行 ─────────────────
  world.seed({
    ...emptyState(),
    students: [{ id: 'stu-edit', name: '已有学员丁', phone: '', createdAt: 1, packages: [] }]
  })
  audit.clearAudit()
  page = loadStudentsPage()
  page.onShow()
  page.openEditor('stu-edit')
  assert.strictEqual(page.data.form.id, 'stu-edit')
  assert.strictEqual(page.data.form.packages.length, 0, '没有课时包的学员不该凭空多出一行')

  // ④a 独立保存仍然可用（不破坏已验证的"保存这笔课程"）。
  page.addPkg()
  fillPaid(0, { total: 20, remaining: 20, price: 300, amount: 5800 })
  await page.savePackage({ currentTarget: { dataset: { i: 0 } } })
  await settle(20)
  state = world.snapshot()
  assert.strictEqual(state.students[0].packages.length, 1, '「保存这笔课程」必须照旧可用')
  assert.deepStrictEqual(audit.audit().map(item => item.command), ['createCourseSale'], '独立保存只发这一条命令')

  // ④b 之后新增的行，一次「保存资料」也要一起收尾（同一个按钮、同一份语义）。
  audit.clearAudit()
  page.openEditor('stu-edit')
  page.addPkg()
  // 注意索引：这位学员已经有一笔课时包了，新加的那一行在最后（不是 0）。
  const fresh = page.data.form.packages.length - 1
  assert.strictEqual(page.data.form.packages[fresh].isNew, true, '新加的那一行必须是"未保存"状态')
  fillPaid(fresh, { total: 10, remaining: 10, price: 400, amount: 3900 })
  await tapSave(page)
  await settle(20)
  state = world.snapshot()
  assert.strictEqual(state.students[0].packages.length, 2, '「保存资料」必须把页面上新填的课时包一起保存')
  assert.strictEqual(state.sales.length, 2, '两笔购买 = 两条销售，既没丢也没重复')
  assert.strictEqual(audit.audit().filter(item => item.command === 'createCourseSale').length, 1, '已存在的课时包不许被重新创建')

  // ─────────────── ⑤ 业务规则：独立字段、不重算 remaining、不用单价×数量覆盖业绩 ───────────────
  world.seed(emptyState())
  audit.clearAudit()
  page = loadStudentsPage()
  page.onShow()
  page.add()
  input(page, 'name', '人工值学员戊')
  // 只填姓名、课时包一行留空 → 只创建学员，不报错、也不许造出半个课时包。
  await tapSave(page)
  await settle(20)
  state = world.snapshot()
  assert.strictEqual(state.students.length, 1, '只填姓名也必须能存下学员')
  assert.strictEqual(state.students[0].packages.length, 0, '空白课时包行不许变成半成品')
  assert.deepStrictEqual(audit.audit().map(item => item.command), ['createStudent'])

  world.seed(emptyState())
  audit.clearAudit()
  page = loadStudentsPage()
  page.onShow()
  page.add()
  input(page, 'name', '人工值学员己')
  // total=20 / remaining=17：remaining 是独立人工值，绝不能被重算成 20 - 0 = 20。
  fillPaid(0, { total: 20, remaining: 17, price: 300, amount: 5500 })
  await tapSave(page)
  await settle(20)
  state = world.snapshot()
  const manual = state.students[0].packages[0]
  assert.strictEqual(manual.total, 20)
  assert.strictEqual(manual.remaining, 17, 'remaining 必须保持人工输入值（不许重算 total - used）')
  assert.strictEqual(manual.used, 0)
  assert.strictEqual(state.sales[0].amount, 5500, 'sale.amount 必须保持人工输入值（不许用 quantity × unitPrice 覆盖）')

  // 填了一半的行（有课时数、缺销售信息）必须当场明确拒绝，且一个字节都不写。
  page = loadStudentsPage()
  page.onShow()
  page.add()
  input(page, 'name', '半成品学员庚')
  pkgInput(page, 0, 'total', '20')
  pkgInput(page, 0, 'remaining', '20')
  audit.clearAudit()
  const before = JSON.stringify(world.snapshot())
  await tapSave(page)
  await settle(10)
  assert.strictEqual(JSON.stringify(world.snapshot()), before, '前置校验不通过时云端一个字节都不许动')
  assert.deepStrictEqual(audit.audit(), [], '前置校验不通过时不许发出任何写命令')
  assert.ok(toastTitles(world).some(title => /销售信息/.test(title)), `必须明确提示缺什么，实测 ${toastTitles(world).join('、')}`)

  // ───────────────────────────── ⑥ 静态：契约（不钉拼写） ─────────────────────────────
  const source = fs.readFileSync(path.join(PROJ, 'pages', 'students', 'students.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(PROJ, 'pages', 'students', 'students.wxml'), 'utf8')
  assert.ok(!/wx:if="\{\{form\.id \|\| !cloudPrimary\}\}"/.test(wxml), '课时包区块不允许再被 form.id 挡着（否则新增学员又得先存空学员）')
  assert.ok(wxml.includes('packages-section'), '课时包区块必须保留')
  assert.ok(!/wx:if="\{\{cloudPrimary\}\}"\s+class="package-save"[^>]*>\{\{item\.isNew\?/.test(wxml),
    '新会员录入不许再出现「保存这笔课程」：底部总保存会一次保存资料与全部新课时包')
  assert.ok(/保存资料与课程/.test(wxml), '唯一主保存按钮必须明确说明会同时保存资料与课程')
  assert.ok((source.match(/newPackageCommand/g) || []).length >= 3, '新课时包的 payload 必须只有一个构造入口（保存这笔课程 / 保存资料 共用）')
  assert.ok(!/wx\.cloud\.callFunction/.test(source), '页面不许绕过统一写入口直连云函数')
  assert.ok(!/adapter\.execute/.test(source), '页面不许绕过统一写入口直接发命令')

  console.log('students new-student-one-save tests: PASS (one tap = student + packages + sales, student-first order, honest partial failure, no duplicate student on retry, manual values kept, single payload builder)')
})().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 }).finally(() => { world.restoreUi() })
