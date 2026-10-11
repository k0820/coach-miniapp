const crypto = require('crypto')

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')

// This is the one authoritative ID contract for coach Sandbox infrastructure.
// The empty suffix is intentional and preserves the deployed trailing-colon rule.
const fixedId = (kind, ownerCoachId, suffix = '') => sha(`${kind}:${ownerCoachId}:${suffix}`).slice(0, 32)
const sandboxHeadId = ownerCoachId => fixedId('coach-sandbox-head', ownerCoachId)
const sandboxDatasetId = ownerCoachId => `sandbox_${fixedId('coach-sandbox-dataset', ownerCoachId).slice(0, 20)}`
const sandboxDatasetDocumentId = (ownerCoachId, datasetId) => fixedId('coach-dataset', ownerCoachId, datasetId)
const sandboxRevisionId = (ownerCoachId, datasetId) => fixedId('coach-sandbox-revision', ownerCoachId, datasetId)

async function isCompleteSandbox({ scope, one, ownerCoachId, datasetId }) {
  if (!ownerCoachId || !datasetId) return false
  const dataset = await one(scope, 'coach_datasets', { _id: sandboxDatasetDocumentId(ownerCoachId, datasetId), ownerCoachId, datasetId, environment: 'sandbox', status: 'active', integrityStatus: 'verified' })
  const revision = await one(scope, 'coach_sandbox_revisions', { _id: sandboxRevisionId(ownerCoachId, datasetId), ownerCoachId, datasetId, environment: 'sandbox' })
  const student = await one(scope, 'students', { ownerCoachId, datasetId })
  return !!(dataset && revision && Number.isInteger(revision.dataRevision) && revision.dataRevision >= 0 && student)
}

module.exports = { sha, fixedId, sandboxHeadId, sandboxDatasetId, sandboxDatasetDocumentId, sandboxRevisionId, isCompleteSandbox }
