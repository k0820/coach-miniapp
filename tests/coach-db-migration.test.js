const assert = require('assert')
const Module = require('module')
const crypto = require('crypto')
const { transferPlan } = require('../utils/cloud-chunk-transfer')

const stores = new Map()
let currentOpenId = 'openid-a'
let failCollection = ''
let clock = 0
const storeFor = name => {
  if (!stores.has(name)) stores.set(name, new Map())
  return stores.get(name)
}
const matches = (record, filter) => Object.keys(filter).every(key => record && record[key] === filter[key])

function collection(name) {
  const store = storeFor(name)
  return {
    where(filter) {
      const state = { skip: 0, limit: Infinity, order: '' }
      const query = {
        orderBy(field) { state.order = field; return query },
        skip(count) { state.skip = count; return query },
        limit(count) { state.limit = count; return query },
        async get() {
          let data = [...store.values()].filter(record => matches(record, filter))
          if (state.order) data.sort((a, b) => Number(a[state.order] || 0) - Number(b[state.order] || 0))
          return { data: data.slice(state.skip, state.skip + state.limit) }
        },
        async remove() {
          const ids = [...store.entries()].filter(([, record]) => matches(record, filter)).map(([id]) => id)
          ids.forEach(id => store.delete(id))
          return { stats: { removed: ids.length } }
        },
        async update({ data }) {
          const entries = [...store.entries()].filter(([, record]) => matches(record, filter))
          entries.forEach(([id, record]) => store.set(id, { ...record, ...data }))
          return { stats: { updated: entries.length } }
        }
      }
      return query
    },
    doc(id) {
      return {
        async get() { return { data: store.get(id) } },
        async update({ data }) {
          if (!store.has(id)) return { stats: { updated: 0 } }
          store.set(id, { ...store.get(id), ...data })
          return { stats: { updated: 1 } }
        },
        async remove() {
          const removed = store.delete(id) ? 1 : 0
          return { stats: { removed } }
        }
      }
    },
    async add({ data }) {
      if (name === failCollection) throw new Error(`injected ${name} failure`)
      if (store.has(data._id)) throw new Error('duplicate key')
      store.set(data._id, JSON.parse(JSON.stringify(data)))
      return { _id: data._id }
    }
  }
}

const database = {
  collection,
  serverDate: () => `server-${++clock}`,
  async runTransaction(callback) { return callback({ collection }) }
}
const cloudMock = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  getWXContext: () => ({ OPENID: currentOpenId }),
  database: () => database
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudMock
  return originalLoad.call(this, request, parent, isMain)
}
const { main } = require('../cloudfunctions/migrateCoachDBToCloud/index')
Module._load = originalLoad

const coachIdFor = openId => crypto.createHash('sha256').update(`coach:${openId}`).digest('hex').slice(0, 32)
function addCoach(openId) {
  const id = coachIdFor(openId)
  storeFor('coaches').set(id, { _id: id, openId, status: 'active', migrationVersion: 0 })
  return id
}
const snapshot = marker => ({
  students: [{ id: `student-${marker}`, name: '测试', packages: [{ id: `package-${marker}`, type: '常规训练', total: 10, used: 2, remaining: 8, price: 300 }] }],
  bookings: [{ id: `booking-${marker}`, studentId: `student-${marker}`, packageId: `package-${marker}`, status: 'done', items: [{ name: '深蹲', sets: 4, reps: 12 }] }],
  incomes: [{ id: `income-${marker}`, bookingId: `booking-${marker}`, studentId: `student-${marker}`, amount: 300 }],
  sales: [{ id: `sale-${marker}`, source: 'course', date: '2026-08-01', amount: 2800, note: '兼容旧销售无关联 ID' }],
  settings: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 10, salesCommissionRate: 2 },
  customExercises: [{ name: '自定义动作', group: '胸' }],
  futureTopLevelField: { preserved: marker }
})
const ownedCount = (name, owner) => [...storeFor(name).values()].filter(item => item.ownerCoachId === owner).length
async function migrate(local, extras = {}) {
  const plan = transferPlan(local)
  let result = await main({ action: 'start', ...plan, chunks: undefined, ...extras })
  if (!result.ok || result.completed) return result
  const sessionId = result.sessionId
  const status = await main({ action: 'status', sessionId, ...extras })
  const received = new Set(status.receivedChunks || [])
  for (const chunk of plan.chunks) {
    if (received.has(`${chunk.collection}:${chunk.chunkIndex}`)) continue
    result = await main({ action: 'uploadChunk', sessionId, ...chunk, ...extras })
    if (!result.ok) return result
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    result = await main({ action: 'finalize', sessionId, ...extras })
    if (!result.ok || result.completed) return result
    assert.strictEqual(result.continue, true)
  }
  throw new Error('finalize did not complete')
}

