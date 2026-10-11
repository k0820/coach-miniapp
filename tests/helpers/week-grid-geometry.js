// 周课表**底部几何**的本地复现（纯函数：只读文本 + 算坐标，不启动小程序、不碰业务数据）
//
// ⛔ 口径演进（读之前先看这条，别把旧结论抄回来）：
//   · 第一版：把 24 行挤进剩下的高度（flex:1 均分）⇒ 行高被压到 12~16px，横幅/通知条一出现更矮。
//   · 二次口径：行高**固定** 96rpx + 课表内部滚动 + 底部操作带 --fab-safe:140rpx。
//   · 三次口径：行高 44rpx + 「＋」进**页头工具条** + --fab-safe:0 + 24 行一屏全见。
//   · ⭐ 四次口径（2026-10-02 真机 UI 整理）—— ⛔ 已被六次口径取代，仅留作历史对照：
//       · 主网格默认 **06:00–23:00 共 18 行**（HOURS 从 6 起）；行高回到 **50rpx**（26px，格子能看清字）；
//       · 凌晨 **00:00–05:59 共 6 行**（LATE_HOURS）**真有课才渲染**：有就整段 6 行一起出来并自动展开，
//         没有就一行都不占。⛔ 这不是"删内容" —— 补录通道只判最晚 23:00、不判最早，
//         00:00–05:59 的课照样有格子装它（见 OVERNIGHT-CHECK-20261002.md）；
//       · 「＋」回到右下角、tabBar 上方，做成带文字的胶囊 `.fab-capsule`
//         ⇒ `--fab-safe` 由 0 恢复到 **104rpx**，课表**主动让出**这条带，胶囊永不压行 / 卡片 / 末行。
//   · ⭐ 五次口径（2026-10-03）：胶囊删除 ⇒ `--fab-safe` 归 0，课表一路铺到 tabBar 上方。
//   · ⭐⭐ 七次口径（2026-10-03 · 1.3.11 真机）—— **本文件现在算的就是它**：
//       · 刷新容器只剩**页面级**一个：`.rows-scroll` 不再是 `scroll-view`、不再带 refresher
//         ⇒ 下拉时页头与时间网格**一起**下移（六次口径下只有网格下移、还挤出一大块三点空白）；
//       · 行区**不再内部滚动**（`.rows-scroll{flex:none}`）⇒ 空间不足时是**整页**轻微滚动；
//       · 行高来源改成「**视口底 − 行区顶**」÷ 行数（六次口径量的是 `.rows-scroll` 容器高度，
//         而那个高度一旦不再由 flex 分配，就会变成"自己量自己"⇒ 自锁）；
//       · 页面由 `height` 改 `min-height`：高度随内容增长（卡片被内容撑高）⇒ 溢出一律由整页接住。
//   · ⭐⭐ 六次口径（2026-10-03 · 1.3.10 真机 Bug）—— 已被七次口径取代，仅留作历史对照：
//       · 行高**不再恒定**，改为「行区可用高度 ÷ 当前渲染行数」（页面实测下发，见 schedule.js 的
//         `syncRowHeight` / `measureRowHeight`），只守住下限 `--hour-row-h`（= `MIN_ROW_RPX`）。
//       · ⛔ 作废的旧结论（别再抄回来）："横幅 / 通知条 / 凌晨提示条出现时，少的是**可见行数**，
//         行高一个像素都不变"。六次口径下这三档都会**按收缩后的可用高度重分**行高；
//         空间不足（小屏 + 横幅 + 通知条）时退回下限并轻微滚动，滑到底 23:00 行必须完整。
//       · ⇒ "屏幕越大、行越高、底部不留空白"，这才是 1.3.10 那个大块空白的修法。
//
// 模型（每条都写明，便于复核）：
//   · 100vh == 页面可视高度（wx.getSystemInfoSync().windowHeight，不含导航栏 / tabBar）
//   · rpx：750rpx == 屏幕宽度 ⇒ 1rpx = windowWidth / 750（px）
//   · ⛔ 实测教训：横幅 `position:sticky` **照旧占流**，文档总高 = 横幅高 + 页面高。
//     旧版这里写"sticky 不贡献滚动距离"是**错的**，别再把那个结论抄回来。
//   · 百分比 height 取父元素 **content-box**（box-sizing:border-box 时先扣 padding）
//   · ⛔ 凌晨提示条 / 取消通知条的**占流高度不从这里推**：它们由内容 + 字号决定，
//     从 wxss 再推一遍就成了"公式自证"。两者都取**实测值**（fixture 里的 lateBlock.barFlowHeight
//     与 noticeFlowHeight），公式要复现的是"它们占掉多少行区"，不是"它们自己多高"。
//
// ⛔ 判别力：本文件所有函数都**接受文本参数** ⇒ 反证只需传入"改坏的文本副本"，
//    不需要动生产源码一个字节（AGENTS.md 第 5 条：禁止改生产源码做变异）。
//    反证见 tests/_week-grid-bottom-mutate.js。

