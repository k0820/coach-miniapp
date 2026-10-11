// ⭐⭐⭐ 学员名单：**没有任何悬浮遮挡物** + **名单铺到 tabBar 上方** —— 几何证明 + 旧写法反证。
//
// ⛔ 口径演进（读之前先看这条，别把旧结论抄回来）：
//   · 第一版：名单跟着**整页**滚，右下「＋」是 position:fixed，页面靠 padding-bottom:150rpx 让位。
//     ⇒ 只有"滚到底"那一下不挡；手指停在任意中间位置，固定按钮必然压住某一行的姓名 / 剩余节数。
//     （用户原话："不要接受'滚到底才不挡'。"）
//   · 第二版：名单改成内部 scroll-view + 一条**独立底部安全带**（.students-fab-band，144rpx）
//     把悬浮胶囊圈起来 ⇒ 几何上真的不挡了，代价是名单永远少用 144rpx（底部一大块空地）。
//   · ⭐ 第三版（**本文件现在钉的**）：**悬浮胶囊与安全带一起删掉**，「＋新增」搬进**标题行**
//     （.students-add，在流内、跟着名单滚）⇒
//       ① 遮挡问题**结构性消失**（流内元素不可能压住别的行）；
//       ② 名单**回收**那 144rpx，一路铺到 tabBar 上方。
//
// 本文件做三件事：
//   ① 从**真实源码文本**里读出几何数字（wxss / app.wxss / wxml），不写死期望值；
//   ② 把新模型跑一遍：名单下沿必须**正好**落在视口底；页面上唯一剩下的 fixed 元素
//      （右侧字母导航 .alphabet-rail）必须与"行文字区"**横向不相交**；
//   ③ 内存变异自证（磁盘不动）：把新模型改坏，判据必须重新变红。
//
// ⛔ 全程只读文本 + 纯算术：不渲染、不写数据、不碰 Production / Sandbox、不开任何窗口。
// ⛔ rpx 与机型无关（等比单位）⇒ 判定用 rpx；同时打印两个重点机型的 px 供人眼核对。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const contract = require('./helpers/ui-round5-contract')

const PROJ = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(PROJ, p), 'utf8')

const SOURCES = {
  wxss: read('pages/students/students.wxss'),
  appWxss: read('app.wxss'),
  wxml: read('pages/students/students.wxml'),
  js: read('pages/students/students.js')
}

// ── 重点机型：rpx = 屏宽 / 750 ───────────────────────────────────────────────
const DEVICES = [
  { name: 'iPhone 6/7/8 (375×667)', windowWidth: 375, windowHeight: 555, rpx: 375 / 750 },
  { name: 'iPhone 12/13 Pro (390×671)', windowWidth: 390, windowHeight: 671, rpx: 0.52 },
  { name: 'iPhone 14 Pro (393×852)', windowWidth: 393, windowHeight: 852, rpx: 393 / 750 }
]

// ── 从源码文本读几何（⛔ 一律读真值，不写死） ────────────────────────────────
const ruleBody = (css, selector) => contract.ruleBodies(css, selector).join(';')
const declRaw = (css, selector, prop) => {
  const match = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;}]+)').exec(ruleBody(css, selector))
  return match ? match[1].trim() : ''
}
const num = value => {
  const match = /^(-?[\d.]+)rpx$/.exec(String(value).trim())
  return match ? Number(match[1]) : null
}

