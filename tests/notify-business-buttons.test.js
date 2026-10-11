const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const pages = [
  'components/booking-modal/booking-modal.js',
  'pages/session/session.js',
  'pages/member-book-slots/member-book-slots.js',
  'pages/member-bookings/member-bookings.js'
]
for (const file of pages) {
  const source = read(file)
  assert.ok(!/runBusinessTap|requestNextAfterAction/.test(source), `${file} 仍连接一次性微信提醒`)
}
assert.ok(read('pages/member-book-slots/member-book-slots.js').includes('this.runSubmit(request)'))
assert.ok(read('pages/member-bookings/member-bookings.js').includes('resolve(true)'))
assert.ok(read('pages/session/session.js').includes('this.cancel(false)'))

console.log('notify business buttons tests: PASS (subscription prompts removed, business actions preserved)')
