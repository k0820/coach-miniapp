const assert=require('assert')
const {createService:identityService,memberIdFor,coachIdFor,fixedId,names:identityNames}=require('../cloudfunctions/memberIdentityCommand/service')
const {createService:readService}=require('../cloudfunctions/readMyMemberData/service')
const {createService:sandboxService}=require('../cloudfunctions/manageMemberSandbox/service')
const {sandboxHeadId}=require('../cloudfunctions/manageCoachSandbox/sandbox-contract')

const copy=value=>value==null?value:JSON.parse(JSON.stringify(value))
function matches(row,query){return Object.keys(query).every(key=>row&&row[key]===query[key])}
function fakeCloud(){
  const stores={},businessWrites=[];let openId='member-a',now=1700000000000
  const ensure=name=>stores[name]||(stores[name]=new Map())
  function scope(target){return{
    collection(name){const store=target[name]||(target[name]=new Map());return{
      doc(id){return{async set({data}){store.set(id,{...copy(data),_id:id});if(['students','packages','bookings','incomes','sales'].includes(name))businessWrites.push({name,id})},async remove(){store.delete(id)}}},
      where(query){let skip=0,limit=100;const api={skip(n){skip=n;return api},limit(n){limit=n;return api},async get(){return{data:[...store.values()].filter(row=>matches(row,query)).slice(skip,skip+limit).map(copy)}}};return api}
    }},
    async runTransaction(work){const draft={};Object.keys(target).forEach(name=>draft[name]=new Map([...target[name]].map(([k,v])=>[k,copy(v)])));const result=await work(scope(draft));Object.keys(draft).forEach(name=>target[name]=draft[name]);return result}
  }}
  const db=scope(stores);return{stores,db,businessWrites,setOpenId:value=>{openId=value},getOpenId:()=>openId,now:()=>++now,put(name,id,row){ensure(name).set(id,{...copy(row),_id:id})},rows(name){return[...ensure(name).values()].map(copy)}}
}

async function execute(identity,cloud,command,payload,expectedRevision,environment='production',prefix='req'){
  return identity({action:'execute',command,payload,expectedRevision,environment,requestId:`${prefix}_${command}_${String(Math.random()).slice(2)}`})
}
async function coachExecute(identity,cloud,command,payload,environment='production',prefix='coach'){
  const meta=await identity({action:'coachMetadata',environment});assert.strictEqual(meta.ok,true)
  return identity({action:'coachExecute',command,payload,expectedRevision:meta.coachRevision,environment,requestId:`${prefix}_${command}_${String(Math.random()).slice(2)}`})
}

