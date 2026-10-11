// M2 自动刷新「缺口修复」永久回归（2026-09-27）。
//
// ⛔ 事故（只读核对实测出来的，不是猜的）：
//   app.js 一直在 `request('appForeground')`，但全项目**零个** `subscribe()` 调用
//   ⇒ 广播空转，从后台回到前台后当前页面不会重读，只有"进页面 / 下拉"才更新。
//   根因不是缺触发点，是**缺订阅者** —— 所以这里钉死的是"广播必须有人听、听了必须真读、且只读一遍"。
//
// 本文件只钉这五件事（不重写刷新系统，也不新增第二套机制）：
//  ① appForeground 确实有订阅者；
//  ② 回前台能触发**当前可见的关键页面**真实重读（用真页面对象，不用假件页面）；
//  ③ 一次事件不重复请求（400ms 合并 + in-flight 不叠加 + 不可见页面不刷）；
//  ④ 下拉刷新仍然可用（自动刷新是默认，下拉是兜底，两者都不能没）；
//  ⑤ 不许用 setInterval / 高频轮询冒充自动刷新。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')
const autoRefresh = require('../utils/auto-refresh')

const tests = []
const test = (name, fn) => tests.push({ name, fn })
// 让"上一轮已回来"的微任务落地（真实运行时是自然的异步间隔，测试里必须显式等一拍）。
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

// ───────────────────────────────────────────────────────────── ① 广播必须有人听
test('① appForeground 广播**确实有订阅者** —— 零订阅者 = 本次事故（回前台不刷新）', async () => {
  autoRefresh.unsubscribeAll()
  assert.equal(autoRefresh.subscriberCount(), 0, '没有页面接入时订阅者为 0（这是事故现场）')
  const calls = []
  const page = { data: {} }
  autoRefresh.installPage(page, { refresh(reason) { calls.push(reason); return Promise.resolve() } })
  assert.equal(autoRefresh.subscriberCount(), 0, '还没 onShow 的页面不占订阅位')
  page.onShow()
  assert.equal(autoRefresh.subscriberCount(), 1, '★ 页面 onShow 后必须真的挂上订阅者（否则广播空转）')
  assert.deepStrictEqual(calls, ['pageShow'], '进入页面读一次，且只读一次')
  await tick()
  const broadcast = autoRefresh.request('appForeground', Date.now() + 1000)
  assert.equal(broadcast, true, '回前台必须真的广播出去')
  assert.deepStrictEqual(calls, ['pageShow', 'appForeground'], '★ 回前台必须触发当前页面重读')
  autoRefresh.unsubscribeAll()
})

// ───────────────────────────────────────────────────────────── ② 真页面：教练课表
function makeWx() {
  const storage = new Map()
  return {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => { storage.set(key, JSON.parse(JSON.stringify(value))) },
    removeStorageSync: key => storage.delete(key),
    cloud: { init: () => {}, callFunction: async () => ({ result: { ok: true } }) },
    getNetworkType: () => {}, onNetworkStatusChange: () => {},
    reLaunch: () => {}, navigateTo: () => {}, redirectTo: () => {}, navigateBack: () => {},
    showModal: () => {}, showToast: () => {}, showLoading: () => {}, hideLoading: () => {},
    stopPullDownRefresh: () => {}, setClipboardData: () => {}, nextTick: fn => fn(),
    showTabBar: () => {}, hideTabBar: () => {}, pageScrollTo: () => {},
    createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => {} }), selectViewport: () => ({ scrollOffset: () => {} }), exec: () => {} })
  }
}
// 真页面对象：只把 mutate 换成记录型假件（本测试不写任何东西），页面/刷新链全部是真模块。
function openSchedulePage() {
  const pageFile = 'pages/schedule/schedule.js'
  const mutatePath = require.resolve(path.join(root, 'utils/mutate'))
  const savedMutate = require.cache[mutatePath]
  const fakeMutate = async () => { throw new Error('本测试只验证刷新链，不应走到写入口') }
  fakeMutate.isCloudWritePath = () => true
  fakeMutate.localFirstEnabled = () => true
  fakeMutate.sync = { schedule: () => {} }
  fakeMutate.resumePendingBookings = async () => ({})
  require.cache[mutatePath] = { id: mutatePath, filename: mutatePath, loaded: true, exports: fakeMutate }
  let config = null
  const savedPage = global.Page
  global.Page = value => { config = value }
  global.wx = makeWx()
  delete require.cache[require.resolve(path.join(root, pageFile))]
  require(path.join(root, pageFile))
  global.Page = savedPage
  if (savedMutate) require.cache[mutatePath] = savedMutate; else delete require.cache[mutatePath]
  const page = Object.assign({}, config)
  page.data = JSON.parse(JSON.stringify(config.data))
  page.setData = (patch, callback) => { Object.keys(patch || {}).forEach(key => { page.data[key] = patch[key] }); if (callback) callback() }
  return page
}

