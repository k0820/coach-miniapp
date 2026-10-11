// 「只读探针的调度点」结构性判据（2026-09-23 第 25 轮新增）。
//
// 为什么需要它：本项目在 `app.js` 的 `onLaunch` 末尾用一行
//   `try { require('./utils/<name>-probe').scheduleOnLaunch(ms) } catch (error) { }`
// 挂只读取证探针。这类钩子**没有任何业务断言会覆盖它** ——
// 于是发生过一次真实事故：新加钩子时把那**一行**替换掉了，而它上面的注释**原样留着**
// （"注释在、代码不在"）⇒ 旧探针从此再也不会自动跑，测试却全绿。
//
// ⚠️ 2026-09-24 发布前清理（1.1.9）：这两个"用完即删"的取证探针**已经从启动链上移除**
//   （`diag-readonly-probe` 没有开关、每次冷启动真跑一串云调用；`diag-crosscheck-probe` 早已空转）。
//   事故正是「写了"用完即删"却忘了删」⇒ 不变量随之**反过来**：
//     旧：app.js 里必须挂着一个探针（防"注释在、代码不在"漏调度）
//     新：**app.js 里绝不能挂着任何探针**（防"调试代码混进发布包"）
//   以下判据按新口径重写；②那条保留为"将来临时挂回探针时必须合规"的护栏。
//
// 本文件的判据（全部只读文件、不跑网络）：
//   ① 启动链**必须干净**：剥注释后的 app.js 不得 require 任何 `-probe` 模块；
//   ② 若将来临时挂回探针：必须**恰好一处**、包在 try/catch 里、且在 `wx.cloud.init` **之后**；
//   ③ 探针模块必须真的导出 `scheduleOnLaunch`（接线存在但导出被改名 ⇒ 运行期 TypeError 被 catch 吞掉）；
//   ④ 只读探针不得 require 业务写层。
const fs = require('fs')
const path = require('path')

const PROJ = path.join(__dirname, '..')
const APP = path.join(PROJ, 'app.js')
const UTILS = path.join(PROJ, 'utils')

// 与项目其它静态断言同一口径：**先剥注释**，否则自己写的解释性注释会把断言绊倒。
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

let pass = 0
let fail = 0
const failures = []
function test(name, fn) {
  try { fn(); pass += 1; console.log('PASS  ' + name) }
  catch (error) { fail += 1; failures.push(name + ' :: ' + (error && error.message)); console.log('FAIL  ' + name + '   | ' + (error && error.message)) }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assert failed') }

const raw = fs.readFileSync(APP, 'utf8')
const code = stripComments(raw)
const probeFiles = fs.readdirSync(UTILS).filter(name => /-probe\.js$/.test(name))
const probeKeys = probeFiles.map(name => name.replace(/\.js$/, ''))

test('① 启动链必须干净：app.js 不得再 require 任何取证探针（调试代码不许混进发布包）', () => {
  assert(probeKeys.length > 0, 'utils 下必须有探针模块（否则这个文件在测空气）')
  probeKeys.forEach(key => {
    const needle = "require('./utils/" + key + "')"
    assert(code.indexOf(needle) < 0,
      key + ' 仍被 app.js 调度 ⇒ 取证代码混进了启动链（真机上每次冷启动都会发云调用）。' +
      '需要取证请走 pages/diag-readonly 页面入口；确需临时挂回，注释里必须写清删除触发条件。')
  })
})

test('② 若将来临时挂回探针：恰好一处、包在 try/catch 里、且在 wx.cloud.init 之后', () => {
  const initAt = code.indexOf('wx.cloud.init')
  assert(initAt >= 0, 'app.js 必须先做 wx.cloud.init')
  let wired = 0
  probeKeys.forEach(key => {
    const needle = "require('./utils/" + key + "')"
    const first = code.indexOf(needle)
    if (first < 0) return
    wired += 1
    assert(code.indexOf(needle, first + 1) < 0, key + ' 被调度了多次（每次启动会重复跑）')
    assert(first > initAt, key + ' 的调度必须在 wx.cloud.init **之后**（顺序契约）')
    // 该行必须处在 try { ... } catch 之内：从行首往前找最近的 `try {`
    const lineStart = code.lastIndexOf('\n', first) + 1
    const line = code.slice(lineStart, code.indexOf('\n', first))
    assert(/^\s*try\s*\{/.test(line), key + ' 的调度行必须自带 try/catch（失败绝不影响启动），实际：' + line.trim())
    assert(/catch\s*\(/.test(line), key + ' 的调度行必须自带 catch，实际：' + line.trim())
  })
  // 现在应该是 0 —— 这正是 ① 断言的内容；这里只做提示，不重复判红。
  assert(wired === 0, '当前发布口径下不应有任何探针被调度，实得 ' + wired)
})

test('③ 被调度的探针模块必须真的导出 scheduleOnLaunch（接线在、导出改名 ⇒ 运行期 TypeError 被 catch 吞掉）', () => {
  probeKeys.forEach(key => {
    if (code.indexOf("require('./utils/" + key + "')") < 0) return
    const source = fs.readFileSync(path.join(UTILS, key + '.js'), 'utf8')
    const stripped = stripComments(source)
    assert(/module\.exports\s*=\s*\{[\s\S]*scheduleOnLaunch[\s\S]*\}/.test(stripped),
      key + ' 必须导出 scheduleOnLaunch')
    assert(/function\s+scheduleOnLaunch\s*\(/.test(stripped), key + ' 必须真的定义 scheduleOnLaunch 函数')
    assert(/try\s*\{/.test(stripped), key + ' 内部必须有 try/catch（探针自己不许把启动搞崩）')
  })
})

test('④ 只读探针不得 require 业务写层（adapter / sync-engine / local-outbox / guard）', () => {
  probeKeys.forEach(key => {
    const stripped = stripComments(fs.readFileSync(path.join(UTILS, key + '.js'), 'utf8'))
    assert(!/cloud-primary-adapter|sync-engine|local-outbox|production-recovery-guard/.test(stripped),
      key + ' 不得 require 业务写层（会写 cache / 动队列 / 触发补发）')
    assert(!/\.flush\(/.test(stripped), key + ' 不得调用 flush（非 step 会把整队一次性发完）')
  })
})

console.log('')
console.log('通过 / 总：' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败清单：'); failures.forEach(row => console.log('  - ' + row)); process.exitCode = 1 } else { console.log('GREEN') }
