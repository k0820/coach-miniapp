// M3-P2-3 · 人工码统一为 8 位短码 —— 永久回归（2026-09-30）
//
// ★★ 改的是什么 ★★
//   两种"要人口头念 / 手抄 / 截图转述"的码原来都又长又容易读错：
//     · 认领码：`randomBytes(18).toString('base64url')` = **24 位** ⇒ 手抄基本不可能对；
//     · 共享码：`randomBytes(5).toString('hex').toUpperCase()` = **10 位十六进制** ⇒ 只有 0-9A-F，
//       `6/B`、`8/B`、`0/D` 极易混。
//   统一为 **8 位 Crockford 风格短码**（字符集 `0-9 A-Z` 去掉 I / L / O / U）。
//
// ★★ 这份测试为什么必要（用户点名的四项检查）★★
//   · **生成**：8 位、字符集合法、**无取模偏差**（不是 `% 32`）；
//   · **唯一性校验**：⛔ 两个调用方的主键都是"码的 hash"⇒ 撞码是**静默覆盖**而不是报错，
//     所以生成端**必须查重**。⑪⑫ 两段专门证明"撞码时换一枚、绝不覆盖已有那条"。
//   · **有效期**：认领码仍是 15 分钟（⑧）；
//   · **服务端查询 / 兑换**：①–⑦ + ⑨⑩⑬，重点是**历史长码继续可用**（⑩）。
//
// ★★ 绝不允许的偷懒做法（本文件就是防它的）★★
//   "前端截取现有长 token 的前 8 位" —— 那样码是**可预测的**（前缀来自同一个 hash），
//   而且服务端查的还是长码 ⇒ 两边不一致。这里钉的是**服务端生成 + 服务端兑换**的完整闭环。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { createWorld, runner } = require('./helpers/m2-business-world')
const { counterSource, seededSource, withDeterministicBytes } = require('./helpers/deterministic-bytes')

const ROOT = path.join(__dirname, '..')
const CLOUD = path.join(ROOT, 'cloudfunctions')
const SHORT_CLOUD = path.join(CLOUD, 'coachBusinessCommand/short-code.js')
const SHORT_MEMBER = path.join(CLOUD, 'memberIdentityCommand/short-code.js')
const cloudShort = require(SHORT_CLOUD)
const memberShort = require(SHORT_MEMBER)
const sharing = require(path.join(CLOUD, 'coachBusinessCommand/sharing'))
const core = require(path.join(CLOUD, 'coachBusinessCommand/core'))
const identity = require(path.join(CLOUD, 'memberIdentityCommand/service'))

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const ENV = 'sandbox'
const STAMP = 1900000000000
const FIFTEEN_MINUTES = 15 * 60 * 1000
const CLAIM_TOKENS = 'member_sandbox_claim_tokens'
const SHARES = 'coach_sandbox_package_shares'

const world = createWorld()
const COACH_OPEN = 'open-short-coach'
const MEMBER_OPEN = 'open-short-member'
let currentOpenId = ''
let stamp = STAMP
const identityService = identity.createService({ db: world.db, getOpenId: () => currentOpenId, now: () => stamp })

let A
let seq = 0
const rid = prefix => `${prefix}_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`

