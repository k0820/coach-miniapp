const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const scene = 'p1234567890abcdef1234567890abcde'
const otherScene = 'pabcdef1234567890abcdef123456789'
const store = {}
const relaunches = []
let appConfig = null

function clear(relative) {
  const target = require.resolve(path.join(root, relative))
  delete require.cache[target]
}
function resetRuntimeModules() {
  for (const name of ['app.js', 'utils/app-role', 'utils/member-environment', 'utils/data-runtime']) clear(name)
}
function makeWx() {
  return {
    cloud: { init() {} },
    getStorageSync: key => store[key],
    setStorageSync: (key, value) => { store[key] = value },
    reLaunch: ({ url }) => { relaunches.push(url) },
    showToast() {}, getNetworkType() {}, onNetworkStatusChange() {}
  }
}
function tick() { return new Promise(resolve => setTimeout(resolve, 5)) }
function loadApp() {
  resetRuntimeModules()
  appConfig = null
  global.App = value => { appConfig = value }
  require(path.join(root, 'app.js'))
  return appConfig
}

async function run() {
  global.wx = makeWx()
  resetRuntimeModules()
  const role = require(path.join(root, 'utils/app-role'))
  const memberEnvironment = require(path.join(root, 'utils/member-environment'))

  // ① 领取成功后，角色、环境和本次随机二维码门牌号都必须持久保存。
  role.set('member')
  memberEnvironment.enterFromClaimScene(scene)
  assert.strictEqual(memberEnvironment.rememberClaimScene(scene), scene)
  assert.strictEqual(memberEnvironment.isRememberedClaimScene(scene), true)
  assert.strictEqual(memberEnvironment.isRememberedClaimScene(otherScene), false, '另一份二维码不能冒充已领取资料')

  // ② 微信把上一次二维码路径带进冷启动时，应直接回会员首页，不再打开已失效的领取页。
  relaunches.length = 0
  let app = loadApp()
  app.onLaunch({ path: 'pages/member-claim/member-claim', scene })
  await tick()
  assert.deepStrictEqual(relaunches, ['/pages/member-home/member-home'])
  assert.strictEqual(app.globalData.memberEntryScene, '', '已领取的旧 scene 不得继续交给领取页')

  // ③ 小程序在后台时再次收到同一二维码入口，也必须直接回会员首页。
  relaunches.length = 0
  global.getCurrentPages = () => [{ route: 'pages/member-claim/member-claim' }]
  app.onShow({ path: 'pages/member-claim/member-claim', scene })
  await tick()
  assert.deepStrictEqual(relaunches, ['/pages/member-home/member-home'])

  // ④ 旧 ready 缓存只能用于普通冷启动；只要本次携带二维码，就必须先识别这张码，
  // 防止“上一份资料的缓存”把一张新码短路回旧会员首页。
  delete store.coachMemberClaimedScene
  store['coachMemberActiveCache:production'] = { ok: true, environment: 'production', state: 'ready', member: { displayName: '测试 A' } }
  relaunches.length = 0
  app = loadApp()
  app.onLaunch({ path: 'pages/member-claim/member-claim', scene })
  await tick()
  assert.deepStrictEqual(relaunches, [], '携带二维码时不得用旧 ready 缓存跳过新资料预览')

  // 只有角色、没有 ready 会员资料，不得误跳过首次领取。
  delete store['coachMemberActiveCache:production']
  relaunches.length = 0
  app = loadApp()
  app.onLaunch({ path: 'pages/member-claim/member-claim', scene: otherScene })
  await tick()
  assert.deepStrictEqual(relaunches, [], '只点过会员身份但未领取资料的用户仍须看到领取页')

  // ⑤ 页面自身保留第二道保护：即使路由层没有拦住，也不请求已经消费过的二维码。
  store.coachMemberClaimedScene = scene
  let previewCalls = 0
  const directoryPath = require.resolve(path.join(root, 'utils/member-directory'))
  require.cache[directoryPath] = { id: directoryPath, filename: directoryPath, loaded: true, exports: {
    previewMemberClaimQr: async () => { previewCalls += 1; return { ok: false } },
    claimMemberByQr: async () => ({ ok: true }), newRequestId: () => 'req-1'
  } }
  let pageConfig = null
  global.Page = value => { pageConfig = value }
  global.getApp = () => ({ globalData: { activeRole: 'member', memberEntryScene: scene } })
  delete require.cache[require.resolve(path.join(root, 'pages/member-claim/member-claim.js'))]
  require(path.join(root, 'pages/member-claim/member-claim.js'))
  relaunches.length = 0
  const page = { ...pageConfig, data: { ...pageConfig.data }, setData(value) { Object.assign(this.data, value) } }
  page.onLoad({ scene })
  assert.strictEqual(previewCalls, 0, '已领取会员不得再次请求已消费二维码')
  assert.deepStrictEqual(relaunches, ['/pages/member-home/member-home'])

  // ⑥ 本机标记缺失时，云端若确认 state=mine，也应自动补记并进入会员首页。
  delete store.coachMemberClaimedScene
  require.cache[directoryPath].exports.previewMemberClaimQr = async () => ({ ok: true, state: 'mine', member: { displayName: '测试 A' }, summary: { remaining: 20 } })
  const fallback = { ...pageConfig, data: { ...pageConfig.data, scene }, setData(value) { Object.assign(this.data, value) } }
  relaunches.length = 0
  await fallback.preview()
  assert.strictEqual(store.coachMemberClaimedScene, scene)
  assert.deepStrictEqual(relaunches, ['/pages/member-home/member-home'])

  // ⑦ 静态保护：真正领取成功的主动作必须先记住 scene，再返回首页。
  const claimSource = fs.readFileSync(path.join(root, 'pages/member-claim/member-claim.js'), 'utf8')
  const confirmStart = claimSource.indexOf('async confirm()')
  const confirmSource = claimSource.slice(confirmStart)
  assert.ok(confirmSource.includes('memberEnvironment.rememberClaimScene(this.data.scene)'))
  assert.ok(confirmSource.indexOf('rememberClaimScene') < confirmSource.indexOf("wx.reLaunch({ url: '/pages/member-home/member-home' })"), '必须先记住领取成功，再跳转首页')

  console.log('member claim reopen auto-login tests: PASS (cold launch, foreground QR, page guard, server-owned fallback)')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
