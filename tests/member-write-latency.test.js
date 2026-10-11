// 会员三条真实写链路的**性能契约**测试（2026-10-01 性能专项）
//
// 真机事实：预约 3s+ / 改期·取消 ~2s，而 UI 早就 Local-first 了 ⇒ 慢的是**服务端真正成功的那一刻**。
// 探针证据（`tests/_probe-write-path-cost.js`）：三条链路**每条都是 2 趟云调用**，
//   第 1 趟 = `coachBusinessCommand`（真写），第 2 趟 = 成功后 `await read({allowCache:true})`（冗余回读）。
//
// ⛔ 本文件钉的是"**成功关键路径上到底等了几趟**"，不是"界面有没有先变"。
//   界面先变（Local-first）是 P-2/P-3 已经真机 PASS 的东西，本轮**不许**拿它冒充"服务端快了"。
//
// 判别力核心：把「回读」那趟云调用**人为拖慢 800ms** ⇒ 如果它还在关键路径上，成功耗时必然跟着变慢。
//   ⛔ 这条是唯一能区分"真的移出去了"和"只是没测到"的断言，其余静态断言都只是辅助。

const assert = require('assert')
const path = require('path')
const fs = require('fs')
const { createWorld, runner } = require('./helpers/m2-business-world')

const ROOT = path.join(__dirname, '..')
const memberBooking = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
const occupancy = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/occupancy'))

const CLAIMS = 'member_sandbox_student_claims'
const EVENTS = 'member_sandbox_notification_events'
const ENV = 'sandbox'
// ⭐ 2026-10-05：测试区现在走**测试区专用**的云函数（名字的唯一出处：utils/sandbox-cloud-functions.js）。
//    ⛔ 本文件跑的是 sandbox 假世界 ⇒ 客户端发的就是 Sandbox 那个名字，写死旧名字会变成"没人接"。
const BUSINESS_FN = require(path.join(ROOT, 'utils/sandbox-cloud-functions')).businessFunction(ENV)
const CLOCK0 = 1900000000000
const TODAY = memberBooking.beijingDateKey(CLOCK0)
const D = n => occupancy.addDateDays(TODAY, n)
const READ_DELAY = 800          // ⭐ 人为拖慢「回读」那趟 ⇒ 关键路径上有没有它，一测就知道
const NOT_AWAITED_BUDGET = 300  // 成功必须在 300ms 内回来（远小于 800ms）

const world = createWorld()
const RUNTIME_SRC = 'utils/member-runtime.js'
const MEMBER_SRC = 'cloudfunctions/coachBusinessCommand/memberBooking.js'

// ------------------------------------------------------------------ 假 wx：云调用计数 + 可拖慢
const storage = {}
let cloudCalls = []
let readDelayMs = 0
let failCloudCall = false
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ------------------------------------------------------------------ 云函数内 DB 操作计数（含事务内）
// ⚠️ 只能包一次：重复包装会层层叠加，把一次操作算成 N 次。
let dbOps = []
let instrumented = false
function instrumentDb() {
  dbOps = []
  if (instrumented) return dbOps
  instrumented = true
  const wrap = scope => {
    const orig = scope.collection.bind(scope)
    scope.collection = name => {
      const api = orig(name)
      return {
        doc(id) {
          const d = api.doc(id)
          return { set(data) { dbOps.push({ name, op: 'set' }); return d.set(data) }, remove() { dbOps.push({ name, op: 'remove' }); return d.remove() } }
        },
        where(query) {
          const w = api.where(query)
          const self = {
            limit(v) { w.limit(v); return self },
            skip(v) { w.skip(v); return self },
            get() { dbOps.push({ name, op: 'get' }); return w.get() }
          }
          return self
        }
      }
    }
    return scope
  }
  wrap(world.db)
  const origTx = world.db.runTransaction.bind(world.db)
  world.db.runTransaction = async work => origTx(async tx => work(wrap(tx)))
  return dbOps
}

