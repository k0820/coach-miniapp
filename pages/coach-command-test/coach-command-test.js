const call = data => wx.cloud.callFunction({ name: 'coachBusinessCommandTest', data }).then(response => response.result)
const rid = prefix => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

Page({
  data: { busy: false, result: '尚未测试。', state: null },
  async invoke(data) {
    this.setData({ busy: true })
    try {
      const result = await call(data)
      this.setData({ result: JSON.stringify(result, null, 2) })
      return result
    } catch (error) {
      const message = error && (error.errMsg || error.message) || '云函数调用失败'
      this.setData({ result: message })
      return { ok: false, code: 'CALL_FAILED', message }
    } finally { this.setData({ busy: false }) }
  },
  async reset() { await this.invoke({ action: 'reset' }); await this.read() },
  async read() {
    const state = await this.invoke({ action: 'read' })
    if (state.ok) this.setData({ state })
  },
  async completeAndRetry() {
    const requestId = rid('complete'), envelope = { command: 'completeBooking', requestId, expectedRevision: 0, payload: { bookingId: 'booking-complete', items: [{ name: '真机事务测试动作' }] } }
    const first = await call({ action: 'execute', envelope }), retry = await call({ action: 'execute', envelope }), state = await call({ action: 'read' })
    this.setData({ result: JSON.stringify({ first, retry, state }, null, 2), state })
  },
  async incomeRollback() {
    await call({ action: 'reset' })
    const response = await call({ action: 'execute', failAt: 'income', envelope: { command: 'completeBooking', requestId: rid('income_fail'), expectedRevision: 0, payload: { bookingId: 'booking-complete' } } }), state = await call({ action: 'read' })
    this.setData({ result: JSON.stringify({ response, state }, null, 2), state })
  },
  async concurrentComplete() {
    await call({ action: 'reset' })
    const payload = { bookingId: 'booking-complete' }
    const responses = await Promise.all([
      call({ action: 'execute', envelope: { command: 'completeBooking', requestId: rid('parallel_a'), expectedRevision: 0, payload } }),
      call({ action: 'execute', envelope: { command: 'completeBooking', requestId: rid('parallel_b'), expectedRevision: 0, payload } })
    ]), state = await call({ action: 'read' })
    this.setData({ result: JSON.stringify({ responses, state }, null, 2), state })
  },
  async reverseAndRollback() {
    await call({ action: 'reset' })
    const failed = await call({ action: 'execute', failAt: 'reverseBookings', envelope: { command: 'reverseCourseSale', requestId: rid('reverse_fail'), expectedRevision: 0, payload: { saleId: 'sale-reverse' } } }), afterFailure = await call({ action: 'read' })
    const success = await call({ action: 'execute', envelope: { command: 'reverseCourseSale', requestId: rid('reverse_ok'), expectedRevision: 0, payload: { saleId: 'sale-reverse' } } }), afterSuccess = await call({ action: 'read' })
    this.setData({ result: JSON.stringify({ failed, afterFailure, success, afterSuccess }, null, 2), state: afterSuccess })
  },
  async cleanup() { await this.invoke({ action: 'cleanup' }); this.setData({ state: null }) }
})