test('② 回前台 ⇒ 当前可见的**教练课表**真的重读一次（真页面对象 + 真刷新链）', async () => {
  autoRefresh.unsubscribeAll()
  const page = openSchedulePage()
  const seen = []
  page.loadScheduleData = () => {}
  page.renderCurrentView = () => {}
  page.resumeContentCopy = () => {}
  page.refreshSchedule = async options => { seen.push((options && options.reason) || 'onShow') }
  page.onShow()
  assert.deepStrictEqual(seen, ['onShow'], '进入课表读一次（页面自己的 onShow 负责，总线不重复）')
  assert.equal(autoRefresh.subscriberCount(), 1, '课表页必须挂上订阅者')
  await tick()
  autoRefresh.request('appForeground', Date.now() + 1000)
  assert.deepStrictEqual(seen, ['onShow', 'appForeground'], '★ 回到前台：可见的课表页必须真的重读')
  // 从课程详情返回 / 写命令成功 —— 同样必须落到这个可见页面上
  await tick()
  autoRefresh.request('sessionReturn', Date.now() + 2000)
  await tick()
  autoRefresh.request('bookingCompleted', Date.now() + 3000)
  await tick()
  assert.deepStrictEqual(seen, ['onShow', 'appForeground', 'sessionReturn', 'bookingCompleted'])
  autoRefresh.unsubscribeAll()
  page.onUnload()
})

// ───────────────────────────────────────────────────────────── ③ 不重复请求
test('③ 一次事件不重复请求：400ms 合并 + 上一轮没回来不叠加 + 不可见页面不刷', async () => {
  autoRefresh.unsubscribeAll()
  const calls = []
  let pending = null
  const page = { data: {} }
  autoRefresh.installPage(page, {
    refresh(reason) {
      calls.push(reason)
      // 第一次返回一个**永不 settle** 的 promise，模拟"上一轮还在飞"
      if (reason === 'appForeground') { pending = new Promise(() => {}); return pending }
      return Promise.resolve()
    }
  })
  page.onShow()
  assert.deepStrictEqual(calls, ['pageShow'])
  await tick()
  // ② in-flight：上一轮还没回来 ⇒ 绝不叠加第二次请求（换别的触发点也不行）
  const t = Date.now()
  assert.equal(autoRefresh.request('appForeground', t + 1000), true)
  assert.deepStrictEqual(calls, ['pageShow', 'appForeground'])
  autoRefresh.request('bookingCreated', t + 2000)
  autoRefresh.request('sessionReturn', t + 3000)
  assert.deepStrictEqual(calls, ['pageShow', 'appForeground'], '★ 上一轮没回来时不得叠加请求')
  autoRefresh.unsubscribeAll()

  // ③ 同一触发点 400ms 内合并（总线层）；④ 不可见页面不刷 —— 用一个"能正常回来"的页面单独验
  autoRefresh.unsubscribeAll()
  const seen = []
  const other = { data: {} }
  autoRefresh.installPage(other, { refresh(reason) { seen.push(reason); return Promise.resolve() } })
  other.onShow()
  await tick()
  assert.deepStrictEqual(seen, ['pageShow'])
  const u = Date.now()
  assert.equal(autoRefresh.request('bookingCreated', u + 1000), true)
  await tick()
  assert.deepStrictEqual(seen, ['pageShow', 'bookingCreated'])
  assert.equal(autoRefresh.request('bookingCreated', u + 1100), false, '400ms 内的重复触发必须合并（总线层）')
  // ④ 切走 tab / 进子页 ⇒ 不响应广播（否则四个 tab 页会一起打云端）
  other.onHide()
  autoRefresh.request('appForeground', u + 2000)
  autoRefresh.request('bookingCompleted', u + 3000)
  await tick()
  assert.deepStrictEqual(seen, ['pageShow', 'bookingCreated'], '★ 不可见页面不得刷新')
  autoRefresh.unsubscribeAll()
})

