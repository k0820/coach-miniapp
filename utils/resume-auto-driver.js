// 「安全自动续跑」的**决策核心**（2026-09-23 第 21 轮，第 23 轮加核验策略门禁）。
//
// 为什么需要它：受控补发已证明"一次点击一条命令"是可控的，但剩下 14 条要人肉点 14 次 ——
// 而连点的真正风险不是慢，是**注意力衰减**：点到第 8 条时没人会再逐条核对回执。
// 所以自动化必须做到"比人更严"，而不是"把人省掉"：
//
//   · **逐条执行**：每次 `deps.step()` 仍走 sync-engine 的 step 模式（一次调用最多一次 execute）；
//   · **每条一授权**：授权里只有当前这一条的 entryId，发完立刻清（= 发完即关闸，冻结一直在）；
//   · **每条强制核验**：回执 + 队列 + 云端 revision +（策略要求时）业务账，**缺一项算未通过**；
//   · **发前门禁**（第 23 轮新增）：策略要求业务级核验、但没有可用核验器 ⇒ **不发**。
//     不可核验的写入是不可逆的，所以"能不能核验"必须在**发送之前**判定；
//   · **一票否决**：unknown / failed / processing / 查询失败 / revision 不连续 / 业务账不符 /
//     队首与计划不符 / 号非法 / 冻结失效 / 引擎自报 execute 不是 0 或 1 —— 任一命中**立即停手**；
//   · **不自动迁移**：号非法就停手（换号必须有人看过，绝不自动换）；
//   · **不解冻**：本模块没有 release / flush（非 step）/ mutate 的路径，发送面只有 `deps.step()`。
//
// 判据唯一性（本项目最贵的一课：两份口径不同步 = 白烧一轮部署）：
//   回执五分法、FIFO 前缀检查、requestId 格式判定**全部由调用方注入**（页面与测试共用同一份）。
//   本模块只负责**编排顺序与停手条件**，不重新实现任何一条判定。
//
// 第 23 轮又补了一条同源的教训：**"无需核验"和"要求核验但没做"必须能分开**。
//   旧版的核验与否完全由实现方自觉（页面只给 completeBooking 实现），驱动分不清这两件事，
//   于是"该命令未配置业务级核验"这句话既会被当成正常、又会被渲染成红色警报 ——
//   现场读起来就像"因为没配置核验才停手"。现在：策略由 `deps.businessPolicy` 注入，
//   要求核验的必须点名已实现的核验器（否则拒发），没要求的一律记为**中性说明**而不是失败。
//
// ⚠️ 本模块**不 require** wx / Storage / sync-engine / adapter / outbox —— 纯逻辑，
//    所有副作用经 deps 注入。测试因此可以完整地造"未知 / 冲突 / 账不平 / 闸门被改坏"等场景。
const DEFAULTS = Object.freeze({
  // 单次运行最多推进多少条（安全阀；剩余 14 条，留足余量又不至于"一口气跑完没人看"）。
  maxEntries: 30,
  // 单次运行的时间上界（8 分钟）：超过就停手并如实记录，不做"偷偷接着跑"。
  maxMs: 8 * 60 * 1000,
  // 两条之间的间隔：给云端读路径一点时间，也让每一条的回读都是**新鲜**的。
  gapMs: 1200,
  // 收敛（0 execute）通过的上界：纯自愈动作，做不动就停手，不原地打转。
  maxDrainPasses: 4
})

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const txt = value => value === null || value === undefined || value === '' ? '—' : String(value)
// 引擎自报的 execute 次数。**拿不到 ≠ 0** —— 拿不到一律按"未知"处理（这是本项目反复踩过的坑：
// 把未知当 0 就等于对外宣称"这条没出网"，而它可能已经在云端落地了）。
function executedOf(result) {
  const value = result && result.executed
  return Number.isInteger(value) ? value : null
}

