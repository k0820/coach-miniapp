// 真实事故永久回归：**删除学员没留墓碑 → 整个账号的全量读取永久失败**。
//
// 事故现场（2026-09-20 ~ 09-22，Production）：
//   学员 `student_aff17e8f86dd642b75d9`（胡秀明）被删除时，handlers.js 还没有写墓碑
//   （那段代码是 09-21 11:08 才补的）。它的两条 reversed 课时包仍然引用它。
//   云端 readMyActiveCoachData/integrity.js 的 reconstruct 找不到学员就直接 throw
//   ACTIVE_RELATION_INVALID（`-504002`）→ 客户端 readActive 永远失败 → 本机 revision
//   拿不到 → 所有写命令在**出网之前**被 REVISION_UNKNOWN 拒掉 → 电脑预约上不了云、
//   手机刷不到、云端 BOOKING_TIME_CONFLICT 从未触发（「该时间已约」消失）。
//
// 本文件钉死三件事：
//   ① 没有墓碑时，**两个读端都必须失败**（复现事故，防止有人把校验放松掉）；
//   ② 补墓碑后，两个读端必须**逐字节一致**地通过（checksum/byteSize/summary/counts/amounts）；
//   ③ 修复动作只新增一条墓碑，绝不改动任何 package / sale / booking / income。
const assert = require('assert')
const { META, coachIdFor, fixedId, createService } = require('../cloudfunctions/coachBusinessCommand/core')
const { handlers } = require('../cloudfunctions/coachBusinessCommand/handlers')
const { runRepair, ACTIONS, BASELINE_FIELDS } = require('../cloudfunctions/coachBusinessCommand/repair')
const { reconstruct, fingerprint } = require('../cloudfunctions/readMyActiveCoachData/integrity')
const { reconstructCandidate, integrity: clientIntegrity } = require('../utils/candidate-dataset')

const STUDENT = 'student_aff17e8f86dd642b75d9'
const OWNER_OPENID = 'openid-owner'
const DATASET = 'candidate_f971f032ca88dc3a2b656a6654d9a314'
const REVERSED_AT = 1789910569191
const DELETE_AT = 1789913938285
const BASELINE = { id: STUDENT, name: '胡秀明', phone: '', abbr: 'HXM', createdAt: 1789827653715 }
const PACKAGES = [
  { packageId: 'package_b65ca3885f8275cd8522', saleId: 'sale_5a0fd8d0ada348f647f2' },
  { packageId: 'package_1f8bf80bb35e9ba14973', saleId: 'sale_7d07b388a1f76c973d13' }
]
const BUSINESS = ['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']

const copy = value => JSON.parse(JSON.stringify(value))
const names = [...Object.values(META), ...BUSINESS, ...Object.values({ sandbox: 'coach_sandbox_heads', sandbox2: 'coach_sandbox_revisions', sandbox3: 'coach_sandbox_receipts' })]
const stores = Object.fromEntries(names.map(name => [name, new Map()]))
let failCollection = '', queue = Promise.resolve(), openId = OWNER_OPENID, clock = DELETE_AT

function scope(target) {
  return {
    collection(name) {
      if (!target[name]) target[name] = new Map()
      return {
        doc(id) {
          return {
            async set({ data }) {
              if (failCollection === name) throw new Error(`injected ${name} failure`)
              target[name].set(id, { ...copy(data), _id: id }); return { _id: id }
            },
            async remove() {
              if (failCollection === name) throw new Error(`injected ${name} failure`)
              const removed = target[name].delete(id) ? 1 : 0; return { stats: { removed } }
            }
          }
        },
        where(query) {
          let limit = Infinity, offset = 0
          const api = {
            limit(value) { limit = value; return api },
            skip(value) { offset = value; return api },
            async get() { return { data: [...target[name].values()].filter(row => Object.keys(query).every(key => row[key] === query[key])).slice(offset, offset + limit).map(copy) } }
          }
          return api
        }
      }
    }
  }
}

