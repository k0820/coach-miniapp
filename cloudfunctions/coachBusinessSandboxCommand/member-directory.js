// ─────────────────────────────────────────────────────────────────────────────
// ⛔⛔ **测试区（Sandbox）专属**：「唯一会员 + 双向联系人」新会员方案的数据底座。
//    本文件只存在于 `coachBusinessSandboxCommand`（测试区）目录里，正式区那份函数里**没有**它，
//    也不会被部署 ⇒ Production 零触碰。
//
// ⭐⭐ 它取代的是什么（旧方案，正在被拿掉）
//   旧的「会员认领 / 8 位认领码 / 15 分钟邀请 / 认领小程序码 / 训练档案 / 切换档案 / 解除认领 /
//   主管教练授权」整套流程，全部依赖「会员自己去认领某本账里的一条学员记录」。
//   这带来三个永远修不干净的故障：换手机就变成另一个人、同一会员多份档案、课时包靠 archiveId 猜归属。
//
// ⭐⭐ 新方案四句话
//   ① **唯一会员**：`memberId = sha('member' + 微信可信 OPENID)` ⇒ 同一个手机号永远算到同一个 ID；
//   ② **主管教练**：第一位与会员建立联系的教练 = `ownerCoachId`，只有他能改核心资料与课时包；
//   ③ **双向联系人**：`memberId + coachId` 唯一一条关系，会员加教练 / 教练加会员落到**同一行**；
//   ④ **不许自动掺\ldots**：二维码只有随机票据，不含 openid / memberId / coachId；
//      遇到错误**绝不**换环境重试（本模块连正式区集合名字面量都没有）。
//
// ⛔⛔ 三条硬纪律
//   ① 环境：进来的 `environment` 必须严格等于 `'sandbox'`，否则一次集合读写都不许发生；
//   ② 身份：`openId` 只从调用方注入（服务端 `cloud.getWXContext()`），⛔ 客户端提交一律无效；
//   ③ 会员定点：客户端永远**不能**提交 `memberId` / `coachId` / `ownerCoachId` / `datasetId` / `openid`。
const crypto = require('crypto')
const core = require('./core')
const authorization = require('./authorization')

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const fixedId = (...parts) => sha(parts.join(':')).slice(0, 32)

// ── 本轮新增的 5 张 Sandbox 集合（⛔ 全部 `member_sandbox_` 前缀，需用户在控制台手工创建）──
const COLLECTIONS = Object.freeze({
  directory: 'member_sandbox_directory',   // 公开编号 → 账号（会员 / 教练各一行）
  members: 'member_sandbox_members',       // 会员主资料（唯一会员；登记 ownerCoachId 与专属 studentId）
  contacts: 'member_sandbox_contacts',     // 联系人关系 memberId + coachId = 一行
  tickets: 'member_sandbox_contact_tickets', // 联系人二维码票据（只有随机串）
  audit: 'member_sandbox_contact_audit'    // 查找次数限制 / 添加移除留痕（**不产生未读消息**）
})
// ⭐ 2026-10-07（1.3.36）真机根因补丁：这一张**也必须自动补齐**。
//   它是「通知投递定位」用的派生索引（`openId ⇒ memberId` 反查），既不定义会员身份、
//   也不存放任何课时事实。旧名单里漏掉了它 ⇒ 集合不存在时 `member-read` 的入口会直接判
//   「未注册」⇒ 首页看得到张三和 10 节、约课页却空空如也（条件矩阵 ⑧⑨ 已实证）。
const DERIVED_COLLECTIONS = Object.freeze({ accounts: 'member_sandbox_accounts' })

// 新会员方案第一次进测试区时，把自己的五张空表补齐。
// 只在本模块、只在 Sandbox 环境门通过后调用；正式区没有此文件，也没有这段能力。
async function ensureSandboxCollections(db) {
  if (!db || typeof db.createCollection !== 'function') return
  const wanted = [...Object.values(COLLECTIONS), ...Object.values(DERIVED_COLLECTIONS)]
  for (const name of wanted) {
    try {
      await db.createCollection(name)
    } catch (error) {
      // 已存在就是正常情况；其他错误（例如云端权限或网络问题）必须照实抛出。
      const detail = `${error && error.code || ''} ${error && error.errCode || ''} ${error && error.message || ''} ${error && error.errMsg || ''}`.toLowerCase()
      if (!/(already|exist|已存在)/.test(detail)) throw error
    }
  }
}

const ROLE_MEMBER = 'member'
const ROLE_COACH = 'coach'
const CONTACT_ACTIVE = 'active'
const CONTACT_REMOVED = 'removed'
const TICKET_TTL_MS = 15 * 60 * 1000
const TICKET_BYTES = 32

// ⭐ 防批量试手机号：同一个账号在 WINDOW 内最多 LOOKUP_LIMIT 次公开编号查找。
//   ⇒ 恰 space 攻击者可以拿一张无效票据一直换人会 skip，但**不可能**拿它去撞全库手机号。
const LOOKUP_WINDOW_MS = 10 * 60 * 1000
const LOOKUP_LIMIT = 10

// ⛔ 界面上的每一句话都必须与真实结果一致：重复添加就说「已经添加过」，没找到就说「没找到」。
const CONTACT_TEXT = Object.freeze({
  DUPLICATED: '已经添加过，无需重复添加。',
  MEMBER_NOT_FOUND: '还没有会员资料，请先填写昵称创建自己的训练账号。',
  CONTACT_NOT_FOUND: '没有找到这个编号，请核对后再试。',
  TICKET_EXPIRED: '这个二维码已经失效，请让对方重新生成后再扫。',
  TICKET_USED_UP: '这个二维码已经失效，请让对方重新生成后再扫。',
  RATE_LIMITED: '查找太频繁了，请稍等一会儿再试。',
  CODE_INVALID: '请输入完整的会员编号或教练编号。',
  NOT_OWNER: '你可以给这位会员排课和记录训练，课时包由主管教练管理。'
})


const cleanText = (value, max) => String(value == null ? '' : value).trim().slice(0, max)
const publicCodeFor = (role, id) => `${role === ROLE_COACH ? 'C' : 'M'}${sha(`public-code:${role}:${id}`).slice(0, 8).toUpperCase()}`
const normalizePublicCode = raw => String(raw == null ? '' : raw).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 9)

const todayKey = nowMs => {
  const at = new Date(Number(nowMs) + 8 * 60 * 60 * 1000)
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
}

const commandError = (code, message, extra = {}) => Object.assign(new Error(message), { commandCode: code, extra })

// ─────────────────────────────────────────────────────────── 数据库小工具
async function listWhere(scope, name, query, limit = 200) {
  // CloudBase 不接受值为 undefined 的查询；真机遇到一条旧的残缺关系行时，
  // 不能让整张会员首页因此报“查询参数对象值不能均为 undefined”。
  const safeQuery = Object.fromEntries(Object.entries(query || {}).filter(([, value]) => value !== undefined && value !== null && value !== ''))
  if (!Object.keys(safeQuery).length) throw commandError('QUERY_KEY_MISSING', `读取 ${name} 时缺少必要条件。`)
  const response = await scope.collection(name).where(safeQuery).limit(limit).get()
  return (response && response.data || [])
}
async function oneRow(scope, name, query) { return (await listWhere(scope, name, query, 1))[0] || null }
async function getRow(scope, name, id) {
  try {
    const response = await scope.collection(name).doc(String(id)).get()
    return response && response.data || null
  } catch (error) { return null }
}
async function setRow(scope, name, id, data) {
  // CloudBase 查询结果自带 `_id`；把整行拿来更新时不能再把 `_id` 写回去，
  // 否则真机会报 -501007「不能更新 _id 的值」。文档编号只由 doc(id) 决定。
  const safe = { ...(data || {}) }
  delete safe._id
  await scope.collection(name).doc(String(id)).set({ data: safe })
  return safe
}

