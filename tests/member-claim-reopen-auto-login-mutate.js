// 判别力反证：所有破坏只写入内存覆盖层，绝不写盘修改正式源码。
const overlay = require('./helpers/mutate-overlay').install()
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const test = path.join(__dirname, 'member-claim-reopen-auto-login.test.js')

const mutations = [
  ['① 领取成功后不再记住二维码', 'pages/member-claim/member-claim.js', 'memberEnvironment.rememberClaimScene(this.data.scene)\n      const app = getApp()', 'const app = getApp()'],
  ['② 冷启动仍回到已失效领取页', 'app.js', 'if (resumeClaimedMember || path.indexOf(\'pages/member-\') !== 0)', 'if (path.indexOf(\'pages/member-\') !== 0)'],
  ['③ 领取页自身仍会拦截已经领取过的同一张二维码', 'pages/member-claim/member-claim.js', "if (role.raw() === 'member' && memberEnvironment.isRememberedClaimScene(scene))", 'if (false)'],
  ['④ 云端确认本人后不补记登录', 'pages/member-claim/member-claim.js', "if (result.state === 'mine') {", 'if (false) {']
]

;(async () => {
  const base = await overlay.runTest(test)
  if (!base.ok) throw new Error('基准测试不是绿的：\n' + base.tail)
  let caught = 0
  for (const [name, file, from, to] of mutations) {
    const full = path.join(root, file)
    const source = fs.readFileSync(full, 'utf8')
    const hits = source.split(from).length - 1
    if (hits !== 1) throw new Error(`${name}：锚点命中 ${hits} 次（应为1次）`)
    fs.writeFileSync(full, source.replace(from, to), 'utf8')
    const result = await overlay.runTest(test)
    if (result.ok) throw new Error(`${name} 没有被专项测试抓住`)
    caught += 1
    console.log('PASS mutation', name)
    overlay.clear()
  }
  console.log(`${caught}/${mutations.length} mutations caught`)
})().catch(error => { console.error(error); process.exitCode = 1 })
