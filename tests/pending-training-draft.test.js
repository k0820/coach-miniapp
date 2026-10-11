const assert = require('assert')
const values = {}
const clone = value => JSON.parse(JSON.stringify(value))
global.wx = { getStorageSync: key => values[key], setStorageSync: (key, value) => { values[key] = clone(value) } }
const draft = require('../utils/pending-training-draft')
const content = { items: [{ name: '假动作', sets: '4' }], notes: '初稿', category: '综合训练', duration: 60 }
draft.write('sandbox', 'dataset-A', 'booking-A', content)
assert.equal(draft.get('sandbox', 'dataset-A', 'booking-A').version, 1)
assert.equal(draft.get('production', 'dataset-A', 'booking-A'), null)
assert.equal(draft.get('sandbox', 'dataset-B', 'booking-A'), null)
const first = draft.begin('sandbox', 'dataset-A', 'booking-A', () => 'request-A')
draft.settle('sandbox', 'dataset-A', 'booking-A', 'request-A', 'unknown')
assert.equal(draft.begin('sandbox', 'dataset-A', 'booking-A', () => 'wrong-request').requestId, 'request-A')
content.items[0].sets = '5'
content.notes = '最新版'
draft.write('sandbox', 'dataset-A', 'booking-A', content)
assert.equal(first.content.items[0].sets, '4', 'in-flight payload must remain immutable')
assert.equal(draft.get('sandbox', 'dataset-A', 'booking-A').content.items[0].sets, '5')
draft.settle('sandbox', 'dataset-A', 'booking-A', 'request-A', 'succeeded')
assert.equal(draft.get('sandbox', 'dataset-A', 'booking-A').content.notes, '最新版', 'newer edit survives older success')
assert.equal(draft.get('sandbox', 'dataset-A', 'booking-A').submission, null)
draft.begin('sandbox', 'dataset-A', 'booking-A', () => 'request-B')
draft.settle('sandbox', 'dataset-A', 'booking-A', 'request-B', 'succeeded')
assert.equal(draft.get('sandbox', 'dataset-A', 'booking-A'), null)
console.log('pending training draft tests passed')