// ⛔ 客户端提交任何身份 / 定位字段 ⇒ 直接拒（不是"忽略"，是让试探行为立刻失败）。
//   `memberId` / `coachId` 之所以**可以**出现：`memberId` 是服务端生成的会员标识、`coachId` 是公开身份，
//   它们本身不是权限 —— 权限一律由**服务端**用 `ownerCoachId` / 联系人关系判定。
const SENSITIVE_KEYS = Object.freeze(['ownerCoachId', 'datasetId', 'studentId', 'claimId', 'packageId', 'bookingId', 'documentId', 'openId', 'openid', 'OPENID', '_openid', '_id'])
function sensitiveIn(value, path = 'payload') {
  if (!value || typeof value !== 'object') return ''
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEYS.indexOf(key) >= 0) return `${path}.${key}`
    const nested = sensitiveIn(value[key], `${path}.${key}`)
    if (nested) return nested
  }
  return ''
}
// ⭐ 与 `memberBooking.js` 同一个写法：**按动作**分表 ⇒ "这条命令能提交什么"一眼看得完。
const PAYLOAD_KEYS = Object.freeze({
  dashboard: Object.freeze([]),
  issueTicket: Object.freeze([]),
  drawTicketQr: Object.freeze([]),
  resolveTicket: Object.freeze(['ticket', 'scene']),
  findByCode: Object.freeze(['code']),
  addContact: Object.freeze(['ticket', 'code']),
  listContacts: Object.freeze([]),
  removeContact: Object.freeze(['contactKey', 'memberId']),
  readMemberDetail: Object.freeze(['memberId']),
  updateMemberCore: Object.freeze(['memberId', 'displayName']),
  loginByPhone: Object.freeze(['phone']),
  resolvePhoneCode: Object.freeze(['code']),
  createMemberByCoach: Object.freeze(['phone', 'displayName']),
})

// ───────────────────────────────────────────── 我是谁（⛔ 只从服务端可信 OPENID 推导）
async function actorOf({ db, openId }) {
  if (!openId) throw commandError('IDENTITY_MISSING', '未能确认当前微信身份。')
  const coachId = core.coachIdFor(openId)
  const coachRow = await getRow(db, 'coaches', coachId)
  if (coachRow && String(coachRow.openId || '') === String(openId)) return { kind: ROLE_COACH, id: coachId, coachId, openId }
  const memberRow = await oneRow(db, COLLECTIONS.members, { openId })
  if (memberRow && memberRow.status !== CONTACT_REMOVED) return { kind: ROLE_MEMBER, id: memberRow.memberId, memberId: memberRow.memberId, openId, memberRow }
  throw commandError('ACTOR_UNKNOWN', '这个微信账号还没有创建会员资料，也还不是教练。')
}

// ⭐ 名片投影：⛔ 只下发昵称 / 身份 / 公开编号 —— 完整手机号与任何内部编号一律不出网。
function publicCardOf({ role, id, displayName, publicCode }) {
  return {
    role, roleText: role === ROLE_COACH ? '教练' : '会员',
    contactKey: fixedId('member-contact-view', role, id),
    displayName: cleanText(displayName, 30) || (role === ROLE_COACH ? '教练' : '会员'),
    publicCode: normalizePublicCode(publicCode) || publicCodeFor(role, id)
  }
}

async function ensureCoachCard({ db, coachId, now }) {
  const id = fixedId('member-directory-coach', coachId)
  const existing = await getRow(db, COLLECTIONS.directory, id)
  if (existing && existing.publicCode) return existing
  const row = { ...(existing || {}), directoryId: id, role: ROLE_COACH, coachId, publicCode: publicCodeFor(ROLE_COACH, coachId), updatedAt: now }
  await setRow(db, COLLECTIONS.directory, id, row)
  return row
}

// ───────────────────────────────────────────── 公开编号查找限流（⛔ 同账号窗口内计数）
async function assertLookupAllowed({ db, actorKey, now }) {
  const rows = await listWhere(db, COLLECTIONS.audit, { actorKey, kind: 'lookup' }, 200)
  const recent = rows.filter(row => Number(row.createdAt) > Number(now) - LOOKUP_WINDOW_MS)
  if (recent.length >= LOOKUP_LIMIT) throw commandError('LOOKUP_RATE_LIMITED', CONTACT_TEXT.RATE_LIMITED)
  return recent.length
}
async function writeAudit({ db, actorKey, kind, detail, now }) {
  const id = `${fixedId('member-contact-audit', actorKey, kind, String(now))}${String(detail || '')}`.slice(0, 64)
  try {
    await setRow(db, COLLECTIONS.audit, id, { kind, actorKey, detail: cleanText(detail, 120), createdAt: now })
  } catch (error) { /* 审计写失败**绝不**影响业务成功 */ }
  return id
}

// ───────────────────────────────────────────── 找人：会员按 members、教练按 directory
// ⭐ 给既有「会员自助预约写通道」用的会员身份解析：openid → **微信身份对应的唯一会员**。
//   ⛔ 查不到就返回空串 ⇒ `memberBooking` 会回退到旧算法 ⇒ 老会员一个字节都不受影响。
async function memberIdByOpenId(db, openId) {
  if (!openId) return ''
  try {
    const row = await oneRow(db, COLLECTIONS.members, { openId })
    return row && row.memberId ? String(row.memberId) : ''
  } catch (error) { return '' }
}

async function coachDisplayName(db, coachId) {
  const names = authorization.collectionsFor('sandbox')
  const profile = await oneRow(db, names.profiles, { coachId })
  return cleanText(profile && profile.displayName, 30) || '教练'
}

// ───────────────────────────────────────────── 联系人关系的唯一写入口
//
// ⛔⛔ 四种入口（会员输手机号 / 会员扫码 / 教练输手机号 / 教练扫码）**全部**落到这一个函数：
//     关系的 `_id` 恒等于 `sha('member-contact' + memberId + coachId)` ⇒ 谁先加都一样，
//     ⛔ 绝不可能因为方向不同出现两条关系，也绝不会凭空多出一份会员资料。
async function writeContact({ db, environment, memberId, coachId, actorKey, source, now }) {
  const id = fixedId('member-contact', memberId, coachId)
  const existing = await getRow(db, COLLECTIONS.contacts, id)
  if (existing && String(existing.status || '') === CONTACT_ACTIVE) {
    // ⛔ 幂等：**零副作用**返回成功 + 明确人话 ⇒ 界面显示「已经添加过，无需重复添加。」
    return { ok: true, duplicated: true, contactId: id, message: CONTACT_TEXT.DUPLICATED }
  }
  let member = await getRow(db, COLLECTIONS.members, fixedId('member-directory-member', memberId))
  if (!member) return { ok: false, code: 'MEMBER_NOT_FOUND', message: CONTACT_TEXT.MEMBER_NOT_FOUND }
  if (!member.ownerCoachId) {
    const context = await core.activeContext(db, coachId, environment)
    const created = await core.execute(db, coachId, {
      command: 'createStudent', requestId: `mdir:${memberId.slice(0, 12)}:${coachId.slice(0, 12)}`,
      expectedRevision: context.revision.dataRevision, payload: { name: member.displayName, phone: '' }
    }, { createStudent: require('./handlers').handlers.createStudent }, now, environment)
    if (!created || !created.ok || !(created.result && created.result.studentId)) return created || { ok: false, code: 'MEMBER_LINK_FAILED', message: '建立会员资料失败，请重试。' }
    const studentId = created.result.studentId
    const names = authorization.collectionsFor(environment)
    const claimId = fixedId('member-directory-claim', memberId)
    await setRow(db, names.claims, claimId, { claimId, memberId: memberIdForOpenId(member.openId), coachId, studentId, status: 'verified', source: 'member-directory', createdAt: now })
    const place = await ownerPlaceOf({ db, environment, member: { ownerCoachId: coachId } })
    member = { ...member, ownerCoachId: coachId, ownerDatasetId: place ? place.datasetId : '', studentId, claimId, createdByCoachId: coachId, updatedAt: now }
    await setRow(db, COLLECTIONS.members, fixedId('member-directory-member', memberId), member)
  }
  const row = {
    contactId: id, memberId, coachId, status: CONTACT_ACTIVE, source: String(source || 'unknown'),
    createdAt: now, createdBy: String(actorKey || ''), updatedAt: now
  }
  await setRow(db, COLLECTIONS.contacts, id, row)
  // ⛔ 建立关系**不复制任何资料**：不建第二份会员、不复制课时包、不产生第二条学员记录。
  //    它只给这位教练开「能看见这位会员 + 能用这位会员的课时包排课」的钥匙（复用 M2 双层授权）。
  const granted = await grantPackagesToCoach({ db, environment, memberId, coachId, now })
  await writeAudit({ db, actorKey: actorKey || '', kind: 'add', detail: `${memberId.slice(0, 8)}:${coachId.slice(0, 8)}`, now })
  return { ok: true, duplicated: false, contactId: id, granted }
}

