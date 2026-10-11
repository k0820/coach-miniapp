// 本轮 UI 整理 · 学员名单「一人一行」+ 会员详情课时包「横向紧凑卡」。
//
// 真机问题（用户原话）：学员名单一个学员占一大片 —— 姓名 + 每人每个课时包各占一行 + 进度条，
// 37 个会员要一直往下滑才能找到人；右下那颗"只有个加号"的圆球也看不出是"新增会员"。
//
// 目标（本文件逐条钉死）：
//   ① 名单 = **一人一行**：姓名 + 关键状态（剩余 x / 总量 节）+ 右箭头，点整行进详情；
//   ② 37 人必须"少滑几屏"：行占位 = height + margin-bottom，落在 88~116rpx（够大能点、够小能塞）；
//   ③ 新增按钮改成右下 tabBar 上方的「＋ 新增会员」胶囊，且**不遮挡任何一行**；
//   ④ 课时包默认态 = 横向紧凑卡（图标 / 名称 / 剩余-总量 / 进度 / 单价或赠送 / 管理入口），约 3 个一屏；
//   ⑤ ⛔ 扣课、余额、销售数据、各入口**一个都不许动** —— 新增的只是纯视图字段。
//
// ⛔ 本文件只读：不写任何业务数据、不碰 Production / Sandbox、不改准入规则、不新建 Storage。
// ⛔ 反证见 tests/_students-one-row-list-mutate.js（只改内存文本副本，磁盘一个字节不动）。
// ⭐ 静态契约与反证共用 tests/helpers/ui-round5-contract.js 里的**同一份判据函数**。

const assert = require('assert')
const path = require('path')
const fs = require('fs')
const { createWorld, copy, settle } = require('./helpers/local-first-world')
const contract = require('./helpers/ui-round5-contract')

const PROJ = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(PROJ, p), 'utf8')

const SOURCES = {
  wxml: read('pages/students/students.wxml'),
  wxss: read('pages/students/students.wxss'),
  appWxss: read('app.wxss'),
  js: read('pages/students/students.js')
}
const SETTINGS = { renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 0, salesCommissionRate: 0 }

// ══════════════════ 一、静态契约（与反证同一份判据） ══════════════════

const ITEMS = contract.studentsContract(SOURCES)
const failed = ITEMS.filter(entry => !entry.pass)
assert.strictEqual(failed.length, 0,
  '学员页静态契约未通过（' + failed.length + '/' + ITEMS.length + '）：\n'
  + failed.map(entry => '  ✗ ' + entry.name + ' → ' + entry.detail).join('\n'))
console.log('① 学员页静态契约：' + ITEMS.length + ' 条全过')

// ══════════════════ 二、密度：37 人到底要滑几屏 ══════════════════
// 用 fixture 里**实测**过的真机窗口（iPhone 12/13 Pro，390×671，rpx=0.52）算，
// 而不是凭"感觉紧凑了"。判据有牙：行高一旦被撑到 160rpx，每屏人数就会掉到 8 以下。

const FX = JSON.parse(read('tests/fixtures/week-grid-rendered.json'))
const DEVICE = FX.measuredRound4.device
const cssPlain = contract.stripCss(SOURCES.wxss)
const appPlain = contract.stripCss(SOURCES.appWxss)
const ROW_H = contract.declRpx(cssPlain, '.students-list-page .student-row', 'height')
const ROW_GAP = contract.declRpx(cssPlain, '.students-list-page .student-row', 'margin-bottom')
// ⭐ 2026-10-03（本轮真机验收）：底部让位**整体取消** —— 悬浮胶囊与安全带（144rpx）一起删掉，
//   「＋新增」搬进标题行 ⇒ 名单**回收**那一块空间。
//   ⛔ 现在底部**唯一**的内边距 = 页面为原生下拉刷新多出来的那 40rpx（几何配平，不是让位）：
//      少了它，滚动区下沿会跑到视口底**再往下** 20px（最后一行被推出屏幕）；
//      多了它，底部又变回"白占的一块地"（正是被否掉的形状）。
const LIST_PAD_TOP = contract.paddingRpx(cssPlain, '.students-list-page', 'top')
const LIST_PAD_BOTTOM = contract.paddingRpx(cssPlain, '.students-list-page', 'bottom')
const PULLDOWN_ROOM = Number((/100vh\s*\+\s*([\d.]+)rpx/
  .exec(contract.ruleBodies(cssPlain, '.students-list-page').join(';')) || [, 0])[1])
