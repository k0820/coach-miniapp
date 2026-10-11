// 阶段 2 测试用「假世界」。
//
// 设计原则（与第 36 节的教训一致）：**假件只能比真实服务端更严，不能更松**。
// 所以这里的服务端不是手写的 if/else，而是**项目里那份已经验证过的纯业务引擎**
// （utils/cloud-command-engine.js 的 InMemoryCommandEngine —— 它与真实云函数 coachBusinessCommand
//  的 core.js + handlers.js 同构，并且被 tests/cloud-command-engine.test.js 与
//  tests/coach-business-command-*.test.js 逐条钉住）。
// 于是「服务端语义」这一层不需要再被模拟一次：receipt、payloadHash、expectedRevision、
// requestId 复用即幂等，全部是真实实现。
//
// 真实模块（不被替换）：local-transaction / local-outbox / local-projection / sync-engine /
// mutate / data-runtime / exercise-picker / session。
// 被替换的只有 ui-cloud-command（它内部就是"云"）—— 这是本项目既有测试的通用做法。
const path = require('path')
const { InMemoryCommandEngine } = require(path.join(__dirname, '..', '..', 'utils', 'cloud-command-engine'))

const PROJ = path.join(__dirname, '..', '..')
const OWNER = 'coach-owner'
const DATASET = 'ds-test'
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
// 让"事件循环转几圈"：本机先行 + 后台同步的断言必须显式跨过微任务与宏任务边界，而不是靠 sleep 赌时间。
const settle = async (rounds = 30) => { for (let i = 0; i < rounds; i++) await delay(1) }

