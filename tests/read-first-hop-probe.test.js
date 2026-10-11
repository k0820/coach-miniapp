// 「廉价校验式首跳」（1.1.9 第 2 轮）。
//
// 真机现象：新版 readMyActiveCoachData（PAGE_LIMIT 20→100，往返 33→12）已经部署，
// 手机下拉刷新**仍然要 10 秒以上** —— 离线按分页次数推算出的「1.5–2.5 秒」没在真机上出现。
// 结论：往返次数只是**乘数**，不是问题本身。真实形状是
//   · 课表 onShow 先起一次后台全量回读（十几跳；固定成本 metadata 约 0.7s + integrity 约 1.7s）；
//   · 用户下拉时为了**不复用「用户开口之前就在飞」的快照**（1.1.9 的既定要求），只能再起一次
//     ⇒ 两整次串联。
// 所以修法不是继续调分页参数，而是**先花一跳把「还要不要读」问清楚**。
//
// ★ 为什么那一跳是 `integrity` 而不是"只问 revision"：
//   只问 revision 然后采信本机缓存，等于在**快路径上把 integrity 校验拿掉了** ——
//   而"指纹对不上必须如实失败"是一条既有安全契约，用户本轮也明确要求"不取消 integrity 校验"。
//   所以这一跳**一跳就把校验做完**：云端的 integrity 会现场把八个集合并一遍、算出指纹，
//   连同 dataRevision 一起回来；客户端拿它与本机**已验证缓存**逐项比对（datasetId / revision /
//   checksum / byteSize / summary，五项全等才算"没变"）。
//
// 本测试钉住七件事：
//   ① 五项全等 → 只走轻量首跳（**恰好 1 次云函数调用**，页数 0），分页与第二次 integrity 都不发；
//   ② revision 变了 → **要么增量、要么整份完整读取**（8 个集合分页 + integrity，一个校验都不少）：
//      第 7 轮起，用户下拉那一跳换成了 `{action:'changes'}`（只取这一段变了哪几行）。
//      本假件是**纯只读世界、拿不到任何收据** ⇒ `changes` 如实回 `CHANGES_GAP` ⇒
//      客户端**整份退回**完整读取。所以这一步现在测的是那条**兜底**：增量做不到时不许少读。
//      （增量真正走成的那一路见 tests/incremental-cross-device-sync.test.js。）
//   ③ revision 没变但**指纹对不上** → 必须走完整读取并**如实失败**（校验没有被拿掉）；
//   ④ 用户主动刷新仍然**不会**拿到「用户开口之前」的旧快照，而且必须**自己**跟云端说话；
//   ⑤ 耗时账本必须**落盘**，带 排队等待 / metadata / pages / integrity / total / 调用次数 / 页数 / revision；
//      —— 其中「排队等待」与「调用次数」是第 2 轮新增的关键两列
//      （旧计时起点在航位**内部**，天然看不到排队；旧账本也不记调用次数，只能靠推算）。
//   ⑥ 并发仍是 2、没有引入任何轮询、完整读取路径里的 integrity 校验还在。
//   ⑦ 【1.1.9 第 3 轮】用户下拉那一跳**只读校验首跳不进航位** ——
//      在途后台整读还挂着的时候它就已经发出去并回来了，而"首跳判出不一致"之后的**完整读取**
//      仍然老老实实回到航位排队（两道边界同时钉住，缺任何一半都不算修对）。
//
// 判别力：把廉价首跳整段删掉 → 第 1 步立刻变红（会发 10 次调用）；把五项比对削成"只比 revision"
// → 第 2b 步立刻变红（指纹对不上会被放过去）；把用户首跳改回"进航位再发" → 第 4 步立刻变红。
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
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const store = {}
global.wx = {
  getStorageSync: key => clone(store[key]),
  setStorageSync: (key, value) => { store[key] = clone(value) },
  removeStorageSync: key => { delete store[key] }
}

