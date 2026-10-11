// 【1.1.9 第 15 轮永久回归】**后台轮次**也必须走 `changes` 增量，不许再退化成 10 页全量读。
//
// 真机账本（2026-09-25 11:41 那一版新体验版，`coachWriteTimings` / `coachReadTimings`，见 §87）：
//   11:43:56.845  A create 落云（rev 286）—— §86 之后命令成功**只做轻量确认、不再推进本机 cache**
//   11:43:58.319  ← 立刻起一条 **10 页全量读**（lane=background，13 次云调用）
//   11:43:59.714  A cancel 落云（rev 287）—— 它自己只花 1545ms，§86 修好了这一块
//   11:44:02.394  B create 进入 execute（界面已显示"预约成功"）
//   11:44:02.394 → 11:44:11.538   **排在 #432 那条 10 页整读后面干等 9144ms**
//   11:44:13.374  B 才真正落云（rev 288）
//   ⇒ 从"电脑显示 B"到"云端真有 B"差 **11 秒**；手机第一次下拉必然落在这个空档里，
//     于是**正确地**读到"这个时段此刻就是空的"（症状：第一次为空、第二次才是 B）。
//
// 根因（`utils/cloud-primary-adapter.js`）：`applyChanges` 原来只开放给 `lane === 'user'`。
//   §86 之后写命令不再推进本机 cache ⇒ **任何**后台读看到的都是"cache 落后"
//   ⇒ background 泳道没有增量可用 ⇒ 每一次都退化成 metadata + 8 集合 10 页 + integrity，
//   而它与写命令共用同一条 `serialize` 航位 ⇒ 把下一条命令堵在门外。
//   ⇒ §86 只是把那次搬运从"命令结束后 20~70ms"**推迟**到了"命令之间"，代价一秒没少。
//
// 修法（本文件守的就是它）：`lane === 'background'` 同样先试**一跳** `changes`，
//   但**只跳一次、不追收敛**（`convergeUserRead` 仍然是 user 泳道专属，一个字没动）。
//
// 本测试跑的是**真实云函数 + 真实客户端**（复用 tests/helpers/sandbox-command-world.js：
// 只有 wx 与 CloudBase DB 是假的），所以两端一起钉：
//   A. 正常链 A create → 后台刷新 → cancel A → 后台刷新 → create B → 后台刷新
//      · 每次后台刷新 = 恰好一次 `changes`，**0 次 metadata / 0 次分页 / 0 次 integrity**；
//      · 整条链一次 10 页全量读都不许出现（这正是真机上吃掉 9.1 秒的那一段）；
//      · 最终云端 A=0、B=1；本机看到的也是 B；outbox 能清空。
//   B. 异常必须**安全退回完整读取**（宁慢不错），每一种都要真的翻 8 个集合并最终成功：
//      ① 镜像不可用（MIRROR_UNAVAILABLE）
//      ② revision 不可信（CHANGES_MALFORMED）
//      ③ 增量校验失败（INCREMENTAL_FINGERPRINT_MISMATCH）
//      ④ 云函数不认识 changes（INVALID_ACTION）
//      ⑤ 传输抛错 ⇒ 绝不许被改写成 ok:false 的假失败，必须照旧抛出
//   C. user 泳道的收敛循环不受影响（仍然 changes + integrity、0 页）。
const assert = require('assert')
const path = require('path')
const { createWorld } = require('./helpers/sandbox-command-world')
const readTiming = require('../utils/read-timing')
const outbox = require('../utils/local-outbox')

const PROJ = path.resolve(__dirname, '..')
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
// 云端行形状不统一：students / packages 是**扁平**的（自带 studentId / packageId），
// bookings 是 `{ data: {...} }`。这里两种都认，绝不因为形状差异让断言失焦。
const dataOf = row => (row && row.data) ? row.data : (row || {})
const idOf = (row, key) => (row && (row[key] || (row.data && (row.data[key] || row.data.id)))) || null

