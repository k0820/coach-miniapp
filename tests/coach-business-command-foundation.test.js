const assert = require('assert')
const { META, coachIdFor, fixedId, createService, activateVerifiedDataset } = require('../cloudfunctions/coachBusinessCommand/core')

const copy = value => JSON.parse(JSON.stringify(value))
const names = [...Object.values(META), 'students', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
const stores = Object.fromEntries(names.map(name => [name, new Map()]))
let failSetCollection = ''

function scope(target) {
  return {
    collection(name) {
      if (!target[name]) target[name] = new Map()
      return {
        doc(id) {
          return {
            async set({ data }) { if (failSetCollection === name) throw new Error(`injected ${name} failure`); target[name].set(id, { ...copy(data), _id: id }); return { _id: id } },
            async remove() { target[name].delete(id); return { stats: { removed: 1 } } }
          }
        },
        where(query) {
          let limit = Infinity
          const api = { limit(value) { limit = value; return api }, async get() { return { data: [...target[name].values()].filter(row => Object.keys(query).every(key => row[key] === query[key])).slice(0, limit).map(copy) } } }
          return api
        }
      }
    }
  }
}

let queue = Promise.resolve()
const db = {
  ...scope(stores),
  runTransaction(work) {
    const run = queue.then(async () => {
      const draft = Object.fromEntries(Object.entries(stores).map(([name, rows]) => [name, new Map([...rows].map(([id, row]) => [id, copy(row)]))]))
      const response = await work(scope(draft))
      for (const name of Object.keys(stores)) { stores[name].clear(); for (const [id, row] of draft[name]) stores[name].set(id, copy(row)) }
      return response
    })
    queue = run.catch(() => {})
    return run
  }
}

let openId = 'openid-a', now = 1900000000000
const owner = () => coachIdFor(openId)
const put = (name, id, data) => stores[name].set(id, { ...copy(data), _id: id })
const clear = () => Object.values(stores).forEach(store => store.clear())

function seedCoach(currentOpenId = openId) {
  const ownerCoachId = coachIdFor(currentOpenId)
  put(META.coaches, ownerCoachId, { openId: currentOpenId, status: 'active' })
  return ownerCoachId
}

function seedActiveDataset(ownerCoachId, datasetId = 'dataset-active', revision = 0) {
  put(META.datasets, fixedId('coach-dataset', ownerCoachId, datasetId), { ownerCoachId, datasetId, status: 'active', integrityStatus: 'verified', checksum: 'abc', byteSize: 10, summary: { students: 1 }, schemaVersion: 1 })
  put(META.heads, fixedId('coach-data-head', ownerCoachId), { ownerCoachId, activeDatasetId: datasetId, headVersion: 1, schemaVersion: 1 })
  put(META.revisions, fixedId('coach-data-revision', ownerCoachId, datasetId), { ownerCoachId, datasetId, dataRevision: revision })
  return datasetId
}

const handler = async (business, payload) => {
  const old = await business.collection('students').get(payload.studentId)
  await business.collection('students').set(payload.studentId, { studentId: payload.studentId, name: payload.name, previousName: old && old.name })
  return { studentId: payload.studentId }
}
const service = () => createService({ db, getOpenId: () => openId, handlers: { updateStudent: handler }, now: () => ++now })
const envelope = (requestId, expectedRevision, payload) => ({ action: 'execute', envelope: { command: 'updateStudent', requestId, expectedRevision, payload } })

async function test(name, fn) {
  try { clear(); failSetCollection = ''; await fn(); process.stdout.write(`PASS ${name}\n`) } catch (e) { process.stderr.write(`FAIL ${name}: ${e.stack}\n`); process.exitCode = 1 }
}

;(async () => {
  await test('没有 active head 时失败关闭且零业务写入', async () => {
    seedCoach(); const response = await service()({ action: 'status' })
    assert.equal(response.code, 'DATASET_HEAD_NOT_FOUND'); assert.equal(stores.students.size, 0); assert.equal(stores[META.receipts].size, 0)
  })

  await test('head 只允许 active + verified dataset', async () => {
    const own = seedCoach(), datasetId = 'candidate'
    put(META.heads, fixedId('coach-data-head', own), { ownerCoachId: own, activeDatasetId: datasetId, headVersion: 1 })
    put(META.datasets, fixedId('coach-dataset', own, datasetId), { ownerCoachId: own, datasetId, status: 'verified', integrityStatus: 'verified' })
    put(META.revisions, fixedId('coach-data-revision', own, datasetId), { ownerCoachId: own, datasetId, dataRevision: 0 })
    assert.equal((await service()({ action: 'status' })).code, 'ACTIVE_DATASET_INVALID')
  })

  await test('命令写入自动绑定 head dataset 和可信 owner', async () => {
    const own = seedCoach(), datasetId = seedActiveDataset(own)
    const response = await service()(envelope('foundation_req_001', 0, { studentId: 'student-1', name: '测试学员' }))
    assert.equal(response.ok, true); assert.equal(response.datasetRevision, 1)
    const row = [...stores.students.values()][0]
    assert.equal(row.ownerCoachId, own); assert.equal(row.datasetId, datasetId); assert.equal(row.studentId, 'student-1')
  })

  await test('同 requestId 同 payload 幂等，不同 payload 冲突', async () => {
    const own = seedCoach(); seedActiveDataset(own); const call = envelope('foundation_retry_001', 0, { studentId: 'student-1', name: 'A' }), main = service()
    assert.equal((await main(call)).ok, true); const retry = await main(call); assert.equal(retry.idempotent, true)
    assert.equal((await main(envelope('foundation_retry_001', 0, { studentId: 'student-1', name: 'B' }))).code, 'REQUEST_ID_CONFLICT')
    assert.equal(stores.students.size, 1); assert.equal([...stores[META.revisions].values()][0].dataRevision, 1)
  })

  await test('同 revision 并发只有一个成功', async () => {
    const own = seedCoach(); seedActiveDataset(own); const main = service()
    const responses = await Promise.all([main(envelope('parallel_foundation_a', 0, { studentId: 'a', name: 'A' })), main(envelope('parallel_foundation_b', 0, { studentId: 'b', name: 'B' }))])
    assert.equal(responses.filter(x => x.ok).length, 1); assert.equal(responses.find(x => !x.ok).code, 'REVISION_CONFLICT'); assert.equal(stores.students.size, 1)
  })

  await test('业务 handler 失败时 receipt/revision/业务写入全部回滚', async () => {
    const own = seedCoach(); seedActiveDataset(own); failSetCollection = 'students'
    const response = await service()(envelope('rollback_foundation_001', 0, { studentId: 'a', name: 'A' }))
    assert.equal(response.code, 'COMMAND_TRANSACTION_FAILED'); assert.equal(stores.students.size, 0); assert.equal(stores[META.receipts].size, 0); assert.equal([...stores[META.revisions].values()][0].dataRevision, 0)
  })

  await test('不同 owner 与不同 dataset 的同 businessId 互不命中', async () => {
    const a = seedCoach('openid-a'), b = seedCoach('openid-b'); seedActiveDataset(a, 'dataset-a'); seedActiveDataset(b, 'dataset-b')
    openId = 'openid-a'; await service()(envelope('owner_dataset_a1', 0, { studentId: 'same-id', name: 'A' }))
    openId = 'openid-b'; await service()(envelope('owner_dataset_b1', 0, { studentId: 'same-id', name: 'B' }))
    const rows = [...stores.students.values()]; assert.equal(rows.length, 2); assert.notEqual(rows[0]._id, rows[1]._id); assert.notEqual(rows[0].ownerCoachId, rows[1].ownerCoachId)
  })

  await test('客户端不能指定 owner/coach/OPENID/documentId/datasetId', async () => {
    openId = 'openid-a'; const own = seedCoach(); seedActiveDataset(own); const main = service(), before = stores.students.size
    for (const forged of [{ OPENID: 'x' }, { coachId: 'x' }, { ownerCoachId: 'x' }, { documentId: 'x' }, { datasetId: 'x' }]) assert.equal((await main({ ...envelope(`forged_${Object.keys(forged)[0]}_1`, 0, { studentId: 'x', name: 'x' }), ...forged })).code, 'FORBIDDEN_IDENTITY_INPUT')
    assert.equal(stores.students.size, before)
  })

  await test('CloudBase event.userInfo 被忽略且不参与 owner 计算', async () => {
    openId = 'openid-a'; const own = seedCoach(); seedActiveDataset(own)
    const response = await service()({ action: 'status', userInfo: { openId: 'openid-b' } })
    assert.equal(response.ok, true); assert.equal(own, coachIdFor('openid-a'))
  })

  await test('未注入 handler 的已知命令当前明确不写入', async () => {
    openId = 'openid-a'; const own = seedCoach(); seedActiveDataset(own)
    const main = createService({ db, getOpenId: () => openId, handlers: {} }), response = await main(envelope('not_enabled_001', 0, { studentId: 'x', name: 'x' }))
    assert.equal(response.code, 'COMMAND_NOT_IMPLEMENTED'); assert.equal(stores[META.receipts].size, 0); assert.equal(stores.students.size, 0)
  })

  await test('未验证 dataset 绝不能切换 head', async () => {
    const own = seedCoach(), datasetId = 'dataset-candidate'
    put(META.datasets, fixedId('coach-dataset', own, datasetId), { ownerCoachId: own, datasetId, status: 'uploading', integrityStatus: 'pending' })
    const response = await activateVerifiedDataset(db, own, datasetId, 0, ++now)
    assert.equal(response.code, 'DATASET_NOT_VERIFIED'); assert.equal(stores[META.heads].size, 0); assert.equal(stores[META.revisions].size, 0)
  })

  await test('verified dataset、revision 初始化和 head 切换原子完成', async () => {
    const own = seedCoach(), datasetId = 'dataset-candidate', datasetDocId = fixedId('coach-dataset', own, datasetId)
    put(META.datasets, datasetDocId, { ownerCoachId: own, datasetId, status: 'verified', integrityStatus: 'verified', checksum: 'checksum', byteSize: 123, summary: { students: 1 }, schemaVersion: 1 })
    const response = await activateVerifiedDataset(db, own, datasetId, 0, ++now), head = [...stores[META.heads].values()][0], dataset = stores[META.datasets].get(datasetDocId), revision = [...stores[META.revisions].values()][0]
    assert.equal(response.ok, true); assert.equal(head.activeDatasetId, datasetId); assert.equal(dataset.status, 'active'); assert.equal(revision.dataRevision, 0)
  })

  await test('head 写入失败时 dataset/revision 状态全部回滚', async () => {
    const own = seedCoach(), datasetId = 'dataset-candidate', datasetDocId = fixedId('coach-dataset', own, datasetId)
    put(META.datasets, datasetDocId, { ownerCoachId: own, datasetId, status: 'verified', integrityStatus: 'verified', checksum: 'checksum', byteSize: 123, summary: { students: 1 }, schemaVersion: 1 })
    failSetCollection = META.heads; const response = await activateVerifiedDataset(db, own, datasetId, 0, ++now)
    assert.equal(response.code, 'DATASET_ACTIVATION_FAILED'); assert.equal(stores[META.datasets].get(datasetDocId).status, 'verified'); assert.equal(stores[META.revisions].size, 0); assert.equal(stores[META.heads].size, 0)
  })

  await test('receipt 查询只定位当前 active dataset', async () => {
    openId = 'openid-a'; const own = seedCoach(); seedActiveDataset(own, 'dataset-a'); const main = service(), requestId = 'receipt_lookup_001'
    await main(envelope(requestId, 0, { studentId: 'a', name: 'A' })); assert.equal((await main({ action: 'getReceipt', requestId })).found, true)
    const candidateId = 'dataset-b', doc = fixedId('coach-dataset', own, candidateId)
    put(META.datasets, doc, { ownerCoachId: own, datasetId: candidateId, status: 'verified', integrityStatus: 'verified', checksum: 'b', byteSize: 1, summary: {}, schemaVersion: 1 })
    assert.equal((await activateVerifiedDataset(db, own, candidateId, 1, ++now)).ok, true)
    assert.equal((await main({ action: 'getReceipt', requestId })).found, false)
  })

  if (!process.exitCode) process.stdout.write('ALL FORMAL COMMAND FOUNDATION TESTS PASSED\n')
})()
