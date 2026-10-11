// M2 V1 正式多教练服务模型：教练端的**授权门面**（2026-09-28）。
//
// ⛔ 这一层**不产生任何业务事实**，只做三件事：
//   ① 读「授权目录」（云端只读投影：我能服务哪些会员、能用哪些课包、能看到哪些共享训练内容）；
//   ② 授权**写完之后**的一致性：权限变了 ⇒ 目录必须重拉一次，并让其它页面收到 permissionChanged；
//   ③ 把结果缓存成"最后一帧已知事实"，页面只读缓存 ⇒ 授权目录**绝不**混进八个业务集合的快照，
//      于是 checksum / 指纹 / 增量 / 完整性校验一个字节都不受影响（那是冻结区）。
//
// ⚠️ 授权命令的**发送**不在这里 —— 它必须走全项目唯一的写入口 `utils/mutate.js`（与其余命令同一条漏斗），
//    页面发完再调 `notePermissionChanged()`。刻意不在门面里再包一层 mutate：
//    两条发送路径早晚漂移，而"只有一条写入口"是本项目的硬护栏（见 tests/mutate-write-surface.test.js）。
//
// ⛔ 绝不复制会员或课时包：目录里的 studentId / packageId 都是**原来那一个**，
//   数字（remaining / reserved / used）是**对端那一行的真值**，不是本地推算出来的第二套余额。

const runtime = require('./data-runtime')
const autoRefresh = require('./auto-refresh')

const CACHE_PREFIX = 'coachAuthorizationDirectory_'
const CLOUD_FUNCTION = 'coachBusinessCommand'
// ⭐ 2026-09-29：缓存 key 只有环境一个维度是不够的 —— 同一台设备（同一个 Storage）里
//   换一位教练，命中的还是上一位教练那一帧 ⇒ 看到别人的会员名单 / 别人的课包。
//   所以 key 必须是 **环境 + 可信教练身份**。
//   ⛔ 身份只能有一个来源：**云端 directory 响应里的 `coachId`**（服务端从 OPENID 推导）。
//      绝不用姓名 / 手机号 / 头像去猜"现在是谁" —— 那两条都是**可以被同名或空值撞上**的值，
//      而且它们本身在业务上是可变的（改个名字就换了一王维？那就等于没有维度）。
const IDENTITY_PREFIX = 'coachAuthorizationIdentity_'
const LEGACY_CACHE_KEYS = ['coachAuthorizationDirectory_production', 'coachAuthorizationDirectory_sandbox']

// ⭐ 缓存形状版本（2026-09-28 真机 BUG 03 **二次**失败的原位修复）。
//
//   事故形状：上一轮只修了云端投影（课包补上 row 层的真实 packageId），
//   但**授权目录缓存是跨版本常驻的** —— 上传新版客户端不会清空 Storage。
//   于是 B 手机上那一帧"修复前写入的旧缓存"（课包只有 type / remaining，没有 packageId）
//   被新客户端当成有效事实：页面进入时 `loadDirectory({force:false})` 命中缓存 ⇒ 一次云调用都不发
//   ⇒ 课包列表照样渲染得出「常规训练」，但提交时 packageId 是空 ⇒ 云端「packageId不能为空」。
//
//   所以闸门必须有两道，**缺一道就会重演**：
//     ① 形状版本：缓存行记 `shape`，不等于当前版本就当作"没有缓存"（旧帧一律不许命中）；
//     ② 内容闸：目录里**任何一份**课包缺真实 packageId ⇒ 这一帧只配展示，不许拿去写。
//   ⚠️ 旧帧仍然会返回给**纯展示**的调用方（学员列表），但会带 `stale:true` ⇒ 谁都能看出它不是最新事实。
// ⚠️ 故意与云端 `DIRECTORY_SHAPE` 取**不同**的值：一个是"本地缓存行的形状"，一个是"云端响应的形状"。
//    同名会让"缓存形状"被误当成"云端版本水印"显示出来 ⇒ 云函数明明是旧版却显示新版（假绿）。
const CACHE_SHAPE = 'm2-dir-cache-2'
// 云端目录响应的版本水印（云函数与客户端是两份代码、不能共享常量 ⇒ 各写一份，只用于**显示**与人工核对部署版本）。
const EXPECTED_CLOUD_SHAPE = 'm2-dir-2'
const STALE_SHAPE_TEXT = '(旧版云函数)'

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const envName = environment => environment === 'sandbox' ? 'sandbox' : 'production'
const cacheKey = (environment, coachId) => (coachId ? `${CACHE_PREFIX}${envName(environment)}_${coachId}` : `${CACHE_PREFIX}${envName(environment)}`)
const identityKey = environment => `${IDENTITY_PREFIX}${envName(environment)}`

