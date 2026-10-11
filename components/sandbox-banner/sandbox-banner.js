const runtime = require('../../utils/data-runtime')
const { switchEnvironment } = require('../../utils/ui-cloud-command')
const { returnToProduction } = require('../../utils/sandbox-navigation')
Component({
  data: { visible: false, returning: false },
  lifetimes: { attached() { this.setData({ visible: runtime.isSandbox() }) } },
  pageLifetimes: { show() { this.setData({ visible: runtime.isSandbox() }) } },
  methods: {
    exit() {
      return returnToProduction({
        switchEnvironment,
        production: runtime.ENVIRONMENTS.PRODUCTION,
        onBusy: returning => this.setData({ returning })
      })
    }
  }
})
