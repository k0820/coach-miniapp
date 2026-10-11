// M2 V1 · §118 第 15 项补齐（2026-09-29）：学员页「可授课教练」表单（`teachingPublicCodes`）。
//
// ⛳ 这一条为什么必须单独测：它是**唯一**让"卖课时顺手把别的教练拉进来"生效的输入点。
//   表单这边少一个 trim、多下发一个空数组、或者把自己也算进名单，都会变成
//   「云端有一条关系，界面上从来没有这个入口」 —— 而这层比任何人用 UI 点出来的授权都更难查。
//
// ⛔ 业务口径（不变）：
//   · 客户端只提交**公开码**，永远不许提交 coachId / ownerCoachId（服务端一律视作伪造）；
//   · 创建 sales 的人得到销售业绩 + 管理权；被勾选的教练只得到**授课权**。

const assert = require('assert')
const path = require('path')
const fs = require('fs')
const { createWorld, runner, copy } = require('./helpers/m2-business-world')
const { todayKey } = require('../utils/beijing-date')

const world = createWorld()
const STUDENTS_PAGE = path.join(__dirname, '..', 'pages', 'students', 'students.js')
const WXML = path.join(__dirname, '..', 'pages', 'students', 'students.wxml')
const GRANTS = 'coach_sandbox_package_grants'

const grantRows = () => [...(world.stores[GRANTS] || new Map()).values()]
const grantsForPackage = packageId => grantRows().filter(row => row.packageId === packageId)
const forbiddenKeys = ['coachId', 'ownerCoachId', 'datasetId', 'openId', 'openid']

function setLocalStudentsSnapshot(coach, students) {
  world.storage.coachSandboxActiveCache = {
    environment: 'sandbox', datasetId: coach.datasetId, revision: 0,
    snapshot: { students, packages: [], bookings: [], incomes: [], sales: [], settings: {} }
  }
}

async function seed() {
  require('../utils/data-runtime').setEnvironment('sandbox')
  const A = world.seedCoach('openid-a', 'ds-a', 'PUBCODEA')
  const B = world.seedCoach('openid-b', 'ds-b', 'PUBCODEB')
  const C = world.seedCoach('openid-c', 'ds-c', 'PUBCODEC')
  world.seedStudent(A, 'stu-1', 'M2 表单学员')
  world.installRuntime()
  world.installFakeMutate()
  world.setActor(A)
  setLocalStudentsSnapshot(A, [{ id: 'stu-1', name: 'M2 表单学员', phone: '13800138000', packages: [] }])
  return { A, B, C }
}

// 真的页面：openEditor → addPkg → 逐项填 → 点「保存这笔课程」（persistPackage）。
async function openEditorAndAddPackage() {
  const page = world.enterPage(STUDENTS_PAGE)
  page.openEditor('stu-1')
  page.addPkg()
  return page
}
function fillPackage(page, index, values) {
  Object.keys(values).forEach(key => {
    page.pkg({ currentTarget: { dataset: { i: index, k: key } }, detail: { value: values[key] } })
  })
}
async function saveNewPackage(page, index) {
  const written = await page.persistPackage({ currentTarget: { dataset: { i: index } } })
  return written
}

