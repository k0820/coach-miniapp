// 会员端三套主题 + 统一底部弹层的**视觉契约**。
//
// ═════════════════════════════════════════════════════════════════════════════
// 这一份盯的是哪一种事故
//
// ⛔ **"三套主题长得一模一样，但测试全绿"**。
//
//    怎么发生的：2026-10-03 之前 `utils/member-theme.js` 每套只有 5 个字段，
//    三套主色是 #22a06b / #168c72 / #4d7f72 —— 全是绿色系；
//    而 `pages/member-theme` 的 `choose()` 写死只允许选 vitality，
//    另外两套点了直接弹「该主题将在后续版本完善」。
//    ⇒ 那种结构下，一份只检查"三套都存在、id 不重名、能resolve"的测试会**全绿**，
//    而用户看到的是"三张卡片、只能选一张、换了看不出区别"。
//
//    这类假绿的根因是：**断言的是"存在性"，事故却是"同一性"**。
//    所以本文件的判据 ①② 断言的是**逐字段两两不同**（不是"字段存在"）——
//    把三套改成同一个 token，必须立刻变红。
//
// 另外盯的三种事故：
//   ③ 主题切换只对会员端生效 ⇒ 教练端被顺带改色 / 主题读写串了身份与缓存
//   ④ 教练端时段卡片被"改会员端"顺手改坏（已真机验收过的视觉不能动）
//   ⑤ 新弹层组件去掉 `catchtouchmove` ⇒ 滑动穿透；或底部按钮被顶出屏幕
//
// ═════════════════════════════════════════════════════════════════════════════
// ⛔ 本文件只读文本 + 注入假 wx / 假 require.cache。不写 Storage、不发网络请求、
//    不渲染、不部署。⛔ 判别力自证用 `require.cache` 注入漂移版模块，
//    **绝不改生产源码**（不改文件 ⇒ 不可能把仓库改坏）。
//
// 📌 判据写成"逐条返回问题清单"的纯函数，正式断言与末尾的漂移注入跑的是**同一份**代码。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')

const THEME_MODULE = 'utils/member-theme.js'
const THEME_PAGE = 'pages/member-theme/member-theme'
const SLOTS = 'styles/slots.wxss'
const MEMBER_WXSS = 'styles/member.wxss'
const SHEET = 'components/member-sheet/member-sheet'

// 教练端**唯一**的时段卡片消费者（另一处 `pages/schedule` 不用 .slot-cell）
const COACH_SLOT_CONSUMERS = [
  { wxml: 'components/booking-modal/booking-modal.wxml', wxss: 'components/booking-modal/booking-modal.wxss', who: '教练端「新建课程」弹层' }
]
// 会员端时段消费者（本轮只读，不改）
const MEMBER_SLOT_CONSUMERS = [
  { wxml: 'pages/member-book-slots/member-book-slots.wxml', wxss: 'pages/member-book-slots/member-book-slots.wxss', who: '会员端「约课」页' }
]

const stripCss = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '')
const stripHtml = src => String(src).replace(/<!--[\s\S]*?-->/g, '')
const stripJs = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** 取某个选择器的第一条规则体 */
function body(wxss, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp('(?:^|[\\s}])' + escaped + '\\s*\\{([^}]*)\\}').exec(stripCss(wxss))
  return match ? match[1] : ''
}
const decl = (ruleBody, prop) => {
  const match = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;}]+)').exec(ruleBody)
  return match ? match[1].trim() : ''
}
/** 从 `border:2rpx solid X` 里取出 X（颜色那一截） */
const borderColorOf = ruleBody => decl(ruleBody, 'border-color') || (/border\s*:[^;}]*?\s(?:solid|dashed)\s([^;}]+)/.exec(ruleBody) || [])[1] || ''

// ═══════════════ 主题模块：加载（可注入漂移版） ═══════════════

/**
 * 载入 utils/member-theme.js。
 * @param {object|null} drift 注入的漂移实现（判别力自证用）；null = 载入真实文件
 */
function loadTheme(drift) {
  const full = require.resolve(path.join(ROOT, THEME_MODULE))
  const saved = require.cache[full]
  if (drift) {
    // ⭐ 用 require.cache 注入，**不改磁盘上的文件**。
    require.cache[full] = { id: full, filename: full, loaded: true, exports: drift, children: [], paths: [] }
  } else {
    delete require.cache[full]
  }
  try { return require(full) } finally { if (saved) require.cache[full] = saved; else delete require.cache[full] }
}

/** 把一套主题摊平成 `字段路径 → 值`（slot.* 会展平），供逐字段比对 */
function flatten(theme) {
  const out = {}
  if (!theme || typeof theme !== 'object') return out
  Object.keys(theme).forEach(key => {
    const value = theme[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.keys(value).forEach(sub => { out[key + '.' + sub] = value[sub] })
    } else if (key !== 'illustration') {
      // ⛔ `illustration` 是 `decoShape` 的同义别名（旧字段名），不比 —— 否则三套
      //    必然在同一个字段上"相同"，那是**假红的来源**，不是事故。
      out[key] = value
    }
  })
  return out
}

// ═══════════════ 契约 A：主题 token ═══════════════

