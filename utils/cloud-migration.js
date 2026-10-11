const { sha256, utf8ByteLength } = require('./sha256')

const MIGRATION_VERSION = 1

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const result = {}
    Object.keys(value).sort().forEach(key => { result[key] = canonicalize(value[key]) })
    return result
  }
  return value
}

function migrationMetadata(snapshot) {
  const canonicalJson = JSON.stringify(canonicalize(snapshot))
  const students = snapshot.students || []
  const bookings = snapshot.bookings || []
  const incomes = snapshot.incomes || []
  const sales = snapshot.sales || []
  const customExercises = snapshot.customExercises || []
  return {
    checksum: sha256(canonicalJson),
    byteSize: utf8ByteLength(canonicalJson),
    summary: {
      students: students.length,
      packages: students.reduce((count, student) => count + (student.packages || []).length, 0),
      bookings: bookings.length,
      completedBookings: bookings.filter(booking => booking.status === 'done').length,
      incomes: incomes.length,
      sales: sales.length,
      customExercises: customExercises.length,
      hasSettings: !!snapshot.settings,
      incomeAmount: Number(incomes.reduce((total, income) => total + Number(income.amount || 0), 0).toFixed(2)),
      salesAmount: Number(sales.reduce((total, sale) => total + Number(sale.amount || 0), 0).toFixed(2))
    }
  }
}

module.exports = { MIGRATION_VERSION, canonicalize, migrationMetadata }
