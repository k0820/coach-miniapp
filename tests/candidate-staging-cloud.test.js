const assert = require('assert')
const { normalizeSnapshot, integrity, buildCandidateDataset } = require('../utils/candidate-dataset')
const { buildCandidateUploadPlan } = require('../utils/candidate-staging')
const { createService, coachIdFor } = require('../cloudfunctions/stageCoachCandidate/service')

const stores = new Map(), store = name => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name) }
const match = (row, filter) => Object.keys(filter).every(key => row[key] === filter[key])
function collection(name) {
  const rows = store(name)
  return {
    where(filter) { const state = { skip: 0, limit: Infinity }; const query = { skip(n){state.skip=n;return query},limit(n){state.limit=n;return query},async get(){return {data:[...rows.values()].filter(row=>match(row,filter)).slice(state.skip,state.skip+state.limit)}} }; return query },
    doc(id) { return { async set({data}){rows.set(id,{_id:id,...JSON.parse(JSON.stringify(data))})},async update({data}){const old=rows.get(id);if(old)rows.set(id,{...old,...JSON.parse(JSON.stringify(data))});return{stats:{updated:old?1:0}}},async remove(){return{stats:{removed:rows.delete(id)?1:0}}} } }
  }
}
const db = { collection, serverDate: () => 'server-time' }
let openId = 'openid-a'
const service = createService({ db, getOpenId: () => openId })
function fixture(mark='a'){return{students:[{id:`student-${mark}`,name:'Fixture',packages:[{id:`package-${mark}`,saleId:`sale-${mark}`,type:'常规训练',total:10,used:1,remaining:9}]},{id:`deleted-${mark}`,name:'历史',status:'deleted',packages:[{id:`dp-${mark}`,saleId:`ds-${mark}`,type:'常规训练',total:1,used:1,remaining:0,status:'reversed'}]}],bookings:[{id:`booking-${mark}`,studentId:`student-${mark}`,packageId:`package-${mark}`,studentName:'Fixture',status:'done',items:[{name:'深蹲',notes:'大'.repeat(60000)},{name:'卧推'}]},{id:`db-${mark}`,studentId:`deleted-${mark}`,packageId:`dp-${mark}`,studentName:'历史',status:'done',items:[]},{id:`legacy-booking-${mark}`,studentId:`student-${mark}`,studentName:'Fixture',status:'done',items:[{name:'历史动作'}],notes:'保留',summary:'保留总结'}],incomes:[{id:`income-${mark}`,bookingId:`booking-${mark}`,studentId:`student-${mark}`,amount:300},{id:`di-${mark}`,bookingId:`db-${mark}`,studentId:`deleted-${mark}`,amount:300},{id:`legacy-income-${mark}`,bookingId:`legacy-booking-${mark}`,studentId:`student-${mark}`,amount:260}],sales:[{id:`sale-${mark}`,source:'course',studentId:`student-${mark}`,packageId:`package-${mark}`,amount:2800},{id:`ds-${mark}`,source:'course',studentId:`deleted-${mark}`,packageId:`dp-${mark}`,amount:300,status:'reversed'},{id:`legacy-orphan-${mark}`,source:'course',studentId:`student-${mark}`,amount:123,date:'2025-01-01'}],settings:{renewThreshold:10,monthlyGoalSessions:40,classCommissionRate:10,salesCommissionRate:2},customExercises:[{id:`exercise-${mark}`,name:'动作'}]}}
async function setup(mark='a') {
  const source=fixture(mark), fp=integrity(normalizeSnapshot(source)), prep=await service({action:'prepare',sourceChecksum:fp.checksum})
  const candidate=buildCandidateDataset(source,{trustedOwnerCoachId:prep.ownerCoachId,trustedDatasetId:prep.datasetId}),plan=buildCandidateUploadPlan(candidate)
  const begin=await service({action:'begin',sourceChecksum:fp.checksum,sourceByteSize:fp.byteSize,sourceSummary:fp.summary,counts:fp.counts,schemaVersion:1,totalChunks:plan.totalChunks,collections:plan.collections})
  return {source,fp,prep,candidate,plan,begin}
}
async function materialize(ctx){let result;do{result=await service({action:'materializeNext',sourceChecksum:ctx.fp.checksum});assert.equal(result.ok,true)}while(result.continue)}
async function cleanup(ctx){let result;do{result=await service({action:'cleanup',sourceChecksum:ctx.fp.checksum});assert.equal(result.ok,true)}while(result.continue);return result}

