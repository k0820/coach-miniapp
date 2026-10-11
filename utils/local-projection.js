// 本机投影（阶段 2：Local-first + Cloud Sync）。
//
// 一份数据，两个来源：
//   ① 云端已确认的快照（coachCloudActiveCache.snapshot，revision 是云端给的）
//   ② 还在 Outbox 里、云端还不知道的本机意图
//
// 本机投影 = ① 按顺序叠加 ②。**页面永远只读这一份**，于是「点了立刻有反应」与
// 「云端仍是最终裁判」同时成立：用户看到的永远是「最后一帧已知事实」，而事实的来源
// 逐条可追溯（cache 里的 = 云端确认过的；叠加出来的 = 本机已算完、正在送).
//
// 关键设计（每一条都是踩出来的）：
//   · **绝不改 cache**：投影是只读派生，cache 仍然是「云端那份」。所以完整性校验（checksum /
//     integrity / 全量回读）依然只针对真正来自云端的东西，不会因为用户点了两下就失真。
//   · **同一份业务规则**：叠加用的就是云端那套 handlers（utils/local-transaction.js），
//     所以「本机先算出来的结果」与「云端复算出来的结果」逐字一致。
//   · **幂等保护来自 handlers 本身**：如果 base 里已经有这条事实（例如云端已提交、只是本机
//     cache 落后），handler 会照常抛 BOOKING_ALREADY_DONE / INCOME_ALREADY_EXISTS…
//     → 本机直接跳过，不会再叠一遍（课时不会扣两次、收入不会记两条）。
//   · **settled 条目的 revision 闸门**：云端已确认但 cache 还没跟上时继续投影；
//     一旦 base 的 revision ≥ 命令成功时的 revision，说明 cache 已经包含这条事实，立即停止叠加，
//     避免"叠加一次 + cache 里一次 = 两份"。
const outbox = require('./local-outbox')
const cancellation = require('./pending-cancellation')
const pendingBooking = require('./pending-booking-request')
const { applyCommand, rewriteIds, normalize } = require('./local-transaction')

// 投影结果只依赖这几样：数据集身份、base 的 revision、Outbox 的版本号、
// **以及队列里到底是哪几条**。最后一个不能省：版本号是每个桶各自的计数器，
// 两台不同的本机（或测试里的两个独立 Storage）完全可能同时停在「revision 0 + 版本 2」，
// 只按前三样做键就会把 A 机的投影当成 B 机的投影返回 —— 本机状态串了机。
// 取消待确认（tombstone）同样进入键：它一变，投影就必须重算（否则"取消之后还看得见"）。
const memo = new Map()

function projectKey(scope, revision, entries, cancels) {
  const tail = entries ? `|${entries.map(entry => entry.entryId).join(',')}` : ''
  const hidden = cancels && cancels.length ? `|x:${cancels.map(row => `${row.localKey}@${row.status}`).join(',')}` : ''
  return `${scope.environment}|${scope.datasetId}|${revision}|${outbox.version(scope)}${tail}${hidden}`
}

// 本机正在取消中的预约（只读，读不到就当没有 —— 绝不能因为一个附属存储读失败就让整份投影炸掉）。
function pendingCancels(scope) {
  try { return cancellation.list(scope.environment, scope.datasetId) } catch (error) { return [] }
}

// 取消记录在 base 里对应的那一行：正式 id 优先，其次按业务键（与视图层 mergeBookings 用**同一个**
// `pending.matches`，绝不在两处各写一套匹配规则）。
function cancelledRowId(db, record) {
  const list = Array.isArray(db.bookings) ? db.bookings : []
  if (record.officialId) {
    const byId = list.find(booking => booking && booking.id === record.officialId)
    if (byId) return byId.id
  }
  const hit = list.find(booking => pendingBooking.matches(record.payload, booking))
  return hit && hit.id ? hit.id : ''
}

