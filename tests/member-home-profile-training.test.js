'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')
const training = require('../utils/member-training-view')

const home = read('pages/member-home/member-home.wxml')
const homeJs = read('pages/member-home/member-home.js')
const homeCss = read('pages/member-home/member-home.wxss')
const homeJson = read('pages/member-home/member-home.json')
const profile = read('pages/member-profile/member-profile.wxml')
const profileJs = read('pages/member-profile/member-profile.js')
const slots = read('pages/member-book-slots/member-book-slots.wxml')
const slotsCss = read('pages/member-book-slots/member-book-slots.wxss')
const slotsJs = read('pages/member-book-slots/member-book-slots.js')
const bookings = read('pages/member-bookings/member-bookings.wxml')
const bookingsCss = read('pages/member-bookings/member-bookings.wxss')
const bookingsJs = read('pages/member-bookings/member-bookings.js')
const nav = read('components/member-nav/member-nav.wxml')
const history = read('pages/member-history/member-history.wxml')
const historyJs = read('pages/member-history/member-history.js')
const historyCss = read('pages/member-history/member-history.wxss')
const detail = read('pages/member-history-detail/member-history-detail.wxml')
const detailCss = read('pages/member-history-detail/member-history-detail.wxss')
const aliasSource = read('utils/member-local-alias.js')
const stats = read('pages/stats/stats.wxml')
const sharedCss = read('styles/member.wxss')
const memberRead = read('cloudfunctions/coachBusinessCommand/member-read.js')
const directory = read('utils/member-directory.js')
const weui = read('styles/vendor/weui-2.6.26.wxss')

