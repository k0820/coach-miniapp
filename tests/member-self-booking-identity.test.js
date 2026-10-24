// ─────────────────────────────────────────────────────────────────────────────
// §192 · 会员**主动约课**「同一个会员只有一个真相源」永久专项（2026-10-07 · 1.3.36）
//
// 🔴 为什么要有这一份（真机 1.3.35 的事实）：
//   会员首页看得到「张三 + 10 节 + 教练」，点「约一节课」进去却：
//     · 没有选择教练；
//     · 没有可约时间；
//     · 有时还说"没有课时包"。
//   ⇒ 不是 WXML 显示问题，是**两条读取链路不是同一个真相源**：
//      · 首页  走新会员目录 `member-directory.readDashboard`，用会员资料行里
//              **绑定时锁定的** ownerCoachId + ownerDatasetId + studentId；
//      · 约课页走旧投影 `member-read`，先在认领表里找 claim，再**动态**去 head 表猜教练当前账本，
//              并进一步要求一张**派生索引** `member_sandbox_accounts` 必须存在且 active。
//
// ⛔ 本专项模拟 1.3.35 真机的**真实数据形状**（会员目录里有张三、ownerCoachId/ownerDatasetId/studentId
//    齐全、真实 10 节课包、A 是第一位教练），并且**故意把旧 head / claim 条件弄残**，
//    要求约课链路**仍然必须读到同一份张三、同一份 10 节、同一位 A 教练**。
//
// ⛔ 判据不是字符串存在：全部跑**真云函数** + **真页面**，只替换 wx / Page / 云调用运输层。
// ⛔ 配套反证：`tests/_member-self-booking-identity-mutate.js`（内存覆盖层，禁止写盘改源码）。
// ─────────────────────────────────────────────────────────────────────────────
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const MEMBER_READ = path.join(ROOT, 'cloudfunctions', 'coachBusinessSandboxCommand', 'member-read.js')
const DIRECTORY = path.join(ROOT, 'cloudfunctions', 'coachBusinessSandboxCommand', 'member-directory.js')
const SLOTS_JS = path.join(ROOT, 'pages', 'member-book-slots', 'member-book-slots.js')
const SLOTS_WXML = path.join(ROOT, 'pages', 'member-book-slots', 'member-book-slots.wxml')

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const fixedId = (...parts) => sha(parts.join(':')).slice(0, 32)

const COACH_A = 'coach-a-owner'
const DATASET_A = 'dataset-a-owner'
const STUDENT_ZHANG = 'student-zhang-real'
const OPENID_ZHANG = 'o-member-zhang-real'
// 专属二维码会员沿用教练已经建立的学员资料，因此 memberId 与旧 OPENID 哈希故意不同。
// 这一条如果又改回 hash(openId)，本专项就无法复现邱一一真机故障。
const MEMBER_ZHANG = fixedId('member-by-student', COACH_A, DATASET_A, STUDENT_ZHANG)
const LEGACY_MEMBER_ZHANG = sha(`member:${OPENID_ZHANG}`).slice(0, 32)
const CONTACT_KEY_A = fixedId('member-contact-view', 'coach', COACH_A)
const futureDate = days => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86400000))
const BOOKED_DATE = futureDate(1)          // 明天已被占用 ⇒ 始终验证"真的算过冲突"，不会随日历过期
const FREE_DATE = futureDate(2)

// ─────────────────── 假 CloudBase（只读 Uponassistant + doc.get + where().get）───────────────────
function makeDb(stores) {
  const listWhere = (name, query, limit = 200) =>
    (stores[name] || []).filter(row => Object.keys(query || {}).every(k => row[k] === query[k])).slice(0, limit)
  const rowById = (name, id) => (stores[name] || []).find(row => row._id === id) || null
  return {
    async createCollection() { throw new Error('already exists') },
    collection(name) {
      return {
        where(query) {
          const chain = {
            async get() { return { data: listWhere(name, query) } },
            skip() { return chain },
            limit(n) { chain.get = async () => ({ data: listWhere(name, query, n) }); return chain },
            orderBy() { return chain }
          }
          return chain
        },
        doc(id) { return { async get() { return { data: rowById(name, id) } } } },
        async get() { return { data: (stores[name] || []) } }
      }
    }
  }
}

