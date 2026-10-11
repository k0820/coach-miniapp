const { TYPES } = require('../../utils/constants')
const { getDB, saveDB, uid, dateStr } = require('../../utils/data-runtime')
const { todayKey, dateParts, monthDateKey, addMonths } = require('../../utils/beijing-date')
const { validDateKey, updateCourseSale, saleRemovalPlan, reverseSale } = require('../../utils/course-sales')
const mutate = require('../../utils/mutate')
const { isSandbox } = require('../../utils/data-runtime')
const { sha256, utf8ByteLength } = require('../../utils/sha256')
const { createBackupEnvelope, restoreClipboardBackup } = require('../../utils/local-backup')
const { CLOUD_BACKUP_META_KEY, decideCloudBackup, writeKnownVersion } = require('../../utils/cloud-backup-version')
const { uploadSnapshotInChunks, readCloudBackup } = require('../../utils/cloud-chunk-client')
const { migrationMetadata } = require('../../utils/cloud-migration')
const releaseFlags = require('../../utils/release-flags')
// 历史结算 → 课时结算：会员那一行的课程明细（只读翻译层，关联只走 bookingId）。
const { bookingIndex, lessonListOf } = require('../../utils/settlement-detail')
function breakdown(records){const total=records.reduce((n,r)=>n+Number(r.amount||0),0),list=[];TYPES.forEach(t=>{const amount=records.filter(r=>r.typeName===t.name).reduce((n,r)=>n+Number(r.amount||0),0);if(amount)list.push({...t,amount:Number(amount.toFixed(2))})});const other=records.filter(r=>!TYPES.some(t=>t.name===r.typeName)).reduce((n,r)=>n+Number(r.amount||0),0);if(other)list.push({name:'其他业绩',color:'#64748b',amount:Number(other.toFixed(2))});let acc=0,parts=[];list.forEach(x=>{const start=acc,pct=total?x.amount/total*100:0;acc+=pct;parts.push(`${x.color} ${start.toFixed(2)}% ${acc.toFixed(2)}%`)});return {total:Number(total.toFixed(2)),list,ring:parts.length?`background:conic-gradient(${parts.join(',')})`:'background:#eee8df'}}
function presentSales(db,records){return records.map(sale=>{const student=sale.studentId&&(db.students||[]).find(item=>item.id===sale.studentId),noteName=String(sale.note||'').split(' · ')[0];return {...sale,legacyReadonly:sale.legacyRelationStatus==='orphan',displayName:sale.source==='course'?(student?student.name:(noteName||'已删学员')):(sale.name||sale.note||'其他业绩')}})}
function saleConfirmText(plan){
  const sale=plan.sale,student=plan.student,name=sale.source==='course'?(student&&student.name||sale.note||'已删学员'):(sale.name||sale.note||'手动业绩'),type=sale.typeName||(sale.source==='course'?'课程销售':'手动业绩')
  return `${sale.date||'日期未记录'}\n${name}\n${type} · ¥${Number(sale.amount||0).toFixed(2)}`
}
const HISTORY_SALE_DATE_YEARS=Array.from({length:131},(_,i)=>String(1970+i)),HISTORY_SALE_DATE_MONTHS=Array.from({length:12},(_,i)=>String(i+1).padStart(2,'0'))
function historySaleDatePicker(key){const parts=(validDateKey(key)?key:todayKey()).split('-'),yearIndex=Math.max(0,HISTORY_SALE_DATE_YEARS.indexOf(parts[0])),monthIndex=Math.max(0,HISTORY_SALE_DATE_MONTHS.indexOf(parts[1])),dayCount=new Date(Date.UTC(Number(HISTORY_SALE_DATE_YEARS[yearIndex]),Number(HISTORY_SALE_DATE_MONTHS[monthIndex]),0)).getUTCDate(),days=Array.from({length:dayCount},(_,i)=>String(i+1).padStart(2,'0')),dayIndex=Math.min(days.length-1,Math.max(0,Number(parts[2])-1));return {editDateRange:[HISTORY_SALE_DATE_YEARS,HISTORY_SALE_DATE_MONTHS,days],editDateValue:[yearIndex,monthIndex,dayIndex]}}
function coachSnapshotSummary(snapshot){if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)||!Array.isArray(snapshot.students)||!Array.isArray(snapshot.bookings)||!Array.isArray(snapshot.incomes))return null;const sales=Array.isArray(snapshot.sales)?snapshot.sales:[],customExercises=Array.isArray(snapshot.customExercises)?snapshot.customExercises:[];return {students:snapshot.students.length,packages:snapshot.students.reduce((count,student)=>count+(Array.isArray(student.packages)?student.packages.length:0),0),bookings:snapshot.bookings.length,completedBookings:snapshot.bookings.filter(booking=>booking.status==='done').length,incomes:snapshot.incomes.length,sales:sales.length,customExercises:customExercises.length,hasSettings:!!snapshot.settings}}
function canonicalJson(value){if(Array.isArray(value))return `[${value.map(item=>canonicalJson(item)).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;return JSON.stringify(value)}
function snapshotComparisonChecksum(snapshot){return sha256(canonicalJson(snapshot))}
function inspectCloudBackup(result,local){if(!result||!result.ok)return {ok:false,notFound:!!(result&&result.code==='NOT_FOUND'),message:(result&&result.message)||'云函数没有返回有效结果'};const snapshot=result.snapshot,actualSummary=coachSnapshotSummary(snapshot),snapshotJson=actualSummary?JSON.stringify(snapshot):'',chunked=result.backupFormatVersion===2,chunkMeta=actualSummary&&chunked?migrationMetadata(snapshot):null,actualChecksum=actualSummary?(chunked?chunkMeta.checksum:sha256(snapshotJson)):'',actualByteSize=actualSummary?(chunked?chunkMeta.byteSize:utf8ByteLength(snapshotJson)):0,summary=result.summary||{},summaryMatches=!!(actualSummary&&Object.keys(actualSummary).every(key=>actualSummary[key]===summary[key])),checksumMatches=result.checksumAlgorithm==='sha256'&&actualChecksum===result.checksum,byteSizeMatches=actualByteSize===Number(result.byteSize),ok=!!(result.ownerVerified&&actualSummary&&checksumMatches&&byteSizeMatches&&summaryMatches),comparisonChecksum=actualSummary?snapshotComparisonChecksum(snapshot):'',localMatches=!!(ok&&local&&typeof local==='object'&&snapshotComparisonChecksum(local)===comparisonChecksum);return {ok,notFound:false,message:ok?'云端快照、校验值、字节数和数据摘要均有效。':'快照结构、身份、校验值、字节数或数据摘要存在不一致。',snapshot,checksum:actualChecksum,comparisonChecksum,byteSize:actualByteSize,summary:actualSummary,localMatches,result}}
function safeError(error){return error&&(error.errMsg||error.message||error.code)||'UNKNOWN_ERROR'}
function blockSandboxLifecycle(){if(!isSandbox())return false;wx.showToast({title:'测试环境不可操作正式备份',icon:'none'});return true}
// 📥 站内消息中心（2026-10-06 需求五）：教练端入口 + 未读红点。
//    ⛔ 正式区没有这套集合 ⇒ `available()` 为假 ⇒ 入口整个藏起来，绝不留下一个点了就报错的按钮。
const inbox=require('../../utils/notification-inbox')
// ⭐ M2 自动刷新补线：接上总线（回前台 / 写命令成功 / 从子页返回时，可见的这个页面会真的重读一次）。
const installAutoRefresh=require('../../utils/auto-refresh').installPage
Page(installAutoRefresh({
  data:{monthTitle:'',classRevenue:0,classSegments:[],classRing:'background:#eee8df',salesRevenue:0,salesSegments:[],salesRing:'background:#eee8df',classCommissionRate:0,salesCommissionRate:0,classCommission:'0.00',salesCommission:'0.00',estimatedCommission:'0.00',giftCount:0,giftRevenue:0,ranking:[],showAllRanking:false,totalSessions:0,totalRevenue:0,monthSessions:0,nextSessions:50,nextRevenue:10000,renewThreshold:10,monthlyGoalSessions:40,saleModal:false,salesDetailModal:false,settingsModal:false,historyModal:false,historyTab:'classes',historyMonth:'',historyLabel:'',historyClass:0,historyClassList:[],historySales:0,historyCommission:'0.00',historySalesCommission:'0.00',historyClassCount:0,historySalesList:[],sale:{name:'月卡',amount:'',date:'',validFrom:'',validTo:'',note:''},salesList:[],reversingSaleId:'',cloudBackupLoading:false,cloudBackupStatus:'',cloudVerifyLoading:false,cloudVerifyResult:null,deleteDataLoading:false,devEntries:releaseFlags.devEntriesVisible(),sandboxEntry:releaseFlags.sandboxEntryVisible(),inboxAvailable:false,inboxUnread:0},
  // 📥 未读条数（教练端：只看**教练自己**这一份消息箱）。⛔ 拿不到就 0，绝不因为附属功能把整页搞崩。
  async loadInboxUnread(){this.setData({inboxAvailable:inbox.available()});if(!inbox.available())return this.setData({inboxUnread:0});this.setData({inboxUnread:await inbox.unread('coach')})},
  openInbox(){inbox.open('coach')},
  // ⭐ M2 自动刷新：进入关键页面是一个正式触发点；下拉刷新是**兜底**。
  onShow(){require('../../utils/auto-refresh').request('pageShow');this.render();this.loadInboxUnread()},onTabItemTap(){this.render()},
  onPullDownRefresh(){this.pullRefresh()},
  // ⭐ 真正读一次云端并重画（自动刷新与下拉刷新共用同一条，不出现两套读法）。
  async cloudRefresh(userInitiated){
    try{const ui=require('../../utils/ui-cloud-command');if(typeof ui.refreshActiveView==='function')await ui.refreshActiveView({userInitiated:!!userInitiated})}catch(error){}
    this.render()
  },
  async pullRefresh(){
    const startedAt=Date.now()
    await this.cloudRefresh(true)
    require('../../utils/auto-refresh').recordSample({reason:'pullDown',startedAt})
    if(wx.stopPullDownRefresh)wx.stopPullDownRefresh()
  },
  render(){
    this.setData({sandboxMode:isSandbox()})
    const db=getDB(),beijingDate=dateParts(todayKey()),salesStart=monthDateKey(beijingDate.year,beijingDate.month,1),salesEnd=addMonths(salesStart,1)
    const allIncomes=db.incomes.filter(r=>r.bookingId&&Number(r.amount)>0),course=allIncomes.filter(r=>r.date>=salesStart&&r.date<salesEnd),gifts=course.filter(r=>r.typeName==='赠送课程'),paid=course.filter(r=>r.typeName!=='赠送课程')
    const allDone=(db.bookings||[]).filter(b=>b.status==='done'),monthDone=allDone.filter(b=>b.date>=salesStart&&b.date<salesEnd)
    const sales=presentSales(db,(db.sales||[]).filter(r=>r.status!=='reversed'&&r.date>=salesStart&&r.date<salesEnd)),c=breakdown(paid),s=breakdown(sales),cnt={}
    monthDone.forEach(booking=>{
      const key=booking.studentId||`deleted:${booking.studentName||booking.id}`
      if(!cnt[key])cnt[key]={studentId:booking.studentId,name:booking.studentName||'已删学员',count:0,cats:{}}
      const item=cnt[key];item.count++
      let category=String(booking.category||booking.typeName||'其他').replace('部训练','').replace('训练','').replace('燃脂','').replace('恢复','')
      if(['胸','背','肩','腿','臀'].includes(category))category+='部'
      item.cats[category]=(item.cats[category]||0)+1
    })
    const ranking=Object.entries(cnt).map(([id,item])=>{const student=item.studentId&&db.students.find(x=>x.id===item.studentId);return {id,name:student?student.name:item.name,count:item.count,detail:Object.entries(item.cats).sort((a,b)=>b[1]-a[1]).map(([name,count])=>`${name} ${count}节`).join(' · '),open:false}}).sort((a,b)=>b.count-a.count)
    const totalSessions=allDone.length,totalRevenue=allIncomes.reduce((n,r)=>n+Number(r.amount),0),cr=Number(db.settings.classCommissionRate)||0,sr=Number(db.settings.salesCommissionRate)||0,giftRevenue=Number(gifts.reduce((n,r)=>n+Number(r.amount||80),0).toFixed(2)),classCommission=c.total*cr/100,salesCommission=s.total*sr/100
    this.setData({monthTitle:`${beijingDate.year}年${beijingDate.month}月`,classRevenue:c.total,classSegments:c.list,classRing:c.ring,salesRevenue:s.total,salesSegments:s.list,salesRing:s.ring,classCommissionRate:cr,salesCommissionRate:sr,classCommission:classCommission.toFixed(2),salesCommission:salesCommission.toFixed(2),estimatedCommission:(classCommission+salesCommission+giftRevenue).toFixed(2),giftCount:gifts.length,giftRevenue,ranking,totalSessions,totalRevenue:Number(totalRevenue.toFixed(2)),monthSessions:monthDone.length,nextSessions:[50,100,500,1000].find(x=>x>totalSessions)||totalSessions||1,nextRevenue:[10000,50000,100000].find(x=>x>totalRevenue)||totalRevenue||1,renewThreshold:db.settings.renewThreshold,monthlyGoalSessions:db.settings.monthlyGoalSessions,salesList:sales.slice().reverse()})
  },
  toggle(e){const i=+e.currentTarget.dataset.i;this.setData({[`ranking[${i}].open`]:!this.data.ranking[i].open})},
  toggleRanking(){this.setData({showAllRanking:!this.data.showAllRanking})},
  openAttendanceHistory(){wx.navigateTo({url:'/pages/attendance-history/attendance-history'})},
  openSalesDetail(){this.setData({salesDetailModal:true})},closeSalesDetail(){this.setData({salesDetailModal:false})},
  openSettings(){this.setData({settingsModal:true})},closeSettings(){this.setData({settingsModal:false})},
  openHistory(){const p=dateParts(todayKey()),currentMonth=monthDateKey(p.year,p.month,1),month=addMonths(currentMonth,-1).slice(0,7);this.setData({historyModal:true,historyTab:'classes',historyMonth:month},()=>this.renderHistory())},closeHistory(){this.setData({historyModal:false})},historyMonth(e){this.setData({historyMonth:e.detail.value.slice(0,7)},()=>this.renderHistory())},switchHistoryTab(e){this.setData({historyTab:e.currentTarget.dataset.tab})},toggleHistoryStudent(e){const i=+e.currentTarget.dataset.i;if(!this.data.historyClassList[i])return;this.setData({[`historyClassList[${i}].open`]:!this.data.historyClassList[i].open})},
  renderHistory(){const db=getDB(),month=this.data.historyMonth,p=month.split('-').map(Number),start=monthDateKey(p[0],p[1],1),end=addMonths(start,1),records=db.incomes.filter(r=>r.bookingId&&r.date>=start&&r.date<end),bookingById=bookingIndex(db.bookings),studentMap={};records.forEach(r=>{const st=db.students.find(s=>s.id===r.studentId),key=r.studentId||r.name||'deleted';if(!studentMap[key])studentMap[key]={id:key,name:st?st.name:(r.studentName||'已删学员'),count:0,amount:0,types:{},incomes:[]};const x=studentMap[key];x.count++;x.amount+=Number(r.amount||0);x.types[r.typeName]=(x.types[r.typeName]||0)+1;x.incomes.push(r)});const classList=Object.values(studentMap).map(x=>({id:x.id,name:x.name,count:x.count,amount:Number(x.amount.toFixed(2)),lessons:lessonListOf(x.incomes,bookingById),typeText:Object.entries(x.types).map(([name,count])=>`${name} ${count} 节`).join('　｜　'),open:false})).sort((a,b)=>b.count-a.count||b.amount-a.amount),salesList=presentSales(db,(db.sales||[]).filter(r=>r.status!=='reversed'&&r.date>=start&&r.date<end).slice().sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:0)).map(sale=>({...sale,...historySaleDatePicker(sale.date)})),historyClass=records.reduce((n,r)=>n+Number(r.amount||0),0),historySales=salesList.reduce((n,r)=>n+Number(r.amount||0),0),gift=records.filter(r=>r.typeName==='赠送课程').reduce((n,r)=>n+Number(r.amount||0),0),paid=historyClass-gift,cr=Number(db.settings.classCommissionRate)||0,sr=Number(db.settings.salesCommissionRate)||0;this.setData({historyLabel:`${p[0]}年${p[1]}月`,historyClass:Number(historyClass.toFixed(2)),historySales:Number(historySales.toFixed(2)),historyCommission:(paid*cr/100+historySales*sr/100+gift).toFixed(2),historySalesCommission:(historySales*sr/100).toFixed(2),historyClassCount:records.length,historyClassList:classList,historySalesList:salesList})},
  historySaleDateColumnChange(e){const index=this.data.historySalesList.findIndex(item=>item.id===e.currentTarget.dataset.id);if(index<0)return;const item=this.data.historySalesList[index],column=+e.detail.column,value=+e.detail.value,dateValue=item.editDateValue.slice(),dateRange=item.editDateRange.map(part=>part.slice());dateValue[column]=value;if(column<2){const dayCount=new Date(Date.UTC(Number(dateRange[0][dateValue[0]]),Number(dateRange[1][dateValue[1]]),0)).getUTCDate(),days=Array.from({length:dayCount},(_,i)=>String(i+1).padStart(2,'0'));dateRange[2]=days;dateValue[2]=Math.min(dateValue[2],days.length-1)}this.setData({[`historySalesList[${index}].editDateRange`]:dateRange,[`historySalesList[${index}].editDateValue`]:dateValue})},
  historySaleDateChange(e){const item=this.data.historySalesList.find(sale=>sale.id===e.currentTarget.dataset.id),value=e.detail.value;if(!item)return;const date=`${item.editDateRange[0][value[0]]}-${item.editDateRange[1][value[1]]}-${item.editDateRange[2][value[2]]}`;this.editSaleDate({currentTarget:{dataset:{id:item.id}},detail:{value:date}})},
  editSaleDate(e){const saleId=e.currentTarget.dataset.id,date=e.detail.value;if(!validDateKey(date))return wx.showToast({title:'请选择有效日期',icon:'none'});const db=getDB(),sale=(db.sales||[]).find(x=>x.id===saleId);if(!sale)return wx.showToast({title:'这笔业绩已不存在',icon:'none'});if(sale.legacyRelationStatus==='orphan')return wx.showToast({title:'历史销售仅可查看',icon:'none'});if(sale.date===date)return wx.showToast({title:'日期未发生变化',icon:'none'});if(mutate.isCloudWritePath())return mutate(null,null,{key:`editSaleDate:${saleId}`,command:sale.source==='course'?'updateCourseSale':'updateManualSale',payload:sale.source==='course'?{saleId,packageId:sale.packageId,date}:{saleId,date},successTitle:'业绩日期已修改',onSuccess:()=>{this.render();if(this.data.historyModal)this.renderHistory()},onRefresh:()=>this.render()});if(sale.source==='course'){const result=updateCourseSale(saleId,{date});if(!result.ok)return wx.showModal({title:'无法修改',content:result.message,showCancel:false,confirmText:'知道了'})}else{sale.date=date;saveDB(db)}this.render();if(this.data.historyModal)this.renderHistory();const [year,month]=date.split('-').map(Number);wx.showToast({title:`已计入${year}年${month}月`,icon:'none'})},
  deleteSale(e){
    const saleId=e.currentTarget.dataset.id,current=(getDB().sales||[]).find(item=>item.id===saleId);if(current&&current.legacyRelationStatus==='orphan')return wx.showToast({title:'历史销售仅可查看',icon:'none'});const plan=saleRemovalPlan(getDB(),saleId)
    if(this.data.reversingSaleId)return
    if(plan.kind==='missing')return wx.showToast({title:'这笔业绩已不存在',icon:'none'})
    if(plan.kind==='blocked')return wx.showModal({title:'无法安全撤销',content:plan.message,showCancel:false,confirmText:'知道了'})
    const reversesCourse=plan.kind==='reverseCourse'||plan.kind==='orphanCourse',extra=reversesCourse?`\n\n撤销后销售业绩失效${plan.pkg?'，对应课时包停用且剩余归零':''}。${plan.bookedCount?`\n${plan.bookedCount}个未完成预约将取消。`:''}\n已完成课程和历史收入不会改变。`:'\n\n本次只删除这笔手动业绩。'
    wx.showModal({title:reversesCourse?'撤销课时包销售':'删除这笔业绩',content:saleConfirmText(plan)+extra,confirmText:reversesCourse?'确认撤销':'确认删除',confirmColor:'#c7563d',success:r=>{
      if(!r.confirm)return
      if(mutate.isCloudWritePath()){
        this.setData({reversingSaleId:saleId})
        return mutate(null,null,{strategy:mutate.STRATEGIES.SILENT,key:`deleteSale:${saleId}`,command:reversesCourse?'reverseCourseSale':'deleteManualSale',payload:reversesCourse?{saleId,...(plan.pkg?{packageId:plan.pkg.id}:{})}:{saleId},successTitle:'',onSuccess:()=>{this.render();if(this.data.historyModal)this.renderHistory()},onRefresh:()=>this.render()}).then(result=>{if(result&&result.ok)wx.showToast({title:reversesCourse?'销售已撤销':'业绩已删除',icon:'none'});else wx.showToast({title:(result&&result.message)||'操作未完成，请稍后重试',icon:'none'});return result}).finally(()=>this.setData({reversingSaleId:''}))
      }
      const result=reverseSale(saleId,plan.kind)
      if(!result.ok)return wx.showToast({title:result.message,icon:'none'})
      this.render()
      if(this.data.historyModal)this.renderHistory()
      wx.showToast({title:reversesCourse?'销售已撤销':'业绩已删除'})
    }})
  },
  setting(e){const k=e.currentTarget.dataset.k,v=e.detail.value,patch={[k]:v};let classCommission=Number(this.data.classCommission),salesCommission=Number(this.data.salesCommission);if(k==='classCommissionRate'){classCommission=this.data.classRevenue*(+v||0)/100;patch.classCommission=classCommission.toFixed(2)}if(k==='salesCommissionRate'){salesCommission=this.data.salesRevenue*(+v||0)/100;patch.salesCommission=salesCommission.toFixed(2)}if(k==='classCommissionRate'||k==='salesCommissionRate')patch.estimatedCommission=(classCommission+salesCommission+Number(this.data.giftRevenue)).toFixed(2);this.setData(patch);if(mutate.isCloudWritePath())return mutate(null,null,{key:`saveSetting:${k}`,command:'saveSettings',payload:{[k]:+v||0},successTitle:'',onRefresh:()=>this.render()});const db=getDB();db.settings[k]=+v||0;saveDB(db)},
  saveSettings(){if(mutate.isCloudWritePath())return mutate(null,null,{key:'saveSettings:main',command:'saveSettings',payload:{renewThreshold:+this.data.renewThreshold||10,monthlyGoalSessions:+this.data.monthlyGoalSessions||40},successTitle:'已保存',onRefresh:()=>this.render()});const db=getDB();db.settings.renewThreshold=+this.data.renewThreshold||10;db.settings.monthlyGoalSessions=+this.data.monthlyGoalSessions||40;saveDB(db);wx.showToast({title:'已保存'})},
  openSale(){const d=dateStr(new Date());this.setData({saleModal:true,sale:{name:'月卡',amount:'',date:d,validFrom:d,validTo:'',note:''}})},closeSale(){this.setData({saleModal:false})},noop(){},saleField(e){this.setData({[`sale.${e.currentTarget.dataset.k}`]:e.detail.value})},
  saveSale(){const f=this.data.sale,amount=Number(f.amount);if(!amount)return wx.showToast({title:'请输入业绩金额',icon:'none'});if(mutate.isCloudWritePath())return mutate(null,null,{key:`createManualSale:${f.date}:${f.name}:${amount}`,command:'createManualSale',payload:{typeName:'其他业绩',name:f.name||'其他业绩',amount:Number(amount.toFixed(2)),date:f.date,validFrom:f.validFrom,validTo:f.validTo,note:f.note},successTitle:'业绩已记录',onSuccess:()=>{this.closeSale();this.render()},onRefresh:()=>this.render()});const db=getDB();db.sales.push({id:uid(),source:'manual',typeName:'其他业绩',name:f.name||'其他业绩',amount:Number(amount.toFixed(2)),date:f.date,validFrom:f.validFrom,validTo:f.validTo,note:f.note});saveDB(db);this.closeSale();this.render();wx.showToast({title:'业绩已记录'})},
  rememberCloudBackupVersion(result){return writeKnownVersion({get:key=>wx.getStorageSync(key),set:(key,value)=>wx.setStorageSync(key,value)},result)},
  backupCoachDBToCloud(){
    if(blockSandboxLifecycle())return
    if(this.data.cloudBackupLoading){
      wx.showToast({title:'云端备份正在进行',icon:'none'})
      return
    }
    try{
      const snapshot=wx.getStorageSync('coachDB')
      if(!snapshot||!Array.isArray(snapshot.students)||!Array.isArray(snapshot.bookings)||!Array.isArray(snapshot.incomes))return wx.showModal({title:'无法备份',content:'本机 coachDB 数据不完整，已停止上传；本地数据没有改变。',showCancel:false,confirmText:'知道了'})
      if(!wx.cloud)return wx.showToast({title:'当前微信不支持云开发',icon:'none'})
      this.setData({cloudBackupLoading:true,cloudBackupStatus:'正在检查云端备份版本…'})
      return readCloudBackup().then(cloudResult=>{
        const notFound=cloudResult&&cloudResult.code==='NOT_FOUND'
        let decision
        if(notFound)decision=decideCloudBackup({cloudExists:false})
        else if(cloudResult&&cloudResult.ok){
          const inspection=inspectCloudBackup(cloudResult,snapshot)
          if(!inspection.ok){this.setData({cloudBackupLoading:false,cloudBackupStatus:'云端备份未通过完整性校验，已停止上传'});return wx.showModal({title:'备份已停止',content:'无法确认当前云端备份完整有效，请先执行“验证云端备份”。',showCancel:false,confirmText:'知道了'})}
          decision=decideCloudBackup({cloudExists:true,cloudVersion:cloudResult.backupVersion,cloudChecksum:inspection.comparisonChecksum,localChecksum:snapshotComparisonChecksum(snapshot),localMetadata:wx.getStorageSync(CLOUD_BACKUP_META_KEY)})
        }else{
          this.setData({cloudBackupLoading:false,cloudBackupStatus:'无法确认云端版本，未执行上传'})
          return wx.showModal({title:'备份已停止',content:(cloudResult&&cloudResult.message)||'云端版本检查失败，请稍后重试。',showCancel:false,confirmText:'知道了'})
        }
        if(!decision.allow){
          this.setData({cloudBackupLoading:false,cloudBackupStatus:'云端备份可能比本机更新，已阻止覆盖'})
          const remoteNewer=decision.reason==='REMOTE_NEWER',noBaseline=decision.reason==='NO_LOCAL_BASELINE'
          if(noBaseline)return this.confirmLocalCloudTakeover(snapshot,cloudResult)
          const content=remoteNewer?'云端备份比本机记录更新，可能来自另一台设备。请先验证或恢复云端备份。':'本机记录的云端版本异常，为避免覆盖数据，请先验证或恢复云端备份。'
          return wx.showModal({title:'已阻止覆盖',content,showCancel:false,confirmText:'知道了'})
        }
        this.setData({cloudBackupLoading:false})
        wx.showModal({title:'确认云端备份',content:'云端版本检查已通过。将当前数据完整备份到你的微信云空间，是否继续？',confirmText:'确认备份',cancelText:'取消',success:r=>{
          if(!r.confirm)return
          this.uploadCoachDBSnapshot(snapshot,decision.expectedBackupVersion)
        },fail:err=>{console.error('[cloud-backup] modal failed',safeError(err));wx.showToast({title:'无法打开确认框，请重试',icon:'none'})}})
      }).catch(error=>{console.error('[cloud-backup] preflight failed',safeError(error));this.setData({cloudBackupLoading:false,cloudBackupStatus:'云端版本检查失败，未执行上传'});wx.showModal({title:'备份已停止',content:'无法检查云端备份版本，本次没有上传。请检查网络后重试。',showCancel:false,confirmText:'知道了'})})
    }catch(error){
      console.error('[cloud-backup] prepare failed',safeError(error))
      this.setData({cloudBackupLoading:false,cloudBackupStatus:'准备云端备份时发生错误，本地数据未改变'})
      wx.showModal({title:'云端备份未开始',content:error&&error.message?error.message:'读取本机备份数据失败，请查看调试日志。',showCancel:false,confirmText:'知道了'})
    }
  },
  confirmLocalCloudTakeover(snapshot,cloudResult){
    const version=Number(cloudResult&&cloudResult.backupVersion),updatedAt=this.formatBackupTime(cloudResult&&cloudResult.updatedAt)
    if(!Number.isInteger(version)||version<1){
      this.setData({cloudBackupStatus:'云端版本异常，已阻止覆盖'})
      return wx.showModal({title:'已阻止覆盖',content:'无法确认当前云端备份版本，请先重新验证云端备份。',showCancel:false,confirmText:'知道了'})
    }
    const firstContent=`云端第 ${version} 版${updatedAt&&updatedAt!=='-'?`\n最后备份：${updatedAt}`:''}\n\n当前本机数据与云端备份不同。如果你确认这台设备的数据是最新的，可以将当前本机数据作为新的云端备份。原云端备份将被更新。`
    wx.showModal({title:'本机数据与云端不同',content:firstContent,confirmText:'继续确认',cancelText:'取消',success:first=>{
      if(!first.confirm)return
      wx.showModal({title:'确认以本机为准？',content:'确认后，将使用当前本机数据更新云端备份。请确保这台设备的数据就是你要保留的版本。',confirmText:'确认更新',cancelText:'取消',success:second=>{
        if(!second.confirm)return
        this.uploadCoachDBSnapshot(snapshot,version)
      },fail:error=>{console.error('[cloud-backup] takeover final confirmation failed',safeError(error));wx.showToast({title:'无法打开确认框，未上传',icon:'none'})}})
    },fail:error=>{console.error('[cloud-backup] takeover confirmation failed',safeError(error));wx.showToast({title:'无法打开确认框，未上传',icon:'none'})}})
  },
  uploadCoachDBSnapshot(snapshot,expectedBackupVersion){
    this.setData({cloudBackupLoading:true,cloudBackupStatus:'正在安全上传完整数据副本…'})
    return uploadSnapshotInChunks({functionName:'backupCoachDB',mode:'backup',snapshot,expectedBackupVersion,onProgress:(done,total)=>this.setData({cloudBackupStatus:`正在分块上传… ${done}/${total}`})}).then(result=>{
      if(!result||!result.ok){
        console.error('[cloud-backup] rejected',result&&result.code||'INVALID_RESULT')
        const conflict=result&&result.code==='VERSION_CONFLICT'
        const differences=result&&result.differences,failedChecks=differences?Object.keys(differences).filter(key=>differences[key]&&!differences[key].matches):[]
        const summaryFields=differences&&differences.summary&&differences.summary.fields||{},summaryDetail=Object.keys(summaryFields).map(key=>`${key} expected ${String(summaryFields[key].expected)} / actual ${String(summaryFields[key].actual)}`).join('；')
        const verifyDetail=summaryDetail?`（summary：${summaryDetail}）`:failedChecks.length?`（不一致：${failedChecks.join('、')}）`:''
        this.setData({cloudBackupLoading:false,cloudBackupStatus:conflict?'云端备份已更新，本次未覆盖':`${(result&&result.message)||'云端备份失败，本地数据未改变'}${verifyDetail}`})
        if(conflict)wx.showModal({title:'已阻止覆盖',content:'云端备份在上传前已被其他设备更新。请先验证或恢复云端备份。',showCancel:false,confirmText:'知道了'})
        return
      }
      const remembered=this.rememberCloudBackupVersion(result),time=String(result.updatedAt||'').replace('T',' ').replace(/\.\d{3}Z$/,' UTC')
      if(!remembered.ok){
        this.setData({cloudBackupLoading:false,cloudBackupStatus:`云端第 ${result.backupVersion} 版已保存，但本机版本记录失败`})
        return wx.showModal({title:'备份已完成',content:'云端备份已经成功，但这台设备未能保存版本记录。再次备份前请先执行“验证云端备份”。',showCancel:false,confirmText:'知道了'})
      }
      this.setData({cloudBackupLoading:false,cloudBackupStatus:`云端备份成功 · 第 ${result.backupVersion} 版${time?' · '+time:''}`})
      wx.showToast({title:'云端备份成功'})
    }).catch(error=>{console.error('[cloud-backup] call failed',safeError(error));this.setData({cloudBackupLoading:false,cloudBackupStatus:`云端备份失败：${error.errMsg||error.message||'请检查网络和云函数'}`})})
  },
  verifyCloudBackup(){
    if(blockSandboxLifecycle())return
    if(this.data.cloudVerifyLoading)return wx.showToast({title:'正在验证云端备份',icon:'none'})
    if(!wx.cloud)return wx.showToast({title:'当前微信不支持云开发',icon:'none'})
    this.setData({cloudVerifyLoading:true,cloudVerifyResult:null})
    return readCloudBackup().then(result=>{
      try{
        if(!result||!result.ok){const notFound=result&&result.code==='NOT_FOUND';this.setData({cloudVerifyLoading:false,cloudVerifyResult:{status:notFound?'没有找到云端备份':'校验失败 / 数据可能损坏',valid:false,version:'-',integrity:notFound?'未找到':'失败',localComparison:'未比较',updatedAt:'-',detail:(result&&result.message)||'云函数没有返回有效结果'}});return}
        const snapshot=result.snapshot,validSnapshot=!!(snapshot&&typeof snapshot==='object'&&!Array.isArray(snapshot)&&Array.isArray(snapshot.students)&&Array.isArray(snapshot.bookings)&&Array.isArray(snapshot.incomes)),snapshotJson=validSnapshot?JSON.stringify(snapshot):'',chunkMeta=validSnapshot&&result.backupFormatVersion===2?migrationMetadata(snapshot):null,actualChecksum=validSnapshot?(chunkMeta?chunkMeta.checksum:sha256(snapshotJson)):'',actualByteSize=validSnapshot?(chunkMeta?chunkMeta.byteSize:utf8ByteLength(snapshotJson)):0,students=validSnapshot?snapshot.students:[],bookings=validSnapshot?snapshot.bookings:[],incomes=validSnapshot?snapshot.incomes:[],sales=validSnapshot&&Array.isArray(snapshot.sales)?snapshot.sales:[],customExercises=validSnapshot&&Array.isArray(snapshot.customExercises)?snapshot.customExercises:[],actualSummary=validSnapshot?{students:students.length,packages:students.reduce((count,student)=>count+(Array.isArray(student.packages)?student.packages.length:0),0),bookings:bookings.length,completedBookings:bookings.filter(booking=>booking.status==='done').length,incomes:incomes.length,sales:sales.length,customExercises:customExercises.length,hasSettings:!!snapshot.settings}:null,summary=result.summary||{},summaryMatches=!!(actualSummary&&Object.keys(actualSummary).every(key=>actualSummary[key]===summary[key])),checksumMatches=result.checksumAlgorithm==='sha256'&&actualChecksum===result.checksum,byteSizeMatches=actualByteSize===Number(result.byteSize),integrity=!!(result.ownerVerified&&validSnapshot&&checksumMatches&&byteSizeMatches&&summaryMatches),local=wx.getStorageSync('coachDB'),localMatches=!!(integrity&&local&&typeof local==='object'&&snapshotComparisonChecksum(local)===snapshotComparisonChecksum(snapshot)),status=!integrity?'校验失败 / 数据可能损坏':localMatches?'完全一致':'云端备份有效，但本地数据之后有变化'
        const remembered=integrity&&localMatches?this.rememberCloudBackupVersion(result):null,metaNote=remembered&&!remembered.ok?' 本机版本记录未能保存。':''
        this.setData({cloudVerifyLoading:false,cloudVerifyResult:{status,valid:integrity,version:result.backupVersion||'-',schemaVersion:result.schemaVersion||'-',integrity:integrity?'通过':'失败',localComparison:integrity?(localMatches?'完全一致':'有差异'):'未比较',updatedAt:this.formatBackupTime(result.updatedAt),byteSize:result.byteSize,detail:integrity?`云端快照、校验值、字节数和数据摘要均有效。${metaNote}`:'快照结构、身份、校验值、字节数或数据摘要存在不一致。'}})
      }catch(error){console.error('[cloud-verify] validation failed',safeError(error));this.setData({cloudVerifyLoading:false,cloudVerifyResult:{status:'校验失败 / 数据可能损坏',valid:false,version:'-',integrity:'失败',localComparison:'未比较',updatedAt:'-',detail:error&&error.message||'验证过程发生异常'}})}
    }).catch(error=>{console.error('[cloud-verify] call failed',safeError(error));this.setData({cloudVerifyLoading:false,cloudVerifyResult:{status:'校验失败 / 数据可能损坏',valid:false,version:'-',integrity:'失败',localComparison:'未比较',updatedAt:'-',detail:error.errMsg||error.message||'只读云函数调用失败'}})})
  },
  restoreFromCloud(){
    if(blockSandboxLifecycle())return
    if(this.data.cloudVerifyLoading)return wx.showToast({title:'正在处理云端备份',icon:'none'})
    if(!wx.cloud)return wx.showToast({title:'当前微信不支持云开发',icon:'none'})
    this.setData({cloudVerifyLoading:true,cloudVerifyResult:null})
    return readCloudBackup().then(result=>{
      let inspection
      try{inspection=inspectCloudBackup(result,wx.getStorageSync('coachDB'))}catch(error){console.error('[cloud-restore] validation failed',safeError(error));this.setData({cloudVerifyLoading:false});return wx.showModal({title:'禁止恢复',content:'云端备份校验过程发生异常，本机数据没有改变。',showCancel:false,confirmText:'知道了'})}
      if(!inspection.ok){this.setData({cloudVerifyLoading:false});return wx.showModal({title:'禁止恢复',content:inspection.notFound?'没有找到当前微信的云端备份。':'云端备份未通过完整性校验，不能恢复。',showCancel:false,confirmText:'知道了'})}
      const summary=inspection.summary,time=this.formatBackupTime(result.updatedAt),size=Number(result.byteSize||0)
      wx.showModal({title:'确认云端恢复',content:`云端第 ${result.backupVersion||'-'} 版 · ${time}\n数据大小 ${size} 字节\n学员 ${summary.students} 人 · 预约 ${summary.bookings} 条\n已完成 ${summary.completedBookings} 条 · 收入 ${summary.incomes} 条\n销售 ${summary.sales} 条\n\n恢复会覆盖当前本机数据。`,confirmText:'继续恢复',cancelText:'取消',success:first=>{
        if(!first.confirm){this.setData({cloudVerifyLoading:false});return}
        let safety
        try{
          const current=wx.getStorageSync('coachDB'),currentJson=JSON.stringify(current),currentSummary=coachSnapshotSummary(current)
          if(!currentSummary)throw new Error('当前本机 coachDB 结构不完整')
          safety={createdAt:new Date().toISOString(),checksum:sha256(currentJson),byteSize:utf8ByteLength(currentJson),snapshot:current}
          wx.setStorageSync('coachDBRestoreSafetyBackup',safety)
          const saved=wx.getStorageSync('coachDBRestoreSafetyBackup'),savedJson=saved&&saved.snapshot&&JSON.stringify(saved.snapshot)
          if(!saved||!savedJson||saved.checksum!==sha256(savedJson)||Number(saved.byteSize)!==utf8ByteLength(savedJson))throw new Error('恢复前安全备份回读校验失败')
        }catch(error){console.error('[cloud-restore] safety backup failed',safeError(error));this.setData({cloudVerifyLoading:false});return wx.showModal({title:'恢复已终止',content:'无法安全保存当前本机数据，尚未覆盖 coachDB。请检查存储空间后重试。',showCancel:false,confirmText:'知道了'})}
        wx.showModal({title:'最后确认',content:'本机安全备份已完成。确定使用云端备份覆盖当前本机数据吗？',confirmText:'确认覆盖',cancelText:'取消',success:second=>{
          if(!second.confirm){this.setData({cloudVerifyLoading:false});return}
          try{
            wx.setStorageSync('coachDB',inspection.snapshot)
            const restored=wx.getStorageSync('coachDB'),restoredJson=restored&&typeof restored==='object'?JSON.stringify(restored):'',restoredChecksum=restoredJson?(result.backupFormatVersion===2?migrationMetadata(restored).checksum:sha256(restoredJson)):''
            if(restoredChecksum!==inspection.checksum)throw new Error('恢复后 checksum 与云端备份不一致')
            const remembered=this.rememberCloudBackupVersion(result),metaNote=remembered.ok?'':' 本机版本记录未能保存，再次备份前请先验证云端备份。'
            this.setData({cloudVerifyLoading:false,cloudVerifyResult:{status:'恢复成功',valid:true,version:result.backupVersion||'-',schemaVersion:result.schemaVersion||'-',integrity:'通过',localComparison:'完全一致',updatedAt:time,byteSize:result.byteSize,detail:`已从当前微信的云端备份恢复，并通过恢复后校验。${metaNote}`}})
            this.render()
            wx.showModal({title:'恢复成功',content:remembered.ok?'云端备份已恢复到本机，并通过完整性校验。':'云端备份已恢复并通过校验，但本机版本记录失败；再次备份前请先验证。',showCancel:false,confirmText:'知道了'})
          }catch(error){console.error('[cloud-restore] verification failed',safeError(error));this.rollbackCloudRestore(safety,error)}
        },fail:error=>{console.error('[cloud-restore] second modal failed',safeError(error));this.setData({cloudVerifyLoading:false});wx.showToast({title:'无法打开确认框',icon:'none'})}})
      },fail:error=>{console.error('[cloud-restore] first modal failed',safeError(error));this.setData({cloudVerifyLoading:false});wx.showToast({title:'无法打开确认框',icon:'none'})}})
    }).catch(error=>{console.error('[cloud-restore] read failed',safeError(error));this.setData({cloudVerifyLoading:false});wx.showModal({title:'恢复未开始',content:'读取云端备份失败，本机数据没有改变。',showCancel:false,confirmText:'知道了'})})
  },
  rollbackCloudRestore(safety,cause){
    try{
      wx.setStorageSync('coachDB',safety.snapshot)
      const rolledBack=wx.getStorageSync('coachDB'),json=rolledBack&&typeof rolledBack==='object'?JSON.stringify(rolledBack):'',ok=!!(json&&sha256(json)===safety.checksum&&utf8ByteLength(json)===Number(safety.byteSize))
      if(!ok)throw new Error('回滚后校验失败')
      this.setData({cloudVerifyLoading:false,cloudVerifyResult:{status:'恢复失败，已自动回滚',valid:false,version:'-',schemaVersion:'-',integrity:'失败',localComparison:'已恢复原本机数据',updatedAt:'-',detail:cause&&cause.message||'恢复后完整性校验失败'}})
      this.render()
      wx.showModal({title:'已安全回滚',content:'云端恢复未通过校验，已自动恢复到操作前的本机数据。',showCancel:false,confirmText:'知道了'})
    }catch(error){console.error('[cloud-restore] rollback failed',safeError(error));this.setData({cloudVerifyLoading:false,cloudVerifyResult:{status:'恢复与回滚均失败',valid:false,version:'-',schemaVersion:'-',integrity:'失败',localComparison:'需要人工处理',updatedAt:'-',detail:'请停止继续操作，并保留 coachDBRestoreSafetyBackup。'}});wx.showModal({title:'需要人工处理',content:'恢复校验失败，自动回滚也未通过校验。请停止操作并保留本机安全备份。',showCancel:false,confirmText:'知道了'})}
  },
  deleteMyAllData(){
    if(blockSandboxLifecycle())return
    if(this.data.deleteDataLoading)return wx.showToast({title:'正在删除个人数据',icon:'none'})
    if(!wx.cloud)return wx.showToast({title:'当前微信不支持云开发',icon:'none'})
    wx.showModal({title:'删除我的全部数据',content:'学员、预约、课时、训练记录、收入与销售、本机备份和云端备份都会被永久删除。',confirmText:'继续删除',cancelText:'取消',confirmColor:'#bf5037',success:first=>{
      if(!first.confirm)return
      wx.showModal({title:'最后确认',content:'删除后无法通过云端恢复。确定永久删除当前微信的全部个人数据吗？',confirmText:'永久删除',cancelText:'取消',confirmColor:'#bf5037',success:second=>{
        if(!second.confirm)return
        this.setData({deleteDataLoading:true})
        wx.cloud.callFunction({name:'deleteMyCoachData',success:res=>{
          const result=res&&res.result
          if(!result||!result.ok||(!result.deleted&&!result.alreadyAbsent)){
            console.error('[delete-my-data] cloud deletion rejected',result&&result.code||'INVALID_RESULT')
            this.setData({deleteDataLoading:false})
            return wx.showModal({title:'删除已停止',content:(result&&result.message)||'无法确认云端备份删除结果，本机数据没有删除。',showCancel:false,confirmText:'知道了'})
          }
          const keys=['coachDB','coachDBBackup','coachDBRestoreSafetyBackup',CLOUD_BACKUP_META_KEY]
          try{
            keys.forEach(key=>wx.removeStorageSync(key))
            const remaining=keys.filter(key=>{const value=wx.getStorageSync(key);return value!==''&&value!==undefined&&value!==null})
            if(remaining.length)throw new Error(`本机数据仍然存在：${remaining.join(',')}`)
          }catch(error){
            console.error('[delete-my-data] local deletion failed',safeError(error))
            this.setData({deleteDataLoading:false})
            return wx.showModal({title:'本机删除未完成',content:'云端备份已处理，但本机数据未能全部删除。请不要继续录入数据，并联系开发者处理。',showCancel:false,confirmText:'知道了'})
          }
          this.setData({deleteDataLoading:false,settingsModal:false,cloudBackupStatus:'',cloudVerifyResult:null})
          this.render()
          wx.showModal({title:'个人数据已删除',content:'本机数据和当前微信的云端备份均已删除。',showCancel:false,confirmText:'知道了'})
        },fail:error=>{
          console.error('[delete-my-data] call failed',safeError(error))
          this.setData({deleteDataLoading:false})
          wx.showModal({title:'删除已停止',content:'云端操作失败，本机数据没有删除。请检查网络后重试。',showCancel:false,confirmText:'知道了'})
        }})
      },fail:error=>{console.error('[delete-my-data] second modal failed',safeError(error))}})
    },fail:error=>{console.error('[delete-my-data] first modal failed',safeError(error))}})
  },
  formatBackupTime(value){if(!value)return '-';const date=new Date(value);if(Number.isNaN(date.getTime()))return String(value);const pad=number=>String(number).padStart(2,'0');return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`},
  exportDB(){if(blockSandboxLifecycle())return;wx.showModal({title:'确认备份？',content:'将复制当前完整数据作为备份，是否继续？',cancelText:'取消',confirmText:'确认备份',success:r=>{if(!r.confirm)return;const created=createBackupEnvelope(getDB());if(!created.ok)return wx.showModal({title:'无法备份',content:created.message||'当前数据结构不完整。',showCancel:false,confirmText:'知道了'});wx.setClipboardData({data:JSON.stringify(created.envelope),success:()=>wx.showToast({title:'备份已复制'}),fail:error=>{console.error('[local-backup] clipboard write failed',safeError(error));wx.showToast({title:'复制备份失败',icon:'none'})}})}})},
  importDB(){
    if(blockSandboxLifecycle())return
    wx.getClipboardData({success:async clip=>{
      const storage={get:key=>wx.getStorageSync(key),set:(key,value)=>wx.setStorageSync(key,value)}
      const confirm=({stage,legacy})=>new Promise((resolve,reject)=>{
        const firstContent=legacy?'检测到旧版备份，无法验证原始 checksum。将按当前内容计算校验值后覆盖本机数据，是否继续？':'备份完整性校验已通过。将使用剪贴板中的备份覆盖当前本机数据，是否继续？'
        wx.showModal({title:stage==='first'?(legacy?'旧版备份警告':'确认恢复备份'):'最后确认',content:stage==='first'?firstContent:'当前本机数据会被替换，恢复前已自动保存安全备份。',cancelText:'取消',confirmText:stage==='first'?'继续恢复':'确认覆盖',success:r=>resolve(!!r.confirm),fail:reject})
      })
      const result=await restoreClipboardBackup({text:clip.data,storage,confirm})
      if(result.ok){this.render();return wx.showModal({title:'恢复成功',content:result.legacy?'旧版备份已恢复；本次写入和回读校验通过，但原始备份不具备 checksum 完整性证明。':'备份已恢复，并通过 checksum 与 byteSize 校验。',showCancel:false,confirmText:'知道了'})}
      if(result.cancelled)return
      const serious=result.code==='ROLLBACK_FAILED',rolledBack=result.code==='RESTORE_FAILED_ROLLED_BACK'
      wx.showModal({title:serious?'需要人工处理':rolledBack?'已安全回滚':'恢复已停止',content:result.message||'备份文件无效或不完整，本机数据没有改变。',showCancel:false,confirmText:'知道了'})
    },fail:error=>{console.error('[local-backup] clipboard read failed',safeError(error));wx.showToast({title:'无法读取剪贴板',icon:'none'})}})
  },
  restoreLocal(){
    if(blockSandboxLifecycle())return
    const backup=wx.getStorageSync('coachDBBackup')
    if(!backup)return wx.showToast({title:'暂无本机历史备份',icon:'none'})
    let text
    try{text=JSON.stringify(backup)}catch(error){console.error('[local-restore] backup serialization failed',safeError(error));return wx.showModal({title:'恢复已停止',content:'本机历史备份无法读取或结构不完整。',showCancel:false,confirmText:'知道了'})}
    const storage={get:key=>wx.getStorageSync(key),set:(key,value)=>wx.setStorageSync(key,value)}
    const confirm=({stage})=>new Promise((resolve,reject)=>{
      wx.showModal({title:stage==='first'?'确认恢复本机数据？':'最后确认',content:stage==='first'?'将使用上一次本机保存的数据覆盖当前数据，是否继续？':'当前本机数据会被替换，恢复前已自动保存并校验安全备份。',cancelText:'取消',confirmText:stage==='first'?'继续恢复':'确认覆盖',success:r=>resolve(!!r.confirm),fail:reject})
    })
    restoreClipboardBackup({text,storage,confirm}).then(result=>{
      if(result.ok){this.render();return wx.showModal({title:'恢复成功',content:'上一次本机数据已恢复，并通过写入与回读校验。',showCancel:false,confirmText:'知道了'})}
      if(result.cancelled)return
      const serious=result.code==='ROLLBACK_FAILED',rolledBack=result.code==='RESTORE_FAILED_ROLLED_BACK'
      wx.showModal({title:serious?'需要人工处理':rolledBack?'已安全回滚':'恢复已停止',content:result.message||'本机历史备份无效或不完整，当前数据没有改变。',showCancel:false,confirmText:'知道了'})
    }).catch(error=>{console.error('[local-restore] unexpected failure',safeError(error));wx.showModal({title:'恢复已停止',content:'恢复过程中发生异常，当前数据没有改变。',showCancel:false,confirmText:'知道了'})})
  }
}, { refresh() { return this.cloudRefresh(false) } }))
