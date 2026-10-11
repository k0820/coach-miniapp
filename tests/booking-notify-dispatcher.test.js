// ─────────────────────────────────────────────────────────────────────────────
// §194 · 预约变动通知的**端到端服务级**专项（2026-10-07 · 1.3.38）
//
// ⭐⭐ 起因（用户 1.3.37 真机结论）：
//   「会员约教练」那条链真机 PASS，反过来的「教练约会员」两轮都没修好。
//   用户点名的修复策略是：**不要再修补失败链，把已经成功的模式反过来复用** ——
//   「谁操作，就通知另一方」，两个方向**共用同一个分发器**。
//
// ⛔⛔ 本测试与上一轮（§193）最大的区别：**不再只测"某个函数返回对不对"**，
//     而是**服务级端到端**：真的走完 分发器 → 事件登记 → 落库 → 投递 → 微信 send 这五步，
//     并断言**最后一次 `subscribeMessage.send` 的 `touser` 到底是谁的 OPENID**。
//
// 🎯 六个业务场景（两条方向各三个），⛔ 全部走**同一个** `notifyBookingChange`：
//     会员预约 / 会员取消 / 会员改期 ⇒ recipient = coach ⇒ 发到教练 OPENID
//     教练排课 / 教练取消 / 教练改期 ⇒ recipient = member ⇒ 发到会员 OPENID
//
// 📌 数据形状一律按**当前真机**：教练 A 先建张三 ⇒ 张三微信绑定既有会员
//     ⇒ `member_sandbox_members` 里有一行带 (ownerCoachId + ownerDatasetId + studentId + openId)。
//   ⛔ 旧认领表 `claims` **故意留空**：新会员不靠它存活（不能依赖旧 claim/archive 存在）。
//
// ⛔ 判据不是字符串：跑**真的** `notify-booking` / `notify` / `subscribe-delivery` / `notify-adapter`，
//    只把数据库与 `subscribeMessage.send` 换成假的。
// ----------------------------------------------------------------------------
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const SANDBOX = path.join(ROOT, 'cloudfunctions', 'coachBusinessSandboxCommand')
const NOTIFY = path.join(SANDBOX, 'notify.js')
const NOTIFY_BOOKING = path.join(SANDBOX, 'notify-booking.js')
const ADAPTER = path.join(SANDBOX, 'notify-adapter.js')
const DELIVERY = path.join(SANDBOX, 'subscribe-delivery.js')
const HANDLERS = path.join(SANDBOX, 'handlers.js')
const MEMBER_BOOKING = path.join(SANDBOX, 'memberBooking.js')

const MEMBERS = 'member_sandbox_members'
const ACCOUNTS = 'member_sandbox_accounts'
const CLAIMS = 'member_sandbox_student_claims'
const EVENTS = 'member_sandbox_notification_events'

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')

// 📌 真机数据形状：会员 OPENID ⇒ memberId 的既有公式（`member-directory.memberIdForOpenId`）。
const OPENID_ZHANG = 'o-member-zhang-sandbox'
const OPENID_COACH = 'o-coach-a-sandbox'
const MEMBER_ZHANG = sha(`member:${OPENID_ZHANG}`).slice(0, 32)
const COACH_A = 'coach-a-owner'
const DATASET_A = 'dataset-a-owner'
const STUDENT_ZHANG = 'student-zhang-real'
const BOOKING_ID = 'bk-real-1'

const cleanForTest = () => {
  ;[NOTIFY, NOTIFY_BOOKING, ADAPTER, DELIVERY, path.join(SANDBOX, 'notify-templates.js'), path.join(SANDBOX, 'authorization.js')]
    .forEach(file => { delete require.cache[require.resolve(file)] })
}

// 🗄️ 内存版云数据库（只做 `where` / `doc.get` / `doc.set`，够跑通整条链）
function makeDb(stores, missing = []) {
  const read = name => {
    if (missing.indexOf(name) >= 0) {
      // ⛔ 真机上"集合还没建出来"就是这个错：`-502005 Db or Table not exist`
      throw Object.assign(new Error(`Db or Table not exist: ${name}`), { errCode: -502005 })
    }
    return stores[name] || []
  }
  return {
    async createCollection() { throw new Error('already exists') },
    collection(name) {
      return {
        where(query) {
          const filter = () => read(name).filter(row => Object.keys(query || {}).every(key => row[key] === query[key]))
          return {
            limit(count) { return { get: async () => ({ data: filter().slice(0, count || 100) }) } },
            get: async () => ({ data: filter() })
          }
        },
        doc(id) {
          return {
            get: async () => ({ data: read(name).find(row => row._id === id) || null }),
            set: async ({ data }) => { stores[name] = stores[name] || []; stores[name].push({ _id: id, ...data }) }
          }
        }
      }
    }
  }
}

