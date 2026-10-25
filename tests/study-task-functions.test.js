const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.SERVER_BASE_URL = 'https://server.example.com';
process.env.SERVER_HMAC_KEY = 'test-hmac-key';
process.env.STUDY_ORDER_OPEN = '1';   // 流程测试按下单开放跑；关闭态单独测

const C = require('../cloudfunctions/studyTaskFunctions/settings');
const L = require('../cloudfunctions/studyTaskFunctions/logic');
const { createService } = require('../cloudfunctions/studyTaskFunctions/service');

function memoryStore() {
  let data = new Map(), tail = Promise.resolve();
  const val = (name, id) => structuredClone(data.get(name + ':' + id) || null);
  return {
    transaction(work) {
      const run = tail.then(async () => {
        const copy = structuredClone(data);
        const result = await work({
          get: async (n, i) => { const v = copy.get(n + ':' + i); return v ? structuredClone(v) : null; },
          set: async (n, i, v) => copy.set(n + ':' + i, structuredClone(v))
        });
        data = copy; return result;
      });
      tail = run.catch(() => {}); return run;
    },
    task: async id => val(C.TASK, id),
    tasksByOpenid: async openid => [...data.entries()]
      .filter(([k, v]) => k.startsWith(C.TASK + ':') && v.openid === openid)
      .map(([, v]) => structuredClone(v)),
    courseSpendReceipts: async openid => [...data.entries()]
      .filter(([k, v]) => k.startsWith('xpay_receipts:') && v.openid === openid && v.kind === 'course_spend')
      .map(([, v]) => structuredClone(v)),
    pendingNotify: async limit => [...data.entries()]
      .filter(([k, v]) => k.startsWith(C.TASK + ':') && v.notified !== true)
      .map(([, v]) => structuredClone(v)).slice(0, limit)
  };
}

const BASE = Date.parse('2026-10-11T20:00:00+08:00');

function setup({ tasks = {}, db = null, send } = {}) {
  let now = BASE;
  const sent = [], calls = [];
  const store = memoryStore();
  const http = async (method, url, body, headers) => {
    calls.push({ method, url, body, headers });
    const path = new URL(url).pathname;
    if (path === '/v1/tasks' && method === 'POST') {
      return { status: 200, body: { success: true, data: { taskId: 't_abc123', duplicated: false } } };
    }
    if (path.startsWith('/v1/tasks/t_abc123') && method === 'GET') {
      const t = tasks.progress || { taskId: 't_abc123', status: 'running', totalCourses: 3, doneCourses: 1,
        overallPercent: 33, courses: [{ title: '数据结构', status: 'running', currentChapter: '第三章 树与二叉树' }], updatedAt: now };
      return { status: 200, body: { success: true, data: t } };
    }
    if (path.endsWith('/cancel')) {
      return { status: 200, body: { success: true, data: { taskId: 't_abc123', status: 'cancelled' } } };
    }
    if (path === '/v1/account' && method === 'GET') {
      return { status: 200, body: { success: true, data: { username: 'stu_001' } } };
    }
    if (path.endsWith('/resume') && method === 'POST') {
      return { status: 200, body: { success: true, data: { taskId: 't_abc123', status: 'queued' } } };
    }
    return { status: 200, body: { success: true, data: {} } };
  };
  const service = createService(
    store,
    send || (async payload => { sent.push(payload); return { errCode: 0 }; }),
    () => now, http, db);
  return { service, store, sent, calls, time: v => { now = v; } };
}

// ---------- 题库按题计费：账本读写辅助 ----------
const seedCredits = (store, openid, tikuBalance) => store.transaction(tx => tx.set(
  'xpay_credits', L.key('credits|' + openid), {
    openid, balance: 0, tikuBalance, grantTotal: 0, tikuGrantTotal: tikuBalance,
    spentTotal: 0, tikuSpentTotal: 0, updatedAt: BASE
  }));
const readCredits = (store, openid) => store.transaction(
  tx => tx.get('xpay_credits', L.key('credits|' + openid)));

// 刷课次数（course）账本：与题库同处 xpay_credits，字段为 balance/spentTotal
const seedBalance = (store, openid, balance) => store.transaction(tx => tx.set(
  'xpay_credits', L.key('credits|' + openid), {
    openid, balance, tikuBalance: 0, grantTotal: balance, tikuGrantTotal: 0,
    spentTotal: 0, tikuSpentTotal: 0, updatedAt: BASE
  }));

