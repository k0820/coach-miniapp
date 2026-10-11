function findLegacyOrphanBooking(snapshot) {
  const bookings = snapshot && Array.isArray(snapshot.bookings) ? snapshot.bookings : []
  const booking = bookings.find(item => item && item.legacyRelationStatus === 'orphan')
  if (!booking) return null
  return {
    bookingId: booking.id,
    date: booking.date || '',
    time: booking.time || `${String(booking.hour == null ? '' : booking.hour).padStart(2, '0')}:${String(booking.minute || 0).padStart(2, '0')}`,
    studentName: booking.studentName || '已删学员',
    typeName: booking.typeName || '',
    status: booking.status || '',
    legacyRelationReason: booking.legacyRelationReason || ''
  }
}

module.exports = { findLegacyOrphanBooking }
