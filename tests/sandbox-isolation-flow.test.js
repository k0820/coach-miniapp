const assert=require('assert')
const {META,SANDBOX_META,coachIdFor,fixedId,createService}=require('../cloudfunctions/coachBusinessCommand/core')
const {handlers}=require('../cloudfunctions/coachBusinessCommand/handlers')
const copy=value=>JSON.parse(JSON.stringify(value)),names=[...new Set([...Object.values(META),...Object.values(SANDBOX_META),'students','student_tombstones','packages','bookings','incomes','sales','settings','customExercises'])],stores=Object.fromEntries(names.map(name=>[name,new Map()]))
let queue=Promise.resolve(),failCollection='',clock=2000000000000
function scope(target){return{collection(name){if(!target[name])target[name]=new Map();return{doc(id){return{async set({data}){if(name===failCollection)throw new Error(`injected ${name}`);target[name].set(id,{...copy(data),_id:id})},async remove(){target[name].delete(id)}}},where(query){let limit=Infinity,offset=0;const api={limit(v){limit=v;return api},skip(v){offset=v;return api},async get(){return{data:[...target[name].values()].filter(row=>Object.keys(query).every(key=>row[key]===query[key])).slice(offset,offset+limit).map(copy)}}};return api}}}}}
const db={...scope(stores),runTransaction(work){const run=queue.then(async()=>{const draft=Object.fromEntries(Object.entries(stores).map(([name,rows])=>[name,new Map([...rows].map(([id,row])=>[id,copy(row)]))]));const result=await work(scope(draft));for(const name of Object.keys(stores)){stores[name].clear();for(const[id,row]of draft[name])stores[name].set(id,copy(row))}return result});queue=run.catch(()=>{});return run}}
const put=(name,id,data)=>stores[name].set(id,{...copy(data),_id:id}),rows=(name,owner,dataset)=>[...stores[name].values()].filter(row=>(!owner||row.ownerCoachId===owner)&&(!dataset||row.datasetId===dataset)),business=(name,owner,dataset,id)=>fixedId(`coach-business-${name}`,owner,`${dataset}:${id}`)
const openId='sandbox-test-openid',owner=coachIdFor(openId),productionDataset='production-sentinel',sandboxDataset='sandbox-isolated'
put(META.coaches,owner,{openId,status:'active'})
put(META.datasets,fixedId('coach-dataset',owner,productionDataset),{ownerCoachId:owner,datasetId:productionDataset,status:'active',integrityStatus:'verified'})
put(META.heads,fixedId('coach-data-head',owner),{ownerCoachId:owner,activeDatasetId:productionDataset,headVersion:9})
put(META.revisions,fixedId('coach-data-revision',owner,productionDataset),{ownerCoachId:owner,datasetId:productionDataset,dataRevision:41})
put('students',business('students',owner,productionDataset,'real-student'),{ownerCoachId:owner,datasetId:productionDataset,studentId:'real-student',data:{id:'real-student',name:'真实区哨兵',phone:'***'}})
put(META.datasets,fixedId('coach-dataset',owner,sandboxDataset),{ownerCoachId:owner,datasetId:sandboxDataset,environment:'sandbox',status:'active',integrityStatus:'verified'})
put(SANDBOX_META.heads,fixedId('coach-sandbox-head',owner),{ownerCoachId:owner,environment:'sandbox',activeDatasetId:sandboxDataset,headVersion:1})
put(SANDBOX_META.revisions,fixedId('coach-sandbox-revision',owner,sandboxDataset),{ownerCoachId:owner,datasetId:sandboxDataset,environment:'sandbox',dataRevision:0})
const productionBefore=copy(Object.fromEntries(names.map(name=>[name,rows(name,owner,productionDataset)])))
const service=()=>createService({db,getOpenId:()=>openId,handlers,now:()=>++clock})
let revision=0,seq=0
async function command(command,payload,options={}){const event={action:'execute',environment:'sandbox',envelope:{command,requestId:options.requestId||`sandbox_req_${String(++seq).padStart(3,'0')}`,expectedRevision:options.expectedRevision==null?revision:options.expectedRevision,payload}},result=await service()(event);if(result.ok&&!result.idempotent)revision=result.datasetRevision;return{result,event}}
const byData=(name,predicate)=>rows(name,owner,sandboxDataset).find(row=>predicate(row.data||{}))
;(async()=>{
  let call=await command('createStudent',{name:'沙盒流程学员',phone:'13900000000'});assert(call.result.ok);const studentId=call.result.result.studentId
  call=await command('createCourseSale',{studentId,type:'常规训练',total:10,remaining:8,quantity:10,unitPrice:150,amount:1450,date:'2026-09-16'});assert(call.result.ok);const{packageId,saleId}=call.result.result
  assert((await command('updateCourseSale',{saleId,packageId,total:11,remaining:8,quantity:10,unitPrice:160,amount:1450,date:'2026-09-16'})).result.ok)
  call=await command('createBooking',{studentId,packageId,date:'2026-09-20',hour:10,minute:0});assert(call.result.ok);const cancelledBooking=call.result.result.bookingId
  assert((await command('rescheduleBooking',{bookingId:cancelledBooking,date:'2026-09-20',hour:11,minute:30})).result.ok)
  assert((await command('cancelBooking',{bookingId:cancelledBooking})).result.ok)
  call=await command('createBooking',{studentId,packageId,date:'2026-09-21',hour:9,minute:15});assert(call.result.ok);const bookingId=call.result.result.bookingId
  const items=[{name:'沙盒高位下拉',group:'背部',sets:4,reps:12,weight:25}]
  assert((await command('updateBookingContent',{bookingId,items,notes:'沙盒训练备注',category:'背部训练',duration:60})).result.ok)
  const beforeComplete=copy(byData('packages',data=>data.id===packageId).data),complete=await command('completeBooking',{bookingId}, {requestId:'sandbox_complete_retry_001'});assert(complete.result.ok)
  const retried=await service()(complete.event);assert(retried.ok&&retried.idempotent)
  const done=byData('bookings',data=>data.id===bookingId).data,afterPackage=byData('packages',data=>data.id===packageId).data,linked=rows('incomes',owner,sandboxDataset).filter(row=>row.data.bookingId===bookingId)
  assert.equal(done.status,'done');assert.deepEqual(done.items,items);assert.equal(done.notes,'沙盒训练备注');assert.equal(afterPackage.used,beforeComplete.used+1);assert.equal(afterPackage.remaining,beforeComplete.remaining-1);assert.equal(linked.length,1)
  call=await command('createManualSale',{name:'沙盒手工业绩',typeName:'其他业绩',amount:99,date:'2026-09-16',note:'fake'});assert(call.result.ok);const manualSaleId=call.result.result.saleId
  assert((await command('updateManualSale',{saleId:manualSaleId,date:'2026-09-17'})).result.ok)
  call=await command('createPackage',{studentId,type:'赠送课程',total:2,remaining:2,isGift:true});assert(call.result.ok);const giftPackageId=call.result.result.packageId
  assert((await command('updatePackage',{packageId:giftPackageId,total:3,remaining:2})).result.ok)
  assert((await command('createCustomExercise',{name:'沙盒划船',group:'背部'})).result.ok)
  assert((await command('saveSettings',{renewThreshold:4,monthlyGoalSessions:30,classCommissionRate:45,salesCommissionRate:12})).result.ok)
  assert((await command('reverseCourseSale',{saleId,packageId})).result.ok)
  const reopened=service(),status=await reopened({action:'status',environment:'sandbox'});assert.equal(status.ok,true);assert.equal(status.datasetRevision,revision)
  const stale=await command('createStudent',{name:'冲突写入'}, {expectedRevision:revision-1});assert.equal(stale.result.code,'REVISION_CONFLICT')
  failCollection='students';const failed=await command('createStudent',{name:'事务失败'});failCollection='';assert.equal(failed.result.ok,false);assert.equal((await service()({action:'status',environment:'sandbox'})).datasetRevision,revision)
  assert.deepEqual(Object.fromEntries(names.map(name=>[name,rows(name,owner,productionDataset)])),productionBefore,'沙盒完整流程不得改变 Production dataset')
  assert.equal(rows(SANDBOX_META.receipts,owner,sandboxDataset).length,revision)
  assert.equal(rows(META.receipts,owner,productionDataset).length,0)
  assert.equal(rows('sales',owner,sandboxDataset).some(row=>row.data.source==='manual'),true)
  assert.equal(rows('packages',owner,sandboxDataset).some(row=>row.data.type==='赠送课程'),true)
  assert.equal(rows('incomes',owner,sandboxDataset).reduce((sum,row)=>sum+Number(row.data.amount||0),0),160)
  assert.equal(rows('sales',owner,sandboxDataset).reduce((sum,row)=>sum+(row.data.status==='reversed'?0:Number(row.data.amount||0)),0),99)
  process.stdout.write('sandbox isolation full-flow tests: PASS (student→sale/package→booking→content→complete→income→gift/reverse/settings, retry/failure/reopen, production untouched)\n')
})().catch(error=>{console.error(error);process.exitCode=1})
