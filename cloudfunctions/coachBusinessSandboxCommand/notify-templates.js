// ─────────────────────────────────────────────────────────────────────────────
// 📮 微信订阅消息「**模板**」的唯一真源（2026-10-05 用户最终决定：**只要 3 个模板**）
//
// ⭐⭐ 用户拍板的口径（不要再改回 5 个）：
//   「课程里的业务事件可以继续分开保存，但**允许多个业务事件共用同一个微信模板 ID**。」
//   ⇒ 8 种业务事件 → 3 个模板：
//
//     ① **预约状态提醒**（`course-status`）—— 6 种情况共用：
//        会员预约成功 / 会员取消 / 会员改期（这三种发给**教练**）
//        教练安排课程 / 教练取消 / 教练改期（这三种发给**会员**）
//     ② **日程提醒**（`reminder-3h`）—— 上课前 3 小时，教练与会员各一条
//     ③ **活动开始提醒**（`reminder-1h`）—— 上课前 1 小时，教练与会员各一条
//
// ⭐ 为什么"共用"是对的（一次性订阅的额度账）：
//   **一次性订阅**的规则是：用户点一次「允许」= 这个模板**只换来一条**推送机会。
//   如果拆成 5 个模板，一次授权虽然拿到 5 条额度，但每个模板的那一条只能用于它对应的那种事件，
//   结果就是"教练改期"发过一次之后再也发不出去，而"教练取消"那条额度还躺着 ⇒ **额度碎片化**。
//   合并成 3 个 ⇒ 一次授权得到的额度正好覆盖"一节课从预约到上课"的完整链路：
//   一次状态通知 + 一次 3 小时提醒 + 一次 1 小时提醒。
//
// ✅ **长期订阅结论（2026-10-06 用户在微信公众平台**亲自查看**后定稿）**：
//    长期订阅页面显示「**暂时没有可选用的模板**」⇒ 当前这 3 个模板**全部是一次性订阅**。
//    ⇒ 实现与文案一律按一次性订阅：一次同意**只够一条提醒**，⛔ 绝不写"已开启 / 永久开启"，
//       ⛔ 也绝不用循环弹窗或自动调用授权接口去伪造"无限通知"。
//    ⇒ 因此「不限次数、不漏消息」只能靠**站内消息中心**兜底，微信发不出去时站内消息**照旧存在**。
// 📌 结论常量见文件末尾的 `ONE_TIME_CONFIRMED` / `ONE_TIME_NOTE`（界面文案的唯一出处）。
//
// ✅ 2026-10-05 夜：用户已在公众平台「订阅消息 → 我的模板」选用到 3 个**真实**模板，
//    并把模板 ID 与**每个模板各自的字段名**抄到了这里（`fields` 的 key 与顺序 = 后台模板详情原样）。
//    ⛔ 以后换模板 / 改字段，只改 `TEMPLATE_IDS` 与 `TEMPLATE_META[slot].fields`，
//       `messageOf` / `valuesOf` 一个字都不用动（它们只认 `role`，不认微信的字段名）。
//
// 📌 本文件**自包含**（不 require 任何东西）：它要被复制到 4 个云函数目录里做孪生副本
//    （正式区业务函数 / 测试区业务函数 / 正式区定时提醒 / 测试区定时提醒），
//    云函数按目录独立部署，跨目录 require 是取不到的 ⇒ 四份必须**逐字节相同**
//    （由 tests/member-notify-subscribe.test.js 钉死）。
//    ⛔ 注释里不许点名那几个**测试区**函数目录名：正式区源码出现 Sandbox 函数名会被
//       tests/sandbox-cloud-isolation.test.js 判为"正式区知道了测试区的存在"（隔离护栏）。
// ----------------------------------------------------------------------------

// 🎯 三个模板槽位
const TEMPLATE_SLOTS = Object.freeze({
  COURSE_STATUS: 'course-status',
  REMINDER_3H: 'reminder-3h',
  REMINDER_1H: 'reminder-1h'
})

