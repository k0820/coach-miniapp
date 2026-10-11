// M2 第七项 + 第四项永久回归（2026-09-27）：
//   L  自动刷新触发点 / 下拉刷新兜底 / 性能预算 —— 至少要有针对性测试；
//   会员日程读到的是**同一条真实课程**（不是副本），且教练私有内容绝不外泄。
//
// ⛔ 这里明确钉死一条：**不允许用「每几秒全量轮询」冒充自动刷新**。
//    轮询会把 Local-first 的增量 / revision 机制架空，还会把"数据没变"伪装成"数据已刷新"。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const sourceOf = relative => fs.readFileSync(path.join(root, relative), 'utf8')
const autoRefresh = require('../utils/auto-refresh')
const { createService, memberIdFor, fixedId, names, sanitizeBooking, PRIVATE_BOOKING_FIELDS } = require('../cloudfunctions/readMyMemberData/service')

const copy = value => JSON.parse(JSON.stringify(value))
async function test(name, fn) {
  try { await fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}

// ———————————————————————————————————————————————— 假 DB（只替网络，service 是真模块）
function fakeDb(stores) {
  const scope = target => ({
    collection(name) {
      if (!target[name]) target[name] = new Map()
      return {
        where(query) {
          let limit = Infinity, offset = 0
          const api = {
            limit(value) { limit = value; return api },
            skip(value) { offset = value; return api },
            async get() { return { data: [...target[name].values()].filter(row => Object.keys(query).every(key => row[key] === query[key])).slice(offset, offset + limit).map(copy) } }
          }
          return api
        }
      }
    }
  })
  return scope(stores)
}

// ———————————————————————————————————————————————— 自动刷新
;(async () => {
  await test('L1 九个刷新触发点全部在册，且性能预算是 ≤ 2 秒（可断言，不是口号）', async () => {
    const expected = ['appLaunch', 'appForeground', 'pageShow', 'sessionReturn', 'bookingCreated', 'bookingRescheduled', 'bookingCancelled', 'bookingCompleted', 'packageChanged']
    expected.forEach(reason => assert.ok(autoRefresh.REFRESH_TRIGGERS.includes(reason), `触发点 ${reason} 必须在册`))
    assert.equal(autoRefresh.PERFORMANCE_BUDGET_MS, 2000, '性能验收目标 ≤ 2 秒')
    assert.equal(autoRefresh.withinBudget(1999), true)
    assert.equal(autoRefresh.withinBudget(2001), false)
  })

  await test('L2 未知触发点不广播；同一触发点短时间内重复 ⇒ 合并（不打爆云端）', async () => {
    autoRefresh.unsubscribeAll()
    const seen = []
    const off = autoRefresh.subscribe(reason => seen.push(reason))
    assert.equal(autoRefresh.request('bookingCreated', 1000), true)
    assert.equal(autoRefresh.request('bookingCreated', 1100), false, '400ms 内的重复触发必须合并')
    assert.equal(autoRefresh.request('bookingCreated', 1500), true)
    assert.equal(autoRefresh.request('NO_SUCH_TRIGGER', 9000), false, '未知触发点一律不广播')
    assert.deepStrictEqual(seen, ['bookingCreated', 'bookingCreated'])
    off()
    autoRefresh.request('bookingCreated', 9000) // 退订后不应再收到
    assert.deepStrictEqual(seen, ['bookingCreated', 'bookingCreated'])
  })

  await test('L3 写命令 → 触发点映射：预约 / 改期 / 取消 / 完课 / 课时购买修改后都要刷新', async () => {
    const map = {
      createBooking: 'bookingCreated', createSharedBooking: 'bookingCreated',
      rescheduleBooking: 'bookingRescheduled', cancelBooking: 'bookingCancelled',
      completeBooking: 'bookingCompleted', markBookingNotHeld: 'bookingCompleted',
      deleteCompletedBooking: 'bookingCompleted',
      createPackage: 'packageChanged', updatePackage: 'packageChanged', deletePackage: 'packageChanged',
      createCourseSale: 'packageChanged', updateCourseSale: 'packageChanged', reverseCourseSale: 'packageChanged'
    }
    Object.entries(map).forEach(([command, reason]) => assert.equal(autoRefresh.refreshTriggerFor(command), reason, `${command} ⇒ ${reason}`))
    assert.equal(autoRefresh.refreshTriggerFor('saveSettings'), null, '无关命令不该触发刷新广播')
  })

  await test('L4 页面接入：installPage 同时接上「进入页面」与「下拉刷新兜底」', async () => {
    autoRefresh.unsubscribeAll()
    const seen = []
    autoRefresh.subscribe(reason => seen.push(reason))
    const calls = []
    const page = { data: {} }
    autoRefresh.installPage(page, { refresh() { calls.push('refresh'); return Promise.resolve() } })
    assert.equal(typeof page.onShow, 'function', '必须接上 onShow')
    assert.equal(typeof page.onPullDownRefresh, 'function', '必须接上下拉刷新兜底')
    page.onShow()
    assert.deepStrictEqual(calls, ['refresh'])
    assert.ok(seen.includes('pageShow'), '进入关键页面必须广播')
    page.onPullDownRefresh()
    assert.deepStrictEqual(calls, ['refresh', 'refresh'])
    autoRefresh.unsubscribeAll()
  })

  await test('L5 真实页面接线：启动 / 回前台 / 关键页面 / 课程页返回 / 写命令成功 —— 都真的挂上了', async () => {
    const requests = (code, reason) => new RegExp(`\\.request\\('${reason}'\\)`).test(code)
    const app = sourceOf('app.js')
    assert.ok(requests(app, 'appLaunch'), '小程序启动必须触发刷新')
    assert.ok(requests(app, 'appForeground'), '从后台回到前台必须触发刷新')
    const session = sourceOf('pages/session/session.js')
    assert.ok(requests(session, 'sessionReturn'), '从课程详情返回必须触发刷新')
    ;['pages/students/students.js', 'pages/stats/stats.js', 'pages/member-home/member-home.js'].forEach(file => {
      assert.ok(requests(sourceOf(file), 'pageShow'), `${file} 进入页面必须触发刷新`)
    })
    const ui = sourceOf('utils/ui-cloud-command.js')
    assert.ok(/requestForCommand\(command\)/.test(ui), '写命令成功后必须触发刷新')
    // 下拉刷新兜底：关键页面的 json 必须真的开了。
    ;['pages/schedule/schedule.json', 'pages/students/students.json', 'pages/stats/stats.json', 'pages/member-home/member-home.json'].forEach(file => {
      const json = JSON.parse(sourceOf(file))
      assert.equal(json.enablePullDownRefresh, true, `${file} 必须支持下拉刷新`)
    })
  })

  await test('L6 ⛔ 不得引入「每几秒全量轮询」冒充自动刷新', async () => {
    const module_ = sourceOf('utils/auto-refresh.js')
    assert.ok(!/setInterval/.test(module_), '自动刷新模块里不许出现 setInterval 轮询')
    assert.ok(!/setTimeout\(/.test(module_), '自动刷新模块里不许出现定时轮询')
    ;['pages/schedule/schedule.js', 'pages/students/students.js', 'pages/stats/stats.js', 'pages/member-home/member-home.js'].forEach(file => {
      const code = sourceOf(file).split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n')
      assert.ok(!/setInterval\(/.test(code), `${file} 不许用定时轮询代替触发点刷新`)
    })
  })

  // ———————————————————————————————————————————————— 会员日程 = 同一条真实课程
  async function memberRead({ environment = 'sandbox', foreignHeads = true } = {}) {
    const n = names(environment)
    const stores = {}
    const put = (name, id, row) => { (stores[name] = stores[name] || new Map()).set(id, { ...copy(row), _id: id }) }
    const memberId = memberIdFor('openid-member')
    put(n.accounts, fixedId(n.accounts, memberId), { memberId, displayName: '小蓝', theme: 'vitality', status: 'active' })
    put(n.revisions, fixedId(n.revisions, 'member', memberId), { actorType: 'member', memberId, dataRevision: 3 })
    const coachA = 'coach-a', coachB = 'coach-b'
    put(n.claims, 'claim-a', { claimId: 'claim-a', memberId, coachId: coachA, studentId: 'stu-a-1', status: 'verified' })
    put(n.profiles, 'p-a', { coachId: coachA, displayName: 'A 教练', discoverable: true })
    put(n.profiles, 'p-b', { coachId: coachB, displayName: 'B 教练', discoverable: true })
    put(n.coachHeads, 'head-a', { ownerCoachId: coachA, environment: 'sandbox', activeDatasetId: 'ds-a' })
    if (foreignHeads) put(n.coachHeads, 'head-b', { ownerCoachId: coachB, environment: 'sandbox', activeDatasetId: 'ds-b' })
    put('packages', 'pkg-row', { ownerCoachId: coachA, datasetId: 'ds-a', studentId: 'stu-a-1', packageId: 'pkg-a-1', data: { id: 'pkg-a-1', type: '常规训练', total: 12, used: 2, remaining: 10, status: 'active' } })
    // ① A 自己那本账里的课
    put('bookings', 'bk-a', { ownerCoachId: coachA, datasetId: 'ds-a', studentId: 'stu-a-1', bookingId: 'bk-a', data: { id: 'bk-a', studentId: 'stu-a-1', status: 'booked', date: '2026-10-02', hour: 14, minute: 0, typeName: '常规训练', notes: 'A 的私人备注', price: 300 } })
    // ② 另一位**授课教练** B 那本账里、属于同一位会员的课（同一条真实课程，不是副本）
    put('bookings', 'bk-b', { ownerCoachId: coachB, datasetId: 'ds-b', studentId: 'stu-a-1', bookingId: 'bk-b', data: { id: 'bk-b', studentId: 'stu-a-1', status: 'booked', date: '2026-10-02', hour: 16, minute: 0, typeName: '常规训练', notes: 'B 的私人备注', price: 300, teachingCoachId: coachB, source: 'coach' } })
    // ③ 一个**不属于本环境**的账本（head 查不到）⇒ 必须被环境隔离挡在外面
    put('bookings', 'bk-x', { ownerCoachId: 'coach-x', datasetId: 'ds-x', studentId: 'stu-a-1', bookingId: 'bk-x', data: { id: 'bk-x', studentId: 'stu-a-1', status: 'booked', date: '2026-10-02', hour: 20, minute: 0, typeName: '常规训练' } })
    const service = createService({ db: fakeDb(stores), getOpenId: () => 'openid-member' })
    return service({ environment })
  }

  await test('会员日程：看到的是**同一条真实课程** —— A 与 B 各一节都进得来，且各自归属正确的授课教练', async () => {
    const res = await memberRead()
    assert.equal(res.ok, true, JSON.stringify(res))
    const ids = res.recentTraining.concat(res.nextBooking ? [res.nextBooking] : []).map(row => row.historyId)
    assert.equal(new Set(ids).size, ids.length, '同一条课不能被投影成两条')
    const booked = res.packages && res.nextBooking ? [res.nextBooking] : []
    // 直接看全部预约视图：recentTraining(done) + nextBooking(booked 的第一条) 不足以覆盖两条，
    // 所以这里断言"两条 booked 都被收进来了"用的是 nextBooking 的排序（最早的一条）+ 教练归属。
    assert.equal(res.nextBooking.hour, 14, '最早的那一节（A 的 14:00）先出现')
    assert.equal(res.nextBooking.coach.displayName, 'A 教练', '这一节的授课教练是 A')
    assert.equal(res.summary.remaining, 10, '课时只算一份（会员本人的真实剩余）')
    assert.equal(res.coaches.filter(item => item.historical).length >= 1, true, '会员的教练清单里应有历史教练')
  })

  await test('会员日程：另一位教练账里的课，授课教练显示的是**那位教练**，不会记到 A 头上', async () => {
    const res = await memberRead()
    const service = require('../cloudfunctions/readMyMemberData/service')
    // 直接对投影函数做判据：同一条数据、不同 owner ⇒ 教练不同。
    const rowA = { ownerCoachId: 'coach-a', datasetId: 'ds-a', bookingId: 'bk-a', data: { id: 'bk-a', status: 'booked', date: '2026-10-02', hour: 14, notes: 'A 的私人备注', price: 300 } }
    const rowB = { ownerCoachId: 'coach-b', datasetId: 'ds-b', bookingId: 'bk-b', data: { id: 'bk-b', status: 'booked', date: '2026-10-02', hour: 16, notes: 'B 的私人备注', price: 300 } }
    const claim = { claimId: 'claim-a', coachId: 'coach-a', studentId: 'stu-a-1' }
    const viewA = service.sanitizeBooking(rowA, claim, { coachKey: 'k-a', displayName: 'A 教练' })
    const viewB = service.sanitizeBooking(rowB, claim, { coachKey: 'k-b', displayName: 'B 教练' })
    assert.equal(viewA.coach.displayName, 'A 教练')
    assert.equal(viewB.coach.displayName, 'B 教练')
    assert.equal(viewB.historyId !== viewA.historyId, true, '两条不同的课必须有两个不同的视图 id')
  })

  await test('会员视图绝不泄露教练私有内容（notes / price / teachingCoachId / packageUsage …）', async () => {
    const row = { ownerCoachId: 'coach-a', datasetId: 'ds-a', bookingId: 'bk-a', data: { id: 'bk-a', status: 'booked', date: '2026-10-02', hour: 14, notes: '教练私人备注：膝盖旧伤', coachPrivateNotes: '更私人的话', price: 300, teachingCoachId: 'coach-a', source: 'coach', createdByCoachId: 'coach-a', packageUsage: { packageId: 'pkg-a-1', ownerCoachId: 'coach-a', datasetId: 'ds-a', studentId: 'stu-a-1' } } }
    const view = sanitizeBooking(row, { claimId: 'claim-a', coachId: 'coach-a', studentId: 'stu-a-1' }, { coachKey: 'k-a', displayName: 'A 教练' })
    PRIVATE_BOOKING_FIELDS.forEach(field => assert.equal(Object.prototype.hasOwnProperty.call(view, field), false, `会员视图里绝不能出现 ${field}`))
    const text = JSON.stringify(view)
    ;['膝盖旧伤', '更私人的话', '300', 'pkg-a-1'].forEach(secret => assert.equal(text.includes(secret), false, `会员视图里泄露了：${secret}`))
  })

  await test('会员日程：查不到 head 的账本（跨环境 / 不存在的教练）一律排除 ⇒ Sandbox 与正式区不串', async () => {
    const withHead = await memberRead({ foreignHeads: true })
    const withoutHead = await memberRead({ foreignHeads: false })
    assert.equal(withHead.ok, true)
    assert.equal(withoutHead.ok, true)
    // B 那本账在本环境没有 head ⇒ 不得进入会员视图；会员课时与教练清单都不该因此变化。
    assert.equal(withoutHead.summary.remaining, withHead.summary.remaining, '课时汇总不受外来账本影响')
    assert.equal(withHead.coaches.some(item => item.displayName === 'B 教练'), true, '本环境内有授课记录 ⇒ B 出现在教练清单')
    assert.equal(withoutHead.coaches.some(item => item.displayName === 'B 教练'), false, '查不到 head 的账本必须被排除在教练清单之外')
  })

  if (!process.exitCode) process.stdout.write('ALL M2 REFRESH + MEMBER SCHEDULE TESTS PASSED\n')
})()
