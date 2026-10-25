const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const notification = require('../miniprogram/utils/notifications');
const config = require('../miniprogram/utils/notification-config');
const planCache = require('../miniprogram/utils/notification-plan-cache');
const fixtureSemester = { id: '202', start_date: '2026-09-07', end_date: '2027-01-24' };
const fixturePlan = [{ lessonId: '1', courseName: '示例', date: '2026-09-09', startTime: '08:30', teacher: '老师', place: 'F2-318' }];
const serverConfig = require('../cloudfunctions/scheduleReminderFunctions/settings');
const settle = () => new Promise(resolve => setImmediate(resolve));
const state = { accountKey: 'wx-owner-fixture', estimatedCredits: 0, creditLimit: 200,
  enabled: false, leadMinutes: 30, syncedThrough: '', syncedAt: 0, lessonCount: 0, records: [] };
function pageFixture(options = {}) {
  let page, subscribeOptions, id = 0;
  const calls = [], events = [], storage = options.storage || new Map();
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (k, v) => storage.set(k, v), removeStorageSync: k => storage.delete(k),
    showToast: e => events.push(e.title), showModal: e => { events.push(e.content); if (e.success) e.success({ confirm: true }); },
    requestSubscribeMessage: e => { events.push('requestSubscribeMessage'); subscribeOptions = e; if (options.throwSubscribe) throw Error('native'); } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../miniprogram/subpackages/notifications/center/center.js'), 'utf8'), {
    Page: p => { page = p; }, wx, console, Date,
    require: name => name.endsWith('/share') ? { withPageShare: p => p } : name.endsWith('/notification-plan-cache') ? planCache : name.endsWith('/notifications') ? {
      config, newRequestId: () => 'fixture_request_123456789_' + (++id),
      loadSemester: async () => options.semester || fixtureSemester,
      collectPlan: async (...args) => options.collectPlan ? options.collectPlan(...args) : [],
      call: async (type, value) => { calls.push({ type, value }); return options.call ? options.call(type, value) : { ...state, estimatedCredits: type === 'recordSubscription' ? 1 : 0 }; }
    } : {}
  });
  page.setData = patch => Object.assign(page.data, patch); page.onLoad();
  return { page, calls, events, storage, reply: value => subscribeOptions.success({ [config.templateId]: value }) };
}

test('前后端模板与提前时间一致；未配置环境明确报错不显示假余额', async () => {
  assert.equal(config.templateId, serverConfig.TEMPLATE_ID);
  assert.deepEqual(config.leadMinutes, serverConfig.LEAD_MINUTES);
  if (!config.cloudEnvId) await assert.rejects(notification.call('getStatus'), /云开发环境/);
  const p = pageFixture({ call: () => { throw Error('云端未部署'); } }); await p.page.refresh();
  assert.equal(p.page.data.ready, false); assert.equal(p.page.data.estimatedCredits, null);
  assert.equal(p.page.data.error, '云端未部署');
});
test('点击直接发起订阅；只有accept记一次，拒绝及重复点击不计数', async () => {
  const p = pageFixture(); await p.page.refresh(); const before = p.calls.length;
  p.page.onAddSubscription(); assert.equal(p.events.at(-1), 'requestSubscribeMessage'); assert.equal(p.calls.length, before);
  p.page.onAddSubscription(); assert.equal(p.events.filter(e => e === 'requestSubscribeMessage').length, 1);
  p.reply('reject'); await settle(); assert.equal(p.calls.filter(c => c.type === 'recordSubscription').length, 0);
  p.page.onAddSubscription(); p.reply('accept'); await settle();
  assert.equal(p.calls.filter(c => c.type === 'recordSubscription').length, 1);
  assert.equal(p.page.data.estimatedCredits, 1); assert.equal(p.page.data.pendingReceipt, false);
});
test('同意后网络失败保留回执；重试不再次弹授权且复用请求ID', async () => {
  let fail = true;
  const p = pageFixture({ call: type => { if (type === 'recordSubscription' && fail) throw Error('network'); return { ...state, estimatedCredits: 1 }; } });
  await p.page.refresh(); p.page.onAddSubscription(); p.reply('accept'); await settle();
  assert.equal(p.page.data.pendingReceipt, true); assert.equal(p.storage.size, 1);
  fail = false; p.page.onRetrySubscriptions(); await settle();
  assert.equal(p.events.filter(e => e === 'requestSubscribeMessage').length, 1);
  const receipts = p.calls.filter(c => c.type === 'recordSubscription');
  assert.equal(receipts[0].value.requestId, receipts[1].value.requestId); assert.equal(p.storage.size, 0);
});
test('订阅同步抛错恢复按钮，离页后的同意保留回执但不更新页面', async () => {
  const p = pageFixture({ throwSubscribe: true }); await p.page.refresh(); p.page.onAddSubscription();
  assert.equal(p.page.data.busy, false);
  const left = pageFixture(); await left.page.refresh(); left.page.onAddSubscription(); left.page.onUnload(); left.reply('accept');
  await settle(); assert.equal(left.storage.size, 1); assert.equal(left.calls.filter(c => c.type === 'recordSubscription').length, 0);
});
test('课表同步只上传课程字段，不上传教务认证；查询含空周并在失败时中断', async () => {
  const a = { token: 'PRIVATE_TOKEN', secret: 'PRIVATE_SECRET', bizTypes: [{ id: '1' }] };
  const api = { getSemesters: async () => ({ cur_semester_id: '202', semesters: [{ id: '202', start_date: '2026-09-07', end_date: '2026-09-20' }] }),
    getCourseTables: async (_, b, id, start) => start === '2026-09-07' ? [{ date: start, start_time: '08:30', lesson_id: 1,
      course_name: '示例课程', rooms: [{ name: '综合教学楼(F2座) F2-318' }], teachers: [{ name: '教师' }] }] : [] };
  const progress = []; const plan = await notification.collectPlan(api, a, () => {}, (...v) => progress.push(v));
  assert.equal(progress.length, 2); assert.equal(plan[0].place, 'F2-318');
  assert.ok(!JSON.stringify(plan).includes('PRIVATE_'));
  api.getCourseTables = async () => { throw Error('network'); }; await assert.rejects(notification.collectPlan(api, a));
});
test('通知中心分包注册与首页入口存在，保留原六个业务入口', () => {
  const app = require('../miniprogram/app.json');
  assert(app.subPackages.some(p => p.root === 'subpackages/notifications' && p.pages.includes('center/center')));
  const home = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/home/home.wxml'), 'utf8');
  assert.match(home, /bindtap="goNotifications"/); assert.equal((home.match(/class="service-entry"/g) || []).length, 7);
  assert.match(home, /class="notification-card"/);
  const schedule = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/schedule/schedule.wxml'), 'utf8');
  assert.match(schedule, /bindtap="openNotifications">课前提醒/);
});

