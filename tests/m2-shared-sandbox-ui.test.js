// M2 第四批：Sandbox 真机验收入口（pages/sandbox-shared-test）永久回归。
//
// 这一批要钉住四件**互不相同**的事：
//   ① 纯函数真的算对（共享码规范化 / 默认 60 分钟 / availableToBook 公式与云端同口径）；
//   ② 页面确实把两条共享命令交给**统一写入口** mutate，且载荷里**绝不含**任何身份/定位字段；
//   ③ 页面只在 Sandbox 里可操作，读对端只用**零写入**的只读云函数；
//   ④ 它明确自称「临时 / 测试入口」并写明 M3 后下线 —— 防止以后被当成正式功能。
// ④ 不是文案洁癖：这个页面背后的共享码是**过渡期技术桥梁**，
//   正式产品模型是「会员靠微信身份认自己的课时、自己选 A/B/C 教练」。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')
const PAGE = 'pages/sandbox-shared-test/sandbox-shared-test'
const pageSource = read(`${PAGE}.js`)
const pageView = read(`${PAGE}.wxml`)
const pageStyle = read(`${PAGE}.wxss`)

// 静态断言**先剥注释**：注释里提到 ownerCoachId 不代表真的提交了它（她踩过这个坑）。
const codeOf = source => source.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// ─────────────────────────────────────────────────────────────── ① 纯函数
test('① 共享码规范化：大小写与空格都要能容错，格式非法要认出来', () => {
  const acceptance = require('../utils/m2-shared-acceptance')
  assert.strictEqual(acceptance.normalizeShareCode(' 9f2c1a7b03 '), '9F2C1A7B03')
  assert.strictEqual(acceptance.normalizeShareCode('A B C 1 2 3'), 'ABC123')
  assert.strictEqual(acceptance.validShareCode('ABC123'), true)
  assert.strictEqual(acceptance.validShareCode('abc123'), true, '小写输入必须也算合法（会被规范化）')
  assert.strictEqual(acceptance.validShareCode('ABC12'), false, '少于 6 位不合法')
  assert.strictEqual(acceptance.validShareCode('ABC-123'), false, '带连字符不合法')
  assert.strictEqual(acceptance.validShareCode('ABC 12345678901234567890123456789012345'), false, '超过 32 位不合法')
})

test('② 预计时长：不填就是 60，越界一律拒绝（与云端 occupancy 同口径）', () => {
  const acceptance = require('../utils/m2-shared-acceptance')
  const occupancy = require(path.join(root, 'cloudfunctions/coachBusinessCommand/occupancy.js'))
  assert.strictEqual(acceptance.plannedMinutesOf(''), 60)
  assert.strictEqual(acceptance.plannedMinutesOf(null), 60)
  assert.strictEqual(acceptance.plannedMinutesOf(undefined), 60)
  assert.strictEqual(acceptance.plannedMinutesOf('90'), 90)
  assert.strictEqual(acceptance.plannedMinutesOf(0), null, '0 分钟不是合法时长')
  assert.strictEqual(acceptance.plannedMinutesOf('1500'), null, '超过 1440 分钟不合法')
  assert.strictEqual(acceptance.plannedMinutesOf('abc'), null)
  assert.strictEqual(acceptance.DEFAULT_PLANNED_MINUTES, occupancy.DEFAULT_PLANNED_MINUTES, '默认时长必须与云端同一个常量')
})