// ⭐ M2 既有机制复用：会员级服务关系 + **每一份有效课时包**的授课授权。
//   ⇒ 添加完立刻就能排课（不需要再走一次"主管教练授权"页面）；
//   ⛔ `canManage: false` ⇒ 这位教练只能上课拿收入，**不能**改核心资料 / 改余额。
async function grantPackagesToCoach({ db, environment, memberId, coachId, now }) {
  const member = await getRow(db, COLLECTIONS.members, fixedId('member-directory-member', memberId)) || await oneRow(db, COLLECTIONS.members, { memberId })
  if (!member) return { memberAuth: false, packages: 0 }
  const auths = authorization.authScope(db, environment)
  const place = await auths.activePlaceOf(member.ownerCoachId)
  if (!place) return { memberAuth: false, packages: 0 }
  if (String(coachId) === String(member.ownerCoachId)) return { memberAuth: false, packages: 0 }
  await auths.writeMember({
    ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId: member.studentId, coachId,
    status: authorization.STATUS_ACTIVE, canManage: false, source: 'contact',
    grantedByCoachId: member.ownerCoachId, createdAt: now, updatedAt: now
  })
  const packages = await listWhere(db, 'packages', { ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId: member.studentId })
  let count = 0
  for (const row of packages) {
    const pkg = row && row.data ? row.data : row
    if (String(pkg.status || 'active') === 'reversed') continue
    const packageId = String(row.packageId || pkg.id || '')
    if (!packageId) continue
    await auths.writeGrant({
      ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, packageId, studentId: member.studentId, coachId,
      status: authorization.STATUS_ACTIVE, canManage: false, grantedByCoachId: member.ownerCoachId, createdAt: now, updatedAt: now
    })
    count += 1
  }
  return { memberAuth: true, packages: count }
}

// ───────────────────────────────────────────── 主管教练：风控 `到账时间片` + 课时投影
async function ownerPlaceOf({ db, environment, member }) {
  // 绑定时已经把“A 教练的哪一本账”写进会员资料。会员读取必须使用这个
  // 确定位置，不能以后再按教练当前 head 猜一次，否则教练切换账本后会员会看到 0 课时。
  if (member && member.ownerCoachId && member.ownerDatasetId) {
    return { ownerCoachId: String(member.ownerCoachId), datasetId: String(member.ownerDatasetId) }
  }
  const auths = authorization.authScope(db, environment)
  return member && member.ownerCoachId ? await auths.activePlaceOf(member.ownerCoachId) : null
}

// ⭐ 课时三个数：**一本账一个真相**，只在主管教练那本账里存在，不会因为加 B 教练而复制第二份。
async function memberPackageSummary({ db, member, place }) {
  const rows = await listWhere(db, 'packages', { ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId: member.studentId })
  const active = rows.filter(row => String(((row && row.data ? row.data : row).status) || 'active') !== 'reversed')
  const occupied = active.reduce((sum, row) => sum + (Number.isFinite(Number((row.data || row).reserved)) ? Number((row.data || row).reserved) : 0), 0)
  const remaining = active.reduce((sum, row) => sum + (Number.isFinite(Number((row.data || row).remaining)) ? Number((row.data || row).remaining) : 0), 0)
  const used = active.reduce((sum, row) => sum + (Number.isFinite(Number((row.data || row).used)) ? Number((row.data || row).used) : 0), 0)
  return {
    available: Math.max(remaining - occupied, 0), occupied, used,
    remaining, packageCount: active.length
  }
}

async function upcomingBookingOf({ db, member, place }) {
  const rows = await listWhere(db, 'bookings', { studentId: member.studentId }, 500)
  const headName = core.metaFor('sandbox').heads
  const future = []
  for (const row of rows) {
    const booking = row && row.data ? row.data : row
    if (String(booking.status || '') !== 'booked') continue
    const heads = await listWhere(db, headName, { ownerCoachId: row.ownerCoachId, environment: 'sandbox' }, 5)
    // ⛔ 跨环境的账本一律不算（不是本环境 head 里登记的那本账 ⇒ 一定不是同一份数据）
    if (!heads.some(head => head && head.activeDatasetId === row.datasetId)) continue
    future.push({ booking, datasetId: row.datasetId, ownerCoachId: row.ownerCoachId })
  }
  future.sort((a, b) => String(a.booking.date).localeCompare(String(b.booking.date)) || Number(a.booking.hour) - Number(b.booking.hour))
  const first = future[0]
  if (!first) return null
  const b = first.booking
  return {
    coachName: await coachDisplayName(db, first.ownerCoachId),
    date: String(b.date || ''), hour: Number(b.hour || 0), minute: Number(b.minute || 0),
    typeName: String(b.typeName || b.category || '常规课')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 命令本体
// ─────────────────────────────────────────────────────────────────────────────

// ⛔ 既有链路的会员身份公式（`readMyMemberData` / `memberBooking` 都是这一个，改一处就要改三处）。
function memberIdForOpenId(openId) { return sha(`member:${openId}`).slice(0, 32) }

// 新会员目录与既有约课/微信通知共用同一个可信 memberId。这里只补一张“接收账号索引”，
// 不创建第二位会员、不复制课包；旧约课读取和通知投递都靠它从 memberId 找回 OPENID。
async function ensureMemberAccount({ db, member, openId, now }) {
  if (!member || !member.memberId || !openId) return null
  const id = fixedId('member_sandbox_accounts', member.memberId)
  const existing = await getRow(db, 'member_sandbox_accounts', id)
  const row = {
    ...(existing || {}), memberId: member.memberId,
    identityHash: sha(`openid:${openId}`), openId: String(openId),
    displayName: cleanText(member.displayName, 30), status: 'active',
    createdAt: existing && existing.createdAt || now, updatedAt: now
  }
  // ⛔ 这是**派生索引**，不是真相源：它写不进去（比如集合还没建好）**不许**拖垮绑定 / 首页这两条主流程。
  //   ⛔ 但也不能假装成功 —— 返回 `null` 让调用方知道"索引这一份没落上"（取值时照旧从主资料读）。
  //   ⚠️ 真相是：`member-read` 已经改以 `member_sandbox_members` 判定会员是否存在，不再只认这张索引表。
  try {
    await setRow(db, DERIVED_COLLECTIONS.accounts, id, row)
  } catch (error) {
    return null
  }
  return row
}

async function rebindClaim({ db, environment, member, openId, now }) {
  const claimId = String(member.claimId || '')
  if (!claimId) return { ok: false, code: 'CLAIM_MISSING' }
  const names = authorization.collectionsFor(environment)
  const row = await getRow(db, names.claims, claimId)
  if (!row) return { ok: false, code: 'CLAIM_MISSING' }
  const nextMemberId = memberIdForOpenId(openId)
  if (String(row.memberId || '') === nextMemberId) return { ok: true, changed: false }
  // ⛔ 只改这一行的"指向谁"，⛔ 绝不复制学员记录、绝不新增第二行、绝不碰课时包。
  await setRow(db, names.claims, claimId, { ...row, memberId: nextMemberId, reboundAt: now, reboundFrom: String(row.memberId || '') })
  return { ok: true, changed: true, claimId }
}

// ② 会员首页所需的一切（这一份数据**只走本模块**，不再经过旧的 `readMyMemberData`）。
async function readDashboard({ db, environment, actor, now }) {
  const member = actor.memberRow || await oneRow(db, COLLECTIONS.members, { memberId: actor.memberId })
  if (!member) return { ok: false, code: 'MEMBER_NOT_FOUND', message: CONTACT_TEXT.MEMBER_NOT_FOUND }
  if (!member.ownerCoachId || !member.studentId) return { ok: false, code: 'MEMBER_BINDING_REQUIRED', needsBinding: true, message: '请先绑定教练已经录入的会员资料。' }
  await ensureMemberAccount({ db, member, openId: actor.openId, now })
  const place = await ownerPlaceOf({ db, environment, member })
  if (!place) return { ok: true, member: publicCardOf({ role: ROLE_MEMBER, id: member.memberId, displayName: member.displayName, publicCode: member.publicCode }), summary: { available: 0, occupied: 0, used: 0, packageCount: 0 }, nextBooking: null, coaches: [], packages: [], placeUnavailable: true }
  // 早期真机绑定曾在“写联系人”之后、“标记票据已用”之前失败。这里幂等补一次，
  // 保证 A 教练永远是会员绑定成功后的第一位教练。
  await writeContact({ db, environment, memberId: member.memberId, coachId: member.ownerCoachId, actorKey: `member:${member.memberId}`, source: 'member-dashboard-repair', now })
  // 只要某位 B 教练已经取得这位会员的有效授课关系（因此能给他排课），
  // 就把 B 幂等加入会员的教练表。关系按 memberId+coachId 唯一，不限教练人数。
  const authNames = authorization.collectionsFor(environment)
  const teachingRows = await listWhere(db, authNames.member, {
    ownerCoachId: place.ownerCoachId, datasetId: place.datasetId,
    studentId: member.studentId, status: authorization.STATUS_ACTIVE
  })
  for (const teaching of teachingRows) {
    if (!teaching.coachId) continue
    await writeContact({ db, environment, memberId: member.memberId, coachId: teaching.coachId, actorKey: `course:${member.memberId}`, source: 'teaching-relation', now })
  }
  const [summary, nextBooking, packages] = [await memberPackageSummary({ db, member, place }), await upcomingBookingOf({ db, member, place }), await listWhere(db, 'packages', { ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId: member.studentId })]
  const contactRows = await listWhere(db, COLLECTIONS.contacts, { memberId: member.memberId, status: CONTACT_ACTIVE })
  const names = authorization.collectionsFor(environment)
  const coaches = []
  for (const row of contactRows) {
    const profile = await oneRow(db, names.profiles, { coachId: row.coachId })
    const directory = await ensureCoachCard({ db, coachId: row.coachId, now })
    coaches.push(Object.assign(publicCardOf({
      role: ROLE_COACH, id: row.coachId,
      displayName: (profile && profile.displayName) || '', publicCode: directory && directory.publicCode
    }), { isOwner: String(row.coachId) === String(member.ownerCoachId) }))
  }
  const packageViews = packages.map(row => {
    const pkg = row.data || row
    return {
      packageKey: fixedId('member-directory-package', member.memberId, String(row.packageId || pkg.id || '')),
      typeName: String(pkg.type || '常规课'), saleDate: String(pkg.saleDate || ''), total: Number(pkg.total || 0), used: Number(pkg.used || 0),
      remaining: Number(pkg.remaining || 0), reserved: Number(pkg.reserved || 0), status: String(pkg.status || 'active')
    }
  })
  return {
    ok: true, environment, memberId: member.memberId,
    member: publicCardOf({ role: ROLE_MEMBER, id: member.memberId, displayName: member.displayName, publicCode: member.publicCode }),
    summary, nextBooking, coaches, packages: packageViews, recentTraining: doneOf(await recentTraining({ db, member, place }))
  }
}

async function recentTraining({ db, member, place }) {
  const rows = await listWhere(db, 'bookings', { studentId: member.studentId }, 500)
  const headName = core.metaFor('sandbox').heads
  const done = []
  for (const row of rows) {
    const booking = row && row.data ? row.data : row
    if (String(booking.status || '') !== 'done') continue
    const heads = await listWhere(db, headName, { ownerCoachId: row.ownerCoachId, environment: 'sandbox' }, 5)
    if (!heads.some(head => head && head.activeDatasetId === row.datasetId)) continue
    done.push({ date: String(booking.date || ''), hour: Number(booking.hour || 0), minute: Number(booking.minute || 0), coachName: await coachDisplayName(db, row.ownerCoachId), typeName: String(booking.typeName || booking.category || '常规课') })
  }
  done.sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.hour) - Number(a.hour))
  return done
}
function doneOf(list) { return list.slice(0, 5) }

