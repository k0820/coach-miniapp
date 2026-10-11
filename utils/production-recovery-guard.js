// Production 救援门禁。**只对「已经选定救援目标且尚未解除」的设备生效**；
// 进入诊断页（`enter()`）时会临时打开整面冻结，选定目标后转为「目标级」持久冻结 ——
// 重启后那条课程的旧队列仍然发不出去，而排在它之前的其他正常课程照常同步。
// 只写独立的安全门禁 metadata；绝不改 coachDB、草稿、outbox 或云业务数据。
// ⚠️ 干净设备（从未做过救援）必须完全按正常生产运行 —— 见 `inspectingNow()` 的注释。
const KEY = 'coachProductionRecoveryHold'
// —— 受控补发授权（2026-09-22 积压队列恢复用）——
// 语义：**默认一条都不许发**（held 在 = 整面冻结）。只有操作员在抢修页上**显式点名**的 entryId
// 能在「同步引擎 step 模式」下通过；且一次调用只允许尝试一条命令（见 sync-engine 的 runFlush opts.step）。
//
// 为什么必须存在这个口子：解冻（release）会让 sync-engine 按 FIFO **把整队一次性发完**，
// 而积压队列里混着不同业务链（createBooking → 内容/改期 → completeBooking），需要**逐链看云端的
// revision / 回执 / 课时 / income** 才能确认没有重复业务事实。授权 ≠ 解冻：它只放行点名的条目，
// 全局闸（blocksBusiness 不带 resendStep 选项时）与业务写入口（mutate）**照旧全拦**。
//
// 边界（写死在实现里，不靠调用方自觉）：
//   · 只能放行 entryId —— 不接受命令名 / 时间 / 日期 / 集合名（载荷内容无从伪造）；
//   · 被救援冻结锁定的那节课（held.bookingId）**永远优先被拦**，授权也放不过（见 blocksEntry 顺序）；
//   · 授权只影响 production；sandbox 不受影响。
const GRANT_KEY = 'coachProductionResendGrant'
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
let inspecting = null
let armed = false
// 读授权。形状不合法一律当成「没有授权」（宁可全拦，绝不放行半张授权）。
function resendGrant() {
  const value = wx.getStorageSync(GRANT_KEY)
  if (!value || typeof value !== 'object' || !Array.isArray(value.allow)) return null
  const allow = value.allow.map(String).filter(Boolean)
  if (!allow.length) return null
  return { allow, label: typeof value.label === 'string' ? value.label : '', at: Number(value.at || 0) }
}
function grantResend(allowIds, label) {
  const allow = (Array.isArray(allowIds) ? allowIds : [allowIds]).map(String).filter(Boolean)
  if (!allow.length) throw new Error('受控补发必须点名至少一条 entryId。')
  wx.setStorageSync(GRANT_KEY, { allow, label: String(label || ''), at: Date.now() })
  const verified = resendGrant()
  if (!verified || verified.allow.join(',') !== allow.join(',')) throw new Error('受控补发授权回读失败；按未授权处理。')
  return verified
}
function clearResendGrant() {
  wx.removeStorageSync(GRANT_KEY)
  const leftover = resendGrant()
  if (leftover) throw new Error('受控补发授权清除失败；请立即停止并保持冻结。')
  return true
}
function held() {
  const value = wx.getStorageSync(KEY)
  return value && value.status !== 'released' && typeof value.bookingId === 'string' && value.bookingId && typeof value.datasetId === 'string' && value.datasetId ? clone(value) : null
}
function released() { const value = wx.getStorageSync(KEY); return value && value.status === 'released' ? clone(value) : null }
function inspectingNow() {
  if (!armed) return false
  // ⚠️ 默认值必须是「**已经选定救援目标且尚未解除**」，不能是「没有任何标记」。
  //    历史写法是 `!held() && !released()` —— 那等于把「从来没做过救援的干净设备」也当成
  //    「正在核查中」，于是 blocksBusiness('production') 恒为 true：
  //    新用户一装上正式版，`mutate` 直接返回 PRODUCTION_RECOVERY_READ_ONLY、
  //    sync-engine 整轮拒发 —— 整个小程序变成只读。
  //    本机当时能正常工作，只是因为它身上已经留着 `status:'released'` 的救援标记。
  //    救援语义本身一个字没变：`enter()` 仍然可以显式打开整面冻结（诊断页进来就调它），
  //    选定目标后 `held()` 为真、冻结继续跟着走，`release()` 之后恢复正常。
  if (inspecting === null) inspecting = !!held()
  return inspecting
}
function arm() { armed = true; return inspectingNow() }
function enter() { arm(); inspecting = true; return true }
function select(bookingId, datasetId) {
  if (!inspectingNow() || !bookingId || !datasetId) throw new Error('恢复诊断尚未就绪。')
  if (released()) throw new Error('该课程救援冻结已解除，不得重新锁定。')
  const prior = held()
  if (prior && (prior.bookingId !== bookingId || prior.datasetId !== datasetId)) throw new Error('已有另一节课程处于恢复冻结状态，不得更换目标。')
  if (!prior) {
    wx.setStorageSync(KEY, { bookingId, datasetId })
    const verified = held()
    if (!verified || verified.bookingId !== bookingId || verified.datasetId !== datasetId) throw new Error('课程冻结标记回读失败。')
  }
  return held()
}
function release(bookingId, datasetId) {
  const prior = held()
  if (!inspectingNow() || !prior || prior.bookingId !== bookingId || prior.datasetId !== datasetId) throw new Error('救援目标不一致，不能解除冻结。')
  wx.setStorageSync(KEY, { bookingId, datasetId, status: 'released', releasedAt: new Date().toISOString() })
  const verified = released()
  if (!verified || verified.bookingId !== bookingId || verified.datasetId !== datasetId) throw new Error('解除冻结标记回读失败；请保持诊断模式。')
  inspecting = false
  return verified
}
function exit() {
  // 离开救援工具：撤销的是**整面冻结**（那是给操作员在工具里浏览时用的临时保护），
  // **目标级冻结不受影响** —— `held()` 还在时那条课程照样发不出去（由 blocksEntry 负责），
  // 而排在它**之前**的其他正常课程可以正常同步。
  // ⚠️ 原写法是「没有标记就不恢复」，配上有缺陷的 inspectingNow() 默认值会把干净设备永久冻死；
  //    这里必须无条件撤销整面冻结，否则「进过工具又没选目标」就等于把小程序锁成只读。
  inspecting = false
  return !held()
}
function blocksEntry(scope, entry) {
  if (!armed) return false
  if (!scope || scope.environment !== 'production') return false
  // ① 「被救援冻结的那节课」**永远最先判**：受控补发授权也放不过它（判断顺序不许改）。
  const lock = held()
  if (lock && entry && lock.datasetId === scope.datasetId && (
    entry.payload && entry.payload.bookingId === lock.bookingId ||
    entry.entityKey === `booking:${lock.bookingId}` ||
    entry.ref && entry.ref.kind === 'booking' && entry.ref.localKey === lock.bookingId)) return true
  // ② 受控补发：**只有被点名的 entryId** 放行（载荷无从伪造：授权里只有 id）。
  const grant = resendGrant()
  if (grant && entry && grant.allow.includes(String(entry.entryId))) return false
  // ③ 整面冻结照旧：其余一切（含"没被点名"的队列条目）全拦。
  if (inspectingNow()) return true
  return false
}
function blocksBusiness(environment, options) {
  if (!(armed && environment === 'production' && inspectingNow())) return false
  // 受控补发：只有**同步引擎显式声明 step 模式**且存在有效授权时，才放行这一轮同步。
  // 其它调用方（`mutate` 业务写入口 / 预约协调器 / `resume`）**不传 options ⇒ 照旧全拦**。
  if (options && options.resendStep === true && resendGrant()) return false
  return true
}
module.exports = { KEY, GRANT_KEY, held, released, inspectingNow, resendGrant, grantResend, clearResendGrant, arm, enter, select, release, exit, blocksEntry, blocksBusiness }
