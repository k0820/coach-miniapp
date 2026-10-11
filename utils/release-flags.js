// 发布开关 —— **唯一**决定「开发期临时入口」在普通界面是否可见的地方。
//
//   RELEASE_BUILD = true   → 隐藏候选/割接/恢复诊断等临时入口。
//                            课表页的「Candidate Staging Fixture / 真实云端切换」、
//                            统计页的「上午课程只读恢复诊断」、
//                            课程页的「只读诊断本次完课」全部从普通界面隐藏。
//                            Sandbox 入口另按 envVersion 控制：仅 develop/trial 显示，
//                            release 即使同一份源码也隐藏。
//   RELEASE_BUILD = false  → 开发包。以上入口全部恢复原样，方便继续开发与真机调试。
//
// ⚠️ 这里**只控制界面入口**，底层的安全能力一律原样保留、一行都不删：
//    · Sandbox 隔离与切换（utils/data-runtime、ui-cloud-command.switchEnvironment、sandbox-banner）
//    · 候选数据 / 割接 / 迁移 / 只读诊断 / 救援冻结（candidate-*、cutover-*、pre-activation-*、
//      production-recovery-*、cloud-migration、cloud-shadow-read）
//    · 幂等号、receipt、持久 Outbox、本机投影、本机先行写链路
//    这些页面**仍在 app.json 注册**、代码**仍在仓库**，所以以后要重新开发，把这里改回 false 即可，
//    不需要重新接线、也不会出现「navigateTo 找不到页面」。
//
// 与 utils/mutate.js 的 `LOCAL_FIRST_ENABLED` 分工：
//    LOCAL_FIRST_ENABLED 控制**写链路走哪条**（本机先行 / 云端先行）；
//    RELEASE_BUILD       控制**开发入口露不露**。两者互不影响。
const RELEASE_BUILD = true

// ✅ M3-P3（2026-09-30）：会员**真实提交预约**的总闸 —— **已打开**。
//   这不是"界面入口开关"，而是**写链路本身**的开关（关掉 ⇒ 页面只弹提示、一次云调用都不发）。
//   三条产品规则已由用户定稿，所以这里打开：
//     ① 规则 1 ⇒ 不需要教练确认（云端 policy 默认 `direct`）；
//     ② 规则 4 ⇒ 最多未来 30 天（`occupancy.MEMBER_BOOKING_MAX_DAYS`，云端事务内终判）；
//     ③ 规则 3 ⇒ 没有档案不许自助建档（`MEMBER_CLAIM_NOT_FOUND`，零写入）。
//   ⛔ 打开它**不等于**可以真机预约：云端 `coachBusinessCommand` **还没部署**，
//      真机上现在点确认只会拿到"云函数不认识这个 action" ⇒ 部署之前不许开体验版给人点。
//   ⛔ 回滚只需要把这一处改回 false（页面与 runtime 都读它，不需要改第二处）。
const MEMBER_BOOKING_SUBMIT = true

// ✅ M3-P6（2026-09-30）：会员**取消 / 改期**的写链总闸 —— **打开**。
//   先决条件**已经具备**（用户第 2 点交代的顺序：云端命令先完成，才允许开这一处）：
//     · 云端已有 `cancelMemberBooking` / `rescheduleMemberBooking`（`coachBusinessCommand/memberBooking.js`），
//       与创建走**同一个**窄通道（同一份身份推导、同一份白名单纪律、同一套事务 / revision / receipt 幂等）；
//     · 六条产品规则**已全部拍板** ⇒ `member-booking-manage.policyBlocked()` 不再是 `true`：
//         ① 任何时间都能取消（无截止时间）② 取消只释放 reserved（不扣课、不动余额、不产生收入）
//         ③ 不计违约 ④ 改期不限次数 ⑤ 改期不需要教练确认 ⑥ 必须通知另一方（本轮只落事件，微信是 M4）。
//   ⛔ 仍然**必须**先部署云端再上传体验版：客户端一开，云端没有这两条命令 ⇒ 真机上"点了报错"且说不清为什么。
//   ⛔ 回滚只需要把这一处改回 false（页面与 runtime 都读它，不需要改第二处）。
const MEMBER_MANAGE_SUBMIT = true

function devEntriesVisible() { return !RELEASE_BUILD }
function memberBookingSubmitEnabled() { return MEMBER_BOOKING_SUBMIT === true }
function memberManageSubmitEnabled() { return MEMBER_MANAGE_SUBMIT === true }

// The sandbox is the one development capability needed in an uploaded trial
// build. Never infer release safety from a source toggle alone: the running
// WeChat version must explicitly be develop/trial. Unknown means hidden.
function sandboxEntryVisible() {
  if (typeof wx === 'undefined' || typeof wx.getAccountInfoSync !== 'function') return false
  try {
    const info = wx.getAccountInfoSync()
    const version = info && info.miniProgram && info.miniProgram.envVersion
    return version === 'develop' || version === 'trial'
  } catch (error) { return false }
}

module.exports = {
  RELEASE_BUILD, devEntriesVisible, sandboxEntryVisible,
  MEMBER_BOOKING_SUBMIT, memberBookingSubmitEnabled,
  MEMBER_MANAGE_SUBMIT, memberManageSubmitEnabled
}
