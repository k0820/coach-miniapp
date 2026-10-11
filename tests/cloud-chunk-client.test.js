const assert = require('assert')
const { uploadSnapshotInChunks, RPC_SAFE_MAX_BYTES, rpcDataByteSize, payloadTooLarge } = require('../utils/cloud-chunk-client')
const local = { students: [], bookings: [], incomes: [], sales: [], settings: {}, customExercises: [] }
async function run() {
  const calls = [], received = new Set(['students:0', 'packages:0'])
  const call = async (name, data) => {
    calls.push({ name, data })
    if (data.action === 'start') return { ok: true, sessionId: 's1' }
    if (data.action === 'status') return { ok: true, receivedChunks: [...received] }
    if (data.action === 'uploadChunk') { received.add(`${data.collection}:${data.chunkIndex}`); return { ok: true } }
    if (data.action === 'finalize') return { ok: true, completed: true, backupVersion: 1, checksum: 'ok' }
    if (data.action === 'abort') return { ok: true }
  }
  const before = JSON.stringify(local)
  const result = await uploadSnapshotInChunks({ functionName: 'backupCoachDB', mode: 'backup', snapshot: local, expectedBackupVersion: 0, call })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(calls.filter(item => item.data.action === 'uploadChunk').length, 5)
  assert.ok(calls.every(item => !Object.prototype.hasOwnProperty.call(item.data, 'snapshot')))
  assert.strictEqual(JSON.stringify(local), before)

  const stagedCalls = [], stages = [
    { ok: true, completed: false, continue: true, stage: 'writing', finalizeCollectionIndex: 0 },
    { ok: true, completed: false, continue: true, stage: 'writing', collection: 'students', finalizeCollectionIndex: 1 },
    { ok: true, completed: false, continue: true, stage: 'verifying', collection: 'customExercises', finalizeCollectionIndex: 7 },
    { ok: true, completed: true, migrationId: 'staged-session', verification: { valid: true } }
  ]
  const stagedResult = await uploadSnapshotInChunks({
    functionName: 'migrateCoachDBToCloud', mode: 'migration', snapshot: local,
    call: async (name, data) => {
      stagedCalls.push(data.action)
      if (data.action === 'start') return { ok: true, sessionId: 'staged-session' }
      if (data.action === 'status') return { ok: true, receivedChunks: ['students:0','packages:0','bookings:0','incomes:0','sales:0','settings:0','customExercises:0'] }
      if (data.action === 'finalize') return stages.shift()
      return { ok: true }
    }
  })
  assert.strictEqual(stagedResult.ok, true)
  assert.strictEqual(stagedCalls.filter(action => action === 'finalize').length, 4)
  assert.ok(!stagedCalls.includes('abort'))

  const failedCalls = []
  const failedCall = async (name, data) => {
    failedCalls.push(data.action)
    if (data.action === 'start') return { ok: true, sessionId: 's2' }
    if (data.action === 'status') return { ok: true, receivedChunks: [] }
    if (data.action === 'uploadChunk') return { ok: false, code: 'CHUNK_INTEGRITY_FAILED' }
    if (data.action === 'abort') return { ok: true }
  }
  const failed = await uploadSnapshotInChunks({ functionName: 'backupCoachDB', mode: 'backup', snapshot: local, expectedBackupVersion: 0, call: failedCall })
  assert.strictEqual(failed.code, 'CHUNK_INTEGRITY_FAILED')
  assert.ok(failedCalls.includes('abort'))
  assert.strictEqual(JSON.stringify(local), before)

  const historical = {
    students: [{ id: 'legacy-student', name: '旧学员', packages: [{ id: 'legacy-package', type: 'normal', total: 10, used: 2 }] }],
    bookings: [{ id: 'legacy-booking', studentId: 'legacy-student', status: 'done', items: [{ name: '深蹲', sets: 4, reps: 12 }] }],
    incomes: [{ id: 'legacy-income', studentId: 'legacy-student', amount: 300 }],
    sales: [{ id: 'legacy-sale', source: 'course', date: '2026-06-01', amount: 3000 }],
    settings: {},
    customExercises: [{ name: '旧动作', group: '腿' }]
  }
  const historicalBefore = JSON.stringify(historical), historicalChunks = []
  const historicalCall = async (name, data) => {
    if (data.action === 'start') return { ok: true, sessionId: 'historical-session' }
    if (data.action === 'status') return { ok: true, receivedChunks: [] }
    if (data.action === 'uploadChunk') { historicalChunks.push(data); return { ok: true } }
    if (data.action === 'finalize') return { ok: true, completed: true, backupVersion: 6 }
    return { ok: true }
  }
  const historicalResult = await uploadSnapshotInChunks({ functionName: 'backupCoachDB', mode: 'backup', snapshot: historical, expectedBackupVersion: 5, call: historicalCall })
  assert.strictEqual(historicalResult.ok, true)
  assert.ok(historicalChunks.length >= 7)
  assert.strictEqual(JSON.stringify(historical), historicalBefore)
  assert.deepStrictEqual(historical.sales[0], { id: 'legacy-sale', source: 'course', date: '2026-06-01', amount: 3000 })

  const outdated = await uploadSnapshotInChunks({
    functionName: 'backupCoachDB', mode: 'backup', snapshot: historical, expectedBackupVersion: 5,
    call: async () => ({ ok: false, message: '备份内容不是有效的 coachDB。' })
  })
  assert.strictEqual(outdated.code, 'CLOUD_FUNCTION_OUTDATED')
  assert.strictEqual(JSON.stringify(historical), historicalBefore)

  const large = JSON.parse(JSON.stringify(historical))
  large.bookings[0].notes = '\\\"训练🙂'.repeat(900000)
  assert.ok(Buffer.byteLength(JSON.stringify(large), 'utf8') > 6 * 1024 * 1024)
  const largeBefore = JSON.stringify(large), rpcCalls = []
  const largeCall = async (name, data) => {
    rpcCalls.push(data)
    if (data.action === 'start') return { ok: true, sessionId: 'large-session' }
    if (data.action === 'status') return { ok: true, receivedChunks: [] }
    if (data.action === 'uploadChunk') return { ok: true }
    if (data.action === 'finalize') return { ok: true, completed: true, backupVersion: 7 }
    return { ok: true }
  }
  const largeResult = await uploadSnapshotInChunks({ functionName: 'backupCoachDB', mode: 'backup', snapshot: large, expectedBackupVersion: 6, call: largeCall })
  assert.strictEqual(largeResult.ok, true)
  assert.ok(rpcCalls.length > 100)
  assert.ok(rpcCalls.every(data => rpcDataByteSize(data) <= RPC_SAFE_MAX_BYTES))
  assert.ok(rpcCalls.every(data => !payloadTooLarge(data)))
  assert.strictEqual(JSON.stringify(large), largeBefore)
  console.log('cloud chunk client tests: PASS (full RPC envelope capped, >6MB snapshot, legacy shape, resume, no full snapshot, abort, local immutable)')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
