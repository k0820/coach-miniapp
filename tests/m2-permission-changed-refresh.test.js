// M2 V1 · §118 第 12 项补齐（2026-09-29）：`permissionChanged` 自动刷新**到底有没有把数据刷出来**。
//
// ⛳ 为什么必须单独钉这一条（2026-09-27 事故）：
//   总线上 `request(...)` 一直在发，但全项目**零个** `subscribe()` ⇒ 广播空转，
//   "回前台 / 授权变了"之后页面显示的还是上一次读到的东西，只有下拉刷新才会更新。
//   这类故障的形状是"代码看起来全对、页面也正常渲染"，唯独事实是旧的 ——
//   只测「命令映射表里写着 permissionChanged」抓不到它，必须测**可见页面真的重读了一次**。
//
// ⛔ 本文件不用手写假 commander：服务端是真的 `createService` + 真 handlers（只替网络）。
//
// ⭐⭐ 2026-10-06：③⑥⑦ 原来钉的是**旧授权工作台**（A 填 B 的公开码 ⇒ openAddCoach / submitAddCoach）。
//    那个页面已随认领方案下线，五条授权命令改成**只由服务端触发**（`utils/ui-command-bindings.js` 的
//    SERVER_TRIGGERED_COMMANDS，见 tests/ui-cloud-command-bindings.test.js 接替）。
//    ⇒ 这里改钉"权限变化之后，**可见的学员页**到底有没有真的重读一次"——
//      新方案下"谁能给这位会员上课"由**添加联系人**决定，学员页就是那张名单的唯一出口。

const assert = require('assert')
const path = require('path')
const { createWorld, runner } = require('./helpers/m2-business-world')
const world = createWorld()
const autoRefresh = require('../utils/auto-refresh')
const runtime = require('../utils/data-runtime')
// ⭐ 「授权变了」只有一个官方入口：门面里的 notePermissionChanged（广播 + 强制重读）。
const authorization = require('../utils/coach-authorization')

const PAGE_PATH = path.join(__dirname, '..', 'pages', 'students', 'students.js')
const SANDBOX_CACHE_KEY = 'coachSandboxActiveCache'
const AUTH_COMMANDS = ['grantMemberService', 'revokeMemberService', 'grantPackageTeaching', 'revokePackageTeaching', 'transferPackageManagement']

// 统计**授权目录**云读次数（区分 execute 与 authorization，避免把写命令算进去）。
let directoryCalls = 0
function installCountingRuntime() {
  const storage = world.installRuntime()
  const raw = global.wx.cloud.callFunction
  global.wx.cloud.callFunction = async options => {
    if (options && options.data && options.data.action === 'authorization') directoryCalls += 1
    return raw(options)
  }
  return storage
}

// 探针页：只做一件事 —— 把自己被要求刷新的**每一次**都记下来。
// （看的不是"页面 hero 方法被调用"，而是"这个可见页面真的有权利拿到最新事实"。）
function enterProbe() {
  const install = autoRefresh.installPage
  const seen = []
  const config = install({
    data: {}, seen,
    refreshCalls: 0,
    refresh(reason) { return Promise.resolve() }
  }, { refresh(reason) { seen.push(reason); return Promise.resolve() } })
  const page = Object.assign(Object.create(null), config, { data: copy2(config.data) })
  return { page, seen }
}
const copy2 = value => value == null ? value : JSON.parse(JSON.stringify(value))
// 把上一次已经甩出去的刷新**跑完**：installPage 有一条硬规则 —— 上一轮没回来就不再叠加
// （in-flight 直接跳过）。所以这里的等待不是"睡一会儿赌它好了"，而是把微任务队列走完
// ⇒ `running` 一定被清空 ⇒ 后面的断言才是在测"该刷的有没有刷"，而不是在测"上一轮还在飞"。
const tick = async (rounds = 8) => { for (let i = 0; i < rounds; i += 1) await Promise.resolve() }
// ⚠️ 页面那一轮刷新里**真的有 await**（云端读取 / 云端写入）⇒ 只抽干微任务队列不够，
//    必须让宏任务也走几拍，"重读有没有完成"才是在测真实行为，而不是在测"上一轮还在飞"。
const settle = async (rounds = 20) => { for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setTimeout(resolve, 1)) }

// 真的进**学员列表页**（新出口）：授权会员就是列表里那张 `authorized` 卡。
const authorizedCards = page => (page.data.students || []).filter(item => item && item.authorized)
async function openStudentsPage(coach) {
  world.setActor(coach)
  // 学员页 render() 走 getDB()：测试区只认 coachSandboxActiveCache 这一份（读不到就抛）⇒ 先摆一本空账。
  world.storage[SANDBOX_CACHE_KEY] = {
    environment: 'sandbox', datasetId: coach.datasetId, revision: 0,
    snapshot: { students: [], bookings: [], incomes: [], sales: [], settings: { renewThreshold: 2, monthlyGoalSessions: 20 }, customExercises: [] }
  }
  const page = world.enterPage(PAGE_PATH)
  await page.onShow()
  await page.refreshAuthorized()
  return page
}

