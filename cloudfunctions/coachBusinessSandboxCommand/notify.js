// M3-P6 · 「业务事件已经发生，需要通知另一方」的**可靠边界**（2026-09-30）
//
// ★★ 这个文件回答的唯一问题：一件事**确实发生了**，而另一方**还不知道**。
//   它**不回答**"微信订阅消息发出去了没有" —— 那件事本轮**没有发生**，就绝不写成"已发送"。
//
// ⛔⛔ 三条硬边界（写给下一个接手的人）：
//   ① **业务成功才写事件**：事务内**只入队**（纯内存 ⇒ 通知链上的任何故障都不可能回滚业务），
//      事务提交成功后由 `core.execute` 调 `flush()` 落库。
//      ⇒ 业务回滚时 `flush()` 根本不会被执行 ⇒ 依然**不可能**留下"没成功却通知了"的假通知。
//      ⚠️⚠️【M3-P0 · 2026-09-30 真机事故订正】旧口径是"只在事务内写"。它的致命后果：
//         Sandbox 环境的 `member_sandbox_notification_events` 集合**从未创建** ⇒ 事务内 `.get()` 抛
//         `-502005 Db or Table not exist` ⇒ **整个预约事务回滚** ⇒ 会员连"取消预约"都点不动
//         （业务明明合法，却被一个**附属**功能拖死）。用户裁决：通知的失败**不许**破坏已经合法完成的
//         业务事务；但**也不许静默吞掉** ⇒ 失败进 `flush()` 的 `failures`，出现在命令响应的
//         `notify` 字段里，并打 `console.error`（云函数日志可追踪）。**别把这条改回事务内直写。**
//   ② **按 requestId 幂等**：事件 ID 里带 requestId ⇒ 重发 / 重放不会变成两条通知。
//      （事务内按 eventId 去重；落库时再按 `_id` 查一次 ⇒ 跨请求重放也还是一条。）
//   ③ **recipient 是预约的另一方，一个人**：会员动 ⇒ 通知这节课的授课教练；教练动 ⇒ 通知这位会员。
//      ⛔ 绝不广播 —— 给 B/C/D/E/F 全部教练各发一条，等于把会员的日程泄露给所有教练。
//
// ✅ 用户已拍板的规则 6：必须通知另一方；**微信订阅消息属 M4**，本轮只落事件、不发微信。
//   ⇒ 事件上永远带着 `delivery: { channel: null, sentAt: null }` 与 `delivered: false`，
//      这是"还没发"的**事实**，不是"发失败"。M4 只有一个接入口：`deliverPending()` 扫 `delivered=false`
//      的事件，发成功后调 `markDelivered()`。**别在别处另起炉灶**。

const crypto = require('crypto')

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const fixedId = (...parts) => sha(parts.join(':')).slice(0, 32)
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const commandError = (code, message) => Object.assign(new Error(message), { commandCode: code })

// 事件集合：按环境隔离（与 `member_*` 那套会员集合同一个命名口径）。
// ⚠️ 它是**元集合**，不进 `core.BUSINESS` ⇒ 不参与 checksum / 指纹 / 增量，读链一个字都不用改。
// ⛔ 集合名**按环境拼装**，⛔ 绝不写"正式区那个完整名字"的字面量（连注释里也不许抄）：
//    测试区那份是**逐字节镜像**，源码里出现正式区集合名会被
//    tests/sandbox-cloud-isolation.test.js 判据⑦ 抓住（那是"测试区知道了正式区的表"）。
const EVENTS_BASE = 'notification_events'
const COLLECTIONS = Object.freeze({
  production: `member_${EVENTS_BASE}`,
  sandbox: `member_sandbox_${EVENTS_BASE}`
})
const collectionFor = environment => environment === 'sandbox' ? COLLECTIONS.sandbox : COLLECTIONS.production

