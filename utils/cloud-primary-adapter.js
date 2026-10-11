const { reconstructCandidate, integrity, candidateCollections } = require('./candidate-dataset')
const { sameSummary } = require('./summary-compare')
const { summaryDiff } = require('./summary-compare')
// ★ §110 requestId 契约：出网边界只允许用「云端一定认得」的号（详见 request-id-rule.js 顶部长注释）。
//   这是**所有 22 条命令**的唯一出网口 —— 把闸门装在这里，客户端生成端无论怎么拼 key 都不会再
//   把非法号送出去白白烧一次网络往返（真机表现为 COMMAND_RESULT_UNKNOWN / CLOUD_CALL_FAILED /
//   `errMsg: Error: requestId 无效。`）。
const requestIdRule = require('./request-id-rule')

const COMMANDS = Object.freeze(['saveSettings','createCustomExercise','updateCustomExercise','deleteCustomExercise','createManualSale','updateManualSale','deleteManualSale','createStudent','updateStudent','deleteStudent','createPackage','createCourseSale','updateCourseSale','reverseCourseSale','updatePackage','deletePackage','createBooking','setPackageShare','createSharedBooking','createAuthorizedBooking','grantMemberService','revokeMemberService','grantPackageTeaching','revokePackageTeaching','transferPackageManagement','updateBookingContent','rescheduleBooking','cancelBooking','completeBooking','deleteCompletedBooking','markBookingNotHeld'])
const CACHE_KEY = 'coachCloudActiveCache'
const RECOVERY_KEY = 'coachDBCloudCutoverRecovery'
// ★ 增量同步的本机侧（1.1.9 第 7 轮）。
//   镜像 = 与「已验快照」**同一版**的那一份原始业务行，存在**独立**的存储键上。
//   为什么独立成键、而不是塞进主缓存里一起写：
//     ① 主缓存那一笔 `storage.set` 失败会让整个读取失败（既有行为），而镜像纯粹是"快路径的燃料"，
//        它写不进去只该意味着"下一次下拉重新完整读一遍"，**绝不能连累主缓存那一笔写**；
//        分成两笔之后，镜像那笔单独 try/catch 吞错，主缓存的行为一个字没变。
//     ② 键一多、值一大就越容易撞配额（主缓存已经约 250KB，镜像同量级）。
//   配对判据：镜像必须与主缓存 datasetId / revision / checksum **三项全等**才敢当基底 ——
//   少任何一项都不足以说明"这份行就是那份快照"，宁可整份重新读。
const ROWS_KEY = 'coachCloudActiveRows'
const SANDBOX_ROWS_KEY = 'coachSandboxActiveRows'
const MIRROR_NAMES = Object.freeze(['students', 'studentTombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises'])
// 云端用的是**物理**集合名（`student_tombstones`），本机缓存用的是 `reconstructCandidate` 认的逻辑名。
// 两个方向都只在这里定义一次，免得"哪边该转"散落各处。
const MIRROR_LOGICAL = Object.freeze({ students: 'students', student_tombstones: 'studentTombstones', packages: 'packages', bookings: 'bookings', incomes: 'incomes', sales: 'sales', settings: 'settings', customExercises: 'customExercises' })
const MIRROR_KEY_FIELD = Object.freeze({ students: 'studentId', student_tombstones: 'studentId', packages: 'packageId', bookings: 'bookingId', incomes: 'incomeId', sales: 'saleId', settings: 'settingsId', customExercises: 'customExerciseId' })
// 云端明确说「增量做不到」的码。它们**不是**失败，是"这一轮退回完整读取"的指令。
// ⚠️ `INVALID_ACTION` 必须在里面，这是本条最要紧的一格：
//    客户端与云函数是**分别部署**的。现实里完全可能出现「体验版先上、云函数还没重新部署」
//    这种顺序（本项目的既有习惯就是"只重传体验版"），此时旧云函数只会回 `INVALID_ACTION`。
//    若把它当"云端报错"，结果是**手机每次下拉都当场失败、课表再也不刷新** ——
//    这比"慢 8 秒"严重得多，而且是升级过程中最容易踩的一次性事故。
//    当成"增量做不到"就等于：新云函数在 ⇒ 走增量；旧云函数在 ⇒ 逐字退回今天的行为。
//    两个方向都安全，升级顺序不再有约束。
// ⚠️ 前缀兜底同理：云端将来新增任何 `CHANGES_*` 码而这份集合忘了同步，
//    按"做不到 ⇒ 退回整读"处理永远安全；反过来把它当失败则可能让刷新整体不可用。
//    只有**非 CHANGES_ 前缀**的码（身份 / 环境 / 数据集定位 / 传输）才原样返回 ——
//    与既有契约一致：云端报错绝不假装成功。
const CHANGES_FALLBACK = new Set(['CHANGES_INVALID_SINCE', 'CHANGES_AHEAD', 'CHANGES_GAP', 'CHANGES_WINDOW_TOO_LARGE', 'CHANGES_REQUIRES_FULL_READ', 'INVALID_ACTION'])
const changesFallbackReason = code => CHANGES_FALLBACK.has(code) || code.startsWith('CHANGES_')

// ★ 「世界在我读的时候还在前进」—— 云端 `liveChanges` 自己发现读出的数据与 revision 对不上
//   时回的就是它（cloudfunctions/readMyActiveCoachData/index.js:78）。
//
//   ⚠️ 它**不是错误**，是「这一次读到的是旧世界，请再读一次」的信号。
//   旧行为把它判成 `mode:'error'` 并原样交卷 ⇒ 用户下拉拿到的是一份**被丢弃的**增量，
//   页面于是继续显示旧 cache —— 真机（2026-09-24 17:36）「第一次下拉显示 A、第二次才显示 B」
//   就是这个形状的另一种出口。
//   ⇒ 现在它是收敛循环里的"再追一跳"，只有在**追不动**之后才允许退回完整读取。
const CONVERGE_MOVED = new Set(['ACTIVE_READ_REVISION_CHANGED'])
// ★ 云端 `changes` 响应里的 HEAD 提示（1.1.9 第 16 轮，§90）。
//   它**只**用来回答"还要不要再追一跳"，绝不参与任何安全判据 —— 安全全靠 `applyChanges`
//   里那一套五项指纹（能走到 HEAD 判断这一步，说明这一版已经逐项复核过了）。
//   ⚠️ 判"可信"的口子开得极窄，三种情况一律判不可信 ⇒ 调用方退回原有的 `integrity` 确认：
//     ① 不是整数（**旧云函数根本没有这个字段**，体验版先上、云函数没部署时就是这个形状）；
//     ② 比 `dataRevision` 还小（revision 只增不减，倒退只可能是换了数据集 / 文档被改坏）；
//     ③ 数据版本本身不是整数（那这一跳早该被判 CHANGES_MALFORMED，这里是双保险）。
function trustedHeadRevision(response, dataRevision) {
  if (!Number.isInteger(dataRevision)) return null
  if (!response || !Number.isInteger(response.headRevision)) return null
  if (response.headRevision < dataRevision) return null
  return response.headRevision
}
// 收敛检查的有界预算：最多再追几跳 `changes`、以及整个下拉里最多花多少毫秒在追。
//   用尽 ⇒ 退回完整读取（**慢**，但绝不静默地把旧数据当最新交出去）。
const CONVERGE_MAX_HOPS = 3
const CONVERGE_BUDGET_MS = 4000

