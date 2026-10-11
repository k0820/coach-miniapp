const runtime = require('../../utils/data-runtime')
const { switchEnvironment, adapter } = require('../../utils/ui-cloud-command')
const { returnToProduction, resetReturnNavigation } = require('../../utils/sandbox-navigation')
// 角色与环境必须成对持久化：只落 role 不落 environment，会员端冷启动会静默退回正式区。
const memberEnvironment = require('../../utils/member-environment')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const isTransactionConflict = error => /TransactionConflict|-501001|DATABASE_TRANSACTION_CONFLICT/i.test(String((error && (error.errMsg || error.message)) || error || ''))
const isFunctionTimeout = error => /-504003|FUNCTIONS_TIME_LIMIT_EXCEEDED|timed out|TIME_LIMIT/i.test(String((error && (error.errMsg || error.message)) || error || ''))
// Sandbox 初始化会删除并重建同一批假数据。前一次刷新还没结束时再次进入，CloudBase
// 可能短暂返回事务冲突；这是可恢复状态，只在测试区自动重试，其他错误仍原样抛出。
async function sandboxCall(name, data) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return (await wx.cloud.callFunction({ name, data })).result }
    catch (error) {
      lastError = error
      // ensure/seed 都使用确定性文档 ID，超时后重复调用会先检查现状，不会重复建立一套数据。
      // reset 是用户明确触发的破坏性测试操作，结果未知时不在这里自动重放。
      const retryable = isTransactionConflict(error) || (data && data.action !== 'reset' && isFunctionTimeout(error))
      if (!retryable || attempt === 2) throw error
      await sleep(isFunctionTimeout(error) ? 600 * (attempt + 1) : 150 * (attempt + 1))
    }
  }
  throw lastError
}
const call = data => sandboxCall('manageCoachSandbox', data)
const memberCall = data => sandboxCall('manageMemberSandbox', data)

function discardStaleSandboxReadCache() {
  // manageCoachSandbox 可能刚把 Sandbox 重建为 revision 0。手机里上一代 Sandbox cache
  // 若是 revision 1+，正常的防倒退保护会返回 ACTIVE_READ_STALE。这里仅丢弃两份测试区
  // 只读缓存，让 switchEnvironment 重新完整读取；正式区 cache / outbox 一概不碰。
  wx.removeStorageSync(runtime.SANDBOX_CACHE_KEY)
  wx.removeStorageSync('coachSandboxActiveRows')
  adapter.resetState(runtime.ENVIRONMENTS.SANDBOX)
}

Page({
  data: { busy: false, sandbox: false, status: '尚未检查' },
  onShow() { this.setData({ sandbox: runtime.isSandbox() }); this.status() },
  async status() {
    try {
      const result = await call({ action: 'status' })
      this.setData({ status: result.ok ? (result.exists ? '沙盒已准备' : '沙盒尚未初始化') : (result.message || result.code) })
    } catch (error) { this.setData({ status: '无法连接沙盒服务' }) }
  },
  async enter() {
    if (this.data.busy) return
    this.setData({ busy: true })
    wx.showLoading({ title: '准备测试环境' })
    try {
      const ready = await call({ action: 'ensure' })
      if (!ready.ok) throw new Error(ready.message || ready.code)
      const switched = await switchEnvironment(runtime.ENVIRONMENTS.SANDBOX)
      if (!switched.ok) throw new Error(switched.message || switched.code)
      // ⭐ M2 真机修复：进入**教练端**测试区必须落 (coach + sandbox)。
      //   以前这里写的是 exitToCoach()（coach + production）⇒ 教练端沙盒等于没持久化。
      memberEnvironment.enterCoachSandbox()
      getApp().globalData.activeRole = 'coach'
      resetReturnNavigation()
      wx.hideLoading()
      wx.reLaunch({ url: '/pages/schedule/schedule' })
    } catch (error) {
      wx.hideLoading()
      this.setData({ busy: false })
      wx.showModal({ title: '无法进入沙盒', content: error.message || '请检查网络后重试', showCancel: false })
    }
  },
  async member() {
    if (this.data.busy) return
    this.setData({ busy: true })
    wx.showLoading({ title: '准备会员测试区' })
    try {
      const coachReady = await call({ action: 'ensure' })
      if (!coachReady.ok) throw new Error(coachReady.message || coachReady.code)
      const memberReady = await memberCall({ action: 'seed' })
      if (!memberReady.ok) throw new Error(memberReady.message || memberReady.code)
      discardStaleSandboxReadCache()
      const switched = await switchEnvironment(runtime.ENVIRONMENTS.SANDBOX)
      if (!switched.ok) throw new Error(switched.message || switched.code)
      memberEnvironment.enterSandbox()
      getApp().globalData.activeRole = 'member'
      resetReturnNavigation()
      wx.hideLoading()
      wx.reLaunch({ url: '/pages/member-home/member-home' })
    } catch (error) {
      wx.hideLoading()
      this.setData({ busy: false })
      wx.showModal({ title: '无法进入会员测试区', content: error.message || '请检查网络后重试', showCancel: false })
    }
  },
  reset() {
    if (this.data.busy) return
    this.setData({ busy: true })
    wx.showModal({
      title: '重置沙盒假数据',
      content: '只会清理并重建当前微信的沙盒数据，不会触碰正式区。',
      confirmText: '确认重置',
      confirmColor: '#c7563d',
      success: async result => {
        if (!result.confirm) { this.setData({ busy: false }); return }
        wx.showLoading({ title: '正在重置' })
        try {
          const memberReset = await memberCall({ action: 'reset' })
          if (!memberReset.ok) throw new Error(memberReset.message || memberReset.code)
          const reset = await call({ action: 'reset' })
          if (!reset.ok) throw new Error(reset.message || reset.code)
          const switched = await switchEnvironment(runtime.ENVIRONMENTS.SANDBOX)
          if (!switched.ok) throw new Error(switched.message || switched.code)
          // 同上：重置后仍是教练端测试区 ⇒ 落 (coach + sandbox)。
          memberEnvironment.enterCoachSandbox()
          getApp().globalData.activeRole = 'coach'
          resetReturnNavigation()
          wx.hideLoading()
          wx.reLaunch({ url: '/pages/schedule/schedule' })
        } catch (error) {
          wx.hideLoading()
          this.setData({ busy: false })
          wx.showModal({ title: '重置未完成', content: error.message || '请重试', showCancel: false })
        }
      },
      fail: () => this.setData({ busy: false })
    })
  },
  production() {
    memberEnvironment.exitToCoach()
    getApp().globalData.activeRole = 'coach'
    return returnToProduction({
      switchEnvironment,
      production: runtime.ENVIRONMENTS.PRODUCTION,
      onBusy: busy => this.setData({ busy })
    })
  }
})
