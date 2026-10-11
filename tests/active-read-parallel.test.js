const assert = require('assert')
const { buildCandidateDataset } = require('../utils/candidate-dataset')
const { createAdapter, SANDBOX_ROWS_KEY } = require('../utils/cloud-primary-adapter')
const fs = require('fs')
const path = require('path')
const snapshot = {
  students: [{ id: 'fake-student', name: '假学员', packages: [{ id: 'fake-package', type: '赠送课程', total: 2, used: 0, remaining: 2, price: 80, status: 'active' }] }],
  bookings: [], incomes: [], sales: [], settings: { renewThreshold: 3, monthlyGoalSessions: 20, classCommissionRate: 40, salesCommissionRate: 10 }, customExercises: []
}
const built = buildCandidateDataset(snapshot, { trustedOwnerCoachId: 'fake-owner', trustedDatasetId: 'fake-dataset' })
const physical = { students: 'students', studentTombstones: 'student_tombstones', packages: 'packages', bookings: 'bookings', incomes: 'incomes', sales: 'sales', settings: 'settings', customExercises: 'customExercises' }
;(async () => {
  let activePages = 0, peakPages = 0, writes = 0, calls = 0
  const writeKeys = []
  const storage = { get: () => undefined, set: key => { writes++; writeKeys.push(key) } }
  const callCloud = async (name, data) => {
    assert.equal(name, 'readMyActiveCoachData')
    calls++
    if (data.action === 'metadata') return { ok: true, environment: 'sandbox', datasetId: 'fake-dataset', dataRevision: 4, collections: Object.values(physical) }
    if (data.action === 'integrity') return { ok: true, environment: 'sandbox', datasetId: 'fake-dataset', dataRevision: 4, ...built.integrity }
    assert.equal(data.action, 'page')
    activePages++; peakPages = Math.max(peakPages, activePages)
    await new Promise(resolve => setTimeout(resolve, 5))
    activePages--
    const logical = Object.keys(physical).find(key => physical[key] === data.collection)
    const rows = built.collections[logical]
    return { ok: true, nextCursor: rows.length, nextFragmentIndex: 0, done: true, encoding: 'base64-json', payload: Buffer.from(JSON.stringify(rows)).toString('base64') }
  }
  const adapter = createAdapter({ callCloud, storage, environment: () => 'sandbox' })
  const result = await adapter.readActive()
  assert.equal(result.ok, true)
  assert.equal(result.revision, 4)
  assert.equal(peakPages, 2, '客户端集合分页并发必须限为 2，避免免费云环境瞬间拥塞；单集合内部仍保持顺序')
  assert.equal(calls, 10, 'metadata + 8 page + integrity 均保留，不减少完整性验证')
  // 1.1.9 第 7 轮起完整读取要落**两**笔：主缓存 + 行镜像（增量同步的燃料）。
  // 这里钉住的不是"两笔"这个数字，而是**它们必须落在两个不同的存储键上** ——
  // 镜像写失败只该让"下一次下拉重新完整读一遍"，绝不能连累主缓存那一笔、更不能变成一次读取失败。
  assert.equal(writes, 2, '完整读取只写两笔：主缓存 + 行镜像')
  assert.equal(writeKeys.filter(key => key === 'coachSandboxActiveCache').length, 1, '主缓存恰好写一笔')
  assert.equal(writeKeys.filter(key => key === SANDBOX_ROWS_KEY).length, 1,
    '★ 行镜像恰好写一笔，且在**独立**存储键上，实得 ' + JSON.stringify(writeKeys))
  assert.notEqual(SANDBOX_ROWS_KEY, 'coachSandboxActiveCache', '★ 镜像键必须与主缓存键不同（共用一键 = 镜像会把主缓存覆盖坏）')
  let staleWrites = 0
  const staleAdapter = createAdapter({ callCloud, environment: () => 'sandbox', storage: { get: () => ({ datasetId: 'fake-dataset', revision: 5 }), set: () => { staleWrites++ } } })
  const staleResult = await staleAdapter.readActive()
  assert.equal(staleResult.code, 'ACTIVE_READ_STALE', 'old read must not overwrite newer cache revision')
  assert.equal(staleWrites, 0)
  const serverRead = fs.readFileSync(path.join(__dirname, '../cloudfunctions/readMyActiveCoachData/index.js'), 'utf8')
  assert(serverRead.includes('Promise.all(COLLECTIONS.map'), '服务端动态指纹的八集合读取也应并行')
  assert(serverRead.includes('revision.dataRevision !== revisionBefore'), '并行后仍必须复核 revision')
  console.log('active read bounded-concurrency tests passed (2 concurrent collections, all 10 RPC checks retained)')
})().catch(error => { console.error(error); process.exitCode = 1 })