// 🆔 微信后台「订阅消息 → 我的模板」里**真实存在**的 3 个模板 ID（2026-10-05 用户提供）。
//   ⛔ 三个槽位的 ID **互不相同**（微信不允许两个模板 ID 相同）；空串 = 还没选用到。
const TEMPLATE_IDS = Object.freeze({
  [TEMPLATE_SLOTS.COURSE_STATUS]: 'KaiavgpdRZYNKJgKZLMw64M4RdtMvSLCB-q0KUKhhF8',   // 预约状态提醒
  [TEMPLATE_SLOTS.REMINDER_3H]: '0-SPkXsTnOR1N2ZIl8wcwzJefIKuufNqjXrsi_-ilR8',     // 日程提醒（提前 3 小时）
  [TEMPLATE_SLOTS.REMINDER_1H]: 'C64-zL8lSAr0rzfEyGokYBkVDMnAOzgDxb-3bLOjiF4'      // 活动开始提醒（提前 1 小时）
})

// ⭐ `role` 是**语义**（这件事在这个字段里要说什么），与微信的字段名解耦：
//    status=预约状态 / counterpart=对方 / when=上课时间 / place=地点 / note=温馨提示
//    lead=提前多久 / subject=主题 / course=课程名 / coach=授课教师 / member=参与会员
//    ⇒ 后台字段叫什么、第几个，都只改 `fields`，`valuesOf` / `messageOf` 一个字都不用动。
const FIELD_ROLES = Object.freeze([
  'status', 'subject', 'when', 'counterpart', 'place', 'note', 'lead', 'course', 'coach', 'member'
])

// ⛔⛔ `fields` 里的 `key` 是微信后台这个模板**真实的字段名**（不是我们猜的），
//     数组**顺序**也要与后台「模板详情」一致（`messageOf` 就是按这个顺序拼 `data` 的）。
//     `type` 是微信的字段类型，`limit` 是微信对该类型的**硬上限**（超过 ⇒ 整条 47003 发不出去）。
//       · thing  = 20 个以内字符
//       · phrase = 5 个以内汉字
//       · time   = 时间（YYYY-MM-DD HH:mm:ss / YYYY-MM-DD HH:mm）
const TEMPLATE_META = Object.freeze({
  'course-status': {
    slot: TEMPLATE_SLOTS.COURSE_STATUS,
    name: '预约状态提醒',
    usage: '会员预约/取消/改期 ⇒ 通知授课教练；教练安排/取消/改期 ⇒ 通知对应会员。',
    fields: Object.freeze([
      { key: 'phrase1', type: 'phrase', role: 'status', label: '预约状态', sample: '预约成功', limit: 5 },
      { key: 'thing2', type: 'thing', role: 'counterpart', label: '预约方', sample: '会员', limit: 20 },
      { key: 'time3', type: 'time', role: 'when', label: '预约时间', sample: '2026-10-06 15:00', limit: 32 },
      // ⭐ 2026-10-06（用户要求）：「预约地点」原来写"详见课表"，对教练**毫无信息量**。
      //   ⇒ role 由 `place` 改为 `course`，`valuesOf` 会把**课时包 / 课程类型**填进来（如「拉伸课」）。
      { key: 'thing4', type: 'thing', role: 'course', label: '课程类型', sample: '拉伸课', limit: 20 },
      { key: 'thing5', type: 'thing', role: 'note', label: '温馨提示', sample: '已改为 10-06 19:00', limit: 20 }
    ])
  },
  'reminder-3h': {
    slot: TEMPLATE_SLOTS.REMINDER_3H,
    name: '日程提醒',
    usage: '每一节还没取消、还没完成的课，在开课前 3 小时提醒授课教练与会员各一次。',
    fields: Object.freeze([
      { key: 'thing9', type: 'thing', role: 'lead', label: '提醒内容', sample: '距离上课还有3小时', limit: 20 },
      { key: 'thing12', type: 'thing', role: 'course', label: '课程名', sample: '私教课', limit: 20 },
      { key: 'thing15', type: 'thing', role: 'member', label: '参与人', sample: '会员', limit: 20 },
      { key: 'thing17', type: 'thing', role: 'coach', label: '授课教师', sample: '教练', limit: 20 },
      { key: 'time19', type: 'time', role: 'when', label: '上课时间', sample: '2026-10-06 15:00', limit: 32 }
    ])
  },
  'reminder-1h': {
    slot: TEMPLATE_SLOTS.REMINDER_1H,
    name: '活动开始提醒',
    usage: '每一节还没取消、还没完成的课，在开课前 1 小时提醒授课教练与会员各一次。',
    fields: Object.freeze([
      { key: 'thing1', type: 'thing', role: 'subject', label: '活动主题', sample: '课程即将开始', limit: 20 },
      { key: 'time2', type: 'time', role: 'when', label: '活动时间', sample: '2026-10-06 15:00', limit: 32 },
      { key: 'thing3', type: 'thing', role: 'coach', label: '活动发起', sample: '教练', limit: 20 },
      { key: 'thing4', type: 'thing', role: 'place', label: '活动地点', sample: '详见课表', limit: 20 },
      { key: 'thing13', type: 'thing', role: 'member', label: '参与者', sample: '会员', limit: 20 }
    ])
  }
})

