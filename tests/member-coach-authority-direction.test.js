// 业务模型方向审计 · 永久回归（2026-10-01）
//
// ⛳ 这一份盯的是**「谁有权力」**，不是「功能能不能跑」。
//
// 【目标模型（她要的）】
//   A = 会员档案 / 课时包的**管理教练**（课时包物理在 A 这本账里，只有一份）
//   B / C = A 授权给该会员上课的其他教练（授权 = 关系，不复制任何数据）
//   M = 会员本人（认领自己的档案，只能约**已被授权**的教练）
//   ⇒ 授权与撤权**只能**由管理教练发起；会员不承担"建立教练服务关系"的职责；
//     会员输入一个陌生教练码**不得**换来任何授课权限。
//
// 【本轮审计结论（写在这里，避免后人重新踩）】
//   ✅ 云端模型**本来就是对的**：`authorization.js` 的双层授权 + `assertMayBook` 云端终判 +
//      教练端「添加授课」由 A 填 B 的公开码（方向正确）。
//   ⛔ 但发现两处真实缺陷 + 两处严重误导，已修，由本文件钉死：
//      D-1 会员端「添加教练」写的是 `coach_shortcuts`（快捷入口），却被叫成"添加教练"、
//          并和"曾上过课"混在同一张列表里 ⇒ 会员分不清"能约"和"只是收藏"；
//          更糟的是约课页**退化路径**把这份列表整份当可约教练 ⇒ "看得见、点了说不能"。
//      D-2 `readMyMemberData.availabilityView` 查课包授权时**漏了账本范围** (ownerCoachId, datasetId)
//          ⇒ 与写路径 `memberBooking.resolveMemberTarget` **不同口径**（写路径带了范围）。
//      D-3 文案：「我的教练码」「授权给我服务的会员」「我管理着的课时包」三处方向没说清。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const { createWorld, runner } = require('./helpers/m2-business-world')
const memberBooking = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
const authorization = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/authorization'))
const occupancy = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/occupancy'))

const ENV = 'sandbox'
const CLAIMS = 'member_sandbox_student_claims'
const CLOCK0 = 1900000000000
const TODAY = memberBooking.beijingDateKey(CLOCK0)

const world = createWorld()

const coachKeyOf = coachId => memberBooking.fixedId('member-coach-view', coachId)
const packageViewIdOf = (claimId, packageId) => memberBooking.fixedId('member-package-view', claimId, packageId)
const pkgOf = (coach, packageId) => world.dataRows('packages', coach.owner, coach.datasetId).find(row => row.id === packageId)
const occOf = (coach, packageId) => occupancy.occupancyOf(pkgOf(coach, packageId))
const grants = () => [...world.stores[authorization.collectionsFor(ENV).package].values()].map(row => row.data || row)
const memberAuths = () => [...world.stores[authorization.collectionsFor(ENV).member].values()].map(row => row.data || row)

function seedPackage(coach, studentId, packageId, extra = {}) {
  world.put('packages', world.businessId('packages', coach.owner, coach.datasetId, packageId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, packageId, studentId,
    data: { id: packageId, type: '常规训练', total: 10, remaining: 10, used: 0, reserved: 0, reservedVersion: 2, price: 300, status: 'active', saleDate: '2026-09-01', ...extra }
  })
  return packageId
}
function seedSale(coach, studentId, packageId, saleId) {
  world.put('sales', world.businessId('sales', coach.owner, coach.datasetId, saleId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, saleId, studentId, packageId,
    data: { id: saleId, studentId, packageId, amount: 3000, date: '2026-09-01', source: 'course' }
  })
}
function seedClaim(memberOpenId, coach, studentId) {
  const claimId = memberBooking.fixedId(CLAIMS, coach.owner, studentId)
  world.put(CLAIMS, claimId, { claimId, memberId: memberBooking.memberIdFor(memberOpenId), coachId: coach.owner, studentId, status: 'verified' })
  return { claimId, memberId: memberBooking.memberIdFor(memberOpenId), studentId }
}
const D = offset => occupancy.addDateDays(TODAY, offset)

// A = 管理教练（账本所有者）；B / C = 候选授课教练；M = 会员本人
let A, B, C, CLAIM, PKG
function setupBase() {
  world.reset()
  A = world.seedCoach('open-a', 'ds-a', 'PUBA')
  B = world.seedCoach('open-b', 'ds-b', 'PUBB')
  C = world.seedCoach('open-c', 'ds-c', 'PUBC')
  world.seedStudent(A, 'stu-1', 'M2 共享测试学员')
  PKG = seedPackage(A, 'stu-1', 'pkg-1')
  seedSale(A, 'stu-1', 'pkg-1', 'sale-1')
  CLAIM = seedClaim('open-m', A, 'stu-1')
  memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
}

// ⚠️ 真服务端 `core.execute` 的返回是**两层**：成功 `{ok:true, result:{...}}`，失败是平的 `{ok:false, code, message}`。
//    取业务字段一律走 `payloadOf()`，取"成功与否"看 `.ok` —— 混用会拿到 undefined（假绿的形状）。
const coachCmd = (coach, command, payload, requestId) => world.execute(coach, command, payload, requestId)
const payloadOf = response => (response && response.result) || {}
const codeOf = response => String((response && response.code) || '')

async function memberBook(options = {}) {
  world.setOpenId(options.openId || 'open-m')
  return world.main()({
    action: 'memberBooking', command: 'createMemberBooking',
    requestId: options.requestId || `mdir_${crypto.randomBytes(6).toString('hex')}`,
    environment: ENV,
    payload: {
      coachKey: coachKeyOf(options.coachId || A.owner),
      packageViewId: packageViewIdOf(CLAIM.claimId, PKG),
      date: options.date || D(3), hour: options.hour == null ? 10 : options.hour, minute: 0
    }
  })
}

