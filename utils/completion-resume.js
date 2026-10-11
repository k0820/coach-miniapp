const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)

function preflightError(before, baseline) {
  if (!before || !before.ok || before.state !== 'C_CONTENT_SUCCEEDED_COMPLETE_NOT_SUCCEEDED' || before.strict !== true) return { code: 'RESUME_STATE_NOT_SAFE' }
  if (baseline && Number(baseline.dataRevision) !== Number(before.dataRevision)) return { code: 'REVISION_CHANGED_SINCE_DIAGNOSIS', expectedRevision: baseline.dataRevision, actualRevision: before.dataRevision }
  if (!before.booking || before.booking.status !== 'booked' || before.incomes.length !== 0) return { code: 'RESUME_STATE_NOT_SAFE' }
  if (!before.package || before.package.status === 'reversed' || !Number.isFinite(Number(before.package.used)) || !Number.isFinite(Number(before.package.remaining)) || Number(before.package.remaining) <= 0) return { code: 'RESUME_PACKAGE_NOT_AVAILABLE' }
  return null
}

function verifySuccess(before, after, requestId) {
  const receipt = after && after.receipts && after.receipts.find(row => row.requestId === requestId && row.command === 'completeBooking')
  const contentBefore = { items: before.booking.items, notes: before.booking.notes, category: before.booking.category, duration: before.booking.duration }
  const contentAfter = after && after.booking && { items: after.booking.items, notes: after.booking.notes, category: after.booking.category, duration: after.booking.duration }
  const checks = {
    state: !!after && after.ok && after.strict === true && after.state === 'B_BOTH_COMMANDS_SUCCEEDED',
    revision: !!after && Number(after.dataRevision) === Number(before.dataRevision) + 1,
    booking: !!after && after.booking && after.booking.status === 'done' && after.booking.packageId === before.booking.packageId,
    package: !!after && after.package && after.package.packageId === before.package.packageId && Number(after.package.used) === Number(before.package.used) + 1 && Number(after.package.remaining) === Number(before.package.remaining) - 1,
    income: !!after && Array.isArray(after.incomes) && after.incomes.length === 1 && after.incomes[0].bookingId === before.booking.bookingId,
    content: canonical(contentAfter) === canonical(contentBefore),
    receipt: !!receipt && receipt.status === 'succeeded' && Number(receipt.revisionBefore) === Number(before.dataRevision) && Number(receipt.revisionAfter) === Number(before.dataRevision) + 1
  }
  return { ok: Object.values(checks).every(Boolean), checks, receipt }
}

async function resumeCompletion({ bookingId, baseline, diagnose, execute, requestId }) {
  const before = await diagnose(bookingId)
  const unsafe = preflightError(before, baseline)
  if (unsafe) return { ok: false, ...unsafe, before, executed: false }
  const command = await execute('completeBooking', { bookingId }, { requestId, expectedRevision: before.dataRevision })
  const after = await diagnose(bookingId)
  const verified = verifySuccess(before, after, requestId)
  if (verified.ok) return { ok: true, code: command && command.ok ? 'RESUME_COMPLETED' : 'RESUME_RECOVERED_FROM_RECEIPT', requestId, before, after, verification: verified.checks }
  return { ok: false, code: after && after.state === 'COMMAND_RESULT_PENDING' ? 'RESUME_RESULT_PENDING' : command && command.code || 'RESUME_NOT_COMPLETED', requestId, before, after, verification: verified.checks, executed: true }
}

module.exports = { resumeCompletion, preflightError, verifySuccess, canonical }
