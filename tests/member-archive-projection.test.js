// 会员「多份学员档案」只读投影 + 分组展示 · 永久回归（2026-10-01）
//
// ⛳ 这一份盯的是：**一位会员认领了多份学员档案之后，界面能不能分得清哪份是谁的**。
//
// 【既定模型（⛔ 不改，也不许被本轮改动悄悄改掉）】
//   一个微信 = **一个**会员账户（memberId）；一个会员账户**可以**认领 **N 份**学员档案（claim）。
//   两份档案是**两条独立记录**（§112-B 模型 1），绝不按姓名/手机合并。
//
// 【本轮只改两件事】
//   ① 只读投影：下发 `archives[]`，并给每份课包 / 每条预约打上不透明 `archiveId`；
//   ② 展示：按档案分组、顶部明说是合计、预约/课包能看出属于哪份档案。
//   ⛔ 不新增解绑/删除、不改业务写入、不改预约/改期/取消/扣课时/授权的任何判定。
//
// 【真机场景（本文件的 1:1 复刻）】
//   B 手机：Sandbox 假学员 12 节（已用 1 ⇒ 剩 11） + M2 共享测试学员 5 节（剩 4）/ 10 节（剩 9）
//   ⇒ 顶部合计 24；分组必须是 11 与 13。

const assert = require('assert')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const read = require(path.join(ROOT, 'cloudfunctions/readMyMemberData/service'))
const { createService: readService, fixedId, archiveIdOf } = read
const memberBooking = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
const viewModel = require(path.join(ROOT, 'utils/member-view-model'))
const bookingView = require(path.join(ROOT, 'utils/member-booking-view'))
const { createWorld, runner } = require('./helpers/m2-business-world')

const ENV = 'sandbox'
const MEMBER_OPEN = 'open-m'
const CLAIMS = 'member_sandbox_student_claims'
const ACCOUNTS = 'member_sandbox_accounts'
const PROFILES = 'member_sandbox_coach_profiles'
const HEADS = 'coach_sandbox_heads'
const memberId = memberBooking.memberIdFor(MEMBER_OPEN)
const coachIdOf = open => memberBooking.fixedId('sha', open) // 占位，下面用真公式覆盖
const coachIdA = require(path.join(ROOT, 'cloudfunctions/memberIdentityCommand/service')).coachIdFor('open-a')
const coachIdB = require(path.join(ROOT, 'cloudfunctions/memberIdentityCommand/service')).coachIdFor('open-b')

// ------------------------------------------------------------------ 只读假云（跑的是**真的** readMyMemberData）
function createReadCloud(openId = MEMBER_OPEN) {
  const stores = {}
  let trips = 0
  const copy = value => JSON.parse(JSON.stringify(value))
  const scope = target => ({
    collection(name) {
      const store = target[name] || (target[name] = new Map())
      return {
        doc(id) {
          return {
            async set({ data }) { store.set(id, { ...copy(data), _id: id }) },
            async remove() { store.delete(id) }
          }
        },
        where(query) {
          let skip = 0, limit = 100
          const api = {
            skip(n) { skip = n; return api },
            limit(n) { limit = n; return api },
            async get() {
              trips += 1
              const rows = [...store.values()].filter(row => Object.keys(query).every(key => row[key] === query[key]))
              return { data: rows.slice(skip, skip + limit).map(copy) }
            }
          }
          return api
        }
      }
    },
    async runTransaction(work) {
      const draft = {}
      Object.keys(target).forEach(name => { draft[name] = new Map([...target[name]].map(([k, v]) => [k, copy(v)])) })
      const result = await work(scope(draft))
      Object.keys(draft).forEach(name => { target[name] = draft[name] })
      return result
    }
  })
  const db = scope(stores)
  return {
    stores, db,
    trips: () => trips, resetTrips() { trips = 0 },
    put(name, id, row) { if (!stores[name]) stores[name] = new Map(); stores[name].set(id, { ...row, _id: id }) },
    call(event) { return readService({ db, getOpenId: () => openId })(event) }
  }
}