async function run(){
  const ownerA=coachIdFor(openId);store('coaches').set(ownerA,{_id:ownerA,openId,status:'active'});store('coach_data_heads').set('head-a',{_id:'head-a',ownerCoachId:ownerA,activeDatasetId:'existing-active'})
  const ctx=await setup();assert.equal(ctx.begin.ok,true);assert.equal(ctx.begin.datasetId,ctx.prep.datasetId)
  assert.equal((await service({...ctx.plan.chunks[0],sourceChecksum:ctx.fp.checksum})).ok,true);assert.equal((await service({...ctx.plan.chunks[0],sourceChecksum:ctx.fp.checksum})).reused,true)
  let missing;for(let attempt=0;attempt<20;attempt++){missing=await service({action:'materializeNext',sourceChecksum:ctx.fp.checksum});if(!missing.ok)break}assert.equal(missing.code,'CANDIDATE_CHUNKS_MISSING')
  for(let i=1;i<ctx.plan.chunks.length;i++)assert.equal((await service({...ctx.plan.chunks[i],sourceChecksum:ctx.fp.checksum})).ok,true)
  await materialize(ctx)
  let verified=await service({action:'verify',sourceChecksum:ctx.fp.checksum,currentSourceChecksum:ctx.fp.checksum,currentSourceByteSize:ctx.fp.byteSize,currentSourceSummary:ctx.fp.summary});assert.equal(verified.ok,true);assert.equal(verified.status,'verified')
  const resumed=await service({action:'begin',sourceChecksum:ctx.fp.checksum,sourceByteSize:ctx.fp.byteSize,sourceSummary:ctx.fp.summary,counts:ctx.fp.counts,schemaVersion:1,totalChunks:ctx.plan.totalChunks,collections:ctx.plan.collections});assert.equal(resumed.ok,true);assert.equal(resumed.reused,true);assert.equal(resumed.status,'verified')
  assert.equal([...store('student_tombstones').values()].filter(x=>x.ownerCoachId===ownerA).length,1)
  assert.deepStrictEqual([...store('bookings').values()].find(x=>x.ownerCoachId===ownerA&&x.bookingId==='booking-a').data.items.map(x=>x.name),['深蹲','卧推'])
  assert.equal([...store('bookings').values()].find(x=>x.ownerCoachId===ownerA&&x.bookingId==='legacy-booking-a').data.legacyRelationStatus,'orphan')
  assert.ok([...store('incomes').values()].some(x=>x.ownerCoachId===ownerA&&x.incomeId==='legacy-income-a'))
  assert.equal([...store('sales').values()].find(x=>x.ownerCoachId===ownerA&&x.saleId==='legacy-orphan-a').data.legacyRelationStatus,'orphan')
  assert.equal(store('coach_data_heads').get('head-a').activeDatasetId,'existing-active');assert.equal(store('coach_data_revisions').size,0)
  const forged=await service({action:'getStatus',sourceChecksum:ctx.fp.checksum,ownerCoachId:'other'});assert.equal(forged.code,'FORBIDDEN_IDENTITY_INPUT')

  openId='openid-b';const ownerB=coachIdFor(openId);store('coaches').set(ownerB,{_id:ownerB,openId,status:'active'});const ctxB=await setup('b');for(const chunk of ctxB.plan.chunks)await service({...chunk,sourceChecksum:ctxB.fp.checksum});await materialize(ctxB)
  assert.equal((await service({action:'getStatus',sourceChecksum:ctx.fp.checksum})).code,'CANDIDATE_SESSION_NOT_FOUND')
  openId='openid-a';const cleaned=await cleanup(ctx);assert.equal(cleaned.cleaned,true);assert.ok([...store('bookings').values()].some(x=>x.ownerCoachId===ownerB));assert.equal(store('coach_data_heads').get('head-a').activeDatasetId,'existing-active')
  console.log('candidate staging cloud adapter tests: PASS (trusted identity, chunks, resume, tombstone, persisted verify, head/revision isolation, scoped cleanup)')
}
run().catch(error=>{console.error(error);process.exitCode=1})
