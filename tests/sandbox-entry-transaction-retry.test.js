const assert = require('assert')
const path = require('path')
const ROOT = path.join(__dirname, '..')

let page = null
let coachCalls = 0
let memberCalls = 0
let relaunched = ''
const storage = { coachSandboxActiveCache: { environment: 'sandbox', datasetId: 'old-sandbox', revision: 9 }, coachSandboxActiveRows: { revision: 9 } }
const removed = []
global.getApp = () => ({ globalData: {} })
global.Page = object => { page = object }
global.wx = {
  getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value }, removeStorageSync: key => { removed.push(key); delete storage[key] },
  showLoading: () => {}, hideLoading: () => {}, showToast: () => {},
  showModal: () => {},
  reLaunch: ({ url }) => { relaunched = url },
  cloud: { callFunction: async ({ name, data }) => {
    if (name === 'manageCoachSandbox') {
      coachCalls += 1
      if (coachCalls === 1) throw { errMsg: 'cloud.callFunction:fail errCode: -504003 Invoking task timed out after 3 seconds FUNCTIONS_TIME_LIMIT_EXCEEDED' }
      if (coachCalls === 2) throw { errMsg: 'document.remove:fail -501001 [ResourceUnavailable.TransactionConflict] Transaction is conflict' }
      return { result: { ok: true, environment: 'sandbox', datasetId: 'sandbox-dataset' } }
    }
    if (name === 'manageMemberSandbox') { memberCalls += 1; return { result: { ok: true, seeded: true } } }
    if (name === 'coachBusinessSandboxCommand') return { result: { ok: true } }
    throw new Error(`unexpected function ${name} ${data && data.action}`)
  } }
}

const ui = require(path.join(ROOT, 'utils', 'ui-cloud-command.js'))
ui.switchEnvironment = async () => ({ ok: true, environment: 'sandbox' })
require(path.join(ROOT, 'pages', 'sandbox-control', 'sandbox-control.js'))
page.setData = function (patch) { Object.assign(this.data, patch || {}) }

;(async () => {
  await page.member()
  assert.strictEqual(coachCalls, 3, '超时和事务冲突后都必须自动续查')
  assert.strictEqual(memberCalls, 1, '教练 Sandbox 准备好后会员 seed 只调用一次')
  assert.deepStrictEqual(removed.sort(), ['coachSandboxActiveCache', 'coachSandboxActiveRows'], '切换前必须只丢弃两份 Sandbox 旧读取缓存')
  assert.strictEqual(relaunched, '/pages/member-home/member-home', '重试成功后必须正常进入会员首页')
  assert.strictEqual(page.data.busy, true, '跳转前保持 busy，防止用户重复点击')
  console.log('sandbox entry transaction retry: PASS')
})().catch(error => { console.error(error); process.exit(1) })
