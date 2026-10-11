// 【本轮核心·永久回归】新增秒进 → 编辑秒改 → 删除秒删，以及它背后的最终一致性。
//
// 这一份测试回答的是真机上的两个问题，所以每个场景都对应一个**真实故障**：
//   · 问题1（「姜来」）：新增学员有时走 Local-first、有时仍被云端 read/revision 准备挡住。
//     根因是「第一次保存时课时包那几笔没成功 → form.id 已被写上 → 再点一次保存就换了另一条路径」。
//     → 场景 C 钉死：**同一个动作，无论第几次点，语义必须一致**。
//   · 问题2：新增后立即删除失败（createStudent / createPackage / createSale 还在队列里）。
//     → 场景 A 钉死：本机临时 id 的改 / 删**绝不**退回云端先行；队列顺序 create→销售→改名→删除
//       必须最终收敛成「没有幽灵学员、没有活跃幽灵销售、没有孤立课包」。
//
// 铁律（本测试的判定标准）：
//   ① UI 的「秒」= 本机安全保存后立即完成；**不是**要求云端 1 秒完成。
//   ② 云端慢、断网、response 丢失，都不许拖住用户界面。
//   ③ 「秒」**绝不**以最终一致性为代价 —— 每个场景末尾都必须验证云端收敛，且没有重复 / 复活。
//
// ⚠️ 编写这份测试时踩到的两个坑，都写在这里，避免下次再犯：
//   坑 1（会让测试**静默地只跑一半**）：`run()` 返回的 Promise 如果只挂 `.catch` 而**不被 await**，
//        那么一旦主模块的同步部分先跑完、事件循环上又恰好没有定时器，
//        Node 就会认为"没事可干了"而**直接退出**。现象极其隐蔽：
//        退出码是 0、前几个场景的断言全都过了、最后的 PASS 行却根本没打印 ——
//        runner 用 `/pass/i` 判分，于是判成 FAILED。所以下面必须 `await run()`。
//   坑 2（会让断言**根本没生效**）：课包不是顶层集合，它住在 `student.packages` 里。
//        写 `snapshot().packages` 会拿到 undefined，`undefined.filter(...)` 直接抛，
//        或者被 `.length` 悄悄当成 0 —— 那不是"没有孤立课包"，而是断言没跑。
const assert = require('assert')
const path = require('path')
const { createWorld, copy, settle } = require('./helpers/local-first-world')
const root = path.join(__dirname, '..')
const empty = () => ({ students: [], bookings: [], incomes: [], sales: [], settings: { renewThreshold: 3, monthlyGoalSessions: 20 }, customExercises: [] })
function setPath(target, key, value) { const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let node = target; for (const part of parts.slice(0, -1)) node = node[part]; node[parts[parts.length - 1]] = copy(value) }
function page() { let definition; global.Page = value => { definition = value }; const file = path.join(root, 'pages/students/students.js'); delete require.cache[require.resolve(file)]; require(file); delete global.Page; const instance = { data: copy(definition.data), setData(patch) { Object.entries(patch).forEach(([key, value]) => setPath(this.data, key, value)) } }; Object.keys(definition).forEach(key => { if (typeof definition[key] === 'function') instance[key] = definition[key].bind(instance) }); return instance }
// 「秒」的判据：给它一个**远小于**云端延迟的窗口。超时不是"慢一点"，而是"这条路径等云端了"。
const INSTANT_MS = 200
const instant = (promise, label) => Promise.race([
  promise,
  new Promise(resolve => setTimeout(() => resolve({ code: 'BLOCKED_ON_CLOUD', __label: label }), INSTANT_MS))
])
// 把后台同步推到"此刻真的没活了"为止。**必须显式驱动**：
//   · 先给事件循环转几圈，让 schedule() 排的那一轮 flush 真正开始；
//   · 再等 sync-engine.whenIdle()，即当前那一轮（含它内部所有 await）走完；
//   · 两者交替，直到队列连续几轮不再变化为止。
//
// ⚠️⚠️ 为什么这里**必须**先 await 一个定时器、而不能直接用 whenIdle()：
//   场景 G 会故意把某些云端命令**永远挂起**（`new Promise(() => {})`），
//   于是 sync-engine 的 `running` 永远不释放、`whenIdle()` 永远返回同一个未 settle 的 promise。
//   如果循环写成"同步地反复 await whenIdle()"，那就是一个**不让事件循环喘息**的紧循环：
//   await 一个 pending promise 只排微任务，微任务队列会被无限续上，
//   定时器阶段永远轮不到 —— 整个进程会被**饿死**。
//   实测表现极其隐蔽：退出码 0、没有任何输出、连最后的 console.log 都不打印。
//   所以每一轮都先 `await settle()`（= 真定时器），把事件循环让出去，再去看队列。
async function drain(world, limit = 60) {
  const sync = require(path.join(root, 'utils', 'sync-engine'))
  let last = null, stable = 0
  for (let i = 0; i < limit; i++) {
    await settle(4)
    // 只"看"一眼同步引擎是否还在跑，**不 await 一个可能永远不 settle 的 promise**：
    // whenIdle() 返回 null 就表示此刻没有在跑的那一轮；有在跑也不阻塞，交给下一轮的 settle。
    const pending = sync.whenIdle()
    if (pending && typeof pending.then === 'function') await Promise.race([pending, settle(4)])
    const count = world.outboxEntries().length
    if (count === last && count === 0) stable += 1
    else stable = 0
    last = count
    if (stable >= 3) return count
  }
  return last
}
// 填一位学员 + 一笔课时包（含销售），与真机上「一次保存」填的内容一致。
function fill(p, { name, total = '20', remaining = '17', price = '300', saleAmount = '5800' } = {}) {
  p.add()
  p.field({ currentTarget: { dataset: { field: 'name' } }, detail: { value: name } })
  for (const [key, value] of Object.entries({ total, remaining, price, saleAmount })) p.pkg({ currentTarget: { dataset: { i: 0, k: key } }, detail: { value } })
}
// 「还活着的学员」= 没有被删除、也没有留下墓碑的那位。
const live = world => world.snapshot().students.filter(s => s.status !== 'deleted')
// 「还活着的销售」= 状态不是 reversed 的都算。
// ⚠️ 云端 `reverseCourseSale` / `deletePackage` 给销售打的是 `status='reversed'`；
//    而 `deleteStudent` 走的是**另一条**路：它给销售打 `reversed:true`（没有 status）。
//    只按 status 判，会把「删除学员后残留的幽灵销售」误当成"已撤销"而漏过去 ——
//    这条断言就白写了。所以两个字段都要认。
const liveSales = world => world.snapshot().sales.filter(s => s.status !== 'reversed' && s.reversed !== true)
// ⚠️ 课包**不是**顶层集合：它住在 `student.packages` 里（与云端 handlers 同形状）。
const livePackages = world => world.snapshot().students.flatMap(s => s.packages || []).filter(p => p.status !== 'reversed' && p.reversed !== true)
const tombstones = world => world.snapshot().studentTombstones || []

