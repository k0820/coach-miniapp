function classifyCompletion({ receipts = [], booking, incomes = [] }) {
  if (receipts.some(row => row.status === 'processing')) return { state: 'COMMAND_RESULT_PENDING', strict: false }
  const contentReceipts = receipts.filter(row => row.command === 'updateBookingContent' && row.status === 'succeeded')
  const completeReceipts = receipts.filter(row => row.command === 'completeBooking' && row.status === 'succeeded')
  const status = booking && booking.status
  const incomeCount = incomes.length
  if (completeReceipts.length > 1 || incomeCount > 1) return { state: 'INCONSISTENT_MULTIPLE_COMPLETIONS', strict: false }
  if (completeReceipts.length === 1) {
    if (!contentReceipts.length || status !== 'done' || incomeCount !== 1) return { state: 'INCONSISTENT_COMPLETION_STATE', strict: false }
    return { state: 'B_BOTH_COMMANDS_SUCCEEDED', strict: true }
  }
  if (contentReceipts.length) {
    if (status !== 'booked' || incomeCount !== 0) return { state: 'INCONSISTENT_CONTENT_ONLY_STATE', strict: false }
    return { state: 'C_CONTENT_SUCCEEDED_COMPLETE_NOT_SUCCEEDED', strict: true }
  }
  if (status === 'booked' && incomeCount === 0) return { state: 'A_BOTH_COMMANDS_NOT_SUCCEEDED', strict: true }
  return { state: 'INCONSISTENT_WITHOUT_SUCCEEDED_RECEIPT', strict: false }
}

function route(event, diagnose) {
  if (!event || event.action !== 'diagnose') return { ok: false, code: 'INVALID_ACTION' }
  const bookingId = String(event.bookingId || '')
  if (!bookingId) return { ok: false, code: 'INVALID_BOOKING_ID' }
  return diagnose(bookingId)
}

module.exports = { classifyCompletion, route }
