// M2 占用规则的**契约测试**（2026-09-26）。
//
// 为什么必须有它：云函数目录不能 require 本项目 utils（云端只上传各自目录），
// 所以同一套占用规则存在两份（cloudfunctions/…/occupancy.js 与 utils/package-occupancy.js）。
// 两份只要有一处漂移，就会出现"本机觉得能约、云端拒绝"（或反过来）的历史事故形态。
//
// 防的事故：
//  ① 两份口径漂移；② 以后有人只改 createBooking 忘了 cancelBooking/completeBooking（占座泄漏）；
//  ③ 派生值被改名成 bookable / 落库；④ 新命令忘了登记（白名单不一致 ⇒ 端上直接被判未知命令）；
//  ⑤ 重新引入"课时属于某个教练"的命名（authority）⇒ 把物理存储位置误当所有权。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const cloud = require('../cloudfunctions/coachBusinessCommand/occupancy')
const local = require('../utils/package-occupancy')
const { COMMANDS } = require('../utils/cloud-command-contract')
const mutate = require('../utils/mutate')
const policy = require('../utils/business-verification-policy')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const cloudSrc = read('cloudfunctions/coachBusinessCommand/occupancy.js')
const localSrc = read('utils/package-occupancy.js')
const handlersSrc = read('cloudfunctions/coachBusinessCommand/handlers.js')
const engineSrc = read('utils/cloud-command-engine.js')

