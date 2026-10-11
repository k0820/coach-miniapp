// Persistent "预约待确认" 记录（乐观预约的本机唯一真相）。
// 只写本机 Storage，永远不写 coachCloudActiveCache / coachSandboxActiveCache，也不写 coachDB。
// 严格按 environment（production / sandbox）+ activeDatasetId 隔离。
const PREFIX = 'coachPendingBookingRequests:'
const BINDING_PREFIX = 'coachBookingBindings:'
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const key = environment => PREFIX + (environment === 'sandbox' ? 'sandbox' : 'production')
const bindingKey = environment => BINDING_PREFIX + (environment === 'sandbox' ? 'sandbox' : 'production')
const readAll = environment => {
  const value = wx.getStorageSync(key(environment))
  return value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : {}
}
const writeAll = (environment, all) => { wx.setStorageSync(key(environment), clone(all)) }
const readBindings = environment => {
  const value = wx.getStorageSync(bindingKey(environment))
  return value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : {}
}
const writeBindings = (environment, all) => { wx.setStorageSync(bindingKey(environment), clone(all)) }

function normalize(value) {
  const source = value || {}
  return {
    studentId: String(source.studentId == null ? '' : source.studentId),
    packageId: String(source.packageId == null ? '' : source.packageId),
    date: String(source.date == null ? '' : source.date),
    hour: Number(source.hour),
    minute: Number(source.minute || 0)
  }
}

function bookingKey(value) {
  const item = normalize(value)
  return [item.studentId, item.packageId, item.date, item.hour, item.minute].join('|')
}

function list(environment, datasetId) {
  if (!datasetId) return []
  const all = readAll(environment)
  return Object.keys(all)
    .filter(id => all[id] && all[id].datasetId === datasetId)
    .sort((a, b) => Number(all[a].createdAt || 0) - Number(all[b].createdAt || 0))
    .map(id => clone(all[id]))
}

function get(environment, datasetId, id) {
  if (!datasetId || !id) return null
  const item = readAll(environment)[id]
  return item && item.datasetId === datasetId ? clone(item) : null
}

function create(environment, datasetId, id, requestId, payload, view, now) {
  if (!datasetId) throw new Error('预约待确认记录缺少数据集标识。')
  if (!id) throw new Error('预约待确认记录缺少时段标识。')
  const all = readAll(environment), existing = all[id]
  if (existing && existing.datasetId === datasetId) return { created: false, entry: clone(existing) }
  const entry = {
    bookingKey: id,
    datasetId,
    environment: environment === 'sandbox' ? 'sandbox' : 'production',
    requestId,
    version: 1,
    status: 'pending',
    attempt: 0,
    payload: normalize(payload),
    view: clone(view),
    createdAt: now
  }
  all[id] = entry
  writeAll(environment, all)
  const verified = get(environment, datasetId, id)
  if (!verified || verified.requestId !== requestId || verified.version !== 1
    || JSON.stringify(verified.payload) !== JSON.stringify(entry.payload)
    || JSON.stringify(verified.view) !== JSON.stringify(entry.view)) throw new Error('预约待确认记录回读失败。')
  return { created: true, entry: verified }
}

function patch(environment, datasetId, id, requestId, changes) {
  const all = readAll(environment), item = all[id]
  if (!item || item.datasetId !== datasetId || item.requestId !== requestId) return null
  Object.assign(item, clone(changes))
  all[id] = item
  writeAll(environment, all)
  const verified = get(environment, datasetId, id)
  if (!verified || verified.requestId !== requestId) throw new Error('预约待确认记录更新回读失败。')
  return verified
}

function remove(environment, datasetId, id, requestId) {
  const all = readAll(environment), item = all[id]
  if (!item) return true
  if (item.datasetId !== datasetId || item.requestId !== requestId) return false
  delete all[id]
  writeAll(environment, all)
  return get(environment, datasetId, id) === null
}

// 用云端快照判定这条待确认预约是否已经真实落库（用于杀进程后自愈去重）。
function matches(value, booking) {
  if (!booking) return false
  const item = normalize(value)
  return booking.studentId === item.studentId
    && booking.packageId === item.packageId
    && booking.date === item.date
    && Number(booking.hour) === item.hour
    && Number(booking.minute || 0) === item.minute
}

// —— 本机身份 → 正式 bookingId 的持久绑定 ——
// 待确认预约只有一个时段业务键（bookingKey），正式 bookingId 由服务端生成。
// 绑定是「刚约完就能进课程详情开始录内容」的地基：未转正时页面用本机编辑态，
// 转正后凭这条绑定把同一个页面实例无缝接到正式 booking 上，不需要重新进页面、不丢内容。
function pendingBookingId(bookingKeyValue) { return `pending:${bookingKeyValue}` }

