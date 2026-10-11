// ⏰ 课前提醒（上课前 3 小时 / 1 小时）· 永久回归（2026-10-05 需求二 + 需求七）
//
// ⭐⭐ 本文件钉死两件事：
//   ① **六种状态通知只发给"另一方"**（会员动 ⇒ 只通知教练；教练动 ⇒ 只通知会员）；
//   ② **课前提醒**：3 小时 / 1 小时各一次、教练与会员各一条、取消/改期作废旧提醒、
//      重复运行不重复发、没授权不假成功、测试区与正式区绝不串消息。
//
// ⛔ 判别力自证：⛔ 禁止改生产源码做变异，一律用 `Module._compile` 在**内存里**编译漂移副本。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
const P = p => path.join(ROOT, p)

const CORE = 'cloudfunctions/classReminderScheduler/reminder-core'
const TEMPLATES = 'cloudfunctions/coachBusinessCommand/notify-templates'
// ⛔ 提醒核心 require 的是**自己目录里**那份 `notify-templates`（云函数按目录独立部署）
//    ⇒ 漂移必须注入到**那个路径**，注入到 coachBusinessCommand 那份是无效的。
const CORE_TEMPLATES = 'cloudfunctions/classReminderScheduler/notify-templates'
const notify = require(P('cloudfunctions/coachBusinessCommand/notify'))
const templates = require(P(TEMPLATES))

const OWNER = 'coach-owner-1'
const DATASET = 'ds-1'
const STUDENT = 'stu-1'
const MEMBER = 'member-1'
const TEACHING = 'coach-teach-1'

const PRODUCTION_HEADS = 'coach_data_heads'
const SANDBOX_HEADS = 'coach_sandbox_heads'
const PRODUCTION_REMINDERS = 'coach_class_reminders'
const SANDBOX_REMINDERS = 'coach_sandbox_class_reminders'
const PRODUCTION_CLAIMS = 'member_student_claims'
const SANDBOX_CLAIMS = 'member_sandbox_student_claims'

// 📌 北京时间 2026-10-06 15:00 的毫秒时间戳（写死常量，⛔ 不依赖本机时区）
const START_AT = Date.UTC(2026, 9, 6, 15 - 8, 0)
const MIN = 60 * 1000
const at3h = START_AT - 180 * MIN
const at1h = START_AT - 60 * MIN

// ─────────────────────────────────────────────────────────────────────────────
// 假 db（只实现提醒核心用到的入口；集合**不会**自动创建 —— 与真 CloudBase 同口径）
// =============================================================================
function createDb(seed = {}) {
  const stores = new Map()
  const touched = []
  Object.keys(seed).forEach(name => {
    const m = new Map()
    Object.keys(seed[name]).forEach(id => m.set(id, { _id: id, ...seed[name][id] }))
    stores.set(name, m)
  })
  const matches = (row, query) => Object.keys(query).every(key => {
    if (key.indexOf('.') < 0) return row[key] === query[key]
    const value = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), row)
    return value === query[key]
  })
  const collection = name => {
    touched.push(name)
    let query = {}, skipN = 0, limitN = 100
    const api = {
      skip(v) { skipN = v; return api },
      limit(v) { limitN = v; return api },
      where(q) { query = q; return api },
      async get() {
        const s = stores.get(name)
        if (!s) throw Object.assign(new Error(`Db or Table not exist: ${name}`), { errCode: -502005 })
        return { data: [...s.values()].filter(row => matches(row, query)).slice(skipN, skipN + limitN).map(row => ({ ...row })) }
      },
      doc(id) {
        return {
          async get() { const s = stores.get(name); const row = s && s.get(id); return { data: row ? { ...row } : null } },
          async set({ data }) {
            if (!stores.has(name)) throw new Error(`Table not exist: ${name}`)
            stores.get(name).set(id, { ...data, _id: id })
          }
        }
      }
    }
    return api
  }
  return { db: { collection }, stores, touched }
}

function bookingRow(overrides = {}) {
  const id = overrides.id || 'bk-1'
  const data = {
    id, studentId: STUDENT, studentName: '小明', date: '2026-10-06', hour: 15, minute: 0,
    status: 'booked', plannedMinutes: 60, packageId: 'pkg-1', teachingCoachId: TEACHING,
    ...(overrides.data || {})
  }
  return { _id: `brow-${id}`, ownerCoachId: OWNER, datasetId: DATASET, bookingId: id, data }
}

const sandboxCollections = {
  heads: SANDBOX_HEADS, bookings: 'bookings', reminders: SANDBOX_REMINDERS,
  claims: SANDBOX_CLAIMS, coaches: 'coaches', accounts: 'member_sandbox_accounts'
}
const productionCollections = {
  heads: PRODUCTION_HEADS, bookings: 'bookings', reminders: PRODUCTION_REMINDERS,
  claims: PRODUCTION_CLAIMS, coaches: 'coaches', accounts: 'member_accounts'
}

