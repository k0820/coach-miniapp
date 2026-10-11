const { normalizeSnapshot, analyzeLegacyCourseSales, integrity, buildCandidateDataset } = require('../../utils/candidate-dataset')
const { buildCandidateUploadPlan } = require('../../utils/candidate-staging')
const { runCandidateDryRun } = require('../../utils/candidate-dry-run')
const { analyzeHistoricalBookings } = require('../../utils/candidate-booking-diagnostic')
const { runPreActivationReadiness } = require('../../utils/pre-activation-readiness')

const call = data => wx.cloud.callFunction({ name: 'stageCoachCandidate', data }).then(response => response.result)
const fixture = () => ({
  students: [
    { id: 'fixture-student', name: 'Fixture 学员', packages: [{ id: 'fixture-package', saleId: 'fixture-sale', type: '常规训练', total: 10, used: 1, remaining: 9, price: 300 }] },
    { id: 'fixture-deleted', name: '历史 Fixture', status: 'deleted', packages: [{ id: 'fixture-deleted-package', saleId: 'fixture-deleted-sale', type: '常规训练', total: 2, used: 1, remaining: 0, status: 'reversed' }] }
  ],
  bookings: [
    { id: 'fixture-booking', studentId: 'fixture-student', studentName: 'Fixture 学员', packageId: 'fixture-package', status: 'done', typeName: '常规训练', items: [{ name: '深蹲', notes: '大记录'.repeat(12000) }, { name: '卧推' }], notes: '仅用于隔离云测试', summary: '动作顺序必须保持' },
    { id: 'fixture-deleted-booking', studentId: 'fixture-deleted', studentName: '历史 Fixture', packageId: 'fixture-deleted-package', status: 'done', typeName: '常规训练', items: [] }
  ],
  incomes: [{ id: 'fixture-income', bookingId: 'fixture-booking', studentId: 'fixture-student', amount: 300 }, { id: 'fixture-deleted-income', bookingId: 'fixture-deleted-booking', studentId: 'fixture-deleted', amount: 300 }],
  sales: [{ id: 'fixture-sale', source: 'course', studentId: 'fixture-student', packageId: 'fixture-package', quantity: 10, unitPrice: 300, amount: 2800 }, { id: 'fixture-deleted-sale', source: 'course', studentId: 'fixture-deleted', packageId: 'fixture-deleted-package', quantity: 2, unitPrice: 300, amount: 600, status: 'reversed' }, { id: 'fixture-manual', source: 'manual', amount: 88, date: '2026-09-14' }],
  settings: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 10, salesCommissionRate: 2 },
  customExercises: [{ id: 'fixture-exercise', name: 'Fixture 动作' }]
})

