const assert = require('assert')
const { buildCandidateDataset, normalizeSnapshot, integrity } = require('../utils/candidate-dataset')
const { buildCandidateUploadPlan, CandidateStagingMock, DEFAULT_RPC_LIMIT, PHYSICAL_COLLECTIONS, deriveCandidateDatasetId } = require('../utils/candidate-staging')

function source(marker = 'a') {
  const bookings = [], incomes = []
  for (let index = 0; index < 130; index++) {
    const deleted = index === 0, studentId = deleted ? `deleted-${marker}` : `student-${marker}`, packageId = deleted ? `package-deleted-${marker}` : `package-${marker}`
    bookings.push({ id: `booking-${marker}-${index}`, studentId, studentName: deleted ? '已删学员' : '张三', packageId, status: 'done', typeName: '常规训练', items: index === 1 ? [{ name: '深蹲', notes: '大记录'.repeat(25000) }, { name: '卧推' }] : [], notes: `n-${index}`, summary: `s-${index}` })
    incomes.push({ id: `income-${marker}-${index}`, bookingId: `booking-${marker}-${index}`, studentId, amount: 300 })
  }
  return {
    students: [
      { id: `student-${marker}`, name: '张三', packages: [{ id: `package-${marker}`, saleId: `sale-${marker}`, type: '常规训练', total: 200, used: 129, remaining: 60 }] },
      { id: `deleted-${marker}`, name: '已删学员', status: 'deleted', packages: [{ id: `package-deleted-${marker}`, saleId: `sale-deleted-${marker}`, type: '常规训练', total: 10, used: 1, remaining: 0, status: 'reversed' }] }
    ],
    bookings, incomes,
    sales: [
      { id: `sale-${marker}`, source: 'course', studentId: `student-${marker}`, packageId: `package-${marker}`, quantity: 200, unitPrice: 300, amount: 58000 },
      { id: `sale-deleted-${marker}`, source: 'course', studentId: `deleted-${marker}`, packageId: `package-deleted-${marker}`, quantity: 10, unitPrice: 300, amount: 3000, status: 'reversed' },
      { id: `manual-${marker}`, source: 'manual', amount: 88, date: '2026-09-14' }
    ],
    settings: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 10, salesCommissionRate: 2 },
    customExercises: [{ id: `exercise-${marker}`, name: '自定义动作' }]
  }
}
function expectCode(fn, code) { assert.throws(fn, error => error && error.code === code) }
function candidateFor(local, owner) {
  const sourceIntegrity = integrity(normalizeSnapshot(local)), datasetId = deriveCandidateDatasetId(owner, sourceIntegrity.checksum)
  return buildCandidateDataset(local, { trustedOwnerCoachId: owner, trustedDatasetId: datasetId })
}

function uploadAll(store, owner, plan, from = 0) { for (let index = from; index < plan.chunks.length; index++) store.upload(owner, plan.chunks[index]) }
function materializeAll(store, owner, datasetId) { Object.keys(PHYSICAL_COLLECTIONS).forEach(name => store.materializeCollection(owner, datasetId, name)) }

