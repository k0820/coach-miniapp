// ─────────────────────────────────────────────────────────────────────────────
// 📇 新会员方案的**客户端**唯一出入口（2026-10-06）
//
// ⭐ 这套东西一句话：会员用当前微信进入自己的唯一资料，会员和教练互相加联系人，
//    加上之后双方都能主动约课。旧的「认领 / 认领码 / 训练档案 / 切换档案」全都用不到了。
//
// ⛔⛔ 五条硬纪律：
//   ① 正式区与测试区都只走统一路由，云函数名由 `sandbox-cloud-functions` 给出
//      （⛔ 本文件不许出现任何云函数名硬编码，隔离护栏会静态扫描）。
//   ② 两个环境各自读写自己的会员集合，任何失败都不能自动跨环境重试。
//   ③ **客户端不许提交身份字段**：`memberId` / `ownerCoachId` / `datasetId` / `openid`
//      一个都不许出现 ⇒ 云端会在入口前直接拒。
//   ④ **失败必须停下来**：任何失败都要到 `finally` 解开 busy ⇒ 按钮停止转圈、允许重试。
//   ⑤ **不许替服务端说成功**：只有云端明确 `ok:true` 才算成功；其余一律如实显示原因。
// ----------------------------------------------------------------------------
const runtime = require('./data-runtime')
const routing = require('./sandbox-cloud-functions')

// 会员首页 / “我的”共用一份最近成功快照。页面先同步读本机，再在后台向云端
// 对账：返回页面时不再用一秒左右的网络时间挡住昵称、课时和下一节课。
// ⛔ 快照只负责首屏显示，云端仍是最终真相；环境写进 key 与内容，绝不串区。
const DASHBOARD_CACHE = 'memberDirectoryDashboard:'

const environment = () => (runtime.environment() === 'sandbox' ? 'sandbox' : 'production')
const dashboardCacheKey = () => DASHBOARD_CACHE + environment()
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
function cachedDashboard() {
  try {
    const value = wx.getStorageSync(dashboardCacheKey())
    return value && value.ok === true && value.environment === environment() ? clone(value) : null
  } catch (error) { return null }
}
function saveDashboard(result) {
  if (!result || result.ok !== true) return result
  const record = { ...result, environment: environment(), cachedAt: Date.now() }
  try { wx.setStorageSync(dashboardCacheKey(), record) } catch (error) { /* 缓存失败不影响本次云端结果 */ }
  return record
}
// 会员目录已同时接通正式区与测试区；环境仍由统一路由决定，绝不交叉读写。
function available() { return true }

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
async function dashboard() { return saveDashboard(await call('dashboard')) }

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

// 📱 联系人二维码：内容只有一次性随机票据，
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

async function withTempImage(result) {
  if (!result || result.ok !== true || !result.fileID) return result
  try {
    const response = await wx.cloud.getTempFileURL({ fileList: [result.fileID] })
    const item = (response && response.fileList || [])[0] || {}
    return { ...result, imageUrl: item.tempFileURL || '' }
  } catch (error) { return { ...result, imageUrl: '' } }
}

