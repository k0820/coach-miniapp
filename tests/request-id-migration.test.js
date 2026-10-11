// requestId 格式自检 + 受控迁移专项测试。
//
// 背景（2026-09-22 真机）：手机队首 `ob_29_l5cmqb`（completeBooking）在补发时被云端拒
// `INVALID_REQUEST_ID`。根因不是数据损坏，而是**历史生成规则**：
//   session.js 把 `completeBooking:${localId}` 当 commandKey，未转正时 localId = `pending:${bookingKey}`，
//   而 bookingKey = studentId|packageId|date|hour|minute（pending-booking-request.js:33）
//   ⇒ 号里出现 `|`（U+007C），服务端白名单 `[A-Za-z0-9:_-]` 不含它。
// 这类号**结构上永远无法被服务端识别**：execute 与 getReceipt 都在 validateRequestId 上先抛错
// （core.js:45 / core.js:196），事务根本不会开始。所以既不能"再点一次"，也不能凭"业务上像是没执行"
// 就换号 —— 必须先用**与服务端同一份判定**把整条队列扫清楚，再按证据决定。
//
// 这份测试钉三件事：
//   ① **口径同源**：直接把云函数源码里的正则抠出来编译，逐样本与本模块比对 —— 不许各抄一份；
//   ② **迁移是纯函数且可核对**：确定性、幂等、只动非法字符、给得出确切的新号、算不出就拒绝；
//   ③ **三种回执情形**（已提交 / 未提交 / 未知）各有唯一结论，且"重复执行历史命令"被结构性挡住。
const path = require('path')
const fs = require('fs')

const PROJ = path.join(__dirname, '..')
const rule = require(path.join(PROJ, 'utils', 'request-id-rule'))

let capturedPage = null
global.Page = definition => { capturedPage = definition }
const page = require(path.join(PROJ, 'pkg-diag', 'repair-orphan-tombstone', 'repair-orphan-tombstone.js'))

