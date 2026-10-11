// 手机系统日历是用户主动保存的一份提醒副本，不是课程数据源。
// 取消或改期仍以小程序为准；这里绝不自动修改用户系统日历。
function timestampOf(date, time) {
  const key = String(date || '')
  const value = String(time || '').slice(0, 5)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !/^\d{2}:\d{2}$/.test(value)) return 0
  const milliseconds = Date.parse(`${key}T${value}:00+08:00`)
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : 0
}

function addCourse(course) {
  const row = course || {}
  const startTime = timestampOf(row.date, row.startText)
  const endTime = timestampOf(row.date, row.endText)
  if (!startTime) {
    wx.showToast && wx.showToast({ title: '课程时间不完整，暂时不能加入日历', icon: 'none' })
    return Promise.resolve({ ok: false, code: 'COURSE_TIME_INVALID' })
  }
  if (!wx.addPhoneCalendar) {
    wx.showModal && wx.showModal({ title: '当前微信暂不支持', content: '请更新微信后再试，课程仍会保留在小程序“我的预约”里。', showCancel: false })
    return Promise.resolve({ ok: false, code: 'CALENDAR_API_MISSING' })
  }
  return new Promise(resolve => wx.addPhoneCalendar({
    title: `${String(row.typeText || '训练课程')} · ${String(row.coachName || '教练')}`,
    startTime,
    endTime: endTime > startTime ? endTime : startTime + 60 * 60,
    description: '课程变动请以训练伙伴小程序里的预约状态为准。',
    alarm: true,
    alarmOffset: 60 * 60,
    success() {
      wx.showToast && wx.showToast({ title: '已加入手机日历', icon: 'success' })
      resolve({ ok: true })
    },
    fail(error) {
      const cancelled = /cancel/i.test(String(error && error.errMsg || ''))
      if (!cancelled) wx.showToast && wx.showToast({ title: '没有加入日历，请检查日历权限', icon: 'none' })
      resolve({ ok: false, code: cancelled ? 'USER_CANCELLED' : 'CALENDAR_ADD_FAILED' })
    }
  }))
}

module.exports = { timestampOf, addCourse }
