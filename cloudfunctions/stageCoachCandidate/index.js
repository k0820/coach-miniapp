const cloud = require('wx-server-sdk')
const { createService } = require('./service')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const main = createService({ db: cloud.database(), getOpenId: () => cloud.getWXContext().OPENID })
exports.main = main
