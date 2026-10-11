// 8 位人工短码（M3-P2-3 · 2026-09-30）
//
// ★★ 为什么需要它 ★★
//   项目里有两种"要人口头念 / 手抄 / 截图转述"的码，原来都又长又容易读错：
//     · 认领码（`memberIdentityCommand` 生成）原为 `randomBytes(18).toString('base64url')` = **24 位**，
//       人工抄写基本不可能对；
//     · 共享码（`sharing.js` 生成）原为 `randomBytes(5).toString('hex').toUpperCase()` = **10 位十六进制**，
//       只有 0-9A-F ⇒ `6/B`、`8/B`、`0/D` 极易混。
//   现在两处统一为 **8 位 Crockford 风格短码**。
//
// ★★ 铁律（改这个文件前先读）★★
//   ① 字符集恰好 32 个：`0-9 A-Z`，**去掉 I / L / O / U**（分别易与 1 / 1 / 0 / V 混）。
//   ② 生成必须**无取模偏差**：5 字节 = 恰好 40 bit = 8 × 5 bit ⇒ 逐 5 bit 取值即可，一个 bit 都不浪费。
//      ⛔ 不许写成 `randomBytes(n)[i] % 字符集长度` 这种"按字节取模"的写法：它对**非 2 的幂**的字符集
//         一定有偏差（256 = 4 × 62 + 8 ⇒ `% 62` 时前 8 个字符各多抽到一次）。
//      ⚠️ 这里故意说清楚一个容易被想当然的点：当前字符集是 32（恰好 2^5），**`% 32` 本身并没有偏差**
//         （256 = 8 × 32 整除）。所以本实现用位缓冲**不是为了修 `% 32`**，而是因为这个理由更牢固：
//         字符集一旦从 32 改成别的（base62 之类）"按字节取模"立刻出错，位缓冲则始终正确。
//      ✅ 由 `m3-p2-short-code` ③ 锁死：8 个位各自都要铺满 32 个字符；并**全枚举 256 个字节**实证 `% 62` 的偏差。
//   ③ 输入侧按 Crockford 约定把误输入**纠正**回来：`I`/`L`→`1`、`O`→`0`、`U`→`V`，并忽略空格与连字符。
//      人念"零"会被听成 O、念"一"会被听成 I / L ⇒ 这一层纠正让口述码真的可用。
//   ④ ⛔ **8 位码必须查重**：两个调用方的主键都是"码的 hash"（`fixedId`）⇒ 撞码是**静默覆盖**而不是报错，
//      会让旧码悄悄指向另一条记录。调用方生成后一定要先查一次"这个码是否已存在"再落库。
//   ⑤ ⛔ 这个文件在**两个云函数目录里各存一份**（微信云函数按目录独立部署，跨目录 require 在真机上
//      找不到文件）。两份必须**逐字节相同**，由 `m3-p2-short-code` 的契约测试锁死：
//      ⇒ **改一份必须同时改另一份**，否则测试立刻变红。
//
// ★★ 兼容性（⛔ 别再退回长码）★★
//   短码空间是 32^8 ≈ 8.5e11。对"15 分钟有效、同时活跃数在千级"的认领码与共享码完全够用，
//   而且 `isShort()` 能把"历史长码"分流出去：**长码一个字符都不改写**（认领码的历史口径是
//   区分大小写的 base64url，一旦被 toUpperCase 就再也兑换不了 —— 这是必须守住的一条）。

const crypto = require('crypto')

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const LENGTH = 8

// 生成一枚 8 位短码（无取模偏差，见铁律 ②）。
function generate() {
  const bytes = crypto.randomBytes(5)
  let buffer = 0, bits = 0, code = ''
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5 && code.length < LENGTH) {
      code += ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return code
}

// 判据：这个输入**看起来**是不是一枚 8 位短码（大小写不敏感，忽略空格 / 连字符）。
//   ⛔ 它**不改写**输入 —— 专门给"新旧两种码分流"用。
function isShort(value) {
  const raw = String(value == null ? '' : value).trim().toUpperCase().replace(/[\s-]/g, '')
  if (raw.length !== LENGTH) return false
  return [...correct(raw)].every(char => ALPHABET.includes(char))
}

// 误输入纠正：只对**长度正好是 8** 的字符串动手（长度不对 ⇒ 原样返回，历史长码靠这个活下来）。
function correct(value) {
  const raw = String(value == null ? '' : value)
  if (raw.length !== LENGTH) return raw
  return raw.replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V')
}

// 归一化（给**大小写不敏感**的调用方用，如共享码）：trim → 大写 → 去空白/连字符 → 若像短码则纠正。
//   ⛔ 长度不是 8 的输入**只做 trim**：不认识的东西不许被悄悄改写。
function normalize(value) {
  const raw = String(value == null ? '' : value).trim()
  if (!isShort(raw)) return raw
  return correct(raw.toUpperCase().replace(/[\s-]/g, ''))
}

module.exports = { ALPHABET, LENGTH, generate, isShort, correct, normalize }
