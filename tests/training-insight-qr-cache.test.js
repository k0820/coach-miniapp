const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const insights = require('../utils/training-insights')

const library = insights.careLibrary()
assert.ok(library.member.length >= 100, '会员关心短句必须至少100条')
assert.ok(library.coach.length >= 100, '教练关心短句必须至少100条')
assert.equal(new Set(library.member).size, library.member.length, '会员关心短句不能重复')
assert.equal(new Set(library.coach).size, library.coach.length, '教练关心短句不能重复')

const records = [
  { historyId: 'h1', date: '2026-10-03', hour: 10, minute: 0, items: [{ name: '深蹲', group: '臀腿训练', sets: 4 }] },
  { historyId: 'h2', date: '2026-10-18', hour: 19, minute: 30, items: [{ name: '臀推', group: '臀腿训练', sets: 5 }] }
]
const member = insights.memberMonthSummary(records, '2026-10')
assert.equal(member.count, 2)
assert.equal(member.dominantGroup, '臀腿')
assert.ok(member.datesText.includes('10月3日 10:00') && member.datesText.includes('10月18日 19:30'))
const chart = insights.chartModel(member.records)
assert.equal(chart.points.length, 2)
assert.equal(chart.lines.length, 1)
assert.ok(chart.points.every(point => point.shortDate && point.fullTime), '趋势点必须同时显示日期和时间')

const coach = insights.coachMonthSummary({
  students: [{ id: 's1', name: '甲' }, { id: 's2', name: '乙' }],
  bookings: [
    { id: 'b1', studentId: 's1', status: 'done', date: '2026-10-03' },
    { id: 'b2', studentId: 's1', status: 'done', date: '2026-10-03' },
    { id: 'b3', studentId: 's2', status: 'done', date: '2026-10-18' }
  ]
}, '2026-10')
assert.equal(coach.count, 3)
assert.equal(coach.topMember, '甲')
assert.equal(coach.busiestDate, '2026-10-03')
assert.equal(coach.busiestLabel, '10月3日')
assert.equal(coach.quietestLabel, '10月18日')

const store = {}
global.wx = {
  getStorageSync: key => store[key],
  setStorageSync: (key, value) => { store[key] = JSON.parse(JSON.stringify(value)) },
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }),
  cloud: { callFunction: async () => ({ result: { ok: true, fileID: 'cloud://qr-file', scene: 'opaque-scene', bound: false, member: { displayName: '测试会员' } } }) }
}
const directoryPath = require.resolve('../utils/member-directory')
delete require.cache[directoryPath]
let directory = require('../utils/member-directory')
;(async () => {
  const generated = await directory.rotateMemberClaimQr('student-1', 'req-1')
  assert.equal(generated.imageUrl, 'cloud://qr-file')
  delete require.cache[directoryPath]
  directory = require('../utils/member-directory')
  const cached = directory.cachedMemberClaimQr('student-1')
  assert.ok(cached && cached.fileID === 'cloud://qr-file', '二维码必须能跨页面重载从本机立即读出')

  const qrPage = read('pages/coach-member-qr/coach-member-qr.js')
  const qrWxml = read('pages/coach-member-qr/coach-member-qr.wxml')
  const students = read('pages/students/students.js')
  const schedule = read('pages/schedule/schedule.wxml')
  const session = read('pages/session/session.js')
  const history = read('pages/member-history/member-history.wxml')
  const memberHome = read('pages/member-home/member-home.wxml')
  const memberHomeJs = read('pages/member-home/member-home.js')
  const memberHomeConfig = JSON.parse(read('pages/member-home/member-home.json'))
  const statsWxml = read('pages/stats/stats.wxml')
  const statsWxss = read('pages/stats/stats.wxss')
  assert.ok(qrPage.indexOf('cachedMemberClaimQr(studentRef)') < qrPage.indexOf('this.load()'), '二维码页必须先显示本机缓存，再后台对账')
  assert.ok(qrWxml.includes('loading && !imageUrl'), '已有缓存图片时不能再用生成中卡片遮住二维码')
  assert.ok(students.includes('prewarmMemberQr(studentId)'), '新建会员保存后必须后台提前生成二维码')
  assert.ok(!/刷新课表|刷新页面|bindtap="refreshScheduleNow"/.test(schedule), '教练课表不得显示多余刷新文字')
  assert.ok(session.includes("title:'本节训练已记录'") && session.includes('completionCareText()'), '点击下课后必须显示关心提示')
  assert.ok(history.includes('trend-canvas') && history.includes('month-summary-card') && history.includes('bindtap="selectPoint"'), '会员训练记录必须使用可点趋势图和月度总结')
  assert.equal(memberHomeConfig.enablePullDownRefresh, false, '会员首页必须关闭会露出大块三点空白区的系统下拉层')
  assert.equal(memberHomeConfig.disableScroll, true, '会员首页必须只由内容区负责滚动，避免两层下拉冲突')
  assert.ok(memberHome.includes('refresher-default-style="none"') && memberHome.includes('bindrefresherrefresh="onRefresherRefresh"'), '会员首页必须使用无图标、内容跟手的下拉刷新')
  assert.ok(!memberHome.includes('wx_dot_loading') && memberHomeJs.includes("this.load({ silent: true })"), '刷新时必须保留现有内容且不能再显示三点同步层')
  assert.ok(statsWxml.includes('coach-insight-member') && statsWxml.includes('coach-insight-busy') && statsWxml.includes('coach-insight-calm'), '教练月度观察必须拆出主次层级')
  ;['#e8f8f1', '#fff0e8', '#eef1ff', '#fff8df'].forEach(color => assert.ok(statsWxss.includes(color), `教练月度观察缺少层次色 ${color}`))
  console.log('training insights + QR first-frame cache: PASS')
})().catch(error => { console.error(error); process.exitCode = 1 })