function seedAccount(cloud) {
  cloud.put(ACCOUNTS, fixedId(ACCOUNTS, memberId), { memberId, displayName: '测试会员', theme: 'vitality', status: 'active' })
}
function seedCoach(cloud, coachId, datasetId, displayName) {
  cloud.put(HEADS, fixedId(HEADS, coachId), { ownerCoachId: coachId, environment: 'sandbox', activeDatasetId: datasetId })
  cloud.put(PROFILES, fixedId(PROFILES, coachId), { coachId, displayName, discoverable: true })
}
function seedStudent(cloud, coachId, datasetId, studentId, name) {
  cloud.put('students', fixedId('students', coachId, datasetId, studentId), {
    ownerCoachId: coachId, datasetId, studentId,
    // ⛔ 故意塞进**绝不该出网**的内部字段 ⇒ 段⑧ 全文扫描会抓它们
    data: { id: studentId, name, phone: '13800000000', internalFlag: 'secret', privateNote: '教练私人备注' }
  })
}
function seedPackage(cloud, coachId, datasetId, studentId, packageId, remaining, total, saleDate) {
  cloud.put('packages', fixedId('packages', coachId, datasetId, packageId), {
    ownerCoachId: coachId, datasetId, studentId, packageId,
    data: { id: packageId, type: '常规训练', total, used: total - remaining, remaining, reserved: 0, reservedVersion: 2, price: 300, status: 'active', saleDate }
  })
}
function seedBookingRow(cloud, coachId, datasetId, studentId, bookingId, date, packageId, status = 'booked') {
  cloud.put('bookings', fixedId('bookings', coachId, datasetId, bookingId), {
    ownerCoachId: coachId, datasetId, studentId, bookingId,
    data: { id: bookingId, studentId, packageId, status, date, hour: 10, minute: 0, duration: 60, typeName: '常规训练', notes: '绝不能出网' }
  })
}
// ⭐ 读路径的返回里**没有** `bookings` 这个字段：待上课在 `nextBooking`（只一条），已完成在 `recentTraining`。
//   两条档案各放一条（一条待上课 + 一条已完成）⇒ 正好覆盖"两条档案的预约都要能辨认"。
function allBookingRows(res) {
  const rows = []
  if (res.nextBooking) rows.push(res.nextBooking)
  ;(res.recentTraining || []).forEach(row => rows.push(row))
  return rows
}
function seedClaimRow(cloud, coachId, studentId) {
  const claimId = fixedId(CLAIMS, coachId, studentId)
  cloud.put(CLAIMS, claimId, { claimId, memberId, coachId, studentId, status: 'verified' })
  return claimId
}
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32)

// ⭐ 真机 1:1：先 seed 出来的假学员（12 节 / 剩 11），后认领的 M2（5 节剩 4 + 10 节剩 9）
function seedTwoArchives(cloud) {
  seedAccount(cloud)
  seedCoach(cloud, coachIdB, 'ds-b', 'Sandbox 教练')
  seedCoach(cloud, coachIdA, 'ds-a', '张飞教练')
  seedStudent(cloud, coachIdB, 'ds-b', 'stu-seed', '假学员')
  seedStudent(cloud, coachIdA, 'ds-a', 'stu-m2', 'M2共享测试学员')
  seedPackage(cloud, coachIdB, 'ds-b', 'stu-seed', 'pkg-12', 11, 12, '2026-09-01')
  seedPackage(cloud, coachIdA, 'ds-a', 'stu-m2', 'pkg-5', 4, 5, '2026-09-28')
  seedPackage(cloud, coachIdA, 'ds-a', 'stu-m2', 'pkg-10', 9, 10, '2026-09-30')
  seedBookingRow(cloud, coachIdB, 'ds-b', 'stu-seed', 'bk-seed', '2026-10-05', 'pkg-12', 'booked')
  seedBookingRow(cloud, coachIdA, 'ds-a', 'stu-m2', 'bk-m2', '2026-10-06', 'pkg-5', 'done')
  const claimSeed = seedClaimRow(cloud, coachIdB, 'stu-seed')
  const claimM2 = seedClaimRow(cloud, coachIdA, 'stu-m2')
  return { claimSeed, claimM2 }
}

const byName = (rows, name) => rows.find(row => row.name === name)

