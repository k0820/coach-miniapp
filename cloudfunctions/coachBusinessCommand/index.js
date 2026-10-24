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
//   ✅ 正式区保留发送能力：3 个真实模板 ID 已配置，教练接收会员预约/取消已真机验证。
//   会员侧微信通知仍受一次性订阅额度与微信投递结果限制；无论微信是否送达，站内消息都会保留。
//   ⛔ 这里仅允许随受控正式部署生效，不得拿 Production 做通知试验。
const NOTIFY_DELIVERY_ENABLED = true
const { createNotifyDelivery } = require('./notify-adapter')
const { createDirectory } = require('./member-directory')
const { createService: createMemberReadService } = require('./member-read')

const service = createService({
  db,
  getOpenId: () => cloud.getWXContext().OPENID,
  handlers,
  // ⭐ 正式区的会员集合（⛔ 只有正式区入口能写这两个名字）
  //   `membersCollection`（会员主资料）＝ **教练 ⇒ 会员**这条通知链找收件人的主源；
  //   旧的 `accounts` 派生索引降级为回落（测试区已实证：只靠索引会让整条链静默断掉）。
  delivery: createNotifyDelivery({ cloud, db, environment: 'production', enabled: NOTIFY_DELIVERY_ENABLED, accountsCollection: 'member_accounts', membersCollection: 'member_members' })
})
const directory = createDirectory({ db, cloud, getOpenId: () => cloud.getWXContext().OPENID, environment: 'production' })
const memberRead = createMemberReadService({ db, getOpenId: () => cloud.getWXContext().OPENID })

// ⚠️ 数据修复是**独立于正式命令服务**的一条窄通道：它不经过 `execute()`，因此不会
//    解锁任何写能力，也不进 22 条命令契约（`utils/cloud-command-contract` 一个字没变）。
//    它只做三件事：只读预演 / 补一条历史墓碑 / 撤销这一条墓碑。
//    正式页面永远不调用它 —— 只有一次性修复页会调。
exports.main = async event => {
  const source = event || {}
  if (source.action === 'memberDirectory') {
    return directory({ ...source, action: String(source.directoryAction || ''), environment: 'production' })
  }
  if (source.action === 'memberRead') {
    return memberRead({ ...source, action: String(source.readAction || 'read'), environment: 'production' })
  }
  if (event && ACTIONS.includes(event.action)) return runRepair({ db, getOpenId: () => cloud.getWXContext().OPENID, event })
  return service(event)
}