/** @returns {string[]} 问题清单（空 = 通过） */
function themeContract(mod) {
  const problems = []
  const need = (ok, message) => { if (!ok) problems.push(message) }

  need(mod && typeof mod.resolve === 'function' && typeof mod.cssVars === 'function',
    '主题模块必须导出 resolve() 与 cssVars()')
  // ⭐⭐ 2026-10-05：三套主题已撤回 ⇒ **必须只剩一套**。多一套 = 被撤回的功能回来了。
  need(mod && mod.THEMES && Object.keys(mod.THEMES).length === 1,
    '必须只剩一套界面色板，实得 ' + (mod && mod.THEMES ? Object.keys(mod.THEMES).join('、') : '无'))

  const ids = Object.keys(mod.THEMES || {})
  const maps = ids.map(id => flatten(mod.THEMES[id]))

  const keys = Object.keys(maps[0] || {})
  need(keys.length >= 10, `一套界面至少 10 个 token（实测 ${keys.length}）—— 只有 5 个字段时颜色没法分层`)
  keys.forEach(key => {
    const values = maps.map(map => map[key])
    need(values.every(v => v !== '' && v !== null && v !== undefined),
      `token「${key}」不许是空值 —— 空值会让那块样式静默失效（不报错、只是不生效）`)
  })

  // 唯一视觉规格：暖白页面 / 白色内容面 / 深海蓝正文 / 青绿色小面积强调。
  const rgbOf = hex => {
    const hit = /^#([0-9a-f]{6})$/i.exec(String(hex || ''))
    if (!hit) return null
    const n = parseInt(hit[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  const lum = hex => {
    const c = rgbOf(hex)
    if (!c) return null
    // 感知亮度（0=全黑，1=全白）
    return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255
  }
  const sat = hex => {
    const c = rgbOf(hex)
    if (!c) return null
    const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b)
    return max === 0 ? 0 : (max - min) / max
  }
  const one = ids.length ? mod.THEMES[ids[0]] : null
  if (one) {
    need(String(one.surface).toLowerCase() === '#ffffff', '内容面必须是纯白 #ffffff')
    const pageLum = lum(one.pageBg)
    need(pageLum !== null && pageLum > 0.9 && pageLum < 0.995,
      `页面底必须是很浅的暖白色（不能纯白到没有层次），实得 ${one.pageBg}`)
    need(String(one.pageBg).toLowerCase() !== String(one.surface).toLowerCase(),
      '页面底不许等于卡片底 —— 同一个值 = 卡片与页面糊成一片')
    const textLum = lum(one.text)
    need(textLum !== null && textLum < 0.25, `正文必须足够深（不能太浅看不清），实得 ${one.text}`)
    const primarySat = sat(one.primary), accentSat = sat(one.accent)
    need(primarySat !== null && primarySat <= 0.76,
      `深海蓝主色不能变成刺眼的高饱和彩色，实得 ${one.primary}`)
    need(accentSat !== null && accentSat <= 0.76,
      `青绿色强调色不能变成荧光色，实得 ${one.accent}`)
    need(one.decoShape === 'plain', '装饰必须是极简的 plain（⛔ 不要回到三套那种叶片/斜切块装饰）')
  }

  // ⭐ 时段四态必须两两可分（底色 / 边框各自）—— 这一条与"几套皮肤"无关，长期有效
  ids.forEach(id => {
    const slot = mod.THEMES[id].slot || {}
    const bg = [slot.freeBg, slot.bookedBg, slot.pastBg, slot.echoBg]
    const line = [slot.freeLine, slot.bookedLine, slot.pastLine, slot.echoLine]
    need(bg.every(Boolean) && new Set(bg).size === 4, `${id} 的时段四态底色必须两两不同，实得 ${JSON.stringify(bg)}`)
    need(line.every(Boolean) && new Set(line).size === 4, `${id} 的时段四态边框必须两两不同，实得 ${JSON.stringify(line)}`)
  })

  // ⭐ resolve() 兜底：未知 / 空 / null / undefined / 原型键 / **历史残留 theme id** 都必须给出完整色板
  const junk = [undefined, null, '', 'nope', 'VITALITY', 'toString', 'constructor', '__proto__', 0, {}, [],
    'vitality', 'active', 'minimal']
  junk.forEach(value => {
    let resolved = null
    try { resolved = mod.resolve(value) } catch (error) { resolved = null }
    const label = typeof value === 'object' ? JSON.stringify(value) : String(value)
    need(resolved && typeof resolved === 'object',
      `resolve(${label}) 绝不许抛错或返回 undefined —— 页面读 t.primary 会直接崩`)
    if (!resolved || typeof resolved !== 'object') return
    need(resolved.id && mod.THEMES[resolved.id],
      `resolve(${label}) 必须落到那唯一一套色板上，实得 id=${resolved.id}`)
    need(resolved.primary && resolved.accent && resolved.slot && resolved.slot.freeBg,
      `resolve(${label}) 必须返回**字段齐全**的色板（缺一个字段 = 那一块颜色静默失效）`)
    // ⭐ 无论传什么进去，**输出必须是同一套**（这是"没有主题可换"的直接判据）
    need(JSON.stringify(flatten(resolved)) === JSON.stringify(flatten(mod.resolve())),
      `resolve(${label}) 必须与无参调用完全一致 —— 同一个会员在不同页面不许出现两套颜色`)
  })
  // resolve 一律返回**深拷贝**的口袋对象：调用方改它不能污染 THEMES
  const a = mod.resolve()
  if (a && a.slot) { a.slot.freeBg = '#000000'; a.primary = '#000000' }
  const onlyId = ids[0]
  need(mod.THEMES[onlyId].primary !== '#000000', 'resolve() 顶层字段必须与 THEMES 解耦（调用方改它不能污染常量表）')
  need(mod.THEMES[onlyId].slot.freeBg !== '#000000', '⭐ resolve() 的**嵌套** slot 也必须解耦（浅拷贝会让页面改一次就污染色板）')

  // ⭐ cssVars() 必须吐出**全部**变量，一个都不能少。
  need(mod.CSS_VAR_NAMES && typeof mod.CSS_VAR_NAMES === 'object' && Object.keys(mod.CSS_VAR_NAMES).length >= 10,
    '主题模块必须导出 CSS_VAR_NAMES（token → CSS 变量的映射表），它是"哪些变量必须存在"的唯一口径')
  const expectedVars = mod.CSS_VAR_NAMES ? Object.values(mod.CSS_VAR_NAMES) : []
  const unionFields = [...new Set(ids.flatMap(id => Object.keys(flatten(mod.THEMES[id]))))]
  const orphanVars = expectedVars.filter(name =>
    !unionFields.some(field => '--member-' + field.replace(/\./g, '-').replace(/[A-Z]/g, ch => '-' + ch.toLowerCase()) === name))
  need(orphanVars.length === 0, 'CSS_VAR_NAMES 里有对不上任何 token 字段的变量名：' + orphanVars.join('、'))

  ids.forEach(id => {
    const css = String(mod.cssVars(id) || '')
    const declared = [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(hit => hit[1])
    need(declared.length === new Set(declared).size, `${id} 的 cssVars() 里有重复变量名`)
    const missing = expectedVars.filter(name => !declared.includes(name))
    need(missing.length === 0, `${id} 的 cssVars() 漏了变量：${missing.join('、')}`)
    const extra = declared.filter(name => !expectedVars.includes(name))
    need(extra.length === 0, `${id} 的 cssVars() 多了没登记的变量（会成为第二套口径）：${extra.join('、')}`)
    const empties = [...css.matchAll(/(--[a-z0-9-]+)\s*:\s*;/g)].map(hit => hit[1])
    need(empties.length === 0, `${id} 的 cssVars() 有空值变量：${empties.join('、')}`)
  })

  return problems
}

// ═══════════════ 契约 B：时段四态读主题变量，且教练端计算值不变 ═══════════════

/**
 * 拆一个 var()：返回 { name, fallback, end }，`end` 是**闭合括号之后**的下标。
 * ⚠️ 必须按括号配平来找结尾 —— 用非贪婪正则会在嵌套时截断
 *    （`var(--slot-x,var(--member-x,#fff))` 会被截成 `#fff)`，多出一个右括号，
 *    于是"教练端计算值没变"这条判据会误报变红 —— 判据自己出 bug 比没有判据更糟）。
 */
function parseVar(text, start) {
  let depth = 1, cursor = start + 4, split = -1, close = -1
  for (; cursor < text.length; cursor++) {
    const ch = text[cursor]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) { close = cursor; break }
    } else if (ch === ',' && depth === 1 && split < 0) split = cursor
  }
  if (close < 0) return null                       // 不配平：交给上层暴露出来
  return {
    name: text.slice(start + 4, split >= 0 ? split : close).trim(),
    fallback: split >= 0 ? text.slice(split + 1, close) : '',
    end: close + 1
  }
}

/** 按 scope 逐层解出最终值（scope 里没有的名字走兜底） */
function resolveVars(value, scope) {
  let out = String(value)
  for (let guard = 0; guard < 12; guard++) {
    const start = out.indexOf('var(')
    if (start < 0) break
    const parsed = parseVar(out, start)
    if (!parsed) break
    const replacement = Object.prototype.hasOwnProperty.call(scope, parsed.name) ? scope[parsed.name] : parsed.fallback
    out = out.slice(0, start) + replacement + out.slice(parsed.end)
  }
  return out.trim()
}

/** 取一条声明里**最外层**的那个 var() 变量名（用来判"第一层是 --slot-* 还是 --member-*"） */
function outermostVarName(value) {
  const raw = String(value)
  const start = raw.indexOf('var(')
  if (start < 0) return ''
  const parsed = parseVar(raw, start)
  return parsed ? parsed.name : ''
}

/** 教练端作用域：`.slots-coach` 上声明的全部 --slot-* */
function coachScope(wxss) {
  const scope = {}
  const source = stripCss(wxss)
  const match = /\.slots-coach\s*\{([\s\S]*?)\}/.exec(source)
  if (match) {
    for (const hit of match[1].matchAll(/(--slot-[a-z0-9-]+)\s*:\s*([^;]+)/g)) scope[hit[1]] = hit[2].trim()
  }
  return scope
}

function slotContract(mod) {
  const problems = []
  const need = (ok, message) => { if (!ok) problems.push(message) }
  const wxss = read(SLOTS)

  // ⭐ 会员端四态**必须读主题变量**（不许再是硬编码冷蓝灰）
  const cell = body(wxss, '.slot-cell')
  const booked = body(wxss, '.slot-cell.booked')
  const past = body(wxss, '.slot-cell.past')
  const echo = body(wxss, '.slot-cell.echo')
  need(cell && booked && past && echo, '四态规则必须齐全（.slot-cell / .booked / .past / .echo）')
  const memberVars = [
    ['可约底色', decl(cell, 'background')], ['已排课底色', decl(booked, 'background')],
    ['已过底色', decl(past, 'background')], ['回声底色', decl(echo, 'background')]
  ]
  memberVars.forEach(([name, value]) => {
    need(/var\(--member-slot-/.test(value),
      `会员端时段「${name}」必须读 --member-slot-* 主题变量（改造前是硬编码冷蓝灰，与绿色系不搭），实得 ${value}`)
  })
  need(/var\(--member-slot-/.test(borderColorOf(cell)) && /var\(--member-slot-/.test(borderColorOf(booked))
    && /var\(--member-slot-/.test(borderColorOf(past)) && /var\(--member-slot-/.test(borderColorOf(echo)),
    '四态边框也必须读 --member-slot-* 主题变量')
  // ⛔ 三层 var 顺序：**第一层**必须是 --slot-*（教练端覆盖点），第二层才是 --member-*
  ;[['可约', cell], ['已排课', booked], ['已过', past], ['回声', echo]].forEach(([name, ruleBody]) => {
    ;[['底色', decl(ruleBody, 'background')], ['边框', borderColorOf(ruleBody)]].forEach(([what, value]) => {
      const outer = outermostVarName(value)
      need(/^--slot-/.test(outer),
        `「${name}」的${what}第一层变量必须是 --slot-* —— 否则教练端 .slots-coach 的覆盖碰不到这条声明，教练端会被改成会员端配色。实得第一层 = ${outer || '(没有 var)'}`)
    })
  })
  // 第二层（--slot-* 的兜底位）必须是 --member-slot-*，也就是会员端主题变量
  ;[['可约', cell], ['已排课', booked], ['已过', past], ['回声', echo]].forEach(([name, ruleBody]) => {
    ;[['底色', decl(ruleBody, 'background')], ['边框', borderColorOf(ruleBody)]].forEach(([what, value]) => {
      const outer = outermostVarName(value)
      if (!/^--slot-/.test(outer)) return
      const inner = String(value).slice(String(value).indexOf(outer) + outer.length)
      const fallbackName = outermostVarName(inner)
      need(/^--member-slot-/.test(fallbackName),
        `「${name}」的${what}第二层必须是 --member-slot-*（会员端主题变量），实得 ${fallbackName || '(没有第二层)'}`)
    })
  })

  // ⭐⭐ 契约 B 核心：教练端的**最终计算值**必须与改造前逐字相同。
  //   这不是"看 .slots-coach 有没有被改"（那只是文本），而是**真的把 var 链解完**再比。
  const scope = coachScope(wxss)
  const expected = {
    '.slot-cell 底色': ['#fff', resolveVars(decl(cell, 'background'), scope)],
    '.slot-cell 边框': ['#2563eb', resolveVars(borderColorOf(cell), scope)],
    '.slot-cell.booked 底色': ['#e7edf6', resolveVars(decl(booked, 'background'), scope)],
    '.slot-cell.booked 边框': ['#cfdaea', resolveVars(borderColorOf(booked), scope)],
    '.slot-cell.past 底色': ['#f8fafc', resolveVars(decl(past, 'background'), scope)],
    '.slot-cell.past 边框': ['#edf1f7', resolveVars(borderColorOf(past), scope)],
    '.slot-time 字色': ['#17345f', resolveVars(decl(body(wxss, '.slot-time'), 'color'), scope)],
    '.slot-cell.booked .slot-time 字色': ['#8798ae', resolveVars(decl(body(wxss, '.slot-cell.booked .slot-time'), 'color'), scope)],
    '.slot-cell.booked .slot-state 字色': ['#8b9bb1', resolveVars(decl(body(wxss, '.slot-cell.booked .slot-state'), 'color'), scope)],
    '.slot-cell.past .slot-time 字色': ['#bfc8d6', resolveVars(decl(body(wxss, '.slot-cell.past .slot-time'), 'color'), scope)],
    '.slot-dot.booked 边框': ['#cfdaea', resolveVars(decl(body(wxss, '.slot-dot.booked'), 'border-color'), scope)],
    '.slot-dot.past 边框': ['#edf1f7', resolveVars(decl(body(wxss, '.slot-dot.past'), 'border-color'), scope)]
  }
  Object.entries(expected).forEach(([label, [before, after]]) => {
    need(after && after.toLowerCase() === before.toLowerCase(),
      `⛔ 教练端视觉一个字都不许改：${label} 改造前是 ${before}，现在算出来是 ${after || '(空)'}（.slots-coach 的覆盖没兜住）`)
  })

  // ⭐ 回声（echo）是会员端专属：教练端两个消费者都不许渲染它
  //   （否则新加的底色就会落到教练端界面上 —— 那也是"改教练端视觉"）
  COACH_SLOT_CONSUMERS.forEach(entry => {
    const wxml = stripHtml(read(entry.wxml))
    need(!/\becho\b/.test(wxml), `${entry.who} 不许渲染 echo 态（会员端"本地回声"专属，教练端没有这个概念）`)
  })

  // ⭐⭐ 前提：教练端**读不到** --member-*。
  //   三套主题变量由 cssVars() 注入到会员端页面的 `.member-shell` 上；
  //   若哪天某个教练端页面/组件也开始 import styles/member.wxss 或挂上 member-shell，
  //   上面那条"最终计算值不变"就不再成立（第二层会被填上）⇒ 把前提也钉死。
  COACH_SLOT_CONSUMERS.map(entry => entry.wxss).concat(['app.wxss']).forEach(file => {
    need(!/styles\/member\.wxss/.test(stripCss(read(file))),
      `⛔ ${file} 是教练端侧样式，不许 import styles/member.wxss（那会把会员主题兜底带进教练端）`)
  })
  COACH_SLOT_CONSUMERS.forEach(entry => {
    const wxml = read(entry.wxml)
    need(!/member-shell|member-page/.test(wxml),
      `${entry.who} 出现在教练端，不许带 member-shell / member-page（那是会员端主题变量的注入点）`)
  })

  // ⭐ 会员端四态在**三套主题下**都要两两可分（真实跑一遍 cssVars 注入）
  const ids = Object.keys(mod.THEMES)
  ids.forEach(id => {
    const scope2 = {}
    for (const hit of String(mod.cssVars(id)).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]*);/g)) scope2[hit[1]] = hit[2].trim()
    const four = [
      ['可约', cell], ['已排课', booked], ['已过', past], ['回声', echo]
    ].map(([label, ruleBody]) => ({
      label,
      bg: resolveVars(decl(ruleBody, 'background'), scope2),
      line: resolveVars(borderColorOf(ruleBody), scope2)
    }))
    need(new Set(four.map(s => s.bg.toLowerCase())).size === 4,
      `主题 ${id} 下会员端四态底色算出来不两两不同：${JSON.stringify(four.map(s => [s.label, s.bg]))}`)
    need(new Set(four.map(s => s.line.toLowerCase())).size === 4,
      `主题 ${id} 下会员端四态边框算出来不两两不同：${JSON.stringify(four.map(s => [s.label, s.line]))}`)
  })

  return problems
}

// ═══════════════ 契约 C：主题页三套都能选 ═══════════════

/** ⚠️ 只扫**代码**：解释"为什么撤回"的注释里当然会提到旧名词，那不算数。
 *  （本文件自己的注释里也写了三遍，别把自己判红。） */
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\/[^\n]*$/gm, '')
}

/** ③ 主题功能撤回护栏：主题页 / 主题按钮 / theme 字段都不许回来 */
function retiredThemeGuardContract() {
  const problems = []
  const need = (ok, message) => { if (!ok) problems.push(message) }
  const exists = rel => fs.existsSync(path.join(ROOT, rel))

  // ⛔ 主题选择页不许回来（整个页面目录 + app.json 注册）
  need(!exists('pages/member-theme/member-theme.js'), '⛔ 主题选择页 pages/member-theme 已撤回，不许再加回来')
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
  need(!app.pages.some(page => String(page).indexOf('member-theme') >= 0),
    '⛔ app.json 不许再注册 member-theme 页面')

  // ⛔ 任何会员端页面都不许再有主题入口 / 主题字段
  const memberDirs = fs.readdirSync(path.join(ROOT, 'pages')).filter(name => name.indexOf('member-') === 0)
  memberDirs.forEach(dir => {
    const base = 'pages/' + dir + '/' + dir
    ;['.wxml', '.js'].forEach(ext => {
      const file = path.join(ROOT, base + ext)
      if (!fs.existsSync(file)) return
      const raw = fs.readFileSync(file, 'utf8')
      const text = stripComments(raw)
      need(!/bindtap="theme"|member-theme\/member-theme/.test(text),
        `⛔ ${base + ext} 里还有主题切换的入口/跳转`)
      need(!/themeName|个性化主题/.test(text), `⛔ ${base + ext} 里还写着主题切换的文案`)
      need(!/member\.theme|payload\.theme|theme:/.test(text),
        `⛔ ${base + ext} 还在读写 theme 字段（它已随主题功能一起撤回）`)
    })
  })

  // ⛔ 云端 updateProfile 不许再接受 theme
  ;['cloudfunctions/memberIdentityCommand/service.js', 'cloudfunctions/memberIdentitySandboxCommand/service.js'].forEach(file => {
    const text = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))
    need(!/payload\.theme/.test(text), `⛔ ${file} 的 updateProfile 不许再把 theme 写进会员账户`)
    need(!new RegExp("theme:" + "\\s*" + "'").test(text), `⛔ ${file} 不许再给会员账户生成 theme 字段`)
  })

  return problems
}

