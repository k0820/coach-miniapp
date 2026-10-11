// M2 V1 正式多教练服务模型：**双层授课权限**（2026-09-28）。
//
// ★★ 一句话模型（写给下一个改这个文件的人）★★
//   一个真实会员只有**一个可信会员身份**；会员不属于任何教练；课时事实属于会员本人。
//   教练与会员之间只有**授权关系**，没有归属关系。授权分两层，**两层都成立才能排课**：
//     ① 会员级服务关系（member）：这位教练可以在「我的学员」里看到这位会员；
//     ② 课包级授课授权（package）：这位教练可以用**这一份具体课包**创建预约。
//   ⚠️ 课程类型**绝不**作为权限判据：两份「常规训练」可以有完全不同的授课教练名单。
//   ⚠️ 授权**不复制任何数据**：不复制学生档案、不复制课时包、不产生第二套余额。
//      被授权教练看到的是**同一个 studentId / 同一个 packageId / 同一份 remaining-reserved-used**。
//
// ★★ 为什么授权记录放在**全局元集合**（不进八个业务集合）★★
//   · 授权是「关系」，不是业务事实 ⇒ 不能进业务集合，否则会污染 checksum / 指纹 / 增量（那八项是冻结区）。
//   · 授权必须能**按 coachId 反查**（"我能服务谁"），业务集合一律按 (ownerCoachId, datasetId) 隔离，做不到。
//   · 与共享码（sharing.js）同层级：**只有本文件这一道窄门**能读写它。
//
// ★★ 旧数据零迁移★★
//   没有任何授权记录 = 没有任何跨教练关系 ⇒ 所有既有流程**逐字不变**（自己账里的学员与课包本来就归自己）。
//   唯一的写入时机是「教练显式授权」或「创建销售时勾选可授课教练」⇒ 不需要批量 Migration。

const { fixedId, one, put, environmentOf } = require('./core')

// 两张授权表 + 一张教练公开身份表（教练目录复用 M1 已落地的 member profiles，不新建第二套身份）。
// ⭐ 会员身份**不在这里定义**：可信会员身份是 M1 已落地的 `memberId = sha(member:<openid>)`，
//   通过会员域的认领表关联到「某本账里的某条学员记录」。
//   本文件只在授权行上**记下** memberId（有就记，没有就留空），**绝不**反过来用姓名/手机号去"认人"。
//   ⇒ 两位教练账里同名同号的「小蓝」是两条独立档案（不同的 studentId），本模型不会自动合并它们。
// ⛔⛔ 沙盒副本：正式区那一支**整条删除**。原版是一张 production / sandbox 二选一的表，
//    由 `environmentOf` 挑 —— 那把"挑错就落到正式区"的开关留在了代码里。本副本只留沙盒这一支，
//    `collectionsFor()` 也**不靠入参挑选**（只用它做环境合法性判定）。
//    ⚠️ 沙盒侧的值必须与正式区那份 `AUTH_COLLECTIONS.sandbox` **逐字一致**：
//       `tests/sandbox-cloud-isolation.test.js` 会两份比对，改一边忘另一边立刻变红。
//    ⚠️ profiles / claims 是会员域已有的集合，教练端**只读**它们，绝不另建一套教练身份。
const AUTH_COLLECTIONS = Object.freeze({
  sandbox: Object.freeze({ member: 'coach_sandbox_member_authorizations', package: 'coach_sandbox_package_grants', profiles: 'member_sandbox_coach_profiles', claims: 'member_sandbox_student_claims' })
})

const STATUS_ACTIVE = 'active'
const STATUS_REVOKED = 'revoked'
const SOURCE_EXPLICIT = 'explicit'                // 教练显式授予的会员级关系
const SOURCE_PACKAGE_DERIVED = 'package-derived'  // 授予课包权限时自动补的会员级关系

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const commandError = (code, message, extra = {}) => Object.assign(new Error(message), { commandCode: code, extra })
const dataOf = row => row && row.data && typeof row.data === 'object' ? row.data : {}

