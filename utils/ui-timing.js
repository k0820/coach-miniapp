// 「安全数据已到达 → 课表立即显示」这一段的耗时账本（1.1.9 第 4 轮）。
//
// 为什么单独这一本：读取层已经有 coachReadTimings，它那一行的时刻 = **校验通过、cache 已落盘**。
// 真机上那一行出现在约 3 秒，课程块却要到约 5 秒才出现 —— 差的这约 2 秒整个都在**这一段**里，
// 而这一段原先完全没有观测点，只能靠"看上去慢"去猜。本账本把它拆成可判读的几列：
//
//   ① gapMs         = 「读取层确认完成」→「开始装载」之间的时间
//                     （客户端里这一段应当≈0；若出现几百毫秒以上，说明中间还有等待）
//   ② loadMs        = 装载本机投影（getDB + 合并待确认 + 完成度索引）花的时间
//   ③ buildMs       = 装载完 → 真正发起 setData 之间（逐格比对）花的时间
//   ④ cellsChanged  = 这一次真正变了的格子数（0 = 视图层什么都不用做）
//   ⑤ setDataBytes  = 这一次推给视图层的字节数（整屏 = 三屏 378 个格子 / 约 50KB）
//   ⑥ setDataMs     = setData 调用 → 框架回调（= 视图层真的应用完）之间的时间
//   ⑦ applied       = 这一次有没有真的推送（false = 数据没变，视图层零改动）
//
// ⚠️ 判读要点：**applied=false 且 cellsChanged=0 是"好的"**，它说明这一轮刷新在视图层
//    一次 setData 都没发（重复重绘已经被收掉）。若真机仍然慢，就看 ⑥ setDataMs ——
//    它把"视图层应用"与"我们自己算"这两件事彻底分开。
//
// 定长：每条记录的字段集合与顺序完全一样，取不到的写 null / 0，按列读即可。
const KEY = 'coachUiTimings'
// 有界：只保留最近这些条（一条约 200 字节）。
const LIMIT = 40
const FIELDS = ['seq', 'at', 'reason', 'environment', 'revision', 'gapMs', 'loadMs', 'buildMs', 'cellsChanged', 'setDataBytes', 'setDataMs', 'totalMs', 'applied']

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const hasStorage = () => typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function' && typeof wx.setStorageSync === 'function'
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0

function list() {
  if (!hasStorage()) return []
  try {
    const raw = wx.getStorageSync(KEY)
    return Array.isArray(raw) ? clone(raw) : []
  } catch (error) { return [] }
}

function normalize(entry) {
  const source = entry || {}
  const rows = list()
  return {
    seq: num(rows.length ? rows[rows.length - 1].seq : 0) + 1,
    at: Date.now(),
    reason: String(source.reason || ''),
    environment: String(source.environment || ''),
    revision: Number.isInteger(source.revision) ? source.revision : null,
    gapMs: num(source.gapMs),
    loadMs: num(source.loadMs),
    buildMs: num(source.buildMs),
    cellsChanged: num(source.cellsChanged),
    setDataBytes: num(source.setDataBytes),
    setDataMs: num(source.setDataMs),
    totalMs: num(source.totalMs),
    applied: source.applied === true
  }
}

// 记账**绝不抛错**：它是观测手段，不是业务路径。写失败最多丢一条观测，
// 绝不能让一次刷新因为"写日志失败"而失败。
function record(entry) {
  let record_ = null
  try {
    record_ = normalize(entry)
    const rows = list()
    rows.push(record_)
    try { wx.setStorageSync(KEY, clone(rows.slice(-LIMIT))) } catch (error) {}
  } catch (error) { return null }
  // 第二通道：日志（开发者工具的 miniprogramLog 会把 console 输出留档）。
  // 只在「用户主动刷新」或「明显慢」时打，避免每一条都刷一行。
  try {
    const reason = String(record_.reason || '')
    if (typeof console !== 'undefined' && console.log && (reason.indexOf('user') === 0 || record_.setDataMs > 300 || record_.gapMs > 300 || record_.totalMs > 500)) {
      console.log('[ui-timing] ' + JSON.stringify(record_))
    }
  } catch (error) {}
  return record_
}

// 调用方用这个决定"这一条值不值得落盘"：不制造噪声，也不丢掉关键证据。
// 判据：用户主动下拉（一定要留一条，用来判 gapMs / setDataMs）／真的推了东西／明显慢。
// ⚠️ 用前缀匹配而不是全等：兜底那一轮 reason 是 `user:full` / `view:full`。
function worth(entry) {
  const source = entry || {}
  return String(source.reason || '').indexOf('user') === 0 || source.applied === true || num(source.setDataMs) > 300 || num(source.gapMs) > 300 || num(source.totalMs) > 500
}

function clear() { try { wx.removeStorageSync(KEY) } catch (error) {} }

module.exports = { KEY, LIMIT, FIELDS, list, record, worth, clear }