// ── 成功核验：**发送路径**（本步真的发了一条）──
// 每一格都是"不同意就不能过"的硬判据；任何一格不成立，调用方必须停手。
function verifySent(input) {
  const row = input || {}
  const checks = {}
  const failed = []
  const notes = []
  const failedNotes = []
  const push = (name, ok, note) => { checks[name] = ok; if (!ok) { failed.push(name); if (note) { notes.push(note); failedNotes.push(note) } } }

  push('executedOne', row.executed === 1, '引擎自报 execute=' + txt(row.executed) + '（发送路径必须恰好 1 次）')
  push('leftQueue', row.leftQueue === true, '条目仍在队列里（status=' + txt(row.status) + '）⇒ 云端未确认')
  push('receiptSucceeded', row.receiptStatus === 'succeeded', '回执不是 succeeded（' + txt(row.receiptLabel) + '）')
  // 回执的**身份**必须与我们要发的那一条逐字一致（防"发 A 却拿 B 的回执交差"）。
  if (row.receiptCommand !== null) push('receiptCommand', row.receiptCommand === row.command, '回执 command=' + txt(row.receiptCommand) + ' 与队列条目 ' + txt(row.command) + ' 不一致')
  if (row.receiptRequestId !== null) push('receiptRequestId', row.receiptRequestId === row.requestId, '回执 requestId 与条目 requestId 不一致')
  // 云端 revision 必须**恰好推进 1**：这是"这次提交只改了一处"的账本判据（多写一次就会 >1）。
  push('revisionAdvancedOnce',
    Number.isInteger(row.revisionBefore) && Number.isInteger(row.revisionAfter) && row.revisionAfter === row.revisionBefore + 1,
    'revision ' + txt(row.revisionBefore) + '→' + txt(row.revisionAfter) + '（必须恰好 +1）')
  // 回执自己报的提交版本必须等于此刻云端的版本 ⇒ 这一格确实属于这次提交（而不是更早某次）。
  push('receiptRevisionMatches',
    Number.isInteger(row.receiptDatasetRevision) && row.receiptDatasetRevision === row.revisionAfter,
    '回执 datasetRevision=' + txt(row.receiptDatasetRevision) + ' ≠ 云端当前 ' + txt(row.revisionAfter))
  // 跨条目连续性：上一条结束时的 revision 必须就是这一条开始时的 revision（中间有人写过就停）。
  if (Number.isInteger(row.expectedRevisionBefore)) {
    push('revisionContinuous', row.revisionBefore === row.expectedRevisionBefore,
      '本步起始 revision=' + txt(row.revisionBefore) + '，上一步结束时=' + txt(row.expectedRevisionBefore) + ' ⇒ 期间有别的写入')
  }
  // 业务账：**策略要求做的必须做了，做了的必须过**。
  //   旧写法只有一个 `if (businessChecked === true)` —— 于是"策略要求核验、但实现方根本没做"
  //   会被静默放过（这正是 2026-09-23 那次 AUTO_CONFIRM 之后的第二种静默故障）。
  if (row.businessRequired === true) {
    push('businessChecked', row.businessChecked === true, '策略要求业务级核验，但本步**没有执行**核验（这条本来就不该被发出去）')
    if (row.businessChecked === true) push('business', row.businessOk === true, '业务账核验未通过：' + txt(row.businessReason))
  } else if (row.businessChecked === true) {
    // 策略没要求、但本步做了核验 ⇒ 做了就必须过（宁可更严，不更松）。
    push('business', row.businessOk === true, '业务账核验未通过：' + txt(row.businessReason))
  }
  return { ok: failed.length === 0, checks, failed, notes, failedNotes }
}

// ── 成功核验：**收敛路径**（回执早已 succeeded，本步只把它清出队列）──
// 这一条**预期 0 次 execute**；印出来是为了证明"确实没发"。
function verifyConverged(input) {
  const row = input || {}
  const checks = {}
  const failed = []
  const notes = []
  const failedNotes = []
  const push = (name, ok, note) => { checks[name] = ok; if (!ok) { failed.push(name); if (note) { notes.push(note); failedNotes.push(note) } } }
  push('executedZero', row.executed === 0, '收敛路径必须 0 次 execute，实际 ' + txt(row.executed) + ' ⇒ 立即停手')
  push('leftQueue', row.leftQueue === true, '条目仍在队列里 ⇒ 没能收敛出队')
  push('receiptSucceeded', row.receiptStatus === 'succeeded', '回执不是 succeeded（' + txt(row.receiptLabel) + '）')
  push('revisionUnchanged',
    Number.isInteger(row.revisionBefore) && Number.isInteger(row.revisionAfter) && row.revisionAfter === row.revisionBefore,
    '收敛路径不应推进 revision（' + txt(row.revisionBefore) + '→' + txt(row.revisionAfter) + '）')
  return { ok: failed.length === 0, checks, failed, notes, failedNotes }
}

