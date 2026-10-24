'use strict'

const MEMBER_OPENERS = [
  '这一段坚持得很踏实。', '最近的训练节奏越来越清楚了。', '每一次完成都在给下一次积累底气。', '能持续回来训练，本身就很值得肯定。', '这个月的每一次训练都没有白费。',
  '训练正在慢慢变成你的生活节奏。', '看到这些记录，就能看到你的认真。', '稳定出现，比偶尔拼尽全力更珍贵。', '这段时间的投入已经留下了清楚的痕迹。', '把训练一节一节完成，就是很好的进步。'
]
const MEMBER_ENDINGS = [
  '继续照顾好休息和恢复，下一次会更从容。', '保持现在的节奏，身体会记住这份认真。', '不用着急追赶，稳定地走下去就很好。', '训练之外也记得好好吃饭、好好睡觉。', '给自己一点耐心，变化往往来自这些重复的小事。',
  '如果身体有疲劳感，适当恢复也是训练的一部分。', '下一节课继续从今天的基础上往前走。', '愿你每次离开训练场时，都比来时更有力量。', '保持动作质量，比单纯追求数量更重要。', '今天完成得很好，也给自己留一点放松时间。'
]
const COACH_OPENERS = [
  '这个月的每一节课都记录着你的投入。', '课程一节一节完成，背后都是认真准备。', '会员的稳定训练，也来自教练持续的陪伴。', '这个月的课表很有分量。', '忙碌的数据背后，是一节节真实的服务。',
  '你把很多人的训练计划稳稳接住了。', '课程节奏正在变得越来越清晰。', '这些完课记录，是本月最直接的工作痕迹。', '会员愿意持续回来，是对陪伴最真实的回应。', '这个月又积累了一批扎实的课程记录。'
]
const COACH_ENDINGS = [
  '辛苦了，也记得给自己安排恢复。', '照顾好会员的同时，也别忘了照顾自己的身体。', '稳定的服务比一时忙满更有价值。', '忙的时候稳住节奏，空一点的时候安心休息。', '愿你的认真被会员感受到，也被自己看见。',
  '课程很多值得高兴，身体的恢复同样重要。', '继续保持专业，也给生活留一点空间。', '你已经做了很多，今天可以对自己说一句辛苦了。', '把节奏保持住，比单纯把日程塞满更重要。', '下一阶段继续稳稳往前走，不必把自己逼得太紧。'
]

