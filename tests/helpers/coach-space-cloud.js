// 首次云端空间开通的**共用假服务端**。
//
// 两个永久回归共用同一份假件，避免"服务端语义被模拟两遍、口径走偏"：
//   · tests/init-coach-space.test.js      —— 服务端本身（身份 / 幂等 / 隔离 / 端到端回读）
//   · tests/coach-space-bootstrap.test.js —— 客户端开通器（联网 / 断网 / 杀进程 / 超时 / 老账号 …）
//
// 关键：这里的服务端**不是手写 if/else**，而是把**真实的** `cloudfunctions/initMyCoachSpace/service.js`
// 跑在一个假 CloudBase db 上；读端也用**真实的** `cloudfunctions/readMyActiveCoachData/integrity.js`
// 的 reconstruct + fingerprint。假件只比真服务端更严，绝不放宽。
const { createService, coachIdFor, fixedId } = require('../../cloudfunctions/initMyCoachSpace/service')
const { reconstruct, fingerprint } = require('../../cloudfunctions/readMyActiveCoachData/integrity')
const { planChanges } = require('../../cloudfunctions/readMyActiveCoachData/changes')

const READ_COLLECTIONS = ['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
const BUSINESS_COLLECTIONS = ['students', 'student_tombstones', 'packages', 'bookings', 'incomes', 'sales', 'customExercises']
const SANDBOX_COLLECTIONS = ['coach_sandbox_heads', 'coach_sandbox_revisions', 'coach_sandbox_receipts']
const META_COLLECTIONS = ['coaches', 'coach_data_heads', 'coach_datasets', 'coach_data_revisions', 'coach_command_receipts']
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))

// 查询匹配：等值 + `db.command.gt(n)`。
// 第 7 轮的增量读取要用 `revisionAfter > sinceRevision` 取收据（真实 CloudBase 的
// `db.command.gt` 回一个 QueryCommand，这里同构地回 `{$gt:n}`；调用方写法完全一样）。
// ⚠️ 等值那一支与改动前**逐字相同**，所以既有假件一条断言都不用改。
function matchesQuery(row, query) {
  return Object.keys(query).every(key => {
    const expected = query[key]
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && Object.prototype.hasOwnProperty.call(expected, '$gt')) {
      return Number(row[key]) > Number(expected.$gt)
    }
    return row[key] === expected
  })
}