// ── 收敛（0 execute）通过：把 settled 条目清出队列，让 FIFO 队首回到计划上的那一条 ──
// 为什么这件事必须做：settled 不在 sendable 里（不会再发），但仍排在队列里，
// 而 `resendPrefixCheck` 用的正是 sendable 列表 ⇒ 它会把队首算成"下一条"，于是前缀检查失败、
// 自动续跑当场停住。用"只授权这一条 settled"再走一次 step，引擎的 purgeSettled 会在一次
// 成功的完整回读之后把它移出队列；其它条目没被授权 ⇒ 引擎在 blocksEntry 处 break ⇒ **executed 必为 0**。
async function drainSettled(deps, options) {
  for (let pass = 0; pass < options.maxDrainPasses; pass += 1) {
    const rows = deps.settledEntries()
    if (!rows.length) return { ok: true, drained: pass }
    const entry = rows[0]
    let result = null
    let threw = null
    deps.grant([String(entry.entryId)], '自动续跑 · 收敛出队（不发送）')
    try { result = await deps.step() } catch (error) { threw = error } finally {
      try { deps.clearGrant() } catch (error) { threw = threw || error }
    }
    if (threw) return { ok: false, code: 'DRAIN_THREW', message: '收敛出队时抛错：' + String((threw && threw.message) || threw) }
    const executed = executedOf(result)
    if (executed !== 0) {
      return {
        ok: false, code: 'DRAIN_EXECUTED', executed,
        message: '收敛出队这一步**不该发送**，但引擎自报 execute=' + txt(executed) + ' ⇒ 闸门被改坏了，立即停手。'
      }
    }
    if (deps.entryById(entry.entryId)) {
      return { ok: false, code: 'DRAIN_STILL_QUEUED', entryId: entry.entryId, message: '收敛出队没成功（条目 ' + entry.entryId + ' 仍在队列里）⇒ 需要一次成功的完整回读；停手。' }
    }
  }
  return { ok: false, code: 'DRAIN_UNFINISHED', message: '连续 ' + options.maxDrainPasses + ' 次都没能把 settled 条目清出队列 ⇒ 停手（不原地打转）。' }
}

