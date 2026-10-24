// 教练端会员详情收口：减少卡片套卡片，同时保留原业务入口。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')
const students = read('pages/students/students.wxml')
const studentsCss = read('pages/students/students.wxss').replace(/\/\*[\s\S]*?\*\//g, '')
const qr = read('pages/coach-member-qr/coach-member-qr.wxml')
const qrCss = read('pages/coach-member-qr/coach-member-qr.wxss').replace(/\/\*[\s\S]*?\*\//g, '')

assert.ok(/class="editor-section qr-entry" bindtap="openDedicatedMemberQr"/.test(students),
  '二维码应是一整行可点击入口，不能再套一张独立大卡')
assert.ok(/课包与剩余课程/.test(students), '课包区标题应同时说明课包和剩余课程')
assert.ok(/pkg-collapsed/.test(students), '未展开的课包必须标记为紧凑态')
assert.ok(/\.member-editor \.pkg-form\.package-detail\.pkg-collapsed\{[^}]*padding:0[^}]*border:0/.test(studentsCss),
  '紧凑课包外层必须去掉 padding 和边框，避免卡片套卡片')
assert.ok(/\.member-editor \.editor-section\{[^}]*background:transparent[^}]*border-bottom:1rpx/.test(studentsCss),
  '会员详情应使用连续分区和分隔线，不能每一段都悬浮成卡片')

assert.ok(qrCss.includes('@import "../../styles/member.wxss";'), '二维码页必须复用已安装的统一设计样式')
const qrSize = /\.qr-frame\{[^}]*width:([\d.]+)rpx[^}]*height:([\d.]+)rpx/.exec(qrCss)
assert.ok(qrSize && Number(qrSize[1]) <= 460 && Number(qrSize[2]) <= 460,
  '二维码主体必须收小到 460rpx 以内，不能继续占满屏幕')
assert.ok(/\.qr-actions\{[^}]*grid-template-columns:1fr 1fr/.test(qrCss),
  '转发和保存应并排显示，减少纵向滚动')
assert.ok(qr.includes('open-type="share"') && qr.includes('bindtap="saveImage"'),
  '转发与保存功能必须保留')
assert.ok(qr.includes('bindtap="openRotate"') && qr.includes('bindtap="openUnbind"'),
  '换码与解除绑定功能必须保留')
assert.ok(students.includes('bindtap="save"') && students.includes('保存资料与课程'),
  '资料和课程的总保存入口必须保留')

console.log('coach member detail UI refresh tests: PASS')
