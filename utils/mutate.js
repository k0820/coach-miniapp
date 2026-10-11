// 统一业务写入口（阶段 2：Local-first + Cloud Sync）。
//
// 页面/组件**只调用 mutate()**，永远不自己决定「写本地还是写云端」，也不知道：
//   · 云端有没有回来   · revision 是多少   · receipt 在哪里
//   · 要不要 full readActive   · 有没有 pending intent
// 这些全部由「本机业务事务（local-transaction）」+「持久 Outbox（local-outbox）」+
// 「后台同步引擎（sync-engine）」处理。
//
// —— 阶段 2 写链 ——
//   页面 → mutate(command,payload)
//        → 本机业务事务（**复用云端那同一份 handlers**）→ 立刻出结果
//        → 写入持久 Outbox（稳定 requestId + payloadHash + 本机临时 id）
//        → 第一帧：getDB() 的投影里已经包含这条事实（local-projection）
//        → 返回给页面（ok / 还是同一个业务错误码）
//        → 后台：sync-engine → adapter.execute → coachBusinessCommand
//                → receipt / 幂等 / 单事务 / 原子回读 → 转正本机临时 id
//
// —— 命令分类（22 条，一处一清）——
//   LOCAL_FIRST（14）：交互高频、且本机可以**逐字复算**的业务写 —— 本机立即生效 + 后台同步
//   OPTIMISTIC（1）  ：cancelBooking —— 由既有「本机视觉协调器」负责（第 29–32 节，真机 PASSED）。
//                      阶段 2 **不重新设计**，页面接口不变
//   CLOUD_FIRST（7） ：既有学员/课时包/课程销售的单独操作仍由云端先行。
//
// ⚠️ createBooking 曾经属于 OPTIMISTIC（2 条），1.1.5 真机把它挪进了 LOCAL_FIRST（1.1.6）。
//    原因不是"协调器不好"，而是**它是一条独立于 Outbox 的第二套同步链**：
//    自己一套 pending 存储、自己一个 requestId 序号、自己一套 receipt 处理与退避。
//    于是同一次「点确认预约」，学员新增走本机先行（秒进、静默收敛），预约却走协调器的
//    「前台写 pending + 后台单独 confirm」—— 后台那条 confirm 一旦拿到
//    COMMAND_RESULT_UNKNOWN / REQUEST_PROCESSING（云端慢、断连、response 丢失），
//    settle() 就会当场弹「结果待确认 · 云端调用中断，这条预约正在确认中」。
//    真机上表现为：无论新学员还是老学员，新建预约必定被这句话打扰一次。
//    挪进 LOCAL_FIRST 后，预约与学员走**同一条**链：
//      本机业务事务（复用云端同一份 handlers）→ 持久 Outbox（稳定 requestId）
//      → sync-engine 按序发送 → 失败自动退避重试 → 只有**明确业务拒绝**才提示一次。
//    前台不再有任何"等待云端结果"的分支，也就没有"待确认"这个状态可以画到屏幕上。
//    cancelBooking 维持 OPTIMISTIC 不变：取消的难点是「create 还在飞时就被取消」的排序，
//    协调器的 tombstone 已经真机 PASSED，本轮刻意不动。
//                      新增学员表单的一次保存是受限例外：先整体校验，再把 createStudent
//                      与 createCourseSale/createPackage 原子记入本机 Outbox，后台按序转正。
//                      「钱与长期身份」的实体 id 会被
//                      booking.packageId / incomes / 页面状态长期引用。本机临时 id 转正会让这些 id
//                      静默变一次（第 33–36 节踩过同族坑），所以刻意留在云端先行：
//                      云端当最终裁判；新表单的本机即时反馈不等于云端最终确认。
// 开关：LOCAL_FIRST_ENABLED 置 false 即整体回退到「全部云端先行」，页面一行都不用改。
const ui = require('./ui-cloud-command')
const runtime = require('./data-runtime')
const outbox = require('./local-outbox')
const localTransaction = require('./local-transaction')
const projection = require('./local-projection')
const syncEngine = require('./sync-engine')
const { hashCommand } = require('./cloud-command-engine')
// ★ §110：requestId 的唯一契约。生成端也过它，是为了让**新命令从出生就合法** ——
//   出网端的闸门只是兜底，真正的修复是别再产非法号（否则每一条都要靠别名救一次）。

const VIA = 'mutate'
const PATHS = Object.freeze({ CLOUD: 'cloud', LOCAL: 'local', LOCAL_FIRST: 'local-first' })
const MODES = Object.freeze({
  CLOUD_PRIMARY: 'cloud-primary',
  LOCAL_PRIMARY: 'local-primary',
  LOCAL_FIRST: 'local-first'
})
const STRATEGIES = Object.freeze({
  COMMAND: 'command',
  SILENT: 'silent',
  RAW: 'raw',
  OPTIMISTIC: 'optimistic',
  LOCAL_FIRST: 'local-first'
})

// ★ 阶段 2 总开关（回退开关）。置 false → 全部命令回到云端先行，行为与阶段 1 一致。
const LOCAL_FIRST_ENABLED = true

// 业务命令清单 —— 必须与 utils/cloud-command-contract.js 的 COMMANDS 逐条一致（永久测试钉住）。
const COMMANDS = Object.freeze([
  'createStudent', 'updateStudent', 'deleteStudent',
  'createPackage', 'createCourseSale', 'updateCourseSale', 'reverseCourseSale',
  'updatePackage', 'deletePackage',
  'createBooking', 'setPackageShare', 'createSharedBooking', 'createAuthorizedBooking', 'updateBookingContent', 'rescheduleBooking', 'cancelBooking', 'completeBooking', 'deleteCompletedBooking', 'markBookingNotHeld',
  'createManualSale', 'updateManualSale', 'deleteManualSale', 'saveSettings',
  'createCustomExercise', 'updateCustomExercise', 'deleteCustomExercise',
  // M2 V1：双层授权（云端先行，理由见 CLOUD_FIRST_COMMANDS 注释）。
  'grantMemberService', 'revokeMemberService', 'grantPackageTeaching', 'revokePackageTeaching', 'transferPackageManagement'
])

