const { resolve, cssVars } = require('./member-theme')

const ENV_NAME = { production: '正式区', sandbox: '测试区' }
function envName(value) { return ENV_NAME[value] || '未知环境' }
function timeText(row) { return row ? `${row.date || ''} ${String(row.hour || 0).padStart(2, '0')}:${String(row.minute || 0).padStart(2, '0')}` : '' }
// ⭐⭐ 2026-10-06：服务端 `warnings` 的**人话字典**。
//   ⛔ 根因：`readMyMemberData` 在 head 查不到 / 查到多份时会 `continue` 丢掉整份档案，
//      但 `state` 仍然是 `'ready'` ⇒ 页面显示"数据已就绪"，会员却看到 0 课时、0 教练。
//      ⇒ 这类"被跳过的档案"**必须**翻译成普通用户看得懂的话，⛔ 绝不再伪装成正常空状态。
//   ⚠️ 括号里保留原始 code：它是排查用的（云开发日志 / 测试断言都靠它），
//      ⛔ 但**绝不**让 code 成为界面上唯一的一句话（用户看 `COACH_DATASET_HEAD_AMBIGUOUS` 等于没说）。
const WARNING_TEXT = Object.freeze({
  COACH_DATASET_HEAD_AMBIGUOUS: '有一位教练的数据档案不止一份，系统暂时分不清该读哪一份',
  COACH_DATASET_UNAVAILABLE: '有一位教练的数据档案暂时读不到（可能还没有初始化完成）'
})
const WARNING_FALLBACK = '有一位教练的数据这次没有读完整'
const WARNING_SUFFIX = '该教练的课时与预约这次没有被算进来。'
// ⛔ 未知 code 也**必须**说人话（⛔ 不许把裸错误码单独摆给会员看）。
function warningTextOf(row) {
  const code = String((row && row.code) || '')
  const head = WARNING_TEXT[code] || WARNING_FALLBACK
  return code ? `${head}（${code}）。${WARNING_SUFFIX}` : `${head}。${WARNING_SUFFIX}`
}

// ⭐ 异常状态必须"看得见"：unregistered / 环境不匹配 / warnings 都不得伪装成
//   「0 课时 / 无预约 / 无记录 / 无教练」的正常空状态（2026-09-26 真机事故的直接教训）。
function notice(data, context) {
  const ctx = context || {}, lines = [], state = data && data.state || 'unregistered'
  if (!data) lines.push('还没有读到会员数据，下面是空数据，不是真实余额。')
  else if (state === 'unregistered') lines.push(`当前「${envName(data.environment)}」没有读到会员账号（账号不存在或未激活），下面显示的是空数据，不是真实余额。`)
  else if (state === 'needs-claim') lines.push('会员账号已存在，但还没有认领任何教练记录。')
  if (ctx.expected === 'sandbox' && ctx.environment !== 'sandbox') lines.push(`上次是在「测试区」，这次启动后没有恢复成测试区（当前是「${envName(ctx.environment)}」）。`)
  else if (ctx.expected !== 'sandbox' && ctx.environment === 'sandbox') lines.push(`当前是「测试区」，与保存的会员环境（「${envName(ctx.expected)}」）不一致。`)
  ;(data && data.warnings || []).forEach(row => lines.push(warningTextOf(row)))
  return lines
}
// ⭐⭐ 2026-10-06：「档案被**悄悄丢掉**」这件事必须在界面上说得出来。
//   服务端（`readMyMemberData`）在 head 查不到 / 查到多份时会 `continue` 丢掉整份档案，
//   却仍然回 `state:'ready'` ⇒ 会员看到的是"数据已就绪"的**空白页**，根本不知道少了一份。
//   ⇒ 这里把服务端留在 `warnings` 里的证据翻成人话，⛔ 绝不让异常冒充正常。
const INCOMPLETE_ONE = '这份会员资料暂时读取不完整，请稍后重试。'
function incompleteTextOf(data) {
  const rows = Array.isArray(data && data.warnings) ? data.warnings : []
  // ⭐ 服务端修好之后会直接下发 `degraded:true` 的档案行 ⇒ 那时按**档案行**数。
  const archives = Array.isArray(data && data.archives) ? data.archives : []
  const degraded = archives.filter(row => row && row.degraded === true).length
  const count = degraded || rows.length
  if (!count) return ''
  if (count === 1) return `${INCOMPLETE_ONE}其余课时与预约不受影响。`
  return `有 ${count} 份会员资料暂时读取不完整，请稍后重试。其余课时与预约不受影响。`
}

