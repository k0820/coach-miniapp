// M2 V1 四组 B 类测试的**共用假服务端**（2026-09-29）。
//
// 为什么抽出来：四个测试要的是同一件事 —— 把**真实的** `coachBusinessCommand` 跑在一个假 CloudBase 上，
// 再把**真实的**页面模块跑在一个假 `wx` 上。四份手写假件早晚漂移（这正是"假件比真服务端宽松"的来源），
// 所以只留这一份，四个测试共用。
//
// ⛔ 假件只比真服务端**更严**，绝不放宽：
// · 命令一律走**真** handlers（网络那一层是假的，业务那一层是真的）；
// · 云写契约照旧 `doc(id).set({data})`（`_id` 由假 db 补，与真 CloudBase 一致）；
// · 真机支持多种 CloudBase 查询写法这里只补需要的那几种，`$gt` 等同构实现。
const { META, SANDBOX_META, coachIdFor, fixedId, createService } = require('../../cloudfunctions/coachBusinessCommand/core')
const { handlers } = require('../../cloudfunctions/coachBusinessCommand/handlers')

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
// ⚠️ 每一个**会被事务写入**的集合都必须登记在这里。原因（踩过的坑）：
//    `runTransaction` 提交时只把 `stores` 里**已存在**的名字拷回去 ⇒ 事务里新建的集合**会被丢掉**，
//    于是"事件写进假世界看不见" ⇒ 测试变成假绿（真机上却是好的）。新加集合时先来这里登记。
const COLLECTIONS = [...new Set([
  ...Object.values(META), ...Object.values(SANDBOX_META),
  'students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises',
  'member_sandbox_coach_profiles', 'member_sandbox_student_claims',
  // M3-P6：通知事件（取消 / 改期的"要通知另一方"落在这张表里）。
  'member_notification_events', 'member_sandbox_notification_events',
  'member_student_claims',
  // ⭐ M3-P2-3：`memberIdentityCommand`（会员身份云函数）用的集合。
  //   ⛔ 原来这里**一个都没登记** —— 而假件 `runTransaction` 提交时只把 `stores` 里**已存在**的名字
  //      拷回去 ⇒ 事务里新建的集合会被**整个丢掉**，测试看不见写入 ⇒ 假绿（真机却是好的）。
  //      同一个坑在 M3-P6 已经踩过一次（见上面通知事件那两行的注释）⇒ 新用到的集合先来这里登记。
  'member_accounts', 'member_sandbox_accounts',
  'member_claim_tokens', 'member_sandbox_claim_tokens',
  'member_receipts', 'member_sandbox_receipts',
  'member_revisions', 'member_sandbox_revisions',
  'member_coach_shortcuts', 'member_sandbox_coach_shortcuts',
  // ⭐ 2026-10-06 新会员方案（唯一会员 + 双向联系人，⛔ 只存在于 Sandbox）：
  //   不登记就会踩上面那个坑 —— 事务里新建的集合会被提交**整个丢掉** ⇒ 测试假绿。
  'member_sandbox_directory', 'member_sandbox_members', 'member_sandbox_contacts',
  'member_sandbox_contact_tickets', 'member_sandbox_contact_audit',
  // M2 双层授权（"添加联系人 ⇒ 立刻能排课"复用它，同样必须先登记）
  'coach_sandbox_member_authorizations', 'coach_sandbox_package_grants'
])]

function matchesQuery(row, query) {
  return Object.keys(query).every(key => {
    const expected = query[key]
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && Object.prototype.hasOwnProperty.call(expected, '$gt')) {
      return Number(row[key]) > Number(expected.$gt)
    }
    return row[key] === expected
  })
}

