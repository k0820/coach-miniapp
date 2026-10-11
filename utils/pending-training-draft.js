const PREFIX = 'coachPendingTrainingDrafts:'
const clone = value => JSON.parse(JSON.stringify(value))
const key = environment => PREFIX + (environment === 'sandbox' ? 'sandbox' : 'production')
const readAll = environment => {
  const value = wx.getStorageSync(key(environment))
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
function get(environment, datasetId, bookingId) {
  if (!datasetId || !bookingId) return null
  const item = readAll(environment)[bookingId]
  return item && item.datasetId === datasetId ? clone(item) : null
}
function write(environment, datasetId, bookingId, content) {
  if (!datasetId || !bookingId) throw new Error('训练草稿缺少数据集或课程标识。')
  const all = readAll(environment), prior = get(environment, datasetId, bookingId)
  const item = { datasetId, bookingId, version: (prior ? prior.version : 0) + 1, content: clone(content), submission: prior && prior.submission || null }
  all[bookingId] = item
  wx.setStorageSync(key(environment), all)
  const verified = get(environment, datasetId, bookingId)
  if (!verified || verified.version !== item.version || JSON.stringify(verified.content) !== JSON.stringify(item.content)) throw new Error('训练草稿临时保存回读失败。')
  return verified
}
function begin(environment, datasetId, bookingId, newRequestId) {
  const all = readAll(environment), item = get(environment, datasetId, bookingId)
  if (!item) return null
  if (!item.submission) {
    item.submission = { requestId: newRequestId(), version: item.version, content: clone(item.content), status: 'ready' }
    all[bookingId] = item
    wx.setStorageSync(key(environment), all)
  }
  const verified = get(environment, datasetId, bookingId)
  if (!verified || !verified.submission || verified.submission.requestId !== item.submission.requestId) throw new Error('训练草稿请求记录回读失败。')
  return verified.submission
}
function settle(environment, datasetId, bookingId, requestId, outcome) {
  const all = readAll(environment), item = get(environment, datasetId, bookingId)
  if (!item || !item.submission || item.submission.requestId !== requestId) return item
  if (outcome === 'unknown') { item.submission.status = 'unknown'; all[bookingId] = item; wx.setStorageSync(key(environment), all); return get(environment, datasetId, bookingId) }
  if (outcome === 'succeeded' && item.version === item.submission.version) delete all[bookingId]
  else { item.submission = null; all[bookingId] = item }
  wx.setStorageSync(key(environment), all)
  return get(environment, datasetId, bookingId)
}
// 取消预约 / 明确不再需要这份内容时彻底删除。
// 目的：保证「取消掉的课程」不会留下一份待提交草稿，日后被 flush 成一条孤儿 Cloud 记录。
function remove(environment, datasetId, bookingId) {
  if (!datasetId || !bookingId) return true
  const all = readAll(environment), item = all[bookingId]
  if (!item || item.datasetId !== datasetId) return true
  delete all[bookingId]
  wx.setStorageSync(key(environment), all)
  return get(environment, datasetId, bookingId) === null
}
module.exports = { get, write, begin, settle, remove, key }
