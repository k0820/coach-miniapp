// 微信**订阅消息**投递层 · 永久回归（2026-10-05 需求五；2026-10-05 晚按用户最终决定改为 **3 个模板**）
//
// ⭐ 本文件钉的是 `cloudfunctions/*/notify-templates.js` + `subscribe-delivery.js` + `utils/notify-consent.js`。
//   ⛔ 它**不重复** `m3-p0-notify-resilience.test.js`（那条管"事件落库不许拖垮业务"）；
//      本文件管的是"**真的发出去**"那一步的硬纪律。
//
// 🚨 硬纪律（逐条有判据、每条都有判别力反证）：
//   ① 缺模板 ⇒ `TEMPLATE_NOT_CONFIGURED`，⛔ 绝不假成功、⛔ 一次 send 都不许调；
//   ② 自己动的手不通知自己（不会出现"你的课程被你本人修改"）；
//   ③ 一个业务事件最多发一次（成功后 `delivered=true`，重试不再发）；
//   ④ 失败留痕、可安全重试（`attempts` + 失败码），⛔ 失败时绝不说成功；
//   ⑤ Sandbox 只用 Sandbox 集合，⛔ 绝不跨环境；
//   ⑥ 授权必须由用户点按钮触发，且**五种状态照实显示**；
//   ⑦ 模板**只有 3 个**：6 种状态事件共用「课程预约状态通知」，2 种课前提醒各用一个。
//
// ⛔ 判别力自证：⛔ 禁止改生产源码做变异，一律用 `Module._compile` 在**内存里**编译漂移副本。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
const P = p => path.join(ROOT, p)
const DELIVERY = 'cloudfunctions/coachBusinessCommand/subscribe-delivery'
const TEMPLATES = 'cloudfunctions/coachBusinessCommand/notify-templates'
const notify = require(P('cloudfunctions/coachBusinessCommand/notify'))

const SANDBOX_EVENTS = 'member_sandbox_notification_events'
const PRODUCTION_EVENTS = 'member_notification_events'

let seq = 0

// ─────────────────────────────────────────────────────────────────────────────
// 假 db：只实现投递层用到的那几个读写入口（集合**不会**自动创建 —— 与真 CloudBase 同口径）
// =============================================================================
function createDb(existing = {}) {
  const stores = new Map(Object.keys(existing).map(name => [name, new Map(Object.keys(existing[name]).map(id => [id, { _id: id, ...existing[name][id] }]))]))
  const matches = (row, query) => Object.keys(query).every(key => {
    if (key.indexOf('.') < 0) return row[key] === query[key]
    const value = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), row)
    return value === query[key]
  })
  const collection = name => ({
    doc(id) {
      return {
        async get() { const s = stores.get(name); const row = s && s.get(id); return { data: row ? { ...row } : null } },
        async set({ data }) { if (!stores.has(name)) throw new Error(`Table not exist: ${name}`); stores.get(name).set(id, { ...data, _id: id }); return { _id: id } }
      }
    },
    where(query) {
      let limit = 100
      const api = {
        limit(v) { limit = v; return api },
        async get() {
          const s = stores.get(name)
          if (!s) throw Object.assign(new Error(`Db or Table not exist: ${name}`), { errCode: -502005 })
          return { data: [...s.values()].filter(row => matches(row, query)).slice(0, limit).map(row => ({ ...row })) }
        }
      }
      return api
    }
  })
  return { db: { collection }, stores }
}

function makeEvent(overrides = {}) {
  const type = overrides.type || notify.EVENT_TYPES.MEMBER_CREATED
  const eventId = overrides.eventId || `evt-${++seq}`
  return {
    eventId, type, environment: overrides.environment || 'sandbox',
    actor: overrides.actor || { kind: 'member', memberId: 'member-1' },
    recipient: overrides.recipient || { kind: 'coach', coachId: 'coach-1' },
    booking: overrides.booking || { bookingId: 'bk-1', date: '2026-10-06', hour: 9, minute: 30, status: 'booked', studentId: 'stu-1' },
    occurredAt: 1780000000000,
    delivered: false,
    delivery: { channel: null, sentAt: null, attempts: 0 },
    ...overrides
  }
}

// ⭐ 在**内存里**编译一份漂移的 `notify-templates.js`，塞进 `require.cache`，
//    再重新加载 `subscribe-delivery` ⇒ 磁盘一个字节都不动。
// `mutate` 漂 `notify-templates.js`；可选的 `mutateDelivery` 漂 `subscribe-delivery.js`（两者都在内存里）
function loadDeliveryWithTemplates(mutate, mutateDelivery) {
  const tplPath = require.resolve(P(TEMPLATES + '.js'))
  const source = fs.readFileSync(tplPath, 'utf8')
  const drifted = mutate(source)
  assert.notStrictEqual(drifted, source, '⛔ 漂移脚本自身失效：notify-templates.js 的锚点没命中')
  const stub = new Module(tplPath, null)
  stub.filename = tplPath
  stub.paths = Module._nodeModulePaths(path.dirname(tplPath))
  stub._compile(drifted, tplPath)
  stub.loaded = true
  const saved = require.cache[tplPath]
  require.cache[tplPath] = stub
  try {
    const deliveryPath = require.resolve(P(DELIVERY + '.js'))
    delete require.cache[deliveryPath]
    delete require.cache[require.resolve(P('cloudfunctions/coachBusinessCommand/notify.js'))]
    if (mutateDelivery) {
      const deliverySource = fs.readFileSync(deliveryPath, 'utf8')
      const deliveryDrifted = mutateDelivery(deliverySource)
      assert.notStrictEqual(deliveryDrifted, deliverySource, '⛔ 漂移脚本自身失效：subscribe-delivery.js 的锚点没命中')
      return loadDelivery(DELIVERY, deliveryDrifted)
    }
    return require(deliveryPath)
  } finally {
    if (saved) require.cache[tplPath] = saved; else delete require.cache[tplPath]
  }
}

