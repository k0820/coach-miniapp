// 「下课 + 自动复制课程内容」= 用户点**一次**就完成的完整动作（1.1.9）。
//
// 用户的要求（逐条钉在这里）：
//   · 点一次下课就够，不要求用户再点"复制"；
//   · 只有「核心完课结果正确」**并且**「剪贴板确认写入成功」之后，UI 才显示这次操作成功；
//   · 剪贴板第一次调用异常，绝不能把整件事伪装成成功；
//   · 复制失败**绝不能**再执行一次 completeBooking（不许重复扣课、重复收入）；
//   · 核心完课已成功、复制阶段暂时没确认成功 → 安全地保持「正在完成下课操作」的状态，
//     只重试/恢复复制阶段；页面退出、重复点击都不得造成二次完课；
//   · 无论复制阶段发生什么：课时最多扣一次、收入最多一笔、completeBooking 最多一次业务事实；
//   · UI 显示"下课完成"时，课程内容必须**已经真的**进了剪贴板。
//
// 全部跑真实模块（真 session 页面 / 真 mutate / 真 outbox / 真 sync-engine / 真 cloud-command-engine），
// 只有"云"是 InMemoryCommandEngine（与真实云函数同构的纯业务引擎）。
// 剪贴板桩严格复现平台回调形状 —— 这是本组断言能成立的前提：
// 一个"从不回调"的桩会让"复制到底成没成"永远没有答案，契约缺陷就会在测试里永远绿。
const assert = require('assert')
const { createWorld, loadSessionPage, settle } = require('./helpers/local-first-world')
const outbox = require('../utils/local-outbox')
const sync = require('../utils/sync-engine')
const completionCopy = require('../utils/completion-copy')

const scope = { environment: 'production', datasetId: 'ds-test' }
const bookingId = 'course-119'
const seed = () => ({
  students: [{ id: 'fake-student', name: '假学员', status: 'active', packages: [{ id: 'exact-package', type: '常规训练', price: 100, total: 8, used: 1, remaining: 7, status: 'active' }] }],
  bookings: [{ id: bookingId, studentId: 'fake-student', studentName: '假学员', packageId: 'exact-package', date: '2026-09-18', hour: 9, minute: 30, typeName: '常规训练', price: 100, status: 'booked', items: [] }],
  incomes: [], sales: [], settings: {}, customExercises: []
})
const items = [{ name: '高位下拉', group: '背', sets: 4, reps: 12, weight: 35 }]
// ⑦⑧ 里要直接在"云端"提交完课，而常规课程完课的服务端安全门要求这条 booking 已经有训练动作
// （TRAINING_ITEMS_REQUIRED），所以这两处用一份"内容已经在云端"的种子。
const seedWithItems = () => {
  const state = seed()
  state.bookings[0].items = items.slice()
  state.bookings[0].category = '背部训练'
  return state
}
const pending = () => completionCopy.list(scope.environment, scope.datasetId)
const commandsOf = () => outbox.list(scope).map(row => row.command)
const toastTitles = world => world.counters.toasts.map(row => String(row.title || ''))
const modalTexts = world => world.counters.modals.map(row => `${String(row.title || '')} ${String(row.content || '')}`)

async function driveCompletion(world) {
  const page = loadSessionPage()
  page.onLoad({ id: bookingId })
  page.onShow()
  page.setData({ items, groupSections: [], notes: '课后备注', category: '背部训练', duration: 60 })
  page.queueDraft()
  const handle = await page.complete()
  const result = handle && handle.settled ? await handle.settled : handle
  return { page, result }
}

