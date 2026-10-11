// ─────────────────────────────────────────────────────────────────────────────
// ⛔⛔ 测试区（Sandbox）**专属**契约 —— 与 `memberIdentityCommand/member-contract.js` 的关系：
//
//   那份是 Production 与 Sandbox **共用**的权威契约：`memberNames(environment)` 按
//   `environment === 'sandbox'` 选择前缀（`member_sandbox_` / `member_`）。
//   ⛔ 本文件**故意不是**它的副本，而是**钉死**版：
//     · `memberNames()` **忽略入参**，永远只返回 `member_sandbox_*`；
//     · 文件里**不出现任何**正式区集合名字面量 ⇒ 没有任何"拼前缀 / 缺省值 / 参数回退"
//       能把一次读写送到正式区（需求 2）。
//
// ⭐ 为什么必须另起一份钉死契约、而不是复用共用契约 + 传 'sandbox'：
//   微信云函数**按目录独立部署**，跨目录 `require` 在真机上找不到文件
//   （PROJECT_MEMORY §129 已踩过）。共用契约里那句 `sandbox ? 'member_sandbox_' : 'member_'`
//   就是一个"参数一回退就落到正式区"的开关 —— 本文件把它整条删掉。
//
// ⛔ 与共用契约的**值**必须逐字一致（只差"没有正式区那一支"）：
//   `tests/sandbox-cloud-isolation.test.js` 断言
//   `memberNames('sandbox')` 与共用契约 `memberNames('sandbox')` 完全相等；
//   共用契约一旦改了沙盒侧的名字，这条测试会立刻变红 ⇒ 不会出现两套口径。
const crypto = require('crypto')

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const fixedId = (...parts) => sha(parts.join(':')).slice(0, 32)

// ── 认领关系的状态：⛔ 只有这两种（与共用契约同值） ───────────────────────────
const CLAIM_STATUS = Object.freeze({ VERIFIED: 'verified', RELEASED: 'released' })


const ARCHIVE_VIEW_KIND = 'member-archive-view'
const ARCHIVE_NAME_MAX = 30

// ── 环境门禁（需求 2 的第一道闸）────────────────────────────────────────────
// ⛔ 只接受**严格等于**字符串 `sandbox` 的值。`undefined` / `''` / `'SANDBOX'` /
//    `'sandbox '` / `'production'` / 拼错的任何值一律拒绝 —— 一个都不许靠"缺省值"蒙过去。
const SANDBOX = 'sandbox'
const SANDBOX_REJECT_CODE = 'SANDBOX_ENVIRONMENT_REQUIRED'
const SANDBOX_REJECT_MESSAGE = '这是测试区专用云函数：只接受 environment = "sandbox"。'
function sandboxVerdict(value) {
  if (value === SANDBOX) return { ok: true, environment: SANDBOX }
  return { ok: false, code: SANDBOX_REJECT_CODE, message: SANDBOX_REJECT_MESSAGE, environment: SANDBOX, received: value === undefined ? 'undefined' : String(value) }
}
// ⛔ 供服务内部（已经过了 index.js 那道闸之后）再兜一次：任何非 sandbox 的环境值直接抛。
function assertSandbox(value) {
  const verdict = sandboxVerdict(value)
  if (!verdict.ok) throw Object.assign(new Error(SANDBOX_REJECT_MESSAGE), { code: SANDBOX_REJECT_CODE })
  return SANDBOX
}

// ── 沙盒集合名（**唯一权威**，本文件里没有正式区那一支）──────────────────────
// ⛔ 入参**故意不使用**：签名保留 `environment` 只是为了与共用契约形状一致
//    （service.js 里是 `names(event.environment)`），⛔ 函数体绝不读它。
// eslint-disable-next-line no-unused-vars
function memberNames(environment) {
  return {
    environment: SANDBOX,
    accounts: 'member_sandbox_accounts',
    claims: 'member_sandbox_student_claims',
    tokens: 'member_sandbox_claim_tokens',
    profiles: 'member_sandbox_coach_profiles',
    shortcuts: 'member_sandbox_coach_shortcuts',
    revisions: 'member_sandbox_revisions',
    receipts: 'member_sandbox_receipts',
    coachHeads: 'coach_sandbox_heads'
  }
}

const archiveIdOf = claimId => fixedId(ARCHIVE_VIEW_KIND, claimId)
const isClaimActive = claim => !!claim && String(claim.status || CLAIM_STATUS.VERIFIED) === CLAIM_STATUS.VERIFIED

module.exports = {
  CLAIM_STATUS, ARCHIVE_VIEW_KIND, ARCHIVE_NAME_MAX,
  memberNames, archiveIdOf, isClaimActive,
  // 门禁（只在本沙盒目录里存在；Production 那份契约没有，也不需要有）
  SANDBOX, SANDBOX_REJECT_CODE, SANDBOX_REJECT_MESSAGE, sandboxVerdict, assertSandbox
}
