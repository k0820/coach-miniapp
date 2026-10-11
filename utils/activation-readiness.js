const { normalizeSnapshot, integrity } = require('./candidate-dataset')
const { sameSummary } = require('./summary-compare')

const clone = value => JSON.parse(JSON.stringify(value))

function fingerprintSnapshot(snapshot) {
  const normalized = normalizeSnapshot(clone(snapshot))
  const result = integrity(normalized)
  return { checksum: result.checksum, byteSize: result.byteSize, summary: clone(result.summary) }
}

function prepareActivation({ snapshot, candidate, requestId, expectedHeadVersion }) {
  if (!candidate || candidate.status !== 'verified' || candidate.integrityStatus !== 'verified') return { ok: false, code: 'DATASET_NOT_VERIFIED' }
  const current = fingerprintSnapshot(snapshot)
  const expected = { checksum: candidate.sourceChecksum || candidate.checksum, byteSize: candidate.sourceByteSize == null ? candidate.byteSize : candidate.sourceByteSize, summary: candidate.sourceSummary || candidate.summary }
  if (current.checksum !== expected.checksum || current.byteSize !== expected.byteSize || !sameSummary(current.summary, expected.summary)) {
    return { ok: false, code: 'SOURCE_CHANGED_BEFORE_ACTIVATION', expected, actual: current }
  }
  return { ok: true, requestId, expectedHeadVersion, sourceChecksum: current.checksum, sourceByteSize: current.byteSize, sourceSummary: current.summary }
}

module.exports = { fingerprintSnapshot, prepareActivation }
