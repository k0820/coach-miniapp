const { GROUP_TITLE } = require('../../utils/constants')
const { getDB, saveDB, uid, timeStr, cacheKey, environment } = require('../../utils/data-runtime')
const { rescheduleBookingAligned, deleteCompletedBookingAligned } = require('../../utils/local-business-rules')
const { adapter, clearPending, operationId, officialIdForBooking, awaitOfficialBooking, subscribePendingBookings, bindingForOfficialId, pendingBookingRecords, pendingCancellationRecords, notifyPendingBookings, completionIntentFor } = require('../../utils/ui-cloud-command')
const mutate = require('../../utils/mutate')
const { resumeCompletion: runCompletionResume } = require('../../utils/completion-resume')
const { completedViewState } = require('../../utils/session-view')
const { createDraftCoordinator } = require('../../utils/draft-coordinator')
const pendingDraft = require('../../utils/pending-training-draft')
const pendingCompletion = require('../../utils/pending-completion')
const completionCopy = require('../../utils/completion-copy')
const completionTrace = require('../../utils/completion-trace')
const notifyConsent = require('../../utils/notify-consent')
// ★ §110：`draft_${draftKey}_…` 里的 draftKey 对未转正预约是 `pending:stu|pkg|date|h|m`，
//   含 `|` ⇒ 云端拒收。走同一份契约拿到确定性别名（同业务键永远同号，幂等不丢）。
const releaseFlags = require('../../utils/release-flags')
// M2 课时占用规则（plannedMinutes / 待确认）本机孪生 —— 与云端 occupancy.js 同口径。
const occupancy = require('../../utils/package-occupancy')
const trainingInsights = require('../../utils/training-insights')
function draftScope(){const cache=wx.getStorageSync(cacheKey());return{environment:environment(),datasetId:(cache&&cache.datasetId)||(adapter.getState&&adapter.getState().datasetId)}}
function classify(items){const gs=items.map(i=>i.group).filter(g=>g&&g!=='自定义'),d={};gs.forEach(g=>d[g]=(d[g]||0)+1);if(!gs.length)return'综合训练';const ks=Object.keys(d);if(ks.length===1)return GROUP_TITLE[ks[0]]||'综合训练';if((d['拉伸']||0)>gs.length/2)return'拉伸恢复';const top=ks.sort((a,b)=>d[b]-d[a])[0];return d[top]>gs.length-d[top]?(GROUP_TITLE[top]||'综合训练'):'综合训练'}
// 正式 bookingId → 这门课在「本机临时 id」阶段用过的草稿键。取不到就返回空串（绝不猜）。
// 用途见 localDraftKey()：转正前后必须落到同一个草稿键上，否则用户录的动作看起来丢了。
function localDraftAlias(officialId){
  if(!officialId)return ''
  try{
    const rows=typeof mutate.bookingViewKeys==='function'?mutate.bookingViewKeys():[]
    const hit=rows.find(row=>row.officialId===officialId)
    return hit&&hit.localId?hit.localId:''
  }catch(error){return ''}
}
Page({
  data:{booking:null,student:null,items:[],groupSections:[],notes:'',draftPending:false,cancelSheet:false,reschedule:false,editDate:'',editHour:7,editMinute:0,hours:Array.from({length:18},(_,i)=>i+7),done:false,completionPending:false,editingCompleted:false,completing:false,cancelling:false,legacyReadonly:false,cloudPrimary:false,diagnostic:null,diagnosticText:'',resumeAvailable:false,resumeBusy:false,category:'综合训练',summary:'',duration:60,durationOptions:[30,45,60],isStretch:false,dragIndex:-1,dragTarget:-1,dragOffset:0,dragRowHeight:0,devEntries:releaseFlags.devEntriesVisible()},
  noop(){},
  // o.id = 正式 bookingId；o.pending = 刚约完、云端还没转正时用的本机时段业务键。
  // 两者必有其一：本机编辑态用的是真实业务键，绝不伪造一个 bookingId 去跑正式命令。
  onLoad(o){
    // ⚠️ 真机根因修复（第 33 节）：小程序的路径参数是 URL 编码形式送达的。
    // 微信官方文档明确写了「this.options 中的路径参数需要 decodeURIComponent」。
    // 之前这里直接拿编码后的字符串当业务键用，于是课表刚约完点进课程时：
    //   本机待确认记录（键是 stu|pkg|date|hour|minute）在 pending 表里查不到，
    //   正式身份绑定也查不到 → load() 判定「这条预约不存在」→ 立刻 wx.navigateBack()。
    // 表现就是「看起来进了课程页但自动弹回课表，点几次都一样，等云端转正后才正常」。
    this.id=decodeParam(o&&o.id)
    this.pendingKey=decodeParam(o&&o.pending)
    this.localId=this.pendingKey?`pending:${this.pendingKey}`:this.id
    // 一个页面实例最多只自动返回一次（load() 会被 onShow 与订阅反复调用）。
    this.returned=false
    this.drafts=createDraftCoordinator()
    this.unsubscribe=null
    // 云端转正 / 待确认记录变化时，就地刷新一次：转正后同一个页面实例自动接到正式 booking 上。
    if(typeof subscribePendingBookings==='function')this.unsubscribe=subscribePendingBookings(()=>{if(!this.data.completing)this.load()})
  },
  onShow(){this.load()},
  onHide(){this.flushDraft()},
  // ⭐ M2 自动刷新：从课程详情返回 ⇒ 课表/学员/会员页要立刻拿到最新状态（完课、改期、取消都发生在这里）。
  onUnload(){require('../../utils/auto-refresh').request('sessionReturn');this.flushDraft();if(this.unsubscribe){try{this.unsubscribe()}catch(error){}this.unsubscribe=null}},
  // 训练草稿的本机键。转正前挂在 pending:<业务键> 上；转正后如果那个键下还有未云端确认的草稿，
  // 继续用它 —— 否则重新进入课程时读不到刚才录的动作，看起来像「丢了」。
  localDraftKey(){
    if(this.pendingKey)return `pending:${this.pendingKey}`
    if(!this.id)return ''
    const scope=draftScope()
    const bound=typeof bindingForOfficialId==='function'?bindingForOfficialId(this.id):null
    if(bound){
      const key=`pending:${bound.bookingKey}`
      if(scope&&scope.datasetId&&pendingDraft.get(scope.environment,scope.datasetId,key))return key
    }
    // ★ 转正前后必须落到**同一个**草稿键上。本机临时 bookingId 与云端正式 bookingId 是同一门课的
    //   两种写法：若只认当前这一个 id，那么在「秒约后进课程（本机 id）→ 后台转正 → 再进来（正式 id）」
    //   这一串里，第二次会拿正式 id 去找草稿，而草稿记在本机 id 下 —— 用户录的动作看起来丢了。
    //   所以先问一句「这门课的本机 id 是什么」，哪个键下确实有草稿就用哪个。
    //   判不准（查不到别名 / 两个键都没有草稿）时一律用当前 id —— 绝不猜、绝不新建一个键。
    if(scope&&scope.datasetId){
      const alias=localDraftAlias(this.id)
      if(alias&&pendingDraft.get(scope.environment,scope.datasetId,alias))return alias
    }
    return this.id
  },
  load(){
    const db=getDB()
    // 转正绑定：这条是本机待确认预约、而云端已经给出正式 bookingId 时，就地绑到同一个页面实例。
    // 不重新进页面、不清空正在编辑的内容、不会产生第二条 booking。
    if(this.pendingKey&&!this.id){const official=officialIdForBooking(this.pendingKey);if(official)this.id=official}
    // ★ 本机临时 id → 正式 id 的就地转正（1.1.6：预约改走本机先行之后才出现的窗口）。
    //   「秒约」路径下，课表块在头一两秒用的是本机临时 bookingId（loc_booking_…）。
    //   用户在这个窗口里点进课程，this.id 就抄下了这个临时身份；等同步引擎拿到云端正式 id
    //   并记进 idMap，**投影立刻改用正式 id**，而 this.id 不会自己改 ——
    //   下面那句 db.bookings.find(x=>x.id===this.id) 就会找不到，pendingKey 又为空，
    //   于是判定"这条预约不存在"→ navigateBack，把正在录训练内容的用户弹回课表。
    //   所以每次 load() 都先问一嘴身份：有映射就就地转正，之后所有命令都用正式 id。
    //   没有映射时原样返回，尚未转正的预约行为与之前逐字一致。
    if(this.id&&typeof mutate.resolveLocalId==='function')this.id=mutate.resolveLocalId(this.id)||this.id
    const fromCloud=this.id?db.bookings.find(x=>x.id===this.id):null
    // 还没转正（或刚转正但 cache 尚未刷到这条）→ 用本机待确认记录当课程本体，进入本机编辑态。
    const fromPending=this.pendingKey?(pendingBookingRecords().find(x=>x.pendingKey===this.pendingKey)||null):null
    const b=fromCloud||fromPending
    // 这条预约确实不存在了 → 自动退回课表。但取消/完课进行中时不再重复触发返回：
    // 那些流程本身已经安排了「第一帧立刻返回」，这里再调一次会连推两层页面。
    if(!b){
      if(this.data.cancelling||this.data.completing)return
      // 「刚约完就进课程」的页面有转正窗口：正式 cache 里查不到是正常的（stale cache），
      // 绝不能被理解成「这条预约不存在」。只要协调器还认为这条预约在办（本机待确认记录还在 /
      // 正式身份已绑定 / 取消仍在进行），就留在本页 —— 云端转正那一刻订阅会再调一次 load()，
      // 页面就地接到正式 booking 上，不需要重新点击、也不需要任何等待或重试。
      if(this.pendingKey&&this.stillKnownToCoordinator())return
      this.returnToSchedule()
      return
    }
    const s=db.students.find(x=>x.id===b.studentId),p=s&&(s.packages.find(x=>x.id===b.packageId)||s.packages[b.packageIndex]),scope=mutate.isCloudWritePath()?draftScope():null,draftKey=this.localDraftKey(),record=scope&&b.status==='booked'&&b.legacyRelationStatus!=='orphan'?pendingDraft.get(scope.environment,scope.datasetId,draftKey):null,view=record?{...b,...record.content}:b,items=view.items||[],isStretch=view.typeName==='拉伸恢复'||view.category==='拉伸恢复'||(items.length>0&&items.every(x=>x.group==='拉伸')),price=b.price!=null?b.price:(p&&p.type==='赠送课程'?80:Number(p&&p.price||0)),studentName=s?s.name:(b.studentName||'已删学员');
    // 本机完课意图：用户已经点过下课、云端结果还没落地。它与正式 done 是**同级的呈现依据** ——
    // 少了它，「刚下课就再点进来」会被当成一门待完成的课（真机上正是这个页面在引导用户再点一次下课，
    // 而那条链的训练内容安全门必然拒绝 → 弹出「训练内容没有在云端确认保存」的误报）。
    const completionEntry=this.completionIntentForBooking(),completed=b.status==='done'||!!completionEntry,completionPending=!!completionEntry&&b.status!=='done';
    // ★ 完课同步中（2026-09-28 真机）：LOCAL_FIRST 下完课意图在**本机事务成功那一刻就被撤掉**，
    //   而云端收敛要等 Outbox 落定 + 回读 ⇒ 上面那个 `completed` 此刻可能**只是本机投影**。
    //   课时 / 收入只在云端事务里产生，所以标题不能一律写「已完成」——那是在替云端宣布一件它还没做的事。
    //   ⚠ 只影响**呈现**：`done` / `completionPending` 的既有语义一个字都不动（它们还管着编辑与删除的闸门）。
    let completionSyncing=false
    try{
      const scope=draftScope()
      if(scope&&scope.datasetId&&this.id){
        const outboxModule=require('../../utils/local-outbox')
        const syncRows=require('../../utils/m2-shared-acceptance').completionSyncRows(outboxModule.openEntries(scope)||[],outboxModule.idMap(scope)||{})
        completionSyncing=!!syncRows[String(this.id)]
      }
    }catch(error){completionSyncing=false}
    // M2「待确认」：仍然 booked + 有 plannedMinutes + 已超过「预计结束 + 3 小时」。
    //   ⚠️ 它是**派生状态**：不落库、不自动扣课、不自动判缺席 —— 只在这里提示，由教练**人工**判定。
    //   老预约没有 plannedMinutes ⇒ 永远不参与这条规则（用户明确要求：不补默认值）。
    const pendingConfirm=!completed&&b.status==='booked'&&occupancy.isPendingConfirmation(b,Date.now()),pendingHours=pendingConfirm?overdueHoursOf(b,Date.now()):0;
    this.setData({booking:{...b,price,time:timeStr(b)},pendingConfirm,pendingHours,student:s||{name:studentName,packages:[]},items,groupSections:makeSections(items),notes:view.notes||'',draftPending:!!record,done:completed,completionPending,completionSyncing,editingCompleted:false,legacyReadonly:b.legacyRelationStatus==='orphan',cloudPrimary:mutate.isCloudWritePath(),category:isStretch?'拉伸恢复':view.category||'综合训练',summary:b.summary||'',duration:view.duration||60,isStretch,pendingBooking:!!fromPending&&!fromCloud})},
  // 这条待确认预约在本机是否还「在办」。四种身份任一成立即算：
  //   ① 正式身份已绑定（说明云端已经有这条预约，只是 cache 还没跟上）
  //   ② 本机待确认记录还在（create 命令还在路上 / 结果未知 / 正在同步）
  //   ③ 取消正在进行（tombstone 还在，块被隐藏但这条预约尚未定论）
  //   ④ 本机已经点过下课（完课意图还在，云端结果未落地）
  // 查询本身出错时保守地留在页面：宁可停在原地，也绝不把用户误弹回课表。
  stillKnownToCoordinator(){
    if(!this.pendingKey)return false
    try{
      if(this.completionIntentForBooking())return true
      if(typeof officialIdForBooking==='function'&&officialIdForBooking(this.pendingKey))return true
      if(typeof pendingBookingRecords==='function'&&pendingBookingRecords().some(item=>item.pendingKey===this.pendingKey))return true
      if(typeof pendingCancellationRecords==='function'&&pendingCancellationRecords().some(item=>item.localKey===this.pendingKey))return true
    }catch(error){return true}
    return false
  },
  // 自动返回课表只允许发生一次：load() 会被 onShow 与订阅回调反复触发，
  // 重复 navigateBack 会把课表自己也弹掉（真机上表现为「连退两层」）。
  returnToSchedule(){
    if(this.returned)return false
    this.returned=true
    wx.navigateBack()
    return true
  },
  // 「这门课在本机是否已经点过下课」（完课意图）。两种身份都要能命中：
  // 正式 bookingId（转正后从课表点进来），或本机编辑态用的 pending:<业务键>。
  completionIntentForBooking(){
    if(typeof completionIntentFor!=='function')return null
    // ★ localKey 必须用**进入页面时钉下的那份本机身份**（this.localId），不能用 this.id。
    //   理由：本机先行创建的预约，this.id 会在后台转正那一刻被就地换成正式 bookingId，
    //   而完课意图当初是按本机身份 begin() 的（pendingCompletion.begin 的 localKey 就是这个值）。
    //   如果这里跟着换成正式 id 去找，就会找不到自己的意图 ——
    //   表现是「刚点完下课，课程页又变回待完成」，一个不会自己纠正的谎。
    //   intentFor 两种身份任一命中即可，所以这里把两个都交出去，绝不赌是哪一个。
    return completionIntentFor({officialId:this.id||'',localKey:this.localId||(this.pendingKey?`pending:${this.pendingKey}`:'')})
  },
  // 本机编辑态下的幂等重确认入口：只向云端查一次结果，绝不盲目重发已发出的预约命令。
  retryBookingConfirmation(){if(!this.pendingKey)return;if(typeof mutate.retryPendingBooking==='function')mutate.retryPendingBooking(this.pendingKey)},
  startEditCompleted(){if(!this.data.done||this.data.legacyReadonly||this.data.completing)return;this.setData({editingCompleted:true})},
  cancelEditCompleted(){if(!this.data.editingCompleted||this.data.completing)return;this.load()},
  async saveCompletedContent(){
    if(!this.data.done||!this.data.editingCompleted||this.data.legacyReadonly||this.data.completing)return
    const payload=contentPayload(this.id,draftContent(this.data))
    this.setData({completing:true})
    try{
      if(mutate.isCloudWritePath())return await mutate(null,null,{key:`updateCompletedContent:${this.id}`,command:'updateBookingContent',payload,successTitle:'训练记录已修改',onSuccess:()=>this.load(),onRefresh:()=>this.load()})
      const db=getDB(),booking=db.bookings.find(item=>item.id===this.id)
      if(!booking||booking.status!=='done'||booking.legacyRelationStatus==='orphan')return wx.showToast({title:'课程状态已变化',icon:'none'})
      Object.assign(booking,{items:payload.items,notes:payload.notes,category:payload.category,duration:payload.duration})
      booking.summary=buildSummary(booking.studentName||this.data.student.name,booking,booking.items,booking.category,booking.notes,booking.completedAt)
      saveDB(db);this.load();wx.showToast({title:'训练记录已修改'})
    }finally{this.setData({completing:false})}
  },
  async fetchCompletionDiagnostic(){try{const runtime=require('../../utils/data-runtime'),response=await wx.cloud.callFunction({name:'diagnoseCoachCompletion',data:{action:'diagnose',environment:runtime.environment(),bookingId:this.id}});return response.result}catch(error){return{ok:false,code:'DIAGNOSTIC_CALL_FAILED',message:error.errMsg||error.message}}},
  async diagnoseCompletion(){if(!this.data.cloudPrimary)return;wx.showLoading({title:'只读诊断'});const result=await this.fetchCompletionDiagnostic();wx.hideLoading();this.setData({diagnostic:result,diagnosticText:JSON.stringify(result,null,2),resumeAvailable:!!(result&&result.ok&&result.strict&&result.state==='C_CONTENT_SUCCEEDED_COMPLETE_NOT_SUCCEEDED')});const state=result&&result.state,title=state==='B_BOTH_COMMANDS_SUCCEEDED'?'训练与完课均已成功':state==='C_CONTENT_SUCCEEDED_COMPLETE_NOT_SUCCEEDED'?'训练内容已保存，课程未完成':state==='A_BOTH_COMMANDS_NOT_SUCCEEDED'?'两条命令均未成功':'只读诊断发现异常';wx.showModal({title,content:result&&result.ok?`当前 revision：${result.dataRevision}\nBooking：${result.booking.status}\nIncome：${result.incomes.length} 条\n请勿重新点击原完课按钮。`:(result&&result.message||result&&result.code||'诊断失败'),showCancel:false,confirmText:'知道了'});return result},
  async resumeCompletion(){if(!this.data.resumeAvailable||this.data.resumeBusy)return;const confirmed=await new Promise(resolve=>wx.showModal({title:'安全继续完课',content:'训练内容已经保存在云端。本次只执行完课，不会再次保存或覆盖训练内容。是否继续？',confirmText:'继续完课',cancelText:'取消',success:r=>resolve(!!r.confirm),fail:()=>resolve(false)}));if(!confirmed)return;clearTimeout(this.draftTimer);this.drafts.reset();this.setData({resumeBusy:true});wx.showLoading({title:'正在安全续跑'});const requestId=`resumeCompleteBooking_${this.id}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`,result=await runCompletionResume({bookingId:this.id,baseline:this.data.diagnostic,requestId,diagnose:()=>this.fetchCompletionDiagnostic(),execute:(command,payload,options)=>mutate.raw(command,payload,options)});wx.hideLoading();this.setData({resumeBusy:false,diagnostic:result.after||result.before||this.data.diagnostic,diagnosticText:JSON.stringify(result,null,2),resumeAvailable:!!(result.after&&result.after.state==='C_CONTENT_SUCCEEDED_COMPLETE_NOT_SUCCEEDED'&&result.after.strict)});if(result.ok){await this.load();const view=completedViewState(this.data,result.after.booking);this.setData({...view,groupSections:makeSections(view.items)});return wx.showModal({title:'课程已安全完成',content:'云端已确认：课程完成、课时仅扣除一次、收入仅生成一条，训练内容保持不变。',showCancel:false,confirmText:'知道了'})}wx.showModal({title:result.code==='RESUME_RESULT_PENDING'?'结果仍在确认':'安全续跑未完成',content:'没有再次提交训练内容，也不会自动重复完课。请保留当前页面并查看下方只读结果。',showCancel:false,confirmText:'知道了'})},
  addExercise(e){if(this.data.completing||(this.data.done&&!this.data.editingCompleted))return;if(this.data.items.some(x=>x.name===e.detail.name))return wx.showToast({title:'已添加过',icon:'none'});const timed=this.data.isStretch||e.detail.group==='拉伸',items=this.data.items.concat({...e.detail,sets:timed?'':4,reps:timed?'':12,weight:'',minutes:timed?15:''});this.setData({items,groupSections:makeSections(items),category:classify(items)});this.queueDraft();wx.showToast({title:'已添加',icon:'success'})},
  itemInput(e){if(this.data.completing||(this.data.done&&!this.data.editingCompleted))return;const {i,k}=e.currentTarget.dataset,items=this.data.items;items[i][k]=e.detail.value;this.setData({items,groupSections:makeSections(items)});this.queueDraft()},remove(e){if(this.data.completing||(this.data.done&&!this.data.editingCompleted))return;const items=this.data.items.filter((_,i)=>i!==+e.currentTarget.dataset.i);this.setData({items,groupSections:makeSections(items),category:classify(items)});this.queueDraft()},notes(e){if(this.data.completing||(this.data.done&&!this.data.editingCompleted))return;this.setData({notes:e.detail.value});this.queueDraft()},
  dragStart(e){if((this.data.done&&!this.data.editingCompleted)||this.data.completing)return;const index=+e.currentTarget.dataset.i,touch=e.touches&&e.touches[0];if(!touch)return;this.dragStartY=touch.clientY;this.dragLastFrame=0;wx.createSelectorQuery().selectAll('.exercise-row').boundingClientRect(rects=>{if(!rects||rects.length!==this.data.items.length)return;this.dragRects=rects;this.setData({dragIndex:index,dragTarget:index,dragOffset:0,dragRowHeight:rects[index].height})}).exec()},
  dragMove(e){if(this.data.dragIndex<0||!this.dragRects)return;const touch=e.touches&&e.touches[0];if(!touch)return;const now=Date.now();if(now-this.dragLastFrame<16)return;this.dragLastFrame=now;const dragOffset=touch.clientY-this.dragStartY,from=this.data.dragIndex,center=this.dragRects[from].top+this.dragRects[from].height/2+dragOffset;let dragTarget=0;for(let i=0;i<this.dragRects.length;i++){if(center>=this.dragRects[i].top+this.dragRects[i].height/2)dragTarget=i}dragTarget=Math.max(0,Math.min(this.data.items.length-1,dragTarget));this.setData({dragOffset,dragTarget})},
  dragEnd(e){const from=this.data.dragIndex;if(from<0)return;if(e&&e.changedTouches&&e.changedTouches[0]&&this.dragRects){const dragOffset=e.changedTouches[0].clientY-this.dragStartY,center=this.dragRects[from].top+this.dragRects[from].height/2+dragOffset;let dragTarget=0;for(let i=0;i<this.dragRects.length;i++){if(center>=this.dragRects[i].top+this.dragRects[i].height/2)dragTarget=i}this.data.dragTarget=Math.max(0,Math.min(this.data.items.length-1,dragTarget))}const to=this.data.dragTarget,items=this.data.items.slice();if(to!==from){const moved=items.splice(from,1)[0];items.splice(to,0,moved)}this.dragRects=null;this.setData({items,groupSections:makeSections(items),category:classify(items),dragIndex:-1,dragTarget:-1,dragOffset:0,dragRowHeight:0});if(to!==from)this.queueDraft()},
  dragCancel(){this.dragRects=null;this.setData({dragIndex:-1,dragTarget:-1,dragOffset:0,dragRowHeight:0})},
  setDuration(e){if(this.data.completing||(this.data.done&&!this.data.editingCompleted))return;this.setData({duration:+e.currentTarget.dataset.value});this.queueDraft()},
  async persistDraft(){
    // 正在取消：这份内容已经不需要提交了，绝不能写给一条正在被取消（或已取消）的课程。
    if(this.data.cancelling)return{ok:true,skipped:true}
    const scope=draftScope(),draftKey=this.localDraftKey(),content=draftContent(this.data)
    if(!mutate.isCloudWritePath()){const db=getDB(),local=db.bookings.find(x=>x.id===this.id);if(!local||this.data.legacyReadonly||local.status!=='booked')return{ok:false,code:'DRAFT_NOT_WRITABLE'};Object.assign(local,content);delete local.bookingId;saveDB(db);return{ok:true}}
    if(this.data.legacyReadonly)return{ok:false,code:'DRAFT_NOT_WRITABLE'}
    if(!scope.datasetId)return{ok:false,code:'DRAFT_DATASET_UNKNOWN'}
    // 还没转正（刚约完就进来录内容）：云端还没有这条 booking，绝不能提交 updateBookingContent。
    // 只写本机草稿；等内容转正后由 flush 走正常云端通道，动作一条不丢。
    if(!this.id){
      try{pendingDraft.write(scope.environment,scope.datasetId,draftKey,content)}catch(error){return{ok:false,code:'DRAFT_LOCAL_WRITE_FAILED'}}
      // 阶段 2：预约还没转正时，内容也**先进持久 Outbox**（按本机引用排队），
      // 等预约在云端转正后由同步引擎补上正式 bookingId 再送 —— 断网录的内容一条都不会丢。
      // coalesceKey：防抖保存的中间态可以被后来者就地取代（只取代"从未发出去过"的那一条）。
      if(mutate.localFirstEnabled()){
        const queued=await mutate(null,null,{strategy:mutate.STRATEGIES.SILENT,key:`updateBookingContent:${draftKey}`,command:'updateBookingContent',payload:contentPayload('',content),ref:{kind:'booking',localKey:this.pendingKey||draftKey},coalesceKey:`draft:${draftKey}`})
        if(queued&&!queued.ok&&queued.code!=='LOCAL_FIRST_UNAVAILABLE')return{ok:false,code:queued.code||'DRAFT_QUEUE_FAILED'}
      }
      return{ok:true,local:true}
    }
    const db=getDB(),b=db.bookings.find(x=>x.id===this.id)
    // ★ 1.1.9 第 6 轮：预约命令成功之后本机 cache **不再立刻补齐**（只做一跳只读校验），
    //   所以「cache 里找不到这条」不再等于「这条预约不可写」—— 它可能只是还没被下一次
    //   完整回读带回来。用户「约完课立刻进课程页录动作」走的正是这条路。
    //   已转正（this.id 有值）本身就是一条独立证据：正式身份来自命令返回体；
    //   若本机还保有它的**活绑定**，就足以确认「这条预约在本机有身份、云端存在」，
    //   按下面的 Outbox 契约继续走，绝不因为本机落后就把刚录的内容拦在门外。
    //   ⚠️ 边界不放宽：cache 里**确实有**这条记录时，仍然严格按它的 status 判 ——
    //      「已完 / 已取消」是算得出来的业务状态，绝不放行。
    const binding=b?null:(typeof bindingForOfficialId==='function'?bindingForOfficialId(this.id):null)
    if(b?b.status!=='booked':!binding)return{ok:false,code:'DRAFT_NOT_WRITABLE'}
    // Stage 2：正式旧 booking 与新预约转正后使用同一份持久 Outbox 契约。
    // 旧 Cloud-primary submission 可能停在 unknown；它不是本机投影/队列的提交凭证，
    // 也不能阻断本机先行完课。只有本次内容确实进入 Outbox 后才允许 flush 通过。
    if(mutate.localFirstReady()){
      let record=pendingDraft.get(scope.environment,scope.datasetId,draftKey)
      if(!record){try{record=pendingDraft.write(scope.environment,scope.datasetId,draftKey,content)}catch(error){return{ok:false,code:'DRAFT_LOCAL_WRITE_FAILED'}}}
      const queued=await mutate(null,null,{strategy:mutate.STRATEGIES.SILENT,key:`updateBookingContent:${this.id}`,command:'updateBookingContent',payload:contentPayload(this.id,record.content),coalesceKey:`draft:${draftKey}`})
      if(!queued||!queued.ok)return{ok:false,code:queued&&queued.code||'DRAFT_QUEUE_FAILED'}
      // 内容已落定的判据 = 「排进了本机持久队列」（local-first）。
      // 本机投影还没跟上这条预约时，本机事务算不出来 —— 那条命令会按既有的 deferred 语义
      // **照常入队**（见 mutate 的 LOCAL_TARGET_MISSING），path 仍是 local-first。
      if(queued.path!==mutate.PATHS.LOCAL_FIRST)return{ok:false,code:'DRAFT_QUEUE_FAILED'}
      // 入 Outbox 只证明本机已接收，尚不代表云端已保存。草稿必须留到
      // sync-engine 拿到成功结果/receipt 后按内容逐字相同再删除；明确拒绝时仍可找回动作。
      this.setData({draftPending:!!pendingDraft.get(scope.environment,scope.datasetId,draftKey)})
      return queued
    }
    const submission=pendingDraft.begin(scope.environment,scope.datasetId,draftKey,()=>`draft_${draftKey}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`);if(!submission)return{ok:true,skipped:true}
    const commandKey=`updateBookingContent:${this.id}`
    let result
    if(submission.status==='unknown'){const receipt=await adapter.getReceipt(submission.requestId);if(receipt.ok&&receipt.found&&receipt.status==='succeeded'){const refreshed=await adapter.readActive();result=refreshed.ok?{ok:true,recoveredFromReceipt:true}:{ok:false,code:'DRAFT_CLOUD_VERIFICATION_PENDING'}}else if(receipt.ok&&receipt.found&&receipt.status==='failed')result=receipt.response||{ok:false,code:'DRAFT_SAVE_FAILED'};else result={ok:false,code:'COMMAND_RESULT_UNKNOWN'}}
    // 走静默通道：安全语义与 runCommand 一致，但不弹全屏「正在保存」遮罩 ——
    // 那层遮罩就是「选动作不能秒回」的真凶（数据层早已写在本机，是遮罩吃掉了后续触摸）。
    else result=await mutate(null,null,{strategy:mutate.STRATEGIES.SILENT,key:commandKey,command:'updateBookingContent',requestId:submission.requestId,payload:contentPayload(this.id,submission.content)})
    // ★ 「训练内容已经确认保存在云端」的判据 = **服务端事务已经提交**，而不是「这次回读刚好成功」（第 36 节）。
    //   这两件事不是一回事：回读要把 metadata + 八个集合分页 + integrity 全部走完（十几次往返），
    //   任何一条并发写入落进这个窗口都会让它整体失败 —— 而那条命令**早已提交成功**
    //   （receipt 与业务写在同一个事务里，core.js:137-150）。
    //   把「本机同步进度」当成「云端确认结果」，就会把一次成功的保存误报成「训练内容没有在云端确认保存」：
    //   上一节的完课链/重同步还在跑时约下一节，从第 2 节开始每次都撞这个窗口。
    //   ⚠️ 安全门一毫米都不降：放行的前提是**拿到「云端确实已提交」的确凿证据**
    //   （命令提交回执，或按本次提交的 requestId 查到 receipt=succeeded）。拿不到证据就照旧拒绝；
    //   而且服务端 completeBooking 另有 TRAINING_ITEMS_REQUIRED 兜底（内容没落库，完课命令在云端直接被拒）。
    const committed=!!(result&&result.ok)
    let confirmed=committed&&!result.refreshFailed
    if(committed&&!confirmed)confirmed=await this.reverifyDraft(submission.requestId)
    const unsettled=!!result.refreshFailed||(!committed&&(result.code==='COMMAND_RESULT_UNKNOWN'||result.code==='REQUEST_PROCESSING'))
    if(submission.status==='unknown'&&(confirmed||(!committed&&result.code!=='COMMAND_RESULT_UNKNOWN'&&result.code!=='DRAFT_CLOUD_VERIFICATION_PENDING')))clearPending&&clearPending(commandKey,submission.requestId)
    pendingDraft.settle(scope.environment,scope.datasetId,draftKey,submission.requestId,confirmed?'succeeded':(unsettled?'unknown':'failed'))
    this.setData({draftPending:!!pendingDraft.get(scope.environment,scope.datasetId,draftKey)})
    if(confirmed)return result
    return{ok:false,code:result.refreshFailed?'DRAFT_CLOUD_VERIFICATION_PENDING':(result.code||'DRAFT_SAVE_FAILED')}
  },
  // 命令已提交、只是那次回读没成功时的「补一次确凿证据」。
  // 顺序：① 先做一次有界重同步（成功等于本机 cache 也跟上了，最理想）；
  //       ② 仍不成功就查**本次提交的那条 requestId** 的回执 —— receipt 与业务写在同一事务里，
  //          succeeded 就是「云端确实保存了这份内容」的服务端权威证据。
  // 绝不接受"别的回执"、也绝不重发（请求号是草稿持久化固定的，只有用户再次保存才可能换号）。
  async reverifyDraft(requestId){
    const refreshed=await adapter.readActive().catch(()=>({ok:false}))
    if(refreshed&&refreshed.ok)return true
    const receipt=await adapter.getReceipt(requestId).catch(()=>({ok:false}))
    return !!(receipt&&receipt.ok&&receipt.found&&receipt.status==='succeeded')
  },
  saveDraft(){return this.drafts.save(()=>this.persistDraft())},
  async confirmPendingDraft(){if(this.data.completing)return;if(!this.id)return wx.showToast({title:'预约正在云端确认，稍后会自动保存',icon:'none'});this.drafts.markDirty();const result=await this.flushDraft();if(result.ok)this.load();else wx.showToast({title:'云端尚未确认保存',icon:'none'});return result},
  queueDraft(){if(this.data.completing||this.data.cancelling||this.data.done)return;if(mutate.isCloudWritePath()){try{const scope=draftScope(),draftKey=this.localDraftKey();if(!draftKey)return;pendingDraft.write(scope.environment,scope.datasetId,draftKey,{items:this.data.items,notes:this.data.notes,category:this.data.isStretch?'拉伸恢复':this.data.category,duration:this.data.duration});this.setData({draftPending:true})}catch(error){wx.showModal({title:'训练内容未安全保存',content:'本机临时保存失败，请勿离开本页或完课。',showCancel:false,confirmText:'知道了'});return}}this.drafts.markDirty();clearTimeout(this.draftTimer);this.draftTimer=setTimeout(()=>this.saveDraft(),260)},
  flushDraft(){clearTimeout(this.draftTimer);if(this.data.cancelling||!this.data.booking)return Promise.resolve({ok:true,skipped:true});const localRef=this.pendingKey||this.localId;if(!this.id&&!(mutate.localFirstEnabled()&&localRef))return Promise.resolve({ok:true,skipped:true});return this.drafts.flush(()=>this.persistDraft())},
  async complete(){
    clearTimeout(this.draftTimer)
    if(this.data.cancelling||this.data.legacyReadonly)return
    // ★★ 同一门课只允许一条完课链（1.1.9 第 2 轮）。
    //    旧代码在这里是**三合一静默 return**：`completing`（本页在跑）/ 完课意图还在 / 已经完成。
    //    后果是真机上最坏的一种形状 —— 用户点了、界面什么都没发生，也没有任何人去把这条链跑完，
    //    唯一出路是"再点一次"，而第二次会**新开第二轮流程**。
    //    现在拆成三条互斥的路，每一条都留诊断记录、都有明确结果，**绝不静默丢点击**：
    //      ① 本页还有一条在跑的链   → 复用**同一个句柄**（不新开第二轮、也不丢掉这次点击）
    //      ② 有完课意图但链不在本页 → 只**查回执 + 重同步 + 补复制**，沿用意图里那枚固定
    //                                 requestId，**绝不重新执行 completeBooking**
    //      ③ 已经正式完成           → 只记一条诊断，不再开轮（UI 上这时按钮本来就不显示）
    const chain=this.completionChainFor()
    if(chain){this.noteCompletionTap('REUSED_CHAIN');return chain}
    if(this.data.done){this.noteCompletionTap('ALREADY_DONE');return{ok:true,noop:true,code:'ALREADY_DONE'}}
    if(!this.data.isStretch&&!this.data.items.length){this.noteCompletionTap('NO_ITEMS');return wx.showToast({title:'请先添加动作',icon:'none'})}
    if(!mutate.isCloudWritePath()){this.noteCompletionTap('LOCAL_MODE');return this.completeLocally()}
    const db=getDB(),current=this.id?db.bookings.find(x=>x.id===this.id):null
    if(current&&current.status==='done'){this.noteCompletionTap('ALREADY_DONE');return{ok:true,noop:true,code:'ALREADY_DONE'}}
    // 第一帧：立刻结束编辑并回到课表 —— 用户不必等云端事务跑完。
    // 但正式财务事实（done / 精确扣 1 节课 / Income 恰好 1 条）仍然只由云端事务产生，
    // 绝不在确认前写进 cache；本机只留一条「完课意图」标记供课表显示。
    this.setData({completing:true})
    const handle=this.runOptimisticCompletion()
    this.setCompletionChain(handle)
    if(typeof setTimeout==='function')setTimeout(()=>{this.returnToSchedule()},0)
    return handle
  },
  // ———————— 同一门课只允许一条完课链（1.1.9 第 2 轮）————————
  // 记下本页那条链的**句柄**（不是裸 promise：调用方拿到的东西在两条路上必须是同一个形状）。
  // 链一收敛就清掉；清掉之后「复用」改由完课意图那一层负责。
  setCompletionChain(handle){
    this.completionHandle=handle
    const settled=handle&&handle.settled
    if(!settled||typeof settled.then!=='function')return
    const clear=()=>{if(this.completionHandle===handle)this.completionHandle=null}
    settled.then(clear,clear)
  },
  // 返回一条「已经存在的完课链」的句柄；没有就返回 null（= 可以新开一轮）。
  // ⚠️ 两条路的返回值形状必须一致（都是 {ok,deferred,localId,settled}），
  //    否则调用方（以及测试）就得靠猜"这一次返回到底是什么"。
  completionChainFor(){
    if(this.completionHandle)return this.completionHandle
    const scope=draftScope(),localId=this.localId||this.id
    let intent=null
    try{intent=pendingCompletion.get(scope.environment,scope.datasetId,localId)}catch(error){intent=null}
    if(!intent||!intent.requestId)return null
    return this.reuseCompletionIntent({environment:scope.environment,datasetId:scope.datasetId,localId,requestId:intent.requestId})
  },
  // 复用一条**已经存在**的完课意图：只查回执、只重同步、只补复制。
  // ⚠️ 这里刻意不调用 mutate / 不发 completeBooking：号码虽然一样（云端 receipt 幂等），
  //    但"永远不可能出现第二条业务事实"这一条比"少一次重试"重要得多。
  // ⚠️ 回执判据必须分类，且只留一个安全出口：
  //      `查询失败(ok=false)` ≠ `云端确认没有(found=false)`；
  //      这里两种情况**都不重发**，只如实说"结果仍在确认中"，把重发交给既有的
  //      self-heal（只查回执 + 重同步、有界）去决定。
  reuseCompletionIntent({environment,datasetId,localId,requestId}){
    const settled=(async()=>{
      const mark=completionTrace.mark({environment,datasetId,localKey:localId,requestId,officialId:this.id||''})
      try{
        this.setData({completing:true})
        let receipt=null
        try{receipt=await adapter.getReceipt(requestId)}catch(error){receipt=null}
        if(receipt&&receipt.ok&&receipt.found&&receipt.status==='succeeded'){
          const refreshed=await adapter.readActive().catch(()=>({ok:false}))
          if(refreshed&&refreshed.ok){try{pendingCompletion.remove(environment,datasetId,localId,requestId)}catch(error){}}
          try{notifyPendingBookings()}catch(error){}
          const copy=await this.settleCompletionCopy({environment,datasetId,localId,requestId})
          completionTrace.finish(mark,{branch:refreshed&&refreshed.ok?'REUSED_RECEIPT_SUCCEEDED':'REUSED_RECEIPT_SYNC_PENDING',localTxApplied:!!(refreshed&&refreshed.ok),clipboardCalled:!!(copy&&copy.called),clipboardOk:!!(copy&&copy.copied),waitedOfficialMs:0,skipped:'NO_NEW_COMMAND',note:'RECEIPT_RESYNC'})
          return{ok:true,code:'REUSED_RECEIPT_SUCCEEDED',copy}
        }
        if(receipt&&receipt.ok&&receipt.found&&receipt.status==='failed'){
          if(this.data.completing)this.setData({completing:false})
          completionTrace.finish(mark,{branch:'REUSED_RECEIPT_FAILED',localTxApplied:false,waitedOfficialMs:0,skipped:'NO_NEW_COMMAND',note:(receipt.response&&(receipt.response.code||receipt.response.message))||''})
          this.failCompletion(localId,'课程未完成',(receipt.response&&receipt.response.message)||'云端已明确这次下课没有生效，你录的内容仍保留在本机。')
          return{ok:false,code:'REUSED_RECEIPT_FAILED'}
        }
        if(this.data.completing)this.setData({completing:false})
        completionTrace.finish(mark,{branch:'REUSED_RECEIPT_PENDING',localTxApplied:null,waitedOfficialMs:0,skipped:'NO_NEW_COMMAND',note:(receipt&&receipt.code)||(receipt&&receipt.found===false?'RECEIPT_NOT_FOUND':'RECEIPT_UNKNOWN')})
        wx.showModal({title:'结果待确认',content:'这节课的完课结果还在云端确认中，不会重复扣课时、也不会重复记收入。稍后回到本页会自动继续确认。',showCancel:false,confirmText:'知道了'})
        return{ok:false,code:'REUSED_RECEIPT_PENDING'}
      }catch(error){
        if(this.data.completing)this.setData({completing:false})
        completionTrace.finish(mark,{branch:'REUSED_CHAIN_ERROR',waitedOfficialMs:0,skipped:'NO_NEW_COMMAND',note:String((error&&error.message)||error)})
        return{ok:false,code:'REUSED_CHAIN_ERROR'}
      }
    })()
    return{ok:true,deferred:true,reused:true,localId,settled}
  },
  // 点击被守卫拦下时也要留一条 —— "停在哪个 branch" 必须能被分辨出来。
  noteCompletionTap(branch,note){
    try{
      const scope=draftScope()
      completionTrace.note({environment:scope.environment,datasetId:scope.datasetId,localKey:this.localId||this.id,requestId:'',officialId:this.id||''},{branch,skipped:'TAP_GUARD',note})
    }catch(error){}
  },
  // ———————— 下课链的收尾：完课 + 自动复制课程内容（1.1.9）————————
  //
  // 用户的一次点击是一个**完整动作**，不是"下课"和"复制"两件事：
  //   完课 + 正确扣课 + 正确生成收入 + 把本节课程内容自动复制到剪贴板。
  // 所以这里的成功判据**同时**要求两件事成立，缺一不可：
  //   ① 核心完课结果正确（已在调用前确认）  ② 剪贴板确认写入成功。
  //
  // 安全边界（这几条决定了"不可能二次完课"）：
  //   · 复制阶段**只碰剪贴板**，从头到尾不发任何业务命令 —— 它连 mutate 都不 require；
  //   · 复制失败**只**重试复制，绝不重跑 completeBooking（否则会二次扣课、二次记收入）；
  //   · 顺序不能反：先落「待复制」标记（文本持久化）→ 再试剪贴板。
  //     反过来的话，试完剪贴板、还没来得及记账就被杀掉，要发的内容就永久丢了。
  //   · 复制没成功 → **不显示成功**，也**不要求用户做任何事**：
  //     「待复制」记录留着（= 这次下课操作还没完整完成），进入课表时的恢复轮会自动再试。
  //
  // 复制文本的来源见 completionCopyText()：优先取事务算出来的那一份（与云端逐字同源）。
  completionCopyText(){
    const student=this.data.student||{},booking=this.data.booking||{}
    // ① 投影里的权威摘要：完课一旦在本机事务里成立，这条 booking 就带着
    //    与云端同源的 handlers 写下的 summary。这是首选，因为它与云端落库的那一份逐字一致。
    try{
      const id=this.id||(typeof mutate.resolveLocalId==='function'?mutate.resolveLocalId(this.localId):'')
      if(id){
        const projected=getDB().bookings.find(item=>item.id===id)
        if(projected&&projected.summary)return completionCopy.buildCopyText(projected,student.name||projected.studentName)
      }
    }catch(error){}
    // ② 取不到（例如预约还没转正、这次本机事务是"延后执行"）→ 按**同一份规则**就地重建。
    //    显式把 summary 清空：要的是"现在这一版内容"，不是 booking 上可能残留的旧摘要。
    return completionCopy.buildCopyText({...booking,summary:'',duration:this.data.duration,items:this.data.items,notes:this.data.notes,category:this.data.isStretch?'拉伸恢复':this.data.category},student.name||booking.studentName)
  },
  completionCareText(){
    const booking=this.data.booking||{}
    return trainingInsights.completionCare(this.data.items,this.data.isStretch?'拉伸恢复':this.data.category,`${booking.id||this.id||''}:${booking.date||''}:${booking.hour||''}`)
  },
  showCompletionCare(copyNote){
    if(this.completionCareShown)return
    this.completionCareShown=true
    wx.showModal({title:'本节训练已记录',content:`${this.completionCareText()}\n\n${copyNote}`,showCancel:false,confirmText:'知道了',success:()=>{}})
  },
  // 复制阶段。返回 {ok, copied, code}；**不改动**任何业务状态。
  async settleCompletionCopy({environment,datasetId,localId,requestId}){
    const showCare=this.data.completing===true
    const text=this.completionCopyText()
    if(!text){
      // 没有可复制的内容（理论上到不了这里：没有训练动作根本不允许完课）。
      // 不建立"待复制"记录 ⇒ 也永远不会假装复制过。
      if(this.data.completing)this.setData({completing:false})
      return{ok:false,copied:false,called:false,code:'COPY_TEXT_UNAVAILABLE'}
    }
    try{completionCopy.begin(environment,datasetId,localId,text,requestId)}catch(error){}
    const result=await completionCopy.flush(environment,datasetId,localId)
    if(this.data.completing)this.setData({completing:false})
    if(result&&result.ok){
      // ★ 只有走到这里，UI 才显示"这次完整操作成功"。
      if(showCare)this.showCompletionCare('课程内容已复制，可以直接粘贴发送给会员。')
      return{ok:true,copied:true,called:true,code:'COMPLETED_AND_COPIED'}
    }
    // 复制暂时没确认成功：如实说"已完成、内容在复制中"，**不显示成功**、**不要求用户动手**。
    // 恢复轮会在下一次页面显示时自动补上（只试剪贴板）。
    if(showCare)this.showCompletionCare('课程已经安全完成，训练内容会继续在后台复制。')
    return{ok:false,copied:false,called:!!(result&&result.called),code:(result&&result.code)||'CLIPBOARD_WRITE_FAILED'}
  },
  // 乐观完课的后台链。返回句柄：UI 不等它，测试/诊断可以 await handle.settled。
  runOptimisticCompletion(){
    const scope=draftScope(),env=scope.environment,datasetId=scope.datasetId,localId=this.localId||this.id
    const commandKey=`completeBooking:${localId}`
    const settled=(async()=>{
      // ★ 完课诊断账本（1.1.9 第 2 轮）：整条链共用**同一个 mark**，每个出口统一 finish，
      //   于是「这一次点击停在哪一个 branch、课时/收入/summary 各自变了没有」永远有答案，
      //   不必再靠读代码推理（上一轮就是推理出来的结论拿不到现场证据，所以不能当根因）。
      //   本模块只读投影、只写 Storage，绝不发命令。
      const mark=completionTrace.mark({environment:env,datasetId,localKey:localId,requestId:operationId(commandKey),officialId:this.id||''})
      let waitedOfficialMs=0
      try{
        // ① bookingId 的解析**放到训练内容落定之后**：阶段 2 起「内容落定」不再依赖正式 id
        //    （内容会先按本机引用排进持久队列），所以先保住内容，再决定用正式 id 还是本机引用。
        let requestId=operationId(commandKey)
        let entry=null
        try{
          entry=pendingCompletion.begin(env,datasetId,localId,this.id,()=>requestId,Date.now()).entry
          // begin 对「同一课程」是幂等的：它会把第一次定下的固定 requestId 持久化下来。
          // 若本机内存里的 operationId 已经被重置（典型：杀掉小程序再进来），
          // 必须沿用持久化的那一个 —— 否则 timeout/unknown 后的重试会换号，等于盲目重发。
          if(entry&&entry.requestId&&entry.requestId!==requestId){requestId=entry.requestId;mark.requestId=requestId}
        }catch(error){entry=null}
        try{notifyPendingBookings()}catch(error){}
        // ② 训练内容必须先落定 —— 绝不为「秒结束」让刚录的动作丢失。
        //    阶段 2 起「落定」= 已经算进本机投影 **且** 已经进了持久 Outbox（不再要求"这一帧就在云端确认"）。
        this.drafts.markDirty()
        const draft=await this.flushDraft()
        if(!draft||!draft.ok){
          completionTrace.finish(mark,{branch:'DRAFT_NOT_CONFIRMED',localTxApplied:false,clipboardCalled:false,clipboardOk:false,waitedOfficialMs:0,skipped:'DRAFT_FLUSH',note:(draft&&draft.code)||''})
          this.failCompletion(localId,'课程未完成','训练内容没有安全保存，本次没有完课。你录的内容已保留在本机，可回到课程继续。')
          return{ok:false,code:'DRAFT_NOT_CONFIRMED'}
        }
        // ①b 待确认预约还没转正：**先用本机引用把这一节排进持久队列**（号不变、顺序不变），
        //     等它在云端转正后由同步引擎补上正式 bookingId 再送 —— 断网也不会把这一节弄丢。
        //     拿不到正式 id 也拿不到本机引用时，仍然明确失败，绝不编造 id 去跑正式命令。
        if(!this.id){
          const localRef=this.pendingKey||this.localId
          if(mutate.localFirstEnabled()&&localRef){
            const queued=await mutate(null,null,{strategy:mutate.STRATEGIES.SILENT,key:commandKey,command:'completeBooking',payload:{bookingId:''},ref:{kind:'booking',localKey:localRef},requestId})
            if(queued&&queued.ok){
              try{pendingCompletion.patch(env,datasetId,localId,requestId,{status:'queued'})}catch(error){}
              try{notifyPendingBookings()}catch(error){}
              const copy=await this.settleCompletionCopy({environment:env,datasetId,localId,requestId})
              completionTrace.finish(mark,{branch:'COMPLETED_LOCAL_FIRST_DEFERRED',localTxApplied:!!queued.applied,clipboardCalled:!!(copy&&copy.called),clipboardOk:!!(copy&&copy.copied),waitedOfficialMs:0,note:queued.code||''})
              return{ok:true,code:'COMPLETED_LOCAL_FIRST_DEFERRED',copy}
            }
          }
          const officialStarted=Date.now()
          const official=await awaitOfficialBooking(this.pendingKey,20000)
          waitedOfficialMs=Date.now()-officialStarted
          if(!official){
            completionTrace.finish(mark,{branch:'BOOKING_NOT_BOUND',localTxApplied:false,clipboardCalled:false,clipboardOk:false,waitedOfficialMs,skipped:'WAIT_OFFICIAL_ID'})
            this.failCompletion(localId,'课程未完成','这条预约没有在云端成功，课程未完成。你录的训练内容仍保留在本机。')
            return{ok:false,code:'BOOKING_NOT_BOUND'}
          }
          this.id=official
        }
        mark.officialId=this.id||''
        completionTrace.remeasure(mark)
        // ③ 正式完课：固定 requestId + 一条业务事实（booking done / 课时精确扣 1 / Income 恰好 1 条）。
        const result=await mutate(null,null,{strategy:mutate.STRATEGIES.SILENT,key:commandKey,command:'completeBooking',payload:{bookingId:this.id},requestId})
        // ★ 阶段 2 本机先行：这条事实**已经**按云端同一份规则在本机算完，并进了持久 Outbox。
        //   同步是后台的事 —— 页面不再看回读、不再等云端、也不弹「正在同步」。
        //   ⚠️ 必须连 ok 一起判：本机事务的拒绝与云端**同一份规则、同一个错误码**，
        //   只看 path 不看 ok 就会把"云端一定会拒绝的一次下课"报成成功 —— 用户看到已完成、实际一节没落。
        if(result&&result.path===mutate.PATHS.LOCAL_FIRST){
          if(result.ok){
            // 完课已经在本机事务里成立（与云端同一份规则、同一个错误码），
            // 而且这条事实已经进了持久 Outbox —— 现在是"完整动作"的后半段：把内容复制出去。
            if(result.applied&&entry)pendingCompletion.remove(env,datasetId,localId,requestId)
            try{notifyPendingBookings()}catch(error){}
            const copy=await this.settleCompletionCopy({environment:env,datasetId,localId,requestId})
            completionTrace.finish(mark,{branch:'COMPLETED_LOCAL_FIRST',localTxApplied:!!result.applied,clipboardCalled:!!(copy&&copy.called),clipboardOk:!!(copy&&copy.copied),waitedOfficialMs})
            return{ok:true,code:'COMPLETED_LOCAL_FIRST',copy}
          }
          const detail=result.code==='TRAINING_ITEMS_REQUIRED'?'这节课还没有训练动作，请先添加动作再下课。'
            :result.code==='PACKAGE_NO_REMAINING'?'所绑课时包剩余课时不足，本次没有完课。'
            :result.code==='BOOKING_ALREADY_DONE'?'这节课已经完成过了。'
            :`这次下课没有生效（${result.code||'UNKNOWN'}）。`
          completionTrace.finish(mark,{branch:'LOCAL_TX_REJECTED',localTxApplied:false,clipboardCalled:false,clipboardOk:false,waitedOfficialMs,note:result.code||'UNKNOWN'})
          this.failCompletion(localId,'课程未完成',`${detail}你录的内容仍保留在本机。`)
          return{ok:false,code:result.code||'COMMAND_REJECTED'}
        }
        if(result&&result.ok){
          if(result.refreshed&&result.refreshed.ok){
            if(entry)pendingCompletion.remove(env,datasetId,localId,requestId)
            try{notifyPendingBookings()}catch(error){}
            const copy=await this.settleCompletionCopy({environment:env,datasetId,localId,requestId})
            completionTrace.finish(mark,{branch:'COMPLETED',localTxApplied:true,clipboardCalled:!!(copy&&copy.called),clipboardOk:!!(copy&&copy.copied),waitedOfficialMs})
            return{ok:true,code:'COMPLETED',copy}
          }
          // ★ 1.1.9 第 6 轮：命令已在云端成功，而且云端已被那一跳只读校验确认处于本命令提交后的
          //   revision（result.confirmed）—— 只是本机 cache 还没翻完。这时**不再补一次完整回读**。
          //   ⚠️ 完课意图（entry）**必须继续留着**：它是课表呈现「已完」的唯一依据，
          //      cache 还没包含这条事实就先清掉，块会当场退回「待上」（用户看到的就是"点过下课的课又变回没完成"）。
          //      收尾交给既有 self-heal：下一次**成功的完整读取**之后按 snapshotShowsDone 撤标记。
          if(result.confirmed&&result.confirmed.ok){
            if(entry)try{pendingCompletion.patch(env,datasetId,localId,requestId,{status:'syncing'})}catch(error){}
            try{notifyPendingBookings()}catch(error){}
            const copy=await this.settleCompletionCopy({environment:env,datasetId,localId,requestId})
            completionTrace.finish(mark,{branch:'COMPLETED_CONFIRMED_PENDING_CACHE',localTxApplied:true,clipboardCalled:!!(copy&&copy.called),clipboardOk:!!(copy&&copy.copied),waitedOfficialMs})
            return{ok:true,code:'COMPLETED_CONFIRMED_PENDING_CACHE',copy}
          }
          // 命令已在云端成功、只是回读刷新失败：只重新同步，绝不再次 completeBooking。
          if(entry)try{pendingCompletion.patch(env,datasetId,localId,requestId,{status:'syncing'})}catch(error){}
          try{notifyPendingBookings()}catch(error){}
          const refreshed=await adapter.readActive().catch(()=>({ok:false}))
          if(refreshed&&refreshed.ok){
            if(entry)pendingCompletion.remove(env,datasetId,localId,requestId)
            try{notifyPendingBookings()}catch(error){}
          }else wx.showModal({title:'课程已完成，正在同步',content:'云端已确认课程完成，课表正在同步。课时与收入都已按一次计算，不会重复。',showCancel:false,confirmText:'知道了'})
          const copy=await this.settleCompletionCopy({environment:env,datasetId,localId,requestId})
          completionTrace.finish(mark,{branch:'SYNC_PENDING',localTxApplied:true,clipboardCalled:!!(copy&&copy.called),clipboardOk:!!(copy&&copy.copied),waitedOfficialMs})
          return{ok:true,code:'SYNC_PENDING',copy}
        }
        const code=(result&&result.code)||'COMMAND_RESULT_UNKNOWN'
        if(code==='COMMAND_RESULT_UNKNOWN'||code==='REQUEST_PROCESSING'){
          // 结果未知：保留「完课意图」标记，只用同一个 requestId 查 receipt，绝不盲目重发。
          if(entry)try{pendingCompletion.patch(env,datasetId,localId,requestId,{status:'unknown'})}catch(error){}
          try{notifyPendingBookings()}catch(error){}
          completionTrace.finish(mark,{branch:'COMMAND_RESULT_UNKNOWN',localTxApplied:null,clipboardCalled:false,clipboardOk:false,waitedOfficialMs,note:code})
          wx.showModal({title:'结果待确认',content:'网络中断，完课结果正在确认中。不会重复扣课时、也不会重复记收入，稍后可回到本课程查看结果。',showCancel:false,confirmText:'知道了'})
          return{ok:false,code}
        }
        completionTrace.finish(mark,{branch:'COMMAND_FAILED',localTxApplied:false,clipboardCalled:false,clipboardOk:false,waitedOfficialMs,note:code})
        this.failCompletion(localId,'课程未完成',(result&&result.message)||code)
        return{ok:false,code}
      }catch(error){
        // 这条 catch 会把异常吞掉（用户只需要一句人话提示），但"抛错的那一次"必须留下轨迹：
        // 否则整条完课链 reject 之后，日志里只剩下成功返回的那些，排查时完全隐形。
        console.error('[compl] chain error', String((error&&error.stack)||error))
        completionTrace.finish(mark,{branch:'COMPLETION_UNKNOWN',localTxApplied:null,clipboardCalled:null,clipboardOk:null,waitedOfficialMs,note:String((error&&error.message)||error)})
        this.failCompletion(localId,'课程未完成','网络异常，本次完课未确认。训练内容已保留在本机。')
        return{ok:false,code:'COMPLETION_UNKNOWN'}
      }
    })()
    return{ok:true,deferred:true,localId,settled}
  },
  // 失败一律撤回「完课意图」标记并明确提示；训练草稿保持不动，接口人不会丢内容。
  failCompletion(localId,title,content){
    try{
      const scope=draftScope(),entry=pendingCompletion.get(scope.environment,scope.datasetId,localId)
      if(entry)pendingCompletion.remove(scope.environment,scope.datasetId,localId,entry.requestId)
    }catch(error){}
    if(this.data.completing)this.setData({completing:false})
    try{notifyPendingBookings()}catch(error){}
    wx.showModal({title,content,showCancel:false,confirmText:'知道了'})
  },
  completeLocally(){const db=getDB(),b=db.bookings.find(x=>x.id===this.id);if(!b||b.status==='done')return;const s=db.students.find(x=>x.id===b.studentId),p=s&&b.packageId&&(s.packages||[]).find(x=>x.id===b.packageId);if(!p||p.status==='reversed'||Number(p.remaining||0)<=0)return wx.showToast({title:'当前所选课时包剩余课时不足，请重新选择课时包',icon:'none'});const completedAt=Date.now(),studentName=s.name;b.duration=this.data.duration;b.studentName=b.studentName||studentName;b.consumedPackageIndex=s.packages.indexOf(p);const category=this.data.isStretch?'拉伸恢复':this.data.category,summary=buildSummary(studentName,b,this.data.items,category,this.data.notes,completedAt);Object.assign(b,{status:'done',items:this.data.items,notes:this.data.notes,category,duration:this.data.duration,completedAt,summary});p.used=Number(p.used||0)+1;p.remaining=Number(p.remaining||0)-1;db.incomes.push({id:uid(),bookingId:b.id,date:b.date,time:timeStr(b),studentId:b.studentId,studentName:b.studentName,typeName:b.typeName,category:b.category,amount:b.typeName==='赠送课程'?80:Number(b.price)});saveDB(db);this.setData({done:true,booking:{...b,time:timeStr(b)},summary,category});wx.setClipboardData({data:summary,success:()=>this.showCompletionCare('课程记录已保存，训练内容也已复制，可以直接粘贴发送给会员。'),fail:()=>this.showCompletionCare('课程记录已保存，训练内容暂时没有复制成功，可以稍后在本页重新复制。')})},
  copySummary(){const booking={...this.data.booking,duration:this.data.duration},text=buildSummary(this.data.student.name,booking,this.data.items,this.data.category,this.data.notes,this.data.booking.completedAt||Date.now()),db=getDB(),b=db.bookings.find(x=>x.id===this.id);if(b&&!this.data.legacyReadonly){if(mutate.isCloudWritePath())mutate(null,null,{key:`updateBookingSummary:${this.id}`,command:'updateBookingContent',payload:{bookingId:this.id,summary:text,duration:this.data.duration},successTitle:'',onRefresh:()=>this.load()});else{b.summary=text;b.duration=this.data.duration;saveDB(db)}}this.setData({summary:text});wx.setClipboardData({data:text,success:()=>wx.showToast({title:'已复制，可发给学员'})})},
  showCancel(){this.setData({cancelSheet:true})},hideCancel(){this.setData({cancelSheet:false})},
  openReschedule(){const b=this.data.booking;this.setData({reschedule:true,editDate:b.date,editHour:b.hour,editMinute:b.minute||0})},closeReschedule(){this.setData({reschedule:false})},
  editDate(e){this.setData({editDate:e.detail.value})},editHour(e){this.setData({editHour:+e.currentTarget.dataset.value})},editMinute(e){this.setData({editMinute:+e.currentTarget.dataset.value})},
  editTime(e){const [editHour,editMinute]=e.detail.value.split(':').map(Number);this.setData({editHour,editMinute})},
  saveReschedule(){
    // ⭐ 出网前先过同一道时间闸：**开始 ≤ 23:00 且 结束 ≤ 当天 24:00** —— 少了它，
    //    "先约 10:00 再改到 23:30"就能绕过去（云端也拦，但那时命令已经排进队列了）。
    //    时长用这节课**预约时落库的快照**；历史老预约没有这个字段 ⇒ 按默认 60 兜底。
    //    ⚠️ 用 showModal 不用 showToast：toast 会截断长句，剩下半句等于没说。
    if(!this.data.legacyReadonly){
      const currentDb=getDB(),current=currentDb.bookings.find(x=>x.id===this.id)
      if(current){
        const gate=occupancy.lessonWindowGateOf({hour:this.data.editHour,minute:this.data.editMinute},occupancy.plannedMinutesOf(current))
        if(gate)return wx.showModal({title:'这个时间排不了',content:gate.message,showCancel:false})
      }
    }
    if(this.data.legacyReadonly)return;const db=getDB(),b=db.bookings.find(x=>x.id===this.id),start=this.data.editHour*60+this.data.editMinute,occupied=db.bookings.some(x=>x.id!==this.id&&x.date===this.data.editDate&&start<(x.hour*60+(x.minute||0)+60)&&(start+60)>x.hour*60+(x.minute||0));if(occupied)return wx.showToast({title:'该时段与其他课程重叠',icon:'none'});notifyConsent.requestNextAfterAction('coach',{quiet:true});if(mutate.isCloudWritePath())return mutate(null,null,{key:`rescheduleBooking:${this.id}`,command:'rescheduleBooking',payload:{bookingId:this.id,date:this.data.editDate,hour:this.data.editHour,minute:this.data.editMinute},successTitle:'时间已修改',onSuccess:()=>{this.setData({reschedule:false});this.load()},onRefresh:()=>this.load()});const result=rescheduleBookingAligned(db,this.id,{date:this.data.editDate,hour:this.data.editHour,minute:this.data.editMinute},booking=>buildSummary(this.data.student.name,booking,this.data.items,this.data.category,this.data.notes,booking.completedAt||Date.now()));if(!result.ok)return wx.showModal({title:'无法安全改期',content:result.message,showCancel:false,confirmText:'知道了'});saveDB(db);this.setData({reschedule:false,booking:{...result.booking,time:timeStr(result.booking)},summary:result.booking.summary||this.data.summary});wx.showToast({title:result.income?'时间与收入已同步':'时间已修改'})},
  // 取消预约：和预约、完课同一套即时交互 —— 第一帧就让课表上的块消失并回到课表，
  // 云端在后台安全落实。正式 cache 一个字都不改（只写本机 tombstone），所以任何统计口径都不受影响。
  // 关键排序：若这条预约的 create 还在路上，协调器会先把 create 的结果问清楚（receipt），
  // 再决定是否需要发 cancelBooking —— 绝不会出现「本地取消了但云端后来又冒出来」的幽灵预约。
  // M2「课程未进行」：待确认（超过预计结束 + 3 小时仍未下课）的课程，由教练**人工**判定这一节没上成。
  //   只释放占座（reserved −1）：不扣剩余课时、不增加已用、不产生收入。
  //   ⚠️ 系统永远不会自动调用它 —— 只负责提醒，不替教练判断现实。
  markNotHeld(){
    if(this.data.legacyReadonly||this.data.done)return
    if(this.data.completing||this.data.cancelling)return
    const officialId=this.id||''
    if(!officialId)return
    wx.showModal({title:'标记这节课为「未进行」？',content:'将释放这节课占用的预约额度；不扣课时、不产生收入。',success:res=>{
      if(!res.confirm)return
      mutate(null,null,{key:`markBookingNotHeld:${officialId}`,command:'markBookingNotHeld',payload:{bookingId:officialId},successTitle:'已标记为未进行',onRefresh:()=>this.load()})
      if(typeof setTimeout==='function')setTimeout(()=>{this.returnToSchedule()},0)
    }})
  },
  cancel(){
    if(this.data.legacyReadonly||this.data.done)return
    if(this.data.completing||this.data.cancelling)return
    // 本地模式（未切换到 cloud-primary）保持原有行为：直接从本机 coachDB 删除。
    if(!mutate.isCloudWritePath()){
      const db=getDB(),local=this.id?db.bookings.find(x=>x.id===this.id):null
      if(local&&local.status!=='done'){db.bookings=db.bookings.filter(x=>x.id!==local.id);saveDB(db);wx.showToast({title:'已取消预约',icon:'none'})}
      if(typeof setTimeout==='function')setTimeout(()=>{this.returnToSchedule()},0)
      return
    }
    this.setData({cancelling:true})
    clearTimeout(this.draftTimer)
    const officialId=this.id||''
    const bound=officialId&&typeof bindingForOfficialId==='function'?bindingForOfficialId(officialId):null
    const localKey=this.pendingKey||((bound&&bound.bookingKey)||'')
    const b=this.data.booking||{}
    if(typeof mutate.cancelBooking==='function')mutate.cancelBooking({localKey,officialId,booking:{id:officialId,studentId:b.studentId,packageId:b.packageId,date:b.date,hour:b.hour,minute:b.minute||0}})
    else if(officialId)mutate(null,null,{key:`cancelBooking:${officialId}`,command:'cancelBooking',payload:{bookingId:officialId},successTitle:'已取消预约',onRefresh:()=>this.load()})
    if(typeof setTimeout==='function')setTimeout(()=>{this.returnToSchedule()},0)
  },
  cancelOnly(){if(this.data.done)return;notifyConsent.requestNextAfterAction('coach',{quiet:true});return this.cancel(false)},
  cancelReturn(){this.deleteCompleted()},
  deleteCompleted(){if(this.data.legacyReadonly)return;const db=getDB(),b=db.bookings.find(x=>x.id===this.id);if(!b||b.status!=='done')return wx.showToast({title:'本节记录已不存在',icon:'none'});const s=db.students.find(x=>x.id===b.studentId),p=s&&b.packageId&&(s.packages||[]).find(x=>x.id===b.packageId),active=!!(p&&p.status!=='reversed'),reversed=!!(p&&p.status==='reversed');let effect='原课时包已不存在，本次不会向其他课时包返还课时。';if(active)effect='对应课时包将返还1节课时。';else if(reversed)effect='原课时包已撤销，本次删除不会返还可用课时。';wx.showModal({title:'删除本节记录',content:`确定删除这节已完成课程吗？\n\n删除后：\n- 本节上课记录将删除\n- 对应上课收入将删除\n- 本月课时统计和预计提成将重新计算\n\n${effect}\n\n此操作不可撤销。`,confirmText:'确认删除',confirmColor:'#c7563d',success:r=>{if(!r.confirm)return;if(mutate.isCloudWritePath())return mutate(null,null,{key:`deleteCompletedBooking:${this.id}`,command:'deleteCompletedBooking',payload:{bookingId:this.id},successTitle:'本节记录已删除',onSuccess:()=>setTimeout(()=>wx.navigateBack(),500),onRefresh:()=>this.load()});const latest=getDB(),result=deleteCompletedBookingAligned(latest,this.id);if(!result.ok)return wx.showModal({title:'无法安全删除',content:result.message,showCancel:false,confirmText:'知道了'});saveDB(latest);wx.showToast({title:'本节记录已删除'});setTimeout(()=>wx.navigateBack(),500)}})},
  back(){wx.navigateBack()}
})
// 路径参数解码（真机根因）：小程序的路径参数是 URL 编码形式送达的，
// 微信官方文档明确要求接收方自己 decodeURIComponent。解不开就按原值用，
// 绝不因为解码失败把这条预约的身份丢掉。
function decodeParam(value){
  if(typeof value!=='string'||!value)return''
  try{const decoded=decodeURIComponent(value);return decoded||value}catch(error){return value}
}
// 训练草稿只描述「训练内容」本身，**绝不携带 bookingId**（第 34 节）。
// 草稿是在本机编辑态下写的，那时还没有正式身份；一旦把 bookingId 写进内容，
// 它就会在转正后的那次提交里跟着 content 一起被展开，把真实的正式 id 盖成空串。
function draftContent(state){return{items:state.items,notes:state.notes,category:state.isStretch?'拉伸恢复':state.category,duration:state.duration}}
// 训练内容的提交载荷：正式 bookingId **永远**由「这个页面此刻持有的正式身份」决定。
// 先把 content 里可能残留的同名字段摘掉，再把正式 id 放到最后 —— 双保险。
// （真机根因：旧草稿里带着 bookingId:''，展开顺序把它盖在正式 id 上 → 云端 INVALID_PAYLOAD
//   → 训练内容永远确认不了 → 完课被安全中止。已落盘的旧草稿也靠这一句自愈。）
function contentPayload(bookingId,content){const body={...content};delete body.bookingId;return{...body,bookingId}}
function makeSections(items){const sections=[];items.forEach((x,index)=>{const group=x.group||'其他',last=sections[sections.length-1];if(last&&last.group===group)last.items.push({...x,sourceIndex:index});else sections.push({key:`${index}-${group}`,group,items:[{...x,sourceIndex:index}]})});return sections}
function buildSummary(student,b,items,category,notes,completedAt){
  const parts=b.date.split('-'),d=new Date(+parts[0],+parts[1]-1,+parts[2]),wd=['日','一','二','三','四','五','六'][d.getDay()]
  const lines=[`⏰ ${Number(parts[1])}月${Number(parts[2])}日 星期${wd}`,`${Number(b.hour)}:${String(b.minute||0).padStart(2,'0')}｜${category}`,'']
  items.forEach(x=>{if(b.typeName==='拉伸恢复'||x.group==='拉伸')lines.push(`${x.name} · ${x.minutes||15}分钟`);else{const weight=x.weight!==''&&x.weight!=null?` · ${x.weight}kg`:'';lines.push(`${x.name} · ${x.sets||4}组×${x.reps||12}次${weight}`)}})
  if(b.typeName==='拉伸恢复')lines.push(`⏱训练时长：${b.duration||60}分钟`)
  if(notes)lines.push(`备注：${notes}`)
  return lines.join('\n')
}
// 「待确认」已经拖了几个小时：只用于**提示文案**，不参与任何业务判断。
// 口径与 occupancy.isPendingConfirmation 完全一致（预计结束 + 3 小时之后才算超时）。
function overdueHoursOf(booking,nowMs){
  const end=occupancy.plannedEndMs(booking)
  if(end==null)return 0
  const overdue=Number(nowMs)-end-occupancy.PENDING_GRACE_MINUTES*60000
  return overdue>0?Math.max(1,Math.floor(overdue/3600000)):0
}
function beijingTime(ms){const d=new Date(ms+8*3600000),pad=n=>String(n).padStart(2,'0');return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`}