const results = []
async function scenario(name, body) {
  const world = createWorld({ allowMaskedCommands: true })
  try {
    await body(world)
    results.push(`  ✓ ${name}`)
  } catch (error) {
    results.push(`  ✗ ${name}`)
    throw error
  } finally {
    world.restoreUi()
  }
}

async function run() {
  // ================================================================ A【本轮主场景】云端 10 秒 + 新增 → 编辑 → 删除
  // 这是用户明确要求的第一条：云端延迟 10 秒下，UI 必须在每一环都立即完成，最后云端收敛且无重复。
  await scenario('A 云端延迟 10 秒：新增秒进 → 编辑秒改 → 删除秒删 → 后台收敛', async world => {
    world.seed(empty()); world.memoryRevision = 0
    const p = page(); p.onShow(); fill(p, { name: '延迟学员' })
    // 云端慢到 10 秒。UI 路径上**一个字节**都不该等它。
    world.latency = 10000
    const created = await instant(p.save(), 'create')
    world.cancelLatency()
    assert.equal(created.ok, true, '新增必须在云端延迟 10 秒下立即完成：' + JSON.stringify(created))
    const id = created.result.studentId
    assert.ok(id, '新增必须立刻拿到本机学员 id')
    assert.ok(world.localDB().students.some(s => s.id === id), '新增必须立刻出现在本机列表里（秒进）')
    assert.equal(p.data.form.id, id, '表单必须立刻落到该学员的编辑态')

    p.setData({ 'form.name': '延迟学员改名' })
    world.latency = 10000
    const edited = await instant(p.save(), 'update')
    world.cancelLatency()
    assert.equal(edited.ok, true, '编辑必须立即完成，不等云端：' + JSON.stringify(edited))
    assert.equal(world.localDB().students.find(s => s.id === id).name, '延迟学员改名', '编辑必须立刻反映在本机（秒改）')

    world.latency = 10000
    const deleted = await instant(p.removeStudentData(id), 'delete')
    world.cancelLatency()
    assert.equal(deleted.ok, true, '删除必须立即完成，不等云端：' + JSON.stringify(deleted))
    assert.equal(world.localDB().students.some(s => s.id === id), false, '删除必须立刻从本机消失（秒删）')

    // 队列必须按 create → 销售 → 改名 → 删除 的**同一实体顺序**排好，且都还在等云端。
    const order = world.outboxEntries().map(e => e.command)
    assert.deepStrictEqual(order, ['createStudent', 'createCourseSale', 'updateStudent', 'deleteStudent'], '同一实体的队列顺序必须是新增→销售→改名→删除：' + order.join('>'))
    assert.ok(world.outboxEntries().every(e => e.entityKey.startsWith('student:')), '这些条目必须都认得出同一个学员实体')

    // 云端恢复（延迟归零）：后台必须把整条链收敛掉。
    world.latency = 0
    await world.restoreNetwork(); await drain(world)
    assert.equal(world.outboxEntries().length, 0, '云端恢复后队列必须清空')
    assert.equal(live(world).length, 0, '最终绝不能留下幽灵学员')
    assert.equal(liveSales(world).length, 0, '最终绝不能留下活跃幽灵销售')
    assert.equal(livePackages(world).length, 0, '最终绝不能留下孤立课包')
    assert.equal(tombstones(world).length, 1, '最终必须恰好一条墓碑（不复活、不重复）')
  })

  // ================================================================ B 云已不可用（execute 被挂起）：新增 → 编辑 → 删除
  // 与 A 的区别：这里不是"慢"，而是**永远不返回**。UI 依旧必须每一环都立即完成。
  await scenario('B 云端永不返回：新增 → 编辑 → 删除 全部立即完成，杀进程后仍成立', async world => {
    world.seed(empty()); world.memoryRevision = 0
    const p = page(); p.onShow(); fill(p, { name: '挂起学员' })
    const execute = world.adapter.execute
    world.adapter.execute = async () => new Promise(() => {})    // 永不 resolve
    const created = await instant(p.save(), 'create')
    assert.equal(created.ok, true, '云端永不返回时新增仍须立即完成：' + JSON.stringify(created))
    const id = created.result.studentId
    p.setData({ 'form.name': '挂起学员改名' })
    assert.equal((await instant(p.save(), 'update')).ok, true, '云端永不返回时编辑仍须立即完成')
    assert.equal(world.localDB().students.find(s => s.id === id).name, '挂起学员改名')
    assert.equal((await instant(p.removeStudentData(id), 'delete')).ok, true, '云端永不返回时删除仍须立即完成')
    assert.equal(world.localDB().students.some(s => s.id === id), false)
    // 杀进程重启：本机的删除结果必须还在（持久化的，不是内存态）。
    world.restartProcess()
    assert.equal(world.localDB().students.some(s => s.id === id), false, '杀进程重开后删除结果必须仍然成立')
    // 队列必须完整存活：新增那批（学员 + 销售）+ 改名 + 删除，一条不丢、不改号。
    assert.deepStrictEqual(world.outboxEntries().map(e => e.command), ['createStudent', 'createCourseSale', 'updateStudent', 'deleteStudent'], '杀进程重开后整条链必须仍在持久队列里，且顺序不变')
    // 放行云端：整条链必须收敛，绝不因为中途杀过进程而重复或复活。
    world.adapter.execute = execute
    await world.restoreNetwork(); await drain(world)
    assert.equal(world.outboxEntries().length, 0, '恢复后队列必须清空')
    assert.equal(live(world).length, 0, '恢复后绝不能复活该学员')
    assert.equal(liveSales(world).length, 0, '恢复后绝不能留下活跃销售')
    assert.equal(tombstones(world).length, 1, '墓碑必须恰好一条')
  })

  // ================================================================ C【问题1】第一次保存失败后重试：语义必须一致
  // 「姜来」故障：第一次保存时课时包那几笔没成功 → 用户再点一次保存 → 换了另一条路径。
  // 这里精确复现：让**第一次**保存遇上云端读失败，然后立刻重试，重试必须仍走本机先行。
  await scenario('C 第一次保存失败后立即重试：第二次仍是本机先行，不再被云端 read 挡住', async world => {
    world.seed(empty()); world.memoryRevision = 0
    const p = page(); p.onShow(); fill(p, { name: '重试学员' })
    // 第一次：让 readActive 失败（复现真机上"最新数据暂时没读到"的那个前提），
    // 但本机先行路径**不该**因此失败 —— 这正是修复要证明的事。
    world.failRefresh = 5
    const first = await instant(p.save(), 'first-save')
    assert.equal(first.ok, true, '第一次保存就必须成功（本机先行不依赖云端 read）：' + JSON.stringify(first))
    const id = first.result.studentId
    assert.ok(world.localDB().students.some(s => s.id === id), '第一次保存后学员必须已在本机')
    // ★ 「姜来」的真凶在这一行：第一次保存已经把 form.id 写上了。
    //   修复前，第二次保存因为 `!f.id` 不再成立而掉到"逐笔云端先行"的旧路径，
    //   于是 createPackage / createCourseSale 被 readActive 失败挡在出网之前。
    assert.equal(p.data.form.id, id, '第一次保存后表单必须已经是"已有学员"的编辑态（这正是旧代码分叉的条件）')
    p.setData({ 'form.name': '重试学员改名' })
    world.failRefresh = 5
    const second = await instant(p.save(), 'retry-save')
    assert.equal(second.ok, true, '第二次保存仍必须立即完成：' + JSON.stringify(second))
    assert.equal(second.path, 'local-first', '第二次保存必须仍走本机先行，不得退回云端先行：' + JSON.stringify(second))
    assert.equal(world.localDB().students.find(s => s.id === id).name, '重试学员改名')
    world.failRefresh = 0
    await world.restoreNetwork(); await drain(world)
    assert.equal(live(world).length, 1, '最终必须只有这一位学员（绝不重复创建）')
    assert.equal(live(world)[0].name, '重试学员改名', '最终名字必须是她最后一次填的')
    assert.equal(world.outboxEntries().length, 0, '队列必须清空')
    // 重试之后**课包与销售也必须只剩一份** —— 旧代码第二次保存会再建一笔。
    assert.equal(livePackages(world).length, 1, '重试绝不能把课时包建成两个')
    assert.equal(liveSales(world).length, 1, '重试绝不能把销售建成两笔')
  })

  // ================================================================ D 双击保存：只能产生一位学员
  await scenario('D 双击 / 连点保存：只产生一位学员、一笔销售', async world => {
    world.seed(empty()); world.memoryRevision = 0
    const p = page(); p.onShow(); fill(p, { name: '双击学员' })
    const [a, b] = await Promise.all([p.save(), p.save()])
    assert.equal(a.ok, true); assert.equal(b.ok, true)
    assert.equal(a.result.studentId, b.result.studentId, '双击必须落到同一位学员上（单航班）')
    await drain(world)
    assert.equal(live(world).length, 1, '双击后云端只能有一位学员')
    assert.equal(liveSales(world).length, 1, '双击后云端只能有一笔销售')
    assert.equal(livePackages(world).length, 1, '双击后云端只能有一个课包')
  })

  // ================================================================ E 完全离线：新增 → 编辑 → 删除，联网后收敛
  await scenario('E 完全离线：新增 → 编辑 → 删除 全部立即完成，联网后收敛且无重复', async world => {
    world.seed(empty()); world.memoryRevision = 0
    const p = page(); p.onShow(); fill(p, { name: '离线学员' })
    world.online = false
    const created = await instant(p.save(), 'offline-create')
    assert.equal(created.ok, true, '离线时新增必须立即完成：' + JSON.stringify(created))
    const id = created.result.studentId
    p.setData({ 'form.name': '离线学员改名' })
    assert.equal((await instant(p.save(), 'offline-update')).ok, true, '离线时编辑必须立即完成')
    assert.equal((await instant(p.removeStudentData(id), 'offline-delete')).ok, true, '离线时删除必须立即完成')
    assert.equal(world.localDB().students.some(s => s.id === id), false, '离线删除必须立刻生效')
    assert.equal(world.counters.cloudCalls.filter(c => c.name === 'coachBusinessCommand').length, 0, '离线期间云端一个字节都不该收到')
    world.online = true
    await world.restoreNetwork(); await drain(world)
    assert.equal(world.outboxEntries().length, 0, '联网后队列必须清空')
    assert.equal(live(world).length, 0, '联网后绝不能留下幽灵学员')
    assert.equal(liveSales(world).length, 0, '联网后绝不能留下活跃幽灵销售')
    assert.equal(livePackages(world).length, 0, '联网后绝不能留下孤立课包')
  })

  // ================================================================ F 命令已提交但响应丢失：不得重复、不得复活
  await scenario('F 新增已提交但响应丢失：不重复创建，删除最终生效', async world => {
    world.seed(empty()); world.memoryRevision = 0
    const p = page(); p.onShow(); fill(p, { name: '丢响应学员' })
    world.dropResponse = 1                       // 第一条命令（createStudent）云端成功但响应丢了
    const created = await instant(p.save(), 'drop-create')
    assert.equal(created.ok, true, '响应丢失也不能拖住界面：' + JSON.stringify(created))
    const id = created.result.studentId
    await drain(world)                           // 让它自己把结果收敛（查回执 / 同号重试）
    assert.equal(live(world).length, 1, '响应丢失后云端必须只有一位学员（同号重试绝不变成两位）')
    assert.equal((await instant(p.removeStudentData(id), 'drop-delete')).ok, true, '删除必须立即完成')
    await world.restoreNetwork(); await drain(world)
    assert.equal(live(world).length, 0, '最终绝不能复活')
    assert.equal(liveSales(world).length, 0, '最终绝不能留下活跃销售')
    assert.equal(world.outboxEntries().length, 0, '队列必须清空')
  })

  // ================================================================ G 学员已成功、课包/销售尚未完成
  await scenario('G 学员已落云但课包/销售还在队列：立即编辑/删除仍然成立', async world => {
    world.seed(empty()); world.memoryRevision = 0
    const p = page(); p.onShow(); fill(p, { name: '半程学员' })
    // 复现真机上"学员有、包没有"的中间态。关键是要让**课包这条命令真的还没送到云端**
    // （引擎还挂在它上面），而不是"已经提交给云端、只是永远不回"。
    // 为什么这个区别是本质的：
    //   · 挂住（本节）—— 队列压着它，后面的 update / delete 被全局 FIFO 挡住，
    //                   这才是"半程态"的真实形状，也正是本节要钉的场景；
    //   · 已提交且不回 —— 那次调用已经交到（永远不返回的）适配器手里，
    //                   之后无论怎么放行都无法再前进 —— 那是"云端已经不可用"，属于场景 B 的领地。
    //
    // 做法：用一道**闸门**拦住第一条课包命令（拦在真正执行之前），断言做完再放行。
    //   ⚠️ 不能改成"返回一个失败码"来伪造冻结：`REVISION_UNKNOWN` 会被同步引擎识别成
    //      **本机前置条件未满足**（命令根本没出网），于是它自己补一次 revision 再重试，
    //      队列当场就被推走了 —— 造不出"队列压着"的中间态。
    //   ⚠️ 也不能在拦截时**顺手把真调用跑掉**再返回一个永不 settle 的 promise：
    //      那样这次真调用就白跑了，放行时再补一次会撞上幂等号，队列永远清不掉。
    //      闸门必须是"先别执行"，不是"执行了但不说结果"。
    const execute = world.adapter.execute
    let openGate = null
    const gate = new Promise(resolve => { openGate = resolve })
    let gated = false
    world.adapter.execute = async (command, payload, opts) => {
      if (command !== 'createStudent' && !gated) { gated = true; await gate }
      return execute(command, payload, opts)
    }
    const created = await instant(p.save(), 'partial-create')
    const id = created.result.studentId
    await drain(world, 12)
    assert.equal(live(world).length, 1, '学员这一半必须已经落到云端')
    assert.ok(gated, '课包/销售这一半必须已经被闸门拦下（尚未送到云端）')
    assert.ok(['createCourseSale', 'createPackage'].some(cmd => world.outboxEntries().some(e => e.command === cmd)), '课包/销售这一半必须仍在队列里')
    // 让表单回到「已有学员」的编辑态 —— 与真机上她看到的那个状态一致。
    // 直接复用同一个 page 实例是不对的：上一轮保存的单航班可能还没释放，
    // 那测的是锁的时序而不是业务路径（本测试要钉的是"半程态下改/删仍然立即完成"）。
    // ⚠️ 这里**先不 render**：要让 `openEditor` 拿到的仍是保存那一刻写进表单的
    //    **本机临时 id**（`loc_student_…`）。这正是真机上"秒进之后立刻编辑"的形状：
    //    表单里那份身份还没有被任何一次回读刷成云端正式 id。
    //    （缺陷就在这里暴露：`saveStudentBatch` 若不先把 studentId 过一遍 idMap 转正，
    //      就会拿一个本机临时 id 去本机事务里找学员 → STUDENT_NOT_FOUND → 改名/删除全部失败。）
    p.openEditor(id)
    assert.equal(p.data.form && p.data.form.id, id, '半程态下表单必须仍停在保存那一刻写下的本机临时身份上')
    p.setData({ 'form.name': '半程学员改名' })
    // 此刻队列里**仍然**压着课包/销售，所以下面两条断言的语义就是"哪怕队列没清空，改和删也必须当场完成"。
    const upd = await instant(p.save(), 'partial-update')
    assert.ok(upd && upd.ok, '半程态下编辑必须立即完成：' + JSON.stringify(upd))
    const del = await instant(p.removeStudentData(id), 'partial-delete')
    assert.ok(del && del.ok, '半程态下删除必须立即完成：' + JSON.stringify(del))
    // 放行闸门：整条链（课包 → 改名 → 删除）必须按序走完并收敛。
    openGate()
    await drain(world)
    assert.equal(world.outboxEntries().length, 0, '放行后队列必须清空（顺序正确才不会卡住）')
    assert.equal(live(world).length, 0, '最终绝不能有幽灵学员')
    assert.equal(liveSales(world).length, 0, '最终绝不能有活跃幽灵销售')
    assert.equal(livePackages(world).length, 0, '最终绝不能有孤立课包')
    assert.equal(tombstones(world).length, 1, '最终必须恰好一条墓碑（不复活、不重复）')
  })

  // ================================================================ H 人工输入必须原样保留（remaining / sale.amount）
  await scenario('H 人工输入原样保留：remaining 与 sale.amount 不被任何本机路径改写', async world => {
    world.seed(empty()); world.memoryRevision = 0
    const p = page(); p.onShow()
    // 故意填一组"非默认"的值：remaining ≠ total，saleAmount ≠ price × total。
    // 任何"自动计算"的实现都会在这里露馅。
    fill(p, { name: '人工值学员', total: '20', remaining: '17', price: '300', saleAmount: '5800' })
    const created = await instant(p.save(), 'manual-create')
    assert.equal(created.ok, true)
    await drain(world)
    const pkg = livePackages(world)[0]
    const sale = world.snapshot().sales[0]
    assert.ok(pkg, '课包必须已经落到云端')
    assert.equal(pkg.remaining, 17, 'remaining 必须原样是人工输入的 17')
    assert.equal(pkg.total, 20, 'total 必须原样是人工输入的 20')
    assert.equal(sale.amount, 5800, 'sale.amount 必须原样是人工输入的 5800')
    assert.notEqual(sale.amount, 300 * 20, 'amount 绝不能被自动算成单价 × 课时数')
  })

  // ================================================================ I 队列顺序：create → update → delete 不得倒序
  await scenario('I 同一实体 outbox 顺序：先建后改再删，云端最终没有该学员', async world => {
    world.seed(empty()); world.memoryRevision = 0
    const p = page(); p.onShow(); fill(p, { name: '顺序学员' })
    const created = await instant(p.save(), 'seq-create')
    const id = created.result.studentId
    // 反复改三次再删：只有顺序正确，云端才不会出现"删除之后又被改活"。
    for (const name of ['顺序学员v2', '顺序学员v3', '顺序学员v4']) { p.setData({ 'form.name': name }); await instant(p.save(), 'seq-update') }
    await instant(p.removeStudentData(id), 'seq-delete')
    const order = world.outboxEntries().map(e => e.command)
    const firstDelete = order.indexOf('deleteStudent')
    assert.ok(firstDelete > order.indexOf('createStudent'), '删除必须排在新增之后：' + order.join('>'))
    assert.ok(order.slice(0, firstDelete).every(cmd => cmd !== 'deleteStudent'), '删除之前不得再出现删除')
    assert.ok(order.slice(firstDelete + 1).every(cmd => cmd !== 'createStudent'), '删除之后不得再出现新增（否则会复活）')
    await world.restoreNetwork(); await drain(world)
    assert.equal(live(world).length, 0, '顺序正确时云端最终必须没有该学员')
    assert.equal(tombstones(world).length, 1, '墓碑恰好一条')
    assert.equal(world.outboxEntries().length, 0, '队列清空')
  })

  // ================================================================ J 创建尚未发送时删除：可安全折叠，但结果必须一致
  await scenario('J create 尚未发送时立即删除：不产生幽灵、不产生孤立课包', async world => {
    world.seed(empty()); world.memoryRevision = 0
    const p = page(); p.onShow(); fill(p, { name: '未发即删学员' })
    // 完全拦住出网：create 一条都没发出去。
    world.online = false
    const created = await instant(p.save(), 'unsent-create')
    assert.equal(created.ok, true)
    const id = created.result.studentId
    assert.equal(world.counters.cloudCalls.length, 0, '此时云端确实一条都没收到')
    assert.equal((await instant(p.removeStudentData(id), 'unsent-delete')).ok, true, '未发送时删除更要立即完成')
    assert.equal(world.localDB().students.some(s => s.id === id), false)
    world.online = true
    await world.restoreNetwork(); await drain(world)
    assert.equal(live(world).length, 0, '无论折叠与否，云端最终都不能留下该学员')
    assert.equal(liveSales(world).length, 0, '不能留下活跃销售')
    assert.equal(livePackages(world).length, 0, '不能留下孤立课包')
  })

  // ================================================================ K 新增 → 编辑 → 删除 后，再次新增同名学员
  await scenario('K 删除后重新新增同名学员：是两条独立业务，不撞号、不复活旧的', async world => {
    world.seed(empty()); world.memoryRevision = 0
    const p = page(); p.onShow(); fill(p, { name: '同名学员' })
    const first = await instant(p.save(), 'same-1')
    const firstId = first.result.studentId
    await instant(p.removeStudentData(firstId), 'same-delete')
    await drain(world)
    assert.equal(live(world).length, 0)
    fill(p, { name: '同名学员' })                     // 第二次新增：新的 draftKey，新的批次
    const second = await instant(p.save(), 'same-2')
    assert.equal(second.ok, true, '删除后重新新增必须立即完成：' + JSON.stringify(second))
    assert.notEqual(second.result.studentId, firstId, '第二次新增必须是一个全新的学员，不得复用已删的身份')
    await drain(world)
    assert.equal(live(world).length, 1, '最终必须恰好一位存活学员')
    assert.equal(live(world)[0].name, '同名学员')
    assert.equal(tombstones(world).length, 1, '被删的那位仍必须留下恰好一条墓碑')
    assert.equal(liveSales(world).length, 1, '新学员的销售必须只剩一笔（旧那笔不能跟着复活）')
  })

  console.log(results.join('\n'))
  console.log('student pending lifecycle PASS（新增秒进 / 编辑秒改 / 删除秒删 + 最终一致性）')
}

// ⚠️ 必须 await：见文件头「坑 1」。不 await 时事件循环一旦没有定时器，
//    Node 会在第 6 个场景处**直接退出**，退出码仍是 0，最后的 PASS 行永远不打印。
run().then(
  () => process.exit(0),
  error => { console.error(error); process.exit(1) }
)
