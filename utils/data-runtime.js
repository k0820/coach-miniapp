const local = require('./db')
const MODE_KEY = 'coachDataSourceMode'
const CACHE_KEY = 'coachCloudActiveCache'
const SANDBOX_CACHE_KEY = 'coachSandboxActiveCache'
const CUTOVER_STATE_KEY = 'coachCloudCutoverState'
const MODES = Object.freeze({ LOCAL: 'local-primary', ACTIVATING: 'activating', PENDING: 'cutover-pending', CLOUD: 'cloud-primary' })
const ENVIRONMENTS = Object.freeze({ PRODUCTION: 'production', SANDBOX: 'sandbox' })
let currentEnvironment = ENVIRONMENTS.PRODUCTION
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
function mode() { return wx.getStorageSync(MODE_KEY) === MODES.CLOUD ? MODES.CLOUD : MODES.LOCAL }
function cutoverState() { const value = wx.getStorageSync(CUTOVER_STATE_KEY); return value && typeof value === 'object' ? clone(value) : { status: mode() === MODES.CLOUD ? MODES.CLOUD : MODES.LOCAL } }
function writesFrozen() { const status = cutoverState().status; return status === MODES.ACTIVATING || status === MODES.PENDING || status === MODES.CLOUD }
function environment() { return currentEnvironment }
function isSandbox() { return currentEnvironment === ENVIRONMENTS.SANDBOX }
function setEnvironment(value) {
  if (!Object.values(ENVIRONMENTS).includes(value)) throw new Error('无效的数据环境。')
  currentEnvironment = value
  return currentEnvironment
}
function cacheKey() { return isSandbox() ? SANDBOX_CACHE_KEY : CACHE_KEY }
// ★★ Sandbox 的权威数据源：**只有** coachSandboxActiveCache 这一份，fail closed。
//  2026-09-27 真机事故：原来 `getDB()` 第一条是 `if (mode() === LOCAL) return local.getDB()`，
//  它**完全不看 environment** ⇒ 在测试区（environment=sandbox）也能返回本机正式区库 coachDB。
//  后果是一整条链都撒谎：页面顶部明明写着「测试区 dataset xxxxxx」（那行单独 hardcode 读沙盒 cache），
//  底下渲染的却是另一本账；而且这种串线**不报错、不提示、刷新一百次也不变** ——
//  Sandbox 与 Production 的分界线在这种写法下等于不存在。
//  修复原则（用户定）：Sandbox 读取失败时**宁可明确报错**，也绝不 fallback 到 coachDB / Production。
function sandboxDB() {
  const cache = wx.getStorageSync(SANDBOX_CACHE_KEY)
  // ⭐ 尽量复用既有错误码：`CLOUD_CACHE_MISSING` 有现成的用户文案与既有契约测试在守，
  //    不要为一个已存在的语义再发明一个新码（多一个码就多一处可能没翻译的地方）。
  if (!cache || !cache.snapshot || !cache.datasetId || !Number.isInteger(cache.revision)) {
    const error = new Error('测试区还没读到云端数据，请先回到课表做一次刷新。')
    error.code = 'CLOUD_CACHE_MISSING'
    throw error
  }
  if (cache.environment !== ENVIRONMENTS.SANDBOX) {
    // 既有契约 tests/sandbox-boundary.test.js 就在守这个码，语义完全一致：**不许回落另一环境**。
    const error = new Error('缓存的数据环境与当前不一致，已阻止读取（宁可报错，也绝不退回正式区数据）。')
    error.code = 'CACHE_ENVIRONMENT_MISMATCH'
    throw error
  }
  const snapshot = clone(cache.snapshot)
  try {
    const projected = require('./local-projection').project(snapshot, { environment: ENVIRONMENTS.SANDBOX, datasetId: cache.datasetId }, cache.revision)
    if (projected) return clone(projected)
  } catch (error) {}
  return snapshot
}
function getDB() {
  // 测试区与正式区**必须分源**：测试区先走自己的权威源，一条路都不许拐到本机正式区库。
  if (isSandbox()) return sandboxDB()
  if (mode() === MODES.LOCAL) return local.getDB()
  const cache = wx.getStorageSync(cacheKey())
  if (!cache || !cache.snapshot || !cache.datasetId || !Number.isInteger(cache.revision)) { const e = new Error('当前离线缓存不可用。'); e.code = 'CLOUD_CACHE_MISSING'; throw e }
  if (isSandbox() ? cache.environment !== 'sandbox' : cache.environment === 'sandbox') { const e = new Error('缓存环境与当前数据环境不一致。'); e.code = 'CACHE_ENVIRONMENT_MISMATCH'; throw e }
  const snapshot = clone(cache.snapshot)
  // ★ 阶段 2「本机投影」：云端已确认的快照 + 还在 Outbox 里、云端还不知道的本机意图。
  //   页面读到的永远是「最后一帧已知事实」，于是「点了立刻有反应」不再需要等云端。
  //   · 只读派生：**一个字节都不写 cache**，cache 仍然是"云端那一份"，完整性校验不受影响。
  //   · 队列为空时直接返回快照（快路径，行为与阶段 1 逐字一致）。
  try {
    const projected = require('./local-projection').project(snapshot, { environment: environment(), datasetId: cache.datasetId }, cache.revision)
    if (projected) return clone(projected)
  } catch (error) {}
  return snapshot
}
function saveDB(db) {
  if (writesFrozen()) { const e = new Error('云端切换或云端主数据模式禁止页面直接写入本机 coachDB。'); e.code = 'CLOUD_PRIMARY_DIRECT_WRITE_BLOCKED'; throw e }
  return local.saveDB(db)
}
function setCutoverState(status, details = {}) {
  if (!Object.values(MODES).includes(status)) throw new Error('无效的切换状态。')
  const value = { ...clone(details), status, updatedAt: Date.now() }
  wx.setStorageSync(CUTOVER_STATE_KEY, value)
  const reread = wx.getStorageSync(CUTOVER_STATE_KEY)
  if (!reread || reread.status !== status) throw new Error('切换状态回读失败。')
  return clone(reread)
}
function activateCloudMode(cache) {
  if (!cache || !cache.datasetId || !Number.isInteger(cache.revision) || !cache.checksum || !cache.snapshot) throw new Error('云端 active cache 不完整。')
  wx.setStorageSync(CACHE_KEY, clone(cache)); const reread = wx.getStorageSync(CACHE_KEY)
  if (!reread || reread.datasetId !== cache.datasetId || reread.revision !== cache.revision || reread.checksum !== cache.checksum) throw new Error('云端 cache 回读校验失败。')
  wx.setStorageSync(MODE_KEY, MODES.CLOUD)
  if (wx.getStorageSync(MODE_KEY) !== MODES.CLOUD) throw new Error('数据源模式切换失败。')
  setCutoverState(MODES.CLOUD, { datasetId: cache.datasetId, revision: cache.revision, checksum: cache.checksum })
}
module.exports = { ...local, getDB, sandboxDB, saveDB, mode, cutoverState, writesFrozen, setCutoverState, activateCloudMode, environment, isSandbox, setEnvironment, cacheKey, MODE_KEY, CACHE_KEY, SANDBOX_CACHE_KEY, CUTOVER_STATE_KEY, MODES, ENVIRONMENTS }
