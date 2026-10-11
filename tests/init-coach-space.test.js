// 首次云端空间开通（云函数 initMyCoachSpace）永久回归。
//
// 这一轮要钉死的五件事：
//   ① **身份只来自可信 OPENID**：客户端提交 OPENID / openId / coachId / ownerCoachId / datasetId /
//      documentId 一律被拒，且什么都不写。
//   ② **幂等 + 绝不创建第二份**：连续两次、事务失败后重试、已有 head 的账号，最终都只有一份空间；
//      而且「已经有 head」的那一次**一个字节都不写**（这是"现有 cloud-primary 账号不受影响"的核心保证）。
//   ③ **写入的指纹必须与读端逐字一致**：用真实 integrity.js（服务端读端）与真实
//      utils/candidate-dataset.integrity（客户端读端）双向比对，再用**真实 adapter.readActive()**
//      端到端跑通 —— 新空间必须能被客户端完整读回来，否则新用户第一次打开就是只读的。
//   ④ **绝不碰业务事实与沙箱**：7 个业务集合零文档、沙箱集合零文档。
//   ⑤ settings 文档的 `_id` 与字段必须与 coachBusinessCommand 的写入器**同一份契约**：
//      否则用户第一次改设置就会多出第二份 settings 文档，回读快照立刻与开通指纹不一致。
//
// 服务端不在本文件里手写：它跑的是**真实** service.js（见 tests/helpers/coach-space-cloud.js）。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { createCoachSpaceCloud, BUSINESS_COLLECTIONS, SANDBOX_COLLECTIONS, READ_COLLECTIONS } = require('./helpers/coach-space-cloud')
const { coachIdFor, fixedId, initialSnapshot, DEFAULT_SETTINGS } = require('../cloudfunctions/initMyCoachSpace/service')
const { reconstruct: serverReconstruct, fingerprint: serverFingerprint } = require('../cloudfunctions/readMyActiveCoachData/integrity')
const { reconstructCandidate, integrity: clientIntegrity } = require('../utils/candidate-dataset')
const { createAdapter } = require('../utils/cloud-primary-adapter')

const PROJ = path.join(__dirname, '..')
const read = relative => fs.readFileSync(path.join(PROJ, relative), 'utf8')
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n')
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const memoryStorage = () => { const memory = new Map(); return { get: key => memory.has(key) ? copy(memory.get(key)) : undefined, set: (key, value) => memory.set(key, copy(value)), raw: memory } }
const cloud = createCoachSpaceCloud()
const documentCount = name => cloud.counts()[name] || 0

async function test(name, run) {
  try { cloud.reset(); await run(); process.stdout.write(`PASS ${name}\n`) }
  catch (error) { process.stderr.write(`FAIL ${name}: ${error && error.stack || error}\n`); process.exitCode = 1 }
}

