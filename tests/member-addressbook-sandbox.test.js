// ⭐ 新会员方案（唯一会员 + 双向联系人）测试区闭环测试（2026-10-07 重写）
//
// 旧版这套测试锁的是「会员认领 / 8 位认领码 / 15 分钟邀请 / 训练档案」那套，
// 已被新方案整体取代。这里改测新四句话：
//   ① 唯一会员：手机号固定 memberId，换手机 / 清缓存都回到同一份资料；
//   ② 主管教练：第一位建立联系的教练 = ownerCoachId，只有他能改核心资料；
//   ③ 双向联系人：memberId + coachId 唯一一行，会员加教练 / 教练加会员落到同一行；
//   ④ 添加不发微信，只预约 / 取消 / 改期 / 完课才通知被动方。
const assert = require('assert'), fs = require('fs'), path = require('path')
const ROOT = path.join(__dirname, '..'), read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const WORLD = require('./helpers/m2-business-world')
const md = require('../cloudfunctions/coachBusinessSandboxCommand/member-directory')
const core = require('../cloudfunctions/coachBusinessCommand/core')
let pass = 0, fail = 0
async function check(n, f) { try { await f(); pass++; console.log('PASS ' + n) } catch (e) { fail++; console.log('FAIL ' + n + '\n' + e.stack) } }

function world() {
  const w = WORLD.createWorld()
  const A = w.seedCoach('openA', 'dsA', 'AAA1')
  const B = w.seedCoach('openB', 'dsB', 'BBB2')
  let clock = 1900000000000
  const call = (open, action, payload = {}) => md.createDirectory({ db: w.db, getOpenId: () => open, environment: 'sandbox', now: () => ++clock })({ action, environment: 'sandbox', requestId: `rid-${clock}`, payload })
  return { w, A, B, call }
}

// 教练 A 按手机号新建会员（新方案唯一入口）：返回 { created, memberId, member:{publicCode} }
async function createMember(x, owner, phone = '13800138000', name = '张三') {
  const r = await x.call(owner.open, 'createMemberByCoach', { phone, displayName: name })
  assert.equal(r.ok, true, JSON.stringify(r))
  return r
}

// 给某会员挂一份课时包（复用旧测试手法：直接落到 member 的 studentId 下）。
function seedPackage(x, owner, member, packageId = 'pkg-zhang-20', total = 20) {
  x.w.put('packages', x.w.businessId('packages', owner.owner, owner.datasetId, packageId), {
    ownerCoachId: owner.owner, datasetId: owner.datasetId, studentId: member.studentId || member.memberId, packageId,
    data: { id: packageId, studentId: member.studentId || member.memberId, type: '常规训练', total, remaining: total, used: 0, reserved: 0, status: 'active', price: 300 }
  })
}

// 通过一次教练动作确保教练有 directory 行（真实 App 里教练打开自己的联系页就会建）。
async function ensureCoachDirectory(x, coach) { await x.call(coach.open, 'listContacts') }

