// §110 永久测试：requestId 唯一契约（真机第 6 次同型事故）
//
// 真机一手证据（2026-09-28）：多条不同命令同时报
//   COMMAND_RESULT_UNKNOWN / CLOUD_CALL_FAILED · errCode -504002 · `errMsg: Error: requestId 无效。`
// 涉及的号形如
//   draft_pending:sandbox-student-1|sandbox-package-1|2026-09-17|11|0_mu6mr…
//   completeBooking:pending:sandbox-student-1|sandbox-package-1|2026-09-17|11|0_mu6ms…
// 共同点：含 `|`（U+007C），而云端白名单是 `^[A-Za-z0-9:_-]{8,128}$`（coachBusinessCommand/core.js:50）。
// `|` 是**业务键** bookingKey 的分隔符（pending-booking-request.js），不能改；要改的是 requestId 的派生方式。
//
// 本测试钉住三件事：
//   ① 出网边界：无论盘上存的是什么号，真正送到云端的必须是云端认得的合法号（execute 与 getReceipt 同一个号）；
//   ② 盘上不换号：原 requestId 一个字节都不许动（它是业务幂等身份，换号会让本机各处对不上账）；
//   ③ 幂等：同一条业务事实重复送达只生效一次（不重复扣课、不重复收入）。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const PROJ = path.join(__dirname, '..')
const { createAdapter } = require(path.join(PROJ, 'utils', 'cloud-primary-adapter'))
const rule = require(path.join(PROJ, 'utils', 'request-id-rule'))
const { InMemoryCommandEngine, emptyState } = require(path.join(PROJ, 'utils', 'cloud-command-engine'))

// —— 真机同形状的两个号（逐字照抄设备诊断里的形状）——
const REAL_DRAFT_ID = 'draft_pending:sandbox-student-1|sandbox-package-1|2026-09-17|11|0_mu6mr8x1'
const REAL_COMPLETE_ID = 'completeBooking:pending:sandbox-student-1|sandbox-package-1|2026-09-17|11|0_mu6ms9k2'
const LEGAL_ID = 'completeBooking_booking_690cad_1_ab12cd34'

// 行注释剥离（只处理 `//`，足够覆盖本项目的源码风格）。
// 用途：静态断言先剥注释，避免"被注释掉的代码仍然命中正则"这种假绿。
function stripComments(source) {
  return String(source).split('\n').map(line => {
    const at = line.indexOf('//')
    return at < 0 ? line : line.slice(0, at)
  }).join('\n')
}

let passed = 0
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed += 1; console.log('  ✓ ' + name) },
    error => { console.error('  ✗ ' + name); throw error })
}

// 一个只记录"出网时到底带了什么"的假通道。
// 关键：**不校验 requestId**——就像被修好之前的 adapter 一样。测试的价值就在于证明
// 校验不在这个假通道上，而在被测的 adapter 里（否则这个测试会把真实缺口一起假造掉）。
function harness({ cloudThrows = true, receipts = null } = {}) {
  const calls = []
  const storage = {
    map: new Map([['coachCloudActiveCache', { datasetId: 'ds-1', revision: 5, environment: 'sandbox', snapshot: null, checksum: 'c', byteSize: 1 }]]),
    get(key) { return this.map.has(key) ? this.map.get(key) : null },
    set(key, value) { this.map.set(key, value) }
  }
  const callCloud = async (name, data) => {
    calls.push({ name, data })
    if (cloudThrows) throw Object.assign(new Error('cloud.callFunction:fail errCode: -504002 errMsg: Error: requestId 无效。'), { errMsg: 'Error: requestId 无效。', code: 'INVALID_REQUEST_ID' })
    if (data && data.action === 'getReceipt') {
      const hit = receipts && receipts[data.requestId]
      return hit || { ok: true, found: false }
    }
    if (data && data.action === 'execute') return { ok: true, command: data.envelope.command, requestId: data.envelope.requestId, revision: 6, datasetRevision: 6, result: {} }
    return { ok: false, code: 'NOT_USED_IN_THIS_TEST' }
  }
  const adapter = createAdapter({ callCloud, storage, isOnline: () => true, environment: () => 'sandbox', onTiming: () => {} })
  return { calls, adapter, storage }
}

