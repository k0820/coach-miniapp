// ⭐ 首屏身份选择 + 会员入口（2026-10-07 重写：对齐「唯一会员 + 双向联系人」新方案）
//
// 旧版锁的是「会员认领 / 专属绑定码 / B 前缀」那套，已被新方案取代。这里改测：
//   · 首屏仍是身份选择（role-entry 第一页），教练冷启动直接进入课表；
//   · 会员入口 = 手机号登录（member-login），添加教练 = member-add-coach；
//   · 公开编号 = C（教练）/ M（会员）+ 8 位大写十六进制，⛔ 不再有 B 前缀；
//   · 扫码进「添加教练」确认页（member-add-coach）由 app-role 识别。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const appJson = JSON.parse(read('app.json'))
assert.strictEqual(appJson.pages[0], 'pages/role-entry/role-entry', '首次进入页必须是身份选择')
for (const name of ['role-entry', 'coach-entry']) {
  assert.ok(appJson.pages.includes(`pages/${name}/${name}`), `${name} 必须注册`)
  for (const ext of ['js', 'wxml', 'wxss', 'json']) assert.ok(fs.existsSync(path.join(root, 'pages', name, `${name}.${ext}`)))
}

const app = read('app.js')
const noChoice = app.indexOf('!appRole.hasChoice()')
const recovery = app.indexOf("require('./utils/production-recovery-guard').arm()")
assert.ok(noChoice >= 0 && noChoice < recovery, '未选择身份时必须在教练恢复/同步启动前退出')
assert.ok(app.includes("globalData: { refreshSchedule: false, activeRole: '', memberEntryScene: '' }"), '新用户不能默认为教练')
assert.ok(app.includes("startCoachRuntime('launch')") && app.includes('bootstrap.maybeRun(reason)'), '老教练与新教练必须复用同一条安全启动链')
assert.ok(/\n\s*if \(launchPath === 'pages\/role-entry\/role-entry'\)/.test(app) && app.includes("wx.reLaunch({ url: '/pages/schedule/schedule' })"), '已记住的教练冷启动必须直接进入课表')
const onShowStart = app.indexOf('onShow(options)')
const memberShow = app.indexOf('if (appRole.isMemberPath(options))', onShowStart)
const coachShow = app.indexOf("appRole.stored() === 'member'", onShowStart)
assert.ok(onShowStart >= 0 && /\n\s*if \(appRole\.isMemberPath\(options\)\) \{/.test(app.slice(onShowStart)) && memberShow > onShowStart && memberShow < coachShow, '后台扫码必须先接住会员入口，再判断旧教练身份')
assert.ok(app.includes('appRole.isMemberBindingQr(options)') && app.includes('memberEnvironment.enterFromClaimScene(appRole.memberBindingScene(options))'), '专属扫码必须按 p/s 前缀把新设备带入签发二维码的正确会员环境')
assert.ok(app.includes('appRole.memberBindingScene(options)') && app.includes('current !== targetPath'), '后台扫码必须确保真正打开添加页并保留scene')

const rolePage = read('pages/role-entry/role-entry.js')
const coachPage = read('pages/coach-entry/coach-entry.js')
assert.ok(rolePage.includes('if (!role.hasChoice())'), '全新设备没有身份时必须停在选择页')
assert.ok(rolePage.includes("role.stored() === 'member' ? '/pages/member-home/member-home' : '/pages/schedule/schedule'"), '记住身份后再次进入必须自动回到自己的端')
assert.ok(rolePage.includes("memberEnvironment.enterMember()"), '会员选择必须持久保存会员身份')
assert.ok(rolePage.includes("memberEnvironment.exitToCoach()"), '选择教练时必须立即记住教练身份，不能等云端初始化后才保存')
assert.ok(rolePage.indexOf("memberEnvironment.exitToCoach()") < rolePage.indexOf("url: '/pages/coach-entry/coach-entry'"), '教练身份必须先落盘再进入登录页')
assert.ok(coachPage.includes("startCoachRuntime('coach-login')"), '教练登录必须复用统一运行时')
assert.ok(coachPage.indexOf("exitToCoach()") < coachPage.indexOf("startCoachRuntime('coach-login')"), '点击登录后才允许建立教练身份')
assert.ok(!/await\s+app\.startCoachRuntime\('coach-login'\)/.test(coachPage), '进入教练端不能等待整轮云端读取结束')
assert.ok(coachPage.indexOf("startCoachRuntime('coach-login')") < coachPage.indexOf("wx.reLaunch"), '后台同步先启动，课表随后立即打开')

// ⭐ 首屏 / 会员入口 UI 不得出现旧认领体系的迷惑文案。
const visible = [
  read('pages/role-entry/role-entry.wxml'), read('pages/coach-entry/coach-entry.wxml'),
  read('pages/member-login/member-login.wxml'), read('pages/member-add-coach/member-add-coach.wxml'),
  read('pages/member-contact-qr/member-contact-qr.wxml'), read('pages/students/students.wxml')
].join('\n')
for (const banned of ['管理员', '邀请码', '开通身份', '选择性别', 'B开头', 'B 开头']) {
  assert.ok(!visible.includes(banned), `首屏与会员入口不应出现“${banned}”`)
}
// ⭐ 新方案：会员用自己的二维码让教练扫（member-contact-qr）；会员添加教练（member-add-coach）。
assert.ok(visible.includes('添加教练') && visible.includes('会员编号'), '会员入口必须使用清楚、自然的名称')
assert.ok(visible.includes('二维码'), '会员必须能出示自己的二维码')

const directory = read('cloudfunctions/coachBusinessSandboxCommand/member-directory.js')
assert.ok(directory.includes("slice(0, 8).toUpperCase()"), '公开编号必须是 8 位大写十六进制')
assert.ok(directory.includes("role === ROLE_COACH ? 'C' : 'M'"), '公开编号前缀必须是 C（教练）/ M（会员），不得回到旧 B 前缀')
const directoryClient = read('utils/member-directory.js')
assert.ok(directoryClient.includes('directoryAction'), '客户端必须把动作包进 memberDirectory 信封')
assert.ok(directoryClient.includes("require('./sandbox-cloud-functions')"), '客户端必须通过路由表取云函数名（隔离护栏）')
assert.ok(!/resolveMemberBinding|issueMemberBinding|MEMBER_BIND_PAGE/.test(directoryClient), '客户端不得再出现旧认领动作')
assert.ok(/claimMemberByQr/.test(directoryClient), '客户端必须暴露专属二维码会员入口')

const oldWx = global.wx
const store = {}
global.wx = { getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = value } }
delete require.cache[require.resolve('../utils/app-role')]
const appRole = require('../utils/app-role')
assert.strictEqual(appRole.hasChoice(), false, '空白设备必须保持未选择状态')
assert.strictEqual(appRole.raw(), '')
assert.strictEqual(appRole.stored(), 'coach', '兼容旧调用时默认值不改变，但不能用于判断是否选过身份')
assert.strictEqual(appRole.set('member'), 'member')
assert.strictEqual(appRole.hasChoice(), true)
assert.strictEqual(appRole.stored(), 'member')
assert.strictEqual(appRole.set('coach'), 'coach')
assert.strictEqual(appRole.stored(), 'coach')
// ⭐ 新方案：会员扫码 = 扫教练的联系人二维码 → 进「添加教练」确认页。
assert.strictEqual(appRole.memberBindingScene({ path: 'pages/member-add-coach/member-add-coach', query: { scene: 'abc%20123' } }), 'abc 123')
assert.strictEqual(appRole.isMemberBindingQr({ path: 'pages/member-add-coach/member-add-coach', query: { scene: 'ticket-1' } }), true)
assert.strictEqual(appRole.isMemberBindingQr({ path: 'pages/member-home/member-home', query: { scene: 'ticket-1' } }), false)
// ⭐ 小程序码（wxacode.getUnlimited）的 scene 在顶层 options.scene，必须能读到。
assert.strictEqual(appRole.memberBindingScene({ path: 'pages/member-add-coach/member-add-coach', scene: 'ticket-9' }), 'ticket-9')
assert.strictEqual(appRole.memberBindingScene({ path: 'pages/member-add-coach/member-add-coach', query: { ticket: 'abc' } }), 'abc')

// ⭐ 新会员入口 = 当前微信扫描教练专属二维码；手机号不再承担登录。
const memberLoginWxml = read('pages/member-login/member-login.wxml')
const memberLoginJs = read('pages/member-login/member-login.js')
assert.ok(memberLoginWxml.includes('专属二维码') && memberLoginWxml.includes('当前微信'), '会员登录页必须明确使用当前微信扫描专属二维码')
assert.ok(!/getPhoneNumber|手动输入手机号|用手机号登录/.test(memberLoginWxml), '会员登录页不得继续要求手机号')
assert.ok(memberLoginJs.includes('directory.dashboard') && !/loginByPhone|resolvePhoneCode/.test(memberLoginJs), '会员登录页只能检查当前微信绑定状态')
if (oldWx === undefined) delete global.wx
else global.wx = oldWx

console.log('first entry role/login tests: PASS (first choice only, remembered role auto-login, member QR identity, C/M public code)')
