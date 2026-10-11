// ⭐ 2026-10-06：跨教练排课的**新出口**是「学员列表页」（`pages/students`）。
//
//   ⛳ 背景：旧的「多教练服务（授权）工作台」`pages/coach-authorization` 已随认领方案一并下线，
//       但那三个真机 BUG 的**根因形状**全都还在新出口上：
//         · BUG03  —— 提交必须带**真实** packageId（不许空、不许拿课程类型顶替）；
//         · BUG03b —— 授权目录那一帧缓存必须有**形状版本 + 内容闸**（旧帧不许被当成事实）；
//         · BUG05  —— 日期只能有**一个真相源**（显示 = 提交 = 落库）。
//      ⇒ 这三个文件共用同一套假世界：真 handlers + 假 CloudBase + **真的学员页**。
//
// ⛔ 假件只比真服务端**更严**，绝不放宽：
//   · 命令一律走真 handlers（网络那一层是假的，业务那一层是真的）；
//   · 页面是**真的** `pages/students/students.js`（只替 `Page` / `wx` / `mutate`）；
//   · 排课面板必须由页面自己组装 payload —— 手工构造正确 payload 的测试在这里过不去。

const path = require('path')
const { META, SANDBOX_META, coachIdFor, fixedId, createService } = require('../../cloudfunctions/coachBusinessCommand/core')
const { handlers } = require('../../cloudfunctions/coachBusinessCommand/handlers')
const cloudOccupancy = require('../../cloudfunctions/coachBusinessCommand/occupancy')
const authorization = require('../../utils/coach-authorization')
const runtime = require('../../utils/data-runtime')

const ROOT = path.join(__dirname, '..', '..')
const PAGE_FILE = path.join(ROOT, 'pages', 'students', 'students.js')
const CACHE_KEY = 'coachSandboxActiveCache'

const copy = value => JSON.parse(JSON.stringify(value))

// ⚠️ 每一个**会被事务写入**的集合都必须登记（假件 runTransaction 提交时只拷回已存在的名字）。
const COLLECTIONS = [...new Set([
  ...Object.values(META), ...Object.values(SANDBOX_META),
  'students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises',
  'member_sandbox_coach_profiles', 'member_sandbox_student_claims',
  'coach_sandbox_member_authorizations', 'coach_sandbox_package_grants'
])]

