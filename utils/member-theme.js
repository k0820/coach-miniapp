// ⭐⭐ 会员端**唯一一套界面色板**（2026-10-05：三套主题已撤回，只保留灰白简约版）。
//
// ─────────────────────────────────────────────────────────────────────────────
// ⛔⛔ 本轮撤回了什么（改动前必读，别把旧东西加回来）
//
//   撤回前：`THEMES` 里有 **三套**皮肤（元气绿 / 活力蓝 / 简约灰），还有一个
//   `pages/member-theme` 主题选择页 + 「我的」页里的「个性化主题 ›」入口，
//   会员点了会把 `theme` 这个 id 通过 `updateProfile` 存到云端，等同于用会员数据存了一个没用的开关。
//
//   用户最终决定：**不要主题**。理由很实在 —— 教练/会员是来上课、约课、看课时的，
//   换皮肤没有业务价值，反而每加一个新页面都要适配三套颜色，出错的面白白大三倍。
//   ⇒ 现在只保留**一套**灰白简约界面：页面浅灰白 / 卡片纯白 / 深灰文字 / 少量统一低饱和强调色。
//
// ⛔⛔ 三条纪律
//   ① **`THEMES` 里只允许有一套。** 再加第二套就是**本轮撤回的功能回来了**，
//      `tests/member-single-theme-guard.test.js` 会立刻变红。
//   ② **不许再出现主题选择器。** 没有 `pages/member-theme`、没有「个性化主题」入口、
//      `updateProfile` 也已不再接受 `theme` 字段（客户端 Storage 里同样不存它）。
//   ③ **本模块只能说"长什么样"**：不允许出现 storage / 云调用 / 课时 / 余额 / 身份等字样，
//      也不引入任何位图（包体上限 2MB，且外部图片 URL 授权不明）。
//
// ─────────────────────────────────────────────────────────────────────────────
// ⭐ 为什么 `resolve()` 还是接一个参数、还写兜底
//
//   历史会员档案里**已经存过** `theme: 'vitality' / 'active' / 'minimal'`（那是用户数据，
//   ❼ 不能假设它干净）。这些调用点遍布十几个页面，若一一改成"不传参"，
//   改动面会扩散到业务页面 —— 与"只改界面、不重写业务"相冲突。
//   ⇒ 所以保留签名 `resolve(id)`、**忽略入参、恒返回唯一这一套**。任意脏值也能拿到完整色板：
//      · `'constructor'` / `'toString'` 这类**原型上的键**不会命中 `Object` 构造函数；
//      · 空串 / null / undefined 也不会；
//      · 将来谁漏写一个 token，`resolve()` 补默认值而不是静默产出 `undefined`（样式整片失效且不报错）。

/** ⭐ 一套界面的完整字段清单（新增 token 时必须同时加进这里，否则 `resolve()` 的补齐会漏）
 *  ⚠️ `slot.*` 是嵌套对象，会被 `cssVars()` 展平成 `--member-slot-*` 变量。 */
