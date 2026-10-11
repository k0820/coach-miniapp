// ─────────────────────────────────────────────────────────────────────────────
// 「当前使用哪份训练档案」—— 会员端**唯一**的档案选择状态（2026-10-03 新需求）
//
// ⭐⭐ 为什么必须有这个模块：在此之前**整个项目根本没有"当前档案"这个概念**
//    （`currentArchive` / `selectedArchive` 全库零命中）。多份档案只是"并列展示 + 课时相加"，
//    首页大字永远是**账号昵称**，于是"我明明认领了 SB，为什么首页还写测试会员"——
//    不是选错了，是**根本没得选**。本模块就是那个"得选"的唯一出处。
//
// ⛔⛔ 四条不可越界的规则（全部由 tests/member-archive-switch.test.js 钉死）：
//   ① **绝不静默选"最新认领的那份"**。多档案且用户还没选过 ⇒ 一律 `need-choice`，
//      由界面明确让用户选。猜错档案 = 把 A 的课时包当成 B 的，整屏数据都错。
//   ② **单份档案可以自动选中**，但状态里必须带 `autoSelected: true` ⇒ 界面**仍然要显示**
//      "当前使用的是哪一份"，不能因为"只有一份就默认对了"而让用户不知道。
//   ③ **Sandbox 与 Production 严格隔离**：存储键带环境名，测试区选的那份**绝不会**跑到正式区。
//      （这条与 §97「角色持久化了、环境没有持久化」那次真机事故是同一类错误。）
//   ④ 切换档案**只改本机状态**，不写云端；云端那条唯一入口是"认领/解除认领"。
//      换句话说：当前档案是**视图状态**，不是业务数据。
//
// ⛔ 范围裁剪的唯一出口是本文件的 `scopeOf()`：**所有页面都调它**，不许各自 filter 一遍。
//    否则一定会出现"首页是 A 档案、课时页是 B 档案"（用户需求 A.8 明确点名要防这个）。
const runtime = require('./data-runtime')
const view = require('./member-view-model')

// ⚠️ 键名带环境后缀：测试区与正式区各存各的，互不串（规则 ③）。
const KEY_PREFIX = 'coachMemberCurrentArchive:'
const environment = () => runtime.environment() === 'sandbox' ? 'sandbox' : 'production'
const storageKey = (env = environment()) => `${KEY_PREFIX}${env}`

function readStored(env = environment()) {
  try {
    const value = wx.getStorageSync(storageKey(env))
    // ⛔ 只接受非空字符串：老版本/别的模块可能往同一个键写过别的东西（曾经有先例：
    //    同一个键被两个用途各写一次，冷启动回来就串味）。形状不对就当"没选过"，绝不硬读。
    return typeof value === 'string' && value ? value : ''
  } catch (error) { return '' }
}
function writeStored(archiveId, env = environment()) {
  const value = String(archiveId || '').trim()
  try { wx.setStorageSync(storageKey(env), value) } catch (error) { /* 写不进就只是"下次要再选一次"，不许因此报错 */ }
  return value
}
function clearStored(env = environment()) {
  try { wx.removeStorageSync ? wx.removeStorageSync(storageKey(env)) : wx.setStorageSync(storageKey(env), '') } catch (error) { /* 同上 */ }
}

// 会员端可见的档案（与 member-view-model 的口径**逐字一致**：不透明 id + 名称 + 教练 + 剩余 + 课包数）
// ⭐ 2026-10-05：归档功能已整体撤回 ⇒ 档案上**不再有**"已结束服务/归档"这个状态，
//    认领了哪几份就展示哪几份，一个都不隐藏。
function archivesOf(data) {
  return view.archivesOf(data)
}
function archiveById(list, archiveId) {
  const id = String(archiveId || '')
  return (Array.isArray(list) ? list : []).find(row => row && String(row.archiveId || '') === id) || null
}

// ── 决定"当前用哪一份"（纯函数，不写盘） ───────────────────────────────────────
// 返回形状：`{ mode, archiveId, autoSelected, reason }`
//   mode = 'none'        一份档案都没有（未认领）
//   mode = 'single'      只有一份，已自动选中（autoSelected=true，界面要显示）
//   mode = 'chosen'      多份，用户此前选过，且这一份还在
//   mode = 'need-choice' 多份且**没有有效选择** ⇒ 必须让用户明确选（⛔ 绝不猜）
function decide(data, stored) {
  const archives = archivesOf(data)
  if (!archives.length) return { mode: 'none', archiveId: '', autoSelected: false, reason: 'no-archive' }
  if (archives.length === 1) return { mode: 'single', archiveId: archives[0].archiveId, autoSelected: true, reason: 'only-one' }
  const hit = archiveById(archives, stored)
  if (hit) return { mode: 'chosen', archiveId: hit.archiveId, autoSelected: false, reason: 'remembered' }
  return { mode: 'need-choice', archiveId: '', autoSelected: false, reason: stored ? 'stale' : 'never-chosen' }
}

// 读盘 + 决策。⛔ **不在这条路径上写盘**：单份自动选中会在下次进入时自然命中，
//   这里写不写都一样 ⇒ 少一次无意义的写，也避免"进页面就改存储"这种副作用。
function current(data) { return decide(data, readStored()) }

// 用户（或替用户）做出选择。⛔ 只接受"当前确实存在"的档案 id —— 传一个不存在的 id
//   必须是**失败**而不是静默忽略：静默忽略会让界面显示"没选"，用户以为自己选上了。
function choose(archiveId, data) {
  const archives = archivesOf(data)
  const hit = archiveById(archives, archiveId)
  if (!hit) return { ok: false, code: 'ARCHIVE_NOT_FOUND', message: '没有找到这份训练档案。' }
  writeStored(hit.archiveId)
  return { ok: true, archiveId: hit.archiveId, mode: decide(data, hit.archiveId).mode }
}

