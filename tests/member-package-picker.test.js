// 会员约课页「课时包必须能选、且只能选这位教练真被授权的」· 永久回归（2026-10-01）
//
// ⛳ 真机阻断 Bug（本文件的 1:1 复刻）：
//   会员有 **3 份档案 / 3 个课时包** ⇒ 约课页列出了 3 个包，但：
//     · 列表**没有 bindtap**（点了没反应）；
//     · 确认框**写死** `packages[0]`（显示的永远是第一个档案的第一个包）；
//     · `buildRequest` **写死** `packages[0].packageViewId`（提交的永远是同一份包）。
//   ⇒ 会员"看得见却选不了"，且一不小心就把课约到了另一份档案上。
//
// 【本轮只改展示与只读投影】
//   ① 云函数下发每份课包的 `coachKeys`（哪些教练真能用它授课，与写路径同口径）；
//   ② 客户端 `packagesForCoach` 按当前教练筛；
//   ③ 页面把"选中的包"变成状态（`packageIndex`），提交恒读它。
//   ⛔ 不改预约 / 改期 / 取消 / 扣课时 / 授权的任何判定；⛔ 不动业务数据。
//
// 【单课包用户的保护】
//   只有一份可约课包 ⇒ `packagesSelectable=false` ⇒ 不出现"选它 / 已选 / 点一个再确认"，
//   界面与改造前逐字相同（段⑤）。

const assert = require('assert')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = require(path.join(ROOT, 'cloudfunctions/readMyMemberData/service'))
const { createService: readService, fixedId } = read
const memberBooking = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
const authorization = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/authorization'))
const bookingView = require(path.join(ROOT, 'utils/member-booking-view'))
const { createWorld, runner } = require('./helpers/m2-business-world')

const ENV = 'sandbox'
const MEMBER_OPEN = 'open-m'
const CLAIMS = 'member_sandbox_student_claims'
const ACCOUNTS = 'member_sandbox_accounts'
const PROFILES = 'member_sandbox_coach_profiles'
const HEADS = 'coach_sandbox_heads'
const GRANTS = 'coach_sandbox_package_grants'
const identity = require(path.join(ROOT, 'cloudfunctions/memberIdentityCommand/service'))
const memberId = memberBooking.memberIdFor(MEMBER_OPEN)
const coachIdA = identity.coachIdFor('open-a')
const coachIdB = identity.coachIdFor('open-b')
const coachIdC = identity.coachIdFor('open-c')
const coachKeyOf = coachId => memberBooking.fixedId('member-coach-view', coachId)

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
    data: { id: studentId, name, phone: '13800000000', privateNote: '教练私人备注' }
  })
}
function seedPackage(cloud, coachId, datasetId, studentId, packageId, remaining, total, type = '常规训练') {
  cloud.put('packages', fixedId('packages', coachId, datasetId, packageId), {
    ownerCoachId: coachId, datasetId, studentId, packageId,
    data: { id: packageId, type, total, used: total - remaining, remaining, reserved: 0, reservedVersion: 2, price: 300, status: 'active', saleDate: '2026-09-01' }
  })
}
// ⭐ 课包级授课授权（M2 双层授权的第二层）：A 的学员档案里，把 **pkg-a2 单独**授权给 C。
function seedGrant(cloud, ownerCoachId, datasetId, packageId, coachId, studentId, status = 'active') {
  cloud.put(GRANTS, authorization.packageGrantId({ ownerCoachId, datasetId }, packageId, coachId), {
    ownerCoachId, datasetId, packageId, coachId, studentId, status, canManage: false
  })
}
function seedClaimRow(cloud, coachId, studentId) {
  const claimId = fixedId(CLAIMS, coachId, studentId)
  cloud.put(CLAIMS, claimId, { claimId, memberId, coachId, studentId, status: 'verified' })
  return claimId
}

