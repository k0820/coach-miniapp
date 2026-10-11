// 首次云端空间自动开通器（方案 A 的客户端那一半）。
//
// 目标：**全新用户第一次正常打开小程序，不用看、不用点任何「云端 / 迁移 / Activation / Candidate /
// Dataset」按钮，就自动拥有自己独立的云端空间**；之后一切照旧走已经验收通过的
// 「本机立即保存 → 持久 Outbox → 后台云同步」。
//
// —— 它只做三件事 ——
//   ① 调 `initMyCoachSpace`（幂等；服务端只认 `cloud.getWXContext().OPENID`）拿到自己的空空间；
//   ② 用**既有**的 `adapter.readActive()`（metadata → 八集合分页 → integrity → cache 回读校验）
//      把这份空间完整读回来；
//   ③ 用**既有**的 `runtime.activateCloudMode()` 切数据源。
//   —— 没有第二套写链路、没有新的切换状态机、没有新的完整性算法。
//
// —— 五条安全边界（每一条都对应一个真实事故）——
// ① **绝不碰现有用户。** 第 0 步先看 `runtime.mode()`：只要已经是 cloud-primary（或正在
//    ACTIVATING / cutover-pending），**立刻返回、一次网络调用都不发**。她本人的正式账号因此
//    永远不会被重新初始化、重新 Activation、迁移、换 dataset 或覆盖。
//    并且**只在正式数据环境下生效** —— 沙箱（诊断入口）里一个字都不做。
// ② **绝不假装成功。** 只有 `provision` 成功 **且** `readActive` 成功 **且** `activateCloudMode`
//    落地并回读确认之后，才会写 `status: 'ready'`。任何一步失败都不动数据源，只记录 + 退避等下次。
// ③ **离线/失败绝不让小程序不可用。** 失败时本机模式一个字都不变（继续本机记账，功能完整），
//    退避窗口内不再发请求；网络恢复 / 回到前台 / 下次启动会自动 `resume()` 继续补。
// ④ **本机已有业务事实 ⇒ 不切换、不上传、不迁移。** 「新用户空数据初始化 ≠ 老用户数据迁移」：
//    只要本机已经有学员/课程/收入/业绩/自定义动作，就保持本机记账（零数据丢失、零风险），
//    云端空间照常开通并**空着等它**（幂等，随时可被后续版本接管）。绝不静默把用户的数据源换掉。
// ⑤ **超时/重复/杀进程不会长出第二份空间。** 幂等由服务端的确定性 _id + 事务保证；
//    客户端这边只要"请求失败"就重新走一遍同样的幂等 `provision`，结果一定是同一个 datasetId。
//
// 本模块**不写任何业务数据**：不调 `coachBusinessCommand`、不进 `utils/mutate.js` 的写链路、
// 不写 `coachDB`、不碰 Outbox / 草稿 / 沙箱缓存。
const runtime = require('./data-runtime')
const ui = require('./ui-cloud-command')
const syncEngine = require('./sync-engine')
const local = require('./db')

const FUNCTION_NAME = 'initMyCoachSpace'
const STATE_KEY = 'coachCloudBootstrapState'
// 只有这 5 个集合算「用户已经在本机记了业务事实」。
// settings 不计入：本机空库的 settings 本来就带默认值（utils/db.emptyDB()），它不是业务事实。
const LOCAL_FACT_COLLECTIONS = Object.freeze(['students', 'bookings', 'incomes', 'sales', 'customExercises'])
const STATUS = Object.freeze({ READY: 'ready', PENDING: 'pending', BLOCKED: 'blocked-local-data' })
const BASE_DELAY_MS = 2000
const MAX_DELAY_MS = 30 * 60 * 1000
const MAX_BACKOFF_STEPS = 6

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
function readState() { try { const value = wx.getStorageSync(STATE_KEY); return value && typeof value === 'object' && !Array.isArray(value) ? value : null } catch (error) { return null } }
function writeState(patch) {
  const value = { ...(readState() || {}), ...clone(patch), updatedAt: Date.now() }
  try { wx.setStorageSync(STATE_KEY, value) } catch (error) {}
  return value
}

