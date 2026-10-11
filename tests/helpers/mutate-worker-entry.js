'use strict'
// 反证专用 Worker 入口：把父线程传来的**内存覆盖层**装好，再加载真正的被测测试。
// 用法（由 mutate-overlay 自动完成）：
//   new Worker(ENTRY, { workerData: { __mutateTest: <测试文件绝对路径>, __mutateOverlay: { <绝对路径>: <变异后内容> } } })
// ⛔ 全程不落盘：被测测试看到的"源码"是内存里的变异副本，磁盘上的正式源码一字未动。
const { workerData } = require('worker_threads')
const overlay = require('./mutate-overlay')

overlay.applySnapshot(workerData && workerData.__mutateOverlay)
overlay.install()

const target = workerData && workerData.__mutateTest
if (!target) {
  console.error('[mutate-worker-entry] 缺少 __mutateTest')
  process.exit(1)
}
require(target)