// ⛔ 沙盒副本：**永远**返回沙盒那一支。`environment` 只用于**合法性判定**
//    （非 sandbox ⇒ `environmentOf` 直接抛），⛔ 绝不参与"选哪一支"。
function collectionsFor(environment) {
  environmentOf(environment)
  return AUTH_COLLECTIONS.sandbox
}
function memberAuthId(place, studentId, coachId) {
  return fixedId('coach-member-authorization', place.ownerCoachId, `${place.datasetId}:${studentId}:${coachId}`)
}
function packageGrantId(place, packageId, coachId) {
  return fixedId('coach-package-grant', place.ownerCoachId, `${place.datasetId}:${packageId}:${coachId}`)
}

async function listWhere(scope, name, query, limit = 200) {
  const response = await scope.collection(name).where(query).limit(limit).get()
  return (response && response.data || []).map(clone)
}

// 授权门面：**业务 handler 唯一能碰授权表的入口**（由 core.execute 在事务内构造并注入 context）。
function authScope(scope, environment) {
  const names = collectionsFor(environment), resolved = environmentOf(environment)
  // ⛔ 沙盒副本：head 集合名 / kind 直接钉死在沙盒那一支（原版这里是一个按环境选的三元表达式）。
  const headName = 'coach_sandbox_heads'
  const headKind = 'coach-sandbox-head'
  return {
    scope, names, environment: resolved,
    async findMember(place, studentId, coachId) {
      return one(scope, names.member, { _id: memberAuthId(place, studentId, coachId), coachId, studentId })
    },
    async findGrant(place, packageId, coachId) {
      return one(scope, names.package, { _id: packageGrantId(place, packageId, coachId), coachId, packageId })
    },
    // 「这位教练被授权了哪些」—— V1 的上限就是**查询维度本身**：按 coachId + status 反查。
    // ⚠️ 真机规模变大时这两张表必须建 (coachId, status) 复合索引；本文件不负责建索引。
    async grantsForCoach(coachId, kind) {
      return listWhere(scope, kind === 'package' ? names.package : names.member, { coachId, status: STATUS_ACTIVE })
    },
    async grantsOnPackage(place, packageId) {
      return listWhere(scope, names.package, { ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, packageId })
    },
    async writeMember(row) {
      const id = memberAuthId({ ownerCoachId: row.ownerCoachId, datasetId: row.datasetId }, row.studentId, row.coachId)
      await put(scope, names.member, id, clone(row))
      return clone(row)
    },
    async writeGrant(row) {
      const id = packageGrantId({ ownerCoachId: row.ownerCoachId, datasetId: row.datasetId }, row.packageId, row.coachId)
      await put(scope, names.package, id, clone(row))
      return clone(row)
    },
    // —— 教练目录：公开码 → 真实 coachId（客户端永远不许提交 coachId）——
    async findProfileByCode(publicCode) {
      return one(scope, names.profiles, { publicCode, discoverable: true })
    },
    // 「这条学员记录被哪个可信会员认领过」—— 有就记下 memberId，没有就留空（绝不猜人）。
    async findClaim(coachId, studentId) {
      return one(scope, names.claims, { coachId, studentId })
    },
    async profileOf(coachId) {
      return one(scope, names.profiles, { coachId })
    },
    async activePlaceOf(coachId) {
      const head = resolved === 'sandbox'
        ? await one(scope, headName, { _id: fixedId(headKind, coachId), ownerCoachId: coachId, environment: 'sandbox' })
        : await one(scope, headName, { _id: fixedId(headKind, coachId), ownerCoachId: coachId })
      return head && head.activeDatasetId ? { ownerCoachId: coachId, datasetId: head.activeDatasetId } : null
    }
  }
}

// ------------------------------------------------------------------ 教练目录翻译
async function coachIdsByPublicCodes(auths, codes) {
  const list = Array.isArray(codes) ? codes : []
  const cleaned = [...new Set(list.map(code => String(code == null ? '' : code).trim()).filter(Boolean))]
  if (!cleaned.length) return []
  const out = []
  for (const publicCode of cleaned) {
    const profile = await auths.findProfileByCode(publicCode)
    if (!profile || !profile.coachId) throw commandError('COACH_PUBLIC_CODE_NOT_FOUND', `没有找到公开码对应的教练：${publicCode}`)
    out.push({ publicCode, coachId: profile.coachId, displayName: profile.displayName || '教练' })
  }
  return out
}
async function coachLabel(auths, coachId) {
  if (!coachId) return { coachId: '', displayName: '', publicCode: '' }
  const profile = await auths.profileOf(coachId)
  return { coachId, displayName: profile && profile.displayName ? profile.displayName : '教练', publicCode: profile && profile.publicCode ? profile.publicCode : '' }
}

