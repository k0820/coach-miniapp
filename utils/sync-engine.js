// 后台同步引擎（阶段 2：Local-first + Cloud Sync）。
//
// 这是「本机先行」的另一半：页面早就返回了，这里负责把 Outbox 里的业务事实**按顺序**送到
// coachBusinessCommand（经过 adapter 的写单航班 / expectedRevision / receipt / 服务端单事务），
// 并在成功后把本机临时 id 换成云端正式 id。
//
// 排序为什么是**全局 FIFO**（而不是"每个实体一条独立队列"）：
//   因为业务载荷之间**存在跨实体引用**：booking 引用 packageId、income 引用 bookingId、
//   销售记录引用 packageId。若允许不同实体并行发送，"引用方"完全可能跑在"被引用方"前面
//   —— 那时正式 id 还不存在，只能失败。单教练场景下吞吐毫无压力，所以选择
//   **严格全局保序**：同实体严格保序、跨实体也保序。这是正确性优先于吞吐的取舍。
//
// 结果分类（每一条都对应一个真实故障）：
//   ok                        → 记 idMap；回读成功就出队；回读失败标 settled（**绝不换号重发**）
//   REVISION_CONFLICT         → 先重新同步取回真 revision，再用**同一个号**重试（有界）
//   COMMAND_RESULT_UNKNOWN    → 先查**本次 requestId** 的回执：succeeded 就当成功；查不到就保留原号退避
//   OFFLINE_READ_ONLY         → 保持 pending，等网络恢复（App 打开 / 网络恢复会再触发）
//   明确的业务拒绝             → 出队留档 + 重新同步取回云端真相 + 轻提示（只用 toast，绝不黑屏弹窗）
//
// 它**不碰**任何云端安全机制：OPENID 由云函数可信取得、requestId 稳定持久化、
// expectedRevision 由 adapter 在航位内现读现用、服务端事务与不变量一条没动。
const outbox = require('./local-outbox')
const recoveryGuard = require('./production-recovery-guard')
const projection = require('./local-projection')
const { applyCommand, rewriteIds, RESULT_ID_FIELD, isLocalId } = require('./local-transaction')
// `canonicalize` 是引擎自己算 payloadHash 用的那套**键序无关**规范化 ——
//   拿它做"两份内容是不是同一份"的比较，与引擎同口径（不再自己另写一套比较规则）。
const { canonicalize } = require('./cloud-command-engine')
// ★ §110：requestId 契约（只读用途：诊断页要能看出"盘上号"与"实际发出去的号"）。
const requestIdRule = require('./request-id-rule')

// ★ 同一条命令**按同一个 requestId**最多自动重试多少次（2026-09-28 真机：attempts 累到 47）。
//
//   attempts 每 +1 都对应**一次真的出网**（见 neverSent / setStatus('inflight', attempts+1) 那一段），
//   所以它不是"重复查询计数"，而是真的重发了 47 次 —— 问题在于**没有任何上限、也没有收口**。
//   退避曲线 `delayMs` 在第 6 次之后就封顶 30 秒，于是 47 次重发可以在一个小时内烧完。
//
//   现在：[1..CAP] 按原退避曲线重试；超过 CAP ⇒ 转入**慢速重试**（`LONG_RETRY_MS`），
//   并且**不再阻挡同实体的后续命令**（见 runFlush 里冷却分支的说明）——
//   否则一条推不动的命令会把整条实体链永久冻住，那正是这次要消灭的形状。
const UNKNOWN_ATTEMPT_CAP = 10
// 慢速重试间隔（30 分钟）：既不放弃这条业务事实，也不再用 30 秒一次的节奏去敲一台正在出故障的服务器。
const LONG_RETRY_MS = 30 * 60 * 1000
//
// ⚠️⭐ **CAP 只限制"重新发送"，绝不限制"安全收口判断"**（2026-09-28 真机第 5 次修正）：
//   上一版把「到顶」写成了**在查回执之前就 stall**，结果真机那条 attempts=47 的历史条目
//   从新版本落地那一刻起，一次回执也没查过、三个安全出口一次也没评估过 ——
//   「已经重试 47 次」反而成了它的终身监禁（本地复现 `tests/_repro108-capped.js` 四连证）。
//   正确语义：**每次冷却到期都是一次完整评估**（查回执 → 事实已在 / TARGET_GONE / SUPERSEDED），
//   三条都不成立才重新进入冷却；到顶唯一封住的是"再发一次"这个动作本身。
//   ⚠️ 冷却必须**真的到期可达**：写了 nextAttemptAt 就必须有代码在时间到了之后走过去（见 runFlush）。

// 训练草稿的入队标记（与 pages/session/session.js 里 `coalesceKey: draft:${draftKey}` 同口径）。
// 为什么"落云成功就删草稿"这件事必须由同步引擎收尾、不能由页面收尾：
//   用户按下课后第一帧就返回了课表，页面**已经 unload**，而这条内容还要等预约在云端转正之后
//   才送得出去。页面不在了，草稿却还留着 —— 下次进课程时它会被当成"尚未确认的新内容"再提交一遍，
//   而它其实早就落库了。队列条目是这份内容的**持久载体**，所以交付确认也该由队列这一侧负责。
const DRAFT_COALESCE_PREFIX = 'draft:'

const listeners = []
let running = null
let scheduled = false
// ★ 1.1.9 第 12 轮：**在途那一轮跑完之后，还要不要再跑一轮**。
//
//   为什么必须有这个标记：`schedule()` 最典型的调用场景恰恰是「某一轮正在跑的时候」——
//   取消落云那一刻，同步引擎多半正在发同一时段的 create，而 B 正被排序门 stall 在这一轮里。
//   旧行为：flush 发现 `running` 非空就直接把**在途那个 promise** 交回去 ⇒ 什么都没发生，
//   B 只能等下一次后台轮询 / 页面生命周期 / 一次完整读取。
//   真机（2026-09-24 17:36）就是这个形状：A 的取消 17:36:12 落云，B 却迟迟不出网，
//   于是「电脑界面早就显示 B」与「云端真的有 B」之间差了十几秒。
//
//   ⇒ 现在记一个"还要再跑一轮"的标记，本轮结束后立刻补一轮。
//   有界：一次只记一次；补出来的那一轮若又有人请求，就再记一次 —— 循环有自然终点，
//   因为队列空时补出来的是**空轮**（不再产生新的 schedule 请求）。
let rerunRequested = false
let lastFailure = null
let lastSummary = null

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
function notify() { listeners.forEach(listener => { try { listener() } catch (error) {} }) }
function subscribe(listener) { if (typeof listener !== 'function') return () => {}; listeners.push(listener); return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1) } }
const delayMs = attempt => Math.min(30000, 1000 * Math.pow(2, Math.max(0, Math.min(5, attempt - 1))))

// 当前（环境 + 数据集）。取不到就什么都不做 —— 绝不猜一个数据集去写。
// 测试替身可能只实现 getDB/saveDB（第 37 节的教训）：缺成员时静默降级成"没有数据集"，不抛错。
function runtimeReady() {
  const runtime = require('./data-runtime')
  return typeof runtime.mode === 'function' && !!runtime.MODES && typeof runtime.cacheKey === 'function' && typeof runtime.environment === 'function'
}
function scope() {
  const runtime = require('./data-runtime')
  if (!runtimeReady() || runtime.mode() !== runtime.MODES.CLOUD) return null
  const cache = wx.getStorageSync(runtime.cacheKey())
  if (!cache || !cache.datasetId) return null
  const environment = runtime.environment()
  const cachedSandbox = cache.environment === 'sandbox'
  if (environment === 'sandbox' ? !cachedSandbox : cachedSandbox) return null
  return { environment, datasetId: cache.datasetId }
}
// 该环境的 Outbox 桶里是否有东西（跨数据集也算，用于启动时判断要不要跑一轮）。
function pendingAnywhere() {
  const runtime = require('./data-runtime')
  if (!runtimeReady()) return 0
  const current = scope()
  if (current) return outbox.count(current)
  const environment = runtime.environment()
  return outbox.openEntries({ environment, datasetId: '' }).length
}

function resolvePayload(current, entry, ui) {
  const payload = rewriteIds(entry.payload, outbox.idMap(current))
  if (!entry.ref || entry.ref.kind !== 'booking') return payload
  const official = entry.ref.localKey && typeof ui.officialIdForBooking === 'function' ? ui.officialIdForBooking(entry.ref.localKey) : ''
  // 目标课程还没在云端转正：不转发、也不算失败 —— 等它转正后下一轮再送（号不变）。
  if (!official) return null
  return { ...payload, bookingId: official }
}
function idPairs(entry, source) {
  const result = (source && source.result) || (source && source.response && source.response.result) || {}
  const pairs = {}
  Object.keys(entry.localIds || {}).forEach(kind => {
    const field = RESULT_ID_FIELD[kind]
    const official = field ? result[field] : null
    if (official) pairs[entry.localIds[kind]] = official
  })
  return pairs
}

// 训练内容确认交付之后，本机那份草稿必须消失。
// 触发条件只有一条：这条队列条目**确认已在云端提交**（拿到了 ok 或 succeeded 回执）。
// 明确被云端拒绝时绝不清 —— 那时草稿是用户内容的唯一副本，清掉就是把用户录的动作弄丢。
function settleTrainingDraft(current, entry) {
  if (!entry || typeof entry.coalesceKey !== 'string' || !entry.coalesceKey.startsWith(DRAFT_COALESCE_PREFIX)) return false
  const draftKey = entry.coalesceKey.slice(DRAFT_COALESCE_PREFIX.length)
  if (!draftKey) return false
  const drafts = require('./pending-training-draft')
  try {
    const record = drafts.get(current.environment, current.datasetId, draftKey)
    if (!record) return false
    // ⚠️ 只删「与刚交付的那一份**逐字相同**」的草稿。
    //    命令在路上这几十~几百毫秒里，用户完全可能又加了动作：那时本机草稿是**更新的**版本，
    //    它还没被交付过 —— 删掉就等于把用户后来录的内容抹掉。
    //    内容不一致 → 原地保留，走下一次正常提交。判不准时一律**保留**（宁可多留，绝不少留）。
    if (!sameDeliveredContent(record.content, entry.payload)) return false
    return drafts.remove(current.environment, current.datasetId, draftKey) === true
  } catch (error) { return false }
}
function sameDeliveredContent(content, payload) {
  if (!content || !payload) return false
  const pick = source => ({ items: source.items, notes: source.notes, category: source.category, duration: source.duration })
  return JSON.stringify(pick(content)) === JSON.stringify(pick(payload))
}

