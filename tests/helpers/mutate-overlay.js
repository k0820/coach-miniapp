'use strict'
// ⛔ 反证（变异）脚本专用底座：把「改坏源码」这件事**只发生在内存里**。
//
// 背景（2026-10-04 专项）：历史反证脚本的做法是
//     readFileSync(真源码) → writeFileSync(变异体) → 跑测试 → writeFileSync(原文还原)
// 一旦中途崩溃 / 被中断 / 还原用的是"启动时读到的污染态"，磁盘上就会留下变异体，
// 而且**重跑多少遍都不会恢复**（restore 把污染当原文写回去）。AGENTS.md 第 5 条明令禁止改生产源码。
//
// 本模块提供三条通道，全部不落盘：
//   ① `fs` 覆盖层：对**正式源码路径**的 readFileSync/writeFileSync 走内存 Map（AGENTS.md 允许的"测试替身"）；
//   ② `Module._extensions['.js'/.json']` 注入：require 也吃到覆盖层（AGENTS.md 允许的 "require.cache 注入"）；
//   ③ `worker_threads.Worker` 自动携带覆盖层：子线程跑被测测试时，看到的同样是变异后的源码。
//
// ⛔ 对正式源码的 rename/unlink/rm/truncate/copyFile 一律 **抛错硬拦**（这些无法用覆盖层表达）。
// ⛔ 非源码路径（报告、截图、临时产物）的写入照旧走真实 fs，不破坏脚本原有行为。

const fs = require('fs')
const path = require('path')
const Module = require('module')
const workerThreads = require('worker_threads')

const PROJ = path.resolve(__dirname, '..', '..')
const SRC_DIRS = ['pages', 'utils', 'components', 'cloudfunctions', 'styles']
const SRC_FILES = ['app.js', 'app.json', 'app.wxss']