// 联系人二维码统一由微信官方生成“小程序码”：圆点样式、中央自动使用当前小程序 Logo，
// 右下角自动带绿色小程序标识。我们不再手画普通方形二维码，也不再维护第二份 Logo。
// scene 只有 32 位随机票据门牌号，不含 openid / memberId / coachId；扫码后仍先显示确认卡。
async function renderContactMiniCode({ cloud, scene, role }) {
  if (!cloud || !cloud.openapi || !cloud.openapi.wxacode || typeof cloud.openapi.wxacode.getUnlimited !== 'function') {
    throw Object.assign(new Error('当前云函数没有小程序码能力。'), { code: 'QRCODE_CAPABILITY_UNAVAILABLE' })
  }
  const page = role === ROLE_MEMBER ? COACH_ADD_MEMBER_PAGE : RESOLVE_PAGE
  const response = await cloud.openapi.wxacode.getUnlimited({
    scene: cleanText(scene, 32), page, width: 430,
    auto_color: false, is_hyaline: false, check_path: false, env_version: QR_ENV_VERSION
  })
  if (!response || !response.buffer) throw Object.assign(new Error('微信没有返回小程序码图片。'), { code: 'QRCODE_GENERATE_FAILED' })
  return response.buffer
}

// ③ 把临时 scene 交给微信，生成能直接打开对应确认页的官方小程序码。
async function drawTicketQr({ db, cloud, actor, now, ttlMs }) {
  const directoryCard = actor.kind === ROLE_COACH
    ? await ensureCoachCard({ db, coachId: actor.id, now })
    : await getRow(db, COLLECTIONS.members, fixedId('member-directory-member', actor.id))
  const publicCode = (directoryCard && directoryCard.publicCode) || publicCodeFor(actor.kind, actor.id)
  const issued = await issueTicket({ db, actor, now, ttlMs })
  const scene = issued.row ? issued.row.ticketId : ''
  if (!scene || !issued.ticket) return { ok: false, code: 'TICKET_INVALID', message: CONTACT_TEXT.TICKET_EXPIRED }
  if (!cloud || typeof cloud.uploadFile !== 'function' || !cloud.openapi || !cloud.openapi.wxacode) {
    return { ok: false, code: 'QRCODE_CAPABILITY_UNAVAILABLE', ticket: issued.ticket, scene, publicCode, message: '暂时不能保存二维码，请把会员编号发给教练添加。' }
  }
  let buffer = null
  try {
    buffer = await renderContactMiniCode({ cloud, scene, role: actor.kind })
  } catch (error) {
    return { ok: false, code: 'QRCODE_GENERATE_FAILED', ticket: issued.ticket, scene, publicCode, message: '二维码生成失败，请稍后重试，或把会员编号发给教练添加。' }
  }
  if (!buffer) return { ok: false, code: 'QRCODE_GENERATE_FAILED', ticket: issued.ticket, scene, publicCode, message: '二维码生成失败，请稍后重试，或把公开编号发给对方添加。' }
  const cloudPath = `contact-qr/${actor.kind}/${scene}.png`
  try {
    const uploaded = await cloud.uploadFile({ cloudPath, fileContent: buffer })
    if (uploaded && uploaded.fileID) return { ok: true, ticket: issued.ticket, scene, fileID: uploaded.fileID, expiresAt: issued.expiresAt, publicCode }
  } catch (error) { /* 落到下面那句统一提示 */ }
  return { ok: false, code: 'QRCODE_UPLOAD_FAILED', ticket: issued.ticket, scene, publicCode, message: '二维码生成了但没能保存到云端，请稍后重试。' }
}
function translateQrError(error) {
  const errCode = Number(error && error.errCode)
  const text = String((error && error.errMsg) || (error && error.message) || '')
  if (errCode === 48001 || errCode === 41001 || /unauthorized|permission|scope/i.test(text)) {
    return Object.assign(new Error('当前小程序还没有开通「获取小程序码」权限，请把公开编号发给对方添加。'), { code: 'QRCODE_CAPABILITY_UNAVAILABLE' })
  }
  if (errCode === 41030 || /page|path/i.test(text)) {
    return Object.assign(new Error(`二维码要打开的页面还没发布（${RESOLVE_PAGE}），请先用公开编号添加。`), { code: 'QRCODE_PAGE_MISSING' })
  }
  return Object.assign(new Error('二维码生成失败，请稍后重试，或把公开编号发给对方添加。'), { code: 'QRCODE_GENERATE_FAILED' })
}