// 队列条目**离开队列**时的收尾：把这条完课命令对应的本机「完课意图」一并撤掉。
//
// 只有两种离开方式，两种都满足 pending-completion 文档写明的清除条件
// （「事务成功回读后 cache 才有这条 done，标记随之清除」）：
//   ① 命令成功**且回读成功** → cache 里已经有这条 done 了；
//   ② settled 条目在一次成功的完整回读之后被清出 → cache 同样已经包含它。
// ⚠️ 回读**失败**时绝不撤：那时 cache 还是旧的，撤掉意图会让课表当场从「已完」退回「已约」——
//    用户在真机上看到的就是"点了下课，课表又变回没完成"。
// 用 requestId 精确定位（它是完课这条业务事实的幂等号），不靠猜 localKey：
// 课程页的 localId 与 outbox 的 ref.localKey 是两套命名，猜错就会清到别的课上。
function settleIntents(current, entries) {
  const rows = (entries || []).filter(entry => entry && entry.command === 'completeBooking')
  if (!rows.length) return 0
  const completions = require('./pending-completion')
  let cleared = 0
  rows.forEach(entry => {
    try {
      const row = completions.list(current.environment, current.datasetId).find(item => item && item.requestId === entry.requestId)
      if (row && completions.remove(current.environment, current.datasetId, row.localKey, row.requestId)) cleared += 1
    } catch (error) {}
  })
  return cleared
}

// 「本机还不知道云端 revision」不是一次业务失败 —— 它是一个**可以自愈的前置条件**。
//
// 为什么必须有这一步：`cloud-primary-adapter.execute()` 的 expectedRevision 取自**进程内存态**
// （只有一次成功的 readActive，或一次成功的命令，才会把它填上）。冷启动 / 切环境之后它是空的，
// 那时 adapter 会在 **callCloud 之前**就返回 `REVISION_UNKNOWN` —— 命令**根本没有出网**，
// 云端连它收到过都不知道。
// 页面侧的三个写入口都带了这道前置保护（`ui-cloud-command.runCommand` / `runCommandSilent`
// 与预约协调器的 `confirm`），**只有同步引擎漏了**。于是"杀进程重开后的第一轮同步"里，
// 队列中的每一条都会以「同步失败」的名义被归档，并弹出一句「有 1 项操作没能同步，已按云端为准」——
// 而真相是云端从未收到过任何一条。真机正是这个形状：多条 updateBookingContent 明明成功了
// （revision 54→55→56…），中间却夹着若干 REVISION_UNKNOWN 进了失败档案，revision 序列里还缺了号。
async function ensureRevision(ui) {
  try {
    if (!ui.adapter || typeof ui.adapter.getState !== 'function' || typeof ui.adapter.readActive !== 'function') return false
    const state = ui.adapter.getState()
    if (Number.isInteger(state && state.revision)) return true
    const active = await ui.adapter.readActive()
    return !!(active && active.ok)
  } catch (error) { return false }
}

// 本机 cache 快照**当前**停在哪一版。读不到就返回 null（= 无法证明"已追上"）。
//
// ⚠️ 绝不能用 adapter 的内存态 revision 代替：命令成功那一刻内存态就被推高了
//    （`cloud-primary-adapter.execute` 里的 setState），但 cache 里**并没有那一行** ——
//    拿它当"已追上"会立刻把刚约上的课从界面上抹掉。
// ⚠️ 也不能用 `ui.adapter.getState().revision`：同上，那是内存态，不是快照。
function cacheRevision() {
  try {
    const runtime = require('./data-runtime')
    if (!runtimeReady()) return null
    const cache = wx.getStorageSync(runtime.cacheKey())
    return Number.isInteger(cache && cache.revision) ? Number(cache.revision) : null
  } catch (error) { return null }
}
// 这条 settled 条目所代表的业务事实，是不是**已经真的进了本机 cache 快照**。
// 判据与投影**逐字同口径**（`local-projection.js` 里 settled 条目停止叠加的那一行）：
//     cache.revision >= settledRevision
//   · 成立 ⇒ 投影本来就已经不再叠加它 ⇒ 出队不会让任何东西从界面消失，**零云调用**即可收尾；
//   · 不成立 ⇒ 这条条目正是"界面上看得见这条事实"的**唯一载体** ⇒ 绝不能出队。
function cacheCaughtUp(entry) {
  if (!entry || !Number.isInteger(entry.settledRevision)) return false
  const revision = cacheRevision()
  return Number.isInteger(revision) && revision >= Number(entry.settledRevision)
}
// 这条命令落地时云端到了哪一版 —— 它就是 settled 条目"什么时候可以出队"的门槛。
//
// 拿不到精确值（极罕见）时**绝不留 null**：null 会让这条条目永远判不出"追上了没有"，
// 于是永久留在队列里（她点名的 D：settled 项目不能永久留在 outbox）。
// 退到「cache 至少往前走一版」这个下界，它是**保守且必然收敛**的：
//   命令既然成功，云端 revision 一定比此刻 cache 新；而之后任何一次读取拿到的都是当时的
//   head（≥ 命令那一版）⇒ cache 只要前进过一次，就必然已经包含了这条事实。
function settledRevisionOf(result) {
  if (Number.isInteger(result && result.datasetRevision)) return result.datasetRevision
  const revision = cacheRevision()
  return Number.isInteger(revision) ? revision + 1 : null
}
// ★ 1.1.9 第 14 轮（真机账本定案，见 `PROJECT_MEMORY.md` §85）：**出队不再需要一次完整读取**。
//
// 修前：只要有 settled 条目，这里就**无条件**先做一次 `ui.adapter.readActive()`
//   —— 真机上那是一次 10 页完整读取（metadata + 10×page + integrity，实测 9~19 秒），
//   而它经 adapter 的 `serialize` 与**写命令共用同一条航位**。
//   ⇒ 「约 A 成功 → 立刻取消 A」时，取消被这条读取堵在航位后面干等 8~19 秒
//      （实测 cancel 的 11 秒里 8~19 秒是排队，真正出网只要 1.3~3.2 秒）；
//      B 又排在 cancel 后面再等一次。这就是"手机第一次下拉看不到 B"的整条因果。
//
// 修后：**先判 cache 有没有追上，只有追上了才收尾，一次云调用都不发。**
//   没追上的条目**继续留在队列里**——它不是垃圾，它是"界面上看得见"的载体
//   （投影会一直叠加它，直到 cache 追上为止，见 `local-projection.js`）。
//   cache 追上只可能由一次**读取**完成，而读取在本来就会发生的地方发生：
//   页面 onShow 的静默刷新、用户下拉、启动/联网恢复、下一次别的命令。
//   追上之后，任何一轮 flush 都会在这里**免费**把它清掉（零云调用）。
//
// 两条安全边界（她点名要求，缺一不可）：
//   ① `settleIntents()` 只对**已追上**的条目执行 —— 完课意图的清除条件
//      （"事务成功回读后 cache 才有这条 done，标记随之清除"）因此**比修前更严格**：
//      修前是"任意一次读取成功"就撤，现在是"cache 确实到了这一版"才撤。
//   ② 绝不让一条"已取消的预约"因为出队而复活：可见性由 tombstone 管
//      （`pending-cancellation`，见 `local-projection.js` 取消先于叠加那一段），
//      本函数一个字节都不碰它。
// 这条 settled 条目**身上还挂着一条没撤掉的完课意图**。
//
// 完课意图（`pending-completion`）的清除条件写在它自己的文档里：「事务成功回读后 cache 才有
// 这条 done，标记随之清除」。也就是说：**cache 没追上时撤意图，课表会当场从「已完」退回「已约」**
// —— 用户看到的是"点过下课的课又变回没完成"，那是比"慢"严重得多的错。
// ⇒ 这类条目**真的需要一次读取**才能收尾，属于她点名要保留的"特殊收尾逻辑"。
function intentPending(current, entry) {
  if (!entry || entry.command !== 'completeBooking') return false
  try {
    const completions = require('./pending-completion')
    return completions.list(current.environment, current.datasetId).some(row => row && row.requestId === entry.requestId)
  } catch (error) { return false }
}
// 本机 cache 那份快照（含 revision / datasetId / snapshot）。
function cacheSnapshot() {
  try {
    const runtime = require('./data-runtime')
    if (!runtimeReady()) return null
    return wx.getStorageSync(runtime.cacheKey()) || null
  } catch (error) { return null }
}
// ★ settled 出队的**确定性证据之一**：云端快照里已经看得见这条命令造成的业务事实（零云调用）。
//
// 为什么必须加这一层：只比 `cache.revision >= settledRevision` 是在**猜**——
//   revision 只是一个计数器，"本机追上了这一版"不等于"这一版里真的包含我这条命令"
//   （例：数据集被重建导致 revision 回退、或别人推的版本恰好把号顶过去了）。
//   用"看得见事实"当证据才是可证明的。
// ⚠️ 判不准的一律 false —— 宁可多花一跳查回执，也绝不猜成功。
// 这条命令**写的那几个字段**（与 handlers.updateBookingContent 逐字同源）。
// ⚠️ 只比"这条命令真正提供的字段"：别的一律不比 —— 别处的改动不该影响这条命令的判定。
const CONTENT_FIELDS = ['items', 'notes', 'category', 'duration', 'summary']
// 这条命令的目标 booking 正式 id（先把 loc_ 临时 id 按 idMap 归一）。拿不到 ⇒ 判不了，绝不猜。
function bookingTargetId(entry, map) {
  if (!entry) return ''
  const raw = String((entry.payload && entry.payload.bookingId) || (entry.localIds && entry.localIds.booking) || '')
  if (!raw) return ''
  const id = Object.prototype.hasOwnProperty.call(map || {}, raw) ? map[raw] : raw
  return id || ''
}
// ★ 「内容类命令的事实是不是已经落好了」——判定方法不是比较时间戳，而是**把这条命令再算一遍**：
//   拿**同一套业务规则**（local-transaction.applyCommand ⇒ cloud-command-engine 的 handlers，
//   与云端同一个字）在本机权威快照上重算；若算出来的那些字段与快照逐字段相同 ⇒
//   云端存的**就是这条命令要写的内容**（再写一次不会产生任何变化）⇒ 事实已经存在。
//
// 为什么不能简单地"看 items 在不在就算存在"：课程内容允许被**更晚的一次保存**覆盖，
//   那时 items 也在，但那不是这条命令写进去的那份。只有"重算结果 == 现状"才能证明是这一份。
//
// ⚠️ 判不了的一律 false（拿不到正式 id / 目标不存在 / 规则引擎拒绝）= "不知道"，
//   绝不等于"已经存在"。
function contentFactVisible(entry, snapshot, map) {
  if (!entry || entry.command !== 'updateBookingContent') return false
  const id = bookingTargetId(entry, map)
  if (!id || isLocalId(id)) return false
  const list = Array.isArray(snapshot && snapshot.bookings) ? snapshot.bookings : []
  const row = list.find(item => item && item.id === id)
  if (!row) return false
  const payload = entry.payload || {}
  const supplied = CONTENT_FIELDS.filter(key => Object.prototype.hasOwnProperty.call(payload, key))
  if (!supplied.length) return false
  let applied = null
  try { applied = applyCommand({ bookings: [clone(row)] }, entry.command, payload, { now: () => 0, id: kind => `loc_${kind}` }) } catch (error) { applied = null }
  if (!applied || !applied.ok) return false
  const after = (applied.db && Array.isArray(applied.db.bookings) ? applied.db.bookings : []).find(item => item && item.id === id)
  if (!after) return false
  return supplied.every(key => canonicalize(after[key]) === canonicalize(row[key]))
}
// ★ 「目标已经不存在」：这条命令写的事实**永远不可能再被送达**（连目的地都没了）。
// ⚠️ 这是不可逆结论，所以三条证据缺一不可：
//   ① 回执**明确**说云端没有受理过这个编号（否则可能是"写成了但没记录"，那样的目标不存在纯属幻觉）；
//   ② 目标 id 已经是**正式 id**（还是 loc_ 说明它自己都还没出生，谈何消失）；
//   ③ 用的必须是**刚读过的一版新鲜快照**，且那版里确实有别的 booking（空数组只说明没读到）。
// ⚠️ 只对**内容类**开放（这次要救的就是历史 updateBookingContent 卡了几百次重发的形状）：
//    完课 / 取消 / 新建都牵着课时与金额，拿"快照里暂时看不见"去宣判它们永久失败太冒险 ——
//    那些宁可保留原号慢速重试，也绝不抢先宣判。
function bookingTargetGone(entry, snapshot, map) {
  if (!entry || entry.command !== 'updateBookingContent') return false
  const id = bookingTargetId(entry, map)
  if (!id || isLocalId(id)) return false
  const list = Array.isArray(snapshot && snapshot.bookings) ? snapshot.bookings : []
  if (!list.length) return false
  return !list.some(item => item && item.id === id)
}
// ★ 「已经被更晚的同一份内容接管」：同一实体、同一命令、**更晚入队**的那一条**已经确认落云**，
//   且它提供的字段**覆盖**本条提供的字段 ⇒ 本条再发出去只会把**更新的内容**覆盖回旧版本。
//   ⇒ 正确处置不是删除，而是**留档归档并写明理由**（它在 failed 里永久可查）。
// ⚠️ 只认 status==='settled'（云端已经确认收下巴菲），pending/unknown 一条都不算 —— 没落地就没有"接管"。
function supersededBy(current, entry) {
  if (!entry) return null
  const map = outbox.idMap(current)
  const key = entityKeyOf(entry, map)
  const covered = overlapFields(entry)
  const rows = outbox.list(current)
  let winner = null
  for (const other of rows) {
    if (!other || other.entryId === entry.entryId) continue
    if (Number(other.seq || 0) <= Number(entry.seq || 0)) continue
    if (other.command !== entry.command || entityKeyOf(other, map) !== key) continue
    if (other.status !== 'settled') continue
    const theirs = overlapFields(other)
    if (!covered.every(field => theirs.indexOf(field) >= 0)) continue
    if (!winner || Number(other.seq || 0) > Number(winner.seq || 0)) winner = other
  }
  return winner
}
// 这条命令真正要写的那几个字段（只在 payload 里**出现**的才算）。
function overlapFields(entry) {
  return CONTENT_FIELDS.filter(key => Object.prototype.hasOwnProperty.call((entry && entry.payload) || {}, key))
}
// ★ 这条 settled 条目此刻还是别人判断"已被更晚版本接管"的**唯一证据** ⇒ 不许提前出队。
//
//   场景：v1 卡在 unknown 迟迟发不出去，用户又存了 v2，v2 顺利落云。
//   v2 一旦被 purgeSettled 清掉，"存在更晚的一版"这件事在本机就**再也无法证明**了 ——
//   于是 v1 重发出去会把用户的 v2 覆盖回 v1（内容命令是覆写，那就是真的丢内容）。
//   ⇒ 只要前面还有一条同实体、同命令、字段有交叠且尚未了结的旧条目，
//     这条 settled 就得留着当证据，等旧条目结案（归档 / 收敛）之后再由下一轮清掉。
function neededAsSupersedeEvidence(current, row) {
  if (!row || row.command !== 'updateBookingContent') return false
  const map = outbox.idMap(current)
  const key = entityKeyOf(row, map)
  const mine = overlapFields(row)
  if (!mine.length) return false
  return outbox.openEntries(current).some(other =>
    other.entryId !== row.entryId &&
    other.command === row.command &&
    entityKeyOf(other, map) === key &&
    Number(other.seq || 0) < Number(row.seq || 0) &&
    ['pending', 'unknown', 'inflight'].indexOf(other.status) >= 0 &&
    overlapFields(other).some(field => mine.indexOf(field) >= 0))
}
function factVisibleInSnapshot(entry, snapshot, map) {
  const list = Array.isArray(snapshot && snapshot.bookings) ? snapshot.bookings : []
  const raw = (entry.payload && entry.payload.bookingId) || (entry.localIds && entry.localIds.booking) || ''
  if (!raw) return false
  const id = Object.prototype.hasOwnProperty.call(map || {}, raw) ? map[raw] : raw
  const row = list.find(item => item && item.id === id)
  if (entry.command === 'completeBooking') return !!(row && row.status === 'done')
  if (entry.command === 'createBooking') return !!row
  // 取消的**唯一**效果就是这一行消失 ⇒ 看不见 = 取消已生效。
  if (entry.command === 'cancelBooking') return !row
  // 内容类：目标还在、且重算不出任何变化 ⇒ 这一份内容已经在云端了（见 contentFactVisible 上方长注释）。
  if (entry.command === 'updateBookingContent') return contentFactVisible(entry, snapshot, map)
  return false
}
// ★ 队列真正收敛（条目拿到云端硬证据后出队）时，必须让**当前可见的页面**重新取一次数。
//
// 为什么这条线以前没有：命令**提交成功**那一刻就广播过一次（ui-cloud-command 的 requestForCommand），
//   但那一刻云端事务刚落、本机 cache 还没翻完 ⇒ 页面读到的仍是旧值；
//   而"cache 追上、条目出队"是**几分钟内另一次**事件，它当时只调了本文件的 notify()（引擎内部总线），
//   没有任何页面订阅它 ⇒ 界面会一直停在「完成同步中」，直到用户重新进页面 / 回前台 / 下拉。
//
// ⚠ 这不是轮询：只在**条目真的离开队列**时触发，且 `auto-refresh` 自带 400ms 合并与"只唤醒可见页面"，
//   没有任何定时 / 循环 / WebSocket。触发点名字一律复用既有 COMMAND_TRIGGERS（completeBooking ⇒ bookingCompleted）。
function broadcastSettled(rows) {
  try {
    const autoRefresh = require('./auto-refresh')
    const seen = new Set()
    for (const row of rows || []) {
      const reason = autoRefresh.refreshTriggerFor(row && row.command)
      if (!reason || seen.has(reason)) continue
      seen.add(reason)
      autoRefresh.request(reason)
    }
  } catch (error) { /* 刷新广播失败绝不能影响队列收敛本身 */ }
}

