// 通道二的**页面级**测试：编排与闸门。
//
// 为什么必须有这一层：**纯函数正确 ≠ 编排正确**。上一轮全量回归变红的根因，是云端 `fail()` 把
// `ok:false` 展开成了 `ok:true` —— 那种缺陷在云端单测里看得见，但"调用方会不会照着 `ok` 继续往下写"
// 只有把**页面真跑一遍**才钉得住（页面就是拿 `result.ok` 当闸门的）。
//
// 本文件刻意**不手搓云端响应**：命令一律转发给**真的** `coachBusinessCommand/repair.js`，
// 它操作一个内存假数据库；页面要的 8 集合只读回读也从同一个数据库里取。
// ⇒ 事件顺序、行形状、指纹都对得上，"页面 → 真云函数 → 真数据形状"整条链是端到端的。
//（这是本项目的硬规矩：凡是断言「A 消费 B 产出的字段」，B 必须是真实实现。）
//
// 另一个刻意的选择：替身 `wx` **不提供** `base64ToArrayBuffer`，让
// `utils/cloud-primary-adapter.base64Bytes` 走它的 `Buffer` 兜底分支 —— 与真机同一套解码口径。
const assert = require('assert')
const path = require('path')
const ROOT = path.join(__dirname, '..')

const { META, coachIdFor, fixedId, createService } = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/core'))
const { runRepair, PURGE, ACTIONS } = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/repair'))
const { handlers } = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/handlers'))

const OPENID = 'openid-owner'
const OWNER = coachIdFor(OPENID)
const DATASET = PURGE.datasetId
const REVISION = 145
const BUSINESS = ['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']

// ═══ 假数据库（与 tests/orphan-test-data-purge.test.js 同一套替身：事务用草稿、提交才落盘）═══
const copy = value => JSON.parse(JSON.stringify(value))
const names = [...Object.values(META), ...BUSINESS, 'coach_sandbox_heads', 'coach_sandbox_revisions', 'coach_sandbox_receipts']
const stores = Object.fromEntries(names.map(name => [name, new Map()]))
let queue = Promise.resolve()

