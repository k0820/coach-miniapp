// memberIdentityCommand 写入契约永久回归（2026-09-28，-501007 真机事故）。
//
// ★★ 事故回顾 ★★
//   真机保存公开教练卡报 `document.set:fail -501007 invalid parameters. 不能更新_id的值`。
//   根因：`put()` 把 `_id` 塞进 `doc(id).set()` 的 data —— CloudBase 禁止 data 覆盖系统字段 `_id`。
//   旧假 DB 是**宽松**的（set 什么都不校验，照单全收）⇒ 坏写法在自动测试里永远绿，真机才炸。
//
// ★★ 本文件的核心：**严格假 DB**（真机参数契约的复刻）★★
//   · `doc(id).set({data})`：data 里有 `_id` ⇒ **当场 throw**（与真机 -501007 同文）；
//   · 文档按平铺存储 `{_id: id, ...data}`（_id 是系统字段，与真机一致）；
//   · `where()` 匹配顶层字段（含 `_id`，真机可查）。
//   ⇒ 任何"把 _id 写进 data"的回归都在这里当场变红，不再依赖真机兜底。
//
// 覆盖：A 首次发布 · B 改名再存 · C 重复保存码不漂移 · D 两教练独立公开卡 ·
//       E Sandbox/Production 集合隔离 · F data 不许带 _id（严格 DB + 显式断言）·
//       G 公开码能被 M2 V1 授权模块识别 · H 集合名与授权模块逐字一致。

const assert = require('assert')
const { createService: identityService, coachIdFor, fixedId } = require('../cloudfunctions/memberIdentityCommand/service')
const authorizationModule = require('../cloudfunctions/coachBusinessCommand/authorization')
const { collectionsFor } = authorizationModule
const { names: memberNames } = require('../cloudfunctions/memberIdentityCommand/service')

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const matches = (row, query) => Object.keys(query).every(key => row[key] === query[key])
const ID_IN_DATA = 'document.set:fail -501007 invalid parameters. 不能更新_id的值'

// —— 严格假 DB：真机写入契约的复刻 ——
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
                // ⭐ 契约①：data 不许携带系统字段 _id（真机 -501007 的复刻）。
                if (data && Object.prototype.hasOwnProperty.call(data, '_id')) throw new Error(ID_IN_DATA)
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
              skip(n) { skip = n; return api },
              limit(n) { limit = n; return api },
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
    // 与严格 DB 同一套契约的种子写入（绕过 set 的 data 检查没有意义：种子本来就不带 _id）
    put(name, id, row) { (stores[name] || (stores[name] = new Map())).set(id, { ...copy(row), _id: id }) }
  }
}

const identity = cloud => identityService({ db: cloud.db, getOpenId: cloud.getOpenId, now: cloud.now })
async function publish(cloud, displayName, environment = 'production', tag = 'pub') {
  const svc = identity(cloud)
  const meta = await svc({ action: 'coachMetadata', environment })
  assert.strictEqual(meta.ok, true, `coachMetadata 失败 ${JSON.stringify(meta)}`)
  return svc({ action: 'coachExecute', command: 'publishCoachProfile', payload: { displayName }, expectedRevision: meta.coachRevision, environment, requestId: `${tag}_${environment}_${String(Math.random()).slice(2)}` })
}
function seedCoach(cloud, openId, datasetId, environment = 'production') {
  const coachId = coachIdFor(openId)
  cloud.put('coaches', coachId, { openId, status: 'active' })
  if (environment === 'sandbox') cloud.put('coach_sandbox_heads', fixedId('coach-sandbox-head', coachId), { ownerCoachId: coachId, environment: 'sandbox', activeDatasetId: datasetId })
  else cloud.put('coach_data_heads', fixedId('coach-data-head', coachId), { ownerCoachId: coachId, activeDatasetId: datasetId })
  return { openId, coachId, datasetId }
}

async function test(name, fn) {
  try { await fn(); process.stdout.write(`PASS ${name}\n`) } catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}