const numOf = text => { const m = String(text || '').match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : 0 }
const rpxList = text => (String(text || '').match(/-?\d+(?:\.\d+)?rpx/g) || []).map(v => parseFloat(v))

// 取某个选择器里某个属性的声明值（与 tests/m2-ui-02-narrow-layout 同思路：按选择器精确定位）。
function declOf(css, selector, prop) {
  for (const block of String(css || '').split('}')) {
    const at = block.lastIndexOf(selector + '{')
    if (at < 0) continue
    const body = block.slice(at + selector.length + 1)
    const m = body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)'))
    if (m) return m[1].trim()
  }
  return ''
}

// CSS 变量（写在 app.wxss 的 page{} 上，页面/组件共用同一个数）。
function varRpx(appWxss, name) {
  const m = String(appWxss || '').match(new RegExp('--' + name + ':\\s*(\\d+(?:\\.\\d+)?)rpx'))
  return m ? parseFloat(m[1]) : 0
}

// 把 `calc(100vh + 40rpx - var(--sandbox-banner-h))` 这类表达式里的变量替换成真值后取数字序列。
function resolvedRpx(expr, appWxss) {
  const text = String(expr || '').replace(/var\(--([a-z0-9-]+)\)/g, (m, n) => varRpx(appWxss, n) + 'rpx')
  return rpxList(text)
}

// 带符号的版本：`calc(100vh + 40rpx - 96rpx)` ⇒ [+40, -96]（区分"加"和"减"，否则补偿量会被当成加高）。
function signedRpx(expr, appWxss) {
  const text = resolvedRpx(expr, appWxss).length ? String(expr || '') : ''
  const src = String(expr || '').replace(/var\(--([a-z0-9-]+)\)/g, (m, n) => varRpx(appWxss, n) + 'rpx')
  const out = []
  const re = /([+-]?)\s*(\d+(?:\.\d+)?)\s*rpx/g
  let m
  while ((m = re.exec(src))) out.push((m[1] === '-' ? -1 : 1) * parseFloat(m[2]))
  return out
}

// ⭐ 课表铺的到底是哪几个小时：主网格（HOURS）+ 凌晨段（LATE_HOURS）。
//   ⛔ 从源码里读，不硬编码：把 HOURS 改成 20 行、或把 LATE_HOURS 删掉，这里立刻跟着变 ⇒ 判据会红。
function hoursOf(scheduleJs) {
  const text = String(scheduleJs || '')
  const main = text.match(/HOURS\s*=\s*Array\.from\(\{\s*length:\s*(\d+)\s*\}\s*,\s*\([^)]*\)\s*=>\s*\w+\s*\+\s*(\d+)/)
  const late = text.match(/LATE_HOURS\s*=\s*Array\.from\(\{\s*length:\s*(\d+)\s*\}\s*,\s*\([^)]*\)\s*=>\s*(\w+)/)
  return {
    mainCount: main ? Number(main[1]) : 0,
    mainStart: main ? Number(main[2]) : 0,
    lateCount: late ? Number(late[1]) : 0,
    // 凌晨段的下标表达式必须是「索引本身」(`(_,i)=>i`) ⇒ 起点 0；
    // 写成别的（`i+1` 之类）取不到 0，返回 -1 ⇒ "00:00 没有格子"会被判据抓住。
    lateStart: late ? (/^i$/.test(late[2]) ? 0 : -1) : 0
  }
}