// ⭐ 真机数据形状的建构函数；每个 `opts` 代表真机上可能出现的一种"残缺"。
function seedRealDevice(opts = {}) {
  const stores = {}
  // ① 新会员目录里的张三（绑定时锁定的三个字段齐全）—— 这才是真相源
  if (!opts.noMembers) {
    stores['member_sandbox_members'] = [{
      _id: fixedId('member-directory-member', MEMBER_ZHANG), memberId: MEMBER_ZHANG, openId: OPENID_ZHANG,
      displayName: '张三', ownerCoachId: COACH_A, ownerDatasetId: DATASET_A, studentId: STUDENT_ZHANG,
      claimId: fixedId('member-directory-claim', MEMBER_ZHANG), status: 'active', createdAt: 1, updatedAt: 1
    }]
  }
  // ② 兼容层：旧认领表（新方案仍在写，但不许再拿它当主判据）
  if (!opts.noClaims) {
    stores['member_sandbox_student_claims'] = [{
      claimId: fixedId('member-directory-claim', MEMBER_ZHANG), memberId: MEMBER_ZHANG, coachId: COACH_A,
      studentId: STUDENT_ZHANG, status: 'verified', source: 'coach-created-binding', createdAt: 1
    }]
  }
  // ③ 派生索引（通知定位用）—— 真机上它可能不存在（1.3.35 就是这个形状）
  if (!opts.noAccounts) {
    stores['member_sandbox_accounts'] = [{
      _id: fixedId('member_sandbox_accounts', MEMBER_ZHANG), memberId: MEMBER_ZHANG,
      identityHash: sha(`openid:${OPENID_ZHANG}`), openId: OPENID_ZHANG, displayName: '张三',
      status: opts.accountInactive ? 'inactive' : 'active', createdAt: 1, updatedAt: 1
    }]
  }
  // ④ 教练 head：0 条 / 没 environment / 两条 —— 三种真机都可能残缺的形态
  if (!opts.noHead) {
    stores['coach_sandbox_heads'] = [{
      _id: fixedId('coach-sandbox-head', COACH_A), ownerCoachId: COACH_A, activeDatasetId: DATASET_A,
      environment: 'sandbox', headVersion: 1, updatedAt: 1
    }]
  }
  if (opts.headNoEnv && stores['coach_sandbox_heads']) delete stores['coach_sandbox_heads'][0].environment
  if (opts.twoHeads && stores['coach_sandbox_heads']) {
    stores['coach_sandbox_heads'].push({
      _id: fixedId('coach-data-head', COACH_A), ownerCoachId: COACH_A, activeDatasetId: 'dataset-legacy-other',
      environment: 'sandbox', headVersion: 2, updatedAt: 2
    })
  }
  // ⑤ 张三真实的 10 节课包（唯一的那一本账）
  if (!opts.noPackages) {
    stores['packages'] = [{
      packageId: 'pkg-zhang-10', ownerCoachId: COACH_A, datasetId: DATASET_A, studentId: STUDENT_ZHANG,
      data: { id: 'pkg-zhang-10', type: '常规训练', total: 10, used: 0, remaining: 10, reserved: 0, status: 'active' }
    }]
  }
  stores['students'] = [{ ownerCoachId: COACH_A, datasetId: DATASET_A, studentId: STUDENT_ZHANG, data: { name: '张三' } }]
  stores['member_sandbox_coach_profiles'] = [{ coachId: COACH_A, displayName: 'A教练', discoverable: true, publicCode: 'C0001234' }]
  // ⑥ 张三自己在某天有一节课 ⇒ 那一天的那一段时间**不许**被算成可约
  stores['bookings'] = [{
    bookingId: 'bk-zhang-existing', ownerCoachId: COACH_A, datasetId: DATASET_A, studentId: STUDENT_ZHANG,
    date: BOOKED_DATE, hour: 14, minute: 0, plannedMinutes: 60, status: 'booked', typeName: '常规训练'
  }]
  if (opts.withOtherMemberBookings) {
    // 这里只是内存测试数据：验证“实际存在的别人课程占位、已取消课程释放”。
    // 15:00 / 16:00 不会写入业务代码，更不会变成固定禁约时间。
    stores['bookings'].push(
      { bookingId: 'bk-other-active', ownerCoachId: COACH_A, datasetId: DATASET_A, studentId: 'student-other', date: BOOKED_DATE, hour: 15, minute: 0, plannedMinutes: 60, status: 'booked', typeName: '常规训练' },
      { bookingId: 'bk-other-cancelled', ownerCoachId: COACH_A, datasetId: DATASET_A, studentId: 'student-other', date: BOOKED_DATE, hour: 16, minute: 0, plannedMinutes: 60, status: 'cancelled', typeName: '常规训练' }
    )
  }
  return stores
}