Page({
  data: { busy: false, result: '尚未测试。', progress: '', ready: false },
  source: null, fingerprint: null, plan: null, nextChunk: 0, materializing: false,
  show(value) { this.setData({ result: JSON.stringify(value, null, 2) }) },
  async run(task) { this.setData({ busy: true }); try { return await task() } catch (error) { const result = { ok: false, code: error.code || 'CALL_FAILED', message: error.errMsg || error.message || '调用失败', details: error.details || null }; this.show(result); return result } finally { this.setData({ busy: false }) } },
  async begin() { return this.run(async () => {
    this.source = fixture(); const normalized = normalizeSnapshot(this.source); this.fingerprint = integrity(normalized)
    const prepared = await call({ action: 'prepare', sourceChecksum: this.fingerprint.checksum }); if (!prepared.ok) return this.show(prepared)
    const candidate = buildCandidateDataset(this.source, { trustedOwnerCoachId: prepared.ownerCoachId, trustedDatasetId: prepared.datasetId }); this.plan = buildCandidateUploadPlan(candidate); this.nextChunk = 0; this.materializing = false
    const result = await call({ action: 'begin', sourceChecksum: this.fingerprint.checksum, sourceByteSize: this.fingerprint.byteSize, sourceSummary: this.fingerprint.summary, counts: this.fingerprint.counts, schemaVersion: candidate.schemaVersion, totalChunks: this.plan.totalChunks, collections: this.plan.collections })
    this.setData({ ready: !!result.ok, progress: `0/${this.plan.totalChunks} chunks` }); this.show(result)
  }) },
  async continueUpload() { return this.run(async () => {
    if (!this.plan) return this.show({ ok: false, message: '请先开始 fixture candidate。' })
    let last
    if (this.nextChunk < this.plan.chunks.length) {
      const end = Math.min(this.nextChunk + 3, this.plan.chunks.length)
      for (; this.nextChunk < end; this.nextChunk++) last = await call({ ...this.plan.chunks[this.nextChunk], sourceChecksum: this.fingerprint.checksum })
      this.setData({ progress: `${this.nextChunk}/${this.plan.totalChunks} chunks` })
    } else {
      this.materializing = true; last = await call({ action: 'materializeNext', sourceChecksum: this.fingerprint.checksum }); this.setData({ progress: `materialize: ${last.collection || '完成'} ${last.materializeCollectionIndex == null ? '' : last.materializeCollectionIndex + '/8'}` })
    }
    this.show(last)
  }) },
  async verify() { return this.run(async () => { if (!this.fingerprint) return this.show({ ok: false, message: '请先开始。' }); const result = await call({ action: 'verify', sourceChecksum: this.fingerprint.checksum, currentSourceChecksum: this.fingerprint.checksum, currentSourceByteSize: this.fingerprint.byteSize, currentSourceSummary: this.fingerprint.summary }); this.show(result) }) },
  async status() { return this.run(async () => { if (!this.fingerprint) return this.show({ ok: false, message: '请先开始。' }); this.show(await call({ action: 'getStatus', sourceChecksum: this.fingerprint.checksum })) }) },
  async cleanup() { return this.run(async () => { if (!this.fingerprint) return this.show({ ok: false, message: '请先开始。' }); let result; do { result = await call({ action: 'cleanup', sourceChecksum: this.fingerprint.checksum }) } while (result.ok && result.continue); this.show(result); if (result.cleaned) { this.plan = null; this.fingerprint = null; this.setData({ ready: false, progress: '' }) } }) }
  ,async realDryRun() {
    const confirmed = await new Promise(resolve => wx.showModal({ title: '开始真实数据 Dry-run？', content: '只复制最新本机 coachDB 到独立 candidate 并回读校验；不会激活、覆盖或切换正式数据。', confirmText: '开始验证', success: result => resolve(!!result.confirm), fail: () => resolve(false) }))
    if (!confirmed) return
    return this.run(async () => {
      const result = await runCandidateDryRun({ readSource: () => wx.getStorageSync('coachDB'), callCloud: call, onProgress: progress => { const text = progress.stage === 'upload' ? `真实 dry-run 上传 ${progress.completed}/${progress.total}` : progress.stage === 'materialize' ? `真实 dry-run materialize ${progress.materializeCollectionIndex || 0}/8` : '正在准备真实 dry-run'; this.setData({ progress: text }) } })
      this.show(result); if (result && result.ok) this.setData({ progress: '真实 candidate 云端回读通过（未激活）' })
    })
  }
  ,analyzeLegacySales() {
    return this.run(async () => {
      const source = wx.getStorageSync('coachDB')
      const report = analyzeLegacyCourseSales(source)
      const result = { ok: true, readOnly: true, counts: report.counts, records: report.records.filter(item => item.category !== 'A'), unresolvedConflicts: report.issues }
      this.show(result)
      return result
    })
  }
  ,analyzeHistoricalBookings() {
    return this.run(async () => {
      const source = wx.getStorageSync('coachDB')
      const result = analyzeHistoricalBookings(source)
      this.show({ ok: true, ...result, records: result.invalidRecords })
      return result
    })
  }
  ,preActivationReadiness() {
    return this.run(async () => {
      const result = await runPreActivationReadiness({
        readSource: () => wx.getStorageSync('coachDB'),
        callCloud: (name, data) => wx.cloud.callFunction({ name, data }).then(response => response.result)
      })
      this.show(result)
      this.setData({ progress: result.readyForActivation ? '切换前检查通过（未执行激活）' : result.message })
      return result
    })
  }
})
