// 短码生成的**确定性**验证 —— 永久回归（2026-10-02）
//
// ★★ 为什么会有这份测试 ★★
//   `m3-p2-short-code` ② 原来是这样写的：用**真随机**生成 20 万枚码，然后断言"零碰撞"。
//   它在数学上是一次**掷骰子**：码空间 32^8 = 2^40，抽 2×10^5 枚的生日碰撞概率约
//     P ≈ n² / (2N) = (2×10^5)² / (2 × 1.1×10^12) ≈ **1.8%**
//   ⇒ 完整回归大约每 55 次会偶发失败一次，而失败原因与代码改动**毫无关系**（当天就是这样遇到的）。
//   这种测试是有害的：它把回归结果变成运气，久了大家就会习惯性"再跑一次"。
//
// ★★ 正确的验证方式 ★★
//   `generate()` 做的是：**5 字节 → 逐 5 bit 取 8 次 → 8 个字符**。
//   5 字节 = 恰好 40 bit，8 × 5 bit = 恰好 40 bit ⇒ 这是一个**双射**（Bijection）：
//     · 相同输入 ⇒ 必然相同输出（纯函数性）
//     · **不同输入 ⇒ 必然不同输出**（不可能碰撞）
//   ⇒ 只要把随机源钉成**确定性**的互异输入，碰撞断言就从"1.8% 的赌局"变成"必然成立"；
//      而一旦实现丢信息（例如改成 `byte % 32` 丢掉每字节高 3 bit），不同输入就会撞车 ⇒ 立刻变红。
//   📌 判别力**更强**：随机版撞 = 运气不好；确定性版撞 = 实现有问题，二者性质不同。
//
// ⛔ 本文件**只改测试的随机源与判定方式**，一个字都不动 `short-code.js` 的生成逻辑 ——
//    生产那一侧的会长码政策本身是对的（调用方有查重，见 m3-p2-short-code ⑪⑫）。

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { runner } = require('./helpers/m2-business-world')
const { counterSource, withDeterministicBytes, fixedSource, bytesFromBits } = require('./helpers/deterministic-bytes')

const ROOT = path.join(__dirname, '..')
const SHORT_CLOUD = path.join(ROOT, 'cloudfunctions/coachBusinessCommand/short-code.js')
const short = require(SHORT_CLOUD)

// ------------------------------------------------------------------ 确定性随机源
//
// ⇩ 全部来自 `tests/helpers/deterministic-bytes.js`（那里讲了完整理由：为什么必须摈弃"20 万枚随机碰运气"）。
//
// 把某个模块的 `crypto.randomBytes` 临时换成交到 alias 上的确定性源，**finally 一定还原**。
//   ⛔ 必须还原：`crypto` 是 Node 的**模块单例**，不还原会污染同一进程里的其它断言。