test('③ availableToBook 与云端 occupancy **逐字同口径**（改了一边忘了另一边当场红）', () => {
  const acceptance = require('../utils/m2-shared-acceptance')
  const occupancy = require(path.join(root, 'cloudfunctions/coachBusinessCommand/occupancy.js'))
  const samples = [
    { remaining: 3, reserved: 1 }, { remaining: 1, reserved: 1 }, { remaining: 1, reserved: 0 },
    { remaining: 0, reserved: 0 }, { remaining: 5, reserved: 9 }, { remaining: 3 }, {}, { reserved: 2 }
  ]
  for (const sample of samples) {
    assert.strictEqual(acceptance.availableToBook(sample), occupancy.availableToBook(sample), `本机与云端口径不一致：${JSON.stringify(sample)}`)
    assert.strictEqual(acceptance.availableToBook(sample, 2), occupancy.availableToBook(sample, 2), `带 reservedOverride 时也不许漂：${JSON.stringify(sample)}`)
  }
  assert.strictEqual(acceptance.availableToBook({ remaining: 1, reserved: 5 }), 0, '绝不能为负 —— 负数等于允许超额')
})

test('④ 「没有复制到 B 账」的判据：排课前后学员/课时包/销售行数一条都不许涨', () => {
  const acceptance = require('../utils/m2-shared-acceptance')
  const before = acceptance.countsOf({ students: [{ packages: [{}, {}] }], sales: [{}, {}], incomes: [] })
  assert.deepStrictEqual(before, { students: 1, packages: 2, sales: 2, incomes: 0 })
  const clean = acceptance.countsDelta(before, { students: 1, packages: 2, sales: 2, incomes: 1 })
  assert.strictEqual(clean.copied, false, '收入增加是正常的（收入归授课教练），学员/课时包/销售没变就该判没复制')
  const copied = acceptance.countsDelta(before, { students: 2, packages: 3, sales: 3, incomes: 1 })
  assert.strictEqual(copied.copied, true, '只要复制了一份学员或课时包，就必须判为已复制')
})

test('⑤ 共享预约只认带 packageUsage 的那几条；错误码要给得出人话', () => {
  const acceptance = require('../utils/m2-shared-acceptance')
  const db = { bookings: [{ id: 'b1' }, { id: 'b2', packageUsage: { packageId: 'p9' } }, { id: 'b3', packageUsage: {} }] }
  assert.deepStrictEqual(acceptance.sharedBookingRows(db).map(row => row.id), ['b2'], '空 packageUsage 不算共享预约')
  assert.strictEqual(acceptance.hintOf('PACKAGE_NO_AVAILABLE').includes('最后一节'), true)
  assert.strictEqual(acceptance.hintOf('SHARE_SELF_NOT_ALLOWED').includes('两位不同'), true, '必须讲清楚 A/B 得是两个人')
  assert.strictEqual(acceptance.hintOf('SHARE_NOT_FOUND').length > 4, true)
  assert.notStrictEqual(acceptance.hintOf('SOME_NEW_CODE'), '未登记的错误码也必须回一句有用的话，不能回 undefined')
  const rule = require('../utils/request-id-rule')
  assert.strictEqual(rule.isLegalRequestId(acceptance.newRequestId('m2dshare')), true, '验收页自己造的 requestId 必须过服务端格式校验')
})

// ─────────────────────────────────────────────────────────────── ② 静态：安全与接线
test('⑥ 页面已注册、入口已挂上，且入口与页面都自称「临时 / 测试」', () => {
  const config = JSON.parse(read('app.json'))
  assert.ok(config.pages.includes(PAGE), '验收页必须注册（隐藏入口 ≠ 不注册）')
  const controlView = read('pages/sandbox-control/sandbox-control.wxml')
  assert.ok(controlView.includes(PAGE), '沙盒页必须有进入验收页的入口')
  assert.ok(/临时测试入口/.test(controlView), '入口必须写明是临时测试入口')
  assert.ok(/M3/.test(controlView) && /下线/.test(controlView), '入口必须写明 M3 上线后下线')
  assert.ok(/TEST · 临时共享入口/.test(pageView), '页面顶部必须打出 TEST 标记')
  assert.ok(/M3/.test(pageView) && /下线/.test(pageView), '页面必须写明 M3 上线后下线')
})