// ── 主循环 ──
// 返回的报告是**必须落盘**的（本项目铁律：静默 = 事故放大器；自动跑更要把每一步留下证据）。
async function runAutoContinue(deps, options) {
  const opt = Object.assign({}, DEFAULTS, options || {})
  const startedAt = deps.now()
  const report = {
    version: 1, startedAt, finishedAt: null, entriesRun: 0, rows: [],
    stop: null, ok: false, code: null, message: '',
    queueBefore: null, queueAfter: null,
    gates: { frozen: null, grantCleared: null, policyInjected: null, stoppedByUser: false, maxEntries: opt.maxEntries, maxMs: opt.maxMs, gapMs: opt.gapMs }
  }
  const fail = (code, message, extra) => {
    report.code = code
    report.stop = Object.assign({ code, message }, extra || {})
    report.message = message
    return report
  }
  // ⓪ 硬前提：冻结必须生效。没有冻结 = 整队可能被别处一次性发完，自动续跑就失去意义。
  //    这里**只检查、绝不修改**门禁状态（本模块连写门禁的能力都没有）。
  const frozen = !!deps.frozen()
  report.gates.frozen = frozen
  if (!frozen) return fail('NOT_FROZEN', '同步冻结未生效 ⇒ 拒绝启动自动续跑（先点「重新立起同步冻结」）。')
  // ⓪′ 判据必须由调用方注入：策略不来就不跑（"靠自觉"正是上一轮停手原因被误读的根源）。
  const policyInjected = typeof deps.businessPolicy === 'function'
  report.gates.policyInjected = policyInjected
  if (!policyInjected) return fail('POLICY_NOT_INJECTED', '没有注入核验策略（deps.businessPolicy）⇒ 拒绝启动：分不清"这条无需核验"和"这条该核验但没做"的批次不允许自动跑。')
  // revision 游标：上一条成功结束时的云端 revision。下一条的**起始** revision 必须等于它 ——
  // 中间凭空多一格的唯一解释就是"有人在我们背后写了"，那就不该继续。
  let cursor = null
  try {
    report.queueBefore = deps.queue().length
    for (let index = 0; index < opt.maxEntries; index += 1) {
      if (deps.shouldStop()) { report.gates.stoppedByUser = true; return fail('USER_STOPPED', '操作员点了「停止自动续跑」⇒ 就地停手（已推进的每一条都已逐条核验并留档）。', { atIndex: index }) }
      if (deps.now() - startedAt > opt.maxMs) return fail('TIME_LIMIT', '本次自动续跑已到时间上界（' + Math.round(opt.maxMs / 60000) + ' 分钟）⇒ 停手留档，可再次启动继续。', { atIndex: index })
      if (!deps.frozen()) return fail('FREEZE_LOST', '运行中同步冻结失效 ⇒ 立即停手（绝不在无冻结状态下继续发送）。', { atIndex: index })

      // ① 收敛 pass：settled 条目会挡住 FIFO 队首，先清干净（预期 0 次 execute）。
      const drained = await drainSettled(deps, opt)
      if (!drained.ok) return fail(drained.code, drained.message, { atIndex: index })

      // ② 队首必须**恰是计划上的那一条**（同一个 resendPrefixCheck：跳条/乱序一律拒）。
      const entries = deps.queue()
      if (!entries.length) { report.ok = true; report.code = 'QUEUE_EMPTY'; report.message = '队列已空：计划内的条目全部有结论。'; return report }
      const check = deps.prefixCheck(entries)
      if (!check.ok) return fail(check.code || 'ORDER_MISMATCH', check.message || '队首与恢复计划不一致 ⇒ 拒绝继续（绝不自由 FIFO）。', { atIndex: index })
      const entry = check.rows[0]

      // ③ 号必须合法。非法 ⇒ **停手**（不自动迁移：换号必须有人看过 ── 迁移是"改变幂等身份"，不是例行步骤）。
      const verdict = deps.requestIdVerdict(entry.requestId)
      if (!verdict || verdict.ok !== true) {
        return fail('REQUEST_ID_ILLEGAL', '队首 ' + entry.entryId + ' 的 requestId 不合法（' + txt(verdict && verdict.code) + '）⇒ 停手；先人工决定是否迁移，自动续跑绝不换号。', { atIndex: index, entryId: entry.entryId })
      }

      // ④ 回执优先（沿用页面唯一的五分法）：已 succeeded ⇒ 只收敛；查询失败 / processing / 陌生 ⇒ 停手；
      //    只有"云端明确没有这一行"才真的发。
      const prior = await deps.receiptOf(entry.requestId)
      const state = deps.classifyReceipt(prior)
      let row = null
      if (state.state === 'SUCCEEDED') row = await convergeOnce(deps, entry, state)
      else if (state.safeToResend === true) {
        // ④′ **发前门禁**：策略要求业务级核验但没有可用核验器 ⇒ **不发**。
        //     为什么必须在发之前：写出去就不可逆了，事后"停手"只是让人知道有一条无法对账的写入。
        const policy = deps.businessPolicy(entry)
        if (!policy || policy.ok !== true) {
          return fail(
            (policy && policy.code) || 'BUSINESS_VERIFY_UNAVAILABLE',
            '队首 ' + entry.entryId + '（' + txt(entry.command) + '）**没有发送**：' + ((policy && policy.message) || '这条命令按策略必须做业务级核验，但还没有可用的只读核验器。'),
            { atIndex: index, entryId: entry.entryId, sent: false }
          )
        }
        // ④″ **核验可得性门禁**：业务级核验要用的只读基线取不到 ⇒ 同样**不发**。
        //     理由与④′同源：发出去就不可逆，"核不平"必须在写之前拦住，而不是写之后停手。
        const prepared = typeof deps.businessPrepare === 'function'
          ? await deps.businessPrepare(entry, policy.requirement)
          : { ok: true, baseline: null }
        if (!prepared || prepared.ok !== true) {
          return fail((prepared && prepared.code) || 'BUSINESS_BASELINE_UNAVAILABLE',
            '队首 ' + entry.entryId + '（' + txt(entry.command) + '）**没有发送**：这条命令的业务级核验现在做不了（' +
            ((prepared && prepared.message) || '发送前的只读基线取不到') + '）⇒ 宁可不发，也不留下一条无法对账的写入。',
          { atIndex: index, entryId: entry.entryId, sent: false })
        }
        row = await sendOnce(deps, entry, state, cursor, policy, prepared.baseline)
      } else {
        return fail('RECEIPT_' + state.state, '队首 ' + entry.entryId + ' 的回执结论是「' + txt(state.label) + '」⇒ 无法判断云端是否已收到 ⇒ 停手（不重发、不换号）。', { atIndex: index, entryId: entry.entryId })
      }
      report.rows.push(row)
      report.entriesRun += 1
      if (typeof deps.onRow === 'function') { try { deps.onRow(clone(row)) } catch (error) { /* 留档失败不影响停手判定 */ } }
      if (!row.ok) {
        // 停手原因必须**自带证据**：只有 check 名字（例如 "business"）等于让人再去猜一次。
        const evidence = (row.failedNotes || []).filter(Boolean).join('；')
        return fail('VERIFY_FAILED', '第 ' + (index + 1) + ' 条（' + entry.entryId + '）核验未通过：' + row.failedChecks.join(' / ') +
          (evidence ? '（' + evidence + '）' : '') + ' ⇒ 立即停手，绝不继续下一条。',
        { atIndex: index, entryId: entry.entryId, failedChecks: row.failedChecks, failedNotes: row.failedNotes || [] })
      }
      // 只有核验通过才推进游标：没通过就停手了，游标无意义。
      cursor = Number.isInteger(row.revisionAfter) ? row.revisionAfter : cursor
      if (index + 1 < opt.maxEntries) await deps.delay(opt.gapMs)
    }
    report.entriesRun = report.entriesRun || 0
    report.ok = false
    report.code = 'ENTRY_LIMIT'
    report.message = '本次已推进 ' + opt.maxEntries + ' 条（上界）⇒ 停手留档，可再次启动继续。'
    report.stop = { code: 'ENTRY_LIMIT', message: report.message }
    return report
  } catch (error) {
    return fail('AUTO_THREW', '自动续跑本身抛错（已推进的每一条都已逐条核验并留档）：' + String((error && error.message) || error))
  } finally {
    report.finishedAt = deps.now()
    try { report.queueAfter = deps.queue().length } catch (error) { report.queueAfter = null }
    // 无论走哪条出口，授权都必须已经清掉；清不掉就**如实报出来**（绝不假装干净）。
    try { report.gates.grantCleared = deps.grantIsClear() } catch (error) { report.gates.grantCleared = null }
  }
}

