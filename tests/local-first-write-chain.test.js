// 【阶段 2 永久回归】本机先行写链：本机业务事务 + 持久 Outbox + 投影 + 后台同步。
//
// 覆盖四件事（每一件都对应一条真实故障）：
//   ① 规则只有一份：本机事务与云端事务在同一个载荷上必须得出**同一份结果**（22 条命令逐条对拍）。
//   ② 本机投影：getDB() = 云端已确认快照 + 队列里的本机意图；空队列时与阶段 1 逐字一致。
//   ③ 财务安全：双点下课 / 杀进程重开 / 超时 / 回执丢失 / 同号重放 / 两次同步
//      —— 最终只能「课时 −1、Income +1」，绝不能 −2 或两条。
//   ④ 连续 A→B→C→D→E：约课 → 加多个动作 → 下课，全部第一帧；云端参与度 = 0；
//      最终 5 条 booking 全 done、各自包各扣 1、Income 恰好 5 条、内容互不串。
const assert = require('assert')
const path = require('path')
const { createWorld, loadSessionPage, settle, delay, PROJ } = require('./helpers/local-first-world')

const mutate = require('../utils/mutate')
const outbox = require('../utils/local-outbox')
const projection = require('../utils/local-projection')
const localTx = require('../utils/local-transaction')
const { InMemoryCommandEngine, PAYLOAD_CONTRACT, SETTING_FIELDS } = require('../utils/cloud-command-engine')
const sync = require('../utils/sync-engine')

const SCOPE = { environment: 'production', datasetId: 'ds-test' }
const dstr = '2026-09-18'

// ---------------------------------------------------------------- 命令分类：31 条一条不落
const LOCAL_FIRST = mutate.LOCAL_FIRST_COMMANDS
const CLOUD_FIRST = mutate.CLOUD_FIRST_COMMANDS
const OPTIMISTIC = Object.keys(mutate.OPTIMISTIC_COMMANDS)
const all = [...LOCAL_FIRST, ...CLOUD_FIRST, ...OPTIMISTIC]
assert.strictEqual(all.length, 31, '三类相加必须是 31 条')
assert.strictEqual(new Set(all).size, 31, '三类之间不得有重叠')
assert.deepStrictEqual(all.slice().sort(), mutate.COMMANDS.slice().sort(), '三类必须正好覆盖 31 条业务命令')
assert.strictEqual(mutate.localFirstEnabled(), true, '阶段 2 必须启用本机先行')
assert.strictEqual(LOCAL_FIRST.length, 15, `本机先行应为 15 条（实测 ${LOCAL_FIRST.length}）`)
assert.strictEqual(CLOUD_FIRST.length, 15, `云端先行应为 15 条（实测 ${CLOUD_FIRST.length}）`)
// 学员的改/删必须在本机先行：这是「新增秒进 → 编辑秒改 → 删除秒删」的分类前提。
// 一旦有人把它们挪回云端先行，新增后的立即编辑/删除就会重新被云端 read/revision 准备挡住。
assert.ok(LOCAL_FIRST.includes('updateStudent') && LOCAL_FIRST.includes('deleteStudent'), 'updateStudent / deleteStudent 必须本机先行')
assert.ok(CLOUD_FIRST.includes('createStudent'), 'createStudent 仍是云端先行（页面新增走 createStudentWithPackages 本机原子批次）')
// 预约必须本机先行：这是「秒约」的分类前提。
// 一旦有人把它挪回 OPTIMISTIC，预约就会重新走协调器那条独立同步链，
// 后台 confirm 拿到"结果未知"时会当场弹「结果待确认」（1.1.5 真机故障）。
assert.ok(LOCAL_FIRST.includes('createBooking'), 'createBooking 必须本机先行')
assert.strictEqual(OPTIMISTIC.length, 1, `既由协调器负责的应只剩取消 1 条（实测 ${OPTIMISTIC.length}）`)
assert.deepStrictEqual(OPTIMISTIC, ['cancelBooking'], '协调器只负责 cancelBooking')
// 分类优先级必须高于页面给的 strategy 提示（页面以后不该再关心通道选择）
assert.strictEqual(mutate.strategyFor('updateBookingContent', { strategy: mutate.STRATEGIES.SILENT }), mutate.STRATEGIES.LOCAL_FIRST, '命令分类必须优先于页面的 strategy 提示')
assert.strictEqual(mutate.strategyFor('createPackage', { strategy: mutate.STRATEGIES.COMMAND }), mutate.STRATEGIES.COMMAND, '云端先行命令不得被本机先行截走')
assert.strictEqual(mutate.strategyFor('createBooking', {}), mutate.STRATEGIES.LOCAL_FIRST, '预约必须本机先行（秒约的前提）')
// 分类优先于页面提示这条规矩，也必须在**曾经的**协调器命令上成立：
// 页面就算还写着 strategy: 'silent'，也不能把 createBooking 从本机先行通道拽走。
assert.strictEqual(mutate.strategyFor('createBooking', { strategy: mutate.STRATEGIES.SILENT }), mutate.STRATEGIES.LOCAL_FIRST, '预约的分类必须盖过页面提示')
assert.strictEqual(mutate.strategyFor('cancelBooking', {}), mutate.STRATEGIES.OPTIMISTIC, '取消仍由既有协调器负责')
console.log('  ✓ 22 条命令分类：14 本机先行 / 7 云端先行 / 1 既有协调器（取消），无重叠无遗漏')

