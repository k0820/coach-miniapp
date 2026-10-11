// §175 · 「课包真实存在却被 archiveId 过滤掉」真机回归（2026-10-06 · 1.3.20 体验版）
//
// ⭐⭐ 真机症状（用户原话，不是猜测）：
//   会员档案 = 「测试1」，授课教练 = 「教练A」，教练端**从一开始**就给测试1建好了剩余 > 0 的课时包；
//   1.3.18 认领后能正常显示课时；1.3.20 约课**确认页**却写「暂无可用课时包」，
//   点确认弹「先选好教练和可用的课时包」；而**教练是选中了的**，缺的是课时包。
//
// ⛔ 根因（本文件复现的就是这一条）：**档案归属在"投影 → 过滤"之间断了一次**
//     服务端 packages[] 每行都带 archiveId
//       → `packagesForArchive()` 精确筛（对）
//       → `usablePackages()` 重新投影成视图对象时**没有带上 archiveId**（⛔ 断点就在这里）
//       → `packagesForCoach()` 又按 archiveId 精确筛 ⇒ 当前档案**自己的**课包被自己筛光。
//   ⇒ 所以这不是"过滤太严"，而是"投影丢字段 + 过滤只有一种判据"的共同根因。
//
// ⛔ 修复方向（用户明定，不许偷懒）：
//   · 当前档案自己的课时包**必须**显示；
//   · 其他历史档案的课时包**仍然**不能混入（⛔ 不许靠删掉档案过滤来"修"）；
//   · 老课包没有 archiveId ⇒ 只能用**服务端可信三项** `ownerCoachId + datasetId + studentId` 兜底，
//     **三项全等**才认；⛔ **绝不**只按 coachKey 兜底（同一教练可能有多名学员）；
//   · 剩余 0 节 / 已作废的课包**仍然**不能预约；
//   · ⛔ 不伪造、不复制、不修改任何真实课时包（本文件一行真实数据都不碰）。
//
// ⛔ 判别力自证：全部用**内存替身**（内存里重新编译改坏后的源码），
//    ⛔ 磁盘零改动，⛔ 绝不调用真实云端，⛔ 绝不读写真实业务数据。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
const P = p => path.join(ROOT, p)
const copy = value => (value == null ? value : JSON.parse(JSON.stringify(value)))
const idsOf = rows => (rows || []).map(row => row && row.packageViewId)

// ─────────────────────────────────────────────────────────────────────────────
// 内存漂移：把源码改坏后重新编译，**只在内存里**（磁盘一个字节都不动）
// ─────────────────────────────────────────────────────────────────────────────
function withDrift(relPath, mutate, fn) {
  const target = require.resolve(P(relPath))
  const source = fs.readFileSync(target, 'utf8')
  const drifted = mutate(source)
  assert.notStrictEqual(drifted, source, `⛔ 漂移脚本自身失效：${relPath} 的锚点没命中`)
  const stub = new Module(target, null)
  stub.filename = target
  stub.paths = Module._nodeModulePaths(path.dirname(target))
  stub._compile(drifted, target)
  stub.loaded = true
  const saved = require.cache[target]
  require.cache[target] = stub
  try { return fn(require(target)) } finally {
    if (saved) require.cache[target] = saved
    else delete require.cache[target]
  }
}

const view = require(P('utils/member-booking-view'))

// ── 真机形状：当前档案「测试1」@ 教练A；当前档案 = (ownerCoachId=coach-a, datasetId=ds-a, studentId=stu-1)
const ARCHIVE_NOW = 'archive-test1'
const ARCHIVE_OTHER = 'archive-old'
const COACH_A = 'ck-coach-a'          // 教练A（当前档案的管理人）
const COACH_B = 'ck-coach-b'          // 被授权的授课教练

// ⭐ 服务端可信三项（只有服务端知道；客服端拿不到就拿不到，**绝不自己猜**）
const TRUSTED_NOW = { ownerCoachId: 'coach-a', datasetId: 'ds-a', studentId: 'stu-1' }
// ⛔ 同一位教练 A 的**另一名学员**（studentId 不同 ⇒ 不得混入）
const TRUSTED_OTHER_STUDENT = { ownerCoachId: 'coach-a', datasetId: 'ds-a', studentId: 'stu-2' }
// ⛔ 同一位学员在**另一本账**（datasetId 不同 ⇒ 不得混入）
const TRUSTED_OTHER_ARCHIVE = { ownerCoachId: 'coach-a', datasetId: 'ds-b', studentId: 'stu-1' }

