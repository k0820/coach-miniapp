// M2 V1 真机 BUG 03 **二次失败**（2026-09-28）：云端投影已经修好、全量回归 126/126 也全绿，
// B 手机重新部署 + 重新上传体验版之后，点「确认排课」**仍然**是「排课未成功 · packageId不能为空」。
//
// ★★ 真机操作（本文件逐字复现）★★
//   B 手机 → 学员列表里那位跨教练会员 → 打开只读详情 → 排课
//   → 默认选中常规训练（不额外点课包）→ 直接确认排课 ⇒ 报 packageId 不能为空。
//
// ★★ 本次根因 ★★
//   上一轮只修了**云端投影**，没管**客户端那一帧缓存**：
//   `utils/coach-authorization.js` 的缓存**既没有形状版本、也从不清空**，而上传新版客户端
//   不会清空 Storage ⇒ B 手机上那份"修复前写入的旧帧"（课包有 type/remaining，没有 packageId）
//   一直被当成有效事实。页面进入走的是 `loadDirectory({force:false})` ⇒ 命中旧帧 ⇒
//   **一次云调用都不发** ⇒ 课包列表照样渲染得出「常规训练」，提交时 packageId 是空。
//   ⇒ 判据：云端新代码**不可能**产出"有 type、没 packageId"的课包（`!projected.packageId` 会 continue），
//      真机上却出现了这种课包 ⇒ 那一帧只能来自旧缓存。
//
// ⭐⭐ 2026-10-06：出口换了，缓存那一帧**还是同一份** ⭐⭐
//   旧工作台 `pages/coach-authorization` 已随认领方案下线；跨教练排课现在走**学员列表页**，
//   而学员列表读的仍然是 `utils/coach-authorization.js` 的**同一帧缓存**（onShow 零云调用）。
//   ⇒ 「形状闸 + 内容闸」这两把锁一条都不能松：松了就是真机上"课包看得见、点了说不能"。
//
// 覆盖：① 旧帧被判为不可用 ② 带旧帧进页面 ⇒ 自愈并真的读一次云端
//       ③ 默认选中带着真实 packageId ④ 排课成功且 A/B 同一份余额（5/1/4）
//       ⑤ 缓存被重写成新形状 ⑥ 云端版本水印可判部署版本 ⑦ 断网 + 旧帧 ⇒ 明确拒绝、零发送
//       ⑧ 抹掉 packageId ⇒ 明确拒绝、零发送 ⑨ 不复制会员 / 课包 / 销售
//       ⑩ 形状版本不匹配（内容完整）也必须重读 —— 证明"形状闸"不是摆设
//       ⑪ 内容闸独立有效（形状对、内容缺 ID 也不许用）⑫ 进页面时断网、恢复后点排课必须自愈。

const assert = require('assert')
const { DIRECTORY_SHAPE } = require('../cloudfunctions/coachBusinessCommand/authorization')
const authorization = require('../utils/coach-authorization')
const { createStudentsBookingWorld, test } = require('./helpers/students-booking-world')

const world = createStudentsBookingWorld()
const copy = world.copy

// ⛔ 写旧帧时必须带上"这是 B 自己那一帧"：
//    · 不带身份 ⇒ 测的就不再是 BUG03 的形状自愈，而是"没身份的帧一律不给用"（那是另一个专项测试）；
//    · 带错身份 ⇒ 测的是"别人的帧不许命中"（同样不是这一段要钉的事）。
//    ⇒ 上面三个是**三种不同的故障**，必须各测各的，不能混在一帧里说不清楚。
function putOwnCacheFrame(owner, frame) {
  world.storage[authorization.identityKey('sandbox')] = { environment: 'sandbox', coachId: owner, savedAt: Date.now() }
  const key = authorization.cacheKey('sandbox', owner)
  world.storage[key] = Object.assign({ environment: 'sandbox', coachId: owner }, frame)
  return world.storage[key]
}
const ownCacheFrame = owner => world.storage[authorization.cacheKey('sandbox', owner)]
// ⭐ 真机上 B 手机里躺着的就是这一帧：**修复前的旧客户端写进去的**，
//    课包只有 type / remaining / availableToBook，**没有 packageId**，缓存行也**没有 shape**。
function oldCacheFrame(studentId) {
  return {
    environment: 'sandbox', savedAt: Date.now() - 86400000,
    data: {
      serving: [{
        studentId, memberId: '', name: '跨教练排课测试会员', phone: '13800138000',
        place: { ownerCoachId: 'legacy-owner', datasetId: 'ds-a' }, managedByMe: false,
        packages: [{ type: '常规训练', total: 5, remaining: 5, used: 0, reserved: 0, availableToBook: 5, status: 'active', canManage: false }],
        upcoming: [], history: []
      }],
      managed: [], truncated: false
    }
  }
}
// 摆好旧帧之后**再**进页面（真机形状：Storage 里躺着旧帧，用户直接进学员列表）。
async function enterWithOldFrame(coach) {
  world.setActor(coach)
  world.openId = coach.open
  world.installRuntime(coach)
  putOwnCacheFrame(coach.owner, oldCacheFrame('stu-1'))
  const page = world.enterPage()
  await page.onShow()
  await page.refreshAuthorized()
  return page
}
const authorizedCard = page => (page.data.students || []).find(item => item && item.authorized)

