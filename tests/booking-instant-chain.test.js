// 【本轮核心·永久回归】预约「秒约」：点确认 → 本机立刻建 → 课表当帧可见 → 后台由 Outbox 收敛。
//
// 这一份测试回答的是 1.1.5 正式区的那个真机故障，所以每个场景都对应一个**真实故障**：
//   · 无论刚新增的测试学员还是已有老学员，新建预约都会出现
//     「结果待确认 / 云端调用中断，这条预约正在确认中」。
//   根因不是文案，是**通道**：createBooking 当时被分派给「本机视觉协调器」——
//   那是一条**独立于 Outbox 的第二套同步链**（自己的 pending 存储、自己的 requestId 序号、
//   自己的 receipt 处理与退避）。它的后台 confirm 一旦拿到 COMMAND_RESULT_UNKNOWN /
//   REQUEST_PROCESSING（云端慢、断连、response 丢失），settle() 就当场弹「结果待确认」。
//   而同一时刻的学员新增走的是本机先行（秒进、静默收敛）—— 同一次「点一下」，
//   两条命令却有两套语义。修复就是把 createBooking 挪进 LOCAL_FIRST，与学员**同一条链**。
//
// 铁律（本测试的判定标准）：
//   ① UI 的「秒」= 本机安全保存后立即完成；**不是**要求云端 1 秒完成。
//   ② 云端慢（含慢到永不返回）、断网、response 丢失，都不许拖住界面、不许弹「结果待确认」。
//   ③ 「秒」**绝不**以最终一致性为代价 —— 每个场景末尾都要验证云端收敛，且没有重复 / 复活。
//   ④ 预约阶段**不提前扣课**：扣课时只发生在完课（未改动）。
//
// ⚠️ 编写时沿用的两条教训（见 student-pending-lifecycle.test.js 的注释）：
//   · `run()` 返回的 Promise 必须 `await`，否则 Node 可能在打印 PASS 之前就退出（退出码 0 却判 FAILED）。
//   · 课包不是顶层集合，它住在 `student.packages` 里；`snapshot().packages` 会悄悄当成长度 0，
//     那不是"没有孤立课包"，而是断言根本没跑。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
// ⚠️ 必须先加载 helper：它在**模块加载时**就把替身写进 require.cache，
//    之后任何项目模块（含 mutate / booking-modal）拿到的才是那套受控的"云"。
const { createWorld, copy, settle } = require('./helpers/local-first-world')
const root = path.join(__dirname, '..')

