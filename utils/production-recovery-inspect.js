// 只读汇总：不调用同步、mutate、saveDB，也不写 Storage。
const outbox = require('./local-outbox')
const drafts = require('./pending-training-draft')
const completions = require('./pending-completion')
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
function inspectLocal(bookingId) {
  const cache = wx.getStorageSync('coachCloudActiveCache')
  if (!cache || !cache.datasetId || !cache.snapshot) return { ok: false, code: 'PRODUCTION_CACHE_UNAVAILABLE' }
  const scope = { environment: 'production', datasetId: cache.datasetId }
  const snapshot = cache.snapshot
  const booking = (snapshot.bookings || []).find(row => row.id === bookingId) || null
  const draft = drafts.get('production', scope.datasetId, bookingId)
  const matches = row => row && (row.payload && row.payload.bookingId === bookingId || row.entityKey === `booking:${bookingId}` || row.ref && row.ref.localKey === bookingId)
  const entries = outbox.list(scope).filter(row => ['updateBookingContent', 'completeBooking'].includes(row.command) && matches(row))
  const failed = outbox.failed(scope).filter(row => row.datasetId === scope.datasetId && ['updateBookingContent', 'completeBooking'].includes(row.command) && matches(row))
  const intents = completions.list('production', scope.datasetId).filter(row => row.officialId === bookingId || row.localKey === bookingId)
  const packageId = booking && booking.packageId
  const packages = (snapshot.students || []).reduce((rows, student) => rows.concat(student.packages || []), [])
  const exactPackage = packageId ? packages.find(row => row.id === packageId) || null : null
  const incomes = (snapshot.incomes || []).filter(row => row.bookingId === bookingId)
  return { ok: true, readOnly: true, cacheRevision: cache.revision, datasetId: scope.datasetId,
    booking: copy(booking), draft: copy(draft), entries: copy(entries), failed: copy(failed), intents: copy(intents),
    package: copy(exactPackage), incomes: copy(incomes), note: 'cache 是上次云端确认值；entries 是本机尚未结清的意图，不能把二者当成同一时刻。' }
}
function candidates() {
  const cache = wx.getStorageSync('coachCloudActiveCache')
  if (!cache || !cache.datasetId || !cache.snapshot) return []
  return (cache.snapshot.bookings || []).slice().sort((a, b) => `${b.date||''} ${b.hour||0}:${b.minute||0}`.localeCompare(`${a.date||''} ${a.hour||0}:${a.minute||0}`))
    .map(row => ({ bookingId: row.id, label: `${row.date || '-'} ${String(row.hour || 0).padStart(2, '0')}:${String(row.minute || 0).padStart(2, '0')} · ${row.studentName || '学员'} · ${row.status || '未知'}` }))
}
module.exports = { inspectLocal, candidates }