function geometryOf(sources) {
  const css = contract.stripCss(sources.wxss)
  const app = contract.stripCss(sources.appWxss)
  const wxml = contract.stripHtml(sources.wxml)

  const pageHeightRaw = declRaw(css, '.students-list-page', 'height')
  const pageMinHeightRaw = declRaw(css, '.students-list-page', 'min-height')
  const pulldown = (() => {
    const match = /calc\(\s*100vh\s*\+\s*([\d.]+)rpx\s*\)/.exec(pageHeightRaw)
    return match ? Number(match[1]) : 0
  })()
  const bannerH = Number((/--sandbox-banner-h\s*:\s*([\d.]+)rpx/.exec(app) || [, 0])[1])

  // ⛔ 安全带：第三版必须**不存在**（存在就是"名单白占底部空间"）
  const bandHeightRaw = declRaw(css, '.students-list-page .students-fab-band', 'height')
  const bandExists = /\.students-fab-band/.test(css) || /students-fab-band/.test(wxml)

  // 「＋新增」按钮：必须在**流内**（不许 fixed / absolute）
  const addBody = ruleBody(css, '.students-list-page .students-add')
  const addFixed = /position\s*:\s*(fixed|absolute)/.test(addBody)
  const addHeight = (() => {
    // 高度按 padding(上下) + 字号×行高 估算（按钮没有显式 height ⇒ 从真实声明里算）
    const pad = /padding\s*:\s*([\d.]+)rpx\s+([\d.]+)rpx/.exec(addBody)
    const font = Number((/font-size\s*:\s*([\d.]+)rpx/.exec(addBody) || [, 0])[1])
    const lh = Number((/line-height\s*:\s*([\d.]+)/.exec(addBody) || [, 1.2])[1])
    return pad ? Number(pad[1]) * 2 + font * lh : font * lh
  })()

  // ⭐ 页面上唯一剩下的 fixed 元素：右侧字母导航（它在页面 padding-right 里，不该压文字）
  // ⛔ 一律取**最后一条**声明（层叠结果）：否则"后面又追加了一条更宽的 width"骗得过公式（假绿）。
  const railSel = '.students-list-page .alphabet-rail'
  // ⛔ 导轨的 position 写在**基础** .alphabet-rail 上，几何（right/top/bottom/width）被页内规则覆盖
  //    ⇒ 必须把两条规则的声明**按顺序拼起来**再取最后一条，否则 position 会读不到、判据变摆设。
  const railBody = ruleBody(css, '.alphabet-rail') + ';' + ruleBody(css, railSel)
  const lastRpxOf = (body, prop) => {
    const re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*(-?[\\d.]+)rpx', 'g')
    let last = null, m
    while ((m = re.exec(body))) last = Number(m[1])
    return last
  }
  const railRight = lastRpxOf(railBody, 'right') || 0
  const railWidth = lastRpxOf(railBody, 'width') || 0
  const railTop = lastRpxOf(railBody, 'top') || 0
  const railBottomGap = lastRpxOf(railBody, 'bottom') || 0
  const railFixed = /position\s*:\s*fixed/.test(railBody)

  const rowH = num(declRaw(css, '.students-list-page .student-row', 'height'))
  const rowGap = num(declRaw(css, '.students-list-page .student-row', 'margin-bottom'))

  return {
    pageDefiniteHeight: /^calc\(/.test(pageHeightRaw),
    pageSelfScrolls: pageMinHeightRaw === '100vh' || !/^calc\(/.test(pageHeightRaw),
    pageHeightRaw, pageMinHeightRaw, pulldown,
    bannerH,
    padTop: contract.paddingRpx(css, '.students-list-page', 'top') || 0,
    padBottom: contract.paddingRpx(css, '.students-list-page', 'bottom') || 0,
    padRight: contract.paddingRpx(css, '.students-list-page', 'right') || 0,
    padLeft: contract.paddingRpx(css, '.students-list-page', 'left') || 0,
    scrollFlex: declRaw(css, '.students-list-page .students-scroll', 'flex'),
    scrollMinHeight: declRaw(css, '.students-list-page .students-scroll', 'min-height'),
    bandExists, bandHeightRaw,
    addFixed, addHeight, addBody,
    railFixed, railRight, railWidth, railTop, railBottomGap,
    rowH, rowGap
  }
}

// ── 相交检测 ─────────────────────────────────────────────────────────────────
const overlaps = (aTop, aBottom, bTop, bBottom) => aTop < bBottom && aBottom > bTop
const STEP = 2 // rpx：≈1px

/** ⭐ 新模型：名单在 .students-scroll 里滚；返回「滚动区下沿 − 视口底」（rpx，必须 = 0） */
function listBottomGap(g, device, withBanner) {
  const viewport = device.windowHeight / device.rpx
  const pageTop = withBanner ? g.bannerH : 0
  const pageH = withBanner ? viewport + g.pulldown - g.bannerH : viewport + g.pulldown
  // 滚动区是页面里唯一的 flex 子项 ⇒ 高度 = 页面高 − 上下内边距
  const scrollH = pageH - g.padTop - g.padBottom
  const scrollBottom = pageTop + g.padTop + scrollH
  return { viewport, pageTop, pageH, scrollH, scrollBottom, gap: scrollBottom - viewport }
}

/**
 * ⭐ 页面上唯一剩下的 fixed 元素（字母导航）会不会压住**行文字**？
 * 判据是横向的：行文字区右边界（视口 − padding-right）必须 ≤ 导轨左边界。
 */
function railHits(g, device, rows) {
  const viewport = device.windowHeight / device.rpx
  const screenW = 750 // rpx
  const textRight = screenW - g.padRight
  const railLeft = screenW - g.railRight - (g.railWidth || 0)
  const railTop = g.railTop
  const railBottom = viewport - g.railBottomGap
  if (!g.railFixed) return { hits: 0, textRight, railLeft }
  let hits = 0
  if (textRight > railLeft) {
    // 横向已经相交 ⇒ 纵向再逐滚动位置扫一遍（行文字在纵向会覆盖导轨的哪一段）
    for (let k = 0; k < rows; k++) {
      const top = g.padTop + k * (g.rowH + g.rowGap)
      for (let i = 0; i <= Math.max(0, top); i += STEP) {
        const rowTop = top - i, rowBottom = rowTop + g.rowH
        if (overlaps(rowTop, rowBottom, railTop, railBottom)) { hits++; break }
      }
    }
  }
  return { hits, textRight, railLeft, railTop, railBottom }
}

/**
 * ⛔ 旧模型（已废弃，只用来做**反证**）：名单跟着整页滚，「＋」是固定在右下的悬浮按钮。
 * 返回 { interior, atBottom }：中间滚动位置的相交数必须 > 0，滚到底那一下 = 0。
 */
const OLD_PAD_BOTTOM = 150
function oldModelHits(g, device, rows) {
  const viewport = device.windowHeight / device.rpx
  const buttonH = Math.max(g.addHeight, 48)
  const buttonTop = viewport - 24 - buttonH
  const buttonBottom = viewport - 24
  const contentH = g.padTop + rows * (g.rowH + g.rowGap) + OLD_PAD_BOTTOM
  const docHeight = Math.max(viewport, contentH)
  const pageScrollMax = Math.max(0, docHeight - viewport)
  let interior = 0, atBottom = 0
  for (let k = 0; k < rows; k++) {
    const docTop = g.padTop + k * (g.rowH + g.rowGap)
    for (let s = 0; s <= pageScrollMax; s += STEP) {
      const top = Math.max(docTop - s, 0)
      const bottom = Math.min(docTop + g.rowH - s, viewport)
      if (bottom <= top) continue
      if (!overlaps(top, bottom, buttonTop, buttonBottom)) continue
      if (s >= pageScrollMax - STEP / 2) atBottom++
      else if (s > 0) interior++
    }
  }
  return { interior, atBottom, pageScrollMax }
}

// ══════════════════ ① 源码里的结构（悬浮物与安全带都没了） ══════════════════
const G = geometryOf(SOURCES)
assert.strictEqual(G.pageSelfScrolls, false,
  '⛔ .students-list-page 不许自己成为滚动容器（min-height:' + (G.pageMinHeightRaw || '无') + '）')
assert.ok(G.rowH > 0 && G.rowGap >= 0, '行高 / 行距必须能从源码读出来：' + JSON.stringify(G))
assert.strictEqual(G.bandExists, false,
  '⛔ .students-fab-band（底部安全带）回来了 ⇒ 名单又开始白占底部空间（实测 height:' + G.bandHeightRaw + '）')
assert.strictEqual(G.addFixed, false,
  '⛔ 「＋新增」是 position:fixed/absolute ⇒ 它又变成压住名单的悬浮物（实测：' + G.addBody + '）')
console.log('① 结构：.students-list-page 确定高度 ' + G.pageHeightRaw + '（+'
  + G.pulldown + 'rpx 下拉余量）；名单在 .students-scroll 里滚（flex:' + G.scrollFlex
  + '，min-height:' + G.scrollMinHeight + '）；**无**底部安全带；「＋新增」在流内（高约 '
  + G.addHeight.toFixed(0) + 'rpx）')

// ══════════════════ ② 名单下沿必须**正好**落在视口底（tabBar 上沿） ══════════════════
for (const device of DEVICES) {
  for (const withBanner of [false, true]) {
    const m = listBottomGap(G, device, withBanner)
    assert.ok(Math.abs(m.gap) <= 0.5,
      '⭐ ' + device.name + (withBanner ? '（测试区横幅）' : '') + '：名单下沿 ' + m.scrollBottom.toFixed(1)
      + 'rpx 与视口底 ' + m.viewport.toFixed(1) + 'rpx 差 ' + m.gap.toFixed(1) + 'rpx ⇒ '
      + (m.gap > 0 ? '最后一行被推出屏幕' : '底部又空出一块（被否掉的形状）'))
  }
  const m0 = listBottomGap(G, device, false)
  console.log('   · ' + device.name + '：名单下沿 ' + (m0.scrollBottom * device.rpx).toFixed(1)
    + 'px = 视口底 ' + (m0.viewport * device.rpx).toFixed(1) + 'px（差 '
    + (m0.gap * device.rpx).toFixed(2) + 'px）· 可用高 ' + (m0.scrollH * device.rpx).toFixed(0) + 'px')
}
console.log('② 名单铺到 tabBar 上方：' + DEVICES.length + ' 个机型 × 有/无横幅 ⇒ 下沿与视口底**零偏差**')

// ══════════════════ ③ 唯一剩下的 fixed 元素（字母导航）不许压住行文字 ══════════════════
const ROWS = 24
for (const device of DEVICES) {
  const r = railHits(G, device, ROWS)
  assert.strictEqual(r.hits, 0,
    '⭐ ' + device.name + '：字母导轨（左边界 ' + r.railLeft + 'rpx）压住了行文字区（右边界 '
    + r.textRight + 'rpx），相交 ' + r.hits + ' 次')
}
const rail0 = railHits(G, DEVICES[1], ROWS)
console.log('③ 字母导航不压文字：行文字右边界 ' + rail0.textRight + 'rpx ≤ 导轨左边界 '
  + rail0.railLeft + 'rpx（差 ' + (rail0.railLeft - rail0.textRight) + 'rpx）')

// ══════════════════ ④ 反证：旧形状（整页滚 + 悬浮按钮）一定算得出来 ══════════════════
for (const device of DEVICES) {
  const old = oldModelHits(G, device, ROWS)
  assert.ok(old.interior > 0,
    '⭐ 反证失败：旧形状（整页滚 + 右下悬浮按钮）在 ' + device.name + ' 上算不出中间位置相交 ⇒ 判据没判别力')
  assert.strictEqual(old.atBottom, 0,
    '⭐ 反证另一半：旧形状"滚到底"那一下本来就干净（' + device.name + ' 实测 ' + old.atBottom + '）'
    + ' ⇒ 这正是"滚到底不挡"不够用的机器证明')
}
console.log('④ 反证：旧形状中间位置相交 '
  + DEVICES.map(d => oldModelHits(G, d, ROWS).interior).join(' / ') + ' 次，滚到底相交 '
  + DEVICES.map(d => oldModelHits(G, d, ROWS).atBottom).join(' / ') + ' 次（= 0）')

// ══════════════════ ⑤ 内存变异自证（磁盘一个字节都不动） ══════════════════
const patch = (source, key, from, to) => {
  if (source[key].indexOf(from) < 0) throw new Error('锚点失效（源码已变形）：' + key + ' 里找不到 "' + from + '"')
  if (from === to) throw new Error('空变异：from === to')
  const next = source[key].replace(from, to)
  if (next === source[key]) throw new Error('空变异：替换后文本没变')
  return { ...source, [key]: next }
}
const append = (source, key, text) => ({ ...source, [key]: source[key] + text })

const MUTATIONS = [
  {
    id: 'G01',
    what: '⛔ 底部安全带加回来（144rpx）⇒ 名单又开始白占底部空间',
    apply: s => append(s, 'wxss', '\n.students-list-page .students-fab-band{flex:none;height:144rpx}')
  },
  {
    id: 'G02',
    what: '⛔ 「＋新增」改回 position:fixed ⇒ 它又变成压住名单的悬浮物',
    apply: s => append(s, 'wxss', '\n.students-list-page .students-add{position:fixed;right:24rpx;bottom:24rpx}')
  },
  {
    id: 'G03',
    what: '⛔ 页面退回 min-height:100vh（页面自己滚）+ 按钮悬浮 ⇒ 中间位置必相交',
    apply: s => patch(s, 'wxss', '.students-list-page{height:calc(100vh + 40rpx);display:flex',
      '.students-list-page{min-height:100vh;display:flex')
  },
  {
    id: 'G04',
    what: '⛔ 字母导轨变宽/左移，压进行文字区',
    apply: s => append(s, 'wxss', '\n.students-list-page .alphabet-rail{width:80rpx}')
  },
  {
    id: 'G05',
    what: '⛔ 名单下沿不再贴视口底（padding-bottom 回到 0 ⇒ 最后一行被推出屏幕）',
    apply: s => patch(s, 'wxss', 'padding:30rpx 54rpx 40rpx 24rpx;box-sizing:border-box}',
      'padding:30rpx 54rpx 0 24rpx;box-sizing:border-box}')
  }
]

const escaped = []
const brokenScripts = []
for (const mutation of MUTATIONS) {
  let caught = false
  let why = ''
  try {
    const G2 = geometryOf(mutation.apply(SOURCES))
    // 判据与新模型一致：安全带回来 / 按钮悬浮 / 下沿不贴底 / 导轨压文字 ⇒ 必须被抓住
    if (G2.bandExists) { caught = true; why = '安全带回来了' }
    if (!caught && G2.addFixed) { caught = true; why = '「＋新增」变成悬浮元素' }
    if (!caught) {
      for (const device of DEVICES) {
        const gap = listBottomGap(G2, device, false).gap
        if (Math.abs(gap) > 0.5) { caught = true; why = '名单下沿与视口底差 ' + gap.toFixed(1) + 'rpx（' + device.name + '）'; break }
        if (railHits(G2, device, ROWS).hits > 0) { caught = true; why = '字母导轨压住行文字 ' + railHits(G2, device, ROWS).hits + ' 次（' + device.name + '）'; break }
        if (G2.pageSelfScrolls && oldModelHits(G2, device, ROWS).interior > 0) { caught = true; why = '页面自己滚 + 悬浮按钮 ⇒ 中间位置相交（' + device.name + '）'; break }
      }
    }
  } catch (error) {
    // ⛔ 锚点失效 / 空变异 = 脚本自身失效，不算"抓住"（否则就是拿空变异冒充判别力）
    if (/锚点失效|空变异/.test(error.message)) brokenScripts.push(mutation.id + ' ' + error.message)
    else { caught = true; why = '抛错：' + error.message }
  }
  if (!caught) escaped.push(mutation.id + ' ' + mutation.what)
  else if (!brokenScripts.some(line => line.indexOf(mutation.id) === 0)) console.log('   ✓ ' + mutation.id + ' 被抓住 —— ' + why)
}

assert.deepStrictEqual(brokenScripts, [],
  '变异脚本自身失效（锚点找不到 / 空变异），必须先修脚本：\n' + brokenScripts.map(l => '  ✗ ' + l).join('\n'))
assert.deepStrictEqual(escaped, [],
  '有变异没被抓住（假绿护栏）：\n' + escaped.map(l => '  ✗ ' + l).join('\n'))
console.log('⑤ 判别力自证：' + MUTATIONS.length + '/' + MUTATIONS.length + ' 个变异全部被抓住')
console.log('ALL STUDENTS SCROLL BAND TESTS PASSED')
