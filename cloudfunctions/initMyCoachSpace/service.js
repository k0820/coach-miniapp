// 首次开通：为**全新 coach** 幂等地建立属于他自己的云端数据空间（一份空数据集 + 它的 revision(0)
// + 指向它的 head(1) + 一份默认 settings）。
//
// —— 为什么刻意**不**复用旧的 Activation / Migration / Candidate Staging ——
// 那套流程的语义是「把一份**已经存在于别处**的快照搬过来、验证指纹、接管为正式基线」：
// 候选暂存分块、sourceChecksum/sourceByteSize 比对、headVersion 冲突、旧数据集 retired、
// ACTIVATING/PENDING 状态机、恢复副本…… 它们全都是**为了处理"有源数据要接管"**才存在的。
// 新 coach 的第一份云端空间**没有任何源数据**（云端零字节、本机也没有要搬的东西），
// 所以这里只需要建立一份**空基线**：**没有迁移、没有候选、没有替换、没有状态机**。
// 「新用户空数据初始化 ≠ 老用户数据迁移」—— 这一层只做前者。
//
// —— 三条不可动摇的性质 ——
// ① **身份只由 `cloud.getWXContext().OPENID` 决定。** 客户端一旦提交 OPENID / openId / coachId /
//    ownerCoachId / datasetId / documentId，直接 `FORBIDDEN_IDENTITY_INPUT` 拒绝（连读都不读）。
//    coachId 由 OPENID 确定性派生（与 getOrCreateCoach / coachBusinessCommand 逐字同源）。
// ② **绝不创建第二份。** 先读 head：只要 head 已经指向一份有效数据集，就**原样返回它、一个字节都不写**
//    （连同 headVersion / dataRevision 一起读回来）。这就是"现有 cloud-primary 账号重新打开新版
//    不受任何影响"的服务端那一半 —— 幂等由**数据本身**保证，而不是由客户端自觉。
// ③ **幂等。** 数据集 / revision / head 的 `_id` 全部由 owner **确定性派生**，且它们的创建在
//    **同一个事务**里完成。于是「连续点开两次 / 杀进程重开 / 请求超时后重试 / 并发重复请求」
//    最终都只会得到同一个空间：并发时事务冲突 → 重新读 head → 读到刚建好的那一份。
//
// 写入面**只有 meta 集合 + 一份 settings**：7 个业务事实集合（students / student_tombstones /
// packages / bookings / incomes / sales / customExercises）保持**零文档**（新用户没有业务数据），
// 沙箱集合（coach_sandbox_*）一个字节都不碰。
const crypto = require('crypto')

const SCHEMA_VERSION = 1
const INITIAL_DATASET_KIND = 'coach-initial-dataset'
const META = Object.freeze({ coaches: 'coaches', heads: 'coach_data_heads', datasets: 'coach_datasets', revisions: 'coach_data_revisions' })
const SETTINGS = 'settings'
// 与 utils/db.emptyDB() 的 settings 默认值、utils/candidate-dataset.DEFAULT_SETTINGS 同值：
// 新 coach 的云端设置必须有一份**可用默认值**，否则云端模式下页面读到的是空对象
// （本地模式由 utils/db.getDB() 兜底填默认值，云端模式没有那层兜底）。
const DEFAULT_SETTINGS = Object.freeze({ renewThreshold: 10, monthlyGoalSessions: 40, classCommissionRate: 0, salesCommissionRate: 0 })
// 读端（readMyActiveCoachData）按这 8 个物理集合分页重建快照。
const READ_COLLECTIONS = Object.freeze(['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises'])
const FORBIDDEN_IDENTITY_INPUT = Object.freeze(['OPENID', 'openId', 'openid', '_openid', 'coachId', 'ownerCoachId', 'datasetId', 'documentId'])

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const coachIdFor = openId => sha(`coach:${openId}`).slice(0, 32)
const fixedId = (kind, owner, suffix = '') => sha(`${kind}:${owner}:${suffix}`).slice(0, 32)
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)

