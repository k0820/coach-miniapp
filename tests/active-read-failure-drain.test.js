const assert = require('assert')
const { createAdapter } = require('../utils/cloud-primary-adapter')

async function run() {
  let release, entered, activePages = 0, commandStarted = false
  const blocked = new Promise(resolve => { release = resolve })
  const arrived = new Promise(resolve => { entered = resolve })
  let pages = 0
  const adapter = createAdapter({ environment: () => 'sandbox', storage: { get() {}, set() {} }, callCloud: async (name, data) => {
    if (name === 'coachBusinessCommand') { commandStarted = true; return { ok: false, code: 'TEST_BUSINESS_REJECTION' } }
    if (data.action === 'metadata') return { ok: true, collections: ['students', 'packages', 'bookings'], environment: 'sandbox' }
    if (data.action === 'page') {
      const index = ++pages
      if (index === 1) { await arrived; throw new Error('injected transport interruption') }
      activePages++; entered()
      await blocked
      activePages--
      return { ok: true, done: true, payload: '' }
    }
    throw new Error('unexpected read phase')
  } })
  let readSettled = false
  const read = adapter.readActive().catch(error => { readSettled = true; return error })
  await arrived
  const write = adapter.execute('saveSettings', {}, { requestId: 'drain_test_write', expectedRevision: 0 })
  await new Promise(resolve => setTimeout(resolve, 10))
  const escaped = readSettled || commandStarted
  release()
  await Promise.all([read, write])
  assert.equal(escaped, false, '一个分页拒绝后，其他在途分页结束前不能释放回读锁或开始下一条写入')
  assert.equal(activePages, 0)
  assert.equal(pages, 2, '失败后不要继续启动剩余集合')
  assert.equal(commandStarted, true, '收尾后必须释放锁，不能死锁')
  console.log('active read failure drain PASS: failed read retains serialization until outstanding pages settle')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
