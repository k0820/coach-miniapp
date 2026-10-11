const assert=require('assert')
const fs=require('fs')
const path=require('path')
const {fixedId,sandboxHeadId,sandboxDatasetDocumentId,sandboxRevisionId,isCompleteSandbox}=require('../cloudfunctions/manageCoachSandbox/sandbox-contract')

const owner='coach-contract-owner'
assert.strictEqual(sandboxHeadId(owner),fixedId('coach-sandbox-head',owner),'Sandbox Head must use manageCoachSandbox authoritative contract')

const root=path.join(__dirname,'../cloudfunctions')
const manager=fs.readFileSync(path.join(root,'manageCoachSandbox/index.js'),'utf8')
assert.ok(manager.includes("require('./sandbox-contract')")&&manager.includes('sandboxHeadId(ownerCoachId)'),'coach Sandbox must create/read Heads through its authoritative contract')
assert.ok(manager.includes('isCompleteSandbox({scope:db,one,ownerCoachId,datasetId})'),'ensure must verify completeness before reuse')

for(const file of ['memberIdentityCommand/service.js','readMyMemberData/service.js','manageMemberSandbox/service.js']){
  const source=fs.readFileSync(path.join(root,file),'utf8')
  assert.ok(!source.includes("fixedId('coach-sandbox-head'"),`${file} must not duplicate coach Sandbox Head ID algorithm`)
  assert.ok(source.includes('ownerCoachId')&&/environment\s*:\s*['"]sandbox['"]/.test(source),`${file} must resolve Sandbox Head by trusted owner and environment`)
}

async function verifyCompleteness(){
  const datasetId='sandbox-contract-dataset'
  const rows={
    coach_datasets:{_id:sandboxDatasetDocumentId(owner,datasetId),ownerCoachId:owner,datasetId,environment:'sandbox',status:'active',integrityStatus:'verified'},
    coach_sandbox_revisions:{_id:sandboxRevisionId(owner,datasetId),ownerCoachId:owner,datasetId,environment:'sandbox',dataRevision:0},
    students:{ownerCoachId:owner,datasetId,studentId:'sandbox-student'}
  }
  const one=async(_scope,name,query)=>{const row=rows[name];return row&&Object.keys(query).every(key=>row[key]===query[key])?row:null}
  assert.strictEqual(await isCompleteSandbox({scope:{},one,ownerCoachId:owner,datasetId}),true)
  delete rows.students
  assert.strictEqual(await isCompleteSandbox({scope:{},one,ownerCoachId:owner,datasetId}),false,'missing fixture student must force safe rebuild')
  rows.students={ownerCoachId:owner,datasetId,studentId:'sandbox-student'}
  rows.coach_sandbox_revisions.dataRevision=-1
  assert.strictEqual(await isCompleteSandbox({scope:{},one,ownerCoachId:owner,datasetId}),false,'invalid revision must force safe rebuild')
}

verifyCompleteness().then(()=>process.stdout.write('member Sandbox Head contract tests: PASS (one authoritative ID rule, complete ensure, member readers cannot drift)\n')).catch(error=>{console.error(error);process.exitCode=1})