// ---------------------------------------------------------------- ①b 载荷门禁：假件与真云函数逐条一致
// 这条断言是「规则只有一份」的第一道防线，也是本轮真机问题的根因所在：
// 本机业务事务的执行底座是 utils/cloud-command-engine.js 的 handlers，一旦它比真实云函数**松**，
// 本机就会接受一条云端必然拒绝的命令 —— 界面先显示成功、同步时才被拒，用户看到的是"记了又没了"。
// 所以这里直接**读真实云函数的源码**，把每个 handler 的 requireOnly 允许字段抽出来逐条对拍。
// 它防的是"以后有人只改一边"：任何一边漂移，这条断言当场失败。
function scenarioPayloadContract() {
  const fs = require('fs')
  const source = fs.readFileSync(path.join(PROJ, 'cloudfunctions', 'coachBusinessCommand', 'handlers.js'), 'utf8')
  const blocks = source.split(/\n  async (\w+)\(/)
  const real = {}
  for (let index = 1; index < blocks.length; index += 2) {
    const name = blocks[index], body = blocks[index + 1]
    const matched = /requireOnly\(payload,\s*(\[[^\]]*\]|SETTING_FIELDS)\)/.exec(body)
    if (!matched) continue
    real[name] = matched[1] === 'SETTING_FIELDS'
      ? SETTING_FIELDS.slice()
      : (matched[1].match(/'([^']+)'/g) || []).map(item => item.slice(1, -1))
  }
  const names = mutate.COMMANDS.slice()
  assert.strictEqual(names.length, 31, '必须覆盖 31 条命令')
  const missing = names.filter(name => !real[name])
  assert.deepStrictEqual(missing, [], `真实云函数里找不到这些命令的载荷门禁：${missing.join('、')}`)
  names.forEach(name => {
    assert.deepStrictEqual(
      (PAYLOAD_CONTRACT[name] || []).slice().sort(),
      real[name].slice().sort(),
      `${name}：本机执行器允许的载荷字段必须与真实云函数逐条一致（多一个字段就是"本机接受了云端必拒的命令"）`
    )
  })
  assert.strictEqual(Object.keys(PAYLOAD_CONTRACT).length, 31, '载荷契约必须覆盖全部 31 条命令')
  console.log('  ✓ 载荷门禁：31 条命令本机执行器 ≡ 真实云函数（直接读 handlers.js 源码对拍）')
}
scenarioPayloadContract()

// ---------------------------------------------------------------- ① 规则只有一份：逐条对拍
// 对拍口径：把同一条命令、同一份载荷分别喂给「本机业务事务」与「云端纯业务引擎」，
// 然后比较**去掉 id 之后的业务指纹**（数量、金额、课时、状态、内容、摘要…）。
// 这是"本机先算出来的"和"云端会算出来的"必须一样的证明；任何一条不一致都会当场照亮。
function fingerprint(state) {
  const money = value => Number(value == null ? 0 : value).toFixed(2)
  return JSON.stringify({
    students: (state.students || []).map(s => ({ name: s.name, phone: s.phone == null ? '' : s.phone, status: s.status || 'active', packages: (s.packages || []).map(p => ({ type: p.type, total: p.total, used: p.used, remaining: p.remaining, price: money(p.price), status: p.status || 'active', isGift: !!p.isGift })) })),
    bookings: (state.bookings || []).map(b => ({ studentName: b.studentName || '', date: b.date, hour: b.hour, minute: b.minute || 0, typeName: b.typeName, price: money(b.price), status: b.status, category: b.category || '', duration: b.duration || 0, notes: b.notes == null ? '' : b.notes, items: (b.items || []).map(i => ({ name: i.name, group: i.group, sets: i.sets, reps: i.reps, weight: i.weight, minutes: i.minutes })), summary: b.summary || '' })),
    incomes: (state.incomes || []).map(i => ({ date: i.date, time: i.time || '', typeName: i.typeName, category: i.category || '', amount: money(i.amount), studentName: i.studentName || '' })),
    sales: (state.sales || []).map(s => ({ source: s.source, typeName: s.typeName || '', name: s.name == null ? '' : s.name, quantity: s.quantity == null ? null : s.quantity, unitPrice: s.unitPrice == null ? null : money(s.unitPrice), amount: money(s.amount), date: s.date, validFrom: s.validFrom || '', validTo: s.validTo || '', note: s.note == null ? '' : s.note, status: s.status || 'active' })),
    settings: state.settings || {},
    customExercises: (state.customExercises || []).map(x => ({ name: x.name, group: x.group }))
  })
}

