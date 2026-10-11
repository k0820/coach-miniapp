// 【永久回归】动作库必须「点了立刻生效」，且**永远不再**出现同步提示 / 遮罩 / 黑屏。
//
// 这个文件对应一个真实真机故障（2026-09-18）：
//   点「添加动作」时弹出「结果待确认 · 动作库操作结果正在确认中，稍后可在动作库查看」，
//   同时整屏出现黑色遮罩，动作**没有**像以前那样被直接加入。
// 根因不是文案，而是：动作库在当时还是「云端先行」——命令走 runCommandSilent → adapter.execute，
// 一旦结果未知就弹模态框，并且 onSuccess（真正把动作加进去的那一步）**根本不会执行**。
//
// 因此本文件钉死的不是字符串，而是**交互契约**：
//   ① 点击后第一帧本机立即生效（动作已可被使用）；
//   ② 不出现「结果待确认」；不出现「正在保存」；不出现 showLoading；不出现任何模态遮罩；
//   ③ 不等 Cloud —— 云端延迟 5 秒、甚至断网，本机动作库照常可用；
//   ④ 断网 + 杀进程 + 重开：队列还在、号不变，恢复网络后云端恰好一条（不重复、不丢）；
//   ⑤ 删除动作不得因此产生孤儿训练记录。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createWorld, loadExercisePicker, loadSessionPage, settle, delay, PROJ } = require('./helpers/local-first-world')

const ACT = '阶段二测试动作'
const ACT2 = '阶段二测试动作·改名'

