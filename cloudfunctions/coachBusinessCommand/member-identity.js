const crypto = require('crypto')

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const memberIdFor = openId => sha(`member:${openId}`).slice(0, 32)
const fixedId = (...parts) => sha(parts.join(':')).slice(0, 32)
const MEMBERS = 'member_members'

async function first(scope, name, query) {
  const response = await scope.collection(name).where(query).limit(1).get()
  return response && response.data && response.data[0] || null
}

// 当前微信已经领取“专属会员资料”时，会员目录中的 memberId 才是唯一身份；
// 旧账号没有这张目录行时，继续使用历史 OPENID 哈希，保证零迁移兼容。
async function resolveMemberIdentity({ db, environment, openId }) {
  const legacyMemberId = memberIdFor(openId)
  if (String(environment || '').toLowerCase() !== 'production') {
    return { memberId: legacyMemberId, memberRow: null, source: 'legacy' }
  }
  try {
    const row = await first(db, MEMBERS, { openId: String(openId) })
    if (row && row.memberId && String(row.status || 'active') !== 'removed') {
      return { memberId: String(row.memberId), memberRow: row, source: 'directory' }
    }
  } catch (error) {
    // 旧环境没有目录集合时保持旧行为；身份解析失败不能把正式链路改成写入或自动建档。
  }
  return { memberId: legacyMemberId, memberRow: null, source: 'legacy' }
}

async function resolveMemberScopes({ db, environment, memberId, memberRow, claimsCollection }) {
  if (String(environment || '').toLowerCase() === 'production') {
    let row = memberRow || null
    try { if (!row) row = await first(db, MEMBERS, { memberId: String(memberId) }) } catch (error) { row = null }
    if (row && row.ownerCoachId && row.ownerDatasetId && row.studentId) {
      return [{
        claimId: String(row.claimId || fixedId('member-directory-claim', row.memberId)),
        memberId: String(row.memberId), coachId: String(row.ownerCoachId),
        datasetId: String(row.ownerDatasetId), studentId: String(row.studentId),
        status: 'verified', source: 'member-directory'
      }]
    }
  }
  const response = await db.collection(claimsCollection).where({ memberId, status: 'verified' }).limit(200).get()
  return response && response.data || []
}

module.exports = { MEMBERS, memberIdFor, resolveMemberIdentity, resolveMemberScopes }