const ITEMS = [{ name: '卧推', group: '胸', sets: 4, reps: 12, weight: 40 }]
function baseSeed(extra = {}) {
  return {
    students: [{ id: 'stu-1', name: '学员甲', phone: '138', status: 'active', packages: [{ id: 'pkg-1', type: '常规训练', price: 100, total: 10, used: 0, remaining: 10, status: 'active' }, { id: 'pkg-gift', type: '赠送课程', price: 80, total: 5, used: 0, remaining: 5, status: 'active', isGift: true }] }],
    bookings: [{ id: 'bk-1', studentId: 'stu-1', studentName: '学员甲', packageId: 'pkg-1', date: dstr, hour: 10, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: ITEMS, notes: '' }],
    incomes: [], sales: [], settings: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 0, salesCommissionRate: 0 },
    customExercises: [{ id: 'ce-1', name: '自定义动作', group: '肩' }],
    ...extra
  }
}
const PARITY_CASES = [
  { command: 'createStudent', payload: { name: '新学员', phone: '139' } },
  { command: 'updateStudent', payload: { studentId: 'stu-1', name: '学员甲改' } },
  { command: 'deleteStudent', payload: { studentId: 'stu-1' } },
  { command: 'createPackage', payload: { studentId: 'stu-1', type: '赠送课程', total: 6, remaining: 6 } },
  { command: 'createCourseSale', payload: { studentId: 'stu-1', type: '常规训练', total: 12, remaining: 12, quantity: 12, unitPrice: 100, amount: 1200, date: dstr } },
  { command: 'updatePackage', payload: { packageId: 'pkg-gift', total: 8, remaining: 7 } },
  { command: 'deletePackage', payload: { packageId: 'pkg-gift' } },
  { command: 'updateCourseSale', payload: { saleId: 'sale-1', quantity: 12, remaining: 12, unitPrice: 100, amount: 1200, date: dstr }, seed: { sales: [{ id: 'sale-1', source: 'course', studentId: 'stu-1', packageId: 'pkg-sale', typeName: '常规训练', quantity: 10, unitPrice: 100, amount: 1000, date: dstr }], students: [{ id: 'stu-1', name: '学员甲', status: 'active', packages: [{ id: 'pkg-sale', type: '常规训练', price: 100, total: 10, used: 0, remaining: 10, status: 'active', saleId: 'sale-1' }] }] } },
  { command: 'reverseCourseSale', payload: { saleId: 'sale-1' }, seed: { sales: [{ id: 'sale-1', source: 'course', studentId: 'stu-1', packageId: 'pkg-sale', typeName: '常规训练', quantity: 10, unitPrice: 100, amount: 1000, date: dstr }], students: [{ id: 'stu-1', name: '学员甲', status: 'active', packages: [{ id: 'pkg-sale', type: '常规训练', price: 100, total: 10, used: 0, remaining: 10, status: 'active', saleId: 'sale-1' }] }] } },
  { command: 'createBooking', payload: { studentId: 'stu-1', packageId: 'pkg-1', date: dstr, hour: 15, minute: 0 } },
  { command: 'setPackageShare', payload: { packageId: 'pkg-1', enabled: true } },
  // ★ 共享预约**只能由云端裁决**：本机手里没有共享课时包那本账（它物理存在另一位教练的数据集里），
  //   所以本机与云端在同一份载荷上必须给出**同一个** SHARE_NOT_FOUND —— 本机绝不许"先自己算一个结果出来"。
  { command: 'createSharedBooking', payload: { shareCode: 'ZZZZZZZZZZ', date: dstr, hour: 16, minute: 0 } },
  // ★ M2 V1 双层授权**只能由云端裁决**：本机手里既没有授权表（它在元集合里）也没有对端账本，
  //   所以本机与云端在同一份载荷上必须给出**同一个** AUTHORIZATION_REQUIRES_CLOUD ——
  //   本机绝不许"先自己算一个授权结果出来"。
  { command: 'createAuthorizedBooking', payload: { studentId: 'stu-1', packageId: 'pkg-1', date: dstr, hour: 16, minute: 0 } },
  { command: 'grantMemberService', payload: { studentId: 'stu-1', publicCodes: ['CODE-A'] } },
  { command: 'revokeMemberService', payload: { studentId: 'stu-1', publicCode: 'CODE-A' } },
  { command: 'grantPackageTeaching', payload: { packageId: 'pkg-1', publicCodes: ['CODE-A'] } },
  { command: 'revokePackageTeaching', payload: { packageId: 'pkg-1', publicCode: 'CODE-A' } },
  { command: 'transferPackageManagement', payload: { packageId: 'pkg-1', publicCode: 'CODE-A' } },
  { command: 'updateBookingContent', payload: { bookingId: 'bk-1', items: ITEMS, notes: '备注', category: '综合训练', duration: 60 } },
  { command: 'rescheduleBooking', payload: { bookingId: 'bk-1', date: dstr, hour: 18, minute: 30 } },
  { command: 'cancelBooking', payload: { bookingId: 'bk-1' } },
  { command: 'markBookingNotHeld', payload: { bookingId: 'bk-1' } },
  // ★ 完课的载荷**只有 bookingId**：训练动作来自这条预约自己的 items（由 updateBookingContent 先落库）。
  //   真实云函数就是这么写的，并且用 requireOnly 明确禁止多带字段。
  { command: 'completeBooking', payload: { bookingId: 'bk-1' } },
  { command: 'deleteCompletedBooking', payload: { bookingId: 'bk-1' }, seed: { bookings: [{ id: 'bk-1', studentId: 'stu-1', studentName: '学员甲', packageId: 'pkg-1', date: dstr, hour: 10, minute: 0, typeName: '常规训练', price: 100, status: 'done', items: ITEMS }], incomes: [{ id: 'in-1', bookingId: 'bk-1', studentId: 'stu-1', studentName: '学员甲', date: dstr, time: '10:00', typeName: '常规训练', category: '综合训练', amount: 100 }], students: [{ id: 'stu-1', name: '学员甲', status: 'active', packages: [{ id: 'pkg-1', type: '常规训练', price: 100, total: 10, used: 1, remaining: 9, status: 'active' }] }] } },
  { command: 'createManualSale', payload: { typeName: '体验课', amount: 300, date: dstr, note: '手工业绩' } },
  { command: 'updateManualSale', payload: { saleId: 'ms-1', date: '2026-09-19' }, seed: { sales: [{ id: 'ms-1', source: 'manual', typeName: '体验课', amount: 300, date: dstr, note: '' }] } },
  { command: 'deleteManualSale', payload: { saleId: 'ms-1' }, seed: { sales: [{ id: 'ms-1', source: 'manual', typeName: '体验课', amount: 300, date: dstr, note: '' }] } },
  { command: 'saveSettings', payload: { renewThreshold: 8, monthlyGoalSessions: 44 } },
  { command: 'createCustomExercise', payload: { name: '新动作', group: '腿' } },
  { command: 'updateCustomExercise', payload: { customExerciseId: 'ce-1', name: '自定义动作改', group: '背' } },
  { command: 'deleteCustomExercise', payload: { customExerciseId: 'ce-1' } }
]
function scenarioParity() {
  assert.strictEqual(PARITY_CASES.length, 31, '对拍必须覆盖全部 31 条命令')
  let compared = 0
  PARITY_CASES.forEach(item => {
    const seed = baseSeed(item.seed || {})
    const engine = new InMemoryCommandEngine({ now: () => 1700000000000, idFactory: kind => `${kind}_srv` })
    engine.seed('coach', JSON.parse(JSON.stringify(seed)))
    const cloudResponse = engine.execute({ ownerCoachId: 'coach' }, { command: item.command, requestId: `parity_${item.command}`, expectedRevision: 0, payload: item.payload })
    const local = localTx.applyCommand(seed, item.command, item.payload, { now: () => 1700000000000, id: kind => `${kind}_loc` })
    assert.strictEqual(local.ok, cloudResponse.ok, `${item.command}：本机与云端"能/不能执行"的结论必须一致（本机 ${local.ok ? 'ok' : local.code} / 云端 ${cloudResponse.ok ? 'ok' : cloudResponse.code}）`)
    if (!local.ok) { assert.strictEqual(local.code, cloudResponse.code, `${item.command}：拒绝时的错误码必须逐字一致`); compared += 1; return }
    const cloudState = engine.read('coach')
    assert.strictEqual(fingerprint(local.db), fingerprint(cloudState), `${item.command}：本机事务结果与云端事务结果必须逐字一致`)
    compared += 1
  })
  assert.strictEqual(compared, 31, '31 条命令必须全部完成对拍')
  console.log('  ✓ 规则只有一份：31 条命令本机事务 ≡ 云端事务（含拒绝时的错误码）')
}