test('下单关闭：读课程和提交直接拒绝、不打服务器；进度与取消照常', async () => {
  const { service: s, calls } = setup();
  process.env.STUDY_ORDER_OPEN = '';
  try {
    await assert.rejects(s.submitTask('owner', { requestId: 'req_closed_000001', username: 'u', password: 'p', courseIds: ['1'] }),
      e => e.expose === true && /暂不支持下单/.test(e.message));
    await assert.rejects(s.scanCourses('owner', { username: 'u', password: 'p' }), /暂不支持下单/);
    assert.equal(calls.length, 0);
    await s.cancelTask('owner', { taskId: 't_old' });
    assert.ok(calls.some(c => c.url.endsWith('/v1/tasks/t_old/cancel')));
  } finally {
    process.env.STUDY_ORDER_OPEN = '1';
  }
});

test('HMAC 签名头覆盖 method/path/body/ts/nonce', async () => {
  const { service: s, calls } = setup();
  await s.submitTask('owner', {
    requestId: 'req_submit_fixture_01', username: 'u', password: 'p',
    courseIds: ['1', '2'], useTiku: false
  });
  const c = calls[0];
  assert.equal(c.method, 'POST');
  assert.ok(c.url.endsWith('/v1/tasks'));
  assert.ok(c.headers['X-Auth-Token']);
  assert.ok(c.headers['X-Timestamp']);
  assert.ok(c.headers['X-Nonce']);
  // 用同一算法复算，应一致
  const expect = L.signHeaders('POST', '/v1/tasks', c.body, Number(c.headers['X-Timestamp']) * 1000, c.headers['X-Nonce']);
  assert.equal(expect['X-Auth-Token'], c.headers['X-Auth-Token']);
});

test('提交任务后本地记录状态为 queued', async () => {
  const { service: s, store } = setup();
  await s.submitTask('owner', { requestId: 'req_submit_fixture_02', username: 'u', password: 'p', courseIds: ['1'] });
  const t = await store.task(L.key('task|t_abc123'));
  assert.equal(t.status, 'queued');
  assert.equal(t.openid, 'owner');
  assert.equal(t.notified, false);
});

test('thing 字段超长被截断到 20 字符（防 47003）', () => {
  const long = '第三章 线性表的顺序存储结构及其实现原理详解';
  const out = L.text(long);
  assert.ok(Array.from(out).length <= C.THING_LIMIT, '实际 ' + Array.from(out).length);
  assert.ok(out.endsWith('…'));
});

test('time 字段为中文格式，非 ISO', () => {
  const t = L.timeText(Date.parse('2026-10-11T15:30:00+08:00'));
  assert.equal(t, '2026年10月11日 15:30');
  assert.ok(!t.includes('T') && !t.includes('Z'));
});

test('订阅额度账本：同意 +1、重复回执幂等、模板不匹配被拒', async () => {
  const { service: s } = setup();
  const r = { templateId: C.TMPL_PROGRESS, accepted: true, requestId: 'req_sub_fixture_0001' };
  await s.recordSubscription('owner', r);
  await s.recordSubscription('owner', r);
  assert.equal((await s.status('owner')).credits, 1);
  await assert.rejects(s.recordSubscription('owner', { ...r, requestId: 'req_sub_fixture_0002', accepted: false }));
  await assert.rejects(s.recordSubscription('owner', { ...r, requestId: 'req_sub_fixture_0003', templateId: 'other' }));
});

test('分发：有额度才发，且同一任务同一状态只发一次', async () => {
  const { service: s, store, sent } = setup({ tasks: { progress: {
    taskId: 't_abc123', status: 'done', totalCourses: 1, doneCourses: 1,
    overallPercent: 100, courses: [], updatedAt: BASE } } });
  // 攒 1 次额度
  await s.recordSubscription('owner', { templateId: C.TMPL_PROGRESS, accepted: true, requestId: 'req_sub_fixture_0010' });
  // 建一个已完结任务
  await s.submitTask('owner', { requestId: 'req_submit_fixture_10', username: 'u', password: 'p', courseIds: ['1'] });
  const r1 = await s.dispatch();
  assert.equal(r1.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].templateId, C.TMPL_PROGRESS);
  assert.ok(sent[0].data.thing4.value);

  // 再分发一次：额度已用光 / 已通知，不应重发
  const r2 = await s.dispatch();
  assert.equal(sent.length, 1, '不应重复发送');
  assert.equal((await s.status('owner')).credits, 0);
});

