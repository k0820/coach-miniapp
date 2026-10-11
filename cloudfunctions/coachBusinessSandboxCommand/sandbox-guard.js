// ─────────────────────────────────────────────────────────────────────────────
// ⛔⛔ 测试区云函数的**服务端硬门禁**（需求 5）
//
// 「会员自助预约」这条路径必须**只能在服务端**判环境：页面判断可以被绕过（改包 / 旧版本 /
// 直接调云函数），而本文件在**任何集合读写之前**就判掉 ⇒ 一个字节都到不了正式区。
//
// ⭐ 两道闸，缺一不可：
//   ① `environment` 必须**严格等于** `'sandbox'`（`undefined` / `''` / 拼错 / 大小写不同 ⇒ 拒绝）；
//   ② 会员预约这三条写命令**逐条**再判一次环境（即使将来有人忘了 ①，② 也会挡住）。
//   ⛔ 两道都不是"缺省值兜底"：没有 `production` 这支分支，也没有"取不到就当正式区"的写法。
//
// ⛔ 会员预约用到的**集合名**由 `./memberBooking` 自己钉死：
//    它的集合名从 `./authorization` 的 `collectionsFor()` 推导，而后者在本副本里**恒为**沙盒那一支。
//    ⭐ 2026-10-05：原先 comment 提到的归档闸门 `archiveCollectionOf()` / `isArchived()`
//    已随「已结束服务 / 已归档学员」功能整体撤回，全库不再存在（见 hxc/ARCHIVE-REMOVAL-20261005.md）。
const { SANDBOX, SANDBOX_REJECT_CODE, SANDBOX_REJECT_MESSAGE, sandboxVerdict } = require('./core')

// ⛔ 白名单：这些命令**只允许**在测试区跑。将来新增受保护命令必须显式写进来。
const SANDBOX_ONLY_COMMANDS = Object.freeze([
  'createMemberBooking',     // 会员自助预约
  'cancelMemberBooking',     // 会员取消
  'rescheduleMemberBooking'  // 会员改期
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
