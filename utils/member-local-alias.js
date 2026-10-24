// 会员给自己设置的本机称呼。
// 只写微信本机 Storage；绝不调用云函数，也不修改教练登记的会员姓名。
const memberEnvironment = require('./member-environment')
const PREFIX = 'coachMemberLocalAlias:v1:'
function key() { return `${PREFIX}${memberEnvironment.read()}` }
function clean(value) { return String(value || '').trim().slice(0, 12) }
function read() { try { return clean(wx.getStorageSync(key())) } catch (error) { return '' } }
function write(value) {
  const next = clean(value)
  try { if (next) wx.setStorageSync(key(), next); else wx.removeStorageSync(key()) } catch (error) {}
  return next
}
module.exports = { PREFIX, key, clean, read, write }
