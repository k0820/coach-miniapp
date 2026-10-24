// 会员端唯一一套界面色板：暖白底、深海蓝文字、青绿色小面积强调。
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
//   ⇒ 现在只保留一套统一界面：页面暖白 / 内容面纯白 / 深海蓝文字 / 青绿色小面积强调。
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
const THEME_NAME = '清透'

const THEMES = Object.freeze({
  [THEME_ID]: Object.freeze({
    id: THEME_ID, name: THEME_NAME,
    // 样板色板：森林绿负责主操作，浅蓝 / 珊瑚 / 暖黄只做信息分层。
    primary: '#103F3B', primaryDeep: '#0B302D', accent: '#4C76DF', soft: '#EAFBF4',
    hero: 'linear-gradient(135deg,#0C302D 0%,#104B45 58%,#28566B 100%)', heroLabel: '#F3B941', heroInk: '#FFFFFF',
    // 暖白页面与白色内容面形成轻层次，避免灰色后台感。
    pageBg: '#FBFAF5', surface: '#FFFFFF', surfaceAlt: '#F3F7F5', border: '#E3EBE7', borderStrong: '#C6DED5',
    shadow: '0 16rpx 44rpx rgba(16,63,59,.08)',
    text: '#102A2B', textSub: '#71837F', tagBg: '#EDF3FF', tagText: '#4C76DF',
    success: '#22A77A', warning: '#9A7024', danger: '#DD6848',
    successSoft: '#EAFBF4', warningSoft: '#FFF8DF', dangerSoft: '#FFF1EC',
    navActive: '#103F3B', navIdle: '#91A09D',
    decoPrimary: '#F3B941', decoSecondary: '#D9F7EC', decoShape: 'plain', illustration: 'plain',
    decoSunRadius: '999rpx', decoLeafRadius: '999rpx',
    slot: Object.freeze({
      freeBg: '#FFFFFF', freeLine: '#22A77A', freeTime: '#103F3B',
      bookedBg: '#EDF2F0', bookedLine: '#D7E2DE', bookedTime: '#81918E', bookedText: '#879591',
      pastBg: '#F8F8F4', pastLine: '#ECEDE7', pastTime: '#BCC4C1', pastText: '#C5CBC8',
      echoBg: '#EAFBF4', echoLine: '#F3B941'
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