// ---------------------------------------------------------------- 替换 ui-cloud-command（其余模块全是真的）
//
// ⚠️ 注入必须发生在**任何项目模块被 require 之前**，所以这份替身在模块加载时就写进 require.cache，
// 而不是等到 createWorld()。踩过的坑：测试文件顶部 `require('../utils/mutate')` 先跑，
// mutate 在那时就绑定了**真的** ui-cloud-command —— 后面再注入替身也换不掉它已经抓住的引用，
// 于是「约课」静默走了真协调器，而它返回的形状里根本没有 path:'local-first'。
// 替身的方法全部通过 ACTIVE 委派给"当前世界"，因此多个 world 可以依次创建、互不串数据。
let ACTIVE = null
const uiPath = require.resolve(path.join(PROJ, 'utils', 'ui-cloud-command.js'))
// 运行期命令通道（云端先行那 9 条走这里）。默认**照旧抛错** —— 阶段 2 的测试不该偷偷用遮罩通道；
// 只有显式声明了 `allowMaskedCommands` 的世界才放行。放行时也**不是**"跳过云端"：
// 它走的是同一份真实 adapter 语义（离线即拒 / 按 key 单航班且 requestId 稳定 / revision 缺失先补回读 / onSuccess 回调），
// 用途正是"从零把整条链跑一遍"（首次开通 → 建学员 → 建课包）。
async function maskedRun(options) {
  if (!ACTIVE || !ACTIVE.allowMaskedCommands) throw new Error('阶段 2 的测试里不应再走运行期遮罩命令通道')
  return ACTIVE.runMasked(options)
}
const operationIdFor = key => `op_${key}`
const uiStub = {
  get adapter() { return ACTIVE ? ACTIVE.adapter : null },
  // ★ 与真件同口径：数据源模式说了算（真件读的就是 runtime.mode()）。
  //   默认世界是 cloud-primary，所以既有测试的行为一字不变；
  //   而"全新设备 / 清缓存重装"那些世界在本机模式下必须如实返回 false —— 否则
  //   「断网时本机记账照常可用」这条断言会被一个恒为 true 的替身悄悄抹掉。
  isCloudPrimary: () => {
    if (!ACTIVE) return true
    try {
      const runtime = require(path.join(PROJ, 'utils', 'data-runtime'))
      return runtime.mode() === runtime.MODES.CLOUD
    } catch (error) { return true }
  },
  isCloudWritable: () => !!ACTIVE && ACTIVE.online,
  setOnline: value => { if (ACTIVE) ACTIVE.online = value !== false },
  switchEnvironment: async () => ({ ok: false, code: 'NOT_USED' }),
  runCommand: options => maskedRun(options),
  runCommandSilent: options => maskedRun(options),
  operationId: key => `op_${key}`,
  clearPending() {},
  submitBooking: async () => (ACTIVE && ACTIVE.coordinatorOffline ? { ok: false, code: 'OFFLINE_READ_ONLY' } : { ok: false, code: 'NOT_USED' }),
  cancelBookingRequest: async () => (ACTIVE && ACTIVE.coordinatorOffline ? { ok: false, code: 'OFFLINE_READ_ONLY' } : { ok: false, code: 'NOT_USED' }),
  retryPendingBooking: async () => ({ ok: false, code: 'NOT_USED' }),
  retryPendingCancellation: async () => ({ ok: false, code: 'NOT_USED' }),
  resumePendingBookings: async () => ({ ok: true }),
  pendingBookingRecords: () => [],
  mergePendingBookings: list => list,
  subscribePendingBookings: () => () => {},
  notifyPendingBookings() {},
  pendingCancellationRecords: () => [],
  officialIdForBooking: key => (ACTIVE && ACTIVE.bindings[key]) || '',
  awaitOfficialBooking: async key => (ACTIVE && ACTIVE.bindings[key]) || '',
  bindingForOfficialId: () => null,
  bookingBindings: () => [],
  // ★ 与真件同口径：真件的 completionIntentFor 读的就是本机「完课意图」记录。
  //   以前这里恒返回 null —— 那是个**太松**的假件：它把「刚点完下课再进课程页会被当成待完成」
  //   这一整类缺陷在测试世界里抹掉了（而那正是真机上误报"训练内容没有在云端确认保存"的根因）。
  completionIntentFor: input => {
    if (!ACTIVE) return null
    try {
      const runtime = require(path.join(PROJ, 'utils', 'data-runtime'))
      const cache = wx.getStorageSync(runtime.cacheKey())
      const datasetId = cache && cache.datasetId
      if (!datasetId) return null
      return require(path.join(PROJ, 'utils', 'pending-completion')).intentFor(runtime.environment(), datasetId, (input && input.officialId) || '', (input && input.localKey) || '')
    } catch (error) { return null }
  },
  getTimings: () => [],
  setTimingSink() {},
  __writeFunnel: { active: 0, enforced: false, enter() { this.active += 1 }, exit() { this.active = Math.max(0, this.active - 1) }, enforce(value) { this.enforced = value !== false; return this.enforced } },
  __assertWriteFunnel() {}
}
function injectUi() { require.cache[uiPath] = { id: uiPath, filename: uiPath, loaded: true, exports: uiStub } }
function restoreUi() { delete require.cache[uiPath] }
injectUi()

