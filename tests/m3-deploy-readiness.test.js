// M3 P1–P6 **部署/上传前**总集成检查（2026-09-30）
//
// 这一份只回答一个问题：**这一版能不能作为一个一致的版本部署**？
// 特别盯住一种危险顺序 —— **客户端先开、云端没部署**：
//   真机上会员点「确认预约」会拿到"云函数不认识这个 action"，或者更糟：
//   云函数是旧版、客户端是新版 ⇒ 校验口径对不上，出错还说不清为什么。
//
// ⛔ 本轮**不部署、不上传**；这里只把"部署前必须为真"的那些不变量钉成永久测试。
// ✅ M3-P6 已落地（2026-09-30）：`cancelMemberBooking` / `rescheduleMemberBooking` 的云端写链
//    与六条产品规则**都已定稿** ⇒ 本文件原来那两条"P4 必须仍然锁死"的断言已被取代，
//    改成钉**新契约**：写命令恰好三条（不许再多一条）、两个总闸各自独立且都与云端能力一致。

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const memberBooking = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
const cloudOccupancy = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/occupancy'))
const localOccupancy = require(path.join(ROOT, 'utils/package-occupancy'))
const flags = require(path.join(ROOT, 'utils/release-flags'))
const manage = require(path.join(ROOT, 'utils/member-booking-manage'))
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
}

// ⭐ 与本批改动相关的**部署单元**（改了就必须重新部署 / 重新上传）。
//   ⛔ 这是一份**清单**，不是自动判定：谁改了什么仍以磁盘 diff 为准，但至少不会漏掉一个目录。
const CLOUD_UNITS = [
  { name: 'coachBusinessCommand', files: ['cloudfunctions/coachBusinessCommand/memberBooking.js', 'cloudfunctions/coachBusinessCommand/core.js', 'cloudfunctions/coachBusinessCommand/handlers.js', 'cloudfunctions/coachBusinessCommand/occupancy.js', 'cloudfunctions/coachBusinessCommand/notify.js'] },
  { name: 'readMyActiveCoachData', files: ['cloudfunctions/readMyActiveCoachData/changes.js'] },
  { name: 'readMyMemberData', files: ['cloudfunctions/readMyMemberData/service.js'] }
]
const CLIENT_FILES = [
  'utils/release-flags.js', 'utils/member-booking-request.js', 'utils/member-booking-view.js',
  // ⛔ `utils/member-coach-tools.js` **不在**这个清单里：它 M1 就已部署，本轮**一行没改**
  //    （新卡片只是复用它）⇒ 不需要重新上传。把它列进来会让人误以为要动一条已真机验证过的链路。
  'utils/member-booking-manage.js', 'utils/package-occupancy.js', 'utils/member-runtime.js',
  'pages/member-book-slots/member-book-slots.js', 'pages/member-book-slots/member-book-slots.wxml',
  'pages/member-bookings/member-bookings.js', 'pages/member-bookings/member-bookings.wxml', 'pages/member-bookings/member-bookings.wxss',
  // ⭐ 2026-10-06：旧的「多教练服务（授权）工作台」`pages/coach-authorization` 已随认领方案下线；
  //    跨教练排课的出口搬到**学员列表页** ⇒ 这一版要重新上传的是学员页这一份（改动真的在里面）。
  'pages/students/students.js', 'pages/students/students.wxml', 'pages/students/students.wxss'
]

const results = []
function test(name, fn) {
  return fn().then(() => results.push(`PASS ${name}`), error => { results.push(`FAIL ${name}: ${error.message}`); process.exitCode = 1 })
}

