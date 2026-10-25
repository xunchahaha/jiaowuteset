const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../cloudfunctions/scheduleReminderFunctions/settings');
const L = require('../cloudfunctions/scheduleReminderFunctions/logic');
const { createService } = require('../cloudfunctions/scheduleReminderFunctions/service');

function memoryStore() {
  let data = new Map(), tail = Promise.resolve();
  return {
    transaction(work) {
      const run = tail.then(async () => {
        const copy = structuredClone(data);
        const result = await work({ get: async (name, id) => structuredClone(copy.get(name + ':' + id) || null),
          set: async (name, id, value) => copy.set(name + ':' + id, structuredClone(value)) });
        data = copy;
        return result;
      });
      tail = run.catch(() => {}); return run;
    },
    due: async (now, limit) => [...data.entries()].filter(([k, p]) => k.startsWith(C.PROFILE + ':') && p.enabled && p.estimatedCredits > 0 && p.nextDueAt > 0 && p.nextDueAt <= now)
      .map(([, p]) => structuredClone(p)).sort((a, b) => a.nextDueAt - b.nextDueAt).slice(0, limit),
    records: async (openid, limit) => [...data.entries()].filter(([k, r]) => k.startsWith(C.RECORD + ':') && r.openid === openid)
      .map(([, r]) => structuredClone(r)).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  };
}
const BASE = Date.parse('2026-09-09T07:00:00+08:00');
const course = (id = '1', startTime = '08:30') => ({ lessonId: id, date: '2026-09-09', startTime,
  courseName: '数据结构', teacher: '示例教师', place: 'F2-318' });
const receipt = id => ({ templateId: C.TEMPLATE_ID, accepted: true, requestId: 'request_fixture_' + id });
function setup(send) {
  let now = BASE;
  const sent = [], store = memoryStore();
  const service = createService(store, async p => { sent.push(p); return send ? send(p) : { errCode: 0 }; }, () => now);
  return { service, sent, store, time: value => { now = value; } };
}
async function enable(s, openid = 'owner', courses = [course()]) {
  await s.sync(openid, { lessons: courses });
  await s.settings(openid, { enabled: true, leadMinutes: 30 });
}

