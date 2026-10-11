const CLOUD_BACKUP_META_KEY = 'coachDBCloudBackupMeta'

const positiveInteger = value => Number.isInteger(Number(value)) && Number(value) > 0

function readKnownVersion(value) {
  if (value == null || value === '') return { exists: false, valid: true, backupVersion: 0 }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !positiveInteger(value.backupVersion)) {
    return { exists: true, valid: false, backupVersion: 0 }
  }
  return { exists: true, valid: true, backupVersion: Number(value.backupVersion) }
}

function decideCloudBackup({ cloudExists, cloudVersion, cloudChecksum, localChecksum, localMetadata }) {
  if (!cloudExists) return { allow: true, expectedBackupVersion: 0, reason: 'NO_CLOUD_BACKUP' }
  if (!positiveInteger(cloudVersion)) return { allow: false, reason: 'INVALID_CLOUD_VERSION' }
  const known = readKnownVersion(localMetadata)
  if (!known.valid) return { allow: false, reason: 'INVALID_LOCAL_METADATA' }
  if (!known.exists) {
    if (cloudChecksum && localChecksum && cloudChecksum === localChecksum) {
      return { allow: true, expectedBackupVersion: Number(cloudVersion), reason: 'SAFE_INITIALIZATION' }
    }
    return { allow: false, reason: 'NO_LOCAL_BASELINE' }
  }
  if (Number(cloudVersion) > known.backupVersion) return { allow: false, reason: 'REMOTE_NEWER' }
  if (Number(cloudVersion) < known.backupVersion) return { allow: false, reason: 'VERSION_REGRESSION' }
  return { allow: true, expectedBackupVersion: Number(cloudVersion), reason: 'VERSION_MATCH' }
}

function metadataFromResult(result, recordedAt = new Date().toISOString()) {
  if (!result || !positiveInteger(result.backupVersion) || typeof result.checksum !== 'string' || !result.checksum) return null
  return {
    backupVersion: Number(result.backupVersion),
    schemaVersion: result.schemaVersion,
    checksum: result.checksum,
    byteSize: Number(result.byteSize),
    updatedAt: result.updatedAt || '',
    recordedAt
  }
}

function writeKnownVersion(storage, result, recordedAt) {
  const metadata = metadataFromResult(result, recordedAt)
  if (!metadata) return { ok: false, message: '云端版本信息不完整。' }
  try {
    storage.set(CLOUD_BACKUP_META_KEY, metadata)
    const saved = storage.get(CLOUD_BACKUP_META_KEY)
    const known = readKnownVersion(saved)
    const ok = known.valid && known.backupVersion === metadata.backupVersion && saved.checksum === metadata.checksum && Number(saved.byteSize) === metadata.byteSize
    return ok ? { ok: true, metadata } : { ok: false, message: '本机云端版本记录回读校验失败。' }
  } catch (error) {
    return { ok: false, message: '无法保存本机云端版本记录。' }
  }
}

module.exports = {
  CLOUD_BACKUP_META_KEY,
  readKnownVersion,
  decideCloudBackup,
  metadataFromResult,
  writeKnownVersion
}