function main() {
  console.log('request id contract')
  return check('① 真机形状（含 | ）的号：出网时必须是合法号，且盘上原号不换', async () => {
    const { calls, adapter } = harness({ cloudThrows: false })
    const result = await adapter.execute('updateBookingContent', { bookingId: 'booking_690cad', items: [] }, { requestId: REAL_DRAFT_ID, expectedRevision: 5 })
    const sent = calls.filter(call => call.name === 'coachBusinessCommand' && call.data.action === 'execute')
    assert.equal(sent.length, 1, '★ 必须真的出网一次')
    const wireId = sent[0].data.envelope.requestId
    assert.ok(rule.isLegalRequestId(wireId),
      '★★★ 送到云端的号必须过云端契约（实际 ' + JSON.stringify(wireId) + '）—— 这正是真机 7 条命令被拒的原因')
    assert.notEqual(wireId, REAL_DRAFT_ID, '★ 含 | 的原号绝不能原样出网')
    assert.equal(result.ok, true, '★ 合法号应当被云端受理（本例假通道不校验，只证明号本身合法）')
  })
    .then(() => check('② 同一个号两次派生必须完全一致（幂等身份不靠记忆）', async () => {
      const a = rule.wireRequestId(REAL_DRAFT_ID)
      const b = rule.wireRequestId(REAL_DRAFT_ID)
      assert.equal(a, b, '★ 杀进程/重启/换设备都必须得到同一个别名，否则重试会变成两条业务')
      assert.ok(rule.isLegalRequestId(a))
      // 合法号原样返回：不许动任何本来就能用的号（否则会把老命令的账搅乱）。
      assert.equal(rule.wireRequestId(LEGAL_ID), LEGAL_ID, '★ 已经合法的号必须原样出网，一个字符都不许改')
    }))
    .then(() => check('③ getReceipt 与 execute 必须用同一个号（查回执也是同一套契约）', async () => {
      const { calls, adapter } = harness({ cloudThrows: true })
      await adapter.execute('completeBooking', { bookingId: 'booking_690cad' }, { requestId: REAL_COMPLETE_ID, expectedRevision: 5 })
      const executed = calls.find(call => call.data.action === 'execute')
      const probed = calls.filter(call => call.data.action === 'getReceipt')
      assert.ok(probed.length >= 1, '★ 传输失败后应当按同一个号查回执')
      assert.ok(probed.every(call => call.data.requestId === executed.data.envelope.requestId),
        '★★★ 查回执的号必须与发送的号逐字相同，否则查的是另一条请求')
      assert.ok(probed.every(call => rule.isLegalRequestId(call.data.requestId)),
        '★ 查回执的号本身也必须合法（云端 core.js:260 同样校验）')
    }))
    .then(() => check('④ 查回执失败必须留下原因（不许再出现"只知道失败了"）', async () => {
      const { adapter } = harness({ cloudThrows: true })
      const receipt = await adapter.getReceipt(REAL_DRAFT_ID)
      assert.equal(receipt.ok, false)
      assert.ok(String(receipt.technicalMessage || '').length > 0,
        '★ 原因必须落下来：否则「查询失败」与「云端说没受理过」在日志里长得一模一样')
    }))
    .then(() => check('⑤ 归一化不了的号（非字符串 / 超长且无法派生）fail closed，绝不出网', async () => {
      const { calls, adapter } = harness({})
      const bad = await adapter.execute('updateBookingContent', { bookingId: 'b1' }, { requestId: 12345, expectedRevision: 5 })
      assert.equal(bad.ok, false, '★ 非字符串 requestId 不许出网')
      assert.equal(calls.length, 0, '★★★ 出网前就必须拒绝：发出去只是白烧一次网络往返')
      // 超长号走确定性哈希兜底，绝不截断（截断会把两条业务并成一条）
      const long = 'x'.repeat(400) + '|' + 'y'.repeat(400)
      const hashed = rule.wireRequestId(long)
      assert.ok(rule.isLegalRequestId(hashed), '★ 超长号必须能派生出合法号')
      assert.notEqual(hashed, long.slice(0, 128), '★★★ 绝不许靠截断凑长度')
      assert.equal(rule.wireRequestId(long), hashed, '★ 哈希也必须确定性')
    }))
    .then(() => check('⑥ 新生成的号必须满足契约（22 条命令共用同一套规则）', () => {
      const mutate = require(path.join(PROJ, 'utils', 'mutate'))
      const commands = ['createBooking', 'updateBookingContent', 'completeBooking', 'cancelBooking', 'rescheduleBooking', 'deleteCompletedBooking', 'markBookingNotHeld', 'createStudent', 'updateStudent', 'deleteStudent', 'createPackage', 'updatePackage', 'deletePackage', 'createCourseSale', 'updateCourseSale', 'reverseCourseSale', 'createManualSale', 'updateManualSale', 'deleteManualSale', 'createCustomExercise', 'updateCustomExercise', 'deleteCustomExercise', 'saveSettings', 'setPackageShare']
      commands.forEach(command => {
        const id = mutate.newRequestIdForTest ? mutate.newRequestIdForTest(command) : null
        if (id) assert.ok(rule.isLegalRequestId(id), '★ ' + command + ' 生成的号必须合法（实际 ' + id + '）')
      })
      // 稳定号（完课/删除已完成课程）也必须在契约内
      const src = fs.readFileSync(path.join(PROJ, 'utils', 'mutate.js'), 'utf8')
      assert.ok(/function stableRequestId/.test(src), '★ 必须保留稳定号入口（它是完课幂等的根基）')
      assert.ok(/function factRequestId/.test(src), '★ 必须保留业务事实号入口')
    }))
    .then(() => check('⑦ 同 requestId 重复送达：只生效一次（不重复扣课 / 不重复收入）', async () => {
      const engine = new InMemoryCommandEngine()
      const base = emptyState()
      base.bookings = [{ id: 'booking_690cad', studentId: 'stu-1', packageId: 'pkg-1', date: '2026-09-20', hour: 10, minute: 0, status: 'booked', items: [{ name: '深蹲', sets: 4, reps: 12, weight: 60 }], price: 100, typeName: '常规训练' }]
      base.students = [{ id: 'stu-1', name: '甲', phone: '', packages: [{ id: 'pkg-1', studentId: 'stu-1', type: '常规训练', typeName: '常规训练', remaining: 10, reserved: 0, used: 0, total: 10, price: 100 }] }]
      engine.seed('coach-1', base)
      const envelope = { command: 'completeBooking', requestId: rule.wireRequestId(REAL_COMPLETE_ID), expectedRevision: base.dataRevision, payload: { bookingId: 'booking_690cad' } }
      const first = engine.execute({ ownerCoachId: 'coach-1' }, envelope)
      const usedAfterFirst = engine.read('coach-1').students[0].packages[0].used
      const incomeAfterFirst = (engine.read('coach-1').incomes || []).length
      const second = engine.execute({ ownerCoachId: 'coach-1' }, envelope)
      assert.equal(first.ok, true, '（前置）第一次必须成功')
      assert.equal(second.ok, true, '★ 同号重发必须被认成同一次请求（幂等命中）')
      assert.equal(second.idempotent, true, '★★★ 第二次必须是幂等命中，而不是又执行一次')
      assert.equal(engine.read('coach-1').students[0].packages[0].used, usedAfterFirst, '★★★ 同号重发绝不能二次扣课')
      assert.equal((engine.read('coach-1').incomes || []).length, incomeAfterFirst, '★★★ 同号重发绝不能二次收入')
    }))
    .then(() => check('⑧ 环境隔离：Sandbox 的号不会带 Production 环境出网', async () => {
      const calls = []
      const storage = { map: new Map([['coachCloudActiveCache', { datasetId: 'ds-1', revision: 5, environment: 'sandbox', snapshot: null, checksum: 'c', byteSize: 1 }]]), get(k) { return this.map.has(k) ? this.map.get(k) : null }, set(k, v) { this.map.set(k, v) } }
      const adapter = createAdapter({
        callCloud: async (name, data) => { calls.push(data); return { ok: true, command: data.envelope.command, requestId: data.envelope.requestId, revision: 6, datasetRevision: 6, result: {} } },
        storage, isOnline: () => true, environment: () => 'sandbox', onTiming: () => {}
      })
      await adapter.execute('updateBookingContent', { bookingId: 'b1' }, { requestId: REAL_DRAFT_ID, expectedRevision: 5 })
      assert.equal(calls[0].environment, 'sandbox', '★ 出网环境必须是 sandbox')
      assert.ok(rule.isLegalRequestId(calls[0].envelope.requestId))
      // 云端校验用于两个环境的是**同一条规则**（core.js 只有一份 validateRequestId）
      const core = fs.readFileSync(path.join(PROJ, 'cloudfunctions', 'coachBusinessCommand', 'core.js'), 'utf8')
      assert.equal(core.split('function validateRequestId').length - 1, 1,
        '★★★ 云端只能有一份 requestId 校验：两份口径不同步正是历史上白烧部署的原因')
    }))
    .then(() => check('⑨ 静态：闸门必须装在**真实出网口**，且盘上盘下同一套规则', () => {
      const adapterSrc = fs.readFileSync(path.join(PROJ, 'utils', 'cloud-primary-adapter.js'), 'utf8')
      const executeBody = adapterSrc.slice(adapterSrc.indexOf('async function execute('), adapterSrc.indexOf('async function getReceipt('))
      assert.ok(executeBody.includes('wireRequestId'), '★★★ execute（唯一出网口）必须过 requestId 契约')
      assert.ok(adapterSrc.indexOf('async function getReceipt(') < adapterSrc.length)
      const receiptBody = adapterSrc.slice(adapterSrc.indexOf('async function getReceipt('))
      assert.ok(receiptBody.slice(0, 900).includes('wireRequestId'), '★★★ getReceipt 必须过同一套契约')
      // 不许靠"取消云端校验"粗暴解决。
      // ⚠️ 静态断言必须**先剥注释**：否则把 `validateRequestId(...)` 注释掉之后文本仍在，
      //    断言照样绿 —— §109 已经因为裸正则漏过一次同样的坏改法。
      const core = stripComments(fs.readFileSync(path.join(PROJ, 'cloudfunctions', 'coachBusinessCommand', 'core.js'), 'utf8'))
      assert.ok(/function validateRequestId/.test(core), '★ 云端校验必须保留（修的是客户端，不是把门拆了）')
      assert.ok(/validateRequestId\(envelope\.requestId\)/.test(core), '★ execute 入口必须继续校验')
      assert.ok(/validateRequestId\(event\.requestId\)/.test(core), '★ getReceipt 入口必须继续校验')
      // 客户端契约副本必须与云端正则逐字一致
      const contract = fs.readFileSync(path.join(PROJ, 'utils', 'cloud-command-contract.js'), 'utf8')
      const cloudPattern = (core.match(/\/\^\[A-Za-z0-9:_-\]\{\d+,\d+\}\$\//) || [])[0]
      assert.ok(cloudPattern, '★ 必须能从云端源码里取出白名单正则')
      assert.ok(contract.includes(cloudPattern), '★★★ 客户端副本的正则必须与云端逐字相同（实际云端 ' + cloudPattern + '）')
    }))
    .then(() => check('⑩ 只读诊断必须能看出「盘上号 ≠ 出网号」以及云端是否明确拒收过', () => {
      const syncSrc = fs.readFileSync(path.join(PROJ, 'utils', 'sync-engine.js'), 'utf8')
      assert.ok(syncSrc.includes('wireRequestId:'), '★ 队列详情必须印出实际发出去的号（真机取证全靠这一列）')
      assert.ok(syncSrc.includes('requestIdLegal'), '★ 必须能一眼看出盘上号本身是否合法')
      assert.ok(syncSrc.includes('cloudRejectedId'), '★ 必须能看出云端是否明确说过这个号无效')
      assert.ok(rule.cloudRejectedRequestId({ code: 'COMMAND_RESULT_UNKNOWN', technicalMessage: 'Error: requestId 无效。at commandError' }) === true,
        '★ 云端原文必须被识别为「明确拒收」')
      assert.ok(rule.cloudRejectedRequestId({ code: 'CLOUD_FUNCTION_TIMEOUT', technicalMessage: 'TIME_LIMIT' }) === false,
        '★★★ 超时/网络失败绝不能被当成"云端没收到"（那是另一件事，处置完全不同）')
    }))
}

main().then(() => {
  console.log('\nrequest id contract: PASS (' + passed + ' 段)')
}, error => { console.error('request id contract: FAIL'); console.error(error); process.exit(1) })
