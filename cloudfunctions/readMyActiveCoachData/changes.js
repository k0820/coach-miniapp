// 「这一段到底变了哪几行」——跨设备增量同步的**纯函数**实现（1.1.9 第 7 轮）。
//
// 为什么要有这一层。真机账本（2026-09-23）已经定案：
//   手机下拉一次 = 13 次云函数往返（1 首跳 + 1 metadata + 10 分页 + 1 末尾 integrity），
//   实测 6.9–11.7 秒。而「云端把八个集合读完算指纹」这一次调用自己只要 1.2–1.4 秒 ——
//   也就是说 **瓶颈不是云端读数据，而是「把整份数据从云端搬到手机」那 10 次分页往返**。
//   云端明明已经知道 `revision 213 → 214`、`bookings 174 → 173`，却没有任何接口能回答
//   「214 这一版具体改了哪一条」—— 于是唯一能拿到「变的那一条」的办法就是整份重搬。
//
// 本模块只做一件纯计算：给定
//   · `groups`    —— 云端**刚刚现读**的那八个集合（与 integrity 用的是同一批行）
//   · `receipts`  —— 命令收据（`coach_command_receipts` / `coach_sandbox_receipts`）
//   · `sinceRevision` / `toRevision`
// 算出「哪些业务行现在是什么样、哪些已经不在了」，供客户端把那几条套在本机缓存上。
//
// ★ 为什么收据能当变更日志用（这条推理必须成立，否则整个增量都不成立）：
//   `cloudfunctions/coachBusinessCommand/core.js:execute` 里，**业务写、revision 自增、
//   收据落 succeeded（带 revisionBefore / revisionAfter）三件事在同一个 `db.runTransaction` 里**。
//   所以：① 同一个 datasetId 下，revision 只可能由 execute 推动；② 每条 succeeded 收据的
//   `revisionAfter` 唯一且严格连续；③ 一次事务要么三件事全成要么全不成（失败会整份回滚，
//   连 processing 收据一起消失，不留痕、也不会占掉一个 revision）。
//   ⇒ 「since+1 … to 每一条 succeeded 收据都在」等价于「这段时间的业务变化一条不漏」。
//   ⚠️ 反过来说，**收据一旦被清理就必须能被发现**——见下面的连续性检查：任何一条缺失
//      都会在 `revisionAfter` 序列里留下一个空洞，本模块据此如实报 `CHANGES_GAP`，
//      由客户端退回完整读取。绝不把「查不到」当成「没有变化」。
//
// ★ 为什么受影响的行可以**由结果反推**（而不是重放命令）：
//   收据里**没有存 payload**（只存 payloadHash），所以拿不到"用户到底改了什么"。
//   但 22 条 handler 的返回值恰好都带上了它改过的业务 id（`{bookingId}`、`{packageId, saleId}`…）。
//   于是「按命令查表 + 从 groups 里现取那几行」就能得到**权威的当前形态**，
//   而不是靠客户端重放业务逻辑（重放 = 第二套业务规则，必然漂移）。
//   表是**封闭**的：没列进来的命令、以及会级联改很多行的命令（删学员 / 改销售 / 撤销售），
//   一律判 broad ⇒ `CHANGES_REQUIRES_FULL_READ` ⇒ 客户端退回完整读取。
//   ⚠️ 判错的代价被刻意做成"慢"，不是"错"：客户端拿到增量后还要用**同一套五项指纹**
//      （checksum / byteSize / summary / counts / amounts）与云端现场指纹逐项比对，
//      对不上就整份退回完整读取 —— 所以本表漏一条只会让那一次刷新变慢，绝不会显示错数据。
const COLLECTION_KEY = Object.freeze({
  students: 'studentId',
  student_tombstones: 'studentId',
  packages: 'packageId',
  bookings: 'bookingId',
  incomes: 'incomeId',
  sales: 'saleId',
  settings: 'settingsId',
  customExercises: 'customExerciseId'
})

// 一次增量最多覆盖多少个 revision。超过就退回完整读取：
// 一来一条命令一页也放不下几百个变更集，二来落后这么多的设备本来也该整份重来一次。
const MAX_WINDOW = 200

