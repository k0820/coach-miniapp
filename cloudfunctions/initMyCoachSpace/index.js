const cloud = require('wx-server-sdk')
const { createService } = require('./service')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
// 身份只来自微信上下文：客户端提交的 ownerCoachId / datasetId 一律不被采信（service 里直接拒绝）。
exports.main = createService({ db: cloud.database(), getOpenId: () => cloud.getWXContext().OPENID })
