// 1.1.9 UI 小尾巴的静态契约（弹层滑动穿透 / 动作名单行 / 历史结算入口）。
//
// 这三条都是"看起来在、其实不工作"的类型，只有真机能看见 —— 所以必须用契约把它钉死：
//   ① 弹层遮罩缺 catchtouchmove ⇒ 手指在弹层上滑，**后面的页面跟着一起滚**（滑动穿透）。
//      课程页尤其危险：它没有 scroll-view 容器，整页是**原生滚动**，
//      所以"锁住背景"只能靠遮罩上的 catchtouchmove（不像学员页还有 page-meta 兜底）。
//   ② 动作名称列被 nowrap / 固定宽度掐住 ⇒ 明明放得下也换行、或者反过来被截断。
//   ③ 月份/历史入口字体太小 ⇒ 真机反馈"不够明显"（入口已迁到页首「按月查看」胶囊，阈值不变）。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const stripWxss = source => source.replace(/\/\*[\s\S]*?\*\//g, '')
const ruleOf = (wxss, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 规则可能出现在行首（前面是换行）或紧随上一条规则（前面是 }）。两种都要能取到。
  const re = new RegExp('(?:^|[\\s}])' + escaped + '\\s*\\{([^}]*)\\}', 'g')
  const bodies = []
  let match
  while ((match = re.exec(stripWxss(wxss)))) bodies.push(match[1])
  return bodies
}
const wxmlFiles = () => {
  const files = []
  // ⭐ 2026-10-04 主包分包：低频诊断/救援页迁到 pkg-diag，仍要被同一套 UI 规则覆盖（覆盖面对齐搬迁前）
  ;['pages', 'components', 'pkg-diag'].forEach(dir => {
    fs.readdirSync(path.join(ROOT, dir)).forEach(entry => {
      const file = path.join(ROOT, dir, entry, `${entry}.wxml`)
      if (fs.existsSync(file)) files.push({ relative: path.posix.join(dir, entry, `${entry}.wxml`), file })
    })
  })
  return files
}

function everyMaskLocksBackground() {
  const offenders = []
  let total = 0
  wxmlFiles().forEach(({ relative, file }) => {
    const source = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    const tags = source.match(/<view\b[^>]*class="[^"]*\bmask\b[^"]*"[^>]*>/g) || []
    tags.forEach(tag => {
      total += 1
      if (!/catchtouchmove\s*=/.test(tag)) offenders.push(relative + ' :: ' + tag.replace(/\s+/g, ' ').slice(0, 120))
    })
  })
  assert.ok(total >= 8, '遮罩节点数量异常（只找到 ' + total + ' 个），扫描规则可能失效了')
  assert.deepStrictEqual(offenders, [],
    '以下弹层遮罩缺 catchtouchmove —— 手指在弹层上滑动会让**后面的页面跟着动**（滑动穿透）：\n' + offenders.join('\n'))

  // 课程页没有 scroll-view 容器（整页原生滚动），只能靠遮罩的 catchtouchmove 锁背景。
  const session = read('pages/session/session.wxml')
  assert.equal(/<scroll-view/.test(session), false, '课程页结构变了：若新增了 scroll-view，背景锁定的推理需要重新核对')
  ;['time-mask', 'cancel-mask'].forEach(name => {
    const tag = (session.match(new RegExp('<view\\b[^>]*' + name + '[^>]*>')) || [''])[0]
    assert.ok(/catchtouchmove\s*=/.test(tag), name + ' 必须锁住背景滑动，实得：' + tag)
  })
}

function exerciseNameStaysOnOneLineWhenItFits() {
  const wxss = read('pages/session/session.wxss')
  const name = ruleOf(wxss, '.exercise-name').join(';')
  assert.ok(/flex\s*:\s*1/.test(name), '动作名称列必须 flex:1 —— 拿到行内**剩余的全部宽度**，才谈得上"尽量单行"')
  assert.ok(/min-width\s*:\s*0/.test(name), '必须 min-width:0，否则长名称会把整行撑开、挤掉后面的组数/次数/重量')
  assert.equal(/(?:^|;)\s*width\s*:/.test(name), false, '动作名称列不许写死宽度（写死宽度就是"明明放得下也换行"的真凶）')
  assert.equal(/white-space\s*:\s*nowrap/.test(name), false, '不许对名称列强制 nowrap —— 那样长名称会被截断而不是换行')
  const body = ruleOf(wxss, '.exercise-name b').join(';')
  assert.ok(/overflow-wrap\s*:\s*break-word/.test(body),
    '名称的断行只能是 break-word（只在"真的放不下"时才在词内断开）；'
    + 'overflow-wrap:anywhere 会把正常的中英混排名称在词中间掰开。实得：' + body)
}

