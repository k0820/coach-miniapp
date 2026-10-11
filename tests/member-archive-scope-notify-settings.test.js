// §173 · 「当前档案隔离」+「生成邀请自动同步教练资料」+「通知设置两套独立授权」（2026-10-06）
//
// ⭐⭐ 起因（真机证据，不是猜测）：
//   ① 会员认领后显示 **0 课时包**，约课页还**混入历史档案的教练** ——
//      服务端 `packages[]` 每行**已经带了** `archiveId`，但客户端只按 `coachKey` 过滤 ⇒ 档案维度**根本没用上**；
//   ② 教练必须**先手动保存一次「公开教练卡」**才能让会员看到真名 ⇒ 没保存 ⇒ 会员看到系统占位名；
//   ③ 会员与教练的通知按钮散布在两处（「我的」一行小字 / 某个学员的认领页）⇒ 两套状态互相冒充。
//
// ⛔⛔ 本轮**不做**的三件事（用户明示，别在这里补）：
//   · ❌ 不为空壳测试学员伪造课时包（0 包是真实状态 ⇒ 显示明确的空态文案）；
//   · ❌ 不修改共用云函数 `readMyMemberData`（方案 B 未启用）；
//   · ❌ 不宣称一次性订阅 = 长期订阅（能不能长期由微信公众平台决定，代码说了不算）。
//
// ⛔ 判别力自证：全部用**内存替身**（假 `wx` / 内存漂移源码），
//    ⛔ 磁盘零改动，⛔ 绝不调用真实云端，⛔ 绝不碰真实业务数据。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
const P = p => path.join(ROOT, p)
const copy = value => (value == null ? value : JSON.parse(JSON.stringify(value)))

// ─────────────────────────────────────────────────────────────────────────────
// 内存漂移：把源码改坏后重新编译，**只在内存里**（磁盘一个字节都不动）
// ─────────────────────────────────────────────────────────────────────────────
function withDrift(relPath, mutate, fn) {
  const target = require.resolve(P(relPath))
  const source = fs.readFileSync(target, 'utf8')
  const drifted = mutate(source)
  assert.notStrictEqual(drifted, source, `⛔ 漂移脚本自身失效：${relPath} 的锚点没命中`)
  const stub = new Module(target, null)
  stub.filename = target
  stub.paths = Module._nodeModulePaths(path.dirname(target))
  stub._compile(drifted, target)
  stub.loaded = true
  const saved = require.cache[target]
  require.cache[target] = stub
  try { return fn(require(target)) } finally {
    if (saved) require.cache[target] = saved
    else delete require.cache[target]
  }
}

const view = require(P('utils/member-booking-view'))
const model = require(P('utils/member-view-model'))
const notifyConsent = require(P('utils/notify-consent'))

const ARCHIVE_NOW = 'archive-now'   // 当前档案（刚认领的那份）
const ARCHIVE_OLD = 'archive-old'   // 历史档案
const COACH_NOW = 'ck-now'
const COACH_OLD = 'ck-old'
const SANDBOX_FN = 'memberIdentitySandboxCommand'

// ⭐ 真机形状：服务端下发的 `coaches` 是**所有档案的并集**，只有 `packages[]` 带 archiveId。
const COACHES = [
  { coachKey: COACH_NOW, displayName: '张教练', bookable: true },
  { coachKey: COACH_OLD, displayName: '老李', bookable: true }
]
const PACKAGES = [
  { packageViewId: 'p-now', archiveId: ARCHIVE_NOW, typeName: '常规课', remaining: 5, total: 10, used: 5, coachKeys: [COACH_NOW] },
  { packageViewId: 'p-old', archiveId: ARCHIVE_OLD, typeName: '拉伸课', remaining: 3, total: 6, used: 3, coachKeys: [COACH_OLD] }
]

