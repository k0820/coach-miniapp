// ─────────────────────────────────────────────────────────────────────────────
// ⏰ 课前提醒 · **正式区**定时云函数（2026-10-05 需求二）
//
// ⭐ 部署方式（⛔ 本轮**不部署**，只准备到"可以部署"为止）：
//   右键本目录 →「上传并部署：云端安装依赖」⇒ 目录里的 `config.json` 会被一并上传，
//   里面的 `triggers` 声明"每 5 分钟跑一次"，`permissions.openapi` 声明要用订阅消息接口。
//   ⛔ 只上传代码不更新 config.json ⇒ 权限与定时器**都不会生效**（会一直报 -604101）。
//
// ⛔⛔ 环境隔离：本函数**只读**正式区那张 heads（`coach_data_heads`）导出的账本清单，
//    提醒状态写 `coach_class_reminders`，会员标识查 `member_student_claims` / `member_accounts`。
//    ⇒ 测试区的假数据一个字节都进不来，测试区消息也绝不会发到这里的用户。
//
// ⛔⛔ **正式区没有测试时钟**：手动改"现在"这种事只存在于测试区那个同名镜像里。
//    这里一旦出现"把时间往前拨"的代码，就是**上线事故**（提前发 / 重复发 / 绕过取消作废）。
//    ⇒ 正式区只允许定时器按真实时间跑，tests/class-reminder-scheduler.test.js 有源码锚钉死。
//
// 🔒 发送开关：`REMINDER_DELIVERY_ENABLED = false` ⇒ 一次都不发（扫描照样跑、记录照样留）。
//    与 `coachBusinessCommand` 的订阅消息同一个姿势：**填好模板 ID + 打开开关**，两者齐了才算接通。
//    ⛔ 只填 ID 不开开关（或反过来）都不会发送 —— 这是故意的，防止"上线当天误发全量用户"。
// ----------------------------------------------------------------------------
const cloud = require('wx-server-sdk')
const core = require('./reminder-core')
const { createNotifyDelivery } = require('./notify-adapter')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// ⛔ 正式区：上线前保持 false；模板 ID 填好 + 真机验收通过之后再打开。
const REMINDER_DELIVERY_ENABLED = false

const ENVIRONMENT = 'production'
const COLLECTIONS = Object.freeze({
  heads: 'coach_data_heads',            // 正式区账本清单（⛔ 绝不能读测试区那张表）
  bookings: 'bookings',                 // 两个环境**共用**的业务集合，靠 ownerCoachId + datasetId 隔离行
  reminders: 'coach_class_reminders',   // 提醒状态（元集合，不进 BUSINESS、不参与指纹）
  claims: 'member_student_claims',      // 认领关系（推导"这节课的会员是谁"）
  coaches: 'coaches',
  accounts: 'member_accounts',
  // ⭐ 会员主资料：给会员发课前提醒时，openId 的**主源**（accounts 只是兼容回落）。
  members: 'member_members'
})

exports.main = async (event = {}) => {
  const db = cloud.database()
  const delivery = createNotifyDelivery({
    cloud, db, environment: ENVIRONMENT, enabled: REMINDER_DELIVERY_ENABLED,
    accountsCollection: COLLECTIONS.accounts, membersCollection: COLLECTIONS.members
  })
  // ⛔ 开关没打开 ⇒ **一次都不发**（也不去查任何 openid），但如实回一条"已跳过"。
  if (!delivery.enabled) {
    return { ok: true, environment: ENVIRONMENT, skipped: true, code: 'DELIVERY_DISABLED', message: '正式区提醒发送开关未打开（模板配置好、真机验收通过后再开）。', scanned: 0, sent: 0 }
  }
  const startedAt = Date.now()
  const outcome = await core.scanOnce({
    db, environment: ENVIRONMENT, collections: COLLECTIONS,
    send: delivery.send, openIdFor: delivery.openIdFor, now: startedAt
  })
  return { ok: true, ...outcome, elapsed: Date.now() - startedAt }
}
