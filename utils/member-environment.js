// 会员端「角色 + 环境」成对持久化（Pair persistence）。
//
// ⭐ 事故背景（2026-09-26）：`utils/app-role.js` 把角色写进了 Storage（本机存储），
//   但"我在正式区还是测试区"（environment）只活在 `data-runtime.js` 的内存变量里。
//   ⇒ 重新上传体验版 ⇒ 小程序冷启动 ⇒ 角色还是 member、环境却复位成 production
//   ⇒ 会员端去读空的正式会员集合 ⇒ 「0 课时 / 无预约 / 无记录 / 无教练」四类全空且不报错。
//   所以：**角色持久化时，环境上下文必须同步持久化**。两者永远成对写入、成对恢复。
//
// 大白话：小程序记住了"你是会员"，也必须同时记住"你是测试区里的会员"。
const role = require('./app-role')

const KEY = 'coachMemberEnvironment'
const PRODUCTION = 'production'
const SANDBOX = 'sandbox'

function read() {
  try { return wx.getStorageSync(KEY) === SANDBOX ? SANDBOX : PRODUCTION } catch (error) { return PRODUCTION }
}
function write(value) {
  const next = value === SANDBOX ? SANDBOX : PRODUCTION
  try { wx.setStorageSync(KEY, next) } catch (error) {}
  return next
}
// 冷启动 / 任何分支：把持久化的环境恢复到运行时。
// ⚠️ 2026-09-27（M2 真机修复）：这里**不再按角色过滤**。
//   旧写法 `role.stored() === 'member' ? read() : PRODUCTION` 让「教练端测试区」变成
//   一个**永远恢复不回来**的状态 —— 而教练端 Sandbox 只在内存里活着，进程一重建就没了。
//   真机后果：进入教练端沙盒 ⇒ 回到前台 / 重开体验版 ⇒ environment 静默变回 production
//   ⇒ M2 验收页被自己的门禁挡住（"请先进入沙盒"）。
//   落盘只有一个来源、一次写入，恢复就照实恢复；没有记录时 read() 就是 production，行为不变。
function apply() {
  const runtime = require('./data-runtime')
  runtime.setEnvironment(read())
  return runtime.environment()
}
// 进入会员测试区：会员角色 + 测试区环境，一起落盘。
function enterSandbox() { role.set('member'); return write(SANDBOX) }
// 以"当前运行时环境"成为会员（正式区身份不会被误标成测试区）。
function enterMember() { role.set('member'); return write(require('./data-runtime').environment()) }
// 切回教练端：教练角色 + 正式区环境，一起落盘（不让 Sandbox 状态污染教练正式区）。
// ⚠️ 这是**会员切回教练 / 返回正式区**专用；教练自己主动进入测试区请用 enterCoachSandbox()。
function exitToCoach() { role.set('coach'); return write(PRODUCTION) }
// ⭐ M2 真机修复：教练自己主动进入教练端测试区 —— 教练角色 + 测试区环境，一起落盘。
//   缺了它，教练端 Sandbox 就是"只存在于内存的状态"，进程重建即丢失（见 apply() 的注释）。
function enterCoachSandbox() { role.set('coach'); return write(SANDBOX) }
// 角色与环境是否成对一致。
// ⚠️ 2026-09-27 修订：**coach + sandbox 现在是合法组合**（教练端测试区必须能恢复），
//    所以旧规则"非会员绝不允许残留 sandbox"不再成立 —— 它挡住的是功能，不是脏数据。
//    真正要抓的是**半套状态**：运行时与落盘分家（内存是测试区、落盘却是正式区），
//    这正是 M2 那个"页面自称没进沙盒"的形状，也是 §97 那类事故的形状。
function pair() { return { role: role.stored(), environment: read() } }
function consistent() {
  const current = pair()
  if (!['member', 'coach'].includes(current.role)) return false
  if (![PRODUCTION, SANDBOX].includes(current.environment)) return false
  try { return require('./data-runtime').environment() === current.environment } catch (error) { return false }
}

module.exports = { KEY, PRODUCTION, SANDBOX, read, write, apply, enterSandbox, enterMember, exitToCoach, enterCoachSandbox, pair, consistent }