// 行 → 本机镜像形态：只保留 `reconstructCandidate` 真正会用到的字段。
// `_id` / `ownerCoachId` / `datasetId` 对本机重建毫无用处，而且 `ownerCoachId` 是身份派生值，
// 没有理由在设备本地留一份。删掉它们**不影响**指纹（重建只读 `data` 与排序/归属字段）。
function mirrorRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const next = clone(row)
  delete next._id
  delete next.ownerCoachId
  delete next.datasetId
  return next
}
function mirrorFromCollections(collections) {
  const rows = {}
  for (const name of MIRROR_NAMES) rows[name] = (collections[name] || []).map(mirrorRow).filter(Boolean)
  return rows
}
// 把云端的增量套在本机镜像上。**顺序**是靠"新行追加在末尾"保持的 ——
// 与云端 `nextSortIndex`（永远取最大值 +1）一致，所以两端重建出来的数组顺序逐项相同，
// 这也正是 checksum 能对上的前提。任何看不懂的形状一律返回 null（调用方退回完整读取）。
function mergeMirror(mirror, delta) {
  const next = {}
  for (const name of MIRROR_NAMES) next[name] = (mirror[name] || []).map(clone)
  const upserts = (delta && delta.upserts) || {}, removals = (delta && delta.removals) || {}
  for (const physical of Object.keys(upserts)) {
    const name = MIRROR_LOGICAL[physical], field = MIRROR_KEY_FIELD[physical]
    if (!name || !field) return null
    const list = next[name]
    for (const raw of upserts[physical] || []) {
      const row = mirrorRow(raw)
      const id = row && row[field]
      if (typeof id !== 'string' || !id) return null
      const at = list.findIndex(item => item && item[field] === id)
      if (at >= 0) list[at] = row
      else list.push(row)
    }
  }
  for (const physical of Object.keys(removals)) {
    const name = MIRROR_LOGICAL[physical], field = MIRROR_KEY_FIELD[physical]
    if (!name || !field) return null
    const gone = new Set((removals[physical] || []).map(String))
    next[name] = next[name].filter(item => !gone.has(String(item && item[field])))
  }
  return next
}
// 由本机**已验快照**反推那一份「行」形态。
// 用途只有一个：升级之后本机还没有镜像时，别让用户先白等一次完整分页读取。
// ⚠️ 它必须自证：重建出来的快照要与本机已验缓存 checksum / byteSize / summary 逐项相同才被采用。
//    自证不过就返回 null ⇒ 调用方走完整读取 —— 也就是说这一步最坏的结果是"回到今天的行为"，
//    而不是"拿一份来路不明的行去套增量"。
function mirrorFromSnapshot(cached) {
  try {
    if (!cached || !cached.snapshot) return null
    const collections = candidateCollections(clone(cached.snapshot), '', String(cached.datasetId || ''))
    const rebuilt = integrity(reconstructCandidate(collections))
    if (rebuilt.checksum !== cached.checksum) return null
    if (rebuilt.byteSize !== cached.byteSize) return null
    if (!sameSummary(rebuilt.summary, cached.summary)) return null
    return mirrorFromCollections(collections)
  } catch (error) { return null }
}
function countChanges(delta) {
  let count = 0
  for (const list of Object.values((delta && delta.upserts) || {})) count += (list || []).length
  for (const list of Object.values((delta && delta.removals) || {})) count += (list || []).length
  return count
}
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
function transportFailure(error, fallbackCode = 'COMMAND_RESULT_UNKNOWN') {
  const raw = String(error && (error.errMsg || error.message || error.code) || '')
  const timedOut = /TIME_LIMIT|TIMED?_?OUT|TIMEOUT|超时/i.test(raw)
  return { ok: false, code: fallbackCode, reason: timedOut ? 'CLOUD_FUNCTION_TIMEOUT' : 'CLOUD_CALL_FAILED', message: timedOut ? '云函数运行超时，请检查 coachBusinessCommand 的超时时间设置。' : '云函数调用失败，请稍后重试。', technicalMessage: raw.slice(0, 300) }
}
function base64Bytes(value) { if (typeof wx !== 'undefined' && wx.base64ToArrayBuffer) return new Uint8Array(wx.base64ToArrayBuffer(value)); return new Uint8Array(Buffer.from(value, 'base64')) }
function join(parts) { const size=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(size);let offset=0;parts.forEach(p=>{out.set(p,offset);offset+=p.length});return out }
function utf8(bytes) { let s='',i=0;while(i<bytes.length){const a=bytes[i++];if(a<128)s+=String.fromCharCode(a);else if(a<224)s+=String.fromCharCode(((a&31)<<6)|(bytes[i++]&63));else if(a<240)s+=String.fromCharCode(((a&15)<<12)|((bytes[i++]&63)<<6)|(bytes[i++]&63));else{const p=((a&7)<<18)|((bytes[i++]&63)<<12)|((bytes[i++]&63)<<6)|(bytes[i++]&63),q=p-65536;s+=String.fromCharCode(55296+(q>>10),56320+(q&1023))}}return s }
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length), next = { value: 0 }
  let failed = false, failure
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (!failed) {
      const index = next.value++
      if (index >= items.length) return
      try { results[index] = await worker(items[index], index) }
      catch (error) { if (!failed) failure = error; failed = true }
    }
  })
  // Promise.all must not reject while another worker still reads the snapshot.
  // Drain outstanding requests before releasing the shared read/write lock.
  await Promise.all(runners)
  if (failed) throw failure
  return results
}

