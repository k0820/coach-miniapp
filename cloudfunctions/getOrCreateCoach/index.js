const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const coaches = db.collection('coaches')
const COACH_SCHEMA_VERSION = 1

const coachIdFor = openId => crypto
  .createHash('sha256')
  .update(`coach:${openId}`)
  .digest('hex')
  .slice(0, 32)

async function findCoach(coachId) {
  const result = await coaches.where({ _id: coachId }).limit(1).get()
  return result && result.data && result.data[0]
}

function publicCoach(coach) {
  return {
    coachId: coach._id,
    status: coach.status,
    schemaVersion: coach.schemaVersion,
    migrationVersion: coach.migrationVersion,
    createdAt: coach.createdAt,
    updatedAt: coach.updatedAt
  }
}

exports.main = async () => {
  const context = cloud.getWXContext()
  const openId = context.OPENID
  if (!openId) {
    return { ok: false, code: 'IDENTITY_MISSING', message: '未能确认当前微信身份。' }
  }

  const coachId = coachIdFor(openId)
  let coach = await findCoach(coachId)

  if (coach) {
    if (coach.openId !== openId) {
      return { ok: false, code: 'OWNER_MISMATCH', message: '用户资料归属异常。' }
    }
    return { ok: true, created: false, coach: publicCoach(coach) }
  }

  const now = db.serverDate()
  const newCoach = {
    _id: coachId,
    openId,
    status: 'active',
    schemaVersion: COACH_SCHEMA_VERSION,
    migrationVersion: 0,
    createdAt: now,
    updatedAt: now
  }

  try {
    await coaches.add({ data: newCoach })
    return { ok: true, created: true, coach: publicCoach(newCoach) }
  } catch (error) {
    // Concurrent first calls can race. Re-read the deterministic record and
    // accept it only when it belongs to the same trusted OPENID.
    coach = await findCoach(coachId)
    if (!coach || coach.openId !== openId) {
      return { ok: false, code: 'CREATE_FAILED', message: '无法创建用户资料。' }
    }
    return { ok: true, created: false, coach: publicCoach(coach) }
  }
}
