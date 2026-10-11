// M2 第五批（真机修复）：**教练端 Sandbox 状态链** 永久回归。
//
// 真机事故（2026-09-27）：进沙盒页显示「沙盒已准备」，点进 M2 验收页却被自己的门禁挡住
// —— "请先进入沙盒"。根因是**教练端 Sandbox 从来没落过盘**：
//   · sandbox-control.enter() 落的是 exitToCoach() ⇒ (coach + production)
//   · app.js 教练分支无条件 setEnvironment(PRODUCTION)
//   · member-environment.apply() 只对 member 角色恢复测试区
// ⇒ 教练端"我在测试区"只活在内存里：进程一重建（真机上极常见）就静默退回正式区。
//
// 本文件与 `m2-shared-sandbox-ui.test.js` 的分工：
//   那边把 data-runtime 换成假件（测页面自身的按钮与载荷）；
//   **这边一律用真模块**（真 app.js onLaunch + 真 member-environment + 真 data-runtime + 真页面对象），
//   专门盯"状态从哪来、能不能活过冷启动"。两边缺一边都补不上这个洞。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')
const PAGE = 'pages/sandbox-shared-test/sandbox-shared-test'
const MODULES = [
  'utils/db', 'utils/data-runtime', 'utils/member-runtime', 'utils/app-role',
  'utils/member-environment', 'utils/local-projection', 'utils/mutate',
  'utils/cloud-primary-adapter', 'utils/business-verification-policy', 'utils/business-verifiers',
  'utils/ui-cloud-command', 'utils/cloud-command-engine', 'utils/sync-engine',
  'utils/cloud-bootstrap', 'utils/production-recovery-guard', 'utils/booking-optimistic'
]

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// ⭐ 真正的"冷启动"：清空模块缓存（等价小程序进程重启），但**保留同一份 Storage**。
function freshModules() {
  MODULES.forEach(name => { const p = require.resolve(path.join(root, name)); delete require.cache[p] })
  delete require.cache[require.resolve(path.join(root, 'app.js'))]
  delete require.cache[require.resolve(path.join(root, `${PAGE}.js`))]
}
const COACH_DB = {
  students: [{ id: 's1', name: '小蓝', packages: [{ id: 'p1', type: '常规训练', remaining: 3, used: 1, reserved: 1, status: 'active' }] }],
  bookings: [{ id: 'b9', date: '2026-10-02', hour: 10, minute: 0, status: 'booked', packageUsage: { packageId: 'p1', studentId: 's1', ownerCoachId: 'A', datasetId: 'dsA' } }],
  incomes: [], sales: [{ id: 'sa1' }], customExercises: [], settings: {}
}
function makeStorage() {
  const storage = new Map()
  storage.set('coachDB', COACH_DB)
  storage.set('coachSandboxActiveCache', { datasetId: 'ds-sandbox-abcdef', environment: 'sandbox', revision: 4, checksum: 'x', snapshot: COACH_DB })
  return storage
}
function makeWx(storage) {
  return {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => { storage.set(key, JSON.parse(JSON.stringify(value))) },
    cloud: {
      init: () => {},
      callFunction: async ({ name, data }) => {
        if (name === 'manageCoachSandbox') return { result: { ok: true, exists: true, datasetId: 'ds-sandbox-abcdef' } }
        if (name === 'manageMemberSandbox') return { result: { ok: true, seeded: true } }
        if (name === 'readMyActiveCoachData') return { result: { ok: true, datasetId: 'ds-sandbox-abcdef', revision: 4, environment: (data && data.environment) || 'production', snapshot: COACH_DB } }
        return { result: { ok: true } }
      }
    },
    getNetworkType: () => {}, onNetworkStatusChange: () => {},
    reLaunch: () => {}, navigateTo: () => {}, redirectTo: () => {}, navigateBack: () => {},
    showModal: () => {}, showToast: () => {}, showLoading: () => {}, hideLoading: () => {},
    stopPullDownRefresh: () => {}, setClipboardData: () => {}
  }
}
// 真冷启动：跑**真的** app.js onLaunch（会员 or 教练分支），拿回真模块。
function launch(storage, launchPath) {
  freshModules()
  global.wx = makeWx(storage)
  let config = null
  global.App = value => { config = value }
  delete require.cache[require.resolve(path.join(root, 'app.js'))]
  require(path.join(root, 'app.js'))
  config.onLaunch({ path: launchPath })
  return {
    runtime: require(path.join(root, 'utils/data-runtime')),
    memberEnvironment: require(path.join(root, 'utils/member-environment')),
    appRole: require(path.join(root, 'utils/app-role'))
  }
}
// 真页面对象：只把 mutate 换成记录型假件（refresh() 不写任何东西），**runtime 必须是真的**。
function openPage() {
  let config = null
  const savedPage = global.Page
  global.Page = value => { config = value }
  const mutatePath = require.resolve(path.join(root, 'utils/mutate'))
  const savedMutate = require.cache[mutatePath]
  const fakeMutate = async () => { throw new Error('本测试只调用 refresh()，不应走到写入口') }
  fakeMutate.isCloudWritePath = () => false
  require.cache[mutatePath] = { id: mutatePath, filename: mutatePath, loaded: true, exports: fakeMutate }
  delete require.cache[require.resolve(path.join(root, `${PAGE}.js`))]
  require(path.join(root, `${PAGE}.js`))
  if (savedMutate) require.cache[mutatePath] = savedMutate; else delete require.cache[mutatePath]
  global.Page = savedPage
  const page = Object.assign({}, config)
  page.data = JSON.parse(JSON.stringify(config.data))
  page.setData = (patch, callback) => { Object.keys(patch || {}).forEach(key => { page.data[key] = patch[key] }); if (callback) callback() }
  return page
}
// 与 sandbox-control.enter() 的真实顺序一致：ensure → switchEnvironment(SANDBOX) → 成对落盘。
function enterCoachSandbox(world) {
  world.runtime.setEnvironment(world.runtime.ENVIRONMENTS.SANDBOX)
  world.memberEnvironment.enterCoachSandbox()
  return world
}

