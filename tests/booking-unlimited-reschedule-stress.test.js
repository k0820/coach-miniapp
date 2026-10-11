// 【永久回归 · 正式业务规则】预约 / 取消 / 重新预约 / 改时间 —— **业务操作次数没有人为上限**。
//
// 规则（用户 2026-09-25 正式提出，写进 PROJECT_MEMORY.md §89）：
//   会员可能不断改时间：
//     预约 A → 取消 A → 预约 B → 取消 B → 预约 C → 取消 C → …… → 预约 D
//   第 1 次、第 10 次、第 30 次、第 100 次都必须照常允许；只要这一次操作本身合法就必须放行。
//   最终状态**以最后一次成功的业务操作为准**：A/B/C 全部无效、D 唯一有效、无幽灵、无旧时间占用。
//
//   ⚠️ **技术重试 ≠ 业务次数**（本文件把这条钉死）：
//     CONVERGE_MAX_HOPS / READ_ATTEMPTS / MAX_SEND_ATTEMPTS / CANCEL_TARGET_PROBES /
//     CANCEL_CONFLICT_ROUNDS / CANCEL_GATE_MS / delayMs / MAX_WINDOW 全部是
//     「一次读取 / 一次发送 / 一条队列条目」内部的**有界**预算，
//     它们的计数器分别挂在 requestId / entryId / 单条 tombstone 上，
//     **绝不**挂在「这个时段」「这个会员」「今天」上 ⇒ 不可能变成"用户只能取消 3 次"。
//
// 本文件做什么：连续 30 轮「预约 → 取消 → 重新预约」，混合
//   ① 同一时间换会员 ② 同一会员换时间 ③ 换日期 ④ 换 package
//   ⑤ 完全相同的业务键再来一次（专测"旧 tombstone / 旧 idMap 会不会挡住后来人"）
//   ⑥ 取消后立即重新预约（不等待） ⑦ 快速连续操作（中间完全不 drain）
// 第 30 轮之后再做一次最终预约 D，然后验证 14 条最终不变量。
//
// 与 `cancel-then-book-ordering.test.js` 同一套口径：只替换「云」（假 adapter，与真服务端逐条同形）
// 与 ui-cloud-command 门面，其余全部是真模块（coordinator / pending-cancellation / local-projection /
// local-outbox / mutate / sync-engine）。
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const PROJ = path.join(__dirname, '..')
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const settle = async (rounds = 12) => { for (let i = 0; i < rounds; i++) await delay(1) }

const DATASET = 'ds-stress'
const ROUNDS = 30

// ---------------------------------------------------------------- Storage / wx
const store = {}
const ui = { toasts: [], modals: [], calls: [] }
global.wx = {
  getStorageSync: key => copy(store[key]),
  setStorageSync: (key, value) => { store[key] = copy(value) },
  removeStorageSync: key => { delete store[key] },
  showToast: options => ui.toasts.push(options),
  showModal: options => ui.modals.push(options),
  showLoading() {}, hideLoading() {}, showTabBar() {}, hideTabBar() {},
  nextTick: task => setTimeout(task, 0),
  navigateTo() {}, navigateBack() {}, setClipboardData: options => { if (options && options.success) options.success({}) },
  getNetworkType: options => options.success({ networkType: 'wifi' }),
  onNetworkStatusChange() {},
  createSelectorQuery: () => ({ selectAll: () => ({ boundingClientRect: () => ({ exec() {} }) }) }),
  cloud: { callFunction: () => Promise.resolve({ result: { ok: false, code: 'NOT_USED' } }) }
}

