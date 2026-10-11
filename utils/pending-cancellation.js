// 「取消预约」的即时响应记录（本机取消待确认的唯一真相）。
// 只写本机 Storage，永远不写 coachCloudActiveCache / coachSandboxActiveCache，也不写 coachDB。
// 严格按 environment（production / sandbox）+ activeDatasetId 隔离。
//
// 为什么必须单独存一份（而不是直接删 cache 里的 booking）：
//  1. 删 cache 等于伪造云端事实 —— 一旦云端取消失败，用户看到的是「已经没了」，但云端还在；
//     而且 cache 是 active read 的输出，下一次 readActive 会把它原样带回来（幽灵预约）。
//  2. 取消是「先看不见、再在云端落实」：本机只记一条 tombstone，视图层据此把块藏起来，
//     正式 cache 一个字都不改；云端确认成功后由 readActive 接管（块本来就是真的没了），
//     tombstone 随即清除；云端明确失败就撤掉 tombstone，块原样回来并提示用户。
//  3. 取消一条「create 还没转正」的预约必须与 create 排序：见 booking-optimistic 的 runCancel。
const PREFIX = 'coachPendingCancellations:'
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const key = environment => PREFIX + (environment === 'sandbox' ? 'sandbox' : 'production')
const readAll = environment => {
  const value = wx.getStorageSync(key(environment))
  return value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : {}
}
const writeAll = (environment, all) => { wx.setStorageSync(key(environment), clone(all)) }

function list(environment, datasetId) {
  if (!datasetId) return []
  const all = readAll(environment)
  return Object.keys(all)
    .filter(id => all[id] && all[id].datasetId === datasetId)
    .sort((a, b) => Number(all[a].startedAt || 0) - Number(all[b].startedAt || 0))
    .map(id => clone(all[id]))
}

function get(environment, datasetId, localKey) {
  if (!datasetId || !localKey) return null
  const item = readAll(environment)[localKey]
  return item && item.datasetId === datasetId ? clone(item) : null
}

// 幂等：同一条预约重复点取消时复用第一次定下的固定 requestId，绝不生成第二个。
function begin(environment, datasetId, localKey, officialId, newRequestId, payload, startedAt) {
  if (!datasetId || !localKey) throw new Error('取消记录缺少数据集或课程标识。')
  const all = readAll(environment), existing = all[localKey]
  if (existing && existing.datasetId === datasetId) {
    // 已经取消过（含上一次结果未知）→ 原样返回，交给上层查 receipt，绝不重开一轮。
    if (officialId && !existing.officialId) {
      existing.officialId = String(officialId)
      all[localKey] = existing
      writeAll(environment, all)
      return { created: false, entry: get(environment, datasetId, localKey) }
    }
    return { created: false, entry: clone(existing) }
  }
  const entry = {
    localKey,
    datasetId,
    environment: environment === 'sandbox' ? 'sandbox' : 'production',
    officialId: officialId ? String(officialId) : '',
    requestId: newRequestId(),
    status: 'waiting',
    attempt: 0,
    // ★ `sent` = 「这条取消命令**有没有真的出过网**」，由 runCancel 在调用 adapter.execute
    //   **之前**打上。它决定两件完全不同的事，混在一起就会说假话：
    //     · sent=false ⇒ 云端**一定没有**这条 requestId（收据与业务写在同一事务里），
    //       所以既不必先花一跳查回执，重发也不违反「结果未知绝不盲目重发」；
    //     · sent=true  ⇒ 查到"云端没有这条 requestId"才是**权威的"从未受理"结论**，
    //       此时原号补发是安全的（号不变 ⇒ 云端只会认作同一次请求）。
    sent: false,
    payload: clone(payload || {}),
    startedAt
  }
  all[localKey] = entry
  writeAll(environment, all)
  const verified = get(environment, datasetId, localKey)
  if (!verified || verified.requestId !== entry.requestId) throw new Error('取消记录回读失败。')
  return { created: true, entry: verified }
}

