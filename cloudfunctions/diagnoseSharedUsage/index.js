// M2 第三批：`diagnoseSharedUsage` 的云端入口（**零写入**，只读取证）。
//
// 这里只做三件事，其余判据全在 `./service.js`：
//   ① 取可信身份（`cloud.getWXContext().OPENID` —— 客户端伪造不了）；
//   ② 拒收任何身份 / 数据集定位字段；
//   ③ 把请求交给 service。
// ⚠️ 本文件**不写任何文档**：没有 set / update / remove，也不碰 revision / receipt。
//   真正会碰 DB 的地方只有 service.js，而它也只用 `.get()`。
// ⚠️ `coachIdFor` / `fixedId` 与 core.js、service.js 是同一份事实的副本（云函数各自独立部署，
//    不能互相 require）；`tests/m2-shared-verification.test.js` 有漂移即红的契约断言盯着。
const cloud = require('wx-server-sdk')
const { createService } = require('./service')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const main = createService({ db, getOpenId: () => cloud.getWXContext().OPENID, now: () => Date.now() })

exports.main = async event => {
  try {
    return await main(event || {})
  } catch (error) {
    // 只读取证失败**不重试、不兜底** —— 如实把这个码带回去，让核验器按"未通过"处理
    // （"读不到证据"永远不等于"账是平的"）。
    return { ok: false, code: 'SHARED_USAGE_THREW', message: String((error && error.message) || error) }
  }
}
