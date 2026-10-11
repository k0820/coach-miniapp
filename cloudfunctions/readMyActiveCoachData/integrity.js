const crypto = require('crypto')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const orderOf = row => Number.isFinite(Number(row.sourceOrder)) ? Number(row.sourceOrder) : Number.isFinite(Number(row.sortIndex)) ? Number(row.sortIndex) : Number.MAX_SAFE_INTEGER
const studentOrderOf = row => Number.isFinite(Number(row.studentSourceOrder)) ? Number(row.studentSourceOrder) : Number.isFinite(Number(row.studentSortIndex)) ? Number(row.studentSortIndex) : Number.MAX_SAFE_INTEGER

function reconstruct(groups) {
  const people = groups.students.concat(groups.student_tombstones).slice().sort((a, b) => orderOf(a) - orderOf(b)).map(row => ({ ...row.data, packages: [] }))
  const byId = new Map(people.map(student => [student.id, student]))
  groups.packages.slice().sort((a, b) => studentOrderOf(a) - studentOrderOf(b) || orderOf(a) - orderOf(b)).forEach(row => {
    const student = byId.get(row.studentId)
    if (!student) throw Object.assign(new Error(`package ${row.packageId || '-'} 缺少学员或墓碑。`), { code: 'ACTIVE_RELATION_INVALID' })
    student.packages.push(row.data)
  })
  const ordered = name => groups[name].slice().sort((a, b) => orderOf(a) - orderOf(b)).map(row => row.data)
  const settings = groups.settings[0] || { data: {}, rootExtras: {} }
  return { ...(settings.rootExtras || {}), students: people, bookings: ordered('bookings'), incomes: ordered('incomes'), sales: ordered('sales'), settings: settings.data || {}, customExercises: ordered('customExercises') }
}

function fingerprint(snapshot) {
  const json = canonical(snapshot), packages = snapshot.students.flatMap(student => student.packages || [])
  const incomeAmount = Number(snapshot.incomes.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2))
  const salesAmount = Number(snapshot.sales.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2))
  return {
    checksum: crypto.createHash('sha256').update(json).digest('hex'), byteSize: Buffer.byteLength(json, 'utf8'),
    summary: { students: snapshot.students.filter(item => item.status !== 'deleted').length, deletedStudents: snapshot.students.filter(item => item.status === 'deleted').length, packages: packages.length, bookings: snapshot.bookings.length, completedBookings: snapshot.bookings.filter(item => item.status === 'done').length, incomes: snapshot.incomes.length, sales: snapshot.sales.length, customExercises: snapshot.customExercises.length, incomeAmount, salesAmount },
    counts: { students: snapshot.students.length, packages: packages.length, bookings: snapshot.bookings.length, incomes: snapshot.incomes.length, sales: snapshot.sales.length, customExercises: snapshot.customExercises.length },
    amounts: { incomes: incomeAmount, sales: salesAmount }
  }
}

function classifyCompletionReceipts(receipts = []) {
  const complete = receipts.find(row => row.command === 'completeBooking' && row.status === 'succeeded')
  const content = receipts.find(row => row.command === 'updateBookingContent' && row.status === 'succeeded')
  return complete
    ? 'B_COMMAND_SUCCEEDED_REFRESH_FAILED'
    : content
      ? 'C_CONTENT_SAVED_NOT_COMPLETED'
      : 'A_COMMAND_NOT_SUCCEEDED'
}

module.exports = { reconstruct, fingerprint, orderOf, studentOrderOf, classifyCompletionReceipts }
