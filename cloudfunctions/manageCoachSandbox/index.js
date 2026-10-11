const cloud = require('wx-server-sdk')
const { sha, fixedId, sandboxHeadId, sandboxDatasetId, sandboxDatasetDocumentId, sandboxRevisionId, isCompleteSandbox } = require('./sandbox-contract')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const BUSINESS = ['students','student_tombstones','packages','bookings','incomes','sales','settings','customExercises']
const coachIdFor = openId => sha(`coach:${openId}`).slice(0, 32)
const put = (scope, name, id, data) => scope.collection(name).doc(id).set({ data })
const one = async (scope, name, query) => { const r=await scope.collection(name).where(query).limit(1).get();return r.data&&r.data[0] }
const removeScoped = async (scope, name, ownerCoachId, datasetId) => {
  for (;;) {
    const r=await scope.collection(name).where({ownerCoachId,datasetId}).limit(100).get(),rows=r.data||[]
    for(const row of rows) await scope.collection(name).doc(row._id).remove()
    if(rows.length<100)return
  }
}
const businessId = (name, owner, dataset, id) => fixedId(`coach-business-${name}`, owner, `${dataset}:${id}`)
function fixture(ownerCoachId,datasetId,now){
  const studentId='sandbox-student-1',packageId='sandbox-package-1',saleId='sandbox-sale-1',bookingId='sandbox-booking-1',doneId='sandbox-booking-done',incomeId='sandbox-income-1'
  const student={id:studentId,name:'测试学员小蓝',phone:'13800000000',abbr:'CSXYXL',createdAt:now}
  const pkg={id:packageId,type:'常规训练',total:12,used:1,remaining:11,price:120,status:'active',saleId,saleDate:'2026-01-01',createdAt:now}
  const sale={id:saleId,source:'course',status:'active',studentId,packageId,typeName:'常规训练',quantity:12,unitPrice:120,amount:1380,date:'2026-01-01',note:'沙盒测试销售',createdAt:now}
  const booked={id:bookingId,studentId,studentName:student.name,packageId,date:'2026-01-02',hour:10,minute:0,typeName:'常规训练',price:120,status:'booked',items:[],notes:'',createdAt:now}
  const done={id:doneId,studentId,studentName:student.name,packageId,date:'2026-01-01',hour:10,minute:0,typeName:'常规训练',price:120,status:'done',items:[{name:'测试深蹲',group:'腿部',sets:4,reps:10,weight:20}],notes:'沙盒历史记录',category:'腿部训练',duration:60,completedAt:now-86400000,summary:'沙盒历史训练'}
  const income={id:incomeId,bookingId:doneId,studentId,studentName:student.name,date:'2026-01-01',time:'10:00',typeName:'常规训练',category:'腿部训练',amount:120}
  const doc=(name,id,order,data,extra={})=>({name,id:businessId(name,ownerCoachId,datasetId,id),data:{ownerCoachId,datasetId,sourceOrder:order,...extra,data}})
  return [
    doc('students',studentId,0,student,{studentId}),doc('packages',packageId,0,pkg,{studentId,studentSourceOrder:0,packageId,saleId}),
    doc('bookings',bookingId,0,booked,{bookingId,studentId,packageId}),doc('bookings',doneId,1,done,{bookingId:doneId,studentId,packageId}),
    doc('incomes',incomeId,0,income,{incomeId,bookingId:doneId,studentId,packageId}),doc('sales',saleId,0,sale,{saleId,studentId,packageId}),
    doc('settings','settings',0,{renewThreshold:3,monthlyGoalSessions:20,classCommissionRate:40,salesCommissionRate:10},{settingsId:'settings',rootExtras:{schemaVersion:1}}),
    doc('customExercises','sandbox-exercise-1',0,{id:'sandbox-exercise-1',name:'测试推举',group:'肩'},{customExerciseId:'sandbox-exercise-1'})
  ]
}
async function reset(ownerCoachId){
  const datasetId=sandboxDatasetId(ownerCoachId),now=Date.now(),docs=fixture(ownerCoachId,datasetId,now)
  return db.runTransaction(async tx=>{
    for(const name of BUSINESS) await removeScoped(tx,name,ownerCoachId,datasetId)
    await removeScoped(tx,'coach_sandbox_receipts',ownerCoachId,datasetId)
    for(const doc of docs) await put(tx,doc.name,doc.id,doc.data)
    await put(tx,'coach_datasets',sandboxDatasetDocumentId(ownerCoachId,datasetId),{ownerCoachId,datasetId,environment:'sandbox',status:'active',integrityStatus:'verified',schemaVersion:1,createdAt:now,updatedAt:now})
    await put(tx,'coach_sandbox_revisions',sandboxRevisionId(ownerCoachId,datasetId),{ownerCoachId,datasetId,environment:'sandbox',dataRevision:0,createdAt:now,updatedAt:now})
    await put(tx,'coach_sandbox_heads',sandboxHeadId(ownerCoachId),{ownerCoachId,environment:'sandbox',activeDatasetId:datasetId,headVersion:1,schemaVersion:1,createdAt:now,updatedAt:now})
    return{ok:true,environment:'sandbox',datasetId,dataRevision:0,seeded:{students:1,packages:1,bookings:2,incomes:1,sales:1,settings:1,customExercises:1}}
  })
}
exports.main=async event=>{
  const openId=cloud.getWXContext().OPENID
  if(!openId)return{ok:false,code:'IDENTITY_MISSING'}
  for(const key of ['OPENID','openId','openid','_openid','coachId','ownerCoachId','datasetId','activeDatasetId','documentId'])if(Object.prototype.hasOwnProperty.call(event||{},key))return{ok:false,code:'FORBIDDEN_IDENTITY_INPUT'}
  const ownerCoachId=coachIdFor(openId),coach=await one(db,'coaches',{_id:ownerCoachId,openId,status:'active'})
  if(!coach)return{ok:false,code:'COACH_NOT_FOUND'}
  if(event.action==='reset'||event.action==='ensure'){
    if(event.action==='ensure'){
      const head=await one(db,'coach_sandbox_heads',{_id:sandboxHeadId(ownerCoachId),ownerCoachId,environment:'sandbox'})
      if(head&&head.activeDatasetId){
        const datasetId=head.activeDatasetId
        if(await isCompleteSandbox({scope:db,one,ownerCoachId,datasetId}))return{ok:true,environment:'sandbox',datasetId,existing:true}
      }
    }
    return reset(ownerCoachId)
  }
  if(event.action==='status'){
    const head=await one(db,'coach_sandbox_heads',{_id:sandboxHeadId(ownerCoachId),ownerCoachId,environment:'sandbox'})
    return{ok:true,environment:'sandbox',exists:!!(head&&head.activeDatasetId),datasetId:head&&head.activeDatasetId||null}
  }
  return{ok:false,code:'INVALID_ACTION'}
}
