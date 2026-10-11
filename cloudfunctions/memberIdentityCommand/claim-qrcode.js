// ─────────────────────────────────────────────────────────────────────────────
// 🎨 「真正的小程序码」提供者（`wxacode.getUnlimited`）—— 2026-10-05 需求四-B
//
// ⭐⭐ 为什么单独一个文件：`createClaimQrCode` 要的**不是**"把一段文字画成二维码"，
//   而是**微信小程序码** —— 微信扫码后**直接打开本小程序的指定页面**，并把 `scene` 原样带过去。
//   ⛔ 用"文字二维码"画 ticket 或短码是三条错：
//     ① 扫出来是**一串字符**，不是页面（会员还得自己找地方输入，等于没有入口）；
//     ② 文字里带着凭据 ⇒ 任何人扫到就能看到/转发那串凭据；
//     ③ 与"分享卡 / 短码"不是同一条路，日后排查要分三套逻辑。
//
// ⛔⛔ 三条硬纪律（tests/member-claim-qrcode.test.js 逐条钉死）：
//   ① **二维码里只有 scene**（≤32 字符的短门牌号），⛔ 绝不许出现 inviteTicket（43 字符塞不下）
//      / 短码 / studentId / coachId / 手机号 等任何可定位信息；
//   ② **扫出来直达认领确认页**（`pages/member-claim/member-claim`）—— 与分享卡、短码
//      **同一张确认卡**，⛔ 绝不是"扫完直接认领"；
//   ③ **失败必须如实**：拿不到图就抛出可识别的失败，⛔ 绝不返回占位图 / 假 fileID
//      （service 里还有一道"没有真图就不许说成功"的二重保险）。
//
// 📌 开通步骤（2026-10-05 晚核完 `需求五` 后**重写**：⛔ 原先写"必须去后台申请"是错的）：
//   ⭐ `wxacode.getUnlimited` 支持**云调用**，微信公众平台**没有**「申请获取小程序码」这个独立入口
//      —— 它不是微信支付那一类需要签约的能力。所以**无需单独申请**，只要：
//   1. 本云函数的 `config.json` 声明 `permissions.openapi: ["wxacode.getUnlimited"]`（**已补齐**）；
//   2. `index.js` 的 `QRCODE_ENABLED` 置 `true`（**已置**）；
//   3. 部署本云函数（测试区那份同名镜像也要一起部署）；
//   4. **真机扫码验证**：能进认领确认页、显示的教练与学员对得上、点确认能认领成功。
//   ⛔ 只有扫码报 48001 / 41001（接口未授权）时，才回「开发管理 → 接口权限」确认状态。
//   ⛔ 任何失败都**如实回缺口**（`QRCODE_CAPABILITY_UNAVAILABLE` 等），页面显示
//      "请用分享或复制8位认领码"，⛔ 绝不返回占位图假装成功。
// ----------------------------------------------------------------------------
const cloud = require('wx-server-sdk')

// 📄 扫码后打开的页面：**认领确认页**。⛔ 不能是别的地方 —— 会员必须先看到"谁邀请我认领什么"。
const CLAIM_PAGE = 'pages/member-claim/member-claim'
// 🎫 微信对 `scene` 的硬限制：**32 个字符以内**。
const SCENE_MAX = 32
const WIDTH = 430

function fail(code, message) { return Object.assign(new Error(message), { code }) }

// 🔎 把微信侧的错误翻译成**我们自己的**说法。⛔ 一律如实，绝不把"没权限"说成"生成成功"。
function translate(error) {
  const errCode = Number(error && error.errCode)
  const text = String((error && error.errMsg) || (error && error.message) || '')
  // 48001 / 41001 … = 接口未授权 / 缺少权限 ⇒ 这是**能力缺口**，不是"生成失败"。
  if (errCode === 48001 || errCode === 41001 || /unauthorized|permission|scope/i.test(text)) {
    return fail('QRCODE_CAPABILITY_UNAVAILABLE', '当前小程序还没有开通「获取小程序码」权限，请用「分享给会员」或「复制8位认领码」。')
  }
  if (errCode === 41030 || /page|path/i.test(text)) {
    return fail('QRCODE_PAGE_MISSING', `二维码要打开的页面不存在（${CLAIM_PAGE}），请检查页面是否已发布。`)
  }
  return fail('QRCODE_GENERATE_FAILED', '二维码生成失败，请稍后重试，或先用「分享给会员」「复制8位认领码」。')
}

// 🏭 造出 `qrCode({ ticket, scene, coachId, studentId, expiresAt })`。
//   ⛔ 参数里的 `ticket` **只用于命名上传文件**，⛔ 绝不写进二维码内容（见文件头纪律 ①）。
function createQrCodeProvider(options = {}) {
  const envVersion = options.envVersion || 'trial' // ⭐ 体验版阶段扫得到；正式发布后改 'release'
  const page = options.page || CLAIM_PAGE
  return async function qrCode({ scene, coachId }) {
    const value = String(scene == null ? '' : scene).trim()
    if (!value) throw fail('QRCODE_SCENE_MISSING', '这一次邀请没有可用的二维码场景值，请重新生成一次邀请。')
    if (value.length > SCENE_MAX) throw fail('QRCODE_SCENE_TOO_LONG', `二维码场景值超过微信 ${SCENE_MAX} 字符限制。`)
    let result = null
    try {
      // ⛔⛔ **微信开放接口的参数必须用「下划线」命名**（scene / page / width / auto_color / is_hyaline / env_version）。
      //    2026-10-05 夜真机事故：这里原本写成驼峰（`envVersion` / `autoColor` / `isHyaline`），
      //    微信**直接忽略**不认识的字段 ⇒ `env_version` 落回默认值 **"release"（正式版）**；
      //    而本小程序从未发布过正式版 ⇒ `check_path` 去正式版找 `pages/member-claim/member-claim`
      //    找不到 ⇒ 微信回 `41030 invalid page`，界面显示"二维码要打开的页面不存在"。
      //    ⛔ 修法是改对参数名，**绝不是**把 `check_path` 设成 false 来掩盖页面错误
      //       （那会生成一张扫了以后报错的二维码）。
      result = await cloud.openapi.wxacode.getUnlimited({
        scene: value, page, width: WIDTH,
        auto_color: false, is_hyaline: false,
        // ⭐ 体验版 / 开发版阶段必须是 trial 或 develop，否则扫到的会是"还没发布的正式版页面"。
        env_version: envVersion
      })
    } catch (error) { throw translate(error) }
    const buffer = result && result.buffer
    // ⛔ 二重保险：微信没给图就绝不继续（service 里还有第三道"没有真图不许说成功"）。
    if (!buffer) throw fail('QRCODE_GENERATE_FAILED', '二维码生成失败，请稍后重试，或先用「分享给会员」「复制8位认领码」。')
    const cloudPath = `claim-qr/${String(coachId || 'coach')}/${value}.png`
    try {
      const uploaded = await cloud.uploadFile({ cloudPath, fileContent: buffer })
      if (uploaded && uploaded.fileID) return uploaded.fileID
    } catch (error) { throw fail('QRCODE_UPLOAD_FAILED', '二维码生成了但没能保存到云端，请稍后重试。') }
    throw fail('QRCODE_UPLOAD_FAILED', '二维码没能保存到云端，请稍后重试。')
  }
}

module.exports = { createQrCodeProvider, CLAIM_PAGE, SCENE_MAX }
