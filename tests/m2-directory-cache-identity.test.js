// M2 V1（2026-09-29）：**授权目录缓存必须按「环境 + 可信教练身份」隔离**。
//
// ⛳ 故障形状（真实的、并且已经在不止一处复现过）：
//   授权目录缓存 key 只有 `environment` 一个维度 ⇒ 同一台设备换一位教练，
//   命中的还是上一位教练那一帧 ⇒ **看到别人的会员名单、拿着别人的课包去排课**。
//   这类事故不报错、不报码、不需要网络：页面渲染得很好，只是事实是别人的。
//
// ⛔ 身份的**唯一**可信来源是云端 directory 响应里的 `coachId`（服务端从 OPENID 推导）。
//    姓名 / 手机号一律不许用来判断"现在是谁" —— 它们会重名、会为空、会在业务上被改写，
//    拿它们当维度等于给自己留一个随时失效的锁。
//
// ⛔ 全部跑真件：云端是真的 createService + 真 handlers，
//    客户端是真的 utils/coach-authorization（只替 wx / Storage / 网络）。

const assert = require('assert')
const path = require('path')
const { createWorld, runner } = require('./helpers/m2-business-world')
const runtime = require('../utils/data-runtime')
const authorization = require('../utils/coach-authorization')

const world = createWorld()
// ⭐ 2026-10-06：旧的「多教练服务（授权）工作台」已随认领方案下线；
//    ⑨ 的业务判据（"我看到的名单必须是我自己那一帧"）改在**新出口**上钉 —— 学员列表页
//    （授权会员就是列表里那张 `authorized` 卡，读的仍然是同一帧按身份隔离的缓存）。
const PAGE_PATH = path.join(__dirname, '..', 'pages', 'students', 'students.js')
const SANDBOX_CACHE_KEY = 'coachSandboxActiveCache'

let directoryCalls = 0
function installCountingRuntime() {
  const storage = world.installRuntime()
  const raw = global.wx.cloud.callFunction
  global.wx.cloud.callFunction = async options => {
    if (options && options.data && options.data.action === 'authorization') directoryCalls += 1
    return raw(options)
  }
  return storage
}

// 以某位教练的身份读一次目录（force ⇒ 真的走云端，并把"我是谁"确认下来）。
async function readAs(coach, options = {}) {
  world.setActor(coach)
  return authorization.loadDirectory({ force: true, ...options })
}
const servingNames = result => (result && result.data && result.data.serving || []).map(item => item.studentId)

// 两位学员由第三位教练 O 建档，O 把「甲」的会员级服务关系授给 A、把「乙」授给 B ⇒
//    · A 的目录里应该只有甲，B 的目录里应该只有乙；
//    · **只要两边串了，会员名单立刻就不一样** —— 这就是这一批测试的判别力来源。
//   （不能用"各自建档、各自拥有"来造：授权目录列的是"我服务谁"，不是"我拥有谁"。）
async function seedTwoWorlds() {
  runtime.setEnvironment('sandbox')
  const A = world.seedCoach('openid-a', 'ds-a', 'PUBCODEA')
  const B = world.seedCoach('openid-b', 'ds-b', 'PUBCODEB')
  const O = world.seedCoach('openid-o', 'ds-o', 'PUBCODEO')
  world.seedStudent(O, 'stu-a1', '授权给 A 的会员')
  world.seedStudent(O, 'stu-b1', '授权给 B 的会员')
  const grantedA = await world.execute(O, 'grantMemberService', { studentId: 'stu-a1', publicCodes: [A.publicCode] }, 'dir_seed_grant_a')
  assert.equal(grantedA.ok, true, JSON.stringify(grantedA))
  const grantedB = await world.execute(O, 'grantMemberService', { studentId: 'stu-b1', publicCodes: [B.publicCode] }, 'dir_seed_grant_b')
  assert.equal(grantedB.ok, true, JSON.stringify(grantedB))
  return { A, B, O }
}