// ——————————————————————————————————————————————————————————————
// ① 一次点击 = 完课 + 复制；成功提示只出现在剪贴板确认之后
// ——————————————————————————————————————————————————————————————
async function onceClickCompletesAndCopies() {
  const world = createWorld(); world.seed(seed()); world.online = false
  const timeline = [], copied = []
  global.wx.setClipboardData = options => { timeline.push('clipboard'); copied.push(String(options.data)); if (options && options.success) options.success({}) }
  const pushModal = global.wx.showModal
  global.wx.showModal = options => { if (String(options && options.title).includes('本节训练已记录')) timeline.push('success'); pushModal(options) }

  const { result } = await driveCompletion(world)
  assert.equal(result.code, 'COMPLETED_LOCAL_FIRST', '本机先行完课必须成功')
  assert.equal(result.copy.ok, true, '复制阶段必须成功')
  assert.deepStrictEqual(timeline, ['clipboard', 'success'],
    '成功提示必须出现在剪贴板确认**之后**（顺序反了就等于"先报成功、再复制"）')
  assert.ok(modalTexts(world).some(text => text.includes('本节训练已记录') && text.includes('课程内容已复制')), '必须用关心弹窗明确告诉用户这次完整操作成功了')

  // 复制文本：**逐字等于事务算出来的那一份**课程内容（不许有第二套摘要格式），且**不含学员姓名**
  assert.equal(copied.length, 1, '一次点击只写一次剪贴板')
  const projected = world.localDB().bookings.find(row => row.id === bookingId)
  assert.ok(projected && projected.summary, '完课必须在本机投影里留下事务算出来的摘要')
  assert.equal(copied[0], projected.summary,
    '复制文本必须逐字等于事务摘要 —— 不许有第二套摘要格式，也不再前缀学员姓名，实得：\n' + copied[0])
  // ★ 1.1.9 第 7 轮：正式聊天里不出现学员姓名。去掉姓名之后**第一行就是日期/星期**，
  //   而日期 / 星期 / 时间 / 训练部位 / 动作 / 组数次数 / 备注的格式一个字都没改（下面两条继续钉住）。
  assert.equal(copied[0].includes('假学员'), false, '★ 复制文本不得出现学员姓名，实得：\n' + copied[0])
  assert.ok(/^⏰ \d+月\d+日 星期[日一二三四五六]/.test(copied[0].split('\n')[0]),
    '第一行必须是日期/星期，实得 ' + JSON.stringify(copied[0].split('\n')[0]))
  assert.ok(copied[0].includes('高位下拉 · 4组×12次 · 35kg'), '动作行必须与事务生成的摘要同格式')
  assert.ok(copied[0].includes('备注：课后备注'), '备注必须带出来')

  // 复制阶段不产生任何业务命令
  assert.deepStrictEqual(commandsOf(), ['updateBookingContent', 'completeBooking'], '复制绝不允许产生额外云命令')
  assert.equal(pending().length, 0, '复制确认成功后待复制记录必须撤掉')

  world.online = true; await sync.flush(); await settle(60)
  assert.equal(world.snapshot().incomes.length, 1, '收入恰好一笔')
  assert.equal(world.snapshot().students[0].packages[0].remaining, 6, '课时恰好扣一节')
  assert.equal(world.commandsSeen.filter(name => name === 'completeBooking').length, 1)
}

// ——————————————————————————————————————————————————————————————
// ② 剪贴板第一次异常：不伪装成功、内部重试，且**只有一次业务事实**
// ——————————————————————————————————————————————————————————————
async function clipboardFirstFailureIsRetriedInternally() {
  const world = createWorld(); world.seed(seed()); world.online = false
  let calls = 0, delivered = 0
  global.wx.setClipboardData = options => {
    calls += 1
    if (calls === 1) { if (options && options.fail) options.fail({ errMsg: 'setClipboardData:fail 模拟一次系统异常' }); return }
    delivered += 1
    if (options && options.success) options.success({})
  }
  const { result } = await driveCompletion(world)
  assert.ok(calls >= 2, '第一次异常必须**内部**重试，而不是把补救动作甩给用户（实得尝试 ' + calls + ' 次）')
  assert.equal(result.copy.ok, true, '重试成功之后这次操作才算完整成功')
  assert.ok(modalTexts(world).some(text => text.includes('课程内容已复制')))
  assert.equal(delivered, 1, '只有一次真的写进去了')
  assert.deepStrictEqual(commandsOf(), ['updateBookingContent', 'completeBooking'], '复制重试不得产生任何新命令')

  world.online = true; await sync.flush(); await settle(60)
  assert.equal(world.commandsSeen.filter(name => name === 'completeBooking').length, 1, '完课命令仍然只有一次')
  assert.equal(world.snapshot().incomes.length, 1, '收入仍然只有一笔')
  assert.equal(world.snapshot().students[0].packages[0].remaining, 6, '课时仍然只扣一节')
}

