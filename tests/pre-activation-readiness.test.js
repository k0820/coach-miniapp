const assert = require('assert')
const { createService, coachIdFor, fixedId } = require('../cloudfunctions/checkCoachCandidateReadiness/service')
const { runPreActivationReadiness } = require('../utils/pre-activation-readiness')
const { fingerprintSnapshot } = require('../utils/activation-readiness')

const clone = value => JSON.parse(JSON.stringify(value))
const fixture = () => ({
  students: [{ id: 's1', name: '张三', packages: [{ id: 'p1', saleId: 'sale1', type: '常规训练', total: 10, used: 1, remaining: 9, price: 300, status: 'active' }] }],
  bookings: [{ id: 'b1', studentId: 's1', studentName: '张三', packageId: 'p1', typeName: '常规训练', status: 'done', price: 300, items: [] }],
  incomes: [{ id: 'i1', bookingId: 'b1', studentId: 's1', amount: 300 }],
  sales: [{ id: 'sale1', source: 'course', status: 'active', studentId: 's1', packageId: 'p1', typeName: '常规训练', quantity: 10, unitPrice: 300, amount: 2800, date: '2026-09-01' }],
  settings: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 10, salesCommissionRate: 2 },
  customExercises: []
})

function mockDb(seed) {
  let writes = 0
  return {
    get writes() { return writes },
    collection(name) {
      return {
        where(filter) {
          return { limit() { return { async get() { return { data: (seed[name] || []).filter(row => Object.entries(filter).every(([key, value]) => row[key] === value)).slice(0, 1).map(clone) } } } } }
        },
        add() { writes += 1 }, doc() { return { set() { writes += 1 }, update() { writes += 1 }, remove() { writes += 1 } } }
      }
    }
  }
}

async function main() {
  const source = fixture(), fingerprint = fingerprintSnapshot(source), openId = 'openid-a', owner = coachIdFor(openId), datasetId = 'candidate-real'
  const seed = {
    coaches: [{ _id: owner, openId, status: 'active' }],
    coach_datasets: [{ _id: 'candidate-doc', ownerCoachId: owner, datasetId, status: 'verified', integrityStatus: 'verified', sourceChecksum: fingerprint.checksum, sourceByteSize: fingerprint.byteSize, sourceSummary: fingerprint.summary }],
    coach_data_heads: [{ _id: fixedId('coach-data-head', owner), ownerCoachId: owner, activeDatasetId: null }]
  }
  const db = mockDb(seed), service = createService({ db, getOpenId: () => openId })
  const result = await runPreActivationReadiness({ readSource: () => clone(source), callCloud: (name, data) => { assert.equal(name, 'checkCoachCandidateReadiness'); return service(data) } })
  assert.equal(result.readyForActivation, true); assert.equal(result.sourceMatch, true); assert.equal(result.byteSizeMatch, true); assert.equal(result.summaryMatch, true); assert.deepEqual(result.summaryDiff, {}); assert.equal(result.activeDatasetId, null); assert.equal(db.writes, 0)

  const reordered = await runPreActivationReadiness({ readSource: () => clone(source), callCloud: async (name, data) => {
    const response = await service(data), entries = Object.entries(response.candidateSummary).reverse()
    return { ...response, candidateSummary: Object.fromEntries(entries) }
  } })
  assert.equal(reordered.summaryMatch, true); assert.equal(reordered.readyForActivation, true); assert.deepEqual(reordered.summaryDiff, {})

  const realDifference = await runPreActivationReadiness({ readSource: () => clone(source), callCloud: async (name, data) => {
    const response = await service(data)
    return { ...response, candidateSummary: { ...response.candidateSummary, sales: response.candidateSummary.sales + 1 } }
  } })
  assert.equal(realDifference.summaryMatch, false); assert.equal(realDifference.readyForActivation, false)
  assert.deepEqual(realDifference.summaryDiff.sales, { current: fingerprint.summary.sales, candidate: fingerprint.summary.sales + 1 })

  const changed = fixture(); changed.students[0].phone = '13800138000'
  const blocked = await runPreActivationReadiness({ readSource: () => changed, callCloud: (name, data) => service(data) })
  assert.equal(blocked.code, 'SOURCE_CHANGED_BEFORE_ACTIVATION'); assert.equal(blocked.readyForActivation, false); assert.equal(db.writes, 0)

  seed.coach_data_heads[0].activeDatasetId = datasetId
  const active = await runPreActivationReadiness({ readSource: () => fixture(), callCloud: (name, data) => service(data) })
  assert.equal(active.readyForActivation, false); assert.equal(active.candidateStatus, 'verified'); assert.equal(active.activeDatasetId, datasetId)

  const forged = await service({ action: 'check', sourceChecksum: fingerprint.checksum, datasetId: datasetId })
  assert.equal(forged.code, 'FORBIDDEN_IDENTITY_INPUT'); assert.equal(db.writes, 0)
  console.log('pre-activation readiness tests passed (trusted owner, source fingerprint, inactive candidate, zero writes)')
}

main().catch(error => { console.error(error); process.exit(1) })
