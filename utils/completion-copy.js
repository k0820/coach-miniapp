// 「下课 + 自动复制课程内容」的**复制阶段状态机**（1.1.9）。
//
// 用户的一次点击是一个**完整动作**：完课 + 扣课 + 生成收入 + 把本节训练内容复制到剪贴板。
// 因此：
//   · 「课程已完成，但内容没进剪贴板」**不是**成功 —— 不能显示成成功；
//   · 「复制没成功」**绝不能**重跑完课 —— 那会二次扣课、二次记收入；
//   · 也不允许把补救操作甩给用户（"复制失败，请点这里重新复制"不是方案）。
//
// 本模块只负责一件事：把「完课已经成功、内容还没确认进剪贴板」这个状态
// **安全地保持在磁盘上**，然后**只**重试复制阶段本身。
// 这里从头到尾没有任何业务命令、不 require mutate、不碰 Outbox / cache ——
// 复制重试多少次都不可能造成第二次完课（由 tests/session-complete-copy.test.js 钉死）。
//
// 为什么必须有这一层：旧代码调用 wx.setClipboardData 时**不给 success / fail 回调**，
// 于是"这次到底复制成功没有"在本机根本不存在答案 —— 而 UI 要拿它当成功判据，就必先有答案。
const { rebuildSummary } = require('./cloud-command-engine')

const PREFIX = 'coachPendingContentCopy:'
// 剪贴板是**本机系统调用**，正常情况下立刻回调。但"从不回调"这种形状绝不能把整条链挂死：
// await 一个永不 settle 的 Promise 会把页面的 completing 永久钉住（用户以为还在下课）。
const CLIPBOARD_TIMEOUT_MS = 1200
// 复制阶段自己的有界重试：一次点击内最多试 3 次（与读取层同一套退避节奏）。
const STAGE_ATTEMPTS = 3
const STAGE_BACKOFF_MS = [120, 320]

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const normalizeEnvironment = environment => environment === 'sandbox' ? 'sandbox' : 'production'
const key = environment => PREFIX + normalizeEnvironment(environment)
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
    .sort((a, b) => Number(all[a].createdAt || 0) - Number(all[b].createdAt || 0))
    .map(id => clone(all[id]))
}

function get(environment, datasetId, copyKey) {
  if (!datasetId || !copyKey) return null
  const item = readAll(environment)[copyKey]
  return item && item.datasetId === datasetId ? clone(item) : null
}

// 幂等：同一门课只会有一条待复制记录。
// 文本以**第一次**记下的为准 —— 那是完课那一刻由事务（与云端同源的 handlers）算出来的那一份；
// 那节课已经结束了，之后再改课程内容也不该改写它。
// 空文本不建记录：没有内容可复制，也就永远不会"假装复制过"。
function begin(environment, datasetId, copyKey, text, requestId) {
  if (!datasetId || !copyKey) return null
  const body = String(text == null ? '' : text)
  if (!body.trim()) return null
  const all = readAll(environment), existing = all[copyKey]
  if (existing && existing.datasetId === datasetId) return clone(existing)
  const entry = {
    copyKey,
    datasetId,
    environment: normalizeEnvironment(environment),
    text: body,
    requestId: requestId || '',
    attempts: 0,
    createdAt: Date.now(),
    lastCode: '',
    lastReason: ''
  }
  all[copyKey] = entry
  writeAll(environment, all)
  const verified = get(environment, datasetId, copyKey)
  if (!verified) throw new Error('待复制内容回读失败。')
  return verified
}

function note(environment, datasetId, copyKey, changes) {
  const all = readAll(environment), item = all[copyKey]
  if (!item || item.datasetId !== datasetId) return null
  Object.assign(item, clone(changes))
  all[copyKey] = item
  writeAll(environment, all)
  return get(environment, datasetId, copyKey)
}

function remove(environment, datasetId, copyKey) {
  const all = readAll(environment), item = all[copyKey]
  if (!item) return true
  if (item.datasetId !== datasetId) return false
  delete all[copyKey]
  writeAll(environment, all)
  return get(environment, datasetId, copyKey) === null
}

// wx.* 的 fail 对象信息在 **errMsg** 上、不在 message 上。只取 message 会得到
// `String({errMsg})` = `[object Object]` —— 比不报错更坏（看着在报错，其实把唯一线索删了）。
// 取值顺序 errMsg → message → code；数字原样保留，不做字符串化。
function clipboardReason(error) {
  if (error == null) return ''
  if (typeof error === 'string') return error
  const value = error.errMsg || error.message || error.code
  if (value != null) return String(value)
  try { return JSON.stringify(error) } catch (caught) { return String(error) }
}

