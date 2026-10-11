// 我的课时 / 课时包
//
// ⭐ 本页的职责边界（2026-10-04 视觉整理 F）：
//   ① 顶部**不再**用一张过大的数字卡占据首屏 —— 总剩余只是**一行摘要**，不是主角；
//   ② 下面每份**独立**课时包必须把七件事一次说全：
//      类型 / 教练 / 购买或登记日期 / 初始节数 / 已使用 / 剩余 / 当前状态；
//   ③ 状态一律说人话（active → 使用中、reversed → 已撤销），⛔ 界面上不许出现英文枚举。
//
// ⛔ 三条不许越过的界：
//   ① **不许合并、不许换算**：每一份课包仍是独立一行，`total / used / remaining` 全部**直读**
//      服务端 `sanitizePackage` 下发的值。⛔ 绝不用 `total - used` 反推 `remaining`
//      （那是展示层反推业务字段，§96 已定过这条规矩；`member-archive-ui` ⑤ 有判别力测试钉着）。
//   ② 裁剪只走 `member-archive-state`（全站唯一出口），⛔ 本页不许自己写第二套 filter。
//   ③ 颜色一律读 `--member-*`（由 `theme.cssVars()` 注入），本页 wxss 不写死色值。
const directory = require('../../utils/member-directory')
const theme = require('../../utils/member-theme')
const view = require('../../utils/member-view-model')

// ⭐ 课时包状态的**人话字典**（全站唯一出口，⛔ 界面不许直接渲染 `status` 英文枚举）。
//   为什么必须是人话：会员看到 "reversed" 只会以为是加载失败或系统 bug，
//   而"已撤销"明确告诉她**这一份已经被作废了、不再计入可用课时**。
//   ⚠️ 未知状态**不许**猜成"使用中"（那会把一份看不懂的课包算成可用）⇒ 落到「状态待确认」。
const PACKAGE_STATUS_TEXT = {
  active: { text: '使用中', tone: '' },
  reversed: { text: '已撤销', tone: 'muted' }
}
const PACKAGE_STATUS_FALLBACK = { text: '状态待确认', tone: 'muted' }
function packageStatusOf(status) {
  return PACKAGE_STATUS_TEXT[String(status || '')] || PACKAGE_STATUS_FALLBACK
}

// ⭐ 把一份课包投影成"七件事齐全"的展示对象（⛔ 纯展示，⛔ 不做任何数值运算）。
//   ⚠️ `coach` 是服务端下发的对象（`{ coachKey, displayName }`），⛔ 不许假设它一定存在。
function packageViewOf(row) {
  const pkg = row || {}
  const status = packageStatusOf(pkg.status)
  return {
    packageViewId: String(pkg.packageViewId || ''),
    typeName: String(pkg.typeName || '') || '课程',
    coachName: String((pkg.coach && pkg.coach.displayName) || '') || '教练',
    // ⛔ 日期没记录就说"日期未记录"，⛔ 绝不拿今天 / 首次购买时间冒充（那会让"什么时候买的"变成假答案）。
    saleDateText: String(pkg.saleDate || '') || '日期未记录',
    // ⭐ 三个数各自**独立**呈现，⛔ 不排成"三个等权重的大数字"（那在暗示 total-used=remaining 这条并不总成立的等式）。
    total: Number(pkg.total || 0),
    used: Number(pkg.used || 0),
    remaining: Number(pkg.remaining || 0),
    statusText: status.text,
    statusTone: status.tone,
    isReversed: String(pkg.status || '') === 'reversed'
  }
}

// ⭐ 顶部那一行摘要：只回答"我现在一共还能约几节"，⛔ 不再是 86rpx 的大数字卡。
//   多份档案时**必须**说清这是合计（老事故：把 N 份档案的课时加在一起却让人以为是"我的课"）。
// ⚠️ `note` 只作为**给测试与调试看的口径自述**；模板里那行说明走的是三元表达式，
//    因为"合计口径"这句话必须能被静态断言钉住，⛔ 只拼在 JS 里就没人能钉了。
function summaryOf(scope) {
  const archives = scope.archives || []
  const remaining = Number((scope.summary && scope.summary.remaining) || 0)
  const multiple = archives.length > 1
  return {
    remaining,
    multiple,
    archiveCount: archives.length,
    label: multiple ? '多份会员资料合计' : '当前可用课时',
    note: multiple
      ? `这是 ${archives.length} 份会员资料加在一起的总节数，不是一个人的课时；下面按资料分别列出`
      : '下面是每一份课时包各自登记的剩余节数，加在一起就是你现在能约的节数',
    // ⛔ 多份时逐份列出（"合计"这个数从哪来的必须可核对）
    breakdown: multiple
      ? archives.map(row => ({ archiveId: String(row.archiveId || ''), name: row.name, remaining: Number(row.remaining || 0) }))
      : []
  }
}

Page({
  data: {
    summary: { remaining: 0, multiple: false, archiveCount: 0, label: '当前可用课时', note: '', breakdown: [] },
    groups: [], themeStyle: theme.cssVars(), notice: view.notice(null, {}),
    showAll: false, scopeLabel: '', multiple: false, allTotal: 0,
    // ⭐ 2026-10-06：0 份课时包的**明确空态**（⛔ 不许让"还没有可显示的课时包"这种
    //    含糊说法把"教练还没建包"和"数据没读到"混成一件事）
    emptyText: ''
  },
  onShow() {
    require('../../utils/auto-refresh').request('pageShow')
    this.refresh()
  },
  render(raw) {
    const rows = (raw && raw.packages) || []
    const owner = ((raw && raw.coaches) || []).find(row => row.isOwner) || {}
    const packages = rows.map(row => packageViewOf({
      ...row,
      packageViewId: row.packageKey,
      coach: { displayName: owner.displayName || '主管教练' }
    }))
    const remaining = Number(raw && raw.summary && raw.summary.remaining || 0)
    this.setData({
      summary: { remaining, multiple: false, archiveCount: 1, label: '当前可用课时', note: '', breakdown: [] },
      groups: packages.length ? [{ archiveId: 'current', grouped: false, packages }] : [],
      emptyText: packages.length ? '' : '你还没有课时包，请联系教练开通。',
      themeStyle: theme.cssVars(),
      notice: [], scopeLabel: '当前会员资料', multiple: false, allTotal: remaining
    })
  },
  toggleAll() {
    this.setData({ showAll: !this.data.showAll })
    this.refresh()
  },
  async refresh() {
    const result = await directory.dashboard()
    if (result && result.ok) return this.render(result)
    this.setData({ groups: [], emptyText: (result && result.message) || '暂时读不到课时包，请下拉刷新。' })
  }
})

