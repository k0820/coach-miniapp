// N 位教练扩展性专项审计（2026-09-30 · M3 并行批次）
//
// ⛔ 审计的问题不是"测试里叫 A/B 行不行"（那是 fixture 命名，可以），而是：
//    **生产代码里有没有"刚好两位教练"的假设** —— 数组下标、固定角色、`[0]` / `[1]`、
//    "撤销一个就等于清空"、"管理人只有两个人" 这类写法，在第 3 位教练出现时就会静默错。
//
// 本文件用 **A(owner) + B/C/D/E/F 共 6 位教练** 跑一遍真实链路（真云函数代码 + 假 CloudBase）：
//   ① 同一会员被多位教练授课；② 课包只有一份、不被复制；③ 授权独立增删、不覆盖已有关系；
//   ④ 管理人切换不污染旁人；⑤ 冲突 / 余额 / 销售 / 收入仍按真实关系；⑥ 会员自约能从 N 位里选。
//
// ⛔ 未部署、未上传、未碰 Production、未清 Sandbox。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createWorld, runner } = require('./helpers/m2-business-world')

const ROOT = path.join(__dirname, '..')
const authorization = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/authorization'))
const memberBooking = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/memberBooking'))
const cloudOccupancy = require(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/occupancy'))

const ENV = 'sandbox'
const CLAIMS = 'member_sandbox_student_claims'
const CLOCK0 = 1900000000000
const TODAY = memberBooking.beijingDateKey(CLOCK0)

const world = createWorld()

// ⭐ 6 位教练：A 是课包/学员所在账的所有者，B..F 是被授权的授课教练。
//    ⛔ 故意不用"A / B"两个字母之外的任何特殊处理 —— 代码里不认识"第一个/最后一个"这种概念。
const CODES = ['PUBB', 'PUBC', 'PUBD', 'PUBE', 'PUBF']
let A, B, C, D, E, F, PKG = 'pkg-a', STUDENT = 'stu-a'
let MEMBER_OPEN = 'open-m1'
let MEMBER_ID = ''

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
}

function setup(options = {}) {
  world.reset()
  A = world.seedCoach('open-a', 'ds-a', 'PUBA')
  const rest = CODES.map((code, index) => world.seedCoach(`open-${code.toLowerCase()}`, `ds-${code.toLowerCase()}`, code))
  ;[B, C, D, E, F] = rest
  world.seedStudent(A, STUDENT, '会员甲')
  world.put('packages', world.businessId('packages', A.owner, A.datasetId, PKG), {
    ownerCoachId: A.owner, datasetId: A.datasetId, packageId: PKG, studentId: STUDENT,
    data: { id: PKG, type: '常规训练', total: 20, remaining: options.remaining == null ? 20 : options.remaining, used: 0, reserved: 0, reservedVersion: 3, price: 300, status: 'active' }
  })
  world.put('sales', world.businessId('sales', A.owner, A.datasetId, 'sale-a'), {
    ownerCoachId: A.owner, datasetId: A.datasetId, saleId: 'sale-a', studentId: STUDENT,
    data: { id: 'sale-a', studentId: STUDENT, amount: 6000, date: '2030-01-01', source: 'manual' }
  })
  world.put('incomes', world.businessId('incomes', A.owner, A.datasetId, 'income-a'), {
    ownerCoachId: A.owner, datasetId: A.datasetId, incomeId: 'income-a',
    data: { id: 'income-a', amount: 300, date: '2030-01-02' }
  })
  MEMBER_ID = memberBooking.memberIdFor(MEMBER_OPEN)
  if (options.claim !== false) {
    world.put(CLAIMS, memberBooking.fixedId(CLAIMS, A.owner, STUDENT), {
      claimId: memberBooking.fixedId(CLAIMS, A.owner, STUDENT),
      memberId: MEMBER_ID, coachId: A.owner, studentId: STUDENT, status: 'verified'
    })
  }
  return { A, B, C, D, E, F }
}

const names = () => authorization.collectionsFor(ENV)
function grantRows() { return [...world.stores[names().package].values()] }
function memberRows() { return [...world.stores[names().member].values()] }
const grantFor = coach => grantRows().find(row => row.coachId === coach.owner && row.packageId === PKG)
const memberAuthFor = coach => memberRows().find(row => row.coachId === coach.owner && row.studentId === STUDENT)