// ⛔ 旧形状的历史数字（悬浮胶囊 72+24=96 + 下拉余量 40 = 136 ⇒ 实际取 144）：
//    只用来算"回收了多少"，任何判据都**不许**再依赖它（它已经不是一个活的数）。
const OLD_BAND_BOTTOM = 144
const CAPSULE_BAND = 72 + 24 // app.wxss .fab-capsule（已删除）：height 72rpx + bottom 24rpx

assert.ok(ROW_H && ROW_GAP !== null && LIST_PAD_TOP !== null && PULLDOWN_ROOM > 0,
  '行高 / 行距 / 页面顶部内边距 / 页面下拉余量都必须可解析（下拉余量 = ' + PULLDOWN_ROOM + 'rpx）')
// ① 名单下沿**正好**压在视口底（tabBar 上沿）：padding-bottom 必须等于下拉余量，不多不少。
assert.strictEqual(LIST_PAD_BOTTOM, PULLDOWN_ROOM,
  '⛔ 名单下沿没有落在视口底：padding-bottom ' + LIST_PAD_BOTTOM + 'rpx ≠ 页面下拉余量 '
  + PULLDOWN_ROOM + 'rpx ⇒ 要么最后一行被推出屏幕，要么底部又白占一块')
// ② 安全带必须**真的不存在**（留着就是被否掉的形状）
// ⛔ 注释里提到旧类名是"说明"，不是"回潮" ⇒ 两边都先剥注释再匹配。
assert.ok(!/\.students-fab-band/.test(cssPlain) && !/students-fab-band/.test(contract.stripHtml(SOURCES.wxml)),
  '⛔ .students-fab-band（给悬浮胶囊留的底部安全带）回来了 ⇒ 名单又开始白占底部空间')

// ⛔ 下面这个是**上界估算**：只扣掉页面顶部与底部内边距，**没有**扣页头「我的学员」与
//    「多教练服务」那一块（它们也占高度）。它证明的是"行本身够紧凑"，不是"真机上正好 8 个"。
const windowRpx = DEVICE.windowHeight / DEVICE.rpx
const usableRpx = windowRpx - LIST_PAD_TOP - LIST_PAD_BOTTOM
// ⭐ 回收证明：同样这块屏，旧形状（多一条 144rpx 安全带）会少装多少人。
const oldUsableRpx = windowRpx - LIST_PAD_TOP - LIST_PAD_BOTTOM - OLD_BAND_BOTTOM
const perScreenOld = Math.floor(oldUsableRpx / (ROW_H + ROW_GAP))
const perScreen = Math.floor(usableRpx / (ROW_H + ROW_GAP))
const screensFor37 = Math.ceil(37 / perScreen)
assert.ok(perScreen >= 8,
  '一屏至少要塞下 8 个会员才算"减少滚动"：可用（上界）' + Math.round(usableRpx) + 'rpx ÷ 每行 '
  + (ROW_H + ROW_GAP) + 'rpx = ' + perScreen + ' 人/屏')
assert.ok(screensFor37 <= 5, '37 个会员最多滑 5 屏，上界估算 ' + screensFor37 + ' 屏')
// ⭐ 回收必须**真的多出人来**，不是"数学上单调"：旧形状每屏人数必须**严格更少**。
assert.ok(perScreen > perScreenOld,
  '⛔ 删掉安全带没换来任何空间：每屏 ' + perScreen + ' 人，与旧形状（含 ' + OLD_BAND_BOTTOM
  + 'rpx 安全带）的 ' + perScreenOld + ' 人一样 ⇒ 那块空间被别的东西吃掉了')