// ① 现在**真机**下发的形状：每行都带 archiveId（已从线上云函数源码核过）
const TAGGED_ROWS = [
  { packageViewId: 'p-now', archiveId: ARCHIVE_NOW, typeName: '常规课', remaining: 8, total: 10, used: 2, coachKeys: [COACH_A, COACH_B] },
  { packageViewId: 'p-old-archive', archiveId: ARCHIVE_OTHER, typeName: '拉伸课', remaining: 5, total: 10, used: 5, coachKeys: [COACH_A] }
]

// ② 老课包形状：当前档案那份**没有** archiveId，只能靠服务端可信三项认领
//    ⛔ 五份包里只有第一份真的属于"当前档案 + 还能约"
const LEGACY_ROWS = [
  { packageViewId: 'p-now-legacy', typeName: '常规课', remaining: 8, total: 10, used: 2, coachKeys: [COACH_A, COACH_B], ...TRUSTED_NOW },
  { packageViewId: 'p-other-student', typeName: '常规课', remaining: 9, total: 10, used: 1, coachKeys: [COACH_A], ...TRUSTED_OTHER_STUDENT },
  { packageViewId: 'p-other-archive', typeName: '拉伸课', remaining: 7, total: 10, used: 3, coachKeys: [COACH_A, COACH_B], ...TRUSTED_OTHER_ARCHIVE },
  { packageViewId: 'p-empty', typeName: '常规课', remaining: 0, total: 10, used: 10, coachKeys: [COACH_A], ...TRUSTED_NOW },
  { packageViewId: 'p-reversed', typeName: '常规课', remaining: 6, total: 10, used: 4, status: 'reversed', coachKeys: [COACH_A], ...TRUSTED_NOW },
  // ⛔ 只给了 ownerCoachId（缺 datasetId / studentId）⇒ 三项不全 ⇒ **必须不认**
  { packageViewId: 'p-half-triple', typeName: '常规课', remaining: 4, total: 10, used: 6, coachKeys: [COACH_A], ownerCoachId: 'coach-a' }
]

// ③ 老云端形状：既没有 archiveId、也没有三项 ⇒ 无从归属 ⇒ 按既有退化口径"不缩名单"
const NO_DIMENSION_ROWS = [
  { packageViewId: 'p-legacy-only', typeName: '常规课', remaining: 3, total: 10, used: 7, coachKeys: [COACH_A] }
]

