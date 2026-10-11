// 利用微信 JS 运行环境的中文排序规则生成姓名拼音首字母。
const LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ'
const BOUNDS = '阿芭擦搭蛾发噶哈击喀垃妈拿哦啪期然撒塌挖昔压匝'
function initials(name) {
  return String(name || '').split('').map(ch => {
    if (/[a-z]/i.test(ch)) return ch.toUpperCase()
    try {
      for (let i = LETTERS.length - 1; i >= 0; i--) if (ch.localeCompare(BOUNDS[i], 'zh-CN') >= 0) return LETTERS[i]
    } catch (e) {}
    return ''
  }).join('')
}
module.exports = { initials }
