// 预约「前台即时响应 + 后台云端安全确认」自动回归。
// 假网络 / 假 adapter / 真实 pending 存储 + 真实协调器。不访问任何真实 CloudBase 或真实 coachDB。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const flush = async (rounds = 10) => { for (let i = 0; i < rounds; i++) await delay(1) }
// 静态断言前必须先剥注释，否则会命中说明文字（踩过的坑）。
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const store = new Map()
global.wx = {
  getStorageSync: key => store.has(key) ? clone(store.get(key)) : undefined,
  setStorageSync: (key, value) => { store.set(key, clone(value)) },
  showToast() {}, showModal() {}
}
const pending = require('../utils/pending-booking-request')
const cancellation = require('../utils/pending-cancellation')
const { createBookingOptimistic } = require('../utils/booking-optimistic')

const MODES = { LOCAL: 'local-primary', ACTIVATING: 'activating', PENDING: 'cutover-pending', CLOUD: 'cloud-primary' }
const PENDING_KEY = 'coachPendingBookingRequests:production'
const PENDING_KEY_SANDBOX = 'coachPendingBookingRequests:sandbox'

const input = (over = {}) => ({
  command: 'createBooking', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', packageIndex: 0,
  date: '2026-09-16', hour: 16, minute: 0, typeName: '常规训练', price: 100, ...over
})

function resetAll() { store.clear() }
let requestCounter = 0

function makeWorld(options = {}) {
  const world = {
    environment: options.environment || 'production',
    cutover: options.cutover || MODES.CLOUD,
    online: options.online !== false,
    datasetByEnv: { production: options.productionDataset || 'ds-p', sandbox: options.sandboxDataset || 'ds-s' },
    revision: options.revision === undefined ? 4 : options.revision,
    bookings: options.bookings ? clone(options.bookings) : [],
    counts: { execute: 0, readActive: 0, getReceipt: 0, metadata: 0, pages: 0, integrity: 0 },
    executedRequestIds: [],
    receipts: new Map(),
    receiptStatus: options.receiptStatus || 'unknown',
    executeThrows: !!options.executeThrows,
    executeDelay: options.executeDelay || 0,
    executeResult: options.executeResult ? clone(options.executeResult) : null,
    refreshOk: options.refreshOk !== false,
    timings: [], toasts: [], modals: []
  }
  const runtime = {
    MODES,
    environment: () => world.environment,
    cutoverState: () => ({ status: world.cutover }),
    cacheKey: () => world.environment === 'sandbox' ? 'coachSandboxActiveCache' : 'coachCloudActiveCache',
    getDB: () => ({ students: [], bookings: clone(world.bookings), incomes: [], sales: [], settings: {}, customExercises: [] })
  }
  let seq = 0
  const adapter = {
    getState: () => ({ datasetId: world.datasetByEnv[world.environment], revision: world.revision }),
    // 与 cloud-primary-adapter.readActive 一致：metadata + 八集合 page + integrity 共 10 个 RPC，一个都不能少。
    async readActive() {
      world.counts.readActive++
      if (!world.refreshOk) return { ok: false, code: 'ACTIVE_READ_INTEGRITY_FAILED' }
      world.counts.metadata++; world.counts.pages += 8; world.counts.integrity++
      if (!Number.isInteger(world.revision)) world.revision = 4
      return { ok: true, environment: world.environment, datasetId: world.datasetByEnv[world.environment], revision: world.revision }
    },
    // 与 cloud-primary-adapter.execute 一致：命令成功后无条件跑完整 readActive；抛错时查 receipt。
    async execute(command, payload, opts) {
      world.counts.execute++
      world.executedRequestIds.push(opts.requestId)
      if (world.executeDelay) await delay(world.executeDelay)
      if (world.executeThrows) {
        const explicit = world.receipts.get(opts.requestId)
        const status = explicit ? explicit.status : world.receiptStatus
        if (status === 'succeeded') { const refreshed = await adapter.readActive(); return { ok: true, recoveredFromReceipt: true, refreshed } }
        if (status === 'failed') return { ok: false, code: 'COMMAND_FAILED' }
        if (status === 'processing') return { ok: false, code: 'REQUEST_PROCESSING', requestId: opts.requestId, retrySafe: true }
        return { ok: false, code: 'COMMAND_RESULT_UNKNOWN', requestId: opts.requestId, retrySafe: true }
      }
      if (!Number.isInteger(world.revision)) return { ok: false, code: 'REVISION_UNKNOWN' }
      const outcome = world.executeResult || { ok: true }
      if (!outcome.ok) return outcome
      world.bookings.push({
        id: `booking-server-${world.bookings.length + 1}`, studentId: payload.studentId, packageId: payload.packageId,
        date: payload.date, hour: payload.hour, minute: payload.minute || 0, typeName: '常规训练', price: 100, status: 'booked'
      })
      world.revision += 1
      const result = { ok: true, command, requestId: opts.requestId, datasetRevision: world.revision }
      const refreshed = await adapter.readActive()
      return refreshed.ok ? { ...result, refreshed } : { ...result, refreshFailed: refreshed }
    },
    async getReceipt(id) {
      world.counts.getReceipt++
      const explicit = world.receipts.get(id)
      if (explicit) return { ok: true, found: true, ...clone(explicit) }
      if (world.receiptStatus === 'unknown') return { ok: true, found: false }
      return { ok: true, found: true, status: world.receiptStatus, response: { ok: true } }
    }
  }
  const optimistic = createBookingOptimistic({
    runtime, pending, adapter,
    isOnline: () => world.online,
    // 与正式实现一致：requestId 全局唯一，绝不跨设备/跨会话复用。
    newRequestId: () => `req-${++requestCounter}`,
    readDatasetId: () => world.datasetByEnv[world.environment] || '',
    readSnapshot: () => runtime.getDB(),
    onTiming: entry => world.timings.push(entry),
    showToast: options => world.toasts.push(options),
    showModal: options => world.modals.push(options),
    // 取消协调器只在显式开启时注入：默认不注入 ⇒ canCancel=false ⇒ 既有场景行为零变化。
    ...(options.withCancellation ? { cancellation } : {})
  })
  world.adapter = adapter
  world.optimistic = optimistic
  world.runtime = runtime
  return world
}