// 🗣️ 「次数用完了」必须说人话，⛔ 绝不能显示成"已订阅成功"。
//   ⛔ 微信 43101 既表示"从没授权过"也表示"额度用完了" —— 两种情况下**用户要做的事是一样的**，
//      所以提示语也必须一样：再去点一次「开启课程提醒」。
const NEED_REAUTHORIZE_TEXT = '提醒次数用完了，需要重新点一次「开启课程提醒」才能继续收到。'
const NEED_REAUTHORIZE_SHORT = '需要重新允许课程提醒'

// 🎯 业务事件种类（**唯一**命名处）。⛔ 前 6 个必须与 `notify.js` 的 `EVENT_TYPES` 逐字一致
//    （那条断言在 tests/member-notify-subscribe.test.js 里）。
const KINDS = Object.freeze({
  MEMBER_CREATED: 'member-booking-created',       // 会员预约成功 → 教练
  MEMBER_CANCELLED: 'member-booking-cancelled',   // 会员取消     → 教练
  MEMBER_RESCHEDULED: 'member-booking-rescheduled', // 会员改期   → 教练
  COACH_CREATED: 'coach-booking-created',         // 教练安排课程 → 会员
  COACH_CANCELLED: 'coach-booking-cancelled',     // 教练取消     → 会员
  COACH_RESCHEDULED: 'coach-booking-rescheduled', // 教练改期     → 会员
  REMINDER_3H: 'class-reminder-3h',               // 课前 3 小时  → 教练 + 会员
  REMINDER_1H: 'class-reminder-1h'                // 课前 1 小时  → 教练 + 会员
})
const KIND_LIST = Object.freeze(Object.values(KINDS))

// 🗺️ 事件 → 模板槽位（**多个事件共用同一个模板**就是这一张表）
const TEMPLATE_OF_KIND = Object.freeze({
  [KINDS.MEMBER_CREATED]: TEMPLATE_SLOTS.COURSE_STATUS,
  [KINDS.MEMBER_CANCELLED]: TEMPLATE_SLOTS.COURSE_STATUS,
  [KINDS.MEMBER_RESCHEDULED]: TEMPLATE_SLOTS.COURSE_STATUS,
  [KINDS.COACH_CREATED]: TEMPLATE_SLOTS.COURSE_STATUS,
  [KINDS.COACH_CANCELLED]: TEMPLATE_SLOTS.COURSE_STATUS,
  [KINDS.COACH_RESCHEDULED]: TEMPLATE_SLOTS.COURSE_STATUS,
  [KINDS.REMINDER_3H]: TEMPLATE_SLOTS.REMINDER_3H,
  [KINDS.REMINDER_1H]: TEMPLATE_SLOTS.REMINDER_1H
})

// 提醒种类 → 提前多少分钟（⛔ 只此一处，改口径不必改别处）
const LEAD_MINUTES_OF = Object.freeze({
  [KINDS.REMINDER_3H]: 180,
  [KINDS.REMINDER_1H]: 60
})