function bindOfficial(environment, datasetId, bookingKeyValue, officialId, payload) {
  if (!datasetId || !bookingKeyValue || !officialId) throw new Error('预约正式标识绑定缺少参数。')
  const all = readBindings(environment), existing = all[bookingKeyValue]
  if (existing && existing.datasetId === datasetId && existing.officialId !== officialId) throw new Error('预约正式标识绑定冲突。')
  const item = {
    datasetId,
    bookingKey: bookingKeyValue,
    officialId: String(officialId),
    requestId: existing && existing.requestId || '',
    payload: normalize(payload || (existing && existing.payload) || {}),
    at: Date.now()
  }
  all[bookingKeyValue] = item
  writeBindings(environment, all)
  const verified = resolveOfficial(environment, datasetId, bookingKeyValue)
  if (!verified || verified.officialId !== item.officialId) throw new Error('预约正式标识绑定回读失败。')
  // ★ 阶段 2：**必须在绑定落定的这一刻**戳一下同步引擎。
  //   队列里那些「按本机引用排队」的写入（updateBookingContent / completeBooking）在转正之前
  //   一律送不出去（sync-engine.resolvePayload 靠的就是这个绑定认身份）。绑定是唯一的身份来源、
  //   这里也是所有转正路径的唯一入口 —— 不在这里通知，那些条目会一直躺在队列里等下一条无关命令，
  //   用户看到的就是「课表上已经是「已完」，云端却迟迟没有」。
  //   惰性 require：躲开 pending-booking-request ↔ sync-engine ↔ ui-cloud-command 的加载环。
  const alreadyBound = !!(existing && existing.officialId === officialId)
  if (!alreadyBound) { try { require('./sync-engine').schedule() } catch (error) {} }
  return verified
}

function resolveOfficial(environment, datasetId, bookingKeyValue) {
  if (!datasetId || !bookingKeyValue) return null
  const item = readBindings(environment)[bookingKeyValue]
  return item && item.datasetId === datasetId ? clone(item) : null
}

// 取消成功后必须解绑：同一个时段业务键以后可能再次被预约，那时会是一个新的正式 bookingId。
// 不解绑的话，下一次 bindOfficial 会因「officialId 冲突」失败，也让渲染 key 指向一条已经不存在的记录。
function unbind(environment, datasetId, bookingKeyValue) {
  if (!datasetId || !bookingKeyValue) return true
  const all = readBindings(environment), item = all[bookingKeyValue]
  if (!item || item.datasetId !== datasetId) return true
  delete all[bookingKeyValue]
  writeBindings(environment, all)
  return resolveOfficial(environment, datasetId, bookingKeyValue) === null
}

// 反查：已知正式 bookingId，找它是从哪条本机待确认预约转正过来的。
// 用途：转正后重新进入课程详情时，仍要能找到转正前写在 pending:<key> 下的训练草稿，避免看起来「动作丢了」。
function bindingForOfficialId(environment, datasetId, officialId) {
  if (!datasetId || !officialId) return null
  const all = readBindings(environment)
  const hit = Object.keys(all).map(id => all[id]).find(item => item && item.datasetId === datasetId && item.officialId === officialId)
  return hit ? clone(hit) : null
}

// 课表用：把「正式 bookingId → 本机稳定渲染 key」一次性摊平。
// 为什么要它：转正后本机待确认记录会被清掉，若渲染 key 回落到 bookingId，节点会被销毁重建。
// 保留同一套稳定 key，才能做到转正前后「零闪烁、零重新出现」。
function listBindings(environment, datasetId) {
  if (!datasetId) return []
  const all = readBindings(environment)
  return Object.keys(all).filter(id => all[id] && all[id].datasetId === datasetId).map(id => clone(all[id]))
}

function pruneBindings(environment, maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now()) {
  const all = readBindings(environment), kept = {}
  Object.keys(all).forEach(id => { if (all[id] && now - Number(all[id].at || 0) < maxAgeMs) kept[id] = all[id] })
  writeBindings(environment, kept)
  return Object.keys(kept).length
}

module.exports = { key, bindingKey, list, get, create, patch, remove, bookingKey, normalize, matches, pendingBookingId, bindOfficial, resolveOfficial, unbind, bindingForOfficialId, listBindings, pruneBindings }
