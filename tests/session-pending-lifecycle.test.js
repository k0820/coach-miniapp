// 「刚约完一次点击就能稳定进入课程详情」的真机生命周期永久回归（第 33 节）。
//
// 为什么必须单独有这个文件：
//   既有测试把「导航」这一环整个跳过了 —— 它们断言课表生成的 url 里带 encodeURIComponent 后的业务键，
//   然后直接拿**原始业务键**去调 session 的 onLoad。真机上这两者之间还隔着微信的路径参数编码：
//   官方文档明确写着 onLoad 拿到的 options 是**编码形式**、需要接收方自己 decodeURIComponent。
//   于是「把编码后的字符串当业务键用」这个 bug 在自动测试里永远照不出来：
//   本机待确认记录查不到（键是 %7C 版）→ 页面判定「这条预约不存在」→ 立刻 navigateBack。
//   真机表现就是「看起来进了课程页但自动弹回课表，点几次都一样，云端转正后才正常」。
//
// 本文件补上这一环：一律从 navigateTo 产出的**真实 url** 里按微信口径解析参数，再交给 onLoad。
// 加载的都是真实现（协调器 / 四个本机存储 / 两个页面），只把「云」与「adapter」换成可注入的假件。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
// setData 假件必须与真实微信同口径：支持路径更新（课表刷新只推真的变了的格子）。
const { applyPatch } = require('./helpers/set-data')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const flush = async (rounds = 8) => { for (let i = 0; i < rounds; i++) await delay(1) }
// 让后台那条 create 链彻底跑完（execute 有 executeDelay，之后还有完整回读与写 cache）。
const settleCloud = async (rounds = 16) => { await delay(world.executeDelay + 20); await flush(rounds) }
// 条件等待：等到某个**确定性条件**成立为止。
// ⚠️ 绝不许用"再加几轮 flush"来替代它 —— 固定轮次会随机器快慢随机翻面：
//    场景 ⑲ 就是这么翻过一次（同一份代码，多几行同步 console.log 就绿、少了就红）。
//    要等的是"这条命令到底有没有定论"，那是一个可断言的事实，不是一个时间长度。
const until = async (predicate, label, ms = 4000) => {
  const started = Date.now()
  for (;;) {
    if (predicate()) return true
    if (Date.now() - started > ms) throw new Error(`等待超时：${label}`)
    await delay(5)
  }
}
// createBooking 的闸门：把它按住，就能确定性地复现「块已经画出来、云端还没转正」的那段窗口，
// 而不是靠 sleep 猜时间（靠猜的话，断言会随机器快慢随机翻面）。
let gateResolve = null
let createGate = new Promise(resolve => { gateResolve = resolve })
// 重新架一道闸门（第 ⑭⑮ 场景要用同样的手法按住 create —— 一条 Promise 只能放行一次）。
const rearmCreateGate = () => { createGate = new Promise(resolve => { gateResolve = resolve }) }
const releaseCreate = () => { if (gateResolve) { gateResolve(); gateResolve = null } }
// completeBooking 的闸门：用来确定性复现「用户已经点下课、云端事务还在跑」的那段窗口。
// 第 35 节的两个真机问题都只出现在这段窗口里，靠 sleep 猜时间会让断言随机器快慢翻面。
let completeResolve = null
let completeGate = new Promise(resolve => { completeResolve = resolve })
const rearmCompleteGate = () => { completeGate = new Promise(resolve => { completeResolve = resolve }) }
const releaseComplete = () => { if (completeResolve) { completeResolve(); completeResolve = null } }

// ---------------------------------------------------------------- 假 wx
const counters = { loading: 0, toasts: [], modals: [], navigations: [], back: 0 }
const storage = { datasetId: 'ds-sandbox' }
global.wx = {
  getStorageSync: key => copy(storage[key]),
  setStorageSync: (key, value) => { storage[key] = copy(value) },
  showToast: options => counters.toasts.push(options),
  showModal: options => counters.modals.push(options),
  showLoading: options => { counters.loading++ },
  hideLoading() {},
  showTabBar() {},
  nextTick: task => setTimeout(task, 0),
  navigateTo: options => counters.navigations.push(options),
  navigateBack() { counters.back++ },
  cloud: { callFunction: () => Promise.resolve({ result: { ok: false, code: 'NOT_USED' } }) },
  createSelectorQuery: () => ({ selectAll: () => ({ boundingClientRect: () => ({ exec() {} }) }) })
}

// 微信口径解析路径参数：onLoad(options) 里的值就是 url 里写的**原文**（未解码）。
// 官方文档：this.options 中的路径参数需要 decodeURIComponent。
// 这里刻意**不**替它解码 —— 一旦在这里解码，就等于把真机的真实行为抹平，测试又会变成假通过。
function wechatOptions(url) {
  const query = String(url).split('?')[1] || ''
  const options = {}
  for (const pair of query.split('&')) {
    if (!pair) continue
    const index = pair.indexOf('=')
    if (index === -1) options[pair] = ''
    else options[pair.slice(0, index)] = pair.slice(index + 1)
  }
  return options
}

// ---------------------------------------------------------------- 假云（服务端真相）
const world = {
  datasetId: 'ds-sandbox', revision: 1, online: true,
  refreshOk: true, failRefreshFor: null, throwNetwork: false, suspendResume: true, executeDelay: 10,
  holdCreate: false, failContentOnce: false,
  // 第 35 节新增：完课窗口的三个可控故障注入。
  holdComplete: false,        // 按住 completeBooking，复现「已点下课、云端还在跑」的窗口
  failDirectRead: false,      // 直接调 readActive 也失败（用来留住「已成功但还没同步」的本机意图）
  failCompleteOnce: null,     // 让 completeBooking 明确失败一次（注入错误码）
  loseResponseFor: null,      // 命令在云端真的执行了、回执也在，但客户端丢了响应（timeout/unknown 的真实形态）
  // 课时包容量：本文件是「完课/意图/同步生命周期」的测试，**不是"课时耗尽"的测试** ——
  // 场景 ⑧⑭⑮⑯⑰⑱⑲ 各要扣 1 节，容量必须够跑完，否则后面的场景会因为"包用完了"而红，
  // 失败信息却指向完课链路（误导）。「课时不足必须拒绝」由各自的专项测试 + 服务端兜底覆盖。
  students: [{ id: 'stu-1', name: '假学员', packages: [{ id: 'pkg-1', type: '常规训练', price: 100, used: 0, remaining: 12 }] }],
  bookings: [], incomes: [], customExercises: [],
  receipts: new Map(), executedCommands: [], requestLog: [], contentPayloads: [],
  counts: { execute: 0, readActive: 0, getReceipt: 0, create: 0, content: 0, complete: 0, cancel: 0 }
}
const findPkg = id => world.students[0].packages.find(item => item.id === id)
const cloudSnapshot = () => ({ students: copy(world.students), bookings: copy(world.bookings), incomes: copy(world.incomes), customExercises: copy(world.customExercises) })

// 客户端 active cache 是**独立的一份**（就放在 storage 里，和真机一致）：
// 只有 readActive 成功时才刷新。绝不能让它直接读 world —— 否则「stale cache 不能把页面弹回去」
// 这类断言就变成了假断言（每次写完缓存都已经是最新的）。
const cacheKey = () => 'coachSandboxActiveCache'
// ⚠️ 与真机**逐字段同口径**（cloud-primary-adapter.js:69）：
//    { environment, datasetId, revision, checksum, byteSize, updatedAt, snapshot }
//    · 缺 environment → mutate.coachScope() 判「环境不符」，本机先行**静默整段失效**，
//      症状却表现为"内容被当成正式内容提交了"，把人指到完全错误的方向；
//    · 快照必须在 cache.snapshot 下（不是摊平在顶层）→ 否则 coachScope() 找不到 snapshot，
//      同样静默降级；data-runtime.getDB() 也要求 cache.snapshot + 整数 revision。
//    假件的形状必须**与真件逐字段一致** —— 宁可更严，不可更松，更不能更残缺。
const CACHE_ENVIRONMENT = 'sandbox'
const writeCache = () => {
  storage[cacheKey()] = {
    environment: CACHE_ENVIRONMENT, datasetId: world.datasetId, revision: world.revision,
    checksum: 'x', byteSize: 1, updatedAt: Date.now(), snapshot: cloudSnapshot()
  }
}
writeCache()
// 「正式 cache 的字节」= cache.snapshot（与 data-runtime.getDB() 取的同一层）。
// 断言必须打在这一层：本机先行下页面读的是**投影**，而这里要看的是**没被本机改过的原始快照**。
const cacheDB = () => storage[cacheKey()].snapshot
// 与真机 data-runtime.getDB() **逐字同口径**（data-runtime.js:21-36）：
//   云端已确认的快照 + 本机投影（Outbox 里还没同步到云端、但本机已经算完的意图）。
// 页面读到的必须是**投影** —— 否则「点下课第一帧回课表就是已完」这类阶段 2 的核心行为
// 在测试里根本观察不到：那条意图已经交棒给持久队列了，撑住视觉的只剩投影。
// 反过来，「正式 cache 有没有被本机改过」必须用 cacheDB() 看**原始字节**，两者绝不能混。
const projectedDB = () => {
  const cache = storage[cacheKey()]
  const snapshot = copy(cache.snapshot)
  try {
    const projected = require('../utils/local-projection').project(snapshot, { environment: CACHE_ENVIRONMENT, datasetId: cache.datasetId }, cache.revision)
    if (projected) return copy(projected)
  } catch (error) {}
  return snapshot
}