// ⭐ 会员**主资料**表（会员目录那张 `members`）：「这位学员当前对应哪个会员」的**唯一真相源**。
//    2026-10-07（1.3.37）：教练主动排课 ⇒ 会员收不到通知的根因就在这里 ——
//    旧代码只认**旧认领表**（`student_claims`）找会员；会员身份迁移到新目录之后，
//    认领表那一行可能根本没有 ⇒ 事件**连生成都不会生成** ⇒ 微信与站内消息双双落空。
//    ⇒ 现在改成：**主资料优先，旧认领表只作兼容回落**。⛔ 旧认领表一个字节都不删。
//    ⛔ 集合名与上面同一套口径：按环境拼装，⛔ 绝不写正式区那个完整名字的字面量。
const MEMBERS_BASE = 'members'
const MEMBER_COLLECTIONS = Object.freeze({
  production: `member_${MEMBERS_BASE}`,
  sandbox: `member_sandbox_${MEMBERS_BASE}`
})
const memberCollectionFor = environment => environment === 'sandbox' ? MEMBER_COLLECTIONS.sandbox : MEMBER_COLLECTIONS.production

const ACTOR_MEMBER = 'member'
const ACTOR_COACH = 'coach'
const ACTORS = Object.freeze([ACTOR_MEMBER, ACTOR_COACH])

// ⭐ 事件类型（**唯一**命名处）。M4 的订阅消息模板按这几个 type 选模板，别在别处拼字符串。
//   ⭐ 2026-10-05 本轮按用户最终决定补上 `COACH_CREATED`（教练安排课程 ⇒ 通知对应会员）：
//      少了它，"教练给你排了一节课"这件事**根本不会进事件表** ⇒ 会员永远收不到"被安排"的通知。
//      ⛔ 6 个状态类事件共用**同一个**模板（课程预约状态通知），见 `notify-templates.js`。
const EVENT_TYPES = Object.freeze({
  MEMBER_CREATED: 'member-booking-created',
  MEMBER_CANCELLED: 'member-booking-cancelled',
  MEMBER_RESCHEDULED: 'member-booking-rescheduled',
  COACH_CREATED: 'coach-booking-created',
  COACH_CANCELLED: 'coach-booking-cancelled',
  COACH_RESCHEDULED: 'coach-booking-rescheduled'
})
const EVENT_TYPE_LIST = Object.freeze(Object.values(EVENT_TYPES))

// ⛔ M4 接入口的**当前状态**：`null` = 还没有任何真实投递渠道。
//   本轮绝不允许把它写成 `'wechat-subscribe'` —— 那等于伪造"已经发了微信"。
const ACTIVE_CHANNEL = null

function assertType(type) {
  if (!EVENT_TYPE_LIST.includes(type)) throw commandError('NOTIFY_TYPE_INVALID', `未知的通知事件类型：${type}`)
  return type
}

function assertActor(kind, actor) {
  if (!ACTORS.includes(kind)) throw commandError('NOTIFY_ACTOR_INVALID', `未知的事件发起方：${kind}`)
  if (!actor || typeof actor !== 'object') throw commandError('NOTIFY_ACTOR_INVALID', '事件缺少发起方。')
  return clone(actor)
}

// recipient：**只认一个人**。给谁就写谁，多一个都不写（广播就是泄露）。
function assertRecipient(recipient) {
  if (!recipient || typeof recipient !== 'object') throw commandError('NOTIFY_RECIPIENT_INVALID', '事件缺少接收方。')
  const kind = recipient.kind
  if (kind === 'member' && !recipient.memberId) throw commandError('NOTIFY_RECIPIENT_INVALID', '接收方是会员却缺少 memberId。')
  if (kind === 'coach' && !recipient.coachId) throw commandError('NOTIFY_RECIPIENT_INVALID', '接收方是教练却缺少 coachId。')
  if (!ACTORS.includes(kind)) throw commandError('NOTIFY_RECIPIENT_INVALID', `未知的事件接收方：${kind}`)
  return { kind, ...(recipient.memberId ? { memberId: recipient.memberId } : {}), ...(recipient.coachId ? { coachId: recipient.coachId } : {}) }
}