// 本机先行的 14 条。
// ⚠️ updateStudent / deleteStudent 划进本机先行，是为了「新增 → 立即编辑 → 立即删除」这条链：
//   新增走后 saveStudentBatch（本机原子批次），此时学员只有本机临时 id（loc_ 前缀），
//   紧接着的改/删只能在本机完成 —— 退回云端先行会拿一个云端不认识的目标 id 出去，
//   或者干脆被「最新数据没读到」挡在出网之前（真机故障）。见 dispatchLocalFirst 的首个守卫。
// ⚠️ createBooking 见文件头：它原先由「本机视觉协调器」负责，那是一条独立于 Outbox 的同步链，
//   后台 confirm 拿到"结果未知"就当场弹「结果待确认」（1.1.5 真机）。挪到这里与学员同一条链。
const LOCAL_FIRST_COMMANDS = Object.freeze([
  'createBooking',
  'updateStudent', 'deleteStudent',
  'updateBookingContent', 'rescheduleBooking', 'completeBooking', 'deleteCompletedBooking', 'markBookingNotHeld',
  'createManualSale', 'updateManualSale', 'deleteManualSale', 'saveSettings',
  'createCustomExercise', 'updateCustomExercise', 'deleteCustomExercise'
])

// 仍然云端先行的 7 条（理由见文件头）。
// ⚠️ createStudent 留在云端先行是**有意的**：单独的 createStudent 没有本机批次身份，
//   无法保证「新学员 + 课时包 + 销售」在同一次意图里原子落本机；页面新增走的是
//   createStudentWithPackages（本机原子批次），不经过这里。它保留在云端先行只是
//   给"非页面入口、只有学员没有包"的旧调用留一条仍可用的路。
// ⚠️ M2 第二批：共享预约**必须云端先行** —— 理由不是偏好，是物理限制：
//   共享课时包的 remaining / reserved 存在**另一位教练**的数据集里，本机根本没有那一份真值，
//   本机先行就等于拿假数据记账（"界面显示约上了，云端说没名额"）。
//   所以两条共享命令都放这里，由云端用同一份 handlers 裁决。
const CLOUD_FIRST_COMMANDS = Object.freeze([
  'createStudent',
  'createPackage', 'createCourseSale', 'updateCourseSale', 'reverseCourseSale',
  'updatePackage', 'deletePackage',
  'setPackageShare', 'createSharedBooking',
  // M2 V1 双层授权：**必须云端先行**。授权表不在八个业务集合里（本机根本没有），
  //   且授权判定要读对端账本的真实 remaining/reserved ⇒ 本机先行就是拿假数据记账。
  'createAuthorizedBooking',
  'grantMemberService', 'revokeMemberService', 'grantPackageTeaching', 'revokePackageTeaching', 'transferPackageManagement'
])

// 由既有「本机视觉协调」负责的（仅剩取消 1 条）。
// ⚠️ 这张表是**封闭**的：把某条命令放进来，就等于让它绕开 Outbox 走协调器自己那条链
//   （前台写 pending → 后台单独 confirm → "结果未知"时弹「结果待确认」）。
//   只有「目标 id 还没转正就要发起」的取消才需要这种排序能力，别的命令没有理由进来。
const OPTIMISTIC_COMMANDS = Object.freeze({ cancelBooking: 'cancel' })

// 命令 → 必须携带的业务目标 id 字段。空值 + 给了 ref 时：本次**不在本机投影**（视觉由既有
// intent 机制兜底），但照样入队 —— 等目标在云端转正后由同步引擎按 ref 补上正式 id 再送。
const TARGET_FIELD = Object.freeze({
  updateBookingContent: 'bookingId',
  rescheduleBooking: 'bookingId',
  completeBooking: 'bookingId',
  deleteCompletedBooking: 'bookingId',
  cancelBooking: 'bookingId',
  markBookingNotHeld: 'bookingId',
  updateCustomExercise: 'customExerciseId',
  deleteCustomExercise: 'customExerciseId',
  updateManualSale: 'saleId',
  deleteManualSale: 'saleId'
})

// ★ 1.1.9 第 6 轮：「本机事务拒绝」里唯一一种**不能当成业务事实**的错误码。
//
// 语境：写命令成功之后不再立刻补齐本机 cache（只做一跳只读校验），于是「刚建完 / 刚确认完、
//   cache 还没跟上」这段时间里，本机投影（cache + 队列意图）里**没有**这条目标记录 ——
//   而云端**有**（预约协调器 confirm 成功时就把正式 id 绑好交给页面了）。
//   此时本机事务会以 BOOKING_NOT_FOUND 拒绝，可这句话是**本机的落后**说的，
//   不是说云端没有。直接把它交给用户 ＝ 说一句假话（"预约不存在"，可它明明在），
//   也正是既有原则里明令禁止的那件事：「用本机的同步进度去否定云端已经发生的事实」。
//
// 处置：退回云端先行，让云端拿自己的数据裁决（云端说没有，才是真的没有）。
// ⚠️ 这张表**只收已证实的形状**，不要顺手把别的 NOT_FOUND 也塞进来：
//   每一类都可能有一条"本机临时 id 不该出网"的独立边界，得逐类单独验证过才能进。
//
//   ★ M2 第二批新增 `SHARED_PACKAGE_NOT_LOCAL`，形状已逐项核实：
//     ① 它说的不是"这条预约不存在" —— 预约**在**本机投影里（云端读回来的），
//        只是它花的课时包在**另一位教练**的数据集里，本机没有那份 remaining / reserved；
//     ② 出网目标 `bookingId` 是**正式 id**（共享预约只能由云端先行创建，不可能有 loc_ 临时 id）；
//     ③ 云端拿同一份 handlers 一定能裁决（那边看得到课时包）⇒ 交给云端说"行/不行"才是对的做法。
//     反过来看，若把它当成业务结论直接告诉用户"不能取消 / 不能下课"，又是一句**本机落后造成的假话**。
const LOCAL_TARGET_MISSING = new Set(['BOOKING_NOT_FOUND', 'SHARED_PACKAGE_NOT_LOCAL'])