// ---------------------------------------------------------------- 「云」
const cloud = {
  revision: 11,
  memoryRevision: 11,
  students: [
    { id: 'stu-A', name: '甲学员', packages: [{ id: 'pkg-A1', type: '常规训练', price: 100, used: 0, remaining: 50 }, { id: 'pkg-A2', type: '拉伸恢复', price: 120, used: 0, remaining: 50 }] },
    { id: 'stu-B', name: '乙学员', packages: [{ id: 'pkg-B1', type: '常规训练', price: 100, used: 0, remaining: 50 }] },
    { id: 'stu-C', name: '丙学员', packages: [{ id: 'pkg-C1', type: '常规训练', price: 100, used: 0, remaining: 50 }] }
  ],
  bookings: [],
  receipts: new Map(),
  applied: [],        // 每一次真正落库的写（顺序 = 云端看到的顺序）
  rejections: [],     // 每一次被云端拒绝的写（业务拒绝不留 receipt，见 core.js）
  sequence: 0,
  online: true
}
const slotOf = row => Number(row.hour) * 60 + Number(row.minute || 0)
const overlaps = (row, moment) => row.date === moment.date && Math.abs(slotOf(row) - slotOf(moment)) < 60
function writeCache() {
  store.coachCloudActiveCache = {
    environment: 'production', datasetId: DATASET, revision: cloud.revision,
    checksum: `chk${cloud.revision}`, byteSize: JSON.stringify(cloud.bookings).length,
    snapshot: { students: copy(cloud.students), bookings: copy(cloud.bookings), incomes: [], customExercises: [] }
  }
}
const cloudState = () => ({ students: copy(cloud.students), bookings: copy(cloud.bookings), incomes: [], customExercises: [], settings: {} })

store.coachDataSourceMode = 'cloud-primary'
store.coachCloudCutoverState = { status: 'cloud-primary' }
cloud.bookings = []
writeCache()

const adapter = {
  getState: () => ({ datasetId: DATASET, revision: cloud.memoryRevision }),
  resetState() {},
  async readActive() {
    ui.calls.push({ name: 'readActive' })
    if (!cloud.online) return { ok: false, code: 'OFFLINE_CACHE_MISSING' }
    cloud.memoryRevision = cloud.revision
    writeCache()
    return { ok: true, environment: 'production', datasetId: DATASET, revision: cloud.revision, checksum: `chk${cloud.revision}`, byteSize: 1, snapshot: cloudState() }
  },
  async getReceipt(requestId) {
    ui.calls.push({ name: 'getReceipt', requestId })
    const hit = cloud.receipts.get(requestId)
    if (!hit) return { ok: true, found: false }
    return { ok: true, found: true, status: hit.status, response: copy(hit.response) }
  },
  async execute(command, payload, options = {}) {
    const requestId = options.requestId
    if (!cloud.online) return { ok: false, code: 'OFFLINE_READ_ONLY' }
    // 与真 adapter 同口径：本机内存态没有 revision 时，命令在**出网之前**就被拒。
    if (!Number.isInteger(cloud.memoryRevision)) return { ok: false, code: 'REVISION_UNKNOWN' }
    ui.calls.push({ name: 'execute', command, payload: copy(payload), requestId })
    const existing = cloud.receipts.get(requestId)
    if (existing) return copy(existing.response)      // 幂等：同号不产生第二条业务
    let result
    if (command === 'cancelBooking') {
      const hit = cloud.bookings.find(row => row.id === payload.bookingId)
      if (!hit) result = { ok: false, code: 'BOOKING_NOT_FOUND' }
      else if (hit.status !== 'booked') result = { ok: false, code: 'BOOKING_STATUS_INVALID' }
      else {
        cloud.bookings = cloud.bookings.filter(row => row.id !== payload.bookingId)
        cloud.revision += 1
        cloud.applied.push({ command, payload: copy(payload), requestId, at: cloud.sequence++ })
        result = { ok: true, result: { bookingId: payload.bookingId, cancelled: true }, datasetRevision: cloud.revision }
      }
    } else if (command === 'createBooking') {
      if (cloud.bookings.some(row => overlaps(row, payload))) result = { ok: false, code: 'BOOKING_TIME_CONFLICT' }
      else {
        const id = `bk-${String(cloud.sequence).padStart(3, '0')}-${payload.studentId}`
        cloud.bookings.push({
          id, studentId: payload.studentId, studentName: '学员', packageId: payload.packageId,
          date: payload.date, hour: payload.hour, minute: Number(payload.minute || 0),
          typeName: '常规训练', price: 100, status: 'booked'
        })
        cloud.revision += 1
        cloud.applied.push({ command, payload: copy(payload), requestId, at: cloud.sequence++, bookingId: id })
        result = { ok: true, result: { bookingId: id }, datasetRevision: cloud.revision }
      }
    } else result = { ok: false, code: 'COMMAND_NOT_ALLOWED' }
    if (result.ok) {
      cloud.receipts.set(requestId, { status: 'succeeded', response: copy(result) })
      cloud.memoryRevision = cloud.revision
      // 与 1.1.9 第 6 轮之后的真 adapter 同形：写成功只给一跳只读校验，不顺手做完整回读。
      return { ...copy(result), confirmed: { ok: true } }
    }
    cloud.rejections.push({ command, code: result.code, requestId })
    return copy(result)
  }
}

