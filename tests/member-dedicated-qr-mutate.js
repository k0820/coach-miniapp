// 判别力反证：变异只存在于内存覆盖层，绝不写盘污染源码。
const overlay = require('./helpers/mutate-overlay').install()
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const test = path.join(__dirname, 'member-dedicated-qr.test.js')

const mutations = [
  ['① 永久二维码不再稳定复用', 'cloudfunctions/coachBusinessSandboxCommand/member-directory.js', 'const keep = !forceRotate && existing && existing.kind', 'const keep = false && !forceRotate && existing && existing.kind'],
  ['② 允许从二维码复制出第二位学员', 'cloudfunctions/coachBusinessSandboxCommand/member-directory.js', "const memberId = fixedId('member-by-student'", "await setRow(db, 'students', 'forged-student', { studentId: 'forged-student' })\n  const memberId = fixedId('member-by-student'"],
  ['③ 别人可以抢走已绑定资料', 'cloudfunctions/coachBusinessSandboxCommand/member-directory.js', 'if (bound && bound !== String(openId))', 'if (false && bound && bound !== String(openId))'],
  ['④ 预览偷偷绑定微信', 'cloudfunctions/coachBusinessSandboxCommand/member-directory.js', "const state = !bound ? 'available'", "member.openId = String(openId)\n  await setRow(db, COLLECTIONS.members, fixedId('member-directory-member', member.memberId), member)\n  const state = !bound ? 'available'"],
  ['⑤ 专属码入口又被放回旧通讯录详情', 'pages/coach-member-detail/coach-member-detail.wxml', '<button wx:if="{{isOwner}}" class="btn ghost" bindtap="openEdit">', '<button class="btn ghost">生成专属二维码</button><button wx:if="{{isOwner}}" class="btn ghost" bindtap="openEdit">'],
  ['⑥ 转发按钮被移除', 'pages/coach-member-qr/coach-member-qr.wxml', 'open-type="share"', 'data-share="off"'],
  ['⑦ 测试区二维码被错误带进正式区', 'utils/member-environment.js', "const next = /^p[0-9a-f]{31}$/.test(value) ? PRODUCTION : SANDBOX", "const next = PRODUCTION"],
  ['⑧ 领取后约课读取仍退回旧 OPENID 编号', 'cloudfunctions/coachBusinessSandboxCommand/member-identity.js', 'return { memberId: String(row.memberId), memberRow: row, source: \'directory\' }', 'return { memberId: legacyMemberId, memberRow: null, source: \'legacy\' }'],
  ['⑨ 预约提交不再读取专属会员位置', 'cloudfunctions/coachBusinessSandboxCommand/member-identity.js', "async function resolveMemberScopes({ db, environment, memberId, memberRow, claimsCollection }) {\n  if (String(environment || '').toLowerCase() === 'sandbox') {", "async function resolveMemberScopes({ db, environment, memberId, memberRow, claimsCollection }) {\n  if (false && String(environment || '').toLowerCase() === 'sandbox') {"],
  ['⑩ 主动换码失效', 'cloudfunctions/coachBusinessSandboxCommand/member-directory.js', 'return getMemberClaimQr({ ...options, forceRotate: true })', 'return getMemberClaimQr({ ...options, forceRotate: false })'],
  ['⑪ 永久码又被按过期时间拒绝', 'cloudfunctions/coachBusinessSandboxCommand/member-directory.js', 'if (row.permanent !== true && (!Number.isFinite(Number(row.expiresAt)) || Number(row.expiresAt) <= Number(now)))', 'if (true && (!Number.isFinite(Number(row.expiresAt)) || Number(row.expiresAt) <= Number(now)))'],
  ['⑫ 二维码首屏重新等待临时链接', 'utils/member-directory.js', 'const claimReady = { ...result, imageUrl: result.fileID }', 'const claimReady = await withTempImage(result)']
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