// 本机是否已经有业务事实。**只读**原始 coachDB —— 不走 utils/db.getDB()，
// 因为那会顺手补默认值/写回，而这里要的只是一个"有没有"的判断。
function localFacts() {
  let db = null
  try { db = wx.getStorageSync(local.KEY) } catch (error) { db = null }
  const counts = {}
  LOCAL_FACT_COLLECTIONS.forEach(name => { counts[name] = db && Array.isArray(db[name]) ? db[name].length : 0 })
  const total = LOCAL_FACT_COLLECTIONS.reduce((sum, name) => sum + counts[name], 0)
  return { total, counts, empty: total === 0 }
}

const callCloud = (name, data) => wx.cloud.callFunction({ name, data }).then(response => response && response.result)

function recordFailure(result, reason) {
  const state = readState() || {}
  const attempts = Number(state.attempts || 0) + 1
  const nextAttemptAt = Date.now() + Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, Math.min(MAX_BACKOFF_STEPS, attempts - 1)))
  writeState({ status: STATUS.PENDING, attempts, nextAttemptAt, code: result && result.code || 'BOOTSTRAP_FAILED', reason })
  return { ok: false, code: result && result.code || 'BOOTSTRAP_FAILED', message: result && result.message || '', retryLater: true, attempts, nextAttemptAt }
}

// 切换数据源：完全复用既有校验链（readActive 的完整性比对 + activateCloudMode 的回读校验）。
// 任何一步不成立就**不切换**，并且如实返回失败原因 —— 绝不让 mode 与 cache 停在"看起来成功"的中间态。
async function switchToCloudSpace() {
  let active
  try { active = await ui.adapter.readActive() } catch (error) { return { ok: false, code: 'BOOTSTRAP_ACTIVE_READ_THREW', message: String(error && error.message || error) } }
  if (!active || !active.ok) return { ok: false, code: (active && active.code) || 'BOOTSTRAP_ACTIVE_READ_FAILED', cause: active || null }
  if (!active.datasetId || !Number.isInteger(active.revision) || !active.checksum || !active.snapshot) return { ok: false, code: 'BOOTSTRAP_ACTIVE_READ_INCOMPLETE' }
  try { runtime.activateCloudMode(active) } catch (error) { return { ok: false, code: error.code || 'BOOTSTRAP_ACTIVATE_FAILED', message: String(error && error.message || error) } }
  if (runtime.mode() !== runtime.MODES.CLOUD) return { ok: false, code: 'BOOTSTRAP_MODE_VERIFY_FAILED' }
  return { ok: true, code: 'BOOTSTRAP_READY', datasetId: active.datasetId, revision: active.revision }
}

