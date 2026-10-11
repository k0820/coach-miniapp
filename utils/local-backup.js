const { sha256, utf8ByteLength } = require('./sha256')

const BACKUP_FORMAT_VERSION = 1
const SAFETY_BACKUP_KEY = 'coachDBRestoreSafetyBackup'
const plainObject = value => !!(value && typeof value === 'object' && !Array.isArray(value))
const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0
const validOptionalId = value => value == null || value === '' || nonEmptyString(value)
const finiteNumber = value => Number.isFinite(Number(value))

function validateSnapshot(snapshot) {
  if (!plainObject(snapshot)) return { ok: false, message: '备份顶层不是有效对象。' }
  for (const key of ['students', 'bookings', 'incomes', 'sales', 'customExercises']) {
    if (!Array.isArray(snapshot[key])) return { ok: false, message: `备份缺少有效的 ${key} 数组。` }
  }
  if (!plainObject(snapshot.settings)) return { ok: false, message: '备份缺少有效的 settings 设置对象。' }

  for (let i = 0; i < snapshot.students.length; i++) {
    const student = snapshot.students[i]
    if (!plainObject(student) || !nonEmptyString(student.id) || typeof student.name !== 'string' || !Array.isArray(student.packages)) {
      return { ok: false, message: `students[${i}] 的学员结构不完整。` }
    }
    for (let j = 0; j < student.packages.length; j++) {
      const pkg = student.packages[j]
      if (!plainObject(pkg) || !nonEmptyString(pkg.id) || !nonEmptyString(pkg.type)) return { ok: false, message: `students[${i}].packages[${j}] 的课时包结构不完整。` }
      if (!validOptionalId(pkg.saleId)) return { ok: false, message: `students[${i}].packages[${j}] 的 saleId 类型无效。` }
      for (const field of ['total', 'used', 'remaining', 'price']) {
        if (pkg[field] != null && !finiteNumber(pkg[field])) return { ok: false, message: `students[${i}].packages[${j}].${field} 不是有效数字。` }
      }
    }
  }

  for (let i = 0; i < snapshot.bookings.length; i++) {
    const booking = snapshot.bookings[i]
    if (!plainObject(booking) || !nonEmptyString(booking.id) || !nonEmptyString(booking.studentId) || !nonEmptyString(booking.status)) return { ok: false, message: `bookings[${i}] 的预约结构不完整。` }
    if (!validOptionalId(booking.packageId)) return { ok: false, message: `bookings[${i}] 的 packageId 类型无效。` }
    if (booking.items != null && !Array.isArray(booking.items)) return { ok: false, message: `bookings[${i}].items 不是有效数组。` }
  }

  for (let i = 0; i < snapshot.incomes.length; i++) {
    const income = snapshot.incomes[i]
    if (!plainObject(income) || !nonEmptyString(income.id) || !validOptionalId(income.bookingId) || !validOptionalId(income.studentId) || !finiteNumber(income.amount)) return { ok: false, message: `incomes[${i}] 的收入结构不完整。` }
  }

  for (let i = 0; i < snapshot.sales.length; i++) {
    const sale = snapshot.sales[i]
    if (!plainObject(sale) || !nonEmptyString(sale.id) || !nonEmptyString(sale.source) || !nonEmptyString(sale.date) || !finiteNumber(sale.amount)) return { ok: false, message: `sales[${i}] 的销售结构不完整。` }
    if (!validOptionalId(sale.studentId) || !validOptionalId(sale.packageId)) return { ok: false, message: `sales[${i}] 的关联 ID 类型无效。` }
  }

  for (let i = 0; i < snapshot.customExercises.length; i++) {
    const exercise = snapshot.customExercises[i]
    if (!plainObject(exercise) || !nonEmptyString(exercise.name) || !nonEmptyString(exercise.group)) return { ok: false, message: `customExercises[${i}] 的动作结构不完整。` }
  }

  for (const field of ['renewThreshold', 'monthlyGoalSessions', 'classCommissionRate', 'salesCommissionRate']) {
    if (snapshot.settings[field] != null && !finiteNumber(snapshot.settings[field])) return { ok: false, message: `settings.${field} 不是有效数字。` }
  }
  return { ok: true }
}

function snapshotMetadata(snapshot) {
  const validation = validateSnapshot(snapshot)
  if (!validation.ok) return validation
  let json
  try { json = JSON.stringify(snapshot) } catch (error) { return { ok: false, message: '备份内容无法序列化。' } }
  if (!json || json === '{}') return { ok: false, message: '备份内容为空或不完整。' }
  return { ok: true, json, checksum: sha256(json), byteSize: utf8ByteLength(json) }
}

function createBackupEnvelope(snapshot, createdAt = new Date().toISOString()) {
  const metadata = snapshotMetadata(snapshot)
  if (!metadata.ok) return metadata
  return {
    ok: true,
    envelope: {
      backupFormatVersion: BACKUP_FORMAT_VERSION,
      createdAt,
      checksumAlgorithm: 'sha256',
      checksum: metadata.checksum,
      byteSize: metadata.byteSize,
      snapshot
    }
  }
}