// —— 写入审计：每一次真正派发（云端 / 本机 / 本机先行）都会记一笔 ——
// 这是永久测试的证据来源：云端真的收到了什么命令，就必须在这里有对应记录（否则就是绕开统一入口）。
const auditLog = []
function record(entry) {
  auditLog.push({ at: Date.now(), ...entry })
  if (auditLog.length > 500) auditLog.shift()
}

function isCloudPath() { return ui.isCloudPrimary() }
function dataSourceMode() {
  if (isCloudPath()) return LOCAL_FIRST_ENABLED ? MODES.LOCAL_FIRST : MODES.CLOUD_PRIMARY
  return MODES.LOCAL_PRIMARY
}
function executionPath() { return isCloudPath() ? PATHS.CLOUD : PATHS.LOCAL }
const isLocalFirstCommand = command => LOCAL_FIRST_COMMANDS.includes(command)
// 命令分类**优先于**页面的 strategy 提示：页面不该再关心"该走遮罩通道还是静默通道"。
// 唯一例外是 RAW（安全续跑用的直通策略，语义必须逐字保留）。
function strategyFor(command, options) {
  if (options && options.strategy === STRATEGIES.RAW) return STRATEGIES.RAW
  if (command && OPTIMISTIC_COMMANDS[command]) return STRATEGIES.OPTIMISTIC
  if (LOCAL_FIRST_ENABLED && command && isLocalFirstCommand(command)) return STRATEGIES.LOCAL_FIRST
  if (options && options.strategy) return options.strategy
  return STRATEGIES.COMMAND
}
// 前置校验只属于「云端先行」路径：本机先行路径的前置条件由本机业务事务自己判（同一个错误码）。
function preconditionFailure(value) {
  if (!value) return null
  if (typeof value === 'string') { wx.showToast({ title: value, icon: 'none' }); return { ok: false, code: 'PRECONDITION_FAILED', message: value } }
  if (value.modal) { wx.showModal({ ...value.modal }); return { ok: false, code: 'PRECONDITION_BLOCKED' } }
  if (value.toast) { wx.showToast({ title: value.toast, icon: 'none' }); return { ok: false, code: 'PRECONDITION_FAILED', message: value.toast } }
  return null
}

// 守卫窗口的开合。测试会以「只替换云端实现」的方式注入假 ui-cloud-command（其中不含守卫对象），
// 那种情况下本就不存在绕过问题，因此缺守卫时静默跳过即可 —— 生产实现永远带守卫。
function openWriteFunnel() {
  const gate = ui.__writeFunnel
  if (!gate) return false
  gate.enter()
  return true
}
function closeWriteFunnel(opened) {
  if (opened) ui.__writeFunnel.exit()
}

async function dispatchCloud(command, payload, options, strategy) {
  if (strategy === STRATEGIES.OPTIMISTIC) return dispatchOptimistic(command, payload, options)
  if (strategy === STRATEGIES.RAW) return ui.adapter.execute(command, payload, options.rawOptions || {})
  // 走统一入口的云端写命令必须在守卫窗口内：ui-cloud-command 的写入口只在 mutate 打开窗口时放行。
  const opened = openWriteFunnel()
  try {
    if (strategy === STRATEGIES.SILENT) {
      return await ui.runCommandSilent({ key: options.key, command, payload, requestId: options.requestId, onSuccess: options.onSuccess, onRefresh: options.onRefresh, showLoading: options.showLoading })
    }
    return await ui.runCommand({ key: options.key, command, payload, requestId: options.requestId, successTitle: options.successTitle, onSuccess: options.onSuccess, onRefresh: options.onRefresh })
  } finally { closeWriteFunnel(opened) }
}

// 取消：即时响应由既有「本机视觉协调器」负责（第 29–32 节，真机 PASSED）。
// 阶段 2 唯一新加的是**断网降级**：协调器在离线时的语义是「只读」硬拒绝，
// 而阶段 2 要求断网也能正常录课。于是离线时改由本机先行队列承接（本机立刻生效 + 持久排队，
// 联网后自动补发）；联网路径一个字都没改。
//
// ⚠️ createBooking 已挪进 LOCAL_FIRST（见文件头），这条分支不再经手预约。
//    留着 `ui.submitBooking` 的老分支只会让人以为预约还能从这儿走，
//    所以这里**只处理取消**；预约的唯一入口就是 dispatchLocalFirst。
async function dispatchOptimistic(command, payload, options) {
  const result = await ui.cancelBookingRequest(payload)
  if (result && result.ok) return result
  const code = (result && result.code) || ''
  // 取消的本机先行降级需要一个正式 bookingId：正式 id 还没转正（ref 只有本机键）时不能退，
  // 退回去就是拿一个空目标 id 发给云端 —— 宁可如实失败。
  const bookingId = (payload && (payload.officialId || (payload.booking && payload.booking.id))) || ''
  if ((code === 'OFFLINE_READ_ONLY' || code === 'CLOUD_DATASET_UNKNOWN') && (!TARGET_FIELD[command] || bookingId)) {
    const fallback = await dispatchLocalFirst(command, { bookingId }, options)
    if (fallback && fallback.ok) return { ...fallback, offlineFallback: true }
  }
  return result
}

