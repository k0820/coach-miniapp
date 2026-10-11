// 【永久回归】方案 A 的**客户端那一半**：全新 coach 第一次正常打开小程序，
// 不用看/不用点任何「云端 / 迁移 / Activation / Candidate / Dataset」按钮，
// 就自动拥有自己独立的云端空间，之后照旧走「本机立即保存 → Outbox → 后台云同步」。
//
// 分工（刻意不重复）：
//   · tests/init-coach-space.test.js —— **服务端**那一半：身份只认 getWXContext / 幂等不建第二份 /
//     账号隔离 / 空空间能被真实 adapter 完整读回 / settings 与写入器同契约。
//   · 本文件 —— **客户端**那一半：什么时候去开通、什么时候**绝不能**去开通、
//     离线 / 超时 / 杀进程 / 重复请求怎么收敛、开通成功后写链是不是真的通。
//
// 假件的口径：
//   服务端不是手写 if/else —— 挂的是**真实的** cloudfunctions/initMyCoachSpace/service.js（跑在假 db 上），
//   业务云端是**真实的** utils/cloud-command-engine.js（与真实云函数 coachBusinessCommand 同构）。
//   两边共用的 coachId / datasetId 由**真实**的 coachIdFor + fixedId 确定性派生，所以断言不是自说自话。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createWorld, settle, PROJ } = require('./helpers/local-first-world')
const { createCoachSpaceCloud } = require('./helpers/coach-space-cloud')
const { coachIdFor, fixedId, INITIAL_DATASET_KIND, DEFAULT_SETTINGS } = require('../cloudfunctions/initMyCoachSpace/service')

const OPENID = 'openid-fresh-coach-001'
const OWNER = coachIdFor(OPENID)
// ★ 服务端那份数据集 id 是**确定性派生**的（fixedId('coach-initial-dataset', owner)）——
//   所以客户端"读到的那一份"与"服务端创建的那一份"可以在测试里事先对齐成一个常量。
const DATASET = fixedId(INITIAL_DATASET_KIND, OWNER)
const SCOPE = { environment: 'production', datasetId: DATASET }
const dstr = '2026-09-17'
const ITEMS = [{ name: '卧推', group: '胸', sets: 4, reps: 12, weight: 40 }, { name: '高位下拉', group: '背', sets: 3, reps: 12, weight: 35 }]

// 极易被 require.cache 复活的模块（进程重启后必须重新 require 才看得见新实例）。
const bootstrapNow = () => require('../utils/cloud-bootstrap')
const runtimeNow = () => require('../utils/data-runtime')
const syncNow = () => require('../utils/sync-engine')
const outboxNow = () => require('../utils/local-outbox')
const mutateNow = () => require('../utils/mutate')

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}
function sourceOf(relative) { return stripComments(fs.readFileSync(path.join(PROJ, relative), 'utf8')) }

// 一台**全新手机**：任何 Storage 都没有，云函数路由指向真实的 initMyCoachSpace service。
// 默认把"云端那份空间本来就带一份默认 settings"也造出来（服务端开通时确实会写下这一份）。
function bootstrapWorld({ cloud, openId = OPENID, allowMaskedCommands = false, seed = { settings: { ...DEFAULT_SETTINGS } } } = {}) {
  const ownerCoachId = coachIdFor(openId)
  const datasetId = fixedId(INITIAL_DATASET_KIND, ownerCoachId)
  const provisionResults = []
  const world = createWorld({
    freshDevice: true,
    ownerCoachId,
    datasetId,
    allowMaskedCommands,
    cloudFunctions: {
      initMyCoachSpace: async data => { const result = await cloud.provision(openId, data); provisionResults.push(result); return result }
    }
  })
  if (seed) world.seedCloud(seed)
  return { world, ownerCoachId, datasetId, provisionResults }
}
const provisionCalls = world => world.counters.cloudCalls.filter(call => call.name === 'initMyCoachSpace')

