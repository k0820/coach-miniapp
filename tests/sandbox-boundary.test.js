const assert=require('assert'),fs=require('fs'),path=require('path')
const runtimePath=require.resolve('../utils/data-runtime'),dbPath=require.resolve('../utils/db')
const storage={coachDataSourceMode:'cloud-primary',coachCloudCutoverState:{status:'cloud-primary'},coachCloudActiveCache:{environment:'production',datasetId:'prod',revision:9,checksum:'p',snapshot:{students:[{id:'real'}],bookings:[],incomes:[],sales:[],settings:{},customExercises:[]}},coachSandboxActiveCache:{environment:'sandbox',datasetId:'sandbox',revision:3,checksum:'s',snapshot:{students:[{id:'fake'}],bookings:[],incomes:[],sales:[],settings:{},customExercises:[]}}}
global.wx={getStorageSync:key=>storage[key],setStorageSync:(key,value)=>{storage[key]=value}}
delete require.cache[runtimePath];delete require.cache[dbPath]
const runtime=require('../utils/data-runtime')
assert.equal(runtime.environment(),'production','每次小程序进程启动必须默认正式区')
assert.equal(runtime.getDB().students[0].id,'real')
runtime.setEnvironment('sandbox');assert.equal(runtime.getDB().students[0].id,'fake')
assert.throws(()=>runtime.saveDB({}),error=>error.code==='CLOUD_PRIMARY_DIRECT_WRITE_BLOCKED')
storage.coachSandboxActiveCache={...storage.coachSandboxActiveCache,environment:'production'}
assert.throws(()=>runtime.getDB(),error=>error.code==='CACHE_ENVIRONMENT_MISMATCH')
runtime.setEnvironment('production');assert.equal(runtime.getDB().students[0].id,'real')
const core=fs.readFileSync(path.join(__dirname,'../cloudfunctions/coachBusinessCommand/core.js'),'utf8'),reader=fs.readFileSync(path.join(__dirname,'../cloudfunctions/readMyActiveCoachData/index.js'),'utf8'),admin=fs.readFileSync(path.join(__dirname,'../cloudfunctions/manageCoachSandbox/index.js'),'utf8'),adapter=fs.readFileSync(path.join(__dirname,'../utils/cloud-primary-adapter.js'),'utf8')
assert(core.includes("heads: 'coach_sandbox_heads'")&&core.includes("revisions: 'coach_sandbox_revisions'")&&core.includes("receipts: 'coach_sandbox_receipts'"))
assert(reader.includes("event.environment === 'sandbox'")&&reader.includes("'coach_sandbox_heads'"))
assert(adapter.includes("environment: env()")&&!adapter.includes('activeDatasetId: env()'))
assert(admin.includes("cloud.getWXContext().OPENID")&&admin.includes("where({ownerCoachId,datasetId})"))
assert(!admin.includes("collection('coach_data_heads').doc")&&!admin.includes("removeScoped(tx,'coach_data_heads'"))
assert(admin.includes("FORBIDDEN_IDENTITY_INPUT")&&admin.includes("datasetId','activeDatasetId"))
process.stdout.write('sandbox boundary tests: PASS (default production, isolated caches/meta, trusted owner, no client dataset, scoped reset)\n')
