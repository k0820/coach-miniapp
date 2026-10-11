// 「安全自动续跑」专项测试（2026-09-23 第 21 轮）。
//
// 背景：第一条真机受控补发已成功（`ob_29_l5cmqb`，旧号含 4 个 `|` → 迁移号 `mig1_…`，
// revision 147→148，云端 booking 已 done、课时 4→5、income 恰好 1 笔 349.39）。
// 剩下的 14 条如果靠人肉点 14 次，风险不在慢，而在**注意力衰减** —— 所以自动化的判据必须
// 比人更严。这份文件钉的就是"更严"体现在哪：
//
//   ① **逐条**：一次 `step()` 最多一次 execute；每条只授权它自己的 entryId（授权日志可核）；
//   ② **每条强制核验**：回执 succeeded + 已出队 + revision **恰好 +1** + 回执自报版本等于云端当前；
//      动钱的 completeBooking 还要**完课前后的账本差量**恰好"扣一次 / 记一笔 / 收据一条"；
//   ③ **一票否决**：unknown / 查询失败 / processing / 状态陌生 / revision 不推进 / 跳格 / 不连续 /
//      execute>1 / 号非法 / 冻结失效 / 业务账不平 —— 任一命中立即停手，**绝不继续下一条**；
//   ④ **不自由 FIFO**：队首必须与恢复计划逐条一致（复用页面同一份 `resendPrefixCheck`）；
//   ⑤ **不自动迁移、不解冻**：模块结构上没有迁移/解冻/非 step 发送的路径（静态断言）。
const path = require('path')
const fs = require('fs')

const PROJ = path.join(__dirname, '..')
const PAGE_PATH = path.join(PROJ, 'pkg-diag', 'repair-orphan-tombstone', 'repair-orphan-tombstone.js')
const WXML_PATH = path.join(PROJ, 'pkg-diag', 'repair-orphan-tombstone', 'repair-orphan-tombstone.wxml')

// 页面文件在 require 时会调用 Page(...) —— 按项目既有约定先立桩（其它测试同样这么做）。
let pageDefinition = null
global.Page = definition => { pageDefinition = definition }
global.wx = {
  getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {},
  showToast: () => {}, showModal: () => {}, setKeepScreenOn: () => {},
  getAccountInfoSync: () => ({ miniProgram: { appId: 'wx7aa0596956732b35', envVersion: 'develop' } })
}
const auto = require(path.join(PROJ, 'utils', 'resume-auto-driver'))
const rule = require(path.join(PROJ, 'utils', 'request-id-rule'))
// §七 用：页面与门禁是**同一份模块实例**（Node 的 require 缓存），所以测试里立/撤冻结与授权，
// 页面读到的就是同一份状态 —— 这正是能"真把 handler 调起来"的前提。
const guard = require(path.join(PROJ, 'utils', 'production-recovery-guard'))
const page = require(PAGE_PATH)
// 第 23 轮起核验策略与核验器是**页面与测试共用同一份实例**（Node require 缓存）：
// 测试断言的就是线上真跑的那段判据，绝不另写一份"测试专用的更松版本"。
const policyOf = require(path.join(PROJ, 'utils', 'business-verification-policy'))
const verifiers = require(path.join(PROJ, 'utils', 'business-verifiers'))

