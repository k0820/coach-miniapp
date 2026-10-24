// 判别力反证：只使用内存覆盖层，绝不写盘修改源码。
const overlay = require('./helpers/mutate-overlay').install()
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const test = path.join(__dirname, 'member-permanent-qr-production.test.js')
const file = 'cloudfunctions/coachBusinessCommand/member-directory.js'

const mutations = [
  ['正式码误用测试版', "const QR_ENV_VERSION = 'release'", "const QR_ENV_VERSION = 'trial'"],
  ['正式码丢失 p 前缀', "environment === 'sandbox' ? 's' : 'p'", "environment === 'sandbox' ? 's' : 's'"],
  ['正式区误写测试会员集合', "members: 'member_members'", "members: 'member_sandbox_members'"],
  ['永久码又被过期判断拒绝', 'if (row.permanent !== true && (!Number.isFinite(Number(row.expiresAt)) || Number(row.expiresAt) <= Number(now)))', 'if (true && (!Number.isFinite(Number(row.expiresAt)) || Number(row.expiresAt) <= Number(now)))']
]

;(async () => {
  const base = await overlay.runTest(test)
  if (!base.ok) throw new Error(`基准测试不是绿的：\n${base.tail}`)
  let caught = 0
  for (const [name, from, to] of mutations) {
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
  console.log(`${caught}/${mutations.length} production QR mutations caught`)
})().catch(error => { console.error(error); process.exitCode = 1 })