test('云端未返回时仍可再次点击订阅，逐条确认不会清掉后续回执', async () => {
  const releases = [];
  const p = pageFixture({ call: type => type === 'recordSubscription' ? new Promise(resolve => releases.push(resolve)) : state });
  await p.page.refresh(); p.page.onAddSubscription(); p.reply('accept');
  assert.equal(p.page.data.subscribing, false); assert.equal(p.page.data.busy, false);
  assert.equal(p.page.data.pendingCount, 1); assert.equal(p.page.data.estimatedCredits, 0);
  p.page.onAddSubscription(); p.reply('accept');
  assert.equal(p.events.filter(e => e === 'requestSubscribeMessage').length, 2);
  assert.equal(p.page.data.pendingCount, 2); assert.equal(releases.length, 1);
  releases[0]({ ...state, estimatedCredits: 1 }); await settle();
  assert.equal(p.page.data.pendingCount, 1); assert.equal(releases.length, 2);
  const receipts = p.calls.filter(c => c.type === 'recordSubscription');
  assert.notEqual(receipts[0].value.requestId, receipts[1].value.requestId);
  releases[1]({ ...state, estimatedCredits: 2 }); await settle();
  assert.equal(p.page.data.pendingCount, 0); assert.equal(p.page.data.estimatedCredits, 2);
  assert.equal(p.page.data.syncingSubscriptions, false); assert.equal(p.storage.size, 0);
});
test('兼容旧版单回执存储，重试不再次申请微信订阅', async () => {
  const p = pageFixture(); await p.page.refresh();
  p.storage.set('notificationReceipt:' + state.accountKey, { requestId: 'old_request_fixture_123', templateId: config.templateId, accepted: true });
  p.page.applyStatus(state); assert.equal(p.page.data.pendingCount, 1);
  p.page.data.ready = false; p.page.onRetrySubscriptions(); await settle();
  assert.equal(p.calls.filter(c => c.type === 'recordSubscription').length, 0);
  p.page.data.ready = true;
  p.page.onRetrySubscriptions(); await settle();
  assert.equal(p.events.filter(e => e === 'requestSubscribeMessage').length, 0);
  assert.equal(p.calls.at(-1).value.requestId, 'old_request_fixture_123'); assert.equal(p.storage.size, 0);
});