// ⚠️ 与 cloudfunctions/readMyActiveCoachData/integrity.js 的 fingerprint **逐字同源**（刻意复制，不改一处）。
//    开通时写下的 checksum / byteSize / summary / counts / amounts 必须与**读端回读后算出来的**一模一样，
//    否则新用户第一次 readActive 就会因完整性不一致而完全无法使用云端数据源
//    （cloud-primary-adapter 会返回 ACTIVE_READ_INTEGRITY_FAILED，整个小程序只读）。
//    项目里已有同样先例：那份 integrity.js 本身就是 utils/candidate-dataset.js 的服务端副本。
function fingerprint(snapshot) {
  const json = canonical(snapshot), packages = snapshot.students.flatMap(student => student.packages || [])
  const incomeAmount = Number(snapshot.incomes.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2))
  const salesAmount = Number(snapshot.sales.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2))
  return {
    checksum: sha(json), byteSize: Buffer.byteLength(json, 'utf8'),
    summary: { students: snapshot.students.filter(item => item.status !== 'deleted').length, deletedStudents: snapshot.students.filter(item => item.status === 'deleted').length, packages: packages.length, bookings: snapshot.bookings.length, completedBookings: snapshot.bookings.filter(item => item.status === 'done').length, incomes: snapshot.incomes.length, sales: snapshot.sales.length, customExercises: snapshot.customExercises.length, incomeAmount, salesAmount },
    counts: { students: snapshot.students.length, packages: packages.length, bookings: snapshot.bookings.length, incomes: snapshot.incomes.length, sales: snapshot.sales.length, customExercises: snapshot.customExercises.length },
    amounts: { incomes: incomeAmount, sales: salesAmount }
  }
}

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })
const error = (code, message, extra = {}) => Object.assign(new Error(message), { code, extra })
async function one(scope, name, query) { const response = await scope.collection(name).where(query).limit(1).get(); return response && response.data && response.data[0] || null }
async function put(scope, name, id, data) { const { _id, ...body } = data; return scope.collection(name).doc(id).set({ data: body }) }

// 空空间的快照 —— 与「0 个业务文档 + 1 份默认 settings」经读端 reconstruct 出来的结果**逐字相等**。
// 测试里用真实 integrity.js 的 reconstruct+fingerprint 端到端证明了这一点（不许靠推理）。
const initialSnapshot = () => ({ students: [], bookings: [], incomes: [], sales: [], settings: { ...DEFAULT_SETTINGS }, customExercises: [] })
const initialChecksum = () => fingerprint(initialSnapshot()).checksum

function datasetRecord(owner, datasetId, timestamp) {
  const meta = fingerprint(initialSnapshot())
  return {
    _id: fixedId('coach-dataset', owner, datasetId), ownerCoachId: owner, datasetId,
    status: 'active', integrityStatus: 'verified', schemaVersion: SCHEMA_VERSION,
    checksum: meta.checksum, byteSize: meta.byteSize, summary: meta.summary, counts: meta.counts, amounts: meta.amounts,
    sourceChecksum: meta.checksum, sourceByteSize: meta.byteSize, sourceSummary: meta.summary,
    collections: READ_COLLECTIONS.slice(), createdAt: timestamp, verifiedAt: timestamp, activatedAt: timestamp
  }
}
// ⚠️ 字段与 `_id` 必须与 cloudfunctions/coachBusinessCommand/core.js 的 scopedBusiness + handlers.saveSettings
//    写出来的**完全一致**（`fixedId('coach-business-settings', owner, `${datasetId}:settings`)` + `{settingsId, sortIndex, data}`）。
//    只要差一个字段，用户第一次改设置就会在本空间里**多出第二份 settings 文档**，而读端只取
//    `groups.settings[0]` —— 回读快照会与开通时写下的指纹不一致，整个云端数据源立刻不可用。
function settingsRecord(owner, datasetId) {
  return { _id: fixedId(`coach-business-${SETTINGS}`, owner, `${datasetId}:settings`), settingsId: SETTINGS, sortIndex: 0, data: { ...DEFAULT_SETTINGS }, ownerCoachId: owner, datasetId }
}

