const crypto = require('crypto')
// ⭐⭐ 会员域权威契约（孪生副本，与 `memberIdentityCommand/member-contract.js` 逐字节相同，
//   由 tests/member-archive-contract.test.js 钉死）。集合名 / 档案视图 ID 算法**只允许有一个出处**。
const contract = require('./member-read-contract')

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const memberIdFor = openId => sha(`member:${openId}`).slice(0, 32)
const fixedId = (...parts) => sha(parts.join(':')).slice(0, 32)
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const FORBIDDEN = new Set(['OPENID', 'openId', 'openid', '_openid', 'memberId', 'studentId', 'coachId', 'ownerCoachId', 'datasetId', 'documentId'])

// ⛔ 旧实现在这里**另抄了一份**集合名，而且字段比 memberIdentityCommand 那份少（没有 tokens / receipts）
//    —— 这就是"集合名漂移"的活标本：假 DB 里两边都建了同名集合，测试全绿；真机上某一趟
//    查的是另一个环境/另一个名字，于是永远查不到。现在统一走契约。
function names(environment) { return contract.memberNames(environment) }
function forbiddenPath(value, path = 'event') {
  if (!value || typeof value !== 'object') return ''
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key)) return `${path}.${key}`
    const nested = forbiddenPath(value[key], `${path}.${key}`)
    if (nested) return nested
  }
  return ''
}
// ⭐ M3-P1 性能：云函数端单次 `limit` 上限是 1000。用 200 而不是 100 是为了**少跑几趟** ——
//   一本账 800 条预约：100/页 = 8 趟往返，200/页 = 4 趟。真机上"往返次数"几乎就是延迟本身。
//   ⛔ 别调到 1000：单页传输时间会顶上来，而且这是"先全下完再在内存里筛"，不是流式。
const PAGE_SIZE = 200
async function all(scope, name, query) {
  const found = []
  for (let skip = 0; ; skip += PAGE_SIZE) {
    const response = await scope.collection(name).where(query).skip(skip).limit(PAGE_SIZE).get(), page = response && response.data || []
    found.push(...page)
    if (page.length < PAGE_SIZE) return found
  }
}
async function one(scope, name, query) { return (await all(scope, name, query))[0] || null }
// ⭐ 2026-10-07（1.3.36）：这一条算法必须与 `member-directory.publicCardOf` 的 `contactKey` **逐字一致**。
//   它用于把「首页教练卡」与「约课页教练列表」对上是同一位教练 —— 两边算法不同 ⇒ 会员在首页点了
//   A 教练跳进约课页，却选不中 A（真机表现："点了教练没反应 / 默认又跳回第一个"）。
//   ⛔ `coachKey`（`member-coach-view`）继续用于**提交**（写路径认它），`contactKey` 只用于**跨页认人**，两者不互相顶替。
const coachContactKey = coachId => fixedId('member-contact-view', 'coach', coachId)
function publicCoach(row) {
  const base = { coachKey: fixedId('member-coach-view', row.coachId), displayName: row.displayName || '教练', avatar: row.avatar || '', specialties: Array.isArray(row.specialties) ? row.specialties : [], introduction: row.introduction || '' }
  return row.coachId ? { ...base, contactKey: coachContactKey(row.coachId) } : base
}
function publicItem(item) {
  return { name: String(item && item.name || ''), group: String(item && item.group || ''), sets: item && item.sets == null ? '' : item.sets, reps: item && item.reps == null ? '' : item.reps, weight: item && item.weight == null ? '' : item.weight, minutes: item && item.minutes == null ? '' : item.minutes }
}
// ⭐ 教练端**私有**内容：永远不得出现在会员视图里（M2 业务模型校正）。
//   `sanitizeBooking` 是**白名单**投影 ⇒ 这里列出的字段天然出不去；列出来是为了让测试能咬住它。
const PRIVATE_BOOKING_FIELDS = Object.freeze(['notes', 'coachPrivateNotes', 'privateNotes', 'internalNotes', 'price', 'teachingCoachId', 'source', 'createdByCoachId', 'createdByMemberId', 'packageUsage'])

// ⭐ 同一条预约 = 授课教练课表里的课程 = 会员日程里的课程（**绝不复制成第二份**）。
//   这位会员的预约可能落在**多位教练**的账里（谁上这节课，课就记在谁的课表里）。
//   所以除了「已认领教练」那本账，还要找出**其他账本里同一位学员**的预约 —— 读的是同一条数据，不是副本。
//   ⚠️ 环境隔离：只接受 datasetId 能在本环境 head 表里查到的账本 ⇒ Sandbox 与正式区绝不互相串。
// ⭐ M3-P1 性能订正（三处都是"白跑的往返"）：
//   ① `studentRows` 允许**外部传入** —— 调用方刚刚已经查过一份一模一样的 `bookings({studentId})`，
//      旧代码在这里又查了一遍（同一份数据、同一本账，重复往返）。
//   ② head 查询**按 `ownerCoachId:datasetId` 去重**：同一位教练有多条预约时只查一次
//      （旧代码是逐行 N 次 ⇒ N+1）。
//   ③ 去重后的 head 查询**并发**发出（旧代码串行 awaiting）。
//   ⛔ 筛选语义一个字没变：仍然是"这个账本必须在本环境的 head 表里存在"，否则这条预约不算数。
async function foreignBookingRows(db, n, claim, head, studentRows) {
  const rows = Array.isArray(studentRows) ? studentRows : await all(db, 'bookings', { studentId: claim.studentId })
  const wanted = rows.filter(row => !(row.ownerCoachId === claim.coachId && row.datasetId === head.activeDatasetId))
  const keys = [...new Set(wanted.map(row => `${row.ownerCoachId}\u0000${row.datasetId}`))]
  const found = await Promise.all(keys.map(key => {
    const [ownerCoachId, datasetId] = key.split('\u0000')
    const query = n.environment === 'sandbox'
      ? { ownerCoachId, environment: 'sandbox', activeDatasetId: datasetId }
      : { ownerCoachId, activeDatasetId: datasetId }
    return one(db, n.coachHeads, query)
  }))
  const allowed = new Set(keys.filter((key, index) => !!found[index]))
  return wanted.filter(row => allowed.has(`${row.ownerCoachId}\u0000${row.datasetId}`))
}

