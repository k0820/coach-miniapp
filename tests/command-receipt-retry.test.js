const assert = require('assert')
const { createWorld } = require('./helpers/sandbox-command-world')

async function run() {
  const world = createWorld()
  const adapter = world.ui.adapter
  assert.equal((await adapter.readActive()).ok, true)

  let receiptCalls = 0
  world.beforeCall = call => {
    if (call.name === 'coachBusinessCommand' && call.data.action === 'getReceipt') {
      receiptCalls++
      if (receiptCalls === 1) throw new Error('isolated receipt transport interruption')
    }
  }
  world.afterCall = call => {
    if (call.name === 'coachBusinessCommand' && call.data.action === 'execute') throw new Error('isolated execute response lost')
  }
  const recovered = await adapter.execute('createStudent', { name: '隔离回执甲' }, { requestId: 'isolated-delete-receipt-recovery' })
  assert.equal(recovered.ok, true, JSON.stringify(recovered))
  assert.equal(recovered.recoveredFromReceipt, true)
  assert.equal(receiptCalls, 2, '第一次查单中断后，只重查回执')
  assert.equal(world.executeCalls('createStudent').length, 1, '业务命令绝不补发')

  world.beforeCall = call => {
    if (call.name === 'coachBusinessCommand' && call.data.action === 'getReceipt') throw new Error('isolated receipts unavailable')
  }
  const unknown = await adapter.execute('createStudent', { name: '隔离回执乙' }, { requestId: 'isolated-still-unknown' })
  assert.equal(unknown.code, 'COMMAND_RESULT_UNKNOWN')
  assert.equal(unknown.requestId, 'isolated-still-unknown')
  assert.equal(unknown.retrySafe, true)
  assert.equal(world.executeCalls('createStudent').length, 2, '回执仍查不到时也不重发第二条命令')
  console.log('command receipt retry PASS: delayed receipt recovery without duplicate business writes')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
