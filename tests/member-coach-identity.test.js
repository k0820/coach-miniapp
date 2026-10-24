// 会员端「同名教练分不清」专项测试（2026-10-01 真机 → Sandbox 证据）
//
// 真机事实：会员约课页出现**两个一模一样**的「Sandbox教练」 ⇒ 会员不知道哪个是管理人、
//   哪个是被授权授课的教练，点错一个就等于约错教练。
//
// 用户定稿的规则：
//   ① 教练选项显示**身份**：管理人 / 授课教练；
//   ② 身份还分不开（同名又同身份）⇒ 再显示**教练码尾号**；
//   ③ ⛔ 不展示完整内部 id；
//   ④ ⛔ 不改授权关系、不改排序、不改默认选择；
//   ⑤ 先确认云端投影是否提供了所需字段 ⇒ 不足才做最小安全补充。
//
// ⛔ 判别力：见 `tests/_member-coach-identity-mutate.js`（故意改错 ⇒ 本文件必须变红）。

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const view = require(path.join(ROOT, 'utils/member-booking-view'))
const businessView = require(path.join(ROOT, 'utils/schedule-view'))

const readFile = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')

const SANDBOX_A = { coachKey: 'k-a', displayName: 'Sandbox教练', bookable: true, role: '管理人', roleKey: 'owner', codeTail: '1A2B' }
const SANDBOX_B = { coachKey: 'k-b', displayName: 'Sandbox教练', bookable: true, role: '授课教练', roleKey: 'teaching', codeTail: '9F8E' }
const OTHER = { coachKey: 'k-c', displayName: '王教练', bookable: true, role: '管理人', roleKey: 'owner', codeTail: '7C6D' }

const results = []
async function runner(title, fn) {
  try { await fn(); results.push(['PASS', title]) }
  catch (error) { results.push(['FAIL', title + ' ⇒ ' + error.message]); process.exitCode = 1 }
}

