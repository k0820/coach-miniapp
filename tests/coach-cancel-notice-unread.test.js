// 教练端「会员取消通知」——**未读口径**专项测试（1.3.1 真机反馈 → 2026-10-01 定的产品规则）
//
// 真机症状：教练课表顶部那条"会员取消了 N 节课"**永远在**，点完「知道了」还在，
//          因为它统计的是"7 天里所有取消"，而不是"还没看过的"。
//
// 本轮定下的 8 条规则（每条都有断言钉住，见 runner 标题）：
//   ① 顶部**永远只有一条**汇总通知，不叠加卡片
//   ② 只统计**尚未查看**的新取消（历史取消不显示）
//   ③ 点开后按**最新时间在前**列出
//   ④ 点「知道了」⇒ 标记已读，顶部通知**立即消失**
//   ⑤ 之后再有新取消 ⇒ 通知**重新出现并重新累计**
//   ⑥ 已取消的业务记录**继续保留**（不删、不清理）
//   ⑦ 不做完整消息中心
//   ⑧ 已读状态**本机**持久化；跨设备方案另行汇报（本轮不实现）
//
// ⛔ 判别力：见 `tests/_coach-cancel-notice-unread-mutate.js`（故意改错 ⇒ 本文件必须变红）。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')
const scheduleView = require(path.join(ROOT, 'utils/schedule-view'))

const readFile = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')

const CANCELLED = row => Object.assign({ status: 'cancelled' }, row)

// 一次「课表装载」的完整模拟：拿到未读提示 → 点「知道了」→ 再装载。
//   与页面 (`pages/schedule/schedule.js`) 用的是**同一批纯函数**，不是在测试里重算一遍。
function load(rows, seen, todayKey = '2026-10-03') {
  const index = scheduleView.buildScheduleIndex(rows)
  return {
    notice: scheduleView.unseenCancellationsOf(index.cancelledByMember, seen, todayKey),
    cancelledByMember: index.cancelledByMember
  }
}
function acknowledged(seen, notice) {
  return scheduleView.mergeSeenKeys(seen, notice.keys || [])
}

const results = []
async function runner(title, fn) {
  try { await fn(); results.push(['PASS', title]) }
  catch (error) { results.push(['FAIL', title + ' ⇒ ' + error.message]); process.exitCode = 1 }
}

