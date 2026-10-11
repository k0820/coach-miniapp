// 本机业务事务（阶段 2：Local-first + Cloud Sync）。
//
// 铁律：**业务规则只有一份**。这里不重写任何规则，而是直接复用云端那套已经验证过的纯函数
// （utils/cloud-command-engine.js 的 handlers —— 它与云端 coachBusinessCommand 的 handlers 同构，
//   由 tests/cloud-command-engine.test.js 与 tests/coach-business-command-*.test.js 逐条钉住）。
//
// 因此本机事务与云端事务在**同一个载荷**上必然得到**同一份结果**：
// 同一个 code、同一条 message、同样的副作用。这是「本机先行、云端复算」能成立的前提 ——
// 如果本机是一套规则、云端是另一套，本地先行就会不断制造需要人工收拾的差异。
//
// 本模块是纯函数（不碰 wx、不碰 Storage、不写 cache），只做「把命令应用到一份数据状态上」。
const { handlers } = require('./cloud-command-engine')

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const array = value => Array.isArray(value) ? value : []

// 本机临时 id 前缀。必须一眼能认出来：它只在本机有效，云端转正后会由 idMap 换成正式 id。
const LOCAL_ID_PREFIX = 'loc_'
let idSequence = 0
function newLocalId(kind) {
  idSequence += 1
  return `${LOCAL_ID_PREFIX}${kind}_${Date.now().toString(36)}${idSequence.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
const isLocalId = value => typeof value === 'string' && value.indexOf(LOCAL_ID_PREFIX) === 0

// 状态形状与 cloud-command-engine.emptyState 对齐；其余字段（例如 studentTombstones）原样保留。
function normalize(base) {
  const db = base && typeof base === 'object' ? clone(base) : {}
  db.students = array(db.students)
  db.bookings = array(db.bookings)
  db.incomes = array(db.incomes)
  db.sales = array(db.sales)
  db.customExercises = array(db.customExercises)
  db.settings = db.settings && typeof db.settings === 'object' ? db.settings : {}
  db.students.forEach(student => { if (!Array.isArray(student.packages)) student.packages = [] })
  return db
}

// 本机业务事务。返回 { ok, db, result, ids } 或 { ok:false, code, message, extra }。
//   · code / message 与云端**逐字同源**（同一个 handlers 抛出的同一个 commandError）。
//   · ids 记录本次事务里 context.id(kind) 生成的本机临时 id —— 由调用方持久化，
//     云端转正后再用 idMap 把后续命令的载荷改写过去。
function applyCommand(base, command, payload, context = {}) {
  const handler = handlers[command]
  if (typeof handler !== 'function') return { ok: false, code: 'COMMAND_NOT_ALLOWED', message: `本机业务事务不支持命令：${command}` }
  const db = normalize(base)
  const ids = {}
  const now = typeof context.now === 'function' ? context.now : () => Date.now()
  const factory = typeof context.id === 'function' ? context.id : newLocalId
  const ctx = {
    now,
    id: kind => { const value = factory(kind); ids[kind] = value; return value },
    step: () => {}
  }
  try {
    const result = handler(db, clone(payload) || {}, ctx)
    return { ok: true, db, result, ids }
  } catch (error) {
    return { ok: false, code: (error && error.commandCode) || 'COMMAND_FAILED', message: (error && error.message) || '本机事务失败。', extra: (error && error.extra) || {} }
  }
}

// 载荷里的 id 改写：本机临时 id → 正式 id。
// 只有「值完全等于一个已知本机 id」的字符串才会被替换，绝不猜、绝不做前缀匹配。
function rewriteIds(value, idMap) {
  if (!idMap || !Object.keys(idMap).length) return value
  if (typeof value === 'string') return Object.prototype.hasOwnProperty.call(idMap, value) ? idMap[value] : value
  if (Array.isArray(value)) return value.map(item => rewriteIds(item, idMap))
  if (value && typeof value === 'object') {
    const out = {}
    Object.keys(value).forEach(key => { out[key] = rewriteIds(value[key], idMap) })
    return out
  }
  return value
}

// 本机事务产生的结果字段 ↔ cloud-command-engine 里 context.id(kind) 的 kind 对应表。
// 用于「命令成功 → 把本机临时 id 换成云端正式 id」。
const RESULT_ID_FIELD = Object.freeze({
  student: 'studentId',
  package: 'packageId',
  sale: 'saleId',
  booking: 'bookingId',
  income: 'incomeId',
  exercise: 'customExerciseId'
})

module.exports = { applyCommand, rewriteIds, normalize, newLocalId, isLocalId, LOCAL_ID_PREFIX, RESULT_ID_FIELD }