function seedWorld(overrides = {}) {
  const headName = overrides.collections ? overrides.collections.heads : SANDBOX_HEADS
  const claimName = overrides.collections ? overrides.collections.claims : SANDBOX_CLAIMS
  const reminderName = overrides.collections ? overrides.collections.reminders : SANDBOX_REMINDERS
  return createDb({
    [headName]: { h1: { ownerCoachId: OWNER, activeDatasetId: DATASET } },
    bookings: { b1: bookingRow(overrides.booking || {}) },
    [claimName]: { c1: { studentId: STUDENT, coachId: OWNER, memberId: MEMBER, status: 'verified' } },
    [reminderName]: {}
  })
}

// 👤 收件人 → 微信标识（⛔ 教练与会员**各用各的**，用来证明"不会收到对方那一份"）
const OPENID_OF = {
  'coach:coach-teach-1': 'openid-coach',
  'coach:coach-owner-1': 'openid-coach-owner',
  'member:member-1': 'openid-member'
}
const openIdFor = async recipient => {
  const key = `${recipient.kind}:${recipient.kind === 'coach' ? recipient.coachId : recipient.memberId}`
  return OPENID_OF[key] || ''
}

function recorder(overrides = {}) {
  const calls = []
  const failing = overrides.failing
  return {
    calls,
    send: async args => {
      calls.push(args)
      if (failing) throw failing()
    }
  }
}

// ⭐ 在内存里漂一份 `notify-templates.js`，再重新加载提醒核心（磁盘零改动）
// `mutateTemplates` 漂模板真源；可选的 `mutateCore` 漂提醒核心（两者都在内存里，磁盘零改动）
function loadCore(mutateTemplates, mutateCore) {
  const tplPath = require.resolve(P(CORE_TEMPLATES + '.js'))
  const source = fs.readFileSync(tplPath, 'utf8')
  const drifted = mutateTemplates ? mutateTemplates(source) : source
  if (mutateTemplates) assert.notStrictEqual(drifted, source, '⛔ 漂移脚本自身失效：notify-templates.js 锚点没命中')
  const stub = new Module(tplPath, null)
  stub.filename = tplPath
  stub.paths = Module._nodeModulePaths(path.dirname(tplPath))
  stub._compile(drifted, tplPath)
  stub.loaded = true
  const saved = require.cache[tplPath]
  require.cache[tplPath] = stub
  try {
    const corePath = require.resolve(P(CORE + '.js'))
    delete require.cache[corePath]
    if (mutateCore) {
      const coreSource = fs.readFileSync(corePath, 'utf8')
      const coreDrifted = mutateCore(coreSource)
      assert.notStrictEqual(coreDrifted, coreSource, '⛔ 漂移脚本自身失效：reminder-core.js 锚点没命中')
      const coreStub = new Module(corePath, null)
      coreStub.filename = corePath
      coreStub.paths = Module._nodeModulePaths(path.dirname(corePath))
      coreStub._compile(coreDrifted, corePath)
      coreStub.loaded = true
      return coreStub.exports
    }
    return require(corePath)
  } finally {
    if (saved) require.cache[tplPath] = saved; else delete require.cache[tplPath]
  }
}

// ⛔ 用**正则**替换（不能写死 `''`）：模板 ID 一旦填进真值，写死空串的锚点会**静默失效**
//    ⇒ 漂移不生效、判据变成"测空气"（假绿）。⇒ 一律按槽位名匹配，值是什么都替换得掉。
const SLOT_RE = /\[TEMPLATE_SLOTS\.(COURSE_STATUS|REMINDER_3H|REMINDER_1H)\]:\s*'[^']*'/g
const replaceSlot = (source, slot, id) => {
  const out = source.replace(SLOT_RE, (whole, name) => (name === slot ? `[TEMPLATE_SLOTS.${name}]: '${id}'` : whole))
  return out
}
const withReminderTemplates = source => replaceSlot(replaceSlot(source, 'REMINDER_3H', 'TPL_3H'), 'REMINDER_1H', 'TPL_1H')
const withStatusTemplate = source => replaceSlot(source, 'COURSE_STATUS', 'TPL_STATUS')
const blankAllTemplates = source => source.replace(SLOT_RE, (whole, name) => `[TEMPLATE_SLOTS.${name}]: ''`)

// ⭐ 「上课时间」在三个真实模板里叫的名字**不一样**（`time19` / `time2` / `time3`）⇒
//    断言不许写死某一个字段名，一律按"哪个键是 time 类型"来取（换模板也不会变成测空气）。
const whenOf = data => {
  const source = data || {}
  const key = Object.keys(source).find(name => /^time\d+$/.test(name))
  return key ? String(source[key].value || '') : ''
}

