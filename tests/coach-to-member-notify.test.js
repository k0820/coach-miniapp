// ─────────────────────────────────────────────────────────────────────────────
// §193 · **双向通知 recipient**（收件人）定位永久专项（2026-10-07 · 1.3.37）
//
// 🔴 为什么要有这一份（真机 1.3.36 的事实）：
//   同一套通知代码，两个方向的实测结果**不一样**：
//     A 链（已真机 PASS）：会员主动预约 / 取消 ⇒ **教练**收到微信订阅消息 ✅
//     B 链（真机 FAIL）  ：教练主动排课         ⇒ **会员**收不到任何通知 ❌
//   ⇒ 不是"微信没配好"，是两条链**在一个点上分叉**：
//       A 链的收件人是教练 ⇒ 直接读 `coaches.openId`，一路畅通；
//       B 链的收件人是会员 ⇒ 必须先由 `notify.memberIdOfStudent()` 把「学员 ⇒ 会员」翻译出来，
//                            而它**只认旧认领表** `member_sandbox_student_claims`。
//   会员身份迁移到新会员目录（`member_sandbox_members`）之后，认领表那一行可能压根不存在
//   ⇒ `handlers.recordBookingChange` 拿到空 memberId ⇒ **直接 return null**
//   ⇒ 事件连生成都不会生成 ⇒ 微信和站内消息双双落空（连"该通知谁"的事实都没记下来）。
//
// ⛔ 本专项模拟**当前真机的新会员绑定数据形状**（member-directory.bindMember 写出来的那几行），
//    并且**故意把旧认领表留空 / 让集合不存在**，要求 B 链**仍然必须**解析到张三的真实 OPENID。
//    ⛔ 同时保护已经真机通过的 A 链一条都不许退。
//
// ⛔ 判据不是"字符串存在"：全部跑**真云函数**（notify / subscribe-delivery / notify-adapter），
//    只替换数据库与 `subscribeMessage.send` 运输层。
// ⛔ 配套反证：`tests/_coach-to-member-notify-mutate.js`（内存覆盖层，禁止写盘改源码）。
// ─────────────────────────────────────────────────────────────────────────────
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const SANDBOX = path.join(ROOT, 'cloudfunctions', 'coachBusinessSandboxCommand')
const NOTIFY = path.join(SANDBOX, 'notify.js')
const ADAPTER = path.join(SANDBOX, 'notify-adapter.js')
const DELIVERY = path.join(SANDBOX, 'subscribe-delivery.js')
const HANDLERS = path.join(SANDBOX, 'handlers.js')
// ⭐⭐ 2026-10-07（1.3.38）：预约变动的**统一通知分发器**（两个方向共用同一套）。
const NOTIFY_BOOKING = path.join(SANDBOX, 'notify-booking.js')

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')

// 📌 真机数据形状：会员微信 OPENID ⇒ memberId 的既有公式（`member-directory.memberIdForOpenId`）。
const OPENID_ZHANG = 'o-member-zhang-sandbox'
const OPENID_COACH = 'o-coach-a-sandbox'
const MEMBER_ZHANG = sha(`member:${OPENID_ZHANG}`).slice(0, 32)
const COACH_A = 'coach-a-owner'
const DATASET_A = 'dataset-a-owner'
const STUDENT_ZHANG = 'student-zhang-real'

const MEMBERS = 'member_sandbox_members'
const ACCOUNTS = 'member_sandbox_accounts'
const CLAIMS = 'member_sandbox_student_claims'
const EVENTS = 'member_sandbox_notification_events'

