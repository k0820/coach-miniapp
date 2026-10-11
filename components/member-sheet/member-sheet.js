// ⭐⭐ 会员端**统一底部弹层**（components/member-sheet）。
//
// ─────────────────────────────────────────────────────────────────────────────
// 为什么要有这个组件
//
// ⛔ 改造前的病：同一个"底部弹层"在项目里有**三份各自复制的副本**——
//    约课确认（pages/member-book-slots）、预约详情（pages/member-bookings）、
//    改期（pages/member-bookings）。三份的圆角、拖动条、标题字号、按钮高度、
//    甚至**遮罩底色**都不一样（同一个页面上 `rgba(12,40,30,.38)` 与 `rgba(12,40,30,.45)` 并存）。
//    ⇒ 同一个产品里"弹层"有两套长相，而且改一处必漏另两处。
//
// ⭐ 现在：结构与视觉只有这一份。三个调用方**由别人接**（本轮 ⛔ 不动那三个页面）。
//
// ─────────────────────────────────────────────────────────────────────────────
// ⭐ 规格（每一条都有对应测试，见 tests/member-theme-visual.test.js ⑥）
//
//   ① 顶部 32rpx 圆角 + 顶部拖动短横线（`.member-sheet` / `.member-sheet-handle`）
//   ② 标题 28rpx 加粗 + 右上关闭 ×（`.member-sheet-title` / `.member-sheet-close`）
//   ③ 内容区**可滚动**：`scroll-view` + `max-height` 用**视口百分比**（不用 rpx 硬编码，
//      否则小屏（iPhone SE 568pt）与大屏（Pro Max）会得到不同的行数，底部按钮位置也不同）
//   ④ 底部主操作按钮**固定**：在 scroll-view **外面**，内容再长也不会被顶走
//   ⑤ 小屏不越界：底部留 `env(safe-area-inset-bottom)`
//   ⑥ 遮罩 `catchtouchmove` 防滚动穿透（⛔ 不许去掉：手指在弹层上滑，
//      后面的页面会跟着一起滚 —— 项目里 tests/ui-tail-119.test.js 已经钉这条）
//   ⑦ 危险操作：确认按钮转红（`danger` 属性）
//   ⑧ ⛔ **不自带 loading spinner**。
//      理由：加载/空/失败/重试这四态是**内容区**的事，由调用方通过 slot 放。
//      组件自己在遮罩上挂一个常驻转圈 ⇒ 用户看到的是"一片空白 + 一个转圈"，
//      不知道是没数据还是失败了（这是项目里踩过的坑，见 member-bookings 的 rLoading 三态）。
//      ⇒ 本组件只有 `visible` 一个显隐开关，没有任何"自动显示的遮罩"。
//
// ─────────────────────────────────────────────────────────────────────────────
// ⛔ 关于"关闭"的语义（三条，别混）：
//   · 点遮罩空白处 / 点右上 ×  / 点「取消」⇒ 只派发 `close` 或 `cancel`，**组件自己不隐藏**。
//     隐藏由调用方把 `visible` 改成 false —— 否则"保存成功后再点遮罩"这种时序会很难写。
//   · `close` = 用户放弃（点 ×、点遮罩）；`cancel` = 用户明确按了「取消」按钮。
//     分开派发是为了让调用方能对二者做不同处理（比如 × 不需要二次确认，取消需要）。
//   · `confirm` = 用户按了主操作。⚠️ 组件**不做任何业务判断**，成功与否由调用方回传。
//
// ⭐ 插槽：只有一个默认 slot，放在**内容区**（scroll-view 内）。
//   ⛔ 为什么 slot 在 scroll-view **里面**：slot 内容可能很长（预约详情、改期面板），
//   放在外面会把底部按钮顶出屏幕 —— 那正是原来三份副本里最常见的问题。

Component({
  properties: {
    visible: { type: Boolean, value: false },          // 显隐（⛔ 唯一开关，组件不自带任何遮罩态）
    title: { type: String, value: '' },
    desc: { type: String, value: '' },                 // 可选：标题下面那行说明
    confirmText: { type: String, value: '确认' },
    cancelText: { type: String, value: '取消' },
    danger: { type: Boolean, value: false },// 危险操作：主按钮转红
    showCancel: { type: Boolean, value: true },// 只要一个主操作时传 false
    // ⭐⭐ 2026-10-04 新增：**CSS 变量注入**（字符串）。
    //
    // 为什么需要：组件里所有颜色都写 `var(--member-*, 兜底值)`。自定义属性只在**同一 DOM 子树**内继承，
    //   而组件的 wxss 是**独立作用域**（不 import 调用方样式）⇒ 调用方根节点上的 `--student-*`
    //   （教练端蓝色板）与 `--member-*`（会员端绿色板）**都不会自动进来**。
    //   若不注入，教练端页面用它就会一律落到兜底值 ⇒ **教练端弹层变成会员端绿色**，视觉直接串色。
    //
    // ⛔ 因此约定：调用方若用**非会员端色板**，必须显式把自己的变量映射进来，例如：
    //     vars="--member-primary: var(--student-primary); --member-surface: var(--student-surface); …"
    //   会员端页面**不用传**（`--member-*` 由 `style="{{themeStyle}}"` 自然提供）。
    vars: { type: String, value: '' }
  },
  methods: {
    // ⛔ 遮罩上的 catchtouchmove 指向它。必须有这个方法名，
    //   否则真机上"遮罩挡住滑动"这件事会因为找不到 handler 而静默失效。
    noop() {},
    onConfirm() { this.triggerEvent('confirm') },
    onCancel() { this.triggerEvent('cancel') },
    onClose() { this.triggerEvent('close') }
  }
})