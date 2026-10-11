// 只判断能否解除临时发送冻结；不写业务数据、不发送命令。
function check({ bookingId, hold, local, cloud }) {
  const reject = reason => ({ ready: false, reason })
  if (!hold || hold.bookingId !== bookingId || !local || !local.ok || hold.datasetId !== local.datasetId) return reject('冻结目标与本机数据不一致')
  if (local.booking && local.booking.status !== 'booked') return reject('本机缓存中的课程状态已变化')
  if (!local.booking || !Array.isArray(local.incomes) || local.incomes.length) return reject('本机缓存中的课程或收入状态不一致')
  if (local.draft || local.entries.length || local.failed.length || local.intents.length) return reject('本机仍有草稿或待处理命令')
  if (!cloud || cloud.ok !== true || cloud.strict !== true || cloud.state !== 'A_BOTH_COMMANDS_NOT_SUCCEEDED') return reject('云端诊断不是明确的未完课状态')
  if (cloud.datasetId !== hold.datasetId || !cloud.booking || cloud.booking.bookingId !== bookingId || cloud.booking.status !== 'booked') return reject('云端课程或数据代次不一致')
  if (!Array.isArray(cloud.booking.items) || cloud.booking.items.length || !Array.isArray(cloud.incomes) || cloud.incomes.length) return reject('云端训练内容或收入状态已变化')
  if (!Array.isArray(cloud.receipts) || cloud.receipts.length) return reject('云端仍有相关命令回执')
  if (!cloud.package || !cloud.booking.packageId || cloud.package.packageId !== cloud.booking.packageId || cloud.package.status === 'reversed' || !(Number(cloud.package.remaining) > 0)) return reject('精确课包不可安全使用')
  if (!local.booking || local.booking.packageId !== cloud.booking.packageId) return reject('本机与云端精确课包不一致')
  return { ready: true, baseline: { used: cloud.package.used, remaining: cloud.package.remaining, incomeCount: 0, revision: cloud.dataRevision } }
}
module.exports = { check }
