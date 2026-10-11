// M2 V1 · 四批客户端改动之间的**相互影响**（2026-09-30）。
//
// 近期四批改动都动到了"界面那一层"：
//   ① §123 BUG05（跨教练排课日期回弹）· ② §124 历史结算逐节课程明细
//   ③ §125 A 侧授权管理入口 · ④ §126 工作台布局修复
// 每一批单独都有测试，但**四批叠在一起**可能产生新的形状：
//   · 改 wxml 时把某个 bindtap 改没了 / 改名了，而 js 里那个 handler 还在（或反过来）⇒ 点了没反应；
//   · 明细的展开状态被另一处渲染覆盖 ⇒ 展开第一条把第二条也带开了；
//   · 布局修复只修了工作台，历史结算里的**长会员姓名**又把行撑破；
//   · 为了躲溢出悄悄把字号改小（⛔ 掩盖型修复）。
//
// ⭐ 判据：**"按钮存在"≠"点了有用"**；四批叠加之后要重新钉一次"绑定 ↔ handler ↔ 入口注册"这条链。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createWorld, runner } = require('./helpers/m2-business-world')

const ROOT = path.join(__dirname, '..')
const world = createWorld()

// ⭐ 2026-10-06：旧的「多教练服务（授权）工作台」已随认领方案下线（页面真的删了）。
//    跨教练排课的三个入口现在**都住在学员页** ⇒ 学员页同时是 §123/§125/§126 的"叠加面"，
//    这里的"四批叠加"自然收敛成"学员页 + 统计页"两个页面，判据一个字没改。
const TARGETS = [
  { name: '学员页（§123/§125/§126 入口所在的页）', page: 'pages/students/students', wxml: 'pages/students/students.wxml' },
  { name: '统计页（§124 历史结算明细）', page: 'pages/stats/stats', wxml: 'pages/stats/stats.wxml' }
]

// 真 require 页面模块拿到 Page(config) —— 不是读源码猜有哪些方法。
function pageConfigOf(pagePath) {
  let captured = null
  global.Page = config => { captured = config }
  const full = require.resolve(path.join(ROOT, pagePath))
  delete require.cache[full]
  require(full)
  assert.ok(captured, `${pagePath} 必须调用 Page()`)
  return captured
}
function bindTapsOf(wxmlPath) {
  const source = fs.readFileSync(path.join(ROOT, wxmlPath), 'utf8')
  return [...new Set([...source.matchAll(/bindtap="([A-Za-z_][\w]*)"/g)].map(m => m[1]))]
}
// 读 WXSS 里的声明（真解析，不硬编码常量）
function declOf(source, selector, prop) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const hit = []
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = {}
    for (const part of m[2].split(';')) {
      const i = part.indexOf(':')
      if (i > 0) decls[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    }
    for (const sel of m[1].split(',')) if (sel.trim() === selector && decls[prop] !== undefined) hit.push(decls[prop])
  }
  return hit.length ? hit[hit.length - 1] : null
}