// 本机当前可写的数据集（环境 + datasetId + 云端已确认的快照）。三者缺一，就不敢本机先行。
function coachScope() {
  // 测试替身常常只实现 getDB/saveDB 那一小块（第 37 节的教训）：**缺成员时必须静默降级**回云端先行，
  // 而不是抛 TypeError —— 那会把失败信息指到一个和业务毫无关系的地方（"runtime.mode is not a function"
  // 完全看不出是哪条业务命令出的问题）。生产实现永远带全这些成员。
  if (typeof runtime.mode !== 'function' || typeof runtime.cacheKey !== 'function' || typeof runtime.environment !== 'function') return null
  if (!runtime.MODES || runtime.mode() !== runtime.MODES.CLOUD) return null
  const cache = wx.getStorageSync(runtime.cacheKey())
  if (!cache || !cache.datasetId || !cache.snapshot || !Array.isArray(cache.snapshot.students)) return null
  const environment = runtime.environment()
  const cachedSandbox = cache.environment === 'sandbox'
  // 环境隔离：cache 里记的环境必须与当前环境一致（Sandbox 绝不能写进 Production 的队列）。
  if (environment === 'sandbox' ? !cachedSandbox : cachedSandbox) return null
  return { environment, datasetId: cache.datasetId, base: cache.snapshot, revision: cache.revision }
}

