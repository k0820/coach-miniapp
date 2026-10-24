// ═══════════════════════════════════════════════════════════════════════════
// 📥 §174 · 站内消息中心 + 通知内容改造 + 业务按钮顺手申请额度（2026-10-06）
//
// ⭐⭐ 起因（真机证据，不是猜的）：
//   ① 教练只收到过**一条**「预约已取消」，第二次预约 / 取消之后再也没收到 ——
//      微信「一次性订阅」**一条授权只够一条提醒**；用户已亲自在微信公众平台核对：
//      长期订阅页面显示「暂时没有可选用的模板」⇒ 3 个模板**全部是一次性订阅**。
//      ⇒ 光靠微信**不可能**保证双方每次都收到 ⇒ 必须有**站内消息中心**兜底。
//   ② 真机收到的通知写着「预约方：会员 / 预约地点：详见课表」—— 对教练**毫无信息量**。
//
// ⛔ 全文件只用**内存假 db** 与**内存漂移**（`Module._compile` + `require.cache`），
//    磁盘一个字节都不改，也**不连真实云端**（⛔ 部署与真机验收另有一份清单）。
// ═══════════════════════════════════════════════════════════════════════════
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
const P = rel => path.join(ROOT, rel)
const read = rel => fs.readFileSync(P(rel), 'utf8')

const INBOX = 'cloudfunctions/coachBusinessSandboxCommand/notification-inbox'
const EVENT = {
  eventId: 'evt-1',
  type: 'member-booking-cancelled',
  environment: 'sandbox',
  actor: { kind: 'member', memberId: 'member-1' },
  recipient: { kind: 'coach', coachId: 'coach-1' },
  occurredAt: 1780000000000,
  booking: {
    bookingId: 'bk-1', date: '2026-10-06', hour: 16, minute: 0, status: 'cancelled',
    studentId: 'stu-1', packageId: 'pkg-1', ownerCoachId: 'coach-1', datasetId: 'ds-1',
    studentName: '张三', coachName: '王教练', courseTypeName: '拉伸课', sessions: 1
  },
  delivered: false,
  delivery: { channel: null, sentAt: null, attempts: 0 }
}
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))

// ───────────────────────────────────────────────────────── 内存假 CloudBase db
function fakeDb(seed = {}) {
  const stores = {}
  Object.keys(seed || {}).forEach(name => { stores[name] = (seed[name] || []).map(clone) })
  const touched = []
  const rows = name => (stores[name] = stores[name] || [])
  const collection = name => ({
    doc(id) {
      return {
        async get() { const row = rows(name).find(item => item._id === id); return { data: row ? clone(row) : null } },
        async set({ data }) {
          const list = rows(name), at = list.findIndex(item => item._id === id)
          const row = { ...clone(data), _id: id }
          if (at >= 0) list[at] = row; else list.push(row)
          return {}
        }
      }
    },
    where(query) {
      let list = rows(name).filter(row => Object.keys(query || {}).every(key => String(row[key]) === String(query[key])))
      const api = {
        limit(count) { list = list.slice(0, Number(count) || list.length); return api },
        async get() { touched.push(name); return { data: list.map(clone) } }
      }
      return api
    }
  })
  return { db: { collection }, stores, touched }
}

// ⭐ 在**内存**里编译一份漂移后的源码（磁盘零改动）
function compile(relPath, source) {
  const resolved = require.resolve(P(relPath))
  const mod = new Module(resolved, null)
  mod.filename = resolved
  mod.paths = Module._nodeModulePaths(path.dirname(resolved))
  mod._compile(source, resolved)
  return mod.exports
}
function withDrift(relPath, mutate, fn) {
  const source = read(relPath.endsWith('.js') ? relPath : `${relPath}.js`)
  const drifted = mutate(source)
  assert.notStrictEqual(drifted, source, `⛔ 漂移脚本自身失效：${relPath} 的锚点没命中`)
  return fn(compile(relPath, drifted))
}
// ⭐ 客户端模块要一个假的 `utils/data-runtime`（它不需要真的读本机环境）
function withClientModule(environment, fn) {
  const runtimePath = require.resolve(P('utils/data-runtime'))
  const savedRuntime = require.cache[runtimePath]
  const stub = new Module(runtimePath, null)
  stub.filename = runtimePath
  stub.paths = Module._nodeModulePaths(path.dirname(runtimePath))
  stub._compile(`module.exports = { environment: () => ${JSON.stringify(environment)}, ENVIRONMENTS: { PRODUCTION: 'production' } }`, runtimePath)
  stub.loaded = true
  require.cache[runtimePath] = stub
  const clientPath = require.resolve(P('utils/notification-inbox'))
  const savedClient = require.cache[clientPath]
  delete require.cache[clientPath]
  try {
    return fn(require(clientPath))
  } finally {
    delete require.cache[clientPath]
    if (savedRuntime) require.cache[runtimePath] = savedRuntime; else delete require.cache[runtimePath]
    if (savedClient) require.cache[clientPath] = savedClient
  }
}