// 主网格行数（旧调用点仍在用；含义 = HOURS.length）。
function hourCountOf(scheduleJs) { return hoursOf(scheduleJs).mainCount }

// 横幅高度（rpx）：显式 height 优先；否则按 padding + 内容 + border 估算。
function bannerHeightRpx(bannerWxss) {
  const explicit = declOf(bannerWxss, '.sandbox-banner', 'height')
  if (explicit) return numOf(explicit)
  const padding = numOf(declOf(bannerWxss, '.sandbox-banner', 'padding')) * 2
  const button = numOf(declOf(bannerWxss, '.sandbox-banner button', 'height'))
  return padding + Math.max(button, 28 * 1.2 + 21 * 1.2) + 2
}

/**
 * 算一次布局（⭐⭐ 七次口径：整页是唯一的刷新容器与滚动容器；
 * 行高 = 「视口底 − 行区顶」÷ 行数；空间不足 ⇒ 卡片被内容撑高 ⇒ **整页**轻微滚动）。
 * @param {object} sources { scheduleWxss, bannerWxss, appWxss, scheduleJs }（都是**文本**）
 * @param {object} device  { windowWidth, windowHeight }（px，模拟真机可视区）
 * @param {boolean} withBanner 是否处于测试环境（横幅占位）
 * @param {object} options { noticePx, latePx, lateExpanded, hintPx }
 *                 noticePx 取消通知条**实测**占流（px）；latePx 凌晨提示条**实测**占流（px）；
 *                 lateExpanded 凌晨段是否展开（true 时那 6 行进 DOM ⇒ 行数 = 18 + 6）；
 *                 hintPx 下拉刷新的紧凑提示条**占流**（px，展开时；收起时 0）。
 */