let pass = 0
let fail = 0
const failures = []
async function test(name, fn) {
  try { await fn(); pass += 1; console.log('PASS  ' + name) }
  catch (error) { fail += 1; failures.push(name + ' :: ' + (error && error.message)); console.log('FAIL  ' + name + '   | ' + (error && error.message)) }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assert failed') }
assert.strictEqual = (actual, expected, message) => assert(actual === expected, (message || '') + ' ｜ 期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual))
assert.deepStrictEqual = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), (message || '') + ' ｜ 期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual))
assert.includes = (list, value, message) => assert((list || []).indexOf(value) >= 0, (message || '') + ' ｜ 缺少 ' + JSON.stringify(value))
assert.notIncludes = (list, value, message) => assert((list || []).indexOf(value) < 0, (message || '') + ' ｜ 不该出现 ' + JSON.stringify(value))
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ── 真实形状的完课账本夹具（来自 2026-09-23 只读取证：补发前 revision 147 / 补发后 148）──
const OFFICIAL = 'booking_d4149d6670a3d944adfd'
const MIGRATED = 'mig1_completeBooking:pending:mth0ctzvs3tljv_x007C_mthcl6gm6hjv4i_x007C_2026-09-19_x007C_12_x007C_0_mu99xswp_7i9m2bop'
const LEDGER_BEFORE = {
  ok: true, readOnly: true, state: 'C_CONTENT_SUCCEEDED_COMPLETE_NOT_SUCCEEDED', dataRevision: 147,
  booking: { bookingId: OFFICIAL, status: 'booked' },
  package: { packageId: 'mthcl6gm6hjv4i', used: 4, remaining: 56, status: 'active' },
  incomes: [],
  receipts: [
    { requestId: 'updateBookingContent_mu99xplb_c_qvjkwrs0', command: 'updateBookingContent', status: 'succeeded', revisionBefore: 135, revisionAfter: 136 },
    { requestId: 'updateBookingContent_mu99xovi_b_4ykoo0zl', command: 'updateBookingContent', status: 'succeeded', revisionBefore: 134, revisionAfter: 135 }
  ]
}
const LEDGER_AFTER = {
  ok: true, readOnly: true, state: 'B_BOTH_COMMANDS_SUCCEEDED', dataRevision: 148,
  booking: { bookingId: OFFICIAL, status: 'done' },
  package: { packageId: 'mthcl6gm6hjv4i', used: 5, remaining: 55, status: 'active' },
  incomes: [{ incomeId: 'income_e2c4aaeead367a142286', bookingId: OFFICIAL, amount: 349.39 }],
  receipts: [
    { requestId: MIGRATED, command: 'completeBooking', status: 'succeeded', revisionBefore: 147, revisionAfter: 148 },
    { requestId: 'updateBookingContent_mu99xplb_c_qvjkwrs0', command: 'updateBookingContent', status: 'succeeded', revisionBefore: 135, revisionAfter: 136 },
    { requestId: 'updateBookingContent_mu99xovi_b_4ykoo0zl', command: 'updateBookingContent', status: 'succeeded', revisionBefore: 134, revisionAfter: 135 }
  ]
}

// ══ 台架：**引擎替身**。它的行为口径照抄 sync-engine / recovery-guard 的三条硬约束 ══
//   ① step 模式：一次调用最多一次 execute；
//   ② **只有被授权的 entryId 能通过**（其余一律 break）⇒ "自由 FIFO" 在这个台架上物理上不可能发生；
//   ③ 成功 = 回执 succeeded；回读失败 ⇒ 只标 settled，**不出队**。
// 另外可按 requestId 指定本次的"命运"（成功 / 结果未知 / 查询失败 / 已成功 / 多写一次…），
// 用来逐个钉住驱动的每一条停手分支。
function worldOf(entries, options) {
  const opt = options || {}
  const state = {
    entries: entries.map(clone),
    revision: Number.isInteger(opt.revision) ? opt.revision : 148,
    receipts: clone(opt.receipts || {}),
    failed: [],
    grant: null,
    grantLog: [],
    executeLog: [],
    purgeLog: [],
    readActiveOk: opt.readActiveOk !== false,
    scenario: Object.assign({}, opt.scenario || {}),
    foreignWrites: [],
    brokenGate: !!opt.brokenGate,
    // ── 云端"业务行"的假件：**业务核验器读的就是它** ──
    //    step 成功时 `applyEffect` 按命令把 payload 落进来（等价于服务端真的改了那一行）。
    //    这样"核验器坏了 / 判据写松了"会让测试变红，而不是被一个永远返回"通过"的假件放过去。
    bookings: clone(opt.bookings || {}),        // 云端正式 bookingId → 该预约的业务字段
    customExercises: clone(opt.customExercises || []),
    idMap: Object.assign({}, opt.idMap || {}),  // 本机临时 id → 云端正式 id
    ledger: clone(opt.ledger || {}),            // 云端正式 bookingId → { before, after, completed }
    readLog: [],
    newIds: {},                                 // entryId → 本次新建实体的云端正式 id（回执 result 用）
    effects: []                                 // 落地的业务副作用（供断言"恰好一次"）
  }
  const entryById = id => state.entries.filter(entry => entry.entryId === id)[0] || null
  const removeEntry = id => { state.entries = state.entries.filter(entry => entry.entryId !== id) }
  // 本机临时 id → 云端正式 id（与页面 `outbox.resolveId` 同口径：查不到就原样返回）。
  const officialOf = raw => { const value = String(raw == null ? '' : raw); return state.idMap[value] || value }
  // ── 只读分页（与页面 `readCollectionRows` 同口径：`{ ok, rows }`）──
  async function readCollection(collection) {
    state.readLog.push('read:' + collection)
    if (opt.readFails && opt.readFails[collection]) return { ok: false, code: 'PAGE_TRANSPORT' }
    if (collection === 'bookings') {
      return { ok: true, rows: Object.keys(state.bookings).map(id => ({ bookingId: id, data: clone(state.bookings[id]) })) }
    }
    if (collection === 'customExercises') {
      return { ok: true, rows: state.customExercises.map(row => ({ customExerciseId: row.customExerciseId, data: clone(row) })) }
    }
    return { ok: true, rows: [] }
  }
  // ── 逐条只读诊断（与页面 `diagnoseBooking` 同口径）：完课差量读的就是它 ──
  //    关键：`before` / `after` 由 `completed` 开关切换 ——
  //    这正好复现"基线必须在**发送前**取"这件事：整批预取会拿到 before，发送前即时取才有意义。
  async function diagnose(bookingId) {
    state.readLog.push('diagnose:' + bookingId)
    if (opt.diagnoseFails) return { ok: false, code: 'DIAGNOSE_REJECTED' }
    const box = state.ledger[bookingId]
    const live = state.bookings[bookingId]
    if (!box && !live) return { ok: false, code: 'DIAGNOSE_REJECTED' }
    const phase = box && box.completed ? 'after' : 'before'
    const base = box ? clone(box[phase] || box.before) : {}
    const result = Object.assign({ state: 'FAKE' }, base)
    result.booking = live ? clone(live) : (base.booking || null)
    return { ok: true, result }
  }
  // 云端读回来的对象**键序与本机 payload 不同** —— 这是 2026-09-23 一手实测的真实形状：
  //   payload 里 item 是 `name,group,sets,reps,weight,minutes`（`exercise-picker` 抛 `{name,group}`、
  //   `session.js:163` 再补 `sets,reps,weight,minutes`），而从云端读回的是字母序
  //   `group,minutes,name,reps,sets,weight`。**数组保序**（动作顺序是业务含义）。
  //   假件必须复现这一点：否则"键序敏感"的核验器在测试里永远绿，而一上真机就误停（本轮的坑）。
  function asServerStores(value) {
    if (Array.isArray(value)) return value.map(asServerStores)
    if (value && typeof value === 'object') {
      const out = {}
      Object.keys(value).sort().forEach(key => { out[key] = asServerStores(value[key]) })
      return out
    }
    return value
  }
  // ── 把命令的业务副作用**真的落到云端假件上**（等价于服务端执行了它）──
  //    没有这一步，核验器读到的永远是"没改过的世界"，测试就会变成"核验器能通过"的自证。
  function applyEffect(entry) {
    const payload = entry.payload || {}
    const command = entry.command
    const note = () => { state.effects.push({ entryId: entry.entryId, command }) }
    if (command === 'rescheduleBooking' || command === 'updateBookingContent' || command === 'completeBooking') {
      const id = officialOf(payload.bookingId)
      const row = state.bookings[id]
      if (!row) return false
      if (command === 'rescheduleBooking') {
        row.date = payload.date; row.hour = payload.hour; row.minute = payload.minute == null ? 0 : payload.minute
      } else if (command === 'updateBookingContent') {
        verifiers.CONTENT_FIELDS.forEach(field => { if (Object.prototype.hasOwnProperty.call(payload, field)) row[field] = asServerStores(clone(payload[field])) })
        // ★ 内容命令的回执**也记在这条 booking 的回执表里** —— 这正是根因现场的真实形状：
        //   完课的回执判据若按"该 booking 的回执总数 +1"来算，这条**合法前置写入**就会被当成异常。
        const box = state.ledger[id]
        if (box) {
          const record = { requestId: entry.requestId, command: 'updateBookingContent', status: 'succeeded' }
          ;['before', 'after'].forEach(phase => { if (box[phase] && Array.isArray(box[phase].receipts)) box[phase].receipts.push(clone(record)) })
        }
      } else {
        row.status = 'done'
        if (state.ledger[id]) state.ledger[id].completed = true
      }
      note(); return true
    }
    if (command === 'createCustomExercise') {
      const id = 'ce_fake_' + String(state.effects.length + 1)
      state.customExercises.push({ customExerciseId: id, name: payload.name, group: payload.group })
      state.newIds[entry.entryId] = id
      note(); return true
    }
    if (command === 'createBooking') {
      const id = 'booking_deadbeef' + String(state.effects.length + 1).padStart(4, '0')
      state.bookings[id] = Object.assign({ id, status: 'booked' }, clone(payload), { studentId: officialOf(payload.studentId), packageId: officialOf(payload.packageId) })
      state.newIds[entry.entryId] = id
      note(); return true
    }
    return false
  }
  function succeededReceipt(entry, revisionAfter) {
    const payload = entry.payload || {}
    const result = entry.command === 'createCustomExercise' || entry.command === 'createBooking'
      ? { customExerciseId: state.newIds[entry.entryId], bookingId: state.newIds[entry.entryId] }
      : { bookingId: officialOf(payload.bookingId) || OFFICIAL }
    return {
      ok: true, found: true, status: 'succeeded',
      response: { ok: true, command: entry.command, requestId: entry.requestId, datasetRevision: revisionAfter, result }
    }
  }
  async function step() {
    const executedBefore = state.executeLog.length
    // ① 收敛 pass（照抄 purgeSettled）：只对被授权、且已 settled 的条目生效；回读失败就原地不动。
    if (state.readActiveOk) {
      state.entries
        .filter(entry => entry.status === 'settled' && state.grant && state.grant.includes(entry.entryId))
        .forEach(entry => { state.purgeLog.push(entry.entryId); removeEntry(entry.entryId) })
    }
    // ② 发送：只发被授权的那一条，且一次调用最多一条（step 模式）。
    let executed = 0, sent = 0, rejected = 0
    for (;;) {
      if (executed >= 1) break
      const sendable = state.entries.filter(entry => entry.status === 'pending' || entry.status === 'unknown')
      if (!sendable.length) break
      const entry = sendable[0]
      if (!(state.grant && state.grant.includes(entry.entryId))) break   // ← 等价于 blocksEntry ⇒ break
      executed += 1
      const mode = state.scenario[entry.requestId] || 'ok'
      state.executeLog.push({ entryId: entry.entryId, requestId: entry.requestId, mode })
      if (mode === 'unknown') { entry.status = 'unknown'; entry.attempts = Number(entry.attempts || 0) + 1; continue }
      if (mode === 'rejected') {
        state.entries = state.entries.filter(item => item.entryId !== entry.entryId)
        state.failed = state.failed.concat([{ entryId: entry.entryId, code: 'CLOUD_REJECTED' }])
        state.receipts[entry.requestId] = { ok: true, found: false }
        rejected += 1
        continue
      }
      // 成功族：revision 的推进方式按 mode 变，用来钉住"账本判据"。
      if (mode === 'okRevisionJump2') state.revision += 2
      else if (mode === 'okNoRevision') { /* 一个字节都不动 */ }
      else state.revision += 1
      // `okNoEffect` = 回执说成功、revision 也 +1，但**业务行没有真的改** ——
      // 这是反向对照：专门用来证明"业务级核验"不是装饰（没有它这条会被判通过）。
      if (mode !== 'okNoEffect') applyEffect(entry)
      const reported = mode === 'okStaleReceipt' ? state.revision - 1 : state.revision
      state.receipts[entry.requestId] = succeededReceipt(entry, reported)
      if (mode === 'okSettled') entry.status = 'settled'
      else removeEntry(entry.entryId)
      sent += 1
    }
    const executedTotal = state.executeLog.length - executedBefore
    return { ok: rejected === 0, sent, rejected, executed: state.brokenGate ? executedTotal + 1 : executedTotal, remaining: state.entries.length }
  }
  function receiptOf(requestId) {
    const mode = state.scenario[requestId]
    if (mode === 'queryfail') return { ok: false, found: false, status: null, response: null, code: 'RECEIPT_CALL_FAILED', reason: 'CLOUD_CALL_FAILED' }
    if (mode === 'processing') return { ok: true, found: true, status: 'processing', response: null }
    if (mode === 'weird') return { ok: true, found: true, status: 'zip', response: null }
    if (state.receipts[requestId]) return clone(state.receipts[requestId])
    return { ok: true, found: false, status: null, response: null }
  }
  return {
    state, step, receiptOf, entryById, removeEntry, readCollection, diagnose, officialOf,
    sendable: () => state.entries.filter(entry => entry.status === 'pending' || entry.status === 'unknown'),
    settled: () => state.entries.filter(entry => entry.status === 'settled'),
    all: () => state.entries
  }
}
// 依赖注入（与页面 `autoDepsOf` 同口径：判据全部复用页面/规则模块的**同一份**实现）。
function depsOf(world, extras) {
  return Object.assign({
    now: () => 1790128000000,
    delay: () => Promise.resolve(),
    frozen: () => true,
    shouldStop: () => false,
    queue: () => world.sendable(),
    settledEntries: () => world.settled(),
    entryById: id => world.entryById(id),
    grant: (ids, label) => { world.state.grant = ids.map(String); world.state.grantLog.push({ ids: ids.map(String), label: String(label || '') }) },
    clearGrant: () => { world.state.grant = null; world.state.clearCount = Number(world.state.clearCount || 0) + 1 },
    grantIsClear: () => world.state.grant === null,
    step: () => world.step(),
    receiptOf: id => Promise.resolve(world.receiptOf(id)),
    classifyReceipt: receipt => page.resendReceiptState(receipt),
    prefixCheck: entries => page.resendPrefixCheck(entries, page.RESEND_PLAN),
    requestIdVerdict: value => rule.requestIdVerdict(value),
    revision: () => Promise.resolve(world.state.revision),
    markPending: id => { const entry = world.entryById(id); if (entry) entry.nextAttemptAt = 0 },
    markSettled: id => { const entry = world.entryById(id); if (entry) entry.status = 'settled' },
    businessCheck: () => ({ checked: false, ok: null, reason: '未配置业务级核验' }),
    onRow: () => {}
    // ★ 业务核验三件套在**默认值之后、extras 之前**注入 ⇒ 单个测试仍可按需覆盖其中一件（做反向对照）。
  }, businessDepsOf(world), extras || {})
}
// 云端正式 bookingId 的解析（与页面 `officialBookingIdOf` 逐字同口径）。
function officialBookingIdOf(entry, resolve) {
  const raw = String(((entry && entry.payload) || {}).bookingId || '')
  if (!raw) return ''
  let resolved = raw
  try { resolved = String(resolve(raw) || '') } catch (error) { resolved = '' }
  return /^booking_[0-9a-f]{8,}$/.test(resolved) ? resolved : ''
}
// ★ 业务核验三件套的注入：与页面 `autoDepsOf` **同一份模块、同一套判据**，
//   而不是测试里另写一份"更松"的替身（否则测试绿了线上照样停手，等于没测）。
function businessDepsOf(world) {
  return {
    // ① 发前门禁：策略没点名到已实现的核验器 ⇒ 这条根本不发。
    businessPolicy: entry => policyOf.preflightOf(entry && entry.command),
    // ② 发前取基线（只读）：只有差量类核验（completion-ledger）需要；取不到 ⇒ 不发。
    businessPrepare: (entry, requirement) => {
      const policy = requirement || policyOf.requirementOf(entry && entry.command)
      if (!policy.required) return Promise.resolve({ ok: true, baseline: null })
      if (policy.verifier !== 'completion-ledger') return Promise.resolve({ ok: true, baseline: null })
      const official = officialBookingIdOf(entry, raw => world.officialOf(raw))
      if (!official) return Promise.resolve({ ok: false, code: 'BUSINESS_VERIFY_UNAVAILABLE', message: '这条完课的云端 bookingId 定位不到' })
      return Promise.resolve(world.diagnose(official)).then(answer => {
        if (!answer.ok) return { ok: false, code: 'BASELINE_DIAGNOSE_FAILED', message: '发送前的只读基线诊断失败：' + answer.code }
        return { ok: true, baseline: verifiers.completionLedgerOf(answer.result) }
      })
    },
    // ③ 发后核验：交给策略点名的核验器（判据在 utils/business-verifiers，唯一一份）。
    businessCheck: (entry, context) => verifiers.verifyEntry({
      entry,
      requirement: (context && context.requirement) || policyOf.requirementOf(entry && entry.command),
      baseline: (context && context.baseline) || null,
      receiptResult: (context && context.receiptResult) || null,
      deps: { diagnose: id => world.diagnose(id), readCollection: name => world.readCollection(name), resolveId: raw => world.officialOf(raw) }
    })
  }
}
// 计划顺序里的连续三条（复原计划：袁梦琪改期 → 4 个自定义动作 → 司马赞奇内容/完课）。
function entryOf(entryId, command, requestId, payload) {
  return {
    entryId, seq: 1, datasetId: 'candidate_f971f032ca88dc3a2b656a6654d9a314', environment: 'production',
    command, payload: clone(payload || {}), requestId, status: 'pending', attempts: 0, nextAttemptAt: 0, localIds: {}, failed: null
  }
}
const SAFE = 'row_one_aaaa_1111'
// ── 三条样本命令对应的**云端真身**（核验器读的就是它们）──
//    本机临时 id → 云端正式 id 是横切关注点（表单/弹层 id、页面 this.id、渲染别名、挂在 id 上的意图，
//    四处都要），所以测试里也显式建出来：`idMap` 就是页面 `outbox.resolveId` 的等价物。
const LOCAL_BOOKING = 'local_bk_yuan_0001'
const OFFICIAL_2A = 'booking_a1b2c3d4e5f60718'   // 袁梦琪那条（改期目标）
const OFFICIAL_2L = 'booking_1f2e3d4c5b6a7980'   // 司马赞奇那条（内容目标）
function officialBookings() {
  return {
    [OFFICIAL_2A]: { id: OFFICIAL_2A, studentId: 'stu_yuan', packageId: 'pkg_yuan', date: '2026-09-22', hour: 9, minute: 0, items: [], notes: '', category: '', duration: 60, summary: '', status: 'booked' },
    [OFFICIAL_2L]: { id: OFFICIAL_2L, studentId: 'stu_sima', packageId: 'pkg_sima', date: '2026-09-22', hour: 10, minute: 0, items: [], notes: '', category: '', duration: 60, summary: '', status: 'booked' }
  }
}
// 生产的**真实 item 形状**（键序就是 App 的构造序：`exercise-picker` 抛 `{name,group}`，
// `session.js:163` 再补 `sets,reps,weight,minutes`）。⚠️ 用它而不是 `{name,sets}`：
// 后者按键排序后**顺序不变**，对"键序敏感"这个缺陷**没有判别力**。
const PRODUCTION_ITEMS = [
  { name: '双手哑铃划船', group: '背', sets: 4, reps: 12, weight: '7.5', minutes: '' },
  { name: '杠铃划船', group: '背', sets: 4, reps: 12, weight: '20', minutes: '' }
]
function threeInPlanOrder(over) {
  const rows = [
    entryOf('ob_2a_bhku2v', 'rescheduleBooking', SAFE + '_a', { bookingId: LOCAL_BOOKING, date: '2026-09-24', hour: 15, minute: 0 }),
    entryOf('ob_2b_1a2b3c', 'createCustomExercise', SAFE + '_b', { name: '壶铃摇摆', group: '臀腿' }),
    entryOf('ob_2l_jl9mja', 'updateBookingContent', SAFE + '_c', { bookingId: OFFICIAL_2L, items: PRODUCTION_ITEMS, category: '力量', duration: 60 })
  ]
  return (over || []).length ? rows.map((row, index) => Object.assign(row, (over || [])[index] || {})) : rows
}
// 三条样本命令的**业务侧台架**（引擎行为与 `worldOf` 逐字相同，只是预置了云端业务行与 idMap）。
function worldFor(entries, options) {
  return worldOf(entries, Object.assign({
    revision: 148,
    idMap: { [LOCAL_BOOKING]: OFFICIAL_2A, [OFFICIAL_2A]: OFFICIAL_2A, [OFFICIAL_2L]: OFFICIAL_2L },
    bookings: officialBookings()
  }, options || {}))
}
// ── 完课（动钱）的真身夹具 ──
//    补发前：只有内容回执；补发后：外加一条**本次 requestId** 的完课回执 + 一笔收入 + 课时 4→5。
//    `mutate` 用来把某一格改坏（反向对照：改坏了就必须停手）。
const OFFICIAL_29 = 'booking_29abcdef01234567'
const COMPLETE_REQUEST = SAFE + '_z'
function completionBox(mutate) {
  const box = {
    before: {
      state: 'C_CONTENT_SUCCEEDED_COMPLETE_NOT_SUCCEEDED',
      booking: { bookingId: OFFICIAL_29, status: 'booked' },
      package: { packageId: 'pkg_zhuge', used: 4, remaining: 56, status: 'active' },
      incomes: [],
      receipts: [{ requestId: 'updateBookingContent_prev_1', command: 'updateBookingContent', status: 'succeeded' }]
    },
    after: {
      state: 'B_BOTH_COMMANDS_SUCCEEDED',
      booking: { bookingId: OFFICIAL_29, status: 'done' },
      package: { packageId: 'pkg_zhuge', used: 5, remaining: 55, status: 'active' },
      incomes: [{ incomeId: 'income_new_1', bookingId: OFFICIAL_29, amount: 349.39 }],
      receipts: [
        { requestId: COMPLETE_REQUEST, command: 'completeBooking', status: 'succeeded' },
        { requestId: 'updateBookingContent_prev_1', command: 'updateBookingContent', status: 'succeeded' }
      ]
    },
    completed: false
  }
  if (mutate) mutate(box)
  return box
}
function completionWorld(mutate, options) {
  const bookings = officialBookings()
  bookings[OFFICIAL_29] = {
    id: OFFICIAL_29, studentId: 'stu_zhuge', packageId: 'pkg_zhuge', date: '2026-09-19', hour: 12, minute: 0,
    items: [], notes: '', category: '', duration: 60, summary: '', status: 'booked'
  }
  return worldFor([entryOf('ob_29_l5cmqb', 'completeBooking', COMPLETE_REQUEST, { bookingId: OFFICIAL_29 })], Object.assign({
    ledger: { [OFFICIAL_29]: completionBox(mutate) },
    bookings
  }, options || {}))
}

async function main() {
  // ═══ 一、全绿路径：逐条、每条一条授权、跑空为止 ═══
  await test('① 三条连续成功：逐条推进到队列空，每条 executed=1、revision 恰好 +1', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148 })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'QUEUE_EMPTY', '跑空才算正常收尾')
    assert.strictEqual(report.entriesRun, 3, '推进条数')
    assert.strictEqual(world.all().length, 0, '队列必须空')
    assert.deepStrictEqual(world.state.executeLog.map(row => row.entryId), ['ob_2a_bhku2v', 'ob_2b_1a2b3c', 'ob_2l_jl9mja'], '发送顺序必须等于队列顺序')
    report.rows.forEach((row, index) => {
      assert.strictEqual(row.ok, true, '第 ' + (index + 1) + ' 条必须通过核验')
      assert.strictEqual(row.executed, 1, '每条恰好一次 execute')
      assert.strictEqual(row.revisionAfter, row.revisionBefore + 1, 'revision 恰好 +1')
      assert.strictEqual(row.leftQueue, true, '必须出队')
    })
  })

  await test('② 授权只点名当前这一条：授权日志与发送日志一一对应（自由 FIFO 物理上不存在）', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148 })
    await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(world.state.grantLog.length, 3, '每条一次授权')
    world.state.grantLog.forEach(row => assert.strictEqual(row.ids.length, 1, '每次授权只能点名一条 entryId'))
    assert.deepStrictEqual(world.state.grantLog.map(row => row.ids[0]), world.state.executeLog.map(row => row.entryId), '授权与发送必须一一对应')
    assert.strictEqual(world.state.clearCount, 3, '每条发完都要关闸')
    assert.strictEqual(world.state.grant, null, '收尾时授权必须已清')
  })

  // ═══ 二、一条不确定 ⇒ 全体停手（绝不继续下一条）═══
  await test('③ 第二条「结果未知」⇒ 停在第 2 条，第三条一次都不发', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148, scenario: { [SAFE + '_b']: 'unknown' } })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'VERIFY_FAILED', '结论码')
    assert.strictEqual(report.entriesRun, 2, '只推进两条')
    assert.strictEqual(report.rows[1].ok, false, '第二条未通过')
    assert.includes(report.rows[1].failedChecks, 'leftQueue', '必须报出"仍在队列里"')
    assert.strictEqual(world.state.executeLog.length, 2, '第三条绝不能发')
    assert.strictEqual(world.all().length, 2, '第二条留在队列里等着人来判断')
  })

  await test('④ 第一条回执「查询失败」⇒ **0 次 execute** 就停手（不知道就不动）', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148, scenario: { [SAFE + '_a']: 'queryfail' } })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'RECEIPT_QUERY_FAILED', '结论码必须与"没收到"区分开')
    assert.strictEqual(world.state.executeLog.length, 0, '一条都不许发')
    assert.strictEqual(report.entriesRun, 0, '没有推进任何条目')
  })

  await test('⑤ 回执 processing / 状态陌生 ⇒ 0 次 execute 停手（两个结论码必须不同）', async () => {
    const w1 = worldFor(threeInPlanOrder(), { revision: 148, scenario: { [SAFE + '_a']: 'processing' } })
    const r1 = await auto.runAutoContinue(depsOf(w1))
    assert.strictEqual(r1.code, 'RECEIPT_PROCESSING', 'processing 的结论码')
    assert.strictEqual(w1.state.executeLog.length, 0, '不许发')
    const w2 = worldFor(threeInPlanOrder(), { revision: 148, scenario: { [SAFE + '_a']: 'weird' } })
    const r2 = await auto.runAutoContinue(depsOf(w2))
    assert.strictEqual(r2.code, 'RECEIPT_UNKNOWN_STATUS', '状态陌生的结论码')
    assert.notIncludes([r1.code, r2.code], 'RECEIPT_NOT_FOUND', '绝不能把它们渲染成"云端没有这一行"')
  })

  await test('⑥ revision 没推进 ⇒ 停手（云端的账本没动，就不是这次提交）', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148, scenario: { [SAFE + '_a']: 'okNoRevision' } })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'VERIFY_FAILED', '结论码')
    assert.includes(report.rows[0].failedChecks, 'revisionAdvancedOnce', '必须报出 revision 未 +1')
    assert.strictEqual(world.state.executeLog.length, 1, '只发了这一条就停')
  })

  await test('⑦ 一次提交把 revision 推了 2 格 ⇒ 停手（多写了一次 = 业务账不平）', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148, scenario: { [SAFE + '_a']: 'okRevisionJump2' } })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'VERIFY_FAILED', '结论码')
    assert.includes(report.rows[0].failedChecks, 'revisionAdvancedOnce', '必须报出"不是恰好 +1"')
  })

  await test('⑧ 回执自报版本 ≠ 云端当前版本 ⇒ 停手（这一格不属于这次提交）', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148, scenario: { [SAFE + '_a']: 'okStaleReceipt' } })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'VERIFY_FAILED', '结论码')
    assert.includes(report.rows[0].failedChecks, 'receiptRevisionMatches', '必须报出版本对不上')
  })

  await test('⑨ 跨条目 revision 不连续（背后有人写）⇒ 第 2 条起手就停手', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148 })
    const deps = depsOf(world, {
      // 第 1 条刚核验完，云端的 revision 被别人推走了 2 格。
      onRow: row => { world.state.foreignWrites.push(row.entryId); world.state.revision += 2 }
    })
    const report = await auto.runAutoContinue(deps)
    assert.strictEqual(report.code, 'VERIFY_FAILED', '结论码')
    assert.strictEqual(report.entriesRun, 2, '第 2 条要发出去并被判未通过')
    assert.includes(report.rows[1].failedChecks, 'revisionContinuous', '必须报出"期间有别的写入"')
  })

  await test('⑩ 引擎自报 execute>1（闸门被改坏）⇒ 停手', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148, brokenGate: true })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'VERIFY_FAILED', '结论码')
    assert.includes(report.rows[0].failedChecks, 'executedOne', '必须报出 execute 不是 1')
    assert.strictEqual(world.state.executeLog.length, 1, '真实只发了 1 条，但自报 2 ⇒ 一定要停下来说清楚')
  })

  await test('⑪ 回执已 succeeded 的条目 ⇒ 只收敛出队（0 次 execute、revision 不动），然后继续下一条', async () => {
    const world = worldFor(threeInPlanOrder(), {
      revision: 148,
      receipts: { [SAFE + '_a']: { ok: true, found: true, status: 'succeeded', response: { ok: true, command: 'rescheduleBooking', requestId: SAFE + '_a', datasetRevision: 147 } } }
    })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.rows[0].mode, 'converged', '第一条走收敛路径')
    assert.strictEqual(report.rows[0].executed, 0, '收敛路径必须 0 次 execute')
    assert.strictEqual(report.rows[0].leftQueue, true, '必须被清出队列（否则挡住 FIFO 队首）')
    assert.strictEqual(report.entriesRun, 3, '收敛之后仍要继续推进剩下的')
  })

  await test('⑫ settled 条目挡在队首 ⇒ 先用"0 execute 的收敛 pass"清掉，再继续发送', async () => {
    const rows = threeInPlanOrder()
    rows.unshift(Object.assign(entryOf('ob_29_l5cmqb', 'completeBooking', SAFE + '_z'), { status: 'settled' }))
    const world = worldFor(rows, { revision: 148 })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'QUEUE_EMPTY', '清干净后要把剩下的推完')
    assert.deepStrictEqual(world.state.purgeLog, ['ob_29_l5cmqb'], 'settled 条目必须靠收敛 pass 清出')
    assert.strictEqual(world.state.executeLog.length, 3, '收敛 pass 不许掺进任何一次 execute')
  })

  // ═══ 三、秩序与边界（不自由 FIFO / 不自动迁移 / 不解冻在无冻结下跑）═══
  await test('⑬ 队首与恢复计划不符（跳条/乱序）⇒ 0 次 execute 停手', async () => {
    const rows = threeInPlanOrder()
    rows.reverse()
    const world = worldOf(rows, { revision: 148 })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'RESEND_ORDER_MISMATCH', '结论码')
    assert.strictEqual(world.state.executeLog.length, 0, '一条都不许发')
  })

  await test('⑭ 队首 requestId 非法 ⇒ 0 次 execute 停手；**绝不自动迁移**（不换号）', async () => {
    const rows = threeInPlanOrder()
    rows[0].requestId = 'completeBooking:pending:mtfe64ce5l0wwn|mthcl6gmkl9nng|2026-09-19|12|0_mu99xswp_7i9m2bop'
    const world = worldOf(rows, { revision: 148 })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'REQUEST_ID_ILLEGAL', '结论码')
    assert.strictEqual(world.state.executeLog.length, 0, '一条都不许发')
    assert.strictEqual(world.entryById('ob_2a_bhku2v').requestId, rows[0].requestId, '号必须原样不动（自动续跑没有换号权限）')
    const source = stripComments(fs.readFileSync(path.join(PROJ, 'utils', 'resume-auto-driver.js'), 'utf8'))
    assert(!/requestId-rule/.test(source), '驱动不得引入迁移/规则模块去改号')
  })

  await test('⑮ 冻结未生效 ⇒ 拒绝启动，0 次 execute', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148 })
    const report = await auto.runAutoContinue(depsOf(world, { frozen: () => false }))
    assert.strictEqual(report.code, 'NOT_FROZEN', '结论码')
    assert.strictEqual(world.state.executeLog.length, 0, '一条都不许发')
    assert.strictEqual(world.state.grantLog.length, 0, '连授权都不该立')
  })

  await test('⑯ 运行中冻结失效 ⇒ 停手（绝不在无冻结状态下继续发送）', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148 })
    let calls = 0
    const report = await auto.runAutoContinue(depsOf(world, { frozen: () => { calls += 1; return calls <= 2 } }))
    assert.strictEqual(report.code, 'FREEZE_LOST', '结论码')
    assert.strictEqual(world.state.executeLog.length, 1, '第一条之后立刻停手')
  })

  await test('⑰ 操作员点停止 ⇒ 在"下一条之前"停手（不半途打断正在发的那条）', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148 })
    let rows = 0
    const report = await auto.runAutoContinue(depsOf(world, {
      shouldStop: () => rows > 0,
      onRow: () => { rows += 1 }
    }))
    assert.strictEqual(report.code, 'USER_STOPPED', '结论码')
    assert.strictEqual(report.entriesRun, 1, '只完成已开始的那一条')
    assert.strictEqual(world.state.executeLog.length, 1, '不许开第二条')
  })

  await test('⑱ 条数上界 ⇒ 收在 ENTRY_LIMIT（留档、可再启动继续，而不是偷偷跑完）', async () => {
    const rows = threeInPlanOrder()
    rows.push(entryOf('ob_2m_i35al3', 'completeBooking', SAFE + '_d'))
    const world = worldFor(rows, { revision: 148 })
    const report = await auto.runAutoContinue(depsOf(world), { maxEntries: 2 })
    assert.strictEqual(report.code, 'ENTRY_LIMIT', '结论码')
    assert.strictEqual(report.entriesRun, 2, '只跑上界这么多')
    assert.strictEqual(world.all().length, 2, '剩下的留在队列里')
  })

  // ═══ 四、动钱的命令：账本差量必须能对上 ═══
  await test('⑲ 完课账本差量（真实取证数据）⇒ 通过：课时恰好扣一次、收入恰好记一笔、回执恰好一条', async () => {
    const before = page.completionLedgerOf(LEDGER_BEFORE)
    const after = page.completionLedgerOf(LEDGER_AFTER)
    assert.strictEqual(before.used, 4, '补发前 used')
    assert.strictEqual(after.used, 5, '补发后 used')
    assert.strictEqual(after.incomeCount, 1, '恰好一笔收入')
    assert.strictEqual(after.completionReceiptIds.length, 1, '恰好一条完课回执')
    assert.strictEqual(rule.isLegalRequestId(MIGRATED), true, '迁移号本身合法')
    const delta = page.completionLedgerDelta(before, after, MIGRATED)
    assert.strictEqual(delta.ok, true, '真实数据必须判通过：' + delta.notes.join('；'))
  })

  await test('⑳ 账本差量：课时没扣 / 收入多记 / 重复回执 —— 各自必须被判不通过', async () => {
    const before = page.completionLedgerOf(LEDGER_BEFORE)
    const noDeduct = clone(LEDGER_AFTER); noDeduct.package.used = 4; noDeduct.package.remaining = 56
    const d1 = page.completionLedgerDelta(before, page.completionLedgerOf(noDeduct), MIGRATED)
    assert.strictEqual(d1.ok, false, '没扣课必须不通过')
    assert.includes(d1.notes.join('；'), '重复扣课', '结论要说人话')
    const doubleIncome = clone(LEDGER_AFTER); doubleIncome.incomes.push({ incomeId: 'income_duplicate', bookingId: OFFICIAL, amount: 349.39 })
    const d2 = page.completionLedgerDelta(before, page.completionLedgerOf(doubleIncome), MIGRATED)
    assert.strictEqual(d2.ok, false, '重复记收入必须不通过')
    assert.includes(d2.notes.join('；'), '重复记收入', '结论要说人话')
    const dupReceipt = clone(LEDGER_AFTER); dupReceipt.receipts.unshift(clone(dupReceipt.receipts[0]))
    const d3 = page.completionLedgerDelta(before, page.completionLedgerOf(dupReceipt), MIGRATED)
    assert.strictEqual(d3.ok, false, '重复回执必须不通过')
    assert.includes(d3.notes.join('；'), '重复回执', '结论要说人话')
    const noBaseline = page.completionLedgerDelta(null, page.completionLedgerOf(LEDGER_AFTER), MIGRATED)
    assert.strictEqual(noBaseline.ok, false, '没有基线也必须不通过（不做无基线的差量判断）')
  })

  await test('㉑ 完课：**发送前**的只读基线取不到 ⇒ 一条都不发（不是"发完才发现核不平"）', async () => {
    // 队首必须是**动钱**的 completeBooking，才谈得上业务核验（计划里那条单独的 `zhuge-done` 就是这个位置）。
    // ① 云端 bookingId 定位不到（本机临时 id 还没转正）⇒ 差量公式的分子分母都无从谈起。
    const noId = worldFor([entryOf('ob_29_l5cmqb', 'completeBooking', COMPLETE_REQUEST, {})], { revision: 148 })
    const r1 = await auto.runAutoContinue(depsOf(noId))
    assert.strictEqual(r1.code, 'BUSINESS_VERIFY_UNAVAILABLE', '结论码（定位不到 ⇒ 拒发）')
    assert.strictEqual(noId.state.executeLog.length, 0, '★一条都不许发')
    assert.strictEqual(r1.stop.sent, false, '报告必须明确"没有发送"')

    // ② 只读诊断本身失败 ⇒ 同样在**发之前**拦住。
    const noBase = completionWorld(null, { diagnoseFails: true })
    const r2 = await auto.runAutoContinue(depsOf(noBase))
    assert.strictEqual(r2.code, 'BASELINE_DIAGNOSE_FAILED', '结论码（基线诊断失败 ⇒ 拒发）')
    assert.strictEqual(noBase.state.executeLog.length, 0, '★一条都不许发')
  })

  await test('㉑′ 完课：核验真的跑了、且账不平 ⇒ VERIFY_FAILED 并停手（记账多一笔就是多一笔）', async () => {
    // 反向对照：把"补发后"的收入改成 2 笔 ⇒ 只有业务级核验抓得到（回执 + 队列 + revision 全都正常）。
    const world = completionWorld(box => { box.after.incomes.push({ incomeId: 'income_dup', bookingId: OFFICIAL_29, amount: 349.39 }) })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'VERIFY_FAILED', '结论码')
    assert.strictEqual(report.rows[0].business.checked, true, '业务核验必须被标记为"做了"')
    assert.strictEqual(report.rows[0].business.ok, false, '并且不通过')
    assert.includes(report.rows[0].failedChecks, 'business', '失败格子就是业务账')
    assert.includes(report.stop.failedNotes.join('；'), '重复记收入', '停手理由必须自带证据（人话）')
    assert.strictEqual(world.state.executeLog.length, 1, '第一条就停手')
  })

  await test('㉑″ 完课：账正好平 ⇒ 一路通过（这才是恢复计划里 `zhuge-done` 那条的样子）', async () => {
    const world = completionWorld()
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'QUEUE_EMPTY', '账平就该正常收尾')
    assert.strictEqual(report.rows[0].business.checked, true, '必须真的执行了核验')
    assert.strictEqual(report.rows[0].business.ok, true, '并且通过')
    assert.strictEqual(world.state.bookings[OFFICIAL_29].status, 'done', '业务行确实变成了 done')
    assert.strictEqual(world.state.effects.length, 1, '业务副作用恰好一次')
  })

  await test('㉒ `verifySent` 三种状态必须一眼可辨：通过 / 未通过 / 未执行（策略要求）—— 且"按策略无需"绝不进失败清单', async () => {
    const base = {
      executed: 1, leftQueue: true, command: 'createStudent', requestId: SAFE + '_s',
      receiptStatus: 'succeeded', receiptLabel: '云端已确认', receiptCommand: 'createStudent', receiptRequestId: SAFE + '_s',
      receiptDatasetRevision: 149, revisionBefore: 148, revisionAfter: 149, expectedRevisionBefore: null
    }
    // ① 按策略无需核验：**中性**，不是失败（旧版会把它渲染成红字，现场读成了停手原因）。
    const neutral = auto.verifySent(Object.assign({}, base, { businessRequired: false, businessChecked: false, businessOk: false, businessReason: '只新增独立行' }))
    assert.strictEqual(neutral.ok, true, '按策略无需核验不该算失败')
    assert.notIncludes(neutral.failed, 'business', '不许进失败清单')
    assert.strictEqual(auto.businessTextOf({ business: { checked: false, required: false } }), '按策略无需', '界面上必须是中性说明')
    // ② 策略**要求**核验、但本步没做 ⇒ 必须失败（这正是上一版被静默放过的那种静默故障）。
    const missing = auto.verifySent(Object.assign({}, base, { businessRequired: true, businessChecked: false, businessOk: false, businessReason: '' }))
    assert.strictEqual(missing.ok, false, '策略要求却没做 ⇒ 必须失败')
    assert.includes(missing.failed, 'businessChecked', '必须报出"没执行核验"这个具体格子')
    assert.strictEqual(auto.businessTextOf({ business: { checked: false, required: true } }), '未执行（策略要求）', '界面必须与"按策略无需"可辨')
    // ③ 做了但不通过 ⇒ 必须失败，且理由要落进证据。
    const failed = auto.verifySent(Object.assign({}, base, { businessRequired: true, businessChecked: true, businessOk: false, businessReason: '收入不是恰好 +1 条' }))
    assert.strictEqual(failed.ok, false, '做了但不通过 ⇒ 必须失败')
    assert.includes(failed.failed, 'business')
    assert.includes(failed.failedNotes.join('；'), '收入不是恰好 +1 条', '停手理由必须自带证据')
    // ④ 做了且通过 ⇒ 唯一的绿色状态。
    const passed = auto.verifySent(Object.assign({}, base, { businessRequired: true, businessChecked: true, businessOk: true, businessReason: '账平' }))
    assert.strictEqual(passed.ok, true, '做了且通过 ⇒ 通过')
    assert.strictEqual(auto.businessTextOf({ business: { checked: true, ok: true } }), '通过')
    assert.strictEqual(auto.businessTextOf({ business: { checked: true, ok: false } }), '未通过')
  })

  // ═══ 四′、核验策略（22 条业务命令）：**声明**必须与真实命令清单逐条对齐 ═══
  await test('㊴ 核验策略与云端真实 handlers **逐条对齐**：不多不少 23 条，且每条都有明确层级与理由', async () => {
    const source = fs.readFileSync(path.join(PROJ, 'cloudfunctions', 'coachBusinessCommand', 'handlers.js'), 'utf8')
    const body = source.slice(source.indexOf('const handlers = {'), source.indexOf('module.exports'))
    const real = []
    body.replace(/^\s{2}async\s+([A-Za-z][A-Za-z0-9]*)\s*\(/gm, (hit, name) => { real.push(name); return hit })
    assert.strictEqual(real.length, 31, '云端业务命令就是 31 条（这份数字是判据，不是装饰）')
    assert.deepStrictEqual(Object.keys(policyOf.POLICY).sort(), real.slice().sort(),
      '策略必须覆盖**恰好**这 31 条 —— 云端加了新命令而策略没跟上，就是"有一条命令没有人定义它的核验"')

    const blocked = []
    real.forEach(command => {
      const requirement = policyOf.requirementOf(command)
      assert(requirement.level === 'required' || requirement.level === 'receipt-only', command + ' 必须有明确层级')
      assert(!!requirement.why, command + ' 必须写清"为什么要/不要核验"')
      assert(!!requirement.effect, command + ' 必须写清"它到底改了什么"')
      if (requirement.level === 'required' && requirement.implemented !== true) blocked.push(command)
      if (requirement.level === 'required' && requirement.implemented === true) {
        assert.strictEqual(policyOf.preflightOf(command).ok, true, command + ' 核验器已实现 ⇒ 必须放行')
      }
    })
    assert(blocked.length > 0, '确实存在"必须核验但暂无核验器"的命令 —— 它们必须被**拒发**而不是放过')
    // 恢复计划里真正要用到的 5 条命令：一条都不许被拦（否则自动续跑一步都走不了）。
    ;['completeBooking', 'rescheduleBooking', 'updateBookingContent', 'createBooking', 'createCustomExercise'].forEach(command => {
      assert.strictEqual(policyOf.requirementOf(command).level, 'required', command + ' 必须是 required（有真实业务副作用）')
      assert.strictEqual(policyOf.preflightOf(command).ok, true, command + ' 必须可发')
    })
    // 未知命令 = **最严**：既不知道它改什么，也不可能有核验器。
    assert.strictEqual(policyOf.preflightOf('deleteEverything').ok, false, '未知命令必须拒发')
    assert.strictEqual(policyOf.preflightOf('').ok, false, '空命令名必须拒发')
    assert.strictEqual(policyOf.preflightOf(undefined).ok, false, '没有命令名必须拒发')
  })

  await test('㊵ 策略：动钱 / 改写既有行且暂无核验器的命令 —— 整队体检必须逐条列出来', async () => {
    const req = command => entryOf('ob_q_' + command, command, SAFE + '_q')
    const queue = ['deleteCompletedBooking', 'reverseCourseSale', 'updatePackage', 'deletePackage', 'cancelBooking', 'saveSettings'].map(req)
    const report = policyOf.preflightQueue(queue)
    assert.strictEqual(report.ok, false, '这一队里确实有会被拒的条目')
    assert.strictEqual(report.total, 6)
    assert.strictEqual(report.blocked.length, 6, '逐条都要列出来（不能只报第一条）')
    report.blocked.forEach(row => {
      assert.strictEqual(row.code, 'BUSINESS_VERIFY_UNAVAILABLE', row.command + ' 的结论码')
      assert(/不发/.test(row.message), row.command + ' 的文案必须明确"不发"')
    })
    // 反向：能核验的命令一起体检必须是绿的。
    assert.strictEqual(policyOf.preflightQueue(['rescheduleBooking', 'completeBooking'].map(req)).ok, true, '可核验的命令必须放行')
  })

  await test('㊶ 反向对照：**摘掉策略注入** ⇒ 拒绝启动、0 次 execute（绝不"没策略就当真、逐条放过"）', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148 })
    const report = await auto.runAutoContinue(depsOf(world, { businessPolicy: undefined }))
    assert.strictEqual(report.code, 'POLICY_NOT_INJECTED', '结论码')
    assert.strictEqual(report.gates.policyInjected, false, '报告必须印出"策略未注入"')
    assert.strictEqual(world.state.executeLog.length, 0, '一条都不许发')
    assert(/★未注入★/.test(auto.autoRunTextOf(report)), '人读报告里必须一眼看到"未注入"')
  })

  await test('㊷ 反向对照：策略判"不可核验" ⇒ **发之前**拦下（不可逆的写入一次都不发生）', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148 })
    const report = await auto.runAutoContinue(depsOf(world, {
      businessPolicy: entry => ({ ok: false, code: 'BUSINESS_VERIFY_UNAVAILABLE', requirement: policyOf.requirementOf('deleteCompletedBooking'), message: '这条命令还没有可用的只读核验器' })
    }))
    assert.strictEqual(report.code, 'BUSINESS_VERIFY_UNAVAILABLE', '结论码')
    assert.strictEqual(world.state.executeLog.length, 0, '★关键：一条都没发出去 —— 不是"发完才发现核不了"')
    assert.strictEqual(report.stop.sent, false, '报告必须明确"没有发送"')
    assert.strictEqual(world.all().length, 3, '队列一个字没动')
  })

  await test('㊸ 反向对照：改期回执 succeeded、revision 恰好 +1，但**云端时间没变** ⇒ 停手并报出期望 vs 实际', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148, scenario: { [SAFE + '_a']: 'okNoEffect' } })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'VERIFY_FAILED', '硬判据（回执 + 队列 + revision）全都正常，只有业务核验抓得到')
    assert.strictEqual(report.rows[0].command, 'rescheduleBooking')
    assert.strictEqual(report.rows[0].business.checked, true, '必须真的读回了目标预约')
    assert.strictEqual(report.rows[0].business.ok, false, '并且判不通过')
    assert.includes(report.stop.failedNotes.join('；'), '时间没变成 payload 指定的值', '停手理由必须自带"期望 vs 实际"')
    assert.strictEqual(world.state.executeLog.length, 1, '第一条就停手，第二条一次都不发')
  })

  await test('㊹ 反向对照：内容回执 succeeded，但**云端内容字段没变** ⇒ 停手并报出字段差异', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148, scenario: { [SAFE + '_c']: 'okNoEffect' } })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'VERIFY_FAILED', '结论码')
    assert.strictEqual(report.rows.length, 3, '前两条正常，第三条才停')
    assert.strictEqual(report.rows[2].command, 'updateBookingContent')
    assert.includes(report.rows[2].failedChecks, 'business')
    // 文案必须把"**真实**不一致"与"只是键序差异"分开说 —— 否则现场读不出是哪一类。
    assert.includes(report.stop.failedNotes.join('；'), 'items', '必须指出是哪个字段不一致')
    assert.includes(report.stop.failedNotes.join('；'), '真实不一致', '必须明说这是"真实"不一致，而不是序列化差异')
    assert.strictEqual(world.state.executeLog.length, 3, '第三条之后不再有第四条')
  })

  await test('㊺ 根因回归（2026-09-23 停手现场）：「内容 → 完课」同属一条 booking 且相邻', async () => {
    // ① 端到端：队列就是计划里的 `sima-content-done` 两条，逐条即时取基线 ⇒ **两条都必须通过**。
    const rows = [
      entryOf('ob_2l_jl9mja', 'updateBookingContent', SAFE + '_c', { bookingId: OFFICIAL_29, items: [{ name: '深蹲', sets: 4 }], category: '力量' }),
      entryOf('ob_2m_i35al3', 'completeBooking', SAFE + '_d', { bookingId: OFFICIAL_29 })
    ]
    const bookings = officialBookings()
    bookings[OFFICIAL_29] = {
      id: OFFICIAL_29, studentId: 'stu_sima', packageId: 'pkg_zhuge', date: '2026-09-22', hour: 10, minute: 0,
      items: [], notes: '', category: '', duration: 60, summary: '', status: 'booked'
    }
    const world = worldFor(rows, {
      revision: 148,
      bookings,
      ledger: { [OFFICIAL_29]: completionBox(box => { box.after.receipts[0].requestId = SAFE + '_d' }) }
    })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'QUEUE_EMPTY', '两条都必须过：' + JSON.stringify(report.stop || {}))
    assert.strictEqual(world.state.executeLog.length, 2, '恰好两条、每条一次 execute')
    assert.strictEqual(report.rows[1].business.checked, true, '完课必须真的做了差量核验')
    assert.strictEqual(report.rows[1].business.ok, true, '并且通过（这条正是当年被误判的那一条）')

    // ② 判据层：**整批预取**的基线 + 旧口径（"该 booking 回执总数恰好 +1"）必然误判 —— 根因就是这一行。
    const batchBaseline = verifiers.completionLedgerOf(LEDGER_BEFORE)
    const afterBase = verifiers.completionLedgerOf(Object.assign({}, LEDGER_AFTER, {
      receipts: LEDGER_AFTER.receipts.concat([{ requestId: 'updateBookingContent_fired_between', command: 'updateBookingContent', status: 'succeeded' }])
    }))
    assert.strictEqual(afterBase.receiptCount === batchBaseline.receiptCount + 1, false,
      '旧判据在"同 booking 的内容回执先落"时必然误判 —— 这就是 2026-09-23 的停手根因')
    assert.strictEqual(verifiers.completionLedgerDelta(batchBaseline, afterBase, MIGRATED).ok, false,
      '整批预取的基线配上**新**判据同样必须判否（差量只允许覆盖这一条命令）')
    // ③ 换成"发送前即时取"的基线 + 集合差 ⇒ 通过，且新增的回执恰好是本次这一个。
    const immediate = verifiers.completionLedgerOf(Object.assign({}, LEDGER_BEFORE, {
      receipts: LEDGER_BEFORE.receipts.concat([{ requestId: 'updateBookingContent_fired_between', command: 'updateBookingContent', status: 'succeeded' }])
    }))
    const delta = verifiers.completionLedgerDelta(immediate, afterBase, MIGRATED)
    assert.strictEqual(delta.ok, true, '即时基线 + 集合差 ⇒ 账平：' + delta.notes.join('；'))
    assert.deepStrictEqual(delta.newReceiptIds, [MIGRATED], '新增的回执恰好是本次 requestId 这一条')
  })

  await test('㊻ 反向对照：核验器被改坏（永远说"通过"）⇒ 端到端必须变红（证明核验不是装饰）', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148, scenario: { [SAFE + '_a']: 'okNoEffect' } })
    const report = await auto.runAutoContinue(depsOf(world, {
      businessCheck: () => ({ checked: true, ok: true, reason: '（假件故意永远说通过）' })
    }))
    assert.strictEqual(report.code, 'QUEUE_EMPTY', '假件当然会放过 —— 所以上面 ㊸/㊹ 的真实核验才是唯一的抓取点')
    // ↑ 这条是**故意**的：它钉住"端到端只会在真的读回云端时才发现问题"，
    //   所以 `businessCheck` 的注入必须来自页面（`autoBusinessCheckOf`），绝不能被悄悄换成恒真实现。
    assert.strictEqual(report.rows[0].business.ok, true, '假件的结论')
    assert.strictEqual(world.state.bookings[OFFICIAL_2A].hour, 9, '而云端其实一个字没改 —— 这就是"核验被换掉"的后果')
  })

  await test('㊼ 根因回归（2026-09-23 第二次停手现场）：**同一份内容、只有键序不同** ⇒ 必须通过、不得误停', async () => {
    // 假云端已经把 item 键序按真服务端的行为重排成字母序（`asServerStores`），
    // 而 payload 用的是 App 的真实构造序（`PRODUCTION_ITEMS`）⇒ 两份**原始字符串必然不同**。
    // 旧口径（`JSON.stringify` 相等）在这里会每一次都判否；新口径（键序无关）必须通过。
    const world = worldFor(threeInPlanOrder(), { revision: 148 })
    const report = await auto.runAutoContinue(depsOf(world))
    assert.strictEqual(report.code, 'QUEUE_EMPTY', '内容命令不得因键序差异而停手')
    assert.strictEqual(report.rows.length, 3, '三条都推完')
    const contentRow = report.rows[2]
    assert.strictEqual(contentRow.command, 'updateBookingContent')
    // ⚠️ 行的业务核验结论在**嵌套字段** `row.business` 上（`sendOnce` 的返回结构），
    //    顶层只有 `businessChecked` 是喂给 `verifySent` 的入参 —— 断言写错字段名会得到
    //    `undefined` 而"看起来像没核验"，这里钉住嵌套口径本身（它才是报告/界面读的那份）。
    assert.strictEqual(contentRow.business.checked, true, '必须真的读回核验（不是"跳过"）')
    assert.strictEqual(contentRow.business.ok, true, '键序差异不是业务不一致 ⇒ 判过')
    assert.strictEqual(contentRow.business.neutral, false, '真实核验过，不是"按策略无需"的中性说明')
    assert.notIncludes(contentRow.failedChecks, 'business', '不得进入失败清单')
    assert.includes(contentRow.business.reason, '逐值相同', '报告必须明说"逐值相同、只是键序不同"')
    // 反证这条用例**真的有判别力**：原始字符串确实不同、长度相同、规范化后完全相同。
    const cloudItems = world.state.bookings[OFFICIAL_2L].items
    assert(JSON.stringify(PRODUCTION_ITEMS) !== JSON.stringify(cloudItems), '原始字符串必须不同（否则用例没有判别力）')
    assert.strictEqual(JSON.stringify(PRODUCTION_ITEMS).length, JSON.stringify(cloudItems).length, '长度相同 ⇒ 差异只在键序')
    assert.strictEqual(verifiers.canonicalJson(PRODUCTION_ITEMS), verifiers.canonicalJson(cloudItems), '规范化后必须完全相同')
  })

  await test('㊽ 键序无关口径的边界：**数组顺序**与**真实值差异**仍必须判否；首个差异位置可复算', async () => {
    const keyOrderOnly = verifiers.contentDiffOf(
      { items: [{ name: '深蹲', group: '腿', sets: 4, reps: 12, weight: '40', minutes: '' }] },
      { items: [{ group: '腿', minutes: '', name: '深蹲', reps: 12, sets: 4, weight: '40' }] })
    assert.strictEqual(keyOrderOnly.ok, true, '只是键序不同 ⇒ 通过')
    assert.strictEqual(keyOrderOnly.problems.length, 0, '不得产生"真实不一致"')
    assert.includes(keyOrderOnly.notes.join('；'), '逐值相同', '必须说明只是键序/序列化差异')

    const arrayReordered = verifiers.contentDiffOf({ items: [{ name: 'A' }, { name: 'B' }] }, { items: [{ name: 'B' }, { name: 'A' }] })
    assert.strictEqual(arrayReordered.ok, false, '**数组顺序**是业务含义（她拖出来的动作次序）⇒ 换了次序必须判否')

    const valueChanged = verifiers.contentDiffOf({ items: [{ name: '深蹲', sets: 4 }] }, { items: [{ name: '深蹲', sets: 5 }] })
    assert.strictEqual(valueChanged.ok, false, '值被改了 ⇒ 真实不一致')
    assert.includes(valueChanged.problems.join('；'), '真实不一致', '必须明说"真实不一致"')

    const textMissing = verifiers.contentDiffOf({ items: [{ name: '深蹲' }], notes: '备注' }, { items: [{ name: '深蹲' }], notes: '' })
    assert.strictEqual(textMissing.ok, false, '文本字段没落 ⇒ 判否')

    assert.strictEqual(verifiers.firstDiffIndex('abcdef', 'abcXef'), 3, '首个差异位置（0 基）')
    assert.strictEqual(verifiers.firstDiffIndex('abc', 'abc'), -1, '逐字符相同 ⇒ -1')
    assert.strictEqual(verifiers.firstDiffIndex('abc', 'abcd'), 3, '前缀关系 ⇒ 较短串的长度')
    assert.strictEqual(verifiers.canonicalJson({ b: 1, a: { d: 2, c: 3 } }), verifiers.canonicalJson({ a: { c: 3, d: 2 }, b: 1 }), '嵌套对象也要键序无关')
    assert(verifiers.canonicalJson([1, 2]) !== verifiers.canonicalJson([2, 1]), '数组必须保序')
  })

  // ═══ 五、留档与文案 ═══
  await test('㉓ 每条都回调留档（进程被杀时报告也必须在），且报告文本里没有 undefined', async () => {
    const world = worldFor(threeInPlanOrder(), { revision: 148 })
    const seen = []
    const report = await auto.runAutoContinue(depsOf(world, { onRow: row => seen.push(row) }))
    assert.strictEqual(seen.length, 3, '每条都要落一次档')
    const text = auto.autoRunTextOf(Object.assign({}, report, { atText: '2026-09-23 09:50:00（北京时）' }))
    assert(!/undefined/.test(text), '报告里不许出现 undefined')
    assert(/execute=1/.test(text), '报告必须印 execute 次数（恢复期最重要的可控数字）')
    assert(/revision/.test(text), '报告必须印 revision')
  })

  // ═══ 六、静态边界：结构上没有"绕过闸门"的路 ═══
  await test('㉔ 驱动模块结构上只有一条发送面：不含 flush / 云调用 / 解冻 / 迁移', async () => {
    const raw = fs.readFileSync(path.join(PROJ, 'utils', 'resume-auto-driver.js'), 'utf8')
    const source = stripComments(raw)
    assert(!/require\(/.test(source), '驱动不得 require 任何模块（副作用全部经 deps 注入）')
    assert(!/flush\(/.test(source), '不得调用 flush（非 step 会把整队一次性发完）')
    assert(!/callFunction|cloud-primary-adapter|sync-engine|local-outbox|production-recovery-guard/.test(source), '不得直接触碰云调用 / 引擎 / 队列 / 门禁')
    assert(!/release\(|unfreeze|setStorageSync|removeStorageSync/.test(source), '不得解冻、不得直接写 Storage')
    assert(/deps\.step\(\)/.test(source), '唯一的发送面必须是注入的 deps.step()')
  })

  await test('㉕ 页面接线：三个入口都在，且自动续跑段的发送面只有 sync.step()（视图同步）', async () => {
    assert(pageDefinition, 'Page 定义必须被捕获')
    ;['onAutoRunStart', 'onAutoStop', 'onCopyAutoRun'].forEach(name => {
      assert(typeof pageDefinition[name] === 'function', '缺少入口 ' + name)
    })
    const raw = fs.readFileSync(PAGE_PATH, 'utf8')
    // 自动续跑＝「支持层（Page 之前）」+「三个入口（Page 之内、通道二之前）」，两段合起来才算完整。
    const support = raw.slice(raw.indexOf('const AUTO_RUN_KEY'), raw.indexOf('\nPage({'))
    const handlers = raw.slice(raw.indexOf('// ═══ 安全自动续跑：**一次启动**'), raw.indexOf('// ═══ 通道二：清除 4 行测试遗留'))
    assert(support.length > 500 && handlers.length > 500, '必须能定位自动续跑的两段代码')
    const section = stripComments(support + '\n' + handlers)
    assert(/step: \(\) => sync\.step\(\)/.test(section), '发送面必须恰好是 sync.step()')
    assert(!/sync\.flush/.test(section), '自动续跑不得调用 sync.flush')
    assert(!/guard\.release|unfreezeSync/.test(section), '自动续跑不得解冻')
    assert(!/migrationRule\.apply|migratedRequestId/.test(section), '自动续跑不得换号')
    assert(/wx\.setKeepScreenOn/.test(section), '长跑必须申请常亮（否则息屏掐断 JS）')
    const wxml = fs.readFileSync(WXML_PATH, 'utf8')
    ;['onAutoRunStart', 'onAutoStop', 'onCopyAutoRun'].forEach(name => {
      assert(wxml.indexOf(name) >= 0, 'wxml 缺少 ' + name + ' 的按钮')
    })
    assert(/autoReport/.test(wxml), 'wxml 必须展示自动续跑记录')
  })

  // ═══ 七、**真把 handler 调起来**（2026-09-23 事故 §0.5.17 的永久防线）═══
  // 为什么单独立这一节：上面 ㉕ 只 grep 标识符字符串 ⇒ 一个致命缺陷全绿放过 ——
  // 页面**漏写** `const autoDriver = require('../../utils/resume-auto-driver')`，于是 `autoDriver` 在
  // 运行期是个自由变量（编译产物里 0 处声明），点「自动续跑」必然 ReferenceError；而那个 ReferenceError
  // 发生在 `showModal` 的 **async 回调**里 ⇒ 变成 unhandled rejection ⇒ **界面上一个字都不出现**。
  // 教训：**字符串在里面 ≠ 代码能跑起来**。这一节的判据统一是"点下去之后页面上出现了什么、队列动了没有"。
  //
  // 安全声明：本节全部用桩 Storage（空队列）⇒ 队列里没有可发条目、`deps.step()` 一次都不会被调用，
  // 不发任何命令、不解冻、不碰云端。
  const OUTBOX_MODULE = require(path.join(PROJ, 'utils', 'local-outbox'))
  const HOLD_KEY = guard.KEY
  const GRANT_KEY = guard.GRANT_KEY
  const RUN_KEY = page.AUTO_RUN_KEY
  const OUTBOX_KEY = OUTBOX_MODULE.bucketKey('production')
  const HOLD = { bookingId: 'REPAIR-ORPHAN-TOMBSTONE-2026-09-22', datasetId: 'candidate_f971f032ca88dc3a2b656a6654d9a314' }
  const SYNTHETIC_SCOPE = { environment: 'production', datasetId: HOLD.datasetId }

  const rejections = []
  process.on('unhandledRejection', error => rejections.push(String((error && error.message) || error)))

  // 把 wx 换成**记账桩**：Storage 用真实对象（guard / outbox 读到的就是我放进去的东西），
  // 弹窗与 Toast 只记录调用 —— "点了没反应"最硬的机器判据正是"该弹的框有没有弹"。
  let store = {}
  let wxCalls = null
  function setWx(options) {
    const opt = options || {}
    store = Object.assign({}, opt.storage || {})
    wxCalls = { modal: [], modalOptions: [], toast: [], storageWrites: [], cloud: [] }
    global.wx = Object.assign({}, global.wx, {
      getStorageSync: key => (Object.prototype.hasOwnProperty.call(store, key) ? clone(store[key]) : ''),
      setStorageSync: (key, value) => { store[key] = clone(value); wxCalls.storageWrites.push(String(key)) },
      removeStorageSync: key => { delete store[key] },
      showModal: options2 => {
        const o = options2 || {}
        // 连**原始 options** 一起记下来：按钮文字是否在基础库硬上限内，只能从这里判（§0.5.18）。
        wxCalls.modalOptions.push(o)
        wxCalls.modal.push({ title: String(o.title || ''), content: String(o.content || '') })
        if (typeof opt.onModal === 'function') opt.onModal(o, wxCalls.modal.length - 1)
      },
      showToast: options2 => wxCalls.toast.push({ title: String((options2 && options2.title) || '') }),
      setKeepScreenOn: () => {}, setClipboardData: options => { if (options && options.success) options.success({}) },
      // ★ 「一次 execute」的**最强判据**：命令真正出网只有这一条路（`utils/cloud-bootstrap.js` 的 `callCloud`）。
      //   测试期间**绝不允许出网** —— 一旦有人点了"没确认就先发"，这里会留下记录并被断言抓住；
      //   返回 rejected promise（不是同步 throw），避免把"意外的发送"伪装成"同步崩溃"。
      cloud: {
        callFunction: options2 => {
          wxCalls.cloud.push({ name: String((options2 && options2.name) || ''), data: clone((options2 && options2.data) || null) })
          return Promise.reject(new Error('测试期间不得调用云函数（出现即代表发生了 execute）：' + String((options2 && options2.name) || '')))
        }
      },
      getAccountInfoSync: () => ({ miniProgram: { appId: 'wx7aa0596956732b35', envVersion: 'develop' } })
    })
    return wxCalls
  }
  // 一个真实的页面实例（方法来自 `Page({...})` 的同一份定义，data 独立、setData 记账）。
  function pageInstance() {
    const inst = {}
    Object.keys(pageDefinition).forEach(key => { inst[key] = pageDefinition[key] })
    inst.data = clone(pageDefinition.data)
    inst.patches = []
    inst.setData = patch => { const row = clone(patch); inst.patches.push(row); Object.assign(inst.data, row) }
    return inst
  }
  const ranOnce = inst => (inst.patches || []).some(row => row.autoRunning === true)
  async function waitFor(condition, label, ms) {
    const limit = Date.now() + (ms || 5000)
    while (Date.now() < limit) {
      if (condition()) return true
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('等待超时：' + label)
  }
  // 点一次"▶ 自动续跑（逐条核验 · 一次启动）"，返回同步抛出的错误（不该有）。
  function clickAutoRun(inst) {
    try { inst.onAutoRunStart(); return null } catch (error) { return error }
  }
  rejections.length = 0

  await test('㉖ 点击 handler **真被调起来**：同步进入、**第一条**就是可见反馈、并弹出确认框报出下一条', async () => {
    setWx({ storage: { [HOLD_KEY]: HOLD } })
    guard.enter()
    const inst = pageInstance()
    const syncThrew = clickAutoRun(inst)
    assert(!syncThrew, 'handler 不得同步抛错：' + String(syncThrew && syncThrew.message))
    assert(inst.patches.length >= 1, '进入 handler 必须立刻 setData（否则就是"点了没反应"）')
    assert(String(inst.patches[0].autoHint || '').length > 0, '**第一条** setData 就必须带可见文本，不能等确认框之后')
    assert.strictEqual(wxCalls.modal.length, 1, '必须弹确认框 —— 真机取证里"一个 showModal 都没有"正是"没进 handler"的判据')
    assert(/确认启动自动续跑/.test(wxCalls.modal[0].title), '确认框标题')
    assert(/逐条推进/.test(wxCalls.modal[0].content), '确认框必须写清逐条推进与停手规则')
    assert(inst.data.autoRunning !== true, '还没确认，不得进入"运行中"')
  })

  await test('㉗ 确认后**真的跑起来**并给出可见结论（空队列 ⇒ 0 条推进、0 次 execute、队列一个字没动）', async () => {
    setWx({
      storage: { [HOLD_KEY]: HOLD },
      onModal: (options, index) => {
        if (index === 0 && typeof options.success === 'function') options.success({ confirm: true })
      }
    })
    guard.enter()
    const inst = pageInstance()
    clickAutoRun(inst)
    await waitFor(() => inst.data.autoReport && inst.data.autoRunning === false, '跑完并交回报告', 8000)
    assert(ranOnce(inst), '确认后必须**立刻**进入可见的"运行中"（不能等驱动回来才画）')
    const report = inst.data.autoReport
    // ★ 这一格就是 §0.5.17 的专属判据：`autoDriver` 的 require 再漏一次，这里必然是 PAGE_AUTO_THREW。
    assert.strictEqual(report.code, 'QUEUE_EMPTY', '空队列的正确结论（若 driver 的 require 又漏了，这里必是 PAGE_AUTO_THREW）')
    assert.strictEqual(report.entriesRun, 0, '空队列不得推进任何条目')
    assert.strictEqual(report.ok, true, '空队列是正常收尾')
    assert.strictEqual(report.gates.frozen, true, '运行全程冻结必须生效')
    assert.strictEqual(report.gates.grantCleared, true, '收尾授权必须已清（不得留下任何发送口子）')
    assert(!store[GRANT_KEY], 'Storage 里不得残留授权')
    assert.strictEqual(store[RUN_KEY] && store[RUN_KEY].code, 'QUEUE_EMPTY', '结论必须落盘留档')
    assert.strictEqual(store[RUN_KEY] && store[RUN_KEY].status, 'completed', '落档状态')
    assert(/队列空了/.test(String(inst.data.autoHint)), '收尾 hint 必须说清结论')
    assert.strictEqual(inst.autoWatchdogTimer, null, '看门狗必须收干净（否则测试进程会被定时器吊住）')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.strictEqual(rejections.length, 0, '不得有未接住的 rejection（这正是上一版"点了没反应"的成因）：' + rejections.join(' / '))
  })

  await test('㉘ 重复点击必须被拦：可见提示 + Toast，且**不再弹确认框**（不产生第二次启动）', async () => {
    setWx({ storage: { [HOLD_KEY]: HOLD } })
    guard.enter()
    const inst = pageInstance()
    inst.data.autoRunning = true
    const before = wxCalls.modal.length
    const syncThrew = clickAutoRun(inst)
    assert(!syncThrew, '重复点击也不得抛错')
    assert.strictEqual(wxCalls.modal.length, before, '运行中不得再弹"确认启动"')
    assert(/已在运行中/.test(String(inst.data.autoHint)), '必须把"已在运行中"画出来（静默等于让人觉得按钮坏了）')
    assert.strictEqual(wxCalls.toast.length, 1, '同时给一个 Toast')
    assert.strictEqual(inst.data.autoRunning, true, '不得把"运行中"标记弄丢')
  })

  await test('㉙ 冻结：受控入口**能起来**（内存态丢了会幂等立回、绝不写 Storage），而普通业务写入口照旧全拦', async () => {
    setWx({ storage: { [HOLD_KEY]: HOLD } })
    guard.enter()
    guard.exit() // 模拟"整面冻结被撤销 / 重编译后内存态丢了"：inspectingNow()=false 而 held() 仍在
    assert(guard.held(), '前置条件：持久冻标记必须还在')
    assert.strictEqual(guard.inspectingNow(), false, '前置条件：内存态不在（这正是重编译后的状态）')
    const writesBefore = wxCalls.storageWrites.length
    const inst = pageInstance()
    const syncThrew = clickAutoRun(inst)
    assert(!syncThrew, '不得抛错')
    assert(!/未启动|没有同步冻结标记/.test(String(inst.data.autoHint)), '内存态丢了**不得**把入口自锁（这是 §0.5.17 的第二处缺陷）')
    assert.strictEqual(guard.inspectingNow(), true, '入口必须把冻结**幂等立回来**（否则重编译就等于冻结静默失效、整队随时被别处发完）')
    assert.strictEqual(wxCalls.storageWrites.length, writesBefore, '立回冻结只加不减，**绝不写 Storage**')
    assert.strictEqual(wxCalls.modal.length, 1, '必须走到确认框')
    assert(/确认启动自动续跑/.test(wxCalls.modal[0].title), '确认框标题')

    // 授权 ≠ 解冻：只有**被点名的那一条**在 step 模式下能过；普通业务写入口（不带 resendStep）照旧全拦。
    guard.grantResend(['ob_2a_bhku2v'], '测试：单条临时授权')
    assert.strictEqual(guard.blocksBusiness('production', { resendStep: true }), false, 'step 模式 + 有效授权 ⇒ 放行这一轮')
    assert.strictEqual(guard.blocksBusiness('production'), true, 'mutate / 预约协调器（不传 options）**照旧全拦**')
    assert.strictEqual(guard.blocksBusiness('production', { resendStep: false }), true, '显式声明非 step ⇒ 全拦')
    assert.strictEqual(guard.blocksEntry(SYNTHETIC_SCOPE, entryOf('ob_2a_bhku2v', 'rescheduleBooking', 'id_a')), false, '被点名的条目放行')
    assert.strictEqual(guard.blocksEntry(SYNTHETIC_SCOPE, entryOf('ob_2a_zzzzzz', 'rescheduleBooking', 'id_b')), true, '没被点名的条目照旧拦')
    assert.strictEqual(guard.blocksBusiness('sandbox', { resendStep: true }), false, 'sandbox 不受影响')
    assert.strictEqual(
      guard.blocksEntry(SYNTHETIC_SCOPE, Object.assign(entryOf('ob_2a_bhku2v', 'x', 'id_c'), { payload: { bookingId: HOLD.bookingId } })),
      true, '被救援冻结锁定的那节课**永远优先被拦**，授权也放不过'
    )
    // 本用例自己收尾，不给后面的用例留状态
    guard.clearResendGrant()
    guard.exit()
    assert(!store[GRANT_KEY], '授权已清')
  })

  await test('㉚ 异常必须**立刻可见 + 落盘 + 解锁按钮**（唯一出口 autoFailOf），且自己绝不抛错', async () => {
    setWx({ storage: { [HOLD_KEY]: HOLD } })
    guard.enter()
    const inst = pageInstance()
    inst.data.autoRunning = true // 模拟"运行到一半抛错"
    let threw = null
    try { inst.autoFailOf('AUTO_RUN_THREW', new Error('模拟：只读基线读取失败')) } catch (error) { threw = error }
    assert(!threw, 'autoFailOf 自己绝不能抛错')
    assert.strictEqual(inst.data.autoRunning, false, '必须解锁按钮（否则从此永久卡"运行中"，再点就静默 return）')
    assert(/已停手/.test(String(inst.data.autoHint)), '必须有"已停手"字样')
    assert(/模拟：只读基线读取失败/.test(String(inst.data.autoHint)), '**原因**必须画在页面上')
    assert.strictEqual(wxCalls.modal.length, 1, '必须弹窗报停手（不能只写在 hint 里）')
    assert(/已停手/.test(wxCalls.modal[0].title), '弹窗标题必须说"已停手"')
    assert(/一个字都没动/.test(wxCalls.modal[0].content), '弹窗必须说清"这条没发出去、队列没动"')
    const saved = store[RUN_KEY]
    assert(saved && saved.ok === false && saved.code === 'AUTO_RUN_THREW', '异常必须落盘留档')
    assert(/模拟：只读基线读取失败/.test(String(saved.message)), '留档必须带原因')
  })

  await test('㉛ 收尾阶段抛错也必须变成可见停手（旧写法这几行在 try 之外 ⇒ Promise 被吞 + 永久卡运行中）', async () => {
    setWx({
      storage: { [HOLD_KEY]: HOLD },
      onModal: (options, index) => {
        if (index === 0 && typeof options.success === 'function') options.success({ confirm: true })
      }
    })
    guard.enter()
    const inst = pageInstance()
    clickAutoRun(inst)
    // 确定性注入：只让**驱动已经返回之后**那一次读队列失败（此前 autoRunning 还是 true，不抛）。
    // ⚠️ 只用「第一次」抛错：`autoFailOf` 收尾还会**再只读读一次**队列（为了不显示"队列 null → null"），
    //    那一次必须能正常读到 —— 否则等于"停手报告里连队列现状都没有"。
    const originalGet = global.wx.getStorageSync
    let injected = 0
    global.wx.getStorageSync = key => {
      if (String(key) === OUTBOX_KEY && injected === 0 && inst.data.autoRunning === false && ranOnce(inst)) { injected += 1; throw new Error('模拟：收尾读队列失败') }
      return originalGet(key)
    }
    await waitFor(() => inst.data.autoReport && inst.data.autoRunning === false, '收尾抛错后仍要走到"已停手"', 8000)
    global.wx.getStorageSync = originalGet
    assert(injected > 0, '故障注入必须真的生效（否则这个用例什么也没测到）')
    assert.strictEqual(inst.data.autoRunning, false, '绝不允许永久卡在"运行中"')
    assert.strictEqual(inst.data.autoReport.code, 'AUTO_FINISH_THREW', '收尾抛错必须被自己的 try 接住并如实命名')
    assert(/已停手/.test(String(inst.data.autoHint)), '必须有可见停手文案')
    assert.strictEqual(store[RUN_KEY] && store[RUN_KEY].code, 'AUTO_FINISH_THREW', '必须落盘留档')
    assert.strictEqual(store[RUN_KEY] && store[RUN_KEY].queueUntouched, true, '收尾抛错也要给出只读队列现值（不能又是 null）')
    assert(wxCalls.modal.some(row => /已停手/.test(row.title)), '必须弹窗报停手')
    assert.strictEqual(injected, 1, '读队列失败只需要发生一次就该停手（不得原地打转）')
  })

  await test('㉜ 页面注入给驱动的发送面**只有** sync.step()（step 模式一次最多一次 execute），且确实可调用', async () => {
    setWx({ storage: { [HOLD_KEY]: HOLD } })
    guard.exit()
    assert.strictEqual(typeof page.autoDepsOf, 'function', 'autoDepsOf 必须导出（驱动全部副作用只能经它落地）')
    assert.strictEqual(typeof page.autoRunTextOf, 'function', 'autoRunTextOf 必须导出')
    const deps = page.autoDepsOf(pageInstance(), { ledgers: {}, report: { rows: [], entriesRun: 0 } })
    // ⚠️ 先剥注释再断言：函数体注释里就写着"绝不改用 flush"，不剥注释会自己撞自己。
    const body = stripComments(String(page.autoDepsOf)).replace(/\s+/g, '')
    assert(/step:\(\)=>sync\.step\(\)/.test(body), '发送面必须是引擎的 **step 模式**')
    assert(!/flush/.test(body), '注入面不得出现 flush（非 step 会把整队一次发完，中途没人看回执）')
    assert(!/release|unfreeze/.test(body), '注入面不得有解冻')
    assert.strictEqual(typeof deps.step, 'function', 'step 必须真的可调用')
    assert.strictEqual(deps.grantIsClear(), true, '初始授权必须是干净的')
    assert.strictEqual(deps.frozen(), false, '本用例刻意不立冻结 ⇒ 驱动会拒启动（没有冻结就没有发送面）')
    assert.strictEqual(deps.shouldStop(), false, '未请求停止')
    guard.enter()
    assert.strictEqual(deps.frozen(), true, '立起冻结后同一组依赖立刻为真')
    guard.exit()
  })

  await test('㉝ 页面顶部**必须**声明 autoDriver（§0.5.17：少这一行 ⇒ 点击必 ReferenceError 且界面无反应）', async () => {
    const source = stripComments(fs.readFileSync(PAGE_PATH, 'utf8'))
    const declared = source.match(/const\s+autoDriver\s*=\s*require\('/g) || []
    assert.strictEqual(declared.length, 1, 'autoDriver 必须**恰好**声明一次（漏写 ⇒ 运行期自由变量 ⇒ 点了没反应）')
    assert((source.match(/autoDriver\./g) || []).length > 0, '页面确实在用 autoDriver')
  })

  // ═══ 八、确认框三条路径 + 按钮文字合规（2026-09-23 事故 §0.5.18 的永久防线）═══
  // 现场：点「自动续跑」不再静默了，但立刻停在 `AUTO_CONFIRM_MODAL_FAILED | [object Object]`。
  // 根因（两条叠加，缺一条都不会长成这样）：
  //   ① 上一轮重构确认框时写了 `confirmText: '启动自动续跑'`（**6 个汉字**）。基础库 `3.17.3.wxvpkg` 里
  //      `showModal` 的硬校验是 `confirmText.replace(/[^\x00-\xff]/g,'##').length > 8 ⇒ fail`，
  //      即**非 ASCII 记 2 宽、上限 8（= 4 个汉字）**；6 汉字 = 12 ⇒ **弹窗根本不显示**，直接走 fail。
  //      —— "弹不出来"和"没绑上事件"长得一模一样，所以它骗过了上一轮的接线排查。
  //   ② `autoFailOf` 只取 `String(error.message)`，而 wx 的 fail 对象把信息放在 **errMsg** 上
  //      ⇒ 界面上只剩 `[object Object]`，等于把唯一线索自己删掉。
  // 这一节的判据：**点下去之后屏幕上出现了什么字、云端有没有被碰过**。
  await test('㉞ 送进 wx.showModal 的按钮文字**必须**在基础库硬上限内（按官方计宽公式，非 ASCII 记 2 宽、上限 8）', async () => {
    setWx({ storage: { [HOLD_KEY]: HOLD } })
    guard.enter()
    const inst = pageInstance()
    clickAutoRun(inst)
    assert.strictEqual(wxCalls.modal.length, 1, '必须弹出确认框')
    const sent = wxCalls.modalOptions[0]
    assert(sent.confirmText !== undefined, '确认框必须显式给出 confirmText（走"确定"默认值就说明封装被绕过了）')
    ;['confirmText', 'cancelText'].forEach(key => {
      const raw = String(sent[key] === undefined ? '' : sent[key])
      const width = raw.replace(/[^\x00-\xff]/g, '##').length
      assert(width <= 8, '❌ ' + key + '＝「' + raw + '」计宽 ' + width + ' > 8 ⇒ 真机**直接 fail 且不显示弹窗**（§0.5.18）')
    })
    // 封装本身也必须在：参数合规不是"这次改对了"，而是"以后写错也弹得出来"。
    assert.strictEqual(typeof inst.safeShowModal, 'function', '页面必须有 safeShowModal 这道闸（否则下一个新人再写长文案又炸）')
  })

  await test('㉟ showModal **fail** 路径：真实 errMsg/code 必须可见 + 落盘 + 解锁按钮 + 队列不再显示 null', async () => {
    const beforeConfirm = []
    setWx({
      storage: { [HOLD_KEY]: HOLD },
      onModal: (options, index) => {
        if (index !== 0) return
        if (typeof options.fail === 'function') {
          // 真机（基础库 3.17.3）在按钮文字超限时给出的正是这个形状：**信息在 errMsg 上**。
          options.fail({ errMsg: 'showModal:fail confirmText length should not larger than 4 Chinese characters', errno: 1001 })
        }
      }
    })
    guard.enter()
    const inst = pageInstance()
    const syncThrew = clickAutoRun(inst)
    assert(!syncThrew, 'fail 回调里出错也不能同步冒出来')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.strictEqual(inst.data.autoRunning, false, '失败后必须解锁按钮（不得卡"运行中"）')
    const hint = String(inst.data.autoHint)
    assert(/AUTO_CONFIRM_MODAL_FAILED/.test(hint), '必须报出失败码')
    assert(/showModal:fail/.test(hint), '**必须是真实 errMsg**（现场只有 [object Object] 就是这里丢的）')
    assert(/confirmText length/.test(hint), 'errMsg 全文必须画在页面上')
    assert(!/\[object Object\]/.test(hint), '绝不允许再出现 [object Object]')
    const saved = store[RUN_KEY]
    assert(saved && saved.ok === false && saved.code === 'AUTO_CONFIRM_MODAL_FAILED', '失败必须落盘留档')
    assert(/showModal:fail/.test(String(saved.message)), '留档必须带真实 errMsg')
    assert(saved.errorDetail && /showModal:fail/.test(String(saved.errorDetail.errMsg)), '**原始错误对象必须完整展开**留档（errMsg）')
    assert.strictEqual(saved.errorDetail.errno, 1001, '原始对象上的其他字段（errno）也要展开，且数字要原样保留')
    assert(Array.isArray(saved.errorDetail.keys) && saved.errorDetail.keys.length >= 1, '原始对象的键必须展开出来')
    // 队列字段：旧写法恒为 null ⇒ 页面显示"队列 null → null"，看起来像"队列读不出来"。
    assert.strictEqual(typeof saved.queueBefore, 'number', '队列数必须是数字（不能是 null）')
    assert.strictEqual(saved.queueBefore, saved.queueAfter, '这一步没有推进任何条目 ⇒ 前后必须一致')
    assert.strictEqual(saved.queueUntouched, true, '必须显式标记"本步没开始推进、这是只读现值"')
    assert(!/队列 null/.test(hint), '不得再出现"队列 null → null"')
    assert.strictEqual(saved.gates && saved.gates.grantCleared, true, '报告里的"授权已清"必须是真的（旧写法不填 gates ⇒ 复制出来误报 ★否★）')
    assert.strictEqual(wxCalls.cloud.length, 0, '确认阶段失败 ⇒ 零出网、零 execute')
    // 这一路根本**没有**进驱动，看门狗也就从没被启动过 ⇒ 只要求"没有活跃定时器"（null / undefined 同义）。
    assert(inst.autoWatchdogTimer == null, '看门狗不得残留活跃定时器，实际=' + String(inst.autoWatchdogTimer))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.strictEqual(rejections.length, 0, '不得有未接住的 rejection：' + rejections.join(' / '))
  })

  await test('㊱ 用户**取消**：确认前与取消后都必须 execute=0（不进驱动、不出网、队列与云端一个字没动）', async () => {
    let instRef = null
    const atConfirmMoment = {}
    setWx({
      storage: { [HOLD_KEY]: HOLD },
      onModal: (options, index) => {
        if (index !== 0) return
        // ★ "确认前 execute=0" 就断言在**这一刻**：确认框刚弹出、用户还没点。
        atConfirmMoment.cloud = wxCalls.cloud.length
        atConfirmMoment.running = ranOnce(instRef)
        atConfirmMoment.report = !!instRef.data.autoReport
        if (typeof options.success === 'function') options.success({ confirm: false, cancel: true })
      }
    })
    guard.enter()
    const inst = pageInstance()
    instRef = inst
    clickAutoRun(inst)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.strictEqual(atConfirmMoment.cloud, 0, '**确认前**绝不允许出网')
    assert.strictEqual(atConfirmMoment.running, false, '**确认前**不得进入"运行中"（否则就是"没等确认就开跑"）')
    assert.strictEqual(atConfirmMoment.report, false, '**确认前**不得生成任何报告')
    assert(inst.data.autoRunning !== true, '取消后不得进入"运行中"')
    assert(!ranOnce(inst), '取消 ⇒ 一次都没跑起来')
    assert(/已取消/.test(String(inst.data.autoHint)), '必须给出可见的"已取消"（不能静默）')
    assert(!inst.data.autoReport, '取消不该生成报告')
    assert.strictEqual(wxCalls.cloud.length, 0, '取消 ⇒ 零出网、零 execute')
    assert(!store[RUN_KEY], '取消不该写报告留档')
    assert.strictEqual(store[OUTBOX_KEY], undefined, '队列一个字都没动')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.strictEqual(rejections.length, 0, '不得有未接住的 rejection')
  })

  await test('㊲ 全项目扫描：**任何** confirmText / cancelText 都不得超出官方计宽上限（防别处再犯）', async () => {
    const targets = []
    const walk = dir => {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
        if (entry.name === 'node_modules' || entry.name.charAt(0) === '.') return
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(js|wxml)$/.test(entry.name)) targets.push(full)
      })
    }
    ;['pages', 'utils', 'components'].forEach(name => {
      const dir = path.join(PROJ, name)
      if (fs.existsSync(dir)) walk(dir)
    })
    ;['app.js', 'app.json'].forEach(name => { if (fs.existsSync(path.join(PROJ, name))) targets.push(path.join(PROJ, name)) })
    assert(targets.length > 30, '扫描面必须覆盖整个项目（实际 ' + targets.length + ' 个文件）')
    const offenders = []
    let literalCount = 0
    targets.forEach(file => {
      let source = fs.readFileSync(file, 'utf8')
      // ⚠️ 先剥注释再断言：注释里就写着事故文案「'启动自动续跑'」，不剥会自己撞自己。
      source = /\.wxml$/.test(file) ? source.replace(/<!--[\s\S]*?-->/g, '') : stripComments(source)
      source.split(/\r?\n/).forEach((line, index) => {
        const re = /(confirmText|cancelText)\s*:([^\n]*)/g
        let m
        while ((m = re.exec(line))) {
          // 取到**下一个逗号之前**：避免把同一行后面别的字段里的长文案算进来（减少误报）。
          const tail = String(m[2]).split(',')[0]
          const literals = tail.match(/(['"])((?:\\.|(?!\1).)*)\1/g) || []
          literals.forEach(lit => {
            const value = lit.slice(1, -1)
            if (!value) return
            literalCount += 1
            const width = value.replace(/[^\x00-\xff]/g, '##').length
            if (width > 8) offenders.push(file + ':' + (index + 1) + '  ' + m[1] + ' = ' + lit + '  计宽=' + width)
          })
        }
      })
    })
    assert(literalCount > 80, '必须真的扫到按钮文字（实际 ' + literalCount + ' 处；为 0 说明正则失效、这条测试在装样子）')
    assert.strictEqual(offenders.length, 0, '有按钮文字超限（真机会**直接 fail 且不显示弹窗**）：\n    ' + offenders.join('\n    '))
  })

  await test('㊳ modal-text / error-text 的官方规则：计宽公式、降级不静默、errMsg 优先、诊断自己绝不抛错', async () => {
    const modalText = require(path.join(PROJ, 'utils', 'modal-text'))
    const errorText = require(path.join(PROJ, 'utils', 'error-text'))
    // 计宽：照抄基础库 `/[^\x00-\xff]/g → '##'`，上限 8。
    assert.strictEqual(modalText.widthOf('启动自动续跑'), 12, '6 个汉字 = 12 宽（正是事故文案）')
    assert.strictEqual(modalText.widthOf('确认启动'), 8, '4 个汉字 = 8 宽，恰在限内')
    assert.strictEqual(modalText.widthOf('OK'), 2, 'ASCII 记 1 宽')
    assert.strictEqual(modalText.fits('启动自动续跑'), false, '6 汉字必须判超限')
    assert.strictEqual(modalText.fits('确认启动'), true, '4 汉字必须判合规')
    // 超限**不许静默截断**（截断会改变按钮含义）：退回 fallback 并把原文如实报出来。
    const fitted = modalText.fitButton('启动自动续跑', '确定')
    assert.strictEqual(fitted.fitted, true, '必须标记发生了降级')
    assert.strictEqual(fitted.text, '确定', '降级到调用方给的短文案')
    assert(/启动自动续跑/.test(fitted.raw), '原文必须留痕（不许假装没写过）')
    const notes = modalText.fitModalOptions({ confirmText: '启动自动续跑', cancelText: '取消' }).notes
    assert.strictEqual(notes.length, 1, '只有 confirmText 超限 ⇒ 恰好一条提示')
    assert(/confirmText/.test(notes[0]) && /启动自动续跑/.test(notes[0]), '提示必须说清哪一项、原文是什么')
    const kept = modalText.fitModalOptions({ confirmText: '确认启动', cancelText: '取消' })
    assert.strictEqual(kept.notes.length, 0, '合规参数不许产生任何提示')
    assert.strictEqual(kept.options.confirmText, '确认启动', '合规参数必须原样通过（不许擅自改动）')
    const hard = modalText.fitButton('这是一段很长的中文按钮文字', '同样很长的一段中文文案')
    assert(modalText.fits(hard.text), '连 fallback 都超限时必须给出合规兜底（1 个汉字 = 2 宽）')
    // error-text：**errMsg 优先** —— 与项目既有惯例同口径（`pages/stats/stats.js` 的 safeError）。
    const failObject = { errMsg: 'showModal:fail confirmText length should not larger than 4 Chinese characters', errno: 1001 }
    const line = errorText.errorTextOf(failObject)
    assert(/showModal:fail confirmText length/.test(line), '必须优先取 errMsg')
    assert(!/\[object Object\]/.test(line), '绝不允许退化成 [object Object]')
    assert.strictEqual(errorText.errorTextOf(new Error('普通 Error')), '普通 Error', '普通 Error 走 message')
    assert.strictEqual(errorText.errorTextOf(undefined), '未知异常（undefined）', 'undefined 也要给可读文本')
    const detail = errorText.errorDetailOf(failObject)
    assert(/showModal:fail/.test(detail.errMsg), 'errMsg 必须展开')
    assert.strictEqual(detail.errno, 1001, '数字字段原样保留（字符串化会让留档分不清 1001 与 "1001"）')
    assert(Array.isArray(detail.keys), '必须展开原始对象的键')
    // 诊断函数自己抛错会把现场搞得更黑 ⇒ 循环引用也必须给出文本。
    const circular = {}
    circular.self = circular
    const circularLine = errorText.errorTextOf(circular)
    assert(typeof circularLine === 'string' && circularLine.length > 0, '循环引用也要给出文本（绝不抛错）')
    assert(errorText.errorDetailOf(null) && errorText.errorDetailOf(null).typeofError === 'object', 'null 也要给可读结构')
  })

  console.log('')
  console.log('通过 / 总：' + pass + ' / ' + (pass + fail) + (fail ? ('  失败 ' + fail) : ''))
  if (fail) { console.log('失败清单：'); failures.forEach(item => console.log('  - ' + item)); process.exit(1) }
  console.log('GREEN')
}
main()
