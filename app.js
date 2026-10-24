App({
  onLaunch(options) {
    // 云开发必须先于任何可能触发同步/补发的模块和网络回调完成初始化。
    // 旧顺序先注册 getNetworkType，再在后面 init；开发者工具或快网络下，
    // 回调可能抢先执行，导致本次进程里的第一批云调用直接中断。
    if (!wx.cloud) {
      console.error('当前微信基础库不支持云开发')
      return
    }
    wx.cloud.init({
      env: 'cloud1-d6g8l8h3uc9d8976f',
      traceUser: true
    })

    // 首次打开先选身份。没有明确选择时绝不能默认创建空教练账号；会员分享链接除外，
    // 因为它本身已经明确表示正在进入会员流程。
    const appRole = require('./utils/app-role')
    const launchPath = String(options && options.path || '')
    if (!appRole.hasChoice() && !appRole.isMemberPath(options)) {
      this.globalData.activeRole = ''
      if (launchPath !== 'pages/role-entry/role-entry') setTimeout(() => {
        if (typeof wx.reLaunch === 'function') wx.reLaunch({ url: '/pages/role-entry/role-entry' })
      }, 0)
      return
    }

    // 会员端是同一小程序里的第二角色。会员入口只使用会员专用云函数，不能在冷启动时
    // 被教练端 bootstrap 自动创建成一位“空教练”，更不能启动教练 Production Outbox。
    // 未选择过会员角色的既有教练仍逐字走下面原有启动链路。
    if (appRole.isMember(options)) {
      this.globalData.activeRole = 'member'
      // ⭐ 冷启动 / 重新打开体验版：把持久化的会员环境（正式区 or 测试区）恢复回来。
      //   没有这一步，会员 Sandbox 会在重启后被静默退回 Production，读到空数据且不报错。
      const memberEnvironment = require('./utils/member-environment')
      // 专属码自带环境前缀：正式码进入正式会员区，测试码继续留在隔离测试区。
      const bindingScene = appRole.isMemberBindingQr(options) ? appRole.memberBindingScene(options) : ''
      // 扫到一张新的专属码时，必须先预览这张码指向的资料。旧首页缓存只能用于
      // “没有携带二维码”的普通冷启动，不能把新码短路回上一位会员。
      const resumeClaimedMember = appRole.raw() === 'member' && !!bindingScene && memberEnvironment.isRememberedClaimScene(bindingScene)
      if (bindingScene) memberEnvironment.enterFromClaimScene(appRole.memberBindingScene(options))
      else memberEnvironment.apply()
      this.globalData.memberEntryScene = resumeClaimedMember ? '' : bindingScene
      const path = options && options.path || ''
      if (resumeClaimedMember || path.indexOf('pages/member-') !== 0) setTimeout(() => wx.reLaunch({ url: '/pages/member-home/member-home' }), 0)
      return
    }

    this.startCoachRuntime('launch')
    // app.json 的第一页必须保留给真正的新用户选择身份；已经选择过教练的手机
    // 冷启动落到第一页时，应直接进入课表，不再让用户重复选择和登录。
    if (launchPath === 'pages/role-entry/role-entry') setTimeout(() => {
      if (typeof wx.reLaunch === 'function') wx.reLaunch({ url: '/pages/schedule/schedule' })
    }, 0)
  },

  // 教练运行时只有一个入口。老教练启动与首次点击“微信一键登录”都走这里，
  // 避免登录页另写一套同步/恢复逻辑。重复调用只恢复现有队列，不重复注册网络监听。
  startCoachRuntime(reason = 'manual') {
    this.globalData.activeRole = 'coach'
    const bootstrap = require('./utils/cloud-bootstrap')
    if (this._coachRuntimeStarted) {
      try { require('./utils/sync-engine').resume() } catch (error) {}
      return bootstrap.ensure(reason)
    }
    this._coachRuntimeStarted = true

    // 必须在任何网络回调/页面 onShow 补发之前先装好 Production 救援门禁。
    require('./utils/production-recovery-guard').arm()
    const runtime = require('./utils/data-runtime')
    // ⭐ M2 真机修复（2026-09-27）：教练分支**不再无条件打回正式区**。
    //   旧代码这里一行 `setEnvironment(PRODUCTION)`，而教练端 Sandbox 只在内存里活着
    //   ⇒ 进程一重建（真机上：微信回收后台、切号、重开体验版）就静默退回正式区，
    //   ⇒ M2 验收页被自己的门禁挡住。
    //   环境落盘**只有一个来源**（utils/member-environment：角色与环境成对写入）：
    //   这里照实恢复它；没有任何记录时 read() 就是 production，行为与旧代码逐字一致。
    //   退出测试区仍然只有一个出口：沙盒页的「返回正式区」（写回 coach + production）。
    const persistedEnvironment = require('./utils/member-environment').read()
    if (persistedEnvironment === runtime.ENVIRONMENTS.SANDBOX) runtime.setEnvironment(runtime.ENVIRONMENTS.SANDBOX)
    else runtime.setEnvironment(runtime.ENVIRONMENTS.PRODUCTION)
    const cloudCommand = require('./utils/ui-cloud-command')
    const syncEngine = require('./utils/sync-engine')
    // 首次云端空间自动开通器（方案 A）。老账号走到它时是**零调用**直接返回（见 utils/cloud-bootstrap.js 第 ① 条）。
    // 阶段 2：网络一恢复就把持久 Outbox 里的业务事实补发出去（联网时是空队列，零开销）。
    // 用 resume 而不是 schedule：恢复网络 / 新进程启动意味着上一次失败的"没网"前提已经消失，
    // 必须同时解除退避窗口（否则用户恢复了网络还要干等十几秒，界面与云端长时间对不上）。
    // 开通器同理：上一次失败的原因（没网）已经消失，跟着一起解除退避并补跑一轮。
    wx.getNetworkType({ success: result => { cloudCommand.setOnline(result.networkType !== 'none'); if (result.networkType !== 'none') { syncEngine.resume(); bootstrap.resume() } } })
    wx.onNetworkStatusChange(result => { cloudCommand.setOnline(result.isConnected); if (result.isConnected) { syncEngine.resume(); bootstrap.resume() } })
    // 必须在 wx.cloud.init 之后：全新设备在这里自动取得自己的云端空间；
    // 已经是 cloud-primary 的设备在这里一次网络调用都不会发（mode 检查在发请求之前）。
    const boot = bootstrap.maybeRun(reason)
    // ⚠️ 1.1.9 发布前清理（2026-09-24）：这里原先挂着两个"用完即删"的取证探针
    //   （`diag-readonly-probe` 每次冷启动自动跑一串云调用；`diag-crosscheck-probe` 已 ARMED=false 属空转）。
    //   两者都不是业务代码，已从包中移除，对应的 `require` 也随之删除（无其他引用，不构成死代码）。
    //   需要手动取证时走 pages/diag-readonly 页面入口，不再在启动链上跑。
    // ⭐ M2：启动是一个正式的刷新触发点（让关键页面重新取云端最新数据）。
    const autoRefresh = require('./utils/auto-refresh')
    if (reason === 'launch') autoRefresh.request('appLaunch')
    else autoRefresh.request('coachLogin')
    return boot
  },
  // 冷启动 / 回到前台：先认领上一进程留下的本机意图，再补发（断网期间录的课不会等下一次点击）；
  // 顺便把还没完成的首次开通再推一轮（成功过 / 已是云端主数据时是零开销）。
  onShow(options) {
    const appRole = require('./utils/app-role')
    // 小程序已在后台时扫码不会再次执行 onLaunch，只会带着新入口执行 onShow。
    // 在任何教练端刷新之前先接住会员二维码，切换角色/环境，并确保打开绑定页。
    if (appRole.isMemberPath(options)) {
      this.globalData.activeRole = 'member'
      const memberEnvironment = require('./utils/member-environment')
      const bindingScene = appRole.isMemberBindingQr(options) ? appRole.memberBindingScene(options) : ''
      const resumeClaimedMember = appRole.raw() === 'member' && !!bindingScene && memberEnvironment.isRememberedClaimScene(bindingScene)
      if (bindingScene) memberEnvironment.enterFromClaimScene(appRole.memberBindingScene(options))
      else memberEnvironment.apply()
      this.globalData.memberEntryScene = resumeClaimedMember ? '' : bindingScene
      const targetPath = String(options && options.path || '')
      const scene = bindingScene
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
      const current = pages.length ? String(pages[pages.length - 1].route || '') : ''
      if (resumeClaimedMember) {
        if (current !== 'pages/member-home/member-home' && typeof wx.reLaunch === 'function') setTimeout(() => wx.reLaunch({ url: '/pages/member-home/member-home' }), 0)
        return
      }
      if (targetPath && current && current !== targetPath && typeof wx.reLaunch === 'function') {
        const suffix = scene ? `?scene=${encodeURIComponent(scene)}` : ''
        setTimeout(() => wx.reLaunch({ url: `/${targetPath}${suffix}` }), 0)
      }
      return
    }
    if (!appRole.hasChoice() || appRole.stored() === 'member') return
    // ⭐ M2：从后台回到前台 ⇒ 广播一次刷新（页面各自 onShow 会真的去取数）。
    // 首次进入尚未选择身份时不能提前启动任何教练端刷新链。
    const autoRefresh = require('./utils/auto-refresh')
    autoRefresh.request('appForeground')
    if (!this._coachRuntimeStarted) { this.startCoachRuntime('show'); return }
    require('./utils/sync-engine').resume()
    require('./utils/cloud-bootstrap').maybeRun('show')
  },
  onHide() {
    // A temporary background transition is not an explicit "return to
    // Production" action. Keep the current in-process environment; onLaunch
    // resets to Production on a genuine fresh start.
  },
  globalData: { refreshSchedule: false, activeRole: '', memberEntryScene: '' }
})