// ---------------------------------------------------------------- ② 投影：空队列 = 阶段 1；有队列 = 本机可见
async function scenarioProjection() {
  const world = createWorld()
  world.seed(baseSeed())
  const runtime = require('../utils/data-runtime')
  const snapshot = JSON.parse(JSON.stringify(world.localDB()))
  assert.strictEqual(projection.project(snapshot, SCOPE, world.revision()), null, '队列为空时投影必须走快路径（返回 null，直接用快照）')
  assert.strictEqual(runtime.getDB().bookings.length, 1, '空队列时页面读到的就是云端快照')

  const result = await mutate('updateBookingContent', { bookingId: 'bk-1', notes: '本机先写' })
  assert.strictEqual(result.path, 'local-first')
  const projected = runtime.getDB()
  assert.strictEqual(projected.bookings[0].notes, '本机先写', '投影必须立刻包含本机意图')
  const raw = world.store.coachCloudActiveCache.snapshot
  assert.strictEqual(
    JSON.stringify(raw),
    JSON.stringify(snapshot),
    '投影绝不能写进 cache —— cache 永远是"云端那一份"（写入前后必须逐字节相同）'
  )
  assert.notStrictEqual(raw.bookings[0].notes, '本机先写', '本机意图不得渗进 cache')
  assert.strictEqual(world.counters.readActive, 0, '本机先行不得触发任何全量回读')
  assert.strictEqual(world.counters.calls.length, 0, '本机先行不得等云端')
  console.log('  ✓ 本机投影：只读派生、不写 cache、零全量回读、零云端等待')
}

