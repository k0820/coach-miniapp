// 跨设备**增量同步**（1.1.9 第 7 轮）。
//
// 真机账本（2026-09-23）定案了这件事的根因：
//   手机下拉一次 = 13 次云函数往返（1 首跳 + 1 metadata + 10 分页 + 1 末尾 integrity），
//   实测 6.9–11.7 秒；而「云端把八个集合读完算指纹」那一次调用自己只要 1.2–1.4 秒。
//   也就是说瓶颈不是"云端读得慢"，而是**为了知道"变的是哪一条"，必须把整份数据搬回手机**。
// 本轮改成：手机带着「本机最后确认过的 revision」问云端"这一段变了哪几行"，只把那几行拿回来。
//
// 本测试跑的是**真实云函数 + 真实客户端**（复用 tests/helpers/sandbox-command-world.js：
// 只有 wx 与 CloudBase DB 是假的），所以它同时钉住两端：
//   ① 新增预约：只同步**新增的那一条** —— 一跳 `changes`，**0 次 metadata、0 次分页**；
//   ② 取消预约：只同步**那一条的消失** —— 走的是与新增**同一套**机制（客户端里只有一处 changes 调用，
//      适配器里连 `cancelBooking` 这个词都不存在，所以不可能再出现"取消专属补丁"）；
//   ③ 增量之后本机 revision / 内存态 revision 必须一起前进（否则下一条写命令会 REVISION_UNKNOWN）；
//   ④ **校验不过必须整份退回完整读取**：云端回的增量指纹对不上时，宁可慢也不能显示错数据；
//   ⑤ 收据被清理（变更日志出现空洞）⇒ 不得把"查不到"当成"没有变化"，必须退回完整读取；
//   ⑥ 旧云函数还不认识 `changes`（体验版先上、云函数没部署）⇒ 下拉**必须照常成功**，
//      逐字退回今天的行为。这一格是本轮实测踩出来的：把它当"云端报错"会让手机每次下拉都硬失败；
//   ⑦ requestId 重放不产生第二笔业务事实，而且重放之后下拉走的是"没变化"那一路；
//   ⑧ 原有 revision 乐观锁继续有效；
//   ⑨ Sandbox 与 Production 隔离不受影响（增量读的必须是**沙箱**收据）。
//
// 判别力：把 `applyChanges` 里的五项比对删掉 → ④ 立刻变红；把 `CHANGES_GAP` 当成"没有变化"
// → ⑤ 立刻变红；把 `INVALID_ACTION` 从兜底集合里去掉 → ⑥ 立刻变红。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createWorld } = require('./helpers/sandbox-command-world')
const readTiming = require('../utils/read-timing')

const ROOT = path.resolve(__dirname, '..')
const PROJ = ROOT
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const PHYSICAL = ['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']

