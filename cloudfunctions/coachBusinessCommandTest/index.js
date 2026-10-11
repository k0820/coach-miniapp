const cloud = require('wx-server-sdk')
const { createService } = require('./core')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = createService({
  db,
  getOpenId: () => cloud.getWXContext().OPENID,
  now: () => Date.now()
})
