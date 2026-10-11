// 弹窗按钮文字宽度规则（微信基础库 **硬校验**，2026-09-23 事故 §0.5.18 的根因）
//
// 原文出处：基础库 `3.17.3.wxvpkg` 内 `showModal` 的参数校验分支：
//
//   var i = { … confirmText:"......", cancelText:"......" … }
//   if (i.confirmText.replace(/[^\x00-\xff]/g, "##").length > 8)
//        fail("confirmText length should not larger than 4 Chinese characters")
//   else if (i.cancelText.replace(/[^\x00-\xff]/g, "##").length > 8)
//        fail("cancelText length should not larger than 4 Chinese characters")
//
// 结论（照抄，别自己推）：
//   ① 计宽公式 = 把**所有非 ASCII 字节范围内的字符**（中文、全角标点、emoji 等）各记 **2** 宽，其余记 1；
//   ② 阈值是 **> 8 即 fail**，不是"最多 4 个字符"这句自然语言的模糊理解 —— 等价于**最多 4 个汉字**
//      （4×2 = 8，不 > 8 ⇒ 通过；5 个汉字 = 10 ⇒ 直接 fail）；
//   ③ **超限时弹窗根本不显示**，直接走 `fail` 回调 —— 表现为"点了按钮，界面上什么都不出现"，
//      和"没绑上事件"长得一模一样。这就是它骗过上一轮排查的原因。
//
// 因此本模块的用途：**调用方在把 options 交给 wx.showModal 之前过一道闸**。
// 超限不做静默截断（截断会改变按钮含义，比报错更坏），而是**退回到调用方给的短文案**，
// 并把"降级了"这件事**如实报出去**（notes），让操作员看得见。
const LIMIT = 8

// 官方计宽公式。空值一律按空串算（宽度 0）。
function widthOf(text) {
  if (text === null || text === undefined) return 0
  return String(text).replace(/[^\x00-\xff]/g, '##').length
}

function fits(text) {
  return widthOf(text) <= LIMIT
}

// 单条按钮文字的合规化：合规 → 原样；超限 → 退到 fallback；fallback 也超限 → 退到 1 个汉字
// （1 个汉字宽度 2，**数学上不可能超限**）。
function fitButton(text, fallback) {
  const raw = (text === null || text === undefined) ? '' : String(text)
  if (raw.length > 0 && fits(raw)) return { text: raw, fitted: false, width: widthOf(raw), raw }
  const fb = (fallback === null || fallback === undefined) ? '' : String(fallback)
  if (fb.length > 0 && fits(fb)) return { text: fb, fitted: true, width: widthOf(fb), raw }
  const hard = raw.length > 0 ? raw.slice(0, 1) : (fb.length > 0 ? fb.slice(0, 1) : '好')
  return { text: hard, fitted: true, width: widthOf(hard), raw }
}

// 对整个 showModal options 做合规化。返回**新对象**（绝不改调用方的字面量），
// 外加 notes：给操作员看的"哪一项被降级了、原来写的什么"。
// 只处理 confirmText / cancelText —— 基础库里 title / content 没有长度硬校验（已核对，无 "title length should not" 命中）。
function fitModalOptions(options) {
  const source = options || {}
  const out = Object.assign({}, source)
  const notes = []
  if (source.confirmText !== undefined) {
    const r = fitButton(source.confirmText, '确定')
    out.confirmText = r.text
    if (r.fitted) notes.push('confirmText（确认按钮）超上限 4 字，已改用「' + r.text + '」（原文「' + r.raw + '」）')
  }
  if (source.cancelText !== undefined) {
    const r = fitButton(source.cancelText, '取消')
    out.cancelText = r.text
    if (r.fitted) notes.push('cancelText（取消按钮）超上限 4 字，已改用「' + r.text + '」（原文「' + r.raw + '」）')
  }
  return { options: out, notes }
}

module.exports = { LIMIT, widthOf, fits, fitButton, fitModalOptions }
