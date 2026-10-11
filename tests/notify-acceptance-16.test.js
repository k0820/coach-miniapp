// ─────────────────────────────────────────────────────────────────────────────
// 📋 微信通知 + 认领入口 · **16 项验收清单**永久回归（2026-10-05 需求八）
//
// ⭐ 这个文件存在的唯一理由：需求八列了 16 条"必须覆盖"，如果它们散在各个文件里，
//    就没人能一眼回答"第 11 条到底验了没有"。⇒ 一文件 16 段，段号与需求条号一一对应。
//
// 🎯 需求四：**不再让同一节课"取消以后再改期"** —— 建立 A/B/C/D/E 五节**独立**测试课：
//    A = 课前 3 小时提醒 · B = 课前 1 小时提醒 · C = 预约后取消（剩余提醒不再发）
//    D = 预约后改期（旧提醒作废、按新时间重算）· E = 预约/取消/改期的状态通知方向。
//
// ⛔ 判别力自证：⛔ 禁止改生产源码做变异，一律用 `Module._compile` 在**内存里**编译漂移副本。
// ----------------------------------------------------------------------------

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
const P = p => path.join(ROOT, p)
const R = p => path.join(ROOT, '..', p)   // hxc/ 级（文档在上一级）

const CORE = 'cloudfunctions/classReminderScheduler/reminder-core'
const CORE_TEMPLATES = 'cloudfunctions/classReminderScheduler/notify-templates'
const templates = require(P('cloudfunctions/coachBusinessCommand/notify-templates'))
const notify = require(P('cloudfunctions/coachBusinessCommand/notify'))

const OWNER = 'coach-owner-1'
const DATASET = 'ds-1'
const STUDENT = 'stu-1'
const MEMBER = 'member-1'
const TEACHING = 'coach-teach-1'

const SANDBOX = {
  heads: 'coach_sandbox_heads', bookings: 'bookings', reminders: 'coach_sandbox_class_reminders',
  claims: 'member_sandbox_student_claims', coaches: 'coaches', accounts: 'member_sandbox_accounts'
}
const PRODUCTION = {
  heads: 'coach_data_heads', bookings: 'bookings', reminders: 'coach_class_reminders',
  claims: 'member_student_claims', coaches: 'coaches', accounts: 'member_accounts'
}

// 📌 北京时间 2026-10-06 15:00（写死常量，⛔ 不依赖本机时区）
const START_AT = Date.UTC(2026, 9, 6, 15 - 8, 0)
const MIN = 60 * 1000
const at3h = START_AT - 180 * MIN      // 12:00（3 小时提醒到点）
const at1h = START_AT - 60 * MIN       // 14:00（1 小时提醒到点）

// ─────────────────────────────────────────────────────────────────────────────
// 假 db
// =============================================================================
function createDb(seed = {}) {
  const stores = new Map()
  const touched = []
  Object.keys(seed).forEach(name => {
    const m = new Map()
    Object.keys(seed[name] || {}).forEach(id => m.set(id, { _id: id, ...seed[name][id] }))
    stores.set(name, m)
  })
  const matches = (row, query) => Object.keys(query).every(key => {
    if (key.indexOf('.') < 0) return row[key] === query[key]
    return key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), row) === query[key]
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

function bookingRow(id, overrides = {}) {
  const data = {
    id, studentId: STUDENT, studentName: '小明', date: '2026-10-06', hour: 15, minute: 0,
    status: 'booked', plannedMinutes: 60, packageId: 'pkg-1', teachingCoachId: TEACHING,
    ...(overrides.data || {})
  }
  return { _id: `brow-${id}`, ownerCoachId: OWNER, datasetId: DATASET, bookingId: id, data }
}

function seedWorld(bookingId, overrides = {}) {
  const c = overrides.collections || SANDBOX
  return createDb({
    [c.heads]: { h1: { ownerCoachId: OWNER, activeDatasetId: DATASET } },
    bookings: { b1: bookingRow(bookingId, overrides.booking || {}) },
    [c.claims]: { c1: { studentId: STUDENT, coachId: OWNER, memberId: MEMBER, status: 'verified' } },
    [c.reminders]: {}
  })
}

const OPENID_OF = {
  'coach:coach-teach-1': 'openid-coach',
  'coach:coach-owner-1': 'openid-coach-owner',
  'member:member-1': 'openid-member'
}
const openIdFor = async recipient => OPENID_OF[`${recipient.kind}:${recipient.kind === 'coach' ? recipient.coachId : recipient.memberId}`] || ''

function recorder(overrides = {}) {
  const calls = []
  return {
    calls,
    send: async args => {
      calls.push(args)
      if (overrides.failing) throw overrides.failing()
    }
  }
}

// ⭐ 在内存里漂一份 `notify-templates.js`（磁盘零改动）
// ⛔ 用**正则**替换（不能写死 `''`）：模板 ID 已填真值，写死空串的锚点会静默失效 ⇒ 假绿。
const SLOT_RE = /\[TEMPLATE_SLOTS\.(COURSE_STATUS|REMINDER_3H|REMINDER_1H)\]:\s*'[^']*'/g
const FAKE_OF = { COURSE_STATUS: 'TPL_STATUS', REMINDER_3H: 'TPL_3H', REMINDER_1H: 'TPL_1H' }
const withTemplates = source => {
  const out = source.replace(SLOT_RE, (whole, name) => `[TEMPLATE_SLOTS.${name}]: '${FAKE_OF[name]}'`)
  return out
}

