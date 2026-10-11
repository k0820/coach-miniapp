// 预约「前台即时响应 + 后台云端安全确认」协调器。
// 设计边界（重要）：
//  - 只做编排，不复制任何云端命令逻辑：真正落库仍然调用 adapter.execute(command, payload)，即现有
//    coachBusinessCommand（单事务：receipt 幂等 → expectedRevision → 业务写入 → revision+1 → succeeded receipt）
//    之后仍然执行完整 active read（metadata + 八集合分页 + 服务端动态 integrity + 客户端重建核对 + cache 回读）。
//  - 本模块绝不写 coachCloudActiveCache / coachSandboxActiveCache，也绝不写 coachDB；
//    乐观数据只在视图层与 cache 合并。
//  - 不因为提速删除任何校验：唯一的区别是 UI 不再 await 这条链。
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const two = value => { const n = Number(value) || 0; return (n < 10 ? '0' : '') + n }
// 后台确认延到下一个 tick 再启动：先让弹层关闭、课表把课程块画出来，再让网络栈开始工作。
const defer = task => { if (typeof setTimeout === 'function') setTimeout(task, 0); else task() }

// ★ 2026-09-22 真机根因修复（"电脑版约好了、手机版永远刷不出来"）：
// 一条预约被本机乐观地画上课表之后，只有两种方式能真的落到云端：createBooking 出网成功，
// 或者后面有人用**同一个 requestId** 把它补发出去。原来的自动路径（resume）只查回执、
// 永不补发 —— 于是一旦第一次发送就没成功，这条预约就永远只活在这台设备的存储里：
// 本机课表看得见（待确认状态不画在像素上，和正式课程长得一模一样），另一台设备永远读不到。
//
// 补发为什么是安全的（两条都写在本文件的既有规则里）：
//   · 云端把 receipt 和业务写放在**同一个事务**里 ⇒ `receipt.found === false` 是权威结论：
//     云端从来没有受理过这条命令（见 resolveCancelTarget 的注释）。
//   · requestId 固定不变 ⇒ 服务端 receipt 仍把它认作**同一次请求**，不可能变成两条业务。
// 所以"补发"不是重试业务，而是**把一次从未送达的投递补上**。
// 有界：同一条预约在**一次进程内**最多发出 MAX_SEND_ATTEMPTS 次（1 次首发 + 最多 2 次补发），
// 绝不把一台正在出故障的服务器往死里打。到顶之后**如实标记 + 把重试预算还回去**，
// 把后续补发交给用户的节奏（重新进页面 / 下拉刷新 → resume），而不是原地空转。
// （口径与 sync-engine 一致：它那边是"每条每轮最多补一次 revision，其余退避到下一轮"。）
// ⚠️ 计数的是**总发送次数**，不是"重发次数"：confirm 开头的 patch 先把 attempt +1 落到记录上，
//    所以 settle 里拿到的 entry.attempt 已经包含"刚刚这一次"。
const MAX_SEND_ATTEMPTS = 3

// 「本机不知道云端版本号」是可以自愈的前置条件，不是业务失败 —— 补齐后原号重发。
// （adapter.execute 在 revision 不是整数时会**在出网之前**就返回 REVISION_UNKNOWN。）
async function ensureRevision(adapter) {
  try {
    if (!adapter || typeof adapter.getState !== 'function') return false
    if (Number.isInteger(adapter.getState().revision)) return true
    const active = await adapter.readActive()
    return !!(active && active.ok)
  } catch (error) { return false }
}