function run() {
  const local = source(), original = JSON.stringify(local), owner = 'coach-a'
  const candidate = candidateFor(local, owner), datasetId = candidate.datasetId
  const plan = buildCandidateUploadPlan(candidate)
  assert.ok(plan.chunks.length > 8)
  assert.ok(plan.chunks.every(chunk => chunk.rpcByteSize <= DEFAULT_RPC_LIMIT))
  assert.ok(plan.chunks.some(chunk => chunk.entries.some(entry => entry.kind === 'fragment')))

  const store = new CandidateStagingMock()
  store.heads.set(owner, { activeDatasetId: 'active-old' })
  store.start(owner, candidate, plan)
  const forgedCandidate = buildCandidateDataset(local, { trustedOwnerCoachId: owner, trustedDatasetId: 'client-forged' })
  expectCode(() => store.start(owner, forgedCandidate, buildCandidateUploadPlan(forgedCandidate)), 'UNTRUSTED_CANDIDATE_SCOPE')
  const middle = Math.floor(plan.chunks.length / 2)
  uploadAll(store, owner, { chunks: plan.chunks.slice(0, middle) })
  expectCode(() => store.materializeCollection(owner, datasetId, 'bookings'), 'CANDIDATE_CHUNKS_MISSING')
  uploadAll(store, owner, plan, middle)
  // 网络重试同一 chunk 只复用，不重复写。
  assert.strictEqual(store.upload(owner, plan.chunks[0]).reused, true)
  const conflictingChunk = { ...plan.chunks[0], entries: plan.chunks[0].entries.concat({ kind: 'record', recordKey: 'x', json: '{}' }) }
  expectCode(() => store.upload(owner, conflictingChunk), 'CANDIDATE_CHUNK_INTEGRITY_FAILED')

  materializeAll(store, owner, datasetId)
  const reused = store.materializeCollection(owner, datasetId, 'students')
  assert.ok(reused.reused > 0 && reused.created === 0)
  const result = store.verify(owner, datasetId, local)
  assert.strictEqual(result.valid, true)
  assert.strictEqual(result.integrity.checksum, candidate.integrity.checksum)
  assert.strictEqual(result.integrity.byteSize, candidate.integrity.byteSize)
  assert.deepStrictEqual(result.rebuilt, candidate.normalizedSnapshot)
  assert.deepStrictEqual(result.rebuilt.bookings[1].items.map(item => item.name), ['深蹲', '卧推'])
  assert.strictEqual(store.business.students.size, 1)
  assert.strictEqual(store.business.studentTombstones.size, 1)
  assert.strictEqual(store.heads.get(owner).activeDatasetId, 'active-old')
  assert.strictEqual(store.revisions.size, 0)
  assert.strictEqual(JSON.stringify(local), original)

  // 开始后 source 发生变化：不得标记 verified。
  const changedStore = new CandidateStagingMock(), changedCandidate = candidateFor(local, 'coach-changed'), changedPlan = buildCandidateUploadPlan(changedCandidate)
  changedStore.start('coach-changed', changedCandidate, changedPlan); uploadAll(changedStore, 'coach-changed', changedPlan); materializeAll(changedStore, 'coach-changed', changedCandidate.datasetId)
  const changed = source(); changed.bookings[0].notes = '迁移期间改动'
  expectCode(() => changedStore.verify('coach-changed', changedCandidate.datasetId, changed), 'SOURCE_CHANGED_DURING_MIGRATION')
  assert.strictEqual(changedStore.datasets.get(`coach-changed:${changedCandidate.datasetId}`).status, 'candidate')
  assert.strictEqual(changedStore.datasets.get(`coach-changed:${changedCandidate.datasetId}`).integrityStatus, 'pending')

  // 确定性文档已存在但内容不同：精确冲突，禁止覆盖。
  const conflictStore = new CandidateStagingMock(), conflictCandidate = candidateFor(local, 'coach-conflict'), conflictPlan = buildCandidateUploadPlan(conflictCandidate)
  conflictStore.start('coach-conflict', conflictCandidate, conflictPlan); uploadAll(conflictStore, 'coach-conflict', conflictPlan); materializeAll(conflictStore, 'coach-conflict', conflictCandidate.datasetId)
  const firstStudent = conflictStore.business.students.values().next().value; firstStudent.data.name = '被篡改'
  expectCode(() => conflictStore.materializeCollection('coach-conflict', conflictCandidate.datasetId, 'students'), 'CANDIDATE_DOCUMENT_CONFLICT')

  // owner + dataset 双隔离，精确清理不碰其他 candidate。
  const candidateB = candidateFor(source('b'), 'coach-b'), planB = buildCandidateUploadPlan(candidateB)
  conflictStore.start('coach-b', candidateB, planB); uploadAll(conflictStore, 'coach-b', planB); materializeAll(conflictStore, 'coach-b', candidateB.datasetId)
  const countB = [...conflictStore.business.bookings.values()].filter(row => row.ownerCoachId === 'coach-b' && row.datasetId === candidateB.datasetId).length
  conflictStore.cleanup('coach-conflict', conflictCandidate.datasetId)
  assert.strictEqual([...conflictStore.business.bookings.values()].filter(row => row.ownerCoachId === 'coach-b' && row.datasetId === candidateB.datasetId).length, countB)
  assert.ok(conflictStore.datasets.has(`coach-b:${candidateB.datasetId}`))

  console.log('candidate-staging tests: PASS (chunk/retry/conflict/readback/source-lock/head isolation/cleanup)')
}

run()