test('分发：无额度时不发送（不静默丢失，由页面内提示兜底）', async () => {
  const { service: s, sent } = setup();
  await s.submitTask('owner', { requestId: 'req_submit_fixture_11', username: 'u', password: 'p', courseIds: ['1'] });
  const r = await s.dispatch();
  assert.equal(sent.length, 0);
  assert.equal(r.sent, 0);
});

test('题库暂停发的是卡券次数提醒模板', async () => {
  const { service: s, sent } = setup({ tasks: { progress: {
    taskId: 't_abc123', status: 'paused_tiku', courses: [], updatedAt: BASE } } });
  await s.recordSubscription('owner', { templateId: C.TMPL_CREDIT, accepted: true, requestId: 'req_sub_fixture_0020' });
  await s.submitTask('owner', { requestId: 'req_submit_fixture_12', username: 'u', password: 'p', courseIds: ['1'] });
  const r = await s.dispatch();
  assert.equal(r.sent, 1);
  assert.equal(sent[0].templateId, C.TMPL_CREDIT);
  assert.ok(sent[0].data.number2 && sent[0].data.thing1);
});

test('未配置服务器地址时给出明确错误', async () => {
  // 遮住 getter，模拟「环境变量和 settings.local.js 都没有」的场景
  const desc = Object.getOwnPropertyDescriptor(C, 'SERVER_BASE_URL');
  Object.defineProperty(C, 'SERVER_BASE_URL', { get: () => '', configurable: true });
  try {
    const store = memoryStore();
    const s = createService(store, async () => ({ errCode: 0 }), Date.now, async () => ({ status: 200, body: {} }), null);
    await assert.rejects(s.submitTask('owner', { requestId: 'req_submit_fixture_13' }), /SERVER_BASE_URL/);
  } finally {
    Object.defineProperty(C, 'SERVER_BASE_URL', desc);
  }
});

test('settings.local.js 里配好服务器地址后，签名头会被带上', async () => {
  const { service: s, calls } = setup();
  await s.submitTask('owner', { requestId: 'req_submit_fixture_14', username: 'u', password: 'p', courseIds: ['1'] });
  assert.ok(calls[0].headers['X-Auth-Token'], '必须带 HMAC 头');
  assert.ok(calls[0].url.startsWith('https://'), '必须走 HTTPS');
});

test('ping：能连上服务器时返回 ok 与耗时', async () => {
  const { service: s, calls } = setup();
  const r = await s.ping();
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.ok(r.target.startsWith('https://'));
  assert.ok(calls.some(c => c.url.endsWith('/healthz')));
});

test('ping：连不上时返回原因而非抛错', async () => {
  const store = memoryStore();
  const s = createService(store, async () => ({}), Date.now,
    async () => { throw new Error('ECONNREFUSED'); }, null);
  const r = await s.ping();
  assert.equal(r.ok, false);
  assert.match(r.reason, /ECONNREFUSED/);
});

test('ping：未配置地址时给出明确提示', async () => {
  const desc = Object.getOwnPropertyDescriptor(C, 'SERVER_BASE_URL');
  Object.defineProperty(C, 'SERVER_BASE_URL', { get: () => '', configurable: true });
  try {
    const s = createService(memoryStore(), async () => ({}), Date.now, async () => ({ status: 200, body: {} }), null);
    const r = await s.ping();
    assert.equal(r.ok, false);
    assert.match(r.reason, /SERVER_BASE_URL/);
  } finally {
    Object.defineProperty(C, 'SERVER_BASE_URL', desc);
  }
});

test('带查询参数的接口：HMAC 只签 path，不含 ?query（回归测试）', async () => {
  const { service: s, calls } = setup();
  await s.listCourses('owner');

  const c = calls[0];
  const u = new URL(c.url);
  assert.equal(u.pathname, '/v1/courses', '请求路径');
  assert.ok(u.search.includes('openid=owner'), '查询参数应在 URL 上');

  // 关键：用「不含 query」的 path 复算签名，必须与发出的头一致
  const ts = Number(c.headers['X-Timestamp']) * 1000;
  const expect = L.signHeaders('GET', '/v1/courses', '', ts, c.headers['X-Nonce']);
  assert.equal(expect['X-Auth-Token'], c.headers['X-Auth-Token'],
    '签名必须只覆盖 path —— 带上 ?query 会导致服务端 401');

  // 反证：带 query 签出来的必须不同
  const wrong = L.signHeaders('GET', '/v1/courses?openid=owner', '', ts, c.headers['X-Nonce']);
  assert.notEqual(wrong['X-Auth-Token'], c.headers['X-Auth-Token']);
});

