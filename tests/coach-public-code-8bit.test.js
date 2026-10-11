// 教练公开码 8 位 Crockford 专项回归（M3-P2-3 收尾，2026-09-30）
//
// ⛔ 为什么单独成文件：这条不变量在 §134 被**测口径错当成"共享码 8 位"**而漏掉，
//    真机事实是教练公开码当时仍是 10 位 fixedId 切片。本文件把它钉死成 12 条有判别力的断言。
//
// 覆盖（与需求逐条对应，每条都能抓回归）：
//   ① 新教练拿到 **8 位**码
//   ② 字符只在 Crockford 字符集内（无 I / L / O / U）
//   ③ 已有 **10 位** 旧码（fixedId 切片）重存不变 —— 旧码继续兼容
//   ④ Sandbox 预置 **TEST-xxxxxx** 兼容（保留原样，不重新生成）
//   ⑤ 撞码自动换一枚（同一事务内查重，绝不静默覆盖别人）
//   ⑥ 连撞 5 次 ⇒ 抛 **COACH_PUBLIC_CODE_COLLISION**（不全盘失败也不无限重试）
//   ⑦ 撞码**绝不覆盖别人的码**（别人的档案不被改写）
//   ⑧ 客户端伪造 publicCode **被忽略**（服务端生成，不信任客户端传来的码）
//   ⑨ 新生成的 8 位码能被授权模块按码找回教练
//   ⑩ 旧 10 位码仍能按码找回教练（兼容回读）
//   ⑪ 重进页面（再发一次 publish / 读 coachMetadata）显示**同一**枚码
//   ⑫ 反证：把"保留原码"改成"每次都重新生成"的漂移版，稳定性断言必须当场失败（证明本条不是测空气）

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createService: identityService, coachIdFor, fixedId, names: memberNames } = require('../cloudfunctions/memberIdentityCommand/service')
const authorizationModule = require('../cloudfunctions/coachBusinessCommand/authorization')
const shortCode = require('../cloudfunctions/memberIdentityCommand/short-code')

const ALPHABET = shortCode.ALPHABET
const LENGTH = shortCode.LENGTH
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const matches = (row, query) => Object.keys(query).every(key => row[key] === query[key])

// —— 严格假 DB（与 member-identity-put-contract 同一套真机 -501007 契约复刻）——
function strictCloud() {
  const stores = {}
  let openId = 'coach-a', now = 1700000000000
  function scope(target) {
    return {
      collection(name) {
        const store = target[name] || (target[name] = new Map())
        return {
          doc(id) {
            return {
              async set({ data }) {
                if (data && Object.prototype.hasOwnProperty.call(data, '_id')) throw new Error('document.set:fail -501007 invalid parameters. 不能更新_id的值')
                if (data && Object.prototype.hasOwnProperty.call(data, 'documentId')) throw new Error('invalid parameters. 不能写入 documentId')
                store.set(id, { ...copy(data), _id: id })
                return { _id: id, updated: store.has(id) }
              },
              async remove() { store.delete(id); return { stats: { removed: 1 } } }
            }
          },
          where(query) {
            let skip = 0, limit = 100
            const api = {
              skip(n) { skip = n; return api }, limit(n) { limit = n; return api },
              async get() { return { data: [...store.values()].filter(row => matches(row, query)).slice(skip, skip + limit).map(copy) } }
            }
            return api
          }
        }
      },
      async runTransaction(work) {
        const draft = {}
        Object.keys(target).forEach(name => { draft[name] = new Map([...target[name]].map(([k, v]) => [k, copy(v)])) })
        const result = await work(scope(draft))
        Object.keys(draft).forEach(name => target[name] = draft[name])
        return result
      }
    }
  }
  const db = scope(stores)
  return {
    stores, db, setOpenId: value => { openId = value }, getOpenId: () => openId, now: () => ++now,
    rows(name) { return [...(stores[name] || new Map()).values()].map(copy) },
    put(name, id, row) { (stores[name] || (stores[name] = new Map())).set(id, { ...copy(row), _id: id }) }
  }
}

