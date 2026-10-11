// M2 V1｜BUG04 永久回归：**共享/授权排课的那节课必须出现在授课教练 B 的正常课表上**（2026-09-28）。
//
// 真机症状：B 用 A 授权的课时包排课成功、M2 授权目录里也看得到（剩余 5 / 已占 1 / 未来预约 10:00），
//   但 B 的**正常课表周视图**里没有这一节课。
//
// 真实根因（本文件逐条钉住）：预约文档落在**授课教练 B 这本账**（`createBookingOnForeignPackage`，
//   跨账定位标记是 `booking.packageUsage`），而那份课时包与那位会员档案在 **A 那本账**里。
//   客户端 `utils/candidate-dataset.js` 的 `validateRelations()` 要求每条 booking 的 package 与 student
//   **必须在本账内** ⇒ 抛 `BOOKING_RELATION_INVALID` ⇒ **整次完整回读失败** ⇒ cache 一个字节都不更新
//   ⇒ B 的课表只能继续画旧那一帧。云端 `readMyActiveCoachData/integrity.js` **没有**这条校验 ⇒ 云端 ok:true
//   ⇒ 两端对同一份数据判据不一致（本文件④一方面用真 modules 把 contradiction 钉住）。
//
// ⭐ 本文件跑的全是真东西：
//   ① 写链 —— **真** core.execute + **真** handlers（假 DB 只替代网络，账本隔离/事务/revision/收据都是真的）；
//   ② 读链 —— **真** `readMyActiveCoachData/integrity.js`（云端 fingerprint）经假 callFunction 回复，
//              **真** utils/cloud-primary-adapter + ui-cloud-command（bulk read → reconstruct → integrity → cache）；
//   ③ 渲染链 —— **真** pages/schedule（loadScheduleData → makeWeek → decorateBooking）；
//   ④ 增量 —— **真** readMyActiveCoachData/changes.js 的 planChanges。
//
// ⛔ 业务边界（不许为了显示而破坏）：不复制会员/课时包/销售、不在 A 的课表出现 B 的课、
//   业绩仍归创建者、收入仍归授课教练、完课/取消/扣课时全部仍然由云端事务裁决。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { META, coachIdFor, fixedId, createService } = require('../cloudfunctions/coachBusinessCommand/core')
const { handlers } = require('../cloudfunctions/coachBusinessCommand/handlers')
const occupancy = require('../cloudfunctions/coachBusinessCommand/occupancy')
const serverIntegrity = require('../cloudfunctions/readMyActiveCoachData/integrity')
const changes = require('../cloudfunctions/readMyActiveCoachData/changes')
const authorization = require('../cloudfunctions/coachBusinessCommand/authorization')

const copy = value => JSON.parse(JSON.stringify(value))
const names = [...new Set([...Object.values(META), 'students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises', 'member_coach_profiles', 'member_student_claims'])]
const stores = Object.fromEntries(names.map(name => [name, new Map()]))
let queue = Promise.resolve(), openId = 'openid-a', clock = 1900000000000

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
            async get() { return { data: [...target[name].values()].filter(row => Object.keys(query).every(key => row[key] === query[key])).slice(offset, offset + limit).map(copy) } }
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
const put = (name, id, data) => stores[name].set(id, { ...copy(data), _id: id })
const rows = (name, owner, datasetId) => [...stores[name].values()].filter(row => row.ownerCoachId === owner && row.datasetId === datasetId)
const dataRows = (name, owner, datasetId) => rows(name, owner, datasetId).map(row => row.data || {})
const revisionOf = (owner, datasetId) => (rows(META.revisions, owner, datasetId)[0] || {}).dataRevision
const businessId = (name, owner, datasetId, id) => fixedId(`coach-business-${name}`, owner, `${datasetId}:${id}`)