// 收据 → 受影响的行。函数签名是 `(result, groups) => [[collection, businessId], ...]`。
// `groups` 参与是因为有个别命令影响的 id 不在返回值里、却能现成地从已读到的行里查出来
// （典型：`rescheduleBooking` 对「已完课」的那节课会顺手改它关联的那条 income，而收入 id 不在返回值里）。
const NARROW = Object.freeze({
  createStudent: r => [['students', r.studentId]],
  updateStudent: r => [['students', r.studentId]],
  createPackage: r => [['packages', r.packageId]],
  updatePackage: r => [['packages', r.packageId]],
  deletePackage: r => [['packages', r.packageId]],
  createCourseSale: r => [['packages', r.packageId], ['sales', r.saleId]],
  createManualSale: r => [['sales', r.saleId]],
  updateManualSale: r => [['sales', r.saleId]],
  deleteManualSale: r => [['sales', r.saleId]],
  // ⚠️ M2 起：预约会同时写「占座」到课时包 ⇒ 增量必须带上 packages，否则 delta 漏行、
  //    完整性对不上 ⇒ 每次预约都退回全量读（真机表现为刷新变慢）。
  createBooking: r => [['bookings', r.bookingId], ['packages', r.packageId]],
  updateBookingContent: r => [['bookings', r.bookingId]],
  cancelBooking: r => [['bookings', r.bookingId], ['packages', r.packageId]],
  markBookingNotHeld: r => [['bookings', r.bookingId], ['packages', r.packageId]],
  // ⚠️ M2 第二批（共享预约）：这两条**只动授课教练自己这边的 bookings** ——
  //    课时包在**别人**那本账里，本数据集里根本没有那一行 ⇒ 绝不能把它列进 NARROW，
  //    否则 delta 会凭空报一条 `packages` 的"删除"（客户端拿去删一个不存在的 id，虽无害但是假话）。
  createSharedBooking: r => [['bookings', r.bookingId]],
  // M2 V1 正式授权排课（BUG04 同批）：与共享码排课**同一个形状** ——
  //   跨账那一侧（`shared:true`）本账只多一条 bookings，课时包在别人那本账 ⇒ 绝不能列进 packages
  //   （列了会凭空报一条"删除"，是一条假话）；
  //   ⚠️ 但它也可能走"课包就在自己这本账"的分支（那时 result 里没有 shared）⇒ 本账 packages 确实变了，
  //      必须带上，否则 delta 漏行 ⇒ 本地指纹与云端对不上 ⇒ 每次都退回完整读取（只是慢，不会错）。
  createAuthorizedBooking: r => r && r.shared === true
    ? [['bookings', r.bookingId]]
    : [['bookings', r.bookingId]].concat(r && r.packageId ? [['packages', r.packageId]] : []),
  // M3-P2 会员自助预约：走的是**同一个预约内核** ⇒ 形状与 createAuthorizedBooking 完全一致
  //   （跨账那侧本账只多一条 bookings；课包就在自己这本账时还要带上 packages）。
  //   ⚠️ 少了这条，教练设备每次刷新都会因为"收据命令不认识"退回完整读取（只是慢，但没必要）。
  createMemberBooking: r => r && r.shared === true
    ? [['bookings', r.bookingId]]
    : [['bookings', r.bookingId]].concat(r && r.packageId ? [['packages', r.packageId]] : []),
  setPackageShare: r => [['packages', r.packageId]],
  // ★ 对端（课时包所属教练）那本账唯一会变的命令：只有 packages 那一行。
  //   它必须有一条 NARROW 规则 —— 否则 A 设备的增量会在 revisionAfter 序列里看到空洞 ⇒ CHANGES_GAP ⇒ 每次全量读。
  sharedPackageSync: r => [['packages', r.packageId]],
  rescheduleBooking: (r, groups) => [['bookings', r.bookingId]].concat(
    r.incomeSynced ? (groups.incomes || []).filter(row => row.bookingId === r.bookingId).map(row => ['incomes', row.incomeId]) : []
  ),
  completeBooking: r => [['bookings', r.bookingId], ['packages', r.packageId], ['incomes', r.incomeId]],
  deleteCompletedBooking: r => [['bookings', r.bookingId], ['incomes', r.incomeId], ['packages', r.packageId]],
  saveSettings: () => [['settings', 'settings']],
  createCustomExercise: r => [['customExercises', r.customExerciseId]],
  updateCustomExercise: r => [['customExercises', r.customExerciseId]],
  deleteCustomExercise: r => [['customExercises', r.customExerciseId]]
})

// 会级联改很多行的命令：受影响的行**无法从返回值枚举**（尤其是「被删掉的那些行」，
// 它们已经不在库里，光靠现读根本列不出来）。这类命令一律退回完整读取 —— 它们都是低频操作。
const BROAD = Object.freeze(['deleteStudent', 'updateCourseSale', 'reverseCourseSale'])

function keyIndexOf(collection, row) {
  const field = COLLECTION_KEY[collection]
  return field && row ? row[field] : undefined
}

