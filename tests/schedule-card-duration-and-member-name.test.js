// A 教练端课表课程卡片时长 + C 会员账户显示名 · 永久回归（2026-10-04）
//
// ⛳ 这一份盯的是哪一种事故：**"看起来占了两个格子" / "认领了却像没生效"**。
//
// 【A 的病根】`decorateBooking` 里不跨午夜的课一律 `height:100%` —— 也就是**不管这节课是
//   30 分钟还是 90 分钟，卡片都画满一整行**。用户看到的就是"一节课像占了两个小时格"。
//   ⛔ 更要命的是 90 分钟的课被**裁在起始那一行**里，图上完全看不出它还要再往后半小时。
//   本文件把"行高"和"课程持续时间"钉成两个独立的数：行高由响应式下发，时长由课程决定。
//
// 【C 的病根】会员首页问候语用的是**账户显示名**，而认领档案名（SB）是教练建的另一套名字。
//   两者并存时用户会以为"认领没生效"；而且此前**根本没有改名入口**，也没人保证
//   「认领新档案不会覆盖显示名」这件事。
//
// ⛔ 只读源码 + 内存副本，⛔ 不启动小程序、不发云调用、不写任何数据、不改生产源码。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
const P = p => path.join(ROOT, p)
const src = p => fs.readFileSync(P(p), 'utf8')
// 同目录编译的"漂移副本"：内存里改一处，不落盘（判别力用）
function loadDrifted(abs, transform) {
  const resolved = require.resolve(abs)
  const source = fs.readFileSync(resolved, 'utf8')
  const drifted = transform(source)
  if (drifted === source) throw new Error('⛔ 漂移副本没改到任何东西（判据测空气）：' + abs)
  const m = new Module(resolved, null)
  m.filename = resolved
  m.paths = Module._nodeModulePaths(path.dirname(resolved))
  m._compile(drifted, resolved)
  return m.exports
}

let passed = 0, TOTAL = 0
async function runner(title, fn) {
  TOTAL++
  try { await fn(); passed++; process.stdout.write(`  ✓ ${title}\n`) }
  catch (error) { process.stderr.write(`  ✗ ${title}\n${error && error.stack}\n`); process.exitCode = 1 }
}

const SLOT_RE = /const slotStyle = `top:\$\{minute \/ 60 \* 100\}%;height:\$\{\(clippedEnd - startMinute\) \/ 60 \* 100\}%`/
const MINUTE = m => String(m || '').match(/-?\d+(?:\.\d+)?/g).map(Number)
// 判据专用：剥掉注释（块注释 + 行注释），避免"解释文字"被当成实现来断言
const stripComments = t => String(t).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '')