function serviceWith(stores, openId = OPENID_ZHANG) {
  // ⛔ 每次都清 require 缓存：确保吃到的是**当前磁盘上的真源码**（反证脚本靠这条把变异体喂进来）。
  for (const key of Object.keys(require.cache)) delete require.cache[key]
  const { createService } = require(MEMBER_READ)
  return createService({ db: makeDb(stores), getOpenId: () => openId })
}

// ─────────────────── 真页面（只替换 wx / Page / 云调用）───────────────────────────────
function openBookingPage(stores, options = {}) {
  const storage = {}
  Object.assign(storage, options.storage || {})
  const calls = []
  for (const key of Object.keys(require.cache)) delete require.cache[key]
  const { createService } = require(MEMBER_READ)
  const service = createService({ db: makeDb(stores), getOpenId: () => OPENID_ZHANG })

  global.wx = {
    getStorageSync: key => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : ''),
    setStorageSync: (key, value) => { storage[key] = value; return value },
    removeStorageSync: key => { delete storage[key] },
    getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
    showToast: () => { },
    showModal: arg => { (arg && arg.success) && arg.success({ confirm: true }) },
    navigateTo: () => { },
    redirectTo: () => { },
    stopPullDownRefresh: () => { },
    requestSubscribeMessage: arg => { if (arg && arg.complete) arg.complete({}) },
    cloud: {
      callFunction: async ({ name, data }) => {
        calls.push({ name, data })
        if (data && data.action === 'memberRead') {
          return { result: await service({ ...data, action: String(data.readAction || 'read'), environment: 'sandbox' }) }
        }
        return { result: { ok: false, code: 'UNROUTED' } }
      },
      getTempFileURL: async () => ({ fileList: [] })
    }
  }
  let page = null
  global.Page = object => { page = object; return object }
  // ⭐ 会员 dmz 是**测试区专属**：必须先把数据运行时切成 sandbox，
  //    否则整条请求会走正式区通道（`readMyMemberData`）⇒ 假世界里自然是空的。
  require(path.join(ROOT, 'utils', 'data-runtime')).setEnvironment('sandbox')
  require(SLOTS_JS)
  assert.ok(page, '页面没有把自己交给 Page()')
  // ⛔ setData 必须是**真合并**（目标是装置和真实机同一个心情：平台会合并后回填 this.data）
  page.setData = function (patch) { Object.assign(this.data, patch); this.data.dates = this.data.dates || [] }
  return { page, calls, storage }
}

function renderWxml(scope) {
  // 极简 WXML 求值：只为证明"选择教练"这一块在模板里**无条件渲染**（不在 wx:if 里藏着）
  const wxml = fs.readFileSync(SLOTS_WXML, 'utf8')
  return wxml
}

let passed = 0
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('PASS ' + name) })
    .catch(error => { console.error('FAIL ' + name + ': ' + error.message); process.exitCode = 1 })
}

