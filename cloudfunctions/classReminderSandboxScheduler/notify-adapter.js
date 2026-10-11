// 🔌 把「微信订阅消息」接到 `core.execute` 上的那一小段适配器（2026-10-05 需求五）
//
// ⭐ 为什么单独一个文件：投递层（`subscribe-delivery.js`）**不碰** `wx-server-sdk`，
//    这样它能在 Node 里被直接测试；真正依赖云环境的只有这一个文件（读 openid + 调 openapi）。
//
// ⛔⛔ 三条纪律：
//   ① **收件人的微信标识只从服务端自己的表里读**：教练读 `coaches`、会员读 `member_*_accounts`。
//      ⛔ 绝不从客户端 payload 里取任何 openid（那等于谁能指定就发给谁）。
//   ② **Sandbox 只读 Sandbox 的表**：集合名由 `environment` 决定（测试 vs 正式两份）。
//   ③ **开关是显式的**：`enabled=false` ⇒ 一次都不发（事件照旧落库，投递不发生）。
//
// 📌 开通步骤（用户本人在微信后台）：申请 5 个订阅消息模板 → 把 ID 填进
//    `subscribe-delivery.js` 的 `TEMPLATE_IDS` → 把 `enabled` 打开 → 部署 → 真机验收。
//    ⛔ 只填 ID 不开开关（或反之）都不会发送 —— 两个都在，才算真的接通。
// ⭐ 会员账号集合由**调用方（index.js）**传入：本文件是正式区与 Sandbox 的**逐字节镜像**，
//    ⛔ 字面量里出现正式区集合名会直接违反隔离纪律（tests/sandbox-cloud-isolation.test.js ⑦）。
//    ⇒ 正式区入口传正式区集合，Sandbox 入口传 Sandbox 集合，两边各自钉死。
function createNotifyDelivery({ cloud, db, environment = 'production', enabled = false, accountsCollection = '', membersCollection = '' }) {
  // 🔎 从一张「会员身份表」里读 openId。
  //    集合不存在 / 权限 / 网络任何故障 ⇒ **返回空串让调用方继续走下一条退路**，
  //    ⛔ 绝不把"这一张表坏了"当成"这个人没有微信"（1.3.37 实测：那样会让整条链静默断掉）。
  async function openIdIn(name, cond) {
    try {
      const response = await db.collection(name).where(cond).limit(1).get()
      const row = response && response.data && response.data[0]
      return row && row.openId ? String(row.openId) : ''
    } catch (error) {
      console.error('[subscribe] 会员身份表读取失败，改用下一张表重试', String(error && error.message || error))
      return ''
    }
  }

  // 🎯 收件人 → 微信 openid。⛔ 查不到就返回空串（投递层会记 `RECIPIENT_OPENID_MISSING`，
  //    绝不拿任何"猜出来"的标识去发）。
  async function openIdFor(recipient) {
    const target = recipient || {}
    try {
      if (target.kind === 'coach') {
        if (!target.coachId) return ''
        const found = await db.collection('coaches').doc(String(target.coachId)).get()
        const row = found && found.data
        return row ? String(row.openId || '') : ''
      }
      if (target.kind === 'member') {
        const wanted = String(target.memberId || '')
        if (!wanted) return ''
        // ① **会员主资料**（唯一真相源）：这一行本身就带着会员当前真实的 openId
        //    ⇒ 课前 3 小时 / 1 小时提醒要发给会员时，只要她绑定过微信就一定找得到。
        //    2026-10-07（1.3.37）：以前只读 accounts 派生索引，索引没落上时这条提醒会静默消失。
        if (membersCollection) {
          const own = await openIdIn(membersCollection, { memberId: wanted })
          if (own) return own
        }
        // ② 兼容回落：既有的账号派生索引（历史会员可能只有这一份），⛔ 不删、不改。
        if (!accountsCollection) return ''
        return await openIdIn(accountsCollection, { memberId: wanted })
      }
    } catch (error) {
      console.error('[subscribe] 读取收件人标识失败（这条提醒本次不发送）', String(error && error.message || error))
    }
    return ''
  }

  // ⛔⛔ **微信开放接口的参数必须用「下划线」命名**（`template_id` / `miniprogram_state`）。
  //    2026-10-05 夜修 bug 时发现这里原本写成驼峰（`templateId` / `miniprogramState`），
  //    微信会**忽略**不认识的字段 ⇒ 缺 `template_id` ⇒ 订阅消息**一条都发不出去**
  //    （界面却可能显示"已发送"，这是最恶劣的一种假象）。
  //    ⛔ `miniprogram_state`：正式版=formal、体验版=trial、开发版=develop。
  //       在体验版上验收时若不传 trial，通知卡片点开会跳到一个"还没发布的正式版页面"。
  async function send({ touser, templateId, page, data, miniprogramState }) {
    // ⛔ 直接调真接口：失败会抛出带 `errCode` 的错误，由投递层翻译成人话并留下记录。
    return cloud.openapi.subscribeMessage.send({
      touser, page, data,
      template_id: templateId,
      miniprogram_state: miniprogramState || 'formal'
    })
  }

  return { enabled: enabled === true, send, openIdFor, environment }
}

module.exports = { createNotifyDelivery }
