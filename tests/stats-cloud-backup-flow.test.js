const assert = require('assert')
const { CLOUD_BACKUP_META_KEY } = require('../utils/cloud-backup-version')
const snapshot = () => ({ students: [], bookings: [], incomes: [], sales: [], customExercises: [], settings: { monthlyGoalSessions: 40 } })
let pageDefinition
global.Page = definition => { pageDefinition = definition }
global.wx = {}
require('../pages/stats/stats.js')

function makePage({ confirmations = [true], failUpload = false } = {}) {
  const values = { coachDB: snapshot() }, calls = [], writes = [], answers = confirmations.slice()
  global.wx = {
    getStorageSync: key => values[key],
    setStorageSync: (key, value) => { values[key] = JSON.parse(JSON.stringify(value)); writes.push(key) },
    showToast() {},
    showModal(options) { if (options.success) options.success({ confirm: answers.length ? answers.shift() : false }) },
    cloud: {
      callFunction(options) {
        calls.push({ name: options.name, data: options.data })
        const data = options.data || {}
        if (options.name === 'verifyCoachDBBackup') return options.success({ result: { ok: false, code: 'NOT_FOUND' } })
        if (options.name === 'backupCoachDB') {
          if (failUpload && data.action === 'uploadChunk') return options.fail({ errMsg: 'network failed' })
          if (data.action === 'start') return options.success({ result: { ok: true, sessionId: 'session-1', backupVersion: 1 } })
          if (data.action === 'status') return options.success({ result: { ok: true, receivedChunks: [] } })
          if (data.action === 'uploadChunk') return options.success({ result: { ok: true } })
          if (data.action === 'finalize') return options.success({ result: { ok: true, completed: true, backupVersion: 1, schemaVersion: 1, checksum: data.checksum || 'final-checksum', byteSize: 123, summary: {}, updatedAt: '2026-09-11T00:00:00.000Z' } })
          if (data.action === 'abort') return options.success({ result: { ok: true } })
        }
      }
    }
  }
  const page = { ...pageDefinition, data: JSON.parse(JSON.stringify(pageDefinition.data)) }
  page.setData = patch => Object.assign(page.data, patch)
  page.render = () => {}
  return { page, values, calls, writes }
}

async function run() {
  let test = makePage()
  await test.page.backupCoachDBToCloud()
  await new Promise(resolve => setTimeout(resolve, 10))
  const backupCalls = test.calls.filter(item => item.name === 'backupCoachDB')
  assert.strictEqual(backupCalls[0].data.action, 'start')
  assert.ok(backupCalls.some(item => item.data.action === 'status'))
  assert.strictEqual(backupCalls.filter(item => item.data.action === 'uploadChunk').length, 7)
  assert.strictEqual(backupCalls[backupCalls.length - 1].data.action, 'finalize')
  assert.ok(backupCalls.every(item => !Object.prototype.hasOwnProperty.call(item.data, 'snapshot')))
  assert.strictEqual(test.values[CLOUD_BACKUP_META_KEY].backupVersion, 1)
  assert.deepStrictEqual(test.values.coachDB, snapshot())

  test = makePage({ confirmations: [false] })
  await test.page.backupCoachDBToCloud()
  assert.strictEqual(test.calls.filter(item => item.name === 'backupCoachDB').length, 0)

  test = makePage({ failUpload: true })
  await test.page.backupCoachDBToCloud()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.strictEqual(test.writes.includes(CLOUD_BACKUP_META_KEY), false)
  assert.deepStrictEqual(test.values.coachDB, snapshot())
  console.log('stats chunked backup flow tests: PASS')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
