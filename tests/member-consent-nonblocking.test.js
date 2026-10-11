// 产品已收口：一次性微信订阅不再绑在常用按钮上。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

for (const file of [
  'pages/member-home/member-home.js',
  'pages/member-profile/member-profile.js',
  'pages/member-book-slots/member-book-slots.js',
  'pages/member-bookings/member-bookings.js',
  'pages/session/session.js',
  'components/booking-modal/booking-modal.js'
]) {
  const source = read(file)
  assert.ok(!/requestNextAfterAction|runBusinessTap/.test(source), `${file} 仍会在常用按钮里申请一次性订阅`)
}

const app = JSON.parse(read('app.json'))
assert.ok(!app.pages.includes('pages/notify-settings/notify-settings'), '通知设置页不应继续注册')
assert.ok(read('pages/member-home/member-home.js').includes("wx.navigateTo({ url })"), '会员首页正常导航必须保留')
assert.ok(read('pages/member-book-slots/member-book-slots.js').includes('return this.runSubmit(request)'), '会员确认预约必须直接执行原业务')
assert.ok(read('pages/member-bookings/member-bookings.js').includes('return resolve(true)'), '会员确认取消必须直接执行原业务')
assert.ok(read('pages/session/session.js').includes('return this.cancel(false)'), '教练确认取消必须直接执行原业务')

console.log('member consent removal tests: PASS (business buttons no longer request one-time subscription)')
