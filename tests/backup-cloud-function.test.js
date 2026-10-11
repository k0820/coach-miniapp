const assert = require('assert')
const Module = require('module')
const crypto = require('crypto')
const { transferPlan, rebuildSnapshot, verifyRebuilt, DEFAULT_MAX_CHUNK_BYTES, chunkJson } = require('../utils/cloud-chunk-transfer')
const stores = new Map(), storeFor = name => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name) }
let openId = 'openid-a', clock = 0
const matches = (item, filter) => Object.keys(filter).every(key => item && item[key] === filter[key])
function collection(name) {
  const store = storeFor(name)
  return {
    where(filter) {
      const state = { skip: 0, limit: Infinity }
      const query = {
        skip(value) { state.skip = value; return query }, limit(value) { state.limit = value; return query },
        async get() { return { data: [...store.values()].filter(item => matches(item, filter)).slice(state.skip, state.skip + state.limit) } },
        async update({ data }) { const found = [...store.entries()].filter(([, item]) => matches(item, filter)); found.forEach(([id, item]) => store.set(id, { ...item, ...data })); return { stats: { updated: found.length } } }
      }; return query
    },
    doc(id) { return { async remove() { const removed = store.delete(id) ? 1 : 0; return { stats: { removed } } } } },
    async add({ data }) { if (store.has(data._id)) throw new Error('duplicate'); store.set(data._id, JSON.parse(JSON.stringify(data))); return { _id: data._id } }
  }
}
const cloudMock = { DYNAMIC_CURRENT_ENV: 'test', init() {}, getWXContext: () => ({ OPENID: openId }), database: () => ({ collection, serverDate: () => `server-${++clock}` }) }
const originalLoad = Module._load
Module._load = function (request, parent, main) { if (request === 'wx-server-sdk') return cloudMock; return originalLoad.call(this, request, parent, main) }
const { main } = require('../cloudfunctions/backupCoachDB/index')
const { main: verifyMain } = require('../cloudfunctions/verifyCoachDBBackup/index')
Module._load = originalLoad
const snapshot = () => ({
  students: [{ id: 's1', name: '测试', packages: [{ id: 'p1', total: 10, remaining: 8, price: 300 }] }],
  bookings: [
    { id: 'b0', studentId: 's1', packageId: 'p1', status: 'done', items: [] },
    { id: 'b1', studentId: 's1', packageId: 'p1', status: 'done', items: [{ name: '深蹲', sets: 4, reps: 12 }], notes: '长备注🙂'.repeat(550000), summary: '总结'.repeat(20000) },
    { id: 'b2', studentId: 's1', packageId: 'p1', status: 'booked', items: [] }
  ],
  incomes: [{ id: 'i1', bookingId: 'b1', amount: 300 }],
  sales: [{ id: 'sale1', studentId: 's1', packageId: 'p1', amount: 2800 }],
  settings: { monthlyGoalSessions: 40 },
  customExercises: [{ name: '动作', group: '胸' }],
  futureTopLevelField: { preserved: true }
})
const legacyId = id => crypto.createHash('sha256').update(`coach-db-backup:${id}`).digest('hex').slice(0, 32)
const reverseObjectKeys = value => Array.isArray(value) ? value.map(reverseObjectKeys) : value && typeof value === 'object' ? Object.keys(value).reverse().reduce((out, key) => { out[key] = reverseObjectKeys(value[key]); return out }, {}) : value
async function run() {
  const local = snapshot(), original = JSON.stringify(local), plan = transferPlan(local)
  assert.ok(plan.byteSize > 6 * 1024 * 1024)
  assert.ok(plan.chunks.length > 7)
  assert.ok(plan.chunks.every(chunk => chunk.chunkByteSize <= DEFAULT_MAX_CHUNK_BYTES))
  assert.ok(plan.chunks.some(chunk => chunk.collection === 'bookings' && chunk.records.some(item => item.kind === 'fragment')))
  assert.deepStrictEqual(rebuildSnapshot(plan.chunks), local)
  assert.strictEqual(verifyRebuilt(rebuildSnapshot(plan.chunks), plan).ok, true)
  assert.strictEqual(JSON.stringify(local), original)
  storeFor('coach_db_backups').set(legacyId(openId), { _id: legacyId(openId), ownerOpenId: openId, backupVersion: 5 })
  let legacy = await verifyMain({ action: 'metadata' })
  assert.strictEqual(legacy.ok, true)
  assert.strictEqual(legacy.backupFormatVersion, 1)
  assert.strictEqual(legacy.backupVersion, 5)
  let result = await main({ action: 'start', expectedBackupVersion: 5, ...plan, chunks: undefined, OPENID: 'forged' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.backupVersion, 6)
  const sessionId = result.sessionId
  for (let i = 0; i < plan.chunks.length - 1; i++) {
    const transported = { ...plan.chunks[i], records: reverseObjectKeys(plan.chunks[i].records) }
    assert.strictEqual((await main({ action: 'uploadChunk', sessionId, ...transported })).ok, true)
  }
  result = await main({ action: 'finalize', sessionId })
  assert.strictEqual(result.code, 'CHUNKS_MISSING')
  assert.strictEqual([...storeFor('coach_backup_manifests').values()][0].status, 'uploading')
  const last = plan.chunks[plan.chunks.length - 1]
  assert.strictEqual((await main({ action: 'uploadChunk', sessionId, ...last })).ok, true)
  assert.strictEqual((await main({ action: 'uploadChunk', sessionId, ...last })).reused, true)
  assert.strictEqual((await main({ action: 'uploadChunk', sessionId, ...last, chunkChecksum: '0'.repeat(64) })).code, 'CHUNK_INTEGRITY_FAILED')
  const changed = { ...last, records: [{ kind: 'record', recordKey: 'bad', json: '{}' }] }
  changed.chunkChecksum = crypto.createHash('sha256').update(chunkJson(changed.records)).digest('hex')
  changed.chunkByteSize = Buffer.byteLength(chunkJson(changed.records))
  assert.strictEqual((await main({ action: 'uploadChunk', sessionId, ...changed })).code, 'CHUNK_CONFLICT')
  const manifestStore = storeFor('coach_backup_manifests'), manifest = manifestStore.get(sessionId), originalChecksum = manifest.checksum
  manifestStore.set(sessionId, { ...manifest, checksum: 'f'.repeat(64) })
  result = await main({ action: 'finalize', sessionId })
  assert.strictEqual(result.code, 'FINAL_VERIFY_FAILED')
  assert.strictEqual(result.differences.checksum.matches, false)
  assert.strictEqual(result.differences.byteSize.matches, true)
  assert.strictEqual(result.differences.summary.matches, true)
  manifestStore.set(sessionId, { ...manifestStore.get(sessionId), checksum: originalChecksum, summary: { ...manifest.summary, sales: manifest.summary.sales + 1 } })
  result = await main({ action: 'finalize', sessionId })
  assert.strictEqual(result.code, 'FINAL_VERIFY_FAILED')
  assert.deepStrictEqual(result.differences.summary.fields.sales, { expected: manifest.summary.sales + 1, actual: manifest.summary.sales })
  manifestStore.set(sessionId, { ...manifestStore.get(sessionId), summary: reverseObjectKeys(manifest.summary) })
  result = await main({ action: 'finalize', sessionId })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.backupVersion, 6)
  assert.strictEqual([...storeFor('coach_backup_manifests').values()][0].status, 'completed')
  assert.ok(storeFor('coach_db_backups').has(legacyId(openId)))
  const meta = await verifyMain({ action: 'metadata' })
  assert.strictEqual(meta.backupFormatVersion, 2)
  assert.strictEqual(meta.snapshot, undefined)
  const downloaded = []
  for (const descriptor of meta.chunks) {
    const response = await verifyMain({ action: 'chunk', backupVersion: meta.backupVersion, ...descriptor })
    assert.strictEqual(response.ok, true)
    downloaded.push(response.chunk)
  }
  assert.strictEqual(verifyRebuilt(rebuildSnapshot(downloaded), meta).ok, true)
  result = await main({ action: 'start', expectedBackupVersion: 5, ...plan, chunks: undefined })
  assert.strictEqual(result.code, 'VERSION_CONFLICT')
  console.log('backup chunk protocol tests: PASS')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
