const assert = require('assert')
const { buildCandidateDataset } = require('../utils/candidate-dataset')
const { createAdapter } = require('../utils/cloud-primary-adapter')
const { returnToProduction, resetReturnNavigation } = require('../utils/sandbox-navigation')

const snapshot = { students: [], bookings: [], incomes: [], sales: [], settings: { renewThreshold: 3, monthlyGoalSessions: 20, classCommissionRate: 0, salesCommissionRate: 0 }, customExercises: [] }
const built = buildCandidateDataset(snapshot, { trustedOwnerCoachId: 'isolated-owner', trustedDatasetId: 'isolated-dataset' })
const physical = { students: 'students', studentTombstones: 'student_tombstones', packages: 'packages', bookings: 'bookings', incomes: 'incomes', sales: 'sales', settings: 'settings', customExercises: 'customExercises' }
const timeout = (promise, ms = 150) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('return to Production waited for a Sandbox/cloud read')), ms))])

async function run() {
  // A Sandbox write is deliberately held. Production's independent read must
  // not queue behind another dataset's write/verified-read chain.
  let environment = 'sandbox', releaseSandbox, commandStarted
  const blocked = new Promise(resolve => { releaseSandbox = resolve })
  const started = new Promise(resolve => { commandStarted = resolve })
  const caches = {}
  const adapter = createAdapter({ environment: () => environment, storage: { get: key => caches[key], set: (key, value) => { caches[key] = value } }, callCloud: async (name, data) => {
    if (name === 'coachBusinessCommand') { commandStarted(); await blocked; return { ok: true, datasetRevision: 1, result: {} } }
    if (data.action === 'metadata') return { ok: true, environment: data.environment, datasetId: 'isolated-dataset', dataRevision: 0, collections: Object.values(physical) }
    if (data.action === 'integrity') return { ok: true, environment: data.environment, datasetId: 'isolated-dataset', dataRevision: 0, ...built.integrity }
    const logical = Object.keys(physical).find(key => physical[key] === data.collection)
    const rows = built.collections[logical]
    return { ok: true, nextCursor: rows.length, done: true, payload: Buffer.from(JSON.stringify(rows)).toString('base64') }
  } })
  assert.equal((await adapter.readActive()).ok, true)
  const sandboxWrite = adapter.execute('saveSettings', {}, { requestId: 'sandbox-held-command' })
  await started
  environment = 'production'
  const productionRead = await timeout(adapter.readActive())
  assert.equal(productionRead.ok, true)
  assert.equal(productionRead.environment, 'production')
  assert.equal(caches.coachSandboxActiveCache.environment, 'sandbox')
  assert.equal(caches.coachCloudActiveCache.environment, 'production')
  releaseSandbox()
  await sandboxWrite

  // Actual UI exit chain: an already verified Production cache restores the
  // page without waiting for the next async Cloud refresh. No fake data copy.
  const store = { coachDataSourceMode: 'cloud-primary', coachCloudCutoverState: { status: 'cloud-primary' },
    coachCloudActiveCache: caches.coachCloudActiveCache, coachSandboxActiveCache: caches.coachSandboxActiveCache }
  let launches = 0, loading = 0, productionCloudReads = 0
  global.wx = {
    getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = value },
    showLoading: () => { loading++ }, hideLoading: () => { loading-- }, showToast() {},
    reLaunch: ({ url }) => { assert.equal(url, '/pages/schedule/schedule'); launches++ }
  }
  const runtime = require('../utils/data-runtime')
  const ui = require('../utils/ui-cloud-command')
  const originalRead = ui.adapter.readActive
  ui.adapter.readActive = async () => { productionCloudReads++; return new Promise(() => {}) }
  runtime.setEnvironment('sandbox')
  resetReturnNavigation()
  const exited = await timeout(returnToProduction({ switchEnvironment: ui.switchEnvironment, production: 'production', wxApi: wx }))
  assert.equal(exited.ok, true)
  assert.equal(runtime.environment(), 'production')
  assert.equal(runtime.getDB().students.length, 0)
  assert.equal(store.coachSandboxActiveCache.environment, 'sandbox', 'Sandbox cache is kept separate, never copied into Production')
  assert.equal(launches, 1)
  assert.equal(loading, 0)
  assert.equal(productionCloudReads, 0, 'the explicit exit does not block on Cloud; schedule.onShow will refresh')
  ui.adapter.readActive = async () => { productionCloudReads++; return { ok: true, environment: 'production', datasetId: 'isolated-dataset', revision: 0 } }
  assert.equal((await ui.refreshActiveView()).ok, true, 'Production page can refresh its own active dataset after immediate navigation')
  assert.equal(productionCloudReads, 1)

  // If the cache is damaged, never display it as Production. A failed read
  // keeps the user in Sandbox and releases the button/loading state.
  runtime.setEnvironment('sandbox')
  resetReturnNavigation()
  store.coachCloudActiveCache = { ...store.coachCloudActiveCache, snapshot: { ...snapshot, students: [{ id: 'corrupted' }] } }
  ui.adapter.readActive = async () => ({ ok: false, code: 'PRODUCTION_READ_FAILED' })
  const failed = await timeout(returnToProduction({ switchEnvironment: ui.switchEnvironment, production: 'production', wxApi: wx }))
  assert.equal(failed.ok, false)
  assert.equal(runtime.environment(), 'sandbox')
  assert.equal(loading, 0)
  assert.equal(launches, 1, 'failed exit must not navigate a second time')
  ui.adapter.readActive = async () => new Promise(() => {})
  const bounded = await ui.switchEnvironment('production')
  assert.equal(bounded.code, 'PRODUCTION_READ_TIMEOUT', 'missing valid cache must fail boundedly instead of leaving the exit spinner forever')
  assert.equal(runtime.environment(), 'sandbox')
  ui.adapter.readActive = originalRead
  console.log('sandbox return Production PASS: held Sandbox write, verified Production cache, one navigation')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
