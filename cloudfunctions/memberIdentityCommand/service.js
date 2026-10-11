const crypto = require('crypto')
// ⭐ M3-P2-3：8 位人工短码。本目录与 `coachBusinessCommand` 各存一份**逐字节相同**的孪生实现。
const shortCode = require('./short-code')
// ⭐⭐ 会员域权威契约（集合名 / 认领状态 / 档案视图 ID）。
//   孪生副本在 `readMyMemberData/member-contract.js`，由 tests/member-archive-contract.test.js 钉死一致。
const contract = require('./member-contract')

// ⛔ `coachId` / `claimId` 也进了黑名单：没有任何一条合法命令需要客户端提交它们
//    （教练侧命令要的是 studentId，会员侧命令要的是不透明 archiveId）⇒ 禁掉零风险，
//    而且堵住"客户端自报一个 coachId 试图越权"的入口。
const FORBIDDEN = new Set(['OPENID', 'openId', 'openid', '_openid', 'ownerCoachId', 'datasetId', 'memberId', 'claimId', 'coachId'])
// ⭐⭐ 2026-10-03：**逐命令**的 payload 白名单。
//   ⛔ 为什么不能只靠全局 FORBIDDEN：`studentId` 对教练命令（createClaimToken）
//      是**必需**的合法入参，不能全局禁掉；但对 `releaseStudentClaim` 它就是越权定位字段。
//      ⇒ 同一个键在不同命令下的合法性不同，就必须在**命令层**再判一次。
//   ⛔ 白名单只给本轮新增/改动的命令加，老命令一字不动（避免"为了安全顺手改了别人"的连带风险）。
const PAYLOAD_ALLOW = {
  releaseStudentClaim: ['archiveId'],
  // ⭐ 2026-10-04 需求 D-6：分页。`cursor` / `limit` 都**不是定位字段**（定位字段一律在 FORBIDDEN 里），
  //   它们只决定"读哪一页、读多少"，⛔ 不影响身份安全：coachId 只来自服务端可信 OPENID。
  // ⭐⭐ 2026-10-04 需求 B：分享链接里**不许**出现明文认领码 ⇒ 改成「服务端不透明邀请票据」。
  //   ⛔ `claimByInvite` 只认一个不透明 ticket：教练归属（coachId）与学员归属（studentId）
  //      **全部由服务端在签发时写死**，客户端一个字节都不许自报 ⇒ 「串领」在协议层就做不到。
  claimByInvite: ['inviteTicket', 'claimScene'],
  previewClaimInvite: ['inviteTicket', 'claimToken', 'claimScene'],
  createClaimInvite: ['studentId'],
  createClaimQrCode: ['studentId', 'inviteTicket']
}
// ⭐⭐ execute 通道里的**只读命令白名单**（2026-10-04）。理由见 `if (READ_ONLY_COMMANDS…)` 那段。
//   ⛔ 白名单而非黑名单：新命令默认要过完整的事务 + 回执 + revision 三道闸。
const READ_ONLY_COMMANDS = ['previewClaimInvite']
// ⭐⭐ 2026-10-04 · **只读预览**（`previewClaimInvite`）不许客户端提交任何定位字段。
//   ⛔ 它虽然走 execute 通道（页面不能自己 `wx.cloud.callFunction`，见 READ_ONLY_COMMANDS 那段），
//      但预览绝不能像普通命令那样"什么字段都能带" —— 能自报 studentId 就等于能问出别人档案的信息。
//      ⇒ 这里有**自己的一道**白名单，与 PAYLOAD_ALLOW 各自独立（两处都要有，缺一处就是绕过口）。
// ⭐ 入参：**三者必须恰好给一个**（票据 = 分享卡主路径，场景码 = 小程序码，短码 = 兜底通道）
//   —— ⛔ 绝不允许两个都带（用哪个没有唯一答案，唯一性正是防串领的地基）。
const PREVIEW_ALLOW = ['inviteTicket', 'claimToken', 'claimScene']
function assertOnlyKeys(allow, payload, code, label) {
  const extra = Object.keys(payload || {}).filter(key => allow.indexOf(key) < 0)
  if (extra.length) throw Object.assign(new Error(`「${label}」不接受这个字段：${extra[0]}`), { code })
  return payload || {}
}
function payloadFieldNotAllowed(action, payload) {
  const allow = PAYLOAD_ALLOW[action]
  if (!allow) return ''
  const extra = Object.keys(payload || {}).filter(key => allow.indexOf(key) < 0)
  return extra.length ? extra[0] : ''
}
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const memberIdFor = openId => sha(`member:${openId}`).slice(0, 32)
const coachIdFor = openId => sha(`coach:${openId}`).slice(0, 32)
const fixedId = (...parts) => sha(parts.join(':')).slice(0, 32)
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })
const ok = value => ({ ok: true, ...value })

function forbiddenPath(value, path = 'event') {
  if (!value || typeof value !== 'object') return ''
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key)) return `${path}.${key}`
    const nested = forbiddenPath(value[key], `${path}.${key}`)
    if (nested) return nested
  }
  return ''
}

// ⛔ 集合名**只有一个出处**（member-contract.js 的 memberNames）。旧实现在本文件里另抄了一份，
//    而 `readMyMemberData` 又抄了第三份且字段更少 —— 集合名抄错在假 DB 里照样全绿、真机上却永远查不到。
function names(environment) { return contract.memberNames(environment) }

// ─────────────────────────────────────────────────────────────────────────────
// ⭐⭐ 2026-10-04 需求 B · **不透明邀请票据**（invite ticket）
//
// 🚨 为什么不能把 8 位认领码放进分享链接（这是本轮最硬的一条安全红线）：
//   ① 8 位 Crockford 只有 32^8 ≈ 8.5e11 的空间 —— 这是**人工可读**码的代价：短到能被暴力枚举。
//      放进 URL 就等于把它变成一个**可被任何人拿到并离线穷举**的凭据（聊天记录、截图、日志、
//      浏览器历史都会留存链接）。短码被猜中 = 学员档案被**别人**认领。
//   ② 认领码是**兜底**通道（会员手输 / 口述），它的安全前提是"只在教练与会员之间流转"。
//      一旦进 URL，就同时出现在两个通道上 ⇒ 兜底通道也一起被泄露了。
//   ③ 链接会被**转发**。带码的链接被转发 = 认领权被转发，防串领只剩"谁先点"这一层。
//
// ⭐ 本轮选定的方案：**服务端换票（server-side exchange）** —— 链接里只放一个不透明 ticket。
//   · ticket = 服务端随机 32 字节 base64url（43 字符），库内**只存 sha256**，明文不落库。
//   · ticket 与认领码在库里是**两条不同的行**（不同 _id、不同 hash 前缀）⇒ 二者互不影响：
//     链接泄露**拿不到**可读的认领码；短码泄露也**换不出**可用的 ticket。
//   · ticket 一次性、15 分钟、绑定「这个教练的这位学员」—— 归属由**服务端签发时写死**。
//   · 会员点开链接先 `previewClaimInvite`（**只读**、不写任何东西）看到「教练 X 邀请你认领学员 Y」
//     与有效期，**点确认之后**才 `claimByInvite` 真正写入。
//
// ⛔ 因此 `claimByInvite` 的 payload 白名单只有 `inviteTicket` 一个字段：
//    客户端**没有任何办法**自报 coachId / studentId 来"认领别人的档案"（服务端从 ticket 行里读）。
const INVITE_PREFIX = 'claim-invite:'
const INVITE_TTL_MS = 15 * 60 * 1000
const inviteHashOf = ticket => sha(`${INVITE_PREFIX}${ticket}`)
// 🎫 生成一枚邀请票据。⛔ 32 字节 = 256 bit 随机：不可枚举，也**不承载任何信息**
//    （教练名、学员名都在库里按 ticket 反查，⛔ 绝不放进票据本体 —— 那样等于把隐私写进 URL）。
function newInviteTicket() { return crypto.randomBytes(32).toString('base64url') }
// 📖 票据的**唯一**合法形状：`^[A-Za-z0-9_-]{43}$`（32 字节 base64url 的精确长度）。
//    ⛔ 长度/字符集都要卡：否则一个任意短串会被当成"合法但查不到"的票，把两种错误混成一种。
const INVITE_TICKET_RE = /^[A-Za-z0-9_-]{43}$/
function normalizeInviteTicket(raw) {
  const value = cleanText(raw, 64)
  if (!INVITE_TICKET_RE.test(value)) throw Object.assign(new Error('这张邀请看起来不完整，请让教练重新发一次。'), { code: 'INVITE_TICKET_MALFORMED' })
  return value
}
// 🔎 按票据取那一行。⛔ 主键 `fixedId(n.tokens, inviteHash)` 与认领码的
//    `fixedId(n.tokens, tokenHash)` 是**不同的 _id**（hash 输入不同）⇒ 两种凭据永不互相命中。
async function findInviteRow(scope, n, rawTicket) {
  const inviteTicket = normalizeInviteTicket(rawTicket)
  const inviteHash = inviteHashOf(inviteTicket)
  return { inviteTicket, inviteHash, row: await one(scope, n.tokens, { _id: fixedId(n.tokens, inviteHash), inviteHash }) }
}

