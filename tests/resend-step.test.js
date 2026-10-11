// 受控补发（第三阶段）专项测试。
//
// 为什么要有一份测试钉它：受控补发是**唯一**能在「同步仍冻结」的前提下把命令送出去的口子。
// 它一旦失守，后果不是"补发失败"，而是「整队 15 条在无人确认的情况下一次性发到云端」——
// 正是这次事故里最贵的那一类失误。所以这里逐条钉死：
//   ① 计划表与台账同口径（16 条 = 手机 15 + 电脑 1），且**与剔除白名单零交集**（绝不会把该删的补发出去）；
//   ② FIFO 纪律：队首必须恰是计划里下一组的剩余条目、同序 —— 跳条/乱序/冒出未知条目一律**拒绝补发**；
//   ③ sent-but-unknown 必须先查回执（禁止盲重试）；
//   ④ 真引擎 + 真门禁 + 真队列：冻结下**一条都发不出去**；授权只放行点名的那条，且**一次一步**；
//   ⑤ 授权**不等于**解冻：业务写入口（mutate）与全局闸（不带 step 选项）照旧全拦。
//
// 台架：tests/helpers/local-first-world.js —— 真 outbox / 真门禁 / 真 sync-engine / 真 InMemoryCommandEngine
// 当服务端（它才是 receipt / 幂等 / expectedRevision 的真实实现，不是手搓替身）。
const path = require('path')
const { createWorld, DATASET, OWNER, copy } = require('./helpers/local-first-world')

const PROJ = path.join(__dirname, '..')
const guard = require(path.join(PROJ, 'utils', 'production-recovery-guard'))
const outbox = require(path.join(PROJ, 'utils', 'local-outbox'))
const sync = require(path.join(PROJ, 'utils', 'sync-engine'))
const { hashCommand } = require(path.join(PROJ, 'utils', 'cloud-command-engine'))

// 页面模块（拿计划常量与纯函数；与真页面同一个模块实例，不另抄一份）
let capturedPage = null
global.Page = definition => { capturedPage = definition }
const page = require(path.join(PROJ, 'pkg-diag', 'repair-orphan-tombstone', 'repair-orphan-tombstone.js'))
const RESEND_PLAN = page.RESEND_PLAN
const PRUNE_WHITELIST = page.PRUNE_WHITELIST

// —— 台账锚（写死，防"改计划顺手把某条漏了/多出来"）——
// 依据 recovery-plan-final-v2.html：B · 保留并补发（16 条 = 手机 15 + 电脑 1）
const PHONE_RESEND_IDS = ['ob_29_l5cmqb', 'ob_2a_bhku2v', 'ob_2b', 'ob_2d', 'ob_2f', 'ob_2j',
  'ob_2l_jl9mja', 'ob_2m_i35al3', 'ob_2y_ck5tc2', 'ob_2z_uhltdy', 'ob_30_yw8bqq',
  'ob_41_vo3utf', 'ob_42_kpqcmc', 'ob_43_r7a5sq', 'ob_44_jdmp2o']
const PC_RESEND_IDS = ['ob_2_i4g811']

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
assert.includes = (list, value, message) => assert((list || []).indexOf(value) >= 0, (message || '') + ' ｜ 缺少 ' + JSON.stringify(value) + ' ｜ 现有=' + JSON.stringify(list))

