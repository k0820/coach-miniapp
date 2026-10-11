// 一整条高频链路的「即时响应」永久回归：
//   约课秒回 → 立即能进课 → 选动作秒回 → 完课秒回
//
// 这个测试刻意不用「把协调器 mock 掉」的写法：它加载真实的
//   utils/booking-optimistic.js、utils/pending-booking-request.js、utils/pending-completion.js、
//   utils/pending-training-draft.js、pages/session/session.js、pages/schedule/schedule.js，
// 只把「云」与「adapter」换成可注入的假件。这样断言的才是真实现，不是替身。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
// setData 假件必须与真实微信同口径：支持路径更新（课表刷新只推真的变了的格子）。
const { applyPatch } = require('./helpers/set-data')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const flush = async (rounds = 24) => { for (let i = 0; i < rounds; i++) await delay(1) }

// ---------------------------------------------------------------- 假 wx
const storage = { coachSandboxActiveCache: { datasetId: 'ds-sandbox' }, coachCloudActiveCache: { datasetId: 'ds-prod' } }
const counters = { loading: 0, toasts: [], modals: [], navigations: [], back: 0 }
global.wx = {
  getStorageSync: key => copy(storage[key]),
  setStorageSync: (key, value) => { storage[key] = copy(value) },
  showToast: options => counters.toasts.push(options),
  showModal: options => counters.modals.push(options),
  showLoading: options => { counters.loading++; counters.lastLoading = options },
  hideLoading() {},
  showTabBar() {},
  nextTick: task => setTimeout(task, 0),
  navigateTo: options => counters.navigations.push(options),
  navigateBack() { counters.back++ },
  cloud: { callFunction: () => Promise.resolve({ result: { ok: false, code: 'NOT_USED' } }) },
  createSelectorQuery: () => ({ selectAll: () => ({ boundingClientRect: () => ({ exec() {} }) }) })
}

// ---------------------------------------------------------------- 假云
const world = {
  datasetId: 'ds-sandbox', revision: 1, online: true,
  refreshOk: true, failNextRefresh: 0, refreshCalls: 0,
  throwNetwork: false, receiptStatusOnThrow: 'unknown', failRefreshFor: null, suspendResume: false,
  executeDelay: 0,
  students: [{ id: 'stu-1', name: '假学员', packages: [{ id: 'pkg-1', type: '常规训练', price: 100, used: 0, remaining: 5 }] }],
  bookings: [], incomes: [], customExercises: [],
  receipts: new Map(), ops: [], executedCommands: [], requestLog: [],
  counts: { execute: 0, readActive: 0, getReceipt: 0, complete: 0, content: 0, create: 0 }
}
const findPkg = id => world.students[0].packages.find(item => item.id === id)
const snapshot = () => ({ students: copy(world.students), bookings: copy(world.bookings), incomes: copy(world.incomes), customExercises: copy(world.customExercises) })

function applyCommand(command, payload) {
  world.ops.push(command)
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
    const booking = world.bookings.find(item => item.id === payload.bookingId)
    if (!booking) return { ok: false, code: 'BOOKING_NOT_FOUND' }
    if (booking.status === 'done') return { ok: true, command, datasetRevision: world.revision, alreadyDone: true }
    booking.status = 'done'
    const pkg = findPkg(booking.packageId)
    if (pkg) { pkg.used = Number(pkg.used || 0) + 1; pkg.remaining = Number(pkg.remaining || 0) - 1 }
    world.incomes.push({ id: `income-${world.incomes.length + 1}`, bookingId: booking.id, amount: 100 })
    world.revision++
    return { ok: true, command, datasetRevision: world.revision }
  }
  return { ok: false, code: 'COMMAND_NOT_ALLOWED' }
}

const adapter = {
  getState: () => ({ datasetId: world.datasetId, revision: world.revision }),
  resetState() {},
  async readActive() {
    world.counts.readActive++
    world.refreshCalls++
    if (world.failNextRefresh > 0) { world.failNextRefresh--; return { ok: false, code: 'ACTIVE_READ_INTEGRITY_FAILED' } }
    if (!world.refreshOk) return { ok: false, code: 'ACTIVE_READ_INTEGRITY_FAILED' }
    return { ok: true, datasetId: world.datasetId, revision: world.revision }
  },
  // 与真实 adapter.execute 语义一致：命令成功后无条件跑完整 readActive；
  // 抛错时查 receipt；同 requestId 命中 receipt 直接返回首次结果（幂等，不产生第二条业务结果）。
  async execute(command, payload, options = {}) {
    world.counts.execute++
    world.executedCommands.push(command)
    const requestId = options.requestId
    world.requestLog.push({ command, requestId })
    if (world.executeDelay) await delay(world.executeDelay)
    if (world.throwNetwork) {
      // 与真实 adapter 抛错路径一致：先查 receipt（同一 requestId 已成功就直接拿结果），
      // 查不到才按 unknown/processing 处理，绝不盲目重发业务。
      const receipt = await adapter.getReceipt(requestId)
      if (receipt && receipt.found && receipt.status === 'succeeded') { const refreshed = await adapter.readActive(); return { ...copy(receipt.response), recoveredFromReceipt: true, refreshed } }
      if (world.receiptStatusOnThrow === 'processing') return { ok: false, code: 'REQUEST_PROCESSING', requestId }
      return { ok: false, code: 'COMMAND_RESULT_UNKNOWN', requestId }
    }
    const cached = world.receipts.get(requestId)
    const response = cached ? copy(cached.response) : applyCommand(command, payload)
    if (response.ok && !cached) world.receipts.set(requestId, { status: 'succeeded', response: copy(response) })
    if (!response.ok) return response
    if (world.failRefreshFor === command) return { ...response, refreshFailed: { ok: false, code: 'ACTIVE_READ_INTEGRITY_FAILED' } }
    const refreshed = await adapter.readActive()
    return refreshed.ok ? { ...response, refreshed } : { ...response, refreshFailed: refreshed }
  },
  async getReceipt(requestId) {
    world.counts.getReceipt++
    const receipt = world.receipts.get(requestId)
    if (receipt) return { ok: true, found: true, status: receipt.status, response: copy(receipt.response) }
    return { ok: true, found: false }
  }
}