// 🎫✂️ 成对签发一次「邀请」（2026-10-04）：**一枚不透明 ticket + 一枚 8 位人工短码**，同一有效期。
//   ⭐ 为什么要成对：主路径（分享 ticket）与兜底（口述 / 手抄短码）**必须同时可用** ——
//     会员在微信里打不开链接、或教练见面直接念码时，兜底通道独立成立，不依赖任何网络会话。
//   ⛔ 两行**各自独立**计数与作废：用掉 ticket 不作废短码（反之亦然），
//     所以"分享链接被转发"最多烧掉主路径，教练手上那张码还能继续用。
//   ⛔ 两行都**只存 hash**，明文短码 / ticket 都不落库（沿用 createClaimToken 的既有纪律）。
//   ⚠️ 短码查重与 createClaimToken 同理由：主键是 hash ⇒ 撞码是**静默覆盖**（= 覆盖别人的档案），
//      属越权级事故，所以连撞 5 次就明确失败，绝不覆盖。
async function mintClaimCredential(scope, n, coach, student, timestamp) {
  const studentId = cleanText(student.studentId, 64)
  const expiresAt = timestamp + INVITE_TTL_MS
  // ① 8 位人工短码（兜底通道）
  let claimToken = '', tokenHash = '', tokenId = ''
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const candidate = shortCode.generate()
    const candidateHash = sha(`claim:${candidate}`), candidateId = fixedId(n.tokens, candidateHash)
    if (!await one(scope, n.tokens, { _id: candidateId })) { claimToken = candidate; tokenHash = candidateHash; tokenId = candidateId; break }
    if (attempt === 5) throw Object.assign(new Error('认领码生成失败，请稍后重试。'), { code: 'CLAIM_CODE_COLLISION' })
  }
  await put(scope, n.tokens, tokenId, { tokenHash, coachId: coach.coachId, studentId, datasetIdAtIssue: coach.datasetId, issuedByCoachId: coach.coachId, useCount: 0, maxUses: 1, status: 'available', expiresAt, createdAt: timestamp })
  // ② 不透明邀请票据（主路径 / 分享链接里唯一出现的东西）
  //    ⛔ 256 bit 随机 ⇒ 查重只是** belt-and-braces **（撞了就是有人拿着同一个 ticketHash 来换票，
  //      那必须拒绝而不是覆盖），所以这里撞了就直接再掷一次。
  let inviteTicket = '', inviteHash = '', inviteId = ''
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const candidate = newInviteTicket()
    const candidateHash = inviteHashOf(candidate), candidateId = fixedId(n.tokens, candidateHash)
    if (!await one(scope, n.tokens, { _id: candidateId })) { inviteTicket = candidate; inviteHash = candidateHash; inviteId = candidateId; break }
    if (attempt === 5) throw Object.assign(new Error('邀请票据生成失败，请稍后重试。'), { code: 'INVITE_TICKET_COLLISION' })
  }
  // ⚠️ 归属**在这里写死**：这一行里的 coachId / studentId 就是日后会员能认领的唯一目标。
  //   客户端永远拿不到、也永远改不了这两个值（claimByInvite 的白名单只有一个 inviteTicket）。
  // ③ 小程序码的 `scene`（微信硬限制：**≤32 个字符**）。
  //   ⛔ 43 字符的 inviteTicket 塞不进 scene（微信会直接拒绝），⛔ 更不许把 ticket 截断
  //     （截断 = 随机空间骤降，一张二维码可以被枚举出来 ⇒ 等于把认领权挂在外面）。
  //   ⇒ 另生成一个**短场景码**写进票据行，二维码里只放它；扫码后由服务端**反查**那一行。
  //     这样上线的二维码只是门牌号，真正的凭证仍然只有服务端见过。
  let claimScene = ''
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const candidate = `${shortCode.generate()}${shortCode.generate()}`
    if (!await one(scope, n.tokens, { claimScene: candidate })) { claimScene = candidate; break }
    if (attempt === 5) throw Object.assign(new Error('邀请场景码生成失败，请稍后重试。'), { code: 'CLAIM_SCENE_COLLISION' })
  }
  await put(scope, n.tokens, inviteId, { inviteHash, claimScene, kind: 'invite', coachId: coach.coachId, studentId, datasetIdAtIssue: coach.datasetId, issuedByCoachId: coach.coachId, useCount: 0, maxUses: 1, status: 'available', expiresAt, createdAt: timestamp })
  return { inviteTicket, inviteHash, claimToken, expiresAt, claimScene }
}

// 🧾 会员侧**只读**预览：这份邀请到底是谁发的、认领谁的、还有效吗、是不是已经被人认领了。
//   ⭐ 这是"点开链接 ≠ 自动认领"的关键：页面先拿它渲染确认卡，用户点确认才发 claimByInvite。
//   ⛔ 全程**零写入**：不碰 claims / 不碰 tokens / 不碰 revisions —— 反复点开链接不会消耗任何东西。
//   ⚠️ 教练名取自**公开教练卡**（profiles），不是签发时快照 ⇒ 教练改过名字后，
//      会员看到的一直是ta 当前对外的名字，不会看到一份"过期的教练名"。
//   ⚠️ 学员名**脱敏**后下发（`姓**`）：链接可能被转发，⛔ 不把完整姓名写进 URL 之外的下发面。
async function describeInvite(scope, n, ticketRow, timestamp) {
  const profile = await one(scope, n.profiles, { _id: fixedId(n.profiles, ticketRow.coachId), coachId: ticketRow.coachId })
  const student = await one(scope, 'students', { ownerCoachId: ticketRow.coachId, datasetId: ticketRow.datasetIdAtIssue, studentId: ticketRow.studentId })
  const fullName = student && student.data && student.data.name ? String(student.data.name) : ''
  return {
    coachName: profile ? (profile.displayName || '教练') : '教练',
    // ⛔ 脱敏：即使链接被转发，看到的也只是"张**"这样的弱信息。
    studentName: fullName ? `${fullName.slice(0, 1)}**` : '这份学员记录',
    // ⭐ 完整姓名**不给**会员：会员确认的是"我认领这份记录"这件事，不是"我知道 TA 叫什么"。
    hasStudent: !!student,
    expiresAt: Number(ticketRow.expiresAt) || 0
  }
}

