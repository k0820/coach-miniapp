// M2 真机事故回归（2026-09-27）：**M2 验收页"刷新"了，但刷的是本机旧快照**。
//
// 现场：A 手机顶部一直显示 10 / 1 / 9；同一时刻用共享码读云端那一行是 11 / 2 / 9（已用 2）。
// 根因：本页 refresh() 只读 runtime.getDB()（Storage 里的旧快照 + Outbox 投影），零网络；
//   于是"重新进入 / 回前台 / 下拉"全都只是在重读同一份旧字节。
// 更难发现的一点：`还能约 = max(剩余 − 已占, 0)` 是派生值，完课时「剩余 −1、已占 −1」
//   会让它一动不动 ⇒ 只看"还能约"永远看不出位移。所以本测试把 **used 一起断言**。
//
// 本文件只测这一件事：这个页面的刷新路径**必须真的经过 ui.refreshActiveView**，
// 且"进入页面 / 回前台 / 下拉 / 写命令后"共用同一道合并与 in-flight 防重门（不许读两三遍）。
// 不测业务规则（remaining/reserved/used 的口径由既有测试守）。

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const PAGE = 'pages/sandbox-shared-test/sandbox-shared-test'
const ROOT = path.join(__dirname, '..')

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

// 确定性"把微任务跑干"，不用 sleep。
// ⚠️ 为什么必须 flush：假件里如果 refreshActiveView 写成 async 再返回闸门 promise，
//    `await` 一个 async 返回值会多出几跳微任务 ⇒ 测试的断言会跑在页面 refresh() **之前**，
//    于是"顶部显示云端值"永远绿不了。这里既把假件写成直接返回 promise，也显式 flush 兜底。
const flush = async (rounds = 8) => { for (let i = 0; i < rounds; i++) await Promise.resolve() }

