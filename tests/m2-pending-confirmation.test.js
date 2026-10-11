// M2「超时未下课 → 待确认」永久回归（2026-09-26）。
//
// 产品规则（用户最终确认）：
//   · 超过「预计结束时间 + 3 小时」仍未完成 ⇒ 进入「待确认」；
//   · 待确认**继续占用 reserved**，不自动扣课、不自动退课、不自动产生收入、不自动判缺席；
//   · 只能由教练人工选择「确认已完成」或「课程未进行」；
//   · 老 booking 没有 plannedMinutes ⇒ **不参与**该规则（不补默认值、不批量迁移）。
//
// 防的事故：
//  ① 用"开始时间 + 3 小时"当基准（用户明确否定）；
//  ② 把 60 分钟当成所有课程的时长（本项目历史硬编码陷阱）；
//  ③ 待确认时自动释放 reserved ⇒ 这节课能被别人再约走；
//  ④ 待确认时自动扣课 / 自动产生收入 ⇒ 系统替教练判断"课上没上"；
//  ⑤ 老预约被强行补 60 分钟 ⇒ 历史数据被错误的时长假设污染。

const assert = require('assert')
const { META, coachIdFor, fixedId, createService } = require('../cloudfunctions/coachBusinessCommand/core')
const { handlers } = require('../cloudfunctions/coachBusinessCommand/handlers')
const cloud = require('../cloudfunctions/coachBusinessCommand/occupancy')
const local = require('../utils/package-occupancy')

const at = (day, hour, minute = 0) => new Date(2026, 0, day, hour, minute, 0, 0).getTime()
const booking = (extra = {}) => ({ id: 'b1', studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 16, minute: 0, typeName: '拉伸恢复', price: 300, status: 'booked', ...extra })