let member = null
function installRuntime() {
  global.wx = {
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value },
    cloud: {
      callFunction: async ({ name, data }) => {
        cloudCalls.push(name)
        if (name === BUSINESS_FN && data.action === 'memberRead') {
          if (readDelayMs) await sleep(readDelayMs)
          return { result: { ok: true, environment: data.environment, state: 'ready', dataRevision: 9, member: {}, summary: {}, packages: [], recentTraining: [], coaches: [] } }
        }
        if (name === BUSINESS_FN) {
          if (failCloudCall) throw new Error('network timeout')
          world.setOpenId('open-m1')
          return { result: await world.main()(data) }
        }
        if (name === 'readMyMemberData') {
          if (readDelayMs) await sleep(readDelayMs)
          return { result: { ok: true, environment: data.environment, state: 'ready', dataRevision: 9, member: {}, summary: {}, packages: [], recentTraining: [], coaches: [] } }
        }
        return { result: { ok: true } }
      }
    },
    showToast: () => {}, showModal: () => {}
  }
  for (const key of Object.keys(require.cache)) {
    if (key.includes('utils/member-runtime') || key.includes('utils/data-runtime') || key.includes('utils/release-flags')) delete require.cache[key]
  }
  const runtime = require(path.join(ROOT, 'utils/data-runtime'))
  runtime.setEnvironment(runtime.ENVIRONMENTS.SANDBOX)
  member = require(path.join(ROOT, 'utils/member-runtime'))
}

const coachKeyOf = coachId => memberBooking.fixedId('member-coach-view', coachId)
const packageViewIdOf = (claimId, packageId) => memberBooking.fixedId('member-package-view', claimId, packageId)
const bookingViewIdOf = (claimId, bookingId) => memberBooking.fixedId(memberBooking.BOOKING_VIEW_KIND, claimId, bookingId)

let A, claim1, PKG
const slot = (date, hour, minute = 0) => ({ coachKey: coachKeyOf(A.owner), packageViewId: packageViewIdOf(claim1.claimId, PKG), date, hour, minute })
const bookingCount = () => world.rows('bookings', A.owner, A.datasetId).length
const bookingDataOf = id => (world.rows('bookings', A.owner, A.datasetId).find(r => r.bookingId === id) || {}).data || null

let seq = 0
const rid = p => `${p}_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`

