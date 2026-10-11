const assert = require('assert')
const { createService, NAMES, coachIdFor } = require('../cloudfunctions/coachBusinessCommandTest/core')

const copy = value => JSON.parse(JSON.stringify(value))
const stores = Object.fromEntries(Object.values(NAMES).map(name => [name, new Map()]))

function makeScope(target) {
  return {
    collection(name) {
      if (!target[name]) target[name] = new Map()
      const collection = {
        doc(id) {
          return {
            async get() { if (!target[name].has(id)) throw new Error('not found'); return { data: copy(target[name].get(id)) } },
            async set({ data }) { target[name].set(id, copy({ ...data, _id: id })); return { _id: id } },
            async remove() { target[name].delete(id); return { stats: { removed: 1 } } }
          }
        },
        where(query) {
          let cap = Infinity
          const api = {
            limit(value) { cap = value; return api },
            async get() { return { data: [...target[name].values()].filter(row => Object.keys(query).every(key => row[key] === query[key])).slice(0, cap).map(copy) } }
          }
          return api
        }
      }
      return collection
    }
  }
}

let transactionQueue = Promise.resolve()
const db = {
  ...makeScope(stores),
  runTransaction(work) {
    const run = transactionQueue.then(async () => {
      const draft = Object.fromEntries(Object.entries(stores).map(([name, rows]) => [name, new Map([...rows].map(([id, row]) => [id, copy(row)]))]))
      const response = await work(makeScope(draft))
      for (const name of Object.keys(stores)) { stores[name].clear(); for (const [id, row] of draft[name]) stores[name].set(id, copy(row)) }
      return response
    })
    transactionQueue = run.catch(() => {})
    return run
  }
}

let currentOpenId = 'openid-a', clock = 1800000000000
const main = createService({ db, getOpenId: () => currentOpenId, now: () => ++clock })
const cmd = (command, requestId, expectedRevision, payload) => ({ action: 'execute', envelope: { command, requestId, expectedRevision, payload } })
const read = () => main({ action: 'read' })
const reset = () => main({ action: 'reset' })

async function test(name, fn) {
  try { await fn(); process.stdout.write(`PASS ${name}\n`) } catch (e) { process.stderr.write(`FAIL ${name}: ${e.stack}\n`); process.exitCode = 1 }
}

