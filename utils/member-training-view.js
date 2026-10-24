'use strict'

function pad(value) { return String(Number(value || 0)).padStart(2, '0') }

function dateValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN
}

function dateLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  return match ? `${Number(match[2])}月${Number(match[3])}日` : String(value || '')
}

function normalize(row) {
  const source = row || {}
  const items = Array.isArray(source.items) ? source.items : []
  const coach = source.coach || {}
  return {
    ...source,
    items,
    coachName: String(coach.displayName || source.coachName || '教练'),
    typeLabel: String(source.category || source.typeName || '训练课程'),
    dateLabel: dateLabel(source.date),
    timeLabel: `${pad(source.hour)}:${pad(source.minute)}`,
    actionNames: items.map(item => String(item && item.name || '')).filter(Boolean).join(' / ')
  }
}

function rowsOf(data) {
  return (Array.isArray(data && data.recentTraining) ? data.recentTraining : [])
    .map(normalize)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.hour) - Number(a.hour) || Number(b.minute) - Number(a.minute))
}

function recentSummary(rows, now = Date.now()) {
  const list = (Array.isArray(rows) ? rows : []).map(normalize)
  const today = new Date(now)
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  const start = todayUtc - 29 * 24 * 60 * 60 * 1000
  const count30 = list.filter(row => {
    const value = dateValue(row.date)
    return Number.isFinite(value) && value >= start && value <= todayUtc
  }).length
  const latest = list[0] || null
  return {
    count30,
    hasTraining: !!latest,
    latestText: latest ? `${latest.dateLabel} · ${latest.typeLabel}` : '完成第一节课后，这里会留下训练内容',
    preview: list.slice(0, 3)
  }
}

module.exports = { dateLabel, normalize, rowsOf, recentSummary }
