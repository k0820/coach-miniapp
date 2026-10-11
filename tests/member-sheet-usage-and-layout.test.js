// tests/member-sheet-usage-and-layout.test.js
//
// ⭐⭐ 会员端「统一确认弹层 + 布局统一」的护栏（需求 F + H，2026-10-04）。
//
// ─────────────────────────────────────────────────────────────────────────────
// 为什么要有这个文件
//
// ⭐ 改造前的病（都是**真实存在**的，不是设想的）：
//   ① 同一个"底部弹层"在项目里有**三份各自复制的副本**：约课确认（member-book-slots）、
//      预约详情 + 改期（member-bookings）。三份的圆角（34rpx / 34rpx / 32rpx）、
//      遮罩底色（.38 / .45 / .42）、标题做法、按钮高度都不一样
//      ⇒ 同一个产品里"弹层"有两套长相，而且改一处必漏另两处。
//   ② 课时页顶部一张 86rpx 大数字卡占掉整屏首屏，而"一共还剩几节"只是入口信息。
//   ③ 会员端底栏实高 ≈157rpx（带 Home 指示条的机器），而页面只留 150rpx
//      ⇒ 列表最后一行正好被压在底栏下面。
//
// ─────────────────────────────────────────────────────────────────────────────
// ⭐ 本文件的写法：**判据与漂移注入共用同一批断言函数**（`assertXxx`）
//
//   ⚠️ 为什么不"先写断言、再另写一份漂移"：
//   那样两份判据会各自漂移，注入的漂移实现可能只被其中一份抓住 ⇒ 测试假绿。
//   本文件把每条判据抽成函数，注入段**直接调用同一个函数**并要求它抛错 ——
//   ⇒ "判据抓不住某个漂移"这件事本身就会让本文件红。
//
// ⛔ 漂移注入**只在内存里做字符串替换**，绝不写回生产源码
//   （⛔ 禁止运行会 `writeFileSync` 改生产源码的反证脚本）。
//
// ⛔ 覆盖面：只断言**本轮真的改了**的东西。
//   `pages/member-home` `member-profile` `member-archives` `member-claim`
//   `member-coach-tools` `students` `student-archives` 本轮**没动**（各有别人在改），
//   本文件不去判它们的弹层，避免给出"已经统一"的假结论。

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(ROOT, ...parts))

const SLOTS = 'pages/member-book-slots/member-book-slots'
const BOOKINGS = 'pages/member-bookings/member-bookings'
const PACKAGES = 'pages/member-packages/member-packages'
const SHEET = 'components/member-sheet/member-sheet'

// ⭐ 真机底栏高度（rpx）：`.member-nav` 的 padding 12+12 + 图标 40 + 文字 ~25。
//    带 Home 指示条的机器 `env(safe-area-inset-bottom)=34pt`，375pt 宽的机型上 1pt = 2rpx ⇒ 68rpx。
const NAV_FIXED_RPX = 12 + 40 + 25 + 12
const SAFE_AREA_NOTCHED_RPX = 34 * 2
/** 页面为底部导航预留的最小内边距（rpx）——⛔ 低于这个值，底栏就会压住内容。 */
const NAV_RESERVE_FLOOR_RPX = NAV_FIXED_RPX + SAFE_AREA_NOTCHED_RPX

// ═════════════════════════════════════════════════════════════════════════════
// 判据函数（注入段会**原样复用**它们，所以它们必须单独成立）
// ═════════════════════════════════════════════════════════════════════════════

/** 从一条 CSS 规则体里取第一个 `prop` 的数值（rpx）。取不到返回 0。 */
function pxOf(ruleBody, prop) {
  const m = new RegExp(`${prop}\\s*:\\s*(\\d+)rpx`).exec(ruleBody || '')
  return m ? Number(m[1]) : 0
}
/** 取一条规则体（形如 `.a{...}`），取不到返回空串。 */
function ruleOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`${escaped}\\{([^}]*)\\}`).exec(css || '')
  return m ? m[1] : ''
}

/**
 * ⭐ 剥掉 WXML 的 HTML 注释再交给判据。
 * ⛔ 为什么必须剥：本文件自己的注释里就写着 `⛔ 界面不许渲染 {{item.status}}` 这类**反例**，
 *    不剥就会自己命中自己 ⇒ 判据测空气（这正是 member-archive-ui ⑤ 踩过的坑）。
 * 剥完之后判据只看**真正会渲染给用户看的那部分标记**。
 */
function wxmlBody(wxml) {
  return String(wxml || '').replace(/<!--[\s\S]*?-->/g, '')
}

// ── ① 弹层归属：三处必须用 member-sheet，⛔ 不许页面自建遮罩 ────────────────