async function uploadOnly(local, extras = {}) {
  const plan = transferPlan(local)
  let result = await main({ action: 'start', ...plan, chunks: undefined, ...extras })
  if (!result.ok || result.completed) return result
  for (const chunk of plan.chunks) {
    const uploaded = await main({ action: 'uploadChunk', sessionId: result.sessionId, ...chunk, ...extras })
    if (!uploaded.ok) return uploaded
  }
  return result
}

async function run() {
  const coachA = addCoach('openid-a')
  const localA = snapshot('a')
  const originalA = JSON.stringify(localA)
  let result = await migrate(localA, { ownerCoachId: 'forged', coachId: 'forged', openId: 'openid-b' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.idempotent, false)
  assert.strictEqual(result.verification.valid, true)
  assert.strictEqual(result.summary.students, 1)
  assert.strictEqual(result.summary.packages, 1)
  assert.strictEqual(result.summary.incomeAmount, 300)
  assert.strictEqual(result.summary.salesAmount, 2800)
  assert.strictEqual(JSON.stringify(localA), originalA)

  // 模拟平台超时发生在 customExercises 已写入、但 finalize 进度尚未来得及持久化之后。
  currentOpenId = 'openid-partial-retry'
  const partialOwner = addCoach(currentOpenId)
  const partialLocal = snapshot('partial-retry')
  const partialOriginal = JSON.stringify(partialLocal)
  const started = await uploadOnly(partialLocal)
  assert.strictEqual(started.ok, true)
  let staged = await main({ action: 'finalize', sessionId: started.sessionId })
  assert.strictEqual(staged.stage, 'writing')
  while (!staged.completed && !(staged.collection === 'customExercises')) {
    staged = await main({ action: 'finalize', sessionId: started.sessionId })
    assert.strictEqual(staged.ok, true)
  }
  assert.strictEqual(staged.collection, 'customExercises')
  const customCountBeforeRetry = ownedCount('customExercises', partialOwner)
  const migrationLock = [...storeFor('coach_migrations').values()].find(item => item.ownerCoachId === partialOwner)
  storeFor('coach_migrations').set(migrationLock._id, { ...migrationLock, status: 'writing', finalizeCollectionIndex: 6 })
  staged = await main({ action: 'finalize', sessionId: started.sessionId })
  assert.strictEqual(staged.ok, true)
  assert.strictEqual(staged.reused, customCountBeforeRetry)
  assert.strictEqual(staged.created, 0)
  assert.strictEqual(ownedCount('customExercises', partialOwner), customCountBeforeRetry)
  while (!staged.completed) staged = await main({ action: 'finalize', sessionId: started.sessionId })
  assert.strictEqual(staged.verification.valid, true)
  assert.strictEqual(JSON.stringify(partialLocal), partialOriginal)

  // 同一确定性 _id 若内容不同必须阻止，不能覆盖或忽略冲突。
  currentOpenId = 'openid-conflict-retry'
  const conflictOwner = addCoach(currentOpenId)
  const conflictLocal = snapshot('conflict-retry')
  const conflictStart = await uploadOnly(conflictLocal)
  await main({ action: 'finalize', sessionId: conflictStart.sessionId })
  let conflictStage
  do { conflictStage = await main({ action: 'finalize', sessionId: conflictStart.sessionId }) } while (conflictStage.ok && conflictStage.collection !== 'customExercises')
  const existingCustom = [...storeFor('customExercises').values()].find(item => item.ownerCoachId === conflictOwner)
  storeFor('customExercises').set(existingCustom._id, { ...existingCustom, data: { name: '被篡改内容' } })
  const conflictLock = [...storeFor('coach_migrations').values()].find(item => item.ownerCoachId === conflictOwner)
  storeFor('coach_migrations').set(conflictLock._id, { ...conflictLock, status: 'writing', finalizeCollectionIndex: 6 })
  const conflictResult = await main({ action: 'finalize', sessionId: conflictStart.sessionId })
  assert.strictEqual(conflictResult.ok, false)
  assert.strictEqual(conflictResult.code, 'MIGRATION_DOCUMENT_CONFLICT')
  assert.strictEqual(storeFor('customExercises').get(existingCustom._id).data.name, '被篡改内容')
  currentOpenId = 'openid-a'
  assert.strictEqual(storeFor('coaches').get(coachA).migrationVersion, 1)
  assert.deepStrictEqual(storeFor('sales').values().next().value.data, localA.sales[0])

  const countsBefore = Object.fromEntries(['students','packages','bookings','incomes','sales','settings','customExercises'].map(name => [name, ownedCount(name, coachA)]))
  result = await migrate(localA)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.idempotent, true)
  assert.deepStrictEqual(Object.fromEntries(Object.keys(countsBefore).map(name => [name, ownedCount(name, coachA)])), countsBefore)

  const changed = snapshot('changed')
  result = await migrate(changed)
  assert.strictEqual(result.code, 'DIFFERENT_CLOUD_DATA')
  assert.deepStrictEqual(Object.fromEntries(Object.keys(countsBefore).map(name => [name, ownedCount(name, coachA)])), countsBefore)

  currentOpenId = 'openid-b'
  const coachB = addCoach('openid-b')
  result = await migrate(snapshot('b'), { ownerCoachId: coachA, documentId: [...storeFor('students').keys()][0] })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(ownedCount('students', coachA), 1)
  assert.strictEqual(ownedCount('students', coachB), 1)
  assert.ok([...storeFor('students').values()].filter(item => item.ownerCoachId === coachB).every(item => item.studentId === 'student-b'))

  currentOpenId = 'openid-c'
  const coachC = addCoach('openid-c')
  failCollection = 'sales'
  const localC = snapshot('c')
  const originalC = JSON.stringify(localC)
  result = await migrate(localC)
  failCollection = ''
  assert.strictEqual(result.ok, false)
  assert.strictEqual(JSON.stringify(localC), originalC)
  assert.strictEqual(storeFor('coaches').get(coachC).migrationVersion, 0)
  assert.strictEqual(ownedCount('students', coachC), 1)
  assert.strictEqual(ownedCount('sales', coachC), 0)
  const resumableMigration = [...storeFor('coach_migrations').values()].find(item => item.ownerCoachId === coachC)
  assert.strictEqual(resumableMigration.status, 'writing')
  result = await migrate(localC)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.verification.valid, true)
  assert.strictEqual(storeFor('coaches').get(coachC).migrationVersion, 1)

  const source = require('fs').readFileSync(require('path').join(__dirname, '../cloudfunctions/migrateCoachDBToCloud/index.js'), 'utf8')
  assert.ok(source.includes('cloud.getWXContext()'))
  assert.ok(!/event\.(OPENID|openId|coachId|ownerCoachId|documentId)/.test(source))
  console.log('coach-db-migration tests: PASS (partial-timeout retry and conflict protection included)')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
