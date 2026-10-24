// 正式区永久会员二维码：环境隔离、长期复用、主动换码、领取后自动读取原课包。
const assert = require('assert')
const WORLD = require('./helpers/m2-business-world')
const { fixedId } = require('../cloudfunctions/coachBusinessCommand/core')
const directoryModule = require('../cloudfunctions/coachBusinessCommand/member-directory')

function setup() {
  const w = WORLD.createWorld()
  const coach = w.seedCoach('prod-coach-open', 'prod-dataset', 'PRODCOACH')
  w.put('coach_data_heads', fixedId('coach-data-head', coach.owner), {
    ownerCoachId: coach.owner, environment: 'production', activeDatasetId: coach.datasetId, headVersion: 1
  })
  w.put('coach_data_revisions', fixedId('coach-data-revision', coach.owner, coach.datasetId), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, dataRevision: 0
  })
  w.seedStudent(coach, 'prod-student-a', '正式会员甲')
  w.seedStudent(coach, 'prod-student-b', '正式会员乙')
  w.put('packages', w.businessId('packages', coach.owner, coach.datasetId, 'prod-package-a'), {
    ownerCoachId: coach.owner, datasetId: coach.datasetId, studentId: 'prod-student-a', packageId: 'prod-package-a',
    data: { id: 'prod-package-a', type: '拉伸恢复', total: 12, remaining: 9, reserved: 0, used: 3, price: 180, status: 'active' }
  })
  let openId = coach.open
  let now = 1900000000000
  const qrCalls = []
  const cloud = {
    openapi: { wxacode: { getUnlimited: async payload => { qrCalls.push(payload); return { buffer: Buffer.from('production-permanent-member-qr') } } } },
    uploadFile: async payload => ({ fileID: `cloud://${payload.cloudPath}` })
  }
  const service = directoryModule.createDirectory({ db: w.db, cloud, getOpenId: () => openId, environment: 'production', now: () => ++now })
  const call = (actorOpenId, action, payload = {}) => {
    openId = actorOpenId
    return service({ action, environment: 'production', requestId: `prod-qr-${String(++now)}`, payload })
  }
  return { w, coach, call, qrCalls, advance: ms => { now += Number(ms || 0) } }
}

;(async () => {
  const x = setup()
  const first = await x.call(x.coach.open, 'getMemberClaimQr', { studentRef: 'prod-student-a' })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.match(first.scene, /^p[0-9a-f]{31}$/)
  assert.equal(first.permanent, true)
  assert.equal(first.expiresAt, 0)
  assert.equal(x.qrCalls[0].env_version, 'release')
  assert.equal(x.qrCalls[0].scene, first.scene)
  assert.equal(JSON.stringify(x.qrCalls[0]).includes('prod-student-a'), false, '正式二维码不能暴露学员编号')

  // 真机复现：体验版分享链接能打开新代码，但旧实现把二维码固定成 release，
  // 扫码就会落到线上旧版。请求 trial 时必须换成同一资料的体验码；正式发布后
  // 再打开页面则自动换回 release，资料关系保持不变。
  const trial = await x.call(x.coach.open, 'getMemberClaimQr', { studentRef: 'prod-student-a', qrEnvVersion: 'trial' })
  assert.equal(trial.ok, true, JSON.stringify(trial))
  assert.notEqual(trial.scene, first.scene, '体验版二维码不能复用正式版图片')
  assert.equal(x.qrCalls[1].env_version, 'trial', '体验版二维码必须打开体验版，和分享链接一致')
  const releaseAgain = await x.call(x.coach.open, 'getMemberClaimQr', { studentRef: 'prod-student-a', qrEnvVersion: 'release' })
  assert.equal(releaseAgain.ok, true, JSON.stringify(releaseAgain))
  assert.notEqual(releaseAgain.scene, trial.scene, '正式发布后必须自动换回 release 二维码')
  assert.equal(x.qrCalls[2].env_version, 'release')

  x.advance(5 * 365 * 24 * 60 * 60 * 1000)
  const afterFiveYears = await x.call('prod-member-open', 'previewMemberClaimQr', { scene: releaseAgain.scene })
  assert.equal(afterFiveYears.ok, true, '正式永久码多年后仍能预览')
  const again = await x.call(x.coach.open, 'getMemberClaimQr', { studentRef: 'prod-student-a' })
  assert.equal(again.scene, releaseAgain.scene, '同一渠道的永久码必须稳定复用，避免反复消耗生成额度')
  assert.equal(x.qrCalls.length, 3)

  // 不设置产品层人数上限：同一教练可以继续为第二位会员建立独立永久码。
  const second = await x.call(x.coach.open, 'getMemberClaimQr', { studentRef: 'prod-student-b' })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.notEqual(second.scene, first.scene)
  assert.equal(x.w.stores.member_members.size, 2)

  const claimed = await x.call('prod-member-open', 'claimMemberByQr', { scene: releaseAgain.scene })
  assert.equal(claimed.ok, true, JSON.stringify(claimed))
  const dashboard = await x.call('prod-member-open', 'dashboard')
  assert.equal(dashboard.ok, true, JSON.stringify(dashboard))
  assert.equal(dashboard.member.displayName, '正式会员甲')
  assert.equal(dashboard.summary.available, 9)
  assert.equal(dashboard.packages.length, 1)
  assert.equal(dashboard.packages[0].typeName, '拉伸恢复')

  const rotated = await x.call(x.coach.open, 'rotateMemberClaimQr', { studentRef: 'prod-student-a' })
  assert.equal(rotated.ok, true)
  assert.notEqual(rotated.scene, releaseAgain.scene)
  assert.equal((await x.call('another-open', 'previewMemberClaimQr', { scene: releaseAgain.scene })).ok, false, '主动换码后旧正式码必须失效')
  assert.equal((await x.call('prod-member-open', 'previewMemberClaimQr', { scene: rotated.scene })).state, 'mine', '换码不影响已领取会员自动登录')

  const sandboxCollections = [...x.w.stores.member_sandbox_members.values()]
  assert.equal(sandboxCollections.length, 0, '正式区流程不能写入测试区会员集合')
  console.log('PASS production permanent member QR: reusable, unlimited members, secure claim, original packages and active rotation')
})().catch(error => { console.error(error); process.exitCode = 1 })