// ───────────────────────────────────────────────────────────── ④ 下拉刷新兜底仍在
test('④ 下拉刷新是兜底：页面自己的下拉不被覆盖，没下拉的页面由 installPage 补上', async () => {
  autoRefresh.unsubscribeAll()
  // 页面已有 onPullDownRefresh ⇒ 绝不能被覆盖（覆盖 = 用户手动刷新静默失效）
  const own = []
  const withOwn = { data: {}, onPullDownRefresh() { own.push('pull') } }
  autoRefresh.installPage(withOwn, { refresh() { return Promise.resolve() } })
  withOwn.onPullDownRefresh()
  assert.deepStrictEqual(own, ['pull'], '页面自己的下拉刷新必须保留')

  const calls = []
  const bare = { data: {} }
  autoRefresh.installPage(bare, { refresh(reason) { calls.push(reason); return Promise.resolve() } })
  assert.equal(typeof bare.onPullDownRefresh, 'function', '没有下拉的页面必须装上兜底')
  bare.onPullDownRefresh()
  assert.deepStrictEqual(calls, ['pullDown'], '下拉刷新必须真的读一次')
  autoRefresh.unsubscribeAll()

  // 关键页面的 json 必须真的开了下拉刷新
  ;['pages/schedule/schedule.json', 'pages/students/students.json', 'pages/stats/stats.json', 'pages/member-home/member-home.json'].forEach(file => {
    assert.equal(JSON.parse(read(file)).enablePullDownRefresh, true, `${file} 必须支持下拉刷新`)
  })
  ;['pages/schedule/schedule.js', 'pages/students/students.js', 'pages/stats/stats.js', 'pages/member-home/member-home.js'].forEach(file => {
    assert.ok(/onPullDownRefresh/.test(read(file)), `${file} 必须有下拉刷新处理`)
  })
})

// ───────────────────────────────────────────────────────────── ⑤ 五个关键页面都接上总线
test('⑤ 五个关键页面全部接上 installPage（接了才算"该刷新时一定刷新"）', async () => {
  const pages = {
    '教练课表': 'pages/schedule/schedule.js',
    '学员': 'pages/students/students.js',
    '统计': 'pages/stats/stats.js',
    '会员首页': 'pages/member-home/member-home.js',
    'M2 真机验收页（仅测试用）': 'pages/sandbox-shared-test/sandbox-shared-test.js'
  }
  Object.entries(pages).forEach(([label, file]) => {
    const code = read(file)
    assert.ok(/installAutoRefresh\(\{/.test(code), `${label}（${file}）必须把页面对象交给 installPage 包装 ⇒ 否则回前台不会刷`)
    assert.ok(/require\('\.\.\/\.\.\/utils\/auto-refresh'\)\.installPage/.test(code), `${label}（${file}）必须 require 的是**同一个** auto-refresh 模块（不许再造第二套）`)
  })
})

test('⑤b 学员页 / 统计页：自动刷新走的是**真的云端重读**，不是只重画本机缓存', async () => {
  ;['pages/students/students.js', 'pages/stats/stats.js'].forEach(file => {
    const code = read(file)
    assert.ok(/cloudRefresh\(/.test(code), `${file} 必须有真读云端的 cloudRefresh`)
    assert.ok(/refreshActiveView/.test(code), `${file} 的 cloudRefresh 必须真的调 refreshActiveView`)
  })
  // 下拉刷新与自动刷新共用同一条读法（不允许出现两套）
  ;['pages/students/students.js', 'pages/stats/stats.js'].forEach(file => {
    const code = read(file)
    assert.ok(/pullRefresh\(\)\{[\s\S]{0,200}cloudRefresh\(true\)/.test(code), `${file} 的下拉必须复用 cloudRefresh(true)`)
  })
})

// ───────────────────────────────────────────────────────────── ⑥ 不许轮询
test('⑥ ⛔ 不得用 setInterval / 定时轮询冒充自动刷新', async () => {
  const module_ = read('utils/auto-refresh.js')
  assert.ok(!/setInterval/.test(module_), '自动刷新模块不许出现 setInterval')
  assert.ok(!/setTimeout\(/.test(module_), '自动刷新模块不许出现定时轮询')
  ;['pages/schedule/schedule.js', 'pages/students/students.js', 'pages/stats/stats.js', 'pages/member-home/member-home.js'].forEach(file => {
    const code = read(file).split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    assert.ok(!/setInterval\(/.test(code), `${file} 不许用定时轮询代替触发点刷新`)
  })
  assert.equal(autoRefresh.PERFORMANCE_BUDGET_MS, 2000, '≤2 秒是"触发后呈现"的目标，不是每 2 秒请求一次')
})

;(async () => {
  for (const item of tests) {
    try { await item.fn(); process.stdout.write(`PASS ${item.name}\n`) } catch (error) { process.stderr.write(`FAIL ${item.name}: ${error.stack}\n`); process.exitCode = 1 }
  }
  if (!process.exitCode) process.stdout.write('ALL M2 FOREGROUND REFRESH TESTS PASSED\n')
})()
