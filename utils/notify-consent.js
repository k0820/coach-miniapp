// 🔔 微信**订阅消息**的"用户主动授权"入口（2026-10-05 用户最终决定：**只要 3 个模板**）
//
// ⭐⭐ 微信的三条硬规则（本模块绕不开，也绝不能假装绕开）：
//   ① **只能由用户自己点按钮授权** ⇒ 这里**绝不**在 `onLoad` / `onShow` 里偷偷调用
//      `wx.requestSubscribeMessage`（那是骚扰，微信也不允许）⇒ 只暴露方法，页面在 `bindtap` 里调。
//      （tests/member-notify-subscribe.test.js 用源码锚钉死了"不许自动调用"。）
//   ② **一次调用最多带 3 个模板** ⇒ 本轮正好 3 个，一次弹窗全部申请完。
//   ③ **点一次「允许」= 这个模板只换来一条推送机会**（一次性订阅的默认规则）。
//      ⇒ 详见文件末尾的 `QUOTA_NOTE`（界面与文档都引用它，避免各处说法不一致）。
//      ⚠️ 「能不能走长期订阅」**本轮没有在用户自己的微信后台实际核对过**，所以这里**不下结论**：
//          只有在后台「订阅消息」里真的看到"长期订阅"入口才算数；在此之前一律按一次性的规则设计，
//          ⛔ 绝不对外宣称"一次同意以后一直能发"，也绝不宣称"一定拿不到长期订阅"。
//
// ⛔⛔ 模板 ID 必须与云端 `cloudfunctions/*/notify-templates.js` 的 `TEMPLATE_IDS` **逐字一致**
//    （那条测试比对客户端与云端两份文件）。
//    ⛔ 空串 = 微信后台还没选用到模板 ⇒ 按钮必须如实说"模板还没配置"，⛔ 绝不说"已开启"。
//
// ⛔ 「点了开启按钮」**不等于**「通知已经开启」：只有微信回调里明确 `accept` 才算同意。
//    本模块把这件事翻译成 5 种状态，界面照实显示，⛔ 一种都不许美化。
// 🆔 微信后台「订阅消息 → 我的模板」里**真实存在**的 3 个模板 ID（2026-10-05 用户提供）。
//   ⛔ 必须与云端 `cloudfunctions/*/notify-templates.js` 的 `TEMPLATE_IDS` **逐字一致**（测试钉死）。
const TEMPLATE_IDS = Object.freeze({
  'course-status': 'KaiavgpdRZYNKJgKZLMw64M4RdtMvSLCB-q0KUKhhF8',   // 预约状态提醒（6 种情况共用）
  'reminder-3h': '0-SPkXsTnOR1N2ZIl8wcwzJefIKuufNqjXrsi_-ilR8',     // 日程提醒（上课前 3 小时）
  'reminder-1h': 'C64-zL8lSAr0rzfEyGokYBkVDMnAOzgDxb-3bLOjiF4'      // 活动开始提醒（上课前 1 小时）
})

// 🎯 教练与会员**申请的都是这 3 个**（⛔ 不会因为你是教练就少申请一个：
//    课前提醒是"教练和会员各收一条"，两边都得有额度）。
const TYPES_FOR_COACH = Object.freeze(['course-status', 'reminder-3h', 'reminder-1h'])
const TYPES_FOR_MEMBER = Object.freeze(['course-status', 'reminder-3h', 'reminder-1h'])
const ALL_SLOTS = Object.freeze(['course-status', 'reminder-3h', 'reminder-1h'])

const configuredIds = slots => slots.map(slot => String(TEMPLATE_IDS[slot] || '')).filter(Boolean)

function tmplIdsFor(kind) {
  return configuredIds(kind === 'member' ? TYPES_FOR_MEMBER : TYPES_FOR_COACH)
}

// 📋 界面要显示的配置状态。⛔ `configured=false` 时必须如实显示"还没配置"，绝不显示"已开启"。
function stateOf(kind) {
  const ids = tmplIdsFor(kind)
  return {
    configured: ids.length === ALL_SLOTS.length,
    count: ids.length,
    total: ALL_SLOTS.length,
    missing: ALL_SLOTS.filter(slot => !String(TEMPLATE_IDS[slot] || ''))
  }
}

const MESSAGE_NOT_CONFIGURED = '课程提醒模板还没在微信后台配置好，暂时无法开启。'

// 🗣️ 「额度用完了」的人话。⛔ 绝不能说成"已订阅成功 / 已开启"。
//    ⛔ 一次性订阅的规则就是这么硬：**一个模板同意一次，只够发一条**。
const NEED_REAUTHORIZE_TEXT = '提醒次数用完了，需要重新点一次「开启课程提醒」才能继续收到。'
const NEED_REAUTHORIZE_SHORT = '需要重新允许课程提醒'

