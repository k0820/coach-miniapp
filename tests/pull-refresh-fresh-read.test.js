// 「主动下拉刷新不得复用旧的在途读取」（1.1.9）。
//
// 真机现象：电脑建/取消预约之后，手机下拉刷新**大约 10 秒**才看到变化。
// 诊断结论（读代码 + 用真实 cache 快照离线复刻云端分页口径算出）：
//   ① 一次完整回读的往返次数几乎完全由"每页装多少"决定 —— 20 条 / 24KB 时，
//      bookings 9 + incomes 9 + packages 3 + sales 3 + … 共 31 次 page 往返，
//      加 metadata + integrity = 33 次云函数往返；客户端并发被刻意限为 2 ⇒ 17 轮串行。
//   ② 用户下拉时若正好有一份**在途**回读还在飞，`readActive()` 会把那一份原样交出去 ——
//      而那份回读是在用户开口**之前**就把快照读走的。复用它 =
//      用户看到旧数据，而界面上的样子与"刷新什么都没发生"**完全同形**。
//
// 本测试钉住两侧：
//   · 用户轮次（userInitiated）**必须另起一次新的完整回读**，读到另一台设备刚写入的内容；
//   · 后台轮次（onShow 静默刷新 / 写命令后的自校验）**行为逐字不变**，仍然合并为一次；
//   · 并且**不许提高并发**（只改"一页装多少"，不动客户端并发数）。
//
// 判别力：把 readActive 的 userInitiated 分支去掉（回到旧行为），第 1 步立刻变红。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { buildCandidateDataset } = require('../utils/candidate-dataset')
const { createAdapter } = require('../utils/cloud-primary-adapter')

