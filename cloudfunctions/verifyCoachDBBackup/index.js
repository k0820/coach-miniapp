const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const legacyBackups = db.collection('coach_db_backups')
const manifests = db.collection('coach_backup_manifests')
const chunks = db.collection('coach_backup_chunks')
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const coachIdFor = openId => digest(`coach:${openId}`).slice(0, 32)
const legacyIdFor = openId => digest(`coach-db-backup:${openId}`).slice(0, 32)
const isoTime = value => { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toISOString() }
async function all(collection, filter) { const output = []; for (let skip = 0; ; skip += 100) { const result = await collection.where(filter).skip(skip).limit(100).get(), page = result.data || []; output.push(...page); if (page.length < 100) return output } }
async function newest(openId, ownerCoachId) {
  const oldResult = await legacyBackups.where({ _id: legacyIdFor(openId), ownerOpenId: openId }).limit(1).get(), legacy = oldResult.data && oldResult.data[0]
  const complete = await all(manifests, { ownerCoachId, status: 'completed' }), manifest = complete.sort((a, b) => Number(b.backupVersion) - Number(a.backupVersion))[0]
  if (!manifest) return legacy ? { kind: 'legacy', record: legacy } : null
  if (!legacy || Number(manifest.backupVersion) >= Number(legacy.backupVersion || 0)) return { kind: 'chunked', record: manifest }
  return { kind: 'legacy', record: legacy }
}
exports.main = async event => {
  const openId = cloud.getWXContext().OPENID
  if (!openId) return { ok: false, code: 'NO_IDENTITY', message: '未能确认当前微信身份。' }
  const ownerCoachId = coachIdFor(openId), action = event && event.action || 'metadata'
  try {
    const current = await newest(openId, ownerCoachId)
    if (!current) return { ok: false, code: 'NOT_FOUND', message: '没有找到当前微信的云端备份。' }
    if (current.kind === 'legacy') {
      const record = current.record
      if (record.ownerOpenId !== openId) return { ok: false, code: 'OWNER_MISMATCH', message: '云端备份身份校验失败。' }
      return { ok: true, ownerVerified: true, backupFormatVersion: 1, backupVersion: record.backupVersion, schemaVersion: record.schemaVersion, createdAt: isoTime(record.createdAt), updatedAt: isoTime(record.updatedAt), byteSize: record.byteSize, checksum: record.checksum, checksumAlgorithm: record.checksumAlgorithm, summary: record.summary, snapshot: record.snapshot }
    }
    const manifest = current.record
    if (manifest.ownerCoachId !== ownerCoachId || manifest.status !== 'completed') return { ok: false, code: 'OWNER_MISMATCH', message: '云端备份身份或状态异常。' }
    if (action === 'chunk') {
      if (Number(event.backupVersion) !== Number(manifest.backupVersion)) return { ok: false, code: 'VERSION_CHANGED', message: '云端备份版本已变化，请重新验证。' }
      const collection = String(event.collection || ''), chunkIndex = Number(event.chunkIndex)
      const result = await chunks.where({ sessionId: manifest._id, ownerCoachId, collection, chunkIndex }).limit(1).get(), chunk = result.data && result.data[0]
      if (!chunk) return { ok: false, code: 'CHUNK_NOT_FOUND', message: '云端备份分块缺失。' }
      return { ok: true, chunk: { collection: chunk.collection, chunkIndex: chunk.chunkIndex, totalChunks: chunk.totalChunks, chunkChecksum: chunk.checksum, chunkByteSize: chunk.byteSize, records: chunk.records } }
    }
    const chunkDocs = await all(chunks, { sessionId: manifest._id, ownerCoachId })
    if (chunkDocs.length !== Number(manifest.totalChunks)) return { ok: false, code: 'CHUNKS_MISSING', message: '云端备份分块不完整。' }
    return { ok: true, ownerVerified: true, backupFormatVersion: 2, backupVersion: manifest.backupVersion, schemaVersion: manifest.schemaVersion, createdAt: isoTime(manifest.createdAt), updatedAt: isoTime(manifest.updatedAt), byteSize: manifest.byteSize, checksum: manifest.checksum, checksumAlgorithm: 'sha256', summary: manifest.summary, chunks: chunkDocs.map(item => ({ collection: item.collection, chunkIndex: item.chunkIndex })).sort((a, b) => a.collection.localeCompare(b.collection) || a.chunkIndex - b.chunkIndex) }
  } catch (error) {
    console.error('[cloud-verify]', error && (error.code || error.message) || 'UNKNOWN')
    return { ok: false, code: 'READ_FAILED', message: '读取云端备份失败，请稍后重试。' }
  }
}