console.log('② 密度实测：一人一行 = ' + ROW_H + 'rpx + ' + ROW_GAP + 'rpx 间距 ⇒ 每屏约 ' + perScreen
  + ' 人（上界），37 人约 ' + screensFor37 + ' 屏；底部 **无**安全带（名单回收 '
  + OLD_BAND_BOTTOM + 'rpx ⇒ 每屏 ' + perScreenOld + ' → ' + perScreen + ' 人）')

// ══════════════════ 三、语义：rowSummaryOf 真算得出这些数字 ══════════════════
// 这一节不看源码文本，而是**真的把页面跑起来**：注入测试替身存储 → onShow → 读渲染数据。
// 只有这样才能证明"剩余/总量/快用完"不是模板里写死的字。

const PKG = (id, type, total, remaining, extra = {}) => ({ id, type, total, used: total - remaining, remaining, price: 300, status: 'active', createdAt: 1, ...extra })
const STUDENTS = [
  // 19/20 + 2/10：合计 21/30，其中 1 个快用完
  { id: 'stu-p1', name: '一个快用完的会员', phone: '13800000001', createdAt: 1, packages: [PKG('p1a', '常规训练', 20, 19), PKG('p1b', '普拉提', 10, 2)] },
  // 唯一一个课时包已用完：必须明说"未购课时包"，不许空白
  { id: 'stu-p2', name: '课时包已用完的会员', phone: '', createdAt: 2, packages: [PKG('p2a', '常规训练', 5, 0)] },
  // 3/10 + 1/8：两个都快用完 ⇒ 文案必须变成"N 个课时包快用完"
  { id: 'stu-p3', name: '两个都快用完的会员', phone: '13800000003', createdAt: 3, packages: [PKG('p3a', '常规训练', 10, 3), PKG('p3b', '体态调整', 8, 1)] }
]

function applyPath(target, key, value) {
  const tokens = String(key).replace(/\[(\d+)\]/g, '.$1').split('.')
  let node = target
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]
    if (node[token] == null) node[token] = /^\d+$/.test(tokens[i + 1]) ? [] : {}
    node = node[token]
  }
  node[tokens[tokens.length - 1]] = value
}

/** 用测试替身加载学员页（require.cache 隔离，不污染别的测试） */
function loadStudentsPage() {
  const file = path.join(PROJ, 'pages', 'students', 'students.js')
  let captured = null
  const previous = global.Page
  global.Page = definition => { captured = definition }
  delete require.cache[require.resolve(file)]
  require(file)
  if (previous) global.Page = previous; else delete global.Page
  if (!captured) throw new Error('学员页没有被注册。')
  const instance = {
    data: copy(captured.data),
    setData(patch, callback) { Object.keys(patch).forEach(key => applyPath(this.data, key, copy(patch[key]))); if (callback) callback() }
  }
  Object.keys(captured).forEach(key => { if (typeof captured[key] === 'function' && key !== 'data') instance[key] = captured[key].bind(instance) })
  return instance
}

/** 独立复算：不信 rowSummaryOf，用 visiblePackages 自己再加一遍 */
const recompute = list => ({
  rowHas: list.length > 0,
  rowLeft: list.reduce((n, item) => n + Number(item.left || 0), 0),
  rowTotal: list.reduce((n, item) => n + Number(item.total || 0), 0)
})

const world = createWorld({ allowMaskedCommands: true })
world.seed({ students: copy(STUDENTS), bookings: [], incomes: [], sales: [], settings: copy(SETTINGS), customExercises: [] })

const page = loadStudentsPage()
page.onShow()
page.render()

const studentOf = id => (page.data.students || []).find(entry => entry.id === id)

