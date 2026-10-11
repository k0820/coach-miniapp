const { getDB, saveDB } = require('./data-runtime')

function validDateKey(value) {
  const key = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
}

function courseSalesForPackage(db, studentId, packageId) {
  return (db.sales || []).filter(sale => sale.source === 'course' && sale.studentId === studentId && sale.packageId === packageId)
}

function resolveCourseSale(db, studentId, packageId, saleId) {
  const student = (db.students || []).find(item => item.id === studentId)
  if (!student) return { ok: false, message: '对应学员已不存在，无法安全修改这笔课程销售。' }
  const pkg = (student.packages || []).find(item => item.id === packageId)
  if (!pkg) return { ok: false, message: '对应课时包已不存在，无法安全修改这笔课程销售。' }
  const matches = courseSalesForPackage(db, studentId, packageId)
  if (matches.length !== 1) return { ok: false, message: matches.length ? '该课时包关联了多笔历史销售，无法安全确定要修改哪一笔。' : '该课时包没有可确认的课程销售记录。' }
  const sale = matches[0]
  if (saleId && sale.id !== saleId) return { ok: false, message: '销售记录与课时包的关联不一致，已停止修改。' }
  if (pkg.saleId && pkg.saleId !== sale.id) return { ok: false, message: '课时包记录的销售编号不一致，已停止修改。' }
  return { ok: true, student, pkg, sale }
}

function numberField(value, label, options = {}) {
  const number = Number(value)
  if (!Number.isFinite(number) || (options.integer && !Number.isInteger(number)) || (options.positive ? number <= 0 : number < 0)) {
    return { ok: false, message: options.integer ? `${label}必须是${options.positive ? '大于0的' : '非负'}整数。` : `请输入有效的${label}。` }
  }
  return { ok: true, value: number }
}

function updateCourseSale(saleId, changes, options = {}) {
  const db = getDB(), sale = (db.sales || []).find(item => item.id === saleId)
  if (!sale) return { ok: false, message: '这笔业绩已不存在。' }
  if (sale.source !== 'course') return { ok: false, message: '这不是课程销售记录。' }
  if (sale.status === 'reversed') return { ok: false, message: '这笔销售已经撤销，不能再次修改。' }
  const context = resolveCourseSale(db, sale.studentId, sale.packageId, saleId)
  if (!context.ok) return context
  const { student, pkg } = context
  if (pkg.status === 'reversed') return { ok: false, message: '对应课时包已经撤销，不能再次修改。' }
  const type = changes.type == null ? pkg.type : String(changes.type || '').trim()
  if (!type) return { ok: false, message: '请选择课程种类。' }
  const totalResult = numberField(changes.total == null ? pkg.total : changes.total, '课时包总课时', { integer: true, positive: true })
  if (!totalResult.ok) return totalResult
  const quantityResult = numberField(changes.quantity == null ? (sale.quantity == null ? pkg.total : sale.quantity) : changes.quantity, '销售数量', { integer: true, positive: true })
  if (!quantityResult.ok) return quantityResult
  const remainingResult = numberField(changes.remaining == null ? pkg.remaining : changes.remaining, '当前剩余课时', { integer: true })
  if (!remainingResult.ok) return remainingResult
  const priceResult = numberField(changes.unitPrice == null ? (sale.unitPrice == null ? pkg.price : sale.unitPrice) : changes.unitPrice, '单节价格', { positive: true })
  if (!priceResult.ok) return priceResult
  const amountResult = numberField(changes.amount == null ? sale.amount : changes.amount, '销售业绩金额', { positive: true })
  if (!amountResult.ok) return amountResult
  const date = changes.date == null ? sale.date : changes.date
  const used = Number(pkg.used || 0)
  if (!Number.isFinite(used) || used < 0) return { ok: false, message: '课时包已使用数量异常，无法安全修改。' }
  if (!validDateKey(date)) return { ok: false, message: '请选择有效的业绩归属日期。' }
  const total = totalResult.value, quantity = quantityResult.value, remaining = remainingResult.value, unitPrice = priceResult.value, amount = Number(amountResult.value.toFixed(2))
  const warnings = []
  if ((changes.remaining != null || changes.total != null) && remaining > total) warnings.push('当前剩余课时高于课时包总课时')
  if (changes.total != null && total < used) warnings.push(`历史已完成${used}节，但课时包总课时填写为${total}节`)
  if ((changes.quantity != null || changes.unitPrice != null || changes.amount != null) && Number((quantity * unitPrice).toFixed(2)) !== amount) warnings.push('销售业绩金额与购买数量×单节价格不一致')
  if (warnings.length && !options.confirmInconsistent) return { ok: false, needsConfirm: true, message: `${warnings.join('；')}。是否仍然保存？` }
  const priceChanged = Number(pkg.price) !== unitPrice, typeChanged = pkg.type !== type
  Object.assign(sale, { typeName: type, quantity, unitPrice, amount, date, note: `${student.name} · ${type} ${quantity}节` })
  Object.assign(pkg, { type, total, remaining, price: unitPrice, saleDate: date, saleId: sale.id, status: 'active' })
  if (priceChanged || typeChanged) {
    const incomes = db.incomes || []
    ;(db.bookings || []).forEach(booking => {
      if (booking.studentId !== student.id || booking.packageId !== pkg.id || booking.status === 'done') return
      if (incomes.some(income => income.bookingId === booking.id)) return
      if (priceChanged) booking.price = unitPrice
      if (typeChanged) booking.typeName = type
    })
  }
  saveDB(db)
  return { ok: true, sale, pkg, total, remaining, warnings }
}