// 🗣️ 六种状态的人话（⛔ 不许把错误码直接显示给用户）
const STATUS_TEXT = Object.freeze({
  agreed: '已同意，课程有变动或快上课时会收到微信提醒。',
  rejected: '你选择了不接收，小程序其他功能不受影响。',
  'not-configured': MESSAGE_NOT_CONFIGURED,
  'wechat-denied': '微信当前不允许向这个账号发送这类提醒。',
  'network-failed': '网络不太好，没能完成开启，可以稍后再点一次。',
  cancelled: '你取消了这次开启，可以稍后再点一次。',
  'quota-exhausted': NEED_REAUTHORIZE_TEXT
})

// 🚦 in-flight guard（请求进行中保护，2026-10-08 · 1.3.39）
//
// ⭐⭐ 真机事故：会员点「约一节课」后连弹**两个** toast ——
//   ①「已允许下一条微信提醒」 ②「网络不太好，稍后可再点一次」。
//   成因：第一次点击后页面**没有任何反馈**（因为下面那个 `await` 把跳转挡住了），
//   用户以为没点上 ⇒ **又点了一次** ⇒ 第二次 `wx.requestSubscribeMessage` 被微信直接拒
//   （同一模板短时间内重复申请）⇒ 翻译成 `network-failed` ⇒ 第二个 toast。
//
// ⛔⛔ 这道闸的**唯一职责**是"同一次点击周期内只允许一个授权请求"，
//   ⛔ 它绝不能变成主业务导航的锁 —— 导航**先发生**，授权爱等多久等多久。
let inflight = null
let inflightRole = ''

// 🧪 仅供测试复位（连续两次点击的判据要能独立跑）。
function resetInflight() { inflight = null; inflightRole = '' }
const inflightState = () => ({ pending: !!inflight, role: inflightRole })

// 🙋 用户点「开启课程提醒」⇒ 才弹微信的授权框。
//   ⛔ 返回**如实**的结果：没配置就回 `TEMPLATE_NOT_CONFIGURED`（不弹窗、不假成功）。
//   ⛔ 已经有同一个角色的请求在飞 ⇒ **复用**那一个 promise（不再重复弹、也不会被微信判重复申请）。
function requestConsent(kind) {
  const role = kind === 'member' ? 'member' : 'coach'
  const ids = tmplIdsFor(kind)
  if (ids.length !== ALL_SLOTS.length) {
    return Promise.resolve({ ok: false, status: 'not-configured', code: 'TEMPLATE_NOT_CONFIGURED', message: MESSAGE_NOT_CONFIGURED })
  }
  if (typeof wx === 'undefined' || typeof wx.requestSubscribeMessage !== 'function') {
    return Promise.resolve({ ok: false, status: 'network-failed', code: 'SUBSCRIBE_API_MISSING', message: STATUS_TEXT['network-failed'] })
  }
  // ⛔ 同一个角色已有在飞的请求 ⇒ 直接复用，⛔ 绝不发起第二次（微信会拒，用户会看到"网络不太好"）。
  if (inflight && inflightRole === role) return inflight
  inflightRole = role
  inflight = new Promise(resolve => {
    wx.requestSubscribeMessage({
      tmplIds: ids,
      success: result => resolve(translate(kind, result || {})),
      fail: error => resolve({ ok: false, status: failStatusOf(error), code: 'SUBSCRIBE_REQUEST_FAILED', message: STATUS_TEXT[failStatusOf(error)] })
    })
  }).then(outcome => {
    if (inflightRole === role) { inflight = null; inflightRole = '' }
    return outcome
  }, () => {
    if (inflightRole === role) { inflight = null; inflightRole = '' }
    return { ok: false, status: 'network-failed', code: 'SUBSCRIBE_REQUEST_FAILED', message: STATUS_TEXT['network-failed'] }
  })
  return inflight
}

