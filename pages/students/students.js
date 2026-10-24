const { TYPES } = require('../../utils/constants')
const { getDB, saveDB, uid, timeStr } = require('../../utils/data-runtime')
const { todayKey } = require('../../utils/beijing-date')
const { initials } = require('../../utils/pinyin')
const { validDateKey, resolveCourseSale, updateCourseSale } = require('../../utils/course-sales')
const { currentStudent, deleteStudentAligned } = require('../../utils/local-business-rules')
// ⭐ 开课时间窗口：**06:00–23:00 开课、每 30 分钟一档、且当天 24:00 前结束**（教练新建与会员自助同一条规则）。
//   与云端 occupancy.js 同一把尺（本机孪生）。
const occupancy = require('../../utils/package-occupancy')
const scheduleView = require('../../utils/schedule-view')
const mutate = require('../../utils/mutate')
// M2 V1：跨教练授权目录（**只读投影**，不进本机业务快照 ⇒ checksum / 指纹 / 增量一个字节不受影响）。
const coachAuthorization = require('../../utils/coach-authorization')
const directory = require('../../utils/member-directory')
// ⭐ 2026-10-03 · 「邀请会员认领」走这一条已登记的教练通道（`memberIdentityCommand` 的 coachExecute）。
//   ⛔ **复用既有封装**（member-coach-tools.js 是全项目唯一调它的地方），本页绝不自己再写一套 wx.cloud。
const tools = require('../../utils/member-coach-tools')
// ⭐⭐ 2026-10-05：会员域功能（邀请认领）目前在**测试区**才可用。
//    正式区必须原样显示「该功能尚在安全测试中」，且**零云调用**（云端 Sandbox 函数自己还有一道硬门禁）。
const routing = require('../../utils/sandbox-cloud-functions')
// 本机当前这本账的 datasetId（去重时用：判断这条授权条目是不是本来就属于我自己这本账）。
// ⚠️ 上面是**解构导入**，这里必须再取一次模块本体 —— 没有 try/catch：取不到就让页面大声失败，不许静默。
const dataRuntime=require('../../utils/data-runtime')
const readDatasetId=()=>{const key=dataRuntime.isSandbox()?dataRuntime.SANDBOX_CACHE_KEY:dataRuntime.CACHE_KEY;const cache=wx.getStorageSync(key);return cache&&cache.datasetId?String(cache.datasetId):''}
function giftsLast(packages){return (packages||[]).map((p,i)=>({...p,_order:i})).sort((a,b)=>(a.type==='赠送课程')-(b.type==='赠送课程')||a._order-b._order).map(({_order,...p})=>p)}
// ⭐ 2026-10-02 · 本轮 UI 整理：名单改成**一人一行**，所以每个学员只出一个"关键状态"。
//    ⛔ 这是一个**纯视图**函数：只把调用方给的那份课时包数组求和、判一下有没有快用完的，
//       不读也不写任何业务账本，不参与扣课 / 余额 / 销售 / 续费口径。
//    ⛔ 调用方传的是 `packages.filter(p=>p.left>0)`（= visiblePackages）。用**同一份**数组算
//       分子和分母，避免出现"剩余 0 / 共 24 节"这种读不通的行。
//    本地会员与「被授权服务的会员」共用这一个函数 ⇒ 两类卡片的关键状态天生同口径。
function rowSummaryOf(visiblePackages){
  const list=Array.isArray(visiblePackages)?visiblePackages:[]
  const rowLeft=list.reduce((n,p)=>n+Number(p.left||0),0)
  const rowTotal=list.reduce((n,p)=>n+Number(p.total||0),0)
  const warn=list.filter(p=>p.warn)
  return {rowHas:list.length>0,rowLeft,rowTotal,rowWarn:warn.length>0,
    rowWarnText:warn.length>1?`${warn.length} 个课时包快用完`:'即将用完'}
}
// 保存失败时用中文说人话：命令返回的错误码不能原样丢给她看。
const SAVE_FAILURE_HINTS={OFFLINE_READ_ONLY:'当前没有网络',CLOUD_DATASET_UNKNOWN:'云端空间还没准备好',REVISION_CONFLICT:'云端数据已被其他操作更新',CUTOVER_WRITE_FROZEN:'云端切换还没完成',REQUEST_PENDING_CONFIRMATION:'上一次保存还在确认中',PRODUCTION_RECOVERY_READ_ONLY:'正在只读核查真实课程'}
const DATE_YEARS=Array.from({length:131},(_,i)=>String(1970+i)),DATE_MONTHS=Array.from({length:12},(_,i)=>String(i+1).padStart(2,'0'))
function monthDays(year,month){return new Date(Date.UTC(Number(year),Number(month),0)).getUTCDate()}
function datePickerData(key){const fallback=todayKey(),parts=(validDateKey(key)?key:fallback).split('-'),yearIndex=Math.max(0,DATE_YEARS.indexOf(parts[0])),monthIndex=Math.max(0,DATE_MONTHS.indexOf(parts[1])),days=Array.from({length:monthDays(DATE_YEARS[yearIndex],DATE_MONTHS[monthIndex])},(_,i)=>String(i+1).padStart(2,'0')),dayIndex=Math.min(days.length-1,Math.max(0,Number(parts[2])-1));return {dateRange:[DATE_YEARS,DATE_MONTHS,days],dateValue:[yearIndex,monthIndex,dayIndex]}}
// ⭐ M2 自动刷新补线：接上总线（回前台 / 写命令成功 / 从子页返回时，可见的这个页面会真的重读一次）。
const installAutoRefresh=require('../../utils/auto-refresh').installPage
Page(installAutoRefresh({
  // ⭐ 2026-10-03 · 名单改成**内部滚动** + 胶囊独立底部安全区（见 students.wxml / students.wxss）：
  //   · inSandbox  测试环境横幅**占流**（sticky 96rpx）⇒ 名单区高度必须扣掉它，否则底部被裁
  //                （与课表页 `.schedule-page.with-banner` 同一条规则，同一个变量）；
  //   · scrollTarget 字母导航用的 `scroll-into-view` 目标（原来是 pageScrollTo，页面已不再自己滚）；
  //   · listRefreshing  滚动区内部下拉的状态（refresher-triggered 是**受控**属性，必须自己收）。
  data:{students:[],groups:[],alphabet:[],modal:false,renewModal:false,detail:null,form:null,types:TYPES,saleTypes:TYPES.filter(t=>!t.gift),renewCount:0,renewPreview:'',renewList:[],profileEditing:false,packageEditing:{},saleEditor:null,sheetStyle:'',sheetClosing:false,cloudPrimary:false,finishedExpanded:false,finishedCount:0,authorizedDetail:null,booking:null,authorizedFailed:false,authorizedStale:false,inSandbox:false,sandboxHint:'',scrollTarget:'',listRefreshing:false,qrPreparing:false,
  },
  noop(){},
  // 整屏保存与单笔保存共享同一把锁，点击当帧就反馈，直到表单回填完成才释放。
  withSaveLock(work){
    if(this._saveTask)return this._saveTask
    const instantNewStudent=mutate.isCloudWritePath()&&mutate.localFirstEnabled()&&this.data.form&&(!this.data.form.id||!this.data.form.packages.some(pkg=>pkg.isNew))
    this.setData({saving:true})
    if(!instantNewStudent)wx.showLoading({title:'正在保存，请稍候',mask:true})
    const task=Promise.resolve().then(work).catch(()=>{this.reportSaveFailure('保存结果尚未确认，请保留表单后重试');return {ok:false,code:'SAVE_UNCONFIRMED'}}).finally(()=>{this._saveTask=null;this.setData({saving:false});if(!instantNewStudent)wx.hideLoading()})
    this._saveTask=task
    return task
  },
  savePackage(e){return this.withSaveLock(()=>this.persistPackage(e))},
  persistStudent(confirmInconsistent){return this.withSaveLock(()=>this.saveStudentContents(confirmInconsistent))},
  // ⭐ M2 自动刷新：进入关键页面是一个正式触发点；下拉刷新是**兜底**（用户主动 ⇒ 真的读一次云端）。
  onShow(){
    // ⭐ 横幅只在测试区出现，而它**占流**（sticky 96rpx）⇒ 名单区高度必须让出同样多
    //   （否则滚动区下沿被推到胶囊带里，底部行会被胶囊压住）。放 onShow：切环境 / 从别的页返回
    //   都会重新对齐，不会出现"横幅还在、名单已经按没有横幅排"。
    //   与课表页同一条规矩（见 schedule.js 的 onShow / schedule.wxss 的 .with-banner）。
    const inSandbox=typeof dataRuntime.isSandbox==='function'?!!dataRuntime.isSandbox():false
    this.setData({inSandbox,sandboxHint:routing.hint(tools.environment())})
    require('../../utils/auto-refresh').request('pageShow');wx.showTabBar();this.setData({cloudPrimary:mutate.isCloudWritePath()});this.render()
  },onHide(){wx.showTabBar()},
  // ⭐ M2 V1：「我的学员」的业务含义 = **当前教练有权限服务的会员**。
  //   被授权服务的会员与我自己创建的会员在**同一个列表**里、用**同一张会员卡片**：
  //   · 数据来源仍是两条（本机这本账 vs 云端授权目录的缓存那一帧），**合并的是视图，不是底层实体**；
  //   · 授权会员**绝不写进 db.students** ⇒ 不复制档案、不复制课时包、不产生第二套余额；
  //   · 去重按**归属**（place 的 datasetId + studentId）⇒ 同一位会员在同一个列表里最多出现一次，
  //     ⛔ 绝不按姓名 / 手机号自动合并（同名同号的两位会员必须是两张卡）。
  authorizedMembers(locals){
    let result
    try{result=coachAuthorization.cachedDirectory()}catch(error){result={ok:false,data:coachAuthorization.emptyDirectory()}}
    const data=(result&&result.data)||coachAuthorization.emptyDirectory()
    this._authorizedFailed=!result.ok
    // ⭐ 2026-10-06：`stale` = 这一帧「展示可以、排课不行」（没有云端标识 / 形状版本不对）。
    //    真机 BUG03 二次失败就是它：课包渲染得出来，点下去却拿不到 packageId。
    //    ⇒ 卡片照旧显示（不许藏），但排课入口必须挡住并告诉她去下拉刷新。
    this._authorizedStale=!!(result&&result.stale)
    const myDataset=String(readDatasetId()||'')
    const mine=new Set((locals||[]).map(s=>String(s.id||'')))
    const seen=new Set(),rows=[]
    ;(data.serving||[]).forEach(member=>{
      const place=member.place||{},datasetId=String(place.datasetId||''),studentId=String(member.studentId||'')
      // 这张卡片本来就属于我自己这本账 ⇒ 列表里那张本地卡片已经是它了，不要再出现第二张。
      if(myDataset&&datasetId===myDataset&&mine.has(studentId))return
      const key=`${datasetId}::${studentId}`
      if(seen.has(key))return
      seen.add(key)
      rows.push({key,member,place})
    })
    this._authorizedIndex=Object.fromEntries(rows.map(row=>[`auth:${row.key}`,row.member]))
    return rows
  },
  // 把云端投影的一份课包换算成与本地课包**同形状**的卡片字段（颜色 / 进度条 / 续费提醒复用同一套口径）。
  authorizedPackage(pkg,th){
    const type=TYPES.find(t=>t.name===pkg.type)||TYPES[0]
    const total=Number(pkg.total||0),left=Math.max(0,Number(pkg.remaining||0))
    const balancePercent=total?Math.max(0,Math.min(100,left/total*100)):0
    return {id:`authpkg:${pkg.packageId}`,packageId:pkg.packageId,type:pkg.type,left,total,balancePercent,
      color:type.color,warn:left>0&&left<=th,gift:!!type.gift,occupancy:coachAuthorization.occupancyText(pkg)}
  },
  authorizedCard(row,th){
    const packages=(row.member.packages||[]).map(pkg=>this.authorizedPackage(pkg,th))
    const visiblePackages=packages.filter(p=>p.left>0)
    const name=row.member.name||'会员'
    return {id:`auth:${row.key}`,authorized:true,studentId:row.member.studentId,name,phone:row.member.phone||'',
      abbr:initials(name),packages,visiblePackages,usedUpCount:packages.length-visiblePackages.length,
      searchLetter:((initials(name)||'#')[0]).toUpperCase(),...rowSummaryOf(visiblePackages)}
  },
  // 点一张卡：本地会员走原有编辑流程，授权会员走只读详情（课包 / 预约 / 共享训练历史）。
  openCard(id){
    const key=String(id||'')
    if(key.indexOf('auth:')===0)return this.openAuthorizedCard(key)
    return this.openEditor(id)
  },
  openAuthorizedCard(key){
    const entry=this._authorizedIndex||{}
    const member=entry[key]
    if(!member)return
    this.cancelSheetClose()
    wx.hideTabBar({animation:true})
    const packages=(member.packages||[]).map(pkg=>({
      packageId:pkg.packageId,type:pkg.type,left:Number(pkg.remaining||0),total:Number(pkg.total||0),
      availableToBook:Number(pkg.availableToBook||0),occupancy:coachAuthorization.occupancyText(pkg),
      percent:Number(pkg.total)?Math.max(0,Math.min(100,Number(pkg.remaining||0)/Number(pkg.total)*100)):0,
      canManage:!!pkg.canManage
    }))
    this.setData({authorizedDetail:{
      initial:(member.name||'会员').slice(0,1),name:member.name||'会员',phone:member.phone||'未填手机号',
      // ⭐ 排课要用学员号（只在这张卡里带着，⛔ 不进本机业务快照）
      studentId:String(member.studentId||''),memberId:String(member.memberId||''),
      packages,upcoming:(member.upcoming||[]).map(item=>({date:item.date,time:coachAuthorization.momentText(item)})),
      history:(member.history||[]).map(item=>({date:item.date,time:coachAuthorization.momentText(item),items:coachAuthorization.itemsText(item)}))
    },booking:this.blankBooking(packages)})
  },
  async refreshAuthorized(){try{await coachAuthorization.loadDirectory({force:true})}catch(error){}this.render()},
  removeAuthorizedMember(){
    const detail=this.data.authorizedDetail||{}
    const memberId=String(detail.memberId||'')
    if(!memberId)return wx.showToast({title:'会员信息还没读全，请下拉刷新',icon:'none'})
    wx.showModal({
      title:'移出会员列表？',
      content:'只解除今后的服务关系。已经上过的课、训练记录、已用课时、历史课时费和收入统计全部保留；以后还能重新添加。若还有待上课程，需要先取消或完成。',
      confirmText:'确认移出',
      success:answer=>{if(answer.confirm)this.confirmRemoveAuthorizedMember(memberId)}
    })
  },
  async confirmRemoveAuthorizedMember(memberId){
    if(this._removingAuthorized)return
    this._removingAuthorized=true
    try{
      const result=await directory.removeMemberContact(memberId)
      if(!result||result.ok!==true)return wx.showModal({title:'没有移出成功',content:(result&&result.message)||'请稍后重试。',showCancel:false})
      await coachAuthorization.notePermissionChanged()
      this.setData({authorizedDetail:null,booking:null})
      wx.showTabBar()
      this.render()
      wx.showToast({title:'已移出，历史数据全部保留',icon:'none'})
    }finally{this._removingAuthorized=false}
  },
  // 为当前已经存在的学员资料生成固定专属二维码。
  // 这里只把会员微信接到现有 studentId；不新建学员、不复制课包或预约。
  async prepareOfficialStudentRef(localId,timeoutMs=12000){
    const source=String(localId||'')
    if(!source)return ''
    const resolve=()=>typeof mutate.resolveLocalId==='function'?String(mutate.resolveLocalId(source)||''):source
    let resolved=resolve()
    if(resolved&&resolved.indexOf('loc_')!==0)return resolved
    try{require('../../utils/sync-engine').resume()}catch(error){try{require('../../utils/sync-engine').schedule()}catch(ignore){}}
    const started=Date.now()
    while(Date.now()-started<timeoutMs){
      await new Promise(done=>setTimeout(done,250))
      resolved=resolve()
      if(resolved&&resolved.indexOf('loc_')!==0)return resolved
    }
    return ''
  },
  prewarmMemberQr(localId){
    const source=String(localId||'')
    if(!source)return
    const started=Date.now()
    const observe=()=>{
      const studentRef=typeof mutate.resolveLocalId==='function'?String(mutate.resolveLocalId(source)||''):source
      if(studentRef&&studentRef.indexOf('loc_')!==0){directory.getMemberClaimQr(studentRef).catch(()=>{});return}
      if(Date.now()-started>=12000)return
      const timer=setTimeout(observe,400)
      if(timer&&typeof timer.unref==='function')timer.unref()
    }
    observe()
  },
  async openDedicatedMemberQr(){
    const form=this.data.form
    if(!form||!form.id)return wx.showToast({title:'请先保存会员资料',icon:'none'})
    // 新建学员会先得到一个 loc_student_… 本机临时编号，后台同步成功后再写入正式编号。
    // 表单本身不会自动改掉旧编号，所以离开本页调用云端能力前必须从统一 idMap 现读现用。
    // 绝不能把临时编号直接交给二维码云函数，否则云端只能误报“找不到这位学员”。
    if(this.data.qrPreparing)return
    this.setData({qrPreparing:true})
    wx.showLoading({title:'正在准备二维码',mask:true})
    const studentRef=await this.prepareOfficialStudentRef(form.id)
    wx.hideLoading()
    this.setData({qrPreparing:false})
    if(!studentRef)return wx.showModal({title:'资料还在同步',content:'网络较慢，系统会继续自动同步。请保持联网后再点一次生成，不需要下拉刷新。',showCancel:false})
    if(String(form.id).indexOf('loc_')===0)this.setData({'form.id':studentRef})
    this.finishClose()
    wx.navigateTo({url:`/pages/coach-member-qr/coach-member-qr?studentRef=${encodeURIComponent(studentRef)}`})
  },
  // ───────────────────────────────────────────────────────────────────────────
  // 给「已添加的会员」排一节课（2026-10-06：取代旧的「多教练服务」授权工作台）
  //
  // ⛔ 谁能上这节课**只由添加联系人决定** ⇒ 客户端只管提交「谁 / 哪份课时包 / 什么时间」，
  //    能不能上由云端 `createAuthorizedBooking` 按授权记录终判；课时包在谁账里就扣谁的，
  //    ⛔ 绝不复制第二份余额。
  // ───────────────────────────────────────────────────────────────────────────
  blankBooking(packages){
    // ⛔ 只列"现在真的能约"的课时包（有剩余且没被约满）⇒ 不会出现"看得见、点了说不能"。
    const list=(packages||[]).filter(pkg=>Number(pkg.availableToBook||0)>0)
    const label=pkg=>`${pkg.type||'课程'}（可约 ${Number(pkg.availableToBook||0)} 节）`
    // ⭐ 时间选择器的上下界**必须取自 occupancy 同一把尺**（⛔ 不许写死）：
    //    否则会出现"00:00 能选、点确认才被闸门拒"这种最难受的形状。
    const pad=n=>String(n).padStart(2,'0')
    const hhmm=m=>`${pad(Math.floor(Number(m||0)/60))}:${pad(Number(m||0)%60)}`
    return {open:false,date:todayKey(),time:'10:00',
      timeStart:hhmm(occupancy.EARLIEST_START_MINUTES),timeEnd:hhmm(occupancy.LATEST_START_MINUTES),
      plannedMinutes:Number(occupancy.DEFAULT_PLANNED_MINUTES||60),minutesText:String(occupancy.DEFAULT_PLANNED_MINUTES||60),
      packageId:list.length?String(list[0].packageId||''):'',packageLabel:list.length?label(list[0]):'（没有可约的课时包）',packages:list}
  },
  bookingLabelOf(pkg){return pkg?`${pkg.type||'课程'}（可约 ${Number(pkg.availableToBook||0)} 节）`:'（没有可约的课时包）'},
  openBooking(){
    const detail=this.data.authorizedDetail
    if(!detail)return
    // ⛔ 陈旧帧不许拿来排课：这一帧里的课包**可能没有云端标识**（真机 BUG03 二次失败的形状）⇒
    //    放进排课面板就是"选了课包、点了说没选"。先让她下拉刷新，拿到可信事实再排。
    if(this._authorizedStale)return wx.showModal({title:'名单还没读到最新',content:'这一份会员名单不是最新读到的，请下拉刷新后再给这位会员排课。',showCancel:false,confirmText:'知道了'})
    const booking=this.blankBooking(detail.packages)
    if(!booking.packages.length)return wx.showModal({title:'暂时排不了课',content:'这位会员还没有你能用的课时包（要有剩余、且没被约满）。请先让主管教练加课时。',showCancel:false})
    this.setData({booking:Object.assign({},booking,{open:true})})
  },
  closeBooking(){this.setData({'booking.open':false})},
  onBookingDate(e){this.setData({'booking.date':String((e&&e.detail&&e.detail.value)||'')})},
  onBookingTime(e){this.setData({'booking.time':String((e&&e.detail&&e.detail.value)||'10:00')})},
  onBookingMinutes(e){
    const value=String((e&&e.detail&&e.detail.value)||'')||String(occupancy.DEFAULT_PLANNED_MINUTES||60)
    this.setData({'booking.minutesText':value,'booking.plannedMinutes':Number(value)||Number(occupancy.DEFAULT_PLANNED_MINUTES||60)})
  },
  onBookingPackage(e){
    const list=(this.data.booking&&this.data.booking.packages)||[]
    const picked=list[Number((e&&e.detail&&e.detail.value)||0)]
    this.setData({'booking.packageId':String((picked&&picked.packageId)||''),'booking.packageLabel':this.bookingLabelOf(picked)})
  },
  async confirmBooking(){
    if(this._bookingBusy)return
    const booking=this.data.booking||{}
    const studentId=String((this.data.authorizedDetail||{}).studentId||'')
    const packageId=String(booking.packageId||'')
    const parts=String(booking.time||'10:00').split(':')
    const hour=Number(parts[0]),minute=Number(parts[1]||0)
    if(!studentId)return wx.showToast({title:'这位会员信息还没读全，请下拉刷新',icon:'none'})
    if(!packageId)return wx.showToast({title:'请先选好课时包',icon:'none'})
    if(!Number.isInteger(hour))return wx.showToast({title:'请先选好上课时间',icon:'none'})
    // ⭐ 日期取不到就**明确拒绝**，绝不静默退化成"今天"（真机 BUG05 的同源形状：写 A 读 B）。
    if(!validDateKey(booking.date))return wx.showModal({title:'请先选好上课日期',content:'日期还没有读到，请重新选择一次日期再排课。',showCancel:false,confirmText:'知道了'})
    if(!mutate.isCloudWritePath())return wx.showToast({title:'云端模式下才能排课',icon:'none'})
    const plannedMinutes=Number(booking.plannedMinutes)||Number(occupancy.DEFAULT_PLANNED_MINUTES||60)
    // ⭐ 出网前先过同一道时间闸（与云端同一把尺）；⛔ 用 showModal 免得长句被 toast 截断。
    const gate=occupancy.lessonWindowGateOf({hour,minute},plannedMinutes)
    if(gate)return wx.showModal({title:'这个时间排不了',content:gate.message,showCancel:false})
    this._bookingBusy=true
    try{
      // ⭐ 排课成功后必须**收起面板**：真 mutate 只在成功时调 onSuccess（onRefresh 是版本冲突那条路）
      //    ⇒ 挂在 onSuccess 上；两条路都挂，收起这一件事不会漏。
      const close=()=>{this.setData({'booking.open':false});this.render()}
      await mutate(null,null,{key:`createAuthorizedBooking:${studentId}:${packageId}:${booking.date}:${hour}:${minute}`,command:'createAuthorizedBooking',payload:{studentId,packageId,date:booking.date,hour,minute,plannedMinutes},successTitle:'已排课',onSuccess:close,onRefresh:close})
      // ⭐ 权限可能已经变了（别的教练撤了我的授课授权）⇒ 排完课顺手把授权目录拉一次。
      await this.refreshAuthorized()
    } finally { this._bookingBusy=false }
  },
  closeAuthorized(){this.setData({authorizedDetail:null});wx.showTabBar()},
  onPullDownRefresh(){this.pullRefresh()},
  // ⭐ 2026-10-03 · 名单区**内部**下拉（scroll-view 的 refresher）：
  //   名单现在在自己的 scroll-view 里滚（这样才可能"任何滚动位置都不被胶囊遮挡"），
  //   于是"手指落在名单上"这一路必须单独接上 —— 否则用户下拉会什么都没发生。
  //   ⛔ 与页面级下拉走**同一条**读取路径（this.pullRefresh，它自己会收掉系统下拉指示），
  //      不另起一套读法，也不改任何业务规则。
  onListRefresh(){
    this.setData({listRefreshing:true})
    const done=()=>this.setData({listRefreshing:false})
    const r=this.pullRefresh()
    if(r&&typeof r.then==='function')r.then(done,done);else setTimeout(done,600)
  },
  // ⭐ 真正读一次云端并重画（自动刷新与下拉刷新共用同一条，不出现两套读法）。
  async cloudRefresh(userInitiated){
    try{const ui=require('../../utils/ui-cloud-command');if(typeof ui.refreshActiveView==='function')await ui.refreshActiveView({userInitiated:!!userInitiated})}catch(error){}
    this.setData({cloudPrimary:mutate.isCloudWritePath()});this.render()
    // ⭐ 权限可能已经变了（别的教练加了/撤了我的授课授权）⇒ 顺手把授权目录拉一次。
    await this.refreshAuthorized()
  },
  async pullRefresh(){
    const startedAt=Date.now()
    await this.cloudRefresh(true)
    require('../../utils/auto-refresh').recordSample({reason:'pullDown',startedAt})
    if(wx.stopPullDownRefresh)wx.stopPullDownRefresh()
  },
  render(){
    const db=getDB(),th=db.settings.renewThreshold;
    // ⭐ 2026-10-05 · 归档功能已整体撤回 ⇒ **学员一律留在当前名单里，一个都不隐藏**。
    //   ⛔ 完课 / 课包用完 / 任何原因都不会让学员从这里消失；
    //      课程、课时包、训练记录、收入与认领关系全部照旧保留（见 tests/completed-class-keeps-student.test.js）。
    const locals=db.students.filter(currentStudent).map(s=>({...s,abbr:s.abbr||initials(s.name)})).map(s=>{
      const packages=giftsLast((s.packages||[]).filter(p=>p.status!=='reversed')).map(p=>{
        const type=TYPES.find(t=>t.name===p.type)||TYPES[0];
        const left=Number(p.remaining||0);
        const balancePercent=p.total?Math.max(0,Math.min(100,left/Number(p.total)*100)):0;
        return {...p,left,balancePercent,color:type.color,warn:left<=th,gift:!!type.gift};
      });
      // ★ 用完的课时包只在**渲染数据**里收起（visiblePackages），packages 本身一个字不动 ——
      //   续费提醒、统计、撤销、云端快照全都继续依赖完整的那一份。
      const visiblePackages=packages.filter(p=>p.left>0),usedUpCount=packages.length-visiblePackages.length;
      return {...s,searchLetter:((s.abbr||initials(s.name)||'#')[0]).toUpperCase(),packages,visiblePackages,usedUpCount,...rowSummaryOf(visiblePackages)};
    });
    // ⭐ 同一个列表：本地会员 + 被授权服务的会员，同形状 / 同排序 / 同字母分组 / 同续费口径。
    //   合并的只是**这一张列表的数据来源**，底层会员实体一份都没有被合并或复制。
    const students=[...locals,...this.authorizedMembers(locals).map(row=>this.authorizedCard(row,th))]
      .sort((a,b)=>a.searchLetter.localeCompare(b.searchLetter)||a.name.localeCompare(b.name,'zh-CN'));
    const letters=[...new Set(students.map(s=>s.searchLetter))];
    const groups=letters.map(letter=>({letter,id:`letter-${letter}`,students:students.filter(s=>s.searchLetter===letter)}));
    const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter=>({letter,active:letters.includes(letter)}));
    const renew=students.filter(s=>s.packages.some(p=>p.warn));
    const renewList=renew.map(s=>({id:s.id,name:s.name,packages:s.packages.filter(p=>p.warn).slice(0,2).map(p=>({type:p.type,left:p.left}))}));
    const previewNames=renew.slice(0,4).map(s=>s.name).join('、');
    const renewPreview=renew.length>4?`${previewNames}等 ${renew.length} 人`:`${previewNames} · 共 ${renew.length} 人`;
    this.setData({students,groups,alphabet,renewCount:renew.length,renewPreview,renewList,authorizedFailed:!!this._authorizedFailed,authorizedStale:!!this._authorizedStale,countScope:`在读 ${students.length} 人`});
  },
  // 【问题1】新增学员必须**一次就能填完**：云端与本机一视同仁，直接给一行可填的课时包。
  // 之前云端新学员不给行，于是必须先存一个空学员、再回来点「保存这笔课程」。
  add(){const saleDate=todayKey(),packages=[{id:uid(),type:'常规训练',total:'',remaining:'',used:0,price:'',saleAmount:'',saleDate,status:'active',isNew:true,...datePickerData(saleDate)}];this.cancelSheetClose();wx.hideTabBar({animation:true});this.setData({modal:true,renewModal:false,detail:null,profileEditing:true,packageEditing:{0:true},finishedExpanded:false,finishedCount:0,sheetStyle:'',sheetClosing:false,form:{id:'',name:'',phone:'',abbr:'',packages,draftKey:uid()}})},
  openEditor(id){
    const db=getDB(),source=db.students.find(x=>x.id===id);if(!source)return
    const s=JSON.parse(JSON.stringify(source))
    s.packages=giftsLast((s.packages||[]).filter(p=>p.status!=='reversed'))
    s.packages.forEach(p=>{
      p.id=p.id||uid()
      const matches=(db.sales||[]).filter(r=>r.source==='course'&&r.studentId===s.id&&r.packageId===p.id&&r.status!=='reversed'),sale=matches.length===1?matches[0]:null
      p.saleDate=p.saleDate||(sale&&sale.date)||''
      p.saleAmount=sale?Number(sale.amount):null
      p.isNew=false
      p.canEditSale=!!(sale&&(!p.saleId||p.saleId===sale.id))
      // 【问题2】已用完（剩余 0）的课时包在编辑页默认收起；只是**视图**标记，不是删除。
      p.finished=Number(p.remaining)<=0
    })
    const finishedCount=s.packages.filter(p=>p.finished).length
    this.cancelSheetClose()
    wx.hideTabBar({animation:true})
    this.setData({modal:true,renewModal:false,detail:null,profileEditing:false,packageEditing:{},saleEditor:null,finishedExpanded:false,finishedCount,sheetStyle:'',sheetClosing:false,form:s})
  },
  toggleFinished(){this.setData({finishedExpanded:!this.data.finishedExpanded})},
  edit(e){this.openCard(e.currentTarget.dataset.id)},
  detail(e){const db=getDB(),s=db.students.find(x=>x.id===e.currentTarget.dataset.id);
    // ★ 当前详情只列**还没完成**的约课：已完成的单节课不再继续堆在这里。
    //   这是**纯展示层过滤** —— 只算这一份渲染数据，一个字节都不动 db / cache / 云端：
    //   已完成的 booking、训练内容、Income、扣课与所有统计口径全部保留原样
    //   （完整出勤历史在「出勤记录」页，不在这里）。课时包照旧全量显示、剩余课时照旧。
    const all=db.bookings.filter(b=>b.studentId===s.id)
    // ⛔ 已取消的课**不是"还没上的课"**（会员自助取消保留这行，只是不再上）⇒ 走共享口径，不自己写 if。
    const current=scheduleView.pendingListOf(all)
    const history=current.sort((a,b)=>(a.date+timeStr(a)<b.date+timeStr(b)?1:-1)).map(b=>({...b,time:timeStr(b)}))
    this.setData({modal:true,form:null,detail:{...s,packages:(s.packages||[]).filter(p=>p.status!=='reversed'),initial:s.name.slice(0,1),history}})},
  editFromDetail(){this.openEditor(this.data.detail.id)},
  bindMemberFromDetail(){
    const detail=this.data.detail
    if(!detail||!detail.id)return
    this.finishClose()
    wx.navigateTo({url:`/pages/coach-add-member/coach-add-member?studentKey=${encodeURIComponent(detail.id)}`})
  },
  toggleProfileEdit(){this.setData({profileEditing:!this.data.profileEditing})},
  togglePackageEdit(e){const i=+e.currentTarget.dataset.i,packageEditing={...this.data.packageEditing};packageEditing[i]=!packageEditing[i];this.setData({packageEditing})},
  // ⭐ 2026-10-03 · 整张课时包卡片可点：这里**只做分流**，不写任何业务数据。
  //   两条分支走的都是原有的 openSaleEditor / togglePackageEdit（入口、保护、文案一个字没改）。
  //   ⛔ 分流判据 = `canEditSale`（openEditor 里算的：这条包能找到**唯一**一条未撤销的 source=course 销售，
  //      且包上的 saleId 与它一致）⇒ 查不到唯一销售关联的历史包**不给编辑入口**，只能查看。
  //      这不是"功能没做"：没有唯一销售关联时改总课时 / 单价 / 业绩，会动到对不上账的销售记录与收入。
  packageCardTap(e){
    const index=+e.currentTarget.dataset.i,pkg=(this.data.form&&this.data.form.packages||[])[index]
    if(!pkg)return
    const editable=!pkg.isNew&&pkg.type!=='赠送课程'&&pkg.canEditSale
    return editable?this.openSaleEditor(e):this.togglePackageEdit(e)
  },
  field(e){const k=e.currentTarget.dataset.field,v=e.detail.value,patch={[`form.${k}`]:v};if(k==='name')patch['form.abbr']=initials(v);this.setData(patch)},
  pkg(e){const i=+e.currentTarget.dataset.i,k=e.currentTarget.dataset.k,v=k==='type'?TYPES[e.detail.value].name:e.detail.value,patch={[`form.packages[${i}].${k}`]:v};if(k==='type'&&TYPES[e.detail.value].gift)patch[`form.packages[${i}].price`]='80';this.setData(patch);this.setData({})},
  saleDateColumnChange(e){const i=+e.currentTarget.dataset.i,column=+e.detail.column,value=+e.detail.value,pack=this.data.form.packages[i],dateValue=pack.dateValue.slice(),dateRange=pack.dateRange.map(x=>x.slice());dateValue[column]=value;if(column<2){const days=Array.from({length:monthDays(dateRange[0][dateValue[0]],dateRange[1][dateValue[1]])},(_,n)=>String(n+1).padStart(2,'0'));dateRange[2]=days;dateValue[2]=Math.min(dateValue[2],days.length-1)}this.setData({[`form.packages[${i}].dateRange`]:dateRange,[`form.packages[${i}].dateValue`]:dateValue})},
  saleDateChange(e){const i=+e.currentTarget.dataset.i,pack=this.data.form.packages[i],value=e.detail.value,date=`${pack.dateRange[0][value[0]]}-${pack.dateRange[1][value[1]]}-${pack.dateRange[2][value[2]]}`;this.setData({[`form.packages[${i}].saleDate`]:date,[`form.packages[${i}].dateValue`]:value})},
  addPkg(){const saleDate=todayKey(),next={id:uid(),type:'常规训练',total:'',remaining:'',used:0,price:'',saleAmount:'',saleDate,teachingCodes:'',status:'active',isNew:true,...datePickerData(saleDate)},p=this.data.form.packages.slice(),giftAt=p.findIndex(x=>x.type==='赠送课程'),at=giftAt<0?p.length:giftAt;p.splice(at,0,next);this.setData({'form.packages':p,packageEditing:{[at]:true},saleEditor:null})},
  openSaleEditor(e){const packageId=e.currentTarget.dataset.id,db=getDB(),pkg=this.data.form.packages.find(item=>item.id===packageId),context=resolveCourseSale(db,this.data.form.id,packageId,pkg&&pkg.saleId);if(!context.ok)return wx.showModal({title:'无法编辑销售',content:context.message,showCancel:false,confirmText:'知道了'});const rawDate=context.sale.date||context.pkg.saleDate,date=validDateKey(rawDate)?rawDate:todayKey();this.setData({saleEditor:{packageId,saleId:context.sale.id,type:context.pkg.type,total:String(context.pkg.total),quantity:String(context.sale.quantity==null?context.pkg.total:context.sale.quantity),remaining:String(context.pkg.remaining),unitPrice:String(context.sale.unitPrice==null?context.pkg.price:context.sale.unitPrice),amount:String(context.sale.amount),date,used:Number(context.pkg.used||0),...datePickerData(date)}})},
  saleEditorField(e){this.setData({[`saleEditor.${e.currentTarget.dataset.k}`]:e.detail.value})},
  saleEditorType(e){this.setData({'saleEditor.type':this.data.saleTypes[e.detail.value].name})},
  saleEditorDateColumnChange(e){const column=+e.detail.column,value=+e.detail.value,editor=this.data.saleEditor,dateValue=editor.dateValue.slice(),dateRange=editor.dateRange.map(x=>x.slice());dateValue[column]=value;if(column<2){const days=Array.from({length:monthDays(dateRange[0][dateValue[0]],dateRange[1][dateValue[1]])},(_,n)=>String(n+1).padStart(2,'0'));dateRange[2]=days;dateValue[2]=Math.min(dateValue[2],days.length-1)}this.setData({'saleEditor.dateRange':dateRange,'saleEditor.dateValue':dateValue})},
  saleEditorDateChange(e){const editor=this.data.saleEditor,value=e.detail.value,date=`${editor.dateRange[0][value[0]]}-${editor.dateRange[1][value[1]]}-${editor.dateRange[2][value[2]]}`;this.setData({'saleEditor.date':date,'saleEditor.dateValue':value})},
  closeSaleEditor(){this.setData({saleEditor:null})},
  saveSaleEditor(){this.persistSaleEditor(false)},
  async persistSaleEditor(confirmInconsistent){const editor=this.data.saleEditor;if(!editor)return;const changes={type:editor.type,total:Number(editor.total),quantity:Number(editor.quantity),remaining:Number(editor.remaining),unitPrice:Number(editor.unitPrice),amount:Number(editor.amount),date:editor.date};if(mutate.isCloudWritePath()){if(Number(editor.total)<Number(editor.used||0)&&!confirmInconsistent)return wx.showModal({title:'请确认数据',content:`历史已完成${editor.used}节，仍要把总课时改为${editor.total}节吗？`,confirmText:'仍然保存',success:r=>{if(r.confirm)this.persistSaleEditor(true)}});return mutate(null,null,{key:`updateCourseSale:${editor.saleId}`,command:'updateCourseSale',payload:{saleId:editor.saleId,packageId:editor.packageId,...changes,...(confirmInconsistent?{confirmTotalBelowUsed:true}:{})},successTitle:'销售已更新',onSuccess:async()=>{this.render();this.openEditor(this.data.form.id)}})}const result=updateCourseSale(editor.saleId,changes,{confirmInconsistent});if(!result.ok){if(result.needsConfirm)return wx.showModal({title:'请确认数据',content:result.message,confirmText:'仍然保存',success:r=>{if(r.confirm)this.persistSaleEditor(true)}});return wx.showModal({title:'无法保存',content:result.message,showCancel:false,confirmText:'知道了'})}const index=this.data.form.packages.findIndex(item=>item.id===editor.packageId);if(index>=0)this.setData({[`form.packages[${index}].type`]:result.pkg.type,[`form.packages[${index}].total`]:result.pkg.total,[`form.packages[${index}].used`]:result.pkg.used,[`form.packages[${index}].remaining`]:result.pkg.remaining,[`form.packages[${index}].price`]:result.pkg.price,[`form.packages[${index}].saleAmount`]:result.sale.amount,[`form.packages[${index}].saleDate`]:result.pkg.saleDate,[`form.packages[${index}].saleId`]:result.sale.id,saleEditor:null});this.render();const [year,month]=result.sale.date.split('-').map(Number);wx.showToast({title:`已计入${year}年${month}月`,icon:'none'})},
  // 【问题1】新课时包的 payload **唯一构造入口**：「保存这笔课程」与「保存资料」共用同一份。
  // 绝不允许出现第二条会写出不同 payload 的路径 —— 那就是两套保存逻辑。
  // 业务规则一字未改：total / remaining 原样下发，quantity=total，unitPrice=单价，amount=她填的实际业绩。
  newPackageCommand(pkg,studentId){
    const total=Number(pkg.total),remaining=Number(pkg.remaining)
    // ⭐ M2 V1：本次课包的可授课教练（公开码，服务端翻译成真实 coachId；客户端永远提交不了 coachId）。
    //   销售业绩仍归**创建这笔销售的人**（sale 写在这本账），管理权也默认归创建人 ——
    //   被加入名单只获得授课权。
    //   ⭐ 2026-09-29：赠课**同样适用**（复用同一个表单字段、同一份 payload，不要第二条路径）：
    //   A 发出去的赠课可以授权 B 上课；接收人只拿授课权，管理权仍归发赠课的 A。
    const teachingPublicCodes=String(pkg.teachingCodes||'').split(',').map(code=>code.trim()).filter(Boolean)
    if(pkg.type==='赠送课程')return {ok:true,command:'createPackage',payload:{studentId,type:'赠送课程',total,remaining,isGift:true,...(teachingPublicCodes.length?{teachingPublicCodes}:{})}}
    if(!Number.isFinite(Number(pkg.price))||Number(pkg.price)<=0)return {ok:false,message:'请填写完整销售信息'}
    if(!Number.isFinite(Number(pkg.saleAmount))||Number(pkg.saleAmount)<=0)return {ok:false,message:'请填写完整销售信息'}
    if(!validDateKey(pkg.saleDate))return {ok:false,message:'请选择业绩归属日期'}
    return {ok:true,command:'createCourseSale',payload:{studentId,type:pkg.type,total,remaining,quantity:total,unitPrice:Number(pkg.price),amount:Number(pkg.saleAmount),date:pkg.saleDate,...(teachingPublicCodes.length?{teachingPublicCodes}:{})}}
  },
  async persistPackage(e){const index=+e.currentTarget.dataset.i,pkg=this.data.form.packages[index];if(!mutate.isCloudWritePath()||!pkg)return;const total=Number(pkg.total),remaining=Number(pkg.remaining);if(!Number.isInteger(total)||total<=0||!Number.isInteger(remaining)||remaining<0)return wx.showToast({title:'请填写有效课时数',icon:'none'});let built;if(pkg.isNew){built=this.newPackageCommand(pkg,this.data.form.id);if(!built.ok)return wx.showToast({title:built.message,icon:'none'})}else built={command:'updatePackage',payload:{packageId:pkg.id,total,remaining}};return mutate(null,null,{key:`${built.command}:${pkg.id}`,command:built.command,payload:built.payload,successTitle:pkg.isNew?'课程已新增':'赠送课已更新',onSuccess:async()=>{this.render();this.openEditor(this.data.form.id)}})},
  removePkg(e){
    const index=+e.currentTarget.dataset.i,pkg=this.data.form.packages[index]
    if(!pkg)return
    if(pkg.isNew){const packages=this.data.form.packages.filter((_,i)=>i!==index);return this.setData({'form.packages':packages,packageEditing:{}})}
    const content='将从当前会员资料中删除这个课时包，并先取消它所有未上预约。销售业绩、已经上完的课程、训练内容和历史收入都会保留。'
    wx.showModal({title:'删除这个课时包？',content,confirmColor:'#c7563d',confirmText:'确认删除',success:async answer=>{
      if(!answer.confirm)return
      if(mutate.isCloudWritePath()){
        await mutate(null,null,{key:`deletePackage:${pkg.id}`,command:'deletePackage',payload:{packageId:pkg.id},successTitle:'课时包已删除',onSuccess:async()=>{this.render();this.openEditor(this.data.form.id)}})
        return
      }
      const db=getDB(),student=db.students.find(item=>item.id===this.data.form.id),target=student&&(student.packages||[]).find(item=>item.id===pkg.id)
      if(!target)return wx.showToast({title:'该课时包已不存在',icon:'none'})
      db.bookings=(db.bookings||[]).filter(booking=>!(booking.studentId===student.id&&booking.packageId===pkg.id&&booking.status!=='done'))
      target.remaining=0;target.status='reversed';target.closedAt=Date.now();target.closedReason='package-deleted'
      saveDB(db)
      this.render();this.openEditor(this.data.form.id);wx.showToast({title:'课时包已删除',icon:'none'})
    }})
  },
  save(){return this.persistStudent(false)},
  // 失败必须说清楚：中途失败**绝不允许**报"全部成功"。
  reportSaveFailure(message,options){const detail=options&&options.detail,partial=!!(options&&options.partial),code=detail&&detail.code,reason=detail&&detail.message?`（${detail.message}）`:(code&&SAVE_FAILURE_HINTS[code]?`（${SAVE_FAILURE_HINTS[code]}）`:'');wx.showModal({title:partial?'部分保存成功':'保存失败',content:`${message}${reason}。${partial?'已保存的内容不会重复创建，请修正后重新点一次保存。':'请检查后重试。'}`,showCancel:false,confirmText:'知道了'})},
  // 【问题1】云端：一次「保存」= 学员 +（页面上填好的）每一笔课时包 + 对应销售。
  // 时序固定「先学员、后课时包」（销售必须挂在已经存在的学员上）。
  // 任何一步失败都如实告知并**原地保留她的输入**；重试只补没成功的那几笔，绝不建第二个学员。
  async saveStudentContents(confirmInconsistent){
    const f=this.data.form
    const wasCreating=!f.id
    if(mutate.isCloudWritePath()){
      if(!f.name.trim())return wx.showToast({title:'请填写姓名',icon:'none'})
      // ① 先把所有"还没保存"的课时包校验完 —— 前置校验不通过时云端一个字节都不许动。
      const drafts=(f.packages||[]).map((pkg,index)=>({pkg,index})).filter(item=>item.pkg.isNew||!item.pkg.id)
      const prepared=[]
      for(let n=0;n<drafts.length;n++){
        const pkg=drafts[n].pkg
        const untouched=['total','remaining','price','saleAmount'].every(field=>String(pkg[field]==null?'':pkg[field]).trim()==='')
        if(untouched)continue
        const total=Number(pkg.total),remaining=Number(pkg.remaining)
        if(!Number.isInteger(total)||total<=0||!Number.isInteger(remaining)||remaining<0)return wx.showToast({title:'请填写有效课时数',icon:'none'})
        const built=this.newPackageCommand(pkg,f.id||'')
        if(!built.ok)return wx.showToast({title:built.message,icon:'none'})
        prepared.push({index:drafts[n].index,command:built.command})
      }
      // ★ 本机原子批次：**新增**与**新增失败后的重试**走同一条实现。
      //   历史真机故障：第一次保存课时包那几笔没成功 → form.id 已被写上 →
      //   用户再点一次保存时 `!f.id` 不再成立 → 掉到下面那条旧路径 → 课时包继续走云端先行的
      //   createPackage / createCourseSale → 被 readActive 失败挡在出网之前，报了
      //   「最新数据暂时没读到」。**同一个动作，只因为失败过一次，就换了一套语义。**
      //   这里改成：只要本机先行可用，学员资料 + 本次新填的课时包一律作为一个本机批次落地，
      //   有 f.id 就跳过 createStudent 直接挂在它下面。旧路径只在「本机先行不可用」时兜底。
      if(mutate.localFirstEnabled()){
        const packages=prepared.map(item=>{
          const pkg=this.data.form.packages[item.index]
          const built=this.newPackageCommand(pkg,f.id||'')
          return {command:built.command,payload:built.payload,clientKey:pkg.id}
        })
        const saved=await mutate.saveStudentBatch({batchKey:f.draftKey||f.id,studentId:f.id||'',name:f.name.trim(),phone:f.phone||'',packages})
        if(saved&&saved.ok){
          const studentId=saved.result.studentId
          const byKey={};((saved.result&&saved.result.packages)||[]).forEach(row=>{byKey[row.clientKey]=row})
          prepared.forEach(item=>{
            const key=this.data.form.packages[item.index].id,row=byKey[key]
            if(row)this.setData({[`form.packages[${item.index}].isNew`]:false,[`form.packages[${item.index}].id`]:row.packageId||key,[`form.packages[${item.index}].saleId`]:row.saleId||null})
          })
          this.setData({'form.id':studentId})
          this.render()
          this.openEditor(studentId)
          if(!f.id)this.setData({profileEditing:false})
          if(wasCreating)this.prewarmMemberQr(studentId)
          // ★ 这里刻意**不弹**「已保存在本机，正在同步」。
          //   本机先行的意义就是"用户的操作已经完成了"：整批业务在本机事务里跑完、校验一次不少、
          //   事实立刻出现在投影里（表单与列表当场就是最新值）。再补一句"正在同步"，
          //   等于告诉用户"现在才算成功"，把一个已经完成的操作重新说成进行中。
          //   后台同步是后台的事：成功完全静默；只有**明确业务拒绝**才由同步引擎提示一次
          //   （sync-engine 的「有 1 项操作没能同步，已按云端为准」）。看见它才是真的需要看一眼。
          //   安全机制一条没动：Outbox / receipt / requestId / revision / 重试 全部照旧，
          //   改的只是用户体验层。
          return saved
        }
        if(saved&&saved.code!=='LOCAL_FIRST_UNAVAILABLE')return this.reportSaveFailure('学员与课程没有保存成功',{detail:saved})
        // 本机先行不可用（cache 未就绪等）→ 落到下面的旧路径兜底，绝不假装已保存。
      }
      // ② 学员先行（静默通道：还不确定整批能不能成功，所以现在不弹任何"成功"提示）。
      // 幂等号带上本次"新增会话"的一次性身份：同一会话内重试用**同一个** requestId（真正的幂等保护），
      // 下一次新增学员天然是新号 —— 绝不与上一次的新增撞成"同一次请求"。
      const creating=!f.id,command=creating?'createStudent':'updateStudent',payload=creating?{name:f.name.trim(),phone:f.phone||''}:{studentId:f.id,name:f.name.trim(),phone:f.phone||''}
      const head=await mutate(null,null,{key:creating?`createStudent:${f.draftKey||'new'}`:`updateStudent:${f.id}`,command,payload,strategy:'silent',coalesceKey:creating?null:`student-profile:${f.id}`})
      if(!head||!head.ok)return this.reportSaveFailure(creating?'学员没有保存成功':`${f.name.trim()}的资料没有保存成功`,{detail:head})
      let studentId=f.id
      if(creating){
        studentId=(head.result&&head.result.studentId)||''
        if(!studentId)return this.reportSaveFailure('学员已建立，但没有保存成功的是"云端编号"，请重新进入列表确认',{partial:true})
        this.setData({'form.id':studentId})
      }
      // ③ 课时包逐笔落下：成功的当场转成"既有行"（重试绝不会重复创建），失败的原样留在表单里。
      const failed=[],savedDates=[]
      for(let n=0;n<prepared.length;n++){
        const current=this.data.form.packages[prepared[n].index]
        const built=this.newPackageCommand(current,studentId)
        if(!built.ok){failed.push(current.type);continue}
        const result=await mutate(null,null,{key:`${built.command}:${current.id}`,command:built.command,payload:built.payload,strategy:'silent'})
        if(result&&result.ok){
          this.setData({[`form.packages[${prepared[n].index}].isNew`]:false,[`form.packages[${prepared[n].index}].id`]:(result.result&&result.result.packageId)||current.id,[`form.packages[${prepared[n].index}].saleId`]:(result.result&&result.result.saleId)||null})
          if(built.command==='createCourseSale')savedDates.push(current.saleDate)
        }else failed.push(current.type)
      }
      if(failed.length)return this.reportSaveFailure(`「${failed.join('、')}」没有保存成功`,{partial:true})
      this.render()
      if(creating)this.openEditor(studentId)
      else{this.openEditor(f.id);this.setData({profileEditing:false})}
      if(creating)this.prewarmMemberQr(studentId)
      const months=[...new Set(savedDates.map(date=>{const [year,month]=date.split('-').map(Number);return `${year}年${month}月`}))]
      if(months.length)wx.showModal({title:'保存成功',content:`业绩已${months.length>1?'分别':''}计入${months.join('、')}`,showCancel:false})
      else wx.showToast({title:creating?'学员已创建':'资料已更新',icon:'none'})
      return head
    }
    if(!f.name.trim()||!f.packages.length)return wx.showToast({title:'请填写姓名和课时包',icon:'none'})
    const rawPackages=f.packages.slice()
    const db=getDB(),old=f.id?db.students.find(s=>s.id===f.id):null,oldAllPackages=old?old.packages||[]:[],oldPackages=oldAllPackages.filter(p=>p.status!=='reversed')
    const invalidNewPackage=f.packages.find(p=>(p.isNew||p.type==='赠送课程')&&(!Number.isInteger(Number(p.total))||Number(p.total)<=0||!Number.isInteger(Number(p.remaining))||Number(p.remaining)<0||(p.isNew&&p.type!=='赠送课程'&&(!Number.isFinite(Number(p.price))||Number(p.price)<=0||!Number.isFinite(Number(p.saleAmount))||Number(p.saleAmount)<=0))))
    if(invalidNewPackage)return wx.showToast({title:'请填写有效的课时数和价格',icon:'none'})
    const invalidNewDate=f.packages.find(p=>p.isNew&&p.type!=='赠送课程'&&!validDateKey(p.saleDate))
    if(invalidNewDate)return wx.showToast({title:'请选择业绩归属日期',icon:'none'})
    f.name=f.name.trim();f.abbr=initials(f.name)
    const omittedExisting=oldPackages.find(p=>!f.packages.some(current=>current.id===p.id))
    if(omittedExisting)return wx.showModal({title:'请使用撤销入口',content:'已有课时包不能通过普通保存静默删除，请进入对应课时包使用“撤销这笔销售”。',showCancel:false,confirmText:'知道了'})
    const warnings=[]
    f.packages.filter(p=>p.isNew||p.type==='赠送课程').forEach(p=>{const total=Number(p.total),remaining=Number(p.remaining),used=Number(p.used||0);if(remaining>total)warnings.push(`${p.type}的剩余课时高于购买课时`);if(total<used)warnings.push(`${p.type}历史已完成${used}节，但购买课时为${total}节`);if(p.isNew&&p.type!=='赠送课程'&&Number((total*Number(p.price)).toFixed(2))!==Number(Number(p.saleAmount).toFixed(2)))warnings.push(`${p.type}的销售业绩与购买数量×单价不一致`)})
    if(warnings.length&&!confirmInconsistent)return wx.showModal({title:'请确认数据',content:`${warnings.join('；')}。是否仍然保存？`,confirmText:'仍然保存',success:r=>{if(r.confirm)this.persistStudent(true)}})
    const activePackages=giftsLast(f.packages.filter(p=>+p.total>0).map(p=>{const prior=oldPackages.find(x=>x.id===p.id),gift=p.type==='赠送课程';if(prior&&prior.type!=='赠送课程')return {...prior,saleId:p.saleId||prior.saleId};if(prior&&prior.type==='赠送课程'&&!gift)return prior;return {id:p.id||uid(),type:p.type,total:+p.total,used:prior?Number(prior.used||0):0,remaining:Number(p.remaining),price:gift?80:+p.price,saleDate:p.saleDate,status:'active',...(p.saleId?{saleId:p.saleId}:{})}}))
    f.packages=activePackages
    const studentId=f.id||uid()
    const newSaleDates=[]
    f.packages.forEach(p=>{
      const prior=oldPackages.find(x=>x.id===p.id)
      if(prior||p.type==='赠送课程')return
      const source=rawPackages.find(item=>item.id===p.id),quantity=Number(p.total),amount=Number(Number(source&&source.saleAmount).toFixed(2))
      if(quantity&&amount){const saleId=uid();p.saleId=saleId;db.sales.push({id:saleId,date:p.saleDate,source:'course',status:'active',studentId,packageId:p.id,typeName:p.type,quantity,unitPrice:Number(p.price),amount,note:`${f.name} · ${p.type} ${quantity}节`});newSaleDates.push(p.saleDate)}
    })
    const reversedPackages=oldAllPackages.filter(p=>p.status==='reversed')
    const storedForm={...f,packages:activePackages.concat(reversedPackages)}
    if(f.id){const i=db.students.findIndex(s=>s.id===f.id);db.students[i]=storedForm}else db.students.push({...storedForm,id:studentId})
    saveDB(db);this.close();this.render();const months=[...new Set(newSaleDates.map(date=>{const [year,month]=date.split('-').map(Number);return `${year}年${month}月`}))];if(months.length)wx.showModal({title:'保存成功',content:`业绩已${months.length>1?'分别':''}计入${months.join('、')}`,showCancel:false});else wx.showToast({title:'保存成功',icon:'success'})
  },
  removeStudentData(id){if(mutate.isCloudWritePath())return mutate(null,null,{key:`deleteStudent:${id}`,command:'deleteStudent',payload:{studentId:id},successTitle:'学员已删除',onSuccess:async()=>{this.close();this.render()}});const db=getDB(),result=deleteStudentAligned(db,id);if(!result.ok)return wx.showToast({title:result.message,icon:'none'});saveDB(db);this.close();this.render()},
  deleteFormStudent(){const id=this.data.form.id;if(!id)return;wx.showModal({title:'删除学员',content:'将停用该学员的课时包与课程销售，并删除未完成预约；已完成课程、已用课时和历史收入会保留。',confirmColor:'#c7563d',success:r=>{if(r.confirm)this.removeStudentData(id)}})},
  sandboxGate(command){if(routing.blocked(command,tools.environment())){wx.showToast({title:routing.SANDBOX_ONLY_MESSAGE,icon:'none'});return true}return false},
  // ⭐ 2026-10-06：旧的「会员端身份认领 / 生成认领码」入口已下线 ⇒ 改成看这位会员的详情。
  // ⭐⭐ 2026-10-04 需求 B · 学员列表页顶部那个「邀请会员认领」入口。
  //   ⛔ **不带 studentId** 是刻意的：这一层没有"当前选中的学员"（那是详情 sheet 的状态，sheet 关掉就没了），
  //      硬传一个会是 undefined/stale 的 id，比不传更糟（教练会对着错的学员发邀请）。
  //      ⇒ 跳到工具页，由它**先列名单让教练点一位**，再发邀请。
  //   ⛔ 本轮只新增入口：`deleteFormStudent` 与其它既有绑定一个字都不动（已真机验收）。
  showRenewDetails(){if(!this.data.renewCount)return;wx.hideTabBar({animation:true});this.setData({renewModal:true})},
  closeRenewDetails(){wx.showTabBar({animation:true});this.setData({renewModal:false})},
  openRenewStudent(e){this.openCard(e.currentTarget.dataset.id)},
  del(){const id=this.data.detail.id;wx.showModal({title:'删除学员',content:'将停用该学员的课时包与课程销售，并删除未完成预约；已完成课程、已用课时和历史收入会保留。',success:r=>{if(r.confirm)this.removeStudentData(id)}})},
  // ⭐ 2026-10-03 · 字母导航改成**滚动区内部定位**（`scroll-into-view`）。
  //   ⛔ 为什么必须换：名单现在住在自己的 `.students-scroll` 里，**页面已经不再滚动**
  //      ⇒ 原来的 `wx.pageScrollTo` 会变成一条"点了没反应"的死入口（页面根本没得滚）。
  //   ⚠️ `scroll-into-view` 是**受控**属性：值没变微信不会再滚一次 ⇒ 同一个字母连点两次要
  //      "先清空、下一帧再设"，否则第二次点击静默失效。
  //   ⛔ 目标 id 仍然来自 `#letter-{{letter}}`（分组时写好的 `id:\`letter-${letter}\``），一个字没改。
  jumpLetter(e){
    const letter=String(e.currentTarget.dataset.letter||'');
    if(!e.currentTarget.dataset.active)return;
    const target=`letter-${letter}`;
    if(this.data.scrollTarget===target){this.setData({scrollTarget:''},()=>this.setData({scrollTarget:target}));return}
    this.setData({scrollTarget:target})
  },
  sheetTouchStart(e){if(this._closingSheet)return;this.sheetStartY=e.touches[0].clientY;this.sheetDrag=0},
  sheetTouchMove(e){if(this.sheetStartY==null||this._closingSheet)return;const raw=Math.max(0,e.touches[0].clientY-this.sheetStartY);this.sheetDrag=raw;this.setData({sheetStyle:`animation:none;transform:translateY(${Math.pow(raw,.92)}px);transition:none`})},
  sheetTouchEnd(){if(this.sheetStartY==null||this._closingSheet)return;const shouldClose=this.sheetDrag>150;this.sheetStartY=null;this.sheetDrag=0;if(shouldClose)return this.close(true);this.setData({sheetStyle:'animation:none;transform:translateY(0);transition:transform .32s cubic-bezier(.2,.8,.2,1)'})},
  cancelSheetClose(){if(this._closeTimer)clearTimeout(this._closeTimer);this._closeTimer=null;this._closingSheet=false},
  finishClose(){this.cancelSheetClose();wx.showTabBar({animation:true});this.setData({modal:false,renewModal:false,detail:null,form:null,profileEditing:false,packageEditing:{},saleEditor:null,finishedExpanded:false,finishedCount:0,sheetStyle:'',sheetClosing:false})},
  // ── M2 第二批：跨教练共享**同一份**会员真实课时 ──
  // ⚠️ 这里只发一枚「共享码」，**绝不复制余额**：别的教练拿着码排课时，
  //    扣的是本教练这本账里**同一个** remaining、占的是**同一个** reserved。
  //    课时包的所有权属于会员本人；ownerCoachId/datasetId 只是存储位置。
  async setPackageShare(packageId,enabled){
    if(!packageId)return
    if(!mutate.isCloudWritePath())return wx.showToast({title:'云端模式下才能共享课时包',icon:'none'})
    const on=enabled!==false
    return mutate(null,null,{key:`setPackageShare:${packageId}:${on?'on':'off'}`,command:'setPackageShare',payload:{packageId,enabled:on},successTitle:on?'':'已停止共享',onSuccess:res=>{
      const code=res&&res.result&&res.result.shareCode
      if(on&&code)wx.showModal({title:'共享码已生成',content:`把这枚共享码给到要上课的教练：\n\n${code}\n\n他排课时会直接消耗这个课时包的真实剩余课时（不会另外复制一份）。`,showCancel:false,confirmText:'知道了'})
      this.render()
    },onRefresh:()=>this.render()})
  },
  // 用别的教练给的共享码排一节课。时间由调用方（课表 / 学员页）通过 data-* 传入；
  // 没有传时间时先要一枚共享码，再由课表页补齐时间后调用 —— 本机**不猜**时间。
  async bookShared(e){
    const data=(e&&e.currentTarget&&e.currentTarget.dataset)||{}
    if(!mutate.isCloudWritePath())return wx.showToast({title:'云端模式下才能用共享码排课',icon:'none'})
    const submit=code=>{
      const hour=Number(data.hour),minute=Number(data.minute||0)
      if(!data.date||!Number.isInteger(hour))return wx.showToast({title:'请先选择上课日期与时间',icon:'none'})
      // ⭐ 出网前先过同一道时间闸：**开始 ≤ 23:00 且 结束 ≤ 当天 24:00**（与云端同一把尺）。
      //    ⚠️ 用 showModal 不用 showToast：toast 会截断长句，剩下半句等于没说。
      const plannedMinutes=data.plannedMinutes?Number(data.plannedMinutes):occupancy.DEFAULT_PLANNED_MINUTES
      const gate=occupancy.lessonWindowGateOf({hour,minute},plannedMinutes)
      if(gate)return wx.showModal({title:'这个时间排不了',content:gate.message,showCancel:false})
      return mutate(null,null,{key:`createSharedBooking:${code}:${data.date}:${hour}:${minute}`,command:'createSharedBooking',payload:{shareCode:code,date:data.date,hour,minute,...(data.plannedMinutes?{plannedMinutes:Number(data.plannedMinutes)}:{})},successTitle:'已排课',onRefresh:()=>this.render()})
    }
    const preset=data.shareCode?String(data.shareCode).trim().toUpperCase():''
    if(preset)return submit(preset)
    wx.showModal({title:'输入共享码',content:'向课时包所属教练索取共享码',editable:true,placeholderText:'例如 9F2C1A7B03',confirmText:'排课',success:r=>{if(r.confirm&&r.content)submit(String(r.content).trim().toUpperCase())}})
  },
  close(fromDrag){if(this.data.saving||this._closingSheet)return;if(!this.data.form)return this.finishClose();this._closingSheet=true;this.setData({sheetClosing:true,sheetStyle:fromDrag===true?'animation:none;transform:translateY(100%);transition:transform .28s cubic-bezier(.4,0,1,1)':'animation:studentSheetOut .28s cubic-bezier(.4,0,1,1) both'});this._closeTimer=setTimeout(()=>this.finishClose(),300)}
}, { refresh() { return this.cloudRefresh(false) } }))