test('⑦ 两条共享命令都走统一写入口；载荷里绝不含身份 / 数据集定位字段', () => {
  const code = codeOf(pageSource)
  assert.ok(code.includes("require('../../utils/mutate')"), '验收页也必须走 utils/mutate.js')
  for (const command of ['setPackageShare', 'createSharedBooking']) {
    assert.ok(code.includes(`command: '${command}'`), `必须通过 mutate 发送 ${command}`)
  }
  // 客户端一旦能塞 ownerCoachId / datasetId / openId，就等于有了任意跨教练读取与写入能力。
  for (const key of ['ownerCoachId', 'datasetId', 'openId', 'OPENID', 'coachId']) {
    assert.ok(!new RegExp(`\\b${key}\\s*:`).test(code), `页面载荷不得出现 ${key}:（这是"客户端定位别人数据"的口子）`)
  }
})

test('⑧ 读对端只用零写入的只读云函数，且每次都显式带上 sandbox 环境', () => {
  const code = codeOf(pageSource)
  const calls = [...code.matchAll(/callFunction\s*\(\s*\{\s*name\s*:\s*'([^']+)'/g)].map(row => row[1])
  assert.ok(calls.length >= 2, '至少要有「查看共享课时」与「核对两侧」两次只读调用')
  // ⏱️ 2026-10-05：本页新增第 ⑤ 卡「课程提醒测试时钟」⇒ 多了一个直连函数。
  //    ⛔ 它是**测试区专属**的定时函数（`classReminderSandboxScheduler`），手动跑一次时不改任何业务数据；
  //       正式区那份函数里没有这个入口（tests/notify-acceptance-16.test.js 段 ⑰ 钉死）。
  assert.deepStrictEqual([...new Set(calls)].sort(), ['classReminderSandboxScheduler', 'diagnoseSharedUsage'],
    '本页只允许直连「只读取证」与「测试区课程提醒测试时钟」这两个函数')
  const actions = [...new Set([...code.matchAll(/action:\s*'([A-Za-z]+)'/g)].map(row => row[1]))].sort()
  assert.deepStrictEqual(actions, ['shareStateByCode', 'sharedBooking'], '只读取证动作面越界')
  const envCount = (code.match(/environment:\s*'sandbox'/g) || []).length
  assert.strictEqual(envCount, calls.length, '每一次只读取证都必须显式声明 sandbox（否则会去正式区查共享码）')
})

test('⑨ 非 Sandbox 不得操作：环境闸门必须真的存在', () => {
  const code = codeOf(pageSource)
  assert.ok(/runtime\.isSandbox\(\)/.test(code), '必须按运行时环境判定，不能只看页面在哪')
  assert.ok(/!sandbox/.test(pageView) || /wx:if="\{\{!sandbox\}\}"/.test(pageView), '非测试区必须给出"请先进入沙盒"的界面')
  assert.ok(/mutate\.isCloudWritePath\(\)/.test(code), '发命令前还必须确认写路径')
})

test('⑩ 不新建第二套 Design System：复用既有类，不自造 token', () => {
  for (const cls of ['class="page ', 'class="card"', 'btn primary', 'btn ghost', 'pill', 'label', 'input']) {
    assert.ok(pageView.includes(cls), `验收页必须复用既有样式类：${cls}`)
  }
  assert.ok(!/:root\s*\{/.test(pageStyle), '不得新定义 CSS 变量')
  assert.ok(!/page\s*\{\s*--/.test(pageStyle), '不得在 page 上新增设计 token')
  assert.ok(!/@font-face/.test(pageStyle), '不得引入新字体')
  // 沿用沙盒页已有的琥珀 TEST 色（#f59e0b / #7c3f00），不另起一套警告色。
  assert.ok(/#f59e0b/.test(pageStyle) && /#7c3f00/.test(pageStyle), 'TEST 提示必须沿用沙盒页既有琥珀色')
})

// ─────────────────────────────────────────────────────────────── ③ 行为：真跑页面对象
function withFakeWorld() {
  const seen = { toasts: [], modals: [], calls: [], cloud: [], navigate: [], clipboard: [] }
  const db = {
    students: [{ id: 's1', name: '小蓝', packages: [{ id: 'p1', type: '常规训练', remaining: 3, used: 1, reserved: 1, status: 'active' }] }],
    bookings: [{ id: 'b9', date: '2026-10-02', hour: 10, minute: 0, status: 'booked', packageUsage: { packageId: 'p1', studentId: 's1', ownerCoachId: 'A', datasetId: 'dsA' } }],
    incomes: [], sales: [{ id: 'sa1' }]
  }
  let sandbox = true
  global.wx = {
    getStorageSync: () => ({ datasetId: 'ds-sandbox-abcdef' }),
    setStorageSync: () => {},
    showToast: options => seen.toasts.push(options),
    showModal: options => seen.modals.push(options),
    showLoading: () => { seen.loading = (seen.loading || 0) + 1 },
    hideLoading: () => {},
    stopPullDownRefresh: () => {},
    navigateTo: options => seen.navigate.push(options.url),
    navigateBack: () => {},
    setClipboardData: options => seen.clipboard.push(options.data),
    cloud: {
      // 假件必须按 action 回**不同形状** —— 一律回同一个对象的话，"核对两侧"这条
      // 就算实现错了也测不出来（假件必须复现真服务端的读回形状）。
      callFunction: async options => {
        seen.cloud.push(options)
        if (options.data.action === 'shareStateByCode') {
          return { result: { ok: true, readOnly: true, action: 'shareStateByCode', minimal: true, active: true, status: 'active', dataRevision: 9, target: { found: true, remaining: 3, used: 1, reserved: 1 } } }
        }
        return {
          result: {
            ok: true, readOnly: true, action: 'sharedBooking',
            self: { dataRevision: 5, booking: { bookingId: 'b9', status: 'booked' }, receipt: { found: true, status: 'succeeded', command: 'createSharedBooking', revisionBefore: 4, revisionAfter: 5 } },
            peer: { found: true, dataRevision: 9, package: { packageId: 'p1', remaining: 3, used: 1, reserved: 2 }, receipt: { found: true, status: 'succeeded', command: 'sharedPackageSync', revisionBefore: 8, revisionAfter: 9 } },
            uniqueness: { bookingId: 1, packageId: 1, studentId: 1, saleId: 1 }
          }
        }
      }
    }
  }
  global.Page = config => { seen.config = config }
  // ★ 完课同步状态只依赖**本机队列**：假件必须能精确摆出「队列里有没有这条完课」，
  //   否则"已完成 / 完成同步中"这条判定在测试里永远是绿的（假件不具备判别力 ⇒ 判据形同不存在）。
  const outboxPath = require.resolve('../utils/local-outbox')
  const savedOutbox = require.cache[outboxPath]
  const outboxState = { entries: [], map: {} }
  require.cache[outboxPath] = { id: outboxPath, filename: outboxPath, loaded: true, exports: {
    openEntries: () => outboxState.entries,
    idMap: () => outboxState.map
  } }
  const runtimePath = require.resolve('../utils/data-runtime')
  const mutatePath = require.resolve('../utils/mutate')
  const savedRuntime = require.cache[runtimePath]
  const savedMutate = require.cache[mutatePath]
  require.cache[runtimePath] = { id: runtimePath, filename: runtimePath, loaded: true, exports: {
    SANDBOX_CACHE_KEY: 'coachSandboxActiveCache',
    CACHE_KEY: 'coachCloudActiveCache',
    MODES: { LOCAL: 'local-primary', CLOUD: 'cloud-primary' },
    isSandbox: () => sandbox,
    // ⭐ 数据源可观测三件套：页面会把它们印在「数据源与读取状态」卡上，假件必须提供。
    cacheKey: () => (sandbox ? 'coachSandboxActiveCache' : 'coachCloudActiveCache'),
    environment: () => (sandbox ? 'sandbox' : 'production'),
    mode: () => 'cloud-primary',
    getDB: () => (sandbox ? db : null)
  } }
  // mutate 在页面里的调用形态是 `mutate(null, null, {...})` ⇒ 假件本身必须**可调用**，
  // 同时挂上 isCloudWritePath（页面发命令前会问它）。只记录"页面到底把什么交给了统一写入口"。
  const fakeMutate = async (a, b, options) => { seen.calls.push(options); return { ok: true, result: { shareCode: 'A1B2C3D4E5', bookingId: 'bk1' } } }
  fakeMutate.isCloudWritePath = () => true
  require.cache[mutatePath] = { id: mutatePath, filename: mutatePath, loaded: true, exports: fakeMutate }
  delete require.cache[require.resolve(`../${PAGE}.js`)]
  require(`../${PAGE}.js`)
  const config = seen.config
  const restore = () => {
    delete require.cache[require.resolve(`../${PAGE}.js`)]
    if (savedOutbox) require.cache[outboxPath] = savedOutbox; else delete require.cache[outboxPath]
    if (savedRuntime) require.cache[runtimePath] = savedRuntime; else delete require.cache[runtimePath]
    if (savedMutate) require.cache[mutatePath] = savedMutate; else delete require.cache[mutatePath]
    delete global.Page
    delete global.wx
  }
  const instantiate = () => {
    const page = Object.assign({}, config)
    page.data = JSON.parse(JSON.stringify(config.data))
    page.setData = (patch, callback) => { Object.keys(patch || {}).forEach(key => { page.data[key] = patch[key] }); if (callback) callback() }
    return page
  }
  return { seen, instantiate, restore, setSandbox: value => { sandbox = value }, db,
    setOutbox: (entries, map) => { outboxState.entries = entries || []; outboxState.map = map || {} } }
}

test('⑪ 刷新：能列出本账课时包与共享预约，并显示"当前教练数据集尾号"', async () => {
  const world = withFakeWorld()
  try {
    const page = world.instantiate()
    await page.refresh()
    assert.strictEqual(page.data.sandbox, true)
    assert.strictEqual(page.data.datasetTail, 'abcdef', '顶部必须能看出"我现在是哪位教练"')
    assert.strictEqual(page.data.students.length, 1)
    assert.strictEqual(page.data.students[0].packages[0].availableToBook, 2, '还能约 = 剩余 3 − 已占 1')
    assert.strictEqual(page.data.sharedBookings.length, 1, '共享预约必须能被认出来')
    assert.strictEqual(page.data.sharedBookings[0].time, '10:00')
    assert.strictEqual(page.data.counts.sales, 1)
  } finally { world.restore() }
})

test('⑫ 非测试区：刷新后不列数据、不发任何命令', async () => {
  const world = withFakeWorld()
  try {
    world.setSandbox(false)
    const page = world.instantiate()
    await page.refresh()
    assert.strictEqual(page.data.sandbox, false)
    await page.genCode()
    assert.strictEqual(world.seen.calls.length, 0, '非测试区绝不能发出 setPackageShare')
    assert.strictEqual(world.seen.cloud.length, 0)
  } finally { world.restore() }
})

test('⑬ A 侧生成共享码：走统一写入口，载荷只有 packageId + enabled', async () => {
  const world = withFakeWorld()
  try {
    const page = world.instantiate()
    await page.refresh()
    await page.genCode()
    const sent = world.seen.calls[0]
    assert.ok(sent, '必须真的发出一条命令')
    assert.strictEqual(sent.command, 'setPackageShare')
    assert.deepStrictEqual(Object.keys(sent.payload).sort(), ['enabled', 'packageId'])
    assert.strictEqual(sent.payload.enabled, true)
    assert.strictEqual(page.data.shareCode, 'A1B2C3D4E5', '码要当场显示在页面上')
    assert.strictEqual(world.seen.cloud.length >= 1, true, '发码后应立刻回读一次这份共享课时')
    assert.strictEqual(world.seen.cloud[0].data.action, 'shareStateByCode')
    page.copyCode()
    assert.deepStrictEqual(world.seen.clipboard, ['A1B2C3D4E5'], '要能一键复制给另一位教练')
  } finally { world.restore() }
})

test('⑭ B 侧排课：默认 60 分钟、共享码规范化、载荷不含任何定位字段', async () => {
  const world = withFakeWorld()
  try {
    const page = world.instantiate()
    await page.refresh()
    page.onCodeInput({ detail: { value: ' 9f2c1a7b03 ' } })
    await page.lookupCode()
    page.setData({ date: '2026-10-05', hourIndex: 3, minuteIndex: 2 })
    await page.bookOnce()
    const sent = world.seen.calls[0]
    assert.strictEqual(sent.command, 'createSharedBooking')
    assert.deepStrictEqual(Object.keys(sent.payload).sort(), ['date', 'hour', 'minute', 'plannedMinutes', 'shareCode'])
    assert.strictEqual(sent.payload.shareCode, '9F2C1A7B03', '共享码必须被规范化成大写')
    assert.strictEqual(sent.payload.plannedMinutes, 60, '不填时长时默认 60')
    assert.strictEqual(sent.payload.date, '2026-10-05')
    assert.strictEqual(sent.payload.hour, 9, 'hours 数组从 6 点起，索引 3 = 9 点')
    assert.strictEqual(sent.payload.minute, 30)
    assert.ok(sent.requestId && sent.requestId.length >= 8, '必须带上自己的 requestId，事后才能查两侧回执')
  } finally { world.restore() }
})

test('⑮ 特殊时长可改；非法时长不许出网', async () => {
  const world = withFakeWorld()
  try {
    const page = world.instantiate()
    await page.refresh()
    page.onCodeInput({ detail: { value: 'ABC123' } })
    page.setData({ date: '2026-10-05', hourIndex: 0, minuteIndex: 0 })
    page.onPlanned({ detail: { value: '90' } })
    await page.bookOnce()
    assert.strictEqual(world.seen.calls[0].payload.plannedMinutes, 90, '特殊情况要能改成 90 分钟')
    // 非法时长：一次都不许出网（出网就是拿脏数据去撞服务端校验）。
    const before = world.seen.calls.length
    page.onPlanned({ detail: { value: '0' } })
    await page.bookOnce()
    assert.strictEqual(world.seen.calls.length, before, '时长非法时必须拦在出网之前')
    assert.ok(world.seen.toasts.some(row => /1–1440/.test(String(row.title))), '要给出人话提示')
  } finally { world.restore() }
})

test('⑯ 「再排一节」必须换一个时段 —— 否则会被时间冲突挡住，看不出是不是超额', async () => {
  const world = withFakeWorld()
  try {
    const page = world.instantiate()
    await page.refresh()
    page.onCodeInput({ detail: { value: 'ABC123' } })
    page.setData({ date: '2026-10-05', hourIndex: 3, minuteIndex: 0 })
    await page.bookOnce()
    const first = world.seen.calls[0].payload
    await page.bookAgain()
    const second = world.seen.calls[1].payload
    assert.notStrictEqual(`${second.date}:${second.hour}`, `${first.date}:${first.hour}`, '验收超额的第二次必须落在另一个时段')
    assert.strictEqual(second.hour, first.hour + 2)
  } finally { world.restore() }
})

test('⑰ 核对：用 sharedBooking 动作读两侧，且带上 sandbox 与 requestId', async () => {
  const world = withFakeWorld()
  try {
    const page = world.instantiate()
    await page.refresh()
    page.setData({ lastRequestId: 'm2dshare_1234567890' })
    await page.verifyLast()
    const call = world.seen.cloud[world.seen.cloud.length - 1]
    assert.strictEqual(call.name, 'diagnoseSharedUsage')
    assert.strictEqual(call.data.action, 'sharedBooking')
    assert.strictEqual(call.data.environment, 'sandbox')
    assert.strictEqual(call.data.bookingId, 'b9', '必须拿本侧那条共享预约去核')
    assert.strictEqual(call.data.requestId, 'm2dshare_1234567890')
    assert.ok(page.data.peerText.includes('课时包侧'), '核对结果要显示成能念出来的中文')
  } finally { world.restore() }
})

test('⑱ 从共享预约能直接跳进正常课程页（上课 / 待确认都在那里）', async () => {
  const world = withFakeWorld()
  try {
    const page = world.instantiate()
    await page.refresh()
    page.openBooking({ currentTarget: { dataset: { id: 'b9' } } })
    assert.deepStrictEqual(world.seen.navigate, ['/pages/session/session?id=b9'])
  } finally { world.restore() }
})

test('⑲ 不先「查看」直接排课：共享码也必须被规范化（不能原样出网）', async () => {
  const world = withFakeWorld()
  try {
    const page = world.instantiate()
    await page.refresh()
    page.onCodeInput({ detail: { value: ' 9f2c1a7b03 ' } })
    page.setData({ date: '2026-10-06', hourIndex: 1, minuteIndex: 0 })
    // 刻意**不**调用 lookupCode()：规范化必须是排课入口自己的责任，
    // 不能靠"先点查看把码擦干净"—— 少点一步就把小写空格码发出去了。
    await page.bookOnce()
    const sent = world.seen.calls[0]
    assert.ok(sent, '必须真的发出命令')
    assert.strictEqual(sent.payload.shareCode, '9F2C1A7B03', '排课入口自己就必须把码规范化')
  } finally { world.restore() }
})

// ─────────────────────────────────────────────────────────────── ④ 完课同步状态呈现（2026-09-28 真机）
//
// ⛳ 要钉住的事：本机投影会把**还没落云**的 completeBooking 渲染成 booking.status === 'done'，
//   而课时 / 收入只在云端事务里产生 ⇒ 界面绝不能把它写成普通「已完成」。
//   ⚠ 样本必须复现真机形状：booking 已经是 done（投影出来的）+ 队列里还躺着 completeBooking。

const COMPLETION_ENTRY = { entryId: 'e1', command: 'completeBooking', status: 'pending', payload: { bookingId: 'b9' } }

test('⑳ 纯函数：三档呈现 —— 同步中 / 异常 / 已完成，且异常档压过 done', () => {
  const acceptance = require('../utils/m2-shared-acceptance')
  assert.strictEqual(acceptance.bookingStatusText({ id: 'b9', status: 'done' }, {}), '已完成')
  assert.strictEqual(acceptance.bookingStatusText({ id: 'b9', status: 'done' }, { b9: 'syncing' }), '完成同步中',
    '本机投影出来的 done + 队列里还有完课 ⇒ 必须是「完成同步中」，绝不能是「已完成」')
  assert.strictEqual(acceptance.bookingStatusText({ id: 'b9', status: 'done' }, { b9: 'unknown' }), '完成同步异常',
    '结果未知时绝不能显示「已完成」——那是在替一个未知结果背书')
  assert.strictEqual(acceptance.bookingStatusText({ id: 'b9', status: 'booked' }, {}), '待上课')
  assert.strictEqual(acceptance.bookingStatusText({ id: 'b9', status: 'booked' }, { b9: 'syncing' }), '完成同步中')
})

test('㉑ completionSyncRows：只认 completeBooking，且能把本机临时 id 对齐到正式 id', () => {
  const acceptance = require('../utils/m2-shared-acceptance')
  const rows = acceptance.completionSyncRows([
    { command: 'completeBooking', status: 'pending', payload: { bookingId: 'loc_1' } },
    { command: 'updateBookingContent', status: 'pending', payload: { bookingId: 'b9' } },
    { command: 'completeBooking', status: 'unknown', payload: { bookingId: 'b9' } },
    { command: 'completeBooking', status: 'pending', payload: {} }
  ], { loc_1: 'b9' })
  assert.strictEqual(rows.b9, 'unknown', '同一条 booking 上 unknown 必须压过 pending（更不确定的那一档胜出）')
  assert.strictEqual(Object.keys(rows).length, 1, '内容类命令与没有 bookingId 的条目都不许污染这张表')
})

test('㉒ 页面：本地已投影成 done 但完课还没落云 ⇒ 显示「完成同步中」，绝不显示「已完成」', async () => {
  const world = withFakeWorld()
  try {
    world.db.bookings[0].status = 'done'          // 本机投影出来的 done
    world.setOutbox([COMPLETION_ENTRY], {})
    const page = world.instantiate()
    await page.refresh()
    const row = page.data.sharedBookings[0]
    assert.strictEqual(row.statusText, '完成同步中')
    assert.notStrictEqual(row.statusText, '已完成', '云端还没确认就写「已完成」，正是本次要修的误报')
    assert.strictEqual(row.syncPending, true, '要给模板一个可样式化的标记')
  } finally { world.restore() }
})

test('㉓ 页面：完课结果未知（unknown）⇒ 显示「完成同步异常」，绝不显示「已完成」', async () => {
  const world = withFakeWorld()
  try {
    world.db.bookings[0].status = 'done'
    world.setOutbox([{ entryId: 'e2', command: 'completeBooking', status: 'unknown', payload: { bookingId: 'b9' } }], {})
    const page = world.instantiate()
    await page.refresh()
    const row = page.data.sharedBookings[0]
    assert.strictEqual(row.statusText, '完成同步异常')
    assert.strictEqual(row.syncFailed, true)
  } finally { world.restore() }
})

test('㉔ 页面：队列已清空 + 云端 done ⇒ 「已完成」；队列有别的命令不影响这一条', async () => {
  const world = withFakeWorld()
  try {
    world.db.bookings[0].status = 'done'
    world.setOutbox([{ entryId: 'e3', command: 'updateBookingContent', status: 'pending', payload: { bookingId: 'b9' } }], {})
    const page = world.instantiate()
    await page.refresh()
    assert.strictEqual(page.data.sharedBookings[0].statusText, '已完成', '未落定的**内容**命令不代表完课没落定')
    world.setOutbox([], {})
    await page.refresh()
    assert.strictEqual(page.data.sharedBookings[0].statusText, '已完成')
    assert.strictEqual(page.data.sharedBookings[0].syncPending, false)
  } finally { world.restore() }
})

test('㉕ 本轮不改变课时口径：还能约仍然是 max(剩余 − 已占, 0)，包 id 照旧印出来', async () => {
  const world = withFakeWorld()
  try {
    world.setOutbox([COMPLETION_ENTRY], {})
    const page = world.instantiate()
    await page.refresh()
    const pkg = page.data.students[0].packages[0]
    assert.strictEqual(pkg.remaining, 3)
    assert.strictEqual(pkg.reserved, 1)
    assert.strictEqual(pkg.availableToBook, 2, '还能约 = 3 − 1，本轮不得改动占用规则')
    assert.strictEqual(pkg.used, 1)
    assert.ok(page.data.selectedIdsText.includes('p1'), '包的 id 必须仍然印在页面上，否则两条数字链无法证明指向同一行')
  } finally { world.restore() }
})

async function main() {
  for (const item of tests) await item.fn()
  console.log(`m2 shared sandbox ui: ${tests.length}/${tests.length} PASS`)
}
main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1 })
