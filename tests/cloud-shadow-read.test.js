const assert = require('assert')
const crypto = require('crypto')
const Module = require('module')
const { migrationMetadata } = require('../utils/cloud-migration')
const { readMyCoachCloudSnapshot, compareCloudAndLocal } = require('../utils/cloud-shadow-read')

const stores = new Map(), mutations = []
let currentOpenId = 'openid-a'
const storeFor = name => { if (!stores.has(name)) stores.set(name, []); return stores.get(name) }
const matches = (record, filter) => Object.keys(filter).every(key => record[key] === filter[key])
function collection(name) {
  return {
    where(filter) {
      const state = { skip: 0, limit: Infinity, orders: [] }
      const query = {
        orderBy(field, direction) { state.orders.push([field, direction]); return query },
        skip(value) { state.skip = value; return query },
        limit(value) { state.limit = value; return query },
        async get() {
          let data = storeFor(name).filter(item => matches(item, filter)).map(item => JSON.parse(JSON.stringify(item)))
          data.sort((a, b) => { for (const [field, direction] of state.orders) { const result = String(a[field] || '').localeCompare(String(b[field] || '')); if (result) return direction === 'desc' ? -result : result } return 0 })
          return { data: data.slice(state.skip, state.skip + state.limit) }
        }
      }
      return query
    }
  }
}
const cloudMock = { DYNAMIC_CURRENT_ENV: 'test', init() {}, getWXContext: () => ({ OPENID: currentOpenId }), database: () => ({ collection }) }
const originalLoad = Module._load
Module._load = function (request, parent, isMain) { if (request === 'wx-server-sdk') return cloudMock; return originalLoad.call(this, request, parent, isMain) }
const { main } = require('../cloudfunctions/readMyCoachCloudData/index')
Module._load = originalLoad

const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const coachIdFor = openId => digest(`coach:${openId}`).slice(0, 32)
const docId = (name, owner, id) => digest(`${name}:${owner}:${id}`).slice(0, 32)
function snapshot(marker, large = false) {
  return {
    students: [{ id: `s-${marker}`, name: `学员${marker}`, packages: [{ id: `p-${marker}-1`, saleId: `sale-${marker}`, total: 10 }, { id: `p-${marker}-2`, total: 5 }] }],
    bookings: [{ id: `b-${marker}-1`, studentId: `s-${marker}`, packageId: `p-${marker}-1`, status: 'done', items: [{ name: '动作1' }] }, { id: `b-${marker}-2`, studentId: `s-${marker}`, packageId: `p-${marker}-2`, status: 'booked', notes: large ? '长记录🙂'.repeat(20000) : '' }],
    incomes: [{ id: `i-${marker}`, bookingId: `b-${marker}-1`, studentId: `s-${marker}`, amount: 300 }],
    sales: [{ id: `sale-${marker}`, studentId: `s-${marker}`, packageId: `p-${marker}-1`, amount: 2800 }],
    settings: { monthlyGoalSessions: 40 },
    customExercises: [{ name: `动作${marker}`, group: '胸' }],
    futureField: { marker }
  }
}
function seed(openId, source) {
  const owner = coachIdFor(openId), migrationId = `migration-${owner}`, meta = migrationMetadata(source)
  storeFor('coaches').push({ _id: owner, openId, status: 'active' })
  storeFor('coach_migrations').push({ _id: `lock-${owner}`, ownerCoachId: owner, migrationId, migrationVersion: 1, status: 'completed', ...meta })
  source.students.forEach((student, studentSortIndex) => {
    const copy = JSON.parse(JSON.stringify(student)), packages = copy.packages; delete copy.packages
    storeFor('students').push({ _id: docId('students', owner, student.id), ownerCoachId: owner, migrationId, studentId: student.id, sortIndex: studentSortIndex, data: copy })
    packages.forEach((pkg, sortIndex) => storeFor('packages').push({ _id: docId('packages', owner, pkg.id), ownerCoachId: owner, migrationId, packageId: pkg.id, studentId: student.id, studentSortIndex, sortIndex, data: pkg }))
  })
  const seedList = (name, idName) => source[name].forEach((data, sortIndex) => storeFor(name).push({ _id: docId(name, owner, data.id || sortIndex), ownerCoachId: owner, migrationId, [idName]: data.id || `legacy-${sortIndex}`, studentId: data.studentId || '', packageId: data.packageId || '', bookingId: data.bookingId || '', sortIndex, data }))
  seedList('bookings', 'bookingId'); seedList('incomes', 'incomeId'); seedList('sales', 'saleId'); seedList('customExercises', 'customExerciseId')
  storeFor('settings').push({ _id: docId('settings', owner, 'settings'), ownerCoachId: owner, migrationId, sortIndex: 0, data: source.settings, rootExtras: { futureField: source.futureField } })
  return owner
}

async function run() {
  const localA = snapshot('A', true), localB = snapshot('B')
  const ownerA = seed('openid-a', localA), ownerB = seed('openid-b', localB)
  const rpcSizes = []
  const call = async (name, data) => {
    assert.strictEqual(name, 'readMyCoachCloudData')
    const result = await main({ ...data, ownerCoachId: ownerB, coachId: ownerB, openId: 'openid-b', documentId: 'forged' })
    rpcSizes.push(Buffer.byteLength(JSON.stringify(result), 'utf8'))
    return result
  }
  const before = JSON.stringify(localA)
  const readA = await readMyCoachCloudSnapshot({ call })
  assert.strictEqual(readA.ok, true)
  assert.deepStrictEqual(readA.snapshot, localA)
  const comparison = compareCloudAndLocal(readA.snapshot, localA, readA.metadata)
  assert.strictEqual(comparison.cloudIntegrity, true)
  assert.strictEqual(comparison.localMatchesCloud, true)
  assert.strictEqual(comparison.orderMatches, true)
  assert.strictEqual(comparison.relationMatches, true)
  assert.ok(rpcSizes.every(size => size < 80 * 1024))
  assert.strictEqual(JSON.stringify(localA), before)
  assert.ok(!mutations.length)

  currentOpenId = 'openid-b'
  const readB = await readMyCoachCloudSnapshot({ call: async (name, data) => main({ ...data, ownerCoachId: ownerA }) })
  assert.deepStrictEqual(readB.snapshot, localB)
  assert.notDeepStrictEqual(readB.snapshot, localA)

  const changed = JSON.parse(JSON.stringify(localB)); changed.sales[0].amount++
  const difference = compareCloudAndLocal(readB.snapshot, changed, readB.metadata)
  assert.strictEqual(difference.cloudIntegrity, true)
  assert.strictEqual(difference.localMatchesCloud, false)
  assert.ok(difference.summary.localDifferences.some(item => item.key === 'salesAmount'))

  const source = require('fs').readFileSync(require('path').join(__dirname, '../cloudfunctions/readMyCoachCloudData/index.js'), 'utf8')
  assert.ok(source.includes('cloud.getWXContext().OPENID'))
  assert.ok(!/event\.(OPENID|openId|coachId|ownerCoachId|documentId)/.test(source))
  assert.ok(!/db\.collection\([^\n]+\)\.(add|update|remove|set)\(/.test(source))
  assert.ok(!/\.doc\([^\n]+\)\.(update|remove|set)\(/.test(source))
  console.log('cloud shadow read tests: PASS (owner isolation, pagination, large fragment, exact rebuild, detailed comparison, zero writes)')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