async function run() {
  // ------------------------------------------------------------------ ① 两条 claim ⇒ 两份档案，绝不合并
  await runner('archive-① 两条 claim 下发两份档案，archiveId 互不相同', async () => {
    const cloud = createReadCloud(); seedTwoArchives(cloud)
    const res = await cloud.call({ action: 'read', environment: ENV })
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.archives.length, 2, '两条 claim 必须是两份档案')
    assert.notStrictEqual(res.archives[0].archiveId, res.archives[1].archiveId, '两份档案的 archiveId 不许相同')
    assert.strictEqual(res.archiveCount, 2)
  })

  // ------------------------------------------------------------------ ② 11 与 4+9 分组正确
  await runner('archive-② Sandbox 剩 11 / M2 剩 13（4+9）分组正确', async () => {
    const cloud = createReadCloud(); seedTwoArchives(cloud)
    const res = await cloud.call({ action: 'read', environment: ENV })
    const seed = byName(res.archives, '假学员'), m2 = byName(res.archives, 'M2共享测试学员')
    assert.ok(seed && m2, `两份档案都必须按学员姓名下发，实测：${res.archives.map(row => row.name).join(' / ')}`)
    assert.strictEqual(seed.remaining, 11, 'Sandbox 那份必须是 11')
    assert.strictEqual(m2.remaining, 13, 'M2 那份必须是 4+9=13')
    assert.strictEqual(m2.packageCount, 2)
    const groups = viewModel.packageGroups(res)
    assert.strictEqual(groups.length, 2)
    const groupM2 = groups.find(row => row.name === 'M2共享测试学员')
    assert.deepEqual(groupM2.packages.map(row => row.remaining).sort((a, b) => a - b), [4, 9])
  })

  // ------------------------------------------------------------------ ③ 总数仍为 24（合计口径一个字节没改）
  await runner('archive-③ 合计仍是 24，且等于各分组之和', async () => {
    const cloud = createReadCloud(); seedTwoArchives(cloud)
    const res = await cloud.call({ action: 'read', environment: ENV })
    assert.strictEqual(res.summary.remaining, 24, '顶部合计必须仍是 24')
    const groups = viewModel.packageGroups(res)
    const summed = groups.reduce((sum, row) => sum + row.remaining, 0)
    assert.strictEqual(summed, 24, '各分组剩余之和必须等于合计')
    const balance = viewModel.balanceHead(res)
    assert.strictEqual(balance.total, 24)
    assert.strictEqual(balance.multiple, true, '多档案必须被标出来')
    assert.strictEqual(balance.breakdown.length, 2)
    assert.deepEqual(balance.breakdown.map(row => row.remaining).sort((a, b) => a - b), [11, 13])
  })

  // ------------------------------------------------------------------ ④ 两条 claim 的课包不会混进同一组
  await runner('archive-④ 课包按 archiveId 归组，绝不串档案', async () => {
    const cloud = createReadCloud(); seedTwoArchives(cloud)
    const res = await cloud.call({ action: 'read', environment: ENV })
    const groups = viewModel.packageGroups(res)
    const seedGroup = groups.find(row => row.name === '假学员')
    const m2Group = groups.find(row => row.name === 'M2共享测试学员')
    assert.strictEqual(seedGroup.packages.length, 1)
    assert.strictEqual(m2Group.packages.length, 2)
    const seedIds = new Set(seedGroup.packages.map(row => row.packageViewId))
    m2Group.packages.forEach(row => assert.ok(!seedIds.has(row.packageViewId), 'M2 的课包不许出现在另一份档案的组里'))
    // 每份课包带的 archiveId 必须与它所属那份档案一致
    const archiveByPkg = new Map(res.archives.map(row => [row.archiveId, row.name]))
    res.packages.forEach(row => assert.ok(archiveByPkg.has(row.archiveId), '每份课包都必须带一个真实存在的 archiveId'))
    assert.strictEqual(res.packages.filter(row => archiveByPkg.get(row.archiveId) === 'M2共享测试学员').length, 2)
  })

  // ------------------------------------------------------------------ ⑤ 单 claim 用户：界面不许变复杂
  await runner('archive-⑤ 单份档案 ⇒ 不分组、不显示档案名、不出现「合计」字样', async () => {
    const cloud = createReadCloud()
    seedAccount(cloud)
    seedCoach(cloud, coachIdA, 'ds-a', '张飞教练')
    seedStudent(cloud, coachIdA, 'ds-a', 'stu-m2', 'M2共享测试学员')
    seedPackage(cloud, coachIdA, 'ds-a', 'stu-m2', 'pkg-5', 4, 5, '2026-09-28')
    seedClaimRow(cloud, coachIdA, 'stu-m2')
    const res = await cloud.call({ action: 'read', environment: ENV })
    assert.strictEqual(res.archiveCount, 1)
    const groups = viewModel.packageGroups(res)
    assert.strictEqual(groups.length, 1, '单档案只许一组')
    assert.strictEqual(groups[0].grouped, false, '单档案不显示档案标题（界面与改造前一致）')
    assert.strictEqual(groups[0].packages.length, 1)
    const balance = viewModel.balanceHead(res)
    assert.strictEqual(balance.multiple, false, '单档案不许说“合计”')
    assert.deepEqual(balance.breakdown, [])
    // 档案名索引：单档案 ⇒ 空表 ⇒ 预约卡片一行档案名都不多显示
    assert.deepEqual(bookingView.archiveNameIndex(res.archives), {})
  })

  // ------------------------------------------------------------------ ⑥ 预约卡片能辨认所属档案
  await runner('archive-⑥ 两条档案的预约各自显示自己的档案名', async () => {
    const cloud = createReadCloud(); seedTwoArchives(cloud)
    const res = await cloud.call({ action: 'read', environment: ENV })
    const archivesById = bookingView.archiveNameIndex(res.archives)
    assert.strictEqual(Object.keys(archivesById).length, 2)
    const own = allBookingRows(res)
    const views = bookingView.splitBookings(own, bookingView.packageNameIndex(res.packages), archivesById)
    const cards = views.upcoming.concat(views.history)
    assert.strictEqual(cards.length, 2, '两条档案各一条预约')
    const texts = cards.map(row => row.archiveText).sort()
    assert.deepEqual(texts, ['M2共享测试学员', '假学员'], `两张卡片必须分别标出自己的档案，实测：${JSON.stringify(texts)}`)
    cards.forEach(row => assert.strictEqual(row.hasArchive, true))
  })

  // ------------------------------------------------------------------ ⑦ 单档案的预约卡片不带档案名
  await runner('archive-⑦ 单档案 ⇒ 预约卡片不带档案名（不增加噪音）', async () => {
    const cloud = createReadCloud()
    seedAccount(cloud)
    seedCoach(cloud, coachIdA, 'ds-a', '张飞教练')
    seedStudent(cloud, coachIdA, 'ds-a', 'stu-m2', 'M2共享测试学员')
    seedPackage(cloud, coachIdA, 'ds-a', 'stu-m2', 'pkg-5', 4, 5, '2026-09-28')
    seedBookingRow(cloud, coachIdA, 'ds-a', 'stu-m2', 'bk-m2', '2026-10-06', 'pkg-5')
    seedClaimRow(cloud, coachIdA, 'stu-m2')
    const res = await cloud.call({ action: 'read', environment: ENV })
    const views = bookingView.splitBookings(allBookingRows(res), bookingView.packageNameIndex(res.packages), bookingView.archiveNameIndex(res.archives))
    assert.strictEqual(views.upcoming.length, 1)
    assert.strictEqual(views.upcoming[0].archiveText, '', '单档案不许在卡片上多一行档案名')
    assert.strictEqual(views.upcoming[0].hasArchive, false)
  })

  // ------------------------------------------------------------------ ⑧ 只下发档案名，内部字段一个都不出网
  await runner('archive-⑧ 学员手机 / 私人备注 / 教练 notes 绝不出网', async () => {
    const cloud = createReadCloud(); seedTwoArchives(cloud)
    const res = await cloud.call({ action: 'read', environment: ENV })
    const text = JSON.stringify(res)
    ;['13800000000', 'internalFlag', 'privateNote', 'secret', '绝不能出网'].forEach(word => {
      assert.ok(text.indexOf(word) < 0, `响应里出现了本该只留在服务端的内容：${word}`)
    })
    // ⭐ 2026-10-05：档案只暴露这**五个**字段（不透明 id + 名称 + 教练 + 剩余 + 课包数）。
    //    原先第 6、7 个字段 archived / archivedAt 属于教练端「已结束服务 / 已归档学员」功能，
    //    那个功能已整体撤回，服务端不再下发 ⇒ ⛔ 多一个字段就是隐私面变大一分。
    res.archives.forEach(row => assert.deepEqual(Object.keys(row).sort(), ['archiveId', 'coach', 'name', 'packageCount', 'remaining']))
  })

  // ------------------------------------------------------------------ ⑨ 不透明：studentId / claimId / packageId 不出网
  await runner('archive-⑨ archiveId 不透明，studentId / claimId / packageId 原文均不出网', async () => {
    const cloud = createReadCloud(); const { claimM2 } = seedTwoArchives(cloud)
    const res = await cloud.call({ action: 'read', environment: ENV })
    const text = JSON.stringify(res)
    ;['stu-m2', 'stu-seed', 'pkg-12', 'pkg-5', 'pkg-10', claimM2].forEach(word => {
      assert.ok(text.indexOf(word) < 0, `响应里泄露了内部标识：${word}`)
    })
    const m2 = byName(res.archives, 'M2共享测试学员')
    assert.strictEqual(m2.archiveId, archiveIdOf(claimM2), 'archiveId 必须是 claimId 的服务端派生值')
    assert.notStrictEqual(m2.archiveId, claimM2, 'archiveId 不许等于 claimId 原文')
  })

  // ------------------------------------------------------------------ ⑩ 去约课页（availability）同样带档案
  await runner('archive-⑩ availability 投影也下发 archives 与课包的 archiveId', async () => {
    const cloud = createReadCloud(); seedTwoArchives(cloud)
    const res = await cloud.call({ action: 'availability', date: '2026-10-05', environment: ENV })
    assert.strictEqual(res.availability, true)
    assert.strictEqual(res.archives.length, 2)
    // ⛔ 去约课页用的是这条投影 ⇒ 档案剩余必须同样正确（否则会员在选课时包时看到的是错的额度）
    assert.strictEqual(byName(res.archives, '假学员').remaining, 11)
    assert.strictEqual(byName(res.archives, 'M2共享测试学员').remaining, 13)
    assert.ok(res.packages.every(row => !!row.archiveId), '每份课包都要能看出属于哪份档案')
    assert.ok(res.bookings.every(row => !!row.archiveId), '每条预约都要能看出属于哪份档案')
    const usable = bookingView.usablePackages(res.packages, bookingView.archiveNameIndex(res.archives))
    const names = usable.map(row => row.archiveName).sort()
    assert.deepEqual(names, ['M2共享测试学员', 'M2共享测试学员', '假学员'], `可用课时包必须标出档案，实测：${JSON.stringify(names)}`)
  })

  // ------------------------------------------------------------------ ⑪ 老云端兼容：没有 archives 也不丢课包
  await runner('archive-⑪ archives 缺失（云端未部署）⇒ 退化成一组，一份课包都不丢', async () => {
    const groups = viewModel.packageGroups({ packages: [{ packageViewId: 'v1', remaining: 4 }, { packageViewId: 'v2', remaining: 9 }] })
    assert.strictEqual(groups.length, 1)
    assert.strictEqual(groups[0].grouped, false, '退化时界面必须与改造前逐字相同')
    assert.strictEqual(groups[0].packages.length, 2, '一份课包都不许丢')
    assert.strictEqual(groups[0].remaining, 13)
  })

  // ------------------------------------------------------------------ ⑫ 查询趟数不随课包数增长（性能不回归）
  await runner('archive-⑫ 读路径趟数不随课包数增长（无 per-package N+1）', async () => {
    const tripsFor = async count => {
      const cloud = createReadCloud()
      seedAccount(cloud)
      seedCoach(cloud, coachIdA, 'ds-a', '张飞教练')
      seedStudent(cloud, coachIdA, 'ds-a', 'stu-m2', 'M2共享测试学员')
      for (let index = 0; index < count; index += 1) seedPackage(cloud, coachIdA, 'ds-a', 'stu-m2', `pkg-${index}`, 4, 5, '2026-09-28')
      seedClaimRow(cloud, coachIdA, 'stu-m2')
      cloud.resetTrips()
      await cloud.call({ action: 'read', environment: ENV })
      return cloud.trips()
    }
    const two = await tripsFor(2), eight = await tripsFor(8)
    assert.strictEqual(two, eight, `课包从 2 涨到 8，数据库往返不许变多（实测 ${two} → ${eight}）`)
  })

  // ------------------------------------------------------------------ ⑬/⑭ 写路径：studentId / packageId 一个字节没变
  const world = createWorld()
  const CLAIMS_W = 'member_sandbox_student_claims'
  function setupWriteWorld() {
    world.reset()
    const A = world.seedCoach('open-a', 'ds-a', 'PUBA')
    const B = world.seedCoach('open-b', 'ds-b', 'PUBB')
    world.seedStudent(A, 'stu-a', '档案甲')
    world.seedStudent(B, 'stu-b', '档案乙')
    seedWorldPackage(A, 'stu-a', 'pkg-a', 10)
    seedWorldPackage(B, 'stu-b', 'pkg-b', 10)
    const claimA = world.fixedId ? null : null
    const idA = memberBooking.fixedId(CLAIMS_W, A.owner, 'stu-a')
    const idB = memberBooking.fixedId(CLAIMS_W, B.owner, 'stu-b')
    world.put(CLAIMS_W, idA, { claimId: idA, memberId: memberBooking.memberIdFor('open-m'), coachId: A.owner, studentId: 'stu-a', status: 'verified' })
    world.put(CLAIMS_W, idB, { claimId: idB, memberId: memberBooking.memberIdFor('open-m'), coachId: B.owner, studentId: 'stu-b', status: 'verified' })
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    return { A, B, idA, idB }
  }
  function seedWorldPackage(coach, studentId, packageId, total) {
    world.put('packages', world.businessId('packages', coach.owner, coach.datasetId, packageId), {
      ownerCoachId: coach.owner, datasetId: coach.datasetId, packageId, studentId,
      data: { id: packageId, type: '常规训练', total, remaining: total, used: 0, reserved: 0, reservedVersion: 2, price: 300, status: 'active', saleDate: '2026-09-01' }
    })
  }
  // ⛔ 假世界的时钟是 **1900000000000**（不是 Date.now()）⇒ 日期必须按它算，否则一律 BOOKING_DATE_IN_PAST（假红）。
  const CLOCK0 = 1900000000000
  const TODAY = memberBooking.beijingDateKey(CLOCK0)
  const occupancy = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/occupancy'))
  async function bookWith(coach, claimId, packageId) {
    world.setOpenId('open-m')
    return world.main()({
      action: 'memberBooking', command: 'createMemberBooking',
      requestId: `arch_${Math.random().toString(36).slice(2, 10)}`, environment: ENV,
      payload: {
        coachKey: memberBooking.fixedId('member-coach-view', coach.owner),
        packageViewId: memberBooking.fixedId('member-package-view', claimId, packageId),
        date: occupancy.addDateDays(TODAY, 3), hour: 10, minute: 0
      }
    })
  }

  await runner('archive-⑬ 两条 claim 各自预约 ⇒ 写到各自的 studentId / packageId（不合并）', async () => {
    const { A, B, idA, idB } = setupWriteWorld()
    const first = await bookWith(A, idA, 'pkg-a')
    assert.strictEqual((first.result || first).ok !== false, true, `第一笔预约应成功：${JSON.stringify(first)}`)
    const second = await bookWith(B, idB, 'pkg-b')
    assert.strictEqual((second.result || second).ok !== false, true, `第二笔预约应成功：${JSON.stringify(second)}`)
    const rowsA = world.dataRows('bookings', A.owner, A.datasetId)
    const rowsB = world.dataRows('bookings', B.owner, B.datasetId)
    assert.strictEqual(rowsA.length, 1)
    assert.strictEqual(rowsB.length, 1)
    assert.strictEqual(rowsA[0].studentId, 'stu-a', 'A 账里写的必须是档案甲')
    assert.strictEqual(rowsA[0].packageId, 'pkg-a')
    assert.strictEqual(rowsB[0].studentId, 'stu-b', 'B 账里写的必须是档案乙')
    assert.strictEqual(rowsB[0].packageId, 'pkg-b')
  })

  await runner('archive-⑭ 写路径反向再验：课包换到另一份档案 ⇒ studentId 随之改变', async () => {
    const { A, idA, idB } = setupWriteWorld()
    // ⛔ 故意跨档案搭配（A 教练 + 乙档案的课包）⇒ 未授权，必须被云端拒绝而不是静默写到别人档案上
    const crossed = await bookWith(A, idB, 'pkg-b')
    const code = String(crossed.code || (crossed.result && crossed.result.code) || '')
    assert.strictEqual(crossed.ok === true, false, '跨档案的无权搭配必须被拒绝')
    assert.ok(['PACKAGE_TEACHING_NOT_AUTHORIZED', 'MEMBER_SERVICE_NOT_AUTHORIZED', 'COACH_NOT_AVAILABLE'].indexOf(code) >= 0, `拒绝码必须明确，实测：${JSON.stringify(crossed)}`)
    assert.strictEqual(world.dataRows('bookings', A.owner, A.datasetId).length, 0, '被拒绝的请求一次写入都不许发生')
  })

  console.log('member archive projection tests: PASS (multi-claim grouping, opaque archiveId, privacy, no-write-change)')
}

run().catch(error => { console.error(error && error.stack || error); process.exitCode = 1 })

module.exports = { hash, coachIdOf }
