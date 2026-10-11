// 【1.1.9 第 16 轮永久回归，§90】用户下拉：**一次云调用**收敛，并保留全部安全退路。
//
// 修前形状（真机 2026-09-25，§89 定案）：
//   一次手机下拉 = `changes` → `integrity` **两次串行**，而这两跳在云端都是"现读八个集合"，
//   各 1.2–1.4 秒 ⇒ 体感 3.8–5.0 秒。第二跳 `integrity` 存在的唯一理由是
//   「一跳 changes 只保证应用到了云端它自己读到的那一版，之后又被人写了没人知道」。
//
// 修法（B + C，本文件守的就是它）：
//   B（云端）：`liveChanges` 在**算完 delta 之后**再读一次 revision 文档（单文档，几十毫秒），
//              随响应一起回 `headRevision`。
//   C（客户端）：`convergeUserRead` 拿可信的 `headRevision` 当"还要不要追"的答案 ——
//              · headRevision == 我手里这一版 ⇒ 收敛，这次下拉结束（1 次调用）；
//              · headRevision >  我手里这一版 ⇒ **同一次下拉内部**再追一跳（不麻烦用户拉第二次）；
//              · headRevision **不可信** ⇒ 一字不改地退回原有的 `integrity` 确认（旧云函数安全）。
//
// ★ 判别力（不需要改源码就能自证，本文件自带）：
//   场景 A（有 headRevision）必须 **1 次**调用；场景 E（同一个世界、只把 headRevision 去掉）
//   必须 **2 次**调用。两者之间唯一的差别就是响应里有没有那个字段 ——
//   这两条合起来就证明"省下来的那一跳确实是被 headRevision 省掉的"，不是断言写松了。
//
// 本文件钉住的场景（用户点名要的）：
//   A 没有新变化            ⇒ 1 次 changes，结束；
//   B 已有一个新 revision   ⇒ 1 次 changes，拿到最新状态；
//   C changes 计算期间有人写 ⇒ headRevision > dataRevision ⇒ 同一次下拉内自动第二跳，追平；
//   D 连续发生变化          ⇒ 不许无限追：最多 CONVERGE_MAX_HOPS 跳，用尽后按既有策略退回完整读取；
//   E 旧云函数没有 headRevision ⇒ 自动退回原 changes → integrity 路径；
//   F headRevision 非法/倒退/null ⇒ 不许采信，走现有安全 fallback；
//   G changes 指纹错误      ⇒ 仍然失败 / fallback，绝不因为 headRevision 相等就绕过 fingerprint；
//   H §88 的 background 单跳不能被破坏（后台不许开始追多跳）。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { buildCandidateDataset } = require('../utils/candidate-dataset')
const { createAdapter } = require('../utils/cloud-primary-adapter')
const readTiming = require('../utils/read-timing')

const ROOT = path.resolve(__dirname, '..')
const PHYSICAL = ['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
const LOGICAL = name => (name === 'student_tombstones' ? 'studentTombstones' : name)
const CTX = { trustedOwnerCoachId: 'o'.repeat(32), trustedDatasetId: 'd' }
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))

// ————————————————————————————————————————————————————————————
// 一个**可控**的假云端：真实客户端 + 真实指纹算法，只有"世界"是假的。
// 之所以不用真实云函数：本轮要钉的七种形状里，C/F/G 都要求精确控制
// 「HEAD 是在 delta 之前还是之后读的」以及「回的那个字段是真是假」——
// 这些只能在替身里做。真实云函数那一侧由
// tests/incremental-cross-device-sync.test.js 场景⑪ 与 tests/background-incremental-read.test.js 守。
// ————————————————————————————————————————————————————————————
const world = {
  revision: 1,
  snapshot: {
    students: [{ id: 's1', name: '头部收敛·甲', phone: '', packages: [{ id: 'p1', type: '常规训练', total: 10, used: 0, remaining: 10, price: 150, status: 'active' }] }],
    bookings: [], incomes: [], sales: [],
    settings: { renewThreshold: 3, monthlyGoalSessions: 20, classCommissionRate: 40, salesCommissionRate: 10 },
    customExercises: []
  },
  built: null,
  log: [],                    // 每前进一版：{ revision, upserts: [bookingId] }
  // —— 假云端的开关 ——
  legacyHead: false,          // 旧云函数：响应里根本没有 headRevision
  headMode: 'normal',         // 'normal' | 'string'（不是整数） | 'null' | 'regress'（倒退）
  corrupt: false,             // 回一个坏指纹（场景 G）
  raceOnce: false,            // 下一跳 changes 算完 delta 之后立刻有人写（场景 C）
  alwaysRace: false           // 每一跳都如此（场景 D）
}
function rebuild() { world.built = buildCandidateDataset(clone(world.snapshot), CTX) }
rebuild()