;(async () => {
  await runner('① WXML 里的每一处 bindtap 都必须在**真页面对象**里有同名 handler（四批叠加后重新钉一次）', async () => {
    world.installRuntime()
    world.installFakeMutate()
    for (const target of TARGETS) {
      const config = pageConfigOf(target.page)
      const taps = bindTapsOf(target.wxml)
      assert.ok(taps.length, `${target.name} 的 wxml 里应当有 bindtap（实测 0 个）`)
      const missing = taps.filter(name => typeof config[name] !== 'function')
      assert.deepEqual(missing, [], `${target.name}：这些 bindtap 在页面里**没有对应方法** ⇒ 点了没反应：${missing.join('、')}`)
    }
  })

  await runner('② 页面注册链完整：这些页面都在 app.json 里（入口可达的最后一环）', async () => {
    const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
    TARGETS.forEach(target => {
      assert.ok(app.pages.includes(target.page), `app.json 必须注册 ${target.page}（否则入口跳不过去）`)
      assert.ok(fs.existsSync(path.join(ROOT, target.page + '.wxml')), `${target.page}.wxml 必须存在`)
    })
  })

  await runner('③ 明细展开/收起：**每一条会员行独立**，展开第一条不会把第二条带开', async () => {
    world.installRuntime()
    world.installFakeMutate()
    const config = pageConfigOf('pages/stats/stats')
    const page = Object.assign(Object.create(null), config, { data: { historyClassList: [] } })
    page.setData = function (patch) {
      Object.keys(patch || {}).forEach(key => {
        const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
        let target = this.data
        for (const part of parts.slice(0, -1)) target = target[part] = target[part] || {}
        target[parts[parts.length - 1]] = patch[key]
      })
    }
    page.data.historyClassList = [{ id: 'a', open: false }, { id: 'b', open: false }]
    page.toggleHistoryStudent({ currentTarget: { dataset: { i: 0 } } })
    assert.equal(page.data.historyClassList[0].open, true, '第一条必须展开')
    assert.equal(page.data.historyClassList[1].open, false, '⛔ 第二条不许被带开（每行独立）')
    page.toggleHistoryStudent({ currentTarget: { dataset: { i: 1 } } })
    assert.equal(page.data.historyClassList[0].open, true, '第一条要**保持**展开')
    assert.equal(page.data.historyClassList[1].open, true, '第二条也要能展开')
    page.toggleHistoryStudent({ currentTarget: { dataset: { i: 0 } } })
    assert.equal(page.data.historyClassList[0].open, false, '再点一次必须收起')
    assert.equal(page.data.historyClassList[1].open, true, '收起第一条不许影响第二条')
    // 越界下标不许改坏任何东西（也不许抛）
    page.toggleHistoryStudent({ currentTarget: { dataset: { i: 9 } } })
    assert.equal(page.data.historyClassList.length, 2, '越界下标不许新增/删减行')
  })

  await runner('④ 长会员姓名 / 长编号不许把历史结算的行撑破（结构性护栏 + 字号不许被改小）', async () => {
    const wxss = fs.readFileSync(path.join(ROOT, 'pages/stats/stats.wxss'), 'utf8')
    const main = declOf(wxss, '.history-main', 'grid-template-columns')
    assert.ok(main && /minmax\(0/.test(main), `.history-main 的第一列必须能收缩（minmax(0,1fr)），否则长姓名会把行撑破（实测 ${main}）`)
    const name = declOf(wxss, '.history-main b', 'overflow')
    assert.equal(name, 'hidden', '会员名超长时必须截断（overflow:hidden）')
    assert.equal(declOf(wxss, '.history-main b', 'min-width'), '0', '⛔ 会员名块必须 min-width:0（否则按 min-content 撑开 ⇒ 一字一行）')
    assert.ok(/ellipsis/.test(declOf(wxss, '.history-main b', 'text-overflow') || ''), '截断要有省略号，不能直接糊在一起')
    const lessonTop = declOf(wxss, '.history-lesson-top', 'grid-template-columns')
    assert.ok(lessonTop && /minmax\(0/.test(lessonTop), `.history-lesson-top 中间列必须能收缩（实测 ${lessonTop}）`)
    assert.equal(declOf(wxss, '.history-lesson-meta', 'flex-wrap'), 'wrap', '明细里的类型/时长/状态必须能换行')
    // ⛔ 不许靠缩小字号掩盖溢出
    assert.equal(declOf(wxss, '.history-main b', 'font-size'), '23rpx', '会员名字号不许被改小')
    assert.equal(declOf(wxss, '.history-amount', 'font-size'), '23rpx!important', '金额字号不许被改小')
    assert.equal(declOf(wxss, '.history-lesson-date', 'font-size'), '21rpx', '明细日期字号不许被改小')
    assert.equal(declOf(wxss, '.history-lesson-time', 'font-size'), '19rpx', '明细时间字号不许被改小')
  })

  await runner('⑤ ⛔ 已下线的旧工作台不许再被任何页面/入口引用（删了就要删干净）', async () => {
    // ⛔ "页面删了但还有地方跳过去" = 点了没反应，而且不报错 —— 正是这一批测试要防的形状。
    const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
    assert.ok(!app.pages.includes('pages/coach-authorization/coach-authorization'), 'app.json 里不许再注册旧工作台')
    const sources = fs.readdirSync(path.join(ROOT, 'pages')).flatMap(dir =>
      ['js', 'wxml', 'json'].map(ext => path.join(ROOT, 'pages', dir, `${dir}.${ext}`))
    ).filter(file => fs.existsSync(file))
    // ⚠️ 判据只看**旧页面路径**：`utils/coach-authorization.js`（授权目录缓存）还活着并且还在用，
    //    把它的名字也算进来会把一条仍然成立的能力误判成"没删干净"。
    const referencing = sources.filter(file => /pages\/coach-authorization|coach-authorization\/coach-authorization/.test(fs.readFileSync(file, 'utf8')))
    assert.deepEqual(referencing, [], `⛔ 这些页面还在引用已下线的工作台：${referencing.join('、')}`)
  })

  process.stdout.write('M2 client batch interaction tests: PASS (5 blocks)\n')
})()
