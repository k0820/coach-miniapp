// 精准剔除（恢复计划 A 类）的**永久测试**。
//
// 为什么必须有这个文件：剔除是这次恢复里**唯一会动本机队列**的动作，而它是"按 entryId 逐个删"——
// 删错一条真实业务命令的代价，可能比云端那条悬空引用还大（`ob_3p_uxob42` 就是活例子：
// 它是 deleteStudent，解冻后 FIFO 会不查回执直接发，漏剔除 = 云端真把刘删掉）。
// 而在这份文件之前，全项目**没有任何测试引用过 PRUNE_WHITELIST / prunePlanOf / pruneApply**
// （grep 全零命中）—— 也就是说白名单是多少条、包里有没有那 23 条、会不会把该补发的删掉，
// 全靠人眼。这里把它钉死。
//
// 铁律照旧：
//   · 不手搓队列桶 —— 桶由**真的** utils/local-outbox 写（`enqueue` / `patch` 走它自己的写后回读校验）；
//   · 判定用**真的**页面模块（require 真文件），不重新实现一份；
//   · 断言"删对了"必须同时断言"没删错"（leaked / lostOthers / 逐条比对）。
const assert = require('assert')
const path = require('path')
const ROOT = path.join(__dirname, '..')

// ═══ 替身 wx：只提供 Storage，其余一概没有（剔除**不需要**任何云端调用，这个替身证明了这一点）═══
const storage = new Map()
let cloudCalls = 0
global.Page = () => {}
global.getApp = () => ({ globalData: {} })
global.wx = {
  getStorageSync: key => (storage.has(key) ? JSON.parse(storage.get(key)) : ''),
  setStorageSync: (key, value) => { storage.set(key, JSON.stringify(value)) },
  removeStorageSync: key => { storage.delete(key) },
  showToast: () => {}, showModal: () => {}, showLoading: () => {}, hideLoading: () => {},
  setClipboardData: () => {},
  cloud: { callFunction: async () => { cloudCalls += 1; throw new Error('剔除全程不得调用云函数') } }
}

const outbox = require(path.join(ROOT, 'utils/local-outbox'))
const guard = require(path.join(ROOT, 'utils/production-recovery-guard'))
const page = require(path.join(ROOT, 'pkg-diag/repair-orphan-tombstone/repair-orphan-tombstone.js'))

const { PRUNE_WHITELIST, prunePlanOf, pruneApply, pruneRollback, OUTBOX_KEY, PRUNE_KEY } = page
const SCOPE = { environment: 'production', datasetId: 'candidate_test_dataset' }
const snapshot = key => storage.get(key)

// ═══ 台账（B 类「保留并补发」16 条）—— 剔除清单**绝不许**与之相交 ═══
// 12 条在恢复计划里有完整 entryId；4 个自定义动作当时只记到 token（`ob_2b` / `ob_2d` / `ob_2f` / `ob_2j`），
// 所以这里对它们用 token 前缀比对（entryId 形状固定是 `ob_<token>_<6位>`，token 唯一）。
const REPLAY_IDS = [
  'ob_29_l5cmqb', 'ob_30_yw8bqq',                                    // 诸葛逍遥 完课 → 改期（依赖部署的 handlers.js:388）
  'ob_2a_bhku2v', 'ob_2y_ck5tc2', 'ob_2z_uhltdy',                    // 袁梦琪 改期 → 内容 → 完课
  'ob_2l_jl9mja', 'ob_2m_i35al3',                                    // 司马赞奇 内容 → 完课
  'ob_41_vo3utf', 'ob_42_kpqcmc', 'ob_43_r7a5sq',                    // 3 条新预约
  'ob_44_jdmp2o',                                                    // 司马赞奇 09-22 18:00
  'ob_2_i4g811'                                                      // 莹子 09-22 17:00（电脑侧那条）
]
const REPLAY_TOKENS = ['2b', '2d', '2f', '2j']                        // 4 个自定义动作

// ═══ 造一条**由真 local-outbox 写出**的队列条目，只把 entryId 改成台账里那个号 ═══
function seedEntry({ command, payload, requestId, entryId }) {
  const created = outbox.enqueue(SCOPE, { command, payload, requestId, entityKey: command })
  assert.strictEqual(created.created, true, '夹具：入队失败 ' + requestId)
  const generated = created.entry.entryId
  if (generated !== entryId) {
    outbox.patch(SCOPE, generated, { entryId })
    assert.ok(outbox.entryById(SCOPE, entryId), '夹具：entryId 改写失败 ' + entryId)
    assert.strictEqual(outbox.entryById(SCOPE, generated), null, '夹具：旧 entryId 没清掉')
  }
  return outbox.entryById(SCOPE, entryId)
}
const idsInQueue = () => outbox.list(SCOPE).map(entry => entry.entryId)
const reset = () => {
  storage.clear()
  cloudCalls = 0
  try { guard.exit() } catch (error) { /* 忽略 */ }
}

