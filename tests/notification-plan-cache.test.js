const assert = require('node:assert/strict');
const { test } = require('node:test');
const cache = require('../miniprogram/utils/notification-plan-cache');
const semester = { id: '202', start_date: '2026-09-07', end_date: '2027-01-24' };
const status = { syncedAt: 100 };
const auth = { token: 'PRIVATE_TOKEN', userInfo: { user_code: 'fixture-user' }, bizTypes: [{ id: '1' }] };
const raw = { lesson_id: '1', course_name: '课程', date: '2026-09-08', start_time: '08:30', end_time: '10:05',
  start_unit: 1, end_unit: 2, rooms: [{ name: 'F2-318' }], teachers: [{ name: '老师' }] };
const plan = [cache.toPlanLesson(raw)];
function storage() {
  const values = new Map();
  return { values, getStorageSync: key => structuredClone(values.get(key)), setStorageSync: (key, value) => values.set(key, structuredClone(value)) };
}
test('近期未变化复用，过30分钟、换学期或云端计划更新才重新核对', () => {
  const wx = storage(); cache.save(wx, auth, 'owner', semester, status, plan, null, 1000);
  const saved = cache.read(wx, auth, 'owner');
  assert.equal(cache.needsCheck(saved, semester, status, 2000), false);
  assert.equal(cache.needsCheck(saved, semester, status, 1000 + cache.CHECK_INTERVAL_MS), true);
  assert.equal(cache.needsCheck(saved, { ...semester, id: '222' }, status, 2000), true);
  assert.equal(cache.needsCheck(saved, semester, { syncedAt: 101 }, 2000), true);
});
test('数量相同的教室、时间变化会识别；顺序与重复条目不误报', () => {
  const wx = storage(); cache.save(wx, auth, 'owner', semester, status, plan, null, 1000);
  const saved = cache.read(wx, auth, 'owner');
  assert.equal(cache.samePlan(saved, semester, status, plan.concat(plan)), true);
  assert.equal(cache.samePlan(saved, semester, status, [{ ...plan[0], place: 'F2-319' }]), false);
  assert.equal(cache.samePlan(saved, semester, status, [{ ...plan[0], startTime: '10:20' }]), false);
});
test('查看当前周沿用已有响应标记变化，空周新增/撤课也识别', () => {
  const wx = storage(); cache.save(wx, auth, 'owner', semester, status, plan, null, 1000);
  cache.observeWeek(wx, auth, '202', '2026-09-07', [raw]);
  assert.equal(cache.read(wx, auth, 'owner').dirty, false);
  cache.observeWeek(wx, auth, '202', '2026-09-07', [{ ...raw, rooms: [{ name: 'F2-319' }] }]);
  assert.equal(cache.read(wx, auth, 'owner').dirty, true);
  assert.equal(cache.read(wx, auth, 'owner').changeVersion, 1);
  cache.observeWeek(wx, auth, '202', '2026-09-07', []);
  assert.equal(cache.read(wx, auth, 'owner').changeVersion, 2);
});
test('核对期间又发现变化不被完成回写清掉；账号隔离，不存原始token或课表', () => {
  const wx = storage(); cache.save(wx, auth, 'owner', semester, status, plan, null, 1000);
  const before = cache.read(wx, auth, 'owner');
  cache.observeWeek(wx, auth, '202', '2026-09-07', []);
  cache.save(wx, auth, 'owner', semester, status, plan, before, 2000);
  assert.equal(cache.read(wx, auth, 'owner').dirty, true);
  assert.equal(cache.read(wx, auth, 'other-owner'), null);
  assert.equal(cache.read(wx, { ...auth, userInfo: { user_code: 'other' } }, 'owner'), null);
  const stored = JSON.stringify([...wx.values]);
  assert.ok(!stored.includes('PRIVATE_TOKEN')); assert.ok(!stored.includes('F2-318'));
});