function createWorld(options = {}) {
  const store = {}
  // 新世界 = 新 Storage：投影的 memo 是跟着「一份存储」走的，换存储必须清掉，否则会串上一台机器的状态。
  require(path.join(PROJ, 'utils', 'local-projection')).invalidate()
  // 教练身份 / 数据集可由调用方指定（默认仍是既有那台机器）。
  // 「首次开通」的测试必须拿**确定性派生**出来的 coachId + datasetId 把两边对齐 —— 服务端固定 id 规则
  // （coachIdFor / fixedId）与客户端读到的那一份必须是同一个，否则断言就只是自说自话。
  const owner = options.ownerCoachId || OWNER
  const datasetId = options.datasetId || DATASET
  if (!options.freshDevice) {
    // 默认就是「已经切到云端主数据」的那台机器（阶段 2 的主战场）。
    store.coachDataSourceMode = 'cloud-primary'
    store.coachCloudCutoverState = { status: 'cloud-primary' }
  }
  // freshDevice：全新手机 —— coachDataSourceMode / cutover / coachCloudActiveCache / coachDB 一个都不存在。
  // 这正是"全新 coach 第一次装好小程序打开"的起点，也是"老账号清缓存/重装后回来"的起点。
  const counters = { toasts: [], modals: [], loading: 0, hides: 0, navigations: [], back: 0, calls: [], cloudCalls: [], readActive: 0, receipts: 0 }
  const latencyTimers = []
  // 云函数路由：默认什么都不认（既有测试不依赖它）。首次开通的测试往这里挂真正的实现
  // （真实 initMyCoachSpace service + 假 db），于是"服务端语义"不需要再被手写模拟一遍。
  const cloudFunctions = { ...(options.cloudFunctions || {}) }

  const engine = new InMemoryCommandEngine({ now: () => Date.now(), idFactory: kind => `${kind}_srv${++engine.sequence}` })

  const world = {
    store, counters, engine,
    online: true,
    // ★ 与真实 adapter 同口径：expectedRevision 取自**进程内存态**，而不是"引擎当前值"。
    //   真件里这份内存态只有一次成功的 readActive（或一次成功的命令）才会被填上，
    //   杀进程重开后它是空的 —— 那时 execute 在 **callCloud 之前**就返回 REVISION_UNKNOWN，
    //   命令根本没有出网。之前的假件直接用 world.revision()（永远有值），
    //   把「冷启动后队列里的命令发不出去」这条真机故障整个抹掉了（第 36 节的教训：假件只能更严）。
    memoryRevision: null,
    latency: 0,
    failRefresh: 0,
    throwNetwork: false,
    dropResponse: 0,
    lostReceipt: false,
    coordinatorOffline: !!options.coordinatorOffline,
    // 只有显式开了这个开关的世界才允许走运行期命令通道（云端先行那 9 条）。
    allowMaskedCommands: !!options.allowMaskedCommands,
    cloudFunctions,
    bindings: {},
    commandsSeen: [],
    // 让"云端慢 5 秒"这类场景可以被取消，避免测试被挂起的定时器拖住。
    cancelLatency() { while (latencyTimers.length) clearTimeout(latencyTimers.pop()) },
    revision: () => Number(engine.read(owner).dataRevision || 0),
    seed(state) { engine.seed(owner, state); world.writeCache() },
    // 只写"云端"（引擎），**不动本机 Storage** —— 「清缓存 / 重装后回来」的构造需要它：
    // 云端那份数据还在，而这台手机上什么缓存都没有。
    seedCloud(state) { engine.seed(owner, state); return world.revision() },
    snapshot() { const state = engine.read(owner); delete state.dataRevision; return state },
    writeCache() {
      const state = engine.read(owner)
      store.coachCloudActiveCache = { environment: 'production', datasetId, revision: Number(state.dataRevision || 0), checksum: `chk${state.dataRevision}`, updatedAt: Date.now(), snapshot: { students: state.students, bookings: state.bookings, incomes: state.incomes, sales: state.sales, settings: state.settings, customExercises: state.customExercises } }
    },
    // 只读：不触发任何命令。用于断言"本机看到的到底是什么"。
    localDB() {
      const runtime = require(path.join(PROJ, 'utils', 'data-runtime'))
      return runtime.getDB()
    },
    outboxEntries() {
      const outbox = require(path.join(PROJ, 'utils', 'local-outbox'))
      return outbox.list({ environment: 'production', datasetId })
    }
  }

  // ---------------------------------------------------------------- 假 wx
  global.wx = {
    getStorageSync: key => copy(store[key]),
    setStorageSync: (key, value) => { store[key] = copy(value) },
    removeStorageSync: key => { delete store[key] },
    showToast: opts => counters.toasts.push(opts),
    showModal: opts => { counters.modals.push(opts); if (opts && opts.success) opts.success({ confirm: true }) },
    showLoading: opts => { counters.loading += 1; counters.lastLoading = opts },
    hideLoading: () => { counters.hides += 1 },
    showTabBar() {}, hideTabBar() {},
    // 剪贴板桩必须复现**真实平台**的回调形状：wx.setClipboardData 一定会回调
    // success 或 fail。不给任何回调的桩会让「这次复制到底成没成」永远没有答案，
    // 而 1.1.9 起 UI 的成功判据就建立在它上面 —— 那种桩会让契约缺陷在测试里永远绿。
    setClipboardData: options => { if (options && options.success) options.success({}) },
    nextTick: task => setTimeout(task, 0),
    navigateTo: opts => counters.navigations.push(opts),
    navigateBack: () => { counters.back += 1 },
    createSelectorQuery: () => ({ selectAll: () => ({ boundingClientRect: () => ({ exec() {} }) }), select: () => ({ boundingClientRect: () => ({ exec() {} }) }) }),
    getNetworkType: opts => opts.success({ networkType: 'wifi' }),
    onNetworkStatusChange() {},
    cloud: {
      callFunction: opts => {
        const name = opts && opts.name
        counters.cloudCalls.push({ name, data: copy(opts && opts.data) })
        const handler = cloudFunctions[name]
        if (typeof handler !== 'function') return Promise.resolve({ result: { ok: false, code: 'NOT_USED' } })
        // 与真 wx.cloud.callFunction 逐字同口径：**成功时 resolve `{ result }`**，
        // 云函数抛错 / 请求失败时 **Promise reject**（首次开通的"断网 / 超时"场景正是构造在这里的）。
        try { return Promise.resolve(handler(copy(opts && opts.data))).then(result => ({ result })) }
        catch (error) { return Promise.reject(error) }
      }
    }
  }

  // ---------------------------------------------------------------- 假 adapter（真实语义：receipt / 幂等 / 回读）
  const latency = () => new Promise(resolve => { if (!world.latency) return resolve(); const timer = setTimeout(resolve, world.latency); latencyTimers.push(timer) })
  const adapter = {
    COMMANDS: null,
    getState: () => ({ datasetId, revision: world.memoryRevision }),
    resetState() {},
    async readActive() {
      counters.readActive += 1
      if (!world.online) return { ok: false, code: 'OFFLINE_CACHE_MISSING' }
      await latency()
      if (world.failRefresh > 0) { world.failRefresh -= 1; return { ok: false, code: 'ACTIVE_READ_INTEGRITY_FAILED' } }
      world.writeCache()
      const state = engine.read(owner)
      // 一次成功的完整回读 = 本机拿到了 revision（真件在 setState 里做这件事）。
      world.memoryRevision = Number(state.dataRevision || 0)
      return { ok: true, environment: 'production', datasetId, revision: Number(state.dataRevision || 0), checksum: `chk${state.dataRevision}`, snapshot: world.snapshot() }
    },
    async execute(command, payload, opts = {}) {
      const requestId = opts.requestId
      if (!world.online) return { ok: false, code: 'OFFLINE_READ_ONLY' }
      // ★ 冷启动 / 杀进程重开后的内存态是空的 → 命令在**出网前**就被拒。
      //   注意这里在 counters.calls / commandsSeen 之前返回：云端这一次**真的什么都没收到**，
      //   所以"未出网"是可断言的（真机的失败档案里也是这个形状）。
      if (!Number.isInteger(world.memoryRevision)) return { ok: false, code: 'REVISION_UNKNOWN' }
      counters.calls.push({ command, payload: copy(payload), requestId })
      world.commandsSeen.push(command)
      await latency()
      // 网络中断：真实 adapter 会先查回执 —— 命中 succeeded 就当成功，查不到才返回"结果未知"。
      // （这条路径专治"盲目重发"：号不变就绝不会变成两条业务。）
      let response = null
      if (world.throwNetwork) {
        const receipt = world.lostReceipt ? null : engine.receiptFor(owner, requestId)
        if (receipt && receipt.status === 'succeeded') response = { ...copy(receipt.response), recoveredFromReceipt: true }
        else return { ok: false, code: 'COMMAND_RESULT_UNKNOWN', requestId, retrySafe: true }
      } else {
        response = engine.execute({ ownerCoachId: owner }, { command, requestId, expectedRevision: world.revision(), payload: copy(payload) })
        if (response && response.ok && world.dropResponse > 0) {
          world.dropResponse -= 1
          return { ok: false, code: 'COMMAND_RESULT_UNKNOWN', requestId, retrySafe: true }
        }
      }
      if (!response || !response.ok) return response || { ok: false, code: 'COMMAND_FAILED' }
      // 命令一落地就把新 revision 写回**内存态**（真件 `execute` 的 setState 做这件事）。
      world.memoryRevision = Number(response.revision == null ? world.revision() : response.revision)
      let refreshed
      try { refreshed = await adapter.readActive() } catch (error) { refreshed = { ok: false, code: 'REFRESH_THREW' } }
      return { ...response, datasetRevision: Number(response.revision == null ? world.revision() : response.revision), refreshed }
    },
    async getReceipt(requestId) {
      counters.receipts += 1
      const receipt = engine.receiptFor(owner, requestId)
      if (!receipt) return { ok: true, found: false }
      return { ok: true, found: true, status: receipt.status, response: copy(receipt.response) }
    }
  }
  world.adapter = adapter

  // 运行期命令通道的替身（只在 allowMaskedCommands 的世界里生效）。语义与真实
  // utils/ui-cloud-command.js 的 runCommandSilent 对齐：离线即拒、按 key 单航班且 requestId 稳定、
  // revision 缺失先补一次回读、成功后回调、失败原样返回（绝不吞掉错误码）。
  const maskedPending = new Map()
  world.runMasked = async (input = {}) => {
    const pendingKey = input.key || input.command || ''
    if (!world.online) return { ok: false, code: 'OFFLINE_READ_ONLY' }
    if (input.requestId && maskedPending.has(pendingKey) && maskedPending.get(pendingKey) !== input.requestId) return { ok: false, code: 'REQUEST_PENDING_CONFIRMATION', requestId: maskedPending.get(pendingKey) }
    if (input.requestId && !maskedPending.has(pendingKey)) maskedPending.set(pendingKey, input.requestId)
    const fixedRequestId = input.requestId || operationIdFor(pendingKey)
    let result = null
    try {
      if (!Number.isInteger(world.memoryRevision)) { const active = await adapter.readActive(); if (!active.ok) result = active }
      if (!result) result = await adapter.execute(input.command, input.payload, { requestId: fixedRequestId })
    } catch (error) { result = { ok: false, code: 'COMMAND_RESULT_UNKNOWN', requestId: fixedRequestId } }
    if (result.ok) { maskedPending.delete(pendingKey); if (input.onSuccess) await input.onSuccess(result); return result }
    if (result.code === 'REVISION_CONFLICT') { await adapter.readActive(); maskedPending.delete(pendingKey); if (input.onRefresh) await input.onRefresh(); return result }
    if (result.code === 'COMMAND_RESULT_UNKNOWN' || result.code === 'REQUEST_PROCESSING') return result
    maskedPending.delete(pendingKey)
    return result
  }
  ACTIVE = world
  injectUi()

  // ---------------------------------------------------------------- 进程重启：只保留 Storage（模拟杀掉小程序再打开）
  // cloud-bootstrap 也在名单里：它的单航班 `running` 与已记录的开通状态都是**进程内存态**，
  // 杀进程重开后必须一并消失，否则"重开后再跑一轮"会被上一进程的残影挡住。
  const volatile = ['mutate', 'sync-engine', 'local-outbox', 'local-projection', 'local-transaction', 'data-runtime', 'exercise-picker', 'session', 'cloud-bootstrap']
  function restartProcess() {
    Object.keys(require.cache).forEach(key => {
      if (key.indexOf(PROJ) !== 0) return
      const base = path.basename(key, '.js')
      if (volatile.includes(base) || /[\\/](pages|components)[\\/]/.test(key)) delete require.cache[key]
    })
    // 杀进程重开：Storage 留着，**进程内存态（含 adapter 的 revision）全部丢失**。
    // 这正是真机上"冷启动后第一轮同步"的起点，必须被真实地模拟出来。
    world.memoryRevision = null
    injectUi()
  }

  world.restartProcess = restartProcess
  // 恢复网络：走 app.js 真实走的那个入口（resume = 解除退避 + 补发），
  // 而不是测试自己绕过退避去 flush —— 否则"恢复网络后要干等十几秒"这个真问题会被测试掩盖。
  //
  // ⚠️⚠️ 绝不可以把 resume() 的返回值直接 await 出去。
  //   `sync-engine.resume()` 最后返回的是 `flush()`，而 flush 是**单航班**：只要上一轮还在跑，
  //   它就把那一轮的 promise 原样交回。而某些场景（例如「课包/销售卡在云端」）会故意让一条命令
  //   **永远不返回**，那一轮 `running` 就永远不释放。
  //   于是 `await world.restoreNetwork()` 会挂在一个永不 settle 的 promise 上；
  //   又因为 await pending promise 只排微任务、不让出定时器阶段，整个进程会被**饿死**。
  //   真实现象极其隐蔽：退出码 0、一个字都不输出、连最后的 PASS 行都不打印，
  //   runner 用 /pass/i 判分于是判成 FAILED，看上去像"业务挂了"，其实是测试脚手架自己卡住了。
  //
  //   正确处理：把网络状态**同步**改好（这才是本函数真正的契约），然后"踢一脚"同步引擎
  //   （resume 已经调用、退避也已解除），但**不等待**那一轮 —— 等活儿干完是 drain() 的职责，
  //   drain() 每一轮都先用真定时器把事件循环让出去，所以它不会被同一个卡死的 promise 饿死。
  world.restoreNetwork = () => {
    world.throwNetwork = false
    world.lostReceipt = false
    world.dropResponse = 0
    world.online = true
    try { require(path.join(PROJ, 'utils', 'sync-engine')).resume() } catch (error) {}
    return world
  }
  world.restoreUi = restoreUi
  world.settle = settle
  world.delay = delay
  // 「清本地缓存 / 重装」：把本机 Storage 抹干净（**云端那份不动**），
  // 进程内存态也一并丢掉 —— 与真实"卸载重装后再打开"逐字同形。
  world.wipeLocalStorage = () => {
    Object.keys(store).forEach(key => delete store[key])
    require(path.join(PROJ, 'utils', 'local-projection')).invalidate()
    world.memoryRevision = null
    return world
  }
  return world
}

