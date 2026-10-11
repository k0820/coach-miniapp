// 会员「点确认预约 ⇒ 多久看到反馈」专项测试（2026-10-01 真机：提交约 2 秒）
//
// ⛔ 本文件钉的是**两件必须分开说的事**（用户要求 ⑧）—— 混着讲就会出现"我改快了但用户还是说慢"：
//   ① **界面响应时间**：手指离开屏幕 ⇒ 屏幕上出现明确状态。这段**完全由前端决定**，必须贴近 0；
//   ② **云端确认时间**：真实网络往返 + 云函数执行。这段**改不了**，也不许拿本地回声冒充成功。
//
// 真机基线（改前，同一把尺子量出来的）：
//   · 界面第一帧只有按钮自己的 loading（页面内容没变）；
//   · 成功后还 `await` 了一趟整页刷新 ⇒ 写完还要再等一次往返，期间页面挂著「正在核对最新排课…」。
//
// 手法（沿用 `member-write-latency.test.js` 的老办法）：给每趟云调用**人为加固定延迟**
//   ⇒ 局域网里的假世界也能量出"谁在关键路径上"。
//   ⚠️ 延迟是**刻度**，不是真机毫秒数（真机还要另加网关 / 冷启动 / 真实网络）。
//
// ⛔ 判别力：见 `tests/_member-submit-feedback-mutate.js`（故意改错 ⇒ 本文件必须变红）。

const assert = require('assert')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const memberBooking = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
const cloudOccupancy = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/occupancy'))
const beijingDate = require(path.join(ROOT, 'utils/beijing-date'))
// ⭐ 2026-10-05：本文件在**测试区**跑（下面 setEnvironment(SANDBOX)）⇒ 客户端发的是测试区专用的那个云函数。
const BUSINESS_FN = require(path.join(ROOT, 'utils/sandbox-cloud-functions')).businessFunction('sandbox')
const { createWorld, runner } = require('./helpers/m2-business-world')

const CLAIMS = 'member_sandbox_student_claims'
const CLOCK0 = 1900000000000
const TODAY = memberBooking.beijingDateKey(CLOCK0)
// ⛔ 客户端预检（未来 30 天）与服务端终判必须看同一本日历 ⇒ 把会员端的"今天"也钉到假世界那一天。
beijingDate.todayKey = () => TODAY
const DATE_IN = cloudOccupancy.addDateDays(TODAY, 3)

// ⭐ 刻度：每趟云调用人为延迟多久（**只为了让瓶颈可辨**，不代表真机毫秒）
const WRITE_LATENCY_MS = 700
const READ_LATENCY_MS = 900        // ⭐ 故意比写还慢 ⇒ 成功若还"快"，就证明它真的不在关键路径上
const UI_BUDGET_MS = 60            // 界面第一帧：本机渲染，不该超过一帧的预算
const CONFIRM_BUDGET_MS = WRITE_LATENCY_MS + 250  // 云端确认：不该被那趟 900ms 的回读拖过去

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const world = createWorld()
const storage = {}
let cloudCalls = []
let modals = []
let patches = []
let t0 = Date.now()
let member = null

const coachKeyOf = coachId => memberBooking.fixedId('member-coach-view', coachId)
const packageViewIdOf = (claimId, packageId) => memberBooking.fixedId('member-package-view', claimId, packageId)

function installRuntime() {
  global.wx = {
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value },
    cloud: {
      callFunction: async ({ name, data }) => {
        cloudCalls.push({ name, action: data.action, at: Date.now() - t0 })
        if (name === BUSINESS_FN && data.action === 'memberRead') {
          await sleep(READ_LATENCY_MS)
          return { result: { ok: true, environment: data.environment, availability: true, state: 'ready', dataRevision: 9, member: {}, date: '', coaches: [], packages: [], bookings: [], own: [], busy: [], archives: [], warnings: [] } }
        }
        if (name === BUSINESS_FN) {
          world.setOpenId('open-m1')
          await sleep(WRITE_LATENCY_MS)
          return { result: await world.main()(data) }
        }
        if (name === 'readMyMemberData') {
          await sleep(READ_LATENCY_MS)
          return { result: { ok: true, environment: data.environment, availability: true, state: 'ready', dataRevision: 9, member: {}, date: '', coaches: [], packages: [], bookings: [], own: [], busy: [], archives: [], warnings: [] } }
        }
        return { result: { ok: true } }
      }
    },
    showToast: () => {},
    showModal: options => modals.push({ title: options && options.title, text: `${options && options.title || ''}${options && options.content || ''}`, at: Date.now() - t0 }),
    navigateTo: () => {}, requestSubscribeMessage: () => {}
  }
  for (const key of Object.keys(require.cache)) {
    if (key.includes('utils/member-runtime') || key.includes('utils/data-runtime') || key.includes('utils/release-flags')) delete require.cache[key]
  }
  const runtime = require(path.join(ROOT, 'utils/data-runtime'))
  runtime.setEnvironment(runtime.ENVIRONMENTS.SANDBOX)
  member = require(path.join(ROOT, 'utils/member-runtime'))
}

