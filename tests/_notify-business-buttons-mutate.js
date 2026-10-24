// 判别力反证：教练端提醒必须保留；会员端任何重新出现的订阅弹窗都必须被抓住。
// mutate-overlay 会拦截下方 writeFileSync，所有变异只存在内存，不改磁盘源码。
'use strict'
const overlay = require('./helpers/mutate-overlay')
overlay.install()
const fs = require('fs')
const path = require('path')

const PROJ = path.join(__dirname, '..')
const TEST = path.join(__dirname, 'notify-business-buttons.test.js')
const FILES = {
  booking: path.join(PROJ, 'components', 'booking-modal', 'booking-modal.js'),
  session: path.join(PROJ, 'pages', 'session', 'session.js'),
  slots: path.join(PROJ, 'pages', 'member-book-slots', 'member-book-slots.js'),
  bookings: path.join(PROJ, 'pages', 'member-bookings', 'member-bookings.js'),
  claim: path.join(PROJ, 'pages', 'member-claim', 'member-claim.js'),
  home: path.join(PROJ, 'pages', 'member-home', 'member-home.js')
}

const MUTATIONS = [
  { name: '教练排课漏掉下一条提醒', file: FILES.booking, from: "notifyConsent.requestNextAfterAction('coach', { quiet: true })", to: '' },
  { name: '教练取消和改期漏掉下一条提醒', file: FILES.session, from: "notifyConsent.requestNextAfterAction('coach',{quiet:true})", to: '' },
  { name: '会员预约重新弹提醒', file: FILES.slots, from: 'return this.runSubmit(request)', to: "notifyConsent.requestNextAfterAction('member', { quiet: true }); return this.runSubmit(request)" },
  { name: '会员取消重新弹提醒', file: FILES.bookings, from: 'if (resolve) return resolve(true)', to: "if (resolve) { notifyConsent.requestNextAfterAction('member', { quiet: true }); return resolve(true) }" },
  { name: '会员首次领取重新弹提醒', file: FILES.claim, from: "this.setData({ busy: true, errorText: '' })", to: "notifyConsent.requestConsent('member'); this.setData({ busy: true, errorText: '' })" },
  { name: '会员首页重新显示提醒', file: FILES.home, from: '  go(url) { wx.navigateTo({ url }) },', to: "  allowNextNotification() { return notifyConsent.requestConsent('member') },\n  go(url) { wx.navigateTo({ url }) }," },
  { name: '通知授权被 await 后阻塞业务', file: FILES.booking, from: "notifyConsent.requestNextAfterAction('coach', { quiet: true })", to: "await notifyConsent.requestNextAfterAction('coach', { quiet: true })" }
]

;(async () => {
  const originals = new Map(Object.values(FILES).map(file => [file, fs.readFileSync(file, 'utf8')]))
  const restore = () => originals.forEach((content, file) => fs.writeFileSync(file, content, 'utf8'))
  const base = await overlay.runTest(TEST)
  if (!base.ok) throw new Error('基准测试不是绿的：\n' + base.tail)
  console.log('基准：PASS')
  let red = 0
  for (const mutation of MUTATIONS) {
    restore()
    const source = fs.readFileSync(mutation.file, 'utf8')
    if (!source.includes(mutation.from)) throw new Error(`${mutation.name}：找不到变异锚点`)
    fs.writeFileSync(mutation.file, source.split(mutation.from).join(mutation.to), 'utf8')
    const result = await overlay.runTest(TEST)
    if (!result.ok) { red += 1; console.log(`  ✅ 变红：${mutation.name}`) }
    else console.log(`  ⛔ 假绿：${mutation.name}`)
  }
  restore()
  const final = await overlay.runTest(TEST)
  if (!final.ok) throw new Error('还原后基准变红：\n' + final.tail)
  console.log(`还原后基准：PASS；判别力：${red}/${MUTATIONS.length} 全红`)
  if (red !== MUTATIONS.length) process.exitCode = 1
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
