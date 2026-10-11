// 临时只读诊断探针（1.1.9 取证用，用完即删）
//
// 目的：拿到 readActive 的真实失败码。这台机器上**任何日志都没有**这个码
//（开发者工具全量 380 个文件搜 errCode/cloud.callFunction 零命中），
// 只能真实跑一次才能得到。
//
// 三条硬约束：
//  ① **只读**：只调 readMyActiveCoachData 的 metadata / integrity / page（分页第一页），
//     加两个对照（coachBusinessCommand 的 getReceipt、readMyCoachCloudData 的 metadata）。
//     这五个 action 在云端全是纯查询分支，没有任何写分支。
//  ② **不经过 adapter**：直接 wx.cloud.callFunction，不 require
//     utils/cloud-primary-adapter.js。所以**不会**写 coachCloudActiveCache、
//     不会改内存 revision、不会动 Outbox、不会触发补发。诊断前后本机状态逐字节相同。
//  ③ **不吞错**：reject 原文（errCode / errMsg / 全部字段）原样落盘，不包装不转码。
const ENV_CODE = 'cloud1-d6g8l8h3uc9d8976f'
const PROBE_ENV = 'production'
const RESULT_KEY = '__readActiveDiagResult'
const MODE_KEY = 'coachDataSourceMode'
const CACHE_KEY = 'coachCloudActiveCache'
const OUTBOX_KEY = 'coachLocalOutbox:production'
const PENDING_KEY = 'coachPendingBookingRequests:production'
const HOLD_KEY = 'coachProductionRecoveryHold'
const BINDINGS_KEY = 'coachBookingBindings:production'

function pad(value) { return value < 10 ? '0' + value : String(value) }
function bjTime(ms) {
  if (!ms) return '-'
  const date = new Date(Number(ms) + 8 * 3600 * 1000)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}
function errorCode(error) {
  if (!error || typeof error !== 'object') return null
  for (const value of [error.errCode, error.errno, error.code]) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}
function clone(value) { try { return JSON.parse(JSON.stringify(value)) } catch (error) { return null } }
// 落盘要小：截长字符串、截长数组、丢掉 page 的 base64 payload（只留字符数）。
function shrink(value, depth) {
  depth = depth || 0
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > 240 ? value.slice(0, 240) + '…(共' + value.length + '字)' : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return value.length > 40 ? value.slice(0, 40).concat(['…共 ' + value.length + ' 条']) : value
  if (depth > 6) return '…(层级过深)'
  const out = {}
  for (const key of Object.keys(value)) {
    if (key === 'payload' && typeof value[key] === 'string') { out.payloadChars = value[key].length; continue }
    out[key] = shrink(value[key], depth + 1)
  }
  return out
}

// 一次真实调用：成功记 result，失败记**原文**。
async function callOnce(id, label, name, data, control) {
  const startedAt = Date.now()
  const base = { id, label, name, data, control: !!control }
  if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
    return Object.assign(base, { ms: 0, ok: false, thrown: true, errCode: null, errMsg: 'wx.cloud.callFunction 不存在', errorKeys: [] })
  }
  try {
    const response = await wx.cloud.callFunction({ name, data })
    return Object.assign(base, { ms: Date.now() - startedAt, ok: true, result: shrink(response && response.result) })
  } catch (error) {
    return Object.assign(base, {
      ms: Date.now() - startedAt,
      ok: false,
      thrown: true,
      errCode: errorCode(error),
      errMsg: String((error && (error.errMsg || error.message)) || error),
      errorKeys: error && typeof error === 'object' ? Object.keys(error) : [],
      errorJson: shrink(clone(error) || String(error))
    })
  }
}

