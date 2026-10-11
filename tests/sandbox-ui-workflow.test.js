const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const copy = value => JSON.parse(JSON.stringify(value))
const state = {
  students: [{ id: 'sandbox-student', name: '假学员', phone: '13800000000', packages: [{ id: 'sandbox-package', type: '常规训练', total: 5, used: 0, remaining: 5, price: 150, status: 'active' }] }],
  bookings: [],
  incomes: [],
  sales: [],
  settings: { renewThreshold: 3, monthlyGoalSessions: 20, classCommissionRate: 40, salesCommissionRate: 10 },
  customExercises: []
}
let capturedComponent, capturedPage, localWrites = 0, revision = 0
const calls = []
const toasts = []
const modals = []
const submitCalls = []
const pendingRecords = []
const navigations = []
const clipboards = []
let loadingCalls = 0
// 已经真的发到云端的 createBooking 条数。1.1.6 起预约走本机先行（或它的降级路径），
// 计数口径从「协调器被调用几次」改成「云端一共收到几条 createBooking」——
// 这才是「一次点击只允许产生一条预约」真正要钉的东西。
const bookingCommands = () => calls.filter(item => item.command === 'createBooking').length
const storage = { coachSandboxActiveCache: { datasetId: 'sandbox-dataset' } }
global.wx = {
  showToast(options) { toasts.push(options) }, showLoading() { loadingCalls++ }, hideLoading() {}, showModal(options) { modals.push(options) },
  // 剪贴板桩必须复现**真实平台回调形状**（1.1.9）：不给 success 就等于"从不回调"，
  // 于是复制阶段永远走满退避重试（两个真实定时器）→ 完成链被拖出微任务边界，
  // 这类时序问题在假件里会被放大成"意外导航"的假象。真机上一写就回调。
  setClipboardData(options) { clipboards.push(options && options.data); if (options && options.success) options.success({}) },
  getStorageSync(key) { return storage[key] }, setStorageSync(key, value) { storage[key] = copy(value) },
  // 记录自动返回而不是直接抛错：完课第一帧本来就会返回课表（这是产品行为，不是意外导航）。
  // 之前这里 throw，而 session 侧用 try/catch 包住 navigateBack → 错误被吞掉，这条守卫形同虚设。
  // 现在改成：同步流程内断言「一次都没导航」，流程结束后再断言「恰好只有完课那一次」。
  navigateBack() { navigations.push({ at: Date.now() }) }
}
const runtimePath = require.resolve('../utils/data-runtime')
const commandPath = require.resolve('../utils/ui-cloud-command')
const previousRuntime = require.cache[runtimePath]
const previousCommand = require.cache[commandPath]
require.cache[runtimePath] = { id: runtimePath, filename: runtimePath, loaded: true, exports: {
  getDB: () => copy(state),
  saveDB: () => { localWrites++; throw new Error('sandbox UI wrote local coachDB') },
  uid: () => 'unexpected-local-id',
  pad: number => String(number).padStart(2, '0'),
  dateStr: () => '2026-09-20',
  timeStr: booking => String(booking.hour).padStart(2, '0') + ':' + String(booking.minute || 0).padStart(2, '0')
  ,cacheKey: () => 'coachSandboxActiveCache', environment: () => 'sandbox'
} }
async function runCommand({ command, payload, onSuccess }) {
  calls.push({ command, payload: copy(payload), revision })
  if (command === 'createBooking') {
    state.bookings.push({ id: 'sandbox-booking', studentId: payload.studentId, studentName: '假学员', packageId: payload.packageId, typeName: '常规训练', price: 150, date: payload.date, hour: payload.hour, minute: payload.minute, status: 'booked', items: [], notes: '' })
  } else if (command === 'updateBookingContent') {
    const booking = state.bookings.find(item => item.id === payload.bookingId)
    Object.assign(booking, { items: copy(payload.items), notes: payload.notes, category: payload.category, duration: payload.duration })
    if (booking.status === 'done') booking.summary = booking.items.map(item => item.name).join('、') + ' ' + booking.notes
  } else if (command === 'completeBooking') {
    const booking = state.bookings.find(item => item.id === payload.bookingId)
    assert.equal(booking.status, 'booked')
    const pkg = state.students[0].packages.find(item => item.id === booking.packageId)
    booking.status = 'done'
    pkg.used += 1
    pkg.remaining -= 1
    state.incomes.push({ id: 'sandbox-income', bookingId: booking.id, amount: booking.price })
  } else throw new Error('unexpected command ' + command)
  revision++
  if (onSuccess) await onSuccess({ ok: true })
  return { ok: true, datasetRevision: revision }
}
require.cache[commandPath] = { id: commandPath, filename: commandPath, loaded: true, exports: {
  isCloudPrimary: () => true,
  runCommand,
  adapter: { getState: () => ({ datasetId: 'sandbox-dataset' }), readActive: async () => ({ ok: true }) },
  // 前台即时响应入口：本桩只负责「业务结果」，乐观层自身的行为由 booking-optimistic-response.test.js 覆盖。
  submitBooking(input) {
    submitCalls.push(copy(input))
    assert.equal(input.command, 'createBooking', '预约必须沿用 createBooking 命令契约')
    assert.ok(input.studentId && input.packageId && input.date, '预约 payload 必须完整')
    assert.ok(Number.isInteger(input.hour) && Number.isInteger(input.minute), '预约时间必须是整数小时/分钟')
    calls.push({ command: 'createBooking', payload: { studentId: input.studentId, packageId: input.packageId, date: input.date, hour: input.hour, minute: input.minute }, revision })
    state.bookings.push({ id: state.bookings.length ? 'sandbox-booking-' + state.bookings.length : 'sandbox-booking', studentId: input.studentId, studentName: input.studentName, packageId: input.packageId, typeName: input.typeName, price: input.price, date: input.date, hour: input.hour, minute: input.minute, status: 'booked', items: [], notes: '' })
    revision++
    return Promise.resolve({ ok: true, deferred: true, requestId: 'sandbox-request' })
  },
  pendingBookingRecords: () => copy(pendingRecords),
  pendingCancellationRecords: () => [],
  // 与 ui-cloud-command 一致：静默通道语义等同 runCommand，只是不显示遮罩。
  runCommandSilent: options => runCommand(options),
  operationId: key => `sandbox-op-${key}`,
  officialIdForBooking: () => '',
  awaitOfficialBooking: async () => '',
  subscribePendingBookings: () => () => {},
  bindingForOfficialId: () => null,
  notifyPendingBookings() {}
} }
global.Component = config => { capturedComponent = config }
global.Page = config => { capturedPage = config }
require('../components/booking-modal/booking-modal')
require('../pages/session/session')
function instance(config, extra = {}) {
  const object = { data: copy(config.data), properties: {}, triggerEvent() {}, setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback() }, ...extra }
  for (const [name, method] of Object.entries(config.methods || config)) if (typeof method === 'function') object[name] = method.bind(object)
  return object
}
;(async () => {
  const booking = instance(capturedComponent, { properties: { presetDate: '2026-09-20', presetHour: 9 }, events: [], triggerEvent(name) { this.events.push(name) } })
  booking.init()
  booking.chooseStudent({ currentTarget: { dataset: { id: 'sandbox-student' } } })
  booking.choosePackage({ currentTarget: { dataset: { index: 0, disabled: false } } })
  const booked = await booking.confirm()
  assert(booked.ok, '正常新预约必须成功')
  // 1.1.6：预约已改为**本机先行**，不再走协调器那条独立同步链。
  // 注意本测试的沙箱 runtime 替身**没有提供本机数据集快照**（coachScope 拿不到 cache.snapshot），
  // 所以这里实际走的是记录在案的**降级路径**：「本机数据集尚未就绪 → 退回云端先行并留痕」。
  // 本机先行的主路径（秒约 / 断网 / 响应丢失 / 临时 id 转正 …）由
  // tests/booking-instant-chain.test.js 逐场景覆盖；这里钉的是降级路径仍然守住的三件事：
  //   不等待遮罩、一次点击只发出一条命令、不产生第二条预约。
  assert.equal(bookingCommands(), 1, '一次点击只允许向云端发出一条 createBooking')
  assert.equal(state.bookings.length, 1, '降级路径也必须真的建出这条预约，且只有一条')
  assert.equal(state.bookings[0].packageId, 'sandbox-package')
  assert.deepEqual(booking.events, ['saved', 'close'])
  assert.equal(submitCalls.length, 0, '预约不得再走协调器那条独立同步链')
  assert.equal(loadingCalls, 0, '预约前台路径不得出现等待遮罩')

  const session = instance(capturedPage)
  session.onLoad({ id: 'sandbox-booking' })
  session.onShow()
  assert.equal(session.data.done, false, 'booked 课程不应被历史只读保护误拦截')
  session.addExercise({ detail: { name: '假高位下拉', group: '背部' } })
  session.itemInput({ currentTarget: { dataset: { i: 0, k: 'sets' } }, detail: { value: '5' } })
  session.itemInput({ currentTarget: { dataset: { i: 0, k: 'reps' } }, detail: { value: '10' } })
  session.itemInput({ currentTarget: { dataset: { i: 0, k: 'weight' } }, detail: { value: '30' } })
  session.notes({ detail: { value: '假数据备注' } })
  const beforeCloudSave = instance(capturedPage)
  beforeCloudSave.onLoad({ id: 'sandbox-booking' })
  beforeCloudSave.onShow()
  assert.equal(state.bookings[0].items.length, 0, 'debounced edit has not reached cloud yet')
  assert.equal(beforeCloudSave.data.items[0].name, '假高位下拉', 'immediate reopen must show pending draft over old cache')
  assert.equal(beforeCloudSave.data.draftPending, true)
  const result = await session.complete()
  assert(result.ok, '正常 booked 课程一次完课必须成功')
  // complete() 现在第一帧就返回句柄（用户不必等云端事务），后台链自行跑完。
  // 安全性质一条不变：先确认训练内容、再一次完课事务。这里等 settled 再校验。
  await result.settled
  // 1.1.9：一次点击下课 = 完课 + 内容进剪贴板，缺一不算完整动作。沙箱这条互通链上也要真的复制到，且只复制一次。
  assert.equal(clipboards.length, 1, '下课必须把课程内容写进剪贴板，且只写一次')
  // ★ 1.1.9 第 7 轮：复制文本**不再带学员姓名** —— 用户要把它贴进正式聊天，
  //   第一行直接从日期/星期开始（日期、星期、时间、训练部位、动作、组数次数格式一个字都没改）。
  const clipboardText = String(clipboards[0] || '')
  assert.equal(clipboardText.includes('假学员'), false, '复制文本不得出现学员姓名，实得：' + JSON.stringify(clipboardText))
  assert.ok(/^⏰ \d+月\d+日 星期[日一二三四五六]/.test(clipboardText.split('\n')[0]),
    '复制文本第一行必须是日期/星期，实得 ' + JSON.stringify(clipboardText.split('\n')[0]))
  assert.deepEqual(calls.map(item => item.command), ['createBooking', 'updateBookingContent', 'completeBooking'])
  assert.equal(state.students[0].packages[0].used, 1)
  assert.equal(state.students[0].packages[0].remaining, 4)
  assert.equal(state.incomes.length, 1)
  assert.equal(require('../utils/pending-training-draft').get('sandbox', 'sandbox-dataset', 'sandbox-booking'), null, 'verified training draft must be cleared')
  const reopened = instance(capturedPage)
  reopened.onLoad({ id: 'sandbox-booking' })
  reopened.onShow()
  assert.equal(reopened.data.done, true)
  assert.equal(reopened.data.items[0].name, '假高位下拉')
  assert.equal(reopened.data.items[0].sets, '5')
  assert.equal(reopened.data.items[0].reps, '10')
  assert.equal(reopened.data.items[0].weight, '30')
  assert.equal(reopened.data.notes, '假数据备注')
  const packageBeforeEdit = copy(state.students[0].packages[0]), incomesBeforeEdit = copy(state.incomes)
  reopened.startEditCompleted()
  assert.equal(reopened.data.editingCompleted, true)
  reopened.itemInput({ currentTarget: { dataset: { i: 0, k: 'weight' } }, detail: { value: '35' } })
  reopened.notes({ detail: { value: '修正后的假数据备注' } })
  const edited = await reopened.saveCompletedContent()
  assert(edited.ok)
  assert.equal(state.bookings[0].status, 'done')
  assert.equal(state.bookings[0].items[0].weight, '35')
  assert.equal(state.bookings[0].notes, '修正后的假数据备注')
  assert.deepEqual(state.students[0].packages[0], packageBeforeEdit)
  assert.deepEqual(state.incomes, incomesBeforeEdit)
  assert.equal(calls.filter(item => item.command === 'completeBooking').length, 1)
  const editedReopen = instance(capturedPage)
  editedReopen.onLoad({ id: 'sandbox-booking' })
  editedReopen.onShow()
  assert.equal(editedReopen.data.items[0].weight, '35')
  assert.equal(editedReopen.data.notes, '修正后的假数据备注')
  state.bookings[0].legacyRelationStatus = 'orphan'
  const legacy = instance(capturedPage)
  legacy.onLoad({ id: 'sandbox-booking' })
  legacy.onShow()
  legacy.startEditCompleted()
  assert.equal(legacy.data.editingCompleted, false, 'legacy orphan 完课必须继续只读')
  delete state.bookings[0].legacyRelationStatus
  assert.equal(localWrites, 0)

  // 待确认预约必须参与本地冲突校验：同一时段不得再乐观插入第二条。
  // 对照组（21:00 无真实课程也无待确认预约时放行）用于证明拦截来自待确认记录本身。
  const conflictBooking = instance(capturedComponent, { properties: { presetDate: '2026-09-20', presetHour: 20 }, events: [], triggerEvent(name) { this.events.push(name) } })
  conflictBooking.init()
  conflictBooking.chooseStudent({ currentTarget: { dataset: { id: 'sandbox-student' } } })
  conflictBooking.choosePackage({ currentTarget: { dataset: { index: 0, disabled: false } } })
  const control = await conflictBooking.confirm()
  assert.equal(control.ok, true, '该时段既无正式课程也无待确认预约时必须放行')
  assert.equal(bookingCommands(), 2, '对照组必须真的向云端发出第二条 createBooking')
  conflictBooking.pickHour({ currentTarget: { dataset: { value: 21 } } })
  conflictBooking.pickMinute({ currentTarget: { dataset: { value: 0 } } })
  pendingRecords.push({ id: 'pending:conflict', studentId: 'sandbox-student', packageId: 'sandbox-package', date: '2026-09-20', hour: 21, minute: 0, pending: true, pendingKey: 'conflict' })
  toasts.length = 0
  modals.length = 0
  const blockedByPending = await conflictBooking.confirm()
  assert.equal(blockedByPending, undefined, '同一时段已有待确认预约时必须在本地就地拦截')
  assert.equal(bookingCommands(), 2, '被拦截时不得再向云端发出 createBooking')
  assert.equal(submitCalls.length, 0, '预约全程都不得再走协调器那条独立同步链')
  assert.ok(modals.some(item => item.title === '该时段已有课程'), '必须明确提示已占用的时段')
  pendingRecords.length = 0

  const stats = fs.readFileSync(path.join(root, 'pages/stats/stats.wxml'), 'utf8')
  // 锚点跟着统计页层级整理一起更新：设置入口现在是「card + settings-entry + ghost-entry」。
  // 同时补一条 bottom > 0 硬断言 —— 原先只做相对比较，锚点找不到时 bottom=-1 仍然"通过"，
  // 那会让后半条断言变成假绿。
  const bottom = stats.indexOf('class="card settings-entry ghost-entry"')
  assert.ok(bottom > 0, '找不到统计页设置入口锚点（class="card settings-entry ghost-entry"）')
  const entry = stats.indexOf('class="sandbox-entry"')
  assert(entry > bottom && entry < stats.indexOf('</view>\n<view wx:if="{{historyModal}}"'), '沙盒入口必须在统计正式页底部')
  assert(stats.includes('wx:if="{{!sandboxMode}}" class="settings-group data-actions"'), '沙盒不得显示正式备份/删除入口')
  const statsLogic = fs.readFileSync(path.join(root, 'pages/stats/stats.js'), 'utf8')
  for (const handler of ['backupCoachDBToCloud', 'verifyCloudBackup', 'restoreFromCloud', 'deleteMyAllData', 'exportDB', 'importDB', 'restoreLocal']) {
    assert(new RegExp(handler + '\\(\\)\\s*\\{\\s*if\\(blockSandboxLifecycle\\(\\)\\)return').test(statsLogic), handler + ' must be blocked in sandbox')
  }
  const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert(config.pages.includes('pages/sandbox-control/sandbox-control'))
  for (const page of ['schedule', 'students', 'stats', 'session']) {
    assert(fs.readFileSync(path.join(root, 'pages', page, page + '.wxml'), 'utf8').includes('<sandbox-banner/>'), page + ' missing sandbox banner')
  }
  const sessionView = fs.readFileSync(path.join(root, 'pages/session/session.wxml'), 'utf8')
  assert(sessionView.includes('bindtap="saveCompletedContent"'))
  assert(sessionView.includes('done && !legacyReadonly'), 'legacy orphan booking must not expose editing')
  // 同步流程内：一次导航都不允许（意外导航 = 页面被弹走）。
  assert.equal(navigations.length, 0, 'sandbox 同步流程内不得发生任何意外导航')
  // 放行一个 macrotask：完课第一帧那条 scheduled 返回才会执行。只允许恰好一次。
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(navigations.length, 1, '只允许「完课第一帧返回课表」这一次自动返回，不得有第二次（否则会把课表也弹掉）')
  console.log('sandbox UI workflow tests passed (entry, instant booking, pending conflict guard, booked training, one completion, exactly one deferred return, reopen, lifecycle hidden, zero local writes)')
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  if (previousRuntime) require.cache[runtimePath] = previousRuntime; else delete require.cache[runtimePath]
  if (previousCommand) require.cache[commandPath] = previousCommand; else delete require.cache[commandPath]
})