// ---------------------------------------------------------------- ① 静态契约
// 钉「契约」而不是「拼写」：这三个字面量本身就代表旧交互，必须从源码里彻底消失。
const pickerSource = fs.readFileSync(path.join(PROJ, 'components', 'exercise-picker', 'exercise-picker.js'), 'utf8')
assert.equal(pickerSource.includes('结果待确认'), false, '动作库不得再出现「结果待确认」')
assert.equal(pickerSource.includes('正在保存'), false, '动作库不得再出现「正在保存」')
assert.equal(pickerSource.includes('showLoading'), false, '动作库不得出现全屏 loading')
assert.equal(/\brunCommand(Silent)?\s*\(/.test(pickerSource), false, '动作库不得直连运行期命令通道')
assert.ok(pickerSource.includes("require('../../utils/mutate')"), '动作库必须接入统一写入口')
// 成功之后必须真的把界面更新掉（刷新列表 + 立刻把动作回填给当前课程）——
// 旧实现的失败模式正是"命令没 ok 就永远不执行这一步"。
assert.ok(pickerSource.includes('this.refresh()'), '动作库成功后必须刷新列表')
assert.ok(pickerSource.includes("triggerEvent('choose'"), '动作库成功后必须立刻可被使用')

// ---------------------------------------------------------------- ② 第一帧生效
async function scenarioFirstFrame() {
  const world = createWorld()
  world.seed({ students: [], bookings: [], incomes: [], sales: [], settings: {}, customExercises: [] })
  const picker = loadExercisePicker()
  const mutate = require('../utils/mutate')
  const sync = require('../utils/sync-engine')

  picker.setData({ customValue: ACT, customGroup: '肩' })
  const started = Date.now()
  const result = await picker.addCustom()
  const elapsed = Date.now() - started

  assert.strictEqual(result.ok, true, '动作库新建必须成功返回')
  assert.strictEqual(result.path, mutate.PATHS.LOCAL_FIRST, '动作库新建必须走本机先行')
  assert.strictEqual(result.applied, true, '动作库新建必须已经在本机投影里生效')
  assert.ok(world.localDB().customExercises.some(item => item.name === ACT), '第一帧本机动作库里就该有这个动作')
  assert.equal(elapsed < 200, true, `第一帧必须是本机的速度（实测 ${elapsed}ms）`)
  assert.strictEqual(world.counters.loading, 0, '不得出现全屏 loading')
  assert.strictEqual(world.counters.modals.length, 0, '不得出现任何模态遮罩（黑屏的来源）')
  assert.ok(world.counters.toasts.some(t => String(t.title).includes('已加入')), '正常成功路径要有本机成功反馈')
  assert.strictEqual(world.counters.calls.length, 0, '这一刻云端还不该收到任何命令 —— 用户根本没有等它')
  assert.strictEqual(picker.events.choose.length, 1, '新动作必须立刻可被使用（直接回填到当前课程）')

  // 后台同步：云端最终必须与业务事实一致。
  await sync.flush()
  await settle()
  const cloud = world.snapshot()
  assert.strictEqual(cloud.customExercises.length, 1, '云端应恰好有一条')
  assert.strictEqual(cloud.customExercises[0].name, ACT)
  console.log('  ✓ 新建动作：第一帧本机生效、零遮罩、零等待，随后后台同步')
  return world
}

// ---------------------------------------------------------------- ③ 云端延迟 5 秒也不能阻塞
async function scenarioSlowCloud() {
  const world = createWorld()
  world.seed({ students: [], bookings: [], incomes: [], sales: [], settings: {}, customExercises: [] })
  const picker = loadExercisePicker()
  const mutate = require('../utils/mutate')
  world.latency = 5000

  picker.setData({ customValue: ACT, customGroup: '肩' })
  const started = Date.now()
  const result = await picker.addCustom()
  const elapsed = Date.now() - started

  assert.strictEqual(result.ok, true)
  assert.equal(elapsed < 200, true, `云端慢 5 秒，本机仍是第一帧（实测 ${elapsed}ms）`)
  assert.ok(world.localDB().customExercises.some(item => item.name === ACT), '云端延迟期间本机动作立即可用')
  assert.strictEqual(world.counters.loading, 0)
  assert.strictEqual(world.counters.modals.length, 0)

  // 延迟期间立刻「马上使用」：这就是原来卡住的那一步。
  const page = loadSessionPage()
  page.id = 'booking-slow'
  page.data.booking = { id: 'booking-slow' }
  page.setData({ items: [] })
  page.addExercise({ detail: { name: ACT, group: '肩' } })
  assert.strictEqual(page.data.items.length, 1, '云端延迟期间动作必须能直接用上')
  clearTimeout(page.draftTimer)

  world.cancelLatency()
  world.latency = 0
  await require('../utils/sync-engine').flush()
  await settle()
  assert.strictEqual(world.snapshot().customExercises.length, 1, '延迟结束后云端恰好一条')
  console.log('  ✓ 云端延迟 5 秒：本机动作库照常可用，不阻塞')
  return world
}

// ---------------------------------------------------------------- ④ 断网 → 杀进程 → 重开 → 恢复网络
async function scenarioOfflineRestart() {
  const world = createWorld()
  world.seed({ students: [], bookings: [], incomes: [], sales: [], settings: {}, customExercises: [] })
  let picker = loadExercisePicker()
  let mutate = require('../utils/mutate')
  world.online = false

  picker.setData({ customValue: ACT, customGroup: '肩' })
  const created = await picker.addCustom()
  assert.strictEqual(created.ok, true, '断网时新建动作也必须成功')
  assert.strictEqual(created.applied, true)
  const requestId = created.requestId
  assert.strictEqual(world.counters.calls.length, 0, '断网时不得有任何云端调用')

  // 断网期间还能改、还能马上用。
  picker.setData({ editingIndex: 0, customValue: ACT2, customGroup: '肩' })
  const edited = await picker.addCustom()
  assert.strictEqual(edited.ok, true, '断网时修改动作也必须成功')
  assert.ok(world.localDB().customExercises.some(item => item.name === ACT2), '断网时改完必须第一帧生效')

  const before = world.outboxEntries()
  assert.strictEqual(before.length, 2, `断网时应留下两条待同步（实测 ${before.length}）`)
  assert.ok(before.some(entry => entry.requestId === requestId), '入队的号必须稳定持久化')

  // —— 杀掉小程序再打开：只保留 Storage ——
  world.restartProcess()
  mutate = require('../utils/mutate')
  const sync = require('../utils/sync-engine')
  const after = world.outboxEntries()
  assert.strictEqual(after.length, 2, '重开后队列必须还在（用户的动作不能丢）')
  assert.ok(after.some(entry => entry.requestId === requestId), '重开后 requestId 不能变成新号 —— 否则就是盲目重发')
  assert.ok(world.localDB().customExercises.some(item => item.name === ACT2), '重开后本机数据仍在')

  // —— 恢复网络 ——
  world.online = true
  await sync.flush()
  await settle(60)
  const cloud = world.snapshot()
  assert.strictEqual(cloud.customExercises.length, 1, `恢复网络后云端必须恰好一条、且不重复（实测 ${cloud.customExercises.length}）`)
  assert.strictEqual(cloud.customExercises[0].name, ACT2, '云端必须是改名后的结果')
  assert.strictEqual(world.outboxEntries().length, 0, '同步完成后队列必须清空')
  console.log('  ✓ 断网 → 杀进程 → 重开 → 恢复网络：不丢、不重复、云端与本机一致')
  return world
}

// ---------------------------------------------------------------- ⑤ 连续：新建 → 马上使用 → 修改 → 马上再用 → 删除
async function scenarioContinuous() {
  const world = createWorld()
  world.seed({
    students: [], sales: [], settings: {}, customExercises: [],
    bookings: [{ id: 'booking-history', studentId: 'stu-1', studentName: '学员甲', packageId: 'pkg-1', date: '2026-09-10', hour: 10, minute: 0, typeName: '常规训练', price: 100, status: 'done', items: [{ name: ACT, group: '肩', sets: 4, reps: 12 }], category: '综合训练' }],
    incomes: [{ id: 'income-1', bookingId: 'booking-history', studentId: 'stu-1', studentName: '学员甲', typeName: '常规训练', category: '综合训练', amount: 100, date: '2026-09-10', time: '10:00' }]
  })
  const picker = loadExercisePicker()
  const mutate = require('../utils/mutate')
  const page = loadSessionPage()
  page.id = 'booking-live'
  page.data.booking = { id: 'booking-live' }
  page.setData({ items: [] })

  // ① 新建 → 马上使用
  picker.setData({ customValue: ACT, customGroup: '肩' })
  assert.strictEqual((await picker.addCustom()).ok, true)
  page.addExercise({ detail: { name: ACT, group: '肩' } })
  assert.strictEqual(page.data.items.length, 1, '新建后必须马上能用')
  clearTimeout(page.draftTimer)

  // ② 修改 → 马上再次使用
  picker.setData({ editingIndex: 0, customValue: ACT2, customGroup: '肩' })
  assert.strictEqual((await picker.addCustom()).ok, true)
  assert.ok(picker.data.sections.some(section => section.items.some(item => item.name === ACT2)), '改完必须第一帧出现在动作库里')
  page.addExercise({ detail: { name: ACT2, group: '肩' } })
  assert.strictEqual(page.data.items.length, 2, '改名后必须马上能再用')
  clearTimeout(page.draftTimer)

  // ③ 删除（确认框是用户确认，不是同步提示 —— 允许；遮罩类提示不允许）
  await picker.deleteCustom({ currentTarget: { dataset: { index: 0 } } })
  assert.equal(world.localDB().customExercises.length, 0, '删除必须第一帧生效')
  assert.strictEqual(world.counters.loading, 0, '全程不得出现全屏 loading')
  assert.strictEqual(world.counters.modals.filter(m => /待确认|正在保存|正在同步/.test(String(m.title))).length, 0, '全程不得出现同步类模态框')

  await require('../utils/sync-engine').flush()
  await settle(60)
  const cloud = world.snapshot()
  assert.strictEqual(cloud.customExercises.length, 0, '云端最终也必须删掉')
  // ④ 不得产生孤儿：已完成课程里的历史动作必须原样保留。
  const history = cloud.bookings.find(item => item.id === 'booking-history')
  assert.ok(history && history.items.some(item => item.name === ACT), '已完成课程里的历史动作不得被删除或改写')
  assert.strictEqual(cloud.incomes.length, 1, '删除动作不得影响收入事实')
  console.log('  ✓ 连续 新建→使用→改名→再用→删除：全程第一帧，且不产生孤儿记录')
  return world
}

// ---------------------------------------------------------------- ⑤b 本机先行不得因云端拒绝而留幻影
async function scenarioCloudRejects() {
  const world = createWorld()
  world.seed({ students: [], bookings: [], incomes: [], sales: [], settings: {}, customExercises: [] })
  const picker = loadExercisePicker()
  world.online = false
  picker.setData({ customValue: ACT, customGroup: '肩' })
  assert.strictEqual((await picker.addCustom()).ok, true)

  // 云端在同步前"已经"有同名动作（另一台设备刚加的）→ 恢复网络后被服务端复核。
  world.online = true
  const state = world.engine.read('coach-owner')
  state.customExercises.push({ id: 'exercise_other', name: ACT, group: '肩' })
  world.engine.seed('coach-owner', state)
  world.writeCache()
  await require('../utils/sync-engine').flush()
  await settle(60)

  const outbox = require('../utils/local-outbox')
  const scope = { environment: 'production', datasetId: 'ds-test' }
  assert.strictEqual(outbox.count(scope), 0, '明确失败/成功的条目都必须离开队列（不能永远挂在里面）')
  assert.ok(world.localDB().customExercises.length >= 1, '本机投影必须回到云端事实，不得留下幻影')
  console.log('  ✓ 云端复核与失败留档：队列不残留、本机投影回到事实')
  return world
}

async function main() {
  await scenarioFirstFrame()
  await scenarioSlowCloud()
  await scenarioOfflineRestart()
  await scenarioContinuous()
  await scenarioCloudRejects()
  console.log('PASS 动作库本机先行（第一帧 / 无遮罩 / 断网 / 重启 / 不产生孤儿）')
  process.exit(0)
}

main().catch(error => { console.error(error && error.stack || error); process.exit(1) })
