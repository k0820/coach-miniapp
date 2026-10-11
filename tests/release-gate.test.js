// 发布门禁永久回归（⑧ 发布前清理）。
//
// 这一轮真正要钉住的是**两件互不相同**的事：
//
// ①【发布阻断】干净设备（从未做过救援、Storage 里没有任何救援标记）**不得**被
//    `production-recovery-guard` 冻结。历史写法把「没有任何标记」也当成「正在核查中」，
//    于是 `blocksBusiness('production')` 恒为 true：新用户一装上正式版，
//    `mutate` 直接返回 PRODUCTION_RECOVERY_READ_ONLY、sync-engine 整轮拒发 —— 整个小程序只读。
//    本机没暴露这个问题，只因为它身上已经留着 `status:'released'` 的救援标记。
//    这条必须用**真机关心的那条链路**（mutate → 出网）来断言，不能只看一个布尔值。
//
// ②【入口可见性】正式发布包里，开发期临时入口不得出现在普通界面；
//    但**页面注册、页面代码、底层能力一个都不能少**（否则以后重新开发时是死链）。
//    所以断言写成「正式界面看不到」+「代码/注册仍在」，而不是「删掉了」。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createWorld, settle, PROJ } = require('./helpers/local-first-world')

const read = rel => fs.readFileSync(path.join(PROJ, rel), 'utf8')
// 把 `wx:if="{{devEntries}}"` 包住的区块整段摘掉 —— 剩下的文本才是「正式用户真正会看到的界面」。
function withoutDevBlocks(wxml) {
  let out = wxml
  for (;;) {
    const start = out.indexOf('<block wx:if="{{devEntries}}">')
    if (start < 0) return out
    const end = out.indexOf('</block>', start)
    if (end < 0) throw new Error('devEntries 区块没有闭合')
    out = out.slice(0, start) + out.slice(end + '</block>'.length)
  }
}
// 元素级的开发入口（直接挂在元素上、没有用 block 包起来的那种）。
// 必须连同**元素内容**一起摘掉 —— 只删开标签会把 {{diagnosticText}} 这类表达式留在文本里。
function stripDevGatedElements(wxml) {
  let out = wxml
  const openRe = /<([a-z][a-z0-9-]*)\b[^>]*?wx:if="\{\{devEntries[^"]*\}\}"[^>]*>/g
  let match
  while ((match = openRe.exec(out))) {
    const tag = match[1]
    const start = match.index
    const closeTag = `</${tag}>`
    const end = out.indexOf(closeTag, match.index + match[0].length)
    out = end < 0
      ? out.slice(0, start) + out.slice(start + match[0].length)
      : out.slice(0, start) + out.slice(end + closeTag.length)
    openRe.lastIndex = start
  }
  return out
}

async function cleanDeviceIsNotFrozen() {
  const world = createWorld()
  // 前提：这台设备**从来没有做过救援** —— 这正是新用户装上正式版时的 Storage 形状。
  assert.equal(wx.getStorageSync('coachProductionRecoveryHold'), undefined, '前提：本机不得有任何救援标记')
  const guard = require(path.join(PROJ, 'utils', 'production-recovery-guard'))
  const mutate = require(path.join(PROJ, 'utils', 'mutate'))
  world.seed({ students: [], bookings: [], incomes: [], sales: [], settings: {}, customExercises: [] })

  guard.arm() // app.onLaunch 真实会走的一步
  assert.equal(guard.inspectingNow(), false, '从未做过救援的设备不得进入「核查中」')
  assert.equal(guard.blocksBusiness('production'), false, '干净设备的 Production 业务写不得被冻结')

  // 用真实的写链路证明它真的能出网，而不是只看一个布尔值。
  const saved = await mutate('saveSettings', { renewThreshold: 9, monthlyGoalSessions: 33 })
  assert.equal(saved.ok, true, '干净设备必须能正常保存设置')
  assert.equal(saved.code, undefined, `不得返回阻断码（实际 ${saved.code}）`)
  await settle(20)
  const wrote = world.counters.calls.filter(row => row.command === 'saveSettings')
  assert.equal(wrote.length, 1, '干净设备的业务写必须真的到达云端')

  // 救援能力本身**不能**被这次修复削弱：显式进入救援流程后仍然整面冻结。
  guard.enter()
  assert.equal(guard.inspectingNow(), true, '进入救援流程后必须仍然冻结 Production')
  assert.equal((await mutate('saveSettings', { renewThreshold: 1 })).code, 'PRODUCTION_RECOVERY_READ_ONLY', '救援流程中业务写必须被拦')
  guard.select('some-booking', 'ds-test')
  assert.equal(guard.held().bookingId, 'some-booking', '选定目标后必须持久冻结')
  assert.equal((await mutate('saveSettings', { renewThreshold: 2 })).code, 'PRODUCTION_RECOVERY_READ_ONLY', '目标冻结期间业务写必须被拦')
  guard.release('some-booking', 'ds-test')
  assert.equal(guard.blocksBusiness('production'), false, '解除后必须恢复正常')
  world.restoreUi()
}