function createCoachSpaceCloud({ now = () => 1700000000000 } = {}) {
  const stores = {}
  const calls = []
  let failure = ''
  function reset() {
    Object.keys(stores).forEach(name => delete stores[name])
    ;[...READ_COLLECTIONS, ...META_COLLECTIONS, ...SANDBOX_COLLECTIONS].forEach(name => { stores[name] = new Map() })
    calls.length = 0
    failure = ''
  }
  reset()

  function scope(target) {
    return {
      // `db.command.gt(n)` 的最小同构（见 matchesQuery）。
      command: { gt: value => ({ $gt: value }) },
      collection(name) {
        if (!target[name]) target[name] = new Map()
        const rows = () => [...target[name].values()]
        return {
          doc(id) {
            return {
              async set({ data }) { if (name === failure) throw new Error('injected'); target[name].set(id, { ...copy(data), _id: id }) },
              async remove() { target[name].delete(id) }
            }
          },
          where(query) {
            let limit = Infinity, skip = 0, order = null
            const api = {
              limit(value) { limit = value; return api },
              skip(value) { skip = value; return api },
              orderBy(field, direction) { order = { field, direction }; return api },
              async get() {
                let found = rows().filter(row => matchesQuery(row, query))
                if (order) found = found.sort((a, b) => (a[order.field] < b[order.field] ? -1 : a[order.field] > b[order.field] ? 1 : 0) * (order.direction === 'desc' ? -1 : 1))
                return { data: found.slice(skip, skip + limit).map(copy) }
              }
            }
            return api
          },
          async add({ data }) { if (name === failure) throw new Error('injected'); target[name].set(data._id, copy(data)); return { _id: data._id } }
        }
      }
    }
  }

  // 事务：与真实 CloudBase 同口径（在副本上执行，成功才提交；失败整份丢弃 ⇒ 不留半份空间）
  let queue = Promise.resolve()
  const db = {
    ...scope(stores),
    runTransaction(work) {
      const run = queue.then(async () => {
        const draft = {}
        Object.keys(stores).forEach(name => { draft[name] = new Map([...stores[name]].map(([key, value]) => [key, copy(value)])) })
        const out = await work(scope(draft))
        Object.keys(draft).forEach(name => { stores[name] = draft[name] })
        return out
      })
      queue = run.then(() => {}, () => {})
      return run
    }
  }

  function ownerGroups(owner) {
    const head = stores.coach_data_heads.get(fixedId('coach-data-head', owner))
    const datasetId = head && head.activeDatasetId
    const physical = {}, logical = {}
    READ_COLLECTIONS.forEach(name => {
      const rows = [...stores[name].values()].filter(row => row.ownerCoachId === owner && row.datasetId === datasetId).sort((a, b) => (a._id < b._id ? -1 : 1)).map(copy)
      physical[name] = rows
      logical[name === 'student_tombstones' ? 'studentTombstones' : name] = rows
    })
    return { head, datasetId, physical, logical }
  }

  // 与 cloudfunctions/readMyActiveCoachData/index.js 同构的读端（同一条 reconstruct + fingerprint）
  function serveActive(openId) {
    return async (name, data) => {
      if (name !== 'readMyActiveCoachData') return { ok: false, code: 'UNEXPECTED_FUNCTION' }
      const owner = coachIdFor(openId)
      const { head, datasetId, physical } = ownerGroups(owner)
      if (!head || !datasetId) return { ok: false, code: 'ACTIVE_DATASET_NOT_FOUND' }
      const dataset = stores.coach_datasets.get(fixedId('coach-dataset', owner, datasetId))
      const revision = stores.coach_data_revisions.get(fixedId('coach-data-revision', owner, datasetId))
      if (!dataset || !revision) return { ok: false, code: 'ACTIVE_DATASET_INVALID' }
      const live = fingerprint(reconstruct(physical))
      if (data.action === 'metadata') return { ok: true, environment: 'production', datasetId, dataRevision: revision.dataRevision, headVersion: head.headVersion, activationChecksum: dataset.checksum, activationByteSize: dataset.byteSize, activationSummary: dataset.summary, collections: READ_COLLECTIONS.slice() }
      if (data.action === 'integrity') return { ok: true, environment: 'production', datasetId, dataRevision: revision.dataRevision, ...live }
      // 增量读取（1.1.9 第 7 轮）。这里**不自写一套增量逻辑**，而是与真实云函数
      // （cloudfunctions/readMyActiveCoachData/index.js 的 liveChanges）共用同一份纯函数 planChanges，
      // 收据口径也逐字一致（与业务写同事务、revisionAfter 严格连续）—— 否则"服务端语义被模拟两遍、
      // 口径走偏"，测试全绿而真机慢。
      if (data.action === 'changes') {
        if (!Number.isInteger(data.sinceRevision) || data.sinceRevision < 0) return { ok: false, code: 'CHANGES_INVALID_SINCE' }
        const payload = { ok: true, environment: 'production', datasetId, dataRevision: revision.dataRevision, ...live }
        if (data.sinceRevision === revision.dataRevision) return { ...payload, unchanged: true, from: data.sinceRevision }
        if (data.sinceRevision > revision.dataRevision) return { ok: false, code: 'CHANGES_AHEAD', currentRevision: revision.dataRevision }
        const receipts = [...stores.coach_command_receipts.values()]
          .filter(row => row.ownerCoachId === owner && row.datasetId === datasetId && row.status === 'succeeded' && Number(row.revisionAfter) > data.sinceRevision)
        const planned = planChanges({ groups: physical, receipts, sinceRevision: data.sinceRevision, toRevision: revision.dataRevision })
        if (!planned.ok) return planned
        return { ...payload, from: data.sinceRevision, to: revision.dataRevision, delta: planned.delta }
      }
      if (data.action === 'page') {
        const rows = physical[data.collection] || []
        return { ok: true, environment: 'production', collection: data.collection, datasetId, dataRevision: revision.dataRevision, cursor: 0, nextCursor: rows.length, nextFragmentIndex: 0, done: true, encoding: 'base64-json', payload: Buffer.from(JSON.stringify(rows), 'utf8').toString('base64') }
      }
      return { ok: false, code: 'INVALID_ACTION' }
    }
  }

  return {
    stores, calls, db, reset, ownerGroups, serveActive,
    setFailure: name => { failure = name || '' },
    counts: () => Object.fromEntries(Object.keys(stores).map(name => [name, stores[name].size])),
    snapshot: () => JSON.stringify(Object.keys(stores).sort().map(name => [name, [...stores[name].entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))])),
    spaceCount: () => stores.coach_datasets.size,
    datasetIdsOf: owner => [...stores.coach_datasets.values()].filter(row => row.ownerCoachId === owner).map(row => row.datasetId),
    provision: (openId, event = { action: 'provision' }) => {
      calls.push({ name: 'initMyCoachSpace', event: copy(event) })
      return createService({ db, getOpenId: () => openId, now })(event)
    }
  }
}

module.exports = { createCoachSpaceCloud, READ_COLLECTIONS, BUSINESS_COLLECTIONS, SANDBOX_COLLECTIONS, META_COLLECTIONS, copy }
