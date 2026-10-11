const assert = require('assert')
const copy = value => JSON.parse(JSON.stringify(value))
let value = { students: [{ id: 's1', name: '张三', packages: [{ id: 'p1', type: '常规训练', total: 40, used: 5, remaining: 35, price: 266.66, saleId: 'sale1', status: 'active' }] }], bookings: [{ id: 'future', studentId: 's1', packageId: 'p1', status: 'booked', typeName: '常规训练', price: 266.66 }], incomes: [], sales: [{ id: 'sale1', source: 'course', status: 'active', studentId: 's1', packageId: 'p1', typeName: '常规训练', quantity: 40, unitPrice: 266.66, amount: 10000, date: '2026-09-01' }], settings: {}, customExercises: [] }
global.wx = { getStorageSync: key => key === 'coachDB' ? copy(value) : null, setStorageSync: (key, next) => { if (key === 'coachDB') value = copy(next) } }
delete require.cache[require.resolve('../utils/db')]; delete require.cache[require.resolve('../utils/course-sales')]
const { updateCourseSale } = require('../utils/course-sales')

let result = updateCourseSale('sale1', { total: 30, quantity: 28, remaining: 25, unitPrice: 300, amount: 7777, date: '2026-08-31' }, { confirmInconsistent: true })
assert.equal(result.ok, true); assert.equal(value.students[0].packages[0].total, 30); assert.equal(value.students[0].packages[0].used, 5); assert.equal(value.students[0].packages[0].remaining, 25); assert.equal(value.sales[0].quantity, 28); assert.equal(value.sales[0].unitPrice, 300); assert.equal(value.sales[0].amount, 7777)

result = updateCourseSale('sale1', { total: 3 }, { confirmInconsistent: false })
assert.equal(result.ok, false); assert.equal(result.needsConfirm, true); assert.equal(value.students[0].packages[0].total, 30); assert.equal(value.students[0].packages[0].used, 5)
result = updateCourseSale('sale1', { total: 3 }, { confirmInconsistent: true })
assert.equal(result.ok, true); assert.equal(value.students[0].packages[0].total, 3); assert.equal(value.students[0].packages[0].used, 5); assert.equal(value.students[0].packages[0].remaining, 25); assert.equal(value.sales[0].quantity, 28)

console.log('local course sale alignment tests: PASS')