// 📦 「教练 A 已创建张三 + 张三微信已绑定」之后云端**应当**存在的数据形状。
function baseStores(options = {}) {
  const opts = options || {}
  return {
    [MEMBERS]: opts.noMembers ? [] : [{
      _id: 'member-row', memberId: MEMBER_ZHANG, openId: opts.membersOpenId === null ? '' : OPENID_ZHANG,
      displayName: '张三', ownerCoachId: COACH_A, ownerDatasetId: DATASET_A, studentId: STUDENT_ZHANG,
      claimId: 'claim-of-zhang', status: 'active'
    }],
    [ACCOUNTS]: opts.noAccounts ? [] : [{
      _id: 'account-row', memberId: MEMBER_ZHANG, openId: opts.accountsOpenId === null ? '' : OPENID_ZHANG,
      status: 'active', displayName: '张三'
    }],
    // ⛔ 旧认领表**故意留空**：新会员身份不靠它存活。
    [CLAIMS]: opts.legacyClaims === true ? [{
      _id: 'claim-of-zhang', claimId: 'claim-of-zhang', memberId: MEMBER_ZHANG,
      coachId: COACH_A, studentId: STUDENT_ZHANG, status: 'verified'
    }] : [],
    [EVENTS]: [],
    coaches: [{ _id: COACH_A, openId: OPENID_COACH, displayName: 'A教练' }]
  }
}

// 🎯 端到端跑一次「预约变动 ⇒ 通知另一方」。
//   ⛔ 两个方向**都**走 `notifyBooking.notifyBookingChange` —— 这正是本轮要钉死的结构。
async function runDispatch({ actorRole, act, options = {} }) {
  cleanForTest()
  const notify = require(NOTIFY)
  const notifyBooking = require(NOTIFY_BOOKING)
  const { createNotifyDelivery } = require(ADAPTER)
  const deliveryModule = require(DELIVERY)

  const stores = baseStores(options)
  const db = makeDb(stores, options.missing || [])
  const actingCoachId = String(options.ownerCoachId || COACH_A)
  const scope = notify.scope(db, 'sandbox', actingCoachId, DATASET_A)

  const booking = {
    id: BOOKING_ID, date: '2026-10-12', hour: 15, minute: 0, status: 'booked',
    studentId: STUDENT_ZHANG, packageId: 'pkg-zhang-10',
    // ⭐ 真机形状：会员自己约的课，booking 上就带着"谁约的"；教练改期这种课时它还在。
    ...(actorRole === 'member' || options.bookingCreatedByMember === true ? { createdByMemberId: MEMBER_ZHANG } : {})
  }
  const event = await notifyBooking.notifyBookingChange(
    { notify: scope, requestId: 'req-194', now: 1700000000000 },
    {
      actorRole, act, booking,
      business: { ownerCoachId: actingCoachId, datasetId: DATASET_A },
      memberId: MEMBER_ZHANG,
      requestId: 'req-194', now: 1700000000000
    }
  )

  const events = scope.events()
  if (!events.length) {
    return { event: null, recipient: null, sentTo: '', sent: false, code: 'NO_EVENT', stores, unresolved: scope.unresolved() }
  }
  await scope.flush(db)

  const calls = []
  const send = async payload => { calls.push(payload) }
  const adapterObj = createNotifyDelivery({
    cloud: null, db, environment: 'sandbox', enabled: true,
    accountsCollection: ACCOUNTS, membersCollection: MEMBERS
  })
  const outcome = await deliveryModule.deliverEvents({
    db, environment: 'sandbox', events, send, openIdFor: adapterObj.openIdFor, now: Date.now()
  })
  const first = events[0]
  return {
    event: first,
    recipient: first.recipient,
    actor: first.actor,
    sentTo: calls.length ? String(calls[0].touser) : '',
    sentToCount: calls.length,
    sent: !!(outcome.results[0] && outcome.results[0].sent),
    code: String((outcome.results[0] && outcome.results[0].code) || ''),
    templateId: calls.length ? String(calls[0].templateId) : '',
    stores, unresolved: scope.unresolved()
  }
}

const cases = []
const test = (name, fn) => cases.push({ name, fn })

// ═══════════════════════════════ B 链：教练动 ⇒ 通知会员（1.3.36 / 1.3.37 两轮真机都没过）
test('① 教练排课 ⇒ 事件产生，recipient = 会员张三，端到端真的发到张三 OPENID', async () => {
  const out = await runDispatch({ actorRole: 'coach', act: 'create' })
  assert.ok(out.event, '必须真的产生一条通知事件')
  assert.strictEqual(out.event.type, 'coach-booking-created')
  assert.strictEqual(out.recipient.kind, 'member', '教练动的事件，收件人必须是会员')
  assert.strictEqual(String(out.recipient.memberId), MEMBER_ZHANG, '收件人必须是张三本人')
  assert.strictEqual(out.sentTo, OPENID_ZHANG, '⛔ 必须真的发到张三的微信 OPENID')
  assert.strictEqual(out.sent, true)
})

