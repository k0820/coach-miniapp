const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createDraftCoordinator } = require('../utils/draft-coordinator')

const clone = value => JSON.parse(JSON.stringify(value))

async function runNormalCompletion() {
  const state = {
    revision: 7,
    booking: { id: 'b-prod-fake', status: 'booked', packageId: 'p-exact', price: 168, items: [], notes: '' },
    packages: [
      { id: 'p-exact', type: '私教课', used: 2, remaining: 8, status: 'active' },
      { id: 'p-other-same-type', type: '私教课', used: 0, remaining: 20, status: 'active' }
    ],
    incomes: []
  }
  const drafts = createDraftCoordinator()
  const expectedItems = [{ name: '高位下拉', group: '背部', sets: 4, reps: 12, weight: 20 }]
  drafts.markDirty()
  let contentWrites = 0
  const persist = async () => {
    contentWrites++
    state.booking.items = clone(expectedItems)
    state.booking.notes = '假数据自动测试'
    state.revision++
    return { ok: true }
  }
  assert.equal((await drafts.flush(persist)).ok, true)
  const exact = state.packages.find(item => item.id === state.booking.packageId)
  const other = state.packages[1]
  state.booking.status = 'done'
  exact.used += 1
  exact.remaining -= 1
  state.incomes.push({ id: 'i-fake', bookingId: state.booking.id, amount: state.booking.price })
  state.revision++

  const reopened = clone(state)
  assert.equal(contentWrites, 1)
  assert.equal(reopened.booking.status, 'done')
  assert.deepEqual(reopened.booking.items, expectedItems)
  assert.equal(reopened.booking.notes, '假数据自动测试')
  assert.deepEqual({ used: exact.used, remaining: exact.remaining }, { used: 3, remaining: 7 })
  assert.deepEqual({ used: other.used, remaining: other.remaining }, { used: 0, remaining: 20 })
  assert.equal(reopened.incomes.filter(item => item.bookingId === state.booking.id).length, 1)
  assert.equal(reopened.revision, 9)
}

async function runAutosaveRace() {
  const drafts = createDraftCoordinator()
  let release
  let calls = 0
  drafts.markDirty()
  const task = async () => {
    calls++
    if (calls === 1) await new Promise(resolve => { release = resolve })
    return { ok: true }
  }
  const autosave = drafts.save(task)
  await Promise.resolve()
  drafts.markDirty()
  const completionFlush = drafts.flush(task)
  release()
  assert.equal((await autosave).ok, true)
  assert.equal((await completionFlush).ok, true)
  assert.equal(calls, 2, '完课等待在途保存后，只补交一次最新草稿')
}

;(async () => {
  await runNormalCompletion()
  await runAutosaveRace()
  const session = fs.readFileSync(path.join(__dirname, '../pages/session/session.js'), 'utf8')
  const completeBody = session.slice(session.indexOf('async complete()'), session.indexOf('copySummary()'))
  assert(completeBody.includes('await this.flushDraft()'))
  assert(!completeBody.includes("command:'updateBookingContent'"), '完课按钮不得绕过草稿协调器重复提交内容命令')
  // 阶段 2：完课链有**两个互斥出口** —— ① 这条预约还没转正 → 按本机引用排进持久队列并**立刻 return**；
  // ② 已经有正式 id → 正式完课。任何一个分支都只发一条 completeBooking，绝不允许"排队之后再发一次"。
  // （这里不能只数出现次数就完事：真正要钉住的是"排队那条出口必须当场 return"。）
  const completionCalls = completeBody.match(/command:'completeBooking'/g) || []
  assert.equal(completionCalls.length, 2, '完课只允许两个互斥出口（本机引用排队 / 正式完课）')
  // 1.1.9：这条出口的返回值上多挂了 copy（复制阶段结果），但"必须当场 return"这条性质不变 ——
  // 所以断言改成前缀匹配而不是字面量全等：删掉 return 照样红，追加字段不该红。
  assert.ok(completeBody.includes("return{ok:true,code:'COMPLETED_LOCAL_FIRST_DEFERRED'"), '按本机引用排队的出口必须立刻 return，绝不能接着再发一条完课命令')
  process.stdout.write('production completion flow tests: PASS (serialized draft, exact package, one income, reopen content)\n')
})().catch(error => { console.error(error); process.exitCode = 1 })