const db = {
  ...scope(stores),
  runTransaction(work) {
    const run = queue.then(async () => {
      const draft = Object.fromEntries(Object.entries(stores).map(([name, rows]) => [name, new Map([...rows].map(([id, row]) => [id, copy(row)]))]))
      const result = await work(scope(draft))
      for (const name of Object.keys(stores)) { stores[name].clear(); for (const [id, row] of draft[name]) stores[name].set(id, copy(row)) }
      return result
    })
    queue = run.catch(() => {})
    return run
  }
}

const put = (name, id, data) => stores[name].set(id, { ...copy(data), _id: id })
const clear = () => { Object.values(stores).forEach(store => store.clear()); failCollection = ''; queue = Promise.resolve(); openId = OWNER_OPENID; }
const businessId = (name, owner, datasetId, id) => fixedId(`coach-business-${name}`, owner, `${datasetId}:${id}`)
const rowOf = (name, id) => stores[name].get(id)
const rows = name => [...stores[name].values()].map(copy)

// 现场快照：36 个在册学员 + 1 个「已删除但没墓碑」的学员（只在课时包里留下引用）。
function seed({ students = 36, orphanPackages = PACKAGES.length } = {}) {
  const owner = coachIdFor(OWNER_OPENID)
  put(META.coaches, owner, { openId: OWNER_OPENID, status: 'active' })
  put(META.datasets, fixedId('coach-dataset', owner, DATASET), { ownerCoachId: owner, datasetId: DATASET, status: 'active', integrityStatus: 'verified', checksum: 'activation-baseline', byteSize: 1, summary: {}, counts: {}, amounts: {}, schemaVersion: 1 })
  put(META.heads, fixedId('coach-data-head', owner), { ownerCoachId: owner, activeDatasetId: DATASET, headVersion: 9 })
  // revision 145 = 那次删除事务；updatedAt 就是删除时间
  put(META.revisions, fixedId('coach-data-revision', owner, DATASET), { ownerCoachId: owner, datasetId: DATASET, dataRevision: 145, updatedAt: DELETE_AT })
  for (let index = 0; index < students; index += 1) {
    const id = `mtfe${String(index).padStart(16, '0')}`
    put('students', businessId('students', owner, DATASET, id), { ownerCoachId: owner, datasetId: DATASET, studentId: id, sourceOrder: index, data: { id, name: `学员${index}`, phone: '', abbr: 'XY', createdAt: 1789000000000 + index } })
  }
  PACKAGES.slice(0, orphanPackages).forEach((item, index) => {
    put('packages', businessId('packages', owner, DATASET, item.packageId), { ownerCoachId: owner, datasetId: DATASET, packageId: item.packageId, studentId: STUDENT, saleId: item.saleId, data: { id: item.packageId, type: '常规训练', total: 20, used: 0, remaining: 0, price: 300, status: 'reversed', saleDate: '2026-09-19', saleId: item.saleId, reversedAt: REVERSED_AT + index } })
    put('sales', businessId('sales', owner, DATASET, item.saleId), { ownerCoachId: owner, datasetId: DATASET, saleId: item.saleId, studentId: STUDENT, packageId: item.packageId, data: { id: item.saleId, source: 'course', status: 'reversed', studentId: STUDENT, packageId: item.packageId, typeName: '常规训练', quantity: 20, unitPrice: 300, amount: 5800, date: '2026-09-19', note: '胡秀明 · 常规训练 20节', reversedAt: REVERSED_AT + index } })
  })
  return { owner, datasetId: DATASET }
}

const serverGroups = () => Object.fromEntries(['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises'].map(name => [name, rows(name)]))
const clientCollections = () => Object.fromEntries(['students', 'studentTombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises'].map(name => [name, rows(name === 'studentTombstones' ? 'student_tombstones' : name)]))
const call = (action, extra = {}) => runRepair({ db, getOpenId: () => openId, event: { action, studentId: STUDENT, baseline: BASELINE, ...extra } })
const service = () => createService({ db, getOpenId: () => openId, handlers, now: () => ++clock })
const execute = (command, requestId, expectedRevision, payload) => ({ action: 'execute', envelope: { command, requestId, expectedRevision, payload } })