function setup() {
  world.reset()
  currentOpenId = ''
  stamp = STAMP
  const coachId = identity.coachIdFor(COACH_OPEN)
  world.put('coaches', coachId, { openId: COACH_OPEN, status: 'active' })
  world.put(core.SANDBOX_META.heads, core.fixedId('coach-sandbox-head', coachId),
    { ownerCoachId: coachId, environment: 'sandbox', activeDatasetId: 'ds-1', headVersion: 1 })
  world.put(core.SANDBOX_META.revisions, core.fixedId('coach-sandbox-revision', coachId, 'ds-1'),
    { ownerCoachId: coachId, datasetId: 'ds-1', dataRevision: 0 })
  A = { open: COACH_OPEN, owner: coachId, datasetId: 'ds-1' }
  // ⚠️ 必须有这条：`coachBusinessCommand` 在开事务之前会校验"当前云端数据代次"，
  //    缺了 `coach_dataset` 行就一律 `ACTIVE_DATASET_INVALID`（⑫ 曾经就栽在这）。
  world.put(core.META.datasets, core.fixedId('coach-dataset', coachId, 'ds-1'),
    { ownerCoachId: coachId, datasetId: 'ds-1', status: 'active', integrityStatus: 'verified', checksum: 'ok', byteSize: 1, summary: {}, schemaVersion: 1 })
  world.seedStudent(A, 'stu-1', '会员甲')
  world.put('packages', world.businessId('packages', A.owner, A.datasetId, 'pkg-1'), {
    ownerCoachId: A.owner, datasetId: A.datasetId, packageId: 'pkg-1', studentId: 'stu-1',
    data: { id: 'pkg-1', type: '常规训练', studentId: 'stu-1', total: 10, remaining: 8, used: 1, reserved: 0, status: 'active' }
  })
}

const coachRevision = () => (world.stores[core.SANDBOX_META.revisions].get(core.fixedId('coach-sandbox-revision', A.owner, A.datasetId)) || {}).dataRevision || 0
function memberRevision() {
  const n = identity.names(ENV), memberId = identity.memberIdFor(MEMBER_OPEN)
  const row = world.stores[n.revisions].get(identity.fixedId(n.revisions, 'member', memberId))
  return row ? Number(row.dataRevision || 0) : 0
}

async function issueClaimToken(studentId = 'stu-1') {
  currentOpenId = COACH_OPEN
  return identityService({
    action: 'coachExecute', environment: ENV, command: 'createClaimToken',
    requestId: rid('ct'), expectedRevision: coachRevision(), payload: { studentId }
  })
}
async function claimWith(claimToken) {
  currentOpenId = MEMBER_OPEN
  return identityService({
    action: 'execute', environment: ENV, command: 'claimStudentRecord',
    requestId: rid('cl'), expectedRevision: memberRevision(), payload: { claimToken }
  })
}
const tokenRows = () => [...world.stores[CLAIM_TOKENS].values()]
const shareRows = () => [...world.stores[SHARES].values()]

// 临时把生成器钉在指定码上（模拟"极不巧地撞了码"），finally 一定还原。
function fakeGenerate(module, sequence) {
  const original = module.generate
  let index = 0
  module.generate = () => {
    const forced = sequence[Math.min(index, sequence.length - 1)]
    index += 1
    return typeof forced === 'function' ? forced() : forced
  }
  return () => { module.generate = original }
}

