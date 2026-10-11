const assert = require('assert'), fs = require('fs'), path = require('path'), crypto = require('crypto')
const root = path.join(__dirname, '..')
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')

// 真实形状：会员身份由微信可信 OPENID 推导，Sandbox 会员账号/claim 存在 member_sandbox_* 集合里。
const OPENID = 'openid-member-sandbox-fixture'
const memberId = sha(`member:${OPENID}`).slice(0, 32)
const MODULES = ['utils/db', 'utils/data-runtime', 'utils/member-runtime', 'utils/app-role', 'utils/member-environment', 'utils/member-view-model', 'utils/local-projection']

function sourceOf(relative) { return fs.readFileSync(path.join(root, relative), 'utf8') }
function resetModules() {
  MODULES.forEach(name => { const p = require.resolve(path.join(root, name)); delete require.cache[p] })
  const appPath = require.resolve(path.join(root, 'app.js')); delete require.cache[appPath]
}
function makeWx(db, calls) {
  const storage = new Map()
  return {
    storage,
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => { storage.set(key, JSON.parse(JSON.stringify(value))) },
    cloud: {
      init: () => {},
      callFunction: async ({ name, data }) => {
        calls.push({ name, data: JSON.parse(JSON.stringify(data)) })
        if (name === 'manageMemberSandbox') {
          if (data.action === 'seed') { db.memberSandbox = { memberId, claimId: 'claim-sandbox-1', coachId: 'coach-sandbox-1' }; return { result: { ok: true, seeded: true } } }
          return { result: { ok: true } }
        }
        if (name === 'readMyMemberData' || data.action === 'memberRead') {
          const environment = data.environment === 'sandbox' ? 'sandbox' : 'production'
          if (environment === 'sandbox' && db.memberSandbox) return { result: { ok: true, environment: 'sandbox', state: 'ready', dataRevision: 3, member: { displayName: '测试会员', theme: 'vitality' }, summary: { remaining: 11 }, packages: [{ packageViewId: `${db.memberSandbox.claimId}:sandbox-package-1`, remaining: 11, total: 12, used: 1 }], nextBooking: { date: '2026-01-02', hour: 10, minute: 0 }, recentTraining: [{ date: '2026-01-01', hour: 10, minute: 0 }], coaches: [{ coachKey: db.memberSandbox.coachId }], warnings: [] } }
          // 正式区会员集合为空 ⇒ 与 2026-09-26 真机事故同形状：四类数据全空且不报错。
          return { result: { ok: true, environment: 'production', state: 'unregistered', member: null, summary: { remaining: 0 }, packages: [], nextBooking: null, recentTraining: [], coaches: [], warnings: [] } }
        }
        return { result: { ok: true } }
      }
    },
    getNetworkType: () => {}, onNetworkStatusChange: () => {}, reLaunch: () => {}, navigateTo: () => {}, redirectTo: () => {}, showModal: () => {}, showToast: () => {}, showLoading: () => {}, hideLoading: () => {}
  }
}
// ⭐ 真正的"冷启动"：清空模块缓存（等价小程序进程重启），但**保留同一份 Storage**，
//   然后重新执行 app.js 的 onLaunch —— 这是本次事故唯一能重现出来的路径。
function coldLaunch(wx, options) {
  resetModules()
  let launched = null
  global.App = config => { launched = config }
  delete require.cache[require.resolve(path.join(root, 'app.js'))]
  require(path.join(root, 'app.js'))
  launched.onLaunch(options || { path: 'pages/member-home/member-home' })
  return {
    runtime: require(path.join(root, 'utils/data-runtime')),
    member: require(path.join(root, 'utils/member-runtime')),
    memberEnvironment: require(path.join(root, 'utils/member-environment')),
    appRole: require(path.join(root, 'utils/app-role'))
  }
}