// ---------------------------------------------------------------- ui-cloud-command 门面
const ACTIVE = { coordinator: null }
const uiPath = require.resolve(path.join(PROJ, 'utils', 'ui-cloud-command.js'))
require.cache[uiPath] = {
  id: uiPath, filename: uiPath, loaded: true,
  exports: {
    get adapter() { return adapter },
    isCloudPrimary: () => true,
    isCloudWritable: () => cloud.online,
    setOnline: value => { cloud.online = value !== false },
    switchEnvironment: async () => ({ ok: false, code: 'NOT_USED' }),
    runCommand: async () => ({ ok: false, code: 'NOT_USED' }),
    runCommandSilent: async () => ({ ok: false, code: 'NOT_USED' }),
    operationId: key => `op_${key}`,
    clearPending() {},
    submitBooking: async () => ({ ok: false, code: 'NOT_USED' }),
    cancelBookingRequest: input => ACTIVE.coordinator.cancel(input),
    retryPendingCancellation: key => ACTIVE.coordinator.retryCancel(key),
    advancePendingCancellations: input => ACTIVE.coordinator.advanceCancellations(input),
    resumePendingBookings: () => ACTIVE.coordinator.resume(),
    pendingBookingRecords: () => [],
    mergePendingBookings: list => list,
    subscribePendingBookings: () => () => {},
    notifyPendingBookings() {},
    pendingCancellationRecords: () => ACTIVE.coordinator.cancelRecords(),
    officialIdForBooking: key => ACTIVE.coordinator.officialIdFor(key),
    awaitOfficialBooking: key => ACTIVE.coordinator.awaitOfficial(key),
    bindingForOfficialId: () => null,
    bookingBindings: () => [],
    getTimings: () => [], setTimingSink() {},
    __writeFunnel: { enter() {}, exit() {} },
    __assertWriteFunnel() {}
  }
}

// ---------------------------------------------------------------- 真模块
const runtime = require(path.join(PROJ, 'utils', 'data-runtime'))
const mutate = require(path.join(PROJ, 'utils', 'mutate'))
const outbox = require(path.join(PROJ, 'utils', 'local-outbox'))
const projection = require(path.join(PROJ, 'utils', 'local-projection'))
const cancellation = require(path.join(PROJ, 'utils', 'pending-cancellation'))
const pending = require(path.join(PROJ, 'utils', 'pending-booking-request'))
const sync = require(path.join(PROJ, 'utils', 'sync-engine'))
const { createBookingOptimistic } = require(path.join(PROJ, 'utils', 'booking-optimistic'))

const SCOPE = { environment: 'production', datasetId: DATASET }
let requestSeq = 0
const coordinator = createBookingOptimistic({
  runtime, pending, cancellation, adapter,
  isOnline: () => cloud.online,
  newRequestId: () => `req-s${++requestSeq}`,
  readDatasetId: () => DATASET,
  readSnapshot: () => { const cache = wx.getStorageSync(runtime.cacheKey()); return cache && cache.snapshot },
  showToast: options => ui.toasts.push(options),
  showModal: options => ui.modals.push(options)
})
ACTIVE.coordinator = coordinator

