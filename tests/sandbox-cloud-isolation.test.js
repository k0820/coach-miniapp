// ⭐⭐ 测试区（Sandbox）云函数隔离 —— **永久**回归
//
// ⛔⛔ 背景（2026-10-05，用户确认）：全项目**只有一个微信云环境**（`cloud1-d6g8l8h3uc9d8976f`）。
//    ⇒ 把新代码部署到 `memberIdentityCommand` / `coachBusinessCommand` = **替换**正式区共用的云函数。
//    ⇒ 因此新增两个**只服务测试区**的入口：`memberIdentitySandboxCommand` / `coachBusinessSandboxCommand`。
//
// 本文件要钉死的七件事（缺一条都不算闭环）：
//   ① 环境值不严格等于 `'sandbox'` ⇒ 云端**立即拒绝**，且**零集合访问**；
//   ② Sandbox 函数源码里**不存在**任何正式区集合名的字面量；
//   ③ Sandbox 契约**忽略入参**，任何入参都只返回 `member_sandbox_*`；
//   ④ 归档 / 恢复 / 解除认领 / 邀请认领 / 编辑显示名 **逐条**有服务端门禁；
//   ⑤ 归档后拒绝预约这条闸门读的**恒为**沙盒归档集合；
//   ⑥ 正式区页面 / 工具层**不会**调 Sandbox 函数；Sandbox 只调 Sandbox 函数；
//   ⑦ Sandbox 的业务逻辑是正式区的**逐字节镜像**（改了正式区忘了同步 ⇒ 立刻变红）。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const PROJ = path.join(__dirname, '..')
const CLOUD = path.join(PROJ, 'cloudfunctions')
const read = rel => fs.readFileSync(path.join(PROJ, rel), 'utf8')
const listJs = dir => fs.readdirSync(dir).filter(name => name.endsWith('.js'))

// ── 正式区集合名（出现在本文件任何断言之外的"沙盒源码"里 ⇒ 隔离被打破）──────────────
const PRODUCTION_COLLECTIONS = [
  'member_accounts', 'member_student_claims', 'member_claim_tokens', 'member_coach_profiles',
  'member_coach_shortcuts', 'member_revisions', 'member_receipts', 'member_student_archives',
  'member_notification_events',
  'coach_data_heads', 'coach_data_revisions', 'coach_command_receipts',
  'coach_package_shares', 'coach_member_authorizations', 'coach_package_grants'
]
// 两个环境**共用**的集合（同名、靠 ownerCoachId + datasetId 隔离行）⇒ 不算"落到正式区"。
const NEUTRAL_COLLECTIONS = new Set(['coaches', 'coach_datasets'])
const isSandboxCollection = name => name.indexOf('member_sandbox_') === 0 || name.indexOf('coach_sandbox_') === 0

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))

