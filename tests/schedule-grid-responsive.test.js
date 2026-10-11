// ═══ 课表**响应式小时行高**（2026-10-03 六次口径）══════════════════════════════════════
//
// 起因（1.3.10 真机 Bug）：删掉右下「＋ 新建课程」胶囊后，课表底部露出一大块空白。
//   ⛔ 根因不是"胶囊删错了"，而是**行高压根不会跟着屏幕变**：
//      `.row-grid{height:50rpx}` 写死 ⇒ 18 行恒定 900rpx（@375 宽 = 450px），
//      而行区可用高度是 flex 随机型分出来的（6/7/8 约 459px、12/13 Pro 约 557px、
//      14 Pro Max 更高）⇒ **屏幕越大、空白越多**。胶囊在时那 104rpx 安全带刚好把空白吃掉，
//      胶囊一删就露馅。
//
// ⭐ 现行口径（本文件逐条钉死）：
//   1. 行高 = **实测行区可用高度 ÷ 当前渲染行数**，由页面下发到每一行（`rowHeightStyle`）；
//   2. `--hour-row-h`（= schedule.js 的 MIN_ROW_RPX）降级为**最小可读行高**：
//      空间不够才用它顶住并**轻微滚动**，绝不把行压到点不中；
//   3. 03:00…23:00 严格等高（不取整、不给末行补差 ⇒ 累计误差 < 1px）；
//   4. 课程卡片 / 半小时片段用**百分比**（slotStyle）⇒ 自动跟随实际行高，不存在第二套数字；
//   5. 布局一变就重算：切视图 / 切周 / 凌晨展开 / 横幅 / 取消通知条 / 窗口尺寸。
//
// ⛔ 本文件**只读**：不写业务数据、不碰 Production / Sandbox、不改任何业务规则。
// ⛔ 反证见 tests/_schedule-grid-responsive-mutate.js（只改**内存文本副本**，不动生产源码）。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const geom = require('./helpers/week-grid-geometry')