// ---------------------------------------------------------------- ① 接线与红线（静态）
function scenarioWiring() {
  const app = fs.readFileSync(path.join(PROJ, 'app.js'), 'utf8')
  assert.ok(/require\('\.\/utils\/cloud-bootstrap'\)/.test(app), 'app.js 必须接入首次开通器')
  assert.ok(app.indexOf('wx.cloud.init') < app.indexOf("startCoachRuntime('launch')"), '教练运行时必须发生在 wx.cloud.init 之后')
  assert.ok(app.indexOf('wx.cloud.init') < app.indexOf('wx.getNetworkType'), '云开发必须先初始化，再注册可能触发补发的网络回调')
  assert.ok(app.indexOf('wx.cloud.init') < app.indexOf("require('./utils/ui-cloud-command')"), '云开发必须先初始化，再加载正式云写入口')
  assert.ok(/startCoachRuntime\('launch'\)/.test(app), '已有教练启动时必须进入统一教练运行时')
  const coachRuntime = app.slice(app.indexOf('startCoachRuntime(reason'), app.indexOf('onShow(options)'))
  assert.ok(/bootstrap\.maybeRun\(reason\)/.test(coachRuntime), '统一教练运行时必须跑一轮开通')
  const onShow = app.slice(app.indexOf('onShow(options)'), app.indexOf('onHide()'))
  assert.ok(/maybeRun\('show'\)/.test(onShow), '回到前台（onShow）必须补一轮开通')
  assert.strictEqual((app.match(/bootstrap\.resume\(\)/g) || []).length, 2, '两条网络恢复路径都必须跟着解除退避并补跑（getNetworkType + onNetworkStatusChange）')

  // 红线：开通器只做三件事（provision / readActive / activateCloudMode），不得碰写链路、沙箱、迁移、发布开关。
  const banned = ['mutate', 'coachBusinessCommand', 'local-outbox', 'local-projection', 'pending-training-draft', 'pending-booking-request', 'candidate-dataset', 'candidate-staging', 'cutover-orchestrator', 'cloud-migration', 'activateCoachDataset', 'cloud-chunk-transfer', 'release-flags', 'devEntries', 'setEnvironment', 'coachSandboxActiveCache']
  const client = sourceOf('utils/cloud-bootstrap.js')
  banned.forEach(name => assert.ok(!client.includes(name), `首次开通器（客户端）不得出现 ${name}`))
  const server = sourceOf('cloudfunctions/initMyCoachSpace/service.js')
  const serverBanned = ['coach_dataset_activation_receipts', 'cutover-orchestrator', 'cloud-migration', 'candidate-staging', 'coach_sandbox_', 'coachBusinessCommand']
  serverBanned.forEach(name => assert.ok(!server.includes(name), `首次开通器（云端）不得出现 ${name}`))
  // 云端开通**只写 meta + 一份 settings**，7 个业务事实集合必须零文档（新用户没有业务数据）。
  const business = ['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'customExercises']
  business.forEach(name => {
    assert.ok(!new RegExp(`put\\(\\s*tx\\s*,\\s*'${name}'`).test(server), `云端开通不得往 ${name} 写任何文档`)
  })
  console.log('  ✓ 接线与红线：app.js 三处触发点齐备；开通器不碰写链路 / 沙箱 / 迁移 / 候选 / 发布开关')
}

// ---------------------------------------------------------------- ② 首次启动（联网）
async function scenarioFirstLaunchOnline() {
  const cloud = createCoachSpaceCloud({ now: () => 1700000000000 })
  const { world, datasetId, provisionResults } = bootstrapWorld({ cloud })
  assert.strictEqual(datasetId, DATASET, '确定性派生：测试与服务端必须算出同一个 datasetId')
  const runtime = runtimeNow()
  const bootstrap = bootstrapNow()
  assert.strictEqual(runtime.mode(), runtime.MODES.LOCAL, '全新设备一开始必须是本机模式')
  assert.strictEqual(wx.getStorageSync(runtime.CACHE_KEY), undefined, '全新设备不该有云端 cache')
  assert.strictEqual(wx.getStorageSync(bootstrap.STATE_KEY), undefined, '全新设备不该有开通状态')

  const result = await bootstrap.ensure('launch')
  assert.strictEqual(result.ok, true, `首次开通必须成功（实测 ${result.code} / ${result.message || ''}）`)
  assert.strictEqual(result.code, 'BOOTSTRAP_READY')
  assert.strictEqual(result.datasetId, DATASET, '切到的必须是服务端那一份确定性数据集')
  assert.strictEqual(provisionResults.length, 1)
  assert.strictEqual(provisionResults[0].created, true, '云端这一份是新建的')
  assert.strictEqual(provisionResults[0].dataRevision, 0, '新空间必须从 revision 0 开始')

  // 数据源真的切过去了，而且 cache 是**回读校验过**的那一份。
  assert.strictEqual(runtime.mode(), runtime.MODES.CLOUD)
  const cache = wx.getStorageSync(runtime.CACHE_KEY)
  assert.strictEqual(cache.datasetId, DATASET)
  assert.strictEqual(cache.revision, 0)
  assert.ok(cache.checksum, 'cache 必须带完整性校验值')
  assert.strictEqual(runtime.cutoverState().status, runtime.MODES.CLOUD)
  assert.strictEqual(bootstrap.state().status, 'ready')
  assert.strictEqual(bootstrap.isReady(), true)
  assert.strictEqual(runtime.getDB().students.length, 0, '新空间读出来是空的')

  // 只有一次云调用，而且只调了开通函数。
  assert.deepStrictEqual(world.counters.cloudCalls.map(call => call.name), ['initMyCoachSpace'], '首次开通只允许调用开通云函数')
  assert.deepStrictEqual(world.counters.cloudCalls[0].data, { action: 'provision' }, '不得夹带任何身份字段')
  assert.strictEqual(world.counters.readActive, 1, '切换数据源必须经过一次完整回读（不是"假装已就绪"）')
  // 开通本身不写任何业务事实、不往队列里塞东西。
  assert.strictEqual(world.counters.calls.length, 0, '开通本身不得发任何业务命令')
  assert.strictEqual(outboxNow().count(SCOPE), 0, '开通不得往待同步队列里塞东西')
  assert.strictEqual(wx.getStorageSync(require('../utils/db').KEY), undefined, '本机 coachDB 不得被开通动作创建')
  // 云端只有一份空间，7 个业务集合零文档。
  assert.strictEqual(cloud.spaceCount(), 1)
  const counts = cloud.counts()
  ;['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'customExercises'].forEach(name => {
    assert.strictEqual(counts[name], 0, `新空间里 ${name} 必须零文档`)
  })
  console.log('  ✓ 首次启动（联网）：一次云调用、零业务写入、数据源切到自己的空空间（校验过指纹）')
}