// ---------------------------------------------------------------- ③ 财务安全
function financeWorld() {
  const world = createWorld()
  world.seed(baseSeed())
  return world
}
const financeFingerprint = world => {
  const state = world.snapshot()
  const pkg = state.students[0].packages.find(item => item.id === 'pkg-1')
  return { used: Number(pkg.used || 0), remaining: Number(pkg.remaining || 0), incomes: state.incomes.length, status: state.bookings.find(b => b.id === 'bk-1').status }
}
async function scenarioFinance() {
  // (a) 连点两次下课：同一条业务事实只会产生一条队列条目
  {
    const world = financeWorld()
    // 闸门：把这一拍的同步关掉，让"连点两下"确定性地落在同一条队列条目上。
    // 不用 sleep 赌时间 —— 那只会在慢机器上装成一次假通过。
    world.online = false
    const first = await mutate('completeBooking', { bookingId: 'bk-1' })
    const second = await mutate('completeBooking', { bookingId: 'bk-1' })
    assert.strictEqual(first.requestId, second.requestId, '同一节课的完课号必须稳定不变')
    assert.strictEqual(second.duplicate, true, '第二次必须被识别为同一条业务（不新增队列条目）')
    assert.strictEqual(outbox.count(SCOPE), 1, `连点两次只能有一条待同步（实测 ${outbox.count(SCOPE)}）`)
    assert.strictEqual(world.localDB().incomes.length, 1, '本机投影里收入也只有一条')
    world.online = true
    await sync.flush(); await settle()
    assert.deepStrictEqual(financeFingerprint(world), { used: 1, remaining: 9, incomes: 1, status: 'done' }, '连点两次：课时 −1、Income +1')
  }
  // (b) 杀进程重开：号不变，云端仍是同一次业务
  {
    const world = financeWorld()
    world.online = false
    const before = await mutate('completeBooking', { bookingId: 'bk-1' })
    world.restartProcess()
    const after = world.outboxEntries()
    assert.strictEqual(after.length, 1, '重开后队列还在')
    assert.strictEqual(after[0].requestId, before.requestId, '重开后 requestId 不能变成新号')
    world.online = true
    await require('../utils/sync-engine').flush(); await settle()
    assert.deepStrictEqual(financeFingerprint(world), { used: 1, remaining: 9, incomes: 1, status: 'done' }, '杀进程重开：课时 −1、Income +1')
  }
  // (c) 命令已提交、响应在网络里丢了（客户端只看到"结果未知"）—— 靠回执收敛，绝不重复
  {
    const world = financeWorld()
    await mutate('completeBooking', { bookingId: 'bk-1' })
    world.dropResponse = 1
    await sync.flush(); await settle()
    assert.deepStrictEqual(financeFingerprint(world), { used: 1, remaining: 9, incomes: 1, status: 'done' }, '响应丢失：必须靠回执认出"其实已经成功"，不能重复扣')
    assert.strictEqual(outbox.count(SCOPE), 0, '回执确认后必须出队')
  }
  // (d) 回执也查不到 + 网络中断：保留原号退避，绝不换号重发
  {
    const world = financeWorld()
    await mutate('completeBooking', { bookingId: 'bk-1' })
    world.throwNetwork = true
    world.lostReceipt = true
    await sync.flush(); await settle()
    assert.strictEqual(outbox.count(SCOPE), 1, '结果仍未确定时条目必须留在队列里（保留原号）')
    assert.strictEqual(world.snapshot().incomes.length, 0, '云端一次都没成功过，不该有收入')
    // 恢复网络：必须走 app.js 真实入口（解除退避 + 补发），不能靠测试绕过退避直接 flush。
    await world.restoreNetwork(); await settle()
    await sync.flush(); await settle()
    assert.deepStrictEqual(financeFingerprint(world), { used: 1, remaining: 9, incomes: 1, status: 'done' }, '网络恢复后用原号重发：仍然只扣 1、只记 1 条')
    const replayed = world.counters.calls.filter(item => item.command === 'completeBooking')
    assert.equal(replayed.length > 1, true, '断网期间与恢复网络后都必须真的尝试过发送')
    assert.strictEqual(new Set(replayed.map(item => item.requestId)).size, 1, '恢复网络前后必须是同一个号（绝不换号重发）')
  }
  // (e) 同 requestId 重放（两次同步 / 两台设备）：服务端认成同一次请求
  {
    const world = financeWorld()
    const first = await mutate('completeBooking', { bookingId: 'bk-1' })
    await sync.flush(); await settle()
    const replay = await world.adapter.execute('completeBooking', { bookingId: 'bk-1' }, { requestId: first.requestId })
    assert.strictEqual(replay.idempotent, true, '同号重放必须被服务端认成同一次请求')
    assert.deepStrictEqual(financeFingerprint(world), { used: 1, remaining: 9, incomes: 1, status: 'done' }, '同号重放：仍然只扣 1、只记 1 条')
    await sync.flush(); await settle()
    assert.deepStrictEqual(financeFingerprint(world), { used: 1, remaining: 9, incomes: 1, status: 'done' }, '再同步一次也不能多扣')
  }
  console.log('  ✓ 财务安全：双点 / 杀进程 / 响应丢失 / 回执丢失 / 同号重放 / 两次同步 —— 都只课时 −1、Income +1')
}