// ——————————————————————————————— 假云端（跑真实 handlers）
const copy = value => JSON.parse(JSON.stringify(value))
const names = [...Object.values(META), 'students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
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
            async remove() { const removed = target[name].delete(id) ? 1 : 0; return { stats: { removed } } }
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
const clear = () => { Object.values(stores).forEach(store => store.clear()); queue = Promise.resolve(); openId = 'openid-a' }
const businessId = (name, owner, datasetId, id) => fixedId(`coach-business-${name}`, owner, `${datasetId}:${id}`)
function seed(open = openId, datasetId = 'dataset-active', revision = 0) {
  const owner = coachIdFor(open)
  put(META.coaches, owner, { openId: open, status: 'active' })
  put(META.datasets, fixedId('coach-dataset', owner, datasetId), { ownerCoachId: owner, datasetId, status: 'active', integrityStatus: 'verified', checksum: 'ok', byteSize: 1, summary: {}, schemaVersion: 1 })
  put(META.heads, fixedId('coach-data-head', owner), { ownerCoachId: owner, activeDatasetId: datasetId, headVersion: 1 })
  put(META.revisions, fixedId('coach-data-revision', owner, datasetId), { ownerCoachId: owner, datasetId, dataRevision: revision })
  return { owner, datasetId }
}
const main = () => createService({ db, getOpenId: () => openId, handlers, now: () => ++clock })
const execute = (command, requestId, expectedRevision, payload) => ({ action: 'execute', envelope: { command, requestId, expectedRevision, payload } })
const rows = name => [...stores[name].values()]
const pkgData = packageId => rows('packages').find(row => row.packageId === packageId).data
let revision = 0
async function run(command, requestId, payload) {
  const result = await main()(execute(command, requestId, revision, payload))
  if (result && result.ok) revision = result.datasetRevision
  return result
}
function seedSpace({ owner, datasetId }, studentId, packageId, remaining, total) {
  put('students', businessId('students', owner, datasetId, studentId), { ownerCoachId: owner, datasetId, studentId, data: { id: studentId, name: '张三', phone: '13800138000', packages: [{ id: packageId }] } })
  put('packages', businessId('packages', owner, datasetId, packageId), { ownerCoachId: owner, datasetId, packageId, studentId, data: { id: packageId, studentId, type: '拉伸恢复', total, remaining, used: total - remaining, price: 300, status: 'active', saleDate: '2026-01-01' } })
}
async function test(name, fn) {
  try { clear(); revision = 0; await fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}

;(async () => {
  await test('16:00 上课 + 60 分钟 ⇒ 20:00 后才进入待确认（基准是"预计结束 + 3 小时"）', async () => {
    const row = booking({ plannedMinutes: 60 })
    assert.equal(cloud.plannedEndMs(row), at(2, 17, 0))
    assert.equal(cloud.isPendingConfirmation(row, at(2, 19, 59)), false, '还没到')
    assert.equal(cloud.isPendingConfirmation(row, at(2, 20, 1)), true, '超过 3 小时宽限')
  })

  await test('单节 90 分钟 ⇒ 17:30 结束，20:30 后才待确认（不是按 60 分钟算）', async () => {
    const row = booking({ plannedMinutes: 90 })
    assert.equal(cloud.plannedEndMs(row), at(2, 17, 30))
    assert.equal(cloud.isPendingConfirmation(row, at(2, 20, 29)), false)
    assert.equal(cloud.isPendingConfirmation(row, at(2, 20, 31)), true)
  })

  await test('老预约没有 plannedMinutes ⇒ 永远不参与待确认（不补默认值）', async () => {
    const row = booking()
    assert.equal(cloud.plannedMinutesOf(row), null)
    assert.equal(cloud.isPendingConfirmation(row, at(3, 23, 59)), false, '哪怕过去一天也不能擅自判')
  })

  await test('已完成的预约不进入待确认', async () => {
    assert.equal(cloud.isPendingConfirmation(booking({ plannedMinutes: 60, status: 'done' }), at(3, 12, 0)), false)
  })

  await test('待确认**继续占用** reserved，availableToBook 不变（10 / 3 ⇒ 7）', async () => {
    const pkg = { id: 'p1', remaining: 10, reserved: 3 }
    const before = cloud.occupancyOf(pkg)
    assert.deepEqual(before, { remaining: 10, reserved: 3, availableToBook: 7 })
    // 待确认是派生状态：它不改变任何落库值，因此 availableToBook 仍然是 7
    const still = cloud.occupancyOf(pkg)
    assert.equal(still.availableToBook, 7)
    assert.equal(local.occupancyOf(pkg).availableToBook, 7, '本机与云端同口径')
  })

  await test('待确认 → 「确认已完成」只结算一次：remaining 10→9、reserved 3→2、available 仍是 7', async () => {
    const space = seed(); seedSpace(space, 's1', 'p1', 10, 20)
    const created = await run('createBooking', 'm2_pend_001', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 10, minute: 0 })
    const bookingId = created.result.bookingId
    // 再补两条预约，凑成 reserved = 3（模拟"其中一节已超时待确认"）
    await run('createBooking', 'm2_pend_002', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 12, minute: 0 })
    await run('createBooking', 'm2_pend_003', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 14, minute: 0 })
    assert.equal(pkgData('p1').reserved, 3)
    assert.equal(cloud.occupancyOf(pkgData('p1')).availableToBook, 7)
    const done = await run('completeBooking', 'm2_pend_004', { bookingId })
    assert.equal(done.ok, true)
    assert.equal(pkgData('p1').remaining, 9); assert.equal(pkgData('p1').reserved, 2)
    assert.equal(cloud.occupancyOf(pkgData('p1')).availableToBook, 7, '完课后 available 仍是 7')
    const again = await run('completeBooking', 'm2_pend_005', { bookingId })
    assert.equal(again.ok, false); assert.equal(again.code, 'BOOKING_ALREADY_DONE', '不允许重复扣课')
    assert.equal(pkgData('p1').remaining, 9)
  })

  await test('待确认 → 「课程未进行」：只释放占座，remaining 不变（10 / 3 ⇒ 8）', async () => {
    const space = seed(); seedSpace(space, 's1', 'p1', 10, 20)
    const created = await run('createBooking', 'm2_pend2_001', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 10, minute: 0 })
    const bookingId = created.result.bookingId
    await run('createBooking', 'm2_pend2_002', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 12, minute: 0 })
    await run('createBooking', 'm2_pend2_003', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 14, minute: 0 })
    assert.equal(pkgData('p1').reserved, 3)
    const result = await run('markBookingNotHeld', 'm2_pend2_004', { bookingId })
    assert.equal(result.ok, true)
    assert.equal(pkgData('p1').remaining, 10, '不扣课时')
    assert.equal(pkgData('p1').used, 10, '不改 used')
    assert.equal(pkgData('p1').reserved, 2)
    assert.equal(cloud.occupancyOf(pkgData('p1')).availableToBook, 8)
    assert.equal(rows('incomes').length, 0, '不产生收入')
  })

  await test('最后一节处于待确认时，其他预约拿不到这一节', async () => {
    const space = seed(); seedSpace(space, 's1', 'p1', 1, 20)
    await run('createBooking', 'm2_pend3_001', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 10, minute: 0 })
    assert.equal(pkgData('p1').reserved, 1)
    assert.equal(cloud.occupancyOf(pkgData('p1')).availableToBook, 0)
    const second = await run('createBooking', 'm2_pend3_002', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 14, minute: 0 })
    assert.equal(second.ok, false); assert.equal(second.code, 'PACKAGE_NO_AVAILABLE')
    assert.equal(pkgData('p1').remaining, 1, '不允许变负')
  })

  await test('本机与云端：待确认口径逐样本一致', async () => {
    const samples = [booking({ plannedMinutes: 60 }), booking({ plannedMinutes: 45 }), booking(), booking({ plannedMinutes: 60, status: 'done' })]
    const moments = [at(2, 17, 0), at(2, 20, 0), at(2, 20, 1), at(3, 9, 0)]
    samples.forEach(row => moments.forEach(now => {
      assert.equal(cloud.isPendingConfirmation(row, now), local.isPendingConfirmation(row, now))
      assert.equal(cloud.pendingStateOf(row, now), local.pendingStateOf(row, now))
    }))
  })

  if (!process.exitCode) process.stdout.write('ALL M2 PENDING CONFIRMATION TESTS PASSED\n')
})()