// 一位教练 = 一本账 + 一枚公开码（公开码是"我要授权给谁"唯一可提交的凭证）。
// ⚠️ A / B 是**两本真账**：不同 ownerCoachId、不同 datasetId、各自 revision 与收据 —— 不是两块 nick name。
function seedCoach(open, datasetId, publicCode) {
  const owner = coachIdFor(open)
  put('coaches', owner, { openId: open, status: 'active' })
  put(META.datasets, fixedId('coach-dataset', owner, datasetId), { ownerCoachId: owner, datasetId, status: 'active', integrityStatus: 'verified', checksum: 'ok', byteSize: 1, summary: {}, schemaVersion: 1 })
  put(META.heads, fixedId('coach-data-head', owner), { ownerCoachId: owner, activeDatasetId: datasetId, headVersion: 1 })
  put(META.revisions, fixedId('coach-data-revision', owner, datasetId), { ownerCoachId: owner, datasetId, dataRevision: 0 })
  if (publicCode) put('member_coach_profiles', fixedId('coach-public', owner), { coachId: owner, publicCode, displayName: `教练${publicCode}`, discoverable: true })
  return { open, owner, datasetId, publicCode }
}
const A = seedCoach('openid-a', 'ds-a', 'CODEA')
const B = seedCoach('openid-b', 'ds-b', 'CODEB')

const main = () => createService({ db, getOpenId: () => openId, handlers, now: () => ++clock })
async function raw(open, command, requestId, expectedRevision, payload) {
  openId = open
  return main()({ action: 'execute', environment: 'production', envelope: { command, requestId, expectedRevision, payload } })
}
const revOf = coach => revisionOf(coach.owner, coach.datasetId)
const cmd = (coach, command, requestId, payload) => raw(coach.open, command, requestId, revOf(coach), payload)
const pkgOf = (coach, packageId) => dataRows('packages', coach.owner, coach.datasetId).find(item => item.id === packageId)
const occ = (coach, packageId) => occupancy.occupancyOf(pkgOf(coach, packageId))
const incomesOf = coach => dataRows('incomes', coach.owner, coach.datasetId)
const salesOf = coach => dataRows('sales', coach.owner, coach.datasetId)

const DATE = '2026-09-28'
let tests = [], failures = 0
function test(name, fn) { tests.push({ name, fn }) }
async function run() {
  for (const item of tests) {
    try { await item.fn(); process.stdout.write(`PASS ${item.name}\n`) }
    catch (error) { failures += 1; process.stdout.write(`FAIL ${item.name}\n    ${error && error.message}\n`) }
  }
  process.stdout.write(failures ? `\n${failures} FAILED / ${tests.length}\n` : `\nALL M2 SHARED BOOKING SCHEDULE VISIBILITY TESTS PASSED (${tests.length})\n`)
  if (failures) process.exitCode = 1
}

