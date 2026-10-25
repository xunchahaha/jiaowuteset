const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const semester = require('../miniprogram/utils/semester');
const semesterData = require('../miniprogram/utils/semester-data');
const root = path.resolve(__dirname, '../miniprogram');
const auth = { token: 'fixture', secret: 'fixture', bizTypes: [{ id: '1' }] };
const settle = () => new Promise((resolve) => setImmediate(resolve));
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-09-06T12:00:00+08:00'])); }
}

function createWx(offline = false, seed = {}) {
  const store = new Map(Object.entries(seed));
  store.set('auth', { ...auth, offline });
  return {
    store,
    getStorageSync: (key) => (store.has(key) ? structuredClone(store.get(key)) : ''),
    setStorageSync: (key, value) => { store.set(key, structuredClone(value)); },
    removeStorageSync: (key) => { store.delete(key); },
    getStorageInfoSync: () => ({ keys: [...store.keys()] }),
    stopPullDownRefresh() {}, reLaunch() {}
  };
}

const realModules = {
  '/cache': '../miniprogram/utils/cache',
  '/exam-data': '../miniprogram/utils/exam-data',
  '/grades-data': '../miniprogram/utils/grades-data',
  '/schedule-week': '../miniprogram/utils/schedule-week'
};

// Pages run against the real cache module backed by an in-memory wx storage.
function load(file, api, { offline = false, wx = createWx(offline) } = {}) {
  let page;
  global.wx = wx;
  const context = {
    module: { exports: {} }, Date: FixedDate, console, setTimeout, clearTimeout,
    Page: (definition) => { page = definition; },
    wx,
    require: (name) => {
      if (name.endsWith('/api')) return api;
      if (name.endsWith('/share')) return { withPageShare: (p) => p };
      if (name.endsWith('/semester')) return semester;
      if (name.endsWith('/semester-data')) return semesterData;
      if (name.endsWith('/notification-plan-cache')) return { observeWeek() {} };
      if (name.endsWith('/wakeup-export')) return {};
      const real = Object.keys(realModules).find((suffix) => name.endsWith(suffix));
      if (real) return require(realModules[real]);
      throw new Error(`Unexpected module: ${name}`);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  if (page) page.setData = (patch) => Object.assign(page.data, patch);
  return { page, exports: context.module.exports, wx, store: wx.store };
}

async function checkSelection(response, expectedExamId, expectedBookId, allEmpty = false) {
  const calls = [];
  const api = {
    getSemesters: async () => response,
    getTextbookSemesters: async () => response,
    getExamTasks: async (a, b, id) => { calls.push(['exam', id]); return !allEmpty && id === expectedExamId ? [{ id: 'exam', course_name: '示例考试' }] : []; },
    getTextbooks: async (a, b, id) => { calls.push(['textbook', id]); return allEmpty ? [] : id === expectedBookId ? Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: '示例教材' })) : id === '183' ? Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: '旧教材' })) : []; },
    getGrades: async () => [], getUserDetail: async () => [],
    getMaxUnit: async () => [], getCourseTables: async () => []
  };
  const { page: exam } = load('pages/exam/exam.js', api);
  await exam.loadExamSemesters();
  assert.equal(exam._examSemesterId, expectedExamId);
  assert.equal(exam.data.examSemesterOptions[exam.data.examSemesterIndex].id, expectedExamId);
  assert.equal(exam.data.examSemesterLabel, exam.data.examSemesterOptions[exam.data.examSemesterIndex].label);
  assert.equal(calls.filter(([name]) => name === 'exam').pop()[1], allEmpty ? exam.data.examSemesterOptions.at(-1).id : expectedExamId);
  const { page: books } = load('pages/textbook/textbook.js', api);
  await books.loadSemestersAndTextbooks();
  assert.equal(books.data.semesters[books.data.semesterIndex].id, expectedBookId);
  assert.equal(calls.filter(([name]) => name === 'textbook').pop()[1], allEmpty ? books.data.semesters.at(-1).id : expectedBookId);

  // A manual selection remains in force for refresh / retry within the page.
  exam.onSelectSemester({ currentTarget: { dataset: { index: 0 } } });
  books.onSelectSemester({ currentTarget: { dataset: { index: 0 } } });
  await settle();
  assert.equal(exam._examSemesterId, exam.data.examSemesterOptions[0].id);
  assert.equal(books.data.semesterIndex, 0);
  exam.refreshExam();
  books.onRetry();
  await settle();
  assert.equal(calls.filter(([name]) => name === 'exam').pop()[1], exam.data.examSemesterOptions[0].id);
  assert.equal(calls.filter(([name]) => name === 'textbook').pop()[1], books.data.semesters[0].id);

  const warm = load('utils/warm-cache.js', api);
  await warm.exports.warmEssentialCaches(auth);
  const warmed = warm.store.get('page-cache:textbook-overview:anonymous:1');
  assert(warmed, 'Textbook prewarm must write its payload');
  assert.equal(warmed.payload.semesters[warmed.payload.semesterIndex].id, expectedBookId);
  assert(warm.store.get('page-cache:textbook-semester:anonymous:1:' + expectedBookId), 'Textbook prewarm also fills the per-semester cache');
  const warmedExam = warm.store.get('page-cache:exam-overview:anonymous:1');
  assert.equal(warmedExam.payload.semesters[warmedExam.payload.semesterIndex].id, expectedExamId);
  assert(warm.store.get('page-cache:grades:anonymous:1:1'), 'Grades prewarm uses the same key as the grades page');
}

