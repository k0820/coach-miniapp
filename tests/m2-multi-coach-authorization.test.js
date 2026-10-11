// M2 V1 正式多教练服务模型永久回归（2026-09-28）。
//
// 这个文件盯的是**双层授权本身**：
//   · 会员只有一个可信身份（memberId 只从认领关系推导，绝不按姓名/手机号合并）；
//   · 会员级服务关系 + 课包级授课授权，**两层都成立**才能排课，且判定**只发生在云端可信身份下**；
//   · 授权不复制会员、不复制课时包、不产生第二套余额；
//   · 销售业绩归创建销售的教练，上课收入归 teachingCoachId，两者互不转移；
//   · 移除教练时若有未完成预约 —— **必须阻止**，绝不静默删除/取消/改派；
//   · 交接只转移管理权，历史销售与收入一个字节不动；
//   · 训练历史只暴露共享字段（私人备注 / 他人销售金额与收入一律不可见）。
//
// ⭐ 与 m2-member-lesson-facts 一样：跑**真实云端 handlers + 真实 core.execute**（假 DB 只替网络），
//    A / B / C / D 是真的四本账（不同 ownerCoachId、不同 datasetId、各自 revision 与收据）。
//    ⇒ 这里的"通过"是**代码与自动测试**通过，不是真机通过。

const assert = require('assert')
const { META, SANDBOX_META, coachIdFor, fixedId, createService } = require('../cloudfunctions/coachBusinessCommand/core')
const { handlers } = require('../cloudfunctions/coachBusinessCommand/handlers')
const occupancy = require('../cloudfunctions/coachBusinessCommand/occupancy')
const authorization = require('../cloudfunctions/coachBusinessCommand/authorization')

const copy = value => JSON.parse(JSON.stringify(value))
const names = [...new Set([
  ...Object.values(META), ...Object.values(SANDBOX_META),
  'students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises',
  // ⚠️ 这两个名字必须与会员端 memberIdentityCommand 的 names() 逐字一致（假件形状失真会让测试假绿）。
  'member_sandbox_coach_profiles', 'member_sandbox_student_claims', 'member_coach_profiles'
])]
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
const clear = () => { Object.values(stores).forEach(store => store.clear()); queue = Promise.resolve(); openId = 'openid-a' }
const businessId = (name, owner, datasetId, id) => fixedId(`coach-business-${name}`, owner, `${datasetId}:${id}`)
const rows = (name, owner, datasetId) => [...stores[name].values()].filter(row => row.ownerCoachId === owner && row.datasetId === datasetId)
const dataRows = (name, owner, datasetId) => rows(name, owner, datasetId).map(row => row.data || {})
const revisionOf = (owner, datasetId) => (rows(SANDBOX_META.revisions, owner, datasetId)[0] || {}).dataRevision

// 一位教练 = 一本账 + 一枚公开码（公开码是"我要授权给谁"的唯一可提交凭证）。
// ⚠️ Sandbox / Production 是**两套账、两张授权表**：P 用例要靠 seedCoachEnv 在正式区再种一份。
function seedCoachEnv(open, datasetId, publicCode, env) {
  const owner = coachIdFor(open)
  put('coaches', owner, { openId: open, status: 'active' })
  put(META.datasets, fixedId('coach-dataset', owner, datasetId), { ownerCoachId: owner, datasetId, status: 'active', integrityStatus: 'verified', checksum: 'ok', byteSize: 1, summary: {}, schemaVersion: 1 })
  if (env === 'sandbox') {
    put(SANDBOX_META.heads, fixedId('coach-sandbox-head', owner), { ownerCoachId: owner, environment: 'sandbox', activeDatasetId: datasetId, headVersion: 1 })
    put(SANDBOX_META.revisions, fixedId('coach-sandbox-revision', owner, datasetId), { ownerCoachId: owner, datasetId, dataRevision: 0 })
    if (publicCode) put('member_sandbox_coach_profiles', fixedId('coach-public', owner), { coachId: owner, publicCode, displayName: `教练${publicCode}`, discoverable: true })
  } else {
    put(META.heads, fixedId('coach-data-head', owner), { ownerCoachId: owner, activeDatasetId: datasetId, headVersion: 1 })
    put(META.revisions, fixedId('coach-data-revision', owner, datasetId), { ownerCoachId: owner, datasetId, dataRevision: 0 })
    if (publicCode) put('member_coach_profiles', fixedId('coach-public', owner), { coachId: owner, publicCode, displayName: `教练${publicCode}`, discoverable: true })
  }
  return { open, owner, datasetId, publicCode }
}
const seedCoach = (open, datasetId, publicCode) => seedCoachEnv(open, datasetId, publicCode, 'sandbox')
function seedPackage(coach, ids, { remaining = 12, total = 12, name = '小蓝' } = {}) {
  const { studentId, packageId, saleId } = ids
  put('students', businessId('students', coach.owner, coach.datasetId, studentId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, studentId,
    data: { id: studentId, name, phone: '13800138000', packages: [{ id: packageId }] }
  })
  put('packages', businessId('packages', coach.owner, coach.datasetId, packageId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, packageId, studentId, saleId,
    data: { id: packageId, studentId, type: '常规训练', total, remaining, used: total - remaining, price: 300, status: 'active', saleDate: '2026-09-01', saleId }
  })
  put('sales', businessId('sales', coach.owner, coach.datasetId, saleId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, saleId, studentId, packageId,
    data: { id: saleId, source: 'course', status: 'active', studentId, packageId, typeName: '常规训练', quantity: total, unitPrice: 300, amount: total * 300, date: '2026-09-01', note: `${name} · 常规训练` }
  })
  return ids
}
const main = () => createService({ db, getOpenId: () => openId, handlers, now: () => ++clock })
async function raw(open, command, requestId, expectedRevision, payload) {
  openId = open
  return main()({ action: 'execute', environment: 'sandbox', envelope: { command, requestId, expectedRevision, payload } })
}
const revOf = coach => revisionOf(coach.owner, coach.datasetId)
const cmd = (coach, command, requestId, payload) => raw(coach.open, command, requestId, revOf(coach), payload)
const pkgOf = (coach, packageId) => dataRows('packages', coach.owner, coach.datasetId).find(item => item.id === packageId)
const occOf = (coach, packageId) => occupancy.occupancyOf(pkgOf(coach, packageId))
const incomesOf = coach => dataRows('incomes', coach.owner, coach.datasetId)
const salesOf = coach => dataRows('sales', coach.owner, coach.datasetId)
const grantRows = () => [...stores[SANDBOX_META.packageGrants].values()].map(row => row.data || row)
const memberRows = () => [...stores[SANDBOX_META.memberAuthorizations].values()].map(row => row.data || row)
const ITEMS = [{ name: '卧推', group: '胸', sets: 4, reps: 12, weight: 40 }]