const scenarios = []
const scenario = (name, fn) => scenarios.push({ name, fn })

// ① 提交瞬间乐观预约出现，零 Cloud 等待
scenario('提交瞬间乐观预约出现，前台零 Cloud 调用', async () => {
  const world = makeWorld()
  let renders = 0
  world.optimistic.subscribe(() => { renders++ })
  const started = Date.now()
  const result = await world.optimistic.submit(input())
  const elapsed = Date.now() - started
  assert.equal(result.ok, true)
  assert.equal(result.deferred, true)
  assert.ok(elapsed < 60, `前台路径必须是本机同步写入，实际 ${elapsed}ms`)
  assert.equal(world.counts.execute, 0, '前台返回时不得已经发出 Cloud Command')
  assert.equal(world.counts.readActive, 0, '前台返回时不得已经发生 active read')
  assert.equal(world.counts.getReceipt, 0)
  assert.ok(renders >= 1, '必须通知视图层重绘')
  const records = world.optimistic.records()
  assert.equal(records.length, 1)
  assert.equal(records[0].pending, true)
  assert.equal(records[0].pendingStatus, 'pending', '内部必须仍能区分待确认 / 结果未知 / 同步中')
  assert.equal(records[0].pendingLabel, '提交中')
  assert.equal(records[0].id, `pending:${pending.bookingKey(input())}`)
  assert.equal(records[0].pendingKey, pending.bookingKey(input()))
  // 稳定渲染 key：转正后正式记录会沿用同一个 key，节点不重建 → 不闪、不重新出现
  assert.equal(records[0].viewKey, `stable:${pending.bookingKey(input())}`)
  // 旧本地版的即时反馈：点完立刻「已约 16:00」。云端确认成功时不得再播报一次，
  // 否则用户会从后到的提示里读出「现在才算成功」，秒回体感就没了。
  assert.ok(world.toasts.some(item => item.title === '已约 16:00'), '前台必须立刻给出与旧本地版相同的「已约」反馈')
  // 视图层合并出 1 条，而正式 getDB() 仍然 0 条
  assert.equal(world.optimistic.mergeBookings(world.runtime.getDB().bookings).length, 1)
  assert.equal(world.runtime.getDB().bookings.length, 0, 'getDB 绝不能看到待确认预约')
})

// ② ③ 成功后只剩 1 条正式预约：不重复、不残影
scenario('Cloud 成功后只剩 1 条正式预约，不重复不残影', async () => {
  const world = makeWorld()
  await world.optimistic.submit(input())
  await flush()
  assert.equal(world.counts.execute, 1)
  assert.equal(world.counts.readActive, 1, '命令成功后必须跑一次完整 active read')
  assert.equal(world.counts.metadata, 1)
  assert.equal(world.counts.pages, 8)
  assert.equal(world.counts.integrity, 1)
  assert.equal(world.counts.metadata + world.counts.pages + world.counts.integrity, 10, '完整性 10 个 RPC 一个都不能少')
  assert.equal(world.optimistic.records().length, 0, '成功后待确认块必须消失')
  assert.equal(pending.list('production', 'ds-p').length, 0)
  assert.equal(world.bookings.length, 1)
  const merged = world.optimistic.mergeBookings(world.bookings)
  assert.equal(merged.length, 1, '不得出现两条')
  assert.equal(merged[0].id, world.bookings[0].id)
  assert.ok(!merged[0].pending)
  // 成功路径必须静默：不能再播报「已保存」，否则等于告诉用户「现在才成功」。
  assert.equal(world.toasts.some(item => item.title === '已保存'), false, '云端确认成功时不得二次播报')
})

// ②b 转正那一帧：cache 已有正式记录、本机标记还没清 —— 不得出现两条，也不得重建节点
scenario('转正窗口：正式记录接管待确认块的渲染 key，不重复、不闪烁', async () => {
  const world = makeWorld({ refreshOk: false }) // 命令成功但回读失败 → 本机标记保留
  await world.optimistic.submit(input())
  await flush()
  const key = pending.bookingKey(input())
  assert.equal(world.optimistic.records().length, 1, '此时本机标记仍在')
  assert.equal(world.optimistic.records()[0].pendingStatus, 'syncing')
  // cache 里还没有这条记录（回读没成功）→ 视图层只渲染待确认块
  const onlyPending = world.optimistic.mergeBookings([])
  assert.equal(onlyPending.length, 1)
  assert.equal(onlyPending[0].pending, true, '转正前渲染的是待确认记录')
  assert.equal(onlyPending[0].viewKey, `stable:${key}`)
  // 转正那一刻：cache 里出现这条正式记录，而本机标记还在（真实存在的中间窗口）
  // 注意这里共用一个 slot：正是要验证「同一条预约不得渲染成两条」。
  const after = world.optimistic.mergeBookings(world.bookings)
  assert.equal(after.length, 1, '同一条预约在转正窗口绝不能渲染成两条（重复课程块）')
  assert.equal(after[0].id, world.bookings[0].id, '接管的必须是正式记录')
  assert.ok(!after[0].pending, '转正后不得再带待确认标记')
  assert.equal(after[0].viewKey, `stable:${key}`, '转正必须沿用同一个渲染 key，否则节点被销毁重建（用户看到闪一下 / 重新出现）')
})

