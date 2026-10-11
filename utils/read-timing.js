// 回读耗时账本（1.1.9 第 2 轮）。
//
// 为什么必须落盘：原来分段时间只堆在 ui-cloud-command 的 `timings` **内存数组**里，
// 小程序一退出就什么都没了。于是上一轮「真机同步仍然 10 秒」这个结论，只能靠
// 「离线复刻分页口径去推算往返次数」—— 那是推算，不是证据，而实测结果与推算不符。
//
// 现在每一轮回读都落一条**定长**记录进本机 Storage，下一轮真机跑完可以直接读出来：
//   排队等待 / metadata / pages / integrity / total / 页数 / revision / 结果
//
// ★ 其中「排队等待」是这一次新增的关键一列。回读排在**每条环境一条的串行航位**上，
//   而计时起点原先取在**已经进入航位之后** —— 排在写命令或上一轮回读后面干等的
//   那段时间，在旧数据里完全不存在。真机上的「10 秒」最大嫌疑恰恰就是这一段。
//
// 定长的意思：**每条记录的字段集合与顺序完全一样**，取不到的写 null / 0，
// 这样按列读就行，不必逐条猜「这条有没有那个字段」。
const KEY = 'coachReadTimings'
// 有界：只保留最近这些条，避免无上限增长把 Storage 撑爆（一条约 200 字节）。
const LIMIT = 60
// ★ 1.1.9 第 7 轮新增三列（追加在末尾，前面各列的顺序与含义一个字没改）：
//   `changesMs`           = 那一跳增量读取（`{action:'changes'}`）自己的耗时；
//   `deltaRows`           = 这一版实际回传了几行；
//   `incrementalFallback` = 增量没走成时**为什么**（空串 = 走成了）。
// 为什么必须有这三列：本轮把"下拉一次"从"整份搬"改成"只取变化"，而这**在界面上看不出来** ——
//   走成与没走成都只表现为"课表更新了"。下一轮真机上只要按 lane='user' 抓一行，
//   就能直接读出"这次是 INCREMENTAL / VERIFIED_UNCHANGED，还是退回完整读取、为什么"，
//   不必再从"总耗时好像快了点"去猜。
const FIELDS = ['seq', 'at', 'environment', 'lane', 'outcome', 'skipped', 'revision', 'calls', 'queueMs', 'metadataMs', 'pagesMs', 'integrityMs', 'cacheMs', 'totalMs', 'pages', 'pageCounts', 'changesMs', 'deltaRows', 'incrementalFallback']

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

function write(rows) {
  try { wx.setStorageSync(KEY, clone(rows.slice(-LIMIT))) } catch (error) {}
}

// 定长：无论传进来什么，落盘的那一条永远且只有 FIELDS 这些键。
function normalize(entry) {
  const source = entry || {}
  const record = {
    seq: 0,
    at: Date.now(),
    environment: String(source.environment || ''),
    lane: String(source.lane || ''),
    outcome: String(source.outcome || ''),
    skipped: source.skipped == null ? null : String(source.skipped),
    revision: Number.isInteger(source.revision) ? source.revision : null,
    calls: num(source.calls),
    queueMs: num(source.queueMs),
    metadataMs: num(source.metadataMs),
    pagesMs: num(source.pagesMs),
    integrityMs: num(source.integrityMs),
    cacheMs: num(source.cacheMs),
    totalMs: num(source.totalMs),
    pages: num(source.pages),
    pageCounts: String(source.pageCounts || ''),
    changesMs: num(source.changesMs),
    deltaRows: num(source.deltaRows),
    incrementalFallback: source.incrementalFallback == null ? '' : String(source.incrementalFallback)
  }
  const rows = list()
  record.seq = num(rows.length ? rows[rows.length - 1].seq : 0) + 1
  return record
}

// 记账**绝不抛错**：它是观测手段，不是业务路径。写失败最多丢一条观测，
// 绝不能让一次刷新因为"写日志失败"而失败。
function record(entry) {
  const record_ = normalize(entry)
  try {
    const rows = list()
    rows.push(record_)
    write(rows)
  } catch (error) {}
  // 第二通道：日志（开发者工具的 miniprogramLog 会把 console 输出留档）。
  // 两条通道互不依赖 —— 存储读不到时还能从日志里看到。只在「用户主动刷新」或「明显慢」时打，
  // 避免每条写入后的自动回读都刷一行。
  try {
    if (typeof console !== 'undefined' && console.log && (record_.lane === 'user' || record_.queueMs > 500 || record_.totalMs > 1500)) {
      console.log('[read-timing] ' + JSON.stringify(record_))
    }
  } catch (error) {}
  return record_
}

function clear() { try { wx.removeStorageSync(KEY) } catch (error) {} }

// ==================== 写命令后的「确认」账本（1.1.9 第 6 轮） ====================
// 为什么必须单独记：本轮把「命令成功 → 无条件完整分页回读」改成了「一跳只读校验，校验不过才兜底」。
// 于是真机上会出现两种形状，而它们**在界面上看不出来**：
//   · mode='lightweight' —— 只发了 1 跳 integrity，本机 cache 仍是旧的（由下一次读取补齐）；
//   · mode='full-read'   —— 校验没过，退回了完整分页回读（`fallback` 说明是哪一种不过）。
// 没有这一列，下一轮只能靠"总耗时好像快了点"来猜；有了它，一次写入一行、直接看 mode 与 confirmMs。
// 定长、有界、自吞错 —— 与读取账本同一套规矩（记账绝不抛错，绝不进业务路径）。
const WRITE_KEY = 'coachWriteTimings'
const WRITE_LIMIT = 40
const WRITE_FIELDS = ['seq', 'at', 'environment', 'command', 'mode', 'fallback', 'expectedRevision', 'revision', 'commandMs', 'refreshMs', 'confirmMs', 'totalMs']

function listWrites() {
  if (!hasStorage()) return []
  try {
    const raw = wx.getStorageSync(WRITE_KEY)
    return Array.isArray(raw) ? clone(raw) : []
  } catch (error) { return [] }
}

function recordWrite(entry) {
  try {
    const source = entry || {}
    const rows = listWrites()
    const record_ = {
      seq: num(rows.length ? rows[rows.length - 1].seq : 0) + 1,
      at: Date.now(),
      environment: String(source.environment || ''),
      command: String(source.command || ''),
      mode: String(source.confirmMode || 'unknown'),
      fallback: source.confirmFallback == null ? '' : String(source.confirmFallback),
      expectedRevision: Number.isInteger(source.confirmRevision) ? source.confirmRevision : null,
      revision: Number.isInteger(source.confirmRevision) ? source.confirmRevision : null,
      commandMs: num(source.commandMs),
      refreshMs: num(source.refreshMs),
      confirmMs: source.confirmMs == null ? null : num(source.confirmMs),
      totalMs: num(source.totalMs)
    }
    rows.push(record_)
    try { wx.setStorageSync(WRITE_KEY, clone(rows.slice(-WRITE_LIMIT))) } catch (error) {}
    try {
      if (typeof console !== 'undefined' && console.log && (record_.mode !== 'lightweight' || record_.refreshMs > 3000)) {
        console.log('[write-timing] ' + JSON.stringify(record_))
      }
    } catch (error) {}
    return record_
  } catch (error) { return null }
}

module.exports = { KEY, LIMIT, FIELDS, list, record, clear, WRITE_KEY, WRITE_LIMIT, WRITE_FIELDS, listWrites, recordWrite }
