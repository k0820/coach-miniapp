// 「完成课程」的即时响应记录（本机有待确认完课的唯一真相）。
// 只写本机 Storage，永远不写 coachCloudActiveCache / coachSandboxActiveCache，也不写 coachDB。
// 严格按 environment（production / sandbox）+ activeDatasetId 隔离。
//
// 为什么必须单独存一份：
//  完课会改动真实财务事实（booking done / 课时包精确扣 1 / Income 恰好 1 条）。
//  这些事实在云端确认前绝不能写进 cache —— 否则看板金额、提成、出勤统计都会算上一条还没成立的课程。
//  但用户点「完成」又必须立刻有反应。所以：UI 立刻结束编辑并返回课表，本机只留一条「完课意图」标记，
//  正式事实仍然只由云端事务产生；事务成功回读后 cache 才有这条 done，标记随之清除。
const PREFIX = 'coachPendingCompletions:'
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

// 幂等：同一个课程（localKey）重复进入完课流程时，复用已有的固定 requestId，绝不生成第二个。
function begin(environment, datasetId, localKey, officialId, newRequestId, startedAt) {
  if (!datasetId || !localKey) throw new Error('完课记录缺少数据集或课程标识。')
  const all = readAll(environment), existing = all[localKey]
  if (existing && existing.datasetId === datasetId) return { created: false, entry: clone(existing) }
  const entry = {
    localKey,
    datasetId,
    environment: environment === 'sandbox' ? 'sandbox' : 'production',
    officialId: officialId || '',
    requestId: newRequestId(),
    status: 'completing',
    attempt: 0,
    startedAt
  }
  all[localKey] = entry
  writeAll(environment, all)
  const verified = get(environment, datasetId, localKey)
  if (!verified || verified.requestId !== entry.requestId) throw new Error('完课记录回读失败。')
  return { created: true, entry: verified }
}

// patch 必须带 requestId：防止上一轮（例如已失败并换过一轮）的收尾动作改到新一轮的记录。
function patch(environment, datasetId, localKey, requestId, changes) {
  const all = readAll(environment), item = all[localKey]
  if (!item || item.datasetId !== datasetId || item.requestId !== requestId) return null
  Object.assign(item, clone(changes))
  all[localKey] = item
  writeAll(environment, all)
  const verified = get(environment, datasetId, localKey)
  if (!verified || verified.requestId !== requestId) throw new Error('完课记录更新回读失败。')
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

// 课表视图层用：把记录摊平成「哪些块已经有本机完课意图」。
// 有意图的块必须按**已完成**呈现（与正式 done 逐字一致），而它的财务事实仍然只由云端事务产生。
// 未转正时课程块挂在 pending:<bookingKey> 上，转正后挂在正式 bookingId 上，两边都要能命中。
function viewIndex(environment, datasetId) {
  const rows = list(environment, datasetId)
  return {
    officialIds: rows.filter(row => row.officialId).map(row => row.officialId),
    localKeys: rows.map(row => row.localKey)
  }
}

// 「这门课在本机是否已经有完课意图」——课程页与课表都靠它决定呈现。
// 前一版只有课表把它当标签用，于是「刚下课 / 云端结果还没落地」的窗口里，
// 课程页仍然只看正式 cache，把一门已经完成的课当成待完成的课（真机误报的根因）。
// 匹配两种身份：正式 bookingId，或本机编辑态用的 pending:<业务键>。
function intentFor(environment, datasetId, officialId, localKey) {
  if (!datasetId || (!officialId && !localKey)) return null
  const rows = list(environment, datasetId)
  if (officialId) {
    const hit = rows.find(row => row.officialId && row.officialId === officialId)
    if (hit) return hit
  }
  if (localKey) {
    const hit = rows.find(row => row.localKey === localKey)
    if (hit) return hit
  }
  return null
}

module.exports = { key, list, get, begin, patch, remove, viewIndex, intentFor }