assert.strictEqual((home.match(/\{\{displayName\|\|/g) || []).length, 1, '首页本机称呼只能显示一次')
assert.ok(!home.includes('{{vm.member.displayName}}'), '首页不得在右侧或其他位置重复显示教练登记姓名')
assert.ok(home.includes('class="home-header"') && home.includes('member-fitness-mark'), '首页顶部必须有问候卡和健身图形')
assert.ok(!home.includes('action-symbol') && !home.includes('>日</view>') && !home.includes('>练</view>'), '下一节课与训练记录不得保留“日/练”装饰方块')
assert.ok(profile.includes('profile-head') && profile.includes('member-fitness-mark'), '“我的”顶部必须有健身图形')
assert.ok(sharedCss.includes('.member-fitness-mark') && sharedCss.includes('.member-fitness-bar'), '健身图形必须复用统一样式')
assert.ok(/class="next-card[^"]*" bindtap="bookings"/.test(home), '首页必须保留下一节课入口')
assert.ok(!home.includes('预约课程') && !home.includes('bindtap="bookNow"') && !homeCss.includes('.book-entry'), '首页预约课程按钮必须删除，统一从底部约课进入')
assert.ok(!home.includes('我的教练') && !home.includes('coach-surface'), '首页不得再显示“我的教练”卡片')
assert.ok(homeCss.includes('weui-2.6.26.wxss') && read('pages/member-profile/member-profile.wxss').includes('weui-2.6.26.wxss'), '首页与“我的”必须使用新安装的微信官方 WeUI 样式')
assert.ok(weui.includes('WeUI v2.6.26') && weui.includes('--weui-BRAND'), 'WeUI 2.6.26 安装包必须完整落盘')
assert.ok(directory.includes('function cachedDashboard()') && directory.includes('wx.setStorageSync(dashboardCacheKey(), record)'), '会员目录必须持久缓存最近成功首页快照')
assert.ok(homeJs.includes('const cached = directory.cachedDashboard()') && homeJs.indexOf('directory.cachedDashboard()') < homeJs.indexOf('this.load({ silent: !!cached })'), '首页必须先同步显示缓存，再后台刷新')
assert.ok(home.includes('class="home-preference"') && home.includes('修改我的称呼') && home.indexOf('home-preference') > home.indexOf('home-training'), '会员称呼入口必须低调放在页面内容底部，不能贴在姓名旁边')
assert.ok(homeJson.includes('/components/member-sheet/member-sheet') && home.includes('只在你的会员端显示，不会改变教练登记的姓名'), '会员称呼必须使用统一弹层并明确本机显示边界')
assert.ok(homeJs.includes("require('../../utils/member-local-alias')") && !homeJs.includes('renameSelf(') && !homeJs.includes('updateMemberCore'), '首页改称呼只能走本机显示偏好，不能写回教练会员资料')
assert.ok(aliasSource.includes('wx.setStorageSync') && aliasSource.includes('wx.removeStorageSync') && aliasSource.includes("memberEnvironment.read()") && !/wx\.cloud|callFunction|renameSelf|updateMemberCore/.test(aliasSource), '会员称呼只能按环境写本机 Storage，不能调用任何云端写入')
for (const color of ['--home-mint:', '--home-blue:', '--home-coral:', '--home-gold:']) assert.ok(homeCss.includes(color), `首页缺少视觉层级颜色 ${color}`)
const homeColors = ['mint', 'blue', 'coral', 'gold'].map(name => (new RegExp(`--home-${name}:([^;}]+)`).exec(homeCss) || [])[1])
assert.strictEqual(new Set(homeColors).size, 4, '首页四种重点色必须互不相同，不能退回同一种颜色')
assert.ok(homeCss.includes('.home-surface.balance-surface') && homeCss.includes('.home-actions.weui-cells') && homeCss.includes('.home-training.weui-cells'), '课时、下一节课和训练记录必须使用不同层级容器')
assert.ok(home.includes('class="home-quick-grid"') && homeCss.includes('.home-quick-grid{display:flex') && homeCss.includes('gap:16rpx'), '下一节课与训练记录必须组成边缘整齐的组合区')
assert.ok(homeCss.includes('flex:1.48') && homeCss.includes('flex:.82') && homeCss.includes('min-height:168rpx'), '两张快捷卡必须上下对齐并保持主次宽度差')

assert.ok(!profile.includes('我的预约'), '“我的”不再重复放预约入口')
assert.ok(profile.includes('我的课包') && !profile.includes('我的课时与课时包'), '课包入口必须使用精简名称')
assert.strictEqual((profile.match(/bindtap="history"/g) || []).length, 1, '最近训练与训练记录必须合并成唯一入口')
assert.ok(profile.includes('训练记录') && profile.includes('近30天') && !profile.includes('最近训练'), '唯一训练记录入口必须同时显示近30天摘要')
assert.ok(!profile.includes('消息中心') && !profile.includes('openInbox'), '“我的”页底部消息卡片必须移除')
assert.ok(profileJs.indexOf('directory.cachedDashboard()') < profileJs.indexOf('this.load({ silent: !!cached })'), '“我的”必须先同步显示缓存，再后台刷新')
assert.ok(profileJs.includes('memberRuntime.read({ allowCache: true })'), '“我的”必须主动刷新训练数据，不能只看旧缓存')
assert.ok(home.includes('我的课包') && home.includes('训练记录') && home.includes('近30天'), '首页必须吸收原“我的”页的课包和训练摘要')
assert.ok(!nav.includes('data-target="profile"') && !nav.includes('<text>我的</text>'), '会员底部导航必须只保留首页和约课')

assert.ok(!slots.includes('<view class="member-card" wx:if="{{packages.length}}">'), '约课页底部旧课时包大卡必须移除')
assert.ok(!slots.includes('<view class="member-title">约课</view>'), '约课页内容区不得重复显示“约课”大标题')
assert.ok(slots.includes('class="booking-choice') && slots.includes('教练与课程') && slots.indexOf('class="booking-choice') < slots.indexOf('date-card'), '教练与课程必须合并为页面顶部一个入口')
assert.ok(!slots.includes('class="course-picker"') && !slots.includes('member-section-title" style="margin-top:0">授课教练'), '约课页不得继续分别显示教练卡和课程横条')
assert.ok(slots.includes('visible="{{choiceOpen}}"') && slots.includes('bindtap="choosePackage"') && slots.includes('item.availableToBook'), '统一入口必须打开课程选择弹层并保留课包余量')
assert.ok(slotsCss.includes('weui-2.6.26.wxss') && slotsCss.includes('background:var(--member-primary)') && slotsJs.includes('--member-primary:#17221c') && slotsJs.includes('--member-hero-label:#85e5ad'), '约课页必须使用与首页一致的 WeUI 深色与绿色视觉')
assert.ok(bookings.includes('class="bookings-hero"') && bookings.includes('data-weui-theme="light"') && bookings.includes('<member-nav active="home"/>'), '下一节课页面必须使用新头图并回归两项导航')
assert.ok(bookingsCss.includes('weui-2.6.26.wxss') && bookingsCss.includes('background:var(--member-primary)') && bookingsJs.includes('--member-primary:#17221c') && bookingsJs.includes('--member-hero-label:#85e5ad'), '预约列表与弹窗必须使用同一深色与绿色视觉')

assert.ok(!history.includes('<view class="member-title">训练记录</view>') && history.includes('class="trend-canvas"') && history.includes('class="trend-point') && history.includes('class="month-summary-card"'), '训练记录页不得重复放开头标题，必须使用可点选的趋势图和月度总结')
assert.ok(historyCss.includes('weui-2.6.26.wxss') && historyCss.includes('--history-blue:') && historyCss.includes('--history-coral:') && historyCss.includes('--history-green:'), '训练记录必须同步首页的 WeUI 与多色层级')
assert.ok(historyJs.includes('member.read({ allowCache: true })'), '训练记录页必须主动回读最新完成内容')
for (const field of ['教练总结', 'item.sets', 'item.reps', 'item.weight', 'item.minutes']) {
  assert.ok(detail.includes(field), `训练详情缺少 ${field}`)
}
assert.ok(detailCss.includes('weui-2.6.26.wxss') && detailCss.includes('--detail-green:') && detailCss.includes('--detail-blue:') && detailCss.includes('--detail-coral:'), '训练详情必须跟随首页多色视觉')
const detailColors = ['green', 'blue', 'coral'].map(name => (new RegExp(`--detail-${name}:([^;}]+)`).exec(detailCss) || [])[1])
assert.strictEqual(new Set(detailColors).size, 3, '训练详情的绿、蓝、珊瑚三种重点色必须保持区分')
assert.ok(!/class="my-identity"[^>]*bindtap="openCoachName"/.test(stats) && stats.includes('class="utility-section"') && stats.indexOf('bindtap="openCoachName"') > stats.indexOf('class="utility-section"'), '教练称呼编辑必须移出顶部身份卡，放进下方设置区')
assert.ok(/items:\s*Array\.isArray\(data\.items\)/.test(memberRead) && /memberSummary:\s*String\(data\.memberSummary/.test(memberRead), '云端会员投影必须继续带出动作明细与公开总结')

const rows = training.rowsOf({ recentTraining: [
  { historyId: 'older', date: '2026-09-18', hour: 9, minute: 5, coach: { displayName: '胡教练' }, typeName: '常规训练', items: [{ name: '深蹲' }] },
  { historyId: 'middle', date: '2026-10-10', hour: 11, minute: 0, coach: { displayName: '胡教练' }, typeName: '常规训练', items: [{ name: '划船' }] },
  { historyId: 'latest', date: '2026-10-20', hour: 18, minute: 30, coach: { displayName: '胡教练' }, category: '拉伸恢复', items: [{ name: '髋屈肌拉伸' }], memberSummary: '今天活动度更好了' }
] })
assert.deepStrictEqual(rows.map(row => row.historyId), ['latest', 'middle', 'older'], '训练记录必须按最近日期排序')
assert.strictEqual(rows[0].actionNames, '髋屈肌拉伸')
assert.strictEqual(rows[0].timeLabel, '18:30')
const summary = training.recentSummary(rows, new Date(2026, 9, 21).getTime())
assert.strictEqual(summary.count30, 2, '最近30天只统计窗口内已完成训练')
assert.strictEqual(summary.latestText, '10月20日 · 拉伸恢复')

async function verifyDashboardCache() {
  const store = {}, calls = []
  const runtimePath = require.resolve('../utils/data-runtime')
  const routingPath = require.resolve('../utils/sandbox-cloud-functions')
  const directoryPath = require.resolve('../utils/member-directory')
  const saved = new Map([[runtimePath, require.cache[runtimePath]], [routingPath, require.cache[routingPath]], [directoryPath, require.cache[directoryPath]]])
  global.wx = {
    getStorageSync: key => store[key],
    setStorageSync: (key, value) => { store[key] = JSON.parse(JSON.stringify(value)) },
    cloud: { callFunction: async options => {
      calls.push(options)
      return { result: { ok: true, member: { displayName: '林欣颖' }, summary: { available: 8, packageCount: 1 }, packages: [], nextBooking: null, coaches: [] } }
    } }
  }
  try {
    require.cache[runtimePath] = { id: runtimePath, filename: runtimePath, loaded: true, exports: { environment: () => 'production' } }
    require.cache[routingPath] = { id: routingPath, filename: routingPath, loaded: true, exports: { businessFunction: () => 'business' } }
    delete require.cache[directoryPath]
    const freshDirectory = require(directoryPath)
    assert.strictEqual(freshDirectory.cachedDashboard(), null, '第一次读取前不得制造假缓存')
    await freshDirectory.dashboard()
    const cached = freshDirectory.cachedDashboard()
    assert.strictEqual(calls.length, 1, '第一次云端读取只允许一趟')
    assert.strictEqual(cached.member.displayName, '林欣颖', '成功快照必须可在下次页面打开时同步读取')
    assert.strictEqual(cached.summary.available, 8, '剩余课程必须随首页快照一起缓存')
    assert.strictEqual(cached.environment, 'production', '快照必须锁定环境，不能串到测试区')
  } finally {
    delete global.wx
    for (const [key, value] of saved) { if (value) require.cache[key] = value; else delete require.cache[key] }
  }
}

async function verifyLocalAliasIsolation() {
  const store = {}; let environment = 'production'
  const environmentPath = require.resolve('../utils/member-environment')
  const aliasPath = require.resolve('../utils/member-local-alias')
  const savedEnvironment = require.cache[environmentPath], savedAlias = require.cache[aliasPath], previousWx = global.wx
  global.wx = { getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = value }, removeStorageSync: key => { delete store[key] } }
  try {
    require.cache[environmentPath] = { id: environmentPath, filename: environmentPath, loaded: true, exports: { read: () => environment } }
    delete require.cache[aliasPath]
    const alias = require(aliasPath)
    assert.strictEqual(alias.write('  小林  '), '小林')
    assert.strictEqual(alias.read(), '小林', '正式区本机称呼必须立即可读')
    environment = 'sandbox'
    assert.strictEqual(alias.read(), '', '测试区不能读到正式区本机称呼')
    alias.write('测试昵称')
    environment = 'production'
    assert.strictEqual(alias.read(), '小林', '切回正式区必须恢复正式区自己的称呼')
    alias.write('')
    assert.strictEqual(alias.read(), '', '留空保存必须恢复教练登记称呼')
  } finally {
    if (savedEnvironment) require.cache[environmentPath] = savedEnvironment; else delete require.cache[environmentPath]
    if (savedAlias) require.cache[aliasPath] = savedAlias; else delete require.cache[aliasPath]
    if (previousWx === undefined) delete global.wx; else global.wx = previousWx
  }
}

Promise.all([verifyDashboardCache(), verifyLocalAliasIsolation()]).then(() => console.log('member home/profile/training UI tests: PASS'), error => { console.error(error); process.exitCode = 1 })