function historyEntryIsActuallyVisible() {
  const wxss = read('pages/stats/stats.wxss')
  const wxml = read('pages/stats/stats.wxml')
  // 1.1.9 真机反馈：月份/历史入口「之前放大过但仍然不够明显」。
  // 本轮统计页层级整理把入口从卡片内「历史结算」按钮搬到页首「按月查看」胶囊（版式先在
  // layout-lab 面板④ 验证）。**入口换位置不等于标准降低**——下面所有阈值按原样保留，
  // 并且改成"对全文件所有命中规则逐一校验"，比原先只看最后一条更严。
  assert.ok(wxml.includes('class="stats-head-entry"') && /bindtap="openHistory"/.test(wxml),
    '月份入口必须仍在，且仍指向 openHistory（「按月查看」与「历史结算」是同一件事）')
  assert.ok(wxml.includes('>按月查看 ›<'), '页首入口文案应为「按月查看 ›」')
  const rules = ruleOf(wxss, '.stats-head-entry')
  assert.ok(rules.length, '找不到 .stats-head-entry 规则')
  const sizeRules = rules.filter(body => /font-size\s*:/.test(body))
  assert.ok(sizeRules.length, '月份入口必须显式写 font-size')
  sizeRules.forEach(body => {
    const fontSize = /font-size\s*:\s*([\d.]+)rpx/.exec(body)
    assert.ok(fontSize, 'font-size 必须是 rpx 数值（禁止写 px / vw 之类的绝对或视口单位）：' + body)
    assert.ok(Number(fontSize[1]) >= 25,
      '月份入口字体必须 >= 25rpx（真机反馈"不够明显"），实得 ' + fontSize[1] + 'rpx')
  })
  // 可点高度 = line-height + 上下 padding，必须 >= 64rpx；左右内边距 >= 16rpx
  const boxRule = rules.find(body => /line-height\s*:/.test(body) && /padding\s*:/.test(body))
  assert.ok(boxRule, '必须显式写 line-height 与 padding —— 不写就等于把可点高度交给默认值，'
    + '这正是当初"看起来放大了、实际还是点不中"的原因')
  const lineHeight = /line-height\s*:\s*([\d.]+)rpx/.exec(boxRule)
  const padding = /padding\s*:\s*([\d.]+)rpx\s+([\d.]+)rpx/.exec(boxRule)
  assert.ok(lineHeight && padding, 'line-height / padding 必须是 rpx 数值：' + boxRule)
  const tapHeight = Number(lineHeight[1]) + 2 * Number(padding[1])
  assert.ok(tapHeight >= 64,
    '月份入口可点高度必须 >= 64rpx，实得 ' + tapHeight + 'rpx（= line-height ' + lineHeight[1]
    + ' + 上下 padding ' + padding[1] + '×2）')
  assert.ok(Number(padding[2]) >= 16, '左右内边距必须 >= 16rpx，实得 ' + padding[2] + 'rpx')
  // 保持浅色胶囊（次级入口），不改成实心主按钮
  const merged = rules.join(';')
  assert.ok(/background\s*:\s*(?:#e8f0ff|var\(--soft\)|#eef4ff)/.test(merged),
    '月份入口必须是浅色胶囊，实得：' + merged)
  assert.equal(/background\s*:\s*var\(--accent\)(?![0-9a-zA-Z-])/.test(merged), false,
    '月份入口不得改成实心主按钮（主按钮色是 var(--accent)）')
  // 写入入口（＋ 其他业绩）仍然存在：层级整理只改外观，不许把功能入口整没了
  assert.ok(/bindtap="openSale"/.test(wxml), '「＋ 其他业绩」入口必须保留（可换位置，不可消失）')
}

function main() {
  everyMaskLocksBackground()
  exerciseNameStaysOnOneLineWhenItFits()
  historyEntryIsActuallyVisible()
  console.log('ui tail 1.1.9: PASS（弹层背景不再穿透 / 动作名单行规则正确 / 月份入口已放大且仍是浅色次级入口）')
}
main()