// ④ 同 key 连点：只 1 个 pending、1 个 requestId、1 次 execute
scenario('同 key 连点只生成 1 个 pending / 1 个 requestId / 1 次 execute', async () => {
  const world = makeWorld({ executeDelay: 25 })
  const first = await world.optimistic.submit(input())
  const second = await world.optimistic.submit(input())
  const third = await world.optimistic.submit(input())
  assert.equal(second.duplicate, true)
  assert.equal(third.duplicate, true)
  assert.equal(second.requestId, first.requestId)
  assert.equal(third.requestId, first.requestId)
  assert.equal(world.optimistic.records().length, 1, '连点期间只能有 1 个待确认块')
  await flush(60)
  assert.equal(world.counts.execute, 1, '只允许发出一次 Cloud Command')
  assert.deepEqual(world.executedRequestIds, [first.requestId])
  assert.equal(world.bookings.length, 1)
  assert.equal(world.optimistic.records().length, 0)
})

// ⑤ 明确失败精确撤回
scenario('业务拒绝（时段重叠 / 课时不足）精确撤回并提示', async () => {
  for (const [code, message] of [['BOOKING_TIME_CONFLICT', '该时段与其他课程重叠。'], ['PACKAGE_NO_REMAINING', '指定课时包剩余课时不足。']]) {
    resetAll()
    const world = makeWorld({ executeResult: { ok: false, code, message } })
    await world.optimistic.submit(input())
    await flush()
    assert.equal(world.optimistic.records().length, 0, `${code} 必须精确撤回`)
    assert.equal(pending.list('production', 'ds-p').length, 0)
    assert.equal(world.bookings.length, 0)
    assert.equal(world.counts.execute, 1)
    assert.equal(world.counts.readActive, 0, '命令被拒时不得触发回读')
    assert.ok(world.modals.some(item => item.title === '预约未生效' && item.content.includes(message)), `${code} 必须明确提示用户`)
  }
})

// ⑥ timeout / processing：保持确认中，不盲目重发
scenario('timeout / processing 保持「确认中」且绝不重发', async () => {
  for (const status of ['unknown', 'processing']) {
    resetAll()
    const world = makeWorld({ executeThrows: true, receiptStatus: status })
    await world.optimistic.submit(input())
    await flush()
    assert.equal(world.optimistic.records().length, 1, `${status}: 必须保留待确认块`)
    assert.equal(world.optimistic.records()[0].pendingLabel, '待确认')
    assert.equal(world.counts.execute, 1)
    assert.ok(world.modals.some(item => item.title === '结果待确认'))
    const executed = world.counts.execute
    await world.optimistic.resume()
    assert.equal(world.counts.execute, executed, `${status}: resume 绝不能重发命令`)
    assert.equal(world.optimistic.records().length, 1)
    assert.ok(world.counts.getReceipt >= 1, '必须用同一个 requestId 查 receipt')
  }
})

// ⑦ 同 requestId 重试幂等：receipt succeeded 直接确认，不新增
scenario('receipt succeeded 直接确认（同 requestId 幂等，不新增）', async () => {
  const world = makeWorld({ executeThrows: true, receiptStatus: 'unknown' })
  await world.optimistic.submit(input())
  await flush()
  const requestId = world.executedRequestIds[0]
  assert.equal(world.optimistic.records().length, 1)
  world.bookings.push({ id: 'booking-server-1', studentId: 'stu-1', packageId: 'pkg-1', date: '2026-09-16', hour: 16, minute: 0, typeName: '常规训练', price: 100, status: 'booked' })
  world.receipts.set(requestId, { status: 'succeeded', response: { ok: true } })
  const executed = world.counts.execute
  await world.optimistic.resume()
  assert.equal(world.counts.execute, executed, 'receipt 已成功时不得再发命令')
  assert.equal(world.optimistic.records().length, 0, '确认后必须清掉本机标记')
  assert.equal(world.bookings.length, 1, '不得新增第二条预约')
  assert.equal(pending.list('production', 'ds-p').length, 0)
})

// ⑧ 旧 cache 不能覆盖新状态
scenario('待确认预约绝不写入 active cache / coachDB', async () => {
  const world = makeWorld()
  await world.optimistic.submit(input())
  await flush()
  const keys = [...store.keys()]
  assert.ok(keys.includes(PENDING_KEY), '只能写本机待确认 key')
  assert.ok(!keys.some(item => item.indexOf('ActiveCache') >= 0), '不得写任何 active cache')
  assert.ok(!keys.includes('coachDBClosed'), '不得写 coachDB')
  assert.ok(!keys.some(item => item === 'coachDB' || item.indexOf('coachCloudActiveCache') === 0 || item.indexOf('coachSandboxActiveCache') === 0))
  // 命令成功 + 回读成功之后仍然不得出现 cache 写入（cache 只由 adapter 管）
  assert.equal(world.counts.readActive, 1)
  assert.ok(![...store.keys()].some(item => item === 'coachCloudActiveCache'))
  // 静态证据：两个新模块都不引用 cache key / saveDB / getDB
  const root = path.join(__dirname, '..')
  for (const file of ['utils/booking-optimistic.js', 'utils/pending-booking-request.js']) {
    const source = stripComments(fs.readFileSync(path.join(root, file), 'utf8'))
    assert.ok(!/ActiveCache/.test(source), `${file} 不得引用 active cache`)
    assert.ok(!/saveDB/.test(source), `${file} 不得直接写 coachDB`)
    assert.ok(!/runtime\.getDB/.test(source), `${file} 不得把待确认数据混进正式快照`)
  }
})