const SCOPE = { environment: 'production', datasetId: DATASET }
// 把真队列灌成计划里的那 16 条（顺序＝计划的 FIFO 顺序；token 组用 token_ 开头的 id）。
function seedPlanQueue(world, options = {}) {
  const skip = new Set(options.skip || [])
  const inserted = []
  RESEND_PLAN.forEach(step => {
    const rows = (step.ids || []).map(id => ({ id, token: false })).concat((step.tokens || []).map(token => ({ id: token + '_test1', token: true })))
    rows.forEach(row => {
      if (skip.has(row.id)) return
      const created = outbox.enqueue(SCOPE, { command: 'createStudent', payload: { name: 'T ' + row.id }, requestId: 'req_' + row.id, entityKey: 'createStudent' })
      outbox.patch(SCOPE, created.entry.entryId, { entryId: row.id })
      inserted.push(row.id)
    })
  })
  return inserted
}
function bootFrozen(world) {
  world.store[guard.KEY] = { bookingId: 'REPAIR-ORPHAN-TOMBSTONE-2026-09-22', datasetId: DATASET, note: 'orphan tombstone repair' }
  guard.arm()
  guard.enter() // 与「点重新立起同步冻结」等价：整面冻结
  return guard.inspectingNow()
}
function resetWorld() {
  try { guard.exit() } catch (error) { /* 忽略 */ }
  try { guard.clearResendGrant() } catch (error) { /* 忽略 */ }
  return createWorld()
}
// 真页面实例：跑的就是页面的 `onResendAdvance`（不是我另抄一份编排）—— 这样"一次点击发几条"
// 才是**页面的**行为，而不是测试自己写的流程。
function pageInstance() {
  const source = capturedPage || {}
  const instance = { data: copy(source.data || {}) }
  Object.keys(source).forEach(key => { if (typeof source[key] === 'function') instance[key] = source[key].bind(instance) })
  instance.setData = patch => { Object.assign(instance.data, copy(patch)) }
  return instance
}
// 与真云函数同口径的两个只读通道：getReceipt 直接问引擎里的**真回执**；metadata 报真 revision。
// `cloudBroken` 用来构造"回执查询本身失败"（ok=false）—— 这一支绝不能被当成"云端没收到"。
function wireCloud(world, options = {}) {
  world.cloudFunctions['coachBusinessCommand'] = async data => {
    if (options.cloudBroken) return { ok: false, code: 'COMMAND_SERVICE_FAILED', message: '云端暂时不可用。' }
    if (data && data.action === 'getReceipt') {
      const receipt = world.engine.receiptFor(OWNER, data.requestId)
      return receipt ? { ok: true, found: true, status: receipt.status, response: receipt.response } : { ok: true, found: false }
    }
    return { ok: false, code: 'NOT_USED' }
  }
  world.cloudFunctions['readMyActiveCoachData'] = async () => ({ ok: true, dataRevision: world.revision(), datasetId: DATASET, collections: [] })
}