;(async () => {
  // ————— ① 旧缓存帧必须被判为"不能拿去排课"
  await test('① 旧形状缓存帧：形状闸 + 内容闸都必须判它不可用', async () => {
    const frame = oldCacheFrame('stu-1')
    assert.equal(authorization.directoryUsable(frame.data), false, '缺 packageId 的课包 ⇒ 目录内容不合格')
    assert.equal(authorization.cacheUsable(frame), false, '没有 shape ⇒ 缓存行不合格')
    const good = copy(frame)
    good.shape = authorization.CACHE_SHAPE
    good.data.serving[0].packages[0].packageId = 'pkg-real'
    assert.equal(authorization.cacheUsable(good), true)
  })

  // ————— ② 带旧帧进入页面（真机就是这样进的）⇒ 必须真的读一次云端，不允许命中旧帧
  await test('② 带旧缓存进学员页：不命中旧帧，真的发一次云端读取', async () => {
    world.reset()
    const { B } = await world.seedSharedScenario()
    const page = await enterWithOldFrame(B)
    assert.ok(world.cloudCalls.some(item => item.data && item.data.action === 'authorization'), `必须真的读一次云端（实测 ${JSON.stringify(world.cloudCalls)}）`)
    const card = authorizedCard(page)
    assert.ok(card, '自愈之后这位会员必须出现在学员列表里')
    assert.ok(card.packages[0].packageId, `自愈后课包必须带真实 ID（实测 ${JSON.stringify(card.packages[0])}）`)
  })

  // ————— ③ 真机操作全链：默认选中常规训练 → 不额外点 → 直接确认排课 ⇒ 成功
  await test('③ 真机全链（旧缓存 → 默认选中 → 直接确认）：payload 带真实 packageId 且排课成功', async () => {
    world.reset()
    const { A, B, packageId } = await world.seedSharedScenario()
    const page = await enterWithOldFrame(B)
    const booking = world.openBooking(page)
    assert.equal(booking.packageId, packageId, `默认选中必须带着真实 packageId（实测 ${JSON.stringify(booking)}）`)
    await page.confirmBooking()
    const sent = world.calls.find(item => item.command === 'createAuthorizedBooking')
    assert.ok(sent, '页面必须真的发出 createAuthorizedBooking')
    assert.equal(sent.payload.packageId, packageId, `payload 必须携带真实 packageId（实测 ${JSON.stringify(sent.payload)}）`)
    assert.ok(!world.modals.length, `不该弹错（实测 ${JSON.stringify(world.modals)}）`)
    assert.deepStrictEqual(world.occOf(A, packageId), { remaining: 5, reserved: 1, availableToBook: 4 }, 'A/B 必须是同一份真值')
  })

  // ————— ④ 旧帧必须被新帧替换掉（形状版本写进缓存）
  await test('④ 排课成功后：本地缓存被重写成当前形状（旧帧不再留存）', async () => {
    world.reset()
    const { B, packageId } = await world.seedSharedScenario()
    const page = await enterWithOldFrame(B)
    world.openBooking(page)
    await page.confirmBooking()
    const row = ownCacheFrame(B.owner)
    assert.ok(row, '必须写过缓存')
    assert.equal(row.shape, authorization.CACHE_SHAPE, `缓存必须带当前形状版本（实测 ${row.shape}）`)
    assert.equal(row.cloudShape, DIRECTORY_SHAPE, '缓存必须记下云端版本水印')
    assert.equal(row.data.serving[0].packages[0].packageId, packageId)
    assert.equal(authorization.cacheUsable(row), true)
  })

  // ————— ⑤ 云端版本水印：一眼核对"云函数有没有更新到这一版"
  await test('⑤ 云端版本水印：新版 m2-dir-2 / 旧版云函数看得出来', async () => {
    world.reset()
    const { B } = await world.seedSharedScenario()
    // 云函数与客户端是两份代码、不能共享常量 ⇒ 用一条契约钉住"两边写的是同一个版本"。
    assert.equal(authorization.EXPECTED_CLOUD_SHAPE, DIRECTORY_SHAPE, '客户端期望的云端版本必须与云函数下发的一致')
    world.setActor(B)
    world.openId = B.open
    world.installRuntime(B)
    const fresh = await authorization.loadDirectory({ force: true })
    assert.equal(fresh.ok, true, JSON.stringify(fresh))
    assert.equal(ownCacheFrame(B.owner).cloudShape, DIRECTORY_SHAPE, `新云函数必须写下版本水印（实测 ${ownCacheFrame(B.owner).cloudShape}）`)
    // 旧版云函数：响应里根本没有 shape ⇒ 水印必须如实显示"旧版"，且**不等于**课包标识缺失。
    assert.equal(authorization.shapeText({ shape: '' }), authorization.STALE_SHAPE_TEXT, '没有水印必须如实显示旧版')
    world.setCloudMode('stripShape')
    const stale = await authorization.loadDirectory({ force: true })
    assert.equal(stale.ok, true, JSON.stringify(stale))
    assert.equal(ownCacheFrame(B.owner).cloudShape, '', `旧版云函数不写水印（实测 ${ownCacheFrame(B.owner).cloudShape}）`)
    assert.equal(authorization.cacheUsable(ownCacheFrame(B.owner)), true, '水印缺失不等于课包标识缺失 ⇒ 这一帧仍然可用')
    world.setCloudMode('ok')
  })

  // ————— ⑥ 断网 + 旧帧：必须明确拒绝，一条命令都不许发
  await test('⑥ 读不到云端且本地是旧帧：明确拒绝排课，零发送', async () => {
    world.reset()
    const { B } = await world.seedSharedScenario()
    world.setActor(B)
    world.openId = B.open
    world.installRuntime(B)
    putOwnCacheFrame(B.owner, oldCacheFrame('stu-1'))
    world.setCloudMode('offline')
    const page = world.enterPage()
    await page.onShow()
    await page.refreshAuthorized()
    // ① 卡片照旧显示（⛔ 不许因为读不到就把会员整张卡藏掉 —— 那是另一种静默）。
    assert.ok(authorizedCard(page), '会员卡不许被藏掉')
    // ② 但这一帧必须被**标成陈旧**，且界面上要说出来（学员页顶部那行 hint）。
    assert.equal(page.data.authorizedStale, true, '⛔ 旧帧必须被标成"陈旧"（展示可以、排课不行）')
    // ③ 拿它去排课 ⇒ 明确拒绝 + 零发送（这就是真机上"课包看得见、点了说不能"的那一格）。
    world.openBooking(page)
    assert.ok(world.modals.length, `必须弹出明确的提示，不许静默什么都不做（实测 ${JSON.stringify(world.modals)}）`)
    assert.ok(/刷新/.test(world.modals[0].content), `要告诉用户怎么修（实测 ${world.modals[0].content}）`)
    assert.equal(world.calls.filter(item => item.command === 'createAuthorizedBooking').length, 0, '不许带着空 packageId 出网')
    world.setCloudMode('ok')
  })

  // ————— ⑦ 抹掉 packageId 后确认：明确拒绝，零发送（不许猜 ID）
  await test('⑦ 提交用 packageId 被抹空：明确拒绝，零发送', async () => {
    world.reset()
    const { B } = await world.seedSharedScenario()
    const page = await world.openAs(B)
    world.openBooking(page)
    page.setData({ 'booking.packageId': '' })
    await page.confirmBooking()
    assert.ok(world.toasts.length || world.modals.length, '必须明确失败，不许静默')
    assert.equal(world.calls.filter(item => item.command === 'createAuthorizedBooking').length, 0, '不许带着空 packageId 出网')
  })

  // ————— ⑧ 全程不产生第二份会员 / 课包 / 余额 / 销售
  await test('⑧ 自愈后排课：B 账里仍然没有复制出来的会员 / 课时包 / 销售', async () => {
    world.reset()
    const { B } = await world.seedSharedScenario()
    const page = await enterWithOldFrame(B)
    world.openBooking(page)
    await page.confirmBooking()
    assert.equal(world.rows('students', B.owner, B.datasetId).length, 0, '不许复制会员')
    assert.equal(world.rows('packages', B.owner, B.datasetId).length, 0, '不许产生第二份课时包 / 余额')
    assert.equal(world.rows('sales', B.owner, B.datasetId).length, 0, '销售业绩不转移到 B')
  })

  // ————— ⑨ 形状版本不匹配但内容完整：也必须重读（形状闸不是摆设，缺它就会吃旧帧）
  await test('⑨ 缓存形状版本不匹配（内容完整）：不许命中缓存，必须重读云端', async () => {
    world.reset()
    const { B } = await world.seedSharedScenario()
    world.setActor(B)
    world.openId = B.open
    world.installRuntime(B)
    const directory = await world.readDirectory(B)
    assert.equal(directory.ok, true, JSON.stringify(directory))
    putOwnCacheFrame(B.owner, { savedAt: Date.now(), shape: 'm2-dir-cache-1', data: directory })
    assert.equal(authorization.directoryUsable(directory), true, '这一帧内容本身是合格的（只差形状版本）')
    const before = world.cloudCalls.length
    const result = await authorization.loadDirectory({})
    assert.equal(result.cached, false, `形状不对 ⇒ 不许命中缓存（实测 ${JSON.stringify(result)}）`)
    assert.equal(world.cloudCalls.length, before + 1, '必须真的读一次云端')
  })

  // ————— ⑩ 内容闸独立有效：形状对、课包缺 packageId ⇒ 不许用
  await test('⑩ 形状对但课包缺 packageId：内容闸必须独立判它不可用', async () => {
    world.reset()
    const { B } = await world.seedSharedScenario()
    world.setActor(B)
    world.openId = B.open
    world.installRuntime(B)
    const frame = oldCacheFrame('stu-1')
    frame.shape = authorization.CACHE_SHAPE
    putOwnCacheFrame(B.owner, frame)
    assert.equal(authorization.cacheUsable(frame), false, '内容闸必须拦住它')
    const before = world.cloudCalls.length
    const result = await authorization.loadDirectory({})
    assert.equal(result.cached, false, '不许命中这一帧')
    assert.equal(world.cloudCalls.length, before + 1, '必须真的读一次云端')
    const page = await world.enterPage()
    await page.onShow()
    await page.refreshAuthorized()
    const card = authorizedCard(page)
    assert.ok(card && card.packages[0].packageId, '自愈后必须拿到真实 ID')
  })

  // ————— ⑪ 进页面那一刻读不到云端，恢复网络后点排课必须自愈
  await test('⑪ 进页面时断网（拿不到名单），恢复网络后刷新并点排课必须自愈并成功', async () => {
    world.reset()
    const { B, packageId } = await world.seedSharedScenario()
    world.setActor(B)
    world.openId = B.open
    world.installRuntime(B)
    world.setCloudMode('offline')
    const page = world.enterPage()
    await page.onShow()
    await page.refreshAuthorized()
    assert.equal(authorizedCard(page), undefined, '进页面那一刻读不到 ⇒ 不许拿旧帧凑数')
    world.setCloudMode('ok')
    // 用户下拉刷新（页面自己的 refreshAuthorized 就是这一条路）
    await page.refreshAuthorized()
    world.openBooking(page)
    await page.confirmBooking()
    const sent = world.calls.find(item => item.command === 'createAuthorizedBooking')
    assert.ok(sent, '必须真的发出排课命令')
    assert.equal(sent.payload.packageId, packageId, `自愈后 payload 必须带真实 ID（实测 ${JSON.stringify(sent && sent.payload)}）`)
    assert.ok(!world.modals.length, `不该弹错（实测 ${JSON.stringify(world.modals)}）`)
  })

  world.runtime.setEnvironment('production')
  if (!process.exitCode) process.stdout.write('ALL M2 AUTHORIZED BOOKING CACHE SHAPE TESTS PASSED\n')
})().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