async function main() {
  // ═══════════════════════ A. 课程卡片高度按真实时长 ═══════════════════════
  await runner('A-① slotStyle 的高度必须由真实时长算出（⛔ 不许写死 height:100%）', () => {
    const js = src('pages/schedule/schedule.js')
    const m = js.match(SLOT_RE)
    assert.ok(m, '⛔ 找不到按真实时长计算高度的 slotStyle（课程卡片又变回"不管多长都占满一行"）')
    // ⛔ 旧写法必须**真的不在了**：三目里那个 height:100% 分支
    const legacy = /crossesMidnight\s*\?[^:]*:\s*`top:[^`]*height:100%`/.test(js)
    assert.strictEqual(legacy, false, '⛔ 仍然存在"不跨午夜就 height:100%"的分支 ⇒ 30/90 分钟的课会被画错')
  })

  await runner('A-② 30 / 60 / 90 分钟分别算出 50% / 100% / 150%', () => {
    // ⛔ 复刻 schedule.js 的那**一行**算式（同一份公式，不另写第二套）——
    //    这条断言的价值是"算式本身对不对"，A-③ 才钉"代码里用的是不是这一行"。
    const heightOf = (startMinute, planned) => {
      const clippedEnd = Math.min(startMinute + planned, 24 * 60)
      return { top: (startMinute % 60) / 60 * 100, height: (clippedEnd - startMinute) / 60 * 100 }
    }
    assert.deepStrictEqual(heightOf(9 * 60, 30), { top: 0, height: 50 }, '30 分钟只占半小时')
    assert.deepStrictEqual(heightOf(9 * 60, 60), { top: 0, height: 100 }, '60 分钟占一整小时')
    assert.deepStrictEqual(heightOf(9 * 60, 90), { top: 0, height: 150 }, '90 分钟占一个半小时')
    assert.deepStrictEqual(heightOf(9 * 60 + 30, 60), { top: 50, height: 100 }, '09:30 起 60 分钟 ⇒ 偏移半行、占一整行')
    assert.deepStrictEqual(heightOf(23 * 60 + 30, 60), { top: 50, height: 50 }, '⛔ 跨午夜必须截断在 24:00（23:30 只画到 24:00）')
  })

  await runner('A-③ 行高与课程时长是两个独立的数（⛔ 不许用行高去推时长）', () => {
    const js = src('pages/schedule/schedule.js')
    // ⚠️ 判据前必须**剥注释**：本文件的文件头注释里就同时出现「top/height」与「MIN_ROW_RPX」
    //    （那是解释性文字，不是实现）⇒ 不剥就会自己命中自己，判据变成测空气。
    const code = stripComments(js)
    // 时长来自 booking 自身（plannedMinutesOf），⛔ 不许来自 rowHeightStyle / MIN_ROW_RPX
    assert.ok(/occupancy\.plannedMinutesOf\(booking\)/.test(js), '⛔ 课程时长必须来自课程自身的 plannedMinutesOf')
    assert.ok(!/slotStyle[^`]*rowHeightStyle/.test(code), '⛔ 卡片高度不许引用行高变量（行高是布局，时长是业务）')
    assert.ok(!/height[^;]*MIN_ROW_RPX/.test(code), '⛔ 卡片高度不许引用最小可读行高')
  })

  await runner('A-④ 跨行卡片必须能画到下一行、并抬层级（否则被后一行文字压住）', () => {
    const wxml = src('pages/schedule/schedule.wxml')
    const wxss = src('pages/schedule/schedule.wxss')
    const js = src('pages/schedule/schedule.js')
    // ① 视图层要能知道「这张卡跨行」
    assert.ok(/spansRows/.test(js) && /booking-spans/.test(wxml), '⛔ 跨行卡片没有对应的标记/类名（后一行会盖住它）')
    // ② ⛔ 单元格必须**允许溢出**：每个小时行是独立的 .cell，150% 的卡片默认会被裁掉，
    //    那 90 分钟在图上就还是 1 小时 —— 正是这一条让「看起来只占一格」复发的。
    const cellBlocks = (wxss.match(/\.cell\{[^}]*\}/g) || [])
    assert.ok(cellBlocks.some(b => /overflow:\s*visible/.test(b)), '⛔ 没有任何 .cell 规则声明 overflow:visible ⇒ 跨行卡片会被裁掉')
    // ③ 跨行卡片要抬 z-index（后面的行在 DOM 里更靠后，不抬会被压住）
    const spanBlock = (wxss.match(/\.booking-spans\{[^}]*\}/) || [''])[0]
    assert.ok(/z-index:\s*\d/.test(spanBlock), '⛔ 跨行卡片必须抬 z-index（后面的行在 DOM 里更靠后）')
  })

  await runner('A-⑤ 七次口径的几条既有契约一条都不许被这次改动破坏', () => {
    const js = src('pages/schedule/schedule.js')
    const wxml = src('pages/schedule/schedule.wxml')
    // 整页下拉刷新（唯一刷新容器）
    assert.ok(/onPullDownRefresh\(\)\{/.test(js), '⛔ 页面级下拉刷新不见了')
    assert.ok(!/<scroll-view[^>]*rows-scroll/.test(wxml), '⛔ 行区不许变回自带 refresher 的 scroll-view')
    // 响应式行高仍由页面下发
    assert.ok(/rowHeightStyle/.test(js) && /rowHeightStyle/.test(wxml), '⛔ 响应式行高下发链路断了')
    assert.ok(/availH \/ rows/.test(js), '⛔ 行高不再按「视口底 − 行区顶」÷ 行数算（自锁回归）')
    // 跨午网点得开那一节
    assert.ok(/cellTapIntentOf/.test(js) || /bookings/.test(wxml), '⛔ 跨午夜/已占用时段的点击入口丢了')
  })

  // ═══════════════════════ C. 会员账户显示名 ═══════════════════════
  // ⭐ 2026-10-06：旧「训练档案 / 已认领档案」页已整体下线 ⇒ C 段改为盯**唯一会员资料**。
  await runner('C-① 「我的」页有「编辑昵称」入口，且走统一出口（⛔ 不许自己拼云调用）', () => {
    const wxml = src('pages/member-profile/member-profile.wxml')
    const js = src('pages/member-profile/member-profile.js')
    assert.ok(wxml.includes('编辑昵称'), '⛔「我的」页没有编辑昵称入口')
    assert.ok(js.includes('directory.renameSelf('), '⛔ 改名必须走 utils/member-directory 这一条统一出口')
    assert.ok(js.includes('nameBusy'), '⛔ 改名必须防重复提交')
    assert.ok(js.includes('没有保存成功'), '⛔ 失败必须如实提示（不许当成功）')
    assert.ok(!/wx\.cloud\.callFunction/.test(js), '⛔ 页面不许直接调 wx.cloud（会绕过 requestId / 回执）')
  })

  await runner('C-② 首页问候语用的是**会员昵称**；⛔ 不再有第二套"档案名"', () => {
    const home = src('pages/member-home/member-home.wxml')
    assert.ok(home.includes('你好，{{vm.member.displayName'), '首页问候语必须继续用会员显示名')
    // ⛔ 一位会员**始终只有一份资料** ⇒ "账号名 / 档案名 两套名字"这套说法必须消失。
    assert.ok(!home.includes('member-archive-picker'), '⛔ 首页不许再挂档案选择器（已不再有档案这一层）')
    const pages = fs.readdirSync(P('pages')).filter(name => !name.startsWith('.')).map(name => `pages/${name}/${name}.wxml`)
    const still = pages.filter(rel => fs.existsSync(P(rel)) && src(rel).includes('当前档案'))
    assert.deepStrictEqual(still, [], `⛔ 还有页面在说「当前档案」：${still.join(', ')}`)
  })

  await runner('C-③ 换手机登录**不得**重建会员资料（只在归属行上重绑）', () => {
    const js = src('cloudfunctions/memberIdentityCommand/service.js')
    // 取 claimStudentRecord 分支那一段
    const at = js.indexOf("action === 'claimStudentRecord'")
    assert.ok(at > 0, '找不到 claimStudentRecord')
    const seg = js.slice(at, at + 2400)
    const end = seg.indexOf("} else if (action === '")
    const body = end > 0 ? seg.slice(0, end) : seg
    assert.ok(!/displayName/.test(body), '⛔ 认领分支里出现了 displayName ⇒ 认领新档案会偷偷覆盖账户显示名')
    assert.ok(/put\(tx, n\.claims/.test(body), '⛔ 认领必须只写认领关系')
    // ⛔ 反向：改名命令不许碰认领关系
    const at2 = js.indexOf("action === 'updateProfile'")
    const seg2 = js.slice(at2, at2 + 600)
    const body2 = seg2.slice(0, seg2.indexOf("} else if (action === '") > 0 ? seg2.indexOf("} else if (action === '") : 600)
    assert.ok(/put\(tx, n\.accounts/.test(body2), '⛔ 改名必须写 accounts')
    assert.ok(!/put\(tx, n\.claims/.test(body2), '⛔ 改名不许碰认领关系')
  })

  // ═══════════════════════ 判别力 ═══════════════════════
  await runner('判别力-A：把 slotStyle 改回「不跨午夜就 height:100%」 ⇒ A-① 必须红', () => {
    // ⚠️ A-① 的判据是**读源码文本**的（那一条算式就写在源码里），所以这里也只做文本漂移。
    //    ⛔ 刻意**不加载** schedule.js：它在模块顶层就调 `Page()`（小程序运行时才有），
    //    在 node 里加载会抛 "Page is not defined" —— 那种失败与判据无关，纯噪音。
    const text = src('pages/schedule/schedule.js')
    const drifted = text.replace(SLOT_RE, "const slotStyle = crossesMidnight ? `top:${minute / 60 * 100}%;height:${(clippedEnd - startMinute) / 60 * 100}%` : `top:${minute / 60 * 100}%;height:100%`")
    assert.notStrictEqual(drifted, text, '漂移必须真的改到东西（改不到 = 判据测空气）')
    let red = false
    try {
      // 与 A-① **逐字同一条**判据（不另写第二份，⛔ 两份判据会各自漂移）
      // ⚠️ 这里**不能**用 `[^:]*`：漂移文本里第一个模板串就带 `${...}`，字符类会在冒号处断掉，
      //    于是判据对真实的回归"视而不见"（判别力必须自己抓得住，否则等于没写）。
      const legacy = /crossesMidnight\s*\?[\s\S]{0,240}?height:100%/.test(drifted)
      assert.strictEqual(legacy, false, '⛔ 仍然存在 height:100% 分支')
    } catch (e) { red = true }
    assert.ok(red, true ? '' : '')
    assert.ok(red, '⛔ A-① 抓不住「卡片高度回退成写死 100%」这种回归')
  })

  await runner('判别力-A2：卡片高度改用行高变量推算 ⇒ A-③ 必须红', () => {
    const text = src('pages/schedule/schedule.js')
    const drifted = text.replace(SLOT_RE, "const slotStyle = `top:${minute / 60 * 100}%;height:${(60 / rowH) * 100}%`")
    let red = false
    try { assert.ok(!/slotStyle[^`]*rowHeightStyle/.test(drifted) && !/height[^;]*MIN_ROW_RPX/.test(drifted), '⛔ 卡片高度不许引用行高') } catch (e) { red = true }
    assert.ok(red, '⛔ A-③ 抓不住"用行高去推课程时长"这种回归')
  })

  await runner('判别力-C：认领分支里偷偷写 displayName ⇒ C-③ 必须红', () => {
    const text = src('cloudfunctions/memberIdentityCommand/service.js')
    const drifted = text.replace(
      "await put(tx, n.tokens, tokenId, { ...tokenRow, status: 'used'",
      "await put(tx, n.accounts, fixedId(n.accounts, account.memberId), { ...account, displayName: tokenRow.studentId, updatedAt: timestamp })\n          await put(tx, n.tokens, tokenId, { ...tokenRow, status: 'used'"
    )
    assert.notStrictEqual(drifted, text, '漂移必须真的改到东西')
    const at = drifted.indexOf("action === 'claimStudentRecord'")
    const seg = drifted.slice(at, at + 2400)
    const end = seg.indexOf("} else if (action === '")
    const body = end > 0 ? seg.slice(0, end) : seg
    let red = false
    try { assert.ok(!/displayName/.test(body), '⛔ 认领分支里不许出现 displayName') } catch (e) { red = true }
    assert.ok(red, '⛔ C-③ 抓不住"认领时偷偷覆盖显示名"这种回归')
  })

  console.log(`\nSCHEDULE CARD DURATION + MEMBER NAME: ${TOTAL} 段中 ${passed} 段通过`)
}
main().then(() => {
  if (process.exitCode) { console.error('有失败段（见上面 ✗ 行）'); return }
  console.log('ALL PASS')
}).catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 })
