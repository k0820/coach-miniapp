const cloud = require('wx-server-sdk')
const { createService } = require('./service')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// ─────────────────────────────────────────────────────────────────────────────
// 🎨 「获取小程序码」能力（`wxacode.getUnlimited`）—— 2026-10-04 需求 B 的**唯一外部缺口**。
//
// ⭐⭐ 2026-10-05 晚核完（需求五）：**这个接口不需要单独申请**。
//   `wxacode.getUnlimited` 支持**云调用**，只要在本云函数的 `config.json` 里声明
//   `permissions.openapi: ["wxacode.getUnlimited"]` 即可 —— 微信公众平台**没有**「申请获取小程序码」
//   这个独立入口（它不是微信支付那一类需要签约的能力）。本轮已补齐 `config.json`，
//   ⇒ 开关置 `true`，**部署后真机扫码验证即可**（扫得出认领确认页 = 已可用）。
//   ⛔ 唯一需要回后台看一眼的情况：扫码报 **48001 / 41001**（接口未授权），
//      此时才去「开发管理 → 接口权限」确认「获取小程序码」是否显示"未获得"。
//
// ⛔⛔ 为什么**绝对不许**在这里"返回一个占位图 / 假装成功"：
//   `createClaimQrCode` 的返回值会直接显示在教练页面上。返回一个假二维码 =
//   教练扫一扫扫不出任何东西，而界面上写着"已生成" —— 这是**方向相反的欺骗**，
//   比"明确报缺口"恶劣得多：教练会以为是会员不配合扫码，而不是功能没开通。
//
// ⭐ 为什么"不注入"就是正确的失败表达（而不是注入一个 throw 的函数）：
//   service 里那道能力闸在**任何写入之前**判掉（`!qrCode` ⇒ 直接抛
//   `QRCODE_CAPABILITY_UNAVAILABLE`）。所以这条路径**一个字节都不会写** ——
//   不消耗教练 revision、不留回执、不落半张票据 ⇒ 教练点多少次都是干净的失败，
//   不会出现"提示失败但邀请已经被消耗"这种最难排查的坏状态。
//
// 📌 开通之后怎么接（**唯一**要改的就是本文件，其余代码一个字都不用动）：
//   1. 公众平台开通「获取小程序码」；
//   2. 实现 `qrCode({ ticket, coachId, studentId, expiresAt })`，内部
//      `cloud.openapi.wxacode.getUnlimited(...)` 拿 buffer，再 `cloud.uploadFile` 换成 fileID 返回；
//   3. 把它作为 `qrCode` 传给 `createService`。
//   ⛔ 注意 `scene` 有 **32 字节以内** 的限制，而 inviteTicket 是 43 字符 base64url —— 直接塞进去
//      会被微信拒。已改成"短门牌号 `claimScene`（16 字符）"映射，
//      ⛔ 绝不能为了"塞得下"就把 ticket 截短 —— 截短的 ticket 空间骤降，会变成可枚举凭据。
// ─────────────────────────────────────────────────────────────────────────────
// 🔲 二维码开关（2026-10-05 晚置 `true`）。
//   ⭐ **置 true 的依据**：接口无需单独申请（见文件头），`config.json` 已声明 openapi 权限。
//   ⛔ 但"能调通"**仍要真机扫码才算数**：`pages/member-claim/member-claim` 必须已随体验版发布，
//      否则微信回 41030（我们会翻译成「页面不存在」的二维码错误，⛔ 绝不甩错误码给教练）。
//   ⛔ 失败时**照旧如实报缺口**（`QRCODE_CAPABILITY_UNAVAILABLE` 等），
//      教练页面显示"请用分享或复制8位认领码" —— 分享与短码**不受影响**（有测试钉死）。
const QRCODE_ENABLED = true

// ⭐ 体验版 / 开发版阶段扫码要能打开 ⇒ envVersion 用 'trial'；
//    ⚠ 正式发布之后记得改成 'release'（否则已发布的码会把用户指向体验版）。
const QRCODE_ENV_VERSION = 'trial'

const qr = require('./claim-qrcode')

exports.main = createService({
  db: cloud.database(),
  getOpenId: () => cloud.getWXContext().OPENID,
  now: () => Date.now(),
  // ⛔ 未开通时**不注入** ⇒ service 里那道能力闸在写入之前直接判掉（零副作用）。
  qrCode: QRCODE_ENABLED ? qr.createQrCodeProvider({ envVersion: QRCODE_ENV_VERSION }) : undefined
})