// patch 必须带 requestId：防止上一轮的收尾动作改到新一轮的记录。
function patch(environment, datasetId, localKey, requestId, changes) {
  const all = readAll(environment), item = all[localKey]
  if (!item || item.datasetId !== datasetId || item.requestId !== requestId) return null
  Object.assign(item, clone(changes))
  all[localKey] = item
  writeAll(environment, all)
  const verified = get(environment, datasetId, localKey)
  if (!verified || verified.requestId !== requestId) throw new Error('取消记录更新回读失败。')
  return verified
}

function remove(environment, datasetId, localKey, requestId) {
  const all = readAll(environment), item = all[localKey]
  if (!item) return true
  if (item.datasetId !== datasetId || item.requestId !== requestId) return false
  delete all[localKey]
  writeAll(environment, all)
  return get(environment, datasetId, localKey) === null
}

// 课表视图层用：把 tombstone 摊平成「哪些块要藏起来」。
// 同时给出 officialIds（正式预约）与 localKeys（还没转正的待确认块）两套索引，并附 payload
// —— 转正那一瞬间本机记录会被清掉，只有 payload 还能按业务键把块认出来。
function viewIndex(environment, datasetId) {
  const rows = list(environment, datasetId)
  return {
    officialIds: rows.filter(row => row.officialId).map(row => row.officialId),
    localKeys: rows.map(row => row.localKey),
    payloads: rows.map(row => clone(row.payload))
  }
}

function findByOfficialId(environment, datasetId, officialId) {
  if (!datasetId || !officialId) return null
  const hit = list(environment, datasetId).find(row => row.officialId === officialId)
  return hit || null
}

// —— 「这条取消是否还占着某个时段」 ——
//
// 为什么必须是一个**共享**判据：取消是「本机先看不见、再在云端落实」，而同一个时段立刻要被
// 另一位学员用上（11:00 约 A → 取消 A → 立刻 11:00 约 B）。这时**三方**必须同时把 A 当成
// 「不再占用」：视图层（块消失）、约课弹层的冲突检测、以及本机业务事务（createBooking 的
// BOOKING_TIME_CONFLICT —— 它与云端跑的是同一份 handlers）。
// 少改任何一方，用户都会看到「该时段的取消尚未确认 / 这条预约仍可能占用该时段」，
// 而且连重新预约都会被本机事务挡下 —— 那不是文案问题，是「取消没进事实层」。
//
// 口径与云端 `handlers` 的 `sameSlot` / 约课弹层的 `overlaps` **逐字一致**：
// 同一日期、按分钟区间判重叠，一节课 60 分钟。
function overlapsMoment(row, moment) {
  const payload = row && row.payload
  if (!payload || !moment) return false
  if (String(payload.date == null ? '' : payload.date) !== String(moment.date == null ? '' : moment.date)) return false
  const left = Number(payload.hour) * 60 + Number(payload.minute || 0)
  const right = Number(moment.hour) * 60 + Number(moment.minute || 0)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false
  const duration = 60
  return right < left + duration && right + duration > left
}

// 占着这个时段的取消记录（按开始时间升序，与 list 同序）。
function slotRows(environment, datasetId, moment) {
  if (!moment) return []
  return list(environment, datasetId).filter(row => overlapsMoment(row, moment))
}

// 「这条取消还没有在云端落定」—— 只有这几种状态会**挡住**紧随其后的同一时段新预约：
//   waiting    ：取消命令还没发出（首次点取消的那一瞬）
//   cancelling ：正在发
//   unknown    ：结果未知（可能已落云、也可能从未受理）
//   syncing    ：**已经确认落云**（settleCancel / confirmCancelled 只在云端确认成功后才标它）
//                ⇒ 云端那条预约已经真的没了，新预约可以照发，绝不能白等。
const UNRESOLVED = Object.freeze(['waiting', 'cancelling', 'unknown'])
const unresolved = row => !!row && UNRESOLVED.includes(String(row.status || ''))

module.exports = { key, list, get, begin, patch, remove, viewIndex, findByOfficialId, overlapsMoment, slotRows, unresolved }
