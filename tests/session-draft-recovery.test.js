const assert = require('assert')
const copy = value => JSON.parse(JSON.stringify(value))
const store = { coachSandboxActiveCache: { datasetId: 'fake-dataset' } }
const cloud = { students: [{ id: 'student', name: '假学员', packages: [{ id: 'package', type: '常规训练', remaining: 2, used: 0 }] }], bookings: [{ id: 'booking', studentId: 'student', packageId: 'package', typeName: '常规训练', price: 100, date: '2026-09-16', hour: 16, status: 'booked', items: [], notes: '' }], incomes: [] }
const copyCloud = () => copy(cloud)
let savedRequests = [], contentCalls = 0, completeCalls = 0, responseMode = 'success', receiptStatus = 'unknown', captured
const runtimePath = require.resolve('../utils/data-runtime'), commandPath = require.resolve('../utils/ui-cloud-command')
const oldRuntime = require.cache[runtimePath], oldCommand = require.cache[commandPath]
global.wx = { getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = copy(value) }, showModal() {}, showToast() {}, showLoading() {}, hideLoading() {}, navigateBack() {} }
require.cache[runtimePath] = { id: runtimePath, filename: runtimePath, loaded: true, exports: { getDB: copyCloud, saveDB: () => { throw new Error('local coachDB write') }, uid: () => 'local', timeStr: booking => `${booking.hour}:00`, cacheKey: () => 'coachSandboxActiveCache', environment: () => 'sandbox' } }
const adapter = { getState: () => ({ datasetId: 'fake-dataset' }), getReceipt: async () => ({ ok: true, found: receiptStatus !== 'unknown', status: receiptStatus }), readActive: async () => ({ ok: true }) }
async function runCommand({ command, payload, requestId }) {
  if (command === 'updateBookingContent') {
    contentCalls++; savedRequests.push(requestId)
    if (responseMode === 'unknown') return { ok: false, code: 'COMMAND_RESULT_UNKNOWN' }
    if (responseMode === 'fail') return { ok: false, code: 'INJECTED_CLOUD_FAILURE' }
    Object.assign(cloud.bookings[0], copy(payload)); delete cloud.bookings[0].bookingId
    return { ok: true, refreshed: { ok: true } }
  }
  if (command === 'completeBooking') { completeCalls++; cloud.bookings[0].status = 'done'; cloud.students[0].packages[0].remaining--; cloud.students[0].packages[0].used++; cloud.incomes.push({ id: 'income', bookingId: 'booking' }); return { ok: true, refreshed: { ok: true } } }
  throw new Error('unexpected command')
}
require.cache[commandPath] = { id: commandPath, filename: commandPath, loaded: true, exports: { isCloudPrimary: () => true, runCommand, runCommandSilent: runCommand, adapter, clearPending() {}, operationId: key => `fixed-${key}`, officialIdForBooking: () => '', awaitOfficialBooking: async () => '', subscribePendingBookings: () => () => {}, bindingForOfficialId: () => null, pendingBookingRecords: () => [], notifyPendingBookings() {} } }
global.Page = page => { captured = page }
require('../pages/session/session')
function page() { const object = { data: copy(captured.data), setData(patch, cb) { Object.assign(this.data, patch); if (cb) cb() } }; for (const [name, fn] of Object.entries(captured)) if (typeof fn === 'function') object[name] = fn.bind(object); object.onLoad({ id: 'booking' }); object.onShow(); return object }
;(async () => {
  let session = page()
  session.addExercise({ detail: { name: '假动作', group: '背部' } })
  assert.equal(cloud.bookings[0].items.length, 0)
  session.back()
  const reopened = page()
  assert.equal(reopened.data.items.length, 1, 'old cloud/cache must not erase pending edit')
  assert.equal(reopened.data.draftPending, true)
  responseMode = 'unknown'
  const first = await session.flushDraft()
  assert.equal(first.ok, false)
  assert.equal(contentCalls, 1)
  assert.equal(completeCalls, 0)
  const blocked = await reopened.complete()
  // 现在 complete() 第一帧就返回句柄，后台链自行跑完；安全性质不变，只是观察点后移到 settled。
  await blocked.settled
  assert.equal(contentCalls, 1, 'timeout must not blindly resubmit command')
  assert.equal(completeCalls, 0, 'completion must wait for confirmed content')
  assert.equal(savedRequests.length, 1)
  receiptStatus = 'succeeded'
  Object.assign(cloud.bookings[0], { items: copy(reopened.data.items), notes: reopened.data.notes })
  const confirmed = await reopened.confirmPendingDraft()
  assert.equal(confirmed.ok, true)
  assert.equal(contentCalls, 1, 'receipt recovery must not send second content command')
  const result = await reopened.complete()
  await result.settled
  assert.equal(result.ok, true)
  assert.equal(completeCalls, 1)
  assert.equal(cloud.students[0].packages[0].used, 1)
  assert.equal(cloud.incomes.length, 1)
  assert.equal(page().data.items[0].name, '假动作')
  assert.equal(require('../utils/pending-training-draft').get('sandbox', 'fake-dataset', 'booking'), null)
  cloud.bookings[0].status = 'booked'
  responseMode = 'fail'
  const failedSession = page()
  failedSession.addExercise({ detail: { name: '第二个假动作', group: '背部' } })
  const failed = await failedSession.complete()
  await failed.settled
  assert.equal(completeCalls, 1, 'cloud content failure cannot trigger a new completion')
  assert.equal(require('../utils/pending-training-draft').get('sandbox', 'fake-dataset', 'booking').content.items.length, 2, 'failed upload must retain latest local draft')
  console.log('session draft recovery tests passed (immediate reopen, timeout receipt, no duplicate content/completion)')
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  if (oldRuntime) require.cache[runtimePath] = oldRuntime; else delete require.cache[runtimePath]
  if (oldCommand) require.cache[commandPath] = oldCommand; else delete require.cache[commandPath]
})
