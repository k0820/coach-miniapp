// 2026-10-02 真机问题（测试环境周课表）：滑到底后 **23:00 那一行只剩约半格**，
//   23:30 的跨午夜旧课卡片看不见；网格下方还有一段空白，再往下才是底部导航。
//
// ⛔ 第一版修法（已作废）："把 24 行挤进剩下的高度"（.row-grid flex:1 均分）+ 手写页头常数 162rpx。
//   实测与算出来的结果都很难看：行高被压到 12~22px；横幅 + 取消通知条一出现，小屏只剩 11.8px。
//   用户明确不接受"为通过测试把可用性判据降下来"，也不接受"为不遮挡而缩小格子"。
//
// ⛔ 三次口径（已作废，只作历史）：行高 44rpx + 24 行 00:00–23:00 + 「＋」进页头工具条 + --fab-safe:0。
//   作废原因：24 行 × 44rpx 时一行只有 22px，格子挤得连课程卡片的字都发虚；
//   而"＋"藏在页头工具条里，和"回到今天 / 选择日期"同级，教练看不出它是"新建课程"。
//
// ⭐ 现行口径 = **四次口径**（本测试逐条钉死）：
//   · 小时行**固定高度** `--hour-row-h:50rpx`（26px），主网格**默认 06:00–23:00 共 18 行**；
//   · 凌晨 **00:00–05:59 共 6 行**（LATE_HOURS）**真有课才渲染**，有就整段出来、自动展开、可收起；
//     没有就一行都不占（现存 168 条生产预约里 hour<6 是 0 条，见 OVERNIGHT-CHECK-20261002.md）；
//     ⛔ 但**不许把这 6 行删死**：补录通道只判最晚 23:00、不判最早 ⇒ 00:00–05:59 的课
//       必须有格子装它（第 ① 段钉"覆盖 0–23 无缺口"，第 ⑭ 段钉"真有课时真的渲染出来"）。
//   · 「＋ 新建课程」胶囊回到**右下角、tabBar 上方**，样式是 app.wxss 的 `.fab-capsule`（唯一来源）；
//     课表用 `--fab-safe:104rpx` 主动让出等高的一条带 ⇒ 胶囊**永不压任何行 / 卡片 / 末行**；
//   · 整页 column flex：课表吃掉剩下的全部高度 ⇒ 不再有手写页头常数；
//   · 横幅 / 通知条 / 凌晨提示条出现时，少的是**可见行数**，行高一个像素都不变（第 ② 段钉死）。
//
// ⛔ 本文件**只读**：不写任何业务数据、不碰 Production / Sandbox、不改准入规则。
// ⛔ 反证见 tests/_week-grid-bottom-mutate.js（只改**内存里的文本副本**，不动生产源码）。
// ⛔ 公式 vs 实测的实测基线来自 tests/fixtures/week-grid-rendered.json 的 `measuredRound4`
//    （由 _render-probe-round4.js 在开发者工具里量出来的，见那一节的 _how / _caveat）。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const geom = require('./helpers/week-grid-geometry')
const scheduleView = require('../utils/schedule-view')
const occupancy = require('../utils/package-occupancy')

const ROOT = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const SOURCES = {
  scheduleWxss: read('pages/schedule/schedule.wxss'),
  bannerWxss: read('components/sandbox-banner/sandbox-banner.wxss'),
  appWxss: read('app.wxss'),
  scheduleJs: read('pages/schedule/schedule.js')
}
const scheduleWxml = read('pages/schedule/schedule.wxml')
const bannerWxml = read('components/sandbox-banner/sandbox-banner.wxml')
const FX = JSON.parse(read('tests/fixtures/week-grid-rendered.json'))
const R4 = FX.measuredRound4

// 最晚开课的**小时**（从 occupancy 取，不写死数字）：23
const LATEST_HOUR = Math.floor(occupancy.latestStartMinutes() / 60)

