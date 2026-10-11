// ═══════════════════════════════════════════════════════════════════════════
// 🎯 §196 · 「真实业务 action ⇒ 统一分发器 ⇒ 站内消息必然存在」端到端服务级专项
//     （2026-10-08 · 1.3.39）
//
// ⭐⭐ 起因（真机证据 + 用户点名的审计要求）：
//   1.3.38 真机：教练给张三排课 ⇒ 课程数据**同步正常**，但会员**微信没通知**，
//      **站内消息中心也没有任何一条**。
//   用户要求：**不要从 notify-booking.js 反向推理**，必须从「教练真机实际点的那个按钮」
//   正向追到「会员站内消息是否落库」。
//
// ⛔⛔ 本文件与 §193 / §194 的区别（这是本轮新判据的关键）：
//   · §193/§194 是**分发器级**：自己构造 `context.notify` 调 `notifyBookingChange`；
//   · 本文件是**服务级**：走 `createService(...)` 的**真入口**发**真命令**
//     （`createBooking` / `cancelBooking` / `rescheduleBooking` / `createMemberBooking` …），
//     ⛔ 不伪造任何中间层 ⇒ 「真实入口根本没进分发器」这一类故障**无处可藏**。
//
// 🎯 教练真机实际用的是哪个 action（**正向追出来的，不是猜的**）：
//   pages/schedule → utils/booking-optimistic.js:285 `adapter.execute(command || 'createBooking')`
//   ⇒ 云函数 `coachBusinessSandboxCommand`，`action:'execute'`，`envelope.command = 'createBooking'`。
//   ⇒ 本文件就**用这一个命令**开跑。
//
// 🏗️ 目标结构（用户第八节定稿，本文件逐条钉死）：
//   BUSINESS SUCCESS → 统一 dispatcher → 解析被动方 → **ALWAYS 站内消息** → BEST-EFFORT 微信
//
// ⛔ 全文件只用**内存假 db**（`tests/helpers/m2-business-world`），磁盘一个字节都不改，
//    也**不连真实云端**；反证脚本走 `mutate-overlay` 内存覆盖层。
// ═══════════════════════════════════════════════════════════════════════════
const assert = require('assert')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const { createWorld } = require('./helpers/m2-business-world')

const SANDBOX = path.join(ROOT, 'cloudfunctions', 'coachBusinessSandboxCommand')
const sandboxCore = require(path.join(SANDBOX, 'core'))
const { handlers: sandboxHandlers } = require(path.join(SANDBOX, 'handlers'))
const { createNotifyDelivery } = require(path.join(SANDBOX, 'notify-adapter'))
const { createInbox } = require(path.join(SANDBOX, 'notification-inbox'))
const notify = require(path.join(SANDBOX, 'notify'))
const authorization = require(path.join(SANDBOX, 'authorization'))
const memberBooking = require(path.join(SANDBOX, 'memberBooking'))

const ENV = 'sandbox'
const CLAIMS = 'member_sandbox_student_claims'
const MEMBERS = 'member_sandbox_members'
const ACCOUNTS = 'member_sandbox_accounts'
const EVENTS = 'member_sandbox_notification_events'
const INBOX_MEMBER = 'member_sandbox_notification_inbox'
const INBOX_COACH = 'coach_sandbox_notification_inbox'

const OPEN_ZHANG = 'open-zhang'
const MEMBER_ZHANG = memberBooking.memberIdFor(OPEN_ZHANG)
const STUDENT_ZHANG = 'stu-zhang'
const PKG = 'pkg-zhang-10'
const DATE = '2030-03-20'

const world = createWorld()

// ⭐ 会员自助预约有「未来 30 天」窗口（真客户端预检同一条规则）⇒ 会员侧必须用**真实今天**附近的日期。
const beijingDate = require(path.join(ROOT, 'utils', 'beijing-date'))
const LIVE_DATE = beijingDate.addDays(beijingDate.todayKey(), 3)