function applyCommand(command, payload) {
  world.executedCommands.push(command)
  if (command === 'createBooking') {
    world.counts.create++
    const id = `booking-${world.counts.create}`
    const pkg = findPkg(payload.packageId)
    world.bookings.push({ id, studentId: payload.studentId, studentName: '假学员', packageId: payload.packageId, date: payload.date, hour: payload.hour, minute: payload.minute || 0, typeName: pkg ? pkg.type : '常规训练', price: 100, status: 'booked', items: [], notes: '' })
    world.revision++
    return { ok: true, command, datasetRevision: world.revision, result: { bookingId: id } }
  }
  if (command === 'updateBookingContent') {
    world.counts.content++
    world.contentPayloads.push(copy(payload))
    if (world.failContentOnce) { world.failContentOnce = false; return { ok: false, code: 'BOOKING_NOT_FOUND', message: '训练内容没有成功保存。' } }
    // 与真实服务端同口径：bookingId 必须是非空字符串，否则直接判 INVALID_PAYLOAD。
    // （真机根因就是这里收到了空 bookingId —— 草稿里残留的 bookingId:'' 把正式 id 覆盖掉了。）
    if (typeof payload.bookingId !== 'string' || !payload.bookingId.trim()) return { ok: false, code: 'INVALID_PAYLOAD', message: 'bookingId不能为空。' }
    const booking = world.bookings.find(item => item.id === payload.bookingId)
    if (!booking) return { ok: false, code: 'BOOKING_NOT_FOUND' }
    if (payload.items) booking.items = copy(payload.items)
    if (payload.notes != null) booking.notes = String(payload.notes)
    if (payload.category) booking.category = payload.category
    if (payload.duration) booking.duration = payload.duration
    world.revision++
    return { ok: true, command, datasetRevision: world.revision }
  }
  if (command === 'completeBooking') {
    world.counts.complete++
    // 明确失败（不是未知）：服务端确实拒绝了这次完课 —— 用来验证「撤回本机意图 + 提示 + 恢复可完课状态」。
    if (world.failCompleteOnce) { const code = world.failCompleteOnce; world.failCompleteOnce = null; return { ok: false, code, message: '云端数据已变化。' } }
    const booking = world.bookings.find(item => item.id === payload.bookingId)
    if (!booking) return { ok: false, code: 'BOOKING_NOT_FOUND' }
    // ★ 与真实服务端**逐条同口径、连顺序都一致**（cloudfunctions/.../handlers.js:427-431）：
    //   ① 课时包剩余不足 → PACKAGE_NO_REMAINING   ② 常规课没有训练动作 → TRAINING_ITEMS_REQUIRED
    //   这两条不是"测试额外加的严格"，而是安全网的**最后一环**：阶段 2 起页面不再同步等待
    //   "内容已在云端确认"，兜底就落在这里。假件比真件松 = 兜底凭空消失（第 37 节的教训）。
    //   ⚠️ 之前缺 PACKAGE_NO_REMAINING，于是「课时用完还继续完课」被假件默默放行、remaining 甚至被扣成负数 ——
    //      场景 ⑱ 正是靠这个太松的假件才一直是绿的（隐性假通过）。
    const pkg = findPkg(booking.packageId)
    const remaining = Number(pkg && pkg.remaining)
    if (!Number.isFinite(remaining) || remaining <= 0) return { ok: false, code: 'PACKAGE_NO_REMAINING', message: '预约指定的课时包剩余课时不足。' }
    const items = Array.isArray(booking.items) ? booking.items : []
    if (booking.typeName !== '拉伸恢复' && !items.length) return { ok: false, code: 'TRAINING_ITEMS_REQUIRED', message: '常规课程请先保存训练动作。' }
    if (booking.status === 'done') return { ok: true, command, datasetRevision: world.revision, alreadyDone: true }
    booking.status = 'done'
    pkg.used = Number(pkg.used || 0) + 1
    pkg.remaining = Number(pkg.remaining || 0) - 1
    world.incomes.push({ id: `income-${world.incomes.length + 1}`, bookingId: booking.id, amount: 100 })
    world.revision++
    return { ok: true, command, datasetRevision: world.revision }
  }
  if (command === 'cancelBooking') {
    world.counts.cancel++
    const index = world.bookings.findIndex(item => item.id === payload.bookingId)
    if (index === -1) return { ok: false, code: 'BOOKING_NOT_FOUND' }
    if (world.bookings[index].status === 'done') return { ok: false, code: 'BOOKING_ALREADY_DONE' }
    world.bookings.splice(index, 1)
    world.revision++
    return { ok: true, command, datasetRevision: world.revision }
  }
  return { ok: false, code: 'COMMAND_NOT_ALLOWED' }
}

// 命令成功之后的那次完整回读。
// 注意：它不受 failDirectRead 影响 —— 那个开关专门用来让「页面/协调器自己发起的重新同步」失败，
// 这样才能构造出「云端已经完成、客户端 cache 还是旧值、本机意图仍在」的真实窗口（第 ⑱ 场景）。
async function refreshCache() {
  world.counts.readActive++
  if (!world.refreshOk) return { ok: false, code: 'ACTIVE_READ_INTEGRITY_FAILED' }
  writeCache()
  return { ok: true, datasetId: world.datasetId, revision: world.revision }
}

const adapter = {
  getState: () => ({ datasetId: world.datasetId, revision: world.revision }),
  resetState() {},
  async readActive() {
    world.counts.readActive++
    if (!world.refreshOk || world.failDirectRead) return { ok: false, code: 'ACTIVE_READ_INTEGRITY_FAILED' }
    writeCache()
    return { ok: true, datasetId: world.datasetId, revision: world.revision }
  },
  // 与真实 adapter.execute 语义一致：成功后无条件跑完整 readActive；失败先查 receipt；同 requestId 幂等。
  async execute(command, payload, options = {}) {
    world.counts.execute++
    const requestId = options.requestId
    world.requestLog.push({ command, requestId })
    if (world.holdCreate && command === 'createBooking') await createGate
    if (world.holdComplete && command === 'completeBooking') await completeGate
    if (world.executeDelay) await delay(world.executeDelay)
    if (world.throwNetwork) {
      const receipt = await adapter.getReceipt(requestId)
      if (receipt && receipt.found && receipt.status === 'succeeded') { const refreshed = await refreshCache(); return { ...copy(receipt.response), recoveredFromReceipt: true, refreshed } }
      return { ok: false, code: 'COMMAND_RESULT_UNKNOWN', requestId }
    }
    const cached = world.receipts.get(requestId)
    const response = cached ? copy(cached.response) : applyCommand(command, payload)
    // 轨迹必须连**被拒绝的那一次**也记下来（含错误码）：只记"发过请求"的话，
    // 「云端到底拒了没有、拒在哪一条」在日志里是完全隐形的，失败现场只会指向别处。
    world.requestLog[world.requestLog.length - 1].code = response && (response.code || 'ok')
    if (response.ok && !cached) world.receipts.set(requestId, { status: 'succeeded', response: copy(response) })
    // 响应丢失：命令在云端真的跑了、回执也写下了，但客户端只看到「未知」。
    if (world.loseResponseFor === command) return { ok: false, code: 'COMMAND_RESULT_UNKNOWN', requestId }
    if (!response.ok) return response
    const failing = Array.isArray(world.failRefreshFor) ? world.failRefreshFor.includes(command) : world.failRefreshFor === command
    if (failing) return { ...response, refreshFailed: { ok: false, code: 'ACTIVE_READ_INTEGRITY_FAILED' } }
    const refreshed = await refreshCache()
    return refreshed.ok ? { ...response, refreshed } : { ...response, refreshFailed: refreshed }
  },
  async getReceipt(requestId) {
    world.counts.getReceipt++
    const receipt = world.receipts.get(requestId)
    if (receipt) return { ok: true, found: true, status: receipt.status, response: copy(receipt.response) }
    return { ok: true, found: false }
  }
}

// ---------------------------------------------------------------- 真 runtime / 真协调器
let currentEnvironment = 'sandbox'
const runtime = {
  environment: () => currentEnvironment,
  setEnvironment: value => { currentEnvironment = value },
  cacheKey,
  cutoverState: () => ({ status: 'cloud-primary' }),
  MODES: { LOCAL: 'local-primary', ACTIVATING: 'activating', PENDING: 'cutover-pending', CLOUD: 'cloud-primary' },
  getDB: projectedDB,
  writesFrozen: () => true,
  mode: () => 'cloud-primary'
}
const pendingBookings = require('../utils/pending-booking-request')
const pendingCancellations = require('../utils/pending-cancellation')
const pendingCompletion = require('../utils/pending-completion')
const pendingDraft = require('../utils/pending-training-draft')
const { createBookingOptimistic } = require('../utils/booking-optimistic')

let requestSeq = 0
const coordinator = createBookingOptimistic({
  runtime, pending: pendingBookings, cancellation: pendingCancellations, completion: pendingCompletion, adapter,
  isOnline: () => world.online,
  newRequestId: () => `req-${++requestSeq}`,
  readDatasetId: () => { const c = wx.getStorageSync(cacheKey()); return c && c.datasetId ? c.datasetId : '' },
  readSnapshot: () => { try { return runtime.getDB() } catch (error) { return null } },
  onCancelled: (localKey, officialId) => {
    pendingDraft.remove(currentEnvironment, world.datasetId, `pending:${localKey}`)
    if (officialId) pendingDraft.remove(currentEnvironment, world.datasetId, officialId)
  },
  showToast: options => counters.toasts.push(options),
  showModal: options => counters.modals.push(options)
})

const commandPending = new Map()
let opSeq = 0
const operationId = key => { if (!commandPending.has(key)) commandPending.set(key, `op-${++opSeq}-${key}`); return commandPending.get(key) }
const clearPending = (key, requestId) => { if (commandPending.get(key) === requestId) commandPending.delete(key) }
async function runCommandSilent({ key, command, payload, requestId, onSuccess }) {
  if (!world.online) return { ok: false, code: 'OFFLINE_READ_ONLY' }
  if (!Number.isInteger(adapter.getState().revision)) return { ok: false, code: 'REVISION_UNKNOWN' }
  const fixed = requestId || operationId(key)
  const result = await adapter.execute(command, payload, { requestId: fixed })
  if (result.ok) { commandPending.delete(key); if (onSuccess) await onSuccess(result) }
  return result
}
async function runCommand(options) { counters.loading++; return runCommandSilent(options) }

