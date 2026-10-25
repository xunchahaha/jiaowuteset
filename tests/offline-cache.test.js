const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const semester = require('../miniprogram/utils/semester');
const semesterData = require('../miniprogram/utils/semester-data');

const root = path.resolve(__dirname, '../miniprogram');
const auth = { token: 'fixture', secret: 'fixture', userInfo: { user_code: 'u1' }, bizTypes: [{ id: '1' }] };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function createWx(offline = false, seed = {}) {
  const store = new Map(Object.entries(seed));
  store.set('auth', { ...auth, offline });
  return {
    store,
    full: false,
    getStorageSync: (key) => (store.has(key) ? structuredClone(store.get(key)) : ''),
    setStorageSync(key, value) {
      if (this.full && key.startsWith('page-cache:')) throw new Error('setStorageSync:fail exceed storage max size');
      store.set(key, structuredClone(value));
    },
    removeStorageSync: (key) => { store.delete(key); },
    getStorageInfoSync: () => ({ keys: [...store.keys()] }),
    stopPullDownRefresh() {}, reLaunch() {}
  };
}

function freshCache(wx) {
  global.wx = wx;
  return require('../miniprogram/utils/cache');
}

const realModules = ['/cache', '/exam-data', '/grades-data', '/schedule-week', '/share-card'];
function loadPage(file, api, wx) {
  let page;
  global.wx = wx;
  const context = {
    module: { exports: {} }, console, setTimeout, clearTimeout, wx,
    Page: (definition) => { page = definition; },
    require: (name) => {
      if (name.endsWith('/api')) return api;
      if (name.endsWith('/share')) return { withPageShare: (p) => p };
      if (name.endsWith('/semester')) return semester;
      if (name.endsWith('/semester-data')) return semesterData;
      if (name.endsWith('/notification-plan-cache')) return { observeWeek() {} };
      if (name.endsWith('/wakeup-export')) return {};
      const real = realModules.find((suffix) => name.endsWith(suffix));
      if (real) return require('../miniprogram/utils' + real);
      throw new Error(`Unexpected module: ${name}`);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  page.setData = (patch) => Object.assign(page.data, JSON.parse(JSON.stringify(patch)));
  return page;
}

function recorder() {
  const calls = { apply: [], notice: [], error: [] };
  return {
    calls,
    apply: (payload, meta) => calls.apply.push({ payload, meta }),
    setNotice: (notice) => calls.notice.push(notice),
    onError: (err) => calls.error.push(err.message)
  };
}

test('有缓存先秒开，数据没变只收起提示，有变动才替换页面并覆盖缓存', async () => {
  const wx = createWx();
  const cache = freshCache(wx);
  cache.writeCache('page-cache:demo', { value: 1 });

  const same = recorder();
  await cache.loadWithCache({ key: 'page-cache:demo', fetch: async () => ({ value: 1 }), ...same });
  assert.equal(same.calls.apply.length, 1);
  assert.equal(same.calls.apply[0].meta.fromCache, true);
  assert.deepEqual(same.calls.notice, ['']);

  const changed = recorder();
  await cache.loadWithCache({ key: 'page-cache:demo', fetch: async () => ({ value: 2 }), ...changed });
  assert.equal(changed.calls.apply.length, 2);
  assert.equal(changed.calls.apply[1].meta.fromCache, false);
  assert.deepEqual(cache.readCache('page-cache:demo').payload, { value: 2 });
});

test('教务连不上：保留缓存并提示；没有缓存才报错；离线模式不发请求', async () => {
  const wx = createWx();
  const cache = freshCache(wx);
  cache.writeCache('page-cache:demo', { value: 1 });

  const failed = recorder();
  await cache.loadWithCache({ key: 'page-cache:demo', fetch: async () => { throw new Error('request:fail timeout'); }, ...failed });
  assert.equal(failed.calls.apply.length, 1);
  assert.match(failed.calls.notice.at(-1), /暂时连不上/);
  assert.equal(failed.calls.error.length, 0);

  const empty = recorder();
  await cache.loadWithCache({ key: 'page-cache:none', fetch: async () => { throw new Error('boom'); }, ...empty });
  assert.deepEqual(empty.calls.error, ['boom']);

  let requested = false;
  const offline = recorder();
  await cache.loadWithCache({ key: 'page-cache:demo', offline: true, fetch: async () => { requested = true; }, ...offline });
  assert.equal(requested, false);
  assert.match(offline.calls.apply[0].meta.notice, /离线模式/);
});

test('过期请求的结果不会覆盖页面，也不会写缓存', async () => {
  const wx = createWx();
  const cache = freshCache(wx);
  const stale = recorder();
  await cache.loadWithCache({ key: 'page-cache:stale', isActive: () => false, fetch: async () => ({ value: 1 }), ...stale });
  assert.equal(stale.calls.apply.length, 0);
  assert.equal(cache.readCache('page-cache:stale'), null);
});

test('缓存条目超过上限按最旧淘汰；存储满时清理后重试', () => {
  const wx = createWx();
  const cache = freshCache(wx);
  for (let index = 0; index < 205; index += 1) {
    cache.writeCache('page-cache:item:' + index, { index });
  }
  const keys = [...wx.store.keys()].filter((key) => key.startsWith('page-cache:item:'));
  assert.equal(keys.length, 200);
  assert.equal(cache.readCache('page-cache:item:0'), null);
  assert(cache.readCache('page-cache:item:204'));

  let attempts = 0;
  const original = wx.setStorageSync;
  wx.setStorageSync = function (key, value) {
    if (key === 'page-cache:big' && attempts++ === 0) throw new Error('exceed storage max size');
    return original.call(this, key, value);
  };
  assert.equal(cache.writeCache('page-cache:big', { big: true }), true);
  assert(cache.readCache('page-cache:big'));
  assert([...wx.store.keys()].filter((key) => key.startsWith('page-cache:item:')).length < 200);
});

test('旧版缓存迁移：按日期存的课表转成按周，教材拆成总览 + 按学期', () => {
  const schedulePayload = { anchorDate: '2026-09-10', weekDays: [{ date: '2026-09-07' }], dayColumns: [] };
  const wx = createWx(false, {
    'page-cache:schedule:u1:1:2026-09-10': { updatedAt: 5, payload: schedulePayload },
    'page-cache:textbooks:u1:1': { updatedAt: 6, payload: { semesters: [{ id: '202' }], semesterIndex: 0, textbooks: [{ id: 'b1' }] } },
    'page-cache:grades:u1:1:1': { updatedAt: 7, payload: { semesters: [] } }
  });
  const cache = freshCache(wx);
  cache.migrateLegacyCache();
  assert.deepEqual(cache.readCache('page-cache:schedule-week:u1:1:2026-09-07').payload, schedulePayload);
  assert.equal(cache.readCache('page-cache:schedule:u1:1:2026-09-10'), null);
  assert.deepEqual(cache.readCache('page-cache:textbook-semester:u1:1:202').payload, { textbooks: [{ id: 'b1' }] });
  assert(cache.readCache('page-cache:textbook-overview:u1:1'));
  assert(cache.readCache('page-cache:grades:u1:1:1'), 'Other entries are kept');
  const index = wx.getStorageSync('page-cache-index');
  assert(index['page-cache:grades:u1:1:1']);
});

const semesterResponse = { semesters: [{ id: '202', name: '当前学期', start_date: '2026-09-07', end_date: '2027-01-24' }] };
function scheduleApi(log) {
  return {
    getSemesters: async () => semesterResponse,
    getMaxUnit: async () => ({}),
    getCourseTables: async (a, b, id, start) => {
      log.push(start);
      return { week_lessons: [{ id: 'l-' + start, course_name: '高数', date: start, section_text: '1-2' }] };
    }
  };
}

test('课表按周缓存：今天看过，明天离线照样能看；没看过的周给出明确提示', async () => {
  const wx = createWx();
  const log = [];
  const online = loadPage('pages/schedule/schedule.js', scheduleApi(log), wx);
  await online.loadSchedule('2026-09-08');
  assert.deepEqual(log, ['2026-09-07']);
  assert(wx.store.get('page-cache:schedule-week:u1:1:2026-09-07'));

  // 第二天教务关机，进入离线模式
  wx.store.set('auth', { ...wx.store.get('auth'), offline: true });
  const offline = loadPage('pages/schedule/schedule.js', {}, wx);
  await offline.loadSchedule('2026-09-09');
  assert.equal(offline.data.error, '');
  assert.equal(offline.data.weekLabel, '第1周');
  assert.equal(offline.data.dayColumns[0].lessons[0].courseName, '高数');
  assert.equal(offline.data.showCacheBanner, true);

  offline.setData({ anchorDate: '2026-09-09' });
  await offline.shiftWeek(7);
  await settle();
  assert.match(offline.data.error, /这一周的课表还没有缓存过/);
  assert.equal(offline.data.weekLabel, '第2周');
});

test('课表在线：先显示缓存，再用新数据替换；快速切周时旧请求不会覆盖', async () => {
  const wx = createWx();
  const log = [];
  const api = scheduleApi(log);
  const page = loadPage('pages/schedule/schedule.js', api, wx);
  await page.loadSchedule('2026-09-08');

  let release;
  api.getCourseTables = (a, b, id, start) => new Promise((resolve) => {
    release = () => resolve({ week_lessons: [{ id: 'new', course_name: '线代', date: start, section_text: '3-4' }] });
  });
  const pending = page.loadSchedule('2026-09-10');
  await settle();
  assert.equal(page.data.dayColumns[0].lessons[0].courseName, '高数', 'Cached week shows immediately');
  release();
  await pending;
  assert.equal(page.data.dayColumns[0].lessons[0].courseName, '线代');
  assert.equal(wx.store.get('page-cache:schedule-week:u1:1:2026-09-07').payload.dayColumns[0].lessons[0].courseName, '线代');

  // 慢的上一周请求晚于下一周返回
  let releaseSlow;
  api.getCourseTables = (a, b, id, start) => (start === '2026-09-07'
    ? new Promise((resolve) => { releaseSlow = () => resolve({ week_lessons: [] }); })
    : Promise.resolve({ week_lessons: [{ id: 'w2', course_name: '英语', date: start, section_text: '1-2' }] }));
  const slow = page.loadSchedule('2026-09-08');
  await settle();
  await page.loadSchedule('2026-09-15');
  releaseSlow();
  await slow;
  assert.equal(page.data.weekLabel, '第2周');
  assert.equal(page.data.dayColumns[0].lessons[0].courseName, '英语');
});

test('考试：每个学期单独缓存，离线切换学期也能看，状态按当前时间重新计算', async () => {
  const wx = createWx();
  const list = { semesters: [{ id: '202', name: '新学期' }, { id: '183', name: '旧学期' }] };
  const api = {
    getSemesters: async () => list,
    getExamTasks: async (a, b, id) => (id === '202'
      ? [{ id: 'e1', course_name: '高数', exam_date: '2000-01-01', start_time: '09:00', end_time: '11:00' }]
      : [{ id: 'e2', course_name: '物理', exam_date: '2099-01-01', start_time: '09:00', end_time: '11:00' }])
  };
  const online = loadPage('pages/exam/exam.js', api, wx);
  await online.loadExamSemesters();
  online.onSelectSemester({ currentTarget: { dataset: { index: 1 } } });
  await settle();

  wx.store.set('auth', { ...wx.store.get('auth'), offline: true });
  const offline = loadPage('pages/exam/exam.js', {}, wx);
  await offline.loadExamSemesters();
  assert.equal(offline.data.examSemesterLabel, '新学期');
  assert.equal(offline.data.examGroups[0].items[0].status, 'finished');
  assert.equal(offline.data.showCacheBanner, true);
  offline.onSelectSemester({ currentTarget: { dataset: { index: 1 } } });
  await settle();
  assert.equal(offline.data.examError, '');
  assert.equal(offline.data.examGroups[0].items[0].courseName, '物理');
  assert.equal(offline.data.examGroups[0].items[0].status, 'upcoming');
});

test('教材：切换学期不再互相覆盖缓存', async () => {
  const wx = createWx();
  const api = {
    getTextbookSemesters: async () => ({ semesters: [{ id: '202', name: '新学期' }, { id: '183', name: '旧学期' }] }),
    getTextbooks: async (a, b, id) => [{ id: 'book-' + id, name: '教材' + id }]
  };
  const online = loadPage('pages/textbook/textbook.js', api, wx);
  await online.loadSemestersAndTextbooks();
  online.onSelectSemester({ currentTarget: { dataset: { index: 1 } } });
  await settle();

  wx.store.set('auth', { ...wx.store.get('auth'), offline: true });
  const offline = loadPage('pages/textbook/textbook.js', {}, wx);
  await offline.loadSemestersAndTextbooks();
  assert.equal(offline.data.textbooks[0].id, 'book-202', 'Overview keeps the default semester');
  offline.onSelectSemester({ currentTarget: { dataset: { index: 1 } } });
  await settle();
  assert.equal(offline.data.textbooks[0].id, 'book-183');
  offline.onSelectSemester({ currentTarget: { dataset: { index: 0 } } });
  await settle();
  assert.equal(offline.data.textbooks[0].id, 'book-202');
});
