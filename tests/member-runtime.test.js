const assert=require('assert')

async function run(){
  const storage=new Map(),calls=[]
  let mode='receipt-missing'
  global.wx={
    getStorageSync:key=>storage.get(key),
    setStorageSync:(key,value)=>storage.set(key,JSON.parse(JSON.stringify(value))),
    cloud:{callFunction:async({name,data})=>{
      calls.push({name,data:JSON.parse(JSON.stringify(data))})
      if(name==='readMyMemberData'||data.action==='memberRead')return{result:{ok:true,environment:data.environment,state:'ready',dataRevision:1,member:{displayName:'测试会员',theme:'vitality'},summary:{remaining:8},packages:[],recentTraining:[],coaches:[]}}
      if(data.action==='execute'){
        if(mode==='receipt-missing'||mode==='receipt-succeeded')throw new Error('timeout')
        return{result:{ok:true,revisionAfter:1}}
      }
      if(data.action==='getReceipt')return mode==='receipt-succeeded'
        ?{result:{ok:true,found:true,receipt:{status:'succeeded',result:{saved:true},revisionAfter:1}}}
        :{result:{ok:true,found:false,receipt:null}}
      return{result:{ok:true}}
    }}
  }
  const runtimePath=require.resolve('../utils/data-runtime'),memberPath=require.resolve('../utils/member-runtime')
  delete require.cache[runtimePath];delete require.cache[memberPath]
  const runtime=require('../utils/data-runtime'),member=require('../utils/member-runtime')
  storage.set(member.cacheKey(),{ok:true,environment:'production',dataRevision:0,member:{displayName:'测试会员',theme:'vitality'}})
  // ⚠️ 2026-10-05：`updateProfile` **带 displayName**（改显示名）现在是**测试区**功能，
  //    正式区会被门禁拦下（零云调用）。本段测的是"稳定幂等号 + 回执未知"这条链路，
  //    与"改的是哪个字段"无关 ⇒ 只带 theme（切主题是已上线功能，不该被挡）保持在正式区跑。
  let result=await member.command('updateProfile',{theme:'vitality'})
  const fixed=result.requestId
  assert.strictEqual(result.code,'MEMBER_RESULT_UNKNOWN','missing receipt must never be treated as success')
  assert.strictEqual(member.pending().length,1)
  assert.strictEqual(member.pending()[0].requestId,fixed)
  assert.strictEqual(calls.filter(row=>row.data.action==='execute')[0].data.requestId,fixed)
  mode='receipt-succeeded'
  result=await member.command('updateProfile',{theme:'vitality'})
  assert.strictEqual(result.ok,true)
  assert.strictEqual(result.requestId,fixed)
  assert.strictEqual(member.pending().length,0)
  assert.deepStrictEqual(calls.filter(row=>row.data.action==='execute').map(row=>row.data.requestId),[fixed,fixed],'timeout recovery must reuse the original requestId')

  runtime.setEnvironment(runtime.ENVIRONMENTS.SANDBOX)
  assert.strictEqual(member.cached(),null,'production member cache must not leak into sandbox')
  await member.read()
  assert.strictEqual(member.cached().environment,'sandbox')
  runtime.setEnvironment(runtime.ENVIRONMENTS.PRODUCTION)
  assert.strictEqual(member.cached().environment,'production')
  assert.strictEqual(member.cached().dataRevision,1)

  // 判别力：如果缓存键没有环境后缀，生产与 Sandbox 必然命中同一 key，本断言必须变红。
  assert.notStrictEqual('coachMemberActiveCache:production','coachMemberActiveCache:sandbox')
  console.log('member runtime tests: PASS (stable requestId, receipt unknown, cache isolation)')
}
run().catch(error=>{console.error(error);process.exitCode=1})