// ---------------------------------------------------------------- ④ 真实页面：下课第一帧 + 零遮罩
async function scenarioSessionFirstFrame() {
  const world = createWorld()
  world.seed(baseSeed())
  const page = loadSessionPage()
  page.id = 'bk-1'
  page.localId = 'bk-1'
  page.load()
  assert.strictEqual(page.data.done, false, '课程初始应为待完成')
  page.setData({ items: ITEMS, category: '综合训练' })

  const started = Date.now()
  const handle = await page.complete()
  const elapsed = Date.now() - started
  assert.strictEqual(handle.deferred, true, '下课必须第一帧返回（后台链交给 handle.settled）')
  assert.equal(elapsed < 200, true, `下课必须第一帧（实测 ${elapsed}ms）`)
  assert.strictEqual(world.counters.loading, 0, '下课不得出现全屏 loading')
  assert.strictEqual(world.counters.calls.length, 0, '第一帧不得等云端')

  const settled = await handle.settled
  assert.strictEqual(settled.code, 'COMPLETED_LOCAL_FIRST', `完课必须以本机先行收尾（实测 ${settled.code}）`)
  assert.strictEqual(world.counters.loading, 0, '整条完课链都不得出现遮罩')
  assert.strictEqual(world.counters.modals.filter(m => /待确认|正在保存|正在同步|课程未完成/.test(String(m.title))).length, 0, '不得出现任何同步/失败模态框')
  const db = world.localDB()
  assert.strictEqual(db.bookings.find(b => b.id === 'bk-1').status, 'done', '第一帧后课程就是已完成')
  assert.strictEqual(db.incomes.length, 1, '第一帧后收入就是一条')
  assert.strictEqual(db.students[0].packages.find(p => p.id === 'pkg-1').used, 1, '第一帧后课时就是 −1')

  await sync.flush(); await settle()
  assert.deepStrictEqual(financeFingerprint(world), { used: 1, remaining: 9, incomes: 1, status: 'done' }, '后台同步后云端与本机一致')
  console.log('  ✓ 真实课程页「下课」：第一帧完成、零遮罩、零等待，后台同步后云端一致')
}

