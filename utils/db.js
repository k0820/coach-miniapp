const KEY = 'coachDB'
const pad = n => String(n).padStart(2, '0')
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const timeStr = b => `${pad(b.hour)}:${pad(b.minute || 0)}`
const emptyDB = () => ({ students: [], bookings: [], incomes: [], sales: [], settings: { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 0, salesCommissionRate: 0 } })
function getDB() {
  const stored = wx.getStorageSync(KEY)
  if (!stored || !Array.isArray(stored.students)) return emptyDB()
  const db = JSON.parse(JSON.stringify(stored))
  db.settings=db.settings||{renewThreshold:10,monthlyGoalSessions:40,commissionRate:0}
  if(db.settings.classCommissionRate==null)db.settings.classCommissionRate=0
  if(db.settings.salesCommissionRate==null)db.settings.salesCommissionRate=Number(db.settings.commissionRate)||0
  db.sales=Array.isArray(db.sales)?db.sales:[]
  db.customExercises=Array.isArray(db.customExercises)?db.customExercises:[]
  const rename = n => n === '力量训练' ? '常规训练' : n === '体能训练' ? '拳击训练' : n
  db.students.forEach(s => (s.packages || []).forEach(p => {
    p.type = rename(p.type)
    if(!p.id)p.id=uid()
    if(p.remaining===undefined)p.remaining=Math.max(0,Number(p.total||0)-Number(p.used||0))
    if(!p.status)p.status='active'
  }))
  db.students.forEach(s => (s.packages || []).forEach(p => {
    if(p.saleId)return
    const matches=db.sales.filter(sale=>sale.source==='course'&&sale.studentId===s.id&&sale.packageId===p.id)
    if(matches.length===1)p.saleId=matches[0].id
  }))
  db.bookings.forEach(b => { b.typeName = rename(b.typeName) })
  db.incomes.forEach(r => { r.typeName = rename(r.typeName) })
  return db
}
function saveDB(db) { const current=wx.getStorageSync(KEY);if(current&&Array.isArray(current.students))wx.setStorageSync('coachDBBackup',current);wx.setStorageSync(KEY, db); return db }
function typeOf(name) { const map={常规训练:['#3b82f6','🔵'],拉伸恢复:['#22a06b','🟢'],普拉提:['#eab308','🟡'],拳击训练:['#f97316','🟠'],赠送课程:['#a855f7','🟣']},v=map[name]||map['常规训练'];return {name:name||'常规训练',color:v[0],emoji:v[1]} }
function monday(offset = 0) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + (d.getDay() === 0 ? -6 : 1 - d.getDay()) + offset * 7); return d }
function monthStart() { const d = new Date(); return dateStr(new Date(d.getFullYear(), d.getMonth(), 1)) }
module.exports = { KEY, pad, uid, dateStr, timeStr, emptyDB, getDB, saveDB, typeOf, monday, monthStart }