(async () => {
  const list = [
    { id: '222', name: '未来学期', current: 'false', start_date: '2027-03-01', end_date: '2027-07-11' },
    { id: '202', name: '当前学期', start_date: '2026-09-07', end_date: '2027-01-24' },
    { id: '183', name: '上学期', current: true }
  ];
  // Module data wins over the general current ID, flags and dates.
  await checkSelection({ cur_semester_id: 202, semesters: list }, '183', '202');
  await checkSelection({ data: { current_semester_id: '183', semesters: list } }, '183', '202');
  await checkSelection({ semesters: [{ id: 'newest', current: 'false' }, { id: 'older', current: 'true' }] }, 'newest', 'newest');
  await checkSelection({ semesters: list }, '222', '222', true);
  await checkSelection({ semesters: [{ id: 'only' }] }, 'only', 'only');

  // Do not skip a failed semester and claim an older one is the latest.
  const requests = [];
  await assert.rejects(semesterData.loadLatestSemesterData(list, async (item) => {
    requests.push(item.id);
    throw new Error('network failed');
  }), /network failed/);
  assert.deepEqual(requests, ['222']);
  assert.deepEqual(await semesterData.loadLatestSemesterData([], async () => []), { semesterIndex: -1, items: [] });

  // A probe error must not hide the successfully loaded selector options.
  let failProbe = true;
  const { page: failedExam } = load('pages/exam/exam.js', {
    getSemesters: async () => ({ semesters: list }),
    getExamTasks: async () => { if (failProbe) throw new Error('network failed'); return []; }
  });
  await failedExam.loadExamSemesters();
  assert.equal(failedExam.data.examSemesterOptions.length, list.length);
  assert.equal(failedExam.data.examSemesterIndex, -1);
  assert.equal(failedExam.data.examError, 'network failed');
  failProbe = false;
  failedExam.onSelectSemester({ currentTarget: { dataset: { index: 2 } } });
  await settle();
  assert.equal(failedExam._examSemesterId, '183');
  assert.equal(failedExam.data.examError, '');

  // Switching while initial discovery is in flight wins, even if discovery finishes later.
  for (const name of ['exam', 'textbook']) {
    let release;
    let first = true;
    const deferred = new Promise((resolve) => { release = resolve; });
    const api = {
      getSemesters: async () => ({ semesters: list }),
      getTextbookSemesters: async () => ({ semesters: list }),
      getExamTasks: async () => { if (first) { first = false; return deferred; } return []; },
      getTextbooks: async () => { if (first) { first = false; return deferred; } return []; }
    };
    const { page, store } = load('pages/' + name + '/' + name + '.js', api);
    const pending = name === 'exam' ? page.loadExamSemesters() : page.loadSemestersAndTextbooks();
    await settle();
    // A prior/cache list is visible while refresh is pending.
    const options = list.map((item) => ({ id: item.id, label: item.name }));
    if (name === 'exam') page.data.examSemesterOptions = options;
    else page.data.semesters = options;
    page.onSelectSemester({ currentTarget: { dataset: { index: 2 } } });
    await settle();
    release([]);
    await pending;
    assert.equal(name === 'exam' ? page._examSemesterId : page.data.semesters[page.data.semesterIndex].id, '183');
    // The superseded discovery must not overwrite the overview cache.
    assert(![...store.keys()].some((key) => key.includes(name + '-overview')));
  }

  // Offline mode retains the cached label and data; it must not relabel old books as current.
  const cached = { updatedAt: 1, payload: { semesters: [{ id: '183' }], semesterIndex: 0, textbooks: [{ id: 'cached' }] } };
  const offlineWx = createWx(true, { 'page-cache:textbook-overview:anonymous:1': cached });
  const { page: offline } = load('pages/textbook/textbook.js', {}, { wx: offlineWx });
  await offline.loadSemestersAndTextbooks();
  assert.equal(offline.data.semesters[0].id, '183');
  assert.equal(offline.data.textbooks[0].id, 'cached');
  assert.equal(offline.data.showCacheBanner, true);

  let rosterRequests = 0;
  const { page: detail } = load('pages/lesson-detail/lesson-detail.js', {
    getLessonStudents: async () => { rosterRequests++; return { students: [{ name: '示例', code: 'fixture' }], total_count: 1 }; }
  });
  detail.data.lessonId = 'fixture';
  detail.toggleStudents();
  await settle();
  assert.equal(detail.data.showStudents, true);
  assert.equal(detail.data.studentCount, 1);
  detail.toggleStudents();
  assert.equal(detail.data.showStudents, false);
  detail.toggleStudents();
  assert.equal(detail.data.showStudents, true);
  assert.equal(rosterRequests, 1, 'Reopening uses the loaded roster');
  const markup = fs.readFileSync(path.join(root, 'pages/lesson-detail/lesson-detail.wxml'), 'utf8');
  assert(markup.includes('right-icon="{{showStudents ? \'chevron-up\' : \'chevron-down\'}}"'));
  assert(!markup.includes("'收起' : '展开'"));
  console.log('Page regressions passed: latest non-empty semester per module, nested responses, all-empty results, request failure, manual selection races, prewarm, offline cache and roster toggle.');
})().catch((err) => { console.error(err); process.exitCode = 1; });