async function main() {
  const failures = []
  const check = async (label, fn) => {
    try { await fn(); console.log(`  ✅ ${label}`) } catch (error) { failures.push(label); console.log(`  ❌ ${label}\n     ${error.message}`) }
  }

  console.log('\n【① 复现 1.3.20 真机：课包真实存在却被自己筛掉】')

  await check('投影必须把档案归属带过去（⛔ 少了它 ⇒ packagesForCoach 全掉）', () => {
    const usable = view.usablePackages(view.packagesForArchive(TAGGED_ROWS, ARCHIVE_NOW), {})
    assert.deepStrictEqual(idsOf(usable), ['p-now'], '⛔ 当前档案的课包在投影阶段就丢了')
    assert.strictEqual(usable[0].archiveId, ARCHIVE_NOW,
      '⛔ usablePackages 没把 archiveId 带过去 —— 这正是 1.3.20 约课页"暂无可用课时包"的形状')
  })

  await check('端到端：当前档案的教练拿得到自己那份课包（1.3.20 这里返回 0）', () => {
    const usable = view.usablePackages(view.packagesForArchive(TAGGED_ROWS, ARCHIVE_NOW), {})
    assert.deepStrictEqual(idsOf(view.packagesForCoach(usable, COACH_A, ARCHIVE_NOW)), ['p-now'])
    assert.deepStrictEqual(idsOf(view.packagesForCoach(usable, COACH_B, ARCHIVE_NOW)), ['p-now'],
      '⛔ 被授权的授课教练也该拿得到（coachKeys 里有他）')
  })

  await check('带 archiveId 时：其他档案的课包仍然一粒都不准混进来', () => {
    assert.deepStrictEqual(idsOf(view.packagesForArchive(TAGGED_ROWS, ARCHIVE_NOW)), ['p-now'])
    assert.deepStrictEqual(idsOf(view.packagesForArchive(TAGGED_ROWS, ARCHIVE_OTHER)), ['p-old-archive'])
  })

  console.log('\n【② 老课包没有 archiveId ⇒ 只能靠服务端可信三项兜底】')

  await check('要求1：当前档案的旧课包（无 archiveId、三项全等）仍然显示', () => {
    const ids = idsOf(view.packagesForArchive(LEGACY_ROWS, ARCHIVE_NOW, TRUSTED_NOW))
    assert.ok(ids.indexOf('p-now-legacy') >= 0,
      `⛔ 当前档案自己的旧课包被 archiveId 过滤掉了 —— 这就是 1.3.20 真机阻断的形状：${JSON.stringify(ids)}`)
    // ⛔ 0 节 / 已作废那两份**也属于当前档案**（档案归属是对的），能不能约由 `usablePackages` 决定 ⇒ 见【③】
    assert.deepStrictEqual(ids, ['p-now-legacy', 'p-empty', 'p-reversed'])
  })

  await check('要求2：其他学员的课包（studentId 不同）不得混入', () => {
    const rows = view.packagesForArchive(LEGACY_ROWS, ARCHIVE_NOW, TRUSTED_NOW)
    assert.ok(idsOf(rows).indexOf('p-other-student') < 0,
      '⛔ 同一教练的另一名学员的课时包混进来了（只按 coachKey 兜底必然踩这个）')
  })

  await check('要求3：其他档案同教练的课包（datasetId 不同）不得混入', () => {
    const rows = view.packagesForArchive(LEGACY_ROWS, ARCHIVE_NOW, TRUSTED_NOW)
    assert.ok(idsOf(rows).indexOf('p-other-archive') < 0,
      '⛔ 同一位学员在另一本账里的课时包混进来了')
  })

  await check('「不得只按 coachKey 兜底」：三项缺任一项 ⇒ 一律不认', () => {
    const rows = view.packagesForArchive(LEGACY_ROWS, ARCHIVE_NOW, TRUSTED_NOW)
    assert.ok(idsOf(rows).indexOf('p-half-triple') < 0,
      '⛔ 只给了 ownerCoachId 的课包被放行了 ⇒ 这就是"只按教练猜"')
    assert.strictEqual(view.archiveTripleOf({ ownerCoachId: 'coach-a' }), null)
    assert.strictEqual(view.archiveTripleOf({ ownerCoachId: 'coach-a', datasetId: 'ds-a' }), null)
    assert.deepStrictEqual(view.archiveTripleOf({ ownerCoachId: 'coach-a', datasetId: 'ds-a', studentId: 'stu-1' }), TRUSTED_NOW)
  })

  await check('当前档案三项没下发 ⇒ 兜底**不发生**（宁可不显示，也不许猜）', () => {
    // ⛔ 服务端没给可信三项 ⇒ 没有 archiveId 的行一律不认（这里是 0 行，绝不是"全都放行"）
    assert.deepStrictEqual(idsOf(view.packagesForArchive(LEGACY_ROWS, ARCHIVE_NOW, null)), [])
    assert.deepStrictEqual(idsOf(view.packagesForArchive(LEGACY_ROWS, ARCHIVE_NOW, undefined)), [])
    // ⛔ 但带 archiveId 的行不受影响 ⇒ 真机（每行都带）永远走最可信的那条路
    assert.deepStrictEqual(idsOf(view.packagesForArchive(TAGGED_ROWS, ARCHIVE_NOW, null)), ['p-now'])
  })

  console.log('\n【③ 要求4：剩余 0 节 / 已作废的课包仍然不能预约】')

  await check('usablePackages 仍然滤掉 0 节与 reversed（⛔ 档案修复不许顺手放开）', () => {
    const own = view.packagesForArchive(LEGACY_ROWS, ARCHIVE_NOW, TRUSTED_NOW)
    const usable = view.usablePackages(own, {})
    assert.ok(idsOf(usable).indexOf('p-empty') < 0, '⛔ 剩余 0 节的课包被放出来预约了')
    assert.ok(idsOf(usable).indexOf('p-reversed') < 0, '⛔ 已作废的课包被放出来预约了')
    assert.deepStrictEqual(idsOf(usable), ['p-now-legacy'])
  })

  await check('真机形状下 0 节 / 作废同样不出现', () => {
    const tagged = TAGGED_ROWS.concat([
      { packageViewId: 'p-zero', archiveId: ARCHIVE_NOW, typeName: '常规课', remaining: 0, total: 10, used: 10, coachKeys: [COACH_A] },
      { packageViewId: 'p-void', archiveId: ARCHIVE_NOW, typeName: '常规课', remaining: 5, total: 10, used: 5, status: 'reversed', coachKeys: [COACH_A] }
    ])
    const usable = view.usablePackages(view.packagesForArchive(tagged, ARCHIVE_NOW), {})
    assert.deepStrictEqual(idsOf(usable), ['p-now'])
  })

  console.log('\n【④ 老云端退化：无从归属时宁可显示，也不清空画面】')

  await check('整份名单既无 archiveId 也无三项 ⇒ 不缩名单（⛔ 绝不清空）', () => {
    assert.deepStrictEqual(idsOf(view.packagesForArchive(NO_DIMENSION_ROWS, ARCHIVE_NOW, TRUSTED_NOW)), ['p-legacy-only'])
    assert.deepStrictEqual(idsOf(view.packagesForCoach(NO_DIMENSION_ROWS, COACH_A, ARCHIVE_NOW, TRUSTED_NOW)), ['p-legacy-only'])
  })

  await check('⛔ 只要有任意一种归属依据，就必须真的筛（不许借"老云端"偷懒放行）', () => {
    const mixed = [{ packageViewId: 'p-tag', archiveId: ARCHIVE_OTHER, typeName: '常规课', remaining: 3, coachKeys: [COACH_A] }]
      .concat(NO_DIMENSION_ROWS)
    assert.deepStrictEqual(idsOf(view.packagesForArchive(mixed, ARCHIVE_NOW, TRUSTED_NOW)), [],
      '⛔ 有可归属依据却退化成"全部放行" ⇒ 其他档案的课包会混进来')
  })

  console.log('\n【⑤ 没有当前档案 / 空名单的既有口径不许被改坏】')

  await check('没有当前档案（多份未选）⇒ 课包 0、教练 0（⛔ 绝不退化成全部）', () => {
    assert.deepStrictEqual(view.packagesForArchive(TAGGED_ROWS, ''), [])
    assert.deepStrictEqual(view.coachesForArchive([{ coachKey: COACH_A }], TAGGED_ROWS, ''), [])
  })

  await check('空名单 ⇒ 空结果', () => {
    assert.deepStrictEqual(view.packagesForArchive([], ARCHIVE_NOW, TRUSTED_NOW), [])
    assert.deepStrictEqual(view.coachesForArchive([{ coachKey: COACH_A }], [], ARCHIVE_NOW, TRUSTED_NOW), [])
  })

  console.log('\n【⑥ 教练名单也走同一个出口（口径不可能各写一套）】')

  await check('当前档案只留自己的教练（老课包三项兜底同样生效）', () => {
    const coaches = [{ coachKey: COACH_A }, { coachKey: COACH_B }]
    const legacyOnly = LEGACY_ROWS.filter(row => row.packageViewId === 'p-now-legacy')
    assert.deepStrictEqual(view.coachKeysForArchive(legacyOnly, ARCHIVE_NOW, TRUSTED_NOW), [COACH_A, COACH_B])
    assert.deepStrictEqual(view.coachesForArchive(coaches, legacyOnly, ARCHIVE_NOW, TRUSTED_NOW).map(row => row.coachKey), [COACH_A, COACH_B])
  })

  await check('其他档案的课包不会把别的教练带进来', () => {
    const coaches = [{ coachKey: COACH_A }, { coachKey: COACH_B }]
    const rows = view.coachesForArchive(coaches, TAGGED_ROWS, ARCHIVE_OTHER)
    assert.deepStrictEqual(rows.map(row => row.coachKey), [COACH_A])
  })

  console.log('\n【⑦ 判别力（把修好的代码改坏 ⇒ 必须变红）】')
  await runDiscrimination(check)

  const failed = failures.length
  console.log(`\n§175 结果：${failed ? `${failed} 条失败` : '全部通过'}`)
  if (failed) process.exit(1)
}