test('getProgress / listTasks / dispatch 的签名同样不含 query', async () => {
  const { service: s, calls } = setup();
  await s.getProgress('owner', { taskId: 't_abc123' });
  const c = calls[0];
  const ts = Number(c.headers['X-Timestamp']) * 1000;
  const expect = L.signHeaders('GET', '/v1/tasks/t_abc123', '', ts, c.headers['X-Nonce']);
  assert.equal(expect['X-Auth-Token'], c.headers['X-Auth-Token']);
  assert.ok(new URL(c.url).search.includes('openid=owner'));
});

// ---------- 题库按题计费：结算 ----------

test('题库计费：任务终结时按用题数扣减，且按 taskId 幂等', async () => {
  const { service: s, store } = setup({ db: {}, tasks: { progress: {
    taskId: 't_abc123', status: 'done', tikuUsed: 12, courses: [], updatedAt: BASE } } });
  await seedCredits(store, 'owner', 50);
  await s.submitTask('owner', { requestId: 'req_submit_tiku_0001', username: 'u', password: 'p', courseIds: ['1'], useTiku: true });

  const r = await s.dispatch();
  assert.equal(r.settled, 12);
  assert.equal((await readCredits(store, 'owner')).tikuBalance, 38);

  // 直接重复结算同一 taskId：receipt 去重，不再扣
  await s.settleTiku('owner', 't_abc123', 12);
  assert.equal((await readCredits(store, 'owner')).tikuBalance, 38, '同一 taskId 不能重复扣');
});

test('题库计费：paused_tiku 也结算（扣掉已用部分，续跑不重复扣）', async () => {
  const { service: s, store } = setup({ db: {}, tasks: { progress: {
    taskId: 't_abc123', status: 'paused_tiku', tikuUsed: 50, courses: [], updatedAt: BASE } } });
  await seedCredits(store, 'owner', 50);
  await s.submitTask('owner', { requestId: 'req_submit_tiku_0002', username: 'u', password: 'p', courseIds: ['1'], useTiku: true });
  const r = await s.dispatch();
  assert.equal(r.settled, 50);
  assert.equal((await readCredits(store, 'owner')).tikuBalance, 0);
});

test('题库计费：未开题库的任务不结算', async () => {
  const { service: s, store } = setup({ db: {}, tasks: { progress: {
    taskId: 't_abc123', status: 'done', tikuUsed: 12, courses: [], updatedAt: BASE } } });
  await seedCredits(store, 'owner', 50);
  await s.submitTask('owner', { requestId: 'req_submit_tiku_0003', username: 'u', password: 'p', courseIds: ['1'], useTiku: false });
  const r = await s.dispatch();
  assert.equal(r.settled, 0);
  assert.equal((await readCredits(store, 'owner')).tikuBalance, 50);
});

test('题库计费：用量超过余额时扣到底，绝不为负', async () => {
  const { service: s, store } = setup({ db: {} });
  await seedCredits(store, 'owner', 5);
  const r = await s.settleTiku('owner', 't_over', 999);
  assert.equal(r.spent, 5);
  assert.equal((await readCredits(store, 'owner')).tikuBalance, 0);
});

test('题库计费：无数据库依赖时返回 null（不影响主流程）', async () => {
  const { service: s } = setup();
  assert.equal(await s.settleTiku('owner', 't_x', 10), null);
});

// ---------- 刷课按门计费：结算 ----------

test('刷课计费：任务真正终态按 doneCourses 扣减，failed 不计入', async () => {
  const { service: s, store } = setup({ db: {}, tasks: { progress: {
    taskId: 't_abc123', status: 'done', totalCourses: 3, doneCourses: 2,
    failedCourses: 1, courses: [], updatedAt: BASE } } });
  await seedBalance(store, 'owner', 10);
  await s.submitTask('owner', { requestId: 'req_submit_course_0001', username: 'u', password: 'p', courseIds: ['1', '2', '3'] });

  const r = await s.dispatch();
  assert.equal(r.settled, 2);
  const c = await readCredits(store, 'owner');
  assert.equal(c.balance, 8);
  assert.equal(c.spentTotal, 2);
});

test('刷课计费：paused_tiku 不结算（任务未结束，用户会续跑）', async () => {
  const { service: s, store } = setup({ db: {}, tasks: { progress: {
    taskId: 't_abc123', status: 'paused_tiku', doneCourses: 1, tikuUsed: 0,
    courses: [], updatedAt: BASE } } });
  await seedBalance(store, 'owner', 10);
  await s.submitTask('owner', { requestId: 'req_submit_course_0002', username: 'u', password: 'p', courseIds: ['1'] });

  const r = await s.dispatch();
  assert.equal(r.settled, 0);
  assert.equal((await readCredits(store, 'owner')).balance, 10);
});

