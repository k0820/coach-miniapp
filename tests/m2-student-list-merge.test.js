// M2 V1 教练端学员列表整合（2026-09-28）。
//
// ★★ 产品决定 ★★
//   被授权服务的会员与教练自己创建的会员，在**同一个「我的学员」列表**里、用**同一张会员卡片**；
//   首页不再出现「授权给我服务的会员」专区、「档案所在 XXXXX」、「会员不属于任何教练」这些机制说明。
//
// ★★ 本文件盯的是**合并会不会越界** ★★
//   · 合并的是**列表的数据来源**，不是底层会员实体 ⇒ 授权会员绝不写进 db.students / packages / sales；
//   · 去重按**归属**（place.datasetId + studentId），⛔ 绝不按姓名 / 手机号自动合并；
//   · 授权会员正常参与人数 / A-Z 索引 / 课时展示 / 续费提醒；
//   · 点开授权会员卡 ⇒ 只读详情（有权限的课包 / 预约 / 共享训练历史），**没有**编辑 / 销售 / 备注 / 金额。
//
// 跑的是**真实学员页**（stub `Page` / `wx`），数据来源：本机 Sandbox 快照 + 授权目录缓存那一帧（零云调用）。

const assert = require('assert')
const path = require('path')
const runtime = require('../utils/data-runtime')

const PROJ = path.join(__dirname, '..')
const PAGE_FILE = path.join(PROJ, 'pages/students/students.js')
const MY_DATASET = 'ds-b'
const DIR_KEY = 'coachAuthorizationDirectory_sandbox'
const CACHE_KEY = 'coachSandboxActiveCache'
// ⭐ 2026-09-29：授权目录缓存按「环境 + 可信教练身份」分键。
//    学员页走的是 `cachedDirectory()`（零云调用）⇒ 必须先把"这一帧属于谁"写进去，
//    否则测试会退化成"身份没确认 ⇒ 什么都不显示"，测不到合并本身。
const authorization = require('../utils/coach-authorization')
const MY_COACH_ID = 'coach-b'

const copy = value => JSON.parse(JSON.stringify(value))
function setPath(target, key, value) {
  const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
  let node = target
  for (const part of parts.slice(0, -1)) node = node[part] && typeof node[part] === 'object' ? node[part] : (node[part] = {})
  node[parts[parts.length - 1]] = value
}

// 一本本地账（Sandbox 快照）+ 一份授权目录缓存，都是**页面真实会读到的两个来源**。
function installWorld({ locals = [], serving = [], threshold = 3, directoryError = null } = {}) {
  const storage = {}
  storage[CACHE_KEY] = {
    environment: 'sandbox', datasetId: MY_DATASET, revision: 1,
    snapshot: {
      students: copy(locals), bookings: [], incomes: [], sales: [],
      settings: { renewThreshold: threshold, monthlyGoalSessions: 20 }, customExercises: []
    }
  }
  if (!directoryError) {
    storage[authorization.identityKey('sandbox')] = { environment: 'sandbox', coachId: MY_COACH_ID, savedAt: Date.now() }
    storage[authorization.cacheKey('sandbox', MY_COACH_ID)] = {
      environment: 'sandbox', coachId: MY_COACH_ID, savedAt: Date.now(),
      data: { serving: copy(serving), managed: [], truncated: false }
    }
  }
  const cloudCalls = []
  global.wx = {
    cloud: { callFunction: async () => { cloudCalls.push(1); return { result: { ok: true } } } },
    getStorageSync: key => (key in storage ? storage[key] : ''),
    setStorageSync: (key, value) => { storage[key] = copy(value) },
    removeStorageSync: key => { delete storage[key] },
    showToast: () => {}, showModal: () => {}, hideTabBar: () => {}, showTabBar: () => {},
    navigateTo: () => {}, pageScrollTo: () => {}, createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => {} }), selectViewport: () => ({ scrollOffset: () => {} }), exec: () => {} })
  }
  runtime.setEnvironment('sandbox')
  return { storage, cloudCalls }
}
function enterStudentsPage() {
  let definition = null
  global.Page = value => { definition = value }
  delete require.cache[require.resolve(PAGE_FILE)]
  require(PAGE_FILE)
  const instance = {
    data: copy(definition.data),
    setData(patch) { Object.entries(patch || {}).forEach(([key, value]) => setPath(this.data, key, value)) }
  }
  Object.keys(definition).forEach(key => { if (typeof definition[key] === 'function') instance[key] = definition[key].bind(instance) })
  return instance
}
const localStudent = (id, name, packages = []) => ({ id, name, phone: '13900000001', abbr: '', status: 'active', packages })
const localPkg = (id, type, total, remaining) => ({ id, type, total, remaining, used: total - remaining, price: 300, status: 'active', saleDate: '2026-09-01' })
const servingMember = (studentId, name, datasetId, packages = []) => ({
  studentId, memberId: '', name, phone: '13800138000',
  place: { ownerCoachId: `owner-${datasetId}`, datasetId },
  managedByMe: false, packages, upcoming: [], history: []
})
const sharedPkg = (packageId, type, total, remaining) => ({
  packageId, type, total, remaining, used: total - remaining, reserved: 0,
  availableToBook: remaining, status: 'active', saleDate: '2026-09-01', canManage: false
})