function geometryOf(sources, device, withBanner, options) {
  const { scheduleWxss, bannerWxss, appWxss, scheduleJs } = sources
  const o = options || {}
  const noticePx = o.noticePx || 0
  const latePx = o.latePx || 0
  const lateExpanded = !!o.lateExpanded
  const hintPx = o.hintPx || 0
  const rpx = device.windowWidth / 750
  const vh = device.windowHeight
  const R = v => v * rpx

//   · ⭐⭐ 七次口径（2026-10-03 · 1.3.11 真机：下拉刷新只有时间网格下移 + 一大块三点空白）：
//       · 刷新容器只剩**页面级**一个（`.rows-scroll` 不再是 scroll-view、不再带 refresher）；
//       · 行区**不再内部滚动**（`.rows-scroll{flex:none}`）⇒ 行区高度 = 行数 × 行高，由内容撑开；
//       · 行高的来源换成「**视口底 − 行区顶**」：
//           ⛔ 六次口径量的是 `.rows-scroll` 的**容器高度**，而那个高度由 flex 分配；
//              行区一旦不再吃 flex 剩余高度，容器高就等于"上一帧自己发下去的行高之和"
//              ⇒ 自己量自己（自锁）。⇒ 必须改成只量**位置**（行区顶），与行高无循环依赖。
//       · 卡片高（`.week-swiper` / `.day-calendar`）由同一个量测反推后下发：
//           卡片高 = （行区顶 − 卡片顶）+ 行数 × 行高 ⇒ 空间不足时卡片被撑高 ⇒ **整页**滚动。
//       · ⇒ `rowsContentH` 在"够用"时**恰好等于** `rowsViewportH`（铺满 ⇒ 零溢出）。
// ---- 行数先算：行高是"可用高度 ÷ 行数"得出来的（次序反过来就会自证）。
const hours = hoursOf(scheduleJs)
const renderedRows = hours.mainCount + (lateExpanded ? hours.lateCount : 0)

// ---- 小时行：**响应式**高度（下限 = 兜底 `var(--hour-row-h)`）
//   ⛔ 旧口径（"恒定 50rpx，与机型/横幅/通知条无关"）已于 2026-10-03 作废 ——
//      那正是"屏幕越大空白越多"的根因。现在的性质是：**铺满行区**，不够时才退回下限并整页滚动。
const minRowH = R(varRpx(appWxss, 'hour-row-h'))
const rowHFallback = minRowH
  // ⛔ 底部操作带必须**从课表真实声明的 margin-bottom 读**，不能直接拿 `--fab-safe` 当结果：
  //    否则"把 margin-bottom 删掉"这种变异骗得过公式（公式自证），真机却照样被胶囊压住。
  const fabSafe = R(resolvedRpx(declOf(scheduleWxss, '.week-swiper', 'margin-bottom'), appWxss)
    .reduce((a, b) => a + Math.abs(b), 0))
  const bannerPx = withBanner ? R(bannerHeightRpx(bannerWxss)) : 0

  // ---- 页面：min-height:calc(100vh + 40rpx [ - 横幅 ])，box-sizing:border-box
  //   ⛔ 七次口径起是 `min-height` 而不是 `height`：页面**高度由内容决定**（卡片撑开就变高），
  //      min-height 只负责保证"至少比视口多 40rpx"⇒ 原生下拉刷新仍然会被触发。
  const pageExpr = withBanner
    ? (declOf(scheduleWxss, '.schedule-page.with-banner', 'min-height') || declOf(scheduleWxss, '.schedule-page', 'min-height'))
    : declOf(scheduleWxss, '.schedule-page', 'min-height')
  const pageExtra = signedRpx(pageExpr, appWxss).reduce((a, b) => a + b, 0)
  const pageMinH = vh + R(pageExtra)

  const pad = resolvedRpx(declOf(scheduleWxss, '.schedule-page', 'padding'), appWxss)
  const padTop = R(pad[0] || 0), padBottom = R(pad.length > 2 ? pad[2] : (pad[0] || 0))

  // ---- 页头（flex 项，各占各的）：标题 + 视图切换 +（刷新提示条）+（取消通知条）
  // ⛔ 通知条只有在**流内**才占高度；一旦被改成 absolute/fixed，它就不再从课表高度里扣，
  //    而是改去**盖住**课表顶部 —— 所以模型必须读它的 position，不能无条件加。
  const noticePos = declOf(scheduleWxss, '.cancel-notice', 'position')
  const noticeInFlow = !/absolute|fixed/.test(noticePos)
  const chromePx = R(numOf(declOf(scheduleWxss, '.top', 'height')))
    + R(numOf(declOf(scheduleWxss, '.view-toolbar', 'height')))
    + (noticeInFlow ? noticePx : 0)
    + hintPx

  // ---- 课表卡片：高度 = （表头 + 凌晨提示条）+ 行区内容高（由页面实测下发 `height:NNpx`）
  const headerH = R(numOf(declOf(scheduleWxss, '.header', 'height')))
  const lateBarH = lateExpanded ? latePx : 0
  const contentTop = bannerPx + padTop
  const calendarTop = contentTop + chromePx
  const rowsTop = calendarTop + headerH + lateBarH
  // ⭐ 行区可用高度 = **视口底 − 行区顶**（不是"容器分给我多少"）⇒ 与行高无循环依赖。
  const rowsViewportH = Math.max(0, vh - rowsTop)
  // ⭐ 严格等高：`rowH` 是"可用高度 ÷ 行数"的实数（不取整、不给末行补差）⇒ 18 行总高 == 行区可用高度。
  const rowH = rowsViewportH > 0 ? Math.max(minRowH, rowsViewportH / renderedRows) : rowHFallback
  const rowsContentH = renderedRows * rowH
  // ⛔ 溢出量 = 行区内容高 − 可用高。七次口径下它**由整页滚动承担**（不是行区内部滚动），
  //    滚到底必看得到，因为页面高度就是按内容算的（见下面 pageContentH）。
  const scrollable = Math.max(0, rowsContentH - rowsViewportH)
  const calendarH = (rowsTop - calendarTop) + rowsContentH
  const calendarBottom = calendarTop + calendarH

  const lastIndex = Math.max(renderedRows - 1, 0)
  // 23:00 在**铺出来的行**里的下标：凌晨段展开时那 6 行在最上面，整体后移 6。
  const hour23Index = (lateExpanded ? hours.lateCount : 0) + (23 - hours.mainStart)

  // ---- 右下「＋ 新建课程」胶囊：fixed 定位，坐标相对**视口**
  const capsuleH = R(numOf(declOf(appWxss, '.fab-capsule', 'height')))
  const capsuleGap = R(numOf(declOf(appWxss, '.fab-capsule', 'bottom')))
  const capsuleTop = vh - capsuleGap - capsuleH
  const capsuleBottom = capsuleTop + capsuleH
  // ⭐ 判据：胶囊**整块在卡片下沿之下**（七次口径下卡片会随内容增长，所以这里依旧是"下方"）
  const capsuleClearance = capsuleTop - calendarBottom

  // ---- 旧的悬浮球（其它页面仍在用，这里保留以便复用同一份几何）
  const fabBorder = numOf(declOf(appWxss, '.fab', 'border'))
  const fabSize = R(numOf(declOf(appWxss, '.fab', 'height')) + fabBorder * 2)
  const fabBottom = R(numOf(declOf(scheduleWxss, '.fab', 'bottom')) || numOf(declOf(appWxss, '.fab', 'bottom')))
  const fabTop = vh - fabBottom - fabSize

  // ---- 页面高度 = **内容高**（卡片撑开就变高）与 min-height 取大者
  const pageContentH = rowsTop + rowsContentH + padBottom + fabSafe
  const pageH = Math.max(pageMinH, pageContentH)
  // 横幅在 `.schedule-page` 之外 ⇒ 文档高 = 横幅 + 页面
  const docHeight = bannerPx + pageH
  const pullAllowance = docHeight - vh

  // ---- ⭐ 五次口径（2026-10-03）：右下悬浮胶囊删除后，课表**不再让出**底部那条带
  //      ⇒ 课表底必须**贴着视口底**（tabBar 上沿）。允许差 = 课表自己那条 1rpx 边框 ×2（≤ 2rpx）。
  //      七次口径下"铺满"的含义扩了一档：**触底时卡片会略高于视口底**（那是整页滚动要接住的量），
  //      同样算"铺满"——判据仍是"不许在视口底之上留出空隙"。
  const calendarGapBelowViewport = vh - calendarBottom
  const scheduleFillsToTabBar = calendarGapBelowViewport <= 2 * rpx + 0.5

  // ---- 滚到最底时，23:00 行在**视口坐标**里的位置（整页滚动：视口顶落在 docHeight − vh 处）。
  //      ⛔ 判据"23:00 完整" = 行底 ≤ 视口底（滚到底之后）。
  const scrolledToBottom = pullAllowance
  const hour23TopAtBottom = rowsTop + hour23Index * rowH - scrolledToBottom
  const hour23BottomAtBottom = hour23TopAtBottom + rowH
  const hour23FullyVisible = hour23BottomAtBottom <= vh + 0.5

  return {
    calendarGapBelowViewport, scheduleFillsToTabBar,
    rpx, vh, hours: hours.mainCount, hoursOf: hours, renderedRows, rowH,
    chromePx, noticePx, latePx, lateExpanded, lateBarH, hintPx,
    pageH, pageMinH, pageContentH, padTop, padBottom, contentH: pageH - padTop - padBottom, contentTop,
    calendarTop, calendarH, calendarBottom,
    headerH, rowsTop, rowsViewportH, rowsContentH, scrollable,
    bannerPx, fabSafe, fabTop, fabBottom, fabSize, lastIndex, hour23Index,
    capsuleH, capsuleGap, capsuleTop, capsuleBottom, capsuleClearance,
    capsuleClearsRows: capsuleClearance >= -0.5,
    docHeight, pullAllowance,
    hour23TopAtBottom, hour23BottomAtBottom, hour23FullyVisible,
  }
}

// 23:30 的跨午夜旧课画在 23:00 行的哪一段（与 schedule.js decorateBooking 同一算法）？
//   top = minute/60·100%，height = (min(开始+时长, 24:00) − 开始)/60·100%
function blockBandOf(startHour, startMinute, plannedMinutes) {
  const start = startHour * 60 + startMinute
  const clippedEnd = Math.min(start + plannedMinutes, 24 * 60)
  return { top: startMinute / 60 * 100, height: (clippedEnd - start) / 60 * 100 }
}

module.exports = { declOf, rpxList, resolvedRpx, signedRpx, hoursOf, hourCountOf, bannerHeightRpx, geometryOf, blockBandOf, numOf, varRpx }