// ---------------------------------------------------------------- 真 runtime / 真 store / 真协调器
let currentEnvironment = 'sandbox'
const runtime = {
  environment: () => currentEnvironment,
  setEnvironment: value => { currentEnvironment = value },
  cacheKey: () => currentEnvironment === 'sandbox' ? 'coachSandboxActiveCache' : 'coachCloudActiveCache',
  cutoverState: () => ({ status: 'cloud-primary' }),
  MODES: { LOCAL: 'local-primary', ACTIVATING: 'activating', PENDING: 'cutover-pending', CLOUD: 'cloud-primary' },
  getDB: () => snapshot(),
  writesFrozen: () => true,
  mode: () => 'cloud-primary'
}
const pendingBookings = require('../utils/pending-booking-request')
const pendingCompletion = require('../utils/pending-completion')
const pendingDraft = require('../utils/pending-training-draft')
const { createBookingOptimistic } = require('../utils/booking-optimistic')

let requestSeq = 0
const coordinator = createBookingOptimistic({
  runtime, pending: pendingBookings, completion: pendingCompletion, adapter,
  isOnline: () => world.online,
  newRequestId: () => `req-${++requestSeq}`,
  readDatasetId: () => currentEnvironment === 'sandbox' ? 'ds-sandbox' : 'ds-prod',
  readSnapshot: () => { try { return snapshot() } catch (error) { return null } },
  showToast: options => counters.toasts.push(options),
  showModal: options => counters.modals.push(options)
})

const commandPending = new Map()
let opSeq = 0
const operationId = key => { if (!commandPending.has(key)) commandPending.set(key, `op-${++opSeq}-${key}`); return commandPending.get(key) }
const clearPending = (key, requestId) => { if (commandPending.get(key) === requestId) commandPending.delete(key) }
// 静默通道：语义等同 runCommand，只是不弹遮罩。
async function runCommandSilent({ key, command, payload, requestId, onSuccess }) {
  if (!world.online) return { ok: false, code: 'OFFLINE_READ_ONLY' }
  if (!Number.isInteger(adapter.getState().revision)) return { ok: false, code: 'REVISION_UNKNOWN' }
  const fixed = requestId || operationId(key)
  const result = await adapter.execute(command, payload, { requestId: fixed })
  if (result.ok) { commandPending.delete(key); if (onSuccess) await onSuccess(result) }
  return result
}
// 旧的阻塞通道：只要有人回退到它，loading 计数就会 > 0，被最后的断言抓住。
async function runCommand(options) { counters.loading++; return runCommandSilent(options) }

