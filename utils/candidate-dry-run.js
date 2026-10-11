const { normalizeSnapshot, integrity, buildCandidateDataset } = require('./candidate-dataset')
const { buildCandidateUploadPlan } = require('./candidate-staging')
const { sameSummary } = require('./summary-compare')

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function invalid(message) { return { ok: false, code: 'LOCAL_SOURCE_INVALID', message } }

async function runCandidateDryRun({ readSource, callCloud, onProgress = () => {} }) {
  const rawBefore = readSource()
  if (!rawBefore || typeof rawBefore !== 'object' || Array.isArray(rawBefore)) return invalid('本机 coachDB 不是有效对象。')
  const sourceBefore = clone(rawBefore), normalizedBefore = normalizeSnapshot(sourceBefore), fingerprintBefore = integrity(normalizedBefore)
  onProgress({ stage: 'prepare', fingerprint: fingerprintBefore })
  const prepared = await callCloud({ action: 'prepare', sourceChecksum: fingerprintBefore.checksum })
  if (!prepared || !prepared.ok) return prepared
  const candidate = buildCandidateDataset(sourceBefore, { trustedOwnerCoachId: prepared.ownerCoachId, trustedDatasetId: prepared.datasetId }), plan = buildCandidateUploadPlan(candidate)
  const begin = await callCloud({ action: 'begin', sourceChecksum: fingerprintBefore.checksum, sourceByteSize: fingerprintBefore.byteSize, sourceSummary: fingerprintBefore.summary, counts: fingerprintBefore.counts, schemaVersion: candidate.schemaVersion, totalChunks: plan.totalChunks, collections: plan.collections })
  if (!begin || !begin.ok) return begin
  if (begin.status !== 'verified') {
    for (let index = 0; index < plan.chunks.length; index++) {
      const uploaded = await callCloud({ ...plan.chunks[index], sourceChecksum: fingerprintBefore.checksum })
      if (!uploaded || !uploaded.ok) return uploaded
      onProgress({ stage: 'upload', completed: index + 1, total: plan.chunks.length, reused: !!uploaded.reused })
    }
    for (let step = 0; step < 10000; step++) {
      const materialized = await callCloud({ action: 'materializeNext', sourceChecksum: fingerprintBefore.checksum })
      if (!materialized || !materialized.ok) return materialized
      onProgress({ stage: 'materialize', ...materialized })
      if (!materialized.continue) break
      if (step === 9999) return { ok: false, code: 'MATERIALIZE_DID_NOT_FINISH', message: 'candidate materialize 未在安全步数内完成。' }
    }
  }
  const rawAfter = readSource()
  if (!rawAfter || typeof rawAfter !== 'object' || Array.isArray(rawAfter)) return invalid('云端验证前本机 coachDB 已不可读。')
  const fingerprintAfter = integrity(normalizeSnapshot(clone(rawAfter)))
  if (fingerprintAfter.checksum !== fingerprintBefore.checksum || fingerprintAfter.byteSize !== fingerprintBefore.byteSize || !sameSummary(fingerprintAfter.summary, fingerprintBefore.summary)) {
    return { ok: false, code: 'SOURCE_CHANGED_DURING_MIGRATION', message: '上传期间本机数据已变化，该 candidate 不能作为激活候选。', datasetId: prepared.datasetId }
  }
  const verified = await callCloud({ action: 'verify', sourceChecksum: fingerprintBefore.checksum, currentSourceChecksum: fingerprintAfter.checksum, currentSourceByteSize: fingerprintAfter.byteSize, currentSourceSummary: fingerprintAfter.summary })
  return verified && verified.ok ? { ...verified, sourceStable: true, sourceChecksum: fingerprintBefore.checksum, sourceByteSize: fingerprintBefore.byteSize, sourceSummary: fingerprintBefore.summary } : verified
}

module.exports = { runCandidateDryRun }
