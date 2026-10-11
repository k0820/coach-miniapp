// 保存条必须真正钉在屏幕底部安全操作区。
//
// 真机故障：课包一多，「保存资料」够不着。
// 根因不是"没写 position:fixed"——它本来就有，但**静默失效**：
// 它原先被放在 .modal.member-editor 里面，而 .modal 带着 studentSheetIn 动画（含 transform），
// 拖拽时还会被写入 inline transform。祖先一旦有 transform，后代的 position:fixed 的包含块
// 就从"视口"变成"这个祖先"，于是 bottom:0 不再是屏幕底部，按钮跟着 sheet 一起被推走。
//
// 本测试钉住三件事：
//   ① 保存条的样式规则必须完整（fixed / 贴底 / 安全区 / 背景 / z-index / 内容留白）
//   ② 保存条必须是 mask 的直接子节点（不是 .modal 的子节点）
//   ③ 祖先链上不允许出现任何 transform —— 否则 fixed 静默失效，且只有真机能发现
//
// 静态断言钉的是"契约"不是"拼写"：所有 CSS 断言前先剥掉注释。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const PROJ = path.join(__dirname, '..')
const wxml = fs.readFileSync(path.join(PROJ, 'pages/students/students.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(PROJ, 'pages/students/students.wxss'), 'utf8')

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push('  ✓ ' + name)
  } catch (error) {
    results.push('  ✗ ' + name + '\n      ' + error.message)
    throw error
  }
}

