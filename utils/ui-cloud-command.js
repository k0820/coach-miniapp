const runtime = require('./data-runtime')
const { createAdapter } = require('./cloud-primary-adapter')
const pendingBookings = require('./pending-booking-request')
const pendingCancellations = require('./pending-cancellation')
const pendingTrainingDraft = require('./pending-training-draft')
const pendingCompletion = require('./pending-completion')
const readTiming = require('./read-timing')
const { createBookingOptimistic } = require('./booking-optimistic')
const { integrity } = require('./candidate-dataset')
const { sameSummary } = require('./summary-compare')
let online = true
const pending = new Map()
const timings = []
let timingSink = null
// —— 统一写入口守卫（阶段1）——
// 云端写命令只允许从 utils/mutate.js 进入：mutate 在派发前打开窗口，这两个入口在窗口内放行。
// 默认 enforced=false（生产行为一个字节都不变）；测试用 __writeFunnel(true) 打开，
// 于是「页面绕开 mutate 自己发命令」会当场抛错，而不是悄悄跑过去。
// 检查发生在同步前奏（函数体第一个 await 之前），所以 enter/exit 的配对是确定的。
const writeFunnel = {
  active: 0, enforced: false,
  enter() { this.active++ },
  exit() { this.active = Math.max(0, this.active - 1) },
  enforce(value) { this.enforced = value !== false; return this.enforced }
}
function assertWriteFunnel(entry) {
  if (!writeFunnel.enforced || writeFunnel.active > 0) return
  throw new Error(`${entry} 只能通过 utils/mutate.js 调用（统一业务写入口）。`)
}
const storage = { get: key => wx.getStorageSync(key), set: (key, value) => wx.setStorageSync(key, value) }
const callCloud = (name, data) => wx.cloud.callFunction({ name, data }).then(response => response.result)
function recordTiming(entry) {
  timings.push(entry)
  if (timings.length > 500) timings.shift()
  if (timingSink) { try { timingSink(entry) } catch (error) {} }
  // ★ 真机耗时账本（1.1.9 第 2 轮）：分段时间以前只活在内存里，小程序一退出就没了，
  //   于是「真机为什么还是 10 秒」只能靠离线推算分页次数去猜。现在每一轮回读都落一条
  //   定长记录进 Storage（排队等待 / metadata / pages / integrity / total / 页数 / revision），
  //   下一轮真机跑完直接读出来看。record 内部自己吞错，绝不影响业务结果。
  if (entry && entry.action === 'readActive') readTiming.record(entry)
  // 写命令后的「确认」也落一条（1.1.9 第 6 轮）：lightweight = 只发了那一跳只读校验；
  // full-read = 校验没过时退回的完整分页回读（fallback 说明原因）。见 utils/read-timing.js。
  if (entry && entry.action === 'execute') readTiming.recordWrite({ ...entry, environment: runtime.environment() })
}
const adapter = createAdapter({ callCloud, storage, isOnline: () => online, environment: () => runtime.environment(), onTiming: recordTiming })
const isCloudPrimary = () => runtime.writesFrozen()
const isCloudWritable = () => runtime.mode() === runtime.MODES.CLOUD && online
// ★ §110：key 是**业务键**（如 `completeBooking:pending:stu|pkg|date|11|0`），里面可能带 `|`，
//   直接拼进 requestId 就会被云端拒收（真机 7 条命令就是这个形状）。
//   过契约后得到的是 key 的确定性别名：同一个业务键永远同一个号 ⇒ 幂等身份不丢。
const newId = key => `${key}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`
let bookingSequence = 0
const bookingOptimistic = createBookingOptimistic({
  runtime,
  pending: pendingBookings,
  cancellation: pendingCancellations,
  // 「用户已经点过下课」也是一份同样的本机意图：课表与课程页都靠它做「视觉先完成」的呈现，
  // 并且由协调器在回到页面时用 receipt 规则做 self-heal（只查回执 / 只重同步，绝不重发完课命令）。
  completion: pendingCompletion,
  adapter,
  isOnline: () => online,
  newRequestId: () => `${newId('booking')}_${++bookingSequence}`,
  readDatasetId: () => { const cache = wx.getStorageSync(runtime.cacheKey()); return cache && cache.datasetId ? cache.datasetId : '' },
  readSnapshot: () => { try { return runtime.getDB() } catch (error) { return null } },
  // 取消确认成功后的收尾：把这条预约的训练草稿一并删除。
  // 必须删：否则一份指向「已取消课程」的内容日后被 flush，就会变成孤儿 Cloud 记录。
  onCancelled: (localKey, officialId) => {
    try {
      const cache = wx.getStorageSync(runtime.cacheKey())
      const datasetId = cache && cache.datasetId
      if (!datasetId) return
      const env = runtime.environment()
      pendingTrainingDraft.remove(env, datasetId, `pending:${localKey}`)
      if (officialId) pendingTrainingDraft.remove(env, datasetId, officialId)
      if (localKey) pendingTrainingDraft.remove(env, datasetId, localKey)
    } catch (error) {}
  },
  onTiming: recordTiming,
  showToast: options => wx.showToast(options),
  showModal: options => wx.showModal(options)
})
function setOnline(value) { online = value !== false }
// options.userInitiated=true：**用户主动**发起的刷新（下拉刷新）。
// 语义见 cloud-primary-adapter.readActive：用户轮次必须真的读一次云端当前状态，
// 绝不能被复用一份「用户开口之前就已经在飞」的旧回读 —— 那与「刷新没生效」同形。
// 「云端最新数据确认完成」的客户端时刻（1.1.9 第 4 轮）。
// 读取层账本那一行的时刻 = 校验通过、cache 已落盘；本变量记的是**同一个瞬间**（回读返回后立刻打），
// 让「安全数据已到达 → 课表立即显示」这一段能单独量出「数据已到达 → 开始装载」这一列（coachUiTimings.gapMs）。
// 只读用途：它不参与任何判断，也绝不影响任何结果。
let lastReadDoneAt = 0
async function refreshActiveView(options) {
  // ⚠️ 不是云端模式时**没有云端可读**，必须如实回报失败，不能返回 ok:true。
  // 返回 ok:true 会让课表页以为"这一轮真的读到云端了"（它会照常 loadScheduleData + render），
  // 于是「下拉刷新」在本机模式下就变成一个**永不报错、也永不生效**的空动作 ——
  // 调用方再也分不出「真的读到了」和「根本没读」。判据只看 ok，不看 skipped。
  // 这不改变任何呈现：两种结果下页面都保留本机课表，只是语义不再撒谎。
  if(runtime.mode()!==runtime.MODES.CLOUD)return {ok:false,code:'CLOUD_MODE_OFF',skipped:true}
  if(!online)return {ok:false,code:'OFFLINE_READ_ONLY'}
  try {
    const result=await adapter.readActive({userInitiated:!!(options&&options.userInitiated)})
    lastReadDoneAt=Date.now()
    if(result&&result.ok&&!result.offline)bookingOptimistic.notifyView()
    // ★ 权威读取成功后**必须**排一轮同步（2026-09-27 真机 26 条长期不收敛的根因之一）。
    //   旧行为：flush 只由「写命令入队后 / 冷启动 / 回前台 / 网络变化」触发，
    //   而 `purgeSettled`（已确认条目的免费出队）又**只**在 flush 里跑 ⇒
    //   用户进页面 / 下拉 / 回前台读一百次，队列**一次都不推进** —— 界面看起来在刷新，
    //   队列却只增不减。
    //   此刻恰好同时具备两个条件：网络是通的、cache.revision 刚被刷到云端最新 ——
    //   这正是「已确认但还没出队」的条目唯一能被判定的时机，且**零额外云调用**。
    // ⚠️ 延迟 require：sync-engine 反过来也要用本模块，顶部互相 require 会成环。
    if(result&&result.ok&&!result.offline){
      try{require('./sync-engine').schedule()}catch(error){}
    }
    return result
  } catch(error) { return {ok:false,code:'REFRESH_FAILED'} }
}
async function switchEnvironment(value) {
  const previous = runtime.environment()
  if (previous === value) return { ok: true, environment: value, unchanged: true }
  // Returning to Production is a view switch, not a new activation. The cache
  // was written only after a verified active read, but validate it again before
  // making it the first visible frame. The schedule page performs its regular
  // async Cloud refresh after reLaunch; the return button never waits for it.
  let productionCache = null
  if (value === runtime.ENVIRONMENTS.PRODUCTION) {
    try {
      const cached = wx.getStorageSync(runtime.CACHE_KEY)
      if (cached && cached.environment === 'production' && cached.datasetId && Number.isInteger(cached.revision) && cached.snapshot) {
        const current = integrity(cached.snapshot)
        if (current.checksum === cached.checksum && current.byteSize === cached.byteSize && sameSummary(current.summary, cached.summary)) productionCache = cached
      }
    } catch (error) { productionCache = null }
  }
  runtime.setEnvironment(value)
  pending.clear()
  adapter.resetState(value)
  if (productionCache) return { ok: true, environment: value, datasetId: productionCache.datasetId, revision: productionCache.revision, restoredFromVerifiedCache: true }
  let timer
  let result
  try {
    result = value === runtime.ENVIRONMENTS.PRODUCTION
      ? await Promise.race([adapter.readActive(), new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, code: 'PRODUCTION_READ_TIMEOUT' }), 12000) })])
      : await adapter.readActive()
  } catch (error) { result = { ok: false, code: 'ENVIRONMENT_READ_FAILED' } }
  finally { if (timer) clearTimeout(timer) }
  if (!result || !result.ok) { runtime.setEnvironment(previous); adapter.resetState(previous); return result || { ok: false, code: 'ENVIRONMENT_READ_FAILED' } }
  return { ok: true, environment: value, datasetId: result.datasetId, revision: result.revision }
}
function operationId(key) { if (!pending.has(key)) pending.set(key, newId(key)); return pending.get(key) }
function clearPending(key, requestId) { if (pending.get(key) === requestId) pending.delete(key) }
async function runCommand({ key, command, payload, requestId, successTitle = '已保存', onSuccess, onRefresh }) {
  assertWriteFunnel('runCommand')
  if (!isCloudPrimary()) throw new Error('runCommand 只能用于 cloud-primary 分支。')
  const cutover = runtime.cutoverState()
  if (cutover.status === runtime.MODES.ACTIVATING || cutover.status === runtime.MODES.PENDING) { wx.showModal({ title: '业务修改已暂停', content: '云端已激活或正在确认，切换尚未完成。请先继续完成云端切换。', showCancel: false, confirmText: '知道了' }); return { ok: false, code: 'CUTOVER_WRITE_FROZEN' } }
  if (!online) { wx.showToast({ title: '当前离线，仅可查看', icon: 'none' }); return { ok: false, code: 'OFFLINE_READ_ONLY' } }
  if (requestId && pending.has(key) && pending.get(key) !== requestId) return { ok: false, code: 'REQUEST_PENDING_CONFIRMATION', requestId: pending.get(key) }
  if (requestId && !pending.has(key)) pending.set(key, requestId)
  const fixedRequestId = requestId || operationId(key)
  wx.showLoading({ title: '正在保存' })
  let result
  try {
    if (!Number.isInteger(adapter.getState().revision)) {
      try {
        const active = await adapter.readActive()
        if (!active.ok) result = { ok:false, code:'ACTIVE_READ_UNAVAILABLE', message:'最新数据暂时没读到，本次操作没有提交，请稍后重试。', readCode:active.code }
      } catch (error) { result = { ok:false, code:'ACTIVE_READ_UNAVAILABLE', message:'最新数据暂时没读到，本次操作没有提交，请稍后重试。' } }
    }
    if (!result) result = await adapter.execute(command, payload, { requestId: fixedRequestId })
  } catch (error) { const raw=String(error&&(error.errMsg||error.message||error.code)||''),timedOut=/TIME_LIMIT|TIMED?_?OUT|TIMEOUT|超时/i.test(raw);result = { ok: false, code:'COMMAND_RESULT_UNKNOWN', reason:timedOut?'CLOUD_FUNCTION_TIMEOUT':'CLOUD_CALL_FAILED', message:timedOut?'云函数运行超时，请检查 coachBusinessCommand 的超时时间设置。':'云函数调用失败，请稍后重试。', technicalMessage:raw.slice(0,300), requestId: fixedRequestId } }
  wx.hideLoading()
  // ⭐ M2 自动刷新：写操作成功后必须让关键数据重新出现（预约 / 改期 / 取消 / 完课 / 课时购买修改）。
  if (result.ok) { pending.delete(key); require('./auto-refresh').requestForCommand(command); if (onSuccess) await onSuccess(result); if (successTitle) wx.showToast({ title: successTitle, icon: 'none' }); return result }
  if (result.code === 'REVISION_CONFLICT') {
    await adapter.readActive(); pending.delete(key); if (onRefresh) await onRefresh()
    wx.showModal({ title: '数据已变化', content: '云端数据已被其他操作更新，请查看最新内容后重新确认。', showCancel: false, confirmText: '知道了' }); return result
  }
  if (result.code === 'COMMAND_RESULT_UNKNOWN' || result.code === 'REQUEST_PROCESSING') {
    wx.showModal({ title: result.reason==='CLOUD_FUNCTION_TIMEOUT'?'云端处理超时':'结果待确认', content: result.reason==='CLOUD_FUNCTION_TIMEOUT'?'服务器处理超过当前时间限制，结果仍需核对。请将 coachBusinessCommand 的超时时间调为 60 秒，再使用原操作重试。':'云端调用中断，操作结果正在确认中。请勿连续重复提交，稍后使用原操作重试。', showCancel: false, confirmText: '知道了' }); return result
  }
  pending.delete(key); wx.showModal({ title: '操作未完成', content: result.message || result.code || '云端操作失败。', showCancel: false, confirmText: '知道了' }); return result
}
// 静默命令通道：安全语义与 runCommand 完全一致（写冻结 / 离线 / 单航班 / 固定 requestId / 完整链），
// 只是不显示 loading 遮罩、不自动弹窗，把结果交给调用方决定。
// 为什么必须有它：runCommand 的 wx.showLoading 是「选动作不能秒回」的真正原因 ——
// 数据层早就写在本机了，是那层全屏遮罩吃掉后续触摸，用户才觉得卡。
async function runCommandSilent({ key, command, payload, requestId, onSuccess, onRefresh, showLoading = false }) {
  assertWriteFunnel('runCommandSilent')
  if (!isCloudPrimary()) throw new Error('runCommandSilent 只能用于 cloud-primary 分支。')
  const cutover = runtime.cutoverState()
  if (cutover.status === runtime.MODES.ACTIVATING || cutover.status === runtime.MODES.PENDING) return { ok: false, code: 'CUTOVER_WRITE_FROZEN' }
  if (!online) return { ok: false, code: 'OFFLINE_READ_ONLY' }
  if (requestId && pending.has(key) && pending.get(key) !== requestId) return { ok: false, code: 'REQUEST_PENDING_CONFIRMATION', requestId: pending.get(key) }
  if (requestId && !pending.has(key)) pending.set(key, requestId)
  const fixedRequestId = requestId || operationId(key)
  if (showLoading) wx.showLoading({ title: '正在保存' })
  let result
  try {
    if (!Number.isInteger(adapter.getState().revision)) {
      try {
        const active = await adapter.readActive()
        if (!active.ok) result = { ok:false, code:'ACTIVE_READ_UNAVAILABLE', message:'最新数据暂时没读到，本次操作没有提交，请稍后重试。', readCode:active.code }
      } catch (error) { result = { ok:false, code:'ACTIVE_READ_UNAVAILABLE', message:'最新数据暂时没读到，本次操作没有提交，请稍后重试。' } }
    }
    if (!result) result = await adapter.execute(command, payload, { requestId: fixedRequestId })
  } catch (error) { const raw=String(error&&(error.errMsg||error.message||error.code)||''),timedOut=/TIME_LIMIT|TIMED?_?OUT|TIMEOUT|超时/i.test(raw);result = { ok: false, code:'COMMAND_RESULT_UNKNOWN', reason:timedOut?'CLOUD_FUNCTION_TIMEOUT':'CLOUD_CALL_FAILED', message:timedOut?'云函数运行超时，请检查 coachBusinessCommand 的超时时间设置。':'云函数调用失败，请稍后重试。', technicalMessage:raw.slice(0,300), requestId: fixedRequestId } }
  if (showLoading) wx.hideLoading()
  if (result.ok) { pending.delete(key); require('./auto-refresh').requestForCommand(command); if (onSuccess) await onSuccess(result); return result }
  if (result.code === 'REVISION_CONFLICT') { await adapter.readActive(); pending.delete(key); if (onRefresh) await onRefresh(); return result }
  if (result.code === 'COMMAND_RESULT_UNKNOWN' || result.code === 'REQUEST_PROCESSING') return result
  pending.delete(key)
  return result
}
// 预约即时响应专用入口：前台立刻返回，后台照旧跑完整 Cloud Command + active read/integrity/cache。
const submitBooking = input => bookingOptimistic.submit(input)
const resumePendingBookings = () => bookingOptimistic.resume()
const retryPendingBooking = bookingKey => bookingOptimistic.retry(bookingKey)
const pendingBookingRecords = () => bookingOptimistic.records()
const mergePendingBookings = bookings => bookingOptimistic.mergeBookings(bookings)
const subscribePendingBookings = listener => bookingOptimistic.subscribe(listener)
// 「完成课程」的即时状态变化也要驱动课表重绘（完课意图 → 已完 / 撤回），共用同一套订阅。
const notifyPendingBookings = () => bookingOptimistic.notifyView()
// 「取消预约」的即时响应入口：前台写 tombstene 让块立刻消失，后台落实；安全语义与预约一致。
const cancelBookingRequest = input => bookingOptimistic.cancel(input)
const retryPendingCancellation = localKey => bookingOptimistic.retryCancel(localKey)
const pendingCancellationRecords = () => bookingOptimistic.cancelRecords()
// 只在「那条 create 刚刚在云端落地」这一刻推进同一时段仍停在 waiting 的取消（同步引擎调用）。
// 事件驱动、不轮询；见 booking-optimistic.advanceCancellations 的注释。
const advancePendingCancellations = bookingLike => {
  if (!bookingOptimistic || typeof bookingOptimistic.advanceCancellations !== 'function') return Promise.resolve({ ok: true, advanced: 0 })
  return bookingOptimistic.advanceCancellations(bookingLike)
}
// 「刚约完就能进课程详情」用的身份解析：未转正返回空串（页面转本机编辑态），转正后返回正式 bookingId。
const officialIdForBooking = bookingKey => bookingOptimistic.officialIdFor(bookingKey)
const awaitOfficialBooking = (bookingKey, timeoutMs) => bookingOptimistic.awaitOfficial(bookingKey, timeoutMs)
const bindingForOfficialId = (officialId) => {
  const cache = wx.getStorageSync(runtime.cacheKey())
  const datasetId = cache && cache.datasetId
  return datasetId ? pendingBookings.bindingForOfficialId(runtime.environment(), datasetId, officialId) : null
}
// 课表用：正式 bookingId → 本机稳定渲染 key，保证转正前后节点不重建。
const bookingBindings = () => {
  const cache = wx.getStorageSync(runtime.cacheKey())
  const datasetId = cache && cache.datasetId
  return datasetId ? pendingBookings.listBindings(runtime.environment(), datasetId) : []
}
// 「这门课在本机是否已经点过下课」（完课意图）。
// 课程页与课表都要靠它：正式 done 落地前，它必须和 done 一样让这门课呈现为「已完成」，
// 否则「刚下课就点进来」会被当成待完成的课，用户再点一次下课只会撞上训练内容安全门并看到误报。
const completionIntentFor = input => {
  try {
    const cache = wx.getStorageSync(runtime.cacheKey())
    const datasetId = cache && cache.datasetId
    if (!datasetId) return null
    return pendingCompletion.intentFor(runtime.environment(), datasetId, (input && input.officialId) || '', (input && input.localKey) || '')
  } catch (error) { return null }
}
module.exports = {
  adapter, isCloudPrimary, isCloudWritable, setOnline, refreshActiveView, switchEnvironment, runCommand, runCommandSilent, operationId, clearPending,  submitBooking, resumePendingBookings, retryPendingBooking, pendingBookingRecords, mergePendingBookings, subscribePendingBookings,
  officialIdForBooking, awaitOfficialBooking, bindingForOfficialId, bookingBindings, notifyPendingBookings,
  cancelBookingRequest, retryPendingCancellation, pendingCancellationRecords, completionIntentFor, advancePendingCancellations,
  setTimingSink: sink => { timingSink = typeof sink === 'function' ? sink : null },
  getTimings: () => timings.slice(),
  // 只读：上一次「云端确认完成」的时刻（0 = 本进程还没有成功回读过）。见本文件顶部的 lastReadDoneAt。
  lastReadDoneAt: () => lastReadDoneAt,
  __writeFunnel: writeFunnel,
  __assertWriteFunnel: assertWriteFunnel
}
