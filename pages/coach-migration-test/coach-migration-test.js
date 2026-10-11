const { validateSnapshot } = require('../../utils/local-backup')
const { migrationMetadata, MIGRATION_VERSION } = require('../../utils/cloud-migration')
const { uploadSnapshotInChunks } = require('../../utils/cloud-chunk-client')

Page({
  data: {
    coachId: '',
    localSummary: null,
    status: '正在准备迁移检查…',
    result: null,
    loading: false
  },

  onLoad() {
    this.prepare()
  },

  async prepare() {
    const snapshot = wx.getStorageSync('coachDB')
    const validation = validateSnapshot(snapshot)
    if (!validation.ok) {
      this.setData({ status: validation.message || '本机 coachDB 结构不完整。' })
      return
    }
    const local = migrationMetadata(snapshot)
    this.snapshot = snapshot
    this.setData({ localSummary: local.summary, status: '本机数据已完成只读检查', loading: true })
    try {
      const response = await wx.cloud.callFunction({ name: 'getOrCreateCoach', data: {} })
      const result = response && response.result
      if (!result || !result.ok || !result.coach) throw new Error((result && result.message) || '身份识别失败')
      this.setData({ coachId: result.coach.coachId, status: '身份已确认，可以开始迁移测试' })
    } catch (error) {
      this.setData({ status: error.message || '身份识别失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  startMigration() {
    if (!this.data.coachId || !this.snapshot) return wx.showToast({ title: '迁移条件尚未就绪', icon: 'none' })
    wx.showModal({
      title: '开始云端迁移？',
      content: '将把当前本机 coachDB 复制到你的云端业务集合。本机数据不会被删除或修改。',
      confirmText: '开始迁移',
      success: result => { if (result.confirm) this.runMigration() }
    })
  },

  openCloudReadTest() {
    wx.navigateTo({ url: '/pages/coach-cloud-read-test/coach-cloud-read-test' })
  },

  async runMigration() {
    this.setData({ loading: true, status: '正在迁移并回读校验…', result: null })
    try {
      const result = await uploadSnapshotInChunks({
        functionName: 'migrateCoachDBToCloud',
        mode: 'migration',
        snapshot: this.snapshot,
        onProgress: (done, total) => this.setData({ status: `正在上传迁移数据… ${done}/${total}` }),
        onFinalizeProgress: progress => {
          if (progress.stage === 'verifying') this.setData({ status: '正在回读并校验全部云端数据…' })
          else this.setData({ status: `正在安全写入云端集合… ${progress.finalizeCollectionIndex || 0}/${progress.totalCollections || 7}` })
        }
      })
      if (!result || !result.ok) throw Object.assign(new Error((result && result.message) || '迁移失败'), { result })
      this.setData({
        status: result.idempotent ? '同一份数据已迁移，无重复写入' : '迁移和云端回读校验通过',
        result: {
          migrationVersion: result.migrationVersion || MIGRATION_VERSION,
          migrationId: result.migrationId,
          checksum: result.checksum,
          summary: result.summary,
          verified: !!(result.verification && result.verification.valid),
          idempotent: !!result.idempotent
        }
      })
      wx.showToast({ title: result.idempotent ? '数据已存在且一致' : '迁移校验通过' })
    } catch (error) {
      const result = error.result
      this.setData({ status: (result && result.message) || error.message || '迁移失败，本机数据未改变', result: null })
      wx.showModal({ title: '迁移未完成', content: (result && result.message) || error.message || '请检查云端配置后重试。', showCancel: false, confirmText: '知道了' })
    } finally {
      this.setData({ loading: false })
    }
  }
})