function hash(text) {
  let value = 0
  String(text || '').split('').forEach(char => { value = ((value * 31) + char.charCodeAt(0)) >>> 0 })
  return value
}
function pair(openers, endings, seed) {
  const value = hash(seed)
  return `${openers[value % openers.length]}${endings[Math.floor(value / openers.length) % endings.length]}`
}
function careLibrary() {
  const member = [], coach = []
  MEMBER_OPENERS.forEach(open => MEMBER_ENDINGS.forEach(end => member.push(open + end)))
  COACH_OPENERS.forEach(open => COACH_ENDINGS.forEach(end => coach.push(open + end)))
  return { member, coach, all: member.concat(coach) }
}
function monthKey(value) { return /^\d{4}-\d{2}/.test(String(value || '')) ? String(value).slice(0, 7) : '' }
function dateLabel(value) { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '')); return match ? `${Number(match[2])}月${Number(match[3])}日` : String(value || '') }
function timeLabel(row) { return `${String(Number(row && row.hour || 0)).padStart(2, '0')}:${String(Number(row && row.minute || 0)).padStart(2, '0')}` }
function groupName(item) {
  const group = String(item && item.group || '').trim()
  if (group) return group.replace(/训练$/, '')
  const name = String(item && item.name || '')
  const rules = [['臀', '臀腿'], ['腿', '臀腿'], ['髋', '臀腿'], ['胸', '胸部'], ['背', '背部'], ['肩', '肩部'], ['臂', '手臂'], ['核心', '核心'], ['腹', '核心'], ['拉伸', '拉伸恢复']]
  return (rules.find(rule => name.includes(rule[0])) || ['', '综合'])[1]
}
function dominantOf(rows) {
  const counts = {}
  ;(rows || []).forEach(row => (row.items || []).forEach(item => { const key = groupName(item); counts[key] = (counts[key] || 0) + 1 }))
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return ranked.length ? { name: ranked[0][0], count: ranked[0][1] } : { name: '', count: 0 }
}
function memberMonthSummary(rows, selectedMonth) {
  const month = String(selectedMonth || '')
  const records = (rows || []).filter(row => monthKey(row.date) === month).sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.hour) - Number(b.hour) || Number(a.minute) - Number(b.minute))
  const dominant = dominantOf(records)
  const dates = records.map(row => `${dateLabel(row.date)} ${timeLabel(row)}`)
  const prefix = records.length ? `${Number(month.slice(5))}月完成了${records.length}次训练${dominant.name ? `，${dominant.name}内容出现得最多` : ''}。` : `${Number(month.slice(5)) || ''}月还没有完成训练。`
  return { month, count: records.length, records, dominantGroup: dominant.name, dates, datesText: dates.join('、'), careText: prefix + pair(MEMBER_OPENERS, MEMBER_ENDINGS, `${month}:${records.length}:${dominant.name}`) }
}
function completionCare(items, category, seed) {
  const dominant = dominantOf([{ items: Array.isArray(items) ? items : [] }])
  const focus = dominant.name || String(category || '本节')
  return `今天的${focus}训练已经认真完成。${pair(MEMBER_OPENERS, MEMBER_ENDINGS, `${seed || ''}:${focus}:${(items || []).length}`)}`
}
function coachMonthSummary(db, selectedMonth) {
  const month = String(selectedMonth || '')
  const rows = (db && db.bookings || []).filter(row => row.status === 'done' && monthKey(row.date) === month)
  const students = db && db.students || []
  const members = {}, days = {}
  rows.forEach(row => {
    const student = students.find(item => item.id === row.studentId)
    const name = String(student && student.name || row.studentName || '已删会员')
    members[name] = (members[name] || 0) + 1
    days[row.date] = (days[row.date] || 0) + 1
  })
  const memberRank = Object.entries(members).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const dayRank = Object.entries(days).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const quietRank = Object.entries(days).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
  const topMember = memberRank[0] || ['', 0], busy = dayRank[0] || ['', 0], quiet = quietRank[0] || ['', 0]
  const facts = rows.length
    ? `本月完成${rows.length}节课。${topMember[0]}训练${topMember[1]}次；${dateLabel(busy[0])}最忙（${busy[1]}节），${dateLabel(quiet[0])}相对轻松（${quiet[1]}节）。`
    : '本月还没有完成课程，可以从容安排接下来的节奏。'
  return { month, count: rows.length, topMember: topMember[0], topMemberCount: topMember[1], busiestDate: busy[0], busiestLabel: dateLabel(busy[0]), busiestCount: busy[1], quietestDate: quiet[0], quietestLabel: dateLabel(quiet[0]), quietestCount: quiet[1], careText: facts + pair(COACH_OPENERS, COACH_ENDINGS, `${month}:${rows.length}:${topMember[0]}:${busy[0]}`) }
}
function chartModel(records) {
  const list = Array.isArray(records) ? records : [], width = Math.max(560, 60 + Math.max(0, list.length - 1) * 110), height = 172
  const scores = list.map(row => Math.max(1, (row.items || []).length + (row.items || []).reduce((sum, item) => sum + Number(item.sets || 0) / 4 + Number(item.minutes || 0) / 15, 0)))
  const min = scores.length ? Math.min(...scores) : 0, max = scores.length ? Math.max(...scores) : 1
  const points = list.map((row, index) => {
    const x = 30 + index * 110, ratio = max === min ? .5 : (scores[index] - min) / (max - min), y = Math.round(138 - ratio * 92)
    return { ...row, x, y, pointStyle: `left:${x - 10}rpx;top:${y - 10}rpx`, labelStyle: `left:${x - 47}rpx`, shortDate: dateLabel(row.date).replace('月', '/').replace('日', ''), fullTime: timeLabel(row) }
  })
  const lines = points.slice(1).map((point, index) => { const previous = points[index], dx = point.x - previous.x, dy = point.y - previous.y, length = Math.sqrt(dx * dx + dy * dy), angle = Math.atan2(dy, dx) * 180 / Math.PI; return { style: `left:${previous.x}rpx;top:${previous.y}rpx;width:${length}rpx;transform:rotate(${angle}deg)` } })
  return { width, height, points, lines }
}

module.exports = { careLibrary, memberMonthSummary, coachMonthSummary, completionCare, chartModel, dominantOf }