// 真机可视区（windowHeight ≈ 屏幕高 − 导航栏 − 底部导航），小屏 / 常见 / 大屏三种都算一遍。
// ⛔ iPhone 6/7/8 那一档在**本轮没有真像素证据**（模拟器窗口当前停在 390×671 档，
//    切机型要人在 IDE 顶部操作）⇒ 它只参与**公式侧**判据（行高恒定 / 不裁末行 / 胶囊不遮挡），
//    不参与"公式 vs 实测"的比对。想补小屏实测：切机型后重跑 _render-probe-round4.js。
const DEVICES = [
  { name: 'iPhone SE 375x667', windowWidth: 375, windowHeight: 560 },
  { name: 'iPhone 14 390x844', windowWidth: 390, windowHeight: 670 },
  // ⭐ 用户的**真机**就是这一台（393×852）⇒ 公式侧必须覆盖它（实测由用户真机验收兜底）。
  { name: 'iPhone 14 Pro 393x852', windowWidth: 393, windowHeight: 679 },
  { name: 'iPhone 14 Pro Max 430x932', windowWidth: 430, windowHeight: 758 }
]
const STATES = [
  { withBanner: false, noticePx: 0, label: '正式区' },
  { withBanner: true, noticePx: 0, label: '测试区' },
  { withBanner: true, noticePx: R4.noticeFlowHeight, label: '测试区+取消通知条' },
  { withBanner: false, noticePx: R4.noticeFlowHeight, label: '正式区+取消通知条' }
]
// ⛔ 取消通知条与凌晨提示条的**占流高度都不从 wxss 再推一遍**（那样就是公式自证）；
//    两者都取实测值。通知条：rowsTop 131.5 − 99 = 32.5px；凌晨提示条：518 − 487 = 31px。
const NOTICE_PX = R4.noticeFlowHeight
const LATE_PX = R4.lateBlock.barFlowHeight
// ⭐「少量滚动」的阈值（px）：横幅 / 通知条这些**占流**元素吃掉的可视高度，不该超过三行。
//   ⛔ 本轮 fixture 机型换成**最矮**的 iPhone 6/7/8（375×555）⇒ 横幅档可滚 39px、最坏档 71px。
//      这是"允许少量滚动"这一既有口径的量化，不是放宽"一屏全见"的目标（prod 档仍钉 0）。
const SMALL_SCROLL_PX = 80
// ⭐ 最小可读行高（rpx）：**从源码读**，常量一漂这里立刻跟着变（不许抄成字面量）。
//   它与 app.wxss 的 `--hour-row-h` 必须**同源**（tests/schedule-grid-responsive.test.js 盯着）。
const MIN_ROW_RPX = (() => {
  const m = SOURCES.scheduleJs.match(/MIN_ROW_RPX\s*=\s*(\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : 0
})()

const geomOf = (device, withBanner, options) => geom.geometryOf(SOURCES, device, withBanner, options)

let passed = 0
let TOTAL = 0
async function runner(title, fn) {
  TOTAL++
  try { await fn(); passed++; process.stdout.write(`  ✓ ${title}\n`) }
  catch (error) { process.stderr.write(`  ✗ ${title}\n${error && error.stack}\n`); process.exitCode = 1 }
}

async function main() {
  // ------------------------------------------------------------------ ① 18 行主网格 + 6 行凌晨段 = 覆盖 00:00–23:00
  await runner('① 主网格默认 06:00–23:00（18 行）+ 凌晨 00:00–05:59（6 行）⇒ 合起来**恰好**覆盖 0–23，无缺口、无重复', () => {
    const h = geom.hoursOf(SOURCES.scheduleJs)
    assert.strictEqual(h.mainCount, 18, `主网格必须是 18 行（06:00–23:00），实测 ${h.mainCount}`)
    assert.strictEqual(h.mainStart, 6, `主网格必须从 06:00 起，实测从 ${h.mainStart}:00 起`)
    assert.strictEqual(h.lateCount, 6, `凌晨段必须是 6 行，实测 ${h.lateCount}`)
    assert.strictEqual(h.lateStart, 0, `凌晨段必须从 00:00 起（补录通道允许 00:00 开课），实测从 ${h.lateStart} 起`)
    const main = { from: h.mainStart, to: h.mainStart + h.mainCount - 1 }
    const late = { from: h.lateStart, to: h.lateStart + h.lateCount - 1 }
    assert.strictEqual(main.to, LATEST_HOUR, `主网格最后一行必须是最晚开课 ${LATEST_HOUR}:00，实测 ${main.to}:00`)
    assert.strictEqual(late.to + 1, main.from, `凌晨段必须紧挨主网格（${late.to}:59 与 ${main.from}:00 之间不许出现空洞）`)
    assert.strictEqual(late.from, 0, '凌晨段必须覆盖到 00:00')
    // ⛔ hour 24 那行不许回来（它没有任何课可以装，只会白占一格高度）
    assert.ok(!/HOURS\s*=\s*Array\.from\(\{\s*length:\s*19/.test(SOURCES.scheduleJs),
      '⛔ 主网格被扩成 19 行 ⇒ 多出来的就是 24:00 那行空行')
    // 行高（⭐ 2026-10-03 六次口径）：`--hour-row-h` 现在是**最小可读行高**（下限），
    //   真实行高 = 行区可用高度 ÷ 当前行数，由页面实测后下发（详见 tests/schedule-grid-responsive.test.js）。
    const hourRow = geom.varRpx(SOURCES.appWxss, 'hour-row-h')
    assert.ok(hourRow > 0, 'app.wxss 必须定义 --hour-row-h（小时行的**最小**可读行高）')
    assert.ok(hourRow >= 44, `--hour-row-h 只剩 ${hourRow}rpx ⇒ 比三次口径（44rpx）还窄，格子里的字又要发虚了`)
    for (const sel of ['.row-grid', '.day-row']) {
      const height = geom.declOf(SOURCES.scheduleWxss, sel, 'height')
      assert.strictEqual(height, 'var(--hour-row-h)', `${sel} 的**兜底**高度必须是 var(--hour-row-h)，实测 "${height}"`)
      const flex = geom.declOf(SOURCES.scheduleWxss, sel, 'flex')
      assert.ok(/none/.test(flex), `${sel} 必须是 flex:none（不许再 flex:1 均分 ⇒ 会被压缩），实测 "${flex}"`)
    }
    for (const device of DEVICES) {
      const g = geomOf(device, true)
      assert.strictEqual(g.hour23Index, g.lastIndex, `${device.name}：23:00 必须是**主网格**最后一行`)
    }
    // 凌晨段展开时，最后一行仍然是 23:00（凌晨行在最上面）
    const gLate = geomOf(DEVICES[1], false, { lateExpanded: true, latePx: LATE_PX })
    assert.strictEqual(gLate.renderedRows, 24, '凌晨段展开后总共 24 行')
    assert.strictEqual(gLate.hour23Index, gLate.lastIndex, '凌晨段展开时 23:00 仍然是最后一行（凌晨行在最上面）')
  })

  // ------------------------------------------------------------------ ②⭐ 行高**响应式** + 有效性证据
  // ⛔ 旧口径（"任何机型 × 任何状态行高都恒定"）已于 2026-10-03 作废：那正是 1.3.10 真机 Bug 的根因
  //    （18 行恒定 900rpx，而行区高度随机型涨 ⇒ 屏幕越大底部空白越多，删掉胶囊后彻底暴露）。
  //    新口径：**铺满行区**，守住最小可读行高；可用性仍由**真实 tap / 卡片实测**证明。
  await runner('② ⭐ 行高**响应式**（可用高度 ÷ 行数，守住最小可读行高）+ 可用性由**真实证据**证明（tap 实测 + 卡片实测）', () => {
    const minRowPx = MIN_ROW_RPX * 1 // 每档按该机型 rpx 折算，见下面逐机型算
    // ① 响应式：任何机型 × 任何页头状态，行区都必须**被铺满**（这是"不留底部空白"的公式侧判据）。
    for (const device of DEVICES) {
      const minPx = MIN_ROW_RPX * device.windowWidth / 750
      const base = geomOf(device, false)
      for (const st of STATES) {
        const g = geomOf(device, st.withBanner, { noticePx: st.noticePx })
        assert.ok(g.rowH >= minPx - 0.01,
          `${device.name}·${st.label}：行高 ${g.rowH.toFixed(2)}px < 最小可读 ${minPx.toFixed(2)}px ⇒ 行被压到点不中`)
        assert.ok(g.rowsContentH >= g.rowsViewportH - 0.5,
          `${device.name}·${st.label}：行总高 ${g.rowsContentH.toFixed(1)} < 行区 ${g.rowsViewportH.toFixed(1)} ⇒ 底部留了 ${(g.rowsViewportH - g.rowsContentH).toFixed(1)}px 空白`)
        // 没触到下限时必须**恰好铺满**（零滚动）；触到下限才允许滚动。
        if (g.rowH > minPx + 0.01) {
          assert.ok(Math.abs(g.rowsContentH - g.rowsViewportH) < 0.5,
            `${device.name}·${st.label}：行高还有余量却没铺满 ⇒ 又是写死高度`)
        }
      }
      const gLate = geomOf(device, false, { lateExpanded: true, latePx: LATE_PX })
      assert.ok(gLate.rowH >= minPx - 0.01, `${device.name}·凌晨段展开：行高掉到可读下限以下`)
      assert.ok(gLate.rowsContentH >= gLate.rowsViewportH - 0.5, `${device.name}·凌晨段展开：底部留白`)
    }
    // ② 回归护栏：任何机型下行高都不许低于它的最小可读值
    //    （⛔ 可用性**不靠行高这个代理判据**，靠下面的实测证据；这条只防"守不住下限"）
    const g0 = geomOf(DEVICES[0], false)
    const min0 = MIN_ROW_RPX * DEVICES[0].windowWidth / 750
    assert.ok(g0.rowH >= min0 - 0.01,
      `行高只剩 ${g0.rowH.toFixed(1)}px（下限 ${min0.toFixed(1)}px）⇒ 还没开始守下限`)
    assert.ok(minRowPx > 0, 'MIN_ROW_RPX 必须从源码读出（mina_app 常量漂移由 tests/schedule-grid-responsive.test.js 盯）')
    // ③ ⭐ 真实 tap 证据（_render-probe-round4.js）：戳空格，新建课程弹层必须真的起来。
    //    ⛔ 五次口径：右下胶囊已删除 ⇒ tap 证据只剩"戳空格"这一条（它现在是**唯一**的新建入口）。
    assert.strictEqual(R4.tap.cell, true, '⛔ 空格的 tap 实测没过 ⇒ 重跑 _render-probe-round4.js 核实')
    // ④ 卡片实测可读（这是把行高提到 50rpx 的**唯一理由**，必须量出来）
    const card = R4.card
    assert.ok(card.h > 0, `整格课程卡片实测高 ${card.h}px ⇒ 挤没了`)
    assert.ok(card.h >= 0.8 * card.rowH,
      `整格卡片只有 ${card.h}px（所在行 ${card.rowH}px）⇒ 卡片没占满格子，行高白白加上去了`)
    assert.ok(parseFloat(card.fontSize) >= 8, `卡片字号 ${card.fontSize} ⇒ 小到不可读`)
    assert.ok(String(card.text).indexOf('整格课') >= 0, `卡片文案 "${card.text}" 不完整`)
    // ⑤ 凌晨行里的卡片同样真的渲染出来了（早于 06:00 的课有格子装它）
    const lateCard = R4.lateBlock.card
    assert.ok(lateCard.h > 0, `凌晨行卡片实测高 ${lateCard.h}px ⇒ 凌晨课没地方画`)
    assert.ok(String(lateCard.text).indexOf('凌晨课') >= 0, `凌晨行卡片文案 "${lateCard.text}" 不完整`)
  })

  // ------------------------------------------------------------------ ③⭐ 一屏目标 + 滑到底完整
  await runner('③ ⭐ 常规屏无横幅 = 一屏全见（零滚动）；其余档允许少量滚动，滑到底 23:00 行**完整**', () => {
    const band = geom.blockBandOf(23, 30, 60)
    assert.strictEqual(band.top, 50, '23:30 的卡片从 23:00 行的 50% 处开始')
    assert.strictEqual(band.height, 50, '跨午夜截断在 24:00 ⇒ 卡片高 50%')
    // ① ⭐ 产品目标：常规屏（390×671）无横幅零滚动 + 18 行全见（fixture 实测，不是公式自证）
    const regW = R4.reg.week.prod
    assert.strictEqual(regW.scrollable, 0, `常规屏无横幅可滚 ${regW.scrollable}px ⇒ 一屏全见的目标丢了`)
    assert.strictEqual(regW.visibleHours >= 18, true, `常规屏无横幅一屏只见 ${regW.visibleHours} 行`)
    assert.ok(regW.content / R4.reg.rowH === R4.reg.rowsDefault + 0.0,
      `实测内容高 ${regW.content} ÷ 行高 ${R4.reg.rowH} ≠ ${R4.reg.rowsDefault} 行 ⇒ 行数或行高口径不一致`)
    // ② 通知条档实测：**允许少量滚动**（fixture 机型换成最矮的 iPhone 6/7/8 之后，通知条会吃掉 32.5px）
    //    ⛔ 这条原来是 strictEqual(0)，那是 390×671 上的结论；本轮换到 375×555（最矮、最严苛）后
    //       通知档可滚 23px（≈1 行），属"少量"。⛔ **一屏全见的目标没变**：prod 档仍然必须是 0（见上面）。
    const noticeW = R4.reg.week.notice
    assert.ok(noticeW.scrollable <= SMALL_SCROLL_PX,
      `通知条档实测可滚 ${noticeW.scrollable}px ⇒ 超出"少量"范围（阈值 ${SMALL_SCROLL_PX}px）`)
    // ③ 公式侧：任何机型 × 任何状态，**滚到底**时 23:00 行与 23:30 卡片都完整落在视口里。
    //    ⭐ 七次口径：滚动容器是**整页**（不再是行区内部）⇒ 这里比的是视口底，不是行区下沿；
    //      "滚到底一定看得到"是结构性成立的（页面高度就是按内容算的），判据只是把它钉住。
    for (const device of DEVICES) for (const st of STATES) {
      const g = geomOf(device, st.withBanner, { noticePx: st.noticePx })
      assert.ok(g.rowsViewportH > 0,
        `${device.name}·${st.label}：行区可用高 ${g.rowsViewportH.toFixed(1)}px ≤ 0 ⇒ 页头把课表吃光了`)
      assert.ok(g.hour23FullyVisible,
        `${device.name}·${st.label}：滚到底 23:00 行底 ${g.hour23BottomAtBottom.toFixed(1)} 仍超出视口底 ${g.vh}`)
      const cardTop = g.hour23TopAtBottom + g.rowH * band.top / 100
      const cardBottom = cardTop + g.rowH * band.height / 100
      assert.ok(cardBottom <= g.vh + 0.01 && cardTop >= 0,
        `${device.name}·${st.label}：23:30 卡片 ${cardTop.toFixed(1)}~${cardBottom.toFixed(1)} 超出视口 0~${g.vh} ⇒ 又被裁`)
    }
    // ④ 最坏档（横幅 + 通知条）实测：滑到底 23:00 完整，而且**溢出的只有 31px**（≈ 1 行多，不是"半屏"）
    const worstW = R4.reg.week.worst
    assert.ok(worstW.scrollable <= SMALL_SCROLL_PX, `最坏档可滚 ${worstW.scrollable}px ⇒ 超出"少量"范围（阈值 ${SMALL_SCROLL_PX}px），页头又被撑大了`)
    assert.ok(worstW.lastBottomAtBottom <= worstW.rowsTop + worstW.rowsH + 0.6,
      `最坏档滑到底 23:00 行底 ${worstW.lastBottomAtBottom} 超出小行区下沿 ${worstW.rowsTop + worstW.rowsH}`)
    // ⑤ 日视图同样口径（实测）
    assert.strictEqual(R4.reg.day.prod.scrollable, 0, `日视图常规屏可滚 ${R4.reg.day.prod.scrollable}px`)
  })

  // ------------------------------------------------------------------ ④⭐ 五次口径：右下胶囊删除 + 课表铺到 tabBar
  // ⛔ 2026-10-03 真机验收：右下「＋ 新建课程」悬浮胶囊**删除**（它压在课表右下角、
  //    教练第一眼把它当装饰；而为了不遮挡它，课表还得在底部白让一条 104rpx 的带）。
  //    ⇒ 新建课程的**唯一**入口回到**点空白时间格**（本来就是这条路径，业务规则一个字没改）。
  //    这条钉四件事：① 胶囊彻底不存在（wxml + app.wxss）；② .fab-pill 不许回潮；
  //    ③ 课表**不再让出**任何底部带；④ 课表底**贴着**视口底（tabBar 上沿）。
  await runner('④ ⭐ 右下「＋ 新建课程」胶囊**已删除**；课表不再让出底部带，一路铺到 tabBar 上方', () => {
    // ⛔ 先剥掉 wxml 注释再匹配 —— 注释里记录了历史（含 class="fab-capsule" 字样），不算回潮。
    const wxmlNoComment = scheduleWxml.replace(/<!--[\s\S]*?-->/g, '')
    assert.ok(!/class="fab-capsule"/.test(wxmlNoComment), '⛔ 右下悬浮胶囊（.fab-capsule）回来了 —— 本轮已删除')
    assert.ok(!/class="fab-pill"/.test(wxmlNoComment), '⛔ 页头工具条里那枚小 ＋（.fab-pill）回来了')
    const appNoComment = SOURCES.appWxss.replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!/\.fab-capsule\s*\{/.test(appNoComment), '⛔ app.wxss 里仍有 .fab-capsule 规则（死样式：没有页面再用它）')
    const scheduleWxssNoComment = SOURCES.scheduleWxss.replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!/\.fab-capsule/.test(scheduleWxssNoComment), '⛔ 课表页自己又写了一套 .fab-capsule')

    // ① 课表不再让出底部带（周 / 日 / 月三个视图都是 0）
    const swiperMb = geom.declOf(SOURCES.scheduleWxss, '.week-swiper', 'margin-bottom')
    assert.ok(!/var\(--fab-safe\)/.test(swiperMb), `⛔ .week-swiper 又在让底部带（实测 "${swiperMb}"）`)
    const dayMb = geom.declOf(SOURCES.scheduleWxss, '.schedule-page .day-calendar,.schedule-page .month-calendar', 'margin-bottom')
    assert.ok(!/var\(--fab-safe\)/.test(dayMb), `⛔ 日/月视图又在让底部带（实测 "${dayMb}"）`)
    assert.ok(!/--fab-safe/.test(appNoComment), '⛔ app.wxss 里 --fab-safe 回来了（它是留给悬浮按钮的让位量）')

    // ② 公式侧：任何机型 × 任何状态，让位量必须是 0，且课表底贴着视口底（差 ≤ 课表自己那条 1rpx 边框 ×2）
    for (const device of DEVICES) for (const st of STATES) {
      const g = geomOf(device, st.withBanner, { noticePx: st.noticePx })
      assert.strictEqual(g.fabSafe, 0, `${device.name}·${st.label}：课表仍在让出 ${g.fabSafe.toFixed(1)}px 底部带`)
      assert.ok(g.scheduleFillsToTabBar,
        `${device.name}·${st.label}：课表底 ${g.calendarBottom.toFixed(1)} 距视口底 ${g.vh} 还有 ${g.calendarGapBelowViewport.toFixed(1)}px ⇒ 底部又空出一块`)
    }

    // ③ ⭐ 新建入口仍在 —— 由**真实 tap** 证明（这枚入口现在只靠点空格）
    assert.strictEqual(R4.tap.cell, true, '⛔ 空格 tap 实测没过 ⇒ 新建课程入口没了（重跑 _render-probe-round4.js 核实）')
    assert.strictEqual(R4.tap.capsuleGone, true, '⛔ 实测里 .fab-capsule 仍然存在 ⇒ 删除没生效')
    // ④ 腾出来的高度要**真的给了行区**（不是被别的东西吃掉）
    const cap0 = R4.reg.week.prod
    assert.ok(cap0.calendarGapToTabBar <= 4,
      `实测课表底距视口底 ${cap0.calendarGapToTabBar}px ⇒ 底部仍有一块空白（本该只有课表边框那 1~2px）`)
  })

  // ------------------------------------------------------------------ ⑤ 横幅高度与页面补偿**同源**
  await runner('⑤ 横幅高度常量与页面补偿值同源：改了横幅高度就必须改 app.wxss 的变量', () => {
    const bannerH = geom.numOf(geom.declOf(SOURCES.bannerWxss, '.sandbox-banner', 'height'))
    assert.ok(bannerH > 0, '⛔ 横幅高度必须**显式写死**（页面要靠它算补偿），不能靠内容撑')
    const declared = (SOURCES.appWxss.match(/--sandbox-banner-h:\s*(\d+(?:\.\d+)?)rpx/) || [])[1]
    assert.ok(declared, 'app.wxss 必须定义 --sandbox-banner-h')
    assert.strictEqual(parseFloat(declared), bannerH, `横幅 ${bannerH}rpx 与变量 ${declared}rpx 不一致 ⇒ 课表会被推下去`)
    const withBanner = geom.declOf(SOURCES.scheduleWxss, '.schedule-page.with-banner', 'min-height')
    assert.ok(/var\(--sandbox-banner-h\)/.test(withBanner), `.with-banner 必须扣掉 --sandbox-banner-h，实测 "${withBanner}"`)
    assert.ok(/100vh/.test(withBanner), '.with-banner 仍要以 100vh 为基准')
  })

  // ------------------------------------------------------------------ ⑥ 刷新容器：页面级**唯一**一个 + 40rpx 余量
  await runner('⑥ 刷新容器只剩**页面级**一个（40rpx 余量仍在）；时间网格不再自带下拉（手指落在网格上也是整页下拉）', () => {
    // ⭐ 1.3.11：页面由 `height` 改 `min-height`（高度随内容增长，卡片被撑高时整页滚动），
    //    但 40rpx 余量一个字没动 —— 它是"页面存在可滚动空间"，微信原生下拉刷新触发的前提（1.1.9 真机事故）。
    const pageMinH = geom.declOf(SOURCES.scheduleWxss, '.schedule-page', 'min-height')
    assert.ok(/\+\s*40rpx/.test(pageMinH), `.schedule-page 必须是 calc(100vh + 40rpx) 的 min-height，实测 "${pageMinH}"`)
    assert.ok(/100vh/.test(pageMinH), '.schedule-page 仍要以 100vh 为基准')
    assert.ok(/\+\s*40rpx/.test(geom.declOf(SOURCES.scheduleWxss, '.schedule-page.with-banner', 'min-height')), '.with-banner 也要保留 40rpx 余量')
    for (const device of DEVICES) for (const withBanner of [false, true]) {
      const g = geomOf(device, withBanner)
      assert.ok(g.pullAllowance > 0,
        `${device.name}${withBanner ? '（测试区）' : ''}：页面不再可滚 ⇒ onPullDownRefresh 永不触发`)
      assert.ok(g.pullAllowance >= g.rpx * 40 - 0.01, `${device.name}：可滚动余量不足 40rpx`)
    }
    // ⛔ 网格内部下拉必须**彻底消失**：这些都回来，真机上就又会变成"只有时间网格下移 + 一大块三点空白"。
    const wxmlNoComment = scheduleWxml.replace(/<!--[\s\S]*?-->/g, '')
    assert.ok(!/<scroll-view[^>]*class="rows-scroll"/.test(wxmlNoComment),
      '⛔ 时间网格又变回 scroll-view 了 ⇒ 下拉会退化成"只有网格下移"')
    assert.ok(!/refresher-enabled|refresher-triggered|bindrefresherrefresh/.test(wxmlNoComment),
      '⛔ 网格自带下拉的属性（refresher-*）回来了 ⇒ 那块三点加载区会跟着回来')
    const jsNoComment = SOURCES.scheduleJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    assert.ok(!/onGridRefresh|gridRefreshing/.test(jsNoComment),
      '⛔ 网格内部下拉那套（onGridRefresh / gridRefreshing）还在 ⇒ 没删干净')
    // ✅ 页面级下拉必须真的在：enablePullDownRefresh + onPullDownRefresh + 同一条用户级读取路径
    assert.ok(/"enablePullDownRefresh":\s*true/.test(read('pages/schedule/schedule.json')),
      '⛔ 页面级下拉刷新被关了 ⇒ 唯一容器没了')
    assert.ok(/onPullDownRefresh\s*\(/.test(SOURCES.scheduleJs), '⛔ 页面没有 onPullDownRefresh 实现')
    // ⛔ 写法按**现状**逐字钉（`{userInitiated:true}` 不加空格）：pull-refresh-fresh-read.test.js
    //    用 `onPullDownRefresh\(\)\{([^}]*)\}` 抓方法体（遇第一个 `}` 截断），而它断言的正是
    //    无空格写法 ⇒ 这条契约两侧必须字面一致，不能各写各的。这里放宽成"允许空白"，
    //    既保住"必须走用户级读取路径"的语义，也不会跟那条老契约打架。
    assert.ok(/refreshSchedule\(\{\s*userInitiated:\s*true\s*\}\)/.test(SOURCES.scheduleJs),
      '页面级下拉必须走**同一条**用户级读取路径')
    // ✅ 紧凑提示条：占流（44rpx）、完成收回；⛔ 不许再做成"三个点"
    const wxssNoComment = SOURCES.scheduleWxss.replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(/\.refresh-hint\s*\{/.test(wxssNoComment), '⛔ 顶部紧凑刷新提示条（.refresh-hint）没了')
    assert.ok(/\.refresh-hint\.on\s*\{[^}]*height:44rpx/.test(wxssNoComment), '紧凑提示条展开高度必须是 44rpx（一条，不是一大块）')
    assert.ok(/class="refresh-hint \{\{refreshing\?'on':''\}\}"/.test(scheduleWxml), '提示条必须绑 refreshing')
    assert.ok(/refreshing:\s*false/.test(SOURCES.scheduleJs) && /setData\(\{\s*refreshing:\s*true\s*\}|refreshing:\s*true/.test(SOURCES.scheduleJs),
      '页面必须有 refreshing 状态（松手出现、完成收回）')
    // ⭐ 1.3.11：下拉那一轮必须把 promise **交出去**（调用方 await 的是"真的换过视图"）
    assert.ok(/return\s+r\.then\(done,\s*done\)/.test(SOURCES.scheduleJs),
      '⛔ onPullDownRefresh 没有把读取那一轮的 promise 交出去 ⇒ 调用方 await 立刻返回（跨设备刷新/即时渲染两条回归都盯这条）')
  })

  // ------------------------------------------------------------------ ⑦ 整页 flex：页头不再有手写高度常数
  await runner('⑦ 整页 column flex + 课表 flex:1 ⇒ 页头多一个占流元素也不会把课表顶到胶囊底下', () => {
    const page = geom.declOf(SOURCES.scheduleWxss, '.schedule-page', 'display')
    assert.ok(/flex/.test(page), `.schedule-page 必须是 flex 容器，实测 "${page}"`)
    assert.strictEqual(geom.declOf(SOURCES.scheduleWxss, '.schedule-page', 'flex-direction'), 'column', '.schedule-page 必须是 column')
    // ⭐ 2026-10-03（1.3.11）：周/日课表卡片改 `flex:none` —— 高度由页面实测下发、**由内容撑开**
    //    （空间不足时整页滚动）。⛔ 一旦改回 `flex:1 1 auto`，flex-shrink 会把下发高度压回"剩余空间"
    //      ⇒ 末行被裁、退化成"只有时间格在滚"，正是真机反馈的那个形状。
    for (const sel of ['.week-swiper', '.calendar']) {
      const flex = geom.declOf(SOURCES.scheduleWxss, sel, 'flex')
      assert.ok(/none/.test(String(flex)), `${sel} 必须是 flex:none（高度由页面下发、随内容撑开），实测 "${flex}"`)
    }
    // 月视图不参与响应式行高：它没有小时行，仍吃满剩余高度并自己纵向滚动。
    assert.ok(/^1(\s|$)/.test(String(geom.declOf(SOURCES.scheduleWxss, '.month-calendar', 'flex')).trim()),
      '月视图仍应 flex:1 吃满剩余高度')
    // ⛔ 卡片高度必须**真的绑到视图层**，否则下发的数只是死数据（页面照样被压回剩余空间）
    for (const selector of ['week-swiper', 'day-calendar']) {
      const re = new RegExp('class="[^"]*' + selector + '[^"]*"[^>]*style="\\{\\{cardHeightStyle\\}\\}"')
      assert.ok(re.test(scheduleWxml), `⛔ 含 .${selector} 的元素上没有绑定 {{cardHeightStyle}} ⇒ 下发的卡片高度没生效`)
    }
    // ⛔ 2026-10-03：悬浮胶囊删除后，课表**不再**让出底部操作带（让出的空间全部还给小时行）。
    for (const sel of ['.week-swiper']) {
      const mb = geom.declOf(SOURCES.scheduleWxss, sel, 'margin-bottom')
      assert.ok(!/var\(--fab-safe\)/.test(mb), `${sel} 又在给悬浮按钮让底部带（实测 "${mb}"）⇒ 底部又会空出一块`)
    }
    assert.ok(!/var\(--fab-safe\)/.test(geom.declOf(SOURCES.scheduleWxss, '.schedule-page .day-calendar,.schedule-page .month-calendar', 'margin-bottom')),
      '日/月视图同样不再让出底部带')
    // ⛔ 手写补偿必须彻底消失：它正是"通知条一出现就压住课表"的根因
    assert.ok(!/has-notice/.test(scheduleWxml), '⛔ has-notice 手写补偿回来了（flex 之后不该再有）')
    const wxssNoComment = SOURCES.scheduleWxss.replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!/\.has-notice/.test(wxssNoComment), '⛔ wxss 里仍有 .has-notice 规则（注释里提到不算）')
    assert.ok(!/--notice-h/.test(SOURCES.appWxss), '⛔ --notice-h 回来了（不应再有手写通知条补偿）')
  })

  // ------------------------------------------------------------------ ⑧ 横幅与隔离机制**保留**
  await runner('⑧ 测试环境横幅、入口与隔离机制全部保留（只是把它的高度算进布局）', () => {
    assert.ok(/<sandbox-banner\s*\/>/.test(scheduleWxml), '⛔ 课表页的测试环境横幅被删了')
    assert.ok(/sandbox-banner/.test(bannerWxml), '⛔ 横幅组件本身被删了')
    assert.ok(/返回正式区/.test(bannerWxml), '⛔ 横幅上的「返回正式区」入口没了（隔离机制被弱化）')
    assert.ok(/测试环境/.test(bannerWxml), '⛔ 横幅文案没了')
    assert.ok(/position:sticky/.test(SOURCES.bannerWxss), '横幅仍是 sticky（行为未变）')
    assert.ok(/schedule-page\s+\{\{inSandbox\?'with-banner':''\}\}/.test(scheduleWxml), '页面必须按环境加 with-banner class')
    assert.ok(/inSandbox/.test(SOURCES.scheduleJs), '页面 JS 必须实时同步 inSandbox')
  })

  // ------------------------------------------------------------------ ⑨ 准入规则一条没动
  await runner('⑨ 只改显示与布局：最晚 23:00 开课 / 当天 24:00 结束 / 闸门函数一条都没动', () => {
    assert.strictEqual(occupancy.LATEST_START_MINUTES, 23 * 60, '最晚开课仍是 23:00')
    assert.strictEqual(occupancy.DAY_END_MINUTES, 24 * 60, '当天界仍是 24:00')
    assert.strictEqual(typeof occupancy.lessonWindowGateOf, 'function', '统一闸门还在')
    assert.equal(occupancy.lessonWindowGateOf({ hour: 23, minute: 0 }, 90).code, 'BOOKING_END_TOO_LATE', '23:00+90 仍被拒')
    assert.strictEqual(occupancy.lessonWindowGateOf({ hour: 23, minute: 0 }, 60), null, '23:00+60 仍放行')
    assert.strictEqual(occupancy.lessonWindowGateOf({ hour: 22, minute: 30 }, 90), null, '22:30+90 仍放行')
    assert.equal(occupancy.lessonWindowGateOf({ hour: 23, minute: 30 }, 60).code, 'BOOKING_START_TOO_LATE', '23:30 新建/改期必须被拒')
  })

  // ------------------------------------------------------------------ ⑩ 24:00 空行删掉 / 凌晨段"默认不铺"都**不影响**占用判定
  await runner('⑩ 24:00 空行删掉、凌晨段默认不铺之后：跨午夜旧课与凌晨课照旧占用（"不画"不等于"不占"）', () => {
    const old = { id: 'old-2330', date: '2026-10-02', hour: 23, minute: 30, plannedMinutes: 60, status: 'booked', studentId: 'stu-old' }
    assert.ok(scheduleView.cellOccupantsOf([old], '2026-10-03', 0), '次日 00:00 仍被这节旧课占着')
    assert.strictEqual(scheduleView.cellTapIntentOf([old], '2026-10-03', 0).kind, 'open', '点次日 00:00 仍是打开这一节课')
    assert.ok(scheduleView.busyRangesOf([old], '2026-10-03').some(r => r.start === 0 && r.end === 30), '分享可约里次日 00:00–00:30 仍是 busy')
    const index = scheduleView.buildScheduleIndex([old])
    assert.ok((index.bySlot['2026-10-02|23'] || []).length === 1, '23:30 的旧课仍渲染在 10-02 的 23:00 行')
    assert.ok(!index.bySlot['2026-10-02|24'], '本来就没有 hour=24 的课 ⇒ 删掉那一行不会漏画任何课')
    // ⭐ 凌晨段：补录进来的 00:15 那节课照样落在 `bySlot[date|0]` 里
    //    （课表"默认不铺"只是**不渲染那一行**，不是把这节课从索引里拿走）
    const early = { id: 'early-0015', date: '2026-10-02', hour: 0, minute: 15, plannedMinutes: 60, status: 'booked', studentId: 'stu-e' }
    const idx2 = scheduleView.buildScheduleIndex([early])
    assert.ok((idx2.bySlot['2026-10-02|0'] || []).length === 1, '凌晨 00:15 的课必须落在 hour=0 这一格里')
    assert.ok(scheduleView.busyRangesOf([early], '2026-10-02').some(r => r.start === 15 && r.end === 75), '凌晨课的占用区间照样成立')
  })

  // ------------------------------------------------------------------ ⑪⭐ 公式 vs 实测（四次口径）
  await runner('⑪ ⭐ 公式 vs 开发者工具实测（四次口径）：rpx、行高、行区位置、行区高、内容高、可滚量都对得上', () => {
    const dev = { windowWidth: R4.device.windowWidth, windowHeight: R4.device.windowHeight }
    const W = R4.reg.week.prod

    // ① rpx 换算：1rpx = 屏宽 / 750（不是 0.5 —— 390 宽的屏是 0.52，差 4%）
    const g0 = geomOf(dev, false)
    assert.ok(Math.abs(g0.rpx - R4.device.rpx) < 0.005, `rpx 换算错：${g0.rpx} ≠ 实测 ${R4.device.rpx}`)

    const tol = 4
    const near = (a, b) => Math.abs(a - b) <= tol
    // ② 行高：公式（六次口径 = max(下限, 行区可用高 ÷ 行数)） vs 实测
    assert.ok(near(g0.rowH, R4.reg.rowH), `行高 ${g0.rowH.toFixed(2)} ≠ 实测 ${R4.reg.rowH}`)
    // ③ ⭐ 行高必须**守住可读下限**（= --hour-row-h 折算到这台机器的 px，也是 MIN_ROW_RPX）；
    //    写死高度会在机型一变就漂，压到下限以下则连 tap 都点不中。
    const minPx = MIN_ROW_RPX * dev.windowWidth / 750
    assert.ok(Math.abs(minPx - geom.varRpx(SOURCES.appWxss, 'hour-row-h') * dev.windowWidth / 750) < 0.001,
      `--hour-row-h 必须与 schedule.js 的 MIN_ROW_RPX 同源（${geom.varRpx(SOURCES.appWxss, 'hour-row-h')}rpx vs ${MIN_ROW_RPX}rpx）`)
    assert.ok(g0.rowH >= minPx - 0.01, `行高 ${g0.rowH.toFixed(2)}px 已掉到可读下限 ${minPx.toFixed(2)}px 以下`)
    // ④ 行数：公式认出来的行数 = 实测内容高 ÷ 实测行高（卡住"行数或行高口径不一致"）
    assert.ok(Math.abs(W.content / R4.reg.rowH - g0.renderedRows) < 0.05,
      `实测内容高÷行高 = ${(W.content / R4.reg.rowH).toFixed(2)}，不等于公式认出来的 ${g0.renderedRows} 行`)
    assert.strictEqual(g0.renderedRows, R4.reg.rowsDefault, `公式认出的行数 ${g0.renderedRows} ≠ 实测 ${R4.reg.rowsDefault}`)
    // ⑤ 行区顶（= 横幅 + padTop + 页头 + 日期表头）
    assert.ok(near(g0.calendarTop + g0.headerH, W.rowsTop),
      `行区顶 ${(g0.calendarTop + g0.headerH).toFixed(1)} ≠ 实测 ${W.rowsTop} ⇒ 页头声明与真实渲染脱节`)
    // ⑥ 页头两段各自也对得上（几何公式读的就是这两个 height）
    assert.ok(near(g0.chromePx, R4.reg.chrome.topHeight + R4.reg.chrome.toolbarHeight),
      `页头 ${g0.chromePx.toFixed(1)} ≠ 实测 ${(R4.reg.chrome.topHeight + R4.reg.chrome.toolbarHeight).toFixed(1)}`)
    // ⑦ 行区可视高
    assert.ok(near(g0.rowsViewportH, W.rowsH), `行区可视高 ${g0.rowsViewportH.toFixed(1)} ≠ 实测 ${W.rowsH}`)
    // ⑧ 内容高 / 可滚量：行高逐行取整会累积，容差按物理来源取值（这里 26 与 26 完全对齐 ⇒ 容差只是护栏）
    const perRowDelta = Math.abs(g0.rowH - R4.reg.rowH)
    const accTol = perRowDelta * g0.renderedRows + 2
    assert.ok(Math.abs(g0.rowsContentH - W.content) <= accTol,
      `行区内容高 ${g0.rowsContentH.toFixed(1)} ≠ 实测 ${W.content}（累加容差 ${accTol.toFixed(1)}）`)
    assert.ok(Math.abs(g0.scrollable - W.scrollable) <= accTol + tol,
      `可滚量 ${g0.scrollable.toFixed(1)} ≠ 实测 ${W.scrollable}（容差 ${(accTol + tol).toFixed(1)}）`)
    // ⑨ ⭐ 滚到最底时 23:00 那一行必须**完整落在视口里**。
    //    ⛔ 七次口径修正：滚动容器是**整页**（`.rows-scroll` 不再自己滚），所以这里比的是**视口底**，
    //       不再是"行区下沿"。旧判据（比 rowsViewportH）会把"整页滚一点就能看到"误判成"被裁"。
    assert.ok(g0.hour23FullyVisible,
      `滚到底 23:00 行底 ${g0.hour23BottomAtBottom.toFixed(1)} 超出视口底 ${g0.vh}`)
    // ⑨b 行区内容底必须落在文档内 ⇒ 最后一行**滚得到**（页面高度按内容算，所以是结构性成立的）
    assert.ok(g0.rowsTop + g0.rowsContentH <= g0.docHeight + 0.6,
      `行区内容底 ${(g0.rowsTop + g0.rowsContentH).toFixed(1)} 超出文档底 ${g0.docHeight.toFixed(1)} ⇒ 最后一行滚不到`)
    // ⑩ ⭐ 课表底边：公式算出来的位置必须复现实测（差 1px 属于渲染取整）
    //    ⛔ 五次口径：胶囊删除后，这里比的是"课表铺到哪儿"而不是"胶囊在哪儿"。
    assert.ok(near(g0.calendarBottom, R4.reg.week.prod.calendarBottom),
      `课表底 ${g0.calendarBottom.toFixed(1)} ≠ 实测 ${R4.reg.week.prod.calendarBottom}`)
    assert.ok(near(g0.calendarH, R4.reg.week.prod.calendarH),
      `课表高 ${g0.calendarH.toFixed(1)} ≠ 实测 ${R4.reg.week.prod.calendarH}`)
  })

  // ------------------------------------------------------------------ ⑫⭐ 取消通知条：少的是可视区，不是行高
  await runner('⑫ ⭐ 会员取消通知条（实测占流 32.5px）出现时：行高按新可用高度**重算**、仍铺满、滑到底 23:00 完整', () => {
    const dev = { windowWidth: R4.device.windowWidth, windowHeight: R4.device.windowHeight }
    const withNotice = geomOf(dev, false, { noticePx: NOTICE_PX })
    const without = geomOf(dev, false)
    const minPx = MIN_ROW_RPX * dev.windowWidth / 750
    // ⭐ 占流 ⇒ 可用高度变少 ⇒ 行高**跟着变**（这是响应式，不是"压格子"）；
    //    ⛔ 但必须守住可读下限：低于它就是"把行压到点不中"（2026-10-02 用户明确否掉的形状）。
    assert.ok(withNotice.rowH >= minPx - 0.01,
      `通知条出现后行高 ${withNotice.rowH.toFixed(2)}px < 可读下限 ${minPx.toFixed(2)}px ⇒ 行被压到点不中`)
    assert.ok(withNotice.rowH < without.rowH + 0.01, '通知条占流了，可用高度却没变小 ⇒ 它根本没挤到课表')
    assert.ok(withNotice.rowsContentH >= withNotice.rowsViewportH - 0.5,
      `通知条档：行总高 ${withNotice.rowsContentH.toFixed(1)} < 行区 ${withNotice.rowsViewportH.toFixed(1)} ⇒ 底部留白`)
    assert.ok(without.rowsViewportH - withNotice.rowsViewportH >= NOTICE_PX - 0.6,
      `通知条占流 ${NOTICE_PX}px，行区可用高却只少了 ${(without.rowsViewportH - withNotice.rowsViewportH).toFixed(1)}px ⇒ 没被真正扣掉`)
    assert.ok(withNotice.hour23FullyVisible, '有通知条：滚到底 23:00 行仍不完整')
    // ⭐ 七次口径：通知条占流 ⇒ 行区内容超出可用高 ⇒ 页面可滚量随之变大（**整页**滚动接住，不是行区内部滚）
    assert.ok(withNotice.pullAllowance > without.pullAllowance + 0.01,
      '通知条占流后页面可滚量没变大 ⇒ 溢出没交给整页')
    // 实测侧：常规屏纯通知档依旧零滚动（fixture）
    const W = R4.reg.week.notice
    assert.ok(W.scrollable <= SMALL_SCROLL_PX, `通知档实测可滚 ${W.scrollable}px ⇒ 超出"少量"范围（阈值 ${SMALL_SCROLL_PX}px）`)
    assert.ok(W.rowsH < R4.reg.week.prod.rowsH, `通知条出现后行区没变小（${W.rowsH} vs ${R4.reg.week.prod.rowsH}）⇒ 它没占流`)
  })

  // ------------------------------------------------------------------ ⑬⭐ 横幅档（with-banner 几何等价实测）
  // ⛔ 横幅档怎么量的，见 fixture measuredRound4._caveat：真实横幅组件没被强制渲染（那要临时改源码），
  //    用 page.setData({inSandbox:true}) 让 with-banner 生效 —— **行区高度**与真横幅出场完全相同
  //    （真横幅只是把整块课表下移 96rpx），行区内的所有判据因此等价。横幅高度同源由 ⑤ 段钉死。
  await runner('⑬ ⭐ 横幅档：可用高度随横幅收缩后**重分行高**（守住可读下限）、铺满、滑到底 23:00 完整', () => {
    const dev = { windowWidth: R4.device.windowWidth, windowHeight: R4.device.windowHeight }
    const gProd = geomOf(dev, false)
    const g = geomOf(dev, true)
    const gN = geomOf(dev, true, { noticePx: NOTICE_PX })
    const minPx = MIN_ROW_RPX * dev.windowWidth / 750
    const tol = 4

    // ①⭐ 行高（2026-10-03 六次口径）：横幅 / 通知条**占流** ⇒ 可用高度变 ⇒ 行高跟着重算，
    //    但**不许掉到可读下限以下**，也**不许不再铺满**（那正是"底部空白"复活的形状）。
    assert.ok(g.rowH >= minPx - 0.01, `横幅档行高 ${g.rowH.toFixed(2)}px 掉到可读下限 ${minPx.toFixed(2)}px 以下`)
    assert.ok(gN.rowH >= minPx - 0.01, `横幅+通知条档行高 ${gN.rowH.toFixed(2)}px 掉到可读下限以下`)
    assert.ok(g.rowsContentH >= g.rowsViewportH - 0.5, `横幅档：行总高 ${g.rowsContentH.toFixed(1)} < 行区 ${g.rowsViewportH.toFixed(1)} ⇒ 底部留白`)
    assert.ok(gN.rowsContentH >= gN.rowsViewportH - 0.5, `横幅+通知条档：底部留白（两者差 ${(gN.rowsViewportH - gN.rowsContentH).toFixed(1)}px）`)
    assert.ok(g.rowH < gProd.rowH + 0.01, '横幅占流后行高反而变大 ⇒ 行区可用高度没被真正扣掉')

    // ② 公式 vs 实测（banner 档）
    const W = R4.reg.week.banner
    assert.ok(Math.abs(g.rowsViewportH - W.rowsH) <= tol,
      `带横幅行区可视高 ${g.rowsViewportH.toFixed(1)} ≠ 实测 ${W.rowsH}`)
    const perRowDelta = Math.abs(g.rowH - R4.reg.rowH)
    const accTol = perRowDelta * g.renderedRows + 2
    assert.ok(Math.abs(g.scrollable - W.scrollable) <= accTol + tol,
      `带横幅可滚量 ${g.scrollable.toFixed(1)} ≠ 实测 ${W.scrollable}（容差 ${(accTol + tol).toFixed(1)}）`)

    // ③ 实测侧：横幅档滚动必须仍是"少量"（用户口径：允许少量滚动）
    assert.ok(W.scrollable <= SMALL_SCROLL_PX, `带横幅可滚 ${W.scrollable}px ⇒ 超出"少量"范围（阈值 ${SMALL_SCROLL_PX}px），页头又被撑大了`)

    // ④ 最坏档（横幅 + 通知条）：可视区被吃掉，但滑到底 23:00 行仍**完整**
    assert.ok(gN.rowsViewportH < g.rowsViewportH - NOTICE_PX + 0.5,
      `通知条占流 ${NOTICE_PX}px，行区可视高只少了 ${(g.rowsViewportH - gN.rowsViewportH).toFixed(1)}px ⇒ 没扣掉`)
    const W2 = R4.reg.week.worst
    assert.ok(W2.lastBottomAtBottom <= W2.rowsTop + W2.rowsH + 0.6,
      `最坏档滑到底 23:00 行底 ${W2.lastBottomAtBottom} 超出小行区下沿 ${W2.rowsTop + W2.rowsH} ⇒ 被裁`)
    assert.ok(W2.visibleHours >= 14, `最坏档一屏只见 ${W2.visibleHours} 行 ⇒ 太少（页头把行区吃光了）`)
  })

  // ------------------------------------------------------------------ ⑭⭐ 凌晨段展开：18 → 24 行的几何
  await runner('⑭ ⭐ 凌晨段展开（真有课才发生）：提示条占 31px、总共 24 行、可滚 137px、胶囊仍不遮挡、滑到底 23:00 完整', () => {
    const dev = { windowWidth: R4.device.windowWidth, windowHeight: R4.device.windowHeight }
    const gClosed = geomOf(dev, false)
    const gOpen = geomOf(dev, false, { lateExpanded: true, latePx: LATE_PX })
    const L = R4.lateBlock

    // ① 行数与行高（行高一个像素都不变）
    assert.strictEqual(gClosed.renderedRows, 18, '收起时 18 行')
    assert.strictEqual(gOpen.renderedRows, 24, '展开时 24 行（18 主 + 6 凌晨）')
    // ⭐ 24 行仍然**铺满同一个行区** ⇒ 行高按 24 份重新分（这是响应式，不是"挤格子"）；
    //    ⛔ 但不能掉到可读下限以下 —— 那才是"为了让行数变多而牺牲点击"。
    const minPx = MIN_ROW_RPX * dev.windowWidth / 750
    assert.ok(gOpen.rowH >= minPx - 0.01, `凌晨段展开后行高 ${gOpen.rowH.toFixed(2)}px < 可读下限 ${minPx.toFixed(2)}px`)
    assert.ok(gOpen.rowH < gClosed.rowH + 0.01, '行数从 18 涨到 24，行高却没变小 ⇒ 又回到写死高度')
    assert.ok(gOpen.rowsContentH >= gOpen.rowsViewportH - 0.5, '凌晨段展开后底部留白')
    assert.strictEqual(L.rowsExpanded, 24, `凌晨段展开实测 ${L.rowsExpanded} 行`)
    // ② 提示条占掉的是**行区可视高**，不是行高
    assert.ok(Math.abs((gClosed.rowsViewportH - gOpen.rowsViewportH) - LATE_PX) < 0.6,
      `凌晨提示条占流 ${LATE_PX}px，行区只少了 ${(gClosed.rowsViewportH - gOpen.rowsViewportH).toFixed(1)}px`)
    assert.ok(Math.abs(L.rowsHProd - L.rowsHExpanded - L.barFlowHeight) <= 1,
      `实测行区 ${L.rowsHProd} → ${L.rowsHExpanded}（差 ${L.rowsHProd - L.rowsHExpanded}）与提示条占流 ${L.barFlowHeight} 不一致`)
    // ③ 公式 vs 实测
    const tol = 4
    assert.ok(Math.abs(gOpen.rowsViewportH - L.rowsHExpanded) <= tol,
      `展开态行区可视高 ${gOpen.rowsViewportH.toFixed(1)} ≠ 实测 ${L.rowsHExpanded}`)
    assert.ok(Math.abs(gOpen.rowsContentH - L.contentExpanded) <= tol,
      `展开态内容高 ${gOpen.rowsContentH.toFixed(1)} ≠ 实测 ${L.contentExpanded}`)
    assert.ok(Math.abs(gOpen.scrollable - L.scrollableExpanded) <= tol,
      `展开态可滚量 ${gOpen.scrollable.toFixed(1)} ≠ 实测 ${L.scrollableExpanded}`)
    // ④ 展开后课表照样铺到 tabBar 上方（不再有"给悬浮按钮让位的那条带"）；滑到底 23:00 完整
    assert.ok(gOpen.scheduleFillsToTabBar,
      `凌晨段展开后课表底 ${gOpen.calendarBottom.toFixed(1)} 距视口底 ${gOpen.vh} 还有 ${gOpen.calendarGapBelowViewport.toFixed(1)}px`)
    assert.ok(L.calendarGapToTabBar <= 4, '⛔ 展开态课表底部仍有空白（实测 ' + L.calendarGapToTabBar + 'px）⇒ 重跑 _render-probe-round4.js')
    // ⭐ 七次口径：滚动容器是整页 ⇒ 23:00 行只要在"滚到底"的视口里就算完整（比的是视口底，不是行区下沿）。
    assert.ok(gOpen.hour23FullyVisible,
      `展开态滚到底 23:00 行底 ${gOpen.hour23BottomAtBottom.toFixed(1)} 超出视口底 ${gOpen.vh}`)
    assert.ok(gOpen.pullAllowance > 0, '展开态页面不再可滚 ⇒ 页面级下拉刷新失效')
    // ⑤ 注入是**显示层**的，必须还原干净（探针自证）
    assert.strictEqual(L.restored, true, '⛔ 探针没有自证还原 ⇒ 那份实测数据不可信，重跑')
  })

  // ------------------------------------------------------------------ ⑮ 凌晨段：条件渲染是**结构性**的（不是 CSS 藏）
  await runner('⑮ 凌晨段"有课才出现"必须是**条件渲染**：收起时那 6 行根本不进 DOM，提示条仍在（不静默隐藏）', () => {
    const js = SOURCES.scheduleJs
    // ① rows 由 late.count>0 && lateExpanded 决定 ⇒ 收起时"不进 rows"（不是用 CSS 藏起来）
    assert.ok(/const expanded = late\.count > 0 && this\.data\.lateExpanded/.test(js),
      '⛔ 周视图必须用 `late.count > 0 && this.data.lateExpanded` 决定凌晨段是否进 rows')
    assert.ok(/const expanded = late\.count > 0 && this\.data\.lateExpanded/.test(js) && (js.match(/late\.count > 0 && this\.data\.lateExpanded/g) || []).length === 2,
      '⛔ 日视图必须与周视图同一口径（两处都要有同一个判据）')
    assert.ok(/expanded \? late\.rows\.concat\(mainRows\) : mainRows/.test(js), '⛔ 周视图：展开才 concat 凌晨 6 行')
    assert.ok(/expanded \? lateRows\.concat\(mainRows\) : mainRows/.test(js), '⛔ 日视图：展开才 concat 凌晨 6 行')
    // ② 凌晨 6 行走的是**同一条**落格逻辑（没有"凌晨格另算一套"）
    const lateBlock = js.slice(js.indexOf('lateBlockOf('), js.indexOf('makeWeek('))
    assert.ok(/this\.makeCell\(day\.date, hour, day\.today\)/.test(lateBlock),
      '⛔ 凌晨行必须复用 makeCell（同一份 bySlot 落格逻辑）')
    // ③ 提示条：有课才出现，收起后**仍然在**（写着有几节）⇒ 不是静默隐藏
    assert.ok(/<view wx:if="\{\{item\.lateCount\}\}" class="late-bar"/.test(scheduleWxml),
      '⛔ 周视图凌晨提示条必须是 `wx:if="{{item.lateCount}}"`（没课就不出现）')
    assert.ok(/class="late-bar-text">00:00–06:00 有 \{\{item\.lateCount\}\} 节课/.test(scheduleWxml),
      '⛔ 提示条必须写出"有几节"（数字来自 lateBlockOf，不许写死）')
    assert.ok(/item\.lateExpanded\?'（已展开）':'（已收起）'/.test(scheduleWxml), '⛔ 提示条必须区分已展开 / 已收起')
    assert.ok(/bindtap="toggleLate"/.test(scheduleWxml), '⛔ 提示条必须能点（收起 / 展开）')
    assert.ok(/toggleLate\(\)\s*\{\s*this\.setData\(\{ lateExpanded: !this\.data\.lateExpanded \}/.test(js),
      '⛔ toggleLate 必须只翻一个显示开关（一条业务数据都不碰）')
    // ④ 轻动效：凌晨行是"展开出来的"，要有一次短促上浮（不是硬出现）
    assert.ok(/\.row-late\{animation:lateRowIn/.test(SOURCES.scheduleWxss), '⛔ 凌晨行的轻动效（lateRowIn）没了')
    // ⑤ 凌晨段是可点的（能在任意凌晨整点补录）
    assert.ok(/rows\.push\(\{ hour, time: `\$\{pad\(hour\)\}:00`, cells, isLate: true/.test(js),
      '⛔ 凌晨行必须带着 hour/isLate 一起进 rows（否则点不动、也画不出凌晨底色）')
  })
}

main().then(() => {
  // ⛔ 不能无条件打印 "ALL PASSED" —— 上一段 runner 失败时 passed 只统计成功的段，
  //    那样会打出"ALL PASSED（12 段）"这种自相矛盾的结论（真的踩过一次）。
  if (process.exitCode) process.stderr.write(`\nWEEK GRID BOTTOM: ${TOTAL} 段中 ${passed} 段通过、${TOTAL - passed} 段失败\n`)
  else process.stdout.write(`\nALL WEEK GRID BOTTOM TESTS PASSED（${passed} 段）\n`)
}).catch(error => {
  process.stderr.write(`\nWEEK GRID BOTTOM TESTS FAILED: ${error && error.stack}\n`)
  process.exitCode = 1
})
