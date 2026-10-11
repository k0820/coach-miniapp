// 一条高频主流程的「local-first 交互 / cloud-confirmed 持久化」永久回归：
//   约课秒回（Production 已通过，冻结）
//     → 刚约完立即进入课程
//     → 选择/添加动作秒回
//     → 取消预约秒回
//     → 完成课程秒回
//
// 设计要点：这个测试**加载真实模块**（协调器、四个本机存储模块、session、schedule），
// 只把「云」与「adapter」换成按真实语义实现的假件。这样断言的才是真实现，不是替身。
// 与 session-instant-chain.test.js 的差别：这里的「cache」是独立的一份，只有 readActive 成功
// 才会被刷新 —— 因此可以精确复现「云端已经变了、本机 cache 还是旧的」这类真实窗口期。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
// setData 假件必须与真实微信同口径：支持路径更新（课表刷新只推真的变了的格子）。
const { applyPatch } = require('./helpers/set-data')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const flush = async (rounds = 30) => { for (let i = 0; i < rounds; i++) await delay(1) }

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
  refreshOk: true, failNextRefresh: 0, failRefreshFor: null,
  throwNetwork: false, receiptStatusOnThrow: 'unknown', suspendResume: false, executeDelay: 0,
  cancelFails: false,
  students: [{ id: 'stu-1', name: '假学员', packages: [{ id: 'pkg-1', type: '常规训练', price: 100, used: 0, remaining: 5 }] }],
  bookings: [], incomes: [], customExercises: [],
  receipts: new Map(), ops: [], executedCommands: [], requestLog: [],
  counts: { execute: 0, readActive: 0, getReceipt: 0, create: 0, content: 0, complete: 0, cancel: 0 }
}
const liveSnapshot = () => ({ students: copy(world.students), bookings: copy(world.bookings), incomes: copy(world.incomes), customExercises: copy(world.customExercises) })
// 本机 cache：只有 readActive 成功才刷新。session / schedule 读的都是它（getDB）。
let cache = { datasetId: 'ds-sandbox', students: [], bookings: [], incomes: [], customExercises: [] }
const findPkg = id => world.students[0].packages.find(item => item.id === id)
// 服务端正式 bookingId 由 requestId 确定性生成（真实实现是同一条规矩：generatedBusinessId）。
const deterministicId = requestId => `bk-${String(requestId).replace(/[^a-zA-Z0-9]/g, '').slice(-12)}`

