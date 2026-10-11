// M2 数据源隔离回归（2026-09-27）：**Sandbox 页面不许读 Production / 本机正式区库**。
//
// 现场第四条证据彻底推翻了此前的全部推测：
//   正式区学员页真实 37 人 · M2 验收页显示 6 人 · Sandbox fixture 只有 1 人。
//   三条数字互不相容 ⇒ 我们一直在比对的两组数字（10/1/3 与 11/2/2）很可能压根不属于同一份数据。
//
// 排查暴露出的**结构性**漏洞（与本轮业务无关，是地基问题）：
//   data-runtime.getDB() 原来第一条是 `if (mode() === LOCAL) return local.getDB()`，
//   它**完全不看 environment** ⇒ environment=sandbox 时也能返回本机正式区库 coachDB。
//   而页面头部那行「测试区 dataset xxxxxx」是**单独 hardcode 读 SANDBOX_CACHE_KEY** 取来的，
//   于是同一个页面里「标着测试区」和「渲染正式区数据」可以同时成立，并且
//   **不报错、不提示、进页面/回前台/下拉/杀进程重开一百次都不会变**。
//
// 本文件守的是一条永久规则：
//   **测试环境读取失败必须 fail closed（失败即停止），禁止静默 fallback 到另一环境。**
//   并且：涉及 Sandbox / Production / 多身份时，不许只验证"中间函数被调用了"，
//   必须验证**最终 authoritative data source** 与 owner / dataset / document identity。
//
// ⚠️ 这些测试**故意用真的 utils/data-runtime**（不替换它）—— 换掉它就测不到那个
//    「sandbox 也能读本机库」的真分支，那正是这次事故在测试里的样子。

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const PAGE_ID = require.resolve('../pages/sandbox-shared-test/sandbox-shared-test')
const RUNTIME_ID = require.resolve('../utils/data-runtime')
const MUTATE_ID = require.resolve('../utils/mutate')
const UI_ID = require.resolve('../utils/ui-cloud-command')
const RUNTIME_SRC = fs.readFileSync(path.join(ROOT, 'utils/data-runtime.js'), 'utf8')
const PAGE_SRC = fs.readFileSync(path.join(ROOT, 'pages/sandbox-shared-test/sandbox-shared-test.js'), 'utf8')

const flush = async (rounds = 8) => { for (let i = 0; i < rounds; i++) await Promise.resolve() }

// 三个世界的 mah —— 名字故意各不相同，串一点就会被抓到。
const productionDb = () => ({
  students: [
    { id: 'prod-student-1', name: 'PROD-正式区学员甲', packages: [{ id: 'prod-package-1', type: '常规训练', remaining: 99, reserved: 0, used: 0 }] },
    { id: 'prod-student-2', name: '测试学员小蓝', packages: [{ id: 'prod-package-2', type: '常规训练', remaining: 77, reserved: 0, used: 0 }] }
  ],
  bookings: [], sales: [{ id: 'prod-sale-1' }], incomes: []
})
// ⭐ 故意让 Sandbox 与正式区存在**同名不同 id** 的学员：这样"按名字串到另一本账"会被当场抓到。
const sandboxSnapshot = override => ({
  students: [
    { id: 'sandbox-student-1', name: '测试学员小蓝', packages: [{ id: 'sandbox-package-1', type: '常规训练', remaining: 11, reserved: 2, used: 2 }] }
  ],
  bookings: [], sales: [{ id: 'sandbox-sale-1' }], incomes: [{ id: 'sandbox-income-1' }],
  ...(override || {})
})
const sandboxCache = () => ({
  environment: 'sandbox',
  datasetId: 'sandbox-coach-aaaaaaaaaaaaaaaa77548e',
  revision: 7,
  checksum: 'x',
  snapshot: sandboxSnapshot()
})