// ⛔ 模板 ID 已经在真源码里**填了真值** ⇒ 漂移锚点**不许**写死 `''`（那样会静默失效 ⇒ 假绿）。
//    一律用**正则**按槽位名替换：不管当前值是空串还是真 ID，都替换得掉。
const SLOT_RE = /\[TEMPLATE_SLOTS\.(COURSE_STATUS|REMINDER_3H|REMINDER_1H)\]:\s*'[^']*'/g
const replaceSlot = (source, slot, id) => source.replace(
  SLOT_RE, (whole, name) => (name === slot ? `[TEMPLATE_SLOTS.${name}]: '${id}'` : whole)
)

// 把「预约状态提醒」这个槽位填上（假装模板已经申请下来）
const withStatusTemplate = id => source => replaceSlot(source, 'COURSE_STATUS', id)

// ⛔ "缺模板"这条判据现在**必须**靠漂移副本造出来（真源码里 3 个模板都已经配置好了）：
//    把三个槽位全部清空 ⇒ 投递层必须如实回 `TEMPLATE_NOT_CONFIGURED`。
const withoutTemplates = source => source.replace(SLOT_RE, (whole, name) => `[TEMPLATE_SLOTS.${name}]: ''`)

// ⭐ 在**内存里**编译一份漂移的 `utils/notify-consent.js`（磁盘零改动）
function loadConsent(mutate) {
  const filePath = require.resolve(P('utils/notify-consent'))
  const source = fs.readFileSync(filePath, 'utf8')
  const drifted = mutate(source)
  assert.notStrictEqual(drifted, source, '⛔ 漂移脚本自身失效：utils/notify-consent.js 的锚点没命中')
  const stub = new Module(filePath, null)
  stub.filename = filePath
  stub.paths = Module._nodeModulePaths(path.dirname(filePath))
  stub._compile(drifted, filePath)
  stub.loaded = true
  const saved = require.cache[filePath]
  require.cache[filePath] = stub
  try { return require(filePath) } finally { if (saved) require.cache[filePath] = saved; else delete require.cache[filePath] }
}
const CONSENT_ID_RE = /'(course-status|reminder-3h|reminder-1h)':\s*'[^']*'/g
const blankConsentIds = source => source.replace(CONSENT_ID_RE, (whole, slot) => `'${slot}': ''`)

function loadDelivery(rel = DELIVERY, sourceOverride) {
  const resolved = require.resolve(P(rel + '.js'))
  delete require.cache[resolved]
  if (typeof sourceOverride === 'string') {
    const m = new Module(resolved, null)
    m.filename = resolved
    m.paths = Module._nodeModulePaths(path.dirname(resolved))
    m._compile(sourceOverride, resolved)
    return m.exports
  }
  return require(resolved)
}

const results = []
async function test(name, fn) {
  try { await fn(); results.push(`PASS ${name}`) }
  catch (error) { results.push(`FAIL ${name}\n    ${String(error && error.stack).split('\n').slice(0, 4).join('\n    ')}`); process.exitCode = 1 }
}