let A, claim1, PKG
const SLOT_KEY = `${DATE_IN}#10:00`

function setup() {
  world.reset()
  cloudCalls = []
  modals = []
  patches = []
  for (const key of Object.keys(storage)) delete storage[key]
  A = world.seedCoach('open-a', 'ds-a', 'PUBA')
  world.seedStudent(A, 'stu-a', '会员甲')
  world.put('packages', world.businessId('packages', A.owner, A.datasetId, 'pkg-a'), {
    ownerCoachId: A.owner, datasetId: A.datasetId, packageId: 'pkg-a', studentId: 'stu-a',
    data: { id: 'pkg-a', type: '常规训练', total: 10, remaining: 8, used: 1, reserved: 0, reservedVersion: 2, price: 300, status: 'active' }
  })
  const memberId = memberBooking.memberIdFor('open-m1')
  const claimId = memberBooking.fixedId(CLAIMS, A.owner, 'stu-a')
  world.put(CLAIMS, claimId, { claimId, memberId, coachId: A.owner, studentId: 'stu-a', status: 'verified' })
  claim1 = { memberId, claimId, studentId: 'stu-a' }
  PKG = 'pkg-a'
  memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
  installRuntime()
}

function buildPage() {
  let captured = null
  global.Page = options => { captured = options }
  const full = require.resolve(path.join(ROOT, 'pages/member-book-slots/member-book-slots'))
  delete require.cache[full]
  require(full)
  const page = Object.assign({}, captured, { data: JSON.parse(JSON.stringify(captured.data)) })
  page.setData = function (patch) { Object.assign(this.data, patch); patches.push({ patch: Object.keys(patch), at: Date.now() - t0 }) }
  page.data.dates = [{ index: 0, key: DATE_IN, label: '三天后' }]
  page.data.dateIndex = 0
  page.data.coaches = [{ coachKey: coachKeyOf(A.owner), displayName: '甲教练' }]
  page.data.packages = [{ packageViewId: packageViewIdOf(claim1.claimId, PKG), typeName: '常规训练', availableToBook: 2, coachKeys: [coachKeyOf(A.owner)] }]
  page.data.slots = [
    { key: SLOT_KEY, start: 600, end: 660, label: '10:00–11:00', available: true },
    { key: `${DATE_IN}#14:00`, start: 840, end: 900, label: '14:00–15:00', available: true }
  ]
  page.data.selected = page.data.slots[0]
  page.data.confirmOpen = true
  captured.pickSlot.call(page, { currentTarget: { dataset: { key: SLOT_KEY } } })
  return page
}

const slotIn = page => (page.data.slots || []).find(row => row.key === SLOT_KEY)
const bookingCount = () => world.rows('bookings', A.owner, A.datasetId).length