async function run() {
  const db = {}, calls = []
  const wx = makeWx(db, calls)
  global.wx = wx

  // ① 首次进入会员 Sandbox（等价 sandbox-control.member()：先切环境，再成对落盘）
  resetModules()
  let runtime = require(path.join(root, 'utils/data-runtime'))
  let member = require(path.join(root, 'utils/member-runtime'))
  let memberEnvironment = require(path.join(root, 'utils/member-environment'))
  runtime.setEnvironment(runtime.ENVIRONMENTS.SANDBOX)
  memberEnvironment.enterSandbox()
  // 与 sandbox-control.member() 同顺序：ensure → seed → 切环境 → 成对落盘 → 读
  const seeded = await wx.cloud.callFunction({ name: 'manageMemberSandbox', data: { action: 'seed' } })
  assert.strictEqual(seeded.result.ok, true, '首次进入必须先 seed 会员 Sandbox')
  const first = await member.read()
  assert.strictEqual(first.state, 'ready', '首次进入会员 Sandbox 必须读到数据')
  assert.strictEqual(first.summary.remaining, 11)
  assert.deepStrictEqual(memberEnvironment.pair(), { role: 'member', environment: 'sandbox' }, '进入时必须同时落 role + environment')
  assert.ok(memberEnvironment.consistent())

  // ② 冷启动 / 重新打开体验版
  const cold = coldLaunch(wx)
  assert.strictEqual(cold.memberEnvironment.read(), 'sandbox', '持久化必须活过冷启动')
  assert.strictEqual(cold.member.environment(), 'sandbox', '冷启动后会员端仍必须处于测试区')
  assert.strictEqual(cold.runtime.environment(), 'sandbox')
  assert.deepStrictEqual(cold.memberEnvironment.pair(), { role: 'member', environment: 'sandbox' }, '角色与环境必须成对恢复')
  assert.ok(cold.memberEnvironment.consistent())

  // ③ 冷启动后必须读到同一个会员、同一条 claim、同一套 fixture
  const second = await cold.member.read()
  assert.strictEqual(second.state, 'ready', '冷启动后不得退回未注册状态')
  assert.strictEqual(second.summary.remaining, first.summary.remaining)
  assert.strictEqual(second.packages[0].packageViewId, first.packages[0].packageViewId, '必须是同一条 claim / 同一个课时包')
  assert.ok(second.coaches.length, '我的教练不得为空')
  assert.ok(calls.filter(row => row.name === 'readMyMemberData' || row.data.action === 'memberRead').every(row => row.data.environment === 'sandbox'), '所有会员读取都必须发生在测试区')

  // ④ 切回教练端：角色与环境一起回到 production，Sandbox 状态不得污染教练正式区
  cold.memberEnvironment.exitToCoach()
  assert.deepStrictEqual(cold.memberEnvironment.pair(), { role: 'coach', environment: 'production' })
  resetModules()
  const coachRuntime = require(path.join(root, 'utils/data-runtime'))
  const coachEnvironment = require(path.join(root, 'utils/member-environment'))
  assert.strictEqual(coachEnvironment.apply(), 'production', '非会员角色绝不允许恢复成测试区')

  // ⑤ 静态契约：环境必须真的写进 Storage；冷启动入口必须真的恢复环境
  const environmentSource = sourceOf('utils/member-environment.js')
  assert.ok(/wx\.setStorageSync/.test(environmentSource), '会员环境必须持久化到 Storage')
  assert.ok(/wx\.getStorageSync/.test(environmentSource))
  const appSource = sourceOf('app.js')
  const memberBranch = appSource.slice(appSource.indexOf('if (appRole.isMember(options))'), appSource.indexOf('production-recovery-guard'))
  assert.ok(/memberEnvironment\.apply\(\)/.test(memberBranch), '会员冷启动分支必须恢复持久化的环境')
  assert.ok(appSource.includes("runtime.setEnvironment(runtime.ENVIRONMENTS.PRODUCTION)"), '教练分支仍必须显式设为正式区')
  const sandboxSource = sourceOf('pages/sandbox-control/sandbox-control.js')
  assert.ok(sandboxSource.includes('memberEnvironment.enterSandbox()'), '进入会员测试区必须成对落盘')
  assert.ok(!/appRole\.set\('member'\)/.test(sandboxSource), '不得再只落 role 不落 environment')

  // ⑥ 异常状态不得静默：会员页必须把 unregistered / 环境不匹配 / warnings 显示出来
  const homeWxml = sourceOf('pages/member-home/member-home.wxml')
  const packagesWxml = sourceOf('pages/member-packages/member-packages.wxml')
  assert.ok(homeWxml.includes('notice.length') && packagesWxml.includes('notice.length'), '会员页必须渲染异常提示')
  const viewModel = sourceOf('utils/member-view-model.js')
  assert.ok(viewModel.includes('function notice('))
  const notice = require(path.join(root, 'utils/member-view-model')).notice
  assert.ok(notice({ state: 'unregistered', environment: 'production' }, { environment: 'production', expected: 'sandbox' }).length >= 2, '未注册 + 环境不匹配必须同时提示')
  assert.ok(notice({ state: 'ready', environment: 'sandbox', warnings: [{ code: 'COACH_DATASET_HEAD_AMBIGUOUS' }] }, { environment: 'sandbox', expected: 'sandbox' }).some(row => row.includes('COACH_DATASET_HEAD_AMBIGUOUS')), 'warnings 不得静默')
  assert.strictEqual(notice({ state: 'ready', environment: 'sandbox' }, { environment: 'sandbox', expected: 'sandbox' }).length, 0, '正常状态不得误报')

  console.log('member sandbox environment persistence tests: PASS (first entry, cold start stays sandbox, same member/claim/fixture, role+environment paired, notices visible)')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