async function runDiscrimination(check) {
  await check('判别力①：usablePackages 丢掉 archiveId ⇒ 1.3.20 真机形状复现', () => {
    const dropArchiveId = s => s.replace("        archiveId: String(row.archiveId || ''),", '')
    const noDegrade = s => s.replace('  if (!attributable.length) return list.slice()', '  if (!attributable.length) return []')
    // ⓐ 只丢归属字段（老云端退化还在）⇒ **档案边界失守**：别的档案的课包混进来
    withDrift('utils/member-booking-view.js', dropArchiveId, drifted => {
      const usable = drifted.usablePackages(TAGGED_ROWS, {})
      const forCoach = drifted.packagesForCoach(usable, COACH_A, ARCHIVE_NOW)
      assert.ok(idsOf(forCoach).indexOf('p-old-archive') >= 0,
        '⛔ 投影丢了归属字段之后，其他档案的课包**仍然**没混进来 ⇒ 这条断言没有判别力')
    })
    // ⓑ 丢归属字段 + 过滤没有兜底（= 1.3.20 上线的形状）⇒ **当前档案自己的课包被自己筛光**
    withDrift('utils/member-booking-view.js', source => noDegrade(dropArchiveId(source)), drifted => {
      const usable = drifted.usablePackages(drifted.packagesForArchive(TAGGED_ROWS, ARCHIVE_NOW), {})
      assert.strictEqual(drifted.packagesForCoach(usable, COACH_A, ARCHIVE_NOW).length, 0,
        '⛔ 复现不出 1.3.20 真机"课包真实存在却一份都不显示" ⇒ 这条断言没有判别力')
    })
  })

  await check('判别力②：三项兜底少比 studentId ⇒ 其他学员混入，变红', () => {
    withDrift('utils/member-booking-view.js', source => source.replace(
      '    && triple.studentId === want.studentId',
      ''
    ), drifted => {
      const rows = drifted.packagesForArchive(LEGACY_ROWS, ARCHIVE_NOW, TRUSTED_NOW)
      assert.ok(idsOf(rows).indexOf('p-other-student') >= 0,
        '⛔ 放宽三项之后其他学员的课包**仍然**没混进来 ⇒ 断言没有判别力')
    })
  })

  await check('判别力③：三项兜底全放行（等于"只按教练猜"）⇒ 其他档案混入，变红', () => {
    withDrift('utils/member-booking-view.js', source => source.replace(
      `  return triple.ownerCoachId === want.ownerCoachId
    && triple.datasetId === want.datasetId
    && triple.studentId === want.studentId`,
      '  return true'
    ), drifted => {
      const rows = drifted.packagesForArchive(LEGACY_ROWS, ARCHIVE_NOW, TRUSTED_NOW)
      assert.ok(idsOf(rows).indexOf('p-other-student') >= 0 || idsOf(rows).indexOf('p-other-archive') >= 0,
        '⛔ 三项全放行之后别人的课包**仍然**没混进来 ⇒ 断言没有判别力')
    })
  })

  await check('判别力④：archiveId 精确匹配改成"忽略大小写/前缀" ⇒ 其他档案混入，变红', () => {
    withDrift('utils/member-booking-view.js', source => source.replace(
      '  if (own) return own === id',
      '  if (own) return true'
    ), drifted => {
      const rows = drifted.packagesForArchive(TAGGED_ROWS, ARCHIVE_NOW)
      assert.ok(idsOf(rows).indexOf('p-old-archive') >= 0,
        '⛔ archiveId 不比了之后其他档案的课包**仍然**没混进来 ⇒ 断言没有判别力')
    })
  })

  await check('判别力⑤：去掉档案过滤（简单删除过滤来"修复"）⇒ 其他档案混入，变红', () => {
    withDrift('utils/member-booking-view.js', source => source.replace(
      '  return list.filter(row => belongsToArchive(row, id, trusted))',
      '  return list'
    ), drifted => {
      const rows = drifted.packagesForArchive(TAGGED_ROWS, ARCHIVE_NOW)
      assert.ok(idsOf(rows).indexOf('p-old-archive') >= 0,
        '⛔ 删掉档案过滤之后其他档案的课包**仍然**没混进来 ⇒ 断言没有判别力')
    })
  })

  await check('判别力⑥：老云端退化改成"清空" ⇒ 老课包消失，变红', () => {
    withDrift('utils/member-booking-view.js', source => source.replace(
      '  if (!attributable.length) return list.slice()',
      '  if (!attributable.length) return []'
    ), drifted => {
      assert.strictEqual(drifted.packagesForArchive(NO_DIMENSION_ROWS, ARCHIVE_NOW, TRUSTED_NOW).length, 0,
        '⛔ 退化改成清空之后老课包**仍然**在 ⇒ 断言没有判别力')
    })
  })
}

main().catch(error => { console.error(error); process.exit(1) })