async function main() {
  // ---------------------------------------------------------------- ① 孪生逐字节相同
  await runner('① 两份 short-code.js **逐字节相同**（云函数按目录部署 ⇒ 必须孪生，由本测试锁死）', async () => {
    const a = fs.readFileSync(SHORT_CLOUD, 'utf8')
    const b = fs.readFileSync(SHORT_MEMBER, 'utf8')
    assert.strictEqual(a, b,
      '⛔ 两个云函数目录里的 short-code.js 必须完全相同 —— 改一份就要同时改另一份（跨目录 require 在真机上找不到文件）')
    assert.strictEqual(cloudShort.ALPHABET, memberShort.ALPHABET)
    assert.strictEqual(cloudShort.LENGTH, memberShort.LENGTH)
    assert.ok(cloudShort.generate().length === 8 || (() => { throw new Error('长度必须是 8') })())
  })

  // ---------------------------------------------------------------- ② 生成：8 位、字符集合规、零碰撞
  await runner('② 生成：固定 8 位、字符集 32 个且不含 I/L/O/U、20 万枚零碰撞', async () => {
    // ⭐ 2026-10-02：**随机源换成了确定性源**（`tests/helpers/deterministic-bytes.js`）。
    //   ⛔ 原来这里是"从真随机里抽 20 万枚 ⇒ 断言零碰撞"，那是一条**掷骰子**的断言：
    //      码空间 2^40 抽 2×10^5 ⇒ 生日碰撞概率约 **1.8%** ⇒ 完整回归大约每 55 次偶发失败一次，
    //      而失败与代码改动毫无关系（"再跑一次就好"是被这条测试训练出来的坏习惯）。
    //   ✅ 现在：`generate()` 是 5 字节 → 8×5bit 的**双射** ⇒ **互异输入必然产出互异的码**，
    //      "零碰撞"从概率结论变成数学必然；实现一旦丢信息（如 `byte % 32`）立刻变红。
    //      📌 双射性与"每一位全枚举铺满 32 个字符"由 `short-code-determinism.test.js` 单独深挖。
    assert.strictEqual(cloudShort.LENGTH, 8)
    assert.strictEqual(cloudShort.ALPHABET.length, 32, '32 个字符 = 5 bit ⇒ 与算法匹配')
    assert.ok(!/[ILOU]/.test(cloudShort.ALPHABET), '⛔ 字符集不许出现 I/L/O/U（与 1/1/0/V 易混）')
    const seen = new Set()
    const trueRandom = crypto.randomBytes
    withDeterministicBytes(counterSource(1), () => {
      for (let index = 0; index < 200000; index += 1) {
        const code = cloudShort.generate()
        assert.strictEqual(code.length, 8, `长度必须是 8：${code}`)
        assert.ok([...code].every(char => cloudShort.ALPHABET.includes(char)), `出现字符集外的字符：${code}`)
        seen.add(code)
      }
    })
    assert.strictEqual(seen.size, 200000, '20 万个互异输入必须产出 20 万枚互异的码')
    // ⛔ 还原之后才允许再碰真随机（下面 ⑤⑥ 要生成历史长码样本）。
    //    这条不是形式主义：`crypto` 是 Node 模块单例，泄漏会让后续断言在假随机下"永远通过"。
    assert.strictEqual(crypto.randomBytes, trueRandom, '确定性源必须只在坍塌的作用域里生效（必须已还原）')
  })

  // ---------------------------------------------------------------- ③ 每一位都均匀铺满字符集
  await runner('③ 生成**每一位都均匀铺满 32 个字符**（掩码被削窄 / 某一位塌缩都会变红）', async () => {
    // ⚠️ 先澄清一个极容易想当然的点，免得把"要求"写歪：
    //   **对 32 个字符的字符集，`byte % 32` 其实没有偏差**（256 = 8 × 32，整除）。
    //   所以本实现用"位缓冲 + 精确取 5 bit"**不是为了修 `% 32`**，而是为了：
    //     · 熵的用量精确（8 位码 = 40 bit = 恰好 5 字节，不浪费也不短缺）；
    //     · 字符集一旦不是 2 的幂，写法本身仍然是对的（见下面 (b)）。
    //   真正会被 (a) 抓到的两类事故是：①掩码被削窄（`& 31` 写成 `& 15`）②某一位没有用新熵
    //   （把某一枚字符复制 8 遍、或 `bits -= 5` 写错导致同一个 5 bit 被反复取）。
    // ⭐ 与 ② 同理：**随机源换成确定性源** —— 抽样序列每次运行完全一样，
    //    ⇒ "每一位出现次数"不再是随行就市的随机数，±25% 的容差也就不会偶发越界。
    //    （"恰好覆盖 32 个字符"的数学证明在 `short-code-determinism.test.js` ③，那里零随机。）
    const rounds = 40000
    const perPosition = Array.from({ length: 8 }, () => new Map())
    withDeterministicBytes(seededSource(20261002), () => {
      for (let index = 0; index < rounds; index += 1) {
        const code = cloudShort.generate()
        for (let slot = 0; slot < 8; slot += 1) {
          const char = code[slot]
          perPosition[slot].set(char, (perPosition[slot].get(char) || 0) + 1)
        }
      }
    })
    perPosition.forEach((counts, slot) => {
      assert.strictEqual(counts.size, 32,
        `第 ${slot + 1} 位只出现了 ${counts.size} 个字符 ⇒ 这一位的熵没有铺满 32 个字符`)
      const expected = rounds / 32
      const worst = [...counts.entries()].sort((a, b) => Math.abs(b[1] - expected) - Math.abs(a[1] - expected))[0]
      assert.ok(Math.abs(worst[1] - expected) <= expected * 0.25,
        `第 ${slot + 1} 位字符 ${worst[0]} 出现 ${worst[1]} 次，期望约 ${expected.toFixed(0)}（±25%）⇒ 分布可能有偏差`)
    })
    // (a) 反证：掩码从 `& 31` 削成 `& 15` ⇒ 覆盖数立刻腰斩。
    const narrowed = crypto.randomBytes(rounds).map(byte => cloudShort.ALPHABET[byte & 15])
    assert.ok(new Set(narrowed).size <= 16,
      `反证：\`& 15\` 最多只能覆盖 16 个字符（实测 ${new Set(narrowed).size}）⇒ 上面 \`=== 32\` 的断言必然变红`)
    // (b) 反证（说明为什么用位缓冲而不是"字节 % 字符集长度"）：字符集不是 2 的幂时，`% n` 必然让
    //     前 (256 % n) 个字符**多抽到一次**。下面把这 256 个字节**全部枚举**，不留任何随机性。
    const WIDE = 62
    const exact = new Map()
    for (let byte = 0; byte < 256; byte += 1) { const slot = byte % WIDE; exact.set(slot, (exact.get(slot) || 0) + 1) }
    assert.strictEqual(exact.get(0), 5, '反证：`% 62` 下第 0 个字符被抽到 5 次（256 = 4 × 62 + 8）')
    assert.strictEqual(exact.get(WIDE - 1), 4, '反证：末位字符只被抽到 4 次 ⇒ 偏差客观存在且可检出')
    assert.strictEqual(exact.get(0) - exact.get(WIDE - 1), 1,
      '这就是 M3-P2-3 选 32 字符集（2 的幂）而不是 base62 的技术理由')
  })

  // ---------------------------------------------------------------- ④ 误输入纠正
  await runner('④ 归一化：纠正口述误输入（O→0 / I,L→1 / U→V）并忽略空格与连字符', async () => {
    assert.strictEqual(cloudShort.normalize('a1b2c3d4'), 'A1B2C3D4', '大小写不敏感')
    assert.strictEqual(cloudShort.normalize('AB-C1 O234'), 'ABC10234', '连字符与空格忽略；O→0')
    assert.strictEqual(cloudShort.normalize('0I23ABCD'), '0123ABCD', 'I→1')
    assert.strictEqual(cloudShort.normalize('0L23ABCD'), '0123ABCD', 'L→1')
    assert.strictEqual(cloudShort.normalize('0123ABCU'), '0123ABCV', 'U→V')
    assert.strictEqual(cloudShort.normalize('  a1b2 c3d4  '), 'A1B2C3D4')
    assert.strictEqual(cloudShort.isShort('ABC10234'), true)
    assert.strictEqual(cloudShort.isShort('ABC1023'), false, '少一位不算短码')
    assert.strictEqual(cloudShort.isShort('AbCdEf1234567890abc_-xy'), false, '历史 24 位长码不是短码')
  })

  // ---------------------------------------------------------------- ⑤⛔ 长码一个字符都不许被改写
  await runner('⑤⛔ 归一化**绝不改写历史长码**（base64url 区分大小写，一旦大写就再也兑换不了）', async () => {
    const legacy = 'AbCdEf1234567890abc_-xy'
    assert.strictEqual(cloudShort.normalize(legacy), legacy, '长度不是 8 ⇒ 只 trim，原样返回')
    // 历史认领码就是 `randomBytes(18).toString('base64url')` 的形状：含大小写与 `-` `_`。
    const sample = crypto.randomBytes(18).toString('base64url')
    assert.strictEqual(sample.length, 24, '历史认领码是 24 位')
    assert.strictEqual(memberShort.normalize(sample), sample, '⛔ 历史码必须原样通过（大写化等于把老码全废掉）')
    const upper = crypto.randomBytes(18).toString('base64url').toUpperCase()
    assert.strictEqual(memberShort.normalize(` ${upper} `), upper, '只去首尾空白')
  })

  // ---------------------------------------------------------------- ⑥ 共享码：新 8 位 + 旧 10 位都收
  await runner('⑥ 共享码：生成为 8 位短码；归一化同时接受**新 8 位**与**旧 10 位十六进制**', async () => {
    for (let index = 0; index < 2000; index += 1) {
      const code = sharing.newShareCode()
      assert.strictEqual(code.length, 8, `共享码必须是 8 位：${code}`)
      assert.ok([...code].every(char => cloudShort.ALPHABET.includes(char)), `共享码出现 I/L/O/U：${code}`)
    }
    // 旧口径：`randomBytes(5).toString('hex').toUpperCase()` = 10 位十六进制 ⇒ 必须**继续可兑换**。
    const legacy = crypto.randomBytes(5).toString('hex').toUpperCase()
    assert.strictEqual(legacy.length, 10)
    assert.strictEqual(sharing.normalizeShareCode(legacy.toLowerCase()), legacy, '旧码大小写不敏感且原样通过')
    assert.strictEqual(sharing.normalizeShareCode(sharing.newShareCode().toLowerCase()).length, 8)
    // 口述误输入在共享码这一侧同样被救回。
    assert.strictEqual(sharing.normalizeShareCode('ab-c1 o234'), 'ABC10234')
    assert.throws(() => sharing.normalizeShareCode('太短'), /共享码格式无效/)
    assert.throws(() => sharing.normalizeShareCode(''), /共享码格式无效/)
  })

  // ---------------------------------------------------------------- ⑦ 主键口径与环境隔离不变
  await runner('⑦ 主键口径与环境隔离**一个字没改**（旧共享码因此不需要任何迁移）', async () => {
    assert.strictEqual(sharing.SHARE_COLLECTIONS.sandbox, SHARES)
    assert.strictEqual(sharing.SHARE_COLLECTIONS.production, 'coach_package_shares')
    assert.strictEqual(sharing.shareCollection('sandbox'), SHARES)
    assert.strictEqual(sharing.shareCollection('production'), 'coach_package_shares')
    assert.strictEqual(sharing.shareCollection(undefined), 'coach_package_shares')
    // 同一枚码永远推出同一个文档 id（hash 公式没动）⇒ 老码指向的还是老那条记录。
    const code = 'ABC10234'
    assert.strictEqual(sharing.shareIdFor(code), core.fixedId('coach-package-share', code))
    // 正则仍然是"6–32 位大写字母数字" ⇒ 8 位短码与 10 位旧码都落在里面。
    assert.ok(sharing.SHARE_CODE_PATTERN.test('ABC10234'))
    assert.ok(sharing.SHARE_CODE_PATTERN.test('A1B2C3D4E5'))
  })

  // ---------------------------------------------------------------- ⑧ 端到端：认领码是 8 位 + 15 分钟
  await runner('⑧ 端到端：`createClaimToken` 产出 8 位短码，有效期仍是 15 分钟', async () => {
    setup()
    const issued = await issueClaimToken()
    assert.strictEqual(issued.ok, true, JSON.stringify(issued))
    assert.strictEqual(String(issued.claimToken).length, 8, `认领码必须是 8 位，实际：${issued.claimToken}`)
    assert.ok([...String(issued.claimToken)].every(char => cloudShort.ALPHABET.includes(char)))
    assert.strictEqual(issued.expiresAt, STAMP + FIFTEEN_MINUTES, '有效期口径不变')
    const row = tokenRows()[0]
    assert.strictEqual(row.tokenHash, sha(`claim:${issued.claimToken}`), '服务端存的仍是码的 sha256（码本身不落库）')
    assert.strictEqual(row.status, 'available')
    assert.strictEqual(row.expiresAt, STAMP + FIFTEEN_MINUTES)
    assert.ok(!JSON.stringify(row).includes(issued.claimToken), '⛔ 明文码不许落库')
  })

  // ---------------------------------------------------------------- ⑨ 端到端：新码可兑换
  await runner('⑨ 端到端：8 位短码可以正常兑换（认领成功、码变成已用）', async () => {
    setup()
    const issued = await issueClaimToken()
    const result = await claimWith(issued.claimToken)
    assert.strictEqual(result.ok, true, JSON.stringify(result))
    assert.strictEqual(result.coachId, A.owner)
    assert.strictEqual(result.studentId, 'stu-1')
    assert.strictEqual(tokenRows()[0].status, 'used', '码用掉后必须变 used')
    assert.strictEqual(tokenRows()[0].usedByMemberId, identity.memberIdFor(MEMBER_OPEN))
  })

  // ---------------------------------------------------------------- ⑩⛔ 历史长码继续可兑换
  await runner('⑩⛔ 历史 **24 位长码仍然可以兑换**（不需要任何数据迁移，也不许让老码失效）', async () => {
    setup()
    // 按**旧口径**造一枚码并落库（模拟老版本已经发出去、用户手上还拿着的那一枚）。
    const legacy = crypto.randomBytes(18).toString('base64url')
    const legacyHash = sha(`claim:${legacy}`)
    world.put(CLAIM_TOKENS, identity.fixedId(CLAIM_TOKENS, legacyHash), {
      tokenHash: legacyHash, coachId: A.owner, studentId: 'stu-1', datasetIdAtIssue: 'ds-1',
      status: 'available', expiresAt: STAMP + FIFTEEN_MINUTES, createdAt: STAMP
    })
    const result = await claimWith(legacy)
    assert.strictEqual(result.ok, true, `历史长码必须继续可用：${JSON.stringify(result)}`)
    assert.strictEqual(result.studentId, 'stu-1')
    // 前后带空格也要能救回来（用户复制粘贴的常见形态）。
    assert.strictEqual(memberShort.normalize(` ${legacy} `), legacy)
  })

  // ---------------------------------------------------------------- ⑪⛔ 认领码查重
  await runner('⑪⛔ 认领码**查重**：撞上已存在的码时必须换一枚，绝不覆盖（静默覆盖 = 越权级事故）', async () => {
    setup()
    const forced = 'ABC10234'
    const forcedHash = sha(`claim:${forced}`)
    world.put(CLAIM_TOKENS, identity.fixedId(CLAIM_TOKENS, forcedHash), {
      tokenHash: forcedHash, coachId: 'other-coach', studentId: 'stu-other', datasetIdAtIssue: 'ds-other',
      status: 'available', expiresAt: STAMP + FIFTEEN_MINUTES, createdAt: STAMP
    })
    // ⚠️ 关键：只让**第一次**撞码，之后必须放行 —— 否则就是把"连撞 5 次该报错"误当成了缺陷。
    const restore = fakeGenerate(memberShort, [forced, 'ZZZZ9999'])
    let issued
    try { issued = await issueClaimToken() } finally { restore() }
    assert.strictEqual(issued.ok, true, '撞码后必须能换一枚继续，而不是失败或覆盖')
    assert.strictEqual(issued.claimToken, 'ZZZZ9999', '★ 应当换到第二枚（说明它确实**重试了生成**，而不是硬用那一枚）')
    assert.notStrictEqual(issued.claimToken, forced, '★ 绝不能把已存在的那枚码再发一次')
    const kept = world.stores[CLAIM_TOKENS].get(identity.fixedId(CLAIM_TOKENS, forcedHash))
    assert.strictEqual(kept.coachId, 'other-coach', '★ 已存在那条必须**原封不动**（撞码时绝不许覆盖）')
    assert.strictEqual(kept.studentId, 'stu-other')
    assert.strictEqual(tokenRows().length, 2, '两条并存')
  })

  // ---------------------------------------------------------------- ⑪b⛔ 连撞 5 次必须报错，而不是覆盖
  await runner('⑪b⛔ 认领码**连撞 5 次**：必须抛 CLAIM_CODE_COLLISION，绝不覆盖，也不许悄悄发一枚重复的', async () => {
    setup()
    const forced = 'ABC10234'
    const forcedHash = sha(`claim:${forced}`)
    const before = {
      tokenHash: forcedHash, coachId: 'other-coach', studentId: 'stu-other', datasetIdAtIssue: 'ds-other',
      status: 'available', expiresAt: STAMP + FIFTEEN_MINUTES, createdAt: STAMP
    }
    world.put(CLAIM_TOKENS, identity.fixedId(CLAIM_TOKENS, forcedHash), { ...before })
    // 生成器被钉死在同一枚 ⇒ 5 次重试必然全部撞上。
    const restore = fakeGenerate(memberShort, [forced])
    let issued
    try { issued = await issueClaimToken() } finally { restore() }
    assert.strictEqual(issued.ok, false, '撞满次数必须是**失败**，而不是成功')
    assert.strictEqual(issued.code, 'CLAIM_CODE_COLLISION', JSON.stringify(issued))
    const kept = world.stores[CLAIM_TOKENS].get(identity.fixedId(CLAIM_TOKENS, forcedHash))
    // ⚠️ 只剥掉假世界自己记账用的 `_id`，其余字段必须**逐一相等**（连多出来的字段也要被抓到）。
    const { _id: ignoredId, ...keptFields } = kept
    assert.deepStrictEqual(keptFields, before, '★ 那条老码必须一个字段都没被动过')
    assert.strictEqual(kept.coachId, 'other-coach', '★ 尤其不许被改写指向别的教练')
    assert.strictEqual(kept.studentId, 'stu-other', '★ 更不许被改指向本次要发码的 stu-1')
    assert.strictEqual(tokenRows().length, 1, '★ 失败时不许留下任何新行')
  })

  // ---------------------------------------------------------------- ⑫⛔ 共享码查重
  await runner('⑫⛔ 共享码**查重**：撞上已存在的码时必须换一枚，绝不覆盖（旧码不许偷偷改指向）', async () => {
    setup()
    const forced = 'DEFG5678'
    world.put(SHARES, sharing.shareIdFor(forced), {
      shareCode: forced, ownerCoachId: 'other-coach', datasetId: 'ds-other',
      packageId: 'pkg-other', studentId: 'stu-other', status: sharing.SHARE_ACTIVE, createdAt: STAMP
    })
    const restore = fakeGenerate(cloudShort, [forced, 'ZZZZ9999'])
    let result
    try { result = await world.execute(A, 'setPackageShare', { packageId: 'pkg-1', enabled: true }) } finally { restore() }
    assert.strictEqual(result.ok, true, JSON.stringify(result))
    assert.strictEqual(result.result.shared, true)
    assert.strictEqual(result.result.shareCode, 'ZZZZ9999', '★ 应当换到第二枚（说明它确实**重试了生成**）')
    assert.notStrictEqual(result.result.shareCode, forced, '★ 绝不能把已存在的那枚码再发一次')
    assert.strictEqual(String(result.result.shareCode).length, 8)
    const kept = world.stores[SHARES].get(sharing.shareIdFor(forced))
    assert.strictEqual(kept.ownerCoachId, 'other-coach', '★ 已存在那条必须**原封不动**')
    assert.strictEqual(kept.packageId, 'pkg-other')
    assert.strictEqual(shareRows().length, 2)
    // 新旧码共存：新码指向 pkg-1，旧码仍指向 pkg-other（谁都没被顶掉）。
    const fresh = shareRows().find(row => row.shareCode === result.result.shareCode)
    assert.strictEqual(fresh.packageId, 'pkg-1')
    assert.strictEqual(fresh.status, sharing.SHARE_ACTIVE)
    assert.strictEqual(fresh.datasetId, A.datasetId)
  })

  // ---------------------------------------------------------------- ⑫b⛔ 连撞 5 次必须报错
  await runner('⑫b⛔ 共享码**连撞 5 次**：必须抛 SHARE_CODE_COLLISION，且那条旧许可一个字段都不许动', async () => {
    setup()
    const forced = 'DEFG5678'
    const before = {
      shareCode: forced, ownerCoachId: 'other-coach', datasetId: 'ds-other',
      packageId: 'pkg-other', studentId: 'stu-other', status: sharing.SHARE_ACTIVE, createdAt: STAMP
    }
    world.put(SHARES, sharing.shareIdFor(forced), { ...before })
    const restore = fakeGenerate(cloudShort, [forced])
    let result
    try { result = await world.execute(A, 'setPackageShare', { packageId: 'pkg-1', enabled: true }) } finally { restore() }
    assert.strictEqual(result.ok, false, `撞满次数必须是**失败**：${JSON.stringify(result)}`)
    assert.strictEqual(result.code, 'SHARE_CODE_COLLISION', JSON.stringify(result))
    const kept = world.stores[SHARES].get(sharing.shareIdFor(forced))
    // ⚠️ 同样只剥掉假世界的 `_id` 记账字段，其余必须**逐一相等**。
    const { _id: ignoredShareId, ...keptFields } = kept
    assert.deepStrictEqual(keptFields, before,
      '★ 旧许可必须一个字段都没被动过（更不许把它的 packageId 改指向 pkg-1）')
    assert.strictEqual(kept.packageId, 'pkg-other', '★ 旧码绝不许偷偷改指向本次要共享的 pkg-1')
    assert.strictEqual(kept.ownerCoachId, 'other-coach')
    assert.strictEqual(shareRows().length, 1, '★ 失败时不许留下任何新行')
  })

  // ---------------------------------------------------------------- ⑬ 口述误输入可救回
  await runner('⑬ 端到端：把码念错（O/I/L/U）或敲进空格，仍能兑换成功', async () => {
    setup()
    const forced = '0123ABCD'
    const restore = fakeGenerate(memberShort, [forced])
    let issued
    try { issued = await issueClaimToken() } finally { restore() }
    assert.strictEqual(issued.claimToken, forced)
    // 用户听到「零一二三 A B C D」，敲成 `O123 ABCD` —— O 被听成字母 O、中间多了个空格。
    const result = await claimWith('O123 ABCD')
    assert.strictEqual(result.ok, true, `口述误输入必须被救回：${JSON.stringify(result)}`)
    assert.strictEqual(result.studentId, 'stu-1')
  })

  // ---------------------------------------------------------------- ⑭ 判别力自检
  await runner('⑭ 反证：把生成器退回"10 位十六进制"⇒ ②⑥ 的断言必然变红（说明它们有判别力）', async () => {
    const legacyGenerator = () => crypto.randomBytes(5).toString('hex').toUpperCase()
    for (let index = 0; index < 200; index += 1) {
      const code = legacyGenerator()
      if (code.length !== 8 || /[ILOU]/.test(code) === false) { /* 正常：旧码会命中任一条件 */ }
    }
    const sample = legacyGenerator()
    assert.strictEqual(sample.length, 10, '旧口径是 10 位 ⇒ ② 的长度断言会红')
    // 旧码里可能出现 I/L/O/U 吗？hex 只有 0-9A-F ⇒ 不会；所以"字符集"那条抓不到它，
    // 真正抓到旧口径的是**长度**（② 与 ⑥ 都钉了 8）。
    const randomHex = Array.from({ length: 200 }, () => legacyGenerator())
    assert.ok(randomHex.every(code => code.length === 10), '反证：旧口径 100% 是 10 位 ⇒ 长度断言必然变红')
  })
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1 })
