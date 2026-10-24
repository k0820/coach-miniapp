// 判别力反证：所有源码变异只进入内存覆盖层，不写生产文件。
const overlay = require('./helpers/mutate-overlay').install()
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')
const test = path.join(__dirname, 'coach-member-detail-ui-refresh.test.js')
const mutations = [
  ['恢复课包卡片套卡片', 'pages/students/students.wxss', '.pkg-collapsed{padding:0', '.pkg-collapsed{padding:20rpx'],
  ['二维码重新放大占屏', 'pages/coach-member-qr/coach-member-qr.wxss', 'width:428rpx;height:428rpx', 'width:560rpx;height:560rpx'],
  ['移除二维码转发', 'pages/coach-member-qr/coach-member-qr.wxml', 'open-type="share"', 'data-share="off"'],
  ['移除资料总保存入口', 'pages/students/students.wxml', 'bindtap="save"', 'data-save="off"']
]

;(async () => {
  const base = await overlay.runTest(test)
  if (!base.ok) throw new Error('基准测试不是绿的：\n' + base.tail)
  for (const [name, file, from, to] of mutations) {
    const full = path.join(ROOT, file)
    const source = fs.readFileSync(full, 'utf8')
    const hits = source.split(from).length - 1
    if (hits !== 1) throw new Error(`${name}：锚点命中 ${hits} 次（应为 1 次）`)
    fs.writeFileSync(full, source.replace(from, to), 'utf8')
    const result = await overlay.runTest(test)
    if (result.ok) throw new Error(`${name} 没有被专项测试抓住`)
    console.log('PASS mutation', name)
    overlay.clear()
  }
  console.log(`${mutations.length}/${mutations.length} mutations caught`)
})().catch(error => { console.error(error); process.exitCode = 1 })
