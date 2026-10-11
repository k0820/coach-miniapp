// 判别力反证（§200 · 常用按钮已经撤下一次性微信订阅）。
// ⛔ 只用 mutate-overlay 在内存里改坏源码，绝不写盘污染工程。
require('./helpers/mutate-overlay').install()
const fs = require('fs'), path = require('path'), { Worker } = require('worker_threads')
const PROJ = path.join(__dirname, '..')
const TEST = path.join(__dirname, 'notify-business-buttons.test.js')
const BOOKING = path.join(PROJ, 'components', 'booking-modal', 'booking-modal.js')
const SESSION = path.join(PROJ, 'pages', 'session', 'session.js')
const MEMBER_BOOK = path.join(PROJ, 'pages', 'member-book-slots', 'member-book-slots.js')
const MEMBER_MANAGE = path.join(PROJ, 'pages', 'member-bookings', 'member-bookings.js')

const MUTATIONS = [
  {
    name: '① 教练共享排课重新绑上一次性订阅 ⇒ 必须变红',
    file: BOOKING,
    from: `return await mutate(null, null, {`,
    to: `return await notifyConsent.runBusinessTap('coach', () => mutate(null, null, {`
  },
  {
    name: '② 教练普通排课重新绑上一次性订阅 ⇒ 必须变红',
    file: BOOKING,
    from: `const result = await mutate('createBooking', {`,
    to: `const result = await notifyConsent.runBusinessTap('coach', () => mutate('createBooking', {`
  },
  {
    name: '③ 教练取消重新绑上一次性订阅 ⇒ 必须变红',
    file: SESSION,
    from: `cancelOnly(){if(this.data.done)return;return this.cancel(false)}`,
    to: `cancelOnly(){if(this.data.done)return;return notifyConsent.runBusinessTap('coach',()=>this.cancel(false))}`
  },
  {
    name: '④ 会员预约重新绑上一次性订阅 ⇒ 必须变红',
    file: MEMBER_BOOK,
    from: `return this.runSubmit(request)`,
    to: `return notifyConsent.runBusinessTap('member', () => this.runSubmit(request))`
  },
  {
    name: '⑤ 会员取消重新绑上一次性订阅 ⇒ 必须变红',
    file: MEMBER_MANAGE,
    from: `if (resolve) return resolve(true)`,
    to: `if (resolve) return notifyConsent.runBusinessTap('member', () => resolve(true))`
  }
]

function runTest() {
  return new Promise(resolve => {
    const worker = new Worker(TEST, { stdout: true, stderr: true })
    let tail = ''
    worker.stdout.on('data', chunk => { tail += String(chunk) })
    worker.stderr.on('data', chunk => { tail += String(chunk) })
    worker.on('error', error => resolve({ code: 1, tail: tail + String(error && error.stack || error) }))
    worker.on('exit', code => resolve({ code, tail }))
  })
}

;(async () => {
  const files = [...new Set(MUTATIONS.map(item => item.file))]
  const originals = new Map(files.map(file => [file, fs.readFileSync(file, 'utf8')]))
  const restore = () => originals.forEach((text, file) => fs.writeFileSync(file, text, 'utf8'))
  try {
    const base = await runTest()
    if (base.code !== 0) throw new Error('基准测试不是绿的：\n' + base.tail)
    console.log('基准：PASS')
    let red = 0
    for (const mutation of MUTATIONS) {
      restore()
      const source = fs.readFileSync(mutation.file, 'utf8')
      const hits = source.split(mutation.from).length - 1
      if (hits !== 1) throw new Error(`${mutation.name}：锚点命中 ${hits} 次（应为 1 次）`)
      fs.writeFileSync(mutation.file, source.replace(mutation.from, mutation.to), 'utf8')
      const result = await runTest()
      if (result.code !== 0) { console.log(`  ✅ 变红：${mutation.name}`); red += 1 }
      else console.log(`  ⛔ 假绿：${mutation.name}`)
    }
    restore()
    const final = await runTest()
    if (final.code !== 0) throw new Error('还原后基准变红：\n' + final.tail)
    console.log('还原后基准：PASS ✅')
    console.log(`判别力：${red}/${MUTATIONS.length} 全红`)
    if (red !== MUTATIONS.length) process.exit(1)
  } finally { restore() }
})().catch(error => { console.error('FATAL ' + error.stack); process.exit(1) })