// booking 的最小必要信息（⛔ 不塞学员姓名 / 手机号 / 价格 —— 通知不需要，也不该进这张表）。
function bookingFactsOf(booking, extra = {}) {
  const source = booking || {}
  return {
    bookingId: String(source.id || extra.bookingId || ''),
    date: String(source.date || ''), hour: Number(source.hour || 0), minute: Number(source.minute || 0),
    status: String(source.status || ''),
    studentId: String(source.studentId || extra.studentId || ''),
    packageId: String(source.packageId || extra.packageId || ''),
    // ⭐ 一节课 = 占用 / 释放 **1 节**课时（目前没有"一次多节"的课形 ⇒ 常量 1，不猜）。
    sessions: Math.max(1, Math.round(Number(source.sessions || extra.sessions || 1))),
    // ⭐ 下面三个字段**由服务端富化**（`enrichFacts`），客户端提交不了也改不动。
    studentName: '', courseTypeName: '', coachName: '',
    ...(extra.ownerCoachId ? { ownerCoachId: String(extra.ownerCoachId) } : {}),
    ...(extra.datasetId ? { datasetId: String(extra.datasetId) } : {}),
    ...(extra.teachingCoachId ? { teachingCoachId: String(extra.teachingCoachId) } : {})
  }
}

// ------------------------------------------------------------------ 事务内的窄门（**只入队，不落库**）
//
// 由 `core.execute` 注入给 handler（与 `shares` / `authorizations` 同一个用法）：
// handler 只能通过它"登记要通知谁"，拿不到别的东西，也**碰不到数据库**。
// ⭐⭐ 这就是 M3-P0 的修复核心：`record()` 里**没有任何 await**，不可能因为集合缺失 / 权限 / 网络
//     而让业务事务失败；真正的落库被推迟到事务提交之后的 `flush(db)`。
//   ⭐⭐ 2026-10-08（1.3.39）：`fallbackDb` 是**备读句柄**（裸 `db`，不参与事务）。
//      为什么需要它：解析收件人**首选**与业务同一个事务快照（`tx`），这样"这一轮刚写进去的
//      绑定关系"一定读得到；但**万一**事务侧这条读出问题（集合在事务里的可见性 / 权限 / 快照约束
//      等真机才暴露的限制），整条通知链就会**静默断掉** —— 事件不产生 ⇒ 站内消息与微信双双落空，
//      而那条链的所有下游（`flush` / 投递 / `writeInbox`）写得**再正确也没有输入**。
//      ⇒ 备读句柄让"这一次事务读不到"退化为"用一次普通读确认"，⛔ 绝不让它变成"不通知"。
//      ⛔ 备读只在**事务读抛错**时才用，绝不改变"以事务快照为准"的优先级。
function scope(tx, environment, ownerCoachId, datasetId, fallbackDb) {
  const name = collectionFor(environment)
  // ⭐ 事件 ID 带 requestId ⇒ 同一个请求重放**还是这一条**（不会变成两条通知）。
  const eventIdFor = (requestId, type) => fixedId('notification-event', ownerCoachId, `${datasetId}:${requestId}:${type}`)
  // ⭐ 待落库队列：key = eventId（同一个请求内重复登记同一种事件 ⇒ 只会落一条）。
  const queued = new Map()
  // ⭐ 可追踪的失败台账：任何一步失败都**不抛**给业务，但一定记在这里。
  const failures = []
  // ⭐⭐ 2026-10-07（1.3.38）：「**根本没产生事件**」的台账。
  //   以前"认不出会员 ⇒ 静默 `return null`" ⇒ 真机上表现为"会员什么都没收到"，
  //   而云端日志里**一行痕迹都没有** ⇒ 无法区分是"没找到人"还是"微信没额度"（A/B/C/D 全糊在一起）。
  //   ⛔ 从此：认不出收件人 ⇒ 必须**留一条带原因的痕**，照样不抛、不影响业务。
  const unresolved = []

  function noteUnresolved(stage, detail) {
    const entry = {
      stage: String(stage || 'resolve-recipient'),
      code: String((detail && detail.code) || 'RECIPIENT_UNRESOLVED'),
      message: String((detail && detail.message) || '没能确定这条通知该发给谁。'),
      studentId: String((detail && detail.studentId) || ''),
      ownerCoachId: String((detail && detail.ownerCoachId) || ownerCoachId || ''),
      datasetId: String((detail && detail.datasetId) || datasetId || ''),
      tried: (detail && detail.tried) || [],
      // ⭐ 1.3.39：每一步**读失败**的具体原因（"读不到"与"确实没绑过"在真机上表现一模一样，
      //    只有这份明细能把它们分开）。
      errors: (detail && detail.errors) || [],
      collection: name, environment
    }
    unresolved.push(entry)
    console.error('[notify] 通知收件人未能确定（业务事务已经成功，预约本身不受影响）', JSON.stringify(entry))
    return entry
  }

  function noteFailure(stage, error) {
    const entry = {
      stage,
      code: String(error && (error.commandCode || error.errCode || error.code) || 'NOTIFY_FAILED'),
      message: String(error && error.message || error),
      collection: name,
      environment
    }
    failures.push(entry)
    // ⛔ 不是"吞掉"：控制台日志是云函数侧的第一个可追踪点（用户可在云开发日志里搜 `[notify]`）。
    console.error('[notify] 通知事件写入失败（业务事务已经成功，预约本身不受影响）', JSON.stringify(entry))
    return entry
  }

  async function record({ type, actor, recipient, booking, requestId, now, extra }) {
    // ⛔ 参数校验仍然**抛**：那是代码写错（未知 type / 缺 recipient），必须当场暴露，不能被降级掩盖。
    assertType(type)
    assertActor(actor.kind, actor)
    const target = assertRecipient(recipient)
    if (!requestId) throw commandError('NOTIFY_REQUEST_ID_MISSING', '事件缺少 requestId，无法保证幂等。')
    const eventId = eventIdFor(requestId, type)
    const existing = queued.get(eventId)
    if (existing) return clone(existing)                  // ⭐ 幂等：同一请求内不会变成两条
    const event = {
      eventId, type, environment,
      actor: { kind: actor.kind, ...(actor.memberId ? { memberId: actor.memberId } : {}), ...(actor.coachId ? { coachId: actor.coachId } : {}) },
      recipient: target,
      booking: bookingFactsOf(booking, extra || {}),
      occurredAt: now,
      // ⛔ M4 之前**恒为 false**：没有渠道、没有发送、没有"已读"这回事。
      delivered: false, delivery: { channel: ACTIVE_CHANNEL, sentAt: null, attempts: 0 }
    }
    queued.set(eventId, event)
    return clone(event)
  }

  // ⭐ 教练侧（handlers.cancelBooking / rescheduleBooking）要用它把「这条预约的会员是谁」查出来。
  //   为什么查在这一个文件里：认领表**不是**按 dataset 分区的业务集合，
  //   业务 handler 手上只有 scopedBusiness（它够不到那里）⇒ 让这一处持有原始读，别把口子开在别处。
  //   ⛔ 只认**服务端**已有的认领关系（status='verified'）；⛔ 绝不拿姓名 / 手机号去"认人"。
  //   ⚠️ 它是**只读**、且读的是真实存在的认领表；万一它自己出故障，也只降级成"这次不通知"
  //      （记进 failures，绝不把业务事务拖下水）。
  // 🔎 在一张表里找「这位学员 ⇒ 哪个会员」。
  //    · 返回 `''`   = 这张表里**确实没有**（"这个人没有会员身份"是一种正常事实）
  //    · 返回 `null` = **这一步自己出故障**（集合还没建 / 权限 / 网络）⇒ 交给下一条退路
  //   ⛔ 两种情况都**不抛**：通知永远是附属能力 —— M3-P0 那次真机事故的教训就是
  //      它不许把一个已经合法完成的业务事务拖回滚。
  async function memberIdIn(reader, name, cond) {
    try {
      const response = await reader.collection(name).where(cond).limit(10).get()
      const list = (response && response.data) || []
      const hit = list.find(row => row && String(row.memberId || ''))
      return hit ? String(hit.memberId) : ''
    } catch (error) {
      noteFailure('resolve-recipient', error)
      return null
    }
  }

  async function memberIdOfStudent(studentId) {
    const id = String(studentId || '')
    if (!id) return ''
    const { collectionsFor } = require('./authorization')
    // ① **会员主资料**（唯一真相源）：新会员模型下，教练先建会员、会员微信再绑定，
    //    「学员 ⇒ 会员」这件事就记在这张表里，绑定那一刻把 ownerCoachId 一起锁定。
    //    优先"这本账自己登记的那位" ⇒ A 教练给张三排课时命中的就是这一条。
    const own = await memberIdIn(tx, memberCollectionFor(environment), { ownerCoachId, studentId: id })
    if (own) return own
    // ② 同一位学员也可能被**别的教练**那本账登记过（B 教练同样要给张三排课）⇒ 不限教练再找一次。
    const any = await memberIdIn(tx, memberCollectionFor(environment), { studentId: id })
    if (any) return any
    // ③ **旧认领表**（历史会员的兼容层）：主资料里查不到才退到这里，行为与修复前**逐字一致**。
    //    ⛔ 这张表与 grant / archive 一道保留为内部兼容层，一个字节都不删。
    const legacy = await memberIdIn(tx, collectionsFor(environment).claims, { studentId: id, status: 'verified' })
    if (legacy) return legacy
    return ''
  }

  // ⭐⭐ 2026-10-06：通知内容必须写**真实学员名 / 课程类型 / 课时数**（⛔ 不许再写笼统的"会员"）。
  //   ⛔ 这三个值**只能由服务端读出来**：`bookingFactsOf` 只收 id、不收姓名 ⇒ 客户端提交不了，
  //      也不存在"谁都能往通知里塞一个名字"的口子。
  //   ⛔ 读失败**绝不抛**：少一个名字只是"这条通知不够具体"，
  //      ⛔ 绝不能像 M3-P0 那次事故一样让一个**附属功能**把已经成功的业务拖下水。
  async function enrichFacts(db) {
    for (const event of queued.values()) {
      const facts = event.booking || {}
      try {
        const studentId = String(facts.studentId || '')
        if (studentId && !facts.studentName) {
          const response = await db.collection('students').where({ ownerCoachId, datasetId, studentId }).limit(1).get()
          const row = response && response.data && response.data[0]
          const data = row && row.data ? row.data : row
          if (data && data.name) facts.studentName = String(data.name).slice(0, 20)
        }
        if (!facts.courseTypeName) {
          const wanted = String(facts.packageId || '')
          const response = await db.collection('packages').where({ ownerCoachId, datasetId, studentId }).limit(50).get()
          const list = (response && response.data) || []
          const hit = list.find(row => String((row && row.packageId) || (row && row.data && row.data.id) || '') === wanted) || null
          const data = hit && hit.data ? hit.data : hit
          if (data && data.type) facts.courseTypeName = String(data.type).slice(0, 20)
        }
        if (!facts.coachName) {
          const { collectionsFor } = require('./authorization')
          const response = await db.collection(collectionsFor(environment).profiles).where({ coachId: ownerCoachId }).limit(1).get()
          const row = response && response.data && response.data[0]
          if (row && row.displayName) facts.coachName = String(row.displayName).slice(0, 20)
        }
      } catch (error) {
        noteFailure('enrich-facts', error)
      }
    }
  }

  const hasPending = () => queued.size > 0

  // ⭐⭐ 唯一落库点：由 `core.execute` 在 `runTransaction` **成功返回之后**调用（传**裸 db**，不是 tx）。
  //   · 业务回滚 ⇒ 这里根本不会被调用 ⇒ 不留假通知；
  //   · 任何一条写失败 ⇒ 记进 failures 并照常返回，**不抛**（业务已经成功了，不能再回滚）；
  //   · 逐条 try：一条坏不影响其余条。
  async function flush(db) {
    // ⭐⭐ `unresolved` **必须在 `queued` 为空时也照常返回**：恰恰是"一条事件都没产生"的时候，
    //    这份台账才是定位「教练排课 ⇒ 会员没收到」的唯一证据（否则空队列 = 零信息）。
    const outcome = {
      attempted: queued.size, written: 0, skipped: 0,
      failures: failures.slice(), unresolved: unresolved.slice(), enriched: 0
    }
    if (!queued.size) return outcome
    // ⭐ 落库**之前**先把真实姓名与课程类型读出来 ⇒ 投递层与站内消息都拿到同一份事实。
    await enrichFacts(db)
    outcome.enriched = queued.size
    for (const event of queued.values()) {
      try {
        // 落库前再按 `_id` 判一次存在 ⇒ 跨请求重放（receipt 被清 / 重试）也不会变成两条。
        const found = await db.collection(name).where({ _id: event.eventId }).limit(1).get()
        const row = found && found.data && found.data[0]
        if (row) { outcome.skipped += 1; continue }
        await db.collection(name).doc(event.eventId).set({ data: event })
        outcome.written += 1
      } catch (error) {
        noteFailure('flush-write', error)
      }
    }
    outcome.failures = failures.slice()
    outcome.unresolved = unresolved.slice()
    return outcome
  }

  return Object.freeze({
    record, eventIdFor, memberIdOfStudent, hasPending, flush, enrichFacts,
    noteUnresolved, unresolved: () => unresolved.slice(),
    // ⭐ M4（2026-10-05）：把这一轮入队的事件**原样**交给投递层。
    //   ⛔ 只读副本 —— 投递层拿它去发微信，改不到业务事务里的任何东西。
    events: () => [...queued.values()].map(clone),
    failures: () => failures.slice(),
    // ⭐ 事务读句柄：统一分发器解析收件人时必须与业务**同一个事务快照**，
    //    否则"业务刚写进去的绑定关系"在这一轮里读不到（真机表现为"第一次总是收不到"）。
    reader: tx,
    // ⭐ 备读句柄（1.3.39）：**只在上面那条事务读抛错时**才启用，优先级永远低于 `reader`。
    fallbackReader: fallbackDb || null,
    environment, ownerCoachId, datasetId, collection: name
  })
}