test('刷课计费：终态续跑二次进入只结算 doneCourses 的增量', async () => {
  const { service: s, store } = setup({ db: {} });
  await seedBalance(store, 'owner', 10);
  const r1 = await s.settleCourse('owner', 't_course_inc', 2);
  assert.equal(r1.spent, 2);
  assert.equal((await readCredits(store, 'owner')).balance, 8);
  const r2 = await s.settleCourse('owner', 't_course_inc', 5);
  assert.equal(r2.spent, 3);
  assert.equal((await readCredits(store, 'owner')).balance, 5);
});

// ---------- 题库按题计费：增量结算 ----------

test('题库计费：增量结算（先 10 再 25 → 共扣 25，而非 35/10）', async () => {
  const { service: s, store } = setup({ db: {} });
  await seedCredits(store, 'owner', 100);

  const r1 = await s.settleTiku('owner', 't_inc', 10);
  assert.equal(r1.spent, 10);
  assert.equal((await readCredits(store, 'owner')).tikuBalance, 90);

  const r2 = await s.settleTiku('owner', 't_inc', 25);
  assert.equal(r2.spent, 15, '只扣差值 25-10=15');
  assert.equal((await readCredits(store, 'owner')).tikuBalance, 75);

  // 续跑再次上报同样的累计用量：差值为 0，不再扣
  const r3 = await s.settleTiku('owner', 't_inc', 25);
  assert.equal(r3.spent, 0);
  assert.equal((await readCredits(store, 'owner')).tikuBalance, 75);
});

// ---------- getAccount / resumeTask 代理 ----------

test('getAccount：签名 path 不含 query，返回用户名（不含密码）', async () => {
  const { service: s, calls } = setup();
  const r = await s.getAccount('owner');
  assert.equal(r.username, 'stu_001');
  assert.equal(r.password, undefined, '绝不返回密码');

  const c = calls[0];
  assert.equal(c.method, 'GET');
  const u = new URL(c.url);
  assert.equal(u.pathname, '/v1/account');
  assert.ok(u.search.includes('openid=owner'));

  const ts = Number(c.headers['X-Timestamp']) * 1000;
  const expect = L.signHeaders('GET', '/v1/account', '', ts, c.headers['X-Nonce']);
  assert.equal(expect['X-Auth-Token'], c.headers['X-Auth-Token'],
    '签名必须只覆盖 path，不含 ?query');
});

test('resumeTask：POST path 不含 query，成功后本地状态回 queued 且 notified=false', async () => {
  const { service: s, store, calls } = setup();
  await s.submitTask('owner', { requestId: 'req_submit_resume_0001', username: 'u', password: 'p', courseIds: ['1'] });
  // 模拟任务已暂停：本地已是终态、已通知
  await store.transaction(async tx => {
    const id = L.key('task|t_abc123');
    const t = await tx.get(C.TASK, id);
    t.status = 'paused_tiku'; t.notified = true;
    await tx.set(C.TASK, id, t);
  });

  const r = await s.resumeTask('owner', { taskId: 't_abc123', tikuQuota: 50 });
  assert.equal(r.status, 'queued');

  const resumeCall = calls.find(c => c.url.includes('/resume'));
  const u = new URL(resumeCall.url);
  assert.equal(u.pathname, '/v1/tasks/t_abc123/resume');
  assert.equal(u.search, '', 'resume 的 path 不能含 query');

  const ts = Number(resumeCall.headers['X-Timestamp']) * 1000;
  const expect = L.signHeaders('POST', '/v1/tasks/t_abc123/resume', resumeCall.body, ts, resumeCall.headers['X-Nonce']);
  assert.equal(expect['X-Auth-Token'], resumeCall.headers['X-Auth-Token'],
    '签名必须与不含 query 的 path/body 一致');

  const t = await store.task(L.key('task|t_abc123'));
  assert.equal(t.status, 'queued');
  assert.equal(t.notified, false, '续跑后需能重新通知与结算');
});

// ---------- 回归：余额不足时欠款不能被抹掉（settled 记「实际已扣」而非上报用量） ----------