// 加载真实的 exercise-picker 组件（用全局 Component 捕获）。
function loadExercisePicker() {
  const file = path.join(PROJ, 'components', 'exercise-picker', 'exercise-picker.js')
  let captured = null
  global.Component = definition => { captured = definition }
  delete require.cache[require.resolve(file)]
  require(file)
  delete global.Component
  if (!captured) throw new Error('exercise-picker 组件没有被注册。')
  const instance = {
    data: copy(captured.data), properties: {},
    setData(patch, callback) { Object.assign(this.data, copy(patch)); if (callback) callback() },
    triggerEvent(name, detail) { (this.events[name] = this.events[name] || []).push(copy(detail)) },
    events: {},
    methods: {}
  }
  Object.assign(instance, captured.methods)
  Object.keys(captured.methods).forEach(name => { if (typeof captured.methods[name] === 'function') instance[name] = captured.methods[name].bind(instance) })
  return instance
}

// 加载真实的 session 页面（用全局 Page 捕获）。
function loadSessionPage() {
  const file = path.join(PROJ, 'pages', 'session', 'session.js')
  let captured = null
  global.Page = definition => { captured = definition }
  delete require.cache[require.resolve(file)]
  require(file)
  delete global.Page
  if (!captured) throw new Error('session 页面没有被注册。')
  const instance = {
    data: copy(captured.data), properties: {}, events: {},
    // onLoad 才会创建草稿协调器；这里给一个语义等价的替身，让页面实例可以直接被驱动。
    drafts: { markDirty() {}, save(task) { return Promise.resolve(task()) }, flush(task) { return Promise.resolve(task()) }, reset() {} },
    draftTimer: null, returned: false,
    setData(patch, callback) { Object.assign(this.data, copy(patch)); if (callback) callback() },
    triggerEvent(name, detail) { (this.events[name] = this.events[name] || []).push(copy(detail)) },
    noop() {}
  }
  Object.keys(captured).forEach(key => { if (typeof captured[key] === 'function' && key !== 'data') instance[key] = captured[key].bind(instance) })
  return instance
}

module.exports = { createWorld, loadExercisePicker, loadSessionPage, settle, delay, copy, OWNER, DATASET, PROJ }