const runtimePath = require.resolve('../utils/data-runtime')
const commandPath = require.resolve('../utils/ui-cloud-command')
const oldRuntime = require.cache[runtimePath], oldCommand = require.cache[commandPath]
require.cache[runtimePath] = {
  id: runtimePath, filename: runtimePath, loaded: true,
  exports: {
    ...require('../utils/db'),
    getDB: projectedDB, saveDB: () => { throw new Error('CLOUD_PRIMARY_DIRECT_WRITE_BLOCKED') },
    uid: () => `local-${++opSeq}`, timeStr: booking => `${booking.hour}:00`,
    cacheKey, environment: () => currentEnvironment,
    writesFrozen: () => true, mode: () => 'cloud-primary', cutoverState: () => runtime.cutoverState(),
    MODES: runtime.MODES, ENVIRONMENTS: { PRODUCTION: 'production', SANDBOX: 'sandbox' }, setEnvironment: runtime.setEnvironment
  }
}
require.cache[commandPath] = {
  id: commandPath, filename: commandPath, loaded: true,
  exports: {
    adapter, isCloudPrimary: () => true, runCommand, runCommandSilent, operationId, clearPending,
    // ★ 阶段 2：替身必须与真模块**同面**（缺一个成员就是"本机先行悄悄失效"）。
    //   本机先行命令进的是持久 Outbox，由同步引擎送云；同步引擎的第一道门就是 isCloudWritable()。
    //   这个测试本来就有 world.online 开关 —— 正好用它，让「断网/恢复」的语义与真机一致。
    isCloudWritable: () => !!world.online, setOnline: value => { world.online = !!value },
    submitBooking: input => coordinator.submit(input),
    resumePendingBookings: () => world.suspendResume ? Promise.resolve({ ok: true, skipped: true }) : coordinator.resume(),
    pendingBookingRecords: () => coordinator.records(),
    mergePendingBookings: bookings => coordinator.mergeBookings(bookings),
    subscribePendingBookings: listener => coordinator.subscribe(listener),
    notifyPendingBookings: () => coordinator.notifyView(),
    officialIdForBooking: key => coordinator.officialIdFor(key),
    awaitOfficialBooking: (key, timeout) => coordinator.awaitOfficial(key, timeout),
    retryPendingBooking: key => coordinator.retry(key),
    cancelBookingRequest: input => coordinator.cancel(input),
    pendingCancellationRecords: () => coordinator.cancelRecords(),
    bindingForOfficialId: officialId => pendingBookings.bindingForOfficialId(currentEnvironment, world.datasetId, officialId),
    // 与真实 ui-cloud-command 同一份匹配逻辑（pendingCompletion.intentFor）：都在真模块里，不在 mock 里重写。
    completionIntentFor: input => pendingCompletion.intentFor(currentEnvironment, world.datasetId, input && input.officialId, input && input.localKey),
    bookingBindings: () => pendingBookings.listBindings(currentEnvironment, world.datasetId)
  }
}

const pages = []
global.Page = config => { pages.push(config) }
require('../pages/session/session')
require('../pages/schedule/schedule')
const sessionConfig = pages[0], scheduleConfig = pages[1]