// ---------------------------------------------------------------- ③ 首次启动（断网）
async function scenarioFirstLaunchOffline() {
  const cloud = createCoachSpaceCloud({ now: () => 1700000000000 })
  const { world } = bootstrapWorld({ cloud })
  world.cloudFunctions.initMyCoachSpace = () => { throw new Error('request:fail timeout') }
  const runtime = runtimeNow()
  const bootstrap = bootstrapNow()

  const first = await bootstrap.ensure('launch')
  assert.strictEqual(first.ok, false, '断网时绝不能假装开通成功')
  assert.strictEqual(first.code, 'BOOTSTRAP_NETWORK_FAILED')
  assert.strictEqual(first.retryLater, true)
  assert.strictEqual(runtime.mode(), runtime.MODES.LOCAL, '开通失败绝不能动数据源')
  assert.strictEqual(wx.getStorageSync(runtime.CACHE_KEY), undefined, '失败不得留下半份 cache')
  assert.strictEqual(bootstrap.state().status, 'pending', '失败只记 pending，等下次自动补')
  assert.strictEqual(cloud.spaceCount(), 0, '云端什么都没被创建')

  // ★ 小程序必须完全可用：本机模式下照常记账（本地写路径一个字节都没被改）。
  const localCalls = []
  const written = await mutateNow()('createStudent', { name: '断网学员' }, { key: 'student:offline', local: () => { localCalls.push(1); return { studentId: 'loc-1' } } })
  assert.strictEqual(written.path, 'local', '本机模式下写命令必须走本机路径')
  assert.strictEqual(localCalls.length, 1, '断网时本机记账必须照常工作')

  // 退避窗口内不得把请求往一个正在出故障的网络里继续打。
  const before = world.counters.cloudCalls.length
  const second = await bootstrap.ensure('show')
  assert.strictEqual(second.code, 'BOOTSTRAP_BACKOFF')
  assert.strictEqual(world.counters.cloudCalls.length, before, '退避窗口内不得再发请求')

  // 网络恢复（app.js 真实走的入口）→ 自动补上，且**不需要用户点任何东西**。
  world.cloudFunctions.initMyCoachSpace = data => cloud.provision(OPENID, data)
  const resumed = await bootstrap.resume()
  assert.strictEqual(resumed.ok, true, `网络恢复后必须自动补开通（实测 ${resumed.code}）`)
  assert.strictEqual(runtime.mode(), runtime.MODES.CLOUD)
  assert.strictEqual(cloud.spaceCount(), 1)
  assert.strictEqual(bootstrap.state().status, 'ready')
  console.log('  ✓ 首次启动（断网）：不动数据源、不假装成功、本机照常可用，网络恢复后自动补上')
}

// ---------------------------------------------------------------- ④ 初始化中杀进程 / 超时但云端其实成功
async function scenarioInterruptedProvision() {
  // (a) 请求发出去了、云端真的建好了，但客户端在**拿到响应之前**被杀掉。
  {
    const cloud = createCoachSpaceCloud({ now: () => 1700000000000 })
    const { world } = bootstrapWorld({ cloud })
    world.cloudFunctions.initMyCoachSpace = async data => { await cloud.provision(OPENID, data); throw new Error('process killed') }
    const killed = await bootstrapNow().ensure('launch')
    assert.strictEqual(killed.ok, false)
    assert.strictEqual(cloud.spaceCount(), 1, '云端其实已经建好了那一份')
    assert.strictEqual(runtimeNow().mode(), runtimeNow().MODES.LOCAL, '客户端什么都没切')

    world.restartProcess()
    world.cloudFunctions.initMyCoachSpace = data => cloud.provision(OPENID, data)
    const after = await bootstrapNow().resume()
    assert.strictEqual(after.ok, true, `重开后必须收敛到同一份空间（实测 ${after.code}）`)
    assert.strictEqual(after.datasetId, DATASET)
    assert.strictEqual(cloud.spaceCount(), 1, '绝不能长出第二份空间')
    assert.strictEqual(cloud.datasetIdsOf(OWNER).length, 1)
    assert.strictEqual(runtimeNow().mode(), runtimeNow().MODES.CLOUD)
  }
  // (b) 超时（响应丢了）但云端其实成功 —— 同一进程里补一轮也必须收敛到同一份。
  {
    const cloud = createCoachSpaceCloud({ now: () => 1700000000000 })
    const { world, provisionResults } = bootstrapWorld({ cloud })
    // 「客户端只看到超时」但云端其实已经建好了 —— 服务端真实跑完，客户端收不到结果。
    world.cloudFunctions.initMyCoachSpace = async data => { const result = await cloud.provision(OPENID, data); provisionResults.push(result); throw new Error('request:fail timeout') }
    assert.strictEqual((await bootstrapNow().ensure('launch')).ok, false)
    assert.strictEqual(cloud.spaceCount(), 1)
    world.cloudFunctions.initMyCoachSpace = async data => { const result = await cloud.provision(OPENID, data); provisionResults.push(result); return result }
    const converged = await bootstrapNow().resume()
    assert.strictEqual(converged.ok, true)
    assert.strictEqual(converged.datasetId, DATASET)
    assert.strictEqual(provisionResults.length, 2, '超时后必须真的重发过一次（不是"算了"）')
    assert.strictEqual(new Set(provisionResults.map(item => item.datasetId)).size, 1, '两次请求必须落在同一份空间上')
    assert.strictEqual(provisionResults[0].created, true)
    assert.strictEqual(provisionResults[1].alreadyProvisioned, true, '第二次必须被服务端认成"已经有了"')
    assert.strictEqual(cloud.spaceCount(), 1, '超时 + 重试绝不允许第二份')
  }
  console.log('  ✓ 初始化中杀进程 / 超时但云端成功：重开与重试都收敛到同一份空间，绝无第二套')
}