// ─────────────────────────────────────────────────── ① 真机主链：教练端 → 进沙盒 → M2
test('① 教练端冷启动 ⇒ 进入教练端沙盒 ⇒ M2 验收页必须能打开（真模块 + 真页面对象）', async () => {
  const storage = makeStorage()
  const world = enterCoachSandbox(launch(storage, 'pages/schedule/schedule'))
  assert.strictEqual(world.runtime.isSandbox(), true, '进入后运行时必须在测试区')
  assert.deepStrictEqual(world.memberEnvironment.pair(), { role: 'coach', environment: 'sandbox' }, '★ 落盘必须是 (coach + sandbox) —— 这就是原来丢掉的那一半')
  assert.strictEqual(world.memberEnvironment.consistent(), true)
  const page = openPage()
  await page.refresh()
  assert.strictEqual(page.data.sandbox, true, 'M2 页必须判自己在测试区（真机就是卡在这里）')
  assert.strictEqual(page.data.ready, true)
  assert.strictEqual(page.data.datasetTail, 'abcdef')
})

// ─────────────────────────────────────────────────── ② 进程重建：教练端沙盒必须活过冷启动
test('② 进入教练端沙盒后**进程重建**：仍是测试区，M2 仍然打得开', async () => {
  const storage = makeStorage()
  enterCoachSandbox(launch(storage, 'pages/schedule/schedule'))
  const restarted = launch(storage, 'pages/schedule/schedule')
  assert.strictEqual(restarted.runtime.isSandbox(), true, '★ 教练端测试区必须活过冷启动（原来这里会静默退回正式区）')
  assert.strictEqual(restarted.memberEnvironment.consistent(), true)
  const page = openPage()
  await page.refresh()
  assert.strictEqual(page.data.sandbox, true)
})

