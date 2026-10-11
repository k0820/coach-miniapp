const assert = require('assert')
const Module = require('module')

let pageDefinition
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '../../utils/local-backup') return { validateSnapshot: () => ({ ok: false, message: '备份顶层不是有效对象。' }) }
  if (request === '../../utils/cloud-shadow-read') {
    return {
      readMyCoachCloudSnapshot: async ({ call }) => call('readMyCoachCloudData', { action: 'metadata' }),
      compareCloudAndLocal() { throw new Error('不应进入本机比较') }
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
global.Page = definition => { pageDefinition = definition }
const calls = [], modals = []
global.wx = {
  getStorageSync() { throw new Error('云端无迁移时不应先读取本机 coachDB') },
  cloud: {
    callFunction(options) {
      calls.push(options.data)
      options.success({ result: { ok: false, code: 'MIGRATION_NOT_FOUND', message: '没有找到已完成的云端迁移。' } })
    }
  },
  showModal(options) { modals.push(options) }
}
require('../pages/coach-cloud-read-test/coach-cloud-read-test.js')
Module._load = originalLoad

async function run() {
  const page = { ...pageDefinition, data: JSON.parse(JSON.stringify(pageDefinition.data)) }
  page.setData = patch => Object.assign(page.data, patch)
  await page.verify()
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].action, 'metadata')
  assert.strictEqual(page.data.status, '当前微信暂无已完成的云端迁移数据')
  assert.strictEqual(modals.length, 1)
  assert.strictEqual(modals[0].title, '暂无云端数据')
  assert.ok(modals[0].content.includes('无法读取其他微信的数据'))
  console.log('coach cloud read page tests: PASS (cloud identity result precedes local comparison)')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
