// 通道二（一次性测试数据清除）的专项测试：**胡秀明 4 行测试遗留数据的一次性安全清除 + 回滚**。
//
// 背景（2026-09-22 用户重新判定）：`student_aff17e8f86dd642b75d9`（胡秀明）是**测试数据**，
// 可以彻底删除、不需要保留历史。于是不再走通道一（补 1 行墓碑），改用更干净的方案：把这 4 行
// **唯一引用它**的测试遗留记录整组清掉 —— 现场自己就干净了，两个读端自然恢复。
//
// 本文件钉死六件事：
//   ① 白名单常量 == 恢复点镜像（测试自带**独立副本**，不是从模块里抄回来的 —— 否则恒真）；
//   ② 4 个字面 _id 恰好等于按「审计时的 owner + 数据代次 + 业务 id」现算的规范行 id；
//   ③ 清除前 reconstruct 抛 ACTIVE_RELATION_INVALID（复现事故）、清除后通过（事故消失）；
//   ④ 只删这 4 行 —— 其余每一行、每一个数字逐字节未变（含业绩口径与收入）；
//   ⑤ 回滚按原 _id 原样插回，8 个集合逐字节回到清除前；
//   ⑥ fail-closed 矩阵：行内容被改 / 只剩一部分 / 有别的行引用他 / 学员在册 / 已有墓碑 /
//      换了数据代次 / 客户端想指定目标 / 事务失败 —— 一律拒绝且一行都不写。
const assert = require('assert')
const { META, coachIdFor, fixedId, createService } = require('../cloudfunctions/coachBusinessCommand/core')
const { handlers } = require('../cloudfunctions/coachBusinessCommand/handlers')
const {
  runRepair, ACTIONS, PURGE, PURGE_ROW_COUNT, PURGE_COLLECTIONS, purgeTargetsOf,
  PURGE_INPUT_FIELDS, PURGE_TARGET_CARRIER_FIELDS, PLATFORM_INJECTED_EVENT_FIELDS
} = require('../cloudfunctions/coachBusinessCommand/repair')
const { reconstruct, fingerprint } = require('../cloudfunctions/readMyActiveCoachData/integrity')
const { reconstructCandidate, integrity: clientIntegrity } = require('../utils/candidate-dataset')

const STUDENT = 'student_aff17e8f86dd642b75d9'
const OWNER_OPENID = 'openid-owner'
const DATASET = 'candidate_f971f032ca88dc3a2b656a6654d9a314'
// 生产 ownerCoachId：取自恢复点行的 ownerCoachId 字段（= sha256('coach:'+真实 openid).slice(0,32)）。
// 测试进程里拿不到真实 openid，所以这个值是**独立常量**；它与白名单字面 _id 的推导关系由
// 「常量：4 个字面 _id 恰好等于…」那条断言（用 fixedId 独立再算一遍）钉死。
const REAL_OWNER = '9fd6a9a0594da9a9337d923f39ad1b3b'
const REVISION = 145
const BUSINESS = ['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']

// —— 恢复点镜像的**独立副本**（2026-09-22 15:54:46 只读转储，逐字节手抄）——
// 它与 repair.js 里的 PURGE 常量是两份独立材料：下面第 1 条断言就是在比这两份。
const AUDITED = [
  {
    collection: 'packages',
    _id: '0be4b6ce94778d1d323d9dd1e98654f0',
    businessId: 'package_b65ca3885f8275cd8522',
    body: {
      packageId: 'package_b65ca3885f8275cd8522',
      studentId: STUDENT,
      saleId: 'sale_5a0fd8d0ada348f647f2',
      studentSortIndex: 36,
      sortIndex: 1,
      data: {
        id: 'package_b65ca3885f8275cd8522', type: '常规训练', total: 20, used: 0, remaining: 0,
        price: 300, status: 'reversed', createdAt: 1789827724553, saleDate: '2026-09-19',
        saleId: 'sale_5a0fd8d0ada348f647f2', reversedAt: 1789910559110
      }
    }
  },
  {
    collection: 'packages',
    _id: '32ee907a44e29d0a91436061fb69f509',
    businessId: 'package_1f8bf80bb35e9ba14973',
    body: {
      packageId: 'package_1f8bf80bb35e9ba14973',
      studentId: STUDENT,
      saleId: 'sale_7d07b388a1f76c973d13',
      studentSortIndex: 36,
      sortIndex: 0,
      data: {
        id: 'package_1f8bf80bb35e9ba14973', type: '常规训练', total: 20, used: 0, remaining: 0,
        price: 300, status: 'reversed', createdAt: 1789827678578, saleDate: '2026-09-19',
        saleId: 'sale_7d07b388a1f76c973d13', reversedAt: 1789910569191
      }
    }
  },
  {
    collection: 'sales',
    _id: '6d96ef507157a273e2a76fc4a8eafed4',
    businessId: 'sale_7d07b388a1f76c973d13',
    body: {
      saleId: 'sale_7d07b388a1f76c973d13',
      studentId: STUDENT,
      packageId: 'package_1f8bf80bb35e9ba14973',
      sortIndex: 47,
      data: {
        id: 'sale_7d07b388a1f76c973d13', source: 'course', status: 'reversed',
        studentId: STUDENT, packageId: 'package_1f8bf80bb35e9ba14973',
        typeName: '常规训练', quantity: 20, unitPrice: 300, amount: 5800, date: '2026-09-19',
        note: '胡秀明 · 常规训练 20节', createdAt: 1789827678578, reversedAt: 1789910569191
      }
    }
  },
  {
    collection: 'sales',
    _id: '7ed26de3385df8a49791c2d2f21585df',
    businessId: 'sale_5a0fd8d0ada348f647f2',
    body: {
      saleId: 'sale_5a0fd8d0ada348f647f2',
      studentId: STUDENT,
      packageId: 'package_b65ca3885f8275cd8522',
      sortIndex: 48,
      data: {
        id: 'sale_5a0fd8d0ada348f647f2', source: 'course', status: 'reversed',
        studentId: STUDENT, packageId: 'package_b65ca3885f8275cd8522',
        typeName: '常规训练', quantity: 20, unitPrice: 300, amount: 5800, date: '2026-09-19',
        note: '胡秀明 · 常规训练 20节', createdAt: 1789827724553, reversedAt: 1789910559110
      }
    }
  }
]