// ③ 我的联系人二维码：**只有随机票据**，二维码里不放openid / memberId / coachId。
async function issueTicket({ db, actor, actorPhoneForTail = '', now, ttlMs = TICKET_TTL_MS }) {
  const ticket = crypto.randomBytes(TICKET_BYTES).toString('base64url')
  const id = fixedId('member-contact-ticket', actor.kind, actor.id, ticket)
  const row = { ticketId: id, ticket, role: actor.kind, memberId: actor.kind === ROLE_MEMBER ? actor.id : '', coachId: actor.kind === ROLE_COACH ? actor.id : '', createdAt: now, expiresAt: now + Number(ttlMs), status: 'new' }
  await setRow(db, COLLECTIONS.tickets, id, row)
  return { ok: true, ticket, expiresAt: row.expiresAt, ttlMs, scene: id, containsSecrets: false, row }
}

// ④ 扫码：**先到确认页**（这里只换回确认卡），⛔ 绝不自动建立关系。
async function resolveTicket({ db, ticket: rawTicket, now }) {
  const ticket = cleanText(rawTicket, 128)
  if (!ticket) return { ok: false, code: 'TICKET_INVALID', message: CONTACT_TEXT.TICKET_EXPIRED }
  // ⭐ 两种形态都认：① 分享出去的长票据；② 二维码里的短 scene（= `ticketId`，32 字符，微信上限刚好够）。
  //   ⛔ 两者指向同一行 ⇒ 绝不会出现"扫得到却查不到"。
  const row = await oneRow(db, COLLECTIONS.tickets, { ticket })
    || (/^[0-9a-f]{32}$/.test(ticket) ? await getRow(db, COLLECTIONS.tickets, ticket) : null)
  if (!row) return { ok: false, code: 'TICKET_INVALID', message: CONTACT_TEXT.TICKET_EXPIRED }
  if (Number(row.expiresAt) <= Number(now)) return { ok: false, code: 'TICKET_EXPIRED', message: CONTACT_TEXT.TICKET_EXPIRED }
  // ⭐ 返回值分两层：`card` 是**能出网**的确认卡（昵称 / 身份 / 尾号），
  //   `role` / `memberId` / `coachId` 是**只在服务端内部流转**的定位（⛔ 出口层会剥掉，绝不下发）。
  if (row.role === ROLE_MEMBER) {
    const member = await getRow(db, COLLECTIONS.members, fixedId('member-directory-member', row.memberId))
    if (!member) return { ok: false, code: 'MEMBER_NOT_FOUND', message: CONTACT_TEXT.MEMBER_NOT_FOUND }
    return {
      ok: true, ticketId: row.ticketId, role: ROLE_MEMBER, memberId: member.memberId, coachId: '',
      card: publicCardOf({ role: ROLE_MEMBER, id: member.memberId, displayName: member.displayName, publicCode: member.publicCode })
    }
  }
  const directory = await ensureCoachCard({ db, coachId: row.coachId, now })
  return {
    ok: true, ticketId: row.ticketId, role: ROLE_COACH, memberId: '', coachId: row.coachId,
    card: publicCardOf({ role: ROLE_COACH, id: row.coachId, displayName: await coachDisplayName(db, row.coachId), publicCode: directory && directory.publicCode })
  }
}

// ⑤ 公开编号精确查找：只接受 M/C 开头的完整编号，并限制查找频率。
async function findByCode({ db, actor, payload, now }) {
  const actorKey = `${actor.kind}:${actor.id}`
  const remaining = LOOKUP_LIMIT - await assertLookupAllowed({ db, actorKey, now })
  const code = normalizePublicCode(payload.code)
  await writeAudit({ db, actorKey, kind: 'lookup', detail: code ? 'valid' : 'invalid', now })
  if (!/^[MC][A-F0-9]{8}$/.test(code)) return { ok: false, code: 'CODE_INVALID', message: CONTACT_TEXT.CODE_INVALID, lookupRemaining: remaining }
  const directory = await oneRow(db, COLLECTIONS.directory, { publicCode: code })
  // ⭐ 兜底：会员公开编号（M 码）可能还没建 directory 行，直接按 members.publicCode 兜底查
  const memberByCode = !directory ? await oneRow(db, COLLECTIONS.members, { publicCode: code }) : null
  if (!directory && (!memberByCode || memberByCode.status === CONTACT_REMOVED)) {
    return { ok: false, code: 'CONTACT_NOT_FOUND', message: CONTACT_TEXT.CONTACT_NOT_FOUND, lookupRemaining: remaining }
  }
  const resolvedRole = directory ? directory.role : ROLE_MEMBER
  const resolvedCoachId = directory ? directory.coachId : ''
  const resolvedMemberId = directory ? directory.memberId : (memberByCode ? memberByCode.memberId : '')
  if (actor.kind === ROLE_MEMBER) {
    if (resolvedRole !== ROLE_COACH) return { ok: false, code: 'CONTACT_ROLE_MISMATCH', message: '请输入教练编号。', lookupRemaining: remaining }
    return { ok: true, lookupRemaining: remaining, card: publicCardOf({ role: ROLE_COACH, id: resolvedCoachId, displayName: await coachDisplayName(db, resolvedCoachId), publicCode: code }) }
  }
  if (resolvedRole !== ROLE_MEMBER) return { ok: false, code: 'CONTACT_ROLE_MISMATCH', message: '请输入会员编号。', lookupRemaining: remaining }
  const member = directory ? await getRow(db, COLLECTIONS.members, fixedId('member-directory-member', resolvedMemberId)) : memberByCode
  if (!member) return { ok: false, code: 'CONTACT_NOT_FOUND', message: CONTACT_TEXT.CONTACT_NOT_FOUND, lookupRemaining: remaining }
  return { ok: true, lookupRemaining: remaining, card: publicCardOf({ role: ROLE_MEMBER, id: member.memberId, displayName: member.displayName, publicCode: code }) }
}

// ⑥ 添加联系人（会员加教练 / 教练加会员，**同一个写入口**）
//
// ⛔⛔ 四条入口（会员输手机号 / 会员扫码 / 教练输手机号 / 教练扫码）最后都落到这里，
//    区别只在于"怎么把对方认出来"（票据 or 手机号），建立关系那一步**只有** `writeContact` 一个地方。
async function addContact({ db, environment, actor, payload, now }) {
  const ticket = cleanText(payload && payload.ticket, 128)
  if (ticket) {
    const resolved = await resolveTicket({ db, ticket, now })
    if (!resolved.ok) return resolved
    // ⛔ 方向：会员只能加教练、教练只能加会员（⛔ 拿错方向的二维码 ⇒ 明确报错，绝不自动换对象）
    if (resolved.role === actor.kind) return { ok: false, code: 'CONTACT_ROLE_MISMATCH', message: '这是同类型的二维码：请用对方那一侧的二维码来添加。' }
    // ⛔ 定位只认服务端解出来的 `memberId` / `coachId`；⛔ **绝不**从下发给客户端的 `card` 里取
    //    （`card` 里故意没有内部编号 ⇒ 从它取会写出一条"会员号是空"的脏关系）。
    return await writeContact({
      db, environment, now,
      memberId: resolved.role === ROLE_MEMBER ? resolved.memberId : actor.id,
      coachId: resolved.role === ROLE_COACH ? resolved.coachId : actor.id,
      actorKey: `${actor.kind}:${actor.id}`, source: 'ticket'
    })
  }
  const code = normalizePublicCode(payload && payload.code)
  if (!code) return { ok: false, code: 'CODE_INVALID', message: CONTACT_TEXT.CODE_INVALID }
  const directory = await oneRow(db, COLLECTIONS.directory, { publicCode: code })
  // ⭐ 兜底：会员公开编号（M 码）可能还没建 directory 行，直接按 members.publicCode 兜底查
  const memberByCode = !directory ? await oneRow(db, COLLECTIONS.members, { publicCode: code }) : null
  if (!directory && !memberByCode) return { ok: false, code: 'CONTACT_NOT_FOUND', message: CONTACT_TEXT.CONTACT_NOT_FOUND }
  if (!directory && memberByCode && memberByCode.status === CONTACT_REMOVED) return { ok: false, code: 'CONTACT_NOT_FOUND', message: CONTACT_TEXT.CONTACT_NOT_FOUND }
  if (actor.kind === ROLE_MEMBER) {
    if (!directory || directory.role !== ROLE_COACH) return { ok: false, code: 'CONTACT_ROLE_MISMATCH', message: '请输入教练编号。' }
    return await writeContact({ db, environment, memberId: actor.id, coachId: directory.coachId, actorKey: `${actor.kind}:${actor.id}`, source: 'code', now })
  }
  // 教练视角：对方可以是教练（directory 行）或会员（members 兜底行）
  if (directory && directory.role !== ROLE_MEMBER) return { ok: false, code: 'CONTACT_ROLE_MISMATCH', message: '请输入会员编号。' }
  const resolvedMemberId = directory ? directory.memberId : (memberByCode ? memberByCode.memberId : '')
  return await writeContact({ db, environment, memberId: resolvedMemberId, coachId: actor.id, actorKey: `${actor.kind}:${actor.id}`, source: 'code', now })
}