// ---------------------------------------------------------------- 30 轮的排期（混合五种变化）
const STUDENT_CYCLE = ['stu-A', 'stu-B', 'stu-C']
const PKGS = { 'stu-A': ['pkg-A1', 'pkg-A2'], 'stu-B': ['pkg-B1'], 'stu-C': ['pkg-C1'] }
const nextStudent = id => STUDENT_CYCLE[(STUDENT_CYCLE.indexOf(id) + 1) % STUDENT_CYCLE.length]

const PLAN = [null]
for (let i = 1; i <= ROUNDS; i++) {
  const prev = PLAN[i - 1] || { date: '2026-09-24', hour: 10, minute: 0, studentId: 'stu-A', packageId: 'pkg-A1', kind: 'seed' }
  const mode = i % 4
  if (mode === 0 && i >= 4) {
    // ⑤ **完全相同的业务键**再来一次 —— 专测"旧的 tombstone / idMap / 绑定会不会挡住后来人"
    PLAN[i] = { ...PLAN[i - 3], kind: 'exact-repeat' }
  } else if (mode === 1) {
    // ① 同一时间换会员
    PLAN[i] = { ...prev, studentId: nextStudent(prev.studentId), packageId: PKGS[nextStudent(prev.studentId)][0], kind: 'same-slot-change-member' }
  } else if (mode === 2) {
    // ② 同一会员换时间
    PLAN[i] = { ...prev, hour: 9 + (i % 6), kind: 'same-member-change-time' }
  } else {
    // ③ 换日期
    PLAN[i] = { ...prev, date: prev.date === '2026-09-24' ? '2026-09-25' : '2026-09-24', kind: 'change-date' }
  }
  // ④ 换 package（只有该学员有第二个课时包时才真的换，否则保持原样）
  if (i % 7 === 0) {
    const list = PKGS[PLAN[i].studentId] || []
    if (list.length > 1 && list.indexOf(PLAN[i].packageId) < 0) PLAN[i] = { ...PLAN[i], packageId: list[0] }
    else if (list.length > 1) PLAN[i] = { ...PLAN[i], packageId: list[1], kind: 'change-package' }
  }
}
// ⑦ 快速连续操作：这两轮内部**完全不 drain**（连续两次"取消 → 预约"背靠背）
const FAST = new Set([10, 20])
// ⑥ 取消后立即重新预约：偶数轮先等它落云再取消（会员改时间），奇数轮**不等**直接取消（最难的那一档）
const waitForLand = i => i % 2 === 0
const FINAL = { studentId: 'stu-B', packageId: 'pkg-B1', date: '2026-09-26', hour: 15, minute: 0 }
// `kind` 只是本文件的分类标签，绝不能混进业务载荷（云端 requireOnly 会因为它判 INVALID_PAYLOAD）。
const payloadOf = plan => ({ studentId: plan.studentId, packageId: plan.packageId, date: plan.date, hour: plan.hour, minute: plan.minute || 0 })

// ---------------------------------------------------------------- 工具
async function drainUntil(limit = 80) {
  for (let i = 0; i < limit; i++) {
    await sync.flush()
    await coordinator.resume()
    await settle(4)
    if (outbox.openEntries(SCOPE).length === 0 && cancellation.list('production', DATASET).length === 0) return true
    // settled 条目要等「本机 cache 追上」才免费出队（§86）：模拟一次后台自然刷新。
    if (i % 6 === 5) await adapter.readActive()
  }
  return false
}
const liveIds = () => cloud.bookings.map(row => row.id)
const createdRows = () => cloud.applied.filter(row => row.command === 'createBooking')
const cancelledRows = () => cloud.applied.filter(row => row.command === 'cancelBooking')

