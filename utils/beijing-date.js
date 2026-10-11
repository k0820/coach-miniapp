const DAY_MS = 24 * 60 * 60 * 1000
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const pad = n => String(n).padStart(2, '0')

function partsFromMs(ms) {
  const d = new Date(ms)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() }
}

function parseDateKey(key) {
  const [year, month, day] = String(key).split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function formatDateMs(ms) {
  const p = partsFromMs(ms)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

function beijingParts(timestamp = Date.now()) {
  return partsFromMs(timestamp + BEIJING_OFFSET_MS)
}

function todayKey(timestamp = Date.now()) {
  const p = beijingParts(timestamp)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

function currentHour(timestamp = Date.now()) {
  return new Date(timestamp + BEIJING_OFFSET_MS).getUTCHours()
}

function dateParts(key) {
  return partsFromMs(parseDateKey(key))
}

function addDays(key, amount) {
  return formatDateMs(parseDateKey(key) + amount * DAY_MS)
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function addMonths(key, amount) {
  const p = dateParts(key)
  const target = new Date(Date.UTC(p.year, p.month - 1 + amount, 1))
  const year = target.getUTCFullYear(), month = target.getUTCMonth() + 1
  return formatDateMs(Date.UTC(year, month - 1, Math.min(p.day, daysInMonth(year, month))))
}

function startOfWeek(key, offset = 0) {
  const p = dateParts(key), back = p.weekday === 0 ? 6 : p.weekday - 1
  return addDays(key, -back + offset * 7)
}

function diffWeeks(fromMonday, toMonday) {
  return Math.round((parseDateKey(toMonday) - parseDateKey(fromMonday)) / (DAY_MS * 7))
}

function monthDateKey(year, month, day) {
  return formatDateMs(Date.UTC(year, month - 1, day))
}

module.exports = { DAY_MS, todayKey, currentHour, dateParts, addDays, addMonths, startOfWeek, diffWeeks, daysInMonth, monthDateKey }