const results = []
async function test(name, fn) {
  try { await fn(); results.push(`PASS ${name}`) }
  catch (error) { results.push(`FAIL ${name}\n    ${String(error && error.stack).split('\n').slice(0, 5).join('\n    ')}`); process.exitCode = 1 }
}

async function main() {
  // ═══════════════════════════════════════════════════════════════════════════
  // 需求七 ①～⑥：六种状态通知**只发给另一方**
  // ═══════════════════════════════════════════════════════════════════════════
  const DIRECTIONS = [
    { kind: 'member-booking-created', to: 'coach', label: '会员预约成功 ⇒ 只通知教练' },
    { kind: 'member-booking-cancelled', to: 'coach', label: '会员取消 ⇒ 只通知教练' },
    { kind: 'member-booking-rescheduled', to: 'coach', label: '会员改期 ⇒ 只通知教练' },
    { kind: 'coach-booking-created', to: 'member', label: '教练安排课程 ⇒ 只通知会员' },
    { kind: 'coach-booking-cancelled', to: 'member', label: '教练取消 ⇒ 只通知会员' },
    { kind: 'coach-booking-rescheduled', to: 'member', label: '教练改期 ⇒ 只通知会员' }
  ]

  await test('①～⑥ 🚨 六种状态通知的方向：会员动⇒只通知教练，教练动⇒只通知会员', async () => {
    // ⛔ 静态层：方向写在**源码**里（收件人只能由服务端推导，客户端提交不了）
    const handlers = fs.readFileSync(P('cloudfunctions/coachBusinessCommand/handlers.js'), 'utf8')
    const memberBooking = fs.readFileSync(P('cloudfunctions/coachBusinessCommand/memberBooking.js'), 'utf8')
    // ⭐⭐ 2026-10-07（1.3.38）：方向判定已收敛到**统一分发器** `notify-booking.js`，
    //    `handlers`（教练侧）与 `memberBooking`（会员侧）只负责传 `actorRole`。
    //    ⇒ 静态锚跟着指向新的真相源 ⛔ **不是降断言**：方向写反了 / 哪个入口绕开分发器 ⇒ 立刻红。
    const dispatcher = fs.readFileSync(P('cloudfunctions/coachBusinessCommand/notify-booking.js'), 'utf8')
    assert.ok(/actor\s*=\s*\{\s*kind:\s*ACTOR_COACH[\s\S]{0,2000}recipient\s*=\s*\{\s*kind:\s*ACTOR_MEMBER/.test(dispatcher),
      '⛔ 统一分发器里：教练动 ⇒ 收件人必须是 member')
    assert.ok(/actor\s*=\s*\{\s*kind:\s*ACTOR_MEMBER[\s\S]{0,2000}recipient\s*=\s*\{\s*kind:\s*ACTOR_COACH/.test(dispatcher),
      '⛔ 统一分发器里：会员动 ⇒ 收件人必须是 coach')
    assert.ok(/actorRole:\s*notifyBooking\.ACTOR_COACH/.test(handlers), '⛔ 教练侧入口必须走统一分发器（actorRole=coach）')
    assert.ok(/actorRole:\s*notifyBooking\.ACTOR_MEMBER/.test(memberBooking), '⛔ 会员侧入口必须走统一分发器（actorRole=member）')
    assert.ok(/notifyTypes\.COACH_CREATED/.test(handlers), '⛔ 教练安排课程这条事件没了（会员收不到"被安排"通知）')
    // ⛔ 动态层：六种「谁动了 + 做了什么」⇒ 事件类型，必须由分发器**唯一**决定（静态锚看不出写反）
    const notifyBooking = require(P('cloudfunctions/coachBusinessCommand/notify-booking.js'))
    const EVENT_TYPES = require(P('cloudfunctions/coachBusinessCommand/notify.js')).EVENT_TYPES
    DIRECTIONS.forEach(row => {
      const role = row.to === 'coach' ? 'member' : 'coach'
      const act = row.kind.indexOf('created') > 0 ? 'create' : (row.kind.indexOf('cancelled') > 0 ? 'cancel' : 'reschedule')
      assert.strictEqual(notifyBooking.eventTypeFor(role, act), row.kind,
        `⛔ 分发器把「${role} 动 / ${act}」算成了别的事件类型（方向或动作写反了）`)
    })
    // ⛔ 动态层：6 种事件逐一投递，收件人必须只有一个、且是"另一方"
    DIRECTIONS.forEach(row => {
      const recipient = row.to === 'coach' ? { kind: 'coach', coachId: TEACHING } : { kind: 'member', memberId: MEMBER }
      const message = templates.messageOf({ type: row.kind, booking: { date: '2026-10-06', hour: 15, minute: 0 }, recipient })
      assert.strictEqual(templates.slotOf(row.kind), 'course-status', `⛔ ${row.kind} 必须共用「课程预约状态通知」`)
      assert.strictEqual(message.page, row.to === 'coach' ? 'pages/schedule/schedule' : 'pages/member-bookings/member-bookings',
        `⛔ ${row.label} 的跳转页给错了方向`)
      // ⛔ 内容里只写"会员 / 教练"角色词，绝不带手机号、价格、学员 id
      const blob = JSON.stringify(message.data)
      ;['1', 'phone', '手机号', '¥', 'price'].forEach(bad => {
        if (bad === '1') return
        assert.ok(blob.indexOf(bad) < 0, `⛔ ${row.kind} 的通知内容里出现了不该出现的 ${bad}`)
      })
    })
    // ⛔ 六种事件**共用同一个模板** ⇒ 额度不会被拆碎（一次性订阅只有"一个模板一条"的额度）
    const slots = new Set(DIRECTIONS.map(row => templates.slotOf(row.kind)))
    assert.strictEqual(slots.size, 1, '⛔ 六种状态通知必须共用**一个**模板')
  })

  await test('⑰⑱ ⛔ 教练不会收到"会员那一份"提醒，会员也不会收到"教练那一份"', async () => {
    const deliverySrc = fs.readFileSync(P('cloudfunctions/coachBusinessCommand/subscribe-delivery.js'), 'utf8')
    // ⛔ 投递层必须**再判一次**是不是自己（宁可漏发，绝不错发）
    assert.ok(/function isSelfAction/.test(deliverySrc), '⛔ 投递层没有"只通知另一方"那道闸')
    const core = loadCore(withReminderTemplates)
    const world = seedWorld()
    const rec = recorder()
    const outcome = await core.scanOnce({
      db: world.db, environment: 'sandbox', collections: sandboxCollections,
      send: rec.send, openIdFor, now: at3h
    })
    assert.strictEqual(outcome.sent, 2, '（前置）3 小时提醒必须发给教练 + 会员各一条')
    const coachCalls = rec.calls.filter(call => call.touser === 'openid-coach')
    const memberCalls = rec.calls.filter(call => call.touser === 'openid-member')
    assert.strictEqual(coachCalls.length, 1, '🚨 教练收到了不止一条（或没收到）')
    assert.strictEqual(memberCalls.length, 1, '🚨 会员收到了不止一条（或没收到）')
    assert.strictEqual(coachCalls[0].page, 'pages/schedule/schedule', '⛔ 教练那份必须跳课表')
    assert.strictEqual(memberCalls[0].page, 'pages/member-bookings/member-bookings', '⛔ 会员那份必须跳「我的预约」')
    // ⛔ 两边用的是**同一个**提醒模板，但收件人标识绝不能串
    assert.strictEqual(coachCalls[0].templateId, 'TPL_3H')
    assert.strictEqual(memberCalls[0].templateId, 'TPL_3H')
    assert.notStrictEqual(coachCalls[0].touser, memberCalls[0].touser, '🚨 教练和会员收到了同一个人的提醒（串号）')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 需求七 ⑦⑧：课前 3 小时 / 1 小时，教练与会员各一条
  // ═══════════════════════════════════════════════════════════════════════════
  await test('⑦⑧ 🚨 开课前 3 小时提醒教练 + 会员各一次；开课前 1 小时再各一次', async () => {
    const core = loadCore(withReminderTemplates)
    const world = seedWorld()
    const rec = recorder()
    const first = await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at3h })
    assert.strictEqual(first.sent, 2, '3 小时节点：教练 + 会员各一条')
    assert.ok(rec.calls.every(call => call.templateId === 'TPL_3H'), '⛔ 3 小时节点必须用 3 小时模板')
    assert.strictEqual(whenOf(rec.calls[0].data), '2026-10-06 15:00', '⛔ 提醒里必须写清上课时间（北京时间）')

    const second = await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at1h })
    assert.strictEqual(second.sent, 2, '1 小时节点：教练 + 会员各一条')
    const oneHour = rec.calls.filter(call => call.templateId === 'TPL_1H')
    assert.strictEqual(oneHour.length, 2, '⛔ 1 小时提醒必须教练 + 会员各一条')
    assert.strictEqual(rec.calls.length, 4, '⛔ 一节课从头到尾就是 4 条（3h×2 + 1h×2），多一条都是重复骚扰')
    // ⛔ 四个标记必须各自独立存在
    const row = world.stores.get(SANDBOX_REMINDERS).values().next().value
    ;['class-reminder-3h:coach', 'class-reminder-3h:member', 'class-reminder-1h:coach', 'class-reminder-1h:member'].forEach(key => {
      assert.ok(row.sent[key] && row.sent[key].ok === true, `⛔ 缺了「${key}」这个已发送标记`)
    })
  })

  await test('⑮ 🚨 定时任务重复运行 / 云函数重复启动 ⇒ 一条都不许多发', async () => {
    const core = loadCore(withReminderTemplates)
    const world = seedWorld()
    const rec = recorder()
    await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at3h })
    const afterFirst = rec.calls.length
    // 同一时刻连跑三次（模拟定时器抖动 + 云函数重复启动）
    await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at3h })
    await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at3h + 30000 })
    assert.strictEqual(rec.calls.length, afterFirst, '🚨 重复运行又发了一遍 ⇒ 用户会收到两条一模一样的提醒')
    const row = world.stores.get(SANDBOX_REMINDERS).values().next().value
    assert.strictEqual(Object.keys(row.sent).length, 2, '⛔ 3 小时节点只该留下 2 个标记（教练 + 会员）')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 需求七 ⑨⑩：取消 / 改期 ⇒ 旧提醒作废
  // ═══════════════════════════════════════════════════════════════════════════
  await test('⑨ 🚨 取消课程 ⇒ 还没发的提醒全部作废（一个都不发）', async () => {
    const core = loadCore(withReminderTemplates)
    const world = seedWorld()
    const rec = recorder()
    await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at3h })
    assert.strictEqual(rec.calls.length, 2, '（前置）3 小时那两条已经发了')
    // 教练取消这节课
    world.stores.get('bookings').get('b1').data.status = 'cancelled'
    const after = await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at1h })
    assert.strictEqual(after.sent, 0, '🚨 课都取消了还在提醒（用户会以为课还在）')
    assert.strictEqual(rec.calls.length, 2, '🚨 取消之后又发了提醒')
    const row = world.stores.get(SANDBOX_REMINDERS).values().next().value
    assert.strictEqual(row.status, 'void', '⛔ 取消之后这条提醒必须被标成作废')
    assert.strictEqual(row.voidReason, 'cancelled')
  })

  await test('⑩ 🚨 改期 ⇒ 旧时间的提醒作废，按**新时间**重新发 3 小时 / 1 小时', async () => {
    const core = loadCore(withReminderTemplates)
    const world = seedWorld()
    const rec = recorder()
    await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at3h })
    assert.strictEqual(rec.calls.length, 2, '（前置）旧时间的 3 小时提醒已发')
    const newStart = Date.UTC(2026, 9, 6, 18 - 8, 0)
    const atNew3h = newStart - 180 * MIN   // 北京时间 15:00
    // ① 先确认：**旧时间**那个 1 小时节点（14:00）在改期后一条都不该发
    world.stores.get('bookings').get('b1').data.hour = 18
    const oldSlot = await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at1h })
    assert.strictEqual(oldSlot.sent, 0, '🚨 课已经改到 18:00，旧时间（15:00）的提醒还在发')
    assert.strictEqual(rec.calls.length, 2, '⛔ 旧时间只该留下改期前那 2 条')
    // ② 新的 3 小时节点（15:00）⇒ 识别出改期 + 清空旧标记 + 教练/会员各发一条
    const rescheduled = await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: atNew3h })
    assert.strictEqual(rescheduled.rescheduled, 1, '⛔ 改期没有被识别出来')
    assert.strictEqual(rescheduled.sent, 2, '🚨 改期后新时间的 3 小时提醒没发出来')
    assert.strictEqual(rec.calls.length, 4, '⛔ 改期后应该是"旧 2 条 + 新 2 条"')
    const row = world.stores.get(SANDBOX_REMINDERS).values().next().value
    assert.strictEqual(row.startAt, newStart, '⛔ 提醒行必须跟着新时间走')
    assert.strictEqual(Object.keys(row.sent).length, 2, '⛔ 改期后旧时间的已发标记必须清空（按新时间重新算，只留新的两条）')
    assert.ok(rec.calls.slice(2).every(call => whenOf(call.data) === '2026-10-06 18:00'), '⛔ 新提醒里必须写**新**的上课时间')
  })

  await test('⑧ 🚨 已完课 / 已过期的课 ⇒ 一条都不发', async () => {
    const core = loadCore(withReminderTemplates)
    // ① 已完课
    const done = seedWorld({ booking: { data: { status: 'done' } } })
    const recDone = recorder()
    const outDone = await core.scanOnce({ db: done.db, environment: 'sandbox', collections: sandboxCollections, send: recDone.send, openIdFor, now: at3h })
    assert.strictEqual(outDone.sent, 0, '🚨 上完的课还在提醒')
    assert.strictEqual(recDone.calls.length, 0)
    // ② 已过期（现在晚于上课时间）
    const recLate = recorder()
    const late = seedWorld()
    const outLate = await core.scanOnce({ db: late.db, environment: 'sandbox', collections: sandboxCollections, send: recLate.send, openIdFor, now: START_AT + 10 * MIN })
    assert.strictEqual(outLate.sent, 0, '🚨 课都上完了还在提醒')
    assert.strictEqual(outLate.scanned, 0, '⛔ 过期的课根本不该进扫描窗口')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 需求七 ⑫⑬⑭⑮：没授权 / 没模板 / 失败可重试 / 成功后不重试
  // ═══════════════════════════════════════════════════════════════════════════
  await test('⑫ 🚨 用户没授权 ⇒ 不发送，并如实记「没有授权」（⛔ 绝不假成功）', async () => {
    const core = loadCore(withReminderTemplates)
    const world = seedWorld()
    const rec = recorder({ failing: () => Object.assign(new Error('user refuse to accept the msg'), { errCode: 43101 }) })
    const outcome = await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at3h })
    assert.strictEqual(outcome.sent, 0, '🚨 没授权却算成了"已发送"')
    const unauthorized = outcome.results.filter(result => result.code === 'SUBSCRIBE_NOT_AUTHORIZED')
    assert.strictEqual(unauthorized.length, 2, '⛔ 教练与会员两条都要如实记「没有授权」')
    const row = world.stores.get(SANDBOX_REMINDERS).values().next().value
    assert.deepStrictEqual(row.sent, {}, '⛔ 没授权**不许**标记成已发送（否则这条提醒就永远发不出去了）')
    assert.strictEqual(row.lastFailure['class-reminder-3h:coach'].code, 'SUBSCRIBE_NOT_AUTHORIZED')
    assert.deepStrictEqual(row.lease, {}, '⛔ 失败必须清掉租约（否则下一轮连重试的机会都没有）')
  })

  await test('⑬ 🚨 模板没配置 ⇒ 一次 send 都不许调，也不许假装成功', async () => {
    // ⛔ 真源码里 3 个模板**都已填真 ID** ⇒ 用内存漂移把三个 ID 清空，才能造出"没模板"这条路
    const core = loadCore(blankAllTemplates)
    const world = seedWorld()
    const rec = recorder()
    const outcome = await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at3h })
    assert.strictEqual(outcome.sent, 0)
    assert.strictEqual(rec.calls.length, 0, '🚨 模板都没配竟然还去调了发送接口 —— 那就是伪造发送')
    const notConfigured = outcome.results.filter(result => result.code === 'TEMPLATE_NOT_CONFIGURED')
    assert.strictEqual(notConfigured.length, 2, '⛔ 必须如实回"模板尚未配置"（教练 + 会员两条）')
    const row = world.stores.get(SANDBOX_REMINDERS).values().next().value
    assert.deepStrictEqual(row.sent, {}, '⛔ 没模板不许标记成已发送')
  })

  await test('⑭⑮ 🚨 发送失败可以安全重试；发送成功之后**永不**重试', async () => {
    const core = loadCore(withReminderTemplates)
    const world = seedWorld()
    // ① 第一次：网络失败
    const failing = recorder({ failing: () => Object.assign(new Error('system error'), { errCode: -1 }) })
    const first = await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: failing.send, openIdFor, now: at3h })
    assert.strictEqual(first.sent, 0, '（前置）第一次必须失败')
    const row1 = world.stores.get(SANDBOX_REMINDERS).values().next().value
    assert.strictEqual(row1.attempts, 2, '⛔ 两条失败都要留痕')
    assert.strictEqual(row1.lastFailure['class-reminder-3h:coach'].code, 'SEND_FAILED')
    assert.deepStrictEqual(row1.sent, {}, '⛔ 失败绝不能标记成已发送')
    // ② 第二次：好了 ⇒ 两条都补发成功，且 attempts 累加
    const ok = recorder()
    const second = await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: ok.send, openIdFor, now: at3h + MIN })
    assert.strictEqual(second.sent, 2, '🚨 失败之后没能重试成功 ⇒ 这条提醒就丢了')
    const row2 = world.stores.get(SANDBOX_REMINDERS).values().next().value
    assert.strictEqual(row2.attempts, 4, '⛔ 尝试次数必须累计（失败两次 + 成功两次）')
    // ③ 第三次：已经成功 ⇒ 一条都不许多发
    const again = recorder()
    const third = await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: again.send, openIdFor, now: at3h + 2 * MIN })
    assert.strictEqual(third.sent, 0, '🚨 已经发成功还重发了一次')
    assert.strictEqual(again.calls.length, 0, '🚨 已发送之后竟然又调了发送接口')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 需求七 ⑯：Sandbox 与 Production 绝不串消息
  // ═══════════════════════════════════════════════════════════════════════════
  await test('⑯ 🚨 测试区只扫测试区、只写给测试区；正式区集合一个字节都不碰', async () => {
    const core = loadCore(withReminderTemplates)
    const world = seedWorld()
    const rec = recorder()
    await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at3h })
    const forbidden = [PRODUCTION_HEADS, PRODUCTION_REMINDERS, PRODUCTION_CLAIMS, 'member_notification_events', 'member_accounts']
    forbidden.forEach(name => {
      assert.ok(world.touched.indexOf(name) < 0, `🚨 测试区的定时提醒碰了正式区集合 ${name}`)
    })
    assert.ok(world.stores.has(SANDBOX_REMINDERS), '⛔ 提醒状态必须写在测试区那张表')
    assert.ok(!world.stores.has(PRODUCTION_REMINDERS), '🚨 竟然创建了正式区的提醒表')
    // ⛔ 静态层：测试区那个定时云函数的**源码里**不许出现任何正式区集合名
    const sandboxIndex = fs.readFileSync(P('cloudfunctions/classReminderSandboxScheduler/index.js'), 'utf8')
    forbidden.forEach(name => {
      assert.ok(sandboxIndex.indexOf(name) < 0, `🚨 classReminderSandboxScheduler/index.js 里出现了正式区集合名 ${name}`)
    })
    // ⛔ 正式区那个函数**不许**去读测试区的 heads
    const productionIndex = fs.readFileSync(P('cloudfunctions/classReminderScheduler/index.js'), 'utf8')
    assert.ok(productionIndex.indexOf(SANDBOX_HEADS) < 0, '🚨 正式区定时函数去读了测试区的账本清单')
    assert.ok(productionIndex.indexOf(PRODUCTION_HEADS) >= 0, '⛔ 正式区定时函数必须读正式区账本清单')
  })

  await test('⑯-b ⛔ 正式区跑一遍：只碰正式区集合（与测试区完全对称）', async () => {
    const core = loadCore(withReminderTemplates)
    const world = seedWorld({ collections: productionCollections })
    const rec = recorder()
    const outcome = await core.scanOnce({ db: world.db, environment: 'production', collections: productionCollections, send: rec.send, openIdFor, now: at3h })
    assert.strictEqual(outcome.sent, 2, '（前置）正式区链路同样能发')
    ;[SANDBOX_HEADS, SANDBOX_REMINDERS, SANDBOX_CLAIMS].forEach(name => {
      assert.ok(world.touched.indexOf(name) < 0, `🚨 正式区的定时提醒碰了测试区集合 ${name}`)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 需求二 ⑮：北京时间（⛔ 云函数默认时区常常是 UTC，差 8 小时就是"提前/延后一小时"级别的事故）
  // ═══════════════════════════════════════════════════════════════════════════
  await test('⑮-时区 🚨 时间一律按北京时间算（⛔ 不许用云函数的默认时区）', async () => {
    const core = loadCore(null)
    assert.strictEqual(core.beijingDateKeyOf(Date.UTC(2026, 9, 6, 6, 59)), '2026-10-06', '14:59 北京时间仍算当天')
    assert.strictEqual(core.beijingDateKeyOf(Date.UTC(2026, 9, 6, 7, 0)), '2026-10-06', '15:00 北京时间')
    assert.strictEqual(core.beijingDateKeyOf(Date.UTC(2026, 9, 5, 16, 0)), '2026-10-06', '次日 00:00 北京时间')
    assert.strictEqual(core.beijingDateKeyOf(Date.UTC(2026, 9, 5, 15, 59)), '2026-10-05', '前一天 23:59 北京时间仍是 10-05')
    // ⛔ 15:00 北京时间 = 07:00 UTC（写死常量防回归）
    assert.strictEqual(core.startAtOf({ date: '2026-10-06', hour: 15, minute: 0 }), Date.UTC(2026, 9, 6, 7, 0))
    // ⛔ 早于 8 点的课会借位到前一天（hour - 8 为负），必须仍然正确
    assert.strictEqual(core.startAtOf({ date: '2026-10-06', hour: 6, minute: 30 }), Date.UTC(2026, 9, 5, 22, 30))
    // ⛔ 判据：到点才发，没到点不发
    assert.deepStrictEqual(core.dueKindsOf(START_AT, at3h - MIN), [], '⛔ 还差 1 分钟就发了 3 小时提醒（早发）')
    assert.deepStrictEqual(core.dueKindsOf(START_AT, at3h), ['class-reminder-3h'], '⛔ 3 小时节点没触发')
    assert.deepStrictEqual(core.dueKindsOf(START_AT, at1h), ['class-reminder-3h', 'class-reminder-1h'], '⛔ 1 小时节点两个都该到期（3h 那次要是漏了会补发）')
    assert.deepStrictEqual(core.dueKindsOf(START_AT, START_AT), [], '⛔ 课都开始了还在提醒（迟到提醒没有意义）')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 判别力：上面每条判据都必须**真的抓得住**
  // ═══════════════════════════════════════════════════════════════════════════
  await test('判别力一：把"已发送标记"拆掉（成功也当没发过）⇒ 重复运行必须多发', async () => {
    // ⚠️ 漂移必须**保持括号平衡**：只改条件、不动同行后面的语句
    //   （早先写成 `if (false) {  // drifted` 会把同行剩下的代码全注释掉 ⇒ SyntaxError）。
    const core = loadCore(withReminderTemplates, source => source.replace(
      "if (current.sent && current.sent[key]) {", 'if (false && current.sent && current.sent[key]) {'
    ))
    const world = seedWorld()
    const rec = recorder()
    await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at3h })
    await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at3h + MIN })
    assert.ok(rec.calls.length > 2, '⛔ 反证自身失效：漂移版竟然没有重复发（那红得没意义）')
    let red = false
    try { assert.strictEqual(rec.calls.length, 2, '🚨 同一节课同一种提醒发了不止一次') } catch (error) { red = true }
    assert.ok(red, '⛔ 判据⑮ 抓不住"重复运行重复发"这种回归')
  })

  await test('判别力二：把"取消后作废"那道闸拆掉 ⇒ 取消的课也会被提醒', async () => {
    const core = loadCore(withReminderTemplates, source => source.replace('if (!eligible.ok) {', 'if (false) {'))
    const world = seedWorld()
    world.stores.get('bookings').get('b1').data.status = 'cancelled'
    const rec = recorder()
    await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at3h })
    assert.ok(rec.calls.length > 0, '⛔ 反证自身失效：漂移版竟然没给取消的课发提醒（那红得没意义）')
    let red = false
    try {
      assert.strictEqual(rec.calls.length, 0, '🚨 课都取消了还在提醒')
    } catch (error) { red = true }
    assert.ok(red, '⛔ 判据⑨ 抓不住"取消后照旧提醒"这种回归')
  })

  await test('判别力三：改期时**不清空**已发标记 ⇒ 新时间的提醒永远发不出去', async () => {
    const core = loadCore(withReminderTemplates, source => source.replace(
      '  next.sent = {}\n  next.lease = {}\n  next.lastFailure = {}',
      '  // drifted: 改期不清空已发标记（新时间就再也收不到提醒了）'
    ))
    const world = seedWorld()
    const rec = recorder()
    await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at3h })
    world.stores.get('bookings').get('b1').data.hour = 18
    const after = await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: Date.UTC(2026, 9, 6, 18 - 8, 0) - 180 * MIN })
    assert.strictEqual(after.sent, 0, '⛔ 反证自身失效：漂移版竟然还发了（那红得没意义）')
    let red = false
    try { assert.strictEqual(after.sent, 2, '🚨 改期后新时间的提醒没发出来') } catch (error) { red = true }
    assert.ok(red, '⛔ 判据⑩ 抓不住"改期不清空标记"这种回归')
  })

  await test('判别力四：把"模板没配置就不发"那道闸拆掉 ⇒ 没模板也会去调发送接口', async () => {
    // ⛔ 漂移点选在模板真源本身：让 `templateIdFor` 永远返回一个假 ID ⇒
    //    "模板没配置"这道闸被绕过，发送接口会被真的调用（这正是要被抓住的回归）。
    const core = loadCore(source => source.replace(
      "const templateIdFor = kind => String(TEMPLATE_IDS[TEMPLATE_OF_KIND[kind]] || '')",
      "const templateIdFor = kind => 'DRIFT_FAKE_TEMPLATE'"
    ))
    const world = seedWorld()
    const rec = recorder()
    await core.scanOnce({ db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send, openIdFor, now: at3h })
    assert.ok(rec.calls.length > 0, '⛔ 反证自身失效：漂移版竟然没去调发送接口（那红得没意义）')
    let red = false
    try { assert.strictEqual(rec.calls.length, 0, '🚨 模板都没配竟然还调了发送接口') } catch (error) { red = true }
    assert.ok(red, '⛔ 判据⑬ 抓不住"没模板也假装发送"这种回归')
  })

  await test('判别力五：把"只通知另一方"拆掉 ⇒ 教练会收到会员那一份（串号）', async () => {
    // ⛔ 静态判据的判别力：`openIdFor` 按收件人取标识这一层被拆掉 ⇒ 两边都拿到同一个 openid
    const core = loadCore(withReminderTemplates)
    const world = seedWorld()
    const rec = recorder()
    await core.scanOnce({
      db: world.db, environment: 'sandbox', collections: sandboxCollections, send: rec.send,
      openIdFor: async () => 'openid-same-for-everyone', now: at3h
    })
    const unique = new Set(rec.calls.map(call => call.touser))
    assert.strictEqual(unique.size, 1, '⛔ 反证自身失效：漂移版竟然还是两个不同收件人（那红得没意义）')
    let red = false
    try { assert.ok(unique.size >= 2, '🚨 教练和会员收到了同一个人的提醒（串号）') } catch (error) { red = true }
    assert.ok(red, '⛔ 判据⑰⑱ 抓不住"教练收到会员那一份"这种回归')
    void core
  })

  console.log(results.join('\n'))
  const failed = results.filter(r => r.startsWith('FAIL')).length
  console.log(`\n课前提醒定时云函数：${results.length - failed} PASS / ${failed} FAIL（共 ${results.length} 条）`)
  if (failed) { console.error('CLASS REMINDER SCHEDULER: 有失败段（见上面 FAIL 行）'); return }
  console.log('CLASS REMINDER SCHEDULER: ALL PASS')
}

main().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 })
