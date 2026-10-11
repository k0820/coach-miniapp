const { getDB, dateStr } = require('../../utils/data-runtime')

function monthRange(offset){
  const now=new Date(),start=new Date(now.getFullYear(),now.getMonth()+offset,1),end=offset===0?now:new Date(now.getFullYear(),now.getMonth()+offset+1,0)
  return {start:dateStr(start),end:dateStr(end)}
}

Page({
  data:{startDate:'',endDate:'',total:0,studentCount:0,days:0,list:[]},
  onLoad(){const r=monthRange(-1);this.setData({startDate:r.start,endDate:r.end},()=>this.render())},
  startDate(e){this.setData({startDate:e.detail.value},()=>this.render())},
  endDate(e){this.setData({endDate:e.detail.value},()=>this.render())},
  previousMonth(){const r=monthRange(-1);this.setData({startDate:r.start,endDate:r.end},()=>this.render())},
  currentMonth(){const r=monthRange(0);this.setData({startDate:r.start,endDate:r.end},()=>this.render())},
  render(){
    const {startDate,endDate}=this.data
    if(!startDate||!endDate||startDate>endDate)return wx.showToast({title:'结束日期不能早于开始日期',icon:'none'})
    const db=getDB(),records=(db.bookings||[]).filter(b=>b.status==='done'&&b.date>=startDate&&b.date<=endDate),map={},incomeByBooking={}
    ;(db.incomes||[]).forEach(income=>{if(income.bookingId)incomeByBooking[income.bookingId]=(incomeByBooking[income.bookingId]||0)+Number(income.amount||0)})
    records.forEach(booking=>{const st=db.students.find(s=>s.id===booking.studentId),key=booking.studentId||`deleted:${booking.studentName||booking.id}`;if(!map[key])map[key]={id:key,name:st?st.name:(booking.studentName||'已删学员'),count:0,amount:0,types:{}};const x=map[key];x.count++;x.amount+=incomeByBooking[booking.id]||0;const type=booking.category||booking.typeName||'其他';x.types[type]=(x.types[type]||0)+1})
    const list=Object.values(map).map(x=>({...x,amount:Number(x.amount.toFixed(2)),detail:Object.entries(x.types).sort((a,b)=>b[1]-a[1]).map(([k,n])=>`${k} ${n} 节`).join(' · ')})).sort((a,b)=>b.count-a.count||b.amount-a.amount),days=Math.floor((new Date(endDate)-new Date(startDate))/86400000)+1
    this.setData({list,total:records.length,studentCount:list.length,days})
  }
})