const normKey = p => {
  const abs = path.resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

const SRC_PREFIXES = SRC_DIRS.map(d => normKey(path.join(PROJ, d)) + path.sep)
const SRC_EXACT = new Set(SRC_FILES.map(f => normKey(path.join(PROJ, f))))

function isSourcePath(p) {
  if (typeof p !== 'string') return false
  const k = normKey(p)
  if (SRC_EXACT.has(k)) return true
  return SRC_PREFIXES.some(pre => k.startsWith(pre))
}

// ───────────────────────── 覆盖层状态
const overlay = new Map()   // normKey -> content（内存里的"磁盘内容"）
const originals = new Map() // normKey -> 真实磁盘内容（首次真实读取时记下，仅用于快照最小化）
let installed = false
const stats = { sourceWrites: 0, blocked: 0, testRuns: 0 }

function encode(content, opts) {
  const enc = typeof opts === 'string' ? opts : (opts && opts.encoding)
  if (enc === undefined || enc === null || enc === 'buffer') return Buffer.from(content, 'utf8')
  if (enc === 'utf8' || enc === 'utf-8' || enc === 'utf16le' || enc === 'latin1' || enc === 'ascii' || enc === 'binary') {
    if (enc === 'utf8' || enc === 'utf-8') return content
    return Buffer.from(content, 'utf8').toString(enc)
  }
  return Buffer.from(content, 'utf8').toString(enc)
}

// 真实磁盘内容（绕过覆盖层）
let readReal = p => fs.readFileSync(p, 'utf8')

function currentOf(abs) {
  const k = normKey(abs)
  if (overlay.has(k)) return overlay.get(k)
  return readReal(abs)
}

function setOverlay(abs, content) {
  const k = normKey(abs)
  overlay.set(k, String(content))
  // require 缓存会让"变异后的源码"读不到 ⇒ 同步清掉这一条（require.cache 注入的关键一步）
  const resolved = path.resolve(abs)
  if (require.cache[resolved]) delete require.cache[resolved]
  if (require.cache[k]) delete require.cache[k]
  stats.sourceWrites += 1
}

function hardBlock(what, p) {
  stats.blocked += 1
  throw new Error('[mutate-overlay] 禁止对正式源码执行 ' + what + '（反证只允许内存覆盖层）：' + p)
}

// ───────────────────────── 安装
function install() {
  if (installed) return api
  installed = true

  readReal = p => RealReadSync.call(fs, p, 'utf8')
  const RealReadSync = fs.readFileSync
  const RealWriteSync = fs.writeFileSync
  const RealWriteFile = fs.writeFile
  const RealAppendSync = fs.appendFileSync
  const RealRenameSync = fs.renameSync
  const RealUnlinkSync = fs.unlinkSync
  const RealRmSync = fs.rmSync
  const RealTruncateSync = fs.truncateSync
  const RealCopySync = fs.copyFileSync

  fs.readFileSync = function patchedReadFileSync(p, opts) {
    if (typeof p === 'string') {
      const k = normKey(p)
      if (overlay.has(k)) return encode(overlay.get(k), opts)
    }
    return RealReadSync.apply(fs, arguments)
  }

  fs.writeFileSync = function patchedWriteFileSync(p, data, opts) {
    if (isSourcePath(p)) { setOverlay(p, data); return undefined }
    return RealWriteSync.apply(fs, arguments)
  }

  fs.writeFile = function patchedWriteFile(p, data, opts, cb) {
    if (isSourcePath(p)) {
      setOverlay(p, data)
      const cb2 = typeof opts === 'function' ? opts : cb
      if (typeof cb2 === 'function') cb2(null)
      return undefined
    }
    return RealWriteFile.apply(fs, arguments)
  }

  fs.appendFileSync = function patchedAppendFileSync(p, data, opts) {
    if (isSourcePath(p)) { setOverlay(p, currentOf(p) + String(data)); return undefined }
    return RealAppendSync.apply(fs, arguments)
  }

  fs.renameSync = function (a, b) { if (isSourcePath(a) || isSourcePath(b)) return hardBlock('renameSync', a + ' → ' + b); return RealRenameSync.apply(fs, arguments) }
  fs.unlinkSync = function (p) { if (isSourcePath(p)) return hardBlock('unlinkSync', p); return RealUnlinkSync.apply(fs, arguments) }
  if (RealRmSync) fs.rmSync = function (p) { if (isSourcePath(p)) return hardBlock('rmSync', p); return RealRmSync.apply(fs, arguments) }
  fs.truncateSync = function (p) { if (isSourcePath(p)) return hardBlock('truncateSync', p); return RealTruncateSync.apply(fs, arguments) }
  fs.copyFileSync = function (a, b) { if (isSourcePath(a) || isSourcePath(b)) return hardBlock('copyFileSync', a + ' → ' + b); return RealCopySync.apply(fs, arguments) }

  // ② require 也要吃到覆盖层（Node 的 cjs loader 内部用的是**解构后**的 readFileSync，
  //    只改 fs.readFileSync 影响不到它，必须直接接管扩展名处理器）
  const extJs = Module._extensions['.js']
  const extJson = Module._extensions['.json']
  Module._extensions['.js'] = function patchedJs(mod, filename) {
    const k = normKey(filename)
    if (overlay.has(k)) { mod._compile(overlay.get(k), filename); return }
    return extJs.call(this, mod, filename)
  }
  Module._extensions['.json'] = function patchedJson(mod, filename) {
    const k = normKey(filename)
    if (overlay.has(k)) { mod.exports = JSON.parse(overlay.get(k)); return }
    return extJson.call(this, mod, filename)
  }

  patchWorker()
  return api
}

// ───────────────────────── ③ Worker 自动携带覆盖层
const ENTRY = path.join(__dirname, 'mutate-worker-entry.js')
const RealWorker = workerThreads.Worker
let workerPatched = false

function patchWorker() {
  if (workerPatched) return
  workerPatched = true
  function OverlayWorker(file, options) {
    const wd = options && options.workerData
    if (wd && wd.__mutateTest) return new RealWorker(file, options)
    const next = Object.assign({}, options, {
      workerData: Object.assign({}, wd, { __mutateTest: file, __mutateOverlay: snapshot() })
    })
    return new RealWorker(ENTRY, next)
  }
  OverlayWorker.prototype = RealWorker.prototype
  try { workerThreads.Worker = OverlayWorker } catch (e) { /* 只读属性时降级：脚本需显式改用 runTest() */ }
}

// 快照：只带"与真实磁盘不同"的条目，减小传输量
function snapshot() {
  const out = {}
  for (const [k, content] of overlay) {
    const abs = path.resolve(k)
    let real = null
    try { real = readReal(abs) } catch (e) { real = null }
    if (real === null || real !== content) out[abs] = content
  }
  return out
}

function applySnapshot(obj) {
  for (const abs of Object.keys(obj || {})) overlay.set(normKey(abs), obj[abs])
}

// ───────────────────────── 对外 API
function runTest(testAbs) {
  install()
  return new Promise(resolve => {
    stats.testRuns += 1
    let worker
    try {
      worker = new RealWorker(ENTRY, {
        stdout: true,
        stderr: true,
        workerData: { __mutateTest: testAbs, __mutateOverlay: snapshot() }
      })
    } catch (error) {
      resolve({ code: 1, rc: 1, ok: false, tail: '[mutate-overlay] Worker 启动失败：' + String((error && error.stack) || error) })
      return
    }
    let out = ''
    worker.stdout.on('data', chunk => { out += String(chunk) })
    worker.stderr.on('data', chunk => { out += String(chunk) })
    worker.on('error', error => { out += String((error && error.stack) || error) })
    worker.on('exit', code => resolve({ code, rc: code, ok: code === 0, tail: out }))
  })
}

const api = {
  install,
  runTest,
  snapshot,
  applySnapshot,
  isSourcePath,
  clear: () => { overlay.clear() },
  stats,
  ENTRY,
  RealWorker
}

module.exports = api