// ⑦ 联系人名单
async function listContacts({ db, environment, actor }) {
  const query = actor.kind === ROLE_MEMBER
    ? { memberId: actor.id, status: CONTACT_ACTIVE }
    : { coachId: actor.id, status: CONTACT_ACTIVE }
  const rows = await listWhere(db, COLLECTIONS.contacts, query)
  const names = authorization.collectionsFor(environment)
  const list = []
  for (const row of rows) {
    if (actor.kind === ROLE_MEMBER) {
      const profile = await oneRow(db, names.profiles, { coachId: row.coachId })
      const directory = await ensureCoachCard({ db, coachId: row.coachId, now: Date.now() })
      list.push(Object.assign(publicCardOf({ role: ROLE_COACH, id: row.coachId, displayName: profile && profile.displayName, publicCode: directory && directory.publicCode }), { contactKey: row.contactId }))
    } else {
      const member = await getRow(db, COLLECTIONS.members, fixedId('member-directory-member', row.memberId))
      if (!member) continue
      const place = await ownerPlaceOf({ db, environment, member })
      list.push(Object.assign(publicCardOf({ role: ROLE_MEMBER, id: member.memberId, displayName: member.displayName, publicCode: member.publicCode }), {
        contactKey: row.contactId,
        isOwner: String(member.ownerCoachId) === String(actor.id),
        summary: place ? await memberPackageSummary({ db, member, place }) : { available: 0, occupied: 0, packageCount: 0 }
      }))
    }
  }
  return { ok: true, role: actor.kind, contacts: list }
}

// ⑧ 移除联系人：⛔ 只断关系，**历史课程 / 收入 / 训练记录一个字节都不删**。
async function removeContact({ db, environment, actor, payload, now }) {
  const target = cleanText(payload && payload.contactKey, 64)
  const row = target ? await getRow(db, COLLECTIONS.contacts, target) : null
  const found = row || await oneRow(db, COLLECTIONS.contacts, actor.kind === ROLE_MEMBER
    ? { memberId: actor.id, coachId: cleanText(payload && payload.coachId, 64), status: CONTACT_ACTIVE }
    : { coachId: actor.id, memberId: cleanText(payload && payload.memberId, 64), status: CONTACT_ACTIVE })
  if (!found) return { ok: false, code: 'CONTACT_NOT_FOUND', message: '没有找到这条联系人关系。' }
  const member = await getRow(db, COLLECTIONS.members, fixedId('member-directory-member', found.memberId))
  if (member) {
    const bookings = await listWhere(db, 'bookings', { studentId: member.studentId }, 500)
    const unfinished = bookings.some(item => {
      const booking = item && item.data ? item.data : item
      const teachingCoachId = String(booking.teachingCoachId || item.ownerCoachId || '')
      return String(booking.status || '') === 'booked' && teachingCoachId === String(found.coachId || '')
    })
    if (unfinished) return { ok: false, code: 'CONTACT_HAS_UNFINISHED_BOOKINGS', message: '这位教练还有未完成课程，请先取消或完成课程，再移出会员列表。' }
  }
  await setRow(db, COLLECTIONS.contacts, found.contactId || target, { ...found, status: CONTACT_REMOVED, updatedAt: now, removedAt: now })
  try {
    if (member) {
      const auths = authorization.authScope(db, environment)
      const place = await auths.activePlaceOf(member.ownerCoachId)
      if (place) {
        const rows = await listWhere(db, 'packages', { ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, studentId: member.studentId })
        for (const pkgRow of rows) {
          const packageId = String(pkgRow.packageId || (pkgRow.data && pkgRow.data.id) || '')
          if (!packageId) continue
          const grant = await auths.findGrant(place, packageId, found.coachId)
          if (grant) await auths.writeGrant({ ...grant, status: authorization.STATUS_REVOKED, updatedAt: now })
        }
      }
    }
  } catch (error) { /* 关系已断 ⇒ 授权撤销失败不影响本次成功，也不允许回滚 */ }
  await writeAudit({ db, actorKey: `${actor.kind}:${actor.id}`, kind: 'remove', detail: (found.contactId || '').slice(0, 16), now })
  return { ok: true, contactKey: found.contactId || target, removed: true, historyKept: true, message: '已移除联系人，历史课程、收入与训练记录全部保留。' }
}

// ⑪ 会员详情（教练视角）：⛔ 只有主管教练能看到"可编辑"，由**服务端**裁决，客户端骗不了。
async function readMemberDetail({ db, environment, actor, payload }) {
  if (actor.kind !== ROLE_COACH) return { ok: false, code: 'NOT_A_COACH', message: '只有教练能查看会员详情。' }
  const memberId = cleanText(payload && payload.memberId, 64)
  const member = memberId ? await getRow(db, COLLECTIONS.members, fixedId('member-directory-member', memberId)) : null
  if (!member) return { ok: false, code: 'MEMBER_NOT_FOUND', message: CONTACT_TEXT.MEMBER_NOT_FOUND }
  const related = await oneRow(db, COLLECTIONS.contacts, { memberId, coachId: actor.id, status: CONTACT_ACTIVE })
  if (!related) return { ok: false, code: 'NOT_YOUR_CONTACT', message: '这位会员还不在你的会员列表里。' }
  const place = await ownerPlaceOf({ db, environment, member })
  const isOwner = String(member.ownerCoachId) === String(actor.id)
  const summary = place ? await memberPackageSummary({ db, member, place }) : { available: 0, occupied: 0, used: 0, packageCount: 0 }
  const rows = place ? await listWhere(db, 'bookings', { studentId: member.studentId }, 500) : []
  const history = []
  for (const row of rows) {
    const booking = row && row.data ? row.data : row
    if (String(row.ownerCoachId || '') !== String(actor.id) && !isOwner) continue
    history.push({ date: String(booking.date || ''), hour: Number(booking.hour || 0), minute: Number(booking.minute || 0), status: String(booking.status || 'booked'), typeName: String(booking.typeName || booking.category || '常规课') })
  }
  history.sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.hour) - Number(a.hour))
  return {
    ok: true, memberId,
    member: publicCardOf({ role: ROLE_MEMBER, id: memberId, displayName: member.displayName, publicCode: member.publicCode }),
    summary, isOwner, canEditCore: isOwner, history: history.slice(0, 60),
    // ⛔ 非主管教练必须看到这一句（۹ not "隐藏按钮就完事"）
    note: isOwner ? '' : CONTACT_TEXT.NOT_OWNER
  }
}

