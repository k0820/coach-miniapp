const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const NAMES = ['students', 'packages', 'bookings', 'incomes', 'sales', 'settings', 'customExercises']
const PAGE_SOURCE_LIMIT = 20
const PAGE_RAW_BYTES = 24 * 1024
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const coachIdFor = openId => digest(`coach:${openId}`).slice(0, 32)

async function currentCoach(openId, ownerCoachId) {
  const result = await db.collection('coaches').where({ _id: ownerCoachId, openId, status: 'active' }).limit(1).get()
  return result.data && result.data[0]
}

async function completedMigration(ownerCoachId) {
  const result = await db.collection('coach_migrations').where({ ownerCoachId, migrationVersion: 1, status: 'completed' }).limit(1).get()
  return result.data && result.data[0]
}

function orderedQuery(name, ownerCoachId, migrationId) {
  // _id is only the stable pagination cursor order. The client restores business
  // order from sortIndex/studentSortIndex after every owned document is read.
  return db.collection(name).where({ ownerCoachId, migrationId }).orderBy('_id', 'asc')
}

function safeInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

async function readPage(name, ownerCoachId, migrationId, cursor, fragmentIndex) {
  const result = await orderedQuery(name, ownerCoachId, migrationId).skip(cursor).limit(PAGE_SOURCE_LIMIT).get()
  const docs = result.data || []
  if (!docs.length) return { ok: true, collection: name, cursor, nextCursor: cursor, done: true, encoding: 'base64-json', payload: '' }

  const firstJson = JSON.stringify(docs[0]), firstBuffer = Buffer.from(firstJson, 'utf8')
  if (firstBuffer.length > PAGE_RAW_BYTES) {
    const totalFragments = Math.ceil(firstBuffer.length / PAGE_RAW_BYTES)
    if (fragmentIndex >= totalFragments) return { ok: false, code: 'INVALID_FRAGMENT', message: '读取分片位置无效。' }
    const start = fragmentIndex * PAGE_RAW_BYTES, end = Math.min(firstBuffer.length, start + PAGE_RAW_BYTES)
    return {
      ok: true, collection: name, cursor, encoding: 'base64-fragment',
      payload: firstBuffer.subarray(start, end).toString('base64'),
      fragmentIndex, totalFragments,
      nextCursor: fragmentIndex + 1 === totalFragments ? cursor + 1 : cursor,
      nextFragmentIndex: fragmentIndex + 1 === totalFragments ? 0 : fragmentIndex + 1,
      done: false
    }
  }

  const selected = []
  for (const item of docs) {
    const candidate = JSON.stringify([...selected, item]), size = Buffer.byteLength(candidate, 'utf8')
    if (size > PAGE_RAW_BYTES) break
    selected.push(item)
  }
  if (!selected.length) return { ok: false, code: 'PAGE_BUILD_FAILED', message: '云端记录无法安全分页。' }
  const payload = Buffer.from(JSON.stringify(selected), 'utf8').toString('base64')
  const nextCursor = cursor + selected.length
  return { ok: true, collection: name, cursor, nextCursor, nextFragmentIndex: 0, done: docs.length < PAGE_SOURCE_LIMIT && selected.length === docs.length, encoding: 'base64-json', payload }
}

exports.main = async event => {
  const openId = cloud.getWXContext().OPENID
  if (!openId) return { ok: false, code: 'NO_IDENTITY', message: '未能确认当前微信身份。' }
  const ownerCoachId = coachIdFor(openId)
  if (!await currentCoach(openId, ownerCoachId)) return { ok: false, code: 'COACH_NOT_FOUND', message: '未找到当前 coach。' }
  const migration = await completedMigration(ownerCoachId)
  if (!migration) return { ok: false, code: 'MIGRATION_NOT_FOUND', message: '没有找到已完成的云端迁移。' }
  const action = event && event.action
  if (action === 'metadata') {
    return {
      ok: true,
      ownerVerified: true,
      migrationId: migration.migrationId,
      migrationVersion: migration.migrationVersion,
      checksum: migration.checksum,
      byteSize: migration.byteSize,
      summary: migration.summary,
      collections: NAMES.slice()
    }
  }
  if (action === 'page') {
    const name = String(event.collection || '')
    if (!NAMES.includes(name)) return { ok: false, code: 'INVALID_COLLECTION', message: '不支持读取该集合。' }
    return readPage(name, ownerCoachId, migration.migrationId, safeInteger(event.cursor), safeInteger(event.fragmentIndex))
  }
  return { ok: false, code: 'INVALID_ACTION', message: '不支持的只读操作。' }
}