async function run(){
  const cloud=fakeCloud(),identity=identityService({db:cloud.db,getOpenId:cloud.getOpenId,now:cloud.now}),read=readService({db:cloud.db,getOpenId:cloud.getOpenId})
  assert.deepStrictEqual(
    {revisions:identityNames('production').revisions,receipts:identityNames('production').receipts,sandboxRevisions:identityNames('sandbox').revisions,sandboxReceipts:identityNames('sandbox').receipts},
    {revisions:'member_revisions',receipts:'member_receipts',sandboxRevisions:'member_sandbox_revisions',sandboxReceipts:'member_sandbox_receipts'}
  )
  const coachA=coachIdFor('coach-a'),coachB=coachIdFor('coach-b'),datasetA='dataset-a',datasetB='dataset-b'
  for(const [openId,coachId,datasetId,studentId,name] of [['coach-a',coachA,datasetA,'student-a','会员甲'],['coach-b',coachB,datasetB,'student-b','会员甲在B处记录']]){
    cloud.put('coaches',coachId,{openId,status:'active'})
    cloud.put('coach_data_heads',fixedId('coach-data-head',coachId),{ownerCoachId:coachId,activeDatasetId:datasetId})
    cloud.put('students',`${coachId}-${studentId}`,{ownerCoachId:coachId,datasetId,studentId,data:{id:studentId,name,phone:'13800000000',internalFlag:'secret'}})
  }
  cloud.put('packages','package-a-row',{ownerCoachId:coachA,datasetId:datasetA,studentId:'student-a',packageId:'package-a',data:{id:'package-a',type:'私教课',total:10,used:2,remaining:7,price:350,status:'active',saleId:'sale-secret',saleDate:'2026-09-01'}})
  cloud.put('packages','package-b-row',{ownerCoachId:coachB,datasetId:datasetB,studentId:'student-b',packageId:'package-b',data:{id:'package-b',type:'续课',total:20,used:1,remaining:15,price:320,status:'active',saleId:'sale-secret-b',saleDate:'2026-09-20'}})
  cloud.put('bookings','booking-a-row',{ownerCoachId:coachA,datasetId:datasetA,studentId:'student-a',bookingId:'booking-a',data:{id:'booking-a',studentId:'student-a',status:'done',date:'2026-09-20',hour:9,minute:0,typeName:'私教课',category:'力量训练',duration:60,items:[{name:'高位下拉',group:'背',sets:4,reps:12,weight:25,privateCue:'secret'}],notes:'教练私人评价绝不能返回',summary:'旧摘要不自动公开',memberSummary:'今天背部发力更稳定',amount:350,packageId:'package-a'}})
  cloud.put('incomes','income-secret',{ownerCoachId:coachA,datasetId:datasetA,studentId:'student-a',bookingId:'booking-a',data:{amount:350,commission:77}})
  cloud.businessWrites.length=0

  cloud.setOpenId('member-a')
  let result=await identity({action:'bootstrap',environment:'production'});assert.strictEqual(result.ok,true)
  assert.strictEqual(result.member.memberId,undefined,'member identity must stay server-side')
  assert.strictEqual(cloud.rows('member_accounts').length,1)
  const memberA=memberIdFor('member-a')

  cloud.setOpenId('coach-a')
  const pubA=await coachExecute(identity,cloud,'publishCoachProfile',{displayName:'张教练',specialties:['力量训练']});const codeA=pubA.publicCode
  result=await coachExecute(identity,cloud,'createClaimToken',{studentId:'student-a'});assert.strictEqual(result.ok,true);const tokenA=result.claimToken
  cloud.setOpenId('member-a')
  result=await execute(identity,cloud,'claimStudentRecord',{claimToken:tokenA},0);assert.strictEqual(result.ok,true)

  cloud.setOpenId('coach-b')
  await coachExecute(identity,cloud,'publishCoachProfile',{displayName:'李教练',specialties:['体态调整']})
  result=await coachExecute(identity,cloud,'createClaimToken',{studentId:'student-b'});const tokenB=result.claimToken
  cloud.setOpenId('member-a')
  result=await execute(identity,cloud,'claimStudentRecord',{claimToken:tokenB},1);assert.strictEqual(result.ok,true)
  assert.strictEqual(cloud.rows('member_accounts').filter(row=>row.memberId===memberA).length,1,'second coach must not create a second member account')
  assert.strictEqual(cloud.rows('member_student_claims').filter(row=>row.memberId===memberA).length,2)

  let view=await read({action:'read',environment:'production',userInfo:{openId:'platform-injected'}});assert.strictEqual(view.ok,true);assert.strictEqual(view.member.memberId,undefined);assert.strictEqual(view.summary.remaining,22);assert.strictEqual(view.packages.length,2);assert.strictEqual(view.recentTraining.length,1)
  const json=JSON.stringify(view)
  for(const forbidden of ['教练私人评价绝不能返回','旧摘要不自动公开','sale-secret','commission','dataset-a','ownerCoachId','receipt','revisionAfter'])assert.ok(!json.includes(forbidden),`member response leaked ${forbidden}`)
  assert.strictEqual(view.recentTraining[0].memberSummary,'今天背部发力更稳定')
  assert.deepStrictEqual(view.recentTraining[0].items[0],{name:'高位下拉',group:'背',sets:4,reps:12,weight:25,minutes:''})

  result=await execute(identity,cloud,'addCoachShortcut',{publicCode:codeA},2);assert.strictEqual(result.ok,true)
  view=await read({action:'read',environment:'production'});const saved=view.coaches.find(row=>row.displayName==='张教练');assert.ok(saved&&saved.saved)
  result=await execute(identity,cloud,'removeCoachShortcut',{shortcutId:saved.shortcutId},3);assert.strictEqual(result.ok,true)
  view=await read({action:'read',environment:'production'});assert.strictEqual(view.recentTraining.length,1,'removing a shortcut must not delete history');assert.ok(view.coaches.find(row=>row.displayName==='张教练'&&row.historical&&!row.saved))
  const revisions=cloud.rows('member_revisions'),receipts=cloud.rows('member_receipts')
  assert.ok(revisions.some(row=>row.actorType==='member'&&row.memberId===memberA))
  assert.ok(revisions.some(row=>row.actorType==='coach'&&row.coachId===coachA))
  assert.ok(receipts.some(row=>row.actorType==='member'&&row.memberId===memberA))
  assert.ok(receipts.some(row=>row.actorType==='coach'&&row.coachId===coachA))
  assert.strictEqual(new Set(revisions.map(row=>row._id)).size,revisions.length,'member/coach revision ids must remain distinct in one collection')
  assert.strictEqual(new Set(receipts.map(row=>row._id)).size,receipts.length,'member/coach receipt ids must remain distinct in one collection')
  const sharedRequestId='shared_actor_request_0001'
  result=await identity({action:'execute',command:'updateProfile',payload:{displayName:'会员甲',theme:'vitality'},expectedRevision:4,environment:'production',requestId:sharedRequestId});assert.strictEqual(result.ok,true)
  let memberReceipt=await identity({action:'getReceipt',environment:'production',requestId:sharedRequestId});assert.strictEqual(memberReceipt.receipt.action,'updateProfile')
  cloud.setOpenId('coach-a');const coachMeta=await identity({action:'coachMetadata',environment:'production'})
  result=await identity({action:'coachExecute',command:'publishCoachProfile',payload:{displayName:'张教练',specialties:['力量训练']},expectedRevision:coachMeta.coachRevision,environment:'production',requestId:sharedRequestId});assert.strictEqual(result.ok,true)
  const coachReceipt=await identity({action:'getCoachReceipt',environment:'production',requestId:sharedRequestId});assert.strictEqual(coachReceipt.receipt.action,'publishCoachProfile')
  assert.notStrictEqual(cloud.rows('member_receipts').find(row=>row.actorType==='member'&&row.requestId===sharedRequestId)._id,cloud.rows('member_receipts').find(row=>row.actorType==='coach'&&row.requestId===sharedRequestId)._id)

  cloud.setOpenId('member-b');await identity({action:'bootstrap',environment:'production'})
  const viewB=await read({action:'read',environment:'production'});assert.strictEqual(viewB.recentTraining.length,0);assert.strictEqual(viewB.packages.length,0);assert.ok(!JSON.stringify(viewB).includes('高位下拉'))
  // 判别力测试：通过 DB 测试替身故意撤掉 claim 查询里的 memberId 隔离，B 会立刻看见 A 的数据。
  // 这证明上一行不是“安慰测试”，它确实卡住了跨会员泄露事故；生产源码完全没有被改写。
  const unsafeDb={
    collection(name){const collection=cloud.db.collection(name);return{
      doc:id=>collection.doc(id),
      where(query){const weakened={...query};if(name==='member_student_claims')delete weakened.memberId;return collection.where(weakened)}
    }},
    runTransaction:work=>cloud.db.runTransaction(work)
  }
  const unsafeRead=readService({db:unsafeDb,getOpenId:cloud.getOpenId}),unsafeViewB=await unsafeRead({action:'read',environment:'production'})
  assert.ok(unsafeViewB.packages.length>0&&JSON.stringify(unsafeViewB).includes('高位下拉'),'removing memberId isolation must make the test visibly fail')
  const forged=await read({action:'read',environment:'production',memberId:memberA,studentId:'student-a'});assert.strictEqual(forged.code,'FORBIDDEN_IDENTITY_INPUT')
  const nestedForged=await read({action:'read',environment:'production',payload:{filters:{studentId:'student-a'}}});assert.strictEqual(nestedForged.code,'FORBIDDEN_IDENTITY_INPUT')
  result=await identity({action:'execute',command:'updateProfile',payload:{memberId:memberA},expectedRevision:4,requestId:'forged_member_identity'});assert.strictEqual(result.code,'FORBIDDEN_IDENTITY_INPUT')
  result=await identity({action:'bootstrap',environment:'production',memberId:memberA});assert.strictEqual(result.code,'FORBIDDEN_IDENTITY_INPUT')

  cloud.setOpenId('coach-a');const secondToken=(await coachExecute(identity,cloud,'createClaimToken',{studentId:'student-a'})).claimToken
  cloud.setOpenId('member-b');result=await execute(identity,cloud,'claimStudentRecord',{claimToken:secondToken},0);assert.strictEqual(result.code,'STUDENT_ALREADY_CLAIMED')

  cloud.setOpenId('member-a');await identity({action:'bootstrap',environment:'sandbox'});const sandbox=await read({action:'read',environment:'sandbox'});assert.strictEqual(sandbox.packages.length,0);assert.strictEqual(sandbox.environment,'sandbox')
  const sandboxCoach=coachIdFor('member-a'),sandboxDataset='sandbox-dataset-member-a'
  cloud.put('coach_sandbox_heads',sandboxHeadId(sandboxCoach),{ownerCoachId:sandboxCoach,activeDatasetId:sandboxDataset,environment:'sandbox'})
  cloud.put('students','sandbox-student-row',{ownerCoachId:sandboxCoach,datasetId:sandboxDataset,studentId:'sandbox-student',data:{id:'sandbox-student',name:'假会员'}})
  const manageSandbox=sandboxService({db:cloud.db,getOpenId:cloud.getOpenId,now:cloud.now}),productionAccountsBefore=cloud.rows('member_accounts').length
  result=await manageSandbox({action:'seed'});assert.strictEqual(result.ok,true);assert.strictEqual(cloud.rows('member_sandbox_student_claims').length,1)
  assert.ok(cloud.rows('member_sandbox_revisions').some(row=>row.actorType==='member'))
  assert.strictEqual(cloud.rows('member_accounts').length,productionAccountsBefore,'sandbox seed must not write production member accounts')
  result=await manageSandbox({action:'reset'});assert.strictEqual(result.ok,true);assert.strictEqual(cloud.rows('member_sandbox_student_claims').length,0);assert.strictEqual(cloud.rows('member_accounts').length,productionAccountsBefore)
  assert.strictEqual(cloud.businessWrites.length,0,'M1 member operations must not write coach business collections')
  for(const removed of ['member_identity_revisions','member_command_receipts','member_coach_revisions','member_coach_command_receipts','member_sandbox_identity_revisions','member_sandbox_command_receipts','member_sandbox_coach_revisions','member_sandbox_coach_command_receipts'])assert.ok(!Object.prototype.hasOwnProperty.call(cloud.stores,removed),`removed collection must not be accessed: ${removed}`)

  const {handlers}=require('../cloudfunctions/coachBusinessCommand/handlers')
  assert.strictEqual(typeof handlers.completeBooking,'function');const source=require('fs').readFileSync(require('path').join(__dirname,'../cloudfunctions/coachBusinessCommand/handlers.js'),'utf8');assert.ok(source.includes("remaining <= 0")&&source.includes('PACKAGE_NO_REMAINING'),'M1 must not weaken existing completion rule')

  console.log('member M1 tests: PASS (identity, claims, multi-coach, privacy, history, sandbox, zero business writes)')
}
run().catch(error=>{console.error(error);process.exitCode=1})
