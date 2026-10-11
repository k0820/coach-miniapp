const assert=require('assert')
const {createBookingOptimistic}=require('../utils/booking-optimistic')
const pending=require('../utils/pending-booking-request')
const cancellation=require('../utils/pending-cancellation')
const store={}
global.wx={getStorageSync:key=>store[key],setStorageSync:(key,value)=>{store[key]=JSON.parse(JSON.stringify(value))}}
const runtime={environment:()=> 'sandbox',cutoverState:()=>({status:'cloud-primary'}),MODES:{ACTIVATING:'activating',PENDING:'cutover-pending'}}
const booking={id:'fake-booking',studentId:'fake-student',packageId:'fake-package',date:'2026-09-19',hour:14,minute:0,status:'booked'}
let revision=null,readOk=true,receiptOk=true,executeCode='',commands=[],modals=[]
const adapter={
  getState:()=>({datasetId:'fake-dataset',revision}),
  readActive:async()=>{if(readOk){revision=4;return {ok:true}}return {ok:false}},
  getReceipt:async()=>({ok:receiptOk,found:false}),
  execute:async(command,payload,options)=>{commands.push({command,payload,options});assert.ok(Number.isInteger(revision));return executeCode?{ok:false,code:executeCode}:{ok:true,refreshed:{ok:true}}}
}
const coordinator=createBookingOptimistic({runtime,pending,cancellation,adapter,readDatasetId:()=> 'fake-dataset',readSnapshot:()=>({bookings:[booking]}),newRequestId:()=> 'original-cancel-id',showModal:options=>modals.push(options)})
function seed(status='waiting'){
  for(const key of Object.keys(store))delete store[key]
  cancellation.begin('sandbox','fake-dataset','key',booking.id,()=> 'original-cancel-id',booking,1)
  cancellation.patch('sandbox','fake-dataset','key','original-cancel-id',{status})
  commands=[];modals=[];revision=null
}
async function run(){
  seed();await coordinator.retryCancel('key')
  assert.equal(commands.length,1);assert.equal(commands[0].options.requestId,'original-cancel-id')
  assert.equal(cancellation.list('sandbox','fake-dataset').length,0)
  assert.equal(modals.length,0)
  seed();readOk=false;await coordinator.retryCancel('key')
  assert.equal(commands.length,0);assert.equal(cancellation.get('sandbox','fake-dataset','key').status,'waiting')
  assert.equal(modals.length,0,'没有出网不能弹取消结果未知')
  readOk=true;await coordinator.retryCancel('key');assert.equal(commands.length,1)
  seed('unknown');receiptOk=false;await coordinator.retryCancel('key')
  assert.equal(commands.length,0,'查单失败时，即使用户点击核对也不能重发')
  receiptOk=true;executeCode='REVISION_UNKNOWN';seed();await coordinator.retryCancel('key')
  assert.equal(cancellation.get('sandbox','fake-dataset','key').status,'waiting')
  assert.equal(modals.length,0)
  executeCode='COMMAND_RESULT_UNKNOWN';seed();await coordinator.retryCancel('key')
  assert.equal(cancellation.get('sandbox','fake-dataset','key').status,'unknown')
  // ★ 1.1.9 第 7 轮：`found === false`（收据与业务写在同一事务里 ⇒ 这是**权威的"从未受理"**）
  //   时，自动恢复允许用**同一个号**补发。修前这里只查单、永不重发 ——
  //   于是"响应丢一次"就等于"这条取消永远上不了云"，而 tombstone 永远留在本机
  //   （用户以为取消了，另一台设备永远看得到）。号不变 ⇒ 云端仍认作同一次请求。
  const before=commands.length
  await coordinator.resume()
  assert.equal(commands.length,before+1,'云端明确未受理 ⇒ 自动恢复必须原号补发')
  assert.equal(commands[commands.length-1].options.requestId,'original-cancel-id','补发必须用同一个号（幂等）')
  // 边界（既有铁律一个字没改）：回执**查不到**（网络问题）时只能等，绝不重发 ——
  // 「结果未知」与「明确从未受理」是两件事，绝不能混为一谈。
  seed('unknown');receiptOk=false;await coordinator.retryCancel('key')
  const kept=commands.length
  await coordinator.resume()
  assert.equal(commands.length,kept,'查不到回执时自动恢复只能查单，绝不重发')
  receiptOk=true
  console.log('cancellation cold start: PASS (revision preflight, same request, failed lookup never resends)')
}
run().catch(error=>{console.error(error);process.exitCode=1})