function mount(config) {
  const object = { data: copy(config.data), unsubscribe: null }
  for (const [name, value] of Object.entries(config)) if (typeof value === 'function') object[name] = value.bind(object)
  object.setData = function (patch, callback) { applyPatch(this.data, patch); if (callback) callback() }
  return object
}
// 真机口径的「进课程」：只吃 navigateTo 产出的真实 url，参数照微信原文交给 onLoad。
function openSessionFromUrl(url) {
  const page = mount(sessionConfig)
  page.onLoad(wechatOptions(url))
  page.onShow()
  return page
}
const openSchedule = () => { const page = mount(scheduleConfig); page.onLoad(); page.onShow(); return page }
const cellFor = (schedule, date, hour) => { schedule.loadScheduleData(); return schedule.makeCell(date, hour, false) }
const KEY = 'stu-1|pkg-1|2026-09-16|16|0'
const inputFor = (date, hour) => ({ studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', packageIndex: 0, date, hour, minute: 0, typeName: '常规训练', price: 100, command: 'createBooking' })
const resetCounters = () => { counters.loading = 0; counters.toasts.length = 0; counters.modals.length = 0; counters.navigations.length = 0; counters.back = 0 }

const scenarios = []
const scenario = (name, fn) => scenarios.push({ name, fn })
const draftKeyOf = key => `pending:${key}`

// ============ 真机主线：确认预约 → 只点一次课程 → 进入 → 加动作 → 转正 → 仍留在原页 ============
let story = null

scenario('① 真机导航口径：一次点击 → 真实 url → 按微信口径解析 → 业务键必须还原（不得自动返回）', async () => {
  resetCounters()
  world.holdCreate = true                // 按住 createBooking：整段 pending 窗口完全可控
  const submitted = await coordinator.submit(inputFor('2026-09-16', 16))
  assert.equal(submitted.ok, true)
  const schedule = openSchedule()
  const cell = cellFor(schedule, '2026-09-16', 16)
  assert.equal(cell.bookings.length, 1, '约课秒回：课表第一帧就有这块')
  assert.equal(cacheDB().bookings.length, 0, '此时客户端 cache 里还没有正式 booking（stale cache 前置条件）')
  // 只点一次
  schedule.booking({ currentTarget: { dataset: { id: cell.bookings[0].id, pending: KEY } } })
  assert.equal(counters.navigations.length, 1, '一次点击只允许一次 navigateTo')
  const raw = wechatOptions(counters.navigations[0].url)
  assert.equal(raw.id, undefined, '本机编辑态不得带 bookingId')
  assert.notEqual(raw.pending, KEY, '真机送达的就是编码形式；若这里相等，说明测试没走 URL 编码这一环（假通过）')
  // 旧写法（直接把编码后的路径参数当业务键）在这一刻什么都查不到 —— 这正是真机「自动返回课表」的机制。
  // 这条断言是这次 bug 的机理钉子：修好之后它依然必须成立，否则说明又有人把它当业务键用了。
  assert.equal(coordinator.records().some(item => item.pendingKey === raw.pending), false, '编码键查不到本机待确认记录（旧写法的失败机理）')
  assert.equal(coordinator.records().some(item => item.pendingKey === KEY), true, '真实业务键必须查得到')
  const page = openSessionFromUrl(counters.navigations[0].url)
  assert.equal(page.pendingKey, KEY, 'onLoad 必须把路径参数解码回真实业务键')
  assert.equal(page.localId, `pending:${KEY}`, '本机编辑态身份必须是真实业务键')
  assert.equal(counters.back, 0, '⚠️ 刚约完点一次就必须停住，绝不能自动返回课表')
  story = { page, schedule }
})

scenario('② 进入时 cache 里没有正式 booking：页面必须停在本机编辑态（零正式命令、零遮罩）', async () => {
  await delay(6)                          // 让后台那条 createBooking 真正发出去（仍被闸门按在路上）
  assert.equal(counters.back, 0, '仍然不许返回')
  assert.equal(story.page.id, '', '未转正时不允许有 bookingId')
  assert.equal(story.page.data.pendingBooking, true, '页面必须知道自己在本机编辑态')
  assert.equal(story.page.data.done, false)
  assert.equal(world.counts.execute, 1, '此刻只有那一次 createBooking 在路上，页面本身不发任何正式命令')
  assert.equal(world.counts.create, 0, '云端此刻还没落库')
  assert.equal(world.bookings.length, 0, '云端此刻还没有这条预约（典型的真机开局）')
  assert.equal(counters.loading, 0, '不允许出现等待遮罩')
})

scenario('③ 进入后立刻连加 3 个动作：第一帧全部在列、零 Cloud、草稿挂在真实业务键上', async () => {
  const before = world.counts.execute
  for (const name of ['高位下拉', '坐姿划船', '杠铃卧推']) story.page.addExercise({ detail: { name, group: '背部' } })
  story.page.itemInput({ currentTarget: { dataset: { i: 1, k: 'weight' } }, detail: { value: '45' } })
  assert.equal(story.page.data.items.length, 3, '三个动作必须第一帧全在列表里')
  assert.equal(story.page.data.items[1].weight, '45')
  assert.equal(world.counts.execute, before, 'pending 期间选动作不允许有任何 Cloud 命令')
  assert.equal(counters.loading, 0)
  const record = pendingDraft.get('sandbox', 'ds-sandbox', draftKeyOf(KEY))
  assert.ok(record, '必须已安全落本机草稿')
  assert.equal(record.content.items.length, 3, '草稿必须挂在真实业务键下（键错位就等于动作丢了）')
  assert.equal(record.content.items[1].weight, '45')
})

scenario('④ pending 期间反复 onShow：不返回、不重发 create、不出现第二条 booking', async () => {
  const before = { execute: world.counts.execute, create: world.counts.create, back: counters.back, bookings: world.bookings.length }
  for (let i = 0; i < 3; i++) { story.page.onShow(); await flush(2) }
  assert.equal(counters.back, before.back, '反复 onShow 绝不允许把页面弹回去')
  assert.equal(world.counts.create, before.create, '反复 onShow 不得重发 createBooking')
  assert.equal(world.counts.execute, before.execute, '反复 onShow 不得产生任何新的云命令')
  assert.equal(world.bookings.length, before.bookings, '不得出现第二条 booking')
  assert.equal(story.page.data.items.length, 3, 'onShow 之后动作原样还在')
})

scenario('⑤ pending 期间 onHide / onUnload：不发云端命令、草稿不丢、不重复 flush', async () => {
  const before = world.counts.execute
  story.page.onHide()
  await flush(4)
  story.page.onUnload()
  await flush(4)
  assert.equal(world.counts.execute, before, '还没转正就离页：绝不允许把内容当成正式内容提交（否则就是 Cloud 孤儿）')
  assert.equal(pendingDraft.get('sandbox', 'ds-sandbox', draftKeyOf(KEY)).content.items.length, 3, '草稿一条不丢')
  assert.equal(story.page.data.pendingBooking, true, '这条预约仍未转正')
})

scenario('⑥ Cloud 转正 / cache 刷新：页面仍留在原页、无缝绑到正式 bookingId、动作一条不丢', async () => {
  world.holdCreate = false
  releaseCreate()                        // 放行 createBooking：从这里开始全是真实的云端回读流程
  await settleCloud()
  assert.equal(world.counts.create, 1, 'create 只允许落地一次')
  assert.equal(world.bookings.length, 1, 'booking 只有 1 条')
  const officialId = world.bookings[0].id
  const bound = pendingBookings.resolveOfficial('sandbox', 'ds-sandbox', KEY)
  assert.ok(bound && bound.officialId === officialId, '必须留下本机身份 → 正式 bookingId 的绑定')
  // 转正那一刻订阅会再调一次 load()：同一个页面实例就地接到正式 booking 上。
  story.page.load()
  assert.equal(counters.back, 0, '转正瞬间绝不允许把页面弹回课表')
  assert.equal(story.page.id, officialId, '同一个业务键必须无缝绑到正式 booking 上')
  assert.equal(story.page.data.items.length, 3, '转正过程中动作一条不能丢')
  assert.equal(pendingBookings.list('sandbox', 'ds-sandbox').length, 0, '转正后待确认记录必须清干净')
  // ★ 阶段 2：转正这一刻，队列里那份「按本机引用排队」的内容**已经**补上正式 bookingId 送到云端了
  //   —— 这正是本机先行的意义：待确认期间录的动作一条都不会丢，用户也不用在页面上干等云端。
  //   所以这里要钉的是「内容真的落到了正式 booking 上」+「本机草稿随确认清干净」，
  //   而不是旧机制下的「草稿还留在本机」—— 那份草稿已经不是内容的唯一副本了。
  assert.equal(world.bookings[0].items.length, 3, '转正前录入的动作必须已经落在正式 booking 上')
  assert.equal(pendingDraft.get('sandbox', 'ds-sandbox', draftKeyOf(KEY)), null, '内容确认落云后本机草稿必须清干净')
})

scenario('⑦ 转正后离页：训练内容恰好一次 updateBookingContent，且指向正式 bookingId（不重复 flush）', async () => {
  const officialId = world.bookings[0].id
  story.page.addExercise({ detail: { name: '面拉', group: '肩' } })
  const mark = world.executedCommands.length
  // 计数器是**全局**的：阶段 2 之后，前面各场景里"按本机引用排队"的内容也会真的落云，
  // 所以这里必须按**本次增量**算（与上面 executedCommands 的 mark 同一个口径），
  // 拿绝对值去比会在场景顺序变化时莫名其妙地红。
  const contentMark = world.counts.content
  story.page.onHide()
  await flush(6)
  story.page.onUnload()
  await flush(6)
  const contents = world.executedCommands.slice(mark).filter(command => command === 'updateBookingContent')
  assert.equal(contents.length, 1, 'onHide + onUnload 连在一起也只允许一次内容提交（不得重复 flush）')
  const last = world.requestLog.filter(item => item.command === 'updateBookingContent').pop()
  assert.ok(last, '必须真的走过云端通道')
  assert.equal(world.counts.content - contentMark, 1, '内容命令只允许一次')
  assert.equal(world.bookings[0].items.length, 4, '内容必须落到正式 booking 上')
  assert.equal(world.bookings[0].items.some(item => item.name === '面拉'), true)
  assert.equal(cacheKey() && cacheDB().bookings.find(item => item.id === officialId).items.length, 4, 'cache 里也应是 4 个动作')
})

scenario('⑧ 完成课程：第一帧返回、正式财务事实只由云端产生一次（1 条 booking / 扣 1 节 / 1 条 Income）', async () => {
  resetCounters()
  const officialId = world.bookings[0].id
  // 课时包状态跨场景累积（前面几节各扣 1 节），所以只能按**本次增量**算，
  // 拿绝对值去比会在场景顺序变化时莫名其妙地红。
  const usedBefore = Number(findPkg('pkg-1').used || 0)
  const remainingBefore = Number(findPkg('pkg-1').remaining || 0)
  const page = openSessionFromUrl(`/pages/session/session?id=${officialId}`)
  assert.equal(counters.back, 0)
  const handle = await page.complete()
  assert.equal(handle.deferred, true, '完课必须前台即时返回句柄')
  assert.equal(page.data.completing, true, '第一帧就进入完成态')
  await handle.settled
  // ★ 要等的是**云端事实**（这门课真的完成了），不是又几轮 flush —— 固定轮数会随机器快慢翻面
  //   （本文件第 25 行立下的规矩）。这里原来硬等 flush(6)，实测会报出 `'booked' == 'done'`，
  //   而真相是"测试还没跑到"，不是"课没完成"。判据强度一个字没改，只是把"什么时候"问清楚。
  await until(() => world.bookings[0] && world.bookings[0].status === 'done', '这门课必须真的在云端完成')
  await flush(6)
  assert.equal(world.bookings.filter(item => item.studentId === 'stu-1' && item.packageId === 'pkg-1').length, 1, 'booking 只有 1 条')
  assert.equal(world.bookings[0].status, 'done')
  assert.equal(Number(findPkg('pkg-1').used) - usedBefore, 1, 'package 只扣 1')
  assert.equal(Number(findPkg('pkg-1').remaining), remainingBefore - 1, 'package 剩余课时只减 1')
  assert.equal(world.incomes.length, 1, 'Income 只有 1 条')
  assert.equal(world.counts.complete, 1, '完课事务只执行一次')
  assert.equal(world.bookings[0].items.length, 4, '训练内容完整')
})

// ============ 其余真机生命周期边界 ============
scenario('⑨ 转正了但 cache 仍是旧值（回读失败）：不得自动返回，也不得出现第二条 booking', async () => {
  resetCounters()
  const KEY8 = 'stu-1|pkg-1|2026-09-17|9|0'
  world.refreshOk = false                // 命令能成功，但回读刷新一律失败 → cache 一直是旧的
  try {
    const submitted = await coordinator.submit(inputFor('2026-09-17', 9))
    assert.equal(submitted.ok, true)
    const page = openSessionFromUrl(`/pages/session/session?pending=${encodeURIComponent(KEY8)}`)
    assert.equal(page.pendingKey, KEY8)
    assert.equal(counters.back, 0, 'cache 里没有正式 booking 时绝不能返回')
    await settleCloud()
    assert.equal(world.bookings.filter(item => item.date === '2026-09-17').length, 1, 'booking 只有 1 条')
    assert.equal(cacheDB().bookings.some(item => item.date === '2026-09-17'), false, 'cache 此刻确实还是旧的（前置条件成立）')
    const bound = pendingBookings.resolveOfficial('sandbox', 'ds-sandbox', KEY8)
    assert.ok(bound, '正式身份必须已经绑定')
    page.load()
    assert.equal(page.id, bound.officialId, '绑定必须让页面就地接到正式 booking 上')
    assert.equal(counters.back, 0, '⚠️ 正式 cache 还没跟上时，页面仍然不许自动返回')
    assert.equal(page.data.items.length, 0)
    assert.equal(pendingBookings.list('sandbox', 'ds-sandbox').length, 1, '本机记录先留着，等回读真的成功再收尾')
    // 构造「本机记录已收尾、但 cache 仍是旧值」的转正窗口：此时页面只能靠正式身份留在原地。
    const live = pendingBookings.get('sandbox', 'ds-sandbox', KEY8)
    pendingBookings.remove('sandbox', 'ds-sandbox', KEY8, (live && live.requestId) || '')
    assert.equal(pendingBookings.get('sandbox', 'ds-sandbox', KEY8), null, '前置条件：本机待确认记录已收尾')
    page.load()
    assert.equal(counters.back, 0, '只要正式身份还在，就说明这条预约真实存在，绝不能被 stale cache 弹回课表')
    assert.ok(page.id, '页面必须持有正式 bookingId')
    assert.equal(world.bookings.filter(item => item.date === '2026-09-17').length, 1, '全程不得凭空多出第二条 booking')
  } finally { world.refreshOk = true; writeCache() }
})

scenario('⑩ 取消进行中：第一帧就返回，且重复 load() 不得重复返回（否则会把课表也弹掉）', async () => {
  resetCounters()
  await coordinator.submit(inputFor('2026-09-18', 10))
  await settleCloud()
  const officialId = world.bookings.find(item => item.date === '2026-09-18').id
  const page = openSessionFromUrl(`/pages/session/session?id=${officialId}`)
  assert.equal(counters.back, 0)
  page.cancel()
  await flush(4)
  assert.equal(counters.back, 1, '取消必须第一帧就返回课表')
  assert.equal(page.returned, true, '返回标记必须已置位')
  page.load(); page.load(); page.load()
  assert.equal(counters.back, 1, '⚠️ 重复 load() 不得重复返回')
  assert.equal(page.returnToSchedule(), false, '同一个页面实例的自动返回只允许发生一次')
  assert.equal(counters.back, 1)
  await settleCloud()
  assert.equal(world.bookings.some(item => item.id === officialId), false, '云端必须已经取消')
  assert.equal(world.counts.cancel, 1, '取消只允许落到云端一次')
  assert.equal(world.incomes.length, 1, '取消不得产生任何收入记录')
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox').length, 0, '取消落地后 tombstone 必须清干净')
})

scenario('⑪ create 明确失败：安全处理本机编辑态与草稿，绝不留下 Cloud 孤儿记录', async () => {
  resetCounters()
  const KEY10 = 'stu-1|pkg-1|2026-09-19|11|0'
  world.failRefreshFor = null
  const throwBackup = world.throwNetwork
  world.throwNetwork = true
  try {
    await coordinator.submit(inputFor('2026-09-19', 11))
    const page = openSessionFromUrl(`/pages/session/session?pending=${encodeURIComponent(KEY10)}`)
    assert.equal(counters.back, 0, '结果未知时页面必须停在原地')
    page.addExercise({ detail: { name: '硬拉', group: '背部' } })
    assert.equal(pendingDraft.get('sandbox', 'ds-sandbox', draftKeyOf(KEY10)).content.items.length, 1, '动作必须安全存在本机草稿')
    const before = world.executedCommands.length
    page.onHide(); await flush(4); page.onUnload(); await flush(4)
    assert.equal(world.executedCommands.length, before, '未转正离页不得产生任何云命令')
    assert.equal(world.bookings.some(item => item.date === '2026-09-19'), false, '云端不得留下孤儿记录')
    assert.equal(pendingDraft.get('sandbox', 'ds-sandbox', draftKeyOf(KEY10)).content.items.length, 1, '草稿仍然完好')
  } finally { world.throwNetwork = throwBackup }
})

scenario('⑫ 正式路径不受影响：?id= 正常进入；指向已不存在的预约仍会返回（且只返回一次）', async () => {
  resetCounters()
  const alive = world.bookings.find(item => item.id === 'booking-1')
  const page = openSessionFromUrl(`/pages/session/session?id=${encodeURIComponent(alive.id)}`)
  assert.equal(page.id, alive.id)
  assert.equal(counters.back, 0, '正常课程必须能进入')
  assert.equal(page.data.booking.id, alive.id)
  const orphan = openSessionFromUrl('/pages/session/session?id=booking-does-not-exist')
  assert.equal(counters.back, 1, '指向不存在的预约必须自动返回')
  orphan.onShow(); orphan.onShow()
  assert.equal(counters.back, 1, '⚠️ 自动返回最多一次：load() 会被反复调用，绝不能连退两层')
})

scenario('⑬ 静态回归：路径参数必须在 onLoad 解码，安全机制全部在位', async () => {
  const root = path.join(__dirname, '..')
  const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const read = file => stripComments(fs.readFileSync(path.join(root, file), 'utf8'))
  const session = read('pages/session/session.js')
  assert.ok(session.includes('decodeURIComponent'), 'onLoad 必须解码路径参数（真机根因）')
  assert.ok(session.includes('decodeParam(o&&o.pending)'), '待确认业务键必须解码后才能当身份用')
  assert.ok(session.includes('decodeParam(o&&o.id)'), '正式 bookingId 也必须解码')
  assert.equal(session.includes("(o&&o.pending)||''"), false, '不得再直接使用未解码的路径参数')
  assert.ok(session.includes('stillKnownToCoordinator'), '必须保留「转正窗口不许自动返回」的守卫')
  assert.ok(session.includes('returnToSchedule'), '自动返回必须收敛到只执行一次的入口')
  assert.equal(session.split('try{wx.navigateBack()}catch(error){}').length - 1, 0, '自动返回不得再散落直调 wx.navigateBack，必须走统一入口')
  assert.ok((session.split('returnToSchedule').length - 1) >= 4, 'load / cancel / complete 都必须收敛到统一入口')
  const schedule = read('pages/schedule/schedule.js')
  assert.ok(schedule.includes('encodeURIComponent(pendingKey)'), '课表仍必须对业务键做 URL 编码')
  const adapter = read('utils/cloud-primary-adapter.js')
  for (const marker of ['ACTIVE_READ_STALE', 'ACTIVE_READ_INTEGRITY_FAILED', 'COMMAND_RESULT_UNKNOWN', 'REQUEST_PROCESSING', 'expectedRevision', 'getReceipt']) {
    assert.ok(adapter.includes(marker), `adapter 必须保留 ${marker}`)
  }
  assert.ok(read('utils/data-runtime.js').includes('CLOUD_PRIMARY_DIRECT_WRITE_BLOCKED'))
  const optimistic = read('utils/booking-optimistic.js')
  assert.equal(/ActiveCache/.test(optimistic), false, '协调器不得触碰 active cache')
  assert.equal(/saveDB/.test(optimistic), false, '协调器不得直接写 coachDB')
  // ⚠️ 真机根因钉子：提交训练内容时，正式 bookingId 绝不能被草稿里残留的同名字段覆盖。
  assert.ok(session.includes('contentPayload'), '必须用统一的载荷构造函数把正式 bookingId 放到位')
  assert.equal(/payload:\{bookingId:this\.id,\.\.\.submission\.content\}/.test(session), false, '不得再把草稿内容展开在 bookingId 之后（空 bookingId 会覆盖正式 id）')
  const draftModule = read('utils/pending-training-draft.js')
  assert.equal(/content\.bookingId|bookingId:\s*content/.test(draftModule), false, '草稿存储层不得把 bookingId 当成内容的一部分')
})

// ============ 第 34 节：待确认课程「录完动作立刻下课」的真机时序 ============
// 真机上用户不会为了等内容上云而停手：加完动作马上点「下课」。
// 而「加完动作」与「点下课」之间，必然跨过本机草稿的 260ms 自动保存 —— 那一刻还没有正式身份。
// 本文件前面 ①–⑧ 的场景恰好绕开了这段时序（永远在 flush 前一刻才 addExercise），
// 于是自动测试全绿、真机却弹「训练内容没有在云端确认保存」。
scenario('⑭ 真机时序：pending 录动作 → 跨过本机自动保存 → 不等 Cloud 直接下课：内容安全落云 + 恰好完课一次', async () => {
  resetCounters()
  const KEY11 = 'stu-1|pkg-1|2026-09-20|14|0'
  const base = {
    content: world.counts.content, complete: world.counts.complete, creates: world.counts.create,
    incomes: world.incomes.length, bookings: world.bookings.length,
    used: Number(findPkg('pkg-1').used || 0), payloads: world.contentPayloads.length,
    completing: pendingCompletion.list('sandbox', 'ds-sandbox').length
  }
  rearmCreateGate()
  world.holdCreate = true
  try {
    const submitted = await coordinator.submit(inputFor('2026-09-20', 14))
    assert.equal(submitted.ok, true)
    const page = openSessionFromUrl(`/pages/session/session?pending=${encodeURIComponent(KEY11)}`)
    assert.equal(page.pendingKey, KEY11)
    assert.equal(counters.back, 0, '录内容前页面必须已经稳定停住')
    for (const name of ['深蹲', '腿举', '箭步蹲']) page.addExercise({ detail: { name, group: '腿部' } })
    assert.equal(page.data.items.length, 3)
    // 真机上从「加完最后一个动作」到「点下课」之间必然跨过这段本机自动保存。
    await delay(400)
    await flush(4)
    const draft = pendingDraft.get('sandbox', 'ds-sandbox', draftKeyOf(KEY11))
    assert.ok(draft && draft.content.items.length === 3, '前置条件：本机草稿已经收下 3 个动作')
    assert.equal(world.counts.create - base.creates, 0, '前置条件：用户没有等 Cloud，此刻云端还没落库')
    // 不等 Cloud，直接点下课
    const handle = await page.complete()
    assert.equal(page.data.completing, true, '第一帧就必须进入完成中')
    await flush(3)
    page.onUnload()                       // 真机：第一帧的 navigateBack 会触发 onUnload
    await flush(4)
    releaseCreate()                       // 放行 create：之后全是真实的云端回读流程
    world.holdCreate = false
    await handle.settled
    // ★ 同 ⑧：等「这门课真的扣掉 1 节课时」这个云端事实，而不是又几轮 flush。
    //   硬等固定轮数时会报「完课事务 0 次」——那是测试没等到，不是产品没发。
    await until(() => Number(findPkg('pkg-1').used) - base.used === 1, '这门课必须真的在云端扣掉 1 节课时')
    await flush(8)
    const payloads = world.contentPayloads.slice(base.payloads)
    const official = world.bookings.find(item => item.date === '2026-09-20')
    assert.ok(official && official.id, '云端必须已经落库这条预约')
    assert.equal(payloads.length, 1, `训练内容恰好一次 updateBookingContent（实际 ${payloads.length} 次，bookingId=${JSON.stringify(payloads.map(item => item.bookingId))}）`)
    assert.equal(payloads[0].bookingId, official.id, '⚠️ 真机根因：提交给云端的 bookingId 必须是正式 id，绝不能是空串')
    assert.equal(payloads[0].items.length, 3, '三个动作必须一起上云')
    assert.equal(counters.modals.some(item => item.title === '课程未完成'), false, '⚠️ 真机根因：不得再出现「训练内容没有在云端确认保存」')
    assert.equal(world.bookings.length - base.bookings, 1, 'booking 只有 1 条')
    assert.equal(world.counts.complete - base.complete, 1, '完课事务恰好一次')
    assert.equal(Number(findPkg('pkg-1').used) - base.used, 1, '课时恰好扣 1')
    assert.equal(world.incomes.length - base.incomes, 1, 'Income 恰好 1 条')
    assert.equal(official.status, 'done', '课程必须真的完成')
    assert.equal(official.items.length, 3, '训练内容完整，一条不丢')
    assert.equal(pendingDraft.get('sandbox', 'ds-sandbox', draftKeyOf(KEY11)), null, '确认落云后本机草稿必须清干净')
    assert.equal(pendingCompletion.list('sandbox', 'ds-sandbox').length, base.completing, '完课后不得留下「完成中」标记')
  } finally { world.holdCreate = false; releaseCreate() }
})

scenario('⑮ 训练内容云端确认失败时仍严格禁止完课（安全门必须保留），且可原地恢复、绝不重复扣课', async () => {
  resetCounters()
  const KEY12 = 'stu-1|pkg-1|2026-09-21|15|0'
  const base = {
    complete: world.counts.complete, incomes: world.incomes.length,
    used: Number(findPkg('pkg-1').used || 0), bookings: world.bookings.length,
    completing: pendingCompletion.list('sandbox', 'ds-sandbox').length
  }
  // 本次场景自己打出去的请求才算数 —— 用日志游标把上一场景的残留隔开。
  const failMark = world.requestLog.length
  rearmCreateGate()
  world.holdCreate = true
  try {
    await coordinator.submit(inputFor('2026-09-21', 15))
    const page = openSessionFromUrl(`/pages/session/session?pending=${encodeURIComponent(KEY12)}`)
    page.addExercise({ detail: { name: '硬拉', group: '背部' } })
    page.addExercise({ detail: { name: '罗马尼亚硬拉', group: '背部' } })
    await delay(400)
    await flush(4)
    world.failContentOnce = true            // 训练内容这一次没能落到云端
    const handle = await page.complete()
    await flush(3)
    releaseCreate()
    world.holdCreate = false
    await handle.settled
    // ★ 这里要等的是「这条完课命令到底有没有定论」，不是一个时间长度 —— 本文件第 25 行写明的规矩。
    //   原来这里是 `await flush(8)` 硬等：固定轮数会随机器快慢随机翻面，实测同一份代码
    //   20 次里有 1~2 次翻红，且失败的形态永远是「完课意图还在、attempt=0」（那条命令压根
    //   没排到发送），与产品行为无关。换成条件等待之后，产品真坏了会稳定红而不是偶发红。
    await until(() => world.requestLog.slice(failMark).some(item => item.command === 'completeBooking' && item.code),
      '这次完课必须真的打到云端并拿到明确结论（含拒绝码）')
    await flush(8)
    // ★ 阶段 2：这条内容的确认发生在**后台队列**里（页面第一帧早就返回课表了，那 260ms 的
    //   本机自动保存 + 下课之后用户已经在看课表），所以「告知」落在同步层（轻提示，绝不黑屏弹窗）。
    //   页面不再同步等待"内容已在云端确认"——那不是降低门槛，而是把把关的位置换成了
    //   「本机同一份 handlers + 队列同实体保序 + 服务端 TRAINING_ITEMS_REQUIRED 兜底」。
    //   **不变量一条都没变**：云端拒绝 → 课时不扣、收入不产生、状态不变、本机意图撤回。
    assert.equal(counters.modals.some(item => item.title === '课程未完成'), false, '页面已经离开了，不得再弹课程页的弹窗')
    assert.equal(counters.toasts.some(item => String(item.title || '').includes('没能同步')), true, '必须如实告知这次没有同步成功（同步层轻提示）')
    const intentAfterFail = pendingCompletion.list('sandbox', 'ds-sandbox')
    assert.equal(intentAfterFail.length, base.completing, `明确失败后必须撤回本机完课意图（否则课表会一直假报「已完」）｜实测 ${intentAfterFail.length} 条 / 场景基线 ${base.completing} 条 / 明细 ${JSON.stringify(intentAfterFail)}`)
    // ★ 业务不变量：**一条财务事实都不许成立**。
    //   阶段 2 起客户端会乐观地把完课命令排进队列（它并不知道云端会怎么判），云端是裁判 ——
    //   所以这里要钉的是「服务端兜底真的把它拦下来了」，而不是"客户端连试都不许试"
    //   （后者是旧同步门的实现细节，不是业务不变量）。counts.complete 计的是**尝试次数**，
    //   拿它当"事实"断言，测的就是实现细节，而且会随架构变化无意义地翻面。
    assert.ok(world.requestLog.some(item => item.command === 'completeBooking' && item.code === 'TRAINING_ITEMS_REQUIRED'), '★ 服务端兜底必须生效：训练内容没落库时完课被云端明确拒绝')
    assert.equal(Number(findPkg('pkg-1').used) - base.used, 0, '课时不得扣减')
    assert.equal(world.incomes.length - base.incomes, 0, '不得产生收入')
    assert.equal(page.data.completing, false, '必须撤回「完成中」标记，允许继续操作')
    const draft = pendingDraft.get('sandbox', 'ds-sandbox', draftKeyOf(KEY12))
    assert.ok(draft && draft.content.items.length === 2, '训练内容必须原地保留在本机草稿')
    assert.equal(world.bookings.find(item => item.date === '2026-09-21').status, 'booked', '课程状态不得改变')
    // 回到课程继续：再点一次下课 → 必须成功，且财务事实只发生一次
    const again = openSessionFromUrl(`/pages/session/session?pending=${encodeURIComponent(KEY12)}`)
    assert.equal(again.data.items.length, 2, '重新进入课程必须仍然看得到刚才录的动作')
    const retry = await again.complete()
    await retry.settled
    await flush(8)
    // 恢复后只允许**成立一次财务事实**（与上面同口径：钉事实，不钉尝试次数）。
    assert.equal(Number(findPkg('pkg-1').used) - base.used, 1, '课时恰好扣 1')
    assert.equal(world.incomes.length - base.incomes, 1, 'Income 恰好 1 条')
    assert.equal(world.bookings.length - base.bookings, 1, 'booking 只有 1 条')
    assert.equal(world.bookings.find(item => item.date === '2026-09-21').status, 'done', '课程必须真的完成')
    assert.equal(world.bookings.find(item => item.date === '2026-09-21').items.length, 2, '训练内容一条不丢')
  } finally { world.failContentOnce = false; world.holdCreate = false; releaseCreate() }
})

// ============ 第 35 节：「视觉先完成」与「已完成课程再次进入」 ============
// 真机两条反馈：
//   ① 点下课回课表，块会短暂显示一个中间状态 —— 用户明确不要这个状态；
//   ② 已经完成的课程再点一次，弹「训练内容没有在云端确认保存」。
// 两条是同一个根因：本机「用户已经点过下课」这件事（pendingCompletion）此前只被课表当成一个标签，
// 没有任何别的消费者。课程页仍然只看正式 cache，于是在「刚下课 / 云端结果还没落地」的窗口里，
// 它把一门已经完成的课当成待完成的课：既给出完课入口，也允许再走一次完课链 ——
// 而那条链的安全门（训练内容必须先云端确认）此时必然拒绝，于是弹出误报。
// 修法：让「本机完课意图」成为与正式 done 同级的呈现依据（视觉先完成），
// 同时把完课入口对该状态关闭（视觉先完成 ≠ 可以重复完课）；财务事实仍然只由云端事务产生。
const step = async (rounds = 8) => { await delay(world.executeDelay + 8); await flush(rounds) }

scenario('⑯ 【问题1】下课第一帧回课表：块直接是「已完」，不得出现「完成中」这类中间状态（财务事实仍未提前落地）', async () => {
  resetCounters()
  const DATE = '2026-09-22', HOUR = 13
  await coordinator.submit(inputFor(DATE, HOUR))
  await settleCloud()
  const officialId = world.bookings.find(item => item.date === DATE).id
  const page = openSessionFromUrl(`/pages/session/session?id=${encodeURIComponent(officialId)}`)
  page.addExercise({ detail: { name: '深蹲', group: '腿部' } })
  page.addExercise({ detail: { name: '腿举', group: '腿部' } })
  rearmCompleteGate()
  world.holdComplete = true
  const contentBefore = world.counts.content
  const incomesBefore = world.incomes.length, usedBefore = Number(findPkg('pkg-1').used || 0)
  try {
    const handle = await page.complete()
    assert.equal(page.data.completing, true, '第一帧仍必须立刻结束编辑态')
    await step()
    assert.ok(world.counts.content - contentBefore >= 1, '前置条件：训练内容已经 flush 完，后台停在被按住的完课事务上')
    page.onUnload()                       // 真机：第一帧的 navigateBack 会触发 onUnload
    assert.equal(world.bookings.find(item => item.id === officialId).status, 'booked', '前置条件：云端事务确实还在跑')
    const block = cellFor(openSchedule(), DATE, HOUR).bookings[0]
    assert.equal(block.statusLabel, '已完', '⚠️ 用户明确不要「完成中」：第一帧回课表就必须是已完成的正常视觉')
    assert.equal(block.dayLabel, '常规训练', '⚠️ 日视图同样不得显示中间状态文案')
    assert.equal(block.completing, undefined, '中间状态只允许留在视图数据里，不得再有专门的像素开关')
    assert.equal(cacheDB().bookings.find(item => item.id === officialId).status, 'booked', '正式 cache 必须还是 booked（视觉先完成 ≠ 改 cache）')
    assert.equal(world.incomes.length, incomesBefore, '不得提前制造 Income')
    assert.equal(Number(findPkg('pkg-1').used || 0), usedBefore, '不得提前扣课时')
    // ★ 阶段 2：撑住「后台仍在跑」的不再是本机完课意图，而是**持久队列条目** ——
    //   它比意图更强：进程被杀之后它还在（意图只是"还没转正、投影无从表达"那个窗口里的兜底）。
    //   视觉这一帧已经由**投影**提供了（同一份 handlers 算出来的 done，与正式 done 逐字一致），
    //   所以这里要钉的是「那条事实还安全地排在队列里等云端」，而不是"本机还挂着一个标记"。
    const outbox = require('../utils/local-outbox')
    const syncScope = require('../utils/sync-engine').scope()
    const queued = outbox.list(syncScope).filter(item => item.command === 'completeBooking')
    assert.equal(queued.length, 1, '本机必须留一条待同步的完课条目（后台仍在跑、且杀进程也不会丢）')
    assert.equal(pendingCompletion.list('sandbox', 'ds-sandbox').length, 0, '投影已经能表达「已完」，就不必再挂本机意图（挂两个消费者就是两个同源 bug）')
    releaseComplete(); world.holdComplete = false
    await handle.settled
    await flush(8)
    const after = cellFor(openSchedule(), DATE, HOUR).bookings[0]
    assert.equal(after.statusLabel, '已完', '正式 done 落地时视觉必须与第一帧逐字一致（中间状态不可见）')
    assert.equal(after.dayLabel, '常规训练')
    assert.equal(after.completing, undefined)
    assert.equal(pendingCompletion.list('sandbox', 'ds-sandbox').length, 0, '确认后本机意图必须清干净')
    assert.equal(world.incomes.length - incomesBefore, 1, 'Income 仍然恰好 1 条')
    assert.equal(Number(findPkg('pkg-1').used || 0) - usedBefore, 1, '课时仍然恰好扣 1')
  } finally { world.holdComplete = false; releaseComplete() }
})

scenario('⑰ 【问题2】已完成窗口内再次点这门课：不得出现完课入口、不得再走一次完课链、不得弹「课程未完成」', async () => {
  resetCounters()
  const DATE = '2026-09-23', HOUR = 15
  await coordinator.submit(inputFor(DATE, HOUR))
  await settleCloud()
  const officialId = world.bookings.find(item => item.date === DATE).id
  const page = openSessionFromUrl(`/pages/session/session?id=${encodeURIComponent(officialId)}`)
  page.addExercise({ detail: { name: '硬拉', group: '背部' } })
  rearmCompleteGate()
  world.holdComplete = true
  const base = { complete: world.counts.complete, content: world.counts.content, used: Number(findPkg('pkg-1').used || 0) }
  try {
    const handle = await page.complete()
    await step()
    assert.ok(world.counts.content - base.content >= 1, '前置条件：训练内容已 flush 完，后台停在被按住的完课事务上')
    page.onUnload()                       // 第一帧返回课表
    const schedule = openSchedule()
    const block = cellFor(schedule, DATE, HOUR).bookings[0]
    assert.equal(block.statusLabel, '已完', '前置条件：块已经按已完成呈现')
    // 用户立刻再点一次这门课 —— 真机上就是这一步弹出误报
    schedule.booking({ currentTarget: { dataset: { id: block.id, pending: block.pendingKey } } })
    assert.equal(counters.navigations.length, 1, '一次点击只允许一次 navigateTo')
    const backBefore = counters.back            // 第一帧那次合法返回已经计入，必须按场景基线比较
    const raw = wechatOptions(counters.navigations[0].url)
    assert.equal(raw.id, officialId, '已完成课程必须走正式 id 入口')
    assert.equal(raw.pending, undefined, '不得再落到本机编辑态入口')
    const again = openSessionFromUrl(counters.navigations[0].url)
    assert.equal(counters.back, backBefore, '已完成课程再次进入绝不允许被弹回课表')
    assert.equal(again.data.done, true, '⚠️ 真机根因：云端结果还没落地时，页面也必须按「已完成」呈现')
    // ★ 阶段 2：这一帧的「已完」来自**投影**（那条完课事实已经算完并排进持久队列），
    //   页面直接就是 `done` —— 比"挂一个中间态标记"更彻底：中间态根本不出现。
    //   `completionPending` 只在投影**表达不出**已完成时才需要（还没转正、没有正式 id 可套用），
    //   那条路径由 ⑭ / ⑯ 覆盖。这里真正要钉的是下面两条：页面不得再给出完课入口，
    //   也不得再走一轮完课链（这正是真机误报弹窗的来源）。
    assert.equal(again.data.pendingBooking, false, '已完成课程绝不允许再落回本机编辑态')
    assert.equal(again.data.completionPending, false, '投影已经能表达「已完」，就不该再挂中间态（用户明确不要「完成中」）')
    assert.equal(again.data.items.length, 1, '训练内容必须完整可见（已完成课程可以查看）')
    const modalsBeforeAgain = counters.modals.length
    const executeBeforeAgain = world.counts.execute
    const second = await again.complete()
    // ⚠️ 1.1.9 第 2 轮改了这里的语义（旧断言是 `second === undefined`）。
    //    静默 `undefined` 是"点了没反应"的来源，也是真机误报弹窗的来源：
    //    静默之后用户只能再点一次，而"再点"会落到别的分支上去。
    //    新语义必须**明确给出结果**，但对一门**已经完成**的课，那个结果只能是 no-op：
    //      · 不得新开一轮完课（否则第二次扣课 / 第二笔收入）
    //      · 不得为此向云端发任何命令
    //      · 更不得弹「结果待确认」这类误报弹窗 —— 已完成就是已完成，没有任何待确认的东西
    assert.ok(second, '★ 已完成课程再次触发也必须给出明确结果，绝不静默 return undefined')
    assert.ok(second.noop === true && second.code === 'ALREADY_DONE',
      '★ 已完成课程只能明确回「已完成 no-op」，既不得再开一轮完课、也不得去复用一条意图，实得 ' + JSON.stringify(second))
    assert.equal(world.counts.execute, executeBeforeAgain, '★ 已完成课程再点一次绝不允许再向云端发任何命令')
    assert.equal(counters.modals.length, modalsBeforeAgain, '★ 已完成课程再点一次绝不允许弹任何「结果待确认」误报弹窗')
    assert.equal(world.counts.complete - base.complete, 0, '★ 绝不允许出现第二次完课事务')
    assert.equal(world.counts.content - base.content, 1, '训练内容只允许那一次提交，不得因再点一次而重复 flush')
    assert.equal(counters.modals.filter(item => String(item.title).includes('未完成')).length, 0, '⚠️ 真机根因：绝不允许弹「训练内容没有在云端确认保存」')
    assert.equal(counters.modals.length, 0, '这条路径上不该有任何弹窗')
    again.onHide(); await flush(4); again.onUnload(); await flush(4)
    assert.equal(world.counts.content - base.content, 1, '离开已完成课程也不得再 flush 一次')
    releaseComplete(); world.holdComplete = false
    await handle.settled
    await flush(8)
    assert.equal(world.counts.complete - base.complete, 1, '全程恰好完课一次')
    assert.equal(world.incomes.filter(item => item.bookingId === officialId).length, 1, '★ Income 恰好 1 条')
    assert.equal(world.bookings.filter(item => item.date === DATE).length, 1, 'booking 只有 1 条')
    assert.equal(Number(findPkg('pkg-1').used || 0), base.used + 1, '★ 课时只扣了这门课的一次')
    assert.equal(cellFor(openSchedule(), DATE, HOUR).bookings[0].statusLabel, '已完', '正式 done 落地后视觉保持一致')
  } finally { world.holdComplete = false; releaseComplete() }
})

scenario('⑱ 云端已成功但回读失败（意图还在、cache 仍是旧值）：再次进入仍按已完成呈现，只重新同步、绝不重复完课', async () => {
  resetCounters()
  const DATE = '2026-09-24', HOUR = 16
  await coordinator.submit(inputFor(DATE, HOUR))
  await settleCloud()
  const officialId = world.bookings.find(item => item.date === DATE).id
  const page = openSessionFromUrl(`/pages/session/session?id=${encodeURIComponent(officialId)}`)
  page.addExercise({ detail: { name: '坐姿划船', group: '背部' } })
  const completeBefore = world.counts.complete
  world.failRefreshFor = 'completeBooking'   // 命令成功，但这次回读刷新失败
  world.failDirectRead = true                // 连直接重同步也失败 → 只能靠本机意图维持「已完成」视觉
  try {
    const handle = await page.complete()
    await handle.settled
    // ★ 同 ⑮ 那一处：要等的是「这条命令到底有没有打到云端」这个**事实**，不是又几轮 flush。
    //   硬等固定轮数时没跑到就会报「完课事务 0 次」—— 那是测试没等到，不是产品没发出去，
    //   两个完全相反的原因被渲染成同一句话，正是最容易把人带偏的形状。
    //   这里只等「已经发生」（≥1），下面那句断言的真正判据是「**恰好**一次」，一个字没改。
    await until(() => world.counts.complete - completeBefore >= 1, '这条完课命令必须真的打到云端')
    await flush(6)
    page.onUnload()
    assert.equal(world.counts.complete - completeBefore, 1, `完课事务恰好一次（实际 ${world.counts.complete - completeBefore} 次，code=${JSON.stringify(world.requestLog.filter(item => item.command === 'completeBooking').map(item => item.code))}）`)
    assert.equal(world.bookings.find(item => item.id === officialId).status, 'done', '云端事实上已经完成')
    assert.equal(cacheDB().bookings.find(item => item.id === officialId).status, 'booked', '前置条件：客户端 cache 仍是旧值')
    // ★ 阶段 2：撑住「结果已定、但还没同步」的是**持久队列条目**，不是本机意图标记。
    //   完课的本机事务一算完，页面就把意图标记撤了（`result.applied` 分支）——这是对的：
    //   投影已经用**同一份 handlers** 算出了 done，再挂一个标记就是两个消费者、两个同源 bug。
    //   要钉的是「这条事实还安全地排在队列里，杀进程也不会丢」。
    const outbox = require('../utils/local-outbox')
    const syncScope = require('../utils/sync-engine').scope()
    const queued = outbox.list(syncScope).filter(item => item.command === 'completeBooking')
    assert.equal(queued.length, 1, '本机必须留一条待同步的完课条目（结果已定、但还没同步）')
    assert.equal(pendingCompletion.list('sandbox', 'ds-sandbox').length, 0, '投影已经能表达「已完」，就不该再挂本机意图')
    const block = cellFor(openSchedule(), DATE, HOUR).bookings[0]
    assert.equal(block.statusLabel, '已完', '⚠️ cache 还是旧值时视觉也必须是已完成（否则用户会以为没下课）')
    const modalsBefore = counters.modals.length
    const again = openSessionFromUrl(`/pages/session/session?id=${encodeURIComponent(officialId)}`)
    assert.equal(again.data.done, true, '再次进入必须按已完成呈现')
    assert.equal(again.data.completionPending, false, '投影已经能表达「已完」，就不该再挂中间态（用户明确不要「完成中」）')
    assert.equal(again.data.items.length, 1, '训练内容可见')
    const completeBeforeRetap = world.counts.complete
    const doneAgain = await again.complete()
    // ⚠️ 1.1.9 第 2 轮：旧断言是 `=== undefined`（静默丢弃这次点击）。新语义必须**明确回一个结果**，
    //    而这门课此刻已经确定完成（意图已清、投影已表达 done）⇒ 结果只能是 no-op：
    //    不得新开一轮完课、不得为此发任何云端命令、也不得弹任何弹窗。
    assert.ok(doneAgain, '★ 已完成课程再次触发也必须给出明确结果，绝不静默 return undefined')
    assert.ok(doneAgain.noop === true && doneAgain.code === 'ALREADY_DONE',
      '★ 已完成课程只能明确回「已完成 no-op」，实得 ' + JSON.stringify(doneAgain))
    assert.equal(world.counts.complete, completeBeforeRetap, '★ 已完成课程再点绝不允许发第二条完课命令')
    assert.equal(counters.modals.length, modalsBefore, '再次进入 + 再点一次不得产生任何新弹窗')
    assert.equal(counters.modals.filter(item => String(item.title).includes('未完成')).length, 0, '不得弹「课程未完成」')
    // 回到课表触发的自动路径：只查 receipt / 只重同步，绝不重发
    world.failDirectRead = false
    await coordinator.resume()
    await flush(8)
    assert.equal(world.counts.complete - completeBefore, 1, '★ 同步过程中绝不允许再发一次完课命令')
    assert.ok(world.counts.getReceipt >= 1, '未同步状态下的自动路径必须先查 receipt')
    assert.equal(world.incomes.filter(item => item.bookingId === officialId).length, 1, 'Income 恰好 1 条')
    assert.equal(cacheDB().bookings.find(item => item.id === officialId).status, 'done', '重新同步后 cache 必须是 done')
    assert.equal(pendingCompletion.list('sandbox', 'ds-sandbox').length, 0, '同步成功后本机意图必须让位给正式 done')
    assert.equal(cellFor(openSchedule(), DATE, HOUR).bookings[0].statusLabel, '已完', '让位过程视觉不得变化')
  } finally { world.failRefreshFor = null; world.failDirectRead = false }
})

scenario('⑲ 完课明确失败：撤回本机意图、恢复正确视觉与可完课状态，之后再完课仍然只有一次', async () => {
  resetCounters()
  const DATE = '2026-09-25', HOUR = 17
  await coordinator.submit(inputFor(DATE, HOUR))
  await settleCloud()
  const officialId = world.bookings.find(item => item.date === DATE).id
  const page = openSessionFromUrl(`/pages/session/session?id=${encodeURIComponent(officialId)}`)
  page.addExercise({ detail: { name: '推举', group: '肩' } })
  const base = { complete: world.counts.complete, incomes: world.incomes.length, used: Number(findPkg('pkg-1').used || 0) }
  // 服务端**明确**拒绝（不是可重试的冲突、也不是结果未知）：本机看是 booked，云端已经不是了。
  // 它是唯一真的能走到「撤回意图 + 如实告知」那条路径的形态 —— 所以这里必须用它。
  // ⚠️ 不能用 REVISION_CONFLICT：那是**乐观锁冲突**，同步层的正确动作是"刷新后重试"，
  //    业务事实并不会因此消失，拿它当"明确失败"会把冲突重试这条正确路径误判成 bug。
  world.failCompleteOnce = 'BOOKING_STATUS_INVALID'
  try {
    const handle = await page.complete()
    await handle.settled
    // ★ 等到"**这一次**那条完课命令确实有了定论"为止（`code` 一写上就是定论：'ok' 或错误码）。
    //   ⚠️ 必须按**本次新增**的记录判断：requestLog 是跨场景累计的，直接 some() 会被历史记录骗过。
    //   ⚠️ 也不能用固定轮次等：链上有 setTimeout 的 defer 与后台确认，轮次会随机器快慢翻面
    //      （同一份代码，多几行同步 console.log 就绿、少了就红 —— 这个场景真的翻过一次）。
    const logMark = world.requestLog.length
    await until(() => world.requestLog.slice(logMark).some(item => item.command === 'completeBooking' && item.code),
      '明确拒绝必须真的打到云端并拿到拒绝码')
    await flush(4)
    assert.equal(world.counts.complete - base.complete, 1, `只允许那一次尝试（明确拒绝不得重试轰炸），实际 ${world.counts.complete - base.complete} 次，code=${JSON.stringify(world.requestLog.filter(item => item.command === 'completeBooking').map(item => item.code))}`)
    assert.equal(counters.toasts.some(item => String(item.title || '').includes('没能同步')), true, '明确失败必须如实告知（同步层轻提示）')
    assert.equal(counters.modals.filter(item => String(item.title).includes('未完成')).length, 0, '页面已经离开了，不得再弹课程页的弹窗')
    assert.equal(pendingCompletion.list('sandbox', 'ds-sandbox').length, 0, '明确失败必须撤回本机「已完成」意图')
    assert.equal(cellFor(openSchedule(), DATE, HOUR).bookings[0].statusLabel, '待上', '⚠️ 失败后视觉必须恢复成真实状态，不能一直显示已完成')
    assert.equal(world.incomes.length, base.incomes, '失败不得产生 Income')
    assert.equal(Number(findPkg('pkg-1').used || 0), base.used, '失败不得扣课时')
    // 用户回到课程重新下课：环境正常后必须恰好成功一次
    const again = openSessionFromUrl(`/pages/session/session?id=${encodeURIComponent(officialId)}`)
    assert.equal(again.data.done, false, '失败后页面必须恢复成可完课状态')
    assert.equal(again.data.completionPending, false)
    assert.equal(again.data.items.length, 1, '训练内容仍在')
    const retry = await again.complete()
    assert.ok(retry && retry.deferred, '重新下课必须仍然第一帧即时响应')
    await retry.settled
    await flush(8)
    assert.equal(world.counts.complete - base.complete, 2, '一次明确失败 + 一次成功')
    assert.equal(world.bookings.find(item => item.id === officialId).status, 'done')
    assert.equal(world.incomes.filter(item => item.bookingId === officialId).length, 1, '★ Income 仍然恰好 1 条')
    assert.equal(Number(findPkg('pkg-1').used || 0), base.used + 1, '★ 课时恰好只扣 1')
  } finally { world.failCompleteOnce = null }
})

scenario('⑳ 完课响应丢失（云端已执行、客户端只见未知）：视觉保持已完成、绝不重发；receipt 确认后自然让位给正式 done', async () => {
  resetCounters()
  const DATE = '2026-09-26', HOUR = 18
  await coordinator.submit(inputFor(DATE, HOUR))
  await settleCloud()
  const officialId = world.bookings.find(item => item.date === DATE).id
  const page = openSessionFromUrl(`/pages/session/session?id=${encodeURIComponent(officialId)}`)
  page.addExercise({ detail: { name: '面拉', group: '肩' } })
  const base = { complete: world.counts.complete, incomes: world.incomes.length, used: Number(findPkg('pkg-1').used || 0) }
  world.loseResponseFor = 'completeBooking'
  // 真正的「云端已成功、本机还没跟上」窗口必须**同时**让直接回读也失败：
  // 否则同步层一旦拿到 succeeded 回执，下一次完整回读就把 cache 刷新到位了 ——
  // 那个窗口根本不存在，测试也就测不到"回执确认但本机没同步"时该不该出队。
  world.failDirectRead = true
  try {
    const handle = await page.complete()
    await handle.settled
    await flush(8)
    page.onUnload()
    assert.equal(world.counts.complete - base.complete, 1, '只允许发出一次尝试')
    assert.equal(world.incomes.length, base.incomes + 1, '云端事实上已经完成（收入已产生）')
    assert.equal(cacheDB().bookings.find(item => item.id === officialId).status, 'booked', '前置条件：客户端 cache 还没跟上')
    // ★ 阶段 2：撑住「结果未知」的是**持久队列条目**（它的 status 就是 unknown）。
    //   本机意图标记在本机事务一算完就撤了 —— 投影已经能表达 done，再挂标记就是第二个消费者。
    //   这里真正要钉的是：**未知绝不等于失败**，条目必须留在队列里等回执，绝不能被删掉。
    const outbox = require('../utils/local-outbox')
    const syncScope = require('../utils/sync-engine').scope()
    const queued = outbox.list(syncScope).filter(item => item.command === 'completeBooking')
    assert.equal(queued.length, 1, '结果未知/已确认但没同步时，队列条目必须留着，不许当失败删掉、也不许提前出队')
    // 具体是 unknown 还是 settled 取决于"这一轮有没有查到 succeeded 回执"（时序相关，不该钉死）；
    // 两者**语义完全一致且都是唯一正确的**：继续参与投影、绝不重发，等一次成功回读再出队。
    assert.ok(['unknown', 'settled'].includes(queued[0].status), `未同步到位的条目状态只能是 unknown / settled（实际 ${queued[0].status}）`)
    assert.equal(pendingCompletion.list('sandbox', 'ds-sandbox').length, 0, '投影已经能表达「已完」，就不该再挂本机意图')
    assert.equal(cellFor(openSchedule(), DATE, HOUR).bookings[0].statusLabel, '已完', '⚠️ 结果未知时视觉仍按已完成呈现（不是失败、也不是中间态）')
    const again = openSessionFromUrl(`/pages/session/session?id=${encodeURIComponent(officialId)}`)
    assert.equal(again.data.done, true, '结果未知时再次进入也必须按已完成呈现')
    assert.equal(again.data.completionPending, false, '投影已经能表达「已完」，就不该再挂中间态')
    const doneAgain2 = await again.complete()
    assert.ok(doneAgain2 && doneAgain2.noop === true && doneAgain2.code === 'ALREADY_DONE',
      '★ 结果未知期间再次进入、再点一次：也必须明确回「已完成 no-op」，绝不静默丢弃、也绝不开第二轮，实得 ' + JSON.stringify(doneAgain2))
    assert.equal(world.counts.complete - base.complete, 1, '★ 自动路径绝不重发完课命令')
    // 回到课表触发的自动路径：只查 receipt → 确认成功 → 重同步 → 让位给正式 done
    world.loseResponseFor = null
    world.failDirectRead = false          // 网络恢复：回读终于能成功，条目才可以出队
    await coordinator.resume()
    await flush(8)
    assert.equal(world.counts.complete - base.complete, 1, '★ self-heal 绝不允许再发一次完课')
    assert.equal(pendingCompletion.list('sandbox', 'ds-sandbox').length, 0, '确认成功后本机意图必须清掉')
    assert.equal(cacheDB().bookings.find(item => item.id === officialId).status, 'done', '正式 done 接管')
    assert.equal(world.incomes.length, base.incomes + 1, '★ Income 仍然恰好 1 条')
    assert.equal(Number(findPkg('pkg-1').used || 0), base.used + 1, '★ 课时恰好只扣 1')
    assert.equal(cellFor(openSchedule(), DATE, HOUR).bookings[0].statusLabel, '已完', '让位过程视觉不得变化')
  } finally { world.loseResponseFor = null; world.failDirectRead = false }
})

scenario('㉑ 静态回归：课表不得再出现「完成中」像素；本机完课意图绝不写 cache、绝不提前造财务事实', async () => {
  const root = path.join(__dirname, '..')
  const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const read = file => stripComments(fs.readFileSync(path.join(root, file), 'utf8'))
  const scheduleView = fs.readFileSync(path.join(root, 'pages/schedule/schedule.wxml'), 'utf8')
  const scheduleStyle = fs.readFileSync(path.join(root, 'pages/schedule/schedule.wxss'), 'utf8')
  assert.equal(/booking-chip/.test(scheduleView), false, '⚠️ 课表不得再渲染中间状态胶囊')
  assert.equal(/booking-chip/.test(scheduleStyle), false, '不得留下中间状态的样式规则')
  const schedule = read('pages/schedule/schedule.js')
  assert.equal(/completing\s*\?\s*'完成中'/.test(schedule), false, 'decorateBooking 不得再把中间状态画成像素')
  assert.ok(schedule.includes('completionPending'), '课表必须用「本机完课意图」把块呈现成已完成')
  const session = read('pages/session/session.js')
  assert.ok(session.includes('completionIntentFor'), '课程页必须读本机完课意图来决定呈现')
  assert.ok(session.includes('completionPending'), '课程页必须知道「完课结果未落地」这个状态')
  // ⚠️ 1.1.9 第 2 轮：门禁的**写法**变了（旧的 `if(this.data.done||this.data.completionPending)return`
  //    是那种"静默 return"），但门禁本身一条都不许少，而且要**入口 + 出口两处**都钉住：
  //      ① 入口（WXML）：完成 / 结果待落地时，完课按钮根本不渲染；
  //      ② 出口（JS）：就算有人绕过按钮直接调 complete()，也只能拿到「已完成 no-op」——
  //         既不静默丢弃这次点击，也绝不开第二轮完课。
  const sessionWxml = fs.readFileSync(path.join(root, 'pages/session/session.wxml'), 'utf8')
  assert.ok(/<button wx:if="\{\{!done\}\}"/.test(sessionWxml), '完课入口必须有 done 门禁（完成/待落地时按钮不得渲染）')
  assert.ok(/if\(this\.data\.done\)\{/.test(session), '完课出口必须有 done 门禁（绕过按钮也只能拿到 no-op）')
  assert.ok(session.includes("code:'ALREADY_DONE'"), '★ done 门禁必须明确回 ALREADY_DONE，绝不静默 return')
  assert.ok(session.includes('DRAFT_NOT_CONFIRMED'), '★ 训练内容必须先云端确认的安全门必须保留')
  assert.ok(session.includes('failCompletion'), '明确失败必须撤回意图并提示')
  assert.ok(session.includes('pendingCompletion.remove'), '成功/失败都要清掉本机意图')
  const completion = read('utils/pending-completion.js')
  assert.equal(/ActiveCache|coachDB|saveDB/.test(completion), false, '本机完课意图不得触碰 active cache / coachDB')
  assert.ok(completion.includes('intentFor'), '意图查询必须由本模块提供（生产与测试同一份逻辑）')
  const optimistic = read('utils/booking-optimistic.js')
  assert.ok(optimistic.includes('completion'), '协调器必须能对完课意图做 self-heal（与取消同一套规则）')
  assert.equal(/pkg\.used|incomes\.push/.test(optimistic), false, '协调器不得自己扣课时或造收入')
  assert.equal(/ActiveCache/.test(optimistic), false, '协调器不得触碰 active cache')
  const command = read('utils/ui-cloud-command.js')
  assert.ok(/completion:\s*pendingCompletion/.test(command), '生产接线必须把完课意图注入协调器（self-heal 才真正生效）')
  assert.ok(command.includes('pendingCompletion.intentFor'), '生产侧查询意图必须复用同一份匹配逻辑')
})

;(async () => {
  for (const item of scenarios) {
    const started = Date.now()
    await item.fn()
    console.log(`  ✓ ${item.name} (${Date.now() - started}ms)`)
  }
  console.log('session pending lifecycle tests: PASS (one tap enters and stays; no auto-return; no duplicate booking; content bound to formal bookingId; full chain still 1 booking / package -1 / income 1)')
})().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 }).finally(() => {
  if (oldRuntime) require.cache[runtimePath] = oldRuntime; else delete require.cache[runtimePath]
  if (oldCommand) require.cache[commandPath] = oldCommand; else delete require.cache[commandPath]
})
