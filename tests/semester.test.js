const assert = require('assert');
const { pickCurrentSemesterItem } = require('../miniprogram/utils/semester');

const semesterResponse = {
  cur_semester_id: '202',
  semesters: [
    { id: '222', start_date: '2027-03-01', end_date: '2027-07-11' },
    { id: '202', start_date: '2026-09-07', end_date: '2027-01-24' },
    { id: '183', start_date: '2026-03-09', end_date: '2026-07-19' }
  ]
};

assert.strictEqual(pickCurrentSemesterItem(semesterResponse, '2026-09-01').id, '202');
assert.strictEqual(pickCurrentSemesterItem({
  semesters: semesterResponse.semesters
}, '2026-04-01').id, '183');
assert.strictEqual(pickCurrentSemesterItem({
  data: semesterResponse
}, '2026-09-01').id, '202');
assert.strictEqual(pickCurrentSemesterItem({
  semesters: [{ id: '1', current: 'false' }, { id: '2', current: 'true' }]
}, '2026-09-01').id, '2');

console.log('semester helper ok');