// 🧾 会员侧**只读**预览的核心（action 与只读 execute 命令**共用这一段**，保证两条通道逐字一致）。
//   ⭐ 绝不写任何东西：claims / tokens / revisions / receipts 一律不碰 —— 反复点开链接零副作用。
//   ⚠️ 查不到有**两种**完全不同的原因，⛔ 绝不能都报"无效"：
//     ① 环境不对（测试区发的票拿到正式区用）—— 最常见的一种，教练自己都不知道有这一步；
//     ② 票真的不存在 / 已被清理。
//   ⛔ 这里**不做**"到另一个环境去找"的兜底：那等于让一张测试区的票在正式区生效。
//   📋 状态**如实**下发（页面据此显示哪种人话，而不是靠猜错误码）：
//     expired → 已过期 ｜ already-claimed → 已被别人认领 ｜ already-mine → 你自己已认领
//     used → 票据已被用掉（一次性）｜ available → 可以认领
//   ⚠️ 判定顺序有讲究：**先判已过期**（时间是最客观的事实），再判已用。
//     反过来的话，"又过期又被人用过"的票会显示"已被认领"，会员去联系教练，
//     而真实原因是"你来晚了" —— 教练查半天也查不出来。
async function previewInviteByTicket(scope, n, credential, memberId, timestamp) {
  const { kind, row } = await findCredentialRow(scope, n, credential.inviteTicket, credential.claimToken, credential.claimScene)
  const detail = await describeInvite(scope, n, row, timestamp)
  const expired = Number(row.expiresAt) <= timestamp
  const claimed = await rows(scope, n.claims, { coachId: row.coachId, studentId: row.studentId })
  const active = claimed.filter(contract.isClaimActive)
  const activeOther = active.find(entry => entry.memberId !== memberId)
  const activeMine = active.find(entry => entry.memberId === memberId)
  let state = 'available'
  if (expired) state = 'expired'
  else if (activeOther) state = 'already-claimed'
  else if (activeMine) state = 'already-mine'
  else if (row.status !== 'available') state = 'used'
  // ⭐ `kind` 如实下发：页面据此知道点确认时该发哪条命令（票据 = claimByInvite，短码 = claimStudentRecord）。
  //   ⛔ 短码**过期**时报 CLAIM_TOKEN_INVALID 而不是 INVITE_EXPIRED —— 那是给"你输入的码"用的说法。
  // ⭐ `viaScene` 如实下发：页面据此在【点确认】时回传 **场景值** 而不是票据
  //    （扫码的人手里从来没有 ticket，只有二维码里那个短场景码）。
  return { environment: n.environment, kind, state, viaScene: !!(credential && credential.claimScene), ...detail }
}

// 🔎 凭据 → 那一行。**票据与短码共用这一个出口**，⛔ 但两者查的**不是同一张表**：
//   票据 `inviteHash = sha('claim-invite:' + ticket)`，短码 `tokenHash = sha('claim:' + code)`，
//   各自的 _id 来自不同的 hash ⇒ ⛔ 一张票据永远不可能被当成一枚短码兑换（反之亦然）。
//   ⭐ 归一化与 claimStudentRecord 逐字同一条（纠正口述误输 O→0 / I,L→1 / U→V、忽略空格与连字符），
//   ⛔ 但**只对"看起来就是 8 位短码"的输入动手** —— 历史 24 位长码是**区分大小写**的 base64url，
//      一旦被 toUpperCase 就再也兑换不了（这是必须守住的一条）。
async function findCredentialRow(scope, n, rawTicket, rawCode, rawScene) {
  const hasTicket = !!cleanText(rawTicket, 64), hasCode = !!cleanText(rawCode, 128), hasScene = !!cleanText(rawScene, 64)
  // ⛔ 三种凭据必须**恰好有一个**：两个都带时"用哪个"没有唯一答案，而唯一性正是防串领的地基。
  const given = [hasTicket, hasCode, hasScene].filter(Boolean).length
  if (given !== 1) throw Object.assign(new Error(given ? '一次只能用一种凭据（邀请链接 / 二维码 / 认领码）。' : '请提供邀请、二维码或认领码。'), { code: 'INVALID_PAYLOAD' })
  // 🎫 小程序码场景值 → 票据行。⛔ 场景值只是门牌号：查不到就**明确说不是邀请**，
  //    绝不回退去查短码表（否则"扫了别人的码"会变成一条无法排查的谜）。
  if (hasScene) {
    const row = await one(scope, n.tokens, { claimScene: cleanText(rawScene, 64), kind: 'invite' })
    if (!row) throw Object.assign(new Error('这个二维码不是有效的认领邀请，或者教练已经重新发过一次。请让教练重新发一个。'), { code: 'INVITE_NOT_FOUND' })
    return { kind: 'invite', row, viaScene: true }
  }
  if (hasTicket) {
    const found = await findInviteRow(scope, n, rawTicket)
    if (found.row) return { kind: 'invite', row: found.row }
    // ⛔ 票据查不到时**不**回退去查短码表：两者是不同凭据，混在一起就成了"什么都试一遍"，
    //    那会让"这张邀请无效"变成一条无法排查的谜。
    throw Object.assign(new Error('这张邀请不是教练发给你的，或者已经被清理了。请让教练重新发一次。'), { code: 'INVITE_NOT_FOUND' })
  }
  const code = shortCode.normalize(cleanText(rawCode, 128))
  const tokenHash = sha(`claim:${code}`), tokenId = fixedId(n.tokens, tokenHash)
  const row = await one(scope, n.tokens, { _id: tokenId, tokenHash })
  if (!row) throw Object.assign(new Error('这个认领码不存在，请让教练重新发一个。'), { code: 'CLAIM_TOKEN_INVALID' })
  return { kind: 'code', row }
}

async function rows(scope, name, query) {
  const response = await scope.collection(name).where(query).limit(100).get()
  return response && response.data || []
}
async function one(scope, name, query) { return (await rows(scope, name, query))[0] || null }

// ⭐ CloudBase 真机契约（2026-09-28 真机 -501007 定案）：`doc(id).set()` 的 data **不允许包含 `_id`**
//    （报错「document.set:fail -501007 invalid parameters. 不能更新_id的值」）。
//    文档的真实 `_id` 由 `doc(id)` 指定：doc 不存在 ⇒ 以该 id **创建**；存在 ⇒ **整体覆盖**。
//    ⇒ 新增与更新天然同一写法，绝不能把读取到的整份文档（含 _id）原样回写。
//    公开码稳定性由 publishCoachProfile 保证：已有公开码的教练**原封保留**（含 B 正式区 41c0e373e7、
//    Sandbox 预置 TEST-xxxxxx 之外的历史码），没有才由服务端生成 8 位 Crockford 短码 ⇒ 重复保存码不漂移。
async function put(scope, name, id, data) {
  const body = { ...(copy(data) || {}) }
  delete body._id
  return scope.collection(name).doc(id).set({ data: body })
}
async function remove(scope, name, id) { return scope.collection(name).doc(id).remove() }

// 认领关系的业务主键。⚠️ 历史行理论上可能缺这个字段（老数据），所以一律容错成空串，
//    空串**不会**被当成"有效目标"（下面 releaseStudentClaim 会显式拒绝）。
const claimIdOf = claim => String((claim && claim.claimId) || '')

function publicMember(account) {
  // ⭐ 2026-10-05：主题切换已撤回 ⇒ 会员画像**不再下发** theme（客户端不再显示/不再存它）。
  return { displayName: account.displayName || '', status: account.status || 'active' }
}
function publicProfile(profile) {
  return { coachId: profile.coachId, displayName: profile.displayName || '教练', avatar: profile.avatar || '', specialties: Array.isArray(profile.specialties) ? profile.specialties : [], introduction: profile.introduction || '' }
}
function cleanText(value, max) { return String(value == null ? '' : value).trim().slice(0, max) }
function requestIdOf(event) {
  const value = cleanText(event.requestId, 96)
  if (!/^[A-Za-z0-9:_-]{8,96}$/.test(value)) throw Object.assign(new Error('请求编号无效。'), { code: 'INVALID_REQUEST_ID' })
  return value
}
function payloadHash(event) { return sha(JSON.stringify({ action: event.action, payload: event.payload || {} })) }