// 🔍 把微信的回调翻译成我们自己的 5 种状态。
//   `accept`  = 用户同意（⛔ 只有这个才算"已开启"）
//   `reject`  = 用户拒绝
//   `ban`     = 微信不允许（该模板被封禁）
//   `filter`  = 模板被系统过滤（通常是模板标题与其他模板重复）
function translate(kind, result) {
  // ⭐ 从**回调对象本身**读答案（而不是"我先知道申请了哪几个 ID"）：
  //   `wx.requestSubscribeMessage` 的 success 回调形状就是 `{ [模板ID]: 'accept'|'reject'|'ban'|'filter' }`，
  //   直接读它最不容易漂移；顺带让这个函数在模板还没配置时也能被单独测试。
  const known = ['accept', 'reject', 'ban', 'filter']
  const answers = Object.keys(result || {}).map(key => String(result[key] || '')).filter(value => known.indexOf(value) >= 0)
  if (!answers.length) answers.push(...tmplIdsFor(kind).map(id => String((result && result[id]) || '')))
  if (answers.some(value => value === 'ban' || value === 'filter')) {
    return { ok: false, status: 'wechat-denied', code: 'SUBSCRIBE_BANNED', message: STATUS_TEXT['wechat-denied'], detail: answers }
  }
  if (answers.some(value => value === 'accept')) {
    return { ok: true, status: 'agreed', code: 'SUBSCRIBE_ACCEPTED', message: STATUS_TEXT.agreed, detail: answers }
  }
  if (answers.some(value => value === 'reject')) {
    return { ok: false, status: 'rejected', code: 'SUBSCRIBE_REJECTED', message: STATUS_TEXT.rejected, detail: answers }
  }
  return { ok: false, status: 'rejected', code: 'SUBSCRIBE_REJECTED', message: STATUS_TEXT.rejected, detail: answers }
}

function failStatusOf(error) {
  const text = String((error && error.errMsg) || '')
  if (/cancel/i.test(text)) return 'cancelled'
  return 'network-failed'
}

// 🧾 把授权结果翻译成一句人话（⛔ 不许把错误码显示给用户）
function explainOf(outcome) {
  if (!outcome) return ''
  return outcome.message || STATUS_TEXT[outcome.status] || '暂时没能开启，可以稍后再试。'
}

// ─────────────────────────────────────────────────────────────────────────────
// 🆔 2026-10-06：**长期订阅已核实完毕**（结论由用户在**微信公众平台亲自查看**后定稿）
//
// ✅ 事实：公众平台的「长期订阅」页面显示「**暂时没有可选用的模板**」
//    ⇒ 当前这 3 个模板**全部是一次性订阅**，⛔ 不存在长期订阅这条路。
//    ⇒ 因此本模块**不再**标 `pending-user-confirm`，也**不再**要求用户提供长期模板 ID。
//
// 📌 最终方案（用户拍板，三步走）：
//   ① 微信通知 = **一次性订阅**：一次同意只够下一条提醒；
//   ② **常用业务按钮顺便申请下一条**：预约 / 取消 / 改期 / 排课 / 完课之后顺手拿到下一次额度；
//      ⛔ 拒绝**绝不**阻断原来的预约 / 取消 / 改期（见 `requestNextAfterAction`）。
//   ③ **站内消息中心**保证**不限次数、不漏消息**（⛔ 微信没额度时站内消息照旧存在）。
//
// ⛔⛔ 硬性禁止词（由 tests 静态扫描钉死）：`已开启` / `永久开启` / `长期有效` / `一直能收到`
//      —— 一次性订阅的额度是**一条**，把这些词写在按钮上就是欺骗。
// ✅ 三个槽位**都是一次性订阅**（2026-10-06 公众平台实测结论，不再标"待确认"）。
const LONG_TERM = Object.freeze({
  'course-status': 'one-time-only',
  'reminder-3h': 'one-time-only',
  'reminder-1h': 'one-time-only'
})
const LONG_TERM_PENDING = 'pending-user-confirm'
const LONG_TERM_CONFIRMED = 'confirmed'
const LONG_TERM_ONE_TIME = 'one-time-only'
// 📌 结论**已经核对过**：后台长期订阅页面显示「暂时没有可选用的模板」⇒ 只有一次性订阅。
//    ⛔ 不许再写"待你在微信公众平台确认"（那是**没核实**时的说法，现在已经有证据了）。
const LONG_TERM_NOTE = '已在微信公众平台核对过：长期订阅页面显示「暂时没有可选用的模板」,' +
  '所以这 3 个模板都是一次性订阅 —— 一次同意只够下一条提醒。' +
  '每次预约 / 取消 / 改期 / 排课后可以再点一次，拿到下一条的额度；' +
  '站内消息中心不受次数限制，任何时候都能看到全部消息。'
