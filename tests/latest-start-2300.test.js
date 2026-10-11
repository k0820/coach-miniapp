// 2026-10-01 **二次口径**（1.3.5 真机体验后产品定稿）：**取消 23:30 开课，简化 MVP**。
//
// 最终规则（用户逐条确认）：
//   ① 会员预约 / 教练新建 / 改期，**最晚开始时间一律 23:00**（23:30 选不到、排不进、改不过去）；
//   ② 23:00 开的课**允许正常结束于 24:00**（23:00 + 60 ⇒ 24:00，正好卡在当天界上）；
//   ③ 移除周课表 / 日课表里次日的「接上节」视觉片段，课表恢复简洁布局；
//   ④ ⛔ **已经存在**的 23:30 跨午夜课：不删、不改、不迁移，**仍可从开始日的卡片打开详情**；
//   ⑤ 旧跨午夜课**仍然占用**次日 00:00–00:30 ⇒ 谁也不能在那段时间新建 / 改期出新冲突；
//   ⑥ 说明文字不许再写"最晚 23:30 开课"。
//
// ⛔ 本文件最容易搞错、也最值得钉死的一点：**「不画」不等于「不占」**。
//    渲染层把次日那一段拿掉了（要求③），但占用判定必须原封不动（要求⑤）——
//    只要有人为了"课表变简洁了"顺手把跨午夜占用也一起删掉，⑤ 就会立刻变红。
//
// ⛔ 本文件**只读**：不写云端、不碰 Sandbox、不创建任何业务记录（连临时预约都不建）。

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const localOccupancy = require('../utils/package-occupancy')
const cloudOccupancy = require('../cloudfunctions/coachBusinessCommand/occupancy')
const scheduleView = require('../utils/schedule-view')
const view = require('../utils/member-booking-view')
const request = require('../utils/member-booking-request')
const manage = require('../utils/member-booking-manage')

const readFile = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')

// ⭐ 一条**存量**的跨午夜旧课（Sandbox 里真实存在的那条：10-02 23:30 → 10-03 00:30）。
//   ⛔ 它是"历史数据"，不是本次新建的 ⇒ 任何闸门都不许碰它。
const LEGACY = { id: 'legacy-2330', date: '2026-10-02', hour: 23, minute: 30, plannedMinutes: 60, status: 'booked' }
const LEGACY_SNAPSHOT = JSON.parse(JSON.stringify(LEGACY))

const results = []
async function runner(title, fn) {
  try { await fn(); results.push(['PASS', title]) }
  catch (error) { results.push(['FAIL', title]); console.log(`   ↳ ${error.message}`) }
}

