const COMMANDS = Object.freeze([
  'createStudent', 'updateStudent', 'deleteStudent',
  'createPackage', 'createCourseSale', 'updateCourseSale', 'reverseCourseSale',
  'updatePackage', 'deletePackage',
  'createBooking', 'setPackageShare', 'createSharedBooking', 'createAuthorizedBooking', 'updateBookingContent', 'rescheduleBooking', 'cancelBooking', 'completeBooking', 'deleteCompletedBooking', 'markBookingNotHeld',
  // M2 V1 正式多教练服务模型：双层授权（会员级 + 课包级）与权限交接。
  'grantMemberService', 'revokeMemberService', 'grantPackageTeaching', 'revokePackageTeaching', 'transferPackageManagement',
  'createManualSale', 'updateManualSale', 'deleteManualSale', 'saveSettings',
  'createCustomExercise', 'updateCustomExercise', 'deleteCustomExercise'
])

// ⭐ M2 V1：新增 `memberId` —— 会员身份只从认领关系推导，客户端不许提交。
const FORBIDDEN_IDENTITY_KEYS = new Set([
  'openid', 'openId', 'OPENID', 'coachId', 'ownerCoachId', 'documentId', 'datasetId', '_openid', 'memberId'
])

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function findForbiddenIdentity(value, path = 'envelope') {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenIdentity(value[index], `${path}[${index}]`)
      if (found) return found
    }
    return null
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_IDENTITY_KEYS.has(key)) return `${path}.${key}`
    const found = findForbiddenIdentity(value[key], `${path}.${key}`)
    if (found) return found
  }
  return null
}

function validateCommandEnvelope(envelope) {
  if (!isPlainObject(envelope)) return failure('INVALID_COMMAND', '命令必须是对象。')
  const forbidden = findForbiddenIdentity(envelope)
  if (forbidden) return failure('FORBIDDEN_IDENTITY_INPUT', `客户端不得提交身份或云文档定位字段：${forbidden}`)
  if (!COMMANDS.includes(envelope.command)) return failure('UNKNOWN_COMMAND', '不支持的业务命令。')
  if (typeof envelope.requestId !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(envelope.requestId)) {
    return failure('INVALID_REQUEST_ID', 'requestId 必须是 8–128 位稳定字符串。')
  }
  if (!Number.isInteger(envelope.expectedRevision) || envelope.expectedRevision < 0) {
    return failure('INVALID_REVISION', 'expectedRevision 必须是非负整数。')
  }
  if (!isPlainObject(envelope.payload)) return failure('INVALID_PAYLOAD', 'payload 必须是对象。')
  return { ok: true }
}

function failure(code, message, extra = {}) {
  return { ok: false, code, message, ...extra }
}

module.exports = { COMMANDS, FORBIDDEN_IDENTITY_KEYS, isPlainObject, findForbiddenIdentity, validateCommandEnvelope, failure }