// 剥掉注释再断言，避免把注释里出现的字样当成规则。
const wxssNoComment = wxss.replace(/\/\*[\s\S]*?\*\//g, '')
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ruleOf = sel => {
  const re = new RegExp(escapeRe(sel) + '\\s*\\{([^}]*)\\}', 'g')
  const bodies = []
  let m
  while ((m = re.exec(wxssNoComment))) bodies.push(m[1])
  return bodies.join(';')
}

// 保存条本体高（rpx，不含安全区）：padding-top + 按钮高 + padding-bottom
const ACTION_PADDING_TOP = 14
const ACTION_BUTTON_H = 76
const ACTION_PADDING_BOTTOM = 14
const ACTION_BAR_BODY_H = ACTION_PADDING_TOP + ACTION_BUTTON_H + ACTION_PADDING_BOTTOM

const SAVE_BAR_OPEN = '<view class="member-editor-action"'

// 保存条在 wxml 里的位置：必须紧跟 </scroll-view>，即 .modal 的兄弟。
const barIndex = wxml.indexOf(SAVE_BAR_OPEN)
const scrollCloseBeforeBar = wxml.lastIndexOf('</scroll-view>', barIndex)

const run = async () => {
  check('保存条节点存在于 wxml', () => {
    assert.ok(barIndex > 0, '找不到 ' + SAVE_BAR_OPEN)
  })

  // ── 样式契约 ────────────────────────────────────────────────
  check('保存条 .member-editor-action 必须 fixed 且四边贴底拉满', () => {
    const body = ruleOf('.member-editor-action')
    assert.ok(body, '.member-editor-action 规则不存在')
    assert.ok(/position\s*:\s*fixed/.test(body), '必须是 position:fixed')
    assert.ok(/bottom\s*:\s*0/.test(body), '必须 bottom:0')
    assert.ok(/left\s*:\s*0/.test(body), '必须 left:0')
    assert.ok(/right\s*:\s*0/.test(body), '必须 right:0')
  })

  check('保存条必须处理微信底部安全区 env(safe-area-inset-bottom)', () => {
    const body = ruleOf('.member-editor-action')
    assert.ok(/env\(\s*safe-area-inset-bottom\s*\)/.test(body),
      '底部安全区必须用 env(safe-area-inset-bottom) 处理，否则全面屏会被系统小白条压住')
  })

  check('保存条必须有背景色与 z-index，滚动内容不能从它下面透出来', () => {
    const body = ruleOf('.member-editor-action')
    assert.ok(/background\s*:\s*[^;]+/.test(body),
      '必须有背景色，否则内容滚动时会从按钮下面穿过')
    assert.ok(/z-index\s*:\s*\d+/.test(body),
      '必须有 z-index，否则会被滚动内容盖住')
  })

  check('保存条不得有分界线 / 底栏底色 / 阴影：只留一个干净的蓝色按钮', () => {
    const body = ruleOf('.member-editor-action')
    assert.ok(!/border-top\s*:/.test(body),
      '不允许 border-top —— 用户明确要求去掉"明显的分界线"')
    assert.ok(!/box-shadow\s*:\s*(?!none)/.test(body),
      '不允许阴影 —— 它会让保存条重新变成一条浮在内容上的"底栏"。'
      + '⚠️ 显式写 box-shadow:none 是**允许且必要**的（用它盖掉 app.wxss `.primary` 的暖色阴影），'
      + '要禁的是"真的画出一个阴影"，不是这两个词本身')
    const background = (/background\s*:\s*([^;]+)/.exec(body) || [])[1]
    assert.strictEqual((background || '').trim(), 'var(--student-bg)',
      '保存条背景必须与 sheet 完全同色（var(--student-bg)）：它同时负责盖住 mask 底部那 104rpx 空隙，'
      + '换成别的颜色就会露出一条色差带，再变成一个"底栏"。实得: ' + background)
    assert.ok(/background\s*:\s*var\(--student-bg\)/.test(ruleOf('.member-editor')),
      'sheet 与保存条必须共用同一个底色变量，否则接缝处会有色差')
    const button = ruleOf('.member-editor-action .editor-save')
    assert.ok(!/box-shadow\s*:\s*(?!none)/.test(button), '蓝色主按钮不得加阴影')
  })

  check('保存条按钮必须是居中紧凑按钮（180–220rpx），不得再铺满', () => {
    const button = ruleOf('.member-editor-action .editor-save')
    assert.ok(button, '.member-editor-action .editor-save 规则不存在')
    assert.ok(!/width\s*:\s*100%/.test(button),
      '按钮不得再通栏铺满 —— 用户要求改成居中的紧凑按钮（否则又会变成一条"底栏"观感）')
    const w = /width\s*:\s*([\d.]+)rpx/.exec(button)
    assert.ok(w, '按钮必须用 rpx 固定宽度，实得样式: ' + button)
    assert.ok(Number(w[1]) >= 180 && Number(w[1]) <= 220,
      '按钮宽度必须在 180–220rpx（用户指定区间），实得 ' + w[1] + 'rpx')
    const h = /height\s*:\s*([\d.]+)rpx/.exec(button)
    assert.ok(h, '按钮必须有固定 rpx 高度')
    assert.strictEqual(Number(h[1]), ACTION_BUTTON_H,
      '按钮高应为 ' + ACTION_BUTTON_H + 'rpx（改动它会连带打破"压进 sheet"的重叠量），实得 ' + h[1])
  })

  check('居中必须由父级 flex 完成，不得靠 margin:auto', () => {
    // 居中：不靠 margin:0 auto —— 微信 button 自带默认盒模型，auto 边距在部分基础库下静默失效。
    const bar = ruleOf('.member-editor-action')
    assert.ok(/display\s*:\s*flex/.test(bar) && /justify-content\s*:\s*center/.test(bar),
      '保存条必须用 display:flex + justify-content:center 让紧凑按钮居中')
    assert.ok(/flex\s*:\s*0\s+0\s+auto/.test(ruleOf('.member-editor-action .editor-save')),
      '按钮在 flex 容器里必须 flex:0 0 auto，否则会被压缩、宽度不再是契约值')
  })

  // ★ 1.1.9 真机第 3 轮定案：**放弃原生 button**。
  //   为什么前两轮都无效：原生 button 的默认样式本身就是 flex 居中（基础库 3.17.3 原文），
  //   文字是**匿名 flex 项** ⇒ `line-height` 只改行盒高、行盒随即被重新居中，**位移恒为 0**；
  //   改用 `padding-bottom` 压矮内容盒让居中线整体上移，也只是在一个**不受我控制的盒模型**上做外科手术。
  //   ⇒ 本轮换成 `<view>` + 自己的 flex 居中：文字视觉中心 = 外框中心，**不需要任何偏移数值**。
  check('保存按钮必须换成可完全控制布局的 view，不得再用原生 button（1.1.9 真机第 3 轮定案）', () => {
    const barChunk = wxml.slice(barIndex, barIndex + 260)
    assert.ok(!/<button/.test(barChunk),
      '保存条里不得再出现原生 <button>：它的默认布局不受控，正是前两轮反复修补都无效的原因。实得: ' + barChunk)
    assert.ok(/<view class="editor-save/.test(barChunk),
      '保存按钮必须是一个 class 含 editor-save 的 <view>，实得: ' + barChunk)
    assert.ok(!/class="[^"]*\bbtn\b/.test(barChunk) && !/class="[^"]*\bprimary\b/.test(barChunk),
      '新按钮不得再挂 .btn / .primary —— 它们会带回 line-height:84rpx、margin-top、渐变背景与暖色阴影，' +
      '正是要靠后续规则一条条压掉的来源。实得: ' + barChunk)
    assert.ok(/bindtap="save"/.test(barChunk),
      '保存入口必须仍然是 bindtap="save"（保存事件与业务逻辑一字不改）')
  })

  check('文字必须由 flex 真正居中，且不得再留任何偏移补丁（1.1.9 真机第 3 轮定案）', () => {
    const button = ruleOf('.member-editor-action .editor-save')
    // ① 真正的居中：flex 容器 + align-items / justify-content。
    //    单行文本的行盒由 align-items:center 居中于 76rpx 外框 ⇒ 视觉中心 = 外框中心。
    assert.ok(/display\s*:\s*flex/.test(button) && /align-items\s*:\s*center/.test(button) &&
      /justify-content\s*:\s*center/.test(button),
      '按钮必须自己用 display:flex + align-items:center + justify-content:center 居中，实得: ' + button)
    // ② 不许再留任何"偏移"写法 —— 上一轮那两条都是死路，留着就是第二套互相干扰的定位方式。
    assert.ok(!/line-height\s*:\s*[\d.]+rpx/.test(button),
      '不得再用 rpx 的 line-height（对居中项位移恒为 0），实得: ' + button)
    assert.ok(!/padding\s*:\s*0\s+0\s+[\d.]+rpx/.test(button),
      '不得再留 padding-bottom 上移补丁：换了元素之后它已无存在理由。实得: ' + button)
    // ③ 视觉不变量：外框尺寸 / 圆角 / 无边框 / 无阴影一个字都不能动。
    assert.strictEqual(Number((/height\s*:\s*([\d.]+)rpx/.exec(button) || [])[1]), ACTION_BUTTON_H,
      '按钮外框高必须仍是 ' + ACTION_BUTTON_H + 'rpx')
    assert.strictEqual(Number((/width\s*:\s*([\d.]+)rpx/.exec(button) || [])[1]), 200,
      '按钮外框宽必须仍是 200rpx')
    assert.ok(/border-radius\s*:\s*20rpx/.test(button),
      '圆角必须**显式**写 20rpx —— 换掉原生 button 后就失去了 .btn 带来的 20rpx，不写会变成直角')
    assert.ok(/border\s*:\s*0/.test(button), '按钮边框必须仍是 0')
    assert.ok(/box-shadow\s*:\s*none/.test(button), '按钮不得有阴影')
    assert.ok(/background\s*:\s*var\(--student-primary\)/.test(button), '按钮底色必须仍是 var(--student-primary)')
    assert.ok(/box-sizing\s*:\s*border-box/.test(button), '必须显式 box-sizing:border-box')
  })

  check('内容区底部留白必须 >= 保存条本体高，最后一个课时包不被遮', () => {
    const editor = ruleOf('.member-editor')
    const pb = /padding-bottom\s*:\s*([\d.]+)rpx/.exec(editor)
    assert.ok(pb, '.member-editor 必须有 padding-bottom')
    assert.ok(Number(pb[1]) >= ACTION_BAR_BODY_H,
      '.member-editor padding-bottom=' + pb[1] + 'rpx 不足以让最后一个课时包滚出保存条（需 >= ' + ACTION_BAR_BODY_H + 'rpx）')
  })

  // ── 真机横线的几何契约（2026-09-22 真机复现出的真因） ──────────
  check('保存条必须压进 sheet：mask 底部留白 < 保存条本体高，否则真机漏 1 设备像素的横线', () => {
    // rpx→px 是小数（全面屏 1rpx ≈ 0.552px）。mask 的 padding-bottom 与保存条高度若各自
    // calc 同一个 104rpx，真机取整后两条边界会落到**不同的设备像素**上，中间露出 1 个设备
    // 像素的 mask 暗色 rgba(20,29,42,.4) —— 这就是用户看到的那条贯穿全宽的横线。
    // 复刻环境 DPR=1 时接缝是 0px，所以这条缺陷**只有真机能看见**，必须用几何契约钉死：
    // 让 mask 底部留白**小于**保存条本体高，保存条的顶边落进 sheet 内部，
    // 用自己那块背景把缝实打实盖住 —— 任何 DPR、任何取整都不可能再露出来。
    const bar = ruleOf('.member-editor-action')
    assert.ok(/padding\s*:\s*14rpx\s+[\d.]+rpx\s+calc\(14rpx/.test(bar),
      '保存条本体高必须就是 ' + ACTION_BAR_BODY_H + 'rpx（上 14 + 按钮 76 + 下 14），下面的重叠量推算才成立')
    const gap = /padding-bottom\s*:\s*calc\(\s*([\d.]+)rpx/.exec(ruleOf('.member-editor-mask'))
    assert.ok(gap, '.member-editor-mask 必须用 calc(Nrpx + env(safe-area-inset-bottom)) 形式的 padding-bottom')
    const maskGap = Number(gap[1])
    assert.ok(maskGap < ACTION_BAR_BODY_H,
      'mask 底部留白 ' + maskGap + 'rpx 必须小于保存条本体高 ' + ACTION_BAR_BODY_H + 'rpx，'
      + '保存条才会压进 sheet 把那条缝盖住；一旦相等或更大，真机就会在接缝处漏出 1 设备像素的横线')
    assert.ok(ACTION_BAR_BODY_H - maskGap >= 8,
      '重叠量只有 ' + (ACTION_BAR_BODY_H - maskGap) + 'rpx，太小：小屏高 DPR 下仍可能被取整吃掉，建议 >= 8rpx')
  })

  // ── 结构契约（本次修复的核心） ──────────────────────────────
  check('保存条必须是 mask 的直接子节点：紧跟 </scroll-view>，不在 .modal 内', () => {
    assert.ok(scrollCloseBeforeBar > 0, '保存条之前找不到 </scroll-view>')
    // 保存条起点紧接在 </scroll-view> 之后（允许空白）
    const between = wxml.slice(scrollCloseBeforeBar + '</scroll-view>'.length, barIndex)
    assert.ok(between.trim() === '',
      '保存条与 </scroll-view> 之间不应有其他节点，实得: ' + JSON.stringify(between.slice(0, 60)))
    // 保存条之前 scroll-view 必须已闭合（否则它还在滚动区里）
    const lastOpen = wxml.lastIndexOf('<scroll-view', barIndex)
    const lastClose = wxml.lastIndexOf('</scroll-view>', barIndex)
    assert.ok(lastOpen < lastClose,
      '保存条仍被包在 scroll-view 内 —— 它会跟着内容一起滚走')
  })

  check('祖先链不得有 transform：.mask 与 .member-editor-mask 都要干净', () => {
    // fixed 的包含块是"最近的带 transform 的祖先"。mask 一旦有 transform，
    // 保存条同样会失效（且只有真机能发现），所以这里必须钉死。
    assert.ok(!/transform\s*:/.test(ruleOf('.mask')),
      '.mask 不允许出现 transform（会让子元素 fixed 失效）')
    assert.ok(!/transform\s*:/.test(ruleOf('.member-editor-mask')),
      '.member-editor-mask 不允许出现 transform（会让保存条 fixed 失效）')
  })

  check('sheetStyle 只能绑在 .modal 上，不得绑到 mask 或保存条', () => {
    assert.ok(/<scroll-view[^>]*class="modal member-editor"[^>]*style="\{\{sheetStyle\}\}"/.test(wxml),
      'sheetStyle 必须绑在 .modal.member-editor 上')
    const bar = new RegExp(escapeRe(SAVE_BAR_OPEN) + '[^>]*>').exec(wxml)
    assert.ok(bar, '找不到保存条节点')
    assert.ok(!/sheetStyle/.test(bar[0]),
      '保存条不能绑 sheetStyle —— 拖拽 sheet 会把它一起推走')
  })

  // ── 行为契约 ────────────────────────────────────────────────
  check('删除学员仍是次要危险操作，不做成固定主按钮', () => {
    const del = /<button[^>]*class="[^"]*delete-student[^"]*"[^>]*>/.exec(wxml)
    assert.ok(del, '找不到删除学员按钮')
    assert.ok(!/member-editor-action/.test(del[0]), '删除学员不能被放进固定操作条')
    assert.ok(wxml.indexOf(del[0]) < scrollCloseBeforeBar,
      '删除学员应留在滚动内容内（</scroll-view> 之前），作为非固定的次要危险操作')
  })

  check('保存条只含一个主按钮：绑 save、文案「保存资料」、保存中状态可见', () => {
    const closeIdx = wxml.indexOf('</view></view>', barIndex)
    const bar = wxml.slice(barIndex, closeIdx > 0 ? closeIdx : wxml.length)
    assert.ok(/bindtap="save"/.test(bar), '主按钮必须绑 save')
    assert.ok(/保存资料/.test(bar), '文案必须包含「保存资料」')
    // ⚠️ 原生 button 的 loading / disabled 属性随元素一起移除了，但**语义必须原样保留**：
    //   · 保存中要有可见反馈 ⇒ saving 驱动文案「正在保存…」+ is-saving（由 wxss 置灰）
    //   · 防重复提交 ⇒ 交给 withSaveLock() 的 single-flight（下一条 check 专门钉它）
    assert.ok(/saving/.test(bar), '保存按钮必须仍然反映保存中状态（saving）')
    assert.ok(/正在保存/.test(bar), '保存中必须换成「正在保存…」文案，用户要能看出它正在跑')
    assert.ok(/is-saving/.test(bar), '保存中必须挂 is-saving，否则换掉原生 loading 后就**没有**任何可见反馈了')
    const buttons = bar.match(/<button/g) || []
    assert.strictEqual(buttons.length, 0,
      '保存条里不应再有原生 <button>（1.1.9 第 3 轮改用可控的 view），实得 ' + buttons.length)
  })

  check('防重复提交不得依赖原生 disabled：withSaveLock 必须仍然在岗', () => {
    // ⚠️ 这是"换元素"最容易静默丢掉的一条：原来 `disabled="{{saving}}"` 由平台保证不触发，
    //   换成 view 之后它没有任何保护 —— 只有 withSaveLock 的 single-flight 能挡住第二次点击。
    const js = fs.readFileSync(path.join(PROJ, 'pages/students/students.js'), 'utf8')
    assert.ok(/withSaveLock\s*\(/.test(js), 'withSaveLock 必须存在')
    assert.ok(/if\s*\(\s*this\._saveTask\s*\)\s*return\s+this\._saveTask/.test(js),
      'withSaveLock 必须保留 single-flight 守卫（已有任务直接返回同一个任务）—— 原生 disabled 没了之后它是唯一的防双提交')
    assert.ok(/persistStudent\s*\([^)]*\)\s*\{\s*return\s+this\.withSaveLock/.test(js),
      '保存链路必须仍然经过 withSaveLock')
  })

  console.log(results.join('\n'))
  console.log('student editor save bar PASS（保存资料固定在底部安全操作区）')
}

run().then(
  () => process.exit(0),
  error => { console.error(error); process.exit(1) }
)