;(async () => {
  await test('completeBooking 在模拟 CloudBase 事务中原子成功', async () => {
    await reset()
    const response = await main(cmd('completeBooking', 'complete_success_001', 0, { bookingId: 'booking-complete', items: [{ name: '卧推' }] })), state = await read()
    assert.equal(response.ok, true); assert.equal(state.dataRevision, 1)
    assert.deepEqual(state.packages.find(x => x.packageId === 'package-paid'), { packageId: 'package-paid', used: 3, remaining: 7, status: 'active' })
    assert.equal(state.bookings.find(x => x.bookingId === 'booking-complete').status, 'done'); assert.equal(state.incomes.filter(x => x.bookingId === 'booking-complete').length, 1)
  })

  await test('income 写入失败时 booking/package/receipt/revision 全部回滚', async () => {
    await reset(); const before = await read()
    const response = await main({ ...cmd('completeBooking', 'complete_failure_001', 0, { bookingId: 'booking-complete' }), failAt: 'income' }), after = await read()
    assert.equal(response.code, 'INJECTED_INCOME_FAILURE'); assert.deepEqual(after, before)
  })

  await test('同 requestId 网络重试返回首次结果且不重复扣课或 income', async () => {
    await reset(); const request = cmd('completeBooking', 'network_retry_001', 0, { bookingId: 'booking-complete' })
    const first = await main(request), retry = await main(request), state = await read()
    assert.equal(first.ok, true); assert.equal(retry.ok, true); assert.equal(retry.idempotent, true); assert.equal(state.dataRevision, 1)
    assert.equal(state.packages.find(x => x.packageId === 'package-paid').remaining, 7); assert.equal(state.incomes.filter(x => x.bookingId === 'booking-complete').length, 1)
  })

  await test('相同 requestId 不同 payload 返回 REQUEST_ID_CONFLICT', async () => {
    await reset(); await main(cmd('completeBooking', 'payload_conflict_001', 0, { bookingId: 'booking-complete', items: [{ name: 'A' }] }))
    const response = await main(cmd('completeBooking', 'payload_conflict_001', 0, { bookingId: 'booking-complete', items: [{ name: 'B' }] }))
    assert.equal(response.code, 'REQUEST_ID_CONFLICT')
  })

  await test('两个客户端同 revision 并发仅一个成功', async () => {
    await reset()
    const [one, two] = await Promise.all([
      main(cmd('completeBooking', 'parallel_device_a', 0, { bookingId: 'booking-complete' })),
      main(cmd('completeBooking', 'parallel_device_b', 0, { bookingId: 'booking-complete' }))
    ])
    assert.equal([one, two].filter(x => x.ok).length, 1); assert.equal([one, two].find(x => !x.ok).code, 'REVISION_CONFLICT')
    const state = await read(); assert.equal(state.incomes.filter(x => x.bookingId === 'booking-complete').length, 1); assert.equal(state.dataRevision, 1)
  })

  await test('A 与 B 的确定性测试命名空间完全隔离', async () => {
    currentOpenId = 'openid-a'; await reset(); await main(cmd('completeBooking', 'owner_a_complete', 0, { bookingId: 'booking-complete' })); const a = await read()
    currentOpenId = 'openid-b'; const beforeSeed = await main(cmd('completeBooking', 'owner_b_cross_try', 0, { bookingId: 'booking-complete' })); assert.equal(beforeSeed.code, 'TEST_STATE_NOT_FOUND')
    await reset(); const b = await read()
    assert.notEqual(a.ownerCoachId, b.ownerCoachId); assert.equal(a.dataRevision, 1); assert.equal(b.dataRevision, 0); assert.equal(b.incomes.length, 1)
    currentOpenId = 'openid-a'; const again = await read(); assert.equal(again.dataRevision, 1); assert.equal(again.incomes.filter(x => x.bookingId === 'booking-complete').length, 1)
  })

  await test('伪造 OPENID/coach/owner/documentId 全部拒绝且不改变数据', async () => {
    currentOpenId = 'openid-a'; await reset(); const before = await read()
    for (const forged of [{ OPENID: 'openid-b' }, { coachId: 'x' }, { ownerCoachId: 'x' }, { documentId: 'x' }]) {
      const response = await main({ ...cmd('completeBooking', `forged_${Object.keys(forged)[0]}`, 0, { bookingId: 'booking-complete' }), ...forged })
      assert.equal(response.code, 'FORBIDDEN_IDENTITY_INPUT')
    }
    assert.deepEqual(await read(), before)
  })

  await test('CloudBase 自动注入 event.userInfo.openId 不阻止正常调用且不参与身份', async () => {
    currentOpenId = 'openid-a'
    const response = await main({ action: 'reset', userInfo: { openId: 'runtime-or-forged-value', appId: 'runtime-app' } })
    assert.equal(response.ok, true)
    assert.equal(response.ownerCoachId, coachIdFor('openid-a'))
    assert.notEqual(response.ownerCoachId, coachIdFor('runtime-or-forged-value'))
  })

  await test('业务输入内嵌 userInfo.openId 仍被拒绝', async () => {
    currentOpenId = 'openid-a'; await reset(); const before = await read()
    const response = await main({ action: 'execute', envelope: { command: 'completeBooking', requestId: 'nested_identity_001', expectedRevision: 0, payload: { bookingId: 'booking-complete', userInfo: { openId: 'openid-b' } } } })
    assert.equal(response.code, 'FORBIDDEN_IDENTITY_INPUT')
    assert.deepEqual(await read(), before)
  })

  await test('reverseCourseSale 中途失败整体回滚', async () => {
    await reset(); const before = await read()
    const response = await main({ ...cmd('reverseCourseSale', 'reverse_failure_001', 0, { saleId: 'sale-reverse' }), failAt: 'reverseBookings' })
    assert.equal(response.code, 'INJECTED_REVERSE_FAILURE'); assert.deepEqual(await read(), before)
  })

  await test('部分使用销售撤销后历史 done/income 保留且未来预约删除', async () => {
    await reset(); const response = await main(cmd('reverseCourseSale', 'reverse_success_001', 0, { saleId: 'sale-reverse' })), state = await read()
    assert.equal(response.ok, true); assert.equal(state.sales.find(x => x.saleId === 'sale-reverse').status, 'reversed')
    assert.deepEqual(state.packages.find(x => x.packageId === 'package-reverse'), { packageId: 'package-reverse', used: 2, remaining: 0, status: 'reversed' })
    assert(state.bookings.some(x => x.bookingId === 'booking-history' && x.status === 'done')); assert(!state.bookings.some(x => x.bookingId === 'booking-future')); assert(state.incomes.some(x => x.incomeId === 'income-history'))
  })

  await test('cleanup 只删除当前 OPENID 的测试数据', async () => {
    currentOpenId = 'openid-a'; await reset(); currentOpenId = 'openid-b'; await reset(); await main({ action: 'cleanup' }); const b = await read()
    assert.equal(b.dataRevision, null); currentOpenId = 'openid-a'; const a = await read(); assert.equal(a.dataRevision, 0)
  })

  await test('云函数源码仅引用 coach_command_test_ 集合且使用 runTransaction/可信 OPENID', async () => {
    const fs = require('fs'), source = fs.readFileSync(require.resolve('../cloudfunctions/coachBusinessCommandTest/index'), 'utf8') + fs.readFileSync(require.resolve('../cloudfunctions/coachBusinessCommandTest/core'), 'utf8')
    for (const formal of ['students', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']) assert(!new RegExp(`collection\\(['\"]${formal}['\"]\\)`).test(source))
    assert(source.includes('cloud.getWXContext().OPENID')); assert(source.includes('db.runTransaction')); assert(!/event\.(OPENID|openId|coachId|ownerCoachId|documentId)/.test(source))
  })

  await test('未读取或修改真实 coachDB', async () => {
    const fs = require('fs'), source = fs.readFileSync(require.resolve('../cloudfunctions/coachBusinessCommandTest/core'), 'utf8')
    assert(!source.includes('coachDB')); assert(!source.includes('wx.getStorage')); assert(!source.includes('wx.setStorage'))
  })

  if (!process.exitCode) process.stdout.write('ALL ISOLATED CLOUD COMMAND TESTS PASSED\n')
})()
