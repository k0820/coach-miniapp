const { getDB, saveDB } = require('./db')

function requireId(record, label) {
  if (!record || typeof record.id !== 'string' || !record.id) {
    throw new Error(`${label} 缺少有效 id`)
  }
}

function upsert(list, record, label) {
  requireId(record, label)
  const index = list.findIndex(item => item.id === record.id)
  if (index >= 0) list[index] = record
  else list.push(record)
  return record
}

// Phase 6.1 local adapter. Existing pages continue importing utils/db directly;
// these methods are the future stable boundary for switching storage backends.
function getSnapshot() { return getDB() }
function saveSnapshot(snapshot) { return saveDB(snapshot) }

function getStudents() { return getDB().students }
function saveStudent(student) {
  const db = getDB()
  upsert(db.students, student, 'student')
  saveDB(db)
  return student
}

function getPackages(studentId) {
  const student = getDB().students.find(item => item.id === studentId)
  return student ? (student.packages || []) : []
}
function savePackage(studentId, pkg) {
  const db = getDB()
  const student = db.students.find(item => item.id === studentId)
  if (!student) throw new Error('student 不存在')
  student.packages = Array.isArray(student.packages) ? student.packages : []
  upsert(student.packages, pkg, 'package')
  saveDB(db)
  return pkg
}

function getBookings() { return getDB().bookings }
function saveBooking(booking) {
  const db = getDB()
  upsert(db.bookings, booking, 'booking')
  saveDB(db)
  return booking
}

function getIncomes() { return getDB().incomes }
function saveIncome(income) {
  const db = getDB()
  upsert(db.incomes, income, 'income')
  saveDB(db)
  return income
}

function getSales() { return getDB().sales }
function saveSale(sale) {
  const db = getDB()
  upsert(db.sales, sale, 'sale')
  saveDB(db)
  return sale
}

function getSettings() { return getDB().settings }
function saveSettings(settings) {
  const db = getDB()
  db.settings = { ...db.settings, ...settings }
  saveDB(db)
  return db.settings
}

function getCustomExercises() { return getDB().customExercises || [] }
function saveCustomExercises(customExercises) {
  if (!Array.isArray(customExercises)) throw new Error('customExercises 必须是数组')
  const db = getDB()
  db.customExercises = customExercises
  saveDB(db)
  return customExercises
}

module.exports = {
  getSnapshot,
  saveSnapshot,
  getStudents,
  saveStudent,
  getPackages,
  savePackage,
  getBookings,
  saveBooking,
  getIncomes,
  saveIncome,
  getSales,
  saveSale,
  getSettings,
  saveSettings,
  getCustomExercises,
  saveCustomExercises
}