async function ensureMember(scope, n, openId, timestamp) {
  const memberId = memberIdFor(openId), id = fixedId(n.accounts, memberId)
  let account = await one(scope, n.accounts, { _id: id, memberId })
  if (!account) {
    // ⭐ `openId` 是**本小程序**的 app-scoped 标识：微信订阅消息要用它当 `touser`
    //   （云端拿不到"另一个人"的 openid，只能读这里）。⛔ 它只在服务端用，
    //   ⛔ 只读接口（`readMyMemberData`）与任何会员端下发里**一个字节都不带它**。
    account = { memberId, identityHash: sha(`openid:${openId}`), openId, displayName: '', status: 'active', createdAt: timestamp, updatedAt: timestamp }
    await put(scope, n.accounts, id, account)
    return account
  }
  // ⭐ 历史账号（本字段上线之前就存在的）在**下一次正常访问**时补上，不需要任何批量迁移。
  //   ⛔ 只补这一个字段，其余字段一个字都不动。
  if (!account.openId) {
    account = { ...account, openId }
    await put(scope, n.accounts, id, account)
  }
  return account
}

async function coachContext(scope, n, openId) {
  const coachId = coachIdFor(openId)
  const coach = await one(scope, 'coaches', { _id: coachId, openId })
  if (!coach || coach.status !== 'active') throw Object.assign(new Error('当前微信不是有效教练账号。'), { code: 'COACH_NOT_FOUND' })
  // Head document IDs belong to the coach infrastructure. Member services must
  // not duplicate that private hashing contract; trusted owner + environment is
  // the stable cross-module lookup contract.
  const query = n.environment === 'sandbox' ? { ownerCoachId: coachId, environment: 'sandbox' } : { ownerCoachId: coachId }
  const heads = await rows(scope, n.coachHeads, query)
  if (heads.length > 1) throw Object.assign(new Error('教练数据空间关系不唯一。'), { code: 'COACH_DATASET_HEAD_AMBIGUOUS' })
  const head = heads[0] || null
  if (!head || !head.activeDatasetId) throw Object.assign(new Error('教练数据空间尚未就绪。'), { code: 'COACH_DATASET_NOT_FOUND' })
  return { coachId, datasetId: head.activeDatasetId }
}

