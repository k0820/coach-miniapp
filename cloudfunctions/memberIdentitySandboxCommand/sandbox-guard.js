// ─────────────────────────────────────────────────────────────────────────────
// ⛔⛔ 测试区云函数的**服务端硬门禁**（需求 5）
//
// 「解除认领 / 邀请认领 / 编辑显示名」这三类操作，⛔ 判定**只能在服务端**，
// ⛔ 绝不能只靠页面判断：页面判断可以被绕过（改包 / 旧版本 / 直接调云函数），
//    而本文件在**任何集合读写之前**就判掉 ⇒ 一个字节都到不了正式区。
//
// ⭐ 两道闸，缺一不可：
//   ① `environment` 必须**严格等于** `'sandbox'`（`undefined` / `''` / 拼错 / 大小写不同 ⇒ 拒绝）；
//   ② 上面那五类命令**逐条**再判一次环境（即使将来有人忘了 ①，② 也会挡住）。
//   ⛔ 两道都不是"缺省值兜底"：没有 `production` 这支分支，也没有"取不到就当正式区"的写法。
const { SANDBOX, SANDBOX_REJECT_CODE, SANDBOX_REJECT_MESSAGE, sandboxVerdict } = require('./member-contract')

// ⛔ 白名单：这些命令**只允许**在测试区跑。将来新增受保护命令必须显式写进来。
const SANDBOX_ONLY_COMMANDS = Object.freeze([
  'releaseStudentClaim',   // 解除认领
  'createClaimInvite',     // 邀请认领（分享链接 / 不透明票据）
  'createClaimQrCode',     // 邀请认领（二维码）
  'updateProfile'          // 编辑显示名
])

// 返回 `null` = 放行；返回对象 = 拒绝（调用方原样回给客户端，⛔ 零集合访问）。
function rejectOperation(command, environment) {
  const verdict = sandboxVerdict(environment)
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message, environment: SANDBOX, received: verdict.received }
  if (SANDBOX_ONLY_COMMANDS.indexOf(command) >= 0 && environment !== SANDBOX) {
    return { ok: false, code: SANDBOX_REJECT_CODE, message: SANDBOX_REJECT_MESSAGE, environment: SANDBOX, received: String(environment) }
  }
  return null
}

module.exports = { SANDBOX, SANDBOX_ONLY_COMMANDS, SANDBOX_REJECT_CODE, SANDBOX_REJECT_MESSAGE, sandboxVerdict, rejectOperation }
