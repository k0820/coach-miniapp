// 「22 条业务命令的核验策略」——**声明**，不靠自觉（2026-09-23 第 23 轮）。
//
// 为什么必须有它：上一版把"要不要做业务级核验"完全交给实现方自觉 —— 页面只给 completeBooking
// 实现了核验，其余 21 条一律返回 `checked:false`；而驱动既分不清"这条本就不需要核验"和
// "这条应该有核验但没人实现"，也把这两件事用同一句红字渲染出来。这正是
// `VERIFY_FAILED` 现场读起来像"因为没配置核验才停"的根因。
//
// 三层判据（缺一不可，写在数据里）：
//  ① `level`：`required`（**必须**读回核验） / `receipt-only`（回执 + 出队 + revision 恰好 +1 足够）。
//  ② `verifier`：required 的命令必须点名一个**已实现**的核验器；点名不到 ⇒ **拒发**（不是"未配置就放过"）。
//     这条是硬门禁：`preflightOf()` 在**发送之前**调用 ⇒ 不可核验的命令**永远不会被发出去**，
//     而不是"发完才发现核不了"（后者留下的是不可逆、无法对账的写入）。
//  ③ `why`：receipt-only 必须写清"为什么不需要"；required 必须写清"要核验什么"。
//
// ⚠️ 升级规则（写给下一个改这个文件的人）：**只新增**类的命令之所以能 receipt-only，是因为
//    "业务键在服务端有唯一/互斥门禁 + 回执 result 带回新实体 id + 不动任何既有行"。
//    一旦这类命令**进入恢复计划**（要补发历史队列），就必须升级为 `required` 并补一个读回核验器 ——
//    因为跨批次重发（同一业务键、不同 requestId）时，revision 恰好 +1 看不出"云端早有一条重复的"。
const LEVELS = Object.freeze({ REQUIRED: 'required', RECEIPT_ONLY: 'receipt-only' })
const RISKS = Object.freeze({ MONEY: 'money', REWRITE: 'rewrite-existing', APPEND: 'append-only' })
const RISK_LABELS = Object.freeze({ money: '动钱', 'rewrite-existing': '改写既有数据', 'append-only': '只新增' })

// 已实现的只读核验器。**这里是唯一的事实来源**：policy 里点名但不在这个集合里 ⇒ 拒发。
const VERIFIERS = Object.freeze({
  'completion-ledger': '完课差量：课时恰好扣一次（used +1 / remaining −1）+ 收入恰好新增一笔 + 预约变 done + 本次 requestId 的回执恰好一条',
  'booking-moment': '读回该预约，date/hour/minute 必须**等于 payload 指定的值**，且该 bookingId 在云端恰好一条',
  'booking-content': '读回该预约，payload 里给了的 items/notes/category/duration/summary 必须逐字段相等',
  'booking-created': '按业务键（学员+课时包+日期+时刻）在云端**恰好一条**，且字段与 payload 一致（多一条就是重复建）',
  'exercise-created': '按业务键（动作名+部位）在云端**恰好一条**，且与 payload 一致（多一条就是重复建）',
  // —— M2 第三批：跨教练共享课时的只读核验器（依赖 `diagnoseSharedUsage` 这个零写入只读云函数）——
  //   它们读的是**两位教练**的数据，靠服务端从可信身份 + 共享关系推导对端位置；
  //   客户端提交任何 ownerCoachId / datasetId 都会被云函数判 FORBIDDEN_IDENTITY_INPUT。
  'shared-booking-created': '读回这条共享预约：① 在授课教练账里恰好一条 ② packageUsage 指向会员真实课时包 ③ 对端 reserved 恰好 +1 ④ 本侧与对端收据都 succeeded 且 revision 恰好 +1 ⑤ 会员/课时包/销售在全球只存在于一本账（没被复制）',
  'package-share-state': '读回共享许可：① 存在且恰好一枚 active ② 指向正确的课时包与会员 ③ 会员/课时包/销售在全球只存在于一本账 ④ 本人账里的学生/课时包/销售行数一条没变（没有复制业务数据）'
})