// ---------------------------------------------------------------- ⑤ 连续 A→B→C→D→E
async function scenarioSequential() {
  const world = createWorld()
  world.seed({ students: [{ id: 'stu-1', name: '学员甲', status: 'active', packages: [{ id: 'pkg-1', type: '常规训练', price: 100, total: 10, used: 0, remaining: 10, status: 'active' }] }], bookings: [], incomes: [], sales: [], settings: {}, customExercises: [] })
  // 预约走既有协调器；这里把协调器设为"离线"，强迫预约走本机先行队列（这正是阶段 2 新增的离线能力）。
  world.coordinatorOffline = true
  // 整节五课都**断网**跑：这样"用户操作期间云端参与度 = 0"才是可证的结论，
  // 而不是"后台同步碰巧还没跑到"。恢复网络放到五节全部做完之后。
  world.online = false
  const marks = ['A课', 'B课', 'C课', 'D课', 'E课']
  const hours = [8, 9, 10, 11, 12]
  const localIds = []
  const allModals = () => world.counters.modals.filter(m => /待确认|正在保存|正在同步|未完成|已变化|失败/.test(String(m.title))).length

  for (let index = 0; index < marks.length; index += 1) {
    const started = Date.now()
    // 约课
    const created = await mutate('createBooking', { studentId: 'stu-1', packageId: 'pkg-1', date: dstr, hour: hours[index], minute: 0 })
    assert.strictEqual(created.ok, true, `${marks[index]}：约课必须成功`)
    assert.strictEqual(created.path, 'local-first', `${marks[index]}：约课必须走本机先行（断网也能约）`)
    const bookingId = created.result.bookingId
    localIds.push(bookingId)
    // 立即进入 + 加多个动作（用本机内生成的 id 直接写内容 —— 正式 id 由同步层转正）
    const content = await mutate('updateBookingContent', { bookingId, items: [{ name: `${marks[index]}-动作1`, group: '胸', sets: 4, reps: 10, weight: 40 }, { name: `${marks[index]}-动作2`, group: '背', sets: 3, reps: 12, weight: 30 }], notes: `${marks[index]}备注`, category: '综合训练', duration: 60 })
    assert.strictEqual(content.ok, true, `${marks[index]}：加动作必须成功`)
    // 下课（载荷只有 bookingId：动作来自上面刚写进这条预约的内容）
    const done = await mutate('completeBooking', { bookingId })
    assert.strictEqual(done.ok, true, `${marks[index]}：下课必须成功`)
    const elapsed = Date.now() - started
    assert.equal(elapsed < 250, true, `${marks[index]}：整节（约课+加动作+下课）必须第一帧完成（实测 ${elapsed}ms）`)
    assert.strictEqual(world.counters.calls.length, 0, `${marks[index]}：用户操作期间云端参与度必须为 0`)
    assert.strictEqual(world.counters.readActive, 0, `${marks[index]}：不得触发全量回读`)
    const db = world.localDB()
    assert.strictEqual(db.bookings.filter(b => b.status === 'done').length, index + 1, `${marks[index]}：本机已完成课程数应为 ${index + 1}`)
    assert.strictEqual(db.incomes.length, index + 1, `${marks[index]}：本机收入应为 ${index + 1} 条`)
  }
  assert.strictEqual(world.counters.loading, 0, '连续 5 节全程不得出现全屏 loading')
  assert.strictEqual(allModals(), 0, '连续 5 节不得出现任何失败/同步模态框')

  // 恢复网络 → 后台逐条同步 → 云端与本机业务事实一致
  world.online = true
  await sync.flush()
  await settle(80)
  const state = world.snapshot()
  assert.strictEqual(state.bookings.length, 5, `云端应有 5 条 booking（实测 ${state.bookings.length}）`)
  assert.strictEqual(state.bookings.filter(b => b.status === 'done').length, 5, '5 节必须全部 done')
  assert.strictEqual(state.incomes.length, 5, `Income 必须恰好 5 条（实测 ${state.incomes.length}）`)
  const pkg = state.students[0].packages.find(p => p.id === 'pkg-1')
  assert.strictEqual(Number(pkg.used), 5, `同一个包必须正好扣 5 节（实测 ${pkg.used}）`)
  assert.strictEqual(Number(pkg.remaining), 5, '剩余必须正好 5')
  marks.forEach((mark, index) => {
    const booking = state.bookings.find(b => (b.items || []).some(i => i.name === `${mark}-动作1`))
    assert.ok(booking, `${mark} 的训练内容必须在云端存在`)
    assert.strictEqual(booking.items.length, 2, `${mark} 必须有自己的两个动作`)
    assert.strictEqual(booking.notes, `${mark}备注`, `${mark} 的备注不得串到别的课`)
    assert.ok(booking.items.every(i => i.name.startsWith(mark)), `${mark} 的动作名称不得串包`)
  })
  assert.strictEqual(state.incomes.filter(i => !i.bookingId).length, 0, '每条收入都必须挂在一条 booking 上')
  assert.strictEqual(new Set(state.incomes.map(i => i.bookingId)).size, 5, '5 条收入必须分别挂在 5 节不同的课上')
  const ids = state.bookings.map(b => b.id)
  assert.strictEqual(new Set(ids).size, 5, '正式 id 必须互不相同')
  assert.ok(state.bookings.every(b => !String(b.id).startsWith('loc_')), '云端不得残留本机临时 id')
  assert.ok(localIds.every(id => String(id).startsWith('loc_')), '本机临时 id 必须能被认出来（并已转正）')
  assert.strictEqual(outbox.count(SCOPE), 0, '同步完成后队列必须清空')
  console.log('  ✓ 连续 A→B→C→D→E：全程第一帧、云端参与度 0，最终 5 节全 done / 各扣 1 / Income 恰好 5 条 / 内容互不串')
}