// ------------------------------------------------------------------ 可信身份（唯一来源：云端响应）
//
// ⚠️ 为什么必须先落这一层：换了人以后，客户端**不可能**在不问云端的情况下知道"现在是谁"
//    （这是云托管身份模型的固有约束：身份只存在于服务端）。所以这里能做的、也必须做的是：
//     ① 身份还没确认过 ⇒ **一帧缓存都不许用**（宁可不显示，也绝不把别人的名单渲染成我的）；
//     ② 每一次云读都**复核**身份 ⇒ 服务端给的 coachId 和上一次确认的不一样，就是换人了。
function readIdentity(environment) {
  const row = wx.getStorageSync(identityKey(environment))
  if (!row || typeof row !== 'object') return ''
  // ⛔ 只认**非空字符串**。对象 / 数组 / 数字也会被 String() 兜成非空文本
  //    （`String({})` 是 '[object Object]'）⇒ 那等于给了伪造空间。
  const value = row.coachId
  return typeof value === 'string' && value ? value : ''
}
function writeIdentity(environment, coachId) {
  const row = { environment: envName(environment), coachId: String(coachId || ''), savedAt: Date.now() }
  wx.setStorageSync(identityKey(environment), row)
  return clone(row)
}
function forgetIdentity(environment) {
  try { wx.removeStorageSync(identityKey(environment)) } catch (error) {}
}
// ⭐ 换人的**唯一检测点**：服务端这次给的身份和上次确认过的不同 ⇒ 换人了。
function adoptIdentity(environment, coachId) {
  const next = String(coachId || '')
  if (!next) return { changed: false, from: '', to: '', switched: false }
  const previous = readIdentity(environment)
  if (previous === next) return { changed: false, from: previous, to: next, switched: false }
  writeIdentity(environment, next)
  return { changed: true, from: previous, to: next, switched: !!previous }
}

// 内容闸：**每一份**列出的课包都必须带非空 packageId，否则这一帧不许拿去排课。
// （空数组也算合格 —— 会员级关系存在但还没有课包授权，本来就是合法形状。）
function directoryUsable(data) {
  const serving = data && data.serving
  if (!Array.isArray(serving)) return false
  return serving.every(member => {
    const packages = member && member.packages
    if (!Array.isArray(packages)) return true
    return packages.every(pkg => !!String(pkg && pkg.packageId || ''))
  })
}
function cacheUsable(row) {
  return !!row && row.shape === CACHE_SHAPE && directoryUsable(row.data)
}