// 假世界：真 data-runtime + 真页面 + 真 m2-shared-acceptance，只有 Storage 与云端读取是可控假件。
function makeWorld(options = {}) {
  const store = Object.assign({}, options.store || {})
  const seen = { uiCalls: [], stopped: 0 }
  global.wx = {
    getStorageSync: key => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : ''),
    setStorageSync: (key, value) => { store[key] = value },
    stopPullDownRefresh: () => { seen.stopped += 1 },
    showToast: () => {}, showModal: () => {}, showLoading: () => {}, hideLoading: () => {}
  }
  global.Page = config => { seen.config = config }

  const saved = { runtime: require.cache[RUNTIME_ID], mutate: require.cache[MUTATE_ID], ui: require.cache[UI_ID], page: require.cache[PAGE_ID] }
  delete require.cache[RUNTIME_ID]
  delete require.cache[PAGE_ID]
  const runtime = require('../utils/data-runtime')
  runtime.setEnvironment(options.environment || 'sandbox')

  const fakeMutate = async () => ({ ok: true, result: {} })
  fakeMutate.isCloudWritePath = () => true
  require.cache[MUTATE_ID] = { id: MUTATE_ID, filename: MUTATE_ID, loaded: true, exports: fakeMutate }
  require.cache[UI_ID] = { id: UI_ID, filename: UI_ID, loaded: true, exports: {
    refreshActiveView: opts => {
      seen.uiCalls.push({ userInitiated: !!(opts && opts.userInitiated) })
      if (typeof options.onRead === 'function') options.onRead(store)
      return options.readResult || { ok: true, revision: 12 }
    }
  } }
  require('../pages/sandbox-shared-test/sandbox-shared-test.js')

  const restore = () => {
    try { require('../utils/auto-refresh').unsubscribeAll() } catch (error) {}
    delete require.cache[PAGE_ID]
    delete require.cache[RUNTIME_ID]
    Object.keys(saved).forEach(key => { if (saved[key]) require.cache[saved[key].id] = saved[key] })
    delete global.Page
    delete global.wx
  }
  const instantiate = () => {
    const page = Object.assign({}, seen.config)
    page.data = JSON.parse(JSON.stringify(seen.config.data))
    page.setData = (patch, callback) => { Object.keys(patch || {}).forEach(key => { page.data[key] = patch[key] }); if (callback) callback() }
    return page
  }
  return { runtime, store, seen, restore, instantiate }
}