const identity = (cloud, factory = identityService) => factory({ db: cloud.db, getOpenId: cloud.getOpenId, now: cloud.now })
async function publish(cloud, displayName, opts = {}) {
  const { environment = 'production', tag = 'pub', payload = {}, factory = identityService } = opts
  const svc = identity(cloud, factory)
  const meta = await svc({ action: 'coachMetadata', environment })
  assert.strictEqual(meta.ok, true, `coachMetadata 失败 ${JSON.stringify(meta)}`)
  return svc({
    action: 'coachExecute', command: 'publishCoachProfile',
    payload: Object.assign({ displayName }, payload),
    expectedRevision: meta.coachRevision, environment,
    requestId: `${tag}_${environment}_${String(Math.random()).slice(2)}`
  })
}
function seedCoach(cloud, openId, datasetId, opts = {}) {
  const { environment = 'production', publicCode } = opts
  const coachId = coachIdFor(openId)
  cloud.put('coaches', coachId, { openId, status: 'active' })
  if (environment === 'sandbox') cloud.put('coach_sandbox_heads', fixedId('coach-sandbox-head', coachId), { ownerCoachId: coachId, environment: 'sandbox', activeDatasetId: datasetId })
  else cloud.put('coach_data_heads', fixedId('coach-data-head', coachId), { ownerCoachId: coachId, activeDatasetId: datasetId })
  if (publicCode) {
    const n = memberNames(environment)
    cloud.put(n.profiles, fixedId(n.profiles, coachId), { coachId, publicCode, displayName: `教练${publicCode}`, discoverable: true })
  }
  return { openId, coachId, datasetId, environment }
}
const OLD_TEN = coachId => fixedId('coach-public', coachId).slice(0, 10)   // 历史 10 位推导（必须继续兼容）

// ⭐ 判别力反证：把"保留原码"这一行改成"每次都重新生成"，加载一份**漂移版**服务。
// ⛔ 反证安全化（2026-10-04）：漂移版只在**内存里编译成模块**（require.cache 注入），
//    不再 writeFileSync 落盘到 cloudfunctions 目录 —— 磁盘正式源码一个字节都不动。
function loadDriftService() {
  const Module = require('module')
  const servicePath = path.join(__dirname, '..', 'cloudfunctions', 'memberIdentityCommand', 'service.js')
  const source = fs.readFileSync(servicePath, 'utf8')
  const from = "let publicCode = (existing && existing.publicCode) ? String(existing.publicCode) : ''"
  const to = "let publicCode = ''"
  assert.ok(source.includes(from), '漂移变异锚点没找到 —— 主代码分支可能已改，请同步更新反证锚点')
  const driftSource = source.replace(from, to)
  // 虚拟路径：与 service.js 同目录（保证漂移版内部 require('./member-contract') 等仍能解析），但不落盘
  const driftPath = path.join(path.dirname(servicePath), '_drift_probe.js')
  const mod = new Module(driftPath, module)
  mod.filename = driftPath
  mod.paths = Module._nodeModulePaths(path.dirname(driftPath))
  require.cache[driftPath] = mod
  mod._compile(driftSource, driftPath)
  mod.loaded = true
  return { factory: mod.exports.createService, driftPath }
}

async function test(name, fn) {
  try { await fn(); process.stdout.write(`PASS ${name}\n`) }
  catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}

