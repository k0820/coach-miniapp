// 写命令之后"带回来的东西"与页面 onShow 那次刷新的合并口径（1.1.9 第 6 轮重写）。
//
// 修前：命令成功 → **无条件**做一次完整分页回读，页面 onShow 复用它 ⇒ 一次写入 = 恰好一次完整读取。
// 修后：命令成功 → 先做**一跳只读校验**（confirmAfterWrite）。于是有两种形状，本文件把两种都钉住：
//   A. 校验通过  → 命令后**零完整读取**；这时在飞的 onShow **不能**复用那一跳校验
//      （它没有 snapshot，复用等于把"没有数据"当成最新数据交给页面），必须自己做一次完整读取。
//   B. 校验不过  → 退回完整分页回读（安全兜底）；这时在飞的 onShow 仍然复用它，不多读一次。
//   C. 兜底也失败 → refreshFailed 如实带出、命令绝不重发、onShow 各自独立重试一次。
const assert = require('assert')
const { buildCandidateDataset } = require('../utils/candidate-dataset')
const { createAdapter } = require('../utils/cloud-primary-adapter')

const snapshot = { students: [], bookings: [], incomes: [], sales: [], settings: { renewThreshold: 3, monthlyGoalSessions: 20, classCommissionRate: 0, salesCommissionRate: 0 }, customExercises: [] }
const built = buildCandidateDataset(snapshot, { trustedOwnerCoachId: 'fake-owner', trustedDatasetId: 'fake-dataset' })
const names = { students: 'students', studentTombstones: 'student_tombstones', packages: 'packages', bookings: 'bookings', incomes: 'incomes', sales: 'sales', settings: 'settings', customExercises: 'customExercises' }

function pagePayload(data) {
  const logical = Object.keys(names).find(key => names[key] === data.collection), rows = built.collections[logical]
  return { ok: true, nextCursor: rows.length, nextFragmentIndex: 0, done: true, encoding: 'base64-json', payload: Buffer.from(JSON.stringify(rows), 'utf8').toString('base64') }
}