// 把内容写进剪贴板。**必须拿到明确结论**：ok / 失败原因。
// `called` 单独一列："平台压根没有这个接口"（没调用）与"调用了但失败/超时"是两件完全不同的事，
// 完课诊断记录要能分辨 —— 前者是本机环境问题，后者才可能是剪贴板本身的偶发问题。
function writeClipboard(data) {
  return new Promise(resolve => {
    if (typeof wx === 'undefined' || typeof wx.setClipboardData !== 'function') return resolve({ ok: false, called: false, code: 'CLIPBOARD_UNAVAILABLE' })
    let settled = false, timer = null
    const finish = value => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(value) }
    timer = setTimeout(() => finish({ ok: false, called: true, code: 'CLIPBOARD_TIMEOUT' }), CLIPBOARD_TIMEOUT_MS)
    try {
      wx.setClipboardData({
        data: String(data == null ? '' : data),
        success: () => finish({ ok: true, called: true }),
        fail: error => finish({ ok: false, called: true, code: 'CLIPBOARD_WRITE_FAILED', reason: clipboardReason(error) })
      })
    } catch (error) { finish({ ok: false, called: true, code: 'CLIPBOARD_WRITE_FAILED', reason: clipboardReason(error) }) }
  })
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// 一次复制尝试：先记账（又试了一次），再写剪贴板；成功才撤掉待复制记录。
// **只有成功才 remove** —— 失败时记录留着，等于"这次下课操作还没完整完成"这个状态被如实保留。
async function attemptOnce(environment, datasetId, copyKey) {
  const entry = get(environment, datasetId, copyKey)
  if (!entry) return { ok: true, copied: false, called: false, code: 'COPY_NOT_PENDING' }
  const result = await writeClipboard(entry.text)
  note(environment, datasetId, copyKey, {
    attempts: Number(entry.attempts || 0) + 1,
    lastCode: result.ok ? 'COPIED' : (result.code || ''),
    lastReason: result.ok ? '' : (result.reason || '')
  })
  if (!result.ok) return { ok: false, copied: false, called: !!result.called, code: result.code || 'CLIPBOARD_WRITE_FAILED', reason: result.reason || '' }
  remove(environment, datasetId, copyKey)
  return { ok: true, copied: true, called: true, code: 'COPIED' }
}

// 复制阶段的有界重试（一次点击内）。**只重试剪贴板**，绝不重跑任何业务命令。
async function flush(environment, datasetId, copyKey, options = {}) {
  const tries = Math.max(1, Number(options.tries) || STAGE_ATTEMPTS)
  let last = null
  for (let index = 0; index < tries; index++) {
    if (index) await wait(STAGE_BACKOFF_MS[index - 1] || 0)
    last = await attemptOnce(environment, datasetId, copyKey)
    if (last.ok) return last
    // 「平台根本没有这个接口」是**确定性**失败：重试多少次结果都一样，
    // 唯一的效果是白等 440ms 退避（还让整条完成链多跨两个定时器）。
    // 只对"可能下次就好了"的失败重试；确定性失败立刻停手 —— 记录照样留着，恢复轮仍在。
    if (last.code === 'CLIPBOARD_UNAVAILABLE') return last
  }
  return last || { ok: false, copied: false, called: false, code: 'CLIPBOARD_WRITE_FAILED' }
}

// 跨页面恢复：在任意一次页面显示时，把还挂着的待复制内容各补一次（每次只试一次，绝不猛打）。
// 只碰剪贴板。返回真正补成功的那几条，调用方据此决定要不要提示。
async function resumePending(environment, datasetId, options = {}) {
  const rows = list(environment, datasetId)
  const copied = []
  for (const row of rows) {
    if (rows.length > 1 && options.spacingMs) await wait(options.spacingMs)
    const result = await attemptOnce(environment, datasetId, row.copyKey)
    if (result.ok && result.copied) copied.push(row.copyKey)
  }
  return { ok: true, copied }
}

// ———————— 复制文本 ————————
// ★ 1.1.9 第 7 轮：**不再带学员姓名**。用户要把这段贴进正式聊天里，姓名单独占一行是多余的，
//   而且摘要第一行本来就是 `⏰ 9月23日 星期三` —— 去掉姓名之后，复制出来的东西**第一行就是日期**。
// ⚠️ 函数签名保留第二个位置但**有意不使用它**：调用方（pages/session/session.js）仍在传
//    studentName，本轮**不动那一行** —— 复制文本的改动与完课链路的改动分开，
//    真出问题时能一眼看出是哪一边引起的。
// ⚠️ 日期 / 星期 / 时间 / 训练部位 / 动作 / 组数次数 / 备注的格式**一个字都没改**：
//    它们全部由 `rebuildSummary` 或事务里已经落库的那份 summary 决定，本函数只做原样透传。
//
// 摘要的权威来源 = booking.summary —— 它由与云端同源的 handlers（cloud-command-engine
// 的 completeBooking → rebuildSummary）在完课那一刻写进投影，与云端落库的那一份逐字一致。
// 只有摘要取不到时（例如预约还没转正、本机事务这次是"延后执行"）才就地按**同一份规则**重建：
// 规则来自 rebuildSummary 本身，绝不另写第二套格式。
//   ⚠️ 页面里那份旧 buildSummary 的缺省分类是「综合训练」，而 handlers 是「常规训练」——
//      差两个字就是两份不一致的课程数据。所以这里不接它。
function buildCopyText(booking) {
  if (!booking || typeof booking.date !== 'string' || !booking.date) return ''
  let body = typeof booking.summary === 'string' && booking.summary ? booking.summary : ''
  if (!body) { try { body = rebuildSummary(booking) } catch (error) { body = '' } }
  if (!body) return ''
  return body
}

module.exports = { key, list, get, begin, note, remove, flush, resumePending, attemptOnce, writeClipboard, clipboardReason, buildCopyText, STAGE_ATTEMPTS }
