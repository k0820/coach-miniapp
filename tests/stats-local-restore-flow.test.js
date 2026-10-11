const assert = require('assert')

const snapshot = label => ({
  students: [{ id: `student-${label}`, name: '测试学员', packages: [{ id: `package-${label}`, type: '常规训练', total: 10, used: 1, remaining: 9, price: 300 }] }],
  bookings: [{ id: `booking-${label}`, studentId: `student-${label}`, packageId: `package-${label}`, status: 'done', items: [] }],
  incomes: [{ id: `income-${label}`, bookingId: `booking-${label}`, studentId: `student-${label}`, amount: 300 }],
  sales: [{ id: `sale-${label}`, source: 'course', studentId: `student-${label}`, packageId: `package-${label}`, date: '2026-09-01', amount: 3000 }],
  customExercises: [],
  settings: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 30, salesCommissionRate: 5 }
})

let pageDefinition
global.Page = definition => { pageDefinition = definition }
global.wx = {}
require('../pages/stats/stats.js')

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const settle = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)))

function scenario({ confirmations = [], backup = snapshot('backup'), current = snapshot('current'), failSafety = false, corruptRestore = false } = {}) {
  const values = { coachDB: clone(current), coachDBBackup: clone(backup) }
  const writes = [], calls = [], modals = [], answers = confirmations.slice()
  let coachWrites = 0, renders = 0
  global.wx = {
    getStorageSync: key => clone(values[key]),
    setStorageSync: (key, value) => {
      writes.push(key)
      if (failSafety && key === 'coachDBRestoreSafetyBackup') throw new Error('storage full')
      values[key] = clone(value)
      if (key === 'coachDB') {
        coachWrites++
        if (corruptRestore && coachWrites === 1) values[key].students[0].name = '写入损坏'
      }
    },
    showToast(options) { calls.push(`toast:${options.title}`) },
    showModal(options) {
      modals.push(options.title)
      if (options.success) options.success({ confirm: answers.length ? answers.shift() : false })
    },
    cloud: { callFunction() { calls.push('cloud') } }
  }
  const page = { ...pageDefinition, data: clone(pageDefinition.data) }
  page.setData = patch => Object.assign(page.data, patch)
  page.render = () => { renders++ }
  return { page, values, writes, calls, modals, renders: () => renders }
}

async function run() {
  let s = scenario({ confirmations: [false] })
  s.page.restoreLocal(); await settle()
  assert.deepStrictEqual(s.writes, [])
  assert.strictEqual(s.values.coachDB.students[0].id, 'student-current')

  s = scenario({ confirmations: [true, false] })
  s.page.restoreLocal(); await settle()
  assert.deepStrictEqual(s.writes, ['coachDBRestoreSafetyBackup'])
  assert.strictEqual(s.values.coachDB.students[0].id, 'student-current')

  s = scenario({ confirmations: [true, true] })
  s.page.restoreLocal(); await settle()
  assert.deepStrictEqual(s.writes, ['coachDBRestoreSafetyBackup', 'coachDB'])
  assert.strictEqual(s.values.coachDB.students[0].id, 'student-backup')
  assert.strictEqual(s.renders(), 1)

  s = scenario({ confirmations: [true, true], failSafety: true })
  s.page.restoreLocal(); await settle()
  assert.strictEqual(s.writes.includes('coachDB'), false)
  assert.strictEqual(s.values.coachDB.students[0].id, 'student-current')

  s = scenario({ confirmations: [true, true], corruptRestore: true })
  s.page.restoreLocal(); await settle()
  assert.deepStrictEqual(s.writes, ['coachDBRestoreSafetyBackup', 'coachDB', 'coachDB'])
  assert.strictEqual(s.values.coachDB.students[0].id, 'student-current')
  assert.strictEqual(s.modals.includes('已安全回滚'), true)

  s = scenario({ backup: { students: 'broken' }, confirmations: [true, true] })
  s.page.restoreLocal(); await settle()
  assert.deepStrictEqual(s.writes, [])
  assert.strictEqual(s.modals.includes('恢复已停止'), true)

  assert.strictEqual(s.calls.includes('cloud'), false)
  console.log('stats local restore flow tests: PASS (18 checks)')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