const runtimePath = require.resolve('../utils/data-runtime')
const commandPath = require.resolve('../utils/ui-cloud-command')
const oldRuntime = require.cache[runtimePath], oldCommand = require.cache[commandPath]
require.cache[runtimePath] = {
  id: runtimePath, filename: runtimePath, loaded: true,
  exports: {
    // 纯函数（pad / typeOf / uid 等）直接用真实实现，只替换数据来源与环境。
    ...require('../utils/db'),
    getDB: () => snapshot(), saveDB: () => { throw new Error('CLOUD_PRIMARY_DIRECT_WRITE_BLOCKED') },
    uid: () => `local-${++opSeq}`, timeStr: booking => `${booking.hour}:00`,
    cacheKey: () => runtime.cacheKey(), environment: () => currentEnvironment,
    writesFrozen: () => true, mode: () => 'cloud-primary', cutoverState: () => runtime.cutoverState(),
    MODES: runtime.MODES, ENVIRONMENTS: { PRODUCTION: 'production', SANDBOX: 'sandbox' }, setEnvironment: runtime.setEnvironment
  }
}
require.cache[commandPath] = {
  id: commandPath, filename: commandPath, loaded: true,
  exports: {
    adapter, isCloudPrimary: () => true, runCommand, runCommandSilent, operationId, clearPending,
    submitBooking: input => coordinator.submit(input),
    resumePendingBookings: () => world.suspendResume ? Promise.resolve({ ok: true, skipped: true }) : coordinator.resume(),
    pendingBookingRecords: () => coordinator.records(),
    mergePendingBookings: bookings => coordinator.mergeBookings(bookings),
    subscribePendingBookings: listener => coordinator.subscribe(listener),
    notifyPendingBookings: () => coordinator.notifyView(),
    officialIdForBooking: key => coordinator.officialIdFor(key),
    awaitOfficialBooking: (key, timeout) => coordinator.awaitOfficial(key, timeout),
    retryPendingBooking: key => coordinator.retry(key),
    bindingForOfficialId: officialId => {
      const datasetId = currentEnvironment === 'sandbox' ? 'ds-sandbox' : 'ds-prod'
      return pendingBookings.bindingForOfficialId(currentEnvironment, datasetId, officialId)
    },
    // 与真实 ui-cloud-command 同一份匹配逻辑（都在 pending-completion 真模块里，不在 mock 里重写）。
    completionIntentFor: input => pendingCompletion.intentFor(currentEnvironment, currentEnvironment === 'sandbox' ? 'ds-sandbox' : 'ds-prod', input && input.officialId, input && input.localKey),
    bookingBindings: () => pendingBookings.listBindings(currentEnvironment, currentEnvironment === 'sandbox' ? 'ds-sandbox' : 'ds-prod')
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
  // setData 必须在绑定之后覆盖，且要挂在实例上
  object.setData = function (patch, callback) { applyPatch(this.data, patch); if (callback) callback() }
  return object
}
const openSession = options => { const page = mount(sessionConfig); page.onLoad(options); page.onShow(); return page }
const openSchedule = () => { const page = mount(scheduleConfig); page.onShow(); return page }
const cellFor = (schedule, date, hour) => { schedule.loadScheduleData(); return schedule.makeCell(date, hour, false) }
const KEY = 'stu-1|pkg-1|2026-09-16|16|0'
const INPUT = { studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', packageIndex: 0, date: '2026-09-16', hour: 16, minute: 0, typeName: '常规训练', price: 100, command: 'createBooking' }
const resetCounters = () => { counters.loading = 0; counters.toasts.length = 0; counters.modals.length = 0; counters.navigations.length = 0; counters.back = 0 }

const scenarios = []
const scenario = (name, fn) => scenarios.push({ name, fn })

scenario('① 约课秒回：第一帧就有课，且零 Cloud 调用', async () => {
  resetCounters()
  const before = world.counts.execute
  const submitted = await coordinator.submit(INPUT)
  assert.equal(submitted.ok, true, '预约必须前台即时成功')
  assert.equal(submitted.deferred, true, '后台确认必须是 deferred')
  assert.equal(world.counts.execute, before, '提交瞬间不允许有任何 Cloud 命令')
  assert.equal(counters.loading, 0, '预约前台路径不允许出现等待遮罩')
  assert.equal(coordinator.records().length, 1, '第一帧视图层就应有这条预约')
  const merged = coordinator.mergeBookings(snapshot().bookings)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].pending, true, '内部仍是待确认状态')
  assert.equal(merged[0].viewKey, `stable:${KEY}`, '必须带稳定渲染 key')
  assert.equal(snapshot().bookings.length, 0, '正式 cache / 云端此时还不该有这条预约')
})

scenario('② 刚约完立即进课：进入本机编辑态，不伪造 bookingId、不发任何正式命令', async () => {
  resetCounters()
  // 秒回之后命令还在路上（真实里大约一两秒）。这里把页面级 resume 关掉，
  // 精确复现「块已经画出来了、云端还没转正」的那个窗口。
  world.suspendResume = true
  const before = world.counts.execute
  const schedule = openSchedule()
  const cell = cellFor(schedule, '2026-09-16', 16)
  assert.equal(cell.bookings.length, 1, '课表第一帧就应看到这条预约')
  assert.equal(cell.bookings[0].pending, true, '此时内部仍是待确认状态')
  assert.equal(snapshot().bookings.length, 0, '云端此时还没有这条预约')
  schedule.booking({ currentTarget: { dataset: { id: cell.bookings[0].id, pending: KEY } } })
  assert.equal(counters.navigations.length, 1, '必须能立即进入课程')
  assert.ok(counters.navigations[0].url.includes(`pending=${encodeURIComponent(KEY)}`), '进入课程必须带业务键')
  assert.equal(counters.navigations[0].url.includes('?id='), false, '本机编辑态不得带 bookingId')
  const session = openSession({ pending: KEY })
  assert.equal(session.id, '', '未转正时不允许有 bookingId')
  assert.equal(session.pendingKey, KEY)
  assert.equal(session.localId, `pending:${KEY}`)
  assert.equal(session.data.items.length, 0)
  assert.equal(session.data.done, false)
  assert.equal(session.data.pendingBooking, true, '页面必须知道自己在本机编辑态')
  assert.equal(world.counts.execute, before, '进入课程不允许产生任何 Cloud 命令')
})

scenario('③ 选动作第一帧立即加入：零 Cloud、零遮罩', async () => {
  resetCounters()
  const session = openSession({ pending: KEY })
  const before = world.counts.execute
  session.addExercise({ detail: { name: '高位下拉', group: '背部' } })
  assert.equal(session.data.items.length, 1, '第一帧就必须在列表里')
  assert.equal(session.data.items[0].name, '高位下拉')
  assert.equal(session.data.items[0].sets, 4, '默认组数必须就位')
  assert.equal(world.counts.execute, before, '选动作不允许等 Cloud')
  assert.equal(counters.loading, 0, '选动作不允许出现等待遮罩')
  assert.equal(session.data.draftPending, true, '同时必须已安全落本机草稿')
  assert.equal(pendingDraft.get('sandbox', 'ds-sandbox', `pending:${KEY}`).content.items.length, 1, '本机草稿必须已写入并回读')
})

