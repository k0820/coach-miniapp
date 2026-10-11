// 三态时段小卡片的**唯一来源 + 唯一状态名**契约。
//
// 背景：会员端「约课」页有一套三态时段小卡片（可约 / 已排课 / 已过时间）。
// 本轮 UI 整理把**同一张卡片**复用到教练端「新建课程」弹层里的「选时段」，
// 两边共用一份样式 `styles/slots.wxss`，只有配色不同（教练端在容器上加 `.slots-coach`）。
//
// 为什么必须钉死：
//   一旦某个消费者文件里自己又写一遍 `.slot-cell{...}`，就会出现"两套卡片"——
//   改了一边忘了另一边，会员端和教练端会长得不一样，而且**不会报错**。这正是本项目
//   踩过的坑（同一枚胶囊/同一张卡片出现第二个来源），所以要在静态层拦住。
//
// ⭐⭐ 2026-10-03 修复了一个**真实缺陷**，本文件因此加了 ⑩⑪⑫⑬ 四条判据：
//   唯一判定口径 `utils/package-occupancy.js` 的 `slotStateOf()` 返回 `'booked'`，
//   而唯一样式来源 `styles/slots.wxss` 定义的却是 `.slot-cell.busy`。
//   会员端 wxml 靠额外补的 `{{item.available?'':'busy'}}` 才侥幸有灰底；
//   教练端弹层只写 `{{s.reason}}` ⇒ 渲染成 `slot-cell booked` ⇒ **一条规则都没命中**
//   ⇒ 「已排课」格与「可约」格长得**一模一样**（真实数据里那几天 booked 格恰好为 0，
//   所以人眼一直没发现）。
//   ⇒ 现在的纪律：**状态类名 = 状态名**，且**只能**由数据驱动（不许页面本地补丁），
//     三态必须在「底色 / 边框 / 时间字色 / 状态字色」四个维度上两两可分。
//
// ⛔ 本文件只读文本 + 真跑纯函数，不渲染、不写数据。
// ⭐ 两处生产 wxss 的注释里都点名引用了本文件；本文件同时内联了判别力自证
//    （14 个内存变异必须全部被抓住），这样 `_run-all.ps1` 每次都会真的验一遍它的牙齿。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const contract = require('./helpers/ui-round5-contract')

const PROJ = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(PROJ, p), 'utf8')

const SOURCE_FILE = 'styles/slots.wxss'
// 「同一张卡片」的两个消费者（都 @import slots.wxss，都不许重定义卡片类）
const CONSUMERS = [
  { file: 'pages/member-book-slots/member-book-slots.wxss', wxml: 'pages/member-book-slots/member-book-slots.wxml', who: '会员端约课页' },
  { file: 'components/booking-modal/booking-modal.wxss', wxml: 'components/booking-modal/booking-modal.wxml', who: '教练端新建课程弹层' }
]
// ⭐ 状态口径的纪律对象：改期面板是**第二个渲染器**（有自己尺寸的 .reschedule-cell，不 import slots.wxss），
//    但它的**状态名与文案来源必须与约课页完全相同** —— 所以它要过 ⑫（不许本地补丁），不必过 ②（同一份样式）。
const STATE_CONSUMERS = CONSUMERS.concat([
  { file: 'pages/member-bookings/member-bookings.wxss', wxml: 'pages/member-bookings/member-bookings.wxml', who: '会员端改期面板' }
])

// 卡片本体的类名（**不含** .slot-day / .slot-date / .slot-box 这些容器与日期条）
const CARD_CLASSES = ['slot-legend', 'slot-legend-item', 'slot-legend-note', 'slot-dot', 'slot-grid', 'slot-cell', 'slot-time', 'slot-state']
// ⛔ 状态类名 = 状态名（`booked` / `past`）；`echo` 是**叠加标记**（本地回声），不是第四种状态。
const STATE_CLASSES = ['slot-cell.booked', 'slot-cell.past', 'slot-cell.echo', 'slot-dot.booked', 'slot-dot.past']