// 解除认领 / 切换环境后清掉选择。⛔ 只清**本环境**那一个键。
function forget() { clearStored(); return { ok: true } }

// ── 范围裁剪：**所有页面唯一的取数出口** ────────────────────────────────────────
// `all: true` = 用户主动打开「查看全部档案」（此时不做裁剪，界面必须自己说明"这是多份档案合计"）。
function scopeOf(data, options = {}) {
  const archives = archivesOf(data)
  const state = current(data)
  const all = options.all === true
  const id = state.archiveId
  const keep = row => all || !id || String((row && row.archiveId) || '') === id
  const packages = (Array.isArray(data && data.packages) ? data.packages : []).filter(keep)
  const bookings = [
    ...(Array.isArray(data && data.recentTraining) ? data.recentTraining : []),
    ...(data && data.nextBooking ? [data.nextBooking] : [])
  ].filter(keep)
  const archive = archiveById(archives, id)
  const done = bookings.filter(row => String(row && row.status) === 'done')
  const month = monthPrefix()
  const upcoming = bookings
    .filter(row => String(row && row.status) === 'booked')
    .sort((a, b) => String(a && a.date).localeCompare(String(b && b.date)) || Number(a && a.hour) - Number(b && b.hour))
  // ⚠️ 「本月训练」按**当前档案**重新数，不复用合计值 —— 否则单档案时数字对不上、多档案时被算成全部。
  const completedThisMonth = done.filter(row => String(row && row.date).startsWith(month)).length
  // ⛔ 「查看全部档案」时剩余必须是**合计**（用户需求 F.3：必须明说"这是多份档案相加"），
  //    不能因为本机还存着一个 archiveId 就只显示那一份的数 —— 那会让"查看全部"名不副实。
  const remaining = all
    ? view.remainingOf(packages)
    : (archive ? Number(archive.remaining || 0) : Number((data && data.summary && data.summary.remaining) || 0))
  return {
    mode: state.mode, archiveId: id, autoSelected: state.autoSelected, reason: state.reason,
    all, archives, archive,
    packages, bookings,
    summary: { remaining, completedThisMonth, packageCount: packages.length },
    nextBooking: upcoming[0] || null,
    recentTraining: done.sort((a, b) => String(b && b.date).localeCompare(String(a && a.date)) || Number(b && b.hour) - Number(a && a.hour)),
    // 界面用得上的两句话（集中在这里，页面不要自己拼）
    needsChoice: state.mode === 'need-choice',
    hasAny: archives.length > 0
  }
}

function monthPrefix(date) {
  const now = date || new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

// ── 切换档案的**唯一**入口 ────────────────────────────────────────────────────
// ⛔ 三件事必须**一起**做，缺一件就会出现"看起来切了、其实数据还是旧的"（用户需求 A.8）：
//   ① 写选择（本机）→ ② 清可约时段缓存（它按上一份档案的教练集合算的）→ ③ 重新读一次云端数据。
// ⚠️ `require('./member-runtime')` 写在函数体内是**故意的**：member-runtime 会拉起一整条
//   读取/写命令链，模块顶层互相 require 容易在冷启动时形成环；函数内 require 只在真的要切时才发生。
function switchTo(archiveId, data, options = {}) {
  const picked = choose(archiveId, data)
  if (!picked.ok) return picked
  let cleared = 0
  try { cleared = require('./member-runtime').clearAvailability() } catch (error) { cleared = 0 }
  return { ...picked, availabilityCacheCleared: cleared, needsReread: options.reread !== false }
}

// 解除认领之后调用：如果解除的是**当前**那份，本机选择必须作废（否则下次进来会拿着
// 一个已经不存在的档案 id 去裁剪数据 ⇒ 整屏空）。⛔ 只清本环境。
function afterRelease(remainingArchives) {
  const left = Array.isArray(remainingArchives) ? remainingArchives : []
  if (!left.length) { clearStored(); return { ok: true, next: 'no-archive' } }
  if (!readStored()) return { ok: true, next: 'need-choice' }
  return { ok: true, next: 'kept' }
}

// ── 页面取数的**窄化**入口 ────────────────────────────────────────────────────
// ⭐ 约课页 / 我的预约 / 训练记录这三个页面各自有自己的视图模型（`member-booking-view` 等），
//   ⛔ 不许它们各自写一遍 filter（那一定会出现"这页是 A 档案、那页是 B 档案"）。
//   ⇒ 它们统一在把数据交给自己的视图模型**之前**先调本函数。
// ⚠️ 返回的是**浅拷贝**：只替换被裁剪的三个字段，其余（summary / member / coaches / warnings…）原样透传，
//   ⛔ 绝不改原对象（缓存里的那份是共享的）。
// ⛔ 一份档案都没有、或处于 need-choice（还没选）时**原样返回**：
//   此时页面应当显示"请先选择当前使用档案"，而不是给一个空列表 —— 空列表会被误读成"你没有课"。
function narrow(data) {
  if (!data) return data
  const state = current(data)
  if (state.mode === 'none' || state.mode === 'need-choice') return data
  const id = state.archiveId, keep = row => String((row && row.archiveId) || '') === id
  return {
    ...data,
    packages: (Array.isArray(data.packages) ? data.packages : []).filter(keep),
    recentTraining: (Array.isArray(data.recentTraining) ? data.recentTraining : []).filter(keep),
    nextBooking: keep(data.nextBooking) ? data.nextBooking : null
  }
}

module.exports = {
  environment, storageKey, readStored, archivesOf, archiveById, decide, current,
  choose, forget, switchTo, afterRelease, scopeOf, narrow, monthPrefix, KEY_PREFIX
}
