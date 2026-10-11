// ═════════════════════════════════════════════════════════════════════════════
// 2026-10-05 · 归档功能**整体撤回**之后的「完课保留」专项回归
//
// 【真实需求】
//   · 会员上完课后**不得**自动从学员名单或会员档案中消失；
//   · 会员继续正常存放在原名单中；
//   · 课程、课包、训练记录、收入、认领关系等历史数据**全部保留**；
//   · 教练不需要归档 / 恢复 / 结束服务操作。
//
// ⛔ 本文件**只读**正式源码（fs.readFileSync + require），⛔ 绝不写任何源码文件；
//    业务行为跑在 `helpers/sandbox-command-world` 的隔离世界（内存云 + 真 handler）里。
// ═════════════════════════════════════════════════════════════════════════════
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createWorld } = require('./helpers/sandbox-command-world')

const PROJ = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(PROJ, rel), 'utf8')

function listJs(dir) {
  const base = path.join(PROJ, dir)
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base).filter(name => name.endsWith('.js')).map(name => `${dir}/${name}`)
}

async function run() {
  // ── ① 完课行为：学员 / 课包 / 训练记录 / 收入 全部保留（真 handler、真隔离云） ──
  const world = createWorld(), { ui, mutate, runtime } = world
  // 前置：先做一次完整读取（页面 render 会读本机账本，没读过会直接抛"还没读到云端数据"）。
  assert.equal((await ui.adapter.readActive()).ok, true, '前置：完整读取必须成功')
  const page = world.page('students')
  page.onShow(); page.add()
  page.data.form.name = '完课保留测试学员'
  Object.assign(page.data.form.packages[0], { total: '20', remaining: '17', price: '300', saleAmount: '5800' })
  await page.save()
  await world.idle()

  const studentRows = world.rows('students')
  assert.equal(studentRows.length, 1, '前置：世界里应有一名学员')
  const studentId = studentRows[0].studentId, packageId = world.rows('packages')[0].packageId

  const booking = await mutate.submitBooking({ studentId, packageId, date: '2026-10-01', hour: 10, minute: 0 })
  assert.equal(booking.ok, true, '前置：约课必须成功')
  await world.idle()
  assert.equal((await ui.adapter.readActive()).ok, true, '前置：完整读取必须成功')
  const first = runtime.getDB().bookings[0]
  assert.ok(first && first.id, '完整读取之后本机必须能看到刚约的那节课')

  const before = {
    students: world.rows('students').length,
    packages: world.rows('packages').length,
    bookings: world.rows('bookings').length
  }
  // 常规课程完课前必须先保存训练动作（既有业务规则，与本轮撤回无关）
  const content = { bookingId: first.id, items: [{ name: '完课深蹲', sets: 3, reps: 10, weight: 20 }], notes: '保留历史', category: '常规训练', duration: 60, summary: '完课保留测试' }
  const contentResult = await mutate(null, null, { command: 'updateBookingContent', payload: content })
  assert.equal(contentResult.ok, true, JSON.stringify(contentResult))
  await world.idle()
  const done = await mutate(null, null, { command: 'completeBooking', payload: { bookingId: first.id } })
  assert.equal(done.ok, true, '完课命令必须成功（这一步才是本测试要盯的动作）' + JSON.stringify(done))
  await world.idle()

  // ①a 学员**仍在**教练学员名单里（⛔ 这是"人丢了"那条真机故障的反面）
  assert.equal(world.rows('students').filter(row => row.studentId === studentId).length, 1,
    '⛔ 完课之后学员必须**仍然**在学员名单里，一个都不许少')
  assert.equal(world.rows('students').length, before.students, '完课不得改变学员条数')

  // ①b 课时包仍在（且仍在**这位学员**名下）
  const keptPackage = world.rows('packages').filter(row => row.packageId === packageId)[0]
  assert.ok(keptPackage, '⛔ 完课之后课时包必须还在')
  assert.equal(keptPackage.studentId, studentId, '课时包必须仍挂在这位学员名下')

  // ①c 训练记录仍在（完课是把这条预约标成 done，**不是**删掉它）
  assert.ok(world.rows('bookings').length >= before.bookings, '⛔ 完课之后这条训练记录必须还在')
  const doneRow = world.rows('bookings').filter(row => row.bookingId === first.id)[0]
  assert.ok(doneRow, '完课的那条预约必须还在账上')
  assert.equal(String((doneRow.data || {}).status || ''), 'done', '这条预约应被标记成已完课')

  // ①d 收入仍在（完课计一次收入，历史收入一条都不许少）
  const incomes = runtime.getDB().incomes || []
  assert.ok(incomes.length >= 1, '⛔ 完课必须计入收入，且历史收入一条都不许被删')

  // ── ② 完课**不触发**隐藏 / 归档 / 解除认领 / 删除（四条一条都不许发生） ──────────
  ;['deleteStudent', 'archiveStudent', 'restoreStudent', 'listArchivedStudents', 'releaseStudentClaim'].forEach(command => {
    assert.equal(world.executeCalls(command).length, 0, `⛔ 完课绝不允许顺带发出 ${command}`)
  })

  // ── ③ 归档能力在源码里已**彻底不存在**（静态全库扫描） ──────────────────────────
  const files = [
    ...listJs('pages/students'), ...listJs('utils'),
    ...listJs('cloudfunctions/memberIdentityCommand'),
    ...listJs('cloudfunctions/memberIdentitySandboxCommand'),
    ...listJs('cloudfunctions/coachBusinessCommand'),
    ...listJs('cloudfunctions/coachBusinessSandboxCommand'),
    ...listJs('cloudfunctions/readMyMemberData')
  ]
  const tokens = ['archiveStudent', 'restoreStudent', 'listArchivedStudents', 'student_archives', 'ARCHIVE_STATUS', 'COACH_STUDENT_ARCHIVED', 'openArchivedList', 'archivedIds']
  files.forEach(file => {
    const source = read(file)
    tokens.forEach(token => {
      assert.ok(source.indexOf(token) < 0, `⛔ ${file} 里仍残留归档标识符 ${token}`)
    })
  })

  // ── ④ 会员端档案行**不再带**归档状态 ⇒ 会员端照常看到这份档案 ────────────────
  const { sanitizeArchive } = require(path.join(PROJ, 'cloudfunctions/readMyMemberData/service'))
  const archiveRow = sanitizeArchive('claim-1', { displayName: '教练' }, { name: '学员' }, 5, 2)
  assert.deepEqual(Object.keys(archiveRow).sort(), ['archiveId', 'coach', 'name', 'packageCount', 'remaining'],
    '档案行不得再出现 archived / archivedAt')

  // ── ⑤ 会员端档案只按「认领是否还在」过滤 ⇒ 完课根本碰不到 claim ────────────────
  // ⛔ 教练业务域（含完课）根本不碰认领集合 ⇒ claim 不可能被完课删除
  ;['handlers.js', 'core.js', 'memberBooking.js'].forEach(file => {
    const source = read(`cloudfunctions/coachBusinessCommand/${file}`)
    assert.ok(source.indexOf('student_claims') < 0,
      `⛔ ${file} 不得触碰认领集合 ⇒ 完课不可能删除或解除任何 claim`)
  })
  // authorization.js 会**只读**认领表（授权目录需要它），但⛔ 绝不允许改写认领状态
  const authSource = read('cloudfunctions/coachBusinessCommand/authorization.js')
  assert.ok(authSource.indexOf('CLAIM_STATUS') < 0 && authSource.indexOf("'released'") < 0,
    '授权模块只能读认领表，绝不允许把认领改成 released（= 解除认领）')

  // ── ⑥ 学员列表页不再有任何"隐藏已归档学员"的过滤 ──────────────────────────────
  const studentsJs = read('pages/students/students.js')
  assert.ok(/db\.students\.filter\(currentStudent\)\.map/.test(studentsJs),
    '学员名单必须是"全员直出"，不得再挂任何 archived 过滤')
  assert.ok(!/app\.json 注册|student-archives/.test(read('app.json')), 'app.json 不得再注册已归档学员页')

  console.log('PASS completed-class-keeps-student：完课后学员 / 课包 / 训练记录 / 收入 / claim 全部保留')
}

run().then(() => console.log('COMPLETED CLASS KEEPS STUDENT: ALL PASS'))
  .catch(error => { console.error('FAILED:', error && error.message); console.error(error && error.stack); process.exitCode = 1 })