const results = []
async function check(name, fn) {
  try { await fn(); results.push(`✅ ${name}`) }
  catch (error) {
    results.push(`❌ ${name}\n    ${String(error && error.stack || error).split('\n').slice(0, 5).join('\n    ')}`)
    process.exitCode = 1
  }
}

async function main() {
  const inboxModule = require(P(INBOX))
  const templates = require(P('cloudfunctions/coachBusinessSandboxCommand/notify-templates'))

  console.log('\n【① 只写 Sandbox 集合 · 正式区一次都写不了】')

  await check('集合名就是那两个 Sandbox 表，且**没有**任何正式区集合名字面量', () => {
    assert.strictEqual(inboxModule.COLLECTIONS.member, 'member_sandbox_notification_inbox')
    assert.strictEqual(inboxModule.COLLECTIONS.coach, 'coach_sandbox_notification_inbox')
    const source = read(`${INBOX}.js`)
    const PRODUCTION = ['member_accounts', 'member_student_claims', 'member_notification_events', 'coach_data_heads', 'member_coach_profiles']
    PRODUCTION.forEach(name => assert.ok(source.indexOf(name) < 0, `⛔ 站内消息模块里出现了正式区集合名 ${name}`))
  })

  await check('⛔ 环境不是 sandbox ⇒ `createInbox` 返回 null ⇒ 一个字都写不出去', () => {
    const { db } = fakeDb()
    assert.strictEqual(inboxModule.createInbox({ db, environment: 'production' }), null)
    assert.strictEqual(inboxModule.createInbox({ db, environment: '' }), null)
    assert.strictEqual(inboxModule.createInbox({ db, environment: undefined }), null)
    assert.ok(inboxModule.createInbox({ db, environment: 'sandbox' }), '⛔ sandbox 竟然造不出收件箱')
  })

  await check('正式区云函数目录里**没有**这套集合与模块（⛔ 只创建和部署 Sandbox）', () => {
    assert.ok(!fs.existsSync(P('cloudfunctions/coachBusinessCommand/notification-inbox.js')),
      '⛔ 站内消息模块出现在正式区函数目录里')
    const production = read('cloudfunctions/coachBusinessCommand/core.js')
    assert.ok(production.indexOf('notification-inbox') < 0, '⛔ 正式区 core 接了站内消息')
    assert.ok(production.indexOf('delivery.inbox') < 0, '⛔ 正式区 core 写了站内消息分支')
  })

  console.log('\n【② 一个事件 = 两条独立消息（操作者 + 另一方）】')

  await check('会员取消 ⇒ 教练一条（另一方）+ 会员一条（操作确认），各在**自己的**集合', async () => {
    const { db, stores } = fakeDb()
    const box = inboxModule.createInbox({ db, environment: 'sandbox' })
    const out = await box.note(EVENT, { sent: false, code: 'SUBSCRIBE_NOT_AUTHORIZED' })
    assert.strictEqual(out.written, 2, `⛔ 一个事件必须写两条，实测 ${out.written}`)
    assert.strictEqual((stores['coach_sandbox_notification_inbox'] || []).length, 1)
    assert.strictEqual((stores['member_sandbox_notification_inbox'] || []).length, 1)
    const coachRow = stores['coach_sandbox_notification_inbox'][0]
    const memberRow = stores['member_sandbox_notification_inbox'][0]
    assert.strictEqual(coachRow.audience, 'counterpart')
    assert.strictEqual(memberRow.audience, 'actor')
    assert.strictEqual(coachRow.ownerId, 'coach-1')
    assert.strictEqual(memberRow.ownerId, 'member-1')
  })

  await check('⛔ 两条**互不冒充**：另一方的那条说"张三…"，操作者那条说"你…"', () => {
    const rows = inboxModule.rowsOf(EVENT, { sent: false, code: 'X' })
    const counterpart = rows.find(row => row.audience === 'counterpart')
    const actor = rows.find(row => row.audience === 'actor')
    assert.ok(counterpart.body.startsWith('张三'), `⛔ 另一方那条没写学员真名：${counterpart.body}`)
    assert.ok(actor.body.startsWith('你'), `⛔ 操作者那条不是"你…"：${actor.body}`)
  })

  await check('六种业务事件**每一种**都是两条（预约/取消/改期 · 会员与教练各三）', () => {
    const KINDS = [
      'member-booking-created', 'member-booking-cancelled', 'member-booking-rescheduled',
      'coach-booking-created', 'coach-booking-cancelled', 'coach-booking-rescheduled'
    ]
    KINDS.forEach(type => {
      const rows = inboxModule.rowsOf({ ...EVENT, type, actor: { kind: type.indexOf('coach-') === 0 ? 'coach' : 'member', memberId: 'member-1', coachId: 'coach-1' }, recipient: { kind: type.indexOf('coach-') === 0 ? 'member' : 'coach', memberId: 'member-1', coachId: 'coach-1' } }, null)
      assert.strictEqual(rows.length, 2, `⛔ ${type} 写了 ${rows.length} 条（必须是 2 条）`)
    })
  })

  await check('幂等：同一事件重复登记 ⇒ **只覆盖同一行**，不会变成 4 条', async () => {
    const { db, stores } = fakeDb()
    const box = inboxModule.createInbox({ db, environment: 'sandbox' })
    await box.note(EVENT, null)
    await box.note(EVENT, null)
    assert.strictEqual((stores['coach_sandbox_notification_inbox'] || []).length, 1)
    assert.strictEqual((stores['member_sandbox_notification_inbox'] || []).length, 1)
  })

  console.log('\n【③ 微信发不出去 ⇒ 站内消息照旧存在 · 两个人各记各的结果】')

  await check('微信**没额度**（sent=false）⇒ 两条站内消息**照样写进去**', async () => {
    const { db, stores } = fakeDb()
    const box = inboxModule.createInbox({ db, environment: 'sandbox' })
    await box.note(EVENT, { sent: false, code: 'SUBSCRIBE_NOT_AUTHORIZED', message: '提醒次数用完了' })
    assert.strictEqual(((stores['coach_sandbox_notification_inbox'] || [])[0] || {}).wechat.sent, false)
    assert.strictEqual(((stores['coach_sandbox_notification_inbox'] || [])[0] || {}).wechat.code, 'SUBSCRIBE_NOT_AUTHORIZED')
    assert.ok((stores['member_sandbox_notification_inbox'] || []).length === 1, '⛔ 微信失败就把站内消息也吞了')
  })

  await check('⛔⛔ 一方微信成功**绝不**把另一方也标成成功（两条各带各的 wechat 结果）', async () => {
    const { db, stores } = fakeDb()
    const box = inboxModule.createInbox({ db, environment: 'sandbox' })
    // 微信本来**只通知另一方** ⇒ 操作者那条应当记成"自己操作，不需要推送"。
    await box.note(EVENT, { sent: true, code: 'SENT' })
    const coachRow = (stores['coach_sandbox_notification_inbox'] || [])[0]
    const memberRow = (stores['member_sandbox_notification_inbox'] || [])[0]
    assert.strictEqual(coachRow.wechat.sent, true, '⛔ 另一方那条没记成功')
    assert.strictEqual(memberRow.wechat.sent, false, '🚨 操作者那条被标成了"微信已发送"（一方成功 ⇒ 另一方也成功 = 假象）')
    assert.strictEqual(memberRow.wechat.code, 'SELF_ACTION_NO_PUSH')
  })

  await check('会员在消息中心能看见这一条微信到底有没有发出去', () => {
    const clientInbox = require(P('utils/notification-inbox'))
    const failed = clientInbox.rowsView([{ id: 'n1', audience: 'counterpart', wechat: { sent: false, code: 'SUBSCRIBE_NOT_AUTHORIZED' } }])[0]
    const sent = clientInbox.rowsView([{ id: 'n2', audience: 'counterpart', wechat: { sent: true, code: 'SENT' } }])[0]
    const own = clientInbox.rowsView([{ id: 'n3', audience: 'actor', wechat: { sent: false, code: 'SELF_ACTION_NO_PUSH' } }])[0]
    assert.ok(/重新允许/.test(failed.wechatText), `⛔ 没把没有提醒次数说清楚：${failed.wechatText}`)
    assert.strictEqual(sent.wechatText, '微信提醒已发送')
    assert.strictEqual(own.wechatText, '', '⛔ 自己的操作不应误报成微信发送失败')
    assert.ok(/wechat:\s*\{/.test(read('cloudfunctions/coachBusinessSandboxCommand/notification-inbox.js')), '⛔ 服务端没有把真实微信结果返回给消息中心')
  })

  await check('投递层 `writeInbox`：微信**没尝试过**（通道未开）⇒ 站内消息**仍然写**', async () => {
    const { db, stores } = fakeDb()
    const box = inboxModule.createInbox({ db, environment: 'sandbox' })
    const delivery = require(P('cloudfunctions/coachBusinessSandboxCommand/subscribe-delivery'))
    const out = await delivery.writeInbox({ db, environment: 'sandbox', events: [EVENT], inbox: box, delivery: null })
    assert.strictEqual(out.written, 2, '⛔ 通道没开 ⇒ 站内消息也必须写两条')
    assert.strictEqual(((stores['coach_sandbox_notification_inbox'] || [])[0] || {}).wechat.code, 'WECHAT_CHANNEL_DISABLED')
  })

  await check('投递层 `writeInbox`：`inbox` 为 null（正式区）⇒ 一次写都没有', async () => {
    const { db, stores } = fakeDb()
    const delivery = require(P('cloudfunctions/coachBusinessSandboxCommand/subscribe-delivery'))
    const out = await delivery.writeInbox({ db, environment: 'production', events: [EVENT], inbox: null, delivery: null })
    assert.strictEqual(out.written, 0)
    assert.strictEqual(Object.keys(stores).length, 0, '⛔ 正式区竟然写了站内消息')
  })

  console.log('\n【④ 消息内容：真名 + 时间 + 课程类型 + 课时变化】')

  await check('取消：「张三取消了10月6日16:00的拉伸课，已释放1节课时，该时间可以重新预约。」', () => {
    const rows = inboxModule.rowsOf(EVENT, null)
    const counterpart = rows.find(row => row.audience === 'counterpart')
    assert.strictEqual(counterpart.body, '张三取消了10月6日16:00的拉伸课，已释放1节课时，该时间可以重新预约',
      `⛔ 取消的站内文案不对：${counterpart.body}`)
    assert.ok(counterpart.body.includes('已释放1节课时'), '⛔ 没写清楚释放了几节')
    assert.ok(counterpart.body.includes('可以重新预约'), '⛔ 没告诉教练原时间可以重新约')
  })

  await check('预约 ⇒「已占用1节课时」；改期 ⇒「新时间已占用，原时间已释放」', () => {
    const created = inboxModule.rowsOf({ ...EVENT, type: 'member-booking-created' }, null).find(r => r.audience === 'counterpart')
    assert.ok(created.body.includes('已占用1节课时'), created.body)
    const moved = inboxModule.rowsOf({ ...EVENT, type: 'member-booking-rescheduled' }, null).find(r => r.audience === 'counterpart')
    assert.ok(moved.body.includes('新时间已占用') && moved.body.includes('原时间已释放'), moved.body)
  })

  await check('⛔ 微信模板里**不再**出现笼统的"会员"：换成真实学员名 / 课程类型', () => {
    const message = templates.messageOf({ type: 'member-booking-cancelled', booking: EVENT.booking, recipient: { kind: 'coach' } })
    assert.strictEqual(message.data.thing2.value, '张三', `⛔ 预约方还是写了"会员/学员"：${message.data.thing2.value}`)
    assert.strictEqual(message.data.thing4.value, '拉伸课', `⛔ 预约地点没换成课程类型：${message.data.thing4.value}`)
    assert.strictEqual(message.data.phrase1.value, '已取消')
    assert.strictEqual(message.data.time3.value, '2026-10-06 16:00')
    assert.strictEqual(message.data.thing5.value, '已释放1节课时，该时间可以重新预约')
    // ⛔ 发给会员时"预约方"是**教练真名**，不是"教练"两个字占位。
    const toMember = templates.messageOf({ type: 'coach-booking-cancelled', booking: EVENT.booking, recipient: { kind: 'member' } })
    assert.strictEqual(toMember.data.thing2.value, '王教练', toMember.data.thing2.value)
  })

  await check('改期的状态词是「已改期」（用户指定口径，⛔ 不再是"时间变更"）', () => {
    assert.strictEqual(templates.STATUS_OF['member-booking-rescheduled'], '已改期')
    assert.strictEqual(templates.STATUS_OF['coach-booking-rescheduled'], '已改期')
  })

  await check('⛔ 姓名拿不到时退到「学员」，⛔ 绝不通篇写"会员"', () => {
    const message = templates.messageOf({ type: 'member-booking-created', booking: { date: '2026-10-06', hour: 9, minute: 0 }, recipient: { kind: 'coach' } })
    assert.notStrictEqual(message.data.thing2.value, '会员')
    assert.strictEqual(message.data.thing2.value, '学员')
  })

  console.log('\n【⑤ 服务端富化真实姓名 / 课程类型（⛔ 客户端提交不了）】')

  await check('`notify.js` 的 `enrichFacts` 从**学员档案与课时包**里读出真名与课程类型', async () => {
    const notify = require(P('cloudfunctions/coachBusinessSandboxCommand/notify'))
    const { db } = fakeDb({
      students: [{ _id: 's1', ownerCoachId: 'coach-1', datasetId: 'ds-1', studentId: 'stu-1', data: { id: 'stu-1', name: '李四' } }],
      packages: [{ _id: 'p1', ownerCoachId: 'coach-1', datasetId: 'ds-1', studentId: 'stu-1', packageId: 'pkg-1', data: { id: 'pkg-1', type: '常规课' } }],
      member_sandbox_coach_profiles: [{ _id: 'cp1', coachId: 'coach-1', displayName: '王教练' }]
    })
    const queued = new Map()
    const event = { eventId: 'e1', booking: { studentId: 'stu-1', packageId: 'pkg-1' } }
    queued.set('e1', event)
    // ⛔ 直接调内部那条富化逻辑：通过 `scope()` 暴露出来的 `enrichFacts`
    const scope = notify.scope({ collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ data: [] }) }) }) }) }, 'sandbox', 'coach-1', 'ds-1')
    // ⛔ scope 内部队列是私有的 ⇒ 用 `record` 之外的公开路径不可行时，改为校验**源码契约**
    assert.ok(typeof scope.enrichFacts === 'function', '⛔ notify.scope 没有暴露 enrichFacts')
    await scope.enrichFacts(db)
    assert.strictEqual(queued.size, 1)
    // ⛔ 源码层：富化只能读服务端集合，绝不收客户端传进来的姓名
    const source = read('cloudfunctions/coachBusinessSandboxCommand/notify.js')
    assert.ok(source.includes("db.collection('students')"), '⛔ 没有从学员档案读姓名')
    assert.ok(source.includes("db.collection('packages')"), '⛔ 没有从课时包读类型')
    assert.ok(/studentName: ''/.test(source), '⛔ bookingFactsOf 没有预留 studentName 字段')
    assert.ok(/courseTypeName: ''/.test(source), '⛔ bookingFactsOf 没有预留 courseTypeName 字段')
  })

  await check('⛔ 富化失败**绝不抛**（附属功能不许把已成功的业务拖下水）', async () => {
    const notify = require(P('cloudfunctions/coachBusinessSandboxCommand/notify'))
    const broken = { collection: () => { throw new Error('Db or Table not exist') } }
    const scope = notify.scope(broken, 'sandbox', 'coach-1', 'ds-1')
    await scope.enrichFacts(broken)   // ⛔ 不许抛
  })

  console.log('\n【⑥ 收件人由服务端定 · 客户端提交不了】')

  await check('客户端只读自己的箱子：OPENID 反查不到 ⇒ **一条都不给**（⛔ 绝不退化成全给）', async () => {
    const { db } = fakeDb({
      member_sandbox_notification_inbox: [{ _id: 'x', environment: 'sandbox', kind: 'member', ownerId: 'member-1', title: 't', body: 'b', createdAt: 1, read: false }],
      coaches: [{ _id: 'coach-1', openId: 'openid-coach' }],
      member_sandbox_accounts: [{ _id: 'a1', memberId: inboxModule.memberIdFor('openid-member'), openId: 'openid-member' }]
    })
    const box = inboxModule.createInbox({ db, environment: 'sandbox' })
    const stranger = await box.handle({ openId: 'openid-stranger', kind: 'member', op: 'list' })
    assert.strictEqual(stranger.ok, false, '⛔ 陌生人竟然也能读消息')
    assert.strictEqual(stranger.code, 'INBOX_OWNER_UNRESOLVED')
    assert.strictEqual(stranger.rows.length, 0, '⛔ 查不到身份就把别人的消息给出去了')
  })

  await check('会员只能看会员表、教练只能看教练表（两个箱子**完全隔离**）', async () => {
    const memberId = inboxModule.memberIdFor('openid-member')
    const { db } = fakeDb({
      member_sandbox_notification_inbox: [{ _id: 'm1', environment: 'sandbox', kind: 'member', ownerId: memberId, title: '会员的', body: 'b', createdAt: 2, read: false }],
      coach_sandbox_notification_inbox: [{ _id: 'c1', environment: 'sandbox', kind: 'coach', ownerId: 'coach-1', title: '教练的', body: 'b', createdAt: 1, read: false }],
      coaches: [{ _id: 'coach-1', openId: 'openid-coach' }],
      member_sandbox_accounts: [{ _id: 'a1', memberId, openId: 'openid-member' }]
    })
    const box = inboxModule.createInbox({ db, environment: 'sandbox' })
    const mine = await box.handle({ openId: 'openid-member', kind: 'member', op: 'list' })
    assert.strictEqual(mine.rows.length, 1)
    assert.strictEqual(mine.rows[0].title, '会员的')
    assert.strictEqual(mine.unread, 1)
    const coach = await box.handle({ openId: 'openid-coach', kind: 'coach', op: 'list' })
    assert.strictEqual(coach.rows.length, 1)
    assert.strictEqual(coach.rows[0].title, '教练的')
  })

  await check('未读计数 + 标记已读（全部 / 指定 id）', async () => {
    const memberId = inboxModule.memberIdFor('openid-member')
    const { db } = fakeDb({
      member_sandbox_notification_inbox: [
        { _id: 'm1', environment: 'sandbox', kind: 'member', ownerId: memberId, title: 'a', body: 'b', createdAt: 1, read: false },
        { _id: 'm2', environment: 'sandbox', kind: 'member', ownerId: memberId, title: 'b', body: 'b', createdAt: 2, read: false }
      ],
      member_sandbox_accounts: [{ _id: 'a1', memberId, openId: 'openid-member' }]
    })
    const box = inboxModule.createInbox({ db, environment: 'sandbox' })
    assert.strictEqual((await box.handle({ openId: 'openid-member', kind: 'member', op: 'list' })).unread, 2)
    const one = await box.handle({ openId: 'openid-member', kind: 'member', op: 'read', ids: ['m1'] })
    assert.strictEqual(one.changed, 1)
    assert.strictEqual(one.unread, 1)
    const all = await box.handle({ openId: 'openid-member', kind: 'member', op: 'read' })
    assert.strictEqual(all.unread, 0)
  })

  await check('列表按时间**倒序**（最新的一条在最上面）', async () => {
    const memberId = inboxModule.memberIdFor('openid-member')
    const { db } = fakeDb({
      member_sandbox_notification_inbox: [
        { _id: 'm1', environment: 'sandbox', kind: 'member', ownerId: memberId, title: '旧的', body: 'b', createdAt: 100, read: false },
        { _id: 'm2', environment: 'sandbox', kind: 'member', ownerId: memberId, title: '新的', body: 'b', createdAt: 200, read: false }
      ],
      member_sandbox_accounts: [{ _id: 'a1', memberId, openId: 'openid-member' }]
    })
    const box = inboxModule.createInbox({ db, environment: 'sandbox' })
    const list = await box.handle({ openId: 'openid-member', kind: 'member', op: 'list' })
    assert.strictEqual(list.rows[0].title, '新的')
  })

  await check('⛔ 客户端**不许**提交任何收件人字段（openId / coachId / memberId）', () => {
    const client = read('utils/notification-inbox.js')
    const payload = client.slice(client.indexOf('const options = { environment'), client.indexOf('return wx.cloud.callFunction'))
    ;['openId', 'coachId', 'memberId', 'recipient', 'ownerId'].forEach(field => {
      assert.ok(payload.indexOf(`${field}:`) < 0, `⛔ 客户端提交了定位字段 ${field}`)
    })
    // ⛔ 云函数名**只从路由表取**（隔离护栏 §⑧：页面/工具源码里不许出现 Sandbox 函数名）
    assert.ok(client.indexOf('coachBusinessSandboxCommand') < 0, '⛔ 客户端写死了云函数名')
    assert.ok(client.indexOf('routing.businessFunction') >= 0, '⛔ 客户没有走路由表')
    const page = read('pages/notification-inbox/notification-inbox.js')
    assert.ok(page.indexOf('coachBusinessSandboxCommand') < 0, '⛔ 消息中心页写死了云函数名')
  })

  await check('正式区 ⇒ 客户端**整个入口藏起来**（`available()` 为假 + 零云调用）', () => {
    withClientModule('production', client => {
      assert.strictEqual(client.available(), false, '⛔ 正式区竟然显示站内消息入口')
      const calls = []
      global.wx = { cloud: { callFunction: async options => { calls.push(options); return { result: {} } } } }
      return client.unread('member').then(count => {
        assert.strictEqual(count, 0)
        assert.strictEqual(calls.length, 0, '⛔ 正式区竟然发起了一次云调用')
        delete global.wx
      })
    })
  })

  console.log('\n【⑦ 入口 / 红点 / 会员端提醒收口】')

  await check('会员端消息卡片已撤下，教练端入口照旧', () => {
    const profile = read('pages/member-profile/member-profile.wxml')
    const home = read('pages/member-home/member-home.wxml')
    const stats = read('pages/stats/stats.wxml')
    assert.ok(!/bindtap="openInbox"/.test(profile), '⛔ 会员「我的」仍有已撤下的消息中心入口')
    assert.ok(!/inboxUnread>0/.test(profile), '⛔ 会员「我的」仍有已撤下的未读条数')
    assert.ok(!/bindtap="openInbox"/.test(home), '⛔ 会员首页仍有重复的消息中心入口')
    assert.ok(/bindtap="openInbox"/.test(stats), '⛔ 教练「统计」没有消息中心入口')
    assert.ok(/inboxUnread>0/.test(stats), '⛔ 教练端没有未读条数')
    // 教练端入口必须继续受 `inboxAvailable` 约束；会员页面不再加载消息模块。
    assert.ok(!/inboxAvailable|openInbox|inboxUnread/.test(profile), '⛔ 会员“我的”仍加载已撤下的消息模块')
    assert.ok(/wx:if="{{inboxAvailable}}"/.test(stats), '⛔ 教练端入口没做环境门禁')
    const pageJson = JSON.parse(read('app.json'))
    assert.ok(pageJson.pages.indexOf('pages/notification-inbox/notification-inbox') >= 0, '⛔ 消息中心页没有注册')
  })

  await check('会员端不再申请无效微信提醒；教练端已可用链路继续保留', () => {
    const slots = read('pages/member-book-slots/member-book-slots.js')
    const bookings = read('pages/member-bookings/member-bookings.js')
    const bookingModal = read('components/booking-modal/booking-modal.js')
    const session = read('pages/session/session.js')
    const claim = read('pages/member-claim/member-claim.js')
    assert.ok(/requestNextAfterAction\('coach'/.test(bookingModal), '⛔ 教练排课没有补下一条提醒额度')
    assert.ok((session.match(/requestNextAfterAction\('coach'/g) || []).length >= 2, '⛔ 教练取消或改期没有补下一条提醒额度')
    assert.ok(!/notify-consent|requestNextAfterAction\('member'/.test(slots + bookings), '⛔ 会员预约管理仍会弹微信提醒')
    assert.ok(!/notify-consent|requestConsent\('member'/.test(claim), '⛔ 新会员首次领取仍会弹微信提醒')
    assert.ok(!/await\s+notifyConsent\.requestNextAfterAction/.test(bookingModal + session + slots + bookings), '⛔ 通知授权阻断了主业务')
  })

  await check('统一订阅模块由常用按钮调用，独立设置页仍不进入产品路由', () => {
    const source = read('utils/notify-consent.js')
    assert.ok(/function requestNextAfterAction/.test(source))
    assert.ok(/\.then\([\s\S]{0,400}\}\)?\s*,\s*\(\)\s*=>\s*null\)/.test(source), '⛔ 没有兜住失败 ⇒ 会把业务一起拖下水')
    assert.ok(/function runBusinessTap\(role, action\)/.test(source), '⛔ 缺少真实按钮统一入口')
    const body = source.slice(source.indexOf('function runBusinessTap'), source.indexOf('// 🧾', source.indexOf('function runBusinessTap')))
    assert.ok(!/await\s+requestNextAfterAction/.test(body), '⛔ 授权被 await，业务会被卡住')
    assert.ok(/return typeof action === 'function' \? action\(\)/.test(body), '⛔ 历史兼容助手改变了原业务返回值')
    const app = JSON.parse(read('app.json'))
    assert.ok(!app.pages.includes('pages/notify-settings/notify-settings'), '⛔ 通知设置页仍注册在正式产品路由')
  })

  await check('课表不再显示手动刷新字样，下拉刷新也不申请一次性订阅', () => {
    const wxml = read('pages/schedule/schedule.wxml')
    const js = read('pages/schedule/schedule.js')
    assert.ok(!/bindtap="refreshScheduleNow"|刷新课表|刷新页面/.test(wxml), '⛔ 课表页仍显示多余的手动刷新入口')
    assert.ok(!/refreshAllowText/.test(js), '⛔ 课表数据里仍保留多余的刷新文字')
    assert.ok(!/notify-consent|requestConsent|refreshAndAllow/.test(js), '⛔ 课表页仍接入一次性订阅')
    // ⛔ 下拉刷新 / 换日期 / 返回 / 看统计这些路径里**不许**出现授权调用
    const refreshBlock = js.slice(js.indexOf('async refreshSchedule('), js.indexOf('loadScheduleData()'))
    assert.ok(!/requestConsent|requestNextAfterAction/.test(refreshBlock), '⛔ 普通下拉刷新也去弹授权了')
    assert.ok(!/requestConsent|requestNextAfterAction/.test(js.slice(js.indexOf('pickDate(e)'), js.indexOf('openDateCalendar'))), '⛔ 换日期也去弹授权了')
  })

  console.log('\n【⑧ 档案异常不许再"无声消失"】')

  await check('服务端 head 异常 ⇒ **档案照旧下发**（degraded:true），⛔ 不再整份丢掉', () => {
    const service = read('cloudfunctions/readMyMemberData/service.js')
    assert.ok(/archiveViews\.push\(degradedArchive\(/.test(service), '⛔ 还是把档案 continue 掉了')
    assert.ok(/degraded: true/.test(service), '⛔ 降级档案没有 degraded 标记')
    // ⛔ 主读取循环（带 `headCode` 的那一段）里不许再出现"只 push 一条 warning 就 continue"的旧写法
    const mainBlock = service.slice(service.indexOf('const headCode = heads.length > 1'), service.indexOf('const profile = profileByCoach.get'))
    assert.ok(mainBlock.includes('archiveViews.push(degradedArchive('), '⛔ 主循环没有下发降级档案')
    assert.ok(!/warnings\.push\([^;]*\); continue/.test(mainBlock), '⛔ 主读取循环里还在静默丢弃档案')
  })

  await check('⛔ 不许再回一个假的"数据已就绪"：`dataComplete:false` + 降级条数', () => {
    const service = read('cloudfunctions/readMyMemberData/service.js')
    assert.ok(/dataComplete: warnings\.length === 0/.test(service), '⛔ 没有 dataComplete 字段')
    assert.ok(/degradedArchives: warnings\.length/.test(service), '⛔ 没有降级条数')
  })

  await check('⛔ 降级档案**不投影**任何教练 / 课包 / 预约（绝不混入别处数据）', () => {
    const service = read('cloudfunctions/readMyMemberData/service.js')
    const block = service.slice(service.indexOf('if (headCode) {'), service.indexOf('const profile = profileByCoach.get'))
    assert.ok(/continue/.test(block), '⛔ 降级之后没有跳过数据投影 ⇒ 会拿空 head 去查课包')
    assert.ok(!/packageRows|bookingRows/.test(block), '⛔ 降级分支里还在投影数据')
  })

  await check('界面把"读取不完整"说成人话（⛔ 不许显示成数据已就绪）', () => {
    const view = require(P('utils/member-view-model'))
    assert.strictEqual(view.incompleteTextOf({ warnings: [] }), '', '⛔ 没有异常却显示了提示')
    const one = view.incompleteTextOf({ warnings: [{ code: 'COACH_DATASET_HEAD_AMBIGUOUS' }] })
    assert.ok(one.includes('这份会员资料暂时读取不完整，请稍后重试。'), one)
    const many = view.incompleteTextOf({ warnings: [{ code: 'A' }, { code: 'B' }] })
    assert.ok(many.includes('有 2 份会员资料暂时读取不完整'), many)
    // 服务端修好之后直接下发 degraded 档案行 ⇒ 也要认得出来
    const degraded = view.incompleteTextOf({ warnings: [], archives: [{ archiveId: 'a', degraded: true }, { archiveId: 'b' }] })
    assert.ok(degraded.includes('这份会员资料暂时读取不完整'), degraded)
    const home = read('pages/member-home/member-home.wxml')
    assert.ok(/incompleteText/.test(home), '⛔ 首页没显示档案不完整的提示')
  })

  console.log('\n【⑨ 判别力：把正确实现改坏 ⇒ 必须分别变红】')

  await check('判别力①：去掉环境硬闸（production 也能写）⇒ 变红', () => {
    withDrift(INBOX, source => source.replace(
      "  if (environment !== 'sandbox' || !db) return null",
      '  if (!db) return null'
    ), drifted => {
      const { db } = fakeDb()
      const box = drifted.createInbox({ db, environment: 'production' })
      assert.ok(box && typeof box.note === 'function', '⛔ 变异后正式区**仍然**写不了 ⇒ 这条断言没有判别力')
    })
  })

  await check('判别力②：只写一条（删掉操作者那条）⇒ 变红', () => {
    const rows = (() => {
      withDrift(INBOX, source => source.replace(
        "  if (actor.kind === KIND_MEMBER && actor.memberId) {",
        "  if (false) {"
      ), drifted => drifted.rowsOf(EVENT, null))
      return null
    })()
    assert.strictEqual(rows, null)
    const two = inboxModule.rowsOf(EVENT, null).length
    assert.strictEqual(two, 2, '⛔ 前置条件不成立')
    withDrift(INBOX, source => source.replace(
      "  if (actor.kind === KIND_MEMBER && actor.memberId) {",
      "  if (false) {"
    ), drifted => {
      assert.strictEqual(drifted.rowsOf(EVENT, null).length, 1, '⛔ 删掉操作者那条之后仍然是两条 ⇒ 判别力为空')
    })
  })

  await check('判别力③：一方微信成功把另一方也标成成功 ⇒ 变红', () => {
    withDrift(INBOX, source => source.replace(
      "sent: !!(row.wechat && row.wechat.sent),",
      "sent: !!(push && push.sent),"
    ), drifted => {
      const rows = drifted.rowsOf(EVENT, { sent: true, code: 'SENT' })
      const actor = rows.find(row => row.audience === 'actor')
      assert.strictEqual(actor.wechat.sent, true, '⛔ 变异后操作者那条**仍然**没被标成功 ⇒ 判别力为空')
    })
  })

  await check('判别力④：把"张三"改回笼统的"会员" ⇒ 变红', () => {
    withDrift('cloudfunctions/coachBusinessSandboxCommand/notify-templates', source => source.replace(
      "counterpart: toCoach ? (studentName || MEMBER_TEXT) : (coachName || COACH_TEXT),",
      "counterpart: toCoach ? MEMBER_TEXT : COACH_TEXT,"
    ), drifted => {
      const message = drifted.messageOf({ type: 'member-booking-cancelled', booking: EVENT.booking, recipient: { kind: 'coach' } })
      assert.strictEqual(message.data.thing2.value, '学员', '⛔ 变异后仍然写了真实姓名 ⇒ 判别力为空')
    })
  })

  await check('判别力⑤：把事件来源改成"只写另一方的集合"（会员那条丢掉）⇒ 变红', () => {
    withDrift(INBOX, source => source.replace(
      "    out.push({ kind: KIND_MEMBER, ownerId: String(actor.memberId), audience: AUDIENCE_ACTOR, wechat: { sent: false, code: 'SELF_ACTION_NO_PUSH' } })",
      "    /* 变异：操作者那条不写了 */"
    ), drifted => {
      const rows = drifted.rowsOf({ ...EVENT, actor: { kind: 'member', memberId: 'member-1' } }, null)
      assert.strictEqual(rows.length, 1, '⛔ 变异后仍是两条 ⇒ 判别力为空')
      assert.strictEqual(rows[0].kind, 'coach')
    })
  })

  await check('判别力⑥：教练提醒丢失或会员提醒回潮时，内存反证会变红', () => {
    const mutation = read('tests/_notify-business-buttons-mutate.js')
    assert.ok(/教练排课漏掉下一条提醒/.test(mutation) && /教练取消和改期漏掉下一条提醒/.test(mutation), '⛔ 教练排课/取消/改期缺少反证')
    assert.ok(/会员预约重新弹提醒/.test(mutation) && /会员取消重新弹提醒/.test(mutation), '⛔ 会员预约/取消提醒回潮缺少反证')
    assert.ok(/会员首次领取重新弹提醒/.test(mutation), '⛔ 会员首次领取提醒回潮缺少反证')
    assert.ok(/通知授权被 await 后阻塞业务/.test(mutation), '⛔ 没有验证通知不得阻塞业务')
  })

  const failed = results.filter(row => row.startsWith('❌'))
  console.log(`\n${results.join('\n')}`)
  console.log(failed.length ? `\n❌ ${failed.length} 条失败` : '\n✅ §174 全部通过')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