test('题库计费：余额不足的欠款保留，充值后继续补扣', async () => {
  const { service: s, store } = setup({ db: {} });
  await seedCredits(store, 'owner', 10);

  const r1 = await s.settleTiku('owner', 't_debt', 25);
  assert.equal(r1.spent, 10, '最多扣到余额为 0');
  assert.equal(r1.settled, 10, 'settled 必须记「实际已扣金额」，不能记上报用量 25');
  assert.equal((await readCredits(store, 'owner')).tikuBalance, 0);

  // 用户充值 100 后，再次以同一累计用量结算：必须补扣欠款 15
  const c = await readCredits(store, 'owner');
  c.tikuBalance = 100;
  await store.transaction(tx => tx.set('xpay_credits', L.key('credits|owner'), c));

  const r2 = await s.settleTiku('owner', 't_debt', 25);
  assert.equal(r2.spent, 15, '充值后必须补扣未结清的欠款');
  assert.equal((await readCredits(store, 'owner')).tikuBalance, 85);

  // 再报同一用量：欠款已清，差值为 0
  const r3 = await s.settleTiku('owner', 't_debt', 25);
  assert.equal(r3.spent, 0);
  assert.equal((await readCredits(store, 'owner')).tikuBalance, 85);
});

test('题库计费：余额为 0 的首轮写入 settled=0，不抹掉欠款', async () => {
  const { service: s, store } = setup({ db: {} });
  await seedCredits(store, 'owner', 0);

  const r1 = await s.settleTiku('owner', 't_zero', 7);
  assert.equal(r1.spent, 0);
  assert.equal(r1.settled, 0, '没扣到任何款就不算已结清');

  const c = await readCredits(store, 'owner');
  c.tikuBalance = 7;
  await store.transaction(tx => tx.set('xpay_credits', L.key('credits|owner'), c));

  const r2 = await s.settleTiku('owner', 't_zero', 7);
  assert.equal(r2.spent, 7, '充值的额度应能补扣之前未结清的部分');
  assert.equal((await readCredits(store, 'owner')).tikuBalance, 0);
});

// ---------- 回归：通知发送失败不扣额度、可重试 ----------

test('分发：发送失败不扣额度、不落回执，下一轮可重试', async () => {
  let fail = true;
  const delivered = [];
  const { service: s } = setup({
    db: {},
    tasks: { progress: {
      taskId: 't_abc123', status: 'done', totalCourses: 1, doneCourses: 1,
      overallPercent: 100, courses: [], updatedAt: BASE } },
    send: async payload => {
      if (fail) throw new Error('微信 500');
      delivered.push(payload);
      return { errCode: 0 };
    }
  });
  await s.recordSubscription('owner', { templateId: C.TMPL_PROGRESS, accepted: true, requestId: 'req_sub_fixture_0090' });
  await s.submitTask('owner', { requestId: 'req_submit_fixture_90', username: 'u', password: 'p', courseIds: ['1'] });
  assert.equal((await s.status('owner')).credits, 1);

  const r1 = await s.dispatch();
  assert.equal(r1.sent, 0, '发送失败不计入 sent');
  assert.equal(delivered.length, 0);
  assert.equal((await s.status('owner')).credits, 1, '发送失败绝不能白扣订阅额度');

  // 恢复后下一轮必须重试并成功
  fail = false;
  const r2 = await s.dispatch();
  assert.equal(r2.sent, 1, '瞬时失败必须能被下一轮重试');
  assert.equal(delivered.length, 1);
  assert.equal((await s.status('owner')).credits, 0);

  // 已成功送达：不再重发
  await s.dispatch();
  assert.equal(delivered.length, 1, '送达后不得重复发送');
});

test('分发：sendMessage 返回非 0 errCode 同样不扣额度、可重试', async () => {
  let code = -1;
  const delivered = [];
  const { service: s } = setup({
    db: {},
    tasks: { progress: {
      taskId: 't_abc123', status: 'done', totalCourses: 1, doneCourses: 1,
      overallPercent: 100, courses: [], updatedAt: BASE } },
    send: async payload => {
      if (code !== 0) return { errCode: code };
      delivered.push(payload);
      return { errCode: 0 };
    }
  });
  await s.recordSubscription('owner', { templateId: C.TMPL_PROGRESS, accepted: true, requestId: 'req_sub_fixture_0091' });
  await s.submitTask('owner', { requestId: 'req_submit_fixture_91', username: 'u', password: 'p', courseIds: ['1'] });

  assert.equal((await s.dispatch()).sent, 0);
  assert.equal((await s.status('owner')).credits, 1);

  code = 0;
  assert.equal((await s.dispatch()).sent, 1);
  assert.equal(delivered.length, 1);
  assert.equal((await s.status('owner')).credits, 0);
});