let requestSequence = 0
function generatedRequestId(command) {
  requestSequence += 1
  return `${command}_${Date.now().toString(36)}_${requestSequence.toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
// requestId 必须**稳定持久化**：一旦入队就不再变化，杀进程重开也还是同一个号。
// 幂等要求高的命令（完课 / 删除已完成课程）直接用「业务事实」当号 —— 同一条事实无论点几次、
// 无论在哪台设备，都是同一个号，云端 receipt 会把它认成同一次请求。
// 身份优先级：正式 bookingId > 本机引用（ref.localKey）—— 待确认预约还没转正时，
// 本机引用就是这条业务事实唯一稳定的身份，绝不能因为"暂时没有正式 id"而退化成随机号（那等于放弃幂等）。
function factRequestId(command, body, options) {
  if (command !== 'completeBooking' && command !== 'deleteCompletedBooking') return ''
  const ref = (options && options.ref) || null
  const identity = (body && body.bookingId) || (ref && ref.localKey) || ''
  // ★ §110：identity 可能是 `pending:<bookingKey>`，而 bookingKey 用 `|` 分隔
  //   （studentId|packageId|date|hour|minute）⇒ 直接拼出来的号云端必然拒收。
  //   所以这里也必须过契约：得到的是「原业务身份的确定性别名」，同一条业务事实永远同一号。
  return identity ? `${command}:${identity}` : ''
}
function stableRequestId(command, body, options, generated) {
  // 调用方显式给的号（页面/草稿协调器）同样必须过契约 —— 否则上游拼错一个字符就会一路带到云端。
  if (typeof options.requestId === 'string' && options.requestId) return options.requestId
  return factRequestId(command, body, options) || generatedRequestId(command)
}
function entityKeyFor(command, body, generated) {
  if (body.bookingId) return `booking:${body.bookingId}`
  if (body.customExerciseId) return `exercise:${body.customExerciseId}`
  if (body.saleId) return `sale:${body.saleId}`
  // 学员的改 / 删也必须带上实体身份：删完再建、或建完立刻删，都靠它认出「这是同一个实体」。
  // 少了这一条，队列里只能看到一个裸命令名，实体级的顺序与收敛都没法追踪。
  if (body.studentId) return `student:${body.studentId}`
  if (generated.student) return `student:${generated.student}`
  if (generated.booking) return `booking:${generated.booking}`
  if (generated.exercise) return `exercise:${generated.exercise}`
  if (generated.sale) return `sale:${generated.sale}`
  return command
}

// —— 本机先行 ——
// 「这条新预约要用的时段，本机是否还有一条**尚未落云**的取消占着？」
//
// 是 ⇒ 返回那条取消的 localKey，由 Outbox 记在条目上，sync-engine 据此排序（先让取消落云，再发这条）。
// 为什么必须在本机解决：`11:00 约 A → 取消 A → 立刻 11:00 约 B` 时，B 若抢在 A 的取消之前出网，
// 云端那边 A 还在 ⇒ B 被 `BOOKING_TIME_CONFLICT` **明确拒绝**，而这条拒绝会被归档成"业务失败"，
// 用户得再点一次。那不是业务冲突，是**排序问题** —— 拿用户的重试来兜是错的。
// 判据与冲突判定同口径（60 分钟一节课、按分钟区间重叠），且只认「尚未落云」的取消
// （`syncing` 表示云端已确认删掉 ⇒ 不挡，绝不白等）。
function pendingCancelBefore(scope, bookingLike) {
  try {
    const cancellation = require('./pending-cancellation')
    const rows = cancellation.slotRows(scope.environment, scope.datasetId, bookingLike).filter(cancellation.unresolved)
    return rows.length ? String(rows[0].localKey || '') : ''
  } catch (error) { return '' }
}

async function dispatchLocalFirst(command, body, options) {
  const scope = coachScope()
  if (!scope) {
    if ((command === 'updateStudent' || command === 'deleteStudent') && localTransaction.isLocalId(body.studentId)) return { ok: false, code: 'LOCAL_FIRST_UNAVAILABLE', message: '本机正式数据尚未就绪，本次没有提交。', path: PATHS.LOCAL_FIRST, local: true }
    // ★ 依赖「本机引用」的命令（正式目标 id 还没转正，只能靠 ref 认身份）**绝不能**退回云端先行：
    //   退回去就是把**空的目标 id 当成正式目标**发出去 —— 要么在云端留下一条谁也不认识的孤儿记录，
    //   要么就是「还没转正就离页，内容却被当成正式内容提交」。
    //   这条路没有"更好的降级"，只有"明确不发"：宁可如实失败，也绝不发出一条身份不明的写命令。
    const refField = TARGET_FIELD[command]
    if (options.ref && refField && !body[refField]) {
      record({ command, strategy: STRATEGIES.LOCAL_FIRST, path: PATHS.LOCAL_FIRST, key: options.key || '', fallback: 'LOCAL_FIRST_REQUIRED_FOR_REF' })
      return { ok: false, code: 'LOCAL_FIRST_UNAVAILABLE', message: '本机数据集尚未就绪，这条命令必须本机先行（目标还没有正式 id），本次没有提交。', path: PATHS.LOCAL_FIRST, local: true, requestId: '' }
    }
    // 本机数据集还没就绪（cache 缺快照 / 环境不符）：退回云端先行，**并在审计里留痕**，
    // 绝不假装"已经本机先行"。这是退化路径，不是正常路径。
    const hint = options.strategy
    const fallback = hint === STRATEGIES.SILENT ? STRATEGIES.SILENT : STRATEGIES.COMMAND
    record({ command, strategy: STRATEGIES.LOCAL_FIRST, path: PATHS.CLOUD, key: options.key || '', fallback: 'LOCAL_FIRST_UNAVAILABLE' })
    return dispatchCloud(command, body, options, fallback)
  }
  const now = Date.now()
  const generated = {}
  const rewrite = localTransaction.rewriteIds(body, outbox.idMap(scope))
  // 同一时段「刚取消、还要立刻重约」时，这条新预约必须排在那条取消后面出网（见 pendingCancelBefore）。
  const afterCancelKey = command === 'createBooking' ? pendingCancelBefore(scope, rewrite) : ''
  // ★ 先按「业务事实号」去重，**再**跑业务（第 2 道防重复保险的客户端那一半）。
  //   连点两次下课：第二次如果直接去跑本机事务，会撞上"投影里这节课已经 done"而返回
  //   「已完成」错误 —— 同一个动作得到两种结果，用户看到的第一次成功、第二次报错。
  //   同一条业务事实就该得到同一个答案：直接返回队列里那一条，**连业务都不跑**。
  //   （云端也有一模一样的守卫：receipt 命中同号就不执行 handlers。两端语义逐字对齐。）
  //   ⚠️ 去重**只看还没定论的条目**：明确失败过的号不算"这件事已经做过"（那条业务根本没成立），
  //      否则一次失败会变成永久失败。见 local-outbox.entryByRequestId 的注释。
  const isFactCommand = command === 'completeBooking' || command === 'deleteCompletedBooking'
  const explicitId = typeof options.requestId === 'string' ? options.requestId : ''
  const factId = isFactCommand ? (explicitId || factRequestId(command, rewrite, options)) : ''
  if (factId) {
    const existing = outbox.entryByRequestId(scope, factId)
    if (existing) {
      projection.invalidate()
      record({ command, strategy: STRATEGIES.LOCAL_FIRST, path: PATHS.LOCAL_FIRST, key: options.key || '', requestId: existing.requestId, entryId: existing.entryId, duplicate: true })
      syncEngine.schedule()
      return {
        ok: true, via: VIA, path: PATHS.LOCAL_FIRST, local: true, duplicate: true,
        applied: existing.applied !== false, deferred: existing.applied === false,
        requestId: existing.requestId, entryId: existing.entryId, result: null, baseRevision: scope.revision
      }
    }
  }
  const targetField = TARGET_FIELD[command]
  let deferred = !!(options.ref && targetField && !rewrite[targetField])
  let applied = { ok: true, ids: {}, result: null }
  if (!deferred) {
    // ★ 本机事务的执行底座必须是**投影**（云端快照 + 队列里已有的本机意图），不能是裸快照：
    //   否则"先新建动作、紧接着改这个动作"会因为正式 id 还没转正而找不到目标。
    //   投影是只读派生，这里只借它算一次结果，state 永远由 base + 队列重算。
    const localBase = projection.project(scope.base, scope, scope.revision) || scope.base
    applied = localTransaction.applyCommand(localBase, command, rewrite, {
      now: () => now,
      id: kind => generated[kind] || (generated[kind] = localTransaction.newLocalId(kind))
    })
    if (!applied.ok) {
      // ★★ 1.1.9 第 6 轮：本机事务的拒绝有两种性质，混在一起就会对用户说假话 ——
      //   · 业务事实（状态非法 / 前置不满足 / 课时不足）：云端拿同一份 handlers 也一定拒绝。
      //     如实返回、绝不入队（入了也会被拒，还平白多一条失败归档）。
      //   · 本机缺目标（LOCAL_TARGET_MISSING）：本机投影里没有这条记录，**可云端有**。
      //     写命令成功之后不再立刻补齐本机 cache（只做一跳只读校验），
      //     「刚建完 / 刚确认完、cache 还没跟上」正是这个形状。
      //     它只说明**本机落后**，不是业务结论；直接交给用户就是一句假话
      //     （"预约不存在"，可它明明在），也正是既有原则里明令禁止的那件事：
      //     「用本机的同步进度去否定云端已经发生的事实」。
      //
      //   处置：走**既有的 `deferred` 语义** —— 本机算不出来就不在本机算，但**照常入队**，
      //   由同步引擎把它送到云端、按同一份 handlers 裁决。
      //   ⚠️ 为什么**不能**图省事直接改走云端先行（已实测踩过）：那条路绕开队列，
      //      会一并丢掉队列提供的幂等（同号重放）、乐观锁冲突的补版重试、失败归档与全局 FIFO；
      //      而且完课安全门正是靠「投影 = cache + 队列里的本机意图」才看得见刚录的动作，
      //      不入队就等于动作隐形（真机表现：约完课立刻录动作立刻下课 → 被安全门误拦）。
      //   边界：出网目标 id 必须已经是**正式 id**。本机临时 id（loc_ 前缀）拿出去必然是
      //      BOOKING_NOT_FOUND，白跑一次云写还留一条失败归档 ⇒ 那种形状保持既有行为：明确不发。
      const outboundField = TARGET_FIELD[command]
      const outboundId = outboundField ? rewrite[outboundField] : ''
      const targetIsUsable = !!outboundField && !!outboundId && !localTransaction.isLocalId(outboundId)
      if (LOCAL_TARGET_MISSING.has(applied.code) && targetIsUsable) {
        record({ command, strategy: STRATEGIES.LOCAL_FIRST, path: PATHS.LOCAL_FIRST, key: options.key || '', fallback: 'LOCAL_TARGET_MISSING' })
        applied = { ok: true, ids: {}, result: null }
        deferred = true
      } else {
        // 本机事务拒绝 = 云端也一定会拒绝（同一个 handlers、同一个错误码）：直接如实返回，不入队。
        record({ command, strategy: STRATEGIES.LOCAL_FIRST, path: PATHS.LOCAL_FIRST, key: options.key || '', rejected: applied.code })
        return { ok: false, code: applied.code, message: applied.message, extra: applied.extra, path: PATHS.LOCAL_FIRST, local: true, requestId: '' }
      }
    }
    Object.assign(generated, applied.ids || {})
  }
  let entry, created = true
  try {
    const queued = outbox.enqueue(scope, {
      command,
      payload: body,
      requestId: stableRequestId(command, body, options, generated),
      entityKey: entityKeyFor(command, rewrite, generated),
      coalesceKey: options.coalesceKey || null,
      ref: options.ref || null,
      afterCancelKey,
      localIds: generated,
      createdAt: now,
      applied: !deferred
    })
    entry = queued.entry
    created = queued.created
    // ★ 记下「预约业务键 → 本机临时 bookingId」：取消链手上只有业务键（学员+课时包+日期+时刻），
    //   而正式 id 存在 idMap 里、键是本机临时 id —— 条目一旦出队，这条反查线索就没了，
    //   可取消恰恰可能在那之后才被推进。见 local-outbox 的 `bookingKeyIndex` 注释。
    if (command === 'createBooking' && generated.booking) {
      try {
        const bookingKey = require('./pending-booking-request').bookingKey(rewrite)
        if (bookingKey) outbox.recordBookingKey(scope, bookingKey, generated.booking)
      } catch (error) {}
    }
  } catch (error) {
    return { ok: false, code: 'OUTBOX_WRITE_FAILED', message: `本机待同步队列写入失败：${error && error.message}`, path: PATHS.LOCAL_FIRST, local: true, requestId: '' }
  }
  projection.invalidate()
  record({ command, strategy: STRATEGIES.LOCAL_FIRST, path: PATHS.LOCAL_FIRST, key: options.key || '', requestId: entry.requestId, entryId: entry.entryId, entityKey: entry.entityKey, deferred, duplicate: !created })
  const response = {
    ok: true, via: VIA, path: PATHS.LOCAL_FIRST, local: true, applied: !deferred, deferred, duplicate: !created,
    requestId: entry.requestId, entryId: entry.entryId, result: applied.result || null, baseRevision: scope.revision
  }
  if (options.onSuccess) await options.onSuccess(response)
  if (options.successTitle) wx.showToast({ title: options.successTitle, icon: 'none' })
  syncEngine.schedule()
  return response
}

// New-student save is one local UI intent, but remains the existing two kinds
// of cloud command. Validate the complete chain against the shared handlers,
// then atomically persist its FIFO commands in one environment-scoped Outbox
// write. No Cloud call, receipt wait, or active-data read is on the UI path.
//
// ⚠️ 这条链**必须**同时覆盖「新增」和「新增失败后重试」两种入口。
//    真机故障（「姜来」）：第一次保存时课时包那几笔没成功 → 表单里 `form.id` 已经被写上，
//    用户再点一次保存，`!f.id` 不再成立 → 走到旧路径 → 课时包继续走云端先行的
//    createPackage / createCourseSale → 被 `readActive` 失败挡在出网之前，
//    于是报了「最新数据暂时没读到」。**同一个动作，只因为失败了第二次，就换了一套语义。**
//    所以这里把「学员资料 + 本次新填的课时包」当成**一个本机原子批次**，
//    新增与重试共用同一条实现：有 studentId 就跳过 createStudent，直接挂在它下面。
async function saveStudentBatch(input = {}) {
  if (require('./production-recovery-guard').blocksBusiness(runtime.environment())) return { ok: false, code: 'PRODUCTION_RECOVERY_READ_ONLY' }
  if (executionPath() !== PATHS.CLOUD || !LOCAL_FIRST_ENABLED) return { ok: false, code: 'LOCAL_FIRST_UNAVAILABLE' }
  const scope = coachScope()
  if (!scope) return { ok: false, code: 'LOCAL_FIRST_UNAVAILABLE', message: '本机正式数据尚未就绪，本次没有保存。' }
  const batchKey = String(input.batchKey || input.draftKey || '')
  if (!batchKey) return { ok: false, code: 'INVALID_PAYLOAD' }
  // ★ 本批的学员身份必须**先过一遍 idMap 转正**，再拿去跑本机事务。
  //
  //   真机故障（新增后立即编辑 / 删除）：页面在保存成功那一帧把**本机临时 id** 写进了表单
  //   （`form.id = loc_student_…`）。此后即便同步引擎已经把这个学员在云端转成了正式 id
  //   （`idMap: loc_student_… → student_srv1`，且已从队列里出队），表单里那一份**不会自己改**。
  //   于是下一次点保存，这里收到的 `studentId` 还是一个本机临时 id；
  //   而本机 base 里早就只有 `student_srv1` 了 —— `findStudent` 找不到 → `STUDENT_NOT_FOUND`
  //   → 名字改不动、学员删不掉，界面还停在编辑态。
  //
  //   `dispatchLocalFirst` 一直是对的：它在跑业务之前先做 `rewriteIds(body, outbox.idMap(scope))`。
  //   这条批次链当初漏了同一件事，于是两条路径对同一个身份给出了两种结果。
  //   这里补齐：身份解析**只做一次**（在构造 commands 之前），后续全部用解析后的值。
  //
  //   ⚠️ 只做「值完全等于一个已知本机 id」的替换（rewriteIds 的既定语义），绝不猜、绝不前缀匹配；
  //      没有映射时原样返回，与旧行为逐字一致 —— 尚未转正的新增学员不受任何影响。
  const studentId = String(localTransaction.rewriteIds(String(input.studentId || ''), outbox.idMap(scope)) || '')
  const student = { name: input.name, phone: input.phone || '' }
  const packages = Array.isArray(input.packages) ? input.packages : []
  const intentHash = hashCommand('saveStudentBatch', { studentId, student, packages })
  // 批次号里必须带上 studentId（重试时同一批仍是同一号），否则「新增」与「重试」会互相覆盖。
  const batchId = studentId ? `studentSave:${studentId}:${batchKey}` : `newStudent:${batchKey}`
  const prior = outbox.batchFor(scope, batchId)
  if (prior) {
    if (prior.intentHash !== intentHash) return { ok: false, code: 'REQUEST_ID_CONFLICT' }
    syncEngine.schedule()
    return { ok: true, local: true, path: PATHS.LOCAL_FIRST, duplicate: true, result: prior.result }
  }
  let shadow = projection.project(scope.base, scope, scope.revision) || scope.base
  const inputs = [], results = [], stamp = Date.now()
  // 已有学员：先落一次资料修改（本机先行命令），再挂课时包。
  // 新增学员：必须先 createStudent，后续命令的 payload 才拿得到正式（本机）id。
  const commands = studentId
    ? [{ command: 'updateStudent', payload: { studentId, ...student }, clientKey: 'student' }]
    : [{ command: 'createStudent', payload: student, clientKey: 'student' }]
  for (const item of packages) {
    if (!item || !['createCourseSale', 'createPackage'].includes(item.command) || !item.clientKey) return { ok: false, code: 'INVALID_PAYLOAD' }
    commands.push({ command: item.command, payload: item.payload, clientKey: String(item.clientKey) })
  }
  let resolvedStudentId = studentId
  for (const item of commands) {
    const payload = (item.command === 'createStudent' || item.command === 'updateStudent')
      ? item.payload
      : { ...item.payload, studentId: resolvedStudentId }
    const generated = {}
    const applied = localTransaction.applyCommand(shadow, item.command, payload, {
      now: () => stamp,
      id: kind => generated[kind] || (generated[kind] = localTransaction.newLocalId(kind))
    })
    if (!applied.ok) return { ok: false, code: applied.code, message: applied.message }
    shadow = applied.db
    if (item.command === 'createStudent') resolvedStudentId = applied.result.studentId
    else if (item.command !== 'updateStudent') results.push({ clientKey: item.clientKey, command: item.command, ...applied.result })
    inputs.push({ command: item.command, payload, requestId: `studentSave:${batchKey}:${item.clientKey}`,
      entityKey: `student:${resolvedStudentId}`, localIds: generated })
  }
  const result = { studentId: resolvedStudentId, packages: results }
  try { outbox.enqueueBatch(scope, batchId, inputs, result, intentHash) }
  catch (error) { return { ok: false, code: 'OUTBOX_WRITE_FAILED', message: error && error.message } }
  projection.invalidate()
  record({ command: 'saveStudentBatch', strategy: STRATEGIES.LOCAL_FIRST, path: PATHS.LOCAL_FIRST, key: batchId, requestIds: inputs.map(item => item.requestId) })
  syncEngine.schedule()
  return { ok: true, local: true, path: PATHS.LOCAL_FIRST, result }
}

// 兼容旧名：新增学员（无 studentId）只是 saveStudentBatch 的一个特例。
function createStudentWithPackages(input = {}) { return saveStudentBatch(input) }

// —— 本机临时 id → 云端正式 id 的「现读现用」解析 ——
//
// 为什么页面必须能自己问这一嘴：本机临时 id（loc_ 前缀）只在"这条事实还压在队列里"期间有效。
// 一旦同步引擎拿到云端正式 id 并记进 idMap，**投影立刻改用正式 id**
// （local-projection 的 id 回调：`map[localId] || localId`）。
// 而页面手里那份身份是当时从投影里抄下来的，它**不会自己改**：
//   · 学员页表单 form.id 停在 loc_student_…（第 55 节已在 saveStudentBatch 里补做转正）
//   · 课程页 this.id 停在 loc_booking_…（本节新增：预约也走本机先行之后才出现这个窗口）
// 后果不是"慢"，而是**页面当场失效**：课程页 load() 拿 loc_booking_… 去正式 cache 里找不到，
// pendingKey 又为空 → 判定"这条预约不存在" → navigateBack 把用户弹回课表。
// 所以凡是要拿身份去查投影 / 跑校验 / 发命令的地方，都必须先过这一嘴。
//
// 语义与 rewriteIds 逐字一致：只替换「值完全等于一个已知本机 id」的字符串，绝不猜、绝不前缀匹配；
// 没有映射时原样返回 —— 尚未转正的新事实不受任何影响。
function resolveLocalId(value) {
  if (!value || typeof value !== 'string' || !localTransaction.isLocalId(value)) return value
  const scope = coachScope()
  if (!scope) return value
  return localTransaction.rewriteIds(value, outbox.idMap(scope)) || value
}

// 本机临时 booking id → 稳定渲染 key。
// 课表用它把「本机 id 那一帧」与「正式 id 那一帧」认成同一条预约：
// viewKey 跨转正必须保持不变，否则小程序会销毁重建这个块（视觉上闪一下），
// 而 1.1.5 已经验收过的性质是「转正那一刻视觉零变化」。
function bookingViewKeys() {
  const scope = coachScope()
  if (!scope) return []
  const map = outbox.idMap(scope)
  const prefix = `${localTransaction.LOCAL_ID_PREFIX}booking_`
  return Object.keys(map)
    .filter(localId => localId.indexOf(prefix) === 0 && map[localId])
    .map(localId => ({ officialId: map[localId], localId, viewKey: `stable:${localId}` }))
}

// 唯一的业务写入口。
//   command / payload      业务命令与载荷（22 条白名单内）
//   options.key            单航班 / 幂等键（沿用今天的语义）
//   options.strategy       见 STRATEGIES；命令分类优先（见 strategyFor）
//   options.local          本机模式（未切云）下的既有本机实现；不给就什么都不做
//   options.precondition   仅云端先行路径的前置校验；返回字符串 → toast 并中止，返回 {modal} → 弹窗并中止
//   options.ref            目标实体还没转正时的本机引用（例如 {kind:'booking', localKey}）
async function mutate(command, payload, options = {}) {
  // 命令与载荷可以走参数，也可以写在 options 里（command / payload），两者等价。
  const resolved = typeof options.command === 'function' ? options.command() : (options.command || command)
  const body = options.payload !== undefined ? options.payload : (payload || {})
  const strategy = strategyFor(resolved, options)
  const local = typeof options.local === 'function' ? options.local : null
  if (require('./production-recovery-guard').blocksBusiness(require('./data-runtime').environment()))
    return { ok: false, code: 'PRODUCTION_RECOVERY_READ_ONLY', message: '正在只读核查真实课程，业务修改已暂停。' }
  if (executionPath() === PATHS.LOCAL) {
    record({ command: resolved || null, strategy, path: PATHS.LOCAL, key: options.key || '' })
    if (!local) return { ok: true, via: VIA, path: PATHS.LOCAL, local: true, skipped: true }
    const value = await local()
    return { ok: true, via: VIA, path: PATHS.LOCAL, local: true, value }
  }
  const blocked = preconditionFailure(typeof options.precondition === 'function' ? options.precondition() : null)
  if (blocked) return blocked
  if (!COMMANDS.includes(resolved)) return { ok: false, code: 'COMMAND_NOT_ALLOWED', message: `mutate 白名单外的命令：${resolved}` }
  if (strategy === STRATEGIES.LOCAL_FIRST) return dispatchLocalFirst(resolved, body, options)
  record({ command: resolved, strategy, path: PATHS.CLOUD, key: options.key || '' })
  return dispatchCloud(resolved, body, options, strategy)
}

// 安全续跑专用的直通策略：语义与今天 `adapter.execute` 逐字相同（不遮罩、不弹窗、原样返回）。
// 仍然算「经由统一入口」，所以同样写进审计。
async function raw(command, payload, options = {}) {
  if (require('./production-recovery-guard').blocksBusiness(require('./data-runtime').environment()))
    return { ok: false, code: 'PRODUCTION_RECOVERY_READ_ONLY', message: '正在只读核查真实课程，业务修改已暂停。' }
  record({ command, strategy: STRATEGIES.RAW, path: PATHS.CLOUD, key: options.key || '' })
  return ui.adapter.execute(command, payload, options)
}

// —— 本机视觉协调的写动作也全部从这里出，页面不再直接触碰协调器 ——
function submitBooking(input) {
  record({ command: (input && input.command) || 'createBooking', strategy: STRATEGIES.OPTIMISTIC, path: PATHS.CLOUD, key: 'submit' })
  return ui.submitBooking(input)
}
function cancelBooking(input) {
  record({ command: 'cancelBooking', strategy: STRATEGIES.OPTIMISTIC, path: PATHS.CLOUD, key: (input && (input.localKey || input.officialId)) || '' })
  return ui.cancelBookingRequest(input)
}
function retryPendingBooking(bookingKey) {
  record({ command: 'createBooking', strategy: STRATEGIES.OPTIMISTIC, path: PATHS.CLOUD, key: `retry:${bookingKey || ''}` })
  return ui.retryPendingBooking(bookingKey)
}
function retryPendingCancellation(localKey) {
  record({ command: 'cancelBooking', strategy: STRATEGIES.OPTIMISTIC, path: PATHS.CLOUD, key: `retryCancel:${localKey || ''}` })
  return ui.retryPendingCancellation(localKey)
}
function resumePendingBookings() {
  record({ command: 'createBooking', strategy: STRATEGIES.OPTIMISTIC, path: PATHS.CLOUD, key: 'resume' })
  return ui.resumePendingBookings()
}

module.exports = mutate
module.exports.mutate = mutate
module.exports.createStudentWithPackages = createStudentWithPackages
module.exports.saveStudentBatch = saveStudentBatch
module.exports.resolveLocalId = resolveLocalId
module.exports.bookingViewKeys = bookingViewKeys
module.exports.raw = raw
module.exports.submitBooking = submitBooking
module.exports.cancelBooking = cancelBooking
module.exports.retryPendingBooking = retryPendingBooking
module.exports.retryPendingCancellation = retryPendingCancellation
module.exports.resumePendingBookings = resumePendingBookings
module.exports.COMMANDS = COMMANDS
module.exports.LOCAL_FIRST_COMMANDS = LOCAL_FIRST_COMMANDS
module.exports.CLOUD_FIRST_COMMANDS = CLOUD_FIRST_COMMANDS
module.exports.MODES = MODES
module.exports.PATHS = PATHS
module.exports.STRATEGIES = STRATEGIES
module.exports.OPTIMISTIC_COMMANDS = OPTIMISTIC_COMMANDS
module.exports.TARGET_FIELD = TARGET_FIELD
module.exports.dataSourceMode = dataSourceMode
module.exports.executionPath = executionPath
module.exports.writePath = executionPath
module.exports.isCloudWritePath = isCloudPath
module.exports.isLocalFirstCommand = isLocalFirstCommand
module.exports.strategyFor = strategyFor
module.exports.localFirstEnabled = () => LOCAL_FIRST_ENABLED
module.exports.localFirstReady = () => LOCAL_FIRST_ENABLED && !!coachScope()
module.exports.sync = syncEngine
module.exports.outbox = outbox
module.exports.projection = projection
module.exports.audit = () => auditLog.slice()
module.exports.clearAudit = () => { auditLog.length = 0 }
module.exports.VIA = VIA