async function main() {
  const failures = []
  const check = async (label, fn) => {
    try { await fn(); console.log(`  ✅ ${label}`) } catch (error) { failures.push(label); console.log(`  ❌ ${label}\n     ${error.message}`) }
  }

  console.log('\n【① 当前档案只能看到自己的教练和课时包】')

  await check('教练名单只留当前档案的教练（历史档案的老李不得出现）', () => {
    const keys = view.coachesForArchive(COACHES, PACKAGES, ARCHIVE_NOW).map(row => row.coachKey)
    assert.deepStrictEqual(keys, [COACH_NOW], `混入/丢错了教练：${JSON.stringify(keys)}`)
  })

  await check('课时包只留当前档案的那几份', () => {
    assert.deepStrictEqual(view.packagesForArchive(PACKAGES, ARCHIVE_NOW).map(row => row.packageViewId), ['p-now'])
  })

  await check('历史档案的教练拿不到当前档案的课包', () => {
    assert.strictEqual(view.packagesForCoach(PACKAGES, COACH_OLD, ARCHIVE_NOW).length, 0,
      '⛔ 历史档案的教练拿到了当前档案的课时包')
  })

  await check('当前档案的教练拿得到当前档案的课包', () => {
    assert.deepStrictEqual(view.packagesForCoach(PACKAGES, COACH_NOW, ARCHIVE_NOW).map(row => row.packageViewId), ['p-now'])
  })

  console.log('\n【② 两份历史档案不得互相混入教练】')

  await check('切到历史档案 ⇒ 只剩老李，张教练消失', () => {
    const rows = view.coachesForArchive(COACHES, PACKAGES, ARCHIVE_OLD)
    assert.deepStrictEqual(rows.map(row => row.coachKey), [COACH_OLD])
  })

  await check('coachKeysForArchive 只从**当前档案**的课包上读授权', () => {
    assert.deepStrictEqual(view.coachKeysForArchive(PACKAGES, ARCHIVE_NOW), [COACH_NOW])
    assert.deepStrictEqual(view.coachKeysForArchive(PACKAGES, ARCHIVE_OLD), [COACH_OLD])
  })

  console.log('\n【③ 空壳学员（0 课时包）显示明确空态，⛔ 不伪造课包】')

  await check('空壳档案：课包 0 份、教练 0 位（⛔ 绝不退化成"全部教练"）', () => {
    assert.deepStrictEqual(view.packagesForArchive([], ARCHIVE_NOW), [])
    assert.deepStrictEqual(view.coachesForArchive(COACHES, [], ARCHIVE_NOW), [],
      '⛔ 一份课包都没有 ⇒ 可约教练必须是 0（给全部教练就是"混入历史档案"的形状）')
  })

  await check('空态文案是两句**不同的话**（没教练 / 没课包不许混成一句）', () => {
    assert.notStrictEqual(view.NO_COACH_FOR_ARCHIVE, view.NO_PACKAGE_FOR_ARCHIVE)
    assert.ok(view.NO_PACKAGE_FOR_ARCHIVE.includes('还没有课时包'))
    assert.ok(view.NO_COACH_FOR_ARCHIVE.includes('没有可预约的教练'))
  })

  await check('没选当前档案（多份）⇒ 一个教练都不给 + "请先选择"', () => {
    assert.deepStrictEqual(view.coachesForArchive(COACHES, PACKAGES, ''), [])
    assert.ok(view.NEED_ARCHIVE_CHOICE.includes('请先选择'))
  })

  await check('老云端兼容：有课包但一行 coachKeys 都没有 ⇒ **不缩名单**', () => {
    const legacy = [{ packageViewId: 'p-legacy', archiveId: ARCHIVE_NOW, remaining: 2, coachKeys: [] }]
    assert.strictEqual(view.coachesForArchive(COACHES, legacy, ARCHIVE_NOW).length, COACHES.length,
      '⛔ 退化投影下把教练全清掉了 —— 界面说没教练其实有')
  })

  console.log('\n【④ 数据异常不再伪装成"数据已就绪"】')

  await check('warnings 翻译成人话，且保留原始 code（排查用）', () => {
    const text = model.warningTextOf({ code: 'COACH_DATASET_HEAD_AMBIGUOUS' })
    assert.ok(text.includes('COACH_DATASET_HEAD_AMBIGUOUS'), '⛔ code 丢了 ⇒ 云开发日志无从追')
    assert.ok(text.includes('分不清') && text.includes('没有'), '⛔ 没翻译成人话')
    assert.ok(!/^数据读取不完整：/.test(text), '⛔ 仍然是老的那句笼统话')
  })

  await check('未知 code 也说人话（⛔ 不许把裸错误码单独摆给会员）', () => {
    const text = model.warningTextOf({ code: 'SOMETHING_NEW' })
    assert.ok(text.includes('没有读完整'), text)
    assert.ok(!/^SOMETHING_NEW/.test(text))
  })

  await check('notice 会把 warnings 真的显示出来（⛔ 不再静默）', () => {
    const lines = model.notice({ state: 'ready', environment: 'sandbox', warnings: [{ code: 'COACH_DATASET_UNAVAILABLE' }] }, { environment: 'sandbox', expected: 'sandbox' })
    assert.ok(lines.some(line => line.includes('COACH_DATASET_UNAVAILABLE')), '⛔ warnings 被静默吞掉了')
  })

  console.log('\n【⑤ 会员与教练的通知授权必须互相独立】')

  await check('两种身份给出**两份不同**的视图（⛔ 绝不共用一份状态）', () => {
    const memberView = notifyConsent.settingsView('member')
    const coachView = notifyConsent.settingsView('coach')
    assert.strictEqual(memberView.roleText, '会员')
    assert.strictEqual(coachView.roleText, '教练')
    assert.notStrictEqual(memberView.scopeText, coachView.scopeText)
    assert.ok(memberView.scopeText.includes('教练要在他自己的手机上'), '⛔ 没说清"对方要各自授权"')
    assert.ok(coachView.scopeText.includes('会员要在她自己的手机上'))
  })

  await check('三个模板都要显示（课程状态 / 课前3小时 / 课前1小时）', () => {
    const made = notifyConsent.settingsView('coach')
    assert.strictEqual(made.templates.length, 3)
    const names = made.templates.map(row => row.name).join('|')
    assert.ok(names.includes('课前 3 小时') && names.includes('课前 1 小时') && names.includes('课程状态'), names)
    assert.ok(made.templates.every(row => row.idTail), '⛔ 模板 ID 尾号没下发')
  })

  console.log('\n【⑥ 一次性订阅不许伪装成长期】')

  await check('按钮恒为「允许下一条微信提醒」，不含任何长期措辞', () => {
    const made = notifyConsent.settingsView('coach')
    assert.strictEqual(made.buttonText, '允许下一条微信提醒')
    notifyConsent.FORBIDDEN_PERMANENT_WORDS.forEach(word => {
      assert.ok(!made.buttonText.includes(word), `⛔ 按钮上出现了被禁的长期措辞：${word}`)
    })
  })

  await check('长期订阅**已核实结论**：3 个模板都是一次性订阅（不再标“待确认”）', () => {
    const made = notifyConsent.settingsView('member')
    assert.strictEqual(made.longTerm, 'one-time-only', '后台已核实没有长期模板 ⇒ 不许再标 pending-user-confirm')
    Object.keys(notifyConsent.LONG_TERM).forEach(slot => {
      assert.strictEqual(notifyConsent.LONG_TERM[slot], 'one-time-only', `${slot} 还标着别的结论`)
    })
    // 📌 结论文案必须说清“这是核对过的事实”，⛔ 不许再让用户去猜。
    assert.ok(made.longTermNote.includes('暂时没有可选用的模板'), '没写出后台实际看到的那句话')
    assert.ok(!made.longTermNote.includes('还没有在后台核对过'), '还在说“没核对过” ⇒ 结论未更新')
    assert.ok(made.longTermNote.includes('站内消息'), '没告诉用户站内消息中心不受次数限制')
  })

  await check('额度用完 / 拒绝后给**明确退路**（去微信设置）', () => {
    const rejected = notifyConsent.settingsView('member', { last: { status: 'rejected' } })
    assert.strictEqual(rejected.showOpenSetting, true)
    assert.strictEqual(rejected.openSettingText, '去微信设置重新打开')
    const used = notifyConsent.settingsView('member', { last: { status: 'quota-exhausted' } })
    assert.strictEqual(used.quotaUsedText, '下一条提醒需要重新允许')
  })

  await check('统一设置页源码里没有"已开启 / 永久开启"这类话', () => {
    // ⛔ 只扫**真正会渲染出来的内容**（注释里的"不许写已开启"不算违规）
    const wxml = fs.readFileSync(P('pages/notify-settings/notify-settings.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    notifyConsent.FORBIDDEN_PERMANENT_WORDS.forEach(word => {
      assert.ok(!wxml.includes(word), `⛔ 通知设置页出现了被禁的长期措辞：${word}`)
    })
  })

  await check('一次性通知设置从正式界面和路由撤下', () => {
    const profile = fs.readFileSync(P('pages/member-profile/member-profile.wxml'), 'utf8')
    const stats = fs.readFileSync(P('pages/stats/stats.wxml'), 'utf8')
    assert.ok(!profile.includes('微信通知设置'), '⛔ 会员「我的」仍有通知入口')
    assert.ok(!stats.includes('微信通知设置'), '⛔ 教练「统计」仍有通知入口')
    const profileJs = fs.readFileSync(P('pages/member-profile/member-profile.js'), 'utf8')
    const statsJs = fs.readFileSync(P('pages/stats/stats.js'), 'utf8')
    assert.ok(!profileJs.includes('openNotifySettings'), '⛔ 会员仍能进入通知设置')
    assert.ok(!statsJs.includes('openNotifySettings'), '⛔ 教练仍能进入通知设置')
    const app = JSON.parse(fs.readFileSync(P('app.json'), 'utf8'))
    assert.ok(!app.pages.includes('pages/notify-settings/notify-settings'), '⛔ 通知设置仍在正式路由')
  })

  console.log('\n【⑦ Sandbox / Production 隔离】')

  await check('自动同步**不新增任何云端命令**（⛔ 既有护栏要求测试区镜像与正式区逐字节相同）', () => {
    const a = fs.readFileSync(P('cloudfunctions/memberIdentitySandboxCommand/service.js'), 'utf8')
    const b = fs.readFileSync(P('cloudfunctions/memberIdentityCommand/service.js'), 'utf8')
    assert.strictEqual(a, b, '⛔ 两份云函数源码不再逐字节相同 ⇒ 新增只属于测试区的命令撞上了 §163 ⑪ 护栏')
    assert.ok(!a.includes('ensureCoachProfile'), '⛔ 仍然残留了只在测试区存在的新命令')
  })


  // ⭐ 2026-10-06：旧「生成邀请自动同步公开教练卡」那一整段（⑧）与
  //    「认领页改成自己弹授权框」的判别力（原 ⑤⑥）已随认领方案下线 ——
  //    教练端不再有「公开教练卡 / 邀请码」，通知入口统一到「我的/统计 → 微信通知设置」。
  await runNotifyPage(check)

  console.log('\n【⑩ 判别力：故意写坏代码，测试必须变红】')
  await runDiscrimination(check)

  console.log('')
  if (failures.length) {
    console.log(`❌ ${failures.length} 条失败：`)
    failures.forEach(label => console.log(`   · ${label}`))
    process.exit(1)
  }
  console.log('✅ §173 全部通过')
}