function createBookingOptimistic(options) {
  const {
    runtime, pending, adapter, isOnline = () => true, newRequestId,
    readDatasetId = () => '', readSnapshot = () => null,
    cancellation = null, completion = null, onCancelled = () => {},
    onTiming = () => {}, showToast = () => {}, showModal = () => {}, now = () => Date.now()
  } = options
  const listeners = new Set()
  const inFlight = new Set()
  const cancelInFlight = new Set()
  const canCancel = !!cancellation && typeof cancellation.begin === 'function'
  const canHealCompletion = !!completion && typeof completion.list === 'function'

  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }
  function notify() { listeners.forEach(listener => { try { listener() } catch (error) {} }) }
  function environment() { return runtime.environment() === 'sandbox' ? 'sandbox' : 'production' }

  // 视图层使用的 active datasetId：优先本机 cache（getDB 的同一份数据），其次 adapter 内存态。
  function activeDatasetId() {
    const cached = readDatasetId()
    if (cached) return cached
    const state = adapter.getState()
    return state && state.datasetId ? state.datasetId : ''
  }

  function frozen() {
    const cutover = runtime.cutoverState()
    return cutover.status === runtime.MODES.ACTIVATING || cutover.status === runtime.MODES.PENDING ||
      require('./production-recovery-guard').blocksBusiness(runtime.environment())
  }

  // —— 取消待确认（tombstone）：视图层临时隐藏，绝不改 cache ——
  function cancelRecords() {
    if (!canCancel) return []
    return cancellation.list(environment(), activeDatasetId()).map(entry => ({
      localKey: entry.localKey,
      officialId: entry.officialId,
      requestId: entry.requestId,
      status: entry.status,
      payload: clone(entry.payload),
      pending: true
    }))
  }
  function cancellationFor(localKeyValue) {
    if (!canCancel || !localKeyValue) return null
    return cancellation.get(environment(), activeDatasetId(), localKeyValue)
  }
  // 把 tombstone 摊平成两套索引：转正前后都能把该藏起来的块认出来。
  function cancelIndex() {
    const rows = canCancel ? cancellation.list(environment(), activeDatasetId()) : []
    return {
      officialIds: new Set(rows.filter(row => row.officialId).map(row => row.officialId)),
      localKeys: new Set(rows.map(row => row.localKey)),
      payloads: rows.map(row => clone(row.payload))
    }
  }

  function records() {
    const hidden = cancelIndex()
    return pending.list(environment(), activeDatasetId())
      // 已经点了取消的待确认预约，视图层立刻不再渲染（内部记录留着，等与 create 排序）。
      .filter(entry => !hidden.localKeys.has(entry.bookingKey))
      .map(entry => ({
      ...clone(entry.view),
      pending: true,
      pendingKey: entry.bookingKey,
      pendingRequestId: entry.requestId,
      pendingStatus: entry.status,
      // 配对用：合并时要靠它与云端快照里刚落库的正式记录认亲，才能做到「同一帧替换、不出现两条」。
      pendingPayload: clone(entry.payload),
      pendingLabel: entry.status === 'unknown' ? '待确认' : entry.status === 'syncing' ? '同步中' : '提交中',
      // 稳定渲染 key：这条预约从「待确认」转成「正式记录」时 key 不变，
      // 小程序不会销毁重建这个节点，所以视觉上不会闪、不会重新出现。
      viewKey: `stable:${entry.bookingKey}`
    }))
  }

  // 视图层唯一入口：把 cache 的 bookings 与待确认预约合并。getDB() 永远看不到这里的数据。
  // 关键：同一条预约在「待确认 → 正式」之间必须共用同一个 viewKey，且同一时刻只渲染一个块。
  function mergeBookings(bookings) {
    const list = Array.isArray(bookings) ? bookings : []
    const hidden = cancelIndex()
    // 已经点过取消的块立刻不渲染 —— 这是「取消秒回」的全部视觉来源。
    // 注意：正式 cache 一个字都没改，所以任何统计、看板口径都不受影响；
    // 云端确认成功后 readActive 会让这条记录真的从 cache 里消失，tombstone 随即清除。
    const visible = list.filter(booking => {
      if (booking && booking.id && hidden.officialIds.has(booking.id)) return false
      // 还没转正 / 刚转正但 cache 仍是旧值：按业务键把它认出来，stale cache 不能把已取消的块带回来。
      if (hidden.payloads.length && pending.matches && hidden.payloads.some(payload => pending.matches(payload, booking))) return false
      return true
    })
    const extra = records()
    if (!extra.length) return visible
    const claimed = new Set()
    const merged = visible.map(booking => {
      const owner = extra.find(entry => !claimed.has(entry.pendingKey) && pending.matches(entry.pendingPayload, booking))
      if (!owner) return booking
      // 云端快照里已经出现这条预约（命令成功那一帧 cache 已刷新，但本机标记还没清）：
      // 正式记录接管待确认块的渲染 key，并让待确认块不再单独插入 —— 不会出现两条，也不会闪。
      claimed.add(owner.pendingKey)
      return { ...booking, viewKey: `stable:${owner.pendingKey}` }
    })
    return merged.concat(extra.filter(entry => !claimed.has(entry.pendingKey)))
  }

  function silentGuard() {
    if (frozen()) return { ok: false, code: 'CUTOVER_WRITE_FROZEN' }
    if (!isOnline()) return { ok: false, code: 'OFFLINE_READ_ONLY' }
    return null
  }

  // —— 本机身份 → 正式 bookingId 的绑定 ——
  // 正式 id 有两个来源：命令返回体（core.js 把它放在 result.result.bookingId），
  // 或回读快照里按业务键配对到的那条正式记录。任一可得即立刻绑定。
  function officialIdFrom(entry, result) {
    const inner = result && result.result
    if (inner && typeof inner.bookingId === 'string' && inner.bookingId) return inner.bookingId
    if (result && typeof result.bookingId === 'string' && result.bookingId) return result.bookingId
    const snapshot = readSnapshot()
    const list = snapshot && Array.isArray(snapshot.bookings) ? snapshot.bookings : []
    const hit = list.find(booking => pending.matches(entry.payload, booking))
    return hit && hit.id ? hit.id : ''
  }
  function bindOfficial(entry, officialId, payload) {
    if (!officialId || typeof pending.bindOfficial !== 'function') return ''
    try {
      pending.bindOfficial(entry.environment, entry.datasetId, entry.bookingKey, officialId, payload || entry.payload)
      return officialId
    } catch (error) {
      onTiming({ action: 'optimisticBooking', phase: 'bind-failed', id: entry.bookingKey, message: String(error && error.message) })
      return ''
    }
  }
  function bindOfficialFor(entry, result) { return bindOfficial(entry, officialIdFrom(entry, result)) }

  // 给「刚约完就想进课程详情」用：拿不到正式 id 时返回空串，绝不编造一个。
  function officialIdFor(bookingKeyValue) {
    if (!bookingKeyValue) return ''
    const env = environment(), datasetId = activeDatasetId()
    const bound = typeof pending.resolveOfficial === 'function' ? pending.resolveOfficial(env, datasetId, bookingKeyValue) : null
    if (bound && bound.officialId) return bound.officialId
    const entry = pending.get(env, datasetId, bookingKeyValue)
    // 本机先行的预约在 pending 那张表里没有记录（生产里它根本不会被写入），
    // 但它的正式 id 在 Outbox 的 idMap 里 —— 同一个「本机身份 → 正式 id」的另一份载体，必须一起看。
    if (!entry) return officialIdFromOutbox(bookingKeyValue, null)
    const snapshot = readSnapshot()
    const list = snapshot && Array.isArray(snapshot.bookings) ? snapshot.bookings : []
    const hit = list.find(booking => pending.matches(entry.payload, booking))
    if (!hit || !hit.id) return ''
    bindOfficial(entry, hit.id)
    return hit.id
  }

  // 等这条待确认预约转正（已有绑定立刻返回；转正时 notify 会把它唤醒；失败/被清掉则返回空串）。
  function awaitOfficial(bookingKeyValue, timeoutMs = 20000) {
    const immediate = officialIdFor(bookingKeyValue)
    if (immediate) return Promise.resolve(immediate)
    return new Promise(resolve => {
      let done = false, timer = null
      const finish = value => {
        if (done) return
        done = true
        unsubscribe()
        if (timer) clearTimeout(timer)
        resolve(value || '')
      }
      const unsubscribe = subscribe(() => {
        const id = officialIdFor(bookingKeyValue)
        if (id) return finish(id)
        if (!pending.get(environment(), activeDatasetId(), bookingKeyValue)) finish('')
      })
      if (typeof setTimeout === 'function') timer = setTimeout(() => finish(officialIdFor(bookingKeyValue)), timeoutMs)
    })
  }

  function guard() {
    const blocked = silentGuard()
    if (!blocked) return null
    if (blocked.code === 'CUTOVER_WRITE_FROZEN') showModal({ title: '业务修改已暂停', content: '云端已激活或正在确认，切换尚未完成。请先继续完成云端切换。', showCancel: false, confirmText: '知道了' })
    else showToast({ title: '当前离线，仅可查看', icon: 'none' })
    return blocked
  }

  // 前台路径：本地同步校验（调用方已完成业务校验）→ 写 pending 并回读 → 立刻返回。
  async function submit(input) {
    const blocked = guard(); if (blocked) return blocked
    const datasetId = activeDatasetId()
    if (!datasetId) { showToast({ title: '云端数据尚未就绪，请稍后重试', icon: 'none' }); return { ok: false, code: 'CLOUD_DATASET_UNKNOWN' } }
    const env = environment(), id = pending.bookingKey(input)
    // 这个时段正在取消中：绝不允许在同一把业务键上再叠一条新预约 ——
    // 两条操作共用一个键会互相踩（新块被 tombstone 藏掉、取消反而打在新预约上）。
    if (canCancel && cancellation.get(env, datasetId, id)) {
      notify()
      showToast({ title: '这个时段正在取消中，稍后再约', icon: 'none' })
      return { ok: false, code: 'CANCELLATION_IN_PROGRESS', id }
    }
    const existing = pending.get(env, datasetId, id)
    if (existing) {
      notify()
      showToast({ title: existing.status === 'unknown' ? '该预约仍在确认中' : '该预约正在提交中', icon: 'none' })
      return { ok: true, duplicate: true, requestId: existing.requestId, id }
    }
    const started = now()
    const requestId = newRequestId()
    const view = {
      id: `pending:${id}`, studentId: input.studentId, studentName: input.studentName,
      packageId: input.packageId, packageIndex: input.packageIndex,
      date: input.date, hour: Number(input.hour), minute: Number(input.minute || 0),
      typeName: input.typeName, price: input.price, status: 'booked', createdAt: started
    }
    let created
    try { created = pending.create(env, datasetId, id, requestId, input, view, started) }
    catch (error) {
      onTiming({ action: 'optimisticBooking', phase: 'pending-write-failed', message: String(error && error.message) })
      showToast({ title: '本机暂存失败，请重试', icon: 'none' })
      return { ok: false, code: 'PENDING_WRITE_FAILED' }
    }
    notify()
    onTiming({ action: 'optimisticBooking', phase: 'pending-visible', id, requestId, totalMs: now() - started, cloudCalls: 0 })
    // 旧本地版的即时反馈就长这样：点完立刻「已约 08:00」。云端确认成功时不再二次播报，
    // 否则用户会从后到的「已保存」提示里读出「现在才算成功」，秒回体感就没了。
    showToast({ title: `已约 ${two(input.hour)}:${two(input.minute || 0)}`, icon: 'none' })
    defer(() => { void confirm(created.entry, input.command) })
    return { ok: true, requestId, id, deferred: true, duplicate: !created.created, localMs: now() - started }
  }

  // 后台路径：完整 Cloud Command + 完整 active read/integrity/cache。谁都不 await 它。
  async function confirm(entry, command) {
    if (inFlight.has(entry.bookingKey)) return { ok: false, code: 'IN_FLIGHT' }
    if (environment() !== entry.environment || activeDatasetId() !== entry.datasetId) return { ok: false, code: 'ENVIRONMENT_CHANGED' }
    inFlight.add(entry.bookingKey)
    const started = now(), env = entry.environment, datasetId = entry.datasetId
    try {
      let marked
      try { marked = pending.patch(env, datasetId, entry.bookingKey, entry.requestId, { status: 'confirming', attempt: Number(entry.attempt || 0) + 1 }) }
      catch (error) { marked = null }
      if (!marked) return { ok: false, code: 'PENDING_UPDATE_FAILED' }
      if (!Number.isInteger(adapter.getState().revision)) {
        const active = await adapter.readActive()
        if (!active.ok) return settle(marked, { ok: false, code: active.code || 'ACTIVE_READ_FAILED' })
      }
      const result = await adapter.execute(command || 'createBooking', marked.payload, { requestId: marked.requestId })
      return await settle(marked, result)
    } catch (error) {
      return await settle(entry, { ok: false, code: 'COMMAND_RESULT_UNKNOWN' })
    } finally {
      inFlight.delete(entry.bookingKey)
      onTiming({ action: 'optimisticBooking', phase: 'background-confirm', id: entry.bookingKey, requestId: entry.requestId, totalMs: now() - started })
    }
  }

  function finish(env, datasetId, entry, title) {
    // 任何收尾路径都先保住「正式身份」绑定（快照兜底，幂等）；绑定失败不阻塞收尾。
    bindOfficialFor(entry, null)
    pending.remove(env, datasetId, entry.bookingKey, entry.requestId)
    notify()
    if (title) showToast({ title, icon: 'none' })
  }

  async function settle(entry, result) {
    const env = entry.environment, datasetId = entry.datasetId
    // 这条预约在 create 还在路上时已经被用户取消了 → 不能按常规收尾，要把 create 与 cancel 排序。
    const cancelled = canCancel ? cancellationFor(entry.bookingKey) : null
    if (result && result.ok) {
      // 命令已经在云端成功：先把「本机身份 → 正式 bookingId」绑好，再收尾。
      // 绑定必须发生在移除本机记录之前，否则「刚约完就进课程详情」会拿不到正式身份。
      bindOfficialFor(entry, result)
      if (cancelled) {
        // create 已经落地，但用户在这期间点了取消：立刻把取消接上去（绝不留下一条「幽灵预约」）。
        // 本机记录先留着 —— 等取消真的落到云端，由 finishCancel 一次清干净。
        notify()
        defer(() => { void runCancel(entry.bookingKey) })
        return { ok: true, code: 'CONFIRMED_THEN_CANCELLING' }
      }
      // 成功路径静默收尾：块在第一帧就已经是正常课程的样子，这里再播报一次「已保存」
      // 只会让用户以为「现在才成功」，所以只在失败/未知时才打扰用户。
      if (result.refreshed && result.refreshed.ok) { finish(env, datasetId, entry); return { ok: true, code: 'CONFIRMED' } }
      // ★ 1.1.9 第 6 轮：命令已在云端成功，而且**云端已被那一跳只读校验确认**处于本命令提交后的
      //   revision，只是本机 cache 还没翻完 —— 这时**不再补一次完整回读**（修前那一次要 8–10 秒）。
      //   本机记录改标 syncing（块继续按正式课程渲染、渲染 key 不变、状态不画在像素上），
      //   收尾交给既有 self-heal：resume() 里「快照已包含这条 ⇒ 绑正式身份并清掉本机标记」。
      //   ⚠️ finish() 只能在本机 cache 真的包含这条事实之后调用 —— 否则块会当场消失、
      //      要等下一轮完整回读才冒回来（用户看到的就是"刚约的课又没了"）。
      if (result.confirmed && result.confirmed.ok) {
        try { pending.patch(env, datasetId, entry.bookingKey, entry.requestId, { status: 'syncing' }) } catch (error) {}
        notify()
        return { ok: true, code: 'CONFIRMED_PENDING_CACHE' }
      }
      // 命令已在云端成功，只是回读刷新失败：保留明确「同步中」状态，绝不重发命令。
      let syncing
      try { syncing = pending.patch(env, datasetId, entry.bookingKey, entry.requestId, { status: 'syncing' }) } catch (error) { syncing = null }
      notify()
      if (!syncing) return { ok: true, code: 'CONFIRMED' }
      const refreshed = await adapter.readActive().catch(() => ({ ok: false }))
      if (refreshed && refreshed.ok) finish(env, datasetId, syncing)
      else { showToast({ title: '预约已提交，正在同步', icon: 'none' }); notify() }
      return { ok: true, code: refreshed && refreshed.ok ? 'CONFIRMED' : 'SYNC_PENDING' }
    }
    const code = (result && result.code) || 'COMMAND_RESULT_UNKNOWN'
    // ★ REVISION_UNKNOWN = adapter 在**出网之前**就拒绝了：云端从未收到这条命令。
    //   它既不是业务拒绝，也不是"结果未知"（根本没有结果可言）。旧代码把它和
    //   COMMAND_RESULT_UNKNOWN 混在一起 ⇒ 给用户弹一句"云端调用中断，正在确认中，
    //   不会重复提交"（**假话**），而自动路径永不补发 ⇒ 这条预约永远上不了云，
    //   另一台设备永远看不到它。正确处置与 sync-engine 的 REVISION_UNKNOWN 分支完全一致：
    //   补齐版本号 → 用同一个号重发 → 按正常结果收尾。
    if (code === 'REVISION_UNKNOWN') {
      if (Number(entry.attempt || 0) < MAX_SEND_ATTEMPTS && await ensureRevision(adapter)) {
        // ⚠️ 补发必须把 **patch 回读出来的那条** 递下去，不能把手里的旧 entry 递下去：
        //   重发时 attempt = 传进去那条的 attempt + 1（见 confirm 开头）。传旧对象就等于
        //   把 attempt 的推进建立在"上一次的旧快照"上，一旦哪天多挂一层链路就会原地打转。
        //   用 requeued 才是单调递增的，`attempt < MAX_SEND_ATTEMPTS` 这个上限才真的成立。
        let requeued = null
        try { requeued = pending.patch(env, datasetId, entry.bookingKey, entry.requestId, { status: 'pending' }) } catch (error) { requeued = null }
        notify()
        // 不能在这里直接再调 confirm：此刻它的 inFlight 还挂在自己身上，会被 IN_FLIGHT 挡回。
        // 排到下一个 tick，等确认链的 finally 释放航位之后再发。
        defer(() => { void confirm(requeued || entry) })
        return { ok: false, code, retryScheduled: true }
      }
      // 现在补不出去（版本号也拿不到）→ 如实标成"从没提交出去"，并**把重试预算还回去**：
      // 这不是一次真正的尝试（命令根本没出网），耗掉预算会让下一次进页面时再也补发不了。
      // 同一条规矩 sync-engine 早就写在它的 REVISION_UNKNOWN 分支里。
      try { pending.patch(env, datasetId, entry.bookingKey, entry.requestId, { status: 'unknown', neverSent: true, attempt: 0 }) } catch (error) {}
      notify()
      if (!cancelled) showModal({ title: '预约未能提交', content: '本机还没有拿到云端最新版本号，这条预约没有提交出去。它仍留在你的课表上，稍后会自动重试。', showCancel: false, confirmText: '知道了' })
      return { ok: false, code }
    }
    if (code === 'COMMAND_RESULT_UNKNOWN' || code === 'REQUEST_PROCESSING') {
      // ⚠️ neverSent 必须显式清掉：这一次命令**已经出网**，云端可能已经受理（只是响应丢了），
      // 所以 resume 里那条"从不发送 → 自动补发"的规则绝不能再碰它。
      try { pending.patch(env, datasetId, entry.bookingKey, entry.requestId, { status: 'unknown', neverSent: false }) } catch (error) {}
      notify()
      // 用户已经点了取消 → 这条预约本来就要消失，不要再弹「结果待确认」打扰他。
      if (!cancelled) showModal({ title: result&&result.reason==='CLOUD_FUNCTION_TIMEOUT'?'云端处理超时':'结果待确认', content: result&&result.reason==='CLOUD_FUNCTION_TIMEOUT'?'服务器处理超过当前时间限制，这条预约仍在核对中。请先把 coachBusinessCommand 的超时时间调为 60 秒，再点这条记录重新确认。':'云端调用中断，这条预约正在确认中，不会重复提交。稍后可在课表上点这条记录重新确认。', showCancel: false, confirmText: '知道了' })
      return { ok: false, code }
    }
    if (code === 'REVISION_CONFLICT') {
      pending.remove(env, datasetId, entry.bookingKey, entry.requestId)
      await adapter.readActive().catch(() => ({ ok: false }))
      notify()
      if (!cancelled) showModal({ title: '数据已变化', content: '云端数据已被其他操作更新，这条预约没有生效，请查看最新课表后重新确认。', showCancel: false, confirmText: '知道了' })
      return { ok: false, code }
    }
    // create 明确没成功 → 云端从来没有这条预约。若用户在等待期间点过取消，只需把本机痕迹清干净，
    // 既不必提示「预约未生效」，也不可能留下幽灵预约。
    if (cancelled) return await dropLocalOnly(cancelled)
    pending.remove(env, datasetId, entry.bookingKey, entry.requestId)
    notify()
    const neverSent = /^ACTIVE_READ_/.test(code) || code === 'OFFLINE_CACHE_MISSING' || code === 'OFFLINE_READ_ONLY' || code === 'DATASET_HEAD_NOT_FOUND'
    showModal({
      title: neverSent ? '预约未提交' : '预约未生效',
      content: neverSent ? '云端数据本次未能确认，这条预约没有提交，请稍后重新约课。' : ((result && result.message) || code),
      showCancel: false, confirmText: '知道了'
    })
    return { ok: false, code }
  }

  // 冷启动 / 回到页面：self-heal。绝不在未查 receipt 的情况下重发已发出的命令。
  async function resume() {
    const blocked = silentGuard(); if (blocked) return { ...blocked, skipped: true }
    const env = environment(), datasetId = activeDatasetId()
    if (!datasetId) return { ok: false, code: 'CLOUD_DATASET_UNKNOWN', skipped: true }
    const list = pending.list(env, datasetId)
    const cancels = canCancel ? cancellation.list(env, datasetId) : []
    const completions = completionRows()
    if (!list.length && !cancels.length && !completions.length) return { ok: true, checked: 0 }
    const snapshot = readSnapshot()
    const bookings = snapshot && Array.isArray(snapshot.bookings) ? snapshot.bookings : []
    let checked = 0
    for (const entry of list) {
      if (inFlight.has(entry.bookingKey)) continue
      // 用户在 create 尚未落定期间就点了取消 → 交给下面的取消循环处理，
      // 这里绝不能补发 createBooking，否则会凭空造出一条已经被取消掉的预约。
      if (canCancel && cancellation.get(env, datasetId, entry.bookingKey)) continue
      // 云端已有这条预约（例如上次刷新成功但本机还没清理）：先绑好正式身份，再清掉本机标记，不留残影。
      const matched = bookings.find(booking => pending.matches(entry.payload, booking))
      if (matched) { bindOfficial(entry, matched.id); pending.remove(env, datasetId, entry.bookingKey, entry.requestId); checked++; continue }
      if (entry.status === 'pending') { checked++; await confirm(entry); continue }
      if (entry.status === 'syncing') {
        checked++
        const refreshed = await adapter.readActive().catch(() => ({ ok: false }))
        if (refreshed && refreshed.ok) pending.remove(env, datasetId, entry.bookingKey, entry.requestId)
        continue
      }
      checked++
      const receipt = await adapter.getReceipt(entry.requestId)
      if (receipt && receipt.ok && receipt.found && receipt.status === 'succeeded') {
        const refreshed = await adapter.readActive().catch(() => ({ ok: false }))
        if (refreshed && refreshed.ok) pending.remove(env, datasetId, entry.bookingKey, entry.requestId)
        else try { pending.patch(env, datasetId, entry.bookingKey, entry.requestId, { status: 'syncing' }) } catch (error) {}
      } else if (receipt && receipt.ok && receipt.found && receipt.status === 'failed') {
        pending.remove(env, datasetId, entry.bookingKey, entry.requestId)
        showModal({ title: '预约未生效', content: '这条预约在云端未成功，已从课表移除。', showCancel: false, confirmText: '知道了' })
      } else if (receipt && receipt.ok && !receipt.found && entry.neverSent === true) {
        // ★ 「回执明确说云端没有这条 requestId」**并且本机有证据这条命令从未出网**
        //   （只有 adapter 在 callCloud 之前就拒绝的 REVISION_UNKNOWN 才会打上 neverSent）——
        //   两个条件同时成立时，补发才不违反既有策略「transport 结果未知绝不盲目重发」：
        //   transport 未知（丢失的响应）那条路必须在 resume 里继续只查回执，由用户决定是否重试
        //   （回归：tests/booking-optimistic-response.test.js 场景⑥）。
        //   这里补发的是**一次从未送达的投递**，号不变 ⇒ 服务端仍认作同一次请求。
        if (Number(entry.attempt || 0) < MAX_SEND_ATTEMPTS) {
          try { pending.patch(env, datasetId, entry.bookingKey, entry.requestId, { status: 'pending' }) } catch (error) {}
          notify()
          await confirm(entry)
          continue
        }
        try { pending.patch(env, datasetId, entry.bookingKey, entry.requestId, { status: 'unknown' }) } catch (error) {}
      } else {
        try { pending.patch(env, datasetId, entry.bookingKey, entry.requestId, { status: 'unknown' }) } catch (error) {}
      }
    }
    // 取消的 self-heal：tombstone 必须一直有效，直到「云端确认取消」或「确认云端从来没有过」为止。
    // 绝不允许因为重启就把一条已经取消的预约又渲染回来（幽灵），也绝不盲目重发取消。
    for (const record of cancels) {
      if (cancelInFlight.has(record.localKey)) continue
      if (record.status === 'syncing') {
        checked++
        const refreshed = await adapter.readActive().catch(() => ({ ok: false }))
        if (refreshed && refreshed.ok) await finishCancel(record)
        continue
      }
      if (record.status === 'unknown') {
        checked++
        const receipt = await adapter.getReceipt(record.requestId).catch(() => ({ ok: false }))
        // 云端已确认取消 → 先重新同步再清 tombstone（顺序反了会让 stale cache 把块复活）。
        if (receipt && receipt.ok && receipt.found && receipt.status === 'succeeded') { await confirmCancelled(record); continue }
        if (receipt && receipt.ok && receipt.found && receipt.status === 'failed') { cancellation.remove(env, datasetId, record.localKey, record.requestId); notify(); continue }
        // ★ 云端**明确**没有这条 requestId（收据与业务写同事务 ⇒ 权威结论）+ 本机确实发过
        //   ⇒ 这不是「结果未知」，是「从未受理」。交给 runCancel 用**同一个号**补发。
        //   这正是"网络抖动之后 tombstone 留在本机、取消命令却再也没上云"的那个窗口 ——
        //   修前它在这里被判成"等"，而自动路径永不重发，于是那条取消永远不上云。
        //   号不变 ⇒ 云端仍认作同一次请求；查不到回执（网络问题）仍然只等，绝不盲目重发。
        if (receipt && receipt.ok && !receipt.found && record.sent === true) { await runCancel(record.localKey); continue }
        continue
      }
      // waiting / cancelling：继续推进（runCancel 自己会先查 receipt，再按 create 的结果决定）。
      checked++
      await runCancel(record.localKey)
    }
    // 完课意图的 self-heal 放在最后：它只碰本机标记，绝不参与预约 / 取消的排序。
    const healedCompletions = await healCompletions()
    notify()
    return { ok: true, checked: checked + healedCompletions }
  }

  // 用户手动「重新确认」：先查 receipt，只有确认云端从未受理时才用同一个 requestId 重发（幂等，不产生重复预约）。
  async function retry(bookingKeyValue) {
    const blocked = guard(); if (blocked) return blocked
    const env = environment(), datasetId = activeDatasetId()
    const entry = pending.get(env, datasetId, bookingKeyValue)
    if (!entry) { notify(); return { ok: false, code: 'PENDING_NOT_FOUND' } }
    if (inFlight.has(entry.bookingKey)) return { ok: true, code: 'IN_FLIGHT' }
    const receipt = await adapter.getReceipt(entry.requestId)
    if (receipt && receipt.ok && receipt.found && receipt.status === 'succeeded') {
      const refreshed = await adapter.readActive().catch(() => ({ ok: false }))
      if (refreshed && refreshed.ok) { finish(env, datasetId, entry, '该预约已确认成功'); return { ok: true, code: 'CONFIRMED' } }
      try { pending.patch(env, datasetId, entry.bookingKey, entry.requestId, { status: 'syncing' }) } catch (error) {}
      notify()
      return { ok: true, code: 'SYNC_PENDING' }
    }
    if (receipt && receipt.ok && receipt.found && receipt.status === 'failed') {
      pending.remove(env, datasetId, entry.bookingKey, entry.requestId)
      notify()
      showModal({ title: '预约未生效', content: '云端已确认这条预约没有成功，已从课表移除。', showCancel: false, confirmText: '知道了' })
      return { ok: false, code: 'COMMAND_FAILED' }
    }
    if (receipt && receipt.ok && receipt.found && receipt.status === 'processing') {
      try { pending.patch(env, datasetId, entry.bookingKey, entry.requestId, { status: 'unknown' }) } catch (error) {}
      notify()
      showToast({ title: '云端仍在处理，请稍后再看', icon: 'none' })
      return { ok: false, code: 'REQUEST_PROCESSING' }
    }
    if (receipt && receipt.ok && !receipt.found) {
      try { pending.patch(env, datasetId, entry.bookingKey, entry.requestId, { status: 'pending' }) } catch (error) {}
      notify()
      await confirm(entry)
      return { ok: true, code: 'RESUBMITTED' }
    }
    showToast({ title: '网络异常，请稍后再试', icon: 'none' })
    return { ok: false, code: 'RECEIPT_RESULT_UNKNOWN' }
  }

  // ============================ 完课意图的 self-heal ============================
  // 「用户已经点过下课」是一份只写在本机的意图（pendingCompletion），它同时决定课表与课程页的呈现。
  // 它必须一直有效，直到云端给出**明确**结果为止 —— 否则用户会看到一门已经完成的课突然变回待完成。
  // 与取消完全同一套规矩：自动路径**只查 receipt / 只重新同步，绝不重发完课命令**；
  // 并且只有在「回执确认成功 + 正式快照确实已经是 done」时才撤下意图，任何中间帧都不会让视觉跳回「待上」。
  function completionRows() {
    if (!canHealCompletion) return []
    try { return completion.list(environment(), activeDatasetId()) } catch (error) { return [] }
  }
  function snapshotShowsDone(officialId) {
    if (!officialId) return false
    const snapshot = readSnapshot()
    const list = snapshot && Array.isArray(snapshot.bookings) ? snapshot.bookings : []
    const hit = list.find(booking => booking.id === officialId)
    return !!(hit && hit.status === 'done')
  }
  async function healCompletions() {
    const rows = completionRows()
    if (!rows.length) return 0
    const env = environment(), datasetId = activeDatasetId()
    let healed = 0
    for (const entry of rows) {
      if (require('./production-recovery-guard').blocksEntry({ environment: env, datasetId }, { payload: { bookingId: entry.officialId || entry.localKey } })) continue
      // status=completing 表示「发起它的那次后台链还在这个进程里跑」→ 由它自己收尾，这里绝不插手。
      // 只有明显过期的 completing（杀进程留下的在途记录）才交给下面的回执规则处理。
      if (entry.status === 'completing' && now() - Number(entry.startedAt || 0) < 30000) continue
      let receipt = null
      try { receipt = await adapter.getReceipt(entry.requestId) } catch (error) { receipt = null }
      if (receipt && receipt.ok && receipt.found && receipt.status === 'failed') {
        // 明确失败 → 撤回本机意图并如实告知：这门课仍是待完成，用户可以回到课程重新下课。
        try { completion.remove(env, datasetId, entry.localKey, entry.requestId) } catch (error) {}
        healed++
        showModal({ title: '课程未完成', content: '云端确认本次完课没有成功，这门课仍是待完成。你录的训练内容保留在本机，可回到课程重新下课。', showCancel: false, confirmText: '知道了' })
        continue
      }
      // 回执查不到 / 网络异常 / 云端仍在处理：无法判定 —— 保持「已完成」的呈现，继续等，绝不重发。
      if (!receipt || !receipt.ok || !receipt.found || receipt.status === 'processing') continue
      if (receipt.status !== 'succeeded') continue
      const refreshed = await adapter.readActive().catch(() => ({ ok: false }))
      if (!refreshed || !refreshed.ok) continue          // 还没同步好 → 继续靠本机意图维持呈现
      if (!snapshotShowsDone(entry.officialId)) continue // 正式快照没跟上就绝不撤标记（否则视觉会跳回「待上」）
      try { completion.remove(env, datasetId, entry.localKey, entry.requestId) } catch (error) {}
      healed++
    }
    return healed
  }

  // ============================ 取消预约（同样 local-first） ============================
  // 前台：写一条 tombstone → 立刻通知视图（块当场消失）→ 后台落实。正式 cache 一个字都不改。
  async function cancel(input) {
    const blocked = guard(); if (blocked) return blocked
    if (!canCancel) return { ok: false, code: 'CANCELLATION_UNAVAILABLE' }
    const env = environment(), datasetId = activeDatasetId()
    if (!datasetId) { showToast({ title: '云端数据尚未就绪，请稍后重试', icon: 'none' }); return { ok: false, code: 'CLOUD_DATASET_UNKNOWN' } }
    const payload = pending.normalize(input && input.booking ? input.booking : input)
    const localKey = (input && (input.localKey || input.pendingKey)) || pending.bookingKey(payload)
    if (!localKey) return { ok: false, code: 'CANCEL_KEY_UNKNOWN' }
    const officialId = (input && input.officialId) || ''
    let begun
    try { begun = cancellation.begin(env, datasetId, localKey, officialId, () => newRequestId(), payload, now()) }
    catch (error) {
      onTiming({ action: 'optimisticCancel', phase: 'pending-write-failed', message: String(error && error.message) })
      showToast({ title: '本机暂存失败，请重试', icon: 'none' })
      return { ok: false, code: 'CANCEL_WRITE_FAILED' }
    }
    // 第一帧：块立刻消失（视图层隐藏），这就是「取消秒回」的全部来源。
    notify()
    onTiming({ action: 'optimisticCancel', phase: 'pending-visible', id: localKey, requestId: begun.entry.requestId, cloudCalls: 0 })
    if (!begun.created) {
      // 连点取消：复用同一个 requestId，绝不重开一轮。
      showToast({ title: '正在取消，请稍候', icon: 'none' })
      return { ok: true, duplicate: true, localKey, requestId: begun.entry.requestId }
    }
    showToast({ title: '已取消预约', icon: 'none' })
    defer(() => { void runCancel(localKey) })
    return { ok: true, deferred: true, localKey, requestId: begun.entry.requestId }
  }

  function markCancel(record, changes) {
    try { return cancellation.patch(record.environment, record.datasetId, record.localKey, record.requestId, changes) || record }
    catch (error) { return record }
  }

  // 云端已经确认取消 → 把这条预约相关的本机痕迹一次清干净（tombstone / 待确认 create / 绑定 / 训练草稿）。
  // 训练草稿必须清：否则日后可能被 flush 成一条指向已取消课程的孤儿 Cloud 内容。
  async function finishCancel(record) {
    const env = record.environment, datasetId = record.datasetId, localKey = record.localKey
    const create = pending.get(env, datasetId, localKey)
    if (create) pending.remove(env, datasetId, localKey, create.requestId)
    if (typeof pending.unbind === 'function') { try { pending.unbind(env, datasetId, localKey) } catch (error) {} }
    cancellation.remove(env, datasetId, localKey, record.requestId)
    try { onCancelled(localKey, record.officialId) } catch (error) {}
    notify()
    return { ok: true, code: 'CANCELLED' }
  }

  // —— 「云端从来没有过」这条结论的**伴随条件** ——
  // `resolveCancelTarget` 判出 `none` 的依据是「读回成功 + 快照里找不到这条」。这句话只有在
  // **本机没有一条正在前往云端的 create** 时才是永久的：否则我们刚撤掉 tombstone、告诉用户
  // "这条预约已经不存在了"，队列随后照样会把那条 createBooking 送上去 —— 另一台设备看到一条
  // 幽灵预约，本机也会因为 tombstone 已经清掉而把它画回来。这正是「约 A → 秒取消 A」最坏的结局。
  //
  // 所以撤 tombstone 之前必须把这条 create 的下落问清楚，三种情形分开处理：
  //   ① 队列里没有它      → none 成立（原来的路径，零云调用）
  //   ② 有，且**从未出网** → 连同队列条目一起撤掉（零云调用）⇒ none 才是永久的
  //   ③ 有，且可能已经出网 → **不许下 none 结论**：保持「尚未落定」，等它有了结论再收尾
  //
  // 「从未出网」的判据与 sync-engine / 采集页同口径：状态还是 pending、重试次数还没被消耗过
  // （引擎在**发送前**就把 attempts +1，被 adapter 在出网前拒的 REVISION_UNKNOWN 会还回去）。
  // 任何一条不满足就按"可能已经出网"处理 —— 宁可多等一轮，也不许凭空造出双预约。
  function queuedCreates(record) {
    try {
      const outbox = require('./local-outbox')
      const keys = []
      if (record.localKey) keys.push(String(record.localKey))
      try { const derived = String(pending.bookingKey(record.payload) || ''); if (derived && keys.indexOf(derived) < 0) keys.push(derived) } catch (error) {}
      if (!keys.length) return []
      return outbox.list({ environment: record.environment, datasetId: record.datasetId })
        .filter(entry => entry && entry.command === 'createBooking')
        .filter(entry => {
          let key = ''
          try { key = String(pending.bookingKey(entry.payload) || '') } catch (error) {}
          return !!key && keys.indexOf(key) >= 0
        })
    } catch (error) { return [] }
  }
  const neverDelivered = entry => String(entry.status || '') === 'pending' && Number(entry.attempts || 0) === 0
  function dropQueuedCreates(record, entries) {
    try {
      const outbox = require('./local-outbox')
      entries.forEach(entry => { try { outbox.remove({ environment: record.environment, datasetId: record.datasetId }, entry.entryId) } catch (error) {} })
      // 队列变了 ⇒ 本机投影必须重算（否则那条 create 的意图还会留在视图层）。
      try { require('./local-projection').invalidate() } catch (error) {}
      return true
    } catch (error) { return false }
  }

  // 明确「云端从来没有这条预约」→ 纯本机清干净，一次云调用都不需要，也就不可能出现幽灵预约。
  async function dropLocalOnly(record) {
    const env = record.environment, datasetId = record.datasetId, localKey = record.localKey
    const queued = queuedCreates(record)
    if (queued.length) {
      const undelivered = queued.filter(neverDelivered)
      if (undelivered.length !== queued.length) {
        // ③ 队列里那条 create 可能已经出网 ⇒ 此刻说「云端从来没过」就是一句假话。
        //    如实保持「尚未落定」（tombstone 继续隐藏那块、时段继续不被静默当成空档），
        //    等它落定后再由 advanceCancellations 推进这条取消。
        markCancel(record, { status: 'waiting' })
        notify()
        return { ok: true, code: 'WAITING_FOR_CREATE' }
      }
      // ② 从未送达 ⇒ 连同本机意图一起撤掉，"云端从来没有过"才是一个永久成立的结论。
      dropQueuedCreates(record, undelivered)
    }
    const create = pending.get(env, datasetId, localKey)
    if (create) pending.remove(env, datasetId, localKey, create.requestId)
    if (typeof pending.unbind === 'function') { try { pending.unbind(env, datasetId, localKey) } catch (error) {} }
    cancellation.remove(env, datasetId, localKey, record.requestId)
    try { onCancelled(localKey, record.officialId) } catch (error) {}
    notify()
    return { ok: true, code: 'NOT_ON_CLOUD' }
  }

  // 「云端已确认取消」→ 必须先重新同步 cache，再清 tombstone。
  // 顺序不能反：tombstone 是视图层隐藏块的唯一依据，一旦先清掉而 cache 仍是旧值，
  // stale cache 会立刻把这条已经被取消的预约画回来（幽灵）。同步失败就保持 syncing 继续隐藏。
  async function confirmCancelled(record) {
    const refreshed = await adapter.readActive().catch(() => ({ ok: false }))
    if (refreshed && refreshed.ok) return await finishCancel(record)
    markCancel(record, { status: 'syncing' })
    notify()
    return { ok: true, code: 'SYNC_PENDING' }
  }

  function findInSnapshot(localKey, payload) {
    const snapshot = readSnapshot()
    const list = snapshot && Array.isArray(snapshot.bookings) ? snapshot.bookings : []
    const hit = list.find(booking => (payload && pending.matches(payload, booking)) || pending.bookingKey(booking) === localKey)
    return hit && hit.id ? hit.id : ''
  }

  // 「本机临时 id」绝不能当正式 id 用：正式 id 一律由服务端生成，loc_ 前缀只在本机有效。
  // 拿它去云端必然 BOOKING_NOT_FOUND —— 白跑一次云写（还留一条失败归档）；
  // 而这条记录本该走「确认云端从来没有过 ⇒ 纯本机清干净」那条路（dropLocalOnly，零云调用）。
  function usableOfficialId(value) {
    const id = String(value == null ? '' : value)
    return id && id.indexOf('loc_') !== 0 ? id : ''
  }

  // —— 正式 id 的**本机**来源：Outbox 的 idMap（零云调用）——
  //
  // 真机实测（2026-09-23 23:23，`coachWriteTimings`）：`约 A → 立刻取消 A` 时
  //   ① `pending-booking-request` 那张表在生产里**根本不会被写入**（唯一写入方 submit() 在 pages/ 零调用点）
  //      ⇒ `officialIdFor()` 永远返回空；
  //   ② 于是旧代码退到「先做一次完整云端回读」，实测 **9664ms**；
  //   ③ 而同段的新预约 B 走 Outbox，4.7 秒就出网了 ⇒ **B 先到、A 的取消后到**，
  //      云端如实回 BOOKING_TIME_CONFLICT。用户看到的「该时段已有课程」正是这个顺序。
  //
  // 可 A 的正式 id **本机其实早就有了**：createBooking 入队时 `localTransaction` 生成了本机临时
  //   bookingId（`entry.localIds.booking`），云端落库那一刻 sync-engine 用 `recordIdMap`
  //   把它换成正式 id —— 这份对应关系就在 Outbox 的 `idMap` 里，读它一次云调用都不需要。
  //
  // ⇒ 正式 id 的取值顺序（越靠前越可信、越便宜）：
  //     tombstone 自带的 officialId → 绑定表 → **Outbox idMap** → 本机 cache 快照 →（最后手段）云端回读。
  function officialIdFromOutbox(localKey, payload) {
    try {
      const outbox = require('./local-outbox')
      const scope = { environment: environment(), datasetId: activeDatasetId() }
      const map = outbox.idMap(scope) || {}
      if (!Object.keys(map).length) return ''
      let derivedKey = ''
      try { derivedKey = String(pending.bookingKey(payload) || '') } catch (error) {}
      const wanted = []
      ;[String(localKey || ''), derivedKey].forEach(key => { if (key && wanted.indexOf(key) < 0) wanted.push(key) })
      const officialOf = localId => usableOfficialId((localId && map[localId]) || '')
      // ① 持久索引（入队时写下，条目出队之后仍然在 —— 覆盖最常见也最容易漏的那一档）
      if (typeof outbox.bookingKeyLocalId === 'function') {
        for (const key of wanted) {
          const official = officialOf(outbox.bookingKeyLocalId(scope, key))
          if (official) return official
        }
      }
      // ② 队列里还在的那一条（索引缺失时的兜底，与 queuedCreates / 投影同一套业务键口径）
      const entries = outbox.list(scope).filter(entry => entry && entry.command === 'createBooking')
      for (const entry of entries) {
        let key = ''
        try { key = String(pending.bookingKey(entry.payload) || '') } catch (error) {}
        const same = (key && wanted.indexOf(key) >= 0) || (payload && pending.matches(payload, entry.payload))
        if (!same) continue
        const official = officialOf(entry.localIds && entry.localIds.booking)
        if (official) return official
      }
      return ''
    } catch (error) { return '' }
  }

  // 「暂时拿不到正式 id」时的兜底上限：先用**本机零成本**来源重试这么多次，
  // 都拿不到才允许动用唯一那一次完整回读（见 resolveCancelTarget 末尾）。
  const CANCEL_TARGET_PROBES = 2

  // 解析「这条预约在云端到底存不存在、正式 id 是什么」。
  // 三态：{ officialId } 可以取消 / { none: true } 云端从来没有 / { waiting: true } 结果还没落定。
  // 关键规矩：取消一条 create 还没转正的预约时，**绝不抢先发 cancelBooking**（那时根本没有正式 id），
  // 只问 create 的结果；create 成功才发取消，create 失败就本地清干净 —— 这样不会有「本地取消了但云端后来冒出来」。
  async function resolveCancelTarget(record) {
    const env = record.environment, datasetId = record.datasetId, localKey = record.localKey
    // ★ 本机零成本来源：绑定表 + Outbox 的 idMap。真机上「刚约完就取消」时 A 的正式 id
    //   只可能在这里（pending 那张表生产里不被写入），而**读它不需要任何云调用**。
    //   ⚠️ 绝不能把「先做一次完整回读」当成取正式 id 的默认手段 —— 那一次实测 9.6 秒，
    //      就是"B 抢在 A 的取消之前出网"的全部原因（§80 真机时间轴）。
    const localSources = () => usableOfficialId(record.officialId) || officialIdFor(localKey) || officialIdFromOutbox(localKey, record.payload)
    const create = pending.get(env, datasetId, localKey)
    if (create) {
      // create 命令从未发出 → 服务端一定没有这条（receipt 与业务写在同一事务里，receipt 不存在 ⇒ 没落库）。
      if (create.status === 'pending') return { none: true }
      if (create.status === 'confirming' || create.status === 'unknown') {
        const receipt = await adapter.getReceipt(create.requestId).catch(() => ({ ok: false }))
        if (!receipt || !receipt.ok || !receipt.found) return { waiting: true }
        if (receipt.status === 'processing') return { waiting: true }
        if (receipt.status === 'failed') return { none: true }
        // create 已在云端成功：正式 bookingId 由 requestId 确定性生成，回执里就能拿到。
        const inner = receipt.response && receipt.response.result
        // 拿不到就**等**（create 已落库 ⇒ 它的正式 id 一定会出现在本机 idMap / 下一次回读里），
        // 绝不为了一个 id 先付一次完整回读 —— 那是把「慢」当成「取不到」。
        const officialId = (inner && inner.bookingId) || localSources() || findInSnapshot(localKey, record.payload)
        if (!officialId) return { waiting: true }
        bindOfficial(create, officialId)
        return { officialId }
      }
      // syncing：命令已成功、只是上次回读没完成 → 正式 id 一定有（在本机 idMap 或快照里）。
      const officialId = localSources() || findInSnapshot(localKey, record.payload)
      return officialId ? { officialId } : { waiting: true }
    }
    // 没有 create 记录：这是正式库里已有的预约（或 create 已经收尾）。
    const officialId = localSources()
    if (officialId) return { officialId }
    const byBusiness = findInSnapshot(localKey, record.payload)
    if (byBusiness) return { officialId: byBusiness }
    // ★ 队列里还有一条**可能已经出网**的 create ⇒ 云端随时会多出这条预约。
    //   此刻说「云端从来没有过」就是一句假话：撤掉 tombstone 之后那条 create 照旧落库，
    //   而本机已经不再隐藏它 ⇒ 另一台设备看到幽灵预约，本机也把它画回来。
    //   （`dropLocalOnly` 只对"从未出网"的那一条开口子：连它一起撤掉，结论才永久成立。）
    const queued = queuedCreates(record)
    // 只有"它从未出网"才允许直接判 none（伴随条件：撤 tombstone 时连这条 create 一起撤掉）。
    if (queued.length && queued.every(neverDelivered)) return { none: true }
    // ⚠️ 队列里还有一条**已经出网**的 create 时，也必须**有限重试**而不是无限等（1.1.9 第 12 轮）：
    //   它要等一次成功完整回读才会离开队列，而那条读取可能几十秒都不来 —— 无限等下去这条取消
    //   就永远发不出去，同一时段的 B 也就永远被排序门挡着。
    //   有限重试用尽 ⇒ 与下面同一条路：动用唯一那一次完整回读把正式 id 拿到手。
    // 队列里没有、快照里也没有 ⇒ 先用**零成本**来源重试若干次（create 可能刚落定、本机还没记账），
    // 都用完了才允许动用唯一那一次完整回读。回读成功仍找不到 ⇒ 那才是可证明的「云端从来没有过」。
    const probe = Number(record.probe || 0)
    if (queued.length || probe < CANCEL_TARGET_PROBES) { markCancel(record, { probe: probe + 1 }); return { waiting: true } }
    const refreshed = await adapter.readActive().catch(() => ({ ok: false }))
    if (refreshed && refreshed.ok) {
      const after = localSources() || findInSnapshot(localKey, record.payload)
      if (after) return { officialId: after }
      return { none: true }
    }
    return { waiting: true }
  }

  async function settleCancel(record, result) {
    const env = record.environment, datasetId = record.datasetId, localKey = record.localKey
    if (result && result.ok) {
      if (result.refreshed && result.refreshed.ok) return await finishCancel(record)
      // ★ 1.1.9 第 6 轮：取消已在云端成功，且被那一跳只读校验确认处于本命令提交后的 revision
      //   → **不再补一次完整回读**（修前那一次要 8–10 秒，而且取消比新增还多欠一次查回执）。
      //   ⚠️ tombstone 必须继续留着：它才是「块隐藏」的唯一依据。现在清掉而 cache 还是旧值，
      //      stale cache 会立刻把这条已经被取消的预约画回来（幽灵）——那是比"慢"严重得多的错。
      //      收尾交给既有 self-heal：resume() 里 syncing 那一路（成功完整回读之后才撤 tombstone）。
      if (result.confirmed && result.confirmed.ok) {
        markCancel(record, { status: 'syncing' })
        notify()
        return { ok: true, code: 'CONFIRMED_PENDING_CACHE' }
      }
      // 命令已在云端成功、只是回读刷新失败：保留 tombstone（块继续隐藏），只重新同步，绝不重发取消。
      const syncing = markCancel(record, { status: 'syncing' })
      notify()
      const refreshed = await adapter.readActive().catch(() => ({ ok: false }))
      if (refreshed && refreshed.ok) return await finishCancel(syncing)
      showToast({ title: '已取消，正在同步', icon: 'none' })
      return { ok: true, code: 'SYNC_PENDING' }
    }
    const code = (result && result.code) || 'COMMAND_RESULT_UNKNOWN'
    if (code === 'REVISION_UNKNOWN') {
      // adapter 在出网前拒绝：本次没有发送，保留原号等待补齐版本。
      markCancel(record,{status:'waiting'})
      notify()
      return {ok:false,code}
    }
    if (code === 'COMMAND_RESULT_UNKNOWN' || code === 'REQUEST_PROCESSING') {
      markCancel(record, { status: 'unknown' })
      notify()
      showToast({ title: '取消已记录，稍后自动核对', icon: 'none' })
      return { ok: false, code }
    }
    if (code === 'REVISION_CONFLICT') {
      await adapter.readActive().catch(() => ({ ok: false }))
      cancellation.remove(env, datasetId, localKey, record.requestId)
      notify()
      showModal({ title: '数据已变化', content: '云端数据已被其他操作更新，这次取消没有生效，请查看最新课表后重试。', showCancel: false, confirmText: '知道了' })
      return { ok: false, code }
    }
    // 明确失败 → 撤回 tombstone，块原样回来并说明原因（不动训练草稿，用户的内容还在）。
    cancellation.remove(env, datasetId, localKey, record.requestId)
    notify()
    showModal({ title: '取消未生效', content: (result && result.message) || code, showCancel: false, confirmText: '知道了' })
    return { ok: false, code }
  }

  // 后台：把一次取消落到实处。可重复进入（幂等）—— 每次都先查 receipt、再解析 create 结果。
  // allowResend 只有「用户主动重试」才为 true。自动路径（resume / 定时自愈）永远只查 receipt：
  //   receipt 不存在 ⇒ 云端从未受理（receipt 与业务写在同一事务里），但这一步判断**只交给用户明确
  //   要求重试时才执行**，自动路径绝不替用户做这个决定 —— 这就是「timeout/unknown 绝不盲目重发」。
  async function runCancel(localKey, options = {}) {
    const allowResend = options.allowResend === true
    if (!canCancel) return { ok: false, code: 'CANCELLATION_UNAVAILABLE' }
    if (cancelInFlight.has(localKey)) return { ok: false, code: 'IN_FLIGHT' }
    const env = environment(), datasetId = activeDatasetId()
    if (!datasetId) return { ok: false, code: 'CLOUD_DATASET_UNKNOWN' }
    let record = cancellation.get(env, datasetId, localKey)
    if (!record) return { ok: true, code: 'NOT_FOUND' }
    if (record.environment !== env || record.datasetId !== datasetId) return { ok: false, code: 'ENVIRONMENT_CHANGED' }
    cancelInFlight.add(localKey)
    const started = now(), requestId = record.requestId
    try {
      // ① 只有「这条取消命令**真的出过网**」才值得先花一跳查回执。
      //    `sent !== true 且 status === 'waiting'` = 这条取消刚刚被写下来、**从未发送过**
      //    ⇒ 云端一定没有这条 requestId（收据与业务写在同一事务里），
      //    而首次点取消的那一瞬正是这个形状 —— 白查一次就是"取消比新增慢一跳"的全部来源。
      //    ⚠️ 判据**必须**同时看 status：`unknown / cancelling` 这些状态本身就意味着"发出过"，
      //       只看 sent 会让一条状态与标记不一致的记录（被人为改过、或旧版本写下的）绕过回执检查，
      //       那是把安全规则让位给一个字段的完整性 —— 宁可多查一跳。
      //    ⚠️ 这一步只省掉"确定查不到"的那一跳，**绝不**降低任何安全规则：
      //       出网过的取消照旧先查回执，绝不盲目重发（下面 ② 的既有规则一个字没动）。
      const neverSent = record.sent !== true && String(record.status || '') === 'waiting'
      let receipt = { ok: true, found: false }
      if (!neverSent) {
        receipt = await adapter.getReceipt(requestId).catch(() => ({ ok: false }))
        if (!receipt || !receipt.ok) return { ok: false, code: 'RECEIPT_RESULT_UNKNOWN' }
        if (receipt.found && receipt.status === 'succeeded') return await confirmCancelled(record)
        if (receipt.found && receipt.status === 'processing') { markCancel(record, { status: 'unknown' }); notify(); return { ok: false, code: 'REQUEST_PROCESSING' } }
        if (receipt.found && receipt.status === 'failed') {
          // 上一次取消确实失败了（不是未知）→ 撤回 tombstone，让块回来。
          cancellation.remove(env, datasetId, localKey, requestId)
          notify()
          return { ok: false, code: 'COMMAND_FAILED' }
        }
      }
      // ② 命令发出过、而云端**明确**没有这条 requestId：这不是"结果未知"，是"从未受理"。
      //    receipt 与业务写在同一个事务里 ⇒ `found === false` 是权威结论（本项目收据无清理逻辑）；
      //    再加上"本机确实发过"（sent）与"还有重试预算"，就可以用**同一个号**补发 ——
      //    号不变 ⇒ 服务端仍把它认作同一次请求，绝不可能在云端变成两条取消。
      //    修前这里一律只等：一旦第一次发送的响应丢了，这条取消就**永远上不了云**，
      //    而 tombstone 一直留在本机（用户看到"取消了"，另一台设备永远看得到）。
      const neverReached = record.sent === true && receipt.ok === true && receipt.found === false
      if ((record.status === 'unknown' || record.status === 'cancelling') && !allowResend) {
        if (!neverReached || Number(record.attempt || 0) >= MAX_SEND_ATTEMPTS) {
          markCancel(record, { status: 'unknown' })
          notify()
          return { ok: false, code: 'RECEIPT_RESULT_UNKNOWN' }
        }
      }
      // ③ 解析这条预约在云端的真实状态（必要时先等 create 落定）。
      const target = await resolveCancelTarget(record)
      if (target.none) return await dropLocalOnly(record)
      if (target.waiting) { markCancel(record, { status: 'waiting' }); notify(); return { ok: true, code: 'WAITING_FOR_CREATE' } }
      if(typeof adapter.getState==='function'&&!Number.isInteger(adapter.getState().revision)){
        const active=await adapter.readActive().catch(()=>({ok:false}))
        if(!active||!active.ok||!Number.isInteger(adapter.getState().revision)){
          markCancel(record,{status:'waiting'});notify();return {ok:false,code:'REVISION_UNKNOWN'}
        }
      }
      record = markCancel(record, { officialId: target.officialId, status: 'cancelling', sent: true, attempt: Number(record.attempt || 0) + 1 })
      notify()
      // ④ 正式取消：固定 requestId + 云端单事务（取消 booking / 需要时返还课时均由原逻辑决定）。
      const result = await adapter.execute('cancelBooking', { bookingId: target.officialId }, { requestId })
      return await settleCancel(record, result)
    } catch (error) {
      return await settleCancel(record, { ok: false, code: 'COMMAND_RESULT_UNKNOWN' })
    } finally {
      cancelInFlight.delete(localKey)
      onTiming({ action: 'optimisticCancel', phase: 'background-cancel', id: localKey, requestId, totalMs: now() - started })
      // ★ 这条取消的**任何一种结局**都要叫醒一次同步引擎：落云（syncing）会让同一时段的新预约
      //   立刻可以发；被撤回（tombstone 消失）也一样。不叫这一下，那条"等取消先落云"的
      //   createBooking 就要干等到下一次真实操作才轮得到（见 sync-engine 的 heldByCancel）。
      //   只此一次，不新增任何轮询。
      try { require('./sync-engine').schedule() } catch (error) {}
    }
  }

  // 用户手动重试一次取消：先查 receipt；只有确认云端从未受理，才用同一个 requestId 补发（幂等）。
  async function retryCancel(localKey) {
    const blocked = guard(); if (blocked) return blocked
    return runCancel(localKey, { allowResend: true })
  }

  // —— 事件驱动地推进「还没落定的取消」（1.1.9 第 7 轮）——
  // 背景：`约 A → 立刻取消 A` 时 A 的 create 还在队列里，取消只能先停在 `waiting`
  //   （那时云端真的还没有 A，绝不许抢先发 cancelBooking —— 那会拿不到正式 id）。
  //   而"create 落云"这一刻**没有任何人叫醒这条取消**：页面 onShow / 下拉 / 用户重试都不会因为
  //   队列里少了一条而再跑一次 resume，于是投递顺序反过来 → B 被云端按冲突拒掉，
  //   或者 A 一直留在云端（别的设备永远看得到它）。
  // 所以：只在这一件事发生时推进一次 —— 那条 create **刚刚在云端落地**（sync-engine 调用本函数）。
  //   只碰同一时段的 `waiting` 记录（判据用共享的 overlapsMoment，与弹层冲突检测、云端 sameSlot 同口径），
  //   不为一次落地去扫全表；事件驱动、只此一次，**不新增任何轮询**。
  //   推不动（create 仍未落定）就什么也不做，等下一次真实事件。
  async function advanceCancellations(bookingLike) {
    if (!canCancel) return { ok: true, advanced: 0 }
    const env = environment(), datasetId = activeDatasetId()
    if (!datasetId) return { ok: true, advanced: 0 }
    let rows = []
    try { rows = cancellation.list(env, datasetId) } catch (error) { return { ok: true, advanced: 0 } }
    const wanted = rows.filter(row => String(row.status || '') === 'waiting').filter(row => {
      if (!bookingLike) return true
      const sameKey = row.localKey && bookingLike.localKey && String(row.localKey) === String(bookingLike.localKey)
      if (sameKey) return true
      if (typeof cancellation.overlapsMoment !== 'function') return false
      try { return cancellation.overlapsMoment(row, bookingLike) } catch (error) { return false }
    })
    let advanced = 0
    for (const row of wanted) {
      if (cancelInFlight.has(row.localKey)) continue
      await runCancel(row.localKey)
      advanced += 1
    }
    return { ok: true, advanced }
  }

  return { submit, resume, retry, records, mergeBookings, subscribe, notifyView: notify, activeDatasetId, frozen, environment, officialIdFor, awaitOfficial, isConfirming: id => inFlight.has(id), cancel, retryCancel, advanceCancellations, cancelRecords, cancelIndex }
}

module.exports = { createBookingOptimistic }