// 本机正式区库 + 沙盒权威缓存同时存在时的标准场景
function bothWorlds(extraStore) {
  return Object.assign({
    coachDB: productionDb(),
    coachDataSourceMode: 'cloud-primary',
    coachCloudActiveCache: { environment: 'production', datasetId: 'prod-dataset', revision: 3, snapshot: productionDb() },
    coachSandboxActiveCache: sandboxCache()
  }, extraStore || {})
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// ── ① Sandbox 只读自己的权威缓存，绝不读到本机正式区库 ──
test('① Sandbox 环境：getDB() 只能返回 Sandbox 权威缓存，一个正式区学员都不许出现', () => {
  const world = makeWorld({ store: bothWorlds() })
  try {
    const db = world.runtime.getDB()
    const names = (db.students || []).map(student => student.name)
    assert.ok(names.length > 0, 'Sandbox 里应当有学员')
    names.forEach(name => assert.ok(name.indexOf('PROD-') !== 0, `Sandbox 里混进了正式区本机库的学员：${name}`))
    // ⭐ 名字会被故意做成同名（见 sandboxSnapshot），所以判定一律走 **id**，名字说了不算
    const ids = (db.students || []).map(student => String(student.id))
    assert.ok(ids.indexOf('sandbox-student-1') >= 0, '没读到 Sandbox 自己的学员')
    ids.forEach(id => assert.ok(id.indexOf('prod-') !== 0, `Sandbox 里混进了正式区 id：${id}`))
    // 反证：本机正式区库确实存在且更大 —— 若实现退化成本机库，上面这条断言立刻变红
    assert.ok((productionDb().students || []).length >= 2, '假件本身要有判别力')
  } finally { world.restore() }
})

// ── ② fail closed：Sandbox 缓存不可用时必须抛错，不许退回 coachDB ──
test('② Sandbox 缓存缺失 ⇒ 必须 fail closed 抛错，绝不静默退回本机正式区库', () => {
  const store = bothWorlds()
  delete store.coachSandboxActiveCache          // 测试区权威源没了，而本机正式区库还在
  const world = makeWorld({ store })
  try {
    let code = ''
    try { world.runtime.getDB() } catch (error) { code = error.code || '' }
    assert.equal(code, 'CLOUD_CACHE_MISSING', `必须明确报错而不是退回别的数据源，实际：${code || '静默返回了数据'}`)
  } finally { world.restore() }
})

// ── ③ 环境标识对不上也必须 fail closed ──
test('③ Sandbox 缓存被标成别的环境 ⇒ 抛 CACHE_ENVIRONMENT_MISMATCH，不许渲染', () => {
  const store = bothWorlds()
  store.coachSandboxActiveCache = { ...sandboxCache(), environment: 'production' }
  const world = makeWorld({ store })
  try {
    let code = ''
    try { world.runtime.getDB() } catch (error) { code = error.code || '' }
    assert.equal(code, 'CACHE_ENVIRONMENT_MISMATCH', `环境串了必须拦下，实际：${code || '静默返回了数据'}`)
  } finally { world.restore() }
})

// ── ④ Production 行为必须原样（不能被这次修复捎带改坏）──
test('④ Production 行为原样：LOCAL→本机库，CLOUD→正式区 cache', () => {
  const cloud = makeWorld({ environment: 'production', store: bothWorlds() })
  try {
    const db = cloud.runtime.getDB()
    assert.ok((db.students || []).some(student => String(student.id || '').indexOf('prod-') === 0), '云端模式下仍要读正式区 cache')
  } finally { cloud.restore() }

  const local = makeWorld({ environment: 'production', store: { ...bothWorlds(), coachDataSourceMode: 'local-primary' } })
  try {
    const db = local.runtime.getDB()
    assert.ok((db.students || []).some(student => String(student.id || '').indexOf('prod-') === 0), '本机模式下仍要读本机 coachDB')
  } finally { local.restore() }
})

// ── ⑤ 同名学员不得跨环境串（必须按 id 取值，不是按名字）──
test('⑤ Production 与 Sandbox 有同名学员时也不许串 — 取的是 id 不是名字', () => {
  const store = bothWorlds()
  // 正式区库里放一个**同名不同 id** 的学员；沙盒里也有一个同名不同 id 的学员
  store.coachDB.students[1] = { id: 'prod-student-same-name', name: '测试学员小蓝', packages: [{ id: 'prod-package-x', type: '常规训练', remaining: 77, reserved: 0, used: 0 }] }
  const world = makeWorld({ store })
  try {
    const db = world.runtime.getDB()
    const hit = (db.students || []).find(student => student.name === '测试学员小蓝')
    assert.ok(hit, 'Sandbox 里应当有同名学员可读')
    assert.equal(hit.id, 'sandbox-student-1', `同名不能串到正式区那一行，实际拿到 ${hit.id}`)
  } finally { world.restore() }
})

// ── ⑥ 页面必须把「我现在看的是哪一本账」写在脸上 ──
test('⑥ 页面 sourceText / selectedIdsText 必须来自当前 environment', async () => {
  const world = makeWorld({ store: bothWorlds() })
  try {
    const page = world.instantiate()
    await page.cloudRefresh(false)
    await flush()
    assert.ok(page.data.sourceText.indexOf('coachSandboxActiveCache') >= 0, `sourceText 必须点名沙盒那一份缓存，实际：${page.data.sourceText}`)
    assert.ok(page.data.sourceText.indexOf('env=sandbox') >= 0, 'sourceText 必须显示当前 environment')
    assert.ok(page.data.sourceText.indexOf('77548e') >= 0, 'sourceText 必须显示 dataset 尾号')
    assert.ok(page.data.selectedIdsText.indexOf('sandbox-student-1'.slice(-6)) >= 0, `选中的 studentId 必须来自 Sandbox，实际：${page.data.selectedIdsText}`)
    assert.ok(page.data.selectedIdsText.indexOf('sandbox-package-1'.slice(-6)) >= 0, `选中的 packageId 必须来自 Sandbox，实际：${page.data.selectedIdsText}`)
    page.data.selectedIdsText.indexOf('prod-') === -1 && assert.ok(true)
    assert.equal(page.data.selectedIdsText.indexOf('prod-'), -1, '选中项里绝不许出现正式区 id')
    // 顶部那行也必须带 id 尾号 —— 只比对数字会被派生式骗过（10−1=9 与 11−2=9 看起来一样）
    assert.ok(page.data.packageText.indexOf('sandbox-package-1'.slice(-6)) >= 0, `packageText 必须印出包 id 尾号，实际：${page.data.packageText}`)
    assert.equal(page.data.readFailed, false, '读取成功时不该标红')
  } finally { world.restore() }
})

// ── ⑦ 读取失败必须可见，不许静默 ──
test('⑦ refreshActiveView 失败 ⇒ 页面必须明确显示失败码，不许假装没事', async () => {
  const world = makeWorld({ store: bothWorlds(), readResult: { ok: false, code: 'CLOUD_MODE_OFF' } })
  try {
    const page = world.instantiate()
    await page.cloudRefresh(false)
    await flush()
    assert.equal(page.data.readFailed, true, '读取失败必须标记出来')
    assert.ok(page.data.readText.indexOf('CLOUD_MODE_OFF') >= 0, `失败原因必须显示给用户，实际：${page.data.readText}`)
  } finally { world.restore() }
})

// ── ⑧ 不能只验证"函数被调用" —— 必须验证最终权威源真的换了 ──
test('⑧ refreshActiveView 成功后，页面读到的必须是**新的权威源**（不是"调用过就算"）', async () => {
  // 这一轮的云端读取会把沙盒 cache 整份换掉（像真的 readActive 写 cache 那样）
  const world = makeWorld({
    store: bothWorlds(),
    onRead: store => {
      store.coachSandboxActiveCache = { ...sandboxCache(), revision: 42, datasetId: 'sandbox-coach-bbbbbbbbbbbbbbbbbbbbbb', snapshot: sandboxSnapshot({
        students: [{ id: 'sandbox-student-1', name: 'SBX-测试学员小蓝', packages: [{ id: 'sandbox-package-1', type: '常规训练', remaining: 5, reserved: 1, used: 8 }] }]
      }) }
    }
  })
  try {
    const page = world.instantiate()
    await page.cloudRefresh(true)
    await flush()
    assert.equal(world.seen.uiCalls.length, 1, '必须真的读过一次云端')
    assert.ok(page.data.packageText.indexOf('剩余 5') >= 0, `页面必须显示**新权威源**的值，实际：${page.data.packageText}`)
    assert.ok(page.data.packageText.indexOf('已用 8') >= 0, 'used 必须来自新权威源')
    assert.ok(page.data.sourceText.indexOf('rev 42') >= 0, `revision 必须跟着权威源走，实际：${page.data.sourceText}`)
    assert.ok(page.data.sourceText.indexOf('bbbbbb') >= 0, 'dataset 尾号必须跟着权威源走')
  } finally { world.restore() }
})

// ── ⑨ 静态防线：sandbox 分支必须排在 local fallback 之前，且不许走本机库 ──
test('⑨ 静态防线：getDB 必须先拦 Sandbox，再谈本机库；sandboxDB 不许碰 local/CACHE_KEY', () => {
  const sandboxGuard = RUNTIME_SRC.indexOf('if (isSandbox()) return sandboxDB()')
  const localFallback = RUNTIME_SRC.indexOf('if (mode() === MODES.LOCAL) return local.getDB()')
  assert.ok(sandboxGuard > 0, 'getDB 里必须有 Sandbox 专属分支')
  assert.ok(localFallback > 0, 'getDB 里仍要保留正式区本机库分支')
  assert.ok(sandboxGuard < localFallback, '★ Sandbox 分支必须排在本机库 fallback **之前**，否则又会走去拿正式区数据')
  const body = RUNTIME_SRC.slice(RUNTIME_SRC.indexOf('function sandboxDB()'), RUNTIME_SRC.indexOf('function getDB()'))
  assert.ok(body.length > 0, '必须存在 sandboxDB')
  assert.ok(!/local\.getDB|CACHE_KEY/.test(body.replace(/SANDBOX_CACHE_KEY/g, '')), 'sandboxDB 里绝不能引用本机库或正式区 cache key')
  assert.ok(/function sandboxDB\(\)\s*\{/.test(RUNTIME_SRC), 'sandboxDB 必须是不接受外部 id 的零参函数（数据源由 environment 唯一决定）')
  // 页面也不许再单独硬编码读沙盒 key —— 那正是"页面上两本账"的来源
  assert.ok(!/getStorageSync\(runtime\.SANDBOX_CACHE_KEY\)/.test(PAGE_SRC), '页面必须统一走 runtime.cacheKey()，不许再单独硬编码沙盒 key')
})

// ── ⑪ 本机模式 + 测试区：这才是 2026-09-27 的真实条件，最容易退化成"读正式区本机库" ──
test('⑪ Sandbox + 本机模式（非云端）：仍然只能读 Sandbox 缓存，不许拿本机正式区库', () => {
  const store = bothWorlds()
  store.coachDataSourceMode = 'local-primary'   // 本机主数据源模式
  const world = makeWorld({ store })
  try {
    assert.equal(world.runtime.mode(), 'local-primary', '假件必须真的处在本机模式')
    const db = world.runtime.getDB()
    const ids = (db.students || []).map(student => String(student.id))
    assert.ok(ids.length > 0, '本机模式下也应当读到测试区数据')
    ids.forEach(id => assert.ok(id.indexOf('prod-') !== 0, `★ 本机模式 + 测试区读到了正式区本机库的 id：${id}`))
    assert.equal(world.store.coachDB.students[0].id, 'prod-student-1', '正式区本机库确实存在于同一台设备上（否则没判别力）')
  } finally { world.restore() }
})

// ── ⑩ 页面的一切数据都必须来自同一个 cacheKey，不许另开一条路 ──
test('⑩ 页面所有 storage 读取都走 runtime.cacheKey()，不存在第二个来源', () => {
  const reads = PAGE_SRC.match(/wx\.getStorageSync\([^)]*\)/g) || []
  reads.forEach(read => {
    if (read.indexOf('runtime.cacheKey()') >= 0) return
    if (read.indexOf('acceptance') >= 0) return
    assert.fail(`页面出现了一处不来自当前环境的独立读取：${read}`)
  })
  assert.ok(reads.some(read => read.indexOf('runtime.cacheKey()') >= 0), '页面必须至少有一处走 runtime.cacheKey()')
})

;(async () => {
  let passed = 0
  const failures = []
  for (const item of tests) {
    try {
      await item.fn()
      passed += 1
      console.log('PASS ' + item.name)
    } catch (error) {
      failures.push(item.name)
      console.log('FAIL ' + item.name)
      console.log('     ' + String(error && error.message || error).split('\n').join('\n     '))
    }
  }
  console.log(failures.length ? `\n${failures.length} FAILED / ${tests.length}` : `\nALL ${tests.length} ${tests[0] ? 'PASSED' : ''}`.trim())
  process.exitCode = failures.length ? 1 : 0
})()
