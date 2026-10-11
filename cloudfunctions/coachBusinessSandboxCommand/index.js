// ─────────────────────────────────────────────────────────────────────────────
// ⛔⛔ `coachBusinessSandboxCommand` —— **测试区专用**的教练业务云函数入口。
//
// ⭐ 为什么要单独一个函数（而不是把新代码部署到 `coachBusinessCommand`）：
//   全项目**只有一个微信云环境**（`cloud1-d6g8l8h3uc9d8976f`，见 app.js），
//   Sandbox 与 Production 只是**同一个环境内的集合名前缀隔离**（`coach_sandbox_*` 与正式区前缀）。
//   ⇒ 部署 `coachBusinessCommand` = 直接**替换**正式区共用的那个云函数；
//      一旦新代码有问题，正式区教练的每一次排课 / 收款 / 完课都会一起受影响。本函数与它互不相干。
//
// ⛔ 三条硬约束（本文件是 ① 的执行点，②③ 由 `./core` `./authorization` `./notify` `./sharing` 钉死）：
//   ① `event.environment` 不**严格等于** `'sandbox'` ⇒ 立即拒绝（零集合访问）；
//   ② 只允许访问 `member_sandbox_*` / `coach_sandbox_*`；
//   ③ 禁止任何"缺省值 / 动态前缀 / 参数回退"落到正式区集合。
//
// ⛔⛔ 与正式区那份的一个**故意差异**：`repair.js`（数据修复窄通道）**没有**被镜像进来。
//    它是正式区救援工具（补墓碑 / 撤销墓碑 / 清理测试行），⛔ 绝不该出现在测试区函数里 ——
//    少一条通道比多一条"能改正式区形状"的通道安全得多。
//
// ⭐ 业务逻辑**不复制**：`core / handlers / memberBooking / occupancy / teaching / short-code`
//    都是与 `coachBusinessCommand` 逐字节一致的镜像（由 `tests/sandbox-cloud-isolation.test.js` 钉死），
//    差异**只在**集合名与门禁两层 ⇒ 沙盒测得的就是正式区将来要跑的那份逻辑。
const cloud = require('wx-server-sdk')
const core = require('./core')
const { createService } = require('./core')
const { handlers } = require('./handlers')
const { SANDBOX, rejectOperation } = require('./sandbox-guard')
// 📥 站内消息中心（2026-10-06）：**只有测试区**有这一份（`createInbox` 内部还有一道环境硬闸）。
const { createInbox } = require('./notification-inbox')

// 📇 2026-10-06 新会员方案（唯一会员 + 双向联系人）：**只有测试区**有这一份。
const { createDirectory } = require('./member-directory')
// 会员约课页的只读投影也必须部署在 Sandbox 专属函数中；共享的
// `readMyMemberData` 未获准部署，不能继续让测试区调用它的旧云端版本。
const { createService: createMemberReadService } = require('./member-read')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
// ⛔ 环境不是 sandbox ⇒ `createInbox` 返回 `null` ⇒ 一次写都不可能发生（双保险）。
const inbox = createInbox({ db, environment: SANDBOX })
// ⛔ 会员身份解析：`openId ⇒ 微信身份对应的唯一会员`。⛔ 查不到返回空 ⇒ 预约通道回退旧算法。
const directory = createDirectory({ db, cloud, getOpenId: () => cloud.getWXContext().OPENID, environment: SANDBOX })
const memberRead = createMemberReadService({ db, getOpenId: () => cloud.getWXContext().OPENID })

// 🔔 与正式区同一个投递层，但**测试区默认打开**（用的全是 Sandbox 假数据，不会碰到真实会员）。
//   ⛔ 即便打开：模板没填 ID ⇒ 会如实回 `TEMPLATE_NOT_CONFIGURED`，绝不假装发送。
const NOTIFY_DELIVERY_ENABLED = true
const { createNotifyDelivery } = require('./notify-adapter')

const service = createService({
  db,
  getOpenId: () => cloud.getWXContext().OPENID,
  handlers,
  // ⛔ 只认 Sandbox 的会员集合（⛔ 绝不碰正式区那两张表）
  //   ⭐ `membersCollection`（会员主资料）是新加的：**教练 ⇒ 会员**这条通知链靠它找到收件人，
  //     只靠旧的 `accounts` 派生索引，索引没落上时整条链会静默断掉（1.3.37 根因）。
  delivery: createNotifyDelivery({
    cloud, db, environment: SANDBOX, enabled: NOTIFY_DELIVERY_ENABLED,
    accountsCollection: 'member_sandbox_accounts', membersCollection: 'member_sandbox_members',
    inbox
  }),
})

exports.main = async event => {
  const source = event || {}
  // ⓵ 环境闸（**在读任何集合之前**）：非 sandbox ⇒ 立刻回绝。
  //    会员预约那三条写命令还会再逐条判一次（见 `./sandbox-guard`）。
  const rejected = rejectOperation(String(source.command || ''), source.environment)
  if (rejected) return rejected
  // ⓵·五 📥 站内消息中心（**只读 / 标记已读**）：
  //   ⛔ 环境闸**已经**先跑过了 ⇒ 这条路径不可能落到正式区集合。
  //   ⛔ 收件人**只由 OPENID 反查**（`inbox.handle` 内部）⇒ 客户端提交不了也改不动。
  if (source.action === 'inbox' && inbox) {
    const openId = cloud.getWXContext().OPENID
    if (!openId) return { ok: false, code: 'IDENTITY_MISSING', message: '未能确认当前微信身份。', environment: SANDBOX }
    return inbox.handle({ openId, kind: String(source.kind || ''), op: String(source.op || 'list'), ids: source.ids })
  }
  // ⓵·六 📇 新会员方案（唯一会员 / 双向联系人 / 手机尾号 / 二维码票据）：
  //   ⛔ 环境闸**已经**先跑过了 ⇒ 这条路径不可能落到正式区集合；`createDirectory` 内部还会再判一次。
  if (source.action === 'memberDirectory') {
    // 外层 action 只负责选模块；目录模块必须收到客户端请求的真实动作。
    return directory({ ...source, action: String(source.directoryAction || '') })
  }
  if (source.action === 'memberRead') {
    return memberRead({ ...source, action: String(source.readAction || 'read'), environment: SANDBOX })
  }
  // ⓶ 强制改写成 sandbox：即使上层传了别的值（此时已不可能），落点也只能是沙盒。
  return service({ ...source, environment: SANDBOX })
}

module.exports.core = core