function createService({ db, getOpenId, now = () => Date.now() }) {
  // coach 记录：与 cloudfunctions/getOrCreateCoach 逐字同口径（确定性 _id + 竞态再读校验归属）。
  async function ensureCoach(openId, owner) {
    const existing = await one(db, META.coaches, { _id: owner })
    if (existing) {
      if (existing.openId !== openId) throw error('OWNER_MISMATCH', '用户资料归属异常。')
      return { created: false, status: existing.status || 'active' }
    }
    const record = { _id: owner, openId, status: 'active', schemaVersion: SCHEMA_VERSION, migrationVersion: 0, createdAt: now(), updatedAt: now() }
    try { await db.collection(META.coaches).add({ data: record }); return { created: true, status: 'active' } }
    catch (createError) {
      const again = await one(db, META.coaches, { _id: owner })
      if (!again || again.openId !== openId) throw error('COACH_CREATE_FAILED', '无法创建用户资料。')
      return { created: false, status: again.status || 'active' }
    }
  }
  // 读回当前空间状态：head / dataset / revision 三者必须齐全且自洽，否则视为不可用（本次不做任何修改）。
  async function stateOf(owner, datasetId) {
    const dataset = await one(db, META.datasets, { _id: fixedId('coach-dataset', owner, datasetId), ownerCoachId: owner, datasetId })
    if (!dataset || dataset.status !== 'active' || dataset.integrityStatus !== 'verified' || !dataset.checksum || !Number.isFinite(Number(dataset.byteSize)) || !dataset.summary) return null
    const revision = await one(db, META.revisions, { _id: fixedId('coach-data-revision', owner, datasetId), ownerCoachId: owner, datasetId })
    if (!revision || !Number.isInteger(revision.dataRevision) || revision.dataRevision < 0) return null
    return { dataRevision: revision.dataRevision }
  }

  return async function main(event = {}) {
    const openId = getOpenId()
    if (!openId) return fail('IDENTITY_MISSING', '未能确认当前微信身份。')
    if (event && typeof event === 'object' && !Array.isArray(event)) {
      for (const key of Object.keys(event)) if (FORBIDDEN_IDENTITY_INPUT.includes(key)) return fail('FORBIDDEN_IDENTITY_INPUT', `客户端不得提交 ${key}。`)
      if (event.action && event.action !== 'provision') return fail('UNKNOWN_ACTION', '不支持的初始化操作。')
    }
    const owner = coachIdFor(openId)
    try {
      const coach = await ensureCoach(openId, owner)
      if (coach.status !== 'active') return fail('COACH_NOT_ACTIVE', '当前账号状态不允许建立云端空间。')

      // ★ ② 绝不创建第二份：head 已经指向一份有效数据集 ⇒ 原样返回，**一个字节都不写**。
      const headId = fixedId('coach-data-head', owner)
      const head = await one(db, META.heads, { _id: headId, ownerCoachId: owner })
      if (head && head.activeDatasetId) {
        const state = await stateOf(owner, head.activeDatasetId)
        if (!state) return fail('ACTIVE_DATASET_INVALID', '当前云端空间状态异常，本次没有做任何修改。')
        return { ok: true, created: false, alreadyProvisioned: true, coachCreated: coach.created, datasetId: head.activeDatasetId, headVersion: Number(head.headVersion || 0), dataRevision: state.dataRevision, schemaVersion: SCHEMA_VERSION }
      }

      // ★ ③ 幂等创建：三个 _id 全部确定性派生 + 同一个事务。
      const datasetId = fixedId(INITIAL_DATASET_KIND, owner), timestamp = now(), checksum = initialChecksum()
      const result = await db.runTransaction(async tx => {
        const draftHead = await one(tx, META.heads, { _id: headId, ownerCoachId: owner })
        if (draftHead && draftHead.activeDatasetId) return { already: true, datasetId: draftHead.activeDatasetId, headVersion: Number(draftHead.headVersion || 0) }
        const datasetDocId = fixedId('coach-dataset', owner, datasetId)
        if (!await one(tx, META.datasets, { _id: datasetDocId, ownerCoachId: owner, datasetId })) await put(tx, META.datasets, datasetDocId, datasetRecord(owner, datasetId, timestamp))
        const revisionId = fixedId('coach-data-revision', owner, datasetId)
        if (!await one(tx, META.revisions, { _id: revisionId, ownerCoachId: owner, datasetId })) await put(tx, META.revisions, revisionId, { ownerCoachId: owner, datasetId, dataRevision: 0, createdAt: timestamp, updatedAt: timestamp })
        const settingsId = fixedId(`coach-business-${SETTINGS}`, owner, `${datasetId}:settings`)
        if (!await one(tx, SETTINGS, { _id: settingsId, ownerCoachId: owner, datasetId })) await put(tx, SETTINGS, settingsId, settingsRecord(owner, datasetId))
        const headVersion = Number(draftHead ? draftHead.headVersion || 0 : 0) + 1
        await put(tx, META.heads, headId, { ownerCoachId: owner, activeDatasetId: datasetId, headVersion, schemaVersion: SCHEMA_VERSION, datasetChecksum: checksum, createdAt: draftHead ? draftHead.createdAt : timestamp, updatedAt: timestamp })
        return { already: false, datasetId, headVersion }
      })

      if (result.already) {
        const state = await stateOf(owner, result.datasetId)
        if (!state) return fail('ACTIVE_DATASET_INVALID', '当前云端空间状态异常，本次没有做任何修改。')
        return { ok: true, created: false, alreadyProvisioned: true, coachCreated: coach.created, datasetId: result.datasetId, headVersion: result.headVersion, dataRevision: state.dataRevision, schemaVersion: SCHEMA_VERSION }
      }
      return { ok: true, created: true, alreadyProvisioned: false, coachCreated: coach.created, datasetId, headVersion: result.headVersion, dataRevision: 0, checksum, schemaVersion: SCHEMA_VERSION }
    } catch (e) {
      return fail(e.code || 'INIT_FAILED', e.message || '首次初始化失败。', e.extra || {})
    }
  }
}

module.exports = { SCHEMA_VERSION, INITIAL_DATASET_KIND, META, SETTINGS, DEFAULT_SETTINGS, READ_COLLECTIONS, FORBIDDEN_IDENTITY_INPUT, coachIdFor, fixedId, fingerprint, initialSnapshot, datasetRecord, settingsRecord, createService }