const POLICY = Object.freeze({
  // —— 动钱：必须读回核验 ——
  completeBooking: { level: LEVELS.REQUIRED, risk: RISKS.MONEY, verifier: 'completion-ledger', effect: '扣课时 + 记一笔收入 + 预约 → done', why: '同时改课时包与收入，只凭回执无法证明"恰好一次"' },
  deleteCompletedBooking: { level: LEVELS.REQUIRED, risk: RISKS.MONEY, verifier: null, effect: '返还课时 + 删收入 + 删预约', why: '反向动钱且不可逆；**尚无只读核验器 ⇒ 拒发**' },
  reverseCourseSale: { level: LEVELS.REQUIRED, risk: RISKS.MONEY, verifier: null, effect: '撤销销售并回退关联课时包', why: '动钱且不可逆；**尚无只读核验器 ⇒ 拒发**' },
  updatePackage: { level: LEVELS.REQUIRED, risk: RISKS.MONEY, verifier: null, effect: '改写既有课时包（used/remaining 就是钱）', why: '改的是钱；**尚无只读核验器 ⇒ 拒发**' },
  deletePackage: { level: LEVELS.REQUIRED, risk: RISKS.MONEY, verifier: null, effect: '删除既有课时包', why: '不可逆；**尚无只读核验器 ⇒ 拒发**' },
  updateCourseSale: { level: LEVELS.REQUIRED, risk: RISKS.MONEY, verifier: null, effect: '改写既有销售记录（金额）', why: '改的是钱；**尚无只读核验器 ⇒ 拒发**' },
  updateManualSale: { level: LEVELS.REQUIRED, risk: RISKS.MONEY, verifier: null, effect: '改写既有手工销售（金额）', why: '改的是钱；**尚无只读核验器 ⇒ 拒发**' },
  deleteManualSale: { level: LEVELS.REQUIRED, risk: RISKS.MONEY, verifier: null, effect: '删除既有手工销售', why: '不可逆；**尚无只读核验器 ⇒ 拒发**' },

  // —— 改写/删除既有业务行：必须读回核验 ——
  rescheduleBooking: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: 'booking-moment', effect: '改写既有预约的 date/hour/minute', why: '改的是她每天要看的课表时间，写错了看回执看不出来' },
  updateBookingContent: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: 'booking-content', effect: '改写既有预约的内容字段（items/notes/category/duration/summary）', why: '改的是课程内容，逐字段读回才能证明落到云端的就是她要的那份' },
  cancelBooking: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: null, effect: '删除既有预约', why: '不可逆；**尚无只读核验器 ⇒ 拒发**' },
  // M2 新增（第 23 条）：与 cancelBooking 同族 —— 删除既有预约，但只释放占座、不返还/不扣减 remaining。
  markBookingNotHeld: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: null, effect: '删除既有预约并释放占座（reserved −1；remaining / used 不变，不产生收入）', why: '不可逆；**尚无只读核验器 ⇒ 拒发**（与 cancelBooking 同族）' },
  updateStudent: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: null, effect: '改写既有学员', why: '**尚无只读核验器 ⇒ 拒发**' },
  deleteStudent: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: null, effect: '删除既有学员（并写墓碑）', why: '不可逆；**尚无只读核验器 ⇒ 拒发**' },
  updateCustomExercise: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: null, effect: '改写既有自定义动作', why: '**尚无只读核验器 ⇒ 拒发**' },
  deleteCustomExercise: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: null, effect: '删除既有自定义动作', why: '**尚无只读核验器 ⇒ 拒发**' },
  saveSettings: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: null, effect: '改写教练设置', why: '**尚无只读核验器 ⇒ 拒发**' },

  // —— 只新增、但会成为后续命令的父记录：仍必须读回核验 ——
  //    理由：它们的"新行"是后面 内容/完课/改期 的依赖，重复建会让后续依赖出现歧义；
  //    而且"载荷写错 = 静默故障"在本项目真实发生过（本机当成功、云端建出另一条）。
  createBooking: { level: LEVELS.REQUIRED, risk: RISKS.APPEND, verifier: 'booking-created', effect: '新增一条预约（后续 内容/完课/改期 都挂在它上面）', why: '父记录重复/字段写错会让后续命令落到错的对象上' },
  createCustomExercise: { level: LEVELS.REQUIRED, risk: RISKS.APPEND, verifier: 'exercise-created', effect: '新增一条自定义动作（会成为训练内容里的 item 引用）', why: '"恰好一条 + 内容匹配"是补发这类命令唯一可靠的判据' },

  // —— M2 第二批：跨教练共享课时包 ——
  // ⛳ **产品定位（2026-09-26 明确）**：`setPackageShare` + 共享码是**过渡期技术桥梁**，
  //    用于在"会员尚未自主选择教练"（M3）之前，安全地建立"这位授课教练可以用这份课时"的授权关系。
  //    它**不是**最终产品流程：最终是会员本人靠微信身份认自己的课时、自由添加/选择 A/B/C 教练，
  //    教练不需要先手工生成码。M3 上线后这条入口应当下线 —— **不要在这之上继续长大**。
  // ✅ 核验已补齐（第三批）：跨账只读证据来自 `diagnoseSharedUsage`（零写入只读云函数），
  //    定位由服务端从可信身份 + 共享关系推导 ⇒ 这两条命令现在可以在抢修 / 自动续跑通道放行。
  setPackageShare: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: 'package-share-state', effect: '开启/关闭课时包共享，并惰性补齐 reservedVersion 字段', why: '共享许可一旦被误开就等于把课时交出去；且必须证明它**没有把会员/课时包/销售复制到另一本账**' },
  createSharedBooking: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: 'shared-booking-created', effect: '新增一条共享预约，并**改写另一位教练数据集里**的课时包占座（reserved +1）', why: '跨数据集改写别人的课时包：必须读到对端那本账才能证明"恰好占了一节、课时没被复制"' },

  // —— M2 V1：正式多教练服务模型的双层授权 ——
  //   授权**不复制任何业务数据**（不复制学员/课时包/余额），只写关系表；但它决定"谁能动这份真实课时"，
  //   写错等于把课时交给错的人 ⇒ 与 setPackageShare 同族：**必须读回核验**。
  //   目前还没有对应的只读核验器 ⇒ 抢修 / 自动续跑通道**拒发**（页面正常流程不受此门禁影响）。
  createAuthorizedBooking: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: null, effect: '新增一条跨教练预约，并改写**另一位教练数据集里**的课时包占座（reserved +1）', why: '与 createSharedBooking 同族：跨数据集改写别人的课时包；**尚无只读核验器 ⇒ 抢修通道拒发**' },
  grantMemberService: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: null, effect: '授予会员级服务关系（决定谁能看到这位会员）', why: '授权写错等于把会员资料交给错的人；**尚无只读核验器 ⇒ 抢修通道拒发**' },
  revokeMemberService: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: null, effect: '撤销会员级服务关系', why: '撤销错了会让教练看不到仍在上课的会员；**尚无只读核验器 ⇒ 抢修通道拒发**' },
  grantPackageTeaching: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: null, effect: '授予课包级授课授权（决定谁能用这份真实课时排课）', why: '授权写错等于把课时交给错的人；**尚无只读核验器 ⇒ 抢修通道拒发**' },
  revokePackageTeaching: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: null, effect: '撤销课包级授课授权（有未完成预约时必须先处理预约）', why: '撤销错了会让进行中的课程失去归属；**尚无只读核验器 ⇒ 抢修通道拒发**' },
  transferPackageManagement: { level: LEVELS.REQUIRED, risk: RISKS.REWRITE, verifier: null, effect: '指定另一位教练接管该课包的权限管理权（历史销售与收入一律不动）', why: '交接错了等于把管理权交给错的人；**尚无只读核验器 ⇒ 抢修通道拒发**' },

  // —— 只新增独立行、业务键有服务端门禁、回执带回新 id、不动任何既有行 ⇒ 硬判据足够 ——
  createStudent: { level: LEVELS.RECEIPT_ONLY, risk: RISKS.APPEND, verifier: null, effect: '新增一条学员', why: '只新增独立行；服务端 ID/重名门禁；回执 result 已带回新 studentId；不触碰任何既有行' },
  createPackage: { level: LEVELS.RECEIPT_ONLY, risk: RISKS.APPEND, verifier: null, effect: '新增一条课时包', why: '只新增独立行；服务端 ID 门禁；回执 result 已带回新 packageId' },
  createCourseSale: { level: LEVELS.RECEIPT_ONLY, risk: RISKS.APPEND, verifier: null, effect: '新增一条销售记录', why: '只新增独立行；服务端 ID 门禁；回执 result 已带回新 id；不改既有金额' },
  createManualSale: { level: LEVELS.RECEIPT_ONLY, risk: RISKS.APPEND, verifier: null, effect: '新增一条手工销售', why: '只新增独立行；服务端 ID 门禁；回执 result 已带回新 id' }
})

