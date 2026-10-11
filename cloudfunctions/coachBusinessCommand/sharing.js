// M2 第二批：跨教练访问**同一份会员真实课时**（2026-09-26 建；2026-09-27 业务模型校正）。
//
// ★★ 一句话模型（写给下一个改这个文件的人）★★
//   **课时事实属于会员本人。不存在「课时包所属教练」，不存在「A 把课时共享给 B」，**
//   **不存在「B 消费 A 的课时」，也不存在「会员归属于某个教练」。**
//   A / B / C 只是**可能给这位会员上课的教练**；区别只在「这一节是谁在上」（见 teaching.js）。
//   `ownerCoachId` / `datasetId` 只是「这份数据物理存在哪本账里」的**存储位置**，不是所有权。
//   ⇒ 多位教练用的是**同一份 remaining / reserved / used**，
//     绝不在第二位教练那里复制一份余额（复制余额 = 出现第二套课时，M2 全部规则失效）。
//
// 存储布局：
//   课时包（会员的课时事实）→ 物理唯一，只存在于某一本账 (ownerCoachId=A, datasetId=dsA)
//   预约 booking            → 存在于**授课教练**那本账（谁上这节课，课就记在谁的课表里）
//   booking.packageUsage = { packageId, studentId, ownerCoachId, datasetId }  ← 指向课时事实的物理位置
//   （这样「完课收入」天然落在授课教练那本账里：收入跟着 booking 走，booking 在谁那儿收入就是谁的；
//     而「销售业绩」留在记录这笔购买的那本账里 —— 两者互不相干，见 handlers.completeBooking。）
//
// ★★ 为什么现在必须有「共享码」这一层（安全，不是装饰）★★
//   客户端**禁止**提交 ownerCoachId / datasetId（core.js 的 FORBIDDEN 硬门禁）。
//   所以 B 不能说"我要用 A 的那个包" —— 必须由服务端**自己**把这句话翻译成存储位置。
//   共享码就是那把钥匙：A 显式授权生成，B 拿着码预约，服务端解析码得到 (A, dsA, packageId)。
//   没有这一步，就只剩"猜别人的 packageId"，等于把数据集隔离拆了。
//
// ⛳ **产品定位（2026-09-26 与她确认；2026-09-27 再次确认）：这是一条「过渡期技术桥梁」，不是业务流程。**
//   最终产品模型是：**会员不属于任何教练** —— 会员本人靠微信身份认自己的真实课时，
//   自己决定给 A / B / C 哪位教练约课。届时"教练 A 手工生成码 → 教练 B 拿码才能上课"
//   这条路径应当**下线**，而不是继续长大。
//   它现在存在的唯一理由：在「会员自主选择教练」（M3）落地之前，需要一条
//   **既能让不同微信身份的教练访问同一份会员课时事实、又不给客户端任意跨教练定位能力**的技术通道，
//   用来做 Sandbox 验收。
//   ⚠️ 正式结论：不要在这条路径上加长期业务规则；不要把共享码机制带进最终会员产品；
//      M3 上线时它应该被替代而不是被扩展。
//
// ★★ 一条关键不变量（reserved 之所以敢只数本数据集）★★
//   共享预约**只能出现在共享码建立之后**；而建码时必然已经完成本数据集内的
//   reserved 惰性初始化（occupancy.syncReserved）。⇒ 之后所有共享预约都走 ±1 增量，
//   惰性初始化永远不需要跨教练去数别人的预约 —— 也就不可能出现"少算跨教练占用"。

const { fixedId, one, put } = require('./core')
// ⭐ M3-P2-3：8 位人工短码。本目录与 `memberIdentityCommand` 各存一份**逐字节相同**的孪生实现
//   （微信云函数按目录独立部署 ⇒ 跨目录 require 在真机上找不到文件）。由 `m3-p2-short-code` 锁死。
const shortCode = require('./short-code')

const SHARE_COLLECTIONS = Object.freeze({
  production: 'coach_package_shares',
  sandbox: 'coach_sandbox_package_shares'
})
const SHARE_KIND = 'coach-package-share'
const SHARE_ACTIVE = 'active'
const SHARE_REVOKED = 'revoked'
// ⭐ M3-P2-3：共享码从「10 位大写十六进制」改为 **8 位人工短码**（见 `short-code.js` 顶部）。
//   ⚠️ 8 位短码的字符集（0-9 A-Z 去 I/L/O/U）**落在**这个正则之内 ⇒ 正则一个字都没改，
//      而且 `shareIdFor` 的口径也没动 ⇒ **历史 10 位共享码继续有效，不需要任何数据迁移**。
const SHARE_CODE_PATTERN = /^[A-Z0-9]{6,32}$/