// 返回叠加后的 db；没有任何本次意图（队列 + 取消）时返回 null
// （调用方直接用 base，零开销、零风险）。
function project(base, scope, revision) {
  if (!base || !scope || !scope.datasetId) return null
  const entries = outbox.openEntries(scope)
  const cancels = pendingCancels(scope)
  if (!entries.length && !cancels.length) { memo.delete(projectKey(scope, revision, entries, cancels)); return null }
  const key = projectKey(scope, revision, entries, cancels)
  const cached = memo.get(key)
  if (cached) return cached
  let db = normalize(base)
  const map = outbox.idMap(scope)
  // 已经点过取消的那条本机意图，绝不再叠加 —— 否则「11:00 约 A → 立刻取消 A → 立刻 11:00 约 B」
  // 会因为 A 的 createBooking 意图还留在投影里，被本机事务以 BOOKING_TIME_CONFLICT 挡下。
  const hiddenKeys = new Set(cancels.map(row => String(row.localKey || '')))
  // ★ 取消待确认先于本机意图生效 —— 顺序不能反，反了就是"取消不彻底"。
  //
  // 在这一步之前，tombstone 的**唯一**消费者是视图层 `mergeBookings()`（它只负责"块看不见"）。
  // 于是同一份数据被读成三种口径：课表渲染认识取消、约课弹层的冲突检测不认识、
  // 本机业务事务（createBooking 的 BOOKING_TIME_CONFLICT，与云端同一份 handlers）也不认识。
  // 结果就是「取消尚未确认 / 这条预约仍可能占用该时段」，而且连重新预约都被本机挡下 ——
  // 这不是文案问题，是「取消没进事实层」。现在它进来了，于是三方（视图 / 弹层 / 本机事务）
  // 同时松绑，而 cache 仍然一个字节都没改。
  //
  // ⚠️ **必须排在叠加 Outbox 意图之前**：`11:00 约 A → 取消 A → 立刻 11:00 约 B` 时，
  //    如果把 A 的摘除放在叠加之后，B 的 createBooking 意图会在"A 还没被摘掉"那一刻
  //    被本机事务以 BOOKING_TIME_CONFLICT 拒掉 —— 用户看到的正是那句"仍可能占用该时段"。
  //    （这是本轮实测踩出来的：顺序写反，新预约根本进不了投影。）
  //
  // 为什么用 `applyCommand(db, 'cancelBooking', …)` 而不是"直接删掉这一行"：
  //   本机投影叠加的必须是**与云端同一份业务规则**（这也是本文件的既定铁律）。
  //   云端 `cancelBooking` 的实际效果是「只删这一行，不碰课时包、不碰收入」——
  //   用它来算，本机与云端在同一个载荷上必然得到同一个结果；将来这条规则变了，
  //   本机也跟着变，不会漂移。算不出来（例如这条课已经是 done）就原样保留：
  //   云端同样会拒绝这次取消，两边一致。
  cancels.forEach(record => {
    const bookingId = cancelledRowId(db, record)
    if (!bookingId) return
    const applied = applyCommand(db, 'cancelBooking', { bookingId }, { now: () => record.startedAt })
    if (applied.ok) db = applied.db
  })
  entries.forEach(entry => {
    if (entry.applied === false) return
    if (entry.command === 'createBooking' && hiddenKeys.has(String(pendingBooking.bookingKey(entry.payload) || ''))) return
    // settled：云端已确认，只有在本机 cache 还没包含这条事实时才继续叠加。
    if (entry.status === 'settled' && Number.isInteger(entry.settledRevision) && Number.isFinite(Number(revision)) && Number(revision) >= Number(entry.settledRevision)) return
    const payload = rewriteIds(entry.payload, map)
    const applied = applyCommand(db, entry.command, payload, { now: () => entry.createdAt, id: kind => {
      const localId = (entry.localIds || {})[kind]
      return Object.prototype.hasOwnProperty.call(map, localId) ? map[localId] : localId
    } })
    if (applied.ok) db = applied.db
  })
  memo.set(key, db)
  if (memo.size > 8) memo.delete(memo.keys().next().value)
  return db
}

function invalidate() { memo.clear() }

module.exports = { project, invalidate, projectKey }
