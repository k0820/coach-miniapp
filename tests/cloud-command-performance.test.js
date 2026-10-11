const assert = require('assert')
const { buildCandidateDataset } = require('../utils/candidate-dataset')
const { createAdapter } = require('../utils/cloud-primary-adapter')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const snapshot = { students: [{ id: 'fake-student', name: '假学员', packages: [{ id: 'fake-package', type: '赠送课程', total: 2, used: 0, remaining: 2, price: 80, status: 'active' }] }], bookings: [], incomes: [], sales: [], settings: { renewThreshold: 3, monthlyGoalSessions: 20, classCommissionRate: 40, salesCommissionRate: 10 }, customExercises: [] }
const built = buildCandidateDataset(snapshot, { trustedOwnerCoachId: 'fake-owner', trustedDatasetId: 'fake-dataset' })
const physical = { students: 'students', studentTombstones: 'student_tombstones', packages: 'packages', bookings: 'bookings', incomes: 'incomes', sales: 'sales', settings: 'settings', customExercises: 'customExercises' }
;(async () => {
  let revision = 0, pageCalls = 0, integrityCalls = 0
  const measurements = []
  const cache = {}
  const adapter = createAdapter({ environment: () => 'sandbox', storage: { get: key => cache[key], set: (key, value) => { cache[key] = value } }, onTiming: entry => measurements.push(entry), callCloud: async (name, data) => {
    if (name === 'coachBusinessCommand') { await delay(60); revision++; return { ok: true, datasetRevision: revision } }
    if (data.action === 'metadata') { await delay(20); return { ok: true, environment: 'sandbox', datasetId: 'fake-dataset', dataRevision: revision, collections: Object.values(physical) } }
    if (data.action === 'integrity') { integrityCalls++; await delay(30); return { ok: true, environment: 'sandbox', datasetId: 'fake-dataset', dataRevision: revision, ...built.integrity } }
    pageCalls++; await delay(40)
    const logical = Object.keys(physical).find(key => physical[key] === data.collection)
    const rows = built.collections[logical]
    return { ok: true, nextCursor: rows.length, nextFragmentIndex: 0, done: true, encoding: 'base64-json', payload: Buffer.from(JSON.stringify(rows)).toString('base64') }
  } })
  assert((await adapter.readActive()).ok)
  const pagesAfterInitialRead = pageCalls, confirmsAfterInitialRead = integrityCalls
  assert.equal(pagesAfterInitialRead, 8, '初始完整读取 = 八个集合各一页')
  for (const command of ['createBooking', 'updateBookingContent', 'completeBooking']) {
    const result = await adapter.execute(command, { bookingId: 'fake-booking' }, { requestId: command })
    // ★ 1.1.9 第 6 轮：命令成功后只做**一跳只读校验**，不再翻分页 —— 这一笔正是本轮去掉的 8–10 秒。
    //   ⚠️ 轻量确认**绝不冒充 refreshed**：refreshed 的含义是「本机 cache 已跟上这一版」，
    //      冒充会让页面拿着没更新的 cache 当最新数据渲染。所以这里同时钉住两件事。
    assert(result.ok && result.confirmed && result.confirmed.lightweight, JSON.stringify({ ok: result.ok, confirmed: result.confirmed, refreshed: result.refreshed }))
    assert.equal(result.refreshed, undefined, '轻量确认成功时不许出现 refreshed')
  }
  assert.equal(pageCalls, pagesAfterInitialRead, '★ 三次写命令之后一页都不许翻：完整数据读取只留给真正要看数据的设备')
  assert.ok(integrityCalls - confirmsAfterInitialRead >= 3, '完整性校验调用必须保留：每条写命令都要经过那一跳只读校验')
  const commandEntries = measurements.filter(entry => entry.action === 'execute')
  assert.equal(commandEntries.length, 3)
  for (const entry of commandEntries) {
    assert.equal(entry.confirmMode, 'lightweight')
    // 一跳只读校验 = 一次 integrity 往返（本夹具 mock 30ms）；八页分页（mock ≥180ms）必须能被判据区分开。
    assert(entry.confirmMs != null && entry.confirmMs < 100, '命令后的确认必须是一跳只读校验，不是一次完整分页回读')
    assert(entry.refreshMs < 100, '命令后带回来的东西必须远小于一次八页回读')
  }
  console.log('mock timing (ms):', JSON.stringify(commandEntries.map(({ command, commandMs, refreshMs, confirmMs, totalMs }) => ({ command, commandMs, refreshMs, confirmMs, totalMs }))))
  console.log('cloud command performance tests passed (mock latency only; all integrity calls retained)')
})().catch(error => { console.error(error); process.exitCode = 1 })
