const assert = require('assert')
const clone = value => JSON.parse(JSON.stringify(value))
const values = {}
const writes = []
global.wx = {
  getStorageSync: key => values[key],
  setStorageSync: (key, value) => { writes.push(key); values[key] = clone(value) }
}
const pending = require('../utils/pending-booking-request')

const base = { studentId: 'stu-1', packageId: 'pkg-1', date: '2026-09-16', hour: 16, minute: 0 }
const view = { id: 'pending:x', studentId: 'stu-1', studentName: '假学员', packageId: 'pkg-1', date: '2026-09-16', hour: 16, minute: 0, typeName: '常规训练', price: 100, status: 'booked' }

// 1. 环境隔离：不同 environment 使用不同 Storage key
assert.equal(pending.key('production'), 'coachPendingBookingRequests:production')
assert.equal(pending.key('sandbox'), 'coachPendingBookingRequests:sandbox')
assert.notEqual(pending.key('production'), pending.key('sandbox'))

// 2. bookingKey 归一化：分钟缺省为 0，小时/分钟会 Number 化
const key = pending.bookingKey(base)
assert.equal(key, 'stu-1|pkg-1|2026-09-16|16|0')
assert.equal(pending.bookingKey({ ...base, minute: undefined }), key)
assert.equal(pending.bookingKey({ ...base, hour: '16', minute: '00' }), key)
assert.notEqual(pending.bookingKey({ ...base, hour: 17 }), key)

// 3. create 必须回读校验，且带 dataset 隔离
const created = pending.create('production', 'ds-p', key, 'req-1', base, view, 1000)
assert.equal(created.created, true)
assert.equal(created.entry.version, 1)
assert.equal(created.entry.status, 'pending')
assert.equal(created.entry.environment, 'production')
assert.deepEqual(created.entry.payload, base)
assert.equal(pending.get('production', 'ds-p', key).requestId, 'req-1')
assert.equal(pending.get('production', 'ds-s', key), null, '不同 dataset 不得读到该记录')
assert.equal(pending.get('sandbox', 'ds-p', key), null, '不同 environment 不得读到该记录')
assert.equal(pending.list('production', 'ds-p').length, 1)
assert.equal(pending.list('production', 'ds-s').length, 0)
assert.equal(pending.list('sandbox', 'ds-s').length, 0)
assert.equal(pending.list('production', '').length, 0, '缺少 datasetId 时不得返回任何记录')

// 4. 同一时段重复 create 不会产生第二条，并复用同一个 requestId（连点只算一次）
const again = pending.create('production', 'ds-p', key, 'req-should-not-win', base, view, 2000)
assert.equal(again.created, false)
assert.equal(again.entry.requestId, 'req-1')
assert.equal(pending.list('production', 'ds-p').length, 1)

// 5. patch 必须带上正确的 requestId，过期请求不能改到新记录
assert.equal(pending.patch('production', 'ds-p', key, 'req-other', { status: 'unknown' }), null)
assert.equal(pending.get('production', 'ds-p', key).status, 'pending')
assert.equal(pending.patch('production', 'ds-p', key, 'req-1', { status: 'confirming', attempt: 1 }).status, 'confirming')
assert.equal(pending.get('production', 'ds-p', key).attempt, 1)
assert.equal(pending.patch('production', 'ds-s', key, 'req-1', { status: 'unknown' }), null, 'dataset 不匹配不得写入')

// 6. remove 只允许同一 requestId 精确移除（防止删掉更新一轮的记录）
assert.equal(pending.remove('production', 'ds-p', key, 'req-other'), false)
assert.equal(pending.list('production', 'ds-p').length, 1)
assert.equal(pending.remove('production', 'ds-p', key, 'req-1'), true)
assert.equal(pending.list('production', 'ds-p').length, 0)

// 7. matches：只有学员+课时包+日期+小时+分钟全部一致才算云端已落库
assert.equal(pending.matches(base, { ...base }), true)
assert.equal(pending.matches(base, { ...base, minute: undefined }), true)
assert.equal(pending.matches(base, { ...base, hour: 17 }), false)
assert.equal(pending.matches(base, { ...base, packageId: 'pkg-2' }), false)
assert.equal(pending.matches(base, null), false)

// 8. 本机存储只写自身 key，绝不碰 cache / coachDB
const bookingStoreKeys = new Set(writes)
assert.ok([...bookingStoreKeys].every(item => item === 'coachPendingBookingRequests:production'))
assert.ok(![...bookingStoreKeys].some(item => item.indexOf('Cache') >= 0 || item === 'coachDB'))

// 9. 损坏的 Storage 值按空处理，不抛异常
values['coachPendingBookingRequests:production'] = ['not-an-object']
assert.deepEqual(pending.list('production', 'ds-p'), [])
values['coachPendingBookingRequests:production'] = null
assert.deepEqual(pending.list('production', 'ds-p'), [])

// 10. sandbox 与 production 可同时各留一条互不影响
pending.create('production', 'ds-p', key, 'req-p', base, view, 3000)
pending.create('sandbox', 'ds-s', key, 'req-s', base, view, 4000)
assert.equal(pending.list('production', 'ds-p')[0].requestId, 'req-p')
assert.equal(pending.list('sandbox', 'ds-s')[0].requestId, 'req-s')
assert.equal(pending.list('production', 'ds-p').length, 1)

console.log('pending booking request tests: PASS (storage isolation, readback, immutable requestId, precise removal)')