async function test(name, fn) {
  try { await fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}

;(async () => {
  // ————— ① 同一个列表、同一种卡片：不再分成上下两区
  await test('① 自有会员与授权会员合成**同一个列表**（都在 students / groups 里，不再有独立专区）', async () => {
    installWorld({
      locals: [localStudent('s-1', '测试学员小蓝', [localPkg('p-1', '常规训练', 10, 6)]), localStudent('s-2', '测试学员红', [localPkg('p-2', '常规训练', 8, 8)])],
      serving: [servingMember('stu-a', 'M2 共享测试学员', 'ds-a', [sharedPkg('pkg-a', '常规训练', 5, 5)])]
    })
    const page = enterStudentsPage()
    page.render()
    assert.equal(page.data.students.length, 3, `三个人都应在同一个列表里（实测 ${page.data.students.length}）`)
    const names = page.data.students.map(item => item.name).sort()
    assert.deepStrictEqual(names, ['M2 共享测试学员', '测试学员小蓝', '测试学员红'].sort())
    // 同一个分组体系：授权会员也在 groups 里（列表页只渲染 groups ⇒ 不在 groups 就等于没合并）。
    const flat = page.data.groups.reduce((sum, group) => sum + group.students.length, 0)
    assert.equal(flat, 3, '授权会员必须真的进入 A-Z 分组')
    // 卡片形状一致：授权会员也带 visiblePackages / balancePercent 这些本地卡片字段。
    const authorized = page.data.students.find(item => item.name === 'M2 共享测试学员')
    assert.equal(authorized.authorized, true)
    assert.equal(authorized.visiblePackages.length, 1)
    assert.equal(authorized.visiblePackages[0].left, 5)
    assert.equal(typeof authorized.visiblePackages[0].balancePercent, 'number')
    assert.equal(typeof authorized.visiblePackages[0].color, 'string', '颜色沿用同一套 Design System（TYPES.color）')
  })

  // ————— ② 顶部人数包含授权会员
  await test('② 学员数量包含授权会员（人数 = 列表长度）', async () => {
    installWorld({
      locals: [localStudent('s-1', '测试学员小蓝', [localPkg('p-1', '常规训练', 10, 6)])],
      serving: [servingMember('stu-a', 'M2 共享测试学员', 'ds-a', [sharedPkg('pkg-a', '常规训练', 5, 5)])]
    })
    const page = enterStudentsPage()
    page.render()
    assert.equal(page.data.students.length, 2)
    // 首页顶部那个数字直接读 students.length ⇒ 合进列表就等于进了人数。
    assert.equal(page.data.students.filter(item => item.authorized).length, 1)
  })

  // ————— ③ A-Z 索引与续费提醒都带上授权会员
  await test('③ 授权会员参与 A-Z 索引与续费提醒', async () => {
    installWorld({
      locals: [localStudent('s-1', '测试学员小蓝', [localPkg('p-1', '常规训练', 10, 8)])],
      serving: [servingMember('stu-a', 'M2 共享测试学员', 'ds-a', [sharedPkg('pkg-a', '常规训练', 5, 2)])],
      threshold: 3
    })
    const page = enterStudentsPage()
    page.render()
    const letters = page.data.groups.map(group => group.letter)
    const authorized = page.data.students.find(item => item.name === 'M2 共享测试学员')
    assert.ok(letters.includes(authorized.searchLetter), `授权会员的字母必须出现在索引里（实测 ${letters}）`)
    assert.ok(page.data.alphabet.some(item => item.letter === authorized.searchLetter && item.active), '字母轨上也要点亮')
    // 剩余 2 <= 阈值 3 ⇒ 进入续费提醒。
    assert.equal(page.data.renewCount, 1, '授权会员的低课时课包也要进续费提醒')
    assert.equal(page.data.renewList[0].id, authorized.id)
  })

  // ————— ④ 去重：同归属同一会员只出现一次；同名绝不自动合并
  await test('④ 去重按归属（datasetId + studentId），同名同号的两位会员仍各占一张卡', async () => {
    // ④-a 目录里给出两条**同一个人**的条目（同一 place、同一 studentId）⇒ 只能出现一张卡。
    installWorld({
      locals: [],
      serving: [
        servingMember('stu-a', 'M2 共享测试学员', 'ds-a', [sharedPkg('pkg-a', '常规训练', 5, 5)]),
        servingMember('stu-a', 'M2 共享测试学员', 'ds-a', [sharedPkg('pkg-b', '拉伸放松', 3, 3)])
      ]
    })
    let page = enterStudentsPage()
    page.render()
    assert.equal(page.data.students.length, 1, '同一个人（同归属同 studentId）只许出现一张卡')

    // ④-b 不同账本里的两位**同名同号**会员 ⇒ **绝不合并**（合并就违背"会员身份只从可信映射来"）。
    //     ⚠️ 这一条专治"偷懒去重"：按姓名 / 手机号合并的写法在这里必须当场红。
    installWorld({
      locals: [localStudent('s-1', '测试学员小蓝', [localPkg('p-1', '常规训练', 10, 6)])],
      serving: [Object.assign(servingMember('stu-x', '测试学员小蓝', 'ds-a', [sharedPkg('pkg-a', '常规训练', 5, 5)]), { phone: '13900000001' })]
    })
    page = enterStudentsPage()
    page.render()
    assert.equal(page.data.students.length, 2, '同名不同人必须是两张卡（禁止按姓名合并）')
    assert.deepStrictEqual(page.data.students.map(item => item.name), ['测试学员小蓝', '测试学员小蓝'])

    // ④-c 这条授权条目本来就属于我自己这本账 ⇒ 本地那张卡已代表它，不许重复出现。
    installWorld({
      locals: [localStudent('stu-a', 'M2 共享测试学员', [localPkg('p-1', '常规训练', 10, 6)])],
      serving: [servingMember('stu-a', 'M2 共享测试学员', MY_DATASET, [sharedPkg('pkg-a', '常规训练', 5, 5)])]
    })
    page = enterStudentsPage()
    page.render()
    assert.equal(page.data.students.length, 1, '属于自己这本账的同一位会员不得出现两次')
    assert.equal(page.data.students[0].authorized, undefined, '自己账里的就是本地那张卡')

    // ④-d 两个**不同账本**里的同名同号会员 ⇒ 也是两张卡（去重只看归属，不看姓名/手机号）。
    installWorld({
      locals: [],
      serving: [
        Object.assign(servingMember('stu-p', '测试学员小蓝', 'ds-x', [sharedPkg('pkg-p', '常规训练', 5, 5)]), { phone: '13900000009' }),
        Object.assign(servingMember('stu-q', '测试学员小蓝', 'ds-y', [sharedPkg('pkg-q', '常规训练', 5, 5)]), { phone: '13900000009' })
      ]
    })
    page = enterStudentsPage()
    page.render()
    assert.equal(page.data.students.length, 2, '不同账本里的同名同号会员必须是两张卡')
  })

  // ————— ⑤ 点授权会员卡 ⇒ 只读详情：有课包 / 预约 / 共享历史，**没有**编辑与销售
  await test('⑤ 点击授权会员卡片 ⇒ 只读详情（课包 / 预约 / 共享历史），不进编辑表单', async () => {
    installWorld({
      locals: [localStudent('s-1', '测试学员小蓝', [localPkg('p-1', '常规训练', 10, 6)])],
      serving: [servingMember('stu-a', 'M2 共享测试学员', 'ds-a', [sharedPkg('pkg-a', '常规训练', 5, 3)], )]
    })
    const page = enterStudentsPage()
    page.render()
    const authorized = page.data.students.find(item => item.name === 'M2 共享测试学员')
    page.edit({ currentTarget: { dataset: { id: authorized.id } } })
    assert.equal(page.data.form, null, '授权会员绝不能进本地编辑表单（那是本账的写入路径）')
    const detail = page.data.authorizedDetail
    assert.ok(detail, '必须打开授权会员详情')
    assert.equal(detail.name, 'M2 共享测试学员')
    assert.equal(detail.packages.length, 1)
    assert.equal(detail.packages[0].packageId, 'pkg-a')
    assert.equal(typeof detail.packages[0].occupancy, 'string')
    // 详情里绝不能出现本账的销售与隐私字段（销售金额 / 单价 / 备注 / 他人收入）。
    const serialized = JSON.stringify(detail)
    ;['saleAmount', 'amount', 'unitPrice', 'price', 'saleId', 'notes', 'coachPrivateNotes', 'privateNotes', 'summary'].forEach(field => {
      assert.ok(serialized.indexOf(`"${field}"`) < 0, `详情里不许出现 ${field}（隐私 / 销售归属）`)
    })
  })

  // ————— ⑥ 授权会员**绝不**写进本地业务数据
  await test('⑥ 合并只发生在视图层：db.students / packages / sales 一条都没多', async () => {
    const { storage } = installWorld({
      locals: [localStudent('s-1', '测试学员小蓝', [localPkg('p-1', '常规训练', 10, 6)])],
      serving: [servingMember('stu-a', 'M2 共享测试学员', 'ds-a', [sharedPkg('pkg-a', '常规训练', 5, 5)])]
    })
    const page = enterStudentsPage()
    page.render()
    page.edit({ currentTarget: { dataset: { id: page.data.students.find(item => item.authorized).id } } })
    const snapshot = storage[CACHE_KEY].snapshot
    assert.equal(snapshot.students.length, 1, '不许把授权会员写进本机学员表')
    assert.equal(snapshot.packages, undefined)
    assert.equal(snapshot.sales.length, 0, '不许产生第二份销售')
    assert.equal(snapshot.students[0].name, '测试学员小蓝')
  })

  // ————— ⑦ onShow 仍然零云调用（既有铁律：断网时不许朝云端发一个字节）
  await test('⑦ 渲染合并列表全程零云调用（onShow 只读缓存）', async () => {
    const { cloudCalls } = installWorld({
      locals: [localStudent('s-1', '测试学员小蓝', [localPkg('p-1', '常规训练', 10, 6)])],
      serving: [servingMember('stu-a', 'M2 共享测试学员', 'ds-a', [sharedPkg('pkg-a', '常规训练', 5, 5)])]
    })
    const page = enterStudentsPage()
    page.render()
    assert.equal(cloudCalls.length, 0, '合并渲染不许发云调用')
    assert.equal(page.data.students.length, 2)
  })

  // ————— ⑧ 目录读取失败：列表照常显示自有会员，且**显式**留一条可retry的提示
  await test('⑧ 授权目录没读到：自有会员照常显示，并留一条明确提示（不许静默假装没有）', async () => {
    installWorld({
      locals: [localStudent('s-1', '测试学员小蓝', [localPkg('p-1', '常规训练', 10, 6)])],
      directoryError: true
    })
    const page = enterStudentsPage()
    page.render()
    assert.equal(page.data.students.length, 1, '自有会员不受影响')
    assert.equal(page.data.authorizedFailed, false, '没有缓存帧时按"还没读过"处理，不谎报失败')
  })

  runtime.setEnvironment('production')
  if (!process.exitCode) process.stdout.write('ALL M2 STUDENT LIST MERGE TESTS PASSED\n')
})().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
