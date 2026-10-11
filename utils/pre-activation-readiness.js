const { fingerprintSnapshot } = require('./activation-readiness')
const { sameSummary, summaryDiff } = require('./summary-compare')

async function runPreActivationReadiness({ readSource, callCloud }) {
  const before = readSource()
  const current = fingerprintSnapshot(before)
  const remote = await callCloud('checkCoachCandidateReadiness', { action: 'check', sourceChecksum: current.checksum })
  if (!remote || !remote.ok) return {
    ok: false,
    code: remote && remote.code || 'READINESS_CHECK_FAILED',
    message: remote && remote.message || '无法读取 Candidate 状态。',
    sourceMatch: false,
    currentChecksum: current.checksum,
    activeDatasetId: remote && remote.activeDatasetId || null,
    readyForActivation: false
  }
  const checksumMatch = current.checksum === remote.candidateChecksum
  const byteSizeMatch = current.byteSize === remote.candidateByteSize
  const summaryMatch = sameSummary(current.summary, remote.candidateSummary)
  const differences = summaryDiff(current.summary, remote.candidateSummary)
  const candidateVerified = remote.candidateStatus === 'verified' && remote.integrityStatus === 'verified'
  const inactive = !remote.candidateIsActive
  const sourceMatch = checksumMatch && byteSizeMatch && summaryMatch
  const readyForActivation = sourceMatch && candidateVerified && inactive
  return {
    ok: readyForActivation,
    code: sourceMatch ? (readyForActivation ? 'READY_FOR_ACTIVATION' : 'CANDIDATE_NOT_READY') : 'SOURCE_CHANGED_BEFORE_ACTIVATION',
    message: sourceMatch ? (readyForActivation ? '切换前检查通过。' : 'Candidate 状态不满足激活条件。') : '当前本机数据已变化，请重新生成 Candidate。',
    sourceMatch,
    candidateStatus: remote.candidateStatus,
    integrityStatus: remote.integrityStatus,
    candidateDatasetId: remote.candidateDatasetId,
    headVersion: remote.headVersion,
    activeDatasetId: remote.activeDatasetId,
    currentChecksum: current.checksum,
    candidateChecksum: remote.candidateChecksum,
    currentByteSize: current.byteSize,
    candidateByteSize: remote.candidateByteSize,
    currentSummary: current.summary,
    candidateSummary: remote.candidateSummary,
    summaryDiff: differences,
    byteSizeMatch,
    summaryMatch,
    readyForActivation
  }
}

module.exports = { runPreActivationReadiness }