// —— 假云数据库（与 orphan-student-tombstone.test.js 同一套替身：事务用草稿、提交才落盘）——
const copy = value => JSON.parse(JSON.stringify(value))
const names = [...Object.values(META), ...BUSINESS, 'coach_sandbox_heads', 'coach_sandbox_revisions', 'coach_sandbox_receipts']
const stores = Object.fromEntries(names.map(name => [name, new Map()]))
let failCollection = '', queue = Promise.resolve(), openId = OWNER_OPENID, clock = 1790000000000

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
const clear = () => { Object.values(stores).forEach(store => store.clear()); failCollection = ''; queue = Promise.resolve(); openId = OWNER_OPENID }
const businessId = (name, owner, datasetId, id) => fixedId(`coach-business-${name}`, owner, `${datasetId}:${id}`)
const rowOf = (name, id) => stores[name].get(id)
const rows = name => [...stores[name].values()].map(copy)
const snapshot = () => Object.fromEntries(names.map(name => [name, rows(name)]))
const revisionOf = () => rows(META.revisions).find(row => row.datasetId === DATASET)
// 目标行就是**审计过的那个字面 _id**（不是现算的）—— 这正是「严格限定这 4 个已确认 _id」。
const targetRowId = item => item._id

// 现场：36 位在册学员 + 真实学员的课时包/销售/课程/收入 + 「已被删除但没留墓碑」的胡秀明的 4 行。
// 规模不必等于生产，但**覆盖面**要一样：真实业务记录三类都要有，才验得出"没被误伤"。
function seed({ orphan = true, packages = 2, datasetId = DATASET } = {}) {
  const owner = coachIdFor(OWNER_OPENID)
  put(META.coaches, owner, { openId: OWNER_OPENID, status: 'active' })
  put(META.datasets, fixedId('coach-dataset', owner, datasetId), { ownerCoachId: owner, datasetId, status: 'active', integrityStatus: 'verified', checksum: 'activation-baseline', byteSize: 1, summary: {}, counts: {}, amounts: {}, schemaVersion: 1 })
  put(META.heads, fixedId('coach-data-head', owner), { ownerCoachId: owner, activeDatasetId: datasetId, headVersion: 9 })
  put(META.revisions, fixedId('coach-data-revision', owner, datasetId), { ownerCoachId: owner, datasetId, dataRevision: REVISION, updatedAt: 1789913938285 })

  for (let index = 0; index < 36; index += 1) {
    const id = `mtfe${String(index).padStart(16, '0')}`
    put('students', businessId('students', owner, datasetId, id), { ownerCoachId: owner, datasetId, studentId: id, sourceOrder: index, data: { id, name: `学员${index}`, phone: '', abbr: 'XY', createdAt: 1789000000000 + index } })
  }
  // 张三：一份未冲正的课时包 + 一笔有效课程销售（业绩口径的"真实数字"就靠它）
  put('packages', businessId('packages', owner, datasetId, 'package_zhang_1'), { ownerCoachId: owner, datasetId, packageId: 'package_zhang_1', studentId: 'mtfe0000000000000000', saleId: 'sale_zhang_1', studentSortIndex: 0, sortIndex: 9, data: { id: 'package_zhang_1', type: '常规训练', total: 10, used: 2, remaining: 8, price: 400, status: 'active', saleDate: '2026-09-10', saleId: 'sale_zhang_1' } })
  put('sales', businessId('sales', owner, datasetId, 'sale_zhang_1'), { ownerCoachId: owner, datasetId, saleId: 'sale_zhang_1', studentId: 'mtfe0000000000000000', packageId: 'package_zhang_1', sortIndex: 20, data: { id: 'sale_zhang_1', source: 'course', status: 'active', studentId: 'mtfe0000000000000000', packageId: 'package_zhang_1', typeName: '常规训练', quantity: 10, unitPrice: 400, amount: 4000, date: '2026-09-10', note: '学员0 · 常规训练 10节' } })
  put('sales', businessId('sales', owner, datasetId, 'sale_manual_1'), { ownerCoachId: owner, datasetId, saleId: 'sale_manual_1', studentId: '', sortIndex: 21, data: { id: 'sale_manual_1', source: 'manual', status: 'active', amount: 1200, date: '2026-09-12', note: '手工业绩' } })
  // 刘：已冲正的课时包（不得被本次清除连带）
  put('packages', businessId('packages', owner, datasetId, 'package_liu_1'), { ownerCoachId: owner, datasetId, packageId: 'package_liu_1', studentId: 'mtfe0000000000000001', saleId: 'sale_liu_1', studentSortIndex: 1, sortIndex: 10, data: { id: 'package_liu_1', type: '常规训练', total: 3, used: 0, remaining: 0, price: 400, status: 'reversed', saleDate: '2026-09-18', saleId: 'sale_liu_1', reversedAt: 1789910000000 } })
  put('sales', businessId('sales', owner, datasetId, 'sale_liu_1'), { ownerCoachId: owner, datasetId, saleId: 'sale_liu_1', studentId: 'mtfe0000000000000001', packageId: 'package_liu_1', sortIndex: 22, data: { id: 'sale_liu_1', source: 'course', status: 'reversed', studentId: 'mtfe0000000000000001', packageId: 'package_liu_1', typeName: '常规训练', quantity: 3, unitPrice: 400, amount: 1200, date: '2026-09-18', note: '学员1 · 常规训练 3节', reversedAt: 1789910000000 } })
  put('bookings', businessId('bookings', owner, datasetId, 'booking_zhang_1'), { ownerCoachId: owner, datasetId, bookingId: 'booking_zhang_1', studentId: 'mtfe0000000000000000', packageId: 'package_zhang_1', sortIndex: 5, data: { id: 'booking_zhang_1', studentId: 'mtfe0000000000000000', packageId: 'package_zhang_1', date: '2026-09-22', hour: 20, minute: 0, status: 'done', studentName: '学员0' } })
  put('bookings', businessId('bookings', owner, datasetId, 'booking_zhang_2'), { ownerCoachId: owner, datasetId, bookingId: 'booking_zhang_2', studentId: 'mtfe0000000000000000', packageId: 'package_zhang_1', sortIndex: 6, data: { id: 'booking_zhang_2', studentId: 'mtfe0000000000000000', packageId: 'package_zhang_1', date: '2026-09-24', hour: 19, minute: 0, status: 'booked', studentName: '学员0' } })
  put('incomes', businessId('incomes', owner, datasetId, 'income_zhang_1'), { ownerCoachId: owner, datasetId, incomeId: 'income_zhang_1', studentId: 'mtfe0000000000000000', bookingId: 'booking_zhang_1', sortIndex: 5, data: { id: 'income_zhang_1', studentId: 'mtfe0000000000000000', bookingId: 'booking_zhang_1', amount: 349.39, date: '2026-09-22', studentName: '学员0' } })
  put('settings', businessId('settings', owner, datasetId, 'settings'), { ownerCoachId: owner, datasetId, data: { coachName: '张教练', defaultHourRate: 349.39 } })
  put('customExercises', businessId('customExercises', owner, datasetId, 'ex_1'), { ownerCoachId: owner, datasetId, data: { id: 'ex_1', name: '杠铃深蹲', category: '腿' } })

  // ⚠️ 必须把「2 个课时包 **和** 与之配对的那 2 笔销售」一起放进现场。
  //    旧写法 `AUDITED.slice(0, packages)` 取的是数组前 N 项，而 AUDITED 的排列是
  //    [包, 包, 销售, 销售] ⇒ slice(0,2) 只落地**两个包**，两笔销售从未进过库，
  //    于是白名单 4 行只存在 2 行。这**不是另一个场景**，是夹具没造出它名字里说的现场：
  //    purgeVerdict 会（正确地）按 PURGE_PARTIAL_STATE 拒绝，所有"应当成功"的用例
  //    全部走不到正题。当时没暴露，是因为 fail() 的 ok 被 extra 覆盖成了 true ——
  //    「拒绝」被伪装成「成功」。两处一起修才看得见真相。
  if (orphan) {
    const packageRows = AUDITED.filter(item => item.collection === 'packages').slice(0, packages)
    const pairedSales = new Set(packageRows.map(item => item.body.saleId))
    ;[...packageRows, ...AUDITED.filter(item => item.collection === 'sales' && pairedSales.has(item.body.saleId))]
      .forEach(item => put(item.collection, targetRowId(item), { ...copy(item.body), ownerCoachId: owner, datasetId }))
  }
  return { owner, datasetId }
}