async function main() {
  // ═══════════════════════════════════════════════════════════════════════════
  // 段 ① 缺模板 ⇒ 如实报"模板尚未配置"（⛔ 绝不假成功）
  // ═══════════════════════════════════════════════════════════════════════════
  await test('①-a ✅ 三个**真实**模板已配置齐全（微信后台已选用 ⇒ 8 种事件全部有模板可用）', async () => {
    const delivery = loadDelivery()
    const tpl = delivery.templates
    // ⛔ 三个槽位都必须有**真实的**模板 ID（空串 = 后台还没选用 ⇒ 一条都发不出去）
    Object.keys(tpl.TEMPLATE_IDS).forEach(slot => {
      const id = String(tpl.TEMPLATE_IDS[slot] || '')
      assert.ok(id.length > 10, `⛔ ${slot} 的模板 ID 是空的（后台还没选用模板 ⇒ 提醒功能不可用）`)
    })
    // ⛔ 三个 ID 必须互不相同（微信不允许两个槽位共用同一个模板 ID）
    const ids = Object.keys(tpl.TEMPLATE_IDS).map(slot => String(tpl.TEMPLATE_IDS[slot]))
    assert.strictEqual(new Set(ids).size, 3, `⛔ 三个模板 ID 有重复：${ids.join(' / ')}`)
    assert.strictEqual(tpl.isConfigured(), true, '⛔ 3 个模板必须全部配置好')
    assert.deepStrictEqual(tpl.missingSlots(), [], '⛔ 还有槽位没填模板 ID')
    // ⛔ 8 种事件每一种都要落到某个模板上（一个都不许漏）
    assert.strictEqual(delivery.missingTypes().length, 0, '⛔ 有事件种类没有可用模板')
    assert.strictEqual(delivery.configuredTypes().length, tpl.KIND_LIST.length, '⛔ 8 种事件应全部有模板')
  })

  await test('①-b 🚨 模板没配置 ⇒ TEMPLATE_NOT_CONFIGURED + ⛔ 一次 send 都不许调', async () => {
    // ⛔ 真源码里 3 个模板**都已配置** ⇒ "缺模板"这条必须用**内存漂移副本**造出来（磁盘零改动）
    const delivery = loadDeliveryWithTemplates(withoutTemplates)
    assert.strictEqual(delivery.templateIdFor(notify.EVENT_TYPES.MEMBER_CREATED), '', '⛔ 反证前置：漂移版必须真的没有模板')
    const { db } = createDb({ [SANDBOX_EVENTS]: {} })
    let sendCalls = 0
    const result = await delivery.deliverEvent({
      db, environment: 'sandbox', event: makeEvent(), send: async () => { sendCalls += 1 }, openIdFor: async () => 'openid-x', now: 1
    })
    assert.strictEqual(result.ok, false, '🚨 没有模板却回报成功 = 最恶劣的一种假象')
    assert.strictEqual(result.code, 'TEMPLATE_NOT_CONFIGURED', `必须明确说"模板尚未配置"（实测 ${result.code}）`)
    assert.strictEqual(result.sent, false, '⛔ 绝不能算作"已发送"')
    assert.strictEqual(sendCalls, 0, '🚨 没有模板竟然还去调了发送接口')
    // ⛔ 8 种事件**全部**没配置 ⇒ 界面必须说"还没配置"，而不是"已开启"
    assert.deepStrictEqual(delivery.configuredTypes(), [], '⛔ 漂移版应当 8 种事件一个都配不上')
    assert.strictEqual(delivery.missingTypes().length, delivery.templates.KIND_LIST.length, '8 种事件一个都不能漏')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 段 ② 只通知**另一方**（绝不出现"你的课程被你本人修改"）
  // ═══════════════════════════════════════════════════════════════════════════
  await test('② 🚨 自己动的手绝不通知自己（不发生"你的课程被你本人修改"）', async () => {
    const { db } = createDb({ [SANDBOX_EVENTS]: {} })
    const delivery = loadDelivery()
    let sendCalls = 0
    // 会员自己改期，recipient 却写成了自己 ⇒ 必须跳过
    const selfMember = await delivery.deliverEvent({
      db, environment: 'sandbox', send: async () => { sendCalls += 1 }, openIdFor: async () => 'openid-x', now: 1,
      event: makeEvent({ type: notify.EVENT_TYPES.MEMBER_RESCHEDULED, actor: { kind: 'member', memberId: 'member-1' }, recipient: { kind: 'member', memberId: 'member-1' } })
    })
    assert.strictEqual(selfMember.ok, false, '🚨 自己改自己的课却给自己发了提醒')
    assert.strictEqual(selfMember.code, 'SELF_ACTION_SKIPPED', `必须明确跳过（实测 ${selfMember.code}）`)
    // 教练同理
    const selfCoach = await delivery.deliverEvent({
      db, environment: 'sandbox', send: async () => { sendCalls += 1 }, openIdFor: async () => 'openid-x', now: 1,
      event: makeEvent({ type: notify.EVENT_TYPES.COACH_CANCELLED, actor: { kind: 'coach', coachId: 'coach-1' }, recipient: { kind: 'coach', coachId: 'coach-1' } })
    })
    assert.strictEqual(selfCoach.code, 'SELF_ACTION_SKIPPED', '教练同理')
    assert.strictEqual(sendCalls, 0, '🚨 自我通知竟然真的发了')
    // ⛔ 反过来说：方向**正确**的事件不能被这条闸误杀
    const normal = makeEvent({ actor: { kind: 'member', memberId: 'member-1' }, recipient: { kind: 'coach', coachId: 'coach-1' } })
    assert.strictEqual(delivery.isSelfAction(normal), false, '⛔ 正常的"通知对方"不许被误判成自我通知')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 段 ③ 一个业务事件**最多发一次**（配置了模板的正向对照）
  // ═══════════════════════════════════════════════════════════════════════════
  await test('③ ⛔ 一个业务事件最多发一次：成功后 delivered=true，再跑一次不再发', async () => {
    // ⭐ 这一条用**注入了模板 ID 的漂移副本**（内存编译，磁盘零改动）——
    //    不然"没模板"会把所有路径都短路掉，"最多一次"这条就永远测不到。
    const delivery = loadDeliveryWithTemplates(withStatusTemplate('TEMPLATE_STATUS_FAKE'))
    assert.strictEqual(delivery.templateIdFor(notify.EVENT_TYPES.MEMBER_CREATED), 'TEMPLATE_STATUS_FAKE')

    const event = makeEvent()
    const { db, stores } = createDb({ [SANDBOX_EVENTS]: { [event.eventId]: event } })
    let sendCalls = 0
    const sentArgs = []
    const first = await delivery.deliverEvent({
      db, environment: 'sandbox', event, now: 1000,
      send: async args => { sendCalls += 1; sentArgs.push(args) },
      openIdFor: async () => 'openid-coach-1'
    })
    assert.strictEqual(first.sent, true, '（前置）第一次必须真的发出去')
    assert.strictEqual(sendCalls, 1)
    assert.strictEqual(sentArgs[0].touser, 'openid-coach-1', '⛔ 收件人必须是**对方**的微信标识')
    assert.strictEqual(sentArgs[0].templateId, 'TEMPLATE_STATUS_FAKE')
    // 🚨 判据本体：标记成已投递
    const row = stores.get(SANDBOX_EVENTS).get(event.eventId)
    assert.strictEqual(row.delivered, true, '发送成功后必须标记 delivered')
    assert.strictEqual(row.delivery.channel, 'wechat-subscribe', '必须如实记下渠道')
    assert.strictEqual(row.delivery.attempts, 1)

    // 第二次（比如定时器又扫了一遍）⇒ 不许再发
    const again = await delivery.deliverEvent({
      db, environment: 'sandbox', event: { ...event, delivered: true }, now: 2000,
      send: async () => { sendCalls += 1 }, openIdFor: async () => 'openid-coach-1'
    })
    assert.strictEqual(again.sent, false, '🚨 同一条事件发了第二次 ⇒ 会员/教练会收到两条一样的提醒')
    assert.strictEqual(again.code, 'ALREADY_DELIVERED')
    assert.strictEqual(sendCalls, 1, '🚨 第二次竟然又调了一次发送接口')

    // ⛔ 待投递列表也必须是空的（`pending` 只捞 delivered=false）
    const pending = await notify.pending(db, 'sandbox', { kind: 'coach', coachId: 'coach-1' })
    assert.strictEqual(pending.length, 0, '⛔ 已投递的事件不许再出现在待投递列表里')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 段 ④ 失败留痕 + 可安全重试（⛔ 失败绝不说成功）
  // ═══════════════════════════════════════════════════════════════════════════
  await test('④ ⛔ 用户没授权（43101）⇒ 如实报 SUBSCRIBE_NOT_AUTHORIZED，失败留痕且可重试', async () => {
    const delivery = loadDeliveryWithTemplates(withStatusTemplate('T'))
    const event = makeEvent()
    const { db, stores } = createDb({ [SANDBOX_EVENTS]: { [event.eventId]: event } })
    const unauthorized = async () => { throw Object.assign(new Error('user refuse to accept the msg'), { errCode: 43101 }) }
    const failed = await delivery.deliverEvent({ db, environment: 'sandbox', event, send: unauthorized, openIdFor: async () => 'openid-coach-1', now: 1000 })
    assert.strictEqual(failed.ok, false, '🚨 用户没授权却回报成功')
    assert.strictEqual(failed.code, 'SUBSCRIBE_NOT_AUTHORIZED', `必须说清"用户还没授权"（实测 ${failed.code}）`)
    assert.strictEqual(failed.sent, false)
    // 🚨 判据本体：失败**不许**标记已投递 ⇒ 重试还能补发（重试也只补这一条）
    const row = stores.get(SANDBOX_EVENTS).get(event.eventId)
    assert.strictEqual(row.delivered, false, '⛔ 失败不许标成已投递（否则这条提醒就永远发不出去了）')
    assert.strictEqual(row.delivery.attempts, 1, '⛔ 失败必须留痕（attempts + 最后一次失败）')
    assert.strictEqual(row.delivery.lastFailure.code, 'SUBSCRIBE_NOT_AUTHORIZED')
    // 重试：这次授权好了 ⇒ 成功，且 attempts 累加而不是重来
    let sendCalls = 0
    const retried = await delivery.deliverEvent({
      db, environment: 'sandbox', event: { ...event, delivery: row.delivery }, now: 2000,
      send: async () => { sendCalls += 1 }, openIdFor: async () => 'openid-coach-1'
    })
    assert.strictEqual(retried.sent, true, '（前置）重试成功')
    assert.strictEqual(sendCalls, 1, '🚨 重试发了不止一次')
    const after = stores.get(SANDBOX_EVENTS).get(event.eventId)
    assert.strictEqual(after.delivered, true)
    // ⭐ 口径：attempts 是**累计尝试次数** ⇒ 失败那次 + 成功这次 = 2（不是被覆盖成 1）。
    assert.strictEqual(after.delivery.attempts, 2, '⛔ attempts 必须累计（失败那次也要留痕）')
  })

  await test('④-b 收件人标识查不到 ⇒ RECIPIENT_OPENID_MISSING，⛔ 不许猜一个发出去', async () => {
    const delivery = loadDeliveryWithTemplates(withStatusTemplate('T'))
    const { db } = createDb({ [SANDBOX_EVENTS]: {} })
    let sendCalls = 0
    const result = await delivery.deliverEvent({
      db, environment: 'sandbox', event: makeEvent(), now: 1,
      send: async () => { sendCalls += 1 }, openIdFor: async () => ''
    })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'RECIPIENT_OPENID_MISSING', `必须说清"找不到收件人"（实测 ${result.code}）`)
    assert.strictEqual(sendCalls, 0, '🚨 没有收件人竟然还发了')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 段 ⑤ Sandbox 只用 Sandbox 数据（⛔ 绝不跨环境）
  // ═══════════════════════════════════════════════════════════════════════════
  await test('⑤ ⛔ Sandbox 投递只碰 Sandbox 集合，正式区一条都不动', async () => {
    const prodEvent = makeEvent({ eventId: 'evt-prod', environment: 'production' })
    const sandboxEvent = makeEvent({ eventId: 'evt-sandbox', environment: 'sandbox' })
    const { db, stores } = createDb({ [SANDBOX_EVENTS]: { [sandboxEvent.eventId]: sandboxEvent }, [PRODUCTION_EVENTS]: { [prodEvent.eventId]: prodEvent } })
    const delivery = loadDeliveryWithTemplates(withStatusTemplate('T'))
    const before = JSON.stringify([...stores.get(PRODUCTION_EVENTS).values()])
    const outcome = await delivery.deliverPending({
      db, environment: 'sandbox', recipient: { kind: 'coach', coachId: 'coach-1' }, now: 1,
      send: async () => {}, openIdFor: async () => 'openid-coach-1'
    })
    assert.strictEqual(outcome.collection, SANDBOX_EVENTS, '⛔ 测试区投递必须落在测试区集合')
    assert.strictEqual(outcome.attempted, 1, '只捞自己环境那一条')
    assert.strictEqual(JSON.stringify([...stores.get(PRODUCTION_EVENTS).values()]), before, '🚨 测试区投递竟然动了正式区的事件')
    assert.strictEqual(stores.get(PRODUCTION_EVENTS).get(prodEvent.eventId).delivered, false, '⛔ 正式区事件不许被测试区的投递标记')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 段 ⑥ 授权按钮：必须由用户点（⛔ 不许自动弹），模板 ID 两份必须一致，**只有 3 个模板**
  // ═══════════════════════════════════════════════════════════════════════════
  await test('⑥-a ⛔ 客户端模板 ID 与云端逐字一致；⛔ 模板**只有 3 个**（多个事件共用一个模板）', async () => {
    const client = require(P('utils/notify-consent'))
    const server = loadDelivery().templates
    assert.deepStrictEqual(Object.keys(client.TEMPLATE_IDS).sort(), Object.keys(server.TEMPLATE_IDS).sort(), '⛔ 两边的模板清单不一致')
    for (const slot of Object.keys(server.TEMPLATE_IDS)) {
      assert.strictEqual(client.TEMPLATE_IDS[slot], server.TEMPLATE_IDS[slot], `⛔ ${slot} 的模板 ID 两边不一致`)
    }
    // ⛔⛔ 用户最终决定：**只要 3 个模板**（不是 5 个）
    assert.strictEqual(Object.keys(server.TEMPLATE_IDS).length, 3, '⛔ 模板必须是 3 个，多一个就是"多个事件各占一个模板"的旧口径回来了')
    // 8 种事件**每一种**都要落到某个模板上（一个都不许漏）
    server.KIND_LIST.forEach(kind => assert.ok(server.slotOf(kind), `⛔ ${kind} 没有映射到任何模板`))
    // ⭐ 6 种状态事件**共用同一个**「课程预约状态通知」
    notify.EVENT_TYPE_LIST.forEach(kind => {
      assert.strictEqual(server.slotOf(kind), 'course-status', `⛔ ${kind} 必须共用「课程预约状态通知」，不该单独占一个模板`)
    })
    // ⭐ 两种课前提醒各自一个模板
    assert.strictEqual(server.slotOf('class-reminder-3h'), 'reminder-3h')
    assert.strictEqual(server.slotOf('class-reminder-1h'), 'reminder-1h')
    // ⛔ notify.js 的 6 个状态事件与模板真源的 6 个状态种类必须**逐字一致**（两处各写一份就会漂移）
    notify.EVENT_TYPE_LIST.forEach(type => assert.ok(server.KIND_LIST.indexOf(type) >= 0, `⛔ notify.js 的 ${type} 在模板真源里不存在`))
    // ⛔ 教练与会员都申请全部 3 个（课前提醒两边都要收）
    assert.deepStrictEqual([...client.TYPES_FOR_COACH].sort(), [...client.ALL_SLOTS].sort(), '⛔ 教练必须一次申请 3 个模板')
    assert.deepStrictEqual([...client.TYPES_FOR_MEMBER].sort(), [...client.ALL_SLOTS].sort(), '⛔ 会员必须一次申请 3 个模板')
  })

  await test('⑥-b 独立设置页撤下；会员端不再弹无效提醒，教练端已可用链路保留', async () => {
    const profile = fs.readFileSync(P('pages/member-profile/member-profile.js'), 'utf8')
    // ⭐ 2026-10-06：旧「会员教练工具（认领）」页面已下线 ⇒ 教练端唯一的通知入口落在**「我的/统计」设置页**。
    const tools = fs.readFileSync(P('pages/stats/stats.js'), 'utf8')
    const profileWxml = fs.readFileSync(P('pages/member-profile/member-profile.wxml'), 'utf8')
    const toolsWxml = fs.readFileSync(P('pages/stats/stats.wxml'), 'utf8')
    assert.ok(!/微信通知设置|openNotifySettings/.test(profileWxml + profile), '⛔ 会员端仍暴露一次性微信通知入口')
    assert.ok(!/微信通知设置|openNotifySettings/.test(toolsWxml + tools), '⛔ 教练端仍暴露一次性微信通知入口')
    const app = JSON.parse(fs.readFileSync(P('app.json'), 'utf8'))
    assert.ok(!app.pages.includes('pages/notify-settings/notify-settings'), '⛔ 通知设置页仍在正式路由')
    // ② 入口在页面里是**方法**，不是 onLoad/onShow 里自动调用
    const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
    for (const [name, code] of [['member-profile', strip(profile)], ['stats', strip(tools)]]) {
      assert.ok(!/requestSubscribeMessage/.test(code), `⛔ ${name}.js 里不许直接调 requestSubscribeMessage（一律走 utils/notify-consent）`)
      assert.ok(!/onLoad[\s\S]{0,400}requestConsent|onShow[\s\S]{0,400}requestConsent/.test(code), `⛔ ${name} 不许在 onLoad/onShow 里自动请求授权`)
    }
    // ③ 五种状态必须都有人话文案（⛔ 少一种就会出现"不知道为什么没开成"）
    const client = require(P('utils/notify-consent'))
    ;['agreed', 'rejected', 'not-configured', 'wechat-denied', 'network-failed'].forEach(status => {
      assert.ok(client.STATUS_TEXT[status], `⛔ 缺少「${status}」这一种状态的人话文案`)
      assert.ok(!/[A-Z_]{6,}/.test(client.STATUS_TEXT[status]), `⛔「${status}」的文案里出现了错误码（不许把英文码显示给用户）`)
    })
    // ④ 没配置模板时必须如实提示
    // ⛔ 真源码里 3 个模板**都已填真 ID** ⇒ 用**内存漂移副本**把三个 ID 清空来造"没配置"这条路
    const blankClient = loadConsent(blankConsentIds)
    assert.strictEqual(blankClient.stateOf('member').configured, false, '⛔ 反证前置：漂移版必须真的处于"没配置"')
    const outcome = await blankClient.requestConsent('member')
    assert.strictEqual(outcome.ok, false, '⛔ 模板没配置 ⇒ 不许回报"已开启"')
    assert.strictEqual(outcome.code, 'TEMPLATE_NOT_CONFIGURED')
    assert.strictEqual(outcome.status, 'not-configured')
    assert.ok(/模板/.test(blankClient.explainOf(outcome)), `必须说清是模板没配置（实测 "${blankClient.explainOf(outcome)}"）`)
    // ✅ 正向：真源码（3 个真 ID 都在）⇒ 状态必须是"已配置"，⛔ 不许还显示"模板没配好"
    assert.strictEqual(client.stateOf('member').configured, true, '⛔ 3 个真实模板 ID 都填了，却还显示"没配置"')
    assert.strictEqual(client.stateOf('coach').configured, true, '⛔ 教练端同样必须显示"已配置"')
    assert.deepStrictEqual(client.tmplIdsFor('member').length, 3, '⛔ 会员端一次必须申请 3 个模板')
    // ⑤ ⛔ 微信回调里只有 `accept` 才算同意（把 `reject` 当成同意 = 假成功）
    assert.strictEqual(client.translate('member', { a: 'reject', b: 'reject', c: 'reject' }).ok, false, '🚨 用户拒绝却算成"已开启"')
    assert.strictEqual(client.translate('member', { a: 'accept', b: 'reject', c: 'reject' }).ok, true, '（前置）至少一个 accept 就算同意')
    assert.strictEqual(client.translate('member', { a: 'ban' }).status, 'wechat-denied', 'ban 必须报「微信不允许」')
    // ⑥ 产品已收口为单教练个人版：不保留独立设置入口；会员端不再打断业务申请无效提醒。
    assert.ok(!/quotaNote|微信通知设置|允许下一条/.test(profileWxml), '⛔ 会员端仍残留一次性订阅入口或额度说明')
    const settingsWxml = fs.readFileSync(P('pages/notify-settings/notify-settings.wxml'), 'utf8')
    assert.ok(/\{\{longTermNote\}\}/.test(settingsWxml), '⛔ 历史设置页仍须保留准确说明，供旧版本兼容与审计')
    assert.ok(!/notify-settings\/notify-settings\?role=coach/.test(tools), '⛔ 教练端仍能进入已经撤下的一次性订阅设置页')
    const commonActions = [
      fs.readFileSync(P('components/booking-modal/booking-modal.js'), 'utf8'),
      fs.readFileSync(P('pages/session/session.js'), 'utf8'),
      fs.readFileSync(P('pages/member-book-slots/member-book-slots.js'), 'utf8'),
      fs.readFileSync(P('pages/member-bookings/member-bookings.js'), 'utf8'),
      fs.readFileSync(P('pages/member-claim/member-claim.js'), 'utf8')
    ].join('\n')
    assert.ok(/requestNextAfterAction\('coach'/.test(commonActions), '⛔ 教练常用动作没有申请下一条提醒')
    assert.ok(!/requestNextAfterAction\('member'|requestConsent\('member'/.test(commonActions), '⛔ 会员常用动作仍会申请无效提醒')
    assert.ok(!/await\s+notifyConsent\.requestNextAfterAction/.test(commonActions), '⛔ 通知授权等待结果，可能卡住业务')
    assert.ok(/一次同意只够/.test(client.LONG_TERM_NOTE), '⛔ LONG_TERM_NOTE 必须写明"一次同意只够一条"')
    assert.ok(!/一直|永久|长期有效|终身/.test(client.LONG_TERM_NOTE), '⛔ 长期说明里不许暗示一次同意永久有效')
    // ⛔ 2026-10-05 用户逐条指定的口径，一句都不许少：
    //    ① 一个模板同意一次只够发一条（不许暗示"开一次以后一直能收"）
    //    ② 教练与会员分别授权
    //    ③ 状态通知发过一次后，下次预约/取消/改期要重新授权
    //    ④ 3h / 1h 各消耗自己那个模板的一次授权
    assert.ok(/一个模板同意一次/.test(client.QUOTA_NOTE), '⛔ 额度说明必须写明"一个模板同意一次，只够发一条"')
    assert.ok(/只够发一条|只够发送一次/.test(client.QUOTA_NOTE), '⛔ 必须写明一次同意只够一条')
    assert.ok(/分别/.test(client.QUOTA_NOTE), '⛔ 必须写明教练和会员要分别授权')
    assert.ok(/重新允许|重新点一次/.test(client.QUOTA_NOTE), '⛔ 必须写明下次变动要重新授权')
    assert.ok(/3 ?小时/.test(client.QUOTA_NOTE) && /1 ?小时/.test(client.QUOTA_NOTE), '⛔ 必须写明 3 小时与 1 小时各算各的')
    // ⛔ 反面：不许出现"以后一直""永久""长期""一直能收到"这类话
    assert.ok(!/一直|永久|长期|终身/.test(client.QUOTA_NOTE), `⛔ 额度说明里不许暗示"一次同意永久有效"：${client.QUOTA_NOTE}`)
    // ⛔ 次数用完必须说"需要重新允许课程提醒"
    assert.ok(client.NEED_REAUTHORIZE_TEXT.indexOf('重新') >= 0 && client.NEED_REAUTHORIZE_TEXT.indexOf('开启课程提醒') >= 0,
      '⛔ 次数用完后必须提示"需要重新点一次「开启课程提醒」"')
    assert.ok(client.STATUS_TEXT['quota-exhausted'], '⛔ 必须有一种"额度用完"的状态文案')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 段 ⑦ 判别力：上面每条判据都必须**真的抓得住**（⛔ 内存漂移，磁盘零改动）
  // ═══════════════════════════════════════════════════════════════════════════
  await test('⑦-a ⛔ 判别力一：把"缺模板也回报成功"的漂移必须被 ① 抓住', async () => {
    const source = fs.readFileSync(P(DELIVERY + '.js'), 'utf8')
    const drifted = source.replace(
      "  if (!templateId) return { eventId, ok: false, code: 'TEMPLATE_NOT_CONFIGURED', sent: false, retryable: true }",
      "  if (!templateId) { await notify.markDelivered(db, environment, eventId, CHANNEL, now); return { eventId, ok: true, sent: true, code: 'SENT' } }"
    )
    assert.notStrictEqual(drifted, source, '⛔ 漂移脚本自身失效：模板闸的锚点没命中')
    const delivery = loadDelivery(DELIVERY, drifted)
    const driftEvent = makeEvent()
    const { db } = createDb({ [SANDBOX_EVENTS]: { [driftEvent.eventId]: driftEvent } })
    let sendCalls = 0
    const result = await delivery.deliverEvent({ db, environment: 'sandbox', event: driftEvent, now: 1, send: async () => { sendCalls += 1 }, openIdFor: async () => 'x' })
    // ⛔ 反证自身失效检查：漂移版必须**真的**变成了"成功"
    assert.strictEqual(result.ok, true, '⛔ 反证自身失效：漂移版竟然还是失败（那红得没意义）')
    let red = false
    try {
      assert.strictEqual(result.code, 'TEMPLATE_NOT_CONFIGURED', '🚨 没有模板却回报成功')
      assert.strictEqual(sendCalls, 0, '🚨 没有模板竟然还调了发送接口')
    } catch (error) { red = true }
    assert.ok(red, '⛔ 判据① 抓不住"缺模板也假装发送"这种回归 —— 那这条判据就是测空气')
  })

  await test('⑦-b ⛔ 判别力二：撤销「只通知另一方」那道闸必须被 ② 抓住', async () => {
    const delivery = loadDeliveryWithTemplates(
      withStatusTemplate('T'),
      // ⛔ 漂移点在 **subscribe-delivery.js**（`isSelfAction` 那道闸住在那里，不在模板真源里）
      src => src.replace("  if (isSelfAction(event)) return { eventId, ok: false, code: 'SELF_ACTION_SKIPPED', sent: false }", "  // drifted: 不再判断是不是自己")
    )
    const selfEvent = makeEvent({ actor: { kind: 'member', memberId: 'm-1' }, recipient: { kind: 'member', memberId: 'm-1' } })
    const { db } = createDb({ [SANDBOX_EVENTS]: { [selfEvent.eventId]: selfEvent } })
    let sendCalls = 0
    const result = await delivery.deliverEvent({
      db, environment: 'sandbox', now: 1, send: async () => { sendCalls += 1 }, openIdFor: async () => 'openid-self', event: selfEvent
    })
    assert.strictEqual(sendCalls, 1, '⛔ 反证自身失效：漂移版竟然没发出去（那红得没意义）')
    let red = false
    try {
      assert.strictEqual(result.ok, false, '🚨 自己改自己的课却给自己发了提醒')
      assert.strictEqual(result.code, 'SELF_ACTION_SKIPPED')
    } catch (error) { red = true }
    assert.ok(red, '⛔ 判据② 抓不住"撤销自我通知闸"这种回归')
  })

  await test('⑦-c ⛔ 判别力三：发送成功后不标记 delivered（重复发）必须被 ③ 抓住', async () => {
    const source = fs.readFileSync(P(DELIVERY + '.js'), 'utf8')
    const drifted = source.replace('  await notify.markDelivered(db, environment, eventId, CHANNEL, now)', '  // drifted: 忘了标记已投递（下次还会再发一次）')
    assert.notStrictEqual(drifted, source, '⛔ 漂移脚本自身失效：markDelivered 的锚点没命中')
    const tplPath = require.resolve(P(TEMPLATES + '.js'))
    const stub = new Module(tplPath, null)
    stub.filename = tplPath
    stub.paths = Module._nodeModulePaths(path.dirname(tplPath))
    stub._compile(withStatusTemplate('T')(fs.readFileSync(tplPath, 'utf8')), tplPath)
    const saved = require.cache[tplPath]
    require.cache[tplPath] = stub
    let delivery
    try { delivery = loadDelivery(DELIVERY, drifted) } finally { if (saved) require.cache[tplPath] = saved; else delete require.cache[tplPath] }
    const event = makeEvent()
    const { db } = createDb({ [SANDBOX_EVENTS]: { [event.eventId]: event } })
    let sendCalls = 0
    await delivery.deliverEvent({ db, environment: 'sandbox', event, now: 1, send: async () => { sendCalls += 1 }, openIdFor: async () => 'x' })
    const again = await delivery.deliverEvent({ db, environment: 'sandbox', event, now: 2, send: async () => { sendCalls += 1 }, openIdFor: async () => 'x' })
    assert.strictEqual(again.sent, true, '⛔ 反证自身失效：漂移版第二次竟然没发（那红得没意义）')
    assert.strictEqual(sendCalls, 2, '⛔ 反证自身失效：漂移版只发了一次')
    let red = false
    try { assert.strictEqual(sendCalls, 1, '🚨 同一条事件发了第二次') } catch (error) { red = true }
    assert.ok(red, '⛔ 判据③ 抓不住"发了不标记 ⇒ 重复提醒"这种回归')
  })

  await test('⑦-d ⛔ 判别力四：把「课前提醒」也塞进状态模板（模板变回按事件拆）必须被 ⑥-a 抓住', async () => {
    const drifted = loadDeliveryWithTemplates(source => source.replace(
      `[KINDS.REMINDER_3H]: TEMPLATE_SLOTS.REMINDER_3H`,
      `[KINDS.REMINDER_3H]: TEMPLATE_SLOTS.COURSE_STATUS`
    ))
    assert.strictEqual(drifted.templates.slotOf('class-reminder-3h'), 'course-status', '⛔ 反证自身失效：漂移没生效')
    let red = false
    try {
      assert.strictEqual(drifted.templates.slotOf('class-reminder-3h'), 'reminder-3h', '🚨 3 小时提醒必须用自己的模板')
    } catch (error) { red = true }
    assert.ok(red, '⛔ 判据⑥-a 抓不住"提醒也挤进状态模板"这种回归 —— 那"3 个模板"就只是嘴上说说')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 段 ⑧ 契约：四份副本必须逐字节相同（两个业务云函数 + 两个定时提醒云函数）
  // ═══════════════════════════════════════════════════════════════════════════
  await test('⑧ ⛔ 投递层 / 适配器 / 模板真源的两份（正式区 ↔ 测试区）副本逐字节相同', async () => {
    for (const file of ['subscribe-delivery', 'notify-adapter', 'notify-templates']) {
      const a = fs.readFileSync(P(`cloudfunctions/coachBusinessCommand/${file}.js`), 'utf8')
      const b = fs.readFileSync(P(`cloudfunctions/coachBusinessSandboxCommand/${file}.js`), 'utf8')
      assert.strictEqual(a, b, `⛔ ${file}.js 的两份副本必须完全相同`)
    }
  })

  await test('⑨ ⛔ 模板真源的**四份**副本（业务 ×2 + 定时提醒 ×2）逐字节相同', async () => {
    const a = fs.readFileSync(P('cloudfunctions/coachBusinessCommand/notify-templates.js'), 'utf8')
    ;['coachBusinessSandboxCommand', 'classReminderScheduler', 'classReminderSandboxScheduler'].forEach(dir => {
      const b = fs.readFileSync(P(`cloudfunctions/${dir}/notify-templates.js`), 'utf8')
      assert.strictEqual(b, a, `⛔ cloudfunctions/${dir}/notify-templates.js 与正式区不一致 —— 改了一处必须四处同步`)
    })
  })

  await test('⑩ ⛔ 提醒核心的两份副本逐字节相同（定时云函数按目录独立部署，跨目录 require 取不到）', async () => {
    const a = fs.readFileSync(P('cloudfunctions/classReminderScheduler/reminder-core.js'), 'utf8')
    const b = fs.readFileSync(P('cloudfunctions/classReminderSandboxScheduler/reminder-core.js'), 'utf8')
    assert.strictEqual(b, a, '⛔ 提醒核心两份副本必须完全相同')
    // ⛔ 定时云函数必须自带 wxacode / 订阅消息权限声明，否则部署后一律 -604101
    const cfg = JSON.parse(fs.readFileSync(P('cloudfunctions/classReminderScheduler/config.json'), 'utf8'))
    assert.ok((cfg.permissions && cfg.permissions.openapi || []).indexOf('subscribeMessage.send') >= 0, '⛔ 定时提醒云函数没有声明 subscribeMessage.send 权限')
    assert.ok((cfg.triggers || []).some(t => t.type === 'timer' && t.config === '0 */5 * * * * *'), '⛔ 定时器必须声明为每 5 分钟一次')
  })

  console.log(results.join('\n'))
  const failed = results.filter(r => r.startsWith('FAIL')).length
  console.log(`\n微信订阅消息投递：${results.length - failed} PASS / ${failed} FAIL（共 ${results.length} 条）`)
  if (failed) { console.error('MEMBER NOTIFY SUBSCRIBE: 有失败段（见上面 FAIL 行）'); return }
  console.log('MEMBER NOTIFY SUBSCRIBE: ALL PASS')
}

main().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 })