// ---------- 错误透传：服务端业务文案必须原样到达前端 ----------
function withHttp(http, store = memoryStore()) {
  return createService(store, async () => ({ errCode: 0 }), () => BASE, http, null);
}

test('服务端 BusinessError 原样透传（不再被白名单吞成「处理失败」）', async () => {
  const svc = withHttp(async () => ({ status: 200,
    body: { success: false, errMsg: '单次最多提交 20 门课' } }));
  const err = await svc.submitTask('o1', { requestId: 'req_1234567890abcdef', courseIds: ['c1'] })
    .catch(e => e);
  assert.equal(err.expose, true);
  assert.match(err.message, /单次最多提交 20 门课/);
});

test('网络错误给出可读原因并标记可展示', async () => {
  const svc = withHttp(async () => { const e = new Error('connect'); e.code = 'ECONNREFUSED'; throw e; });
  const err = await svc.submitTask('o1', { requestId: 'req_1234567890abcdef', courseIds: ['c1'] })
    .catch(e => e);
  assert.equal(err.expose, true);
  assert.match(err.message, /连接失败（ECONNREFUSED）/);
});

test('服务器已建单但本地记录写失败：仍返回 taskId（避免用户重复提交）', async () => {
  const store = memoryStore();
  store.transaction = async () => { throw new Error('db down'); };
  const svc = withHttp(async () => ({ status: 200,
    body: { success: true, data: { taskId: 't_x', duplicated: false } } }), store);
  const data = await svc.submitTask('o1', { requestId: 'req_1234567890abcdef', courseIds: ['c1'] });
  assert.equal(data.taskId, 't_x');
});

// ---------- 不依赖定时触发器：进度页拉到终态即结算 ----------
test('getProgress 拉到终态即扣刷课次数；之后 dispatch 不重复扣', async () => {
  const { service: s, store } = setup({ db: {}, tasks: { progress: {
    taskId: 't_abc123', status: 'done', totalCourses: 1, doneCourses: 1,
    courses: [], updatedAt: BASE } } });
  await seedBalance(store, 'owner', 5);
  await s.submitTask('owner', { requestId: 'req_progress_settle_01', username: 'u', password: 'p', courseIds: ['1'] });

  await s.getProgress('owner', { taskId: 't_abc123' });
  assert.equal((await readCredits(store, 'owner')).balance, 4);
  assert.equal((await store.task(L.key('task|t_abc123'))).notified, true);

  await s.getProgress('owner', { taskId: 't_abc123' });   // 进度页继续轮询
  const r = await s.dispatch();                            // 触发器补跑
  assert.equal(r.settled, 0);
  assert.equal((await readCredits(store, 'owner')).balance, 4);
});

test('getProgress 进行中不结算', async () => {
  const { service: s, store } = setup({ db: {} });
  await seedBalance(store, 'owner', 5);
  await s.submitTask('owner', { requestId: 'req_progress_settle_02', username: 'u', password: 'p', courseIds: ['1'] });
  await s.getProgress('owner', { taskId: 't_abc123' });
  assert.equal((await readCredits(store, 'owner')).balance, 5);
});

// ---------- v2 统一次数：开自动答题时答过题的课多扣 1 次 ----------
function v2Setup(progress) {
  return setup({ db: {}, tasks: { progress: Object.assign({
    taskId: 't_abc123', status: 'done', courses: [], updatedAt: BASE }, progress) } });
}
const v2Submit = (s, extra) => s.submitTask('owner', Object.assign({
  requestId: 'req_v2_submit_0001', username: 'u', password: 'p',
  courseIds: ['1', '2'], useTiku: true, billing: 'v2' }, extra));

test('v2：完成 2 门，其中 1 门答过题 → 扣 3 次；不动题库券', async () => {
  const { service: s, store, calls } = v2Setup({ totalCourses: 2, doneCourses: 2, answeredDoneCourses: 1, tikuUsed: 120 });
  await seedBalance(store, 'owner', 5);
  await v2Submit(s);
  const body = JSON.parse(calls.find(c => c.method === 'POST').body);
  assert.equal(body.billing, 'v2');
  assert.equal(body.tikuQuota, null);

  await s.dispatch();
  const c = await readCredits(store, 'owner');
  assert.equal(c.balance, 2);
  assert.equal(c.tikuSpentTotal || 0, 0);
});