;(async () => {
  // ① 新教练拿到 8 位码
  await test('① 新教练首次发布拿到 8 位公开码', async () => {
    const cloud = strictCloud(), coach = seedCoach(cloud, 'coach-a', 'ds-a')
    cloud.setOpenId(coach.openId)
    const result = await publish(cloud, 'A教练')
    assert.strictEqual(result.ok, true, JSON.stringify(result))
    assert.strictEqual(typeof result.publicCode, 'string')
    assert.strictEqual(result.publicCode.length, LENGTH, `公开码必须是 ${LENGTH} 位（实测 ${result.publicCode.length}）`)
  })

  // ② 字符只在 Crockford 字符集内（多生成几枚，覆盖随机性）
  await test('② 生成的公开码字符全部在 Crockford 字符集内（无 I/L/O/U）', async () => {
    const seen = []
    for (let i = 0; i < 30; i += 1) {
      const cloud = strictCloud(), coach = seedCoach(cloud, `coach-gen-${i}`, `ds-${i}`)
      cloud.setOpenId(coach.openId)
      const result = await publish(cloud, `教练${i}`)
      assert.strictEqual(result.publicCode.length, LENGTH)
      for (const char of result.publicCode) {
        assert.ok(ALPHABET.includes(char), `出现非法字符 ${char}（不允许 I/L/O/U）`)
      }
      seen.push(result.publicCode)
    }
    // 30 枚里应当出现至少几个不同字符的多样性（不是只发同一枚）
    const chars = new Set(seen.join('').split(''))
    assert.ok(chars.size >= 8, `字符多样性不足（只出现 ${chars.size} 种）`)
  })

  // ③ 已有 10 位旧码重存不变
  await test('③ 已有 10 位旧码（fixedId 切片）重存不变', async () => {
    const cloud = strictCloud(), coach = seedCoach(cloud, 'coach-a', 'ds-a')
    cloud.setOpenId(coach.openId)
    const old10 = OLD_TEN(coach.coachId)
    seedCoach(cloud, 'coach-a', 'ds-a', { publicCode: old10 })   // 预置旧 10 位码
    const first = await publish(cloud, 'A教练')
    assert.strictEqual(first.publicCode, old10, '重存必须保留旧 10 位码，不得重新生成')
    const again = await publish(cloud, 'A教练改名')
    assert.strictEqual(again.publicCode, old10, '再次保存也不得换码')
  })

  // ④ Sandbox 预置 TEST-xxxxxx 兼容
  await test('④ Sandbox 预置 TEST-xxxxxx 原样保留（不重新生成 8 位）', async () => {
    const cloud = strictCloud(), coach = seedCoach(cloud, 'coach-b', 'ds-b', { environment: 'sandbox', publicCode: 'TEST-443c4d' })
    cloud.setOpenId(coach.openId)
    const result = await publish(cloud, 'B教练', { environment: 'sandbox', tag: 'sb' })
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.publicCode, 'TEST-443c4d', 'Sandbox 预置 TEST-xxxxxx 必须原样保留')
    // 仍写在 sandbox 集合
    const n = memberNames('sandbox')
    const rows = cloud.rows(n.profiles)
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].publicCode, 'TEST-443c4d')
  })

  // ⑤ 撞码自动换一枚
  await test('⑤ 生成撞上别人的码时自动换一枚（不静默覆盖）', async () => {
    const realGenerate = shortCode.generate
    try {
      const cloud = strictCloud()
      // 先放一位已有码 EXISTING1 的教练
      const other = seedCoach(cloud, 'coach-other', 'ds-o', { publicCode: 'EXISTING1' })
      cloud.setOpenId(other.openId); await publish(cloud, 'Other', { tag: 'o' })
      // 让生成器第一枚返回被占用的 EXISTING1，第二枚返回空的 FREE0001
      const seq = ['EXISTING1', 'FREE0001']
      shortCode.generate = () => seq.shift() || realGenerate()
      const coach = seedCoach(cloud, 'coach-new', 'ds-n')
      cloud.setOpenId(coach.openId)
      const result = await publish(cloud, 'New', { tag: 'n' })
      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.publicCode, 'FREE0001', '撞码后必须换一枚空闲码')
      assert.notStrictEqual(result.publicCode, 'EXISTING1')
    } finally { shortCode.generate = realGenerate }
  })

  // ⑥ 连撞 5 次 ⇒ COACH_PUBLIC_CODE_COLLISION
  await test('⑥ 连撞 5 次抛出 COACH_PUBLIC_CODE_COLLISION（不无限重试）', async () => {
    const realGenerate = shortCode.generate
    try {
      const cloud = strictCloud()
      const other = seedCoach(cloud, 'coach-other', 'ds-o', { publicCode: 'TAKEN000' })
      cloud.setOpenId(other.openId); await publish(cloud, 'Other', { tag: 'o' })
      shortCode.generate = () => 'TAKEN000'   // 永远撞同一枚
      const coach = seedCoach(cloud, 'coach-new', 'ds-n')
      cloud.setOpenId(coach.openId)
      const result = await publish(cloud, 'New', { tag: 'n' })
      assert.strictEqual(result.ok, false, '连撞 5 次必须失败')
      assert.strictEqual(result.code, 'COACH_PUBLIC_CODE_COLLISION', `必须抛出专属碰撞码（实测 ${result.code}）`)
    } finally { shortCode.generate = realGenerate }
  })

  // ⑦ 撞码绝不覆盖别人的码
  await test('⑦ 撞码流程下别人的档案不被改写', async () => {
    const realGenerate = shortCode.generate
    try {
      const cloud = strictCloud()
      const other = seedCoach(cloud, 'coach-other', 'ds-o', { publicCode: 'EXISTING1' })
      cloud.setOpenId(other.openId); await publish(cloud, 'Other', { tag: 'o' })
      const seq = ['EXISTING1', 'FREE0001']
      shortCode.generate = () => seq.shift() || realGenerate()
      const coach = seedCoach(cloud, 'coach-new', 'ds-n')
      cloud.setOpenId(coach.openId)
      await publish(cloud, 'New', { tag: 'n' })
      const n = memberNames('production')
      const otherRow = cloud.rows(n.profiles).find(r => r.coachId === other.coachId)
      assert.strictEqual(otherRow.publicCode, 'EXISTING1', '别人的码必须原封不动')
      const newRow = cloud.rows(n.profiles).find(r => r.coachId === coach.coachId)
      assert.strictEqual(newRow.publicCode, 'FREE0001', '自己的码是换出来的空闲码')
    } finally { shortCode.generate = realGenerate }
  })

  // ⑧ 客户端伪造 publicCode 被忽略
  await test('⑧ 客户端传来的 publicCode 被忽略（服务端生成，不信任客户端）', async () => {
    const cloud = strictCloud(), coach = seedCoach(cloud, 'coach-a', 'ds-a')
    cloud.setOpenId(coach.openId)
    const result = await publish(cloud, 'A教练', { payload: { publicCode: 'EVIL9999' } })
    assert.strictEqual(result.ok, true)
    assert.notStrictEqual(result.publicCode, 'EVIL9999', '服务端不得采用客户端指定的码')
    assert.strictEqual(result.publicCode.length, LENGTH, '服务端仍生成 8 位合法码')
    // 不存在任何以 EVIL9999 为码的档案
    const n = memberNames('production')
    assert.ok(!cloud.rows(n.profiles).some(r => r.publicCode === 'EVIL9999'))
  })

  // ⑨ 新码被授权模块按码找回
  await test('⑨ 新生成的 8 位码能被授权模块 coachIdsByPublicCodes 找回教练', async () => {
    const cloud = strictCloud(), coach = seedCoach(cloud, 'coach-b', 'ds-b')
    cloud.setOpenId(coach.openId)
    const published = await publish(cloud, 'B教练')
    const auths = authorizationModule.authScope(cloud.db, 'production')
    const found = await authorizationModule.coachIdsByPublicCodes(auths, [published.publicCode])
    assert.strictEqual(found.length, 1, `按码找回必须命中（${published.publicCode}）`)
    assert.strictEqual(found[0].coachId, coach.coachId)
  })

  // ⑩ 旧 10 位码仍能按码找回（兼容回读）
  await test('⑩ 旧 10 位码仍能按码找回教练（兼容回读）', async () => {
    const cloud = strictCloud(), coach = seedCoach(cloud, 'coach-a', 'ds-a')
    cloud.setOpenId(coach.openId)
    const old10 = OLD_TEN(coach.coachId)
    seedCoach(cloud, 'coach-a', 'ds-a', { publicCode: old10 })
    const published = await publish(cloud, 'A教练')
    assert.strictEqual(published.publicCode, old10, '重存保留旧 10 位码')
    const auths = authorizationModule.authScope(cloud.db, 'production')
    const found = await authorizationModule.coachIdsByPublicCodes(auths, [old10])
    assert.strictEqual(found.length, 1, `旧 10 位码必须仍能找回（${old10}）`)
    assert.strictEqual(found[0].coachId, coach.coachId)
  })

  // ⑪ 重进页面显示同一枚码
  await test('⑪ 重进（再发 publish / 读 coachMetadata）显示同一枚码', async () => {
    const cloud = strictCloud(), coach = seedCoach(cloud, 'coach-a', 'ds-a')
    cloud.setOpenId(coach.openId)
    const first = await publish(cloud, 'A教练')
    // 模拟重进：先读 coachMetadata 看回读是否一致
    const svc = identity(cloud)
    const meta = await svc({ action: 'coachMetadata', environment: 'production' })
    assert.strictEqual(meta.profile && meta.profile.publicCode, first.publicCode, 'coachMetadata 回读必须同码')
    // 再发一次 publish（模拟再次保存/重进保存）
    const again = await publish(cloud, 'A教练', { tag: 'again' })
    assert.strictEqual(again.publicCode, first.publicCode, '再次发布不得换码')
  })

  // ⑫ 反证：漂移版（每次重新生成）必须被稳定性断言抓住
  await test('⑫ 反证：漂移版每次重新生成必须被稳定性断言抓住（证明 ⑪ 不是测空气）', async () => {
    const { factory, driftPath } = loadDriftService()
    try {
      const cloud = strictCloud(), coach = seedCoach(cloud, 'coach-drift', 'ds-d')
      cloud.setOpenId(coach.openId)
      const d1 = await publish(cloud, 'D教练', { factory, tag: 'd1' })
      const d2 = await publish(cloud, 'D教练2', { factory, tag: 'd2' })
      // 漂移版应当真的会换码
      assert.notStrictEqual(d2.publicCode, d1.publicCode, '漂移版实现确实每次换码（反证前提成立）')
      // 对它跑与 ⑪ 完全相同的稳定性断言，必须**失败** ⇒ 证明 ⑪ 不是在测空气
      let caught = false
      try { assert.strictEqual(d2.publicCode, d1.publicCode, '漂移版应当被稳定性断言抓住') } catch (e) { caught = true }
      assert.ok(caught, '反证失败：稳定性断言没能抓住"每次重新生成"的回归 —— ⑪ 在测空气')
    } finally {
      // ⛔ 漂移版没有落盘 ⇒ 只需把注入的模块从 require.cache 里摘掉
      if (driftPath) delete require.cache[driftPath]
    }
  })

  if (!process.exitCode) process.stdout.write('ALL COACH PUBLIC CODE 8-BIT TESTS PASSED\n')
})().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