function devEntriesHiddenInRelease() {
  const flags = require(path.join(PROJ, 'utils', 'release-flags'))
  assert.equal(flags.RELEASE_BUILD, true, '发布包必须处于 RELEASE_BUILD 模式')
  assert.equal(flags.devEntriesVisible(), false, '发布包里开发入口必须不可见')
  global.wx = global.wx || {}
  global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'release' } })
  assert.equal(flags.sandboxEntryVisible(), false, '正式 release 不得展示 Sandbox 入口')
  global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'trial' } })
  assert.equal(flags.sandboxEntryVisible(), true, '体验版须可从统计页进入 Sandbox')
  global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'develop' } })
  assert.equal(flags.sandboxEntryVisible(), true, '开发版须可从统计页进入 Sandbox')
  global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'release' } })
  const flagSource = read('utils/release-flags.js')
  assert.ok(/RELEASE_BUILD = (true|false)/.test(flagSource), '可见性必须由唯一一个顶层常量控制（可回退开关）')

  // —— 课表页：Candidate Staging Fixture / 真实云端切换 ——
  const scheduleView = read('pages/schedule/schedule.wxml')
  const scheduleLeft = withoutDevBlocks(scheduleView)
  assert.ok(!/candidate-staging-test/.test(scheduleLeft), '正式课表页不得残留 Candidate Staging 入口')
  assert.ok(!/cloud-cutover/.test(scheduleLeft), '正式课表页不得残留真实云端切换入口')
  assert.ok(/Candidate Staging Fixture/.test(scheduleView), '开发包仍要能显示该入口（不能一删了之）')

  // —— 统计页：测试环境（Sandbox）/ 上午课程只读恢复诊断 ——
  const statsView = read('pages/stats/stats.wxml')
  const statsLeft = withoutDevBlocks(statsView).replace(/<navigator wx:if="\{\{sandboxEntry\}\}"[^>]*>[^<]*<\/navigator>/g, '')
  assert.ok(!/sandbox-control/.test(statsLeft), '正式统计页不得残留 Sandbox 入口')
  assert.ok(!/production-recovery-diagnostic/.test(statsLeft), '正式统计页不得残留只读恢复诊断入口')

  // —— 课程页：只读诊断按钮 + 原始诊断 JSON ——
  const sessionView = read('pages/session/session.wxml')
  const sessionLeft = stripDevGatedElements(sessionView)
  assert.ok(!/diagnoseCompletion/.test(sessionLeft), '正式课程页不得残留「只读诊断本次完课」按钮')
  assert.ok(!/\{\{diagnosticText\}\}/.test(sessionLeft), '正式课程页不得把原始诊断 JSON 打到界面上')
  assert.ok(/resumeCompletion/.test(sessionLeft), '「安全继续完成课程」是用户侧恢复入口，必须保留')

  // —— 三个页面的 data 都必须由那一个开关驱动，不许散落临时 if ——
  for (const file of ['pages/schedule/schedule.js', 'pages/stats/stats.js', 'pages/session/session.js']) {
    const source = read(file)
    assert.ok(/release-flags/.test(source), `${file} 必须从 utils/release-flags 取开关`)
    assert.ok(/devEntries\s*:\s*releaseFlags\.devEntriesVisible\(\)/.test(source), `${file} 的 devEntries 必须由 devEntriesVisible() 决定`)
  }
}

