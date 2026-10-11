// ─────────────────────────────────────────────────────────────────────────────
// 📇 新会员方案的**客户端**唯一出入口（2026-10-06）
//
// ⭐ 这套东西一句话：会员用当前微信进入自己的唯一资料，会员和教练互相加联系人，
//    加上之后双方都能主动约课。旧的「认领 / 认领码 / 训练档案 / 切换档案」全都用不到了。
//
// ⛔⛔ 五条硬纪律：
//   ① **只走测试区云函数**：云函数名一律由 `sandbox-cloud-functions` 路由表给出
//      （⛔ 本文件不许出现任何云函数名硬编码，隔离护栏会静态扫描）。
//   ② **正式区显示「尚在安全测试中」**：集合与通道只部署在测试区 ⇒ `available()` 为假时
//      入口整个藏起来，⛔ 绝不给一个点了就报错的按钮。
//   ③ **客户端不许提交身份字段**：`memberId` / `ownerCoachId` / `datasetId` / `openid`
//      一个都不许出现 ⇒ 云端会在入口前直接拒。
//   ④ **失败必须停下来**：任何失败都要到 `finally` 解开 busy ⇒ 按钮停止转圈、允许重试。
//   ⑤ **不许替服务端说成功**：只有云端明确 `ok:true` 才算成功；其余一律如实显示原因。
// ----------------------------------------------------------------------------
const runtime = require('./data-runtime')
const routing = require('./sandbox-cloud-functions')

const environment = () => (runtime.environment() === 'sandbox' ? 'sandbox' : 'production')
// ⛔ 新会员方案**只部署在测试区**（正式区集合与通道都没有）⇒ 正式区一律不显示入口。
function available() { return environment() === 'sandbox' }

const SANDBOX_ONLY_NOTE = '该功能尚在安全测试中'

// ⛔ 与服务端同一批话术（小事不必多语言，重要的是**两端说同一句**）。
const TEXTS = Object.freeze({
  DUPLICATED: '已经添加过，无需重复添加。',
  MEMBER_NOT_FOUND: '还没有会员资料，请先填写昵称。',
  CONTACT_NOT_FOUND: '没有找到这个编号，请核对后再试。',
  TICKET_EXPIRED: '这个二维码已经失效，请让对方重新生成后再扫。',
  RATE_LIMITED: '查找太频繁了，请稍等一会儿再试。',
  CODE_INVALID: '请输入完整的会员编号或教练编号。',
  NETWORK: '网络没连上，请稍后再试一次。',
  NOT_OWNER: '你可以给这位会员排课和记录训练，课时包由主管教练管理。',
  PHONE_INVALID: '请输入正确的手机号。',
  PHONE_API_UNAVAILABLE: '本小程序尚未开通手机号获取能力：请在微信公众平台「开发 → 接口设置」开通「获取手机号」，并完成小程序验证与隐私声明后再使用。',
  PHONE_NOT_FOUND: '没有找到你的会员资料，请联系教练核对手机号。',
  PHONE_ALREADY_EXISTS: '这个手机号已经有会员资料了，请直接添加。'
})

function newRequestId(action) {
  const tail = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-z0-9]/gi, '').slice(-10).toLowerCase()
  return `md-${String(action || 'x').replace(/[^A-Za-z0-9_-]/g, '')}-${tail}`
}

// ⛔ 一次动作一个号：重试 / 连点都是同一个号 ⇒ 云端幂等，不会重复添加、不会重复建关系。
async function call(action, payload = {}, requestId) {
  if (!available()) return { ok: false, code: routing.SANDBOX_ONLY_CODE, message: SANDBOX_ONLY_NOTE }
  const id = String(requestId || newRequestId(action))
  try {
    const response = await wx.cloud.callFunction({
      name: routing.businessFunction(environment()),
      // 外层用 memberDirectory 进入测试区目录模块；真正的动作单独带上，
      // 不能把两层动作混成一个，否则云端只会收到 memberDirectory 而报「不支持的操作」。
      data: { environment: environment(), action: 'memberDirectory', directoryAction: action, requestId: id, payload }
    })
    const result = (response && response.result) || response || {}
    return { ...result, requestId: id }
  } catch (error) {
    return { ok: false, code: 'NETWORK_FAILED', message: TEXTS.NETWORK, requestId: id, error: String((error && error.message) || error) }
  }
}

// ── ① 微信身份自动进入 ─────────────────────────────────────────────────────────────
// ⛔ `cloudId` 是微信在 `bindgetphonenumber` 回调里给的**凭证**，不是手机号本身。
//    ⛔ 传不了凭证就如实报缺口，⛔ 绝不用用户手填的字符串冒充登录凭证。
// ── ② 会员首页 ───────────────────────────────────────────────────────────────
function dashboard() { return call('dashboard') }