// ------------------------------------------------------------------ 两层判定
//
// ⭐ 账本所有者（place owner）**永远**拥有该账本里自己学员与课包的全部权限 —— 不需要任何授权记录。
//    这一条是"旧数据零迁移"的支点：老账本里没有授权行，老流程照旧。
function isPlaceOwner(place, coachId) {
  return !!place && !!coachId && place.ownerCoachId === coachId
}

async function canServeMember(auths, place, studentId, coachId) {
  if (!place || !studentId || !coachId) return false
  if (isPlaceOwner(place, coachId)) return true
  const row = await auths.findMember(place, studentId, coachId)
  return !!row && row.status === STATUS_ACTIVE
}
async function canTeachPackage(auths, place, packageId, coachId) {
  if (!place || !packageId || !coachId) return false
  if (isPlaceOwner(place, coachId)) return true
  const row = await auths.findGrant(place, packageId, coachId)
  return !!row && row.status === STATUS_ACTIVE
}

// ⭐ 排课的唯一权限闸：**两层都要过**，缺哪层报哪个码（前端要能分得清，不许合成一个"没权限"）。
async function assertMayBook(auths, place, studentId, packageId, coachId) {
  if (!(await canServeMember(auths, place, studentId, coachId))) {
    throw commandError('MEMBER_SERVICE_NOT_AUTHORIZED', '你还没有这位会员的服务授权，请先让管理该会员的教练授予服务关系。')
  }
  if (!(await canTeachPackage(auths, place, packageId, coachId))) {
    throw commandError('PACKAGE_TEACHING_NOT_AUTHORIZED', '你没有这份课时包的授课授权，不能用它排课。')
  }
}

// 权限管理人：课包所有者 或 授权行上 canManage=true 的教练。
async function canManagePackage(auths, place, packageId, coachId) {
  if (isPlaceOwner(place, coachId)) return true
  const row = await auths.findGrant(place, packageId, coachId)
  return !!row && row.status === STATUS_ACTIVE && row.canManage === true
}
async function assertCanManagePackage(auths, place, packageId, coachId) {
  if (!(await canManagePackage(auths, place, packageId, coachId))) {
    throw commandError('PACKAGE_MANAGE_NOT_AUTHORIZED', '只有该课时包的权限管理人可以修改授课教练名单或指定接管人。')
  }
}

// ------------------------------------------------------------------ 排课时「这份课包物理在哪本账」
//
// 客户端只提交 (studentId, packageId)。位置**只能**由服务端从授权记录推导：
//   ① 自己这本账里有 → 就是自己（老流程，不需要授权行）；
//   ② 否则查「我被授权了这份 packageId」的那条授权行 → 行里带着 (ownerCoachId, datasetId)。
// ⇒ 客户端永远无法指定别人的账本（与共享码同形的安全边界）。
async function resolveBookingPlace({ auths, business, context, studentId, packageId, coachId }) {
  const own = await business.collection('packages').get(packageId)
  if (own) return { place: { ownerCoachId: business.ownerCoachId, datasetId: business.datasetId }, shared: false, packageRow: own }
  const grants = (await auths.grantsForCoach(coachId, 'package')).filter(row => row.packageId === packageId)
  if (!grants.length) throw commandError('PACKAGE_TEACHING_NOT_AUTHORIZED', '这份课时包不存在，或你没有它的授课授权。')
  if (grants.length > 1) throw commandError('PACKAGE_GRANT_AMBIGUOUS', '这份课时包存在多条有效授权，请让权限管理人整理后重试。')
  const grant = grants[0], place = { ownerCoachId: grant.ownerCoachId, datasetId: grant.datasetId }
  if (grant.studentId && studentId && grant.studentId !== studentId) throw commandError('PACKAGE_STUDENT_MISMATCH', '这份课时包不属于该会员。')
  if (!context || typeof context.businessAt !== 'function') throw commandError('COMMAND_TRANSACTION_FAILED', '当前执行环境不支持跨教练排课。')
  const space = context.businessAt(place.ownerCoachId, place.datasetId)
  const packageRow = await space.collection('packages').get(packageId)
  if (!packageRow) throw commandError('PACKAGE_NOT_FOUND', '这份课时包已不存在，不能排课。')
  return { place, shared: true, packageRow, grant }
}