function inspectBackupText(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch (error) { return { ok: false, code: 'INVALID_JSON', message: '剪贴板内容不是有效 JSON。' } }
  const isEnvelope = plainObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'snapshot')
  if (!isEnvelope) {
    const metadata = snapshotMetadata(parsed)
    if (!metadata.ok) return { ...metadata, code: 'INVALID_SNAPSHOT' }
    return { ok: true, legacy: true, verified: false, snapshot: parsed, checksum: metadata.checksum, byteSize: metadata.byteSize }
  }
  if (parsed.backupFormatVersion !== BACKUP_FORMAT_VERSION || parsed.checksumAlgorithm !== 'sha256' || !nonEmptyString(parsed.createdAt) || !/^[a-f0-9]{64}$/i.test(String(parsed.checksum || '')) || !Number.isInteger(Number(parsed.byteSize)) || Number(parsed.byteSize) < 0) {
    return { ok: false, code: 'INVALID_ENVELOPE', message: '备份外层信息无效或版本不受支持。' }
  }
  const metadata = snapshotMetadata(parsed.snapshot)
  if (!metadata.ok) return { ...metadata, code: 'INVALID_SNAPSHOT' }
  if (metadata.checksum !== parsed.checksum) return { ok: false, code: 'CHECKSUM_MISMATCH', message: '备份 checksum 校验失败，内容可能已损坏。' }
  if (metadata.byteSize !== Number(parsed.byteSize)) return { ok: false, code: 'BYTE_SIZE_MISMATCH', message: '备份 byteSize 校验失败，内容可能不完整。' }
  return { ok: true, legacy: false, verified: true, snapshot: parsed.snapshot, checksum: metadata.checksum, byteSize: metadata.byteSize, createdAt: parsed.createdAt }
}

function createSafetyBackup(snapshot, createdAt = new Date().toISOString()) {
  const metadata = snapshotMetadata(snapshot)
  if (!metadata.ok) return metadata
  return { ok: true, safety: { createdAt, checksum: metadata.checksum, byteSize: metadata.byteSize, snapshot } }
}

function verifySafetyBackup(safety) {
  if (!plainObject(safety) || !nonEmptyString(safety.createdAt)) return { ok: false, message: '恢复前安全备份结构无效。' }
  const metadata = snapshotMetadata(safety.snapshot)
  if (!metadata.ok) return metadata
  if (metadata.checksum !== safety.checksum || metadata.byteSize !== Number(safety.byteSize)) return { ok: false, message: '恢复前安全备份回读校验失败。' }
  return { ok: true, checksum: metadata.checksum, byteSize: metadata.byteSize }
}

async function restoreClipboardBackup(options) {
  const { text, storage, confirm, now = () => new Date().toISOString() } = options
  const candidate = inspectBackupText(text)
  if (!candidate.ok) return candidate
  let firstConfirmed
  try { firstConfirmed = await confirm({ stage: 'first', legacy: candidate.legacy }) } catch (error) { return { ok: false, code: 'CONFIRM_FAILED', message: '无法打开恢复确认框。' } }
  if (!firstConfirmed) return { ok: false, code: 'CANCELLED_FIRST', cancelled: true }

  let safety
  try {
    const current = storage.get('coachDB')
    const created = createSafetyBackup(current, now())
    if (!created.ok) return { ...created, code: 'SAFETY_INVALID' }
    safety = created.safety
    storage.set(SAFETY_BACKUP_KEY, safety)
    const verified = verifySafetyBackup(storage.get(SAFETY_BACKUP_KEY))
    if (!verified.ok) throw new Error(verified.message)
  } catch (error) {
    return { ok: false, code: 'SAFETY_BACKUP_FAILED', message: '无法安全保存当前本机数据，恢复已终止。' }
  }

  let secondConfirmed
  try { secondConfirmed = await confirm({ stage: 'second', legacy: candidate.legacy }) } catch (error) { return { ok: false, code: 'CONFIRM_FAILED', message: '无法打开最终确认框。' } }
  if (!secondConfirmed) return { ok: false, code: 'CANCELLED_SECOND', cancelled: true, safetyCreated: true }

  try {
    storage.set('coachDB', candidate.snapshot)
    const restored = snapshotMetadata(storage.get('coachDB'))
    if (!restored.ok || restored.checksum !== candidate.checksum || restored.byteSize !== candidate.byteSize) throw new Error('恢复后完整性校验失败')
    return { ok: true, legacy: candidate.legacy, verified: candidate.verified, checksum: candidate.checksum, byteSize: candidate.byteSize }
  } catch (error) {
    try {
      storage.set('coachDB', safety.snapshot)
      const rolledBack = verifySafetyBackup({ ...safety, snapshot: storage.get('coachDB') })
      if (!rolledBack.ok) throw new Error(rolledBack.message)
      return { ok: false, code: 'RESTORE_FAILED_ROLLED_BACK', rolledBack: true, message: '恢复校验失败，已自动恢复操作前的数据。' }
    } catch (rollbackError) {
      return { ok: false, code: 'ROLLBACK_FAILED', rolledBack: false, message: '恢复和自动回滚均未通过校验，请保留恢复前安全备份。' }
    }
  }
}

module.exports = {
  BACKUP_FORMAT_VERSION,
  SAFETY_BACKUP_KEY,
  validateSnapshot,
  snapshotMetadata,
  createBackupEnvelope,
  inspectBackupText,
  createSafetyBackup,
  verifySafetyBackup,
  restoreClipboardBackup
}
