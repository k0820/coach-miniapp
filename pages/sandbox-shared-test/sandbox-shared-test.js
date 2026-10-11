// M2 第四批：**Sandbox 真机验收入口**（2026-09-26）。
//
// ⛳⛳ 这个页面是什么、不是什么（写在最前面，防止后来的人把它当正式功能）⛳⛳
//   · 它是 **M2 验收用的临时测试页**，只在 Sandbox 里可操作；正式区打开只会看到提示。
//   · 它复用的**业务能力**只有两条正式命令（`setPackageShare` / `createSharedBooking`），
//     而且一律走统一写入口 `utils/mutate.js` —— 没有第二条写路径。
//   · 它读对端课时包只通过 **零写入的只读云函数** `diagnoseSharedUsage`。
//   · **共享码是过渡期技术桥梁，不是正式业务流程**：最终产品是会员靠微信身份认自己的课时、
//     自由选择 A/B/C 教练。M3（会员自主选择教练）上线后，本页面与共享码入口应当**下线**，
//     而不是继续扩展。所以这里不做复杂美化、不进任何正式入口。
//
// ★★ 一部手机能不能验完？（这个问题必须回答清楚）★★
//   不能只靠一个微信号。教练身份由**服务端**从 `wx.getWXContext().OPENID` 推导，
//   一个微信号 = 一位教练；`createSharedBooking` 还有 `SHARE_SELF_NOT_ALLOWED`
//   明确拒绝"自己用自己的共享码"。这不是限制，正是 M2 的核心不变量：
//   **课时只有一份、两位教练是两个人**。
//   最小安全替代（不降身份安全、不加假登录）：同一部手机上用微信「切换账号」登录**两个微信号**
//   （两个都要先加为体验成员）⇒ 两个真实 openid ⇒ 两位真实教练 ⇒ 完整 A/B 真机。
//   本页顶部会显示「当前教练数据集尾号」：两位教练这个号必须不同，一眼就能确认自己没在自约。
const runtime = require('../../utils/data-runtime')
const mutate = require('../../utils/mutate')
const { todayKey } = require('../../utils/beijing-date')
const acceptance = require('../../utils/m2-shared-acceptance')
// ⭐ 开课时间窗口：**06:00–23:00 开课、每 30 分钟一档、且当天 24:00 前结束**（教练新建与会员自助同一条规则）。
//   与云端 occupancy.js 同一把尺（本机孪生）。
const occupancy = require('../../utils/package-occupancy')

const HOURS = acceptance.HOURS.map(value => String(value))
const MINUTES = acceptance.MINUTES.map(value => String(value))
const BUSY_TEXT = '正在处理…'

function pad(value) { return String(value).padStart(2, '0') }

const installAutoRefresh = require('../../utils/auto-refresh').installPage

