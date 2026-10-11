const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const app = JSON.parse(read('app.json'))
// ⭐ 新方案（唯一会员 + 双向联系人）把这 5 个联系人页面变成正式核心页面：
// 会员要能添加教练 / 看教练列表 / 出示联系人码，教练要能添加会员 / 出示联系人码。
// 判据随真相源迁移：从「不应注册」翻转为「必须注册」（删掉任一个都会红，判别力更强）。
for (const page of [
  'pages/member-coaches/member-coaches',
  'pages/member-add-coach/member-add-coach',
  'pages/member-contact-qr/member-contact-qr',
  'pages/coach-add-member/coach-add-member',
  'pages/coach-contact-qr/coach-contact-qr'
]) assert.ok(app.pages.includes(page), `${page} 必须注册进正式产品路由（新联系人方案核心页面）`)
// 微信通知设置页仍属已撤回功能，不进正式路由
for (const page of ['pages/notify-settings/notify-settings']) {
  assert.ok(!app.pages.includes(page), `${page} 不应再进入正式产品路由`)
}

const visible = [
  read('pages/member-home/member-home.wxml'),
  read('pages/member-profile/member-profile.wxml'),
  read('pages/member-book-slots/member-book-slots.wxml'),
  read('pages/member-bookings/member-bookings.wxml'),
  read('pages/students/students.wxml'),
  read('pages/stats/stats.wxml'),
  read('pages/notification-inbox/notification-inbox.wxml'),
  read('pages/session/session.wxml')
].join('\n')
for (const banned of ['添加教练', '我的联系人二维码', '添加已经绑定的会员', '给B教练使用', '其他教练添加这位会员', '微信通知设置']) {
  assert.ok(!visible.includes(banned), `单教练界面不应再显示“${banned}”`)
}
assert.ok(visible.includes('加入手机日历'), '教练或会员应能把待上课程加入手机日历')

const business = [
  read('pages/member-home/member-home.js'),
  read('pages/member-profile/member-profile.js'),
  read('pages/member-book-slots/member-book-slots.js'),
  read('pages/member-bookings/member-bookings.js'),
  read('pages/session/session.js')
].join('\n')
assert.ok(!business.includes('runBusinessTap') && !business.includes('requestNextAfterAction'), '常用业务按钮不得再弹一次性订阅授权')
assert.ok(read('pages/member-book-slots/member-book-slots.js').includes('coaches = primary ? [primary] : []'), '会员约课必须只使用资料所属的单一主教练')
const studentsPage = read('pages/students/students.js')
for (const removedHandler of ['openAddMember', 'openMemberClaimTool', 'openInviteClaim']) {
  assert.ok(!studentsPage.includes(removedHandler), `单教练学员页不应残留 ${removedHandler} 旧跳转`)
}

const calls = []
const oldWx = global.wx
global.wx = {
  addPhoneCalendar(options) { calls.push(options); options.success() },
  showToast() {}, showModal() {}
}
delete require.cache[require.resolve('../utils/phone-calendar')]
const calendar = require('../utils/phone-calendar')
assert.strictEqual(calendar.timestampOf('2026-10-10', '09:30'), 1791595800, '课程时间必须按北京时间转换')
calendar.addCourse({ date: '2026-10-10', startText: '09:30', endText: '10:30', typeText: '常规训练', coachName: '教练' })
assert.strictEqual(calls.length, 1, '一次点击只能添加一条系统日历')
assert.strictEqual(calls[0].startTime, 1791595800)
assert.strictEqual(calls[0].endTime, 1791599400)
assert.strictEqual(calls[0].alarm, true)
assert.strictEqual(calls[0].alarmOffset, 3600, '默认提前一小时提醒')
if (oldWx === undefined) delete global.wx
else global.wx = oldWx

console.log('single coach + phone calendar surface tests: PASS')