async function test(name, fn) {
  try { clear(); await fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}
async function completeBookingOf(coach, bookingId, tag) {
  const content = await cmd(coach, 'updateBookingContent', `m2v_${tag}_content`, { bookingId, items: ITEMS, category: '综合训练', duration: 60 })
  assert.equal(content.ok, true, `训练内容保存失败 ${JSON.stringify(content)}`)
  return cmd(coach, 'completeBooking', `m2v_${tag}_done`, { bookingId })
}

;(async () => {
  // ———————————————————————————————————————————————— 0：真服务端形状契约（写错集合名在假 DB 里照样全绿）
  await test('0：授权模块复用的会员端集合名必须与 memberIdentityCommand 逐字一致', async () => {
    // ⭐ 这一条专治"假件形状失真"：教练公开码表 / 认领表是 **M1 已存在的集合**，
    //    授权模块只读它们。名字写错 ⇒ 假 DB 里自己建一张照样全绿，真机上却永远查不到教练。
    const memberNames = require('../cloudfunctions/memberIdentityCommand/service').names
    for (const environment of ['production', 'sandbox']) {
      const real = memberNames(environment), mine = authorization.collectionsFor(environment)
      assert.equal(mine.profiles, real.profiles, `${environment} 教练公开码表名必须一致（真=${real.profiles} 我=${mine.profiles}）`)
      assert.equal(mine.claims, real.claims, `${environment} 认领表名必须一致（真=${real.claims} 我=${mine.claims}）`)
    }
  })

  // ———————————————————————————————————————————————— A
  await test('A：一个会员 / 多位授权教练 —— 不复制会员、不复制课时包、不产生第二套余额', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB'), C = seedCoach('openid-c', 'ds-c', 'PUBCODEC')
    const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' })
    const granted = await cmd(A, 'grantPackageTeaching', 'm2v_a_grant', { packageId: ids.packageId, publicCodes: [B.publicCode, C.publicCode] })
    assert.equal(granted.ok, true, JSON.stringify(granted))
    // 授权只是关系：B / C 两本账里**一条**学员、课时包、销售都不许出现。
    ;[B, C].forEach(coach => {
      assert.equal(rows('students', coach.owner, coach.datasetId).length, 0, `${coach.publicCode} 账里不许出现复制的学员`)
      assert.equal(rows('packages', coach.owner, coach.datasetId).length, 0, `${coach.publicCode} 账里不许出现复制的课时包`)
      assert.equal(rows('sales', coach.owner, coach.datasetId).length, 0, `${coach.publicCode} 账里不许出现复制的销售`)
    })
    // ⭐ A 是账本所有者 ⇒ **隐式**拥有全部权限，**不需要**授权行（这就是"旧数据零迁移"的支点）。
    assert.equal(grantRows().filter(row => row.coachId === A.owner).length, 0, '所有者不需要授权行')
    assert.equal(grantRows().filter(row => row.status === 'active').length, 2, '只写 B / C 两条课包授权（A 走隐式权限）')
    assert.equal(memberRows().filter(row => row.status === 'active').length, 2, 'B / C 各一条会员级关系（A 是所有者，不需要授权行）')
    // 三位教练各上一节：用的是**同一份** remaining / reserved / used。
    const at = (coach, hour) => cmd(coach, 'createAuthorizedBooking', `m2v_a_book_${coach.publicCode}`, { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour, minute: 0 })
    const bookA = await at(A, 10), bookB = await at(B, 11), bookC = await at(C, 12)
    ;[bookA, bookB, bookC].forEach((result, index) => assert.equal(result.ok, true, `第 ${index + 1} 位教练排课失败 ${JSON.stringify(result)}`))
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 12, reserved: 3, availableToBook: 9 }, '三节都占在这**同一份**课时上')
    assert.equal(pkgOf(A, ids.packageId).used, 0, '预约不扣课时')
  })

  // ———————————————————————————————————————————————— B
  await test('B：同名同号但不同可信档案 —— 绝不自动合并（只认 studentId，不认姓名/手机号）', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB')
    // 两本账里各有一条「小蓝 / 13800138000」—— 这是两条独立档案（不同的 studentId）。
    const idsA = seedPackage(A, { studentId: 'stu-a-1', packageId: 'pkg-a-1', saleId: 'sale-a-1' }, { name: '小蓝' })
    const idsB = seedPackage(B, { studentId: 'stu-b-1', packageId: 'pkg-b-1', saleId: 'sale-b-1' }, { name: '小蓝' })
    const granted = await cmd(A, 'grantPackageTeaching', 'm2v_b_grant', { packageId: idsA.packageId, publicCodes: [B.publicCode] })
    assert.equal(granted.ok, true, JSON.stringify(granted))
    const booked = await cmd(B, 'createAuthorizedBooking', 'm2v_b_book', { studentId: idsA.studentId, packageId: idsA.packageId, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(booked.ok, true, JSON.stringify(booked))
    // ⭐ 扣的必须是 A 那一份（被授权的那一份），B 自己那份「小蓝」的课包**一格都不许动**。
    assert.deepStrictEqual(occOf(A, idsA.packageId), { remaining: 12, reserved: 1, availableToBook: 11 })
    assert.deepStrictEqual(occOf(B, idsB.packageId), { remaining: 12, reserved: 0, availableToBook: 12 }, '同名的另一份课时包必须纹丝不动')
    assert.equal(rows('students', A.owner, A.datasetId).length, 1)
    assert.equal(rows('students', B.owner, B.datasetId).length, 1)
    // 认领只指向精确的那一条：A 的档案认领后，B 那份档案不会被"顺手"认成同一个会员。
    put('member_sandbox_student_claims', fixedId('claim', A.owner, idsA.studentId), { coachId: A.owner, studentId: idsA.studentId, memberId: 'member-1', status: 'verified' })
    const again = await cmd(A, 'grantPackageTeaching', 'm2v_b_grant2', { packageId: idsA.packageId, publicCodes: [B.publicCode] })
    assert.equal(again.ok, true, JSON.stringify(again))
    const memberRow = memberRows().find(row => row.coachId === B.owner)
    assert.equal(memberRow.memberId, 'member-1', 'memberId 只从**这条档案**的认领关系推导')
    assert.equal(memberRows().filter(row => row.studentId === idsB.studentId).length, 0, '另一条同名档案不得被牵连')
  })

  // ———————————————————————————————————————————————— C
  await test('C：会员级有权、课包级无权 —— 不能排课（报 PACKAGE_TEACHING_NOT_AUTHORIZED）', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB')
    const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' })
    const memberOnly = await cmd(A, 'grantMemberService', 'm2v_c_member', { studentId: ids.studentId, publicCodes: [B.publicCode] })
    assert.equal(memberOnly.ok, true, JSON.stringify(memberOnly))
    const denied = await cmd(B, 'createAuthorizedBooking', 'm2v_c_deny', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(denied.ok, false, '只有会员级关系不能排课')
    assert.equal(denied.code, 'PACKAGE_TEACHING_NOT_AUTHORIZED', `必须是课包级授权缺失（实测 ${denied.code}）`)
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 12, reserved: 0, availableToBook: 12 }, '被拒绝的排课不许留下任何占座')
    // ⭐ 直接盯**闸本身**（不经过 resolveBookingPlace）：课包层缺 ⇒ 必须报课包层的码。
    //   注：命令链路里课包层会被 resolveBookingPlace 先拦一道 ⇒ 不单独盯闸的话，"把课包层删掉"也能全绿。
    const auths = authorization.authScope(db, 'sandbox'), place = { ownerCoachId: A.owner, datasetId: A.datasetId }
    await assert.rejects(
      () => authorization.assertMayBook(auths, place, ids.studentId, ids.packageId, B.owner),
      error => error.commandCode === 'PACKAGE_TEACHING_NOT_AUTHORIZED'
    )
  })

  // ———————————————————————————————————————————————— D
  await test('D：课包级有权、会员级缺失 —— 同样不能排课（两层缺一不可，不许绕过）', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB')
    const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' })
    const granted = await cmd(A, 'grantPackageTeaching', 'm2v_d_grant', { packageId: ids.packageId, publicCodes: [B.publicCode] })
    assert.equal(granted.ok, true, JSON.stringify(granted))
    // 造一个"课包级在、会员级被撤"的不一致状态（现实中可能来自人工改数据 / 旧版本遗留）。
    const memberRow = memberRows().find(row => row.coachId === B.owner)
    put(SANDBOX_META.memberAuthorizations, authorization.memberAuthId({ ownerCoachId: A.owner, datasetId: A.datasetId }, ids.studentId, B.owner), { ...memberRow, status: 'revoked' })
    const denied = await cmd(B, 'createAuthorizedBooking', 'm2v_d_deny', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(denied.ok, false, '会员级关系缺失 ⇒ 课包级授权不能单独放行')
    assert.equal(denied.code, 'MEMBER_SERVICE_NOT_AUTHORIZED', `必须是会员级缺失（实测 ${denied.code}）`)
    // ⭐ 同样直接盯闸：课包层在、会员层撤 ⇒ 报会员层的码（两个码不许合成一个"没权限"）。
    const auths = authorization.authScope(db, 'sandbox'), place = { ownerCoachId: A.owner, datasetId: A.datasetId }
    await assert.rejects(
      () => authorization.assertMayBook(auths, place, ids.studentId, ids.packageId, B.owner),
      error => error.commandCode === 'MEMBER_SERVICE_NOT_AUTHORIZED'
    )
    // 所有者是**隐式**权限 ⇒ 闸必须放行（不抛错），这条是"旧数据零迁移"的支点。
    await authorization.assertMayBook(auths, place, ids.studentId, ids.packageId, A.owner)
  })

  // ———————————————————————————————————————————————— E / R
  await test('E/R：教练名单是动态的 —— 第 3、第 4 位教练同样可用，不存在 A/B/C/D 写死上限', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA')
    const others = ['c', 'd', 'e', 'f'].map((suffix, index) => seedCoach(`openid-${suffix}`, `ds-${suffix}`, `PUBCODE${suffix.toUpperCase()}${index}`))
    const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' }, { remaining: 10 })
    const granted = await cmd(A, 'grantPackageTeaching', 'm2v_e_grant', { packageId: ids.packageId, publicCodes: others.map(coach => coach.publicCode) })
    assert.equal(granted.ok, true, JSON.stringify(granted))
    assert.equal(grantRows().filter(row => row.status === 'active' && row.coachId !== A.owner).length, 4, '四位教练都要在名单里')
    for (let index = 0; index < others.length; index += 1) {
      const result = await cmd(others[index], 'createAuthorizedBooking', `m2v_e_book_${index}`, { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10 + index, minute: 0 })
      assert.equal(result.ok, true, `第 ${index + 3} 位教练排课失败 ${JSON.stringify(result)}`)
    }
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 10, reserved: 4, availableToBook: 6 })
  })

  // ———————————————————————————————————————————————— F
  await test('F：同一会员的两份课包 —— 授权名单各自独立（给了 pkg-1 不等于给了 pkg-2）', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB'), C = seedCoach('openid-c', 'ds-c', 'PUBCODEC')
    const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' })
    const second = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-2', saleId: 'sale-2' })
    await cmd(A, 'grantPackageTeaching', 'm2v_f_grant1', { packageId: ids.packageId, publicCodes: [B.publicCode] })
    await cmd(A, 'grantPackageTeaching', 'm2v_f_grant2', { packageId: second.packageId, publicCodes: [C.publicCode] })
    const bOn1 = await cmd(B, 'createAuthorizedBooking', 'm2v_f_b1', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10, minute: 0 })
    const bOn2 = await cmd(B, 'createAuthorizedBooking', 'm2v_f_b2', { studentId: ids.studentId, packageId: second.packageId, date: '2026-10-02', hour: 11, minute: 0 })
    const cOn2 = await cmd(C, 'createAuthorizedBooking', 'm2v_f_c2', { studentId: ids.studentId, packageId: second.packageId, date: '2026-10-02', hour: 12, minute: 0 })
    const cOn1 = await cmd(C, 'createAuthorizedBooking', 'm2v_f_c1', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 13, minute: 0 })
    assert.equal(bOn1.ok, true, JSON.stringify(bOn1)); assert.equal(cOn2.ok, true, JSON.stringify(cOn2))
    assert.equal(bOn2.code, 'PACKAGE_TEACHING_NOT_AUTHORIZED', `B 不能越过名单用 pkg-2（实测 ${bOn2.code}）`)
    assert.equal(cOn1.code, 'PACKAGE_TEACHING_NOT_AUTHORIZED', `C 不能越过名单用 pkg-1（实测 ${cOn1.code}）`)
    // ⭐ 课程类型**不作**判据：两份都是「常规训练」，名单照样互不相通。
    assert.equal(pkgOf(A, ids.packageId).type, pkgOf(A, second.packageId).type)
  })

  // ———————————————————————————————————————————————— G
  await test('G：A 销售、B 授课 —— 销售业绩留在 A，上课收入归 B（互不转移）', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB')
    const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' })
    const beforeAmount = salesOf(A)[0].amount
    await cmd(A, 'grantPackageTeaching', 'm2v_g_grant', { packageId: ids.packageId, publicCodes: [B.publicCode] })
    const booked = await cmd(B, 'createAuthorizedBooking', 'm2v_g_book', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(booked.ok, true, JSON.stringify(booked))
    const done = await completeBookingOf(B, booked.result.bookingId, 'g')
    assert.equal(done.ok, true, JSON.stringify(done))
    // 课时：只有一份，扣在 A 那本账的课时包上。
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 11, reserved: 0, availableToBook: 11 })
    assert.equal(pkgOf(A, ids.packageId).used, 1)
    // 收入：写在**授课教练 B** 那本账里；A 一分钱收入都没有（销售 ≠ 授课）。
    assert.equal(incomesOf(B).length, 1, 'B 拿到这一节的上课收入')
    assert.equal(incomesOf(A).length, 0, 'A 没有上课收入')
    assert.equal(incomesOf(B)[0].amount, 300)
    // 销售业绩：还在 A 这本账里，金额没变，也没有跑到 B 那里。
    assert.equal(salesOf(A)[0].amount, beforeAmount, 'A 的销售业绩金额不变')
    assert.equal(salesOf(B).length, 0, '被加入授课名单 ≠ 获得销售业绩')
    // ⭐ 销售归属：销售额仍记在 A 账本 ⇒ A 的销售业绩（actual sale owner）没有被改写成 B。
    assert.equal(rows('sales', A.owner, A.datasetId)[0].ownerCoachId, A.owner)
  })

  // ———————————————————————————————————————————————— H
  await test('H：续费 —— 新销售记在创建它的那本账里，A 的历史销售一笔不动（跨账本续费见文档"未完成"）', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB')
    const idsA = seedPackage(A, { studentId: 'stu-a-1', packageId: 'pkg-a-1', saleId: 'sale-a-1' })
    const idsB = seedPackage(B, { studentId: 'stu-b-1', packageId: 'pkg-b-1', saleId: 'sale-b-1' }, { remaining: 2, total: 2 })
    const oldAmountA = salesOf(A)[0].amount
    const packagesBeforeA = rows('packages', A.owner, A.datasetId).length
    // V1 的形状：销售记录物理落在**创建它的那本账**里 ⇒ 谁创建就记在谁那儿（这就是"销售归属"的落点）。
    const renewed = await cmd(B, 'createCourseSale', 'm2v_h_renew', { studentId: idsB.studentId, type: '常规训练', total: 6, remaining: 6, quantity: 6, unitPrice: 300, amount: 1800, date: '2026-10-01' })
    assert.equal(renewed.ok, true, JSON.stringify(renewed))
    assert.equal(salesOf(B).length, 2, 'B 办的新销售记在 B 这本账（旧的一笔 + 续费一笔）')
    assert.ok(salesOf(B).some(sale => sale.amount === 1800), '续费金额记在 B')
    // A 的历史销售：笔数、金额、owner 一个字节都不许变。
    assert.equal(salesOf(A).length, 1)
    assert.equal(salesOf(A)[0].amount, oldAmountA, '旧销售金额不变')
    assert.equal(rows('sales', A.owner, A.datasetId)[0].ownerCoachId, A.owner, '旧销售仍归 A')
    // ⛔ V1 不做「B 在 A 的账本里续费」—— 那等于把 B 的业绩写进 A 的账本，与本条规则冲突。
    //    留作后续独立需求；V1 的落点很明确：拿 A 的 studentId 去建销售 ⇒ 查无此人，直接拒绝。
    const cross = await cmd(B, 'createCourseSale', 'm2v_h_cross', { studentId: idsA.studentId, type: '常规训练', total: 6, remaining: 6, quantity: 6, unitPrice: 300, amount: 1800, date: '2026-10-01' })
    assert.equal(cross.ok, false, 'V1 不允许跨账本续费')
    assert.equal(cross.code, 'STUDENT_NOT_FOUND', `跨账本续费必须被拒（实测 ${cross.code}）`)
    assert.equal(rows('packages', A.owner, A.datasetId).length, packagesBeforeA, 'V1 不在对端账本里凭空新增课时包')
    assert.equal(salesOf(A).length, 1, '被拒的跨账本续费不许在 A 账里留下任何东西')
  })

  // ———————————————————————————————————————————————— I
  await test('I：最后一节 —— A/B 并发抢，只有一个成功，真实课时绝不变负', async () => {
    for (const [label, aFirst] of [['A 先', true], ['B 先', false]]) {
      clear()
      const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB')
      const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' }, { remaining: 1, total: 12 })
      await cmd(A, 'grantPackageTeaching', `m2v_i_${aFirst ? 1 : 2}_grant`, { packageId: ids.packageId, publicCodes: [B.publicCode] })
      const byA = () => cmd(A, 'createAuthorizedBooking', `m2v_i_${aFirst ? 1 : 2}_a`, { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10, minute: 0 })
      const byB = () => cmd(B, 'createAuthorizedBooking', `m2v_i_${aFirst ? 1 : 2}_b`, { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 11, minute: 0 })
      const first = aFirst ? await byA() : await byB()
      const second = aFirst ? await byB() : await byA()
      assert.equal(first.ok, true, `${label}：第一个必须成功 ${JSON.stringify(first)}`)
      assert.equal(second.ok, false, `${label}：第二个必须被挡`)
      assert.equal(second.code, 'PACKAGE_NO_AVAILABLE', `${label}：挡住它的必须是"可约课时为 0"（实测 ${second.code}）`)
      assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 1, reserved: 1, availableToBook: 0 })
      assert.ok(occOf(A, ids.packageId).remaining >= 0 && occOf(A, ids.packageId).reserved >= 0, '真实课时绝不变负')
    }
  })

  // ———————————————————————————————————————————————— J
  await test('J：会员时间冲突与教练时间冲突 —— 两种冲突分别报各自的码', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB')
    const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' })
    await cmd(A, 'grantPackageTeaching', 'm2v_j_grant', { packageId: ids.packageId, publicCodes: [B.publicCode] })
    const byA = await cmd(A, 'createAuthorizedBooking', 'm2v_j_a_first', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 14, minute: 0 })
    assert.equal(byA.ok, true, JSON.stringify(byA))
    // ① 会员时间：B 自己的 14:00 是空的，但会员已经有课 ⇒ 必须是 MEMBER_TIME_CONFLICT。
    const memberClash = await cmd(B, 'createAuthorizedBooking', 'm2v_j_member', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 14, minute: 0 })
    assert.equal(memberClash.code, 'MEMBER_TIME_CONFLICT', `必须是会员时间冲突（实测 ${memberClash.code}）`)
    // ② 教练时间：B 自己 15:00 已给别的会员排课 ⇒ BOOKING_TIME_CONFLICT。
    const other = seedPackage(B, { studentId: 'stu-b-9', packageId: 'pkg-b-9', saleId: 'sale-b-9' })
    const byBOwn = await cmd(B, 'createBooking', 'm2v_j_b_own', { studentId: other.studentId, packageId: other.packageId, date: '2026-10-02', hour: 15, minute: 0 })
    assert.equal(byBOwn.ok, true, JSON.stringify(byBOwn))
    const coachClash = await cmd(B, 'createAuthorizedBooking', 'm2v_j_coach', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 15, minute: 0 })
    assert.equal(coachClash.code, 'BOOKING_TIME_CONFLICT', `必须是教练时间冲突（实测 ${coachClash.code}）`)
  })

  // ———————————————————————————————————————————————— K
  await test('K：取消 / 完成 / 重复完成 —— reserved 口径不变，重复完成被硬闸挡住', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB')
    const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' })
    await cmd(A, 'grantPackageTeaching', 'm2v_k_grant', { packageId: ids.packageId, publicCodes: [B.publicCode] })
    const booked = await cmd(B, 'createAuthorizedBooking', 'm2v_k_book', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10, minute: 0 })
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 12, reserved: 1, availableToBook: 11 }, '预约即占座')
    const cancelled = await cmd(B, 'cancelBooking', 'm2v_k_cancel', { bookingId: booked.result.bookingId })
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 12, reserved: 0, availableToBook: 12 }, '取消只释放占座，remaining / used 不动')
    const booked2 = await cmd(B, 'createAuthorizedBooking', 'm2v_k_book2', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10, minute: 0 })
    const done = await completeBookingOf(B, booked2.result.bookingId, 'k')
    assert.equal(done.ok, true, JSON.stringify(done))
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 11, reserved: 0, availableToBook: 11 }, '完课：remaining −1 / used +1 / reserved −1')
    const again = await cmd(B, 'completeBooking', 'm2v_k_again', { bookingId: booked2.result.bookingId })
    assert.equal(again.ok, false, '重复完成必须被挡')
    assert.equal(again.code, 'BOOKING_ALREADY_DONE', `重复完成的码必须是 BOOKING_ALREADY_DONE（实测 ${again.code}）`)
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 11, reserved: 0, availableToBook: 11 }, '重复完成不许再扣一次')
    assert.equal(incomesOf(B).length, 1, '收入恰好一笔')
  })

  // ———————————————————————————————————————————————— L
  await test('L：移除授课教练时还有未来预约 —— 必须阻止，绝不静默删除/取消/改派', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB')
    const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' })
    await cmd(A, 'grantPackageTeaching', 'm2v_l_grant', { packageId: ids.packageId, publicCodes: [B.publicCode] })
    const booked = await cmd(B, 'createAuthorizedBooking', 'm2v_l_book', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(booked.ok, true, JSON.stringify(booked))
    const revoked = await cmd(A, 'revokePackageTeaching', 'm2v_l_revoke', { packageId: ids.packageId, publicCode: B.publicCode })
    assert.equal(revoked.ok, false, '有未完成预约 ⇒ 不许移除')
    assert.equal(revoked.code, 'COACH_HAS_FUTURE_BOOKINGS', `必须是"还有未来预约"（实测 ${revoked.code}）`)
    // 注：命令失败返回里 extra 是**平铺**的（fail(code, message, ...extra)）。
    assert.equal(revoked.futureBookings.length, 1, '必须把冲突的预约如实报出来')
    assert.equal(revoked.futureBookings[0].bookingId, booked.result.bookingId, '报出来的必须是那条真实的未完成预约')
    // ⛔ 被拒绝之后：授权仍在、预约仍在、占座一格没动。
    assert.equal(grantRows().find(row => row.coachId === B.owner).status, 'active', '授权不许被静默撤掉')
    assert.equal(dataRows('bookings', B.owner, B.datasetId).length, 1, '预约不许被静默取消')
    assert.equal(dataRows('bookings', B.owner, B.datasetId)[0].teachingCoachId, B.owner, 'teachingCoachId 不许被改派')
    assert.deepStrictEqual(occOf(A, ids.packageId), { remaining: 12, reserved: 1, availableToBook: 11 }, 'reserved 不许被静默释放')
    // 预约处理完之后就可以正常移除。
    await cmd(B, 'cancelBooking', 'm2v_l_cancel', { bookingId: booked.result.bookingId })
    const revokedNow = await cmd(A, 'revokePackageTeaching', 'm2v_l_revoke2', { packageId: ids.packageId, publicCode: B.publicCode })
    assert.equal(revokedNow.ok, true, JSON.stringify(revokedNow))
    assert.equal(grantRows().find(row => row.coachId === B.owner).status, 'revoked')
    // 派生出来的会员级关系随之收掉（它不是显式授予的）；B 也不能再排课。
    assert.equal(memberRows().find(row => row.coachId === B.owner).status, 'revoked')
    const denied = await cmd(B, 'createAuthorizedBooking', 'm2v_l_deny', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-03', hour: 10, minute: 0 })
    assert.equal(denied.code, 'PACKAGE_TEACHING_NOT_AUTHORIZED', '取消授权后不许再建新预约')
  })

  // ———————————————————————————————————————————————— M
  await test('M：指定接管人 —— 只转移管理权，历史销售与收入一个字节不动', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB'), C = seedCoach('openid-c', 'ds-c', 'PUBCODEC')
    const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' })
    await cmd(A, 'grantPackageTeaching', 'm2v_m_grant', { packageId: ids.packageId, publicCodes: [B.publicCode, C.publicCode] })
    const saleBefore = JSON.stringify(salesOf(A))
    const incomeBefore = JSON.stringify(incomesOf(A))
    const grantOf = coach => grantRows().find(row => row.coachId === coach.owner)
    // 交接前：B / C 都不是管理人 ⇒ 不能改名单。
    const denied = await cmd(C, 'grantPackageTeaching', 'm2v_m_deny', { packageId: ids.packageId, publicCodes: [B.publicCode] })
    assert.equal(denied.code, 'PACKAGE_MANAGE_NOT_AUTHORIZED', `非管理人不能改名单（实测 ${denied.code}）`)
    // ① A（所有者）把管理权交给 B。
    const first = await cmd(A, 'transferPackageManagement', 'm2v_m_transfer1', { packageId: ids.packageId, publicCode: B.publicCode })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(grantOf(B).canManage, true, 'B 成为管理人')
    // ② B（非所有者）把管理权交给 C ⇒ B 自己交出（所有者的隐式权限是交不掉的：那本账本来就归他）。
    const second = await cmd(B, 'transferPackageManagement', 'm2v_m_transfer2', { packageId: ids.packageId, publicCode: C.publicCode })
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.equal(grantOf(C).canManage, true, 'C 成为管理人')
    assert.equal(grantOf(B).canManage, false, 'B 交出管理权')
    assert.equal(grantOf(B).status, 'active', '交出管理权 ≠ 失去授课权（B 仍能上课）')
    // 接管人现在可以改名单；历史事实一个字节不动。
    const added = await cmd(C, 'grantPackageTeaching', 'm2v_m_add', { packageId: ids.packageId, publicCodes: [B.publicCode] })
    assert.equal(added.ok, true, JSON.stringify(added))
    assert.equal(JSON.stringify(salesOf(A)), saleBefore, '历史销售业绩一个字节都不许变')
    assert.equal(JSON.stringify(incomesOf(A)), incomeBefore, '历史收入一个字节都不许变')
    assert.equal(rows('sales', A.owner, A.datasetId)[0].ownerCoachId, A.owner, '销售归属不随交接转移')
    // ⭐ 所有者是"隐式管理人"：即使把 flag 交给了别人，A 仍然能改（他 owning 这本账，夺不掉也不必夺）。
    const byOwner = await cmd(A, 'grantPackageTeaching', 'm2v_m_owner', { packageId: ids.packageId, publicCodes: [B.publicCode] })
    assert.equal(byOwner.ok, true, '所有者的隐式管理权不随交接消失')
    // 不存在"凭空接管"：① 陌生公开码 ② 没有授课授权的人 —— 一律拒绝。
    const stranger = await cmd(C, 'transferPackageManagement', 'm2v_m_stranger', { packageId: ids.packageId, publicCode: 'PUBCODEZZZ' })
    assert.equal(stranger.code, 'COACH_PUBLIC_CODE_NOT_FOUND', `陌生公开码必须被拒（实测 ${stranger.code}）`)
    const D = seedCoach('openid-d', 'ds-d', 'PUBCODED')
    const outsider = await cmd(C, 'transferPackageManagement', 'm2v_m_outsider', { packageId: ids.packageId, publicCode: D.publicCode })
    assert.equal(outsider.code, 'GRANT_TARGET_NOT_TEACHING_COACH', `没有授课授权的人不能被指定为接管人（实测 ${outsider.code}）`)
    assert.equal(grantRows().filter(row => row.coachId === D.owner).length, 0, '被拒的接管不许留下任何授权行')
  })

  // ———————————————————————————————————————————————— N / O
  await test('N/O：授权目录只投影共享字段 —— 私人备注、他人销售金额与收入一律不可见；训练动作可见', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB')
    const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' })
    await cmd(A, 'grantPackageTeaching', 'm2v_n_grant', { packageId: ids.packageId, publicCodes: [B.publicCode] })
    const booked = await cmd(B, 'createAuthorizedBooking', 'm2v_n_book', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10, minute: 0 })
    const withNotes = await cmd(B, 'updateBookingContent', 'm2v_n_content', { bookingId: booked.result.bookingId, items: ITEMS, notes: '教练的私人备注：这个会员腰不好', category: '综合训练', duration: 60 })
    assert.equal(withNotes.ok, true, JSON.stringify(withNotes))
    await cmd(B, 'completeBooking', 'm2v_n_done', { bookingId: booked.result.bookingId })
    // 目录读的是**服务端投影**：B 看自己参与过的课，A 看被授权的会员。
    openId = B.open
    const directory = await main()({ action: 'authorization', read: 'directory', environment: 'sandbox' })
    assert.equal(directory.ok, true, JSON.stringify(directory))
    const member = (directory.serving || []).find(row => row.studentId === ids.studentId)
    assert.ok(member, 'B 应该能看到被授权的会员')
    const shared = JSON.stringify(member.history || [])
    assert.ok(/卧推/.test(shared), '训练动作必须可见（这是共享内容）')
    const history = (member.history || [])[0] || {}
    assert.equal(history.notes, undefined, 'notes 绝不出现在共享投影里')
    assert.equal(history.summary, undefined, '教练内部 summary 绝不当共享字段外泄')
    assert.equal(history.price, undefined, '他人收入相关的价格快照不投影')
    assert.equal(history.coachPrivateNotes, undefined)
    assert.equal(history.privateNotes, undefined)
    const packageText = JSON.stringify(member.packages || [])
    assert.ok(!/amount|unitPrice|saleId/.test(packageText), '他人销售业绩明细（金额 / 单价 / 销售编号）不得出现在课包投影里')
    assert.ok(/remaining|reserved|availableToBook/.test(packageText), '课时三值必须可见（被授权教练需要它判断能不能排）')
    assert.equal(directory.readOnly, true, '目录必须是只读的')
  })

  // ———————————————————————————————————————————————— P
  await test('P：Sandbox / Production 隔离 —— 授权表也按环境分开，两边互不串', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB')
    const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' })
    const inSandbox = await cmd(A, 'grantPackageTeaching', 'm2v_p_grant', { packageId: ids.packageId, publicCodes: [B.publicCode] })
    assert.equal(inSandbox.ok, true, JSON.stringify(inSandbox))
    assert.equal([...stores[SANDBOX_META.packageGrants].values()].length, 1, 'Sandbox 授权行写在 sandbox 表（这里只授予了 B 一位）')
    assert.equal([...stores[META.packageGrants].values()].length, 0, '正式区授权表必须为空')
    // ⭐ 正式区**同样种一套账本与课包**：这样下面那条命令如果通过，就只能是因为"借到了测试区的授权"
    //   （课包在正式区是真实存在的，唯一缺的就是正式区的授权行 ⇒ 判别力落在这一个点上）。
    const prodA = seedCoachEnv('openid-a', 'ds-a-prod', 'PUBCODEA', 'production')
    seedCoachEnv('openid-b', 'ds-b-prod', 'PUBCODEB', 'production')
    seedPackage(prodA, ids)
    openId = B.open
    const cross = await main()({ action: 'execute', envelope: { command: 'createAuthorizedBooking', requestId: 'm2v_p_cross', expectedRevision: 0, payload: { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10, minute: 0 } } })
    assert.equal(cross.ok, false, '正式区不得借用测试区的授权')
    assert.equal(cross.code, 'PACKAGE_TEACHING_NOT_AUTHORIZED', `课包在正式区存在、唯独授权不在 ⇒ 必须卡在授权（实测 ${cross.code}）`)
    assert.equal([...stores[META.packageGrants].values()].length, 0, '被拒的跨环境命令不许在正式区留下授权行')
    // 正式区读目录：看不到 sandbox 的授权。
    openId = B.open
    const production = await main()({ action: 'authorization', read: 'directory', environment: 'production' })
    assert.equal(production.ok, true, JSON.stringify(production))
    assert.equal((production.serving || []).length, 0, '正式区目录不得出现测试区授权')
    assert.equal((production.managed || []).length, 0)
    // 会员级关系表同样分区。
    assert.equal([...stores[SANDBOX_META.memberAuthorizations].values()].length, 1)
    assert.equal([...stores[META.memberAuthorizations].values()].length, 0)
  })

  // ———————————————————————————————————————————————— Q
  await test('Q：客户端伪造 coachId / ownerCoachId / datasetId —— 一律拒绝，且不产生任何授权', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB')
    const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' })
    openId = B.open
    const forged = [
      { payload: { packageId: ids.packageId, publicCodes: [B.publicCode], ownerCoachId: A.owner } },
      { payload: { packageId: ids.packageId, publicCodes: [B.publicCode], datasetId: A.datasetId } },
      { payload: { packageId: ids.packageId, publicCodes: [B.publicCode], coachId: A.owner } },
      { payload: { packageId: ids.packageId, publicCodes: [B.publicCode], memberId: 'member-x' } }
    ]
    for (let index = 0; index < forged.length; index += 1) {
      const response = await main()({
        action: 'execute', environment: 'sandbox',
        envelope: { command: 'grantPackageTeaching', requestId: `m2v_q_forged_${index}`, expectedRevision: 0, payload: forged[index].payload }
      })
      assert.equal(response.code, 'FORBIDDEN_IDENTITY_INPUT', `第 ${index + 1} 个伪造必须被拒（实测 ${response.code}）`)
    }
    assert.equal(grantRows().length, 0, '伪造请求不许留下任何授权行')
  })

  // ———————————————————————————————————————————————— 授课教练闸
  await test('补充：只有授课教练能改/完成自己的课 —— 前端参数冒充不了服务端可信身份', async () => {
    const A = seedCoach('openid-a', 'ds-a', 'PUBCODEA'), B = seedCoach('openid-b', 'ds-b', 'PUBCODEB')
    const ids = seedPackage(A, { studentId: 'stu-1', packageId: 'pkg-1', saleId: 'sale-1' })
    await cmd(A, 'grantPackageTeaching', 'm2v_x_grant', { packageId: ids.packageId, publicCodes: [B.publicCode] })
    const booked = await cmd(B, 'createAuthorizedBooking', 'm2v_x_book', { studentId: ids.studentId, packageId: ids.packageId, date: '2026-10-02', hour: 10, minute: 0 })
    assert.equal(booked.ok, true, JSON.stringify(booked))
    // ① 把存储的 teachingCoachId 改成别人 ⇒ **连本人都动不了**：闸读的是服务端事实，不是客户端参数。
    const bookingRow = rows('bookings', B.owner, B.datasetId)[0]
    bookingRow.data.teachingCoachId = 'someone-else'
    const tampered = await cmd(B, 'updateBookingContent', 'm2v_x_tamper', { bookingId: booked.result.bookingId, items: ITEMS, category: '综合训练', duration: 60 })
    assert.equal(tampered.ok, false, '授课教练闸被绕过')
    assert.equal(tampered.code, 'NOT_TEACHING_COACH', `必须报"不是授课教练"（实测 ${tampered.code}）`)
    // ② 复原 ⇒ 本人可以正常写内容、正常完课。
    bookingRow.data.teachingCoachId = B.owner
    const byA = await cmd(A, 'completeBooking', 'm2v_x_byA', { bookingId: booked.result.bookingId })
    assert.equal(byA.ok, false, 'A 不能完成 B 的课')
    assert.equal(byA.code, 'BOOKING_NOT_FOUND', `A 那本账里没有这条预约（实测 ${byA.code}）`)
    const content = await cmd(B, 'updateBookingContent', 'm2v_x_content', { bookingId: booked.result.bookingId, items: ITEMS, category: '综合训练', duration: 60 })
    assert.equal(content.ok, true, JSON.stringify(content))
    const byB = await cmd(B, 'completeBooking', 'm2v_x_byB', { bookingId: booked.result.bookingId })
    assert.equal(byB.ok, true, JSON.stringify(byB))
    // ③ 重复完成是另一条硬闸，与授课教练闸无关。
    const again = await cmd(B, 'completeBooking', 'm2v_x_again', { bookingId: booked.result.bookingId })
    assert.equal(again.ok, false, '重复完成必须被挡')
    assert.equal(again.code, 'BOOKING_ALREADY_DONE')
  })

  // ⚠️ 不许无条件打印"全部通过"：只要有 FAIL，收尾必须说失败（否则 exitCode 与末行自相矛盾）。
  if (process.exitCode) process.stdout.write('M2 MULTI COACH AUTHORIZATION TESTS FAILED\n')
  else process.stdout.write('ALL M2 MULTI COACH AUTHORIZATION TESTS PASSED\n')
})()