// ───────────────────────────────────────────────────────────────────────────
// 🏗️ 服务：真 `createService` + **真投递层** + **真站内消息**（只把网络那一层换成假的）
// ───────────────────────────────────────────────────────────────────────────
function buildService(options = {}) {
  const sent = []
  const sendMode = options.send || 'ok'   // 'ok' | 'fail' | 'no-quota'
  const cloud = {
    openapi: {
      subscribeMessage: {
        send: async payload => {
          sent.push(payload)
          if (sendMode === 'fail') { const e = new Error('system error'); e.errCode = -1; throw e }
          if (sendMode === 'no-quota') { const e = new Error('user refuse'); e.errCode = 43101; throw e }
          return { errCode: 0, errMsg: 'openapi.subscribeMessage.send:ok' }
        }
      }
    }
  }
  const db = world.db
  const inbox = createInbox({ db, environment: ENV })
  const delivery = createNotifyDelivery({
    cloud, db, environment: ENV, enabled: true,
    accountsCollection: ACCOUNTS, membersCollection: MEMBERS, inbox
  })
  let openId = ''
  const service = () => sandboxCore.createService({
    db, getOpenId: () => openId, handlers: sandboxHandlers, delivery
  })
  return {
    sent, inbox, service,
    as(value) { openId = value; return this },
    get openId() { return openId }
  }
}

const rid = tag => `r196_${tag}_${Math.random().toString(36).slice(2, 10)}`

// 🎯 会员写路径只认这三个「视图 ID」（客户端提交不了真实 id ⇒ 与真机逐字一致）。
const coachKeyOf = coachId => memberBooking.fixedId('member-coach-view', coachId)
const packageViewIdOf = (claimId, packageId) => memberBooking.fixedId('member-package-view', claimId, packageId)
const bookingViewIdOf = (claimId, bookingId) => memberBooking.fixedId(memberBooking.BOOKING_VIEW_KIND, claimId, bookingId)
const claimIdOf = () => memberBooking.fixedId('member-directory-claim', MEMBER_ZHANG)

// 🎯 教练**真机那条**命令通道（`action:'execute'` + `envelope.command`）。
async function coachDo(ctx, actor, command, payload, tag = command) {
  ctx.as(actor.open)
  const revision = world.revisionOf(actor.owner, actor.datasetId)
  return ctx.service()({
    action: 'execute', environment: ENV,
    envelope: { command, requestId: rid(tag), expectedRevision: revision, payload }
  })
}

// 🎯 会员**真机那条**命令通道（`action:'memberBooking'`）。
async function memberDo(ctx, openIdValue, command, payload, tag = command) {
  ctx.as(openIdValue)
  return ctx.service()({
    action: 'memberBooking', command, requestId: rid(tag), environment: ENV, payload: payload || {}
  })
}