function applyCommand(command, payload, requestId) {
  world.ops.push(command)
  if (command === 'createBooking') {
    world.counts.create++
    const id = deterministicId(requestId)
    if (world.bookings.some(item => item.id === id)) return { ok: true, command, datasetRevision: world.revision, result: { bookingId: id }, alreadyDone: true }
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
  if (command === 'cancelBooking') {
    world.counts.cancel++
    if (world.cancelFails) return { ok: false, code: 'BOOKING_ALREADY_DONE', message: '课程已经完成，不能取消。' }
    const index = world.bookings.findIndex(item => item.id === payload.bookingId)
    if (index < 0) return { ok: false, code: 'BOOKING_NOT_FOUND' }
    // 真实语义：取消会把这行 booking 删掉（课时与收入都不动）。
    world.bookings.splice(index, 1)
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
    if (world.failNextRefresh > 0) { world.failNextRefresh--; return { ok: false, code: 'ACTIVE_READ_INTEGRITY_FAILED' } }
    if (!world.refreshOk) return { ok: false, code: 'ACTIVE_READ_INTEGRITY_FAILED' }
    cache = { ...liveSnapshot(), datasetId: world.datasetId }
    return { ok: true, datasetId: world.datasetId, revision: world.revision }
  },
  // 与真实 adapter.execute 语义一致：命令成功后无条件跑完整 readActive；
  // 抛错时先查 receipt；同 requestId 命中 receipt 直接返回首次结果（幂等，不产生第二条业务结果）。
  async execute(command, payload, options = {}) {
    world.counts.execute++
    world.executedCommands.push(command)
    const requestId = options.requestId
    world.requestLog.push({ command, requestId })
    if (world.executeDelay) await delay(world.executeDelay)
    if (world.throwNetwork) {
      const receipt = await adapter.getReceipt(requestId)
      if (receipt && receipt.found && receipt.status === 'succeeded') { const refreshed = await adapter.readActive(); return { ...copy(receipt.response), recoveredFromReceipt: true, refreshed } }
      if (world.receiptStatusOnThrow === 'processing') return { ok: false, code: 'REQUEST_PROCESSING', requestId }
      return { ok: false, code: 'COMMAND_RESULT_UNKNOWN', requestId }
    }
    const cached = world.receipts.get(requestId)
    const response = cached ? copy(cached.response) : applyCommand(command, payload, requestId)
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
  getDB: () => copy(cache),
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
  readDatasetId: () => cache.datasetId,
  readSnapshot: () => copy(cache),
  // 取消落地后清掉这条预约的训练草稿（否则日后可能被 flush 成一条孤儿 Cloud 内容）。
  onCancelled: (localKey, officialId) => {
    const datasetId = cache.datasetId
    pendingDraft.remove('sandbox', datasetId, `pending:${localKey}`)
    if (officialId) pendingDraft.remove('sandbox', datasetId, officialId)
    if (localKey) pendingDraft.remove('sandbox', datasetId, localKey)
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
    getDB: () => copy(cache), saveDB: () => { throw new Error('CLOUD_PRIMARY_DIRECT_WRITE_BLOCKED') },
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
    cancelBookingRequest: input => coordinator.cancel(input),
    retryPendingCancellation: key => coordinator.retryCancel(key),
    pendingCancellationRecords: () => coordinator.cancelRecords(),
    bindingForOfficialId: officialId => pendingBookings.bindingForOfficialId(currentEnvironment, cache.datasetId, officialId),
    // 与真实 ui-cloud-command 同一份匹配逻辑（都在 pending-completion 真模块里）。
    completionIntentFor: input => pendingCompletion.intentFor(currentEnvironment, cache.datasetId, input && input.officialId, input && input.localKey),
    bookingBindings: () => pendingBookings.listBindings(currentEnvironment, cache.datasetId)
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
const openSession = options => { const page = mount(sessionConfig); page.onLoad(options); page.onShow(); return page }
const openSchedule = () => { const page = mount(scheduleConfig); page.onShow(); return page }
const cellFor = (schedule, date, hour) => { schedule.loadScheduleData(); return schedule.makeCell(date, hour, false) }
const visibleBookings = () => coordinator.mergeBookings(copy(cache.bookings))
const resetCounters = () => { counters.loading = 0; counters.toasts.length = 0; counters.modals.length = 0; counters.navigations.length = 0; counters.back = 0 }

const KEY1 = 'stu-1|pkg-1|2026-09-16|16|0'
const KEY2 = 'stu-1|pkg-1|2026-09-17|9|0'
const KEY3 = 'stu-1|pkg-1|2026-09-18|10|0'
const KEY4 = 'stu-1|pkg-1|2026-09-19|11|0'
const input = (key, over = {}) => {
  const [studentId, packageId, date, hour, minute] = key.split('|')
  return { studentId, studentName: '假学员', packageId, packageIndex: 0, date, hour: +hour, minute: +minute, typeName: '常规训练', price: 100, command: 'createBooking', ...over }
}

const scenarios = []
const scenario = (name, fn) => scenarios.push({ name, fn })

scenario('① 组合：秒回约课 → 立即进课 → 连加动作 → 转正绑定 → 完课一次（1 条 booking / 扣 1 / 1 条 Income / 内容完整）', async () => {
  resetCounters()
  world.suspendResume = true                       // 先卡住页面级 resume，精确复现「块已画、云端未转正」窗口
  const submitted = await coordinator.submit(input(KEY1))
  assert.equal(submitted.ok, true, '预约必须前台即时成功')
  assert.equal(submitted.deferred, true)
  assert.equal(world.counts.execute, 0, '提交瞬间不允许有 Cloud 命令')
  assert.equal(counters.loading, 0, '前台路径不允许出现等待遮罩')
  const schedule = openSchedule()
  const cell = cellFor(schedule, '2026-09-16', 16)
  assert.equal(cell.bookings.length, 1, '课表第一帧就应看到这条预约')
  assert.equal(cell.bookings[0].pending, true, '内部仍是待确认状态')
  assert.equal(copy(cache.bookings).length, 0, '正式 cache 此时还没有这条预约')

  // 刚约完立即进入课程：本机编辑态，用真实业务键，不伪造 bookingId，不发正式命令。
  const before = world.counts.execute
  schedule.booking({ currentTarget: { dataset: { id: cell.bookings[0].id, pending: KEY1 } } })
  assert.equal(counters.navigations.length, 1, '必须能立即进入课程（不允许任何阻断提示）')
  assert.equal(counters.modals.length, 0, '正常路径不允许弹阻断式提示')
  assert.ok(counters.navigations[0].url.includes(`pending=${encodeURIComponent(KEY1)}`))
  const session = openSession({ pending: KEY1 })
  assert.equal(session.id, '', '未转正时不允许有 bookingId')
  assert.equal(session.data.pendingBooking, true)
  assert.equal(world.counts.execute, before, '进入课程不允许产生任何 Cloud 命令')

  // 立即添加多个动作：第一帧就进列表，零 Cloud、零遮罩。
  for (const name of ['高位下拉', '坐姿划船', '杠铃卧推']) session.addExercise({ detail: { name, group: '背部' } })
  session.itemInput({ currentTarget: { dataset: { i: 1, k: 'weight' } }, detail: { value: '45' } })
  assert.deepEqual(session.data.items.map(item => item.name), ['高位下拉', '坐姿划船', '杠铃卧推'], '动作顺序不能乱')
  assert.equal(session.data.items[1].weight, '45', '输入必须落到正确的行')
  assert.equal(world.counts.execute, before, '连加动作期间不允许有任何 Cloud 命令')
  assert.equal(counters.loading, 0, '选动作不允许出现等待遮罩')
  assert.equal(pendingDraft.get('sandbox', 'ds-sandbox', `pending:${KEY1}`).content.items.length, 3, '本机草稿必须跟手')

  // 转正：createBooking 在后台落地，正式身份绑定完成。
  world.suspendResume = false
  await coordinator.resume()
  await flush()
  assert.equal(world.bookings.length, 1, '转正后必须恰好 1 条正式预约')
  const officialId = world.bookings[0].id
  assert.equal(pendingBookings.resolveOfficial('sandbox', 'ds-sandbox', KEY1).officialId, officialId, '必须留下本机身份 → 正式 bookingId 的绑定')
  assert.equal(pendingBookings.list('sandbox', 'ds-sandbox').length, 0, '转正后待确认记录必须清干净')

  session.load()
  assert.equal(session.id, officialId, '同一个页面实例必须就地接到正式 booking 上')
  assert.equal(session.data.items.length, 3, '转正不许丢动作')
  assert.equal(session.data.pendingBooking, false)

  // 完成课程：第一帧立即响应，训练内容先确认、再单次完课事务。
  const handle = await session.complete()
  assert.equal(handle.deferred, true, '完课必须前台即时返回句柄')
  assert.equal(world.counts.complete, 0, '第一帧绝不允许开始完课事务')
  await handle.settled
  await flush()
  assert.equal(world.bookings.length, 1, '全程只允许 1 条 booking')
  assert.equal(world.bookings[0].status, 'done')
  assert.equal(world.bookings[0].items.length, 3, '完课后训练内容必须完整保留')
  assert.equal(world.students[0].packages[0].used, 1, '课时恰好扣 1')
  assert.equal(world.students[0].packages[0].remaining, 4)
  assert.equal(world.incomes.length, 1, 'Income 恰好 1 条')
  assert.equal(world.incomes[0].bookingId, officialId)
  assert.equal(world.counts.complete, 1, '完课事务只允许一次')
  assert.equal(world.counts.cancel, 0, '这条流程里不该出现任何取消')
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox').length, 0, '不许留下取消 tombstone')
  assert.equal(counters.loading, 0, '整条主流程都不许出现等待遮罩')
})

scenario('② 组合：约课秒回后立刻取消（create 尚未发出）→ 零 Cloud、无幽灵、课表不冒出来', async () => {
  resetCounters()
  world.suspendResume = true                          // 卡住页面级 resume，精确保留「记录已写、命令未发」状态
  // 精确复现真实可达状态：待确认记录已持久化，但 create 命令还没发出（提交后的下一个 tick 才发）。
  const started = Date.now()
  pendingBookings.create('sandbox', 'ds-sandbox', KEY2, 'req-never-sent', input(KEY2), {
    id: `pending:${KEY2}`, studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1',
    date: '2026-09-17', hour: 9, minute: 0, typeName: '常规训练', price: 100, status: 'booked', createdAt: started
  }, started)
  const before = world.counts.execute
  const mark = world.executedCommands.length
  const bookingsBefore = world.bookings.length
  const schedule = openSchedule()
  assert.equal(cellFor(schedule, '2026-09-17', 9).bookings.length, 1, '第一帧应看到这条预约')

  const session = openSession({ pending: KEY2 })
  assert.equal(session.data.pendingBooking, true, '刚约完应能进入本机编辑态')
  session.cancel()
  assert.equal(session.data.cancelling, true, '第一帧必须立刻结束编辑态')
  // 取消的第一帧：块当场从课表消失（视图层 tombstone），正式 cache 一个字没改。
  assert.equal(cellFor(openSchedule(), '2026-09-17', 9).bookings.length, 0, '第一帧课表就应该看不见它')
  await delay(2)
  assert.equal(counters.back, 1, '第一帧之后必须立刻回到课表')
  // 关键排序：即使 resume 立刻跑，也绝不允许把一条已经被取消的 create 补发出去。
  await coordinator.resume()
  await flush()
  session.onUnload()                                  // 离页时也不许把内容 flush 出去
  await flush()
  assert.equal(world.counts.execute, before, 'create 尚未发出时取消必须是纯本机操作，零 Cloud 调用')
  const sent = world.executedCommands.slice(mark)
  assert.equal(sent.includes('createBooking'), false, '绝不允许补发 createBooking')
  assert.equal(world.bookings.length, bookingsBefore, '云端本来就没有这条预约（不许凭空多出来）')
  assert.equal(pendingBookings.list('sandbox', 'ds-sandbox').length, 0, '本机待确认记录必须清干净')
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox').length, 0, 'tombstone 必须清干净')
  assert.equal(pendingDraft.get('sandbox', 'ds-sandbox', `pending:${KEY2}`), null, '不许留下孤儿训练草稿')
  assert.equal(sent.includes('updateBookingContent'), false, '取消后绝不允许把草稿写给一条已被取消的课程')
  world.suspendResume = false
  assert.equal(cellFor(openSchedule(), '2026-09-17', 9).bookings.length, 0, '课表绝对不能再冒出来')
})

scenario('③ 组合：约课时立刻取消（create 已在路上）→ create 成功后自动接上 cancel，绝不留下幽灵预约', async () => {
  resetCounters()
  const createBefore = world.counts.create, cancelBefore = world.counts.cancel, incomeBefore = world.incomes.length
  world.executeDelay = 25                              // 让 create 处于「已发出、结果未回」的窗口里
  const submitted = await coordinator.submit(input(KEY3))
  assert.equal(submitted.ok, true)
  await delay(5)                                       // 命令已发出（status: confirming），但还没返回
  assert.equal(pendingBookings.get('sandbox', 'ds-sandbox', KEY3).status, 'confirming', '必须精确复现「create 在路上」窗口')
  const session = openSession({ pending: KEY3 })
  session.cancel()
  assert.equal(cellFor(openSchedule(), '2026-09-18', 10).bookings.length, 0, '第一帧就看不见了')
  assert.equal(world.counts.cancel, cancelBefore, '第一帧绝不允许抢先发 cancelBooking（那时还没有正式 id）')
  world.executeDelay = 0
  await flush(120)
  // create 落地 → 本机立刻把 cancel 接上去 → 云端最终没有这条预约，也不会有幽灵。
  assert.equal(world.counts.create, createBefore + 1, 'create 只允许执行一次')
  assert.equal(world.counts.cancel, cancelBefore + 1, 'cancel 恰好执行一次')
  assert.equal(world.bookings.some(item => item.studentId === 'stu-1' && item.date === '2026-09-18' && item.hour === 10), false, '云端最终不允许留下这条预约（否则就是幽灵）')
  assert.equal(pendingBookings.list('sandbox', 'ds-sandbox').length, 0, '本机待确认记录必须清干净')
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox').length, 0, 'tombstone 必须清干净')
  assert.equal(pendingDraft.get('sandbox', 'ds-sandbox', `pending:${KEY3}`), null, '不许留下孤儿训练草稿')
  assert.equal(cellFor(openSchedule(), '2026-09-18', 10).bookings.length, 0, '课表绝对不能再冒出来')
  assert.equal(world.incomes.length, incomeBefore, '取消不会产生任何收入')
})

scenario('④ 正式预约取消：第一帧消失 + 云端恰好一次 + tombstone 清除', async () => {
  resetCounters()
  world.bookings.push({ id: 'bk-official', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-19', hour: 11, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: [], notes: '' })
  world.revision++
  await adapter.readActive()
  const session = openSession({ id: 'bk-official' })
  const before = world.counts.execute, cancelBefore = world.counts.cancel, incomeBefore = world.incomes.length
  const cacheBefore = copy(cache.bookings).length
  session.cancel()
  assert.equal(session.data.cancelling, true, '第一帧必须立刻结束编辑态')
  assert.equal(cellFor(openSchedule(), '2026-09-19', 11).bookings.length, 0, '第一帧课表就应该看不见它')
  assert.equal(world.counts.execute, before, '第一帧不允许等 Cloud 事务')
  assert.equal(copy(cache.bookings).length, cacheBefore, '正式 cache 一个字都不许改（只写本机 tombstone）')
  await delay(2)
  assert.equal(counters.back, 1, '第一帧之后必须立刻回到课表')
  await flush()
  assert.equal(world.counts.cancel, cancelBefore + 1, '取消只允许执行一次')
  assert.equal(world.bookings.some(item => item.id === 'bk-official'), false, '云端这条预约必须已经没了')
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox').length, 0, '确认后 tombstone 必须清除')
  assert.equal(cellFor(openSchedule(), '2026-09-19', 11).bookings.length, 0, '课表保持为空档')
  assert.equal(world.incomes.length, incomeBefore, '取消不会产生任何收入')
})

scenario('⑤ 取消明确失败：撤回 tombstone，块原样回来并说明原因', async () => {
  resetCounters()
  world.bookings.push({ id: 'bk-fail', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-20', hour: 9, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: [], notes: '' })
  world.revision++
  await adapter.readActive()
  world.cancelFails = true
  const session = openSession({ id: 'bk-fail' })
  session.cancel()
  assert.equal(cellFor(openSchedule(), '2026-09-20', 9).bookings.length, 0, '第一帧仍然必须立刻消失')
  await flush()
  world.cancelFails = false
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox').length, 0, '明确失败必须撤回 tombstone')
  assert.equal(cellFor(openSchedule(), '2026-09-20', 9).bookings.length, 1, '块必须原样回来')
  assert.equal(world.bookings.some(item => item.id === 'bk-fail'), true, '云端这条预约必须还在')
  assert.equal(counters.modals.some(modal => String(modal.title).includes('取消未生效')), true, '必须明确提示取消未生效')
})

scenario('⑥ 连点取消：只执行一次，绝不重复取消', async () => {
  resetCounters()
  world.bookings.push({ id: 'bk-dup', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-21', hour: 14, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: [], notes: '' })
  world.revision++
  await adapter.readActive()
  const session = openSession({ id: 'bk-dup' })
  const mark = world.executedCommands.length
  const cancelBefore = world.counts.cancel
  session.cancel()
  session.cancel()                                    // 第二下必须被门禁挡住
  session.cancelOnly()                                // 从取消面板再来一次
  const duplicate = await coordinator.cancel({ localKey: pendingBookings.bookingKey(world.bookings.find(item => item.id === 'bk-dup') || { studentId: 'stu-1', packageId: 'pkg-1', date: '2026-09-21', hour: 14, minute: 0 }), officialId: 'bk-dup' })
  assert.equal(duplicate.duplicate, true, '重复取消必须复用已有记录，不重开一轮')
  await flush()
  assert.equal(world.counts.cancel, cancelBefore + 1, '连点只允许 1 次取消事务')
  assert.equal(world.executedCommands.slice(mark).filter(name => name === 'cancelBooking').length, 1, '命令层也只允许出现一次 cancelBooking')
  assert.equal(world.bookings.some(item => item.id === 'bk-dup'), false)
})

scenario('⑦ 取消 timeout / unknown：保留 tombstone、只查 receipt、绝不盲目重发', async () => {
  resetCounters()
  // ★ 闸门（同场景⑨）：`openSession` / `openSchedule` 都会走页面 onShow → `resumePendingBookings()`，
  //   起一轮**没有被 await** 的 resume。它会与本场景下面两次显式 `coordinator.resume()` 抢同一条取消，
  //   被 in-flight 守卫挡掉的那一次就白跑了（断言看的是"这一轮发了什么"）。这里只关页面自动通道。
  world.suspendResume = true
  world.bookings.push({ id: 'bk-tmo', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-22', hour: 15, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: [], notes: '' })
  world.revision++
  await adapter.readActive()
  world.throwNetwork = true
  const session = openSession({ id: 'bk-tmo' })
  session.cancel()
  await flush()
  const marker = pendingCancellations.list('sandbox', 'ds-sandbox')
  assert.equal(marker.length, 1, '结果未知时必须保留 tombstone，不许当失败删掉')
  assert.equal(marker[0].status, 'unknown')
  assert.equal(cellFor(openSchedule(), '2026-09-22', 15).bookings.length, 0, '不确定期间块继续隐藏，不当成失败')
  assert.equal(counters.modals.some(modal => String(modal.title).includes('待确认')), false, '网络不稳时不应再弹出难懂的技术确认框')
  assert.equal(counters.toasts.some(toast => String(toast.title).includes('稍后自动核对')), true, '应以轻提示说明系统会自动核对')
  const mark = world.requestLog.length
  // ★ 1.1.9 第 7 轮：云端**明确没有**这条 requestId（收据与业务写在同一事务里 ⇒ 这是权威结论）
  //   时，自动恢复允许用**同一个号**补发。修前这里是"永不重发"，于是"响应丢一次"就等于
  //   "这条取消永远上不了云"，而 tombstone 永远留在本机（用户以为取消了，另一台设备永远看得到）。
  //   号不变 ⇒ 服务端仍把它认作同一次请求，不可能变成两条取消。
  //   ⚠️ 边界一个字没改：**查回执失败**（真断网 / 传输抛错）时只能等，绝不重发 ——
  //      见 cancellation-cold-start.test.js 里那条 `receiptOk = false` 的断言。
  await coordinator.resume()
  await flush()
  const autoResent = world.requestLog.slice(mark).filter(item => item.command === 'cancelBooking')
  assert.equal(autoResent.length, 1, '云端明确未受理 ⇒ 自动恢复必须原号补发（不许永远不上云）')
  assert.equal(autoResent[autoResent.length - 1].requestId, marker[0].requestId, '补发必须沿用同一个固定 requestId')
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox')[0].requestId, marker[0].requestId, '必须沿用同一个固定 requestId')
  assert.equal(cellFor(openSchedule(), '2026-09-22', 15).bookings.length, 0, '不确定期间块继续隐藏，不当成失败')
  // 用户主动重试：先查 receipt；确认云端从未受理（found:false）才用**同一个** requestId 补发 —— 幂等，不是新单据。
  const attempt = await coordinator.retryCancel(marker[0].localKey)
  await flush()
  assert.equal(attempt.code === 'RECEIPT_RESULT_UNKNOWN' || attempt.code === 'REQUEST_PROCESSING' || attempt.code === 'COMMAND_RESULT_UNKNOWN', true, '重试只允许拿到「结果仍未定」')
  const resent = world.requestLog.slice(-1)[0]
  assert.equal(resent.command, 'cancelBooking', '主动重试才允许补发')
  assert.equal(resent.requestId, marker[0].requestId, '补发必须复用同一个 requestId，绝不换新号')
  world.throwNetwork = false
  // 云端其实成功了、只是回执丢了：用同一个 requestId 查 receipt 就能确认，不需要再取消一次。
  world.bookings = world.bookings.filter(item => item.id !== 'bk-tmo')
  world.receipts.set(marker[0].requestId, { status: 'succeeded', response: { ok: true, command: 'cancelBooking', datasetRevision: world.revision } })
  const afterRetry = world.executedCommands.length
  await coordinator.resume()
  await flush()
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox').length, 0, 'receipt 确认成功后 tombstone 必须清除')
  assert.equal(world.executedCommands.length, afterRetry, '有 receipt 证据时绝不允许再发一次取消')
  assert.equal(cellFor(openSchedule(), '2026-09-22', 15).bookings.length, 0, '云端已经没有它，课表保持空档')
  world.suspendResume = false
})

scenario('⑧ 取消成功后回读失败：stale cache 不能把已取消的块带回来，且绝不重复取消', async () => {
  resetCounters()
  world.bookings.push({ id: 'bk-sync', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-23', hour: 16, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: [], notes: '' })
  world.revision++
  await adapter.readActive()
  world.failRefreshFor = 'cancelBooking'              // 命令成功，但这一次回读刷新失败
  world.refreshOk = false                             // 后续重试回读也先失败
  const cancelBefore = world.counts.cancel
  const session = openSession({ id: 'bk-sync' })
  session.cancel()
  await flush()
  assert.equal(world.counts.cancel, cancelBefore + 1, '回读失败绝不允许再来一次取消命令')
  assert.equal(world.bookings.some(item => item.id === 'bk-sync'), false, '云端事实上已经取消')
  assert.equal(copy(cache.bookings).length >= 1, true, '本机 cache 仍是旧值（典型 stale cache）')
  assert.equal(cellFor(openSchedule(), '2026-09-23', 16).bookings.length, 0, 'stale cache 绝不能把已取消的块带回来')
  const marker = pendingCancellations.list('sandbox', 'ds-sandbox')
  assert.equal(marker.length, 1, '回读未完成前必须保留 tombstone')
  assert.equal(marker[0].status, 'syncing')
  world.failRefreshFor = null
  world.refreshOk = true
  await coordinator.resume()                          // 只重新同步，不重发命令
  await flush()
  assert.equal(world.counts.cancel, cancelBefore + 1, '自愈过程中同样不允许重复取消')
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox').length, 0, '同步成功后 tombstone 清除')
  assert.equal(copy(cache.bookings).some(item => item.id === 'bk-sync'), false, 'cache 终于追上了云端')
  assert.equal(cellFor(openSchedule(), '2026-09-23', 16).bookings.length, 0)
})

scenario('⑨ 杀进程重进（resume）：create 结果未定 → 只等不重发；create 已落地 → 自动补上取消', async () => {
  resetCounters()
  // ★ 闸门（测试自身的确定性，不是产品行为）：下面 `cellFor(openSchedule(), …)` 会让课表页走
  //   onShow → `mutate.resumePendingBookings()`，在协调器里起一轮**没有被 await** 的 resume。
  //   那一轮只要还在途，本场景后面那次显式 `coordinator.resume()` 就会被 in-flight 守卫挡掉
  //   （同一条取消绝不允许被并发推进两次 —— 守卫本身是对的），于是整个场景变成"看运气"。
  //   这里只关掉**页面那条自动通道**，然后照旧显式调 `coordinator.resume()` —— 被测的东西一个字没变。
  world.suspendResume = true
  // A. create 命令发出过，但服务端从未受理（receipt 不存在）→ 只能等，不许补发 create、也不许发 cancel。
  pendingBookings.create('sandbox', 'ds-sandbox', KEY4, 'req-lost', input(KEY4), {
    id: `pending:${KEY4}`, studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1',
    date: '2026-09-19', hour: 11, minute: 0, typeName: '常规训练', price: 100, status: 'booked', createdAt: Date.now()
  }, Date.now())
  pendingBookings.patch('sandbox', 'ds-sandbox', KEY4, 'req-lost', { status: 'confirming' })
  pendingCancellations.begin('sandbox', 'ds-sandbox', KEY4, '', () => 'req-cancel-lost', input(KEY4), Date.now())
  const before = world.counts.execute
  const cancelBefore = world.counts.cancel
  await coordinator.resume()
  await flush()
  assert.equal(world.counts.execute, before, 'create 结果未定时绝不允许补发任何命令')
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox').length, 1, 'tombstone 必须继续有效（块一直隐藏）')
  assert.equal(cellFor(openSchedule(), '2026-09-19', 11).bookings.length, 0, '不许因为重启就把已取消的块画回来')

  // B. 再进来一次，这次 create 其实已经在云端成功（receipt succeeded）→ 必须自动把取消补上。
  const officialId = deterministicId('req-lost')
  world.bookings.push({ id: officialId, studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-19', hour: 11, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: [], notes: '' })
  world.revision++
  world.receipts.set('req-lost', { status: 'succeeded', response: { ok: true, command: 'createBooking', datasetRevision: world.revision, result: { bookingId: officialId } } })
  await coordinator.resume()
  await flush()
  assert.equal(world.counts.cancel, cancelBefore + 1, 'create 已落地时必须自动补上一次取消')
  assert.equal(world.bookings.some(item => item.id === officialId), false, '最终云端不允许留下这条预约')
  assert.equal(pendingBookings.list('sandbox', 'ds-sandbox').length, 0, '本机待确认记录清干净')
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox').length, 0, 'tombstone 清干净')
  assert.equal(cellFor(openSchedule(), '2026-09-19', 11).bookings.length, 0, '课表不冒出来')
  world.suspendResume = false
})

scenario('⑩ 写冻结 / 离线：不创建 tombstone 也不提交', async () => {
  resetCounters()
  world.bookings.push({ id: 'bk-off', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-24', hour: 17, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: [], notes: '' })
  world.revision++
  await adapter.readActive()
  world.online = false
  const before = world.counts.execute
  const result = await coordinator.cancel({ localKey: 'stu-1|pkg-1|2026-09-24|17|0', officialId: 'bk-off', booking: { studentId: 'stu-1', packageId: 'pkg-1', date: '2026-09-24', hour: 17, minute: 0 } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'OFFLINE_READ_ONLY')
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox').length, 0, '离线时不允许留下 tombstone')
  assert.equal(world.counts.execute, before)
  world.online = true
  assert.equal(cellFor(openSchedule(), '2026-09-24', 17).bookings.length, 1, '离线时块必须还在')
})

scenario('⑪ Sandbox / Production 完全隔离', async () => {
  resetCounters()
  pendingCancellations.begin('sandbox', 'ds-sandbox', 'iso-key', 'iso-official', () => 'iso-req', input(KEY1), Date.now())
  assert.equal(pendingCancellations.get('sandbox', 'ds-sandbox', 'iso-key').requestId, 'iso-req')
  assert.equal(pendingCancellations.list('production', 'ds-prod').length, 0, 'Production 不得看到 Sandbox 的取消记录')
  assert.notEqual(pendingCancellations.key('sandbox'), pendingCancellations.key('production'), '取消记录必须按环境分键')
  assert.equal(pendingCancellations.viewIndex('production', 'ds-prod').payloads.length, 0)
  assert.equal(pendingCancellations.viewIndex('sandbox', 'ds-sandbox').payloads.length, 1)
  // Production 环境下的课表不得因为 Sandbox 的 tombstone 而隐藏任何东西。
  const previous = currentEnvironment
  currentEnvironment = 'production'
  const prodIds = new Set(pendingCancellations.viewIndex('production', 'ds-prod').officialIds)
  assert.equal(prodIds.has('iso-official'), false)
  currentEnvironment = previous
  pendingCancellations.remove('sandbox', 'ds-sandbox', 'iso-key', 'iso-req')
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox').length, 0)
})

scenario('⑫ 取消在飞时不能立刻重约同一时段（同一把业务键不许叠两条操作）', async () => {
  resetCounters()
  const KEY5 = 'stu-1|pkg-1|2026-09-25|18|0'
  world.bookings.push({ id: 'bk-rebook', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-25', hour: 18, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: [], notes: '' })
  world.revision++
  await adapter.readActive()
  world.executeDelay = 30                             // 让取消停在「已发出、结果未回」
  const session = openSession({ id: 'bk-rebook' })
  session.cancel()
  await delay(5)
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox').length, 1, '取消必须已经在飞')
  const before = world.counts.execute
  const resubmit = await coordinator.submit(input(KEY5))
  assert.equal(resubmit.ok, false, '同一时段在取消落定前不允许再约')
  assert.equal(resubmit.code, 'CANCELLATION_IN_PROGRESS')
  assert.equal(world.counts.execute, before, '被拦住时绝不允许发出任何命令')
  assert.equal(pendingBookings.get('sandbox', 'ds-sandbox', KEY5), null, '绝不允许留下第二条待确认记录')
  assert.equal(cellFor(openSchedule(), '2026-09-25', 18).bookings.length, 0, '时段保持空档，不许出现重复块')
  world.executeDelay = 0
  const cancelBefore = world.counts.cancel
  await flush(120)
  assert.equal(world.counts.cancel, cancelBefore + 1, '取消照常落地，且只执行一次')
  assert.equal(world.bookings.some(item => item.id === 'bk-rebook'), false, '原预约已取消')
  assert.equal(pendingCancellations.list('sandbox', 'ds-sandbox').length, 0, 'tombstone 清干净')
  // 取消落定之后，同一时段可以正常重新预约（不许被永久锁住）。
  const again = await coordinator.submit(input(KEY5))
  assert.equal(again.ok, true, '取消落定后必须能重新约')
  await flush(60)
  assert.equal(world.bookings.filter(item => item.date === '2026-09-25').length, 1, '重新约之后云端恰好 1 条')
  assert.equal(cellFor(openSchedule(), '2026-09-25', 18).bookings.length, 1, '课表恰好 1 块')
})

scenario('⑬ 静态回归：即时路径不许再出现等待遮罩，取消链路不许碰正式 cache', async () => {
  const root = path.join(__dirname, '..')
  const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const read = file => stripComments(fs.readFileSync(path.join(root, file), 'utf8'))
  const session = read('pages/session/session.js')
  const cancelAt = session.indexOf('  cancel(){')
  assert.ok(cancelAt > -1, '必须能找到取消入口')
  const cancelBody = session.slice(cancelAt, session.indexOf('\n  },', cancelAt))
  assert.equal(cancelBody.includes('showLoading'), false, '取消路径不得出现等待遮罩')
  // 阶段1：取消统一经由 mutate.js 出口；该出口把 cancelBooking 派给既有 local-first 协调器，语义一条不变。
  assert.ok(cancelBody.includes('mutate.cancelBooking('), '取消必须走统一写入口')
  assert.equal(cancelBody.includes('cancelBookingRequest('), false, '页面不得再直接触碰协调器')
  assert.strictEqual(require('../utils/mutate').OPTIMISTIC_COMMANDS.cancelBooking, 'cancel', 'cancelBooking 必须由统一入口派给取消协调器')
  // 取消第一帧必须回到课表。断言「统一出口」而不是直接调 wx.navigateBack ——
  // 自动返回已收敛到 returnToSchedule()（一个页面实例只执行一次），
  // 钉字面调用会把「重构到统一出口」误判成回归。
  assert.ok(cancelBody.includes('returnToSchedule('), '取消第一帧必须回到课表（统一出口 returnToSchedule）')
  assert.equal(/(^|[^a-zA-Z])mutate\.isCloudWritePath\(\)/.test(cancelBody), true, '必须保留本地模式分支（数据源判断只允许走统一入口）')
  assert.equal(/(^|[^a-zA-Z])isCloudPrimary\(\)/.test(cancelBody), false, '页面不得自己判断数据源')
  assert.ok(session.includes('cancelling'), '必须有 cancelling 门禁，防止离页把内容 flush 成孤儿记录')
  const schedule = read('pages/schedule/schedule.js')
  assert.equal(schedule.includes('showLoading'), false, '课表不得出现等待遮罩')
  assert.ok(schedule.includes("session?pending="), '待确认块必须能直接进入本机编辑态')
  assert.ok(schedule.includes("status==='unknown'||status==='syncing'"), '只有结果未知才允许给说明出口')
  const cancellation = read('utils/pending-cancellation.js')
  assert.equal(/ActiveCache/.test(cancellation), false, '取消记录不得触碰 active cache')
  assert.equal(/saveDB/.test(cancellation), false, '取消记录不得直接写 coachDB')
  const optimistic = read('utils/booking-optimistic.js')
  assert.equal(/ActiveCache/.test(optimistic), false, '协调器不得触碰 active cache')
  assert.equal(/saveDB/.test(optimistic), false, '协调器不得直接写 coachDB')
  const adapter = read('utils/cloud-primary-adapter.js')
  for (const marker of ['ACTIVE_READ_STALE', 'ACTIVE_READ_INTEGRITY_FAILED', 'COMMAND_RESULT_UNKNOWN', 'REQUEST_PROCESSING', 'expectedRevision', 'getReceipt']) {
    assert.ok(adapter.includes(marker), `adapter 必须保留 ${marker}`)
  }
  assert.ok(adapter.includes("callCloud('coachBusinessCommand'"), '正式命令通道必须保留')
  const runtime = read('utils/data-runtime.js')
  assert.ok(runtime.includes('CLOUD_PRIMARY_DIRECT_WRITE_BLOCKED'), 'Cloud-primary 直接写门禁必须保留')
  assert.ok(runtime.includes('CACHE_ENVIRONMENT_MISMATCH'), '环境隔离必须保留')
  const draft = read('utils/pending-training-draft.js')
  assert.ok(draft.includes('function remove('), '训练草稿必须支持删除（取消后不留孤儿内容）')
})

;(async () => {
  for (const item of scenarios) {
    const started = Date.now()
    await item.fn()
    console.log(`  ✓ ${item.name} (${Date.now() - started}ms)`)
  }
  assert.equal(counters.loading, 0, '整条链路都不允许出现等待遮罩')
  console.log('local-first interaction tests: PASS (booking→enter→exercise→cancel→complete all instant; 1 booking; package -1 exactly; income exactly 1; no ghost booking)')
})().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 }).finally(() => {
  if (oldRuntime) require.cache[runtimePath] = oldRuntime; else delete require.cache[runtimePath]
  if (oldCommand) require.cache[commandPath] = oldCommand; else delete require.cache[commandPath]
})
