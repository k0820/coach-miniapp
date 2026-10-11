const guard = require('../../utils/production-recovery-guard')
const sync = require('../../utils/sync-engine')
const inspector = require('../../utils/production-recovery-inspect')
const readiness = require('../../utils/production-recovery-readiness')

Page({
  data: { ready: false, busy: false, released: false, selectedId: '', candidates: [], plain: '正在冻结同步并读取本机状态…', detail: '' },
  async onLoad() {
    if (guard.released()) { const released=guard.released(); this.setData({ ready: true, released: true, selectedId: released.bookingId, plain: '临时冻结已解除。正在只读核对本机失败记录和云端训练内容…' }); await this.inspectAfterRelease(released.bookingId); return }
    guard.enter()
    await sync.whenIdle() // 已发出的请求不能撤销；等它结束后才取本机基线。
    const held = guard.held()
    this.setData({ ready: true, candidates: inspector.candidates(), selectedId: held && held.bookingId || '', plain: held ? '目标课程仍处于发送冻结状态。' : 'Production 自动同步已暂停。请选择上午那节课程；选定后该课程退出页面也保持冻结。' })
    if (held) await this.inspect(held.bookingId)
  },
  async inspectAfterRelease(bookingId) {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      const local=inspector.inspectLocal(bookingId)
      const answer=await wx.cloud.callFunction({ name: 'diagnoseCoachCompletion', data: { action: 'diagnose', environment: 'production', bookingId } })
      const cloud=answer&&answer.result
      const failed=local&&local.ok?local.failed.map(row=>({ command:row.command, code:row.code, message:row.message, requestId:row.requestId, rejectedAt:row.rejectedAt, items:row.payload&&row.payload.items||[] })):[]
      const plain=!local||!local.ok?'本机状态无法确认；不要下课。':!cloud||!cloud.ok?'云端状态无法确认；不要下课。':failed.length
        ?`本机失败档案：${failed.map(row=>`${row.command} / ${row.code}`).join('；')}。本机草稿：${local.draft?'仍在':'无'}；云端动作：${cloud.booking&&cloud.booking.items&&cloud.booking.items.length||0} 项。请先确认原因，不要重复下课。`
        :`这节课没有本机失败档案。本机草稿：${local.draft?'仍在':'无'}；云端动作：${cloud.booking&&cloud.booking.items&&cloud.booking.items.length||0} 项。若曾看到同步失败提示，可能属于另一条操作。`
      this.setData({ plain, detail:JSON.stringify({ local, cloud, failed },null,2) })
    }catch(error){this.setData({plain:'只读核对失败；不要下课。',detail:String(error&&error.message||error)})}
    finally{this.setData({busy:false})}
  },
  async releaseForRecovery() {
    if (this.data.busy || this.data.released || !this.data.selectedId || !guard.held()) return
    this.setData({ busy: true, plain: '正在重新只读核对本机与云端，尚未解除冻结…' })
    try {
      const bookingId = this.data.selectedId
      const local = inspector.inspectLocal(bookingId)
      if (!local.ok) throw new Error('本机正式缓存不可用。')
      const response = await wx.cloud.callFunction({ name: 'diagnoseCoachCompletion', data: { action: 'diagnose', environment: 'production', bookingId } })
      const cloud = response && response.result
      const result = readiness.check({ bookingId, hold: guard.held(), local, cloud })
      if (!result.ready) throw new Error(`状态已变化：${result.reason}。仍保持冻结，请勿直接下课。`)
      const confirm = await new Promise(resolve => wx.showModal({ title: '解除本节课冻结？', content: '只解除临时同步冻结，不发送旧命令、不执行完课。之后请回到原课程重新录入动作，按正常流程下课。', confirmText: '解除冻结', cancelText: '取消', success: value => resolve(!!value.confirm), fail: () => resolve(false) }))
      if (!confirm) { this.setData({ plain: '已取消；原课程仍保持冻结。' }); return }
      // 确认弹窗期间可能有状态变化；仍处于冻结状态，再做最后一次只读核对。
      const finalLocal = inspector.inspectLocal(bookingId)
      const finalResponse = await wx.cloud.callFunction({ name: 'diagnoseCoachCompletion', data: { action: 'diagnose', environment: 'production', bookingId } })
      const finalResult = readiness.check({ bookingId, hold: guard.held(), local: finalLocal, cloud: finalResponse && finalResponse.result })
      if (!finalResult.ready) throw new Error(`确认期间状态已变化：${finalResult.reason}。仍保持冻结。`)
      guard.release(bookingId, finalLocal.datasetId)
      this.setData({ released: true, plain: `临时冻结已解除。请回到原课程重新录入动作并正常下课。解除前课包 used=${finalResult.baseline.used}、remaining=${finalResult.baseline.remaining}、Income=0；没有事前基线，不能判断更早是否发生过扣课。`, detail: JSON.stringify({ bookingId, datasetId: finalLocal.datasetId, baseline: finalResult.baseline, note: '只解除独立安全门禁；未写业务数据、未发送旧命令。' }, null, 2) })
    } catch (error) { this.setData({ plain: String(error && error.message || error) }) }
    finally { this.setData({ busy: false }) }
  },
  choose(e) {
    const bookingId = e.currentTarget.dataset.id
    if (!bookingId || this.data.busy) return
    wx.showModal({ title: '只读核查这节课？', content: '确认后会冻结这节课的待同步命令，只读取本机和云端状态，不执行完课。', confirmText: '开始核查', cancelText: '取消', success: value => { if (value.confirm) this.inspect(bookingId) } })
  },
  async inspect(bookingId) {
    if (this.data.busy) return
    this.setData({ busy: true, plain: '正在先读取本机状态…' })
    try {
      const local = inspector.inspectLocal(bookingId) // 先读；这一步不写任何业务存储。
      if (!local.ok) { this.setData({ plain: '本机正式缓存不可用，无法安全确认。', detail: JSON.stringify(local, null, 2) }); return }
      guard.select(bookingId, local.datasetId) // 独立安全门禁 metadata，写后回读；不动业务数据。
      this.setData({ selectedId: bookingId, plain: '本机状态已读取，正在只读查询云端…' })
      const response = await wx.cloud.callFunction({ name: 'diagnoseCoachCompletion', data: { action: 'diagnose', environment: 'production', bookingId } })
      const cloud = response && response.result || { ok: false, code: 'EMPTY_DIAGNOSTIC_RESPONSE' }
      const requestIds = [...local.entries, ...local.failed, ...(local.draft && local.draft.submission ? [local.draft.submission] : [])].map(row => row.requestId).filter(Boolean)
      const receipts = []
      for (const requestId of [...new Set(requestIds)]) {
        try {
          // ★ §110：查回执必须用与 execute **同一个**号。盘上存的可能是含 `|` 的旧格式号，
          //   云端 getReceipt 入口同样校验格式 ⇒ 用原号查必然「查不到」，那不是"云端没有这条请求"。
          //   这里用同一份契约派生出云端认得的别名再查，并在结果里同时留原号，便于人工核对。
          const wireId = require('../../utils/request-id-rule').wireRequestId(requestId) || requestId
          const answer = await wx.cloud.callFunction({ name: 'coachBusinessCommand', data: { action: 'getReceipt', environment: 'production', requestId: wireId } })
          receipts.push({ requestId, wireRequestId: wireId, ...(answer && answer.result || { ok: false, code: 'EMPTY_RECEIPT_RESPONSE' }) })
        } catch (error) { receipts.push({ requestId, ok: false, code: 'RECEIPT_READ_FAILED' }) }
      }
      const open = local.entries.filter(row => ['pending', 'inflight', 'unknown', 'settled'].includes(row.status))
      let plain = '无法确认：云端只读诊断未成功，请保持冻结。'
      if (cloud.ok) {
        if (open.length || receipts.some(row => !row.ok || row.status === 'processing')) plain = `C：本机有 ${open.length} 条未结清命令或回执未决；不要再次下课。`
        else if (cloud.booking && cloud.booking.status === 'done' && cloud.incomes.length === 1) plain = 'B：云端课程已完成且有 1 条 Income；不要再次下课。请核对下方精确课包和回执。'
        else if (cloud.booking && cloud.booking.status === 'booked' && cloud.incomes.length === 0) plain = '云端仍未完课、Income 为 0；当前课包余额没有事前基线，扣课情况不能仅凭余额证明。请保留草稿和冻结状态。'
        else plain = 'D：云端课程、Income 或回执关系异常；不要操作业务数据。'
      }
      this.setData({ plain, detail: JSON.stringify({ local, cloud, exactReceipts: receipts }, null, 2) })
    } catch (error) {
      this.setData({ plain: '无法确认：只读核查失败，目标课程仍保持冻结。', detail: String(error && (error.errMsg || error.message) || error) })
    } finally { this.setData({ busy: false }) }
  },
  onUnload() { guard.exit() } // 不调用 resume；目标课程持久冻结。
})
