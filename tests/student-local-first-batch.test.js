const assert = require('assert')
const path = require('path')
const { createWorld, copy, settle } = require('./helpers/local-first-world')
const PROJ = path.join(__dirname, '..')
const world = createWorld({ allowMaskedCommands: true })
const empty = () => ({ students: [], bookings: [], incomes: [], sales: [], settings: { renewThreshold: 3, monthlyGoalSessions: 20 }, customExercises: [] })
function setPath(target, key, value) {
  const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
  let node = target
  for (const part of parts.slice(0, -1)) node = node[part]
  node[parts.at(-1)] = copy(value)
}
function page() {
  let definition
  global.Page = value => { definition = value }
  const file = path.join(PROJ, 'pages/students/students.js')
  delete require.cache[require.resolve(file)]
  require(file)
  delete global.Page
  const instance = { data: copy(definition.data), setData(patch) { Object.entries(patch).forEach(([key, value]) => setPath(this.data, key, value)) } }
  Object.keys(definition).forEach(key => { if (typeof definition[key] === 'function') instance[key] = definition[key].bind(instance) })
  return instance
}
function fill(instance, name = '本机秒存假学员') {
  instance.add()
  instance.field({ currentTarget: { dataset: { field: 'name' } }, detail: { value: name } })
  for (const [key, value] of Object.entries({ total: '20', remaining: '17', price: '300', saleAmount: '5800' })) {
    instance.pkg({ currentTarget: { dataset: { i: 0, k: key } }, detail: { value } })
  }
}
async function run() {
  world.seed(empty())
  world.memoryRevision = 0
  const instance = page()
  instance.onShow()
  fill(instance)
  let releaseCloud
  const held = new Promise(resolve => { releaseCloud = resolve })
  const originalExecute = world.adapter.execute
  world.adapter.execute = async (...args) => { await held; return originalExecute(...args) }
  const start = Date.now()
  const first = instance.save(), repeated = instance.save()
  assert.strictEqual(first, repeated, 'double tap shares one UI save task')
  const saved = await Promise.race([first, new Promise((_, reject) => setTimeout(() => reject(new Error('UI waited for Cloud')), 250))])
  assert.equal(saved.ok, true)
  assert.ok(Date.now() - start < 250, 'student save must return before held Cloud response')
  assert.equal(world.snapshot().students.length, 0, 'server was deliberately held')
  assert.equal(world.localDB().students.length, 1)
  assert.equal(world.localDB().students[0].packages.length, 1)
  assert.equal(world.localDB().sales.length, 1)
  assert.equal(world.localDB().sales[0].amount, 5800)
  assert.equal(world.localDB().students[0].packages[0].remaining, 17)
  assert.equal(world.outboxEntries().length, 2, 'both commands must persist before first-frame success')
  const originalIds = world.outboxEntries().map(row => row.requestId)
  assert.equal(world.counters.loading, 0, 'new-student path must not open a blocking cloud spinner')
  world.restartProcess()
  assert.equal(world.localDB().students.length, 1, 'kill/reopen preserves projected member')
  assert.deepEqual(world.outboxEntries().map(row => row.requestId), originalIds)
  releaseCloud()
  world.adapter.execute = originalExecute
  await world.restoreNetwork()
  await settle(25)
  assert.equal(world.snapshot().students.length, 1)
  assert.equal(world.snapshot().students[0].packages.length, 1)
  assert.equal(world.snapshot().sales.length, 1)
  assert.equal(world.snapshot().sales[0].amount, 5800)
  assert.equal(world.snapshot().students[0].packages[0].remaining, 17)
  assert.equal(world.outboxEntries().length, 0)
  assert.equal(world.localDB().students.length, 1)
  assert.equal(world.localDB().sales.length, 1)
  console.log('student local-first durable batch PASS')
}
run().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => world.restoreUi())