// 发送路径：**发送前即时取业务基线（只读）** → 拿前后 revision → 授权**只这一条** →
// 引擎 step（恰好一次 execute）→ 关闸 → 立刻核验。
// ⚠️ 基线为什么必须"发送前即时取"：差量核验的公式假设"这段时间里只发生了这一条命令"。
//    旧版在整批开始前一次性取基线，而恢复计划里「内容 → 完课」本来就相邻且同属一条 booking，
//    于是合法的前置写入被算成"期间有别的写入" ⇒ 一条其实干干净净的完课被判成账不平 ⇒ VERIFY_FAILED。
//    改成逐条即时取基线后，差量只覆盖这一条命令，口径与公式才自洽。
//    （基线由主循环在**发送前**经 `deps.businessPrepare` 取好并传进来；取不到就不会走到这里。）
async function sendOnce(deps, entry, state, expectedRevisionBefore, policy, baseline) {
  const requirement = (policy && policy.requirement) || null
  const revisionBefore = await deps.revision()
  deps.markPending(entry.entryId)
  const expected = expectedRevisionBefore === undefined ? null : expectedRevisionBefore
  let result = null
  let threw = null
  deps.grant([String(entry.entryId)], '自动续跑 · ' + entry.command)
  try { result = await deps.step() } catch (error) { threw = error } finally {
    try { deps.clearGrant() } catch (error) { threw = threw || error }
  }
  const still = deps.entryById(entry.entryId)
  const receipt = await deps.receiptOf(entry.requestId)
  const after = deps.classifyReceipt(receipt)
  const revisionAfter = await deps.revision()
  const detail = (still && still.lastError) || {}
  const response = receipt && receipt.response ? receipt.response : null
  const business = typeof deps.businessCheck === 'function'
    ? await deps.businessCheck(entry, {
      before: revisionBefore, after: revisionAfter, baseline, requirement,
      receiptResult: response && response.result ? response.result : null
    })
    : { checked: false, ok: null, reason: '调用方没有注入业务核验（deps.businessCheck）' }
  const verdict = verifySent({
    executed: executedOf(result), leftQueue: !still, status: (still && still.status) || null,
    command: entry.command, requestId: entry.requestId,
    receiptStatus: receipt ? receipt.status : null, receiptLabel: after.label,
    receiptCommand: response && response.command !== undefined ? response.command : null,
    receiptRequestId: response && response.requestId !== undefined ? response.requestId : null,
    receiptDatasetRevision: response && response.datasetRevision !== undefined ? Number(response.datasetRevision) : null,
    revisionBefore, revisionAfter, expectedRevisionBefore: expected,
    businessRequired: !!(requirement && requirement.required === true),
    businessChecked: business.checked === true, businessOk: business.ok === true, businessReason: business.reason
  })
  const notes = verdict.notes.slice()
  const neutralNotes = []
  // 「按策略无需核验」是**中性说明**，不是失败 —— 旧版把它写进 notes 又被渲染成红字，
  // 于是现场把它读成了停手原因。这里单独一条通道，界面上用中性样式展示。
  if (business.checked === false) {
    neutralNotes.push((requirement && requirement.neutralNote) || ('按策略无需业务级核验：' + txt(business.reason)))
  } else if (business.evidence && business.evidence.diff && business.evidence.diff.length) {
    notes.push('业务核验差异明细：' + business.evidence.diff.join('；'))
  }
  if (baseline === null && requirement && requirement.verifier === 'completion-ledger') {
    notes.push('发送前的业务基线为空（只读诊断没取到）—— 走到这里说明门禁漏了，核验会按未通过处理。')
  }
  if (threw) notes.push('本步发送链抛错（已按未确认处理）：' + String((threw && threw.message) || threw))
  if (detail.reason || detail.technicalMessage) notes.push('本机记下的原因：' + [detail.reason, detail.technicalMessage].filter(Boolean).join(' ｜ '))
  return {
    mode: 'sent', entryId: entry.entryId, command: entry.command, requestId: entry.requestId,
    label: entry.label || null, executed: executedOf(result),
    leftQueue: !still, status: (still && still.status) || null,
    receiptState: after.state, receiptLabel: after.label, receiptStatus: receipt ? receipt.status : null,
    receiptDatasetRevision: response && response.datasetRevision !== undefined ? Number(response.datasetRevision) : null,
    revisionBefore, revisionAfter,
    policy: requirement ? { level: requirement.level, risk: requirement.risk, verifier: requirement.verifier, required: requirement.required, effect: requirement.effect } : null,
    business: {
      checked: business.checked === true, ok: business.ok === true,
      required: !!(requirement && requirement.required === true),
      neutral: business.checked === false, reason: business.reason || null
    },
    checks: verdict.checks, failedChecks: verdict.failed, failedNotes: verdict.failedNotes, ok: verdict.ok && !threw, notes, neutralNotes
  }
}