;(async () => {
  // ————— A：首次发布公开教练卡成功
  await test('A：首次发布公开教练卡成功（创建路径，data 不带 _id）', async () => {
    const cloud = strictCloud(), coach = seedCoach(cloud, 'coach-a', 'ds-a')
    cloud.setOpenId(coach.openId)
    const result = await publish(cloud, 'A教练')
    assert.strictEqual(result.ok, true, JSON.stringify(result))
    assert.ok(result.publicCode, '必须返回公开码')
    const rows = cloud.rows('member_coach_profiles')
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].coachId, coach.coachId, 'coachId 只能来自服务端可信 OPENID')
    assert.strictEqual(rows[0]._id, fixedId('member_coach_profiles', coach.coachId), '文档 _id 必须等于 doc(id)（系统字段，不是 data 字段）')
  })

  // ————— B：修改显示名称后再次保存成功（更新路径）
  await test('B：修改显示名称后再次保存成功（覆盖路径同样不带 _id）', async () => {
    const cloud = strictCloud(), coach = seedCoach(cloud, 'coach-a', 'ds-a')
    cloud.setOpenId(coach.openId)
    assert.strictEqual((await publish(cloud, 'A教练', 'production', 'b1')).ok, true)
    const again = await publish(cloud, 'A教练改', 'production', 'b2')
    assert.strictEqual(again.ok, true, `更新保存失败 ${JSON.stringify(again)}`)
    const rows = cloud.rows('member_coach_profiles')
    assert.strictEqual(rows.length, 1, '更新必须覆盖原文档，不能新增一行')
    assert.strictEqual(rows[0].displayName, 'A教练改')
  })

  // ————— C：重复保存不改变已有公开码
  await test('C：重复保存三次，公开码稳定不漂移', async () => {
    const cloud = strictCloud(), coach = seedCoach(cloud, 'coach-a', 'ds-a')
    cloud.setOpenId(coach.openId)
    const first = await publish(cloud, 'A教练')
    for (const name of ['A教练2', 'A教练3']) {
      const again = await publish(cloud, name, 'production', 'c')
      assert.strictEqual(again.ok, true)
      assert.strictEqual(again.publicCode, first.publicCode, '公开码必须稳定（coachId 派生，不随机）')
    }
  })

  // ————— D：两位不同教练拥有独立公开卡
  await test('D：A / B 两位教练各自发布，公开卡与公开码互相独立', async () => {
    const cloud = strictCloud(), a = seedCoach(cloud, 'coach-a', 'ds-a'), b = seedCoach(cloud, 'coach-b', 'ds-b')
    cloud.setOpenId(a.openId)
    const pa = await publish(cloud, 'A教练', 'production', 'd-a')
    cloud.setOpenId(b.openId)
    const pb = await publish(cloud, 'B教练', 'production', 'd-b')
    assert.strictEqual(pa.ok && pb.ok, true)
    assert.notStrictEqual(pa.publicCode, pb.publicCode)
    const rows = cloud.rows('member_coach_profiles')
    assert.strictEqual(rows.length, 2, '两位教练两行公开卡，绝不互相覆盖')
    assert.ok(rows.some(r => r.coachId === a.coachId && r.displayName === 'A教练'))
    assert.ok(rows.some(r => r.coachId === b.coachId && r.displayName === 'B教练'))
  })

  // ————— E：Sandbox / Production 写入隔离
  await test('E：同一教练在 Sandbox 发布，绝不能写进 Production 集合（反之亦然）', async () => {
    const cloud = strictCloud(), coach = seedCoach(cloud, 'coach-a', 'ds-a', 'sandbox')
    cloud.setOpenId(coach.openId)
    const sandboxed = await publish(cloud, 'A教练', 'sandbox', 'e')
    assert.strictEqual(sandboxed.ok, true, JSON.stringify(sandboxed))
    assert.strictEqual(cloud.rows('member_coach_profiles').length, 0, 'Sandbox 不得写 Production 集合')
    assert.strictEqual(cloud.rows('member_sandbox_coach_profiles').length, 1, '必须写在 sandbox 集合')
    assert.strictEqual(cloud.rows('member_sandbox_revisions').length >= 1, true, 'revision 也要在 sandbox 侧')
    assert.strictEqual(cloud.rows('member_revisions').length, 0, 'Production revision 不得被 Sandbox 命令推进')
  })

  // ————— F：data 永远不许携带 _id（严格 DB 会当场 throw，这里再显式断言存储形状）
  await test('F：set 的 data 不许携带 _id（严格契约 DB 当场拒绝）', async () => {
    const cloud = strictCloud()
    let caught = ''
    try {
      await cloud.db.collection('member_coach_profiles').doc('x').set({ data: { _id: 'x', coachId: 'c', publicCode: 'P' } })
    } catch (error) { caught = error.message }
    assert.ok(caught.includes('-501007'), `严格 DB 必须复刻真机 -501007（实测：${caught || '没有抛错'}）`)
  })

  // ————— G：发布出的公开码能被 M2 V1 授权模块识别（跨云函数同一集合契约）
  await test('G：发布出的公开码能被 M2 V1 授权模块 coachIdsByPublicCodes 找到', async () => {
    const cloud = strictCloud(), coach = seedCoach(cloud, 'coach-b', 'ds-b')
    cloud.setOpenId(coach.openId)
    const published = await publish(cloud, 'B教练')
    assert.strictEqual(published.ok, true)
    const auths = authorizationModule.authScope(cloud.db, 'production')
    const found = await authorizationModule.coachIdsByPublicCodes(auths, [published.publicCode])
    assert.strictEqual(found.length, 1, `授权模块必须能凭公开码找到教练（${published.publicCode}）`)
    assert.strictEqual(found[0].coachId, coach.coachId)
    assert.strictEqual(found[0].displayName, 'B教练')
  })

  // ————— H：集合名与 memberIdentityCommand 契约逐字一致
  await test('H：授权模块复用的集合名与 memberIdentityCommand.names() 逐字一致', async () => {
    for (const environment of ['production', 'sandbox']) {
      const real = memberNames(environment), mine = collectionsFor(environment)
      assert.strictEqual(mine.profiles, real.profiles, `${environment} profiles 集合名不一致`)
      assert.strictEqual(mine.claims, real.claims, `${environment} claims 集合名不一致`)
    }
  })

  if (!process.exitCode) process.stdout.write('ALL MEMBER IDENTITY PUT CONTRACT TESTS PASSED\n')
})().catch(error => { process.stderr.write(`FATAL ${error.stack}\n`); process.exitCode = 1 })