// ------------------------------------------------------------------ M3 P1 · 会员「可约时间」只读投影
//
// ⛔ 这一层**只投影，不裁决**：不复制任何冲突/余额规则（那是 coachBusinessCommand 的 occupancy 与
//    assertMayBook 的职责）。这里只回答"这一天的哪些分钟区间已经有人了"，并且**不携带任何学员信息**
//   （不返回 studentId / 姓名 / 手机号 ⇒ 会员看不到"谁占了"，只看得到"这段时间不行"）。
//
// ⛔ 时长缺失时按 60 分钟**保守占位**：宁可把一段其实空着的时间藏起来，也绝不把一个已被占用的时段显示成可约。
const BUSY_FALLBACK_MINUTES = 60
// ═════════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-07（1.3.36 起）· 会员定位的**唯一真相源**
//
// 🔴 本次真机故障的共同根因（必须写在这里，防止以后被"顺手改回去"）：
//    · 会员首页走的是**新会员目录**（`member-directory.readDashboard`），它用会员资料行里
//      **绑定时就锁定的** `ownerCoachId + ownerDatasetId + studentId` 去找真实资料和课时包；
//    · 会员约课页走的是**本文件这条老链路**：先在认领表 `member_sandbox_student_claims` 里
//      找 verified 的认领行，再**动态**去 `coach_sandbox_heads` 猜教练"当前是哪本账"。
//    ⇒ 两条路不是一个真相源。只要 head 那一趟查不到 / 查到多份 / 环境字段不同，
//      老链路就整条退化成空：教练列表空、课时包空、档案空 ⇒ 页面显示"没有课时包""没有可约时间"，
//      而同一个张三在首页明明看得到 10 节和教练。
//
// ⇒ 修法：**定位统一到这里**。新会员方案只在 `member_sandbox_members` 里认一次位置，
//    本文件不再拿 head 表的查询结果当作"这位会员是谁"。
// ⛔ 兼容优先（用户要求第一轮不迁移数据）：旧认领数据**一个都不删**，
//    解析不到新会员资料时**原样退回**旧的 claim + head 定位，老会员照旧工作。
// ═════════════════════════════════════════════════════════════════════════════
const MEMBERS = 'member_sandbox_members'
const MEMBER_ROW_KIND = 'member-directory-member'

async function memberRowOf(db, memberId) {
  const byMemberId = await one(db, MEMBERS, { memberId })
  if (byMemberId) return byMemberId
  return await one(db, MEMBERS, { _id: fixedId(MEMBER_ROW_KIND, memberId) })
}

// ⭐ 把"这位会员在哪"解析成一个可以直接用的组合。
//   ⛔ 三个字段缺任何一个都不算找到了 —— 缺一个就退回老链路，
//      ⛔ 绝不拿"两个字段推第三个"（那正是以前会长出第二套真相的地方）。
async function resolveMemberPlace(db, memberId) {
  const member = await memberRowOf(db, memberId)
  if (!member) return null
  const ownerCoachId = String(member.ownerCoachId || '')
  const datasetId = String(member.ownerDatasetId || '')
  const studentId = String(member.studentId || '')
  if (!ownerCoachId || !datasetId || !studentId) return null
  // ⛔ claimId 沿用绑定时写好的那个 ⇒ 写路径 `memberBooking.resolveMemberTarget` 能算出同一个不透明 ID。
  return { ownerCoachId, datasetId, studentId, claimId: String(member.claimId || fixedId('member-sandbox-place', memberId)) }
}

// ⭐ 对外只暴露这一个：把「会员 ⇒ 服务关系」一次解析到位。
//   ⛔ 返回的每一项都**自带 datasetId**（新分支因此不再需要查 head 表）；
//      旧兼容分支没有 datasetId ⇒ 下游照旧走 head（一个字节的行为都不变）。
async function memberScopes(db, n, memberId) {
  const place = await resolveMemberPlace(db, memberId)
  if (place) {
    return {
      kind: 'member',
      claims: [{ claimId: place.claimId, memberId, coachId: place.ownerCoachId, studentId: place.studentId, datasetId: place.datasetId }]
    }
  }
  const claims = await all(db, n.claims, { memberId, status: 'verified' })
  return { kind: 'legacy', claims }
}