;(async () => {
  const provision = (openId, event) => cloud.provision(openId, event)

  await test('全新 coach 首次开通：只建一份空空间，7 个业务集合零文档', async () => {
    const result = await provision('openid-new')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.created, true)
    assert.equal(result.alreadyProvisioned, false)
    assert.equal(result.dataRevision, 0)
    assert.equal(result.headVersion, 1)
    const owner = coachIdFor('openid-new')
    assert.equal(documentCount('coaches'), 1, '必须建立唯一 coach 记录')
    assert.equal(cloud.stores.coaches.get(owner).openId, 'openid-new', 'coach 记录必须绑定可信 OPENID')
    assert.equal(documentCount('coach_datasets'), 1)
    assert.equal(documentCount('coach_data_revisions'), 1)
    assert.equal(documentCount('coach_data_heads'), 1)
    assert.equal(documentCount('settings'), 1, '新空间必须带一份默认设置')
    BUSINESS_COLLECTIONS.forEach(name => assert.equal(documentCount(name), 0, `${name} 必须保持零文档`))
    SANDBOX_COLLECTIONS.forEach(name => assert.equal(documentCount(name), 0, `开通绝不允许碰沙箱集合 ${name}`))
    const head = cloud.stores.coach_data_heads.get(fixedId('coach-data-head', owner))
    assert.equal(head.activeDatasetId, result.datasetId)
    assert.equal(head.datasetChecksum, result.checksum)
  })

  await test('空空间指纹与真实读端逐字一致（服务端 integrity + 客户端 integrity 双向）', async () => {
    const result = await provision('openid-new')
    const owner = coachIdFor('openid-new')
    const { datasetId, physical, logical } = cloud.ownerGroups(owner)
    const dataset = cloud.stores.coach_datasets.get(fixedId('coach-dataset', owner, datasetId))
    // 服务端读端（cloudfunctions/readMyActiveCoachData/integrity.js）
    const server = serverFingerprint(serverReconstruct(physical))
    assert.equal(dataset.checksum, server.checksum, 'dataset.checksum 必须等于读端 reconstruct 后的 fingerprint')
    assert.equal(dataset.byteSize, server.byteSize)
    assert.equal(JSON.stringify(dataset.summary), JSON.stringify(server.summary))
    assert.equal(JSON.stringify(dataset.counts), JSON.stringify(server.counts))
    assert.equal(JSON.stringify(dataset.amounts), JSON.stringify(server.amounts))
    // 客户端读端（utils/candidate-dataset）—— 这是 adapter.readActive 真正跑的那一份
    const clientSnapshot = reconstructCandidate(logical)
    const client = clientIntegrity(clientSnapshot)
    assert.equal(client.checksum, dataset.checksum, '客户端 reconstructCandidate 的 checksum 必须与开通指纹一致')
    assert.equal(client.byteSize, dataset.byteSize)
    assert.equal(JSON.stringify(client.summary), JSON.stringify(dataset.summary))
    assert.equal(JSON.stringify(clientSnapshot.settings), JSON.stringify(DEFAULT_SETTINGS))
    assert.equal(JSON.stringify(initialSnapshot().settings), JSON.stringify(DEFAULT_SETTINGS))
    assert.equal(result.checksum, dataset.checksum)
  })

  await test('连续两次开通幂等：同一个 datasetId，且第二次一个字节都不写', async () => {
    const first = await provision('openid-new')
    const before = cloud.snapshot()
    const second = await provision('openid-new')
    assert.equal(second.ok, true)
    assert.equal(second.created, false)
    assert.equal(second.alreadyProvisioned, true, '第二次必须认出空间已存在')
    assert.equal(second.datasetId, first.datasetId, '绝不允许换 dataset')
    assert.equal(second.headVersion, first.headVersion, '不得推进 headVersion')
    assert.equal(second.dataRevision, 0)
    assert.equal(cloud.snapshot(), before, '已开通的空间在重复开通时必须一个字节都不写')
    assert.equal(documentCount('coach_datasets'), 1)
    assert.equal(documentCount('coach_data_heads'), 1)
  })

  await test('已有 head/dataset 的账号（现有 cloud-primary 用户）不被重新初始化、不创建第二份', async () => {
    const owner = coachIdFor('openid-existing')
    cloud.stores.coaches.set(owner, { _id: owner, openId: 'openid-existing', status: 'active', schemaVersion: 1, migrationVersion: 1 })
    cloud.stores.coach_datasets.set(fixedId('coach-dataset', owner, 'existing-dataset'), { _id: fixedId('coach-dataset', owner, 'existing-dataset'), ownerCoachId: owner, datasetId: 'existing-dataset', status: 'active', integrityStatus: 'verified', checksum: 'a'.repeat(64), byteSize: 120, summary: { students: 3 }, counts: {}, amounts: {} })
    cloud.stores.coach_data_revisions.set(fixedId('coach-data-revision', owner, 'existing-dataset'), { _id: fixedId('coach-data-revision', owner, 'existing-dataset'), ownerCoachId: owner, datasetId: 'existing-dataset', dataRevision: 62 })
    cloud.stores.coach_data_heads.set(fixedId('coach-data-head', owner), { _id: fixedId('coach-data-head', owner), ownerCoachId: owner, activeDatasetId: 'existing-dataset', headVersion: 1 })
    const before = cloud.snapshot()
    const result = await provision('openid-existing')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.alreadyProvisioned, true)
    assert.equal(result.datasetId, 'existing-dataset', '必须继续使用既有 dataset')
    assert.equal(result.dataRevision, 62, '必须读回既有 revision')
    assert.equal(cloud.snapshot(), before, '绝不能碰既有账号的任何数据')
    assert.equal(documentCount('coach_datasets'), 1, '绝不允许创建第二份 dataset')
    assert.equal(documentCount('coach_data_heads'), 1)
  })

  await test('客户端提交任何身份字段一律拒绝，且什么都不写', async () => {
    for (const key of ['OPENID', 'openId', 'openid', '_openid', 'coachId', 'ownerCoachId', 'datasetId', 'documentId']) {
      const before = cloud.snapshot()
      const result = await provision('openid-new', { action: 'provision', [key]: 'forged' })
      assert.equal(result.ok, false, `${key} 必须被拒绝`)
      assert.equal(result.code, 'FORBIDDEN_IDENTITY_INPUT', `${key} 必须返回 FORBIDDEN_IDENTITY_INPUT`)
      assert.equal(cloud.snapshot(), before, `${key} 被拒时不得写入任何数据`)
    }
    assert.equal(documentCount('coach_datasets'), 0)
    assert.equal(documentCount('coaches'), 0)
  })

  await test('拿不到可信 OPENID 时不建任何东西', async () => {
    const result = await provision('')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'IDENTITY_MISSING')
    assert.equal(documentCount('coaches'), 0)
    assert.equal(documentCount('coach_datasets'), 0)
    assert.equal(documentCount('coach_data_heads'), 0)
  })

  await test('事务中途失败不留半份空间，且重试能正常建起来', async () => {
    cloud.setFailure('coach_data_heads')
    const result = await provision('openid-new')
    assert.equal(result.ok, false, '写入失败必须如实返回失败')
    cloud.setFailure('')
    assert.equal(documentCount('coach_data_heads'), 0, '事务回滚后不得留下 head')
    assert.equal(documentCount('coach_datasets'), 0, '事务回滚后不得留下 dataset')
    assert.equal(documentCount('coach_data_revisions'), 0)
    assert.equal(documentCount('settings'), 0)
    const retry = await provision('openid-new')
    assert.equal(retry.ok, true)
    assert.equal(retry.created, true)
    assert.equal(documentCount('coach_datasets'), 1)
  })

  await test('不同微信账号完全隔离：各自的 coach / dataset / head 互不可见', async () => {
    const a = await provision('openid-a')
    const b = await provision('openid-b')
    assert.notEqual(a.datasetId, b.datasetId, '两个账号必须拿到不同的 datasetId')
    assert.equal(documentCount('coach_datasets'), 2)
    assert.equal(documentCount('coach_data_heads'), 2)
    assert.equal(documentCount('coaches'), 2)
    const ownerA = coachIdFor('openid-a'), ownerB = coachIdFor('openid-b')
    const stateA = cloud.ownerGroups(ownerA), stateB = cloud.ownerGroups(ownerB)
    assert.equal(stateA.datasetId, a.datasetId)
    assert.equal(stateB.datasetId, b.datasetId)
    READ_COLLECTIONS.forEach(name => {
      assert.equal(stateA.physical[name].every(row => row.ownerCoachId === ownerA), true, `${name} 不得混入其他账号的文档`)
      assert.equal(stateB.physical[name].every(row => row.ownerCoachId === ownerB), true)
    })
  })

  await test('端到端：真实 adapter.readActive() 必须完整通过（新空间能被客户端读回来）', async () => {
    const result = await provision('openid-new')
    const storage = memoryStorage()
    const adapter = createAdapter({ callCloud: cloud.serveActive('openid-new'), storage, isOnline: () => true })
    const active = await adapter.readActive()
    assert.equal(active.ok, true, `新空间必须能被 readActive 读通：${JSON.stringify(active).slice(0, 400)}`)
    assert.equal(active.datasetId, result.datasetId)
    assert.equal(active.revision, 0)
    assert.equal(active.checksum, result.checksum)
    assert.equal(active.snapshot.students.length, 0)
    assert.equal(active.snapshot.bookings.length, 0)
    assert.equal(JSON.stringify(active.snapshot.settings), JSON.stringify(DEFAULT_SETTINGS), '新空间必须带默认设置（云端模式没有本地那层默认值兜底）')
    assert.equal(storage.raw.has('coachDB'), false, '开通与回读都不得写本机 coachDB')
  })

  await test('settings 文档与 coachBusinessCommand 写入器是同一份契约（不会长出第二份）', async () => {
    await provision('openid-new')
    const owner = coachIdFor('openid-new')
    const { datasetId } = cloud.ownerGroups(owner)
    // 用 core.js 的公式**独立**重算一次预期 _id（而不是引用 service 里那个函数）
    const expectedId = crypto.createHash('sha256').update(`coach-business-settings:${owner}:${datasetId}:settings`).digest('hex').slice(0, 32)
    const stored = cloud.stores.settings.get(expectedId)
    assert.ok(stored, 'settings 文档的 _id 必须与 coachBusinessCommand.scopedBusiness 的公式一致')
    assert.equal(stored.settingsId, 'settings')
    assert.equal(stored.sortIndex, 0)
    assert.equal(stored.ownerCoachId, owner)
    assert.equal(stored.datasetId, datasetId)
    // 模拟用户第一次改设置（handlers.saveSettings 就是 doc.set(同一个 id, {settingsId, sortIndex, data})）
    cloud.stores.settings.set(expectedId, { ...stored, data: { ...stored.data, renewThreshold: 8 } })
    assert.equal(documentCount('settings'), 1, '改设置必须更新同一份文档，绝不能多出第二份')
    const active = await createAdapter({ callCloud: cloud.serveActive('openid-new'), storage: memoryStorage(), isOnline: () => true }).readActive()
    assert.equal(active.ok, true, '改设置之后回读仍然必须通过完整性校验')
    assert.equal(active.snapshot.settings.renewThreshold, 8)
  })

  await test('静态：身份只来自 getWXContext；不写业务事实、不碰沙箱、不含迁移/候选逻辑', async () => {
    const index = read('cloudfunctions/initMyCoachSpace/index.js')
    // ⚠️ 静态断言前先剥注释：「不得复用旧流程」这句说明本身就用这些词写的，注释里提到不等于用了。
    const service = stripComments(read('cloudfunctions/initMyCoachSpace/service.js'))
    assert.ok(/cloud\.getWXContext\(\)\.OPENID/.test(index), '身份必须来自 cloud.getWXContext()')
    assert.ok(!/event\.openId|event\.OPENID|event\.coachId|event\.ownerCoachId|event\.datasetId/.test(index + service), '绝不允许从客户端 event 里取身份或数据集')
    assert.ok(/FORBIDDEN_IDENTITY_INPUT/.test(service), '必须显式拒绝客户端提交身份字段')
    assert.ok(!/migrateCoachDBToCloud|stageCoachCandidate|activateCoachDataset|coach_migration|coach_candidate|retired|coach_dataset_activation_receipts/.test(service), '不得复用旧的 Activation / Migration / Candidate 流程')
    assert.ok(!/coach_sandbox/.test(service), '开通不得碰沙箱集合')
    assert.ok(!/coachBusinessCommand/.test(service), '开通器不是业务写入口')
    BUSINESS_COLLECTIONS.forEach(name => {
      assert.equal(new RegExp(`put\\(\\s*tx\\s*,\\s*'${name}'`).test(service), false, `开通不得写入业务集合 ${name}`)
    })
  })

  if (!process.exitCode) process.stdout.write('ALL INIT COACH SPACE TESTS PASSED\n')
})()