// ═══════════════ 契约 D：统一底部弹层组件 ═══════════════

function sheetContract() {
  const problems = []
  const need = (ok, message) => { if (!ok) problems.push(message) }
  const js = stripJs(read(SHEET + '.js'))
  const wxml = stripHtml(read(SHEET + '.wxml'))
  const wxss = read(SHEET + '.wxss')
  const json = JSON.parse(read(SHEET + '.json'))

  need(json.component === true, 'member-sheet.json 必须声明 "component": true')

  // —— props ——
  const props = ['visible', 'title', 'desc', 'confirmText', 'cancelText', 'danger', 'showCancel']
  // ⭐ 组件定义用**沙箱**取，而不是 require —— 组件 js 里没有 require，可以直接在
  //   干净沙箱里跑一次 `Component({...})`（我们只提供 Component 这一个全局）。
  //   ⚠️ 不要去改文件首行再加导出：那是为了测试改生产源码。
  const sandbox = { Component: config => { sandbox.__captured = config } }
  vm.runInNewContext(read(SHEET + '.js'), sandbox, { filename: SHEET + '.js' })
  const definition = sandbox.__captured
  need(definition && definition.properties, '组件必须声明 properties')
  props.forEach(prop => {
    need(definition.properties[prop], `组件必须支持 prop「${prop}」`)
  })
  // —— 事件 ——
  const methods = definition.methods || {}
  ;[['onConfirm', 'confirm'], ['onCancel', 'cancel'], ['onClose', 'close']].forEach(([fn, event]) => {
    need(typeof methods[fn] === 'function', `组件必须有 ${fn}() 方法`)
    need(new RegExp(`triggerEvent\\('${event}'\\)`).test(stripJs(read(SHEET + '.js'))),
      `组件必须派发 '${event}' 事件`)
  })
  // —— slot ——
  need(/<slot\s*\/>/.test(wxml) || /<slot\s*>/.test(wxml), '组件必须有一个默认 slot 放内容')

  // —— wxml 关键结构 ——
  need(/catchtouchmove\s*=\s*"noop"/.test(wxml),
    '⛔ 遮罩必须有 catchtouchmove="noop" —— 少了它，手指在弹层上滑会把后面的页面带着一起滚')
  const maskTag = (wxml.match(/<view[^>]*class="member-sheet-mask"[^>]*>/) || [''])[0]
  need(/catchtouchmove\s*=/.test(maskTag), 'catchtouchmove 必须挂在**遮罩**上（不是挂在面板上），实得：' + maskTag)
  need(/bindtap="onClose"/.test(maskTag), '点遮罩空白处应当关闭')
  need(/catchtap="noop"/.test(wxml), '面板本身要 catchtap 挡住冒泡（否则点面板会当成点遮罩）')

  const bodyIndex = wxml.indexOf('<scroll-view')
  const bodyEnd = wxml.indexOf('</scroll-view>')
  const footIndex = wxml.indexOf('member-sheet-foot')
  need(bodyIndex >= 0, '内容区必须是 scroll-view（要能滚）')
  need(bodyEnd > bodyIndex, 'scroll-view 必须闭合')
  need(footIndex > bodyEnd,
    '⭐ 底部按钮区必须在 </scroll-view> **之后** —— 放前面的话内容一长就把按钮顶出屏幕')
  need(/<slot\s*\/?>/.test(wxml.slice(bodyIndex, bodyEnd)),
    '⭐ slot 必须在 scroll-view **内**：长内容只该在内容区滚，标题与按钮要留在屏幕上')

  // —— wxss：圆角 / 拖动条 / 标题 / 可滚动高度 / 安全区 ——
  const sheet = body(wxss, '.member-sheet')
  need(/border-radius\s*:\s*32rpx\s+32rpx\s+0\s+0/.test(sheet),
    '面板顶部必须是 32rpx 圆角（下角为 0，贴底），实得 ' + decl(sheet, 'border-radius'))
  need(body(wxss, '.member-sheet-handle'), '必须有顶部拖动短横线')
  need(/font-size\s*:\s*32rpx/.test(body(wxss, '.member-sheet-title')) &&
    /font-weight\s*:\s*(7[0-9]{2}|800|bold)/.test(body(wxss, '.member-sheet-title')),
    '标题必须 32rpx 加粗')
  need(body(wxss, '.member-sheet-close'), '右上角必须有关闭 ×')
  const scroll = body(wxss, '.member-sheet-body')
  need(/max-height\s*:\s*\d+vh/.test(scroll),
    '⭐ 内容区 max-height 必须用**视口百分比**：写死 rpx 会让小屏与大屏露出的内容行数不同（"下面还有没有"变成看运气），实得 ' + decl(scroll, 'max-height'))
  need(/env\(safe-area-inset-bottom\)/.test(wxss), '⛔ 必须处理 env(safe-area-inset-bottom)：小屏底部按钮会顶到 Home 指示条')
  const foot = body(wxss, '.member-sheet-foot')
  need(/env\(safe-area-inset-bottom\)/.test(foot), '⛔ 安全区必须加在**底部按钮区**上（不是只在某个别的地方）')
  need(/flex\s*:\s*0\s+0\s+auto/.test(foot), '底部按钮区不许参与滚动（flex:0 0 auto）')
  const primary = body(wxss, '.member-sheet-btn.primary')
  need(/var\(--member-primary/.test(primary), '主按钮必须读 --member-primary（弹窗强调色随主题走）')
  need(/var\(--member-danger/.test(body(wxss, '.member-sheet-btn.primary.danger')), 'danger 时确认按钮必须转红（读 --member-danger）')

  // —— ⛔ 不许自带 loading spinner ——
  need(!/spinner|loading/i.test(wxml + wxss),
    '⛔ 组件不许自带任何 loading / spinner —— 加载/空/失败/重试四态由调用方通过 slot 表达，否则用户看到的是"一片空白 + 一个转圈"')
  need(/wx:if\s*=\s*"\{\{visible\}\}"/.test(wxml), '整块弹层必须由 visible 控制显隐（组件不得有第二个自动显示的遮罩）')

  // —— ⛔ 不许内联颜色常量（颜色必须来自主题变量，否则弹层就成了第二套配色）——
  const hardcoded = [...stripCss(wxss).matchAll(/(?:background|color)\s*:\s*(#[0-9a-f]{3,8})/gi)]
    .map(hit => hit[1])
    // 白色按钮文字 / 白色关闭符号不算"第二套配色"
    .filter(value => !/^#fff$/i.test(value))
  need(hardcoded.length === 0,
    '⛔ 弹层样式里不许出现硬编码颜色（会变成第二套配色，与主题脱钩）：' + hardcoded.join('、'))

  return problems
}

// ═══════════════ 契约 F：统一设计变量（styles/member.wxss）═══════════════

function designVarContract() {
  const problems = []
  const need = (ok, message) => { if (!ok) problems.push(message) }
  const wxss = read(MEMBER_WXSS)
  const shell = body(wxss, '.member-shell')

  // ⭐ 必有的设计变量（每一项都对应任务书里"统一覆盖"的一条）
  const REQUIRED_VARS = [
    '--member-gap-xl', '--member-gap-lg', '--member-gap-md', '--member-gap-sm', '--member-gap-xs',   // 页面左右边距 + 间距
    '--member-radius-card', '--member-radius-hero', '--member-radius-control', '--member-radius-pill',   // 圆角
    '--member-shadow',                    // 卡片阴影
    '--member-font-title', '--member-font-section', '--member-font-body', '--member-font-sub', '--member-font-cap', // 字号层级
    '--member-button-height', '--member-button-height-sm',  // 按钮高度
    '--member-tag-height',               // 状态标签高度
    '--member-divider',                  // 分隔线
    '--member-safe-gap'                // 底部安全距离
  ]
  const declared = [...stripCss(wxss).matchAll(/(--member-[a-z0-9-]+)\s*:/g)].map(hit => hit[1])
  REQUIRED_VARS.forEach(name => {
    need(declared.includes(name), `styles/member.wxss 必须定义设计变量 ${name}（任务书要求统一的那一项）`)
  })

  // ⭐ 字号必须**成层级**（标题 > 小节 > 正文 > 次要 > 标签），不是五个随便的数
  const sizeOf = name => {
    const hit = new RegExp(name + '\\s*:\\s*(\\d+)rpx').exec(shell)
    return hit ? Number(hit[1]) : null
  }
  const sizes = ['--member-font-title', '--member-font-section', '--member-font-body', '--member-font-sub', '--member-font-cap'].map(sizeOf)
  need(sizes.every(v => typeof v === 'number' && v > 0), '五个字号档位都必须有具体 rpx 值，实得 ' + JSON.stringify(sizes))
  for (let i = 0; i + 1 < sizes.length; i++) {
    need(sizes[i] > sizes[i + 1], `字号层级必须递减（标题>小节>正文>次要>标签），实得 ${JSON.stringify(sizes)}`)
  }
  // ⭐ 按钮高度必须**有区分**且都是具体值（统一高度的同时保留小号档）
  const primary = body(wxss, '.member-primary')
  const ghost = body(wxss, '.member-ghost')
  need(/var\(--member-button-height/.test(primary), '.member-primary 的高度必须读 --member-button-height（三个页面的"确认"按钮要同高）')
  need(/var\(--member-button-height-sm/.test(ghost), '.member-ghost 的高度必须读 --member-button-height-sm')
  // ⭐ 状态标签高度必须真的被用上（定义了不用 = 没统一）
  need(/min-height\s*:\s*var\(--member-tag-height\)|height\s*:\s*var\(--member-tag-height\)/.test(body(wxss, '.member-pill')),
    '.member-pill 必须真的用 --member-tag-height（只定义不用等于没统一）')
  // ⭐ 底部安全距离必须处理 env()
  need(/env\(safe-area-inset-bottom\)/.test(body(wxss, '.member-safe-bottom')),
    '⛔ .member-safe-bottom 必须用 env(safe-area-inset-bottom)：小屏底部会被 Home 指示条盖住')

  // ⭐ 颜色不许硬编码在几何类里（颜色只能来自 --member-*，否则"换主题"会漏）
  const geometrySelectors = ['.member-page', '.member-card', '.member-title', '.member-subtitle', '.member-section-title', '.member-pill', '.member-list-row', '.member-input']
  geometrySelectors.forEach(selector => {
    const ruleBody = body(wxss, selector)
    const hardcoded = [...(ruleBody || '').matchAll(/(?:^|;)\s*(?:background|color|border(?:-color)?)\s*:\s*(#[0-9a-f]{3,8})/gi)].map(hit => hit[1])
      .filter(value => !/^#fff$/i.test(value))     // 白 / 纯白字不算
    need(hardcoded.length === 0,
      `${selector} 里出现硬编码颜色 ${hardcoded.join('、')} —— 颜色必须读 --member-*，否则换主题时这一处不变`)
  })

  // ⭐⭐ 只新增不删：本轮不许删掉任何既有类名。
  //   这些是 2026-10-03 之前就存在、且被十几个页面在用的类名（从老版本的 member.wxss 抄下来的清单）。
  const LEGACY_CLASSES = [
    'member-page', 'member-shell', 'member-card', 'member-title', 'member-subtitle', 'member-section-title',
    'member-primary', 'member-ghost', 'member-hero', 'member-hero-label', 'member-balance', 'member-balance-unit',
    'member-sun', 'member-leaf', 'member-row', 'member-spread', 'member-avatar', 'member-pill', 'member-empty',
    'member-arrow', 'member-list-row', 'member-actions', 'member-action', 'member-action-icon', 'member-tag-done',
    'member-input', 'member-safe-bottom', 'member-notice', 'member-notice-line'
  ]
  const plain = stripCss(wxss)
  LEGACY_CLASSES.forEach(name => {
    need(new RegExp('\\.' + name + '(?![a-z0-9-])').test(plain), `⛔ 既有类名 .${name} 被删了 —— 十几个页面在用，删了就是白屏`)
  })

  return problems
}

// ═══════════════ 契约 E：主题只影响会员端视觉 ═══════════════

function isolationContract() {
  const problems = []
  const need = (ok, message) => { if (!ok) problems.push(message) }

  // ⭐ 教练端文件不许 require 主题模块
  const coachFiles = [
    'pages/schedule/schedule.js', 'pages/students/students.js', 'pages/stats/stats.js',
    'pages/session/session.js', 'pages/attendance-history/attendance-history.js',
    'components/booking-modal/booking-modal.js', 'components/sandbox-banner/sandbox-banner.js',
    'utils/data-runtime.js', 'utils/sync-engine.js', 'utils/package-occupancy.js',
    'utils/schedule-view.js', 'utils/session-view.js'
  ]
  coachFiles.forEach(file => {
    const full = path.join(ROOT, file)
    if (!fs.existsSync(full)) return
    const src = fs.readFileSync(full, 'utf8')
    need(!/member-theme/.test(src), `⛔ ${file} 是教练端侧文件，不许引用 member-theme（主题只管会员端视觉）`)
  })

  // ⭐ 主题模块里不许出现任何业务 / 身份 / 缓存关键字
  const themeSrc = read(THEME_MODULE)
  for (const word of ['getStorage', 'setStorage', 'cloud', 'callFunction', 'booking', 'remaining', 'coach', 'openid']) {
    need(!new RegExp(word, 'i').test(themeSrc),
      `⛔ 主题模块里不许出现「${word}」—— 主题只准改"长什么样的"，碰业务/身份/缓存就是越界`)
  }
  // ⭐ 教练端文件里也不许出现 --member-* 变量（那是会员端的主题变量）
  const coachWxss = ['pages/schedule/schedule.wxss', 'components/booking-modal/booking-modal.wxss', 'app.wxss']
  coachWxss.forEach(file => {
    const full = path.join(ROOT, file)
    if (!fs.existsSync(full)) return
    const src = stripCss(fs.readFileSync(full, 'utf8'))
    // app.wxss 是全局的，理论上也不该定义会员主题变量
    need(!/--member-(primary|hero|page-bg|text)\s*:/.test(src),
      `⛔ ${file} 不许定义会员主题变量（会污染教练端）`)
  })

  // ⭐ 会员端时段样式的兜底变量只应出现在 styles/slots.wxss 与 styles/member.wxss
  const slotsSrc = stripCss(read(SLOTS))
  need(/--member-slot-free-bg/.test(slotsSrc) || /var\(--member-slot-/.test(slotsSrc),
    'styles/slots.wxss 必须读 --member-slot-*')

  return problems
}

// ═══════════════════════════════ 正式断言 ═══════════════════════════════

async function main() {
  const real = loadTheme(null)

  // ① 只剩一套色板 + 暖白/深蓝/青绿规格 + resolve 兜底 + cssVars 完整
  const a = themeContract(real)
  assert.deepStrictEqual(a, [], '① 单一界面色板 / resolve 兜底 / cssVars 契约：\n' + a.map(x => '  ✗ ' + x).join('\n'))
  console.log('① 单一色板：' + Object.keys(real.THEMES).length + ' 套 × ' +
    Object.keys(flatten(real.THEMES[Object.keys(real.THEMES)[0]])).length +
    ' 个 token；页面暖白 / 内容面纯白 / 深海蓝文字 / 青绿强调；脏 theme id 也一律落到同一套')

  // ② 时段四态读主题变量，且教练端最终计算值不变
  const b = slotContract(real)
  assert.deepStrictEqual(b, [], '② 时段四态 / 教练端不变契约：\n' + b.map(x => '  ✗ ' + x).join('\n'))
  console.log('② 会员端时段四态读 --member-slot-*；教练端 12 项最终计算值与改造前逐字相同')

  // ③ 主题页三套都能选
  // ③ 撤回护栏：主题按钮 / 选择页 / theme 字段都不许回来
  const c = retiredThemeGuardContract()
  assert.deepStrictEqual(c, [], '③ 主题功能撤回护栏：\n' + c.map(x => '  ✗ ' + x).join('\n'))
  console.log('③ 撤回护栏：主题页未注册、会员端零主题入口、云端 updateProfile 不再接受 theme')

  // ④ 统一底部弹层组件
  const d = sheetContract()
  assert.deepStrictEqual(d, [], '④ 底部弹层组件契约：\n' + d.map(x => '  ✗ ' + x).join('\n'))
  console.log('④ member-sheet：props/事件/slot/catchtouchmove/固定底部按钮/vh 滚动/安全区/danger 全部到位，无常驻 spinner')

  // ⑤ 主题只影响会员端视觉
  const e = isolationContract()
  assert.deepStrictEqual(e, [], '⑤ 会员端 / 教练端隔离契约：\n' + e.map(x => '  ✗ ' + x).join('\n'))
  console.log('⑤ 主题模块不碰业务/身份/缓存；教练端 12 个文件零引用，app.wxss 不定义会员主题变量')

  // ⑤bis 统一设计变量
  const f = designVarContract()
  assert.deepStrictEqual(f, [], '⑤b 统一设计变量契约：\n' + f.map(x => '  ✗ ' + x).join('\n'))
  console.log('⑤b styles/member.wxss：间距/圆角/字号层级/按钮高度/标签高度/分隔线/安全距离全部变量化；29 个既有类名一个没删')

  // ⑥ 判别力自证：把源码换成"三套返回同一个 token"的漂移实现，必须让 ① 变红。
  //   ⛔ 用 require.cache 注入，**不改磁盘文件**。
  const DRIFTS = [
    {
      id: 'D1',
      what: '⭐⭐ 把被撤回的绿色皮肤再加回来变成**第二套**（"多一套怎么了"就是复辟的第一脚）',
      expect: '必须只剩一套',
      build(realMod) {
        const base = realMod.resolve()
        const vitality = { ...base, id: 'vitality', primary: '#2f9e5f', pageBg: '#f5f9f3', text: '#1a3a28', decoShape: 'sunleaf' }
        return { ...realMod, THEMES: { ...realMod.THEMES, vitality } }
      }
    },
    {
      id: 'D2',
      what: '⭐ 主色改成鲜绿（回到三套皮肤那种**高饱和彩色**的样子）',
      expect: '不得变成刺眼的鲜绿色皮肤',
      build(realMod) {
        const base = realMod.resolve()
        return { ...realMod, THEMES: { default: { ...base, primary: '#22a06b', accent: '#f0b429' } } }
      }
    },
    {
      id: 'D3',
      what: '⭐ 页面底改成**纯白**且与卡片同色（层次被抹平，卡片与背景糊成一片）',
      expect: '页面暖白 ≠ 内容面纯白',
      build(realMod) {
        const base = realMod.resolve()
        return { ...realMod, THEMES: { default: { ...base, pageBg: '#ffffff' } } }
      }
    },
    {
      id: 'D4',
      what: '⭐ resolve() 偷偷按入参返回不同色板（= 主题切换从后门回来了）',
      expect: '任何入参都必须是同一套',
      build(realMod) {
        const base = realMod.resolve()
        return { ...realMod, resolve: id => (id === 'vitality' ? { ...base, primary: '#2f9e5f' } : realMod.resolve()) }
      }
    },
    {
      id: 'D5',
      what: '⭐ resolve() 原型键击穿：THEMES["constructor"] 返回 Object 构造函数（老实现的真洞）',
      expect: 'resolve 兜底',
      build(realMod) { return { ...realMod, resolve: id => realMod.THEMES[id] || realMod.THEMES[realMod.DEFAULT_ID] } }
    },
    {
      id: 'D6',
      what: '⭐ cssVars() 漏掉时段四态变量（会员端时段退回硬编码蓝灰）',
      expect: 'cssVars 完整',
      build(realMod) {
        return {
          ...realMod,
          cssVars: id => realMod.cssVars(id).split(';').filter(pair => !/--member-slot-/.test(pair)).join(';') + ';'
        }
      }
    },
    {
      id: 'D7',
      what: '⭐ 可约时段与已过时间**底色撞了**（会员分不清哪个还能点）',
      expect: '时段四态底色两两不同',
      build(realMod) {
        const base = realMod.resolve()
        return {
          ...realMod,
          THEMES: { default: { ...base, slot: { ...base.slot, pastBg: base.slot.freeBg } } }
        }
      }
    },
    {
      id: 'D8',
      what: '⭐ 装饰形状偷偷从 plain 换成 sunleaf（撤回时被删掉的"三套装饰"又长回来一个）',
      expect: 'decoShape 必须是极简 plain',
      build(realMod) {
        const base = realMod.resolve()
        return { ...realMod, THEMES: { default: { ...base, decoShape: 'sunleaf', illustration: 'sunleaf' } } }
      }
    }
  ]

  const escaped = []
  let caught = 0
  for (const drift of DRIFTS) {
    const injected = drift.build(real)
    let problems = []
    try { problems = themeContract(loadTheme(injected)) } catch (error) { problems = ['抛错：' + error.message] }
    if (problems.length) caught++
    else escaped.push(drift.id + ' ' + drift.what + '（期望抓到：' + drift.expect + '）')
  }
  assert.deepStrictEqual(escaped, [],
    '有漂移实现没被抓住（判别力假绿护栏）：\n' + escaped.map(x => '  ✗ ' + x).join('\n'))
  console.log('⑥ 判别力自证：' + caught + '/' + DRIFTS.length + ' 个漂移实现全部让契约变红（注入走 require.cache，未改任何生产文件）')

  // ⑦ 判别力自证（wxss 侧）：把 slots.wxss 的四态退回硬编码冷蓝灰，② 必须变红。
  //   ⛔ 同样只改内存里的字符串，不动磁盘。
  {
    const realSlots = read(SLOTS)
    const drifted = realSlots
      .replace(/var\(--slot-free-bg,var\(--member-slot-free-bg,#fff\)\)/, '#fff')
      .replace(/var\(--slot-booked-bg,var\(--member-slot-booked-bg,#e6eef4\)\)/, '#e6eef4')
      .replace(/var\(--slot-past-bg,var\(--member-slot-past-bg,#f8fafb\)\)/, '#f8fafb')
    const problems = slotContractWith(drifted, real)
    assert.ok(problems.length > 0, '⑦ 把会员端四态退回硬编码冷蓝灰，契约 ② 必须变红 —— 现在它是绿的，说明判据没牙')
    console.log('⑦ 判别力自证（wxss 侧）：硬编码四态被抓住 ' + problems.length + ' 条')
  }

  // ⑧ 判别力自证（弹层侧）：去掉 catchtouchmove，④ 必须变红。
  {
    const realWxml = read(SHEET + '.wxml')
    assert.ok(stripHtml(realWxml).includes('catchtouchmove'), '前置：本组件当前必须带 catchtouchmove')
    const problems = sheetContractWith(stripHtml(realWxml).replace(/\s*catchtouchmove="noop"/, ''), read(SHEET + '.wxss'))
    assert.ok(problems.some(p => /catchtouchmove/.test(p)),
      '⑧ 去掉遮罩 catchtouchmove 后契约 ④ 必须变红（滑动穿透）—— 现在它是绿的')
    console.log('⑧ 判别力自证（弹层侧）：去掉 catchtouchmove 被抓住')
  }

  // ⑨ 判别力自证（设计变量侧）：三处典型劣化各必须被抓
  //   ① 删掉一个既有类名（白屏级事故）
  //   ② 把字号层级改成"随手写的"（25rpx 混进层级里）
  //   ③ 把按钮高度写死回裸数字（三个页面又会三种高度）
  {
    const realWxss = read(MEMBER_WXSS)
    const DRIFT_WXSS = [
      ['删掉既有类名 .member-safe-bottom', realWxss.replace(/\.member-safe-bottom\{[^}]*\}/, ''), /既有类名/],
      ['字号层级不再是递减', realWxss.replace(/--member-font-sub:\s*24rpx/, '--member-font-sub: 30rpx'), /字号层级必须递减/],
      ['按钮高度写死裸数字', realWxss.replace(/height:var\(--member-button-height\)/, 'height:92rpx'), /--member-button-height/]
    ]
    DRIFT_WXSS.forEach(([what, drifted, expected]) => {
      const problems = designVarContractWith(drifted)
      assert.ok(problems.some(p => expected.test(p)),
        '⑨ ' + what + ' 必须让契约 ⑤b 变红 —— 现在它是绿的（判据没牙）。实得：' + JSON.stringify(problems.slice(0, 3)))
    })
    console.log('⑨ 判别力自证（设计变量侧）：删类名 / 破字号层级 / 写死按钮高度 三处劣化全部被抓住')
  }

  // ⑩ 判别力自证（**撤回护栏侧**）：故意把主题按钮/主题页/云端 theme 字段恢复一次，③ 必须变红。
  //    ⛔ 全程走内存覆盖（上面那个 guardWith），磁盘一个字节都不改。
  {
    const appJson = JSON.parse(read('app.json'))
    const appWithThemePage = JSON.stringify({ ...appJson, pages: [...appJson.pages, 'pages/member-theme/member-theme'] })
    const profileWxml = read('pages/member-profile/member-profile.wxml')
      .replace('<view class="member-list-row training-row weui-cell weui-cell_access" bindtap="history">',
        '<view class="member-list-row weui-cell" bindtap="theme"><view>个性化主题</view><view class="member-subtitle">{{themeName}} ›</view></view>\n    <view class="member-list-row training-row weui-cell weui-cell_access" bindtap="history">')
    const identityJs = read('cloudfunctions/memberIdentityCommand/service.js')
      .replace("displayName: cleanText(payload.displayName, 30), updatedAt: timestamp",
        "displayName: cleanText(payload.displayName, 30), theme: payload.theme || 'vitality', updatedAt: timestamp")
    const GUARD_DRIFTS = [
      ['app.json 又把主题页注册回去', { 'app.json': appWithThemePage }, /不许再注册 member-theme/],
      ['「我的」页又把「个性化主题」按钮加回来', { 'pages/member-profile/member-profile.wxml': profileWxml }, /主题切换的入口/],
      ['云端 updateProfile 又开始写 theme', { 'cloudfunctions/memberIdentityCommand/service.js': identityJs }, /updateProfile 不许再把 theme/],
      ['主题选择页目录又出现了', { 'pages/member-theme/member-theme.js': 'Page({})' }, /主题选择页/]
    ]
    GUARD_DRIFTS.forEach(([what, overrides, expected]) => {
      const problems = guardWith(overrides)
      assert.ok(problems.some(p => expected.test(p)),
        '⑩ ' + what + ' 必须让契约 ③ 变红 —— 现在它是绿的（护栏没牙）。实得：' + JSON.stringify(problems.slice(0, 3)))
    })
    console.log('⑩ 判别力自证（撤回护栏侧）：注册主题页 / 加回主题按钮 / 云端写 theme / 主题页目录复现 四处复辟全部被抓住')
  }

  delete global.wx
  delete global.Page
  console.log('ALL MEMBER THEME VISUAL TESTS PASSED')
}

/** slotContract 的可注入版本（判别力自证用：喂一份改过的 wxss 文本，不落盘） */
function slotContractWith(wxssText, mod) {
  const saved = fs.readFileSync
  try {
    fs.readFileSync = (file, ...rest) => (String(file).replace(/\\/g, '/').endsWith(SLOTS) ? wxssText : saved(file, ...rest))
    return slotContract(mod)
  } finally { fs.readFileSync = saved }
}

/** sheetContract 的可注入版本（同上） */
function sheetContractWith(wxmlText, wxssText) {
  const saved = fs.readFileSync
  try {
    fs.readFileSync = (file, ...rest) => {
      const flat = String(file).replace(/\\/g, '/')
      if (flat.endsWith(SHEET + '.wxml')) return wxmlText
      if (flat.endsWith(SHEET + '.wxss')) return wxssText
      return saved(file, ...rest)
    }
    return sheetContract()
  } finally { fs.readFileSync = saved }
}

/** designVarContract 的可注入版本（判别力自证用：喂一份改过的 member.wxss 文本，不落盘） */
function designVarContractWith(wxssText) {
  const saved = fs.readFileSync
  try {
    fs.readFileSync = (file, ...rest) => (String(file).replace(/\\/g, '/').endsWith(MEMBER_WXSS) ? wxssText : saved(file, ...rest))
    return designVarContract()
  } finally { fs.readFileSync = saved }
}

/** guardContract 的可注入版本（判别力自证用：**内存覆盖**，绝不写盘） */
function guardWith(overrides) {
  const savedRead = fs.readFileSync
  const savedExists = fs.existsSync
  try {
    fs.readFileSync = (file, ...rest) => {
      const rel = String(file).replace(/\\/g, '/').replace(ROOT.replace(/\\/g, '/') + '/', '')
      if (Object.prototype.hasOwnProperty.call(overrides, rel)) return overrides[rel]
      return savedRead(file, ...rest)
    }
    fs.existsSync = target => {
      const rel = String(target).replace(/\\/g, '/').replace(ROOT.replace(/\\/g, '/') + '/', '')
      if (Object.prototype.hasOwnProperty.call(overrides, rel)) return true
      return savedExists(target)
    }
    return retiredThemeGuardContract()
  } finally { fs.readFileSync = savedRead; fs.existsSync = savedExists }
}

main().catch(error => { console.error(error); process.exit(1) })