// ---------------------------------------------------------------- ⑤ 连续启动两次 + 并发触发
async function scenarioRepeatedLaunch() {
  const cloud = createCoachSpaceCloud({ now: () => 1700000000000 })
  const { world } = bootstrapWorld({ cloud })
  const bootstrap = bootstrapNow()
  // 同一轮里被触发两次（launch + show）→ 单航班，只发一次请求。
  const [a, b] = await Promise.all([bootstrap.ensure('launch'), bootstrap.ensure('show')])
  assert.strictEqual(a, b, '两次触发必须复用同一轮（同一份结果）')
  assert.strictEqual(a.ok, true)
  assert.strictEqual(provisionCalls(world).length, 1, '并发触发只能发一次开通请求')
  // 成功之后再启动：已经是云端主数据 → 零请求直接返回。
  const third = await bootstrap.ensure('launch')
  assert.strictEqual(third.skipped, true)
  assert.strictEqual(third.code, 'BOOTSTRAP_ALREADY_CLOUD')
  assert.strictEqual(provisionCalls(world).length, 1, '第二次启动不得再发任何请求')
  assert.strictEqual(world.counters.cloudCalls.length, 1, '成功之后联网启动应当零云调用')
  assert.strictEqual(cloud.spaceCount(), 1)
  assert.strictEqual(runtimeNow().mode(), runtimeNow().MODES.CLOUD)
  console.log('  ✓ 连续启动两次 / 并发触发：单航班只发一次，成功后一律零请求')
}

// ---------------------------------------------------------------- ⑥ 已有 cloud-primary 老账号升级
async function scenarioExistingUserUntouched() {
  const cloud = createCoachSpaceCloud({ now: () => 1700000000000 })
  // 默认世界 = 她本人的那台机器：已经是 cloud-primary，本机与云端都已经有真实业务数据。
  const world = createWorld({ cloudFunctions: { initMyCoachSpace: data => cloud.provision(OPENID, data) } })
  world.seed({
    students: [{ id: 'stu-old', name: '老学员', phone: '139', status: 'active', packages: [{ id: 'pkg-old', type: '常规训练', price: 100, total: 10, used: 2, remaining: 8, status: 'active' }] }],
    bookings: [{ id: 'bk-old', studentId: 'stu-old', studentName: '老学员', packageId: 'pkg-old', date: dstr, hour: 10, minute: 0, typeName: '常规训练', price: 100, status: 'done', items: ITEMS }],
    incomes: [{ id: 'in-old', bookingId: 'bk-old', studentId: 'stu-old', studentName: '老学员', date: dstr, time: '10:00', typeName: '常规训练', category: '综合训练', amount: 100 }],
    sales: [], settings: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 0, salesCommissionRate: 0 }, customExercises: []
  })
  const runtime = runtimeNow()
  const bootstrap = bootstrapNow()
  const storageBefore = JSON.stringify(Object.keys(world.store).sort().map(key => [key, world.store[key]]))
  const cacheBefore = JSON.stringify(wx.getStorageSync(runtime.CACHE_KEY))
  const dataBefore = JSON.stringify(runtime.getDB())
  const revisionBefore = runtime.cutoverState().revision

  const result = await bootstrap.ensure('launch')
  assert.strictEqual(result.skipped, true, '老账号必须被直接跳过')
  assert.strictEqual(result.code, 'BOOTSTRAP_ALREADY_CLOUD')
  assert.strictEqual(world.counters.cloudCalls.length, 0, '老账号升级必须**零网络调用**')
  assert.strictEqual(world.counters.calls.length, 0, '老账号不得被写入任何业务命令')
  assert.strictEqual(world.counters.readActive, 0, '老账号连回读都不该被触发')
  assert.strictEqual(cloud.calls.length, 0, '不得为老账号碰云端任何集合')
  assert.strictEqual(cloud.spaceCount(), 0, '不得为老账号创建任何空间（更不会换 dataset）')
  assert.strictEqual(bootstrap.state(), null, '不得写任何开通状态')
  assert.strictEqual(runtime.mode(), runtime.MODES.CLOUD, '数据源必须原样保持 cloud-primary')
  assert.strictEqual(runtime.cutoverState().revision, revisionBefore, 'revision 不得被动过')
  assert.strictEqual(JSON.stringify(Object.keys(world.store).sort().map(key => [key, world.store[key]])), storageBefore, '老账号的 Storage 必须逐字节不变')
  assert.strictEqual(JSON.stringify(wx.getStorageSync(runtime.CACHE_KEY)), cacheBefore, '云端 cache 必须逐字节不变')
  assert.strictEqual(JSON.stringify(runtime.getDB()), dataBefore, '老账号读到的数据必须逐字节不变')
  console.log('  ✓ 已有 cloud-primary 老账号升级：零网络调用、零写入、Storage 与数据逐字节不变')
}