// 假世界：真页面 + 真 auto-refresh + 真 m2-shared-acceptance，只把「本机库」和「云端读取」换成可观测的假件。
// ⭐ 假件必须复现真形状：refreshActiveView 真的会**改变 getDB() 的返回值**（云端权威值覆盖本机快照），
//    否则"顶部最终显示 11/2/9"这条断言在假世界里永远绿 —— 那正是这次事故在测试里的样子。
function withWorld() {
  const seen = { uiCalls: [], deferreds: [] }
  let useCloud = false
  const localDb = {
    students: [{ id: 's1', name: '测试学员小蓝', packages: [{ id: 'p1', type: '常规训练', remaining: 10, reserved: 1, used: 1 }] }],
    bookings: [], sales: [], incomes: []
  }
  const cloudDb = {
    students: [{ id: 's1', name: '测试学员小蓝', packages: [{ id: 'p1', type: '常规训练', remaining: 11, reserved: 2, used: 2 }] }],
    bookings: [], sales: [], incomes: []
  }
  global.wx = {
    getStorageSync: () => ({ datasetId: 'sandbox-coach-abcdef' }),
    setStorageSync: () => {},
    stopPullDownRefresh: () => { seen.stopped = (seen.stopped || 0) + 1 },
    showToast: () => {},
    showModal: () => {},
    showLoading: () => {},
    hideLoading: () => {}
  }
  global.Page = config => { seen.config = config }

  const runtimePath = require.resolve('../utils/data-runtime')
  const mutatePath = require.resolve('../utils/mutate')
  const uiPath = require.resolve('../utils/ui-cloud-command')
  const saved = {
    runtime: require.cache[runtimePath], mutate: require.cache[mutatePath], ui: require.cache[uiPath],
    page: require.cache[require.resolve(`../${PAGE}.js`)]
  }
  require.cache[runtimePath] = { id: runtimePath, filename: runtimePath, loaded: true, exports: {
    SANDBOX_CACHE_KEY: 'coachSandboxActiveCache',
    CACHE_KEY: 'coachCloudActiveCache',
    MODES: { LOCAL: 'local-primary', CLOUD: 'cloud-primary' },
    isSandbox: () => true,
    // ⭐ 数据源可观测三件套必须一并补齐：页面会把 cacheKey / env / mode 印到「数据源与读取状态」卡里，
    //    假件少了它们就不是"真形状"，而且一漏就是 TypeError 崩溃（已经踩过一次）。
    cacheKey: () => 'coachSandboxActiveCache',
    environment: () => 'sandbox',
    mode: () => 'cloud-primary',
    getDB: () => (useCloud ? cloudDb : localDb)
  } }
  const fakeMutate = async () => ({ ok: true, result: {} })
  fakeMutate.isCloudWritePath = () => true
  require.cache[mutatePath] = { id: mutatePath, filename: mutatePath, loaded: true, exports: fakeMutate }
  require.cache[uiPath] = { id: uiPath, filename: uiPath, loaded: true, exports: {
    // 故意**不写成 async**：直接返回闸门 promise，让页面的 await 与测试的 await 挂在同一条微任务队列上。
    refreshActiveView: options => {
      seen.uiCalls.push({ userInitiated: !!(options && options.userInitiated) })
      useCloud = true                        // ★ 云端读取成功后权威值覆盖本机快照
      const gate = deferred()
      seen.deferreds.push(gate)
      return gate.promise
    }
  } }
  delete require.cache[require.resolve(`../${PAGE}.js`)]
  require(`../${PAGE}.js`)

  const restore = () => {
    delete require.cache[require.resolve(`../${PAGE}.js`)]
    Object.keys(saved).forEach(key => {
      if (key === 'page') return
      if (saved[key]) require.cache[saved[key].id] = saved[key]
    })
    delete global.Page
    delete global.wx
    require('../utils/auto-refresh').unsubscribeAll()
  }
  const instantiate = () => {
    const page = Object.assign({}, seen.config)
    page.data = JSON.parse(JSON.stringify(seen.config.data))
    page.setData = (patch, callback) => { Object.keys(patch || {}).forEach(key => { page.data[key] = patch[key] }); if (callback) callback() }
    return page
  }
  const releaseLast = async () => {
    const gate = seen.deferreds[seen.deferreds.length - 1]
    gate.resolve({ ok: true, datasetId: 'sandbox-coach-abcdef', revision: 9 })
    await gate.promise
    await flush()
  }
  return { seen, instantiate, restore, releaseLast, localDb, cloudDb }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// ── A + D：进入页面必须真的读云端，且顶部最终显示云端值（不是旧快照）──
test('① 进入页面必须调 refreshActiveView，且顶部最终显示云端 11/2/9（已用 2）', async () => {
  const world = withWorld()
  try {
    const page = world.instantiate()
    page.onShow()
    assert.equal(world.seen.uiCalls.length, 1, '★ 进入验收页必须真的读一次云端（不是只读 runtime.getDB）')
    assert.equal(world.seen.uiCalls[0].userInitiated, false)
    assert.equal(page.data.packageText, '—', '云端还没回来之前不应伪造任何数字')
    await world.releaseLast()
    // ⚠️ 用"包含"而不是"全等"：顶部课时行现在还会印出 packageId 尾号（用来证明两条数字链指向同一行），
    //    用全等会让这条无关的新格式变化把测试搞红，掩盖真正要守的那件事。
    assert.ok(page.data.packageText.indexOf('常规训练') === 0, `顶部应以课程类型开头，实际：${page.data.packageText}`)
    assert.ok(page.data.packageText.indexOf('剩余 11 · 已占 2 · 还能约 9 · 已用 2') >= 0,
      '★ 云端 11/2/used2 ⇒ 顶部必须是 11/2/9/已用2，绝不能留旧快照的 10/1/9')
    assert.ok(page.data.packageText.indexOf('…p1') >= 0, '顶部必须带 packageId 尾号，否则两条链无法证明指向同一行')
  } finally { world.restore() }
})

// ── B：回前台必须重新读云端 ──
test('② 回到前台：可见的验收页必须重新读一次云端', async () => {
  const world = withWorld()
  try {
    const page = world.instantiate()
    page.onShow()
    await world.releaseLast()
    const before = world.seen.uiCalls.length
    const autoRefresh = require('../utils/auto-refresh')
    assert.equal(autoRefresh.subscriberCount(), 1, '页面必须挂上订阅者，否则广播空转')
    const ok = autoRefresh.request('appForeground', Date.now() + 1000)
    assert.equal(ok, true, 'appForeground 必须真的广播出去')
    assert.equal(world.seen.uiCalls.length, before + 1, '★ 回前台必须真的再读一次云端')
    await world.releaseLast()
    // 页面被切走后不能再响应广播（否则四个页面一起打云端）
    page.onHide()
    autoRefresh.request('appForeground', Date.now() + 5000)
    assert.equal(world.seen.uiCalls.length, before + 1, '★ 不可见页面不得响应刷新广播')
  } finally { world.restore() }
})

// ── C：下拉刷新必须重新读云端，且标记为 userInitiated ──
test('③ 下拉刷新：走同一个云端入口，且必须标记为 userInitiated', async () => {
  const world = withWorld()
  try {
    const page = world.instantiate()
    page.onShow()
    await world.releaseLast()
    const before = world.seen.uiCalls.length
    // ⚠️ 绝不能 `await` 这个调用：云端闸门还没放行，它会一直挂着（进程被饿死、退出码 0、零输出）。
    const inFlight = page.onPullDownRefresh()
    assert.equal(world.seen.uiCalls.length, before + 1, '★ 下拉必须真的再读一次云端')
    assert.equal(world.seen.uiCalls[world.seen.uiCalls.length - 1].userInitiated, true, '用户主动刷新必须标记 userInitiated')
    await world.releaseLast()
    await inFlight
    await flush()
    assert.equal(world.seen.stopped >= 1, true, '下拉指示必须被收掉')
    assert.ok(page.data.packageText.indexOf('剩余 11 · 已占 2 · 还能约 9 · 已用 2') >= 0, '下拉后顶部必须是云端那一版')
  } finally { world.restore() }
})

// ── E：一次事件不许读两三遍（400ms 合并 + in-flight 防重，两条门都要生效）──
test('④ 一次触发只读一次：400ms 内合并 + 上一轮没回来不叠加', async () => {
  const world = withWorld()
  try {
    const page = world.instantiate()
    const autoRefresh = require('../utils/auto-refresh')
    const base = Date.now()
    page.onShow()
    assert.equal(world.seen.uiCalls.length, 1)
    // ① 与 pageShow 同一拍（<400ms）的 appForeground ⇒ 合并掉
    autoRefresh.request('appForeground', base + 10)
    assert.equal(world.seen.uiCalls.length, 1, '★ 400ms 内的重复触发必须合并')
    // ② 上一轮**还没回来**（闸门未放行）⇒ 换时间也不叠加
    autoRefresh.request('appForeground', base + 1000)
    autoRefresh.request('bookingCompleted', base + 2000)
    autoRefresh.request('sessionReturn', base + 3000)
    assert.equal(world.seen.uiCalls.length, 1, '★ 上一轮没回来时不许叠加请求')
    // ③ 放行之后、超过合并窗口 ⇒ 才允许再读一次
    await world.releaseLast()
    autoRefresh.request('bookingCompleted', base + 5000)
    assert.equal(world.seen.uiCalls.length, 2, '放行后新的触发点必须真的读')
    await world.releaseLast()
  } finally { world.restore() }
})

// ── F：刷新后必须保持当前学员 / 课时包选择 ──
test('⑤ 刷新后保持当前学员与课时包选择；只有选中项消失才回退', async () => {
  const world = withWorld()
  try {
    // 两个学员、第一个学员有两个包 —— 旧代码（`packageIndex: 0`）在**第二个学员 / 第二个包**
    // 上必然弹回，只有一个包时看不出来，所以假件必须造出"选了非首项"的情形。
    const shape = () => ([
      { id: 's1', name: '甲', packages: [{ id: 'p1', type: '常规训练', remaining: 3, reserved: 0, used: 0 }, { id: 'p2', type: '拉伸', remaining: 5, reserved: 1, used: 0 }] },
      { id: 's2', name: '乙', packages: [{ id: 'p3', type: '私教', remaining: 8, reserved: 2, used: 1 }] }
    ])
    world.localDb.students = shape()
    world.cloudDb.students = shape()
    const page = world.instantiate()
    page.onShow()
    await world.releaseLast()                       // 第一次渲染：默认选中「甲 / p1」
    assert.equal(page.data.studentIndex, 0)
    assert.equal(page.data.packageIndex, 0)
    // ⭐ 判别点：选「甲 / p2」（**不是第一个包**）后刷新 ——
    //    旧代码每次刷新都写 `packageIndex: 0`，这里必然被弹回 p1；只有一个包时看不出来。
    page.data.studentIndex = 0
    page.data.packageIndex = 1
    page.refresh()
    assert.equal(page.data.packageIndex, 1, '★ 课时包选择必须保持')
    assert.ok(/拉伸/.test(page.data.packageText), '★ 刷新后仍是用户选的那个包，不得弹回第一个')
    // 用户改成「乙 / p3」后再刷新 —— 必须还是「乙 / p3」
    page.data.studentIndex = 1
    page.data.packageIndex = 0
    page.refresh()
    assert.equal(page.data.studentIndex, 1, '★ 学员选择必须保持')
    assert.ok(/私教/.test(page.data.packageText), '★ 刷新后仍是用户选的那个包，不得弹回第一个')
    // 选中项（p3）在云端已经不存在 ⇒ 安全回退到该学员的第一个包，绝不越界
    world.cloudDb.students[1].packages = [{ id: 'p4', type: '康复', remaining: 2, reserved: 0, used: 0 }]
    page.refresh()
    assert.equal(page.data.studentIndex, 1)
    assert.equal(page.data.packageIndex, 0, '选中项消失时应回退到 0，不得越界')
    assert.ok(/康复/.test(page.data.packageText))
  } finally { world.restore() }
})

// ── used 必须可见：派生值会把位移藏起来 ──
test('⑥ 顶部必须印出 used，且 usedOf 是纯函数口径', async () => {
  const acceptance = require('../utils/m2-shared-acceptance')
  assert.equal(acceptance.usedOf({ used: 2 }), 2)
  assert.equal(acceptance.usedOf({ used: undefined }), 0)
  assert.equal(acceptance.usedOf(null), 0)
  assert.equal(acceptance.usedOf({ used: -1 }), 0)
  const world = withWorld()
  try {
    const page = world.instantiate()
    page.onShow()
    await world.releaseLast()
    assert.ok(/已用 2/.test(page.data.packageText), '★ 顶部必须印出"已用"，否则 remaining/reserved 同时变化时看不出来')
    assert.ok(/剩余 11 · 已占 2 · 还能约 9 · 已用 2/.test(page.data.packageText))
  } finally { world.restore() }
})

// ── 静态防线：防止有人把接线改回"只读本机" ──
test('⑦ 静态：刷新链必须指向云端入口，且本页不得自带会重复请求的 onShow', async () => {
  const src = fs.readFileSync(path.join(ROOT, `${PAGE}.js`), 'utf8')
  const body = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(/refreshActiveView/.test(body), '刷新链必须经过 ui.refreshActiveView')
  assert.ok(/refresh\(\)\s*\{\s*return this\.cloudRefresh\(false\)/.test(body), 'installPage 的 refresh 必须指向 cloudRefresh')
  assert.ok(!/onShow\s*\(\s*\)\s*\{\s*this\.refresh\(\)/.test(body), '★ 不允许再有"onShow 直接读本机"这条老路径')
  assert.ok(/installAutoRefresh\(/.test(body), '页面必须接 installPage（回前台靠它）')
  assert.ok(!/setInterval/.test(body), '不允许轮询')
})

;(async () => {
  let failed = 0
  for (const item of tests) {
    try { await item.fn(); console.log(`PASS  ${item.name}`) }
    catch (error) { failed++; console.log(`FAIL  ${item.name}\n      ${error && error.message}`) }
  }
  console.log(failed ? `\n${failed} FAILED / ${tests.length}` : `\nALL ${tests.length} PASSED`)
  process.exit(failed ? 1 : 0)
})()
