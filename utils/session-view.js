function completedViewState(current = {}, verified = {}) {
  const items = Array.isArray(verified.items) ? verified.items : []
  return {
    booking: { ...(current.booking || {}), status: 'done', packageId: verified.packageId || current.booking && current.booking.packageId, summary: verified.summary || current.booking && current.booking.summary || '', duration: verified.duration || current.duration || 60 },
    items,
    notes: verified.notes || '',
    category: verified.category || current.category || '综合训练',
    duration: verified.duration || current.duration || 60,
    summary: verified.summary || '',
    done: true
  }
}

module.exports = { completedViewState }