// →  B 教练也能给这位会员排课的关系来自 M2 授课授权表，
//    ⛔ 与写路径 `memberBooking.resolveMemberTarget` 逐字同口径 —— 读路径放行、写路径才不会拒绝。
function authNames() {
  return {
    member: 'coach_sandbox_member_authorizations',
    package: 'coach_sandbox_package_grants'
  }
}
function minutesOf(row) {
  const data = row && row.data || row || {}
  const hour = Number(data.hour), minute = Number(data.minute || 0)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  return { start: hour * 60 + minute, end: hour * 60 + minute + (Number.isInteger(Number(data.plannedMinutes)) && Number(data.plannedMinutes) > 0 ? Number(data.plannedMinutes) : (Number.isInteger(Number(data.duration)) && Number(data.duration) > 0 ? Number(data.duration) : BUSY_FALLBACK_MINUTES)) }
}
function dateOf(row) {
  const data = row && row.data || row || {}
  return String(data.date || row && row.date || '')
}
async function headOf(db, n, coachId) {
  const query = n.environment === 'sandbox' ? { ownerCoachId: coachId, environment: 'sandbox' } : { ownerCoachId: coachId }
  const heads = await all(db, n.coachHeads, query)
  if (heads.length > 1) return { ambiguous: true, head: null }
  return { ambiguous: false, head: heads[0] || null }
}
async function availabilityView(db, n, claims, profileByCoach, dateKey) {
  const date = String(dateKey || '')
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(date)
  const auth = authNames(n.environment), scopes = [], packages = [], own = [], busy = [], warnings = [], coachKeys = [], bookings = [], archives = []
  const bookingSeen = new Set()
  const seenScope = new Set(), seenCoach = new Set()
  // ⭐ 2026-10-01 真机：会员端出现**两个一模一样**的教练名（管理人与被授权授课的教练同名）
  //   ⇒ 会员不知道该选哪个。缺的是"这位和我的关系是什么"，而这个答案服务端早就有了：
  //     `addScope` 被调用时就明明白白知道这次是"认领的那位"还是"被授权来的那位"。
  // ⛔ 只加 `role` / `codeTail` 两个展示字段，**不加任何一趟数据库查询**（都能从已有数据现算）：
  //     · role     —— `coachId === claim.coachId` ⇒ 管理人；否则是课包授权来的授课教练；
  //     · codeTail —— 教练公开码 `publicCode` 的**尾 4 位**（⛔ 绝不下发完整 id / 主键）。
  // ⛔ 要不要显示尾号由客户端决定（只有同名又同身份时才需要）⇒ 服务端不替它判断。
  const roleByCoach = new Map()
  const COACH_ROLE_TITLE = Object.freeze({ owner: '管理人', teaching: '授课教练' })
  const codeTailOf = row => {
    const code = String((row && row.publicCode) || '').replace(/[^A-Za-z0-9]/g, '')
    return code ? code.slice(-4) : ''
  }
  // ⭐ M3-P1 性能：同一位教练的 head 只查一次（记忆化），去重后的多趟**并发**发出。
  //   旧代码在两处都是串行逐条 `await` ⇒ 延迟是"所有往返之和"而不是"最长的一趟"。
  const headTasks = new Map()
  const headFor = coachId => {
    if (!headTasks.has(coachId)) headTasks.set(coachId, headOf(db, n, coachId))
    return headTasks.get(coachId)
  }
  const addScope = (coachId, datasetId, claim) => {
    const key = `${coachId}:${datasetId}`
    if (!seenScope.has(key)) {
      seenScope.add(key)
      scopes.push({ coachId, datasetId, coachKey: fixedId('member-coach-view', coachId), studentId: claim.studentId })
    }
    const coachKey = fixedId('member-coach-view', coachId)
    // ⭐ 身份在同一个方法里顺手记下（**零额外查询**）：认领的那位 ⇒ 管理人；授权来的 ⇒ 授课教练。
    //   ⛔ 一位教练同时是两种身份时（认领一本账、又被另一本账授权）⇒ **管理人优先**：
    //   那是更强的一层关系（自己的课时在他账里），也是"更像是会员要找的那个人"的那一层。
    const role = String(coachId || '') === String(claim.coachId || '') ? 'owner' : 'teaching'
    const known = roleByCoach.get(coachKey)
    const winner = known === 'owner' || role === 'owner' ? 'owner' : 'teaching'
    roleByCoach.set(coachKey, winner)
    const patch = {
      role: COACH_ROLE_TITLE[winner] || COACH_ROLE_TITLE.teaching,
      roleKey: winner,
      codeTail: codeTailOf(profileByCoach.get(coachId))
    }
    // ⛔ 已经推过这一位（多份档案认到同一个教练）⇒ 回头把身份补上，不推第二条。
    if (seenCoach.has(coachKey)) {
      const existing = coachKeys.find(row => row && row.coachKey === coachKey)
      if (existing) Object.assign(existing, patch)
      return
    }
    seenCoach.add(coachKey)
    // ⛔ 这里的每一位**都**来自"认领关系 + 有效课包授权" ⇒ bookable 恒为 true。
    //   「常用教练 shortcut」**绝不**进这张表（会员自己加的码不构成授权）。
    coachKeys.push(Object.assign({
      coachKey,
      // ⭐ 与首页「我的教练」卡同一个身份串 ⇒ 会员点谁进来就默认选中谁（算法见 `coachContactKey` 注释）。
      contactKey: coachContactKey(coachId),
      displayName: (profileByCoach.get(coachId) || {}).displayName || '教练',
      bookable: true
    }, patch))
  }
  for (const claim of claims) {
    // ⭐⭐ 新会员方案：`claim.datasetId` 是**绑定时就锁定的**那本真实账本 ⇒ 直接采用，
    //   ⛔ 不再去 head 表猜"教练当前是哪本账"（猜不着 ⇒ 整份投影被丢空，就是本次真机故障的形状）。
    //   ⚠️ 只有**旧兼容分支**（这位会员还没进新目录、拿不到新会员资料）才保留原来的 head 查询，
    //      那一条路的行为一个字节都没改。
    let datasetId = String(claim.datasetId || '')
    if (!datasetId) {
      const owner = await headFor(claim.coachId)
      if (owner.ambiguous) { warnings.push({ code: 'COACH_DATASET_HEAD_AMBIGUOUS', claimId: claim.claimId, archiveId: archiveIdOf(claimIdOf(claim)) }); continue }
      if (!owner.head || !owner.head.activeDatasetId) { warnings.push({ code: 'COACH_DATASET_UNAVAILABLE', claimId: claim.claimId, archiveId: archiveIdOf(claimIdOf(claim)) }); continue }
      datasetId = owner.head.activeDatasetId
    }
    addScope(claim.coachId, datasetId, claim)
    // 被授予授课权的其他教练（M2 双层授权的课包级那层）⇒ 会员也可以约他们。
    // ⛔ 2026-10-01 审计修复：**必须带上账本范围** `(ownerCoachId, datasetId)`。
    //    原写法只按 `studentId` 查 ⇒ 会把**别的账本**里同 studentId 的授权也算成"你可以约"，
    //    而写路径 `coachBusinessCommand/memberBooking.resolveMemberTarget` 是**带账本范围**的
    //    ⇒ 读路径放行、写路径拒绝 ⇒ 会员"看得见却约不了"，且等于跨账读别人的授权关系。
    //    ⛔ 与写路径必须逐字同口径，否则就是最难受的那一类故障（界面说能、云端说不能）。
    const grants = await all(db, auth.package, { ownerCoachId: claim.coachId, datasetId, studentId: claim.studentId, status: 'active' })
    const teachingGrants = grants.filter(grant => grant && grant.coachId && grant.coachId !== claim.coachId)
    const teachingHeads = await Promise.all(teachingGrants.map(grant => headFor(grant.coachId)))
    teachingGrants.forEach((grant, index) => {
      const resolved = teachingHeads[index]
      if (!resolved || resolved.ambiguous || !resolved.head || !resolved.head.activeDatasetId) return
      addScope(grant.coachId, resolved.head.activeDatasetId, claim)
    })
    // 课包只在**它所在的那本账**里（M2 授权不复制数据）⇒ 只从认领的那位教练的账里读。
    // ⭐ 学员档案名与课包**互不依赖** ⇒ 并发发出（不增加任何一个网络往返）。
    const [packageRows, studentRow] = await Promise.all([
      all(db, 'packages', { ownerCoachId: claim.coachId, datasetId, studentId: claim.studentId }),
      firstRow(db, 'students', { ownerCoachId: claim.coachId, datasetId, studentId: claim.studentId })
    ])
    const claimCoach = publicCoach(profileByCoach.get(claim.coachId) || { coachId: claim.coachId, displayName: '教练' })
    // ⭐ `sanitizePackage` 是纯函数（不查库）⇒ 直接同步投影，不新增任何一趟数据库往返。
    packageRows.forEach(row => packages.push(sanitizePackage(row, claim, claimCoach, grants)))
    // ⭐ 这份档案自己的剩余课时（与「只统计未作废课包」的口径逐字一致）⇒ 界面按档案分组小计直接用它。
    const claimRemaining = packageRows
      .filter(row => String((row && row.data ? row.data : row).status || '') !== 'reversed')
      .reduce((sum, row) => sum + (Number.isFinite(Number((row && row.data ? row.data : row).remaining)) ? Number((row && row.data ? row.data : row).remaining) : 0), 0)
    archives.push(sanitizeArchive(claimIdOf(claim) || fixedId(n.claims, claim.coachId, claim.studentId), claimCoach, studentRow, claimRemaining, packageRows.length))
    // 会员**自己**的课：可能落在多位教练的账里 ⇒ 跨账读同一条真实数据。
    //   ⭐ M3-P1：这一份 `bookings({studentId})` **只查一次**、两份用途共用
    //   （旧代码在 `foreignBookingRows` 里把一模一样的一趟又跑了一遍 ⇒ 纯白跑的往返）。
    const studentRows = await all(db, 'bookings', { studentId: claim.studentId })
    // ⛔ 这里传的是「当前这本账」的描述对象（`foreignBookingRows` 只用它筛掉本账自己的行）。
    //    新分支没有 head 行，但**语义逐字相同** ⇒ 直接给同一个形状的对象。
    const ownRows = studentRows.concat(await foreignBookingRows(db, n, claim, { activeDatasetId: datasetId }, studentRows))
    for (const row of ownRows) {
      const rowDate = dateOf(row)
      // 会员自己的课：无论哪天都要（「我的预约」要用），按日期筛只影响**占用投影**。
      const bookingCoach = publicCoach(profileByCoach.get(row.ownerCoachId || claim.coachId) || { coachId: row.ownerCoachId || claim.coachId, displayName: '教练' })
      const bookingView = sanitizeBooking(row, claim, bookingCoach)
      const viewId = `${bookingView.historyId}:${rowDate}`
      if (!bookingSeen.has(viewId)) { bookingSeen.add(viewId); bookings.push(bookingView) }
      if (!dated || rowDate !== date) continue
      const span = minutesOf(row)
      if (!span) continue
      own.push({ coachKey: fixedId('member-coach-view', row.ownerCoachId || claim.coachId), start: span.start, end: span.end })
    }
  }
  if (dated) {
    // ⭐ M3-P1：多本账的排课投影**并发**读（旧代码串行 ⇒ 3 位教练就是 3 趟往返相加）。
    //   ⚠️ `Promise.all` 保序 ⇒ 下面按 `scopes` 下标取用，投影顺序与旧版逐字一致。
    const accountRows = await Promise.all(scopes.map(scope => all(db, 'bookings', { ownerCoachId: scope.coachId, datasetId: scope.datasetId })))
    scopes.forEach((scope, index) => {
      for (const row of accountRows[index]) {
        if (dateOf(row) !== date) continue
        // ⛔ 会员自己的课已经在 own 里了，这里只投影**别人**占用的时段。
        if (String(row.studentId || '') === String(scope.studentId || '')) continue
        const span = minutesOf(row)
        if (!span) continue
        busy.push({ coachKey: scope.coachKey, start: span.start, end: span.end })
      }
    })
  }
  return {
    ok: true, availability: true, environment: n.environment, date: dated ? date : '',
    coaches: coachKeys, packages, bookings, own, busy, archives, warnings
  }
}