// ------------------------------------------------------------------ 真机 1:1：三位教练、三份档案、三份课包
//
//   A（张飞）· 档案甲 stu-a：pkg-a1（5 节剩 4）  —— A 自己可教
//   A（张飞）· 档案甲 stu-a：pkg-a2（10 节剩 9） —— 单独授权给 C ⇒ A 与 C 都能教
//   B（Sandbox）· 档案乙 stu-b：pkg-b1（12 节剩 11）—— 只有 B 能教
function seedThreeArchives(cloud) {
  seedAccount(cloud)
  seedCoach(cloud, coachIdA, 'ds-a', '张飞教练')
  seedCoach(cloud, coachIdB, 'ds-b', 'Sandbox 教练')
  seedCoach(cloud, coachIdC, 'ds-c', '李飞教练')
  seedStudent(cloud, coachIdA, 'ds-a', 'stu-a', '档案甲')
  seedStudent(cloud, coachIdB, 'ds-b', 'stu-b', '档案乙')
  seedPackage(cloud, coachIdA, 'ds-a', 'stu-a', 'pkg-a1', 4, 5, '常规训练')
  seedPackage(cloud, coachIdA, 'ds-a', 'stu-a', 'pkg-a2', 9, 10, '拉伸恢复')
  seedPackage(cloud, coachIdB, 'ds-b', 'stu-b', 'pkg-b1', 11, 12, '常规训练')
  // ⭐ 只把 pkg-a2 授权给 C ⇒ C 在约课页**只能**看到/选到 pkg-a2，绝不能碰 pkg-a1、pkg-b1
  seedGrant(cloud, coachIdA, 'ds-a', 'pkg-a2', coachIdC, 'stu-a')
  seedClaimRow(cloud, coachIdA, 'stu-a')
  seedClaimRow(cloud, coachIdB, 'stu-b')
}

const typeOf = (rows, packageViewId) => (rows.find(row => row.packageViewId === packageViewId) || {}).typeName

