// ─────────────────────────────────────────────────────────────────────────────
// 会员域**唯一权威契约**（孪生副本：memberIdentityCommand / readMyMemberData 各存一份）
//
// ⛔ 为什么是"孪生副本"而不是共享模块：微信云函数**各自独立部署**，跨目录 `require`
//    在真机上必然失败（PROJECT_MEMORY §129 已经踩过）。所以这份契约在两个云函数目录里
//    各放一份**逐字节相同**的副本，由 `tests/member-archive-contract.test.js` 钉死：
//    ① 两份文件必须完全一致；② 集合名 / 状态常量不得与真实用法漂移。
//    ⛔ 历史上正是"集合名各抄一份、已经抄错一处"造成了「假件全绿、真机永远查不到教练」。
//
// 这个文件只放**跨云函数必须一致**的东西：集合名、认领状态、档案视图 ID 算法。
// 它**不**放业务规则（各服务各写各的），也**不**放任何写逻辑。
const crypto = require('crypto')

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const fixedId = (...parts) => sha(parts.join(':')).slice(0, 32)

// ── 认领关系的状态：⛔ 只有这两种 ──────────────────────────────────────────────
// 「解除认领」= 从 verified 改成 **released（软删除）**，⛔ 绝不删行、绝不改 studentId。
// 为什么必须是软删除：认领关系是「谁在用这份教练学员记录」的唯一凭据，删掉之后
// 教练端就再也无法证明"这份记录曾被谁认领"，历史追溯、争议核对都会失去依据。
// ⭐ 所有读端一律按 `status: 'verified'` 过滤（memberBooking / notify / readMyMemberData），
//    所以 released 的档案**自动**从会员端消失，不需要每处都记得加判断 —— 这也是本设计的核心收益。
const CLAIM_STATUS = Object.freeze({ VERIFIED: 'verified', RELEASED: 'released' })


// 会员端看到的**不透明**档案视图 ID：客户端拿不到 studentId / claimId，
// 也**不可能**拿它去换别人的档案（写路径只认 packageViewId / bookingViewId）。
const ARCHIVE_VIEW_KIND = 'member-archive-view'
const ARCHIVE_NAME_MAX = 30

// 会员域集合名（**唯一权威**）。sandbox 与 production 严格隔离。
function memberNames(environment) {
  const sandbox = environment === 'sandbox'
  const prefix = sandbox ? 'member_sandbox_' : 'member_'
  return {
    environment: sandbox ? 'sandbox' : 'production',
    accounts: `${prefix}accounts`,
    claims: `${prefix}student_claims`,
    tokens: `${prefix}claim_tokens`,
    profiles: `${prefix}coach_profiles`,
    shortcuts: `${prefix}coach_shortcuts`,
    revisions: `${prefix}revisions`,
    receipts: `${prefix}receipts`,
    coachHeads: sandbox ? 'coach_sandbox_heads' : 'coach_data_heads'
  }
}

const archiveIdOf = claimId => fixedId(ARCHIVE_VIEW_KIND, claimId)
// ⛔ 只认"已认领"这一种；⛔ 缺 status 的历史行按已认领处理（老数据一律是 verified）。
const isClaimActive = claim => !!claim && String(claim.status || CLAIM_STATUS.VERIFIED) === CLAIM_STATUS.VERIFIED

module.exports = {
  CLAIM_STATUS, ARCHIVE_VIEW_KIND, ARCHIVE_NAME_MAX,
  memberNames, archiveIdOf, isClaimActive
}