const ROOT = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const SOURCES = {
  scheduleWxss: read('pages/schedule/schedule.wxss'),
  bannerWxss: read('components/sandbox-banner/sandbox-banner.wxss'),
  appWxss: read('app.wxss'),
  scheduleJs: read('pages/schedule/schedule.js')
}
const WXML = read('pages/schedule/schedule.wxml')
// 剥注释后再匹配：商品空隙 ——
const jsNoComment = SOURCES.scheduleJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const wxssNoComment = SOURCES.scheduleWxss.replace(/\/\*[\s\S]*?\*\//g, '')
const wxmlNoComment = WXML.replace(/<!--[\s\S]*?-->/g, '')

const geomOf = (device, withBanner, options) => geom.geometryOf(SOURCES, device, withBanner, options)

// ⛔ 三种必须各算一遍：**最矮**（小屏要滚动）、**常规**、**最大**（空白最显眼）。
//    windowHeight = 屏幕高 − 导航栏 − tabBar，与 fixture measuredRound4 同源。
const DEVICES = [
  { name: 'iPhone 6/7/8 · 375×555', windowWidth: 375, windowHeight: 555 },
  { name: 'iPhone 12/13 Pro · 390×671', windowWidth: 390, windowHeight: 671 },
  { name: 'iPhone 14 Pro Max · 430×760', windowWidth: 430, windowHeight: 760 }
]
// 取消通知条 / 凌晨提示条的占流高度取**实测**（tests/fixtures/week-grid-rendered.json），
// 不从 wxss 再推一遍（那样是公式自证）。
const FX = JSON.parse(read('tests/fixtures/week-grid-rendered.json'))
const NOTICE_PX = FX.measuredRound4.noticeFlowHeight
const LATE_PX = FX.measuredRound4.lateBlock.barFlowHeight

const MIN_ROW_RPX = (() => {
  const m = SOURCES.scheduleJs.match(/MIN_ROW_RPX\s*=\s*(\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : 0
})()

let passed = 0
let TOTAL = 0
async function runner(title, fn) {
  TOTAL++
  try { await fn(); passed++; process.stdout.write(`  ✓ ${title}\n`) }
  catch (error) { process.stderr.write(`  ✗ ${title}\n${error && error.stack}\n`); process.exitCode = 1 }
}

async function main() {
  // ─────────────────────────────────────────────── ① 单点的"行高下限"必须两侧同源
  await runner('① 最小可读行高只有一处定义：schedule.js 的 MIN_ROW_RPX == app.wxss 的 --hour-row-h', () => {
    assert.ok(MIN_ROW_RPX > 0, '⛔ schedule.js 里读不到 MIN_ROW_RPX（脚本锚点失效 ⇒ 反证无效）')
    const css = geom.varRpx(SOURCES.appWxss, 'hour-row-h')
    assert.strictEqual(MIN_ROW_RPX, css,
      `两侧不同源：JS 的 MIN_ROW_RPX=${MIN_ROW_RPX}rpx，CSS 的 --hour-row-h=${css}rpx ⇒ 改一处会漏另一处`)
    assert.ok(MIN_ROW_RPX >= 44, `下限只剩 ${MIN_ROW_RPX}rpx ⇒ 比历史最窄的 44rpx 还窄，格子里的字会发虚`)
    // ⛔ CSS 那条必须是 var()，不许回潮成写死 px
    for (const sel of ['.row-grid', '.day-row']) {
      const h = geom.declOf(SOURCES.scheduleWxss, sel, 'height')
      assert.strictEqual(h, 'var(--hour-row-h)', `${sel} 的兜底高度必须是 var(--hour-row-h)，实测 "${h}"`)
    }
  })

  // ─────────────────────────────────────────────── ② 行高必须**测出来**，不许任何写死高度
  await runner('② 行高必须由**实测**「视口底 − 行区顶」算出来（不许写死常量、不许量容器高度、不许取整）', () => {
    // ⛔ 按**方法定义**锚定（`measureRowHeight()` 这种松散匹配会先命中调用点 ⇒ 判据形同虚设）
    const fn = jsNoComment.match(/\n  measureRowHeight\s*\(\s*\)\s*\{[\s\S]*?\n  \}/)
    assert.ok(fn, '⛔ 读不到 measureRowHeight 的定义（脚本锚点失效 ⇒ 反证无效）')
    const body = fn[0]
    // ① 必须真的去量选择器
    assert.ok(/createSelectorQuery/.test(body), 'measureRowHeight 没有真的去量 DOM')
    assert.ok(/selectAll\(\s*ROWS_VIEWPORT_SELECTOR\s*\)/.test(body), '没有量到小时行区那个选择器')
    // ⛔ 选择器值也必须有可读的单点定义，且**就是**行区容器（换个容器量出来的位置是错的）
    const sel = SOURCES.scheduleJs.match(/ROWS_VIEWPORT_SELECTOR\s*=\s*'([^']+)'/)
    assert.ok(sel, '读不到 ROWS_VIEWPORT_SELECTOR 的值（脚本锚点失效）')
    assert.strictEqual(sel[1], '.rows-scroll', `量的是 ${sel[1]}，不是行区容器 .rows-scroll`)
    // ⛔ 必须**挂在行区选择器上**：只判 `boundingClientRect` 会被卡片那一句（CARD_SELECTORS）顶包
    assert.ok(/selectAll\(\s*ROWS_VIEWPORT_SELECTOR\s*\)[\s\S]{0,40}?boundingClientRect/.test(body),
      '行区那次量测没有读 boundingClientRect（拿不到真实坐标）')
    // ② ⭐⭐ 七次口径：量**位置**（行区顶），不是容器高度
    assert.ok(/rowsRect\.top/.test(body), '没有用行区顶（rowsRect.top）当量测对象')
    assert.ok(/scrollOffset/.test(body), '没有读页面滚动位置 ⇒ 页面滚过之后拿到的是视口坐标，行高会算错')
    assert.ok(/rowsRect\.top\s*\+\s*scrollTop/.test(body), '行区顶没有换算成**内容坐标**（页面滚过就偏）')
    // ③ 可用高度 = 视口底 − 行区顶
    //    ⛔ 逐字比对，不许带补偿量：`windowHeight - rowsTop - 104` 这类"偷偷扣一条带"
    //       就是这次真机 Bug 的形状（课表底不再贴 tabBar），松匹配抓不住、必须精确。
    const availDecl = body.match(/const availH\s*=\s*([^\n;]+)/)
    assert.strictEqual(availDecl && availDecl[1].replace(/\s+/g, ' ').trim(), 'windowHeight - rowsTop',
      `行区可用高度不是"视口底 − 行区顶"：实测 "${availDecl && availDecl[1].trim()}"`)
    // ④ 行高 = 可用高度 ÷ 行数
    assert.ok(/Math\.max\(\s*minPx,\s*availH\s*\/\s*rows\s*\)/.test(body), '行高不是"可用高度 ÷ 行数" ⇒ 又回到写死高度')
    // ⑤ ⛔ 不许再量容器高度：行区不再由 flex 分配高度 ⇒ 容器高 = 上一帧自己发下去的行高之和，
    //    量它就成了"自己量自己"（自锁：永远不会更新）。这正是七次口径要换掉的东西。
    assert.ok(!/\b\w*[Rr]ect\.height\s*\/\s*rows/.test(body), '⛔ 又回去量容器高度 ÷ 行数了（自锁：下发的行高反过来决定容器高）')
    // ⑥ 必须守住可读下限
    assert.ok(/Math\.max\(\s*minPx/.test(body), '没有用 max(minPx, …) 守住可读下限 ⇒ 小屏会把行压到点不中')
    // ⑦ 行数必须是**实际渲染行数**，不许写死 18 / 24
    const rowsSrc = body.match(/const rows\s*=[\s\S]*?\.length/)
    assert.ok(rowsSrc, '读不到行数来源')
    assert.ok(/dayRows|weekSlides/.test(rowsSrc[0]), '行数不是从实际渲染数据取的')
    assert.ok(!/\b(18|24)\b/.test(rowsSrc[0]), '行数里出现写死的字面量 ⇒ 凌晨段展开后会算错')
    // ⑧ 卡片高度必须由**同一次量测**导出（不是"行高之外的第二套数字"）
    assert.ok(/cardHeightStyle/.test(body) && /rowsTop\s*-\s*cardTop/.test(body),
      '卡片高度不是从同一次量测（行区顶 − 卡片顶 + 行数 × 行高）导出的')
    // ⑨ 整份 measureRowHeight 不许出现"写死的 px 行高"赋值
    assert.ok(!/=\s*'?\d+(\.\d+)?px'?/.test(body), 'measureRowHeight 里出现写死的 px 行高')
  })

  // ─────────────────────────────────────────────── ③ 每一行的 wxml 必须收到下发的行高
  await runner('③ 周 / 日两种小时行都必须绑定 {{rowHeightStyle}}：不下发 ⇒ CSS 兜底又变回写死高度', () => {
    const weekRow = wxmlNoComment.match(/<view[^>]*class="grid row-grid[^"]*"[^>]*>/)
    const dayRow = wxmlNoComment.match(/<view[^>]*class="day-row[^"]*"[^>]*>/)
    assert.ok(weekRow, '⛔ 找不到周视图小时行（脚本锚点失效）')
    assert.ok(dayRow, '⛔ 找不到日视图小时行（脚本锚点失效）')
    assert.ok(/style="\{\{rowHeightStyle\}\}"/.test(weekRow[0]), `周视图行没有下发 rowHeightStyle：${weekRow[0]}`)
    assert.ok(/style="\{\{rowHeightStyle\}\}"/.test(dayRow[0]), `日视图行没有下发 rowHeightStyle：${dayRow[0]}`)
    // 行仍需 flex:none（不许回头 flex:1 均分 —— 那会把最后一行压扁）
    for (const sel of ['.row-grid', '.day-row']) {
      assert.ok(/none/.test(geom.declOf(SOURCES.scheduleWxss, sel, 'flex')), `${sel} 必须是 flex:none`)
    }
  })

  // ─────────────────────────────────────────────── ④ 卡片 / 半小时片段必须跟着实际行高（百分比）
  await runner('④ 课程卡片与半小时片段的定位必须是**百分比**：写死 px 会在行高一变就错位', () => {
    const deco = jsNoComment.match(/const slotStyle\s*=[\s\S]*?:\s*`[^`]*`/)
    assert.ok(deco, '⛔ 读不到 slotStyle（脚本锚点失效）')
    const text = deco[0]
    assert.ok(/top:\$\{[^}]*\}\s*%/.test(text), `slotStyle 的 top 不是百分比：${text}`)
    assert.ok(/height:\$\{[^}]*\}\s*%|height:100%/.test(text), `slotStyle 的 height 不是百分比：${text}`)
    assert.ok(!/\d+px/.test(text), 'slotStyle 里出现写死的 px ⇒ 卡片长度不跟随行高')
    // 半点 / 跨午夜的都是**按分钟比例**算的（不存在另一套数字）
    assert.ok(/minute\s*\/\s*60/.test(text), '半点不是按 minute/60 的比例算的')
    assert.ok(/clippedEnd\s*=\s*Math\.min\(\s*startMinute\s*\+\s*planned,\s*24\s*\*\s*60\s*\)/.test(jsNoComment),
      '跨午夜没有截断在 24:00（会溢出到格子外面）')
  })

  // ─────────────────────────────────────────────── ⑤ 布局一变就重算（七个必须的重算点）
  await runner('⑤ 布局变化的**每一处**都排了重算：切视图 / 凌晨展开 / 横幅 / 通知条 / 屏幕尺寸 / 数据刷新', () => {
    const calls = jsNoComment.match(/this\.syncRowHeight\(\)/g) || []
    assert.ok(calls.length >= 7, `syncRowHeight 只有 ${calls.length} 处调用 ⇒ 至少漏了一个重算点`)
    const where = src => new RegExp(src).test(jsNoComment)
    assert.ok(/renderCurrentView\(\)\s*\{[\s\S]*?this\.syncRowHeight\(\)/.test(jsNoComment), '切视图（renderCurrentView）后没重算')
    assert.ok(/this\.setData\(\{\s*cancelNotice: notice \}[\s\S]{0,80}syncRowHeight/.test(jsNoComment), '通知条出现后没重算')
    assert.ok(/this\.setData\(\{\s*cancelNotice: cleared \}[\s\S]{0,80}syncRowHeight/.test(jsNoComment), '通知条消失后没重算')
    assert.ok(/inSandbox[\s\S]{0,80}syncRowHeight/.test(jsNoComment), '横幅出现/消失后没重算')
    assert.ok(/wx\.onWindowResize/.test(jsNoComment) && where('onWindowResize\\(\\)\\s*\\{\\s*this\\.syncRowHeight'), '屏幕尺寸变化后没重算')
    assert.ok(/this\.setData\(patch,\s*\(\)\s*=>\s*\{[^}]*syncRowHeight/.test(jsNoComment), '数据刷新上屏后没重算（凌晨提示条可能刚出现）')
    // ⭐ 1.3.11：下拉刷新的紧凑提示条占 44rpx 的流 ⇒ 出现 / 收回都必须重算，
    //    否则它在的那几十毫秒里末行会被顶出视口（那是"页面级刷新"新引入的唯一占流元素）。
    assert.ok(/setData\(\{\s*refreshing:\s*true\s*\},\s*\(\)\s*=>\s*this\.syncRowHeight\(\)\)/.test(jsNoComment),
      '下拉刷新提示条**出现**后没重算行高')
    assert.ok(/setData\(\{\s*refreshing:\s*false\s*\},\s*\(\)\s*=>\s*this\.syncRowHeight\(\)\)/.test(jsNoComment),
      '下拉刷新提示条**收回**后没重算行高')
    // 合并到下一帧 ⇒ 不会量到中间态
    const syncBody = jsNoComment.match(/\n  syncRowHeight\s*\(\s*\)\s*\{[\s\S]*?\n  \}/)
    assert.ok(syncBody && /wx\.nextTick/.test(syncBody[0]), 'syncRowHeight 没有合并到下一帧 ⇒ 会量到中间态')
  })

  // ─────────────────────────────────────────────── ⑥ 这段逻辑不许碰任何业务数据
  await runner('⑥ 测量逻辑**只读布局**：不许 setData 别的字段、不许写库、不许发云端命令', () => {
    const body = jsNoComment.match(/\n  measureRowHeight\s*\(\s*\)\s*\{[\s\S]*?\n  \}/)[0]
    const setDatas = body.match(/setData\(\{([^}]*)\}/g) || []
    for (const one of setDatas) {
      assert.ok(/rowHeightStyle/.test(one), `measureRowHeight 里推送了别的字段：${one}`)
    }
    for (const banned of ['setStorageSync', 'callFunction', 'getDB', 'mutate.', 'removeSync', 'Cloud']) {
      assert.ok(body.indexOf(banned) < 0, `测量逻辑里出现 ${banned} ⇒ 碰了业务数据`)
    }
  })

  // ─────────────────────────────────────────────── ⑦ 几何：三机型 × 有/无横幅 / 有/无通知条都要铺满
  await runner('⑦ 公式侧：三机型 × 四档状态，18 行**严格等高且铺满行区**（底层不留空白）', () => {
    for (const device of DEVICES) {
      const minPx = MIN_ROW_RPX * device.windowWidth / 750
      const states = [
        { withBanner: false, noticePx: 0, label: '正式区' },
        { withBanner: true, noticePx: 0, label: '测试区' },
        { withBanner: false, noticePx: NOTICE_PX, label: '正式区+通知条' },
        { withBanner: true, noticePx: NOTICE_PX, label: '测试区+通知条' }
      ]
      for (const st of states) {
        const g = geomOf(device, st.withBanner, { noticePx: st.noticePx })
        const tag = `${device.name}·${st.label}`
        // ① 严格等高：行高 × 行数 == 内容高（这一条把"存在差异/不正确某行补差"钉死）
        assert.ok(Math.abs(g.rowH * g.renderedRows - g.rowsContentH) < 0.001, `${tag}：行不是严格等高`)
        // ② 铺满：内容高 ≥ 行区可视高（否则底部就是空白）
        assert.ok(g.rowsContentH >= g.rowsViewportH - 0.5,
          `${tag}：行总高 ${g.rowsContentH.toFixed(1)} < 行区 ${g.rowsViewportH.toFixed(1)} ⇒ 底部留了 ${(g.rowsViewportH - g.rowsContentH).toFixed(1)}px 空白`)
        // ③ 没触到下限时必须**恰好**铺满（零滚动）
        if (g.rowH > minPx + 0.01) {
          assert.ok(g.scrollable <= 0.5, `${tag}：行高还有余量却滚了 ${g.scrollable.toFixed(1)}px ⇒ 又是写死高度`)
        }
        // ④ 23:00 最后一行在**滚到底**时必须完整落在视口里
        //    ⛔ 七次口径：滚动容器是整页（行区不再自己滚）⇒ 比视口底，不是行区下沿
        assert.ok(g.hour23FullyVisible,
          `${tag}：滚到底 23:00 行底 ${g.hour23BottomAtBottom.toFixed(1)} 超出视口底 ${g.vh}`)
        // ⑤ 课表底必须贴到 tabBar 上沿（不许任何东西再占一条"让位带"）
        assert.ok(g.scheduleFillsToTabBar, `${tag}：课表底距视口底还有 ${g.calendarGapBelowViewport.toFixed(1)}px`)
        // ⑥ 课表内部不许出现".fab-capsule / 底部带"回潮
        assert.strictEqual(g.fabSafe, 0, `${tag}：又出现了底部让位带 ${g.fabSafe}px`)
      }
    }
  })

  // ─────────────────────────────────────────────── ⑧ 屏幕越大 ⇒ 行越高（这就是空白的根因修复）
  await runner('⑧ 屏幕越高、每行越**高**（行区可用高度全部回到行本身，而不是留在底部）', () => {
    const rowHOf = d => geomOf(d, false).rowH
    const hSmall = rowHOf(DEVICES[0]), hMid = rowHOf(DEVICES[1]), hBig = rowHOf(DEVICES[2])
    assert.ok(hMid > hSmall, `常规屏行高 ${hMid.toFixed(1)} ≤ 小屏 ${hSmall.toFixed(1)} ⇒ 多出来的高度没还给行`)
    assert.ok(hBig > hMid, `大屏行高 ${hBig.toFixed(1)} ≤ 常规屏 ${hMid.toFixed(1)} ⇒ 大屏底部又会留白`)
    // 每一档都必须比"写死的旧行高"高（旧值 = 50rpx，正式区无横幅）
    for (const device of DEVICES) {
      const old = MIN_ROW_RPX * device.windowWidth / 750
      assert.ok(rowHOf(device) > old, `${device.name}：行高 ${rowHOf(device).toFixed(1)} 没超过旧写死值 ${old.toFixed(1)} ⇒ 没吃掉那块空白`)
    }
    process.stdout.write(`     行高实测（正式区 18 行）：${DEVICES.map(d => `${d.name.split('·')[0].trim()} ${rowHOf(d).toFixed(2)}px`).join(' / ')}\n`)
  })

  // ─────────────────────────────────────────────── ⑨ 凌晨段展开 24 行：同法则、守下限
  await runner('⑨ 凌晨段展开（18 → 24 行）：同一条"铺满"法则，行高按 24 份重分、不破可读下限', () => {
    for (const device of DEVICES) {
      const minPx = MIN_ROW_RPX * device.windowWidth / 750
      const closed = geomOf(device, false)
      const open = geomOf(device, false, { lateExpanded: true, latePx: LATE_PX })
      const tag = device.name
      assert.strictEqual(open.renderedRows, 24, `${tag}：展开后不是 24 行`)
      assert.ok(open.rowH >= minPx - 0.01, `${tag}：展开后行高 ${open.rowH.toFixed(2)} 掉到可读下限 ${minPx.toFixed(2)} 以下`)
      assert.ok(open.rowsContentH >= open.rowsViewportH - 0.5, `${tag}：展开后底部留白`)
      assert.ok(open.rowH < closed.rowH + 0.01, `${tag}：行数变多、行高却没重分 ⇒ 写死高度回来了`)
      assert.ok(open.scheduleFillsToTabBar, `${tag}：展开后课表没铺到 tabBar 上方`)
    }
  })

  // ─────────────────────────────────────────────── ⑩ 这次不许把任何按钮/安全带加回来
  await runner('⑩ 修高度**不等于**把按钮加回来：悬浮胶囊 / 底部安全带一个都不许复活', () => {
    assert.ok(!/fab-capsule/.test(wxmlNoComment), '⛔ 右下悬浮胶囊（.fab-capsule）回来了')
    assert.ok(!/fab-capsule/.test(SOURCES.appWxss.replace(/\/\*[\s\S]*?\*\//g, '')), '⛔ .fab-capsule 样式回来了')
    assert.ok(!/fab-safe/.test(wxssNoComment), '⛔ 底部安全带 var(--fab-safe) 回来了')
    const swiperMb = geom.declOf(SOURCES.scheduleWxss, '.week-swiper', 'margin-bottom')
    assert.ok(!/fab-safe/.test(swiperMb), `⛔ .week-swiper 又开始给谁让位：margin-bottom:${swiperMb}`)
    // 新建入口仍然是"点空白格"
    assert.ok(/class="cell[^"]*"[^>]*bindtap="cell"/.test(wxmlNoComment), '⛔ 空白格的 bindtap="cell" 没了 ⇒ 新建入口断了')
  })

  process.stdout.write(`\nSCHEDULE GRID RESPONSIVE: ${TOTAL} 段中 ${passed} 段通过${passed === TOTAL ? '' : `、${TOTAL - passed} 段失败`}\n`)
  if (passed !== TOTAL) process.exitCode = 1
}

main()