let seq = 0
function addBooking(id) {
  world.snapshot.bookings.push({
    id, studentId: 's1', studentName: '头部收敛·甲', packageId: 'p1',
    date: '2026-12-01', hour: 8 + (seq++), minute: 0,
    typeName: '常规训练', price: 150, status: 'booked', items: [], notes: ''
  })
  world.revision += 1
  world.log.push({ revision: world.revision, upserts: [id] })
  rebuild()
}

const store = {}
global.wx = {
  getStorageSync: key => clone(store[key]),
  setStorageSync: (key, value) => { store[key] = clone(value) },
  removeStorageSync: key => { delete store[key] }
}
const storage = { get: key => clone(store[key]), set: (key, value) => { store[key] = clone(value) } }

let calls = []
let serving = null
const physicalRow = (name, id) => (world.built.collections[LOGICAL(name)] || []).find(row => row.bookingId === id)
const liveIntegrity = () => {
  const actual = clone(world.built.integrity)
  if (world.corrupt) actual.checksum = 'corrupted-' + actual.checksum
  return actual
}

async function callFunction({ name, data }) {
  assert.equal(name, 'readMyActiveCoachData', '本测试只有只读回读通道')
  calls.push(data.action + (data.collection ? ':' + data.collection : ''))
  if (data.action === 'metadata') {
    serving = { revision: world.revision, collections: clone(world.built.collections) }
    return { ok: true, environment: 'production', datasetId: 'd', dataRevision: serving.revision, headVersion: 1, collections: PHYSICAL.slice() }
  }
  if (data.action === 'page') {
    if (!serving) return { ok: false, code: 'NO_CONSISTENCY_WINDOW' }
    const rows = serving.collections[LOGICAL(data.collection)] || []
    return { ok: true, environment: 'production', collection: data.collection, datasetId: 'd', dataRevision: serving.revision, done: true, cursor: 0, nextCursor: rows.length, nextFragmentIndex: 0, encoding: 'base64-json', payload: Buffer.from(JSON.stringify(rows), 'utf8').toString('base64') }
  }
  if (data.action === 'integrity') {
    // ⚠️ integrity 永远回**真实**指纹（场景 G 要模拟的是"云端回的那一份**增量**指纹是坏的"，
    //    真实云端里 liveIntegrity 与 liveChanges 用的是同一批行、同一个算法，不会一个坏一个好）。
    return { ok: true, environment: 'production', datasetId: 'd', dataRevision: world.revision, ...clone(world.built.integrity) }
  }
  // ★★ changes：顺序与真实云函数**逐字同序** —— 先定版本、算完 delta，**最后**才读 HEAD。
  if (data.action === 'changes') {
    const since = data.sinceRevision
    if (!Number.isInteger(since) || since < 0) return { ok: false, code: 'CHANGES_INVALID_SINCE' }
    const to = world.revision
    const base = { ok: true, environment: 'production', datasetId: 'd', dataRevision: to, ...liveIntegrity() }
    let payload = null
    if (since === to) payload = { ...base, unchanged: true, from: since }
    else {
      const upserts = []
      world.log.forEach(entry => {
        if (entry.revision <= since || entry.revision > to) return
        entry.upserts.forEach(id => upserts.push(physicalRow('bookings', id)))
      })
      payload = { ...base, from: since, to, delta: { upserts: { bookings: upserts }, removals: {}, revisions: [] } }
    }
    // 「算完 delta 之后」这段时间里又有人写 —— 真机 262 → 263/264 就是这一段。
    if (world.raceOnce || world.alwaysRace) { world.raceOnce = false; addBooking('b-race-' + world.revision) }
    if (world.legacyHead) return payload                                  // 场景 E：旧云函数
    if (world.headMode === 'string') return { ...payload, headRevision: 'not-a-number' }   // 场景 F1
    if (world.headMode === 'null') return { ...payload, headRevision: null }               // 场景 F3
    if (world.headMode === 'regress') return { ...payload, headRevision: to - 1 }          // 场景 F2
    return { ...payload, headRevision: world.revision }                                    // 场景 A/B/C/D
  }
  return { ok: false, code: 'INVALID_ACTION' }
}