// —— base64 → 文本（只读分页返回的是 base64 的 JSON）——
function utf8Decode(bytes) {
  let out = '', i = 0
  while (i < bytes.length) {
    const first = bytes[i++]
    if (first < 0x80) out += String.fromCharCode(first)
    else if (first < 0xE0) out += String.fromCharCode(((first & 0x1F) << 6) | (bytes[i++] & 0x3F))
    else if (first < 0xF0) out += String.fromCharCode(((first & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F))
    else {
      const point = ((first & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F)
      const value = point - 0x10000
      out += String.fromCharCode(0xD800 + (value >> 10), 0xDC00 + (value & 0x3FF))
    }
  }
  return out
}
function base64ToText(base64) {
  try {
    if (typeof wx.base64ToArrayBuffer !== 'function') return ''
    return utf8Decode(new Uint8Array(wx.base64ToArrayBuffer(base64)))
  } catch (error) { return '' }
}
// 把某个集合完整读一遍（只读分页；单个文档超 24KB 的分片形状不支持，只如实报出来）。
async function readCollection(functionName, collection) {
  const docs = []
  let cursor = 0, fragmentIndex = 0, pages = 0
  for (;;) {
    pages++
    if (pages > 30) return { ok: false, code: 'PAGE_GUARD', docs }
    let page
    try {
      const response = await wx.cloud.callFunction({ name: functionName, data: { action: 'page', collection, cursor, fragmentIndex, environment: PROBE_ENV } })
      page = response && response.result
    } catch (error) {
      return { ok: false, code: 'PAGE_CALL_THREW', errCode: errorCode(error), errMsg: String((error && (error.errMsg || error.message)) || error), docs }
    }
    if (!page || !page.ok) return { ok: false, code: (page && page.code) || 'PAGE_FAILED', docs }
    if (page.encoding === 'base64-fragment') return { ok: false, code: 'FRAGMENT_UNSUPPORTED', docs }
    if (page.payload) {
      const text = base64ToText(page.payload)
      if (!text) return { ok: false, code: 'DECODE_FAILED', docs }
      try { for (const doc of JSON.parse(text)) docs.push(doc) } catch (error) { return { ok: false, code: 'PARSE_FAILED', docs } }
    }
    cursor = page.nextCursor
    fragmentIndex = page.nextFragmentIndex || 0
    if (page.done) break
  }
  return { ok: true, docs, pages }
}
// 谁挂在谁身上断了：云端 integrity.js:11 就是拿 packages.studentId 去 students + tombstone 里找，
// 找不到就 throw。这里用同一套口径把**具体那一条**找出来。
async function relations() {
  const students = await readCollection('readMyActiveCoachData', 'students')
  const tombstones = await readCollection('readMyActiveCoachData', 'student_tombstones')
  const packages = await readCollection('readMyActiveCoachData', 'packages')
  if (!students.ok || !packages.ok) return { ok: false, students: shrink(students), tombstones: shrink(tombstones), packages: shrink(packages) }
  const ids = new Set()
  const naming = {}
  for (const doc of students.docs.concat(tombstones.ok ? tombstones.docs : [])) {
    const data = doc && doc.data ? doc.data : {}
    if (data.id) { ids.add(String(data.id)); naming[String(data.id)] = { name: data.name || null, status: data.status || null } }
  }
  const dangling = []
  for (const doc of packages.docs) {
    const raw = doc || {}, data = raw.data || {}
    const studentId = raw.studentId != null ? raw.studentId : data.studentId
    if (!studentId || ids.has(String(studentId))) continue
    dangling.push({
      docId: raw._id || null,
      packageId: raw.packageId || data.packageId || null,
      studentId: String(studentId),
      packageData: shrink(data)
    })
  }
  const result = {
    ok: true,
    counts: { students: students.docs.length, tombstones: tombstones.ok ? tombstones.docs.length : -1, packages: packages.docs.length, pages: { students: students.pages, packages: packages.pages } },
    danglingCount: dangling.length,
    dangling: shrink(dangling)
  }
  // 旧迁移快照里也许还留着这位学员（能给出名字，也能作为恢复来源）。
  if (dangling.length) {
    const snapshot = await readCollection('readMyCoachCloudData', 'students')
    if (snapshot.ok) {
      const byId = {}
      for (const doc of snapshot.docs) { const data = doc && doc.data ? doc.data : {}; if (data.id) byId[String(data.id)] = { name: data.name || null, status: data.status || null } }
      result.snapshotStudents = snapshot.docs.length
      result.danglingFromSnapshot = dangling.map(row => ({ studentId: row.studentId, inOldSnapshot: !!byId[row.studentId], old: byId[row.studentId] || null }))
    } else {
      result.snapshotRead = shrink(snapshot)
    }
  }
  return result
}

// —— ⑦ 完课级只读取证（2026-09-22 受控补发第一条 unknown 用，只查不写）——
// 用的是**既有只读云函数** `diagnoseCoachCompletion`（救援诊断页点的是同一个 action），
// 它返回：state 分类（A/B/C…）、dataRevision、云端 booking.status、package.used/remaining、
// 该 booking 的 income 行、以及**该 booking 的全部 receipt**（requestId/command/status/revisionBefore/After/completedAt）。
// 这正是「这条命令到底在云端成了没有 / 有没有回执」的唯一权威口径 —— 纯查询，零写分支。
const COMPLETION_PROBE = Object.freeze([
  { id: 'zhuge-0919', label: '诸葛逍遥 2026-09-19（ob_29_l5cmqb completeBooking 的目标课）', bookingId: 'booking_d4149d6670a3d944adfd' },
  { id: 'yingzi-0922', label: '莹子 2026-09-22 17:00（电脑侧 ob_2_i4g811，已确认成功的那条）', bookingId: 'booking_927436bcd4f8eed2cb76' }
])
async function completionFacts() {
  const rows = []
  for (const target of COMPLETION_PROBE) {
    rows.push(await callOnce('completion:' + target.id, '⑦ 完课级只读取证 · ' + target.label, 'diagnoseCoachCompletion', { action: 'diagnose', environment: PROBE_ENV, bookingId: target.bookingId }))
  }
  return rows
}

function readEnvInfo() {  const account = typeof wx.getAccountInfoSync === 'function' ? wx.getAccountInfoSync() : null
  const mini = account && account.miniProgram ? account.miniProgram : {}
  return {
    codeEnv: ENV_CODE, appId: mini.appId, envVersion: mini.envVersion,
    cloudAvailable: !!(wx.cloud && typeof wx.cloud.callFunction === 'function')
  }
}
function readNetworkType() {
  return new Promise(resolve => {
    if (typeof wx.getNetworkType !== 'function') return resolve('unknown')
    wx.getNetworkType({ success: result => resolve(result.networkType), fail: () => resolve('unknown') })
  })
}
function localSnapshot() {
  let mode, cache, outbox, pending, hold, bindings
  try {
    mode = wx.getStorageSync(MODE_KEY)
    cache = wx.getStorageSync(CACHE_KEY) || null
    outbox = wx.getStorageSync(OUTBOX_KEY) || null
    pending = wx.getStorageSync(PENDING_KEY) || null
    hold = wx.getStorageSync(HOLD_KEY)
    bindings = wx.getStorageSync(BINDINGS_KEY)
  } catch (error) { return { error: String(error && error.message || error) } }
  // 子对象一律给默认值，绝不留 null —— 界面模板要能安全取值。
  const safeCache = cache && typeof cache === 'object' ? {
    environment: cache.environment || null, datasetId: cache.datasetId || null, revision: cache.revision,
    updatedAt: cache.updatedAt || null, updatedAtText: bjTime(cache.updatedAt),
    ageMinutes: cache.updatedAt ? Math.round((Date.now() - cache.updatedAt) / 60000) : null
  } : { environment: null, datasetId: null, revision: null, updatedAt: null, updatedAtText: '(本机无缓存)', ageMinutes: null }
  const safeOutbox = outbox && typeof outbox === 'object' ? {
    version: outbox.version, seq: outbox.seq,
    entryCount: (outbox.entries || []).length,
    idMapKeys: Object.keys(outbox.idMap || {}).length,
    failedCount: (outbox.failed || []).length,
    entries: (outbox.entries || []).map(row => ({
      id: row.id, command: row.command, status: row.status, attempts: row.attempts,
      requestId: row.requestId, payload: shrink(row.payload), lastError: shrink(row.lastError),
      nextAttemptAt: row.nextAttemptAt, nextAttemptText: bjTime(row.nextAttemptAt)
    }))
  } : { version: null, seq: null, entryCount: 0, idMapKeys: 0, failedCount: 0, entries: [] }
  return {
    dataSourceMode: mode || null,
    cache: safeCache,
    outbox: safeOutbox,
    pendingBookingRequestCount: pending ? Object.keys(pending).length : 0,
    recoveryHold: hold ? shrink(hold) : null,
    bookingBindingsPresent: !!bindings
  }
}

function describe(step) {
  if (!step) return '未执行'
  if (!step.ok) return '抛异常 errCode=' + (step.errCode == null ? '无' : step.errCode) + ' / ' + step.errMsg
  if (step.result && step.result.ok === false) return '已到达云端，但云端拒绝：code=' + step.result.code
  return '成功'
}
function verdictOf(envInfo, steps) {
  if (!envInfo.cloudAvailable) return 'wx.cloud.callFunction 不存在，基础库没起云开发。'
  const byId = {}
  for (const step of steps) byId[step.id] = step
  const metadata = byId.metadata, integrity = byId.integrity
  if (metadata && !metadata.ok) return '第 1 跳 metadata 就失败：' + describe(metadata)
  if (metadata && metadata.result && metadata.result.ok === false) return 'metadata 到达云端但被拒：code=' + metadata.result.code
  if (integrity && !integrity.ok) return 'metadata 成功（' + metadata.ms + 'ms），但 integrity 失败：' + describe(integrity)
  if (integrity && integrity.result && integrity.result.ok === false) return 'integrity 到达云端但被拒：code=' + integrity.result.code
  if (metadata && metadata.ok && integrity && integrity.ok) return '本次全部通过：readActive 现在读得动云。失败可能是间歇的。'
  return '诊断未完成。'
}
function scopeOf(steps) {
  const controls = steps.filter(step => step.control)
  const failed = controls.filter(step => !step.ok)
  if (!controls.length) return ''
  if (failed.length === controls.length) return '两个对照函数都失败 ⇒ 不是某一个函数，是整条 wx.cloud.callFunction 通道'
  if (!failed.length) return '两个对照函数都成功 ⇒ 通道本身正常，问题只在 readMyActiveCoachData 这一侧'
  return '对照部分成功 ⇒ 与具体函数 / 负载有关'
}

// 结果同时返回给调用方、并落一条诊断日志（唯一一次 Storage 写入）。
function persist(record) {
  try { wx.setStorageSync(RESULT_KEY, record) } catch (error) { /* 落盘失败不影响界面 */ }
  return record
}

async function run() {
  const startedAt = Date.now()
  const envInfo = readEnvInfo()
  envInfo.networkType = await readNetworkType()
  const steps = []
  if (!envInfo.cloudAvailable) {
    return persist({
      version: 1, startedAt, envInfo, steps, local: localSnapshot(), relations: null,
      verdict: verdictOf(envInfo, steps), controlScope: '',
      finishedAt: Date.now(), finishedAtText: bjTime(Date.now())
    })
  }
  const readEnv = { environment: PROBE_ENV }
  // ① 真实读路径第 1 跳 —— readActive 里第一句云端调用
  steps.push(await callOnce('metadata', '① metadata（readActive 第一跳）', 'readMyActiveCoachData', Object.assign({ action: 'metadata' }, readEnv)))
  // ② 真实读路径最后一跳 —— 最重的一次：8 个集合分页 + 全量指纹
  steps.push(await callOnce('integrity', '② integrity（readActive 最后一跳·最重）', 'readMyActiveCoachData', Object.assign({ action: 'integrity' }, readEnv)))
  // ③ 真实读路径中间的分页 —— 单集合第一页
  steps.push(await callOnce('page', '③ page bookings 第 1 页', 'readMyActiveCoachData', Object.assign({ action: 'page', collection: 'bookings', cursor: 0, fragmentIndex: 0 }, readEnv)))
  // ④ 对照 A：写路径那个云函数（只读 action）—— 判「整条通道」还是「单个函数」
  steps.push(await callOnce('controlCommand', '④ 对照A getReceipt（另一个函数·只读）', 'coachBusinessCommand', Object.assign({ action: 'getReceipt', requestId: 'diag_readonly_probe' }, readEnv), true))
  // ⑤ 对照 B：第三个只读云函数
  steps.push(await callOnce('controlRead', '⑤ 对照B readMyCoachCloudData（第三个函数·只读）', 'readMyCoachCloudData', { action: 'metadata' }, true))
  // ⑥ 把「谁挂在谁身上断了」精确定位出来（走同一个只读分页接口，用云端同一套口径）
  let relationResult
  try { relationResult = await relations() } catch (error) { relationResult = { ok: false, code: 'RELATIONS_THREW', message: String(error && error.message || error) } }
  // ⑦ 完课级只读取证（2026-09-22 新增）
  let completionResult
  try { completionResult = await completionFacts() } catch (error) { completionResult = [{ id: 'completion-threw', ok: false, errMsg: String(error && error.message || error) }] }
  // ⑧ 复读 metadata：证明这一轮只读期间云端 revision 没有变（有变就说明期间有人写了）
  steps.push(await callOnce('metadata2', '⑧ 复读 metadata（证明本轮只读期间 revision 未变）', 'readMyActiveCoachData', Object.assign({ action: 'metadata' }, readEnv)))
  const record = {
    version: 1, startedAt, envInfo, steps, local: localSnapshot(), relations: relationResult, completion: completionResult,
    verdict: verdictOf(envInfo, steps), controlScope: scopeOf(steps),
    finishedAt: Date.now(), finishedAtText: bjTime(Date.now())
  }
  return persist(record)
}

// 启动后自动跑一次（每次进程只跑一次）。延迟一会儿，避免与启动期的补发抢云资源。
let launched = false
function scheduleOnLaunch(delayMs) {
  if (launched) return
  launched = true
  setTimeout(() => { run().catch(() => {}) }, typeof delayMs === 'number' ? delayMs : 1500)
}

module.exports = { RESULT_KEY, run, persist, scheduleOnLaunch, bjTime, shrink, verdictOf, scopeOf, localSnapshot }