async function runOnce(reason) {
  // ① 现有用户 / 已有云端主数据 / 正在割接 —— 一次网络调用都不发。
  if (typeof runtime.mode !== 'function' || !runtime.MODES || typeof runtime.cutoverState !== 'function' || typeof runtime.activateCloudMode !== 'function') return { ok: false, code: 'BOOTSTRAP_UNAVAILABLE' }
  if (runtime.mode() !== runtime.MODES.LOCAL) return { ok: true, skipped: true, code: 'BOOTSTRAP_ALREADY_CLOUD' }
  const cutover = runtime.cutoverState()
  if (cutover && cutover.status && cutover.status !== runtime.MODES.LOCAL) return { ok: true, skipped: true, code: 'BOOTSTRAP_CUTOVER_IN_PROGRESS' }
  // ①b 只对**正式数据环境**生效。沙箱（诊断入口）里绝不自动去开通/切换任何空间 ——
  //     开通只可能建出正式那份空间，而切换在沙箱读端根本读不回来，只会白白留下一串失败记录。
  if (typeof runtime.environment !== 'function' || !runtime.ENVIRONMENTS || runtime.environment() !== runtime.ENVIRONMENTS.PRODUCTION) return { ok: true, skipped: true, code: 'BOOTSTRAP_NOT_PRODUCTION' }

  const state = readState() || {}
  // ④ 已知「本机有业务事实 + 空间已开通」：保持本机记账，零请求、零打扰。
  //    本机事实一旦被清空（重装 / 清缓存），这里就会自动放行接管。
  if (state.status === STATUS.BLOCKED && state.provisioned === true && !localFacts().empty) return { ok: false, code: 'BOOTSTRAP_LOCAL_DATA_PRESENT', blocked: true, provisioned: true, datasetId: state.datasetId || '' }
  // 退避窗口（网络恢复 / 回到前台 / 下次启动会由 resume() 主动解除）。
  if (Number(state.nextAttemptAt || 0) > Date.now()) return { ok: false, code: 'BOOTSTRAP_BACKOFF', retryLater: true, nextAttemptAt: Number(state.nextAttemptAt) }

  let provision
  try { provision = await callCloud(FUNCTION_NAME, { action: 'provision' }) }
  catch (error) { return recordFailure({ code: 'BOOTSTRAP_NETWORK_FAILED', message: String(error && (error.errMsg || error.message) || error) }, reason) }
  if (!provision || provision.ok !== true || !provision.datasetId) return recordFailure({ code: (provision && provision.code) || 'BOOTSTRAP_PROVISION_FAILED', message: (provision && provision.message) || '' }, reason)

  // ④ 本机已经有业务事实 ⇒ **不切换数据源、不上传、不迁移**。
  //    云端空间照样已经就绪（幂等），但用户的数据源与数据一个字节都不动。
  if (!localFacts().empty) {
    writeState({ status: STATUS.BLOCKED, provisioned: true, attempts: 0, nextAttemptAt: 0, datasetId: provision.datasetId, code: 'BOOTSTRAP_LOCAL_DATA_PRESENT', reason })
    return { ok: false, code: 'BOOTSTRAP_LOCAL_DATA_PRESENT', blocked: true, provisioned: true, datasetId: provision.datasetId }
  }

  const switched = await switchToCloudSpace()
  if (!switched.ok) return recordFailure(switched, reason)
  writeState({ status: STATUS.READY, provisioned: true, attempts: 0, nextAttemptAt: 0, datasetId: switched.datasetId, revision: switched.revision, provisionedDatasetId: provision.datasetId || '', code: switched.code, reason })
  // 切完立刻让界面按新数据源重绘一次（复用已有的待确认预约订阅，课表/课程页都会收到）。
  try { ui.notifyPendingBookings() } catch (error) {}
  try { syncEngine.resume() } catch (error) {}
  return { ok: true, code: 'BOOTSTRAP_READY', datasetId: switched.datasetId, revision: switched.revision }
}

// 单航班：同一时刻只有一轮。多次触发（launch / show / 网络恢复）只会复用同一轮。
let running = null
function ensure(reason = 'manual') {
  if (running) return running
  const task = runOnce(reason)
    .catch(error => ({ ok: false, code: 'BOOTSTRAP_FAILED', message: String(error && error.message || error), retryLater: true }))
    .then(result => { if (running === task) running = null; return result })
  running = task
  return task
}
// 给 app.js 用的即发即忘入口：永远返回 Promise，永不抛。
function maybeRun(reason) { try { return ensure(reason) } catch (error) { return Promise.resolve({ ok: false, code: 'BOOTSTRAP_FAILED', message: String(error && error.message || error) }) } }
// 「上一次失败的原因现在不成立了」—— 网络恢复 / 回到前台 / 进程重开。
// 只清退避时钟，不动已记录的状态与已开通的 datasetId。
function resume() {
  const state = readState()
  if (state && state.status === STATUS.PENDING && Number(state.nextAttemptAt || 0) > 0) writeState({ nextAttemptAt: 0 })
  return ensure('resume')
}
function state() { return clone(readState()) }
function isReady() { return runtime.mode() === runtime.MODES.CLOUD }
function reset() { try { wx.removeStorageSync(STATE_KEY) } catch (error) { try { wx.setStorageSync(STATE_KEY, null) } catch (inner) {} } }

module.exports = {
  FUNCTION_NAME, STATE_KEY, STATUS, LOCAL_FACT_COLLECTIONS,
  ensure, maybeRun, resume, state, isReady, reset, localFacts,
  __switchToCloudSpace: switchToCloudSpace
}