// ⭐ 读缓存：**必须同时带着"这一帧是谁的"**。
//   ① 身份没确认 ⇒ 返回 null（调用方会看到"没有缓存可用"，而不是凑巧命中别人的帧）；
//   ② 行里自报的 coachId 与读取身份不一致 ⇒ 这一帧永不使用（双重锁：key 与内容都要对得上）；
//   ③ 旧版 key（没有身份后缀）**一律不认** —— 它证明不了自己属于谁，
//      而 BUG03 教会我们的正是"跨版本常驻的旧帧不能拿来当事实"（那一版是形状，这一版是身份）。
function readCache(environment, coachId) {
  const identity = String(coachId || '')
  if (!identity) return null
  const row = wx.getStorageSync(cacheKey(environment, identity))
  if (!row || typeof row !== 'object' || !row.data) return null
  if (String(row.coachId || '') !== identity) return null
  return clone(row)
}
function writeCache(environment, data, cloudShape = '', coachId = '') {
  const identity = String(coachId || '')
  // ⛔ 没有可信身份就**不许写缓存**：写了也没人能证明它属于谁，反而给下一次留下一个说不清的帧。
  if (!identity) return null
  const row = { environment: envName(environment), coachId: identity, data: clone(data), savedAt: Date.now(), shape: CACHE_SHAPE, cloudShape: String(cloudShape || '') }
  wx.setStorageSync(cacheKey(environment, identity), row)
  return clone(row)
}
// 环境有哪些：给环境（清这一个）/ 不给（两个都清）。
function listEnvironments(environment) {
  return environment ? [envName(environment)] : ['production', 'sandbox']
}
// 清掉"我能证明属于当前身份"的那一帧 + 旧版遗留 key。
// ⚠️ 别的教练那一帧清不掉也没有关系：读的那一边要求 **key 与身份同时命中**，拿不到就是拿不到。
function clearCache(environment) {
  const keys = []
  listEnvironments(environment).forEach(env => {
    keys.push(cacheKey(env, ''))
    keys.push(cacheKey(env, readIdentity(env)))
  })
  ;[...new Set(keys)].filter(Boolean).forEach(key => { try { wx.removeStorageSync(key) } catch (error) {} })
}

// 目录读取：一次云调用，失败时**保留上一帧**并如实回报 code（绝不假装"没有授权"）。
async function loadDirectory(options = {}) {
  const environment = runtime.environment()
  // 身份 ≥ 环境：缓存隔离要按"这是谁的帧"来取，环境只是第二维。
  const identity = readIdentity(environment)
  // 原帧（含旧形状）只用于**展示上一帧**；能不能拿去写由 `usable` 单独说。
  const frame = readCache(environment, identity)
  const usable = cacheUsable(frame)
  const fallback = () => ({
    cached: !!frame, environment, coachId: identity, identityConfirmed: !!identity,
    data: frame ? clone(frame.data) : emptyDirectory(),
    shape: frame ? frame.shape || '' : '', cloudShape: frame ? frame.cloudShape || '' : '',
    usable, stale: !usable
  })
  if (!options.force && usable) {
    return { ok: true, cached: true, environment, coachId: identity, identityConfirmed: true, data: clone(frame.data), savedAt: frame.savedAt, shape: frame.shape, cloudShape: frame.cloudShape || '', usable: true, stale: false }
  }
  let result
  try {
    const response = await wx.cloud.callFunction({
      name: CLOUD_FUNCTION,
      data: { action: 'authorization', read: 'directory', environment }
    })
    result = response && response.result
  } catch (error) {
    return { ok: false, code: 'AUTHORIZATION_READ_FAILED', message: '授权目录读取失败，当前显示的是上一次读到的内容。', ...fallback() }
  }
  if (!result || result.ok !== true) {
    return { ok: false, code: (result && result.code) || 'AUTHORIZATION_READ_FAILED', message: (result && result.message) || '授权目录读取失败。', ...fallback() }
  }
  // ⭐ 换人检测发生在**写之前**：服务端这次给的身份如果和上一次确认过的不同，
  //    就先把身份换成新的 —— 之后所有读写都在"这一帧属于谁"这件事上是明确的。
  const adopted = adoptIdentity(environment, result.coachId)
  const row = writeCache(environment, result, result.shape || '', adopted.to)
  const fresh = directoryUsable(row && row.data)
  return {
    ok: true, cached: false, environment, coachId: adopted.to, identityConfirmed: !!adopted.to,
    identitySwitched: adopted.switched,
    data: row ? clone(row.data) : emptyDirectory(), savedAt: row ? row.savedAt : 0,
    shape: row ? row.shape : '', cloudShape: row ? row.cloudShape : '', usable: fresh, stale: !fresh,
    droppedPackages: Number(result.droppedPackages || 0)
  }
}

function emptyDirectory() { return { serving: [], managed: [], truncated: false } }