// ---------------------------------------------------------------- ⑦ 同一微信账号清缓存 / 重装后回来
async function scenarioReinstallAndReturn() {
  const cloud = createCoachSpaceCloud({ now: () => 1700000000000 })
  // 云端已经有这个账号的一份空间 + 真实业务数据（上一次使用留下的）。
  const first = await cloud.provision(OPENID)
  assert.strictEqual(first.datasetId, DATASET, '服务端的 datasetId 规则必须与客户端一致')
  // 这台手机是重装后的：Storage 全空，但云端那份数据还在。
  const { world, provisionResults } = bootstrapWorld({
    cloud,
    seed: {
      students: [{ id: 'stu-cloud', name: '云端老学员', phone: '137', status: 'active', packages: [{ id: 'pkg-cloud', type: '常规训练', price: 100, total: 10, used: 2, remaining: 8, status: 'active' }] }],
      bookings: [{ id: 'bk-cloud', studentId: 'stu-cloud', studentName: '云端老学员', packageId: 'pkg-cloud', date: dstr, hour: 10, minute: 0, typeName: '常规训练', price: 100, status: 'done', items: ITEMS }],
      incomes: [{ id: 'in-cloud', bookingId: 'bk-cloud', studentId: 'stu-cloud', studentName: '云端老学员', date: dstr, time: '10:00', typeName: '常规训练', category: '综合训练', amount: 100 }],
      sales: [], settings: { ...DEFAULT_SETTINGS }, customExercises: []
    }
  })
  const runtime = runtimeNow()
  const result = await bootstrapNow().ensure('launch')
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.datasetId, DATASET, '必须切回**自己原有的那一份**，不是新建一份')
  assert.strictEqual(provisionResults[0].alreadyProvisioned, true, '服务端必须认出"已经有了"')
  assert.strictEqual(cloud.spaceCount(), 1, '重装回来绝不允许第二份空间')
  assert.strictEqual(runtime.mode(), runtime.MODES.CLOUD)
  // 云端原有数据必须完整读回来（不是把一个空空间当成自己的）。
  const db = runtime.getDB()
  assert.strictEqual(db.students.length, 1)
  assert.strictEqual(db.students[0].id, 'stu-cloud')
  assert.strictEqual(db.students[0].packages[0].remaining, 8)
  assert.strictEqual(db.bookings.filter(item => item.status === 'done').length, 1)
  assert.strictEqual(db.incomes.length, 1)
  assert.strictEqual(db.incomes[0].amount, 100)
  assert.deepStrictEqual(db.settings, { ...DEFAULT_SETTINGS }, 'settings 必须随空间一起读回来')
  console.log('  ✓ 清缓存 / 重装后回来：切回原有那一份空间，数据完整读回，绝不新建第二份')
}

// ---------------------------------------------------------------- ⑧ 不同微信账号完全隔离
async function scenarioAccountIsolation() {
  const cloud = createCoachSpaceCloud({ now: () => 1700000000000 })
  const other = 'openid-other-coach-002'
  const otherOwner = coachIdFor(other)
  const otherDataset = fixedId(INITIAL_DATASET_KIND, otherOwner)
  assert.notStrictEqual(otherDataset, DATASET, '不同账号的确定性 datasetId 必须不同')

  const A = bootstrapWorld({ cloud, openId: OPENID })
  const a = await bootstrapNow().ensure('launch')
  assert.strictEqual(a.datasetId, DATASET)
  const spaceBefore = cloud.snapshot()
  const groupsABefore = JSON.stringify(cloud.ownerGroups(OWNER))

  const B = bootstrapWorld({ cloud, openId: other })
  const b = await bootstrapNow().ensure('launch')
  assert.strictEqual(b.datasetId, otherDataset, 'B 必须拿到自己的那一份')
  assert.strictEqual(cloud.spaceCount(), 2)
  assert.strictEqual(cloud.datasetIdsOf(OWNER).length, 1)
  assert.strictEqual(cloud.datasetIdsOf(otherOwner).length, 1)
  assert.strictEqual(JSON.stringify(cloud.ownerGroups(OWNER)), groupsABefore, 'B 的开通绝不能碰 A 的空间')
  assert.notStrictEqual(JSON.stringify(cloud.ownerGroups(OWNER)), JSON.stringify(cloud.ownerGroups(otherOwner)), '两个人的空间必须各自独立')
  assert.strictEqual(cloud.stores.coaches.get(OWNER).openId, OPENID)
  assert.strictEqual(cloud.stores.coaches.get(otherOwner).openId, other)
  // 客户端这边：B 的设备读到的只能是 B 的空间。
  assert.strictEqual(runtimeNow().getDB().students.length, 0)
  assert.strictEqual(wx.getStorageSync(runtimeNow().CACHE_KEY).datasetId, otherDataset)
  void spaceBefore
  console.log('  ✓ 不同微信账号：各自的 coach / dataset / head 互不可见，B 的开通碰不到 A 半字节')
}