async function checkSemantics() {
  await settle()

  const p1 = studentOf('stu-p1')
  assert.ok(p1, '会员必须还在名单里（只改渲染结构，不许把人弄丢）')
  assert.strictEqual(p1.visiblePackages.length, 2, '两个都有剩余 ⇒ 两个都进渲染数据')
  assert.strictEqual(p1.rowHas, true)
  assert.strictEqual(p1.rowLeft, 21, '剩余合计必须是 19 + 2 = 21')
  assert.strictEqual(p1.rowTotal, 30, '总量合计必须是 20 + 10 = 30')
  assert.strictEqual(p1.rowWarn, true, '2/10 已经 <= 阈值 10 ⇒ 必须报"快用完"')
  assert.strictEqual(p1.rowWarnText, '即将用完', '只有一个快用完时文案是「即将用完」')
  assert.deepStrictEqual(recompute(p1.visiblePackages), { rowHas: p1.rowHas, rowLeft: p1.rowLeft, rowTotal: p1.rowTotal },
    'rowSummaryOf 的分子分母必须与 visiblePackages 独立复算一致（防"换个数组算"）')

  const p2 = studentOf('stu-p2')
  assert.strictEqual(p2.packages.length, 1, '数据层必须仍然拿着那个用完的课时包（续费/统计/撤销都靠它）')
  assert.strictEqual(p2.visiblePackages.length, 0, '用完的课时包不进渲染数据')
  assert.strictEqual(p2.usedUpCount, 1, '必须能报出"已收起 1 个"')
  assert.strictEqual(p2.rowHas, false, '没有可见课时包 ⇒ rowHas=false（模板据此显示"未购课时包"）')
  assert.strictEqual(p2.rowLeft, 0)
  assert.strictEqual(p2.rowTotal, 0)
  assert.strictEqual(p2.rowWarn, false)

  const p3 = studentOf('stu-p3')
  assert.strictEqual(p3.rowLeft, 4, '剩余合计必须是 3 + 1 = 4')
  assert.strictEqual(p3.rowTotal, 18)
  assert.strictEqual(p3.rowWarn, true)
  assert.strictEqual(p3.rowWarnText, '2 个课时包快用完', '两个都快用完时文案必须报数量')

  // 授权会员走的是**同一个** rowSummaryOf：直接按单测调用，看它是否同一口径
  const authCard = page.authorizedCard({
    key: 'authkey-1',
    member: {
      name: '授权会员', studentId: 'auth-stu-1', phone: '',
      packages: [{ packageId: 'ap1', type: '常规训练', total: 20, remaining: 18 }, { packageId: 'ap2', type: '普拉提', total: 10, remaining: 0 }]
    }
  }, SETTINGS.renewThreshold)
  assert.strictEqual(authCard.visiblePackages.length, 1)
  assert.strictEqual(authCard.rowHas, true)
  assert.strictEqual(authCard.rowLeft, 18)
  assert.strictEqual(authCard.rowTotal, 20)
  assert.strictEqual(authCard.rowWarn, false, '18/20 没到阈值，不许误报')
  assert.deepStrictEqual(recompute(authCard.visiblePackages), { rowHas: authCard.rowHas, rowLeft: authCard.rowLeft, rowTotal: authCard.rowTotal },
    '授权会员与本地会员必须用同一份 visiblePackages 算同一组字段')

  // 只读自证：渲染前后本机数据/云端快照的课时包数量一个字节都没变
  const after = world.snapshot()
  assert.deepStrictEqual(after.students.map(s => s.packages.length), STUDENTS.map(s => s.packages.length),
    '渲染不许改动本机 coachDB 里任何学员的课时包数量')
  assert.deepStrictEqual(after.students.map(s => s.packages.map(p => p.remaining)),
    STUDENTS.map(s => s.packages.map(p => p.remaining)),
    '渲染不许改动任何 remaining（扣课/余额是钱，视图层碰不得）')

  console.log('③ 语义实测：p1 剩余 21/30（1 个快用完）· p2 未购课时包 · p3 剩余 4/18（2 个快用完）'
    + ' · 授权会员同一口径 · 数据层零改动')
}

checkSemantics().then(() => {
  console.log('ALL STUDENTS ONE-ROW LIST TESTS PASSED（静态契约 ' + ITEMS.length + ' 条 + 密度 + 语义）')
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