test('② 教练取消 ⇒ recipient = 会员张三，端到端真的发到张三 OPENID', async () => {
  const out = await runDispatch({ actorRole: 'coach', act: 'cancel' })
  assert.strictEqual(out.event.type, 'coach-booking-cancelled')
  assert.strictEqual(out.recipient.kind, 'member')
  assert.strictEqual(out.sentTo, OPENID_ZHANG)
})

test('③ 教练改期 ⇒ recipient = 会员张三，端到端真的发到张三 OPENID', async () => {
  const out = await runDispatch({ actorRole: 'coach', act: 'reschedule' })
  assert.strictEqual(out.event.type, 'coach-booking-rescheduled')
  assert.strictEqual(out.recipient.kind, 'member')
  assert.strictEqual(out.sentTo, OPENID_ZHANG)
})

// ═══════════════════════════════ A 链：会员动 ⇒ 通知教练（1.3.36 真机 PASS，必须一直绿）
test('④ 会员预约 ⇒ 事件产生，recipient = 教练 A，端到端真的发到教练 OPENID', async () => {
  const out = await runDispatch({ actorRole: 'member', act: 'create' })
  assert.ok(out.event, '必须真的产生一条通知事件')
  assert.strictEqual(out.event.type, 'member-booking-created')
  assert.strictEqual(out.recipient.kind, 'coach', '会员动的事件，收件人必须是教练')
  assert.strictEqual(String(out.recipient.coachId), COACH_A)
  assert.strictEqual(out.sentTo, OPENID_COACH, '⛔ 必须真的发到教练的微信 OPENID')
  assert.strictEqual(out.sent, true)
})

test('⑤ 会员取消 ⇒ recipient = 教练 A，端到端真的发到教练 OPENID', async () => {
  const out = await runDispatch({ actorRole: 'member', act: 'cancel' })
  assert.strictEqual(out.event.type, 'member-booking-cancelled')
  assert.strictEqual(out.recipient.kind, 'coach')
  assert.strictEqual(out.sentTo, OPENID_COACH)
})

test('⑥ 会员改期 ⇒ recipient = 教练 A，端到端真的发到教练 OPENID', async () => {
  const out = await runDispatch({ actorRole: 'member', act: 'reschedule' })
  assert.strictEqual(out.event.type, 'member-booking-rescheduled')
  assert.strictEqual(out.recipient.kind, 'coach')
  assert.strictEqual(out.sentTo, OPENID_COACH)
})

// ═══════════════════════════════ 「谁操作 ⇒ 通知另一方」的硬闸
test('⑦ 六个方向：actor 与 recipient **绝不能是同一个人**（自己动的手不许通知自己）', async () => {
  const roles = [
    { actorRole: 'coach', acts: ['create', 'cancel', 'reschedule'] },
    { actorRole: 'member', acts: ['create', 'cancel', 'reschedule'] }
  ]
  for (const group of roles) {
    for (const act of group.acts) {
      const out = await runDispatch({ actorRole: group.actorRole, act })
      assert.ok(out.event, `${group.actorRole}/${act} 必须产生事件`)
      assert.notStrictEqual(out.actor.kind, out.recipient.kind, `⛔ ${group.actorRole} 动 ${act} 时 actor 与 recipient 同角色（自己通知自己）`)
      assert.notStrictEqual(out.sentTo, group.actorRole === 'coach' ? OPENID_COACH : OPENID_ZHANG,
        `⛔ ${group.actorRole} 动 ${act} 竟然发给了自己`)
    }
  }
})

test('⑧ 两个方向用的是**同一个模板**（course-status）⇒ 会员点一次授权两个方向都覆盖', async () => {
  const toMember = await runDispatch({ actorRole: 'coach', act: 'create' })
  const toCoach = await runDispatch({ actorRole: 'member', act: 'create' })
  assert.ok(toMember.templateId && toCoach.templateId, '两条都必须真的走到发送')
  assert.strictEqual(toMember.templateId, toCoach.templateId,
    '⛔ 两个方向用了不同模板 ⇒ 会员授权一次只能覆盖一个方向（额度碎片化）')
})

// ═══════════════════════════════ 真机数据形状下的稳健性
test('⑨ 旧认领表为空 + 派生索引缺失 ⇒ 教练→会员仍必须发出去（不依赖旧 claim/archive）', async () => {
  const out = await runDispatch({ actorRole: 'coach', act: 'create', options: { noAccounts: true, missing: [CLAIMS] } })
  assert.strictEqual(String(out.recipient && out.recipient.memberId), MEMBER_ZHANG)
  assert.strictEqual(out.sentTo, OPENID_ZHANG, '⛔ 只靠会员主资料也必须能定位到 OPENID')
})