// ------------------------------------------------------------------ 只读投影（readMyMemberData）专用假云
//
// ⛔ 只替网络，不替业务：跑的是**真的** `readMyMemberData/service.js`。
function readCloud(openId = 'open-m', environment = ENV) {
  const stores = {}
  const scope = target => ({
    collection(name) {
      const store = target[name] || (target[name] = new Map())
      return {
        doc(id) {
          return {
            async set({ data }) { store.set(id, { ...JSON.parse(JSON.stringify(data)), _id: id }) },
            async remove() { store.delete(id) }
          }
        },
        where(query) {
          let skip = 0, limit = 100
          const api = {
            skip(n) { skip = n; return api },
            limit(n) { limit = n; return api },
            async get() {
              const rows = [...store.values()].filter(row => Object.keys(query).every(key => row[key] === query[key]))
              return { data: rows.slice(skip, skip + limit).map(row => JSON.parse(JSON.stringify(row))) }
            }
          }
          return api
        }
      }
    },
    async runTransaction(work) {
      const draft = {}
      Object.keys(target).forEach(name => { draft[name] = new Map([...target[name]].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])) })
      const result = await work(scope(draft))
      Object.keys(draft).forEach(name => { target[name] = draft[name] })
      return result
    }
  })
  const db = scope(stores)
  return {
    stores, db,
    put: (name, id, row) => { if (!stores[name]) stores[name] = new Map(); stores[name].set(id, { ...row, _id: id }) },
    rows: name => [...(stores[name] || new Map()).values()],
    call: event => require(path.join(ROOT, 'cloudfunctions/readMyMemberData/service')).createService({ db, getOpenId: () => openId })(event),
    environment
  }
}

// 在只读假云里搭一套 A（管理教练）/ B（被授权）/ Z（陌生教练，只有快捷入口）的完整场景。
function seedReadWorld(cloud, { grantB = true, shortcutZ = true } = {}) {
  const { META, SANDBOX_META, coachIdFor } = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/core'))
  // ⛔ 会员侧集合的 `_id` 必须用**会员端那份** fixedId（`(...parts) => sha(parts.join(':'))`）。
  //    教练端那份是 `sha(kind:owner:suffix)`（多一个尾巴冒号）⇒ 算出来的 id 对不上 ⇒ 账户查不到 ⇒ 假红。
  const { fixedId } = require(path.join(ROOT, 'cloudfunctions/memberIdentityCommand/service'))
  const ownerA = coachIdFor('open-a'), ownerB = coachIdFor('open-b'), ownerZ = coachIdFor('open-z')
  const dsA = 'ds-a', dsB = 'ds-b', dsZ = 'ds-z'
  const ownerD = coachIdFor('open-d')
  for (const [openId, coachId, datasetId, code, name] of [
    ['open-a', ownerA, dsA, 'PUBA', '张教练'], ['open-b', ownerB, dsB, 'PUBB', '李教练'], ['open-z', ownerZ, dsZ, 'PUBZ', '陌生教练'],
    // ⭐ D 只有一本空账（没有这位学员、没有课包）—— 专门用来验证"别的账本里的授权不算数"。
    //   ⛔ 不给 D 配 head 的话，就算查询口径错了也走不到 addScope ⇒ 变异传不出来（假绿）。
    ['open-d', ownerD, 'ds-d', 'PUBD', '别家教练']
  ]) {
    cloud.put('coaches', coachId, { openId, status: 'active' })
    cloud.put(META.datasets, fixedId('coach-dataset', coachId, datasetId), { ownerCoachId: coachId, datasetId, status: 'active' })
    cloud.put(SANDBOX_META.heads, fixedId('coach-sandbox-head', coachId), { ownerCoachId: coachId, environment: 'sandbox', activeDatasetId: datasetId })
    cloud.put('member_sandbox_coach_profiles', fixedId('coach-public', coachId), { coachId, publicCode: code, displayName: name, discoverable: true })
  }
  cloud.put('students', fixedId('s', ownerA, 'stu-1'), { ownerCoachId: ownerA, datasetId: dsA, studentId: 'stu-1', data: { id: 'stu-1', name: 'M2 共享测试学员', phone: '138' } })
  cloud.put('packages', fixedId('p', ownerA, 'pkg-1'), { ownerCoachId: ownerA, datasetId: dsA, studentId: 'stu-1', packageId: 'pkg-1', data: { id: 'pkg-1', type: '常规训练', total: 10, used: 1, remaining: 9, price: 300, status: 'active' } })
  cloud.put('member_sandbox_accounts', fixedId('member_sandbox_accounts', memberBooking.memberIdFor('open-m')), { memberId: memberBooking.memberIdFor('open-m'), status: 'active', displayName: '会员甲' })
  cloud.put(CLAIMS, fixedId(CLAIMS, ownerA, 'stu-1'), { claimId: fixedId(CLAIMS, ownerA, 'stu-1'), memberId: memberBooking.memberIdFor('open-m'), coachId: ownerA, studentId: 'stu-1', status: 'verified' })
  if (grantB) {
    const names = authorization.collectionsFor(ENV)
    cloud.put(names.package, authorization.packageGrantId({ ownerCoachId: ownerA, datasetId: dsA }, 'pkg-1', ownerB), {
      ownerCoachId: ownerA, datasetId: dsA, packageId: 'pkg-1', studentId: 'stu-1', coachId: ownerB, status: 'active', canManage: false
    })
  }
  if (shortcutZ) {
    cloud.put('member_sandbox_coach_shortcuts', fixedId('member_sandbox_coach_shortcuts', memberBooking.memberIdFor('open-m'), ownerZ), {
      shortcutId: 'sc-z', memberId: memberBooking.memberIdFor('open-m'), coachId: ownerZ, source: 'publicCode'
    })
  }
  return { ownerA, ownerB, ownerZ, ownerD, dsA }
}

