const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { classifyCompletion, route } = require('./service')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const coachIdFor = openId => sha(`coach:${openId}`).slice(0, 32)
const fixedId = (kind, owner, suffix = '') => sha(`${kind}:${owner}:${suffix}`).slice(0, 32)
const forbidden = new Set(['OPENID', 'openId', 'openid', '_openid', 'coachId', 'ownerCoachId', 'datasetId', 'documentId'])
async function one(name, query) { const result = await db.collection(name).where(query).limit(1).get(); return result.data && result.data[0] }
async function all(name, query) { const rows = []; let skip = 0; for (;;) { const result = await db.collection(name).where(query).orderBy('_id', 'asc').skip(skip).limit(100).get(), page = result.data || []; rows.push(...page); skip += page.length; if (page.length < 100) return rows } }

async function diagnose(ownerCoachId, datasetId, dataRevision, bookingId, receiptCollection) {
  const bookingRow = await one('bookings', { ownerCoachId, datasetId, bookingId })
  if (!bookingRow) return { ok: false, code: 'BOOKING_NOT_FOUND' }
  const booking = bookingRow.data || {}
  const packageId = booking.packageId || bookingRow.packageId || ''
  const packageRow = packageId ? await one('packages', { ownerCoachId, datasetId, packageId }) : null
  const incomes = await all('incomes', { ownerCoachId, datasetId, bookingId })
  const receipts = (await all(receiptCollection, { ownerCoachId, datasetId }))
    .filter(row => ['updateBookingContent', 'completeBooking'].includes(row.command) && row.response && row.response.result && row.response.result.bookingId === bookingId)
    .sort((a, b) => Number(b.completedAt || b.createdAt || 0) - Number(a.completedAt || a.createdAt || 0))
  const classified = classifyCompletion({ receipts, booking, incomes })
  return {
    ok: true, readOnly: true, ...classified, datasetId, dataRevision,
    booking: { bookingId, status: booking.status, packageId, items: Array.isArray(booking.items) ? booking.items : [], notes: booking.notes || '', category: booking.category || '', summary: booking.summary || '', duration: booking.duration },
    package: packageRow ? { packageId, used: packageRow.data && packageRow.data.used, remaining: packageRow.data && packageRow.data.remaining, status: packageRow.data && packageRow.data.status } : null,
    incomes: incomes.map(row => ({ incomeId: row.incomeId || row.data && row.data.id, bookingId: row.bookingId || row.data && row.data.bookingId, amount: row.data && row.data.amount })),
    receipts: receipts.slice(0, 20).map(row => ({ requestId: row.requestId, command: row.command, status: row.status, revisionBefore: row.revisionBefore, revisionAfter: row.revisionAfter, result: row.response && row.response.result, completedAt: row.completedAt }))
  }
}

exports.main = async event => {
  const openId = cloud.getWXContext().OPENID
  if (!openId) return { ok: false, code: 'IDENTITY_MISSING' }
  for (const key of Object.keys(event || {})) if (forbidden.has(key)) return { ok: false, code: 'FORBIDDEN_IDENTITY_INPUT' }
  if (event.environment != null && event.environment !== 'production' && event.environment !== 'sandbox') return { ok: false, code: 'INVALID_ENVIRONMENT' }
  const environment = event.environment === 'sandbox' ? 'sandbox' : 'production'
  const ownerCoachId = coachIdFor(openId)
  const coach = await one('coaches', { _id: ownerCoachId, openId, status: 'active' })
  if (!coach) return { ok: false, code: 'COACH_NOT_FOUND' }
  const headCollection=environment==='sandbox'?'coach_sandbox_heads':'coach_data_heads',headKind=environment==='sandbox'?'coach-sandbox-head':'coach-data-head',revisionCollection=environment==='sandbox'?'coach_sandbox_revisions':'coach_data_revisions',revisionKind=environment==='sandbox'?'coach-sandbox-revision':'coach-data-revision',receiptCollection=environment==='sandbox'?'coach_sandbox_receipts':'coach_command_receipts'
  const head = await one(headCollection, environment==='sandbox'?{ _id: fixedId(headKind, ownerCoachId), ownerCoachId, environment }:{ _id: fixedId(headKind, ownerCoachId), ownerCoachId })
  if (!head || !head.activeDatasetId) return { ok: false, code: 'ACTIVE_DATASET_NOT_FOUND' }
  const datasetId = head.activeDatasetId
  const revision = await one(revisionCollection, { _id: fixedId(revisionKind, ownerCoachId, datasetId), ownerCoachId, datasetId })
  if (!revision || !Number.isInteger(revision.dataRevision)) return { ok: false, code: 'ACTIVE_DATASET_INVALID' }
  return route(event, bookingId => diagnose(ownerCoachId, datasetId, revision.dataRevision, bookingId, receiptCollection))
}