// ⭐ 只读本机缓存（**零云调用**）。
//   为什么必须有它：「学员」页的 onShow **一次云调用都不许发**（离线场景里那等于"断网还在打云端"，
//   见 tests/student-pending-lifecycle.test.js 场景 E）。所以学员页只渲染缓存里那一帧，
//   真正联网刷新交给自动刷新 / 下拉刷新（permissionChanged 也会走到那里）。
function cachedDirectory() {
  const environment = runtime.environment()
  const identity = readIdentity(environment)
  const row = readCache(environment, identity)
  // ⚠️ 展示层照旧拿到那一帧（学员列表不许因为"标识陈旧"就把会员整张卡藏掉），
  //    但 `stale` 必须带出来 ⇒ 任何想拿它去写的人一眼看得出这不是可信事实。
  // ⚠️ 身份还没确认 ⇒ `row` 一定是 null（读的那一边就卡在身份上）⇒ 会员渲染为空而不是"别人的会员"。
  return {
    ok: true, cached: true, environment, coachId: identity, identityConfirmed: !!identity, fresh: false,
    data: row ? row.data : emptyDirectory(),
    savedAt: row ? row.savedAt : 0, hasCache: !!row, usable: cacheUsable(row), stale: !cacheUsable(row)
  }
}
// 云端目录版本水印：**一眼核对部署版本**（云函数没更新 ⇒ 这里看得出来）。
// ⛔ 只认**云端**给的 `cloudShape`：缓存自己的 `shape` 是另一回事，拿它兜底会把"旧版云函数"显示成新版。
function shapeText(result) {
  const value = result && result.cloudShape
  return value ? String(value) : STALE_SHAPE_TEXT
}

// ------------------------------------------------------------------ 授权变更之后的一致性
//
// ⚠️ 授权命令在 `utils/mutate.js` 里是**云端先行**（本机没有授权表，硬算就是拿假数据记账），
//    权限判定**只发生在云端可信身份下**。前端隐藏按钮只是体验，不是安全边界。
//
// ⭐ 页面发完授权命令（走 mutate）之后必须调一次这个 —— 否则"我这边改了权限，别的页面还显示旧名单"。
//    · autoRefresh.request('permissionChanged')：唤醒**可见**页面各自重读（总线，不轮询）；
//    · 再强拉一次目录缓存：授权目录是独立缓存，不重拉就会显示上一帧。
async function notePermissionChanged() {
  autoRefresh.request('permissionChanged')
  await loadDirectory({ force: true })
}

// ------------------------------------------------------------------ 呈现辅助（纯函数，可单测）
//
// ⛔ 隐私：进入这里的字段**已经**是云端投影过的（notes / summary / 金额 / 提成一律不在里面）。
//   这一层只做排版，**不再引入任何新字段**。
function occupancyText(pkg) {
  const remaining = Number(pkg && pkg.remaining || 0), reserved = Number(pkg && pkg.reserved || 0)
  const available = Number.isFinite(Number(pkg && pkg.availableToBook)) ? Number(pkg.availableToBook) : Math.max(remaining - reserved, 0)
  return `剩余 ${remaining} · 已占 ${reserved} · 还能约 ${available}`
}
function momentText(booking) {
  return `${booking.date} ${String(booking.hour).padStart(2, '0')}:${String(booking.minute || 0).padStart(2, '0')}`
}
function itemsText(booking) {
  const items = Array.isArray(booking && booking.items) ? booking.items : []
  if (!items.length) return '未记录动作'
  return items.map(item => `${item.name} ${item.sets || 4}组×${item.reps || 12}次${item.weight ? ` · ${item.weight}kg` : ''}`).join('、')
}

module.exports = {
  CACHE_PREFIX, IDENTITY_PREFIX, LEGACY_CACHE_KEYS, CLOUD_FUNCTION, CACHE_SHAPE, EXPECTED_CLOUD_SHAPE, STALE_SHAPE_TEXT,
  loadDirectory, cachedDirectory, emptyDirectory, clearCache, notePermissionChanged,
  readIdentity, writeIdentity, forgetIdentity, cacheKey, identityKey,
  directoryUsable, cacheUsable, shapeText,
  occupancyText, momentText, itemsText
}
