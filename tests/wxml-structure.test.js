// Offline structural guard, not a replacement for the WeChat WXML compiler.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const root = path.join(__dirname, '..')

function parse(source, file) {
  const clean = source.replace(/<!--[\s\S]*?-->/g, value => value.replace(/[^\n]/g, ' '))
  const tags = /<\/?[A-Za-z][\w:-]*(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g
  const stack = [], nodes = []
  for (const match of clean.matchAll(tags)) {
    const raw = match[0], name = /^<\/?([\w:-]+)/.exec(raw)[1]
    const line = clean.slice(0, match.index).split('\n').length
    if (raw.startsWith('</')) {
      const open = stack.pop()
      assert.ok(open && open.name === name, `${file}:${line}: unexpected </${name}>, expected </${open && open.name}>`)
    } else {
      const node = { name, raw, parent: stack[stack.length - 1] }
      nodes.push(node)
      if (!raw.endsWith('/>')) stack.push(node)
    }
  }
  assert.strictEqual(stack.length, 0, `${file}: unclosed tags`)
  return nodes
}
assert.throws(() => parse('<view></block>', 'fixture'), /unexpected/)
parse('<view wx:if="{{count > 0}}"><input /></view>', 'fixture')

let count = 0
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name)
    if (item.isDirectory()) walk(file)
    else if (item.name.endsWith('.wxml')) { parse(fs.readFileSync(file, 'utf8'), file); count++ }
  }
}
walk(path.join(root, 'pages'))
walk(path.join(root, 'components'))

const nodes = parse(fs.readFileSync(path.join(root, 'pages/students/students.wxml'), 'utf8'), 'students')
const card = nodes.find(node => /class="[^"]*\bpackage-detail\b/.test(node.raw))
assert.ok(card && card.parent && /wx:for="\{\{form.packages\}\}"/.test(card.parent.raw), 'Keep original package indexes in an outer loop')
const condition = /wx:if="\{\{([\s\S]*?)\}\}"/.exec(card.raw)
assert.ok(condition, 'Package visibility must be bound to the card, not just the toggle label')
for (const [item, finishedExpanded, expected] of [
  [{ finished: true, isNew: false }, false, false],
  [{ finished: true, isNew: false }, true, true],
  [{ finished: false, isNew: false }, false, true],
  [{ finished: true, isNew: true }, false, true],
  [{ isNew: true }, false, true]
]) {
  assert.strictEqual(!!vm.runInNewContext(condition[1], { item, finishedExpanded }), expected)
}
console.log(`WXML structure tests: PASS (${count} templates; package visibility states)`)