async function main() {
  assert.notStrictEqual(MEMBER_ZHANG, LEGACY_MEMBER_ZHANG, '前置必须复现：专属资料编号与旧微信哈希编号不同')
  await test('① head 表完全查不到 ⇒ 约课链路**仍然**读到同一份张三 · 10 节 · A 教练', async () => {
    const service = serviceWith(seedRealDevice({ noHead: true }))
    const result = await service({ action: 'availability', date: FREE_DATE, environment: 'sandbox' })
    assert.strictEqual(result.availability, true, '必须是真正的只读投影，不是退化结果')
    assert.strictEqual((result.coaches || []).length, 1, 'A 教练必须在（不许因为 head 查不到就把人丢了）')
    assert.strictEqual(result.coaches[0].displayName, 'A教练')
    assert.strictEqual((result.packages || []).length, 1, '张三的 10 节课包必须在')
    assert.strictEqual(result.packages[0].typeName, '常规训练')
    assert.strictEqual(result.packages[0].remaining, 10)
  })

  await test('①b 专属二维码会员没有任何旧 claim ⇒ 仍按会员目录读到教练和课包', async () => {
    const result = await serviceWith(seedRealDevice({ noClaims: true }))({ action: 'availability', date: FREE_DATE, environment: 'sandbox' })
    assert.strictEqual(result.availability, true)
    assert.strictEqual(result.coaches.length, 1)
    assert.strictEqual(result.packages.length, 1)
  })

  await test('② head 表出现两条（账本不确定）⇒ 结果逐字相同（不许再被判成"不确定"跳过）', async () => {
    const service = serviceWith(seedRealDevice({ twoHeads: true }))
    const result = await service({ action: 'availability', date: FREE_DATE, environment: 'sandbox' })
    assert.strictEqual(result.coaches.length, 1)
    assert.strictEqual(result.packages[0].remaining, 10)
    assert.deepStrictEqual(result.warnings, [], 'head 有二义性不该再变成一条 warning 丢掉整份数据')
  })

  await test('③ 派生索引 accounts 缺失 / 不是 active ⇒ 不许再被判「未注册」', async () => {
    for (const opts of [{ noAccounts: true }, { accountInactive: true }]) {
      const service = serviceWith(seedRealDevice(opts))
      const read = await service({ action: 'read', environment: 'sandbox' })
      assert.notStrictEqual(read.state, 'unregistered', '会员明明已经在会员目录里，不许判成未注册')
      const avail = await service({ action: 'availability', date: FREE_DATE, environment: 'sandbox' })
      assert.strictEqual(avail.availability, true)
      assert.strictEqual(avail.coaches.length, 1)
      assert.strictEqual(avail.packages.length, 1)
    }
  })

  await test('④ 四种残缺形态返回的是**同一个** packageViewId（不许换一份数据源就换一个标识）', async () => {
    const shapes = [{}, { noHead: true }, { twoHeads: true }, { noAccounts: true }]
    const views = []
    for (const opts of shapes) {
      const result = await serviceWith(seedRealDevice(opts))({ action: 'availability', date: FREE_DATE, environment: 'sandbox' })
      views.push(result.packages[0].packageViewId)
    }
    assert.strictEqual(new Set(views).size, 1, '同一份真实课时包只许有一个不透明标识')
    // ⛔ 必须与**绑定时写好的 claimId** 同源 ⇒ 写路径才能认出它（不同源就是"看得见却约不了"）
    assert.strictEqual(views[0], fixedId('member-package-view', fixedId('member-directory-claim', MEMBER_ZHANG), 'pkg-zhang-10'))
  })

  await test('⑤ 读取成功的状态必须是 `ready`，且账面剩余 = 10', async () => {
    const read = await serviceWith(seedRealDevice({ noHead: true, noAccounts: true }))({ action: 'read', environment: 'sandbox' })
    assert.strictEqual(read.state, 'ready')
    assert.strictEqual(read.summary.remaining, 10)
    assert.strictEqual(read.summary.packageCount, 1)
    assert.strictEqual(read.member.displayName, '张三', '会员名不许因为派生索引缺失掉成空')
  })

  await test('⑥ 真页面：head 与 accounts 都残缺 ⇒ 仍然渲染出 A 教练 + 10 节课包', async () => {
    const { page } = openBookingPage(seedRealDevice({ noHead: true, noAccounts: true }))
    await page.load({ force: true })
    assert.strictEqual(page.data.coaches.length, 1, '界面必须真的有教练可选')
    assert.strictEqual(page.data.coaches[0].displayName, 'A教练')
    assert.strictEqual(page.data.packages.length, 1, '界面必须真的有课时包')
    assert.strictEqual(page.data.packages[0].remaining, 10)
    assert.ok(page.data.slots.length > 0, '必须算出可约时段（不是空课表）')
  })

  await test('⑥b Sandbox 清理后手机残留旧 archiveId ⇒ 必须采用本次服务端的新档案与课包', async () => {
    const stale = {
      environment: 'sandbox',
      archives: [{ archiveId: 'archive-from-previous-sandbox', displayName: '旧测试会员' }]
    }
    const { page } = openBookingPage(seedRealDevice({ noHead: true }), {
      storage: { 'coachMemberActiveCache:sandbox': stale, 'coachMemberCurrentArchive:sandbox': 'archive-from-previous-sandbox' }
    })
    await page.load({ force: true })
    assert.strictEqual(page.data.coaches.length, 1, '旧缓存不能盖掉本次服务端下发的教练')
    assert.strictEqual(page.data.packages.length, 1, '旧 archiveId 不能把新领取的真实课时包筛空')
    assert.strictEqual(page.data.packages[0].remaining, 10)
  })

  await test('⑦ 页面始终显示唯一「授课教练」，不再提供多教练选择器', async () => {
    const wxml = renderWxml()
    assert.ok(wxml.includes('授课教练'), '模板里必须有"授课教练"这一块')
    assert.ok(!wxml.includes('选择教练'), '⛔ 单教练产品仍显示"选择教练"')
    assert.ok(!/bindtap="pickCoach"/.test(wxml), '⛔ 单教练产品仍能切换教练')
    assert.ok(!/wx:if="\{\{coaches\.length\}\}"[^>]*class="member-section-title"/.test(wxml), '读取失败时授课教练标题也必须保留')
    // 没有教练时要明说原因
    assert.ok(wxml.includes('{{archiveEmpty'), '没有教练时必须显示人话原因，不留一片空白')
  })

  await test('⑧ availability 必须真的按**所选教练**排除冲突（已排课的时段不可约）', async () => {
    const { page } = openBookingPage(seedRealDevice({ noHead: true }))
    await page.load({ force: true })
    const index = page.data.dates.findIndex(row => row.key === BOOKED_DATE)
    assert.ok(index >= 0, '构造的"已被占用的那天"必须在可选日期里')
    await page.pickDate({ currentTarget: { dataset: { index } } })
    const slot = page.data.slots.find(row => row.startText === '14:00')
    assert.ok(slot, '必须算出 14:00 这一格')
    assert.strictEqual(slot.available, false, '张三自己 14:00 有课 ⇒ 不许显示成可约')
    assert.strictEqual(slot.reason, 'booked')
  })

  await test('⑧b 只同步真实课程占用：别人已预约会禁约，已取消课程立即释放', async () => {
    const stores = seedRealDevice({ noHead: true, withOtherMemberBookings: true })
    const service = serviceWith(stores)
    const projection = await service({ action: 'availability', date: BOOKED_DATE, environment: 'sandbox' })
    assert.ok(projection.busy.some(row => row.start === 15 * 60 && row.end === 16 * 60), '实际存在的 15:00 课程必须同步为占用')
    assert.ok(!projection.busy.some(row => row.start === 16 * 60), '已取消的 16:00 课程不能继续占位')

    const { page } = openBookingPage(stores)
    await page.load({ force: true })
    const index = page.data.dates.findIndex(row => row.key === BOOKED_DATE)
    await page.pickDate({ currentTarget: { dataset: { index } } })
    assert.strictEqual(page.data.slots.find(row => row.startText === '15:00').available, false, '真实占用必须在会员端显示不可约')
    assert.strictEqual(page.data.slots.find(row => row.startText === '16:00').available, true, '取消后必须恢复可约')
  })

  await test('⑨ 技术失败不许伪装成"没有可约时间"', async () => {
    const wxml = renderWxml()
    const source = fs.readFileSync(SLOTS_JS, 'utf8')
    assert.ok(source.includes('READ_FAILED_TEXT'), '必须有一条专门的"读取失败"文案')
    assert.ok(source.includes('暂时读取失败'), '文案必须明说"失败"，不许说成"没有可约时间"')
    // ⛔ 退化路径里不得再出现"读不到就说没有可约教练"的旧话术
    assert.ok(!source.includes('暂时没有可约的教练'), '旧话术不许复活：那是把故障伪装成"教练没空"')
    assert.ok(wxml.includes('这一天没有可约时间'), '只有当**真的读到**、确实没空位时才说"没有可约时间"')
  })

  await test('⑩ 首页与约课页必须能**互相认出同一位教练**（contactKey 同源）', async () => {
    const result = await serviceWith(seedRealDevice({ noHead: true }))({ action: 'availability', date: FREE_DATE, environment: 'sandbox' })
    assert.strictEqual(result.coaches[0].contactKey, CONTACT_KEY_A, '约课页下发的 contactKey 必须与首页同一算法')
    // ⛔ 两边算法一漂移 ⇒ 首页点了 A 教练跳进约课页却选不中 A
    const readSrc = fs.readFileSync(MEMBER_READ, 'utf8')
    const dirSrc = fs.readFileSync(DIRECTORY, 'utf8')
    const readExpr = /const coachContactKey = coachId => fixedId\('([^']+)', '([^']+)', coachId\)/.exec(readSrc)
    const dirExpr = /contactKey: fixedId\('([^']+)', role, id\)/.exec(dirSrc)
    assert.ok(readExpr, '约课侧取不到 contactKey 公式')
    assert.ok(dirExpr, '首页侧取不到 contactKey 公式')
    assert.strictEqual(readExpr[1], dirExpr[1], `两边的 contactKey 命名空间不一致（${readExpr[1]} vs ${dirExpr[1]}）`)
    assert.strictEqual(readExpr[2], 'coach', '教练角色名必须与首页一致')
  })

  await test('⑪ 即使旧数据里存在第二位教练，约课页也固定使用主教练', async () => {
    const { page } = openBookingPage(seedRealDevice({ noHead: true }))
    page.onLoad({ coach: CONTACT_KEY_A })
    await page.load({ force: true })
    assert.strictEqual(page.data.coachIndex, 0)
    // 历史多教练数据仍保留在后台，但单教练产品不向会员开放切换。
    const stores = seedRealDevice({ noHead: true })
    stores['coach_sandbox_member_authorizations'] = []
    stores['coach_sandbox_package_grants'] = [{
      ownerCoachId: COACH_A, datasetId: DATASET_A, studentId: STUDENT_ZHANG, packageId: 'pkg-zhang-10',
      coachId: 'coach-b-teaching', status: 'active'
    }]
    stores['coach_sandbox_heads'] = [{ _id: fixedId('coach-sandbox-head', 'coach-b-teaching'), ownerCoachId: 'coach-b-teaching', activeDatasetId: 'dataset-b', environment: 'sandbox', headVersion: 1 }]
    stores['member_sandbox_coach_profiles'].push({ coachId: 'coach-b-teaching', displayName: 'B教练', discoverable: true, publicCode: 'C0005678' })
    const second = openBookingPage(stores)
    second.page.onLoad({ coach: fixedId('member-contact-view', 'coach', 'coach-b-teaching') })
    await second.page.load({ force: true })
    assert.strictEqual(second.page.data.coaches.length, 1, '正式约课页只允许一个主教练')
    assert.strictEqual(second.page.data.coaches[0].displayName, 'A教练', '旧 B 教练参数不能覆盖主教练')
    assert.strictEqual(second.page.data.coachIndex, 0)
  })

  await test('⑫ 客户端伪造身份 / 定位字段 ⇒ 一律拒，零集合访问', async () => {
    const service = serviceWith(seedRealDevice())
    const forged = await service({ memberId: MEMBER_ZHANG, ownerCoachId: COACH_A, action: 'availability', environment: 'sandbox' })
    assert.strictEqual(forged.ok, false)
    assert.strictEqual(forged.code, 'FORBIDDEN_IDENTITY_INPUT')
    const nested = await service({ action: 'availability', payload: { studentId: 'someone-else' }, environment: 'sandbox' })
    assert.strictEqual(nested.code, 'FORBIDDEN_IDENTITY_INPUT')
  })

  await test('⑬ 静态：约课页不再用"档案读不到"把整页挡成一个错误页', async () => {
    const source = fs.readFileSync(SLOTS_JS, 'utf8')
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
    assert.ok(!stripped.includes('view.NEED_ARCHIVE_CHOICE'), '不许再有"请先选择当前使用的训练档案"这道闸门')
    assert.ok(!stripped.includes('view.NO_COACH_FOR_ARCHIVE'), '旧档案维度的空态文案不许复活')
    // ⛔ 也不许再有" archivedEmpty 为真就 return"的早退
    assert.ok(!/if\s*\(this\.data\.archiveEmpty\)\s*\{[\s\S]{0,200}return/.test(stripped), '不允许"档案有问题就整页 return"的早退')
  })

  await test('⑭ 静态：会员定位只有 `memberScodes`/`memberScopes` 一个真相源', async () => {
    const source = fs.readFileSync(MEMBER_READ, 'utf8')
    assert.ok(source.includes('async function memberScopes'), '必须有统一的「会员 ⇒ 服务关系」解析出口')
    assert.ok(source.includes('function resolveMemberPlace'), '必须有「会员真实位置」解析')
    // ⛔ 主判据不许再去查 head：`headFor` 只在 B 教练那条支线（他自己的账本）出现
    const uses = source.split('headFor(').length - 1
    assert.ok(uses <= 2, 'headFor 的调用次数过多（主教练那一条不许再查 head）')
    assert.ok(/!\(\(account && account\.status === 'active'\) \|\| row\)/.test(source), '「是否注册」必须以会员主资料为准，不能只认派生索引')
  })
}

main().then(() => {
  if (process.exitCode) { console.error('存在失败项') ; process.exit(1) }
  console.log(`member self-booking identity tests: PASS (${passed}/${passed})`)
}).catch(error => { console.error('FATAL', error); process.exit(1) })