const FORBIDDEN_PERMANENT_WORDS = Object.freeze(['已开启', '永久开启', '长期有效', '一直能收到', '以后都能收到'])
// ⛔ 按钮文案**只有这一句**（一次性订阅的默认事实）。⛔ 任何页面不许改写成"已开启"。
const BUTTON_TEXT = '允许下一条微信提醒'
// ⛔ 拒绝过之后要走微信设置页（⛔ 不许写"已开启"，也不许假装还能直接弹授权框）。
const OPEN_SETTING_TEXT = '去微信设置重新打开'
// ⛔ 额度已经被用掉之后的提示（⛔ 不许写成"已开启 / 仍然开启"）。
const QUOTA_USED_TEXT = '下一条提醒需要重新允许'
// 🔁 业务按钮（预约 / 取消 / 改期 / 排课 / 完课）**顺便**申请下一条额度的按钮文案。
const AFTER_ACTION_BUTTON_TEXT = '刷新课表并允许下一条提醒'
// 🤫 业务操作之后那一次"顺便申请"的结果提示（⛔ 一句话，⛔ 绝不写"已开启 / 永久开启"）。
const ACTION_HINT = Object.freeze({
  agreed: '已允许下一条微信提醒',
  rejected: '没允许微信提醒，站内消息仍会通知',
  cancelled: '没允许微信提醒，站内消息仍会通知',
  'quota-exhausted': QUOTA_USED_TEXT,
  'not-configured': '微信提醒模板还没配置好',
  'wechat-denied': '微信不允许发这类提醒',
  'network-failed': '网络不太好，稍后可再点一次'
})

// 👤 身份口径（⛔ 会员与教练是**两套独立授权**，⛔ 绝不共用一个开关）
const ROLE_TEXT = Object.freeze({ member: '会员', coach: '教练' })
// ⛔ "谁会收到哪些消息"必须分开写清楚：一方授权**绝不**代表另一方也能收到。
const ROLE_SCOPE = Object.freeze({
  member: '这里的授权**只**控制你自己手机上收到的提醒；教练要在他自己的手机上再点一次。',
  coach: '这里的授权**只**控制你自己手机上收到的提醒；会员要在她自己的手机上再点一次。'
})

// 📌 一次性订阅额度的**大白话说明**（界面 `hint` 与文档都引用这一份，避免各处口径不一致）
//
// ⛔⛔ 三条必须写清楚、一条都不许含糊（2026-10-05 用户逐条指定的口径）：
//   ① **一个模板同意一次，只够发送一次**（不是"开一次以后一直能收"）；
//   ② **教练和会员要分别授权**：教练自己点的只给自己发，会员自己点的只给会员发；
//   ③ **状态通知发过一次之后，下一次预约 / 取消 / 改期要重新拿到这个模板的授权**；
//      3 小时和 1 小时提醒各自消耗**自己那个模板**的一次授权（互不串用）。
const QUOTA_NOTE = '一个模板同意一次，只够发一条。' +
  '课程状态、上课前3小时、上课前1小时是三个不同的模板，各算各的。' +
  '教练和会员要分别点一次「开启课程提醒」。' +
  '状态通知发过一次之后，下次预约、取消或改期要重新允许一次。'

// 🏷️ 三个模板在界面上的中文名（⛔ 用微信后台模板的用途起名，不用字段名）
const SLOT_NAMES = Object.freeze({
  'course-status': '课程状态通知（预约 / 取消 / 改期）',
  'reminder-3h': '课前 3 小时提醒',
  'reminder-1h': '课前 1 小时提醒'
})

// 🔧 拒绝过之后再点 ⇒ 去微信设置页重新打开。
//   ⛔ 必须**由用户点击**触发（⛔ 页面打开时绝不自动调用 —— 那是骚扰，微信也不允许）。
//   ⛔ 打开设置页**不等于**已经授权：回来之后必须**重新读一次状态**（由页面 `onShow` 负责）。
function openSetting() {
  if (typeof wx === 'undefined' || typeof wx.openSetting !== 'function') {
    return Promise.resolve({ ok: false, status: 'network-failed', code: 'OPEN_SETTING_API_MISSING', message: STATUS_TEXT['network-failed'] })
  }
  return new Promise(resolve => {
    wx.openSetting({
      success: () => resolve({ ok: true, status: 'settings-opened', message: '已经打开微信设置，改完回来这一页会自动刷新。' }),
      fail: () => resolve({ ok: false, status: 'cancelled', code: 'OPEN_SETTING_FAILED', message: '没有打开微信设置页，可以稍后再点一次。' })
    })
  })
}