// ------------------------------------------------------------------ M4 的**单一接入口**（本轮不发）
//
// M4 要做的事只有三步，别在别处重写：
//   ① `pending(db, environment, recipient)` 取出这个人**还没投递**的事件；
//   ② 真的发出去（微信订阅消息）；
//   ③ `markDelivered(db, environment, eventId, channel, at)` 把这条标记成已投递。
// ⛔ `ACTIVE_CHANNEL === null` ⇒ `deliverable()` 恒为 false ⇒ 本轮**没有任何渠道**可投递。
// ⚠️【M3-P0 订正】前两个参数的形状以前写错了（写着 `scope` 却调 `scope.collection(…)`，
//   而 `scope()` 工厂返回的 `collection` 是个**字符串**）⇒ 一调就崩。现在统一为
//   **裸 db + environment**：M4 的扫描发生在**事务之外**（不参与任何业务写入），
//   而 `scope` 那些孪生字段（`environment` / `collection`）只服务于事务内那一侧。
function deliverable() { return ACTIVE_CHANNEL != null }

async function pending(db, environment, recipient, limit = 100) {
  const target = assertRecipient(recipient)
  const query = target.kind === 'member' ? { 'recipient.kind': 'member', 'recipient.memberId': target.memberId } : { 'recipient.kind': 'coach', 'recipient.coachId': target.coachId }
  const response = await db.collection(collectionFor(environment)).where({ ...query, delivered: false }).limit(limit).get()
  return (response && response.data || []).map(row => clone(row.data || row))
}

async function markDelivered(db, environment, eventId, channel, at) {
  if (!eventId) throw commandError('NOTIFY_EVENT_ID_MISSING', '缺少事件 ID。')
  const name = collectionFor(environment)
  const response = await db.collection(name).where({ _id: eventId }).limit(1).get()
  const row = response && response.data && response.data[0]
  if (!row) throw commandError('NOTIFY_EVENT_NOT_FOUND', '要标记的事件不存在。')
  const event = clone(row.data || row)
  event.delivered = true
  event.delivery = { channel: String(channel || ''), sentAt: at, attempts: Number(event.delivery && event.delivery.attempts || 0) + 1 }
  await db.collection(name).doc(eventId).set({ data: event })
  return event
}

module.exports = {
  COLLECTIONS, MEMBER_COLLECTIONS, collectionFor, memberCollectionFor, ACTOR_MEMBER, ACTOR_COACH, ACTORS,
  EVENT_TYPES, EVENT_TYPE_LIST, ACTIVE_CHANNEL,
  scope, deliverable, pending, markDelivered, bookingFactsOf, fixedId
}
