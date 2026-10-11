// M2 课时占用规则（reserved / availableToBook）永久回归 —— **跑真实云端 handlers**（2026-09-26）。
//
// 防的事故：
//  ① 预约不占座 ⇒ 最后一节被两条预约同时占（本项目最危险的一类超额）；
//  ② 「排满了」被当成「还有课时」⇒ 页面显示 remaining=5 却放不出预约资格；
//  ③ 两种 0 混为一谈 ⇒ remaining>0 但 availableToBook=0 时提示"课时已用完"，文案骗人；
//  ④ 取消/完课释放顺序写反 ⇒ 多释放一节（占座泄漏的反向故障）；
//  ⑤ availableToBook 落库 ⇒ 出现第二套余额；
//  ⑥ 历史 package 没有 reserved ⇒ 惰性初始化少算历史预约。

const assert = require('assert')
const { META, coachIdFor, fixedId, createService } = require('../cloudfunctions/coachBusinessCommand/core')
const { handlers } = require('../cloudfunctions/coachBusinessCommand/handlers')
const occupancyCloud = require('../cloudfunctions/coachBusinessCommand/occupancy')

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

// 历史形态的 package / student：没有 reserved、没有 reservedVersion（零迁移的关键场景）
function seedLegacy({ owner, datasetId }, studentId, packageId, remaining, total) {
  put('students', businessId('students', owner, datasetId, studentId), {
    ownerCoachId: owner, datasetId, studentId,
    data: { id: studentId, name: '张三', phone: '13800138000', packages: [{ id: packageId }] }
  })
  put('packages', businessId('packages', owner, datasetId, packageId), {
    ownerCoachId: owner, datasetId, packageId, studentId,
    data: { id: packageId, studentId, type: '拉伸恢复', total, remaining, used: total - remaining, price: 300, status: 'active', saleDate: '2026-01-01' }
  })
}

function legacyBooking({ owner, datasetId }, bookingId, packageId, studentId, hour) {
  put('bookings', businessId('bookings', owner, datasetId, bookingId), {
    ownerCoachId: owner, datasetId, bookingId, packageId, studentId, sortIndex: 0,
    data: { id: bookingId, studentId, packageId, date: '2026-01-02', hour, minute: 0, typeName: '拉伸恢复', price: 300, status: 'booked', createdAt: 1 }
  })
}

const pkgRow = packageId => rows('packages').find(row => row.packageId === packageId)
const pkgData = packageId => pkgRow(packageId).data
const bookingsOf = packageId => rows('bookings').filter(row => row.packageId === packageId && row.data.status === 'booked')
const occ = packageId => occupancyCloud.occupancyOf(pkgData(packageId))

let revision = 0
async function run(command, requestId, payload) {
  const result = await main()(execute(command, requestId, revision, payload))
  if (result && result.ok) revision = result.datasetRevision
  return result
}

