const { validateSnapshot } = require('../../utils/local-backup')
const { readMyCoachCloudSnapshot, compareCloudAndLocal } = require('../../utils/cloud-shadow-read')

function callCloud(name, data) {
  return new Promise((resolve, reject) => wx.cloud.callFunction({
    name, data,
    success: response => resolve(response && response.result),
    fail: error => reject(new Error(error && error.errMsg || '云函数调用失败'))
  }))
}

function shortHash(value) { return value ? `${value.slice(0, 12)}…${value.slice(-8)}` : '-' }

Page({
  data: { loading: false, status: '尚未开始只读验证', result: null },

  async verify() {
    if (this.data.loading) return
    this.setData({ loading: true, status: '正在只读分页读取云端数据…', result: null })
    try {
      const cloudResult = await readMyCoachCloudSnapshot({
        call: callCloud,
        onProgress: (done, total, collection) => this.setData({ status: `正在读取 ${collection}（${done}/${total}）` })
      })
      if (!cloudResult || !cloudResult.ok) {
        if (cloudResult && cloudResult.code === 'MIGRATION_NOT_FOUND') {
          this.setData({ status: '当前微信暂无已完成的云端迁移数据', result: null })
          return wx.showModal({ title: '暂无云端数据', content: '当前微信没有已完成的正式云端迁移，无法读取其他微信的数据。', showCancel: false, confirmText: '知道了' })
        }
        throw new Error(cloudResult && cloudResult.message || '云端读取失败')
      }
      const localSnapshot = wx.getStorageSync('coachDB'), validation = validateSnapshot(localSnapshot)
      if (!validation.ok) {
        this.setData({ status: '云端读取成功，但本机暂无可比较的 coachDB', result: null })
        return wx.showModal({ title: '仅完成云端读取', content: '当前微信的云端数据已读取，但本机没有有效 coachDB，无法进行本机一致性比较。', showCancel: false, confirmText: '知道了' })
      }
      const comparison = compareCloudAndLocal(cloudResult.snapshot, localSnapshot, cloudResult.metadata)
      const summary = comparison.summary, localSummary = summary.local, cloudSummary = summary.cloud
      this.setData({
        status: comparison.cloudIntegrity ? (comparison.localMatchesCloud ? '云端有效，与本机完全一致' : '云端有效，但与本机有差异') : '云端迁移数据完整性校验失败',
        result: {
          migrationVersion: cloudResult.metadata.migrationVersion,
          cloudIntegrity: comparison.cloudIntegrity,
          localMatchesCloud: comparison.localMatchesCloud,
          checksumMatches: comparison.checksum.localMatchesCloud,
          byteSizeMatches: comparison.byteSize.localMatchesCloud,
          expectedIntegrityChecksum: comparison.checksum.cloudMatchesExpected,
          expectedIntegrityByteSize: comparison.byteSize.cloudMatchesExpected,
          orderMatches: comparison.orderMatches,
          relationMatches: comparison.relationMatches,
          localChecksum: shortHash(comparison.checksum.local),
          cloudChecksum: shortHash(comparison.checksum.cloud),
          localByteSize: comparison.byteSize.local,
          cloudByteSize: comparison.byteSize.cloud,
          localSummary,
          cloudSummary,
          summaryDifferences: summary.localDifferences
        }
      })
    } catch (error) {
      this.setData({ status: error.message || '云端读取失败，本机数据没有改变', result: null })
      wx.showModal({ title: '只读验证失败', content: error.message || '请检查网络和云函数部署。', showCancel: false, confirmText: '知道了' })
    } finally {
      this.setData({ loading: false })
    }
  }
})
