const { runPreActivationReadiness } = require('./pre-activation-readiness')
const { fingerprintSnapshot } = require('./activation-readiness')
const { sameSummary } = require('./summary-compare')

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const requestId = () => `activate_${Date.now()}_${Math.random().toString(36).slice(2)}`

function createCutoverOrchestrator({ readSource, callCloud, storage, adapter, runtime, makeRequestId = requestId }) {
  let lastCheck = null
  const call = (name, data) => callCloud(name, data)

  async function check() {
    const result = await runPreActivationReadiness({ readSource, callCloud: call })
    lastCheck = result.readyForActivation ? clone(result) : null
    return result
  }

  function verifyRecovery(expected) {
    const saved = storage.get(adapter.RECOVERY_KEY)
    if (!saved || !saved.snapshot || saved.datasetId !== expected.datasetId || saved.checksum !== expected.checksum || saved.byteSize !== expected.byteSize || !sameSummary(saved.summary, expected.summary)) return false
    const actual = fingerprintSnapshot(saved.snapshot)
    return actual.checksum === expected.checksum && actual.byteSize === expected.byteSize && sameSummary(actual.summary, expected.summary)
  }

  async function resolveActivation(id) {
    let receipt
    try { receipt = await call('activateCoachDataset', { action: 'getReceipt', requestId: id }) }
    catch (error) { return { ok: false, code: 'ACTIVATION_RESULT_UNKNOWN', requestId: id, frozen: true } }
    if (receipt && receipt.ok && receipt.found && receipt.status === 'succeeded' && receipt.result && receipt.result.ok) return receipt.result
    if (receipt && receipt.ok && receipt.found && receipt.status === 'failed') return receipt.result || { ok: false, code: 'ACTIVATION_FAILED' }
    return { ok: false, code: receipt && receipt.status === 'processing' ? 'ACTIVATION_PROCESSING' : 'ACTIVATION_RESULT_UNKNOWN', requestId: id, frozen: true }
  }

  async function finishPending() {
    const state = runtime.cutoverState()
    if (![runtime.MODES.ACTIVATING, runtime.MODES.PENDING].includes(state.status)) return { ok: false, code: 'CUTOVER_NOT_PENDING' }
    let activation = state.activationResult
    if (!activation) {
      activation = await resolveActivation(state.requestId)
      if (!activation.ok) return activation
      runtime.setCutoverState(runtime.MODES.PENDING, { ...state, activationResult: activation, datasetId: activation.activeDatasetId })
    }
    try {
      const active = await adapter.readActive()
      if (!active.ok) return { ok: false, code: 'CUTOVER_ACTIVE_READ_FAILED', cause: active, frozen: true }
      if (active.datasetId !== activation.activeDatasetId || active.revision !== activation.dataRevision || active.checksum !== state.sourceChecksum) return { ok: false, code: 'CUTOVER_ACTIVE_DATASET_MISMATCH', frozen: true }
      const cached = storage.get(adapter.CACHE_KEY), actual = cached && cached.snapshot && fingerprintSnapshot(cached.snapshot)
      if (!cached || cached.datasetId !== active.datasetId || cached.revision !== active.revision || cached.checksum !== active.checksum || cached.byteSize !== state.sourceByteSize || !sameSummary(cached.summary, state.sourceSummary) || !actual || actual.checksum !== active.checksum || actual.byteSize !== state.sourceByteSize || !sameSummary(actual.summary, state.sourceSummary)) return { ok: false, code: 'CUTOVER_CACHE_VERIFY_FAILED', frozen: true }
      runtime.activateCloudMode(cached)
      if (runtime.mode() !== runtime.MODES.CLOUD || runtime.cutoverState().status !== runtime.MODES.CLOUD) return { ok: false, code: 'CUTOVER_MODE_VERIFY_FAILED', frozen: true }
      return { ok: true, code: 'CUTOVER_COMPLETE', datasetId: active.datasetId, revision: active.revision }
    } catch (error) {
      return { ok: false, code: error.code || 'CUTOVER_PENDING_STEP_FAILED', message: error.message, frozen: true }
    }
  }

  async function activate() {
    const live = await check()
    if (!live.readyForActivation) return live
    const source = readSource(), current = fingerprintSnapshot(source)
    if (current.checksum !== live.candidateChecksum || current.byteSize !== live.candidateByteSize || !sameSummary(current.summary, live.candidateSummary)) return { ok: false, code: 'SOURCE_CHANGED_BEFORE_ACTIVATION' }
    const recoveryMeta = { datasetId: live.candidateDatasetId, revision: 0, checksum: current.checksum, byteSize: current.byteSize, summary: current.summary, headVersion: live.headVersion }
    try { adapter.saveRecovery(source, recoveryMeta) } catch (error) { return { ok: false, code: 'RECOVERY_WRITE_FAILED', message: error.message } }
    if (!verifyRecovery(recoveryMeta)) return { ok: false, code: 'RECOVERY_READBACK_FAILED' }
    const id = makeRequestId()
    runtime.setCutoverState(runtime.MODES.ACTIVATING, { requestId: id, datasetId: live.candidateDatasetId, sourceChecksum: current.checksum, sourceByteSize: current.byteSize, sourceSummary: current.summary, expectedHeadVersion: live.headVersion })
    let result
    try { result = await call('activateCoachDataset', { action: 'activate', requestId: id, expectedHeadVersion: live.headVersion, sourceChecksum: current.checksum, sourceByteSize: current.byteSize, sourceSummary: current.summary }) }
    catch (error) { result = await resolveActivation(id) }
    if (!result || !result.ok) {
      if (result && ['ACTIVATION_PROCESSING', 'ACTIVATION_RESULT_UNKNOWN'].includes(result.code)) return result
      runtime.setCutoverState(runtime.MODES.LOCAL, { lastError: result && result.code || 'ACTIVATION_FAILED' })
      return result || { ok: false, code: 'ACTIVATION_FAILED' }
    }
    runtime.setCutoverState(runtime.MODES.PENDING, { requestId: id, datasetId: result.activeDatasetId, sourceChecksum: current.checksum, sourceByteSize: current.byteSize, sourceSummary: current.summary, expectedHeadVersion: live.headVersion, activationResult: result })
    return finishPending()
  }

  return { check, activate, finishPending, getLastCheck: () => clone(lastCheck) }
}

module.exports = { createCutoverOrchestrator }