const TOKEN_GROUPS = {
  // —— 主色系（按钮 / 强调 / 选中态）——
  primary: '',        // 主色：主按钮底、选中态描边、可约格边框
  primaryDeep: '',    // 深一档主色：按压态、深色底上的分隔
  accent: '',         // 唯一的低饱和强调色：点缀、小面积高亮
  soft: '',           // 主色的极浅底：头像底、图标底
  // —— 头图（首页 hero）——
  hero: '',           // 头图渐变
  heroLabel: '',      // 头图上的小标签字色（必须与 hero 底色对比够）
  heroInk: '',        // 头图上的大数字字色
  // —— 面（页面底 / 卡片底 / 描边 / 阴影）——
  pageBg: '',         // 页面底色（浅灰白，**不能纯白到没有层次**）
  surface: '',        // 卡片底色（纯白）
  surfaceAlt: '',     // 次级面（空态、嵌套块）
  border: '',         // 常规描边
  borderStrong: '',   // 强调描边（可约格、选中态）
  shadow: '',         // 卡片阴影（带一点石墨色相，不是纯黑）
  // —— 字（正文 / 次要文字 / 状态标签）——
  text: '',           // 正文（深灰）
  textSub: '',        // 次要文字
  tagBg: '',          // 状态标签底
  tagText: '',        // 状态标签字
  // —— 语义色（⛔ 低饱和，不要荧光感）——
  success: '', warning: '', danger: '',
  successSoft: '', warningSoft: '', dangerSoft: '',
  // —— 底部导航 ——
  navActive: '',      // 选中态（字 + 图标）
  navIdle: '',        // 未选中态
  // —— 纯 CSS 装饰（⛔ 不是图片路径）——
  decoPrimary: '',    // 装饰主色
  decoSecondary: '',  // 装饰辅色
  decoShape: '',      // 装饰**形状类型**（恒为 'plain'：只用留白和一根细线）
  // 首页头图上两个纯 CSS 图形的几何形状（`.member-sun` / `.member-leaf`）
  decoSunRadius: '',   // `.member-sun` 的 border-radius
  decoLeafRadius: '',  // `.member-leaf` 的 border-radius
  // —— 可约时段四态（⛔ 与 styles/slots.wxss 一一对应）——
  slot: {
    freeBg: '', freeLine: '', freeTime: '',      // 可约
    bookedBg: '', bookedLine: '', bookedTime: '', bookedText: '',   // 已排课（不可约）
    pastBg: '', pastLine: '', pastTime: '', pastText: '',         // 已过时间
    echoBg: '', echoLine: ''                    // 本地回声（刚点的、确认中）
  }
}

/** token 字段 → CSS 变量名（`--member-*` 前缀沿用，页面里已有大量引用不能改名） */
const CSS_VAR_NAMES = {
  primary: '--member-primary', primaryDeep: '--member-primary-deep', accent: '--member-accent', soft: '--member-soft',
  hero: '--member-hero', heroLabel: '--member-hero-label', heroInk: '--member-hero-ink',
  pageBg: '--member-page-bg', surface: '--member-surface', surfaceAlt: '--member-surface-alt',
  border: '--member-border', borderStrong: '--member-border-strong', shadow: '--member-shadow',
  text: '--member-text', textSub: '--member-text-sub', tagBg: '--member-tag-bg', tagText: '--member-tag-text',
  success: '--member-success', warning: '--member-warning', danger: '--member-danger',
  successSoft: '--member-success-soft', warningSoft: '--member-warning-soft', dangerSoft: '--member-danger-soft',
  navActive: '--member-nav-active', navIdle: '--member-nav-idle',
  decoPrimary: '--member-deco-primary', decoSecondary: '--member-deco-secondary',
  decoSunRadius: '--member-deco-sun-radius', decoLeafRadius: '--member-deco-leaf-radius',
  slotFreeBg: '--member-slot-free-bg', slotFreeLine: '--member-slot-free-line', slotFreeTime: '--member-slot-free-time',
  slotBookedBg: '--member-slot-booked-bg', slotBookedLine: '--member-slot-booked-line',
  slotBookedTime: '--member-slot-booked-time', slotBookedText: '--member-slot-booked-text',
  slotPastBg: '--member-slot-past-bg', slotPastLine: '--member-slot-past-line',
  slotPastTime: '--member-slot-past-time', slotPastText: '--member-slot-past-text',
  slotEchoBg: '--member-slot-echo-bg', slotEchoLine: '--member-slot-echo-line'
}

/** 唯一一套界面：命名仍叫 `default`，`id` 只用于形状完整性，⛔ 不代表可以切换。 */
const THEME_ID = 'default'
const DEFAULT_ID = THEME_ID
const THEME_NAME = '简约'