test('⑩ B 教练（张三登记在 A 名下）给张三排课 ⇒ 同样必须通知到张三本人', async () => {
  const out = await runDispatch({ actorRole: 'coach', act: 'create', options: { ownerCoachId: 'coach-b-teaching' } })
  assert.strictEqual(String(out.recipient && out.recipient.memberId), MEMBER_ZHANG, '第二级退路：不限教练再找一次')
  assert.strictEqual(out.sentTo, OPENID_ZHANG)
})

test('⑪ 教练改期一节"会员自己约的课"：booking 上**已经**带着会员身份 ⇒ 不用查表也必须通知到张三', async () => {
  // ⭐ 真机形状：张三先自己约了一节，A 教练后来改期它 ⇒ 这条预约上本来就有 `createdByMemberId`。
  //   ⇒ 这正是用户说的「不要再猜会员是谁，用业务上下文已经确定的身份」。
  //   ⛔ 所以这里故意把会员主资料清空：仍然必须通知到张三。
  const out = await runDispatch({ actorRole: 'coach', act: 'reschedule', options: { noMembers: true, bookingCreatedByMember: true } })
  assert.ok(out.event, '必须产生一条通知事件')
  assert.strictEqual(String(out.recipient.memberId), MEMBER_ZHANG, '必须直接用 booking 上带的会员身份')
  assert.strictEqual(out.sentTo, OPENID_ZHANG, '⛔ 业务已确定的身份还去查表 ⇒ 就是"猜"，会被脏数据带偏')
})

test('⑫ 真的没有任何会员身份 ⇒ 不产生事件，**且必须留痕**（⛔ 不许静默）', async () => {
  const out = await runDispatch({ actorRole: 'coach', act: 'create', options: { noMembers: true, noAccounts: true } })
  assert.strictEqual(out.event, null, '没有可通知对象时一个事件都不许落')
  assert.ok(out.unresolved.length >= 1, '⛔ 认不出收件人必须留一条带原因的痕')
  assert.strictEqual(out.unresolved[0].code, 'MEMBER_BINDING_NOT_FOUND')
})

// ═══════════════════════════════ 静态锚：两个入口都必须走同一个分发器
test('⑬ 教练侧（handlers）与会员侧（memberBooking）**都**必须调同一个分发器，只传 actorRole', () => {
  const handlers = fs.readFileSync(HANDLERS, 'utf8')
  const memberBooking = fs.readFileSync(MEMBER_BOOKING, 'utf8')
  assert.ok(/notifyBooking\.notifyBookingChange/.test(handlers), '⛔ 教练侧入口绕开了统一分发器')
  assert.ok(/notifyBooking\.notifyBookingChange/.test(memberBooking), '⛔ 会员侧入口绕开了统一分发器')
  assert.ok(/actorRole:\s*notifyBooking\.ACTOR_COACH/.test(handlers), '教练侧必须声明 actorRole=coach')
  assert.ok(/actorRole:\s*notifyBooking\.ACTOR_MEMBER/.test(memberBooking), '会员侧必须声明 actorRole=member')
  // ⛔ 更硬的一条：分发器里**不许**再出现两套"分别按角色实现"的分支写事件
  const dispatcher = fs.readFileSync(NOTIFY_BOOKING, 'utf8')
  const recordCalls = dispatcher.match(/scope\.record\(/g) || []
  assert.strictEqual(recordCalls.length, 1, `⛔ 分发器里出现了 ${recordCalls.length} 处登记事件 ⇒ 又在往两套路径漂移`)
})

test('⑭ 分发器认不出人时**不许**写出一条没有收件人的事件（宁可不发，绝不错发）', () => {
  const dispatcher = fs.readFileSync(NOTIFY_BOOKING, 'utf8')
  assert.ok(/if\s*\(!resolved\.memberId\)/.test(dispatcher), '认不出会员必须走"不产生事件"的分支')
  assert.ok(/noteUnresolved/.test(dispatcher), '认不出会员必须留痕（⛔ 静默 return null 是 1.3.37 定位不住的元凶）')
})

;(async () => {
  let failed = 0
  for (const item of cases) {
    try {
      await item.fn()
      console.log(`  ✅ ${item.name}`)
    } catch (error) {
      failed += 1
      console.error(`  ⛔ ${item.name}\n     ${String(error && error.message || error)}`)
    }
  }
  console.log(`\n§194 预约通知统一分发器端到端专项：${cases.length - failed}/${cases.length} 通过`)
  if (failed) process.exit(1)
  process.exit(0)
})().catch(error => { console.error('FATAL ' + error.stack); process.exit(1) })