async function run() {
  // ------------------------------------------------------------------ ① 课包投影自带「哪些教练能教它」
  await runner('picker-① 每份课包都下发 coachKeys：账本所有者恒可用', async () => {
    const cloud = createReadCloud(); seedThreeArchives(cloud)
    const res = await cloud.call({ action: 'availability', date: '2026-10-05', environment: ENV })
    assert.strictEqual(res.availability, true)
    assert.strictEqual(res.packages.length, 3, '三份档案 / 三份课包')
    res.packages.forEach(row => {
      assert.ok(Array.isArray(row.coachKeys) && row.coachKeys.length >= 1, `课包必须带 coachKeys：${JSON.stringify(row)}`)
    })
    const a1 = res.packages.find(row => row.typeName === '常规训练' && row.saleDate !== undefined && row.coach.displayName === '张飞教练')
    assert.ok(a1, 'A 账里的课包必须在投影里')
    assert.ok(a1.coachKeys.indexOf(coachKeyOf(coachIdA)) >= 0, '账本所有者 A 恒可用自己的课包')
  })

  // ------------------------------------------------------------------ ② 被授权的第二位教练 ⇒ 出现在**那一份**课包上
  await runner('picker-② 课包级授权：C 只出现在 pkg-a2 的 coachKeys 里，pkg-a1 上没有', async () => {
    const cloud = createReadCloud(); seedThreeArchives(cloud)
    const res = await cloud.call({ action: 'availability', date: '2026-10-05', environment: ENV })
    const pkgA2 = res.packages.find(row => row.typeName === '拉伸恢复')
    const pkgA1 = res.packages.find(row => row.typeName === '常规训练' && row.coach.displayName === '张飞教练')
    const pkgB1 = res.packages.find(row => row.coach.displayName === 'Sandbox 教练')
    assert.ok(pkgA2 && pkgA1 && pkgB1, '三份课包都要在')
    assert.ok(pkgA2.coachKeys.indexOf(coachKeyOf(coachIdC)) >= 0, 'C 被授权教 pkg-a2 ⇒ 必须出现在它的 coachKeys 里')
    assert.strictEqual(pkgA1.coachKeys.indexOf(coachKeyOf(coachIdC)), -1, 'C 没被授权教 pkg-a1 ⇒ 绝不能出现')
    assert.strictEqual(pkgB1.coachKeys.indexOf(coachKeyOf(coachIdC)), -1, 'C 与 B 的账毫无关系 ⇒ 绝不能出现')
    assert.strictEqual(pkgB1.coachKeys.indexOf(coachKeyOf(coachIdA)), -1, 'A 也不能拿 B 账里的课包')
  })

  // ------------------------------------------------------------------ ③ 选第二位教练 ⇒ 只剩他真被授权的那些课包
  await runner('picker-③ 换到教练 C ⇒ 只剩 pkg-a2（一个都不多、一个都不少）', async () => {
    const cloud = createReadCloud(); seedThreeArchives(cloud)
    const res = await cloud.call({ action: 'availability', date: '2026-10-05', environment: ENV })
    const usable = bookingView.usablePackages(res.packages, bookingView.archiveNameIndex(res.archives))
    assert.strictEqual(usable.length, 3, '未选教练时三份都在（页面默认展示全部）')
    const forC = bookingView.packagesForCoach(usable, coachKeyOf(coachIdC))
    assert.strictEqual(forC.length, 1, `C 只能选到 1 份，实测 ${forC.length}：${forC.map(row => row.typeName).join('/')}`)
    assert.strictEqual(forC[0].typeName, '拉伸恢复')
    const forA = bookingView.packagesForCoach(usable, coachKeyOf(coachIdA))
    assert.strictEqual(forA.length, 2, 'A 是自己账的所有者 ⇒ 自己那两份都能用')
    const forB = bookingView.packagesForCoach(usable, coachKeyOf(coachIdB))
    assert.strictEqual(forB.length, 1, 'B 只能用自己账里那一份')
    assert.strictEqual(forB[0].typeName, '常规训练')
  })

  // ------------------------------------------------------------------ ④ 未授权的教练 ⇒ 一份课包都不剩（不许退回"全给"）
  await runner('picker-④ 教练没有任何授权 ⇒ 返回空（绝不退化成"把全部课包给他选"）', async () => {
    const cloud = createReadCloud(); seedThreeArchives(cloud)
    const res = await cloud.call({ action: 'availability', date: '2026-10-05', environment: ENV })
    const usable = bookingView.usablePackages(res.packages, bookingView.archiveNameIndex(res.archives))
    const outsider = memberBooking.fixedId('member-coach-view', identity.coachIdFor('open-z'))
    const rows = bookingView.packagesForCoach(usable, outsider)
    assert.strictEqual(rows.length, 0, '局外人一位课包都不许看到')
  })

  // ------------------------------------------------------------------ ⑤ 单课包用户：不加任何"选择"动作
  await runner('picker-⑤ 只有一份可约课包 ⇒ 原样返回、不增加选择负担', async () => {
    const cloud = createReadCloud()
    seedAccount(cloud)
    seedCoach(cloud, coachIdA, 'ds-a', '张飞教练')
    seedStudent(cloud, coachIdA, 'ds-a', 'stu-a', '档案甲')
    seedPackage(cloud, coachIdA, 'ds-a', 'stu-a', 'pkg-only', 4, 5)
    seedClaimRow(cloud, coachIdA, 'stu-a')
    const res = await cloud.call({ action: 'availability', date: '2026-10-05', environment: ENV })
    const usable = bookingView.usablePackages(res.packages, bookingView.archiveNameIndex(res.archives))
    assert.strictEqual(usable.length, 1, '单课包')
    assert.strictEqual(bookingView.packagesForCoach(usable, coachKeyOf(coachIdA)).length, 1, '单课包必须原样返回')
    // ⛔ 单课包 + 只有一份档案 ⇒ 一行档案名都不多显示（界面与改造前逐字相同）
    assert.deepEqual(bookingView.archiveNameIndex(res.archives), {})
    assert.strictEqual(usable[0].archiveName, '')
  })

  // ------------------------------------------------------------------ ⑥ 老云端兼容：没有 coachKeys ⇒ 一个都不筛
  await runner('picker-⑥ 老云端没下发 coachKeys ⇒ 一条都不筛（绝不把画面清空）', async () => {
    const legacy = [
      { packageViewId: 'v1', typeName: '常规训练', remaining: 4, availableToBook: 4 },
      { packageViewId: 'v2', typeName: '拉伸恢复', remaining: 9, availableToBook: 9 }
    ]
    const rows = bookingView.packagesForCoach(legacy, 'coach-any')
    assert.strictEqual(rows.length, 2, '老云端下发的两份课包一个都不许丢')
    // 部分下发 ⇒ 只按有标注的那些筛（不丢数据，也不放行没标注的）
    const mixed = [
      { packageViewId: 'v1', typeName: '常规训练', remaining: 4, availableToBook: 4, coachKeys: ['coach-a'] },
      { packageViewId: 'v2', typeName: '拉伸恢复', remaining: 9, availableToBook: 9 }
    ]
    assert.strictEqual(bookingView.packagesForCoach(mixed, 'coach-b').length, 0)
  })

  // ------------------------------------------------------------------ ⑦ 提交用的 packageViewId = 用户选中的那一份
  //
  // ⛔ 这一段盯的是**页面状态逻辑本身**（`currentPackage` 的取值规则），不依赖 wx：
  //     把页面的 `packageIndex` / `packages` 按真机形状摆出来，验证"取出来的是第二个、不是第一个"。
  await runner('picker-⑦ 选中第二份 ⇒ 取出来的是第二份（不是 packages[0]）', async () => {
    const cloud = createReadCloud(); seedThreeArchives(cloud)
    const res = await cloud.call({ action: 'availability', date: '2026-10-05', environment: ENV })
    const usable = bookingView.usablePackages(res.packages, bookingView.archiveNameIndex(res.archives))
    const forA = bookingView.packagesForCoach(usable, coachKeyOf(coachIdA))
    // ⛔ 直接调**页面用的那一个函数**（不是测试里另写一份等价实现 ⇒ 否则变异改页面函数也测不出来）
    assert.strictEqual(bookingView.selectedPackageOf(forA, 0), forA[0], '选第一份 ⇒ 取第一份')
    const second = bookingView.selectedPackageOf(forA, 1)
    assert.ok(second && second.packageViewId, '第二份必须取得到')
    assert.strictEqual(second, forA[1], '⛔ 选第二份时提交的不许还是第一份（写死 packages[0] 的 Bug 就在这里）')
    assert.ok(forA.some(row => row.packageViewId === second.packageViewId), '取出来的必须是名单里真实存在的那一份')
    // 越界 / 非法下标 ⇒ 退到第一个，绝不返回 undefined 让提交带着空 packageViewId 出去
    assert.strictEqual(bookingView.selectedPackageOf(forA, 99), forA[0])
    assert.strictEqual(bookingView.selectedPackageOf(forA, -3), forA[0])
    assert.strictEqual(bookingView.selectedPackageOf([], 0), null)
  })

  // ------------------------------------------------------------------ ⑧ 写路径交叉验证：C 用 pkg-a2 能约成功、用 pkg-a1 必须被拒
  const world = createWorld()
  const CLAIMS_W = 'member_sandbox_student_claims'
  const occupancy = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/occupancy'))
  const CLOCK0 = 1900000000000
  const TODAY = memberBooking.beijingDateKey(CLOCK0)
  function setupWriteWorld() {
    world.reset()
    const A = world.seedCoach('open-a', 'ds-a', 'PUBA')
    const C = world.seedCoach('open-c', 'ds-c', 'PUBC')
    world.seedStudent(A, 'stu-a', '档案甲')
    seedWorldPackage(A, 'stu-a', 'pkg-a1', 5)
    seedWorldPackage(A, 'stu-a', 'pkg-a2', 10)
    const claimId = memberBooking.fixedId(CLAIMS_W, A.owner, 'stu-a')
    world.put(CLAIMS_W, claimId, { claimId, memberId: memberBooking.memberIdFor('open-m'), coachId: A.owner, studentId: 'stu-a', status: 'verified' })
    // ⭐ 与教练端真实授予命令同形状：**课包级 + 会员级两条一起写**（前者派生后者），
    //   只写课包级 ⇒ 会员级那道闸会把请求拦掉（MEMBER_SERVICE_NOT_AUTHORIZED，假红）。
    world.put(GRANTS, authorization.packageGrantId({ ownerCoachId: A.owner, datasetId: A.datasetId }, 'pkg-a2', C.owner), {
      ownerCoachId: A.owner, datasetId: A.datasetId, packageId: 'pkg-a2', coachId: C.owner, studentId: 'stu-a', status: 'active', canManage: false, grantedByCoachId: A.owner
    })
    world.put('coach_sandbox_member_authorizations', authorization.memberAuthId({ ownerCoachId: A.owner, datasetId: A.datasetId }, 'stu-a', C.owner), {
      ownerCoachId: A.owner, datasetId: A.datasetId, studentId: 'stu-a', coachId: C.owner, status: 'active', source: authorization.SOURCE_PACKAGE_DERIVED, grantedByCoachId: A.owner
    })
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    return { A, C, claimId }
  }
  function seedWorldPackage(coach, studentId, packageId, total) {
    world.put('packages', world.businessId('packages', coach.owner, coach.datasetId, packageId), {
      ownerCoachId: coach.owner, datasetId: coach.datasetId, packageId, studentId,
      data: { id: packageId, type: total === 10 ? '拉伸恢复' : '常规训练', total, remaining: total, used: 0, reserved: 0, reservedVersion: 2, price: 300, status: 'active', saleDate: '2026-09-01' }
    })
  }
  async function bookBy(coach, claimId, packageId, tag) {
    world.setOpenId('open-m')
    return world.main()({
      action: 'memberBooking', command: 'createMemberBooking',
      requestId: `pick_${tag}_${Math.random().toString(36).slice(2, 8)}`, environment: ENV,
      payload: {
        coachKey: memberBooking.fixedId('member-coach-view', coach.owner),
        packageViewId: memberBooking.fixedId('member-package-view', claimId, packageId),
        date: occupancy.addDateDays(TODAY, 3), hour: 10, minute: 0
      }
    })
  }

  await runner('picker-⑧ 「界面只给 C 看 pkg-a2」与云端裁决一致：a2 成功、a1 被拒', async () => {
    const { A, C, claimId } = setupWriteWorld()
    const ok = await bookBy(C, claimId, 'pkg-a2', 'ok')
    assert.notStrictEqual((ok.result || ok).ok, false, `C 用被授权的 pkg-a2 应当成功：${JSON.stringify(ok)}`)
    const rows = world.dataRows('bookings', C.owner, C.datasetId)
    assert.strictEqual(rows.length, 1, '课落在授课教练 C 的账里')
    assert.strictEqual(rows[0].packageId, 'pkg-a2', '写进去的必须是会员选中的那一份')
    assert.strictEqual(rows[0].studentId, 'stu-a', '写在正确的档案上')

    const denied = await bookBy(C, claimId, 'pkg-a1', 'no')
    const code = String(denied.code || (denied.result && denied.result.code) || '')
    assert.strictEqual((denied.result || denied).ok === true, false, 'C 用未授权的 pkg-a1 必须被拒')
    assert.ok(['PACKAGE_TEACHING_NOT_AUTHORIZED', 'MEMBER_SERVICE_NOT_AUTHORIZED', 'COACH_NOT_AVAILABLE'].indexOf(code) >= 0, `拒绝码必须明确，实测 ${JSON.stringify(denied)}`)
    // ⛔ 界面已经不给他这份包了 ⇒ 云端拒绝时一次写入都不许发生
    assert.strictEqual(world.dataRows('bookings', C.owner, C.datasetId).length, 1, '被拒的请求不许留下第二笔预约')
  })

  // ------------------------------------------------------------------ ⑨ 隐私：教练/学员内部标识不出网
  await runner('picker-⑨ coachKeys 是不透明视图标识，coachId / packageId / studentId 不出网', async () => {
    const cloud = createReadCloud(); seedThreeArchives(cloud)
    const res = await cloud.call({ action: 'availability', date: '2026-10-05', environment: ENV })
    const text = JSON.stringify(res)
    ;[coachIdA, coachIdB, coachIdC, 'stu-a', 'stu-b', 'pkg-a1', 'pkg-a2', 'pkg-b1', '13800000000', 'privateNote'].forEach(word => {
      assert.ok(text.indexOf(word) < 0, `响应里泄露了内部标识：${word}`)
    })
    res.packages.forEach(row => {
      row.coachKeys.forEach(key => assert.ok(/^[0-9a-f]{32}$/.test(key), `coachKey 必须是定长哈希，实测：${key}`))
    })
  })

  // ------------------------------------------------------------------ ⑩ 性能：coachKeys 不新增一趟数据库往返
  await runner('picker-⑩ 下发 coachKeys 不新增数据库往返（授权那趟已存在，只复用）', async () => {
    const tripsFor = async grantCount => {
      const cloud = createReadCloud()
      seedAccount(cloud)
      seedCoach(cloud, coachIdA, 'ds-a', '张飞教练')
      seedCoach(cloud, coachIdC, 'ds-c', '李飞教练')
      seedStudent(cloud, coachIdA, 'ds-a', 'stu-a', '档案甲')
      seedPackage(cloud, coachIdA, 'ds-a', 'stu-a', 'pkg-a1', 4, 5)
      seedPackage(cloud, coachIdA, 'ds-a', 'stu-a', 'pkg-a2', 9, 10, '拉伸恢复')
      seedClaimRow(cloud, coachIdA, 'stu-a')
      for (let index = 0; index < grantCount; index += 1) {
        seedGrant(cloud, coachIdA, 'ds-a', index ? 'pkg-a1' : 'pkg-a2', coachIdC, 'stu-a')
      }
      cloud.resetTrips()
      await cloud.call({ action: 'availability', date: '2026-10-05', environment: ENV })
      return cloud.trips()
    }
    const one = await tripsFor(1), two = await tripsFor(2)
    assert.strictEqual(one, two, `授权行从 1 涨到 2，数据库往返不许变多（实测 ${one} → ${two}）`)
  })

  console.log('member package picker tests: PASS (selectable packages, per-coach authorization, submit uses the chosen one)')
}

run().catch(error => { console.error(error && error.stack || error); process.exitCode = 1 })
