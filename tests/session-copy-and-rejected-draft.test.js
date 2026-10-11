const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createWorld, loadSessionPage, settle } = require('./helpers/local-first-world')
const pendingDraft = require('../utils/pending-training-draft')
const outbox = require('../utils/local-outbox')
const sync = require('../utils/sync-engine')
const scope = { environment: 'production', datasetId: 'ds-test' }
const bookingId = 'legacy-existing-booking'
const seed = () => ({ students: [{ id: 'fake-student', name: '假学员', status: 'active', packages: [{ id: 'exact-package', type: '常规训练', price: 100, total: 8, used: 1, remaining: 7, status: 'active' }] }], bookings: [{ id: bookingId, studentId: 'fake-student', studentName: '假学员', packageId: 'exact-package', date: '2026-09-18', hour: 9, minute: 30, typeName: '常规训练', price: 100, status: 'booked', items: [] }], incomes: [], sales: [], settings: {}, customExercises: [] })
const items = [{ name: '高位下拉', group: '背', sets: 4, reps: 12, weight: 35 }]
async function rejectedDraft() {
  const world = createWorld(); world.seed(seed()); world.online = false
  const page = loadSessionPage(); page.onLoad({ id: bookingId }); page.onShow()
  page.setData({ items, groupSections: [], notes: '新备注', category: '背部训练', duration: 60 })
  page.queueDraft(); await page.flushDraft()
  assert(pendingDraft.get(scope.environment, scope.datasetId, bookingId), '仅入队后草稿仍在')
  assert.equal(outbox.list(scope).length, 1)
  world.online = true
  const original = world.adapter.execute
  world.adapter.execute = async command => command === 'updateBookingContent' ? { ok: false, code: 'BOOKING_RELATION_INVALID', message: '模拟明确云端拒绝' } : original(command)
  await sync.flush()
  const failed = outbox.failed(scope).find(row => row.command === 'updateBookingContent')
  assert.equal(failed.code, 'BOOKING_RELATION_INVALID', '失败原因原样入档，不能只显示泛化 toast')
  assert.deepStrictEqual(failed.payload.items, items)
  assert.deepStrictEqual(pendingDraft.get(scope.environment, scope.datasetId, bookingId).content.items, items, '明确拒绝后本机动作仍在')
  assert.deepStrictEqual(world.snapshot().bookings[0].items, [], '不得谎称云端已保存')
  const reopened = loadSessionPage(); reopened.onLoad({ id: bookingId }); reopened.onShow()
  assert.deepStrictEqual(reopened.data.items, items, '再次进入仍能看见本机动作')
  assert.equal(world.snapshot().incomes.length, 0)
  assert.equal(world.snapshot().students[0].packages[0].remaining, 7)
  const guard=require('../utils/production-recovery-guard')
  wx.setStorageSync(guard.KEY,{bookingId,datasetId:scope.datasetId,status:'released'})
  wx.cloud.callFunction=async ({name,data})=>{
    assert.equal(name,'diagnoseCoachCompletion');assert.equal(data.action,'diagnose')
    return {result:{ok:true,booking:{bookingId,status:'booked',items:[]},incomes:[]}}
  }
  let definition;global.Page=value=>{definition=value}
  require('../pkg-diag/production-recovery-diagnostic/production-recovery-diagnostic.js');delete global.Page
  const diagnostic={data:{...definition.data},setData(patch){Object.assign(this.data,patch)}}
  for(const [name,method] of Object.entries(definition))if(typeof method==='function')diagnostic[name]=method.bind(diagnostic)
  await diagnostic.onLoad()
  assert(diagnostic.data.plain.includes('updateBookingContent / BOOKING_RELATION_INVALID'),'只读页面展示确切失败命令和 code')
  assert(diagnostic.data.detail.includes('高位下拉'),'失败档案仍保留原动作')
}
async function copiedCompletion() {
  const world = createWorld(); world.seed(seed()); world.online = false
  const clipboard=[]; wx.setClipboardData = ({ data, success }) => { clipboard.push(data); if (success) success({}) }
  const page = loadSessionPage(); page.onLoad({ id: bookingId }); page.onShow()
  page.setData({ items, groupSections: [], notes: '课后备注', category: '背部训练', duration: 60 })
  page.queueDraft(); const handle = await page.complete(); const result = await handle.settled
  assert.equal(result.code, 'COMPLETED_LOCAL_FIRST')
  assert.equal(clipboard.length, 1, 'Sandbox 与 Production 共用课程页，下课成功只复制一次')
  assert(clipboard[0].includes('高位下拉') && clipboard[0].includes('课后备注'))
  assert.deepStrictEqual(outbox.list(scope).map(row => row.command), ['updateBookingContent', 'completeBooking'], '复制不产生额外云命令')
  world.online = true; await sync.flush(); await settle(50)
  assert.equal(world.snapshot().incomes.length, 1)
  assert.equal(world.snapshot().students[0].packages[0].remaining, 6)
}
async function main() { await rejectedDraft(); await copiedCompletion(); console.log('session copy and rejected draft: PASS') }
assert(fs.readFileSync(path.join(__dirname,'../pages/session/session.wxml'),'utf8').includes('完成课程并保存训练记录（同时复制）'),'正式课程页必须明确保留下课同时复制入口')
main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1 })