async function purgeSettled(current, ui) {
  const rows = outbox.settled(current).filter(entry => !recoveryGuard.blocksEntry(current, entry))
  if (!rows.length) return 0
  let ready = rows.filter(cacheCaughtUp)
  // ★ 只有下面这三类**真的需要一次读取**；其余一律零云调用出队 —— 那才是本次要修的东西。
  //   ① completeBooking：完课既撤意图、又要求 cache 里真有那条 done（见 intentPending 上方），
  //      所以它必须靠一次读取把 cache 推上来 —— 这条是**刻意保留**的旧行为，不是遗漏。
  //   ② 别的命令但身上还挂着完课意图（intentPending）：同上，撤早了课表会退回"未完成"。
  //   ③ settledRevision 拿不到：永远判不出"追上没有"，不给它收敛就会永久滞留在队列里（D）。
  //   ⚠️ 这三类都是**少数分支**：普通的 createBooking / cancelBooking / updateBookingContent
  //      既不是完课、又拿得到 datasetRevision ⇒ 走到这里一行云调用都不会发 ——
  //      而"约 A → 取消 A → 约 B"整条链**全都是**普通命令，所以那条 10 页读彻底消失了。
  const needsRead = rows.filter(entry => !cacheCaughtUp(entry) &&
    (entry.command === 'completeBooking' || intentPending(current, entry) || !Number.isInteger(entry.settledRevision)))
  if (needsRead.length) {
    let refreshed = null
    try { refreshed = await ui.adapter.readActive() } catch (error) { refreshed = null }
    // 读取成功 ⇒ cache 到了 head（head ≥ 任何既往命令那一版）⇒ 此刻这些条目都可以清掉。
    if (refreshed && refreshed.ok) {
      ready = rows.filter(entry => cacheCaughtUp(entry) || !Number.isInteger(entry.settledRevision))
    }
  }
  if (!ready.length) return 0
  // ★★ 出队前必须拿到「云端确实提交过这条」的确定性证据（2026-09-27 真机后定的硬规矩）。
  //   `cache.revision >= settledRevision` 只证明"本机追上了这一版"，**不证明这一版里包含我这条命令**
  //   （数据集重建会让 revision 回退；别人推的版本也会把号顶过去）⇒ 拿它单独当证据就是在猜。
  //   两条硬证据，取一即可：
  //     ① 云端快照里已经看得见这条命令造成的业务事实（零云调用，首选）；
  //     ② 云端回执按**原 requestId** 明确说 succeeded。
  //   查不到 / 传输失败 ⇒ **保留**：绝不能为了让队列变短而丢掉一条可能尚未落云的业务事实。
  // ⚠️ 兼容边界：只有发送链**具备查回执能力**时才走证据链；否则沿用既有判据，不因此把队列卡死。
  const canVerify = !!(ui && ui.adapter && typeof ui.adapter.getReceipt === 'function')
  if (!canVerify) {
    settleIntents(current, ready)
    ready.forEach(row => outbox.remove(current, row.entryId))
    projection.invalidate()
    broadcastSettled(ready)
    return ready.length
  }
  const map = outbox.idMap(current)
  const snapshot = (cacheSnapshot() || {}).snapshot || null
  const confirmed = []
  for (const row of ready) {
    if (snapshot && factVisibleInSnapshot(row, snapshot, map)) { confirmed.push(row); continue }
    let receipt = null
    try { receipt = await ui.adapter.getReceipt(row.requestId) } catch (error) { receipt = null }
    if (receipt && receipt.ok && receipt.found && receipt.status === 'succeeded') { confirmed.push(row); continue }
    if (receipt && receipt.ok && receipt.found && receipt.status === 'failed') {
      settleIntents(current, [row])
      outbox.reject(current, row.entryId, (receipt.response && receipt.response.code) ? receipt.response : { code: 'COMMAND_FAILED', message: '云端执行失败。' })
      continue
    }
    // 查不到 / 传输失败 ⇒ 保留在队列里继续参与投影，等下一轮再取证。
  }
  const evidence = confirmed.filter(row => neededAsSupersedeEvidence(current, row))
  const readyOut = confirmed.filter(row => evidence.indexOf(row) < 0)
  if (!readyOut.length) return 0
  settleIntents(current, readyOut)
  readyOut.forEach(row => outbox.remove(current, row.entryId))
  projection.invalidate()
  broadcastSettled(readyOut)
  return readyOut.length
}