async function main() {
  await test('① 会员写命令**恰好三条**：创建 / 取消 / 改期，不许再多一条', async () => {
    assert.deepEqual([...memberBooking.MEMBER_COMMANDS],
      ['createMemberBooking', 'cancelMemberBooking', 'rescheduleMemberBooking'])
    // ⛔ 白名单是**闭集**：多出任何一条都要在这里变红（新开一条会员能力必须显式改这个断言，
    //    而不是悄悄被 `includes` 放过 —— 这才是"窄通道"的意义）。
    assert.strictEqual(memberBooking.MEMBER_COMMANDS.length, 3, '窄通道只许三条')
    assert.strictEqual(memberBooking.MEMBER_COMMANDS.includes(manage.CANCEL_COMMAND), true, '取消命令必须已在云端开放（P6）')
    assert.strictEqual(memberBooking.MEMBER_COMMANDS.includes(manage.RESCHEDULE_COMMAND), true, '改期命令必须已在云端开放（P6）')
    const source = stripComments(read('cloudfunctions/coachBusinessCommand/memberBooking.js'))
    // ⛔ 断言必须**带分隔符**：只匹配命令名的话，把命令改名成 `cancelMemberBookingX` 也照样绿（假绿）。
    assert.ok(/cancelMemberBookingHandler\s*\(/.test(source), '云端必须有取消命令的 handler')
    assert.ok(/rescheduleMemberBookingHandler\s*\(/.test(source), '云端必须有改期命令的 handler')
    assert.ok(/MEMBER_PAYLOAD_KEYS/.test(source), '必须有按命令分表的字段白名单')
    // 每条命令都必须在**分表**里有自己的字段白名单（否则取消也能夹带时间）
    for (const command of [memberBooking.CREATE_COMMAND, memberBooking.CANCEL_COMMAND, memberBooking.RESCHEDULE_COMMAND]) {
      assert.ok(memberBooking.MEMBER_PAYLOAD_KEYS[command], `${command} 必须有字段白名单`)
    }
    // ⛔ 会员白名单里**永远不许**出现授权类命令（会员不能自己给自己授权）
    for (const forbidden of ['grantPackageTeaching', 'grantMemberService', 'grantAuthorization']) {
      assert.ok(!memberBooking.MEMBER_COMMANDS.includes(forbidden), `⛔ 会员通道不许有 ${forbidden}`)
    }
  })

  await test('② P6 管理写链**已接通且自洽**（总闸 true × 规则已定 × 云端真有实现）', async () => {
    assert.strictEqual(flags.MEMBER_MANAGE_SUBMIT, true, 'P6：云端写链 + 客户端接线 + 测试 + 反证齐备后才允许打开')
    assert.strictEqual(flags.memberManageSubmitEnabled(), true)
    assert.strictEqual(manage.policyBlocked(), false, '六条规则已定稿 ⇒ 不再阻塞')
    assert.strictEqual(manage.openPolicyPoints().length, 0, '不许还有未定的 policy 扩展点')
    // 六条规则必须与云端逐字段一致（改一处不改另一处 ⇒ 红）
    const cloud = memberBooking.MANAGE_POLICY
    for (const key of Object.keys(manage.POLICY_DEFAULTS)) {
      const a = cloud[key], b = manage.POLICY_DEFAULTS[key]
      assert.ok(a === b || (a === Infinity && b === Infinity), `规则 ${key} 云端与客户端不一致：cloud=${a} client=${b}`)
    }
  })

  await test('③ P3 direct policy：会员预约不需要教练确认', async () => {
    assert.strictEqual(memberBooking.currentPolicy(), memberBooking.POLICY_DIRECT)
    assert.strictEqual(memberBooking.requestStatusOf(memberBooking.POLICY_DIRECT), 'confirmed')
    // ⛔ "未选择"这一档不许再回到运行状态（真机上用户会拿到看不懂的拒绝码）
    const source = stripComments(read('cloudfunctions/coachBusinessCommand/memberBooking.js'))
    assert.ok(/let SELECTED_POLICY\s*=\s*POLICY_DIRECT/.test(source), '默认必须是 direct')
    // ⛔ "未选择"不再是**默认状态**，但作为 **fail closed 分支**必须留着：
    //    万一有人显式 `setPolicy(null)`（测试还原 / 紧急关停）⇒ 必须拒，不许退回某个默认值。
    assert.ok(/MEMBER_BOOKING_POLICY_NOT_SELECTED/.test(source), 'fail closed 分支必须保留')
    // 新进程里的默认就是 direct（不是被某个用例改出来的）
    const freshPath = require.resolve(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
    delete require.cache[freshPath]
    const fresh = require(freshPath)
    assert.strictEqual(fresh.currentPolicy(), 'direct', '干净进程里的默认 policy 必须是 direct')
  })

  await test('④ 会员预约窗口 = 今天～+30 天，且**只有一个地方定义 30**', async () => {
    assert.strictEqual(cloudOccupancy.MEMBER_BOOKING_MAX_DAYS, 30)
    // 云端与本机孪生必须同口径（两套 30 是最典型的漂移）
    assert.strictEqual(localOccupancy.MEMBER_BOOKING_MAX_DAYS, cloudOccupancy.MEMBER_BOOKING_MAX_DAYS)
    const today = memberBooking.beijingDateKey(1900000000000)
    const add = cloudOccupancy.addDateDays
    assert.strictEqual(cloudOccupancy.memberBookingDateAllowed(today, today), 'ok', '今天必须可约')
    assert.strictEqual(cloudOccupancy.memberBookingDateAllowed(add(today, 30), today), 'ok', '+30 必须可约')
    assert.strictEqual(cloudOccupancy.memberBookingDateAllowed(add(today, 31), today), 'beyond', '+31 必须拒')
    assert.strictEqual(cloudOccupancy.memberBookingDateAllowed(add(today, -1), today), 'past', '过去必须拒')
    // 只定义一次
    const files = ['cloudfunctions/coachBusinessCommand/occupancy.js', 'utils/package-occupancy.js']
    files.forEach(file => {
      const source = stripComments(read(file))
      assert.strictEqual(source.match(/MEMBER_BOOKING_MAX_DAYS\s*=\s*30/g).length, 1, `${file} 里 30 必须只定义一次`)
    })
  })

  await test('⑤ 无教练档案 ⇒ MEMBER_CLAIM_NOT_FOUND，且**零写入**', async () => {
    const source = stripComments(read('cloudfunctions/coachBusinessCommand/memberBooking.js'))
    assert.ok(/MEMBER_CLAIM_NOT_FOUND/.test(source), '必须有"没有认领"这个明确拒绝')
    // 拒绝路径上不许出现任何建档动作
    const resolveBlock = source.slice(source.indexOf('async function resolveMemberTarget'), source.indexOf('async function createMemberBookingHandler'))
    assert.ok(resolveBlock.length > 100, '要能定位到解析函数')
    ;['createStudent', 'createClaim', 'claimStudentRecord', 'ensureMember', 'addStudent'].forEach(symbol => {
      assert.ok(!resolveBlock.includes(symbol), `解析阶段不许出现 ${symbol}（禁止自助建档）`)
    })
  })

  await test('⑥ readMyMemberData 的 P1–P4 改动与会员端兼容（状态如实透传 + 下发 packageViewId）', async () => {
    const source = stripComments(read('cloudfunctions/readMyMemberData/service.js'))
    assert.ok(/packageViewId/.test(source), '必须下发课包视图 ID（真实 packageId 不出网）')
    assert.ok(/status:\s*data\.status/.test(source) || /status\s*===\s*'done'\s*\?\s*'done'/.test(source), '状态必须如实透传')
    // ⛔ 不许把 cancelled / noshow 折叠成 booked（那会让会员端永远判不出"已取消"）
    const sanitize = source.slice(source.indexOf('function sanitizeBooking'), source.indexOf('function sanitizeBooking') + 900)
    assert.ok(sanitize.length > 100)
    assert.ok(!/status\s*===\s*'done'\s*\?\s*'done'\s*:\s*'booked'/.test(sanitize), '不许把其它状态一律折叠成 booked')
    // 会员端视图层认得这些状态
    const view = require(path.join(ROOT, 'utils/member-booking-view'))
    assert.deepEqual([...view.TERMINAL_STATUSES], ['done', 'cancelled', 'noshow'])
    assert.strictEqual(view.statusTextOf({ status: 'cancelled' }), '已取消')
    assert.strictEqual(view.canManageOf({ status: 'cancelled' }), false, '已取消不能再取消')
  })

  await test('⑦ 增量同步认识 createMemberBooking（否则会员约完教练端会退回全量读）', async () => {
    const source = stripComments(read('cloudfunctions/readMyActiveCoachData/changes.js'))
    // ⛔ 必须带上冒号：**只匹配命令名**的话，把命令改名成 `createMemberBookingX` 也照样绿（假绿）。
    assert.ok(/createMemberBooking\s*:/.test(source), '增量同步必须认识这条命令')
    const block = source.slice(source.indexOf('createMemberBooking'), source.indexOf('createMemberBooking') + 260)
    assert.ok(/bookings/.test(block), '至少要回读 bookings')
  })

  await test('⑧ ⛔ 危险顺序自检：客户端写链开着 ⇒ 云端**必须**已经有对应入口', async () => {
    const core = stripComments(read('cloudfunctions/coachBusinessCommand/core.js'))
    // ⭐ 这条是"客户端先开、云端没部署"的唯一防线：
    //    只要 MEMBER_BOOKING_SUBMIT 为 true，`core.js` 里就必须真有 memberBooking 分支，
    //    且这个分支要在**教练身份校验之前**（会员不是教练 ⇒ 放在后面会被 COACH_NOT_FOUND 挡掉）。
    assert.ok(/event\.action === 'memberBooking'/.test(core), '云端必须有 memberBooking 入口')
    assert.ok(fs.existsSync(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking.js')), '通道文件必须存在')
    const branchAt = core.indexOf("event.action === 'memberBooking'")
    const coachGateAt = core.indexOf('const ownerCoachId = coachIdFor(openId)')
    assert.ok(branchAt > 0 && coachGateAt > 0, '要能定位两处')
    assert.ok(branchAt < coachGateAt, '会员入口必须在教练身份校验之前（否则会员会被当成没注册的教练）')
    if (flags.memberBookingSubmitEnabled()) {
      assert.ok(/MEMBER_COMMANDS/.test(read('cloudfunctions/coachBusinessCommand/memberBooking.js')), '开关开着就必须有命令白名单')
    }
  })

  await test('⑨ 部署单元清单完整：列出的每个文件都真实存在（避免漏部署一个目录）', async () => {
    for (const unit of CLOUD_UNITS) {
      for (const file of unit.files) {
        assert.ok(fs.existsSync(path.join(ROOT, file)), `${unit.name} 的 ${file} 必须存在`)
      }
    }
    for (const file of CLIENT_FILES) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `客户端文件 ${file} 必须存在`)
    }
    assert.strictEqual(CLOUD_UNITS.length, 3, '本批必须重新部署的云函数：coachBusinessCommand / readMyActiveCoachData / readMyMemberData')
  })

  await test('⑩ 云端与客户端的“目录版本水印”没被改坏（两边各写一份，改形状必须两边都 +1）', async () => {
    const cloud = stripComments(read('cloudfunctions/coachBusinessCommand/authorization.js'))
    const client = stripComments(read('utils/coach-authorization.js'))
    const match = cloud.match(/DIRECTORY_SHAPE\s*=\s*'([^']+)'/)
    assert.ok(match, '云端必须有目录形状水印')
    const cloudShape = match[1]
    const clientMatch = client.match(/SHAPE\s*=\s*'([^']+)'|'([^']*m2-dir[^']*)'/)
    assert.ok(clientMatch, '客户端也要有一份水印常量（否则真机上分不清云函数到底更新了没）')
    assert.ok(client.includes(cloudShape), `客户端水印必须包含云端水印 ${cloudShape}`)
  })

  await test('⑪ 两个总闸**各自独立**且都与云端能力一致：P3 创建开、P6 管理开', async () => {
    assert.strictEqual(flags.memberBookingSubmitEnabled(), true, 'P3 真实预约已接通（但云端未部署 ⇒ 真机上现在仍会失败）')
    assert.strictEqual(flags.memberManageSubmitEnabled(), true, 'P6 取消 / 改期已接通（同样：云端未部署 ⇒ 真机上现在仍会失败）')
    const source = stripComments(read('utils/release-flags.js'))
    assert.ok(/const MEMBER_BOOKING_SUBMIT = true/.test(source))
    assert.ok(/const MEMBER_MANAGE_SUBMIT = true/.test(source))
    // ⛔ 两个总闸是**两个独立的常量**（关一个不许影响另一个）
    assert.ok(/const MEMBER_BOOKING_SUBMIT/.test(source) && /const MEMBER_MANAGE_SUBMIT/.test(source), '两个总闸必须各自有独立常量')
    // ⭐ 新增：本批必须重新部署的云函数里要包含 notify.js（M3-P6 的通知事件层）
    const commandUnit = CLOUD_UNITS.find(unit => unit.name === 'coachBusinessCommand')
    assert.ok(commandUnit.files.includes('cloudfunctions/coachBusinessCommand/notify.js') ||
      fs.existsSync(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/notify.js')), '通知事件层必须随 coachBusinessCommand 一起部署')
  })
}

main().then(() => {
  results.forEach(line => process.stdout.write(line + '\n'))
}, error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