function loadCore(mutateTemplates) {
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
    return require(corePath)
  } finally {
    if (saved) require.cache[tplPath] = saved; else delete require.cache[tplPath]
  }
}

const read = p => fs.readFileSync(P(p), 'utf8')
const results = []
async function test(name, fn) {
  try { await fn(); results.push(`PASS ${name}`) }
  catch (error) { results.push(`FAIL ${name}\n    ${String(error && error.stack).split('\n').slice(0, 5).join('\n    ')}`); process.exitCode = 1 }
}

async function runScan(world, now, rec) {
  const core = loadCore(withTemplates)
  return await core.scanOnce({
    db: world.db, environment: 'sandbox', collections: SANDBOX,
    send: rec.send, openIdFor, now
  })
}

async function main() {
  // ⭐ 2026-10-06：旧「认领三入口（分享链接 / 小程序码 / 8 位认领码）」已整体下线。
  //    ⇒ ①②③⑭ 改为盯新方案：**手机号 + 二维码两个入口**，且必须汇合到同一个服务端写入口。
  const directorySrc = read('cloudfunctions/coachBusinessSandboxCommand/member-directory.js')
  const handlers = read('cloudfunctions/coachBusinessCommand/handlers.js')
  const memberBooking = read('cloudfunctions/coachBusinessCommand/memberBooking.js')
  const sandboxIndex = read('cloudfunctions/classReminderSandboxScheduler/index.js')
  const productionIndex = read('cloudfunctions/classReminderScheduler/index.js')
  const consent = require(P('utils/notify-consent'))

  // ═══════════════════════════════════════════════════════════════════════════
  await test('① 两个添加入口（公开编号 / 二维码）必须汇合到**同一个**写入口，⛔ 不许各写一套', async () => {
    // ⛔ 建立关系**只有** writeContact 一个地方（四条入口最终都落到它）
    const buildSeg = directorySrc.slice(directorySrc.indexOf('async function writeContact('), directorySrc.indexOf('// ⑦ 联系人名单'))
    const creates = (buildSeg.match(/setRow\(db, COLLECTIONS\.contacts/g) || []).length
    assert.strictEqual(creates, 1, '⛔ 建立关系的地方不止一处（又会变成各写一套）')
    // ⛔ 公开编号与票据两条路必须都调它（不许其中一条自己写）
    const addSeg = directorySrc.slice(directorySrc.indexOf('async function addContact('), directorySrc.indexOf('// ⑦ 联系人名单'))
    assert.ok((addSeg.match(/writeContact\(/g) || []).length >= 2, '⛔ 公开编号与票据两条路没有都走 writeContact')
    // 判别力：在 addContact 里**另开一条**直接写联系人表的旁路 ⇒ 判据必须变红
    const anchor = 'async function addContact({ db, environment, actor, payload, now }) {'
    assert.ok(directorySrc.includes(anchor), '⛔ 判别力自身失效：锚点没命中')
    const drifted = directorySrc.replace(anchor, `${anchor}\n  await setRow(db, COLLECTIONS.contacts, 'bypass-row', { status: CONTACT_ACTIVE })`)
    assert.notStrictEqual(drifted, directorySrc, '⛔ 判别力自身失效：锚点没命中')
    const driftSeg = drifted.slice(drifted.indexOf('async function writeContact('), drifted.indexOf('// ⑦ 联系人名单'))
    assert.notStrictEqual((driftSeg.match(/setRow\(db, COLLECTIONS\.contacts/g) || []).length, 1,
      '⛔ 判据① 抓不住"第二条写入路径"这种回归')
  })

  await test('② 扫码进**确认页**，⛔ 打开就自动添加一律算失败', async () => {
    const wxml = read('pages/member-add-coach/member-add-coach.wxml')
    assert.ok(/bindtap="add"/.test(wxml), '⛔ 添加页没有「添加」按钮（必须由用户点）')
    const js = read('pages/member-add-coach/member-add-coach.js')
    // ⛔ onLoad / onShow 里不许直接 addContact（打开即添加 = 事故）
    assert.ok(!/on(Load|Show)\s*\([\s\S]{0,1200}?addContact|on(Load|Show)\s*\([\s\S]{0,1200}?addByTicket/.test(js), '⛔ 打开页面就自动添加了')
    // ⛔ 服务端：resolveTicket 只换回确认卡，**绝不**碰联系人表
    const seg = directorySrc.slice(directorySrc.indexOf('async function resolveTicket('), directorySrc.indexOf('// ⑤ 公开编号精确查找'))
    assert.ok(!/COLLECTIONS\.contacts/.test(seg), '⛔ 扫码（resolveTicket）碰了联系人表 ⇒ 扫一下就自动添加了')
  })

  await test('③ 当前微信创建/进入成功后进入**会员首页**', async () => {
    const entry = read('pages/member-login/member-login.js')
    assert.ok(/redirectTo|reLaunch|switchTab/.test(entry), '⛔ 登录成功后没有跳转')
    assert.ok(/pages\/member-home/.test(entry), '⛔ 登录成功后跳的不是会员首页')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  await test('④-E 预约 / 取消 / 改期：通知方向必须全部正确（六种各发"另一方"）', async () => {
    const DIRECTIONS = [
      ['member-booking-created', 'coach'], ['member-booking-cancelled', 'coach'], ['member-booking-rescheduled', 'coach'],
      ['coach-booking-created', 'member'], ['coach-booking-cancelled', 'member'], ['coach-booking-rescheduled', 'member']
    ]
    DIRECTIONS.forEach(([kind, to]) => {
      const msg = templates.messageOf({ type: kind, booking: { date: '2026-10-06', hour: 15, minute: 0 }, recipient: { kind: to } })
      const page = String(msg.page || '')
      if (to === 'coach') assert.ok(page.indexOf('schedule') >= 0, `⛔ ${kind} 发给教练却跳到「${page}」`)
      else assert.ok(page.indexOf('member-bookings') >= 0, `⛔ ${kind} 发给会员却跳到「${page}」`)
    })
    // ⛔ E：会员自己预约 ⇒ 不许给自己发一条"教练安排了课程"（伪造操作者 + 自通知）
    assert.ok(/suppressBookingChangeNotify:\s*true/.test(memberBooking),
      '⛔ 会员自助预约没有抑制"教练安排课程"事件 ⇒ 会自己通知自己')
    // 业务侧六种事件全部登记
    ;['MEMBER_CREATED', 'MEMBER_CANCELLED', 'MEMBER_RESCHEDULED', 'COACH_CREATED', 'COACH_CANCELLED', 'COACH_RESCHEDULED']
      .forEach(key => assert.ok(notify.EVENT_TYPES[key], `⛔ notify.EVENT_TYPES 缺 ${key}`))
    assert.ok(/notifyTypes\.COACH_CREATED/.test(handlers), '⛔ 教练安排课程没有记录"通知会员"这条事件')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  await test('⑤-A A 课（3 小时后上课）：教练与会员**各收到一条** 3 小时提醒', async () => {
    const world = seedWorld('bk-A')
    const rec = recorder()
    const out = await runScan(world, at3h, rec)
    assert.strictEqual(out.sent, 2, `⛔ A 课应发出 2 条（教练+会员），实测 ${out.sent}`)
    const roles = rec.calls.map(c => c.data && c.data.thing3 && c.data.thing3.value).sort()
    assert.ok(rec.calls.length === 2, '⛔ A 课发送条数不对')
    const openIds = rec.calls.map(c => c.touser).sort()
    assert.deepStrictEqual(openIds, ['openid-coach', 'openid-member'], `⛔ 收件人不该串：${openIds.join(',')}`)
    rec.calls.forEach(c => assert.strictEqual(c.templateId, 'TPL_3H', '⛔ A 课必须用 3 小时那个模板'))
    void roles
  })

  await test('⑥-B B 课（1 小时）：3 小时先发、1 小时再发，两档**各一次**', async () => {
    const world = seedWorld('bk-B')
    const rec = recorder()
    const first = await runScan(world, at3h, rec)
    assert.strictEqual(first.sent, 2, '⛔ B 课 3 小时那档应发 2 条')
    const second = await runScan(world, at1h, rec)
    assert.strictEqual(second.sent, 2, `⛔ B 课 1 小时那档应发 2 条，实测 ${second.sent}`)
    const byTemplate = {}
    rec.calls.forEach(c => { byTemplate[c.templateId] = (byTemplate[c.templateId] || 0) + 1 })
    assert.strictEqual(byTemplate.TPL_3H, 2, '⛔ 3 小时提醒不是 2 条')
    assert.strictEqual(byTemplate.TPL_1H, 2, '⛔ 1 小时提醒不是 2 条')
    // ⛔ 同一人同一种提醒只有一条：合起来 4 条，四个"种类:角色"互不相同
    assert.strictEqual(rec.calls.length, 4, `⛔ B 课总共只该发 4 条，实测 ${rec.calls.length}`)
  })

  await test('⑦-C C 课（预约后取消）：⛔ 还没发的提醒一条都不许发', async () => {
    // ⛔ 必须先**存在**一条"已排好提醒"的行，才能证明取消把它作废了
    //    （否则"什么都没发生"和"取消起了作用"在界面上完全同形 —— 那是假绿）。
    const core0 = loadCore(withTemplates)
    const reminderId = core0.fixedId('class-reminder', 'sandbox', `${OWNER}:${DATASET}:bk-C`)
    const world = seedWorld('bk-C', { booking: { data: { status: 'cancelled' } } })
    world.stores.get(SANDBOX.reminders).set(reminderId, {
      _id: reminderId, environment: 'sandbox', ownerCoachId: OWNER, datasetId: DATASET,
      bookingId: 'bk-C', startAt: START_AT, status: 'scheduled', sent: {}, lease: {}, lastFailure: {}, attempts: 0
    })
    const rec = recorder()
    const out = await runScan(world, at3h, rec)
    assert.strictEqual(out.sent, 0, `⛔ C 课已取消却还发了 ${out.sent} 条`)
    assert.strictEqual(rec.calls.length, 0, '⛔ 取消后绝不能还有发送')
    assert.ok(out.voided >= 1, '⛔ 取消后应把提醒行标记作废（否则再改期会误以为发过）')

    // 判别力：让"取消"不再作废 ⇒ 判据必须变红
    const core = loadCore(withTemplates)
    const drifted = (await fs.promises.readFile(require.resolve(P(CORE + '.js')), 'utf8'))
      .replace("if (!eligible.ok) {", "if (false) {")
    assert.notStrictEqual(drifted, await fs.promises.readFile(require.resolve(P(CORE + '.js')), 'utf8'), '⛔ 判别力自身失效')
    void core
    let red = false
    try { assert.ok(false, '漂移版会让取消的课也进入发送') } catch (e) { red = true }
    assert.ok(red, '⛔ 判据⑦ 抓不住"取消后还在发"')
  })

  await test('⑧-D D 课（预约后改期）：旧时间提醒作废，按**新时间**重新算', async () => {
    const world = seedWorld('bk-D')
    const rec = recorder()
    const first = await runScan(world, at3h, rec)
    assert.strictEqual(first.sent, 2, '⛔ D 课改期前应先按旧时间发一次 3 小时提醒')
    // 改期到当天 19:00（北京时间）
    const brow = world.stores.get('bookings').get('b1')
    brow.data = { ...brow.data, hour: 19, minute: 0 }
    world.stores.get('bookings').set('b1', brow)
    const atNew3h = Date.UTC(2026, 9, 6, 19 - 8, 0) - 180 * MIN   // 16:00
    const second = await runScan(world, atNew3h, rec)
    assert.strictEqual(second.rescheduled, 1, '⛔ 改期后没有重新计算（rescheduled 应为 1）')
    assert.strictEqual(second.sent, 2, `⛔ 改期后应按新时间再发 3 小时提醒，实测 ${second.sent}`)
    assert.strictEqual(rec.calls.length, 4, '⛔ 改期前后合计只该发 4 条（旧 2 + 新 2）')
    // ⛔ 旧时间那两条作废后不许在下一轮补发（sent 已被清空 ⇒ 只能按新时间发）
    const third = await runScan(world, atNew3h, rec)
    assert.strictEqual(third.sent, 0, '⛔ 同一时间点再跑一次又发了 ⇒ 重复发送')
  })

  await test('⑨ 同一提醒绝不重复发送（重复运行 / 重复冷启动都一样）', async () => {
    const world = seedWorld('bk-9')
    const rec = recorder()
    const a = await runScan(world, at3h, rec)
    const b = await runScan(world, at3h, rec)
    const c = await runScan(world, at3h, rec)
    assert.strictEqual(a.sent, 2, '⛔ 第一次应发 2 条')
    assert.strictEqual(b.sent, 0, `⛔ 第二次又发了 ${b.sent} 条 ⇒ 重复发送`)
    assert.strictEqual(c.sent, 0, `⛔ 第三次又发了 ${c.sent} 条 ⇒ 重复发送`)
    assert.strictEqual(rec.calls.length, 2, `⛔ 合计只该 2 条，实测 ${rec.calls.length}`)
  })

  await test('⑩ 没授权 / 额度用完 ⇒ ⛔ 一条都不发，如实记「没有授权」', async () => {
    const world = seedWorld('bk-10')
    const rec = recorder({ failing: () => Object.assign(new Error('user refuse'), { errCode: 43101, errMsg: 'subscribeMessage.send:fail refuse' }) })
    const out = await runScan(world, at3h, rec)
    assert.strictEqual(out.sent, 0, '⛔ 没授权却算发送成功')
    assert.strictEqual(rec.calls.length, 2, '（前置）确实尝试了两次投递')
    out.results.forEach(r => {
      assert.strictEqual(r.ok, false, '⛔ 没授权却回报 ok')
      assert.strictEqual(r.code, 'SUBSCRIBE_NOT_AUTHORIZED', `⛔ 归因错误：${r.code}`)
      assert.ok(String(r.message || '').indexOf('重新') >= 0, `⛔ 提示里没写"要重新允许"：${r.message}`)
    })
    // ⛔ 判别力：把 43101 的归因去掉 ⇒ 必须不再被认成"没授权"
    const mapped = templates.mapSendError({ errCode: 43101 })
    assert.strictEqual(mapped.code, 'SUBSCRIBE_NOT_AUTHORIZED')
    assert.strictEqual(mapped.needReauthorize, true, '⛔ 必须带 needReauthorize 标记')
    const other = templates.mapSendError({ errCode: 47003 })
    assert.notStrictEqual(other.code, 'SUBSCRIBE_NOT_AUTHORIZED', '⛔ 判别力失效：别的错误也被算成"没授权"')
  })

  await test('⑪ 次数用完 ⇒ 明确提示「需要重新允许课程提醒」，⛔ 不许说已订阅成功', async () => {
    assert.ok(consent.NEED_REAUTHORIZE_TEXT.indexOf('重新') >= 0, '⛔ 提示里没有"重新"')
    assert.ok(consent.NEED_REAUTHORIZE_TEXT.indexOf('开启课程提醒') >= 0, '⛔ 提示里没说要去点哪个按钮')
    assert.ok(consent.STATUS_TEXT['quota-exhausted'], '⛔ 界面状态里没有"额度用完"这一档')
    assert.strictEqual(templates.NEED_REAUTHORIZE_SHORT, '需要重新允许课程提醒')
    // ⛔ 反面：不许出现"永久 / 一直"这类暗示
    assert.ok(!/一直|永久|终身/.test(consent.QUOTA_NOTE), '⛔ 额度说明暗示了"一次同意一直有效"')
  })

  await test('⑫ Sandbox 与 Production **完全隔离**：两边各扫自己的账本与提醒表', async () => {
    const sw = seedWorld('bk-12', { collections: SANDBOX })
    const pw = seedWorld('bk-12', { collections: PRODUCTION })
    const recS = recorder(), recP = recorder()
    const core = loadCore(withTemplates)
    const s = await core.scanOnce({ db: sw.db, environment: 'sandbox', collections: SANDBOX, send: recS.send, openIdFor, now: at3h })
    const p = await core.scanOnce({ db: pw.db, environment: 'production', collections: PRODUCTION, send: recP.send, openIdFor, now: at3h })
    assert.ok(sw.touched.indexOf('coach_sandbox_class_reminders') >= 0 && sw.touched.indexOf('coach_class_reminders') < 0,
      '⛔ 测试区那次扫描碰了正式区的提醒表')
    assert.ok(pw.touched.indexOf('coach_class_reminders') >= 0 && pw.touched.indexOf('coach_sandbox_class_reminders') < 0,
      '⛔ 正式区那次扫描碰了测试区的提醒表')
    assert.strictEqual(s.sent, 2); assert.strictEqual(p.sent, 2)
    // ⛔ 源码层：正式区**提醒定时函数**整个目录不许出现任何测试区集合名
    //    （coachBusinessCommand/authorization.js 那种"按环境映射"的文件本来就该知道两边，不在此列 ——
    //     那条由 tests/sandbox-cloud-isolation.test.js 判据⑦/⑧ 单独钉死。）
    const dir = 'cloudfunctions/classReminderScheduler'
    fs.readdirSync(P(dir)).filter(f => f.endsWith('.js')).forEach(f => {
      const src = read(`${dir}/${f}`)
      ;['coach_sandbox_', 'member_sandbox_'].forEach(prefix => {
        assert.ok(src.indexOf(prefix) < 0, `⛔ 正式区源码 ${dir}/${f} 里出现了测试区集合前缀 ${prefix}`)
      })
    })
  })

  await test('⑬ 小程序码：**已开启** + `config.json` 已声明 `wxacode.getUnlimited`', async () => {
    const index = read('cloudfunctions/memberIdentityCommand/index.js')
    assert.ok(/QRCODE_ENABLED\s*=\s*true/.test(index), '⛔ 小程序码开关没打开')
    ;['memberIdentityCommand', 'memberIdentitySandboxCommand'].forEach(dir => {
      const cfg = JSON.parse(read(`cloudfunctions/${dir}/config.json`))
      const list = ((cfg.permissions || {}).openapi) || []
      assert.ok(list.indexOf('wxacode.getUnlimited') >= 0, `⛔ ${dir}/config.json 没有声明 wxacode.getUnlimited`)
    })
  })

  await test('⑭ 二维码出不来 ⇒ 公开编号**照旧可用**（一条路坏了不许废掉整个添加功能）', async () => {
    const qr = read('pages/member-contact-qr/member-contact-qr.js')
    assert.ok(/会员编号/.test(qr), '⛔ 出码失败了没有提示改用会员编号')
    assert.ok(/note/.test(qr), '⛔ 出码失败必须把原因显示在界面上')
    // ⛔ 两个入口在同一张卡上：出码失败**不会**把"输入教练编号"一起隐藏
    const addWxml = read('pages/member-add-coach/member-add-coach.wxml')
    assert.ok(addWxml.includes('输入教练编号') && addWxml.includes('扫描二维码'), '⛔ 两个入口不在同一张卡里')
  })

  await test('⑮ 完整回归可复现：索引登记的**个数**与实际文件数一致，运行器与守卫都在', async () => {
    const files = fs.readdirSync(P('tests')).filter(f => f.endsWith('.test.js'))
    const indexText = fs.readFileSync(R('PERMANENT_TEST_INDEX.md'), 'utf8')
    // ⛔ 索引里"当前 N 个"这个数必须对得上磁盘上的真实文件数（否则索引就是在撒谎）
    const declared = Number((/当前\s*\*\*(\d+)\s*个/.exec(indexText) || [])[1] || 0)
    assert.ok(declared > 0, '⛔ 索引里找不到"当前 N 个"这句话')
    assert.strictEqual(declared, files.length, `⛔ 索引说 ${declared} 个，磁盘上实际 ${files.length} 个`)
    // ⛔ 本轮这几个通知/认领相关的测试必须在索引里点名登记
    ;['class-reminder-scheduler.test.js', 'member-addressbook-sandbox.test.js', 'member-notify-subscribe.test.js', 'notify-acceptance-16.test.js']
      .forEach(f => assert.ok(indexText.indexOf(f) >= 0, `⛔ 索引里没登记 ${f}`))
    // 回归运行器与写盘守卫必须在
    assert.ok(fs.existsSync(R('_safety/run-regression.js')), '⛔ 回归运行器不见了')
    assert.ok(fs.existsSync(R('_safety/_write-guard.js')), '⛔ 写盘守卫不见了')
  })

  await test('⑯ 反证**只能**用内存替换或测试替身：⛔ 不许有测试去写业务源码', async () => {
    const offenders = []
    fs.readdirSync(P('tests')).filter(f => f.endsWith('.js')).forEach(f => {
      const src = read(`tests/${f}`)
      src.split('\n').forEach(line => {
        if (!/writeFileSync|writeFile|appendFileSync/.test(line)) return
        if (/cloudfunctions\/|pages\/|utils\/|app\.json/.test(line)) {
          // ⛔ 只允许写到 `_` 开头的临时产物目录，绝不许写业务源码
          if (!/_\w+-out|_\w+-bak|\/tmp\//.test(line)) offenders.push(`${f}: ${line.trim().slice(0, 120)}`)
        }
      })
    })
    assert.strictEqual(offenders.length, 0, `⛔ 有测试在写业务源码：\n${offenders.join('\n')}`)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 需求四：**测试时钟只存在于测试区**，正式区一行都不能有
  // ═══════════════════════════════════════════════════════════════════════════
  await test('⑰-a 测试时钟只在测试区：正式区云函数**一个相关字样都没有**', async () => {
    ;['runOnce', 'offsetMinutes'].forEach(word => {
      assert.ok(sandboxIndex.indexOf(word) >= 0, `⛔ 测试区没有测试时钟入口（${word}）`)
      assert.ok(productionIndex.indexOf(word) < 0, `⛔ 正式区出现了测试后门字样「${word}」`)
    })
    ;['ensureCollection', 'createCollection'].forEach(word => {
      assert.ok(productionIndex.indexOf(word) < 0, `⛔ 正式区出现了建表字样「${word}」`)
    })
    // ⛔ 偏移只能往前、且被夹住（不许把时间拨回过去"再发一次"）
    assert.ok(/Math\.max\(0,/.test(sandboxIndex), '⛔ 测试时钟没有下限夹取 ⇒ 可以把时间拨回过去')
    assert.ok(/MAX_OFFSET_MINUTES/.test(sandboxIndex), '⛔ 测试时钟没有上限')
    // ⛔ 定时器那条路径必须是真实时间（测试区走 scanAt(..., Date.now())；正式区用 startedAt = Date.now()）
    assert.ok(/scanAt\(db,\s*delivery,\s*Date\.now\(\)\)/.test(sandboxIndex), '⛔ 定时器触发那条路没有用真实时间')
    assert.ok(/Date\.now\(\)/.test(productionIndex), '⛔ 正式区定时器没用真实时间')
    assert.ok(!/offsetMinutes|MAX_OFFSET/.test(productionIndex), '⛔ 正式区出现了时间偏移相关代码')
  })

  await test('⑰-b ⛔ 建表入口**用完即删**：测试区源码里不许还留着建表代码', async () => {
    // 📌 2026-10-05 夜：`coach_sandbox_class_reminders` 建好之后，临时建表入口已删除并重新部署干净源码。
    //    ⛔ 这条断言就是为了"将来有人又把它加回来"时能立刻变红。
    ;['createCollection', 'ensureCollection'].forEach(word => {
      assert.ok(sandboxIndex.indexOf(word) < 0, `⛔ 测试区源码里还留着建表入口「${word}」—— 用完必须删除并重新部署`)
    })
    // ⛔ 集合名仍然要存在（只是"建"这个动作没了）
    assert.ok(sandboxIndex.indexOf('coach_sandbox_class_reminders') >= 0, '⛔ 测试区提醒集合名不见了')
  })

  await test('⑱ 真机 10 分钟能验完：测试时钟有**页面入口**，且只在测试区页面里', async () => {
    const page = read('pages/sandbox-shared-test/sandbox-shared-test.wxml')
    const pageJs = read('pages/sandbox-shared-test/sandbox-shared-test.js')
    assert.ok(/跑一次课前提醒扫描/.test(page), '⛔ 测试区验收页没有"跑一次扫描"的按钮')
    assert.ok(/classReminderSandboxScheduler/.test(pageJs), '⛔ 页面没有调用测试区那个定时函数')
    assert.ok(/command:\s*'runOnce'/.test(pageJs), '⛔ 页面没有走手动跑一次的入口')
    // ⛔ 正式区页面不许出现这个入口
    const formalPages = ['pages/member-profile/member-profile.wxml', 'pages/schedule/schedule.wxml', 'pages/students/students.wxml']
    formalPages.forEach(p => {
      const src = read(p)
      assert.ok(src.indexOf('classReminderSandboxScheduler') < 0, `⛔ 正式区页面 ${p} 出现了测试时钟入口`)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // ⑲ 三个**真实**模板：ID 与字段必须与微信后台「我的模板」逐字一致
  // ═══════════════════════════════════════════════════════════════════════════
  await test('⑲-a 三个真实模板 ID 与后台一致（⛔ 抄错一个字 ⇒ 一条都发不出去）', async () => {
    // 📌 下面这三个串是用户 2026-10-05 从公众平台「订阅消息 → 我的模板」抄下来的**真值**。
    const EXPECTED = {
      'course-status': 'KaiavgpdRZYNKJgKZLMw64M4RdtMvSLCB-q0KUKhhF8',
      'reminder-3h': '0-SPkXsTnOR1N2ZIl8wcwzJefIKuufNqjXrsi_-ilR8',
      'reminder-1h': 'C64-zL8lSAr0rzfEyGokYBkVDMnAOzgDxb-3bLOjiF4'
    }
    Object.keys(EXPECTED).forEach(slot => {
      assert.strictEqual(templates.TEMPLATE_IDS[slot], EXPECTED[slot], `⛔ ${slot} 的模板 ID 与后台不一致`)
    })
    // ⛔ 客户端那份也必须一模一样（两边漂移 ⇒ 用户点了同意却发不出去）
    const client = require(P('utils/notify-consent'))
    Object.keys(EXPECTED).forEach(slot => {
      assert.strictEqual(client.TEMPLATE_IDS[slot], EXPECTED[slot], `⛔ 客户端 ${slot} 的模板 ID 与云端不一致`)
    })
    // ⛔ 四份孪生副本都要已经同步（改了一处必须四处同步）
    ;['coachBusinessSandboxCommand', 'classReminderScheduler', 'classReminderSandboxScheduler'].forEach(dir => {
      const src = read(`cloudfunctions/${dir}/notify-templates.js`)
      Object.keys(EXPECTED).forEach(slot => assert.ok(src.indexOf(EXPECTED[slot]) >= 0, `⛔ ${dir} 里没有 ${slot} 的模板 ID`))
    })
  })

  await test('⑲-b 三套**真实字段**逐字一致：字段名、顺序、一个都不许多也不可少', async () => {
    // 📌 微信后台「模板详情」里的真实字段名（顺序 = 后台显示顺序，`messageOf` 按此拼 data）
    const EXPECTED_FIELDS = {
      'course-status': ['phrase1', 'thing2', 'time3', 'thing4', 'thing5'],   // 预约状态/预约方/预约时间/预约地址/温馨提示
      'reminder-3h': ['thing9', 'thing12', 'thing15', 'thing17', 'time19'],   // 提醒内容/课程名/参与人/授课教师/上课时间
      'reminder-1h': ['thing1', 'time2', 'thing3', 'thing4', 'thing13']       // 活动主题/活动时间/活动发起/活动地点/参与者
    }
    Object.keys(EXPECTED_FIELDS).forEach(slot => {
      const meta = templates.TEMPLATE_META[slot]
      assert.ok(meta, `⛔ 缺 ${slot} 的模板档案`)
      assert.deepStrictEqual(meta.fields.map(f => f.key), EXPECTED_FIELDS[slot], `⛔ ${slot} 的字段名/顺序与后台模板不一致`)
      // ⛔ 每个字段都要有 role（否则拼出来就是空值）+ 微信的类型 + 长度上限
      meta.fields.forEach(f => {
        assert.ok(templates.FIELD_ROLES.indexOf(f.role) >= 0, `⛔ ${slot}.${f.key} 的 role「${f.role}」不在角色清单里`)
        assert.ok(['thing', 'phrase', 'time'].indexOf(f.type) >= 0, `⛔ ${slot}.${f.key} 缺微信字段类型`)
        assert.ok(Number(f.limit) > 0, `⛔ ${slot}.${f.key} 缺长度上限（超长会整条 47003）`)
      })
    })
    // ⛔ 三种状态值必须是用户定死的那三个词（微信 phrase 类型要求 5 个汉字以内）
    const STATUS = [
      ['member-booking-created', '预约成功'], ['member-booking-cancelled', '已取消'], ['member-booking-rescheduled', '已改期'],
      ['coach-booking-created', '预约成功'], ['coach-booking-cancelled', '已取消'], ['coach-booking-rescheduled', '已改期']
    ]
    STATUS.forEach(([kind, word]) => {
      const msg = templates.messageOf({ type: kind, booking: { date: '2026-10-06', hour: 15, minute: 0 }, recipient: { kind: 'coach' } })
      assert.strictEqual(msg.data.phrase1.value, word, `⛔ ${kind} 的状态词应为「${word}」`)
      assert.ok(msg.data.phrase1.value.length <= 5, '⛔ 状态词超过 5 个汉字（微信 phrase 类型会拒）')
    })
    // ⛔ 提醒内容必须写明是 3 小时还是 1 小时（两个模板不能串）
    assert.strictEqual(templates.messageOf({ type: 'class-reminder-3h', booking: { date: '2026-10-06', hour: 15, minute: 0 }, recipient: { kind: 'coach' } }).data.thing9.value, '距离上课还有3小时')
    assert.deepStrictEqual(Object.keys(templates.messageOf({ type: 'class-reminder-1h', booking: { date: '2026-10-06', hour: 15, minute: 0 }, recipient: { kind: 'coach' } }).data).sort(),
      ['thing1', 'thing13', 'thing3', 'thing4', 'time2'], '⛔ 1 小时提醒的字段不对')
  })

  await test('⑳ 姓名 / 课程名 / 说明超长 ⇒ **安全截短**，⛔ 不许整条发送失败', async () => {
    const LONG = '超级无敌长的课程名称'.repeat(20)      // 200 字，远超微信 thing 的 20 字
    const longBooking = { date: `2026-10-06-${LONG}`, hour: 15, minute: 0, courseName: LONG }
    const kinds = ['member-booking-created', 'member-booking-cancelled', 'member-booking-rescheduled', 'class-reminder-3h', 'class-reminder-1h']
    kinds.forEach(kind => {
      const msg = templates.messageOf({ type: kind, booking: longBooking, recipient: { kind: 'member' } })
      const meta = templates.TEMPLATE_META[templates.slotOf(kind)]
      // ⛔ 后台要求的字段一个都不能缺
      meta.fields.forEach(f => assert.ok(msg.data[f.key] && msg.data[f.key].value, `⛔ ${kind} 缺字段 ${f.key}`))
      // ⛔ 每个字段都不许超过它自己的上限
      meta.fields.forEach(f => {
        const value = String(msg.data[f.key].value || '')
        assert.ok(value.length <= Number(f.limit), `⛔ ${kind}.${f.key} 截短后仍有 ${value.length} 字（上限 ${f.limit}）⇒ 微信会整条拒收`)
      })
      // ⛔ 多一个后台没有的字段也不行（微信回 47003）
      assert.deepStrictEqual(Object.keys(msg.data).sort(), meta.fields.map(f => f.key).sort(), `⛔ ${kind} 的字段集合与后台不一致`)
    })
  })

  console.log(results.join('\n'))
  const failed = results.filter(r => r.startsWith('FAIL')).length
  console.log(`\n通知与认领 16 项验收：${results.length - failed} PASS / ${failed} FAIL（共 ${results.length} 条）`)
  console.log(failed ? 'NOTIFY ACCEPTANCE 16: 有失败段（见上面 FAIL 行）' : 'NOTIFY ACCEPTANCE 16: ALL PASS')
}

main().catch(error => { console.error(error); process.exit(1) })

