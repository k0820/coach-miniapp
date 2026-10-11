const assert = require('assert')
const {
  CLOUD_BACKUP_META_KEY,
  decideCloudBackup,
  writeKnownVersion
} = require('../utils/cloud-backup-version')

function storage(initial = {}, fail = false) {
  const values = JSON.parse(JSON.stringify(initial)), writes = []
  return {
    writes,
    get: key => values[key],
    set(key, value) { if (fail) throw new Error('storage full'); writes.push(key); values[key] = JSON.parse(JSON.stringify(value)) }
  }
}

const cloud = (version, checksum = `hash-${version}`) => ({ cloudExists: true, cloudVersion: version, cloudChecksum: checksum, localChecksum: checksum })

assert.deepStrictEqual(decideCloudBackup({ cloudExists: false }), { allow: true, expectedBackupVersion: 0, reason: 'NO_CLOUD_BACKUP' })
assert.strictEqual(decideCloudBackup({ ...cloud(2), localMetadata: { backupVersion: 2 } }).allow, true)
assert.strictEqual(decideCloudBackup({ ...cloud(2), localMetadata: { backupVersion: 1 } }).reason, 'REMOTE_NEWER')
assert.strictEqual(decideCloudBackup({ ...cloud(2), localMetadata: null }).reason, 'SAFE_INITIALIZATION')
assert.strictEqual(decideCloudBackup({ ...cloud(2), localChecksum: 'different', localMetadata: null }).reason, 'NO_LOCAL_BASELINE')
assert.strictEqual(decideCloudBackup({ ...cloud(2), localMetadata: { backupVersion: 3 } }).reason, 'VERSION_REGRESSION')
assert.strictEqual(decideCloudBackup({ ...cloud(2), localMetadata: { backupVersion: 'bad' } }).reason, 'INVALID_LOCAL_METADATA')

let local = storage()
let result = writeKnownVersion(local, { backupVersion: 3, schemaVersion: 1, checksum: 'hash-3', byteSize: 100, updatedAt: 'time' }, 'recorded')
assert.strictEqual(result.ok, true)
assert.strictEqual(local.get(CLOUD_BACKUP_META_KEY).backupVersion, 3)
assert.deepStrictEqual(local.writes, [CLOUD_BACKUP_META_KEY])

local = storage({}, true)
result = writeKnownVersion(local, { backupVersion: 3, checksum: 'hash-3', byteSize: 100 })
assert.strictEqual(result.ok, false)
assert.deepStrictEqual(local.writes, [])

const backupSource = require('fs').readFileSync(require('path').join(__dirname, '../cloudfunctions/backupCoachDB/index.js'), 'utf8')
assert.ok(backupSource.includes('cloud.getWXContext()'))
assert.ok(backupSource.includes('expectedBackupVersion'))
assert.ok(backupSource.includes("code: 'VERSION_CONFLICT'"))
assert.ok(!/event\.(OPENID|openId|coachId|documentId)/.test(backupSource))

console.log('cloud-backup-version tests: PASS (12 checks)')
