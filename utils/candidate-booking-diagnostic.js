function clone(value) { return JSON.parse(JSON.stringify(value)) }
function array(value) { return Array.isArray(value) ? value : [] }

function analyzeHistoricalBookings(input) {
  const snapshot = clone(input || {}), students = array(snapshot.students), bookings = array(snapshot.bookings), incomes = array(snapshot.incomes)
  const studentById = new Map(), packageRefs = [], packageById = new Map(), duplicateStudentIds = new Set(), duplicatePackageIds = new Set()
  students.forEach(student => {
    if (studentById.has(student.id)) duplicateStudentIds.add(student.id)
    else studentById.set(student.id, student)
    array(student.packages).forEach(pkg => {
      const ref = { studentId: student.id, studentStatus: student.status || 'active', package: pkg }
      if (packageById.has(pkg.id)) duplicatePackageIds.add(pkg.id)
      else packageById.set(pkg.id, ref)
      packageRefs.push(ref)
    })
  })
  const incomesByBooking = new Map()
  incomes.forEach(income => {
    if (!incomesByBooking.has(income.bookingId)) incomesByBooking.set(income.bookingId, [])
    incomesByBooking.get(income.bookingId).push(income)
  })

  const records = bookings.map(booking => {
    const reasons = [], deterministicRepairs = [], student = studentById.get(booking.studentId), packageRef = packageById.get(booking.packageId), linkedIncomes = incomesByBooking.get(booking.id) || [], status = booking.status
    let category = 'A'
    if (!booking.id || typeof booking.id !== 'string') reasons.push({ code: 'BOOKING_ID_MISSING', field: 'bookingId' })
    if (!['booked', 'done'].includes(status)) reasons.push({ code: 'BOOKING_STATUS_INVALID', field: 'status', actual: status })
    if (booking.studentId && duplicateStudentIds.has(booking.studentId)) reasons.push({ code: 'STUDENT_ID_AMBIGUOUS', field: 'studentId', actual: booking.studentId })
    if (booking.packageId && duplicatePackageIds.has(booking.packageId)) reasons.push({ code: 'PACKAGE_ID_AMBIGUOUS', field: 'packageId', actual: booking.packageId })

    if (!booking.studentId && packageRef && !duplicatePackageIds.has(booking.packageId)) deterministicRepairs.push({ field: 'studentId', value: packageRef.studentId, evidence: 'unique booking.packageId owner' })
    else if (!booking.studentId) reasons.push({ code: 'STUDENT_ID_MISSING', field: 'studentId' })
    else if (!student) reasons.push({ code: 'STUDENT_NOT_FOUND', field: 'studentId', actual: booking.studentId })

    if (!booking.packageId) {
      const incomePackageIds = [...new Set(linkedIncomes.map(item => item.packageId).filter(Boolean))]
      const incomePackage = incomePackageIds.length === 1 ? packageById.get(incomePackageIds[0]) : null
      if (incomePackage && !duplicatePackageIds.has(incomePackageIds[0]) && (!booking.studentId || incomePackage.studentId === booking.studentId)) deterministicRepairs.push({ field: 'packageId', value: incomePackageIds[0], evidence: 'unique linked income.packageId' })
      else reasons.push({ code: 'PACKAGE_ID_MISSING', field: 'packageId', incomePackageCandidateCount: incomePackageIds.length })
    } else if (!packageRef) reasons.push({ code: 'PACKAGE_NOT_FOUND', field: 'packageId', actual: booking.packageId })
    else if (booking.studentId && packageRef.studentId !== booking.studentId) reasons.push({ code: 'PACKAGE_STUDENT_CONFLICT', field: 'packageId/studentId', expectedStudentId: packageRef.studentId, actualStudentId: booking.studentId })

    const repairedStudentId = (deterministicRepairs.find(item => item.field === 'studentId') || {}).value, effectiveStudentId = booking.studentId || repairedStudentId || ''
    if (status === 'done') {
      if (linkedIncomes.length === 0) reasons.push({ code: 'DONE_INCOME_MISSING', field: 'income.bookingId' })
      else if (linkedIncomes.length > 1) reasons.push({ code: 'DONE_INCOME_AMBIGUOUS', field: 'income.bookingId', candidateCount: linkedIncomes.length })
      else if (effectiveStudentId && linkedIncomes[0].studentId && linkedIncomes[0].studentId !== effectiveStudentId) reasons.push({ code: 'INCOME_STUDENT_CONFLICT', field: 'income.studentId', actual: linkedIncomes[0].studentId, expected: effectiveStudentId })
    } else if (status === 'booked' && linkedIncomes.length) reasons.push({ code: 'BOOKED_HAS_INCOME', field: 'income.bookingId', candidateCount: linkedIncomes.length })

    const conflict = reasons.some(item => ['BOOKING_ID_MISSING', 'BOOKING_STATUS_INVALID', 'STUDENT_ID_AMBIGUOUS', 'PACKAGE_ID_AMBIGUOUS', 'PACKAGE_STUDENT_CONFLICT', 'DONE_INCOME_AMBIGUOUS', 'INCOME_STUDENT_CONFLICT', 'BOOKED_HAS_INCOME'].includes(item.code))
    const historicalOnly = status === 'done' && reasons.length > 0 && !conflict
    if (conflict || (status !== 'done' && reasons.length)) category = 'D'
    else if (historicalOnly) category = 'C'
    else if (deterministicRepairs.length) category = 'B'

    return {
      bookingId: booking.id || '', status, studentId: booking.studentId || '', packageId: booking.packageId || '', typeName: booking.typeName, date: booking.date, time: booking.time, hour: booking.hour, minute: booking.minute,
      category, reasons, deterministicRepairs,
      studentEvidence: student ? { id: student.id, status: student.status || 'active' } : null,
      packageEvidence: packageRef ? { id: packageRef.package.id, studentId: packageRef.studentId, saleId: packageRef.package.saleId || '', status: packageRef.package.status || 'active' } : null,
      incomeEvidence: linkedIncomes.map(item => ({ incomeId: item.id || '', bookingId: item.bookingId || '', studentId: item.studentId || '', packageId: item.packageId || '', amount: item.amount, date: item.date, time: item.time })),
      originalBooking: clone(booking)
    }
  })
  const counts = { A: 0, B: 0, C: 0, D: 0 }
  records.forEach(item => { counts[item.category] += 1 })
  const bookingIds = new Set(bookings.map(item => item.id))
  const orphanIncomes = incomes.filter(item => !bookingIds.has(item.bookingId)).map(item => ({ incomeId: item.id || '', bookingId: item.bookingId || '', studentId: item.studentId || '', reason: 'INCOME_BOOKING_NOT_FOUND' }))
  return { readOnly: true, counts, records, invalidRecords: records.filter(item => item.category !== 'A'), orphanIncomes }
}

module.exports = { analyzeHistoricalBookings }