function createStudentsBookingWorld() {
  const stores = Object.fromEntries(COLLECTIONS.map(name => [name, new Map()]))
  const calls = [], modals = [], toasts = [], cloudCalls = []
  const storage = {}
  let queue = Promise.resolve()
  let openId = 'openid-a'
  let clock = 1900000000000
  let currentActor = null
  // 'ok' = 云端就是这一版；'stripShape' = 云端还是旧版（响应里没有 shape）；'offline' = 读不到云端。
  let cloudMode = 'ok'

  function scope(target) {
    return {
      collection(name) {
        if (!target[name]) target[name] = new Map()
        return {
          doc(id) {
            return {
              async set({ data }) { target[name].set(id, { ...copy(data), _id: id }); return { _id: id } },
              async remove() { target[name].delete(id); return { stats: { removed: 1 } } }
            }
          },
          where(query) {
            let limit = Infinity, offset = 0
            const api = {
              limit(value) { limit = value; return api },
              skip(value) { offset = value; return api },
              async get() {
                return { data: [...target[name].values()].filter(row => Object.keys(query).every(key => row[key] === query[key])).slice(offset, offset + limit).map(copy) }
              }
            }
            return api
          }
        }
      }
    }
  }
  const db = {
    ...scope(stores),
    runTransaction(work) {
      const run = queue.then(async () => {
        const draft = Object.fromEntries(Object.entries(stores).map(([name, rows]) => [name, new Map([...rows].map(([id, row]) => [id, copy(row)]))]))
        const result = await work(scope(draft))
        for (const name of Object.keys(stores)) { stores[name].clear(); for (const [id, row] of draft[name]) stores[name].set(id, copy(row)) }
        return result
      })
      queue = run.catch(() => {})
      return run
    }
  }
  // 真实客户端的 requestId 是**稳定**的（同一次意图同一个号 ⇒ 重发是幂等回放，不是再建一条预约）。
  function stableRequestId(command, payload, requestId) {
    if (requestId) return requestId
    return `sbw_${command}_${Buffer.from(JSON.stringify(payload)).toString('hex').slice(0, 24)}`
  }
  const main = () => createService({ db, getOpenId: () => openId, handlers, now: () => ++clock })
  const put = (name, id, data) => stores[name].set(id, { ...copy(data), _id: id })
  const businessId = (n, owner, datasetId, id) => fixedId(`coach-business-${n}`, owner, `${datasetId}:${id}`)
  const rows = (n, owner, datasetId) => [...stores[n].values()].filter(row => row.ownerCoachId === owner && row.datasetId === datasetId)
  const dataRows = (n, owner, datasetId) => rows(n, owner, datasetId).map(row => row.data || {})
  const revisionOf = (owner, datasetId) => (rows(SANDBOX_META.revisions, owner, datasetId)[0] || {}).dataRevision
  const occOf = (coach, packageId) => cloudOccupancy.occupancyOf(dataRows('packages', coach.owner, coach.datasetId).find(item => item.id === packageId))

  function seedCoach(open, datasetId, publicCode) {
    const owner = coachIdFor(open)
    put('coaches', owner, { openId: open, status: 'active' })
    put(META.datasets, fixedId('coach-dataset', owner, datasetId), { ownerCoachId: owner, datasetId, status: 'active', integrityStatus: 'verified', checksum: 'ok', byteSize: 1, summary: {}, schemaVersion: 1 })
    put(SANDBOX_META.heads, fixedId('coach-sandbox-head', owner), { ownerCoachId: owner, environment: 'sandbox', activeDatasetId: datasetId, headVersion: 1 })
    put(SANDBOX_META.revisions, fixedId('coach-sandbox-revision', owner, datasetId), { ownerCoachId: owner, datasetId, dataRevision: 0 })
    if (publicCode) put('member_sandbox_coach_profiles', fixedId('coach-public', owner), { coachId: owner, publicCode, displayName: `教练${publicCode}`, discoverable: true })
    return { open, owner, datasetId, publicCode }
  }
  const seedStudent = (coach, studentId, name) => put('students', businessId('students', coach.owner, coach.datasetId, studentId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, studentId, data: { id: studentId, name, phone: '13800138000', packages: [] }
  })

  function installRuntime(actor, installOptions = {}) {
    if (installOptions.clear !== false) for (const key of Object.keys(storage)) delete storage[key]
    // ⭐ 学员页 `render()` 会 `getDB()`：测试区**只认** coachSandboxActiveCache 这一份，
    //    读不到就抛 CLOUD_CACHE_MISSING（宁可报错也不回落正式区）⇒ 必须先摆一本空账进去。
    if (actor) {
      storage[CACHE_KEY] = {
        environment: 'sandbox', datasetId: actor.datasetId, revision: 0,
        snapshot: { students: [], bookings: [], incomes: [], sales: [], settings: { renewThreshold: 2, monthlyGoalSessions: 20 }, customExercises: [] }
      }
    }
    global.wx = {
      getStorageSync: key => (key in storage ? storage[key] : ''),
      setStorageSync: (key, value) => { storage[key] = copy(value) },
      removeStorageSync: key => { delete storage[key] },
      cloud: {
        callFunction: async ({ name, data }) => {
          if (name !== 'coachBusinessCommand') throw new Error(`未预期的云调用 ${name}`)
          cloudCalls.push({ data: copy(data), at: Date.now() })
          if (cloudMode === 'offline') throw new Error('network down')
          const result = await main()(data)
          // 模拟"云函数还是旧版"：新云函数会在目录响应里带 shape，旧版根本没这个字段。
          if (cloudMode === 'stripShape' && result && Object.prototype.hasOwnProperty.call(result, 'shape')) delete result.shape
          return { result }
        }
      },
      showToast: payload => toasts.push(payload),
      showModal: payload => modals.push(payload),
      setClipboardData: () => {}, navigateTo: () => {}, navigateBack: () => {},
      pageScrollTo: () => {}, stopPullDownRefresh: () => {}, hideTabBar: () => {}, showTabBar: () => {},
      showLoading: () => {}, hideLoading: () => {},
      createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => {} }), selectViewport: () => ({ scrollOffset: () => {} }), exec: () => {} })
    }
    runtime.setEnvironment('sandbox')
    return storage
  }

  // 假 mutate：只替**网络那一层**，命令照旧落到真 handlers；语义与真 `utils/mutate.js` 对齐
  // （成功 ⇒ onSuccess + successTitle toast；结果不明 / 冲突 ⇒ onRefresh）。
  function installFakeMutate() {
    const id = require.resolve('../../utils/mutate')
    const fake = async (a, b, options) => {
      const command = a || (options && options.command)
      const payload = b || (options && options.payload)
      calls.push({ command, payload: copy(payload) })
      openId = (currentActor || {}).open
      const result = await main()({
        action: 'execute', environment: 'sandbox',
        envelope: {
          command, requestId: stableRequestId(command, payload, options && options.requestId),
          expectedRevision: revisionOf(currentActor.owner, currentActor.datasetId), payload
        }
      })
      if (result && result.ok) {
        if (options && options.onSuccess) await options.onSuccess(result)
        if (options && options.successTitle) global.wx.showToast({ title: options.successTitle, icon: 'none' })
      } else if (result) {
        // ⛔ 真 mutate 的做法：被云端拒绝时**把云端给的码/文案如实弹出来**，前端不自己编。
        global.wx.showModal({ title: '操作未完成', content: result.message || result.code || '云端操作失败。', showCancel: false, confirmText: '知道了' })
      }
      return result
    }
    fake.mutate = fake
    fake.isCloudWritePath = () => true
    fake.localFirstEnabled = () => false
    fake.STRATEGIES = { SILENT: 'silent' }
    require.cache[id] = { id, filename: id, loaded: true, exports: fake, children: [], paths: [] }
    return fake
  }

  function setPath(target, key, value) {
    const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
    let node = target
    for (const part of parts.slice(0, -1)) node = node[part] && typeof node[part] === 'object' ? node[part] : (node[part] = {})
    node[parts[parts.length - 1]] = value
  }
  // 真的学员页实例（`setData` 支持小程序原生 `a.b[0].c` 路径写法）。
  function enterPage() {
    installFakeMutate()
    let captured = null
    global.Page = config => { captured = config }
    delete require.cache[require.resolve(PAGE_FILE)]
    require(PAGE_FILE)
    if (!captured) throw new Error('pages/students 必须调用 Page()')
    const instance = {
      data: copy(captured.data),
      setData(patch, callback) {
        Object.keys(patch || {}).forEach(key => setPath(this.data, key, patch[key]))
        if (typeof callback === 'function') callback.call(this)
      }
    }
    Object.keys(captured).forEach(key => { if (typeof captured[key] === 'function') instance[key] = captured[key].bind(instance) })
    return instance
  }

  // A 建会员 + 用 B 的公开码建销售（= 真机第 1~3 步）⇒ B 的授权目录里就有这位会员与那份课包。
  async function seedSharedScenario() {
    runtime.setEnvironment('sandbox')
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA')
    const B = seedCoach('openid-b', 'ds-b', 'PUBCODEB')
    seedStudent(A, 'stu-1', '跨教练排课测试会员')
    openId = A.open
    const sold = await main()({
      action: 'execute', environment: 'sandbox',
      envelope: {
        command: 'createCourseSale', requestId: 'sbw_sale', expectedRevision: revisionOf(A.owner, A.datasetId),
        payload: { studentId: 'stu-1', type: '常规训练', total: 5, remaining: 5, quantity: 5, unitPrice: 100, amount: 500, date: '2026-09-28', teachingPublicCodes: [B.publicCode] }
      }
    })
    if (!sold.ok) throw new Error(`（前置）销售必须建成：${JSON.stringify(sold)}`)
    return { A, B, packageId: sold.result.packageId }
  }

  async function execute(actor, command, payload, requestId) {
    openId = actor.open
    return main()({
      action: 'execute', environment: 'sandbox',
      envelope: { command, requestId: stableRequestId(command, payload, requestId), expectedRevision: revisionOf(actor.owner, actor.datasetId), payload }
    })
  }
  async function readDirectory(actor) {
    openId = actor.open
    return main()({ action: 'authorization', read: 'directory', environment: 'sandbox' })
  }

  // ⭐ 真机进入学员页的形状：`onLoad` + `onShow`（onShow 走缓存那一帧，零云调用）。
  async function openAs(coach, options = {}) {
    currentActor = coach
    openId = coach.open
    // ⚠️ 默认清 Storage（每个用例从头开始）；要模拟"B 再次进页面、缓存还在" ⇒ clearStorage:false。
    installRuntime(coach, { clear: options.clearStorage === false ? false : true })
    const page = enterPage()
    // ⚠️ 学员页自己没有 onLoad（入口由 auto-refresh 的 installPage 注入 onShow/onHide）
    //    ⇒ 不判空就会把 onLoad 当成必须存在，那是**假件比真页面更严**，不是真机的形状。
    if (typeof page.onLoad === 'function') await page.onLoad()
    await page.onShow()
    if (options.force !== false) await page.refreshAuthorized()
    return page
  }
  // 学员列表里那张**授权会员**卡（新出口：点卡 ⇒ 只读详情 ⇒ 详情里点排课）。
  function authorizedCardId(page) {
    const hit = (page.data.students || []).find(item => item && item.authorized)
    return hit ? String(hit.id) : ''
  }
  // 打开排课面板：**必须**走页面自己的入口（点卡 → 详情 → 排课），不许手工塞 data。
  function openBooking(page) {
    const id = authorizedCardId(page)
    if (!id) throw new Error(`（前置）学员列表里必须有那张授权会员卡（实测 ${JSON.stringify((page.data.students || []).map(i => i && i.id))}）`)
    page.openCard(id)
    page.openBooking()
    return page.data.booking
  }

  function reset() {
    Object.values(stores).forEach(map => map.clear())
    queue = Promise.resolve()
    clock = 1900000000000
    cloudMode = 'ok'
    openId = 'openid-a'
    calls.length = 0; modals.length = 0; toasts.length = 0; cloudCalls.length = 0
  }

  return {
    stores, storage, calls, modals, toasts, cloudCalls, copy,
    main, put, rows, dataRows, revisionOf, occOf, seedCoach, seedStudent,
    seedSharedScenario, execute, readDirectory, installRuntime, installFakeMutate,
    enterPage, openAs, authorizedCardId, openBooking, reset,
    authorization, cloudOccupancy, runtime, PAGE_FILE, CACHE_KEY,
    setActor(coach) { currentActor = coach; openId = coach.open },
    setCloudMode(mode) { cloudMode = mode },
    getCloudMode() { return cloudMode },
    get openId() { return openId },
    set openId(value) { openId = value }
  }
}

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => process.stdout.write(`PASS ${name}\n`),
    error => { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
  )
}

module.exports = { createStudentsBookingWorld, test, copy }