function policyOf(command) {
  const name = String(command == null ? '' : command)
  const row = POLICY[name]
  if (!row) {
    // 未知命令 = **最严**处理：既不知道它改什么，也不可能有核验器。
    return {
      command: name, known: false, level: LEVELS.REQUIRED, risk: 'unknown', verifier: null,
      effect: '未知命令（不在 22 条业务命令清单内）', why: '未知命令一律按"必须核验且无核验器"处理 ⇒ 拒发'
    }
  }
  return Object.assign({ command: name, known: true }, row)
}
// 这条命令在发送**之前**必须满足什么？
function requirementOf(command) {
  const row = policyOf(command)
  const implemented = row.verifier !== null && Object.prototype.hasOwnProperty.call(VERIFIERS, row.verifier)
  return {
    command: row.command, known: row.known, level: row.level, risk: row.risk,
    verifier: row.verifier, implemented, effect: row.effect, why: row.why,
    // 只有"要求核验 + 核验器已实现"才允许发送。
    required: row.level === LEVELS.REQUIRED,
    canSend: row.level !== LEVELS.REQUIRED || implemented,
    neutralNote: row.level === LEVELS.RECEIPT_ONLY ? ('按策略无需业务级核验（' + (RISK_LABELS[row.risk] || row.risk) + '：' + row.why + '）') : ''
  }
}
// 发前门禁：**不可核验的命令绝不发送**（这一条必须用在发送之前，发完再说就晚了）。
function preflightOf(command) {
  const requirement = requirementOf(command)
  if (requirement.canSend) return { ok: true, requirement, code: null, message: '' }
  const code = requirement.known ? 'BUSINESS_VERIFY_UNAVAILABLE' : 'POLICY_UNKNOWN_COMMAND'
  const message = requirement.known
    ? ('这条命令按策略**必须**做业务级核验（' + (RISK_LABELS[requirement.risk] || requirement.risk) + '：' + requirement.effect + '），但还没有可用的只读核验器 ⇒ **不发**。' +
      '等补上核验器，或人工确认这一条要不要单独处理。')
    : ('命令 ' + requirement.command + ' 不在 22 条业务命令清单里 ⇒ 不知道它会改什么，**不发**。')
  return { ok: false, requirement, code, message }
}
// 整队发前体检（只读、纯函数）：把"哪些条目会被拒"一次性列出来，便于停手前就看清。
function preflightQueue(entries) {
  const rows = Array.isArray(entries) ? entries : []
  const blocked = []
  rows.forEach(entry => {
    const verdict = preflightOf(entry && entry.command)
    if (!verdict.ok) blocked.push({ entryId: String((entry && entry.entryId) || ''), command: String((entry && entry.command) || ''), code: verdict.code, message: verdict.message })
  })
  return { ok: blocked.length === 0, total: rows.length, blocked }
}
// 人读表（报告 / 文档共用一份）。
function policyText() {
  const lines = ['# 业务命令的核验策略（level ｜ 风险 ｜ 核验器）']
  Object.keys(POLICY).forEach(command => {
    const requirement = requirementOf(command)
    lines.push([
      command, requirement.level, RISK_LABELS[requirement.risk] || requirement.risk,
      requirement.verifier ? (requirement.verifier + (requirement.implemented ? '' : '（未实现 ⇒ 拒发）')) : '—'
    ].join(' ｜ '))
  })
  return lines.join('\n')
}

module.exports = {
  LEVELS, RISKS, RISK_LABELS, POLICY, VERIFIERS,
  policyOf, requirementOf, preflightOf, preflightQueue, policyText
}