async function grantTeaching(actor, codes) {
  return world.execute(actor, 'grantPackageTeaching', { packageId: PKG, publicCodes: codes })
}
async function revokeTeaching(actor, code) {
  return world.execute(actor, 'revokePackageTeaching', { packageId: PKG, publicCode: code })
}
async function bookAs(actor, date, hour) {
  return world.execute(actor, 'createAuthorizedBooking', { studentId: STUDENT, packageId: PKG, date, hour, minute: 0 })
}
const pkgData = () => world.rows('packages', A.owner, A.datasetId)[0].data
const bookingsOf = coach => world.rows('bookings', coach.owner, coach.datasetId)
const dayOffset = n => cloudOccupancy.addDateDays(TODAY, n)
const coachKeyOf = coachId => memberBooking.fixedId('member-coach-view', coachId)
const packageViewIdOf = (claimId, packageId) => memberBooking.fixedId('member-package-view', claimId, packageId)

async function main() {
  // ────────────────────────────────────────────────────────────── ① 一位会员 · 多位授课教练
  await runner('① 同一会员可被 5 位教练授课：一次授予 5 个公开码 ⇒ 5 条独立授权行，互不覆盖', async () => {
    setup()
    const result = await grantTeaching(A, CODES)
    assert.strictEqual(result.ok, true, `授予失败：${result.code}`)
    // ⭐ `core.execute` 的返回形状：`{ ok, command, requestId, datasetRevision, result }`
    //    ⇒ 命令自己的输出在 `result.result`（写成 `result.granted` 就是 undefined ⇒ 假绿）。
    assert.strictEqual(result.result.granted.length, 5, `应当一次授予 5 位教练，实际 ${result.result.granted.length}`)
    const rows = grantRows()
    assert.strictEqual(rows.length, 5, `授权行必须是 5 条（一位教练一行），实际 ${rows.length}`)
    // ⛔ 判据不是"有 5 行"，而是**每一行都指向不同的教练**、且都指向同一份真实课包。
    const coachIds = new Set(rows.map(row => row.coachId))
    assert.strictEqual(coachIds.size, 5, `5 行必须对应 5 个不同教练，实际 ${coachIds.size} 个`)
    rows.forEach(row => {
      assert.strictEqual(row.packageId, PKG, '每一行都必须指向同一份真实课包')
      assert.strictEqual(row.ownerCoachId, A.owner, '课包归属不因授权而转移')
      assert.strictEqual(row.status, authorization.STATUS_ACTIVE)
    })
    // 会员级服务关系同样一人一行（派生补齐）
    assert.strictEqual(memberRows().length, 5, '会员级关系也必须一人一行')
  })

  await runner('② 课包只有一份：5 位教练各排一节后，packages 仍然只有 1 行，remaining 不变、reserved=5', async () => {
    setup()
    await grantTeaching(A, CODES)
    const before = pkgData()
    assert.strictEqual(world.rows('packages', A.owner, A.datasetId).length, 1, '课包物理上只有一份')
    const actors = [B, C, D, E, F]
    for (let index = 0; index < actors.length; index += 1) {
      const result = await bookAs(actors[index], dayOffset(index + 1), 9 + index)
      assert.strictEqual(result.ok, true, `${CODES[index]} 排课失败：${result.code} ${result.message || ''}`)
    }
    const after = pkgData()
    assert.strictEqual(after.remaining, before.remaining, '创建预约不消耗 remaining（只占座）')
    assert.strictEqual(Number(after.reserved), 5, `5 节预约 ⇒ reserved 必须是 5，实际 ${after.reserved}`)
    assert.strictEqual(world.rows('packages', A.owner, A.datasetId).length, 1, '排完课仍然只有一份课包（没被复制）')
    // 预约文档分别落在**各自授课教练**的账里 ⇒ 5 本账各 1 条
    const owners = []
    for (const actor of actors) {
      const rows = bookingsOf(actor).filter(row => String((row.data || {}).packageId || '') === PKG)
      assert.strictEqual(rows.length, 1, `${actor.publicCode} 账里应当有 1 条预约，实际 ${rows.length}`)
      owners.push(rows[0].ownerCoachId)
    }
    assert.strictEqual(new Set(owners).size, 5, '5 条预约必须分别落在 5 位教练的账上')
  })

  await runner('③ 撤销中间那一位（C）⇒ B / D / E / F 完全不受影响（不按下标、不按角色）', async () => {
    setup()
    await grantTeaching(A, CODES)
    const cBefore = grantFor(C)
    const result = await revokeTeaching(A, C.publicCode)
    assert.strictEqual(result.ok, true, `撤销 C 失败：${result.code}`)
    assert.strictEqual(grantFor(C).status, authorization.STATUS_REVOKED, 'C 变成已撤销')
    // ⛔ 关键：撤销的是"第 3 位"（不是第一个也不是最后一个）⇒ 按下标/固定角色写的代码会撤错人。
    for (const coach of [B, D, E, F]) {
      const row = grantFor(coach)
      assert.strictEqual(row.status, authorization.STATUS_ACTIVE, `${coach.publicCode} 不该被牵连`)
      assert.strictEqual(row.createdAt, grantFor(coach).createdAt)
    }
    // C 排不了，D 仍然能排
    const denied = await bookAs(C, dayOffset(2), 15)
    assert.strictEqual(denied.ok, false, '撤销后 C 不能再排课')
    assert.strictEqual(denied.code, 'PACKAGE_TEACHING_NOT_AUTHORIZED', `错误码必须与教练端一致，实际 ${denied.code}`)
    const allowed = await bookAs(D, dayOffset(2), 16)
    assert.strictEqual(allowed.ok, true, `D 仍应能排课：${allowed.code}`)
  })

  await runner('④ 第 6 位教练 F 后来加入 ⇒ 已有 5 条授权一个字节都没被改写', async () => {
    setup()
    await grantTeaching(A, CODES.slice(0, 4))          // 先 B C D E
    const before = grantRows().map(row => JSON.stringify(row)).sort()
    const result = await grantTeaching(A, [F.publicCode])  // 再加 F
    assert.strictEqual(result.ok, true, `加入 F 失败：${result.code}`)
    assert.strictEqual(grantRows().length, 5, '授权行应变为 5 条')
    const kept = grantRows().filter(row => row.coachId !== F.owner).map(row => JSON.stringify(row)).sort()
    assert.deepEqual(kept, before, '已有授权行必须逐字不变（新增不能覆盖已有关系）')
    assert.strictEqual(grantFor(F).status, authorization.STATUS_ACTIVE)
  })

  await runner('⑤ 管理人切换（A→C→D）：只动交出的那个人，B / E / F 永不变成管理人', async () => {
    setup()
    await grantTeaching(A, CODES)
    const first = await world.execute(A, 'transferPackageManagement', { packageId: PKG, publicCode: C.publicCode })
    assert.strictEqual(first.ok, true, `A 交给 C 失败：${first.code}`)
    assert.strictEqual(grantFor(C).canManage, true, 'C 成为管理人')
    const second = await world.execute(C, 'transferPackageManagement', { packageId: PKG, publicCode: D.publicCode })
    assert.strictEqual(second.ok, true, `C 交给 D 失败：${second.code}`)
    assert.strictEqual(grantFor(D).canManage, true, 'D 成为管理人')
    assert.strictEqual(grantFor(C).canManage, false, 'C 交出后不再是管理人')
    // ⛔ 旁人绝不能被顺手带上
    for (const coach of [B, E, F]) {
      assert.strictEqual(grantFor(coach).canManage, false, `${coach.publicCode} 不该变成管理人`)
    }
    const managers = grantRows().filter(row => row.canManage === true).map(row => row.coachId)
    assert.deepEqual(managers, [D.owner], `非所有者的管理人只能有 D 一位，实际 ${managers.length} 位`)
  })

  await runner('⑥ 冲突分两层：会员同时段只能有一节课（MEMBER_TIME_CONFLICT）；教练自己撞车是 BOOKING_TIME_CONFLICT', async () => {
    setup()
    await grantTeaching(A, CODES)
    const date = dayOffset(4)
    const first = await bookAs(B, date, 10)
    assert.strictEqual(first.ok, true, `B 先排成功：${first.code}`)
    const second = await bookAs(D, date, 10)
    assert.strictEqual(second.ok, false, '同一位会员同一时段不能有两节课（哪怕换一位教练）')
    assert.strictEqual(second.code, 'MEMBER_TIME_CONFLICT', `实际 ${second.code}`)
    // 换一个小时 ⇒ 立刻可以（冲突只针对那一段，不是把这位教练整天锁死）
    const third = await bookAs(D, date, 14)
    assert.strictEqual(third.ok, true, `换时间后 D 应能排：${third.code}`)
    // —— 教练层：B 自己账里还有另一位学员，同时段再排一节 ⇒ 撞的是 B 的时间 ——
    world.seedStudent(B, 'stu-b2', '会员乙')
    world.put('packages', world.businessId('packages', B.owner, B.datasetId, 'pkg-b2'), {
      ownerCoachId: B.owner, datasetId: B.datasetId, packageId: 'pkg-b2', studentId: 'stu-b2',
      data: { id: 'pkg-b2', type: '常规训练', total: 10, remaining: 10, used: 0, reserved: 0, reservedVersion: 1, price: 300, status: 'active' }
    })
    const clash = await world.execute(B, 'createBooking', { studentId: 'stu-b2', packageId: 'pkg-b2', date, hour: 10, minute: 0 })
    assert.strictEqual(clash.ok, false, 'B 自己这段时间已经有课了')
    assert.strictEqual(clash.code, 'BOOKING_TIME_CONFLICT', `教练层冲突应当报 BOOKING_TIME_CONFLICT，实际 ${clash.code}`)
  })

  await runner('⑦ 余额：remaining=2 ⇒ 第 3 位教练拿不到（PACKAGE_NO_AVAILABLE，且不是"课包不存在"）', async () => {
    setup({ remaining: 2 })
    await grantTeaching(A, CODES)
    assert.strictEqual(await bookAs(B, dayOffset(1), 9).then(r => r.ok), true)
    assert.strictEqual(await bookAs(C, dayOffset(2), 9).then(r => r.ok), true)
    const third = await bookAs(D, dayOffset(3), 9)
    assert.strictEqual(third.ok, false, '余额用尽后不能再排')
    assert.strictEqual(third.code, 'PACKAGE_NO_AVAILABLE', `实际 ${third.code}`)
    assert.notStrictEqual(third.code, 'PACKAGE_NOT_FOUND', '这是余额口径，不是"课包没了"')
    assert.strictEqual(Number(pkgData().reserved), 2, '只占了两节')
  })

  await runner('⑧ 销售 / 收入 / 归属：N 位教练各排一节后 sales 与 incomes 逐字节不变', async () => {
    setup()
    await grantTeaching(A, CODES)
    const salesBefore = JSON.stringify(world.rows('sales', A.owner, A.datasetId))
    const incomesBefore = JSON.stringify(world.rows('incomes', A.owner, A.datasetId))
    // ⛔ 只比**业务字段**（reservedVersion / updatedAt 这类记账字段本来就会动，
    //    拿整行比对会因为"记账字段变了"报红 ⇒ 那是噪音，不是缺陷）。
    const businessFields = row => JSON.stringify({
      packageId: row.packageId, studentId: row.studentId,
      total: row.data.total, remaining: row.data.remaining, used: row.data.used, status: row.data.status
    })
    const packageBefore = JSON.stringify(world.rows('packages', A.owner, A.datasetId).map(businessFields))
    for (let index = 0; index < 5; index += 1) await bookAs([B, C, D, E, F][index], dayOffset(index + 1), 9)
    assert.strictEqual(JSON.stringify(world.rows('sales', A.owner, A.datasetId)), salesBefore, '销售一行都不能变')
    assert.strictEqual(JSON.stringify(world.rows('incomes', A.owner, A.datasetId)), incomesBefore, '预约本身不产生收入')
    assert.strictEqual(JSON.stringify(world.rows('packages', A.owner, A.datasetId).map(businessFields)), packageBefore, '课包的课时字段不许有任何变化')
    assert.strictEqual(Number(pkgData().reserved), 5, '只有 reserved 变了')
  })

  await runner('⑨ 会员自助预约能从 N 位有权教练里任选（不是只认识 A / B）', async () => {
    setup()
    await grantTeaching(A, CODES)
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    const claimId = memberBooking.fixedId(CLAIMS, A.owner, STUDENT)
    // ⛔ 故意挑**第 4 位**教练 E（不是第一个也不是最后一个）⇒ 只认 [0] 的实现会失败。
    const picked = E
    world.setOpenId(MEMBER_OPEN)
    const result = await world.main()({
      action: 'memberBooking', command: 'createMemberBooking', requestId: 'mbk_n_choose_e', environment: ENV,
      payload: {
        coachKey: coachKeyOf(picked.owner),
        packageViewId: packageViewIdOf(claimId, PKG),
        date: dayOffset(5), hour: 11, minute: 0
      }
    })
    assert.strictEqual(result.ok, true, `会员选 E 约课失败：${result.code} ${result.message || ''}`)
    const rows = bookingsOf(picked)
    assert.strictEqual(rows.length, 1, '这一节必须落在 E 的账上')
    const booking = rows[0].data || {}
    assert.strictEqual(booking.teachingCoachId, picked.owner, '授课教练必须是会员选的那一位')
    // 其余 4 位教练账里**没有**这条预约
    for (const coach of [B, C, D, F]) {
      assert.strictEqual(bookingsOf(coach).length, 0, `${coach.publicCode} 账里不该多出预约`)
    }
  })

  await runner('⑩ 会员不能约第 6 位里那位**被撤销**的教练（撤销后与教练端同一个码）', async () => {
    setup()
    await grantTeaching(A, CODES)
    await revokeTeaching(A, E.publicCode)
    memberBooking.setPolicy(memberBooking.POLICY_DIRECT)
    const claimId = memberBooking.fixedId(CLAIMS, A.owner, STUDENT)
    world.setOpenId(MEMBER_OPEN)
    const result = await world.main()({
      action: 'memberBooking', command: 'createMemberBooking', requestId: 'mbk_n_revoked', environment: ENV,
      payload: { coachKey: coachKeyOf(E.owner), packageViewId: packageViewIdOf(claimId, PKG), date: dayOffset(6), hour: 11, minute: 0 }
    })
    assert.strictEqual(result.ok, false, '被撤销的教练不能约')
    assert.strictEqual(result.code, 'PACKAGE_TEACHING_NOT_AUTHORIZED', `必须与教练端同码，实际 ${result.code}`)
    assert.strictEqual(world.rows('bookings', E.owner, E.datasetId).length, 0, '零写入')
  })

  await runner('⑪ 生产代码里没有"双教练"假设（静态扫描云函数与 utils，注释不算）', async () => {
    // ⛔ 只盯**真的会把人数钉死在两位**的写法：具名角色、写死的下标、"另一位/对面那位"这种
    //    单数假设。（`otherCoach` 这种循环里的局部变量名不算 —— 它遍历的是 N 位，不是固定两个人。）
    const patterns = [
      /coachA\b/, /coachB\b/, /coachC\b/,
      /教练\s*A\b/, /教练\s*B\b/, /教练A/, /教练B/,
      /coaches\[1\]/, /grants\[1\]/, /owners\[1\]/, /members\[1\]/,
      /twoCoach/i, /secondCoach\b/, /firstCoach\b/
    ]
    const files = []
    const scan = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { if (!['node_modules', 'test'].includes(entry.name)) scan(full); continue }
        if (/\.js$/.test(entry.name)) files.push(full)
      }
    }
    scan(path.join(ROOT, 'cloudfunctions'))
    for (const name of fs.readdirSync(path.join(ROOT, 'utils'))) {
      if (/\.js$/.test(name)) files.push(path.join(ROOT, 'utils', name))
    }
    const offenders = []
    for (const file of files) {
      if (file.includes('tests')) continue
      const source = stripComments(fs.readFileSync(file, 'utf8'))
      for (const pattern of patterns) {
        if (pattern.test(source)) offenders.push(`${path.relative(ROOT, file).replace(/\\/g, '/')} :: ${pattern}`)
      }
    }
    assert.deepEqual(offenders, [], `生产代码里出现了双教练假设：\n${offenders.join('\n')}`)
  })

  await runner('⑫ 授权行的 ID 由 (账本, 课包, 教练) 三者共同决定 ⇒ 第 N 位不会撞车', async () => {
    setup()
    await grantTeaching(A, CODES)
    const ids = grantRows().map(row => authorization.packageGrantId({ ownerCoachId: A.owner, datasetId: A.datasetId }, PKG, row.coachId))
    assert.strictEqual(new Set(ids).size, 5, '5 位教练的授权行 ID 必须两两不同')
    const memberIds = memberRows().map(row => authorization.memberAuthId({ ownerCoachId: A.owner, datasetId: A.datasetId }, STUDENT, row.coachId))
    assert.strictEqual(new Set(memberIds).size, 5, '会员级关系 ID 也必须两两不同')
    // 同一位教练重复授予 ⇒ 幂等（还是那一行，不是多出第二行）
    await grantTeaching(A, [B.publicCode])
    assert.strictEqual(grantRows().length, 5, '重复授予同一位教练不许多出授权行')
  })

  await runner('⑬ 每位教练只看到自己该看到的：B 的目录里只有自己被授权的那位会员', async () => {
    setup()
    await grantTeaching(A, [B.publicCode, C.publicCode])
    const directory = await world.readDirectory(B)
    assert.strictEqual(directory.ok, true)
    assert.strictEqual(directory.serving.length, 1, 'B 只应看到 1 位被授权的会员')
    assert.strictEqual(directory.serving[0].studentId, STUDENT)
    // 未授权的 F 什么都看不到
    const empty = await world.readDirectory(F)
    assert.strictEqual(empty.serving.length, 0, '没被授权的教练不该看到这位会员')
  })
}

main().then(() => {
  process.stdout.write(`\nN-COACH OK · ${world.rows ? 'ok' : 'ok'}\n`)
}, error => {
  process.stderr.write(`FATAL ${error.stack}\n`)
  process.exitCode = 1
})
