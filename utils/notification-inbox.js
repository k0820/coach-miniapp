// ─────────────────────────────────────────────────────────────────────────────
// 📥 站内消息中心的**客户端**出入口（2026-10-06 需求五 / 需求六）
//
// ⭐⭐ 为什么要有它：微信「一次性订阅」**一条授权只够一条提醒**（已在公众平台核实：
//    长期订阅页面显示「暂时没有可选用的模板」）⇒ 微信**不可能**保证双方每次都收到。
//    ⇒ 站内消息才是"不限次数、不漏消息"的那一条路：预约 / 取消 / 改期 / 排课 / 完课
//      都会给**双方各写一条**独立消息，⛔ 微信没额度时站内消息**照旧存在**。
//
// ⛔⛔ 四条硬纪律：
//   ① **只走测试区云函数**：云函数名**一律**由 `sandbox-cloud-functions` 路由表给出
//      （⛔ 本页面不许出现任何云函数名硬编码 —— 隔离护栏会静态扫描）。
//   ② **正式区不显示这个入口**：集合与读取通道**只部署在测试区** ⇒ `available()` 为假时
//      页面必须把入口**整个藏起来**，⛔ 绝不显示一个点了就报错的按钮。
//   ③ **收件人由服务端定**：客户端只传"我在看会员端还是教练端"（`kind`），
//      ⛔ **绝不**提交 openId / coachId / memberId —— 那是服务端按 OPENID 反查的事。
//   ④ **读失败不许炸页面**：未读数拿不到就显示 0，⛔ 绝不因为一个附属功能把整页搞崩。
// ----------------------------------------------------------------------------
const runtime = require('./data-runtime')
const routing = require('./sandbox-cloud-functions')

const environment = () => (runtime.environment() === 'sandbox' ? 'sandbox' : 'production')

// ⛔ 站内消息中心**只部署在测试区**（正式区集合与读通道都没有）⇒ 正式区一律不显示入口。
function available() { return environment() === 'sandbox' }

const PAGE = '/pages/notification-inbox/notification-inbox'

// ⛔ 云函数名**只从路由表取**（隔离护栏 §⑧：页面源码里不许出现 Sandbox 函数名）。
function call(op, kind, ids) {
  const options = { environment: environment(), action: 'inbox', kind, op }
  if (Array.isArray(ids) && ids.length) options.ids = ids
  return wx.cloud.callFunction({ name: routing.businessFunction(environment()), data: options })
    .then(result => (result && result.result) || result || {})
}

async function list(kind) {
  if (!available()) return { ok: false, code: 'SANDBOX_ONLY', unread: 0, rows: [] }
  try {
    const result = await call('list', kind)
    if (!result || result.ok !== true) return { ok: false, code: (result && result.code) || 'INBOX_READ_FAILED', unread: 0, rows: [] }
    return { ok: true, unread: Number(result.unread || 0), rows: Array.isArray(result.rows) ? result.rows : [] }
  } catch (error) {
    return { ok: false, code: 'INBOX_READ_FAILED', unread: 0, rows: [] }
  }
}

// 🔴 未读数量（首页 / 我的 / 统计页的红点用）。⛔ 拿不到就回 0，绝不假装"有未读"。
async function unread(kind) {
  const result = await list(kind)
  return Number(result.unread || 0)
}

async function markRead(kind, ids) {
  if (!available()) return { ok: false, changed: 0 }
  try {
    const result = await call('read', kind, ids)
    return { ok: result && result.ok === true, changed: Number((result && result.changed) || 0), unread: Number((result && result.unread) || 0) }
  } catch (error) {
    return { ok: false, changed: 0 }
  }
}

function open(kind) {
  wx.navigateTo({ url: `${PAGE}?role=${kind === 'member' ? 'member' : 'coach'}` })
}

// 🧾 列表页的视图模型（纯函数）：把服务端下发的行变成界面能直接渲染的形状。
function rowsView(rows) {
  const list = Array.isArray(rows) ? rows : []
  return list.map(row => ({
    id: String((row && row.id) || ''),
    title: String((row && row.title) || '课程变动'),
    body: String((row && row.body) || ''),
    timeText: timeTextOf(row && row.createdAt),
    read: !!(row && row.read),
    // ⛔ 谁收到的（操作者本人 / 另一方）要让用户一眼分清 ⇒ 给一句人话标签。
    audienceText: (row && row.audience) === 'actor' ? '你的操作' : '对方操作'
  }))
}

function pad(value) { return String(value).padStart(2, '0') }
function timeTextOf(at) {
  const time = Number(at || 0)
  if (!time) return ''
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

module.exports = { available, environment, list, unread, markRead, open, rowsView, timeTextOf, PAGE }