async function main() {
  // --------------------------------------------------------------- ① 顶部只有一条汇总
  await runner('① 顶部**只有一条**汇总：count 是单一数字 + 一条 lines 列表（不叠加卡片）', async () => {
    const rows = [
      CANCELLED({ id: 'b1', date: '2026-10-01', hour: 18, studentName: 'M2共享测试学员' }),
      CANCELLED({ id: 'b2', date: '2026-10-02', hour: 9, studentName: '甲' }),
      { id: 'b3', date: '2026-10-02', hour: 10, status: 'booked', studentName: '乙' }
    ]
    const notice = load(rows, []).notice
    assert.strictEqual(typeof notice.count, 'number', 'count 必须是单个数字（不是数组/列表）')
    assert.strictEqual(notice.count, 2)
    assert.ok(Array.isArray(notice.lines) && notice.lines.length === 2)
    // 结构上也必须只产出一个汇总对象（没有 `notices[]` 这类会渲染成多张卡片的字段）。
    assert.strictEqual(notice.notices, undefined, '⛔ 不许出现"多条通知"结构')
    // 模板里也只有一个通知块。
    const wxml = readFile('pages/schedule/schedule.wxml')
    const blocks = wxml.match(/class="cancel-notice"/g) || []
    assert.strictEqual(blocks.length, 1, `课表模板里取消通知块必须只有 1 个（实测 ${blocks.length}）`)
  })

  // --------------------------------------------------------------- ② 只统计"尚未查看"的新取消
  await runner('② 只报**未读**：全部看过 ⇒ 顶部不再出现（历史取消不打扰）', async () => {
    const rows = [
      CANCELLED({ id: 'h1', date: '2026-09-28', hour: 9, studentName: '老王' }),
      CANCELLED({ id: 'h2', date: '2026-09-29', hour: 10, studentName: '老李' }),
      CANCELLED({ id: 'h3', date: '2026-10-01', hour: 18, studentName: 'M2共享测试学员' })
    ]
    const first = load(rows, []).notice
    assert.strictEqual(first.count, 3, '第一次：3 条都没看过')
    const seen = acknowledged([], first)
    const second = load(rows, seen).notice
    assert.strictEqual(second.count, 0, '⛔ 都看过了 ⇒ 不许再显示（真机症状：通知常驻）')
    assert.strictEqual(second.lines.length, 0)
    assert.strictEqual(second.latest, '')
  })

  // --------------------------------------------------------------- ③ 按最新时间在前
  await runner('③ 未读列表按**最新时间在前**排序（latest 就是最新的那一节）', async () => {
    const rows = [
      CANCELLED({ id: 'b1', date: '2026-09-30', hour: 9, studentName: '早的' }),
      CANCELLED({ id: 'b2', date: '2026-10-02', hour: 15, studentName: '最新的' }),
      CANCELLED({ id: 'b3', date: '2026-10-01', hour: 20, studentName: '中间' })
    ]
    const notice = load(rows, []).notice
    assert.strictEqual(notice.count, 3)
    assert.ok(notice.latest.indexOf('2026-10-02 15:00') === 0, `latest 必须是最新一节（实测 ${notice.latest}）`)
    assert.ok(notice.latest.indexOf('最新的') > 0, 'latest 必须写明是哪位学员')
    assert.deepStrictEqual(notice.lines.map(line => line.slice(0, 16)), [
      '2026-10-02 15:00', '2026-10-01 20:00', '2026-09-30 09:00'
    ], '⛔ 列表必须新→旧')
  })

  // --------------------------------------------------------------- ④ 点「知道了」⇒ 立即消失
  await runner('④ 点「知道了」⇒ 标记已读，顶部通知**立即消失**（且整批标记，不是只标第一条）', async () => {
    const rows = [
      CANCELLED({ id: 'b1', date: '2026-10-01', hour: 18, studentName: 'M2共享测试学员' }),
      CANCELLED({ id: 'b2', date: '2026-10-01', hour: 9, studentName: '甲' }),
      CANCELLED({ id: 'b3', date: '2026-10-02', hour: 10, studentName: '乙' })
    ]
    const notice = load(rows, []).notice
    assert.strictEqual(notice.count, 3)
    assert.strictEqual(notice.keys.length, 3, '⛔ 点一次「知道了」要把**当前这批**全部标记，不是只标第一条')
    const seen = acknowledged([], notice)
    assert.strictEqual(load(rows, seen).notice.count, 0, '标记后必须立即消失')
  })

  // --------------------------------------------------------------- ⑤ 之后再来新取消 ⇒ 重新出现并累计
  await runner('⑤ 之后再来新取消 ⇒ 通知**重新出现并重新累计**（不是永久沉默）', async () => {
    const before = [
      CANCELLED({ id: 'b1', date: '2026-10-01', hour: 18, studentName: 'M2共享测试学员' })
    ]
    const seen = acknowledged([], load(before, []).notice)
    assert.strictEqual(load(before, seen).notice.count, 0)

    // 会员又取消了一节 ⇒ 顶部应重新出现「1」。
    const afterOne = before.concat([CANCELLED({ id: 'b2', date: '2026-10-02', hour: 9, studentName: '甲' })])
    const n1 = load(afterOne, seen).notice
    assert.strictEqual(n1.count, 1, '⛔ 新的取消必须重新出现')
    assert.ok(n1.latest.indexOf('2026-10-02 09:00') === 0, '重新出现的应该是**新的**那一条')

    // 再取消一节 ⇒ 累计成 2（之前看过的那条不再算进来）。
    const afterTwo = afterOne.concat([CANCELLED({ id: 'b3', date: '2026-10-03', hour: 8, studentName: '乙' })])
    const n2 = load(afterTwo, seen).notice
    assert.strictEqual(n2.count, 2, '⛔ 必须是"新取消"重新累计，不含已读的 b1')
    assert.ok(!n2.lines.some(line => line.indexOf('M2共享测试学员') > 0), '已读的那条不许再出现')
  })

  // --------------------------------------------------------------- ⑥ 业务记录继续保留
  await runner('⑥ 已取消的课程记录**一条都不许删**（只记"看过了"，不动数据）', async () => {
    const rows = [
      CANCELLED({ id: 'b1', date: '2026-10-01', hour: 18, studentName: 'M2共享测试学员' }),
      { id: 'b2', date: '2026-10-02', hour: 9, status: 'booked', studentName: '甲' }
    ]
    const snapshot = JSON.stringify(rows)
    const loaded = load(rows, [])
    // 索引里被排除的课**原样留着**（教练要看明细 / 财务要对账都还要用）。
    assert.strictEqual(loaded.cancelledByMember.length, 1)
    assert.strictEqual(loaded.cancelledByMember[0].id, 'b1')
    assert.strictEqual(loaded.cancelledByMember[0].status, 'cancelled')
    const seen = acknowledged([], loaded.notice)
    load(rows, seen)
    assert.strictEqual(JSON.stringify(rows), snapshot, '⛔ 计算与标记都不许改动原始业务数据')
  })

  // --------------------------------------------------------------- ⑦ 7 天窗口外的旧取消不打扰
  await runner('⑦ 窗口（7 天）外的旧取消不打扰，窗口内照旧提示', async () => {
    const stale = [CANCELLED({ id: 'old', date: '2026-09-01', hour: 9, studentName: '很久以前' })]
    assert.strictEqual(load(stale, [], '2026-10-03').notice.count, 0, '超窗口不再提示')
    assert.strictEqual(load(stale, [], '2026-09-03').notice.count, 1, '窗口内照旧提示')
  })

  // --------------------------------------------------------------- ⑧ 已读指纹封顶（不会无限膨胀）
  await runner('⑧ 已读指纹**封顶**：用久了不会无限增长（丢最老的，留最新的）', async () => {
    const cap = scheduleView.MAX_SEEN_KEYS
    assert.ok(cap > 0 && cap <= 2000, '上限是个合理值')
    const many = Array.from({ length: cap + 50 }, (_, i) => `id:old${i}`)
    let merged = scheduleView.mergeSeenKeys(many, [])
    assert.ok(merged.length <= cap, `⛔ 必须截断到 ${cap}（实测 ${merged.length}）`)
    // 追加新 key 后，最老的被挤掉、新的必须还在（否则"新取消"会永远不提示）。
    merged = scheduleView.mergeSeenKeys(merged, ['id:fresh'])
    assert.ok(merged.indexOf('id:fresh') >= 0, '⛔ 新加入的指纹必须保留')
    assert.strictEqual(merged[merged.length - 1], 'id:fresh')
    assert.strictEqual(merged.indexOf('id:old0'), -1, '最老的应被丢掉')
  })

  // --------------------------------------------------------------- ⑨ 指纹稳定且能区分不同课
  await runner('⑨ 已读指纹**稳定且唯一**：正式 id / 同 slot 不同学员都不能混', async () => {
    const row = { id: 'b1', bookingId: 'official-1', date: '2026-10-01', hour: 18, studentId: 'stu-1' }
    assert.strictEqual(scheduleView.cancelSeenKeyOf(row), 'id:official-1', '有正式 bookingId 就用它（最稳）')
    assert.strictEqual(scheduleView.cancelSeenKeyOf({ id: 'b1' }), 'id:b1')
    const a = scheduleView.cancelSeenKeyOf({ date: '2026-10-01', hour: 18, studentId: 'stu-1' })
    const b = scheduleView.cancelSeenKeyOf({ date: '2026-10-01', hour: 18, studentId: 'stu-2' })
    assert.notStrictEqual(a, b, '同一时段不同学员必须是两条')
    // 只用 id 那一段做识别 ⇒ 时间/学员被改也不会让已读失效（避免转正式 id 后重复打扰）。
    assert.strictEqual(scheduleView.cancelSeenKeyOf({ id: 'b1', date: '2026-11-11', hour: 3 }), 'id:b1')
  })

  // --------------------------------------------------------------- ⑩ 环境与账本隔离
  await runner('⑩ 已读状态按「环境 + 账本」分开存：正式区/测试区、A/B 教练互不串', async () => {
    const p1 = scheduleView.seenStorageKeyOf('production', 'ds-a')
    const s1 = scheduleView.seenStorageKeyOf('sandbox', 'ds-a')
    const p2 = scheduleView.seenStorageKeyOf('production', 'ds-b')
    assert.notStrictEqual(p1, s1, '⛔ 正式区与测试区必须分开（否则一边点过，另一边永远收不到）')
    assert.notStrictEqual(p1, p2, '⛔ 两本账必须分开')
    assert.strictEqual(p1, scheduleView.seenStorageKeyOf('production', 'ds-a'), '同环境同账本必须稳定（否则已读会失效）')
    assert.ok(p1.indexOf(scheduleView.SEEN_KEY_PREFIX) === 0, 'key 必须有统一前缀')
  })

  // --------------------------------------------------------------- ⑪ 页面必须走共享口径
  await runner('⑪ 页面走共享口径，不许自己写 status 判断，也不许绕过已读', async () => {
    const schedule = readFile('pages/schedule/schedule.js')
    assert.ok(schedule.includes('scheduleView.unseenCancellationsOf('), '课表必须走「未读」口径')
    assert.ok(schedule.includes('scheduleView.mergeSeenKeys('), '点「知道了」必须写回已读')
    assert.ok(schedule.includes('scheduleView.seenStorageKeyOf('), '已读必须按环境+账本分开存')
    // ⛔ 先剥掉注释行再判：注释里本来就会写"不许写 status === 'cancelled'"这种反例，别把自己的注释当成代码。
    const codeOnly = schedule.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
    assert.ok(!/status\s*===\s*'cancelled'/.test(codeOnly), '课表里不许再散落手写判断')
    const view = readFile('utils/schedule-view.js')
    assert.ok(view.includes('occupancy.isCancelled('), '已取消判定必须复用唯一口径')
  })

  // --------------------------------------------------------------- ⑫ 不做消息中心
  // ⭐ 2026-10-06 口径更新：用户本轮**明确要求**做站内消息中心（微信一次性订阅一条只够一条，
  //    必须有一个不限次数的兜底）⇒ 旧断言"不许新建消息中心页面"已作废，改成"只允许**一个**、
  //    且必须受环境门禁"（⛔ 正式区没有这套集合 ⇒ 入口与页面都得是藏得住的）。
  await runner('⑫ 消息中心**只允许一个**页面，且必须受环境门禁（正式区整个藏起来）', async () => {
    const pages = fs.readdirSync(path.join(ROOT, 'pages'))
    const center = pages.filter(name => /message|notice|inbox|center/i.test(name))
    assert.deepStrictEqual(center, ['notification-inbox'], `⛔ 消息中心页面只允许一个（实测 ${center.join(',')}）`)
    const page = readFile('pages/notification-inbox/notification-inbox.js')
    assert.ok(page.includes('inbox.available()'), '⛔ 消息中心页没有做环境门禁')
    const client = readFile('utils/notification-inbox.js')
    assert.ok(client.includes('coachBusinessSandboxCommand') === false, '⛔ 客户端写死了 Sandbox 云函数名')
    const entries = readFile('pages/stats/stats.wxml') + readFile('pages/member-profile/member-profile.wxml')
    assert.ok(/wx:if="{{inboxAvailable}}"/.test(entries), '⛔ 入口没有环境门禁 ⇒ 正式区会留下一个点了就报错的按钮')
    const view = readFile('utils/schedule-view.js')
    assert.ok(!/wx\.|require\(['"]\.\/cloud/.test(view), '共享口径里不许出现 wx 调用（必须保持纯函数）')
  })

  // --------------------------------------------------------------- ⑬ 弹层：只列有限行数 + 明确"还有 N 节"
  await runner('⑬ 弹层一次只列有限行数，超出要写明「还有 N 节」（不能用截断糊过去）', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => CANCELLED({ id: `b${i}`, date: '2026-10-01', hour: i + 6, studentName: `学员${i}` }))
    const notice = load(rows, []).notice
    assert.strictEqual(notice.count, 9)
    assert.strictEqual(notice.lines.length, scheduleView.NOTICE_MAX_LINES, '汇总里最多列 8 行')
    const schedule = readFile('pages/schedule/schedule.js')
    assert.ok(/slice\(0,\s*NOTICE_LINES_IN_MODAL\)/.test(schedule), '弹层必须限制行数')
    assert.ok(schedule.includes('还有 ${rest} 节'), '⛔ 超出部分必须明确写出"还有 N 节"')
    assert.ok(schedule.includes("confirmText: '知道了'"), '必须有「知道了」按钮')
    assert.ok(/success:\s*\(\)\s*=>\s*this\.markCancelSeen/.test(schedule), '⛔ 「知道了」必须真的标记已读（不是只关掉弹窗）')
  })

  for (const [state, title] of results) console.log(`${state === 'PASS' ? '✓' : '✗'} ${title}`)
}

main().then(() => {
  if (process.exitCode) { console.error('\n[coach-cancel-notice-unread] FAILED'); return }
  console.log(`\n[coach-cancel-notice-unread] ALL PASS (${results.length} 段)`)
})