let pass = 0
let fail = 0
const failures = []
async function test(name, fn) {
  try { await fn(); pass += 1; console.log('PASS  ' + name) }
  catch (error) { fail += 1; failures.push(name + ' :: ' + (error && error.message)); console.log('FAIL  ' + name + '   | ' + (error && error.message)) }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assert failed') }
assert.strictEqual = (actual, expected, message) => assert(actual === expected, (message || '') + ' ｜ 期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual))
assert.deepStrictEqual = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), (message || '') + ' ｜ 期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual))
assert.includes = (list, value, message) => assert((list || []).indexOf(value) >= 0, (message || '') + ' ｜ 缺少 ' + JSON.stringify(value))

// —— 真实形状（从代码规则推导，不是手编的）——
const BOOKING_KEY = 'mtfe64ce5l0wwn|mthcl6gmkl9nng|2026-09-19|12|0'
const REAL_ILLEGAL = 'completeBooking:pending:' + BOOKING_KEY
const OFFICIAL_ID = 'booking_d4149d6670a3d944adfd'
const REAL_LEGAL = 'completeBooking:' + OFFICIAL_ID
const GENERATED_LEGAL = 'createBooking_muc5utt1_1_17400z7a'

// 从服务端源码里**抠出**它真正在用的正则 —— 这才是"同口径"的证据，而不是我嘴上说一致。
function serverRegexSource(relative) {
  const source = fs.readFileSync(path.join(PROJ, relative), 'utf8')
  const found = source.match(/\/\^\[A-Za-z0-9:_-\]\{8,128\}\$\//)
  return found ? found[0] : null
}

async function main() {
  console.log('=== requestId 格式自检 + 受控迁移专项 ===')

  // ───────────────── ① 口径同源（防两份正则漂移）─────────────────
  await test('服务端与客户端源码里的 requestId 正则都是那一份，且与本模块逐字相同', async () => {
    const server = serverRegexSource('cloudfunctions/coachBusinessCommand/core.js')
    const contract = serverRegexSource('utils/cloud-command-contract.js')
    assert(server, '云函数 core.js 里必须能找到 requestId 正则')
    assert(contract, '客户端契约里必须能找到同一份正则')
    assert.strictEqual(server, '/' + rule.REQUEST_ID_PATTERN + '/', '云函数正则')
    assert.strictEqual(contract, server, '客户端契约必须与服务端逐字相同')
    assert.strictEqual(String(rule.REQUEST_ID_RULE), server, '本模块正则必须与它们逐字相同')
  })

  await test('逐样本比对：本模块的判定 = 用服务端正则直接编译出来的判定', async () => {
    const compiled = new RegExp(rule.REQUEST_ID_PATTERN)
    const samples = [REAL_ILLEGAL, REAL_LEGAL, GENERATED_LEGAL, 'activate_1790050510691_abc123', 'mig1_x',
      'short', '', 'has space', 'has.dot', 'has/slash', 'has#hash',
      'completeBooking:pending:sid|pid|2026-09-19|12|0', 'a'.repeat(128), 'a'.repeat(129),
      null, undefined, 1790050510691, { requestId: 'x' }]
    samples.forEach(sample => {
      const serverSays = typeof sample === 'string' && compiled.test(sample)
      assert.strictEqual(rule.isLegalRequestId(sample), serverSays, '样本必须与服务端同判：' + JSON.stringify(sample))
    })
  })

  // ───────────────── ② 历史号的形状与判定 ─────────────────
  await test('真实历史形状（pending:<bookingKey>）被判非法，并精确指出 4 个 `|`', async () => {
    const verdict = rule.requestIdVerdict(REAL_ILLEGAL)
    assert.strictEqual(verdict.ok, false, '必须非法')
    assert.strictEqual(verdict.code, 'ILLEGAL_CHARS', '原因码')
    assert.strictEqual(verdict.illegal.length, 4, '非法字符个数（studentId|packageId|date|hour|minute 共 4 个竖线）')
    verdict.illegal.forEach(row => assert.strictEqual(row.char, '|', '非法字符必须是竖线'))
    assert(verdict.reason.indexOf('U+007C') >= 0, '原因里要给出码点，便于机器核对')
  })

  await test('三种"不合法"必须分开：不是字符串 / 长度越界 / 含非法字符，处置不同', async () => {
    assert.strictEqual(rule.requestIdVerdict(undefined).code, 'NOT_A_STRING', 'undefined')
    assert.strictEqual(rule.requestIdVerdict(1790050510691).code, 'NOT_A_STRING', '数字（服务端 typeof 就先拒）')
    assert.strictEqual(rule.requestIdVerdict('short').code, 'TOO_SHORT', '太短')
    assert.strictEqual(rule.requestIdVerdict('a'.repeat(129)).code, 'TOO_LONG', '太长')
    assert.strictEqual(rule.requestIdVerdict(REAL_LEGAL).code, 'OK', '合法')
  })

  // ───────────────── ③ 迁移号：纯函数、确定、只动非法字符 ─────────────────
  await test('迁移号是确定性的：同一个旧号永远得到同一个新号（跨重启/跨设备一致）', async () => {
    const a = rule.migratedRequestId(REAL_ILLEGAL)
    const b = rule.migratedRequestId(REAL_ILLEGAL)
    assert.deepStrictEqual(a, b, '两次调用必须逐字相同')
    assert.strictEqual(a.ok, true, '这条必须能转出来')
    assert.strictEqual(a.changed, true, '应当被改过')
    assert.strictEqual(a.requestId.indexOf(rule.MIGRATION_PREFIX), 0, '必须带迁移前缀')
  })

  await test('迁移号合法、长度有上界、且旧号的字符一个不丢（`|` → `_x007C_`）', async () => {
    const migrated = rule.migratedRequestId(REAL_ILLEGAL).requestId
    assert(rule.isLegalRequestId(migrated), '迁移号必须合法：' + migrated)
    assert(migrated.length <= rule.REQUEST_ID_MAX, '长度上界')
    assert(migrated.indexOf('_x007C_') >= 0, '竖线必须被确定性转义：' + migrated)
    assert.strictEqual(migrated, rule.MIGRATION_PREFIX + 'completeBooking:pending:mtfe64ce5l0wwn_x007C_mthcl6gmkl9nng_x007C_2026-09-19_x007C_12_x007C_0', '确切值（防实现漂移）')
  })

  await test('已经合法的号一律原样返回，绝不被"顺手改一下"', async () => {
    ;[REAL_LEGAL, GENERATED_LEGAL, 'activate_1790050510691_abc123'].forEach(id => {
      const result = rule.migratedRequestId(id)
      assert.strictEqual(result.ok, true, '合法号必须能通过：' + id)
      assert.strictEqual(result.changed, false, '合法号不许改：' + id)
      assert.strictEqual(result.requestId, id, '合法号必须逐字原样：' + id)
    })
  })

  await test('转不出来就**如实拒绝**：非字符串 / 转义后超长 —— 绝不截断、绝不硬造', async () => {
    assert.strictEqual(rule.migratedRequestId(undefined).ok, false, 'undefined 拒绝')
    assert.strictEqual(rule.migratedRequestId(undefined).code, 'NOT_A_STRING', '原因码')
    const tooLong = 'x'.repeat(120) + '|'.repeat(10)
    const result = rule.migratedRequestId(tooLong)
    assert.strictEqual(result.ok, false, '转义后 120+10*6+5 > 128 ⇒ 必须拒绝')
    assert.strictEqual(result.code, 'ESCAPE_TOO_LONG', '原因码')
    assert.strictEqual(result.requestId, null, '拒绝时不给号（免得有人拿 null 去发）')
  })

  // ───────────────── ④ 整队扫描（她要的"一次扫完，不逐条踩雷"）─────────────────
  await test('整队自检：混合队列一次分完类，逐条给出原因', async () => {
    const entries = [
      { entryId: 'ob_29_l5cmqb', command: 'completeBooking', status: 'unknown', attempts: 3, requestId: REAL_ILLEGAL },
      { entryId: 'ob_2a_bhku2v', command: 'rescheduleBooking', status: 'pending', attempts: 0, requestId: GENERATED_LEGAL },
      { entryId: 'ob_2b_xxxxxx', command: 'completeBooking', status: 'pending', attempts: 0, requestId: 'completeBooking:pending:a|b|2026-09-20|20|0' },
      { entryId: 'ob_2c_yyyyyy', command: 'updateBookingContent', status: 'settled', attempts: 1, requestId: REAL_LEGAL }
    ]
    const audit = rule.auditRequestIds(entries)
    assert.strictEqual(audit.total, 4, '总数')
    assert.strictEqual(audit.illegalCount, 2, '非法条数')
    assert.strictEqual(audit.legalCount, 2, '合法条数')
    assert.deepStrictEqual(audit.illegal.map(row => row.entryId), ['ob_29_l5cmqb', 'ob_2b_xxxxxx'], '非法条目必须点名')
    audit.illegal.forEach(row => assert(row.verdict.reason.length > 0, '每条都要带原因'))
  })

  await test('迁移计划是**只读**的：只给旧号→新号，不动任何条目；冲突/算不出就拒绝', async () => {
    const entries = [
      { entryId: 'ob_29_l5cmqb', command: 'completeBooking', status: 'unknown', attempts: 3, requestId: REAL_ILLEGAL },
      { entryId: 'ob_ok_1', command: 'completeBooking', status: 'pending', attempts: 0, requestId: REAL_LEGAL }
    ]
    const frozenCopy = JSON.stringify(entries)
    const plan = rule.migrationPlanOf(entries, [])
    assert.strictEqual(JSON.stringify(entries), frozenCopy, '计划函数不许改入参（只读）')
    assert.strictEqual(plan.planCount, 1, '只有 1 条需要迁移（合法那条不许动）')
    assert.strictEqual(plan.ok, true, '没有拒绝项时 ok=true')
    assert.strictEqual(plan.plans[0].entryId, 'ob_29_l5cmqb', '点名的必须是那条非法号')
    assert.strictEqual(plan.plans[0].newRequestId, rule.migratedRequestId(REAL_ILLEGAL).requestId, '计划里的新号必须等于纯函数的输出')

    // 新号已被占用（队列里）⇒ 拒绝，避免把两条业务并成一条
    const occupied = entries.concat([{ entryId: 'ob_dup', command: 'x', requestId: rule.migratedRequestId(REAL_ILLEGAL).requestId }])
    const rejected = rule.migrationPlanOf(occupied, [])
    assert.strictEqual(rejected.ok, false, '新号撞上现存号必须整批拒绝')
    assert.strictEqual(rejected.refusals[0].code, 'COLLIDES_WITH_EXISTING', '拒绝原因码')

    // 新号与 failed 归档里的号相同 ⇒ 也拒绝（归档里的号是"云端拒绝过"的，不能复用）
    const archived = rule.migrationPlanOf(entries, [{ requestId: rule.migratedRequestId(REAL_ILLEGAL).requestId }])
    assert.strictEqual(archived.ok, false, '撞归档也必须拒绝')
  })

  // ───────────────── ⑤ 三种回执情形 → 唯一结论 ─────────────────
  await test('迁移闸门：已提交(succeeded) / 未提交(found=false) / 未知(ok=false) 三种情形各有唯一结论', async () => {
    const illegalVerdict = rule.requestIdVerdict(REAL_ILLEGAL)
    const legalVerdict = rule.requestIdVerdict(REAL_LEGAL)
    const gate = page.migrationGateOf

    // ① 号合法 ⇒ 不走迁移（走受控补发，回执说了算）
    assert.strictEqual(gate({ verdict: legalVerdict, receiptState: { state: 'SUCCEEDED' }, factAbsentProven: true }).code, 'ID_ALREADY_LEGAL', '合法号不走迁移')

    // ② 非法号 + 回执查询失败 + **结构性证据** + **云端已证明无此事实** ⇒ 唯一放行（三类证据必须齐全）
    const allowed = gate({ verdict: illegalVerdict, receiptState: { state: 'QUERY_FAILED' }, structuralProven: true, factAbsentProven: true, factPresent: false })
    assert.strictEqual(allowed.allow, true, '这是唯一放行的组合')
    assert.strictEqual(allowed.code, 'ALLOW_ONE_TIME_MIGRATION', '结论码')

    // ③ 非法号 + 云端已有该业务事实 ⇒ **禁止**换号重发（会重复扣课时 / 重复记收入）
    const present = gate({ verdict: illegalVerdict, receiptState: { state: 'QUERY_FAILED' }, structuralProven: true, factPresent: true, factAbsentProven: true })
    assert.strictEqual(present.allow, false, '云端已有事实时绝不允许迁移重发')
    assert.strictEqual(present.code, 'FACT_ALREADY_PRESENT', '结论码')

    // ④ 非法号 + 没有"云端确实没有"的证据 ⇒ 停手（这一支是"未知"的正解）
    const unproven = gate({ verdict: illegalVerdict, receiptState: { state: 'QUERY_FAILED' }, structuralProven: true })
    assert.strictEqual(unproven.allow, false, '缺证据必须停手')
    assert.strictEqual(unproven.code, 'FACT_NOT_PROVEN_ABSENT', '结论码')

    // ④b 三类证据里缺"结构性"那一类 ⇒ 同样停手。
    //     每一道闸都要有**专属**断言：挤在一条里的话，摘掉其中一道那条依然绿，对照实验会给出错误结论。
    assert.strictEqual(gate({ verdict: illegalVerdict, receiptState: { state: 'QUERY_FAILED' }, factAbsentProven: true }).code, 'STRUCTURAL_NOT_PROVEN', '缺结构性证据必须停手')

    // ⑤ 非法号 + 回执居然有结论（不该发生）⇒ 人工看，不迁移
    assert.strictEqual(gate({ verdict: illegalVerdict, receiptState: { state: 'SUCCEEDED' }, factAbsentProven: true }).code, 'RECEIPT_UNEXPECTEDLY_ANSWERED', '反常情形停手')

    // ⑥ 不是"含非法字符"那一支（非字符串 / 长度越界）⇒ 绝不自动迁移
    assert.strictEqual(gate({ verdict: rule.requestIdVerdict('short'), receiptState: { state: 'QUERY_FAILED' }, factAbsentProven: true }).allow, false, 'TOO_SHORT 必须人工决策')
  })

  await test('对偶断言：闸门的放行**钉在 factAbsentProven 上**（摘掉它就会放走已提交的业务）', async () => {
    const illegalVerdict = rule.requestIdVerdict(REAL_ILLEGAL)
    // 只要求"号非法 + 回执查不到"就放行的**危险口径**：它会连"云端其实已经有这条业务事实"也放过去。
    // 这里把它显式写出来做对照，证明本模块的严格口径不是摆设。
    const looseGate = row => (row.verdict && row.verdict.ok === false && row.verdict.code === 'ILLEGAL_CHARS' &&
      (!row.receiptState || row.receiptState.state === 'QUERY_FAILED')) ? { allow: true } : { allow: false }
    const dangerInput = { verdict: illegalVerdict, receiptState: { state: 'QUERY_FAILED' }, factPresent: true }
    assert.strictEqual(looseGate(dangerInput).allow, true, '危险口径确实会放行"云端已有事实"的那一条')
    assert.strictEqual(page.migrationGateOf(dangerInput).allow, false, '本模块的口径必须挡住它')
  })

  await test('自检报告可复制、可核对：非法条必须连**原值**一起印出来', async () => {
    const entries = [{ entryId: 'ob_29_l5cmqb', command: 'completeBooking', status: 'unknown', attempts: 3, requestId: REAL_ILLEGAL }]
    const record = {
      atText: '2026-09-23 00:30:00（北京时）', frozen: true,
      audit: rule.auditRequestIds(entries), plan: rule.migrationPlanOf(entries, [])
    }
    const text = page.auditTextOf(record)
    assert(text.indexOf('ob_29_l5cmqb') >= 0, '必须点名条目')
    assert(text.indexOf(REAL_ILLEGAL) >= 0, '必须印出原值（人要能看到到底长什么样）')
    assert(text.indexOf('U+007C') >= 0, '必须印出犯规字符的码点')
    assert(text.indexOf('只读') >= 0, '必须写明只读')
    assert(text.indexOf('execute') < 0, '自检不发送命令 ⇒ 报告里不该出现 execute 计数')
  })

  console.log('')
  console.log('=== ' + (fail ? 'FAIL' : 'ALL GREEN') + '：' + pass + ' 通过 / ' + fail + ' 失败 ===')
  if (fail) { failures.forEach(row => console.log('  ⛔ ' + row)); process.exitCode = 1 }
}

main().catch(error => { console.log('CRASH ' + (error && error.stack || error)); process.exitCode = 1 })