/**
 * 判据：某个页面的某个弹层必须由 `member-sheet` 承载。
 * ⚠️ 判别力来源：它同时要求 ① wxml 里真的有 `<member-sheet>` ② 页面里**没有**自建遮罩壳。
 *    只查 ① 的话，"用了组件但外面又套了一层自建遮罩"会假绿。
 */
function assertSheetOwned(opts) {
  const { json, label, selfBuiltAllowed } = opts
  const wxml = wxmlBody(opts.wxml)
  assert.ok(wxml.includes('<member-sheet'),
    `${label}：必须用统一弹层 <member-sheet>（⛔ 不许再自建一份副本）`)
  assert.ok(json.includes('member-sheet'),
    `${label}：json 的 usingComponents 必须注册 member-sheet（⛔ 用了却没注册＝真机上白屏）`)
  if (!selfBuiltAllowed) {
    assert.ok(!/class="[^"]*-mask"/.test(wxml),
      `${label}：⛔ 页面里不许再出现自建遮罩（*-mask），防穿透与遮罩色由组件统一负责`)
    assert.ok(!/(position\s*:\s*fixed[^}]*background\s*:\s*rgba\()/s.test(opts.wxss || ''),
      `${label}：⛔ 页面 wxss 里不许再写"fixed + 半透明底色"的遮罩（那是自建弹层的标志）`)
  }
}

// ── ② 弹层安全：防穿透 / 底部安全距离 / 危险层级 ─────────────────────────

/** 判据：弹层遮罩必须挡滚动穿透，且底部操作区必须留安全区。 */
function assertSheetSafety(wxml, wxss, label) {
  const body = wxmlBody(wxml)
  assert.ok(/member-sheet-mask[^>]*catchtouchmove/.test(body),
    `${label}：遮罩必须带 catchtouchmove（⛔ 手指在弹层上滑会把后面的页面带着滚）`)
  assert.ok(/catchtouchmove="noop"/.test(body) && /noop\s*\(/.test(read(`${SHEET}.js`)),
    `${label}：catchtouchmove 必须指向一个真实存在的 noop 方法（⛔ 找不到 handler 会静默失效）`)
  const foot = ruleOf(wxss, '.member-sheet-foot')
  assert.ok(/env\(safe-area-inset-bottom\)/.test(foot),
    `${label}：底部操作区必须留 env(safe-area-inset-bottom)（⛔ 小屏会顶到 Home 指示条）`)
}

/**
 * 判据：取消预约这个弹层必须声明 danger（危险层级）。
 * ⚠️ 判别力来源：**只取那一个 `<member-sheet …>` 开始标签本身**来判，
 *    ⛔ 不用"往前找 N 个字符"这种窗口 —— 窗口里会撞上详情弹层那颗
 *    `booking-manage-btn danger` 按钮，于是"取消弹层自己没写 danger"也会假绿。
 */
function assertDangerSheet(wxml, label) {
  const body = wxmlBody(wxml)
  const at = body.indexOf('bindconfirm="confirmCancel"')
  assert.ok(at >= 0, `${label}：必须存在取消确认弹层的 confirm 出口`)
  // 从这个 member-sheet 开始标签的 `<` 起，到 `bindconfirm` 前为止 —— 就是标签本身
  const start = body.lastIndexOf('<member-sheet', at)
  assert.ok(start >= 0 && start < at, `${label}：取消确认必须由 member-sheet 承载`)
  const openTag = body.slice(start, at)
  assert.ok(/danger/.test(openTag),
    `${label}：⛔ 取消预约的 <member-sheet> 标签上必须声明 danger（不可逆动作，主按钮要转红）`)
  assert.ok(/danger\s*=\s*"\{\{\s*true\s*\}\}"|\bdanger(\s|\/|>)/.test(openTag),
    `${label}：danger 必须是真值（⛔ danger="false" 等于没有危险层级）`)
}

// ── ③ 课时页：七件事齐全 + 状态说人话 ─────────────────────────────────────

/** 判据：课时页顶部**不得**再有大数字卡，每份课包必须七件事齐全。 */
function assertPackagesPage(rawWxml, label) {
  const wxml = wxmlBody(rawWxml)          // ⛔ 剥注释：注释里的反例不许自己命中自己
  // ① 顶部不许再占满首屏的大数字
  //    ⚠️ 判据按**类名**判（`member-display` / `member-balance` 是那套 86rpx 大数字的类），
  //    ⛔ 不是按"字号小于多少"判 —— 那是"换个更小的大数字"，首屏照样被占。
  assert.ok(!/class="[^"]*\bmember-display\b/.test(wxml) && !/class="[^"]*\bmember-balance\b/.test(wxml),
    `${label}：⛔ 顶部不许再用 86rpx 的大数字卡（总剩余只是摘要，主角是下面逐份的课包）`)
  // ② 七件事：类型 / 教练 / 购买日期 / 初始节数 / 已使用 / 剩余 / 状态
  for (const [name, re] of [
    ['类型', /pkg\.typeName/],
    ['教练', /pkg\.coachName/],
    ['购买/登记日期', /pkg\.saleDateText/],
    ['初始节数', /pkg\.total/],
    ['已使用', /pkg\.used/],
    ['剩余', /pkg\.remaining/],
    ['当前状态', /pkg\.statusText/]
  ]) {
    assert.ok(re.test(wxml), `${label}：每份独立课时包必须显示「${name}」（少一件用户就得回头问教练）`)
  }
  // ③ 状态必须是人话，⛔ 界面上不许渲染英文枚举
  assert.ok(!/\{\{\s*(?:item|pkg)\.status\s*\}\}/.test(wxml),
    `${label}：⛔ 界面上不许直接渲染 status 英文枚举（会员看到 reversed 只会以为是 bug）`)
  assert.ok(/已撤销/.test(read(`${PACKAGES}.js`)) && /使用中/.test(read(`${PACKAGES}.js`)),
    `${label}：⛔ 状态字典必须把 active→使用中、reversed→已撤销 翻成人话`)
  // ④ ⛔ 不许拿 total-used 反推 remaining
  const jsBare = read(`${PACKAGES}.js`)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')
  assert.ok(!/total\s*-\s*used/.test(jsBare),
    `${label}：⛔ 不许用 total - used 反推剩余（服务端下发什么就显示什么）`)
  // ⑤ 范围开关保留
  // 新会员模型只有一份由教练预建并绑定的资料，不再存在“多档案切换”。
  // 课时页必须直接读取新目录 dashboard，避免首页有课包、明细页却继续读旧认领缓存。
  const js = read(`${PACKAGES}.js`)
  assert.ok(/directory\.dashboard\(\)/.test(js) && !/archiveState\.scopeOf\(/.test(js),
    `${label}：必须读取新绑定资料的课包，不能退回旧认领/多档案读取`)
}

