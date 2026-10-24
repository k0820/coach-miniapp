const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const bookingModal = read('components/booking-modal/booking-modal.js')
const session = read('pages/session/session.js')
const slots = read('pages/member-book-slots/member-book-slots.js')
const bookings = read('pages/member-bookings/member-bookings.js')
const claim = read('pages/member-claim/member-claim.js')
const home = read('pages/member-home/member-home.js')
const homeWxml = read('pages/member-home/member-home.wxml')
const coach = bookingModal + session
const memberActions = slots + bookings

assert.ok(bookingModal.includes("requestNextAfterAction('coach'"), '教练排课没有接入下一条提醒')
assert.ok((session.match(/requestNextAfterAction\('coach'/g) || []).length >= 2, '教练取消、改期没有全部接入下一条提醒')
assert.ok(!/notify-consent|requestNextAfterAction\('member'/.test(memberActions), '会员预约、取消或改期仍会弹无效微信提醒')
assert.ok(!/notify-consent|requestConsent\('member'/.test(claim), '会员首次领取仍会弹无效微信提醒')
assert.ok(!/notifyConsent|allowNextNotification/.test(home), '会员首页仍残留提醒逻辑')
assert.ok(!/微信课程提醒|允许下一条微信提醒/.test(homeWxml), '会员首页仍显示提醒按钮')
assert.ok(!/await\s+notifyConsent\.requestNextAfterAction/.test(coach + memberActions), '常用业务动作不得等待通知授权，拒绝也必须继续业务')
assert.ok(read('pages/member-book-slots/member-book-slots.js').includes('this.runSubmit(request)'))
assert.ok(read('pages/member-bookings/member-bookings.js').includes('resolve(true)'))
assert.ok(read('pages/session/session.js').includes('this.cancel(false)'))

console.log('notify business buttons tests: PASS (coach prompts preserved; member prompts removed without changing business actions)')