// ---------------------------------------------------------------- ⑥ 断网 → 杀进程 → 恢复网络
async function scenarioOffline() {
  const world = createWorld()
  world.seed({ students: [{ id: 'stu-1', name: '学员甲', status: 'active', packages: [{ id: 'pkg-1', type: '常规训练', price: 100, total: 10, used: 0, remaining: 10, status: 'active' }] }], bookings: [], incomes: [], sales: [], settings: {}, customExercises: [] })
  world.coordinatorOffline = true
  world.online = false

  const created = await mutate('createBooking', { studentId: 'stu-1', packageId: 'pkg-1', date: dstr, hour: 9, minute: 0 })
  assert.strictEqual(created.ok, true, '断网时必须能约课')
  const items = [{ name: '断网动作', group: '腿', sets: 4, reps: 10, weight: 50 }]
  assert.strictEqual((await mutate('updateBookingContent', { bookingId: created.result.bookingId, items, notes: '断网录的内容', category: '综合训练', duration: 45 })).ok, true, '断网时必须能加动作')
  assert.strictEqual((await mutate('completeBooking', { bookingId: created.result.bookingId })).ok, true, '断网时必须能下课')
  assert.strictEqual(world.counters.calls.length, 0, '断网期间云端调用必须为 0')

  const db = world.localDB()
  assert.strictEqual(db.bookings[0].status, 'done', '断网时本机也必须立刻是已完成')
  assert.strictEqual(db.incomes.length, 1, '断网时本机收入也必须立刻出现')
  assert.strictEqual(db.students[0].packages[0].used, 1, '断网时本机课时也必须立刻 −1')
  assert.strictEqual(db.bookings[0].notes, '断网录的内容', '断网时录的内容必须留在本机')

  // —— 杀进程再打开 ——
  const idsBefore = world.outboxEntries().map(entry => entry.requestId)
  world.restartProcess()
  const sync2 = require('../utils/sync-engine')
  const after = world.outboxEntries()
  assert.strictEqual(after.length, 3, `重开后三条待同步必须都在（实测 ${after.length}）`)
  assert.deepStrictEqual(after.map(entry => entry.requestId), idsBefore, '重开后号必须逐个不变')
  assert.strictEqual(world.localDB().bookings[0].status, 'done', '重开后本机数据仍在（用户录的课没丢）')

  // —— 恢复网络 ——
  world.online = true
  await sync2.flush()
  await settle(80)
  const state = world.snapshot()
  assert.strictEqual(state.bookings.length, 1, '恢复网络后云端恰好 1 条预约')
  assert.strictEqual(state.bookings[0].status, 'done', '云端的课必须已完成')
  assert.strictEqual(state.bookings[0].notes, '断网录的内容', '云端内容必须与断网时录的一致')
  assert.strictEqual(state.incomes.length, 1, '云端收入恰好 1 条')
  assert.strictEqual(Number(state.students[0].packages[0].used), 1, '云端课时恰好 −1')
  assert.strictEqual(outbox.count(SCOPE), 0, '队列必须清空')
  console.log('  ✓ 断网 → 约课+加动作+下课 → 杀进程重开 → 恢复网络：不丢、不重、云端与本机一致')
}

async function main() {
  scenarioParity()
  await scenarioProjection()
  await scenarioFinance()
  await scenarioSessionFirstFrame()
  await scenarioSequential()
  await scenarioOffline()
  console.log('PASS 阶段2 本机先行写链（规则唯一 / 投影 / 财务安全 / 连续多课 / 离线收敛）')
  process.exit(0)
}
main().catch(error => { console.error(error && error.stack || error); process.exit(1) })
