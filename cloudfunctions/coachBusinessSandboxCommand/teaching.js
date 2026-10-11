// M2 业务模型校正（2026-09-27）：**会员拥有自己的真实课时事实**。
//
// ★★ 一句话模型（写给下一个改这个文件的人）★★
//   不存在「课时包所属教练」，不存在「A 把课时共享给 B」，不存在「B 消费 A 的课时」，
//   也不存在「会员归属于某个教练」。
//   真实情况只有两件事：
//     ① 课时事实属于**会员本人**（remaining / reserved / used 只有一份，物理存在某一本账里）；
//     ② A / B / C 只是**可能给这位会员上课的教练** —— 区别只在「这一节是谁在上」。
//   所以一条预约必须同时回答两个问题：谁发起的（source / createdBy），谁实际授课（teachingCoachId）。
//   课时归谁**不由创建者决定**：谁创建的预约都不改变课时事实的归属。
//
// 为什么还要有 teachingCoachId：
//   预约这条数据物理落在**发起/授课教练**那本账里，课表也是那本账的课表。
//   把它显式记下来，M3「会员自己选教练 → 预约」才能复用**同一条预约**，
//   而不需要新建第二套预约系统（会员预约与教练预约是同一种预约，只是发起方不同）。
//
// ⚠️ 旧数据兼容：历史 booking 没有这两个字段 ⇒ `teachingCoachIdOf()` 回落到
//    「这条预约所在那本账的 ownerCoachId」（老模型里 bookings 就在授课教练账里），语义一致，无需迁移。

// ⭐ 冲突检测**必须**与 handlers.overlaps 共用 occupancy 那份实现（跨午夜区间的唯一正确算法）。
//   ⛔ 在这里另抄一份区间数学，就是给"会员冲突"和"教练冲突"造两套口径的开端。
const occupancy = require('./occupancy')

const SOURCE_COACH = 'coach'
const SOURCE_MEMBER = 'member'

// 预约创建时的身份三件套：谁发起 + 谁授课。
//   teachingCoachId   默认 = 当前教练（教练端发起 ⇒ 发起者就是授课者）
//   M3 会员端发起时由会员选择的教练决定 —— 那时 source='member'、createdByMemberId 有值，
//   **但数据形状从现在就是这样**，不需要到时候再改结构。
function identityFor(business, payload) {
  const source = payload && payload.source === SOURCE_MEMBER ? SOURCE_MEMBER : SOURCE_COACH
  return {
    teachingCoachId: business.ownerCoachId,
    source,
    createdByCoachId: source === SOURCE_COACH ? business.ownerCoachId : null,
    createdByMemberId: null
  }
}

// 旧预约没有 teachingCoachId ⇒ 回落到"这条预约存在谁那本账"（= 老模型下的授课教练）。
function teachingCoachIdOf(booking, rowOwnerCoachId) {
  const value = booking && booking.teachingCoachId
  return typeof value === 'string' && value ? value : (rowOwnerCoachId || null)
}

// ------------------------------------------------------------------ 会员时间冲突
//
// ⭐ 预约成功前服务端必须最终校验三件事（缺一不可，且**不信任客户端页面当前显示的数据**）：
//   ① 授课教练这个时间没冲突   —— 在**授课教练自己的课表**里查
//   ② 会员这个时间没冲突       —— 在**所有已知持有这位会员预约的账本**里查
//   ③ 会员仍有 availableToBook > 0 的课时包
//   ② 是本文件存在的理由：教练 A 的课表不占教练 B 的时间，但**同一个会员的时间是共享的**，
//      A 14:00 给小蓝上课 ⇒ B 不能给小蓝再约 14:00。
//
// 「已知账本」（places）的确定方式，**不接受客户端提交**：
//   当前教练自己的 (ownerCoachId, datasetId)  +  课时包物理所在的那本账（来自共享许可 / packageUsage）。
// ⚠️ 已知边界（如实写，不要假装覆盖了）：如果这位会员在**第三位教练**那里还有一份
//    完全独立的学员档案（不同的 studentId），且既没有共享许可也没有认领关系把它们连起来，
//    系统目前无从知道那是同一个人 ⇒ 那本账不在此列。这是 M3「会员身份统一」要补的部分。

function dedupePlaces(places) {
  const seen = new Set(), out = []
  ;(places || []).forEach(place => {
    if (!place || !place.ownerCoachId || !place.datasetId) return
    const key = `${place.ownerCoachId}::${place.datasetId}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ ownerCoachId: place.ownerCoachId, datasetId: place.datasetId })
  })
  return out
}

// 分钟级重叠判定：**与 handlers.overlaps 同口径** —— 绝对分钟轴上的真区间相交。
//
// ⛔ 旧实现按 `booking.date !== moment.date` 短路（只比同一天）+ 双方时长写死 60。
//    允许 23:30 → 次日 00:30 之后这两条都会**漏判真实冲突**：
//      · 会员 10-01 23:30–00:30，再约 10-02 00:00–01:00 ⇒ 日期不同，旧算法放行（实际人分身乏术）；
//      · 一条 90 分钟的课只按 60 分钟参与比较 ⇒ 尾部 30 分钟的重叠看不见。
//    ⇒ 改成与 handlers.overlaps **同一个** occupancy.intervalOf / intervalsOverlap，两端不许出现第二套算法。
function overlapsMoment(booking, moment, ignoredBookingId, plannedMinutes) {
  if (!booking) return false
  if (ignoredBookingId && (booking.id === ignoredBookingId || booking.bookingId === ignoredBookingId)) return false
  const a = occupancy.intervalOf(booking)
  const b = occupancy.intervalOf({ date: moment.date, hour: moment.hour, minute: moment.minute, plannedMinutes })
  return occupancy.intervalsOverlap(a, b)
}

function dataOf(row) { return row && row.data && typeof row.data === 'object' ? row.data : row || {} }

// 会员时间冲突：在 places 列出的每一本账里，查这位学员的**有效预约**是否与该时段重叠。
//   返回第一条冲突（含它属于哪本账），没有则 null。
// ⚠️ 只查 status==='booked'（已取消=已删文档；已完成=不占会员时间）。
async function findMemberTimeConflict({ businessAt, places, studentId, moment, ignoredBookingId, plannedMinutes }) {
  for (const place of dedupePlaces(places)) {
    const business = businessAt(place.ownerCoachId, place.datasetId)
    const rows = await business.collection('bookings').list({ studentId })
    for (const row of rows) {
      const booking = dataOf(row)
      if (booking.studentId !== studentId) continue
      if (booking.status !== 'booked') continue
      if (overlapsMoment(booking, moment, ignoredBookingId, plannedMinutes)) {
        return { bookingId: booking.id || row.bookingId || null, ownerCoachId: place.ownerCoachId, datasetId: place.datasetId, date: moment.date }
      }
    }
  }
  return null
}

module.exports = {
  SOURCE_COACH, SOURCE_MEMBER,
  identityFor, teachingCoachIdOf,
  dedupePlaces, overlapsMoment, findMemberTimeConflict
}