const SUBJECT_OF = Object.freeze({
  [KINDS.MEMBER_CREATED]: '会员预约成功',
  [KINDS.MEMBER_CANCELLED]: '会员取消课程',
  [KINDS.MEMBER_RESCHEDULED]: '会员修改课程时间',
  [KINDS.COACH_CREATED]: '教练安排课程',
  [KINDS.COACH_CANCELLED]: '教练取消课程',
  [KINDS.COACH_RESCHEDULED]: '教练修改课程时间',
  [KINDS.REMINDER_3H]: '课程即将开始',
  [KINDS.REMINDER_1H]: '课程即将开始'
})

// 🏷️ 「预约状态提醒」那个模板的 `phrase1`（⛔ 只用用户定死的这三个词，微信 phrase 类型要求 5 个汉字内）
//   ⭐ 2026-10-06：「时间变更」改成用户指定的「**已改期**」（更直白，同样 3 个汉字）。
const STATUS_OF = Object.freeze({
  [KINDS.MEMBER_CREATED]: '预约成功',
  [KINDS.MEMBER_CANCELLED]: '已取消',
  [KINDS.MEMBER_RESCHEDULED]: '已改期',
  [KINDS.COACH_CREATED]: '预约成功',
  [KINDS.COACH_CANCELLED]: '已取消',
  [KINDS.COACH_RESCHEDULED]: '已改期'
})
// ⛔ 课前提醒那两个模板**没有**状态字段 ⇒ 给一个中性占位（绝不会真的用到，但字段不能缺）
const STATUS_FALLBACK = '预约成功'

const LEAD_TEXT_OF = Object.freeze({
  [KINDS.REMINDER_3H]: '距离上课还有3小时',
  [KINDS.REMINDER_1H]: '距离上课还有1小时'
})

// 📍 我们没有"上课地点"这个字段 ⇒ 如实写"详见课表"（⛔ 绝不编造地址，也绝不把字段留空）
const PLACE_TEXT = '详见课表'
// 🎓 2026-10-06（用户要求）：**真实姓名**取代笼统的"会员"。
//   ⛔ 姓名由**服务端**从学员档案 / 教练档案读出，并在 `notify.js` 的 `enrichFacts()` 里
//      **写进事件事实** ⇒ 客户端提交不了、也改不动它 ⇒ 不存在"谁都能填一个名字"的口子。
//   ⛔ 仍然**不塞**手机号 / 价格 / 学员 id / 任何身份标识（订阅消息会显示在锁屏上）。
const COACH_TEXT = '教练'
const MEMBER_TEXT = '学员'
const DEFAULT_COURSE_NAME = '常规课'
// ✅ 长期订阅的**唯一结论**（2026-10-06 公众平台实测：长期订阅页面「暂时没有可选用的模板」）
const ONE_TIME_CONFIRMED = 'one-time-only'
const ONE_TIME_NOTE = '微信后台的长期订阅页面显示「暂时没有可选用的模板」，' +
  '当前这 3 个模板都是一次性订阅：一次同意只够下一条提醒。' +
  '所以每次业务操作后都要再点一次「允许下一条微信提醒」；' +
  '站内消息中心不受次数限制，任何时候都能看到全部消息。'

// 📱 点开通知跳到哪一页（教练看课表，会员看「我的预约」）
const PAGE_FOR_COACH = 'pages/schedule/schedule'
const PAGE_FOR_MEMBER = 'pages/member-bookings/member-bookings'
const PAGE_OF = Object.freeze({
  [KINDS.MEMBER_CREATED]: PAGE_FOR_COACH,
  [KINDS.MEMBER_CANCELLED]: PAGE_FOR_COACH,
  [KINDS.MEMBER_RESCHEDULED]: PAGE_FOR_COACH,
  [KINDS.COACH_CREATED]: PAGE_FOR_MEMBER,
  [KINDS.COACH_CANCELLED]: PAGE_FOR_MEMBER,
  [KINDS.COACH_RESCHEDULED]: PAGE_FOR_MEMBER,
  [KINDS.REMINDER_3H]: PAGE_FOR_COACH,
  [KINDS.REMINDER_1H]: PAGE_FOR_COACH
})

const templateIdFor = kind => String(TEMPLATE_IDS[TEMPLATE_OF_KIND[kind]] || '')