Page(installAutoRefresh({
  data: {
    sandbox: false, ready: false, datasetTail: '—', busy: false,
    students: [], studentIndex: 0, packageIndex: 0, packageText: '—',
    shareCode: '', shareState: '',
    code: '', lookupText: '', lookupOk: false,
    date: '', hourIndex: 3, minuteIndex: 0, planned: '60',
    hours: HOURS, minutes: MINUTES,
    counts: null, baseline: null, copyText: '',
    sharedBookings: [], peerText: '', lastRequestId: '', lastResult: '',
    // ★ 可观测出口（2026-09-27）：数据源、读取结果、选中的真实 id、本机未落定条数。
    //   三轮真机定位失败的根因之一就是「失败看不见」——U64 看不到 code，就只能靠猜。
    sourceText: '—', sourceError: '', readText: '—', readFailed: false,
    selectedIdsText: '—', pendingText: '—',
    // ★ 只读队列详情（Sandbox 诊断专用，默认收起；不进任何会员产品 UI）
    queueDetailOpen: false, queueDetailText: '—',
    // ── 课程提醒「测试时钟」（2026-10-05 需求四）──
    // ⛔ 真机验收不可能真的等 3 小时 / 1 小时 ⇒ 测试区提供"把现在往前拨"的手动入口。
    //    ⛔ 这个入口**只在测试区这个临时验收页里**，正式区页面与正式区云函数都没有。
    clockIndex: 0,
    clockOptions: ['0 分钟（真实时间）', '30 分钟', '1 小时', '2 小时', '3 小时', '5 小时'],
    clockMinutes: [0, 30, 60, 120, 180, 300],
    clockBusy: false,
    clockText: '—'
  },

  // ★ 队列详情：**只读**。只看不动 —— 不发云调用、不入队、不改任何条目。
  //   为什么必须做成"引擎的诊断函数 + 页面只负责打印"：出口判据全在引擎里，
  //   页面另写一份必然与真实判定慢慢走偏 ⇒ 那就等于拿一份假账做诊断。
  toggleQueueDetail() {
    if (this.data.queueDetailOpen) { this.setData({ queueDetailOpen: false }); return }
    let text = '读取失败'
    try {
      const envText = String(runtime.environment())
      const cache = wx.getStorageSync(runtime.cacheKey()) || {}
      const datasetId = String((cache && cache.datasetId) || '')
      const engine = require('../../utils/sync-engine')
      const rows = engine.diagnoseQueue({ environment: envText, datasetId }) || []
      text = rows.length
        ? rows.map(row => [
            `#${row.seq} ${row.command} ${row.status} 试${row.attempts}次`,
            `  rid=${row.requestId}`,
            `  key=${row.entityKey} 目标=${row.targetId || '—'} 云端有这行=${row.cloudRowFound ? '是' : '否'}`,
            `  错误=${(row.lastError && row.lastError.code) || '—'}${row.lastError && row.lastError.reason ? '/' + row.lastError.reason : ''}`,
            row.lastError && row.lastError.technicalMessage ? `  原文=${String(row.lastError.technicalMessage).slice(0, 120)}` : '',
            row.cooldown ? `  冷却=第${row.cooldown.rounds}轮 到期=${new Date(Number(row.cooldown.nextAt)).toTimeString().slice(0, 8)}` : '',
            row.probeFails ? `  查回执失败${row.probeFails}次` : '',
            `  字段=${row.payloadFields.join(',') || '—'} payload键=${row.payloadKeys.join(',')}`,
            `  出口①事实已在: ${row.exits.factVisible}`,
            `  出口②目标消失: ${row.exits.targetGone}`,
            `  出口③被接管: ${row.exits.superseded}`,
            row.blockers.length ? `  等= ${row.blockers.map(b => `#${b.seq} ${b.command} ${b.status}`).join(' / ')}（${row.blockers[0].reason}）` : '  等= 无',
            row.cloudRow ? `  云端现状=${JSON.stringify(row.cloudRow)}` : '',
            `  cache rev=${row.cacheRevision}`
          ].filter(Boolean).join('\n')).join('\n\n')
        : '队列为空'
    } catch (error) { text = '诊断不可用：' + String((error && error.message) || error).slice(0, 120) }
    this.setData({ queueDetailOpen: true, queueDetailText: text })
  },

  // ⚠️ 这里**故意不写 onShow**：installPage 的 onShow 会在没有原 onShow 时走 `run('pageShow')`，
  //    于是「进入页面」和「回前台 / 从子页返回 / 写命令成功」共用**同一道** 400ms 合并 + in-flight 防重门。
  //    若本页自己写一个 onShow 去读云端，回前台那一下（页面 onShow 与 appForeground 先后到达）
  //    就会连打两次云端 —— 这正是"一次事件读两三遍"的来源。
  onPullDownRefresh() { return this.pullRefresh() },

  // ── ★ 真正的刷新入口：先读云端，再 render 本机事实 ──
  // 2026-09-27 真机事故：本页原来的 refresh() 只读 `runtime.getDB()`
  //   （= 本机 Storage 里那份快照 + Outbox 投影），**一个网络字节都不发**。
  //   于是真机上 A 一直显示 10/1/9，而云端那一行其实已经是 11/2/9 ——
  //   页面"刷新"了、也重新渲染了，但刷的是同一份旧字节，与刷没刷新无关。
  // 修复方式**不造第二套**：复用项目统一的云端主动读取 `ui.refreshActiveView`
  //   （学员页 / 统计页 / 课表页用的就是它），它成功后会把最新 authoritative 快照
  //   写进 runtime.cacheKey() 那份 cache，之后的 getDB() 读到的才是云端此刻的值。
  async cloudRefresh(userInitiated) {
    const startedAt = Date.now()
    // ⭐ 读取结果必须被**接住**并展示：这是本项目铁律（静默必须有可观测出口）。
    //   2026-09-27：连续三轮真机定位失败，全因为这里既不接收返回值又不记日志，
    //   于是「云端根本没读」与「读到的就是这样」在界面上完全同形。
    let read = { ok: false, code: 'REFRESH_ENTRY_MISSING' }
    try {
      const ui = require('../../utils/ui-cloud-command')
      if (typeof ui.refreshActiveView === 'function') read = (await ui.refreshActiveView({ userInitiated: !!userInitiated })) || { ok: false, code: 'REFRESH_EMPTY_RESULT' }
    } catch (error) { read = { ok: false, code: (error && error.code) || 'REFRESH_THREW' } }
    this.refresh()
    if (read && read.ok) {
      const cache = wx.getStorageSync(runtime.cacheKey()) || {}
      this.setData({ readFailed: false, readText: `云端读取成功 · ${Date.now() - startedAt}ms · revision ${Number.isInteger(cache.revision) ? cache.revision : '—'}` })
    } else {
      this.setData({ readFailed: true, readText: `云端读取失败：${(read && read.code) || '未知'}（页面显示的是本机已确认的那一版，不是云端此刻）` })
    }
  },
  // 下拉刷新 = 用户着急时的手动兜底：走同一个入口，只是标记为 userInitiated（不被防重门吃掉）。
  async pullRefresh() {
    const startedAt = Date.now()
    await this.cloudRefresh(true)
    require('../../utils/auto-refresh').recordSample({ reason: 'pullDown', startedAt })
    if (wx.stopPullDownRefresh) wx.stopPullDownRefresh()
  },

  // ── 渲染本机当前事实（云端快照 + 本机投影）—— 纯读，一个字节都不写 ──
  // ⚠️ 它**不联网**。要"真正刷新"必须走上面的 cloudRefresh。
  refresh() {
    const sandbox = runtime.isSandbox()
    if (!sandbox) { this.setData({ sandbox: false, ready: false }); return }
    let db = null
    let sourceError = ''
    // ★ 数据源读取失败必须**看得见**：这里是 Sandbox 唯一的读源，落到这里说明没有权威数据可读。
    //   绝不能再退化成"默默渲染另一本账"——那正是 2026-09-27 三轮定位失败的形状。
    try { db = runtime.getDB() } catch (error) { db = null; sourceError = (error && error.code) || 'SOURCE_READ_FAILED' }
    const cache = wx.getStorageSync(runtime.cacheKey()) || {}
    // ⚠️ 刷新前先把**当前选中**记下来（必须在 setData 之前取，否则读到的是上一帧）。
    //    旧代码无条件 `packageIndex: 0`：只有一包时无害；一旦有第二个包，每次刷新都会
    //    把用户选的课时包弹回第一个 —— 真机上就是"我明明选了 B 包，刷新后显示的是 A 包"。
    const previousStudentId = (this.data.students && this.data.students[this.data.studentIndex] || {}).id
    const previousPackageId = (this.currentPackage() || {}).id
    const students = ((db && db.students) || []).map(student => ({
      id: student.id, name: student.name,
      packages: ((student.packages) || []).filter(pkg => pkg.status !== 'reversed').map(pkg => {
        const occupancy = acceptance.occupancyOf(pkg)
        return { id: pkg.id, type: pkg.type, remaining: occupancy.remaining, reserved: occupancy.reserved, availableToBook: occupancy.availableToBook, used: acceptance.usedOf(pkg) }
      })
    })).filter(student => student.packages.length)
    // ★ 完课同步状态（2026-09-28 真机）：本机投影会把**还没落云**的 completeBooking 渲染成 done，
    //   但课时 / 收入只在云端事务里产生 ⇒ 界面必须按"Outbox 里这条完课有没有落定"来区分呈现，
    //   绝不能把投影出来的 done 直接写成「已完成」（那等于替云端宣布一件它还没做的事）。
    //   只读、零云调用：只看本机队列，不新增轮询，也不新建第二套业务状态。
    const envText = String(runtime.environment())
    const datasetId = String(cache.datasetId || '')
    let completionSync = {}
    try {
      const outboxModule = require('../../utils/local-outbox')
      const scope = { environment: envText, datasetId }
      completionSync = acceptance.completionSyncRows(outboxModule.openEntries(scope) || [], outboxModule.idMap(scope) || {})
    } catch (error) { completionSync = {} }
    const sharedBookings = acceptance.sharedBookingRows(db).map(booking => ({
      id: booking.id, date: booking.date, time: acceptance.timeText(booking),
      statusText: acceptance.bookingStatusText(booking, completionSync),
      syncPending: !!completionSync[String(booking.id)],
      syncFailed: completionSync[String(booking.id)] === 'unknown',
      packageId: booking.packageUsage && booking.packageUsage.packageId
    }))
    const counts = acceptance.countsOf(db)
    const hourIndex = Math.min(this.data.hourIndex, HOURS.length - 1)
    // 按 **id** 复原选中（不是按下标）：只有"原先选中的那条已经不存在"时才安全回退。
    let studentIndex = previousStudentId ? students.findIndex(student => student.id === previousStudentId) : -1
    if (studentIndex < 0) studentIndex = Math.min(this.data.studentIndex, Math.max(0, students.length - 1))
    const chosenStudent = students[studentIndex]
    let packageIndex = chosenStudent && previousPackageId
      ? (chosenStudent.packages || []).findIndex(pkg => pkg.id === previousPackageId)
      : -1
    if (packageIndex < 0) packageIndex = 0
    let pendingCount = 0
    let queueText = '本机队列读取失败'
    try {
      const outbox = require('../../utils/local-outbox')
      const rows = outbox.openEntries({ environment: envText, datasetId }) || []
      pendingCount = rows.length
      // ★ 最小诊断（2026-09-27 真机教训）：只印一个数字时**无法判断卡在哪**，
      //   于是每一轮定位都只能靠猜。必须给出「各状态各几条」+「最老那一条为什么没走」。
      // ⚠️ 只显示**状态与错误码**这类结论，不铺开发细节；正式区页面本来就不显示这一行。
      const byStatus = {}
      rows.forEach(row => { byStatus[row.status] = (byStatus[row.status] || 0) + 1 })
      const oldest = rows[0]
      // ★ reason 必须单独印出来：同一个 COMMAND_RESULT_UNKNOWN 底下藏着**完全不同的两种故障**
      //   （云函数超时 CLOUD_FUNCTION_TIMEOUT / 调用失败 CLOUD_CALL_FAILED / 慢速重试 RETRY_COOLDOWN），
      //   只看 code 永远分不清"云端在算"还是"根本没发出去"。
      const reasonOf = row => (row.lastError && row.lastError.reason) ? '/' + String(row.lastError.reason) : ''
      // ★ 「谁卡住了谁」必须看得见（2026-09-28 真机：3 unknown + 5 pending，只给数字没法判哪些是被挡的）。
      //   延迟 require：sync-engine 反过来也会用到别的模块，顶部互相 require 有环的风险。
      let dependencyText = ''
      try {
        const engine = require('../../utils/sync-engine')
        const scope = { environment: envText, datasetId }
        const waiting = rows.filter(row => (typeof engine.dependencyBlockers === 'function' ? engine.dependencyBlockers(scope, row) : []).length)
        if (waiting.length) {
          const sample = waiting[0]
          const blockers = engine.dependencyBlockers(scope, sample)
          dependencyText = `｜受阻 ${waiting.length}（#${sample.seq} ${sample.command} 等 #${blockers[0].seq} ${blockers[0].command} ${blockers[0].status}）`
        }
      } catch (error) { dependencyText = '' }
      queueText = pendingCount === 0
        ? '本机队列已清空'
        : `未落定 ${pendingCount}（${Object.keys(byStatus).map(key => `${key} ${byStatus[key]}`).join(' · ')}）` +
          (oldest ? `｜最老：${oldest.command} ${oldest.status} 已试 ${Number(oldest.attempts || 0)} 次${oldest.lastError && oldest.lastError.code ? ' ' + String(oldest.lastError.code) + reasonOf(oldest) : ''}` : '') +
          dependencyText
    } catch (error) { pendingCount = -1 }
    const chosen = students[studentIndex]
    const pkgRow = chosen && chosen.packages[packageIndex]
    const tail = value => String(value == null || value === '' ? '—' : value).slice(-6)
    this.setData({
      sandbox: true, ready: !!db,
      datasetTail: String(cache.datasetId || '—').slice(-6),
      sourceError,
      // ★ 「我现在看的到底是哪一本账」必须写在脸上：Environment + mode + cache key + dataset + revision。
      sourceText: sourceError
        ? `数据源不可用：${sourceError}`
        : `${runtime.cacheKey()} · env=${envText} · mode=${runtime.mode()} · ds …${tail(cache.datasetId)} · rev ${Number.isInteger(cache.revision) ? cache.revision : '—'}`,
      selectedIdsText: `选中 student …${tail(chosen && chosen.id)} / package …${tail(pkgRow && pkgRow.id)}`,
      pendingText: pendingCount < 0 ? '本机队列读取失败' : queueText,
      students, studentIndex, packageIndex, counts, sharedBookings,
      date: this.data.date || todayKey()
    })
    this.setData({ packageText: this.currentPackageText() })
  },

  currentPackage() {
    const student = this.data.students[this.data.studentIndex]
    if (!student) return null
    return student.packages[this.data.packageIndex] || student.packages[0] || null
  },
  currentPackageText() {
    const pkg = this.currentPackage()
    if (!pkg) return '本账里还没有课时包'
    // ⭐ 必须把 used 一起印出来：`还能约 = max(剩余 − 已占, 0)` 是派生值，
    //    完课时「剩余 −1、已占 −1」会让它一动不动 ⇒ 只看"还能约"永远发现不了位移。
    //   2026-09-27：三轮里我们一直在比对「10/1/3 与 11/2/2 差几次完课」，最后发现压根不是同一份数据 ——
    //   **包的 id 必须印出来**，否则两条数字链永远无法被证明指向同一行。
    return `${pkg.type}(…${String(pkg.id).slice(-6)}) · 剩余 ${pkg.remaining} · 已占 ${pkg.reserved} · 还能约 ${pkg.availableToBook} · 已用 ${acceptance.usedOf(pkg)}`
  },

  onStudentChange(e) { this.setData({ studentIndex: Number(e.detail.value) || 0, packageIndex: 0, shareCode: '', shareState: '' }, () => this.setData({ packageText: this.currentPackageText() })) },
  onPackageChange(e) { this.setData({ packageIndex: Number(e.detail.value) || 0, shareCode: '', shareState: '' }, () => this.setData({ packageText: this.currentPackageText() })) },

  // ── ① A 侧：生成 / 查看共享码（只发一枚码，不复制任何余额）──
  async share(enabled) {
    if (this.data.busy) return
    const pkg = this.currentPackage()
    if (!pkg) return wx.showToast({ title: '先选一个课时包', icon: 'none' })
    if (!mutate.isCloudWritePath()) return wx.showToast({ title: '云端模式下才能共享课时包', icon: 'none' })
    const on = enabled !== false
    this.setData({ busy: true })
    wx.showLoading({ title: BUSY_TEXT, mask: true })
    const result = await mutate(null, null, {
      key: `setPackageShare:${pkg.id}:${on ? 'on' : 'off'}`,
      command: 'setPackageShare',
      payload: { packageId: pkg.id, enabled: on },
      successTitle: on ? '' : '已停止共享'
    })
    wx.hideLoading()
    this.setData({ busy: false })
    if (!result || !result.ok) {
      this.setData({ shareCode: '', shareState: '' })
      return wx.showModal({ title: on ? '共享码没有生成' : '停止共享没有成功', content: acceptance.hintOf(result && result.code), showCancel: false, confirmText: '知道了' })
    }
    const code = (result.result && result.result.shareCode) || ''
    this.setData({ shareCode: code, shareState: '' })
    if (on && code) this.lookup(code)
    this.refresh()
  },
  genCode() { return this.share(true) },
  stopShare() { return this.share(false) },
  copyCode() {
    const code = this.data.shareCode
    if (!code) return
    wx.setClipboardData({ data: code, success: () => wx.showToast({ title: '已复制共享码', icon: 'none' }) })
  },

  onCodeInput(e) { this.setData({ code: e.detail.value || '', lookupText: '', lookupOk: false }) },

  // ── ② B 侧：先看清楚这份共享课时，再排课 ──
  // 只读：零写入云函数，只回「是否有效 + 课时三个计数」，不含任何 id / 姓名 / 金额。
  async lookup(code) {
    const shareCode = acceptance.normalizeShareCode(code == null ? this.data.code : code)
    if (!acceptance.validShareCode(shareCode)) return wx.showToast({ title: '共享码格式不对', icon: 'none' })
    wx.showLoading({ title: '正在读取', mask: true })
    try {
      const result = await wx.cloud.callFunction({ name: 'diagnoseSharedUsage', data: { action: 'shareStateByCode', shareCode, environment: 'sandbox' } })
      const fact = (result && result.result) || {}
      wx.hideLoading()
      const ok = fact.ok === true && fact.active === true
      // ★ 把共享码指向的**真实 id 尾号**一并印出来，与顶部那一行逐字比对即可证明「同一份事实」。
      //   2026-09-27 的教训：只比对数字会被派生式骗过（10−1=9 与 11−2=9 看起来一样），只有 id 不会说谎。
      const target = fact.target || {}
      const ids = `码指向 student …${String(target.studentId || '—').slice(-6)} / package …${String(target.packageId || '—').slice(-6)}`
      this.setData({
        code: shareCode, lookupOk: ok,
        lookupText: ok
          ? `${acceptance.shareStateText(fact)}\n${ids}\n（这份课时仍记在原教练账上，不会复制到你这里）`
          : acceptance.hintOf(fact.code)
      })
      return fact
    } catch (error) {
      wx.hideLoading()
      this.setData({ lookupOk: false, lookupText: '读取失败，请检查网络后重试。' })
      return null
    }
  },
  lookupCode() { return this.lookup() },

  onDate(e) { this.setData({ date: e.detail.value }) },
  onHour(e) { this.setData({ hourIndex: Number(e.detail.value) || 0 }) },
  onMinute(e) { this.setData({ minuteIndex: Number(e.detail.value) || 0 }) },
  onPlanned(e) { this.setData({ planned: e.detail.value }) },

  // ── ③ B 侧：用共享码排一节课 ──
  // extraHour：验收「最后一节只能一个人约到」时**必须换一个时段**再试，
  // 否则会被"这个时段你已经有课了"挡住，看不出到底是不是超额。
  async book(extraHour) {
    if (this.data.busy) return
    const shareCode = acceptance.normalizeShareCode(this.data.code)
    if (!acceptance.validShareCode(shareCode)) return wx.showToast({ title: '先输入有效的共享码', icon: 'none' })
    if (!mutate.isCloudWritePath()) return wx.showToast({ title: '云端模式下才能用共享码排课', icon: 'none' })
    const plannedMinutes = acceptance.plannedMinutesOf(this.data.planned)
    if (plannedMinutes == null) return wx.showToast({ title: '预计时长必须是 1–1440 的整数分钟', icon: 'none' })
    const hour = Number(HOURS[this.data.hourIndex]) + (Number(extraHour) || 0)
    if (hour > 23) return wx.showToast({ title: '换个更早的时段再试超额', icon: 'none' })
    const minute = Number(MINUTES[this.data.minuteIndex])
    // ⭐ 出网前先过同一道时间闸：**开始 ≤ 23:00 且 结束 ≤ 当天 24:00**（与云端同一把尺）。
    //    30 / 60 / 90 分钟的课都不许跨午夜 ⇒ 90 分钟那档最晚只能 22:30 开课。
    //    ⚠️ 用 showModal 不用 showToast：toast 会截断长句，剩下半句等于没说。
    const gate = occupancy.lessonWindowGateOf({ hour, minute }, plannedMinutes)
    if (gate) return wx.showModal({ title: '这个时间排不了', content: gate.message, showCancel: false })
    const date = this.data.date || todayKey()
    const requestId = acceptance.newRequestId('m2dshare')
    let db = null
    try { db = runtime.getDB() } catch (error) { db = null }
    const baseline = acceptance.countsOf(db)
    this.setData({ busy: true })
    wx.showLoading({ title: BUSY_TEXT, mask: true })
    const result = await mutate(null, null, {
      key: `createSharedBooking:${shareCode}:${date}:${hour}:${minute}`,
      command: 'createSharedBooking',
      payload: { shareCode, date, hour, minute, plannedMinutes },
      requestId,
      successTitle: `已排 ${pad(hour)}:${pad(minute)}`
    })
    wx.hideLoading()
    this.setData({ busy: false, lastRequestId: requestId })
    if (!result || !result.ok) {
      this.setData({ lastResult: `未通过：${(result && result.code) || 'UNKNOWN'}` })
      return wx.showModal({
        title: '没有排上这节课', content: acceptance.hintOf(result && result.code),
        showCancel: false, confirmText: '知道了'
      })
    }
    this.setData({ lastResult: '已排课（共享预约落在你自己的账里）' })
    this.refresh()
    return this.verify()
  },
  bookOnce() { return this.book(0) },
  bookAgain() { return this.book(2) },

  // ── ④ 验收检查：读两侧事实（对端课时 / 双方版本号 / 双方回执）──
  async verify() {
    const rows = this.data.sharedBookings
    const bookingId = rows.length ? rows[rows.length - 1].id : ''
    if (!bookingId) return wx.showToast({ title: '你这边还没有共享预约', icon: 'none' })
    wx.showLoading({ title: '正在核对', mask: true })
    try {
      const result = await wx.cloud.callFunction({ name: 'diagnoseSharedUsage', data: { action: 'sharedBooking', bookingId, requestId: this.data.lastRequestId || '', environment: 'sandbox' } })
      const fact = (result && result.result) || {}
      wx.hideLoading()
      if (!fact.ok) { this.setData({ peerText: acceptance.hintOf(fact.code) }); return wx.showModal({ title: '核对失败', content: acceptance.hintOf(fact.code), showCancel: false }) }
      const self = fact.self || {}, peer = fact.peer || {}, uni = fact.uniqueness || {}
      const lines = [
        acceptance.peerText(fact),
        `我这侧版本 ${self.dataRevision} · 课时包那侧版本 ${peer.dataRevision}`,
        `我这侧回执 ${(self.receipt && self.receipt.status) || '—'} · 课时包那侧回执 ${(peer.receipt && peer.receipt.status) || '—'}`,
        `唯一性：课时包 ${uni.packageId} 处 · 学员 ${uni.studentId} 处 · 销售 ${uni.saleId} 处（都必须是 1）`
      ]
      this.setData({ peerText: lines.join('\n') })
      return fact
    } catch (error) {
      wx.hideLoading()
      this.setData({ peerText: '核对失败，请检查网络后重试。' })
      return null
    }
  },
  verifyLast() { return this.verify() },

  openBooking(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/session/session?id=${encodeURIComponent(id)}` })
  },
  // ⭐ M2 真机修复：被门禁挡住时必须给一条**能走出去**的路。
  //   原来是 navigateBack —— 若本页是直开的（编译模式 / 深层返回栈），按钮等于没用，
  //   用户就卡在"请先进入沙盒"这句话上。直接去沙盒页，那里现在还会明说本进程在哪个区。
  goSandbox() { wx.navigateTo({ url: '/pages/sandbox-control/sandbox-control' }) },

  // ── ⑤ 课程提醒：**手动**跑一次课前提醒扫描（可带测试时钟偏移）──
  // ⛔ 为什么必须手动：定时器每 5 分钟自己跑一次，但真机验收要"立刻看到这一节发没发"，
  //    等定时器等于把验收拖成玄学。手动跑 + 测试时钟 ⇒ 10 分钟内走完 A/B/C/D/E 五节课。
  // ⛔ 偏移只影响这一次调用，**不会改任何数据、不会改系统时间**；定时器下次仍按真实时间跑。
  onClockChange(e) { this.setData({ clockIndex: Number(e.detail.value) || 0 }) },
  async runReminderScan() {
    if (this.data.clockBusy) return
    const offsetMinutes = Number((this.data.clockMinutes || [])[this.data.clockIndex] || 0)
    this.setData({ clockBusy: true, clockText: '正在扫描…' })
    wx.showLoading({ title: '正在扫描', mask: true })
    try {
      // ⛔ 每一次云调用都必须显式声明 sandbox（与上面两条只读取证同一个纪律）：
      //    否则"这个调用到底打到了哪个环境"就只能靠猜。
      const result = await wx.cloud.callFunction({
        name: 'classReminderSandboxScheduler',
        data: { command: 'runOnce', offsetMinutes, environment: 'sandbox' }
      })
      wx.hideLoading()
      const fact = (result && result.result) || {}
      const sent = Number(fact.sent || 0)
      this.setData({
        clockBusy: false,
        clockText: fact.ok === false
          ? `扫描失败：${fact.code || '未知'}`
          : `扫到 ${Number(fact.scanned || 0)} 节 · 发出 ${sent} 条` +
            (offsetMinutes ? `（测试时钟 +${offsetMinutes} 分钟）` : '（真实时间）') +
            (fact.skipped ? ` · 已跳过：${fact.message || ''}` : '')
      })
    } catch (error) {
      wx.hideLoading()
      this.setData({ clockBusy: false, clockText: `扫描失败：${String((error && error.errMsg) || (error && error.message) || error).slice(0, 80)}` })
    }
  },
  noop() {}
  // 接上总线：回前台 / 从子页返回 / 写命令成功 ⇒ 都走 cloudRefresh（真读云端），
  // 400ms 合并与 in-flight 防重仍由 auto-refresh 的 installPage 负责，本页不重复实现。
}, { refresh() { return this.cloudRefresh(false) } }))