const shareCollection = environment => (environment === 'sandbox' ? SHARE_COLLECTIONS.sandbox : SHARE_COLLECTIONS.production)
const shareIdFor = shareCode => fixedId(SHARE_KIND, String(shareCode || ''))
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))

// 共享码：8 位短码（生成端在 `short-code.generate`；⛔ 调用方生成后**必须查重**，见 handlers.enablePackageShare）。
function newShareCode() {
  return shortCode.generate()
}

// 归一化：共享码历史上就是**大小写不敏感**（输入时统一大写）。
//   · 新 8 位短码 ⇒ 顺手纠正口述误输入（O→0、I/L→1、U→V）并忽略空格 / 连字符；
//   · 历史长码 ⇒ 走 `isShort` 判为 false 的那一支，只做 trim + 大写 + 去空白
//     （旧码是十六进制、不含空格连字符 ⇒ 与旧行为**逐字等价**，不可能把老码改坏）。
function normalizeShareCode(value) {
  const raw = String(value == null ? '' : value).trim().toUpperCase().replace(/[\s-]/g, '')
  const code = shortCode.isShort(raw) ? shortCode.correct(raw) : raw
  if (!SHARE_CODE_PATTERN.test(code)) throw Object.assign(new Error('共享码格式无效。'), { commandCode: 'INVALID_PAYLOAD' })
  return code
}

// 共享许可的读写门面。**只暴露这三个动作** —— 业务 handler 拿不到裸 tx，
// 也就没法绕开 (ownerCoachId, datasetId) 去改别人的业务行。
function shareScope(scope, environment, ownerCoachId, datasetId) {
  const name = shareCollection(environment)
  return {
    async findByCode(shareCode) {
      return one(scope, name, { _id: shareIdFor(shareCode), shareCode })
    },
    async findActiveByPackage(packageId) {
      return one(scope, name, { ownerCoachId, datasetId, packageId, status: SHARE_ACTIVE })
    },
    async write(share) {
      await put(scope, name, shareIdFor(share.shareCode), clone(share))
      return clone(share)
    },
    // ⭐「谁用过这枚码」登记表（**服务端自己记，客户端永远提交不了**）。
    //   用途只有一个：建立预约前，服务端要知道「这位会员的预约可能还散落在哪几本账里」，
    //   才能做**会员时间冲突**校验（见 teaching.findMemberTimeConflict）。
    //   记的是 (ownerCoachId, datasetId) 存储位置，**不含任何业务数据、不代表所有权**。
    //   幂等：同一位置重复登记只留一条。
    async markRedeemer(shareCode, place) {
      const share = await one(scope, name, { _id: shareIdFor(shareCode), shareCode })
      if (!share || !place || !place.ownerCoachId || !place.datasetId) return []
      const list = Array.isArray(share.redeemedBy) ? share.redeemedBy.filter(Boolean).slice(0, 50) : []
      if (!list.some(item => item.ownerCoachId === place.ownerCoachId && item.datasetId === place.datasetId)) {
        list.push({ ownerCoachId: place.ownerCoachId, datasetId: place.datasetId })
      }
      await put(scope, name, shareIdFor(shareCode), clone({ ...share, redeemedBy: list }))
      return list
    }
  }
}

// 「这位会员的预约可能散落在哪几本账」—— 只从**服务端登记过的事实**推导，不接受客户端输入。
function redeemerPlacesOf(share) {
  if (!share || !Array.isArray(share.redeemedBy)) return []
  return share.redeemedBy
    .filter(item => item && item.ownerCoachId && item.datasetId)
    .map(item => ({ ownerCoachId: item.ownerCoachId, datasetId: item.datasetId }))
}

// 预约上那枚「这份课时在谁那儿」的定位标记。
// ⚠️ ownerCoachId 的语义是**存储位置**，不是所有权（本文件开头已写明）。
function usageOf(share) {
  return {
    packageId: String(share.packageId || ''),
    studentId: String(share.studentId || ''),
    ownerCoachId: String(share.ownerCoachId || ''),
    datasetId: String(share.datasetId || '')
  }
}

function usageOfBooking(booking) {
  const usage = booking && booking.packageUsage
  if (!usage || typeof usage !== 'object') return null
  if (!usage.packageId || !usage.ownerCoachId || !usage.datasetId) return null
  return usage
}

module.exports = {
  SHARE_COLLECTIONS, SHARE_KIND, SHARE_ACTIVE, SHARE_REVOKED, SHARE_CODE_PATTERN,
  shareCollection, shareIdFor, newShareCode, normalizeShareCode, shareScope, usageOf, usageOfBooking, redeemerPlacesOf
}