// ─────────────────────────────────────────────────── ③ 真机路径：会员端 → 回教练端 → 沙盒 → M2
test('③ 会员端测试区 → 回到教练端：**先回到正式区**（M2 必须挡住）→ 再进教练端沙盒 ⇒ 打得开', async () => {
  const storage = makeStorage()
  const world = launch(storage, 'pages/member-home/member-home')
  world.runtime.setEnvironment(world.runtime.ENVIRONMENTS.SANDBOX)
  world.memberEnvironment.enterSandbox()
  assert.deepStrictEqual(world.memberEnvironment.pair(), { role: 'member', environment: 'sandbox' })

  // 回到教练端（与 member-entry / member-profile 的 coach() 同顺序）
  world.runtime.setEnvironment(world.runtime.ENVIRONMENTS.PRODUCTION)
  world.memberEnvironment.exitToCoach()
  assert.deepStrictEqual(world.memberEnvironment.pair(), { role: 'coach', environment: 'production' }, '会员切回教练不得残留测试区')
  let page = openPage()
  await page.refresh()
  assert.strictEqual(page.data.sandbox, false, '这时还没进教练端沙盒 ⇒ M2 必须挡住（门禁不许为了"能打开"而取消）')
  assert.strictEqual(page.data.ready, false, '正式区不得把假数据列出来')

  // 再去沙盒页点「进入教练端沙盒」
  enterCoachSandbox(world)
  page = openPage()
  await page.refresh()
  assert.strictEqual(page.data.sandbox, true, '点了进入教练端沙盒之后就必须能打开')
})

// ─────────────────────────────────────────────────── ④ 正式区直开 M2：仍然必须被挡住
test('④ 从没进过任何测试区（正式区）直接打开 M2：必须被挡住，且不给任何数据', async () => {
  const storage = new Map()
  storage.set('coachDB', COACH_DB)
  const world = launch(storage, 'pages/schedule/schedule')
  assert.strictEqual(world.runtime.isSandbox(), false)
  const page = openPage()
  await page.refresh()
  assert.strictEqual(page.data.sandbox, false)
  assert.strictEqual(page.data.students.length, 0, '正式区不得列出课时包')
  assert.strictEqual(page.data.sharedBookings.length, 0)
})

// ─────────────────────────────────────────────────── ⑤ 半套状态必须被认出来（不是静默）
test('⑤ 「落盘是测试区、运行时是正式区」这种半套状态必须被 consistent() 抓红', () => {
  const storage = makeStorage()
  const world = enterCoachSandbox(launch(storage, 'pages/schedule/schedule'))
  assert.strictEqual(world.memberEnvironment.consistent(), true)
  world.runtime.setEnvironment(world.runtime.ENVIRONMENTS.PRODUCTION) // 只改内存，落盘没动
  assert.strictEqual(world.memberEnvironment.consistent(), false, '★ 半套状态不许被判成一致（这正是本次事故的形状）')
  const fresh = launch(storage, 'pages/schedule/schedule')
  assert.strictEqual(fresh.memberEnvironment.consistent(), true, '冷启动恢复回来就应当重新一致')
})