// M3-P4：状态**如实透传**（⛔ 不许把 cancelled / noshow 折叠成 booked —— 折叠之后
//   「已取消的课不能再次取消」在会员端就永远判不出来，界面上还会把已取消的课当成"待上课"）。
// ⛔ 课包只下发**服务端派生的不透明视图 ID**：真实 packageId 不出网，客户端拿它只能做展示。
function memberBookingStatus(data) {
  const status = String((data && data.status) || '')
  if (status === 'done') return 'done'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'noshow') return 'noshow'
  return 'booked'
}

// ------------------------------------------------------------------ 学员档案（claim）的**只读投影**
//
// ⭐ 2026-10-01 审计落地：一个会员账户**可以**认领多份学员档案（§112-B 模型，既定不改），
//    但界面此前把多份档案的课包 / 预约**混成一个列表**，会员分不清哪份是谁的。
//   ⇒ 这里给每份档案下发一个**服务端派生的不透明** `archiveId`，并把课包 / 预约各自打上它。
//
// ⛔ 不透明：`archiveId = sha('member-archive-view' + claimId)` ⇒ 客户端拿不到 studentId / claimId，
//    也**不可能**拿它去换别人的档案（写路径只认 `packageViewId` / `bookingViewId`，见 memberBooking.js）。
//    ⭐ 算法搬进了 member-contract.js（与写端同一份孪生副本）—— 客户端能算出来的 `archiveId`
//    必须与这里下发的**逐字一致**，否则"解除认领 / 切换档案"会找不到目标。
// ⛔ 只读：本文件不写任何业务集合；`archives` 只是把已经读到的东西换个形状。
// ⛔ 白名单：档案名**只取学员姓名一个字段**；手机 / 备注 / 价格 / 教练私有字段一律不出网。
const ARCHIVE_VIEW_KIND = contract.ARCHIVE_VIEW_KIND
const ARCHIVE_NAME_MAX = contract.ARCHIVE_NAME_MAX
function claimIdOf(claim) { return String((claim && claim.claimId) || '') }
const archiveIdOf = contract.archiveIdOf
function archiveNameOf(studentRow, coachName) {
  const raw = studentRow && studentRow.data ? studentRow.data : studentRow
  const name = String((raw && raw.name) || '').trim()
  if (name) return name.slice(0, ARCHIVE_NAME_MAX)
  return `${String(coachName || '').trim() || '教练'}的学员档案`
}
// ⭐ 学员档案行**只要一条** ⇒ 用 `limit(1)`，绝不走 `all()` 的分页（那会为一行数据跑整页往返）。
function firstRow(scope, name, query) {
  return scope.collection(name).where(query).limit(1).get().then(response => (response && response.data || [])[0] || null)
}
// ⭐ 2026-10-05：归档功能已整体撤回 ⇒ 档案行**不再带**"已结束服务/归档"状态；
//    只要认领还在（`status: 'verified'`），这份档案就照常下发给会员端。
function sanitizeArchive(claimId, coach, studentRow, remaining, packageCount) {
  const remainingValue = Number(remaining), countValue = Number(packageCount)
  return {
    archiveId: archiveIdOf(claimId), name: archiveNameOf(studentRow, coach && coach.displayName),
    coach: coach || null,
    remaining: Number.isFinite(remainingValue) ? remainingValue : 0,
    packageCount: Number.isFinite(countValue) ? countValue : 0
  }
}