const slotOf = kind => String(TEMPLATE_OF_KIND[kind] || '')
const configuredSlots = () => Object.keys(TEMPLATE_IDS).filter(slot => !!String(TEMPLATE_IDS[slot] || ''))
const missingSlots = () => Object.keys(TEMPLATE_IDS).filter(slot => !String(TEMPLATE_IDS[slot] || ''))
const isConfigured = () => configuredSlots().length === Object.keys(TEMPLATE_IDS).length

const hhmm = booking => `${String(Number((booking && booking.hour) || 0)).padStart(2, '0')}:${String(Number((booking && booking.minute) || 0)).padStart(2, '0')}`
const whenText = booking => `${String((booking && booking.date) || '')} ${hhmm(booking)}`.trim()
// ⛔ 提示语里的日期要短（微信 thing 只有 20 个字）："2026-10-06" ⇒ "10-06"
const shortDate = booking => String((booking && booking.date) || '').replace(/^\d{4}-/, '')

// 🧩 这一步只决定"这段话说什么"（语义），**不碰微信的字段名**。
//   ⇒ 后台字段叫什么、第几个，改 `TEMPLATE_META[slot].fields` 就行，这里一个字都不动。
//   ⛔ 只写角色 + 脱敏称呼，⛔ 绝不写手机号 / 价格 / 学员 id / 任何身份标识。
// 🎓 「课时到底占了几节 / 放了几节」—— 2026-10-06 用户逐条指定的口径。
//   ⛔⛔ **只有取消事务真的成功、课时占用真的释放之后**，才会有"取消"这一类事件：
//      `notify.js` 的事件是**业务事务提交之后**才落库的（`core.execute` 里的 `flush(db)`），
//      事务一旦回滚 ⇒ 事件根本不存在 ⇒ 这里写"已释放 N 节"就**不可能是假话**。
//   ⛔ 超长被截短时的保留顺序：姓名 → 状态 → 时间 → 课程类型 → 课时变化。
function sessionNoteOf(kind, sessions) {
  const count = `${Math.max(1, Math.round(Number(sessions) || 1))}节`
  if (kind === KINDS.MEMBER_CANCELLED || kind === KINDS.COACH_CANCELLED) return `已释放${count}课时，该时间可以重新预约`
  if (kind === KINDS.MEMBER_RESCHEDULED || kind === KINDS.COACH_RESCHEDULED) return '新时间已占用，原时间已释放'
  if (kind === KINDS.MEMBER_CREATED || kind === KINDS.COACH_CREATED) return `已占用${count}课时`
  return ''
}

function valuesOf(event) {
  const source = event || {}
  const kind = String(source.type || '')
  const booking = source.booking || {}
  const slot = slotOf(kind)
  const toCoach = !!(source.recipient && source.recipient.kind === 'coach')
  const when = whenText(booking)
  // ⭐ 真实姓名与课程类型：**服务端**富化后写进事件事实的字段（`notify.js` 的 `enrichFacts`）。
  const studentName = String((booking && booking.studentName) || '')
  const coachName = String((booking && booking.coachName) || '')
  const courseName = String((booking && booking.courseTypeName) || '')
  const sessions = Number((booking && booking.sessions) || 1)
  const values = {
    status: STATUS_OF[kind] || STATUS_FALLBACK,
    subject: SUBJECT_OF[kind] || '课程变动',
    when,
    // ⛔ 不再写笼统的"会员"：发给教练就是**这位学员的真名**，发给会员就是**这位教练的真名**。
    counterpart: toCoach ? (studentName || MEMBER_TEXT) : (coachName || COACH_TEXT),
    place: PLACE_TEXT,
    // ⛔ 课程类型取自**课时包类型**（如「拉伸课」），拿不到才退到中性词（⛔ 绝不写"详见课表"占位）。
    course: courseName || DEFAULT_COURSE_NAME,
    coach: coachName || COACH_TEXT,
    member: studentName || MEMBER_TEXT,
    lead: LEAD_TEXT_OF[kind] || '',
    note: sessionNoteOf(kind, sessions)
  }
  // 课前提醒那两个模板没有"课时变化"这回事 ⇒ 温馨提示就是"还有多久上课"。
  if (slot === TEMPLATE_SLOTS.REMINDER_3H || slot === TEMPLATE_SLOTS.REMINDER_1H) values.note = LEAD_TEXT_OF[kind] || '请按时到课'
  return values
}

