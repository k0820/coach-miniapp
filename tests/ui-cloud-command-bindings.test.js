const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { COMMANDS } = require('../utils/cloud-primary-adapter')
const { UI_COMMAND_BINDINGS, SERVER_TRIGGERED_COMMANDS } = require('../utils/ui-command-bindings')

const root = path.resolve(__dirname, '..')
const sources = {
  'pages/students': fs.readFileSync(path.join(root, 'pages/students/students.js'), 'utf8'),
  'pages/stats': fs.readFileSync(path.join(root, 'pages/stats/stats.js'), 'utf8'),
  'pages/session': fs.readFileSync(path.join(root, 'pages/session/session.js'), 'utf8'),
  'components/booking-modal': fs.readFileSync(path.join(root, 'components/booking-modal/booking-modal.js'), 'utf8'),
  'components/exercise-picker': fs.readFileSync(path.join(root, 'components/exercise-picker/exercise-picker.js'), 'utf8'),
  // M2 第四批：Sandbox 验收页也发两条共享命令 —— 一样必须走统一写入口、一样必须登记。
  'pages/sandbox-shared-test': fs.readFileSync(path.join(root, 'pages/sandbox-shared-test/sandbox-shared-test.js'), 'utf8')
}

// ⭐ 2026-10-06：旧「多教练服务（授权）工作台」页面已随认领方案下线。
//    ⇒ 授权不再是教练手工点的动作，而是「添加联系人」的**后果**（服务端写）。
//    ⇒ 所以"有 UI 出口的命令" + "只由服务端触发的命令" = 全部命令，一格不多一格不少。
assert.deepStrictEqual(Object.keys(UI_COMMAND_BINDINGS).concat(SERVER_TRIGGERED_COMMANDS).sort(), COMMANDS.slice().sort())
SERVER_TRIGGERED_COMMANDS.forEach(command => {
  assert.ok(!Object.prototype.hasOwnProperty.call(UI_COMMAND_BINDINGS, command), `${command} 不许再有客户端出口`)
})
// ⛔ 客户端任何业务源码都不许再出现这 5 条命令名（出现 = 又有人想从手机端手工授权）
// （只扫页面 / 组件：`utils/mutate.js` 与 `cloud-command-engine.js` 里的**白名单登记**是另一回事，
//   那条漏斗服务端也要用，不许因为这里而把登记删掉。）
const clientSource = Object.values(sources).join('\n')
SERVER_TRIGGERED_COMMANDS.forEach(command => {
  const hits = clientSource.split('\n').map((line, index) => (line.includes(`'${command}'`) ? index + 1 : 0)).filter(Boolean)
  assert.deepStrictEqual(hits, [], `⛔ 客户端还在引用 ${command}（行 ${hits.join(',')}）⇒ 授权必须只由服务端在添加联系人时写`)
})
for (const [command, bindings] of Object.entries(UI_COMMAND_BINDINGS)) {
  assert.ok(bindings.length, `${command} must have a UI binding`)
  for (const binding of bindings) {
    const split = binding.lastIndexOf(':'), file = binding.slice(0, split), handler = binding.slice(split + 1), source = sources[file]
    assert.ok(source, `missing mapped source ${file}`)
    assert.ok(source.includes(`${handler}(`), `${binding} handler missing`)
    assert.ok(source.includes(`'${command}'`), `${binding} does not reference ${command}`)
  }
}

const formal = Object.values(sources).join('\n')
const ordinaryBusinessUi = Object.entries(sources).filter(([name]) => name !== 'pages/stats').map(([, source]) => source).join('\n')
assert.ok(!ordinaryBusinessUi.includes("wx.setStorageSync('coachDB'"), 'ordinary business UI must not directly write coachDB storage')
const restoreWrites = sources['pages/stats'].match(/wx\.setStorageSync\('coachDB',\s*(?:inspection|safety)\.snapshot\)/g) || []
assert.strictEqual(restoreWrites.length, 2, 'stats direct coachDB writes must remain restricted to the two explicit restore lifecycle paths')
assert.ok(!formal.includes('repository.saveSnapshot'), 'formal UI must not snapshot-overwrite cloud data')
assert.ok(!formal.includes('genericUpsert'), 'formal UI must not use a generic cloud upsert')
// 写路径判断已收敛到统一入口 mutate（阶段1）：本机保存仍然必须在云端分支之后，且不再由页面自己判断数据源。
assert.ok(/if\(mutate\.isCloudWritePath\(\)\)/.test(sources['pages/students']), 'student local save must be behind the cloud split')
assert.ok(!/\bisCloudPrimary\b/.test(formal), 'formal UI must not decide the data source itself —— 只允许 mutate.isCloudWritePath()')
assert.ok(sources['pages/students'].includes("require('../../utils/mutate')"), 'formal UI must go through the unified write entry')
assert.ok(sources['pages/students'].includes("command=creating?'createStudent':'updateStudent'"), 'student profile must be split from package creation')
// 钉**契约**而不是拼写：付费购买必须走 createCourseSale、赠课必须走 createPackage。
// （命令载荷的构造入口收敛到 newPackageCommand，写法改成 `command:'createCourseSale'` 属正常重构，
//   所以这里只要求"某个 command 被赋成该命令名"，不钉赋值语法是 = 还是 :。）
assert.ok(/command\s*[:=]\s*'createCourseSale'/.test(sources['pages/students']), 'paid purchase must use createCourseSale')
assert.ok(/command\s*[:=]\s*'createPackage'/.test(sources['pages/students']), 'gift purchase must use createPackage')
console.log('ui-cloud-command-bindings tests passed')