test('v2：没开自动答题，answeredDoneCourses 不计费', async () => {
  const { service: s, store } = v2Setup({ totalCourses: 2, doneCourses: 2, answeredDoneCourses: 2 });
  await seedBalance(store, 'owner', 5);
  await v2Submit(s, { useTiku: false });
  await s.dispatch();
  assert.equal((await readCredits(store, 'owner')).balance, 3);
});

// 新任务下单时已经把答题那份预留好了，正常不会再欠款；这两条保的是改规则之前
// 下的老任务（当时只要求「课程数」）结算时的欠款处理 —— 用「下单后余额变少」来模拟。
test('v2：余额不足以补扣答题次数 → 记欠款，下次下单被拦；充值后自动结清', async () => {
  const { service: s, store } = v2Setup({ totalCourses: 2, doneCourses: 2, answeredDoneCourses: 2 });
  await seedBalance(store, 'owner', 4);
  await v2Submit(s);
  await seedBalance(store, 'owner', 2);
  await s.dispatch();
  assert.equal((await readCredits(store, 'owner')).balance, 0);
  assert.equal((await s.wallet('owner')).debt, 2);

  await seedBalance(store, 'owner', 5);                 // 充值
  const err = await v2Submit(s, { requestId: 'req_v2_submit_0002', courseIds: ['9'] }).catch(e => e);
  assert.ok(!(err instanceof Error), '充值后应先结清欠款再放行');
  const c = await readCredits(store, 'owner');
  assert.equal(c.balance, 3);                           // 5 - 欠款 2
  assert.equal((await s.wallet('owner')).debt, 0);
});

test('v2：欠款结不清时拒绝下单并说明原因', async () => {
  const { service: s, store } = v2Setup({ totalCourses: 2, doneCourses: 2, answeredDoneCourses: 2 });
  await seedBalance(store, 'owner', 4);
  await v2Submit(s);
  await seedBalance(store, 'owner', 2);
  await s.dispatch();
  const err = await v2Submit(s, { requestId: 'req_v2_submit_0003' }).catch(e => e);
  assert.equal(err.expose, true);
  assert.match(err.message, /还差 2 次未结清/);
});

test('v2：进行中的任务占用次数，不能用同一笔余额连下两单', async () => {
  const { service: s, store } = setup({ db: {} });       // 默认进度为 running
  await seedBalance(store, 'owner', 5);
  await v2Submit(s);                                      // 2 门 + 答题：占用 4
  const err = await v2Submit(s, { requestId: 'req_v2_submit_0004' }).catch(e => e);
  assert.match(err.message, /可用 1 次（进行中的任务已占用 4 次）/);
});

test('v2：开自动答题每门课要预留 2 次，只够刷课部分时拒绝并说明；不开答题照常下单', async () => {
  const { service: s, store, calls } = setup({ db: {} });
  await seedBalance(store, 'owner', 3);
  const err = await v2Submit(s).catch(e => e);            // 2 门 + 答题 = 4 次
  assert.equal(err.expose, true);
  assert.match(err.message, /每门课需预留 2 次/);
  assert.match(err.message, /本次需要 4 次，可用 3 次/);
  assert.equal(calls.filter(c => c.method === 'POST').length, 0, '被拒绝的单不能发到服务器');

  await v2Submit(s, { requestId: 'req_v2_submit_0005', useTiku: false });
  assert.equal((await s.wallet('owner')).reserved, 2);    // 不开答题：每门 1 次
});

test('v2：预留 2 次/门，刷完按实际扣 —— 没答题的课那 1 次退回', async () => {
  const { service: s, store } = v2Setup({ totalCourses: 2, doneCourses: 2, answeredDoneCourses: 1 });
  await seedBalance(store, 'owner', 4);
  await v2Submit(s);
  await s.dispatch();                                     // 2 门刷完，只有 1 门答了题 → 扣 3
  const w = await s.wallet('owner');
  assert.equal(w.balance, 1);
  assert.equal(w.reserved, 0);                            // 任务结束，预留全部释放
  assert.equal(w.available, 1);
  assert.equal(w.debt, 0);
});

test('v2：改规则前下的老任务（没有 reserveCount）仍按课程数占用', async () => {
  const { service: s, store } = setup({ db: {} });
  await seedBalance(store, 'owner', 6);
  await v2Submit(s);
  await store.transaction(async tx => {                   // 抹掉字段，模拟老任务记录
    const [doc] = await store.tasksByOpenid('owner');
    assert.equal(doc.reserveCount, 4);
    delete doc.reserveCount;
    await tx.set(C.TASK, L.key('task|' + doc.taskId), doc);
  });
  assert.equal((await s.wallet('owner')).reserved, 2);
});
