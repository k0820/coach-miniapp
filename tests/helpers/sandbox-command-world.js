// No network or real storage: retain the real client funnel, adapter, coordinator,
// sync engine and deployed function sources. Only wx and the CloudBase DB are fake.
const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const path = require('path')
const { createRequire } = require('module')
const { createCoachSpaceCloud, copy } = require('./coach-space-cloud')
const { coachIdFor, fixedId, createService } = require('../../cloudfunctions/coachBusinessCommand/core')
const { handlers } = require('../../cloudfunctions/coachBusinessCommand/handlers')
const PROJ = path.resolve(__dirname, '../..')

function createWorld() {
  const cloud = createCoachSpaceCloud()
  const owner = coachIdFor('isolated-sandbox-integration'), datasetId = 'sandbox-integration-only'
  const put = (name, id, data) => cloud.stores[name].set(id, { ...data, _id: id })
  put('coaches', owner, { openId: 'isolated-sandbox-integration', status: 'active' })
  put('coach_datasets', fixedId('coach-dataset', owner, datasetId), { ownerCoachId: owner, datasetId, environment: 'sandbox', status: 'active', integrityStatus: 'verified' })
  put('coach_sandbox_heads', fixedId('coach-sandbox-head', owner), { ownerCoachId: owner, environment: 'sandbox', activeDatasetId: datasetId, headVersion: 1 })
  put('coach_sandbox_revisions', fixedId('coach-sandbox-revision', owner, datasetId), { ownerCoachId: owner, datasetId, dataRevision: 0 })
  const command = createService({ db: cloud.db, getOpenId: () => 'isolated-sandbox-integration', handlers })
  const file = path.join(PROJ, 'cloudfunctions/readMyActiveCoachData/index.js')
  const exports = {}, localRequire = createRequire(file)
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    exports, Buffer, console,
    require: name => name === 'wx-server-sdk' ? { init() {}, database: () => cloud.db, getWXContext: () => ({ OPENID: 'isolated-sandbox-integration' }) } : localRequire(name)
  }, { filename: file })
  const store = { coachDataSourceMode: 'cloud-primary', coachCloudCutoverState: { status: 'cloud-primary' } }
  const calls = [], modals = [], toasts = []
  const world = { cloud, store, calls, modals, toasts, owner, datasetId, beforeCall: null, afterCall: null, pendingCalls: 0 }
  global.wx = {
    getStorageSync: key => copy(store[key]), setStorageSync: (key, value) => { store[key] = copy(value) }, removeStorageSync: key => { delete store[key] },
    showToast: value => toasts.push(value), showModal: value => modals.push(value), showLoading() {}, hideLoading() {}, showTabBar() {}, hideTabBar() {},
    nextTick: work => setTimeout(work, 0),
    cloud: { callFunction: async ({ name, data }) => {
      assert.equal(data.environment, 'sandbox', 'test must never route a call to Production')
      assert.ok(['coachBusinessCommand', 'readMyActiveCoachData'].includes(name), 'no initialization, migration or other cloud functions')
      const call = { name, data: copy(data) }; calls.push(call); world.pendingCalls++
      try {
        if (world.beforeCall) await world.beforeCall(call)
        const result = await (name === 'coachBusinessCommand' ? command(data) : exports.main(data))
        call.result = copy(result)
        if (world.afterCall) await world.afterCall(call)
        return { result: copy(result) }
      } finally { world.pendingCalls-- }
    } }
  }
  world.runtime = require('../../utils/data-runtime')
  world.runtime.setEnvironment('sandbox')
  world.ui = require('../../utils/ui-cloud-command')
  world.mutate = require('../../utils/mutate')
  world.sync = require('../../utils/sync-engine')
  world.rows = name => [...cloud.stores[name].values()].filter(row => row.ownerCoachId === owner && row.datasetId === datasetId).map(copy)
  world.executeCalls = name => calls.filter(call => call.data.action === 'execute' && (!name || call.data.envelope.command === name))
  world.idle = async () => {
    for (let i = 0, quiet = 0; i < 1000; i++) {
      await new Promise(resolve => setTimeout(resolve, 1))
      await world.sync.whenIdle()
      if (!world.pendingCalls) quiet++; else quiet = 0
      if (quiet >= 5) return
    }
    throw new Error('isolated client did not settle')
  }
  world.page = name => {
    let definition
    global.Page = value => { definition = value }
    require(path.join(PROJ, 'pages', name, name + '.js'))
    delete global.Page
    return { ...definition, data: copy(definition.data), setData(patch) {
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
        let target = this.data
        for (const part of parts.slice(0, -1)) target = target[part]
        target[parts.at(-1)] = copy(value)
      }
    } }
  }
  return world
}
module.exports = { createWorld }