// 「上一次失败到底为什么」必须能事后复原。
// 旧写法只把 `{code}` 存进 lastError，adapter 给的 `reason` / `technicalMessage` **全丢了** ⇒
// 事后永远无法区分「云函数超时」「网络断」「云函数抛错」这三件完全不同的事
// （2026-09-22 手机队首悬在 unknown 时就卡在这里：只能确定"传输层抛错"，再往下问不下去了）。
// 现在原样保留 adapter 的字段；缺哪个就不写哪个 —— 绝不填假值进去冒充原因。
function errorRecord(code, result) {
  const source = result || {}
  const record = { code }
  ;['reason', 'message', 'technicalMessage', 'originalTechnicalMessage'].forEach(field => {
    const value = source[field]
    if (typeof value === 'string' && value) record[field] = value.slice(0, 300)
  })
  return record
}

// ★ 「先取消、后重约同一时段」的排序门（1.1.9 第 7 轮）。
//
// 场景：11:00 约了 A → 取消 A → 立刻把 11:00 约给 B。
//   取消走的是本机视觉协调器（不在队列里），B 走队列。B 若抢在 A 的取消之前出网，
//   云端那边 A 还在 ⇒ `createBooking` 被 `BOOKING_TIME_CONFLICT` **明确拒绝** ——
//   而明确拒绝会被当成"业务失败"归档，用户看到的就是"约不上，得再点一次"。
//   那不是业务冲突，是**排序问题**，必须在本机解决。
//
// 判据：条目上有 `afterCancelKey`（入队时由 mutate 打上，见 pendingCancelBefore）且
//   那条取消**尚未落云**（waiting / cancelling / unknown）。取消一旦在云端确认（syncing）
//   或被撤回（记录消失），门立刻打开 —— 绝不为了一条已经落云的取消白等。
//
// 为什么不 `break` 而是 `stall`：stall 的语义是"这一轮先不发它，但别堵住后面的"，
//   与既有的「目标课程还没转正」完全同形（那条也是等下一轮）。整轮 break 会让一个
//   极端情形（取消一直落不了云）把整个队列拖住。
//
// 有界：取消超过 CANCEL_GATE_MS 仍未落云就放行，交给云端裁决（云端是最终裁判）。
//   真到那一步的话 B 会被明确拒绝并如实归档 —— 那是**有界、可见**的失败，不是静默错误。
const CANCEL_GATE_MS = 8000
// 已经因为「同段取消未落云」被云端拒过一次之后，改按**轮次**计数放行（不再看墙上时钟）：
//   那时钟已经说明"取消比预期慢"，再用 8 秒去卡它只会把一条必然能成功的预约判死。
// 有界：最多再等 CANCEL_CONFLICT_ROUNDS 轮，超过就归档（那是**有界、可见**的失败，不是静默错误）。
const CANCEL_CONFLICT_ROUNDS = 3

// 真正占着这条新预约那个时段、且**还没落云**的取消记录。
//
// ⚠️ 为什么必须**在出网前现查**、而不是沿用入队那一刻打在条目上的 `afterCancelKey` 快照：
//   真机实测（2026-09-23 23:23）B 入队后 4.7 秒就出网了，而那条取消此时还在"等正式 id"——
//   也就是 B 入队那一刻 `afterCancelKey` 是空的（tombstone 还没建 / 或还没匹配上），
//   快照一旦为空，门就整轮失效，B 抢先出网、被云端 BOOKING_TIME_CONFLICT 明确拒绝（§80）。
//   判据与冲突判定同口径（共享 `overlapsMoment`：同一日期、分钟区间重叠、一节课 60 分钟）。
function sameSlotUnresolvedCancels(current, entry) {
  if (!entry || entry.command !== 'createBooking') return []
  try {
    const cancellation = require('./pending-cancellation')
    const rows = cancellation.slotRows(current.environment, current.datasetId, entry.payload).filter(cancellation.unresolved)
    // 入队快照那一条也一并算上（它可能是本时段之外的引用，或 payload 字段缺失时唯一的线索）。
    const named = entry.afterCancelKey ? cancellation.get(current.environment, current.datasetId, entry.afterCancelKey) : null
    if (named && cancellation.unresolved(named) && !rows.some(row => String(row.localKey) === String(named.localKey))) rows.push(named)
    return rows
  } catch (error) { return [] }
}
function heldByCancel(current, entry) {
  const rows = sameSlotUnresolvedCancels(current, entry)
  if (!rows.length) return false
  const conflicts = Number(entry.cancelConflict || 0)
  if (conflicts > 0) return conflicts <= CANCEL_CONFLICT_ROUNDS
  const oldest = rows.reduce((min, row) => Math.min(min, Number(row.startedAt || 0)), Date.now())
  return Date.now() - oldest <= CANCEL_GATE_MS
}

// ★★ 依赖感知的推进（2026-09-27 真机：26 条里有 1 条 unknown 卡在队首 ⇒ FIFO 整队停摆，
//   25 条 pending **一次都没出过网**）。
//
// 旧行为：全局严格 FIFO，`entries[0]` 一旦因为「结果未知 / 退避中 / revision 拿不到」
//   直接 `break` 结束整轮 ⇒ 后面所有条目跟着一起饿死。队列因此**长期只增不减**。
//
// 现在的原则不是"无脑跳过"，而是**按依赖链分组推进**：
//   ① **同一实体严格保序**：`entityKey` 相同（经 idMap 归一后）的条目，前面的没了结，
//      后面的绝不允许越过。这是"课程内容不丢"的地基 ——
//      `updateBookingContent`（内容）必须排在 `completeBooking`（完课）之前落云，
//      反了的话云端那节已完成课会拒绝再改内容，用户录的动作就永久丢了。
//   ② **引用未转正 id 的条目必须等**：载荷里出现 `loc_` 前缀的本机临时 id，
//      而这个 id 正是一条更早、尚未了结的命令将要产出的 ⇒ 等它（否则必然 BOOKING_NOT_FOUND）。
//   ③ **除此以外可以越过**：不同学员 / 不同课程 / 不同动作库条目之间没有任何依赖，
//      一条卡住不该把无关的业务一起拖死（真机 25 条 pending 就是这么被拖死的）。
//
// 为什么可以放心越过：被判为"本轮无法推进"的条目**都没有成功**，
//   因此**不会产出任何正式 id**，越过后引用链不会断裂；而真正会产生 id 的那条若被卡住，
//   依赖它的条目会被 ② 精确挡下。
function entityKeyOf(entry, map) {
  const raw = String((entry && entry.entityKey) || '')
  const at = raw.indexOf(':')
  if (at < 0) return raw
  const kind = raw.slice(0, at), id = raw.slice(at + 1)
  const resolved = Object.prototype.hasOwnProperty.call(map || {}, id) ? map[id] : id
  return `${kind}:${resolved}`
}
function collectLocalIds(value, found) {
  if (typeof value === 'string') { if (isLocalId(value)) found.add(value); return }
  if (Array.isArray(value)) { value.forEach(item => collectLocalIds(item, found)); return }
  if (value && typeof value === 'object') Object.keys(value).forEach(key => collectLocalIds(value[key], found))
}
// 这条候选条目是不是被"排在他前面、且本轮无法推进"的某一条挡住了。
function dependsOnEarlier(entry, blockedEntries, map) {
  if (!entry || !blockedEntries || !blockedEntries.length) return false
  const key = entityKeyOf(entry, map)
  const used = new Set()
  collectLocalIds(entry.payload, used)
  if (entry.ref && entry.ref.localKey) used.add(String(entry.ref.localKey))
  if (entry.ref && entry.ref.kind === 'booking' && entry.payload && entry.payload.bookingId) used.add(String(entry.payload.bookingId))
  for (const blocked of blockedEntries) {
    if (!blocked || blocked.entryId === entry.entryId) continue
    if (Number(blocked.seq || 0) > Number(entry.seq || 0)) continue
    // ① 同一实体：严格保序，绝不越过
    if (entityKeyOf(blocked, map) === key) return true
    // ② 引用了它尚未转正的产物
    const produced = Object.keys(blocked.localIds || {}).map(kind => blocked.localIds[kind])
    for (const id of used) if (produced.indexOf(id) >= 0) return true
  }
  return false
}
// 这条命令**是否从未出过网**。
// ⚠️ 只有"确定没出网"才允许原号重发：那时云端连 receipt 都没有（收据与业务写在同一事务里），
//    重发不是重放，是真正的第一次。出过网的一律先查回执，绝不重发 —— 见 runFlush 里的 receipt 分支。
function neverSent(entry) {
  const code = entry && entry.lastError && entry.lastError.code
  if (code === 'REVISION_UNKNOWN') return true
  return Number(entry && entry.attempts || 0) === 0
}

