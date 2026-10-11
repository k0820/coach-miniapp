const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { returnToProduction, resetReturnNavigation } = require('../utils/sandbox-navigation')

;(async () => {
  resetReturnNavigation()
  let resolveSwitch, switches = 0, launches = 0, loading = 0, busy = false
  const wxApi = {
    showLoading() { loading++ }, hideLoading() { loading-- }, showToast() {},
    reLaunch({ url }) { assert.equal(url, '/pages/schedule/schedule'); launches++ }
  }
  const switchEnvironment = () => { switches++; return new Promise(resolve => { resolveSwitch = resolve }) }
  const options = { switchEnvironment, production: 'production', wxApi, onBusy: value => { busy = value } }
  const first = returnToProduction(options)
  const repeated = [returnToProduction(options), returnToProduction(options), returnToProduction(options)]
  assert.equal(busy, true, '第一次点击应立即进入处理中')
  assert.equal(switches, 1, '连点期间只允许一次环境切换')
  assert(repeated.every(promise => promise === first), '连点必须复用同一个 in-flight Promise')
  resolveSwitch({ ok: true })
  await Promise.all([first, ...repeated])
  assert.equal(launches, 1, '连点只允许一次页面跳转')
  assert.equal(loading, 0)
  await returnToProduction(options)
  assert.equal(launches, 1, '已发起跳转后不得再次跳转')
  resetReturnNavigation()
  const next = returnToProduction({ ...options, switchEnvironment: async () => ({ ok: false }) })
  await next
  assert.equal(busy, false, '切换失败应重新允许用户操作')

  const page = fs.readFileSync(path.join(__dirname, '../pages/sandbox-control/sandbox-control.js'), 'utf8')
  const banner = fs.readFileSync(path.join(__dirname, '../components/sandbox-banner/sandbox-banner.js'), 'utf8')
  const pageView = fs.readFileSync(path.join(__dirname, '../pages/sandbox-control/sandbox-control.wxml'), 'utf8')
  const bannerView = fs.readFileSync(path.join(__dirname, '../components/sandbox-banner/sandbox-banner.wxml'), 'utf8')
  assert(page.includes('if (this.data.busy) return'), '进入/重置必须有 busy 门禁')
  assert(page.includes('returnToProduction(') && banner.includes('returnToProduction('), '两个返回入口必须共用 single-flight')
  assert(pageView.includes('disabled="{{busy}}"') && bannerView.includes('disabled="{{returning}}"'))
  let app
  global.App = definition => { app = definition }
  delete require.cache[require.resolve('../app')]
  require('../app')
  delete global.App
  const runtime = require('../utils/data-runtime')
  runtime.setEnvironment('sandbox')
  app.onHide()
  assert.equal(runtime.environment(), 'sandbox', '普通切页/后台切换不能自动退出 Sandbox')
  const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8')
  assert(appSource.includes('runtime.setEnvironment(runtime.ENVIRONMENTS.PRODUCTION)'), '真正重启仍须默认 Production')
  runtime.setEnvironment('production')
  console.log('sandbox navigation tests passed (instant busy, one switch, one reLaunch, enter/reset guards)')
})().catch(error => { console.error(error); process.exitCode = 1 })