scenario('④ 连续快速添加多个动作：顺序与内容正确，仍零 Cloud', async () => {
  const session = openSession({ pending: KEY })
  const before = world.counts.execute
  for (const name of ['高位下拉', '坐姿划船', '杠铃卧推']) session.addExercise({ detail: { name, group: '背部' } })
  session.itemInput({ currentTarget: { dataset: { i: 1, k: 'weight' } }, detail: { value: '45' } })
  assert.deepEqual(session.data.items.map(item => item.name), ['高位下拉', '坐姿划船', '杠铃卧推'], '顺序不能乱')
  assert.equal(session.data.items[1].weight, '45', '输入必须落到正确的行')
  assert.deepEqual(session.data.groupSections.map(section => section.group), ['背部'], '分组必须合并')
  assert.equal(world.counts.execute, before, '连点期间不允许有任何 Cloud 命令')
  assert.equal(counters.loading, 0)
  assert.equal(pendingDraft.get('sandbox', 'ds-sandbox', `pending:${KEY}`).content.items.length, 3, '草稿必须跟着更新')
})

scenario('⑤ 立即返回再进入：动作一条不丢', async () => {
  const session = openSession({ pending: KEY })
  session.addExercise({ detail: { name: '哑铃侧平举', group: '肩' } })
  session.back()
  const reopened = openSession({ pending: KEY })
  assert.equal(reopened.data.items.length, 4, '重新进入必须看到全部 4 个动作')
  assert.ok(reopened.data.items.some(item => item.name === '哑铃侧平举'))
  assert.equal(reopened.data.draftPending, true)
})

scenario('⑥ stale cache 不能覆盖刚选的动作', async () => {
  const session = openSession({ pending: KEY })
  assert.equal(snapshot().bookings.length, 0, '云端此时还没有这条预约（典型的 stale cache）')
  session.load()
  assert.equal(session.data.items.length, 4, '旧快照绝不能把刚选的动作清掉')
})

scenario('⑦ 转正：临时态无缝绑定正式唯一 booking，仍只有 1 条', async () => {
  world.suspendResume = false
  await flush()
  assert.equal(world.bookings.length, 1, '转正后必须恰好 1 条正式预约（不允许出现第二条）')
  const officialId = world.bookings[0].id
  const bound = pendingBookings.resolveOfficial('sandbox', 'ds-sandbox', KEY)
  assert.ok(bound && bound.officialId === officialId, '必须留下本机身份 → 正式 bookingId 的绑定')
  assert.equal(pendingBookings.list('sandbox', 'ds-sandbox').length, 0, '转正后待确认记录必须清干净')
  const session = openSession({ pending: KEY })
  assert.equal(session.id, officialId, '同一个业务键必须无缝绑到正式 booking 上')
  assert.equal(session.data.items.length, 4, '绑定时动作一条不能丢')
  assert.equal(session.data.pendingBooking, false, '转正后不再标记为本机编辑态')
  const schedule = openSchedule()
  const cell = cellFor(schedule, '2026-09-16', 16)
  assert.equal(cell.bookings.length, 1, '课表也只允许有一条')
  assert.equal(cell.bookings[0].viewKey, `stable:${KEY}`, '转正必须沿用同一个渲染 key（不闪、不重建节点）')
  assert.equal(cell.bookings[0].pending, false)
})

scenario('⑧ 转正后重新进入：仍能读到转正前写的草稿（不会看起来丢了动作）', async () => {
  const officialId = world.bookings[0].id
  const items = [
    { name: '高位下拉', group: '背部', sets: 4, reps: 12, weight: '' },
    { name: '坐姿划船', group: '背部', sets: 4, reps: 12, weight: '45' },
    { name: '杠铃卧推', group: '背部', sets: 4, reps: 12, weight: '' },
    { name: '哑铃侧平举', group: '肩', sets: 4, reps: 12, weight: '' }
  ]
  // 精确复现「转正前刚录完内容、debounce 还没发出去」的窗口：云端这条课的内容还是空的。
  pendingDraft.write('sandbox', 'ds-sandbox', `pending:${KEY}`, { items, notes: '假数据备注', category: '背部训练', duration: 60 })
  world.bookings[0].items = []
  const session = openSession({ id: officialId })
  assert.equal(session.localDraftKey(), `pending:${KEY}`, '必须继续用转正前的草稿键')
  assert.equal(session.data.items.length, 4, '动作必须还在')
  assert.equal(session.data.draftPending, true)
})