// ⭐⭐ 2026-10-06：head 异常（查不到 / 查到多份）时**这份档案仍要显示**，
//   ⛔ 绝不再 `continue` 把它整份悄悄丢掉 —— 旧行为会让会员看到一个"数据已就绪"的空白页
//      （`state` 仍是 `'ready'`，档案却没了），这是把**故障**伪装成**正常**。
//   ⛔ 这份档案**不参与**任何教练 / 课包 / 预约投影 ⇒ 绝不会把别处的教练或课时包混进来。
function degradedArchive(claimId, code) {
  return {
    archiveId: archiveIdOf(claimId), name: '这份训练档案暂时读取不完整',
    coach: null, remaining: 0, packageCount: 0,
    degraded: true, reason: String(code || 'COACH_DATASET_UNAVAILABLE')
  }
}

function sanitizeBooking(row, claim, coach) {
  const data = row.data || row
  return {
    historyId: fixedId('member-training-view', claim.claimId, row.bookingId || data.id),
    archiveId: archiveIdOf(claimIdOf(claim)),
    status: memberBookingStatus(data), date: data.date || '', hour: Number(data.hour || 0), minute: Number(data.minute || 0),
    coach, typeName: data.typeName || '', category: data.category || '', duration: Number(data.duration || 0),
    packageViewId: data.packageId ? fixedId('member-package-view', claim.claimId, data.packageId) : '',
    items: Array.isArray(data.items) ? data.items.map(publicItem) : [], memberSummary: String(data.memberSummary || ''), completedAt: data.completedAt || null,
    // ⭐ 2026-10-01：会员端「历史」要按**状态发生那一刻**排序并显示「取消于 MM-DD HH:mm」
    //   ⇒ 必须把云端**已经写好的** `cancelledAt`（`memberBooking` 取消时写入）原样带出来。
    //   ⛔ 只读**既有值**，不改数据、不做迁移；⛔ **不新增任何一次数据库查询**（row 本来就已经读出来了）。
    //   ⛔ `cancelledByMemberId` 等内部字段**仍然**出不去（白名单投影，见 `PRIVATE_BOOKING_FIELDS`）。
    cancelledAt: data.cancelledAt || null
  }
}
// ⭐ 每一份课包「哪些教练真的能用它授课」—— 由**服务端**裁决并下发（与写路径
//   `coachBusinessCommand.resolveMemberTarget` 同口径）：账本所有者恒可用 + 这条课包上
//   **status='active'** 的授课授权教练。⛔ 客户端不许自己猜授权（猜错就是"看得见却约不了")。
//   ⚠️ 授权是**课包级**（测试区课包授权表主键含 packageId）⇒ 必须逐包算，不是一个档案一份。
function packageCoachKeys(claimCoachId, grants, packageRow) {
  const id = String((packageRow && (packageRow.packageId || (packageRow.data && packageRow.data.id))) || '')
  const keys = [fixedId('member-coach-view', claimCoachId)]
  ;(Array.isArray(grants) ? grants : []).forEach(grant => {
    if (!grant) return
    if (grant.coachId && String(grant.packageId) === id) keys.push(fixedId('member-coach-view', grant.coachId))
  })
  return keys
}
function sanitizePackage(row, claim, coach, grants) {
  const data = row.data || row
  return { packageViewId: fixedId('member-package-view', claim.claimId, row.packageId || data.id), archiveId: archiveIdOf(claimIdOf(claim)), coach, typeName: data.type || '', total: Number(data.total || 0), used: Number(data.used || 0), remaining: Number(data.remaining || 0), status: data.status || 'active', isGift: !!data.isGift, saleDate: data.saleDate || '', coachKeys: packageCoachKeys(claim.coachId, grants, row) }
}