// ⑫ 改核心资料（昵称）：会员本人或主管教练可改；公开编号与微信身份都不可改。
async function updateMemberCore({ db, environment, actor, payload, now }) {
  const submittedId = cleanText(payload && payload.memberId, 64)
  // ⛔⛔ 会员本人这一支：身份**只认服务端认出来的自己**，客户端传 memberId 一律不当真
  //    （想靠传别人的 memberId 改别人资料 ⇒ 在这儿就断了）。
  if (actor.kind === ROLE_MEMBER && submittedId && String(submittedId) !== String(actor.id)) {
    return { ok: false, code: 'NOT_YOUR_PROFILE', message: '只能修改你自己的昵称。' }
  }
  const memberId = actor.kind === ROLE_MEMBER ? String(actor.id) : submittedId
  const member = memberId ? await getRow(db, COLLECTIONS.members, fixedId('member-directory-member', memberId)) : null
  if (!member) return { ok: false, code: 'MEMBER_NOT_FOUND', message: CONTACT_TEXT.MEMBER_NOT_FOUND }
  // ⭐ 会员本人只能改**自己的昵称**（这是"我的"页那一个输入框唯一能改的东西）。
  //   ⛔ 手机号会决定唯一会员身份 ⇒ 会员本人改手机号会造成"改完之后变成另一个人" ⇒ 一律不许。
  if (actor.kind === ROLE_MEMBER) {
    if (String(memberId) !== String(actor.id)) return { ok: false, code: 'NOT_YOUR_PROFILE', message: '只能修改你自己的昵称。' }
    const nickname = cleanText(payload && payload.displayName, 30)
    if (!nickname) return { ok: false, code: 'INVALID_PAYLOAD', message: '昵称不能为空。' }
    member.displayName = nickname
    member.updatedAt = now
    await setRow(db, COLLECTIONS.members, fixedId('member-directory-member', memberId), member)
    return { ok: true, memberId, updated: true, who: ROLE_MEMBER, member: publicCardOf({ role: ROLE_MEMBER, id: memberId, displayName: member.displayName, publicCode: member.publicCode }) }
  }
  if (actor.kind !== ROLE_COACH) return { ok: false, code: 'NOT_A_COACH', message: '只有教练能修改会员资料。' }
  // ⛔⛔ 权限的唯一真相源：客户端传什么都不管用，只认服务端那一行 `ownerCoachId`。
  if (String(member.ownerCoachId) !== String(actor.id)) return { ok: false, code: 'NOT_OWNER_COACH', message: CONTACT_TEXT.NOT_OWNER }
  const nextName = payload && payload.displayName == null ? '' : cleanText(payload.displayName, 30)
  if (!nextName) return { ok: false, code: 'INVALID_PAYLOAD', message: '没有需要修改的内容。' }
  if (nextName) member.displayName = nextName
  member.updatedAt = now
  await setRow(db, COLLECTIONS.members, fixedId('member-directory-member', memberId), member)
  // ⛔ 改昵称要同步下游学员记录（学员档案名不许出现两份口径）
  const place = await ownerPlaceOf({ db, environment, member })
  if (place && nextName) {
    try {
      const context = await core.activeContext(db, member.ownerCoachId, environment)
      await core.execute(db, member.ownerCoachId, {
        command: 'updateStudent', requestId: `mdir:${memberId.slice(0, 12)}:${now}`,
        expectedRevision: context.revision.dataRevision, payload: { studentId: member.studentId, name: nextName }
      }, { updateStudent: require('./handlers').handlers.updateStudent }, now, environment)
    } catch (error) { /* 主资料已改 ⇒ 不回滚；界面会看到新昵称 */ }
  }
  return { ok: true, memberId, updated: true, member: publicCardOf({ role: ROLE_MEMBER, id: memberId, displayName: member.displayName, publicCode: member.publicCode }) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

// ⭐⭐ 新方案会员身份唯一键 = 手机号（不是 openid）：教练建会员时按手机号固定 memberId，
//    因此「换手机 / 清缓存 / 重新进入」都回到同一个会员，绝不会出现"变成另一个人"或"多份档案"。
function memberIdByPhone(phone) { return fixedId('member-by-phone', String(phone || '').trim()) }

// ⑬ 手机号登录（新方案会员身份入口）：⛔ 只认服务端可信 OPENID + 客户端提交的可信手机号。
//    会员用微信官方手机号按钮 → 客户端把**可信手机号**交给云端 → 精确匹配 → 找到唯一会员 → 绑定本机 openid。
//    ⛔ 找不到只回「没有找到你的会员资料」，⛔ 绝不创建第二份会员、⛔ 绝不假装成功。
//    ⛔ 客户端提交的 memberId / openId 一律无效（见上方 SENSITIVE_KEYS 与白名单）。
async function loginByPhone({ db, openId, payload, now }) {
  const phone = cleanText(payload && payload.phone, 20)
  if (!/^1\d{10}$/.test(phone)) return { ok: false, code: 'PHONE_INVALID', message: '请输入正确的手机号。' }
  const member = await oneRow(db, COLLECTIONS.members, { phone })
  if (!member || member.status === CONTACT_REMOVED) {
    return { ok: false, code: 'MEMBER_NOT_FOUND', message: '没有找到你的会员资料，请联系教练核对手机号。' }
  }
  // ⛔ 同一个手机号恒定一个 memberId（教练建会员时已按手机号固定）；openid 只是"本机登录会话"，
  //    因此换手机 / 清缓存都不会让会员身份漂移。
  const publicCode = member.publicCode || publicCodeFor(ROLE_MEMBER, member.memberId)
  const needsAccount = !member.openId || String(member.openId) !== String(openId)
  if (needsAccount) {
    member.openId = String(openId)
    member.updatedAt = now
    await setRow(db, COLLECTIONS.members, fixedId('member-directory-member', member.memberId), member)
    await ensureMemberAccount({ db, member, openId, now })
  }
  return {
    ok: true, memberId: member.memberId,
    member: publicCardOf({ role: ROLE_MEMBER, id: member.memberId, displayName: member.displayName, publicCode }),
    needsProfile: !member.displayName
  }
}

// ⑭ 教练新建会员（新方案：手机号是会员唯一键）：⛔ 一个手机号只能有一份会员资料。
//    创建者自动成为 `ownerCoachId`（主管教练）；⛔ 绝不因为重复手机号生成第二份。
//    ⛔ 客户端提交 openId / memberId / ownerCoachId 一律无效。
async function createMemberByCoach({ db, environment, actor, payload, now }) {
  if (actor.kind !== ROLE_COACH) return { ok: false, code: 'COACH_ONLY', message: '只有教练可以新建会员。' }
  const phone = cleanText(payload && payload.phone, 20)
  if (!/^1\d{10}$/.test(phone)) return { ok: false, code: 'PHONE_INVALID', message: '请输入正确的手机号。' }
  const displayName = cleanText(payload && payload.displayName, 30)
  if (!displayName) return { ok: false, code: 'INVALID_PAYLOAD', message: '请填写会员昵称。' }
  const existing = await oneRow(db, COLLECTIONS.members, { phone })
  if (existing && existing.status !== CONTACT_REMOVED) {
    return { ok: false, code: 'PHONE_ALREADY_EXISTS', message: '这个手机号已经有会员资料了，请直接添加。', memberId: existing.memberId }
  }
  const memberId = memberIdByPhone(phone)
  const memberDocId = fixedId('member-directory-member', memberId)
  const context = await core.activeContext(db, actor.id, environment)
  const created = await core.execute(db, actor.id, {
    command: 'createStudent', requestId: `mdir:${memberId.slice(0, 12)}:${now}`,
    expectedRevision: context.revision.dataRevision, payload: { name: displayName, phone }
  }, { createStudent: require('./handlers').handlers.createStudent }, now, environment)
  if (!created || !created.ok || !(created.result && created.result.studentId)) return created || { ok: false, code: 'MEMBER_LINK_FAILED', message: '新建会员失败，请重试。' }
  const studentId = created.result.studentId
  const publicCode = publicCodeFor(ROLE_MEMBER, memberId)
  const member = {
    memberId, phone, displayName, publicCode,
    ownerCoachId: actor.id, ownerDatasetId: String(context.datasetId || ''), studentId, status: CONTACT_ACTIVE,
    createdByCoachId: actor.id, createdAt: now, updatedAt: now
  }
  await setRow(db, COLLECTIONS.members, memberDocId, member)
  // 创建者即主管教练 ⇒ 自动建立一条联系人关系（会员列表出现对方）。
  await writeContact({ db, environment, memberId, coachId: actor.id, actorKey: `coach:${actor.id}`, source: 'coach-created', now })
  return {
    ok: true, created: true, memberId,
    member: publicCardOf({ role: ROLE_MEMBER, id: memberId, displayName, publicCode }),
    summary: { available: 0, occupied: 0, packageCount: 0 }
  }
}

// ⑮ 手机号换取（⛔ 微信接口依赖）：把 `getPhoneNumber` 返回的 `code` 换成可信手机号。
//    ⛔ 需要微信公众平台开通「获取手机号」能力 + 小程序完成验证 + 配置隐私声明。
//    ⛔ 拿不到时**如实报缺口**，⛔ 绝不返回假手机号、⛔ 绝不假装登录成功。
async function resolvePhoneCode({ cloud, payload }) {
  const code = cleanText(payload && payload.code, 200)
  if (!code) return { ok: false, code: 'PHONE_CODE_MISSING', message: '没有拿到手机号授权结果。' }
  if (!cloud || !cloud.openapi || typeof cloud.openapi.getuserphonenumber !== 'function') {
    return { ok: false, code: 'PHONE_API_UNAVAILABLE', message: '本小程序尚未开通手机号获取能力：请在微信公众平台「开发 → 接口设置」开通「获取手机号」，并完成小程序验证与隐私声明后再使用。' }
  }
  try {
    const res = await cloud.openapi.getuserphonenumber({ code })
    const phone = res && res.phone_info && res.phone_info.phoneNumber
    if (!phone) return { ok: false, code: 'PHONE_API_EMPTY', message: '微信没有返回手机号，请重试或改用其他方式。' }
    return { ok: true, phone: String(phone).trim() }
  } catch (error) {
    return { ok: false, code: 'PHONE_API_FAILED', message: '手机号换取失败（可能能力未开通或权限不足）：请在微信公众平台确认「获取手机号」能力已开通。' }
  }
}

const ACTIONS = Object.freeze([
  'dashboard', 'issueTicket', 'drawTicketQr', 'resolveTicket', 'findByCode', 'addContact',
  'listContacts', 'removeContact', 'readMemberDetail', 'updateMemberCore', 'loginByPhone', 'resolvePhoneCode', 'createMemberByCoach'
])
// 📱 扫码后打开的**确认页**：⛔ 扫码只到这里，**绝不**自动添加（见到人确认才建立关系）。
const RESOLVE_PAGE = 'pages/member-add-coach/member-add-coach'
const COACH_ADD_MEMBER_PAGE = 'pages/coach-add-member/coach-add-member'
const QR_ENV_VERSION = 'trial'

function validateRequestId(value) {
  const text = cleanText(value, 90)
  if (!/^[A-Za-z0-9:_-]{8,90}$/.test(text)) throw commandError('INVALID_REQUEST_ID', '请求编号无效。')
  return text
}

function createDirectory({ db, cloud = null, getOpenId = () => '', now = () => Date.now(), environment = 'sandbox', ttlMs = TICKET_TTL_MS }) {
  return async event => {
    const source = event || {}
    try {
      // ⓵ 环境闸（**在读任何集合之前**）：⛔ 不是 sandbox ⇒ 零集合访问。
      if (core.environmentOf(source.environment) !== core.SANDBOX) {
        return { ok: false, code: core.SANDBOX_REJECT_CODE, message: core.SANDBOX_REJECT_MESSAGE, environment: core.SANDBOX }
      }
      const action = cleanText(source.action, 48)
      if (ACTIONS.indexOf(action) < 0) return { ok: false, code: 'UNKNOWN_ACTION', message: '不支持的操作。' }
      const openId = getOpenId()
      if (!openId) return { ok: false, code: 'IDENTITY_MISSING', message: '未能确认当前微信身份。', environment: core.SANDBOX }
      // ⓶ 敏感字段：定位 / 归属 / 开放 ID 一律拒（伪造 ownerCoachId 的入口在这儿就断了）。
      const forbidden = sensitiveIn(source.payload || {})
      if (forbidden) return { ok: false, code: 'FORBIDDEN_IDENTITY_INPUT', message: `客户端不得提交身份或数据定位字段：${forbidden}`, environment: core.SANDBOX }
      // ⓷ 按动作收字段白名单（超出的一律拒，不做宽容忽略）。
      const allowed = PAYLOAD_KEYS[action] || []
      const extra = Object.keys(source.payload || {}).filter(key => allowed.indexOf(key) < 0)
      if (extra.length) return { ok: false, code: 'INVALID_PAYLOAD', message: `包含不允许的字段：${extra.join('、')}`, environment: core.SANDBOX }
      const requestId = validateRequestId(source.requestId)
      const stamped = now()
      const payload = source.payload || {}
      await ensureSandboxCollections(db)
      // 第一次进入时没有会员身份也可以创建；身份只取可信 OPENID。
      if (action === 'loginByPhone') return { ...(await loginByPhone({ db, openId, payload, now: stamped })), environment: core.SANDBOX, requestId }
      if (action === 'resolvePhoneCode') return { ...(await resolvePhoneCode({ cloud, payload })), environment: core.SANDBOX, requestId }
      // 同一个微信可能既是教练又绑定了会员资料。会员页面的动作必须优先按会员身份，
      // 否则会把 actor.memberId 读成空值，真机首页就会整页空白。
      const memberOnlyActions = new Set(['dashboard', 'loginByPhone'])
      let actor
      if (memberOnlyActions.has(action)) {
        const memberRow = await oneRow(db, COLLECTIONS.members, { openId })
        if (!memberRow || memberRow.status === CONTACT_REMOVED) return { ok: false, code: 'MEMBER_NOT_FOUND', message: '当前微信还没有绑定会员资料。', environment: core.SANDBOX, requestId }
        actor = { kind: ROLE_MEMBER, id: memberRow.memberId, memberId: memberRow.memberId, openId, memberRow }
      } else actor = await actorOf({ db, openId })
      if (actor.kind === ROLE_COACH) await ensureCoachCard({ db, coachId: actor.id, now: stamped })
      if (action === 'dashboard') return { ...(await readDashboard({ db, environment: core.SANDBOX, actor, now: stamped })), environment: core.SANDBOX, requestId }
      if (action === 'issueTicket') {
        const issued = await issueTicket({ db, actor, now: stamped, ttlMs })
        return { ok: true, ticket: issued.ticket, scene: issued.scene, expiresAt: issued.expiresAt, ttlMs: issued.ttlMs, containsSecrets: false, environment: core.SANDBOX, requestId }
      }
      if (action === 'drawTicketQr') return { ...(await drawTicketQr({ db, cloud, actor, now: stamped, ttlMs })), environment: core.SANDBOX, requestId }
      if (action === 'resolveTicket') {
        const resolved = await resolveTicket({ db, ticket: payload.ticket, now: stamped })
        if (!resolved.ok) return { ...resolved, environment: core.SANDBOX, requestId }
        // ⛔ 出口层剥掉内部定位：客户端（确认页）只拿得到确认卡与票据号。
        return { ok: true, ticketId: resolved.ticketId, card: resolved.card, environment: core.SANDBOX, requestId }
      }
      if (action === 'findByCode') return { ...(await findByCode({ db, actor, payload, now: stamped })), environment: core.SANDBOX, requestId }
      if (action === 'addContact') return { ...(await addContact({ db, environment: core.SANDBOX, actor, payload, now: stamped })), environment: core.SANDBOX, requestId }
      if (action === 'listContacts') return { ...(await listContacts({ db, environment: core.SANDBOX, actor })), environment: core.SANDBOX, requestId }
      if (action === 'removeContact') return { ...(await removeContact({ db, environment: core.SANDBOX, actor, payload, now: stamped })), environment: core.SANDBOX, requestId }
      if (action === 'createMemberByCoach') return { ...(await createMemberByCoach({ db, environment: core.SANDBOX, actor, payload, now: stamped })), environment: core.SANDBOX, requestId }
      if (action === 'readMemberDetail') return { ...(await readMemberDetail({ db, environment: core.SANDBOX, actor, payload })), environment: core.SANDBOX, requestId }
      return { ...(await updateMemberCore({ db, environment: core.SANDBOX, actor, payload, now: stamped })), environment: core.SANDBOX, requestId }
    } catch (error) {
      return { ok: false, code: error.commandCode || 'MEMBER_DIRECTORY_FAILED', message: error.message || '操作失败，请重试。', environment: core.SANDBOX, extra: error.extra || {} }
    }
  }
}

module.exports = {
  COLLECTIONS, ROLE_MEMBER, ROLE_COACH, CONTACT_ACTIVE, CONTACT_REMOVED, CONTACT_TEXT,
  LOOKUP_LIMIT, LOOKUP_WINDOW_MS, ACTIONS,
  publicCodeFor, normalizePublicCode, publicCardOf, sensitiveIn, PAYLOAD_KEYS, todayKey, ensureSandboxCollections,
  RESOLVE_PAGE, COACH_ADD_MEMBER_PAGE, translateQrError, drawTicketQr, renderContactMiniCode,
  createDirectory, memberIdForOpenId, memberIdByPhone, rebindClaim, writeContact, grantPackagesToCoach, recentTraining, memberIdByOpenId, resolvePhoneCode
}