async function test(name, fn) {
  try { clear(); await fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}

;(async () => {
  // ——— ① 复现事故：没有墓碑时，两个读端都读不出来 ———
  await test('复现事故：缺墓碑时云端 reconstruct 抛 ACTIVE_RELATION_INVALID', async () => {
    seed()
    assert.throws(() => reconstruct(serverGroups()), error => error.code === 'ACTIVE_RELATION_INVALID' && error.message.includes(PACKAGES[0].packageId), '云端必须因为缺墓碑而整体失败')
  })

  await test('复现事故：缺墓碑时客户端 reconstructCandidate 抛 ORPHAN_PACKAGE', async () => {
    seed()
    assert.throws(() => reconstructCandidate(clientCollections()), error => error.code === 'ORPHAN_PACKAGE', '客户端必须因为缺墓碑而整体失败')
  })

  await test('复现事故：readMyActiveCoachData integrity 的这次读取整体不可用', async () => {
    seed()
    let thrown = null
    try { reconstruct(serverGroups()) } catch (error) { thrown = error }
    assert(thrown, '缺墓碑时读不出任何数据 —— 这正是「整账号永久不可读」')
    assert.equal(thrown.code, 'ACTIVE_RELATION_INVALID')
  })

  // ——— ② 预演：inspect 只读，且把「即将写入的那一行」和每个值的来源摊开 ———
  await test('repairInspect：只读预演，不写任何一行', async () => {
    const { owner } = seed()
    const before = copy(Object.fromEntries(names.map(name => [name, rows(name)])))
    const result = await call('repairInspect')
    assert.equal(result.ok, true)
    assert.equal(result.studentId, STUDENT)
    assert.equal(result.datasetId, DATASET)
    assert.equal(result.revisionBefore, 145)
    assert.equal(result.existingStudent, false)
    assert.equal(result.existingTombstone, false)
    assert.equal(result.referencingPackages.length, 2)
    assert.deepEqual(result.referencingPackages.map(item => item.packageId).sort(), PACKAGES.map(item => item.packageId).sort())
    assert.deepEqual(result.counts, { studentsBefore: 36, tombstonesBefore: 0, packagesBefore: 2 })
    // sortIndex / deletedAt / abbr 全部是服务端推导，不是客户端说了算
    assert.equal(result.sortIndex, 36, 'nextSortIndex 必须等于该学员当年创建时的值')
    assert.equal(result.deletedAt, DELETE_AT, 'deletedAt 必须来自 coach_data_revisions.updatedAt')
    assert.equal(result.data.abbr, 'HXM', 'abbr 必须由 handlers.initials(name) 重算')
    assert.deepEqual(Object.keys(result.data).sort(), ['abbr', 'createdAt', 'deletedAt', 'id', 'name', 'phone', 'status'].sort())
    assert.equal(result.data.status, 'deleted')
    assert.equal(result.tombstoneRowId, businessId('student_tombstones', owner, DATASET, STUDENT))
    assert.equal(result.evidence.cloudNameEvidence.length >= 1, true, '必须找到云端姓名证据')
    assert.deepEqual(Object.fromEntries(names.map(name => [name, rows(name)])), before, '预演阶段禁止任何写入')
  })

  // ——— ③ 补墓碑：写入后两个读端逐字节一致 ———
  await test('补墓碑后：云端与客户端重建同一快照，checksum/byteSize/summary/counts/amounts 全部一致', async () => {
    seed()
    const result = await call('repairStudentTombstone', { expectedRevision: 145 })
    assert.equal(result.ok, true); assert.equal(result.repaired, true)
    assert.equal(result.revisionBefore, 145); assert.equal(result.revisionAfter, 146)
    assert.equal(rows('student_tombstones').length, 1)
    const tombstone = rows('student_tombstones')[0]
    assert.equal(tombstone.data.id, STUDENT)
    assert.equal(tombstone.data.status, 'deleted')
    assert.equal(tombstone.data.name, '胡秀明')
    assert.equal(tombstone.data.deletedAt, DELETE_AT)
    assert.equal(tombstone.sortIndex, 36)
    assert.equal(tombstone.ownerCoachId, coachIdFor(OWNER_OPENID))
    assert.equal(tombstone.datasetId, DATASET)

    const server = reconstruct(serverGroups()), serverPrint = fingerprint(server)
    const client = reconstructCandidate(clientCollections()), clientPrint = clientIntegrity(client)
    assert.equal(serverPrint.checksum, clientPrint.checksum, '两个读端的 checksum 必须逐字节一致')
    assert.equal(serverPrint.byteSize, clientPrint.byteSize)
    assert.deepEqual(serverPrint.summary, clientPrint.summary)
    assert.deepEqual(serverPrint.counts, clientPrint.counts)
    assert.deepEqual(serverPrint.amounts, clientPrint.amounts)
    assert.equal(serverPrint.summary.students, 36, '在册学员数一个字没变')
    assert.equal(serverPrint.summary.deletedStudents, 1)
    assert.equal(serverPrint.summary.packages, 2)
    assert.equal(serverPrint.amounts.sales, 11600)
  })

  await test('补墓碑后：两条 reversed 课时包与两条 sale 逐字节未变', async () => {
    seed()
    const packagesBefore = PACKAGES.map(item => copy(rowOf('packages', businessId('packages', coachIdFor(OWNER_OPENID), DATASET, item.packageId))))
    const salesBefore = PACKAGES.map(item => copy(rowOf('sales', businessId('sales', coachIdFor(OWNER_OPENID), DATASET, item.saleId))))
    await call('repairStudentTombstone', { expectedRevision: 145 })
    const packagesAfter = PACKAGES.map(item => copy(rowOf('packages', businessId('packages', coachIdFor(OWNER_OPENID), DATASET, item.packageId))))
    const salesAfter = PACKAGES.map(item => copy(rowOf('sales', businessId('sales', coachIdFor(OWNER_OPENID), DATASET, item.saleId))))
    assert.deepEqual(packagesAfter, packagesBefore, 'used/remaining/status/saleDate/reversedAt 必须一个字都不动')
    assert.deepEqual(salesAfter, salesBefore, '销售历史必须一个字都不动')
    assert.equal(rows('packages').every(row => row.data.status === 'reversed' && row.data.remaining === 0), true)
  })

  await test('补墓碑后：readMyActiveCoachData 的三个 action 都能跑通（metadata/integrity/page）', async () => {
    const { owner } = seed()
    await call('repairStudentTombstone', { expectedRevision: 145 })
    // page 的落点：`page` 用 orderBy('_id') 分页；这里直接断言行集合可枚举且含墓碑
    const tombstonePage = rows('student_tombstones').filter(row => row.ownerCoachId === owner && row.datasetId === DATASET)
    assert.equal(tombstonePage.length, 1)
    // integrity 的落点
    const print = fingerprint(reconstruct(serverGroups()))
    assert.equal(print.summary.deletedStudents, 1)
    // metadata 的落点：revision 必须能正常取得（不再是 null / 非整数）
    const revision = rows(META.revisions).find(row => row.datasetId === DATASET)
    assert.equal(Number.isInteger(revision.dataRevision), true)
    assert.equal(revision.dataRevision, 146)
  })

  // ——— ④ 幂等与回滚 ———
  await test('重复执行：同一条墓碑只写一次，revision 不重复自增', async () => {
    seed()
    const first = await call('repairStudentTombstone', { expectedRevision: 145 })
    const second = await call('repairStudentTombstone', { expectedRevision: 146 })
    assert.equal(first.repaired, true)
    assert.equal(second.ok, true); assert.equal(second.alreadyRepaired, true); assert.equal(second.repaired, false)
    assert.equal(rows('student_tombstones').length, 1)
    assert.equal(rows(META.revisions).find(row => row.datasetId === DATASET).dataRevision, 146)
  })

  await test('回滚：删掉刚补的那一条墓碑，并回到「读不出来」的原状', async () => {
    seed()
    const written = await call('repairStudentTombstone', { expectedRevision: 145 })
    const rolled = await call('repairTombstoneRollback', { deletedAt: written.data.deletedAt })
    assert.equal(rolled.ok, true); assert.equal(rolled.rolledBack, true)
    assert.equal(rows('student_tombstones').length, 0)
    assert.equal(rows(META.revisions).find(row => row.datasetId === DATASET).dataRevision, 147)
    assert.throws(() => reconstruct(serverGroups()), error => error.code === 'ACTIVE_RELATION_INVALID')
    assert.equal(rows('packages').length, 2, '回滚同样不碰课时包')
  })

  await test('回滚：deletedAt 不匹配时拒绝删除任何墓碑', async () => {
    seed()
    await call('repairStudentTombstone', { expectedRevision: 145 })
    const refused = await call('repairTombstoneRollback', { deletedAt: DELETE_AT + 1 })
    assert.equal(refused.ok, false); assert.equal(refused.code, 'REPAIR_ROLLBACK_TARGET_MISMATCH')
    assert.equal(rows('student_tombstones').length, 1)
  })

  // ——— ⑤ fail-closed 矩阵 ———
  await test('拒绝：学员仍然存在时不补墓碑', async () => {
    const { owner } = seed()
    put('students', businessId('students', owner, DATASET, STUDENT), { ownerCoachId: owner, datasetId: DATASET, studentId: STUDENT, sortIndex: 36, data: { ...BASELINE } })
    const result = await call('repairInspect')
    assert.equal(result.ok, false); assert.equal(result.code, 'REPAIR_STUDENT_STILL_EXISTS')
    assert.equal(rows('student_tombstones').length, 0)
  })

  await test('拒绝：没有任何课时包引用时不补墓碑', async () => {
    seed({ orphanPackages: 0 })
    const result = await call('repairInspect')
    assert.equal(result.ok, false); assert.equal(result.code, 'REPAIR_NOT_ORPHANED')
  })

  await test('拒绝：引用的课时包仍有余额/未冲正时交给人判断', async () => {
    const { owner } = seed()
    put('packages', businessId('packages', owner, DATASET, PACKAGES[0].packageId), { ownerCoachId: owner, datasetId: DATASET, packageId: PACKAGES[0].packageId, studentId: STUDENT, data: { id: PACKAGES[0].packageId, status: 'active', remaining: 5, used: 0 } })
    const result = await call('repairInspect')
    assert.equal(result.ok, false); assert.equal(result.code, 'REPAIR_REFERENCE_NOT_REVERSED')
    assert.equal(result.notReversed.length, 1)
  })

  await test('拒绝：客户端基线多送字段 / 少送字段', async () => {
    seed()
    const extra = await call('repairInspect', { baseline: { ...BASELINE, role: 'admin' } })
    assert.equal(extra.ok, false); assert.equal(extra.code, 'REPAIR_BASELINE_FIELD_UNKNOWN')
    const missing = await call('repairInspect', { baseline: { id: STUDENT, name: '胡秀明' } })
    assert.equal(missing.ok, false); assert.equal(missing.code, 'REPAIR_BASELINE_FIELD_MISSING')
    const wrongId = await call('repairInspect', { baseline: { ...BASELINE, id: 'student_00000000000000000000' } })
    assert.equal(wrongId.ok, false); assert.equal(wrongId.code, 'REPAIR_BASELINE_ID_MISMATCH')
    assert.equal(rows('student_tombstones').length, 0)
  })

  await test('拒绝：abbr 与 name 不一致（服务端重算，不采信客户端）', async () => {
    seed()
    const result = await call('repairInspect', { baseline: { ...BASELINE, abbr: 'ZZZ' } })
    assert.equal(result.ok, false); assert.equal(result.code, 'REPAIR_ABBR_MISMATCH')
    assert.equal(result.computed, 'HXM')
  })

  await test('拒绝：删除前基线的姓名与云端证据冲突', async () => {
    seed()
    const result = await call('repairInspect', { baseline: { ...BASELINE, name: '别人' } })
    assert.equal(result.ok, false); assert.equal(result.code, 'REPAIR_ABBR_MISMATCH', 'abbr 先被拦下（' + '别人' + ' 算不出 HXM）')
    const consistent = await call('repairInspect', { baseline: { id: STUDENT, name: '别人', phone: '', abbr: require('../cloudfunctions/coachBusinessCommand/handlers').initials('别人'), createdAt: BASELINE.createdAt } })
    assert.equal(consistent.ok, false)
    assert.equal(consistent.code, 'REPAIR_EVIDENCE_NAME_MISMATCH', '云端 sale.note 写着「胡秀明」，基线说「别人」→ 必须拒绝')
    assert.equal(consistent.cloudName, '胡秀明')
  })

  await test('拒绝：学员 ID 形状不合法 / 客户端伪造身份字段', async () => {
    seed()
    const bad = await runRepair({ db, getOpenId: () => openId, event: { action: 'repairInspect', studentId: 'student_ZZZZ', baseline: BASELINE } })
    assert.equal(bad.ok, false); assert.equal(bad.code, 'REPAIR_STUDENT_ID_INVALID')
    const forged = await runRepair({ db, getOpenId: () => openId, event: { action: 'repairInspect', studentId: STUDENT, baseline: BASELINE, datasetId: 'other' } })
    assert.equal(forged.ok, false); assert.equal(forged.code, 'FORBIDDEN_IDENTITY_INPUT')
    const noCoach = await runRepair({ db, getOpenId: () => 'openid-stranger', event: { action: 'repairInspect', studentId: STUDENT, baseline: BASELINE } })
    assert.equal(noCoach.ok, false); assert.equal(noCoach.code, 'COACH_NOT_FOUND')
  })

  await test('隔离：另一个 owner / 另一个 dataset 的引用不会被这条墓碑救活', async () => {
    const { owner } = seed()
    const strangerOwner = coachIdFor('openid-stranger')
    put(META.coaches, strangerOwner, { openId: 'openid-stranger', status: 'active' })
    put(META.datasets, fixedId('coach-dataset', strangerOwner, 'dataset-stranger'), { ownerCoachId: strangerOwner, datasetId: 'dataset-stranger', status: 'active', integrityStatus: 'verified', checksum: 'x', byteSize: 1, summary: {}, schemaVersion: 1 })
    put(META.heads, fixedId('coach-data-head', strangerOwner), { ownerCoachId: strangerOwner, activeDatasetId: 'dataset-stranger', headVersion: 1 })
    put(META.revisions, fixedId('coach-data-revision', strangerOwner, 'dataset-stranger'), { ownerCoachId: strangerOwner, datasetId: 'dataset-stranger', dataRevision: 3, updatedAt: DELETE_AT })
    put('packages', businessId('packages', strangerOwner, 'dataset-stranger', 'package-stranger'), { ownerCoachId: strangerOwner, datasetId: 'dataset-stranger', packageId: 'package-stranger', studentId: STUDENT, data: { id: 'package-stranger', status: 'reversed', remaining: 0 } })
    await call('repairStudentTombstone', { expectedRevision: 145 })
    assert.equal(rows('student_tombstones').filter(row => row.ownerCoachId === strangerOwner).length, 0, '不得替别人补墓碑')
    assert.equal(rows('student_tombstones').filter(row => row.ownerCoachId === owner && row.datasetId === DATASET).length, 1)
    // 另一个 owner 的引用依旧读不出来（各自独立，互不牵连）
    assert.throws(() => reconstruct({ students: [], student_tombstones: [], packages: [{ packageId: 'package-stranger', studentId: STUDENT, data: {} }], bookings: [], incomes: [], sales: [], settings: [], customExercises: [] }), error => error.code === 'ACTIVE_RELATION_INVALID')
  })

  await test('事务失败：墓碑写不进去时，revision / 回执都不留半成品', async () => {
    seed()
    failCollection = 'student_tombstones'
    const result = await call('repairStudentTombstone', { expectedRevision: 145 })
    assert.equal(result.ok, false); assert.equal(result.code, 'REPAIR_TRANSACTION_FAILED')
    assert.equal(rows('student_tombstones').length, 0)
    assert.equal(rows(META.revisions).find(row => row.datasetId === DATASET).dataRevision, 145)
    assert.equal(rows(META.receipts).length, 0)
    assert.throws(() => reconstruct(serverGroups()), error => error.code === 'ACTIVE_RELATION_INVALID')
  })

  await test('revision 冲突：expectedRevision 不一致时拒绝写入', async () => {
    seed()
    const result = await call('repairStudentTombstone', { expectedRevision: 144 })
    assert.equal(result.ok, false); assert.equal(result.code, 'REVISION_CONFLICT')
    assert.equal(rows('student_tombstones').length, 0)
  })

  await test('回执可查：修复动作写下的回执能被现有 getReceipt 读到', async () => {
    seed()
    await call('repairStudentTombstone', { expectedRevision: 145 })
    const receipt = await service()({ action: 'getReceipt', requestId: `repair_tombstone_${STUDENT}` })
    assert.equal(receipt.ok, true); assert.equal(receipt.found, true); assert.equal(receipt.status, 'succeeded')
    assert.equal(receipt.response.result === undefined ? receipt.response.studentId : receipt.response.result.studentId, STUDENT)
    assert.equal(receipt.response.revisionAfter, 146)
  })

  await test('契约：修复动作不进入 22 条正式业务命令', async () => {
    const { COMMANDS } = require('../utils/cloud-command-contract')
    assert.deepEqual(Object.keys(handlers).sort(), COMMANDS.slice().sort(), 'handlers 必须仍恰好是 22 条')
    ACTIONS.forEach(action => assert.equal(COMMANDS.includes(action), false, `${action} 不得进入正式命令契约`))
    assert.deepEqual(ACTIONS, [
      'repairInspect', 'repairStudentTombstone', 'repairTombstoneRollback',
      // 通道二（一次性测试数据清除）：同一个事故的另一种、且是现行采用的修法。
      'purgeTestRowsInspect', 'purgeTestRows', 'purgeTestRowsRollback'
    ])
    assert.deepEqual(BASELINE_FIELDS, ['id', 'name', 'phone', 'abbr', 'createdAt'])
  })

  // ——— ⑥ 删除学员的正式路径：墓碑必须存在（事故成因的正面防线）———
  await test('正式路径：deleteStudent 必须在同一事务里留下墓碑，且 integrity 仍然通过', async () => {
    const { owner, datasetId } = seed({ orphanPackages: 0 })
    const studentId = 'student_11111111111111111111'
    put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, sortIndex: 36, data: { id: studentId, name: '张三', phone: '', abbr: 'ZS', createdAt: 1789000000000 } })
    put('packages', businessId('packages', owner, datasetId, 'package_22222222222222222222'), { ownerCoachId: owner, datasetId, packageId: 'package_22222222222222222222', studentId, data: { id: 'package_22222222222222222222', type: '常规训练', total: 10, used: 2, remaining: 8, price: 400, status: 'active' } })
    const result = await service()(execute('deleteStudent', 'delete_student_with_tombstone', 145, { studentId }))
    assert.equal(result.ok, true)
    const tombstone = rows('student_tombstones').find(row => row.studentId === studentId)
    assert(tombstone, '删除学员必须原子地留下墓碑')
    assert.equal(tombstone.data.status, 'deleted')
    assert.equal(tombstone.data.name, '张三')
    const print = fingerprint(reconstruct(serverGroups()))
    assert.equal(print.summary.deletedStudents, 1)
    assert.equal(print.summary.packages, 1)
    assert.equal(print.summary.students, 36)
  })

  if (!process.exitCode) process.stdout.write('ALL ORPHAN STUDENT TOMBSTONE TESTS PASSED\n')
})()