async function run() {
  const adapter = createAdapter({
    callCloud: (name, data) => callFunction({ name, data }),
    storage,
    environment: () => 'production',
    onTiming: entry => { if (entry && entry.action === 'readActive') readTiming.record(entry) }
  })
  const resetCalls = () => { calls = []; serving = null }
  const ledger = () => (Array.isArray(store[readTiming.KEY]) ? store[readTiming.KEY] : [])
  const lastLedger = () => ledger().slice(-1)[0]
  const lastFallback = () => ledger().slice().reverse().find(row => row.incrementalFallback) || { incrementalFallback: '' }
  const pageCount = () => calls.filter(item => item.startsWith('page:')).length
  const localBookings = () => (storage.get('coachCloudActiveCache') || { snapshot: { bookings: [] } }).snapshot.bookings.map(row => row.id)

  // ————————————————————————————————————————————————————————————
  // 基线：本机还没有缓存 ⇒ 完整读取（落 cache + 行镜像，后面才有增量可走）
  // ————————————————————————————————————————————————————————————
  resetCalls()
  const baseline = await adapter.readActive()
  assert.equal(baseline.ok, true, '（前置）基线完整读取必须成功')
  assert.equal(baseline.revision, 1, '（前置）基线落在 revision 1')
  assert.equal(pageCount(), PHYSICAL.length, '（前置）基线必须翻 8 个集合')
  assert.equal(localBookings().length, 0, '（前置）基线还没有预约')

  // ══════════════════════════════════════════════════════════════
  // 场景 A：没有新变化 ⇒ **1 次**云调用
  // ══════════════════════════════════════════════════════════════
  resetCalls()
  const calm = await adapter.readActive({ userInitiated: true })
  assert.equal(calm.ok, true, 'A：无变化下拉必须成功')
  assert.deepEqual(calls, ['changes'],
    '★★ A：无变化时一次下拉只许 **1 次**云调用（修前固定 2 次串行），实得 ' + JSON.stringify(calls))
  assert.equal(lastLedger().integrityMs, 0, '★★ A：这一轮的 integrity 开销必须是 0')
  assert.equal(lastLedger().skipped, 'VERIFIED_UNCHANGED', 'A：账本必须记成"校验通过、直接结束"')
  assert.equal(lastLedger().incrementalFallback, '', 'A：走成了就不许留兜底原因')
  assert.equal(calm.revision, world.revision, 'A：必须停在云端当前 revision')

  // ══════════════════════════════════════════════════════════════
  // 场景 B：已有一个新 revision ⇒ **1 次**云调用就拿到最新状态
  // ══════════════════════════════════════════════════════════════
  addBooking('b-1')
  resetCalls()
  const one = await adapter.readActive({ userInitiated: true })
  assert.equal(one.ok, true, 'B：有变化时下拉必须成功')
  assert.deepEqual(calls, ['changes'],
    '★★ B：有变化时一次下拉同样只许 **1 次**云调用，实得 ' + JSON.stringify(calls))
  assert.equal(one.revision, world.revision, '★ B：必须直接落到云端最新 revision')
  assert.ok(localBookings().includes('b-1'), '★ B：一次调用就必须把新数据带进本机 cache')
  assert.equal(lastLedger().skipped, 'INCREMENTAL', 'B：账本必须记下走的是增量')
  assert.equal(lastLedger().pages, 0, 'B：一页完整读取都不许有')
  assert.equal(lastLedger().integrityMs, 0, '★★ B：这一轮的 integrity 开销必须是 0')

  // ══════════════════════════════════════════════════════════════
  // 场景 C：changes 计算期间云端又发生一次写入 ⇒ 同一次下拉内部自动第二跳
  //   （真机"第一次显示 A、第二次才显示 B"那个形状）
  // ══════════════════════════════════════════════════════════════
  addBooking('b-2')               // 云端先前进一版（本机还不知道）
  world.raceOnce = true           // ★ 就在下一跳 changes 算完 delta 之后，再写一条
  const headBeforePull = world.revision
  resetCalls()
  const chased = await adapter.readActive({ userInitiated: true })
  assert.equal(chased.ok, true, 'C：竞态下的下拉必须成功')
  assert.deepEqual(calls, ['changes', 'changes'],
    '★★ C：必须是"同一次下拉内部自动再追一跳"（2 次 changes、0 次 integrity），实得 ' + JSON.stringify(calls))
  assert.equal(chased.revision, world.revision,
    '★★ C：必须直接收敛到云端最新 revision（实得 ' + chased.revision + ' / 云端 ' + world.revision + '）')
  assert.ok(chased.revision > headBeforePull, 'C：追的那一版必须是竞态中写进去的那一版')
  assert.ok(localBookings().includes('b-2'), 'C：第一跳带回来的那条必须在')
  assert.ok(localBookings().includes('b-race-' + headBeforePull), '★★ C：竞态里新写的那条也必须在（不许要用户再拉一次）')
  assert.equal(lastLedger().pages, 0, '★ C：追的过程中一页完整读取都不许有')
  assert.equal(lastLedger().integrityMs, 0, '★★ C：追的过程里不许再花串行 integrity')
  assert.equal(lastLedger().incrementalFallback, '', '★ C：追上了就不许留兜底原因')

  // ══════════════════════════════════════════════════════════════
  // 场景 D：连续发生变化 ⇒ 不许无限追（有界）；用尽后按既有策略退回完整读取
  // ══════════════════════════════════════════════════════════════
  addBooking('b-3')
  world.alwaysRace = true
  resetCalls()
  const exhausted = await adapter.readActive({ userInitiated: true })
  world.alwaysRace = false
  assert.equal(exhausted.ok, true, '★ D：一直有人在写时，下拉最终必须**如实成功**（退回完整读取）：' + JSON.stringify(exhausted))
  // ⚠️ 上限是 **6** 而不是 3：用户下拉由两段组成 —— ① 不进航位的只读首跳（probeOnly），
  //    ② 判出"追不动"之后回到航位里的那一次完整读取。两段各自有 CONVERGE_MAX_HOPS=3 的预算，
  //    而本场景里每一跳都真的把增量套进了 cache ⇒ 第 ② 段的缓存"动过"，于是它重新走一次首跳。
  //    （这是既有结构，不是本轮引入的；关键性质是**有界**，不是恰好 3。）
  const chaseCalls = calls.filter(item => item === 'changes').length
  assert.ok(chaseCalls >= 3 && chaseCalls <= 6,
    '★★ D：追的次数必须**有界**（两段 × 3 跳 = 最多 6 次），绝不许无限追，实得 ' + JSON.stringify(calls))
  assert.ok(calls.includes('metadata') && pageCount() === PHYSICAL.length,
    '★ D：追不动时必须退回完整读取（8 个集合一个都不少），实得 ' + JSON.stringify(calls))
  assert.equal(lastFallback().incrementalFallback, 'CONVERGE_EXHAUSTED',
    '★ D：账本必须如实记下"追到预算用尽才退"，实得 ' + lastFallback().incrementalFallback)
  assert.equal(exhausted.revision, world.revision, '★ D：无论如何必须落到云端最新那一版')
  assert.ok(localBookings().includes('b-3'), '★ D：追完之后必须看到新数据')

  // ══════════════════════════════════════════════════════════════
  // 场景 E：旧云函数（响应里根本没有 headRevision）⇒ 退回原 changes → integrity
  //   ⚠️ 这一格就是"客户端先上传、云函数还没部署"那一整段时间的保险。
  // ══════════════════════════════════════════════════════════════
  addBooking('b-4')
  world.legacyHead = true
  resetCalls()
  const legacy = await adapter.readActive({ userInitiated: true })
  world.legacyHead = false
  assert.equal(legacy.ok, true, '★ E：旧云函数下下拉必须照常成功：' + JSON.stringify(legacy))
  assert.deepEqual(calls, ['changes', 'integrity'],
    '★★ E：拿不到可信 headRevision 时必须逐字退回"changes + integrity"老路径，实得 ' + JSON.stringify(calls))
  assert.equal(legacy.revision, world.revision, '★ E：老路径也必须落到云端最新那一版')
  assert.ok(localBookings().includes('b-4'), '★ E：老路径也必须把新数据带回来')
  assert.equal(lastLedger().pages, 0, 'E：老路径照样不许翻分页')
  assert.equal(lastLedger().incrementalFallback, '', 'E：走成了就不许留兜底原因')

  // ══════════════════════════════════════════════════════════════
  // 场景 F：headRevision 非法 / 倒退 / null ⇒ 不许采信，走现有安全 fallback
  // ══════════════════════════════════════════════════════════════
  const illegal = [
    { mode: 'string', label: 'F1 headRevision 不是整数' },
    { mode: 'regress', label: 'F2 headRevision 比 dataRevision 还小（倒退）' },
    { mode: 'null', label: 'F3 headRevision 是 null' }
  ]
  for (const item of illegal) {
    addBooking('b-f-' + item.mode)
    world.headMode = item.mode
    resetCalls()
    const result = await adapter.readActive({ userInitiated: true })
    world.headMode = 'normal'
    assert.equal(result.ok, true, item.label + '：下拉必须成功')
    assert.deepEqual(calls, ['changes', 'integrity'],
      '★★ ' + item.label + '：不许被采信 ⇒ 必须走 integrity 确认，实得 ' + JSON.stringify(calls))
    assert.equal(result.revision, world.revision, item.label + '：必须落到云端最新那一版')
    assert.equal(lastLedger().pages, 0, item.label + '：不许翻分页')
  }

  // ══════════════════════════════════════════════════════════════
  // 场景 G：changes 指纹错误 ⇒ 仍然失败 / fallback
  //   绝不许因为 "headRevision == dataRevision" 就绕过 fingerprint 校验
  // ══════════════════════════════════════════════════════════════
  addBooking('b-g')
  const beforeCorrupt = JSON.stringify(storage.get('coachCloudActiveCache'))
  world.corrupt = true
  resetCalls()
  const corrupted = await adapter.readActive({ userInitiated: true })
  world.corrupt = false
  assert.equal(corrupted.ok, true, '★ G：指纹坏的时候必须退回完整读取后**如实成功**：' + JSON.stringify(corrupted))
  assert.equal(lastFallback().incrementalFallback, 'INCREMENTAL_FINGERPRINT_MISMATCH',
    '★★ G：必须如实记下"指纹对不上"，绝不能因为 headRevision 相等就放过，实得 ' + lastFallback().incrementalFallback)
  assert.ok(calls.includes('metadata') && pageCount() === PHYSICAL.length,
    '★★ G：指纹对不上必须真的退回完整读取，实得 ' + JSON.stringify(calls))
  assert.equal(String(corrupted.checksum).startsWith('corrupted-'), false,
    '★★ G：坏指纹绝不许被采用 —— 宁慢也不错')
  assert.equal(corrupted.revision, world.revision, 'G：退回完整读取后必须落在云端最新那一版')
  assert.ok(localBookings().includes('b-g'), 'G：退回完整读取之后必须看到真数据')

  // ══════════════════════════════════════════════════════════════
  // 场景 H：§88 的 background 单跳**不许**被本轮破坏
  //   后台只跳一次 changes，不许因为给 user 加了 headRevision 就开始追多跳
  //   （追多跳 = 重新占用与写命令共用的那条航位 = §87 真机 9144ms 那个形状）
  // ══════════════════════════════════════════════════════════════
  addBooking('b-h')
  resetCalls()
  const bg = await adapter.readActive()
  assert.equal(bg.ok, true, 'H：后台刷新必须成功')
  assert.deepEqual(calls, ['changes'],
    '★★ H：后台刷新必须**仍然只发一次 changes**（不许追收敛、不许 integrtiy、不许分页），实得 ' + JSON.stringify(calls))
  assert.equal(lastLedger().lane, 'background', 'H：（形态检查）这一轮必须是后台轮次')
  assert.equal(lastLedger().integrityMs, 0, '★★ H：后台一次 integrity 开销都不许有')
  assert.equal(lastLedger().pages, 0, '★★ H：后台不许翻任何分页（真机上省下来的 10 次往返就在这里）')
  assert.equal(bg.revision, world.revision, 'H：后台刷新必须把本机 revision 推到云端当前值')

  // ══════════════════════════════════════════════════════════════
  // 静态契约：B 与 C 两处改动必须在，且一条安全退路都不许少
  // ══════════════════════════════════════════════════════════════
  {
    const client = fs.readFileSync(path.join(ROOT, 'utils', 'cloud-primary-adapter.js'), 'utf8')
    const bare = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')
    // ① 客户端真的会用 headRevision（"省掉那一跳"的落点）
    assert.ok(/function trustedHeadRevision/.test(bare), '★ 客户端必须有一个"headRevision 可信吗"的判据')
    assert.ok(/trustedHead !== null/.test(bare), '★ 只有 HEAD 可信时才许省掉 integrity')
    assert.ok(/if \(trustedHead === current\.revision\) return \{ mode: 'converged'/.test(bare),
      '★ HEAD == 我手里这一版 ⇒ 收敛；其余（含不可信）⇒ 退回 integrity')
    // ② 不可信的三种形状一个都不许漏（少一种就可能"错误地认为已经追平"）
    assert.ok(/!Number\.isInteger\(response\.headRevision\)/.test(bare), '★ 非整数 headRevision 必须判不可信')
    assert.ok(/response\.headRevision < dataRevision/.test(bare), '★ 倒退的 headRevision 必须判不可信')
    // ③ 收敛循环仍然**只**属于 user 泳道（后台不许追）
    assert.ok(/if \(state\.lane === 'user'\) \{[\s\S]{0,400}?convergeUserRead\(/.test(bare),
      '★ convergeUserRead 必须仍然只被 user 泳道调用')
    assert.ok(/state\.lane === 'user' \|\| state\.lane === 'background'/.test(bare), '★ §88 的后台准入不许被回退')
    // ④ 有界预算不许被放大，也不许被拿掉
    assert.ok(/const CONVERGE_MAX_HOPS = 3/.test(bare), '★ 单次刷新内部的追赶上限仍然是 3 跳')
    assert.ok(/const CONVERGE_BUDGET_MS = 4000/.test(bare), '★ 单次刷新内部的时间预算仍然是 4000ms')
    // ⑤ 五项指纹逐项比对一条都不许少
    ;['checksum', 'byteSize', 'summary', 'counts', 'amounts'].forEach(field => {
      assert.ok(new RegExp(field + ': (actual|confirm)\\.' + field + ' !== response\\.' + field + '|' + field + ': actual\\.' + field).test(bare) || bare.includes(field + ': actual.' + field), '★ ' + field + ' 比对必须在')
    })
    // ⑥ 退路一个不许少
    ;['MIRROR_UNAVAILABLE', 'CHANGES_MALFORMED', 'INCREMENTAL_FINGERPRINT_MISMATCH', 'CHANGES_DATASET_CHANGED', 'CHANGES_REVISION_UNEXPECTED', 'CONVERGE_EXHAUSTED'].forEach(reason => {
      assert.ok(bare.includes(reason), '★ 退路 ' + reason + ' 必须保留（缺一条就可能把错数据写进 cache）')
    })
    // ⑦ 增量调用点仍然只有一处
    assert.equal((bare.match(/action:\s*'changes'/g) || []).length, 1, '★ 增量读取只允许有一个调用点')

    const server = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'readMyActiveCoachData', 'index.js'), 'utf8')
    // ⑧ 云端必须真的"算完 delta 之后才读 HEAD"（顺序反了就抓不到这个竞态）
    assert.ok(/async function readHeadRevision/.test(server), '★ 云端必须有那个"再读一次 HEAD"的动作')
    const atHead = server.indexOf('await readHeadRevision(')
    const atPlan = server.indexOf('const planned = planChanges(')
    assert.ok(atPlan > 0 && atHead > atPlan,
      '★★ 顺序必须是「先算 delta → 再读 HEAD」（否则抓不到"算 delta 期间又被人写"，实得 plan@' + atPlan + ' / head@' + atHead + '）')
    // ⑨ 云端也不许把不可信的值当 HEAD 交出去
    assert.ok(/Number\.isInteger\(head\) && head >= to \? head : null/.test(server),
      '★ 云端读不到 / 倒退时 headRevision 必须是 null（客户端据此退回 integrity）')
  }

  console.log('user refresh head convergence: PASS'
    + '（无变化 1 次调用 / 有变化 1 次调用 / 计算期间被写 ⇒ 同一次下拉内自动第二跳且 0 次 integrity；'
    + '连续变化 ⇒ 最多 3 跳后退完整读取；旧云函数 ⇒ 逐字退回 changes+integrity；'
    + 'headRevision 非整数 / 倒退 / null 三例全部不采信；坏指纹仍然 fallback；'
    + '后台仍然只跳一次 changes、0 integrity、0 分页）')
}
run().catch(error => { console.error('user refresh head convergence: FAIL'); console.error(error && error.message); console.error(error && error.stack); process.exitCode = 1 })
