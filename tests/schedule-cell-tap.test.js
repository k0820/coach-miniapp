// 教练课表「点这一格到底是新建还是进详情」专项测试（1.3.3 真机 Bug → 2026-10-01 修复）
//
// 真机症状（Sandbox 复现）：
//   会员用 M2 课包约了 **2026-10-02 23:30**（确认框正确显示结束 **10-03 00:30**），
//   教练课表 **正确显示** 了这节课；**点它却进不去详情**，反而弹
//   「这个时间排不了，每天最晚 23:30 开课，请选择 23:30 或更早的时间。」
//
// 根因链（已在 `utils/schedule-view.js` 顶部逐条写死，这里用断言钉住）：
//   ① 23:30 + 60 = 次日 00:30 ⇒ 在**当天分钟轴**上占到 1470，**跨过 1440（=24:00）**；
//   ② 课表一天铺 25 个格子（00:00–24:00），hour=24 这一格的存在就是为了**看得见**跨午夜那半截课；
//   ③ "能不能新建"的时间闸挂在**格子的 tap** 上，判据是这个格子的整点 hour
//      （24 > 23:30 ⇒ 判为非法）⇒ 落到这一格的那一下，被当成"要在 24:00 新建"给拒了，
//      而这一格**正被 23:30 那节课占着**。
//
// 修复后的产品规则（每条都有断言）：
//   ① 23:30 是**合法**的开始时间，结束允许跨到次日 00:30；
//   ② **已被占用的时间片，点击必须打开那一节课**，永远不去走新建校验；
//   ③ 「最晚 23:30 开课」只约束**新建 / 改期的开始时间**；
//   ④ 空着且晚于 23:30 的格子仍然**明确提示**（不静默忽略）；
//   ⑤ 待上课列表 / 课程数据**一个字节都不许改**（改动只落在"点击怎么解释"）。
//
// ⛔ 判别力：见 `tests/_schedule-cell-tap-mutate.js`（故意改错 ⇒ 本文件必须变红）。

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const occupancy = require(path.join(ROOT, 'utils/package-occupancy'))
const scheduleView = require(path.join(ROOT, 'utils/schedule-view'))

const readFile = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')

// --------------------------------------------------------------------------- 复刻 Sandbox 真机的那一天
// 2026-10-02：① 10:00 一节普通课（60 分钟） ② **23:30 一节 M2 课（跨午夜到 10-03 00:30）**
const NORMAL = {
  id: 'bk-1000', date: '2026-10-02', hour: 10, minute: 0, status: 'booked',
  plannedMinutes: 60, studentId: 'stu-a', studentName: '甲', typeName: '常规训练'
}
const MIDNIGHT = {
  id: 'bk-2330', date: '2026-10-02', hour: 23, minute: 30, status: 'booked',
  plannedMinutes: 60, studentId: 'stu-m2', studentName: 'M2共享测试学员', typeName: '拉伸恢复'
}
const LONG90 = {
  id: 'bk-2200', date: '2026-10-02', hour: 22, minute: 0, status: 'booked',
  plannedMinutes: 90, studentId: 'stu-b', studentName: '乙', typeName: '常规训练'
}
const DONE = {
  id: 'bk-0800', date: '2026-10-02', hour: 8, minute: 0, status: 'done',
  plannedMinutes: 60, studentId: 'stu-c', studentName: '丙', typeName: '常规训练'
}

const rows = list => list.map(row => JSON.parse(JSON.stringify(row)))
const day = list => rows(list)
// 页面实际拿到的那一格：`CellTapIntentOf(**整份**名单, 这一格的日期, 整点)`。
//   ⛔ 必须传整份名单（不是"这一天那几节"）—— 跨午夜的课从昨天延过来，占的可是今天那一格。
const intent = (list, hour, dateKey = '2026-10-02') => scheduleView.cellTapIntentOf(day(list), dateKey, hour)

const results = []
async function runner(title, fn) {
  try { await fn(); results.push(['PASS', title]) }
  catch (error) { results.push(['FAIL', title + ' ⇒ ' + error.message]); process.exitCode = 1 }
}