async function test(name, fn) {
  try { await fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}

;(async () => {
  await test('云端与本机的常量逐条一致', async () => {
    assert.equal(cloud.DEFAULT_PLANNED_MINUTES, local.DEFAULT_PLANNED_MINUTES)
    assert.equal(cloud.PENDING_GRACE_MINUTES, local.PENDING_GRACE_MINUTES)
    assert.equal(cloud.RESERVED_VERSION, local.RESERVED_VERSION)
    assert.equal(cloud.OUTSTANDING_STATUS, local.OUTSTANDING_STATUS)
    assert.equal(cloud.DEFAULT_PLANNED_MINUTES, 60, '默认课程时长 = 60 分钟')
    assert.equal(cloud.PENDING_GRACE_MINUTES, 180, '待确认宽限 = 3 小时')
  })

  await test('availableToBook 唯一公式：max(remaining − reserved, 0)，两份实现逐样本一致', async () => {
    const samples = [
      { remaining: 5, reserved: 0 }, { remaining: 5, reserved: 2 }, { remaining: 5, reserved: 5 },
      { remaining: 5, reserved: 9 }, { remaining: 0, reserved: 0 }, { remaining: 0, reserved: 3 },
      { remaining: 12, reserved: 2 }, { remaining: 1, reserved: 1 }
    ]
    samples.forEach(pkg => {
      assert.equal(cloud.availableToBook(pkg), Math.max(pkg.remaining - pkg.reserved, 0))
      assert.equal(local.availableToBook(pkg), cloud.availableToBook(pkg))
      assert.deepEqual(local.occupancyOf(pkg), cloud.occupancyOf(pkg))
      assert.ok(cloud.availableToBook(pkg) >= 0, '绝不允许负数')
    })
    // 缺失 reserved ⇒ 0（历史数据零迁移的前提）
    assert.equal(cloud.availableToBook({ remaining: 5 }), 5)
  })

  await test('两份源码都只用一个 max 公式，没有第二套算法', async () => {
    ;[cloudSrc, localSrc].forEach(src => {
      assert.ok(/Math\.max\(remaining - reserved, 0\)/.test(src), '唯一公式必须是 max(remaining - reserved, 0)')
      assert.ok(!/availableToBook\s*=\s*[^;\n]*remaining\s*-\s*used/.test(src), '不允许用 total/used 推导')
    })
  })

  await test('派生值叫 availableToBook，不得出现 bookable 别名、也不得落库', async () => {
    ;[cloudSrc, localSrc, handlersSrc, engineSrc].forEach(src => {
      assert.ok(!/\bbookable\b/i.test(src), '命名必须统一为 availableToBook')
    })
    assert.ok(!/pkg\.availableToBook\s*=/.test(handlersSrc), 'availableToBook 绝不能写回 package')
    assert.ok(!/pkg\.availableToBook\s*=/.test(engineSrc))
  })

  await test('三条预约命令**全部**维护 reserved（只改一处就会泄漏占座）', async () => {
    // ⚠️ 第二个参数从第二批起可能是 `space`：共享预约的课时包在**别人的账**里，
    //    占座必须加减在那一本账上 —— 口径变了，但"三处 −1 一处都不能少"这条判据没变。
    const count = (src, delta) => (src.match(new RegExp(`applyDelta\\((?:business|state|space), pkg, ${delta}\\)`, 'g')) || []).length
    assert.ok(/await occupancy\.applyDelta\(business, pkg, 1\)/.test(handlersSrc), '云端 createBooking 必须 +1')
    assert.ok(count(handlersSrc, '-1') >= 3, '云端 cancel / complete / markBookingNotHeld 三处 −1')
    assert.ok(/occupancy\.applyDelta\(state, pkg, 1\)/.test(engineSrc), '本机 createBooking 必须 +1')
    assert.ok(count(engineSrc, '-1') >= 3, '本机 cancel / complete / markBookingNotHeld 三处 −1')
  })

  await test('预约门禁判的是 availableToBook，不是 remaining（云端与本机同口径）', async () => {
    assert.ok(/occupancy\.availableToBook\(pkg, reserved\) <= 0/.test(handlersSrc))
    assert.ok(/occupancy\.availableToBook\(pkg, reserved\) <= 0/.test(engineSrc))
    // 两种 0 必须分成两个错误码
    assert.ok(/'PACKAGE_NO_REMAINING'/.test(handlersSrc) && /'PACKAGE_NO_AVAILABLE'/.test(handlersSrc))
    assert.ok(/'PACKAGE_NO_REMAINING'/.test(engineSrc) && /'PACKAGE_NO_AVAILABLE'/.test(engineSrc))
  })

  await test('plannedMinutes 缺失返回 null（老预约不参与待确认），绝不补默认值', async () => {
    assert.equal(cloud.plannedMinutesOf({}), null)
    assert.equal(local.plannedMinutesOf({}), null)
    assert.equal(cloud.plannedMinutesOf({ plannedMinutes: 60 }), 60)
    assert.equal(cloud.plannedMinutesOf({ plannedMinutes: 0 }), null)
    assert.equal(cloud.plannedMinutesOf({ plannedMinutes: 90 }), 90)
  })

  await test('新命令 markBookingNotHeld 已在三处登记：白名单 / mutate / 核验策略', async () => {
    assert.ok(COMMANDS.includes('markBookingNotHeld'))
    assert.ok(mutate.COMMANDS.includes('markBookingNotHeld'))
    assert.deepEqual(mutate.COMMANDS.slice().sort(), COMMANDS.slice().sort(), '两份命令清单必须逐条一致')
    const requirement = policy.requirementOf('markBookingNotHeld')
    assert.equal(requirement.known, true, '策略必须认识这条命令')
    assert.equal(requirement.level, policy.LEVELS.REQUIRED)
  })

  await test('会员预约窗口（未来 30 天）：云端与本机孪生**逐样本一致**', async () => {
    assert.equal(cloud.MEMBER_BOOKING_MAX_DAYS, local.MEMBER_BOOKING_MAX_DAYS)
    assert.equal(cloud.MEMBER_BOOKING_MAX_DAYS, 30, '规则 4：最多预约未来 30 天')
    assert.equal(cloud.MEMBER_BOOKING_WINDOW_MESSAGE, local.MEMBER_BOOKING_WINDOW_MESSAGE)
    const today = '2026-09-30'
    const samples = [
      ['2026-09-29', 'past'], ['2026-09-30', 'ok'], ['2026-10-30', 'ok'],
      ['2026-10-31', 'beyond'], ['2026-12-01', 'beyond'], ['2026-13-01', 'invalid'], ['', 'invalid']
    ]
    samples.forEach(([dateKey, expected]) => {
      assert.equal(cloud.memberBookingDateAllowed(dateKey, today), expected, `${dateKey} 相对 ${today} 应为 ${expected}`)
      assert.equal(local.memberBookingDateAllowed(dateKey, today), cloud.memberBookingDateAllowed(dateKey, today))
    })
    // 跨月 / 跨年 / 闰年都走日历语义（+30 天由 addDateDays 算，不许用心算的毫秒加法）
    assert.equal(cloud.addDateDays('2026-09-30', 30), '2026-10-30')
    assert.equal(local.addDateDays('2026-09-30', 30), '2026-10-30')
    assert.equal(cloud.addDateDays('2026-12-31', 1), '2027-01-01')
    assert.equal(local.addDateDays('2028-02-28', 1), '2028-02-29', '闰年 2 月 29 日')
    assert.deepEqual(cloud.memberBookingWindowOf('2026-09-30'), { from: '2026-09-30', to: '2026-10-30', maxDays: 30 })
    assert.deepEqual(local.memberBookingWindowOf('2026-09-30'), cloud.memberBookingWindowOf('2026-09-30'))
  })

  await test('30 这个数字**只在 occupancy 里定义一次**（页面 / 视图 / 请求构造器都不许写死）', async () => {
    ;[cloudSrc, localSrc].forEach(src => assert.ok(/const MEMBER_BOOKING_MAX_DAYS = 30/.test(src)))
    const viewSrc = read('utils/member-booking-view.js')
    const pageSrc = read('pages/member-book-slots/member-book-slots.js')
    const requestSrc = read('utils/member-booking-request.js')
    assert.ok(/MEMBER_BOOKING_MAX_DAYS = occupancy\.MEMBER_BOOKING_MAX_DAYS/.test(viewSrc), '会员视图的 30 必须取自 occupancy')
    assert.ok(!/MEMBER_BOOKING_MAX_DAYS\s*=\s*\d/.test(viewSrc), '会员视图不许再写死一个数字')
    assert.ok(/view\.MEMBER_DATE_COUNT/.test(pageSrc), '约课页的可选天数必须取自视图常量')
    assert.ok(!/dateOptions\([^)]*,\s*\d+\s*\)/.test(pageSrc), '约课页不许写死天数')
    // ⚠️ 静态断言**先剥注释**：注释里会写"超过 30 天"来解释规则，那不是第二处定义。
    const requestCode = requestSrc.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
    assert.ok(!/未来 30 天|30 天内/.test(requestCode), '请求构造器里的文案也要用常量拼，不许写死 30')
    const viewModule = require('../utils/member-booking-view')
    assert.equal(viewModule.MEMBER_BOOKING_MAX_DAYS, 30)
    assert.equal(viewModule.MEMBER_DATE_COUNT, 31, '今天 + 30 天 ⇒ 31 个日期选项')
  })

  await test('命名纪律：不得重新引入把"物理存储位置"当所有权的 authority', async () => {
    ;[cloudSrc, localSrc, handlersSrc, engineSrc].forEach(src => {
      assert.ok(!/\bauthority\b/i.test(src), 'M2 用 packageUsage 表达"本次消耗哪一行课时"，不用 authority')
    })
  })

  if (!process.exitCode) process.stdout.write('ALL M2 OCCUPANCY CONTRACT TESTS PASSED\n')
})()