// A 建会员 + 课包（**带** B 的公开码 ⇒ B 一开始就能给这位会员上课；后面由撤销制造"权限变了"）
async function seedOwnPackage() {
  runtime.setEnvironment('sandbox')
  const A = world.seedCoach('openid-a', 'ds-a', 'PUBCODEA')
  const B = world.seedCoach('openid-b', 'ds-b', 'PUBCODEB')
  world.seedStudent(A, 'stu-1', 'M2 权限变更学员')
  world.setActor(A)
  const sold = await world.execute(A, 'createCourseSale', {
    studentId: 'stu-1', type: '常规训练', total: 5, remaining: 5, quantity: 5, unitPrice: 100, amount: 500,
    date: '2026-09-29', teachingPublicCodes: [B.publicCode]
  })
  assert.equal(sold.ok, true, JSON.stringify(sold))
  return { A, B, packageId: sold.result.packageId }
}

;(async () => {
  await runner('① 五条授权命令都必须映射到 permissionChanged（少一条就有页面不重读）', async () => {
    world.reset(); directoryCalls = 0; installCountingRuntime(); autoRefresh.unsubscribeAll()
    for (const command of AUTH_COMMANDS) {
      assert.equal(autoRefresh.refreshTriggerFor(command), 'permissionChanged', `${command} 必须触发权限刷新`)
    }
    assert.equal(autoRefresh.refreshTriggerFor('completeBooking'), 'bookingCompleted', '非授权命令不许串到 permissionChanged')
    assert.equal(autoRefresh.requestForCommand('不存在的命令'), false, '未知命令不许广播')
  })

  await runner('② 总线契约：未知触发点返回 false；同一拍内重复被合并成一次', async () => {
    world.reset(); directoryCalls = 0; installCountingRuntime(); autoRefresh.unsubscribeAll()
    const seen = []
    autoRefresh.subscribe(reason => seen.push(reason))
    assert.equal(autoRefresh.request('完全没登记过的触发点'), false, '未知触发点不许广播')
    const now = 2000000000000
    assert.equal(autoRefresh.request('permissionChanged', now), true, '登记的触发点必须播出去')
    assert.equal(autoRefresh.request('permissionChanged', now + 100), false, `400ms 内重复必须被合并（实测 ${JSON.stringify(seen)}）`)
    assert.equal(autoRefresh.request('permissionChanged', now + autoRefresh.DEDUPE_MS), true, '过了合并窗口必须能再播一次')
    assert.deepEqual(seen, ['permissionChanged', 'permissionChanged'])
    autoRefresh.unsubscribeAll()
  })

  await runner('③ 真的 UI 链（新出口）：权限变了 ⇒ 可见的**学员页**真的重读一次（不许躺在缓存里）', async () => {
    world.reset(); directoryCalls = 0; installCountingRuntime(); world.installFakeMutate(); autoRefresh.unsubscribeAll()
    const { A, B, packageId } = await seedOwnPackage()
    const page = await openStudentsPage(B)
    assert.equal(authorizedCards(page).length, 1, '（前置）B 这一帧里看得到那位会员')

    // A 在**自己手机上**撤销 B 的授课授权 ⇒ 权限真的变了。
    const revoked = await world.execute(A, 'revokePackageTeaching', { packageId, publicCode: B.publicCode })
    assert.equal(revoked.ok, true, JSON.stringify(revoked))
    await settle()
    const before = directoryCalls
    // ⛔ 走**官方入口**（写命令成功后页面就是调它）：广播 + 强制重读，一件事都不能少。
    await authorization.notePermissionChanged()
    await settle()
    assert.ok(directoryCalls > before, `权限变了 ⇒ 可见的学员页必须真的重读一次云端（实测 ${before} → ${directoryCalls}）`)
    // ⛔ 界面必须追上云端：撤销课包授课权时，由它**派生**出来的会员级服务关系会一并收掉
    //    （见 tests/m2-revocation-integrity.test.js ②）⇒ 会员整张卡从 B 的名单里消失。
    assert.equal(authorizedCards(page).length, 0, '⛔ 重读之后那张卡必须消失（界面追上云端，不许"报错了但东西还在"）')
    autoRefresh.unsubscribeAll()
  })

  await runner('④ 广播必须落到**别的可见页面**：收到 permissionChanged 就真的刷新一次', async () => {
    world.reset(); directoryCalls = 0; installCountingRuntime(); autoRefresh.unsubscribeAll()
    const { page: probe, seen } = enterProbe()
    probe.onShow()
    await tick()
    seen.length = 0
    const now = 2000000000000
    assert.equal(autoRefresh.request('permissionChanged', now), true)
    assert.deepEqual(seen, ['permissionChanged'], `可见页面必须被唤醒（实测 ${JSON.stringify(seen)}）`)
    // ① 页面不可见 ⇒ 不许响应广播（四个 tab 页同时在栈里，一次回前台会打爆云端）
    probe.onHide()
    await tick()
    seen.length = 0
    autoRefresh.request('permissionChanged', now + 10000)
    assert.equal(seen.length, 0, `不可见页面不许被广播（实测 ${JSON.stringify(seen)}）`)
    autoRefresh.unsubscribeAll()
  })

  await runner('⑤ pageShow 不许被总线重复送达（每个页面自己的 onShow 已经读过一次）', async () => {
    world.reset(); directoryCalls = 0; installCountingRuntime(); autoRefresh.unsubscribeAll()
    const { page: probe, seen } = enterProbe()
    probe.onShow()
    // 无 onShow 的页面由 installPage 兜底读一次，且**只一次**；总线那一拍不许再叠第二次。
    assert.deepEqual(seen, ['pageShow'], `进页面只许读一次（实测 ${JSON.stringify(seen)}）`)
    autoRefresh.unsubscribeAll()
  })

  await runner('⑥ 边界：写命令被云端拒绝 ⇒ 不许广播"权限变了"（没变就是没变）', async () => {
    world.reset(); directoryCalls = 0; installCountingRuntime(); world.installFakeMutate(); autoRefresh.unsubscribeAll()
    const { A, B, packageId } = await seedOwnPackage()
    const page = await openStudentsPage(B)
    // 撤销一位**从来没被授权过**的教练 ⇒ 云端必须拒（没变就是没变）。
    const C = world.seedCoach('openid-c', 'ds-c', 'PUBCODEC')
    await settle()
    const seen = []
    autoRefresh.subscribe(reason => seen.push(reason))
    const before = directoryCalls
    const again = await world.execute(A, 'revokePackageTeaching', { packageId, publicCode: C.publicCode })
    await settle()
    assert.equal(again.ok, false, `（前置）撤销一位没被授权过的教练必须被云端拒（实测 ${JSON.stringify(again)}）`)
    assert.ok(!seen.includes('permissionChanged'), `没改成却广播了权限变化（实测 ${JSON.stringify(seen)}）`)
    assert.equal(directoryCalls, before, `失败之后不该去重拉目录（实测 ${before} → ${directoryCalls}）`)
    assert.equal(world.modals.length + world.toasts.length > 0 || again.code.length > 0, true, '被拒绝必须有明确的码/文案，不许静默')
    autoRefresh.unsubscribeAll()
  })

  await runner('⑦ 边界：排课缺课时包 / 缺日期 ⇒ 在**出网之前**就被拦下（一条命令都不许发）', async () => {
    world.reset(); directoryCalls = 0; installCountingRuntime(); world.installFakeMutate(); autoRefresh.unsubscribeAll()
    const { B } = await seedOwnPackage()
    const page = await openStudentsPage(B)
    assert.equal(authorizedCards(page).length, 1, '（前置）B 看得到那位会员')

    // ① 空 packageId：不许出网
    page.openCard(authorizedCards(page)[0].id)
    page.openBooking()
    let before = world.calls.length
    page.setData({ 'booking.packageId': '' })
    await page.confirmBooking()
    assert.equal(world.calls.length, before, '空 packageId ⇒ 不许出网')
    assert.ok(world.toasts.some(item => /课时包/.test(String(item.title || ''))), `必须如实提示（实测 ${JSON.stringify(world.toasts)}）`)

    // ② 空日期：同样不许出网（真机 BUG05 的同源形状：日期不明不许退化成今天）
    world.toasts.length = 0
    page.openBooking()
    before = world.calls.length
    page.setData({ 'booking.date': '' })
    await page.confirmBooking()
    assert.equal(world.calls.length, before, '空日期 ⇒ 不许出网')
    assert.ok(world.modals.some(item => /日期/.test(String(item.content || ''))), `必须如实提示（实测 ${JSON.stringify(world.modals)}）`)
    autoRefresh.unsubscribeAll()
  })

  runtime.setEnvironment('production')
  if (!process.exitCode) process.stdout.write('ALL M2 PERMISSION CHANGED REFRESH TESTS PASSED\n')
})().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