function devPagesStayRegistered() {
  const config = JSON.parse(read('app.json'))
  // 隐藏的是**入口**，不是页面。页面注册与代码都在 ⇒ 开关改回 false 就能立刻恢复，
  // 而且永远不会出现「navigateTo 找不到页面」。
  // ⭐ 2026-10-04 主包分包：低频诊断/救援页已迁到**普通分包** pkg-diag。
  //    判据本意不变——「页面必须仍处于已注册状态」（隐藏入口 ≠ 删除能力），
  //    只是合法注册位置从「只有主包 pages[]」扩到「主包 pages[] 或任意分包的 pages[]」。
  const subPkgPages = (config.subPackages || []).reduce((acc, sp) => {
    for (const p of (sp.pages || [])) acc.push(sp.root ? `${sp.root}/${p}` : p)
    return acc
  }, [])
  const registered = new Set([].concat(config.pages || [], subPkgPages))
  const devPages = [
    'pages/coach-migration-test/coach-migration-test',
    'pages/coach-cloud-read-test/coach-cloud-read-test',
    'pages/coach-command-test/coach-command-test',
    'pkg-diag/candidate-staging-test/candidate-staging-test',
    'pkg-diag/cloud-cutover/cloud-cutover',
    'pages/sandbox-control/sandbox-control',
    'pkg-diag/production-recovery-diagnostic/production-recovery-diagnostic'
  ]
  for (const page of devPages) {
    assert.ok(registered.has(page), `${page} 必须仍在 app.json 注册（主包 pages[] 或分包 pages[] 任一即可；隐藏入口 ≠ 删除能力）`)
    assert.ok(fs.existsSync(path.join(PROJ, `${page}.js`)), `${page}.js 必须仍然存在`)
    assert.ok(fs.existsSync(path.join(PROJ, `${page}.wxml`)), `${page}.wxml 必须仍然存在`)
  }
  // 正常业务页面一个都不能少。
  for (const page of ['pages/schedule/schedule', 'pages/students/students', 'pages/stats/stats', 'pages/session/session', 'pages/attendance-history/attendance-history']) {
    assert.ok(config.pages.includes(page), `${page} 是正常业务页面，不得被发布清理带走`)
  }
}

function packageIgnoresOnlyTestFiles() {
  const config = JSON.parse(read('project.config.json'))
  const ignore = (config.packOptions && config.packOptions.ignore) || []
  const values = ignore.map(rule => String(rule && rule.value || ''))
  assert.ok(values.includes('tests'), 'tests/ 是纯自动测试代码，不得进入正式小程序包')
  // 运行时真正依赖的东西绝不能被顺手排除。
  const runtimePaths = ['utils', 'components', 'pages', 'cloudfunctions', 'app.js', 'app.json', 'app.wxss', 'sitemap.json']
  for (const target of runtimePaths) {
    assert.ok(!values.includes(target), `${target} 是运行时依赖，绝不能被 packOptions.ignore 排除`)
  }
  for (const rule of ignore) {
    assert.ok(rule && typeof rule.type === 'string' && typeof rule.value === 'string', 'ignore 规则必须是微信开发者工具支持的 {type,value} 形式')
  }
}

function releaseUiHasNoDevJargon() {
  const jargon = /revision|receipt|outbox|dataset|candidate|fixture|staging|cutover|activation|cloud-primary|OPENID|requestId|checksum/
  const pages = ['pages/schedule/schedule.wxml', 'pages/students/students.wxml', 'pages/stats/stats.wxml', 'pages/session/session.wxml', 'pages/attendance-history/attendance-history.wxml']
  for (const file of pages) {
    // 先把被隐藏的开发区块摘掉：正式用户看不到的东西不算残留。
    const visible = stripDevGatedElements(withoutDevBlocks(read(file)))
    const hit = visible.match(jargon)
    assert.equal(hit, null, `${file} 的正式界面出现了开发术语「${hit && hit[0]}」`)
  }
}

async function main() {
  devEntriesHiddenInRelease()
  devPagesStayRegistered()
  packageIgnoresOnlyTestFiles()
  releaseUiHasNoDevJargon()
  await cleanDeviceIsNotFrozen()
  console.log('release gate: PASS')
}
main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1 })