async function test(name, fn) {
  try { clear(); revision = 0; await fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}

;(async () => {
  await test('预约即占座：reserved +1，remaining / used 一律不动', async () => {
    const space = seed(); seedLegacy(space, 's1', 'p1', 5, 20)
    const created = await run('createBooking', 'm2_create_001', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 10, minute: 0 })
    assert.equal(created.ok, true)
    assert.equal(pkgData('p1').reserved, 1, '预约必须占 1 节')
    assert.equal(pkgData('p1').reservedVersion, occupancyCloud.RESERVED_VERSION)
    assert.equal(pkgData('p1').remaining, 5, '预约不能扣 remaining')
    assert.equal(pkgData('p1').used, 15, '预约不能改 used')
    assert.equal(occ('p1').availableToBook, 4)
  })

  await test('预约默认 plannedMinutes = 60，允许单节指定 90', async () => {
    const space = seed(); seedLegacy(space, 's1', 'p1', 5, 20)
    await run('createBooking', 'm2_create_002', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 10, minute: 0 })
    const second = await run('createBooking', 'm2_create_003', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 12, minute: 0, plannedMinutes: 90 })
    assert.equal(second.ok, true)
    const byHour = rows('bookings').sort((a, b) => a.data.hour - b.data.hour)
    assert.equal(byHour[0].data.plannedMinutes, 60, '不传就用默认 60')
    assert.equal(byHour[1].data.plannedMinutes, 90, '单节可指定')
  })

  await test('remaining > 0 但 availableToBook = 0 ⇒ PACKAGE_NO_AVAILABLE，不建预约', async () => {
    const space = seed(); seedLegacy(space, 's1', 'p1', 2, 20)
    await run('createBooking', 'm2_full_001', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 10, minute: 0 })
    await run('createBooking', 'm2_full_002', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 12, minute: 0 })
    assert.equal(occ('p1').remaining, 2); assert.equal(occ('p1').availableToBook, 0)
    const third = await run('createBooking', 'm2_full_003', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 14, minute: 0 })
    assert.equal(third.ok, false); assert.equal(third.code, 'PACKAGE_NO_AVAILABLE')
    assert.equal(bookingsOf('p1').length, 2, '绝不产生超额预约')
    assert.equal(pkgData('p1').remaining, 2, 'remaining 不允许变负')
  })

  await test('remaining = 0 ⇒ PACKAGE_NO_REMAINING（与"排满了"必须是两个码）', async () => {
    const space = seed(); seedLegacy(space, 's1', 'p1', 0, 20)
    const result = await run('createBooking', 'm2_empty_001', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 10, minute: 0 })
    assert.equal(result.ok, false); assert.equal(result.code, 'PACKAGE_NO_REMAINING')
  })

  await test('取消释放占座：reserved −1，remaining / used 不变', async () => {
    const space = seed(); seedLegacy(space, 's1', 'p1', 5, 20)
    const created = await run('createBooking', 'm2_cancel_001', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 10, minute: 0 })
    const bookingId = created.result.bookingId
    assert.equal(pkgData('p1').reserved, 1)
    const cancelled = await run('cancelBooking', 'm2_cancel_002', { bookingId })
    assert.equal(cancelled.ok, true)
    assert.equal(pkgData('p1').reserved, 0)
    assert.equal(pkgData('p1').remaining, 5); assert.equal(pkgData('p1').used, 15)
    assert.equal(occ('p1').availableToBook, 5)
  })

  await test('完课结算：reserved −1 + remaining −1 + used +1 + 产生一条 income', async () => {
    const space = seed(); seedLegacy(space, 's1', 'p1', 5, 20)
    const created = await run('createBooking', 'm2_done_001', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 10, minute: 0 })
    const bookingId = created.result.bookingId
    const done = await run('completeBooking', 'm2_done_002', { bookingId })
    assert.equal(done.ok, true)
    assert.equal(pkgData('p1').reserved, 0, '完课必须释放占座')
    assert.equal(pkgData('p1').remaining, 4); assert.equal(pkgData('p1').used, 16)
    assert.equal(rows('incomes').length, 1)
    assert.equal(occ('p1').availableToBook, 4)
  })

  await test('历史 package 惰性初始化：首次触碰时把已有有效预约算进 reserved（零迁移）', async () => {
    const space = seed(); seedLegacy(space, 's1', 'p1', 5, 20)
    legacyBooking(space, 'b_legacy_1', 'p1', 's1', 8)
    legacyBooking(space, 'b_legacy_2', 'p1', 's1', 9)
    assert.equal(pkgData('p1').reserved, undefined, '历史数据本来没有 reserved')
    // 取消其中一条：应当先数到 2（含这条），再 −1 ⇒ reserved = 1
    const cancelled = await run('cancelBooking', 'm2_legacy_001', { bookingId: 'b_legacy_1' })
    assert.equal(cancelled.ok, true)
    assert.equal(pkgData('p1').reserved, 1, '顺序反了会变成 0（多释放一节）')
    assert.equal(pkgData('p1').reservedVersion, occupancyCloud.RESERVED_VERSION)
    assert.equal(occ('p1').availableToBook, 4)
  })

  await test('重复取消不得重复释放（占座泄漏的反向故障）', async () => {
    const space = seed(); seedLegacy(space, 's1', 'p1', 5, 20)
    const created = await run('createBooking', 'm2_dup_001', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 10, minute: 0 })
    const bookingId = created.result.bookingId
    await run('cancelBooking', 'm2_dup_002', { bookingId })
    const again = await run('cancelBooking', 'm2_dup_003', { bookingId })
    assert.equal(again.ok, false); assert.equal(again.code, 'BOOKING_NOT_FOUND')
    assert.equal(pkgData('p1').reserved, 0, '绝不能变成负数')
  })

  await test('availableToBook 是派生值，绝不落库（不允许出现第二套余额）', async () => {
    const space = seed(); seedLegacy(space, 's1', 'p1', 5, 20)
    await run('createBooking', 'm2_derive_001', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 10, minute: 0 })
    const stored = pkgData('p1')
    assert.equal('availableToBook' in stored, false)
    assert.equal('bookable' in stored, false)
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'availableToBook'), false)
  })

  await test('「课程未进行」：只释放占座，remaining / used 不变，不产生 income', async () => {
    const space = seed(); seedLegacy(space, 's1', 'p1', 5, 20)
    const created = await run('createBooking', 'm2_nothold_001', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 10, minute: 0 })
    const bookingId = created.result.bookingId
    assert.equal(pkgData('p1').reserved, 1)
    const result = await run('markBookingNotHeld', 'm2_nothold_002', { bookingId })
    assert.equal(result.ok, true)
    assert.equal(pkgData('p1').reserved, 0, '释放占座')
    assert.equal(pkgData('p1').remaining, 5, '不扣课时')
    assert.equal(pkgData('p1').used, 15, '不改 used')
    assert.equal(rows('incomes').length, 0, '不产生收入')
    assert.equal(occ('p1').availableToBook, 5)
  })

  await test('「课程未进行」重复点击不得重复释放', async () => {
    const space = seed(); seedLegacy(space, 's1', 'p1', 5, 20)
    const created = await run('createBooking', 'm2_nothold2_001', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 10, minute: 0 })
    const bookingId = created.result.bookingId
    await run('markBookingNotHeld', 'm2_nothold2_002', { bookingId })
    const again = await run('markBookingNotHeld', 'm2_nothold2_003', { bookingId })
    assert.equal(again.ok, false); assert.equal(again.code, 'BOOKING_NOT_FOUND')
    assert.equal(pkgData('p1').reserved, 0)
  })

  await test('已产生收入的预约不能被判为「未进行」', async () => {
    const space = seed(); seedLegacy(space, 's1', 'p1', 5, 20)
    const created = await run('createBooking', 'm2_nothold3_001', { studentId: 's1', packageId: 'p1', date: '2026-01-02', hour: 10, minute: 0 })
    const bookingId = created.result.bookingId
    await run('completeBooking', 'm2_nothold3_002', { bookingId })
    const result = await run('markBookingNotHeld', 'm2_nothold3_003', { bookingId })
    assert.equal(result.ok, false); assert.equal(result.code, 'BOOKING_ALREADY_DONE')
    assert.equal(pkgData('p1').remaining, 4)
  })

  if (!process.exitCode) process.stdout.write('ALL M2 PACKAGE OCCUPANCY TESTS PASSED\n')
})()