// 逐条收据算受影响的行；任何一条判不出来就返回「需要完整读取」。
function touchedRows(receipts, groups) {
  const touched = new Map()
  for (const receipt of receipts) {
    const command = String(receipt.command || '')
    if (BROAD.includes(command)) return { broad: command }
    const rule = NARROW[command]
    if (!rule) return { broad: command || 'UNKNOWN_COMMAND' }
    const result = receipt.response && receipt.response.result
    if (!result || typeof result !== 'object') return { broad: command }
    let pairs
    try { pairs = rule(result, groups) } catch (error) { return { broad: command } }
    for (const pair of pairs || []) {
      const collection = pair && pair[0], key = pair && pair[1]
      if (!collection || !COLLECTION_KEY[collection]) continue
      if (typeof key !== 'string' || !key) continue
      if (!touched.has(collection)) touched.set(collection, new Set())
      touched.get(collection).add(key)
    }
  }
  return { touched }
}

// 把「受影响的行」翻译成**权威的当前形态**：
//   现读还在 ⇒ upserts（整行，与 page 回传的形状逐字一致）
//   现读不在 ⇒ removals（只报 id —— 客户端据此把那一行从本机缓存里摘掉）
// 注意这里判「增删」靠的是**现读结果**，不是命令名：`cancelBooking` 与
// `deleteCompletedBooking` 都是"删"，但判据统一成"这条 id 现在还在不在库里"，
// 于是将来新增删除类命令也不需要动这里。
function buildDelta(touched, groups) {
  const index = new Map()
  for (const collection of Object.keys(COLLECTION_KEY)) {
    const map = new Map()
    for (const row of groups[collection] || []) {
      const key = keyIndexOf(collection, row)
      if (typeof key === 'string' && key) map.set(key, row)
    }
    index.set(collection, map)
  }
  const upserts = {}, removals = {}
  for (const [collection, keys] of touched) {
    const map = index.get(collection) || new Map()
    const up = [], gone = []
    for (const key of keys) {
      const row = map.get(key)
      if (row) up.push(row)
      else gone.push(key)
    }
    if (up.length) upserts[collection] = up
    if (gone.length) removals[collection] = gone
  }
  return { upserts, removals }
}

// 主入口。`sinceRevision` 是**客户端自己最后确认过的那一版**（本机已验缓存里的 revision）。
// 返回值分三类：
//   { ok:true, delta }                  —— 可以增量应用
//   { ok:false, code:'CHANGES_*' }      —— 无法证明安全，客户端必须退回完整读取
// 绝不返回"看起来成功但其实缺东西"的结果。
function planChanges({ groups, receipts, sinceRevision, toRevision }) {
  if (!Number.isInteger(sinceRevision) || sinceRevision < 0) return { ok: false, code: 'CHANGES_INVALID_SINCE' }
  if (!Number.isInteger(toRevision)) return { ok: false, code: 'CHANGES_INVALID_SINCE' }
  // 客户端比云端还新：只可能是环境切换 / 数据集切换 / 本机缓存被改坏。不许猜，退回完整读取。
  if (sinceRevision > toRevision) return { ok: false, code: 'CHANGES_AHEAD', currentRevision: toRevision }
  if (sinceRevision === toRevision) return { ok: true, unchanged: true, delta: { upserts: {}, removals: {}, revisions: [] } }
  if (toRevision - sinceRevision > MAX_WINDOW) {
    return { ok: false, code: 'CHANGES_WINDOW_TOO_LARGE', from: sinceRevision, to: toRevision, window: toRevision - sinceRevision, limit: MAX_WINDOW }
  }
  const byRevision = new Map()
  for (const receipt of receipts || []) {
    const revision = Number(receipt && receipt.revisionAfter)
    if (!Number.isInteger(revision)) continue
    if (revision <= sinceRevision || revision > toRevision) continue
    // 同一个 revision 出现两条 succeeded 收据是不可能的（事务互斥 + revision 自增）。
    // 真出现就说明这份收据集合不是我们以为的那一份 ⇒ 如实判否。
    if (byRevision.has(revision)) return { ok: false, code: 'CHANGES_GAP', missing: [revision], duplicate: true }
    byRevision.set(revision, receipt)
  }
  const missing = []
  for (let revision = sinceRevision + 1; revision <= toRevision; revision++) if (!byRevision.has(revision)) missing.push(revision)
  if (missing.length) {
    return { ok: false, code: 'CHANGES_GAP', from: sinceRevision, to: toRevision, missing: missing.slice(0, 20), missingCount: missing.length }
  }
  const ordered = []
  for (let revision = sinceRevision + 1; revision <= toRevision; revision++) ordered.push(byRevision.get(revision))
  const planned = touchedRows(ordered, groups)
  if (planned.broad) return { ok: false, code: 'CHANGES_REQUIRES_FULL_READ', from: sinceRevision, to: toRevision, command: planned.broad }
  const delta = buildDelta(planned.touched, groups)
  delta.revisions = ordered.map(receipt => ({ revision: Number(receipt.revisionAfter), command: String(receipt.command || '') }))
  return { ok: true, unchanged: false, delta }
}

module.exports = { COLLECTION_KEY, MAX_WINDOW, NARROW, BROAD, planChanges, buildDelta, touchedRows, keyIndexOf }