;(async () => {
  await runner('① 正常路径：表单填公开码 ⇒ createCourseSale payload 必须带上 teachingPublicCodes', async () => {
    world.reset()
    const { B } = await seed()
    const page = await openEditorAndAddPackage()
    fillPackage(page, 0, { total: '5', remaining: '5', price: '100', saleAmount: '500', teachingCodes: B.publicCode })
    const written = await saveNewPackage(page, 0)
    assert.equal(written.ok, true, JSON.stringify(written))
    const sent = world.calls.find(item => item.command === 'createCourseSale')
    assert.ok(sent, '必须真的发出 createCourseSale')
    assert.deepEqual(sent.payload.teachingPublicCodes, [B.publicCode], `实测 ${JSON.stringify(sent.payload.teachingPublicCodes)}`)
  })

  await runner('② 名单真的落到云端：B 拿到**授课权**（canManage=false），A 自己是管理人', async () => {
    world.reset()
    const { A, B } = await seed()
    const page = await openEditorAndAddPackage()
    fillPackage(page, 0, { total: '5', remaining: '5', price: '100', saleAmount: '500', teachingCodes: B.publicCode })
    const written = await saveNewPackage(page, 0)
    const packageId = written.result.packageId
    const grants = grantsForPackage(packageId)
    assert.equal(grants.length, 2, `课包级授权必须是两条（A 管理人 + B 授课）实测 ${JSON.stringify(grants)}`)
    const mine = grants.find(row => row.coachId === A.owner)
    const theirs = grants.find(row => row.coachId === B.owner)
    assert.ok(mine && mine.canManage === true, '创建这笔销售的人必须拿到管理权')
    assert.ok(theirs, '被勾选的教练必须有一条授权')
    assert.equal(theirs.canManage, false, '⛔ 参与授课 ≠ 拿到管理权（销售业绩也不转移）')
  })

  await runner('③ 多位教练 + 乱空格 / 多余逗号 ⇒ 切分正确', async () => {
    world.reset()
    const { B, C } = await seed()
    const page = await openEditorAndAddPackage()
    fillPackage(page, 0, { total: '5', remaining: '5', price: '100', saleAmount: '500', teachingCodes: ` ${B.publicCode} , ${C.publicCode}, ` })
    await saveNewPackage(page, 0)
    const sent = world.calls.find(item => item.command === 'createCourseSale')
    assert.deepEqual(sent.payload.teachingPublicCodes, [B.publicCode, C.publicCode], `实测 ${JSON.stringify(sent.payload.teachingPublicCodes)}`)
  })

  await runner('④ 留空 ⇒ payload **不许带这个键**（空数组也算提交了字段，语义不一样）', async () => {
    world.reset()
    await seed()
    const page = await openEditorAndAddPackage()
    fillPackage(page, 0, { total: '5', remaining: '5', price: '100', saleAmount: '500' })
    await saveNewPackage(page, 0)
    const sent = world.calls.find(item => item.command === 'createCourseSale')
    assert.ok(!Object.prototype.hasOwnProperty.call(sent.payload, 'teachingPublicCodes'), `留空时不许带这个键（实测 ${JSON.stringify(sent.payload)}）`)
    // 只填一串逗号 / 空格 ⇒ 一样是不带键（而不是下发一个空数组，让服务端去猜语义）。
    world.calls.length = 0
    fillPackage(page, 0, { teachingCodes: ' , , ' })
    await saveNewPackage(page, 0)
    const second = world.calls.filter(item => item.command === 'createCourseSale').pop()
    assert.ok(second, '第二次必须真的发出命令')
    assert.ok(!Object.prototype.hasOwnProperty.call(second.payload, 'teachingPublicCodes'), `脏输入时不许带这个键（实测 ${JSON.stringify(second.payload)}）`)
  })

  await runner('⑤ 重复公开码 ⇒ 服务端去重，不许记两条授权', async () => {
    world.reset()
    const { B } = await seed()
    const page = await openEditorAndAddPackage()
    fillPackage(page, 0, { total: '5', remaining: '5', price: '100', saleAmount: '500', teachingCodes: `${B.publicCode},${B.publicCode}` })
    const written = await saveNewPackage(page, 0)
    assert.equal(written.ok, true, JSON.stringify(written))
    const grants = grantsForPackage(written.result.packageId)
    assert.equal(grants.length, 2, `重复码不许产生第三条（实测 ${JSON.stringify(grants.map(row => row.coachId))}）`)
    // 服务端回执里的"名单"也必须去重：它不是渲染文案，是"这次到底加了谁"的事实清单。
    const granted = written.result.teachingCoaches || []
    assert.equal(granted.length, 1, `同一位教练在名单里只许出现一次（实测 ${JSON.stringify(granted)}）`)
    // ⭐ 光数行数是**不够**的：同一个 coachId 写两次，落在同一行文档上 ⇒ 行数看不出区别。
    //    真正的判据是命令回执 —— 它说"这次授予了谁"，重复码必须在**那里**就被并掉。
    assert.equal(written.result.teachingCoaches.length, 1, `回执里同一个人只许出现一次（实测 ${JSON.stringify(written.result.teachingCoaches)}）`)
    assert.equal(written.result.teachingCoaches[0].coachId, B.owner)
  })

  await runner('⑥ 边界：公开码不存在 ⇒ 明确失败 + 一个字节都不许写进业务集合', async () => {
    world.reset()
    await seed()
    const page = await openEditorAndAddPackage()
    fillPackage(page, 0, { total: '5', remaining: '5', price: '100', saleAmount: '500', teachingCodes: 'PUB_NOBODY' })
    const written = await saveNewPackage(page, 0)
    assert.equal(written.ok, false, '不存在的公开码必须被拒绝')
    assert.equal(written.code, 'COACH_PUBLIC_CODE_NOT_FOUND', `必须说清楚是哪个公开码找不到（实测 ${JSON.stringify(written)}）`)
    assert.equal([...world.stores.packages.values()].length, 0, '拒绝之后不许留下半个课时包')
    assert.equal(grantRows().length, 0, '拒绝之后也不许留下半条授权')
    assert.ok(!world.toasts.some(item => item.title === '课程已新增'), '被拒绝不许报成功')
  })

  await runner('⑦ 「新增学员」那条入口没有 teachingCodes 字段 ⇒ 不得崩、不得凭空下发', async () => {
    world.reset()
    await seed()
    const page = world.enterPage(STUDENTS_PAGE)
    page.add()
    assert.equal(page.data.form.packages[0].teachingCodes, undefined, '新学员默认那一行没有这个字段（这是既有形状）')
    fillPackage(page, 0, { total: '5', remaining: '5', price: '100', saleAmount: '500' })
    await saveNewPackage(page, 0)
    const sent = world.calls.find(item => item.command === 'createCourseSale')
    assert.ok(sent, '必须真的发出命令')
    assert.ok(!Object.prototype.hasOwnProperty.call(sent.payload, 'teachingPublicCodes'), '字段不存在时不许下发')
  })

  await runner('⑧ ⛔ 客户端永远不许提交身份字段（服务端一律视作伪造）', async () => {
    world.reset()
    const { B } = await seed()
    const page = await openEditorAndAddPackage()
    fillPackage(page, 0, { total: '5', remaining: '5', price: '100', saleAmount: '500', teachingCodes: B.publicCode })
    await saveNewPackage(page, 0)
    const sent = world.calls.find(item => item.command === 'createCourseSale')
    forbiddenKeys.forEach(key => assert.ok(!Object.prototype.hasOwnProperty.call(sent.payload, key), `payload 里不许出现 ${key}`))
    const json = JSON.stringify(sent.payload)
    forbiddenKeys.forEach(key => assert.ok(!json.includes(`"${key}"`), `payload 深层也不许藏着 ${key}`))
  })

  await runner('⑨ 赠课跨教练授课授权（2026-09-29 已开通）：A 发的 2 节赠课可以授权 B 来上', async () => {
    world.reset()
    const { A, B } = await seed()
    const page = await openEditorAndAddPackage()
    // ① 表单这一层：赠课**复用同一个输入框**（不新建第二套 UI / 第二套 Design System）。
    const wxml = fs.readFileSync(WXML, 'utf8')
    const codeLine = (wxml.split('\n').find(line => line.includes('teachingCodes') && line.includes('<input')) || '')
    assert.ok(codeLine, '表单里必须有这个输入框')
    assert.ok(!codeLine.includes("item.type!=='赠送课程'"), '赠课也必须能填这个输入（复用现有组件，不再按类型藏起来）')
    // ② 构造入口：赠课走 createPackage，payload **同样**带公开码。
    const built = page.newPackageCommand({ type: '赠送课程', total: 2, remaining: 2, teachingCodes: B.publicCode }, 'stu-1')
    assert.equal(built.command, 'createPackage', '赠课仍然走 createPackage（不新建命令）')
    assert.deepEqual(built.payload.teachingPublicCodes, [B.publicCode], '赠课这条路径也要下发该字段')
    // ③ 云端这一层：`createPackage` 的字段白名单已经收它 ⇒ 真的授权成功。
    const probe = await world.execute(A, 'createPackage', {
      studentId: 'stu-1', type: '赠送课程', total: 2, remaining: 2, isGift: true, teachingPublicCodes: [B.publicCode]
    }, 'm2w_gift_with_codes')
    assert.equal(probe.ok, true, `赠课这条通道必须接受该字段（实测 ${JSON.stringify(probe)}）`)
    assert.equal(probe.result.gift, true, '仍然是赠课')
    assert.equal(probe.result.saleId, null, '赠课不产生销售记录 ⇒ 不可能被记成销售业绩')
    assert.deepEqual((probe.result.teachingCoaches || []).map(item => item.coachId), [B.owner], '回执要说清楚授权给了谁')

    // ④ 双层权限与收入归属：**一条都没变**。
    const grants = grantsForPackage(probe.result.packageId)
    const mine = grants.find(row => row.coachId === A.owner)
    const theirs = grants.find(row => row.coachId === B.owner)
    assert.ok(mine && mine.canManage === true, '发赠课的 A 有管理权')
    assert.ok(theirs && theirs.canManage === false, 'B 只拿到授课权，没有管理权')
    const sales = world.dataRows('sales', A.owner, A.datasetId)
    assert.equal(sales.length, 0, '赠课绝不生成销售业绩')
    // ⑤ B 用这份赠课排课并完成 ⇒ 80 元收入归 B，课时扣在 A 那本账。
    const packageId = probe.result.packageId
    const booked = await world.execute(B, 'createAuthorizedBooking', { studentId: 'stu-1', packageId, date: todayKey(), hour: 15, minute: 0 }, 'm2w_gift_book')
    assert.equal(booked.ok, true, `B 必须能用这份赠课排课（实测 ${JSON.stringify(booked)}）`)
    const bookingId = booked.result.bookingId
    await world.execute(B, 'updateBookingContent', {
      bookingId, items: [{ name: '卧推', sets: 4, reps: 12, weight: '40' }]
    })
    const done = await world.execute(B, 'completeBooking', { bookingId }, 'm2w_gift_done')
    assert.equal(done.ok, true, `B 必须能完成这节赠课（实测 ${JSON.stringify(done)}）`)
    const incomeInA = world.dataRows('incomes', A.owner, A.datasetId)
    const incomeInB = world.dataRows('incomes', B.owner, B.datasetId)
    assert.equal(incomeInA.length, 0, '收入不许回流给发赠课的 A')
    assert.equal(incomeInB.length, 1, '教学收入归实际授课的 B')
    assert.equal(incomeInB[0].amount, 80, '赠课的单价口径仍是 80 元')
    const pkg = world.dataRows('packages', A.owner, A.datasetId).find(item => item.id === packageId)
    assert.equal(pkg.remaining, 1, '课时扣在赠课所在那本账')
  })

  require('../utils/data-runtime').setEnvironment('production')
  if (!process.exitCode) process.stdout.write('ALL STUDENTS TEACHING PUBLIC CODES TESTS PASSED\n')
})().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
