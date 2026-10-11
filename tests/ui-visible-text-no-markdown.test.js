// 用户可见界面不许出现裸 Markdown 标记（2026-09-30）
//
// 真机现象：小程序页面上直接显示 `**授课教练是你（B）**` 这种带星号的原文。
// 根因：写页面时顺手把文档里的强调语法写进了界面文案，而小程序**不会**渲染 Markdown。
//
// ⛔ 判定口径（先想清楚再扫，否则不是假绿就是假红）：
//   · 只看**真正会渲染出来的文字** —— WXML 要去掉 `<!-- -->` 注释与 `{{ }}` 表达式，
//     JS 只看字符串字面量（模板字符串也算：它们大多是拼给界面的句子）；
//   · **注释里出现 `**` 是文档，不是缺陷** ⇒ 不先剥注释就会把自己扫成假红；
//   · 反引号在 JS 里绝大多数是模板字符串的定界符 ⇒ 那是代码，不是界面标记。
//
// ⛔ 不允许用"隐藏 / 截断"掩盖：只能把标记从文案里删掉，不许靠 CSS 藏起来或截断字符串。

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const MARKDOWN = /\*\*|~~|(?<![A-Za-z0-9_])__(?![A-Za-z0-9_])/

function walk(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'cloudfunctions', 'tests', 'utils'].includes(entry.name)) continue
      walk(full, out)
      continue
    }
    if (/\.(wxml|js)$/.test(entry.name)) out.push(full)
  }
  return out
}

// 抽出"用户会看到的文字"
function visibleTextOf(file, source) {
  if (file.endsWith('.wxml')) {
    return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\{\{[\s\S]*?\}\}/g, '').replace(/<[^>]*>/g, '\n')
  }
  const literals = []
  source.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, match => { literals.push(match); return match })
  return literals.join('\n')
}

const results = []
function test(name, fn) {
  return fn().then(() => results.push(`PASS ${name}`), error => { results.push(`FAIL ${name}: ${error.message}`); process.exitCode = 1 })
}

async function main() {
  await test('① 全部页面的可见文案里没有裸 Markdown（** / __ / ~~）', async () => {
    const offenders = []
    for (const file of walk(path.join(ROOT, 'pages'))) {
      const source = fs.readFileSync(file, 'utf8')
      const hit = visibleTextOf(file, source).match(new RegExp(MARKDOWN.source, 'g'))
      if (hit) offenders.push(`${path.relative(ROOT, file).replace(/\\/g, '/')} → ${[...new Set(hit)].join(' ')}`)
    }
    assert.deepEqual(offenders, [], `界面上仍然有裸 Markdown：\n${offenders.join('\n')}`)
  })

  await test('② 会员端页面（用户天天点的那些）一条都不许有', async () => {
    const memberPages = fs.readdirSync(path.join(ROOT, 'pages')).filter(name => name.startsWith('member-'))
    assert.ok(memberPages.length >= 8, `会员端页面数量不对：${memberPages.length}`)
    for (const page of memberPages) {
      for (const ext of ['.wxml', '.js']) {
        const file = path.join(ROOT, 'pages', page, `${page}${ext}`)
        if (!fs.existsSync(file)) continue
        const text = visibleTextOf(file, fs.readFileSync(file, 'utf8'))
        assert.ok(!MARKDOWN.test(text), `${page}${ext} 里有裸 Markdown`)
      }
    }
  })

  await test('③ 弹窗 / 提示的中文文案里不许带强调标记（toast 会截断，弹窗会原样显示星号）', async () => {
    const offenders = []
    for (const file of walk(path.join(ROOT, 'pages'))) {
      const source = fs.readFileSync(file, 'utf8')
      // 只看 showModal / showToast 的 title 与 content
      const blocks = source.match(/(?:title|content|message)\s*:\s*(['"`])(?:\\.|(?!\1)[^\\])*\1/g) || []
      for (const block of blocks) {
        if (MARKDOWN.test(block)) offenders.push(`${path.relative(ROOT, file).replace(/\\/g, '/')} → ${block.slice(0, 60)}`)
      }
    }
    assert.deepEqual(offenders, [], `弹窗文案里有裸 Markdown：\n${offenders.join('\n')}`)
  })

  await test('④ **反向自检**：这套判定真的抓得到（把一处文案改成带星号必须被抓出来）', async () => {
    const sample = path.join(ROOT, 'pages', 'member-bookings', 'member-bookings.wxml')
    assert.ok(fs.existsSync(sample))
    const source = fs.readFileSync(sample, 'utf8')
    // ⛔ 别写死某个词（页面一改词就替换不到 ⇒ 这条自检变成空的、永远绿）⇒ 直接注入第一处中文。
    const poisoned = source.replace(/[一-龥]{2}/, match => `**${match}**`)
    assert.notStrictEqual(poisoned, source, '样本里必须有可替换的文案，否则这条自检是空的')
    assert.ok(MARKDOWN.test(visibleTextOf(sample, poisoned)), '注入星号后必须被扫出来（扫不出来 = 假绿）')
    // 顺带证明注释里的星号**不会**被误判（否则就是假红）
    const commented = `<view>正常文案</view>\n<!-- 这是**文档**，不该算缺陷 -->\n`
    assert.ok(!MARKDOWN.test(visibleTextOf('x.wxml', commented)), '注释里的 Markdown 不该被当成界面缺陷')
  })
}

main().then(() => {
  results.forEach(line => process.stdout.write(line + '\n'))
}, error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