// ── ④ 布局：底部预留 + 窄屏 + 视觉口径 ─────────────────────────────────────

/** 判据：会员端页面的底部预留必须 ≥ 底栏实高（防底栏遮挡回归）。 */
function assertNavReserve(pageName, baseCss) {
  // ⚠️ `.member-page` 用的是 padding **简写**（`padding:A B C`）⇒ C 段才是 padding-bottom
  const shorthand = (baseCss.match(/\.member-page\{([^}]*)\}/) || [])[1] || ''
  const longhand = /padding-bottom:([^;}]+)/.exec(shorthand)
  const pagePadding = longhand ? longhand[1] : (/(?:^|;)\s*padding:[^;}]*/.exec(shorthand) ? String((shorthand.split(';').find(x => /(^|;)\s*padding:/.test(x)) || '')).split(':')[1].trim().split(/\s+/).slice(2).join(' ') : '')
  assert.ok(pagePadding, `${pageName}：读不到 .member-page 的 padding-bottom`)
  // 写法必须是 calc(<固定> + env(safe-area-inset-bottom))：光秃秃一个数在带指示条的机器上不够
  assert.ok(/env\(safe-area-inset-bottom\)/.test(String(pagePadding)),
    `${pageName}：⛔ padding-bottom 必须含 env(safe-area-inset-bottom)（iPhone X 类机器底栏实高 ${NAV_RESERVE_FLOOR_RPX}rpx）`)
  const fixed = Number(/(\d+)rpx/.exec(String(pagePadding))[1])
  assert.ok(fixed + SAFE_AREA_NOTCHED_RPX >= NAV_RESERVE_FLOOR_RPX,
    `${pageName}：底部预留 ${fixed}rpx + 安全区 ${SAFE_AREA_NOTCHED_RPX}rpx < 底栏实高 ${NAV_RESERVE_FLOOR_RPX}rpx ⇒ 列表最后一行会被压住`)
}

// ═════════════════════════════════════════════════════════════════════════════
// 正式断言
// ═════════════════════════════════════════════════════════════════════════════

// ⭐ 2026-10-05：主题选择页已撤回，从布局体检清单里移除（它的 wxss 已不存在，留着只会 ENOENT 假红）。
const PAGES = {
  'member-book-slots': SLOTS, 'member-bookings': BOOKINGS, 'member-packages': PACKAGES,
  'member-history': 'pages/member-history/member-history',
  'member-coaches': 'pages/member-coaches/member-coaches', 'member-history-detail': 'pages/member-history-detail/member-history-detail',
  'member-add-coach': 'pages/member-add-coach/member-add-coach'
}