async function run() {
  // ---------------------------------------------------------------- A. 轻量校验通过：命令后零完整读取
  let revision = 0, fullReads = 0, pageCalls = 0, confirmCalls = 0, changeCalls = 0, releaseCommand, reachedCommand
  const entered = new Promise(resolve => { reachedCommand = resolve })
  const blocked = new Promise(resolve => { releaseCommand = resolve })
  const cache = {}
  const adapter = createAdapter({ environment: () => 'sandbox', storage: { get: key => cache[key], set: (key, value) => { cache[key] = value } }, callCloud: async (name, data) => {
    if (name === 'coachBusinessCommand') { reachedCommand(); await blocked; revision++; return { ok: true, datasetRevision: revision, result: {} } }
    // ⚠️ 1.1.9 第 15 轮：后台轮次也先试 `changes`。本假件是"没有收据的纯只读世界"，
    //    所以它**如实**按"云函数还是旧版本/拿不到变更集"回退（INVALID_ACTION）——
    //    这是产品里明确支持的形状。⚠️ 它绝不能掉进下面的 pageCalls 分支：
    //    那一跳不是分页，混进去会让"翻了几页"这个判据失真。
    if (data.action === 'changes') { changeCalls++; return { ok: false, code: 'INVALID_ACTION' } }
    if (data.action === 'integrity') { confirmCalls++; return { ok: true, environment: 'sandbox', datasetId: 'fake-dataset', dataRevision: revision, ...built.integrity } }
    if (data.action === 'metadata') { fullReads++; return { ok: true, environment: 'sandbox', datasetId: 'fake-dataset', dataRevision: revision, collections: Object.values(names) } }
    pageCalls++
    return pagePayload(data)
  } })
  assert.equal((await adapter.readActive()).ok, true)
  const readsBefore = fullReads, pagesBefore = pageCalls, confirmsBefore = confirmCalls
  const write = adapter.execute('saveSettings', {}, { requestId: 'coalesce_test_001' })
  await entered
  // schedule.onShow 在同一时刻也要刷新：它**不能**复用那一跳没有 snapshot 的校验。
  const onShow = adapter.readActive()
  releaseCommand()
  const [saved, shown] = await Promise.all([write, onShow])
  assert.equal(saved.ok, true)
  assert.equal(saved.confirmed && saved.confirmed.ok, true, '命令成功后必须给出那一跳只读校验的确认结果')
  assert.equal(saved.confirmed.lightweight, true)
  assert.equal(saved.confirmed.revision, 1, '确认结果里的 revision 必须是云端那一版')
  assert.equal(saved.refreshed, undefined, '★ 轻量确认成功时**不许**出现 refreshed —— 它的含义是"本机 cache 已跟上"，冒充会让页面照旧 cache 渲染')
  assert.equal(fullReads - readsBefore, 1, '★ 命令成功后不得再翻分页：多出来的那一次完整读取只能是 onShow 自己那一次')
  assert.equal(pageCalls - pagesBefore, 8, '★ 命令成功后一页都不许翻（8 个集合各一页，全部属于 onShow 那一次读取）')
  // ⚠️ 1.1.9 第 15 轮：onShow 那一轮先试了一跳 `changes`（本假件如实回退）⇒ 原本"读前的
  //    integrity 首跳"被它取代了 ⇒ 这一段的 integrity = 写入确认 1 次 + onShow 完整读取末尾 1 次 = 2。
  //   判据的**含义没变**：写入那一跳确认只有 1 次、onShow 的完整读取只有末尾那一次校验。
  assert.equal(confirmCalls - confirmsBefore, 2, '这一段的 integrity 调用 = 写入那一跳确认 1 次 + onShow 自己那次读取末尾 1 次')
  assert.equal(changeCalls, 1, '★ onShow 那一轮必须先试一跳 changes（不是一上来就翻 8 个集合）')
  assert.equal(shown.ok, true)
  assert.equal(shown.revision, 1)
  assert.ok(shown.snapshot, 'onShow 必须自己拿到一份**带 snapshot** 的完整结果')
  console.log('A 轻量确认：命令后零完整读取 / onShow 自己读一次 PASS')

  // ---------------------------------------------------------------- B. 轻量校验不过 ⇒ 退回完整回读，onShow 复用它
  // ⚠️ 闸门必须**先不武装**：本段开头那次基线读取自己也会走 metadata，
  //    若一上来就 await blocked2，基线读取当场卡死、后面开闸的代码永远轮不到执行
  //    ⇒ 进程静默饿死（exit 0 + 输出截断），这正是本文件上一版的老毛病。
  //    「用闸门造确定性窗口」的前提是：闸门只罩住你要观测的那一次调用。
  let revision2 = 0, fullReads2 = 0, failConfirm = false, metadataEntered, releaseMetadata, armGate2 = false
  const entered2 = new Promise(resolve => { metadataEntered = resolve })
  const blocked2 = new Promise(resolve => { releaseMetadata = resolve })
  const cache2 = {}
  const fallbackAdapter = createAdapter({ environment: () => 'sandbox', storage: { get: key => cache2[key], set: (key, value) => { cache2[key] = value } }, callCloud: async (name, data) => {
    if (name === 'coachBusinessCommand') { revision2++; return { ok: true, datasetRevision: revision2, result: {} } }
    if (data.action === 'integrity') {
      // 只让**那一跳确认**判不过（云端还停在命令提交前的版本）；之后恢复真实值。
      if (failConfirm) { failConfirm = false; return { ok: true, environment: 'sandbox', datasetId: 'fake-dataset', dataRevision: 0, ...built.integrity } }
      return { ok: true, environment: 'sandbox', datasetId: 'fake-dataset', dataRevision: revision2, ...built.integrity }
    }
    if (data.action === 'metadata') { fullReads2++; if (armGate2) { metadataEntered(); await blocked2 } return { ok: true, environment: 'sandbox', datasetId: 'fake-dataset', dataRevision: revision2, collections: Object.values(names) } }
    return pagePayload(data)
  } })
  assert.equal((await fallbackAdapter.readActive()).ok, true)
  const fullBefore = fullReads2
  // 基线读取已经过去，现在才武装闸门：接下来唯一会撞上 metadata 的就是**兜底那次完整回读**。
  armGate2 = true
  failConfirm = true
  const fallbackWrite = fallbackAdapter.execute('saveSettings', {}, { requestId: 'coalesce_test_002' })
  await entered2
  const overlapping = fallbackAdapter.readActive()
  releaseMetadata()
  const [fell, reused] = await Promise.all([fallbackWrite, overlapping])
  assert.equal(fell.ok, true)
  assert.equal(fell.confirmed, undefined, '校验不过时不能给出轻量确认')
  assert.equal(fell.refreshed && fell.refreshed.ok, true, '校验不过必须退回完整回读，并把它的结果如实交出来')
  assert.equal(fell.refreshed.confirmFallback, 'WRITE_CONFIRM_REVISION_NOT_REACHED', '必须如实报出是哪一种校验不过')
  assert.equal(reused.ok, true)
  assert.equal(fullReads2 - fullBefore, 1, '★ 兜底那次完整回读必须被在飞的 onShow 复用，不能读第二遍')
  console.log('B 校验不过 → 安全兜底完整回读（且被 onShow 复用）PASS')

  // ---------------------------------------------------------------- C. 兜底也失败：refreshFailed 如实带出，命令绝不重发
  let revision3 = 0, commands3 = 0, brokenMetadata = 0, goodMetadata = 0, failConfirm3 = true, breakFullRead = false
  const cache3 = {}
  const retryAdapter = createAdapter({ environment: () => 'sandbox', storage: { get: key => cache3[key], set: (key, value) => { cache3[key] = value } }, callCloud: async (name, data) => {
    if (name === 'coachBusinessCommand') { commands3++; revision3++; return { ok: true, datasetRevision: revision3, result: {} } }
    if (data.action === 'integrity') {
      if (failConfirm3) { failConfirm3 = false; return { ok: true, environment: 'sandbox', datasetId: 'fake-dataset', dataRevision: 0, ...built.integrity } }
      return { ok: true, environment: 'sandbox', datasetId: 'fake-dataset', dataRevision: revision3, ...built.integrity }
    }
    if (data.action === 'metadata') {
      if (breakFullRead) { brokenMetadata++; return { ok: false, code: 'READ_TEMPORARILY_FAILED' } }
      goodMetadata++
      return { ok: true, environment: 'sandbox', datasetId: 'fake-dataset', dataRevision: revision3, collections: Object.values(names) }
    }
    return pagePayload(data)
  } })
  assert.equal((await retryAdapter.readActive()).ok, true)
  failConfirm3 = true
  breakFullRead = true
  const thirdWrite = await retryAdapter.execute('saveSettings', {}, { requestId: 'coalesce_test_003' })
  assert.equal(thirdWrite.ok, true, '命令本身已经提交成功，绝不能被回读失败否定')
  assert.equal(thirdWrite.refreshed, undefined)
  // 兜底也失败时，这一轮的产物是 `refreshFailed`（不是 refreshed）—— 「走了哪条路、为什么」
  // 这三个只读诊断字段跟着**那一轮的产物**走，所以它在 refreshFailed 里，不在顶层。
  assert.equal(thirdWrite.refreshFailed.confirmFallback, 'WRITE_CONFIRM_REVISION_NOT_REACHED')
  assert.equal(thirdWrite.refreshFailed.code, 'READ_TEMPORARILY_FAILED', '兜底完整回读失败必须如实带出来')
  assert.equal(commands3, 1, '★ 回读失败绝不能变成"重发命令"')
  assert.equal(brokenMetadata, 1, '兜底那次完整回读失败一次就如实返回，绝不原地打转')
  // 页面各自独立重试：回读恢复后 onShow 照旧能拿到一份完整快照（命令不会被重发第二次）。
  breakFullRead = false
  const retryRead = await retryAdapter.readActive()
  assert.equal(retryRead.ok, true)
  assert.equal(retryRead.revision, 1)
  assert.equal(goodMetadata, 2, '初始那一次 + onShow 这一次')
  assert.equal(commands3, 1)
  console.log('C 兜底失败 → refreshFailed 如实带出 / 命令不重发 PASS')
  console.log('post-write confirm / onShow coalescing PASS')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