// ——————————————————————————————————————————————————————————————
// 云端替身：**严格**按 readMyActiveCoachData 的协议回话，且中间的完整性用**真云端 modules**算。
//   · action:'page'      ⇒ 把这本账的八个物理集合按 physical name 分页（就是云端 all() 读到的原始行）
//   · action:'integrity' ⇒ **真** `readMyActiveCoachData/integrity.js`（reconstruct + fingerprint）
//   · action:'changes'   ⇒ 本假云端不实现 ⇒ INVALID_ACTION ⇒ 客户端退整读（与现实里"旧云函数"同一形状）
// ——————————————————————————————————————————————————————————————
const PHYSICAL = ['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
let as = 'openid-b'
const groupsOf = coach => Object.fromEntries(PHYSICAL.map(name => [name, rows(name, coach.owner, coach.datasetId)]))
async function callFunction({ name, data }) {
  if (name !== 'readMyActiveCoachData') return { result: { ok: false, code: 'UNKNOWN_FUNCTION' } }
  const coach = as === 'openid-a' ? A : B
  if (data.action === 'metadata') {
    return { result: { ok: true, environment: 'production', datasetId: coach.datasetId, dataRevision: revOf(coach), headVersion: 1, collections: PHYSICAL.slice() } }
  }
  if (data.action === 'page') {
    const list = rows(data.collection, coach.owner, coach.datasetId)
    return { result: { ok: true, environment: 'production', collection: data.collection, datasetId: coach.datasetId, dataRevision: revOf(coach), done: true, cursor: 0, nextCursor: list.length, nextFragmentIndex: 0, encoding: 'base64-json', payload: Buffer.from(JSON.stringify(list), 'utf8').toString('base64') } }
  }
  if (data.action === 'integrity') {
    const groups = groupsOf(coach)
    const fingerprint = serverIntegrity.fingerprint(serverIntegrity.reconstruct(groups))
    return { result: { ok: true, environment: 'production', datasetId: coach.datasetId, dataRevision: revOf(coach), ...fingerprint } }
  }
  return { result: { ok: false, code: 'INVALID_ACTION' } }
}

// ——————————————————————————————————————————————————————————————
// 本机替身：一台设备 = 一份 Storage。切账号必须连 cache 一起换（现实里两台手机就是两份 Storage）。
// ——————————————————————————————————————————————————————————————
const storage = new Map()
storage.set('coachDataSourceMode', 'cloud-primary')
storage.set('coachCloudCutoverState', { status: 'cloud-primary', updatedAt: Date.now() })
global.wx = {
  cloud: { callFunction },
  getStorageSync: key => { const value = storage.get(key); return value === undefined ? undefined : copy(value) },
  setStorageSync: (key, value) => storage.set(key, copy(value)),
  removeStorageSync: key => storage.delete(key),
  showLoading() {}, hideLoading() {}, showToast() {}, showModal() {},
  showTabBar() {}, hideTabBar() {}, nextTick(fn) { fn() }, navigateTo() {}, stopPullDownRefresh() {},
  getNetworkType() {}, onNetworkStatusChange() {}
}
const ui = require('../utils/ui-cloud-command')
let capturedPage = null
global.Page = config => { capturedPage = config }
require('../pages/schedule/schedule')

function useDevice(who) {
  as = who === 'A' ? 'openid-a' : 'openid-b'
  if (storage.get('coachUiTimings')) storage.delete('coachUiTimings')
  storage.delete('coachCloudActiveCache'); storage.delete('coachCloudActiveRows')
  return who === 'A' ? A : B
}
// 真课表页实例（near-device：真的 Page 对象 + 真 setData 语义）
function makePage(date) {
  const page = {
    data: copy(capturedPage.data), _visible: true,
    setData(patch, callback) { applyPatch(this.data, copy(patch)); if (callback) callback() }
  }
  for (const [key, fn] of Object.entries(capturedPage)) if (typeof fn === 'function') page[key] = fn.bind(page)
  page.data.selectedDate = date
  page.data.viewMode = 'week'
  return page
}
const { applyPatch } = require('./helpers/set-data')
function renderAs(coach, date) {
  const page = makePage(date)
  page.loadScheduleData()
  page.renderWeek()
  return page
}
function cellOf(page, date, hour) {
  for (const slide of page.data.weekSlides || []) {
    for (const row of slide.rows) {
      if (row.hour !== hour) continue
      for (const cell of row.cells) if (cell.date === date) return cell
    }
  }
  return null
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// ——————————————————————————————————————————————————————————————
// 场景：A 有一份真实销售（含一份课时包）并把授课权授权给 B；B 另有自己的学员与业绩。
// ——————————————————————————————————————————————————————————————
async function seedWorld() {
  for (const name of Object.keys(stores)) stores[name].clear()
  queue = Promise.resolve()
  // 重建两个 coach 的身影，因为上面 clear 了一切
  seedCoach('openid-a', 'ds-a', 'CODEA'); seedCoach('openid-b', 'ds-b', 'CODEB')
  const r = await cmd(A, 'createStudent', 'req-a-student-0001', { name: 'M2 共享测试学员', phone: '13900000001' })
  const studentA = r.result.studentId
  const sale = await cmd(A, 'createCourseSale', 'req-a-sale-0001', {
    studentId: studentA, type: '常规训练', total: 12, remaining: 12, quantity: 12, unitPrice: 300, amount: 3600, date: '2026-09-01', teachingPublicCodes: []
  })
  const granted = await cmd(A, 'grantPackageTeaching', 'req-a-grant-0001', { packageId: sale.result.packageId, publicCodes: ['CODEB'] })
  // B 自己的一本真实账（含一节自己学员的课 —— 真机上 B 课表里那些"蓝色本地课"就是这个形状）
  const bStudent = await cmd(B, 'createStudent', 'req-b-student-0001', { name: 'B 自己的学员', phone: '13900000002' })
  const bSale = await cmd(B, 'createCourseSale', 'req-b-sale-0001', {
    studentId: bStudent.result.studentId, type: '常规训练', total: 10, remaining: 10, quantity: 10, unitPrice: 200, amount: 2000, date: '2026-09-02', teachingPublicCodes: []
  })
  const local = await cmd(B, 'createBooking', 'req-b-book-0001', {
    studentId: bStudent.result.studentId, packageId: bSale.result.packageId, date: DATE, hour: 14, minute: 0
  })
  assert.equal(granted.ok, true, '前置：A 必须能把授课权授给 B')
  assert.equal(local.ok, true, '前置：B 自己的本地一节课要能建出来')
  return { studentA, packageA: sale.result.packageId, saleA: sale.result.saleId, packageB: bSale.result.packageId, studentB: bStudent.result.studentId }
}
let world = null
const sharedBookingByAwait = () => rows('bookings', B.owner, B.datasetId).filter(row => (row.data || {}).packageUsage)

test('① A 建真实销售并把授课权授给 B：不复制会员 / 课包 / 业绩', async () => {
  world = await seedWorld()
  const all = await authorization.authScope(db, 'production').grantsForCoach(B.owner, 'package')
  // 每条 createCourseSale 会给**创建者本人**写一条 canManage 的持有人授权 ⇒ 只看 A 那份包授出去的那一笔。
  const grants = all.filter(row => row.ownerCoachId === A.owner && row.datasetId === A.datasetId)
  assert.equal(grants.length, 1, 'B 必须恰好拿到一条来自 A 的课包授课授权，实得 ' + JSON.stringify(all))
  assert.equal(grants[0].packageId, world.packageA)
  assert.equal(grants[0].coachId, B.owner)
  assert.equal(grants[0].canManage, false, '⛔ 授课权 ≠ 管理权：被授权人不得拿到管理权')
  assert.equal(rows('students', B.owner, B.datasetId).filter(row => row.studentId === world.studentA).length, 0,
    '⛔ 授权绝不能把 A 的会员复制一本到 B 账里')
  assert.equal(rows('packages', B.owner, B.datasetId).filter(row => row.packageId === world.packageA).length, 0,
    '⛔ 授权绝不能产生第二份课时包 / 第二套余额')
  assert.equal(rows('sales', B.owner, B.datasetId).filter(row => row.saleId === world.saleA).length, 0,
    '⛔ 业绩留在创始人 A 那本账')
})

test('② B 用授权课包排课（就用用户那一手的默认选择，直接确认）⇒ 云端成功', async () => {
  const result = await cmd(B, 'createAuthorizedBooking', 'req-b-authbk-0001', {
    studentId: world.studentA, packageId: world.packageA, date: DATE, hour: 10, minute: 0
  })
  assert.equal(result.ok, true, `排课必须成功（云端回复 ${result.code}｜${result.message}）`)
  world.bookingId = result.result.bookingId
  assert.ok(world.bookingId, '必须返回真的 bookingId')
})

test('③ 云端的持久化事实：这一行物理落在 **B 这本账**，跨账定位写在 packageUsage 上', async () => {
  const list = sharedBookingByAwait()
  assert.equal(list.length, 1, 'B 账里必须恰好有一条跨账预约')
  const row = list[0], booking = row.data
  assert.equal(row.ownerCoachId, B.owner, '⭐ 存储位置必须是授课教练 B 那本账')
  assert.equal(row.datasetId, B.datasetId)
  assert.equal(booking.teachingCoachId, B.owner, '⭐ D：授课教练必须是 B（不能被算成 A 的课）')
  assert.equal(booking.status, 'booked', 'E：状态是 booked，不是别的')
  assert.equal(booking.date, DATE)
  assert.equal(Number(booking.hour), 10)
  assert.deepStrictEqual(booking.packageUsage, {
    packageId: world.packageA, studentId: world.studentA, ownerCoachId: A.owner, datasetId: A.datasetId
  }, '跨账定位必须与 A 那份真实课包逐字段一致')
  assert.equal(rows('bookings', A.owner, A.datasetId).length, 0, 'A 账里一条预约都不能有')
  // A 侧被占了一格租赁座（同一份 real 余额），剩余课时不变
  assert.equal(occ(A, world.packageA).reserved, 1, 'A 那份真实课包的占座 +1')
  assert.equal(pkgOf(A, world.packageA).remaining, 12, '占座不动 remaining')
})

test('④ F：B 的完整回读必须成功（真 adapter + 真云端指纹）—— 这一条就是 BUG04 的断链点', async () => {
  useDevice('B')
  const result = await ui.refreshActiveView()
  assert.ok(result && result.ok === true,
    `⭐ B 的完整回读必须成功；失败.code=${result && result.code} —— 这一旦失败，B 的本机 cache 就永远落后（真机 BUG04）`)
  const cache = storage.get('coachCloudActiveCache')
  assert.ok(cache && cache.snapshot, '回读成功必须真的落下一份 cache')
  const found = cache.snapshot.bookings.filter(item => item.id === world.bookingId)
  assert.equal(found.length, 1, 'cache 快照里必须有这一条共享预约')
})

test('⑤ B 的正常课表周视图：10:00 出现这一节，且自己的 14:00 本地课照旧在', async () => {
  useDevice('B')
  const ok = await ui.refreshActiveView()
  assert.ok(ok && ok.ok, '渲染前必须真的读到一份一致快照')
  const page = renderAs(B, DATE)
  const cell = cellOf(page, DATE, 10)
  assert.ok(cell, '必须找得到 10:00 这一格')
  assert.equal(cell.bookings.length, 1, '⭐ BUG04：B 的课表这一格必须恰好出现这一节课')
  assert.equal(cell.bookings[0].studentName, 'M2 共享测试学员', '块上必须是会员真实姓名（借用云端写下的 studentName 快照）')
  assert.equal(cell.bookings[0].displayTime, '10:00')
  assert.equal(cell.bookings[0].statusLabel, '待上')
  assert.equal(cellOf(page, DATE, 14).bookings.length, 1, 'B 自己的本地课必须照旧在（不许为了满足共享课而丢了别的课）')
})

test('⑥ A 的正常课表：绝不能出现 B 的这节课；A 自己的回读也必须成功', async () => {
  useDevice('A')
  const ok = await ui.refreshActiveView()
  assert.ok(ok && ok.ok, 'A 的完整回读也必须成功')
  const page = renderAs(A, DATE)
  const cell = cellOf(page, DATE, 10)
  assert.ok(cell, 'A 也应该有 10:00 这一格（没有就说明没渲染）')
  assert.equal(cell.bookings.length, 0, '⛔ A 的课表绝不能出现 B 授课的那节课（业务规则：A 不显示 B 的课）')
})

test('⑦ 取消链：B 取消 ⇒ 回读仍成功 ⇒ 该格空掉 ⇒ A 那份课包占座归零（remaining 依旧不动）', async () => {
  const cancelled = await cmd(B, 'cancelBooking', 'req-b-cancel-0001', { bookingId: world.bookingId })
  assert.equal(cancelled.ok, true, '取消必须成功')
  useDevice('B')
  const ok = await ui.refreshActiveView()
  assert.ok(ok && ok.ok, '取消之后 B 的回读仍必须成功（共享预约参与回读 ⇒ 不许再把整条读链打死）')
  const page = renderAs(B, DATE)
  assert.equal(cellOf(page, DATE, 10).bookings.length, 0, '取消后这一格必须空掉')
  assert.equal(occ(A, world.packageA).reserved, 0, '占座必须释放在 A 那本账')
  assert.equal(pkgOf(A, world.packageA).remaining, 12, '取消不动 remaining')
  assert.equal(sharedBookingByAwait().length, 0)
})

test('⑧ 完课链 + 收入归属：B 完课 ⇒ 课扣在 A 的账上、收入记在 B 的账上、业绩仍归 A', async () => {
  const again = await cmd(B, 'createAuthorizedBooking', 'req-b-authbk-0002', {
    studentId: world.studentA, packageId: world.packageA, date: DATE, hour: 10, minute: 0
  })
  assert.equal(again.ok, true, '第二次排课必须成功')
  const bookingId = again.result.bookingId
  await cmd(B, 'updateBookingContent', 'req-b-content-0001', {
    bookingId, items: [{ name: '深蹲', group: '腿', sets: 4, reps: 12, weight: '' }], category: '常规训练', duration: 60
  })
  const done = await cmd(B, 'completeBooking', 'req-b-complete-0001', { bookingId })
  assert.equal(done.ok, true, `完课必须成功（${done.code}｜${done.message}）`)

  const income = incomesOf(B)
  assert.equal(income.length, 1, 'B 必须拿到恰好一笔收入')
  assert.equal(income[0].bookingId, bookingId)
  assert.equal(Number(income[0].amount), 300, '收入金额取的是课时包单价快照')
  assert.equal(incomesOf(A).length, 0, '⛔ A 绝不能因为"用了自己的课"而凭空多一笔收入')
  assert.equal(pkgOf(A, world.packageA).used, 1, '⭐ 课时扣在 A 那份真实课包上（只有一份共享余额）')
  assert.equal(pkgOf(A, world.packageA).remaining, 11)
  assert.equal(salesOf(A).reduce((sum, item) => sum + Number(item.amount || 0), 0), 3600, 'A 的销售业绩一个字节都不许变')

  useDevice('B')
  const ok = await ui.refreshActiveView()
  assert.ok(ok && ok.ok, '⭐ 完课之后 B 的回读仍必须成功（done + income 这对关系也必须过关）')
  const page = renderAs(B, DATE)
  const cell = cellOf(page, DATE, 10)
  assert.equal(cell.bookings.length, 1, '完课后这节课仍要在 B 的课表上')
  assert.equal(cell.bookings[0].statusLabel, '已完', '必须呈现成已完成')
})

// 「createAuthorizedBooking」这条命令入口同时服务两种形状 —— 两种都必须能被增量**精确定位**：
//   · 跨账（shared:true）  ：本账只多一条 bookings；课时包在别人账里 ⇒ **绝不能**列 packages（列了就是假话）
//   · 自己账（没有 shared）：本账的 packages 也变了 ⇒ **必须**列 packages（漏了 delta 就少一行 ⇒ 指纹对不上）
function plannedFor(receipt) {
  const to = Number(receipt.revisionAfter)
  return changes.planChanges({ groups: groupsOf(B), receipts: [receipt], sinceRevision: to - 1, toRevision: to })
}
function allReceipts() {
  return rows(META.receipts, B.owner, B.datasetId).filter(row => row.status === 'succeeded').sort((a, b) => Number(a.revisionAfter) - Number(b.revisionAfter))
}

test('⑨-A 增量读取：跨账那一侧只该碰 bookings（不许凭空报一条别人账里的 packages）', async () => {
  // ⚠️ 只挑**这一刻还在库里**的那一条（⑦ 已经取消过一条 ⇒ 它的 receipt 只能算出"删除"，
  //    我们要验的是"跨账预约新增时能精确定位"）。
  const live = new Set(groupsOf(B).bookings.map(row => row.bookingId))
  const receipt = allReceipts()
    .filter(row => row.command === 'createAuthorizedBooking' && row.response && row.response.result && row.response.result.shared === true)
    .filter(row => live.has(row.response.result.bookingId))
    .pop()
  assert.ok(receipt, '场景里必须有一条仍然存在的跨账 createAuthorizedBooking')
  const planned = plannedFor(receipt)
  assert.notEqual(planned.code, 'CHANGES_REQUIRES_FULL_READ',
    `⛔ createAuthorizedBooking 必须有 NARROW 规则（缺了就是每次排课都退回全量读），实得 ${planned.code}`)
  assert.equal(planned.ok, true, `跨账增量必须算得出来（${planned.code}）`)
  assert.ok(((planned.delta.upserts || {}).bookings || []).some(row => row.bookingId === receipt.response.result.bookingId),
    'delta 必须带这一条 bookings')
  assert.ok(!('packages' in (planned.delta.upserts || {})), '⛔ 课时包不在本账 ⇒ upserts 里不许出现 packages')
  assert.ok(!((planned.delta.removals || {}).packages || []).length,
    '⛔ 课时包不在本账 ⇒ removals 里更不许出现 packages（那等于凭空报一条删除，是假话）')
})

test('⑨-B 增量读取：自己账那一侧必须同时带上 packages（漏了就是 delta 少一行）', async () => {
  const own = await cmd(B, 'createAuthorizedBooking', 'req-b-authbk-0003', {
    studentId: world.studentB, packageId: world.packageB, date: DATE, hour: 16, minute: 0
  })
  assert.equal(own.ok, true, 'createAuthorizedBooking 也要能给"自己账里的成员"排课')
  assert.notEqual(own.result.shared, true, '前置：这一侧没有跨账标记')
  const receipt = allReceipts().find(row => row.requestId === 'req-b-authbk-0003')
  const planned = plannedFor(receipt)
  assert.equal(planned.ok, true, `自己账这一侧的增量也要能算出来（${planned.code}）`)
  assert.ok(((planned.delta.upserts || {}).packages || []).some(row => row.packageId === world.packageB),
    '⛔ 自己账里的课时包变了 ⇒ delta 必须带上 packages，否则本地重建指纹与云端对不上（每次退回全量读）')
  assert.ok(((planned.delta.upserts || {}).bookings || []).some(row => row.bookingId === own.result.bookingId))
})

test('⑩ 口子必须是窄的：普通的孤儿预约（没有 packageUsage）仍必须被 BOOKING_RELATION_INVALID 拦住', async () => {
  const { integrity, reconstructCandidate, candidateCollections } = require('../utils/candidate-dataset')
  const base = { students: [], bookings: [{ id: 'bk-orphan', studentId: 'stu-x', packageId: 'pkg-x', date: DATE, hour: 9, minute: 0, typeName: '常规训练', price: 300, status: 'booked' }], incomes: [], sales: [], settings: {}, customExercises: [] }
  assert.throws(() => integrity(reconstructCandidate(candidateCollections(copy(base), B.owner, B.datasetId))),
    error => error.code === 'BOOKING_RELATION_INVALID',
    '⭐ 没跨账标记的预约，条款一个字都没松（这条保证了 BUG04 的修复不是"把校验关掉"）')
  // 反向：同形状但带了真实 packageUsage ⇒ 必须放行
  const shared = copy(base)
  shared.bookings[0].packageUsage = { packageId: 'pkg-x', studentId: 'stu-x', ownerCoachId: A.owner, datasetId: A.datasetId }
  integrity(reconstructCandidate(candidateCollections(shared, B.owner, B.datasetId)))
})

test('⑪-B 缺了跨账位置（ownerCoachId / datasetId）的 packageUsage 不算凭证 ⇒ 仍必须被拦', async () => {
  const { integrity, reconstructCandidate, candidateCollections, sharedUsageOf } = require('../utils/candidate-dataset')
  const booking = { id: 'bk-y', packageId: 'pkg-real', packageUsage: { packageId: 'pkg-real' } }
  assert.equal(sharedUsageOf(booking), null, '没有 ownerCoachId / datasetId 就不许当成跨账凭证')
  const snapshot = { students: [], bookings: [booking], incomes: [], sales: [], settings: {}, customExercises: [] }
  assert.throws(() => integrity(reconstructCandidate(candidateCollections(copy(snapshot), B.owner, B.datasetId))),
    error => error.code === 'BOOKING_RELATION_INVALID')
})

test('⑪ packageId 真伪：假 packageUsage（指向别处的 packageId 与 booking.packageId 不一致）不算跨账凭证', async () => {
  const { integrity, reconstructCandidate, candidateCollections, sharedUsageOf } = require('../utils/candidate-dataset')
  const booking = { id: 'bk-x', packageId: 'pkg-real', packageUsage: { packageId: 'pkg-other', ownerCoachId: A.owner, datasetId: A.datasetId } }
  assert.equal(sharedUsageOf(booking), null, 'packageUsage.packageId 必须等于 booking.packageId 才算数')
  const snapshot = { students: [], bookings: [booking], incomes: [], sales: [], settings: {}, customExercises: [] }
  const rebuilt = reconstructCandidate(candidateCollections(copy(snapshot), B.owner, B.datasetId))
  assert.throws(() => integrity(rebuilt), error => error.code === 'BOOKING_RELATION_INVALID')
})

test('⑫ 一份令牌只有一个人：A / B 两本账的业务行互不重叠（没有被复制出来的第二份数据）', async () => {
  const cross = Object.keys(stores).filter(name => PHYSICAL.includes(name)).reduce((list, name) => {
    const seen = new Map()
    for (const row of rows(name, A.owner, A.datasetId)) seen.set(`${name}:${row.studentId || row.packageId || row.bookingId || row.saleId || row.settingsId || row.customExerciseId}`, row)
    for (const row of rows(name, B.owner, B.datasetId)) if (seen.has(`${name}:${row.studentId || row.packageId || row.bookingId || row.saleId || row.settingsId || row.customExerciseId}`)) list.push(name)
    return list
  }, [])
  assert.equal(cross.length, 0, '⛔ A / B 两本账不许出现同一个业务 id（一旦复制就会出现第二套余额），实得 ' + JSON.stringify(cross))
})

;(async () => { await run() })()
