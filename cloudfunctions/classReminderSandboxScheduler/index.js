// ─────────────────────────────────────────────────────────────────────────────
// ⏰ 课前提醒 · **测试区（Sandbox）**定时云函数（2026-10-05 需求二）
//
// ⭐ 与 `classReminderScheduler` 的关系：**逐字节镜像的业务逻辑**（`reminder-core.js`），
//   只有**集合注入**不同 —— 这是全项目"一个云环境、靠集合名前缀隔离"的既定口径。
//
// ⛔⛔ 三条隔离纪律（tests/sandbox-cloud-isolation.test.js 钉死）：
//   ① 本目录源码里**不存在任何正式区集合名的字面量**；
//   ② 账本清单只来自 `coach_sandbox_heads` ⇒ 只能扫到测试区的假数据；
//   ③ 会员标识只查 `member_sandbox_student_claims` / `member_sandbox_accounts`
//      ⇒ **测试区的提醒绝不可能发给正式用户**。
//
// ⏱️ **测试时钟**（2026-10-05 需求四）：真机验收不可能真的等 3 小时 / 1 小时。
//    ⇒ 本函数支持**手动**调用时把"现在"往前拨若干分钟（`offsetMinutes`），
//      用来在 10 分钟内走完 A/B/C/D/E 五节课的验收。
//    ⛔⛔ 三条硬边界（tests/class-reminder-scheduler.test.js 用源码锚钉死）：
//      a) **只有手动调用**（`command:'runOnce'`）才认这个偏移；定时器触发 ⇒ 一律用真实时间；
//      b) **只有这一个文件里有**（正式区 `classReminderScheduler/index.js` 连这个词都没有）；
//      c) 偏移**只能往前**（≥0）且有上限 ⇒ ⛔ 不能把时间拨回过去"再发一次"。
// ----------------------------------------------------------------------------
const cloud = require('wx-server-sdk')
const core = require('./reminder-core')
const { createNotifyDelivery } = require('./notify-adapter')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// ✅ 测试区：**打开**（只发给测试区的假用户，本来就是用来验收这条链路的）。
const REMINDER_DELIVERY_ENABLED = true

const ENVIRONMENT = 'sandbox'
const COLLECTIONS = Object.freeze({
  heads: 'coach_sandbox_heads',                 // 测试区账本清单
  bookings: 'bookings',                         // 两个环境共用的业务集合，靠 ownerCoachId + datasetId 隔离行
  reminders: 'coach_sandbox_class_reminders',   // 测试区提醒状态
  claims: 'member_sandbox_student_claims',      // 测试区认领关系
  coaches: 'coaches',
  accounts: 'member_sandbox_accounts',
  // ⭐ 会员主资料：给会员发课前提醒时，openId 的**主源**（accounts 只是兼容回落）。
  members: 'member_sandbox_members'
})

// ⏱️ 测试时钟上限：**最多往前拨 24 小时**（再多就没有意义，也容易误伤）。
const MAX_OFFSET_MINUTES = 24 * 60

async function scanAt(db, delivery, now) {
  const startedAt = Date.now()
  const outcome = await core.scanOnce({
    db, environment: ENVIRONMENT, collections: COLLECTIONS,
    send: delivery.send, openIdFor: delivery.openIdFor, now
  })
  return { ok: true, ...outcome, elapsed: Date.now() - startedAt }
}

exports.main = async (event = {}) => {
  const db = cloud.database()
  const delivery = createNotifyDelivery({
    cloud, db, environment: ENVIRONMENT, enabled: REMINDER_DELIVERY_ENABLED,
    accountsCollection: COLLECTIONS.accounts, membersCollection: COLLECTIONS.members
  })
  if (!delivery.enabled) {
    return { ok: true, environment: ENVIRONMENT, skipped: true, code: 'DELIVERY_DISABLED', message: '测试区提醒发送开关未打开。', scanned: 0, sent: 0 }
  }

  // 🔧 建表入口：**已经用完并删除**（2026-10-05 夜）。
  //    当时用它创建了 `coach_sandbox_class_reminders`，随后立刻从源码里删掉、重新部署了干净版本
  //    ⇒ ⛔ 现在这里**没有任何建表代码**，也不该再有（tests/notify-acceptance-16.test.js 段 ⑰-b 钉死）。

  // ⏱️ 手动跑一次（带可选的测试时钟偏移）
  if (event && event.command === 'runOnce') {
    // ⛔ 调用方必须显式声明 sandbox；不声明或声明成别的一律拒绝（⛔ 绝不允许"默认打正式区"）。
    if (event.environment && String(event.environment) !== 'sandbox') {
      return { ok: false, environment: ENVIRONMENT, code: 'ENVIRONMENT_MISMATCH', message: '本函数只在测试区可用。', scanned: 0, sent: 0 }
    }
    const minutes = Number(event.offsetMinutes || 0)
    const safeMinutes = Number.isFinite(minutes) ? Math.min(Math.max(0, Math.floor(minutes)), MAX_OFFSET_MINUTES) : 0
    const now = Date.now() + safeMinutes * 60 * 1000
    const outcome = await scanAt(db, delivery, now)
    return { ...outcome, testClockOffsetMinutes: safeMinutes, manualRun: true }
  }

  // 🕐 定时器触发：⛔ 一律真实时间，绝不加任何偏移。
  return await scanAt(db, delivery, Date.now())
}
