// 统一写入口（utils/mutate.js）永久回归 —— 阶段1「收敛写入口」的护栏。
//
// 两件事必须永久成立：
//   ① 22 条业务命令只有一条公共路径：utils/mutate.js。页面/组件不得自己决定「写本地还是写云端」，
//      也不得绕开统一入口直接发命令（否则以后新页面又会把写入口散开）。
//   ② mutate 的行为契约不变：云端路径仍然完全委托既有 Cloud-primary 实现
//      （runCommand / runCommandSilent / 协调器 / adapter.execute），Production/Sandbox 隔离、
//      requestId、receipt、revision、事务、integrity 全部原样沿用。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const root = path.resolve(__dirname, '..')
const mutateSource = fs.readFileSync(path.join(root, 'utils/mutate.js'), 'utf8')
const uiSource = fs.readFileSync(path.join(root, 'utils/ui-cloud-command.js'), 'utf8')
const { COMMANDS } = require('../utils/cloud-command-contract')
const { COMMANDS: ADAPTER_COMMANDS } = require('../utils/cloud-primary-adapter')
const { UI_COMMAND_BINDINGS, SERVER_TRIGGERED_COMMANDS } = require('../utils/ui-command-bindings')

// 页面/组件目录下的全部 .js —— 静态审计对象（含调试页，任何页面都不许绕开）
function collectSources(dir) {
  const result = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) result.push(...collectSources(full))
    else if (entry.name.endsWith('.js')) result.push(full)
  }
  return result
}
// ⭐ 2026-10-04 主包分包：低频诊断/救援页迁到了普通分包 pkg-diag，
//    它们**仍然是不许绕开统一写入口的页面**，静态审计必须照样覆盖（否则搬迁=审计漏网）。
const uiFiles = [...collectSources(path.join(root, 'pages')), ...collectSources(path.join(root, 'components')), ...collectSources(path.join(root, 'pkg-diag'))]
// 剥掉整行注释与块注释：注释里提到 runCommand 不代表绕开（例如「安全语义与 runCommand 一致」）
const codeOf = file => fs.readFileSync(file, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n')
const sources = new Map(uiFiles.map(file => [path.relative(root, file).replace(/\\/g, '/'), codeOf(file)]))

// ---------------------------------------------------------------- ① 静态审计
// 允许 mutate.xxx(...)，但不允许裸调用（那等于自己绕开统一入口）
const FORBIDDEN = ['runCommand', 'runCommandSilent', 'submitBooking', 'cancelBookingRequest', 'retryPendingBooking', 'retryPendingCancellation', 'resumePendingBookings', 'bookingOptimistic']
for (const [name, source] of sources) {
  for (const symbol of FORBIDDEN) {
    const bare = new RegExp(`(?<!mutate\\.)\\b${symbol}\\b`)
    assert.ok(!bare.test(source), `${name} 不得直接使用 ${symbol} —— 业务写只能走 utils/mutate.js`)
  }
  assert.ok(!/(?<!mutate\.)\badapter\.execute\s*\(/.test(source), `${name} 不得直接调用 adapter.execute —— 业务写只能走 utils/mutate.js`)
}

// ---------------------------------------------------------------- ①b 直连云函数的白名单
// 除了 22 条业务命令，页面里还剩一小撮「不是业务写」的直连云函数调用。它们不能被塞进
// mutate 的 22 条白名单，因为语义正好相反，必须逐条登记、逐条说明理由、逐条钉死函数名：
//   · 破坏性全量重置 deleteMyCoachData —— 契约要求「云端先确认成功，本机才删」，绝不允许本机先行；
//     若被 local-first 化，会出现「本机已清空而云端没删」的不可逆事故 → 刻意留在业务写入口之外。
//   · 只读诊断 diagnoseCoachCompletion —— 只查不写。
//   · 沙箱/割接/迁移/诊断 工具页 —— 只与专用测试云函数对话（可注入故障 failAt），
//     走业务写入口会让它们失去故障注入能力并污染真实业务路径。
// 关键是这张表是「封闭」的：任何新页面想直连云函数来写数据，都会在下一条断言里失败。
const DIRECT_CLOUD_ALLOWED = {
  'pages/session/session.js': { functions: ['diagnoseCoachCompletion'], readOnly: true, reason: '完课诊断只读查询' },
  'pages/coach-command-test/coach-command-test.js': { functions: ['coachBusinessCommandTest'], reason: '沙箱事务故障注入诊断台' },
  'pages/sandbox-control/sandbox-control.js': { functions: ['manageCoachSandbox', 'manageMemberSandbox'], reason: '教练端与会员端沙箱开关管理；两者都只作用于隔离测试数据' },
  // M2 第四批（2026-09-26）：Sandbox 验收页。它**唯一**直连的云函数是零写入的跨账只读取证
  // （对端课时 / 双方版本 / 双方回执）；两条共享命令的写**一律**走 utils/mutate.js。
  // 它绝不接受客户端提交 ownerCoachId / datasetId —— 那条边界由 tests/m2-shared-verification.test.js 钉死。
  // ⏱️ 2026-10-05：**课程提醒测试时钟**也走这个页（第 ⑤ 卡）。它直连的 `classReminderSandboxScheduler`
  //    是**测试区专属**的定时云函数，手动 `runOnce` 时最多把"现在"往前拨 —— ⛔ 只影响这一次调用，
  //    不改任何业务数据；正式区那份函数里连这个入口都没有（tests/notify-acceptance-16.test.js 段 ⑰ 钉死）。
  //    ⇒ 登记在这里正是为了让"谁可以直连哪个云函数"这件事**看得见**，而不是悄悄绕过统一入口。
  'pages/sandbox-shared-test/sandbox-shared-test.js': { functions: ['diagnoseSharedUsage', 'classReminderSandboxScheduler'], readOnly: true, reason: 'M2 Sandbox 验收页：跨账只读取证 + 测试区课程提醒测试时钟（仅手动跑一次，不改业务数据）；业务写入一律走统一入口' },
  'pkg-diag/cloud-cutover/cloud-cutover.js': { functions: [], dynamic: true, reason: '云端割接执行台（函数名由割接步骤决定）' },
  'pkg-diag/candidate-staging-test/candidate-staging-test.js': { functions: ['stageCoachCandidate'], reason: '候选数据暂存工具' },
  'pages/coach-migration-test/coach-migration-test.js': { functions: ['getOrCreateCoach'], reason: '迁移期身份引导' },
  'pages/coach-cloud-read-test/coach-cloud-read-test.js': { functions: [], dynamic: true, reason: '云端只读比对（shadow read）' },
  'pages/stats/stats.js': { functions: ['deleteMyCoachData'], reason: '危险区全量重置（云端先确认，永不走本机先行）' }
  ,'pkg-diag/production-recovery-diagnostic/production-recovery-diagnostic.js': { functions: ['diagnoseCoachCompletion', 'coachBusinessCommand'], reason: '临时救援只读：diagnose + getReceipt，绝不 execute' }
  ,'pkg-diag/repair-orphan-tombstone/repair-orphan-tombstone.js': { functions: ['coachBusinessCommand', 'readMyActiveCoachData'], reason: '缺墓碑抢修通道：事故现场读端已坏，刻意绕开依赖 revision 的统一入口；只发 repair* 三个动作 + purge* 三个动作（通道二：清除 4 行测试遗留）' }
}
// 整页都属于「非业务工具」的页面 —— 不计入业务写面
const TOOL_PAGES = new Set([
  'pages/coach-command-test/coach-command-test.js',
  'pages/sandbox-control/sandbox-control.js',
  'pkg-diag/cloud-cutover/cloud-cutover.js',
  'pkg-diag/candidate-staging-test/candidate-staging-test.js',
  'pages/coach-migration-test/coach-migration-test.js',
  'pages/coach-cloud-read-test/coach-cloud-read-test.js'
  ,'pkg-diag/production-recovery-diagnostic/production-recovery-diagnostic.js'
])
// 业务页里唯一允许「直连云端做写」的破坏性例外（云端先确认，绝不允许本机先行）
const DESTRUCTIVE_RESET_PAGES = new Set(['pages/stats/stats.js'])
// 业务页里允许「直连云端做写」的第二类例外：**一次性数据抢修通道**（2026-09-22 缺墓碑事故）。
// 它必须留在统一入口之外，理由不是偷懒，而是语义正好相反：
//   事故现场 readActive 永久失败（云端 integrity 抛 ACTIVE_RELATION_INVALID）⇒ 本机 revision
//   永远拿不到 ⇒ mutate.js 的**每一条**命令都会在 callCloud 之前被判 REVISION_UNKNOWN 拒掉。
//   把抢修动作塞进 mutate，等于让它依赖那个已经坏掉的东西 —— 永远修不好。
// 所以它和 deleteMyCoachData 同类：**云端先行、本机绝不先行**，逐条登记、逐条钉死边界。
const CLOUD_FIRST_REPAIR_PAGES = new Set([
  'pkg-diag/repair-orphan-tombstone/repair-orphan-tombstone.js'
])
for (const [name, source] of sources) {
  if (!source.includes('callFunction')) continue
  const allowed = DIRECT_CLOUD_ALLOWED[name]
  assert.ok(allowed, `${name} 直连云函数却不在白名单里 —— 业务写只能走 utils/mutate.js`)
  assert.ok(allowed.reason, `${name} 的白名单条目必须写明理由`)
  const callSites = [...source.matchAll(/callFunction\s*\(\s*\{[^}]*?name\s*:\s*'([^']+)'/g)].map(match => match[1])
  for (const fn of callSites) assert.ok(allowed.functions.includes(fn) || allowed.dynamic, `${name} 直连了未登记的函数 ${fn}`)
}
const recoverySource = sources.get('pkg-diag/production-recovery-diagnostic/production-recovery-diagnostic.js')
assert.ok(recoverySource.includes("action: 'diagnose'") && recoverySource.includes("action: 'getReceipt'"), '救援页只可使用现有只读云 action')
assert.ok(!/action:\s*['"]execute['"]/.test(recoverySource), '救援页不得执行正式业务命令')
// 白名单里出现的文件都必须真实存在
for (const name of Object.keys(DIRECT_CLOUD_ALLOWED)) assert.ok(sources.has(name), `白名单登记了不存在的文件：${name}`)
// 非业务工具页一律不许碰业务写路径（它们只能与专用测试云函数对话）
for (const name of TOOL_PAGES) {
  const source = sources.get(name)
  for (const token of ["require('../../utils/mutate')", 'mutate(', 'runCommand', 'adapter.execute']) {
    assert.ok(!source.includes(token), `${name} 属于非业务工具页，不得混入业务写路径（命中 ${token}）`)
  }
}
// 业务页只允许「只读诊断」直连云端；想写就必须走统一入口 —— 唯一例外是登记在案的破坏性重置
for (const [name, source] of sources) {
  if (TOOL_PAGES.has(name) || !source.includes('callFunction')) continue
  const allowed = DIRECT_CLOUD_ALLOWED[name]
  if (allowed.readOnly || DESTRUCTIVE_RESET_PAGES.has(name) || CLOUD_FIRST_REPAIR_PAGES.has(name)) continue
  assert.fail(`${name} 是业务页，直连云函数只允许只读诊断；写操作必须走 utils/mutate.js`)
}
// 破坏性重置必须是「云端先确认」的写法，且永远不许被本机化（这是数据安全底线）
for (const name of DESTRUCTIVE_RESET_PAGES) {
  const source = sources.get(name)
  assert.ok(source.includes("name:'deleteMyCoachData'"), `${name} 的危险区重置必须直连 deleteMyCoachData（云端先确认）`)
  assert.ok(!/mutate\s*\(\s*'deleteMyCoachData'/.test(source), `${name} 的危险区重置不得被 local-first 化`)
}
// 抢修通道的边界必须**逐条钉死**，否则这张白名单就变成「以后谁都能直连云端写数据」的后门：
//   ① 动作面必须精确等于「只读三件套（metadata/integrity/page）+ 回执 + repair* 三个 + purge* 三个
//      + diagnose」。多一个都算越界（purge* 是通道二：清除那 4 行测试遗留，与补墓碑互斥、一次只走一条）。
//      `diagnose` = diagnoseCoachCompletion 的**只读**分支，2026-09-23 登记：抢修页做「一次性单条 requestId
//      迁移」之前**必须再次取证**（无 completeBooking 回执 / booking 仍 booked / 课时未扣 / 无 income），
//      而这份证据只能从它取。登记不是口头承诺 —— 下面有一条断言直接核对那个云函数里没有任何写调用。
//   ② 不许引用任何一条 22 条正式业务命令（抢修不是业务写）；
//   ③ 不许混入统一写入口 —— 一旦 require 了 mutate，这条通道就依赖了那个已经坏掉的 revision。
// ③ 的例外（2026-09-26 登记，M2 第三批）：`shareForPackage` / `shareStateByCode` 是
//    `diagnoseSharedUsage`（**零写入**的跨账只读取证）的只读分支 —— 抢修通道要做
//    「共享命令的写入后回读核验」，而**对端那本账**的证据只有它能取到（本机那条路只能读自己）。
//    登记同样不是口头承诺：下面有一条断言直接核对这个函数里没有任何数据库写调用，
//    且它**不接受**任何身份/定位字段（那条边界由 tests/m2-shared-verification.test.js 逐条钉死）。
const REPAIR_ACTIONS = ['diagnose', 'getReceipt', 'integrity', 'metadata', 'page', 'purgeTestRows', 'purgeTestRowsInspect', 'purgeTestRowsRollback', 'repairInspect', 'repairStudentTombstone', 'repairTombstoneRollback', 'shareForPackage', 'shareStateByCode']
// ② 的例外（2026-09-23 登记）：「安全自动续跑」必须认出**唯一会同时扣课时 + 记收入**的那条命令，
//    才能对它做完课账本差量对账（课时恰好扣一次 / 收入恰好记一笔 / 回执恰好一条）。
//    登记不是口头承诺 —— 下面是机检：这个名字在抢修页里**只允许以比较式（=== / !==）出现**。
const REPAIR_COMPARE_ONLY_COMMANDS = ['completeBooking']
// 「真正引用某条命令」的**唯一口径**：`=== 'x'` / `!== 'x'` 这类**纯比较**不算引用 ——
// 它不产生任何发送能力（页面上没有把命令名交给任何发送面）。两份检查共用这一份判定：
//   ① 抢修通道「只许比较」的机检；② 命令 UI 出口的归属判定（谁是这条命令的出口）。
function commandQuoteCounts(source, command) {
  const quoted = (source.match(new RegExp(`'${command}'`, 'g')) || []).length
  const compared = (source.match(new RegExp(`(===|!==)\\s*'${command}'|'${command}'\\s*(===|!==)`, 'g')) || []).length
  return { quoted, compared }
}
const mentionsCommand = (source, command) => { const counts = commandQuoteCounts(source, command); return counts.quoted > counts.compared }
// 上面登记的 `diagnose` 必须真的**只读**：直接核验该云函数里没有任何数据库写调用（add/update/remove/set/doc）。
// ⚠️ 只认 `collection(...)` 链上的写，避免误伤 `crypto.createHash(...).update(...)` 那种同名的非数据库调用。
const diagnoseSource = fs.readFileSync(path.join(root, 'cloudfunctions/diagnoseCoachCompletion/index.js'), 'utf8')
const diagnoseWrites = [...diagnoseSource.matchAll(/collection\([^)]*\)[^;]*?\.(add|update|remove|set|doc)\s*\(/g)]
assert.strictEqual(diagnoseWrites.length, 0, `diagnoseCoachCompletion 必须只读（这是登记 diagnose 的前提），却出现了写调用：${diagnoseWrites.map(row => row[0]).join(' | ')}`)
assert.ok(/\.get\(\)/.test(diagnoseSource), 'diagnoseCoachCompletion 应当是查询型（只有 .get() 读）')
// 同一把尺子量一遍新登记的 `diagnoseSharedUsage`：它**必须零写入**，否则"取证"就成了第二个写入面。
const sharedUsageSource = fs.readFileSync(path.join(root, 'cloudfunctions/diagnoseSharedUsage/service.js'), 'utf8')
// ⚠️ 只认**同一行**上的写（跨行会误伤 `seen.add(`、`createHash(...).update(` 这类非数据库调用）。
const sharedUsageWrites = [...sharedUsageSource.matchAll(/collection\([^)]*\)[^\n;]*?\.(add|update|remove|set|doc)\s*\(/g)]
assert.strictEqual(sharedUsageWrites.length, 0, `diagnoseSharedUsage 必须零写入（这是登记 shareForPackage / shareStateByCode 的前提），却出现了写调用：${sharedUsageWrites.map(row => row[0]).join(' | ')}`)
assert.ok(/\.get\(\)/.test(sharedUsageSource), 'diagnoseSharedUsage 应当是查询型（只有 .get() 读）')
assert.ok(/FORBIDDEN/.test(sharedUsageSource) && /FORBIDDEN_IDENTITY_INPUT/.test(sharedUsageSource), 'diagnoseSharedUsage 必须拒收客户端的身份/定位字段')
for (const name of CLOUD_FIRST_REPAIR_PAGES) {
  const source = sources.get(name)
  assert.ok(source, `抢修通道登记了不存在的文件：${name}`)
  const actions = [...new Set([...source.matchAll(/action:\s*'([A-Za-z]+)'/g)].map(match => match[1]))].sort()
  assert.deepStrictEqual(actions, REPAIR_ACTIONS, `${name} 的动作面越界 —— 只允许 ${REPAIR_ACTIONS.join('/')}，实际：${actions.join(',')}`)
  for (const command of COMMANDS) {
    if (!source.includes(`'${command}'`)) continue
    assert.ok(REPAIR_COMPARE_ONLY_COMMANDS.includes(command), `${name} 属于抢修通道，不得引用正式业务命令 ${command}`)
    // 机检：出现几次就必须是几次"比较式"。任何一次"当命令名发出去"（`command: '...'` / `execute('...')`
    // 之类）都会让两个数字对不上 ⇒ 当场变红。白名单因此不是后门，而是一条**可核验的窄缝**。
    const counts = commandQuoteCounts(source, command)
    assert.strictEqual(counts.compared, counts.quoted, `${name}：「${command}」只允许以比较式（=== / !==）出现 —— 实际出现 ${counts.quoted} 处，其中比较式只有 ${counts.compared} 处`)
  }
  for (const token of ["require('../../utils/mutate')", 'mutate(', 'adapter.execute']) {
    assert.ok(!source.includes(token), `${name} 属于抢修通道，不得混入统一写入口（命中 ${token}）`)
  }
}
// 抢修通道必须与危险区重置同构：**云端先确认，本机绝不先行**（本机先行 = 云端没修好却显示修好了）
assert.ok(!/LOCAL_FIRST|local-first/.test(sources.get('pkg-diag/repair-orphan-tombstone/repair-orphan-tombstone.js')), '抢修通道不得本机先行')
// 业务写面 = 除工具页以外的全部页面/组件（逐个都必须接进统一入口）
const businessSources = [...sources].filter(([name]) => !TOOL_PAGES.has(name))
assert.ok(businessSources.length >= 8, `业务写面文件数异常：${businessSources.length}`)
// 守卫必须真的挂在两个云端写入口上（默认只在测试里启用，生产行为不变）
assert.ok(uiSource.includes('assertWriteFunnel(\'runCommand\')'), 'runCommand 必须挂统一写入口守卫')
assert.ok(uiSource.includes('assertWriteFunnel(\'runCommandSilent\')'), 'runCommandSilent 必须挂统一写入口守卫')
// 阶段 2：本机先行**已经启用**，但它必须仍然是一个「一个常量就能关掉」的可回退开关 ——
// 关掉之后必须回落到阶段 1 的云端先行语义（而不是留下半开半关的中间态）。
assert.ok(/LOCAL_FIRST_ENABLED = true/.test(mutateSource), '阶段 2 必须启用 Local-first')
assert.ok(/LOCAL_FIRST_ENABLED = (true|false)/.test(mutateSource), '本机先行必须由一个顶层常量控制（可回退开关）')
const strategySource = mutateSource.slice(mutateSource.indexOf('function strategyFor'), mutateSource.indexOf('function preconditionFailure'))
assert.ok(/if \(LOCAL_FIRST_ENABLED && command && isLocalFirstCommand\(command\)\)/.test(strategySource), '本机先行必须整体挂在 LOCAL_FIRST_ENABLED 之下：关掉开关就回落到云端先行')
// 安全续跑（诊断后的完课）也必须经由统一入口的直通策略
const sessionSource = sources.get('pages/session/session.js')
assert.ok(/execute:\s*\(command,payload,options\)\s*=>\s*mutate\.raw\(command,payload,options\)/.test(sessionSource), '安全续跑的 execute 必须绑定 mutate.raw')

// ---------------------------------------------------------------- 假 wx（不落盘、可观察）
const storage = {
  coachDataSourceMode: 'cloud-primary',
  coachCloudActiveCache: {
    environment: 'production', datasetId: 'ds-prod', revision: 1, checksum: 'x', byteSize: 1, summary: {}, updatedAt: 1,
    snapshot: {
      students: [], bookings: [], incomes: [], sales: [],
      customExercises: [{ id: 'ce-1', name: '测试动作', group: '肩' }],
      settings: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 0, salesCommissionRate: 0 }
    }
  }
}
const seen = { toasts: [], modals: [], loading: 0, execute: [] }
global.wx = {
  getStorageSync: key => copy(storage[key]),
  setStorageSync: (key, value) => { storage[key] = copy(value) },
  removeStorageSync: key => { delete storage[key] },
  showToast: options => seen.toasts.push(options),
  showModal: options => { seen.modals.push(options); if (options && options.success) options.success({ confirm: true, cancel: false }) },
  showLoading: () => { seen.loading++ },
  hideLoading: () => {},
  showTabBar: () => {},
  cloud: { callFunction: () => Promise.resolve({ result: { ok: false, code: 'NOT_USED' } }) }
}

const ui = require('../utils/ui-cloud-command')
const mutate = require('../utils/mutate')

// 22 条命令的「契约一致性 + UI 出口覆盖」——依赖已加载的 mutate 模块，故放在 require 之后校验。
// 阶段 2 的接缝**已经打开**（这是刻意的），但它必须还能一键关回去：localFirstEnabled() 就是那个开关。
assert.strictEqual(mutate.localFirstEnabled(), true, '阶段 2 必须启用本机先行')
// 22 条命令逐条必须在 mutate 白名单里，且三处口径完全一致（契约 / adapter / UI 绑定）
assert.deepStrictEqual(mutate.COMMANDS.slice().sort(), COMMANDS.slice().sort(), 'mutate 白名单必须与 cloud-command-contract 逐条一致')
assert.deepStrictEqual(mutate.COMMANDS.slice().sort(), ADAPTER_COMMANDS.slice().sort(), 'mutate 白名单必须与 adapter 口径一致')
// ⭐ 2026-10-06：授权不再由教练手工点 ⇒ 那 5 条命令改成**只由服务端触发**（添加/删除联系人时写）。
//    ⇒ "有 UI 出口的命令" + "只由服务端触发的命令" = 全部命令，一格不多一格不少。
assert.deepStrictEqual(Object.keys(UI_COMMAND_BINDINGS).concat(SERVER_TRIGGERED_COMMANDS).sort(), mutate.COMMANDS.slice().sort(),
  'UI 绑定表 + 服务端触发表必须覆盖全部命令')
// 每条命令都必须有出口（UI 出口 or 服务端触发），而且出现它的页面必须已经从统一入口取写入能力。
// ⚠️ 这里的"出现"用 `mentionsCommand`（纯比较不算）—— 否则抢修页里那句"认出动钱的那条命令"
//    会被误判成"出口"，逼着抢修通道去接统一写入口（那正好是这条通道**必须**避开的东西）。
for (const command of mutate.COMMANDS) {
  if (SERVER_TRIGGERED_COMMANDS.indexOf(command) >= 0) {
    // ⛔ 反向钉死：这 5 条**不许**有任何页面出口（想从手机端手工授权 = 老毛病回来）
    const owners = businessSources.filter(([, source]) => mentionsCommand(source, command)).map(([name]) => name)
    assert.deepStrictEqual(owners, [], `${command} 只许由服务端触发，不许再有 UI 出口（实际：${owners.join(',')}）`)
    continue
  }
  const owners = businessSources.filter(([, source]) => mentionsCommand(source, command)).map(([name]) => name)
  assert.ok(owners.length, `${command} 没有任何 UI 出口`)
  for (const owner of owners) {
    const source = sources.get(owner)
    assert.ok(source.includes("require('../../utils/mutate')"), `${owner} 引用了 ${command} 却没有接入统一写入口`)
    assert.ok(source.includes('mutate(') || source.includes('mutate.'), `${owner} 引用了 ${command} 却没有调用统一写入口`)
  }
}
// 反向覆盖：业务写面里凡是发起写动作的文件都必须接进统一入口（防止新增页面绕过）
for (const [name, source] of businessSources) {
  const writes = /(mutate\s*\(|mutate\.[a-zA-Z]+\s*\()/.test(source)
  if (!writes) continue
  assert.ok(source.includes("require('../../utils/mutate')"), `${name} 发起了业务写却没有接入统一写入口`)
}

// 只把「云」换成假件：写命令按真实回执形状返回，其余语义（单航班/幂等号/缓存）保持真实现
ui.adapter.getState = () => ({ datasetId: 'ds-prod', revision: 5, snapshot: null })
ui.adapter.readActive = async () => ({ ok: true, environment: 'production', datasetId: 'ds-prod', revision: 5, checksum: 'x', byteSize: 1, summary: {}, snapshot: copy(storage.coachCloudActiveCache.snapshot) })
ui.adapter.getReceipt = async () => ({ ok: true, found: true, status: 'succeeded', response: { ok: true } })
ui.adapter.execute = async (command, payload, options) => {
  seen.execute.push({ command, payload: copy(payload), options: copy(options) })
  return { ok: true, command, datasetRevision: 6, refreshed: { ok: true, datasetId: 'ds-prod', revision: 6 } }
}

;(async () => {
  // ---------------------------------------------------------------- ② 运行时：22 条命令全部经统一入口
  // 阶段 2：数据源模式 = 本机先行（云端仍是**唯一事实来源**，只是写命令先落本机 + 持久队列）；
  // 执行路径仍是 cloud —— 这两件事不是一个概念，别混。
  assert.strictEqual(mutate.dataSourceMode(), 'local-first')
  assert.strictEqual(mutate.executionPath(), 'cloud')
  mutate.clearAudit()
  const optimistic = []
  for (const command of mutate.COMMANDS) {
    const key = `surface:${command}`
    const result = await mutate(null, null, { key, command, payload: { probe: command } })
    assert.ok(!result || result.code !== 'COMMAND_NOT_ALLOWED', `${command} 必须被统一入口接受`)
    const dispatched = seen.execute.some(item => item.command === command)
    // 阶段 2：本机先行命令的审计路径是 'local-first'（先落本机 + 持久队列，再由同步引擎送云）。
    // 审计要钉的是「有没有绕开统一入口」，不是「走的哪条子路径」—— 两条都算经由统一入口。
    const audited = mutate.audit().some(item => item.command === command && (item.path === 'cloud' || item.path === 'local-first'))
    assert.ok(audited, `${command} 必须写进统一入口的写入审计`)
    if (!dispatched) optimistic.push(command)   // 预约/取消由既有本机视觉协调承担（后台异步落实）
  }
  await delay(40)
  for (const command of mutate.COMMANDS) {
    if (optimistic.includes(command)) continue
    assert.ok(seen.execute.some(item => item.command === command), `${command} 必须真的派发到云端写`)
  }
  // 云端真的收到了什么，统一入口就必须记到什么 —— 一条都不许漏（这就是「没绕开」的证据）
  const executedCommands = new Set(seen.execute.map(item => item.command))
  for (const command of executedCommands) {
    assert.ok(mutate.audit().some(item => item.command === command), `云端执行了 ${command}，统一入口却没有记录 —— 说明有路径绕开了统一入口`)
  }

  // ---------------------------------------------------------------- ③ 守卫：绕开统一入口必须被拦住
  // 这一节钉的是**守卫窗口**（绕开 mutate 的裸调用必须被拦），不是某条业务命令的本机语义。
  // 所以取样命令必须是「本机事务必定接受」的那一条：用 deleteStudent + 一个投影里不存在的 id，
  // 会在守卫之前就被本机业务事务以 STUDENT_NOT_FOUND 拒掉 —— 那是业务拒绝，不是守卫漏放，
  // 断言会指向一个完全无关的地方。saveSettings 只改设置字段，不依赖任何实体存在。
  ui.__writeFunnel.enforce(true)
  await assert.rejects(() => ui.runCommand({ key: 'bypass', command: 'deleteStudent', payload: { studentId: 's1' } }), /统一业务写入口/)
  await assert.rejects(() => ui.runCommandSilent({ key: 'bypass', command: 'updateBookingContent', payload: {} }), /统一业务写入口/)
  seen.execute.length = 0
  const through = await mutate(null, null, { key: 'through', command: 'saveSettings', payload: { monthlyGoalSessions: 40 } })
  assert.ok(through && through.ok, '经由统一入口的写命令必须放行：' + JSON.stringify(through))
  assert.strictEqual(through.path, 'local-first', '本机先行命令经由统一入口的路径必须是 local-first')
  await assert.rejects(() => ui.runCommand({ key: 'bypass', command: 'deleteStudent', payload: { studentId: 's1' } }), /统一业务写入口/)
  ui.__writeFunnel.enforce(false)
  // 取样命令真的落进了持久队列（放行的证据不只是一句 ok）
  const queue = require('../utils/local-outbox')
  assert.ok(queue.count({ environment: 'production', datasetId: 'ds-prod' }) > 0, '经由统一入口的写命令必须真的入队')
  queue.clear({ environment: 'production', datasetId: 'ds-prod' })

  // ---------------------------------------------------------------- ④ 安全续跑走直通策略，语义逐字保留
  seen.execute.length = 0
  await mutate.raw('completeBooking', { bookingId: 'bk-1' }, { expectedRevision: 9 })
  assert.strictEqual(seen.execute[0].command, 'completeBooking')
  assert.strictEqual(seen.execute[0].options.expectedRevision, 9, '直通策略必须原样透传 expectedRevision（安全续跑的基线）')
  assert.ok(mutate.audit().some(item => item.command === 'completeBooking' && item.strategy === 'raw'))

  // ---------------------------------------------------------------- ⑤ 数据源决定权在统一入口（本机模式：云端零副作用）
  storage.coachDataSourceMode = 'local-primary'
  assert.strictEqual(mutate.executionPath(), 'local')
  seen.execute.length = 0
  mutate.clearAudit()
  let localRuns = 0
  const local = await mutate('deleteStudent', { studentId: 's1' }, { key: 'local', local: () => { localRuns++; return 'local-done' } })
  assert.strictEqual(localRuns, 1, '本机模式下必须执行传入的本机实现')
  assert.strictEqual(seen.execute.length, 0, '本机模式下云端一个字节都不许动')
  assert.strictEqual(local.local, true)
  assert.strictEqual(local.value, 'local-done')
  const skipped = await mutate('deleteStudent', { studentId: 's1' }, { key: 'local' })
  assert.strictEqual(skipped.skipped, true, '本机模式下没有本机实现时应当什么都不做（与旧行为一致）')
  assert.strictEqual(localRuns, 1)
  storage.coachDataSourceMode = 'cloud-primary'

  // ---------------------------------------------------------------- ⑥ 真实 UI：页面与组件都必须落进同一条路径
  let pageDefinition = null, componentDefinition = null
  global.Page = definition => { pageDefinition = definition }
  global.Component = definition => { componentDefinition = definition }
  require('../pages/students/students.js')
  require('../components/exercise-picker/exercise-picker.js')
  assert.ok(pageDefinition && componentDefinition)

  // 本机先行命令的目标必须真的在**本机快照**里 —— 否则本机事务会以业务错误码拒绝它
  // （这与云端会给出的答案一致：本机先行从不发明云端会拒绝的命令）。
  // 所以先把这位学员种进快照，再验「页面删学员」这条链路。
  storage.coachCloudActiveCache.snapshot.students = [{ id: 'stu-9', name: '被删学员', status: 'active', packages: [] }]
  await ui.adapter.readActive()
  const page = Object.assign({}, pageDefinition, { data: {}, setData() {}, render() {}, close() {} })
  // 上面的 ② 已经往本机队列里排了 13 条本机先行命令（探针载荷）。这里要单独验「页面删学员」这一条，
  // 所以先把队列跑干净、再清空观测，否则断言看到的是**队列里前面那几条**而不是本节的命令。
  await mutate.sync.flush()
  seen.execute.length = 0
  mutate.clearAudit()
  await page.removeStudentData('stu-9')
  // 阶段 2：删学员已是**本机先行**（「新增秒进 → 编辑秒改 → 删除秒删」的最后一环），
  // 与上面组件那条同构：①「经由统一入口」是同步事实，用审计钉死；②「真的出网」由同步引擎跑一轮收口。
  // 把两件事混成一条同步断言，测的就是事件循环的运气了 —— 而不是契约。
  assert.ok(mutate.audit().some(item => item.command === 'deleteStudent'), '页面删学员必须走统一入口')
  await mutate.sync.flush()
  assert.deepStrictEqual(seen.execute.map(item => item.command), ['deleteStudent'], '页面删学员必须真的送到云端')

  const component = Object.assign({}, componentDefinition.methods, { data: {}, setData() {}, refresh() {}, triggerEvent() {} })
  seen.execute.length = 0
  mutate.clearAudit()
  await component.deleteCustom({ currentTarget: { dataset: { index: 0 } } })
  // 阶段 2：这条命令是**本机先行** —— 先落本机 + 持久队列，到达云端是**后台异步**的（同步引擎在下一个
  // 事件循环里送）。所以分两步钉：①「必须经由统一入口」是同步事实，用审计钉死；
  // ②「必须真的被送到云端」由同步引擎跑一轮收口。把两件事混成一条同步断言，测的就是事件循环的运气了。
  assert.ok(mutate.audit().some(item => item.command === 'deleteCustomExercise'), '组件删自定义动作必须走统一入口')
  await mutate.sync.flush()
  assert.deepStrictEqual(seen.execute.map(item => item.command), ['deleteCustomExercise'], '组件删自定义动作必须真的送到云端')

  console.log(`mutate-write-surface tests passed (${mutate.COMMANDS.length} commands, ${uiFiles.length} UI sources)`)
})().catch(error => { console.error(error); process.exit(1) })
