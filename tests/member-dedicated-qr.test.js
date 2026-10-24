// 专属会员二维码：长期有效、可主动换码，认领同一条学员记录，绝不复制课包。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')
const WORLD = require('./helpers/m2-business-world')
const md = require('../cloudfunctions/coachBusinessSandboxCommand/member-directory')
const memberRead = require('../cloudfunctions/coachBusinessSandboxCommand/member-read')
const memberBooking = require('../cloudfunctions/coachBusinessSandboxCommand/memberBooking')

function setup() {
  const w = WORLD.createWorld()
  const coach = w.seedCoach('coach-open', 'coach-dataset', 'COACH')
  w.seedStudent(coach, 'student-existing', '张三')
  w.put('packages', w.businessId('packages', coach.owner, coach.datasetId, 'pkg-existing'), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, studentId: 'student-existing', packageId: 'pkg-existing',
    data: { id: 'pkg-existing', type: '常规训练', total: 10, remaining: 10, reserved: 0, used: 0, price: 100, status: 'active' }
  })
  let now = 1900000000000
  const qrCalls = []
  const cloud = {
    openapi: { wxacode: { getUnlimited: async payload => { qrCalls.push(payload); return { buffer: Buffer.from('member-dedicated-qr') } } } },
    uploadFile: async payload => ({ fileID: `cloud://${payload.cloudPath}` })
  }
  const call = (openId, action, payload = {}) => md.createDirectory({
    db: w.db, cloud, getOpenId: () => openId, environment: 'sandbox', now: () => ++now
  })({ action, environment: 'sandbox', requestId: `qr-${String(++now)}`, payload })
  return { w, coach, call, qrCalls, advance: ms => { now += Number(ms || 0) } }
}