async function main() {
  // ------------------------------------------------------------ ① 界面响应时间
  await runner('① ⭐ 点下去**同一帧**就有反馈：那一格立刻变成「正在占」（不等任何云调用）', async () => {
    setup()
    const page = buildPage()
    patches = []        // ⛔ 只统计"点确认之后"的界面变化（buildPage 里那次 pickSlot 不算）
    t0 = Date.now()
    const running = page.submit()
    await sleep(0)
    const first = patches.length ? patches[0] : null
    assert.ok(first, '⛔ 提交期间界面没有任何变化 ⇒ 用户只能干等（真机"2 秒"的第一层原因）')
    assert.ok(first.at < UI_BUDGET_MS, `第一帧用了 ${first.at}ms ⇒ 超过了本机渲染预算 ${UI_BUDGET_MS}ms`)
    assert.ok(first.patch.indexOf('slots') >= 0, '第一帧必须改的是**页面内容**（那一格本身），不只是按钮自己的 loading')
    assert.strictEqual(slotIn(page).available, false, '那一格必须立刻标成占住')
    assert.strictEqual(slotIn(page).reasonText, '正在占', '⛔ 文案必须是"还在占" —— 不许让读者理解成已成功')
    // ⭐ 2026-10-03 补：画面真正渲染的是 `{{stateText}}`（reasonText 是老消费者读的字段）。
    //    只断言 reasonText ⇒ 有人只改 `stateText`（用户看见的就是「已排课」）也照样绿。
    assert.strictEqual(slotIn(page).stateText, '正在占',
      '⛔ 画面读的那个字段（stateText）也必须是"还在占"')
    assert.ok(String(page.data.submitNote || '').length > 0, '必须有一句明写"还在确认"的话')
    await running
  })

  // ------------------------------------------------------------ ② 不许提前报成功
  await runner('② ⛔ 云端没回来之前，**绝不**出现「预约成功」（也不许出现任何读起来像成功的话）', async () => {
    setup()
    const page = buildPage()
    t0 = Date.now()
    const running = page.submit()
    await sleep(WRITE_LATENCY_MS - 200)          // ⭐ 此时写还没回来
    assert.strictEqual(modals.length, 0, `云端还没回，已经弹了窗：${JSON.stringify(modals)}`)
    const text = `${page.data.submitNote}`
    assert.ok(text.indexOf('成功') < 0, '等待文案不许出现"成功"')
    assert.ok(text.indexOf('已排') < 0, '等待文案不许出现"已排"')
    assert.strictEqual(slotIn(page).reasonText, '正在占', '等待期间那一格仍是"正在占"，不是"已排课"')
    assert.strictEqual(slotIn(page).stateText, '正在占',
      '画面读的字段（stateText）在等待期间也不许提前变成「已排课」')
    await running
  })

  // ------------------------------------------------------------ ③ 成功不被"提交后整页刷新"拖住
  await runner('③ ⭐ 成功**不等**提交后的整页刷新（回读故意拖到 900ms ⇒ 成功必须在写的时间附近就到）', async () => {
    setup()
    const page = buildPage()
    t0 = Date.now()
    const started = Date.now()
    await page.submit()
    const settledAt = Date.now() - started
    // ⭐ 整条提交流程（含收尾）都不许被那趟回读拖过去 ⇒ 这才是"提交后整页刷新已移出"的硬证据。
    assert.ok(settledAt < CONFIRM_BUDGET_MS,
      `submit() 用了 ${settledAt}ms 才收工 ⇒ 成功之后还在等那趟 ${READ_LATENCY_MS}ms 的整页刷新`)
    assert.strictEqual(modals.length, 1, '必须弹且只弹一次')
    assert.strictEqual(modals[0].title, '预约成功')
    assert.ok(modals[0].at < CONFIRM_BUDGET_MS,
      `成功弹窗出现在 ${modals[0].at}ms ⇒ 还在等那趟 ${READ_LATENCY_MS}ms 的回读（整页刷新没真正移出关键路径）`)
    const writes = cloudCalls.filter(row => row.name === BUSINESS_FN && row.action !== 'memberRead').length
    const reads = cloudCalls.filter(row => row.name === 'readMyMemberData' || row.action === 'memberRead').length
    assert.strictEqual(writes, 1, '关键路径上只有 1 趟写（不许重复提交）')
    // ⛔ 改前是 2 趟读（页面 force 刷新 + runtime 后台对账同时发）⇒ 现在只允许后台那一趟
    assert.ok(reads <= 1, `提交后出现了 ${reads} 趟整页回读 ⇒ 重复读取没消除干净`)
    // 后台那趟**照旧会跑完**（「我的预约」下次进屏就是新的）
    await member.pendingReconcile()
    assert.strictEqual((member.cached() || {}).dataRevision, 9, '后台对账必须真的刷新了缓存')
  })

  // ------------------------------------------------------------ ④ 成功后本机立刻看到那一节
  await runner('④ 成功当帧页面上这一节就已经是「已排课」（不用再等一趟网才看得见）', async () => {
    setup()
    const page = buildPage()
    t0 = Date.now()
    await page.submit()
    assert.strictEqual(slotIn(page).available, false)
    assert.strictEqual(slotIn(page).reasonText, '已排课')
    assert.strictEqual(slotIn(page).stateText, '已排课',
      '画面读的字段（stateText）也必须跟着"转正" —— 否则那一格会一直写着「正在占」')
    assert.strictEqual(slotIn(page).echo, true, '标记为本地回声 ⇒ 下一趟服务端结果会整份覆盖它')
    assert.strictEqual(bookingCount(), 1, '云端**真的**建好了这一节（不是界面对话）')
  })

  // ------------------------------------------------------------ ⑤ 失败 ⇒ 立刻收回回声
  await runner('⑤ ⛔ 提交失败 ⇒ **立刻撤回**那一格的"已排课"（不许留着一个没约上的假成功）', async () => {
    setup()
    const page = buildPage()
    t0 = Date.now()
    // 让云端拒绝：**这位教练没有授课授权**（客户端预检只看"标识非空" ⇒ 会照常发出去 ⇒ 由服务端终判）
    page.data.coaches = [{ coachKey: 'k-not-authorized', displayName: '未授权教练' }]
    page.data.coachIndex = 0
    page.data.packages = [{ packageViewId: packageViewIdOf(claim1.claimId, PKG), typeName: '常规训练', availableToBook: 2, coachKeys: ['k-not-authorized'] }]
    page.submitRequest = null
    page.data.selected = page.data.slots[0]
    await page.submit()
    const failure = modals[modals.length - 1]
    assert.ok(failure && failure.title !== '预约成功', `失败也必须明说，不许弹成功：${JSON.stringify(modals)}`)
    const slot = slotIn(page) || page.data.slots[0]
    assert.strictEqual(slot.available, true, '⛔ 失败没收回回声 ⇒ 界面留着一个其实没约上的"已排课"')
    assert.strictEqual(slot.echo, undefined)
    assert.strictEqual(bookingCount(), 0, '失败 ⇒ 云端一条都没建')
  })

  // ------------------------------------------------------------ ⑥ 防重复提交 / 幂等仍在
  await runner('⑥ ⛔ 连点两次确认 ⇒ 只发**一趟**写（两道锁都还在，云端幂等不受影响）', async () => {
    setup()
    const page = buildPage()
    t0 = Date.now()
    const first = page.submit()
    const second = await page.submit()   // ⭐ 不等第一趟返回，立刻再点一次
    assert.ok(second && second.ok === false, '第二下必须被挡住')
    assert.strictEqual(second.code, 'MEMBER_BOOKING_SUBMITTING', '⛔ 挡住的必须是实例锁（不是界面那道 ⇒ 直接调方法也拦得住）')
    const results = await Promise.all([first, second])
    assert.ok(results[0] && results[0].ok, '第一次必须成功')
    assert.strictEqual(cloudCalls.filter(row => row.name === BUSINESS_FN && row.action !== 'memberRead').length, 1, '⛔ 发出了 2 趟写 ⇒ 重复提交保护失效')
    assert.strictEqual(bookingCount(), 1, '只落一条预约（扣一次课时）')
  })

  // ------------------------------------------------------------ ⑦ 时间冲突 / 课时包权限没被削弱
  await runner('⑦ ⛔ 抢时间仍然被服务端挡住：本地回声**绝不会**替它放行', async () => {
    setup()
    const page = buildPage()
    t0 = Date.now()
    await page.submit()
    assert.strictEqual(bookingCount(), 1)
    // 同一个时段再来一次（换一个 requestId ⇒ 不是幂等重放，是一次全新的请求）
    page.submitRequest = null
    page.data.slots = [
      { key: SLOT_KEY, start: 600, end: 660, available: false, reason: 'booked', reasonText: '已排课', echo: true },
      { key: `${DATE_IN}#10:30`, start: 630, end: 690, available: true }
    ]
    page.data.selected = page.data.slots[1]
    const second = await page.submit()
    assert.ok(second, '第二次提交必须真的发出去（不许被本地状态挡下）')
    assert.strictEqual(bookingCount(), 1, '时段冲突 ⇒ 必须被服务端挡住，只落一条')
    assert.ok(modals.some(row => row.title !== '预约成功'), '被挡住时必须明说原因')
  })

  // ------------------------------------------------------------ ⑧ 口径诚实
  await runner('⑧ 页面不许把"本地回声"写成"已经成功"：成功话术只有一处、且只在服务端 ok 之后', async () => {
    const pageSource = require('fs').readFileSync(path.join(ROOT, 'pages/member-book-slots/member-book-slots.js'), 'utf8')
    const successUses = (pageSource.match(/requestBuilder\.SUCCESS_TITLE/g) || []).length
    assert.strictEqual(successUses, 1, '⛔ 成功话术只能出现在一处（多了就是别的地方也在偷偷报成功）')
    const start = pageSource.indexOf('async runSubmit(request) {')
    const body = pageSource.slice(start, pageSource.indexOf('\n  },', start))
    assert.ok(body.indexOf('SUCCESS_TITLE') > body.indexOf('result && result.ok'),
      '⛔ 成功弹窗必须写在"服务端返回 ok"之后（不是之前、也不是无条件）')
    assert.ok(!body.includes('await this.refresh({ force: true })'), '⛔ 成功之后不许再等整页刷新')
  })
}

main().catch(error => { console.error('测试自身出错：', error); process.exitCode = 1 })