const failures = []
async function test(name, fn) {
  reset()
  try { await fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { failures.push(name); process.stderr.write(`FAIL ${name}: ${error.message}\n${error.stack}\n`) }
}

;(async () => {
  // ════════════════════════════════════════════════════════════════
  // ① 白名单契约：23 条 = 手机 22 + 电脑 1，且与「补发 16」零交集
  // ════════════════════════════════════════════════════════════════
  await test('白名单契约：恰好 23 条（手机 22 + 电脑 1）、id 唯一、形状合法、理由非空', async () => {
    assert.strictEqual(PRUNE_WHITELIST.length, 23, '白名单必须恰好 23 条')
    const ids = PRUNE_WHITELIST.map(item => item.id)
    assert.strictEqual(new Set(ids).size, 23, 'entryId 不许重复')
    ids.forEach(id => assert.ok(/^ob_[0-9a-z]+_[0-9a-z]+$/.test(id), 'entryId 形状不对：' + id))
    PRUNE_WHITELIST.forEach(item => {
      assert.ok(['phone', 'pc'].includes(item.device), 'device 只能是 phone / pc：' + item.id)
      assert.ok(typeof item.why === 'string' && item.why.length >= 6, '每条都要有可读依据：' + item.id)
    })
    const byDevice = PRUNE_WHITELIST.reduce((acc, item) => { acc[item.device] = (acc[item.device] || 0) + 1; return acc }, {})
    assert.deepStrictEqual(byDevice, { phone: 22, pc: 1 }, '台账：手机 22 + 电脑 1')
  })

  await test('白名单必须含 ob_3p_uxob42（刘的 deleteStudent）—— 漏它 = 解冻后误删真实数据', async () => {
    const target = PRUNE_WHITELIST.find(item => item.id === 'ob_3p_uxob42')
    assert.ok(target, '★ ob_3p_uxob42 不在剔除白名单里 —— 解冻后 FIFO 会直接把它发出去，云端真删刘并撤销其 ¥1200 销售')
    assert.strictEqual(target.device, 'phone', '它在手机侧队列里')
    assert.ok(target.why.includes('不删'), '理由必须写明「用户改判不删」')
  })

  await test('白名单与「补发 16」零交集（含 4 个自定义动作的 token 前缀）', async () => {
    const ids = PRUNE_WHITELIST.map(item => item.id)
    const clash = ids.filter(id => REPLAY_IDS.includes(id))
    assert.deepStrictEqual(clash, [], '★ 这些 entryId 既在剔除又在补发：' + clash.join(' / '))
    const prefixClash = ids.filter(id => REPLAY_TOKENS.some(token => id.startsWith('ob_' + token + '_')))
    assert.deepStrictEqual(prefixClash, [], '★ 这些 entryId 落在补发的自定义动作 token 上：' + prefixClash.join(' / '))
    // 台账账平：23 + 16 = 39 条「非永久」条目，另一台设备上的那 1 条补发（ob_2_i4g811）也在 16 里
    assert.strictEqual(REPLAY_IDS.length + REPLAY_TOKENS.length, 16, '补发台账必须仍是 16 条')
  })

  // ════════════════════════════════════════════════════════════════
  // ② prunePlanOf：纯函数，只认白名单 id，绝不误命中
  // ════════════════════════════════════════════════════════════════
  await test('prunePlanOf：只命中白名单 id；真实业务条目一条都不命中', async () => {
    seedEntry({ command: 'deleteStudent', payload: { studentId: 'mt_liu' }, requestId: 'req-liu', entryId: 'ob_3p_uxob42' })
    seedEntry({ command: 'createBooking', payload: { studentId: 'mt_ying' }, requestId: 'req-ying', entryId: 'ob_2_i4g811' })
    seedEntry({ command: 'createBooking', payload: { studentId: 'mt_qita' }, requestId: 'req-qita', entryId: 'ob_9_zzzzzz' })
    const plan = prunePlanOf({ entries: outbox.list(SCOPE) }, PRUNE_WHITELIST)
    assert.strictEqual(plan.total, 3)
    assert.strictEqual(plan.target, 23)
    assert.strictEqual(plan.hit, 1)
    assert.deepStrictEqual(plan.hitList.map(item => item.entryId), ['ob_3p_uxob42'])
    assert.strictEqual(plan.notFound, 22)
    assert.strictEqual(plan.remain, 2)
    assert.strictEqual(plan.expectRemain, 2)
    assert.strictEqual(plan.hitList[0].command, 'deleteStudent')
    assert.strictEqual(plan.hitList[0].device, 'phone')
  })

  await test('prunePlanOf：命中清单按时间排序，且带得动 why/device 供人复核', async () => {
    seedEntry({ command: 'createBooking', payload: { a: 1 }, requestId: 'r1', entryId: 'ob_40_xeaoyf' })
    seedEntry({ command: 'createBooking', payload: { a: 2 }, requestId: 'r2', entryId: 'ob_3v_mt7gtn' })
    outbox.patch(SCOPE, 'ob_40_xeaoyf', { createdAt: 200 })
    outbox.patch(SCOPE, 'ob_3v_mt7gtn', { createdAt: 100 })
    const plan = prunePlanOf({ entries: outbox.list(SCOPE) }, PRUNE_WHITELIST)
    assert.deepStrictEqual(plan.hitList.map(item => item.entryId), ['ob_3v_mt7gtn', 'ob_40_xeaoyf'])
    assert.ok(plan.hitList[0].at && plan.hitList[0].why && plan.hitList[0].device, '复核三件套必须齐全')
  })

  await test('prunePlanOf：空桶 / 畸形输入不崩（不发命令、不写入）', async () => {
    assert.strictEqual(prunePlanOf(null, PRUNE_WHITELIST).hit, 0)
    assert.strictEqual(prunePlanOf({ entries: null }, PRUNE_WHITELIST).total, 0)
    assert.strictEqual(prunePlanOf({ entries: [] }, []).target, 0)
  })

  // ════════════════════════════════════════════════════════════════
  // ③ 预演（preview）必须是**一个字都不写**
  // ════════════════════════════════════════════════════════════════
  await test('preview：预演全程零写入、零云调用（用 Storage 逐字节快照对照）', async () => {
    seedEntry({ command: 'deleteStudent', payload: { s: 1 }, requestId: 'r1', entryId: 'ob_3p_uxob42' })
    seedEntry({ command: 'createBooking', payload: { s: 2 }, requestId: 'r2', entryId: 'ob_2_i4g811' })
    const before = snapshot(OUTBOX_KEY)
    const result = pruneApply(false)
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.mode, 'preview')
    assert.strictEqual(result.plan.hit, 1)
    assert.strictEqual(snapshot(OUTBOX_KEY), before, '★ 预演写了 Storage')
    assert.strictEqual(snapshot(PRUNE_KEY), undefined, '预演不得落备份（备份是执行时才写）')
    assert.strictEqual(cloudCalls, 0, '剔除不得调用云函数')
  })

  // ════════════════════════════════════════════════════════════════
  // ④ 冻结闸：未冻结 → 拒绝，且队列一个字没动
  // ════════════════════════════════════════════════════════════════
  await test('未冻结：执行被拒（NOT_FROZEN），队列逐字节未动、备份不落盘', async () => {
    seedEntry({ command: 'deleteStudent', payload: { s: 1 }, requestId: 'r1', entryId: 'ob_3p_uxob42' })
    const before = snapshot(OUTBOX_KEY)
    const result = pruneApply(true)
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.mode, 'blocked')
    assert.strictEqual(result.code, 'NOT_FROZEN')
    assert.strictEqual(result.frozen, false)
    assert.strictEqual(snapshot(OUTBOX_KEY), before, '★ 未冻结却动了队列')
    assert.strictEqual(snapshot(PRUNE_KEY), undefined, '未冻结不得落备份')
  })

  await test('未冻结：回滚同样被拒（NOT_FROZEN）', async () => {
    storage.set(PRUNE_KEY, JSON.stringify({ at: 1, bucket: { version: 1, seq: 0, entries: [], idMap: {}, failed: [], batches: {} } }))
    const result = pruneRollback()
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'NOT_FROZEN')
  })

  // ════════════════════════════════════════════════════════════════
  // ⑤ 快乐路径：冻结下执行 —— 只删白名单命中的，**其余逐条原样**
  // ════════════════════════════════════════════════════════════════
  await test('冻结下执行：删掉命中的，保留全部真实业务条目（含电脑侧那条补发）', async () => {
    seedEntry({ command: 'deleteStudent', payload: { studentId: 'mt_liu' }, requestId: 'req-liu', entryId: 'ob_3p_uxob42' })
    seedEntry({ command: 'createStudent', payload: { name: '孕妇' }, requestId: 'req-yf', entryId: 'ob_3w_om2y3u' })
    seedEntry({ command: 'createBooking', payload: { studentId: 'mt_ying' }, requestId: 'req-ying', entryId: 'ob_2_i4g811' })
    seedEntry({ command: 'completeBooking', payload: { bookingId: 'booking_zhuge' }, requestId: 'req-zhuge', entryId: 'ob_29_l5cmqb' })
    const keepBefore = ['ob_2_i4g811', 'ob_29_l5cmqb'].map(id => JSON.stringify(outbox.entryById(SCOPE, id)))

    guard.enter()                                        // 立起整面冻结（arm + enter）
    const result = pruneApply(true)

    assert.strictEqual(result.ok, true, '剔除未通过：' + (result.code || '') + ' ' + (result.message || ''))
    assert.strictEqual(result.mode, 'commit')
    assert.strictEqual(result.frozen, true)
    assert.deepStrictEqual(result.removed.slice().sort(), ['ob_3p_uxob42', 'ob_3w_om2y3u'])
    assert.deepStrictEqual(result.failed, [])
    assert.deepStrictEqual(result.leaked, [], '白名单条目没删净')
    assert.deepStrictEqual(result.lostOthers, [], '★ 非白名单条目被误删')
    assert.strictEqual(result.remain, 2)
    assert.strictEqual(result.expectRemain, 2)

    const after = idsInQueue().sort()
    assert.deepStrictEqual(after, ['ob_29_l5cmqb', 'ob_2_i4g811'], '★ 队列里剩下的必须是那两条真实业务')
    // 保留的两条**逐字节**没变（不是"还在"就行）
    assert.deepStrictEqual(['ob_2_i4g811', 'ob_29_l5cmqb'].map(id => JSON.stringify(outbox.entryById(SCOPE, id))), keepBefore)
    assert.strictEqual(cloudCalls, 0, '剔除不得调用云函数')
  })

  await test('执行：整桶备份落盘且可回读（条数一致），否则中止', async () => {
    seedEntry({ command: 'deleteStudent', payload: { s: 1 }, requestId: 'r1', entryId: 'ob_3p_uxob42' })
    guard.enter()
    const result = pruneApply(true)
    assert.strictEqual(result.ok, true)
    const backup = JSON.parse(storage.get(PRUNE_KEY))
    assert.strictEqual(backup.scopeKey, OUTBOX_KEY)
    assert.strictEqual(backup.bucket.entries.length, 1, '备份必须是执行前那份桶')
    assert.strictEqual(backup.bucket.entries[0].entryId, 'ob_3p_uxob42')
    assert.strictEqual(backup.plan.hit, 1)
  })

  // ════════════════════════════════════════════════════════════════
  // ⑥ 对照实验：让 remove() 多删一条 ⇒ ok 必须变 false 且 lostOthers 非空
  // ════════════════════════════════════════════════════════════════
  await test('对照实验：误删了非白名单条目时，结果必须 ok:false 且如实报出 lostOthers', async () => {
    seedEntry({ command: 'deleteStudent', payload: { s: 1 }, requestId: 'r1', entryId: 'ob_3p_uxob42' })
    seedEntry({ command: 'createBooking', payload: { s: 2 }, requestId: 'r2', entryId: 'ob_2_i4g811' })
    guard.enter()

    const realRemove = outbox.remove
    // 模拟一个"看着对、其实删多了"的实现：删白名单那条时顺手把下一条也删了。
    outbox.remove = (scope, entryId) => {
      const result = realRemove(scope, entryId)
      if (entryId === 'ob_3p_uxob42') realRemove(scope, 'ob_2_i4g811')
      return result
    }
    let result
    try { result = pruneApply(true) } finally { outbox.remove = realRemove }

    assert.strictEqual(result.ok, false, '★ 误删了真实业务条目却报成功')
    assert.deepStrictEqual(result.lostOthers, ['ob_2_i4g811'], '必须点名被误删的条目')
    assert.strictEqual(result.remain, 0)
    assert.notStrictEqual(result.remain, result.expectRemain)
  })

  await test('对照实验：白名单条目没删干净时，结果必须 ok:false 且如实报出 leaked', async () => {
    seedEntry({ command: 'deleteStudent', payload: { s: 1 }, requestId: 'r1', entryId: 'ob_3p_uxob42' })
    guard.enter()
    const realRemove = outbox.remove
    outbox.remove = () => false                       // 模拟"删了但没落盘"
    let result
    try { result = pruneApply(true) } finally { outbox.remove = realRemove }
    assert.strictEqual(result.ok, false, '★ 没删净却报成功')
    assert.deepStrictEqual(result.leaked, ['ob_3p_uxob42'])
    assert.deepStrictEqual(result.failed, [{ entryId: 'ob_3p_uxob42', code: 'STILL_PRESENT' }])
  })

  // ════════════════════════════════════════════════════════════════
  // ⑦ 回滚：整桶写回，逐条一致（含 version / seq / idMap / failed）
  // ════════════════════════════════════════════════════════════════
  await test('回滚：把队列恢复成剔除前逐条一致的样子', async () => {
    seedEntry({ command: 'deleteStudent', payload: { s: 1 }, requestId: 'r1', entryId: 'ob_3p_uxob42' })
    seedEntry({ command: 'createBooking', payload: { s: 2 }, requestId: 'r2', entryId: 'ob_2_i4g811' })
    // 顺带带上 idMap，验证"整桶回滚"连 idMap 一起回到原样（本机临时 id 前缀是 loc_）
    outbox.recordIdMap(SCOPE, { loc_booking_test0001: 'booking_real_1' })
    const before = JSON.parse(snapshot(OUTBOX_KEY))
    assert.deepStrictEqual(before.idMap, { loc_booking_test0001: 'booking_real_1' }, '夹具：idMap 没写进去')
    guard.enter()
    const pruned = pruneApply(true)
    assert.strictEqual(pruned.ok, true)
    assert.strictEqual(idsInQueue().length, 1)

    const rolled = pruneRollback()
    assert.strictEqual(rolled.ok, true, '回滚失败：' + (rolled.code || ''))
    assert.strictEqual(rolled.code, 'RESTORED')
    assert.strictEqual(rolled.restored, 2)
    const after = JSON.parse(snapshot(OUTBOX_KEY))
    assert.deepStrictEqual(after.entries.map(entry => entry.entryId).sort(), before.entries.map(entry => entry.entryId).sort())
    assert.deepStrictEqual(after.idMap, before.idMap, 'idMap 也必须回到原样')
    assert.strictEqual(after.seq, before.seq)
  })

  await test('回滚：没有备份时拒绝，且不动队列', async () => {
    seedEntry({ command: 'deleteStudent', payload: { s: 1 }, requestId: 'r1', entryId: 'ob_3p_uxob42' })
    guard.enter()
    const before = snapshot(OUTBOX_KEY)
    const result = pruneRollback()
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'NO_BACKUP')
    assert.strictEqual(snapshot(OUTBOX_KEY), before)
  })

  // ════════════════════════════════════════════════════════════════
  // ⑧ 电脑侧真现场的形状：这台设备只该命中 1 条（ob_1_2n9mnp）
  // ════════════════════════════════════════════════════════════════
  await test('电脑侧真现场形状：队列 2 条时只命中 ob_1_2n9mnp，另一条（莹子补发）必须留下', async () => {
    // 形状照 2026-09-22 21:23 从本机 Storage 只读读回的真队列（entryId / command / payload 逐字一致）
    seedEntry({ command: 'createBooking', payload: { studentId: 'mtfe64ce5l0wwn', packageId: 'mthcl6gmkl9nng', date: '2026-09-22', hour: 20, minute: 0 }, requestId: 'req_pc_1', entryId: 'ob_1_2n9mnp' })
    seedEntry({ command: 'createBooking', payload: { studentId: 'mtfe8z81wigk7d', packageId: 'mthcl6gmf5oyiq', date: '2026-09-22', hour: 17, minute: 0 }, requestId: 'req_pc_2', entryId: 'ob_2_i4g811' })
    const plan = pruneApply(false)
    assert.strictEqual(plan.mode, 'preview')
    assert.strictEqual(plan.plan.hit, 1)
    assert.deepStrictEqual(plan.plan.hitList.map(item => item.entryId), ['ob_1_2n9mnp'])
    assert.strictEqual(plan.plan.hitList[0].device, 'pc')
    assert.strictEqual(plan.plan.notFound, 22, '其余 22 条属于手机，本机必然未命中')
    assert.strictEqual(plan.plan.remain, 1)

    guard.enter()
    const committed = pruneApply(true)
    assert.strictEqual(committed.ok, true)
    assert.deepStrictEqual(idsInQueue(), ['ob_2_i4g811'], '★ 电脑侧剔除后必须只剩莹子那条待补发')
    assert.strictEqual(cloudCalls, 0)
  })

  if (failures.length) { process.stderr.write(`\n${failures.length} 项失败：${failures.join(' / ')}\n`); process.exitCode = 1 } else { process.stdout.write('ALL REPAIR PRUNE PAGE TESTS PASSED\n') }
})()
