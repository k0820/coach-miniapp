// 会员端「历史」列表：按**状态发生时间**倒序 + 轻量筛选（2026-10-01 真机反馈：「历史不好理解」）
//
// 【真机事实】会员端「历史」页签按**课程原定时间**倒序 ⇒ 刚取消的课按它"本来几点上"插在中间，
//   会员看不出"哪条是最近发生的"。
//
// 【用户定稿的口径】
//   ① 历史按**状态发生那一刻**倒序（最新操作最前）；
//   ② 已完成 ⇒ `completedAt`；已取消 ⇒ `cancelledAt`；
//   ③ 缺 ⇒ `updatedAt` ⇒ 课程原定时间；
//   ④ 卡片显示「完成于 MM-DD HH:mm」/「取消于 MM-DD HH:mm」；
//   ⑤ 筛选：全部 / 已完成 / 已取消（**只影响页面，不改业务数据**）；
//   ⑥ 待上课排序**不许动**。
//
// ⛔⛔ 第 ⑦ 段与第 ⑫ 段是**数据缺口自证**：
//   云端 `memberBooking.cancelMemberBookingHandler` 确实写了 `booking.cancelledAt = context.now`，
//   但**会员端只读投影 `readMyMemberData.sanitizeBooking` 没有把它带出来**（只有 `completedAt`）。
//   ⇒ 会员端**拿不到可靠的取消时间**。本轮严守"不伪造顺序"：
//        · 排序键**预留** `cancelledAt`（云端一旦带出就自动生效）；
//        · 但**兜底出来的时刻绝不写成「取消于」** ⇒ 已取消的课当前**不显示**时间行。
//      ⛔ 谁要是"顺手用课程原定时间冒充取消时间"，第 ⑦ 段立刻变红。

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const crypto = require('crypto')
const { runner } = require('./helpers/m2-business-world')
const view = require('../utils/member-booking-view')
const { createService: readService, fixedId } = require('../cloudfunctions/readMyMemberData/service')

// ⭐ 最小假 wx：只是为了 `require` 页面模块时不在顶层炸掉（本页全部断言都是纯函数 / 纯视图层）。
global.wx = {
  getStorageSync: () => '', setStorageSync: () => { },
  navigateTo: () => { }, redirectTo: () => { },
  showModal: () => { }, showToast: () => { }, stopPullDownRefresh: () => { },
  cloud: { callFunction: async () => ({ result: { ok: false } }) }
}

// 北京时间 ⇒ 毫秒时间戳（`Date.UTC` 自己会处理"小时减 8 变成前一天"）
const at = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 8, mm)
const row = over => Object.assign({
  historyId: 'h', date: '2026-09-20', hour: 10, minute: 0,
  status: 'done', typeName: '常规训练', coach: { displayName: '甲教练' }
}, over)
const ids = rows => rows.map(item => item.historyId)
const cards = rows => view.splitBookings(rows).history

// ------------------------------------------------------------------ 假云端（只为跑**真的** `readMyMemberData` 投影）
const ENV = 'sandbox'
const memberIdOf = openId => crypto.createHash('sha256').update(`member:${openId}`).digest('hex').slice(0, 32)
const coachIdOf = openId => crypto.createHash('sha256').update(`coach:${openId}`).digest('hex').slice(0, 32)

