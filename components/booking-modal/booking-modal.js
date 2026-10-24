const { TYPES } = require('../../utils/constants')
const { getDB, saveDB, uid, pad, dateStr } = require('../../utils/data-runtime')
const { initials } = require('../../utils/pinyin')
const { currentStudent, validateBookingCreation } = require('../../utils/local-business-rules')
// ⭐ 开课时间窗口：**06:00–23:00 开课、每 30 分钟一档、且当天 24:00 前结束**（教练新建与会员自助同一条规则）。
//   与云端 occupancy.js 同一把尺（本机孪生），UI 与云端不会再出现两套口径。
const occupancy = require('../../utils/package-occupancy')
const { pendingBookingRecords } = require('../../utils/ui-cloud-command')
const mutate = require('../../utils/mutate')
// ⭐ 2026-10-02 · 「新建课程」的时间选择改成**三态时段小卡片**（可约 / 已排课 / 已过时间）。
//    卡片本身与会员端「约课时段」是同一套（styles/slots.wxss），
//    三态判定与时段生成**也共用同一个纯函数**（member-booking-view.slotsFor → occupancy.slotStateOf）
//    ⇒ 教练端和会员端不可能各写一套口径。
const memberView = require('../../utils/member-booking-view')
const coachAuthorization = require('../../utils/coach-authorization')
const { todayKey } = require('../../utils/beijing-date')
const notifyConsent = require('../../utils/notify-consent')
Component({
  properties: { visible: Boolean, presetDate: String, presetHour: Number },
  data: { step: 1, q: '', students: [], student: null, packages: [], packageIndex: -1, date: '', hour: 6, minute: 0, hours: [], timeEdit:false,
    // ⭐ 三态时段卡片：slots 由 buildSlots() 现算（读的是**已经在本机**的预约，不发任何网络请求）
    slots: [], slotAnchor: '', preciseOpen: false },
  observers: { visible(v) { if (v) this.init() } },
  methods: {
    noop() {},
    authorizedStudents(result) {
      if (!result || !result.usable || !result.data) return []
      const seen = new Set()
      return (result.data.serving || []).map(member => {
        const studentId = String(member && member.studentId || '')
        const place = member && member.place || {}
        const key = `${String(place.datasetId || '')}::${studentId}`
        if (!studentId || seen.has(key)) return null
        seen.add(key)
        const name = String(member.name || '会员')
        const packages = (member.packages || []).filter(pkg => !!String(pkg && pkg.packageId || '')).map(pkg => ({
          id: String(pkg.packageId), packageId: String(pkg.packageId), type: pkg.type || '常规训练',
          total: Number(pkg.total || 0), remaining: Number(pkg.remaining || 0), reserved: Number(pkg.reserved || 0),
          availableToBook: Number.isFinite(Number(pkg.availableToBook)) ? Number(pkg.availableToBook) : Math.max(Number(pkg.remaining || 0) - Number(pkg.reserved || 0), 0),
          price: Number(pkg.price || 0), status: 'active'
        }))
        return { id: `authorized:${key}`, authorized: true, studentId, name, phone: member.phone || '', abbr: initials(name), attend: 0,
          packages, totalLeft: packages.reduce((sum, pkg) => sum + Number(pkg.availableToBook || 0), 0) }
      }).filter(Boolean)
    },
    mergeStudents(locals, directory) {
      const localIds = new Set((locals || []).map(row => String(row.id || '')))
      return (locals || []).concat(this.authorizedStudents(directory).filter(row => !localIds.has(row.studentId)))
        .sort((a, b) => Number(b.attend || 0) - Number(a.attend || 0))
    },
    init() {
      const db = getDB(); const now = new Date()
      const att = {}; db.incomes.forEach(r => { if (r.studentId && r.typeName !== '其他') att[r.studentId] = (att[r.studentId] || 0) + 1 })
      const locals = db.students.filter(currentStudent).map(s => ({ ...s, abbr: initials(s.name), attend: att[s.id] || 0, totalLeft: (s.packages||[]).filter(p=>p.status!=='reversed').reduce((n,p)=>n+Number(p.remaining||0),0) }))
      const students = this.mergeStudents(locals, coachAuthorization.cachedDirectory())
      // ⭐ 可选小时的**下界与上界**都来自唯一常量（最早 / 最晚开课时间），不写死任何数字。
      //    📌 口径改过好几轮（07:00 → 06:00、24:00 → 23:30 → 23:00），这里始终**一行没动** ——
      //       因为两端都是算出来的，不会与云端脱钩。
      const earliestHour = Math.floor(occupancy.EARLIEST_START_MINUTES / 60)
      const latestHour = Math.floor(occupancy.latestStartMinutes() / 60)
      const wanted = this.properties.presetHour == null ? now.getHours() : this.properties.presetHour
      this.setData({ step: 1, q: '', students, allStudents: students, student: null, packageIndex: -1, date: this.properties.presetDate || dateStr(now), hour: Math.min(latestHour, Math.max(earliestHour, wanted)), minute: 0, hours: Array.from({ length: latestHour - earliestHour + 1 }, (_, i) => i + earliestHour), timeEdit:false, preciseOpen:false }, () => this.buildSlots())
    },
    // ⭐ 三态时段卡片的数据源。**只读本机已有数据**（本地投影 + 还没确认的本机意图），
    //   不发网络、不写任何东西 ⇒ 打开弹层不会为了等云端而卡住。
    buildSlots() {
      const db = getDB()
      const dateKey = this.data.date
      const today = todayKey()
      const now = new Date()
      const nowMinutes = dateKey === today ? now.getHours() * 60 + now.getMinutes() : null
      const pending = (typeof mutate.isCloudWritePath === 'function' && mutate.isCloudWritePath() && typeof pendingBookingRecords === 'function') ? pendingBookingRecords() : []
      // ⛔ 占用区间用**会员端同一个助手**：`occupiedRanges` 按真实分钟区间算，
      //    存量的 23:30 跨午夜旧课（占次日 00:00–00:30）也会被正确算进来 —— 自己写一遍必漏。
      const busy = memberView.busyOf({ bookings: db.bookings.concat(pending), dateKey })
      const raw = memberView.slotsFor({
        dateKey, todayKey: today, nowMinutes, busy,
        // ⭐ 2026-10-03：起点与会员端统一为 **06:00**（`EARLIEST_START_MINUTES` 是唯一常量，不许写死数字）。
        //    ⛔ 原来这里是写死的 `0`（"补录通道允许凌晨课"）。入口规则统一到 06:00 之后，
        //       凌晨时段不再出现在新建弹层里；**存量**的 00:00–05:59 历史课照旧在课表凌晨段展示。
        dayStart: occupancy.EARLIEST_START_MINUTES,
        latestStart: occupancy.LATEST_START_MINUTES,
        step: occupancy.SLOT_STEP_MINUTES,
        length: occupancy.DEFAULT_PLANNED_MINUTES
      })
      // ⛔ 不再自己拼 stateText —— `slotsFor` 已经给出唯一文案来源，本地再拼一遍就是第二套口径。
      const slots = raw
      const cur = this.data.hour * 60 + this.data.minute
      // 打开时自动定位到**当前已选时段**那一格 ⇒ 教练不用从 00:00 往下滚
      const near = slots.some(s => s.start === cur) ? cur : (slots.length ? slots[0].start : 0)
      this.setData({ slots, slotAnchor: 'slot-' + near })
    },
    // 点一格 = 设定开始时间。三态的**点法不一样**，这是本轮唯一刻意的教练端差异：
    //   · 已排课  ⇒ 不可点（那段时间有课，点了下一步必然被同一把尺拒掉，白点一次）
    //   · 已过时间 ⇒ **可以点**：教练的补录通道允许把真实上过的课录进来
    //                （tests/past-lesson-backfill.test.js ⑤ 明文钉死"补录不受最早开课限制"，
    //                  真实上过的课可能就在凌晨或非整点）⇒ 这里不许跟着会员端一起禁掉。
    pickSlot(e) {
      const start = Number(e.currentTarget.dataset.start)
      const slot = (this.data.slots || []).find(s => s.start === start)
      if (!slot) return
      if (slot.reason === 'booked') return wx.showToast({ title: '这个时段已经排了课', icon: 'none' })
      // 选中后立即回到确认态：顶部时间摘要会同步刷新，确认约课按钮也重新露出。
      // 过去这里只改 hour/minute，整块时间网格仍展开，按钮被推到屏幕下方，
      // 用户会误以为点击没有生效。
      this.setData({ hour: Math.floor(start / 60), minute: start % 60, timeEdit: false, preciseOpen: false })
    },
    togglePrecise() { this.setData({ preciseOpen: !this.data.preciseOpen }) },
    search(e) { const q=e.detail.value.trim().toLowerCase(),letter=/^[a-z]+$/.test(q); this.setData({ q, students: this.data.allStudents.filter(s => {const name=s.name.toLowerCase(),abbr=(s.abbr||'').toLowerCase(),phone=s.phone||'';return !q||(letter?abbr.startsWith(q):name.includes(q)||phone.includes(q))}) }) },
    chooseStudent(e) { const student = this.data.allStudents.find(s => s.id === e.currentTarget.dataset.id),packages=(student.packages||[]).map((p,sourceIndex)=>({p,sourceIndex})).filter(x=>x.p.status!=='reversed').map(({p,sourceIndex})=>{const t=TYPES.find(t=>t.name===p.type)||TYPES[0];return {...p,sourceIndex,left:student.authorized?Number(p.availableToBook||0):Number(p.remaining||0),color:t.color,light:t.light,gift:!!t.gift,emoji:t.emoji}}).sort((a,b)=>(a.gift?1:0)-(b.gift?1:0)||a.sourceIndex-b.sourceIndex); this.setData({ student, packages, step: 2,timeEdit:false }) },
    choosePackage(e) {
      const dataset = e && e.currentTarget && e.currentTarget.dataset || {}
      const disabled = dataset.disabled === true || dataset.disabled === 'true' || dataset.disabled === 1 || dataset.disabled === '1'
      if (disabled) return wx.showToast({ title: '这份课程目前没有可约课时', icon: 'none' })
      const packageIndex = Number(dataset.index)
      if (!Number.isInteger(packageIndex) || !this.data.packages[packageIndex]) return
      // 从课表点进来时，日期和时间已经确定。选课程只负责确定要消耗哪一份课包，
      // 不再把时间表重复展开；只有教练主动点「预约时间（点击修改）」才进入时间编辑。
      // 同一会员有常规课、拉伸课等多份课包时，每一张卡仍走完全相同的选择流程。
      this.setData({ packageIndex, timeEdit: false, preciseOpen: false })
    },
    // 改日期 ⇒ 三态必须重算（"已过时间"和"已排课"都是按这一天的数据算出来的，不是写死的）
    onDate(e) { this.setData({ date: e.detail.value }, () => this.buildSlots()) },
    onHour(e) { this.setData({ hour: this.data.hours[e.detail.value] }) }, onMinute(e) { this.setData({ minute: this.data.minutes[e.detail.value] }) },
    onTime(e){const [hour,minute]=e.detail.value.split(':').map(Number);this.setData({hour,minute,timeEdit:false,preciseOpen:false})},
    pickHour(e){this.setData({hour:+e.currentTarget.dataset.value})},pickMinute(e){this.setData({minute:+e.currentTarget.dataset.value})},
    // 展开时间编辑时重算三态（"已过时间"随时间走，隔一会儿回来点开必须是最新的）
    toggleTime(){const open=!this.data.timeEdit;this.setData({timeEdit:open},()=>{if(open)this.buildSlots()})},
    back() { this.setData({ step: 1, packageIndex: -1 }) }, close() { this.triggerEvent('close') },
    async confirm() {
      // 连点保护：第一次点击已经把这条预约派发进本机队列，之后的点击一律忽略。
      // 这一层是「同一个动作只办一次」的第一道保险（第二道是本机业务事务里的
      // BOOKING_TIME_CONFLICT —— 它与云端跑的是同一份 handlers）。
      if (this.submitting) return
      const i = this.data.packageIndex; if (i < 0) return wx.showToast({ title: '请选择课程类型', icon: 'none' })
      // 这次点击同时为教练本人申请下一条提醒；不等待结果，不让通知阻断排课。
      notifyConsent.requestNextAfterAction('coach', { quiet: true })
      const db = getDB()
      const selectedStudent = this.data.student
      if (selectedStudent && selectedStudent.authorized) {
        const selectedPackage = this.data.packages[i] || {}
        const studentId = String(selectedStudent.studentId || '')
        const packageId = String(selectedPackage.packageId || selectedPackage.id || '')
        if (!studentId || !packageId) return wx.showToast({ title: '会员资料还没读完整，请到学员页下拉刷新。', icon: 'none' })
        const gate = occupancy.lessonWindowGateOf({ hour: this.data.hour, minute: this.data.minute }, occupancy.DEFAULT_PLANNED_MINUTES)
        if (gate) return wx.showModal({ title: '这个时间排不了', content: gate.message, showCancel: false })
        const start = Number(this.data.hour) * 60 + Number(this.data.minute || 0)
        const overlaps = booking => booking.date === this.data.date && start < (Number(booking.hour) * 60 + Number(booking.minute || 0) + Number(occupancy.DEFAULT_PLANNED_MINUTES || 60)) && (start + Number(occupancy.DEFAULT_PLANNED_MINUTES || 60)) > Number(booking.hour) * 60 + Number(booking.minute || 0)
        const occupied = db.bookings.find(overlaps) || (mutate.isCloudWritePath() && pendingBookingRecords().find(overlaps))
        if (occupied) return wx.showModal({ title: '该时段已有课程', content: `${occupied.date} ${pad(occupied.hour)}:${pad(occupied.minute || 0)} 已有课程，请选择其他时间。`, showCancel: false })
        this.submitting = true
        try {
          const close = () => { this.triggerEvent('saved'); this.triggerEvent('close') }
          return await mutate(null, null, {
            key: `createAuthorizedBooking:${studentId}:${packageId}:${this.data.date}:${this.data.hour}:${this.data.minute || 0}`,
            command: 'createAuthorizedBooking',
            payload: { studentId, packageId, date: this.data.date, hour: Number(this.data.hour), minute: Number(this.data.minute || 0), plannedMinutes: Number(occupancy.DEFAULT_PLANNED_MINUTES || 60) },
            successTitle: `已约 ${pad(this.data.hour)}:${pad(this.data.minute)}`,
            onSuccess: close, onRefresh: close
          })
        } finally { this.submitting = false }
      }
      // ★ 身份必须先过一遍「本机临时 id → 云端正式 id」转正，再拿去校验。
      //   刚新增的学员此刻只有 loc_student_… 身份；等他真的在云端转正后，投影里换成了正式 id，
      //   而本组件 this.data.student 里抄下来的那一份**不会自己改** —— 直接拿去查就会报
      //   「学员已不存在」。这就是「新学员尚未完全同步时马上预约」的真机形状。
      //   课时包同理：它和学员是同一批（同一个本机批次）落地的。
      const studentId = mutate.resolveLocalId(this.data.student.id)
      const packageId = mutate.resolveLocalId(this.data.packages[i].id)
      const checked = validateBookingCreation(db, studentId, packageId)
      if (!checked.ok) return wx.showToast({ title: checked.message, icon: 'none' })
      const p = checked.pkg, sourceIndex = (checked.student.packages || []).findIndex(item => item.id === p.id)
      // ⭐ 出网前的最后一道时间闸：新课**开始 ≤ 23:00 且结束 ≤ 当天 24:00**（与云端同一把尺）。
      //    本机引擎也会拦一次，但那已经进了队列；这里先拦 ⇒ 用户当场看到原因，不用等一轮同步。
      //    ⚠️ 用 showModal 不用 showToast：toast 会截断长句，剩下半句等于没说（静默 = 事故放大器）。
      const gate = occupancy.lessonWindowGateOf({ hour: this.data.hour, minute: this.data.minute }, 60)
      if (gate) return wx.showModal({ title: '这个时间排不了', content: gate.message, showCancel: false })
      const start = this.data.hour * 60 + this.data.minute, duration = 60
      const overlaps = b => b.date === this.data.date && start < (b.hour * 60 + (b.minute || 0) + duration) && (start + duration) > b.hour * 60 + (b.minute || 0)
      const occupied = db.bookings.find(overlaps) || (mutate.isCloudWritePath() && pendingBookingRecords().find(overlaps))
      if (occupied) {
        const ui = require('../../utils/ui-cloud-command')
        const rows = typeof ui.pendingCancellationRecords === 'function' ? ui.pendingCancellationRecords() : []
        const cancelling = rows.filter(row => row.officialId === occupied.id || row.payload && overlaps(row.payload))
        if (typeof ui.refreshActiveView === 'function') ui.refreshActiveView()
        this.triggerEvent('saved')
        if (cancelling.length) return wx.showModal({ title: '该时段的取消尚未确认', content: '这条预约仍可能占用该时段。现在核对取消结果吗？', confirmText: '核对取消', cancelText: '稍后', success: async r => { if (!r.confirm) return; for (const row of cancelling) await mutate.retryPendingCancellation(row.localKey); this.triggerEvent('saved') } })
        return wx.showModal({ title: '该时段已有课程', content: `${occupied.date} ${pad(occupied.hour)}:${pad(occupied.minute || 0)} 已有课程，正在更新课表。请查看后选择其他时间。`, showCancel: false })
      }
      // 统一写入口：云端时 createBooking 属于**本机先行**命令 ——
      // 本机业务事务立刻建出这条预约（课表当帧就能看到），持久排进 Outbox，
      // 由同步引擎在后台按序送云端；云端慢 / 断网 / 响应丢失都只影响后台，不再打扰用户。
      // ⚠️ 载荷必须是契约允许的**恰好五个字段**：真实云函数用 requireOnly 做硬门禁，
      //    多带一个字段就是 INVALID_PAYLOAD（本机先行会把云端必拒的载荷当成功排进队列）。
      //    学员名 / 课程类型 / 单价 / packageIndex 全部由 handlers 从课时包自己算，不需要也不许传。
      this.submitting = true
      try {
        const result = await mutate('createBooking', {
          studentId,
          packageId,
          date: this.data.date,
          hour: Number(this.data.hour),
          minute: Number(this.data.minute || 0)
        }, {
          key: `createBooking:${studentId}:${packageId}:${this.data.date}:${this.data.hour}:${this.data.minute || 0}`,
          successTitle: `已约 ${pad(this.data.hour)}:${pad(this.data.minute)}`,
          local: () => {
            db.bookings.push({ id: uid(), studentId, studentName: this.data.student.name, packageId, packageIndex: sourceIndex, date: this.data.date, hour: this.data.hour, minute: this.data.minute, typeName: p.type, price: p.type === '赠送课程' ? 80 : +p.price, status: 'booked', createdAt: Date.now() })
            saveDB(db); wx.showToast({ title: `已约 ${pad(this.data.hour)}:${pad(this.data.minute)}` })
          }
        })
        if (result && result.local) { this.triggerEvent('saved'); this.triggerEvent('close'); return result }
        if (!result || !result.ok) return result
        this.triggerEvent('saved'); this.triggerEvent('close'); return result
      } finally { this.submitting = false }
    }
  }
})