// ───────────────── 内存假 CloudBase（where/get/doc/set/createCollection）─────────────────
function makeDb(stores, missing = []) {
  const read = name => {
    if (missing.indexOf(name) >= 0) {
      throw Object.assign(new Error(`-502005 Db or Table not exist: ${name}`), { errCode: -502005 })
    }
    return stores[name] || []
  }
  return {
    async createCollection() { throw new Error('already exists') },
    collection(name) {
      return {
        where(query) {
          const flt = () => read(name).filter(row => Object.keys(query || {}).every(k => row[k] === query[k]))
          return {
            limit(count) { return { get: async () => ({ data: flt().slice(0, count || 100) }) } },
            get: async () => ({ data: flt() })
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

// 📦 「教练已创建张三 + 张三微信已绑定」之后，云端**应当**存在的数据形状。
//    ⛔ 认领表 `member_sandbox_student_claims` **故意留空**：新会员不靠它存活。
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
    [CLAIMS]: opts.legacyClaims === true ? [{
      _id: 'claim-of-zhang', claimId: 'claim-of-zhang', memberId: MEMBER_ZHANG,
      coachId: COACH_A, studentId: STUDENT_ZHANG, status: 'verified'
    }] : [],
    [EVENTS]: [],
    coaches: [{ _id: COACH_A, openId: OPENID_COACH, displayName: 'A教练' }]
  }
}

// 📮 投递结果的**记录器**：验证"微信真的发给谁"。
function makeRecorder(fail) {
  const calls = []
  const send = fail
    ? async () => { throw Object.assign(new Error('subscribeMessage.send:fail refuse'), { errCode: 43101 }) }
    : async payload => { calls.push(payload) }
  return { calls, send }
}

const cleanForTest = name => {
  delete require.cache[require.resolve(NOTIFY)]
  delete require.cache[require.resolve(ADAPTER)]
  delete require.cache[require.resolve(DELIVERY)]
  delete require.cache[require.resolve(path.join(SANDBOX, 'notify-templates.js'))]
  delete require.cache[require.resolve(path.join(SANDBOX, 'authorization.js'))]
  delete require.cache[require.resolve(NOTIFY_BOOKING)]
  return name
}

// ⭐⭐ 2026-10-07（1.3.38）：真正的方向判定与收件人解析**已经搬到统一分发器** `notify-booking.js`。
//    `handlers.recordBookingChange` 现在只是一层薄封装（把 `actorRole=coach` 传进去）。
//    ⇒ 测试跟到新的真相源：**require 磁盘上那个真模块**来跑（不是手抄副本）。
//    ⛔ 判别力不降反升：分发器里任何一步被改坏（`tests/_coach-to-member-notify-mutate.js`
//       用内存覆盖层逐条改回去），下面每一段都会立刻变红。
function dispatcherOf() {
  return require(NOTIFY_BOOKING)
}

// 🎯 跑一条完整的 B 链：教练排课 ⇒ 事件入队 ⇒ 落库 ⇒ 投递，返回收件人与投递结果。
async function runCoachCreateStores(options = {}) {
  cleanForTest()
  const notify = require(NOTIFY)
  const { createNotifyDelivery } = require(ADAPTER)
  const deliveryModule = require(DELIVERY)
  const notifyBooking = dispatcherOf()

  const stores = baseStores(options)
  const missing = options.missing || []
  const db = makeDb(stores, missing)
  // ⭐ `ownerCoachId` = **这一笔业务发生在哪一本账上**。B 教练给张三排课时它是 B，
  //    而会员主资料行里的 ownerCoachId 仍然是创建张三的那位 A ⇒ 必须靠**第二级退路**命中。
  const actingCoachId = String(options.ownerCoachId || COACH_A)
  const scope = notify.scope(db, 'sandbox', actingCoachId, DATASET_A)

  // ⭐ 走的就是 `handlers.createBooking` 尾那一步（**统一分发器**的真模块，一个字都没复制）。
  await notifyBooking.notifyBookingChange(
    { notify: scope, requestId: 'req-coach-create-1', now: Date.now() },
    {
      actorRole: notifyBooking.ACTOR_COACH,
      act: notifyBooking.ACTS.CREATE,
      booking: { id: 'bk-1', date: '2026-10-12', hour: 15, minute: 0, status: 'booked', studentId: STUDENT_ZHANG },
      business: { ownerCoachId: actingCoachId, datasetId: DATASET_A },
      requestId: 'req-coach-create-1', now: Date.now()
    }
  )
  const events = scope.events()
  // ⛔ recipient 的 kind / memberId **只能从真事件里读** ⇒ 谁把收件人写成教练自己，这里立刻变成空。
  const first = events[0] || null
  const memberId = first && first.recipient && first.recipient.kind === 'member' ? String(first.recipient.memberId || '') : ''
  if (!first) {
    // ⛔ 恰恰是"一条事件都没产生"的时候，台账才是唯一证据 ⇒ 早退也必须把它带出去。
    const un = typeof scope.unresolved === 'function' ? scope.unresolved() : []
    return { memberId: '', queued: 0, sentTo: '', result: null, stores, unresolved: un }
  }
  await scope.flush(db)

  const { send, calls } = makeRecorder(options.sendFails === true)
  const adapterObj = createNotifyDelivery({
    cloud: null, db, environment: 'sandbox', enabled: true,
    accountsCollection: ACCOUNTS, membersCollection: MEMBERS
  })
  const outcome = await deliveryModule.deliverEvents({
    db, environment: 'sandbox', events, send, openIdFor: adapterObj.openIdFor, now: Date.now()
  })
  // ⭐ `unresolved`：认不出收件人时的台账（1.3.38 新增）。⛔ 以前这里是**零信息**的静默 return null。
  const unresolved = typeof scope.unresolved === 'function' ? scope.unresolved() : []
  return { memberId, queued: events.length, sentTo: calls.length ? String(calls[0].touser) : '', result: outcome.results[0], stores, unresolved }
}

// 🎯 跑一条完整的 A 链（保护用）：会员预约 ⇒ recipient = 教练。
async function runMemberCreateNotify() {
  cleanForTest()
  const notify = require(NOTIFY)
  const { createNotifyDelivery } = require(ADAPTER)
  const deliveryModule = require(DELIVERY)

  const stores = baseStores()
  const db = makeDb(stores)
  const scope = notify.scope(db, 'sandbox', COACH_A, DATASET_A)
  await scope.record({
    type: notify.EVENT_TYPES.MEMBER_CREATED,
    actor: { kind: 'member', memberId: MEMBER_ZHANG },
    recipient: { kind: 'coach', coachId: COACH_A },
    booking: { id: 'bk-2', date: '2026-10-12', hour: 15, minute: 0, status: 'booked', studentId: STUDENT_ZHANG },
    requestId: 'req-member-create-1', now: Date.now()
  })
  const events = scope.events()
  await scope.flush(db)
  const { send, calls } = makeRecorder(false)
  const adapterObj = createNotifyDelivery({ cloud: null, db, environment: 'sandbox', enabled: true, accountsCollection: ACCOUNTS, membersCollection: MEMBERS })
  const outcome = await deliveryModule.deliverEvents({ db, environment: 'sandbox', events, send, openIdFor: adapterObj.openIdFor, now: Date.now() })
  return { sentTo: calls.length ? String(calls[0].touser) : '', result: outcome.results[0], recipient: events[0].recipient }
}

const cases = []
const test = (name, fn) => cases.push({ name, fn })

// ─────────────────────────────── B 链：教练 ⇒ 会员（本轮要修的）
test('① 教练排课 ⇒ recipient 必须解析成张三本人（**认领表为空**也不受影响）', async () => {
  const out = await runCoachCreateStores()
  assert.strictEqual(out.memberId, MEMBER_ZHANG, '认领表为空时也必须从会员主资料找到张三')
  assert.strictEqual(out.queued, 1, '必须真的生成一条通知事件')
})

test('② 张三的 OPENID 必须定位到她自己的微信（端到端真的发到这个人）', async () => {
  const out = await runCoachCreateStores()
  assert.strictEqual(out.sentTo, OPENID_ZHANG, '收件人必须是张三真实 OPENID')
  assert.strictEqual(out.result && out.result.sent, true, '事件必须真的投递成功')
})

test('③ 认领集合在云端完全不存在（-502005）时也不能断链', async () => {
  const out = await runCoachCreateStores({ missing: [CLAIMS] })
  assert.strictEqual(out.memberId, MEMBER_ZHANG)
  assert.strictEqual(out.sentTo, OPENID_ZHANG)
})

test('④ 会员主资料集合缺失 ⇒ 必须回落到旧认领表（老会员一个都不许丢）', async () => {
  const out = await runCoachCreateStores({ missing: [MEMBERS], legacyClaims: true })
  assert.strictEqual(out.memberId, MEMBER_ZHANG, '回落旧认领表要能认出老会员')
  assert.strictEqual(out.sentTo, OPENID_ZHANG)
})

test('⑤ 派生账号索引缺失 ⇒ 靠会员主资料也找得到 OPENID', async () => {
  const out = await runCoachCreateStores({ noAccounts: true })
  assert.strictEqual(out.sentTo, OPENID_ZHANG, 'accounts 没有也必须能从主资料拿到 OPENID')
})

test('⑥ 主资料没有 OPENID（脏数据）⇒ 回落到 accounts', async () => {
  const out = await runCoachCreateStores({ membersOpenId: null })
  assert.strictEqual(out.sentTo, OPENID_ZHANG, '主资料缺 openId 时要继续走下一条退路')
})

test('⑦ members 与 accounts 都拿不到 OPENID ⇒ 如实报「找不到收件人」，⛔ 不许伪装成功', async () => {
  const out = await runCoachCreateStores({ membersOpenId: null, accountsOpenId: null })
  assert.strictEqual(out.sentTo, '', '拿不到 OPENID 时绝不许发出去')
  assert.strictEqual(out.result && out.result.code, 'RECIPIENT_OPENID_MISSING')
  assert.strictEqual(out.result && out.result.sent, false)
})

test('⑧ 真的没有任何会员身份 ⇒ 不产生事件（合理退化，不是"发了但失败"）', async () => {
  const out = await runCoachCreateStores({ noMembers: true, noAccounts: true })
  assert.strictEqual(out.memberId, '', '没有会员身份就找不到 memberId')
  assert.strictEqual(out.queued, 0, '没有可通知对象时一个事件都不许落')
})

test('⑩ 自己动的手不许通知自己（教练排课 ⇒ 收件人不能有教练 OPENID）', async () => {
  const out = await runCoachCreateStores()
  assert.notStrictEqual(out.sentTo, OPENID_COACH, '出现"教练通知教练自己"就是事故')
})

// ─────────────────────────────── A 链：会员 ⇒ 教练（1.3.36 真机已过，必须一直绿）
test('⑨ B 教练（会员主资料登记在 A 名下）给张三排课 ⇒ 同样必须通知到张三', async () => {
  const out = await runCoachCreateStores({ ownerCoachId: 'coach-b-teaching' })
  assert.strictEqual(out.memberId, MEMBER_ZHANG, '第二级退路：不限教练再找一次')
  assert.strictEqual(out.sentTo, OPENID_ZHANG)
})

test('⑪ 会员主动预约 ⇒ recipient = 教练，且真的发到教练 OPENID（保护已真机通过的那条）', async () => {
  const out = await runMemberCreateNotify()
  assert.strictEqual(out.recipient.kind, 'coach')
  assert.strictEqual(out.recipient.coachId, COACH_A)
  assert.strictEqual(out.sentTo, OPENID_COACH)
  assert.strictEqual(out.result && out.result.sent, true)
})

test('⑫ 微信返回 43101（授权用完/拒绝）⇒ 如实留痕，⛔ 不许标 delivered', async () => {
  const out = await runCoachCreateStores({ sendFails: true })
  assert.strictEqual(out.result && out.result.sent, false)
  assert.strictEqual(out.result && out.result.ok, false)
  assert.ok(String(out.result.code).length > 0, '必须留下可查的失败码')
})

// ─────────────────────────────── 静态锚（防止有人又把它改回只认旧表）
test('⑬ 统一收件人解析器必须「booking 上下文 → 三元组 → 逐层回落 → 旧认领」，退路一个都不许少', () => {
  const source = fs.readFileSync(NOTIFY_BOOKING, 'utf8')
  assert.ok(/memberCollectionFor\s*\(\s*environment\s*\)/.test(source), '会员主资料的集合名必须按环境拼装（⛔ 不许写死字面量）')
  assert.ok(/opts\.createdByMemberId/.test(source), '① 业务**已经确定**的会员身份必须优先用（不要再猜）')
  assert.ok(/ownerCoachId,\s*ownerDatasetId:\s*datasetId,\s*studentId/.test(source), '② canonical 落点：绑定那一刻写死的（coach + dataset + student）三元组')
  assert.ok(/ownerCoachId,\s*studentId\s*\}\s*\]/.test(source), '③ datasetId 缺失时的退路')
  assert.ok(/membersCollection,\s*\{\s*studentId\s*\}\s*\]/.test(source), '④ B 教练给张三排课（会员登记在 A 名下）的退路')
  assert.ok(/collectionsFor\s*\(\s*environment\s*\)\.claims/.test(source), '⑤ 旧认领表必须保留为兼容层（⛔ 不删不改）')
})

test('⑭ openIdFor 必须「主资料 → 派生索引」两级退路，且每一级失败都不许终止整个查找', () => {
  const source = fs.readFileSync(ADAPTER, 'utf8')
  assert.ok(/membersCollection/.test(source), '这一份必须知道会员主资料集合')
  assert.ok(/openIdIn\s*\(\s*membersCollection/.test(source), '主资料必须优先')
  assert.ok(/openIdIn\s*\(\s*accountsCollection/.test(source), '派生索引必须作为回落保留')
  assert.ok(/会员身份表读取失败，改用下一张表重试/.test(source), '单表故障必须能被兜住并继续')
})

test('⑮ 统一分发器认不出会员 ⇒ 不产生事件 **且必须留痕**（⛔ 静默 return null 正是 1.3.37 定位不住的原因）', async () => {
  const out = await runCoachCreateStores({ noMembers: true, noAccounts: true })
  assert.strictEqual(out.queued, 0, '没有可通知对象时一个事件都不许落')
  assert.ok(Array.isArray(out.unresolved) && out.unresolved.length >= 1, '⛔ 认不出收件人必须留下一条带原因的痕，绝不许静默')
  const first = out.unresolved[0]
  assert.strictEqual(first.code, 'MEMBER_BINDING_NOT_FOUND', '痕迹里必须写明"为什么找不到"')
  assert.ok(Array.isArray(first.tried) && first.tried.length >= 4, '必须记下"试过哪几步"，真机才能一眼定位')
  assert.strictEqual(String(first.studentId), STUDENT_ZHANG, '痕迹里必须带上学员标识，否则无从查起')
})

// ─────────────────────────────── 跑
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
  console.log(`\n§193 双向通知 recipient 专项：${cases.length - failed}/${cases.length} 通过`)
  if (failed) process.exit(1)
  process.exit(0)
})().catch(error => { console.error('FATAL ' + error.stack); process.exit(1) })
