// 异常 → 可读文本 / 完整展开（2026-09-23 事故 §0.5.18 的第二处根因）
//
// 为什么必须有这个模块：`wx.*` 的 fail 回调给的是 `{ errMsg: 'showModal:fail …' }` ——
// 错误信息在 **errMsg** 上，**不在** `message` 上。只取 `error.message` 的话拿到 `undefined`，
// 再用 `String(error)` 兜底就得到 `[object Object]` —— 现场只剩一个"有错但不知道是什么错"，
// 等于把唯一的诊断线索自己删掉（当时报告的正是 `AUTO_CONFIRM_MODAL_FAILED | [object Object]`）。
//
// 项目里已有的正确惯例（`pages/stats/stats.js`）：`error && (error.errMsg || error.message || error.code)`。
// 本模块把它统一成两个函数：
//   · errorTextOf  → 一行人话（画到界面 / 写进弹窗）
//   · errorDetailOf → 完整展开（落盘留档，字段尽量不丢：errMsg / message / code / errno / stack / 原对象 JSON）
// 两条铁律：**永不抛错**（诊断函数自己抛错会让故障现场更黑）、**永不编造**（取不到就写"取不到"，不填假值）。
function safeJson(value) {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch (error) {
    return '<不可序列化：' + String((error && error.message) || error) + '>'
  }
}

function clip(text, max) {
  const s = String(text)
  return s.length > max ? s.slice(0, max) + '…（共 ' + s.length + ' 字）' : s
}

// 留档用：字符串截断；数字/布尔/null **原样保留**（`JSON.stringify` 会把 errno 变成 "1001"，
// 那会让"数字 1001"和"字符串 '1001'"这两种事实在留档里分不出来）；其余对象走安全 JSON。
function serialize(value) {
  const kind = typeof value
  if (kind === 'string') return clip(value, 800)
  if (kind === 'number' || kind === 'boolean' || value === null) return value
  return clip(safeJson(value), 800)
}

// 一行可读文本。顺序照微信的约定：errMsg 最准，其次 message，再次 code。
function errorTextOf(error) {
  if (error === null || error === undefined) return '未知异常（' + String(error) + '）'
  if (typeof error !== 'object') return clip(String(error), 300)
  const pick = key => {
    try {
      const value = error[key]
      return (typeof value === 'string' && value.length > 0) ? value : null
    } catch (e) { return null }
  }
  const parts = [pick('errMsg'), pick('message'), pick('code')].filter(Boolean)
  const head = parts.length ? parts.join(' ｜ ') : safeJson(error)
  const rest = clip(safeJson(error), 300)
  // 只在"原始对象确实还有信息"时才追加 —— `JSON.stringify(new Error('x'))` 是 `{}`：
  // 把 `{}` 追在 message 后面纯属噪音，会让人以为漏了什么。有内容（errMsg/errno/…）才带上。
  const hasExtra = rest && rest !== '{}' && rest !== '[]' && rest !== head
  return hasExtra ? head + ' ｜ 原始对象=' + rest : head
}

// 完整展开（给落盘用）。绝不抛错：每一项单独 try。
function errorDetailOf(error) {
  const detail = { typeofError: typeof error }
  if (error === null || error === undefined) { detail.value = String(error); return detail }
  if (typeof error !== 'object') { detail.value = clip(String(error), 500); return detail }
  try { detail.keys = Object.keys(error) } catch (e) { detail.keys = null }
  try { detail.ownNames = Object.getOwnPropertyNames(error) } catch (e) { detail.ownNames = null }
  const fields = ['errMsg', 'message', 'code', 'name', 'errno', 'errorCode', 'errCode', 'stack']
  fields.forEach(key => {
    try {
      const value = error[key]
      if (value === undefined) return
      detail[key] = serialize(value)
    } catch (e) { detail[key] = '<读取该字段时抛错>' }
  })
  detail.json = clip(safeJson(error), 1200)
  try { detail.string = clip(String(error), 300) } catch (e) { detail.string = null }
  return detail
}

module.exports = { errorTextOf, errorDetailOf, safeJson }