// ---------------------------------------------------------------- ⑨ Sandbox 与 Production 隔离
async function scenarioSandboxIsolation() {
  const cloud = createCoachSpaceCloud({ now: () => 1700000000000 })
  const { world } = bootstrapWorld({ cloud })
  const runtime = runtimeNow()
  runtime.setEnvironment(runtime.ENVIRONMENTS.SANDBOX)
  try {
    const result = await bootstrapNow().ensure('launch')
    assert.strictEqual(result.skipped, true, '沙箱环境里绝不自动开通')
    assert.strictEqual(result.code, 'BOOTSTRAP_NOT_PRODUCTION')
    assert.strictEqual(world.counters.cloudCalls.length, 0, '沙箱下必须零云端调用')
    assert.strictEqual(wx.getStorageSync(runtime.SANDBOX_CACHE_KEY), undefined, '不得写沙箱 cache')
    assert.strictEqual(wx.getStorageSync(runtime.CACHE_KEY), undefined, '不得写正式 cache')
    assert.strictEqual(runtime.mode(), runtime.MODES.LOCAL, '沙箱下数据源必须原样不动')
    assert.strictEqual(cloud.spaceCount(), 0, '沙箱下不得创建任何空间')
    assert.strictEqual(bootstrapNow().state(), null, '沙箱下不得留下开通状态')
  } finally { runtime.setEnvironment(runtime.ENVIRONMENTS.PRODUCTION) }
  // 回到正式环境，同一台设备照常自动开通。
  const back = await bootstrapNow().ensure('launch')
  assert.strictEqual(back.ok, true)
  assert.strictEqual(runtime.mode(), runtime.MODES.CLOUD)
  assert.strictEqual(wx.getStorageSync(runtime.SANDBOX_CACHE_KEY), undefined, '正式开通不得写沙箱 cache')
  console.log('  ✓ Sandbox / Production 隔离：沙箱里一个字都不做，正式环境照常自动开通')
}

// ---------------------------------------------------------------- ⑩ 完整生命周期（联网）
async function scenarioFullLifecycleOnline() {
  const cloud = createCoachSpaceCloud({ now: () => Date.now() })
  const { world } = bootstrapWorld({ cloud, allowMaskedCommands: true })
  const runtime = runtimeNow()
  const mutate = mutateNow()
  const sync = syncNow()
  const outbox = outboxNow()

  // 0) 新用户第一次打开
  assert.strictEqual((await bootstrapNow().ensure('launch')).ok, true)
  assert.strictEqual(runtime.getDB().students.length, 0)

  // 1) 建学员（云端先行：学员身份会被长期引用，必须云端当裁判）
  const stu = await mutate('createStudent', { name: '学员甲', phone: '13800000000' }, { key: 'student:1' })
  assert.strictEqual(stu.ok, true, `建学员必须成功（实测 ${stu.code || 'ok'}）`)
  const studentId = stu.result.studentId

  // 2) 建课包（课程销售：与销售记录原子创建）
  const sale = await mutate('createCourseSale', { studentId, type: '常规训练', total: 12, remaining: 12, quantity: 12, unitPrice: 100, amount: 1200, date: dstr }, { key: 'sale:1' })
  assert.strictEqual(sale.ok, true, `建课包必须成功（实测 ${sale.code || 'ok'}）`)
  const packageId = sale.result.packageId

  // 3) 约课 → 4) 录动作 → 5) 下课
  //    这个世界的 ui 替身里**没有预约协调器**（协调器自身的真机语义由 tests/booking-optimistic-response.test.js
  //    逐条覆盖），所以走的是它那张"协调器不可用 ⇒ 交给本机先行队列"的兜底牌 ——
  //    本机立刻生效 + 持久排队，正是阶段 2 已验证的写链。
  world.coordinatorOffline = true
  const booking = await mutate('createBooking', { studentId, packageId, date: dstr, hour: 10, minute: 0 })
  assert.strictEqual(booking.ok, true, `约课必须成功（实测 ${booking.code || 'ok'}）`)
  assert.strictEqual(booking.path, 'local-first')
  const localBookingId = booking.result.bookingId
  assert.strictEqual((await mutate('updateBookingContent', { bookingId: localBookingId, items: ITEMS, notes: '首课备注', category: '综合训练', duration: 60 })).ok, true, '录动作必须成功')
  const done = await mutate('completeBooking', { bookingId: localBookingId })
  assert.strictEqual(done.ok, true, `下课必须成功（实测 ${done.code || 'ok'}）`)
  // 连点第二下：同一条业务事实只有一条队列条目（第一帧也不会多扣一次）。
  const again = await mutate('completeBooking', { bookingId: localBookingId })
  assert.strictEqual(again.duplicate, true, '连点两次下课必须被识别为同一条业务')
  assert.strictEqual(again.requestId, done.requestId, '同一节课的完课号必须稳定不变')

  // 第一帧（还没等云端）：课已完、收入一条、课时 −1。
  const frame = runtime.getDB()
  assert.strictEqual(frame.bookings.find(item => item.id === localBookingId).status, 'done')
  assert.strictEqual(frame.incomes.length, 1, '第一帧就该有一条收入')
  assert.strictEqual(frame.students[0].packages[0].used, 1, '第一帧课时就该 −1')

  await sync.flush(); await settle(80)
  let state = world.snapshot()
  assert.strictEqual(state.bookings.length, 1)
  assert.strictEqual(state.bookings[0].status, 'done')
  assert.strictEqual(state.bookings[0].items.length, 2, '训练内容必须完整落到云端')
  assert.strictEqual(state.bookings[0].notes, '首课备注')
  assert.strictEqual(state.incomes.length, 1, '完课只能产生 1 条 Income')
  assert.strictEqual(Number(state.students[0].packages[0].used), 1, '完课只能扣 1 课时')
  assert.strictEqual(Number(state.students[0].packages[0].remaining), 11)
  assert.strictEqual(outbox.count(SCOPE), 0, '同步完成后队列必须清空')
  assert.ok(!String(state.bookings[0].id).startsWith('loc_'), '云端不得残留本机临时 id')
  assert.ok(state.incomes[0].bookingId, '收入必须挂在正式 bookingId 上')

  // 6) 杀进程重开：不得重新开通、数据仍在、写链照常。
  const provisionCount = provisionCalls(world).length
  world.restartProcess()
  const runtime2 = runtimeNow()
  const bootstrap2 = bootstrapNow()
  assert.strictEqual(runtime2.mode(), runtime2.MODES.CLOUD, '重开后仍然是云端主数据')
  assert.strictEqual(runtime2.getDB().students.length, 1, '重开后数据仍在（本机 cache 完整）')
  const restartRun = await bootstrap2.ensure('launch')
  assert.strictEqual(restartRun.skipped, true, '重开后不得再开通一次')
  assert.strictEqual(provisionCalls(world).length, provisionCount, '重开后不得再调开通云函数')
  const after = await mutateNow()('createStudent', { name: '重开后的学员' }, { key: 'student:2' })
  assert.strictEqual(after.ok, true, `重开后写链必须照常（实测 ${after.code || 'ok'}）`)
  await syncNow().flush(); await settle(60)
  state = world.snapshot()
  assert.strictEqual(state.students.length, 2, '重开后新建的学员必须落到云端')
  assert.strictEqual(state.bookings.length, 1, '原有的那条课程不得被重复提交')
  assert.strictEqual(state.incomes.length, 1, '原有的收入不得被重复提交')
  console.log('  ✓ 完整生命周期（联网）：开通 → 建学员 → 建课包 → 约课 → 录动作 → 下课（连点不重复）→ 杀进程重开 → 写链照常')
}

