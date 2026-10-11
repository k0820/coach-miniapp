const assert = require('assert')
const { createCutoverOrchestrator } = require('../utils/cutover-orchestrator')
const { fingerprintSnapshot } = require('../utils/activation-readiness')
const { MODES } = require('../utils/data-runtime')

const clone = value => JSON.parse(JSON.stringify(value))
const fixture = () => ({ students: [], bookings: [], incomes: [], sales: [], settings: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 10, salesCommissionRate: 2 }, customExercises: [] })

function harness(options = {}) {
  const source = fixture(), fingerprint = fingerprintSnapshot(source), memory = new Map(), states = []
  let reads = 0, activated = 0, receipt = options.receipt || null
  const storage = { get: key => memory.get(key), set: (key, value) => { if (options.failRecovery && key === 'coachDBCloudCutoverRecovery') throw new Error('storage full'); memory.set(key, clone(value)); if (options.corruptRecovery && key === 'coachDBCloudCutoverRecovery') memory.get(key).checksum = 'bad' } }
  const runtime = {
    MODES,
    cutoverState: () => clone(states[states.length - 1] || { status: MODES.LOCAL }),
    setCutoverState: (status, details) => { const value = { ...clone(details), status }; states.push(value); return value },
    activateCloudMode: cache => { if (options.failMode) throw new Error('mode failed'); states.push({ status: MODES.CLOUD, datasetId: cache.datasetId, revision: cache.revision, checksum: cache.checksum }) },
    mode: () => (states[states.length - 1] || {}).status === MODES.CLOUD ? MODES.CLOUD : MODES.LOCAL
  }
  const readiness = () => ({ ok: true, candidateStatus: 'verified', integrityStatus: 'verified', candidateDatasetId: 'dataset-final', headVersion: 0, activeDatasetId: null, candidateChecksum: fingerprint.checksum, candidateByteSize: fingerprint.byteSize, candidateSummary: clone(fingerprint.summary), candidateIsActive: false })
  const callCloud = async (name, data) => {
    if (name === 'checkCoachCandidateReadiness') return readiness()
    if (name === 'activateCoachDataset' && data.action === 'getReceipt') return receipt || { ok: true, found: false }
    if (name === 'activateCoachDataset') { activated += 1; if (options.activationFailure) return { ok: false, code: 'ACTIVATION_FAILED' }; if (options.activationTimeout) throw new Error('timeout'); return { ok: true, activeDatasetId: 'dataset-final', dataRevision: 0, headVersionBefore: 0, headVersionAfter: 1, sourceChecksum: fingerprint.checksum } }
    throw new Error(`unexpected ${name}`)
  }
  const adapter = {
    RECOVERY_KEY: 'coachDBCloudCutoverRecovery', CACHE_KEY: 'coachCloudActiveCache',
    saveRecovery(snapshot, meta) { storage.set(this.RECOVERY_KEY, { ...clone(meta), snapshot: clone(snapshot) }) },
    async readActive() {
      if (options.failRead) return { ok: false, code: 'NETWORK' }
      const cache = { datasetId: 'dataset-final', revision: 0, checksum: fingerprint.checksum, byteSize: fingerprint.byteSize, summary: clone(fingerprint.summary), snapshot: clone(source) }
      if (options.failCache) cache.checksum = 'bad'
      storage.set(this.CACHE_KEY, cache); return { ok: true, ...clone(cache) }
    }
  }
  const readSource = () => { reads += 1; if (options.sourceChanges && reads >= 2) { const changed = fixture(); changed.marker = true; return changed } return clone(source) }
  const orchestrator = createCutoverOrchestrator({ readSource, callCloud, storage, adapter, runtime, makeRequestId: () => 'activation_fixed_001' })
  return { orchestrator, runtime, storage, states, controls: options, get activated() { return activated }, fingerprint }
}

async function main() {
  let h = harness({ sourceChanges: true }), result = await h.orchestrator.activate()
  assert.equal(result.code, 'SOURCE_CHANGED_BEFORE_ACTIVATION'); assert.equal(h.activated, 0)

  h = harness({ failRecovery: true }); result = await h.orchestrator.activate()
  assert.equal(result.code, 'RECOVERY_WRITE_FAILED'); assert.equal(h.activated, 0)

  h = harness({ corruptRecovery: true }); result = await h.orchestrator.activate()
  assert.equal(result.code, 'RECOVERY_READBACK_FAILED'); assert.equal(h.activated, 0)

  h = harness({ activationFailure: true }); result = await h.orchestrator.activate()
  assert.equal(result.code, 'ACTIVATION_FAILED'); assert.equal(h.runtime.cutoverState().status, MODES.LOCAL)

  const receiptResult = { ok: true, activeDatasetId: 'dataset-final', dataRevision: 0, headVersionAfter: 1 }
  h = harness({ activationTimeout: true, receipt: { ok: true, found: true, status: 'succeeded', result: receiptResult } }); result = await h.orchestrator.activate()
  assert.equal(result.code, 'CUTOVER_COMPLETE'); assert.equal(h.runtime.cutoverState().status, MODES.CLOUD); assert.equal(h.activated, 1)

  for (const flag of ['failRead', 'failCache', 'failMode']) {
    h = harness({ [flag]: true }); result = await h.orchestrator.activate()
    assert.equal(result.ok, false, flag); assert.equal(result.frozen, true, flag); assert.equal(h.runtime.cutoverState().status, MODES.PENDING, flag)
  }

  h = harness({ failRead: true }); result = await h.orchestrator.activate()
  assert.equal(h.runtime.cutoverState().status, MODES.PENDING); h.controls.failRead = false
  result = await h.orchestrator.finishPending(); assert.equal(result.code, 'CUTOVER_COMPLETE'); assert.equal(h.runtime.cutoverState().status, MODES.CLOUD)

  h = harness(); result = await h.orchestrator.activate()
  assert.equal(result.code, 'CUTOVER_COMPLETE'); assert.equal(h.runtime.cutoverState().status, MODES.CLOUD)
  assert.equal(h.storage.get('coachDB'), undefined)
  console.log('real cutover orchestrator tests: PASS')
}

main().catch(error => { console.error(error); process.exit(1) })
