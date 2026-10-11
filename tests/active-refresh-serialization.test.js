const assert=require('assert')
const {buildCandidateDataset}=require('../utils/candidate-dataset')
const {createAdapter}=require('../utils/cloud-primary-adapter')
const physical={students:'students',studentTombstones:'student_tombstones',packages:'packages',bookings:'bookings',incomes:'incomes',sales:'sales',settings:'settings',customExercises:'customExercises'}
const snapshot={students:[{id:'s',name:'假学员',packages:[{id:'p',type:'赠送课程',total:2,used:0,remaining:2,price:80,status:'active'}]}],bookings:[],incomes:[],sales:[],settings:{renewThreshold:3,monthlyGoalSessions:20,classCommissionRate:0,salesCommissionRate:0},customExercises:[]}
let environment='sandbox',revision=1,reading=false,blockNext=false,release,entered,commands=0
let built=buildCandidateDataset(snapshot,{trustedOwnerCoachId:'fake-owner',trustedDatasetId:'fake-dataset'})
const memory={}
const adapter=createAdapter({environment:()=>environment,storage:{get:key=>memory[key],set:(key,value)=>{memory[key]=value}},callCloud:async(name,data)=>{
  if(name==='coachBusinessCommand'){
    assert.equal(reading,false,'写入不能插入完整回读窗口')
    assert.equal(data.envelope.expectedRevision,revision)
    commands++;revision++;return {ok:true,datasetRevision:revision,result:{}}
  }
  if(data.action==='metadata'){
    reading=true
    if(blockNext){blockNext=false;entered();await new Promise(resolve=>{release=resolve})}
    return {ok:true,environment:data.environment,datasetId:'fake-dataset',dataRevision:revision,collections:Object.values(physical)}
  }
  if(data.action==='integrity'){reading=false;return {ok:true,environment:data.environment,datasetId:'fake-dataset',dataRevision:revision,...built.integrity}}
  const logical=Object.keys(physical).find(key=>physical[key]===data.collection),rows=built.collections[logical]
  return {ok:true,nextCursor:rows.length,done:true,payload:Buffer.from(JSON.stringify(rows)).toString('base64')}
}})
async function run(){
  assert.equal((await adapter.readActive()).ok,true)
  snapshot.bookings.push({id:'other-device',studentId:'s',studentName:'假学员',packageId:'p',date:'2026-09-19',hour:14,minute:0,status:'booked',typeName:'赠送课程',price:80,items:[]})
  revision++
  built=buildCandidateDataset(snapshot,{trustedOwnerCoachId:'fake-owner',trustedDatasetId:'fake-dataset'})
  assert.ok(built.integrity.checksum)
  const arrived=new Promise(resolve=>{entered=resolve});blockNext=true
  // ⚠️ 1.1.9 第 2 轮：本机有**已验缓存**时，readActive 会先走一跳 `integrity` 校验式首跳，
  //    压根不经过 metadata —— 而这里的门恰好挂在 metadata 上。
  //    若不清缓存：这次读取既不会被门挡住，`await arrived` 也**永远不会 resolve**
  //    ⇒ 进程静默饿死（**退出码 0、零输出**，看起来像"通过"，其实是假绿）。
  //    要构造的形态是"**一整次完整回读**正停在窗口内"（metadata 已读、分页未开始），所以先清掉缓存。
  delete memory.coachSandboxActiveCache
  const refresh=adapter.readActive();await arrived
  assert.strictEqual(adapter.readActive(),refresh,'同环境同时刷新合并为一次')
  const write=adapter.execute('saveSettings',{}, {requestId:'fake-save'})
  assert.equal(commands,0)
  release();assert.equal((await refresh).ok,true);assert.equal((await write).ok,true)
  assert.equal(commands,1)
  assert.equal(memory.coachSandboxActiveCache.snapshot.bookings[0].id,'other-device')
  // 同上：这一跳同样要**走完整路径**才可能被 metadata 的门挡住，所以在采样基线之前先清缓存
  // （采样必须放在清缓存**之后**，否则下面的"memory 逐字不变"会被这次清缓存自己破坏）。
  delete memory.coachSandboxActiveCache
  const oldCache=JSON.stringify(memory)
  const switching=new Promise(resolve=>{entered=resolve});blockNext=true
  const stale=adapter.readActive();await switching
  environment='production';release()
  assert.equal((await stale).ok,false)
  assert.equal(JSON.stringify(memory),oldCache,'跨环境在途回读不能落到任何新缓存')
  assert.ok(!memory.coachCloudActiveCache)
  console.log('active refresh serialization: PASS (other device, read/write ordering, coalescing, environment isolation)')
}
run().catch(error=>{console.error(error);process.exitCode=1})