const ROOT = path.resolve(__dirname, '..')
const PHYSICAL = ['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
const LOGICAL = name => (name === 'student_tombstones' ? 'studentTombstones' : name)
const CTX = { trustedOwnerCoachId: 'o'.repeat(32), trustedDatasetId: 'd' }
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// ——————————————————————————————————————————————————————————————
// 1. 云端替身：严格按 readMyActiveCoachData 的协议与分页格式回话
// ——————————————————————————————————————————————————————————————
const world = {
  revision: 1,
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

// 一次读取一旦拿到 metadata，它之后每一步看到的都是**那一刻的一致快照**。
// 真实云端就是这样：另一台设备的写入如果落在这次读取的 integrity 之后，
// 这一次读取会带着一份自洽但**旧**的快照成功返回 —— 这正是"复用旧在途回读"要防的那个窗口。
let serving = null
function capture() {
  serving = { revision: world.revision, collections: clone(world.built.collections), integrity: clone(world.built.integrity) }
}
let metadataGate = null

// ⚠️ adapter 的 callCloud 拿到的**已经是云函数的 result**（生产实现里是 wx.cloud.callFunction
// 的 `.then(response => response.result)`），所以这里直接返回 result，不要再包一层 {result}。
async function callFunction({ name, data }) {
  assert.equal(name, 'readMyActiveCoachData', '只有只读回读通道，不存在任何写命令')
  if (data.action === 'metadata') {
    capture()
    if (metadataGate) { const gate = metadataGate; metadataGate = null; await gate }
    return { ok: true, environment: 'production', datasetId: 'd', dataRevision: serving.revision, headVersion: 1, collections: PHYSICAL.slice() }
  }
  if (data.action === 'page') {
    const rows = serving.collections[LOGICAL(data.collection)] || []
    return { ok: true, environment: 'production', collection: data.collection, datasetId: 'd', dataRevision: serving.revision, done: true, cursor: 0, nextCursor: rows.length, nextFragmentIndex: 0, encoding: 'base64-json', payload: Buffer.from(JSON.stringify(rows), 'utf8').toString('base64') }
  }
  if (data.action === 'integrity') {
    // ⚠️ integrity 必须回**现场算出来的**那一份（真实云端的 liveIntegrity 就是现读现算），
    //    不能用"上一次 metadata 时冻结的 serving"。
    //    1.1.9 第 2 轮的**校验式首跳**全靠这一跳发现"世界已经变了" —— 发现了才回去做完整读取。
    //    沿用陈旧 serving 会让首跳把"另一台设备刚写入"误判成"没变化"，直接把旧缓存当结果交出去：
    //    假件比真件松的地方，缺陷在真机上照样会复现（第 37 节的教训）。
    return { ok: true, environment: 'production', datasetId: 'd', dataRevision: world.revision, ...world.built.integrity }
  }
  return { ok: false, code: 'INVALID_ACTION' }
}

const storage = { get: key => clone(store[key]), set: (key, value) => { store[key] = clone(value) } }
const store = {}

async function run() {
  const adapter = createAdapter({ callCloud: (name, data) => callFunction({ name, data }), storage, environment: () => 'production' })

  // ——————————— 第 0 步：客户端先有一份基线缓存 ———————————
  const baseline = await adapter.readActive()
  assert.equal(baseline.ok, true, '基线回读必须成功')
  assert.deepEqual(store.coachCloudActiveCache.snapshot.bookings, [], '基线里本来没有预约')

  // ——————————— 第 1 步（核心）：旧在途回读 + 用户主动下拉 ———————————
  // 另一台设备在"用户开口之前"就已经写入 —— 世界前进到 revision 2。
  world.snapshot.bookings.push({ id: 'b-from-other-device', studentId: 's1', studentName: '假学员', packageId: 'p1', date: '2026-09-25', hour: 14, minute: 0, typeName: '常规训练', price: 150, status: 'booked', items: [], notes: '' })
  world.revision = 2
  rebuild()

  // 本机此刻**正好有一份在途回读**（课表 onShow 那一轮），它会拿到旧快照。
  let release
  metadataGate = new Promise(resolve => { release = resolve })
  const inFlight = adapter.readActive()
  await delay(5)
  assert.strictEqual(adapter.readActive(), inFlight, '后台轮次仍然合并为一次（既有契约不变）')

  // 用户在此时下拉刷新 = 一句「现在给我最新数据」的明确指令。
  const pulled = adapter.readActive({ userInitiated: true })
  assert.notStrictEqual(pulled, inFlight, '用户轮次必须是**一次新的回读**，不能是用户开口之前就起飞的那一份')
  assert.strictEqual(adapter.readActive({ userInitiated: true }), pulled, '用户轮次内部仍然合并为一次（连点两下不会叠加）')
  release()
  const [background, user] = await Promise.all([inFlight, pulled])
  assert.equal(background.ok, true, '旧在途回读照旧成功（它拿的是自己那一刻的一致快照）')
  assert.equal(user.ok, true, '用户轮次必须成功')
  assert.equal(user.revision, 2, '用户轮次读到的必须是**当前** revision')
  assert.ok(store.coachCloudActiveCache.snapshot.bookings.some(item => item.id === 'b-from-other-device'),
    '用户下拉刷新后必须看到另一台设备刚写入的那条 —— 复用"用户开口之前"的旧在途回读就会看不到')

  // ——————————— 第 2 步：用户轮次必须真的读一次云端（不是读本地缓存） ———————————
  world.snapshot.bookings.push({ id: 'b-second', studentId: 's1', studentName: '假学员', packageId: 'p1', date: '2026-09-25', hour: 15, minute: 0, typeName: '常规训练', price: 150, status: 'booked', items: [], notes: '' })
  world.revision = 3
  rebuild()
  await adapter.readActive({ userInitiated: true })
  assert.ok(store.coachCloudActiveCache.snapshot.bookings.some(item => item.id === 'b-second'), '用户轮次读的是云端当前权威数据，不是本地缓存')

  // ——————————— 第 3 步：静态契约 ———————————
  const server = fs.readFileSync(path.join(ROOT, 'cloudfunctions/readMyActiveCoachData/index.js'), 'utf8')
  const page = /const PAGE_LIMIT\s*=\s*([\d.]+)\s*,\s*PAGE_BYTES\s*=\s*([\d.]+\s*\*\s*[\d.]+)/.exec(server)
  assert.ok(page, '找不到 PAGE_LIMIT / PAGE_BYTES 声明')
  const pageLimit = Number(page[1]), pageBytes = Number(page[2].replace(/\s/g, '').split('*').reduce((a, b) => a * Number(b), 1))
  assert.ok(pageLimit >= 100, '单页条数必须放大到 >= 100（旧值 20 才是"10 秒"的主因），实得 ' + pageLimit)
  assert.ok(pageLimit <= 1000, '单页条数不得超过云数据库单次 get 的上限，实得 ' + pageLimit)
  assert.ok(pageBytes >= 128 * 1024, '单页字节必须放大到 >= 128KB（旧值 24KB），实得 ' + pageBytes)
  assert.ok(pageBytes * 4 / 3 < 1024 * 1024, '单页 base64 后必须仍明显低于 callFunction 返回体上限，实得 ' + Math.round(pageBytes * 4 / 3 / 1024) + 'KB')
  // 读什么 / 校验什么 / 分片逻辑**一个都不许动**：改的只是"一页装多少"。
  const serverBare = server.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')
  ;['reconstruct', 'fingerprint', "'ACTIVE_READ_REVISION_CHANGED'", 'function pagePayload', "'base64-fragment'", 'revision.dataRevision !== revisionBefore'].forEach(token => {
    assert.ok(serverBare.includes(token), '只允许改"一页装多少"，但 ' + token + ' 不见了 —— 读什么/校验什么/分片逻辑被动了')
  })
  const client = fs.readFileSync(path.join(ROOT, 'utils/cloud-primary-adapter.js'), 'utf8')
  const clientBare = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')
  assert.ok(/function readActive\(options\)/.test(clientBare), 'readActive 必须接受选项（用户轮次与后台轮次行为不同）')
  assert.ok(/options\s*&&\s*options\.userInitiated\s*===\s*true/.test(clientBare), '用户轮次必须被显式识别')
  assert.ok(/mapLimit\(meta\.collections,\s*2,/.test(clientBare), '客户端集合并发必须仍然是 2 —— 本轮只改分页，不动并发数')
  const ui = fs.readFileSync(path.join(ROOT, 'utils/ui-cloud-command.js'), 'utf8')
  assert.ok(/adapter\.readActive\(\{\s*userInitiated:/.test(ui), 'refreshActiveView 必须把 userInitiated 透传给读取层')
  const schedule = fs.readFileSync(path.join(ROOT, 'pages/schedule/schedule.js'), 'utf8')
  const pull = /onPullDownRefresh\(\)\{([^}]*)\}/.exec(schedule.replace(/\s+/g, ' '))
  assert.ok(pull, '找不到 onPullDownRefresh')
  assert.ok(/userInitiated:true/.test(pull[1]), '下拉刷新必须标记为用户主动轮次')

  console.log('pull refresh fresh read: PASS'
    + '（用户下拉不复用旧在途回读、后台轮次照旧合并、并发仍为 2、'
    + '单页 ' + pageLimit + ' 条 / ' + (pageBytes / 1024) + 'KB）')
}
run().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 })