const BOOK_DATE = '2026-09-25'
const empty = () => ({ students: [], bookings: [], incomes: [], sales: [], settings: { renewThreshold: 3, monthlyGoalSessions: 20 }, customExercises: [] })
// 一位老学员 + 两个课包：第二个用来钉「packageId 必须精确对应用户点选的那一个」。
const seeded = () => ({
  ...empty(),
  students: [{
    id: 'stu-1', name: '老学员', phone: '13900000000', abbr: 'LXY', status: 'active',
    packages: [
      { id: 'pkg-1', type: '常规训练', total: 20, used: 3, remaining: 17, price: 300, status: 'active', saleId: 'sale-1' },
      { id: 'pkg-2', type: '拉伸恢复', total: 8, used: 0, remaining: 8, price: 200, status: 'active', saleId: 'sale-2' }
    ]
  }],
  sales: [
    { id: 'sale-1', date: '2026-09-01', source: 'course', status: 'active', studentId: 'stu-1', packageId: 'pkg-1', typeName: '常规训练', quantity: 20, unitPrice: 300, amount: 6000 },
    { id: 'sale-2', date: '2026-09-02', source: 'course', status: 'active', studentId: 'stu-1', packageId: 'pkg-2', typeName: '拉伸恢复', quantity: 8, unitPrice: 200, amount: 1600 }
  ]
})
// 「秒」的判据：给它一个**远小于**云端延迟的窗口。超时不是"慢一点"，而是"这条路径等云端了"。
const INSTANT_MS = 200
const instant = (promise, label) => Promise.race([
  promise,
  new Promise(resolve => setTimeout(() => resolve({ code: 'BLOCKED_ON_CLOUD', __label: label }), INSTANT_MS))
])
// 把后台同步推到"此刻真的没活了"为止。每一轮先用真定时器把事件循环让出去，
// **绝不 await 一个可能永不 settle 的 promise**（否则微任务会被无限续上、定时器阶段永远轮不到 → 进程被饿死，
// 表现是退出码 0、一个字都不输出、连 PASS 行都没有）。
async function drain(world, limit = 60) {
  const sync = require(path.join(root, 'utils', 'sync-engine'))
  let last = null, stable = 0
  for (let i = 0; i < limit; i++) {
    await settle(4)
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
// 加载**真实的** booking-modal 组件（用全局 Component 捕获），不另写一份替身：
// 要钉的正是"点确认那一下走的到底是哪条通道"，替身会把这条通道盖掉。
function bookingModal() {
  const file = path.join(root, 'components/booking-modal/booking-modal.js')
  let definition = null
  global.Component = value => { definition = value }
  delete require.cache[require.resolve(file)]
  require(file)
  delete global.Component
  if (!definition) throw new Error('booking-modal 组件没有被注册。')
  const instance = {
    data: copy(definition.data), properties: {}, events: {},
    setData(patch) { Object.entries(patch).forEach(([key, value]) => { this.data[key] = copy(value) }) },
    triggerEvent(name, detail) { (this.events[name] = this.events[name] || []).push(copy(detail)) }
  }
  Object.keys(definition.methods).forEach(name => {
    const fn = definition.methods[name]
    instance[name] = typeof fn === 'function' ? fn.bind(instance) : copy(fn)
  })
  return instance
}
// 走完真实的两步选择：学员 → 课包 → 时间。绝不手工拼 data，否则测的就不是页面了。
function openModal(world, { studentId = 'stu-1', packageIndex = 0, hour = 10, minute = 0, date = BOOK_DATE } = {}) {
  const modal = bookingModal()
  modal.properties = { visible: true, presetDate: date, presetHour: hour }
  modal.init()
  modal.chooseStudent({ currentTarget: { dataset: { id: studentId } } })
  modal.choosePackage({ currentTarget: { dataset: { index: packageIndex, disabled: false } } })
  modal.setData({ date, hour, minute })
  return modal
}
// 本机这一帧（投影）+ 云端真相（引擎）。
const localBookings = world => world.localDB().bookings
const cloudBookings = world => world.snapshot().bookings
const studentPackages = world => world.snapshot().students[0].packages
// 「打扰型」模态框：正常路径上一个都不该出现（这正是本轮要消灭的东西）。
const naggingModals = world => world.counters.modals.filter(m => /待确认|正在同步|云端确认|云端调用|未生效|未提交|处理超时|数据已变化/.test(String(m.title)))
// 「这个时段被闸门拦下的云端调用」：闸门拦在**真调用之前**。
// ⚠️ 绝不能"先跑真调用再返回一个永不 settle 的 promise"——那次真调用白跑，
//    放行后补跑会撞上幂等号，而队列再也清不掉（student-pending-lifecycle 场景 G 踩过）。
function gate(world, command) {
  const execute = world.adapter.execute
  let openGate = null
  const gatePromise = new Promise(resolve => { openGate = resolve })
  let hit = false
  world.adapter.execute = async (cmd, payload, opts) => {
    if (cmd === command && !hit) { hit = true; await gatePromise }
    return execute(cmd, payload, opts)
  }
  return { release() { openGate(); world.adapter.execute = execute }, hit: () => hit }
}

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
  // ================================================================ A【本轮主场景】老学员预约
  // 点确认那一刻：云端一次都没被叫到、课表当帧就有这条预约、弹层立刻关、没有「结果待确认」。
  await scenario('A 老学员预约：前台零等待、课表当帧可见、后台静默收敛、全程无「结果待确认」', async world => {
    world.seed(seeded()); world.memoryRevision = 0
    const modal = openModal(world, { studentId: 'stu-1', packageIndex: 0, hour: 10 })
    const result = await instant(modal.confirm(), 'create-booking')
    assert.ok(result && result.ok, '点确认必须立即完成：' + JSON.stringify(result))
    assert.equal(result.path, 'local-first', '预约必须走本机先行（与学员同一条链）：' + JSON.stringify(result))
    assert.equal(world.counters.calls.length, 0, '点确认那一刻云端参与度必须为 0（不许等云端）')
    assert.equal(localBookings(world).length, 1, '课表在本机这一帧就必须能看到这条预约')
    assert.equal((modal.events.close || []).length, 1, '弹层必须立刻关闭')
    assert.equal(naggingModals(world).length, 0, '不得出现「结果待确认」类提示：' + JSON.stringify(world.counters.modals))

    // 云端载荷必须是契约允许的**恰好五个字段**（多一个字段真实云函数就 INVALID_PAYLOAD）。
    await world.restoreNetwork(); await drain(world)
    const call = world.counters.calls.find(item => item.command === 'createBooking')
    assert.ok(call, '后台必须真的把这条预约送到云端')
    assert.deepStrictEqual(Object.keys(call.payload).sort(), ['date', 'hour', 'minute', 'packageId', 'studentId'], '预约载荷只能带契约允许的 5 个字段：' + JSON.stringify(call.payload))

    assert.equal(world.outboxEntries().length, 0, '收敛后队列必须清空')
    assert.equal(cloudBookings(world).length, 1, '云端必须恰好一条预约')
    assert.equal(naggingModals(world).length, 0, '后台收敛全程也不许打扰用户')
    assert.equal(localBookings(world)[0].packageId, 'pkg-1', '本机这一帧必须挂在用户点选的那个课包上')
  })

  // ================================================================ B 新学员尚未完全同步时马上预约
  // 这是用户明确点名要覆盖的形状：学员只有 loc_ 临时身份时就必须能约，
  // 而且发到云端时载荷里的身份要**已经转正**（否则云端 findStudent 一定找不到）。
  await scenario('B 新学员尚未完全同步时马上预约：本机临时 id 起步，发到云端时已换成正式 id', async world => {
    world.seed(empty()); world.memoryRevision = 0
    const mutate = require(path.join(root, 'utils', 'mutate'))
    const saved = await instant(mutate.saveStudentBatch({
      batchKey: 'nb-1', name: '秒约新学员', phone: '',
      packages: [{ command: 'createCourseSale', payload: { type: '常规训练', total: 20, remaining: 20, quantity: 20, unitPrice: 300, amount: 6000, date: '2026-09-20' }, clientKey: 'pk-1' }]
    }), 'save-student')
    assert.ok(saved && saved.ok, '新增学员必须立即完成：' + JSON.stringify(saved))
    const localStudentId = saved.result.studentId
    const localPackageId = saved.result.packages[0].packageId
    assert.ok(String(localStudentId).indexOf('loc_') === 0, '此刻学员应该只有本机临时 id：' + localStudentId)
    assert.ok(String(localPackageId).indexOf('loc_') === 0, '此刻课包应该只有本机临时 id：' + localPackageId)

    // ★ 一秒钟都没等：学员那批命令还在队列里，立刻预约。
    const modal = openModal(world, { studentId: localStudentId, packageIndex: 0, hour: 11 })
    const booked = await instant(modal.confirm(), 'create-booking')
    assert.ok(booked && booked.ok, '新学员尚未同步时必须仍能立即约上：' + JSON.stringify(booked))
    assert.equal(world.counters.calls.length, 0, '学员还没出网，预约更不该等云端')
    assert.equal(localBookings(world).length, 1, '课表必须当帧就出现这条预约')
    const localFrame = localBookings(world)[0]
    assert.equal(localFrame.studentId, localStudentId, '本机这一帧用的是学员的本机临时身份（正是真机形状）')
    assert.equal(localFrame.packageId, localPackageId, '本机这一帧用的是课包的本机临时身份')
    // 跨实体保序：被引用方（学员、课包）必须排在引用方（预约）**前面**，
    // 否则预约发出去时正式 id 还不存在，云端 findStudent 一定找不到。
    assert.equal(world.outboxEntries().map(entry => entry.command).join('>'), 'createStudent>createCourseSale>createBooking', '队列必须按「先学员、再课包、后预约」的跨实体顺序排好')

    await world.restoreNetwork(); await drain(world)
    assert.equal(world.outboxEntries().length, 0, '收敛后队列必须清空')
    const cloud = cloudBookings(world)
    assert.equal(cloud.length, 1, '云端必须恰好一条预约')
    const officialStudentId = world.snapshot().students[0].id
    assert.ok(String(officialStudentId).indexOf('loc_') !== 0, '云端学员必须是正式 id')
    assert.equal(cloud[0].studentId, officialStudentId, '发到云端的预约必须已经挂在正式学员 id 上（本机临时 id 已在发送时转正）')
    assert.equal(cloud[0].packageId, studentPackages(world)[0].id, '发到云端的预约必须挂在正式课包 id 上')
    assert.equal(localBookings(world)[0].studentId, officialStudentId, '转正后本机看到的也必须已经是正式 id（两帧是同一条预约）')
    assert.equal(naggingModals(world).length, 0, '全程不得出现「结果待确认」')
  })

  // ================================================================ B2 组件手里还是临时 id、学员已转正
  // 真机形状：新增完学员立刻去点日期格 → 弹层抄下的是**本机临时身份**；
  // 等用户选完课包，后台已经把这个学员在云端转正了（投影改用正式 id），
  // 而弹层里那一份**不会自己改**。此时如果直接拿临时身份去校验，就会报「学员已不存在」。
  await scenario('B2 弹层持有本机临时 id、学员已在云端转正：预约仍必须成功并落到正式 id 上', async world => {
    world.seed(empty()); world.memoryRevision = 0
    const mutate = require(path.join(root, 'utils', 'mutate'))
    const saved = await instant(mutate.saveStudentBatch({
      batchKey: 'nb-2', name: '转正窗口学员', phone: '',
      packages: [{ command: 'createCourseSale', payload: { type: '常规训练', total: 20, remaining: 20, quantity: 20, unitPrice: 300, amount: 6000, date: '2026-09-20' }, clientKey: 'pk-2' }]
    }), 'save-student')
    const localStudentId = saved.result.studentId
    // 弹层在**转正之前**打开并选好 —— 组件抄下的就是本机临时身份。
    const modal = openModal(world, { studentId: localStudentId, packageIndex: 0, hour: 19 })
    assert.equal(modal.data.student.id, localStudentId, '弹层此刻拿到的必须是本机临时身份')
    // 后台把学员 / 课包转正。组件里那份身份不会跟着变（这正是缺陷暴露点）。
    await world.restoreNetwork(); await drain(world)
    const officialStudentId = world.snapshot().students[0].id
    assert.ok(String(officialStudentId).indexOf('loc_') !== 0 && officialStudentId !== localStudentId, '学员必须已经在云端转正')
    assert.equal(modal.data.student.id, localStudentId, '组件里那份身份确实没有自己改（这就是真机形状）')

    const result = await instant(modal.confirm(), 'booking')
    assert.ok(result && result.ok, '弹层持有本机临时身份时预约仍必须成功：' + JSON.stringify(result))
    assert.equal(localBookings(world).length, 1, '课表必须当帧可见')
    await world.restoreNetwork(); await drain(world)
    assert.equal(world.outboxEntries().length, 0, '收敛后队列必须清空')
    assert.equal(cloudBookings(world).length, 1, '云端必须恰好一条预约')
    assert.equal(cloudBookings(world)[0].studentId, officialStudentId, '预约必须挂在正式学员 id 上')
    assert.equal(cloudBookings(world)[0].packageId, studentPackages(world)[0].id, '预约必须挂在正式课包 id 上')
    assert.equal(naggingModals(world).length, 0, '不得出现「结果待确认」')
  })

  // ================================================================ C 云端慢到永不返回
  // 比"慢 10 秒"更严：这一条命令**永远不回**。界面每一环仍必须立即完成，且不许弹任何待确认。
  await scenario('C 云端永不返回（比慢 10 秒更严）：界面立即完成、不弹「结果待确认」、放行后收敛', async world => {
    world.seed(seeded()); world.memoryRevision = 0
    const hold = gate(world, 'createBooking')
    const modal = openModal(world, { studentId: 'stu-1', packageIndex: 0, hour: 12 })
    const result = await instant(modal.confirm(), 'booking')
    assert.ok(result && result.ok, '云端永不返回时预约仍须立即完成：' + JSON.stringify(result))
    assert.equal(localBookings(world).length, 1, '课表必须当帧可见')
    assert.equal(naggingModals(world).length, 0, '云端一直不回也不许弹「结果待确认」：' + JSON.stringify(world.counters.modals))
    // 界面已经完成了，现在才轮到后台真的去撞那一次云端调用（sync-engine 用 setTimeout(run,0) 起步）。
    await settle(6)
    assert.ok(hold.hit(), '云端那一次必须真的被拦住了（否则测的不是"慢"）')
    assert.equal(world.outboxEntries().length, 1, '这条预约必须持久排在队列里等云端')
    assert.equal(naggingModals(world).length, 0, '后台撞上"云端不回"时也不许弹「结果待确认」')

    // 杀进程重开：预约与队列都必须还在（持久化的，不是内存态）。
    world.restartProcess()
    assert.equal(localBookings(world).length, 1, '杀进程重开后课表上这条预约必须还在')
    assert.equal(world.outboxEntries().length, 1, '杀进程重开后队列必须还在，且是同一个号')

    hold.release()
    await world.restoreNetwork(); await drain(world)
    assert.equal(world.outboxEntries().length, 0, '放行后队列必须清空')
    assert.equal(cloudBookings(world).length, 1, '放行后云端必须恰好一条预约（不重复）')
    assert.equal(naggingModals(world).length, 0, '放行收敛后也不许打扰用户')
  })

  // ================================================================ D 完全断网 → 恢复
  await scenario('D 完全断网：本机立即建、重开后仍在、联网后只同步一次', async world => {
    world.seed(seeded()); world.memoryRevision = 0
    world.online = false
    const modal = openModal(world, { studentId: 'stu-1', packageIndex: 0, hour: 13 })
    const result = await instant(modal.confirm(), 'booking')
    assert.ok(result && result.ok, '断网时预约仍须立即完成（本机先行）：' + JSON.stringify(result))
    assert.equal(world.counters.calls.length, 0, '断网时云端参与度必须为 0')
    assert.equal(localBookings(world).length, 1, '断网时课表必须当帧可见')
    assert.equal(naggingModals(world).length, 0, '断网不是失败，不许弹「结果待确认」')

    world.restartProcess()
    assert.equal(localBookings(world).length, 1, '杀掉小程序重开，预约仍在')
    assert.equal(world.outboxEntries().length, 1, '队列必须持久排队等网络')

    world.restoreNetwork(); await drain(world)
    assert.equal(world.outboxEntries().length, 0, '恢复网络后队列必须清空')
    assert.equal(cloudBookings(world).length, 1, '恢复网络后只能同步一次，绝不能变成两条')
    // 后台再跑一轮也不得再产生一条（同一 requestId ⇒ 云端 receipt 认作同一次业务）。
    await require(path.join(root, 'utils', 'sync-engine')).flush()
    assert.equal(cloudBookings(world).length, 1, '后台再跑一轮也不得再产生一条预约')
    assert.equal(naggingModals(world).length, 0, '恢复收敛全程不许打扰用户')
  })

  // ================================================================ E 云端命令成功但响应丢失
  await scenario('E 云端命令成功但响应丢失：不重复预约、不打扰用户、最终收敛', async world => {
    world.seed(seeded()); world.memoryRevision = 0
    world.dropResponse = 1
    const modal = openModal(world, { studentId: 'stu-1', packageIndex: 1, hour: 15 })
    const result = await instant(modal.confirm(), 'booking')
    assert.ok(result && result.ok, '响应丢失也要立即完成：' + JSON.stringify(result))
    assert.equal(localBookings(world).length, 1, '课表必须当帧可见')
    assert.equal(naggingModals(world).length, 0, '响应丢失是后台的事，不许弹「结果待确认」')

    await world.restoreNetwork(); await drain(world)
    assert.equal(world.outboxEntries().length, 0, '收敛后队列必须清空')
    assert.equal(cloudBookings(world).length, 1, '响应丢失绝不能变成两条预约')
    assert.equal(cloudBookings(world)[0].packageId, 'pkg-2', '必须仍是用户点选的那个课包')
    assert.equal(naggingModals(world).length, 0, '收敛后也不许打扰用户')
  })

  // ================================================================ F 连点预约不能生成两条
  await scenario('F 连点预约：同一个动作只能生成一条', async world => {
    world.seed(seeded()); world.memoryRevision = 0
    // 两个独立实例 = 模拟两次都越过了组件内那层连点锁的最坏情况，
    // 兜底必须落在**本机业务事务**上（它与云端跑的是同一份 handlers）。
    const first = openModal(world, { studentId: 'stu-1', packageIndex: 0, hour: 16 })
    const second = openModal(world, { studentId: 'stu-1', packageIndex: 0, hour: 16 })
    const outcome = await instant(Promise.all([first.confirm(), second.confirm()]), 'double-tap')
    assert.ok(Array.isArray(outcome), '两次点击都必须立即返回（不许卡住）：' + JSON.stringify(outcome))
    assert.equal(localBookings(world).length, 1, '连点预约绝不能生成两条')
    await world.restoreNetwork(); await drain(world)
    assert.equal(cloudBookings(world).length, 1, '连点后云端也只能有一条预约')
    assert.equal(world.outboxEntries().length, 0, '收敛后队列必须清空')
  })

  // ================================================================ G packageId 精确对应 + 预约阶段不扣课
  await scenario('G packageId 精确对应用户点选的课包；预约阶段不提前扣课、不产生收入', async world => {
    world.seed(seeded()); world.memoryRevision = 0
    const modal = openModal(world, { studentId: 'stu-1', packageIndex: 1, hour: 17 })
    await instant(modal.confirm(), 'booking')
    assert.equal(localBookings(world)[0].packageId, 'pkg-2', '本机这一帧必须精确对应第 2 个课包')
    assert.equal(studentPackages(world).find(p => p.id === 'pkg-2').remaining, 8, '预约阶段本机绝不能提前扣课')
    assert.equal(world.snapshot().incomes.length, 0, '预约阶段本机绝不能产生收入')

    await world.restoreNetwork(); await drain(world)
    const booking = cloudBookings(world)[0]
    assert.equal(booking.packageId, 'pkg-2', '云端这条必须精确挂在用户点选的课包上')
    assert.equal(booking.status, 'booked', '预约必须落在 booked（扣课时只发生在完课）')
    assert.equal(studentPackages(world)[0].remaining, 17, '另一个课包不能被误扣')
    assert.equal(studentPackages(world).find(p => p.id === 'pkg-2').remaining, 8, '预约阶段云端也绝不能提前扣课')
    assert.equal(world.snapshot().incomes.length, 0, '预约阶段云端也绝不能产生收入')
  })

  // ================================================================ H Production / Sandbox 严格隔离
  await scenario('H Production / Sandbox Outbox 严格隔离：预约只进当前环境的队列桶', async world => {
    world.seed(seeded()); world.memoryRevision = 0
    const outbox = require(path.join(root, 'utils', 'local-outbox'))
    const modal = openModal(world, { studentId: 'stu-1', packageIndex: 0, hour: 18 })
    await instant(modal.confirm(), 'booking')
    assert.deepStrictEqual(world.outboxEntries().map(entry => entry.command), ['createBooking'], '预约必须进 Production 的队列')
    assert.equal(outbox.list({ environment: 'sandbox', datasetId: 'ds-test' }).length, 0, '预约绝不能写进 Sandbox 队列')
    assert.ok(world.outboxEntries().every(entry => entry.environment === 'production'), '队列条目必须记住自己属于哪个环境')
    await world.restoreNetwork(); await drain(world)
    assert.equal(outbox.list({ environment: 'sandbox', datasetId: 'ds-test' }).length, 0, '收敛后 Sandbox 队列仍必须是空的')
  })

  // ================================================================ I 不允许破坏学员的秒进/秒改/秒删
  // 预约改道共用的是 dispatchLocalFirst / Outbox / sync-engine 这套底座，
  // 所以这里必须证明学员那条链**一个字都没被带坏**（深度覆盖在 student-pending-lifecycle）。
  await scenario('I 学员新增/编辑/删除仍是本机先行，且不再弹「已保存在本机，正在同步」', async world => {
    world.seed(empty()); world.memoryRevision = 0
    const mutate = require(path.join(root, 'utils', 'mutate'))
    const saved = await instant(mutate.saveStudentBatch({
      batchKey: 'rb-1', name: '回归学员', phone: '',
      packages: [{ command: 'createCourseSale', payload: { type: '常规训练', total: 10, remaining: 10, quantity: 10, unitPrice: 300, amount: 3000, date: '2026-09-20' }, clientKey: 'pk-9' }]
    }), 'save')
    assert.ok(saved && saved.ok, '新增学员必须仍然立即完成：' + JSON.stringify(saved))
    const id = saved.result.studentId
    const edited = await instant(mutate(null, null, { command: 'updateStudent', payload: { studentId: id, name: '回归学员改名', phone: '' } }), 'edit')
    assert.equal(edited.path, 'local-first', '学员编辑必须仍是本机先行：' + JSON.stringify(edited))
    assert.equal(world.localDB().students.find(s => s.id === id).name, '回归学员改名', '改名必须立刻生效')
    const removed = await instant(mutate(null, null, { command: 'deleteStudent', payload: { studentId: id } }), 'remove')
    assert.equal(removed.path, 'local-first', '学员删除必须仍是本机先行：' + JSON.stringify(removed))
    assert.equal(world.localDB().students.some(s => s.id === id), false, '删除必须立刻生效')
    assert.equal(world.counters.calls.length, 0, '整条学员链在 UI 路径上不得等云端')
    assert.equal(world.counters.toasts.some(item => /正在同步/.test(String(item.title))), false, '正常本机保存不得再提示「正在同步」')

    await world.restoreNetwork(); await drain(world)
    assert.equal(world.outboxEntries().length, 0, '学员链收敛后队列必须清空')
    assert.equal(world.snapshot().students.filter(s => s.status !== 'deleted').length, 0, '不能留下幽灵学员')
  })

  // ================================================================ J 结构契约（钉通道与体验，不钉拼写）
  await scenario('J 结构契约：预约不再走协调器那条独立同步链；正常路径的同步提示已移除', async () => {
    const read = file => fs.readFileSync(path.join(root, file), 'utf8')
    // 剥注释再断言（注释里会提到这些字样，属刻意说明，不是实现）。
    const strip = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const mutateSource = read('utils/mutate.js')
    assert.ok(/LOCAL_FIRST_COMMANDS[\s\S]*'createBooking'/.test(mutateSource), 'createBooking 必须登记在本机先行命令里')
    assert.ok(!/OPTIMISTIC_COMMANDS\s*=\s*Object\.freeze\(\s*\{[^}]*createBooking/.test(mutateSource), 'createBooking 不得再登记为协调器命令')

    const modal = strip(read('components/booking-modal/booking-modal.js'))
    assert.ok(/mutate\(\s*'createBooking'/.test(modal), '预约必须仍走统一写入口')
    assert.ok(!/\bsubmitBooking\s*\(/.test(modal), '组件不得直接触碰协调器')
    assert.ok(!/showLoading/.test(modal), '预约前台路径不得出现等待遮罩')
    // 载荷必须恰好是契约允许的 5 个字段：多传一个（例如 studentName / price）真实云函数就会拒。
    // 只看**交给 mutate 的那个对象**，不看整个文件 —— 非云端分支的 local() 闭包里
    // 本来就要写 studentName（那是本机对象，不是云端载荷），把整文件一起扫会误伤。
    const payloadStart = modal.indexOf('{', modal.indexOf("mutate('createBooking'"))
    const payloadEnd = modal.indexOf('},', payloadStart)
    assert.ok(payloadStart > 0 && payloadEnd > payloadStart, '找不到 mutate 的预约载荷块')
    const payloadBlock = modal.slice(payloadStart, payloadEnd)
    for (const key of ['studentId', 'packageId', 'date', 'hour', 'minute']) {
      assert.ok(payloadBlock.indexOf(key) !== -1, `预约载荷必须带 ${key}`)
    }
    for (const forbidden of ['studentName', 'packageIndex', 'typeName', 'price']) {
      assert.ok(!new RegExp('\\b' + forbidden + '\\b').test(payloadBlock), `预约载荷不得携带契约外字段 ${forbidden}`)
    }
    assert.ok(modal.includes('resolveLocalId'), '选中的学员/课包必须先做本机临时 id → 正式 id 转正再校验')

    // 正常路径的同步提示必须已经移除：本机先行 = 操作已完成，不该再说"正在同步"。
    const students = strip(read('pages/students/students.js'))
    assert.ok(students.indexOf('已保存在本机，正在同步') === -1, '正常本机保存不得再弹「已保存在本机，正在同步」')
    // 安全机制一条都不许因为"去掉提示"而被删掉。
    for (const marker of ['saveStudentBatch', 'localFirstEnabled', 'reportSaveFailure']) {
      assert.ok(students.includes(marker), `学员保存链必须保留 ${marker}`)
    }
    for (const marker of ['enqueueBatch', 'entryByRequestId', 'recordIdMap']) {
      assert.ok(read('utils/local-outbox.js').includes(marker), `Outbox 必须保留 ${marker}`)
    }
    for (const marker of ['getReceipt', 'expectedRevision', 'REVISION_UNKNOWN', 'recordIdMap']) {
      assert.ok(read('utils/sync-engine.js').includes(marker), `同步引擎必须保留 ${marker}`)
    }
    for (const marker of ['REVISION_CONFLICT', 'COMMAND_RESULT_UNKNOWN']) {
      assert.ok(read('utils/cloud-primary-adapter.js').includes(marker), `adapter 必须保留 ${marker}`)
    }
    // 取消仍由协调器负责（本轮不动）—— 别把 createBooking 的改动顺手扩到取消上。
    const schedule = read('pages/schedule/schedule.js')
    assert.ok(schedule.includes('mergePendingBookings('), '课表必须继续在视图层合并待确认预约')
    assert.ok(schedule.includes('resumePendingBookings('), '重进页面必须继续恢复待确认预约')
  })

  console.log(results.join('\n'))
  console.log('booking instant chain PASS（秒约：本机立即建 / 课表当帧可见 / Outbox 静默收敛 / 不弹结果待确认）')
}

run().then(
  () => process.exit(0),
  error => { console.error(error); process.exit(1) }
)