async function run() {
  // ============================================================ 30 轮
  const metrics = []          // 每轮：云调用次数 / 耗时 / 收尾后的本机残留
  const failures = []         // 任何一次"没被允许"的业务操作都记在这里
  const createOps = []        // 每一次"预约"操作（用来逐条核对它的最终下落）
  let live = null

  for (let i = 1; i <= ROUNDS; i++) {
    const plan = PLAN[i]
    const startedAt = Date.now()
    const from = ui.calls.length

    // 上一轮留下的那条：先取消（⑥ 取消后立即重新预约 —— 与下面的 create 之间没有任何等待）
    if (live) {
      if (waitForLand(i)) {
        await drainUntil()
        // 偶数轮：这一条已经落云 ⇒ 正式 id 本机就有（真实场景里"会员过一会儿才改时间"就是这一档）
        const landed = cloud.bookings.find(row => pending.bookingKey(row) === live.key)
        live.officialId = landed ? landed.id : ''
      }
      const cancelled = await coordinator.cancel({ booking: payloadOf(live), officialId: live.officialId || '' })
      if (!cancelled || cancelled.ok !== true) failures.push({ round: i, step: 'cancel', result: cancelled })
    }

    const created = await mutate('createBooking', payloadOf(plan), { key: `k-r${i}` })
    if (process.env.STRESS_TRACE) console.error(`[r${i}] ${plan.kind} create ok=${created && created.ok} dup=${created && created.duplicate} req=${created && created.requestId}`)
    if (!created || created.ok !== true) failures.push({ round: i, step: 'create', result: created, plan })
    createOps.push({ round: i, requestId: created && created.requestId, kind: plan.kind, fast: false })
    const key = pending.bookingKey(payloadOf(plan))
    live = { ...payloadOf(plan), key }

    if (FAST.has(i)) {
      // ⑦ 快速连续：本轮第一条先落云，然后**背靠背**「取消 → 预约」，中间一次都不 drain
      //    （第二条因此可能"还没出网就被取消" —— 那是合法结局②，不是被吞掉）
      await drainUntil()
      const cancelled = await coordinator.cancel({ booking: payloadOf(plan) })
      if (!cancelled || cancelled.ok !== true) failures.push({ round: i, step: 'fast-cancel', result: cancelled })
      const fastPlan = { ...payloadOf(plan), hour: plan.hour + 1 }
      const again = await mutate('createBooking', fastPlan, { key: `k-r${i}f` })
      if (!again || again.ok !== true) failures.push({ round: i, step: 'fast-create', result: again })
      createOps.push({ round: i, requestId: again && again.requestId, kind: plan.kind + '/fast', fast: true })
      live = { ...fastPlan, key: pending.bookingKey(fastPlan) }
    }

    if (!FAST.has(i)) await drainUntil()
    metrics.push({
      round: i, kind: plan.kind,
      cloudCalls: ui.calls.slice(from).length,
      ms: Date.now() - startedAt,
      // 收尾之后的本机残留（**有界**才说明没有随轮数累积）
      openOutbox: outbox.openEntries(SCOPE).length,
      tombstones: cancellation.list('production', DATASET).length,
      pendings: pending.list('production', DATASET).length
    })
  }

  // ★ 1. 30 轮全部允许执行 —— 没有任何一次被"次数上限"挡回来
  assert.deepEqual(failures, [], '★ 30 轮里出现被拒绝的业务操作（这就是隐藏次数上限）：' + JSON.stringify(failures))
  if (process.env.STRESS_TRACE) {
    console.error('applied: ' + JSON.stringify(cloud.applied.map(row => ({ c: row.command, p: row.payload, id: row.result && row.result.bookingId })), null, 0))
    console.error('rejections: ' + JSON.stringify(cloud.rejections))
    console.error('failed: ' + JSON.stringify(outbox.failed(SCOPE).map(row => ({ command: row.command, code: row.code || (row.result && row.result.code) }))))
  }
  // ★ 2. 没有隐藏次数上限：**逐条**核对每一次预约的下落。
  //
  //   一条预约只有两种合法结局：
  //     ① 出网了 ⇒ 必须真的落库（被任何"次数上限"吞掉都会在这里变红）；
  //     ② 还没离开本机就被取消了 ⇒ 云端从来没有过它（零云调用、不可能有幽灵，这是既有设计）。
  //   除了这两种之外没有第三种 —— "允许执行但最后无声无息消失"就是隐藏上限。
  const executedIds = new Set(ui.calls.filter(call => call.name === 'execute').map(call => call.requestId))
  const landedIds = new Set(createdRows().map(row => row.requestId))
  createOps.forEach(op => {
    if (executedIds.has(op.requestId)) {
      assert.ok(landedIds.has(op.requestId),
        `★ 第 ${op.round} 轮（${op.kind}）的预约已经出网却没有落库 —— 这就是被吞掉的那一条：${op.requestId}`)
    }
  })
  // ★ 3. 非"快速连续"的每一轮都必须真的落到云端 —— 操作次数增加**不许**改变结果（第 1 轮和第 30 轮同等对待）
  createOps.filter(op => !op.fast).forEach(op => {
    assert.ok(landedIds.has(op.requestId),
      `★ 第 ${op.round} 轮（${op.kind}）的预约必须真的落到云端：第 1 轮能落、第 ${op.round} 轮也必须能落`)
  })
  // ★ 4. 全程**零**云端拒绝：没有 BOOKING_TIME_CONFLICT、没有 BOOKING_NOT_FOUND、没有重复创建
  assert.deepEqual(cloud.rejections, [],
    '★ 30 轮里出现云端拒绝（冲突 / 找不到 / 状态不对 / 重复）：' + JSON.stringify(cloud.rejections))
  // ★ 5. 出网的命令必须一次一条、绝不重复（幂等号唯一 ⇒ 云端不可能多出业务）
  assert.equal(createdRows().length, new Set(createdRows().map(row => row.requestId)).size,
    '★ 落库的预约条数必须等于不同的幂等号数量（同号重放绝不能变成两条业务）')

  // ============================================================ 第 30 轮之后再做一次最终预约 D
  await drainUntil()
  const cancelledLast = await coordinator.cancel({ booking: payloadOf(live), officialId: live.officialId || '' })
  assert.equal(cancelledLast.ok, true, '★ 第 30 轮之后仍必须允许取消：' + JSON.stringify(cancelledLast))
  const finalCreate = await mutate('createBooking', { ...FINAL }, { key: 'k-final' })
  assert.equal(finalCreate.ok, true, '★ 第 30 轮之后仍必须允许最终预约 D：' + JSON.stringify(finalCreate))
  assert.equal(await drainUntil(), true, '★ 最终预约必须能自己收尾（outbox 与 tombstone 都要清空）')

  // ============================================================ 最终不变量
  const tag = '30 轮之后'
  // ① 最终只有最后一次预约有效
  assert.equal(cloud.bookings.length, 1, `${tag}：★ 云端必须恰好 1 条有效预约，实得 ${liveIds().join(',')}`)
  const finalId = cloud.bookings[0].id
  assert.equal(cloud.bookings[0].studentId, FINAL.studentId, `${tag}：★ 有效的必须是最终那条 D`)
  assert.equal(cloud.bookings[0].date, FINAL.date, `${tag}：★ D 的日期必须正确`)
  assert.equal(Number(cloud.bookings[0].hour), FINAL.hour, `${tag}：★ D 的时间必须正确`)
  // ② 所有旧预约均无效（云端真的删掉了，不是"藏起来"）
  assert.equal(createdRows().length, cancelledRows().length + 1,
    `${tag}：★ 每一条旧预约都必须被真的取消（create 数 = cancel 数 + 1）`)
  const cancelledIds = cancelledRows().map(row => row.payload.bookingId)
  assert.equal(new Set(cancelledIds).size, cancelledIds.length, `${tag}：★ 一条预约不许被取消两次`)
  assert.ok(cancelledIds.indexOf(finalId) < 0, `${tag}：★ 最终那条 D 不许被取消`)
  createdRows().forEach(row => { if (row.result && row.result.bookingId === finalId) assert.ok(true) })
  if (process.env.STRESS_TRACE) {
    console.error('alive: ' + JSON.stringify(cloud.bookings))
    console.error('created: ' + JSON.stringify(allCreated))
    console.error('cancelled: ' + JSON.stringify(cancelledIds))
  }
  // ③ 无幽灵预约 / 旧预约复活：云端活着的那些 id 必须恰好等于「所有创建 - 所有取消」
  const allCreated = createdRows().map(row => row.bookingId).filter(Boolean)
  assert.deepEqual(liveIds().slice().sort(), allCreated.filter(id => cancelledIds.indexOf(id) < 0).sort(),
    `${tag}：★ 云端活着的集合必须恰好等于「创建过且没被取消」的集合（无幽灵、无复活）`)
  // ④ 无错误时间冲突（已在上面 rejections 里钉死，这里再钉一次便于定位）
  assert.equal(cloud.rejections.filter(row => row.code === 'BOOKING_TIME_CONFLICT').length, 0,
    `${tag}：★ 不许出现 BOOKING_TIME_CONFLICT（旧 tombstone 不许阻止后续预约）`)
  // ⑤ outbox 清空 / ⑥ pending cancellation 清理
  assert.equal(outbox.openEntries(SCOPE).length, 0, `${tag}：★ outbox 必须清空`)
  assert.equal(outbox.failed(SCOPE).length, 0, `${tag}：★ 不许有任何一条被归档成"业务失败"`)
  assert.equal(cancellation.list('production', DATASET).length, 0, `${tag}：★ 取消 tombstone 必须清空`)
  assert.equal(pending.list('production', DATASET).length, 0, `${tag}：★ 待确认预约必须清空`)
  // ⑦ idMap / 绑定最终一致
  const map = outbox.idMap(SCOPE)
  const officialIds = Object.keys(map).map(local => map[local])
  assert.ok(officialIds.indexOf(finalId) >= 0, `${tag}：★ 最终那条 D 的正式 id 必须能从本机 idMap 反查到`)
  const bindings = pending.listBindings('production', DATASET)
  assert.equal(bindings.filter(row => row.officialId === finalId).length, bindings.length,
    `${tag}：★ 残留绑定不许指向已经被取消的预约`)
  // ⑧ 本机最终事实层 = 云端最终事实层
  const db = runtime.getDB()
  assert.equal(db.bookings.length, 1, `${tag}：★ 本机必须恰好 1 条预约，实得 ${db.bookings.map(row => row.id).join(',')}`)
  assert.equal(db.bookings[0].id, finalId, `${tag}：★ 本机那条必须是 D`)
  assert.equal(db.bookings.filter(row => row.date === '2026-09-24' || row.date === '2026-09-25').length, 0,
    `${tag}：★ 本机不得残留任何旧日期的预约（旧时间不许复活）`)
  // ⑨ 30 轮里**每一次**收尾之后本机残留都必须是有界的（不许随轮数累积）
  const worst = metrics.reduce((acc, row) => Math.max(acc, row.openOutbox, row.tombstones, row.pendings), 0)
  assert.ok(worst <= 3, `${tag}：★ 本机残留必须有界（不随轮数累积），实得最大 ${worst}`)
  // 快速连续那两轮刻意不 drain ⇒ 允许留 1 条正在飞行的 tombstone；其余每一轮收尾后必须归零。
  // （tombstone 是"块隐藏"的唯一依据，它**永久**留在那儿就会永久挡住那个时段 —— 这就是"卡死"的形状。）
  assert.equal(metrics.filter(row => !FAST.has(row.round) && row.tombstones > 0).length, 0,
    `${tag}：★ 每一轮收尾之后都不许残留 tombstone（否则它会永久挡住那个时段）：`
    + JSON.stringify(metrics.filter(row => !FAST.has(row.round) && row.tombstones > 0).map(row => row.round)))
  // ⑩ 无线性恶化：每轮的云调用次数不随轮数增长（用同类型轮次前后段对比，排除"等落云/不等落云"的固有差异）
  const kindGroups = {}
  metrics.forEach(row => { (kindGroups[row.kind] = kindGroups[row.kind] || []).push(row.cloudCalls) })
  Object.keys(kindGroups).forEach(kind => {
    const list = kindGroups[kind]
    if (list.length < 4) return
    const head = list.slice(0, Math.ceil(list.length / 3))
    const tail = list.slice(-Math.ceil(list.length / 3))
    const avg = arr => arr.reduce((sum, value) => sum + value, 0) / arr.length
    assert.ok(avg(tail) <= avg(head) * 2 + 2,
      `${tag}：★「${kind}」这一类操作的云调用次数不许随轮数增长（前段 ${avg(head).toFixed(1)} → 后段 ${avg(tail).toFixed(1)}）`)
  })

  // ============================================================ 静态契约：把"技术重试 ≠ 业务次数"钉死
  {
    const optimistic = fs.readFileSync(path.join(PROJ, 'utils', 'booking-optimistic.js'), 'utf8')
    const pendingSource = fs.readFileSync(path.join(PROJ, 'utils', 'pending-booking-request.js'), 'utf8')
    const cancelSource = fs.readFileSync(path.join(PROJ, 'utils', 'pending-cancellation.js'), 'utf8')
    const syncSource = fs.readFileSync(path.join(PROJ, 'utils', 'sync-engine.js'), 'utf8')
    const adapterSource = fs.readFileSync(path.join(PROJ, 'utils', 'cloud-primary-adapter.js'), 'utf8')
    // 每条**新的**预约 / 取消，重试预算都必须从 0 开始（否则"总共只能发 N 次"就会变成业务上限）
    assert.ok(/attempt:\s*0/.test(pendingSource), '★ 新的一条待确认预约必须 attempt:0（预算逐条重置，不是全局计数）')
    assert.ok(/attempt:\s*0/.test(cancelSource), '★ 新的一条取消 tombstone 必须 attempt:0（预算逐条重置）')
    // MAX_SEND_ATTEMPTS 只能拿来比"这一条记录自己的 attempt"
    assert.ok(/Number\(entry\.attempt \|\| 0\) < MAX_SEND_ATTEMPTS/.test(optimistic), '★ 发送上限必须挂在单条记录上')
    assert.ok(/Number\(record\.attempt \|\| 0\) >= MAX_SEND_ATTEMPTS/.test(optimistic), '★ 取消的发送上限也必须挂在单条 tombstone 上')
    assert.ok(!/MAX_SEND_ATTEMPTS/.test(syncSource), '★ 同步引擎不许复用"单条预约的发送上限"（它自己用的是逐条 attempts + 退避）')
    // 收敛跳数只属于**一次读取**
    assert.ok(/CONVERGE_MAX_HOPS/.test(adapterSource) && /hops >= CONVERGE_MAX_HOPS/.test(adapterSource),
      '★ 收敛跳数必须是"一次下拉内部"的预算')
    assert.ok(/CANCEL_GATE_MS/.test(syncSource) && /CANCEL_CONFLICT_ROUNDS/.test(syncSource),
      '★ 排序门必须同时有"时间界"与"轮次界"，且都挂在单条队列条目上')
  }

  const times = metrics.map(row => row.ms).sort((a, b) => a - b)
  const p50 = times[Math.floor(times.length / 2)]
  console.log(`booking unlimited reschedule stress: PASS (${ROUNDS} 轮 + 最终预约｜`
    + `云端 ${createdRows().length} 次预约 / ${cancelledRows().length} 次取消 / 拒绝 ${cloud.rejections.length} 次｜`
    + `最终云端 ${cloud.bookings.length} 条 = D｜每轮云调用 min ${times.length ? Math.min(...metrics.map(r => r.cloudCalls)) : 0}`
    + ` / max ${Math.max(...metrics.map(row => row.cloudCalls))}｜每轮耗时 p50 ${p50}ms / max ${times[times.length - 1]}ms)`)
}

run().catch(error => { console.error(error); process.exitCode = 1 })
