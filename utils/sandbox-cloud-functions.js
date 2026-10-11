// ─────────────────────────────────────────────────────────────────────────────
// ⭐⭐ 云函数名路由 + 测试区功能门禁 —— **唯一权威**
//
// ⛔⛔ 背景（2026-10-05）：全项目**只有一个微信云环境**（`cloud1-d6g8l8h3uc9d8976f`，见 app.js）。
//    Sandbox 与 Production 只是**同一个环境内的集合名前缀隔离**（`member_sandbox_*` / 正式区前缀）。
//    ⇒ 把新代码部署到 `memberIdentityCommand` / `coachBusinessCommand` = 直接**替换**正式区共用的云函数。
//    ⇒ 所以新增两个**只服务测试区**的函数：
//         `memberIdentitySandboxCommand`   （镜像 `memberIdentityCommand`）
//         `coachBusinessSandboxCommand`    （镜像 `coachBusinessCommand`，不含 repair 通道）
//
// ⛔ 三条纪律（改这个文件前先读）：
//   ① 环境 === 'sandbox' ⇒ 调 Sandbox 函数；否则调正式函数。⛔ **反过来绝不允许**
//      （正式区不许调 Sandbox 函数，Sandbox 也不许调正式函数 —— 由测试钉死）。
//   ② 「尚在安全测试中」的功能在正式区**零云调用**并返回同一句话，由页面原样提示。
//   ③ 页面**不许**自己拼云函数名（`wx.cloud.callFunction({name:'...'})`），只能走本模块
//      （`tests/sandbox-cloud-isolation.test.js` 静态扫描钉死）。
//
// ⚠️ 本文件只是**客户端**的第二道闸。真正的硬门禁在云端 Sandbox 函数里
//    （`cloudfunctions/*/index.js` 的 `rejectOperation`）：少了任何一个字段、值拼错，
//    云端都会直接拒绝 ⇒ 改包 / 旧版本客户端也不可能碰到正式区集合。
const PRODUCTION = 'production'
const SANDBOX = 'sandbox'

// ⛔ 函数名**只有这一个出处**。以后新增 / 改名只改这里。
const IDENTITY_FUNCTION = Object.freeze({ production: 'memberIdentityCommand', sandbox: 'memberIdentitySandboxCommand' })
const BUSINESS_FUNCTION = Object.freeze({ production: 'coachBusinessCommand', sandbox: 'coachBusinessSandboxCommand' })

// ⛔ 正式区看到的提示（需求 3）：按钮上原样显示这一句，⛔ 不许换成"暂未开放""敬请期待"之类。
const SANDBOX_ONLY_CODE = 'SANDBOX_ONLY_FEATURE'
const SANDBOX_ONLY_MESSAGE = '该功能尚在安全测试中'

// ⛔ 白名单：这些命令**只允许**在测试区跑（与云端 `sandbox-guard.js` 的那一份对应）。
//   值为 `null` = 整条命令都挡；值为数组 = 只挡**带这些字段**的那一次调用。
const PROTECTED_COMMANDS = Object.freeze({
  releaseStudentClaim: null,    // 解除认领
  createClaimInvite: null,      // 邀请认领（分享链接 / 不透明票据）
  createClaimQrCode: null,      // 邀请认领（二维码）
  // ⛔ 只挡「改显示名」这条会写会员账户的命令。
  //    ⭐ 2026-10-05：原先这里写着"`member-theme` 用同一条命令切主题，不能一起挡掉" ——
  //       主题切换功能已整体撤回，`updateProfile` 现在**只负责显示名**，那段顾虑不再成立。
  updateProfile: ['displayName']
})

// ⛔ 与云端同一把尺：只认**严格等于** `sandbox` 的值，其余一律 `production`。
//    ⚠️ 这里是**客户端**归一化：归到 production 之后会走"门禁 + 提示"，⛔ 不会静默落到正式区数据。
function normalize(value) { return value === SANDBOX ? SANDBOX : PRODUCTION }
function isSandbox(value) { return value === SANDBOX }

function identityFunction(environment) { return IDENTITY_FUNCTION[normalize(environment)] }
function businessFunction(environment) { return BUSINESS_FUNCTION[normalize(environment)] }

// 返回 `null` = 放行；返回对象 = 拦截（调用方**原样**回给页面，⛔ 零云调用）。
function reject(command, environment, payload) {
  if (normalize(environment) === SANDBOX) return null
  if (!Object.prototype.hasOwnProperty.call(PROTECTED_COMMANDS, command)) return null
  const keys = PROTECTED_COMMANDS[command]
  if (Array.isArray(keys) && !keys.some(key => payload && Object.prototype.hasOwnProperty.call(payload, key))) return null
  return { ok: false, code: SANDBOX_ONLY_CODE, message: SANDBOX_ONLY_MESSAGE, environment: PRODUCTION }
}
function blocked(command, environment, payload) { return reject(command, environment, payload) !== null }
// 页面上按钮 / 提示位要显示的那句话（测试区为空串 ⇒ 显示正常文案）。
function hint(environment) { return normalize(environment) === SANDBOX ? '' : SANDBOX_ONLY_MESSAGE }

module.exports = {
  PRODUCTION, SANDBOX,
  IDENTITY_FUNCTION, BUSINESS_FUNCTION,
  SANDBOX_ONLY_CODE, SANDBOX_ONLY_MESSAGE, PROTECTED_COMMANDS,
  normalize, isSandbox, identityFunction, businessFunction, reject, blocked, hint
}