// ——————————————————————————————————————————————————————————————
// ③ 剪贴板彻底失败：不显示成功、保持"正在完成下课操作"、只恢复复制阶段
// ——————————————————————————————————————————————————————————————
async function clipboardNeverWorksKeepsOperationPending() {
  const world = createWorld(); world.seed(seed()); world.online = false
  global.wx.setClipboardData = options => { if (options && options.fail) options.fail({ errMsg: 'CLIPBOARD_FAIL' }) }
  const { result } = await driveCompletion(world)
  assert.equal(result.copy.ok, false, '复制没成功就绝不允许把这次操作报成成功')
  const prompts = modalTexts(world)
  assert.equal(prompts.some(text => text.includes('课程内容已复制')), false, '复制失败绝不能说已经复制成功')
  assert.ok(prompts.some(text => text.includes('后台复制')), '要如实告诉用户：课程已完成、内容还在复制，实得 ' + JSON.stringify(prompts))
  assert.equal(prompts.some(text => text.includes('课程未完成')), false, '复制没成功不得弹任何"课程未完成"这类误报框')

  // 「正在完成下课操作」的状态必须留在磁盘上 —— 它就是"这次下课还没完整完成"
  const rows = pending()
  assert.equal(rows.length, 1, '待复制记录必须持久保留')
  assert.equal(rows[0].copyKey, bookingId)
  assert.ok(rows[0].attempts >= 3, '一次点击内必须已经试过有界重试，实得 attempts=' + rows[0].attempts)
  assert.ok(String(rows[0].text).includes('高位下拉'), '待复制记录里存的是完课那一刻的同一份内容')

  assert.deepStrictEqual(commandsOf(), ['updateBookingContent', 'completeBooking'], '复制失败阶段同样不得产生任何新命令')
  world.online = true; await sync.flush(); await settle(60)
  assert.equal(world.snapshot().incomes.length, 1, '收入最多一笔')
  assert.equal(world.snapshot().students[0].packages[0].remaining, 6, '课时最多扣一次')
  assert.equal(world.commandsSeen.filter(name => name === 'completeBooking').length, 1, '完课命令最多一次')

  // 恢复轮（下一次页面显示时）：只补复制，绝不重做完课
  const writes = []
  global.wx.setClipboardData = options => { writes.push(String(options.data)); if (options && options.success) options.success({}) }
  const resumed = await completionCopy.resumePending(scope.environment, scope.datasetId)
  assert.equal(resumed.copied.length, 1, '恢复轮必须把内容补进剪贴板')
  assert.ok(writes[0].includes('高位下拉'), '恢复用的是完课那一刻存下来的同一份内容')
  assert.equal(pending().length, 0, '补成功之后状态才清掉 —— 这时"下课操作"才真正完整完成')
  assert.equal(world.commandsSeen.filter(name => name === 'completeBooking').length, 1, '恢复阶段绝不允许再发一次完课命令')
  assert.equal(world.snapshot().students[0].packages[0].remaining, 6, '恢复阶段绝不重复扣课')
  await sync.flush(); await settle(40)
  assert.equal(world.snapshot().incomes.length, 1)
}

