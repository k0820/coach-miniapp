// 完课链诊断账本（1.1.9 第 2 轮）。
//
// 为什么必须有它：上一轮真机「第一次点『下课』没完成，第二次才行」，而完课链在这台机器上
// **不留任何痕迹** —— 「第一次到底走到哪一步」的八个问题，全都只能靠读代码推理。推理出的
// 结论（某个安全门拒绝）拿不到现场证据，所以既不能当根因、也不能据此改代码。
//
// 现在每一次下课点击都落一条**定长**记录，字段就是那八个问题本身：
//   branch            这一跳停在哪一个出口
//   localTxApplied    这一跳结束时**本机是否已经拿到完课事实**（本机事务生效 / 回执+重同步落地）
//   packageDelta      课时包 remaining 的实际变化量
//   incomeCreated     这次为这门课新增的收入条数
//   summaryCreated    这门课是不是在这一跳才第一次有了 summary
//   clipboardCalled   剪贴板调用有没有真的发生
//   clipboardOk       剪贴板有没有确认成功
//   waitedOfficialMs  为等正式 bookingId 花了多久
//
// 定长的意思：**每条记录的字段集合与顺序完全一样**，取不到的写 null，
// 所以「下一次真机仍失败」时，直接读出最后几条、按列看就能定位，不必再猜。
//
// ⚠️ 本模块是**纯观测**：只读投影、只写 Storage，绝不发命令、绝不改任何业务状态。
//    所有函数都不抛错 —— 诊断绝不能把业务链搞挂。
const KEY = 'coachCompletionTrace'
const LIMIT = 24
const FIELDS = ['seq', 'at', 'environment', 'datasetId', 'localKey', 'requestId', 'branch', 'localTxApplied', 'packageDelta', 'incomeCreated', 'summaryCreated', 'clipboardCalled', 'clipboardOk', 'waitedOfficialMs', 'skipped', 'note', 'durationMs']

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const hasStorage = () => typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function' && typeof wx.setStorageSync === 'function'
const bool = value => value === true ? true : value === false ? false : null
const str = value => value == null ? '' : String(value).slice(0, 160)

function list() {
  if (!hasStorage()) return []
  try {
    const raw = wx.getStorageSync(KEY)
    return Array.isArray(raw) ? clone(raw) : []
  } catch (error) { return [] }
}

function append(record) {
  try {
    const rows = list()
    rows.push(record)
    wx.setStorageSync(KEY, clone(rows.slice(-LIMIT)))
  } catch (error) {}
  try {
    if (typeof console !== 'undefined' && console.log) console.log('[completion-trace] ' + JSON.stringify(record))
  } catch (error) {}
  return record
}

function normalize(input, changes) {
  const source = input || {}, extra = changes || {}
  const rows = list()
  return {
    seq: Number((rows.length ? rows[rows.length - 1].seq : 0) || 0) + 1,
    at: Date.now(),
    environment: str(source.environment),
    datasetId: str(source.datasetId),
    localKey: str(source.localKey),
    requestId: str(source.requestId),
    branch: str(extra.branch),
    localTxApplied: bool(extra.localTxApplied),
    packageDelta: Number.isFinite(Number(extra.packageDelta)) ? Number(extra.packageDelta) : null,
    incomeCreated: Number.isFinite(Number(extra.incomeCreated)) ? Number(extra.incomeCreated) : null,
    summaryCreated: bool(extra.summaryCreated),
    clipboardCalled: bool(extra.clipboardCalled),
    clipboardOk: bool(extra.clipboardOk),
    waitedOfficialMs: Number.isFinite(Number(extra.waitedOfficialMs)) ? Number(extra.waitedOfficialMs) : null,
    skipped: extra.skipped == null ? null : str(extra.skipped),
    note: str(extra.note),
    durationMs: Number.isFinite(Number(extra.durationMs)) ? Number(extra.durationMs) : null
  }
}

// 读一份「当前投影」的可比量。只读，取不到就返回 {ok:false}（对应的差值一律记 null，
// 绝不用 0 去冒充「没有变化」——0 和「测不到」是两件完全不同的事）。
function measure(input) {
  const source = input || {}
  try {
    const { getDB } = require('./data-runtime')
    const db = getDB() || {}
    const id = str(source.officialId)
    const booking = id ? (db.bookings || []).find(item => item && item.id === id) || null : null
    const student = booking ? (db.students || []).find(item => item && item.id === booking.studentId) || null : null
    const packageId = booking && booking.packageId
    let pkg = null
    if (packageId) {
      pkg = (db.packages || []).find(item => item && item.id === packageId) || null
      if (!pkg && student) pkg = (student.packages || []).find(item => item && item.id === packageId) || null
    }
    const incomes = (db.incomes || []).filter(item => item && id && (item.bookingId === id || (item.data && item.data.bookingId === id)))
    return {
      ok: true,
      status: booking ? String(booking.status || '') : '',
      remaining: pkg && Number.isFinite(Number(pkg.remaining)) ? Number(pkg.remaining) : null,
      incomeCount: incomes.length,
      hasSummary: !!(booking && booking.summary)
    }
  } catch (error) { return { ok: false } }
}

// 开始一跳：记下「动作之前」的那一份可比重。
// officialId 允许后补（本机临时 id → 正式 id 是在链中间才定下来的），
// 定下来之后用 remeasure 再读一次「之前」即可 —— 那之前不会有任何业务写入，所以仍然成立。
function mark(input) {
  const source = input || {}
  const state = {
    environment: str(source.environment),
    datasetId: str(source.datasetId),
    localKey: str(source.localKey),
    requestId: str(source.requestId),
    officialId: str(source.officialId),
    startedAt: Date.now(),
    before: null
  }
  state.before = measure(state)
  return state
}

function remeasure(state) {
  if (!state) return null
  state.before = measure(state)
  return state.before
}

function delta(before, after, pick) {
  if (!before || !after || !before.ok || !after.ok) return null
  return pick(before, after)
}

// 收尾：落一条定长记录。`changes` 里没给的字段一律记 null（= 这一跳根本没走到那里）。
function finish(state, changes) {
  if (!state) return null
  const extra = changes || {}
  const after = measure(state)
  const before = state.before
  const record = normalize(state, {
    branch: extra.branch,
    localTxApplied: extra.localTxApplied,
    packageDelta: extra.packageDelta != null ? extra.packageDelta : delta(before, after, (b, a) => (b.remaining == null || a.remaining == null) ? null : b.remaining - a.remaining),
    incomeCreated: extra.incomeCreated != null ? extra.incomeCreated : delta(before, after, (b, a) => a.incomeCount - b.incomeCount),
    summaryCreated: extra.summaryCreated != null ? extra.summaryCreated : delta(before, after, (b, a) => !b.hasSummary && a.hasSummary),
    clipboardCalled: extra.clipboardCalled,
    clipboardOk: extra.clipboardOk,
    waitedOfficialMs: extra.waitedOfficialMs,
    skipped: extra.skipped,
    note: extra.note,
    durationMs: Date.now() - Number(state.startedAt || Date.now())
  })
  return append(record)
}

// 一步到位记一条（用于「点击被守卫拦下、压根没进链」这种情况 —— 那也是一种必须能分辨的结果）。
function note(input, changes) {
  return append(normalize(input, changes))
}

function clear() { try { wx.removeStorageSync(KEY) } catch (error) {} }

module.exports = { KEY, LIMIT, FIELDS, list, measure, mark, remeasure, finish, note, clear }