// 🔁 业务按钮**顺便**申请下一条微信提醒（2026-10-06 需求五）
//
// ⛔⛔ 三条铁律：
//   ① **绝不阻断原业务**：授权请求与业务动作由同一次真实点击发起，但业务动作不等待授权结果；
//      点了“不允许”或授权层异常，课仍照旧预约 / 取消。
//   ② **必须由用户这次点击带出来**：不是页面打开就弹、也不是循环弹（⛔ 微信不允许，也是骚扰）。
//   ③ **拒绝也不算错**：只是这一次没拿到额度 ⇒ 站内消息中心**照旧**会通知到。
function requestNextAfterAction(role, options) {
  // 🤫 `quiet: true` = **一句话都不弹**（用于"点了按钮要跳走"的场景：
  //    用户已经不在这一页了，弹一个 toast 只会让人以为跳转失败了）。
  const quiet = !!(options && options.quiet)
  return requestConsent(role === 'member' ? 'member' : 'coach').then(outcome => {
    const text = quiet ? '' : (ACTION_HINT[String(outcome && outcome.status || '')] || '')
    if (text && typeof wx !== 'undefined' && typeof wx.showToast === 'function') wx.showToast({ title: text, icon: 'none' })
    return outcome
  }, () => null)
}

// 把“一次性提醒授权”接到真实业务按钮上，同时保持原业务的返回值与执行时机。
// 微信要求订阅弹层必须由用户点击直接触发，所以不能等保存成功后再补调；
// 这里先同步发起授权，再立刻执行 action，绝不 await、绝不让授权失败卡住业务。
function runBusinessTap(role, action) {
  try { requestNextAfterAction(role, { quiet: true }) } catch (error) { /* 授权永远不能阻断业务 */ }
  return typeof action === 'function' ? action() : undefined
}

// 🧾 统一通知设置页的**视图模型**（纯函数，不碰 wx、不写数据）
//   ⛔ 一次性订阅的形状全部由这里决定 ⇒ 页面不许再自己拼"已开启"这类话。
//   `last` = 上一次 `requestConsent` / `openSetting` 的结果（没有就传 null）。
function settingsView(kind, options = {}) {
  const role = kind === 'member' ? 'member' : 'coach'
  const state = stateOf(role)
  const opts = options || {}
  const last = opts.last || null
  const status = last ? String(last.status || '') : ''
  const rejected = status === 'rejected' || status === 'cancelled' || status === 'wechat-denied'
  const needReauthorize = status === 'quota-exhausted'
  return {
    role, roleText: ROLE_TEXT[role], scopeText: ROLE_SCOPE[role],
    configured: state.configured, count: state.count, total: state.total,
    configuredText: state.configured ? '' : MESSAGE_NOT_CONFIGURED,
    // ⛔ 按钮文案**永远**是「允许下一条微信提醒」：没有后台证据表明存在长期订阅。
    buttonText: state.configured ? BUTTON_TEXT : '模板尚未配置',
    openSettingText: OPEN_SETTING_TEXT,
    showOpenSetting: rejected,
    quotaUsedText: needReauthorize ? QUOTA_USED_TEXT : '',
    statusText: status ? (STATUS_TEXT[status] || explainOf(last) || '') : '',
    // ✅ 长期订阅**已核实**：后台没有长期模板 ⇒ 如实标成"一次性订阅"，⛔ 绝不含糊。
    longTerm: LONG_TERM_ONE_TIME,
    longTermNote: LONG_TERM_NOTE,
    rejected, needReauthorize,
    templates: ALL_SLOTS.map(slot => ({
      slot, name: SLOT_NAMES[slot],
      configured: !!String(TEMPLATE_IDS[slot] || ''),
      // ⛔ 模板 ID 只显示**后 6 位**（完整 ID 是凭据，不该摆给普通用户看）
      idTail: String(TEMPLATE_IDS[slot] || '').slice(-6)
    }))
  }
}

module.exports = {
  TEMPLATE_IDS, TYPES_FOR_COACH, TYPES_FOR_MEMBER, ALL_SLOTS, STATUS_TEXT, QUOTA_NOTE,
  SLOT_NAMES, ROLE_TEXT, ROLE_SCOPE, BUTTON_TEXT, OPEN_SETTING_TEXT, QUOTA_USED_TEXT,
  FORBIDDEN_PERMANENT_WORDS, LONG_TERM, LONG_TERM_PENDING, LONG_TERM_CONFIRMED, LONG_TERM_ONE_TIME, LONG_TERM_NOTE,
  AFTER_ACTION_BUTTON_TEXT, ACTION_HINT, requestNextAfterAction, runBusinessTap,
  resetInflight, inflightState,
  openSetting, settingsView,
  NEED_REAUTHORIZE_TEXT, NEED_REAUTHORIZE_SHORT,
  tmplIdsFor, stateOf, requestConsent, explainOf, translate, failStatusOf,
  MESSAGE_NOT_CONFIGURED
}