/** 某个类名在文件里**被定义**过（剥注释） */
const definedIn = (wxss, cls) => contract.ruleBodies(contract.stripCss(wxss), '.' + cls).length > 0
/** 取第一条命中规则体 */
const firstBody = (wxss, cls) => (contract.ruleBodies(contract.stripCss(wxss), '.' + cls)[0] || '')
const decl = (body, prop) => {
  const match = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;}]+)').exec(body)
  return match ? match[1].trim() : ''
}
/** 扁平规则的精确取体（`.slot-cell.booked .slot-time{...}` 这种带后代的选择器 ruleBodies 不保证支持） */
const exactBody = (wxss, selector) => {
  const text = contract.stripCss(wxss)
  const at = text.indexOf(selector + '{')
  if (at < 0) return ''
  return text.slice(at + selector.length + 1, text.indexOf('}', at))
}
const borderColorOf = body => {
  const explicit = decl(body, 'border-color')
  if (explicit) return explicit
  const shorthand = /border\s*:\s*[^;}]*?\s(?:solid|dashed)\s+([^;}]+)/.exec(body)
  return shorthand ? shorthand[1].trim() : ''
}

/** 从 `utils/package-occupancy.js` 的源码里解析出**状态词表**（模块没导出它，所以读文本）。
 *  ⛔ 为什么不直接改生产源码加一个 export：判据要能在**变异后的文本**上跑，文本解析天然支持。 */
