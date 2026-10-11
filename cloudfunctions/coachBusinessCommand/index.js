const cloud = require('wx-server-sdk')
const { createService } = require('./core')
const { handlers } = require('./handlers')
const { ACTIONS, runRepair } = require('./repair')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// Phase 6.5C2 now implements the reviewed 22-command contract. Formal pages
// still do not call this function; owner and active dataset remain cloud-derived.
// ─────────────────────────────────────────────────────────────────────────────
// 🔔 微信订阅消息投递开关（2026-10-05）
//   ⛔ **正式区默认关闭**：教练每天真在用的那套数据，在**真机验收通过之前**一条都不许发出去。
//      （需求原文：正式区发送要保持受控，不拿真实用户做测试。）
//   ⭐ 打开它需要**同时**满足三件事，少一件都不会发送（这样"半开"不会变成半 success）：
//     ① 微信后台已申请到 5 个订阅消息模板；
//     ② `subscribe-delivery.js` 的 `TEMPLATE_IDS` 已填入真实模板 ID；
//     ③ 真机验收通过（会员预约/改期/取消 ⇒ 教练收到；教练改期/取消 ⇒ 会员收到）。
const NOTIFY_DELIVERY_ENABLED = false
const { createNotifyDelivery } = require('./notify-adapter')

const service = createService({
  db,
  getOpenId: () => cloud.getWXContext().OPENID,
  handlers,
  // ⭐ 正式区的会员集合（⛔ 只有正式区入口能写这两个名字）
  //   `membersCollection`（会员主资料）＝ **教练 ⇒ 会员**这条通知链找收件人的主源；
  //   旧的 `accounts` 派生索引降级为回落（测试区已实证：只靠索引会让整条链静默断掉）。
  delivery: createNotifyDelivery({ cloud, db, environment: 'production', enabled: NOTIFY_DELIVERY_ENABLED, accountsCollection: 'member_accounts', membersCollection: 'member_members' })
})

// ⚠️ 数据修复是**独立于正式命令服务**的一条窄通道：它不经过 `execute()`，因此不会
//    解锁任何写能力，也不进 22 条命令契约（`utils/cloud-command-contract` 一个字没变）。
//    它只做三件事：只读预演 / 补一条历史墓碑 / 撤销这一条墓碑。
//    正式页面永远不调用它 —— 只有一次性修复页会调。
exports.main = async event => {
  if (event && ACTIONS.includes(event.action)) return runRepair({ db, getOpenId: () => cloud.getWXContext().OPENID, event })
  return service(event)
}