async function main() {
  // ---------------------------------------------------------------- ① 管理教练创建并持有会员课时包
  await runner('① 课时包只在管理教练那本账里（授权不复制第二套）', async () => {
    setupBase()
    await coachCmd(A, 'grantPackageTeaching', { packageId: PKG, publicCodes: [B.publicCode] })
    for (const coach of [B, C]) {
      assert.equal(world.rows('students', coach.owner, coach.datasetId).length, 0, `${coach.publicCode} 账里不许出现复制的学员档案`)
      assert.equal(world.rows('packages', coach.owner, coach.datasetId).length, 0, `${coach.publicCode} 账里不许出现复制的课时包`)
      assert.equal(world.rows('sales', coach.owner, coach.datasetId).length, 0, `${coach.publicCode} 账里不许出现复制的销售`)
    }
    assert.equal(world.rows('packages', A.owner, A.datasetId).length, 1, '课时包仍然只有一份，在 A 账里')
  })

  // ---------------------------------------------------------------- ② 只有管理教练能增加授课教练
  await runner('② 只有管理教练（账本所有者 / canManage 管理人）能添加授课教练', async () => {
    setupBase()
    // ⛔ 先让 B 拿到**授课权**（canManage=false）⇒ 这是最危险的一种人：他看得见这份课包，
    //    但管理权不在他手里。他再想拉 C 进来 ⇒ 必须被云端拒。
    await coachCmd(A, 'grantPackageTeaching', { packageId: PKG, publicCodes: [B.publicCode] })
    const expand = await coachCmd(B, 'grantPackageTeaching', { packageId: PKG, publicCodes: [C.publicCode] })
    assert.equal(expand.ok, false, `⛔ 被授权教练不许替管理教练扩大授权名单：${JSON.stringify(expand)}`)
    assert.equal(codeOf(expand), 'PACKAGE_MANAGE_NOT_AUTHORIZED', `实测 ${codeOf(expand)}`)
    // ⛔ 接管权同样不许自助（"我给自己升成管理人"）。
    const selfManage = await coachCmd(B, 'transferPackageManagement', { packageId: PKG, publicCode: C.publicCode })
    assert.equal(selfManage.ok, false, '被授权教练不许指定接管人')
    assert.equal(codeOf(selfManage), 'PACKAGE_MANAGE_NOT_AUTHORIZED', `实测 ${codeOf(selfManage)}`)
    // ⛔ 完全无关的 C 自助申请 ⇒ 连课包都定位不到，也必须拒（不能因为"看不见"就放行）。
    const stranger = await coachCmd(C, 'grantPackageTeaching', { packageId: PKG, publicCodes: [B.publicCode] })
    assert.equal(stranger.ok, false, 'C 也不许替 A 的课包加人')
    assert.ok(['PACKAGE_NOT_FOUND', 'PACKAGE_MANAGE_NOT_AUTHORIZED'].includes(codeOf(stranger)), `实测 ${codeOf(stranger)}`)
    // ⛔ 被拒之后 C 这条授权记录**不许**产生（拒绝必须是无损的）。
    assert.equal(grants().filter(row => row.coachId === C.owner).length, 0, '被拒的授权不许留下任何痕迹')
    // ✅ A 发起 ⇒ 成功，写下的是 C 的授权（不是 A 自己的）。
    const ok = await coachCmd(A, 'grantPackageTeaching', { packageId: PKG, publicCodes: [C.publicCode] })
    assert.equal(ok.ok, true, JSON.stringify(ok))
    assert.equal(grants().filter(row => row.coachId === C.owner && row.status === 'active').length, 1)
    assert.equal(memberAuths().filter(row => row.coachId === C.owner && row.status === 'active').length, 1, '顺带补齐会员级服务关系')
  })

  // ---------------------------------------------------------------- ③ 未授权教练不能使用该会员课包
  await runner('③ 未授权教练（C）使用该会员课包排课 ⇒ 云端拒绝且零写入', async () => {
    setupBase()
    await coachCmd(A, 'grantPackageTeaching', { packageId: PKG, publicCodes: [B.publicCode] })
    const before = JSON.stringify(world.rows('bookings', A.owner, A.datasetId))
    const denied = await coachCmd(C, 'createAuthorizedBooking', { studentId: 'stu-1', packageId: PKG, date: D(3), hour: 10, minute: 0 })
    assert.equal(denied.ok, false, `C 没有被授权，必须拒绝：${JSON.stringify(denied)}`)
    assert.equal(denied.code, 'PACKAGE_TEACHING_NOT_AUTHORIZED', `实测 ${denied.code}`)
    assert.equal(JSON.stringify(world.rows('bookings', A.owner, A.datasetId)), before, '被拒 ⇒ A 账里一条预约都不许多')
    assert.deepStrictEqual(occOf(A, PKG), { remaining: 10, reserved: 0, availableToBook: 10 }, '被拒 ⇒ 课时占用纹丝不动')
    // ⭐ 双层判据的**判别性**用例：先只给 C **会员级**服务关系（第一层），**不给**课包级（第二层）。
    //   ⇒ 必须报**课包级**那个码（不是"没有服务关系"），会员才知道该让管理教练授的是哪一种权。
    //   ⛔ 少了这一段，就算把课包级那道闸整段删掉，本测试也照样全绿 ⇒ 那才是真的"变异了个空气"。
    await coachCmd(A, 'grantMemberService', { studentId: 'stu-1', publicCodes: [C.publicCode] })
    assert.equal(memberAuths().filter(row => row.coachId === C.owner && row.status === 'active').length, 1, '第一层已成立')
    assert.equal(grants().filter(row => row.coachId === C.owner && row.status === 'active').length, 0, '第二层仍然没有')
    const halfOpened = await coachCmd(C, 'createAuthorizedBooking', { studentId: 'stu-1', packageId: PKG, date: D(3), hour: 11, minute: 0 })
    assert.equal(halfOpened.ok, false, '只有会员级关系 ⇒ 仍然不许用这份课包排课')
    assert.equal(codeOf(halfOpened), 'PACKAGE_TEACHING_NOT_AUTHORIZED', `⛔ 必须是"缺课包级"这个码（实测 ${codeOf(halfOpened)}）`)
    assert.equal(JSON.stringify(world.rows('bookings', A.owner, A.datasetId)), before, '被拒 ⇒ 零写入')
  })

  // ---------------------------------------------------------------- ④ 授权后被授权教练可以服务该会员
  await runner('④ 授权后 B 能排课，且 B 的授权目录里出现这位会员', async () => {
    setupBase()
    await coachCmd(A, 'grantPackageTeaching', { packageId: PKG, publicCodes: [B.publicCode] })
    const booked = await coachCmd(B, 'createAuthorizedBooking', { studentId: 'stu-1', packageId: PKG, date: D(3), hour: 10, minute: 0 })
    assert.equal(booked.ok, true, `B 已被授权 ⇒ 必须能排课：${JSON.stringify(booked)}`)
    // 课记在**授课教练**那本账（B），课时扣在**会员那一份**（A）。
    assert.equal(world.rows('bookings', B.owner, B.datasetId).length, 1, '预约落在 B 的课表里')
    assert.deepStrictEqual(occOf(A, PKG), { remaining: 10, reserved: 1, availableToBook: 9 }, '占的是 A 账里那一份真实课时')
    // B 的服务目录里必须看到这位会员（第一层关系已由授权自动补齐）。
    const directory = await world.readDirectory(B)
    assert.equal(directory.ok, true, JSON.stringify(directory))
    assert.ok((directory.serving || []).some(row => row.studentId === 'stu-1'), 'B 的目录里必须出现这位会员')
  })

  // ---------------------------------------------------------------- ⑤ 会员认领后自动看到正确课包
  await runner('⑤ 会员认领后自动看到管理教练账里那一份课包（不是复制件）', async () => {
    const cloud = readCloud()
    const { ownerA, ownerD, dsA } = seedReadWorld(cloud, { grantB: false, shortcutZ: false })
    const view = await cloud.call({ action: 'read', environment: ENV })
    assert.equal(view.ok, true, JSON.stringify(view))
    assert.equal(view.state, 'ready')
    assert.equal(view.packages.length, 1, '只看到一份课包')
    assert.equal(view.packages[0].typeName, '常规训练')
    assert.equal(view.summary.remaining, 9, '剩余课时就是 A 账里那一份的真值')
    // ⛔ 会员视图不许泄露任何账本定位字段（客户端拿它只能展示，不能反推别人账本）。
    const json = JSON.stringify(view)
    for (const forbidden of ['ownerCoachId', 'datasetId', 'studentId', 'packageId', 'ds-a']) {
      assert.ok(!json.includes(forbidden), `会员视图泄露了 ${forbidden}`)
    }
    assert.ok(ownerA && dsA)
  })

  // ---------------------------------------------------------------- ⑥ 会员只能预约被授权教练
  await runner('⑥ 会员只能约**被授权**的教练：未授权 / 已撤销 / 凭空猜的 coachKey 全被拒', async () => {
    setupBase()
    await coachCmd(A, 'grantPackageTeaching', { packageId: PKG, publicCodes: [B.publicCode] })
    // ✅ 账本所有者 A 天然可约（旧数据零迁移的支点：不需要任何授权行）。
    const withOwner = await memberBook({ coachId: A.owner })
    assert.equal(withOwner.ok, true, `账本所有者天然可约：${JSON.stringify(withOwner)}`)
    // ⛔ C 没有被授权 ⇒ 会员点他必须被云端拒。
    const withC = await memberBook({ coachId: C.owner, hour: 12 })
    assert.equal(withC.ok, false, '会员不许约没有授权的教练')
    assert.equal(codeOf(withC), 'COACH_NOT_AVAILABLE', `实测 ${codeOf(withC)}`)
    // ⛔ 撤销 B（此时 B 没有未完成预约 ⇒ 允许撤）之后再约 ⇒ 与教练端**同一个码**。
    const revoked = await coachCmd(A, 'revokePackageTeaching', { packageId: PKG, publicCode: B.publicCode })
    assert.equal(revoked.ok, true, JSON.stringify(revoked))
    const afterRevoke = await memberBook({ coachId: B.owner, hour: 13 })
    assert.equal(afterRevoke.ok, false, '撤权后不许再约')
    assert.equal(codeOf(afterRevoke), 'PACKAGE_TEACHING_NOT_AUTHORIZED', `实测 ${codeOf(afterRevoke)}`)
    // ⛔ 凭空编一个 coachKey ⇒ 一律拒（不是"没找到"这种含糊的话）。
    const forged = await memberBook({ coachId: 'coach-that-does-not-exist', hour: 14 })
    assert.equal(forged.ok, false)
    assert.equal(codeOf(forged), 'COACH_NOT_AVAILABLE')
  })

  // ---------------------------------------------------------------- ⑦ 撤权后不能再创建新课
  await runner('⑦ 撤权后 B 立即失去排课权（云端终判，不靠前端隐藏按钮）', async () => {
    setupBase()
    await coachCmd(A, 'grantPackageTeaching', { packageId: PKG, publicCodes: [B.publicCode] })
    const beforeRevoke = await coachCmd(B, 'createAuthorizedBooking', { studentId: 'stu-1', packageId: PKG, date: D(3), hour: 10, minute: 0 })
    assert.equal(beforeRevoke.ok, true, `撤权前 B 必须能排课：${JSON.stringify(beforeRevoke)}`)
    // ⛔ 有未完成预约时**不许**直接撤（撤了就是"课还在、人已经没权处理"的死局）。
    const blocked = await coachCmd(A, 'revokePackageTeaching', { packageId: PKG, publicCode: B.publicCode })
    assert.equal(blocked.ok, false, '还有未完成预约 ⇒ 必须先处理预约，绝不静默移除')
    assert.equal(codeOf(blocked), 'COACH_HAS_FUTURE_BOOKINGS', `实测 ${codeOf(blocked)}`)
    // 先把那节课上完（处理预约，不是绕过预约）。
    const bookingId = payloadOf(beforeRevoke).bookingId
    assert.ok(bookingId, `必须拿到 bookingId：${JSON.stringify(beforeRevoke)}`)
    await coachCmd(B, 'updateBookingContent', { bookingId, items: [{ name: '卧推', group: '胸', sets: 4, reps: 12, weight: 40 }], category: '综合训练', duration: 60 })
    assert.equal((await coachCmd(B, 'completeBooking', { bookingId })).ok, true)
    // ✅ 预约处理完 ⇒ 可以撤了。
    const revoked = await coachCmd(A, 'revokePackageTeaching', { packageId: PKG, publicCode: B.publicCode })
    assert.equal(revoked.ok, true, JSON.stringify(revoked))
    const again = await coachCmd(B, 'createAuthorizedBooking', { studentId: 'stu-1', packageId: PKG, date: D(4), hour: 10, minute: 0 })
    assert.equal(again.ok, false, '撤权后必须立即不能再排新课')
    assert.equal(codeOf(again), 'PACKAGE_TEACHING_NOT_AUTHORIZED', `实测 ${codeOf(again)}`)
    // ⛔ 两层都收掉（课包级 + 派生出来的会员级）。
    assert.equal(grants().filter(row => row.coachId === B.owner && row.status === 'active').length, 0)
    assert.equal(memberAuths().filter(row => row.coachId === B.owner && row.status === 'active').length, 0, '派生出来的会员级关系也一并收掉')
    // ⛔ 历史课程与收入**一个都不许删**（撤权只收未来的权力）。
    assert.equal(world.rows('bookings', B.owner, B.datasetId).length, 1, '历史课程必须保留')
    assert.ok(world.dataRows('incomes', B.owner, B.datasetId).length > 0, '历史收入必须保留')
  })

  // ---------------------------------------------------------------- ⑧ 撤权不删除历史课程 / 收入
  await runner('⑧ 撤权不删除历史课程、收入与销售（只收未来的权力）', async () => {
    setupBase()
    await coachCmd(A, 'grantPackageTeaching', { packageId: PKG, publicCodes: [B.publicCode] })
    const booked = await coachCmd(B, 'createAuthorizedBooking', { studentId: 'stu-1', packageId: PKG, date: D(3), hour: 10, minute: 0 })
    assert.equal(booked.ok, true, JSON.stringify(booked))
    const bookingId = payloadOf(booked).bookingId
    assert.ok(bookingId, `必须拿到 bookingId：${JSON.stringify(booked)}`)
    // 完课 ⇒ B 账里产生收入（收入跟着 booking 走，booking 在谁那儿收入就是谁的）。
    const content = await coachCmd(B, 'updateBookingContent', { bookingId, items: [{ name: '卧推', group: '胸', sets: 4, reps: 12, weight: 40 }], category: '综合训练', duration: 60 })
    assert.equal(content.ok, true, JSON.stringify(content))
    const done = await coachCmd(B, 'completeBooking', { bookingId })
    assert.equal(done.ok, true, JSON.stringify(done))
    const incomesBefore = world.dataRows('incomes', B.owner, B.datasetId).length
    assert.ok(incomesBefore > 0, 'B 账里必须有这笔完课收入')
    const salesBefore = world.dataRows('sales', A.owner, A.datasetId).length
    const bookingsBefore = world.rows('bookings', B.owner, B.datasetId).length
    // 撤权（B 已经没有未完成预约 ⇒ 允许撤）
    const revoked = await coachCmd(A, 'revokePackageTeaching', { packageId: PKG, publicCode: B.publicCode })
    assert.equal(revoked.ok, true, JSON.stringify(revoked))
    assert.equal(world.rows('bookings', B.owner, B.datasetId).length, bookingsBefore, '历史课程一条都不许删')
    assert.equal(world.dataRows('incomes', B.owner, B.datasetId).length, incomesBefore, '历史收入一笔都不许删')
    assert.equal(world.dataRows('sales', A.owner, A.datasetId).length, salesBefore, '销售业绩一笔都不许删')
  })

  // ---------------------------------------------------------------- ⑨ 多教练共用同一余额
  await runner('⑨ 多教练共用**同一份**余额，绝不产生第二套课时', async () => {
    setupBase()
    await coachCmd(A, 'grantPackageTeaching', { packageId: PKG, publicCodes: [B.publicCode, C.publicCode] })
    for (const [index, coach] of [A, B, C].entries()) {
      const result = await coachCmd(coach, 'createAuthorizedBooking', { studentId: 'stu-1', packageId: PKG, date: D(3), hour: 10 + index, minute: 0 })
      assert.equal(result.ok, true, `${coach.publicCode} 排课失败 ${JSON.stringify(result)}`)
    }
    assert.deepStrictEqual(occOf(A, PKG), { remaining: 10, reserved: 3, availableToBook: 7 }, '三节都占在同一份课时上')
    assert.equal(pkgOf(A, PKG).used, 0, '预约不扣课时')
    // ⛔ B / C 账里不许出现任何"第二套余额"。
    for (const coach of [B, C]) assert.equal(world.rows('packages', coach.owner, coach.datasetId).length, 0)
  })

  // ---------------------------------------------------------------- ⑩ 并发预约不会重复扣课
  await runner('⑩ 并发 / 重发不重复扣课（requestId 幂等 + 事务串行）', async () => {
    setupBase()
    await coachCmd(A, 'grantPackageTeaching', { packageId: PKG, publicCodes: [B.publicCode] })
    // ⭐ 真正的并发形状：**同一个提交会话**被重复发出（双击 / 超时重发 / 弱网重传）。
    //   三趟同号并发 ⇒ 云端只许落一条，占用只许 +1。
    const same = await Promise.all([1, 2, 3].map(() => memberBook({ coachId: B.owner, requestId: 'mdir_same_request_id' })))
    assert.ok(same.some(row => row && row.ok === true), `至少一趟要成功：${JSON.stringify(same)}`)
    assert.equal(world.rows('bookings', B.owner, B.datasetId).length, 1, `⛔ 同号并发只许落一条（实测 ${world.rows('bookings', B.owner, B.datasetId).length} 条）`)
    assert.deepStrictEqual(occOf(A, PKG), { remaining: 10, reserved: 1, availableToBook: 9 }, '同号并发不许重复占用课时')
    // ⛔ 再来一趟同号（这次是串行重发）⇒ 命中收据，仍然只有一条。
    const replay = await memberBook({ coachId: B.owner, requestId: 'mdir_same_request_id' })
    assert.equal(payloadOf(replay).replayed === true || replay.replayed === true, true, `同号重发必须命中收据：${JSON.stringify(replay)}`)
    assert.equal(world.rows('bookings', B.owner, B.datasetId).length, 1)
    // ✅ 不同会话**串行**发三趟（不同时段）⇒ 各落一条，占用恰好 +3（不多不少）。
    for (const hour of [14, 15, 16]) {
      const result = await memberBook({ coachId: B.owner, hour, requestId: `mdir_seq_${hour}` })
      assert.equal(result.ok, true, `${hour} 点排课失败 ${JSON.stringify(result)}`)
    }
    assert.equal(world.rows('bookings', B.owner, B.datasetId).length, 4, '三趟各落一条')
    assert.deepStrictEqual(occOf(A, PKG), { remaining: 10, reserved: 4, availableToBook: 6 }, '不得重复扣课 / 少算占用')
  })

  // ---------------------------------------------------------------- ⑪ 管理权 / 接管权变化不复制课包
  await runner('⑪ 指定接管人只转移**管理权**，销售 / 收入 / 课包一个字节不动', async () => {
    setupBase()
    await coachCmd(A, 'grantPackageTeaching', { packageId: PKG, publicCodes: [B.publicCode] })
    const before = JSON.stringify({
      sales: world.dataRows('sales', A.owner, A.datasetId),
      packages: world.dataRows('packages', A.owner, A.datasetId),
      bookings: world.dataRows('bookings', A.owner, A.datasetId)
    })
    const transferred = await coachCmd(A, 'transferPackageManagement', { packageId: PKG, publicCode: B.publicCode })
    assert.equal(transferred.ok, true, JSON.stringify(transferred))
    assert.equal(payloadOf(transferred).managerCoachId, B.owner)
    assert.equal(JSON.stringify({
      sales: world.dataRows('sales', A.owner, A.datasetId),
      packages: world.dataRows('packages', A.owner, A.datasetId),
      bookings: world.dataRows('bookings', A.owner, A.datasetId)
    }), before, '接管不许动销售 / 课包 / 预约')
    for (const coach of [B, C]) assert.equal(world.rows('packages', coach.owner, coach.datasetId).length, 0, '接管不复制课包')
    // ⛔ 接管人必须是"已有授课授权"的人；把管理权交给陌生人 ⇒ 拒绝。
    const toStranger = await coachCmd(A, 'transferPackageManagement', { packageId: PKG, publicCode: C.publicCode })
    assert.equal(toStranger.ok, false, '接管人必须先有授课授权')
    assert.equal(codeOf(toStranger), 'GRANT_TARGET_NOT_TEACHING_COACH', `实测 ${codeOf(toStranger)}`)
    // ✅ 接管之后 B 可以再授权给 C（管理权真的转移了）。
    const byB = await coachCmd(B, 'grantPackageTeaching', { packageId: PKG, publicCodes: [C.publicCode] })
    assert.equal(byB.ok, true, `接管人应当获得管理权：${JSON.stringify(byB)}`)
  })

  // ---------------------------------------------------------------- ⑫ 会员不能自行扩大授权范围
  await runner('⑫ ⭐ 会员输入陌生教练码**换不来**任何授课权限（bookable=false 且预约被拒）', async () => {
    const cloud = readCloud()
    const { ownerA, ownerB, ownerZ } = seedReadWorld(cloud, { grantB: true, shortcutZ: true })
    const view = await cloud.call({ action: 'read', environment: ENV })
    assert.equal(view.ok, true, JSON.stringify(view))
    const byCoach = new Map(view.coaches.map(row => [row.displayName, row]))
    // ① 会员自己加进来的「常用教练」Z：出现在列表里（快捷入口），但 **bookable=false**。
    const z = [...view.coaches].find(row => row.saved === true)
    assert.ok(z, '快捷入口应当还在（那是一个产品功能）')
    assert.equal(z.bookable, false, '⛔ 会员自己加的教练绝不能变成"可约"')
    // ② 账本所有者 A 与被授权的 B 都必须是 bookable=true。
    const a = view.coaches.find(row => row.coachKey === coachKeyOf(ownerA))
    assert.ok(a, `管理教练必须出现在「我的教练」里（实测 ${JSON.stringify(view.coaches)}）`)
    assert.equal(a.bookable, true, '管理教练本人必须可约')
    const b = view.coaches.find(row => row.coachKey === coachKeyOf(ownerB))
    assert.ok(b && b.bookable === true, '被授权的 B 必须可约')
    // ③ 端到端：会员拿 Z 的 coachKey 去预约 ⇒ 云端必须拒。
    setupBase()
    const denied = await memberBook({ coachId: ownerZ, hour: 10 })
    assert.equal(denied.ok, false, '⛔ 会员加了码也不许约')
    assert.equal(denied.code, 'COACH_NOT_AVAILABLE', `实测 ${denied.code}`)
    assert.ok(ownerA)
  })

  // ---------------------------------------------------------------- ⑬ 旧 M2 数据仍可兼容读取
  await runner('⑬ 旧数据零迁移：没有任何授权行时，账本所有者与会员的老流程逐字不变', async () => {
    setupBase()   // ⛔ 故意**不**执行任何 grantPackageTeaching
    assert.equal(grants().length, 0, '这一组的前提：没有任何授权行')
    const booked = await coachCmd(A, 'createAuthorizedBooking', { studentId: 'stu-1', packageId: PKG, date: D(3), hour: 10, minute: 0 })
    assert.equal(booked.ok, true, `所有者不需要授权行：${JSON.stringify(booked)}`)
    const byMember = await memberBook({ coachId: A.owner, hour: 11 })
    assert.equal(byMember.ok, true, `会员约自己的管理教练不受影响：${JSON.stringify(byMember)}`)
    const denied = await memberBook({ coachId: B.owner, hour: 12 })
    assert.equal(denied.ok, false, '没有授权 ⇒ 约不了（与旧行为一致）')
    // 只读投影同样兼容：没有 grant 时 A 仍然 bookable。
    const cloud = readCloud()
    seedReadWorld(cloud, { grantB: false, shortcutZ: false })
    const view = await cloud.call({ action: 'read', environment: ENV })
    assert.equal(view.packages.length, 1, '老数据照样读得到课包')
  })

  // ---------------------------------------------------------------- ⑭ 性能机制不退化
  await runner('⑭ 性能机制不许退化：两条写出口不许 `await read(`，后台对账仍在', async () => {
    const source = fs.readFileSync(path.join(ROOT, 'utils/member-runtime.js'), 'utf8')
    // ⚠️ 只在**两个提交出口**里判：文件里另外几处 `await read(` 属于 pending 补发 / 版本冲突自愈，
    //    那些本来就该等（它们不是"告诉用户成功"的那条路）。
    //    ⇒ 断言必须**按函数切片**，不能全文件数个数（那样会把合法的那几处也算成缺陷，假红）。
    for (const name of ['submitMemberBooking', 'submitMemberManage']) {
      const from = source.indexOf(`async function ${name}(`)
      assert.ok(from >= 0, `必须能定位到 ${name}`)
      const to = source.indexOf('\nasync function ', from + 10)
      const body = source.slice(from, to < 0 ? source.length : to)
      assert.ok(body.length > 100, `${name} 的切片不该是空的（锚点写错会假红）`)
      assert.ok(!/await\s+read\(/.test(body), `⛔ ${name} 不许再 await read( —— 那会把"成功"推迟一整个网络往返`)
      assert.ok(/void startBackgroundReconcile\(/.test(body), `${name} 必须把对账丢到后台（不等待）`)
    }
    assert.ok(/pendingReconcile/.test(source), '页面要能补等对账')
  })

  // ---------------------------------------------------------------- ⑮ 可约教练由服务端裁决下发
  await runner('⑮ ⭐ 服务端下发 `bookable`：只来自认领关系 + 有效课包授权', async () => {
    const cloud = readCloud()
    const { ownerB } = seedReadWorld(cloud, { grantB: true, shortcutZ: true })
    const view = await cloud.call({ action: 'read', environment: ENV })
    const names = view.coaches.map(row => `${row.displayName}:${row.bookable}`).sort()
    assert.ok(names.includes('张教练:true'), `管理教练必须可约（实测 ${names.join(' | ')}）`)
    assert.ok(names.includes('李教练:true'), `被授权的 B 必须可约（实测 ${names.join(' | ')}）`)
    assert.ok(view.coaches.some(row => row.coachKey === coachKeyOf(ownerB)), '⛔ 刚被授权、还没上过课的教练也必须看得见')
    assert.ok(names.includes('陌生教练:false'), `⛔ 会员自己加的教练必须 bookable=false（实测 ${names.join(' | ')}）`)
    // ⛔ 撤销 B 之后，B 必须变成不可约（服务端当场生效，不是靠前端藏）。
    const grantName = authorization.collectionsFor(ENV).package
    const grantRow = cloud.rows(grantName)[0]
    cloud.put(grantName, grantRow._id, { ...grantRow, status: authorization.STATUS_REVOKED })
    const after = await cloud.call({ action: 'read', environment: ENV })
    const b = after.coaches.find(row => row.coachKey === coachKeyOf(ownerB))
    // ⛔ 撤权后 B 要么从列表消失（本来就没上过课、也没加过快捷入口），
    //    要么还在（有过历史 / 会员加过快入口）—— 但**绝不允许**仍是 bookable=true。
    assert.ok(!b || b.bookable === false, `撤权后 B 必须不可约（实测 ${JSON.stringify(after.coaches)}）`)
  })

  // ---------------------------------------------------------------- ⑯ 读写口径必须一致（账本范围）
  await runner('⑯ ⭐ 可约时间投影查课包授权**必须带账本范围**（与写路径同口径）', async () => {
    const cloud = readCloud()
    const { ownerA, ownerD, dsA } = seedReadWorld(cloud, { grantB: false, shortcutZ: false })
    // ⛔ 故意在**另一本账**（X）里放一条同 studentId 的有效授权 ⇒ 老写法（只按 studentId 查）
    //    会把它算成"会员可以约这位教练"，而写路径（带 ownerCoachId/datasetId）会拒
    //    ⇒ 这正是"界面说能、云端说不能"的那一类故障。
    const { coachIdFor } = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/core'))
    const ownerX = coachIdFor('open-x')
    const names = authorization.collectionsFor(ENV)
    cloud.put(names.package, authorization.packageGrantId({ ownerCoachId: ownerX, datasetId: 'ds-x' }, 'pkg-1', ownerD), {
      ownerCoachId: ownerX, datasetId: 'ds-x', packageId: 'pkg-1', studentId: 'stu-1', coachId: ownerD, status: 'active', canManage: false
    })
    const view = await cloud.call({ action: 'availability', date: D(3), environment: ENV })
    assert.equal(view.availability, true, JSON.stringify(view))
    // D 只在 X 那本账的授权里出现 ⇒ **不许**算成这位会员的可约教练。
    assert.ok(!view.coaches.some(row => row.coachKey === coachKeyOf(ownerD)),
      `⛔ 别的账本里的授权不许算成可约（实测 ${JSON.stringify(view.coaches)}）`)
    assert.ok(view.coaches.some(row => row.coachKey === coachKeyOf(ownerA)), '账本所有者本人必须可约')
    assert.ok(view.coaches.every(row => row.bookable === true), '能进这张表的每一位都是可约的')
    assert.ok(dsA)
  })

  // ---------------------------------------------------------------- ⑰ 约课页退化路径不拿快捷入口当可约教练
  await runner('⑰ ⭐ 约课页退化路径：只渲染 `bookable=true` 的教练，绝不塞一个假的', async () => {
    const state = { calls: [], modals: [], toasts: [], storage: {} }
    global.wx = {
      getStorageSync: key => state.storage[key],
      setStorageSync: (key, value) => { state.storage[key] = value },
      removeStorageSync: key => { delete state.storage[key] },
      navigateTo: () => { },
      showToast: option => state.toasts.push(option),
      showModal: option => state.modals.push(option),
      stopPullDownRefresh: () => { },
      cloud: {
        callFunction: async ({ name, data }) => {
          state.calls.push({ name, data })
          if (name !== 'readMyMemberData' && data.action !== 'memberRead') throw new Error(`未预期的云调用 ${name}`)
          const action = data.readAction || data.action
          if (action === 'availability') throw new Error('模拟：读不到可约时间（退化路径）')
          return {
            result: {
              ok: true, environment: ENV, state: 'ready', dataRevision: 0,
              member: { displayName: '会员甲', theme: 'vitality' }, summary: { remaining: 9 },
              packages: [], recentTraining: [], nextBooking: null,
              coaches: [
                { coachKey: 'k-stranger', displayName: '陌生教练', saved: true, shortcutId: 'sc-1', bookable: false },
                { coachKey: 'k-real', displayName: '张教练', historical: true, bookable: true }
              ]
            }
          }
        }
      }
    }
    for (const key of Object.keys(require.cache)) {
      if (key.includes('utils/member-runtime') || key.includes('utils/data-runtime') || key.includes('utils/release-flags') || key.includes('pages/member-book-slots')) delete require.cache[key]
    }
    const runtime = require(path.join(ROOT, 'utils/data-runtime'))
    runtime.setEnvironment('sandbox')
    const page = world.enterPage(path.join(ROOT, 'pages/member-book-slots/member-book-slots'))
    await page.load({ force: true })
    assert.equal(page.data.coaches.length, 1, `退化路径只该留下可约的那一位（实测 ${JSON.stringify(page.data.coaches)}）`)
    assert.equal(page.data.coaches[0].displayName, '张教练')
    assert.ok(!page.data.error, `有可约教练时不该报错（实测 ${page.data.error}）`)
    // ⛔ 反过来：一个可约的都没有 ⇒ 必须**明说**，绝不塞一个假的「教练」让用户点了才报错。
    state.calls.length = 0
    global.wx.cloud.callFunction = async ({ data }) => {
      if (data.action === 'availability') throw new Error('boom')
      return { result: { ok: true, environment: ENV, state: 'ready', dataRevision: 0, member: {}, summary: {}, packages: [], recentTraining: [], nextBooking: null, coaches: [{ coachKey: 'k-stranger', displayName: '陌生教练', saved: true, bookable: false }] } }
    }
    const page2 = world.enterPage(path.join(ROOT, 'pages/member-book-slots/member-book-slots'))
    await page2.load({ force: true })
    assert.ok(page2.data.error && page2.data.error.length > 0, '没有可约教练时必须明确提示')
    assert.equal(page2.data.coaches.length, 0, '⛔ 不许凭空造一个"教练"出来')
    delete global.wx
  })

  // ---------------------------------------------------------------- ⑱ 文案方向（谁管谁、谁授权谁）
  // ⭐ 2026-10-06 新口径：会员**真的能自己加教练**（双向添加），添加即开通排课权。
  //    ⛔ 旧的"只是快捷入口 / 不是授权 / 由管理教练授权决定"这套说法已整体作废。
  await runner('⑱ 文案：会员端「添加教练」是**真添加**，添加后就能约课（不再是"只是快捷入口"）', async () => {
    const add = fs.readFileSync(path.join(ROOT, 'pages/member-add-coach/member-add-coach.wxml'), 'utf8')
    assert.ok(add.includes('>添加教练<'), '新方案里会员就是可以自己添加教练')
    assert.ok(add.includes('你就能主动约课'), '必须说清加完能做什么')
    assert.ok(add.includes('不需要对方同意'), '必须说清不需要对方先点头（双方都有主动权）')
    assert.ok(!add.includes('这只是快捷入口，不是授权'), '⛔ 旧的"只是快捷入口"说法不许再出现')
    // ⛔ 只按公开编号精确查找，确认卡不下发手机号
    assert.ok(add.includes('C 开头的完整教练编号'), '必须写清是完整教练编号')
    assert.ok(add.includes('{{card.publicCode}}'), '确认卡必须显示公开编号')
  })

  await runner('⑲ 文案：教练端必须分清「我主管的」与「我只能上课的」', async () => {
    // ⛔ 旧「多教练服务（授权）工作台」页面已下线 ⇒ 这句话改由**会员详情页**来说。
    const wxml = fs.readFileSync(path.join(ROOT, 'pages/coach-member-detail/coach-member-detail.wxml'), 'utf8')
    assert.ok(wxml.includes('{{note}}'), '非主管教练必须看到服务端给的那句话（不是一个按钮藏起来就完事）')
    assert.ok(wxml.includes('wx:if="{{isOwner}}" class="btn ghost"'), '改资料入口**只**对主管教练显示')
    const text = fs.readFileSync(path.join(ROOT, 'cloudfunctions/coachBusinessSandboxCommand/member-directory.js'), 'utf8')
    assert.ok(text.includes('课时包由主管教练管理'), '服务端那句话必须点明权力在主管教练手里')
    assert.ok(text.includes('NOT_OWNER_COACH'), '非主管改核心资料必须在服务端被拒')
  })

  console.log('member coach authority direction: PASS (19 段 · 权力方向 + 读写同口径 + 退化路径 + 文案)')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