// ★ 云端**明确**没有受理过这个编号之后的四条出口（2026-09-28 真机：3 条 unknown 长期 COMMAND_RESULT_UNKNOWN）
//
//   landed   ⇒ 这份业务事实已经在云端了 ⇒ **不许重发**（内容类命令是覆写，重发会把更新的内容盖回去）；
//   rejected ⇒ 目标已消失 / 已被更晚版本接管 ⇒ 归档**留档**，code 写清理由，payload 永久可查；
//   resend   ⇒ 目标还在、事实还没到 ⇒ 按**原 requestId** 再发一次（有界，见 UNKNOWN_ATTEMPT_CAP）；
//   wait     ⇒ 已到重发上限 ⇒ 转入慢速重试（每 30 分钟一次），本轮不再动它。
//
// ⚠️ 每一条都有出口：既不会因为"拿不到结论"无限重发，也不会为了把数字变短丢掉任何一条业务事实。
// ⚠️ requestId 一个字都不许改 —— 它是幂等的唯一凭据。
async function decideAfterNoReceipt(current, ui, entry, budget) {
  const map = outbox.idMap(current)
  // ① 零云调用先看本机 cache：看得见事实就当场收工。
  let snapshot = (cacheSnapshot() || {}).snapshot || null
  if (snapshot && factVisibleInSnapshot(entry, snapshot, map)) return landFactSettled(current, entry)
  // ② 「目标消失」是**不可逆结论**，只能用**刚读过的一版**新鲜快照来判；
  //    每轮最多给一次读取预算，绝不为了查一条而再造一次 10 页读的拥堵。
  const freshened = await freshSnapshotOnce(ui, budget)
  if (freshened) snapshot = freshened
  if (snapshot && factVisibleInSnapshot(entry, snapshot, map)) return landFactSettled(current, entry)
  // ③ 更晚的同一份内容已经确认落云 ⇒ 本条再发只会把新内容盖回旧版本。
  const winner = supersededBy(current, entry)
  if (winner) return archiveWithReason(current, entry, 'SUPERSEDED_BY_NEWER_WRITE', `同一课程内容已有更晚的一次保存（${winner.requestId}）确认落云，本条不再补发。`)
  // ④ 目标都没了 ⇒ 这条事实**永远不可能**被送达 ⇒ 归档留档，理由写死在数据里随时可查。
  if (snapshot && bookingTargetGone(entry, snapshot, map)) return archiveWithReason(current, entry, 'TARGET_GONE', `目标课程 ${bookingTargetId(entry, map)} 在云端已不存在，本条业务事实不可能再被送达。`)
  // ⑤ 事实还没到 ⇒ 才允许按原号再发一次，并且**次数有上限**（到顶则转入冷却，重新排一次评估时机）。
  return armCooldown(current, entry) ? 'wait' : 'resend'
}
// ★ 「自动重发已经到达上限」的处理：保留原号、保留业务事实，只把节奏降到每 30 分钟一次。
//
// ⚠️⚠️ **冷却状态写独立字段，绝不碰 lastError**（2026-09-28 真机：旧版把 reason 覆写成 RETRY_COOLDOWN，
//   于是 `CLOUD_FUNCTION_TIMEOUT` / `CLOUD_CALL_FAILED` / 云端原始 errMsg **全部被抹掉**，
//   页面上永远只剩一句 RETRY_COOLDOWN，再也分不清"云端在算"还是"根本没发出去" ⇒ 诊断被自己毁掉）。
//   `lastError` 是**这条命令最后一次真实失败**的血证，谁也不许改它。
//
// ⚠️ 冷却是**可重复的**：每次到期评估完仍无出口时重新排一次 nextAttemptAt
//   ⇒ "每 30 分钟评估一次"是**真的会发生**的事，不是写在数据里的空话。
function armCooldown(current, entry, attemptsAt) {
  const attempts = Number.isFinite(attemptsAt) ? attemptsAt : Number(entry.attempts || 0)
  if (attempts < UNKNOWN_ATTEMPT_CAP) return false
  const previous = entry.cooldown || {}
  const rounds = Number(previous.rounds || 0) + 1
  const nextAt = Date.now() + LONG_RETRY_MS
  outbox.patch(current, entry.entryId, {
    nextAttemptAt: nextAt,
    cooldown: {
      rounds,
      attempts,
      armedAt: Date.now(),
      nextAt,
      reason: 'RETRY_COOLDOWN',
      // 冷却期间**不许再发**，但冷却本身不代表业务失败 —— 这句话要留在数据里给人和代码看。
      message: `已按同一个编号发送 ${attempts} 次仍未拿到云端结论；转入每 30 分钟评估一次的冷却（第 ${rounds} 轮）。原编号与原失败原因都保留。`
    }
  })
  return true
}
// 「这条事实已经在云端」⇒ 机上按已确认处理（继续投影、绝不重发），随后由 purgeSettled 凭事实出队。
function landFactSettled(current, entry) {
  settleTrainingDraft(current, entry)
  const revision = cacheRevision()
  outbox.setStatus(current, entry.entryId, 'settled', {
    settledRevision: Number.isInteger(revision) ? revision : null,
    attempts: 0, nextAttemptAt: 0,
    lastError: { code: 'FACT_ALREADY_IN_CLOUD', reason: 'BUSINESS_FACT_VISIBLE', message: '云端快照里已经存在这一份业务事实，不再按原编号补发。' }
  })
  projection.invalidate()
  return 'landed'
}
// 归档**留档**（不是删除）：队列里消失，但 `failed` 里永久保留 payload + requestId + 理由。
function archiveWithReason(current, entry, code, message) {
  settleTrainingDraft(current, entry)
  settleIntents(current, [entry])
  lastFailure = outbox.reject(current, entry.entryId, { code, message })
  projection.invalidate()
  return 'rejected'
}
// 一轮里最多一次的「新鲜权威快照」预算：`readActive` 在真机上可能是 10 页读，
// 放任每个 unknown 各自读一次会把写航位重新堵回 §85 之前的老样子。
async function freshSnapshotOnce(ui, budget) {
  const wallet = budget || { reads: 0 }
  if (Number(wallet.reads || 0) >= 1) return null
  if (!ui || !ui.adapter || typeof ui.adapter.readActive !== 'function') return null
  wallet.reads = Number(wallet.reads || 0) + 1
  let refreshed = null
  try { refreshed = await ui.adapter.readActive() } catch (error) { refreshed = null }
  if (!refreshed || !refreshed.ok) return null
  const cache = cacheSnapshot()
  return (cache && cache.snapshot) || null
}

// ★ unknown（结果未知）的**唯一**收口：按**原 requestId** 查云端回执，再决定它的命运。
//   三种结果，三种处置，没有第四种：
//     succeeded ⇒ 云端确实提交过 ⇒ 收敛（能回读就当场出队，读不了就标 settled 继续投影）；
//     failed    ⇒ 云端明确失败 ⇒ 归档出队 + 撤回完课意图（回执与业务同一事务，失败即没写）；
//     查不到 / processing ⇒ **保留等待**，本轮不再碰它。
// ⚠️ 绝不换 requestId 重发：换号等于放弃幂等，可能真的造出两条业务（重复扣课时 / 重复记收入）。
// ⚠️ 也绝不因为"它卡在队首"就把它删掉 —— 它是这条业务事实在本机的唯一凭据。
async function resolveUnknownByReceipt(current, ui, entry, budget) {
  // ⚠️ 发送链不具备查回执能力时**绝不**因此把队列卡死：无从取证就退回既有的"原号重发"路径。
  if (!ui || !ui.adapter || typeof ui.adapter.getReceipt !== 'function') return 'resend'
  let receipt = null
  try { receipt = await ui.adapter.getReceipt(entry.requestId) } catch (error) { receipt = null }
  // ⚠️⭐ **"查询失败"与"云端明确说没有"是两件事，绝不能混**（2026-09-28 真机第 5 次修正）：
  //   `!receipt.ok` = 我这边没问出来（网络 / 云函数异常 / 超时）⇒ **对云端状态零信息**；
  //   `receipt.found === false` = 云端明确答复"这个编号从来没被受理过" ⇒ 那是**确定事实**。
  //   把前者当后者 ⇒ 会拿"没问到"当"没收到"，进而做出错误的结论（旧版就栽在这里：
  //   查询失败直接进 blocked，同实体后续被永久冻结）。
  //   ⇒ 返回独立结论 `probe-failed`，由主循环单独处置（只 stall，绝不重发、绝不冻结后续）。
  if (!receipt || !receipt.ok) return 'probe-failed'
  // ★ 回执**明确**说"云端没有这个编号" ⇒ 云端从未受理过它
  //   （收据与业务写在同一事务里，没受理就不可能有收据）。
  //
  //   ⚠️ 但"没受理过"**不等于**"必须立刻再发一次"（2026-09-28 真机：attempts 累到 47）。
  //     重发前必须先过一遍「业务事实」这道闸 —— Content 类命令是**覆写**，不是累加：
  //     万一其间这份事实已经通过别的路径落到云端了，再发一次会把**更新的内容**覆盖回旧版本。
  //     判据见 `decideAfterNoReceipt`。
  if (!receipt.found) return await decideAfterNoReceipt(current, ui, entry, budget)
  const source = receipt.response || receipt
  if (receipt.status === 'succeeded') {
    const pairs = idPairs(entry, source)
    if (Object.keys(pairs).length) { outbox.recordIdMap(current, pairs); projection.invalidate() }
    settleTrainingDraft(current, entry)
    let refreshed = null
    try { refreshed = await ui.adapter.readActive() } catch (error) { refreshed = null }
    if (refreshed && refreshed.ok) { settleIntents(current, [entry]); outbox.remove(current, entry.entryId) }
    else outbox.setStatus(current, entry.entryId, 'settled', { settledRevision: settledRevisionOf(source), attempts: 0, nextAttemptAt: 0 })
    return 'done'
  }
  if (receipt.status === 'failed') {
    const failure = outbox.reject(current, entry.entryId, (source && source.code) ? source : { code: 'COMMAND_FAILED', message: '云端执行失败。' })
    settleIntents(current, [entry])
    lastFailure = failure
    return 'rejected'
  }
  return 'wait'
}

