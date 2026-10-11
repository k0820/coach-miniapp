// 测试用的**确定性随机源**（2026-10-02）
//
// ★★ 它为什么存在 ★★
//   `m3-p2-short-code` ② 原来用**真随机**生成 20 万枚短码、断言"零碰撞"。那是一条**掷骰子**的断言：
//     码空间 32^8 = 2^40，抽 2×10^5 枚 ⇒ 生日碰撞概率 P ≈ n²/(2N) ≈ **1.8%**
//   ⇨ 完整回归大约每 55 次偶发失败一次，而失败与代码改动毫无关系。
//   ⛔ 偶发失败的测试是有害的：它会训练大家"再跑一次就好"，最后真正变红的那次也没人当回事。
//
// ★★ 怎么改成必然 ★★
//   `short-code.generate()` 做的是 **5 字节 → 逐 5 bit 取 8 次 → 8 个字符**。
//   5 字节 = 40 bit，8 × 5 bit = 40 bit ⇒ 这是一个**双射**：不同输入字节 ⇒ 必然不同输出。
//   ⇒ 只要把 `crypto.randomBytes` 钉成一串**互异且可复现**的输入，"零碰撞"就从
//      "98.2% 的概率成立"变成"数学上必然成立"；而实现一旦丢信息，不同输入就会撞车 ⇒ 立刻变红。
//
// ⛔ 用法纪律：
//   · 一定用 `withDeterministicBytes` 包起来 —— 它保证 `finally` 还原。
//     `crypto` 是 Node 的**模块单例**，泄漏出去会污染同一进程里的其它断言（很难查）。
//   · 还原之后才允许继续调用真实的 `crypto.randomBytes`（历史长码样本等）。

// 一个可复现的 `randomBytes` 替身：把 40 bit 计数器按**小端**拆成字节。
//   ⛔ 关键性质：counter 递增 ⇒ 5 字节序列两两互异（对 counter < 2^40 恒成立）
//      ⇒ **"互异性"断言（零碰撞）用它最合适**：结论是数学必然，不是概率。
//   ⚠️ 但它**不适合做分布统计**：counter 递增时高字节变化很慢（40000 轮里高字节几乎不动），
//      相应的高位 5-bit 段铺不满 32 个字符 ⇒ 分布类断言要用下面的 `seededSource`。
function counterSource(start = 1) {
  let counter = start
  return size => {
    const out = Buffer.alloc(size)
    let rest = counter
    for (let index = 0; index < size; index += 1) { out[index] = rest % 256; rest = Math.floor(rest / 256) }
    counter += 1
    return out
  }
}

// 固定种子的伪随机源（LCG · Numerical Recipes 参数）—— 给**分布类**断言用。
//   ⛔ 仍然是**确定性**的：同一个种子 ⇒ 同一个序列 ⇒ 每次运行统计结果一模一样（不会偶发越界）。
//   ⛔ 仍然保证"5 连窗口两两互异"：LCG 的 state 在一个周期内不重复 ⇒ 任意两个不同起点
//      走出的连续 5 步不可能相同 ⇒ 拿它做"零碰撞"断言同样是数学必然。
//   ⚠️ 取 `state >>> 16`（中间字节）而不是低字节 —— 低字节的周期性明显（LCG 的老毛病）。
function seededSource(seed = 0x2545f491) {
  let state = seed >>> 0
  return size => {
    const out = Buffer.alloc(size)
    for (let index = 0; index < size; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      out[index] = (state >>> 16) & 0xff
    }
    return out
  }
}

// 临时把模块的 `crypto.randomBytes` 换成 `source`，**finally 一定还原**。
function withDeterministicBytes(source, fn) {
  const original = sourceModule.randomBytes
  sourceModule.randomBytes = size => {
    const bytes = source(size)
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  }
  try { return fn() } finally { sourceModule.randomBytes = original }
}

// 固定一组字节（反复返回同一内容）⇒ 用来验证 `generate` 的**纯函数性**。
function fixedSource(bytes) {
  const frozen = Buffer.from(bytes)
  return () => Buffer.from(frozen)
}

// 把 40 bit 写成 5 字节（**大端**，与 ALPHABET 从左到右的位序一致）。
function bytesFromBits(bits) {
  const out = Buffer.alloc(5)
  let rest = BigInt(bits)
  for (let index = 4; index >= 0; index -= 1) { out[index] = Number(rest & 0xffn); rest >>= 8n }
  return out
}

const sourceModule = require('crypto')

module.exports = { counterSource, seededSource, withDeterministicBytes, fixedSource, bytesFromBits }