async function main() {
  console.log('=== 受控补发专项（第三阶段）===')

  // ───────────────────────── ① 计划表契约 ─────────────────────────
  await test('计划表 = 台账 16 条（手机 15 + 电脑 1），无重复、形状合法', async () => {
    const exact = []
    const tokens = []
    RESEND_PLAN.forEach(step => { (step.ids || []).forEach(id => exact.push(id)); (step.tokens || []).forEach(token => tokens.push(token)) })
    assert.strictEqual(exact.length + tokens.length, 16, '计划条目总数')
    PHONE_RESEND_IDS.concat(PC_RESEND_IDS).forEach(id => {
      if (id.length > 8) assert.includes(exact, id, '台账里的完整 id 必须在计划里')
      else assert.includes(tokens, id, '台账里只记到 token 的必须在计划的 tokens 里')
    })
    exact.concat(tokens).forEach(id => assert(/^ob_[0-9a-z]+(_[0-9a-z]+)*$/.test(id), 'id 形状必须合法：' + id))
    assert.strictEqual(new Set(exact).size, exact.length, '完整 id 不许重复')
    const orders = RESEND_PLAN.map(step => step.key)
    assert.strictEqual(new Set(orders).size, orders.length, '分组 key 不许重复')
  })

  await test('计划 ∩ 剔除白名单 = ∅（绝不把该删的补发出去）', async () => {
    const whitelist = PRUNE_WHITELIST.map(item => String(item.id))
    RESEND_PLAN.forEach(step => {
      ;(step.ids || []).forEach(id => assert(whitelist.indexOf(id) < 0, '补发条目不得出现在剔除白名单里：' + id))
      ;(step.tokens || []).forEach(token => assert(!whitelist.some(id => id.indexOf(token + '_') === 0), 'token 也不得与剔除白名单相交：' + token))
    })
  })

  await test('剔除白名单仍是 23 条且含 ob_3p_uxob42（「刘」的删除不可跳过）', async () => {
    assert.strictEqual(PRUNE_WHITELIST.length, 23, '白名单条数')
    assert.includes(PRUNE_WHITELIST.map(item => item.id), 'ob_3p_uxob42', '必须含刘的 deleteStudent')
  })

  // ───────────────────────── ② 纯函数 ─────────────────────────
  await test('匹配：完整 id 精确命中；token 只按前缀（ob_2b_… 命中，ob_2bb_… 不命中）', async () => {
    const custom = RESEND_PLAN.find(step => step.key === 'custom-4')
    const zhuge = RESEND_PLAN.find(step => step.key === 'zhuge-done')
    assert.strictEqual(page.resendMatches({ entryId: 'ob_2b_test1' }, custom), true)
    assert.strictEqual(page.resendMatches({ entryId: 'ob_2bb_test1' }, custom), false, '前缀不许误吞')
    assert.strictEqual(page.resendMatches({ entryId: 'ob_2b' }, custom), false, 'token 必须带下划线分隔')
    assert.strictEqual(page.resendMatches({ entryId: 'ob_29_l5cmqb' }, zhuge), true)
    assert.strictEqual(page.resendMatches({ entryId: 'ob_29_l5cmqc' }, zhuge), false)
  })

  await test('FIFO 纪律：全套在队 → 通过；多出一条未知条目 / 顺序错乱 → 拒绝', async () => {
    const world = resetWorld()
    seedPlanQueue(world)
    const ok = page.resendPrefixCheck(outbox.sendable(SCOPE), RESEND_PLAN)
    assert.strictEqual(ok.ok, true, '顺序正确时必须通过')
    assert.strictEqual(ok.step.key, 'zhuge-done', '下一组应是第一组')

    // 队首塞一条计划外条目（真实事故形状：队列里混进别的东西）
    const stray = outbox.enqueue(SCOPE, { command: 'createStudent', payload: { name: 'stray' }, requestId: 'req_stray', entityKey: 'createStudent' })
    outbox.patch(SCOPE, stray.entry.entryId, { entryId: 'ob_stray_x', seq: 0 })
    const bad = page.resendPrefixCheck(outbox.sendable(SCOPE), RESEND_PLAN)
    assert.strictEqual(bad.ok, false, '队首不是计划条目 ⇒ 必须拒绝')
    assert.strictEqual(bad.code, 'RESEND_ORDER_MISMATCH')

    // 还原队首，改成"顺序错乱"：把第二条挪到最前
    outbox.remove(SCOPE, 'ob_stray_x')
    const rows = outbox.list(SCOPE)
    outbox.patch(SCOPE, rows[1].entryId, { seq: 0 })
    const swapped = page.resendPrefixCheck(outbox.sendable(SCOPE), RESEND_PLAN)
    assert.strictEqual(swapped.ok, false, '顺序错乱 ⇒ 必须拒绝（跳条会破坏 createBooking → 内容 → 完课 的依赖）')
  })

  await test('sent-but-unknown 判据：出过网/未知/重试过 ⇒ 必须先查回执', async () => {
    assert.strictEqual(page.resendNeedsReceipt({ attempts: 0, status: 'pending' }), false, '全新条目（从未出网）无需回执')
    assert.strictEqual(page.resendNeedsReceipt({ attempts: 1, status: 'pending' }), true)
    assert.strictEqual(page.resendNeedsReceipt({ attempts: 0, status: 'unknown' }), true)
    assert.strictEqual(page.resendNeedsReceipt({ attempts: 0, status: 'pending', neverSent: false }), true)
    assert.strictEqual(page.resendNeedsReceipt({ attempts: 0, status: 'pending', neverSent: true }), false, '明确记为"从未出网"才允许直接发')
  })

  await test('单条判定：离开队列 + 回执 succeeded 才算确认；任一不满足都不算', async () => {
    assert.strictEqual(page.resendCommandVerdict({ leftQueue: true, receiptStatus: 'succeeded', revisionBefore: 143, revisionAfter: 144 }).ok, true)
    assert.strictEqual(page.resendCommandVerdict({ leftQueue: false, receiptStatus: 'succeeded' }).ok, false, '仍在队列 = 未确认')
    assert.strictEqual(page.resendCommandVerdict({ leftQueue: true, receiptStatus: null }).ok, false, '查不到回执 = 未确认')
    const stagnant = page.resendCommandVerdict({ leftQueue: true, receiptStatus: 'succeeded', revisionBefore: 144, revisionAfter: 144 })
    assert.strictEqual(stagnant.ok, true, 'revision 未推进只提示，不改判定（避免把合法命令判成失败）')
    assert(stagnant.notes.some(note => note.indexOf('revision') >= 0), '必须如实提示 revision 未推进')
  })

  // ───────────────────────── ③ 真引擎 + 真门禁：受控到底控不控得住 ─────────────────────────
  await test('冻结下：整轮 flush 一条都发不出去（受控补发的前提没被破坏）', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    const result = await sync.flush()
    assert.strictEqual(result.code, 'PRODUCTION_RECOVERY_READ_ONLY', '冻结下必须整轮拒发')
    assert.strictEqual(world.commandsSeen.length, 0, '云端一条都不该收到')
    assert.strictEqual(outbox.sendable(SCOPE).length, 16, '队列必须原样不动')
  })

  await test('没有授权时 step()：一条都不发（门禁的受控补发口默认关着）', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    await sync.step()
    assert.strictEqual(world.commandsSeen.length, 0, '没有授权 ⇒ 云端零命令')
    assert.strictEqual(outbox.sendable(SCOPE).length, 16)
  })

  await test('授权**非队首**条目：一条都不发（授权不许跳条）', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    const head = outbox.sendable(SCOPE)[0].entryId
    const second = outbox.sendable(SCOPE)[1].entryId
    assert(head !== second)
    guard.grantResend([second], '跳条实验')
    try { await sync.step() } finally { guard.clearResendGrant() }
    assert.strictEqual(world.commandsSeen.length, 0, '只授权第二条 ⇒ 队首没被放行 ⇒ 一条都不许发')
  })

  await test('授权队首：**恰好一条**（其余 15 条仍关在冻结里）', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    const head = outbox.sendable(SCOPE)[0]
    assert.strictEqual(head.entryId, 'ob_29_l5cmqb', '队首应是计划第一条')
    guard.grantResend([head.entryId], '受控补发 · 第一条')
    try { await sync.step() } finally { guard.clearResendGrant() }
    assert.strictEqual(world.commandsSeen.length, 1, '一次 step 只能尝试一条命令')
    assert.strictEqual(world.commandsSeen[0], 'createStudent')
    assert.strictEqual(outbox.entryById(SCOPE, head.entryId), null, '成功的条目应离开队列')
    assert.strictEqual(outbox.sendable(SCOPE).length, 15, '其余 15 条必须原样留在队列里')
  })

  await test('授权不清就等于继续放行同一条：第二步不会把下一条也发出去', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    const head = outbox.sendable(SCOPE)[0]
    guard.grantResend([head.entryId], '受控补发 · 第一条')
    try {
      await sync.step()
      const first = world.commandsSeen.length
      await sync.step() // 第二次：授权里那条已经出队，队首换人 ⇒ 不在授权里 ⇒ 必须停下
      assert.strictEqual(world.commandsSeen.length, first, '授权之外的条目一条都不许发')
    } finally { guard.clearResendGrant() }
    assert.strictEqual(outbox.sendable(SCOPE).length, 15)
  })

  await test('授权 ≠ 解冻：业务写入口与全局闸照旧全拦', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    const head = outbox.sendable(SCOPE)[0]
    guard.grantResend([head.entryId], '受控补发')
    try {
      assert.strictEqual(guard.blocksBusiness('production'), true, '不带 step 选项的全局闸必须仍然拦（mutate / 协调器 / resume 走的就是它）')
      assert.strictEqual(guard.inspectingNow(), true, '冻结仍然生效')
      const mutate = require(path.join(PROJ, 'utils', 'mutate'))
      const gate = typeof mutate.isWriteBlocked === 'function' ? mutate.isWriteBlocked() : null
      if (gate !== null) assert.strictEqual(gate, true, '业务写入口必须保持只读')
    } finally { guard.clearResendGrant() }
  })

  await test('被救援冻结锁定的条目：授权也放不过（锁优先于授权）', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    const head = outbox.sendable(SCOPE)[0]
    // 把锁定目标换成这条队列条目指向的课程 —— 模拟"这条链正好属于被冻结的那节课"
    world.store[guard.KEY] = { bookingId: 'booking_locked_1', datasetId: DATASET }
    outbox.patch(SCOPE, head.entryId, { payload: { name: 'T', bookingId: 'booking_locked_1' } })
    guard.grantResend([head.entryId], '受控补发 · 被锁的课')
    try { await sync.step() } finally { guard.clearResendGrant() }
    assert.strictEqual(world.commandsSeen.length, 0, '被锁定的条目永远不许发，即使被授权')
  })

  // ───────────────── ④ 一步 = 恰好一条命令（2026-09-22 修正的硬边界）─────────────────
  // 为什么这四条必须钉死：`step` 是恢复期唯一的发送口子。旧版的收工判据只数 `sent + rejected`，
  // 而「结果未知」「乐观锁冲突」两支**两个都不计** ⇒ 同一次点击会对**同一条**命令连发 3 次
  // （真机量化实测；号不变所以云端不会多出业务，但"这次点击到底发了几条"彻底说不清）。
  await test('一次点击的命令条数上界被写死为 1（改它必须是有意为之）', async () => {
    assert.strictEqual(page.RESEND_COMMANDS_PER_CLICK, 1, '一次点击最多一条命令')
  })

  await test('结论未知（传输抛错、回执也查不到）：一次 step() **恰好一次** execute，且当场停手', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    world.throwNetwork = true
    world.lostReceipt = true // 云端没收到、云端也没有回执 ⇒ 真·结果未知
    const head = outbox.sendable(SCOPE)[0]
    guard.grantResend([head.entryId], '未知结局实验')
    let summary = null
    try { summary = await sync.step() } finally { guard.clearResendGrant() }
    assert.strictEqual(world.commandsSeen.length, 1, '一次 step 只许一次 execute（旧版这里是 3 次）')
    assert.strictEqual(summary.executed, 1, '引擎必须自报 executed=1')
    const still = outbox.entryById(SCOPE, head.entryId)
    assert(still && still.status === 'unknown', '结论未知 ⇒ 条目留在队列里标 unknown，等人工决定')
    assert.strictEqual(outbox.sendable(SCOPE).length, 16, '队列条数不许变（一条都没出队）')
    outbox.sendable(SCOPE).filter(entry => entry.entryId !== head.entryId)
      .forEach(entry => assert.strictEqual(Number(entry.attempts || 0), 0, '下一条不许被牵连：' + entry.entryId))
    assert(still.lastError && still.lastError.code === 'COMMAND_RESULT_UNKNOWN', '本机必须记下错误码')
  })

  await test('乐观锁冲突：一次 step() **恰好一次** execute，且当场停手（不在同一步里重试）', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    const original = world.adapter.execute
    let executes = 0
    world.adapter.execute = async () => { executes += 1; return { ok: false, code: 'REVISION_CONFLICT', reason: 'STALE_REVISION', message: '数据已被其他设备更新。' } }
    const head = outbox.sendable(SCOPE)[0]
    guard.grantResend([head.entryId], '冲突实验')
    let summary = null
    try { summary = await sync.step() } finally { guard.clearResendGrant(); world.adapter.execute = original }
    assert.strictEqual(executes, 1, '一次 step 只许一次 execute（旧版会取回 revision 后用同号再来一次）')
    assert.strictEqual(summary.executed, 1, '引擎必须自报 executed=1')
    const still = outbox.entryById(SCOPE, head.entryId)
    assert(still && still.status === 'pending', '冲突后回 pending，等下一次人工点击')
    assert.strictEqual(Number(still.attempts || 0), 1, '冲突是**真·尝试过** ⇒ attempts 照常 +1')
    assert(Number(still.nextAttemptAt || 0) > 0, '必须排上退避，别原地打转')
    assert(still.lastError && still.lastError.reason === 'STALE_REVISION', 'adapter 的 reason 必须被保留下来')
  })

  await test('回执已 succeeded：一次 step() **零次** execute（只本地收敛出队，绝不重发）', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    const head = outbox.sendable(SCOPE)[0]
    // 造出「进程被杀 / 响应丢失」的真实形状：命令已在云端成功，本机却还悬着
    world.engine.seedReceipt(OWNER, head.requestId, {
      command: head.command, payloadHash: hashCommand(head.command, head.payload), status: 'succeeded',
      response: { ok: true, datasetRevision: 1 }
    })
    outbox.setStatus(SCOPE, head.entryId, 'settled', { settledRevision: null, attempts: 0, nextAttemptAt: 0 })
    guard.grantResend([head.entryId], '回执已成功，仅需出队')
    let summary = null
    try { summary = await sync.step() } finally { guard.clearResendGrant() }
    assert.strictEqual(world.commandsSeen.length, 0, '回执已成功 ⇒ 绝不许再发一次')
    assert.strictEqual(summary.executed, 0, '引擎必须自报 executed=0')
    assert.strictEqual(outbox.entryById(SCOPE, head.entryId), null, '应被清出队列（云端已确认，本机只欠一次出队）')
    assert.strictEqual(outbox.sendable(SCOPE).length, 15)
  })

  await test('清除授权后：queue 立刻回到"一条都发不出去"', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    guard.grantResend([outbox.sendable(SCOPE)[0].entryId], '临时授权')
    guard.clearResendGrant()
    await sync.step()
    assert.strictEqual(world.commandsSeen.length, 0, '授权清掉后必须一条都发不出去')
  })

  // ───────── ⑤ 回执结论的判读 + 真页面编排（跑的就是 onResendAdvance，不是我另抄一份）─────────
  await test('回执判读：只有「云端确认没有这一行」才允许重发；查询失败≠未找到', async () => {
    const cases = [
      [{ ok: false, found: false }, 'QUERY_FAILED', false],
      [{ ok: true, found: false }, 'NOT_FOUND', true],
      [{ ok: true, found: true, status: 'succeeded' }, 'SUCCEEDED', false],
      [{ ok: true, found: true, status: 'failed' }, 'FAILED', false],
      [{ ok: true, found: true, status: 'processing' }, 'PROCESSING', false],
      [{ ok: true, found: true, status: 'weird' }, 'UNKNOWN_STATUS', false]
    ]
    cases.forEach(pair => {
      const state = page.resendReceiptState(pair[0])
      assert.strictEqual(state.state, pair[1], '结论分类：' + JSON.stringify(pair[0]))
      assert.strictEqual(state.safeToResend, pair[2], '是否允许重发：' + JSON.stringify(pair[0]))
      assert(typeof state.label === 'string' && state.label.length > 0, '必须有人能读懂的标签')
    })
    assert(page.resendReceiptState({ ok: false }).label !== page.resendReceiptState({ ok: true, found: false }).label,
      '「查询失败」与「未找到」不许再显示成同一句话（这正是把网络抖动当成"云端没收到"的入口）')
  })

  await test('业务链 label：行里没带 label 也能反查出来（首列不再 undefined）', async () => {
    assert.strictEqual(page.resendChainLabel('ob_29_l5cmqb'), '诸葛逍遥 · 完课')
    assert.strictEqual(page.resendChainLabel('ob_2b_x1'), '4 个自定义动作（跳箱弓箭步 / 甩大绳 / 举手跳 / 髋飞机）')
    assert.strictEqual(page.resendChainLabel('ob_zz_unknown'), '计划外条目')
    const log = page.resendLogOf({
      atText: 'T', frozen: true, stopped: '停手',
      steps: [{
        entryId: 'ob_29_l5cmqb', command: 'completeBooking', ok: false, leftQueue: false, status: 'unknown',
        receiptState: 'NOT_FOUND', receiptLabel: page.RESEND_RECEIPT_LABELS.NOT_FOUND,
        revisionBefore: null, revisionAfter: null, idMapAdded: 0, executed: 1,
        lastError: 'COMMAND_RESULT_UNKNOWN', lastErrorReason: 'CLOUD_FUNCTION_TIMEOUT', lastErrorTechnical: 'errMsg=x',
        notes: ['仍在队列里']
      }]
    })
    assert(log.indexOf('undefined') < 0, '补发记录里不许出现 undefined：\n' + log)
    assert(log.indexOf('诸葛逍遥 · 完课') >= 0, '首列必须是业务链 label')
    assert(log.indexOf('CLOUD_FUNCTION_TIMEOUT') >= 0, '必须保留 adapter 的 reason（否则事后无法区分超时/断网）')
    assert(log.indexOf('未找到回执') >= 0, '回执结论必须照实印出来')
  })

  await test('页面编排：回执**查询失败** ⇒ 一条都不发（不许把"不知道"当成"云端没收到"）', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    const head = outbox.sendable(SCOPE)[0]
    outbox.patch(SCOPE, head.entryId, { status: 'unknown', attempts: 2 })
    wireCloud(world, { cloudBroken: true })
    const instance = pageInstance()
    await instance.onResendAdvance()
    assert.strictEqual(world.commandsSeen.length, 0, '回执查询失败 ⇒ 绝不允许重发')
    assert(outbox.entryById(SCOPE, head.entryId), '条目必须原样留在队列里')
    const modal = world.counters.modals[world.counters.modals.length - 1]
    assert(modal && modal.title.indexOf('停手') >= 0, '弹窗必须明确「已停手」')
    assert(modal.content.indexOf('undefined') < 0, '弹窗内容不许出现 undefined：\n' + (modal && modal.content))
    assert.strictEqual(world.store[guard.GRANT_KEY], undefined, '授权必须已被清掉（发完即关闸）')
  })

  await test('页面编排：回执 found=false ⇒ 原号受控重发，一次点击恰好一次 execute 并立即清授权', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    const head = outbox.sendable(SCOPE)[0]
    // 真机形状：attempts=3 且退避还没走完 —— 页面既然已经核对过回执，就该只清"等待秒数"再发这一条
    outbox.patch(SCOPE, head.entryId, { status: 'unknown', attempts: 3, nextAttemptAt: Date.now() + 60000 })
    wireCloud(world)
    const instance = pageInstance()
    await instance.onResendAdvance()
    assert.strictEqual(world.commandsSeen.length, 1, '一次点击恰好一次 execute')
    assert.strictEqual(outbox.entryById(SCOPE, head.entryId), null, '云端已确认 ⇒ 出队')
    assert.strictEqual(outbox.sendable(SCOPE).length, 15, '其余 15 条原样不动')
    assert.strictEqual(world.store[guard.GRANT_KEY], undefined, '授权必须已被清掉')
    const modal = world.counters.modals[world.counters.modals.length - 1]
    assert(modal && modal.title.indexOf('已停手') < 0, '这一条是确认成功的，不该报"停手"：' + (modal && modal.title))
    assert(modal.content.indexOf('undefined') < 0, '弹窗内容不许出现 undefined：\n' + (modal && modal.content))
  })

  await test('页面编排：结论未知 ⇒ 一次点击只发一条、当场停手、下一条不受牵连', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    world.throwNetwork = true
    world.lostReceipt = true
    wireCloud(world)
    const instance = pageInstance()
    await instance.onResendAdvance()
    assert.strictEqual(world.commandsSeen.length, 1, '一次点击只许一次 execute（旧版是 3 次）')
    assert.strictEqual(outbox.sendable(SCOPE).length, 16, '一条都没出队')
    const modal = world.counters.modals[world.counters.modals.length - 1]
    assert(modal && modal.title.indexOf('停手') >= 0, '结论未知必须停手')
    assert(modal.content.indexOf('undefined') < 0, '弹窗内容不许出现 undefined：\n' + (modal && modal.content))
    assert.strictEqual(world.store[guard.GRANT_KEY], undefined, '授权必须已被清掉')
  })

  await test('页面编排：锁定课程 + 全队冻结 ⇒ 点多少次都发不出去（step 也没绕过锁）', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    const head = outbox.sendable(SCOPE)[0]
    world.store[guard.KEY] = { bookingId: 'booking_locked_1', datasetId: DATASET }
    outbox.patch(SCOPE, head.entryId, { payload: { name: 'T', bookingId: 'booking_locked_1' } })
    wireCloud(world)
    const instance = pageInstance()
    await instance.onResendAdvance()
    assert.strictEqual(world.commandsSeen.length, 0, '被锁定的条目永远不许发')
    assert.strictEqual(outbox.sendable(SCOPE).length, 16, '队列原样不动')
    assert.strictEqual(world.store[guard.GRANT_KEY], undefined, '授权必须已被清掉')
  })

  await test('页面编排：回执 failed ⇒ 不许重发（云端已明确拒绝，等人判断）', async () => {
    const world = resetWorld()
    world.seed({ students: [] })
    seedPlanQueue(world)
    bootFrozen(world)
    const head = outbox.sendable(SCOPE)[0]
    outbox.patch(SCOPE, head.entryId, { status: 'unknown', attempts: 2 })
    world.cloudFunctions['coachBusinessCommand'] = async () => ({ ok: true, found: true, status: 'failed', response: { ok: false, code: 'PACKAGE_NO_REMAINING' } })
    world.cloudFunctions['readMyActiveCoachData'] = async () => ({ ok: true, dataRevision: world.revision(), datasetId: DATASET, collections: [] })
    const instance = pageInstance()
    await instance.onResendAdvance()
    assert.strictEqual(world.commandsSeen.length, 0, '回执 failed ⇒ 绝不允许重发')
    assert(outbox.entryById(SCOPE, head.entryId), '条目必须原样留在队列里')
    const modal = world.counters.modals[world.counters.modals.length - 1]
    assert(modal && modal.title.indexOf('停手') >= 0, '必须停手')
    assert(modal.content.indexOf('明确拒绝') >= 0, '必须说清"云端已明确拒绝"（与"查询失败"不是一个答案）')
    assert(modal.content.indexOf('PACKAGE_NO_REMAINING') >= 0, '必须带上云端给的错误码')
    assert.strictEqual(world.store[guard.GRANT_KEY], undefined, '授权必须已被清掉')
  })

  console.log('')
  if (fail) { console.log(failures.join('\n')); console.log(`\n${fail} 项失败 / 共 ${pass + fail} 项`) ; process.exit(1) }
  console.log(`ALL RESEND STEP TESTS PASSED (${pass}/${pass})`)
  process.exit(0)
}

main().catch(error => { console.error(error && error.stack || error); process.exit(1) })