// ---------------------------------------------------------------- ⑪ 完整生命周期（断网 → 杀进程 → 恢复网络）
async function scenarioFullLifecycleOffline() {
  const cloud = createCoachSpaceCloud({ now: () => Date.now() })
  const { world } = bootstrapWorld({ cloud, allowMaskedCommands: true })
  const runtime = runtimeNow()
  const mutate = mutateNow()
  const outbox = outboxNow()

  // 承接上一节：云端已经有一份空间与数据，这台手机是刚装好的。
  await cloud.provision(OPENID)
  assert.strictEqual((await bootstrapNow().ensure('launch')).ok, true)

  // 建学员（联网，云端先行）
  const stu = await mutate('createStudent', { name: '离线学员', phone: '136' }, { key: 'student:offline' })
  assert.strictEqual(stu.ok, true)
  const sale = await mutate('createCourseSale', { studentId: stu.result.studentId, type: '常规训练', total: 12, remaining: 12, quantity: 12, unitPrice: 100, amount: 1200, date: dstr }, { key: 'sale:offline' })
  assert.strictEqual(sale.ok, true)
  await syncNow().flush(); await settle(60)

  // ---- 断网：整整一节课都在没有网络的情况下完成 ----
  world.online = false
  world.coordinatorOffline = true
  const booking = await mutate('createBooking', { studentId: stu.result.studentId, packageId: sale.result.packageId, date: dstr, hour: 14, minute: 0 })
  assert.strictEqual(booking.ok, true, '断网时必须能约课')
  const localBookingId = booking.result.bookingId
  assert.strictEqual((await mutate('updateBookingContent', { bookingId: localBookingId, items: ITEMS, notes: '断网录的内容', category: '综合训练', duration: 45 })).ok, true, '断网时必须能录动作')
  assert.strictEqual((await mutate('completeBooking', { bookingId: localBookingId })).ok, true, '断网时必须能下课')
  assert.strictEqual((await mutate('completeBooking', { bookingId: localBookingId })).duplicate, true, '断网连点两次也必须合成一条')
  assert.strictEqual(world.counters.calls.length, 2, '断网期间云端只该收到开通前的两条（建学员 / 建课包）')
  const offline = runtime.getDB()
  assert.strictEqual(offline.bookings.find(item => item.id === localBookingId).status, 'done', '断网时本机也必须立刻是已完成')
  assert.strictEqual(offline.incomes.length, 1, '断网时本机收入也必须立刻出现')
  assert.strictEqual(offline.incomes[0].amount, 100)
  assert.strictEqual(offline.students[0].packages[0].used, 1, '断网时本机课时也必须立刻 −1')

  // ---- 杀进程重开 ----
  const idsBefore = world.outboxEntries().map(entry => entry.requestId)
  world.restartProcess()
  const runtime2 = runtimeNow()
  assert.strictEqual(runtime2.mode(), runtime2.MODES.CLOUD, '重开后数据源不变')
  assert.strictEqual((await bootstrapNow().ensure('launch')).skipped, true, '重开后不得再开通')
  const queued = world.outboxEntries()
  assert.strictEqual(queued.length, 3, `重开后三条待同步必须都在（实测 ${queued.length}）`)
  assert.deepStrictEqual(queued.map(entry => entry.requestId), idsBefore, '重开后号必须逐个不变')
  assert.strictEqual(runtime2.getDB().bookings[0].status, 'done', '重开后本机数据仍在')

  // ---- 恢复网络 ----
  world.online = true
  await syncNow().resume(); await settle(80)
  const state = world.snapshot()
  const done = state.bookings.filter(item => item.status === 'done')
  assert.strictEqual(state.bookings.length, 1, '云端恰好 1 条预约（不得因重试变成两条）')
  assert.strictEqual(done.length, 1)
  assert.strictEqual(done[0].notes, '断网录的内容', '云端内容必须与断网时录的一致')
  assert.strictEqual(done[0].items.length, 2)
  assert.strictEqual(state.incomes.length, 1, '完课只允许 1 条 Income')
  assert.strictEqual(state.incomes.filter(item => item.bookingId === done[0].id).length, 1, '这条收入必须挂在这节课上')
  assert.strictEqual(Number(state.students[0].packages[0].used), 1, '完课只允许扣 1 课时')
  assert.strictEqual(Number(state.students[0].packages[0].remaining), 11)
  assert.strictEqual(outbox.count(SCOPE), 0, '队列必须清空')
  console.log('  ✓ 完整生命周期（断网→杀进程→恢复）：不丢不重，云端恰好 1 节 done / 1 条 Income / 扣 1 课时')
}

