const assert=require('assert')
const {createWorld,copy,settle}=require('./helpers/local-first-world')
function page(){
  let definition
  global.Page=value=>{definition=value}
  delete require.cache[require.resolve('../pages/students/students')]
  require('../pages/students/students');delete global.Page
  const instance={...definition,data:copy(definition.data),setData(patch,callback){
    for(const [key,value] of Object.entries(patch)){
      const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');let target=this.data
      for(const part of parts.slice(0,-1))target=target[part]
      target[parts[parts.length-1]]=copy(value)
    }
    if(callback)callback()
  }}
  return instance
}
async function run(){
  const world=createWorld({allowMaskedCommands:true})
  world.seed({students:[],bookings:[],incomes:[],sales:[],settings:{renewThreshold:10},customExercises:[]})
  world.memoryRevision=0
  const view=page();view.onShow();view.add()
  view.data.form.name='隔离连点测试'
  Object.assign(view.data.form.packages[0],{total:'20',remaining:'17',price:'300',saleAmount:'5800'})
  const original=world.adapter.execute
  let release,entered
  const gate=new Promise(resolve=>{release=resolve})
  const arrived=new Promise(resolve=>{entered=resolve})
  let saleCalls=0
  world.adapter.execute=async (command,payload,options)=>{
    if(command==='createCourseSale'){saleCalls++;entered();await gate}
    return original(command,payload,options)
  }
  const first=view.save()
  const second=view.save()
  const third=view.savePackage({currentTarget:{dataset:{i:0}}})
  assert.strictEqual(second,first,'整屏连点必须复用同一任务')
  assert.strictEqual(third,first,'另一保存按钮必须共享同一把锁')
  await Promise.all([first,second,third])
  assert.equal(world.counters.loading,0,'本机保存不等待云端遮罩')
  assert.equal(world.localDB().students.length,1,'保存返回时会员已经在本机')
  await arrived
  release();await settle(80)
  assert.equal(saleCalls,1)
  assert.equal(view.data.saving,false)
  assert.equal(world.snapshot().students.length,1)
  assert.equal(world.snapshot().sales.length,1)
  assert.equal(world.snapshot().sales[0].amount,5800)
  assert.equal(world.snapshot().students[0].packages[0].remaining,17)
  await view.save()
  assert.equal(world.snapshot().sales.length,1,'成功之后再保存资料不得重复建销售')
  world.online=false
  await view.save();assert.equal(view.data.saving,false,'离线重入后锁必须释放')
  await settle(2);world.restoreUi()
  console.log('students save reentry: PASS (slow cloud, two buttons, one sale, lock release)')
}
run().catch(error=>{console.error(error);process.exitCode=1})
