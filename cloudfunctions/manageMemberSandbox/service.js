const crypto=require('crypto')
const sha=value=>crypto.createHash('sha256').update(String(value)).digest('hex')
const fixedId=(...parts)=>sha(parts.join(':')).slice(0,32)
const memberIdFor=openId=>sha(`member:${openId}`).slice(0,32)
const coachIdFor=openId=>sha(`coach:${openId}`).slice(0,32)
const collections=['member_sandbox_accounts','member_sandbox_student_claims','member_sandbox_claim_tokens','member_sandbox_coach_profiles','member_sandbox_coach_shortcuts','member_sandbox_revisions','member_sandbox_receipts']
const all=async(db,name,query)=>{const out=[];for(let skip=0;;skip+=100){const r=await db.collection(name).where(query).skip(skip).limit(100).get(),page=r.data||[];out.push(...page);if(page.length<100)return out}}
const one=async(db,name,query)=>(await all(db,name,query))[0]||null

function createService({db,getOpenId,now=()=>Date.now()}){
  return async event=>{
    const openId=getOpenId();if(!openId)return{ok:false,code:'IDENTITY_MISSING'}
    const memberId=memberIdFor(openId),coachId=coachIdFor(openId),action=event&&event.action||'status'
    if(action==='status'){const account=await one(db,'member_sandbox_accounts',{memberId}),claims=await all(db,'member_sandbox_student_claims',{memberId});return{ok:true,seeded:!!account,claimCount:claims.length}}
    if(action==='reset'){
      for(const name of collections){const rows=[...await all(db,name,{memberId}),...await all(db,name,{coachId})],seen=new Set();for(const row of rows)if(row&&row._id&&!seen.has(row._id)){seen.add(row._id);await db.collection(name).doc(row._id).remove()}}
      return{ok:true,reset:true}
    }
    if(action!=='seed')return{ok:false,code:'INVALID_ACTION'}
    // Coach Sandbox owns the Head ID algorithm. Member Sandbox resolves the
    // already trusted coach by owner + environment instead of reimplementing it.
    const heads=await all(db,'coach_sandbox_heads',{ownerCoachId:coachId,environment:'sandbox'})
    if(heads.length>1)return{ok:false,code:'COACH_DATASET_HEAD_AMBIGUOUS',message:'教练 Sandbox 数据空间关系不唯一。'}
    const head=heads[0]||null
    if(!head||!head.activeDatasetId)return{ok:false,code:'SANDBOX_NOT_READY',message:'请先建立教练 Sandbox 假数据。'}
    const students=await all(db,'students',{ownerCoachId:coachId,datasetId:head.activeDatasetId})
    if(!students.length)return{ok:false,code:'SANDBOX_STUDENT_MISSING',message:'Sandbox 中还没有假学员。'}
    const timestamp=now(),student=students[0],claimId=fixedId('member_sandbox_student_claims',coachId,student.studentId),shortcutId=fixedId('member_sandbox_coach_shortcuts',memberId,coachId)
    await db.runTransaction(async tx=>{
      await tx.collection('member_sandbox_accounts').doc(fixedId('member_sandbox_accounts',memberId)).set({data:{memberId,identityHash:sha(`openid:${openId}`),displayName:'测试会员',theme:'vitality',status:'active',createdAt:timestamp,updatedAt:timestamp}})
      await tx.collection('member_sandbox_student_claims').doc(claimId).set({data:{claimId,memberId,coachId,studentId:student.studentId,status:'verified',claimedAt:timestamp,source:'sandbox-seed'}})
      await tx.collection('member_sandbox_coach_profiles').doc(fixedId('member_sandbox_coach_profiles',coachId)).set({data:{coachId,publicCode:`TEST-${coachId.slice(0,6)}`,displayName:'Sandbox 教练',specialties:['力量训练','体态调整'],introduction:'仅用于安全测试',discoverable:true,updatedAt:timestamp}})
      await tx.collection('member_sandbox_coach_shortcuts').doc(shortcutId).set({data:{shortcutId,memberId,coachId,source:'sandbox-seed',addedAt:timestamp}})
      await tx.collection('member_sandbox_revisions').doc(fixedId('member_sandbox_revisions','member',memberId)).set({data:{actorType:'member',memberId,dataRevision:0,createdAt:timestamp,updatedAt:timestamp}})
    })
    return{ok:true,seeded:true,studentPreview:{name:student.data&&student.data.name||'假学员'}}
  }
}
module.exports={createService,fixedId,memberIdFor,coachIdFor,collections}