// ------------------------------------------------------------------ 学员档案（claim）分组（**纯展示**）
//
// ⭐ 2026-10-01：一个会员账户可以认领**多份**学员档案（既定模型，不改）。
//    课包此前是一个扁平列表 ⇒ 两份档案的课时被混在一起，会员分不清。
//    ⇒ 按服务端下发的 `archiveId` 分组；每组的剩余课时由服务端算好（`archives[].remaining`）。
//
// ⛔ 只分组、不合并、不换算：**每份课时包仍是独立一行**，业务规则一个字没动。
// ⛔ 向后兼容：`archives` 为空（云端还没部署）⇒ 退化成**一个组**，界面与改造前逐字相同。
function archivesOf(data) {
  const rows = Array.isArray(data && data.archives) ? data.archives : []
  return rows.filter(row => row && row.archiveId).map(row => ({
    archiveId: String(row.archiveId || ''),
    name: String(row.name || '').trim() || '训练档案',
    coachName: String((row.coach && row.coach.displayName) || '').trim() || '教练',
    remaining: Number.isFinite(Number(row.remaining)) ? Number(row.remaining) : 0,
    packageCount: Number.isFinite(Number(row.packageCount)) ? Number(row.packageCount) : 0
  }))
}
function remainingOf(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && row.status !== 'reversed')
    .reduce((sum, row) => sum + (Number.isFinite(Number(row && row.remaining)) ? Number(row.remaining) : 0), 0)
}
// 分组结果：`[{ archiveId, name, coachName, remaining, packageCount, packages, grouped }]`
//   `grouped === false` ⇒ 只有一个组（单档案 或 老云端）⇒ 页面不显示档案标题，保持原样。
function packageGroups(data) {
  const packages = Array.isArray(data && data.packages) ? data.packages : []
  const archives = archivesOf(data)
  if (archives.length < 2) {
    // ⛔ `archiveId` 用固定串 'all' 而不是空串：WXML 的 `wx:key` 认不出空串（会退化成警告），
    //    而这一组本来就是"不分组"的那一种（单档案 或 老云端还没下发 archives）。
    return [{ archiveId: 'all', name: archives.length ? archives[0].name : '', coachName: archives.length ? archives[0].coachName : '', remaining: remainingOf(packages), packageCount: packages.length, packages, grouped: false }]
  }
  const buckets = archives.map(row => ({ ...row, packages: [] }))
  const byId = new Map(buckets.map(row => [row.archiveId, row]))
  const orphans = []
  packages.forEach(row => {
    const bucket = byId.get(String((row && row.archiveId) || ''))
    if (bucket) bucket.packages.push(row)
    else orphans.push(row)
  })
  // ⛔ 一份课包都不许丢：认不出档案的（理论上不会发生）一律进最后一组，绝不静默丢弃。
  if (orphans.length) buckets.push({ archiveId: 'other', name: '其他训练档案', coachName: '', remaining: remainingOf(orphans), packageCount: orphans.length, packages: orphans, grouped: true })
  return buckets
}
// 顶部那句"合计"要不要说清：多份档案 ⇒ 明说是合计；单份 ⇒ 保持原来的话。
function balanceHead(data) {
  const archives = archivesOf(data), summary = data && data.summary || {}
  const total = Number.isFinite(Number(summary.remaining)) ? Number(summary.remaining) : 0
  return {
    total, archiveCount: archives.length,
    multiple: archives.length > 1,
    breakdown: archives.length > 1
      ? archives.map(row => ({ archiveId: row.archiveId, name: row.name, coachName: row.coachName, remaining: row.remaining }))
      : []
  }
}
// 已认领的档案份数（「我的」页据此决定要不要显示那条入口；只有 >1 才显示）。
function archiveCountOf(data) {
  const explicit = Number(data && data.archiveCount)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return archivesOf(data).length
}
function home(data) {
  const member = data && data.member || {}, theme = resolve(member.theme), recent = (data && data.recentTraining || []).slice(0, 1)[0] || null
  return {
    state: data && data.state || 'unregistered', member, theme, themeStyle: cssVars(), summary: data && data.summary || { remaining: 0, completedThisMonth: 0 },
    balance: balanceHead(data), archives: archivesOf(data), archiveCount: (data && Number(data.archiveCount)) || archivesOf(data).length,
    nextBooking: data && data.nextBooking ? { ...data.nextBooking, timeText: timeText(data.nextBooking) } : null,
    recent: recent ? { ...recent, timeText: timeText(recent), actionNames: (recent.items || []).slice(0, 3).map(item => item.name).filter(Boolean).join(' / ') } : null,
    coaches: data && data.coaches || [], warnings: data && data.warnings || []
  }
}
module.exports = { home, notice, envName, timeText, warningTextOf, WARNING_TEXT, WARNING_FALLBACK, WARNING_SUFFIX, incompleteTextOf, INCOMPLETE_ONE, archivesOf, archiveCountOf, packageGroups, balanceHead, remainingOf }