async function runFlush(options = {}) {
  // 受控补发（2026-09-22）：`step` = **一次调用恰好一条命令**（= 最多一次 `adapter.execute`），
  // 且**结论未知/乐观锁冲突都当场停手**，不在同一次调用里重试。非 step 的语义一个字没改 ——
  // 它只是把「整轮排空」收紧成「一步」。配合门禁的受控补发授权（只放行被点名的 entryId），
  // 就能做到「逐条推进、逐条验证」，而不是解冻后让 FIFO 把整队一次性发完。
  const step = options.step === true
  const ui = require('./ui-cloud-command')
  const current = scope()
  if (!current) return { ok: false, code: 'SYNC_NO_SCOPE', sent: 0, rejected: 0, remaining: pendingAnywhere() }
  if (recoveryGuard.blocksBusiness(current.environment, { resendStep: step })) return { ok: true, code: 'PRODUCTION_RECOVERY_READ_ONLY', sent: 0, rejected: 0, remaining: outbox.count(current) }
  if (!ui.isCloudWritable || !ui.isCloudWritable()) return { ok: true, code: 'SYNC_OFFLINE', sent: 0, rejected: 0, remaining: outbox.count(current) }
  await purgeSettled(current, ui)
  // 先把「本机不知道云端 revision」这个前置条件补齐：否则下面第一条命令会在**出网前**被拒。
  await ensureRevision(ui)
  // 上一次进程被杀时停在 inflight 的条目（本机还没拿到结论）：复位成 pending，用**原号**重发。
  // 号不变 ⇒ 云端 receipt 会把它认成同一次请求，绝不会在云端变成两条业务。
  outbox.list(current).filter(entry => entry.status === 'inflight' && !recoveryGuard.blocksEntry(current, entry)).forEach(entry => outbox.setStatus(current, entry.entryId, 'pending', { attempts: Number(entry.attempts || 0) }))
  const stall = new Set()
  // 本轮里**判定为推不动**的条目：它们没有消失，用来给后面的条目做依赖判定 ——
  //   同实体 / 引用其产物的必须继续等，其余无关条目可以越过（见 dependsOnEarlier）。
  // ⚠️ 只有**真的尝试过发送并失败**（unknown 退避 / 环境切换）的条目才进这里；
  //    「目标还没转正」「同段取消未落云」这类只是在**等条件**，它们**不阻挡同实体后续** ——
  //    否则一条还没轮到的命令会把整个实体链冻住（既有真机语义原本就不是这样）。
  const blocked = new Set()
  // 本轮里已经为哪几条补过一次 revision（每条最多补一次，避免任何形式的原地打转）。
  const revisionRepair = new Set()
  // ★ 「为了判一条 unknown 去读云端」的**每轮总预算**：一轮最多一次。
  //    真机的 readActive 可能是 10 页读（§85 实测 9~19 秒），放任每个 unknown 各自读一次，
  //    会把写航位重新堵出"取消要等 11 秒"的老样子 —— 那是好不容易才修掉的。
  const factBudget = { reads: 0 }
  let sent = 0, rejected = 0, iterations = 0
  // step 模式的**真正判据**：这一轮里调用过多少次 `adapter.execute`。
  // 旧写法数的是 `sent + rejected`，而「结果未知」「revision 冲突」这两支**两个都不计** ——
  // 于是同一次 step 会对着**同一条**命令反复 execute（2026-09-22 真机量化实测 = 3 次）：
  // 幂等号不变所以云端不会多出业务，但"一次点击到底发了几条"就再也说不清了，
  // 而"能说清一次点击发了几条"正是恢复期唯一重要的可控性。现在直接数 execute 调用本身。
  let executed = 0
  for (;;) {
    if (recoveryGuard.blocksBusiness(current.environment, { resendStep: step })) break
    // step 模式：**恰好一条** —— 只要已经调用过一次 adapter.execute 就收工，无论结局是什么。
    // 放在循环头统一判，是为了让所有分支都走同一道闸（不靠各分支自觉：漏一个分支就等于放开整队）。
    // ⚠️ 判据是 `executed`（真的调过几次发送链），**不是** `sent + rejected`：后两者在
    //    「结果未知」「revision 冲突」这两支上都不计，用它当闸门等于对同一条命令连发（实测 3 次）。
    if (step && executed >= 1) break
    if ((iterations += 1) > 400) break
    const entries = outbox.sendable(current).filter(entry => !stall.has(entry.entryId))
    if (!entries.length) break
    // ★ 按依赖链挑第一条**推得动**的（真机根因：队首 1 条 unknown 让 25 条 pending 永不出网）。
    //   blocked 为空时它与原来的 `entries[0]` **逐字等价**，既有语义一个字都没改。
    const idMap = outbox.idMap(current)
    const blockedList = outbox.list(current).filter(item => blocked.has(item.entryId))
    const entry = entries.find(item => !dependsOnEarlier(item, blockedList, idMap)) || null
    if (!entry) break
    // ★ 环境硬隔离：条目属于另一个数据环境 ⇒ **一次都不许出网**（Sandbox 条目绝不能进 Production）。
    if (entry.environment && entry.environment !== current.environment) { stall.add(entry.entryId); blocked.add(entry.entryId); continue }
    // 全局 FIFO 不跳过被救援冻结的课程；后续条目保持原号原序，避免跨实体引用越序。
    if (recoveryGuard.blocksEntry(current, entry)) break
    const attempts = Number(entry.attempts || 0)
    // ★★ 到顶（冷却）的 unknown —— 两种时刻，两种处理，**绝不能一刀切短路**（2026-09-28 第 5 次修正）：
    //   ① **冷却还没到期** ⇒ 本轮只 stall（不入 blocked：同实体的后续命令可以先走，
    //      避免一条推不动的老命令把整条实体链冻到天荒地老 —— 真机 3 unknown + 5 pending 就是这个形状）。
    //      顺序为什么仍然安全：等它被越过之后，后续那条会先落云并**作为接管证据被扣在队列里**
    //      （`neededAsSupersedeEvidence`），老的那条下次评估时会被 SUPERSEDED 出口收掉，不会回头覆盖新内容。
    //   ② **冷却到期了** ⇒ ⚠️ 必须**往下走完整收口**：查回执 → 事实已在 / TARGET_GONE / SUPERSEDED。
    //      旧版在这里直接 stall，于是"到顶"成了终身监禁：attempts=47 那条从新版本落地起
    //      一次回执都没查过、三个安全出口一次都没跑过（复现 `tests/_repro108-capped.js` 已证）。
    const cooling = entry.status === 'unknown' && attempts >= UNKNOWN_ATTEMPT_CAP
    if (cooling && Number(entry.nextAttemptAt || 0) > Date.now()) { stall.add(entry.entryId); continue }
    // ★ 退避中的 unknown（**未到顶**）：stall（本轮不碰它，后面的无关条目照推）而**不是结束整轮**。
    //   旧写法在这里 `break` —— 真机上正是这一行让队首那 1 条 unknown 把后面 25 条 pending 全拖死。
    if (entry.status === 'unknown' && !cooling && attempts >= 3 && Number(entry.nextAttemptAt || 0) > Date.now()) { stall.add(entry.entryId); blocked.add(entry.entryId); continue }
    // ★ unknown 且**出过网**：先按原 requestId 查云端回执再决定，绝不贸然重发。
    if (entry.status === 'unknown' && !neverSent(entry)) {
      const verdict = await resolveUnknownByReceipt(current, ui, entry, factBudget)
      if (verdict === 'done') { sent += 1; projection.invalidate(); notify(); continue }
      // 事实已经在云端（回执说没受理过，但业务事实确实存在）⇒ 按已认可处理，**一次都不再发**。
      if (verdict === 'landed') { projection.invalidate(); notify(); continue }
      if (verdict === 'rejected') { rejected += 1; projection.invalidate(); notify(); continue }
      // ⚠️ **回执查询失败 ≠ 云端没收到**（2026-09-28）：查不到回执只是"我没问出来"，
      //   既不能当成 found=false（那是云端明确答复"没这个号"），也**绝不能因此重发**（铁律）。
      //   ⇒ 只 stall、**不入 blocked**：否则一次持续的网络/云函数异常会把同实体后续命令永久冻结。
      if (verdict === 'probe-failed') {
        outbox.patch(current, entry.entryId, { probeFails: Number(entry.probeFails || 0) + 1 })
        stall.add(entry.entryId)
        continue
      }
      if (verdict !== 'resend') {
        stall.add(entry.entryId)
        // 冷却中的条目**不许**再当 blocker（它已经松过一次手了，见上面冷却分支的说明）；
        // 其余"拿不到结论"的条目维持既有语义：只 stall + blocked，同实体继续保序。
        if (!cooling) blocked.add(entry.entryId)
        continue
      }
    }
    // 「目标课程还没转正」「同段取消还没落云」都只是在**等条件**，不是失败 ⇒ 只 stall，不阻挡同实体。
    const payload = resolvePayload(current, entry, ui)
    if (payload === null) { stall.add(entry.entryId); continue }
    if (heldByCancel(current, entry)) { stall.add(entry.entryId); continue }
    outbox.setStatus(current, entry.entryId, 'inflight', { attempts: attempts + 1 })
    let result
    executed += 1
    try { result = await ui.adapter.execute(entry.command, payload, { requestId: entry.requestId }) } catch (error) {
      // 引擎自己这一层抛错（不是 adapter 的返回）也要留下可复原的原因，别只留一个码。
      result = {
        ok: false, code: 'COMMAND_RESULT_UNKNOWN', retrySafe: true,
        reason: 'ENGINE_EXECUTE_THREW', message: '同步引擎调用发送链时抛错。',
        technicalMessage: String((error && (error.errMsg || error.message || error.code)) || '').slice(0, 300)
      }
    }

    if (result && result.ok) {
      const pairs = idPairs(entry, result)
      if (Object.keys(pairs).length) { outbox.recordIdMap(current, pairs); projection.invalidate() }
      // ★ 这份训练内容已经**确认落在云端的正式课程上** → 本机草稿使命完成，立刻清掉。
      //   只清"已交付"的那一份；被云端拒绝的条目走下面的 reject 分支，草稿必须原样留着（页面还要重试）。
      settleTrainingDraft(current, entry)
      // ★ 与 purgeSettled 同源：**条目真的离开队列**就得上报一次（页面才会从「完成同步中」翻成「已完成」）。
      //   ⚠️ 2026-10-04 修复：这里曾**丢失** `broadcastSettled([entry])` —— 是 tests/_m2-settled-broadcast-mutate.js
      //   的变异体被留在磁盘上（它 restore() 拿到的"原文"本身就是变异后的，于是还原不回去）。
      //   证据：① 本行上方的注释明写"条目真的离开队列就得上报一次"；② 该变异脚本的 to 形态与本行逐字相同；
      //   ③ 永久测试 sandbox-outbox-convergence ⑧「完课出队必须广播 bookingCompleted」判红且实得 []。
      if (result.refreshed && result.refreshed.ok) { settleIntents(current, [entry]); outbox.remove(current, entry.entryId); broadcastSettled([entry]) }
      // 云端已提交、只是本机 cache 还没跟上：**绝不重发**，先按"已确认"在本机继续投影
      // （界面不会回退、也不会重复计一次），等 cache 追上之后再让它出队 ——
      // 判据是 `cache.revision >= settledRevision`（见 cacheCaughtUp），不再是"做一次完整读取"。
      else {
        outbox.setStatus(current, entry.entryId, 'settled', { settledRevision: settledRevisionOf(result), attempts: 0, nextAttemptAt: 0 })
        // ★ 1.1.9 第 6 轮：命令成功时不再顺手补齐本机 cache（只做一跳只读校验）。
        // ★ 1.1.9 第 14 轮（真机账本定案，§85）：settled 的出口收尾**不再靠一次读取**
        //   —— purgeSettled 改成"cache 追上才出队"（零云调用，见该函数上方长注释）。
        //   于是这里排的这一轮是**纯本机的、不占航位、不发任何云调用**的：
        //     若 cache 此刻已经追上（例如别的读取刚把它刷上来）⇒ 当场免费清掉；
        //     没追上 ⇒ 条目继续留在队列里承担投影，等下一次自然读取后再免费清掉。
        //   ⇒ 命令成功后**不再有任何一次 10 页完整读取去占住写航位**，
        //     这正是"取消 A 要等 11 秒 / B 要等 5 秒 / 手机第一次下拉看不到 B"的根因。
        //   settled 不在 sendable 里，不主动排一次就没人会再来收尾它（第 6 轮的真机教训：
        //   课表永远显示"完课中"）—— 这一行因此保留，只是它现在**不花钱**了。
        schedule()
      }
      sent += 1
      projection.invalidate()
      // ★ 取消的推进（1.1.9 第 7 轮）：这一条 create **刚刚在云端落地** ⇒ 那条因为 create 还没落定
      //   而只能停在 `waiting` 的取消，现在才有结论可用 —— 它正是「B 能不能出网」与「A 会不会
      //   永远留在云端」的关键。这里只叫醒一次、只针对同一时段（判据在 booking-optimistic 里，
      //   与本文件前面的 heldByCancel 同源）；入口不存在（测试替身 / 旧版本）就安静跳过。
      if (entry.command === 'createBooking' && typeof ui.advancePendingCancellations === 'function') {
        try { await ui.advancePendingCancellations(payload) } catch (error) {}
      }
      notify()
      continue
    }

    const code = (result && result.code) || 'COMMAND_RESULT_UNKNOWN'
    // ★ 「本机还不知道云端 revision」= 命令**压根没出网**（adapter 在 callCloud 之前就返回了）。
    //   它既不是业务拒绝（云端没收到过），也不是"结果未知"（根本没有结果可言）。
    //   把它当成明确拒绝归档，等于把一条本来一定会成功的业务记成**永久失败**，
    //   还让用户背上一句假话「已按云端为准」——而云端连这条命令都没听过。
    //   正确处置：补一次 revision，然后**用同一个号**重试（号不变 ⇒ 云端 receipt 仍认同一次业务）。
    //   补不到就原地退避等下一轮，**绝不归档、绝不打扰用户、绝不换号**。
    if (code === 'REVISION_UNKNOWN') {
      if (revisionRepair.has(entry.entryId)) { outbox.setStatus(current, entry.entryId, 'pending', { nextAttemptAt: Date.now() + delayMs(attempts + 1) }); break }
      revisionRepair.add(entry.entryId)
      const ready = await ensureRevision(ui)
      if (!ready) { outbox.setStatus(current, entry.entryId, 'pending', { nextAttemptAt: Date.now() + delayMs(attempts + 1), lastError: { code, message: '本机尚未取得云端 revision，稍后自动重试。' } }); break }
      // 这一轮没有真的"尝试过"：把发送前的 attempts +1 还回去（否则纯本机前置条件会把重试预算耗光）。
      // ⚠️ 但**必须留下 lastError**：`neverSent` 判据（页面/采集里）读的就是 `lastError.code === 'REVISION_UNKNOWN'`，
      //    不写它就等于对外宣称"这条出过网"，下一条命令就会被误当成 sent-but-unknown 去查回执。
      outbox.setStatus(current, entry.entryId, 'pending', { attempts, lastError: { code, message: '本机当时还不知道云端 revision，这条命令从未出网；revision 已补齐。' } })
      // step 模式：这一次 adapter.execute 已经算掉了一步（它刻意在**出网前**返回）。
      //   ⇒ 必须停手：宁可让人再点一次，也绝不在同一次点击里接着发第二条命令。
      if (step) break
      continue
    }
    if (code === 'REVISION_CONFLICT') {
      let refreshed = null
      try { refreshed = await ui.adapter.readActive() } catch (error) { refreshed = null }
      // 非 step：照旧"取回真 revision → 用同一个号重试"（有界，最多 5 次）。
      // step：**一律停手** —— 一次点击只能有一次 execute，这里再 continue 就是第二次。
      //   冲突是**真·尝试过**（命令真的出网并撞了乐观锁），所以 attempts 照常 +1、退避照常排。
      if (!step && attempts + 1 < 5 && refreshed && refreshed.ok) { outbox.setStatus(current, entry.entryId, 'pending', { attempts: attempts + 1, nextAttemptAt: 0 }); continue }
      outbox.setStatus(current, entry.entryId, 'pending', { attempts: attempts + 1, nextAttemptAt: Date.now() + delayMs(attempts + 1), lastError: errorRecord(code, result) })
      break
    }
    if (code === 'COMMAND_RESULT_UNKNOWN' || code === 'REQUEST_PROCESSING') {
      let receipt = null
      try { receipt = await ui.adapter.getReceipt(entry.requestId) } catch (error) { receipt = null }
      if (receipt && receipt.ok && receipt.found && receipt.status === 'succeeded') {
        const pairs = idPairs(entry, receipt.response || receipt)
        if (Object.keys(pairs).length) { outbox.recordIdMap(current, pairs); projection.invalidate() }
        // 回执说"云端确实提交了" → 这份训练内容确认落云，本机草稿使命完成。
        settleTrainingDraft(current, entry)
        // ⚠️ 但「云端提交了」≠「本机已经同步到位」。出队的前提必须是**这次真的成功完整回读**：
        //    条目一旦离开队列，投影就不再套用它。如果此刻 cache 还是旧值（回读失败），
        //    把它移出队列 = 课表当场从「已完」退回「待上」，而云端其实早已完成 ——
        //    用户看到的就是"点过下课的课又变回没完成"，且这个谎永远不会被纠正。
        //    所以回读失败时只把它标成 settled（继续参与投影、且**绝不重发**），等一次成功回读再出队。
        let refreshed = null
        try { refreshed = await ui.adapter.readActive() } catch (error) { refreshed = null }
        if (refreshed && refreshed.ok) { settleIntents(current, [entry]); outbox.remove(current, entry.entryId) }
        else {
          const confirmed = receipt.response || receipt
          outbox.setStatus(current, entry.entryId, 'settled', { settledRevision: settledRevisionOf(confirmed), attempts: 0, nextAttemptAt: 0 })
          // 同上：settled 不在 sendable 里，不主动排一次就没人会再来收尾它。
          schedule()
        }
        sent += 1
        projection.invalidate()
        notify()
        continue
      }
      if (receipt && receipt.ok && receipt.found && receipt.status === 'failed') {
        const failure = outbox.reject(current, entry.entryId, (receipt.response && receipt.response.code) ? receipt.response : { code: 'COMMAND_FAILED', message: '云端执行失败。' })
        settleIntents(current, [entry])
        rejected += 1
        lastFailure = failure
        projection.invalidate()
        notify()
        continue
      }
      outbox.setStatus(current, entry.entryId, 'unknown', { attempts: attempts + 1, nextAttemptAt: Date.now() + delayMs(attempts + 1), lastError: errorRecord(code, result) })
      // ★ 刚刚**越过**重发上限 ⇒ **当场**把冷却状态写进条目（2026-09-28）：
      //   冷却只能在"越过上限的这一刻"或"冷却到期后评估完仍无出口"两处装配。
      //   少了这一处，条目会停在 30 秒的普通退避里 —— 而冷却判定要等 nextAttemptAt 到期才肯走，
      //   于是它既进不了冷却、也永远等不到一次完整评估（真机上的形状就是"数字一动不动"）。
      if (attempts + 1 >= UNKNOWN_ATTEMPT_CAP) armCooldown(current, entry, attempts + 1)
      // step 模式：**结论未知 = 当场停手**。旧写法会在这里 continue，于是同一次点击里对着同一条
      //   命令反复 execute（实测 3 次）—— 号不变所以云端不会多出业务，但"这一步到底发生了什么"
      //   就彻底糊了：既看不出是网络抖动还是云函数异常，也数不清发了几条。
      //   现在是"一次点击一条、一条一个结论"，下一次点击由人来决定。
      if (step) break
      if (attempts + 1 >= 5) break
      continue
    }
    if (code === 'OFFLINE_READ_ONLY') {
      outbox.setStatus(current, entry.entryId, 'pending', { attempts: 0, nextAttemptAt: Date.now() + 15000 })
      break
    }
    // ★ 排序问题 ≠ 业务冲突：云端说"这个时段有课"，而**本机此刻有证据**同一时段存在一条
    //   尚未落云的取消 ⇒ 那节"有课"正是我们要取消的那条 A。真机 23:23:13 的
    //   BOOKING_TIME_CONFLICT 就是这么来的（§80：B 比 A 的取消早 13.5 秒到云端）。
    //   把它当成普通失败归档 = 让用户再点一次预约；而第二次点击会拿到**新的 requestId**，
    //   云端幂等靠号，换号就等于放弃幂等（也可能真的造出两条）。
    //
    //   正确处置：**保持原号**、原地等，取消落云后由 runCancel 收尾的 schedule 自动重发。
    //   同号重发是安全的：被业务拒绝的命令在云端事务里回滚，**连 receipt 都没写进去**
    //   （core.js 只在成功时落 receipt）⇒ 重发不是"重放一次失败"，而是真正再执行一次。
    if (code === 'BOOKING_TIME_CONFLICT' && sameSlotUnresolvedCancels(current, entry).length) {
      const rounds = Number(entry.cancelConflict || 0) + 1
      if (rounds <= CANCEL_CONFLICT_ROUNDS) {
        outbox.patch(current, entry.entryId, {
          status: 'pending',
          cancelConflict: rounds,
          // 这一轮**没有真的尝试过**（撞的是排序，不是业务），把发送前的 attempts +1 还回去。
          attempts,
          nextAttemptAt: 0,
          lastError: { code, message: '同一时段有一条尚未落云的取消；等它落云后用同一个编号自动重发。' }
        })
        // 本轮不再碰它（stall 而不是 break：同一队列里别的条目照发，绝不整队堵死）。
        stall.add(entry.entryId)
        projection.invalidate()
        notify()
        // 谁来叫醒它：正常情况下那条取消落云时 runCancel 的收尾会 schedule 一次。
        // 但**那条取消自己也可能还停在 waiting**（等正式 id），那时没有别的事件会再来一轮；
        // 这里补一次**有界**的再排（轮次已在上面封顶），避免一条能成功的预约无限期悬着。
        if (typeof setTimeout === 'function') setTimeout(() => schedule(), 0)
        continue
      }
      // 超过有界轮次 ⇒ 不再替用户兜：照下面的既有路径如实归档（**有界、可见**的失败）。
    }
    // ★ 环境切换**不是**业务拒绝（2026-09-27 真机：failed 档案里出现了 ENVIRONMENT_CHANGED）。
    //   它只说明"发这一条的时候数据环境已经不是它所属的那个"：
    //   命令可能根本没送出去，也可能已经提交 —— 本机无从判断。
    //   把它当"明确拒绝"归档 = 丢掉一条业务事实，还给用户一句假的「已按云端为准」。
    //   正确处置：**保留原号**、原地等，等环境回到这条条目所属的环境再由下一轮发送。
    // ⚠️ 绝不改写它的 environment / datasetId —— Sandbox 条目永远不许被送去 Production。
    if (code === 'ENVIRONMENT_CHANGED') {
      outbox.patch(current, entry.entryId, {
        status: 'pending', attempts, nextAttemptAt: 0,
        lastError: { code, message: '发这条时数据环境已切换，保留原编号等待环境回归后重发。' }
      })
      stall.add(entry.entryId); blocked.add(entry.entryId)
      continue
    }
    // 明确的业务拒绝（云端是裁判）：出队留档 → 取回云端真相 → 轻提示（只用 toast，不遮屏）
    const failure = outbox.reject(current, entry.entryId, result)
    // ★ 云端说"这次完课没成立"——本机那条「完课意图」必须**当场撤回**，否则课表会一直
    //   把这条课显示成「已完」，而云端从来没有这门已完成的课：用户看到的就是一个永不纠正的谎。
    //   （自愈契约：明确失败 → 撤回标记 + 如实告知；只有"结果未知"才允许保留标记等回执。）
    settleIntents(current, [entry])
    rejected += 1
    lastFailure = failure
    try { await ui.adapter.readActive() } catch (error) {}
    projection.invalidate()
    try { wx.showToast({ title: '有 1 项操作没能同步，已按云端为准', icon: 'none' }) } catch (error) {}
    notify()
    continue
  }
  // `executed` 一并对外报出：受控补发时它是"这一次点击到底发了几条命令"的唯一权威数字。
  lastSummary = { ok: rejected === 0, sent, rejected, executed, remaining: outbox.count(current), at: Date.now() }
  return lastSummary
}