// ───────────────────────────────────────────────────────────────────────────
// 🌱 真机数据形状：教练 A 建张三 + 10 节课包 + 张三微信绑定现有会员
//    ⛔ 刻意**不写**任何旧认领表行（`claims` 留空）⇒ 证明不再依赖旧 claim 结构。
// ───────────────────────────────────────────────────────────────────────────
function seedRealDevice(options = {}) {
  world.reset()
  const A = world.seedCoach('open-a', 'ds-a', 'PUBA')
  world.seedStudent(A, STUDENT_ZHANG, '张三')
  world.put('packages', world.businessId('packages', A.owner, A.datasetId, PKG), {
    ownerCoachId: A.owner, datasetId: A.datasetId, packageId: PKG, studentId: STUDENT_ZHANG,
    data: { id: PKG, type: '常规训练', total: 10, remaining: 10, used: 0, reserved: 0, reservedVersion: 2, price: 300, status: 'active' }
  })
  // ⭐ 会员主资料（**唯一真相源**）：绑定那一刻锁死 ownerCoachId + ownerDatasetId + studentId。
  if (!options.noMembers) {
    world.put(MEMBERS, memberBooking.fixedId('member-directory-member', MEMBER_ZHANG), {
      memberId: MEMBER_ZHANG, openId: OPEN_ZHANG, displayName: '张三',
      publicCode: 'PUBZ', ownerCoachId: A.owner, ownerDatasetId: A.datasetId,
      studentId: STUDENT_ZHANG, claimId: memberBooking.fixedId('member-directory-claim', MEMBER_ZHANG),
      status: 'active', createdAt: 1, updatedAt: 1
    })
  }
  if (options.withAccounts) {
    world.put(ACCOUNTS, memberBooking.fixedId(ACCOUNTS, MEMBER_ZHANG), {
      memberId: MEMBER_ZHANG, openId: OPEN_ZHANG, identityHash: 'x', status: 'active'
    })
  }
  if (options.withClaims) {
    // ⭐ 与会员主资料里 `claimId` **同一个值**（`bindMember` 就是这么写的），否则会员写路径
    //    拿 packageViewId 对不上号 ⇒ PACKAGE_NOT_AVAILABLE_FOR_MEMBER。
    const claimId = memberBooking.fixedId('member-directory-claim', MEMBER_ZHANG)
    world.put(CLAIMS, claimId, { claimId, memberId: MEMBER_ZHANG, coachId: A.owner, studentId: STUDENT_ZHANG, status: 'verified' })
  }
  if (options.withGrants) {
    const names = authorization.collectionsFor(ENV)
    const place = { ownerCoachId: A.owner, datasetId: A.datasetId }
    world.put(names.package, authorization.packageGrantId(place, PKG, A.owner), {
      ownerCoachId: A.owner, datasetId: A.datasetId, packageId: PKG, studentId: STUDENT_ZHANG,
      coachId: A.owner, status: authorization.STATUS_ACTIVE, canManage: false, grantedByCoachId: A.owner
    })
    world.put(names.member, authorization.memberAuthId(place, STUDENT_ZHANG, A.owner), {
      ownerCoachId: A.owner, datasetId: A.datasetId, studentId: STUDENT_ZHANG,
      coachId: A.owner, status: authorization.STATUS_ACTIVE, source: authorization.SOURCE_PACKAGE_DERIVED, grantedByCoachId: A.owner
    })
  }
  return A
}

const rowsOf = name => [...(world.stores[name] || new Map()).values()]
const eventsOf = () => rowsOf(EVENTS).map(row => row.data || row)
const inboxRows = name => rowsOf(name)
const memberInbox = () => inboxRows(INBOX_MEMBER)
const coachInbox = () => inboxRows(INBOX_COACH)
const bookingData = () => world.dataRows('bookings', world.stores.packages && world.rows('packages', '', '') ? '' : '', '')
  || []

const results = []
async function test(name, fn) {
  try { await fn(); results.push(`✅ ${name}`) }
  catch (error) {
    results.push(`❌ ${name}\n    ${String(error && error.stack || error).split('\n').slice(0, 6).join('\n    ')}`)
    process.exitCode = 1
  }
}