const parseStateTable = src => {
  const marker = 'const SLOT_STATE_TEXT = {'
  const at = src.indexOf(marker)
  if (at < 0) return null
  const body = src.slice(at + marker.length, src.indexOf('}', at))
  const map = {}
  for (const hit of body.matchAll(/(?:'([^']*)'|([A-Za-z_$][\w$]*))\s*:\s*'([^']*)'/g)) {
    map[hit[1] !== undefined ? hit[1] : hit[2]] = hit[3]
  }
  return map
}

/** 三态在**四个维度**上的取值（可约 / 已排课 / 已过时间） */
const triStateStyles = wxss => {
  const pick = (cellAt, timeAt, stateAt) => {
    const cell = exactBody(wxss, cellAt)
    return {
      bg: decl(cell, 'background'),
      line: borderColorOf(cell),
      time: decl(exactBody(wxss, timeAt), 'color'),
      state: decl(exactBody(wxss, stateAt), 'color')
    }
  }
  return {
    free: pick('.slot-cell', '.slot-time', '.slot-state'),
    booked: pick('.slot-cell.booked', '.slot-cell.booked .slot-time', '.slot-cell.booked .slot-state'),
    past: pick('.slot-cell.past', '.slot-cell.past .slot-time', '.slot-cell.past .slot-state')
  }
}

const source = read(SOURCE_FILE)
const occupancySrc = read('utils/package-occupancy.js')
const view = require('../utils/member-booking-view')
const WXMLS = CONSUMERS.map(entry => ({ ...entry, wxmlText: read(entry.wxml), wxssText: read(entry.file) }))
const STATE_WXMLS = STATE_CONSUMERS.map(entry => ({ ...entry, wxmlText: read(entry.wxml), wxssText: read(entry.file) }))

// ══════════════════ 契约 A：静态（唯一来源 / 唯一状态名 / 三态可分 / 无本地补丁） ══════════════════

function staticContract(ctx) {
  const { source: src, consumers } = ctx
  const problems = []
  const need = (ok, message) => { if (!ok) problems.push(message) }

  // ① 唯一来源：卡片本体与三态组合都必须在这里定义
  const missingInSource = [...CARD_CLASSES, ...STATE_CLASSES].filter(cls => !definedIn(src, cls))
  need(missingInSource.length === 0,
    'styles/slots.wxss 作为唯一来源，必须定义全部卡片类，缺：' + missingInSource.join('、'))

  // ② 两个卡片消费者 import 的是**同一个路径字符串**（同一份文件，不是各自抄一份）
  const imports = consumers.slice(0, 2).map(entry => (contract.stripCss(entry.wxss).match(/@import\s+["']([^"']*slots\.wxss)["']/) || [])[1])
  need(imports.every(Boolean), '每个消费者都必须 @import styles/slots.wxss')
  need(new Set(imports.filter(Boolean)).size <= 1, '消费者必须 import 同一个路径，实得：' + JSON.stringify(imports))
  need(/\/styles\/slots\.wxss$/.test(imports[0] || ''), 'import 的必须是 styles/slots.wxss，实得 ' + imports[0])

  // ③ 消费者**不许**重定义任何卡片类（这是本文件存在的理由）
  const redefined = []
  consumers.forEach(entry => {
    const plain = contract.stripCss(entry.wxss)
    ;[...CARD_CLASSES, ...STATE_CLASSES].forEach(cls => {
      if (contract.ruleBodies(plain, '.' + cls).length > 0) redefined.push(entry.who + ':' + cls)
    })
  })
  need(redefined.length === 0, '消费者重定义了卡片类，等于出现第二套卡片：' + redefined.join('、'))

  // ④ 会员端不设 --slot-* 变量（会员端走默认值，只有教练端用 .slots-coach 覆盖）
  const memberVars = contract.stripCss(consumers[0].wxss).match(/--slot-[a-z-]+\s*:/g) || []
  need(memberVars.length === 0, '会员端不许覆盖 --slot-* 变量（会静默改变卡片配色），实得：' + memberVars.join('、'))

  // ⑤ 三态必须各有**独立**底色与独立边框
  const styles = triStateStyles(src)
  const bgs = [styles.free.bg, styles.booked.bg, styles.past.bg]
  const lines = [styles.free.line, styles.booked.line, styles.past.line]
  need(bgs.every(Boolean), '三态都必须显式写 background，实得 ' + JSON.stringify(bgs))
  need(lines.every(Boolean), '三态都必须显式写边框色，实得 ' + JSON.stringify(lines))
  need(new Set(bgs).size === 3, '三态底色必须互不相同，实得 ' + JSON.stringify(bgs))
  need(new Set(lines).size === 3, '三态边框必须互不相同，实得 ' + JSON.stringify(lines))

  // ⑥ 卡片几何也在唯一来源里（列数 / 最小高度），消费者不许改
  need(/repeat\(4\s*,\s*1fr\)/.test(firstBody(src, 'slot-grid')), '.slot-grid 必须是 4 列')
  const minHeight = decl(firstBody(src, 'slot-cell'), 'min-height')
  need(/^\d+rpx$/.test(minHeight), '.slot-cell 必须显式写 min-height（rpx），实得 ' + minHeight)

  // ⑦ 复用是真的复用：每个卡片消费者都渲染了同一套图例与三态结构
  consumers.slice(0, 2).forEach(entry => {
    const wxml = String(contract.stripHtml(entry.wxml) || '')
    need(/class="slot-legend"/.test(wxml), entry.who + ' 必须有顶部图例')
    for (const label of ['可约', '已排课', '已过时间']) {
      need(wxml.indexOf(label) >= 0, entry.who + ' 图例缺少「' + label + '」')
    }
    if (/slot-grid|slot-cell/.test(wxml)) {
      need(/class="slot-grid"/.test(wxml), entry.who + ' 必须用 .slot-grid 承载时段')
      need(/class="slot-time"/.test(wxml) && /class="slot-state"/.test(wxml), entry.who + ' 每格必须同时给时间与状态文字')
    }
    // 图例圆点三态必须齐全，且名字与状态名一致
    need(/class="slot-dot"/.test(wxml), entry.who + ' 图例缺可约圆点')
    need(/class="slot-dot booked"/.test(wxml), entry.who + ' 图例缺「已排课」圆点（.slot-dot.booked）')
    need(/class="slot-dot past"/.test(wxml), entry.who + ' 图例缺「已过时间」圆点（.slot-dot.past）')
  })

  // ⑧ 样式层不许出现"最晚结束时间"这类口径数字（口径只能来自 occupancy）
  need(!/24:00|1440/.test(contract.stripCss(src)), 'styles/slots.wxss 不许写死最晚结束时间（24:00 / 1440）')

  // ⑨ 教练端配色只作为容器级覆盖存在
  need(definedIn(src, 'slots-coach'), '教练端配色 .slots-coach 必须在唯一来源里定义')
  need(/--slot-/.test(firstBody(src, 'slots-coach')), '.slots-coach 必须靠 --slot-* 变量覆盖成蓝色系')
  // ⭐ 教练端的三态也必须两两可分（否则"修好了"只修了会员端）
  const coach = firstBody(src, 'slots-coach')
  const coachVar = name => (new RegExp('--' + name + '\\s*:\\s*([^;}]+)').exec(coach) || [])[1]
  const coachBg = [coachVar('slot-booked-bg'), coachVar('slot-past-bg')]
  need(coachBg.every(Boolean), '.slots-coach 必须给出 --slot-booked-bg / --slot-past-bg')
  need(new Set(coachBg).size === 2 && !coachBg.includes('#fff'),
    '教练端三态底色必须两两不同（可约是 #fff），实得 ' + JSON.stringify(coachBg))

  // ⑩ ⭐⭐ 状态名唯一：样式里的状态类名必须与判定函数的词表**逐字相同**
  const table = parseStateTable(ctx.occupancySrc) || {}
  const cssStates = [...contract.stripCss(src).matchAll(/\.slot-cell\.([a-z-]+)/g)]
    .map(hit => hit[1]).filter(name => name !== 'echo')   // echo 是叠加标记，不是第四态
  const uniqueCssStates = [...new Set(cssStates)].sort()
  const runtimeStates = Object.keys(table).filter(Boolean).sort()
  need(uniqueCssStates.join(',') === runtimeStates.join(','),
    '⭐ 状态类名必须与 slotStateOf 的词表逐字相同：样式里有 [' + uniqueCssStates.join(',') +
    ']，occupancy 词表里有 [' + runtimeStates.join(',') + ']')
  need(!/\.slot-(cell|dot)\.busy/.test(contract.stripCss(src)),
    '⛔ 状态类名不许出现旧名 busy —— 判定函数返回的是 booked，写成 busy 就一条规则都命中不了')
  // ⭐ 词表本身也必须三态三词（否则界面分不出三态，而"类名对得上"这件事仍然成立）
  const tableValues = Object.values(table).filter(Boolean)
  need(tableValues.length >= 3 && new Set(tableValues).size === tableValues.length,
    '⭐ 状态词表必须给每个状态一个**不同**的词（否则三态在界面上是同一句话），实得 ' + JSON.stringify(table))

  // ⑪ ⭐⭐ 三态两两可分：底色 / 边框 / 时间字色 / 状态字色 **四个维度**都必须互不相同
  const dims = { bg: [styles.free.bg, styles.booked.bg, styles.past.bg], line: [styles.free.line, styles.booked.line, styles.past.line], time: [styles.free.time, styles.booked.time, styles.past.time], state: [styles.free.state, styles.booked.state, styles.past.state] }
  for (const [name, values] of Object.entries(dims)) {
    need(values.every(Boolean), '三态的「' + name + '」都必须显式写值，实得 ' + JSON.stringify(values))
    need(new Set(values).size === 3, '⭐ 三态的「' + name + '」必须两两不同（否则分不出状态），实得 ' + JSON.stringify(values))
  }

  // ⑫ ⭐⭐ 消费者不许本地打补丁：类名与文案都只能由数据驱动
  //   ⛔ 先挡"判据被静默跳过"：任何消费者缺 wxml / wxss 文本，这里就红 ——
  //      否则一个取错键名（`entry.wxmlText`）就能让整条纪律形同虚设。
  need(consumers.every(entry => typeof entry.wxml === 'string' && entry.wxml.length > 0),
    '每个消费者都必须带上 wxml 文本（缺了会让本段判据被静默跳过）')
  need(consumers.every(entry => typeof entry.wxss === 'string' && entry.wxss.length > 0),
    '每个消费者都必须带上 wxss 文本（缺了会让第③段判据被静默跳过）')
  consumers.forEach(entry => {
    // ⛔ 键名必须与 CTX.consumers 的形状一致（`wxml` / `wxss`）。
    //    曾经这里误写 `entry.wxmlText` ⇒ 取到 undefined ⇒ 整段判据被静默跳过，
    //    C10 / C12 两个变异当时就**逃逸**了（正是"假绿护栏"本身出问题）。
    const wxml = contract.stripHtml(entry.wxml)
    need(!/available\s*\?/.test(wxml), entry.who + ' ⛔ 不许在 wxml 里用 available 三元（available?空:busy）做**本地类名补丁** —— 状态名必须由数据里的 reason 驱动')
    need(!/['"]busy['"]/.test(wxml), entry.who + ' ⛔ wxml 里不许出现旧状态名 busy')
    if (/slot-cell/.test(wxml)) {
      need(/class="slot-cell \{\{[a-zA-Z]+\.reason\}\}/.test(wxml),
        entry.who + ' 的 .slot-cell 类名必须直接来自 `{{...reason}}`（与 slotStateOf 的返回值同名）')
      need(/\{\{[a-zA-Z]+\.stateText\}\}/.test(wxml),
        entry.who + ' 的状态文案必须来自 {{...stateText}}（唯一文案来源，不许自己写 available 三元拼「可约」）')
    }
  })

  return problems
}

// ══════════════════ 契约 B：运行时（三态真的能区分） ══════════════════

function runtimeContract(ctx) {
  const problems = []
  const need = (ok, message) => { if (!ok) problems.push(message) }
  const TODAY = '2026-10-20'
  const make = (dateKey, extra) => ctx.view.slotsFor({ dateKey, busy: [], todayKey: TODAY, ...extra })
  const at = (slots, start) => (slots || []).find(slot => slot.start === start) || {}

  const freeSlot = at(make('2026-10-21'), 6 * 60)
  const bookedSlot = at(ctx.view.slotsFor({ dateKey: '2026-10-21', busy: [{ start: 6 * 60, end: 7 * 60 }], todayKey: TODAY }), 6 * 60)
  const pastSlot = at(make(TODAY, { nowMinutes: 12 * 60 }), 6 * 60)

  need(freeSlot.reason === '' && freeSlot.stateText === '可约', '可约格：reason 必须是空串、stateText 必须是「可约」（实得 ' + JSON.stringify([freeSlot.reason, freeSlot.stateText]) + '）')
  need(bookedSlot.reason === 'booked' && bookedSlot.stateText === '已排课', '已排课格：reason 必须是 booked、stateText 必须是「已排课」（实得 ' + JSON.stringify([bookedSlot.reason, bookedSlot.stateText]) + '）')
  need(pastSlot.reason === 'past' && pastSlot.stateText === '已过时间', '已过时间格：reason 必须是 past、stateText 必须是「已过时间」（实得 ' + JSON.stringify([pastSlot.reason, pastSlot.stateText]) + '）')

  const stateTexts = [freeSlot.stateText, bookedSlot.stateText, pastSlot.stateText]
  const reasons = [freeSlot.reason, bookedSlot.reason, pastSlot.reason]
  need(new Set(stateTexts).size === 3, '⭐ 三态的显示文案必须两两不同，实得 ' + JSON.stringify(stateTexts))
  need(new Set(reasons).size === 3, '⭐ 三态的 reason 必须两两不同（它是进 class 的那个值），实得 ' + JSON.stringify(reasons))

  // ⭐ 词表本身必须三态三词（这条读的是**注入的** occupancy 源码 ⇒ 抓得住"词表被写成一个词"的变异）
  //   ⛔ 为什么不直接 `occupancy.SLOT_STATE_TEXT`：生产模块**没有导出**它（只导出 slotStateOf / slotStateTextOf），
  //      而判据必须能在"变异后的文本"上跑 ⇒ 统一从源码文本解析（见 parseStateTable）。
  const table = parseStateTable(ctx.occupancySrc) || {}
  const tableTexts = reasons.map(reason => table[reason])
  need(tableTexts.every(Boolean) && new Set(tableTexts).size === 3,
    '⭐ 状态词表必须给三态三个**不同**的词，实得 ' + JSON.stringify(tableTexts) + ' / 词表 ' + JSON.stringify(table))

  // ⭐ 状态名与词表同名：reason 必须是词表的键（空串 ⇒ 可约）
  const keys = Object.keys(table)
  need(reasons.every(reason => keys.includes(reason)), 'reason 必须是 SLOT_STATE_TEXT 的键，实得 ' + JSON.stringify(reasons) + ' / 词表 ' + JSON.stringify(keys))

  // 教师端弹层也读同一个函数：这里顺带证明"教练端拿到的 reason 与会员端逐字相同"
  const coachSlots = ctx.view.slotsFor({ dateKey: '2026-10-21', busy: [{ start: 6 * 60, end: 7 * 60 }], todayKey: TODAY, dayStart: 6 * 60, latestStart: 23 * 60, step: 30, length: 60 })
  const coachBooked = at(coachSlots, 6 * 60)
  need(coachBooked.reason === bookedSlot.reason && coachBooked.stateText === bookedSlot.stateText,
    '⭐ 教练端与会员端对同一格的 reason / stateText 必须逐字相同（实得 ' + JSON.stringify([coachBooked.reason, coachBooked.stateText]) + '）')

  return problems
}

const CTX = { source, consumers: STATE_WXMLS.map(e => ({ wxss: e.wxssText, wxml: e.wxmlText, who: e.who })), occupancySrc, view }

const staticProblems = staticContract(CTX)
const runtimeProblems = runtimeContract(CTX)
assert.deepStrictEqual(staticProblems, [], '静态契约不通过：\n' + staticProblems.map(line => '  ✗ ' + line).join('\n'))
assert.deepStrictEqual(runtimeProblems, [], '运行时契约不通过：\n' + runtimeProblems.map(line => '  ✗ ' + line).join('\n'))

console.log('① 唯一来源：' + SOURCE_FILE + ' 定义 ' + (CARD_CLASSES.length + STATE_CLASSES.length) + ' 个卡片类（含三态组合）')
console.log('② 三个消费者（约课页 / 教练弹层 / 改期面板）import 同一路径，零重定义、会员端零 --slot-* 覆盖')
console.log('③ 三态在「底色 / 边框 / 时间字色 / 状态字色」四个维度两两可分；教练端配色同样两两可分')
console.log('④ ⭐ 状态类名与 slotStateOf 词表逐字相同（booked / past，没有 busy）；消费者零本地补丁')
console.log('⑤ ⭐ 运行时三态样本 reason / stateText 两两不同，且教练端与会员端逐字一致')

// ══════════════════ 判别力自证（内存变异，磁盘不动） ══════════════════

const patch = (text, from, to) => {
  if (text.indexOf(from) < 0) throw new Error('空变异/锚点失效：找不到 "' + from + '"')
  if (from === to) throw new Error('空变异：from === to')
  const next = text.replace(from, to)
  if (next === text) throw new Error('空变异：替换后文本没变')
  return next
}
const prepend = (text, extra) => extra + text

const MUTATIONS = [
  { id: 'C01', what: '唯一来源里删掉三态的"已过时间"规则', apply: s => ({ ...s, source: patch(s.source, '.slot-cell.past{', '.slot-cell-past-disabled{') }) },
  { id: 'C02', what: '会员端自己又写一份 .slot-cell（第二套卡片）', apply: s => ({ ...s, consumers: [{ ...s.consumers[0], wxss: s.consumers[0].wxss + '\n.slot-cell{min-height:120rpx}' }, ...s.consumers.slice(1)] }) },
  { id: 'C03', what: '会员端覆盖 --slot-accent（像素静默变化）', apply: s => ({ ...s, consumers: [{ ...s.consumers[0], wxss: s.consumers[0].wxss + '\n.sl {--slot-accent:#000}' }, ...s.consumers.slice(1)] }) },
  { id: 'C04', what: '弹层改成 import 另一个副本文件', apply: s => ({ ...s, consumers: [s.consumers[0], { ...s.consumers[1], wxss: s.consumers[1].wxss.replace('../../styles/slots.wxss', '../../styles/slots-modal-copy.wxss') }, s.consumers[2]] }) },
  { id: 'C05', what: '三态底色被改成同一个白', apply: s => ({ ...s, source: patch(s.source, '.slot-cell.booked{background:var(--slot-booked-bg,#e6eef4)', '.slot-cell.booked{background:#fff') }) },
  { id: 'C06', what: '弹层删掉"已过时间"图例', apply: s => ({ ...s, consumers: [s.consumers[0], { ...s.consumers[1], wxml: s.consumers[1].wxml.replace('<view class="slot-legend-item"><view class="slot-dot past"></view><text>已过时间</text></view>', '') }, s.consumers[2]] }) },
  { id: 'C07', what: '网格列数从 4 列改成 3 列', apply: s => ({ ...s, source: patch(s.source, 'grid-template-columns:repeat(4,1fr)', 'grid-template-columns:repeat(3,1fr)') }) },
  { id: 'C08', what: '样式层写死最晚结束时间 24:00', apply: s => ({ ...s, source: s.source + '\n.slot-note::after{content:"24:00"}' }) },

  // ⭐ 以下 6 条针对 2026-10-03 修的那个真实缺陷（状态名分歧 / 本地补丁 / 三态不可分 / 词表退化）
  { id: 'C09', what: '⭐ 状态名回退成旧名 busy（判定函数返回 booked ⇒ 一条规则都命中不了）', apply: s => ({ ...s, source: patch(s.source, '.slot-cell.booked{', '.slot-cell.busy{') }) },
  { id: 'C10', what: '⭐ 消费者重新加本地类名补丁 available?\'\':\'busy\'', apply: s => ({ ...s, consumers: [s.consumers[0], { ...s.consumers[1], wxml: s.consumers[1].wxml.replace('class="slot-cell {{s.reason}}"', 'class="slot-cell {{s.available?\'\':\'busy\'}} {{s.reason}}"') }, s.consumers[2]] }) },
  { id: 'C11', what: '⭐ 三态的"时间字色"被改成同一个灰（只剩底色可分）', apply: s => ({ ...s, source: patch(s.source, '.slot-cell.booked .slot-time{color:var(--slot-booked-time,#8698ab)', '.slot-cell.booked .slot-time{color:#8698ab').replace('.slot-cell.past .slot-time{color:var(--slot-past-time,#bfc9d2)}', '.slot-cell.past .slot-time{color:#8698ab}') }) },
  { id: 'C12', what: '⭐ 消费者不再用 reason 驱动类名（改成写死的 slot-cell）', apply: s => ({ ...s, consumers: [s.consumers[0], { ...s.consumers[1], wxml: s.consumers[1].wxml.replace('class="slot-cell {{s.reason}}"', 'class="slot-cell"') }, s.consumers[2]] }) },
  // ⭐ C13 / C14 打的是**状态词表**（`utils/package-occupancy.js` 里那一行）。
  //    ⛔ 为什么改的是**源码文本**而不是内存对象：生产模块没有导出 SLOT_STATE_TEXT（只导出
  //       slotStateOf / slotStateTextOf），而且 `view` 是 require 进来的**活模块**，
  //       改文本不会影响它 ⇒ 只能让"读文本"的那两条判据（静态 ⑩ 与运行时词表段）来抓。
  { id: 'C13', what: '⭐ 词表三个状态被写成同一个词（界面再也分不出三态）', runtime: true, apply: s => ({ ...s, occupancySrc: patch(s.occupancySrc, "const SLOT_STATE_TEXT = { past: '已过时间', booked: '已排课', '': '可约' }", "const SLOT_STATE_TEXT = { past: '可约', booked: '可约', '': '可约' }") }) },
  { id: 'C14', what: '⭐ 词表丢掉"可约"那一档（可约格的 stateText 变成 undefined ⇒ 卡片上一片空白）', runtime: true, apply: s => ({ ...s, occupancySrc: patch(s.occupancySrc, "const SLOT_STATE_TEXT = { past: '已过时间', booked: '已排课', '': '可约' }", "const SLOT_STATE_TEXT = { past: '已过时间', booked: '已排课' }") }) }
]

let caught = 0
const escaped = []
for (const mutation of MUTATIONS) {
  const base = {
    source,
    consumers: CTX.consumers.map(entry => ({ ...entry })),
    occupancySrc,
    view
  }
  let failed = false
  try {
    const mutated = mutation.apply(base)
    const problems = staticContract({ source: mutated.source, consumers: mutated.consumers, occupancySrc: mutated.occupancySrc })
      .concat(runtimeContract({ view: mutated.view, occupancySrc: mutated.occupancySrc }))
    if (problems.length) failed = true
  } catch (error) { failed = true }
  if (failed) caught++
  else escaped.push(mutation.id + ' ' + mutation.what)
}

assert.deepStrictEqual(escaped, [], '有变异没被抓住（假绿护栏）：\n' + escaped.map(line => '  ✗ ' + line).join('\n'))
console.log('⑥ 判别力自证：' + caught + '/' + MUTATIONS.length + ' 个变异全部被抓住')
console.log('ALL SLOT CARD SINGLE SOURCE TESTS PASSED')