scenario('⑨ 完成课程：第一帧立即响应并返回课表', async () => {
  resetCounters()
  const session = openSession({ id: world.bookings[0].id })
  const before = world.counts.execute
  const handle = await session.complete()
  assert.equal(handle.deferred, true, '完课必须前台即时返回句柄')
  assert.equal(handle.ok, true)
  // 注意：完课的第一帧**允许也必须**先把训练内容 flush 到云端（这是「动作不丢」的硬要求，
  // flush 本身就要发一条 updateBookingContent）。真正被禁止的是：第一帧就把整条链跑完、
  // 尤其是提前开始完课事务。所以这里断言的是「完课事务没有在第一帧启动」，而不是「零 Cloud 调用」。
  assert.equal(world.counts.complete, 0, '点击完成的第一帧绝不允许开始完课事务')
  assert.equal(world.executedCommands.includes('completeBooking'), false, '第一帧不允许出现完课命令')
  assert.ok(world.counts.execute - before <= 1, '第一帧最多只允许为「不丢动作」而 flush 训练内容这一条命令')
  assert.equal(session.data.completing, true, '第一帧必须结束编辑态')
  const schedule = openSchedule()
  const cell = cellFor(schedule, '2026-09-16', 16)
  // ⚠️ 契约变更（第 35 节）：用户明确不要任何可见的中间状态。
  // 第一帧回课表就必须是「已完成的正常视觉」——块本身与正式 done 落地后逐字一致，
  // 中间状态只允许留在视图数据里（pendingCompletion），不再有任何像素开关。
  assert.equal(cell.bookings[0].statusLabel, '已完', '第一帧回课表就必须按已完成呈现，不得出现「完成中」')
  assert.equal(cell.bookings[0].dayLabel, '常规训练', '日视图同样不得显示中间状态文案')
  assert.equal(cell.bookings[0].completing, undefined, '不得再把中间状态暴露成像素开关')
  assert.equal(snapshot().bookings[0].status, 'booked', '云端事实此时还没变 —— 绝不能提前写成 done')
  assert.equal(pendingCompletion.list('sandbox', 'ds-sandbox').length, 1, '本机必须留一条完成中标记')
  await delay(2)
  assert.equal(counters.back, 1, '第一帧之后必须立刻回到课表')
  await handle.settled
})

scenario('⑩ 完课结果：训练内容先确认、再单次完课事务，课时恰好扣 1、Income 恰好 1 条', async () => {
  await flush()
  const lastContent = world.ops.lastIndexOf('updateBookingContent')
  const lastComplete = world.ops.lastIndexOf('completeBooking')
  assert.ok(lastContent > -1, '必须先用固定 requestId 把训练内容确认到云端')
  assert.ok(lastComplete > -1, '必须发出完课事务')
  assert.ok(lastContent < lastComplete, '训练内容必须先于完课确认')
  assert.equal(world.bookings[0].status, 'done')
  assert.equal(world.bookings[0].items.length, 4, '完课后训练内容必须完整保留')
  assert.equal(world.students[0].packages[0].used, 1, '课时恰好扣 1')
  assert.equal(world.students[0].packages[0].remaining, 4, '剩余课时恰好减 1')
  assert.equal(world.incomes.length, 1, 'Income 恰好 1 条')
  assert.equal(world.incomes[0].bookingId, world.bookings[0].id)
  assert.equal(world.counts.complete, 1, '完课事务只允许执行一次')
  assert.equal(pendingCompletion.list('sandbox', 'ds-sandbox').length, 0, '确认后完成中标记必须清除')
  assert.equal(pendingDraft.get('sandbox', 'ds-sandbox', `pending:${KEY}`), null, '已确认的训练草稿必须清除')
  const schedule = openSchedule()
  const cell = cellFor(schedule, '2026-09-16', 16)
  assert.equal(cell.bookings[0].completing, undefined, '确认落地后同样没有中间状态像素')
  assert.equal(cell.bookings[0].statusLabel, '已完', '落地后的视觉必须与第一帧逐字一致')
})

