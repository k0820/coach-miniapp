const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const cases = []
const check = (name, fn) => cases.push([name, fn])

check('① 会员编号明确绑定长按复制，复制值就是当前公开编号', () => {
  const wxml = read('pages/member-contact-qr/member-contact-qr.wxml')
  const js = read('pages/member-contact-qr/member-contact-qr.js')
  assert.ok(/bindlongpress="copyCode"/.test(wxml), '会员编号必须可长按')
  assert.ok(/setClipboardData\s*\(\s*\{[\s\S]*data:\s*code/.test(js), '长按必须把当前会员编号写进剪贴板')
  assert.ok(/会员编号已复制/.test(js), '复制成功必须有明确反馈')
})

check('② 联系人码由微信生成官方小程序码，自动使用当前小程序Logo', async () => {
  const source = read('cloudfunctions/coachBusinessSandboxCommand/member-directory.js')
  const start = source.indexOf('async function renderContactMiniCode')
  const end = source.indexOf('\n// ③ 把临时 scene', start)
  const body = source.slice(start, end)
  assert.ok(/wxacode\.getUnlimited/.test(body), '必须使用微信官方小程序码接口')
  assert.ok(/scene:\s*cleanText\(scene,\s*32\)/.test(body), '小程序码只能带32位临时scene')
  assert.ok(source.includes("const COACH_ADD_MEMBER_PAGE = 'pages/coach-add-member/coach-add-member'"), '会员联系人码必须打开教练添加会员页')
  assert.ok(/env_version:\s*QR_ENV_VERSION/.test(body), '测试码必须明确打开体验版')
  assert.ok(/check_path:\s*false/.test(body), '体验版页面生成时必须关闭正式路径校验')
  assert.ok(!/require\('qrcode'\)|member-contact-logo\.png|toBuffer\(/.test(source), '不得继续手画方形二维码或维护第二份Logo')
  const memberDirectory = require(path.join(root, 'cloudfunctions/coachBusinessSandboxCommand/member-directory'))
  let sent
  const cloud = { openapi: { wxacode: { getUnlimited: async payload => { sent = payload; return { buffer: Buffer.from('official-mini-code') } } } } }
  const png = await memberDirectory.renderContactMiniCode({ cloud, scene: 'a'.repeat(32), role: memberDirectory.ROLE_MEMBER })
  assert.equal(Buffer.from(png).toString(), 'official-mini-code')
  assert.deepEqual(sent, { scene: 'a'.repeat(32), page: 'pages/coach-add-member/coach-add-member', width: 430, auto_color: false, is_hyaline: false, check_path: false, env_version: 'trial' })
})

check('③ 已绑定会员出示会员编号与联系人二维码，教练用 M 码或扫码添加', () => {
  const source = read('cloudfunctions/coachBusinessSandboxCommand/member-directory.js')
  const page = read('pages/member-contact-qr/member-contact-qr.js')
  const view = read('pages/member-contact-qr/member-contact-qr.wxml')
  const addView = read('pages/coach-add-member/coach-add-member.wxml')
  // 服务端：会员的二维码票据身份必须是会员本人（ROLE_MEMBER），且打开教练添加页
  assert.ok(/role:\s*ROLE_MEMBER/.test(source), '会员二维码票据身份必须是会员本人')
  assert.ok(source.includes('role === ROLE_MEMBER ? COACH_ADD_MEMBER_PAGE : RESOLVE_PAGE'), '会员二维码必须打开教练添加会员页')
  // 客户端「我的联系人码」：长按复制 M 会员编号，并明确告诉教练用来添加自己
  assert.ok(view.includes('bindlongpress="copyCode"'), '会员联系人码上的 M 编号必须支持长按复制')
  assert.ok(view.includes('会员编号'), '页面必须展示会员编号')
  assert.ok(view.includes('让教练扫描这个二维码'), '页面必须明确告诉用户此码给教练添加自己')
  assert.ok(page.includes('copyCode') && /会员编号已复制/.test(page), '长按复制必须明确反馈已复制会员编号')
  assert.ok(/publicCode:\s*String\(result\.member\.publicCode/.test(page), '页面必须读取服务端下发的 M 会员编号')
  // 教练添加会员入口：只接受 M 会员码（不能误用其他码）
  assert.ok(/\^M\[A-F0-9\]\{8\}\$/.test(read('pages/coach-add-member/coach-add-member.js')), '教练查找入口仍只能接受 M 会员码')
  assert.ok(addView.includes('M 开头的会员编号') || addView.includes('M 开头编号'), '教练输入页必须明确要求 M 码')
})

check('④ B教练添加成功后先刷新授权名单，再返回学员页', () => {
  const page = read('pages/coach-add-member/coach-add-member.js')
  assert.ok(/require\('\.\.\/\.\.\/utils\/coach-authorization'\)/.test(page), '添加页必须接入授权名单缓存')
  assert.ok(/await coachAuthorization\.notePermissionChanged\(\)[\s\S]*wx\.navigateBack\(\)/.test(page), '添加成功后必须先拉取最新名单再返回，不能依赖手动下拉')
})

check('⑤ B教练已添加的会员进入课表同一选择弹窗，并走跨教练原命令', async () => {
  const modalPath = require.resolve('../components/booking-modal/booking-modal')
  const modulePaths = {
    runtime: require.resolve('../utils/data-runtime'), constants: require.resolve('../utils/constants'), pinyin: require.resolve('../utils/pinyin'),
    rules: require.resolve('../utils/local-business-rules'), occupancy: require.resolve('../utils/package-occupancy'),
    ui: require.resolve('../utils/ui-cloud-command'), mutate: require.resolve('../utils/mutate'), memberView: require.resolve('../utils/member-booking-view'),
    beijing: require.resolve('../utils/beijing-date'), authorization: require.resolve('../utils/coach-authorization')
  }
  const previous = new Map(Object.values(modulePaths).concat(modalPath).map(p => [p, require.cache[p]]))
  const fake = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports } }
  const calls = []
  const mutation = async (command, payload, options) => { calls.push(options); if (options.onSuccess) options.onSuccess({ ok: true }); return { ok: true } }
  mutation.isCloudWritePath = () => true
  mutation.resolveLocalId = value => value
  fake(modulePaths.runtime, { getDB: () => ({ students: [], bookings: [], incomes: [] }), saveDB() {}, uid: () => 'x', pad: n => String(n).padStart(2, '0'), dateStr: () => '2026-10-08' })
  fake(modulePaths.constants, { TYPES: [{ name: '常规训练', color: '#1b65d8', light: '#eef4ff', gift: false, emoji: '课' }] })
  fake(modulePaths.pinyin, { initials: () => 'ZS' })
  fake(modulePaths.rules, { currentStudent: () => true, validateBookingCreation: () => ({ ok: false }) })
  fake(modulePaths.occupancy, { EARLIEST_START_MINUTES: 360, LATEST_START_MINUTES: 1380, SLOT_STEP_MINUTES: 30, DEFAULT_PLANNED_MINUTES: 60, latestStartMinutes: () => 1380, lessonWindowGateOf: () => null })
  fake(modulePaths.ui, { pendingBookingRecords: () => [] })
  fake(modulePaths.mutate, mutation)
  fake(modulePaths.memberView, { busyOf: () => [], slotsFor: () => [{ start: 900, startText: '15:00', reason: 'available', stateText: '可约' }] })
  fake(modulePaths.beijing, { todayKey: () => '2026-10-08' })
  fake(modulePaths.authorization, { cachedDirectory: () => ({ usable: true, data: { serving: [{ name: '张三', studentId: 'student-a', place: { datasetId: 'dataset-a' }, packages: [{ packageId: 'package-a', type: '常规训练', total: 10, remaining: 10, reserved: 0, availableToBook: 10 }] }] } }) })
  let definition
  const oldComponent = global.Component
  const oldWx = global.wx
  global.Component = value => { definition = value }
  global.wx = { showToast() {}, showModal() {} }
  delete require.cache[modalPath]
  require(modalPath)
  const events = []
  const instance = { properties: { presetDate: '2026-10-08', presetHour: 15 }, data: JSON.parse(JSON.stringify(definition.data)), setData(patch, cb) { Object.assign(this.data, patch); if (cb) cb() }, triggerEvent(name) { events.push(name) } }
  Object.assign(instance, definition.methods)
  instance.init()
  assert.equal(instance.data.students.length, 1, 'B课表弹窗必须出现已添加的张三')
  assert.equal(instance.data.students[0].authorized, true)
  instance.chooseStudent({ currentTarget: { dataset: { id: instance.data.students[0].id } } })
  assert.equal(instance.data.packages[0].left, 10, '必须显示同一份真实课包的可约课时')
  instance.setData({ packageIndex: 0, date: '2026-10-08', hour: 15, minute: 0 })
  await instance.confirm()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'createAuthorizedBooking', 'B必须沿用既有跨教练排课命令')
  assert.deepEqual(calls[0].payload, { studentId: 'student-a', packageId: 'package-a', date: '2026-10-08', hour: 15, minute: 0, plannedMinutes: 60 })
  assert.ok(events.includes('close'), '成功后必须关闭同一个课表弹窗')
  global.Component = oldComponent
  global.wx = oldWx
  for (const [p, value] of previous) { if (value) require.cache[p] = value; else delete require.cache[p] }
})

check('⑥ B教练会员卡提供安全移出入口，明确保留历史数据', () => {
  const page = read('pages/students/students.js')
  const view = read('pages/students/students.wxml')
  const client = read('utils/member-directory.js')
  const cloud = read('cloudfunctions/coachBusinessSandboxCommand/member-directory.js')
  assert.ok(view.includes('bindtap="removeAuthorizedMember"'), 'B教练会员卡必须有移出入口')
  assert.ok(view.includes('移出我的会员列表'), '按钮必须说清是移出当前列表')
  assert.ok(page.includes("const directory = require('../../utils/member-directory')"), '学员页必须接入联系人命令模块')
  assert.ok(/removeMemberContact\(memberId\)/.test(page), '页面必须按当前会员调用安全移除命令')
  for (const phrase of ['已经上过的课','已用课时','历史课时费','收入统计','全部保留']) assert.ok(page.includes(phrase), `确认框缺少说明：${phrase}`)
  assert.ok(/function removeMemberContact\(memberId\)/.test(client), '客户端必须有教练移出会员的专用入口')
  assert.ok(/CONTACT_HAS_UNFINISHED_BOOKINGS/.test(cloud), '还有待上课程时必须阻止移除')
  assert.ok(/historyKept:\s*true/.test(cloud), '服务端必须明确返回历史数据已保留')
})

;(async () => {
  for (const [name, fn] of cases) { await fn(); console.log('PASS', name) }
  console.log(`\n${cases.length}/${cases.length} PASS member code, QR and B schedule`)
})().catch(error => { console.error(error); process.exitCode = 1 })
