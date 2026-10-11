function currentStudent(student) { return student && student.status !== 'deleted' }

function deleteStudentAligned(db, studentId, now = Date.now()) {
  const student = (db.students || []).find(item => item.id === studentId && currentStudent(item))
  if (!student) return { ok: false, code: 'STUDENT_NOT_FOUND', message: '学员已不存在。' }
  const name = student.name
  ;(db.bookings || []).forEach(booking => { if (booking.studentId === studentId && booking.status === 'done' && name && !booking.studentName) booking.studentName = name })
  ;(db.incomes || []).forEach(income => { if (income.studentId === studentId && income.bookingId && name && !income.studentName) income.studentName = name })
  ;(student.packages || []).forEach(pkg => { pkg.status = 'reversed'; pkg.remaining = 0; pkg.reversedAt = now })
  ;(db.sales || []).forEach(sale => { if (sale.source === 'course' && sale.studentId === studentId) { sale.status = 'reversed'; sale.reversedAt = now } })
  db.bookings = (db.bookings || []).filter(booking => booking.studentId !== studentId || booking.status === 'done')
  student.status = 'deleted'; student.deletedAt = now
  return { ok: true, studentId }
}

function validateBookingCreation(db, studentId, packageId) {
  const student = (db.students || []).find(item => item.id === studentId && currentStudent(item))
  if (!student) return { ok: false, code: 'STUDENT_NOT_FOUND', message: '学员已不存在。' }
  const pkg = (student.packages || []).find(item => item.id === packageId)
  if (!pkg) return { ok: false, code: 'PACKAGE_NOT_FOUND', message: '所选课时包已不存在，请重新选择。' }
  if (pkg.status === 'reversed') return { ok: false, code: 'PACKAGE_UNAVAILABLE', message: '所选课时包已撤销，请重新选择。' }
  const remaining = Number(pkg.remaining)
  if (!Number.isFinite(remaining) || remaining <= 0) return { ok: false, code: 'PACKAGE_NO_REMAINING', message: '这个课时包已经没有剩余课时了。请先给会员续费或增加课时，再录入这节课（事后补录也一样不能透支）。' }
  return { ok: true, student, pkg }
}

function rescheduleBookingAligned(db, bookingId, moment, summaryBuilder) {
  const booking = (db.bookings || []).find(item => item.id === bookingId)
  if (!booking) return { ok: false, code: 'BOOKING_NOT_FOUND', message: '课程已不存在。' }
  const incomes = (db.incomes || []).filter(item => item.bookingId === bookingId)
  if (booking.status === 'done' && incomes.length !== 1) return { ok: false, code: 'INCOME_RELATION_AMBIGUOUS', message: incomes.length ? '本节课程关联了多条收入记录，无法安全改期。' : '本节课程缺少对应收入记录，无法安全改期。' }
  booking.date = moment.date; booking.hour = moment.hour; booking.minute = moment.minute
  if (booking.status === 'done') {
    incomes[0].date = booking.date; incomes[0].time = `${String(booking.hour).padStart(2, '0')}:${String(booking.minute || 0).padStart(2, '0')}`
    if (summaryBuilder) booking.summary = summaryBuilder(booking)
  }
  return { ok: true, booking, income: incomes[0] || null }
}

function deleteCompletedBookingAligned(db, bookingId) {
  const booking = (db.bookings || []).find(item => item.id === bookingId)
  if (!booking || booking.status !== 'done') return { ok: false, code: 'BOOKING_NOT_DONE', message: '本节已完成课程不存在。' }
  const incomes = (db.incomes || []).filter(item => item.bookingId === bookingId)
  if (incomes.length !== 1) return { ok: false, code: 'INCOME_RELATION_AMBIGUOUS', message: incomes.length ? '本节课程关联了多条收入记录，无法安全删除。' : '本节课程缺少对应收入记录，无法安全删除。' }
  const student = (db.students || []).find(item => item.id === booking.studentId), pkg = student && (student.packages || []).find(item => item.id === booking.packageId)
  let refund = 'missing-package-no-refund'
  if (pkg) {
    const used = Number(pkg.used), remaining = Number(pkg.remaining)
    if (!Number.isFinite(used) || used <= 0 || !Number.isFinite(remaining) || remaining < 0) return { ok: false, code: 'PACKAGE_USAGE_INVALID', message: '原课时包课时数据异常，无法安全删除。' }
    pkg.used = used - 1
    if (pkg.status === 'reversed') { pkg.remaining = 0; refund = 'reversed-package-no-refund' } else { pkg.remaining = remaining + 1; refund = 'active-package-refunded' }
  }
  db.incomes = db.incomes.filter(item => item.id !== incomes[0].id)
  db.bookings = db.bookings.filter(item => item.id !== bookingId)
  return { ok: true, bookingId, incomeId: incomes[0].id, refund }
}

module.exports = { currentStudent, deleteStudentAligned, validateBookingCreation, rescheduleBookingAligned, deleteCompletedBookingAligned }
