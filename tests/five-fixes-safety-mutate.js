// 判别力反证：所有破坏只写入内存覆盖层，绝不写盘修改正式源码。
const overlay = require('./helpers/mutate-overlay').install()
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')

const mutations = [
  {
    name: '① 解除微信绑定入口失效',
    file: 'cloudfunctions/coachBusinessSandboxCommand/member-directory.js',
    test: 'member-dedicated-qr.test.js',
    from: "if (action === 'unbindMemberWechat') return { ...(await unbindMemberWechat({ db, environment: core.SANDBOX, actor, payload, now: stamped })), environment: core.SANDBOX, requestId }",
    to: "if (false) return { ...(await unbindMemberWechat({ db, environment: core.SANDBOX, actor, payload, now: stamped })), environment: core.SANDBOX, requestId }"
  },
  {
    name: '② 删除课时包时误删已完成课程',
    file: 'cloudfunctions/coachBusinessCommand/handlers.js',
    test: 'coach-business-command-low-risk.test.js',
    from: "if (businessData(bookingRow).status === 'done') continue",
    to: "if (false) continue"
  },
  {
    name: '③ 继续复用已经过期的开发版二维码',
    file: 'cloudfunctions/coachBusinessSandboxCommand/member-directory.js',
    test: 'member-dedicated-qr.test.js',
    from: "&& existing.permanent === true && existing.qrEnvVersion === QR_ENV_VERSION",
    to: "&& existing.permanent === true"
  },
  {
    name: '④ 体验版二维码错误打开线上旧版本',
    file: 'cloudfunctions/coachBusinessCommand/member-directory.js',
    test: 'member-permanent-qr-production.test.js',
    from: "const qrEnvVersion = requestedQrEnv === 'trial' ? 'trial' : QR_ENV_VERSION",
    to: "const qrEnvVersion = QR_ENV_VERSION"
  }
]

;(async () => {
  for (const mutation of mutations) {
    const test = path.join(__dirname, mutation.test)
    const base = await overlay.runTest(test)
    if (!base.ok) throw new Error(`${mutation.name}：基准测试不是绿的\n${base.tail}`)
    const full = path.join(root, mutation.file)
    const source = fs.readFileSync(full, 'utf8')
    const hits = source.split(mutation.from).length - 1
    if (hits !== 1) throw new Error(`${mutation.name}：锚点命中 ${hits} 次（应为1次）`)
    fs.writeFileSync(full, source.replace(mutation.from, mutation.to), 'utf8')
    const result = await overlay.runTest(test)
    if (result.ok) throw new Error(`${mutation.name} 没有被专项测试抓住`)
    console.log('PASS mutation', mutation.name)
    overlay.clear()
  }
  console.log(`${mutations.length}/${mutations.length} mutations caught`)
})().catch(error => { console.error(error); process.exitCode = 1 })
