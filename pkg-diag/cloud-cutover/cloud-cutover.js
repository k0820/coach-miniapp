const runtime = require('../../utils/data-runtime')
const { createAdapter } = require('../../utils/cloud-primary-adapter')
const { createCutoverOrchestrator } = require('../../utils/cutover-orchestrator')
const { findLegacyOrphanBooking } = require('../../utils/legacy-orphan-locator')

const storage = { get: key => wx.getStorageSync(key), set: (key, value) => wx.setStorageSync(key, value) }
const callCloud = (name, data) => wx.cloud.callFunction({ name, data }).then(response => response.result)
const adapter = createAdapter({ callCloud, storage, isOnline: () => true })

Page({
  data: { busy: false, checked: false, ready: false, status: runtime.cutoverState().status, result: '尚未检查。' },
  onLoad() { this.orchestrator = createCutoverOrchestrator({ readSource: () => wx.getStorageSync('coachDB'), callCloud, storage, adapter, runtime }); this.refreshState() },
  refreshState() { const state = runtime.cutoverState(); this.setData({ status: state.status }) },
  show(result) { this.setData({ result: JSON.stringify(result, null, 2) }); this.refreshState() },
  async run(task) { this.setData({ busy: true }); try { const result = await task(); this.show(result); return result } catch (error) { const result = { ok: false, code: error.code || 'CUTOVER_CALL_FAILED', message: error.errMsg || error.message || '切换调用失败' }; this.show(result); return result } finally { this.setData({ busy: false }) } },
  check() { return this.run(async () => { const result = await this.orchestrator.check(); this.setData({ checked: true, ready: !!result.readyForActivation }); return result }) },
  async activate() {
    const state = runtime.cutoverState()
    if (state.status === runtime.MODES.ACTIVATING || state.status === runtime.MODES.PENDING) return this.run(() => this.orchestrator.finishPending())
    if (!this.data.ready) return wx.showToast({ title: '请先完成最终切换检查', icon: 'none' })
    const first = await new Promise(resolve => wx.showModal({ title: '激活云端主数据？', content: '开始后将把云端数据设为正式主数据，切换过程中请不要退出或进行其他业务操作。', confirmText: '继续切换', success: value => resolve(!!value.confirm), fail: () => resolve(false) }))
    if (!first) return
    const second = await new Promise(resolve => wx.showModal({ title: '确认开始切换？', content: '系统会先保存并验证本机恢复副本，再执行云端激活。云端激活后业务修改将暂停，直到切换完整完成。', confirmText: '确认切换', success: value => resolve(!!value.confirm), fail: () => resolve(false) }))
    if (!second) return
    const result = await this.run(() => this.orchestrator.activate())
    if (result && result.ok) wx.reLaunch({ url: '/pages/schedule/schedule' })
  },
  locateLegacyBooking() {
    return this.run(async () => {
      if (runtime.mode() !== runtime.MODES.CLOUD) return { ok: false, code: 'CLOUD_PRIMARY_REQUIRED', message: '仅能从当前 active dataset 定位。' }
      const active = await adapter.readActive()
      if (!active.ok) return active
      const found = findLegacyOrphanBooking(active.snapshot)
      if (!found) return { ok: false, code: 'LEGACY_ORPHAN_BOOKING_NOT_FOUND', message: '当前 active dataset 中未找到 Legacy 历史课程。' }
      const result = { ok: true, readOnly: true, ...found }
      this.show(result)
      wx.navigateTo({ url: `/pages/session/session?id=${encodeURIComponent(found.bookingId)}` })
      return result
    })
  }
})