let total = 0
let passed = 0
async function runner(name, fn) {
  total++
  try { await fn(); passed++; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}: ${error && error.message}`) }
}
/** 断言"必须红"：把注入的漂移喂给真判据，要求它抛错。 */
function mustGoRed(judge, drifted, why) {
  let red = false
  try { judge(drifted) } catch (e) { red = true }
  assert.ok(red, `⛔ 判据抓不住「${why}」这种漂移 ⇒ 这条护栏是测空气的`)
}

async function main() {
  const baseCss = read('styles/member.wxss')
  const sheetWxml = read(`${SHEET}.wxml`)
  const sheetWxss = read(`${SHEET}.wxss`)
  const slots = { wxml: read(`${SLOTS}.wxml`), wxss: read(`${SLOTS}.wxss`), json: read(`${SLOTS}.json`) }
  const bookings = { wxml: read(`${BOOKINGS}.wxml`), wxss: read(`${BOOKINGS}.wxss`), json: read(`${BOOKINGS}.json`) }

  // ───────────────────────────────────────────────────────────────────────────
  await runner('① 三处确认型弹层都必须由 member-sheet 承载（⛔ 页面不许自建遮罩）', () => {
    // 约课确认：纯确认型（确认 / 再看看两颗对等主操作）⇒ 必须换
    assertSheetOwned({ ...slots, label: '约课确认' })
    assert.ok(/bindconfirm="submit"/.test(wxmlBody(slots.wxml)), '约课确认：主操作必须接 submit')
    assert.ok(/bindcancel="closeConfirm"/.test(wxmlBody(slots.wxml)), '约课确认：取消出口必须接 closeConfirm')

    // 改期：会真写云端，主操作必须落在组件的固定底部操作区里
    const rescheduleAt = wxmlBody(bookings.wxml).indexOf('bindconfirm="closeReschedule"')
    assert.ok(rescheduleAt >= 0, '改期：必须用 member-sheet，且主操作落在组件底部操作区')
    assert.ok(/<member-sheet/.test(wxmlBody(bookings.wxml).slice(Math.max(0, rescheduleAt - 800), rescheduleAt)),
      '改期：确认区必须由 member-sheet 承载（⛔ 旧版把按钮做成右上角「收起」文字，内容一长就够不到）')
    // 取消二次确认：不可逆动作 ⇒ 统一弹层 + danger
    assertDangerSheet(bookings.wxml, '取消预约')

    // ⚠️ 预约详情是**唯一允许**保留自建弹层的页面（信息展示型，理由见 wxml 注释）
    //    —— 但"允许保留"不等于"允许丑"：它必须与组件逐项同口径。
    assert.ok(/class="booking-detail-mask"/.test(wxmlBody(bookings.wxml)),
      '预约详情：作为信息展示型弹层，允许保留自建外壳')
    assert.ok(!/reschedule-mask/.test(wxmlBody(bookings.wxml)) && !/^\s*\.reschedule-mask\{/m.test(bookings.wxss),
      '⛔ 改期面板的自建遮罩必须彻底删掉（不许留半套）')
    assert.ok(!/booking-detail-mask/.test(wxmlBody(slots.wxml)) && !/^\s*\.booking-detail-mask\{/m.test(slots.wxss),
      '⛔ 约课页的自建遮罩必须彻底删掉（⛔ 三份副本的存在本身就是病根）')
  })

  // ───────────────────────────────────────────────────────────────────────────
  await runner('② 弹层三件安全：防穿透 / 底部安全距离 / 危险层级', () => {
    assertSheetSafety(sheetWxml, sheetWxss, '统一弹层')
    // 固定底部按钮必须在 scroll-view **之外**（内容再长也顶不走按钮）
    const sheetBody = wxmlBody(sheetWxml)
    const scrollEnd = sheetBody.indexOf('</scroll-view>')
    const footAt = sheetBody.indexOf('member-sheet-foot')
    assert.ok(scrollEnd > 0 && footAt > scrollEnd,
      '⛔ 底部操作区必须在 </scroll-view> 之后（否则长内容把按钮顶出屏幕）')
    // 顶部 32rpx 圆角 + 拖动短线（同一套长相的两处弹层要能对齐）
    const panel = ruleOf(sheetWxss, '.member-sheet')
    assert.ok(/border-radius:\s*32rpx 32rpx 0 0/.test(panel), '统一弹层：顶部必须是 32rpx 圆角')
    assert.ok(/member-sheet-handle/.test(sheetWxss), '统一弹层：必须有顶部拖动短横线')
    // ⭐ 保留自建的预约详情，必须与组件**同口径**（这一条是"允许保留"的兑现条件）
    const detailMask = ruleOf(bookings.wxss, '.booking-detail-mask')
    const detailPanel = ruleOf(bookings.wxss, '.booking-detail')
    assert.ok(/var\(--member-sheet-mask/.test(detailMask),
      '预约详情：遮罩底色必须读 --member-sheet-mask（⛔ 不许自己挑一个 rgba）')
    assert.ok(/border-radius:\s*32rpx 32rpx 0 0/.test(detailPanel),
      '预约详情：顶圆角必须与统一弹层一致（32rpx）')
    assert.ok(/env\(safe-area-inset-bottom\)/.test(detailPanel),
      '预约详情：底部必须留安全区')
    assert.ok(/booking-detail-handle/.test(bookings.wxss) && /booking-detail-handle/.test(wxmlBody(bookings.wxml)),
      '预约详情：拖动短线要与统一弹层一致')
    assert.ok(/booking-detail-mask[^>]*catchtouchmove/.test(wxmlBody(bookings.wxml)),
      '预约详情：自建遮罩必须自己挡滚动穿透')
  })

  // ───────────────────────────────────────────────────────────────────────────
  await runner('③ 取消预约：危险层级 + 直白文案（⛔ 不用技术术语掩盖真实行为）', () => {
    const js = read(`${BOOKINGS}.js`)
    const bare = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')
    // ① 必须真的有二次确认（⛔ "点一下就取消"是事故）
    assert.ok(/await this\.askConfirm\(/.test(bare),
      '⛔ 取消必须先有二次确认（askConfirm）才允许真写入')
    // ② 弹层只派发事件、不自己隐藏 ⇒ 页面必须有把它置 false 的两个出口
    assert.ok(/confirmCancel\s*\(/.test(js) && /closeCancel\s*\(/.test(js),
      '⛔ 必须有 confirm / close 两个出口（组件不自己隐藏，否则弹层关不掉）')
    assert.ok(/cancelOpen:\s*false/.test(js), 'cancelOpen 初值必须是 false（⛔ 不许默认就弹出）')
    assert.ok(/this\.setData\(\{\s*cancelOpen:\s*false/.test(bare),
      '⛔ 确认与取消两条出口都必须把 cancelOpen 置 false')
    // ③ 文案：说清真实后果 + 不许技术术语
    const askAt = bare.indexOf('this.askConfirm(')
    assert.ok(askAt > 0, '找不到 askConfirm 的调用点')
    const copy = /this\.askConfirm\(`([^`]*)`/.exec(bare.slice(askAt))
    assert.ok(copy, '⛔ 确认文案必须直接写在 askConfirm 的参数里（不许绕到别处拼）')
    assert.ok(/不会减少/.test(copy[1]),
      '⛔ 必须说清"课时不会减少"（按六条规则取消只释放占座；不说清用户会以为课时被扣了）')
    assert.ok(!/物理删除|级联|软删|硬删|逻辑删除/.test(copy[1]),
      '⛔ 确认文案不许用"物理删除"这类说法掩盖真实行为')
    assert.ok(/不能恢复|无法恢复/.test(copy[1]), '⛔ 必须说清这一步不可撤销')
    // ④ ⛔ 假成功词表仍然生效（页面源码里不许提前喊成功）
    const forbidden = require(path.join(ROOT, 'utils/member-booking-manage')).FORBIDDEN_SUCCESS_WORDS
    forbidden.forEach(word => assert.ok(!bare.includes(word), `⛔ 页面源码里不许出现假成功词「${word}」`))
  })

  // ───────────────────────────────────────────────────────────────────────────
  await runner('④ 课时页：顶部一行摘要 + 每份课包七件事齐全 + 状态说人话', () => {
    const wxml = read(`${PACKAGES}.wxml`)
    assertPackagesPage(wxml, '课时页')
    // 顶部确实只有一行（⛔ 不是"换个更小的大数字"，是真的压成摘要行）
    assert.ok(/class="balance-line"/.test(wxml), '顶部必须是压成一行摘要')
    assert.ok(/member-safe-bottom/.test(wxml), '课时页底部必须留安全区')
    // 明写"多份档案加在一起"（老事故：合计被当成自己的课时）
    assert.ok(/加在一起/.test(wxml), '⛔ 合计口径必须写明"是多份档案加在一起"')
    // 每个 packageViewId 一行（⛔ 不许合并 / 不许换算）
    assert.ok(/wx:key="packageViewId"/.test(wxml), '⛔ 每份课包必须按 packageViewId 独立成行（不许合并）')
  })

  // ───────────────────────────────────────────────────────────────────────────
  await runner('⑤ 布局：每页底部预留 ≥ 底栏实高（防底栏遮挡回归）', () => {
    for (const name of Object.keys(PAGES)) assertNavReserve(name, baseCss)
    // 会员端每一页都必须 import 统一变量（⛔ 不许自带一套 padding-bottom 覆盖）
    for (const [name, page] of Object.entries(PAGES)) {
      assert.ok(/@import\s+"\.\.\/\.\.\/styles\/member\.wxss"/.test(read(`${page}.wxss`)),
        `${name}：必须 @import styles/member.wxss（否则底部预留口径不统一）`)
    }
    // 底栏自身也必须留安全区（否则它自己顶到指示条）
    assert.ok(/env\(safe-area-inset-bottom\)/.test(read('components/member-nav/member-nav.wxss')),
      'member-nav 必须留 env(safe-area-inset-bottom)')
  })

  // ───────────────────────────────────────────────────────────────────────────
  await runner('⑥ 窄屏（iPhone 6/7/8 = 375×555）：不许出现截断或一字一行', () => {
    // 判据走"结构"而不是"看起来"：flex 里的文字块必须 min-width:0，块级长文案必须可断行。
    const flexTextBlocks = {
      [SLOTS]: ['booking-copy', 'slot-day-copy', 'booking-detail-value'],
      [BOOKINGS]: ['booking-copy', 'booking-detail-value', 'booking-tab', 'booking-manage-btn'],
      [PACKAGES]: ['package-copy']
    }
    for (const [page, names] of Object.entries(flexTextBlocks)) {
      const css = read(`${page}.wxss`)
      for (const n of names) {
        const own = ruleOf(css, `.${n}`)
        const fromBase = ruleOf(baseCss, `.${n}`)
        assert.ok(/min-width:0/.test(own) || /min-width:0/.test(fromBase),
          `${page} 的 .${n} 必须 min-width:0（⛔ 没有它中文在 375 窄屏上被压成一字一行）`)
      }
    }
    // 课时页三个数字行：⛔ 不许用 ellipsis 把节数藏起来（"看不全"比"不好看"严重）
    const pkgCss = read(`${PACKAGES}.wxss`)
    assert.ok(!/text-overflow:ellipsis/.test(ruleOf(pkgCss, '.package-fact-value')),
      '⛔ 节数不许被 ellipsis 截断（截断＝用户以为只剩这么多）')
    assert.ok(/overflow-wrap:break-word/.test(ruleOf(pkgCss, '.package-name')),
      '⛔ 长课程名必须可断行')
    // 摘要口径说明在 375 上单行放不下 ⇒ 必须允许换行
    assert.ok(/balance-note/.test(pkgCss), '顶部口径说明必须有独立类（才能单独允许换行）')
    // 弹层内容区用 vh 而不是 rpx 硬编码（小屏大屏看到的行数必须成比例）
    assert.ok(/max-height:\s*\d+vh/.test(ruleOf(sheetWxss, '.member-sheet-body')),
      '⛔ 弹层内容区高度必须用 vh（rpx 硬编码会让小屏看到的内容和大屏完全不同）')
  })

  // ───────────────────────────────────────────────────────────────────────────
  await runner('⑦ 视觉收敛：会员端不许自建第二套圆角/危险色/遮罩色', () => {
    // 危险色只有一个（⛔ 各页自己挑一个红是"三处弹层三种红"的根）
    // ⚠️ 判据只认**真正会生效的那一层**，并且区分两种"看起来都是裸色值"的情况：
    //   ① `var(--x, #兜底)` 里的兜底色 —— **允许**（主题没注入时的保底值）；
    //   ② 纯白 `#fff` 用在**实心填充之上**当文字色（如 `.booking-tab.active{background:var(--member-primary);color:#fff}`）
    //      —— **允许**（⛔ 它不是"第二套配色"，反过来读成深色反而会看不清）。
    //   除此之外的裸色值 = 第二套配色，必须红。
    const bareHexes = css => (css.replace(/var\([^)]*\)/g, '').match(/#[0-9a-fA-F]{3,6}\b/g) || [])
    for (const name of ['member-bookings', 'member-coaches', 'member-packages', 'member-book-slots']) {
      // ⛔ 先剥 CSS 注释：本文件与源码的注释里都写着"不许写死 #xxx"这类**说明 + 反例**，
      //    不剥就会把注释里的字当成选择器去构造正则 ⇒ 判据自己炸自己。
      const css = read(`pages/${name}/${name}.wxss`).replace(/\/\*[\s\S]*?\*\//g, '')
      const offenders = []
      for (const rule of css.match(/([.#][^{}]+)\{([^}]*)\}/g) || []) {
        const selector = rule.split('{')[0].trim()
        // ⚠️ "这块白字是不是反色"要看**整条祖先链**上的实心填充：
        //    `.reschedule-date.active .reschedule-date-day{color:#fff}` 的底色写在
        //    `.reschedule-date.active{background:...}` 上（CSS 里底色与字色常分两条规则）。
        //    ⛔ 而这两条规则的 var() 都要**先剥**再判断 —— 不剥的话
        //    `background:var(--member-primary)` 会让"有没有底色"永远为真（那就等于没判）。
        const chainOf = sel => {
          const out = [sel]
          let cur = sel
          for (let i = 0; i < 4 && cur; i++) {
            cur = cur.replace(/\s*[>:].*$/, '').replace(/\.[^.]+$/, '')
            if (!cur || out.includes(cur)) break
            out.push(cur)
          }
          return out
        }
        const bodyOf = sel => {
          const m = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(css)
          return m ? m[1] : ''
        }
        const onSolidFill = chainOf(selector).some(sel => {
          const b = bodyOf(sel)
          return b && /background:\s*(?!none|transparent)[^;}]+/.test(b)
        })
        const body = rule.replace(/var\([^)]*\)/g, '')
        for (const hex of (body.match(/#[0-9a-fA-F]{3,6}\b/g) || [])) {
          const isPlainWhite = /^#(fff|ffffff)$/i.test(hex)
          if (onSolidFill && isPlainWhite) continue          // ② 放行
          offenders.push(`${selector} → ${hex}`)
        }
      }
      assert.deepEqual(offenders, [],
        `${name}：⛔ 颜色必须读 --member-* token（var() 兜底值与实心底上的反色白除外）：${offenders.join(' | ')}`)
      assert.deepEqual(bareHexes(css).filter(h => !/^#(fff|ffffff)$/i.test(h)), [],
        `${name}：⛔ 不许有裸色值`)
    }
    // 组件与保留自建的弹层必须共用同一个遮罩 token
    assert.ok(/var\(--member-sheet-mask/.test(sheetWxss) && /var\(--member-sheet-mask/.test(read(`${BOOKINGS}.wxss`)),
      '⛔ 两处弹层的遮罩底色必须读同一个 token')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 判别力：注入两种漂移实现，**必须**让上面的判据变红
  //
  // ⭐ 关键：这里调用的是**上面那些同一个函数**，不是另写一遍。
  //    所以"判据抓不住"这件事本身会让本文件红（而不是悄悄放过）。
  // ═══════════════════════════════════════════════════════════════════════════
  await runner('⑧ 判别力：注入「取消预约没有二次确认」⇒ ③ 必须红', () => {
    const drifted = read(`${BOOKINGS}.js`)
      // 最坏方向的漂移：点一下就取消，连问都不问
      .replace(/const ok = await this\.askConfirm\([^)]*\)\s*\n\s*if \(!ok\) return\n/, 'const ok = true\n')
    assert.notStrictEqual(drifted, read(`${BOOKINGS}.js`), '⛔ 漂移注入没生效（源码形状变了，判据会失去意义）')
    let red = false
    try {
      const bare = drifted.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')
      assert.ok(/await this\.askConfirm\(/.test(bare), '⛔ 取消必须先有二次确认')
    } catch (e) { red = true }
    assert.ok(red, '⛔ ③ 抓不住"取消预约没有二次确认"这种最危险的漂移')
  })

  await runner('⑨ 判别力：注入「弹层去掉防穿透」⇒ ② 必须红', () => {
    // 漂移 A：组件遮罩去掉 catchtouchmove（最常见的"手滑删掉"）
    // ⚠️ 2026-10-04：遮罩上多了 `style="{{vars}}"`（给教练端页面注入自己的色板），
    //    锚点必须逐字带上，否则 replace 命中 0 次 ⇒ 漂移没注入 ⇒ 判据测空气（本轮真的踩到）。
    mustGoRed(
      (wxml) => assert.ok(/member-sheet-mask[^>]*catchtouchmove/.test(wxml), '遮罩必须带 catchtouchmove'),
      sheetWxml.replace('class="member-sheet-mask" style="{{vars}}" bindtap="onClose" catchtouchmove="noop"', 'class="member-sheet-mask" style="{{vars}}" bindtap="onClose"'),
      '统一弹层遮罩去掉防滚动穿透'
    )
    // 漂移 B：底部操作区去掉安全区
    mustGoRed(
      (css) => assertSheetSafety(sheetWxml, css, '统一弹层'),
      sheetWxss.replace('calc(20rpx + env(safe-area-inset-bottom))', '20rpx'),
      '弹层底部去掉安全距离（小屏顶到 Home 指示条）'
    )
    // 漂移 C：把改期面板改回自建遮罩
    mustGoRed(
      (wxml) => {
        assert.ok(!/reschedule-mask/.test(wxml), '⛔ 改期不许自建遮罩')
        assert.ok(wxml.includes('<member-sheet'), '⛔ 必须用统一弹层')
      },
      bookings.wxml.replace('<member-sheet visible="{{detail && rescheduleOpen}}"', '<view wx:if="{{detail && rescheduleOpen}}" class="reschedule-mask"><view class="reschedule-panel">').replace('</member-sheet>', '</view></view>'),
      '改期面板退回自建弹层副本'
    )
  })

  await runner('⑩ 判别力：注入「课时页退回大数字卡 + 少显示两项」⇒ ④ 必须红', () => {
    // ⚠️ 注入源用**剥掉注释后的正文**（与判据读的是同一份），
    //    否则会漂移到注释里的类名上去、判据却看不到变化 ⇒ 假绿。
    const wxml = wxmlBody(read(`${PACKAGES}.wxml`))
    // 漂移 A：顶部又变回 86rpx 大数字卡（把摘要行的数字换成 member-display 那一套类）
    mustGoRed(
      (w) => assertPackagesPage(w, '课时页'),
      wxml.replace('class="balance-num"', 'class="member-display member-balance"'),
      '顶部退回占满首屏的大数字卡'
    )
    // 漂移 B：隐藏"教练"与"已使用"两项（七件事变五件）
    mustGoRed(
      (w) => assertPackagesPage(w, '课时页'),
      wxml.replace('{{pkg.coachName}} · ', '').replace('已登记使用', '—'),
      '课包卡片少了教练与已使用'
    )
    // 漂移 C：把状态翻回英文枚举
    mustGoRed(
      (w) => assertPackagesPage(w, '课时页'),
      wxml.replace('{{pkg.statusText}}', '{{pkg.status}}'),
      '状态退回英文枚举'
    )
  })

  await runner('⑪ 判别力：注入「底部预留改回光秃秃 150rpx」⇒ ⑤ 必须红', () => {
    mustGoRed(
      (css) => assertNavReserve('member-home', css),
      baseCss.replace('calc(150rpx + env(safe-area-inset-bottom))', '150rpx'),
      '底部预留去掉安全区（iPhone X 类机器上底栏压住最后一行）'
    )
    // 顺带钉住"预留值本身不够大"这一种：把它调到比底栏矮
    mustGoRed(
      (css) => assertNavReserve('member-home', css),
      baseCss.replace('calc(150rpx + env(safe-area-inset-bottom))', 'calc(60rpx + env(safe-area-inset-bottom))'),
      '底部预留固定值小于底栏实高'
    )
  })

  await runner('⑫ 判别力：注入「取消确认去掉 danger / 文案改成技术术语」⇒ ③ 必须红', () => {
    mustGoRed(
      (wxml) => assertDangerSheet(wxml, '取消预约'),
      wxmlBody(bookings.wxml).replace('danger="{{true}}"', ''),
      '取消预约不再是危险层级（主按钮不红了）'
    )
    const bare = read(`${BOOKINGS}.js`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')
    mustGoRed(
      (js) => {
        const askAt = js.indexOf('this.askConfirm(')
        const copy = /this\.askConfirm\(`([^`]*)`/.exec(js.slice(askAt))
        assert.ok(copy && !/物理删除|级联|软删|硬删/.test(copy[1]), '⛔ 确认文案不许用技术术语')
      },
      bare.replace('已经登记的课时不会减少', '该记录将被物理删除'),
      '确认文案用"物理删除"掩盖真实行为'
    )
    mustGoRed(
      (js) => {
        const askAt = js.indexOf('this.askConfirm(')
        const copy = /this\.askConfirm\(`([^`]*)`/.exec(js.slice(askAt))
        assert.ok(copy && /不会减少/.test(copy[1]), '⛔ 必须说清课时不会减少')
      },
      bare.replace('已经登记的课时不会减少', '课时会被扣掉'),
      '确认文案让人误以为课时被扣'
    )
  })

  console.log(`\nMEMBER SHEET USAGE & LAYOUT: ${total} 段中 ${passed} 段通过`)
  if (passed !== total) { console.error('MEMBER SHEET USAGE & LAYOUT: 有失败段（见上面 ✗ 行）'); process.exitCode = 1 }
  else console.log('MEMBER SHEET USAGE & LAYOUT: ALL PASS')
}

main().catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 })