async function main() {
  // ---------------------------------------------------------------- ① 23:30 跨午夜：点它必须进详情（Bug 本体）
  await runner('① ⭐ 23:30 跨午夜那节课：落到 24:00 这一格 ⇒ **打开详情**，不再是「这个时间排不了」', async () => {
    const intent24 = intent([NORMAL, MIDNIGHT], 24)
    assert.strictEqual(intent24.kind, 'open', `实测 kind=${intent24.kind} —— 这就是 1.3.3 的真机 Bug（点它应该开详情）`)
    assert.strictEqual(intent24.row && intent24.row.id, 'bk-2330', '打开的必须是 23:30 那节 M2 课（不能串到别的课）')
    // 反向自证：老实现只看格子整点 hour ⇒ 24 会被判 too-late
    assert.strictEqual(occupancy.startsAfterLatest({ hour: 24, minute: 0 }), true,
      '自证：24:00 这**一格**确实晚于最晚开课时间 ⇒ 旧实现必然误伤（这条 Bug 真实存在，不是幻觉）')
  })

  // ---------------------------------------------------------------- ② 同一天其它格子不受影响
  await runner('② 23:00 那格仍然是「可以新建」：它是最后一个合法开课时间（23:30 已取消）', async () => {
    // 23:00 这一格空着（23:30 那节还没开始）⇒ 允许从这里新建（23:00 是合法开始时间）
    assert.strictEqual(intent([NORMAL, MIDNIGHT], 23).kind, 'create')
    assert.strictEqual(occupancy.startsAfterLatest({ hour: 23, minute: 0 }), false)
    // ⛔ 23:30 这一档已取消（二次口径）⇒ 不再是合法开课时间
    assert.strictEqual(occupancy.startsAfterLatest({ hour: 23, minute: 30 }), true,
      '23:30 已取消 ⇒ 不许再作为开课时间')
    assert.strictEqual(occupancy.startsAfterLatest({ hour: 23, minute: 45 }), true, '23:45 必须仍被拒')
  })

  // ---------------------------------------------------------------- ③ 普通课程：占位 ⇒ 详情；空格 ⇒ 新建
  await runner('③ 普通 10:00 课程：点它⇒详情；点到 11:00 空格⇒新建（原行为不变）', async () => {
    const open10 = intent([NORMAL, MIDNIGHT], 10)
    assert.strictEqual(open10.kind, 'open')
    assert.strictEqual(open10.row.id, 'bk-1000')
    assert.strictEqual(intent([NORMAL, MIDNIGHT], 11).kind, 'create', '11:00 空着 ⇒ 允许新建')
    assert.strictEqual(intent([NORMAL, MIDNIGHT], 0).kind, 'create', '凌晨补录通道不被新建闸误伤')
  })

  // ---------------------------------------------------------------- ④ 空着的 24:00 格：仍然明确提示
  await runner('④ 24:00 这一格**空着**时 ⇒ 仍然明确提示「排不了」（不许静默忽略）', async () => {
    const intent24 = intent([NORMAL], 24)
    assert.strictEqual(intent24.kind, 'too-late', '没有课的 24:00 格 ⇒ 不许从这里新建（保持旧提示）')
    assert.strictEqual(intent24.row, null)
    const schedule = readFile('pages/schedule/schedule.js')
    assert.ok(schedule.includes("return wx.showModal({title:'这个时间排不了',content:occupancy.START_TOO_LATE_MESSAGE,showCancel:false})"),
      '提示必须由 cell() 明确弹出（不是静默 return）')
  })

  // ---------------------------------------------------------------- ⑤ 90 分钟跨半点的课：按**真实时长**占位
  await runner('⑤ 90 分钟的课（22:00–23:30）：占位按真实时长，半开区间不越界', async () => {
    const source = day([LONG90])
    const at22 = intent([LONG90], 22)
    assert.strictEqual(at22.kind, 'open', '22:00 起 90 分钟 ⇒ 22:00 这一格必须进详情')
    assert.strictEqual(at22.row.id, 'bk-2200')
    const at23 = intent([LONG90], 23)
    assert.strictEqual(at23.kind, 'open',
      '⭐ 90 分钟的课跨到 23:30 ⇒ 23:00 这一格正有人在上课 ⇒ 点它同样是进详情（不许按 60 分钟粗算）')
    assert.strictEqual(at23.row.id, 'bk-2200')
    // 半开区间：下课那一刻不再占用（否则会把下一节紧挨着的课误判成撞课）
    assert.strictEqual(scheduleView.occupyingAt(source, 23 * 60 + 30), null, '23:30 已下课 ⇒ 那一刻不算占用')
    const atEnd = scheduleView.occupyingAt(source, 23 * 60 + 29)
    assert.strictEqual(atEnd && atEnd.id, 'bk-2200', '23:29 还在上课 ⇒ 仍算占用')
  })

  // ---------------------------------------------------------------- ⑥ 已完成的课：仍然点得开（要看历史）
  await runner('⑥ 已完成的课仍然占座 ⇒ 点它是进详情查看（不是让你在同一格再约一节）', async () => {
    const open = intent([DONE], 8)
    assert.strictEqual(open.kind, 'open')
    assert.strictEqual(open.row.id, 'bk-0800')
  })

  // ---------------------------------------------------------------- ⑦ 已取消的课：不占座（不许挡住新建）
  await runner('⑦ 已取消的课**不占座**：既不弹出详情，也不把这一格堵住', async () => {
    const cancelled = { id: 'bk-1900', date: '2026-10-02', hour: 19, minute: 0, status: 'cancelled', studentId: 'stu-d', studentName: '丁' }
    assert.strictEqual(scheduleView.occupyingAt(day([cancelled]), 19 * 60), null,
      '⛔ 已取消的课占座 ⇒ 教练点那一格会开一个"不存在的一节课"（还会挡住新建）')
    // 页面拿到的行是先过 buildScheduleIndex 的（cancelled 已被移出 byDate）⇒ 双重保险，这里必须一致
    const index = scheduleView.buildScheduleIndex([cancelled, NORMAL])
    assert.ok(!index.byDate['2026-10-02'].some(row => row.id === 'bk-1900'), '取消的课不进 byDate（与课表索引同一口径）')
  })

  // ---------------------------------------------------------------- ⑧ 叠加与脏数据：不许炸，结果稳定
  await runner('⑧ 同一刻叠了多条 / 脏数据：取最晚开始那条，且**不抛异常**', async () => {
    const earlyOfSameSlot = { id: 'bk-aa', date: '2026-10-02', hour: 22, minute: 0, status: 'booked', plannedMinutes: 120 }
    const laterOfSameSlot = { id: 'bk-bb', date: '2026-10-02', hour: 23, minute: 0, status: 'booked', plannedMinutes: 120 }
    const hit = scheduleView.occupyingAt(day([earlyOfSameSlot, laterOfSameSlot]), 23 * 60)
    assert.strictEqual(hit.id, 'bk-bb', '同一刻叠课时取**最晚开始**的那条（最贴近用户点的位置）')
    const reversed = scheduleView.occupyingAt(day([laterOfSameSlot, earlyOfSameSlot]), 23 * 60)
    assert.strictEqual(reversed.id, 'bk-bb', '⛔ 换一下行序就换答案 ⇒ 结果不稳定，教练点两次看到两节课')
    // ⭐ 2026-10-03 补（覆盖真空修复）：上面那两条**开始时间不同**（22:00 / 23:00）⇒ 排序键永远不为 0，
    //    末尾那句 `id` 兜底**一次都没用上** ⇒ 删掉它也照样绿。
    //    真正考验兜底的是**同一刻、同一开始时间的两条**：此时 `diff` 恒为 0，答案就完全交给兜底。
    //    （证据：`_schedule-cell-tap-mutate` ⑧「叠课比较不带 id 兜底」曾经漏网。）
    const dupZ = { id: 'bk-zz', date: '2026-10-02', hour: 23, minute: 0, status: 'booked', plannedMinutes: 60 }
    const dupA = { id: 'bk-aa', date: '2026-10-02', hour: 23, minute: 0, status: 'booked', plannedMinutes: 60 }
    const first = scheduleView.occupyingAt(day([dupZ, dupA]), 23 * 60)
    const second = scheduleView.occupyingAt(day([dupA, dupZ]), 23 * 60)
    assert.ok(first && second, '同一刻的两条都要能查到一条')
    assert.strictEqual(first.id, second.id, '⛔ 开始时间相同时，换行序不许换答案（必须靠 id 兜底）')
    assert.strictEqual(first.id, 'bk-aa', '相同开始时间 ⇒ 取 id 字典序最小那条（稳定、可预测、与行序无关）')
    ;[null, undefined, 'x', NaN, -1, 1.5, ''].forEach(value => {
      assert.strictEqual(scheduleView.occupyingAt([NORMAL], value), null, `脏分钟 ${JSON.stringify(value)} 必须当成"没查到"，不许炸`)
    })
    // ⭐ 2026-10-03 补（覆盖真空修复）：上面那串脏值**没有一个能算进任何一节课的区间** ——
    //    越界（-1 / 1.5 / 空串）或全是 NaN ⇒ 无论有没有那句"必须是整数"的闸，结果都是 null。
    //    也就是说它们只证明了"不会炸"，**证明不了"非整数一律当成没查到"**。
    //    ⛔ 注意别写成 `'600'` 这种：本函数开头有 `Number(minuteOfDay)` 归一化 ⇒ **数字字符串会是整数**，
    //       仍然照常命中 —— 那是设计如此，不是缺陷（所以它抓不到那条变异，别拿它当判据）。
    //    有判别力的是**归一化之后仍不是整数、又恰好落在区间里**的那些值：
    //    少了整数闸，它们会被当成"命中 10:00 那节课（600–660）"。
    //    （证据：`_schedule-cell-tap-mutate` ⑨「脏分钟不再挡」曾经漏网。）
    ;[600.5, '600.5', 659.9].forEach(value => {
      assert.strictEqual(scheduleView.occupyingAt(day([NORMAL]), value), null,
        `非整数 ${JSON.stringify(value)} 必须当成"没查到"（否则会被算成命中 10:00 那节课）`)
    })
    assert.strictEqual(scheduleView.occupyingAt(null, 600), null)
    assert.strictEqual(scheduleView.occupyingAt([null, undefined, {}], 600), null)
    assert.strictEqual(scheduleView.occupyingAt(undefined, 600), null)
  })

  // ---------------------------------------------------------------- ⑨ ⛔ 零写入：点击解释不许改动任何一个业务字段
  await runner('⑨ ⛔ 零写入：整条点击链路不许改 status / 时间 / 学员（也不许替用户"完成/取消"这节课）', async () => {
    const source = day([NORMAL, MIDNIGHT, LONG90, DONE])
    const before = JSON.stringify(source)
    // ⛔ 2026-10-03 修：原来这里写的是 `scheduleView.cellTapIntentOf(source, hour)` —— **只传了 2 个参数**，
    //    真正的签名是 `(rows, dateKey, hour)` ⇒ `dateKey` 收到了 hour、`hour` 收到 undefined，
    //    `cellMinuteOf` 直接判 null ⇒ 每次都返回 `create`，那串断言等于什么都没验。
    //    现在走文件里同一个助手（整份名单 + 真实日期 + 整点），并**逐格核对判词**。
    const expectedKinds = { 8: 'open', 10: 'open', 11: 'create', 22: 'open', 23: 'open', 24: 'open' }
    Object.keys(expectedKinds).forEach(hour => {
      const result = intent(source, Number(hour))
      assert.strictEqual(result.kind, expectedKinds[hour],
        `第 ${hour} 格应判「${expectedKinds[hour]}」（实测 ${JSON.stringify(result)}）`)
    })
    assert.strictEqual(JSON.stringify(source), before, '⛔ 点击解释改了业务数据 ⇒ 教练点一下就把课改了')
    // 页面源码层面：cell() 里不许出现任何写操作（setData 只用于开新建弹窗）
    const schedule = readFile('pages/schedule/schedule.js')
    const cellBody = schedule.slice(schedule.indexOf('  cell(e){'), schedule.indexOf('  add(){'))
    assert.ok(!/saveDB|mutate\(|wx\.setStorageSync/.test(cellBody), 'cell() 里不许出现写操作')
    assert.ok(!/setData\(\{modal:false/.test(cellBody))
    // ⛔ 2026-10-03 **加强**（覆盖真空修复）：上面那句只查 `saveDB` / `mutate(` / `wx.setStorageSync` 三个词，
    //    于是 `rows.forEach(row=>{if(row)row.status='done'})` 这种**直接给业务字段赋值**的写法能整条溜过去
    //    （实测：`_schedule-cell-tap-mutate` ⑭ 曾因此漏网 —— 点一下就把整天的课标成"已完成"）。
    //    判据升级为"结构性"的：这段代码只许**读数据 + 决定跳哪**，任何对属性的赋值都不允许。
    const cellCode = cellBody.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const assignments = cellCode.match(/\.\s*[A-Za-z_$][\w$]*\s*=(?!=)/g) || []
    assert.deepStrictEqual(assignments, [],
      `⛔ 点击链路里不许给任何属性赋值（点一下就改数据）；实测出现 ${JSON.stringify(assignments)}`)
    // 双保险：即使上面的通配被绕过，业务字段一个都不许出现在赋值左边
    assert.ok(!/\.\s*(status|date|hour|minute|plannedMinutes|planned|duration|studentId|studentName|typeName|price|paid|notes|cancelledAt|completedAt)\s*=(?!=)/.test(cellCode),
      '⛔ 点击链路里不许改写任何业务字段')
  })

  // ---------------------------------------------------------------- ⑩ 页面真的在用它（防止"测试绿、页面没改"）
  await runner('⑩ 页面与测试同源于**同一份判据**：cell() 必须调用 `cellTapIntentOf`，且先开门、后验时间', async () => {
    const schedule = readFile('pages/schedule/schedule.js')
    const body = schedule.slice(schedule.indexOf('  cell(e){'), schedule.indexOf('  booking(e){'))
    assert.ok(/scheduleView\.cellTapIntentOf\(/.test(body), '⛔ cell() 没有走共享判据 ⇒ 页面改坏了测试照样绿（假绿）')
    // ⛔ 2026-10-03 修（覆盖真空修复）：原来这里直接写
    //      `body.indexOf("intent.kind==='open'") < body.indexOf("intent.kind==='too-late'")`
    //    —— 只要**一句都不剩**，`indexOf` 双双返回 -1 / 或者只缺 open 那支时返回 -1，
    //    而 `-1 < 正数` 恒真 ⇒ 断言自动通过。整支 open 分支被删掉都能绿。
    //    （证据：`_schedule-cell-tap-mutate` ⑫ 曾因此漏网：mutate 把 open 那行整行替换掉，
    //      结果 `indexOf` 得 -1，顺序断言反而"成立"了。）
    //    ⇒ 先要求"两支都在"，再比先后；并数一下到底有几个分支判词（多出第三支也是漂移）。
    const openAt = body.indexOf("intent.kind==='open'")
    const lateAt = body.indexOf("intent.kind==='too-late'")
    assert.ok(openAt >= 0, '⛔ cell() 里必须真的存在 open 分支（缺了它：点已有的课会去开「新建」弹窗）')
    assert.ok(lateAt >= 0, '⛔ cell() 里必须有 too-late 分支（缺了它：晚于 23:00 的空格会静默无所作为）')
    assert.strictEqual((body.match(/intent\.kind===/g) || []).length, 2,
      '⛔ cell() 只该判 open / too-late 两支（多出来的第三种口径 = 静默漂移）')
    assert.ok(openAt < lateAt,
      '⛔ 顺序错了：先判 open、再判 too-late（反过来就是 1.3.3 那个 Bug）')
    assert.ok(!/occupancy\.startsAfterLatest\(/.test(body),
      '⛔ cell() 里不许再手写时间闸（唯一判据在 schedule-view.cellTapIntentOf 里）')
  })

  // ---------------------------------------------------------------- ⑪ 详情入口只有一处（不许出现第二种口径）
  await runner('⑪ 「进课程详情」的实现只有一处：卡片与格子共用同一个 openBooking', async () => {
    const schedule = readFile('pages/schedule/schedule.js')
    const jumps = schedule.match(/pages\/session\/session\?id=/g) || []
    assert.strictEqual(jumps.length, 1, `⛔ 正式 booking 的跳转出现了 ${jumps.length} 处 ⇒ 出现了第二种详情口径`)
    assert.ok(/openBooking\(row\)\{/.test(schedule), 'openBooking 必须有实现')
    const openBody = schedule.slice(schedule.indexOf('  openBooking(row){'), schedule.indexOf('  add(){'))
    assert.ok(openBody.includes('pages/session/session?id='), '正式跳转必须落在 openBooking 里')
    assert.ok(/booking\(e\)\{[\s\S]{0,220}this\.openBooking\(/.test(schedule), '⛔ 卡片点击必须委托给 openBooking（不是自己再写一遍）')
  })

  // ---------------------------------------------------------------- ⑫ 模板中性命关口：卡片点击永远优先于格子
  await runner('⑫ 模板：课程卡片必须 `catchtap="booking"`（吃掉冒泡，永不落到格子的新建逻辑）', async () => {
    const wxml = readFile('pages/schedule/schedule.wxml')
    ;['catchtap="booking"'].forEach(token => assert.ok(wxml.includes(token), `模板缺 ${token}`))
    // ⚠️ 上面那句 `includes` 只证明"**某处**有"，证明不了"**每一处**都有"：
    //    周视图与日视图各有一张课程卡片，改坏其中一处、另一处还在 ⇒ 断言照旧绿。
    //    （证据：`_schedule-cell-tap-mutate` ⑮「卡片 catchtap 改 bindtap」曾经漏网。）
    //    ⇒ 逐处核对：全文不许出现 `bindtap="booking"`，且**每一张**卡片都得吃掉冒泡。
    const loose = wxml.match(/bindtap="booking"/g) || []
    assert.strictEqual(loose.length, 0,
      `⛔ 卡片点击必须用 catchtap 吃掉冒泡；实测出现 ${loose.length} 处 bindtap="booking"（点卡片会同时新建）`)
    const cardLines = wxml.split('\n').filter(line => /data-pending="\{\{\w+\.pendingKey\}\}"/.test(line))
    assert.ok(cardLines.length >= 2, `周视图与日视图各应有一张课程卡片绑定（实测 ${cardLines.length} 处）`)
    cardLines.forEach(line => assert.ok(line.includes('catchtap="booking"'),
      `⛔ 每一处课程卡片都必须 catchtap="booking"（实测缺：${line.trim().slice(0, 90)}）`))
    const weekRow = wxml.split('\n').find(line => line.includes('class="cell {{cell.today'))
    assert.ok(weekRow && weekRow.includes('bindtap="cell"'), '空格子仍需 bindtap="cell"（新建入口不能丢）')
    const dayRow = wxml.split('\n').find(line => line.includes('class="day-cell'))
    assert.ok(dayRow && dayRow.includes('bindtap="cell"') && dayRow.includes('data-hour="{{item.cell.hour}}"'))
  })

  // ---------------------------------------------------------------- ⑬ 一条数据带 / 不带时长快照都要对
  await runner('⑬ 没有 `plannedMinutes` 快照的老预约：按默认 60 分钟占位（不整格吞掉、也不算脱轨）', async () => {
    const legacy = { id: 'bk-old', date: '2026-10-02', hour: 23, minute: 30, status: 'booked' }
    const hit = scheduleView.occupyingAt(day([legacy]), 24 * 60)
    assert.strictEqual(hit && hit.id, 'bk-old', '老预约（无时长快照）跨午夜也要能点开')
    assert.strictEqual(scheduleView.occupyingAt(day([legacy]), 25 * 60), null, '00:30 下课 ⇒ 之后不算占用')
  })

  // ---------------------------------------------------------------- ⑭ 语义自证：修理ţa后的规则不说谎
  await runner('⑭ 规则自证：**已有课程的详情永不被时间闸拦**，存量的 23:30 课仍打得开、23:30 / 23:45 仍不可新建', async () => {
    // "open" 分支在 23:30、甚至更晚的开始时间上都必须成立（历史里若有更晚的老课，也点得开）
    const lateOld = { id: 'bk-late', date: '2026-10-02', hour: 23, minute: 45, status: 'booked' }
    const hit = scheduleView.occupyingAt(day([lateOld]), 24 * 60)
    assert.strictEqual(hit && hit.id, 'bk-late', '历史里 23:45 的老课也必须点得开（详情不过时间闸）')
    // 但新建仍然拦：空着的格子永远是最高优先/**最晚 23:00** 这条闸只在 create 通道生效
    assert.strictEqual(occupancy.startsAfterLatest({ hour: 23, minute: 45 }), true, '新建 23:45 仍然被拒')
    assert.strictEqual(intent([], 23).kind, 'create', '空格 23:00 ⇒ 新建（合法最后一节的前一格）')
  })

  for (const [state, title] of results) console.log(`${state === 'PASS' ? '✓' : '✗'} ${title}`)
}

main().then(() => {
  if (process.exitCode) { console.error('\n[schedule-cell-tap] FAILED'); return }
  console.log(`\n[schedule-cell-tap] ALL PASS (${results.length} 段)`)
})