// 单航班：同一时刻只有一轮同步。多次触发只会复用同一轮。
//
// ⚠️ 「复用同一轮」≠「什么都不做」（1.1.9 第 12 轮）：在途期间发出的 schedule 请求会被记进
//   `rerunRequested`，本轮结束后**立刻再跑一轮** —— 这正是「取消落云 ⇒ 等待中的 B 立刻出网」
//   那一次唤醒。step（受控补发）不参与：一次点击只能有一条命令，补一轮会把这条边界打破。
function flush(options = {}) {
  const wantsStep = options.step === true
  if (running) { if (!wantsStep) rerunRequested = true; return running }
  const task = runFlush(options)
    .catch(error => ({ ok: false, code: 'SYNC_ENGINE_ERROR', message: String(error && error.message), sent: 0, rejected: 0 }))
    .then(result => {
      if (running === task) running = null
      if (rerunRequested) { rerunRequested = false; return flush() }
      return result
    })
  running = task
  return task
}
// 受控补发的唯一入口：先等当前那一轮走完（否则会把在途那一轮的结果当成自己的结果），再走**一步**。
async function step() { await whenIdle(); return flush({ step: true }) }
// 触发用的轻量入口：合并同一轮事件循环里的多次触发。
function schedule() {
  if (scheduled) return
  scheduled = true
  const run = () => { scheduled = false; flush() }
  if (typeof setTimeout === 'function') setTimeout(run, 0)
  else run()
}

