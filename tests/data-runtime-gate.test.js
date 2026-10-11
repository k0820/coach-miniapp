const assert=require('assert'),fs=require('fs'),path=require('path')
const storage=new Map();global.wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,JSON.parse(JSON.stringify(v)))}
const runtime=require('../utils/data-runtime'),sample={students:[],bookings:[],incomes:[],sales:[],settings:{},customExercises:[]}
storage.set('coachDB',sample);assert.equal(runtime.mode(),'local-primary');runtime.saveDB(sample);assert.ok(storage.has('coachDB'))
const cached={datasetId:'d1',revision:2,checksum:'abc',updatedAt:1,snapshot:{...sample,marker:'cloud'}};runtime.activateCloudMode(cached);assert.equal(runtime.mode(),'cloud-primary');assert.equal(runtime.getDB().marker,'cloud')
assert.throws(()=>runtime.saveDB(sample),error=>error.code==='CLOUD_PRIMARY_DIRECT_WRITE_BLOCKED');assert.equal(storage.get('coachDB').marker,undefined)
storage.set(runtime.MODE_KEY,runtime.MODES.LOCAL);runtime.setCutoverState(runtime.MODES.PENDING,{datasetId:'d1'});assert.equal(runtime.writesFrozen(),true);assert.throws(()=>runtime.saveDB(sample),error=>error.code==='CLOUD_PRIMARY_DIRECT_WRITE_BLOCKED')
const roots=['pages/schedule','pages/students','pages/session','pages/stats','pages/attendance-history','components/booking-modal','components/exercise-picker']
for(const root of roots)for(const file of fs.readdirSync(path.join(__dirname,'..',root)).filter(x=>x.endsWith('.js'))){const source=fs.readFileSync(path.join(__dirname,'..',root,file),'utf8');assert.ok(!source.includes("utils/db')")&&!source.includes('utils/db"'),`${root}/${file} 绕过 data-runtime`)}
process.stdout.write('data runtime gate tests: PASS (local unchanged, cloud cache read-only, direct local write blocked)\n')
