const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const statsPath = path.join(root, 'pages', 'stats', 'stats.js')
const toolsPath = path.join(root, 'utils', 'member-coach-tools.js')
const calls = []
const fakeTools = {
  async readProfile() {
    return { ok: true, profile: { displayName: '雅教练', avatar: 'cloud://avatar', specialties: ['力量'], introduction: '认真训练' } }
  },
  async execute(command, payload) {
    calls.push({ command, payload })
    return { ok: true }
  }
}

const previousToolsCache = require.cache[require.resolve(toolsPath)]
require.cache[require.resolve(toolsPath)] = { id: toolsPath, filename: toolsPath, loaded: true, exports: fakeTools }

let captured
const previousPage = global.Page
const previousWx = global.wx
global.Page = definition => { captured = definition }
global.wx = { showToast() {}, showModal() {} }
delete require.cache[require.resolve(statsPath)]
require(statsPath)

const page = { ...captured, data: JSON.parse(JSON.stringify(captured.data)) }
page.setData = patch => Object.assign(page.data, patch)

;(async () => {
  await page.loadCoachProfile()
  assert.strictEqual(page.data.coachName, '雅教练', '“我的”页必须回读已发布的教练称呼')
  assert.strictEqual(page.data.coachInitial, '雅', '头像文字应取教练称呼首字')

  page.openCoachName()
  page.coachNameInput({ detail: { value: '  小雅教练  ' } })
  await page.saveCoachName()
  assert.strictEqual(calls.length, 1, '保存一次只能发出一次公开教练资料命令')
  assert.strictEqual(calls[0].command, 'publishCoachProfile')
  assert.deepStrictEqual(calls[0].payload, {
    displayName: '小雅教练',
    avatar: 'cloud://avatar',
    specialties: ['力量'],
    introduction: '认真训练'
  }, '改称呼时必须保留头像、擅长项目和介绍，不能把原公开资料清空')
  assert.strictEqual(page.data.coachName, '小雅教练')
  assert.strictEqual(page.data.coachNameModal, false)

  const wxml = fs.readFileSync(path.join(root, 'pages', 'stats', 'stats.wxml'), 'utf8')
  assert.ok(wxml.includes('会员收到邀请和预约信息时会看到这个名字'), '页面必须说清教练称呼的用途')
  assert.ok(wxml.includes('bindtap="saveCoachName"'), '教练称呼必须有明确保存入口')
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.strictEqual(app.tabBar.list[2].text, '我的', '教练第三个页签应为“我的”')

  console.log('coach name profile tests: PASS')
})().finally(() => {
  delete require.cache[require.resolve(statsPath)]
  if (previousToolsCache) require.cache[require.resolve(toolsPath)] = previousToolsCache
  else delete require.cache[require.resolve(toolsPath)]
  if (previousPage === undefined) delete global.Page
  else global.Page = previousPage
  if (previousWx === undefined) delete global.wx
  else global.wx = previousWx
})