const THEMES = Object.freeze({
  [THEME_ID]: Object.freeze({
    id: THEME_ID, name: THEME_NAME,
    // ⭐ 主色用中性石墨；唯一的强调色 `#5f7a86`（低饱和蓝灰）只做小面积点缀。
    primary: '#3a454e', primaryDeep: '#252d34', accent: '#5f7a86', soft: '#eef1f3',
    hero: 'linear-gradient(135deg,#eff2f4,#ffffff)', heroLabel: '#5c6770', heroInk: '#1d2429',
    // ⭐ 层次怎么来的：页面 `#f6f7f8`（浅灰白）→ 卡片 `#ffffff`（纯白）+ 1rpx 描边 + 极淡阴影。
    pageBg: '#f6f7f8', surface: '#ffffff', surfaceAlt: '#fafbfb', border: '#e6e8ea', borderStrong: '#d2d6da',
    shadow: '0 8rpx 24rpx rgba(37,45,52,.05)',
    text: '#22282e', textSub: '#757e86', tagBg: '#eef1f3', tagText: '#414c55',
    success: '#4f7a5c', warning: '#8a6f34', danger: '#a8453c',
    successSoft: '#ecf1ed', warningSoft: '#f3eee2', dangerSoft: '#f4e9e8',
    navActive: '#3a454e', navIdle: '#939ba1',
    decoPrimary: '#c3cace', decoSecondary: '#9aa3a9', decoShape: 'plain', illustration: 'plain',
    decoSunRadius: '8rpx', decoLeafRadius: '0',
    slot: Object.freeze({
      freeBg: '#ffffff', freeLine: '#3a454e', freeTime: '#22282e',
      bookedBg: '#f0f2f3', bookedLine: '#dadee1', bookedTime: '#8b949a', bookedText: '#828b91',
      pastBg: '#fafafa', pastLine: '#edeef0', pastTime: '#c0c5c9', pastText: '#ccd0d4',
      echoBg: '#f2f4f5', echoLine: '#5f7a86'
    })
  })
})

const IDS = Object.freeze(Object.keys(THEMES))

/** ⛔ 只认**自有**键：`THEMES['constructor']` 会返回 Object 构造函数（原型上的键），不是色板 */
const has = id => Object.prototype.hasOwnProperty.call(THEMES, id)

/**
 * ⭐ 取唯一那套**字段齐全**的色板（⛔ 忽略入参 —— 历史库里残留的 theme id 一律不影响显示）。
 * @returns {object} 完整色板（⛔ 永远不会是 undefined）
 */
function resolve() {
  const theme = THEMES[THEME_ID]
  const out = {}
  Object.keys(TOKEN_GROUPS).forEach(key => {
    if (key === 'slot') return
    out[key] = theme[key] == null ? '' : theme[key]
  })
  out.id = theme.id
  out.name = theme.name
  out.illustration = theme.illustration || theme.decoShape
  out.slot = {}
  Object.keys(TOKEN_GROUPS.slot).forEach(key => { out.slot[key] = theme.slot[key] })
  return out
}

/** ⭐ 恒返回**一项**（历史接口：主题页渲染用；现在没有选择页，保留形状以免调用方报错） */
function list() { return [resolve()] }

/** 嵌套字段 → 展平后的名字（slot.freeBg ⇒ slotFreeBg） */
const flattenSlot = slot => Object.keys(TOKEN_GROUPS.slot).reduce((out, key) => {
  out['slot' + key.charAt(0).toUpperCase() + key.slice(1)] = slot[key]
  return out
}, {})

/** ⭐ 色板 token → 一整串 CSS 自定义属性，页面用 `style="{{themeStyle}}"` 注入。
 *  ⛔ 值全部来自本模块的字面量（不含任何用户输入）⇒ 拼进 style 字符串是安全的。 */
function cssVars() {
  const theme = resolve()
  const flat = {}
  Object.keys(CSS_VAR_NAMES).forEach(key => { flat[key] = theme[key] })
  Object.assign(flat, flattenSlot(theme.slot))
  return Object.keys(CSS_VAR_NAMES)
    .map(key => `${CSS_VAR_NAMES[key]}:${flat[key]}`)
    .join(';') + ';'
}

module.exports = { THEMES, IDS, DEFAULT_ID, TOKEN_GROUPS, CSS_VAR_NAMES, resolve, cssVars, list, has }
