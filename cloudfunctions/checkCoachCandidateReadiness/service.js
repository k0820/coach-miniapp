const crypto = require('crypto')

const FORBIDDEN = new Set(['OPENID', 'openId', 'openid', '_openid', 'coachId', 'ownerCoachId', 'datasetId', 'activeDatasetId', 'documentId'])
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const coachIdFor = openId => sha(`coach:${openId}`).slice(0, 32)
const fixedId = (kind, owner, suffix = '') => sha(`${kind}:${owner}:${suffix}`).slice(0, 32)
const fail = (code, message) => ({ ok: false, code, message })

async function one(db, collection, filter) {
  const result = await db.collection(collection).where(filter).limit(1).get()
  return result.data && result.data[0] || null
}

function createService({ db, getOpenId }) {
  return async function main(event = {}) {
    try {
      const openId = getOpenId()
      if (!openId) return fail('IDENTITY_MISSING', '未能确认当前微信身份。')
      const forbidden = Object.keys(event).find(key => key !== 'userInfo' && FORBIDDEN.has(key))
      if (forbidden) return fail('FORBIDDEN_IDENTITY_INPUT', `客户端不得提交身份或数据集定位字段：${forbidden}`)
      if (event.action !== 'check') return fail('INVALID_ACTION', '不支持的只读检查操作。')
      const sourceChecksum = String(event.sourceChecksum || '')
      if (!/^[a-f0-9]{64}$/.test(sourceChecksum)) return fail('INVALID_SOURCE_CHECKSUM', '当前本机 checksum 无效。')

      const ownerCoachId = coachIdFor(openId)
      const coach = await one(db, 'coaches', { _id: ownerCoachId, openId, status: 'active' })
      if (!coach) return fail('COACH_NOT_FOUND', '未找到当前 coach。')
      const candidate = await one(db, 'coach_datasets', { ownerCoachId, sourceChecksum })
      const head = await one(db, 'coach_data_heads', { _id: fixedId('coach-data-head', ownerCoachId), ownerCoachId })
      if (!candidate) return {
        ok: false,
        code: 'SOURCE_CHANGED_BEFORE_ACTIVATION',
        message: '当前本机数据与已验证 Candidate 不一致，请重新生成 Candidate。',
        activeDatasetId: head && head.activeDatasetId || null
      }
      return {
        ok: true,
        candidateStatus: candidate.status,
        integrityStatus: candidate.integrityStatus,
        candidateDatasetId: candidate.datasetId,
        headVersion: head ? Number(head.headVersion || 0) : 0,
        activeDatasetId: head && head.activeDatasetId || null,
        candidateChecksum: candidate.sourceChecksum || candidate.checksum,
        candidateByteSize: candidate.sourceByteSize == null ? candidate.byteSize : candidate.sourceByteSize,
        candidateSummary: candidate.sourceSummary || candidate.summary,
        candidateIsActive: !!(head && head.activeDatasetId === candidate.datasetId)
      }
    } catch (error) {
      return fail(error.code || 'READINESS_CHECK_FAILED', error.message || '切换前只读检查失败。')
    }
  }
}

module.exports = { createService, coachIdFor, fixedId }