function scope(target) {
  return {
    collection(name) {
      if (!target[name]) target[name] = new Map()
      return {
        doc(id) {
          return {
            async set({ data }) { target[name].set(id, { ...copy(data), _id: id }); return { _id: id } },
            async remove() { const removed = target[name].delete(id) ? 1 : 0; return { stats: { removed } } }
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
const businessId = (name, id) => fixedId(`coach-business-${name}`, OWNER, `${DATASET}:${id}`)
const rowsOf = name => [...(stores[name] || new Map()).values()].map(copy)
// 与 `cloudfunctions/coachBusinessCommand/index.js` 的 main 同构：按 action 分流 ——
// 抢修动作（repair*/purge*）走 runRepair，其余（含 getReceipt）走正式命令服务。
// 这样页面拿到的 `getReceipt` 响应形状就是**真实现**产出的，而不是我手搓的。
const service = createService({ db, getOpenId: () => OPENID, handlers })

// ═══ 现场：审计过的那 4 行（**行 _id 用真常量**，只把归属换成当前测试 owner）═══
// 行 _id 必须逐字等于白名单里的字面 _id，否则会走到 PURGE_WHITELIST_INVALID。
function seed() {
  Object.values(stores).forEach(store => store.clear())
  queue = Promise.resolve()
  const put = (name, id, data) => stores[name].set(id, { ...copy(data), _id: id })
  put(META.coaches, OWNER, { openId: OPENID, status: 'active' })
  put(META.datasets, fixedId('coach-dataset', OWNER, DATASET), { ownerCoachId: OWNER, datasetId: DATASET, status: 'active', integrityStatus: 'verified', checksum: 'activation-baseline', byteSize: 1, summary: {}, counts: {}, amounts: {}, schemaVersion: 1 })
  put(META.heads, fixedId('coach-data-head', OWNER), { ownerCoachId: OWNER, activeDatasetId: DATASET, headVersion: 1 })
  put(META.revisions, fixedId('coach-data-revision', OWNER, DATASET), { ownerCoachId: OWNER, datasetId: DATASET, dataRevision: REVISION, updatedAt: 1789913938285 })
  // 两条"真实业务"记录：用来验"没被误伤"（其余集合必须逐字节不变）
  put('students', businessId('students', 'mtfe0000000000000000'), { ownerCoachId: OWNER, datasetId: DATASET, studentId: 'mtfe0000000000000000', sortIndex: 0, data: { id: 'mtfe0000000000000000', name: '张教练学员', phone: '', abbr: 'ZJ', createdAt: 1789000000000 } })
  put('packages', businessId('packages', 'package_zhang_1'), { ownerCoachId: OWNER, datasetId: DATASET, packageId: 'package_zhang_1', studentId: 'mtfe0000000000000000', saleId: 'sale_zhang_1', studentSortIndex: 0, sortIndex: 9, data: { id: 'package_zhang_1', type: '常规训练', total: 10, used: 2, remaining: 8, price: 400, status: 'active', saleDate: '2026-09-10', saleId: 'sale_zhang_1' } })
  put('sales', businessId('sales', 'sale_zhang_1'), { ownerCoachId: OWNER, datasetId: DATASET, saleId: 'sale_zhang_1', studentId: 'mtfe0000000000000000', packageId: 'package_zhang_1', sortIndex: 20, data: { id: 'sale_zhang_1', source: 'course', status: 'active', studentId: 'mtfe0000000000000000', packageId: 'package_zhang_1', typeName: '常规训练', quantity: 10, unitPrice: 400, amount: 4000, date: '2026-09-10', note: '学员 · 常规训练 10节' } })
  put('bookings', businessId('bookings', 'booking_zhang_1'), { ownerCoachId: OWNER, datasetId: DATASET, bookingId: 'booking_zhang_1', studentId: 'mtfe0000000000000000', packageId: 'package_zhang_1', sortIndex: 5, data: { id: 'booking_zhang_1', studentId: 'mtfe0000000000000000', status: 'done', date: '2026-09-22', hour: 20, minute: 0 } })
  put('incomes', businessId('incomes', 'income_zhang_1'), { ownerCoachId: OWNER, datasetId: DATASET, incomeId: 'income_zhang_1', studentId: 'mtfe0000000000000000', bookingId: 'booking_zhang_1', sortIndex: 5, data: { id: 'income_zhang_1', amount: 349.39, date: '2026-09-22' } })
  put('settings', businessId('settings', 'settings'), { ownerCoachId: OWNER, datasetId: DATASET, data: { coachName: '张教练', defaultHourRate: 349.39 } })
  put('customExercises', businessId('customExercises', 'ex_1'), { ownerCoachId: OWNER, datasetId: DATASET, data: { id: 'ex_1', name: '杠铃深蹲' } })
  // 审计过的那 4 行：body 直接取云函数里的镜像常量（**不手抄**），只换归属字段
  PURGE.rows.forEach(row => put(row.collection, row._id, { ...copy(row.body), ownerCoachId: OWNER, datasetId: DATASET }))
}

// ═══ 页面模块的加载环境（替身 Page / wx）═══
let pageDefinition = null
const storage = new Map()
const calls = []
const world = { integrityBroken: false, hideReceipt: false, lyingInspect: false, tamperAfterCommit: false, tampered: false, injectExtra: null, clipboard: '' }
const wxCalls = []

global.Page = definition => { pageDefinition = definition }
global.wx = {
  getStorageSync: key => (storage.has(key) ? JSON.parse(storage.get(key)) : ''),
  setStorageSync: (key, value) => { storage.set(key, JSON.stringify(value)) },
  removeStorageSync: key => { storage.delete(key) },
  showToast: () => {},
  showModal: options => { if (options && options.success) options.success({ confirm: true, cancel: false }) },
  showLoading: () => {}, hideLoading: () => {},
  setClipboardData: options => { world.clipboard = (options && options.data) || ''; if (options && options.success) options.success({}) },
  // ⚠️ 刻意不提供 base64ToArrayBuffer：让 base64Bytes 走 Buffer 兜底（与真机同一套解码口径）
  cloud: {
    callFunction: async request => {
      // ⚠️ 与真实通道同口径：平台会往 event 里注入调用方控制不了的字段。字段名按**实测原文**写 ——
      //    2026-09-22 19:24 那次真实预演的原话是 "清除通道不接受这些字段：tcbContext"
      //    （tcb = Tencent CloudBase）。上一版这里跟着我记错的名字写成 tbdContext：一个字母之差，
      //    替身和代码一起错 ⇒「本地全绿 + 云上照旧被拒」。替身必须抄真通道，不能抄记错的名字。
      const injected = {
        userInfo: { appId: 'wx7aa0596956732b35', openId: 'test-openid' },
        tcbContext: { source: 'devtools', traceId: 'sim-trace-1' }
      }
      const extra = world.injectExtra || {}
      return { result: await route(request.name, { ...injected, ...extra, ...(request.data || {}) }) }
    }
  }
}

function revisionNow() { return rowsOf(META.revisions)[0].dataRevision }
function pagePayload(collection) {
  const json = JSON.stringify(rowsOf(collection))
  return { ok: true, payload: Buffer.from(json, 'utf8').toString('base64'), encoding: 'json', nextCursor: 1, done: true, dataRevision: revisionNow(), datasetId: DATASET, environment: 'production' }
}

async function route(name, data) {
  const action = data.action
  calls.push({ name, action })
  wxCalls.push({ name, action, data })
  if (name === 'readMyActiveCoachData') {
    if (action === 'page') return pagePayload(data.collection)
    if (action === 'metadata') return { ok: true, dataRevision: revisionNow(), datasetId: DATASET, headVersion: 1 }
    if (action === 'integrity') {
      if (world.integrityBroken) return { ok: false, code: 'ACTIVE_READ_INTEGRITY_FAILED', dataRevision: revisionNow() }
      return { ok: true, dataRevision: revisionNow(), summary: {}, counts: {} }
    }
    throw new Error('未登记的只读动作 ' + action)
  }
  if (name !== 'coachBusinessCommand') throw new Error('未登记的函数 ' + name)
  if (action === 'getReceipt' && world.hideReceipt) return { ok: true, found: false }
  const result = ACTIONS.includes(action)
    ? await runRepair({ db, getOpenId: () => OPENID, event: { ...data } })
    : await service({ ...data })
  if (action === 'purgeTestRowsInspect' && world.lyingInspect && result && result.ok) {
    // 伪造**旧缺陷形状**：云端明明判了"拒绝"，却回 ok:true（code 还在）——
    // 这正是 repair.js 的 fail 展开顺序被写反时的样子。页面必须照样拒。
    return { ...result, code: 'PURGE_ROW_MISMATCH', message: '（模拟旧缺陷形状）拒绝却回 ok:true' }
  }
  if (action === 'purgeTestRows' && result && result.purged && world.tamperAfterCommit && !world.tampered) {
    world.tampered = true
    stores.bookings.set(businessId('bookings', 'booking_TAMPERED'), { ownerCoachId: OWNER, datasetId: DATASET, bookingId: 'booking_TAMPERED', studentId: 'mtfe0000000000000000', sortIndex: 99, data: { id: 'booking_TAMPERED', status: 'booked', date: '2026-09-30' }, _id: businessId('bookings', 'booking_TAMPERED') })
  }
  return result
}

function loadPage() {
  if (!pageDefinition) require(path.join(ROOT, 'pkg-diag/repair-orphan-tombstone/repair-orphan-tombstone.js'))
  const page = Object.assign({}, pageDefinition)
  page.data = {}
  page.setData = function (patch) { Object.assign(this.data, patch) }
  return page
}
const pageModule = () => require(path.join(ROOT, 'pkg-diag/repair-orphan-tombstone/repair-orphan-tombstone.js'))
const guard = require(path.join(ROOT, 'utils/production-recovery-guard'))

function freezeOn() {
  wx.setStorageSync(guard.KEY, { bookingId: 'REPAIR-ORPHAN-TOMBSTONE-2026-09-22', datasetId: DATASET })
  guard.enter()
}
function freezeOff() {
  storage.delete(guard.KEY)
  guard.exit()
}
const reset = () => {
  calls.length = 0
  wxCalls.length = 0
  world.integrityBroken = false
  world.hideReceipt = false
  world.lyingInspect = false
  world.tamperAfterCommit = false
  world.tampered = false
  world.injectExtra = null
  world.clipboard = ''
}

const failures = []
async function test(name, fn) {
  try { reset(); storage.clear(); seed(); await fn(); process.stdout.write(`PASS ${name}\n`) }
  catch (error) { failures.push(name); process.stderr.write(`FAIL ${name}: ${error.message}\n${error.stack}\n`) }
}
const actionsOf = () => calls.filter(call => call.action !== 'page').map(call => call.action)
const pageCalls = () => calls.filter(call => call.action === 'page').length

;(async () => {
  // ——— ① 纯函数：预演响应的**真生产者**是云函数，不是手搓 ———
  await test('purgePlanOf：吃真云函数产出的预演响应（4 行、逐行在否/等于镜像）', async () => {
    const { purgePlanOf } = pageModule()
    const real = await runRepair({ db, getOpenId: () => OPENID, event: { action: 'purgeTestRowsInspect', environment: 'production' } })
    assert.strictEqual(real.ok, true)
    assert.strictEqual(real.presentRows, 4)
    const plan = purgePlanOf(real)
    assert.strictEqual(plan.ok, true)
    assert.strictEqual(plan.presentRows, 4)
    assert.strictEqual(plan.lines.length, 4)
    assert.ok(plan.lines.every(line => line.present && line.matches), '4 行都必须在且逐字节等于镜像')
    assert.ok(plan.lines.every(line => line.hash.length === 12), '每行要能印出镜像 hash 前 12 位给人核对')
    assert.deepStrictEqual(plan.targetIds.slice().sort(), PURGE.rows.map(row => row._id).sort())
    assert.strictEqual(plan.referenceHits, 4, '引用闭包命中数应等于 4 行')
    assert.strictEqual(plan.impact.orphanReferencesBefore, 2, '悬空引用 = 2 条课时包')
    assert.strictEqual(plan.impact.orphanReferencesAfter, 0)
    assert.strictEqual(plan.datasetId, DATASET)
    assert.strictEqual(plan.revisionBefore, REVISION)
    // 预演响应里 4 行的 rowId 必须是**真常量里的字面 _id**
    assert.deepStrictEqual(plan.lines.map(line => line.rowId).sort(), PURGE.rows.map(row => row._id).sort())
  })

  // ——— ② 逐项判定：全绿 / 逐条变异反证 ———
  const greenFacts = () => {
    const before = { dataRevision: REVISION, perCollection: {} }
    const after = { dataRevision: REVISION + 1, perCollection: {} }
    BUSINESS.forEach(name => {
      const rows = rowsOf(name)
      before.perCollection[name] = { count: rows.length, checksum: 'c:' + name, byteSize: 1 }
      const shrink = name === 'packages' || name === 'sales' ? 2 : 0
      after.perCollection[name] = { count: rows.length - shrink, checksum: shrink ? 'c:' + name + ':after' : 'c:' + name, byteSize: 1 }
    })
    return {
      before, after, targetIds: PURGE.rows.map(row => row._id),
      purge: {
        ok: true, purged: true, alreadyPurged: false, requestId: 'purge_test_rows_x',
        revisionBefore: REVISION, revisionAfter: REVISION + 1,
        removed: PURGE.rows.map(row => ({ collection: row.collection, rowId: row._id })),
        impact: { activeSalesAmountBefore: 5200, activeSalesAmountAfter: 5200, activeSalesCountBefore: 2, activeSalesCountAfter: 2, orphanReferencesBefore: 2, orphanReferencesAfter: 0 }
      },
      integrity: { ok: true, dataRevision: REVISION + 1 },
      // 与**真生产者**同口径：getReceipt 返回 { ok, found, status, response }，revisionAfter 在 response 里
      receipt: { ok: true, found: true, status: 'succeeded', response: { revisionAfter: REVISION + 1 } }
    }
  }
  await test('purgeChecksOf：全绿时 ok=true（10 项）', async () => {
    const { purgeChecksOf } = pageModule()
    const result = purgeChecksOf(greenFacts())
    assert.strictEqual(result.ok, true, '全绿必须判通过：' + JSON.stringify(result.checks.filter(item => !item.ok)))
    assert.strictEqual(result.checks.length, 10)
  })
  await test('purgeChecksOf：逐条变异反证 —— 每一处破坏都必须被单独抓住', async () => {
    const { purgeChecksOf } = pageModule()
    const mutations = [
      ['响应不是 purged=true（幂等返回）', facts => { facts.purge.purged = false }],
      ['回读到的 revision 没有 +1', facts => { facts.after.dataRevision = REVISION + 2 }],
      ['删的不是那 4 行', facts => { facts.purge.removed = facts.purge.removed.slice(0, 3) }],
      ['packages 少掉的行数不对', facts => { facts.after.perCollection.packages.count = facts.before.perCollection.packages.count - 1 }],
      ['别的集合被动了', facts => { facts.after.perCollection.bookings.checksum = 'changed' }],
      ['integrity 没过（事故没修好）', facts => { facts.integrity = { ok: false, code: 'ACTIVE_RELATION_INVALID' } }],
      ['回执没找到', facts => { facts.receipt = { found: false } }],
      ['业绩口径被改了', facts => { facts.purge.impact.activeSalesAmountAfter = 3000 }],
      ['悬空引用没归零', facts => { facts.purge.impact.orphanReferencesAfter = 1 }],
      ['学员行数被动了', facts => { facts.after.perCollection.students.count = facts.before.perCollection.students.count + 1 }]
    ]
    for (const [label, mutate] of mutations) {
      const facts = greenFacts()
      mutate(facts)
      const result = purgeChecksOf(facts)
      assert.strictEqual(result.ok, false, `变异「${label}」没有被抓住`)
      const red = result.checks.filter(item => !item.ok)
      assert.strictEqual(red.length, 1, `变异「${label}」应恰好打红 1 项，实际 ${red.length}：` + red.map(item => item.name).join(' / '))
    }
  })
  await test('purgeRestoreChecksOf：全同判通过；任一集合不同就判失败', async () => {
    const { purgeRestoreChecksOf } = pageModule()
    const before = { perCollection: {} }
    BUSINESS.forEach(name => { before.perCollection[name] = { count: 2, checksum: 'x:' + name } })
    const same = { perCollection: copy(before.perCollection) }
    assert.strictEqual(purgeRestoreChecksOf(before, same).ok, true)
    const changed = { perCollection: copy(before.perCollection) }
    changed.perCollection.sales.checksum = 'y:sales'
    const result = purgeRestoreChecksOf(before, changed)
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.checks.filter(item => !item.ok).length, 1)
  })

  // ——— ③ 编排：未冻结 → 一个字都不发 ———
  await test('编排 · 未冻结：先点执行也必须拒，且不发任何 purgeTestRows', async () => {
    freezeOff()
    const page = loadPage()
    await page.purgeExecute()
    assert.strictEqual(calls.filter(call => call.action === 'purgeTestRows').length, 0, '未冻结时绝不允许发出清除命令')
    assert.strictEqual(calls.filter(call => call.action === 'purgeTestRowsInspect').length, 0, '未冻结时连预演都不该发')
    assert.strictEqual(page.data.purge.verdictOk, false)
    assert.ok(/冻结/.test(page.data.purge.verdict), '结论要说清是冻结没生效：' + page.data.purge.verdict)
  })

  // ——— ④ 编排：快乐路径（端到端）———
  await test('编排 · 快乐路径：预演 ok → 单次提交 → 10 项验证全绿 → 不回插', async () => {
    freezeOn()
    const page = loadPage()
    await page.purgeExecute()
    assert.deepStrictEqual(actionsOf(), ['purgeTestRowsInspect', 'purgeTestRows', 'metadata', 'integrity', 'getReceipt'],
      '动作顺序必须是 预演 → 提交 → 只读验证素材；实际：' + actionsOf().join(' → '))
    assert.strictEqual(pageCalls(), 16, '清除前后各一次全 8 集合只读回读')
    assert.strictEqual(calls.filter(call => call.action === 'purgeTestRowsRollback').length, 0, '验证全绿时不该回插')
    assert.strictEqual(page.data.purge.verdictOk, true, page.data.purge.verdict)
    assert.deepStrictEqual(page.data.purge.checks.checks.filter(item => !item.ok), [], '不该有打红项')
    // 4 行真的从云端没了，且其余集合一行未动
    const packages = rowsOf('packages').filter(row => row._id === PURGE.rows[0]._id || row._id === PURGE.rows[1]._id)
    assert.strictEqual(packages.length, 0)
    assert.strictEqual(rowsOf('sales').filter(row => row._id === PURGE.rows[2]._id || row._id === PURGE.rows[3]._id).length, 0)
    assert.strictEqual(rowsOf('students').length, 1, '名册一行未动')
    assert.strictEqual(rowsOf('bookings').length, 1, '课程一行未动')
    assert.strictEqual(revisionNow(), REVISION + 1)
    // 执行记录落盘（可审计）
    assert.ok(storage.has(pageModule().PURGE_KEY), '执行记录必须落 Storage')
  })

  // ——— ⑤ 编排：预演拒绝 → 必须一个字都不写 ———
  await test('编排 · 预演 ok:false（真云函数判 PURGE_ROW_MISMATCH）→ 不发清除', async () => {
    freezeOn()
    // 把其中一行改成与审计镜像不符 ⇒ 真云函数会（正确地）拒绝
    stores.packages.set(PURGE.rows[0]._id, { ...copy(PURGE.rows[0].body), ownerCoachId: OWNER, datasetId: DATASET, data: { ...copy(PURGE.rows[0].body.data), remaining: 7 }, _id: PURGE.rows[0]._id })
    const page = loadPage()
    await page.purgeExecute()
    const inspect = calls.filter(call => call.action === 'purgeTestRowsInspect')
    assert.strictEqual(inspect.length, 1)
    assert.strictEqual(calls.filter(call => call.action === 'purgeTestRows').length, 0, '预演未通过时绝不允许发出清除命令')
    assert.strictEqual(calls.filter(call => call.action === 'purgeTestRowsRollback').length, 0, '一个字都没写，不需要回插')
    assert.strictEqual(revisionNow(), REVISION, 'revision 一个字都不该动')
    assert.ok(/预演未通过/.test(page.data.purge.verdict), page.data.purge.verdict)
  })

  await test('编排 · 预演"ok=true 却带 code"（旧缺陷形状）→ 照样不当成通过', async () => {
    freezeOn()
    world.lyingInspect = true
    const page = loadPage()
    await page.purgeExecute()
    assert.strictEqual(calls.filter(call => call.action === 'purgeTestRows').length, 0,
      '成功响应从不带 code；带 code 就必须按拒绝处理（纵深防御），绝不允许继续删')
    assert.strictEqual(revisionNow(), REVISION)
    assert.ok(/自相矛盾/.test(page.data.purge.verdict), page.data.purge.verdict)
  })

  // ——— ⑤′ 输入闸回显：字段名必须一路上到「页面看得见」的地方 ———
  // 上一版把 unknown/unknownShapes/ignoredFields 在 purgePlanOf 里丢掉了，于是云上真拒的时候，
  // 页面上只剩一排 null —— 只能靠"再部署一次试试"来猜字段名（2026-09-22 白跑一轮）。
  await test('输入闸回显 · 平台字段放行：页面照常预演，状态行给出版本与「额外字段=无」', async () => {
    freezeOn()
    const page = loadPage()
    await page.onPreviewPurge()
    const plan = page.data.purge.plan
    assert.strictEqual(plan.ok, true, `${plan.code || ''} ${plan.message || ''}`)
    assert.strictEqual(plan.presentRows, 4)
    // 实测真名（userInfo / tcbContext）都在白名单里 ⇒ 没有额外字段可报
    assert.deepStrictEqual(plan.ignoredFields, [])
    assert.strictEqual(page.data.purgeFieldNote.includes('额外字段=无'), true, page.data.purgeFieldNote)
    assert.strictEqual(page.data.purgeHint.includes('通道版本=v3'), true, '状态行必须显示通道版本：' + page.data.purgeHint)
  })

  await test('输入闸回显 · 惰性未知字段（含错拼的 tbdContext）：页面显示名字、不回值，且照常走完预演', async () => {
    freezeOn()
    world.injectExtra = { tbdContext: { traceId: 'typo-should-not-echo' }, someFutureField: 'value-should-not-echo' }
    const page = loadPage()
    await page.onPreviewPurge()
    const plan = page.data.purge.plan
    assert.strictEqual(plan.ok, true, `惰性未知字段不该拦预演：${plan.code || ''} ${plan.message || ''}`)
    assert.deepStrictEqual(plan.ignoredFields.map(shape => shape.field).sort(), ['someFutureField', 'tbdContext'])
    assert.strictEqual('preview' in plan.ignoredFields[0], false, '只回名字/类型/键名，不回值')
    assert.strictEqual(page.data.purgeFieldNote.includes('tbdContext'), true, page.data.purgeFieldNote)
    assert.strictEqual(page.data.purgeHint.includes('typo-should-not-echo'), false, '值不许出现在页面上')
    // 复制清单也要带这一行 —— 否则事后只能看截图回忆
    await page.onCopyPurge()
    assert.strictEqual(world.clipboard.includes('tbdContext'), true, '复制清单要能说出被放行的字段名')
    assert.strictEqual(world.clipboard.includes('云端放行并忽略的惰性字段'), true)
    assert.strictEqual(world.clipboard.includes('value-should-not-echo'), false, '复制清单也不许带平台字段的值')
  })

  await test('输入闸回显 · 被硬拒字段：名字进状态行与复制清单，且提交入口照样拦得住', async () => {
    freezeOn()
    world.injectExtra = { collection: 'sales' }
    const page = loadPage()
    await page.onPreviewPurge()
    const plan = page.data.purge.plan
    assert.strictEqual(plan.ok, false)
    assert.strictEqual(plan.code, 'PURGE_FIELD_UNKNOWN')
    assert.deepStrictEqual(plan.unknown, ['collection'])
    assert.strictEqual(plan.message.includes('collection'), true, '拒绝原因里必须点名是哪个字段')
    assert.strictEqual(page.data.purgeFieldNote.includes('collection'), true, page.data.purgeFieldNote)
    assert.strictEqual(page.data.purgeHint.includes('PURGE_FIELD_UNKNOWN'), true)
    await page.onCopyPurge()
    assert.strictEqual(world.clipboard.includes('collection'), true)
    // 提交入口也必须拦得住：预演被拒 ⇒ 一个字都不许写
    await page.purgeExecute()
    assert.strictEqual(calls.filter(call => call.action === 'purgeTestRows').length, 0, '预演被拒时绝不允许发出清除命令')
    assert.strictEqual(revisionNow(), REVISION)
    // 按 _id 精确核对：白名单那 4 行原样都在（不依赖夹具里恰好几行）
    const targetIds = PURGE.rows.map(row => row._id)
    assert.strictEqual(rowsOf('packages').filter(row => targetIds.includes(row._id)).length, 2, '白名单里的 2 个课时包原样都在')
    assert.strictEqual(rowsOf('sales').filter(row => targetIds.includes(row._id)).length, 2, '白名单里的 2 笔销售原样都在')
  })

  // ——— ⑥ 编排：验证不过 → 自动回插，并自证"逐字节回到清除前" ———
  await test('编排 · 清除后别的集合被动过 → 自动回插，并把"仍对不上"如实报出（不静默掩盖）', async () => {
    freezeOn()
    world.tamperAfterCommit = true
    const page = loadPage()
    await page.purgeExecute()
    assert.strictEqual(calls.filter(call => call.action === 'purgeTestRowsRollback').length, 1, '验证不过必须自动回插一次')
    assert.strictEqual(page.data.purge.checks.ok, false, '这次验证必须判不通过')
    // ⚠️ 回插只负责把**白名单 4 行**放回去，它不是通用撤销器：别人后来动过的行必须留在原地并**如实报出**。
    // 所以这里断言的是"红项恰好是被动过的那一个集合"，而不是"回插后全绿" —— 后者会掩盖真实问题。
    const restore = page.data.purge.restoreChecks
    assert.strictEqual(restore.ok, false)
    assert.deepStrictEqual(restore.checks[0].detail.filter(item => !item.same).map(item => item.name), ['bookings'])
    assert.strictEqual(restore.checks[1].detail.filter(item => item.after !== item.before).map(item => item.name).join(), 'bookings')
    // 但这 4 行本身必须已按原 _id 回插到位
    assert.strictEqual(rowsOf('packages').filter(row => row._id === PURGE.rows[0]._id).length, 1)
    assert.strictEqual(rowsOf('sales').filter(row => row._id === PURGE.rows[3]._id).length, 1)
    assert.strictEqual(page.data.purge.verdictOk, false)
    assert.ok(/⚠️/.test(page.data.purge.verdict), '必须如实写出"仍对不上、立即停止并回报"：' + page.data.purge.verdict)
  })

  await test('编排 · integrity 没过（事故没修好）→ 自动回插，且回插后 8 集合逐字节回到清除前', async () => {
    freezeOn()
    world.integrityBroken = true
    const page = loadPage()
    await page.purgeExecute()
    assert.strictEqual(calls.filter(call => call.action === 'purgeTestRowsRollback').length, 1)
    assert.strictEqual(page.data.purge.restoreChecks.ok, true, '这一路的回插必须全绿：' + JSON.stringify(page.data.purge.restoreChecks.checks.filter(item => !item.ok)))
    assert.strictEqual(revisionNow(), REVISION + 2)
  })

  await test('编排 · 回执查不到 → 判不通过并自动回插（不采信响应自述）', async () => {
    freezeOn()
    world.hideReceipt = true
    const page = loadPage()
    await page.purgeExecute()
    assert.strictEqual(calls.filter(call => call.action === 'purgeTestRowsRollback').length, 1)
    assert.strictEqual(page.data.purge.checks.ok, false)
    assert.strictEqual(page.data.purge.restoreChecks.ok, true)
  })

  // ——— ⑦ 按钮接线：确认后才会执行 ———
  await test('接线：onRunPurge 在用户确认后调用 purgeExecute；preview/回插也各有一处入口', async () => {
    freezeOn()
    const page = loadPage()
    let executed = 0
    page.purgeExecute = () => { executed += 1 }
    page.onRunPurge()
    assert.strictEqual(executed, 1)
    const source = require('fs').readFileSync(path.join(ROOT, 'pkg-diag/repair-orphan-tombstone/repair-orphan-tombstone.wxml'), 'utf8')
    ;['onPreviewPurge', 'onCopyPurge', 'onRunPurge', 'onRollbackPurge'].forEach(handler => assert.ok(source.includes('bindtap="' + handler + '"'), '页面必须给 ' + handler + ' 一个入口'))
  })

  if (failures.length) { process.stderr.write(`\n${failures.length} 项失败：${failures.join(' / ')}\n`); process.exitCode = 1 } else { process.stdout.write('ALL REPAIR PURGE PAGE TESTS PASSED\n') }
})()