async function run() {
  const world = createWorld(), { ui, mutate, runtime, cloud } = world
  const adapter = ui.adapter

  // ——————— 与云端的原始对话（"另一台设备"就是在这个层面动手的）———————
  // 用真实传输通道打真命令服务：同一个事务、同一条 succeeded 收据、同一个 revision 自增。
  // 这比"直接改 stores"忠实得多 —— 收据正是本轮增量的全部依据。
  let aSeq = 0
  const call = (name, data) => global.wx.cloud.callFunction({ name, data }).then(response => response.result)
  const cloudRevision = async () => (await call('coachBusinessCommand', { action: 'status', environment: 'sandbox' })).datasetRevision
  const deviceA = async (command, payload, requestId) => call('coachBusinessCommand', {
    action: 'execute', environment: 'sandbox',
    envelope: { command, requestId: requestId || `devA${String(++aSeq).padStart(4, '0')}_x`, expectedRevision: await cloudRevision(), payload }
  })
  const mark = () => world.calls.length
  const readActions = from => world.calls.slice(from).filter(item => item.name === 'readMyActiveCoachData').map(item => item.data.action)
  const lastLedger = () => readTiming.list().slice(-1)[0]
  // ⚠️ 退回完整读取时账本会落**两**行：先是一条用户轮次的"增量做不到"（带兜底原因），
  //    再是航位里完整读取自己那一行（它没有"兜底原因"可言）。
  //    所以要判"为什么没走成增量"就必须取前一行 —— 取最后一行永远读到空串。
  const lastFallback = () => readTiming.list().slice().reverse().find(row => row.incrementalFallback) || { incrementalFallback: '' }
  // ★ 第 12 轮：用户下拉 = 「一跳增量 + 一跳**轻量确认**」（两次都是只读、0 页、不翻任何集合）。
  //   判据改成"绝不允许出现 metadata / page"，确切跳数由场景⑪钉死。
  //   （旧断言写的是"恰好 ['changes']"，那是在加收敛检查之前写的；现在多出来的这一跳
  //     正是"确认云端最新 revision"——它不翻任何集合，pages 仍然必须是 0。）
  const noHeavyRead = (fromIndex, label) => {
    const acts = readActions(fromIndex)
    assert.ok(acts.length >= 1 && acts.length <= 2 && acts.every(action => action === 'changes' || action === 'integrity'),
      label + '：只允许轻量只读（changes / integrity），绝不允许 metadata 或分页，实得 ' + JSON.stringify(acts))
  }
  // 篡改云端回应（模拟"云函数版本不对" / "云端回的增量指纹是坏的"）。包在传输层上，
  // 因为被替换掉的正是客户端每次现取的那个入口。
  const original = global.wx.cloud.callFunction
  const tamper = { checksum: false, legacy: false }
  global.wx.cloud.callFunction = async request => {
    const response = await original(request)
    const data = request && request.data
    if (data && data.action === 'changes') {
      if (tamper.legacy) return { result: { ok: false, code: 'INVALID_ACTION' } }
      if (tamper.checksum) { const copy = clone(response); copy.result.checksum = 'corrupted-' + copy.result.checksum; return copy }
    }
    return response
  }

  // ——————— 基线：本机（设备 B）先把学员与课时包建出来，再做一次完整读取 ———————
  assert.equal((await mutate(null, null, { command: 'createStudent', payload: { name: '增量学员', phone: '' } })).ok, true)
  await world.idle()
  const studentId = world.rows('students')[0].studentId
  assert.equal((await mutate(null, null, { command: 'createPackage', payload: { studentId, type: '赠送课程', total: 10, remaining: 10, isGift: true } })).ok, true)
  await world.idle()
  const packageId = world.rows('packages')[0].packageId
  const baseline = await adapter.readActive()
  assert.equal(baseline.ok, true, '基线完整读取必须成功')
  assert.ok(adapter.getState().revision >= 2, '基线必须落在建完学员与课时包之后的 revision 上')
  const baselineBookings = runtime.getDB().bookings.length
  assert.equal(baselineBookings, 0, '基线还没有任何预约')

  // ════════════════════════════════════════════════════════════════════
  // ① 新增预约：只同步**新增的那一条**（一跳 changes；metadata 与分页一次都不发）
  // ════════════════════════════════════════════════════════════════════
  const created = await deviceA('createBooking', { studentId, packageId, date: '2026-10-08', hour: 10, minute: 0 })
  assert.equal(created.ok, true, '另一台设备的新增必须成功：' + JSON.stringify(created))
  const newBookingId = created.result.bookingId
  const afterCreateRevision = created.datasetRevision

  let from = mark()
  const pulled = await adapter.readActive({ userInitiated: true })
  assert.equal(pulled.ok, true, '下拉必须成功：' + JSON.stringify(pulled))
  noHeavyRead(from, '★ 新增一条预约：metadata 与 8 次分页一次都不许发')
  assert.equal(pulled.revision, afterCreateRevision, '增量必须把本机 revision 推进到云端当前值')
  assert.equal(adapter.getState().revision, afterCreateRevision, '内存态 revision 必须一起前进（否则下一条写命令会 REVISION_UNKNOWN）')
  assert.ok(runtime.getDB().bookings.some(row => row.id === newBookingId),
    '★ 新增的课必须真的进本机 cache —— 视图层读的就是它，"只让三个点提前消失"不算')
  const createLedger = lastLedger()
  assert.equal(createLedger.skipped, 'INCREMENTAL', '账本必须如实记下"这一轮走的是增量"')
  assert.equal(createLedger.pages, 0, '★ 增量那一轮页数必须是 0（这正是真机上省下来的 10 次往返）')
  // M2 起：预约会同时写「booking」和「课时包的占座 reserved」⇒ 增量应当只回这 2 行，仍然不许全量读。
  assert.equal(createLedger.deltaRows, 2, '★ 这一版只变了**两条**业务行（预约 + 课时包占座）—— 增量必须只回它们，实得 ' + createLedger.deltaRows)
  assert.equal(createLedger.incrementalFallback, '', '走成了就不许留兜底原因')
  assert.ok(createLedger.changesMs >= 0, '账本必须带上增量那一跳自己的耗时')

  // ════════════════════════════════════════════════════════════════════
  // ② 取消预约：走的必须是**同一套**机制（不是取消专属的第二条路）
  // ════════════════════════════════════════════════════════════════════
  const cancelled = await deviceA('cancelBooking', { bookingId: newBookingId })
  assert.equal(cancelled.ok, true, '另一台设备的取消必须成功：' + JSON.stringify(cancelled))
  from = mark()
  const pulledCancel = await adapter.readActive({ userInitiated: true })
  assert.equal(pulledCancel.ok, true, '取消之后下拉必须成功：' + JSON.stringify(pulledCancel))
  noHeavyRead(from, '★ 取消必须走与新增**同一套**增量机制（不许有取消专属的第二条路）')
  assert.equal(pulledCancel.revision, cancelled.datasetRevision, '取消后 revision 必须同步到云端当前值')
  assert.equal(runtime.getDB().bookings.some(row => row.id === newBookingId), false,
    '★ 被取消的课必须真的从本机 cache 里消失（不是只更新个计数）')
  assert.equal(runtime.getDB().bookings.length, baselineBookings, '取消之后本机预约条数必须回到基线')
  const cancelLedger = lastLedger()
  assert.equal(cancelLedger.skipped, 'INCREMENTAL')
  assert.equal(cancelLedger.pages, 0)
  // M2：取消同时改「被删的那条预约」和「课时包释放占座」⇒ 2 行，仍然不许全量读。
  assert.equal(cancelLedger.deltaRows, 2, '★ 取消只回"消失的那一条 + 释放占座的课时包"，实得 ' + cancelLedger.deltaRows)

  // ②b 静态：增量只有**一处**调用点，而且适配器里不存在任何"取消专属"的分支。
  //     "不允许再分别打补丁"这条要求，判据就是这里 —— 新增与取消在客户端是同一条代码路径。
  const clientSource = fs.readFileSync(path.join(PROJ, 'utils/cloud-primary-adapter.js'), 'utf8')
  const bare = clientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')
  assert.equal((bare.match(/action:\s*'changes'/g) || []).length, 1, '增量读取只允许有一个调用点（新增与取消共用它）')
  // `cancelBooking` 在适配器里唯一**合法**的位置是命令注册表那一行（COMMANDS 里必须有全部命令名）。
  // 除此之外任何一处出现都只可能是一个"取消专属"分支 —— 那正是本轮要消灭的东西。
  const outsideRegistry = bare.split('\n').filter(line => line.includes('cancelBooking') && !line.includes('const COMMANDS')).join('\n')
  assert.equal(outsideRegistry.includes('cancelBooking'), false,
    '★ 除命令注册表外，适配器里不许再出现 cancelBooking（出现即"又打了一条取消专属补丁"）：\n' + outsideRegistry)
  // "变了哪几行"的映射表只许在**云函数**里（changes.js 的 NARROW）；客户端自带一份 = 新增/取消各一条路径。
  assert.equal(bare.includes('NARROW'), false, '客户端不许自带"命令 → 受影响行"的映射表（它只该在云函数里）')
  assert.equal(bare.includes("require('./changes')"), false, '客户端不许 require 云函数的 changes.js')

  // ════════════════════════════════════════════════════════════════════
  // ③ 再来一条新增（走同一套），确认连续增量仍然成立、且 revision 锚点没写错
  // ════════════════════════════════════════════════════════════════════
  const created2 = await deviceA('createBooking', { studentId, packageId, date: '2026-10-09', hour: 11, minute: 0 })
  assert.equal(created2.ok, true)
  from = mark()
  const pulled2 = await adapter.readActive({ userInitiated: true })
  noHeavyRead(from, '连续第二次增量')
  assert.ok(runtime.getDB().bookings.some(row => row.id === created2.result.bookingId), '第二条新增也必须真的进 cache')
  assert.equal(lastLedger().deltaRows, 2, '第二条同样只回两行（预约 + 课时包占座）')

  // ════════════════════════════════════════════════════════════════════
  // ④ 校验不过必须整份退回完整读取（宁可慢，绝不显示错数据）
  // ════════════════════════════════════════════════════════════════════
  const created3 = await deviceA('createBooking', { studentId, packageId, date: '2026-10-10', hour: 12, minute: 0 })
  assert.equal(created3.ok, true)
  tamper.checksum = true
  from = mark()
  const tampered = await adapter.readActive({ userInitiated: true })
  tamper.checksum = false
  assert.equal(tampered.ok, true, '★ 云端回的增量指纹是坏的时候，必须整份退回完整读取后**如实成功**：' + JSON.stringify(tampered))
  assert.ok(readActions(from).includes('metadata'), '★ 指纹对不上就必须真的退回完整读取（不是把坏增量照单全收）')
  assert.equal(readActions(from).filter(action => action === 'page').length, PHYSICAL.length,
    '★ 退回完整读取时八个集合一个都不许跳过，实得 ' + JSON.stringify(readActions(from)))
  assert.equal(tampered.revision, created3.datasetRevision, '完整读取必须落在云端当前 revision')
  assert.ok(runtime.getDB().bookings.some(row => row.id === created3.result.bookingId), '退回完整读取之后数据必须是**真的**那一份')
  assert.equal(lastFallback().incrementalFallback, 'INCREMENTAL_FINGERPRINT_MISMATCH',
    '★ 账本必须如实说出"指纹对不上"这个原因，实得 ' + lastFallback().incrementalFallback)
  assert.equal(adapter.getState().checksum, tampered.checksum, '本机"已验指纹"必须是完整读取带回来的那一份')
  assert.equal(String(tampered.checksum).startsWith('corrupted-'), false,
    '★ 被篡改的坏指纹绝不许被采用 —— 宁慢也不错（"不能为了速度吞掉校验"这条要求，判据就在这里）')

  // ════════════════════════════════════════════════════════════════════
  // ⑤ 收据被清理（变更日志有空洞）⇒ 不得把"查不到"当成"没有变化"
  // ════════════════════════════════════════════════════════════════════
  const created4 = await deviceA('createBooking', { studentId, packageId, date: '2026-10-11', hour: 13, minute: 0 })
  assert.equal(created4.ok, true)
  // 抹掉这条命令的收据 = 云端收据做了保留期清理。世界已经前进，但变更日志缺了一格。
  const receiptKey = [...cloud.stores.coach_sandbox_receipts.keys()]
    .find(key => Number(cloud.stores.coach_sandbox_receipts.get(key).revisionAfter) === created4.datasetRevision)
  assert.ok(receiptKey, '这条命令必须留下一条 succeeded 收据（增量全靠它）')
  const snapshotBefore = clone(cloud.stores.coach_sandbox_receipts.get(receiptKey))
  cloud.stores.coach_sandbox_receipts.delete(receiptKey)
  from = mark()
  const gapped = await adapter.readActive({ userInitiated: true })
  assert.equal(gapped.ok, true, '收据有空洞时下拉必须成功（退回完整读取）：' + JSON.stringify(gapped))
  // ⚠️ 退回完整读取时账本落**两**行：先是用户轮次那条"增量做不到"（带兜底原因），
  //    再是航位里完整读取自己那一行（它没有"兜底原因"可言）。所以取**前一行**判原因、取**最后一行**判真正翻了哪些页。
  assert.equal(lastFallback().incrementalFallback, 'CHANGES_GAP',
    '★ 变更日志不连续必须如实判否（不许把"查不到"当成"没有变化"），实得 ' + lastFallback().incrementalFallback)
  assert.equal(lastFallback().pages, 0, '★ 增量那一跳一页都不许翻（这正是它省下来的 10 次往返）')
  assert.equal(lastLedger().incrementalFallback, '', '完整读取自己那一行不许带兜底原因（原因属于"为什么没走成增量"那一条）')
  assert.equal(lastLedger().pages, PHYSICAL.length, '退回完整读取必须真的翻 8 个集合的分页')
  assert.ok(runtime.getDB().bookings.some(row => row.id === created4.result.bookingId),
    '★ 增量做不到的时候必须靠完整读取拿到真数据 —— 不许因为"查不到变更"就少读、显示旧课表')
  // 放回收据，后面的场景继续用完整可用的变更日志
  cloud.stores.coach_sandbox_receipts.set(receiptKey, snapshotBefore)

  // ════════════════════════════════════════════════════════════════════
  // ⑥ 旧云函数还不认识 changes（体验版先上、云函数没部署）⇒ 下拉必须照常成功
  // ════════════════════════════════════════════════════════════════════
  const created5 = await deviceA('createBooking', { studentId, packageId, date: '2026-10-12', hour: 14, minute: 0 })
  assert.equal(created5.ok, true)
  tamper.legacy = true
  from = mark()
  const legacy = await adapter.readActive({ userInitiated: true })
  tamper.legacy = false
  assert.equal(legacy.ok, true,
    '★ 云函数还是旧版本（不认 changes）时，下拉**必须照常成功**：把它当"云端报错"会让手机每次下拉都硬失败')
  assert.equal(lastFallback().incrementalFallback, 'INVALID_ACTION', '账本必须如实记下"旧云函数不认增量"这件事')
  assert.equal(lastLedger().pages, PHYSICAL.length, '必须逐字退回今天的完整读取')
  assert.ok(runtime.getDB().bookings.some(row => row.id === created5.result.bookingId), '退回完整读取之后必须看到新数据')

  // ════════════════════════════════════════════════════════════════════
  // ⑦ requestId 重放不产生第二笔业务事实；重放之后下拉走"没变化"那一路
  // ════════════════════════════════════════════════════════════════════
  const replayId = 'replay_probe_0001'
  const replayPayload = { studentId, packageId, date: '2026-10-13', hour: 15, minute: 0 }
  const firstRun = await deviceA('createBooking', replayPayload, replayId)
  assert.equal(firstRun.ok, true, '第一次执行必须成功')
  const secondRun = await deviceA('createBooking', replayPayload, replayId)
  assert.equal(secondRun.ok, true, '重放必须幂等成功：' + JSON.stringify(secondRun))
  assert.equal(secondRun.idempotent, true, '★ 同一 requestId 重放必须走幂等返回（绝不重跑业务）')
  assert.equal(secondRun.datasetRevision, firstRun.datasetRevision, '★ 重放不许再推进 revision（那意味着多了一笔业务事实）')
  assert.equal(world.rows('bookings').filter(row => row.data.id === firstRun.result.bookingId).length, 1, '云端只能有一条这条预约')
  from = mark()
  const settled = await adapter.readActive({ userInitiated: true })
  assert.equal(settled.ok, true)
  noHeavyRead(from, '重放之后仍然是轻量只读')
  assert.ok(runtime.getDB().bookings.some(row => row.id === firstRun.result.bookingId),
    '这一跳要补的是**第一次执行**那一条新增 —— 重放自己没有产生第二笔事实，所以只补一行')
  // M2：第一次执行写的是「预约 + 课时包占座」两行 ⇒ 补回 2 行才对（重放自己仍没有产生第二笔事实）。
  assert.equal(lastLedger().deltaRows, 2, '★ 重放没有产生第二笔事实 ⇒ 增量只该补回第一次执行那两行')
  // 再下拉一次：世界已经追平 ⇒ 必须走"校验通过、直接结束"那一路（不带 delta，也不再翻页）。
  from = mark()
  const calm = await adapter.readActive({ userInitiated: true })
  assert.equal(calm.ok, true)
  noHeavyRead(from, '追平之后仍然是轻量只读')
  assert.equal(lastLedger().skipped, 'VERIFIED_UNCHANGED', '没变化必须走"校验通过、直接结束"那一路（不带 delta）')
  assert.equal(lastLedger().outcome, 'VERIFIED_UNCHANGED', '账本的 outcome 也必须是"校验通过、没变化"')
  assert.equal(lastLedger().deltaRows, 0, '没变化的那一轮不许报出变更行数')
  assert.equal(lastLedger().pages, 0, '没变化的那一轮一页都不许翻')
  assert.equal(lastLedger().incrementalFallback, '', '没变化那一轮不是"兜底"，账本不许留兜底原因')

  // ════════════════════════════════════════════════════════════════════
  // ⑧ 原有 revision 乐观锁继续生效
  // ════════════════════════════════════════════════════════════════════
  const stale = await call('coachBusinessCommand', {
    action: 'execute', environment: 'sandbox',
    envelope: { command: 'createBooking', requestId: 'stale_probe_0001', expectedRevision: 0, payload: { studentId, packageId, date: '2026-10-14', hour: 16, minute: 0 } }
  })
  assert.equal(stale.ok, false, '用过期 revision 写必须被拒')
  assert.equal(stale.code, 'REVISION_CONFLICT', '★ 乐观锁必须原样生效（本轮一个字都没动它）')
  assert.equal(world.rows('bookings').some(row => row.data.date === '2026-10-14'), false, '被拒的命令不许留下任何业务事实')

  // ════════════════════════════════════════════════════════════════════
  // ⑨ Sandbox / Production 隔离不受影响：增量读的必须是**沙箱**收据
  // ════════════════════════════════════════════════════════════════════
  assert.ok(cloud.stores.coach_sandbox_receipts.size > 0, '沙箱命令必须落在沙箱收据里')
  assert.equal(cloud.stores.coach_command_receipts.size, 0, '★ 增量必须只读沙箱收据：正式区收据里一条业务收据都不该有')
  assert.ok(world.calls.every(item => item.data.environment === 'sandbox'), '全程不许有任何一跳被打到 Production')

  // ════════════════════════════════════════════════════════════════════
  // ⑩ 「在途复用」不会让下一次下拉拿到旧世界（本轮纳入覆盖的那条嫌疑）
  //
  //   适配器对**用户轮次**有一条既有设计：同一次下拉期间的第二下会复用同一轮
  //   （防止两下叠加成两次云端读取）。必须证明它**只**发生在"两次下拉完全重叠"时，
  //   且**一轮结束之后**的下一次下拉一定是重新问云端的。
  // ════════════════════════════════════════════════════════════════════
  from = mark()
  const lap1 = adapter.readActive({ userInitiated: true })
  const lap2 = adapter.readActive({ userInitiated: true })
  assert.equal(lap1, lap2, '完全重叠的两下合并成同一轮（既有设计，不许叠加成两次云端读取）')
  await lap1
  await lap2
  noHeavyRead(from, '完全重叠的两下合并之后仍然是轻量只读')
  // 一轮**结束之后**再下拉：必须是新的一轮 —— 否则用户第二次下拉会又拿到第一次那份旧世界，
  // 而界面上看不出来（下拉动画照样结束），于是只能靠"再拉一次"来救。
  from = mark()
  await adapter.readActive({ userInitiated: true })
  assert.ok(readActions(from).length >= 1,
    '★ 上一轮结束后的下一次下拉必须真的重新问云端（实得 ' + JSON.stringify(readActions(from)) + '）')
  noHeavyRead(from, '上一轮结束后的下一次下拉')

  // ⑩b 「取消落云 ⇒ 第一次下拉就消失，不依赖第二次」已在上面的场景②里钉死：
  //     `deviceA(cancelBooking)` 落云之后只调了**一次** `readActive({userInitiated:true})`，
  //     然后就断言"这门课真的从本机 cache 里消失了"。那个断言本身就是"一次下拉就够"的判据。

  // ════════════════════════════════════════════════════════════════════
  // ⑪（第 12 轮 B）一次下拉必须**收敛到下拉结束时**的云端最新状态
  //
  //   真机（2026-09-24 17:36）：手机第一次下拉显示旧的 A，第二次才变成 B。
  //   形状是「第一跳 changes 拿到的那一刻云端最新就是 262(=A)，而云端随后继续走到 263/264」。
  //   一跳增量只保证「应用到了它自己读到的那一版」—— 拿完就交卷，用户就得拉第二次。
  //   ⇒ 同一次下拉内部必须：套完增量 → 轻量确认云端最新 revision → 还落后就**继续追**，
  //     直到「本机 revision == 云端最新 revision」才结束，而且全程 0 页完整读取。
  // ════════════════════════════════════════════════════════════════════
  const convDate = '2026-10-20', convHour = 11
  const convA = await deviceA('createBooking', { studentId, packageId, date: convDate, hour: convHour, minute: 0 })
  assert.equal(convA.ok, true, '（前置）另一台设备先约上 A')
  //
  // ★★ 1.1.9 第 16 轮（§90）：注入点从「传输层」（云端已经把响应交出去之后）改成
  //   「云端**算完 delta、还没读 HEAD**」那一刻 —— 也就是第 3 次读 revision 文档的那一次
  //   （第 1 次在入口、第 2 次是 liveChanges 的自证、第 3 次是 §90 新增的 HEAD 读）。
  //   为什么必须改：新云函数把 HEAD 随 `changes` 响应一起回，"云端算 delta 期间又被人写"
  //   （真机 262 → 263/264 就是这一段时间，占整次读取的绝大部分）**当场**就能看出来，
  //   客户端据此在同一次下拉内部再追一跳 —— 这正是这里要钉的形状。
  //   ⚠️ 剩下那一小段（响应已经在路上、客户端还没收到，约 100–300ms）**任何"一次调用"的
  //      读法都覆盖不到** —— 要覆盖它只能再问一次云端，那就是被本轮省掉的那次 `integrity`。
  //      诚实边界记在 PROJECT_MEMORY.md §90：偶发"第一次下拉"不可能做到数学上的 0。
  const REVISION_STORE = 'coach_sandbox_revisions'
  let revReads = 0, injected = false, injecting = false
  const baseCollection = cloud.db.collection
  cloud.db.collection = name => {
    const col = baseCollection(name)
    if (name !== REVISION_STORE) return col
    return { ...col, where: query => {
      const api = col.where(query)
      const wrapped = {
        limit: value => { api.limit(value); return wrapped },
        skip: value => { api.skip(value); return wrapped },
        orderBy: (field, direction) => { api.orderBy(field, direction); return wrapped },
        get: async () => {
          revReads += 1
          if (!injected && !injecting && revReads === 3) {
            injected = true
            injecting = true                                   // 防重入：下面这两条命令自己也要读 revision
            try {
              // ★ 就在这一刻，云端继续前进：A 取消 + B 新增（真机 262 → 263 → 264 那个形状）
              assert.equal((await deviceA('cancelBooking', { bookingId: convA.result.bookingId })).ok, true)
              assert.equal((await deviceA('createBooking', { studentId, packageId, date: convDate, hour: convHour, minute: 0 })).ok, true)
            } finally { injecting = false }
          }
          return api.get()
        }
      }
      return wrapped
    } }
  }
  from = mark()
  const converged = await adapter.readActive({ userInitiated: true })
  cloud.db.collection = baseCollection
  assert.equal(injected, true, '（前置）竞态必须真的被注入到"云端算完 delta、还没读 HEAD"那一刻')
  const headAfter = await cloudRevision()
  assert.equal(converged.ok, true, '下拉必须成功')
  assert.equal(converged.revision, headAfter,
    '★★ 一次下拉必须直接收敛到云端最新 revision（实得 ' + converged.revision + ' / 云端 ' + headAfter + '）')
  const convRows = runtime.getDB().bookings.filter(row => row.date === convDate && Number(row.hour) === convHour)
  assert.equal(convRows.length, 1, '★ 这个时段最终必须恰好一门课，实得 ' + convRows.length)
  assert.equal(convRows.some(row => row.id === convA.result.bookingId), false,
    '★★ A 必须已经消失 —— 不许停在旧的 A（那正是"要拉第二次"的症状）')
  assert.ok(convRows.some(row => row.id !== convA.result.bookingId), '★★ 一次下拉就必须直接看到 B')
  const convActions = readActions(from)
  assert.ok(convActions.filter(action => action === 'changes').length >= 2,
    '★ 同一次下拉内部必须继续追增量，实得 ' + JSON.stringify(convActions))
  assert.ok(convActions.indexOf('metadata') < 0 && convActions.indexOf('page') < 0,
    '★ 追的过程中一页完整读取都不许有，实得 ' + JSON.stringify(convActions))
  assert.equal(convActions.indexOf('integrity'), -1,
    '★★ 云端已经把 HEAD 随 changes 一起回了 ⇒ 追的过程中不许再花一次串行 integrity，实得 ' + JSON.stringify(convActions))
  assert.equal(lastLedger().integrityMs, 0,
    '★★ 账本里这一次下拉的 integrity 开销必须是 0（省下来的就是真机上那 1.4 秒）')
  assert.equal(lastLedger().pages, 0, '★ 全程 0 页完整读取')
  assert.equal(lastLedger().incrementalFallback, '', '★ 追上了就不许留兜底原因')

  // ⑪b `ACTIVE_READ_REVISION_CHANGED` = 云端自证"我读的时候世界还在前进"。
  //     它**不是错误**，是"再追一跳"；把它当 error 交卷 ⇒ 用户看到的就是旧 cache（真机那个形状）。
  const extra = await deviceA('createBooking', { studentId, packageId, date: convDate, hour: convHour + 3, minute: 0 })
  assert.equal(extra.ok, true, '（前置）云端再前进一版')
  // ⚠️ 这一跳**每一跳** changes 都回"世界还在动"：把它当 error 交卷的代码会在
  //    第一次就结束刷新（用户看到旧 cache）；正确处理是"继续追"，追到有界预算用尽
  //    才退回完整读取（**慢但不会错**）。所以这里的判据是"下拉必须成功且追到最新"，
  //    以及账本必须如实记下"追到预算用尽才退的"。
  const outerCall = global.wx.cloud.callFunction
  global.wx.cloud.callFunction = async request => {
    if (request && request.data && request.data.action === 'changes') {
      return { result: { ok: false, code: 'ACTIVE_READ_REVISION_CHANGED' } }
    }
    return outerCall(request)
  }
  from = mark()
  const afterMoved = await adapter.readActive({ userInitiated: true })
  global.wx.cloud.callFunction = outerCall
  assert.equal(afterMoved.ok, true,
    '★★ ACTIVE_READ_REVISION_CHANGED 不许被当成错误结束刷新：' + JSON.stringify(afterMoved))
  assert.equal(afterMoved.revision, await cloudRevision(), '★ 无论如何必须追到云端最新那一版')
  assert.equal(lastFallback().incrementalFallback, 'CONVERGE_EXHAUSTED',
    '★ 一直说"世界还在动" ⇒ 必须追到有界预算用尽才退，而且账本要如实写清楚')
  assert.ok(runtime.getDB().bookings.some(row => row.id === extra.result.bookingId), '追完之后必须看到新数据')

  console.log('incremental cross-device sync: PASS'
    + '（新增 = 一跳 changes / 0 metadata / 0 分页 / deltaRows 1；取消 = 同一套机制、同样一跳；'
    + 'revision 前进入本机 cache 与内存态；指纹对不上 ⇒ 退回 8 集合并如实成功；'
    + '收据有空洞 ⇒ CHANGES_GAP 并退回完整读取；旧云函数 ⇒ INVALID_ACTION 且下拉照常成功；'
    + '重放不动 revision；乐观锁仍生效；沙箱收据 0 条落到正式区；'
    + '重叠下拉合并不叠加、下一轮必定重新读、取消后第一次下拉即消失）')
}

run().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 })