// ------------------------------------------------------------------ 「这位会员的预约可能散落在哪几本账」
//
// 与 sharing.redeemerPlacesOf 同思想：**只从服务端已知事实推导**，不接受客户端输入。
//   已知事实 = ① 课时包物理所在账 ② 该课包授权给了哪些教练 ③ 该会员的会员级关系给了哪些教练
//   ⇒ 每一位的活跃数据集都要查一遍会员时间冲突。
// ⚠️ 已知边界（如实写）：某位教练既没有课包授权也没有会员级关系，却给这位会员上过课
//    （历史遗留），那本账不在此列 —— 与共享码路径同一条边界，不假装覆盖。
async function knownMemberPlaces({ auths, place, studentId, packageId }) {
  const coaches = new Set()
  if (place && place.ownerCoachId) coaches.add(place.ownerCoachId)
  const grants = await listWhere(auths.scope, auths.names.package, { ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, packageId, status: STATUS_ACTIVE })
  grants.forEach(row => { if (row.coachId) coaches.add(row.coachId) })
  const memberAuths = await listWhere(auths.scope, auths.names.member, { ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId, status: STATUS_ACTIVE })
  memberAuths.forEach(row => { if (row.coachId) coaches.add(row.coachId) })
  const seen = new Set(), out = []
  for (const coachId of coaches) {
    const target = await auths.activePlaceOf(coachId)
    if (!target) continue
    const key = `${target.ownerCoachId}::${target.datasetId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(target)
  }
  return out
}

// ------------------------------------------------------------------ 移除教练前的冲突检查
//
// ⛔ 铁律：**绝不静默移除**。只要这位教练在这份课包上还有「未完成预约」，就拒绝并如实报出来。
//    放行会造成"课还在、但授课教练已无权处理"的死局；静默取消/改派更是篡改事实。
async function futureBookingsOfCoach({ auths, context, packageId, coachId }) {
  const target = await auths.activePlaceOf(coachId)
  if (!target || !context || typeof context.businessAt !== 'function') return []
  const rows = await context.businessAt(coachId, target.datasetId).collection('bookings').list({})
  return rows.filter(row => {
    const booking = dataOf(row)
    if (booking.status !== 'booked') return false
    if (packageId && booking.packageId !== packageId) return false
    const usage = booking.packageUsage
    return !!usage && usage.packageId === packageId
  }).map(row => {
    const booking = dataOf(row)
    return { bookingId: row.bookingId || booking.id, date: booking.date, hour: booking.hour, minute: booking.minute || 0 }
  })
}

// ------------------------------------------------------------------ 只读目录（教练端「授权给我服务的会员」）
//
// ⛔ 隐私红线（一条都不能越）：
//   · 不返回 `notes` / `coachPrivateNotes` / `privateNotes` / `internalNotes` —— 私人备注永不外泄；
//   · 不返回**现有** `summary` —— 它是 `rebuildSummary` 生成的教练内部口径（含"备注：…"行），
//     给别的教练看等同于泄漏上一位教练的私人备注。V1 只读**明确的共享字段** `memberSummary`
//     （当前无人写入 ⇒ 恒为空 ⇒ 零泄漏）。写入入口留待 M3「课程总结」统一设计；
//   · 不返回其他教练的销售业绩明细（amount / unitPrice / saleId）；
//   · 不返回其他教练的收入与提成（booking.price 与 incomes 一律不投影）。
const SHARED_BOOKING_FIELDS = Object.freeze(['bookingId', 'date', 'hour', 'minute', 'typeName', 'category', 'items', 'duration', 'memberSummary', 'teachingCoachId', 'status', 'packageId'])
const MEMBER_PACKAGE_FIELDS = Object.freeze(['packageId', 'type', 'total', 'remaining', 'used', 'reserved', 'availableToBook', 'saleDate', 'status'])
const DIRECTORY_LIMITS = Object.freeze({ members: 50, packagesPerMember: 50, bookingsPerMember: 100, history: 30 })
// ⭐ 目录响应的**版本水印**（2026-09-28 真机二次失败）：客户端把它直接显示出来 ⇒
//   「云函数到底有没有更新到这一版」不需要翻日志，看页面上那一行就知道。
//   ⚠️ 云函数与客户端是两份代码、不能共享常量 ⇒ 两边各写一份同名常量，改形状时**两边都要 +1**。
const DIRECTORY_SHAPE = 'm2-dir-2'

function pickFields(source, fields) {
  const out = {}
  fields.forEach(key => { if (source[key] !== undefined) out[key] = clone(source[key]) })
  return out
}

async function readDirectory({ db, ownerCoachId, environment }) {
  const auths = authScope(db, environment)
  const [memberAuths, packageGrants] = await Promise.all([
    auths.grantsForCoach(ownerCoachId, 'member'),
    auths.grantsForCoach(ownerCoachId, 'package')
  ])
  const grantsByMember = new Map()
  packageGrants.forEach(grant => {
    const key = `${grant.ownerCoachId}::${grant.datasetId}::${grant.studentId}`
    if (!grantsByMember.has(key)) grantsByMember.set(key, [])
    grantsByMember.get(key).push(grant)
  })
  const serving = []
  let truncated = memberAuths.length > DIRECTORY_LIMITS.members
  // ⛔ 静默 = 事故放大器：被丢掉的课包必须**报个数**（只报数量，不报任何身份信息）。
  //   恒为 0 才是正常；非 0 说明有课包拿不到真实 ID，客户端一侧必须看得见。
  let droppedPackages = 0
  for (const auth of memberAuths.slice(0, DIRECTORY_LIMITS.members)) {
    const place = { ownerCoachId: auth.ownerCoachId, datasetId: auth.datasetId }
    const studentRow = await firstWhere(db, 'students', { ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId: auth.studentId })
    if (!studentRow) continue
    const student = dataOf(studentRow)
    const grants = grantsByMember.get(`${place.ownerCoachId}::${place.datasetId}::${auth.studentId}`) || []
    const packages = []
    if (grants.length > DIRECTORY_LIMITS.packagesPerMember) truncated = true
    for (const grant of grants.slice(0, DIRECTORY_LIMITS.packagesPerMember)) {
      const packageRow = await firstWhere(db, 'packages', { ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, packageId: grant.packageId })
      if (!packageRow) continue
      const pkg = dataOf(packageRow), reserved = Number.isInteger(Number(pkg.reserved)) ? Number(pkg.reserved) : 0
      // ⭐ 授权出去的每一个课包标识都必须是**真实 ID**（2026-09-28 真机 BUG 03 的原位修复）：
      //   课时包文档是两层 —— row 层有 `packageId`，data 层里这个字段叫 `id`。
      //   投影的是 data 层 ⇒ 不显式带上 row 层的 packageId，客户端就拿不到任何可用 ID，
      //   排课时只能提交空值 ⇒ 云端「packageId不能为空」。
      const projected = pickFields({ ...pkg, packageId: packageRow.packageId, reserved, availableToBook: Math.max(Number(pkg.remaining || 0) - reserved, 0) }, MEMBER_PACKAGE_FIELDS)
      // ⛔ 投影不出真实 ID 就**绝不**下发一个没有标识的课包（那等于逼客户端去猜）。
      //    丢掉的份数记进 droppedPackages，让"云端丢过东西"变成一个看得见的数字。
      if (!projected.packageId) { droppedPackages += 1; continue }
      packages.push({ ...projected, canManage: grant.canManage === true, place })
    }
    const bookings = await bookingsForMember(db, auths, place, auth.studentId, ownerCoachId)
    if (bookings.truncated) truncated = true
    serving.push({
      studentId: auth.studentId, memberId: auth.memberId || '', name: student.name || '会员', phone: student.phone || '',
      place, managedByMe: grants.some(grant => grant.canManage === true),
      packages, upcoming: bookings.upcoming, history: bookings.history
    })
  }
  // 「我管理着的课包」：权限管理视图（新增 / 移除 / 指定接管人）的数据来源。
  const managed = []
  for (const grant of packageGrants.filter(row => row.canManage === true)) {
    const place = { ownerCoachId: grant.ownerCoachId, datasetId: grant.datasetId }
    const packageRow = await firstWhere(db, 'packages', { ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, packageId: grant.packageId })
    if (!packageRow) continue
    const pkg = dataOf(packageRow)
    const all = await auths.grantsOnPackage(place, grant.packageId)
    const coaches = []
    for (const row of all.filter(item => item.status === STATUS_ACTIVE)) {
      const label = await coachLabel(auths, row.coachId)
      coaches.push({ coachId: row.coachId, displayName: label.displayName, publicCode: label.publicCode, canManage: row.canManage === true })
    }
    const studentRow = await firstWhere(db, 'students', { ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId: grant.studentId })
    managed.push({
      place, packageId: grant.packageId, studentId: grant.studentId,
      studentName: studentRow ? dataOf(studentRow).name || '会员' : '会员',
      type: pkg.type || '', coaches
    })
  }
  return { ok: true, readOnly: true, environment: auths.environment, coachId: ownerCoachId, serving, managed, truncated, shape: DIRECTORY_SHAPE, droppedPackages }
}

async function firstWhere(scope, name, query) {
  const response = await scope.collection(name).where(query).limit(1).get()
  return (response && response.data || [])[0] || null
}

async function bookingsForMember(db, auths, place, studentId, coachId) {
  const raw = await listWhere(db, 'bookings', { ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId }, DIRECTORY_LIMITS.bookingsPerMember)
  let upcoming = [], history = []
  for (const row of raw) {
    const booking = dataOf(row)
    if (!booking || !booking.date) continue
    const shared = pickFields({ ...booking, bookingId: row.bookingId || booking.id, teachingCoachId: booking.teachingCoachId || place.ownerCoachId }, SHARED_BOOKING_FIELDS)
    if (booking.status === 'booked') upcoming.push({ ...shared, place })
    else if (booking.status === 'done') history.push({ ...shared, place })
  }
  // 我自己这本账里也可能有给这位会员上的课（预约文档落在**授课教练**那本账上）。
  const ownPlace = await auths.activePlaceOf(coachId)
  if (ownPlace && !(ownPlace.ownerCoachId === place.ownerCoachId && ownPlace.datasetId === place.datasetId)) {
    const mine = await listWhere(db, 'bookings', { ownerCoachId: coachId, datasetId: ownPlace.datasetId, studentId }, DIRECTORY_LIMITS.bookingsPerMember)
    for (const row of mine) {
      const booking = dataOf(row)
      if (!booking || !booking.date) continue
      const shared = pickFields({ ...booking, bookingId: row.bookingId || booking.id, teachingCoachId: booking.teachingCoachId || coachId }, SHARED_BOOKING_FIELDS)
      if (booking.status === 'booked') upcoming.push({ ...shared, place: ownPlace })
      else if (booking.status === 'done') history.push({ ...shared, place: ownPlace })
    }
  }
  upcoming = upcoming.sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.hour) - Number(b.hour))
  history = history.sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.hour) - Number(a.hour)).slice(0, DIRECTORY_LIMITS.history)
  return { upcoming, history, truncated: raw.length >= DIRECTORY_LIMITS.bookingsPerMember }
}

module.exports = {
  AUTH_COLLECTIONS, STATUS_ACTIVE, STATUS_REVOKED, SOURCE_EXPLICIT, SOURCE_PACKAGE_DERIVED,
  SHARED_BOOKING_FIELDS, MEMBER_PACKAGE_FIELDS, DIRECTORY_LIMITS, DIRECTORY_SHAPE,
  collectionsFor, authScope, memberAuthId, packageGrantId,
  coachIdsByPublicCodes, coachLabel, isPlaceOwner,
  canServeMember, canTeachPackage, assertMayBook, canManagePackage, assertCanManagePackage,
  resolveBookingPlace, futureBookingsOfCoach, knownMemberPlaces, readDirectory
}