// 🧾 组装消息内容：**按后台真实的字段名与顺序**拼 `data`（否则微信回 47003）。
function messageOf(event) {
  const source = event || {}
  const kind = String(source.type || '')
  const slot = slotOf(kind)
  const toCoach = !!(source.recipient && source.recipient.kind === 'coach')
  const meta = TEMPLATE_META[slot]
  const fields = (meta && meta.fields) || []
  const values = valuesOf(event)
  const data = {}
  fields.forEach(field => {
    const limit = Number(field.limit) || 20
    const raw = String(values[field.role] == null ? '' : values[field.role])
    // ⛔ 空值也要给一个占位，绝不能把字段整个省掉 —— 缺字段微信直接回 47003。
    // ⛔ 超长**安全截短**（不抛错、不整条失败）：微信 thing 只收 20 字，多一个字整条发不出去。
    data[field.key] = { value: (raw || '-').slice(0, limit) }
  })
  return {
    data,
    // ⛔ 跳转页**只由收件人决定**（教练 ⇒ 课表；会员 ⇒ 我的预约）。
    //   ⚠️ 早先按"事件类型"取页是错的：课前提醒两个角色都会收到，
    //      按类型取会让**会员那份也跳到教练课表**（点了进不去）。
    page: toCoach ? PAGE_FOR_COACH : PAGE_FOR_MEMBER
  }
}

// 🔎 把微信侧的错误翻译成我们自己的说法（⛔ 一律如实，绝不把失败说成成功）。
//   ⛔ 这个函数也放在本文件：定时提醒云函数只带这一份自包含副本，不能 require 别的东西。
function mapSendError(error) {
  const errCode = Number(error && (error.errCode || error.code))
  const text = String((error && error.errMsg) || (error && error.message) || '')
  if (errCode === 43101 || /refuse|unsubscribe|not subscribe/i.test(text)) {
    // ⛔ 一次性订阅的"额度用完了"也落在这个码里 ⇒ 必须如实记成"没有授权"，⛔ 绝不假成功。
    //   ⛔ 而且必须明说"要重新允许"：用户以为已经开了，其实那一条额度早就用掉了。
    return { code: 'SUBSCRIBE_NOT_AUTHORIZED', message: NEED_REAUTHORIZE_TEXT, short: NEED_REAUTHORIZE_SHORT, needReauthorize: true, retryable: false }
  }
  if (errCode === 40003 || errCode === 40013 || /openid/i.test(text)) {
    return { code: 'RECIPIENT_OPENID_INVALID', message: '接收方的微信标识无效，无法发送提醒。', retryable: false }
  }
  if (errCode === 47003 || /template|data|keyword/i.test(text)) {
    return { code: 'TEMPLATE_ARGS_INVALID', message: '模板内容与申请的模板不匹配，请核对模板关键词。', retryable: false }
  }
  if (errCode === 40037 || errCode === 43104 || /template\s?id/i.test(text)) {
    return { code: 'TEMPLATE_NOT_CONFIGURED', message: '模板尚未配置。', retryable: true }
  }
  return { code: 'SEND_FAILED', message: String(text || '提醒发送失败。').slice(0, 120), retryable: true }
}

module.exports = {
  TEMPLATE_SLOTS, TEMPLATE_META, TEMPLATE_IDS, FIELD_ROLES,
  NEED_REAUTHORIZE_TEXT, NEED_REAUTHORIZE_SHORT,
  ONE_TIME_CONFIRMED, ONE_TIME_NOTE, PLACE_TEXT, COACH_TEXT, MEMBER_TEXT, DEFAULT_COURSE_NAME, sessionNoteOf,
  KINDS, KIND_LIST, TEMPLATE_OF_KIND, LEAD_MINUTES_OF,
  SUBJECT_OF, STATUS_OF, LEAD_TEXT_OF, PAGE_OF, PAGE_FOR_COACH, PAGE_FOR_MEMBER,
  templateIdFor, slotOf, configuredSlots, missingSlots, isConfigured,
  hhmm, whenText, shortDate, valuesOf, messageOf, mapSendError
}