const world = {
  revision: 1,
  corruptFingerprint: false,
  snapshot: {
    students: [{ id: 's1', name: '假学员', phone: '', packages: [{ id: 'p1', type: '常规训练', total: 10, used: 0, remaining: 10, price: 150, status: 'active' }] }],
    bookings: [], incomes: [], sales: [],
    settings: { renewThreshold: 3, monthlyGoalSessions: 20, classCommissionRate: 40, salesCommissionRate: 10 },
    customExercises: []
  },
  built: null
}
function rebuild() { world.built = buildCandidateDataset(clone(world.snapshot), CTX) }
rebuild()

// 一次**完整读取**拿到 metadata 之后，后面每一步看到的都是**那一刻的一致快照**（真实云端就是这样）。
// ⚠️ integrity 例外：它永远回**现场**算出来的那一份（真实 liveIntegrity 就是现读现算），
//    这样"世界在读的过程中动了"才会被如实暴露出来。
let serving = null
function capture() { serving = { revision: world.revision, collections: clone(world.built.collections) } }

let calls = []
// ★ 「在途回读」闸门。⚠️ 1.1.9 第 2 轮改首跳后，一次回读的**第一跳**有两种可能：
//   · 本机有已验缓存 → 第一跳是 `integrity`（廉价校验首跳）
//   · 本机没有缓存   → 第一跳是 `metadata`（完整读取）
//   真机上两者都会占住那条串行航位，所以闸门必须挂在**任意一次只读调用**上，
//   而不是只挂在 metadata 上 —— 否则"首跳被挂起"这件事在假件里根本不会发生，
//   排队等待那一列就会恒为 0，而真机上它恰恰是最可疑的一段。
let readGate = null
// ⚠️ adapter 的 callCloud 拿到的**已经是云函数的 result**（生产里是 wx.cloud.callFunction
// 的 `.then(response => response.result)`），所以这里直接返回 result，不要再包一层 {result}。
async function callFunction({ name, data }) {
  assert.equal(name, 'readMyActiveCoachData', '只有只读回读通道，不存在任何写命令')
  calls.push(data.action + (data.collection ? ':' + data.collection : ''))
  if (data.action === 'metadata') {
    capture()
    if (readGate) { const gate = readGate; readGate = null; await gate }
    return { ok: true, environment: 'production', datasetId: 'd', dataRevision: serving.revision, headVersion: 1, collections: PHYSICAL.slice() }
  }
  if (data.action === 'page') {
    if (!serving) return { ok: false, code: 'NO_CONSISTENCY_WINDOW' }
    const rows = serving.collections[LOGICAL(data.collection)] || []
    return { ok: true, environment: 'production', collection: data.collection, datasetId: 'd', dataRevision: serving.revision, done: true, cursor: 0, nextCursor: rows.length, nextFragmentIndex: 0, encoding: 'base64-json', payload: Buffer.from(JSON.stringify(rows), 'utf8').toString('base64') }
  }
  if (data.action === 'integrity') {
    // 首跳也会走这一支 ⇒ 闸门同样在这里生效（先等，再算现场指纹）。
    if (readGate) { const gate = readGate; readGate = null; await gate }
    // 现场指纹：云端把数据现读一遍再算 —— 所以它回的是**当下**的 revision 与指纹。
    const actual = clone(world.built.integrity)
    if (world.corruptFingerprint) actual.checksum = 'corrupted-' + actual.checksum
    return { ok: true, environment: 'production', datasetId: 'd', dataRevision: world.revision, ...actual }
  }
  // ★ 1.1.9 第 7 轮：用户下拉的第一跳改成了 `changes`（只取这一段变了哪几行）。
  //   本假件是一个**纯只读世界**（file 头就写着"只有只读回读通道，不存在任何写命令"），
  //   所以这里永远拿不到收据 ⇒ 除了"没变化"之外一律如实回 `CHANGES_GAP`。
  //   这恰好把本轮最关键的一条契约钉在这一步上：**增量做不到，就必须整份退回完整读取**，
  //   而不是"拿不准就少读一点"。真正的增量成功路径在
  //   tests/incremental-cross-device-sync.test.js 里跑真实云函数验证。
  if (data.action === 'changes') {
    if (!Number.isInteger(data.sinceRevision) || data.sinceRevision < 0) return { ok: false, code: 'CHANGES_INVALID_SINCE' }
    const actual = clone(world.built.integrity)
    if (world.corruptFingerprint) actual.checksum = 'corrupted-' + actual.checksum
    if (data.sinceRevision === world.revision) {
      return { ok: true, environment: 'production', datasetId: 'd', dataRevision: world.revision, unchanged: true, from: data.sinceRevision, ...actual }
    }
    return { ok: false, code: 'CHANGES_GAP', from: data.sinceRevision, to: world.revision, missing: [data.sinceRevision + 1] }
  }
  return { ok: false, code: 'INVALID_ACTION' }
}