function createWorld() {
  const stores = Object.fromEntries(COLLECTIONS.map(name => [name, new Map()]))
  const calls = [], modals = [], toasts = []
  // ⭐ M3-P0：被显式标记为"真环境里不存在"的集合（默认空 = 全部存在，与老测试的行为逐字一致）。
  const missing = new Set()
  let queue = Promise.resolve()
  let openId = ''
  let clock = 1900000000000
  let currentActor = null

  function scope(target) {
    return {
      command: { gt: value => ({ $gt: value }) },
      collection(name) {
        // ⭐ M3-P0：在这里模拟真 CloudBase 的 `-502005 Db or Table not exist`。
        //   ⛔ 旧假件**永远不报这个错**（`target[name]` 不存在就自动新建 Map）⇒ 真机上
        //      "集合忘了建"这一类故障在本地 151 个测试里**一次都测不到** —— 这正是 P0 逃逸的原因。
        //      ⇒ 假件必须比真服务端**更严**，所以补上这个缺口。
        if (missing.has(name)) {
          const absent = () => {
            const error = new Error(`Db or Table not exist: ${name}`)
            error.errCode = -502005
            return Promise.reject(error)
          }
          return {
            doc: () => ({ set: absent, remove: absent }),
            where: () => { const api = { limit() { return api }, skip() { return api }, get: absent }; return api }
          }
        }
        if (!target[name]) target[name] = new Map()
        return {
          doc(id) {
            return {
              async get() { const row = target[name].get(id); return row ? { data: copy(row) } : { data: null } },
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
                const found = [...target[name].values()].filter(row => matchesQuery(row, query))
                return { data: found.slice(offset, offset + limit).map(copy) }
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
    async createCollection(name) {
      if (!stores[name]) stores[name] = new Map()
      missing.delete(name)
      return { errMsg: 'createCollection:ok' }
    },
    runTransaction(work) {
      const run = queue.then(async () => {
        const draft = Object.fromEntries(Object.entries(stores).map(([name, rows]) => [name, new Map([...rows].map(([id, row]) => [id, copy(row)]))]))
        const result = await work(scope(draft))
        for (const name of Object.keys(stores)) {
          stores[name].clear()
          for (const [id, row] of draft[name]) stores[name].set(id, copy(row))
        }
        return result
      })
      queue = run.catch(() => {})
      return run
    }
  }

  const main = () => createService({ db, getOpenId: () => openId, handlers, now: () => ++clock })
  const put = (name, id, data) => stores[name].set(id, { ...copy(data), _id: id })
  const businessId = (n, owner, datasetId, id) => fixedId(`coach-business-${n}`, owner, `${datasetId}:${id}`)
  const rows = (n, owner, datasetId) => [...stores[n].values()].filter(row => row.ownerCoachId === owner && row.datasetId === datasetId)
  const dataRows = (n, owner, datasetId) => rows(n, owner, datasetId).map(row => row.data || {})
  const revisionOf = (owner, datasetId) => (rows(SANDBOX_META.revisions, owner, datasetId)[0] || {}).dataRevision

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

  // execute 一次命令：**只比真客户端多一件东西** —— 把当前"我是谁"换成这次的执行者。
  async function execute(actor, command, payload, requestId) {
    openId = actor.open
    // ⚠️ requestId 必须覆盖**整份** payload：早先版本取 JSON 的前 24 个 hex 字符，
    //    两条前缀相同（{"studentId":"stu-c","public…）的命令会撞号 ⇒ REQUEST_ID_CONFLICT，
    //    那是**假件的缺陷**，不是服务端的问题（真客户端的号由 intent 生成，不会这样撞）。
    const digest = require('crypto').createHash('sha1').update(JSON.stringify({ command, payload })).digest('hex').slice(0, 24)
    return main()({
      action: 'execute', environment: 'sandbox',
      envelope: { command, requestId: requestId || `m2w_${command}_${digest}`, expectedRevision: revisionOf(actor.owner, actor.datasetId), payload }
    })
  }
  async function readDirectory(actor) {
    openId = actor.open
    return main()({ action: 'authorization', read: 'directory', environment: 'sandbox' })
  }

  const storage = {}
  function installRuntime() {
    global.wx = {
      storage,
      getStorageSync: key => storage[key],
      setStorageSync: (key, value) => { storage[key] = value },
      removeStorageSync: key => { delete storage[key] },
      cloud: {
        callFunction: async ({ name, data }) => {
          if (name !== 'coachBusinessCommand') throw new Error(`未预期的云调用 ${name}`)
          return { result: await main()(data) }
        }
      },
      showToast: payload => toasts.push(payload),
      showModal: payload => modals.push(payload),
      setClipboardData: () => {}, navigateTo: () => {}, pageScrollTo: () => {}, stopPullDownRefresh: () => {}, hideTabBar: () => {}, showTabBar: () => {}
    }
    return storage
  }

  // 假 mutate：让**真页面**发出的命令落到**真 handlers**，并把 payload 记下来供断言。
  // ⛔ 只有这一条写入口与真 `utils/mutate.js` 同位置（页面 require 到的是这个替身）。
  // ⚠️ 真 `utils/mutate.js` 有两种调用形态，这里必须**同字形都认**：
  //   mutate(command, payload)              —— 多云页面用的简写；
  //   mutate(null, null, {command, payload})—— 学员页 / 统计页用的完整形态。
  //  只认前一种，学员页那条保存链会拿到 command=null ⇒ 测试变成在测空气。
  function installFakeMutate() {
    const id = require.resolve('../../utils/mutate')
    const fake = async (a, b, options) => {
      const command = a || (options && options.command)
      const payload = b || (options && options.payload)
      calls.push({ command, payload: copy(payload) })
      return execute(currentActor, command, payload, options && options.requestId)
    }
    fake.mutate = fake
    fake.isCloudWritePath = () => true
    fake.localFirstEnabled = () => false
    fake.STRATEGIES = { SILENT: 'silent' }
    require.cache[id] = { id, filename: id, loaded: true, exports: fake, children: [], paths: [] }
    return fake
  }

  function setActor(coach) { currentActor = coach; openId = coach.open }

  function reset() {
    Object.values(stores).forEach(map => map.clear())
    missing.clear()
    calls.length = 0; modals.length = 0; toasts.length = 0
    for (const key of Object.keys(storage)) delete storage[key]
    queue = Promise.resolve()
    clock = 1900000000000
  }

  // 真实页面实例：`setData` 支持小程序原生的 `a.b.c` 路径写法。
  function enterPage(pageRelativePath) {
    let captured = null
    global.Page = config => { captured = config }
    const full = require.resolve(pageRelativePath)
    delete require.cache[full]
    require(full)
    if (!captured) throw new Error(`${pageRelativePath} 必须调用 Page()`)
    return Object.assign(Object.create(null), captured, {
      data: copy(captured.data),
      // 支持小程序原生写法：setData(patch, callback) + 'booking.packageId' 这种路径。
      setData(patch, callback) {
        Object.keys(patch || {}).forEach(key => {
          // 小程序原生路径：`a.b`、`a[0].b` 都要支持（`pages/students` 大量用 `form.packages[0].x`）。
          const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
          if (parts.length === 1) { this.data[key] = patch[key]; return }
          let target = this.data
          for (const part of parts.slice(0, -1)) target = target[part] = target[part] || {}
          target[parts[parts.length - 1]] = patch[key]
        })
        if (typeof callback === 'function') callback.call(this)
      }
    })
  }

  return {
    stores, copy, calls, modals, toasts, storage, db,
    main, put, rows, dataRows, businessId, revisionOf, execute, readDirectory,
    seedCoach, seedStudent, setActor, installRuntime, installFakeMutate, enterPage, reset,
    // ⭐ M3-P0：模拟"这个集合在真环境里不存在"（`-502005`）。
    missCollection: name => { missing.add(name) },
    restoreCollection: name => { missing.delete(name) },
    missingCollections: () => [...missing],
    get actor() { return currentActor },
    setOpenId(value) { openId = value }
  }
}

function runner(name, fn) {
  return fn().then(
    () => process.stdout.write(`PASS ${name}\n`),
    error => { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
  )
}

module.exports = { createWorld, runner, copy }
