const runtime=require('./data-runtime')
// ⭐⭐ 云函数名**只从这一个出处**取（2026-10-05）：测试区走**测试区专用的那个**会员身份云函数，
//    正式区走正式区共用的那个。⛔ 页面与本页面都不许自己拼云函数名（名字写在 routing 里，只有一处）。
//    ⚠️ 为什么不是"部署一份新代码到 memberIdentityCommand"：全项目只有一个云环境，
//       部署它 = 替换正式区共用的云函数。详见 `utils/sandbox-cloud-functions.js` 顶部。
const routing=require('./sandbox-cloud-functions')
const environment=()=>runtime.environment()==='sandbox'?'sandbox':'production'
const call=data=>wx.cloud.callFunction({name:routing.identityFunction(environment()),data}).then(result=>result&&result.result||result)
const requestId=action=>`coach_member_${action}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`
const pendingKey=()=>`coachMemberToolPending:${environment()}`
const pending=()=>{try{return wx.getStorageSync(pendingKey())||{}}catch(e){return{}}}
const save=value=>wx.setStorageSync(pendingKey(),value)
async function execute(command,payload){
  // ⛔ 测试区功能门禁（需求 3）：正式区**零云调用**，原样返回「该功能尚在安全测试中」。
  //    ⚠️ 这只是客户端第二道闸；云端 Sandbox 函数自己还有一道硬门禁（缺字段 / 拼错值 ⇒ 拒绝）。
  const gate=routing.reject(command,environment(),payload)
  if(gate)return gate
  // 🚨🚨 2026-10-06 真机（「生成15分钟有效邀请」一直转圈、教练再也点不动）：
  //   这一趟原本是裸 await —— 运输层任何失败（云函数 Updating / 断网 / 超时）都会从这里**抛出去**，
  //   页面那句 `this.setData({ inviteBusy:false })` 永远执行不到 ⇒ 按钮**永久转圈**。
  //   ⛔ 契约：`execute()` **永远返回对象**，⛔ 绝不向外抛异常 —— 失败是一种**结果**，不是一种崩溃。
  let meta
  try{meta=await call({action:'coachMetadata',environment:environment()})}
  catch(error){
    return {ok:false,code:'COACH_MEMBER_NETWORK_FAILED',message:'服务器暂时没有回应（可能正在部署，也可能网络不太稳）。请稍后再点一次。'}
  }
  if(!meta||!meta.ok)return meta
  const fingerprint=JSON.stringify(payload||{}),saved=pending(),prior=saved[command],id=prior&&prior.fingerprint===fingerprint?prior.requestId:requestId(command)
  saved[command]={requestId:id,fingerprint}
  // ⛔ 待补发队列写不进去（存储满 / 权限限制）**不许**把整次操作拖垮 ⇒ 退化成“这一趟没有本地幂等记录”。
  try{save(saved)}catch(error){}
  try{const result=await call({action:'coachExecute',command,payload:payload||{},requestId:id,expectedRevision:meta.coachRevision,environment:environment()});if(result&&result.ok){delete saved[command];save(saved)}else if(result&&result.code!=='COACH_MEMBER_RESULT_UNKNOWN'){delete saved[command];save(saved)}return result}
  catch(error){
    try{const receipt=await call({action:'getCoachReceipt',requestId:id,environment:environment()});if(receipt&&receipt.ok&&receipt.found&&receipt.receipt.status==='succeeded'){delete saved[command];save(saved);return{ok:true,...receipt.receipt.result,replayed:true}}}catch(e){}
    return{ok:false,code:'COACH_MEMBER_RESULT_UNKNOWN',message:'结果暂时无法确认，请不要重复点击。',requestId:id}
  }
}
// ⭐ 公开教练卡**回读**：与发布共用 `coachMetadata` 这一条链路 ⇒ 身份（可信 OPENID）与集合（当前环境）天然一致。
//    ⚠️ 读取失败必须**显式**返回失败，绝不能静默转成"还没注册过"的空对象（2026-09-28 真机 BUG 02 的教训）。
async function readProfile(){
  let result
  try{result=await call({action:'coachMetadata',environment:environment()})}catch(error){return{ok:false,code:'COACH_PROFILE_READ_FAILED',message:'公开教练卡读取失败，请检查网络后重试。'}}
  if(!result||!result.ok)return{ok:false,code:(result&&result.code)||'COACH_PROFILE_READ_FAILED',message:(result&&result.message)||'公开教练卡读取失败，请稍后重试。'}
  const profile=result.profile||null
  return{ok:true,environment:result.environment,profile:profile?{displayName:profile.displayName||'',avatar:profile.avatar||'',specialties:Array.isArray(profile.specialties)?profile.specialties:[],introduction:profile.introduction||'',publicCode:profile.publicCode||''}:null}
}
module.exports={execute,readProfile,environment,pendingKey}