test('订阅同意记一次、重复回执幂等、拒绝不增加、账号隔离和应用上限', async () => {
  const { service: s } = setup();
  await Promise.all([s.recordSubscription('owner', receipt(1)), s.recordSubscription('owner', receipt(1))]);
  assert.equal((await s.status('owner')).estimatedCredits, 1);
  assert.equal((await s.status('other')).estimatedCredits, 0);
  await assert.rejects(s.recordSubscription('owner', { ...receipt(2), accepted: false }));
  await assert.rejects(s.recordSubscription('owner', { ...receipt(2), templateId: 'other' }));
  for (let i = 2; i <= 202; i++) await s.recordSubscription('owner', receipt(i));
  assert.equal((await s.status('owner')).estimatedCredits, C.CREDIT_LIMIT);
});
test('并发定时触发只发送一次、只扣一次；重新同步课表不重发', async () => {
  const { service: s, sent, time } = setup(); await enable(s);
  await s.recordSubscription('owner', receipt(1)); await s.recordSubscription('owner', receipt(2));
  time(Date.parse('2026-09-09T08:00:00+08:00'));
  await Promise.all([s.dispatch(), s.dispatch()]);
  assert.equal(sent.length, 1); assert.equal((await s.status('owner')).estimatedCredits, 1);
  assert.equal(sent[0].touser, 'owner'); assert.equal(sent[0].templateId, C.TEMPLATE_ID);
  assert.deepEqual(Object.keys(sent[0].data), ['time1', 'thing2', 'thing5', 'thing6', 'thing7']);
  assert.equal(sent[0].data.thing6.value, 'F2-318');
  await s.sync('owner', { lessons: [course()] }); await s.dispatch(); assert.equal(sent.length, 1);
});
test('开关关闭、额度不足和未到提前时间均不发；改提前时间立即重算', async () => {
  const { service: s, sent, time } = setup(); await enable(s);
  time(Date.parse('2026-09-09T08:00:00+08:00')); await s.dispatch(); assert.equal(sent.length, 0);
  await s.recordSubscription('owner', receipt(1));
  await s.settings('owner', { enabled: false, leadMinutes: 30 }); await s.dispatch(); assert.equal(sent.length, 0);
  await s.settings('owner', { enabled: true, leadMinutes: 5 }); await s.dispatch(); assert.equal(sent.length, 0);
  assert.equal((await s.status('owner')).nextDueAt, Date.parse('2026-09-09T08:25:00+08:00'));
  time(Date.parse('2026-09-09T08:25:00+08:00')); await s.dispatch(); assert.equal(sent.length, 1);
});
test('已错过提醒时间不补发、不扣次数，并留下记录', async () => {
  const { service: s, sent, time } = setup(); await enable(s); await s.recordSubscription('owner', receipt(1));
  time(Date.parse('2026-09-09T08:06:00+08:00')); await s.dispatch();
  const state = await s.status('owner'); assert.equal(sent.length, 0); assert.equal(state.estimatedCredits, 1);
  assert.equal(state.records[0].status, 'skipped');
});
test('微信43101校正旧额度，保留发送期间新增的同意记录', async () => {
  let release;
  const { service: s, time } = setup(() => new Promise(resolve => { release = resolve; }));
  await enable(s); await s.recordSubscription('owner', receipt(1)); time(Date.parse('2026-09-09T08:00:00+08:00'));
  const pending = s.dispatch(); while (!release) await new Promise(resolve => setImmediate(resolve));
  await s.recordSubscription('owner', receipt(2)); release({ errCode: 43101 }); await pending;
  const state = await s.status('owner'); assert.equal(state.estimatedCredits, 1); assert.equal(state.records[0].status, 'failed');
});
test('明确错误退回估计次数；网络不确定结果不重发、不伪称送达', async () => {
  for (const code of [47003, 0]) {
    const { service: s, time, sent } = setup(() => { throw { errCode: code }; });
    await enable(s); await s.recordSubscription('owner', receipt(1)); time(Date.parse('2026-09-09T08:00:00+08:00'));
    await s.dispatch(); await s.dispatch();
    const state = await s.status('owner'); assert.equal(sent.length, 1);
    assert.equal(state.estimatedCredits, code ? 1 : 0); assert.equal(state.records[0].status, code ? 'failed' : 'unknown');
  }
});
test('旧请求43101晚于新请求成功，不恢复已经消耗的新订阅次数', async () => {
  let release, attempts = 0;
  const { service: s, time } = setup(() => ++attempts === 1 ? new Promise(resolve => { release = resolve; }) : { errCode: 0 });
  await enable(s, 'owner', [course('a'), course('b')]); await s.recordSubscription('owner', receipt(1));
  time(Date.parse('2026-09-09T08:00:00+08:00'));
  const old = s.dispatch(); while (!release) await new Promise(resolve => setImmediate(resolve));
  await s.recordSubscription('owner', receipt(2)); await s.dispatch();
  release({ errCode: 43101 }); await old;
  assert.equal(attempts, 2); assert.equal((await s.status('owner')).estimatedCredits, 0);
});
test('测试发送幂等、消耗真实订阅机会且与正式提醒分离', async () => {
  const { service: s, sent, time } = setup(); await enable(s);
  await assert.rejects(s.test('owner', { requestId: 'test_fixture_no_credit' }));
  await s.recordSubscription('owner', receipt(1)); await s.recordSubscription('owner', receipt(2));
  await s.test('owner', { requestId: 'test_fixture_request' });
  await s.test('owner', { requestId: 'test_fixture_request' }); assert.equal(sent.length, 1);
  time(Date.parse('2026-09-09T08:00:00+08:00')); await s.dispatch(); assert.equal(sent.length, 2);
});
test('云函数仅信平台OPENID和触发器来源，客户端伪造dispatch/OPENID无效', async () => {
  let context = { OPENID: 'real-owner', SOURCE: 'wx_client' }, forwarded;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/scheduleReminderFunctions/index'), 'utf8'), {
    module, exports: module.exports,
    require: name => name === 'wx-server-sdk' ? { init() {}, database: () => ({}), getWXContext: () => context,
      openapi: { subscribeMessage: { send() {} } } } : name === './settings' ? C : name === './store' ? { createStore: () => ({}) } : {
      createService: () => ({ status: async openid => { forwarded = openid; return {}; }, dispatch: async () => ({}) })
    }
  });
  assert.equal((await module.exports.main({ type: 'getStatus', openid: 'victim' })).success, true);
  assert.equal(forwarded, 'real-owner');
  assert.equal((await module.exports.main({ type: 'dispatchScheduleReminders', Type: 'Timer' })).success, false);
  context = { SOURCE: 'http' }; assert.equal((await module.exports.main({ Type: 'Timer', TriggerName: C.TRIGGER_NAME })).success, false);
  context = { SOURCE: 'wx_trigger' }; assert.equal((await module.exports.main({})).success, true);
});
test('模板字段长度、UTC+8时间、无效日期与过量计划检查', () => {
  const values = L.message('owner', { ...course(), courseName: '😀'.repeat(30) }, '提醒').data;
  assert.equal(Array.from(values.thing2.value).length, 20);
  assert.equal(L.normalizePlan([course()], BASE)[0].startAt, Date.parse('2026-09-09T08:30:00+08:00'));
  assert.throws(() => L.normalizePlan([{ ...course(), date: '2026-02-30' }], BASE));
  assert.throws(() => L.normalizePlan(Array(1001).fill(course()), BASE));
});