// 收敛路径：回执说"云端其实早就成功了" ⇒ **绝不重发**，只把它标 settled 后清出队列（预期 0 execute）。
async function convergeOnce(deps, entry, state) {
  const revisionBefore = await deps.revision()
  deps.markSettled(entry.entryId)
  let result = null
  let threw = null
  deps.grant([String(entry.entryId)], '自动续跑 · 回执已成功，仅需出队')
  try { result = await deps.step() } catch (error) { threw = error } finally {
    try { deps.clearGrant() } catch (error) { threw = threw || error }
  }
  const still = deps.entryById(entry.entryId)
  const revisionAfter = await deps.revision()
  const verdict = verifyConverged({
    executed: executedOf(result), leftQueue: !still, receiptStatus: entry.receiptStatus || 'succeeded',
    receiptLabel: state.label, revisionBefore, revisionAfter
  })
  const notes = verdict.notes.slice()
  if (still) notes.push('回执已成功、但本机尚未完成一次成功完整回读 ⇒ 停手（绝不在这种状态下继续下一条）。')
  if (threw) notes.push('收敛出队时抛错：' + String((threw && threw.message) || threw))
  return {
    mode: 'converged', entryId: entry.entryId, command: entry.command, requestId: entry.requestId,
    label: entry.label || null, executed: executedOf(result),
    leftQueue: !still, status: (still && still.status) || null,
    receiptState: state.state, receiptLabel: state.label, receiptStatus: 'succeeded',
    receiptDatasetRevision: null, revisionBefore, revisionAfter,
    policy: null,
    business: { checked: false, ok: true, required: false, neutral: true, reason: '云端早已确认，本步不改业务，故不做业务级核验' },
    checks: verdict.checks, failedChecks: verdict.failed, failedNotes: verdict.failedNotes, ok: verdict.ok && !threw, notes,
    neutralNotes: ['收敛路径不发送、不改业务 ⇒ 按策略无需业务级核验（云端回执已 succeeded）']
  }
}