function saleRemovalPlan(db, saleId) {
  const sales = Array.isArray(db.sales) ? db.sales : [], sale = sales.find(item => item.id === saleId)
  if (!sale) return { kind: 'missing' }
  if (sale.status === 'reversed') return { kind: 'blocked', sale, message: '这笔销售已经撤销。' }
  if (sale.source === 'manual') return { kind: 'saleOnly', sale, reason: 'manual' }
  if (sale.source !== 'course') return { kind: 'blocked', sale, message: '这笔业绩来源无法确认，为保护现有数据，暂不能删除。' }
  const student = (db.students || []).find(item => item.id === sale.studentId)
  const pkg = student && (student.packages || []).find(item => item.id === sale.packageId)
  if (!student || !pkg) return { kind: 'orphanCourse', sale, student, pkg, reason: 'orphan', bookedCount: 0 }
  const samePackageSales = courseSalesForPackage(db, sale.studentId, sale.packageId)
  if (samePackageSales.length !== 1 || (pkg.saleId && pkg.saleId !== sale.id)) return { kind: 'blocked', sale, student, pkg, message: '该课时包的销售关联不唯一，无法安全撤销。' }
  const bookedCount = (db.bookings || []).filter(item => item.studentId === sale.studentId && item.packageId === sale.packageId && item.status === 'booked').length
  return { kind: 'reverseCourse', sale, student, pkg, bookedCount }
}

function reverseSale(saleId, expectedKind) {
  const db = getDB(), plan = saleRemovalPlan(db, saleId)
  if (plan.kind === 'missing') return { ok: false, message: '这笔业绩已不存在。' }
  if (plan.kind === 'blocked') return { ok: false, message: plan.message }
  if (expectedKind && plan.kind !== expectedKind) return { ok: false, message: '关联数据已经变化，请重新确认。' }
  if (plan.kind === 'saleOnly') db.sales = (db.sales || []).filter(item => item.id !== saleId)
  else {
    plan.sale.status = 'reversed'
    plan.sale.reversedAt = Date.now()
    if (plan.pkg) {
      plan.pkg.status = 'reversed'
      plan.pkg.remaining = 0
      plan.pkg.reversedAt = plan.sale.reversedAt
      db.bookings = (db.bookings || []).filter(item => !(item.studentId === plan.sale.studentId && item.packageId === plan.sale.packageId && item.status === 'booked'))
    }
  }
  saveDB(db)
  return { ok: true, kind: plan.kind, sale: plan.sale, packageId: plan.pkg && plan.pkg.id, cancelledBookings: plan.bookedCount || 0 }
}

function packageRemovalPlan(db, studentId, packageId) {
  const student = (db.students || []).find(item => item.id === studentId)
  const pkg = student && (student.packages || []).find(item => item.id === packageId)
  if (!student || !pkg) return { kind: 'missing' }
  const sales = courseSalesForPackage(db, studentId, packageId)
  if (sales.length === 1) return { kind: 'sale', saleId: sales[0].id, student, pkg, salePlan: saleRemovalPlan(db, sales[0].id) }
  if (sales.length > 1 || pkg.saleId) return { kind: 'blocked', message: '该课时包的销售关联不唯一，无法安全删除。' }
  const bookings = db.bookings || [], incomes = db.incomes || [], bookingMap = {}
  bookings.forEach(item => { bookingMap[item.id] = item })
  const linkedBooking = bookings.some(item => item.studentId === studentId && item.packageId === packageId)
  const legacyBooking = bookings.some(item => item.studentId === studentId && !item.packageId && item.typeName === pkg.type)
  const linkedIncome = incomes.some(item => { const booking = bookingMap[item.bookingId]; return booking && booking.studentId === studentId && booking.packageId === packageId })
  const legacyIncome = incomes.some(item => { if (item.studentId !== studentId || item.typeName !== pkg.type) return false; const booking = bookingMap[item.bookingId]; return !booking || !booking.packageId })
  if (Number(pkg.used || 0) > 0 || linkedBooking || legacyBooking || linkedIncome || legacyIncome) return { kind: 'blocked', message: '该课时包已有课程使用记录或关联预约，无法直接删除。' }
  return { kind: 'packageOnly', student, pkg }
}

function removePackageSafely(studentId, packageId, expectedKind) {
  const db = getDB(), plan = packageRemovalPlan(db, studentId, packageId)
  if (plan.kind === 'missing') return { ok: false, message: '该课时包已不存在。' }
  if (plan.kind === 'blocked' || plan.kind === 'sale') return { ok: false, message: plan.message || '请通过对应销售记录撤销该课时包。' }
  if (expectedKind && plan.kind !== expectedKind) return { ok: false, message: '关联数据已经变化，请重新确认。' }
  plan.student.packages = (plan.student.packages || []).filter(item => item.id !== packageId)
  saveDB(db)
  return { ok: true, kind: plan.kind, packageId }
}

module.exports = { validDateKey, resolveCourseSale, updateCourseSale, saleRemovalPlan, reverseSale, packageRemovalPlan, removePackageSafely }