async function runNotifyPage(check) {
  console.log('\n【⑨ 通知设置页行为（拒绝后可进微信设置 / 返回后刷新）】')
  const opened = []
  const subscribed = []
  let PageObj = null
  const savedPage = global.Page
  const savedWx = global.wx
  global.Page = obj => { PageObj = obj }
  global.wx = {
    requestSubscribeMessage(arg) {
      subscribed.push(arg)
      const answer = {}
      arg.tmplIds.forEach(id => { answer[id] = 'reject' })
      arg.success(answer)
    },
    openSetting(arg) { opened.push(arg); arg.success({ authSetting: {} }) },
    showToast() {}, showModal() {}, navigateTo() {}, setStorageSync() {}, getStorageSync: () => ''
  }
  try {
    const pagePath = require.resolve(P('pages/notify-settings/notify-settings'))
    delete require.cache[pagePath]
    require(pagePath)
    assert.ok(PageObj, '⛔ 通知设置页没有注册')

    const mk = () => {
      const inst = Object.assign({}, PageObj)
      inst.data = { ...PageObj.data }
      inst.setData = function (patch) { this.data = { ...this.data, ...patch } }
      Object.keys(PageObj).forEach(key => { if (typeof PageObj[key] === 'function') inst[key] = PageObj[key].bind(inst) })
      return inst
    }

    const coach = mk()
    coach.onLoad({ role: 'coach' })

    await check('教练入口 ⇒ 显示"教练"，并明说"会员要在她自己的手机上再点一次"', () => {
      assert.strictEqual(coach.data.roleText, '教练')
      assert.ok(coach.data.scopeText.includes('会员要在她自己的手机上'))
    })

    await check('页面打开时**绝不**自动弹授权框（微信硬规则）', () => {
      assert.strictEqual(subscribed.length, 0, '⛔ onLoad 就弹了授权框 —— 那是骚扰，微信也不允许')
    })

    await coach.allow()

    await check('点按钮才弹授权框，一次带 3 个模板', () => {
      assert.strictEqual(subscribed.length, 1, '⛔ 点了按钮却没弹')
      assert.strictEqual(subscribed[0].tmplIds.length, 3)
    })

    await check('被拒绝之后显示「去微信设置重新打开」（⛔ 不许显示已开启）', () => {
      assert.strictEqual(coach.data.showOpenSetting, true)
      assert.strictEqual(coach.data.buttonText, '允许下一条微信提醒')
    })

    await coach.openWechatSetting()

    await check('点「去微信设置」真的调 wx.openSetting', () => {
      assert.strictEqual(opened.length, 1, '⛔ 没有真的打开微信设置页')
    })

    coach.onShow()

    await check('从微信设置回来 ⇒ 自动刷新并说清下一步（⛔ 不宣布"已开启"）', () => {
      assert.ok(coach.data.statusText.includes('再点一次'), coach.data.statusText)
      notifyConsent.FORBIDDEN_PERMANENT_WORDS.forEach(word => {
        assert.ok(!coach.data.statusText.includes(word), `⛔ 出现了被禁的长期措辞：${word}`)
      })
    })

    await check('会员入口 ⇒ 显示"会员"（⛔ 与教练那份互不相干）', () => {
      const member = mk()
      member.onLoad({ role: 'member' })
      assert.strictEqual(member.data.roleText, '会员')
      assert.ok(member.data.scopeText.includes('教练要在他自己的手机上'))
    })
  } finally {
    global.Page = savedPage
    global.wx = savedWx
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑩ 判别力
// ─────────────────────────────────────────────────────────────────────────────
async function runDiscrimination(check) {
  // ⭐ 2026-10-06 真机回归后**同步改锚点**：档案归属已经收敛到 `archiveScopeOf` 这一个出口
  //    （精确匹配 / 服务端可信三项兜底 / 老云端退化），原来的那行内联 filter 已经不存在了。
  //    ⛔ 锚点不跟着改 ⇒ 反证脚本会"静默失效"（变异没发生 ⇒ 假绿）。
  await check('判别力①：让 packagesForCoach 不再做档案归属判定 ⇒ 变红', () => {
    withDrift('utils/member-booking-view.js', source => source.replace(
      'archiveScopeOf(rows, id, trusted)',
      '(Array.isArray(rows) ? rows : [])'
    ), drifted => {
      assert.notStrictEqual(drifted.packagesForCoach(PACKAGES, COACH_OLD, ARCHIVE_NOW).length, 0,
        '⛔ 变异后仍然筛得干净 ⇒ 这条断言没有判别力')
    })
  })

  await check('判别力②：去掉 coachesForArchive 的档案闸门 ⇒ 变红', () => {
    withDrift('utils/member-booking-view.js', source => source.replace(
      "  return list.filter(row => row && keys.indexOf(String((row && row.coachKey) || '')) >= 0)",
      '  return list'
    ), drifted => {
      assert.ok(drifted.coachesForArchive(COACHES, PACKAGES, ARCHIVE_NOW).some(row => row.coachKey === COACH_OLD),
        '⛔ 变异后历史教练仍然没混进来 ⇒ 断言没有判别力')
    })
  })

  await check('判别力③：把按钮写成"已开启（永久有效）" ⇒ 变红', () => {
    withDrift('utils/notify-consent.js', source => source.replace(
      "const BUTTON_TEXT = '允许下一条微信提醒'",
      "const BUTTON_TEXT = '已开启（永久有效）'"
    ), drifted => {
      const made = drifted.settingsView('coach')
      assert.ok(notifyConsent.FORBIDDEN_PERMANENT_WORDS.some(word => made.buttonText.includes(word)),
        '⛔ 变异后禁用词没被抓到 ⇒ 断言没有判别力')
    })
  })

  await check('判别力④：让设置页忽略角色（教练也按会员）⇒ 变红', () => {
    // ⛔ 锚点必须**钉在 `settingsView` 内部**：`requestConsent()` 里有一行**完全同形**的
    //    `const role = kind === 'member' ? 'member' : 'coach'`，`String.replace` 只替换第一处
    //    ⇒ 裸锚打不到 settingsView ⇒ 变异后教练仍显示"教练"（判据假绿）。带上函数名即可唯一。
    withDrift('utils/notify-consent.js', source => {
      const anchor = "function settingsView(kind, options = {}) {\n  const role = kind === 'member' ? 'member' : 'coach'"
      assert.ok(source.includes(anchor), '⛔ 锚点失效：settingsView 的 role 解析改结构了，判据必须跟着改（不许降断言）')
      return source.replace(anchor, "function settingsView(kind, options = {}) {\n  const role = 'member'")
    }, drifted => {
      assert.notStrictEqual(drifted.settingsView('coach').roleText, '教练',
        '⛔ 变异后教练仍显示"教练" ⇒ 断言没有判别力')
    })
  })
}

main().catch(error => { console.error(error); process.exit(1) })