async function run() {
  const world = createWorld()
  const { ui, mutate, runtime, sync, datasetId } = world
  const adapter = ui.adapter
  const SCOPE = { environment: 'sandbox', datasetId }
  const call = (name, data) => global.wx.cloud.callFunction({ name, data }).then(response => response.result)
  const cloudRevision = async () => (await call('coachBusinessCommand', { action: 'status', environment: 'sandbox' })).datasetRevision
  const mark = () => world.calls.length
  const readActions = from => world.calls.slice(from).filter(item => item.name === 'readMyActiveCoachData').map(item => item.data.action)
  const lastLedger = () => readTiming.list().slice(-1)[0]
  // ⚠️ 退回完整读取时账本会落**两**行：先是"增量做不到"（带兜底原因），再是完整读取自己那一行。
  const lastFallback = () => readTiming.list().slice().reverse().find(row => row.incrementalFallback) || { incrementalFallback: '' }
  // 本机 cache 的存储键（镜像也有 datasetId/revision，靠 snapshot 区分）
  const cacheKeyOf = () => Object.keys(world.store).find(key => {
    const value = world.store[key]
    return value && typeof value === 'object' && value.datasetId === datasetId && value.snapshot
  })
  const localRows = () => runtime.getDB().bookings
  const slotRows = () => localRows().filter(row => row.date === DATE && Number(row.hour) === HOUR)

  const DATE = '2026-11-01', HOUR = 14

  // ————————————————————————————————————————————————————————————
  // 基线：两名学员 + 课时包，再做一次完整读取（此刻还没有 cache，必然是完整读取）
  // ————————————————————————————————————————————————————————————
  const makeStudent = async name => {
    assert.equal((await mutate(null, null, { command: 'createStudent', payload: { name, phone: '' } })).ok, true)
    await world.idle()
    const row = world.rows('students').find(item => dataOf(item).name === name)
    assert.ok(row, '（前置）学员必须建出来：' + name)
    const studentId = idOf(row, 'studentId')
    assert.ok(studentId, '（前置）必须拿到学员正式 id')
    assert.equal((await mutate(null, null, { command: 'createPackage', payload: { studentId, type: '赠送课程', total: 10, remaining: 10, isGift: true } })).ok, true)
    await world.idle()
    const pkg = world.rows('packages').find(item => idOf(item, 'studentId') === studentId)
    assert.ok(pkg, '（前置）课时包必须建出来')
    return { studentId, packageId: idOf(pkg, 'packageId') }
  }
  const A = await makeStudent('后台增量·甲')
  const B = await makeStudent('后台增量·乙')
  const baseline = await adapter.readActive()
  assert.equal(baseline.ok, true, '（前置）基线完整读取必须成功')
  assert.equal(localRows().length, 0, '（前置）基线还没有任何预约')

  // ══════════════════════════════════════════════════════════════
  // A. 正常链：A create → 后台刷新 → cancel A → 后台刷新 → create B → 后台刷新
  // ══════════════════════════════════════════════════════════════
  const sceneStart = mark()
  const ledgerStart = readTiming.list().length
  const bookA = { studentId: A.studentId, packageId: A.packageId, date: DATE, hour: HOUR, minute: 0 }
  const bookB = { studentId: B.studentId, packageId: B.packageId, date: DATE, hour: HOUR, minute: 0 }

  assert.equal((await mutate('createBooking', bookA, { key: 'k-bg-A' })).ok, true, '（前置）本机约上 A')
  await world.idle()

  // ① 第一次后台刷新
  let from = mark()
  let bg = await adapter.readActive()                       // 不带 userInitiated ⇒ lane = 'background'
  assert.equal(bg.ok, true, '后台刷新必须成功：' + JSON.stringify(bg))
  assert.deepEqual(readActions(from), ['changes'],
    '★★ 后台刷新必须**只**发一次 changes（不许 metadata / 分页 / integrity），实得 ' + JSON.stringify(readActions(from)))
  assert.equal(lastLedger().lane, 'background', '账本必须如实记下这是后台轮次')
  assert.equal(lastLedger().pages, 0, '★★ 后台刷新页数必须是 0（真机上省下来的 10 次往返就在这里）')
  assert.equal(lastLedger().incrementalFallback, '', '走成了就不许留兜底原因')
  assert.equal(lastLedger().skipped, 'INCREMENTAL', '这一轮必须有真增量被套上去')
  assert.equal(bg.revision, await cloudRevision(), '后台刷新必须把本机 revision 推到云端当前值')
  assert.equal(slotRows().length, 1, '（前置）本机此刻看到 A')

  // ② 取消 A
  const officialA = slotRows()[0].id
  await ui.cancelBookingRequest({ officialId: officialA, booking: bookA })
  await world.idle()
  assert.equal(world.rows('bookings').filter(row => dataOf(row).id === officialA).length, 0, '（前置）云端 A 已取消')
  assert.equal(slotRows().length, 0, '★ A 取消之后本机也绝不能看到它（不许幽灵恢复）')

  // ③ 第二次后台刷新
  from = mark()
  bg = await adapter.readActive()
  assert.equal(bg.ok, true)
  assert.deepEqual(readActions(from), ['changes'], '★★ 取消之后的后台刷新同样只许一次 changes')
  assert.equal(lastLedger().pages, 0, '★★ 取消之后的后台刷新不许翻任何分页')
  assert.equal(lastLedger().incrementalFallback, '', '走成了就不许留兜底原因')
  assert.equal(bg.revision, await cloudRevision(), 'revision 必须推到云端当前值')

  // ④ 同一时段立刻约 B
  assert.equal((await mutate('createBooking', bookB, { key: 'k-bg-B' })).ok, true,
    '★ A 取消之后同一时段必须能立刻约给别人（不许再被"时间冲突"挡住）')
  await world.idle()

  // ⑤ 第三次后台刷新
  from = mark()
  bg = await adapter.readActive()
  assert.equal(bg.ok, true)
  assert.deepEqual(readActions(from), ['changes'], '★★ B 落云之后的后台刷新同样只许一次 changes')
  assert.equal(lastLedger().pages, 0, '★★ 这一轮也一页都不许翻')
  assert.equal(bg.revision, await cloudRevision(), 'revision 必须推到云端当前值')

  // ——— 最终业务不变量 ———
  const cloudSlot = world.rows('bookings').map(dataOf).filter(row => row.date === DATE && Number(row.hour) === HOUR)
  assert.equal(cloudSlot.length, 1, '★★ 云端这个时段必须恰好 1 条，实得 ' + JSON.stringify(cloudSlot))
  assert.equal(cloudSlot[0].studentId, B.studentId, '★★ 留在场上的必须是 B')
  assert.equal(slotRows().length, 1, '★★ 本机也必须恰好 1 条')
  assert.equal(slotRows()[0].studentId, B.studentId, '★★ 本机看到的必须是 B（不许是幽灵 A）')

  // ★★★ 整条正常链一次 10 页全量读都不许出现 —— 这就是真机上吃掉 9.1 秒的那一段
  const chainActions = readActions(sceneStart)
  assert.equal(chainActions.filter(action => action === 'metadata').length, 0,
    '★★★ 正常链不许出现任何 metadata（完整读取的开场就在这里），实得 ' + JSON.stringify(chainActions))
  assert.equal(chainActions.filter(action => action === 'page').length, 0,
    '★★★ 正常链一页完整读取都不许有（真机：它排在 B 的 create 前面 9144ms），实得 ' + JSON.stringify(chainActions))
  assert.equal(chainActions.filter(action => action === 'changes').length, 3,
    '★ 三次后台刷新 = 三次 changes，实得 ' + JSON.stringify(chainActions))
  // ⚠️ 链上剩下的 `integrity` 是**三条写命令各自的轻量确认**（§86 的 confirmAfterWrite，1 次往返、
  //    不翻任何集合），不是读取。后台**读取**那一轮本身必须一次 integrity 都没有 ——
  //    "确认云端最新 revision"那一跳是 user 泳道收敛循环的专属物，后台只跳一次、不追收敛。
  const bgLedgers = readTiming.list().slice(ledgerStart).filter(row => row.lane === 'background')
  assert.ok(bgLedgers.length >= 3, '（前置）三次后台刷新必须各留一条后台账')
  bgLedgers.forEach(row => {
    assert.equal(row.pages, 0, '★ 后台读取页数必须是 0')
    assert.equal(row.metadataMs, 0, '★ 后台读取不许有 metadata 开销')
    assert.equal(row.integrityMs, 0,
      '★ 后台读取只跳一次 changes、不追收敛 ⇒ 一次 integrity 开销都不许有，实得 ' + row.integrityMs)
    assert.equal(row.incrementalFallback, '', '★ 后台读取走成了就不许留兜底原因')
  })

  // ——— 队列最终能清空（D）———
  await sync.flush()
  await world.idle()
  assert.equal(outbox.count(SCOPE), 0,
    '★★ 成功命令最终必须安全出队（settled 不得永久滞留），实得 ' + outbox.count(SCOPE) + ' ' + JSON.stringify(outbox.settled(SCOPE).map(row => row.command)))
  assert.equal(slotRows().length, 1, '★ 出队之后 B 仍然必须在（出队不许把事实弄丢）')
  assert.equal(slotRows()[0].studentId, B.studentId, '★ 出队之后看到的仍然是 B')

  // ══════════════════════════════════════════════════════════════
  // B. 异常必须安全退回完整读取（宁慢也绝不错）
  // ══════════════════════════════════════════════════════════════
  const outerCall = global.wx.cloud.callFunction
  const tamper = { checksum: false, legacy: false, badRevision: false, throwTransport: false }
  global.wx.cloud.callFunction = async request => {
    const isChanges = request && request.data && request.data.action === 'changes'
    if (isChanges && tamper.throwTransport) throw new Error('cloud call interrupted')
    const response = await outerCall(request)
    if (isChanges && response && response.result) {
      if (tamper.legacy) return { result: { ok: false, code: 'INVALID_ACTION' } }
      if (tamper.badRevision) { const copy = clone(response); copy.result.dataRevision = 'not-a-number'; return copy }
      if (tamper.checksum) { const copy = clone(response); copy.result.checksum = 'corrupted-' + copy.result.checksum; return copy }
    }
    return response
  }
  // 让云端前进一版（否则走的是"没变化"那一跳，根本到不了镜像解析与指纹比对）
  let advanceSeq = 0
  const advance = async () => {
    // ⭐ 起点放在 08:00 是为了**留足余量**：课程最晚 24:00 结束（默认 60 分钟）⇒
    //    23:00 是最后一个可约起点。这里只是要"让云端前进一版"的一条数据，与被测的增量读无关，
    //    不该被"最晚结束"这道闸拦下 ⇒ 递增的时段必须整体落在合法区间内。
    const hour = 8 + (advanceSeq++)                          // 每次用一个**全新**的时段，绝不与既有预约撞车
    const result = await mutate('createBooking', { studentId: A.studentId, packageId: A.packageId, date: '2026-11-02', hour, minute: 0 }, { key: 'k-adv-' + hour })
    assert.equal(result.ok, true, '（前置）让云端前进一版的预约必须成功：' + JSON.stringify(result))
    await world.idle()
  }
  const expectFullRead = async (label, expectedReason) => {
    await advance()
    from = mark()
    const result = await adapter.readActive()
    assert.equal(result.ok, true, label + '：★ 退回完整读取之后必须**如实成功**：' + JSON.stringify(result))
    assert.ok(readActions(from).includes('metadata'), label + '：★ 必须真的退回完整读取，实得 ' + JSON.stringify(readActions(from)))
    assert.equal(readActions(from).filter(action => action === 'page').length, 8,
      label + '：★ 退回完整读取时八个集合一个都不许跳过')
    assert.equal(result.revision, await cloudRevision(), label + '：★ 完整读取必须落在云端当前 revision')
    assert.equal(lastFallback().incrementalFallback, expectedReason,
      label + '：★ 账本必须如实说出退回原因，实得 ' + lastFallback().incrementalFallback)
    assert.equal(lastLedger().lane, 'background', label + '：（形态检查）这一轮仍然是后台轮次')
  }

  // ① 镜像不可用：抹掉落盘镜像 + 改坏 cache 的 checksum ⇒ 就地重建也自证不过 ⇒ resolveMirror 必然 null
  {
    await advance()
    wx.removeStorageSync('coachSandboxActiveRows')
    const key = cacheKeyOf()
    assert.ok(key, '（前置）必须能定位到本机 cache 的存储键')
    const cache = clone(world.store[key])
    cache.checksum = 'corrupt-' + cache.checksum
    wx.setStorageSync(key, cache)
    from = mark()
    const result = await adapter.readActive()
    assert.equal(result.ok, true, '镜像不可用时必须退回完整读取并成功：' + JSON.stringify(result))
    assert.equal(lastFallback().incrementalFallback, 'MIRROR_UNAVAILABLE',
      '★★ 镜像拿不到必须退回完整读取，实得 ' + lastFallback().incrementalFallback)
    assert.equal(readActions(from).filter(action => action === 'page').length, 8,
      '★★ 镜像不可用 ⇒ 八个集合一个都不少，实得 ' + JSON.stringify(readActions(from)))
    assert.equal(result.revision, await cloudRevision(), '★ 退回之后必须落在云端当前 revision')
  }
  // ② revision 不可信
  {
    tamper.badRevision = true
    await expectFullRead('★★ revision 不可信', 'CHANGES_MALFORMED')
    tamper.badRevision = false
  }
  // ③ 增量校验失败（云端回的指纹与本机重算的对不上）
  {
    tamper.checksum = true
    await expectFullRead('★★ 增量指纹对不上', 'INCREMENTAL_FINGERPRINT_MISMATCH')
    tamper.checksum = false
    // 被篡改的坏指纹绝不许被采用
    assert.equal(String(adapter.getState().checksum).startsWith('corrupted-'), false,
      '★★ 被篡改的坏指纹绝不许被采用 —— 宁慢也不错')
  }
  // ④ 云函数还不认识 changes（体验版先上、云函数没部署）
  {
    tamper.legacy = true
    await expectFullRead('★★ 旧云函数不认 changes', 'INVALID_ACTION')
    tamper.legacy = false
  }
  // ⑤a `changes` 那一跳传输中断：绝不许把它当成"没变化"交卷 ⇒ 必须退回完整读取并如实成功
  {
    await advance()
    tamper.throwTransport = true
    from = mark()
    const result = await adapter.readActive()
    tamper.throwTransport = false
    assert.equal(result.ok, true, 'changes 传输中断后必须退回完整读取并成功：' + JSON.stringify(result))
    assert.equal(readActions(from).filter(action => action === 'page').length, 8,
      '★★ changes 传输中断 ⇒ 必须真的退回完整读取，实得 ' + JSON.stringify(readActions(from)))
    assert.equal(lastFallback().incrementalFallback, 'CHANGES_CALL_FAILED',
      '★★ 账本必须如实记下"changes 那一跳传输中断"，实得 ' + lastFallback().incrementalFallback)
    assert.notEqual(lastLedger().skipped, 'VERIFIED_UNCHANGED',
      '★★ 绝不许把"changes 没问到"当成"云端没变化"交卷（那会让页面继续显示旧课表且毫无提示）')
  }
  // ⑤b 整个读取通道都抛错：既有契约是「传输抛错整次回读照旧抛出去」，不许被吞成 ok:false
  {
    const throwAll = async () => { throw new Error('cloud call interrupted') }
    global.wx.cloud.callFunction = async request => {
      if (request && request.name === 'readMyActiveCoachData') return throwAll()
      return outerCall(request)
    }
    let threw = false
    try { await adapter.readActive() } catch (error) { threw = true }
    global.wx.cloud.callFunction = outerCall
    assert.equal(threw, true,
      '★★ 传输层抛错必须照旧抛出去 —— 绝不许把它吞成 ok:false（那会让页面以为"读成功了、只是没变化"）')
  }
  global.wx.cloud.callFunction = outerCall

  // ══════════════════════════════════════════════════════════════
  // C. user 泳道的收敛循环不受影响（本轮一个字没动它）
  // ══════════════════════════════════════════════════════════════
  from = mark()
  const pulled = await adapter.readActive({ userInitiated: true })
  assert.equal(pulled.ok, true, '用户下拉必须照常成功：' + JSON.stringify(pulled))
  const userActions = readActions(from)
  assert.ok(userActions.includes('changes'), '用户下拉仍然必须走增量，实得 ' + JSON.stringify(userActions))
  // ★ 1.1.9 第 16 轮（§90）：新云函数把 HEAD 随 `changes` 一起回 ⇒ 用户下拉正常只要**一次**调用。
  //   （"确认云端最新 revision"那一跳不再单独发 —— 旧云函数没有 headRevision 时它照旧存在，
  //     那条向后兼容的回归钉在 tests/read-first-hop-probe.test.js 里。）
  assert.deepEqual(userActions, ['changes'],
    '★★ 新云函数下用户下拉必须只发一次 changes（省掉那次串行 integrity），实得 ' + JSON.stringify(userActions))
  assert.equal(readActions(from).filter(action => action === 'page').length, 0, '用户下拉仍然必须 0 页')
  assert.equal(lastLedger().lane, 'user', '（形态检查）这一轮必须是用户轮次')
  assert.equal(lastLedger().integrityMs, 0, '★★ 用户下拉这一轮的 integrity 开销必须是 0')
  // ⚠️ 与后台那条边界相反：这里**允许**追多跳（用户在等"此刻最新"），但只许是 changes。
  assert.ok(userActions.filter(action => action === 'changes').length <= 3,
    '★ 一次下拉内部最多追 CONVERGE_MAX_HOPS 跳，实得 ' + JSON.stringify(userActions))

  // ══════════════════════════════════════════════════════════════
  // D. 静态契约：后台开放了，但边界一个都不许松
  // ══════════════════════════════════════════════════════════════
  {
    const src = require('fs').readFileSync(path.join(PROJ, 'utils', 'cloud-primary-adapter.js'), 'utf8')
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')
    // ① 后台必须真的进得去增量分支
    assert.ok(/state\.lane === 'user' \|\| state\.lane === 'background'/.test(bare),
      '★ 后台轮次必须同样能进增量分支')
    // ② 收敛循环仍然**只**属于用户泳道（后台不许追收敛，那是"多占航位"的老路）
    assert.ok(/if \(state\.lane === 'user'\) \{[\s\S]{0,400}?convergeUserRead\(/.test(bare),
      '★ convergeUserRead 必须仍被 user 泳道单独包住（后台只跳一次）')
    // ③ 完整读取仍然只由后台"真退不动"时才走：applyChanges 的每一条退路都必须保留
    ;['MIRROR_UNAVAILABLE', 'CHANGES_MALFORMED', 'INCREMENTAL_FINGERPRINT_MISMATCH', 'CHANGES_DATASET_CHANGED', 'CHANGES_REVISION_UNEXPECTED'].forEach(reason => {
      assert.ok(bare.includes(reason), '★ 退路 ' + reason + ' 必须保留（缺一条就可能把错数据写进 cache）')
    })
    // ④ 五项指纹逐项比对不许少（"不许为了速度吞掉校验"这条要求的落点）
    assert.ok(/checksum: actual\.checksum !== response\.checksum/.test(bare), '★ checksum 比对必须在')
    assert.ok(/byteSize: actual\.byteSize !== response\.byteSize/.test(bare), '★ byteSize 比对必须在')
    assert.ok(/summary: !sameSummary\(actual\.summary, response\.summary\)/.test(bare), '★ summary 比对必须在')
    assert.ok(/counts: !sameSummary\(actual\.counts, response\.counts\)/.test(bare), '★ counts 比对必须在')
    assert.ok(/amounts: !sameSummary\(actual\.amounts, response\.amounts\)/.test(bare), '★ amounts 比对必须在')
    // ⑤ 增量调用点仍然只有一处（不许为后台另开一条"后台专属"的增量路）
    assert.equal((bare.match(/action:\s*'changes'/g) || []).length, 1, '★ 增量读取只允许有一个调用点（user 与 background 共用它）')
    // ⑥ §86 的零云调用出队不许被本轮破坏
    const engine = require('fs').readFileSync(path.join(PROJ, 'utils', 'sync-engine.js'), 'utf8')
    assert.ok(/(const|let) ready = rows\.filter\(cacheCaughtUp\)/.test(engine), '★ §86 的零云调用出队路径必须还在')
  }

  console.log('background incremental read: PASS'
    + '（后台刷新 = 恰好一次 changes / 0 metadata / 0 分页 / 0 integrity；'
    + 'A create→取消→B 整条链零完整读取；云端 A=0、B=1；队列清空；'
    + '镜像不可用 / revision 不可信 / 指纹对不上 / 旧云函数 / 传输抛错 五类异常全部安全退回；'
    + 'user 泳道收敛循环未受影响）')
}

run().catch(error => { console.error('background incremental read: FAIL'); console.error(error); process.exitCode = 1 })
