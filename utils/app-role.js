const KEY = 'coachAppPreferredRole'
const MEMBER_PREFIX = 'pages/member-'
function raw() { try { const value = wx.getStorageSync(KEY); return value === 'member' || value === 'coach' ? value : '' } catch (e) { return '' } }
function hasChoice() { return !!raw() }
function stored() { try { return wx.getStorageSync(KEY) === 'member' ? 'member' : 'coach' } catch (e) { return 'coach' } }
function isMemberPath(options) { const path = options && options.path || ''; return path.indexOf(MEMBER_PREFIX) === 0 }
function memberBindingScene(options) {
  const path = String(options && options.path || '')
  const query = options && options.query || {}
  // 会员扫码入口：联系人二维码进入添加教练；专属会员二维码进入领取本人资料。
  //   小程序码（wxacode.getUnlimited）的 scene 在顶层 options.scene，不在 query.scene。
  if (path !== 'pages/member-add-coach/member-add-coach' && path !== 'pages/member-claim/member-claim') return ''
  const raw = (options && options.scene) || query.scene || query.ticket || ''
  try { return decodeURIComponent(String(raw).trim()) } catch (error) { return String(raw).trim() }
}
function isMemberBindingQr(options) { return !!memberBindingScene(options) }
function fromLaunch(options) { return isMemberPath(options) ? 'member' : stored() }
function set(role) { const next = role === 'member' ? 'member' : 'coach'; wx.setStorageSync(KEY, next); return next }
function isMember(options) { return fromLaunch(options) === 'member' }
module.exports = { KEY, raw, hasChoice, stored, isMemberPath, memberBindingScene, isMemberBindingQr, fromLaunch, set, isMember }