function createAdapter({ callCloud, storage, isOnline = () => true, requestId = () => `cmd_${Date.now()}_${Math.random().toString(36).slice(2)}`, environment = () => 'production', onTiming = () => {} }) {
  const states = new Map(), env = () => environment() === 'sandbox' ? 'sandbox' : 'production'
  const stateFor = () => states.get(env()) || { datasetId: '', revision: null, snapshot: null }
  const setState = value => states.set(env(), value)
  // —— 写命令单航班（第 36 节）——
  // 服务端用 expectedRevision 做乐观锁，客户端却**从来没有**「同一时刻只允许一条写命令在飞」的约束：
  // 上一条命令还没返回（内存里的 revision 还是旧值），下一条就带着旧号发出去了 → 后发的那条必然
  // REVISION_CONFLICT，而它自己的业务其实完全合法。真机正是这个形状：上一节的完课链 / resume 重同步
  // 还在飞，用户已经开始下一节 —— 于是「第 1 节成功、第 2 节起失败」。
  // 当前约束覆盖写命令及完整回读；失败时也要等在途分页收尾，才释放航位。
  // Different environments have different trusted heads/datasets/revisions.
  // A slow Sandbox command must never hold Production's read/write lane while
  // the user explicitly returns to their real workspace.
  const writeTails = new Map()
  const serialize = (lane, task) => {
    const tail = writeTails.get(lane) || Promise.resolve()
    const run = tail.then(task, task)
    const settled = run.then(() => undefined, () => undefined)
    writeTails.set(lane, settled)
    settled.then(() => { if (writeTails.get(lane) === settled) writeTails.delete(lane) })
    return run
  }
  const cacheKey = () => env() === 'sandbox' ? 'coachSandboxActiveCache' : CACHE_KEY
  const rowsKey = () => env() === 'sandbox' ? SANDBOX_ROWS_KEY : ROWS_KEY
  // 镜像落盘**单独一笔、单独吞错**（见 ROWS_KEY 上方）。它失败只该让"下一次下拉重新完整读一遍"，
  // 绝不能连累主缓存那一笔写，也绝不能变成一次读取失败。
  function persistMirror(datasetId, revision, checksum, rows) {
    if (!datasetId || !Number.isInteger(revision) || !checksum || !rows) return
    try { storage.set(rowsKey(), { environment: env(), datasetId, revision, checksum, rows: clone(rows) }) } catch (error) {}
  }
  // 解析「本机这份已验缓存」对应的那一份行。
  // ① 已落盘的镜像三项全等（datasetId / revision / checksum）⇒ 直接用；
  // ② 否则由已验快照就地重建并**自证**（见 mirrorFromSnapshot）；
  // ③ 两条都拿不到 ⇒ null ⇒ 调用方退回完整读取（= 今天的行为）。
  function resolveMirror(cached) {
    try {
      const stored = storage.get(rowsKey())
      if (stored && stored.datasetId === cached.datasetId && stored.revision === cached.revision && stored.checksum === cached.checksum && stored.rows) {
        const rows = stored.rows
        if (MIRROR_NAMES.every(name => Array.isArray(rows[name]))) return rows
      }
    } catch (error) {}
    const rebuilt = mirrorFromSnapshot(cached)
    if (rebuilt) persistMirror(cached.datasetId, cached.revision, cached.checksum, rebuilt)
    return rebuilt
  }
  // ★★ 用户下拉的增量同步（1.1.9 第 7 轮）★★
  //
  // 最初（1.1.9 第 7 轮）只给**用户主动下拉**这一条路（`state.lane === 'user'`）：
  //   ① 它是真机上唯一被量到 8.9 / 5.3 秒的那一条，也是唯一一条"用户此刻就要看到最新课表"的指令；
  //   ② 后台轮次（onShow 静默刷新 / 写命令后的自校验 / 同步引擎重同步）读的东西与"用户这一刻要看什么"
  //      无关，而且用户下拉之后本机缓存已经是最新的 ⇒ 它们的首跳会立刻命中"没变"、只花一次调用；
  //   ③ 把改动面压在这一条路上，就不必再把已经真机验收过的后台链路与写链路重新翻一遍。
  //
  // ⚠️ 第 ② 条在 **§86 之后不再成立**（1.1.9 第 15 轮，§87 真机定案）：写命令成功只做轻量确认、
  //    不再推进本机 cache ⇒ 后台再也没有"缓存已最新、首跳立刻命中没变"这种好事，
  //    **每一次**后台读都注定看到 cache 落后 ⇒ 每一次都退化成 13 次调用的整读，
  //    而它与写命令共用同一条航位 ⇒ 真机 11:44 那轮 B 的 create 为它干等 9144ms。
  //    ⇒ 后台（`lane === 'background'`）因此同样开放增量，但**只跳一次、不追收敛**（见调用处）。
  //    写命令路径（`lane:'write-refresh'`）仍然一个字都没动。
  //
  // 三条前置，任何一条过不去都**原样退回今天那条路**（integrity 首跳 → 航位内完整读取）：
  //   ① 本机有可用缓存，且能解析出与之**同源同一版**的行镜像；
  //   ② 一跳 `{action:'changes', sinceRevision}` 成功返回「这一段变了哪几行」；
  //   ③ 把增量套上去、本地重算五项指纹，与云端现场指纹**逐项**比对。
  //
  // ⚠️ 第 ③ 步是这套东西敢开的前提，也是"不许为了速度牺牲安全"这条要求的落点：
  //    增量算漏一条、算错一条、顺序排错，后果都被限定为**这一次刷新退回完整读取**（变慢），
  //    绝不会是"手机显示了错的课表"。checksum / byteSize / summary / counts / amounts 一个都没少，
  //    而且用的是与本机缓存同一份重建口径（`reconstructCandidate` + `integrity`）。
  async function applyChanges(cached, requestedEnvironment, readCacheKey, state) {
    const started = Date.now()
    state.calls++
    let response = null
    try { response = await callCloud('readMyActiveCoachData', { action: 'changes', environment: requestedEnvironment, sinceRevision: cached.revision }) }
    catch (error) { return { mode: 'error', result: { ok: false, code: 'CHANGES_CALL_FAILED', message: '云端调用失败，请稍后重试。' } } }
    state.changesMs = Date.now() - started
    if (!response || response.ok !== true) {
      const code = String((response && response.code) || 'CHANGES_CALL_FAILED')
      // 「增量做不到」= 明确指令，退回完整读取；其余（身份 / 环境 / 数据集定位）原样返回，
      // 与既有契约逐字一致（云端报错绝不假装成功）。
      if (changesFallbackReason(code)) return { mode: 'fallback', reason: code }
      // 云端自证「我读的时候世界还在前进」⇒ 不是错误，是"再追一跳"（见上面的 CONVERGE_MOVED）。
      if (CONVERGE_MOVED.has(code)) return { mode: 'moved' }
      return { mode: 'error', result: response || { ok: false, code } }
    }
    // 跨环境的在途调用绝不能把结果交出去，也绝不能落到任何缓存（与完整读取同一条边界）。
    if (env() !== requestedEnvironment) return { mode: 'error', result: { ok: false, code: 'ENVIRONMENT_CHANGED' } }
    // 数据集换了 ⇒ 本机这份缓存根本不属于云端现在这一代，绝不能被"增量"补成新的。
    if (response.datasetId !== cached.datasetId) return { mode: 'fallback', reason: 'CHANGES_DATASET_CHANGED' }
    if (!Number.isInteger(response.dataRevision)) return { mode: 'fallback', reason: 'CHANGES_MALFORMED' }
    if (response.unchanged === true) {
      // 与原来那一跳 integrity 的判据**逐字相同**：五项全等才算"本机就是云端此刻"。
      if (response.dataRevision !== cached.revision) return { mode: 'fallback', reason: 'CHANGES_REVISION_UNEXPECTED' }
      if (response.checksum !== cached.checksum || response.byteSize !== cached.byteSize || !sameSummary(response.summary, cached.summary)) {
        return { mode: 'fallback', reason: 'INCREMENTAL_FINGERPRINT_MISMATCH' }
      }
      setState({ datasetId: cached.datasetId, revision: cached.revision, checksum: cached.checksum, snapshot: clone(cached.snapshot) })
      return { mode: 'unchanged', cache: clone(cached), headRevision: trustedHeadRevision(response, cached.revision) }
    }
    if (!response.delta) return { mode: 'fallback', reason: 'CHANGES_MALFORMED' }
    // 云端必须给出一个**严格前进**的 revision：没前进就说明这条增量不是"从我们这一版往后"的，
    // 拿着它去补缓存会把缓存的 revision 锚点写错（并让下一次 sinceRevision 出错）。
    if (!(response.dataRevision > cached.revision)) return { mode: 'fallback', reason: 'CHANGES_REVISION_UNEXPECTED' }
    const mirror = resolveMirror(cached)
    if (!mirror) return { mode: 'fallback', reason: 'MIRROR_UNAVAILABLE' }
    let merged = null, snapshot = null, actual = null
    try {
      merged = mergeMirror(mirror, response.delta)
      if (!merged) return { mode: 'fallback', reason: 'CHANGES_MALFORMED' }
      // `reconstructCandidate` 自己会 assert 关系完整性（孤儿课时包等），
      // `integrity` 还会跑一遍 validateRelations —— 两者都抛就说明这份增量不成立。
      snapshot = reconstructCandidate(merged)
      actual = integrity(snapshot)
    } catch (error) { return { mode: 'fallback', reason: 'INCREMENTAL_APPLY_FAILED', message: String(error && error.message).slice(0, 160) } }
    const mismatch = {
      checksum: actual.checksum !== response.checksum,
      byteSize: actual.byteSize !== response.byteSize,
      summary: !sameSummary(actual.summary, response.summary),
      counts: !sameSummary(actual.counts, response.counts),
      amounts: !sameSummary(actual.amounts, response.amounts)
    }
    if (Object.values(mismatch).some(Boolean)) return { mode: 'fallback', reason: 'INCREMENTAL_FINGERPRINT_MISMATCH', mismatch }
    // 落缓存前再过一次"这中间有没有别人写进更新的版本"（与完整读取同一条陈旧保护）。
    const storeStarted = Date.now()
    const existing = storage.get(readCacheKey)
    if (existing && existing.datasetId === response.datasetId && Number.isInteger(existing.revision) && existing.revision > response.dataRevision) {
      return { mode: 'error', result: { ok: false, code: 'ACTIVE_READ_STALE', currentRevision: existing.revision, readRevision: response.dataRevision } }
    }
    const cache = { environment: env(), datasetId: response.datasetId, revision: response.dataRevision, checksum: response.checksum, byteSize: response.byteSize, summary: clone(response.summary), updatedAt: Date.now(), snapshot: clone(snapshot) }
    setState({ datasetId: response.datasetId, revision: response.dataRevision, checksum: response.checksum, snapshot: clone(snapshot) })
    storage.set(readCacheKey, cache)
    persistMirror(response.datasetId, response.dataRevision, response.checksum, merged)
    state.deltaRows = countChanges(response.delta)
    state.cacheMs = Date.now() - storeStarted
    return { mode: 'applied', cache: clone(cache), headRevision: trustedHeadRevision(response, response.dataRevision) }
  }
  // ★★ 用户下拉的「收敛检查」（1.1.9 第 12 轮，§82）。
  //
  //   一跳 `changes` 只能保证「应用到了云端它自己读到的那一版」。云端会自证（读出的数据与
  //   revision 对不上 ⇒ `ACTIVE_READ_REVISION_CHANGED`），但它**读完到我们把结果拿到手**这一段
  //   没人证明。真机（2026-09-24 17:36）正是这个形状：手机第一跳停在 rev 262(=A)，
  //   而云端在同一瞬间继续走到 263(A 取消) / 264(B 新增) ⇒ 用户第一次下拉看到的是 A，
  //   必须再拉一次才看到 B。
  //
  //   所以每次套完增量之后，必须问一次「云端此刻最新是哪一版」。
  //
  // ★★ 1.1.9 第 16 轮（§90）：这一问**优先由 `changes` 响应自带的 headRevision 回答**。
  //   云端在算完 delta **之后**再读一次 revision 文档（单文档、几十毫秒）并随 delta 一起回，
  //   于是「云端算 delta 期间又被人写」这件事**当场**就能看出来，不必再花一次 `integrity`：
  //     · headRevision == 我手里这一版 ⇒ 收敛，这一次下拉到此结束
  //       ⇒ **正常无变化 / 正常有变化都只要 1 次云调用**（修前固定 2 次串行，真机 3.8–5.0 秒）；
  //     · headRevision >  我手里这一版 ⇒ 云端刚被人写了 ⇒ **同一次下拉内部**再追一跳
  //       ⇒ 用户不必手动拉第二次（真机"第一次显示 A、第二次才显示 B"那个形状）；
  //     · headRevision 不可信（**旧云函数**没有这个字段 / 不是整数 / 比 dataRevision 还小）
  //       ⇒ 一字不改地走下面那一次 `integrity` 确认（与部署新云函数之前逐字一致，
  //          客户端先上传、云函数还没部署也是安全的）。
  //   有界：CONVERGE_MAX_HOPS 跳 / CONVERGE_BUDGET_MS 毫秒 —— 这是**一次刷新内部**的技术保护，
  //   与用户能做多少次预约 / 取消**毫无关系**（每一次业务操作都是一次全新的刷新、全新的预算）。
  //   ⚠️ 安全契约一个都没松：每一跳增量仍然要用同一套五项指纹复核，指纹对不上**一律**退回完整读取；
  //     headRevision 只决定"还追不追"，绝不参与"这一版对不对"的判断。
  async function convergeUserRead(state, readEnvironment, readCacheKey, initial, callRead) {
    let current = initial
    let applied = false
    let hops = 0
    const deadline = Date.now() + CONVERGE_BUDGET_MS
    for (;;) {
      const outcome = await applyChanges(current, readEnvironment, readCacheKey, state)
      if (outcome.mode === 'applied') { current = outcome.cache; applied = true; hops += 1 }
      else if (outcome.mode === 'unchanged') { current = outcome.cache; hops += 1 }
      else if (outcome.mode === 'moved') { hops += 1 }
      else if (outcome.mode === 'error') return outcome
      else { state.incrementalFallback = String(outcome.reason || 'INCREMENTAL_UNAVAILABLE'); return outcome }
      if (hops >= CONVERGE_MAX_HOPS || Date.now() >= deadline) {
        state.incrementalFallback = 'CONVERGE_EXHAUSTED'
        return { mode: 'fallback', reason: 'CONVERGE_EXHAUSTED' }
      }
      // ★ 云端给的 HEAD 可信 ⇒ 它已经回答了"还要不要追"，**省掉下面那一次 `integrity`**。
      //   ⚠️ 能走到这里，说明 applyChanges 已经用同一套五项指纹把这一版逐项复核过了；
      //      指纹对不上的时候上面早就 return 了 —— headRevision 相等**绝不会**绕过指纹校验。
      const trustedHead = Number.isInteger(outcome.headRevision) ? outcome.headRevision : null
      if (trustedHead !== null) {
        if (trustedHead === current.revision) return { mode: 'converged', cache: current, applied }
        // 云端还在前面 ⇒ **直接**再追一跳（下一跳的 since 就是刚应用到的这一版）。
        // 不做 integrity：headRevision 已经把这个答案带回来了，再问一次就是白花一趟串行往返。
        continue
      }
      // headRevision 不可信（**旧云函数**没有这个字段 / 不是整数 / 比 dataRevision 还小）
      // ⇒ 一字不改地走下面这一跳 `integrity` 确认（与部署新云函数之前逐字一致）。
      const confirmStarted = Date.now()
      const confirm = await callRead({ action: 'integrity' })
      state.integrityMs += Date.now() - confirmStarted
      if (!confirm || confirm.ok !== true) return { mode: 'error', result: confirm || { ok: false, code: 'CONVERGE_CONFIRM_FAILED' } }
      if (env() !== readEnvironment) return { mode: 'error', result: { ok: false, code: 'ENVIRONMENT_CHANGED' } }
      if (confirm.datasetId !== current.datasetId) return { mode: 'fallback', reason: 'CONVERGE_DATASET_CHANGED' }
      const head = Number.isInteger(confirm.dataRevision) ? confirm.dataRevision : null
      if (head === null) return { mode: 'fallback', reason: 'CONVERGE_MALFORMED' }
      // 云端比本机还旧是不可能的（本机这一版就是从云端来的）⇒ 那一定意味着数据集/身份换了代。
      if (head < current.revision) return { mode: 'fallback', reason: 'CONVERGE_REVISION_UNEXPECTED' }
      if (head === current.revision) {
        const verified = confirm.checksum === current.checksum && confirm.byteSize === current.byteSize && sameSummary(confirm.summary, current.summary)
        if (!verified) return { mode: 'fallback', reason: 'INCREMENTAL_FINGERPRINT_MISMATCH' }
        return { mode: 'converged', cache: current, applied }
      }
      // 云端还在前面 ⇒ 同一次下拉内部继续追（下一跳的 since 就是刚应用到的这一版）。
    }
  }

  const reads = new Map()
  const freshReads = new Map()
  const writes = new Map()
  // —— 完整回读的有限重试（多设备刷新，1.1.7）——
  // 一次主动回读是「metadata → 8 个集合分页 → integrity」十来个 RPC。只要**在这个窗口里**
  // 有人提交了一条命令（另一台设备的写入，或本机 Outbox 的补发），两步拿到的 revision 就不一样。
  // 云端 readMyActiveCoachData 的 integrity 就是拿「它自己刚读到的 revision」与这次请求的
  // revision 相比（cloudfunctions/readMyActiveCoachData/index.js:23），所以真机上只有两种形状：
  //   · 云端自己发现 → `ACTIVE_READ_REVISION_CHANGED`
  //   · 写入落在两次调用之间，云端 integrity 自洽地回了新 revision，客户端比对时才发现对不上
  //     → `ACTIVE_READ_INTEGRITY_FAILED` 且 mismatch.revision=true（此时 checksum 必然也对不上）
  // 旧行为是就此放弃：页面保留旧缓存，于是课表继续把对方刚约走的时间显示成空闲
  //（真机形状："电脑版已经预约、手机版没有显示"），而且**没有任何自动重试**，
  // 用户只能反复手动点那一行提示。
  //
  // ★ 重试边界**只**划在「世界在我读的时候动了」这一件事上，别的形状一律不重试：
  //   · 允许重试：只有上面那两种 revision 对不上的形状。再读一次就能拿到一致快照；
  //     而**重试成功之前一个字节都不落 cache**（cache 只在逐项一致之后才写），失败则原样保留旧缓存。
  //   · 传输抛错**不重试**，而且整次回读**照旧抛出去**（不许吞掉、不许改成 ok:false）——
  //     这条同时是两个既有契约：① `active-read-failure-drain`：一个分页失败后不许继续启动剩余
  //     集合，也不许重启分页；② `session-sequential-courses` ⑧：整次回读只有一个 integrity 读，
  //     它抛了整次就失败，调用方照旧拿到 REFRESH_THREW、页面照旧保留本机课表。
  //   · 指纹对不上而 revision 没变（checksum / summary / counts / amounts）**不重试**：
  //     那是真·数据不一致，重试只会多烧 RPC 并把损坏藏成"网络抖动"。
  //   · environment / datasetId 变了**不重试**：那不是"世界动了"，是这次回读的目标本身失效了
  //     —— 跨环境在途回读绝不能落到任何新缓存。
  const READ_ATTEMPTS = 3
  const READ_BACKOFF_MS = [120, 320]
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  function readRetryable(result) {
    if (!result) return false
    if (result.code === 'ACTIVE_READ_REVISION_CHANGED') return true
    if (result.code === 'ACTIVE_READ_INTEGRITY_FAILED') return !!(result.mismatch || {}).revision
    return false
  }
  function readActive(options) {
    const requestedEnvironment=env()
    // ★ 排队等待的计时起点（1.1.9 第 2 轮）：取在**进入航位之前**。
    //   readActiveAttempt 的 started 在航位内部，所以旧数据里的 totalMs 天然不含
    //   「排在别的读/写后面干等」那一段 —— 而真机上的 10 秒，最大嫌疑正是这一段。
    const queuedAt=Date.now()
    // ★★ 用户主动下拉刷新 = 一句「现在给我最新数据」的明确指令（1.1.9）。
    //    它**绝不能**被一份「用户开口之前就已经在飞」的回读满足：
    //    那份回读在另一台设备的写入落地之前就把快照读走了，复用它 = 用户看到旧数据，
    //    而界面上的样子与「刷新什么都没发生」**完全同形** —— 真机上就是
    //    「电脑已经取消、手机下拉之后仍然显示旧的」，而且再拉一次也可能又撞上同一份在途回读。
    //    所以用户轮次另起一次**新的**完整回读。
    //    ★★ 1.1.9 第 3 轮（真机账本定案）：只"另起一次"**还不够** ——
    //    新起的那一次仍然**排在**在途后台整读后面，而账本显示用户那一轮
    //    queueMs=8021ms、自己只花 1022ms、pages=0（首跳早就命中）。
    //    排在它前面的正是 onShow 起的那一轮后台整读（seq 35：排队 1498 + metadata 2120
    //    + pages 4881 + integrity 921 = 7938ms）。后台整读读的东西与这次**只读校验**毫无关系。
    //    ⇒ 用户这一次的**只读校验首跳**改为不进航位直接发（见 userRefreshRead）：
    //      它不写任何东西、不碰写航位，与后台整读并存是安全的；
    //      只有"首跳证明缓存已不是云端此刻状态"时才回到航位走完整读取。
    //    ⚠️ 这条豁免**只给 userInitiated 这一条路**：后台轮次（onShow 静默刷新、写命令后的自校验、
    //      同步引擎的重同步）行为逐字不变，仍然全部走 serialize；
    //      写命令与它的完整回读照旧独占航位 ——「同一时刻只有一条命令 + 它的一次完整回读」一个字没变。
    //    连点两下：第二下复用第一下的用户轮次（用户轮次内部仍然合并为一次），不会叠加。
    if(options&&options.userInitiated===true){
      if(freshReads.has(requestedEnvironment))return freshReads.get(requestedEnvironment)
      const fresh=userRefreshRead(requestedEnvironment,queuedAt)
      freshReads.set(requestedEnvironment,fresh)
      const clear=()=>{if(freshReads.get(requestedEnvironment)===fresh)freshReads.delete(requestedEnvironment)}
      fresh.then(clear,clear)
      return fresh
    }
    if(reads.has(requestedEnvironment))return reads.get(requestedEnvironment)
    // A page onShow during this client's write does not need a second full read:
    // the write itself performs a verified read after committing. Reuse it only
    // when that read succeeded; on failure keep the page's independent retry.
    // ★ 1.1.9 第 6 轮：「写命令之后带回来的东西」现在有两种 ——
    //   ① `refreshed`   = 完整回读成功 ⇒ 本机 cache 已跟上这一版，**可以**直接复用（修前的老路径）；
    //   ② `confirmed`   = 轻量确认成功 ⇒ 云端已确认，但**本机 cache 仍是旧的**。
    //   这里只认 ①，②必须让页面自己做一次完整读取 ——
    //   把 ② 当 ① 复用会把"没有 snapshot 的确认"当成最新数据交出去，页面照着旧 cache 渲染，
    //   而且**看不出来**（视图层拿到的是一份形状合法的结果）。
    const writing = writes.get(requestedEnvironment)
    const freshRead = () => serialize(requestedEnvironment,()=>env()===requestedEnvironment?readActiveNow({queuedAt,lane:'background'}):{ok:false,code:'ENVIRONMENT_CHANGED'})
    const task = writing
      ? writing.then(result => result && result.refreshed && result.refreshed.ok && !result.refreshed.lightweight ? result.refreshed : freshRead(), freshRead)
      : freshRead()
    reads.set(requestedEnvironment,task)
    task.then(()=>{if(reads.get(requestedEnvironment)===task)reads.delete(requestedEnvironment)},()=>{if(reads.get(requestedEnvironment)===task)reads.delete(requestedEnvironment)})
    return task
  }
  // ★★ 用户主动下拉读（1.1.9 第 3 轮）：先发**一跳只读校验**，这一跳不进航位。
  //
  // 为什么允许并存：这一跳只有 `{action:'integrity'}` —— 云端把八个集合现读一遍算指纹，是**只读**的。
  //   它不写任何东西、不碰写航位，所以「同一时刻只有一条业务命令 + 它的完整回读」这条不变量
  //   一个字都没变（写命令照旧独占航位）。
  // 为什么必须先发：真机账本（2026-09-23）显示用户那一轮 9.04s 里 **8.02s 是在排队干等**，
  //   自己只花 1.02s 且 pages=0。排在它前面的那轮后台整读，与这次只读校验毫无关系。
  // 边界（一个都不放松）：
  //   · 云端报错 ⇒ 原样返回（与既有契约逐字一致，绝不假装成功）；
  //   · 指纹/版本与**已验缓存**不一致 ⇒ 进航位走**原有完整读取**，integrity 校验一个都不少；
  //   · 本机没有可用缓存 ⇒ 不做首跳，直接进航位完整读取（与旧行为相同）。
  async function userRefreshRead(requestedEnvironment,queuedAt){
    if(env()!==requestedEnvironment)return {ok:false,code:'ENVIRONMENT_CHANGED'}
    const cached=storage.get(cacheKey())
    const cacheUsable=!!(cached&&Number.isInteger(cached.revision)&&cached.checksum&&cached.byteSize&&cached.snapshot)
    // 没有可用缓存时，进航位的时刻就是"用户开口"的时刻；有缓存时下面会把它改成"决定进航位的那一刻"。
    let laneQueuedAt=queuedAt
    if(cacheUsable){
      const probe=await readActiveNow({queuedAt,lane:'user',probeOnly:true})
      if(probe&&probe.code!=='PROBE_REQUIRES_FULL_READ')return probe
      // ⚠️ 排队计时起点取在**决定进航位的那一刻**：queueMs 因此仍然是"纯排队"这一列，
      //   首跳自己那一段已经单独记在它自己那条账上了（两列不许互相包含）。
      laneQueuedAt=Date.now()
    }
    return serialize(requestedEnvironment,()=>{
      if(env()!==requestedEnvironment)return {ok:false,code:'ENVIRONMENT_CHANGED'}
      // ★ 首跳刚判过"不一致"，但排队这段时间里**别的读取可能已经把缓存修好了**
      //   （最典型：排在前面那轮后台整读刚好读完并落了新缓存）。
      //   缓存自那以后没动过 ⇒ 首跳的结论仍然成立，直接起完整读取（省掉一次重复校验）；
      //   缓存动过 ⇒ 重新做一次首跳（此刻很可能已经全等，直接结束、省掉整整一轮分页）。
      const now=storage.get(cacheKey())
      const moved=!cached||!now||now.datasetId!==cached.datasetId||now.revision!==cached.revision||now.checksum!==cached.checksum
      if(cacheUsable&&!moved)return readActiveNow({queuedAt:laneQueuedAt,lane:'user',skipProbe:true})
      return readActiveNow({queuedAt:laneQueuedAt,lane:'user'})
    })
  }
  // 有限次重试的外壳。**除「revision 动了」以外的一切失败，行为与无重试时逐字一致**：
  // 返回原样的失败对象；`readActiveAttempt` 抛错则**原样抛出去**（不吞、不转码 —— 那会把
  // 既有契约里的 REFRESH_THREW / 整次失败语义改掉）。重试若干次仍失败 → 返回最后一次的失败，
  // 绝不假装成功、也绝不写 cache。
  async function readActiveNow(trace) {
    const context = trace || {}
    let last = null
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      if (attempt) await wait(READ_BACKOFF_MS[attempt - 1] || 0)
      const result = await readActiveAttempt(context, attempt)
      if (result && result.ok) return result
      last = result
      if (!readRetryable(result)) return result
    }
    return last
  }
  // 一跳回读。为了让「无论成功、失败还是抛错都一定留痕」，主体拆进 Inner，
  // 外层只负责把这一跳如实记进账本（记账本身绝不抛错，它绝不允许影响业务结果）。
  async function readActiveAttempt(trace, attempt) {
    const context = trace || {}
    const started = Date.now()
    const state = {
      environment: env(),
      lane: context.lane || 'background',
      attempt: attempt || 0,
      queuedAt: Number.isFinite(Number(context.queuedAt)) ? Number(context.queuedAt) : started,
      // 用户下拉那一路的两种模式（见 userRefreshRead）：
      //   probeOnly  = 只做那一跳只读校验，不一致就把球交回调用方（绝不在航位外翻分页）；
      //   skipProbe  = 刚判过"不一致"且缓存没动过，直接起完整读取，省掉一次重复校验。
      probeOnly: !!context.probeOnly,
      skipProbe: !!context.skipProbe,
      metadataMs: 0, pagesMs: 0, integrityMs: 0, cacheMs: 0,
      // 增量同步（1.1.9 第 7 轮）：`changesMs` = 那一跳 `changes` 自己的耗时；
      // `deltaRows` = 这一版实际回传了几行（0 通常意味着"没变化"）；
      // `incrementalFallback` = 增量没走成时**为什么**（有值就说明这一次退回完整读取了）。
      // 这三列让"真机这次到底走没走增量、为什么没走"直接从账本里读出来，不必再靠推算。
      changesMs: 0, deltaRows: 0, incrementalFallback: null,
      calls: 0, pages: 0, pageCounts: [], revision: null, skipped: null
    }
    let outcome = ''
    try {
      const result = await readActiveAttemptInner(state)
      outcome = result && result.ok ? (state.skipped ? state.skipped : (result.offline ? 'OFFLINE' : 'OK')) : String((result && result.code) || 'UNKNOWN')
      return result
    } catch (error) {
      outcome = 'THREW'
      throw error
    } finally {
      // ★ 排队等待 = 「要求刷新」→「真正开始读」之间的时间。它纯粹是等前面那条读/写，
      //   与这一跳本身快慢无关，所以必须单独一列 —— 混进 totalMs 就分不出该优化谁。
      try {
        onTiming({
          action: 'readActive', environment: state.environment, lane: state.lane, attempt: state.attempt,
          outcome, skipped: state.skipped, revision: state.revision,
          queueMs: Math.max(0, started - state.queuedAt),
          metadataMs: state.metadataMs, pagesMs: state.pagesMs, integrityMs: state.integrityMs, cacheMs: state.cacheMs,
          changesMs: state.changesMs, deltaRows: state.deltaRows, incrementalFallback: state.incrementalFallback,
          totalMs: Date.now() - started, calls: state.calls, pages: state.pages, pageCounts: state.pageCounts.slice().sort().join(',')
        })
      } catch (error) {}
    }
  }
  async function readActiveAttemptInner(state) {
    const readEnvironment=env(),readCacheKey=cacheKey()
    const callRead=data=>{state.calls++;return callCloud('readMyActiveCoachData',{...data,environment:readEnvironment})}
    const started = Date.now()
    if (!isOnline()) { const cached = storage.get(cacheKey()); return cached ? { ok: true, offline: true, environment: env(), ...clone(cached) } : { ok: false, code: 'OFFLINE_CACHE_MISSING' } }
    // ★★ 廉价「校验式」首跳（1.1.9 第 2 轮）。
    //
    //    为什么不是"只问一下 revision"：只问版本号、然后直接采信本机缓存，等于在**快路径上把
    //    integrity 校验悄悄拿掉了** —— 那正是「指纹对不上必须如实失败」这条既有安全契约要防的事
    //    （revision 计数器与数据集是两份文档；真出现不一致时，只比版本号永远看不出来）。
    //    用户的要求也是"不取消 integrity 校验"，所以这里**一跳就把校验做完**：
    //      `action:'integrity'` 会让云端**现场**把八个集合读一遍、算出指纹并连同 dataRevision 一起回；
    //      客户端拿它与本机**已验证缓存**（checksum / byteSize / summary / revision / datasetId）逐项比对。
    //        · 全对 ⇒ 本机快照就是云端此刻的状态 ⇒ 立即结束（不再翻分页）。
    //        · 有任何一项不同（含 revision 变了）⇒ 走下面的**完整**读取（分页 + integrity 一个都不少）。
    //        · 云端自己报错 ⇒ 原样返回（与既有契约逐字一致，绝不假装成功）。
    //    成本：修前每次刷新固定 12 次云函数往返（metadata 1 + page 10 + integrity 1）；
    //          修后「没变化」只 1 次，「有变化」13 次（多这一次就是这次校验）。
    //    ⚠️ 这**不是**"复用一份在途的旧快照"：这次调用是刚刚发出去的**新请求**，读到的是此刻的云端状态。
    //       航位口径（1.1.9 第 3 轮）：用户下拉那一路的**首跳**不进航位（见 userRefreshRead，它只读、
    //       不写，与在途后台整读并存是安全的）；后台轮次的首跳与所有完整读取照旧在航位内依次执行。
    //       首跳一旦判出"不一致"，完整读取仍然回到航位里跑（probeOnly/skipProbe 两个开关就是这条边界）。
    //    ⚠️ 必须同时补内存态：state 是「本机当前 revision」，进程重启后是空的；
    //       少了这一句，下一条写命令会因为 REVISION_UNKNOWN 在**出网前**被拒。
    const cached = storage.get(readCacheKey)
    const cacheUsable = !state.skipProbe && !!(cached && Number.isInteger(cached.revision) && cached.checksum && cached.byteSize && cached.snapshot)
    // ★ 增量同步（1.1.9 第 7 轮）：**用户主动下拉**这一条路先试「只读这一段变化」。
    //   它把今天"先一跳校验、判出不一致再整份搬 250KB"变成"一跳就拿到变的那几行"。
    //   试不成（拿不到镜像 / 云端说做不到 / 套上去指纹对不上）就**原样退回今天那条路**：
    //   因为已经知道"增量的依据不成立"，这里不再多花一次 integrity 首跳，直接交回调用方进航位整读。
    if (cacheUsable && (state.lane === 'user' || state.lane === 'background')) {
      if (state.lane === 'user') {
        // ★ 收敛循环：一跳不够就**在同一次下拉内部**再追，直到「本机 revision == 云端最新 revision」。
        const outcome = await convergeUserRead(state, readEnvironment, readCacheKey, cached, callRead)
        if (outcome.mode === 'converged') {
          state.skipped = outcome.applied ? 'INCREMENTAL' : 'VERIFIED_UNCHANGED'
          state.revision = outcome.cache.revision
          return { ok: true, ...outcome.cache, ...(outcome.applied ? {} : { unchanged: true }) }
        }
        if (outcome.mode === 'error') return outcome.result
        state.incrementalFallback = String(outcome.reason || 'INCREMENTAL_UNAVAILABLE')
        if (state.probeOnly) return { ok: false, code: 'PROBE_REQUIRES_FULL_READ' }
      } else {
        // ★★ 后台轮次（onShow 静默刷新 / 同步引擎重同步）同样先试**一跳**增量（1.1.9 第 15 轮，§87）。
        //
        //   为什么必须放开：§86 之后写命令成功**只做轻量确认、不再推进本机 cache**
        //   ⇒ 从此**任何**后台读看到的都是「cache 落后于云端」⇒ 后台没有增量可用
        //   ⇒ 每一次都退化成 metadata + 8 集合 10 页 + integrity = 13 次云调用（真机 9~11 秒），
        //   而且它**与写命令共用同一条 serialize 航位** ⇒ 真机 11:44 那轮 B 的 create
        //   就为它干等了 9144ms —— 这才是「手机第一次下拉为空」的真正来源。
        //   ⇒ 后台必须也能走增量，否则 §86 只是把那次搬运**推迟**到命令之间，代价一秒没少。
        //
        // ⚠️ 与 user 泳道的边界：**后台只跳一次，不追收敛**。
        //    ① 用户在等的是"此刻最新"，后台不是；追收敛会凭空多出 integrity + 第二跳；
        //    ② 后台是航位内的常客，多一跳就多占一会儿航位，正好是这次要消灭的东西；
        //    ③ 因此 `convergeUserRead` 一个字都没动（`state.lane === 'user'` 才进得去）。
        //
        // ⚠️ 安全契约与 user 那条路**逐字相同**，一条都没松（都由 `applyChanges` 自己保证）：
        //    · 起点必须是**可信 cache revision**（上面的 `cacheUsable`：整数 revision + checksum
        //      + byteSize + snapshot 俱全的已验缓存），拿不到就根本不进这个分支；
        //    · 镜像解析不出来 ⇒ MIRROR_UNAVAILABLE ⇒ 退完整读取；
        //    · 云端说做不到（CHANGES_GAP / AHEAD / WINDOW_TOO_LARGE …）⇒ 退完整读取；
        //    · 套上增量后本地重算五项指纹（checksum / byteSize / summary / counts / amounts）
        //      与云端现场指纹**逐项**比对，任何一项不同 ⇒ 退完整读取；
        //    · `reconstructCandidate` / `integrity` 抛错 ⇒ 退完整读取；
        //    · 落缓存前的陈旧保护（`existing.revision > 读到的一版`）照旧。
        const outcome = await applyChanges(cached, readEnvironment, readCacheKey, state)
        if (outcome.mode === 'applied' || outcome.mode === 'unchanged') {
          state.skipped = outcome.mode === 'applied' ? 'INCREMENTAL' : 'VERIFIED_UNCHANGED'
          state.revision = outcome.cache.revision
          return { ok: true, ...outcome.cache, ...(outcome.mode === 'applied' ? {} : { unchanged: true }) }
        }
        if (outcome.mode === 'error') {
          const code = String((outcome.result && outcome.result.code) || '')
          // 传输层抛错（云端调用中断）：**不许**把它改写成 ok:false 的假失败 —— 既有契约是
          // 「传输抛错整次回读照旧抛出去」（active-read-failure-drain）。往下走完整读取，
          // 那一跳 metadata 会照旧抛出，行为与放开后台之前逐字一致。
          if (code === 'CHANGES_CALL_FAILED') state.incrementalFallback = 'CHANGES_CALL_FAILED'
          else return outcome.result
        } else {
          // moved = 云端自证「我读的时候世界还在前进」：后台不去追，直接退完整读取（安全侧）。
          state.incrementalFallback = String(outcome.reason || (outcome.mode === 'moved' ? 'ACTIVE_READ_REVISION_CHANGED' : 'INCREMENTAL_UNAVAILABLE'))
        }
      }
    }
    // 增量那一轮已经判过"做不到" ⇒ 不再多花一次 integrity 首跳，直接往下走完整读取。
    if (cacheUsable && !state.incrementalFallback) {
      const probeStarted = Date.now()
      const probe = await callRead({ action: 'integrity' })
      state.integrityMs = Date.now() - probeStarted
      if (!probe.ok) return probe
      state.revision = Number.isInteger(probe.dataRevision) ? probe.dataRevision : null
      // 跨环境的在途回读**绝不能**落到任何缓存，也绝不能把另一个环境的数据当成结果交出去。
      if (env() !== readEnvironment) return { ok: false, code: 'ENVIRONMENT_CHANGED' }
      const verified = probe.datasetId === cached.datasetId && probe.dataRevision === cached.revision &&
        probe.checksum === cached.checksum && probe.byteSize === cached.byteSize && sameSummary(probe.summary, cached.summary)
      if (verified) {
        state.skipped = 'VERIFIED_UNCHANGED'
        setState({ datasetId: cached.datasetId, revision: cached.revision, checksum: cached.checksum, snapshot: clone(cached.snapshot) })
        return { ok: true, ...clone(cached), unchanged: true }
      }
    }
    // ★ 用户下拉的"只读首跳"到此为止：不一致就交回调用方**进航位**做完整读取。
    //   绝不在这条"不进航位"的路上继续翻分页 —— 那等于把一整次完整读取放到航位外跑，
    //   会让"同一时刻只有一条业务命令 + 它的完整回读"这条不变量失效。
    if (state.probeOnly) return { ok: false, code: 'PROBE_REQUIRES_FULL_READ' }
    const meta = await callRead({ action: 'metadata' }); if (!meta.ok) return meta
    state.metadataMs = Date.now() - started
    state.revision = Number.isInteger(meta.dataRevision) ? meta.dataRevision : null
    const pagesStarted = Date.now()
    const collections = Object.fromEntries(meta.collections.map(name => [name === 'student_tombstones' ? 'studentTombstones' : name, []]))
    // 免费云环境的并发余量很小。八个集合同时 callFunction，再叠加页面刷新、
    // Outbox 查单和开发者工具体检，会在同一秒挤出十几个请求；平台虽然能接住
    // 一部分（日志显示 202 running），客户端却会随机收到“云端调用中断”。
    // 限制为同时两个集合：仍保留 8 个分页 + 最终 integrity，一个校验都不少。
    // （1.1.9：并发限制一个字没改；页数由云端的 PAGE_LIMIT 决定，页数记进账本，
    //   所以「体验版到底有没有走新云函数」可以直接从 bookings 的页数上看出来。）
    const pageResults = await mapLimit(meta.collections, 2, async physical => {
      let cursor = 0, fragmentIndex = 0, fragments = [], calls = 0
      const records = []
      for (;;) {
        const page = await callRead({ action: 'page', collection: physical, cursor, fragmentIndex }); calls++
        if (!page.ok) { state.pages += calls; state.pageCounts.push(`${physical}:${calls}!${page.code}`); return { error: page } }
        if (page.encoding === 'base64-fragment') {
          fragments[page.fragmentIndex] = base64Bytes(page.payload)
          if (page.nextCursor > cursor) { records.push(JSON.parse(utf8(join(fragments)))); fragments = [] }
        } else if (page.payload) records.push(...JSON.parse(utf8(base64Bytes(page.payload))))
        cursor = page.nextCursor; fragmentIndex = page.nextFragmentIndex || 0; if (page.done) break
      }
      state.pages += calls
      state.pageCounts.push(`${physical}:${calls}`)
      return { physical, records }
    })
    const failedPage = pageResults.find(result => result.error)
    if (failedPage) return failedPage.error
    state.pagesMs = Date.now() - pagesStarted
    const verificationStarted = Date.now()
    for (const { physical, records } of pageResults) collections[physical === 'student_tombstones' ? 'studentTombstones' : physical] = records
    const snapshot = reconstructCandidate(collections), actual = integrity(snapshot)
    const current = await callRead({ action: 'integrity' }); if (!current.ok) return current
    if (Number.isInteger(current.dataRevision)) state.revision = current.dataRevision
    const expectedEnvironment = env(), environmentMismatch = expectedEnvironment === 'sandbox' ? meta.environment !== 'sandbox' || current.environment !== 'sandbox' : meta.environment === 'sandbox' || current.environment === 'sandbox'
    const mismatch = {
      environment: environmentMismatch,
      datasetId: current.datasetId !== meta.datasetId,
      revision: current.dataRevision !== meta.dataRevision,
      checksum: actual.checksum !== current.checksum,
      byteSize: actual.byteSize !== current.byteSize,
      summary: !sameSummary(actual.summary, current.summary),
      counts: !sameSummary(actual.counts, current.counts),
      amounts: !sameSummary(actual.amounts, current.amounts)
    }
    if (Object.values(mismatch).some(Boolean)) return { ok: false, code: 'ACTIVE_READ_INTEGRITY_FAILED', mismatch, expected: { datasetId: current.datasetId, revision: current.dataRevision, checksum: current.checksum, byteSize: current.byteSize, summary: current.summary, counts: current.counts, amounts: current.amounts }, actual: { datasetId: meta.datasetId, revision: meta.dataRevision, checksum: actual.checksum, byteSize: actual.byteSize, summary: actual.summary, counts: actual.counts, amounts: actual.amounts }, summaryDiff: summaryDiff(actual.summary, current.summary) }
    state.integrityMs = Date.now() - verificationStarted
    const cacheStarted = Date.now()
    if(env()!==readEnvironment)return {ok:false,code:'ENVIRONMENT_CHANGED'}
    const existing = storage.get(readCacheKey)
    if (existing && existing.datasetId === meta.datasetId && Number.isInteger(existing.revision) && existing.revision > meta.dataRevision) return { ok: false, code: 'ACTIVE_READ_STALE', currentRevision: existing.revision, readRevision: meta.dataRevision }
    setState({ datasetId: meta.datasetId, revision: meta.dataRevision, checksum: current.checksum, snapshot })
    const cache = { environment: env(), datasetId: meta.datasetId, revision: meta.dataRevision, checksum: current.checksum, byteSize: current.byteSize, summary: clone(current.summary), updatedAt: Date.now(), snapshot: clone(snapshot) }
    storage.set(readCacheKey, cache)
    // ★ 1.1.9 第 7 轮：顺手把这一版对应的**行镜像**落盘（独立键、单独吞错，见 ROWS_KEY 上方）。
    //   有了它，下一轮用户下拉就能只取"变的那几行"，不必再整份搬一次。
    //   它写不进去只影响"下次快不快"，不影响这次读到什么 —— 所以放在主缓存那一笔之后，且自行吞错。
    persistMirror(meta.datasetId, meta.dataRevision, current.checksum, mirrorFromCollections(collections))
    state.cacheMs = Date.now() - cacheStarted
    return { ok: true, ...clone(cache) }
  }
  // ★★ 写命令后的「轻量确认」（1.1.9 第 6 轮）★★
  //
  // 修前：命令事务成功 → 立刻做一次**完整分页回读**（metadata + 八集合分页 + integrity）。
  //   真机账本（`coachReadTimings`）里 `lane:'write-refresh'` 共 8 条，**全部 8,057–10,473ms**（均 9,098）。
  //   这一笔两台设备都会付：写的那台付一次；读的那台下拉时还要付一次自己的完整读取，
  //   而且**两者共用同一条串行航位** —— 用户下拉因此被写命令的回读堵在后面（实测 queueMs=8,613ms）。
  //
  // 修后：命令事务成功（**唯一成功依据**，receipt 与业务写在同一个事务里）→ 只发**一跳只读校验**
  //   `{action:'integrity'}`（1 次云函数往返；它与完整读取末期那一次是**同一个** `liveIntegrity`，
  //   五个指纹 checksum / byteSize / summary / counts / amounts 一个都不少、云函数零改动），
  //   拿它确认「云端此刻的 datasetId 未变、且 dataRevision 已经 ≥ 本命令提交后的那一版」。
  //
  //   · 确认通过 ⇒ 回 `{ok:true, confirmed:true, lightweight:true}`：**不翻分页、不写 cache**。
  //     本机 cache 仍停在旧 revision —— 这是**故意**的，不是漏更新：
  //     cache 的语义是「本机手里那一份**云端已验证过**的快照」。它一旦落后于云端，
  //     下一次任何读取都会经既有五项比对判出"不一致"并走**完整读取** ——
  //     也就是"完整数据读取只留给真正需要取得最新数据来展示的那一次"。
  //     内存态 revision 已在命令落地时更新（execute 里的 setState），所以下一条写命令不会 REVISION_UNKNOWN。
  //   · 确认不通过（revision 没到 / 数据集换了 / 云端报错 / 并发写入落进探针窗口）⇒
  //     **安全兜底：原样退回修前那次完整分页回读**（含它自带的有限重试），
  //     绝不假装成功、绝不改业务事实、绝不吞掉失败码。
  //   · 与 `refreshed` **严格分开**：`refreshed` 的含义仍然是「本机 cache 已经跟上了这一版」，
  //     它的消费者（readActive 的写后复用、预约协调器、同步引擎、课程页）都靠这个含义判断
  //     "能不能拿本机 cache 当云端事实"。轻量确认**绝不冒充** refreshed ——
  //     冒充会让页面拿着没更新的 cache 当最新数据去渲染（静默展示旧数据）。
  //
  // 重试边界与读取层同一条规矩：「世界在我读的时候动了」之外一律不重试。
  // 这里只对 `ACTIVE_READ_REVISION_CHANGED`（liveIntegrity 自己发现两次读之间 revision 变了）再试一次，
  // 而且**不加任何 sleep** —— 重试就是再发一跳只读校验。其余形状直接走安全兜底。
  const WRITE_CONFIRM_ATTEMPTS = 2
  async function confirmAfterWrite(requestedEnvironment, expectedRevision, queuedAt) {
    const fullRead = () => readActiveNow({ queuedAt, lane: 'write-refresh' })
    if (env() !== requestedEnvironment) return { ok: false, code: 'ENVIRONMENT_CHANGED' }
    // 拿不到「本命令提交后的 revision」就无从校验 ⇒ 直接走安全兜底（与修前逐字一致）。
    if (!Number.isInteger(expectedRevision)) return fullRead()
    // 「数据集身份」的基准也必须有：没有它就无法判"云端还是同一份数据集"，宁可不走快路。
    const expectedDatasetId = stateFor().datasetId
    if (!expectedDatasetId) return fullRead()
    const started = Date.now()
    let attempts = 0, calls = 0, callMs = 0, fallback = ''
    for (let attempt = 0; attempt < WRITE_CONFIRM_ATTEMPTS; attempt++) {
      if (env() !== requestedEnvironment) return { ok: false, code: 'ENVIRONMENT_CHANGED' }
      attempts = attempt + 1
      const callStarted = Date.now()
      calls++
      let probe = null
      try { probe = await callCloud('readMyActiveCoachData', { action: 'integrity', environment: requestedEnvironment }) }
      catch (error) { probe = null }
      callMs += Date.now() - callStarted
      // 并发写入正好落在探针的读取窗口里（云端自己两次读到的 revision 不一致）：
      // 这是**唯一**允许再试一次的形状，不睡任何时间，就是再发一跳只读校验。
      if (probe && probe.code === 'ACTIVE_READ_REVISION_CHANGED' && attempt + 1 < WRITE_CONFIRM_ATTEMPTS) continue
      if (!probe || !probe.ok) { fallback = String((probe && probe.code) || 'WRITE_CONFIRM_CALL_FAILED'); break }
      if (probe.datasetId !== expectedDatasetId) { fallback = 'WRITE_CONFIRM_DATASET_CHANGED'; break }
      if (!Number.isInteger(probe.dataRevision) || probe.dataRevision < expectedRevision) { fallback = 'WRITE_CONFIRM_REVISION_NOT_REACHED'; break }
      return {
        ok: true, confirmed: true, lightweight: true,
        environment: requestedEnvironment, datasetId: probe.datasetId, revision: probe.dataRevision,
        expectedRevision, checksum: probe.checksum, byteSize: probe.byteSize, summary: clone(probe.summary),
        confirmAttempts: attempts, confirmCalls: calls, confirmCallMs: callMs, confirmMs: Date.now() - started
      }
    }
    // 校验不通过 ⇒ 安全兜底：退回修前那次**完整分页回读**（含它自己的有限重试）。
    // 兜底结果原样沿用 refreshed / refreshFailed 的既有语义，一个字段都没改含义；
    // 只是多带三个只读的确认字段，让"这一轮到底走了哪条路、为什么"可被账本看到。
    const result = await fullRead()
    return { ...(result || { ok: false, code: 'WRITE_CONFIRM_FALLBACK_FAILED' }), confirmFallback: fallback || 'WRITE_CONFIRM_FAILED', confirmAttempts: attempts, confirmCalls: calls }
  }
  async function execute(command, payload, options = {}) {
    const commandEnvironment=env()
    const started = Date.now()
    if (!COMMANDS.includes(command)) return { ok: false, code: 'COMMAND_NOT_ALLOWED' }
    if (!isOnline()) return { ok: false, code: 'OFFLINE_READ_ONLY' }
    // ★ 关键：expectedRevision 必须在**航位内**现读现用。
    //   在航位外读（= 在等待队列期间读）等于什么都没修 —— 读到的仍然是上一条命令写回之前的旧值。
    //   显式传入的 options.expectedRevision 保持原样（completion-resume 的"安全续跑"就是靠它
    //   把 revision 钉在诊断基线上的，绝不能替它改成现值）。
    // ★ 回读也在航位内：`readActive` 的一致性窗口是「metadata → 八集合分页 → integrity」，
    //   任何写入落进这个窗口都会让它整体失败。让**客户端自己的下一条写命令**去撞这个窗口，
    //   纯属自伤 —— 真机上表现为「课程已完成，正在同步 / 训练内容没有在云端确认保存」这类假警报。
    //   放进航位后，不变量变得干净：**同一时刻只有一条写命令 + 它的完整回读在跑**。
    const task = serialize(commandEnvironment, async () => {
      if(env()!==commandEnvironment)return {ok:false,code:'ENVIRONMENT_CHANGED'}
      const state = stateFor(), rawRequestId = options.requestId || requestId()
      // ★ 出网前唯一的 requestId 闸门：非法号 ⇒ 用它的**确定性别名**出网（盘上的原号一动不动）。
      //   归一化不了（非字符串且无法派生）⇒ fail closed，绝不出网 —— 发出去也只是被云端拒收。
      const id = requestIdRule.wireRequestId(rawRequestId)
      if (!id) return { ok: false, code: 'INVALID_REQUEST_ID', requestId: null, originalRequestId: String(rawRequestId || ''), message: '请求编号不符合云端契约，本次没有发送。' }
      const revision = options.expectedRevision == null ? state.revision : options.expectedRevision
      if (!Number.isInteger(revision)) return { ok: false, code: 'REVISION_UNKNOWN' }
      let result
      try {
        result = await callCloud('coachBusinessCommand', { action: 'execute', environment: commandEnvironment, envelope: { command, requestId: id, expectedRevision: revision, payload: clone(payload) } })
      } catch (networkError) {
        // 手机没收到 execute 回答时，只查同一个 requestId 的回执。云端可能刚提交、
        // 第一次查单尚未可见；短暂重查可以收敛结果，但绝不重发业务命令。
        let receipt, receiptError
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await new Promise(resolve => setTimeout(resolve, attempt === 1 ? 250 : 600))
          try { receipt = await callCloud('coachBusinessCommand', { action: 'getReceipt', environment: commandEnvironment, requestId: id }); receiptError = null }
          catch (error) { receipt = null; receiptError = error }
          if (receipt && receipt.ok && receipt.found && (receipt.status === 'succeeded' || receipt.status === 'failed')) break
        }
        if (receipt && receipt.ok && receipt.found && receipt.status === 'succeeded') result = { ...receipt.response, recoveredFromReceipt: true }
        else if (receipt && receipt.ok && receipt.found && receipt.status === 'failed') return receipt.response || { ok: false, code: 'COMMAND_FAILED' }
        else if (receipt && receipt.ok && receipt.found && receipt.status === 'processing') return { ok: false, code: 'REQUEST_PROCESSING', requestId: id, retrySafe: true }
        else return { ...transportFailure(receiptError || networkError), requestId: id, retrySafe: true, originalTechnicalMessage: String(networkError && (networkError.errMsg || networkError.message || networkError.code) || '').slice(0,300) }
      }
      const commandMs = Date.now() - started
      if (!result.ok) return result
      // 命令一落地就把新 revision 写回内存态 —— 这之后才算"上一条命令已了结"。
      if(env()!==commandEnvironment)return {...result,refreshFailed:{ok:false,code:'ENVIRONMENT_CHANGED'}}
      if (Number.isInteger(result.datasetRevision)) setState({ ...state, revision: result.datasetRevision })
      // 回读**绝不能抛出去**：命令已经在云端提交成功（receipt 与业务写在同一个事务里），
      // 回读失败只说明"本机 cache 还没跟上"，把它当成异常抛给调用方，就会被理解成「命令结果未知」——
      // 那是在用本机的同步进度去否定云端已经发生的事实。
      // ★ 1.1.9 第 6 轮：这一次**不再是**无条件的完整分页回读，而是 confirmAfterWrite ——
      //   一跳只读校验确认云端已处于本命令提交后的 revision；校验不过才退回完整分页回读（安全兜底）。
      //   见 confirmAfterWrite 上方的长注释（为什么这样仍然安全、以及 refreshed 与 confirmed 的分工）。
      let refreshed
      try { refreshed = await confirmAfterWrite(commandEnvironment, result.datasetRevision, Date.now()) }
      catch (error) { refreshed = { ok: false, code: 'REFRESH_THREW', message: String(error && error.message) } }
      const lightweight = !!(refreshed && refreshed.ok && refreshed.lightweight)
      onTiming({
        action: 'execute', command, commandMs, refreshMs: Date.now() - started - commandMs, totalMs: Date.now() - started,
        confirmMode: lightweight ? 'lightweight' : 'full-read',
        confirmRevision: refreshed && Number.isInteger(refreshed.revision) ? refreshed.revision : null,
        confirmMs: refreshed && Number.isFinite(Number(refreshed.confirmMs)) ? Number(refreshed.confirmMs) : null,
        confirmFallback: refreshed && refreshed.confirmFallback ? String(refreshed.confirmFallback) : null
      })
      // 轻量确认成功 = 云端已被确认、但本机 cache 还没跟上：**绝不冒充 refreshed**（含义不同，见上）。
      if (lightweight) return { ...result, confirmed: refreshed }
      return refreshed.ok ? { ...result, refreshed } : { ...result, refreshFailed: refreshed }
    })
    writes.set(commandEnvironment, task)
    task.then(() => { if (writes.get(commandEnvironment) === task) writes.delete(commandEnvironment) }, () => { if (writes.get(commandEnvironment) === task) writes.delete(commandEnvironment) })
    return task
  }
  // ★ 查回执与发送**必须同一套号**：云端 core.js:260 的 getReceipt 也要过 validateRequestId，
  //   非法号在这里同样被拒 —— 那正是真机「查回执失败 2 次」的真身（不是网络问题，是号本身不合法）。
  //   注意查回执**不能**自己悄悄换号：号必须与 execute 时用的别名逐字相同，否则查的就是另一条请求。
  async function getReceipt(id) {
    if (!isOnline()) return { ok: false, code: 'OFFLINE_READ_ONLY' }
    const wireId = requestIdRule.wireRequestId(id)
    if (!wireId) return { ok: false, code: 'INVALID_REQUEST_ID', message: '请求编号不符合云端契约，无法查询回执。' }
    try { return await callCloud('coachBusinessCommand', { action: 'getReceipt', environment: env(), requestId: wireId }) }
    catch (error) {
      // 原因必须留下：否则「查询失败」与「云端明确说没受理过」在日志里长得一模一样（§108 的教训）。
      return { ok: false, code: 'RECEIPT_RESULT_UNKNOWN', technicalMessage: String(error && (error.errMsg || error.message || error.code) || '').slice(0, 300) }
    }
  }
  function saveRecovery(snapshot, metadata) { storage.set(RECOVERY_KEY, { createdAt: Date.now(), datasetId: metadata.datasetId, revision: metadata.revision, checksum: metadata.checksum, byteSize: metadata.byteSize, summary: clone(metadata.summary), headVersion: metadata.headVersion, snapshot: clone(snapshot) }) }
  return { readActive, execute, getReceipt, saveRecovery, getState: () => clone(stateFor()), resetState: value => states.delete(value || env()), CACHE_KEY, RECOVERY_KEY, COMMANDS }
}

// `base64Bytes` / `join` / `utf8` 一并导出：一次性修复页要用**同一套解码口径**读原始行
// （备份/比对必须与正式读路径逐字节一致，绝不能各写一份解码器）。
module.exports = { createAdapter, COMMANDS, CACHE_KEY, RECOVERY_KEY, ROWS_KEY, SANDBOX_ROWS_KEY, MIRROR_NAMES, base64Bytes, join, utf8 }