test('首次进入自动准备课表并开启；同页权限弹窗返回不重复查询整学期', async () => {
  let backend = { ...state }, collects = 0;
  const p = pageFixture({ collectPlan: async () => { collects++; return fixturePlan; },
    call: (type, args) => {
      if (type === 'syncPlan') backend = { ...backend, syncedAt: 1, syncedThrough: '2027-01-24', lessonCount: 1 };
      if (type === 'saveSettings') backend = { ...backend, enabled: args.enabled };
      return backend;
    } });
  p.storage.set('auth', { token: 'AUTH_FIXTURE' });
  await p.page.onShow(); assert.equal(collects, 1); assert.equal(p.page.data.enabled, true);
  assert.equal(p.page.data.syncingSchedule, false);
  await p.page.onShow(); assert.equal(collects, 1);
  assert.equal(p.events.filter(e => e === 'requestSubscribeMessage').length, 0);
});
test('已有的关闭状态和首次准备失败后主动关闭均被保留', async () => {
  for (const syncedAt of [0, 10]) {
    const p = pageFixture({ collectPlan: async () => fixturePlan, call: type => ({ ...state, syncedAt: type === 'syncPlan' ? 20 : syncedAt, lessonCount: 1 }) });
    p.storage.set('auth', { token: 'AUTH_FIXTURE' });
    if (!syncedAt) p.storage.set('notificationReminderChoice:' + state.accountKey, false);
    await p.page.onShow();
    assert.equal(p.calls.filter(c => c.type === 'saveSettings').length, 0); assert.equal(p.page.data.enabled, false);
  }
});
test('自动准备课表不阻塞订阅按钮，计划响应不覆盖并行确认的次数', async () => {
  let finish;
  const p = pageFixture({ collectPlan: () => new Promise(resolve => { finish = resolve; }),
    call: type => ({ ...state, estimatedCredits: type === 'recordSubscription' ? 1 : 0,
      syncedAt: type === 'getStatus' ? 0 : 1, lessonCount: type === 'getStatus' ? 0 : 1,
      enabled: type === 'saveSettings' }) });
  p.storage.set('auth', { token: 'AUTH_FIXTURE' });
  const pending = p.page.onShow(); await settle();
  assert.equal(p.page.data.syncingSchedule, true); assert.equal(p.page.data.busy, false);
  p.page.onAddSubscription(); p.reply('accept'); await settle();
  assert.equal(p.page.data.estimatedCredits, 1);
  finish(fixturePlan); await pending;
  assert.equal(p.page.data.enabled, true); assert.equal(p.page.data.estimatedCredits, 1);
});
test('自动读取失败或中途换账号不上传部分计划、不错误开启', async () => {
  const failed = pageFixture({ collectPlan: async () => { throw Error('网络失败'); } });
  failed.storage.set('auth', { token: 'AUTH_FIXTURE' }); await failed.page.onShow();
  assert.match(failed.page.data.syncError, /网络失败/); assert.equal(failed.page.data.enabled, false);
  assert.equal(failed.calls.filter(c => c.type === 'syncPlan' || c.type === 'saveSettings').length, 0);
  let finish;
  const changed = pageFixture({ collectPlan: () => new Promise(resolve => { finish = resolve; }) });
  changed.storage.set('auth', { token: 'OLD' }); const pending = changed.page.onShow(); await settle();
  changed.storage.set('auth', { token: 'NEW' }); finish(fixturePlan); await pending;
  assert.equal(changed.calls.filter(c => c.type === 'syncPlan').length, 0);
});
test('页面没有手动同步课表按钮，只在自动更新失败时提供重试', () => {
  const markup = fs.readFileSync(path.resolve(__dirname, '../miniprogram/subpackages/notifications/center/center.wxml'), 'utf8');
  assert.ok(!markup.includes('onSyncSchedule')); assert.ok(!markup.includes('同步当前学期课表'));
  assert.match(markup, /wx:if="\{\{syncError\}\}"[^>]*bindtap="retryAutoSync"/);
});
test('没有未来课时点开启会还原原生开关，不伪显示已开启', async () => {
  const p = pageFixture(); await p.page.refresh();
  const patches = [], setData = p.page.setData;
  p.page.setData = patch => { patches.push(patch); setData(patch); };
  p.page.onToggle({ detail: { value: true } });
  assert.equal(patches.at(-1).enabled, false);
  assert.equal(p.calls.filter(c => c.type === 'saveSettings').length, 0);
});
test('重新进入页面复用缓存，不重新读20周；过期核对无变化不重复上传', async () => {
  let backend = { ...state }, collects = 0, uploads = 0;
  const storage = new Map(); storage.set('auth', { token: 'AUTH_FIXTURE' });
  const options = { storage, collectPlan: async () => { collects++; return fixturePlan; }, call: (type, args) => {
    if (type === 'syncPlan') { uploads++; backend = { ...backend, syncedAt: 1, lessonCount: 1 }; }
    if (type === 'saveSettings') backend = { ...backend, enabled: args.enabled };
    return backend;
  } };
  const first = pageFixture(options); await first.page.onShow(); first.page.onUnload();
  const second = pageFixture(options); await second.page.onShow();
  assert.equal(collects, 1); assert.equal(uploads, 1);
  for (const [key, value] of storage) if (key.startsWith('notification-plan-v1:')) storage.set(key, { ...value, checkedAt: Date.now() - planCache.CHECK_INTERVAL_MS - 1 });
  await second.page.onShow(); assert.equal(collects, 2); assert.equal(uploads, 1);
  assert.match(second.page.data.planStatus, /无变化/);
});