// ——————————————————————————————————————————————————————————————
// ④ 重复点击 + 页面退出：仍然只有一次业务事实
// ——————————————————————————————————————————————————————————————
async function repeatedClicksAndPageExitStaySingle() {
  const world = createWorld(); world.seed(seed()); world.online = false
  const writes = []
  global.wx.setClipboardData = options => { writes.push(String(options.data)); if (options && options.success) options.success({}) }
  const page = loadSessionPage()
  page.onLoad({ id: bookingId }); page.onShow()
  page.setData({ items, groupSections: [], notes: '', category: '背部训练', duration: 60 })
  page.queueDraft()
  const first = await page.complete()
  const second = await page.complete()
  const third = await page.complete()
  assert.strictEqual(second, first,
    '★ 链还在跑时再点一次必须**复用同一条链**（1.1.9 第 2 轮改的就是这条：旧行为是静默 return undefined —— '
    + '用户点了、界面什么都没发生，也没有任何人把这条链跑完，唯一出路是"再点一次"）')
  assert.strictEqual(third, first, '连点同样复用同一条链，绝对不许新开第二轮')
  await first.settled
  // 「第一帧回到课表」是排在一个宏任务里的（setTimeout 0）：纯微任务链不会让它跑，
  // 所以这里必须真的把事件循环让出去一次再断言。
  await settle(5)
  // 页面在第一帧就回到课表（用户的既定体验），后端链路继续跑完
  assert.ok(world.counters.back >= 1, '下课后第一帧必须回到课表')
  // 链已结束、本机也已经生效之后再点一次：只记一条诊断，绝不再开第二轮
  const again = await page.complete()
  assert.equal(again && again.code, 'ALREADY_DONE',
    '已经完成的课再点下课不许新开一轮（那会白跑一次注定被拒的命令），实得 ' + JSON.stringify(again && again.code))
  assert.equal(again && again.noop, true, '这一路必须是明确的 no-op，而且留了诊断记录')

  world.online = true; await sync.flush(); await settle(60)
  assert.equal(world.commandsSeen.filter(name => name === 'completeBooking').length, 1, '重复点击后完课命令仍然只有一次')
  assert.equal(world.snapshot().incomes.length, 1, '收入只有一笔')
  assert.equal(world.snapshot().students[0].packages[0].remaining, 6, '课时只扣一节')
  assert.equal(world.commandsSeen.filter(name => name === 'updateBookingContent').length, 1, '训练内容也只提交一次')
  assert.ok(writes.length >= 1, '页面退出不影响复制阶段完成')
  assert.equal(pending().length, 0, '页面退出后复制阶段仍然确认成功')
}

