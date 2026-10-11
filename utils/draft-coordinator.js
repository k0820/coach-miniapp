function createDraftCoordinator() {
  let version = 0
  let savedVersion = 0
  let inFlight = null

  function markDirty() {
    version += 1
    return version
  }

  function isDirty() {
    return savedVersion < version
  }

  async function save(task) {
    if (inFlight) return inFlight
    if (!isDirty()) return { ok: true, skipped: true }
    const targetVersion = version
    inFlight = Promise.resolve().then(task).then(result => {
      if (result && result.ok && savedVersion < targetVersion) savedVersion = targetVersion
      return result
    }).finally(() => { inFlight = null })
    return inFlight
  }

  async function flush(task) {
    let attempts = 0
    while (isDirty() || inFlight) {
      if (++attempts > 20) return { ok: false, code: 'DRAFT_FLUSH_NOT_STABLE' }
      const result = await save(task)
      if (!result || !result.ok) return result || { ok: false, code: 'DRAFT_SAVE_FAILED' }
    }
    return { ok: true }
  }

  function reset() {
    version = 0
    savedVersion = 0
    inFlight = null
  }

  return { markDirty, isDirty, save, flush, reset, isSaving: () => !!inFlight }
}

module.exports = { createDraftCoordinator }