// ---------------------------------------------------------------- ⑫ 「重装回来的老账号」仍然照常下课
async function scenarioReinstallThenComplete() {
  const cloud = createCoachSpaceCloud({ now: () => Date.now() })
  const seeded = {
    students: [{ id: 'stu-r', name: '回访学员', phone: '135', status: 'active', packages: [{ id: 'pkg-r', type: '常规训练', price: 100, total: 10, used: 0, remaining: 10, status: 'active' }] }],
    bookings: [{ id: 'bk-r', studentId: 'stu-r', studentName: '回访学员', packageId: 'pkg-r', date: dstr, hour: 16, minute: 0, typeName: '常规训练', price: 100, status: 'booked', items: ITEMS }],
    incomes: [], sales: [], settings: { ...DEFAULT_SETTINGS }, customExercises: []
  }
  await cloud.provision(OPENID)
  const { world } = bootstrapWorld({ cloud, seed: seeded })
  const runtime = runtimeNow()
  assert.strictEqual((await bootstrapNow().ensure('launch')).ok, true)
  // 云端那条"已约"的课必须能直接下课（不是空空间，也不是被当成新空间）。
  // 闸门：先把同步关掉，让"连点两下"确定性地落在同一条队列条目上（不靠 sleep 赌时间）。
  world.online = false
  const first = await mutateNow()('completeBooking', { bookingId: 'bk-r' })
  assert.strictEqual(first.ok, true, `重装回访后下课必须成功（实测 ${first.code || 'ok'}）`)
  assert.strictEqual(first.path, 'local-first')
  const again = await mutateNow()('completeBooking', { bookingId: 'bk-r' })
  assert.strictEqual(again.duplicate, true, '在途连点第二下必须被识别为同一条业务')
  assert.strictEqual(again.requestId, first.requestId, '同一节课的完课号必须稳定不变')
  world.online = true
  await syncNow().flush(); await settle(60)
  const state = world.snapshot()
  assert.strictEqual(state.bookings.length, 1, '不得多出一条课')
  assert.strictEqual(state.bookings[0].status, 'done')
  assert.strictEqual(state.incomes.length, 1, '完课只产生 1 条 Income')
  assert.strictEqual(Number(state.students[0].packages[0].used), 1)
  assert.strictEqual(Number(state.students[0].packages[0].remaining), 9)
  assert.strictEqual(runtime.mode(), runtime.MODES.CLOUD)
  // 落地之后再点：本机业务事务当场拒绝（与云端**同一个错误码**），绝不再扣一次。
  const replay = await mutateNow()('completeBooking', { bookingId: 'bk-r' })
  assert.strictEqual(replay.ok, false, '已经完成的课不得被再完成一次')
  assert.strictEqual(replay.code, 'BOOKING_ALREADY_DONE', '本机拒绝它的错误码必须与云端逐字一致')
  await syncNow().flush(); await settle(60)
  const after = world.snapshot()
  assert.strictEqual(after.incomes.length, 1, '重复点击不得产生第二条收入')
  assert.strictEqual(Number(after.students[0].packages[0].used), 1, '重复点击不得再扣课时')
  assert.strictEqual(outboxNow().count(SCOPE), 0, '被拒绝的命令不得留在队列里')
  console.log('  ✓ 重装回访的老账号：直接在原有空间上正常下课，只扣 1、只记 1 条（再点被当场拒绝）')
}

async function main() {
  scenarioWiring()
  await scenarioFirstLaunchOnline()
  await scenarioFirstLaunchOffline()
  await scenarioInterruptedProvision()
  await scenarioRepeatedLaunch()
  await scenarioExistingUserUntouched()
  await scenarioReinstallAndReturn()
  await scenarioAccountIsolation()
  await scenarioSandboxIsolation()
  await scenarioFullLifecycleOnline()
  await scenarioFullLifecycleOffline()
  await scenarioReinstallThenComplete()
  console.log('ALL COACH SPACE BOOTSTRAP TESTS PASSED')
  process.exit(0)
}
main().catch(error => { console.error(error && error.stack || error); process.exit(1) })