// ——————————————————————————————————————————————————————————————
// ⑤ 结构契约：复制阶段不允许出现任何业务命令调用点
// ——————————————————————————————————————————————————————————————
function copyStageCannotTouchBusiness() {
  const fs = require('fs')
  const path = require('path')
  const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'completion-copy.js'), 'utf8')
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')
  assert.equal(/require\(['"][^'"]*(mutate|local-outbox|sync-engine|ui-cloud-command)[^'"]*['"]\)/.test(bare), false,
    '复制阶段模块不许 require 任何业务写链路 —— 拿不到写入口，就不可能重跑完课')
  assert.equal(/completeBooking/.test(bare), false, '复制阶段模块里不许出现 completeBooking')
  const session = fs.readFileSync(path.join(__dirname, '..', 'pages', 'session', 'session.js'), 'utf8')
  const settle = /settleCompletionCopy\(\{[^}]*\}\)\s*\{([\s\S]*?)\n  \},/.exec(session)
  assert.ok(settle, '找不到 settleCompletionCopy')
  assert.equal(/mutate\(/.test(settle[1]), false, '复制阶段绝不允许再调用 mutate（那就是重跑完课的路）')
}

// ——————————————————————————————————————————————————————————————
// ⑥ 平台根本没有剪贴板接口 = 确定性失败 → 只试一次，不空转退避
// ——————————————————————————————————————————————————————————————
// 判别力说明：修前 `flush` 不看失败原因，一律跑满 3 次 + 120/320ms 退避
// （对"接口根本不存在"这种结果永远不变的失败，纯属空转，还把整条完成链多跨两个定时器，
//  在真机上表现为下课之后约 0.44 秒里复制阶段还挂着一轮注定失败的循环）。
// 这条断言只看 attempts：修前 3、修后 1 —— 是"这一列有判别力"的那种断言。
// 同时钉住：确定性失败**不等于**放弃 —— 记录照留，恢复轮仍然能补上。
async function missingClipboardApiFailsFastWithoutSpinning() {
  const world = createWorld(); world.seed(seed()); world.online = false
  global.wx.setClipboardData = undefined
  const { result } = await driveCompletion(world)
  assert.equal(result.copy.ok, false, '平台没有剪贴板接口时，这次操作不允许被报成成功')
  assert.equal(result.copy.code, 'CLIPBOARD_UNAVAILABLE', '失败原因必须如实是"接口不可用"')
  const rows = pending()
  assert.equal(rows.length, 1, '确定性失败同样要保留"这次下课还没完整完成"的状态')
  assert.equal(rows[0].attempts, 1, '确定性失败只允许试一次（修前会空转 3 次），实得 attempts=' + rows[0].attempts)
  assert.deepStrictEqual(commandsOf(), ['updateBookingContent', 'completeBooking'], '复制阶段不得产生任何新命令')

  // 恢复轮：接口恢复可用之后，下一次页面显示必须把内容补进去（不甩给用户）
  const writes = []
  global.wx.setClipboardData = options => { writes.push(String(options.data)); if (options && options.success) options.success({}) }
  const resumed = await completionCopy.resumePending(scope.environment, scope.datasetId)
  assert.equal(resumed.copied.length, 1, '恢复轮必须补上')
  assert.ok(writes[0].includes('高位下拉'))
  assert.equal(pending().length, 0, '补成功后状态才清掉')
  world.online = true; await sync.flush(); await settle(60)
  assert.equal(world.snapshot().students[0].packages[0].remaining, 6, '全程课时只扣一节')
  assert.equal(world.snapshot().incomes.length, 1, '全程收入只有一笔')
}

// ——————————————————————————————————————————————————————————————
// ⑦ 有完课意图但链不在本页 → 复用（只查回执 + 重同步 + 补复制），绝不重发完课
// ——————————————————————————————————————————————————————————————
// 判别力：修前这一路是**静默 return** —— 用户点了没反应，复制也永远补不上。
// 而且"复用到底该做什么"从代码上看不出来，所以这里把安全边界一起钉死：
// 只许查回执，**绝不许**重新执行 completeBooking（号码虽然一样，但"永远不可能有第二条业务事实"
// 比"少一次重试"重要得多）。
async function existingIntentIsReusedInsteadOfResent() {
  const world = createWorld(); world.seed(seedWithItems()); world.online = true
  const pendingCompletion = require('../utils/pending-completion')
  const trace = require('../utils/completion-trace')
  const writes = []
  global.wx.setClipboardData = options => { writes.push(String(options.data)); if (options && options.success) options.success({}) }

  // 前提条件（直接构造，不依赖别的用例）：云端那条完课命令**已经**提交成功 ——
  // 走的是真实业务引擎，所以它给出的 receipt 与真云端同构。
  const requestId = 'req-fixed-119'
  const cloud = world.engine.execute({ ownerCoachId: 'coach-owner' }, { command: 'completeBooking', requestId, expectedRevision: world.revision(), payload: { bookingId } })
  assert.equal(cloud.ok, true, '前提条件：云端这条完课命令必须真的成功')
  // 本机留着「已点过下课、结果还没落地」的意图：有意图，但**本页没有在跑的链**。
  pendingCompletion.begin(scope.environment, scope.datasetId, bookingId, '', () => requestId, Date.now())
  assert.ok(pendingCompletion.get(scope.environment, scope.datasetId, bookingId), '前提条件：本机必须已经有完课意图')

  const page = loadSessionPage()
  page.onLoad({ id: bookingId }); page.onShow()
  page.setData({ items, notes: '课后备注', category: '背部训练', duration: 60 })
  assert.equal(page.data.completionPending, true, '课程页必须从本机意图认出"这门课已经点过下课"')

  const handle = await page.complete()
  assert.ok(handle && handle.settled, '★ 有在途完课意图时再点下课**不许静默丢掉**，实得 ' + JSON.stringify(handle))
  assert.equal(handle.reused, true, '这一路必须是明确的"复用"，而不是新开一轮')
  const result = await handle.settled
  assert.equal(result.code, 'REUSED_RECEIPT_SUCCEEDED', '回执已成功 → 复用必须收敛成成功，实得 ' + result.code)
  assert.ok(result.copy && result.copy.ok === true, '复用之后必须把复制阶段补完（用户不需要再点任何东西）')
  assert.ok(modalTexts(world).some(text => text.includes('课程内容已复制')), '两者都完成后才显示成功关心弹窗')
  assert.equal(pendingCompletion.get(scope.environment, scope.datasetId, bookingId), null, '回执确认成功之后意图才清掉')
  assert.ok(writes.length >= 1 && writes[0].includes('高位下拉'), '复用补的是同一份课程内容')

  // ★ 核心安全契约：复用绝不允许重新执行完课
  assert.equal(world.commandsSeen.filter(name => name === 'completeBooking').length, 0,
    '★ 复用路径绝不允许重新执行 completeBooking —— 一旦重发，这里立刻变红')
  assert.ok(world.counters.receipts >= 1, '复用必须靠**查回执**来定论')

  const last = trace.list().slice(-1)[0]
  assert.equal(last.branch, 'REUSED_RECEIPT_SUCCEEDED', '诊断账本必须指出这一跳走的是"复用回执"')
  assert.equal(last.skipped, 'NO_NEW_COMMAND', '诊断账本必须显示这一跳没有发新命令')
}

// ——————————————————————————————————————————————————————————————
// ⑧ 诊断账本：一次点击停在哪个 branch，必须能被**直接读出来**
// ——————————————————————————————————————————————————————————————
// 这是第 2 轮真机验收的前提。上一轮「第一次点下课没完成」只能靠读代码推理，
// 而推理出的结论（某个安全门拒绝）拿不到现场证据 —— 既不能当根因，也不能据此改代码。
// 现在每个出口都落一条**定长**记录（字段集合与顺序完全一样、缺的写 null），
// 下一轮真机直接把账本读出来按列看就能定位。
async function completionLedgerPinsTheBranch() {
  const trace = require('../utils/completion-trace')

  // 场景 A：平台根本没有剪贴板接口（确定性失败，连调用都没发生）
  const world = createWorld(); world.seed(seed()); world.online = false
  global.wx.setClipboardData = undefined
  const first = await driveCompletion(world)
  assert.equal(first.result.copy.ok, false, '前提：这一跳的复制阶段必须失败')
  const rows = trace.list()
  assert.ok(rows.length >= 1, '每一次下课点击都必须留一条记录')
  const last = rows.slice(-1)[0]
  assert.equal(last.branch, 'COMPLETED_LOCAL_FIRST',
    '★ 账本必须直接指出这一跳的具体出口（完课成功、卡在复制阶段），实得 ' + last.branch)
  assert.equal(last.localTxApplied, true, '账本必须显示本机的完课事实已经成立')
  assert.equal(last.packageDelta, 1, '账本必须显示课时恰好扣了 1 节（多扣一节会在这里露出来）')
  assert.equal(last.incomeCreated, 1, '账本必须显示收入恰好新增 1 笔')
  assert.equal(last.summaryCreated, true, '账本必须显示这门课是在这一跳才第一次有了 summary')
  assert.equal(last.clipboardCalled, false, '平台没有这个接口 ⇒ 剪贴板调用**没有发生**（必须与"调用了但失败"分得开）')
  assert.equal(last.clipboardOk, false, '剪贴板没有确认成功')
  assert.equal(last.waitedOfficialMs, 0, '这一跳不需要等正式 id')
  assert.ok(Number.isFinite(last.durationMs) && last.durationMs >= 0, '账本必须带这一跳的总耗时')
  assert.deepStrictEqual(Object.keys(last), trace.FIELDS,
    '★ 账本必须是**定长**的：字段集合与顺序完全一样，真机上才能按列读')
  assert.ok(rows.every(row => JSON.stringify(Object.keys(row)) === JSON.stringify(trace.FIELDS)), '历史记录的字段形状也必须一致')
  assert.ok(rows.length <= trace.LIMIT, '账本必须有界，不许无限增长')

  // 场景 B：剪贴板**调用了但失败** —— 与场景 A 成对照，`clipboardCalled` 这一列才有判别力
  const world2 = createWorld(); world2.seed(seed()); world2.online = false
  global.wx.setClipboardData = options => { if (options && options.fail) options.fail({ errMsg: 'CLIPBOARD_FAIL' }) }
  await driveCompletion(world2)
  const rows2 = trace.list()
  assert.equal(rows2.length, 1, '换一台机器就是一本新账本（按机器隔离）')
  assert.equal(rows2[0].clipboardCalled, true, '这一跳剪贴板**确实调用了**（与场景 A 对照）')
  assert.equal(rows2[0].clipboardOk, false, '但它没有成功')
  assert.equal(rows2[0].branch, 'COMPLETED_LOCAL_FIRST', '失败发生在复制阶段，branch 必须如实指向完课那一跳')
  assert.equal(rows2[0].packageDelta, 1, '复制失败绝不能带来第二次扣课')
  assert.equal(rows2[0].incomeCreated, 1, '复制失败绝不能带来第二笔收入')

  // 场景 C：在途完课意图被复用 ⇒ 账本必须显示"没有发新命令"
  const world3 = createWorld(); world3.seed(seedWithItems()); world3.online = true
  const pendingCompletion = require('../utils/pending-completion')
  global.wx.setClipboardData = options => { if (options && options.success) options.success({}) }
  const requestId = 'req-fixed-119-ledger'
  world3.engine.execute({ ownerCoachId: 'coach-owner' }, { command: 'completeBooking', requestId, expectedRevision: world3.revision(), payload: { bookingId } })
  pendingCompletion.begin(scope.environment, scope.datasetId, bookingId, '', () => requestId, Date.now())
  const page = loadSessionPage()
  page.onLoad({ id: bookingId }); page.onShow()
  page.setData({ items, notes: '', category: '背部训练', duration: 60 })
  const handle = await page.complete()
  await handle.settled
  const rows3 = trace.list()
  assert.equal(rows3.length, 2, '账本里应是这一跳的两条：这次点击被"已有链"接住 + 复用回执收敛')
  assert.equal(rows3[0].branch, 'REUSED_CHAIN', '先记下"这次点击被已有链接住了"')
  assert.equal(rows3[0].skipped, 'TAP_GUARD', '并且标明它没有新开一轮')
  const hop = rows3.slice(-1)[0]
  assert.equal(hop.branch, 'REUSED_RECEIPT_SUCCEEDED', '账本必须记下"复用回执"这一路')
  assert.equal(hop.skipped, 'NO_NEW_COMMAND', '账本必须记下"这一跳没发新命令"')
  assert.equal(hop.waitedOfficialMs, 0, '复用不需要等正式 id')
  assert.equal(hop.requestId, requestId, '账本里的 requestId 必须是那枚**固定**的号 —— 它是"没有换号重发"的凭据')
}

async function main() {
  await onceClickCompletesAndCopies()
  await clipboardFirstFailureIsRetriedInternally()
  await clipboardNeverWorksKeepsOperationPending()
  await repeatedClicksAndPageExitStaySingle()
  await missingClipboardApiFailsFastWithoutSpinning()
  await existingIntentIsReusedInsteadOfResent()
  await completionLedgerPinsTheBranch()
  copyStageCannotTouchBusiness()
  console.log('session complete + copy: PASS（一次点击=完课+复制；链在跑时复用同一条链、有意图时只查回执绝不重发；'
    + '复制失败不伪装成功、只恢复复制；确定性失败不空转；课时/收入/完课事实各最多一次；诊断账本定长可读）')
}
main().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 })
