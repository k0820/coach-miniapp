const assert = require('assert')
const { runCandidateDryRun } = require('../utils/candidate-dry-run')
const { normalizeSnapshot, integrity } = require('../utils/candidate-dataset')
const { deriveCandidateDatasetId } = require('../utils/candidate-staging')
const source = () => ({ students:[{id:'s1',name:'A',packages:[{id:'p1',saleId:'sale1',type:'常规训练',total:2,used:1,remaining:1}]}],bookings:[{id:'b1',studentId:'s1',packageId:'p1',studentName:'A',status:'done',items:[]}],incomes:[{id:'i1',bookingId:'b1',studentId:'s1',amount:300}],sales:[{id:'sale1',source:'course',studentId:'s1',packageId:'p1',quantity:2,unitPrice:300,amount:500}],settings:{renewThreshold:10,monthlyGoalSessions:40,classCommissionRate:0,salesCommissionRate:0},customExercises:[] })
async function run(){
  let local=source(),writes=0,materializeCalls=0;const fp=integrity(normalizeSnapshot(local)),owner='coach-a',datasetId=deriveCandidateDatasetId(owner,fp.checksum),calls=[]
  const cloud=async event=>{calls.push(event);if(event.action==='prepare')return{ok:true,ownerCoachId:owner,datasetId};if(event.action==='begin'||event.action==='uploadChunk')return{ok:true};if(event.action==='materializeNext')return{ok:true,continue:++materializeCalls<3};if(event.action==='verify')return{ok:true,status:'verified',integrityStatus:'verified',datasetId};throw new Error('unexpected')}
  let result=await runCandidateDryRun({readSource:()=>JSON.parse(JSON.stringify(local)),callCloud:cloud});assert.equal(result.ok,true);assert.equal(result.sourceStable,true);assert.equal(writes,0);assert.ok(calls.some(x=>x.action==='verify'));assert.ok(!calls.some(x=>/activate/i.test(x.action)));assert.ok(calls.filter(x=>x.action==='uploadChunk').length>0)
  local=source();let reads=0;const changedCloud=async event=>{if(event.action==='prepare')return{ok:true,ownerCoachId:owner,datasetId};if(event.action==='begin'||event.action==='uploadChunk')return{ok:true};if(event.action==='materializeNext')return{ok:true,continue:false};if(event.action==='verify')throw new Error('verify must not run after source change')}
  result=await runCandidateDryRun({readSource:()=>{reads++;const copy=JSON.parse(JSON.stringify(local));if(reads===2)copy.sales[0].amount=501;return copy},callCloud:changedCloud});assert.equal(result.code,'SOURCE_CHANGED_DURING_MIGRATION');assert.equal(writes,0)
  console.log('candidate dry-run tests: PASS (explicit source, stable fingerprint, source-change block, no activation/local writes)')
}
run().catch(error=>{console.error(error);process.exitCode=1})