function createService({ db, getOpenId }) {
  return async event => {
    event = event || {}
    const topLevelForbidden = [...FORBIDDEN].find(key => Object.prototype.hasOwnProperty.call(event, key))
    const bad = topLevelForbidden ? `event.${topLevelForbidden}` : forbiddenPath(event.payload || {})
    if (bad) return { ok: false, code: 'FORBIDDEN_IDENTITY_INPUT', message: `客户端不得提交身份或数据定位字段：${bad}` }
    const openId = getOpenId()
    if (!openId) return { ok: false, code: 'IDENTITY_MISSING', message: '未能确认当前微信身份。' }
    const n = names(event.environment), memberId = memberIdFor(openId)
    // ⭐⭐ 2026-10-07：这是"两个真相源"的**第二处**（条件矩阵探针实证，见 hxc/_probe-1336-matrix.js）：
    //   旧写法只看**派生索引** `member_sandbox_accounts` ⇒ 这张索引表漏写 / 集合不在 / status 不是 active
    //   ⇒ 一个明明已经在首页看到"张三 + 10 节 + 教练"的会员，在这里被判成 `unregistered`
    //   ⇒ 教练列表空、课时包空、可约时间空 ⇒ 真机就成了"约课页读不到同一套真实数据"。
    // ⇒ 真相源改为**会员主资料** `member_sandbox_members`：`accounts` 只是"通知投递定位"的派生索引，
    //   它缺不缺**不再改变**"这位会员已经存在"这个事实。
    const [account, row] = await Promise.all([
      one(db, n.accounts, { _id: fixedId(n.accounts, memberId), memberId }),
      memberRowOf(db, memberId)
    ])
    if (!((account && account.status === 'active') || row)) return { ok: true, environment: n.environment, state: 'unregistered', member: null, summary: { remaining: 0, completedThisMonth: 0 }, packages: [], nextBooking: null, recentTraining: [], coaches: [], archives: [], archiveCount: 0, warnings: [] }
    // ⭐⭐ M3-P1 性能（会员约课页"正在读取可约时间…"停留 1–2 秒的云端一侧）：
    //   ① `claims` 与 `profiles` 互不依赖 ⇒ **并发**发出（旧代码两趟串行相加）；
    //   ② **availability 分支一口气提到最前面** —— 它**根本用不到** `revisions` 与 `shortcuts`，
    //      旧代码却先把这两趟白跑完才去判断 `event.action`（纯浪费的两趟往返）。
    // ⭐⭐ 定位统一走 `memberScopes`（原理见本文件顶部「唯一真相源」那段注释）：
    //    新会员方案 ⇒ 用会员资料行里绑定时锁定的那三个字段；读不到新资料才退回旧认领表。
    const [scopes, profiles] = await Promise.all([
      memberScopes(db, n, memberId),
      all(db, n.profiles, { discoverable: true })
    ])
    const profileByCoach = new Map(profiles.map(row => [row.coachId, row]))
    const claims = scopes.claims
    // M3 P1：会员「可约时间」只读投影（⚠️ 旧版本云端不认识这个 action ⇒ 会照旧返回整包读取结果，
    //   客户端靠 `availability === true` 判别 ⇒ 拿不到就退化成"只按自己的课排除冲突"，不会误判成"全天可约"）。
    if (event.action === 'availability') return availabilityView(db, n, claims, profileByCoach, event.date)
    const revision = await one(db, n.revisions, { _id: fixedId(n.revisions, 'member', memberId), actorType: 'member', memberId })
    const shortcuts = await all(db, n.shortcuts, { memberId })
    const packageViews = [], bookingViews = [], historicalCoachIds = new Set(), warnings = [], archiveViews = []
    // ⭐ 2026-10-01 审计：**「可约教练」必须由服务端算出来下发**，不能让会员端猜。
    //   来源只有两处（与写路径 `memberBooking.resolveMemberTarget` 逐字同口径）：
    //     ① 账本所有者（认领的那位教练）—— 自己账里的会员天然可约，不需要授权行；
    //     ② 该账本里这位学员的**有效课包级授权**的 coachId。
    //   ⛔ 会员自己输入的「常用教练」（`coach_shortcuts`）**绝不算**可约 ⇒ bookable=false。
    const bookableCoachIds = new Set()
    for (const claim of claims) {
      // ⭐⭐ 与 availability 同一个道理：新会员方案**自带**绑定时锁定的 datasetId ⇒ 不去 head 表猜。
      //   ⛔ 这一处如果不跟着改，就会出现"约课页读到了、我的预约还是空的"这种半边不一致。
      let datasetId = String(claim.datasetId || '')
      let headCode = ''
      if (!datasetId) {
        const headQuery = n.environment === 'sandbox' ? { ownerCoachId: claim.coachId, environment: 'sandbox' } : { ownerCoachId: claim.coachId }
        const heads = await all(db, n.coachHeads, headQuery)
        const head = heads.length === 1 ? heads[0] : null
        headCode = heads.length > 1 ? 'COACH_DATASET_HEAD_AMBIGUOUS' : (!head || !head.activeDatasetId ? 'COACH_DATASET_UNAVAILABLE' : '')
        if (!headCode) datasetId = head.activeDatasetId
      }
      if (headCode) {
        const claimKey = claimIdOf(claim) || fixedId(n.claims, claim.coachId, claim.studentId)
        warnings.push({ code: headCode, claimId: claim.claimId, archiveId: archiveIdOf(claimKey) })
        // ⛔ 档案**照旧下发**（带 `degraded:true`），⛔ 但它的课包 / 预约 / 教练**一个都不投影**。
        archiveViews.push(degradedArchive(claimKey, headCode))
        continue
      }
      const profile = profileByCoach.get(claim.coachId) || { coachId: claim.coachId, displayName: '教练' }, coach = publicCoach(profile)
      // ⭐ 三趟互不依赖 ⇒ **并发**发出（旧代码 packages / bookings 是串行两趟）。
      //   多出来的 grants 那一趟**不会**让"我的预约秒出"变慢：等待时间 = 最长的一趟，不是三者之和。
      // ⭐ 四趟互不依赖 ⇒ 并发（学员档案名那一趟是 `limit(1)`，等待时间 = 最长的一趟，不是四趟之和）。
      const [packageRows, bookingRows, grantRows, studentRow] = await Promise.all([
        all(db, 'packages', { ownerCoachId: claim.coachId, datasetId, studentId: claim.studentId }),
        all(db, 'bookings', { ownerCoachId: claim.coachId, datasetId, studentId: claim.studentId }),
        all(db, authNames(n.environment).package, { ownerCoachId: claim.coachId, datasetId, studentId: claim.studentId, status: 'active' }),
        firstRow(db, 'students', { ownerCoachId: claim.coachId, datasetId, studentId: claim.studentId })
      ])
      bookableCoachIds.add(claim.coachId)
      grantRows.forEach(row => { if (row && row.coachId) bookableCoachIds.add(row.coachId) })
      packageRows.forEach(row => packageViews.push(sanitizePackage(row, claim, coach, grantRows)))
      // ⭐ 这份档案自己的剩余课时 / 课包数（口径与上面 `activePackages` 逐字一致：未作废才计入）。
      const claimRemaining = packageRows
        .filter(row => String((row && row.data ? row.data : row).status || '') !== 'reversed')
        .reduce((sum, row) => sum + (Number.isFinite(Number((row && row.data ? row.data : row).remaining)) ? Number((row && row.data ? row.data : row).remaining) : 0), 0)
      archiveViews.push(sanitizeArchive(claimIdOf(claim) || fixedId(n.claims, claim.coachId, claim.studentId), coach, studentRow, claimRemaining, packageRows.length))
      bookingRows.forEach(row => { bookingViews.push(sanitizeBooking(row, claim, coach)); historicalCoachIds.add(claim.coachId) })
      // ⭐ 其他授课教练账里、属于同一位会员的预约（同一条真实课程，不是副本）⇒ 一并进会员日程。
      const others = await foreignBookingRows(db, n, claim, { activeDatasetId: datasetId })
      for (const row of others) {
        const teachingCoachId = row.ownerCoachId
        const otherCoach = publicCoach(profileByCoach.get(teachingCoachId) || { coachId: teachingCoachId, displayName: '教练' })
        bookingViews.push(sanitizeBooking(row, claim, otherCoach))
        historicalCoachIds.add(teachingCoachId)
      }
    }
    // ⭐ 2026-10-01 审计修复：**被授权可服务这位会员的教练必须出现在「我的教练」里**。
    //    原列表 = 常用教练 ∪ 曾上过课 ⇒ 一位刚被授权、还没上过课的教练**根本看不见**
    //    （而"会员端自动看到被授权可服务自己的教练"正是目标模型的要求）。
    const shortcutCoachIds = new Set(shortcuts.map(row => row.coachId)), coachIds = [...new Set([...shortcutCoachIds, ...historicalCoachIds, ...bookableCoachIds])]
    // ⛔ `bookable` 是**服务端**裁决的结果（不是客户端猜的）：只有它为真，会员才能真的约这位教练。
    //   「常用教练」只是快捷入口，与"有没有授课授权"是两件事 —— 这一列必须让普通用户一眼分清。
    const coaches = coachIds.map(coachId => ({ ...publicCoach(profileByCoach.get(coachId) || { coachId, displayName: '教练' }), shortcutId: shortcuts.find(row => row.coachId === coachId)?.shortcutId || '', saved: shortcutCoachIds.has(coachId), historical: historicalCoachIds.has(coachId), bookable: bookableCoachIds.has(coachId) }))
    const activePackages = packageViews.filter(row => row.status !== 'reversed'), remaining = activePackages.reduce((sum, row) => sum + (Number.isFinite(row.remaining) ? row.remaining : 0), 0)
    // ⭐ 档案数 > 1 ⇒ `remaining` 是**多份档案的合计**（不是一个人的课时）⇒ 一并下发，让界面明说。
    //   ⛔ `remaining` 这个值本身一个字节都没改（只是多给了拆分依据），老客户端照旧工作。
    const archiveCount = archiveViews.length
    const now = new Date(), month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const done = bookingViews.filter(row => row.status === 'done').sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.hour) - Number(a.hour))
    const future = bookingViews.filter(row => row.status === 'booked').sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.hour) - Number(b.hour))
    return {
      // ⛔ 有任何一份档案被降级 ⇒ `dataComplete:false`，⛔ 绝不再单独回一个假的"数据已就绪"。
      ok: true, environment: n.environment, state: claims.length ? 'ready' : 'needs-claim', dataRevision: revision ? revision.dataRevision : 0,
      dataComplete: warnings.length === 0, degradedArchives: warnings.length,
      // ⭐ 2026-10-05：主题切换已撤回 ⇒ 会员侧读服务不再下发 theme。
      // ⭐ 昵称**优先取主资料**：`accounts` 是派生索引（可能还没写好）⇒ 不许因为它空了就把会员名显示成空。
      member: { displayName: (account && account.displayName) || (row && row.displayName) || '' },
      summary: { remaining, packageCount: activePackages.length, completedThisMonth: done.filter(row => String(row.date).startsWith(month)).length },
      packages: packageViews, nextBooking: future[0] || null, recentTraining: done, coaches, archives: archiveViews, archiveCount, warnings
    }
  }
}

module.exports = { createService, memberIdFor, fixedId, names, forbiddenPath, sanitizeBooking, sanitizePackage, sanitizeArchive, archiveIdOf, claimIdOf, archiveNameOf, ARCHIVE_VIEW_KIND, PRIVATE_BOOKING_FIELDS }