// ─────────────────────────────────────────────────────────────────────────────
// 假 CloudBase db：**记录每一个被点名的集合**，用来证明"一次读写都没落到正式区"。
function createRecordingDb(seed = {}) {
  const stores = {}
  const touched = []
  Object.keys(seed).forEach(name => { stores[name] = seed[name].map(copy) })
  function scopeOf(target) {
    const list = name => (target[name] = target[name] || [])
    return {
      command: { gt: v => ({ $gt: v }), gte: v => ({ $gte: v }), lt: v => ({ $lt: v }), lte: v => ({ $lte: v }), neq: v => ({ $neq: v }), in: v => ({ $in: v }) },
      collection(name) {
        touched.push(name)
        return {
          doc(id) {
            return {
              async get() { const row = list(name).find(r => r._id === id); return { data: row ? copy(row) : null } },
              async set({ data }) {
                const rows = list(name), at = rows.findIndex(r => r._id === id)
                const row = { ...copy(data), _id: id }
                if (at >= 0) rows[at] = row; else rows.push(row)
              },
              async remove() { const rows = list(name), at = rows.findIndex(r => r._id === id); if (at >= 0) rows.splice(at, 1) }
            }
          },
          where(query) {
            let limit = Infinity, skip = 0
            const api = {
              limit(value) { limit = value; return api },
              skip(value) { skip = value; return api },
              orderBy() { return api },
              async get() {
                const found = list(name).filter(row => Object.keys(query).every(key => {
                  const want = query[key]
                  if (want && typeof want === 'object' && !Array.isArray(want)) {
                    if ('$gt' in want) return Number(row[key]) > Number(want.$gt)
                    if ('$gte' in want) return Number(row[key]) >= Number(want.$gte)
                    if ('$lt' in want) return Number(row[key]) < Number(want.$lt)
                    if ('$lte' in want) return Number(row[key]) <= Number(want.$lte)
                    if ('$neq' in want) return row[key] !== want.$neq
                    if ('$in' in want) return want.$in.indexOf(row[key]) >= 0
                  }
                  return row[key] === want
                }))
                return { data: found.slice(skip, skip + limit).map(copy) }
              },
              async count() { return { total: list(name).length } }
            }
            return api
          },
          async add({ data }) { const rows = list(name), row = { ...copy(data), _id: data._id || ('auto_' + rows.length) }; rows.push(row); return { _id: row._id } },
          async get() { return { data: list(name).map(copy) } }
        }
      }
    }
  }
  const db = Object.assign(scopeOf(stores), {
    runTransaction: async work => {
      const draft = {}
      Object.keys(stores).forEach(name => { draft[name] = stores[name].map(copy) })
      const out = await work(scopeOf(draft))
      Object.keys(draft).forEach(name => { stores[name] = draft[name] })
      return out
    }
  })
  return { db, stores, touched }
}

// ─────────────────────────────────────────────────────────────────────────────
// 加载云函数入口（index.js 会 `require('wx-server-sdk')`，本机没有这个包 ⇒ 注入一个假件）。
// ⛔ 只注入内存模块，**不落盘任何文件**。
function loadEntry(dir, db, openId) {
  const FAKE_SDK = path.join(__dirname, 'helpers', '_fake-wx-server-sdk.js')
  if (!require.cache[FAKE_SDK]) {
    const fake = new Module(FAKE_SDK, module)
    fake.filename = FAKE_SDK
    fake.loaded = true
    fake.exports = { DYNAMIC_CURRENT_ENV: 'fake-env', init() {}, database: () => db, getWXContext: () => ({ OPENID: openId }) }
    require.cache[FAKE_SDK] = fake
  } else {
    require.cache[FAKE_SDK].exports.database = () => db
    require.cache[FAKE_SDK].exports.getWXContext = () => ({ OPENID: openId })
  }
  const original = Module._resolveFilename
  Module._resolveFilename = function (request, ...rest) {
    return request === 'wx-server-sdk' ? FAKE_SDK : original.call(this, request, ...rest)
  }
  try {
    const entryPath = path.join(CLOUD, dir, 'index.js')
    const mod = new Module(entryPath, module)
    mod.filename = entryPath
    mod.paths = Module._nodeModulePaths(path.dirname(entryPath))
    require.cache[entryPath] = mod
    mod._compile(fs.readFileSync(entryPath, 'utf8'), entryPath)
    mod.loaded = true
    return mod.exports
  } finally {
    Module._resolveFilename = original
  }
}

const BAD_ENVIRONMENTS = [
  ['undefined', undefined], ['null', null], ['空串', ''], ['production', 'production'],
  ['全大写 SANDBOX', 'SANDBOX'], ['首字母大写 Sandbox', 'Sandbox'], ['尾部空格 sandbox ', 'sandbox '],
  ['拼错 sandb0x', 'sandb0x'], ['数字 0', 0], ['true', true], ['对象', {}]
]

// ⛔ 只认"抛出来的错误带 SANDBOX_ENVIRONMENT_REQUIRED 这个码" —— 不比对文案（文案会改，码不会）。
function assertRejectsSandbox(fn, label) {
  let threw = null
  try { fn() } catch (error) { threw = error }
  assert.ok(threw, `${label}：必须抛错（不许悄悄放行）`)
  assert.equal(threw.commandCode || threw.code, 'SANDBOX_ENVIRONMENT_REQUIRED', `${label}：错误码不对`)
}

