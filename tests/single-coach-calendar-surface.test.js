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
assert.ok(!visible.includes('加入手机日历'), '产品已取消手机日历功能，所有可见页面都不应再出现入口')

const business = [
  read('pages/member-home/member-home.js'),
  read('pages/member-profile/member-profile.js'),
  read('pages/member-book-slots/member-book-slots.js'),
  read('pages/member-bookings/member-bookings.js'),
  read('pages/session/session.js')
].join('\n')
assert.ok(!business.includes("requestNextAfterAction('member'"), '会员端已取消无效微信提醒，不应再从业务按钮申请')
assert.ok(business.includes("requestNextAfterAction('coach'"), '教练端已经可用的提醒链必须保留')
assert.ok(!/await\s+notifyConsent\.requestNextAfterAction/.test(business), '通知授权不得阻断会员业务')
assert.ok(read('pages/member-book-slots/member-book-slots.js').includes('coaches = primary ? [primary] : []'), '会员约课必须只使用资料所属的单一主教练')
const studentsPage = read('pages/students/students.js')
for (const removedHandler of ['openAddMember', 'openMemberClaimTool', 'openInviteClaim']) {
  assert.ok(!studentsPage.includes(removedHandler), `单教练学员页不应残留 ${removedHandler} 旧跳转`)
}

assert.ok(!business.includes("require('../../utils/phone-calendar')"), '业务页面不应再加载手机日历模块')
assert.ok(!business.includes('addToCalendar'), '业务页面不应残留手机日历点击处理函数')
const project = JSON.parse(read('project.config.json'))
const ignoredFiles = (project.packOptions && project.packOptions.ignore || [])
  .filter(item => item && item.type === 'file')
  .map(item => item.value)
assert.ok(ignoredFiles.includes('utils/phone-calendar.js'), '已撤下的手机日历工具不得再进入提审上传包，否则会产生错误的日历隐私声明')

console.log('single coach + calendar removed surface tests: PASS')