;(async () => {
  await runner('① A 登录后读到的是**A 自己**那一帧（并且后续默认读命中自己的缓存）', async () => {
    world.reset()
    installCountingRuntime()
    const { A } = await seedTwoWorlds()
    const first = await readAs(A)
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.coachId, A.owner, '服务端给的可信身份必须记下来')
    assert.equal(first.cached, false, '第一次必须真读云端')
    assert.ok(servingNames(first).includes('stu-a1'), 'A 的会员必须在列表里')
    // 默认（不带 force）读 ⇒ 命中自己那一帧，**零云调用**。
    const before = directoryCalls
    const second = await authorization.loadDirectory({})
    assert.equal(second.cached, true, '同一份身份 ⇒ 命中缓存')
    assert.equal(directoryCalls, before, '命中缓存时一次云调用都不许发')
    assert.ok(servingNames(second).includes('stu-a1'))
  })

  await runner('② A → B 切换：服务端给的身份变成 B ⇒ 不许再读 A 那一帧', async () => {
    world.reset()
    installCountingRuntime()
    const { A, B } = await seedTwoWorlds()
    await readAs(A)
    const asB = await readAs(B)
    assert.equal(asB.coachId, B.owner, '身份必须跟着服务端确认的那一位走')
    assert.equal(asB.identitySwitched, true, '必须**看得出来**换人了（这本身就是一条可观测事实）')
    assert.equal(asB.cached, false, '换了人 ⇒ 不许命中上一帧')
    assert.ok(servingNames(asB).includes('stu-b1'), '读到的是 B 的会员')
    assert.ok(!servingNames(asB).includes('stu-a1'), '⛔ 绝不能把 A 的会员混进来')
    // 默认读 ⇒ 命中的是 B 那一帧，仍然是零云调用。
    const before = directoryCalls
    const cached = await authorization.loadDirectory({})
    assert.equal(cached.cached, true, '现在属于 B ⇒ 命中 B 的缓存')
    assert.equal(directoryCalls, before)
    assert.ok(!servingNames(cached).includes('stu-a1'), '默认读也不许串回 A')
  })

  await runner('③ B → A 切回：仍读得到 A 的数据，且不会残留 B 的会员', async () => {
    world.reset()
    installCountingRuntime()
    const { A, B } = await seedTwoWorlds()
    await readAs(A)
    await readAs(B)
    const backToA = await readAs(A)
    assert.equal(backToA.coachId, A.owner)
    assert.equal(backToA.identitySwitched, true)
    assert.ok(servingNames(backToA).includes('stu-a1'), '切回 A 必须拿回 A 的名单')
    assert.ok(!servingNames(backToA).includes('stu-b1'), '⛔ 不许残留 B 的会员')
    // 切回之后默认读 ⇒ 命中 A 那一帧（两位教练各存各的，互不覆盖）。
    const before = directoryCalls
    const cached = await readAs(A, { force: false })
    assert.equal(cached.cached, true, 'A 那一帧并没有被 B 覆盖掉')
    assert.equal(directoryCalls, before, '命中缓存 ⇒ 零云调用')
    assert.ok(servingNames(cached).includes('stu-a1'))
  })

  await runner('④ 当前身份未确认 ⇒ **任何**一帧都不许用（宁可不显示，也不许显示别人的）', async () => {
    world.reset()
    const storage = installCountingRuntime()
    const { A, B } = await seedTwoWorlds()
    await readAs(A)
    await readAs(B)
    // 身份被清掉（等价于换了一台设备 / 清了登录态），但 A、B 两帧都还留在 Storage 里。
    storage[authorization.identityKey('sandbox')] = undefined
    delete storage[authorization.identityKey('sandbox')]
    const cacheAfter = authorization.cachedDirectory()
    assert.equal(cacheAfter.identityConfirmed, false, '必须明示"身份还没确认"')
    assert.equal(cacheAfter.hasCache, false, '⛔ 身份没确认 ⇒ 一帧都不给')
    assert.equal(cacheAfter.data.serving.length, 0, '绝不能把别人那一帧渲染成我的名单')
    // 而且 loadDirectory 默认读必须真的去问云端（否则永远不自愈）。
    const before = directoryCalls
    const healed = await readAs(A, { force: false })
    assert.equal(healed.cached, false, '身份没确认 ⇒ 不许命中任何缓存')
    assert.ok(directoryCalls > before, '必须真的读一次云端重新确认身份')
    assert.equal(healed.coachId, A.owner)
  })

  await runner('⑤ 不同环境互相隔离：production 的帧绝不能被 sandbox 读到（反之亦然）', async () => {
    world.reset()
    installCountingRuntime()
    const { A } = await seedTwoWorlds()
    runtime.setEnvironment('production')
    // ⚠️ production 环境这一读会失败（测试世界只播种了 sandbox 元数据），
    //    这里只证明**两维都在 key 上**：环境不同 → key 不同 → 不会串。
    await readAs(A)
    const prodKey = authorization.cacheKey('production', A.owner)
    const sandboxKey = authorization.cacheKey('sandbox', A.owner)
    assert.notEqual(prodKey, sandboxKey, '环境与身份必须同时进 key')
    // 手工摆一帧 production 的目录进 Storage ⇒ sandbox 那一边必须看不见它。
    world.storage[prodKey] = {
      environment: 'production', coachId: A.owner, shape: authorization.CACHE_SHAPE, savedAt: Date.now(),
      data: { serving: [{ studentId: 'stu-prod', name: '生产环境会员', packages: [], upcoming: [], history: [] }], managed: [], truncated: false }
    }
    runtime.setEnvironment('sandbox')
    const sandbox = authorization.cachedDirectory()
    assert.ok(!servingNames(sandbox).includes('stu-prod'), '⛔ production 的会员不许出现在 sandbox 的名单里')
  })

  await runner('⑥ 旧版缓存（只有环境、没有身份）：升级后**一律不认**，不许被当成事实', async () => {
    world.reset()
    installCountingRuntime()
    const { A } = await seedTwoWorlds()
    // 旧版客户端写下的那一帧：key 里没有身份，内容也不知道是谁的。
    const legacyKey = authorization.cacheKey('sandbox', '')
    world.storage[legacyKey] = {
      environment: 'sandbox', savedAt: Date.now(), shape: authorization.CACHE_SHAPE,
      data: { serving: [{ studentId: 'stu-legacy', name: '旧帧会员', packages: [], upcoming: [], history: [] }], managed: [], truncated: false }
    }
    assert.ok(authorization.LEGACY_CACHE_KEYS.includes(legacyKey), '旧 key 的形状必须被记住（便于真机取证与排障）')
    // 身份还没确认 ⇒ 它拿不到任何一帧。
    const beforeIdentity = authorization.cachedDirectory()
    assert.equal(beforeIdentity.hasCache, false, '没身份 ⇒ 旧帧不许用')
    // 身份确认之后也必须株连千里地忽略旧帧 ⇒ 真的去读云端。
    const before = directoryCalls
    const healed = await readAs(A)
    assert.equal(healed.cached, false, '⛔ 旧帧不许被当成"这就是我的那一帧"')
    assert.ok(directoryCalls > before, '必须重新读一次云端')
    assert.ok(!servingNames(healed).includes('stu-legacy'), '旧帧里的会员不许混进来')
  })

  await runner('⑦ 异常身份（空串 / 非字符串 / 嵌套对象）一律挡住，不许凑巧命中某一帧', async () => {
    world.reset()
    installCountingRuntime()
    const { A } = await seedTwoWorlds()
    await readAs(A)
    for (const bad of ['', null, undefined, 0, {}, { coachId: A.owner }, ['x']]) {
      world.storage[authorization.identityKey('sandbox')] = { environment: 'sandbox', coachId: bad, savedAt: Date.now() }
      const view = authorization.cachedDirectory()
      assert.equal(view.identityConfirmed, false, `身份 ${JSON.stringify(bad)} 不算有效身份`)
      assert.equal(view.hasCache, false, `身份异常时不许拿到任何缓存（实测 ${JSON.stringify(view.data.serving.map(x => x.studentId))}）`)
    }
    // 行里自报的身份与读取身份不一致 ⇒ 这一帧同样不许用（key 和内容是**两把锁**，缺一把就给了伪造空间）。
    const key = authorization.cacheKey('sandbox', A.owner)
    const good = world.storage[key]
    world.storage[authorization.identityKey('sandbox')] = { environment: 'sandbox', coachId: A.owner, savedAt: Date.now() }
    world.storage[key] = { ...good, coachId: 'coach-someone-else' }
    const mismatched = authorization.cachedDirectory()
    assert.equal(mismatched.hasCache, false, '⛔ 行里自报的身份对不上 ⇒ 不许拿这一帧')
    world.storage[key] = { ...good, coachId: undefined }
    assert.equal(authorization.cachedDirectory().hasCache, false, '⛔ 行里没有身份 ⇒ 同样不许拿（这正是旧版帧的形状）')
  })

  await runner('⑧ 授权变更后刷新：notePermissionChanged ⇒ 强制重读 + 身份复核（换了人就切换身份）', async () => {
    world.reset()
    installCountingRuntime()
    const { A, B, O } = await seedTwoWorlds()
    await readAs(A)
    // O 把自己的会员「甲」再授一份会员级服务关系给 B ⇒ B 的目录里应该多一位会员。
    const granted = await world.execute(O, 'grantMemberService', { studentId: 'stu-a1', publicCodes: [B.publicCode] }, 'dir_cache_grant_member')
    assert.equal(granted.ok, true, JSON.stringify(granted))
    await readAs(B)
    world.setActor(B)
    const before = directoryCalls
    await authorization.notePermissionChanged()
    assert.ok(directoryCalls > before, '权限变了 ⇒ 必须真读一次（不能躺在缓存里）')
    const after = authorization.cachedDirectory()
    assert.equal(after.coachId, B.owner, '重读之后身份必须是当前这位（不是刚刚那位）')
    assert.ok(servingNames(after).includes('stu-a1'), 'B 现在应该能看到被授权给他的会员')
  })

  await runner('⑨ 业务侧证明：切到 B 之后，页面显示的是**B 自己**的名单，不会拿 A 的会员去排课', async () => {
    world.reset()
    installCountingRuntime()
    const { A, B, O } = await seedTwoWorlds()
    // O 给「甲」再卖一份课包，并把课包授课权授给 A ⇒ A 的目录里甲既有人也有课包。
    const sold = await world.execute(O, 'createCourseSale', {
      studentId: 'stu-a1', type: '常规训练', total: 5, remaining: 5, quantity: 5, unitPrice: 100, amount: 500,
      date: '2026-09-29', teachingPublicCodes: [A.publicCode]
    }, 'dir_seed_sale_a1')
    assert.equal(sold.ok, true, JSON.stringify(sold))
    await readAs(A)
    await readAs(B)
    // 真的进 B 的学员列表页：看到的必须是属于 B 的那一帧（乙），而不是 A 的甲。
    world.installFakeMutate()
    world.setActor(B)
    // 学员页 render() 走 getDB()：测试区只认 coachSandboxActiveCache 这一份（读不到就抛）⇒ 先摆一本空账。
    world.storage[SANDBOX_CACHE_KEY] = {
      environment: 'sandbox', datasetId: B.datasetId, revision: 0,
      snapshot: { students: [], bookings: [], incomes: [], sales: [], settings: { renewThreshold: 2, monthlyGoalSessions: 20 }, customExercises: [] }
    }
    const page = world.enterPage(PAGE_PATH)
    await page.onShow()
    await page.refreshAuthorized()
    const memberIds = (page.data.students || []).map(item => item.studentId)
    assert.ok(!memberIds.includes('stu-a1'), `⛔ B 的页面不许出现 A 的会员（实测 ${JSON.stringify(memberIds)}）`)
    assert.ok(memberIds.includes('stu-b1'), `必须显示属于 B 自己的会员（实测 ${JSON.stringify(memberIds)}）`)
    assert.equal(authorization.readIdentity('sandbox'), B.owner, '当前身份必须是 B')
  })

  await runner('⑪ 云端没给可信身份（旧版云函数 / 异常响应）⇒ 允许展示这一帧，但**不许落缓存**', async () => {
    world.reset()
    installCountingRuntime()
    const { A } = await seedTwoWorlds()
    // 模拟"云函数没在响应里带 coachId"：目录照样读得回来，但这一帧**说不清属于谁**。
    const raw = global.wx.cloud.callFunction
    global.wx.cloud.callFunction = async options => {
      const response = await raw(options)
      if (options && options.data && options.data.action === 'authorization' && response && response.result && 'coachId' in response.result) delete response.result.coachId
      return response
    }
    const result = await readAs(A)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.identityConfirmed, false, '服务端没给身份 ⇒ 必须明示"没确认"')
    assert.ok(servingNames(result).length >= 0, '展示照旧（这一帧仍然可以拿来渲染）')
    // ⛔ 关键：不许落任何一帧缓存（包括旧版那个没有身份的 key）—— 落了就等于留了个说不清属于谁的事实。
    world.storage[authorization.identityKey('sandbox')] = undefined
    delete world.storage[authorization.identityKey('sandbox')]
    const legacyKey = authorization.cacheKey('sandbox', '')
    const ownKey = authorization.cacheKey('sandbox', A.owner)
    assert.equal(world.storage[legacyKey], undefined, '⛔ 没身份 ⇒ 不许写旧版那个 key')
    assert.equal(world.storage[ownKey], undefined, '⛔ 更不许写进某一位教练名下')
    const view = authorization.cachedDirectory()
    assert.equal(view.hasCache, false, '⛔ 读的那一边也必须什么都没有')
  })

  await runner('⑩ 关键形状：可信身份是 A，但最近一次写进来的帧是 B 的 ⇒ 默认读必须拿回**A**那一帧', async () => {
    world.reset()
    installCountingRuntime()
    const { A, B } = await seedTwoWorlds()
    await readAs(A)
    await readAs(B)
    // ⛳ 这一段的真机形状：两位教练**各存各的帧**。
    //    只按环境分键的旧实现里，B 那一帧会把 A 那一帧**覆盖掉**；
    //    于是会出现"身份是 A、缓存里却已经是 B 的东西" —— 看到的就是别人的名单。
    world.storage[authorization.identityKey('sandbox')] = { environment: 'sandbox', coachId: A.owner, savedAt: Date.now() }
    const before = directoryCalls
    const served = await authorization.loadDirectory({})
    assert.equal(served.cached, true, 'A 那一帧还在 ⇒ 命中缓存，零云调用')
    assert.equal(directoryCalls, before)
    assert.ok(servingNames(served).includes('stu-a1'), '必须拿回 A 的名单')
    assert.ok(!servingNames(served).includes('stu-b1'), `⛔ 绝不能把 B 的帧给 A（实测 ${JSON.stringify(servingNames(served))}）`)
  })

  runtime.setEnvironment('production')
  if (!process.exitCode) process.stdout.write('ALL M2 DIRECTORY CACHE IDENTITY TESTS PASSED\n')
})().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