// 业务核验那一列的人话（三种状态必须一眼可辨：通过 / 未通过 / 按策略无需）。
function businessTextOf(row) {
  const business = (row && row.business) || {}
  if (business.checked === true) return business.ok === true ? '通过' : '未通过'
  return business.required === true ? '未执行（策略要求）' : '按策略无需'
}
// 人读报告（弹窗 / 复制共用一份，绝不出现 undefined）。
function autoRunTextOf(report) {
  const r = report || {}
  const lines = []
  lines.push('# 安全自动续跑 ' + txt(r.atText || '') + ' ｜ 结论=' + txt(r.code) + ' ｜ 本步推进 ' + txt(r.entriesRun) + ' 条')
  lines.push('队列 ' + txt(r.queueBefore) + ' → ' + txt(r.queueAfter) + ' 条 ｜ 冻结=' + (r.gates && r.gates.frozen === true ? '生效' : '★未生效★') +
    ' ｜ 授权已清=' + (r.gates && r.gates.grantCleared === true ? '是' : '★否★') +
    ' ｜ 核验策略=' + (r.gates && r.gates.policyInjected === true ? '已注入' : '★未注入★'))
  ;(r.rows || []).forEach((row, index) => {
    lines.push((index + 1) + '. ' + (row.mode === 'sent' ? '发送' : '收敛') + ' ｜ ' + txt(row.entryId) + ' ｜ ' + txt(row.command) +
      ' ｜ ' + (row.ok ? '✅已核验' : '⛔未通过') + ' ｜ 出队=' + (row.leftQueue ? 'Y' : 'n') +
      ' ｜ 回执=' + txt(row.receiptLabel) + ' ｜ revision ' + txt(row.revisionBefore) + '→' + txt(row.revisionAfter) +
      ' ｜ execute=' + txt(row.executed) + ' ｜ 业务核验=' + businessTextOf(row))
    ;(row.notes || []).forEach(note => lines.push('     ⚠️ ' + note))
    ;(row.neutralNotes || []).forEach(note => lines.push('     · ' + note))
  })
  if (r.stop) lines.push('⛔ 停手：' + txt(r.stop.code) + ' ｜ ' + txt(r.stop.message))
  return lines.join('\n')
}

module.exports = {
  DEFAULTS, runAutoContinue, verifySent, verifyConverged, drainSettled,
  autoRunTextOf, executedOf, businessTextOf
}