const storage = { get: key => clone(store[key]), set: (key, value) => { store[key] = clone(value) } }
const resetCalls = () => { calls = []; serving = null }
const ledger = () => (Array.isArray(store[readTiming.KEY]) ? store[readTiming.KEY] : [])

async function run() {
  // 生产接线：adapter 的分段时间交给账本落盘（与 utils/ui-cloud-command.js 逐字同口径）。
  const adapter = createAdapter({
    callCloud: (name, data) => callFunction({ name, data }),
    storage,
    environment: () => 'production',
    onTiming: entry => { if (entry && entry.action === 'readActive') readTiming.record(entry) }
  })

  // ——————— 第 0 步：基线（本机还没有缓存 ⇒ 不做首跳，直接完整读取）———————
  resetCalls()
  const baseline = await adapter.readActive()
  assert.equal(baseline.ok, true, '基线回读必须成功')
  assert.deepEqual(calls.slice(0, 1), ['metadata'], '没有缓存时不做首跳，直接从 metadata 起一次完整读取')
  assert.equal(calls.filter(c => c.startsWith('page:')).length, PHYSICAL.length, '基线必须是完整读取（八个集合各分页一次）')
  assert.equal(calls.filter(c => c === 'integrity').length, 1, '基线必须做 integrity 校验')
  assert.equal(store.coachCloudActiveCache.revision, 1, '基线缓存必须落到 revision 1')

  // ——————— 第 1 步（核心）：五项全等 → 只走轻量首跳 ———————
  resetCalls()
  const skipped = await adapter.readActive()
  // ⚠️ 1.1.9 第 15 轮：后台轮次也开放了 `changes` ⇒ 这一跳从 integrity 变成了 changes。
  //   判据的**含义不变**：没变化时只允许发**一次**轻量调用，分页与第二次 integrity 一次都不许发
  //   （旧行为是 10 次调用）。所以这里钉的是"恰好一次、且必须是轻量的"，不再钉死具体动作名。
  assert.equal(calls.length, 1,
    '★ 没变化时只允许发**一次**调用：分页与第二次 integrity 一次都不许发。'
    + '旧行为是 10 次调用。实得 ' + JSON.stringify(calls))
  assert.ok(calls[0] === 'integrity' || calls[0] === 'changes',
    '★ 那一跳必须是轻量的（integrity 或 changes），绝不许是 metadata / 分页，实得 ' + JSON.stringify(calls))
  assert.equal(skipped.ok, true, '轻量首跳必须成功返回')
  assert.equal(skipped.unchanged, true, '必须明确标记这是"校验通过、直接结束"的那一路')
  assert.equal(skipped.revision, 1, '返回的就是本机已验证快照的那个 revision')
  assert.deepEqual(skipped.snapshot, baseline.snapshot, '返回的就是本机那份已验快照（逐字相同）')
  const skipRow = ledger().slice(-1)[0]
  assert.equal(skipRow.pages, 0, '轻量首跳的页数必须是 0')
  assert.equal(skipRow.calls, 1, '账本必须记下"这一跳只发了 1 次调用"')
  assert.equal(skipRow.skipped, 'VERIFIED_UNCHANGED', '账本必须记下跳过原因')
  assert.equal(skipRow.revision, 1, '账本必须记下 revision')

  // 用户主动下拉：没变化时同样只走首跳 —— 1.1.9 第 7 轮起这一跳是 `changes`
  // （它既回答问题，也带回同一套五项指纹，所以"没变化"的判据一个字都没放松）。
  resetCalls()
  const skipUser = await adapter.readActive({ userInitiated: true })
  assert.equal(skipUser.ok, true, '用户轮次也要成功')
  // ⚠️ 1.1.9 第 12 轮起：用户下拉在「没变化」时也不止一次调用 —— `changes` 判完"没变"之后，
  //     收敛循环还会用一次**纯只读、零分页**的 `integrity` 问"云端此刻最新是不是这一版"。
  //     为什么必须有这第二跳：一跳 `changes` 只保证"应用到了云端它自己读到的那一版"，
  //     云端**读完到我们把结果拿到手**这一段没人证明（真机 17:36 就卡在这里）。
  //     所以口径从「恰好一次」改成「只有轻量调用、一次完整读取都不许有」。
  assert.deepEqual(calls, ['changes', 'integrity'],
    '用户主动刷新在没变化时只发轻量调用（changes + 一次零分页 integrity 确认），实得 ' + JSON.stringify(calls))
  assert.equal(calls.filter(c => c === 'metadata' || c.startsWith('page:')).length, 0,
    '★ 没变化时一次完整读取都不许发（metadata / 分页都不许出现），实得 ' + JSON.stringify(calls))
  assert.equal(ledger().slice(-1)[0].skipped, 'VERIFIED_UNCHANGED', '没变化时账本必须如实记成"校验通过、直接结束"')
  assert.equal(ledger().slice(-1)[0].incrementalFallback, '', '走成了就不许留兜底原因')

  // ——————— 第 2 步：revision 变了 → 必须完整读取 ———————
  world.snapshot.bookings.push({ id: 'b-1', studentId: 's1', studentName: '假学员', packageId: 'p1', date: '2026-09-25', hour: 14, minute: 0, typeName: '常规训练', price: 150, status: 'booked', items: [], notes: '' })
  world.revision = 2
  rebuild()
  resetCalls()
  const changed = await adapter.readActive({ userInitiated: true })
  assert.equal(changed.ok, true, 'revision 变化后必须成功读到新数据')
  assert.equal(changed.revision, 2, '必须落到新 revision')
  assert.ok(changed.unchanged !== true, 'revision 变了就绝不能走"没变"那一路')
  assert.equal(calls[0], 'changes', '用户下拉的第一跳必须是增量读取（不是整份搬）')
  assert.equal(calls.filter(c => c === 'integrity').length, 1,
    '增量做不到 ⇒ 整份退回完整读取：只留完整读取末尾那一次 integrity（已经知道增量的依据不成立，不再多花一次首跳）')
  assert.equal(calls.filter(c => c.startsWith('page:')).length, PHYSICAL.length, '★ 增量做不到必须完整分页（一个集合都不许跳过）')
  assert.ok(store.coachCloudActiveCache.snapshot.bookings.some(item => item.id === 'b-1'), '新数据必须进缓存')
  const changeRow = ledger().slice(-1)[0]
  assert.ok(changeRow.pages >= PHYSICAL.length, '账本必须记下真实页数（据此可判断体验版有没有走新云函数），实得 ' + changeRow.pages)
  assert.ok(changeRow.pageCounts.includes('bookings:'), '账本必须带每集合页数，实得 ' + changeRow.pageCounts)
  // ★ 第 7 轮新增的判别力：账本必须**指明为什么没走成增量**（本假件没有收据 ⇒ CHANGES_GAP）。
  //   有了这一列，"真机这次到底是走成了增量、还是退回整读、还是因为别的原因"不必再靠猜。
  //   ⚠️ 取的是**那一跳**（outcome=PROBE_REQUIRES_FULL_READ），不是最后一条 ——
  //      后面还有完整读取自己那一行，它的兜底原因当然应该是空的。
  const userRows = ledger().filter(row => row.lane === 'user')
  const probeRow2 = userRows.find(row => row.outcome === 'PROBE_REQUIRES_FULL_READ')
  assert.equal(probeRow2.incrementalFallback, 'CHANGES_GAP',
    '增量拿不到变更集时必须如实记下原因（不许悄悄退回整读、也不许把"查不到"当成"没有变化"），实得 ' + probeRow2.incrementalFallback)
  assert.equal(probeRow2.deltaRows, 0, '没走成增量的那一次不许报出变更行数')
  assert.equal(changeRow.incrementalFallback, '', '完整读取自己那一行没有"兜底原因"可言')

  // 再读一次：又回到"校验通过"，说明首跳之后缓存确实是当前的
  resetCalls()
  await adapter.readActive()
  assert.equal(calls.length, 1, '新 revision 落缓存后，下一次又只剩一跳，实得 ' + JSON.stringify(calls))
  assert.ok(calls[0] === 'integrity' || calls[0] === 'changes',
    '★ 那一跳必须是轻量的（后台现在走 changes），实得 ' + JSON.stringify(calls))

  // ——————— 第 2b 步（关键）：revision 没变、但指纹对不上 → 必须如实失败 ———————
  // 只比 revision 的实现会在这里**放过去**（把损坏当成"没变化"），所以这一步是"校验没被拿掉"的判据。
  world.corruptFingerprint = true
  const cacheBeforeCorrupt = JSON.stringify(store.coachCloudActiveCache)
  resetCalls()
  const corrupt = await adapter.readActive({ userInitiated: true })
  world.corruptFingerprint = false
  assert.equal(corrupt.ok, false, '★ 指纹对不上必须如实失败（只比 revision 就会把它放过去）')
  assert.equal(corrupt.code, 'ACTIVE_READ_INTEGRITY_FAILED', '必须以"完整性校验失败"这个码如实失败')
  assert.equal(calls.filter(c => c.startsWith('page:')).length, PHYSICAL.length,
    '首跳校验没通过 ⇒ 必须真的做一次完整读取再去判定，不能盲目采信缓存')
  assert.equal(JSON.stringify(store.coachCloudActiveCache), cacheBeforeCorrupt, '失败时缓存必须逐字保留，绝不能被写坏')

  // ——————— 第 3 步：用户轮次仍不吃「用户开口之前」的旧快照 ———————
  // 世界此刻在 revision 2，本机已验缓存也是 2。让在途回读起飞并被闸门挂住 ——
  // 此刻它手里握着的就是「用户开口之前」的那份快照（本机已验缓存）。
  resetCalls()
  let release
  readGate = new Promise(resolve => { release = resolve })
  const inFlight = adapter.readActive()
  await delay(5)
  // 另一台设备在「用户开口之前」写入 → 世界前进到 3，而那份在途回读**看不到**它。
  world.snapshot.bookings.push({ id: 'b-2', studentId: 's1', studentName: '假学员', packageId: 'p1', date: '2026-09-25', hour: 15, minute: 0, typeName: '常规训练', price: 150, status: 'booked', items: [], notes: '' })
  world.revision = 3
  rebuild()
  // 用户在此时下拉刷新 = 一句「现在给我最新数据」的明确指令。
  const pulled = adapter.readActive({ userInitiated: true })
  assert.notStrictEqual(pulled, inFlight, '用户轮次必须是**新的**一次读取，不能是用户开口之前就起飞的那一份')
  release()
  await inFlight
  const callsWhenInFlightDone = calls.length
  const user = await pulled
  assert.ok(calls.length > callsWhenInFlightDone, '★ 用户轮次必须**自己**跟云端说话（不是把前面那一份结果捡回来）')
  assert.equal(user.ok, true, '用户轮次必须成功')
  assert.equal(user.revision, 3, '★ 用户轮次必须读到**当前** revision（旧在途快照停在 2）')
  assert.ok(store.coachCloudActiveCache.snapshot.bookings.some(item => item.id === 'b-2'),
    '用户下拉后必须看到另一台设备刚写入的那条 —— 复用了旧在途快照就会看不到')

  // ——————— 第 4 步（1.1.9 第 3 轮核心）：用户下拉的首跳**不排队**，但不一致后的完整读取照旧排队 ———————
  //
  // 真机账本（2026-09-23）定案：用户那一轮 queueMs=8021ms、totalMs=1022ms、pages=0 ——
  // 「8 秒在排队干等、1 秒才是读」，而排在它前面的正是 onShow 起的那一轮**后台整读**
  // （seq 35：排队 1498 + metadata 2120 + pages 4881 + integrity 921）。后台整读读的东西
  // 与这次只读校验毫无关系，却把它整个挡住 —— 这一步就是那条修的判据。
  //
  // 判别力：把 userRefreshRead 里的首跳改回"进航位再发"（即回到 `serialize(...readActiveNow)`），
  //   `userSettled` 会一直是 false ⇒ 下面第一行立刻变红。
  resetCalls()
  // 世界前进到 4 ⇒ 用户那一跳首跳必然判出"不一致"，从而落回航位走完整读取。
  world.snapshot.bookings.push({ id: 'b-3', studentId: 's1', studentName: '假学员', packageId: 'p1', date: '2026-09-25', hour: 16, minute: 0, typeName: '常规训练', price: 150, status: 'booked', items: [], notes: '' })
  world.revision = 4
  rebuild()
  readGate = new Promise(resolve => { release = resolve })
  const holder = adapter.readActive()          // 后台轮次：先进航位，第一跳（只读校验）被闸门挂住
  await delay(5)
  const heldStart = ledger().length
  let userSettled = false
  const waiter = adapter.readActive({ userInitiated: true })
  waiter.then(() => { userSettled = true }, () => { userSettled = true })
  await delay(30)
  const heldRows = ledger().slice(heldStart).filter(row => row.lane === 'user')
  const probeRow = heldRows.find(row => row.outcome === 'PROBE_REQUIRES_FULL_READ')
  assert.ok(probeRow,
    '★ 用户下拉的只读首跳必须在在途后台整读**还挂着**的时候就已经发出去并留痕，实得 ' + JSON.stringify(heldRows))
  assert.ok(probeRow.queueMs < 20,
    '★ 首跳本身不排队：queueMs 必须接近 0（它不进航位），实得 ' + probeRow.queueMs)
  assert.equal(userSettled, false,
    '首跳判出"不一致"之后，这一轮必须回到航位排队等（在途整读未放行前不许结束）—— 它不排队就说明没等校验')
  release()
  await holder
  const pulled4 = await waiter
  assert.equal(pulled4.ok, true, '放行后台整读后，用户轮次必须拿到已验证的一致结果')
  assert.equal(pulled4.revision, 4, '用户轮次必须落到最新 revision')
  assert.ok(store.coachCloudActiveCache.snapshot.bookings.some(item => item.id === 'b-3'), '用户轮次必须真的看到世界新写入的那条')
  // ⚠️ totalMs 与 queueMs 是**故意分开**的两列，不许互相包含：
  //    totalMs 只算「真正开始读之后」那一段，queueMs 只算「排队干等」。真机上两者要分开看 ——
  //    10 秒到底花在"等前面那条读/写"还是"读本身慢"，是两条完全不同的修法。
  //    （旧实现的计时起点在航位**内部**，所以旧数据里 queueMs 根本不存在、totalMs 也看不见等待。）
  const laneRows = ledger().slice(heldStart).filter(row => row.lane === 'user')
  const queued = laneRows.filter(row => row.queueMs >= 20).slice(-1)[0]
  assert.ok(queued, '★ 进航位那一条必须如实记下排队等待（>=20ms），实得 ' + JSON.stringify(laneRows.map(r => r.queueMs)))
  assert.ok(Number.isFinite(queued.totalMs) && queued.totalMs >= 0, '同一跳必须同时给出 totalMs（读本身耗时）')

  // ——————— 第 5 步：账本形状契约 ———————
  const rows = ledger()
  assert.ok(rows.length > 0, '账本不能是空的')
  assert.ok(rows.length <= readTiming.LIMIT, '账本必须是有界的（不能无限增长）')
  assert.deepEqual(Object.keys(rows[rows.length - 1]).sort(), readTiming.FIELDS.slice().sort(),
    '★ 账本必须是**定长**的：每条记录的字段集合完全一样，缺的写 null/0，才能按列读')
  ;['queueMs', 'metadataMs', 'pagesMs', 'integrityMs', 'totalMs', 'calls', 'pages', 'revision'].forEach(field => assert.ok(readTiming.FIELDS.includes(field), '账本必须覆盖真机取证需要的列：' + field))
  const sample = rows.find(row => row.pages > 0)
  assert.ok(sample && sample.metadataMs >= 0 && sample.integrityMs >= 0 && sample.pagesMs >= 0 && sample.cacheMs >= 0,
    '完整读取那几条必须把 metadata / pages / integrity / cache 四段都记下来')
  assert.ok(rows.every(row => row.queueMs >= 0 && row.totalMs >= 0), '时间列不许出现负数')

  // ——————— 第 6 步：静态契约 ———————
  const client = fs.readFileSync(path.join(ROOT, 'utils/cloud-primary-adapter.js'), 'utf8')
  const bare = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')
  assert.ok(/mapLimit\(meta\.collections,\s*2,/.test(bare), '客户端集合并发必须仍然是 2（这一轮同样不动并发数）')
  assert.ok(/VERIFIED_UNCHANGED/.test(bare), '廉价首跳必须以"现场指纹与已验缓存逐项全等"为判据')
  assert.ok(/async function userRefreshRead/.test(bare), '用户下拉的首跳必须走独立入口（那条不进航位的只读校验）')
  assert.ok(/probeOnly:true/.test(bare), '首跳必须标记 probeOnly：不一致就把球交回航位里的完整读取，绝不在航位外翻分页')
  assert.ok(/skipProbe:true/.test(bare), '首跳刚判过不一致且缓存没动过 ⇒ 进航位后直接起完整读取（省掉一次重复校验）')
  assert.ok(/return serialize\(requestedEnvironment,\(\)=>\{/.test(bare), '完整读取（含首跳判不一致后的那一次）必须仍然在航位里跑')
  assert.ok(/options\s*&&\s*options\.userInitiated\s*===\s*true/.test(bare), '那条豁免只给"用户主动下拉"这一条路')
  assert.ok(!/setInterval/.test(bare), '不允许引入任何轮询 / 定时重读')
  assert.ok(/callRead\(\{\s*action:\s*'integrity'\s*\}\)/.test(bare), '完整读取路径里 integrity 校验必须还在')
  // ★ 第 7 轮的静态契约：增量读取必须**真的存在、只给用户下拉**，而且必须过同一套五项指纹。
  assert.ok(/action:\s*'changes'/.test(bare), '客户端必须真的去打增量读取（不是本机猜"哪条变了"）')
  assert.ok(/INCREMENTAL_FINGERPRINT_MISMATCH/.test(bare), '★ 增量套上去之后必须用同一套五项指纹复核，对不上就退回完整读取')
  assert.ok(/state\.lane === 'user'/.test(bare), '增量只给用户主动下拉那一条路：后台轮次与写链路的行为一个字都不动')
  assert.ok(/MIRROR_UNAVAILABLE/.test(bare), '本机拿不到与之同源同一版的行镜像时，必须退回完整读取')
  const ui = fs.readFileSync(path.join(ROOT, 'utils/ui-cloud-command.js'), 'utf8')
  assert.ok(/readTiming\.record\(entry\)/.test(ui), '生产接线必须把分段时间交给落盘账本')
  const server = fs.readFileSync(path.join(ROOT, 'cloudfunctions/readMyActiveCoachData/index.js'), 'utf8')
  assert.ok(/action === 'integrity'/.test(server), '云端必须保留 integrity 这个动作（后台轮次的首跳仍然靠它）')
  assert.ok(/action === 'changes'/.test(server), '云端必须提供增量动作（本轮新增的那个只读 action）')
  const changes = fs.readFileSync(path.join(ROOT, 'cloudfunctions/readMyActiveCoachData/changes.js'), 'utf8')
  assert.ok(/CHANGES_GAP/.test(changes), '★ 收据不连续必须判否（"查不到"绝不许当成"没有变化"）')
  assert.ok(/CHANGES_REQUIRES_FULL_READ/.test(changes), '受影响的行无法枚举的命令必须判 broad、退回完整读取')

  console.log('read first-hop probe: PASS'
    + '（没变化 = 1 次调用且带完整校验；变了 = 增量拿不到变更集 ⇒ 整份退回 8 集合分页 + integrity；'
    + '指纹对不上会如实失败；用户首跳不排队（在途整读还挂着就已发出）、进航位后排队等待已单独记账 '
    + queued.queueMs + 'ms；账本 ' + rows.length + ' 条定长记录已落盘）')
}
run().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 })