function createCloud(openId) {
  const stores = {}
  const stats = { gets: 0 }   // ⛔ 要求 ④：带出 cancelledAt **不许**多跑一趟数据库 ⇒ 用它咬住
  let current = openId
  const scope = target => ({
    collection(name) {
      const store = target[name] || (target[name] = new Map())
      return {
        doc(id) { return { async set({ data }) { store.set(id, { ...data, _id: id }) }, async remove() { store.delete(id) } } },
        where(query) {
          let skip = 0, limit = 100
          const api = {
            skip(value) { skip = value; return api },
            limit(value) { limit = value; return api },
            async get() {
              stats.gets++
              const rows = [...store.values()].filter(row => Object.keys(query).every(key => row && row[key] === query[key]))
              return { data: rows.slice(skip, skip + limit).map(row => JSON.parse(JSON.stringify(row))) }
            }
          }
          return api
        }
      }
    }
  })
  const db = scope(stores)
  return {
    stores, db, stats, setOpenId(value) { current = value }, getOpenId: () => current,
    put(name, id, row) { const store = stores[name] || (stores[name] = new Map()); store.set(id, { ...row, _id: id }) }
  }
}

// 一位会员认领了教练甲账里的学员 S1（Sandbox，与 m3-p1 同一套形状）
function seedMember(cloud) {
  const memberId = memberIdOf('member-a'), coachAId = coachIdOf('coach-a')
  const studentId = 'student-s1', datasetA = 'ds-a'
  cloud.put('member_sandbox_accounts', fixedId('member_sandbox_accounts', memberId), { memberId, status: 'active', displayName: '小蓝' })
  cloud.put('member_sandbox_student_claims', 'claim-1', { claimId: 'claim-1', memberId, studentId, coachId: coachAId, status: 'verified' })
  cloud.put('member_sandbox_coach_profiles', 'profile-a', { coachId: coachAId, displayName: '甲教练', discoverable: true })
  cloud.put('coach_sandbox_heads', 'head-a', { ownerCoachId: coachAId, environment: ENV, activeDatasetId: datasetA })
  return { memberId, coachAId, studentId, datasetA }
}
const bookingRow = (id, extra) => Object.assign({
  bookingId: id, id, date: '2026-09-20', hour: 10, minute: 0, status: 'booked', plannedMinutes: 60, typeName: '常规训练'
}, extra)