async function main() {
  console.log('\n【① 教练真机 action：createBooking ⇒ 会员站内消息必然存在】')

  await test('① createBooking 成功 ⇒ 事件落库 + **会员站内消息**有一条（⛔ 不是"可选"）', async () => {
    const A = seedRealDevice()
    const ctx = buildService()
    const result = await coachDo(ctx, A, 'createBooking', { studentId: STUDENT_ZHANG, packageId: PKG, date: DATE, hour: 15, minute: 0 })
    assert.strictEqual(result.ok, true, `排课必须成功（实测 ${result.code} ${result.message}）`)
    const events = eventsOf()
    assert.ok(events.length >= 1, '⛔ 通知事件一条都没有 —— 真实入口没进分发器')
    const event = events[0]
    assert.strictEqual(event.type, notify.EVENT_TYPES.COACH_CREATED, '事件类型必须是 coach-booking-created')
    assert.strictEqual(event.actor.kind, 'coach', 'actor 必须是教练')
    assert.strictEqual(event.recipient.kind, 'member', 'recipient 必须是会员')
    assert.strictEqual(event.recipient.memberId, MEMBER_ZHANG, `收件人必须是张三（实测 ${event.recipient.memberId}）`)
    // ⭐⭐ 本轮核心判据
    const inbox = memberInbox()
    assert.ok(inbox.length >= 1, '⛔ 会员站内消息一条都没有（1.3.38 真机就是这个现象）')
    assert.ok(inbox.some(row => String(row.ownerId || (row.data && row.data.ownerId) || '') === MEMBER_ZHANG),
      '站内消息必须落在张三自己的箱子里')
  })

  await test('② 全程**不依赖**旧认领表：`member_sandbox_student_claims` 留空照样通', async () => {
    const A = seedRealDevice()          // ⛔ 默认不播种 claims
    assert.strictEqual(rowsOf(CLAIMS).length, 0, '（前置）认领表必须是空的')
    const ctx = buildService()
    const result = await coachDo(ctx, A, 'createBooking', { studentId: STUDENT_ZHANG, packageId: PKG, date: DATE, hour: 16, minute: 0 })
    assert.strictEqual(result.ok, true)
    assert.ok(memberInbox().length >= 1, '⛔ 没有旧认领行 ⇒ 会员又收不到站内消息了')
  })

  await test('③ 教练取消（cancelBooking）⇒ 会员站内消息；方向必须是 coach→member', async () => {
    const A = seedRealDevice()
    const ctx = buildService()
    const created = await coachDo(ctx, A, 'createBooking', { studentId: STUDENT_ZHANG, packageId: PKG, date: DATE, hour: 15, minute: 0 }, 'c1')
    const bookingId = created.result.bookingId
    const cancelled = await coachDo(ctx, A, 'cancelBooking', { bookingId }, 'x1')
    assert.strictEqual(cancelled.ok, true, `取消必须成功（实测 ${cancelled.code}）`)
    const types = eventsOf().map(row => row.type)
    assert.ok(types.indexOf(notify.EVENT_TYPES.COACH_CANCELLED) >= 0, `⛔ 没有 coach-booking-cancelled 事件（实测 ${types.join(',')}）`)
    assert.ok(memberInbox().filter(row => (row.type || (row.data && row.data.type) || '') === notify.EVENT_TYPES.COACH_CANCELLED).length >= 1
      || memberInbox().length >= 2, '⛔ 取消之后会员箱子里没有新增消息')
  })

  await test('④ 教练改期（rescheduleBooking）⇒ 会员站内消息', async () => {
    const A = seedRealDevice()
    const ctx = buildService()
    const created = await coachDo(ctx, A, 'createBooking', { studentId: STUDENT_ZHANG, packageId: PKG, date: DATE, hour: 15, minute: 0 }, 'c2')
    const bookingId = created.result.bookingId
    const moved = await coachDo(ctx, A, 'rescheduleBooking', { bookingId, date: DATE, hour: 17, minute: 0 }, 'm1')
    assert.strictEqual(moved.ok, true, `改期必须成功（实测 ${moved.code}）`)
    assert.ok(eventsOf().some(row => row.type === notify.EVENT_TYPES.COACH_RESCHEDULED), '⛔ 没有 coach-booking-rescheduled 事件')
    assert.ok(memberInbox().length >= 2, '⛔ 改期之后会员箱子里没有新增消息')
  })

  console.log('\n【② 会员侧真实 action ⇒ 教练站内消息（保护 1.3.36 已通过的那条）】')

  await test('⑤ 会员 createMemberBooking ⇒ 事件 recipient = coach + **教练站内消息**', async () => {
    const A = seedRealDevice({ withClaims: true, withGrants: true, withAccounts: true })
    const ctx = buildService()
    const result = await memberDo(ctx, OPEN_ZHANG, 'createMemberBooking', {
      coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claimIdOf(), PKG), date: LIVE_DATE, hour: 10, minute: 0
    })
    assert.strictEqual(result.ok, true, `会员预约必须成功（实测 ${result.code} ${result.message}）`)
    const event = eventsOf().find(row => row.type === notify.EVENT_TYPES.MEMBER_CREATED)
    assert.ok(event, '⛔ 没有 member-booking-created 事件')
    assert.strictEqual(event.recipient.kind, 'coach', 'recipient 必须是教练')
    assert.strictEqual(event.recipient.coachId, A.owner, '收件人必须是 A 教练')
    assert.ok(coachInbox().length >= 1, '⛔ 教练站内消息一条都没有')
  })

  await test('⑥ 会员取消 ⇒ 教练站内消息（actor=member / recipient=coach，⛔ 不许反过来）', async () => {
    const A = seedRealDevice({ withClaims: true, withGrants: true, withAccounts: true })
    const ctx = buildService()
    const created = await memberDo(ctx, OPEN_ZHANG, 'createMemberBooking', {
      coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claimIdOf(), PKG), date: LIVE_DATE, hour: 10, minute: 0
    }, 'mb1')
    assert.strictEqual(created.ok, true, `（前置）会员预约必须成功（实测 ${created.code} ${created.message}）`)
    // ⚠️ 会员预约的响应把 `bookingId` 放在**顶层**（不是 `.result` 里）⇒ 取错了就 BOOKING_NOT_MINE。
    const createdBookingId = String((created.result && created.result.bookingId) || created.bookingId || '')
    assert.ok(createdBookingId, '（前置）必须拿到 bookingId')
    const cancelled = await memberDo(ctx, OPEN_ZHANG, 'cancelMemberBooking', {
      bookingViewId: bookingViewIdOf(claimIdOf(), createdBookingId)
    }, 'mc1')
    assert.strictEqual(cancelled.ok, true, `会员取消必须成功（实测 ${cancelled.code}）`)
    const event = eventsOf().find(row => row.type === notify.EVENT_TYPES.MEMBER_CANCELLED)
    assert.ok(event, '⛔ 没有 member-booking-cancelled 事件')
    assert.strictEqual(event.actor.kind, 'member', '⛔ actor 被伪造成教练了')
    assert.strictEqual(event.recipient.kind, 'coach', 'recipient 必须是教练')
    assert.ok(coachInbox().length >= 2, '⛔ 取消之后教练箱子里没有新增消息')
  })

  console.log('\n【③ 微信发不出去 ⇒ 站内消息照旧 + 预约照旧成功】')

  await test('⑦ 微信 send 抛错（没额度 43101）⇒ **预约仍成功** + 站内消息**仍在** + 事件如实留失败码', async () => {
    const A = seedRealDevice({ withAccounts: true })
    const ctx = buildService({ send: 'no-quota' })
    const result = await coachDo(ctx, A, 'createBooking', { studentId: STUDENT_ZHANG, packageId: PKG, date: DATE, hour: 15, minute: 0 })
    assert.strictEqual(result.ok, true, '⛔ 微信发送失败竟然把排课拖失败了')
    assert.ok(memberInbox().length >= 1, '⛔ 微信没额度 ⇒ 站内消息也没了（第七节硬规则被破坏）')
    const event = eventsOf()[0]
    assert.strictEqual(event.delivered, false, '⛔ 没发出去却标成了已投递')
    const delivery = result.notify && result.notify.delivery
    assert.ok(delivery && delivery.results && delivery.results[0] && /43101|SUBSCRIBE/.test(String(delivery.results[0].code || '')),
      `⛔ 失败码没有如实记进响应（实测 ${JSON.stringify(delivery && delivery.results)}）`)
  })

  await test('⑧ 微信通道整体关掉（delivery.enabled=false）⇒ 站内消息**仍然写**', async () => {
    const A = seedRealDevice({ withAccounts: true })
    const db = world.db
    const inbox = createInbox({ db, environment: ENV })
    // ⛔ 故意**不注入**可用的 send：enabled=false 的投递层
    const delivery = createNotifyDelivery({ cloud: null, db, environment: ENV, enabled: false, accountsCollection: ACCOUNTS, membersCollection: MEMBERS, inbox })
    let openId = A.open
    const service = () => sandboxCore.createService({ db, getOpenId: () => openId, handlers: sandboxHandlers, delivery })
    const result = await service()({
      action: 'execute', environment: ENV,
      envelope: { command: 'createBooking', requestId: rid('noch'), expectedRevision: world.revisionOf(A.owner, A.datasetId), payload: { studentId: STUDENT_ZHANG, packageId: PKG, date: DATE, hour: 18, minute: 0 } }
    })
    assert.strictEqual(result.ok, true)
    assert.ok(memberInbox().length >= 1, '⛔ 通道没开 ⇒ 站内消息也没了')
  })

  console.log('\n【④ 课时占用完全不受通知影响】')

  await test('⑨ 排课前后：remaining 不变、reserved +1（通知链一个字节都碰不到课时）', async () => {
    const A = seedRealDevice()
    const pkgId = world.businessId('packages', A.owner, A.datasetId, PKG)
    const before = JSON.parse(JSON.stringify(world.stores.packages.get(pkgId).data))
    const ctx = buildService({ send: 'fail' })     // ⛔ 故意让微信发送爆掉
    const result = await coachDo(ctx, A, 'createBooking', { studentId: STUDENT_ZHANG, packageId: PKG, date: DATE, hour: 15, minute: 0 })
    assert.strictEqual(result.ok, true, '⛔ 微信发送异常竟然把排课拖失败了')
    const after = world.stores.packages.get(pkgId).data
    assert.strictEqual(after.remaining, before.remaining, '⛔ remaining 被通知链改了')
    assert.strictEqual(after.reserved, before.reserved + 1, '⛔ 预约没有占座（或占了多节）')
    assert.ok(memberInbox().length >= 1, '⛔ 站内消息仍必须在')
  })

  console.log('\n【⑤ 认不出人 ⇒ 必须留痕，⛔ 不许静默】')

  await test('⑩ 会员主资料缺失 ⇒ 排课**照样成功**，但 `unresolved` 台账必须有一条', async () => {
    const A = seedRealDevice({ noMembers: true })
    const ctx = buildService()
    const result = await coachDo(ctx, A, 'createBooking', { studentId: STUDENT_ZHANG, packageId: PKG, date: DATE, hour: 19, minute: 0 })
    assert.strictEqual(result.ok, true, '⛔ 认不出会员竟然把排课拖失败了（附属能力不许拖主业务）')
    const note = result.notify || {}
    const unresolved = note.unresolved || []
    assert.ok(unresolved.length >= 1, `⛔ 认不出收件人却什么痕都没留（实测 notify=${JSON.stringify(note)}）`)
    assert.ok(unresolved[0].tried && unresolved[0].tried.length >= 4, '必须记下"试过哪几步"')
  })

  await test('⑪ 静态锚：分发器里 `scope.record(` **只允许一处**（⛔ 结构上不可能漂回两套）', () => {
    const source = require('fs').readFileSync(path.join(SANDBOX, 'notify-booking.js'), 'utf8')
    const hits = source.match(/scope\.record\(/g) || []
    assert.strictEqual(hits.length, 1, `⛔ 分发器里有 ${hits.length} 处登记入口 ⇒ 又会变成两套通知路径`)
  })

  await test('⑫ 静态锚：分发器里**每一个** `return null` 之前都必须先留痕（⛔ 不许静默）', () => {
    const source = require('fs').readFileSync(path.join(SANDBOX, 'notify-booking.js'), 'utf8')
    const body = source.slice(source.indexOf('async function notifyBookingChange'))
    const lines = body.split('\n')
    let silent = 0
    let lastReturn = -1
    lines.forEach((line, index) => {
      if (!/^\s*return null\s*$/.test(line)) return
      // ⛔ 只看**上一个 return null 之后**这一段（否则"别的出口留过痕"会把静默出口掩护过去
      //    —— 反证 ⑥ 就是这么假绿的）。
      const window = lines.slice(lastReturn + 1, index).join('\n')
      lastReturn = index
      if (!/noteUnresolved\(|console\.error\(/.test(window)) silent += 1
    })
    assert.strictEqual(silent, 0, `⛔ 还有 ${silent} 处 return null 之前没有留痕 ⇒ 真机上"没通知"依然查不到原因`)
    assert.ok(/NOTIFY_SCOPE_MISSING/.test(body), '出口① 必须有码')
    assert.ok(/NOTIFY_SUPPRESSED/.test(body), '出口② 必须有码')
    assert.ok(/NOTIFY_EVENT_TYPE_UNRESOLVED/.test(body), '出口③ 必须有码')
    assert.ok(/NOTIFY_REQUEST_ID_MISSING/.test(body), '出口④ 必须有码')
    assert.ok(/NOTIFY_MEMBER_ACTOR_ID_MISSING/.test(body), '出口⑤ 必须有码')
  })

  console.log(`\n${results.join('\n')}`)
  const failed = results.filter(line => line.indexOf('❌') === 0).length
  console.log(failed ? `\n❌ ${failed} 条失败` : `\n🎉 全部 ${results.length} 条通过`)
}

main()