async function main() {
  await check('教练按手机号新建会员：唯一键固定 memberId，创建者即主管教练', async () => {
    const x = world()
    const r = await createMember(x, x.A, '13800138000', '张三')
    assert.equal(r.created, true)
    assert.ok(r.memberId)
    // ⭐ 手机号恒定一个 memberId：再算一次必须一致
    assert.equal(r.memberId, md.memberIdByPhone('13800138000'))
    // 自动建立一条联系人关系（A 是会员第一位教练）
    assert.equal(x.w.stores.member_sandbox_contacts.size, 1)
    // 学员记录只建一份
    assert.equal(x.w.stores.students.size, 1)
    // 这条联系人关系里 coachId = A
    const contact = [...x.w.stores.member_sandbox_contacts.values()][0]
    assert.equal(contact.coachId, x.A.owner)
  })

  await check('同一手机号重复建档只报错不建第二份', async () => {
    const x = world()
    await createMember(x, x.A, '13800138000', '张三')
    const again = await x.call(x.A.open, 'createMemberByCoach', { phone: '13800138000', displayName: '张三二号' })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'PHONE_ALREADY_EXISTS')
    assert.equal(x.w.stores.member_sandbox_members.size, 1)
  })

  await check('会员用手机号登录：按手机号找到唯一会员并绑定本机 openid，建立接收账号索引', async () => {
    const x = world()
    const created = await createMember(x, x.A, '13800138000', '张三')
    const login = await x.call('member-open', 'loginByPhone', { phone: '13800138000' })
    assert.equal(login.ok, true, JSON.stringify(login))
    assert.equal(login.memberId, created.memberId)
    // 接收账号索引写了一份（member_sandbox_accounts）
    assert.equal(x.w.stores.member_sandbox_accounts.size, 1)
    assert.equal([...x.w.stores.member_sandbox_accounts.values()][0].openId, 'member-open')
    // 会员资料上的 openId 被绑定
    const member = await md.createDirectory({ db: x.w.db, getOpenId: () => 'member-open', environment: 'sandbox', now: () => 1 })({ action: 'dashboard', environment: 'sandbox', requestId: 'rid-dashboard-check', payload: {} })
    assert.equal(member.ok, true, JSON.stringify(member))
    assert.equal(member.member.displayName, '张三')
  })

  await check('会员登录不会漂移身份：同一手机号多次登录恒定一个 memberId', async () => {
    const x = world()
    await createMember(x, x.A, '13800138000', '张三')
    const first = await x.call('member-open', 'loginByPhone', { phone: '13800138000' })
    const second = await x.call('member-other-phone', 'loginByPhone', { phone: '13800138000' })
    assert.equal(first.memberId, second.memberId)
    assert.equal(x.w.stores.member_sandbox_members.size, 1)
  })

  await check('会员登录后首页读到资料与课时包（有课包时）', async () => {
    const x = world()
    const created = await createMember(x, x.A, '13800138000', '张三')
    // 用 createMember 返回的 memberId 拿 studentId
    const memberRow = [...x.w.stores.member_sandbox_members.values()][0]
    seedPackage(x, x.A, memberRow)
    await x.call('member-open', 'loginByPhone', { phone: '13800138000' })
    const home = await x.call('member-open', 'dashboard')
    assert.equal(home.ok, true, JSON.stringify(home))
    assert.equal(home.member.displayName, '张三')
    assert.equal(home.summary.remaining, 20)
    assert.equal(home.summary.packageCount, 1)
  })

  await check('会员用教练二维码票据添加教练（双向联系人落到同一行）', async () => {
    const x = world()
    await createMember(x, x.A, '13800138000', '张三')
    await x.call('member-open', 'loginByPhone', { phone: '13800138000' })
    // 教练 B 发票据 → 会员解析（真实扫码流程会建 B 的 directory 行）
    const issued = await x.call(x.B.open, 'issueTicket')
    assert.equal(issued.ok, true)
    const resolved = await x.call('member-open', 'resolveTicket', { ticket: issued.ticket })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.card.role, 'coach')
    const added = await x.call('member-open', 'addContact', { ticket: issued.ticket })
    assert.equal(added.ok, true, JSON.stringify(added))
    // 联系人关系 +1（A 那条 + 这条）
    assert.equal(x.w.stores.member_sandbox_contacts.size, 2)
    // 会员资料与学员记录都不复制
    assert.equal(x.w.stores.member_sandbox_members.size, 1)
    assert.equal(x.w.stores.students.size, 1)
  })

  await check('教练用会员 M 码添加会员（members.publicCode 兜底查得到）', async () => {
    const x = world()
    const created = await createMember(x, x.A, '13800138000', '张三')
    const mCode = md.publicCodeFor('member', created.memberId)
    const added = await x.call(x.B.open, 'addContact', { code: mCode })
    assert.equal(added.ok, true, JSON.stringify(added))
    assert.equal(x.w.stores.member_sandbox_contacts.size, 2)
    assert.equal(x.w.stores.member_sandbox_members.size, 1)
  })

  await check('findByCode 对会员 M 码走 members 兜底也能查到', async () => {
    const x = world()
    const created = await createMember(x, x.A, '13800138000', '张三')
    const mCode = md.publicCodeFor('member', created.memberId)
    const found = await x.call(x.B.open, 'findByCode', { code: mCode })
    assert.equal(found.ok, true, JSON.stringify(found))
    assert.equal(found.card.role, 'member')
    assert.equal(found.card.displayName, '张三')
  })

  await check('B 排课完课共用原课包且收入归 B', async () => {
    const x = world()
    const created = await createMember(x, x.A, '13800138000', '张三')
    const memberRow = [...x.w.stores.member_sandbox_members.values()][0]
    const pkgId = 'pkg-zhang-20'
    seedPackage(x, x.A, memberRow, pkgId)
    // 教练 B 加会员（M 码）
    const added = await x.call(x.B.open, 'addContact', { code: md.publicCodeFor('member', created.memberId) })
    assert.equal(added.ok, true)
    const booked = await x.w.execute(x.B, 'createAuthorizedBooking', { studentId: memberRow.studentId, packageId: pkgId, date: '2026-10-08', hour: 10, minute: 0 })
    assert.equal(booked.ok, true)
    await x.w.execute(x.B, 'updateBookingContent', { bookingId: booked.result.bookingId, items: [{ name: '深蹲', sets: 3, reps: 12 }] })
    assert.equal((await x.w.execute(x.B, 'completeBooking', { bookingId: booked.result.bookingId })).ok, true)
    assert.equal([...x.w.stores.packages.values()][0].data.remaining, 19)
    assert.equal([...x.w.stores.incomes.values()].some(r => r.ownerCoachId === x.B.owner), true)
  })

  await check('B 有待上课程时不能移出会员，避免留下没人处理的预约', async () => {
    const x = world()
    const created = await createMember(x, x.A, '13800138000', '张三')
    const memberRow = [...x.w.stores.member_sandbox_members.values()][0]
    const pkgId = 'pkg-zhang-20'
    seedPackage(x, x.A, memberRow, pkgId)
    await x.call(x.B.open, 'addContact', { code: md.publicCodeFor('member', created.memberId) })
    const booked = await x.w.execute(x.B, 'createAuthorizedBooking', { studentId: memberRow.studentId, packageId: pkgId, date: '2026-10-08', hour: 10, minute: 0 })
    assert.equal(booked.ok, true)
    const removed = await x.call(x.B.open, 'removeContact', { memberId: created.memberId })
    assert.equal(removed.ok, false)
    assert.equal(removed.code, 'CONTACT_HAS_UNFINISHED_BOOKINGS')
    assert.equal([...x.w.stores.member_sandbox_contacts.values()].filter(r => r.coachId === x.B.owner)[0].status, 'active')
  })

  await check('B 移出会员只断未来关系，完课扣课收入与历史全部保留且可重新添加', async () => {
    const x = world()
    const created = await createMember(x, x.A, '13800138000', '张三')
    const memberRow = [...x.w.stores.member_sandbox_members.values()][0]
    const pkgId = 'pkg-zhang-20'
    seedPackage(x, x.A, memberRow, pkgId)
    await x.call(x.B.open, 'addContact', { code: md.publicCodeFor('member', created.memberId) })
    const booked = await x.w.execute(x.B, 'createAuthorizedBooking', { studentId: memberRow.studentId, packageId: pkgId, date: '2026-10-08', hour: 10, minute: 0 })
    await x.w.execute(x.B, 'updateBookingContent', { bookingId: booked.result.bookingId, items: [{ name: '深蹲', sets: 3, reps: 12 }] })
    await x.w.execute(x.B, 'completeBooking', { bookingId: booked.result.bookingId })
    const before = { students: x.w.stores.students.size, packages: x.w.stores.packages.size, bookings: x.w.stores.bookings.size, incomes: x.w.stores.incomes.size, remaining: [...x.w.stores.packages.values()][0].data.remaining }
    const removed = await x.call(x.B.open, 'removeContact', { memberId: created.memberId })
    assert.equal(removed.ok, true)
    assert.equal(removed.historyKept, true)
    assert.equal([...x.w.stores.member_sandbox_contacts.values()].filter(r => r.coachId === x.B.owner)[0].status, 'removed')
    assert.deepEqual({ students: x.w.stores.students.size, packages: x.w.stores.packages.size, bookings: x.w.stores.bookings.size, incomes: x.w.stores.incomes.size, remaining: [...x.w.stores.packages.values()][0].data.remaining }, before)
    const added = await x.call(x.B.open, 'addContact', { code: md.publicCodeFor('member', created.memberId) })
    assert.equal(added.ok, true)
    assert.equal(x.w.stores.students.size, 1)
    assert.equal(x.w.stores.packages.size, 1)
    assert.equal([...x.w.stores.member_sandbox_contacts.values()].filter(r => r.coachId === x.B.owner)[0].status, 'active')
  })

  await check('客户端不能伪造数据归属', async () => {
    const x = world()
    const r = await x.call(x.A.open, 'createMemberByCoach', { phone: '13800138000', displayName: '张三', ownerCoachId: 'fake' })
    assert.equal(r.code, 'FORBIDDEN_IDENTITY_INPUT')
  })

  await check('会员入口页提供微信手机号按钮与手动输入兜底，且无旧认领词', () => {
    const js = read('pages/member-login/member-login.js'), wxml = read('pages/member-login/member-login.wxml')
    assert.ok(wxml.includes('open-type="getPhoneNumber"') && wxml.includes('bindgetphonenumber="onPhone"'), '缺少微信手机号按钮')
    assert.ok(/手机号|手动/.test(wxml), '缺少手动输入兜底')
    assert.equal(/认领码|训练档案|绑定会员微信/.test(wxml), false)
    assert.equal(/认领码|训练档案|绑定会员微信/.test(js), false)
  })

  await check('新联系人页面存在且不含旧认领入口（会员加教练 / 我的二维码 / 教练加会员）', () => {
    for (const f of ['pages/member-add-coach/member-add-coach.wxml', 'pages/member-contact-qr/member-contact-qr.wxml', 'pages/coach-add-member/coach-add-member.wxml']) {
      const s = read(f)
      assert.equal(/认领|绑定会员微信|8\s*位|邀请码/.test(s), false, f + '：仍有旧认领词')
    }
    const addCoachJs = read('pages/member-add-coach/member-add-coach.js')
    assert.ok(addCoachJs.includes('addByCode') || addCoachJs.includes('addByTicket'), '会员加教练页未接新联系人入口')
  })

  await check('学员页不再有旧「绑定会员微信」入口', () => {
    const wxml = read('pages/students/students.wxml'), js = read('pages/students/students.js')
    // ⚠️ 「认领」可能只是历史说明写在 HTML 注释里 ⇒ 必须先剥注释再判
    const strip = s => s.replace(/<!--[\s\S]*?-->/g, '')
    assert.equal(/绑定会员微信|openBindingFromEditor/.test(strip(wxml)), false)
    assert.equal(/openBindingFromEditor|member-bind-invite/.test(strip(js)), false)
  })

  await check('正式区没有测试区绑定模块', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'cloudfunctions/coachBusinessCommand/member-directory.js')), false)
  })

  await check('测试区云函数入口能正确路由到新会员动作', () => {
    const router = read('cloudfunctions/coachBusinessSandboxCommand/index.js')
    assert.ok(router.includes("directoryAction"))
    assert.ok(md.ACTIONS.includes('createMemberByCoach'))
    assert.ok(md.ACTIONS.includes('loginByPhone'))
    assert.ok(md.ACTIONS.includes('addContact'))
    // ⛔ 旧认领动作一个都不许残留
    for (const dead of ['issueMemberBinding', 'resolveMemberBinding', 'bindMember', 'bootstrapMember', 'MEMBER_BIND_PAGE']) {
      assert.equal(md.ACTIONS.includes(dead), false, '仍残留旧动作：' + dead)
    }
  })

  console.log(`\nRESULT ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}
main()