async function main() {
  // ------------------------------------------------------------------ ① 三个入口都不许出现 23:30
  await runner('① 判据：23:00 是最后合法开课时间，23:30 已归为「开课太晚」（两端同一把尺）', async () => {
    assert.strictEqual(localOccupancy.LATEST_START_MINUTES, 23 * 60, '本机最晚开课必须是 23:00')
    assert.strictEqual(cloudOccupancy.LATEST_START_MINUTES, 23 * 60, '云端最晚开课必须是 23:00（孪生不许漂移）')
    assert.strictEqual(localOccupancy.LATEST_START_LABEL, '23:00')
    assert.strictEqual(cloudOccupancy.LATEST_START_LABEL, '23:00')
    assert.strictEqual(localOccupancy.startsAfterLatest({ hour: 23, minute: 30 }), true, '23:30 必须判为"晚于最晚开课"')
    assert.strictEqual(localOccupancy.startsAfterLatest({ hour: 23, minute: 0 }), false, '23:00 必须放行')
    for (const occ of [localOccupancy, cloudOccupancy]) {
      assert.strictEqual(occ.startVerdictOf({ hour: 23, minute: 0 }), 'ok')
      assert.strictEqual(occ.startVerdictOf({ hour: 23, minute: 30 }), 'too-late')
    }
  })

  await runner('② 会员预约：23:30 这一格**压根不生成**，且提交预检会明确拒绝', async () => {
    const slots = view.slotsFor({ dateKey: '2026-10-20', busy: [], todayKey: '2026-01-01' })
    assert.ok(!slots.some(slot => slot.start > 23 * 60), '23:00 之后不许出现任何起点（含 23:30）')
    assert.strictEqual(slots[slots.length - 1].start, 23 * 60, '最后一格必须是 23:00')
    // ⭐ 2026-10-03 补（覆盖真空修复）：上面那两条**只靠"默认 60 分钟"间接成立** ——
    //    23:30 + 60 恰好越过 24:00，被"结束跨午夜"那条规则顺手挡掉了，
    //    于是「最晚开始 23:00」这条规则**本身**从没被钉住。
    //    证据：`_latest-start-2300-mutate` ③（把会员端上界偷偷放到 23:30）曾经**漏网**。
    //    ⇒ 换几个时长各量一遍：**不论一节课上多久，起点都不许越过 23:00**。
    //    （时长 30 是判别关键：23:30 + 30 = 24:00 不越日界 ⇒ 只有这一档能把上界漂移暴露出来。）
    for (const length of [30, 45, 60, 90]) {
      const byLength = view.slotsFor({ dateKey: '2026-10-20', busy: [], todayKey: '2026-01-01', length })
      assert.ok(byLength.length > 0, `时长 ${length} 分钟必须真的排出格子（防空表造成的假绿）`)
      const over = byLength.filter(slot => slot.start > 23 * 60)
      assert.strictEqual(over.length, 0,
        `时长 ${length} 分钟时也不许出现晚于 23:00 的起点（实测 ${JSON.stringify(over.map(slot => slot.startText))}）`)
      assert.ok(!byLength.some(slot => slot.start > localOccupancy.LATEST_START_MINUTES),
        '任何时长下，起点上界都只能是 occupancy.LATEST_START_MINUTES')
    }
    // 就算有人绕过 UI 直接提交 23:30 的 slot ⇒ 客户端预检也必须拒
    const slot = { start: 23 * 60 + 30, end: 23 * 60 + 90, available: true }
    const built = request.buildBookingRequest({ dateKey: '2026-10-20', slot, coachKey: 'coach-a', packageViewId: 'pv-1', todayKey: '2026-10-01' })
    assert.strictEqual(built.ok, false, '会员预约 23:30 必须被拒')
    assert.ok(String((built.errors || []).join('|')).includes(localOccupancy.START_TOO_LATE_MESSAGE),
      `必须给出 occupancy 那唯一一句提示（实测 ${JSON.stringify(built.errors)}）`)
  })

  await runner('③ 改期：改到 23:30 同样被拒（不许"先约早的再改晚的"绕过）', async () => {
    const row = { historyId: 'h1', bookingViewId: 'h1', date: '2026-10-20', hour: 10, minute: 0, status: 'booked' }
    const at = start => ({ start, end: start + 60, available: true })
    const halfPast = manage.buildRescheduleRequest({ bookingViewId: 'h1', ownViewIds: ['h1'], row, dateKey: '2026-10-20', slot: at(23 * 60 + 30), todayKey: '2026-10-01' })
    assert.strictEqual(halfPast.ok, false, '改到 23:30 必须被拒')
    assert.strictEqual(halfPast.code, 'BOOKING_START_TOO_LATE', `实测 ${JSON.stringify(halfPast)}`)
    const ok = manage.buildRescheduleRequest({ bookingViewId: 'h1', ownViewIds: ['h1'], row, dateKey: '2026-10-20', slot: at(23 * 60), todayKey: '2026-10-01' })
    assert.strictEqual(ok.ok, true, `改到 23:00 必须放行（实测 ${JSON.stringify(ok)}）`)
  })

  // ------------------------------------------------------------------ ② 23:00 允许结束于 24:00
  await runner('④ ⭐ 23:00 开课 + 60 分钟 ⇒ **24:00 结束合法**（正好卡在当天界上）', async () => {
    assert.strictEqual(localOccupancy.plannedEndMinutes({ hour: 23, minute: 0 }, 60), 24 * 60, '结束分钟必须是 1440（= 24:00）')
    assert.strictEqual(localOccupancy.startVerdictOf({ hour: 23, minute: 0 }), 'ok')
    const slots = view.slotsFor({ dateKey: '2026-10-20', busy: [], todayKey: '2026-01-01' })
    const last = slots[slots.length - 1]
    assert.strictEqual(last.start, 23 * 60)
    assert.strictEqual(last.end, 24 * 60, '23:00 那格必须结束于 24:00')
    assert.strictEqual(last.label, '23:00–24:00', `显示必须是 23:00–24:00（实测 ${last.label}）`)
    assert.strictEqual(last.crossesMidnight, false, '⛔ 它不跨午夜 ⇒ 不许标记成跨午夜')
    // 整天最后一节与次日 00:00 首尾相接 ⇒ 不算冲突（半开区间）
    const a = localOccupancy.intervalOf({ date: '2026-10-02', hour: 23, minute: 0, plannedMinutes: 60 })
    const b = localOccupancy.intervalOf({ date: '2026-10-03', hour: 0, minute: 0, plannedMinutes: 60 })
    assert.strictEqual(localOccupancy.intervalsOverlap(a, b), false, '23:00–24:00 与次日 00:00–01:00 相邻不重叠')
  })

  // ------------------------------------------------------------------ ③ 旧课仍能打开（要求⑥）
  await runner('⑤ ⭐ 存量的 23:30 跨午夜课：**仍能打开**，且数据一个字节都没被改', async () => {
    const rows = [LEGACY]
    // ① 开始日那张**卡片**仍在（10-02 23:00 那一格）⇒ 点卡片就能进详情（渲染层给的入口没被拆掉）
    const index = scheduleView.buildScheduleIndex(rows)
    assert.ok((index.bySlot['2026-10-02|23'] || []).some(row => row.id === LEGACY.id), '开始日的卡片必须还在 ⇒ 点它就能进详情')
    // ② 23:30 那一刻仍然属于它 ⇒ 任何"这一刻归谁"的判定都还认这条旧课
    assert.strictEqual(scheduleView.occupyingAt(rows, 23 * 60 + 30).id, LEGACY.id)
    // ③ 开始日 23:00 那格的**空白区**仍然是 create（23:00 那一刻没人上课）⇒
    //    与普通课行为一致：不因为旁边有条跨午夜课就把整格锁死。
    assert.strictEqual(scheduleView.cellTapIntentOf(rows, '2026-10-02', 23).kind, 'create')
    // ⛔ 闸门不审判存量：它是历史数据，不是"要新建的课"
    assert.strictEqual(scheduleView.occupyingAt(rows, 23 * 60 + 30).id, LEGACY.id, '23:30 这一刻仍被它占着')
    assert.deepStrictEqual(LEGACY, LEGACY_SNAPSHOT, '⛔ 这些只读函数不许改动原对象')
  })

  // ------------------------------------------------------------------ ④ 旧课仍占用次日（要求⑦）
  await runner('⑥ ⭐⭐ 旧课**仍然占用**次日 00:00–00:30 ⇒ 不许在那段时间排新课', async () => {
    const rows = [LEGACY]
    // ① 点次日 00:00 那片空白 ⇒ 打开这一节课（不是新建、也不是"太晚不能排"）
    const next = scheduleView.cellTapIntentOf(rows, '2026-10-03', 0)
    assert.strictEqual(next.kind, 'open', `次日 00:00 必须判为"已占用"⇒ 打开那一节课（实测 ${JSON.stringify(next)}）`)
    assert.strictEqual(next.row.id, LEGACY.id)
    assert.strictEqual(scheduleView.cellOccupantsOf(rows, '2026-10-03', 0).id, LEGACY.id)
    // ①b ⭐ 2026-10-03 补（覆盖真空修复）：**"这一格有课"必须先于"这一格太晚"** ——
    //     顺序反了就是 1.3.3 那个真机 Bug 的原样（教练点不开自己那节跨午夜的课）。
    //     上面 ① 只在**次日 00:00** 验了"有课"，可那一刻本来就不"太晚"⇒ 两个判断的先后根本没用上。
    //     真正考验顺序的是**同时成立**的那一格：开始日的 24:00 ——
    //     既被这节 23:30 的旧课占着，又晚于最晚开课时间 23:00。
    //     证据：`_latest-start-2300-mutate` ⑤（把顺序换回去）曾经**漏网**。
    const startDayTail = scheduleView.cellTapIntentOf(rows, '2026-10-02', 24)
    assert.strictEqual(localOccupancy.startsAfterLatest({ hour: 24, minute: 0 }), true,
      '前提：24:00 这一刻确实晚于最晚开课时间（否则本断言测不到"顺序"）')
    assert.strictEqual(scheduleView.cellOccupantsOf(rows, '2026-10-02', 24).id, LEGACY.id,
      '前提：24:00 那一格确实被这节跨午夜旧课占着（与"太晚"同时成立）')
    assert.strictEqual(startDayTail.kind, 'open',
      `同时"有课"又"太晚"的那一格必须判 open（顺序反了会误判成 too-late ⇒ 点不开自己的课；实测 ${JSON.stringify(startDayTail)}）`)
    assert.strictEqual(startDayTail.row.id, LEGACY.id)
    // ② 分享出去的"可约时间"里，那段仍然是 busy
    const busy = scheduleView.busyRangesOf(rows, '2026-10-03')
    assert.deepStrictEqual(busy, [{ start: 0, end: 30 }], `次日被占的必须是 00:00–00:30（实测 ${JSON.stringify(busy)}）`)
    // ③ 真冲突：想在次日 00:00 排一节 ⇒ 必须重叠
    const legacy = localOccupancy.intervalOf(LEGACY)
    const clash = localOccupancy.intervalOf({ date: '2026-10-03', hour: 0, minute: 0, plannedMinutes: 60 })
    assert.strictEqual(localOccupancy.intervalsOverlap(legacy, clash), true, '次日 00:00–00:30 与旧课真重叠 ⇒ 不许放行')
    // ④ 首尾相接（00:30 起）不算冲突
    const adjacent = localOccupancy.intervalOf({ date: '2026-10-03', hour: 0, minute: 30, plannedMinutes: 60 })
    assert.strictEqual(localOccupancy.intervalsOverlap(legacy, adjacent), false, '00:30 起首尾相接 ⇒ 不冲突')
    // ⑤ 01:00 那格已经跟旧课无关 ⇒ 空的，可以新建
    assert.strictEqual(scheduleView.cellTapIntentOf(rows, '2026-10-03', 1).kind, 'create')
  })

  // ------------------------------------------------------------------ ⑤ 课表不再显示「接上节」（要求⑤）
  await runner('⑦ ⭐ 课表不再显示次日「接上节」片段（渲染层已拆干净）', async () => {
    const wxml = readFile('pages/schedule/schedule.wxml')
    const wxss = readFile('pages/schedule/schedule.wxss')
    const page = readFile('pages/schedule/schedule.js')
    // ⛔ 只匹配**标签 / 属性 / 样式规则**的真身，不匹配注释里提到的名字（注释里保留历史说明是允许的）
    assert.strictEqual((wxml.match(/wx:if="\{\{(?:booking|item)\.continuation\}\}"/g) || []).length, 0, 'wxml 里不许再有「接上节」条件标签')
    assert.ok(!wxml.includes('接上节'), 'wxml 里不许再出现「接上节」文案')
    assert.ok(!/continuation\?\s*'/.test(wxml), 'wxml 里不许再有 continuation 三元类')
    assert.ok(!/\.booking-cont\{/.test(wxss) && !/\.day-booking-cont\{/.test(wxss) && !/\.day-cont-tag\{/.test(wxss),
      'wxss 里不许再残留片段样式')
    assert.ok(!/continuation:/.test(page), '页面 data 里不许再产出 continuation 字段')
    // ⛔ 计算层也拆干净：不再有"次日片段"这套东西（留着迟早被谁重新接回去）
    assert.strictEqual(scheduleView.buildSpillIndex, undefined, 'buildSpillIndex 必须已删除')
    assert.strictEqual(scheduleView.spillSegmentsOf, undefined, 'spillSegmentsOf 必须已删除')
    assert.strictEqual(scheduleView.buildScheduleIndex([LEGACY]).spillBySlot, undefined, '课表索引不再产出 spillBySlot')
    // 次日那一格**没有**渲染块（不画 ⇒ 但上面⑥证明它仍然被占着）
    assert.deepStrictEqual(scheduleView.buildScheduleIndex([LEGACY]).bySlot['2026-10-03|0'], undefined,
      '次日 00:00 那一格不画任何东西（占用由绝对时间轴负责，不靠渲染）')
  })

  await runner('⑧ 开始日那段仍然**截断在 24:00**（不溢出到格子外面），普通课一个像素不动', async () => {
    const page = readFile('pages/schedule/schedule.js')
    assert.ok(/crossesMidnight\s*=\s*startMinute \+ planned > 24 \* 60/.test(page), '必须仍按"是否跨过 24:00"判断')
    assert.ok(/clippedEnd = Math\.min\(startMinute \+ planned, 24 \* 60\)/.test(page), '跨午夜的高度必须截断在 24:00')
    const wxml = readFile('pages/schedule/schedule.wxml')
    // ⚠️ 2026-10-04：课程块加了**跨行标记**（90 分钟要画到下一行），类名变成
    //    `class="booking {{booking.spansRows?'booking-spans':''}}"` ⇒ 这里跟"仍以 booking 开头"，
    //    ⛔ 不许放宽成"随便有个 booking 字样"（那会让这条契约形同虚设）。
    // ⚠️ 字符类里**必须写 `\s` 而不是 `s`**：`{{` 前面那个分隔符是**空格**（`booking {{…}}`），
    //    `[s{]` 只认字母 s 和花括号 ⇒ 会假红。`\s` 覆盖空格/制表/换行，才是对的。
    assert.ok(/class="booking[\s{]/.test(wxml), '课程块本体照旧渲染（只是不再有片段变体）')
  })

  // ------------------------------------------------------------------ ⑥ 说明文字（要求⑩）
  await runner('⑨ 说明文字：不许再出现"最晚 23:30 开课 / 最后一个开课时间 23:30"', async () => {
    const files = [
      'utils/package-occupancy.js', 'utils/schedule-view.js', 'utils/member-booking-view.js',
      'utils/member-booking-request.js', 'utils/member-booking-manage.js', 'utils/cloud-command-engine.js',
      'cloudfunctions/coachBusinessCommand/occupancy.js', 'cloudfunctions/coachBusinessCommand/handlers.js',
      'cloudfunctions/coachBusinessCommand/memberBooking.js',
      'pages/schedule/schedule.js', 'pages/schedule/schedule.wxml',
      'components/booking-modal/booking-modal.wxml', 'pages/session/session.wxml'
    ]
    for (const relative of files) {
      const text = readFile(relative)
      // ⛔ 只抓**把 23:30 当成现行规则**的写法；"取消 23:30 开课""存量的 23:30 旧课"是正确表述，不许误伤。
      const bad = text.split('\n').filter(line => /最晚\s*23:30/.test(line) || /最后一个开课时间 23:30/.test(line) || /23:30 是当天最后一个开课时间/.test(line))
      assert.strictEqual(bad.length, 0, `${relative} 仍在写旧口径：${bad[0] || ''}`)
    }
    assert.ok(localOccupancy.START_TOO_LATE_MESSAGE.includes('23:00'), '提示必须说出 23:00')
    assert.ok(!localOccupancy.START_TOO_LATE_MESSAGE.includes('23:30'), '提示不许再说 23:30')
    assert.ok(localOccupancy.START_WINDOW_MESSAGE.includes('06:00–23:00'), '窗口说明必须是 06:00–23:00')
  })

  await runner('⑩ 入口选择器上界同步到 23:00（不能"能选 23:30 再被拒"）', async () => {
    assert.ok(/end="23:00"/.test(readFile('components/booking-modal/booking-modal.wxml')), '排课弹窗时间选择器上界必须是 23:00')
    assert.ok(/end="23:00"/.test(readFile('pages/session/session.wxml')), '改期时间选择器上界必须是 23:00')
  })

  const failed = results.filter(row => row[0] === 'FAIL').length
  results.forEach(([state, title]) => console.log(`${state === 'PASS' ? 'PASS' : 'FAIL'} ${title}`))
  if (!failed) process.stdout.write('ALL LATEST START 23:00 TESTS PASSED\n')
  else process.exitCode = 1
}

main().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