// ─────────────────────────────────────────────────── ⑥ 静态契约：单一状态来源
test('⑥ 静态：环境落盘只有一个来源，教练分支必须恢复它，页面不许自建第二套标志', () => {
  const appSource = read('app.js')
  const coachBranch = appSource.slice(appSource.indexOf('production-recovery-guard'))
  assert.ok(/member-environment'\)\.read\(\)/.test(coachBranch), '教练冷启动分支必须读持久化的环境')
  assert.ok(/runtime\.setEnvironment\(runtime\.ENVIRONMENTS\.PRODUCTION\)/.test(appSource), '没记录时仍必须显式落在正式区')

  const environmentSource = read('utils/member-environment.js')
  assert.ok(/function enterCoachSandbox\(\)/.test(environmentSource), '必须有"教练进入测试区"的成对落盘')
  assert.ok(/runtime\.setEnvironment\(read\(\)\)/.test(environmentSource), '恢复环境不许再按角色过滤（教练也要能恢复）')

  const controlSource = read('pages/sandbox-control/sandbox-control.js')
  const enterBranch = controlSource.slice(controlSource.indexOf('async enter()'), controlSource.indexOf('async member()'))
  assert.ok(enterBranch.includes('memberEnvironment.enterCoachSandbox()'), '进入教练端沙盒必须落 (coach + sandbox)')
  assert.ok(!enterBranch.includes('memberEnvironment.exitToCoach()'), '★ 进入教练端沙盒不许再写 production（这就是丢状态的元凶）')

  // M2 页只能问唯一来源，不许自己另立一套 sandbox 标志。
  const pageSource = read(`${PAGE}.js`)
  const codeOf = source => source.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n')
  const code = codeOf(pageSource)
  assert.ok(/runtime\.isSandbox\(\)/.test(code), 'M2 页必须从唯一来源问"我是不是在测试区"')
  assert.ok(!/isSandbox\s*[:=]\s*wx\.getStorageSync/.test(code), '不许自己读一个 storage key 当 sandbox 标志')
  assert.ok(!/coachM2Sandbox|m2Sandbox/.test(code), '不许新建第二套 Sandbox 标志')

  // 沙盒页必须把「云端数据集已准备」与「本进程现在在哪个区」分开显示（真机误读就出在这里）
  const controlView = read('pages/sandbox-control/sandbox-control.wxml')
  assert.ok(/本进程当前/.test(controlView), '沙盒页必须明说本进程现在在哪个区')
  assert.ok(/\{\{sandbox\?/.test(controlView))
  const pageView = read(`${PAGE}.wxml`)
  assert.ok(/去进入教练端沙盒/.test(pageView), '被挡住时必须给一条能走出去的路')
})

// ─────────────────────────────────────────────────── ⑦ 真点「进入教练端沙盒」按钮（不是只查源码）
//   上面 ① 走的是等价顺序；这条**真的调用** sandbox-control.enter()，
//   因为"落盘写错"这种错只有跑那个按钮才看得见（只查源码会漏掉顺序/分支类的改动）。
test('⑦ 真点「进入教练端沙盒」：环境切到测试区，且落盘必须是 (coach + sandbox)', async () => {
  const storage = makeStorage()
  const world = launch(storage, 'pages/schedule/schedule')
  let config = null
  const savedPage = global.Page
  global.Page = value => { config = value }
  global.getApp = () => ({ globalData: {} })
  // 只把云命令通道的"切环境"换成真改 runtime 的桩；member-environment / data-runtime 全是真的。
  const cmdPath = require.resolve(path.join(root, 'utils/ui-cloud-command'))
  const savedCmd = require.cache[cmdPath]
  require.cache[cmdPath] = {
    id: cmdPath, filename: cmdPath, loaded: true,
    exports: { switchEnvironment: async value => { world.runtime.setEnvironment(value); return { ok: true, environment: value } } }
  }
  delete require.cache[require.resolve(path.join(root, 'pages/sandbox-control/sandbox-control.js'))]
  require(path.join(root, 'pages/sandbox-control/sandbox-control.js'))
  if (savedCmd) require.cache[cmdPath] = savedCmd; else delete require.cache[cmdPath]
  global.Page = savedPage
  const page = Object.assign({}, config)
  page.data = JSON.parse(JSON.stringify(config.data))
  page.setData = (patch, callback) => { Object.keys(patch || {}).forEach(key => { page.data[key] = patch[key] }); if (callback) callback() }
  await page.enter()
  assert.strictEqual(world.runtime.isSandbox(), true, '按钮必须把运行时切进测试区')
  assert.deepStrictEqual(world.memberEnvironment.pair(), { role: 'coach', environment: 'sandbox' }, '★ 按钮必须把 (coach + sandbox) 落盘 —— 真机丢的就是这一下')
})

// ⚠️ 必须**跑完所有用例再汇总**：第一条失败就 return 会把后面的红全遮住
//   （判别力脚本只能看到第一个红，看不出一条改动到底被几处盯住）。
async function main() {
  let failed = 0
  for (const item of tests) {
    try { await item.fn(); console.log(`  ✓ ${item.name}`) } catch (error) {
      failed += 1
      console.error(`  ✗ ${item.name}\n    ${error.message}`)
    }
  }
  if (failed) { process.exitCode = 1; return }
  console.log(`m2 sandbox navigation state tests: ${tests.length}/${tests.length} PASS (coach sandbox persists, survives restart, member→coach→sandbox chain, production still blocked, single source of truth)`)
}
main()
