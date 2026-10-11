const runtime = require('./data-runtime')
const flags = require('./release-flags')
const manage = require('./member-booking-manage')
// ⭐⭐ 云函数名**只从这一个出处**取（2026-10-05）：测试区走 Sandbox 云函数，正式区走正式云函数。
const routing = require('./sandbox-cloud-functions')

const CACHE = 'coachMemberActiveCache:'
const PENDING = 'coachMemberPendingCommands:'
const environment = () => runtime.environment() === 'sandbox' ? 'sandbox' : 'production'
const cacheKey = () => CACHE + environment()
const pendingKey = () => PENDING + environment()
const readStorage = key => { try { return wx.getStorageSync(key) } catch (e) { return null } }
const writeStorage = (key, value) => { wx.setStorageSync(key, value); return wx.getStorageSync(key) }
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const requestId = action => `member_${action}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
const call = (name, data) => wx.cloud.callFunction({ name, data }).then(result => result && result.result || result)
const readCall = data => environment() === 'sandbox'
  ? call(routing.businessFunction(environment()), { ...data, action: 'memberRead', readAction: data.action, environment: 'sandbox' })
  : call('readMyMemberData', data)

function cached() { const value = readStorage(cacheKey()); return value && value.environment === environment() ? clone(value) : null }
function pending() { const value = readStorage(pendingKey()); return Array.isArray(value) ? value.filter(row => row.environment === environment()) : [] }
function savePending(rows) { writeStorage(pendingKey(), rows); return rows }
async function bootstrap() { return call(routing.identityFunction(environment()), { action: 'bootstrap', environment: environment() }) }
async function read(options = {}) {
  try {
    const result = await readCall({ action: 'read', environment: environment() })
    if (!result || !result.ok) throw Object.assign(new Error(result && result.message || '会员数据读取失败。'), { code: result && result.code })
    const record = { ...result, cachedAt: Date.now() }, stored = writeStorage(cacheKey(), record)
    if (!stored || stored.environment !== environment()) throw Object.assign(new Error('会员缓存保存失败。'), { code: 'MEMBER_CACHE_WRITE_FAILED' })
    return record
  } catch (error) {
    const fallback = cached()
    if (options.allowCache !== false && fallback) return { ...fallback, offline: true }
    throw error
  }
}
// M3 P1 · 会员「可约时间」**只读**查询。
// ⛔ 这条链**只能读**，不许带任何写命令（会员写通道还没定，见 M3_PREP_V1.md §8）。
// ⚠️ 云端尚未部署这个 action ⇒ 老版本会照旧返回整包读取结果 ⇒ 靠 `availability === true` 判别；
//    拿不到就返回 null，页面退化成"只按自己的课排除冲突"，绝不假装"教练全天有空"。
//
// ★★ M3-P1 提速（真机体感 1–2 秒 → 目标秒开）★★
//   · **按日期分桶的短 TTL 缓存**（20 秒）：目的**不是**"少发请求"，而是"同一屏内不要重复请求"。
//     切日期、从确认层返回、`onShow` 抖动都不会各发一趟。
//   · ⛔ **教练最新排课不许因为缓存长期显示旧数据** ⇒ TTL 只有 20 秒，且页面每次进屏都用
//     `force: true` 拉一次最新的；缓存只负责"先把画面填出来"，随后一定被真实结果覆盖。
//   · ⛔ **最终冲突裁决仍然完全在服务端**（`coachBusinessCommand` 事务内的 occupancy / assertMayBook）。
//     这里多新鲜都只是**展示**，绝不会因为缓存产生重复预约。
//   · ⛔ 不允许用"直接返回缓存并悄悄不请求"来制造"变快"的假象 —— `force` 一律真的发请求。
const AVAILABILITY_CACHE = 'coachMemberAvailability:'
const AVAILABILITY_TTL_MS = 20000
const availabilityCacheKey = date => `${AVAILABILITY_CACHE}${environment()}:${String(date || '')}`

// 读缓存（**不判 TTL**）：页面靠它"先把画面填出来"，是不是够新由调用方决定。
function cachedAvailability(date) {
  const value = readStorage(availabilityCacheKey(date))
  if (!value || value.availability !== true) return null
  if (value.environment !== environment()) return null
  return clone(value)
}
function availabilityFresh(row) {
  return !!row && (Date.now() - Number(row.cachedAt || 0)) < AVAILABILITY_TTL_MS
}

async function availability(date, options = {}) {
  const key = String(date || ''), cached = cachedAvailability(key)
  // 20 秒内的同一份就是"刚拉到的"，不必再来一趟（`force` 例外：进屏 / 下拉一律拿最新的）。
  if (options.force !== true && availabilityFresh(cached)) return { ...cached, fromCache: true }
  try {
    const result = await readCall({ action: 'availability', date: key, environment: environment() })
    if (!result || result.ok !== true || result.availability !== true) return cached || null
    const record = { ...result, cachedAt: Date.now() }
    try { writeStorage(availabilityCacheKey(key), record) } catch (error) { /* 写不进就退化成不缓存，不影响本次结果 */ }
    return record
  } catch (error) {
    // ⚠️ 网络失败时**回落到缓存**（哪怕已过期）：一份 30 秒前的真实占用，也比"整天全可约"安全得多。
    return cached || null
  }
}

// 预热：把"用户马上要看的那几天"提前发出去，**不阻塞渲染、不抛错**。
//   ⭐ 网络时间被藏进"用户从上一个页面点进来"的那几百毫秒里。
function preloadAvailability(dates) {
  const list = (Array.isArray(dates) ? dates : [dates]).filter(Boolean)
  return Promise.all(list.map(date => availability(date).catch(() => null)))
}

// ------------------------------------------------------------------ 后台对账（⛔ 不在成功关键路径上）
//
// ⭐⭐ 2026-10-01 性能专项（真机实测：预约 3s+ / 改期·取消 ~2s）
//   旧写法：写命令 `coachBusinessCommand` **成功之后**，再 `await read({allowCache:true})` 才返回。
//   ⇒ 那是一整趟**额外的云函数调用**（完整读一遍会员数据），把"告诉用户成功"推迟了一个网络往返。
//   探针证据（`tests/_probe-write-path-cost.js`）：三条链路**都是 2 趟云调用**，第 2 趟就是它。
//
// ⛔ 它不是"成功"的必要条件：**服务端事务已经提交、收据已落库**，成不成立由云端终判决定，
//    这一趟 read 只是刷新缓存 / 让「我的预约」下次进屏更快。
// ⛔ 页面本来就有 Local-first + `load(true)` 服务端对账 ⇒ 移出关键路径**不会**丢真相。
// ⛔ 对账失败**不许**把已经成功的业务说成失败（与原来 `catch {}` 的语义逐字相同）。
let backgroundReconcile = null
function startBackgroundReconcile(mark) {
  if (mark) mark('backgroundReconcileStart')
  const promise = read({ allowCache: true }).then(
    value => {
      backgroundReconcile = null
      if (mark) mark('backgroundReconcileEnd')
      return value
    },
    () => {
      backgroundReconcile = null
      if (mark) mark('backgroundReconcileFailed')
      return null
    }
  )
  backgroundReconcile = promise
  return promise
}
// 页面 / 测试**可以**（但不被要求）等这一趟 —— 例如「我的预约」进屏时想确认缓存已经最新。
const pendingReconcile = () => backgroundReconcile

// M3-P2 · 会员预约**真实提交**的唯一出口（⛔ 双重锁：调用方要先过 release-flag，这里再过一次）。
//   · 现在 `MEMBER_BOOKING_SUBMIT === false` ⇒ 直接返回"未开放"，**一次云调用都不发**；
//   · 云端那一侧另有两道闸：命令白名单只有 createMemberBooking、规则 1 未定 ⇒ POLICY_NOT_SELECTED。
//   ⇒ "前端接线完整"与"真的能写"是两件事，不许互相冒充。
// ⚠️ 名字**不要**叫 `submitBooking`：那是教练端 pending-booking-request 的写面符号，
//    `tests/mutate-write-surface` 有一条静态审计禁止页面直接出现它（业务写只能走统一入口）。
//    这里是**会员侧**受控通道，语义不同 ⇒ 用不会撞名的 `submitMemberBooking`。
async function submitMemberBooking(request, options = {}) {
  if (!flags.memberBookingSubmitEnabled()) {
    return { ok: false, code: 'MEMBER_BOOKING_SUBMIT_DISABLED', message: '预约提交功能待开放。' }
  }
  if (!request || !request.requestId || !request.command || !request.payload) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: '预约请求结构不完整。' }
  }
  const id = String(request.requestId)
  const trace = options.trace === true ? [] : null
  const mark = name => { if (trace) trace.push({ stage: name, at: Date.now() }) }
  mark('clientStart')
  try {
    mark('cloudCallStart')
    const result = await call(routing.businessFunction(environment()), {
      action: 'memberBooking', command: request.command, requestId: id,
      payload: clone(request.payload), environment: environment()
    })
    mark('cloudReturn')
    // ⭐ 成功后**后台**回读一次（让「我的预约」下次进屏就看到这一条）。
    void startBackgroundReconcile(mark)
    mark('clientResult')
    return { ...(result || {}), requestId: id, ...(trace ? { __trace: trace } : {}) }
  } catch (error) {
    return { ok: false, code: 'MEMBER_BOOKING_RESULT_UNKNOWN', message: '预约结果待确认，请勿重复提交。', requestId: id, ...(trace ? { __trace: trace } : {}) }
  }
}

// M3-P4 建，M3-P6 接通 · 会员「取消 / 改期」的唯一出口（**三道锁**，任一为真 ⇒ 零云调用）：
//   ① `MEMBER_MANAGE_SUBMIT === false`（写链总闸）；
//   ② `manage.policyBlocked()`（六条产品规则没定 ⇒ 不许替她选）；
//   ③ 云端命令白名单 + 服务端终判（**即使前两道都被绕过，云端也只认这三条命令**）。
// ✅ M3-P6（2026-09-30）：六条规则已由用户定稿 ⇒ `policyBlocked()` 恒为 false；总闸已开 ⇒ 真的会写。
//   ⛔ 但 ①② 两道锁**一个字节都没删**：紧急回滚只需把 `MEMBER_MANAGE_SUBMIT` 改回 false
//      （关回去就零云调用，页面明说"暂未开放"，绝不假成功）。测试 `m3-p4` 的⑳ 仍在验这两道锁。
async function submitMemberManage(request, options = {}) {
  if (!flags.memberManageSubmitEnabled()) {
    return { ok: false, code: 'MEMBER_MANAGE_SUBMIT_DISABLED', message: manage.NOTICE_TITLE + '。' }
  }
  if (manage.policyBlocked()) {
    return { ok: false, code: 'MEMBER_MANAGE_POLICY_NOT_SELECTED', message: manage.FRIENDLY_MESSAGES.MEMBER_MANAGE_POLICY_NOT_SELECTED }
  }
  if (!request || !request.requestId || !request.command || !request.payload) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: '预约调整请求结构不完整。' }
  }
  if (manage.MANAGE_COMMANDS.indexOf(request.command) < 0) {
    return { ok: false, code: 'UNKNOWN_COMMAND', message: '不认识的预约调整命令。' }
  }
  const id = String(request.requestId)
  const trace = options.trace === true ? [] : null
  const mark = name => { if (trace) trace.push({ stage: name, at: Date.now() }) }
  mark('clientStart')
  try {
    mark('cloudCallStart')
    const result = await call(routing.businessFunction(environment()), {
      action: 'memberBooking', command: request.command, requestId: id,
      payload: clone(request.payload), environment: environment()
    })
    mark('cloudReturn')
    void startBackgroundReconcile(mark)
    mark('clientResult')
    return { ...(result || {}), requestId: id, ...(trace ? { __trace: trace } : {}) }
  } catch (error) {
    return { ok: false, code: 'MEMBER_MANAGE_RESULT_UNKNOWN', message: '调整结果待确认，请勿重复提交。', requestId: id, ...(trace ? { __trace: trace } : {}) }
  }
}

// ⭐ 切换「当前档案」时清掉可约时段缓存（2026-10-03 新增）。
//   可约时段是**按这份档案能约的教练集合**算出来的 ⇒ 换了档案，旧缓存对应的就是另一批教练，
//   不清就会出现"档案已经切了、约课页还按上一份的教练算可约"（用户需求 A.8 点名的混用）。
//   ⛔ 只清可约时段这一类键，⛔ 绝不动会员数据缓存（`coachMemberActiveCache:`）——
//      那是"整份会员数据"，清了会变成"页面空白等网络"，反而更糟。
function clearAvailability() {
  try {
    const info = typeof wx.getStorageInfoSync === 'function' ? wx.getStorageInfoSync() : null
    const keys = (info && Array.isArray(info.keys) ? info.keys : []).filter(key => String(key).indexOf(AVAILABILITY_CACHE) === 0)
    keys.forEach(key => { try { wx.removeStorageSync(key) } catch (error) { /* 单个删不掉不影响其它 */ } })
    return keys.length
  } catch (error) { return 0 }
}

async function command(commandName, payload, options = {}) {
  // 🎯 调用方可显式指定要去哪个世界（`{ environment: 'sandbox' | 'production' }`）。
  //   ⛔ 不传（或传了别的值）就**逐字沿用**原来的行为：走当前运行时环境。
  //   ⭐ 为什么要引入它（2026-10-06 真机事故）：`pages/member-claim` 那条新会员入口开在**教练的课表页**上，
  //      会员从那里进来时小程序可能停在 `production` —— 而正式区那支云函数还是没部署过 `previewClaimInvite`
  //      的旧版本，它对这条命令的回答就是「不支持的会员身份命令。」。⇒ 认领码属于哪个世界，
  //      就该由哪个世界的服务器来回答（页面负责裁定，这里只提供"去指定世界"的能力）。
  const target = options.environment === 'sandbox' || options.environment === 'production' ? options.environment : environment()
  // ⛔ 测试区功能门禁（需求 3）：正式区**零云调用**，原样返回「该功能尚在安全测试中」。
  //   ⚠️ 门禁判定用**目标世界**（显式指定 sandbox 时，原来的 correspondingly 门禁就应当放开）。
  const gate = routing.reject(commandName, target, payload)
  if (gate) return gate
  const commandPayload = clone(payload || {}), rows = pending()
  const matching = rows.find(row => row.command === commandName && JSON.stringify(row.payload || {}) === JSON.stringify(commandPayload))
  const current = cached() || { dataRevision: 0 }, id = options.requestId || (matching && matching.requestId) || requestId(commandName)
  const entry = matching || { requestId: id, command: commandName, payload: commandPayload, expectedRevision: Number(current.dataRevision || 0), environment: target, createdAt: Date.now() }
  // ⚠️ 待补发队列是**按环境分Key**存的（`pendingKey()` 带环境后缀，读取时也按环境过滤）。
  //   ⇒ 目标世界与当前世界不一致时**不落队列**：落下去它永远不会被 `pending()` 读到、
  //     也就永远不会被 `resumePending` 补发，只会变成一条没人认领的脏行。
  if (target === environment() && !rows.some(row => row.requestId === id)) savePending(rows.concat(entry))
  let result
  // ⛔ 云函数名永远只从路由模块取；这里多出来的只是"去哪个世界"这个决定。
  const identityFunction = routing.identityFunction(target)
  try { result = await call(identityFunction, { action: 'execute', command: commandName, payload: entry.payload, requestId: id, expectedRevision: entry.expectedRevision, environment: entry.environment }) } catch (error) {
    try { result = await call(identityFunction, { action: 'getReceipt', requestId: id, environment: entry.environment }) } catch (lookupError) { return { ok: false, code: 'MEMBER_RESULT_UNKNOWN', message: '操作结果待确认，请勿重复提交。', requestId: id } }
    if (result && result.ok && result.found && result.receipt.status === 'succeeded') result = { ok: true, ...(result.receipt.result || {}), revisionAfter: result.receipt.revisionAfter, replayed: true }
    else return { ok: false, code: 'MEMBER_RESULT_UNKNOWN', message: '操作结果待确认，请勿重复提交。', requestId: id }
  }
  if (result && result.ok) { savePending(pending().filter(row => row.requestId !== id)); await read({ allowCache: true }); return { ...result, requestId: id } }
  if (result && result.code !== 'MEMBER_RESULT_UNKNOWN') savePending(pending().filter(row => row.requestId !== id))
  if (result && result.code === 'REVISION_CONFLICT') await read({ allowCache: true })
  return { ...(result || { ok: false, code: 'MEMBER_COMMAND_FAILED', message: '操作没有完成。' }), requestId: id }
}
async function resumePending() {
  const rows = pending(), outcomes = []
  for (const entry of rows) {
    let receipt
    try { receipt = await call(routing.identityFunction(entry.environment), { action: 'getReceipt', requestId: entry.requestId, environment: entry.environment }) } catch (e) { outcomes.push({ requestId: entry.requestId, status: 'unknown' }); continue }
    if (receipt && receipt.ok && receipt.found && receipt.receipt.status === 'succeeded') { savePending(pending().filter(row => row.requestId !== entry.requestId)); outcomes.push({ requestId: entry.requestId, status: 'succeeded' }) }
    else outcomes.push({ requestId: entry.requestId, status: 'pending' })
  }
  if (outcomes.some(row => row.status === 'succeeded')) await read({ allowCache: true })
  return outcomes
}
module.exports = { environment, cached, pending, bootstrap, read, availability, cachedAvailability, availabilityFresh, preloadAvailability, clearAvailability, submitMemberBooking, submitMemberManage, command, resumePending, cacheKey, pendingKey, AVAILABILITY_TTL_MS, startBackgroundReconcile, pendingReconcile }
