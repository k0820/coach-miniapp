const assert=require('assert'),fs=require('fs'),path=require('path')
const root=path.join(__dirname,'..')
const app=JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8'))
// ⭐ 2026-10-05：`member-theme`（主题选择页）已撤回并从 app.json 注销 ⇒ 从必须注册的清单里移除。
// ⭐ 2026-10-07 新方案（唯一会员 + 双向联系人）：会员与教练互相添加的联系人体系是产品核心的一部分，
//    member-login / member-add-coach / member-coaches / member-contact-qr / coach-add-member / coach-contact-qr 全部注册。
const pages=['role-entry','coach-entry','member-home','member-packages','member-history','member-history-detail','member-profile']
pages.forEach(name=>assert.ok(app.pages.includes(`pages/${name}/${name}`),`${name} must be registered`))
const all=pages.map(name=>['js','wxml','wxss','json'].map(ext=>path.join(root,'pages',name,`${name}.${ext}`))).flat()
all.forEach(file=>assert.ok(fs.existsSync(file),file))
const home=fs.readFileSync(path.join(root,'pages/member-home/member-home.wxml'),'utf8')
// ⭐ 2026-10-06 新方案：首页三张卡 = 课时概况 / 下一节课 / 我的教练（不再要求「本月训练 / 最近训练」）。
assert.ok(home.includes('课时概况')&&home.includes('下一节课')&&home.includes('我的教练'))
// 首页不得再放与底部导航 / 「我的」页重复的快捷九宫格
assert.ok(!home.includes('member-actions'),'member home must not keep shortcut grid duplicating bottom nav / profile')
assert.ok(!/bindtap="(coaches|profile)"/.test(home),'member home must not duplicate My-coaches / settings entries')
// 会员「我的课时」只展示表达，不得新增第二套余额，也不得用减法推导 remaining
const packages=fs.readFileSync(path.join(root,'pages/member-packages/member-packages.wxml'),'utf8')
assert.ok(packages.includes('当前可用课时'),'packages must lead with currently usable sessions')
assert.ok(packages.includes('独立保存'),'packages must keep every purchase / renewal as its own record')
assert.ok(!packages.includes('>剩余</text>')&&!packages.includes('>总课时</text>'),'packages must not show three equal-weight numbers implying total-used=remaining')
const pkgExprs=packages.match(/\{\{[^}]*\}\}/g)||[]
assert.ok(!pkgExprs.some(expr=>/item\.total/.test(expr)&&/item\.used/.test(expr)),'packages must never combine total and used in one expression')
assert.ok(!pkgExprs.some(expr=>/[-\+]\s*item\.(total|used|remaining)/.test(expr)),'packages must never compute numbers with arithmetic')
// ⭐ 2026-10-05：三套主题已撤回 ⇒ 这里改为钉死"**只有一套**色板，且是灰白简约（不许有第二套）"。
const theme=fs.readFileSync(path.join(root,'utils/member-theme.js'),'utf8')
// ⚠️ 只扫**代码**：文件头部的说明注释里会提到被撤回的旧 id（那是为了解释历史），不算数。
const themeCode=theme.replace(/^[ \t]*\/\/.*$/gm,'').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\r/g,'')
assert.ok(!/vitality|'active'|minimal/.test(themeCode),'member-theme must keep exactly one palette, not the retired three skins')
assert.ok(theme.includes('#3a454e')&&theme.includes('#f6f7f8'),'member-theme must be the single gray-white palette')
const themeAppJson=JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8'))
assert.ok(!themeAppJson.pages.some(page=>page.includes('member-theme')),'member-theme selection page must stay removed')
// ⭐ 2026-10-07 新方案：会员与教练互相添加的联系人页面是产品的一部分，必须注册。
for(const required of ['member-login','member-add-coach','member-coaches','member-contact-qr','coach-add-member','coach-contact-qr'])assert.ok(themeAppJson.pages.some(page=>page.includes(required)),`${required} must be registered (new member scheme)`)
const appSource=fs.readFileSync(path.join(root,'app.js'),'utf8')
assert.ok(appSource.includes("if (appRole.isMember(options))"))
assert.ok(appSource.indexOf("if (appRole.isMember(options))")<appSource.indexOf("production-recovery-guard"),'member cold start must not start coach recovery/outbox')
const coachCore=fs.readFileSync(path.join(root,'cloudfunctions/coachBusinessCommand/core.js'),'utf8')
assert.ok(!coachCore.includes('memberIdentityCommand')&&!coachCore.includes('member_student_claims'))
const sandboxControl=fs.readFileSync(path.join(root,'pages/sandbox-control/sandbox-control.js'),'utf8')
assert.ok(sandboxControl.includes("memberCall({ action: 'seed' })")&&sandboxControl.includes('memberEnvironment.enterSandbox()'),'进入会员测试区必须同时落 role=member 与 environment=sandbox')
assert.ok(!/appRole\.set\('member'\)/.test(sandboxControl),'不得再只落 role 不落 environment（冷启动会静默退回正式区）')
assert.ok(fs.readFileSync(path.join(root,'app.js'),'utf8').includes('memberEnvironment.apply()'),'会员冷启动必须恢复持久化的环境')
const nav=fs.readFileSync(path.join(root,'components/member-nav/member-nav.wxml'),'utf8')
assert.ok(nav.includes('member-sandbox-banner'))
console.log('member M1 UI tests: PASS (pages, visual hierarchy, shared theme structure, frozen command separation)')