const memberClaimQrCache = new Map()
const MEMBER_CLAIM_QR_CACHE = 'memberClaimQr:'
// 分享链接天然跟随当前正在运行的小程序版本；专属小程序码也必须使用同一版本。
// 开发者工具/体验版统一生成 trial 码，正式版生成 release 码。取不到平台信息时
// 保守按 release 处理，避免正式用户被导向仅体验成员可打开的版本。
function memberClaimQrEnvVersion() {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync()
    const value = String(info && info.miniProgram && info.miniProgram.envVersion || '').toLowerCase()
    return value === 'develop' || value === 'trial' ? 'trial' : 'release'
  } catch (error) { return 'release' }
}
function memberClaimQrCacheKey(studentRef) {
  return `${MEMBER_CLAIM_QR_CACHE}${environment()}:${memberClaimQrEnvVersion()}:${String(studentRef || '')}`
}
function cachedMemberClaimQr(studentRef) {
  const key = String(studentRef || '')
  if (!key) return null
  const memory = memberClaimQrCache.get(key)
  if (memory && memory.ok === true && memory.fileID) return clone(memory)
  try {
    const saved = wx.getStorageSync(memberClaimQrCacheKey(key))
    if (!saved || saved.ok !== true || !saved.fileID || saved.environment !== environment() || saved.qrEnvVersion !== memberClaimQrEnvVersion()) return null
    memberClaimQrCache.set(key, saved)
    return clone(saved)
  } catch (error) { return null }
}
function saveMemberClaimQr(studentRef, result) {
  const key = String(studentRef || '')
  if (!key || !result || result.ok !== true || !result.fileID) return result
  const ready = { ...result, imageUrl: result.imageUrl || result.fileID, environment: environment(), qrEnvVersion: memberClaimQrEnvVersion(), cachedAt: Date.now() }
  memberClaimQrCache.set(key, ready)
  try { wx.setStorageSync(memberClaimQrCacheKey(key), ready) } catch (error) { /* 缓存失败不影响二维码使用 */ }
  return ready
}
async function tempImageUrl(fileID) {
  if (!fileID) return ''
  try {
    const response = await wx.cloud.getTempFileURL({ fileList: [fileID] })
    const item = (response && response.fileList || [])[0] || {}
    return item.tempFileURL || ''
  } catch (error) { return '' }
}
async function getMemberClaimQr(studentRef) {
  const key = String(studentRef || '')
  // 二维码图片由服务端永久复用，但“是否已绑定微信”必须每次现读，
  // 否则会员刚领取后，教练端会被旧缓存误导成“尚未绑定”，也无法解除。
  const result = await call('getMemberClaimQr', { studentRef: key, qrEnvVersion: memberClaimQrEnvVersion() })
  if (!result || result.ok !== true || !result.fileID) return result
  // cloud:// 文件可以直接给 image 显示，省掉一趟必须等待的临时链接请求。
  // 分享图链接在页面后台补取，不阻塞二维码首屏。
  const claimReady = { ...result, imageUrl: result.fileID }
  return saveMemberClaimQr(key, claimReady)
}
function previewMemberClaimQr(scene) { return call('previewMemberClaimQr', { scene: String(scene || '') }) }
function claimMemberByQr(scene, requestId) { return call('claimMemberByQr', { scene: String(scene || '') }, requestId) }
async function unbindMemberWechat(studentRef, requestId) {
  const key = String(studentRef || '')
  const result = await call('unbindMemberWechat', { studentRef: key }, requestId)
  if (result && result.ok === true) {
    const cached = cachedMemberClaimQr(key)
    if (cached) saveMemberClaimQr(key, { ...cached, bound: false })
  }
  return result
}
async function rotateMemberClaimQr(studentRef, requestId) {
  const result = await call('rotateMemberClaimQr', { studentRef: String(studentRef || ''), qrEnvVersion: memberClaimQrEnvVersion() }, requestId)
  if (!result || result.ok !== true || !result.fileID) return result
  return saveMemberClaimQr(studentRef, { ...result, imageUrl: result.fileID })
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

// ⭐ 会员首页：课时概况 / 下一节课 / 预约课程。教练卡已按产品决定删除。
//   ⛔ 服务端怎么说就怎么显示：没有课就明确写「暂时没有待上课程」，⛔ 不许显示一个假的入口。
function homeView(result) {
  const empty = { member: { displayName: '', phoneTail: '' }, summary: { available: 0, occupied: 0, used: 0, packageCount: 0 }, nextBooking: null, coaches: [], recentTraining: [] }
  const data = (result && result.ok ? result : {})
  const member = data.member || empty.member
  const summary = data.summary || empty.summary
  const next = data.nextBooking || null
  const coaches = (data.coaches || []).map(coach => ({
    ...coach,
    initial: String(coach && coach.displayName || '教').slice(0, 1)
  }))
  const packages = (data.packages || []).map(item => ({
    ...item,
    available: Math.max(Number(item && item.remaining || 0) - Number(item && item.reserved || 0), 0)
  }))
  return {
    initial: (String(member.displayName || '我')).slice(0, 1),
    member,
    summary,
    nextText: next ? timeTextOf(next.date, next.hour, next.minute) : '',
    next,
    // 教练联系人不设人数上限；横向列表自己滚动，不能在数据层偷偷截掉第 7 位以后的人。
    coaches,
    coachCount: coaches.length,
    packages,
    recentTraining: data.recentTraining || [],
    // ⛔ 一份课时包都没有 ≠ 加载失败 ⇒ 明说，不许让用户对着 0 猜。
    emptyText: !summary.packageCount ? '还没有课时包，请让主管教练给你创建。' : ''
  }
}

module.exports = {
  available, environment, TEXTS, SANDBOX_ONLY_NOTE, newRequestId, call,

  dashboard, cachedDashboard, resolvePhoneCode, loginByPhone, createMemberByCoach,
  contacts, issueTicket, drawQr, resolveTicket, findByCode, addByCode, addByTicket,
  removeContact, removeMemberContact, readMemberDetail, updateMemberCore, renameSelf,
  getMemberClaimQr, cachedMemberClaimQr, rotateMemberClaimQr, unbindMemberWechat, previewMemberClaimQr, claimMemberByQr, tempImageUrl, memberClaimQrEnvVersion,
  homeView, timeTextOf
}