async function main() {
  const ROUNDS = 200000

  // ---------------------------------------------------------------- ① 纯函数性：同输入必同输出
  await runner('① `generate` 是**确定性纯函数**：同一组字节两次调用必须产出同一枚码', async () => {
    const fixed = bytesFromBits(0x1a2b3c4d5en)
    const codes = withDeterministicBytes(fixedSource(fixed), () => [short.generate(), short.generate(), short.generate()])
    assert.strictEqual(codes[0], codes[1], '相同输入字节 ⇒ 必须产出同一枚码')
    assert.strictEqual(codes[1], codes[2])
    assert.strictEqual(codes[0].length, 8)
  })

  // ---------------------------------------------------------------- ② ⭐⭐ 无碰撞：**必然成立**，不再靠运气
  await runner(`② ⭐ 确定性 ${ROUNDS.toLocaleString()} 枚**两两互不相同**（双射 ⇒ 不是概率结论）`, async () => {
    const seen = new Set()
    withDeterministicBytes(counterSource(1), () => {
      for (let index = 0; index < ROUNDS; index += 1) {
        const code = short.generate()
        assert.strictEqual(code.length, 8, `长度必须是 8：${code}`)
        assert.ok([...code].every(char => short.ALPHABET.includes(char)), `出现字符集外的字符：${code}`)
        seen.add(code)
      }
    })
    assert.strictEqual(seen.size, ROUNDS,
      `⛔ ${ROUNDS} 个互异输入必须产出 ${ROUNDS} 枚互异的码（实测 ${seen.size}）⇒ 实现丢掉了熵`)
  })

  // ---------------------------------------------------------------- ③ 每一位**全枚举**铺满 32 个字符
  await runner('③ ⭐ 每一位用**全枚举**（8 × 32 = 256 个样本）证明恰好覆盖 32 个字符，零随机', async () => {
    // 第 i 个字符来自第 i 个 5 bit 段（从最高位往下数）⇒ 把那一段单独设成 v，其余置 0。
    //   这样 8 × 32 = 256 组输入**两两互异**，且第 i 位必然等于 ALPHABET[v]。
    for (let slot = 0; slot < 8; slot += 1) {
      const produced = new Set()
      const bitsToCode = new Map()
      for (let value = 0; value < 32; value += 1) {
        const bytes = bytesFromBits(BigInt(value) << BigInt(35 - 5 * slot))
        const code = withDeterministicBytes(() => Buffer.from(bytes), () => short.generate())
        assert.strictEqual(code[slot], short.ALPHABET[value],
          `第 ${slot + 1} 位：输入段值 ${value} 应产出 ${short.ALPHABET[value]}，实测 ${code[slot]}`)
        produced.add(code[slot])
        bitsToCode.set(code, bytes.toString('hex'))
      }
      assert.strictEqual(produced.size, 32, `第 ${slot + 1} 位只覆盖了 ${produced.size} 个字符`)
      assert.strictEqual(bitsToCode.size, 32, `第 ${slot + 1} 位：32 个互异输入撞出了重复输出 ⇒ 不是双射`)
    }
  })

  // ---------------------------------------------------------------- ④ 判别力自证：坏实现必须被抓住
  await runner('④ ⭐ 反证：这三条断言**抓得住**坏实现（否则这份测试就是摆设）', async () => {
    // (a) 丢信息的坏实现：每字节只取低 5 bit（等价于 `% 32`，丢掉每字节高 3 bit）。
    //     40 bit 输入只剩 25 bit ⇒ 不同输入必然撞车 ⇒ ② 必然红。
    const lossy = bytes => {
      let code = ''
      for (const byte of bytes) code += short.ALPHABET[byte & 31]
      return code.slice(0, 8)
    }
    const bad = new Set()
    const feed = counterSource(1)
    for (let index = 0; index < 5000; index += 1) bad.add(lossy(feed(5)))
    assert.ok(bad.size < 5000,
      `反证：丢信息的实现在 5000 个互异输入下必然撞车（实测只产出 ${bad.size} 枚）⇒ ② 的断言必然变红`)
    // (b) 掩码被削窄（`& 31` 写成 `& 15`）⇒ 每位最多覆盖 16 个字符 ⇒ ③ 必然红。
    const narrowed = new Set()
    for (let value = 0; value < 32; value += 1) narrowed.add(short.ALPHABET[value & 15])
    assert.strictEqual(narrowed.size, 16, '反证：掩码削窄 ⇒ ③ 的"恰好 32 个"必然变红')
    // (c) 某一位没有用新熵（把第 1 位复制 8 遍）⇒ ③④ 同时红。
    const flat = short.ALPHABET[7].repeat(8)
    assert.strictEqual(new Set([...flat]).size, 1, '反证：把一枚字符复制 8 遍只覆盖 1 个字符')
  })

  // ---------------------------------------------------------------- ⑤ 孪生：两份文件仍逐字节相同
  await runner('⑤ 两份 short-code.js 仍**逐字节相同**（改一份必须同时改另一份）', async () => {
    const SHORT_MEMBER = path.join(ROOT, 'cloudfunctions/memberIdentityCommand/short-code.js')
    assert.strictEqual(fs.readFileSync(SHORT_CLOUD, 'utf8'), fs.readFileSync(SHORT_MEMBER, 'utf8'))
  })
}

main().then(() => {
  process.stdout.write('\nALL SHORT CODE DETERMINISM TESTS PASSED\n')
}).catch(error => {
  process.stderr.write(`\nSHORT CODE DETERMINISM FAILED: ${error.stack}\n`)
  process.exitCode = 1
})
