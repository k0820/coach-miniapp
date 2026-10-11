const { transferPlan, rebuildSnapshot, verifyRebuilt, MIN_CHUNK_BYTES } = require('./cloud-chunk-transfer')
const { utf8ByteLength } = require('./sha256')

const RPC_SAFE_MAX_BYTES = 80 * 1024
const INITIAL_RECORDS_BYTES = 48 * 1024

function rpcDataByteSize(data) { return utf8ByteLength(JSON.stringify(data)) }

function payloadTooLarge(data, maxBytes = RPC_SAFE_MAX_BYTES) {
  const byteSize = rpcDataByteSize(data)
  if (byteSize <= maxBytes) return null
  const error = new Error(`云函数调用参数过大：action=${data.action || '-'}，collection=${data.collection || '-'}，chunkIndex=${data.chunkIndex == null ? '-' : data.chunkIndex}，${byteSize} 字节。`)
  error.code = 'RPC_PAYLOAD_TOO_LARGE'
  error.action = data.action || ''
  error.collection = data.collection || ''
  error.chunkIndex = data.chunkIndex
  error.byteSize = byteSize
  error.maxBytes = maxBytes
  return error
}

function callCloud(name, data) {
  const tooLarge = payloadTooLarge(data)
  if (tooLarge) return Promise.reject(tooLarge)
  return new Promise((resolve, reject) => wx.cloud.callFunction({
    name,
    data,
    success: response => resolve(response && response.result),
    fail: cause => {
      const error = new Error(`云函数调用失败：action=${data.action || '-'}，collection=${data.collection || '-'}，chunkIndex=${data.chunkIndex == null ? '-' : data.chunkIndex}，${rpcDataByteSize(data)} 字节。${cause && (cause.errMsg || cause.message) || ''}`)
      error.code = cause && cause.code || 'CLOUD_CALL_FAILED'
      error.cause = cause
      reject(error)
    }
  }))
}

const chunkKey = chunk => `${chunk.collection}:${chunk.chunkIndex}`
const uploadChunkData = (sessionId, chunk) => ({ action: 'uploadChunk', sessionId, ...chunk })

function prepareTransferPlan(snapshot, maxRpcBytes = RPC_SAFE_MAX_BYTES) {
  let recordsBytes = Math.min(INITIAL_RECORDS_BYTES, maxRpcBytes - 4096)
  while (recordsBytes >= MIN_CHUNK_BYTES) {
    const plan = transferPlan(snapshot, recordsBytes)
    const placeholderSessionId = 's'.repeat(64)
    const oversized = plan.chunks
      .map(chunk => uploadChunkData(placeholderSessionId, chunk))
      .find(data => payloadTooLarge(data, maxRpcBytes))
    if (!oversized) return plan
    recordsBytes = Math.floor(recordsBytes / 2)
  }
  const error = new Error('无法在安全调用容量内拆分完整数据；本机数据没有上传。')
  error.code = 'RPC_CHUNKING_FAILED'
  throw error
}

async function uploadSnapshotInChunks({ functionName, mode, snapshot, expectedBackupVersion, onProgress, onFinalizeProgress, call = callCloud, maxRpcBytes = RPC_SAFE_MAX_BYTES }) {
  const plan = prepareTransferPlan(snapshot, maxRpcBytes)
  const invoke = async data => {
    const tooLarge = payloadTooLarge(data, maxRpcBytes)
    if (tooLarge) throw tooLarge
    return call(functionName, data)
  }
  const start = await invoke({
    action: 'start', mode, expectedBackupVersion,
    protocolVersion: plan.protocolVersion, backupFormatVersion: plan.backupFormatVersion,
    schemaVersion: plan.schemaVersion, checksum: plan.checksum, byteSize: plan.byteSize,
    summary: plan.summary, totalChunks: plan.totalChunks, collections: plan.collections
  })
  if (start && !start.ok && /coachDB|snapshot/i.test(String(start.message || '')) && /无效|不完整|有效/.test(String(start.message || ''))) {
    return { ok: false, code: 'CLOUD_FUNCTION_OUTDATED', message: '云端备份函数仍是旧版本，请重新部署 backupCoachDB 后再试；本机数据没有改变。' }
  }
  if (!start || !start.ok) return start
  const sessionId = start.sessionId || start.migrationId || start.backupId
  if (!sessionId) return { ok: false, code: 'INVALID_SESSION', message: '云端未返回有效上传会话。' }
  if (start.completed) return start
  const stop = async result => { try { await invoke({ action: 'abort', sessionId }) } catch (error) {}; return result }

  try {
    const status = await invoke({ action: 'status', sessionId })
    if (!status || !status.ok) return stop(status)
    const received = new Set(status.receivedChunks || [])
    let uploaded = 0
    for (const chunk of plan.chunks) {
      if (!received.has(chunkKey(chunk))) {
        const result = await invoke(uploadChunkData(sessionId, chunk))
        if (!result || !result.ok) return stop(result)
      }
      uploaded++
      if (onProgress) onProgress(uploaded, plan.chunks.length)
    }
  } catch (error) {
    try { await invoke({ action: 'abort', sessionId }) } catch (abortError) {}
    throw error
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const final = await invoke({ action: 'finalize', sessionId })
    if (!final || !final.ok) return mode === 'migration' ? final : stop(final)
    if (final.completed) return final
    if (!final.continue) return { ok: false, code: 'FINALIZE_STALLED', message: '云端最终处理未完成，请重试。' }
    if (onFinalizeProgress) onFinalizeProgress(final)
  }
  return { ok: false, code: 'FINALIZE_STALLED', message: '云端最终处理次数超出安全限制，请重试。' }
}

async function readCloudBackup({ call = callCloud } = {}) {
  const meta = await call('verifyCoachDBBackup', { action: 'metadata' })
  if (!meta || !meta.ok || meta.backupFormatVersion !== 2) return meta
  const chunks = []
  for (const descriptor of meta.chunks || []) {
    const result = await call('verifyCoachDBBackup', { action: 'chunk', backupVersion: meta.backupVersion, collection: descriptor.collection, chunkIndex: descriptor.chunkIndex })
    if (!result || !result.ok || !result.chunk) return result || { ok: false, code: 'CHUNK_READ_FAILED', message: '云端备份分块读取失败。' }
    chunks.push(result.chunk)
  }
  const snapshot = rebuildSnapshot(chunks)
  const verification = verifyRebuilt(snapshot, meta)
  if (!verification.ok) return { ok: false, code: 'INTEGRITY_FAILED', message: '云端分块重建后完整性校验失败。' }
  return { ...meta, snapshot, ownerVerified: true, checksumAlgorithm: 'sha256' }
}

module.exports = { RPC_SAFE_MAX_BYTES, rpcDataByteSize, payloadTooLarge, prepareTransferPlan, callCloud, uploadSnapshotInChunks, readCloudBackup }