async function setup() {
  world.reset()
  cloudCalls = []
  readDelayMs = 0
  failCloudCall = false
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

const bookingRequest = (date, hour, minute = 0) => ({
  requestId: rid('mbk'), command: 'createMemberBooking', payload: slot(date, hour, minute)
})
const cancelRequest = id => ({
  requestId: rid('mbm'), command: 'cancelMemberBooking', payload: { bookingViewId: bookingViewIdOf(claim1.claimId, id) }
})
const reschedRequest = (id, date, hour, minute = 0) => ({
  requestId: rid('mbm'), command: 'rescheduleMemberBooking',
  payload: { bookingViewId: bookingViewIdOf(claim1.claimId, id), date, hour, minute }
})

async function createBooking(date, hour, minute = 0) {
  const result = await member.submitMemberBooking(bookingRequest(date, hour, minute))
  assert.strictEqual(result.ok, true, `前置：预约必须成功（${result.code || ''}）`)
  return result.bookingId
}
// ⭐ 测"成功耗时"：回读被拖慢 800ms，**成功必须在 300ms 内回来**。
async function timed(fn) {
  const started = Date.now()
  const result = await fn()
  return { result, ms: Date.now() - started }
}

async function main() {
  memberBooking.setPolicy(memberBooking.POLICY_DIRECT)

  // ------------------------------------------------------------ ① 预约
  await runner('① ⭐ 预约：成功**不等**冗余回读（回读拖慢 800ms，成功仍 <300ms）', async () => {
    await setup()
    readDelayMs = READ_DELAY
    const { result, ms } = await timed(() => member.submitMemberBooking(bookingRequest(D(3), 10)))
    assert.strictEqual(result.ok, true, `预约必须成功：${result.code || ''} ${result.message || ''}`)
    assert.ok(result.bookingId, '必须返回 bookingId')
    assert.ok(ms < NOT_AWAITED_BUDGET, `成功耗时 ${ms}ms ⇒ 仍在等那趟被拖慢 ${READ_DELAY}ms 的回读（冗余 await 没删干净）`)
    // 后台对账**仍然会跑完**，并刷新缓存 ⇒ 「我的预约」下次进屏就是最新的。
    await member.pendingReconcile()
    assert.strictEqual((member.cached() || {}).dataRevision, 9, '后台对账必须真的刷新了缓存')
  })

  // ------------------------------------------------------------ ② 取消
  await runner('② ⭐ 取消：成功**不等**冗余回读（回读拖慢 800ms，成功仍 <300ms）', async () => {
    await setup()
    const id = await createBooking(D(3), 10)
    readDelayMs = READ_DELAY
    const { result, ms } = await timed(() => member.submitMemberManage(cancelRequest(id)))
    assert.strictEqual(result.ok, true, `取消必须成功：${result.code || ''} ${result.message || ''}`)
    assert.strictEqual(result.status, 'cancelled')
    assert.ok(ms < NOT_AWAITED_BUDGET, `成功耗时 ${ms}ms ⇒ 取消仍在等冗余回读`)
    await member.pendingReconcile()
    assert.strictEqual((member.cached() || {}).dataRevision, 9, '后台对账必须真的刷新了缓存')
  })

  // ------------------------------------------------------------ ③ 改期
  await runner('③ ⭐ 改期：成功**不等**冗余回读（回读拖慢 800ms，成功仍 <300ms）', async () => {
    await setup()
    const id = await createBooking(D(3), 10)
    readDelayMs = READ_DELAY
    const { result, ms } = await timed(() => member.submitMemberManage(reschedRequest(id, D(4), 11)))
    assert.strictEqual(result.ok, true, `改期必须成功：${result.code || ''} ${result.message || ''}`)
    assert.ok(ms < NOT_AWAITED_BUDGET, `成功耗时 ${ms}ms ⇒ 改期仍在等冗余回读`)
    const after = bookingDataOf(id)
    assert.strictEqual(after.hour, 11, '服务端真的改了时间（不是只改了界面）')
    await member.pendingReconcile()
    assert.strictEqual((member.cached() || {}).dataRevision, 9, '后台对账必须真的刷新了缓存')
  })

  // ------------------------------------------------------------ ④ 通知不在关键路径上 / 失败不拖垮业务
  await runner('④ ⭐ 通知：集合缺失 / 落库失败 ⇒ 业务**照样成功**，且如实回传 notify.ok=false', async () => {
    await setup()
    const id = await createBooking(D(3), 10)
    world.missCollection(EVENTS)             // 真机事故原样：`-502005 Db or Table not exist`
    readDelayMs = READ_DELAY
    const { result, ms } = await timed(() => member.submitMemberManage(cancelRequest(id)))
    assert.strictEqual(result.ok, true, '⛔ 通知写不进去**绝不能**把已经成功的取消变成失败')
    assert.strictEqual(bookingDataOf(id).status, 'cancelled', '业务必须真的生效')
    assert.strictEqual(result.notify && result.notify.ok, false, '通知失败必须如实回传，不许静默')
    assert.ok(ms < NOT_AWAITED_BUDGET, `通知慢/失败也不许拖住成功返回（实测 ${ms}ms）`)
  })

  // ------------------------------------------------------------ ⑤ 明确失败 ⇒ 无损（不产生写入、数据不变）
  await runner('⑤ 明确失败仍无损：已取消的课再改期 ⇒ 拒绝且数据一个字不动', async () => {
    await setup()
    const id = await createBooking(D(3), 10)
    const before = JSON.stringify(bookingDataOf(id))
    const cancelled = await member.submitMemberManage(cancelRequest(id))
    assert.strictEqual(cancelled.ok, true)
    const afterCancel = JSON.stringify(bookingDataOf(id))
    const refused = await member.submitMemberManage(reschedRequest(id, D(4), 11))
    assert.strictEqual(refused.ok, false, '已取消的课不许改期')
    assert.strictEqual(refused.code, 'BOOKING_ALREADY_CANCELLED')
    assert.strictEqual(JSON.stringify(bookingDataOf(id)), afterCancel, '被拒时数据一个字节都不许变')
    assert.notStrictEqual(afterCancel, before, '（构造判别力）取消那一步确实改过数据')
  })

  // ------------------------------------------------------------ ⑥ UNKNOWN 裁决
  await runner('⑥ UNKNOWN 仍正确裁决：云调用超时 ⇒ 不明说成功、也不假装失败', async () => {
    await setup()
    const id = await createBooking(D(3), 10)
    failCloudCall = true
    const result = await member.submitMemberManage(cancelRequest(id))
    assert.strictEqual(result.ok, false, '网络超时不许算成功')
    assert.strictEqual(result.code, 'MEMBER_MANAGE_RESULT_UNKNOWN')
    assert.ok(/待确认/.test(result.message || ''), '必须明说"结果待确认，别重复提交"')
    assert.strictEqual(bookingDataOf(id).status, 'booked', '没有成功 ⇒ 状态不许变')
    failCloudCall = false
  })

  // ------------------------------------------------------------ ⑦ 双击只产生一次有效写入
  await runner('⑦ 双击（同 requestId 并发两次）⇒ 只落一条预约，第二次是幂等重放', async () => {
    await setup()
    const request = bookingRequest(D(3), 10)
    const both = await Promise.all([
      member.submitMemberBooking(request),
      member.submitMemberBooking(request)
    ])
    assert.strictEqual(both[0].ok, true)
    assert.strictEqual(both[1].ok, true, '同号重放应返回同一个成功结果（不是报错）')
    assert.strictEqual(bookingCount(), 1, `只允许一条预约（实测 ${bookingCount()} 条）`)
    assert.strictEqual(both[1].replayed, true, '第二次必须是幂等重放')
  })

  // ------------------------------------------------------------ ⑧ 时间窗口不回归
  await runner('⑧ 不能回归：23:00 可约（→ 24:00）、23:30 / 23:45 拒、06:30 可约、05:30 拒', async () => {
    await setup()
    const last = await member.submitMemberBooking(bookingRequest(D(2), 23, 0))
    assert.strictEqual(last.ok, true, `23:00 是最后一个开课时间 ⇒ 必须可约（${last.code || ''}）`)
    const halfPast = await member.submitMemberBooking(bookingRequest(D(3), 23, 30))
    assert.strictEqual(halfPast.ok, false, `23:30 已取消 ⇒ 必须拒（${halfPast.code || ''}）`)
    assert.strictEqual(halfPast.code, 'BOOKING_START_TOO_LATE')
    const tooLate = await member.submitMemberBooking(bookingRequest(D(2), 23, 45))
    assert.strictEqual(tooLate.ok, false)
    assert.strictEqual(tooLate.code, 'BOOKING_START_TOO_LATE')
    // ⭐ 2026-10-03 四次口径：最早 07:00 → **06:00** ⇒ 06:30 现在是**合法**的半点，
    //    被拒的那一档顺延到 05:30（判据仍然钉住"最早那一档"这个口径本身，只是数值跟着常量走）。
    const half = await member.submitMemberBooking(bookingRequest(D(5), 6, 30))
    assert.strictEqual(half.ok, true, `06:30 半点必须可约（${half.code || ''}）`)
    const tooEarly = await member.submitMemberBooking(bookingRequest(D(5), 5, 30))
    assert.strictEqual(tooEarly.ok, false)
    assert.strictEqual(tooEarly.code, 'BOOKING_START_TOO_EARLY')
  })

  // ------------------------------------------------------------ ⑨ 诊断 instrumentation
  await runner('⑨ 阶段耗时 instrumentation（默认关闭 ⇒ 生产零开销；显式打开才有）', async () => {
    await setup()
    const plain = await member.submitMemberBooking(bookingRequest(D(3), 10))
    assert.strictEqual(plain.__trace, undefined, '默认不许带 trace（生产零开销）')
    const traced = await member.submitMemberBooking(bookingRequest(D(6), 14), { trace: true })
    const names = (traced.__trace || []).map(row => row.stage)
    for (const stage of ['clientStart', 'cloudCallStart', 'cloudReturn', 'clientResult']) {
      assert.ok(names.includes(stage), `trace 必须含 ${stage}（实测 ${JSON.stringify(names)}）`)
    }
    assert.ok(names.indexOf('cloudCallStart') < names.indexOf('cloudReturn'), 'trace 必须有序')
  })

  // ------------------------------------------------------------ ⑩ 源码钉子 + 后台对账仍存在
  await runner('⑩ 源码钉子：三条提交出口里**不许**再出现 `await read(`；后台对账入口仍在', async () => {
    const source = fs.readFileSync(path.join(ROOT, RUNTIME_SRC), 'utf8')
    const submitBlock = source.slice(source.indexOf('async function submitMemberBooking'), source.indexOf('async function command('))
    assert.ok(!/await\s+read\(/.test(submitBlock), '⛔ 预约 / 取消 / 改期的成功关键路径上不许再 await 回读')
    assert.ok(/startBackgroundReconcile\(/.test(submitBlock), '回读必须**还在**（只是后台化了），不许直接删掉')
    assert.ok(/pendingReconcile/.test(source), '必须暴露 pendingReconcile ⇒ 页面 / 测试可以等对账结果')
  })

  // ------------------------------------------------------------ ⑪ 云端：同一次请求内的重复查询已合并
  await runner('⑪ ⭐ 云端：同一位教练的账本位置在一次请求里只查一次（place 备忘录）', async () => {
    // 📌 本轮审计**撤回过一条错误结论**：最初以为 `resolveOwnBooking` 里"逐条预约查 head"是 N+1，
    //    还写了备忘录 —— 但 head 只在"视图 ID 命中之后"才查、命中即 return ⇒ 本来就最多一次。
    //    是"操作数是否随数据规模变化"这条判据把它证伪的 ⇒ 备忘录已撤回，判定结果一字未变。
    // ⛔ 教训：**"看起来像 N+1"不等于"真的是 N+1"**，必须用"操作数随规模怎么变"来判，不能靠读代码的感觉。
    const source = fs.readFileSync(path.join(ROOT, MEMBER_SRC), 'utf8')
    // ⚠️ 结束锚点必须从**起点之后**开始找：那个注释在本文件里出现两次，
    //    不传起始位置会找到前面那次 ⇒ slice 被截成空串 ⇒ 断言永远不成立（假红）。
    const from = source.indexOf('async function resolveMemberTarget')
    const to = source.indexOf('// ------------------------------------------------------------------ 服务端推导', from + 10)
    assert.ok(from >= 0 && to > from, '切片锚点必须成立')
    const target = source.slice(from, to)
    // 真正的重复点：`activePlaceOf` 原本"每个 claim 一次 + 每个 grant 一次"，同一位教练会被重复查。
    assert.ok(/await placeOf\(claim\.coachId\)/.test(target), 'claim 的账本位置必须走 placeOf 备忘录')
    assert.ok(/await placeOf\(grant\.coachId\)/.test(target), '⛔ grant 的账本位置必须走 placeOf 备忘录（不许退回逐条 activePlaceOf）')
    assert.ok(/placeMemo\.has\(coachId\)/.test(target), '备忘录必须真的按 coachId 命中')
  })

  // ------------------------------------------------------------ ⑫ 成功文案统一
  await runner('⑫ 成功提示统一：预约成功 / 时间更改成功 / 预约已取消（不许再有"已改到新的时间"）', async () => {
    const manage = require(path.join(ROOT, 'utils/member-booking-manage'))
    assert.strictEqual(manage.SUCCESS_TEXT.cancel, '预约已取消')
    assert.strictEqual(manage.SUCCESS_TEXT.reschedule, '时间更改成功')
    const request = require(path.join(ROOT, 'utils/member-booking-request'))
    assert.strictEqual(request.SUCCESS_TITLE, '预约成功')
    const page = fs.readFileSync(path.join(ROOT, 'pages/member-bookings/member-bookings.js'), 'utf8')
    assert.ok(!/已改到新的时间/.test(page), '⛔ 「已改到新的时间」这种像迟到通知的说法必须消失')
    assert.ok(!/已取消这节课/.test(page), '⛔ 取消提示统一为「预约已取消」')
  })

  console.log('member write latency tests: PASS')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
