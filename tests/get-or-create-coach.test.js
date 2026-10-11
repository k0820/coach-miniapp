const assert = require('assert')
const Module = require('module')
const crypto = require('crypto')

const records = new Map()
let currentOpenId = 'openid-a'
const matches = (record, filter) => Object.keys(filter).every(key => record && record[key] === filter[key])
const collection = {
  where(filter) {
    return {
      limit() { return this },
      async get() { return { data: [...records.values()].filter(record => matches(record, filter)) } }
    }
  },
  async add({ data }) {
    if (records.has(data._id)) throw new Error('duplicate key')
    records.set(data._id, { ...data })
    return { _id: data._id }
  }
}
const cloudMock = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  getWXContext: () => ({ OPENID: currentOpenId }),
  database: () => ({ collection: name => {
    assert.strictEqual(name, 'coaches')
    return collection
  }, serverDate: () => 'server-time' })
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudMock
  return originalLoad.call(this, request, parent, isMain)
}
const { main } = require('../cloudfunctions/getOrCreateCoach/index')
Module._load = originalLoad

const coachIdFor = openId => crypto.createHash('sha256').update(`coach:${openId}`).digest('hex').slice(0, 32)

async function run() {
  let result = await main({ ownerCoachId: 'forged', OPENID: 'forged' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.created, true)
  assert.strictEqual(result.coach.coachId, coachIdFor('openid-a'))
  assert.strictEqual(records.get(result.coach.coachId).openId, 'openid-a')
  assert.strictEqual(result.coach.openId, undefined)

  const firstId = result.coach.coachId
  result = await main({ ownerCoachId: 'another-forged-owner' })
  assert.strictEqual(result.created, false)
  assert.strictEqual(result.coach.coachId, firstId)
  assert.strictEqual(records.size, 1)

  currentOpenId = 'openid-b'
  result = await main({ ownerCoachId: firstId })
  assert.strictEqual(result.created, true)
  assert.notStrictEqual(result.coach.coachId, firstId)
  assert.strictEqual(records.size, 2)

  currentOpenId = ''
  result = await main({ ownerCoachId: firstId })
  assert.strictEqual(result.code, 'IDENTITY_MISSING')
  assert.strictEqual(records.size, 2)

  const source = require('fs').readFileSync(require('path').join(__dirname, '../cloudfunctions/getOrCreateCoach/index.js'), 'utf8')
  assert.ok(source.includes('cloud.getWXContext()'))
  assert.ok(!/event\.(OPENID|openId|coachId|ownerCoachId|documentId)/.test(source))
  console.log('get-or-create-coach tests: PASS (14 checks)')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