scenario('⑪ 快速重复点完成：只执行一次，即使重复提交也命中固定 requestId 幂等', async () => {
  // 造一条新的待完课
  world.bookings.push({ id: 'booking-dup', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-17', hour: 9, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: [{ name: '深蹲', group: '腿部', sets: 4, reps: 12, weight: '' }], notes: '' })
  const session = openSession({ id: 'booking-dup' })
  session.data.items = [{ name: '深蹲', group: '腿部', sets: 4, reps: 12, weight: '' }]
  const completeBefore = world.counts.complete
  const first = await session.complete()
  // ⚠️ 1.1.9 第 2 轮改了这里的语义（旧断言是 `second === undefined`）：
  //    静默 return undefined 才是真机上"点了没反应、只能再点一次、第二次才成功"的来源。
  //    现在的唯一正确行为是**复用同一条正在执行的链** —— 不静默丢弃这次点击，也不新开第二轮。
  const second = await session.complete()
  assert.strictEqual(second, first, '完成中再次触发必须复用同一条正在执行的链（既不静默丢弃、也绝不开第二轮完课）')
  await first.settled
  assert.equal(world.counts.complete, completeBefore + 1, '连点只允许 1 次完课事务')
  const used = world.students[0].packages[0].used, incomes = world.incomes.length
  // ① 同一 requestId 的重复投递（就是 timeout 后重试走的那条路）：必须直接命中 receipt，
  //    服务端连业务都不再跑一次。
  const usedRequestId = [...world.requestLog].reverse().find(item => item.command === 'completeBooking').requestId
  await adapter.execute('completeBooking', { bookingId: 'booking-dup' }, { requestId: usedRequestId })
  assert.equal(world.counts.complete, completeBefore + 1, '同一 requestId 重放必须命中 receipt，不得再跑一次业务')
  assert.equal(world.students[0].packages[0].used, used, '同一 requestId 重放不得再扣课时')
  assert.equal(world.incomes.length, incomes, '同一 requestId 重放不得再产生 Income')
  // ② 就算有人把「完成中」门禁强行放开再点一次，也**不许静默丢弃**，更不许新开一轮完课。
  //    旧语义的 `undefined` 正是真机上"点了没反应"的来源；新语义必须明确给出结果：
  //    要么「已完成 no-op」，要么「复用既有链」。
  session.data.completing = false
  const doneAgain = await session.complete()
  assert.ok(doneAgain, '云端已 done 时也必须给出明确结果，绝不静默 return undefined')
  assert.ok(doneAgain.noop === true || doneAgain.reused === true,
    '云端已 done 时只能明确回「已完成 no-op」或「复用既有链」，实得 ' + JSON.stringify(doneAgain))
  assert.equal(world.counts.complete, completeBefore + 1, '云端已 done 后再点绝不允许产生第二次完课事务')
  // ③ 再退一步：假设请求真的带着**新的** requestId 打到了服务端，业务层也必须认出「已经完成」，
  //    绝不第二次扣课时、第二次记收入。这是不依赖 requestId 的第二道保险。
  const fresh = await runCommandSilent({ key: 'completeBooking:booking-dup:forced', command: 'completeBooking', payload: { bookingId: 'booking-dup' } })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.alreadyDone, true, '业务层必须识别为已经完成')
  assert.equal(world.students[0].packages[0].used, used, '新 requestId 重放同样不得再扣课时')
  assert.equal(world.incomes.length, incomes, '新 requestId 重放同样不得再产生 Income')
  assert.equal(world.incomes.filter(item => item.bookingId === 'booking-dup').length, 1, '这条课恰好 1 条 Income')
})

scenario('⑫ 训练内容没确认前，绝不完课（flush 失败即中止）', async () => {
  world.bookings.push({ id: 'booking-hold', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-18', hour: 10, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: [], notes: '' })
  const session = openSession({ id: 'booking-hold' })
  session.addExercise({ detail: { name: '硬拉', group: '背部' } })
  resetCounters()
  const mark = world.executedCommands.length
  world.throwNetwork = true                     // 训练内容无法确认
  const handle = await session.complete()
  assert.equal(handle.deferred, true, '第一帧仍然必须立即响应')
  await handle.settled
  assert.equal(world.executedCommands.slice(mark).includes('completeBooking'), false, '训练内容未确认时绝不允许发完课命令')
  const held = pendingDraft.get('sandbox', 'ds-sandbox', 'booking-hold')
  assert.ok(held && held.content.items.length === 1, '本机必须保留最新训练草稿，动作不丢')
  assert.equal(counters.modals.some(modal => String(modal.title).includes('未完成')), true, '必须明确提示未完成')
  assert.equal(snapshot().bookings.find(item => item.id === 'booking-hold').status, 'booked', '云端状态必须保持 booked')
  assert.equal(pendingCompletion.list('sandbox', 'ds-sandbox').length, 0, '中止时必须撤回完成中标记')
  world.throwNetwork = false
})

scenario('⑬ 完课 timeout / unknown：视觉保持已完成、只查 receipt、绝不盲目重发', async () => {
  world.bookings.push({ id: 'booking-tmo', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-21', hour: 12, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: [{ name: '推举', group: '肩', sets: 4, reps: 12, weight: '' }], notes: '' })
  const session = openSession({ id: 'booking-tmo' })
  resetCounters()
  world.throwNetwork = true
  const mark = world.executedCommands.length
  const handle = await session.complete()
  await handle.settled
  assert.equal(world.executedCommands.slice(mark).filter(name => name === 'completeBooking').length, 1, '允许发出一次尝试，但只有一次')
  const marker = pendingCompletion.list('sandbox', 'ds-sandbox')
  assert.equal(marker.length, 1, '结果未知时必须保留完成中标记，不许当失败删掉')
  assert.equal(marker[0].status, 'unknown', '状态必须是 unknown')
  assert.equal(world.counts.getReceipt >= 1, true, '结果未知时必须先查过 receipt，绝不盲目重发')
  assert.equal(counters.modals.some(modal => String(modal.title).includes('待确认')), true, '必须提示结果待确认')
  assert.equal(snapshot().bookings.find(item => item.id === 'booking-tmo').status, 'booked', '不确定时绝不允许把云端写成 done')
  // 结果未知期间，页面按「已完成」呈现，并且不允许再触发完课 —— 用户不会再被引导去重复点击。
  // ⚠️ 1.1.9 第 2 轮：旧断言是 `=== undefined`（静默丢弃这次点击 —— 真机"点了没反应"的来源）。
  //    此刻这门课**还有在途完课意图**（第 472 行那条 unknown 标记），所以唯一正确的出路是
  //    **复用同一条链**：只查回执 + 重同步 + 补复制，**绝不重发 completeBooking**。
  const completeBeforeRetap = world.counts.complete
  const retapWhileUnknown = await session.complete()
  assert.ok(retapWhileUnknown && retapWhileUnknown.reused === true,
    '★ 结果未知期间再点必须复用同一条链（既不静默丢弃这次点击、也绝不开第二轮），实得 ' + JSON.stringify(retapWhileUnknown))
  assert.equal(world.counts.complete, completeBeforeRetap, '★ 复用路径绝不允许再发一条完课命令')
  const used = world.students[0].packages[0].used, incomes = world.incomes.length
  const completeRuns = world.counts.complete
  // ⚠️ 契约变更（第 35 节）：以前「再进来重按一次」是允许的（靠固定 requestId 幂等兜底）。
  // 现在真机验收明确要求：已完成的课再点进去必须就是「已完成课程」，不能重新触发完课前的 flush/complete 链路
  // —— 用户从那条链路里只会拿到一个「训练内容没有在云端确认保存」的误报。
  const reentered = openSession({ id: 'booking-tmo' })
  assert.equal(reentered.data.done, true, '结果未知时再次进入也必须按「已完成」呈现（视觉先完成）')
  assert.equal(reentered.data.completionPending, true, '页面必须知道自己处在「完课结果未落地」的状态')
  const retapReentered = await reentered.complete()
  assert.ok(retapReentered && retapReentered.reused === true,
    '★ 结果未知期间再次进入、再点一次：只能复用同一条链（不得静默丢弃、也不得新开一轮），实得 ' + JSON.stringify(retapReentered))
  assert.equal(world.counts.complete, completeRuns, '★ 绝不允许因为再点一次而多发一次完课命令')
  assert.equal(counters.modals.some(modal => String(modal.title).includes('未完成')), false, '绝不允许弹「训练内容没有在云端确认保存」')
  assert.equal(world.students[0].packages[0].used, used, '未知状态下再点不得再扣课时')
  assert.equal(world.incomes.length, incomes, '未知状态下再点不得再记收入')
  const after = pendingCompletion.list('sandbox', 'ds-sandbox')
  assert.equal(after.length, 1, '仍然只允许有一条完课意图')
  assert.equal(after[0].requestId, marker[0].requestId, '绝不换新号')
  const schedule = openSchedule()
  const cell = cellFor(schedule, '2026-09-21', 12)
  assert.equal(cell.bookings[0].statusLabel, '已完', '结果未知时课表仍按已完成呈现（不是失败、也不是中间状态）')
  assert.equal(cell.bookings[0].completing, undefined, '课表不得再有中间状态像素')
  // 自动路径只能查 receipt：查不到回执（连回执都没有 ⇒ 本轮无法判定）时绝不重发、也绝不把标记当失败删掉。
  await coordinator.resume()
  assert.equal(pendingCompletion.list('sandbox', 'ds-sandbox').length, 1, '自动路径不得把未知当失败删掉标记')
  assert.equal(world.counts.complete, completeRuns, '★ 自动路径绝不允许重发完课命令')
  world.throwNetwork = false
  pendingCompletion.remove('sandbox', 'ds-sandbox', 'booking-tmo', marker[0].requestId)
})

scenario('⑭ Cloud 成功但回读失败：只重新同步，绝不重复完课', async () => {
  world.bookings.push({ id: 'booking-sync', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-19', hour: 11, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: [{ name: '划船', group: '背部', sets: 4, reps: 12, weight: '' }], notes: '' })
  const session = openSession({ id: 'booking-sync' })
  const completeBefore = world.counts.complete
  world.failRefreshFor = 'completeBooking'    // 命令成功，但这次回读刷新失败
  const handle = await session.complete()
  await handle.settled
  assert.equal(world.counts.complete, completeBefore + 1, '回读失败绝不允许再来一次完课命令')
  assert.equal(snapshot().bookings.find(item => item.id === 'booking-sync').status, 'done', '云端事实上必须已经完成')
  assert.equal(world.incomes.filter(item => item.bookingId === 'booking-sync').length, 1, 'Income 仍然恰好 1 条')
  assert.equal(pendingCompletion.list('sandbox', 'ds-sandbox').some(item => item.localKey === 'booking-sync'), false, '重新同步成功后必须清掉标记')
  const after = await flush().then(() => openSession({ id: 'booking-sync' }))
  assert.equal(after.data.done, true, '重新同步后必须看到完成')
})

scenario('⑮ 写冻结 / 离线：既不留标记也不提交', async () => {
  world.online = false
  const session = openSession({ id: 'booking-sync' })
  const before = world.counts.execute
  const result = await coordinator.submit({ ...INPUT, date: '2026-09-20', hour: 8 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'OFFLINE_READ_ONLY')
  assert.equal(tryCount(coordinator.records(), '2026-09-20') , 0, '离线时不允许留下待确认预约')
  assert.equal(world.counts.execute, before)
  world.online = true
  function tryCount(list, date) { return list.filter(item => item.date === date).length }
})

scenario('⑯ Sandbox / Production 完全隔离', async () => {
  const sandboxBindings = pendingBookings.resolveOfficial('sandbox', 'ds-sandbox', KEY)
  assert.ok(sandboxBindings, 'Sandbox 必须有自己的绑定')
  assert.equal(pendingBookings.resolveOfficial('production', 'ds-prod', KEY), null, 'Production 不得看到 Sandbox 的绑定')
  assert.notEqual(pendingBookings.key('sandbox'), pendingBookings.key('production'), '待确认预约必须按环境分键')
  assert.notEqual(pendingCompletion.key('sandbox'), pendingCompletion.key('production'), '完成中标记必须按环境分键')
  assert.notEqual(pendingDraft.key('sandbox'), pendingDraft.key('production'), '训练草稿必须按环境分键')
  assert.equal(pendingCompletion.list('production', 'ds-prod').length, 0)
  assert.equal(pendingDraft.get('production', 'ds-prod', KEY), null)
  const previous = currentEnvironment
  currentEnvironment = 'production'
  const schedule = openSchedule()
  const cell = cellFor(schedule, '2026-09-20', 8)
  assert.equal(cell.bookings.length, 0, 'Production 课表不得出现 Sandbox 的任何内容')
  currentEnvironment = previous
})

scenario('⑰ 静态回归：即时路径不许再出现等待遮罩，安全机制全部在位', async () => {
  const root = path.join(__dirname, '..')
  const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const read = file => stripComments(fs.readFileSync(path.join(root, file), 'utf8'))
  const session = read('pages/session/session.js')
  // 阶段1：静默通道收敛成统一入口的一种策略；「不遮罩、不自动弹窗」的语义一条不变。
  assert.ok(/strategy:\s*mutate\.STRATEGIES\.SILENT/.test(session), '训练草稿必须走静默通道（统一入口的静默策略）')
  assert.equal(session.includes('runCommandSilent('), false, '页面不得再直接调用静默通道')
  // 高频链 = 从 addExercise 往后的全部交互方法（选动作 / 改内容 / 排序 / 保存 / 完课）。
  // 这一段里绝不允许再出现等待遮罩；允许保留显式进度的只有它前面的
  // 「只读诊断」与「安全续跑」——那是用户主动点开的异常恢复流程。
  const chainStart = session.indexOf('addExercise(')
  assert.ok(chainStart > -1, '必须能定位高频链区间')
  assert.equal(session.slice(chainStart).includes('showLoading'), false, '高频链（选动作→改内容→保存→完课）不得出现等待遮罩')
  const loadingSites = session.split('wx.showLoading').length - 1
  assert.equal(loadingSites, 2, '课程详情页只允许「只读诊断」「安全续跑」两处显式进度（多一处就是遮罩回归）')
  assert.ok(session.includes('awaitOfficialBooking('), '未转正时必须等正式 identity，不能编造 bookingId')
  assert.ok(session.includes('flushDraft()'), '完课前必须 flush 训练内容')
  const schedule = read('pages/schedule/schedule.js')
  assert.equal(schedule.includes('showLoading'), false, '课表不得出现等待遮罩')
  assert.ok(schedule.includes('retryPendingBooking('), '待确认预约必须保留幂等重试入口')
  const adapter = read('utils/cloud-primary-adapter.js')
  for (const marker of ['ACTIVE_READ_STALE', 'ACTIVE_READ_INTEGRITY_FAILED', 'COMMAND_RESULT_UNKNOWN', 'REQUEST_PROCESSING', 'expectedRevision', 'getReceipt']) {
    assert.ok(adapter.includes(marker), `adapter 必须保留 ${marker}`)
  }
  assert.ok(adapter.includes("callCloud('coachBusinessCommand'"), '正式命令通道必须保留')
  const runtime = read('utils/data-runtime.js')
  assert.ok(runtime.includes('CLOUD_PRIMARY_DIRECT_WRITE_BLOCKED'), 'Cloud-primary 直接写门禁必须保留')
  assert.ok(runtime.includes('CACHE_ENVIRONMENT_MISMATCH'), '环境隔离必须保留')
  const optimistic = read('utils/booking-optimistic.js')
  assert.equal(/ActiveCache/.test(optimistic), false, '协调器不得触碰 active cache')
  assert.equal(/saveDB/.test(optimistic), false, '协调器不得直接写 coachDB')
  const completion = read('utils/pending-completion.js')
  assert.equal(/ActiveCache/.test(completion), false, '完课标记不得触碰 active cache')
  assert.equal(/saveDB/.test(completion), false, '完课标记不得直接写 coachDB')
  const request = read('utils/pending-booking-request.js')
  assert.equal(/ActiveCache/.test(request), false, '待确认预约不得触碰 active cache')
})

;(async () => {
  for (const item of scenarios) {
    const started = Date.now()
    await item.fn()
    console.log(`  ✓ ${item.name} (${Date.now() - started}ms)`)
  }
  assert.equal(counters.loading, 0, '整条链路都不允许出现等待遮罩（含选动作 / 完课）')
  console.log('session instant chain tests: PASS (booking→enter→exercise→completion all instant; no duplicate booking; package -1 exactly; income exactly 1)')
})().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 }).finally(() => {
  if (oldRuntime) require.cache[runtimePath] = oldRuntime; else delete require.cache[runtimePath]
  if (oldCommand) require.cache[commandPath] = oldCommand; else delete require.cache[commandPath]
})
