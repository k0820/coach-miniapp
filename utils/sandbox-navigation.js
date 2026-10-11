let returning = null
let launched = false

function resetReturnNavigation() {
  returning = null
  launched = false
}

function returnToProduction({ switchEnvironment, production, wxApi = wx, onBusy = () => {} }) {
  if (returning) return returning
  onBusy(true)
  wxApi.showLoading({ title: '正在返回正式区' })
  returning = (async () => {
    try {
      const result = await switchEnvironment(production)
      if (!result.ok) {
        onBusy(false)
        wxApi.showToast({ title: '正式区暂时无法加载', icon: 'none' })
        returning = null
        return result
      }
      if (!launched) {
        launched = true
        wxApi.reLaunch({ url: '/pages/schedule/schedule' })
      }
      return result
    } catch (error) {
      launched = false
      onBusy(false)
      returning = null
      wxApi.showToast({ title: '正式区暂时无法加载', icon: 'none' })
      return { ok: false, code: 'PRODUCTION_SWITCH_FAILED' }
    } finally {
      wxApi.hideLoading()
    }
  })()
  return returning
}

module.exports = { returnToProduction, resetReturnNavigation }