const serverGroups = () => Object.fromEntries(['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises'].map(name => [name, rows(name)]))
const clientCollections = () => Object.fromEntries(['students', 'studentTombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises'].map(name => [name, rows(name === 'studentTombstones' ? 'student_tombstones' : name)]))
const call = (action, extra = {}) => runRepair({ db, getOpenId: () => openId, event: { action, ...extra } })
const service = () => createService({ db, getOpenId: () => openId, handlers, now: () => ++clock })

async function test(name, fn) {
  try { clear(); await fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}

;(async () => {
  // ——— ① 常量自证：白名单必须真的等于恢复点镜像（两份独立材料逐字段对） ———
  await test('常量：PURGE.rows 逐字段等于恢复点镜像（独立副本，非从模块抄回）', async () => {
    assert.strictEqual(PURGE.studentId, STUDENT)
    assert.strictEqual(PURGE.ownerCoachId, REAL_OWNER)
    assert.strictEqual(PURGE.datasetId, DATASET)
    assert.strictEqual(PURGE.rows.length, AUDITED.length)
    assert.deepStrictEqual(copy(PURGE.rows), AUDITED)
    assert.strictEqual(PURGE.capturedRevision, REVISION)
    assert.strictEqual(PURGE.capturedChecksum, '515b7e0d802a88be8809fd41c84261c89bb0e156c14f41fa413d65d806b872d1')
  })

  await test('常量：4 个字面 _id 恰好等于按（审计 owner + 数据代次 + 业务 id）现算的规范行 id', async () => {
    const targets = purgeTargetsOf()
    assert.strictEqual(targets.length, 4)
    targets.forEach((target, index) => {
      assert.strictEqual(target.rowId, AUDITED[index]._id, `${AUDITED[index].businessId} 的字面 _id 与独立副本不一致`)
      assert.strictEqual(target.auditRowId, target.rowId, `${AUDITED[index].businessId} 现算 id 与白名单不一致`)
      // 用 fixedId 独立再算一遍：不采信模块内部的推导结果
      assert.strictEqual(
        fixedId(`coach-business-${AUDITED[index].collection}`, REAL_OWNER, `${DATASET}:${AUDITED[index].businessId}`),
        AUDITED[index]._id
      )
    })
    assert.strictEqual(new Set(targets.map(target => target.rowId)).size, 4, '4 个行 id 必须互不相同')
  })

  await test('常量：换 owner / 换数据集 ⇒ 现算 id 立刻不等于白名单（字面 id 只在审计那一代存在）', async () => {
    AUDITED.forEach(item => {
      const kind = `coach-business-${item.collection}`
      assert.notStrictEqual(fixedId(kind, coachIdFor('openid-stranger'), `${DATASET}:${item.businessId}`), item._id)
      assert.notStrictEqual(fixedId(kind, REAL_OWNER, `candidate_0000000000000000000000000000:${item.businessId}`), item._id)
    })
  })

  await test('常量：白名单恰好 4 行、只落在 packages / sales', async () => {
    assert.strictEqual(PURGE_ROW_COUNT, 4)
    assert.deepStrictEqual([...PURGE_COLLECTIONS].sort(), ['packages', 'sales'])
    assert.strictEqual(PURGE.rows.filter(row => row.collection === 'packages').length, 2)
    assert.strictEqual(PURGE.rows.filter(row => row.collection === 'sales').length, 2)
  })

  // ——— ② 复现事故 → 清除 → 事故消失 ———
  await test('复现：清除前云端 reconstruct 抛 ACTIVE_RELATION_INVALID（整账号读不出来）', async () => {
    seed()
    assert.throws(() => reconstruct(serverGroups()), error => error.code === 'ACTIVE_RELATION_INVALID')
    assert.throws(() => reconstructCandidate(clientCollections()), error => error.code === 'ORPHAN_PACKAGE')
  })

  await test('预演 purgeTestRowsInspect：只读，一行都不写', async () => {
    seed()
    const before = snapshot()
    const result = await call('purgeTestRowsInspect')
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.studentId, STUDENT)
    assert.strictEqual(result.datasetId, DATASET)
    assert.strictEqual(result.revisionBefore, REVISION)
    assert.strictEqual(result.presentRows, 4)
    assert.strictEqual(result.alreadyPurged, false)
    assert.deepStrictEqual(result.targets.map(target => target.rowId).sort(), AUDITED.map(item => item._id).sort())
    assert.strictEqual(result.impact.orphanReferencesBefore, 2)
    assert.strictEqual(result.impact.countsBefore.packages, 4)
    assert.strictEqual(result.impact.countsBefore.sales, 5)
    assert.strictEqual(result.impact.countsBefore.students, 36)
    assert.strictEqual(result.impact.salesAmountBefore, 18000)
    assert.strictEqual(result.impact.activeSalesAmountBefore, 5200)
    assert.strictEqual(result.impact.incomeAmountBefore, 349.39)
    assert.deepStrictEqual(snapshot(), before, '预演阶段禁止任何写入')
  })

  await test('清除：只删这 4 行 —— 其余每一行逐字节未变，revision 只 +1', async () => {
    seed()
    const before = snapshot()
    const result = await call('purgeTestRows', { expectedRevision: REVISION })
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.purged, true)
    assert.strictEqual(result.removedCount, 4)
    assert.strictEqual(result.revisionBefore, REVISION)
    assert.strictEqual(result.revisionAfter, REVISION + 1)
    assert.deepStrictEqual(result.removed.map(item => item.rowId).sort(), AUDITED.map(item => item._id).sort())

    const after = snapshot()
    const removedKeys = AUDITED.map(item => `${item.collection} ${item._id}`).sort()
    const goneKeys = []
    BUSINESS.forEach(name => {
      const beforeIds = new Set(before[name].map(row => String(row._id)))
      const afterIds = new Set(after[name].map(row => String(row._id)))
      before[name].forEach(row => { if (!afterIds.has(String(row._id))) goneKeys.push(`${name} ${row._id}`) })
      after[name].forEach(row => { if (!beforeIds.has(String(row._id))) goneKeys.push(`!! 新增 ${name} ${row._id}`) })
      // 留存的每一行必须逐字节一致（不是"字段相等"，是整个对象 deepStrictEqual）
      const beforeById = new Map(before[name].map(row => [String(row._id), row]))
      after[name].forEach(row => assert.deepStrictEqual(row, beforeById.get(String(row._id)), `${name} ${row._id} 被改动了`))
    })
    assert.deepStrictEqual(goneKeys.sort(), removedKeys, '消失的行必须恰好是白名单 4 行')
    // 数据面之外只允许 revision 与 receipts 动
    assert.strictEqual(revisionOf().dataRevision, REVISION + 1)
    assert.strictEqual(rows(META.receipts).length, 1)
  })

  await test('清除后：reconstruct 通过，事故消失；业绩口径 / 收入 / 名册 / 课程一分不变', async () => {
    seed()
    const inspected = await call('purgeTestRowsInspect')
    const result = await call('purgeTestRows', { expectedRevision: REVISION })
    // 这一行在清除前会抛 ACTIVE_RELATION_INVALID —— 能跑通本身就是"事故消失"的判据
    const print = fingerprint(reconstruct(serverGroups()))
    assert.strictEqual(print.summary.packages, inspected.impact.countsBefore.packages - 2)
    assert.strictEqual(print.summary.sales, inspected.impact.countsBefore.sales - 2)
    assert.strictEqual(print.summary.students, inspected.impact.countsBefore.students)
    assert.strictEqual(print.summary.students, 36, '名册一行不动')
    assert.strictEqual(print.summary.completedBookings, 1, '已完成课程一行不动')
    assert.strictEqual(print.summary.bookings, inspected.impact.countsBefore.bookings)
    assert.strictEqual(print.summary.incomes, inspected.impact.countsBefore.incomes)
    // 原始金额只少掉那两笔已冲正的 5800×2（只存在于云端自检指纹里，不进任何界面口径）
    assert.strictEqual(print.amounts.sales, inspected.impact.salesAmountBefore - 11600)
    assert.strictEqual(print.amounts.incomes, inspected.impact.incomeAmountBefore)
    assert.strictEqual(print.amounts.incomes, 349.39, '收入一分不动')
    // 业绩口径（stats.js 只算 status !== "reversed"）必须**一分不变**
    assert.strictEqual(result.impact.activeSalesAmountBefore, 5200)
    assert.strictEqual(result.impact.activeSalesAmountAfter, result.impact.activeSalesAmountBefore)
    assert.strictEqual(result.impact.activeSalesCountAfter, result.impact.activeSalesCountBefore)
    assert.strictEqual(result.impact.orphanReferencesBefore, 2)
    assert.strictEqual(result.impact.orphanReferencesAfter, 0)
    assert.strictEqual(print.counts.sales, result.impact.salesCountAfter)
    assert.strictEqual(print.counts.packages, result.impact.countsAfter.packages)
    assert.strictEqual(print.counts.incomes, result.impact.incomeCountAfter)
  })

  await test('清除后：两个读端重建同一快照，checksum/byteSize/summary/counts/amounts 全部一致', async () => {
    seed()
    await call('purgeTestRows', { expectedRevision: REVISION })
    const server = fingerprint(reconstruct(serverGroups()))
    const client = clientIntegrity(reconstructCandidate(clientCollections()))
    assert.strictEqual(server.checksum, client.checksum)
    assert.strictEqual(server.byteSize, client.byteSize)
    assert.deepStrictEqual(server.summary, client.summary)
    assert.deepStrictEqual(server.counts, client.counts)
    assert.deepStrictEqual(server.amounts, client.amounts)
  })

  await test('清除后：回执存在且 succeeded，revisionAfter 与响应一致（可审计）', async () => {
    seed()
    const result = await call('purgeTestRows', { expectedRevision: REVISION })
    const receipts = rows(META.receipts)
    assert.strictEqual(receipts.length, 1)
    const receipt = receipts[0]
    assert.strictEqual(receipt.command, 'purgeTestRows')
    assert.strictEqual(receipt.status, 'succeeded')
    assert.strictEqual(receipt.requestId, result.requestId)
    assert.strictEqual(receipt.revisionBefore, REVISION)
    assert.strictEqual(receipt.revisionAfter, REVISION + 1)
    assert.strictEqual(receipt.response.removedCount, 4)
    assert.deepStrictEqual(receipt.response.removed.map(item => item.rowId).sort(), AUDITED.map(item => item._id).sort())
  })

  await test('幂等：再执行一次不重复删、不重复自增 revision', async () => {
    seed()
    const first = await call('purgeTestRows', { expectedRevision: REVISION })
    const second = await call('purgeTestRows', { expectedRevision: REVISION + 1 })
    assert.strictEqual(first.purged, true)
    assert.strictEqual(second.ok, true)
    assert.strictEqual(second.alreadyPurged, true)
    assert.strictEqual(second.purged, false)
    assert.strictEqual(second.idempotent, true)
    assert.strictEqual(revisionOf().dataRevision, REVISION + 1)
    assert.strictEqual(rows(META.receipts).length, 1)
  })

  // ——— ③ 回滚 ———
  await test('回滚：按原 _id 原样插回，8 个集合逐字节回到清除前', async () => {
    seed()
    const before = snapshot()
    // 基线指纹：按「清除后应有的样子」重建一次（把白名单 4 行摘掉再 reconstruct）。
    // 不能直接对原现场取指纹 —— 带着这 4 行时 reconstruct 会直接抛，那正是事故本身。
    const clearedGroups = () => {
      const groups = serverGroups()
      AUDITED.forEach(item => { groups[item.collection] = groups[item.collection].filter(row => String(row._id) !== item._id) })
      return groups
    }
    const clearedPrint = fingerprint(reconstruct(clearedGroups()))
    const purged = await call('purgeTestRows', { expectedRevision: REVISION })
    assert.strictEqual(purged.removedCount, 4)
    assert.deepStrictEqual(fingerprint(reconstruct(serverGroups())), clearedPrint, '清除后的快照必须恰好等于「摘掉这 4 行」的样子')

    const rolled = await call('purgeTestRowsRollback', { expectedRevision: REVISION + 1 })
    assert.strictEqual(rolled.ok, true)
    assert.strictEqual(rolled.restored, 4)
    assert.strictEqual(rolled.revisionAfter, REVISION + 2)
    // 业务数据（8 个集合）必须逐字节回到原状。按 _id 排序后比 —— 回滚是把行插回容器尾部，
    // 行的**集合**必须一样，物理存放顺序不算内容。
    const byId = (left, right) => String(left._id).localeCompare(String(right._id))
    BUSINESS.forEach(name => assert.deepStrictEqual(rows(name).sort(byId), before[name].slice().sort(byId), `${name} 没有回到清除前`))
    // 回到原状 ⇒ 两个读端又开始失败（这正是回滚的语义：把现场原样放回去）
    assert.throws(() => reconstruct(serverGroups()), error => error.code === 'ACTIVE_RELATION_INVALID')
    assert.throws(() => reconstructCandidate(clientCollections()), error => error.code === 'ORPHAN_PACKAGE')
  })

  await test('回滚：4 行本来就好端端时（等于镜像）不写入、revision 不变', async () => {
    seed()
    const rolled = await call('purgeTestRowsRollback')
    assert.strictEqual(rolled.ok, true)
    assert.strictEqual(rolled.alreadyIntact, true)
    assert.strictEqual(rolled.restored, 0)
    assert.strictEqual(rolled.revisionAfter, REVISION)
    assert.strictEqual(revisionOf().dataRevision, REVISION)
    assert.strictEqual(rows(META.receipts).length, 0)
  })

  // ——— ④ fail-closed 矩阵 ———
  await test('拒绝：任一行内容被改过（镜像不符）⇒ 一行都不删', async () => {
    const { owner } = seed()
    const tampered = { ...copy(AUDITED[0].body), ownerCoachId: owner, datasetId: DATASET, data: { ...copy(AUDITED[0].body.data), used: 3 } }
    put('packages', targetRowId(AUDITED[0]), tampered)
    const before = snapshot()
    const inspected = await call('purgeTestRowsInspect')
    assert.strictEqual(inspected.ok, false)
    assert.strictEqual(inspected.code, 'PURGE_ROW_MISMATCH')
    assert.strictEqual(inspected.mismatched.length, 1)
    const result = await call('purgeTestRows')
    assert.strictEqual(result.code, 'PURGE_ROW_MISMATCH')
    assert.deepStrictEqual(snapshot(), before, '被篡改时一个字都不许写')
  })

  await test('拒绝：白名单 4 行只剩一部分 ⇒ PURGE_PARTIAL_STATE', async () => {
    seed()
    stores.packages.delete(targetRowId(AUDITED[0]))
    const result = await call('purgeTestRows')
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'PURGE_PARTIAL_STATE')
    assert.strictEqual(rows('packages').length, 3)
  })

  await test('拒绝：4 行都不在、却没有本通道回执 ⇒ 不认领、不写入', async () => {
    seed({ orphan: false })
    const before = snapshot()
    const result = await call('purgeTestRows')
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'PURGE_ABSENT_WITHOUT_RECEIPT')
    assert.deepStrictEqual(snapshot(), before)
  })

  await test('拒绝：学员仍在名册里（真人一律不动）', async () => {
    const { owner } = seed()
    put('students', businessId('students', owner, DATASET, STUDENT), { ownerCoachId: owner, datasetId: DATASET, studentId: STUDENT, sortIndex: 36, data: { id: STUDENT, name: '胡秀明', phone: '', abbr: 'HXM', createdAt: 1789827653715 } })
    const inspected = await call('purgeTestRowsInspect')
    assert.strictEqual(inspected.ok, false)
    assert.strictEqual(inspected.code, 'PURGE_STUDENT_ALIVE')
    assert.strictEqual(rows('students').length, 37)
  })

  await test('拒绝：已存在该学员的墓碑（事故已被通道一处理，两条通道互斥）', async () => {
    const { owner } = seed()
    put('student_tombstones', businessId('student_tombstones', owner, DATASET, STUDENT), { ownerCoachId: owner, datasetId: DATASET, studentId: STUDENT, sortIndex: 36, data: { id: STUDENT, name: '胡秀明', phone: '', abbr: 'HXM', createdAt: 1789827653715, status: 'deleted', deletedAt: 1789913938285 } })
    const result = await call('purgeTestRows')
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'PURGE_TOMBSTONE_PRESENT')
    assert.strictEqual(rows('packages').length, 4)
  })

  await test('拒绝：除白名单 4 行外还有别的行引用该学员（现场变了）', async () => {
    const { owner } = seed()
    put('bookings', businessId('bookings', owner, DATASET, 'booking_orphan_1'), { ownerCoachId: owner, datasetId: DATASET, bookingId: 'booking_orphan_1', studentId: STUDENT, packageId: 'package_1f8bf80bb35e9ba14973', sortIndex: 90, data: { id: 'booking_orphan_1', studentId: STUDENT, status: 'booked', date: '2026-09-25', hour: 10, minute: 0 } })
    const before = snapshot()
    const result = await call('purgeTestRows')
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'PURGE_UNEXPECTED_REFERENCE')
    assert.strictEqual(result.unexpectedReferences.length, 1)
    assert.strictEqual(result.unexpectedReferences[0].collection, 'bookings')
    assert.deepStrictEqual(snapshot(), before)
  })

  await test('拒绝：换了数据代次（业务 id 相同、行 id 不同，本通道一律拒绝）', async () => {
    const OTHER_DATASET = 'candidate_5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b'
    const { owner } = seed({ datasetId: OTHER_DATASET })
    // 在新代次里按新代次现算 id 放一份"同名"的包与销售
    AUDITED.forEach(item => {
      put(item.collection, fixedId(`coach-business-${item.collection}`, owner, `${OTHER_DATASET}:${item.businessId}`), { ...copy(item.body), ownerCoachId: owner, datasetId: OTHER_DATASET })
    })
    const before = snapshot()
    const result = await call('purgeTestRows')
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'PURGE_DATASET_MISMATCH')
    assert.deepStrictEqual(snapshot(), before)
  })

  await test('拒绝：客户端想指定目标 / 夹带集合名与行 id / 查询条件', async () => {
    seed()
    const wrongTarget = await call('purgeTestRowsInspect', { studentId: 'student_00000000000000000000' })
    assert.strictEqual(wrongTarget.ok, false)
    assert.strictEqual(wrongTarget.code, 'PURGE_TARGET_IMMUTABLE')
    const extraField = await call('purgeTestRows', { collection: 'sales' })
    assert.strictEqual(extraField.ok, false)
    assert.strictEqual(extraField.code, 'PURGE_FIELD_UNKNOWN')
    assert.deepStrictEqual(extraField.unknown, ['collection'])
    // 拒绝必须带「形状摘录」：下一个未知字段冒出来时，一次点击就能定性（平台注入 vs 客户端发错）。
    assert.strictEqual(extraField.unknownShapes.length, 1)
    assert.strictEqual(extraField.unknownShapes[0].field, 'collection')
    assert.strictEqual(extraField.unknownShapes[0].type, 'string')
    assert.strictEqual(extraField.unknownShapes[0].preview, '"sales"')
    const withIds = await call('purgeTestRows', { rowIds: AUDITED.map(item => item._id) })
    assert.strictEqual(withIds.code, 'PURGE_FIELD_UNKNOWN')
    const withFilter = await call('purgeTestRows', { where: { status: 'reversed' } })
    assert.strictEqual(withFilter.code, 'PURGE_FIELD_UNKNOWN')
    assert.strictEqual(rows('packages').length, 4, '这些请求一条都不许落地')
  })

  await test('平台注入字段名必须与实测原文逐字符一致：tcbContext（不是 tbdContext）—— 手抄一个字母就白跑一轮部署', async () => {
    // 原文出处：2026-09-22 19:24:46 那次真实预演，模拟器 Storage 的 `coachRepairPurge:production` 记录：
    //   "message": "清除通道不接受这些字段：tcbContext"（且只列出这一个 ⇒ event 完整键集
    //   ⊆ {action, environment, userInfo, tcbContext}，没有第三个注入键）。
    // 上一版把这里写成 tbdContext（b/p 之差）⇒ 白名单等于没加，云上 v2 一字不差地又拒了一次。
    assert.deepStrictEqual([...PLATFORM_INJECTED_EVENT_FIELDS].sort(), ['tcbContext', 'userInfo'])
    assert.strictEqual(PLATFORM_INJECTED_EVENT_FIELDS.includes('tbdContext'), false, '错拼的名字绝不能被当成平台字段')

    seed()
    const inspected = await call('purgeTestRowsInspect', {
      userInfo: { appId: 'wx7aa0596956732b35', openId: 'o_test_openid' },
      tcbContext: { traceId: 'simulator-trace-1', source: 'devtools' }
    })
    assert.strictEqual(inspected.ok, true, `平台注入字段不该拦预演：${inspected.code || ''} ${inspected.message || ''}`)
    assert.strictEqual(inspected.presentRows, 4)
    assert.strictEqual(inspected.alreadyPurged, false)
    // 已知平台字段在白名单里 ⇒ 连名字都不进 ignoredFields，值更不回显。
    assert.deepStrictEqual(inspected.ignoredFields, [])
    assert.strictEqual(JSON.stringify(inspected).includes('simulator-trace-1'), false)
    assert.strictEqual(JSON.stringify(inspected).includes('o_test_openid'), false)
    // 预演是只读的：4 行原样都在。
    assert.strictEqual(rows('packages').length, 4)
  })

  await test('惰性未知字段：放行且只回名字/类型/键名（不回值）—— 「平台多注入一个字段」不再卡死通道', async () => {
    seed()
    const inspected = await call('purgeTestRowsInspect', {
      tbdContext: { traceId: 'typo-trace-should-not-echo', source: 'devtools' },
      someFuturePlatformField: 'value-should-not-echo'
    })
    assert.strictEqual(inspected.ok, true, `惰性未知字段不该拦预演：${inspected.code || ''} ${inspected.message || ''}`)
    assert.deepStrictEqual(inspected.ignoredFields.map(shape => shape.field).sort(), ['someFuturePlatformField', 'tbdContext'])
    for (const shape of inspected.ignoredFields) {
      // 只带 field / type（对象再加顶层键名），**没有 preview、没有值** —— 不把平台的未知内容搬进页面与 Storage。
      assert.deepStrictEqual(Object.keys(shape).filter(key => key !== 'keys').sort(), ['field', 'type'])
    }
    // 定性仍然够用：对象字段要给顶层键名。
    assert.deepStrictEqual(inspected.ignoredFields.find(shape => shape.field === 'tbdContext').keys, ['traceId', 'source'])
    const flat = JSON.stringify(inspected)
    assert.strictEqual(flat.includes('typo-trace-should-not-echo'), false)
    assert.strictEqual(flat.includes('value-should-not-echo'), false)
  })

  await test('惰性未知字段不影响「删什么」：带着一堆未知字段执行，仍然只删那 4 行', async () => {
    seed()
    const before = BUSINESS.map(name => rows(name).length)
    const committed = await call('purgeTestRows', {
      expectedRevision: REVISION,
      tbdContext: { a: 1 }, unknownThing: [1, 2, 3], userInfo: { openId: 'o_test_openid' }
    })
    assert.strictEqual(committed.ok, true, `带惰性未知字段的清除应当正常完成：${committed.code || ''} ${committed.message || ''}`)
    assert.strictEqual(committed.removedCount, 4)
    assert.deepStrictEqual(committed.removed.map(item => item.rowId).sort(), AUDITED.map(item => item._id).sort(), '删的必须恰好是那 4 个字面 _id')
    assert.strictEqual(revisionOf().dataRevision, REVISION + 1)
    // 逐集合清点：只有 packages −2、sales −2，其余六个集合一个都没动。
    const after = BUSINESS.map(name => rows(name).length)
    const delta = Object.fromEntries(BUSINESS.map((name, index) => [name, before[index] - after[index]]))
    assert.deepStrictEqual(delta, { students: 0, student_tombstones: 0, packages: 2, bookings: 0, incomes: 0, sales: 2, settings: 0, customExercises: 0 })
  })

  await test('目标载体字段一律硬拒（集合 / 行 id / 条件 / 数据集 / 主键）—— 这才是输入闸真正的保护面', async () => {
    seed()
    const before = BUSINESS.map(name => rows(name).length)
    // 逐个都必须是 PURGE_TARGET_CARRIER_FIELDS 的成员（对着真常量核对，不在测试里另抄一份名单）
    // ⚠️ datasetId 不在其中：它在**更上游**那一层就被拦了（core.js 的身份/数据集定位字段黑名单），
    //    拒绝码是 FORBIDDEN_IDENTITY_INPUT —— 更早更强，单独断言（见下）。
    const cases = ['collection', 'collections', 'rowIds', 'rowId', '_id', 'where', 'filter', 'query', 'documents', 'students', 'targets', 'businessId', 'keys']
    for (const field of cases) {
      assert.strictEqual(PURGE_TARGET_CARRIER_FIELDS.includes(field.toLowerCase()), true, `${field} 必须在目标载体黑名单里`)
      const answer = await call('purgeTestRows', { [field]: 'x' })
      assert.strictEqual(answer.ok, false, `${field} 必须被拒`)
      assert.strictEqual(answer.code, 'PURGE_FIELD_UNKNOWN', `${field} 的拒绝码`)
      assert.deepStrictEqual(answer.unknown, [field])
      assert.strictEqual(answer.unknownShapes.length, 1)
      assert.strictEqual(answer.unknownShapes[0].field, field)
      // 被拒的字段带形状摘录（类型 + 200 字预览）：一次点击就能定性。
      assert.strictEqual(answer.unknownShapes[0].type, 'string')
      assert.strictEqual(answer.unknownShapes[0].preview, '"x"')
    }
    // 数据集定位字段由**上游**那一层拦（core.js 的身份/数据集黑名单）—— 比本闸门更早、更强。
    const byDataset = await call('purgeTestRows', { datasetId: DATASET })
    assert.strictEqual(byDataset.ok, false)
    assert.strictEqual(byDataset.code, 'FORBIDDEN_IDENTITY_INPUT')
    assert.deepStrictEqual(BUSINESS.map(name => rows(name).length), before, '全被拒 ⇒ 一行都不许落地')
  })

  await test('内锁：repair.js 读到的 event 字段必须全部落在契约字段内（谁给清除路径加新入参，这里先红）', async () => {
    const fs = require('fs'), path = require('path')
    const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/coachBusinessCommand/repair.js'), 'utf8')
    // ⚠️ 先剥注释：解释性注释里写了 `event.xxx` 会把断言绊倒（这个坑踩过）。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const read = [...new Set([...code.matchAll(/(?<![A-Za-z0-9_$])event\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]))].sort()
    assert.deepStrictEqual(read, ['action', 'environment', 'expectedRevision', 'studentId'], '这条一变，输入闸与「目标载体」黑名单必须同步更新')
    // 这正是"未列举字段在结构上惰性"的机器证明：清除通道压根读不到它们。
    assert.deepStrictEqual(read.filter(field => !PURGE_INPUT_FIELDS.includes(field)), [])
  })

  await test('通道版本出口：每个响应（成功或拒绝）都带 channelVersion —— 让「云上跑的是哪版」可观测', async () => {
    seed()
    const ok = await call('purgeTestRowsInspect', { userInfo: {}, tcbContext: {} })
    assert.strictEqual(ok.channelVersion, 3, '成功响应必须带通道版本')
    const rejected = await call('purgeTestRows', { collection: 'sales' })
    assert.strictEqual(rejected.channelVersion, 3, '拒绝响应也必须带通道版本')
    assert.strictEqual(rejected.ok, false)
    const unknownAction = await call('purgeWhatNot', {})
    assert.strictEqual(unknownAction.channelVersion, 3, '未知动作也要带版本（说明 identity/环境层都过了）')
  })

  await test('拒绝：伪造身份 / 数据集定位字段 / 非本账号', async () => {
    seed()
    const forged = await runRepair({ db, getOpenId: () => openId, event: { action: 'purgeTestRows', datasetId: 'someone-else' } })
    assert.strictEqual(forged.ok, false)
    assert.strictEqual(forged.code, 'FORBIDDEN_IDENTITY_INPUT')
    const stranger = await runRepair({ db, getOpenId: () => 'openid-stranger', event: { action: 'purgeTestRows' } })
    assert.strictEqual(stranger.ok, false)
    assert.strictEqual(stranger.code, 'COACH_NOT_FOUND')
  })

  await test('拒绝：expectedRevision 不一致', async () => {
    seed()
    const result = await call('purgeTestRows', { expectedRevision: REVISION - 1 })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'REVISION_CONFLICT')
    assert.strictEqual(rows('packages').length, 4)
    assert.strictEqual(revisionOf().dataRevision, REVISION)
  })

  await test('事务失败：删不掉时一行都不删、revision 不变、不留回执', async () => {
    seed()
    const before = snapshot()
    failCollection = 'sales'
    const result = await call('purgeTestRows', { expectedRevision: REVISION })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'REPAIR_TRANSACTION_FAILED')
    assert.deepStrictEqual(snapshot(), before)
    assert.strictEqual(revisionOf().dataRevision, REVISION)
    assert.strictEqual(rows(META.receipts).length, 0)
    assert.throws(() => reconstruct(serverGroups()), error => error.code === 'ACTIVE_RELATION_INVALID')
  })

  await test('回滚：行 id 被内容不符的行占用时拒绝覆盖', async () => {
    const { owner } = seed({ orphan: false })
    put('packages', targetRowId(AUDITED[0]), { ...copy(AUDITED[0].body), ownerCoachId: owner, datasetId: DATASET, data: { ...copy(AUDITED[0].body.data), remaining: 7 } })
    const result = await call('purgeTestRowsRollback')
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'PURGE_ROLLBACK_ROW_OCCUPIED')
    assert.strictEqual(rowOf('packages', targetRowId(AUDITED[0])).data.remaining, 7, '不得覆盖')
  })

  await test('隔离：别的 owner / 别的数据集里同名业务 id 的行完全不受影响', async () => {
    seed()
    const strangerOwner = coachIdFor('openid-stranger')
    const strangerRowId = businessId('packages', strangerOwner, 'dataset-stranger', AUDITED[0].businessId)
    put('packages', strangerRowId, { ...copy(AUDITED[0].body), ownerCoachId: strangerOwner, datasetId: 'dataset-stranger' })
    const result = await call('purgeTestRows', { expectedRevision: REVISION })
    assert.strictEqual(result.ok, true)
    // 目标行 id 是「审计 owner + 审计代次」的 hash ⇒ 永远指不到别人的行
    assert.notStrictEqual(strangerRowId, targetRowId(AUDITED[0]))
    assert.strictEqual(rows('packages').filter(row => row.ownerCoachId === strangerOwner).length, 1)
    // 另一个 owner 的悬空引用依旧读不出来（各自独立）
    assert.throws(() => reconstruct({ students: [], student_tombstones: [], packages: [{ packageId: 'x', studentId: STUDENT, data: {} }], bookings: [], incomes: [], sales: [], settings: [], customExercises: [] }), error => error.code === 'ACTIVE_RELATION_INVALID')
  })

  // ——— ④ 横切契约：**拒绝必须回 ok:false** ———
  // 这条不是上面某条用例的重复，它钉的是一条横切不变式。本模块的 `fail()` 会把调用方传进来的
  // 派生结果（`derived` / `facts`）展开进返回值，而那些对象**自带 `ok: true` 与 `code`**；
  // 旧写法 `{ ok:false, code, message, ...extra }` 会被它覆盖 ⇒ 每个"拒绝"出口都回 `ok:true`，
  // 调用方（预演判定 / 抢修页 / 回滚）据此继续往下写。
  // 对照实验（同一份代码，只把 fail 的展开顺序改回旧写法）实测后果：
  //   镜像不符时预演回 `ok:true`（判定"通过"）、执行回 `ok:true` 且 **真的删掉了 4 行**、
  //   revision 145→146、写了回执 —— 那道"逐字节等于审计镜像"的安全锁被整条绕过。
  // 所以这里对**每一个拒绝出口**同时断言三件事：ok === false、code 一致、快照逐字节未变。
  await test('契约：每个「拒绝」出口都必须回 ok:false 且一行都不写（ok 不许被 extra 覆盖）', async () => {
    const tampered = kind => {
      const { owner } = seed()
      put('packages', targetRowId(AUDITED[0]), { ...copy(AUDITED[0].body), ownerCoachId: owner, datasetId: DATASET, data: { ...copy(AUDITED[0].body.data), remaining: kind } })
    }
    const scenes = [
      { label: '行内容与镜像不符 · 预演', action: 'purgeTestRowsInspect', code: 'PURGE_ROW_MISMATCH', scene: () => tampered(7) },
      { label: '行内容与镜像不符 · 执行', action: 'purgeTestRows', code: 'PURGE_ROW_MISMATCH', extra: { expectedRevision: REVISION }, scene: () => tampered(7) },
      { label: '白名单只剩一部分', action: 'purgeTestRows', code: 'PURGE_PARTIAL_STATE', scene: () => { seed(); stores.packages.delete(targetRowId(AUDITED[0])) } },
      { label: '4 行都不在且无本通道回执', action: 'purgeTestRows', code: 'PURGE_ABSENT_WITHOUT_RECEIPT', scene: () => seed({ orphan: false }) },
      { label: '回滚目标行被内容不符的行占用', action: 'purgeTestRowsRollback', code: 'PURGE_ROLLBACK_ROW_OCCUPIED', scene: () => tampered(7) },
      { label: '学员仍在名册', action: 'purgeTestRows', code: 'PURGE_STUDENT_ALIVE',
        scene: () => { const { owner, datasetId } = seed(); put('students', businessId('students', owner, datasetId, STUDENT), { ownerCoachId: owner, datasetId, studentId: STUDENT, sortIndex: 36, data: { id: STUDENT, name: '胡秀明', phone: '', abbr: 'HXM', createdAt: 1789827653715 } }) } },
      { label: '已有墓碑（两通道互斥）', action: 'purgeTestRows', code: 'PURGE_TOMBSTONE_PRESENT',
        scene: () => { const { owner, datasetId } = seed(); put('student_tombstones', businessId('student_tombstones', owner, datasetId, STUDENT), { ownerCoachId: owner, datasetId, studentId: STUDENT, sortIndex: 36, data: { id: STUDENT, status: 'deleted', deletedAt: 1789913938285 } }) } },
      { label: '除白名单外还有别的行引用他', action: 'purgeTestRows', code: 'PURGE_UNEXPECTED_REFERENCE',
        scene: () => { const { owner, datasetId } = seed(); put('bookings', businessId('bookings', owner, datasetId, 'booking_x'), { ownerCoachId: owner, datasetId, bookingId: 'booking_x', studentId: STUDENT, sortIndex: 90, data: { id: 'booking_x', studentId: STUDENT, status: 'booked' } }) } },
      { label: '换了数据代次', action: 'purgeTestRows', code: 'PURGE_DATASET_MISMATCH', scene: () => seed({ datasetId: 'candidate_5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b' }) },
      { label: '客户端夹带未知字段', action: 'purgeTestRows', code: 'PURGE_FIELD_UNKNOWN', extra: { collection: 'sales' }, scene: () => seed() },
      { label: '客户端想指定清除目标', action: 'purgeTestRowsInspect', code: 'PURGE_TARGET_IMMUTABLE', extra: { studentId: 'student_00000000000000000000' }, scene: () => seed() },
      { label: 'expectedRevision 不一致', action: 'purgeTestRows', code: 'REVISION_CONFLICT', extra: { expectedRevision: REVISION - 1 }, scene: () => seed() }
    ]
    for (const item of scenes) {
      clear()
      item.scene()
      const before = snapshot()
      const result = await call(item.action, item.extra || {})
      assert.strictEqual(result.ok, false, `${item.label}：拒绝必须回 ok:false —— ok 被 extra 里的 ok:true 覆盖了`)
      assert.strictEqual(result.code, item.code, `${item.label}：拒绝码不对`)
      assert.deepStrictEqual(snapshot(), before, `${item.label}：拒绝时一行都不许写`)
    }
    // 正对照：合法路径必须仍然 ok:true —— 别靠"整条通道恒返回 false"把上面 12 条骗绿
    clear(); seed()
    const positive = await call('purgeTestRowsInspect')
    assert.strictEqual(positive.ok, true)
    assert.strictEqual(positive.presentRows, 4)
    assert.strictEqual(positive.alreadyPurged, false)
  })

  await test('契约：6 个动作都不进入 22 条正式业务命令，handlers 仍恰好 22 条', async () => {
    const { COMMANDS } = require('../utils/cloud-command-contract')
    assert.deepStrictEqual(Object.keys(handlers).sort(), COMMANDS.slice().sort())
    assert.deepStrictEqual(ACTIONS, ['repairInspect', 'repairStudentTombstone', 'repairTombstoneRollback', 'purgeTestRowsInspect', 'purgeTestRows', 'purgeTestRowsRollback'])
    ACTIONS.forEach(action => assert.strictEqual(COMMANDS.includes(action), false, `${action} 不得进入正式命令契约`))
    // 通道里没出现任何一条正式业务命令名（不借用业务写路径）
    const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'cloudfunctions', 'coachBusinessCommand', 'repair.js'), 'utf8')
    COMMANDS.forEach(command => assert.strictEqual(source.includes(`'${command}'`), false, `repair.js 不得引用正式业务命令 ${command}`))
  })

  await test('未知动作：不落进任何分支，且不产生任何写入', async () => {
    seed()
    const before = snapshot()
    const unknown = await call('purgeTestRowsEverywhere')
    assert.strictEqual(unknown.ok, false)
    assert.strictEqual(unknown.code, 'UNKNOWN_REPAIR_ACTION')
    assert.deepStrictEqual(snapshot(), before)
    // service 替身仍可用（顺带证明这条通道与 22 条命令面互不干扰）
    assert.strictEqual(typeof service, 'function')
  })

  if (!process.exitCode) process.stdout.write('ALL ORPHAN TEST DATA PURGE TESTS PASSED\n')
})()