// ⭐⭐ 新方案会员身份入口：手机号登录（⛔ 只认可信手机号，绝不手填冒充）。
//    会员用微信官方手机号按钮 → `resolvePhoneCode` 换可信手机号 → 这里按手机号找唯一会员。
function resolvePhoneCode(code, requestId) { return call('resolvePhoneCode', { code: String(code || '') }, requestId) }
function loginByPhone(phone, requestId) { return call('loginByPhone', { phone: String(phone || '') }, requestId) }

// ⭐ 教练新建会员（手机号是唯一键）：创建者自动成为主管教练。
function createMemberByCoach(phone, displayName, requestId) {
  return call('createMemberByCoach', { phone: String(phone || ''), displayName: String(displayName || '') }, requestId)
}

// ── ③ 联系人 ─────────────────────────────────────────────────────────────────
function contacts() { return call('listContacts') }
function issueTicket() { return call('issueTicket') }
function resolveTicket(ticket) { return call('resolveTicket', { ticket: String(ticket || '') }) }
function findByCode(code) { return call('findByCode', { code: String(code || '') }) }
function addByCode(code, requestId) { return call('addContact', { code: String(code || '') }, requestId) }
function addByTicket(ticket, requestId) { return call('addContact', { ticket: String(ticket || '') }, requestId) }
function removeContact(contactKey) { return call('removeContact', { contactKey: String(contactKey || '') }) }
function removeMemberContact(memberId) { return call('removeContact', { memberId: String(memberId || '') }) }

// 📱 二维码：这里只拿一个临时链接；内容只有一口气 randomised 的票据，
//    ⛔ 二维码里没有手机号、没有 openid、没有 memberId / coachId。
async function drawQr() {
  const issued = await call('drawTicketQr')
  if (!issued || issued.ok !== true || !issued.fileID) return issued
  try {
    const response = await wx.cloud.getTempFileURL({ fileList: [issued.fileID] })
    const item = (response && response.fileList || [])[0] || {}
    return { ...issued, imageUrl: item.tempFileURL || '' }
  } catch (error) {
    return { ...issued, imageUrl: '' }
  }
}

// ── ④ 教练侧 ─────────────────────────────────────────────────────────────────
function readMemberDetail(memberId) { return call('readMemberDetail', { memberId: String(memberId || '') }) }
function updateMemberCore(patch, requestId) {
  const payload = {}
  if (patch && patch.memberId) payload.memberId = String(patch.memberId)
  if (patch && patch.displayName != null) payload.displayName = String(patch.displayName)
  return call('updateMemberCore', payload, requestId)
}
// ⭐ 会员改自己的昵称（⛔ 手机号改不了 —— 那是主管教练的事）。
function renameSelf(displayName, requestId) {
  return call('updateMemberCore', { displayName: String(displayName || '') }, requestId)
}

// ── 视图模型（纯函数，界面只管渲染）──────────────────────────────────────────
function pad(value) { return String(value).padStart(2, '0') }
function timeTextOf(dateText, hour, minute) {
  const date = String(dateText || '')
  if (!date) return ''
  return `${date.slice(5).replace('-', '月')}日 ${pad(Number(hour || 0))}:${pad(Number(minute || 0))}`
}

// ⭐ 会员首页三张卡：课时概况 / 下一节课 / 我的教练。
//   ⛔ 服务端怎么说就怎么显示：没有课就明确写「暂时没有待上课程」，⛔ 不许显示一个假的入口。
function homeView(result) {
  const empty = { member: { displayName: '', phoneTail: '' }, summary: { available: 0, occupied: 0, used: 0, packageCount: 0 }, nextBooking: null, coaches: [], recentTraining: [] }
  const data = (result && result.ok ? result : {})
  const member = data.member || empty.member
  const summary = data.summary || empty.summary
  const next = data.nextBooking || null
  return {
    initial: (String(member.displayName || '我')).slice(0, 1),
    member,
    summary,
    nextText: next ? timeTextOf(next.date, next.hour, next.minute) : '',
    next,
    // 教练联系人不设人数上限；横向列表自己滚动，不能在数据层偷偷截掉第 7 位以后的人。
    coaches: data.coaches || [],
    coachCount: (data.coaches || []).length,
    recentTraining: data.recentTraining || [],
    // ⛔ 一份课时包都没有 ≠ 加载失败 ⇒ 明说，不许让用户对着 0 猜。
    emptyText: !summary.packageCount ? '还没有课时包，请让主管教练给你创建。' : ''
  }
}

module.exports = {
  available, environment, TEXTS, SANDBOX_ONLY_NOTE, newRequestId, call,

  dashboard, resolvePhoneCode, loginByPhone, createMemberByCoach,
  contacts, issueTicket, drawQr, resolveTicket, findByCode, addByCode, addByTicket,
  removeContact, removeMemberContact, readMemberDetail, updateMemberCore, renameSelf,
  homeView, timeTextOf
}