// ⑨ Sandbox / Production 完全隔离
scenario('Sandbox 与 Production 待确认预约完全隔离', async () => {
  const world = makeWorld()
  await world.optimistic.submit(input())
  assert.equal(pending.list('production', 'ds-p').length, 1)
  world.environment = 'sandbox'
  assert.equal(world.optimistic.records().length, 0, 'sandbox 不得看到 production 的待确认预约')
  const executed = world.counts.execute
  await world.optimistic.resume()
  assert.equal(world.counts.execute, executed, 'sandbox resume 不得提交 production 的预约')
  assert.equal(pending.list('production', 'ds-p').length, 1, 'sandbox 操作不得影响 production 记录')
  world.environment = 'production'
  assert.equal(world.optimistic.records().length, 1)
  // dataset 维度隔离
  world.datasetByEnv.production = 'ds-p-next'
  assert.equal(world.optimistic.records().length, 0, '切换 datasetId 后不得复用旧 dataset 的待确认预约')
  assert.equal(pending.list('production', 'ds-p').length, 1)
})

// ⑩ 杀进程 / 重进页面恢复
scenario('杀进程后重进：只查单不重发，能恢复也能清理', async () => {
  const world = makeWorld()
  const key = pending.bookingKey(input())
  pending.create('production', 'ds-p', key, 'req-killed', input(), { id: `pending:${key}`, studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-16', hour: 16, minute: 0, typeName: '常规训练', price: 100, status: 'booked' }, 1)
  pending.patch('production', 'ds-p', key, 'req-killed', { status: 'unknown' })
  const restarted = makeWorld() // 新进程：新的 inFlight / 新的订阅者，共用同一份本机 Storage
  const executed = restarted.counts.execute
  await restarted.optimistic.resume()
  assert.equal(restarted.counts.execute, executed, '未知状态恢复时绝不能重发命令')
  assert.equal(restarted.optimistic.records().length, 1)
  assert.equal(restarted.optimistic.records()[0].pendingLabel, '待确认')
  restarted.receipts.set('req-killed', { status: 'succeeded', response: { ok: true } })
  await restarted.optimistic.resume()
  assert.equal(restarted.optimistic.records().length, 0, 'receipt 确认成功后必须清掉本机标记')
  assert.equal(restarted.counts.execute, executed)
})

scenario('杀进程后重进：云端已有该预约时直接去重，不查 receipt 也不留残影', async () => {
  const world = makeWorld()
  const key = pending.bookingKey(input())
  pending.create('production', 'ds-p', key, 'req-killed-2', input(), { id: `pending:${key}`, studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-16', hour: 16, minute: 0, typeName: '常规训练', price: 100, status: 'booked' }, 1)
  const restarted = makeWorld({ bookings: [{ id: 'booking-server-1', studentId: 'stu-1', packageId: 'pkg-1', date: '2026-09-16', hour: 16, minute: 0, typeName: '常规训练', price: 100, status: 'booked' }] })
  await restarted.optimistic.resume()
  assert.equal(restarted.optimistic.records().length, 0)
  assert.equal(restarted.counts.getReceipt, 0, '云端已有该预约时无需查 receipt')
  assert.equal(restarted.counts.execute, 0)
  assert.equal(restarted.optimistic.mergeBookings(restarted.bookings).length, 1, '不得出现重复块')
})

scenario('下次启动才补发：状态仍是 pending（命令从未发出）才允许提交', async () => {
  const key = pending.bookingKey(input())
  resetAll()
  const world = makeWorld()
  pending.create('production', 'ds-p', key, 'req-never-sent', input(), { id: `pending:${key}`, studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-16', hour: 16, minute: 0, typeName: '常规训练', price: 100, status: 'booked' }, 1)
  const restarted = makeWorld()
  await restarted.optimistic.resume()
  assert.equal(restarted.counts.execute, 1, '从未发出的命令必须补发')
  assert.deepEqual(restarted.executedRequestIds, ['req-never-sent'], '必须复用原 requestId')
  assert.equal(restarted.optimistic.records().length, 0)
  assert.equal(restarted.bookings.length, 1)
})

// ⑪ 写冻结 / 离线禁止
scenario('activating / cutover-pending / 离线 禁止创建待确认预约', async () => {
  for (const cutover of [MODES.ACTIVATING, MODES.PENDING]) {
    resetAll()
    const world = makeWorld({ cutover })
    const result = await world.optimistic.submit(input())
    assert.equal(result.ok, false)
    assert.equal(result.code, 'CUTOVER_WRITE_FROZEN')
    assert.equal(world.optimistic.records().length, 0, '写冻结时不得产生待确认块')
    assert.equal(world.counts.execute, 0)
    assert.ok(world.modals.some(item => item.title === '业务修改已暂停'))
    await world.optimistic.resume()
    assert.equal(world.counts.execute, 0, '写冻结时 resume 也不得提交')
  }
  resetAll()
  const offline = makeWorld({ online: false })
  const offlineResult = await offline.optimistic.submit(input())
  assert.equal(offlineResult.code, 'OFFLINE_READ_ONLY')
  assert.equal(offline.optimistic.records().length, 0)
  assert.equal(offline.counts.execute, 0)
  assert.ok(offline.toasts.some(item => item.title === '当前离线，仅可查看'))
})

// ⑫ 完整 integrity 不因提速减少
scenario('提速路径与常规路径使用同一条完整 active read（10 RPC 不减少）', async () => {
  const world = makeWorld()
  await world.optimistic.submit(input())
  await flush()
  assert.equal(world.counts.readActive, 1)
  assert.equal(world.counts.metadata + world.counts.pages + world.counts.integrity, 10)
  const adapter = world.adapter
  // 协调器必须复用 adapter.execute / adapter.readActive，不能另起轻量读路径
  const source = fs.readFileSync(path.join(__dirname, '..', 'utils/booking-optimistic.js'), 'utf8')
  // ⚠️ 静态断言**必须先剥注释**：注释里写到一个词（例如解释"这条命令在 callCloud 之前就被拒"）
  //    不等于代码里调了它。契约由代码钉，不由注释钉。
  const bare = stripComments(source)
  assert.ok(bare.includes('adapter.execute('), '落库必须走 adapter.execute')
  assert.ok(bare.includes('adapter.readActive('), '回读必须走 adapter.readActive')
  assert.ok(!/callCloud/.test(bare), '协调器不得直接调云函数绕过 adapter')
  assert.ok(!/integrity\(/.test(bare), '协调器不得自建一套完整性校验')
  assert.ok(typeof adapter.execute === 'function')
})

// ⑬ 最终 Cloud 数据与 UI 一致
scenario('最终 Cloud 快照与 UI 合并结果一致', async () => {
  const world = makeWorld()
  await world.optimistic.submit(input({ hour: 16, minute: 30, studentId: 'stu-9', packageId: 'pkg-9' }))
  await world.optimistic.submit(input({ hour: 18, minute: 0 }))
  assert.equal(world.optimistic.records().length, 2, '两条不同的预约可以同时在途')
  await flush(20)
  assert.equal(world.bookings.length, 2)
  assert.equal(world.counts.execute, 2)
  assert.equal(world.optimistic.records().length, 0)
  const merged = world.optimistic.mergeBookings(world.bookings)
  assert.equal(merged.length, 2)
  assert.deepEqual(merged.map(item => `${item.hour}:${item.minute}`).sort(), ['16:30', '18:0'])
  assert.ok(merged.every(item => !item.pending && !String(item.id).startsWith('pending:')))
})

// ⑭ 命令成功但回读失败：标记「同步中」，绝不重发
scenario('命令成功但 active read 失败时标记「同步中」，之后自愈', async () => {
  const world = makeWorld({ refreshOk: false })
  await world.optimistic.submit(input())
  await flush()
  assert.equal(world.counts.execute, 1, '命令已成功，不得重发')
  assert.equal(world.optimistic.records().length, 1)
  assert.equal(world.optimistic.records()[0].pendingLabel, '同步中')
  assert.ok(world.toasts.some(item => item.title === '预约已提交，正在同步'))
  world.refreshOk = true
  await world.optimistic.resume()
  assert.equal(world.optimistic.records().length, 0, '同步成功后必须清掉本机标记')
  assert.equal(world.counts.execute, 1)
})

// ⑮ revision 冲突安全处理
scenario('REVISION_CONFLICT 精确撤回并重新同步 cache', async () => {
  const world = makeWorld({ executeResult: { ok: false, code: 'REVISION_CONFLICT', currentRevision: 9 } })
  await world.optimistic.submit(input())
  await flush()
  assert.equal(world.optimistic.records().length, 0, 'revision 冲突必须精确撤回')
  assert.equal(world.counts.readActive, 1, '冲突后必须重新同步一次')
  assert.ok(world.modals.some(item => item.title === '数据已变化'))
  assert.equal(world.bookings.length, 0)
})

// ⑯ 冷启动 revision 未知
scenario('冷启动 revision 未知时先补一次 active read，前台仍然即时返回', async () => {
  const world = makeWorld({ revision: null })
  const result = await world.optimistic.submit(input())
  assert.equal(result.ok, true)
  assert.equal(world.counts.readActive, 0, '前台返回时不得等待 active read')
  const started = Date.now()
  while (world.counts.execute === 0 && Date.now() - started < 500) await delay(1)
  await flush()
  assert.equal(world.counts.execute, 1)
  assert.equal(world.counts.readActive, 2, '补一次 revision + 命令后完整回读一次')
  assert.equal(world.optimistic.records().length, 0)
  assert.equal(world.bookings.length, 1)
})

// ⑰ 用户手动「重新确认」：只有云端从未受理时才用同一个 requestId 重发
scenario('手动重新确认复用同一个 requestId，不产生重复预约', async () => {
  const world = makeWorld({ executeThrows: true, receiptStatus: 'unknown' })
  await world.optimistic.submit(input())
  await flush()
  const requestId = world.executedRequestIds[0]
  const key = world.optimistic.records()[0].pendingKey
  world.executeThrows = false
  const retried = await world.optimistic.retry(key)
  await flush()
  assert.equal(retried.code, 'RESUBMITTED')
  assert.deepEqual(world.executedRequestIds, [requestId, requestId], '必须复用同一个 requestId')
  assert.equal(world.bookings.length, 1)
  assert.equal(world.optimistic.records().length, 0)
  // 云端已受理时手动重试只做确认，不再发命令
  const world2 = makeWorld({ executeThrows: true, receiptStatus: 'unknown' })
  await world2.optimistic.submit(input({ hour: 19 }))
  await flush()
  const key2 = world2.optimistic.records()[0].pendingKey
  const requestId2 = world2.executedRequestIds[0]
  world2.receipts.set(requestId2, { status: 'succeeded', response: { ok: true } })
  world2.bookings.push({ id: 'booking-server-1', studentId: 'stu-1', packageId: 'pkg-1', date: '2026-09-16', hour: 19, minute: 0, typeName: '常规训练', price: 100, status: 'booked' })
  const before = world2.counts.execute
  const second = await world2.optimistic.retry(key2)
  assert.equal(second.code, 'CONFIRMED')
  assert.equal(world2.counts.execute, before, 'receipt 已成功时手动重试不得再发命令')
  assert.equal(world2.optimistic.records().length, 0)
  assert.equal(world2.bookings.length, 1)
})

// ⑱ 结构回归：既有安全机制文件未被改动
scenario('结构回归：adapter / data-runtime / 云函数未引入乐观预约逻辑', async () => {
  const root = path.join(__dirname, '..')
  const readRaw = file => fs.readFileSync(path.join(root, file), 'utf8')
  const read = file => stripComments(readRaw(file))
  for (const file of ['utils/cloud-primary-adapter.js', 'utils/data-runtime.js', 'utils/db.js']) {
    const source = read(file)
    assert.ok(!/pending-booking|booking-optimistic|optimisticBooking/i.test(source), `${file} 不应引入乐观预约逻辑`)
  }
  const runtime = read('utils/data-runtime.js')
  assert.ok(runtime.includes("CLOUD_PRIMARY_DIRECT_WRITE_BLOCKED"), 'Cloud-primary 直接写门禁必须保留')
  assert.ok(runtime.includes('CACHE_ENVIRONMENT_MISMATCH'), '环境隔离必须保留')
  const adapter = read('utils/cloud-primary-adapter.js')
  for (const marker of ['ACTIVE_READ_STALE', 'ACTIVE_READ_INTEGRITY_FAILED', 'COMMAND_RESULT_UNKNOWN', 'REQUEST_PROCESSING', 'expectedRevision', 'getReceipt']) {
    assert.ok(adapter.includes(marker), `adapter 必须保留 ${marker}`)
  }
  assert.ok(adapter.includes("callCloud('coachBusinessCommand'"), '正式命令通道必须保留')
  const modal = read('components/booking-modal/booking-modal.js')
  // 阶段1：预约统一经由 mutate.js 出口；该出口把 createBooking 派给既有「前台即时响应」协调器，语义一条不变。
  assert.ok(/mutate\(\s*'createBooking'/.test(modal), '预约必须走统一写入口')
  assert.ok(!/\bsubmitBooking\s*\(/.test(modal), '组件不得再直接触碰协调器')
  assert.ok(!/\brunCommand(Silent)?\s*\(/.test(modal), '预约前台路径不得退回等待式命令通道')
  // 1.1.6：createBooking 从「协调器」改为**本机先行**（与学员新增同一条 Outbox 链）。
  // 理由：协调器是独立于 Outbox 的第二套同步链（自己的 pending 存储 / requestId 序号 / receipt 处理），
  // 它的后台 confirm 一旦拿到"结果未知"就当场弹「结果待确认 · 云端调用中断」——
  // 1.1.5 真机上无论新老学员，新建预约必定被这句话打扰一次。
  // 现在预约必须由统一入口派给本机先行：前台零等待，后台由 Outbox 按序发送 + 退避重试，
  // 只有**明确业务拒绝**才提示一次。取消（cancelBooking）维持协调器不变。
  const mutateCommands = require('../utils/mutate')
  assert.strictEqual(mutateCommands.strategyFor('createBooking', {}), mutateCommands.STRATEGIES.LOCAL_FIRST, 'createBooking 必须本机先行（前台零等待，后台由 Outbox 收敛）')
  assert.ok(mutateCommands.LOCAL_FIRST_COMMANDS.includes('createBooking'), 'createBooking 必须登记在本机先行命令里')
  assert.equal(mutateCommands.OPTIMISTIC_COMMANDS.createBooking, undefined, 'createBooking 不得再走协调器那条独立同步链')
  assert.strictEqual(mutateCommands.OPTIMISTIC_COMMANDS.cancelBooking, 'cancel', '取消仍由协调器负责（本轮不动）')
  assert.ok(modal.includes("'createBooking'"), 'createBooking 命令名必须保留在正式 UI 绑定中')
  assert.ok(!modal.includes('showLoading'), '预约前台路径不得再出现等待遮罩')
  const schedule = read('pages/schedule/schedule.js')
  assert.ok(schedule.includes('mergePendingBookings('), '课表必须在视图层合并待确认预约')
  assert.ok(schedule.includes('resumePendingBookings('), '重进页面必须恢复待确认预约')
  assert.ok(schedule.includes('retryPendingBooking('), '待确认预约必须提供幂等重试入口')
  const scheduleRaw = readRaw('pages/schedule/schedule.js')
  assert.ok(scheduleRaw.includes('getDB()'), '课表仍然从正式 cache 读业务数据')
  assert.ok(schedule.includes('mergePendingBookings(db.bookings)'), '聚合必须发生在 getDB 之后')
  const wxml = readRaw('pages/schedule/schedule.wxml')
  // 秒回验收标准：第一帧就必须是正式课程视觉，所以不允许存在「待确认专用样式」和会变的渲染 key。
  assert.equal(wxml.includes('pending-block'), false, '不允许再有独立 pending-block 视觉 class（第一帧就必须是正式课程的样子）')
  assert.equal(/wx:key="id"/.test(wxml), false, '课表不得用会变的 booking.id 当渲染 key')
  assert.ok(wxml.includes('wx:key="viewKey"'), '课表必须用稳定渲染 key（转正不重建节点）')
  assert.ok(wxml.includes('data-pending'), '待确认块必须能被点击识别（内部状态，不画在像素上）')
  const wxss = readRaw('pages/schedule/schedule.wxss')
  assert.equal(wxss.includes('pendingBlockPulse'), false, '不允许用呼吸/闪烁动画把「还没好」推到用户眼前')
  const scheduleVisual = read('pages/schedule/schedule.js')
  assert.equal(/dashed/.test(scheduleVisual), false, '课表不得再渲染虚线待确认块')
  assert.equal(/#fff/.test(scheduleVisual), false, '课表不得再渲染白底待确认块')
  assert.ok(scheduleVisual.includes('pendingStatus'), '点击待确认块时必须能读到内部状态')
  const bindings = read('utils/ui-command-bindings.js')
  assert.ok(bindings.includes('createBooking'), '正式 UI 命令绑定表必须保留 createBooking')
  // 诊断钩子必须与正式改动一起落地：不能又出现「命令慢还是回读慢只能靠猜」的情况
  const command = read('utils/ui-cloud-command.js')
  assert.ok(command.includes('onTiming: recordTiming'), 'adapter 必须接入 onTiming 分段时间钩子')
  assert.ok(command.includes('setTimingSink'), '必须能把分段时间交给外部诊断/测试')
  assert.ok(command.includes('getTimings'), '必须能读取已记录的分段时间')
  assert.ok(command.includes('submitBooking'), '必须导出前台即时响应入口')
  assert.ok(command.includes('resumePendingBookings'), '必须导出重进页面的恢复入口')
  assert.ok(command.includes('readDatasetId'), '必须按当前环境读取 activeDatasetId 做隔离')
  assert.ok(command.includes('runtime.environment()'), 'adapter 必须继续按环境隔离')
})

// ⑯ 命令**从未出网**（adapter 在 callCloud 之前就拒了：REVISION_UNKNOWN，本机没有版本号）
//    ⇒ 既不许无限重发，也不许永远停在本机。三件事一起钉：
//      a) 重发必须**有界**：绝不把一台正在出故障的服务器往死里打；
//      b) 到顶之后必须**如实**记成"还没提交出去"，并且**把重试预算还回去**
//         （那不是一次真正的尝试 —— 命令根本没出网，耗掉预算会让下次进页面时再也补发不了）；
//      c) 下次进页面（onShow → resumePendingBookings）拿到版本号后，用**同一个号**补发成功。
//    旧代码把 REVISION_UNKNOWN 混进"结果未知" ⇒ 自动路径只查回执、永不补发 ⇒
//    这条预约永远只活在那台设备的存储里。真机形状就是「电脑上约好了、手机上永远刷不出来」。
scenario('命令从未出网时必须如实标记并把重试预算还回来，下次进页面用同一个号补发成功', async () => {
  const MAX_SEND_ATTEMPTS = 3   // 必须与 utils/booking-optimistic.js 里的常量一致（计数的是总发送次数）
  const world = makeWorld()
  const original = world.adapter.execute.bind(world.adapter)
  world.adapter.execute = async (command, payload, opts) => {
    world.counts.execute++
    world.executedRequestIds.push(opts.requestId)
    // 兜底闸门：万一"有界"这条被改坏（例如 attempt 不再递增），这里把条目清掉让循环停下，
    // 否则这个用例会挂住而不是干净地失败。
    if (world.counts.execute > MAX_SEND_ATTEMPTS + 5) pending.list('production', 'ds-p').forEach(entry => pending.remove('production', 'ds-p', entry.bookingKey, entry.requestId))
    return { ok: false, code: 'REVISION_UNKNOWN' }
  }
  await world.optimistic.submit(input())
  await flush(40)
  assert.equal(world.counts.execute, MAX_SEND_ATTEMPTS,
    '出网前被拒必须重发，但必须有界（1 次首发 + 最多 ' + (MAX_SEND_ATTEMPTS - 1) + ' 次补发）；实得 ' + world.counts.execute + ' 次')
  assert.equal(new Set(world.executedRequestIds).size, 1,
    '★ 无论重发几次，必须始终是同一个 requestId（幂等的唯一依据）；实得 ' + world.executedRequestIds.join(', '))
  assert.equal(world.bookings.length, 0, '这些命令一条都没出网，云端当然没有这条预约')
  const stuck = world.optimistic.records()
  assert.equal(stuck.length, 1, '本机必须继续把它画在课表上，不许凭空消失')
  assert.equal(stuck[0].pendingStatus, 'unknown', '必须如实标成"还没提交出去"，而不是含糊的"确认中"')
  assert.equal(world.optimistic.mergeBookings(world.runtime.getDB().bookings).length, 1,
    '本机课表照常把它画成一节课 —— 这正是"看得见但同步不出去"的危险之处')
  assert.equal(world.modals.some(item => /不会重复提交/.test(String(item.content || ''))), false,
    '对一条从未发出的命令，不许对用户说"正在确认中、不会重复提交"')
  // 云端恢复（版本号拿得到）→ 用户重新进课表页（onShow 会调 resumePendingBookings）
  world.adapter.execute = original
  await world.optimistic.resume()
  await flush(20)
  assert.equal(world.counts.execute, MAX_SEND_ATTEMPTS + 1, '自动路径必须真的补发一次，而不是永远等下去')
  assert.equal(new Set(world.executedRequestIds).size, 1, 'resume 的补发同样必须用同一个 requestId')
  assert.equal(world.bookings.length, 1, '补发之后云端才真正拥有这条预约（另一台设备这才可能刷出来）')
  assert.equal(world.optimistic.records().length, 0, '补发成功后本机待确认记录必须清掉')
  assert.equal(pending.list('production', 'ds-p').length, 0)
})

// ⑰ REVISION_UNKNOWN = adapter **在出网之前**就拒绝了：云端从未收到这条命令。
//    旧代码把它当成"结果未知"，还会弹一句"云端调用中断，正在确认中，不会重复提交"——
//    对一条根本没发出去的命令说"不会重复提交"，既是假话，也让这条预约永远上不了云。
//    正确处置与 sync-engine 完全一致：补齐版本号 → 原号重发。
scenario('REVISION_UNKNOWN 必须补齐版本号后原号重发，不得当成"结果未知"', async () => {
  const world = makeWorld()
  const original = world.adapter.execute.bind(world.adapter)
  let first = true
  world.adapter.execute = async (command, payload, opts) => {
    if (first) { first = false; world.counts.execute++; world.executedRequestIds.push(opts.requestId); return { ok: false, code: 'REVISION_UNKNOWN' } }
    return await original(command, payload, opts)
  }
  await world.optimistic.submit(input())
  await flush(20)
  assert.equal(world.counts.execute, 2, '出网前被拒 ≠ 终局：必须补齐版本号后用同一个号再发一次')
  assert.equal(world.executedRequestIds[0], world.executedRequestIds[1], '★ 补发必须沿用同一个 requestId')
  assert.equal(world.bookings.length, 1, '这条预约最终必须落到云端')
  assert.equal(world.optimistic.records().length, 0)
  assert.equal(world.modals.some(item => /不会重复提交/.test(String(item.content || ''))), false,
    '对一条从未发出的命令，不许再对用户说"正在确认中、不会重复提交"')
})

// ⑱ 取消记录里存着「本机临时 id」时，绝不拿它当正式 id 发 cancelBooking。
//    真实形状：用户在**本机新建、还没上云**的那条预约上点了取消 ⇒ cancellation.begin(..., officialId)
//    记下的 officialId 其实就是本机 id（loc_booking_…）。云端正式 id 一律由服务端生成，
//    拿 loc_ 去云端必然 BOOKING_NOT_FOUND —— 白跑一次云写（还留一条失败归档）。
//    为什么必须在解析阶段拦：resume 对「等待中」的取消会**自动推进**，而 runCancel 里那道
//    「自动路径只查回执」的闸只覆盖 unknown / cancelling —— waiting 不在它的保护范围内。
scenario('取消记录带本机临时 officialId 时只做本机清理，绝不发 cancelBooking', async () => {
  const world = makeWorld({ withCancellation: true, revision: 162 })
  const datasetId = 'ds-p'
  const localKey = 'mtfebs2trp2ufp|mthcl6gmfug0yp|2026-09-22|17|0'
  const payload = {
    studentId: 'mtfebs2trp2ufp', packageId: 'mthcl6gmfug0yp', date: '2026-09-22', hour: 17, minute: 0,
    typeName: '常规训练', price: 400, status: 'booked'
  }
  store.set('coachPendingCancellations:production', {
    [localKey]: {
      localKey, datasetId, environment: 'production', officialId: 'loc_booking_muc61ctq14b5z32',
      requestId: 'req-cancel-loc', status: 'waiting', attempt: 0, payload: clone(payload), startedAt: 1
    }
  })
  // ★ 拿不到正式 id 时不再"默认先做一次完整回读"就下结论，而是 waiting + **有限**重试，
  //   用尽之后才动用唯一那次回读来定论（1.1.9 第 10 轮）。所以这里推进到收敛为止再断言。
  let result = null
  for (let i = 0; i < 6; i++) result = await world.optimistic.resume()
  assert.strictEqual(world.counts.execute, 0,
    '本机临时 id 绝不是正式 id ⇒ 一条云写命令都不许发（实得 ' + world.counts.execute + ' 次）')
  assert.strictEqual(cancellation.list('production', datasetId).length, 0,
    '确认云端从来没有这条 ⇒ 本机标记必须清干净（本机先行、绝不发注定失败的写）')
  assert.ok(result && result.ok, 'resume 必须正常收尾，不得卡在这条残留上')
})

// 反证：判据只拦「本机临时 id」。真正的正式 id 必须照常发出去，
// 否则这条新判据会把正常取消一起堵死（本项目对"空壳判据"栽过，必须给出反向样本）。
scenario('反证：正式 officialId 的取消仍然照常发送（判据只拦本机临时 id）', async () => {
  const world = makeWorld({ withCancellation: true, revision: 162 })
  const datasetId = 'ds-p'
  const localKey = 'stu-9|pkg-9|2026-09-23|11|0'
  const payload = {
    studentId: 'stu-9', packageId: 'pkg-9', date: '2026-09-23', hour: 11, minute: 0,
    typeName: '常规训练', price: 300, status: 'booked'
  }
  store.set('coachPendingCancellations:production', {
    [localKey]: {
      localKey, datasetId, environment: 'production', officialId: 'booking_927436bcd4f8eed2cb76',
      requestId: 'req-cancel-real', status: 'waiting', attempt: 0, payload: clone(payload), startedAt: 1
    }
  })
  await world.optimistic.resume()
  assert.strictEqual(world.counts.execute, 1, '正式 id 必须照常发一条 cancelBooking（实得 ' + world.counts.execute + '）')
  assert.strictEqual(world.executedRequestIds[0], 'req-cancel-real',
    '必须沿用记录里固定的 requestId（幂等的唯一依据）')
})

;(async () => {
  for (const item of scenarios) {
    resetAll()
    const started = Date.now()
    await item.fn()
    console.log(`  ✓ ${item.name} (${Date.now() - started}ms)`)
  }
  console.log(`booking optimistic response tests: PASS (${scenarios.length} scenarios, foreground zero-RPC, full integrity retained, no duplicate booking)`)
})().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 })