// 🎨 二维码生成能力（**可选注入**）：`qrCode({ticket, coachId, studentId, expiresAt}) => imageUrl`。
//   ⭐ 由 `index.js` 注入（那里才有 `cloud.openapi.wxacode.getUnlimited`）。⛔ **没注入就是没有**：
//   本轮该接口权限尚未在微信公众平台开通 ⇒ 命令必须如实回 `QRCODE_CAPABILITY_UNAVAILABLE`，
//   ⛔ 绝不允许"假装生成成功"或返回一张占位图 —— 那会让教练以为二维码能用了。
function createService({ db, getOpenId, now = () => Date.now(), qrCode = null }) {
  return async event => {
    event = event || {}
    const topLevelIdentityInput = [...FORBIDDEN].find(key => Object.prototype.hasOwnProperty.call(event, key))
    const identityInput = topLevelIdentityInput ? `event.${topLevelIdentityInput}` : forbiddenPath(event.payload || {})
    if (identityInput) return fail('FORBIDDEN_IDENTITY_INPUT', `客户端不得提交身份归属字段：${identityInput}`)
    const openId = getOpenId()
    if (!openId) return fail('IDENTITY_MISSING', '未能确认当前微信身份。')
    const n = names(event.environment), timestamp = now()
    if (event.action === 'bootstrap') {
      try {
        const account = await ensureMember(db, n, openId, timestamp)
        return ok({ environment: n.environment, created: account.createdAt === timestamp, member: publicMember(account) })
      } catch (error) { return fail(error.code || 'MEMBER_BOOTSTRAP_FAILED', error.message || '会员空间初始化失败。') }
    }
    if (event.action === 'getReceipt') {
      try {
        const account = await ensureMember(db, n, openId, timestamp), requestId = requestIdOf(event)
        const receipt = await one(db, n.receipts, { _id: fixedId(n.receipts, 'member', account.memberId, requestId), actorType: 'member', memberId: account.memberId, requestId })
        return ok({ found: !!receipt, receipt: receipt ? { requestId, action: receipt.action, status: receipt.status, result: receipt.result, revisionBefore: receipt.revisionBefore, revisionAfter: receipt.revisionAfter } : null })
      } catch (error) { return fail(error.code || 'RECEIPT_LOOKUP_FAILED', error.message || '回执查询失败。') }
    }
    if (event.action === 'previewClaimInvite') {
      // ─────────────────────────────────────────────────────────────────────────
      // 「点开分享链接」看到的那张确认卡（2026-10-04 需求 B · 主路径的**只读**一半）。
      //
      // ⭐⭐ 为什么必须是**独立 action**、而不是 execute 通道里的一条普通命令：
      //   execute 通道的每一条命令都会 ① 校验 expectedRevision ② 推进 memberRevision
      //   ③ 写一条回执 ④ 视命令而定写业务数据。预览是"看一眼"，这四件事**一件都不该发生** ——
      //   否则会员只是点开链接（甚至点错了、随手转发了一下）就消耗了一次 revision、留下一条回执。
      //   ⛔ 顺带把"链接点开就自动认领"这个事故从协议层关掉：这里**没有任何写入**，
      //      真正认领只可能由 `claimByInvite`（点确认之后才发）产生。
      //
      // ⚠️ 页面**不能**自己 `wx.cloud.callFunction`（tests/mutate-write-surface 钉死了这条），
      //   所以它只能借 `utils/member-runtime`；而 runtime 暴露的会员侧唯一入口就是 `command()`
      //   （execute 通道）⇒ **取舍**：这里保留独立 action，同时给 runtime 一个**同义的 execute 入口**
      //   `previewClaimInvite`（见下面 `READ_ONLY_COMMANDS`）—— 它在 execute 通道里被显式标成
      //   只读：**不校验 revision、不推进 revision、不写回执**。两条通道行为逐字一致。
      try {
        // ⛔ 与命令层同一把尺：客户端只许提交 inviteTicket。定位字段一律不许自报。
        const payload = assertOnlyKeys(PREVIEW_ALLOW, event.payload, 'PAYLOAD_FIELD_NOT_ALLOWED', 'previewClaimInvite')
        return ok(await previewInviteByTicket(db, n, { inviteTicket: payload.inviteTicket, claimToken: payload.claimToken, claimScene: payload.claimScene }, memberIdFor(openId), timestamp))
      } catch (error) { return fail(error.code || 'INVITE_PREVIEW_FAILED', error.message || '这张邀请暂时看不了，请让教练重新发一次。') }
    }
    if (event.action === 'coachMetadata') {
      try {
        const coach = await coachContext(db, n, openId), revision = await one(db, n.revisions, { _id: fixedId(n.revisions, 'coach', coach.coachId), actorType: 'coach', coachId: coach.coachId })
        // ⭐ 公开教练卡的**回读**必须与发布走同一条链路：`coachContext()` 出的可信 coachId + `n.profiles` 这个环境集合。
        //    ⇒ coachId 只可能来自服务端可信 OPENID（不可能串号），集合只可能由 event.environment 决定（不可能串环境）。
        //    ⚠️ 这条回读不能省：页面只靠 publish 的返回值显示资料的话，重新进入页面时表单永远为空（2026-09-28 真机 BUG 02）。
        const profile = await one(db, n.profiles, { _id: fixedId(n.profiles, coach.coachId), coachId: coach.coachId })
        return ok({ environment: n.environment, coachRevision: revision ? revision.dataRevision : 0, profile: profile ? { ...publicProfile(profile), publicCode: profile.publicCode || '' } : null })
      } catch (error) { return fail(error.code || 'COACH_MEMBER_METADATA_FAILED', error.message || '教练会员工具状态读取失败。') }
    }
    if (event.action === 'getCoachReceipt') {
      try {
        const coach = await coachContext(db, n, openId), requestId = requestIdOf(event)
        const receipt = await one(db, n.receipts, { _id: fixedId(n.receipts, 'coach', coach.coachId, requestId), actorType: 'coach', coachId: coach.coachId, requestId })
        return ok({ found: !!receipt, receipt: receipt ? { requestId, action: receipt.action, status: receipt.status, result: receipt.result, revisionBefore: receipt.revisionBefore, revisionAfter: receipt.revisionAfter } : null })
      } catch (error) { return fail(error.code || 'COACH_RECEIPT_LOOKUP_FAILED', error.message || '教练会员工具回执查询失败。') }
    }
    if (event.action === 'coachExecute') {
      try {
        const requestId = requestIdOf(event), action = cleanText(event.command, 48), fingerprint = payloadHash({ action, payload: event.payload }), payload = event.payload || {}
        const notAllowed = payloadFieldNotAllowed(action, payload)
        if (notAllowed) return fail('PAYLOAD_FIELD_NOT_ALLOWED', `「${action}」不接受这个字段：${notAllowed}`)
        return await db.runTransaction(async tx => {
          const coach = await coachContext(tx, n, openId), receiptId = fixedId(n.receipts, 'coach', coach.coachId, requestId)
          const prior = await one(tx, n.receipts, { _id: receiptId, actorType: 'coach', coachId: coach.coachId, requestId })
          if (prior) {
            if (prior.payloadHash !== fingerprint || prior.action !== action) throw Object.assign(new Error('同一请求编号不能用于不同操作。'), { code: 'REQUEST_ID_CONFLICT' })
            if (prior.status === 'succeeded') return ok({ replayed: true, ...prior.result, revisionBefore: prior.revisionBefore, revisionAfter: prior.revisionAfter })
          }
          const revisionId = fixedId(n.revisions, 'coach', coach.coachId), revision = await one(tx, n.revisions, { _id: revisionId, actorType: 'coach', coachId: coach.coachId }) || { actorType: 'coach', coachId: coach.coachId, dataRevision: 0, createdAt: timestamp }
          if (!Number.isInteger(event.expectedRevision) || event.expectedRevision !== revision.dataRevision) throw Object.assign(new Error('会员工具状态已变化，请重试。'), { code: 'REVISION_CONFLICT', currentRevision: revision.dataRevision })
          let result
          if (action === 'createClaimToken') {
            const studentId = cleanText(payload.studentId, 64)
            if (!studentId) throw Object.assign(new Error('缺少学员编号。'), { code: 'INVALID_PAYLOAD' })
            const student = await one(tx, 'students', { ownerCoachId: coach.coachId, datasetId: coach.datasetId, studentId })
            if (!student) throw Object.assign(new Error('找不到当前教练数据空间中的学员。'), { code: 'STUDENT_NOT_FOUND' })
            // ⭐ M3-P2-3：认领码从「24 位 base64url」改为 **8 位人工短码** ——
            //   原来的码没法口头念、没法手抄、没法截图转发后让对方敲进去（这才是它真正的毛病）。
            //   ⛔ **必须查重**：`tokenId = fixedId(tokens, tokenHash)` ⇒ 撞码不是报错，而是**静默覆盖**，
            //      会让一位会员手里那枚码悄悄变成**另一位学员**的档案 —— 这是越权级的事故，不是小瑕疵。
            //   ⚠️ 有效期与集合口径一个字都没改（15 分钟、`member[_sandbox]_claim_tokens`）。
            let token = '', tokenHash = '', tokenId = ''
            for (let attempt = 1; attempt <= 5; attempt += 1) {
              const candidate = shortCode.generate()
              const candidateHash = sha(`claim:${candidate}`), candidateId = fixedId(n.tokens, candidateHash)
              if (!await one(tx, n.tokens, { _id: candidateId })) { token = candidate; tokenHash = candidateHash; tokenId = candidateId; break }
              if (attempt === 5) throw Object.assign(new Error('认领码生成失败，请稍后重试。'), { code: 'CLAIM_CODE_COLLISION' })
            }
            const expiresAt = timestamp + 15 * 60 * 1000
            // ⭐ 2026-10-03：补**风控三件套**（之前只有"15 分钟后失效"，分享出去的链接没有任何次数限制）：
            //   `issuedByCoachId` 谁发的、`useCount` / `maxUses` 最多能被兑换几次。
            //   ⛔ 默认 1 次 = 一次性，与「一次性认领码」这个说法一致；将来要做"一次生成、多个会员用"
            //     时只要调 maxUses，**主键公式一个字都不改** ⇒ 老码零迁移、绝不影响已在用的码。
            await put(tx, n.tokens, tokenId, { tokenHash, coachId: coach.coachId, studentId, datasetIdAtIssue: coach.datasetId, issuedByCoachId: coach.coachId, useCount: 0, maxUses: 1, status: 'available', expiresAt, createdAt: timestamp })
            result = { claimToken: token, expiresAt, studentPreview: { name: student.data && student.data.name ? `${String(student.data.name).slice(0, 1)}**` : '当前学员' } }
          } else if (action === 'createClaimInvite' || action === 'createClaimQrCode') {
            // ─────────────────────────────────────────────────────────────────────────
            // 「邀请会员认领」的两条命令（2026-10-04 需求 B）。
            //
            // ⭐⭐ 与 `createClaimToken` 的分工（这是本轮设计的核心）：
            //   · `createClaimToken` = **兜底通道**。8 位人工短码，会员手输 / 口述 / 截图转述。
            //     ⛔ 它**绝不能**进分享链接（见文件头 INVITE_TICKET 那段的三条理由）。
            //   · `createClaimInvite` = **主路径**。产出 `inviteTicket`（不透明、一次性、15 分钟），
            //     分享链接里**只有**它。会员点开先只读预览、点确认才写入。
            //   · 两者**成对**签发、同一有效期、各自独立计数 ⇒ 教练一次点按钮，
            //     主路径（分享）与兜底（复制 / 扫码）同时可用，互不阻塞。
            //
            // ⛔ 归属校验（防串领的**第一道**）：学员必须存在于**调用者自己的当前数据空间**
            //    （`ownerCoachId + datasetId` 双重限定）—— 教练无法为别人的学员签发邀请。
            // ⛔ 归属的**第二道**在会员侧 `claimByInvite`：教练归属与学员归属**只从库里那一行读**，
            //    客户端 payload 只有 inviteTicket 一个字段（PAYLOAD_ALLOW 已钉死）。
            const studentId = cleanText(payload.studentId, 64)
            if (!studentId) throw Object.assign(new Error('缺少学员编号。'), { code: 'INVALID_PAYLOAD' })
            const student = await one(tx, 'students', { ownerCoachId: coach.coachId, datasetId: coach.datasetId, studentId })
            if (!student) throw Object.assign(new Error('找不到当前教练数据空间中的学员。'), { code: 'STUDENT_NOT_FOUND' })
            // 🔲 二维码能力闸：**必须在任何写入之前**判掉。
            //   ⛔ 为什么放最前面：命令尾部会推进 coachRevision、写回执。若先写库再发现生不成图，
            //      就会留下"生成成功但没有二维码"的半成功状态 —— 页面只能显示失败，教练却看到
            //      邀请已被消耗（再点一次要重新走一遍），这是最难排查的一种坏。
            //   ⛔ 未开通时**如实报缺口**（`QRCODE_CAPABILITY_UNAVAILABLE`），⛔ 绝不返回任何
            //      "已生成图片"式的假结果 —— 页面据此显示"请用分享或复制8位认领码"。
            if (action === 'createClaimQrCode' && !qrCode) throw Object.assign(new Error('当前环境还不能生成二维码，请用「分享给会员」或「复制8位认领码」。'), { code: 'QRCODE_CAPABILITY_UNAVAILABLE' })
            // 🎫 二维码优先**复用**教练刚才生成的那一份邀请（需求口径：一次邀请、三种入口：
            //    分享卡片 / 小程序码 / 短码，指向的是**同一次**邀请）。
            //   ⛔ 复用的硬条件：这一行必须是**这位教练**为自己这位学员签发的、还在有效期内、
            //      还没被用掉、并且**带着场景码**。⛔ 任何一条不满足就明确报错，
            //      ⛔ 绝不"顺手新签一份" —— 那样教练以为二维码与分享卡是同一份邀请，其实不是，
            //      事后排查会变成"会员说扫了码、教练说发了链接"的谜。
            let credential = null
            const reuseTicket = cleanText(payload.inviteTicket, 64)
            if (action === 'createClaimQrCode' && reuseTicket) {
              const found = await findInviteRow(tx, n, reuseTicket)
              const reuseRow = found.row
              const reusable = reuseRow && String(reuseRow.issuedByCoachId || '') === String(coach.coachId || '')
                && String(reuseRow.studentId || '') === String(studentId || '') && String(reuseRow.claimScene || '')
              if (!reusable) throw Object.assign(new Error('这份邀请已经不能用了，请重新生成一次邀请。'), { code: 'INVITE_NOT_FOUND' })
              if (Number(reuseRow.expiresAt) <= timestamp) throw Object.assign(new Error('这份邀请已经过期了，请重新生成一次邀请。'), { code: 'INVITE_EXPIRED' })
              if (String(reuseRow.status || '') !== 'available') throw Object.assign(new Error('这份邀请已经被用过了，请重新生成一次邀请。'), { code: 'INVITE_ALREADY_USED' })
              credential = { inviteTicket: found.inviteTicket, inviteHash: found.inviteHash, claimToken: '', claimScene: String(reuseRow.claimScene), expiresAt: Number(reuseRow.expiresAt) }
            } else {
              credential = await mintClaimCredential(tx, n, coach, student, timestamp)
            }
            if (action === 'createClaimInvite') {
              // 教练公开卡的显示名：邀请页要显示"教练 X 邀请你…"，⛔ 但这不能由客户端自报。
              const profile = await one(tx, n.profiles, { _id: fixedId(n.profiles, coach.coachId), coachId: coach.coachId })
              result = {
                inviteTicket: credential.inviteTicket, claimToken: credential.claimToken, claimScene: credential.claimScene, expiresAt: credential.expiresAt,
                // 教练自己看得到完整姓名（她本来就有权看）；⛔ 会员侧预览才走脱敏。
                studentName: student.data && student.data.name ? String(student.data.name).slice(0, contract.ARCHIVE_NAME_MAX) : '',
                coachName: profile ? (profile.displayName || '教练') : '教练'
              }
            } else {
              // 🎫 复用**上面刚签发的那枚 ticket**（不另发一枚）⇒ 二维码与分享链接指向同一次邀请。
              const image = await qrCode({ ticket: credential.inviteTicket, scene: credential.claimScene, coachId: coach.coachId, studentId, expiresAt: credential.expiresAt })
              // ⛔ 二重保险：即使 qrCode 实现被写坏，**没有真图就不许说成功**。
              if (!image) throw Object.assign(new Error('当前环境还不能生成二维码，请用「分享给会员」或「复制8位认领码」。'), { code: 'QRCODE_CAPABILITY_UNAVAILABLE' })
              result = { inviteTicket: credential.inviteTicket, claimScene: credential.claimScene, expiresAt: credential.expiresAt, qrImage: image }
            }
          } else if (action === 'publishCoachProfile') {
            // ⭐ M3-P2-3 收尾：教练公开码从「10 位 fixedId 切片」改为 **8 位人工短码**。
            //   ⛔ 与认领码 / 课时包共享码同一套 Crockford 规则（字符集 0-9A-Z 去 I/L/O/U = 32 = 5 bit）。
            //   ⭐⭐ **服务端生成，绝不信任客户端传来的码**：
            //      · 已有公开码的教练（含 B 正式区 41c0e373e7、Sandbox 预置 TEST-xxxxxx 之外的历史码）
            //        **原封不动保留** ⇒ 重存不变码、旧码继续可用、绝不每保存一次就换一个码；
            //      · 新教练 / 没码的老档案 ⇒ 服务端生成 8 位码，同一事务内查重，连撞 5 次抛 COACH_PUBLIC_CODE_COLLISION
            //        （撞上别人的码就换一枚，**绝不静默覆盖别人**）；
            //      · 客户端不得指定码去覆盖其他教练（历史上 `payload.publicCode` 这一支被移除）。
            const existing = await one(tx, n.profiles, { _id: fixedId(n.profiles, coach.coachId), coachId: coach.coachId })
            let publicCode = (existing && existing.publicCode) ? String(existing.publicCode) : ''
            if (!publicCode) {
              for (let attempt = 1; attempt <= 5; attempt += 1) {
                const candidate = shortCode.generate()
                const taken = await rows(tx, n.profiles, { publicCode: candidate })
                if (!taken.some(row => row.coachId !== coach.coachId)) { publicCode = candidate; break }
                if (attempt === 5) throw Object.assign(new Error('教练公开码生成失败，请稍后重试。'), { code: 'COACH_PUBLIC_CODE_COLLISION' })
              }
            }
            const profile = { coachId: coach.coachId, publicCode, displayName: cleanText(payload.displayName, 30) || '教练', avatar: cleanText(payload.avatar, 300), specialties: Array.isArray(payload.specialties) ? payload.specialties.slice(0, 6).map(value => cleanText(value, 20)).filter(Boolean) : [], introduction: cleanText(payload.introduction, 120), discoverable: true, updatedAt: timestamp }
            await put(tx, n.profiles, fixedId(n.profiles, coach.coachId), profile)
            result = { profile: publicProfile(profile), publicCode }
          } else throw Object.assign(new Error('不支持的教练会员工具命令。'), { code: 'UNKNOWN_COMMAND' })
          const nextRevision = revision.dataRevision + 1
          await put(tx, n.revisions, revisionId, { ...revision, actorType: 'coach', coachId: coach.coachId, dataRevision: nextRevision, updatedAt: timestamp })
          await put(tx, n.receipts, receiptId, { actorType: 'coach', coachId: coach.coachId, requestId, action, payloadHash: fingerprint, status: 'succeeded', revisionBefore: revision.dataRevision, revisionAfter: nextRevision, result, completedAt: timestamp })
          return ok({ ...result, revisionBefore: revision.dataRevision, revisionAfter: nextRevision })
        })
      } catch (error) { return fail(error.code || 'COACH_MEMBER_COMMAND_FAILED', error.message || '教练会员工具操作失败。', { ...(error.currentRevision == null ? {} : { currentRevision: error.currentRevision }), ...(error.collection ? { collection: error.collection } : {}) }) }
    }
    if (event.action !== 'execute') return fail('INVALID_ACTION', '不支持的会员身份操作。')
    try {
      const requestId = requestIdOf(event), action = cleanText(event.command, 48), fingerprint = payloadHash({ action, payload: event.payload }), payload = event.payload || {}
      const notAllowed = payloadFieldNotAllowed(action, payload)
      if (notAllowed) return fail('PAYLOAD_FIELD_NOT_ALLOWED', `「${action}」不接受这个字段：${notAllowed}`)
      // ─────────────────────────────────────────────────────────────────────────
      // ⭐⭐ `previewClaimInvite` = execute 通道里的**唯一只读命令**（2026-10-04）。
      //   会员页不能自己 `wx.cloud.callFunction`（tests/mutate-write-surface 钉死），
      //   它的会员侧唯一出口是 `utils/member-runtime` 的 `command()` ⇒ 预览必须能走 execute。
      //   ⛔ 但它**必须零写入** —— 于是这里在**进事务之前**就把它拦下来单独处理：
      //     · 不校验 expectedRevision（看一眼凭什么要revision）
      //     · 不写回执（回执是"这件事做过了"的证据，预览没有"做"）
      //     · 不推进 memberRevision（点开链接不该让会员的 revision 跳动）
      //     · 不开事务（没有写入就不需要事务快照）
      //   ⛔ 判据是**白名单**而不是黑名单：将来有人加命令进来，必须显式写进 READ_ONLY_COMMANDS
      //     才会享受"跳过事务"这个特权 ⇒ 默认所有人都要过完整的回执 + revision 闸。
      if (READ_ONLY_COMMANDS.indexOf(action) >= 0) {
        return ok(await previewInviteByTicket(db, n, { inviteTicket: payload.inviteTicket, claimToken: payload.claimToken, claimScene: payload.claimScene }, memberIdFor(openId), timestamp))
      }
      return await db.runTransaction(async tx => {
        const account = await ensureMember(tx, n, openId, timestamp), receiptId = fixedId(n.receipts, 'member', account.memberId, requestId)
        const prior = await one(tx, n.receipts, { _id: receiptId, actorType: 'member', memberId: account.memberId, requestId })
        if (prior) {
          if (prior.payloadHash !== fingerprint || prior.action !== action) throw Object.assign(new Error('同一请求编号不能用于不同操作。'), { code: 'REQUEST_ID_CONFLICT' })
          if (prior.status === 'succeeded') return ok({ replayed: true, ...prior.result, revisionBefore: prior.revisionBefore, revisionAfter: prior.revisionAfter })
        }
        const revisionId = fixedId(n.revisions, 'member', account.memberId), revision = await one(tx, n.revisions, { _id: revisionId, actorType: 'member', memberId: account.memberId }) || { actorType: 'member', memberId: account.memberId, dataRevision: 0, createdAt: timestamp }
        if (!Number.isInteger(event.expectedRevision) || event.expectedRevision !== revision.dataRevision) throw Object.assign(new Error('会员数据已变化，请刷新后重试。'), { code: 'REVISION_CONFLICT', currentRevision: revision.dataRevision })
        let result
        if (action === 'updateProfile') {
          // ⛔ 2026-10-05：这里**刻意不接** payload.theme —— 主题功能已整体撤回，接了等于把开关又请回来。
          const next = { ...account, displayName: cleanText(payload.displayName, 30), updatedAt: timestamp }
          await put(tx, n.accounts, fixedId(n.accounts, account.memberId), next)
          result = { member: publicMember(next) }
        } else if (action === 'claimStudentRecord') {
          // ⭐ M3-P2-3：**同时接受新的 8 位短码与历史 24 位长码**。
          //   ⛔ 关键不变量：`tokenHash = sha('claim:' + token)` 这个公式**一个字都没改** ⇒ 旧码照旧命中，
          //      **不需要任何数据迁移**。
          //   ⛔ 归一化只对"看起来就是 8 位短码"的输入动手（纠正口述误输入 O→0 / I,L→1 / U→V 并忽略空格
          //      与连字符）；其余输入**原样使用** —— 历史码是**区分大小写**的 base64url，
          //      一旦被 toUpperCase 就再也兑换不了（这是必须守住的一条）。
          const token = shortCode.normalize(cleanText(payload.claimToken, 128)), tokenHash = sha(`claim:${token}`), tokenId = fixedId(n.tokens, tokenHash)
          const tokenRow = await one(tx, n.tokens, { _id: tokenId, tokenHash })
          if (!tokenRow || tokenRow.status !== 'available' || Number(tokenRow.expiresAt) <= timestamp) throw Object.assign(new Error('认领码无效或已经过期。'), { code: 'CLAIM_TOKEN_INVALID' })
          const existing = await rows(tx, n.claims, { coachId: tokenRow.coachId, studentId: tokenRow.studentId })
          // ⭐⭐ 只让**仍然有效**的认领关系挡路（`released` 的不挡）——
          //    否则一旦支持"解除认领"，解除过的那份档案就**永远认不回来**了。
          if (existing.filter(contract.isClaimActive).some(row => row.memberId !== account.memberId)) throw Object.assign(new Error('这条学员记录已经被其他会员认领。'), { code: 'STUDENT_ALREADY_CLAIMED' })
          const claimId = fixedId(n.claims, tokenRow.coachId, tokenRow.studentId)
          const prior = existing.find(row => String(row.claimId || '') === claimId)
          // 重新认领（此前解除过）：⛔ 绝不写成"全新的一条"——保留首次认领时间，并留下"曾经解除过"的痕迹。
          const reclaimedAt = prior && String(prior.status || '') === contract.CLAIM_STATUS.RELEASED ? timestamp : null
          await put(tx, n.claims, claimId, {
            claimId, memberId: account.memberId, coachId: tokenRow.coachId, studentId: tokenRow.studentId,
            status: contract.CLAIM_STATUS.VERIFIED, claimedAt: (prior && prior.claimedAt) || timestamp,
            sourceTokenId: tokenId, reclaimedAt
          })
          await put(tx, n.tokens, tokenId, { ...tokenRow, status: 'used', usedAt: timestamp, usedByMemberId: account.memberId, useCount: Number(tokenRow.useCount || 0) + 1 })
          result = { claimId, archiveId: contract.archiveIdOf(claimId), coachId: tokenRow.coachId, studentId: tokenRow.studentId, reclaimed: !!reclaimedAt }
        } else if (action === 'claimByInvite') {
          // ─────────────────────────────────────────────────────────────────────────
          // 用**不透明邀请票据**认领（2026-10-04 需求 B 主路径）。分享链接里只有它。
          //
          // ⛔⛔ 防串领的三道闸（这一段是本轮的核心安全面，缺一道都算事故）：
          //   ① **payload 白名单只有一个字段**（PAYLOAD_ALLOW.claimByInvite = ['inviteTicket']）：
          //      客户端**没有任何办法**自报 coachId / studentId / claimId —— 想认领别人的档案，
          //      连"告诉服务端要认领谁"这一步都做不到。
          //   ② **归属只从库里那一行读**：`row.coachId` / `row.studentId` 是签发时写死的
          //      （见 mintClaimCredential）。⛔ 绝不使用 payload 里任何定位字段（一个都没有）。
          //   ③ **已被别人认领就明确拒绝**：见下面 `activeOther` 那条 —— 复用 claimStudentRecord
          //      已有的"只让仍然有效的认领挡路"口径（released 不挡路，解除过的档案能重新认领）。
          //
          // ⭐ 与 `claimStudentRecord` 的关系：认领关系的**业务后果完全一致**（同一张 claims 行、
          //   同一个 archiveId 算法），⛔ 但入口凭据不同 ⇒ 票据被转发/爆破**不会**牵连兜底短码。
          // 🎫 两种凭据走**同一条**认领逻辑：分享链接带 ticket，小程序码带 scene。
          const ticketValue = cleanText(payload.inviteTicket, 64)
          const sceneValue = cleanText(payload.claimScene, 64)
          // ⛔ 凭据唯一性（与预览同一把尺）：票据与场景码**必须恰好给一个**。
          //    两个都带时"按哪个认领"没有唯一答案 —— 那正是串领的入口。
          const givenCredentials = [ticketValue, sceneValue].filter(Boolean).length
          if (givenCredentials !== 1) throw Object.assign(new Error('一次只能用一种凭据（邀请链接 / 二维码）。'), { code: 'INVALID_PAYLOAD' })
          const useScene = !ticketValue && !!sceneValue
          const sceneRow = useScene ? await one(tx, n.tokens, { claimScene: sceneValue, kind: 'invite' }) : null
          const found = useScene
            ? { inviteTicket: '', inviteHash: String((sceneRow && sceneRow.inviteHash) || ''), row: sceneRow }
            : await findInviteRow(tx, n, payload.inviteTicket)
          const { inviteTicket, inviteHash, row: inviteRow } = found
          const inviteId = fixedId(n.tokens, inviteHash)
          if (!inviteRow) throw Object.assign(new Error('这张邀请不是教练发给你的，或者已经被清理了。请让教练重新发一次。'), { code: 'INVITE_NOT_FOUND' })
          if (Number(inviteRow.expiresAt) <= timestamp) throw Object.assign(new Error('这个邀请已经过期了，请让教练重新发一个。'), { code: 'INVITE_EXPIRED' })
          if (inviteRow.status !== 'available') throw Object.assign(new Error('这个邀请已经被用过了，请让教练重新发一个。'), { code: 'INVITE_ALREADY_USED' })
          // ⚠️ 票据是一次性的，但**"这份档案已被人认领"是更硬的边界**：⛔ 即便票据本身
          //   还没被兑换（转发出去的那一份），只要档案已经属于别人，就绝不许再写一条认领。
          //   否则"教练转发给 A，A 认领，同一链接再被 B 打开"就会产出两条有效认领 ⇒ 档案被认领两次。
          const existing = await rows(tx, n.claims, { coachId: inviteRow.coachId, studentId: inviteRow.studentId })
          if (existing.filter(contract.isClaimActive).some(row => row.memberId !== account.memberId)) throw Object.assign(new Error('这条学员记录已经被其他会员认领。'), { code: 'STUDENT_ALREADY_CLAIMED' })
          const claimId = fixedId(n.claims, inviteRow.coachId, inviteRow.studentId)
          const prior = existing.find(row => String(row.claimId || '') === claimId)
          const reclaimedAt = prior && String(prior.status || '') === contract.CLAIM_STATUS.RELEASED ? timestamp : null
          await put(tx, n.claims, claimId, {
            claimId, memberId: account.memberId, coachId: inviteRow.coachId, studentId: inviteRow.studentId,
            status: contract.CLAIM_STATUS.VERIFIED, claimedAt: (prior && prior.claimedAt) || timestamp,
            // ⚠️ 来源字段用 `sourceInviteId`（票据行 id）而**不是** `sourceTokenId` ——
            //   票据不是认领码，把它的 id 写进 `sourceTokenId` 会让日后排查的人
            //   顺着这个名字去 tokens 里查一枚**根本不存在**的认领码。⛔ 名字必须说真话。
            sourceInviteId: inviteId, reclaimedAt
          })
          // 🔒 票据作废：⛔ 一次性是这一行存在的**全部意义** —— 同一张邀请被重复打开时，
          //   上面的 `status !== 'available'` 会把它明确拒掉，而不是"又认领一次"。
          await put(tx, n.tokens, inviteId, { ...inviteRow, status: 'used', usedAt: timestamp, usedByMemberId: account.memberId, useCount: Number(inviteRow.useCount || 0) + 1 })
          result = { claimId, archiveId: contract.archiveIdOf(claimId), coachId: inviteRow.coachId, studentId: inviteRow.studentId, reclaimed: !!reclaimedAt, viaInvite: true }
        } else if (action === 'releaseStudentClaim') {
          // ─────────────────────────────────────────────────────────────────────────
          // 「解除认领」= **只解除本微信账号与这份学员档案的关系**（2026-10-03 会员端新需求）。
          // ⛔⛔ 三条不可越界的红线：
          //   ① **软删除**：status: verified → released。⛔ 绝不 `remove()`、绝不改 studentId / coachId ——
          //      删掉之后教练端就再也无法证明"这份记录曾被谁认领"，历史追溯与争议核对会失去依据。
          //   ② **只认服务端已有的关系**：客户端只提交不透明的 `archiveId`，由服务端在自己的认领里反查 ——
          //      ⛔ 客户端**永远不许**提交 claimId / studentId / coachId（FORBIDDEN 已拦），
          //      所以"解除别人的认领"这件事在协议层就做不到。
          //   ③ **历史一律保留**：课程、课包、训练记录、收入、回执一个字都不动；
          //      会员端之后不再看到这份档案（所有读端都按 status='verified' 过滤），但数据仍在。
          // 📌 关于 `archiveId`：它是 `sha('member-archive-view' + claimId)` 的不透明视图 ID，
          //    客户端本来就拿得到（列表里每份档案都带），不需要新增任何下发字段。
          // ⚠️ 幂等：重复解除同一条不会报错（第二次找不到有效关系 ⇒ 明确回 MEMBER_CLAIM_NOT_FOUND），
          //    而回执层（requestId）保证同一次点击只会真正执行一次。
          const archiveId = cleanText(payload.archiveId, 64)
          if (!archiveId) throw Object.assign(new Error('缺少档案标识。'), { code: 'INVALID_PAYLOAD' })
          const mine = await rows(tx, n.claims, { memberId: account.memberId, status: contract.CLAIM_STATUS.VERIFIED })
          const target = mine.find(row => contract.archiveIdOf(claimIdOf(row)) === archiveId)
          if (!target) throw Object.assign(new Error('没有找到这份训练档案，可能已经解除过了。'), { code: 'MEMBER_CLAIM_NOT_FOUND' })
          const claimId = claimIdOf(target)
          if (!claimId) throw Object.assign(new Error('这份认领关系缺少标识，无法解除。'), { code: 'MEMBER_CLAIM_NOT_FOUND' })
          // ⚠️ 逐字段写出而不是把读回来的整份文档回写：读回来的文档带 _id，回写会被云端拒（-501007），
          //    也避免把任何不该进认领行的字段带进去。
          await put(tx, n.claims, claimId, {
            claimId, memberId: account.memberId, coachId: target.coachId, studentId: target.studentId,
            status: contract.CLAIM_STATUS.RELEASED, claimedAt: target.claimedAt || null,
            sourceTokenId: target.sourceTokenId || '', releasedAt: timestamp, releasedByMemberId: account.memberId
          })
          const stillMine = mine.filter(row => claimIdOf(row) !== claimId)
          result = { archiveId, released: true, releasedAt: timestamp, remainingArchiveCount: stillMine.length }
        } else if (action === 'addCoachShortcut') {
          const code = cleanText(payload.publicCode, 32), profile = await one(tx, n.profiles, { publicCode: code, discoverable: true })
          if (!profile) throw Object.assign(new Error('没有找到可添加的教练。'), { code: 'COACH_PUBLIC_PROFILE_NOT_FOUND' })
          const shortcutId = fixedId(n.shortcuts, account.memberId, profile.coachId)
          await put(tx, n.shortcuts, shortcutId, { shortcutId, memberId: account.memberId, coachId: profile.coachId, source: 'publicCode', addedAt: timestamp })
          result = { shortcutId, coach: publicProfile(profile) }
        } else if (action === 'removeCoachShortcut') {
          const shortcutId = cleanText(payload.shortcutId, 64), shortcut = await one(tx, n.shortcuts, { _id: shortcutId, memberId: account.memberId })
          if (!shortcut) throw Object.assign(new Error('常用教练记录不存在。'), { code: 'COACH_SHORTCUT_NOT_FOUND' })
          await remove(tx, n.shortcuts, shortcutId)
          result = { shortcutId, removed: true }
        } else throw Object.assign(new Error('不支持的会员身份命令。'), { code: 'UNKNOWN_COMMAND' })
        const nextRevision = revision.dataRevision + 1
        await put(tx, n.revisions, revisionId, { ...revision, actorType: 'member', memberId: account.memberId, dataRevision: nextRevision, updatedAt: timestamp })
        await put(tx, n.receipts, receiptId, { actorType: 'member', memberId: account.memberId, requestId, action, payloadHash: fingerprint, status: 'succeeded', revisionBefore: revision.dataRevision, revisionAfter: nextRevision, result, completedAt: timestamp })
        return ok({ ...result, revisionBefore: revision.dataRevision, revisionAfter: nextRevision })
      })
    } catch (error) { return fail(error.code || 'MEMBER_COMMAND_FAILED', error.message || '会员身份操作失败。', error.currentRevision == null ? {} : { currentRevision: error.currentRevision }) }
  }
}

module.exports = { createService, memberIdFor, coachIdFor, fixedId, names, forbiddenPath }