async function test(name, fn) {
  try { await fn(); process.stdout.write(`PASS ${name}\n`) }
  catch (error) { process.stderr.write(`FAIL ${name}: ${error.stack}\n`); process.exitCode = 1 }
}

;(async () => {
  // ── ① 会员身份 Sandbox 入口：坏环境值一律拒绝，且零集合访问 ──────────────────────
  for (const [label, value] of BAD_ENVIRONMENTS) {
    await test(`① memberIdentitySandboxCommand 拒绝 environment=${label}（零集合访问）`, async () => {
      const { db, touched } = createRecordingDb()
      const entry = loadEntry('memberIdentitySandboxCommand', db, 'openid-sandbox-1')
      const out = await entry.main({ action: 'bootstrap', environment: value })
      assert.equal(out && out.ok, false, '必须拒绝')
      assert.equal(out && out.code, 'SANDBOX_ENVIRONMENT_REQUIRED', '拒绝码必须是 SANDBOX_ENVIRONMENT_REQUIRED')
      assert.equal(out && out.environment, 'sandbox', '拒绝也要如实回 sandbox（绝不回 production）')
      assert.deepEqual(touched, [], '拒绝路径一个集合都不许碰')
    })
  }

  // ── ①b 放行时：只碰沙盒集合 ─────────────────────────────────────────────────
  await test('①b memberIdentitySandboxCommand 放行 sandbox，且只碰 member_sandbox_* / coach_sandbox_*', async () => {
    const { db, touched } = createRecordingDb()
    const entry = loadEntry('memberIdentitySandboxCommand', db, 'openid-sandbox-1')
    const out = await entry.main({ action: 'bootstrap', environment: 'sandbox' })
    assert.notEqual(out && out.code, 'SANDBOX_ENVIRONMENT_REQUIRED', 'sandbox 必须放行')
    assert.equal(out && out.environment, 'sandbox')
    assert.ok(touched.length > 0, '放行路径确实读写了集合（否则这条断言在测空气）')
    touched.forEach(name => {
      assert.ok(!PRODUCTION_COLLECTIONS.includes(name), `碰到了正式区集合：${name}`)
      assert.ok(isSandboxCollection(name) || NEUTRAL_COLLECTIONS.has(name), `集合既不是沙盒也不在共用白名单：${name}`)
    })
  })

  // ── ② 教练业务 Sandbox 入口：坏环境值一律拒绝 ───────────────────────────────
  for (const [label, value] of BAD_ENVIRONMENTS) {
    await test(`② coachBusinessSandboxCommand 拒绝 environment=${label}（会员预约那条命令）`, async () => {
      const { db, touched } = createRecordingDb()
      const entry = loadEntry('coachBusinessSandboxCommand', db, 'openid-sandbox-2')
      const out = await entry.main({ action: 'memberBooking', command: 'createMemberBooking', environment: value })
      assert.equal(out && out.ok, false)
      assert.equal(out && out.code, 'SANDBOX_ENVIRONMENT_REQUIRED')
      assert.deepEqual(touched, [])
    })
  }
  await test('②b coachBusinessSandboxCommand 拒绝 environment=undefined（教练命令通道）', async () => {
    const { db, touched } = createRecordingDb()
    const entry = loadEntry('coachBusinessSandboxCommand', db, 'openid-sandbox-2')
    const out = await entry.main({ action: 'status' })
    assert.equal(out && out.ok, false)
    assert.equal(out && out.code, 'SANDBOX_ENVIRONMENT_REQUIRED')
    assert.deepEqual(touched, [])
  })
  await test('②c coachBusinessSandboxCommand 放行 sandbox，且只碰沙盒 / 共用集合', async () => {
    const { db, touched } = createRecordingDb()
    const entry = loadEntry('coachBusinessSandboxCommand', db, 'openid-sandbox-2')
    const out = await entry.main({ action: 'status', environment: 'sandbox' })
    assert.notEqual(out && out.code, 'SANDBOX_ENVIRONMENT_REQUIRED', 'sandbox 必须放行')
    touched.forEach(name => {
      assert.ok(!PRODUCTION_COLLECTIONS.includes(name), `碰到了正式区集合：${name}`)
      assert.ok(isSandboxCollection(name) || NEUTRAL_COLLECTIONS.has(name), `集合既不是沙盒也不在共用白名单：${name}`)
    })
  })

  // ── ③ Sandbox 契约：忽略入参，恒为沙盒；且值与正式区沙盒侧逐字相同 ──────────────
  await test('③ 沙盒契约忽略入参：任何值都只返回 member_sandbox_*', async () => {
    const sandbox = require('../cloudfunctions/memberIdentitySandboxCommand/member-contract')
    const expected = sandbox.memberNames('sandbox')
    Object.keys(expected).forEach(key => {
      if (key === 'environment') return
      assert.ok(String(expected[key]).indexOf('member_sandbox_') === 0 || String(expected[key]).indexOf('coach_sandbox_') === 0, `${key}=${expected[key]} 不是沙盒集合`)
    })
    ;[undefined, null, '', 'production', 'SANDBOX', 'sandbox ', 0, {}].forEach(value => {
      assert.deepEqual(sandbox.memberNames(value), expected, `memberNames(${String(value)}) 竟然和 sandbox 不一样`)
    })
    // ⭐ 2026-10-05：归档撤回 ⇒ 不再有归档集合；顺带钉死任何环境值都不会带出 student_archives。
    assert.equal(expected.archives, undefined, '归档集合名必须已从沙盒契约移除')
  })
  await test('③b 沙盒契约的值与正式区契约的 sandbox 侧**逐字相同**（不允许两套口径）', async () => {
    const sandbox = require('../cloudfunctions/memberIdentitySandboxCommand/member-contract')
    const production = require('../cloudfunctions/memberIdentityCommand/member-contract')
    assert.deepEqual(sandbox.memberNames('sandbox'), production.memberNames('sandbox'))
    assert.deepEqual(sandbox.CLAIM_STATUS, production.CLAIM_STATUS)
    assert.equal(sandbox.ARCHIVE_NAME_MAX, production.ARCHIVE_NAME_MAX)
  })

  // ── ④ 五类操作逐条有服务端门禁 ─────────────────────────────────────────────
  await test('④ 解除认领/邀请认领/编辑显示名 逐条有服务端门禁', async () => {
    const guard = require('../cloudfunctions/memberIdentitySandboxCommand/sandbox-guard')
    const COMMANDS = ['releaseStudentClaim', 'createClaimInvite', 'createClaimQrCode', 'updateProfile']
    COMMANDS.forEach(command => {
      assert.ok(guard.SANDBOX_ONLY_COMMANDS.includes(command), `${command} 必须在受保护白名单里`)
      ;[undefined, '', 'production', 'SANDBOX', 'sandbox '].forEach(value => {
        const rejected = guard.rejectOperation(command, value)
        assert.ok(rejected, `${command} + environment=${String(value)} 必须被拒`)
        assert.equal(rejected.code, 'SANDBOX_ENVIRONMENT_REQUIRED')
      })
      assert.equal(guard.rejectOperation(command, 'sandbox'), null, `${command} + sandbox 必须放行`)
    })
  })
  await test('④b 会员预约三条写命令逐条有服务端门禁（教练业务侧）', async () => {
    const guard = require('../cloudfunctions/coachBusinessSandboxCommand/sandbox-guard')
    ;['createMemberBooking', 'cancelMemberBooking', 'rescheduleMemberBooking'].forEach(command => {
      assert.ok(guard.SANDBOX_ONLY_COMMANDS.includes(command), `${command} 必须在受保护白名单里`)
      ;[undefined, '', 'production'].forEach(value => {
        const rejected = guard.rejectOperation(command, value)
        assert.ok(rejected && rejected.code === 'SANDBOX_ENVIRONMENT_REQUIRED', `${command} + ${String(value)} 必须被拒`)
      })
      assert.equal(guard.rejectOperation(command, 'sandbox'), null)
    })
  })

  // ── ⑤ 环境归一化：非 sandbox 直接抛，绝不"默认正式区" ─────────────────────────
  await test('⑤ core.environmentOf 对非 sandbox 一律抛（没有 production 这支分支）', async () => {
    const core = require('../cloudfunctions/coachBusinessSandboxCommand/core')
    assert.equal(core.environmentOf('sandbox'), 'sandbox')
    ;[undefined, null, '', 'production', 'SANDBOX', 'sandbox ', 0].forEach(value => {
      assertRejectsSandbox(() => core.environmentOf(value), `environmentOf(${String(value)})`)
    })
    assert.equal(core.metaFor('sandbox'), core.SANDBOX_META)
    assert.equal(core.META, core.SANDBOX_META, '沙盒副本里 META 必须就是沙盒元集合（不留正式区出口）')
    // ⛔ kind / 回执口径也必须钉在沙盒那一支（`receiptKindFor` 是唯一被导出的那个）。
    assert.equal(core.receiptKindFor('sandbox'), 'coach-sandbox-receipt')
    assert.equal(core.receiptKindFor('sandbox').indexOf('sandbox') >= 0, true)
  })
  await test('⑤b authorization.collectionsFor 恒为沙盒，且与正式区 sandbox 侧逐字相同', async () => {
    const sandboxAuth = require('../cloudfunctions/coachBusinessSandboxCommand/authorization')
    const prodAuth = require('../cloudfunctions/coachBusinessCommand/authorization')
    assert.deepEqual(sandboxAuth.collectionsFor('sandbox'), prodAuth.collectionsFor('sandbox'))
    assert.equal(sandboxAuth.collectionsFor('sandbox').claims, 'member_sandbox_student_claims')
    ;[undefined, 'production', ''].forEach(value => {
      assertRejectsSandbox(() => sandboxAuth.collectionsFor(value), `collectionsFor(${String(value)})`)
    })
  })


  // ── ⑦ 静态：Sandbox 源码里不存在任何正式区集合名 ──────────────────────────────
  await test('⑦ Sandbox 两个云函数源码里**没有**任何正式区集合名字面量', async () => {
    ;['memberIdentitySandboxCommand', 'coachBusinessSandboxCommand'].forEach(dir => {
      listJs(path.join(CLOUD, dir)).forEach(file => {
        const source = read(path.join('cloudfunctions', dir, file))
        PRODUCTION_COLLECTIONS.forEach(name => {
          assert.ok(source.indexOf(name) < 0, `cloudfunctions/${dir}/${file} 里出现了正式区集合名 ${name}`)
        })
      })
    })
  })
  await test('⑦b Sandbox 云函数**没有** repair 通道（正式区救援工具不该出现在测试区函数里）', async () => {
    assert.ok(!fs.existsSync(path.join(CLOUD, 'coachBusinessSandboxCommand', 'repair.js')), 'repair.js 不该被镜像进来')
    const indexSource = read('cloudfunctions/coachBusinessSandboxCommand/index.js')
    assert.ok(indexSource.indexOf('repair') < 0 || indexSource.indexOf("require('./repair')") < 0, 'index.js 不该接 repair')
  })

  // ── ⑧ 静态：正式区代码不会调 Sandbox 函数 ───────────────────────────────────
  await test('⑧ 正式区云函数 / utils / pages 源码里不出现 Sandbox 函数名（除路由模块本身）', async () => {
    const SANDBOX_NAMES = ['memberIdentitySandboxCommand', 'coachBusinessSandboxCommand']
    const places = []
    ;['memberIdentityCommand', 'coachBusinessCommand', 'readMyMemberData'].forEach(dir => {
      listJs(path.join(CLOUD, dir)).forEach(f => places.push(path.join('cloudfunctions', dir, f)))
    })
    fs.readdirSync(path.join(PROJ, 'utils')).filter(f => f.endsWith('.js')).forEach(f => places.push(path.join('utils', f)))
    fs.readdirSync(path.join(PROJ, 'pages')).forEach(dir => {
      const file = path.join('pages', dir, dir + '.js')
      if (fs.existsSync(path.join(PROJ, file))) places.push(file)
    })
    places.forEach(rel => {
      if (rel.indexOf('sandbox-cloud-functions.js') >= 0) return  // 路由表本身当然要写这两个名字
      const source = read(rel)
      SANDBOX_NAMES.forEach(name => {
        assert.ok(source.indexOf(name) < 0, `${rel} 里出现了 Sandbox 函数名 ${name}`)
      })
    })
  })

  // ── ⑨ 客户端路由：环境 → 云函数名 ────────────────────────────────────────────
  await test('⑨ 客户端路由表：sandbox ⇒ Sandbox 函数；否则 ⇒ 正式函数', async () => {
    const routing = require('../utils/sandbox-cloud-functions')
    assert.equal(routing.identityFunction('sandbox'), 'memberIdentitySandboxCommand')
    assert.equal(routing.identityFunction('production'), 'memberIdentityCommand')
    assert.equal(routing.identityFunction(undefined), 'memberIdentityCommand')
    assert.equal(routing.businessFunction('sandbox'), 'coachBusinessSandboxCommand')
    assert.equal(routing.businessFunction('production'), 'coachBusinessCommand')
    assert.equal(routing.businessFunction(''), 'coachBusinessCommand')
    assert.equal(routing.hint('sandbox'), '')
    assert.equal(routing.hint('production'), '该功能尚在安全测试中')
    assert.equal(routing.hint(undefined), '该功能尚在安全测试中')
  })
  await test('⑨b 正式区受保护命令被门禁拦下（零云调用 + 同一句话）', async () => {
    const routing = require('../utils/sandbox-cloud-functions')
    ;['releaseStudentClaim', 'createClaimInvite', 'createClaimQrCode'].forEach(command => {
      const out = routing.reject(command, 'production')
      assert.ok(out, `${command} 在正式区必须被拦`)
      assert.equal(out.code, 'SANDBOX_ONLY_FEATURE')
      assert.equal(out.message, '该功能尚在安全测试中')
      assert.equal(routing.reject(command, 'sandbox'), null, `${command} 在测试区必须放行`)
    })
    // ⛔ 切主题走的是同一条 updateProfile，但**不带 displayName** ⇒ 绝不能被一起挡掉
    assert.equal(routing.reject('updateProfile', 'production', { theme: 'vitality' }), null)
    assert.ok(routing.reject('updateProfile', 'production', { displayName: 'x' }), '改显示名必须被拦')
    assert.equal(routing.reject('updateProfile', 'sandbox', { displayName: 'x' }), null)
  })

  // ── ⑩ 客户端：正式区零云调用；测试区只调 Sandbox 函数 ──────────────────────────
  await test('⑩ 教练端工具层：正式区零云调用，测试区只调 memberIdentitySandboxCommand', async () => {
    const calls = []
    global.wx = {
      getStorageSync: () => null, setStorageSync() {}, removeStorageSync() {},
      cloud: { callFunction: async ({ name, data }) => { calls.push({ name, data }); return { result: { ok: true, coachRevision: 0 } } } }
    }
    const runtime = require('../utils/data-runtime')
    const tools = require('../utils/member-coach-tools')
    runtime.setEnvironment('production')
    // ⭐ 2026-10-05：归档命令已移除 ⇒ 改用仍在受保护名单里的「解除认领」验证同一条门禁。
    const blocked = await tools.execute('releaseStudentClaim', { archiveId: 'a1' })
    assert.equal(blocked.code, 'SANDBOX_ONLY_FEATURE')
    assert.equal(blocked.message, '该功能尚在安全测试中')
    assert.equal(calls.length, 0, '正式区一次云调用都不许发')

    runtime.setEnvironment('sandbox')
    const out = await tools.execute('archiveStudent', { studentId: 's1' })
    assert.ok(out && out.ok, '测试区必须真的发得出去')
    assert.equal(calls.length > 0, true)
    calls.forEach(call => {
      assert.equal(call.name, 'memberIdentitySandboxCommand', '测试区不许调正式函数')
      assert.equal(call.data.environment, 'sandbox')
    })
    runtime.setEnvironment('production')
  })

  // ── ⑪ 镜像守卫：Sandbox 的业务逻辑必须与正式区**逐字节一致** ────────────────────
  await test('⑪ Sandbox 镜像文件与正式区逐字节一致（改了正式区忘了同步 ⇒ 立刻红）', async () => {
    const MIRRORS = [
      ['memberIdentityCommand/service.js', 'memberIdentitySandboxCommand/service.js'],
      ['memberIdentityCommand/short-code.js', 'memberIdentitySandboxCommand/short-code.js'],
      ['coachBusinessCommand/handlers.js', 'coachBusinessSandboxCommand/handlers.js'],
      ['coachBusinessCommand/occupancy.js', 'coachBusinessSandboxCommand/occupancy.js'],
      ['coachBusinessCommand/teaching.js', 'coachBusinessSandboxCommand/teaching.js'],
      ['coachBusinessCommand/short-code.js', 'coachBusinessSandboxCommand/short-code.js'],
      // ⭐ 2026-10-05 晚补登记（此前漏登记）：这两个文件本来就是**逐字节镜像**，
      //    因为没进清单 ⇒ 测试区那份里硬编码的 `coach_data_heads` 一直没被判据⑦ 抓到。
      //    （判据⑦ 已促使源码改成从 `core.metaFor()` 推导，⛔ 不许再写死集合名字面量。）
      ['coachBusinessCommand/memberBooking.js', 'coachBusinessSandboxCommand/memberBooking.js'],
      ['coachBusinessCommand/notify.js', 'coachBusinessSandboxCommand/notify.js'],
      // ⭐ 2026-10-08 第 74 轮补登记：统一通知分发器**本来就是**逐字节镜像（前几轮一直手动同步），
      //    漏登记 ⇒ 只改一侧也不会红 ⇒ 迟早漂回两套通知路径。
      ['coachBusinessCommand/notify-booking.js', 'coachBusinessSandboxCommand/notify-booking.js']
    ]
    // ⛔⛔ `core.js` **故意不在这个清单里**（2026-10-08 第 74 轮踩过一次坑）：
    //   正式区 core 按设计**不带站内消息分支**（`notification-inbox-sandbox` ⑨ 钉死
    //   「正式区不许出现 notification-inbox / delivery.inbox」），而测试区 core **必须**有。
    //   ⇒ 谁把 `core.js` 当孪生整文件覆盖同步，那条测试会立刻红 —— **那是判据在起作用，不要去改判据**。
    MIRRORS.forEach(([from, to]) => {
      const a = read(path.join('cloudfunctions', from)), b = read(path.join('cloudfunctions', to))
      assert.equal(b, a, `${to} 与 ${from} 不一致 —— 正式区改过之后必须重新镜像（整文件覆盖）`)
    })
    // 会员身份定位逻辑必须同构，但集合名与环境闸必须各自独立，不能逐字节覆盖。
    const prodIdentity = read(path.join('cloudfunctions', 'coachBusinessCommand/member-identity.js'))
    const sandboxIdentity = read(path.join('cloudfunctions', 'coachBusinessSandboxCommand/member-identity.js'))
    const normalizedProdIdentity = prodIdentity.replace(/member_members/g, 'member_sandbox_members').replace(/production/g, 'sandbox')
    assert.equal(sandboxIdentity, normalizedProdIdentity, '两侧会员身份逻辑必须同构，且只允许集合名与环境名不同')
  })

  // ── ⑫ 部署清单：本轮测试区唯一需要新建的集合 ────────────────────────────────────
  await test('⑫ Sandbox 契约不再引入任何归档集合（归档功能已整体撤回）', async () => {
    const sandbox = require('../cloudfunctions/memberIdentitySandboxCommand/member-contract')
    const names = sandbox.memberNames('sandbox')
    // ⭐ 2026-10-05：归档功能撤回 ⇒ 契约里**不许**再有归档旁路集合，也不许再出现 student_archives 字面量。
    assert.equal(names.archives, undefined, '归档集合名必须从 Sandbox 契约里彻底移除')
    // ⛔ 顺带钉死：Sandbox 侧**不额外引入**任何新集合（都在既有沙盒前缀下）
    Object.keys(names).forEach(key => {
      if (key === 'environment') return
      assert.ok(String(names[key]).indexOf('member_sandbox_') === 0 || String(names[key]).indexOf('coach_sandbox_') === 0, `${key} 不是既有沙盒集合`)
    })
  })
})()