async function main() {
  // ---------------------------------------------------------------- ① 身份来自云端投影（要求⑤ 的答案）
  await runner('① **字段不足**是真机事实：原题投影只有 coachKey/displayName/bookable ⇒ 已做最小补充', async () => {
    const service = readFile('cloudfunctions/readMyMemberData/service.js')
    const start = service.indexOf('const addScope = (coachId, datasetId, claim) => {')
    assert.ok(start >= 0, '找不到 addScope（结构变了？必须重新审计）')
    const body = service.slice(start, service.indexOf('\n  }', start))
    // ⭐ 补充的两个字段：**不查库**（都由已有数据现算）
    assert.ok(body.includes('roleKey') && body.includes('codeTail'), '投影必须带出 roleKey / codeTail')
    const queriesBefore = (body.match(/await /g) || []).length
    assert.strictEqual(queriesBefore, 0, '⛔ addScope 里不许出现任何 await（零额外数据库往返）')
    assert.ok(/const role = String\(coachId \|\| ''\) === String\(claim\.coachId \|\| ''\) \? 'owner' : 'teaching'/.test(body),
      '认领的那位 ⇒ 管理人；授权来的 ⇒ 授课教练（判据必须在服务端，不许客户端猜）')
  })

  // ---------------------------------------------------------------- ② 身份 label 正确
  await runner('② 两个同名教练 ⇒ 一个标「管理人」、一个标「授课教练」', async () => {
    const rows = view.coachOptionsView([SANDBOX_A, SANDBOX_B])
    assert.strictEqual(rows[0].roleText, '管理人')
    assert.strictEqual(rows[1].roleText, '授课教练')
    rows.forEach(row => assert.strictEqual(row.hasRole, true))
  })

  // ---------------------------------------------------------------- ③ 尾号只在"同名又同身份"才出现（要求②）
  await runner('③ ⭐ 身份能区分 ⇒ **不带**尾号；同名又同身份 ⇒ 才补尾号', async () => {
    const distinct = view.coachOptionsView([SANDBOX_A, SANDBOX_B])
    assert.strictEqual(distinct[0].showCodeTail, false, '身份已经能区分 ⇒ 不多打这 4 个字符')
    assert.strictEqual(distinct[1].showCodeTail, false)
    const twins = view.coachOptionsView([
      { coachKey: 'k-t1', displayName: '同名教练', role: '授课教练', roleKey: 'teaching', codeTail: 'ABCD' },
      { coachKey: 'k-t2', displayName: '同名教练', role: '授课教练', roleKey: 'teaching', codeTail: 'EFGH' }
    ])
    assert.strictEqual(twins[0].showCodeTail, true, '同名又同身份 ⇒ 必须亮尾号')
    assert.strictEqual(twins[0].codeTail, 'ABCD')
    assert.strictEqual(twins[1].codeTail, 'EFGH')
    // 名字不同 ⇒ 根本不需要尾号
    const different = view.coachOptionsView([OTHER, SANDBOX_B])
    assert.strictEqual(different[0].showCodeTail, false)
  })

  // ---------------------------------------------------------------- ④ 不出完整内部 id（要求③）
  await runner('④ ⛔ 绝不出完整 id：只有公开码的**后 4 位**，coachId / 内部字段一律不下发', async () => {
    const service = readFile('cloudfunctions/readMyMemberData/service.js')
    const tailAt = service.indexOf('const codeTailOf')
    const codeTail = service.slice(tailAt, service.indexOf('\n  }', tailAt))
    assert.ok(codeTail.includes('.replace(/[^A-Za-z0-9]/g, \'\')'), '只保留安全字符（防止把怪字符带进界面）')
    assert.ok(codeTail.includes('slice(-4)'), '只取后 4 位 ⇒ 完整公开码也不出')
    const start = service.indexOf('const addScope = (coachId, datasetId, claim) => {')
    const body = service.slice(start, service.indexOf('\n  }', start))
    assert.ok(!body.includes('coachId:'), '⛔ 投影里不许出现 coachId（内部 id）')
    // ⛔ 2026-10-03 **加强**（覆盖真空修复）：上面那句只挡得住**带冒号**的写法，
    //    而 JS 的**简写属性**（`{ coachId, coachKey, … }`）里根本没有冒号 ⇒ `includes('coachId:')` 恒为 false，
    //    整条漏过去。（证据：`_member-coach-identity-mutate` ⑤ 曾因此漏网 —— 会员视图里多了内部主键。）
    //    ⇒ 只盯"**真正下发给会员的那几个字段**"那一段，凡在 key 的位置出现这些名字都算漏（简写也算）。
    const emitStart = service.indexOf('coachKeys.push(Object.assign({')
    const emitEnd = service.indexOf('}, patch))', emitStart)
    assert.ok(emitStart >= 0 && emitEnd > emitStart,
      '⛔ 投影段的两端锚点都必须命中（命中不了 ⇒ 下面这段断言会被静默跳过，等于没写）')
    const emitBody = service.slice(emitStart, emitEnd)
    ;['coachId', 'publicCode', 'openId', 'datasetId', 'studentId'].forEach(forbidden => {
      assert.ok(!new RegExp(`(^|[,{\\s])${forbidden}\\s*[,:}]`).test(emitBody),
        `⛔ 下发给会员的字段里不许出现 ${forbidden}（简写属性也算出网）`)
    })
    assert.ok(!body.includes('publicCode:'), '⛔ 不许下发完整公开码（只给尾号）')
    assert.ok(!body.includes('openId') && !body.includes('datasetId:'), '⛔ 身份 / 账本定位字段不许进会员视图')
    const rows = view.coachOptionsView([SANDBOX_A])
    assert.strictEqual(rows[0].coachId, undefined, '客户端也没造出内部 id')
  })

  // ---------------------------------------------------------------- ⑤ 顺序 / 默认选择不变（要求④）
  await runner('⑤ ⛔ 排序、数量、默认选择**一个都不许变**（只加工展示字段）', async () => {
    const source = [SANDBOX_B, SANDBOX_A, OTHER]
    const rows = view.coachOptionsView(source)
    assert.strictEqual(rows.length, source.length, '不许增删教练（多一份、少一份都是改了授权名单）')
    assert.deepStrictEqual(rows.map(row => row.coachKey), ['k-b', 'k-a', 'k-c'], '顺序必须原样保留')
    // ⭐ 2026-10-03 补（覆盖真空修复）：上面那份夹具的顺序**恰好等于**期望顺序 ——
    //    'Sandbox教练' 排在中国姓氏之前，且 A / B 同名（排序稳定后仍是原序）
    //    ⇒ 就算有人偷偷插一道 `sort`，答案也一模一样，抓不到。
    //    （证据：`_member-coach-identity-mutate` ⑥「加工时改了顺序」曾经漏网。）
    //    换一份**姓名顺序与给定顺序明显相反**的夹具（全 ASCII ⇒ 不受中文 collation 影响）：
    const zed = { coachKey: 'k-z', displayName: 'Zed Coach', bookable: true, role: '管理人', roleKey: 'owner', codeTail: '0001' }
    const ada = { coachKey: 'k-y', displayName: 'Ada Coach', bookable: true, role: '授课教练', roleKey: 'teaching', codeTail: '0002' }
    const mia = { coachKey: 'k-x', displayName: 'Mia Coach', bookable: true, role: '管理人', roleKey: 'owner', codeTail: '0003' }
    const shuffled = view.coachOptionsView([zed, ada, mia])
    assert.deepStrictEqual(shuffled.map(row => row.coachKey), ['k-z', 'k-y', 'k-x'],
      '⛔ 顺序必须原样保留：服务端给的顺序决定"默认选中谁"，重排 = 换个人')
    assert.deepStrictEqual(shuffled.map(row => row.coachKey), view.coachOptionsView([zed, ada, mia]).map(row => row.coachKey),
      '两次加工结果必须一致（不许引入任何不稳定的排序）')
    rows.forEach((row, at) => {
      assert.strictEqual(row.displayName, source[at].displayName)
      assert.strictEqual(row.bookable, source[at].bookable, '⛔ bookable 不许被加工改写（那是授权判定）')
      assert.strictEqual(row.coachKey, source[at].coachKey)
    })
    // 页面走的就是这一份
    const page = readFile('pages/member-book-slots/member-book-slots.js')
    assert.ok(page.includes('coaches = view.coachOptionsView(coaches)'), '页面必须调用共享加工（不许自己再拼一遍）')
    assert.ok(!/coachOptionsView[\s\S]{0,200}sort\(/.test(page), '加工之后不许再排序（顺序是服务端的事实）')
  })

  // ---------------------------------------------------------------- ⑥ 服务端没给 ⇒ 一个字都不编
  await runner('⑥ 老版本云端没下发 role ⇒ **不显示身份标签**（不许凭空显示"管理人"）', async () => {
    const rows = view.coachOptionsView([{ coachKey: 'k-old', displayName: '老教练', bookable: true }])
    assert.strictEqual(rows[0].hasRole, false, '没有 role ⇒ 标记为"没身份信息"')
    assert.strictEqual(rows[0].roleText, '')
    assert.strictEqual(rows[0].showCodeTail, false, '没有 codeTail ⇒ 不亮尾号')
  })

  // ---------------------------------------------------------------- ⑦ 单教练产品不再向用户展示多教练身份选择
  await runner('⑦ 单教练界面只显示当前授课教练，不再出现身份标签和切换入口', async () => {
    const wxml = readFile('pages/member-book-slots/member-book-slots.wxml')
    assert.ok(wxml.includes('授课教练'), '单教练页面必须明确告诉会员当前授课教练')
    assert.ok(wxml.includes("{{coaches[coachIndex].displayName||'正在读取教练'}}"), '顶部合并按钮必须显示唯一教练姓名')
    assert.ok(!/slot-coach-role|slot-coach-tail|pickCoach/.test(wxml), '⛔ 单教练页面仍残留身份标签或教练切换入口')
    assert.ok(wxml.includes('<text wx:if="{{coaches[coachIndex].hasRole}}" class="confirm-coach-role">'),
      '最终确认弹层必须保留云端给出的教练身份提示，防止历史同名资料选错')
  })

  // ---------------------------------------------------------------- ⑧ 只有一位教练 ⇒ 不制造噪音
  await runner('⑧ 只有一位教练 ⇒ 不加标签（单教练用户的界面不许变）', async () => {
    const rows = view.coachOptionsView([SANDBOX_A])
    assert.strictEqual(rows[0].showCodeTail, false)
    // 页面把唯一教练与课程合并展示，不提供教练切换器。
    const wxml = readFile('pages/member-book-slots/member-book-slots.wxml')
    assert.ok(wxml.includes("booking-choice {{coaches.length?'':'disabled'}}"), '顶部合并按钮必须随唯一教练读取状态启用')
    assert.ok(wxml.includes("{{coaches[coachIndex].displayName||'正在读取教练'}}"), '有教练时必须显示当前授课教练')
    assert.ok(!wxml.includes('选择教练'), '⛔ 单教练产品不应要求会员选择教练')
  })

  // ---------------------------------------------------------------- ⑨ 与写路径同口径：可约名单没有第二条来源
  await runner('⑨ 身份标签**不参与授权判定**：bookable 仍由服务端裁决（纸面看得见 ≠ 真的能约）', async () => {
    const forbidden = view.coachOptionsView([{ coachKey: 'k-x', displayName: 'X', bookable: false, role: '授课教练', roleKey: 'teaching' }])
    assert.strictEqual(forbidden[0].bookable, false, '加工不许把不可约的教练变成可约')
    const service = readFile('cloudfunctions/readMyMemberData/service.js')
    assert.ok(service.includes('bookable: true'), 'bookable 恒由服务端给（这里每一位都来自认领 + 有效授权）')
    // 换教练筛选课包仍然只看 coachKeys ⇒ 没被身份字段影响
    const pkgs = view.packagesForCoach([
      { packageViewId: 'p1', coachKeys: ['k-b'] }, { packageViewId: 'p2', coachKeys: ['k-a'] }
    ], 'k-a')
    assert.deepStrictEqual(pkgs.map(row => row.packageViewId), ['p2'])
  })

  // ---------------------------------------------------------------- ⑩ 脏数据不崩
  await runner('⑩ 脏数据 / 缺字段：不抛异常，退化为"没有身份信息"', async () => {
    const rows = view.coachOptionsView([null, undefined, {}, { displayName: null, roleKey: 5, codeTail: {} }])
    assert.strictEqual(rows.length, 4)
    rows.forEach(row => {
      assert.strictEqual(typeof row.hasRole, 'boolean')
      assert.strictEqual(typeof row.showCodeTail, 'boolean')
    })
    assert.deepStrictEqual(view.coachOptionsView(null), [])
  })

  // ---------------------------------------------------------------- ⑪ 顺便守住：这一层不许顺手改别的口径
  await runner('⑪ 加工函数**只动展示**：课表那边的口径一个字节都没被碰到', async () => {
    // 拿一条**存量的跨午夜旧课**做样本（23:30 → 次日 00:30）：课表索引 + 次日占用都必须是稳定的。
    const snap = () => {
      const index = businessView.buildScheduleIndex([{ id: 'b1', date: '2026-10-02', hour: 23, minute: 30, status: 'booked', plannedMinutes: 60 }])
      return JSON.stringify({ bySlot: index.bySlot, byDate: index.byDate, nextDayBusy: businessView.busyRangesOf(index.rows, '2026-10-03') })
    }
    const before = snap()
    view.coachOptionsView([SANDBOX_A, SANDBOX_B])
    assert.strictEqual(snap(), before, '⛔ 改会员端展示不许回响到教练课表（含跨午夜课的次日占用）')
  })

  const failed = results.filter(row => row[0] === 'FAIL').length
  results.forEach(([state, title]) => console.log(`${state === 'PASS' ? '✓' : '✗'} ${title}`))
  console.log(failed ? `\n[member-coach-identity] FAILED` : `\n[member-coach-identity] ALL PASS (${results.length} 段)`)
}

main()
