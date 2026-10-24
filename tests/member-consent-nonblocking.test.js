// 2026-10-13 产品收口：会员端不再展示或触发无效的一次性微信提醒；教练端已可用链路继续保留。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const expected = ['components/booking-modal/booking-modal.js', 'pages/session/session.js']
for (const file of expected) {
  const source = read(file)
  assert.ok(source.includes("require('../../utils/notify-consent')"), `${file} 没有接入统一订阅助手`)
  assert.ok(source.includes("requestNextAfterAction('coach'"), `${file} 没有保留教练端下一条提醒`)
  assert.ok(!/await\s+notifyConsent\.requestNextAfterAction/.test(source), `${file} 等待通知授权，会卡住主业务`)
}

const claim = read('pages/member-claim/member-claim.js')
const slots = read('pages/member-book-slots/member-book-slots.js')
const bookings = read('pages/member-bookings/member-bookings.js')
for (const [name, source] of [['领取资料', claim], ['预约', slots], ['取消与改期', bookings]]) {
  assert.ok(!source.includes("require('../../utils/notify-consent')"), `会员${name}仍加载微信提醒模块`)
  assert.ok(!/requestNextAfterAction\('member'|requestConsent\('member'/.test(source), `会员${name}仍会弹微信提醒`)
}

const home = read('pages/member-home/member-home.js')
const homeWxml = read('pages/member-home/member-home.wxml')
assert.ok(!/notifyConsent|allowNextNotification/.test(home), '会员首页仍保留微信提醒逻辑')
assert.ok(!/微信课程提醒|允许下一条微信提醒/.test(homeWxml), '会员首页仍显示无效微信提醒')

const app = JSON.parse(read('app.json'))
assert.ok(!app.pages.includes('pages/notify-settings/notify-settings'), '不需要恢复独立通知设置页')
assert.ok(read('pages/member-book-slots/member-book-slots.js').includes('return this.runSubmit(request)'), '会员预约主动作必须保留')
assert.ok(read('pages/member-bookings/member-bookings.js').includes('return resolve(true)'), '会员取消主动作必须保留')
assert.ok(read('pages/session/session.js').includes('return this.cancel(false)'), '教练取消主动作必须保留')
assert.ok(claim.includes('directory.claimMemberByQr'), '会员领取主动作必须保留')

console.log('member notification surface tests: PASS (member prompts removed; coach prompts preserved; business actions intact)')
