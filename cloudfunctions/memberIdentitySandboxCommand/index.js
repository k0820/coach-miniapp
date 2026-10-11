// ─────────────────────────────────────────────────────────────────────────────
// ⛔⛔ `memberIdentitySandboxCommand` —— **测试区专用**的会员身份云函数入口。
//
// ⭐ 为什么要单独一个函数（而不是把新代码部署到 `memberIdentityCommand`）：
//   全项目**只有一个微信云环境**（`cloud1-d6g8l8h3uc9d8976f`，见 app.js），
//   Sandbox 与 Production 只是**同一个环境内的集合名前缀隔离**（`member_sandbox_*` 与正式区前缀）。
//   ⇒ 部署 `memberIdentityCommand` = 直接**替换**正式区共用的那个云函数；
//      一旦新代码有问题，正式区会员立刻一起受影响。本函数与它**互不相干**，随便测。
//
// ⛔ 三条硬约束（本文件就是它们的唯一执行点）：
//   ① `event.environment` 不**严格等于** `'sandbox'` ⇒ 立即拒绝（零集合访问）；
//   ② 只允许访问 `member_sandbox_*`（契约已钉死，见 `./member-contract`）；
//   ③ 禁止任何"缺省值 / 动态前缀 / 参数回退"落到正式区集合。
//
// ⭐ 业务逻辑**不复制**：`./service.js` 是与 `memberIdentityCommand/service.js`
//    逐字节一致的镜像（由 `tests/sandbox-cloud-isolation.test.js` 钉死），
//    差异**只在**契约与门禁两层 ⇒ 沙盒测得的就是正式区将来要跑的那份逻辑。
//    ⚠️ 改动 `memberIdentityCommand` 之后必须重新镜像（那条测试会红，红就是提醒）。
const cloud = require('wx-server-sdk')
const { createService } = require('./service')
const { SANDBOX, rejectOperation } = require('./sandbox-guard')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 🔲 与正式区同一个开关口径（2026-10-05 晚置 `true`）：
//   `wxacode.getUnlimited` 走云调用、**无需单独申请**，`config.json` 已声明 openapi 权限
//   ⇒ 部署后真机扫码验证即可。⛔ 失败时**照旧如实报缺口**（⛔ 绝不返回占位图假装生成成功）。
const QRCODE_ENABLED = true
const QRCODE_ENV_VERSION = 'trial'
const qr = require('./claim-qrcode')

const service = createService({
  db: cloud.database(),
  getOpenId: () => cloud.getWXContext().OPENID,
  now: () => Date.now(),
  // ⛔ 小程序码**必须明写**它属于哪个世界：这份码是本（测试区）函数签出来的 ⇒ 扫码后只进 sandbox。
  //   ⛔ 绝不留给认领页去"先问一个环境、答不上来再问另一个" —— 那是把同一枚 scene 发给两个环境。
  qrCode: QRCODE_ENABLED
    ? qr.createQrCodeProvider({ envVersion: QRCODE_ENV_VERSION, page: `${qr.CLAIM_PAGE}?env=sandbox` })
    : undefined
})

exports.main = async event => {
  const source = event || {}
  // ⓵ 环境闸（**在读任何集合之前**）：非 sandbox ⇒ 立刻回绝。
  const rejected = rejectOperation(source.command, source.environment)
  if (rejected) return rejected
  // ⓶ 强制改写成 sandbox：即使上层传了别的值（此时已不可能），落点也只能是沙盒。
  return service({ ...source, environment: SANDBOX })
}