// 「上一次失败的原因现在不成立了」——网络恢复、进程重开、回到前台。
//
// 退避是为了别把一台**正在出故障的服务器**往死里打；但上面这三种情况下，
// 上一次失败的真正原因是"没网 / 上一进程已经死了"，那个原因此刻已经消失。
// 如果不解除退避，用户明明恢复了网络，还要干等 16~30 秒才同步，本机与云端长时间不一致
// （杀进程重开也一样：退避时钟是上一进程留下的，对这一个进程毫无意义）。
//
// 只清 nextAttemptAt，**不动 attempts、不动 requestId**：退避曲线与幂等号一个字都不变，
// 失败的次数照样累计，只是把"等一下"这个前提去掉。
function resume() {
  const current = scope()
  if (current && recoveryGuard.blocksBusiness(current.environment)) return Promise.resolve({ ok: true, code: 'PRODUCTION_RECOVERY_READ_ONLY', sent: 0, rejected: 0, remaining: outbox.count(current) })
  if (current) {
    outbox.list(current)
      .filter(entry => !recoveryGuard.blocksEntry(current, entry) && (entry.status === 'pending' || entry.status === 'unknown') && Number(entry.nextAttemptAt || 0) > 0)
      .forEach(entry => outbox.setStatus(current, entry.entryId, entry.status, { nextAttemptAt: 0 }))
  }
  return flush()
}
// ★ 「这一条现在在等谁」——给页面用的**只读**依赖查询（2026-09-28 真机：3 unknown + 5 pending）。
//
//   队列里只看得见"还剩几条"，看不见"它们为什么不动"；没有这一层，每次定位都只能靠猜。
//   这里返回**挡在它前面**的那几条（与 runFlush 的推进判定同一个 `dependsOnEarlier`，口径绝不另写一套）：
//     · 同一实体（entityKey 经 idMap 归一后相同）⇒ 必须按先后落地；
//     · 引用了前面某条将要产出的本机临时 id ⇒ 得等那条先转正。
// ⚠️ 只读：一个字节都不改，也不发任何云调用。
function dependencyBlockers(scope, entry) {
  if (!scope || !entry) return []
  const rows = outbox.openEntries(scope)
  const map = outbox.idMap(scope)
  const key = entityKeyOf(entry, map)
  return rows.filter(other => other && other.entryId !== entry.entryId && Number(other.seq || 0) < Number(entry.seq || 0) && dependsOnEarlier(entry, [other], map))
    .map(other => ({
      entryId: other.entryId, seq: Number(other.seq || 0), command: other.command, status: other.status,
      attempts: Number(other.attempts || 0),
      reason: entityKeyOf(other, map) === key ? '同一课程/同一动作项，必须按先后落地' : '引用了它产出的临时编号'
    }))
}
// ⭐ **只读诊断**：把某一条队列条目"为什么还没走"翻译成人能读的原文（2026-09-28 真机：8 条残留）。
//
// ⚠️ 三条硬规矩：
//   ① **零云调用**、零副作用 —— 只翻本机 outbox 与**刚读过的那版权威快照**；
//   ② 只回答"三个安全出口各自为什么不成立"，**不替任何一条下结论**；
//   ③ 只有 Sandbox 验收页会用（会员产品 UI 一律不接）。
//
// 为什么必须做成引擎里的函数而不是页面里现拼：出口的判据（factVisible / targetGone / superseded）
//   全在引擎里，页面另写一份必然与真实判定**慢慢走偏** —— 那就等于用一份假账做诊断。
function diagnoseEntry(scope, requestId) {
  const entry = outbox.list(scope).find(row => row && row.requestId === requestId) || null
  if (!entry) return null
  const map = outbox.idMap(scope)
  const cache = cacheSnapshot() || {}
  const snapshot = cache.snapshot || null
  const id = bookingTargetId(entry, map)
  const list = Array.isArray(snapshot && snapshot.bookings) ? snapshot.bookings : []
  const row = id ? list.find(item => item && item.id === id) || null : null
  const supplied = overlapFields(entry)
  const reason = { }
  // 出口①：事实已在
  if (entry.command !== 'updateBookingContent') reason.factVisible = '仅内容类命令支持（本条是 ' + String(entry.command) + '）'
  else if (!id) reason.factVisible = 'payload 里没有 bookingId'
  else if (isLocalId(id)) reason.factVisible = '目标还是本机临时编号（' + id + '），尚未转正'
  else if (!row) reason.factVisible = '云端快照里没有这节课（' + id + '）'
  else if (!supplied.length) reason.factVisible = 'payload 里没有可比对的内容字段'
  else if (!contentFactVisible(entry, snapshot, map)) reason.factVisible = '云端当前内容与本条要写的内容不同（本条这份还没落云）'
  else reason.factVisible = '命中：云端里已是这一份内容'
  // 出口②：目标消失
  if (entry.command !== 'updateBookingContent') reason.targetGone = '仅内容类开放（不可逆结论，课时/金额类一律不宣判）'
  else if (!id || isLocalId(id)) reason.targetGone = '目标 id 尚未转正，谈不上消失'
  else if (!list.length) reason.targetGone = '快照里一门课都没有（更像没读到，不能当证据）'
  else if (row) reason.targetGone = '目标课程仍在（' + id + '）'
  else reason.targetGone = '命中：目标已不在云端'
  // 出口③：被更晚版本接管
  const winner = supersededBy(scope, entry)
  reason.superseded = winner
    ? '命中：更晚的 #' + Number(winner.seq || 0) + '（' + String(winner.requestId) + '）已落云并接管'
    : '队列里没有更晚、同实体、同命令且**已落云**（settled）的内容命令'
  return {
    seq: Number(entry.seq || 0),
    command: String(entry.command || ''),
    requestId: String(entry.requestId || ''),
    // ★ §110：盘上这个号**原样不动**（它是业务幂等身份），但云端只认得派生的合法别名。
    //   真机取证时这一列最关键：看到两者不同，就说明这条曾经带非法号出过网（云端必然拒收）。
    wireRequestId: String(requestIdRule.wireRequestId(entry.requestId) || ''),
    requestIdLegal: requestIdRule.isLegalRequestId(entry.requestId),
    requestIdVerdict: requestIdRule.requestIdVerdict(entry.requestId).code,
    cloudRejectedId: requestIdRule.cloudRejectedRequestId(entry.lastError),
    entityKey: String(entry.entityKey || ''),
    status: String(entry.status || ''),
    attempts: Number(entry.attempts || 0),
    nextAttemptAt: Number(entry.nextAttemptAt || 0),
    probeFails: Number(entry.probeFails || 0),
    cooldown: entry.cooldown ? clone(entry.cooldown) : null,
    lastError: entry.lastError ? clone(entry.lastError) : null,
    payloadFields: supplied,
    payloadKeys: Object.keys(entry.payload || {}),
    targetId: id,
    cloudRowFound: !!row,
    cloudRow: row ? { id: row.id, status: row.status, items: Array.isArray(row.items) ? row.items.length : null, notes: typeof row.notes === 'string' ? row.notes.slice(0, 60) : null, updatedAt: row.updatedAt == null ? null : row.updatedAt } : null,
    cacheRevision: Number.isInteger(cache.revision) ? Number(cache.revision) : null,
    blockers: dependencyBlockers(scope, entry),
    exits: reason
  }
}
// 一次性把当前队列逐条诊断出来（只读，Sandbox 诊断页专用）。
function diagnoseQueue(scope) {
  const rows = outbox.openEntries(scope) || []
  return rows.map(row => diagnoseEntry(scope, row.requestId)).filter(Boolean)
}
function whenIdle() { return running || Promise.resolve() }

module.exports = {
  flush,
  step,
  resume,
  whenIdle,
  schedule,
  subscribe,
  notify,
  scope,
  pendingAnywhere,
  subscribeFailure: listener => subscribe(() => { if (lastFailure && typeof listener === 'function') listener(clone(lastFailure)) }),
  lastFailure: () => clone(lastFailure),
  lastSummary: () => clone(lastSummary),
  dependencyBlockers,
  // 只读诊断出口（零云调用、零副作用，仅 Sandbox 验收页可用）
  diagnoseEntry,
  diagnoseQueue
}
