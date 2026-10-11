// 真实微信 setData 的**路径语义**假件（所有驱动页面的测试都该用它）。
//
// 为什么必须有：`setData` 支持按路径只更新一个节点 ——
//   this.setData({ 'weekSlides[1].rows[3].cells[2].bookings': [...] })
// 课表刷新正是用这种方式把**改变的格子**推给视图层（见 pages/schedule/schedule.js 的
// applyLatestData：一次刷新只推真的变了的那几格，数据没变时一次 setData 都不发）。
//
// ⚠️ 只会 `Object.assign(this.data, patch)` 的假件会把 `'weekSlides[1]...'` 当成一个**字面量键**，
//    于是"页面数据看起来没更新"——那是假件的缺陷，不是产品行为。
//    假件必须与真服务端/真框架逐条同口径（宁可更严），否则这类判据缺陷在测试里永远绿。
//
// 支持：'a.b.c'、'a[0].b'、'a[0][1].b'（真实微信写 data 路径时用的是同一套语法）。
function parsePath(path) {
  const keys = []
  String(path).replace(/\[(\d+)\]/g, '.$1').split('.').forEach(part => {
    if (part === '') return
    keys.push(/^\d+$/.test(part) ? Number(part) : part)
  })
  return keys
}

function setPath(target, path, value) {
  const keys = parsePath(path)
  if (!keys.length) return target
  let node = target
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (node[key] == null || typeof node[key] !== 'object') node[key] = typeof keys[i + 1] === 'number' ? [] : {}
    node = node[key]
  }
  node[keys[keys.length - 1]] = value
  return target
}

// 与真实 setData 同语义：对 data 打一层**路径补丁**（值按原样写入，调用方自行决定要不要 clone）。
function applyPatch(target, patch) {
  Object.keys(patch || {}).forEach(key => setPath(target, key, patch[key]))
  return target
}

module.exports = { applyPatch, setPath, parsePath }