;(async () => {
  // ------------------------------------------------------------------ ① 已完成：按 completedAt 倒序（不是按课程日期）
  await runner('① 已完成按「完成那一刻」倒序（课程更早、但更晚完成的排最前 ⇒ 证明不是按课程时间排）', async () => {
    const rows = [
      row({ historyId: 'late-course', date: '2026-10-05', hour: 9, minute: 0, status: 'done', completedAt: at(2026, 9, 25, 20, 0) }),
      row({ historyId: 'early-course', date: '2026-09-20', hour: 9, minute: 0, status: 'done', completedAt: at(2026, 10, 1, 18, 30) })
    ]
    assert.deepEqual(ids(cards(rows)), ['early-course', 'late-course'],
      '课程在 09-20 但 10-01 才完成 ⇒ 必须排在 10-05 那节（09-25 完成）前面')
  })

  // ------------------------------------------------------------------ ② 已取消：按 cancelledAt 倒序
  await runner('② 已取消按「取消那一刻」倒序（云端一旦带出 cancelledAt 就自动生效）', async () => {
    const rows = [
      row({ historyId: 'cx-old', date: '2026-10-06', status: 'cancelled', cancelledAt: at(2026, 9, 28, 9, 15) }),
      row({ historyId: 'cx-new', date: '2026-09-21', status: 'cancelled', cancelledAt: at(2026, 10, 1, 12, 0) })
    ]
    assert.deepEqual(ids(cards(rows)), ['cx-new', 'cx-old'], '09-21 那节是 10-01 才取消的 ⇒ 必须排最前')
  })

  // ------------------------------------------------------------------ ③ 跨状态：谁后发生谁在前（完成与取消同一把尺子）
  await runner('③ 完成与取消**混排**：唯一排序尺子是"状态发生的那一刻"，不是"它是完成还是取消"', async () => {
    const rows = [
      row({ historyId: 'done-1', date: '2026-10-06', status: 'done', completedAt: at(2026, 10, 1, 9, 0) }),
      row({ historyId: 'cx-2', date: '2026-09-22', status: 'cancelled', cancelledAt: at(2026, 10, 2, 9, 0) }),
      row({ historyId: 'done-3', date: '2026-10-07', status: 'done', completedAt: at(2026, 9, 30, 9, 0) })
    ]
    assert.deepEqual(ids(cards(rows)), ['cx-2', 'done-1', 'done-3'])
  })

  // ------------------------------------------------------------------ ④ 缺 completedAt ⇒ updatedAt 兜底（但不许冒充当"完成于"）
  await runner('④ 缺 completedAt ⇒ 用 updatedAt 排序；⛔ 兜底出来的时刻**不许**显示成「完成于」', async () => {
    const rows = [
      row({ historyId: 'u-old', status: 'done', updatedAt: at(2026, 9, 20, 10, 0) }),
      row({ historyId: 'u-new', status: 'done', updatedAt: at(2026, 10, 1, 10, 0) })
    ]
    assert.deepEqual(ids(cards(rows)), ['u-new', 'u-old'], 'updatedAt 是第二顺位，必须参与排序')
    const card = cards(rows).find(item => item.historyId === 'u-new')
    assert.strictEqual(card.hasEventAt, false, '没有 completedAt ⇒ 绝不能写「完成于」（那是伪造）')
    assert.strictEqual(card.eventAtText, '')
  })

  // ------------------------------------------------------------------ ⑤ 都没有 ⇒ 课程原定时间兜底；连日期都没有 ⇒ 排最后
  await runner('⑤ 连 updatedAt 都没有 ⇒ 退回课程原定时间；连日期都没有 ⇒ 排最后（⛔ 不许拿"现在"顶替）', async () => {
    const rows = [
      row({ historyId: 'no-date', date: '', hour: null, minute: null, status: 'done' }),
      row({ historyId: 'c-0920', date: '2026-09-20', hour: 10, minute: 0, status: 'done' }),
      row({ historyId: 'c-1006', date: '2026-10-06', hour: 10, minute: 0, status: 'done' })
    ]
    assert.deepEqual(ids(cards(rows)), ['c-1006', 'c-0920', 'no-date'])
    const card = cards(rows).find(item => item.historyId === 'c-1006')
    assert.strictEqual(card.hasEventAt, false, '兜底到课程原定时间 ⇒ 不显示「完成于」')
    assert.strictEqual(view.historyOrderOf({ historyId: 'x', status: 'done' }), -Infinity,
      '彻底没时间 ⇒ 排序键 -Infinity（排最后），绝不能是 Date.now()')
    // ⭐ 2026-10-03 补（覆盖真空修复）：上面那条走的是 `done` 那一支（`statusAtOf` 的三支里第一支命中就返回），
    //    而"兜底回落到 `-Infinity`"这句话在**三支里各写了一遍** ——
    //    "顺手改成 `Date.now()`"最可能只改掉其中一支，而测试只喂了 `done` ⇒ 另两支怎么改都绿。
    //    （证据：`_member-history-order-mutate` ④ 曾因此漏网：它打的正是**第三支**，
    //      即 status 既不是 done 也不是 cancelled 的那种行。）
    //    ⇒ 三支都要喂，并且不许只看"是不是 -Infinity"，还要咬住"不许回落到现在"。
    const NOWISH = Date.now()
    ;[{ status: 'done' }, { status: 'cancelled' }, { status: 'booked' }, {}].forEach(probe => {
      const key = view.historyOrderOf(Object.assign({ historyId: 'probe' }, probe))
      const label = `status=${JSON.stringify(probe.status)}`
      assert.strictEqual(key, -Infinity,
        `彻底没时间（${label}）⇒ 排序键只能是 -Infinity（实测 ${key}）`)
      assert.ok(!(Number.isFinite(key) && Math.abs(key - NOWISH) < 60000),
        `⛔ 排序键回落成"现在"了（${label}）⇒ 没记录的课永远排最前`)
    })
  })

  // ------------------------------------------------------------------ ⑥ 文案格式
  await runner('⑥ 卡片文案：「完成于 / 取消于 MM-DD HH:mm」（北京时间，前后零补齐）', async () => {
    assert.strictEqual(view.eventAtTextOf(row({ status: 'done', completedAt: at(2026, 10, 1, 18, 30) })), '完成于 10-01 18:30')
    assert.strictEqual(view.eventAtTextOf(row({ status: 'cancelled', cancelledAt: at(2026, 9, 28, 9, 5) })), '取消于 09-28 09:05')
    // 跨 UTC 日界（北京 10-02 07:30 = UTC 10-01 23:30）⇒ 必须显示 10-02，不能显示成 10-01
    assert.strictEqual(view.eventAtTextOf(row({ status: 'done', completedAt: at(2026, 10, 2, 7, 30) })), '完成于 10-02 07:30')
  })

  // ------------------------------------------------------------------ ⑦ 数据缺口自证：已取消**没有**可靠时间 ⇒ 不伪造
  await runner('⑦ 已取消但**没有** cancelledAt（当前真机现状）⇒ 不显示「取消于」，排序退回课程原定时间', async () => {
    const rows = [
      row({ historyId: 'cx-0920', date: '2026-09-20', hour: 10, minute: 0, status: 'cancelled' }),
      row({ historyId: 'cx-1006', date: '2026-10-06', hour: 10, minute: 0, status: 'cancelled' })
    ]
    const list = cards(rows)
    assert.deepEqual(ids(list), ['cx-1006', 'cx-0920'], '没有取消时间 ⇒ 只能按课程原定时间排（诚实，不是按"最近操作"）')
    list.forEach(card => {
      assert.strictEqual(card.hasEventAt, false, '⛔ 没有 cancelledAt 就绝不能出现「取消于」')
      assert.strictEqual(card.eventAtText, '')
    })
    // ⛔ 反向护栏：故意塞一个"看起来像时间"的脏值，不许被当成取消时间
    const dirty = [row({ historyId: 'd1', date: '2026-09-20', status: 'cancelled', cancelledAt: 0 })]
    assert.strictEqual(cards(dirty)[0].hasEventAt, false, 'cancelledAt = 0 是"没记录"，不是 1970 年')
  })

  // ------------------------------------------------------------------ ⑧ 待上课排序不许动
  await runner('⑧ 待上课**仍然**按课程原定时间升序（最近一节在最前）—— 本轮不许碰它', async () => {
    const rows = [
      row({ historyId: 'u-1010', date: '2026-10-10', hour: 9, minute: 0, status: 'booked', completedAt: at(2026, 9, 1, 9, 0) }),
      row({ historyId: 'u-1002', date: '2026-10-02', hour: 20, minute: 0, status: 'booked' }),
      row({ historyId: 'u-1002b', date: '2026-10-02', hour: 8, minute: 0, status: 'booked' })
    ]
    const split = view.splitBookings(rows)
    assert.deepEqual(ids(split.upcoming), ['u-1002b', 'u-1002', 'u-1010'], '待上课只认课程时间：同日 08:00 在 20:00 前')
    assert.strictEqual(split.history.length, 0)
  })

  // ------------------------------------------------------------------ ⑨ 筛选：只切片，不修改业务数据
  await runner('⑨ 筛选（全部 / 已完成 / 已取消）**只切片**：原数组一个字节都不许变', async () => {
    const history = cards([
      row({ historyId: 'd1', status: 'done', completedAt: at(2026, 10, 1, 9, 0) }),
      row({ historyId: 'c1', status: 'cancelled', cancelledAt: at(2026, 10, 2, 9, 0) }),
      row({ historyId: 'n1', status: 'noshow' }),
      row({ historyId: 'd2', status: 'done', completedAt: at(2026, 9, 30, 9, 0) })
    ])
    const before = JSON.parse(JSON.stringify(history))
    assert.deepEqual(ids(view.filterHistory(history, 'all')), ['c1', 'd1', 'd2', 'n1'])
    assert.deepEqual(ids(view.filterHistory(history, 'done')), ['d1', 'd2'])
    assert.deepEqual(ids(view.filterHistory(history, 'cancelled')), ['c1'])
    assert.deepEqual(history, before, '⛔ 筛选后的原数组必须逐字段不变（不许就地删元素）')
    // ⛔「未出席」只在「全部」里出现：它既不是已完成也不是已取消，不许被错误归类
    assert.ok(ids(view.filterHistory(history, 'done')).indexOf('n1') < 0)
    assert.ok(ids(view.filterHistory(history, 'cancelled')).indexOf('n1') < 0)
  })

  // ------------------------------------------------------------------ ⑩ 保持原排序 + 计数按全部历史算
  await runner('⑩ 筛选后**保持**原相对顺序；计数按**全部历史**算（不是按当前筛选）', async () => {
    const history = cards([
      row({ historyId: 'd1', status: 'done', completedAt: at(2026, 10, 1, 9, 0) }),
      row({ historyId: 'c1', status: 'cancelled', cancelledAt: at(2026, 10, 2, 9, 0) }),
      row({ historyId: 'd2', status: 'done', completedAt: at(2026, 9, 30, 9, 0) }),
      row({ historyId: 'c2', status: 'cancelled', cancelledAt: at(2026, 9, 29, 9, 0) })
    ])
    assert.deepEqual(ids(view.filterHistory(history, 'done')), ['d1', 'd2'], '筛选不许重新排序')
    assert.deepEqual(ids(view.filterHistory(history, 'cancelled')), ['c1', 'c2'])
    const counts = view.historyCountsOf(history)
    assert.deepEqual(counts, { all: 4, done: 2, cancelled: 2 })
    // ⛔ 在「已取消」筛选下计数仍然是**全部**的计数 ⇒ 会员在任一档都能看到"已取消 2 节"
    const countsUnderFilter = view.historyCountsOf(view.filterHistory(history, 'cancelled'))
    assert.deepEqual(countsUnderFilter, { all: 2, done: 0, cancelled: 2 },
      '计数函数只认"传进去的那份全部历史" ⇒ 页面必须传**未筛选**的 history 进去')
  })

  // ------------------------------------------------------------------ ⑪ 页面：点筛选只改视图，不碰 rows
  await runner('⑪ 真页面点筛选：只 setData 视图，**rows 与服务端数据一个字节都不动**', async () => {
    let captured = null
    global.Page = config => { captured = config }
    const full = require.resolve(path.join(ROOT, 'pages/member-bookings/member-bookings'))
    delete require.cache[full]
    require(full)
    delete require.cache[full]
    assert.ok(captured && typeof captured.switchHistoryFilter === 'function', 'switchHistoryFilter 必须挂在页面上')

    const rows = [
      row({ historyId: 'd1', status: 'done', completedAt: at(2026, 10, 1, 9, 0) }),
      row({ historyId: 'c1', status: 'cancelled', cancelledAt: at(2026, 10, 2, 9, 0) })
    ]
    const split = view.splitBookings(rows)
    const page = Object.assign({}, captured)
    page.rows = rows
    page.data = { ...captured.data, history: split.history, visibleHistory: split.history, historyCounts: view.historyCountsOf(split.history), historyFilter: 'all' }
    page.setData = patch => Object.assign(page.data, patch)
    const rowsBefore = JSON.parse(JSON.stringify(page.rows))

    page.switchHistoryFilter({ currentTarget: { dataset: { filter: 'cancelled' } } })
    assert.strictEqual(page.data.historyFilter, 'cancelled')
    assert.deepEqual(ids(page.data.visibleHistory), ['c1'])
    assert.strictEqual(page.data.history.length, 2, '⛔ 全部历史仍然是 2 条（筛选不是删除）')
    assert.deepEqual(page.data.historyCounts, { all: 2, done: 1, cancelled: 1 })
    assert.deepEqual(page.rows, rowsBefore, '⛔ rows 不许被筛选改动')

    // 非法 / 空 / 当前值 ⇒ 一律忽略（不许把视图筛成空）
    page.switchHistoryFilter({ currentTarget: { dataset: { filter: 'delete-everything' } } })
    assert.strictEqual(page.data.historyFilter, 'cancelled', '不认识的筛选值必须被忽略')
    page.switchHistoryFilter({})
    assert.strictEqual(page.data.historyFilter, 'cancelled')

    // 回到「全部」⇒ 两条都在，顺序仍按状态发生时间（取消 10-02 在前）
    page.switchHistoryFilter({ currentTarget: { dataset: { filter: 'all' } } })
    assert.deepEqual(ids(page.data.visibleHistory), ['c1', 'd1'])
  })

  // ------------------------------------------------------------------ ⑫ 投影口径：带出 cancelledAt，且内部字段一个都不出
  await runner('⑫ 会员投影**带出** cancelledAt（只读既有值），且内部字段一个都不出网', async () => {
    const { sanitizeBooking } = require('../cloudfunctions/readMyMemberData/service')
    const cancelledAt = at(2026, 10, 1, 12, 0)
    // ⛔ 故意在原始文档里塞满内部字段：投影后一个都不许出现（白名单投影的意义就在这里）
    const view = sanitizeBooking({
      bookingId: 'b1', id: 'b1', status: 'cancelled', date: '2026-09-20', hour: 10, minute: 0,
      cancelledAt, completedAt: null,
      cancelledByMemberId: 'member-secret', studentId: 'stu-1', coachId: 'coach-1', ownerCoachId: 'coach-1',
      datasetId: 'ds-a', notes: '教练私货', price: 350, packageUsage: 'x'
    }, { claimId: 'claim-1' }, { coachKey: 'ck-1', displayName: '甲教练' })
    assert.strictEqual(view.cancelledAt, cancelledAt, '⛔ 云端已经写好的取消时刻必须**原样**带出来（只读，不改不迁移）')
    assert.strictEqual(view.status, 'cancelled')
    const dump = JSON.stringify(view)
    ;['cancelledByMemberId', 'studentId', 'coachId', 'ownerCoachId', 'datasetId', 'notes', 'price', 'packageUsage', 'bookingId']
      .forEach(secret => assert.ok(!dump.includes(secret), `会员投影里出现了不该下发的内部字段：${secret}`))
    // ⛔ 反向：写路径**必须**真的写了 cancelledAt（否则带出来也是空的）
    const writer = fs.readFileSync(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking.js'), 'utf8')
    assert.ok(writer.includes('booking.cancelledAt = context.now'), '会员自助取消必须记录取消时刻')
  })

  // ------------------------------------------------------------------ ⑬ 时间戳归一化：脏值一律当"没记录"
  await runner('⑬ 时间戳归一化：ISO 字符串认；0 / 空串 / null / 脏字符串一律当"没记录"（绝不返回 0）', async () => {
    assert.strictEqual(view.timestampOf(at(2026, 10, 1, 18, 30)), at(2026, 10, 1, 18, 30))
    assert.strictEqual(view.timestampOf('2026-10-01T10:30:00Z'), at(2026, 10, 1, 18, 30), 'ISO 字符串也要认')
    ;[0, '', null, undefined, 'abc', NaN, -1].forEach(value => {
      assert.strictEqual(view.timestampOf(value), null, `脏值 ${JSON.stringify(value)} 必须当成"没记录"`)
    })
  })

  // ------------------------------------------------------------------ ⑭ UI 契约：时间行必须"有才显示"，列表必须用筛选后的数组
  await runner('⑭ UI 契约：卡片时间行 `wx:if="{{item.hasEventAt}}"`；历史列表渲染**筛选后**的 visibleHistory', async () => {
    const wxml = fs.readFileSync(path.join(ROOT, 'pages/member-bookings/member-bookings.wxml'), 'utf8')
    assert.ok(wxml.includes('wx:for="{{visibleHistory}}"'), '历史列表必须渲染 visibleHistory（否则筛选点了没反应）')
    assert.ok(wxml.includes('wx:if="{{item.hasEventAt}}"'),
      '⛔ 时间行必须挂在 hasEventAt 上：没记录就不显示，不许无条件渲染一句「完成于」')
    ;['all', 'done', 'cancelled'].forEach(filter => {
      assert.ok(wxml.includes(`data-filter="${filter}"`), `筛选按钮缺 ${filter}`)
    })
  })

  // ------------------------------------------------------------------ ⑮ 端到端：真云函数把**真实取消时刻**带出来 ⇒ 排序 + 文案落地
  await runner('⑮ 端到端（真的 `readMyMemberData`）：已取消按**真实取消时刻**排序并显示「取消于 MM-DD HH:mm」', async () => {
    const cloud = createCloud('member-a'), ids = seedMember(cloud)
    const cancelledAt = at(2026, 10, 1, 12, 0), completedAt = at(2026, 9, 25, 20, 0)
    // 课程原定 09-20、但 10-01 才取消；另一节课程原定 10-05、09-25 就完成了
    // ⇒ 按"课程时间"排是 10-05 在前，按"状态发生时间"排是**取消那节**在前。
    cloud.put('bookings', 'b-cx', {
      ...bookingRow('b-cx', { status: 'cancelled', cancelledAt, cancelledByMemberId: ids.memberId }),
      ownerCoachId: ids.coachAId, datasetId: ids.datasetA, studentId: ids.studentId
    })
    cloud.put('bookings', 'b-done', {
      ...bookingRow('b-done', { date: '2026-10-05', hour: 9, minute: 0, status: 'done', completedAt }),
      ownerCoachId: ids.coachAId, datasetId: ids.datasetA, studentId: ids.studentId
    })
    const read = readService({ db: cloud.db, getOpenId: cloud.getOpenId })
    const live = await read({ action: 'availability', environment: ENV })
    assert.strictEqual(live.availability, true, '必须走新版只读投影')

    // ① 投影**原样**带出云端既有的取消时刻（只读，不新增任何查询）
    const cxProjection = live.bookings.find(row => row.status === 'cancelled')
    assert.ok(cxProjection, '已取消的课必须出现在「我的预约」里（保留历史，不是物理删除）')
    assert.strictEqual(cxProjection.cancelledAt, cancelledAt, '⛔ 取消时刻必须是云端那个值，一个毫秒都不许动')
    assert.strictEqual(cxProjection.cancelledByMemberId, undefined, '⛔ 内部字段不许出网')

    // ② 排序 + 文案：取消那节（10-01）必须排在 09-25 完成那节之前，且显示「取消于」
    const history = view.splitBookings(live.bookings).history
    assert.strictEqual(history.length, 2)
    assert.strictEqual(history[0].status, 'cancelled', '10-01 取消的那节必须排最前（不是按课程日期 09-20）')
    assert.strictEqual(history[0].eventAtText, '取消于 10-01 12:00')
    assert.strictEqual(history[0].hasEventAt, true)
    assert.strictEqual(history[1].status, 'done')
    assert.strictEqual(history[1].eventAtText, '完成于 09-25 20:00')

    // ③ 同一口径：`read` 与 `availability` **共用同一个**投影函数（不许出现第二份预约视图）
    const legacy = await read({ action: 'read', environment: ENV })
    const source = fs.readFileSync(path.join(ROOT, 'cloudfunctions/readMyMemberData/service.js'), 'utf8')
    const calls = (source.match(/sanitizeBooking\(/g) || []).length
    assert.ok(calls >= 4, `read 与 availability 必须共用 sanitizeBooking（实测调用点 ${calls} 处）`)
    // legacy 的"已完成训练"也来自同一投影 ⇒ 时间字段口径一致
    assert.strictEqual(legacy.recentTraining.length, 1)
    assert.strictEqual(legacy.recentTraining[0].completedAt, completedAt)
    assert.strictEqual(legacy.recentTraining[0].cancelledAt, null, '已完成的行没有取消时刻 ⇒ null（不是 0、不是 NaN）')
  })

  // ------------------------------------------------------------------ ⑯ 零成本：带出 cancelledAt 不许多跑一趟数据库
  await runner('⑯ 带出 cancelledAt **不增加任何数据库查询**（同一份数据、有/无该字段 ⇒ 查询次数完全相同）', async () => {
    const build = withCancelledAt => {
      const cloud = createCloud('member-a'), ids = seedMember(cloud)
      cloud.put('bookings', 'b-cx', {
        ...bookingRow('b-cx', withCancelledAt ? { status: 'cancelled', cancelledAt: at(2026, 10, 1, 12, 0) } : { status: 'cancelled' }),
        ownerCoachId: ids.coachAId, datasetId: ids.datasetA, studentId: ids.studentId
      })
      return cloud
    }
    const withAt = build(true), withoutAt = build(false)
    const readWith = readService({ db: withAt.db, getOpenId: withAt.getOpenId })
    const readWithout = readService({ db: withoutAt.db, getOpenId: withoutAt.getOpenId })
    const a = await readWith({ action: 'availability', environment: ENV })
    const b = await readWithout({ action: 'availability', environment: ENV })
    assert.strictEqual(a.bookings.length, 1)
    assert.strictEqual(b.bookings.length, 1)
    assert.strictEqual(withAt.stats.gets, withoutAt.stats.gets,
      `⛔ 带出取消时刻多跑了数据库（${withoutAt.stats.gets} ⇒ ${withAt.stats.gets}）：投影必须只读已经读出来的文档`)
    assert.strictEqual(a.bookings[0].cancelledAt, at(2026, 10, 1, 12, 0))
    assert.strictEqual(b.bookings[0].cancelledAt, null, '文档里没有 ⇒ null（不许凭空造一个值）')
    // ⭐ 2026-10-03 补（覆盖真空修复）：上面那句只比"有该字段 / 无该字段"两次的**相对**次数。
    //    它抓不到**无条件**多跑一趟的写法 —— 两边都多跑，差值照样是 0（差值为 0 也能来自"两次都错"）。
    //    （证据：`_member-history-order-mutate` ⑲「投影前又查一次 bookings」曾因此漏网。）
    //    要求既然是"投影**只读已经读出来的文档**"，就必须钉**绝对**趟数：
    //    本夹具（1 条认领 + 1 条课包 + 1 条预约）应有且仅有 8 趟读取。
    //    ⛔ 将来若有正当理由要改这个数字，必须在注释里写清"多读的是哪一份文档、为什么非读不可"，
    //       并同步调整本判据 —— 这正是这条护栏想要的那次对话。
    const READS_FOR_THIS_FIXTURE = 8
    assert.strictEqual(withAt.stats.gets, READS_FOR_THIS_FIXTURE,
      `⛔ 读取趟数变了（期望 ${READS_FOR_THIS_FIXTURE}，实测 ${withAt.stats.gets}）⇒ 投影多跑了数据库`)
    assert.strictEqual(withoutAt.stats.gets, READS_FOR_THIS_FIXTURE,
      `⛔ 读取趟数变了（期望 ${READS_FOR_THIS_FIXTURE}，实测 ${withoutAt.stats.gets}）⇒ 投影多跑了数据库`)
  })
})()
