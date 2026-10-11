const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const backups = cloud.database().collection('coach_db_backups')
const db = cloud.database()
const manifests = db.collection('coach_backup_manifests')
const chunks = db.collection('coach_backup_chunks')
const coachIdFor = openId => crypto.createHash('sha256').update(`coach:${openId}`).digest('hex').slice(0, 32)
async function all(collection, filter) { const output=[]; for(let skip=0;;skip+=100){const result=await collection.where(filter).skip(skip).limit(100).get(),page=result.data||[];output.push(...page);if(page.length<100)return output} }

exports.main = async () => {
  const context = cloud.getWXContext()
  const openId = context.OPENID
  if (!openId) return { ok: false, code: 'NO_IDENTITY', message: '未能确认当前微信身份，已停止删除。' }

  const backupId = crypto.createHash('sha256').update(`coach-db-backup:${openId}`).digest('hex').slice(0, 32)
  const ownerCoachId = coachIdFor(openId)
  let record
  let hadCloudBackup = false
  try {
    const result = await backups.where({ _id: backupId }).limit(1).get()
    record = result && result.data && result.data[0]
    hadCloudBackup = !!record
  } catch (error) {
    console.error('[delete-my-data] lookup failed', error && (error.code || error.message) || 'UNKNOWN_ERROR')
    return { ok: false, code: 'LOOKUP_FAILED', message: '无法确认云端备份状态，已停止删除。' }
  }

  if (record && record.ownerOpenId !== openId) return { ok: false, code: 'OWNER_MISMATCH', message: '云端备份身份校验失败，已停止删除。' }

  try {
    const ownManifests = await all(manifests, { ownerCoachId })
    const ownChunks = await all(chunks, { ownerCoachId })
    hadCloudBackup = hadCloudBackup || ownManifests.length > 0 || ownChunks.length > 0
    await Promise.all(ownChunks.map(item => chunks.doc(item._id).remove()))
    await Promise.all(ownManifests.map(item => manifests.doc(item._id).remove()))
    const removal = record ? await backups.doc(backupId).remove() : { stats: { removed: 0 } }
    if (record && (!removal || !removal.stats || removal.stats.removed !== 1)) {
      return { ok: false, code: 'DELETE_UNCERTAIN', message: '无法确认云端备份是否已删除，本机数据保持不变。' }
    }
    const verify = await backups.where({ _id: backupId }).limit(1).get()
    const verifyManifests = await all(manifests, { ownerCoachId })
    const verifyChunks = await all(chunks, { ownerCoachId })
    if ((verify && verify.data && verify.data.length) || verifyManifests.length || verifyChunks.length) {
      return { ok: false, code: 'STILL_EXISTS', message: '云端备份仍然存在，本机数据保持不变。' }
    }
  } catch (error) {
    console.error('[delete-my-data] delete failed', error && (error.code || error.message) || 'UNKNOWN_ERROR')
    return { ok: false, code: 'DELETE_FAILED', message: '删除云端备份失败，本机数据保持不变。' }
  }
  return { ok: true, deleted: hadCloudBackup, alreadyAbsent: !hadCloudBackup }
}