;(async () => {
  const x = setup()
  assert.equal(x.w.stores.students.size, 1, '前置：教练已经有一条真实学员记录')
  assert.equal(x.w.stores.member_sandbox_members.size, 0, '前置：旧学员没有新会员目录行')

  const first = await x.call(x.coach.open, 'getMemberClaimQr', { studentRef: 'student-existing' })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.match(first.scene, /^s[0-9a-f]{31}$/)
  assert.equal(first.permanent, true)
  assert.equal(first.expiresAt, 0)
  assert.equal(first.member.displayName, '张三')
  assert.equal(x.w.stores.students.size, 1, '生成二维码不能新建第二位学员')
  assert.equal(x.w.stores.packages.size, 1, '生成二维码不能复制课时包')
  assert.equal(x.w.stores.member_sandbox_members.size, 1, '只允许补一条指向原 studentId 的身份索引')
  const mapped = [...x.w.stores.member_sandbox_members.values()][0]
  assert.equal(mapped.studentId, 'student-existing')
  assert.equal(mapped.ownerCoachId, x.coach.owner)
  assert.equal(mapped.ownerDatasetId, x.coach.datasetId)

  assert.equal(x.qrCalls.length, 1)
  assert.deepEqual(x.qrCalls[0], {
    scene: first.scene, page: 'pages/member-claim/member-claim', width: 430,
    auto_color: false, is_hyaline: false, check_path: false, env_version: 'trial'
  })
  assert.equal(JSON.stringify(x.qrCalls[0]).includes('student-existing'), false, '二维码里不能放 studentId')

  const again = await x.call(x.coach.open, 'getMemberClaimQr', { studentRef: 'student-existing' })
  assert.equal(again.ok, true)
  assert.equal(again.scene, first.scene, '重复打开必须永久复用现有码')
  assert.equal(x.qrCalls.length, 1, '已有永久云文件后不能重复生成')

  // 历史 develop 码会被微信判定为“开发版已过期”。首次重新打开二维码页时必须自动换成 trial 码。
  const legacy = setup()
  const legacyFirst = await legacy.call(legacy.coach.open, 'getMemberClaimQr', { studentRef: 'student-existing' })
  const legacyTicket = [...legacy.w.stores.member_sandbox_contact_tickets.values()].find(row => row.kind === 'member-claim')
  legacyTicket.qrEnvVersion = 'develop'
  const migrated = await legacy.call(legacy.coach.open, 'getMemberClaimQr', { studentRef: 'student-existing' })
  assert.equal(migrated.ok, true)
  assert.notEqual(migrated.scene, legacyFirst.scene, '旧开发版二维码必须自动换新，不能继续返回已过期图片')
  assert.equal(legacy.qrCalls.length, 2)
  assert.equal(legacy.qrCalls[1].env_version, 'trial')

  const preview = await x.call('new-member-open', 'previewMemberClaimQr', { scene: first.scene })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.equal(preview.state, 'available')
  assert.equal(preview.member.displayName, '张三')
  assert.equal([...x.w.stores.member_sandbox_members.values()][0].openId, undefined, '预览不能自动绑定微信')

  x.advance(365 * 24 * 60 * 60 * 1000)
  const afterYear = await x.call('new-member-open', 'previewMemberClaimQr', { scene: first.scene })
  assert.equal(afterYear.ok, true, '永久码一年后仍应可领取')
  const renewed = await x.call(x.coach.open, 'rotateMemberClaimQr', { studentRef: 'student-existing' })
  assert.equal(renewed.ok, true)
  assert.equal(renewed.rotated, true)
  assert.notEqual(renewed.scene, first.scene, '教练主动换码时必须生成新码')
  assert.equal(x.qrCalls.length, 2)
  const revoked = await x.call('new-member-open', 'previewMemberClaimQr', { scene: first.scene })
  assert.equal(revoked.ok, false, '换码后旧码必须立即失效')
  assert.equal(revoked.code, 'MEMBER_CLAIM_QR_INVALID')

  const claimed = await x.call('new-member-open', 'claimMemberByQr', { scene: renewed.scene })
  assert.equal(claimed.ok, true, JSON.stringify(claimed))
  assert.equal(x.w.stores.students.size, 1, '认领不能新建第二位学员')
  assert.equal(x.w.stores.packages.size, 1, '认领不能复制课时包')
  assert.equal(x.w.stores.member_sandbox_members.size, 1, '认领不能新建第二份会员资料')

  const dashboard = await x.call('new-member-open', 'dashboard')
  assert.equal(dashboard.ok, true, JSON.stringify(dashboard))
  assert.equal(dashboard.member.displayName, '张三')
  assert.equal(dashboard.summary.available, 10, '领取后必须直接读到原课包的 10 节')
  assert.equal(dashboard.summary.packageCount, 1)

  // 真机故障复现：专属资料的稳定 memberId 与旧 OPENID 哈希不同，且没有旧 claim 行。
  // 领取后约课页仍必须读到同一位教练、同一课包，并能真正提交预约。
  assert.equal(x.w.stores.member_sandbox_student_claims.size, 0, '前置：专属二维码不依赖旧认领表')
  const readMemberData = memberRead.createService({ db: x.w.db, getOpenId: () => 'new-member-open' })
  const bookingDate = new Date(1900000000000 + 8 * 3600000 + 86400000).toISOString().slice(0, 10)
  const available = await readMemberData({ action: 'availability', environment: 'sandbox', date: bookingDate })
  assert.equal(available.availability, true, JSON.stringify(available))
  assert.equal(available.coaches.length, 1, '领取后约课页必须立即读到主管教练')
  assert.equal(available.packages.length, 1, '领取后约课页必须立即读到原课包')
  const booked = await memberBooking.runMemberBooking({
    db: x.w.db, getOpenId: () => 'new-member-open', now: 1900000000000,
    event: {
      action: 'memberBooking', environment: 'sandbox', command: 'createMemberBooking',
      requestId: 'member_qr_booking_001',
      payload: {
      coachKey: available.coaches[0].coachKey,
      packageViewId: available.packages[0].packageViewId,
      date: bookingDate, hour: 15, minute: 0, plannedMinutes: 60
      }
    }
  })
  assert.equal(booked.ok, true, JSON.stringify(booked))
  assert.equal(x.w.stores.bookings.size, 1, '预约必须写回原教练的同一本账')
  assert.equal([...x.w.stores.packages.values()][0].data.reserved, 1, '预约必须占用原课包的一节')

  const sameAgain = await x.call('new-member-open', 'claimMemberByQr', { scene: renewed.scene })
  assert.equal(sameAgain.ok, true)
  assert.equal(sameAgain.alreadyMine, true, '本人重复扫码必须幂等进入')
  const blocked = await x.call('stranger-open', 'claimMemberByQr', { scene: renewed.scene })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'MEMBER_ALREADY_CLAIMED')

  // 同一个微信默认不能覆盖另一份资料；主管教练明确解除后，才允许拿它继续测试新资料。
  x.w.seedStudent(x.coach, 'student-second', '李四')
  const secondQr = await x.call(x.coach.open, 'getMemberClaimQr', { studentRef: 'student-second' })
  assert.equal(secondQr.ok, true)
  const conflict = await x.call('new-member-open', 'claimMemberByQr', { scene: secondQr.scene })
  assert.equal(conflict.code, 'WECHAT_ALREADY_BOUND')
  const unbound = await x.call(x.coach.open, 'unbindMemberWechat', { studentRef: 'student-existing' })
  assert.equal(unbound.ok, true, JSON.stringify(unbound))
  assert.equal([...x.w.stores.member_sandbox_members.values()].find(row => row.studentId === 'student-existing').openId, '')
  const oldDashboard = await x.call('new-member-open', 'dashboard')
  assert.ok(['ACTOR_UNKNOWN', 'MEMBER_NOT_FOUND'].includes(oldDashboard.code), '解除后原微信不能继续打开旧资料')
  const claimedSecond = await x.call('new-member-open', 'claimMemberByQr', { scene: secondQr.scene })
  assert.equal(claimedSecond.ok, true, JSON.stringify(claimedSecond))
  const secondDashboard = await x.call('new-member-open', 'dashboard')
  assert.equal(secondDashboard.member.displayName, '李四')

  const appJson = JSON.parse(read('app.json'))
  assert.ok(appJson.pages.includes('pages/member-claim/member-claim'))
  assert.ok(appJson.pages.includes('pages/coach-member-qr/coach-member-qr'))
  const students = read('pages/students/students.wxml')
  const studentsJs = read('pages/students/students.js')
  assert.ok(students.includes('专属会员二维码'))
  assert.ok(students.includes('bindtap="openDedicatedMemberQr"'))
  assert.ok(studentsJs.includes('/pages/coach-member-qr/coach-member-qr?studentRef='))
  assert.ok(studentsJs.includes('prepareOfficialStudentRef'), '新建会员生成二维码前必须自动等待本机临时编号转成云端正式编号')
  assert.ok(studentsJs.includes("resolved.indexOf('loc_')!==0"), '尚未同步完成时不得把临时编号发给二维码云函数')
  assert.ok(studentsJs.includes('encodeURIComponent(studentRef)'), '二维码页面必须接收解析后的正式会员编号')
  assert.ok(students.includes('删除这个课时包'), '会员详情必须提供明确的课时包删除入口，不能再显示为清零')
  assert.equal(students.includes('添加会员</view>'), false, '学员资料里不能再引导“添加会员/扫描会员二维码”')
  const memberProfile = read('pages/member-profile/member-profile.wxml')
  const memberProfileJs = read('pages/member-profile/member-profile.js')
  assert.equal(memberProfile.includes('进入教练端'), false, '会员端不应显示进入教练端按钮')
  assert.equal(memberProfileJs.includes('coachMode'), false, '会员端不应残留切换到教练端的处理函数')
  const oldDetail = read('pages/coach-member-detail/coach-member-detail.wxml')
  assert.equal(oldDetail.includes('生成专属二维码'), false, '旧通讯录详情页不能出现本功能')
  const coachQr = read('pages/coach-member-qr/coach-member-qr.wxml')
  const coachQrJs = read('pages/coach-member-qr/coach-member-qr.js')
  const directoryClient = read('utils/member-directory.js')
  assert.ok(coachQr.includes('show-menu-by-longpress'))
  assert.ok(coachQr.includes('open-type="share"'))
  assert.ok(coachQr.includes('长期有效'), '页面必须明确二维码长期有效')
  assert.ok(coachQr.includes('换一张二维码'), '页面必须提供主动换码入口')
  assert.ok(coachQrJs.includes('imageUrl: result.fileID') || coachQrJs.includes('result.imageUrl || result.fileID'), '二维码首屏必须直接使用云文件，不等待临时链接')
  assert.ok(directoryClient.includes('memberClaimQrCache'), '重复打开应直接复用本机刚拿到的永久二维码')
  assert.ok(directoryClient.includes('rotateMemberClaimQr'), '客户端必须支持主动换码')
  assert.ok(directoryClient.includes('unbindMemberWechat'), '客户端必须支持主管教练解除微信绑定')
  assert.ok(directoryClient.includes('const claimReady = { ...result, imageUrl: result.fileID }'), '客户端必须直接显示 cloud 文件，不能把临时链接放在首屏关键路径')
  assert.ok(coachQrJs.includes('/pages/member-claim/member-claim?scene='))
  const claimPage = read('pages/member-claim/member-claim.js')
  assert.ok(claimPage.includes('确认领取这份资料'))
  const role = read('utils/app-role.js')
  assert.ok(role.includes("path !== 'pages/member-add-coach/member-add-coach' && path !== 'pages/member-claim/member-claim'"))

  // 真机首扫发生在一个全新的微信环境：scene 前缀必须立即选择正确环境，
  // 不能只写 Storage 等下一次冷启动，否则领取页第一趟预览会读错数据区。
  const savedWx = global.wx
  const storage = new Map()
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value)
  }
  for (const file of ['../utils/member-environment', '../utils/data-runtime', '../utils/app-role']) {
    delete require.cache[require.resolve(file)]
  }
  const memberEnvironment = require('../utils/member-environment')
  const dataRuntime = require('../utils/data-runtime')
  assert.equal(dataRuntime.environment(), 'production', '前置：新进程默认在正式区')
  memberEnvironment.enterFromClaimScene(first.scene)
  assert.equal(dataRuntime.environment(), 'sandbox', 's 前缀扫码入口必须立即把本次进程切到测试区')
  assert.deepEqual(memberEnvironment.pair(), { role: 'member', environment: 'sandbox' })
  memberEnvironment.enterFromClaimScene(`p${first.scene.slice(1)}`)
  assert.equal(dataRuntime.environment(), 'production', 'p 前缀扫码入口必须立即把本次进程切到正式区')
  assert.deepEqual(memberEnvironment.pair(), { role: 'member', environment: 'production' })
  global.wx = savedWx
  for (const file of ['../utils/member-environment', '../utils/data-runtime', '../utils/app-role']) {
    delete require.cache[require.resolve(file)]
  }

  console.log('PASS member dedicated QR: permanent QR, active rotation, auto environment, same packages and exclusive binding')
})().catch(error => { console.error(error); process.exitCode = 1 })
