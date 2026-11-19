const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('module');
const path = require('path');

const auth = { token: 't', secret: 's', userInfo: { user_code: 'u1' }, bizTypes: [{ id: '1' }] };

function createWx() {
  const store = new Map();
  return {
    store,
    getStorageSync: (key) => (store.has(key) ? structuredClone(store.get(key)) : ''),
    setStorageSync: (key, value) => { store.set(key, structuredClone(value)); },
    removeStorageSync: (key) => { store.delete(key); },
    getStorageInfoSync: () => ({ keys: [...store.keys()] })
  };
}

// course-plan 依赖的 api.js 不入库，测试里换成桩。
function loadCoursePlan(api, wx) {
  global.wx = wx;
  const file = path.resolve(__dirname, '../miniprogram/utils/course-plan.js');
  const cacheFile = path.resolve(__dirname, '../miniprogram/utils/cache.js');
  delete require.cache[file];
  delete require.cache[cacheFile];
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === './api') return api;
    return original.call(this, request, parent, isMain);
  };
  try {
    return require(file);
  } finally {
    Module._load = original;
  }
}

const plan = {
  name: '2025 软件工程',
  plan_type: 'major',
  plan_course_groups: [
    {
      name: '公共基础课程',
      plan_courses: [],
      plan_course_groups: [
        { name: '人文社科', plan_course_groups: [], plan_courses: [
          { id: '101698', course_code: '45B102002', course_name: '马克思主义基本原理', credits: 3, compulsory: true },
          { id: '105786', course_code: '06B102029', course_name: '大学英语Ⅲ（专业认知）', credits: 2, compulsory: true }
        ] }
      ]
    },
    {
      name: '专业课程',
      plan_courses: [],
      plan_course_groups: [
        { name: '核心课程组2', plan_course_groups: [], plan_courses: [
          { id: '105622', course_code: '43B104094', course_name: '数据库原理', credits: 3.5, compulsory: true }
        ] }
      ]
    },
    {
      name: '公共选修课程',
      plan_courses: [],
      plan_course_groups: [{ name: '工程技术', credits: 1, plan_courses: [], plan_course_groups: [] }]
    }
  ]
};

function detail(name, mode) {
  return [
    { title: '课程信息', type: 'list', content: [
      { title: '课程名称', content: name, type: 'text' },
      { title: '开课院系', content: '软件与通信学院', type: 'text' },
      { title: '建议修读学期', content: '3', type: 'text' },
      { title: '考核方式', content: mode, type: 'text' },
      { title: '备注', type: 'textarea' }
    ] },
    { title: '学时分配', type: 'list', content: [{ title: '总学时', content: '48', type: 'text' }] }
  ];
}

const semesterLessons = {
  arrange_lessons: [
    { lesson_id: 1, course_name: '大学英语Ⅲ（专业认知）', lesson_arrange: ['星期一[5-6节] 1-16周 D-316 吴刚 '], teachers: ['吴刚'], teachclass_std_count: 64 },
    { lesson_id: 2, course_name: '数据库原理', lesson_arrange: ['星期三[5-6节] 7-17周 F2-307 陈伟 ', '星期四[5-6节] 1-10周 F2-307 陈伟 '], teachers: ['陈伟'] },
    { lesson_id: 3, course_name: '马克思主义基本原理', lesson_arrange: [], teachers: ['某老师'] }
  ],
  unarrange_lessons: [
    { lesson_id: 4, course_name: '电子商务那些事', teachers: ['孙学成'], weekstate: '1-19' }
  ]
};

const modes = { 101698: '考试', 105786: '考查', 105622: '考试' };

function stubApi(log) {
  return {
    getMyPlan: async () => { log.push('plan'); return plan; },
    getPlanCourseDetail: async (a, id, type) => {
      log.push('detail:' + id + ':' + type);
      return detail('x', modes[id]);
    },
    getSemesterLessons: async (a, biz, semesterId) => { log.push('lessons:' + semesterId); return semesterLessons; }
  };
}

test('培养方案拍平：课程带上所在课程组，公选模块下没有具体课程', () => {
  const coursePlan = loadCoursePlan({}, createWx());
  const flat = coursePlan.flattenPlan(plan);
  assert.equal(flat.planType, 'major');
  assert.deepEqual(flat.courses.map((c) => [c.id, c.group]), [
    ['101698', '公共基础课程 · 人文社科'],
    ['105786', '公共基础课程 · 人文社科'],
    ['105622', '专业课程 · 核心课程组2']
  ]);
  assert.equal(flat.courses[2].credits, '3.5');
});

test('方案课程详情解析出考核方式，考试 / 考查分开着色', () => {
  const coursePlan = loadCoursePlan({}, createWx());
  const parsed = coursePlan.parsePlanCourseDetail(detail('数据库原理', '考查'));
  assert.equal(parsed.examMode, '考查');
  assert.equal(parsed.suggestTerm, '3');
  assert.equal(parsed.totalHours, '48');
  assert.equal(coursePlan.examModeTone('考试'), 'exam');
  assert.equal(coursePlan.examModeTone('考查'), 'check');
  assert.equal(coursePlan.examModeTone('考察'), 'check');
  assert.equal(coursePlan.examModeTone('论文'), 'other');
  assert.equal(coursePlan.examModeTone(''), '');
});

test('课程名匹配忽略全半角括号和罗马数字写法，课程代码优先', () => {
  const coursePlan = loadCoursePlan({}, createWx());
  const index = coursePlan.buildPlanIndex(coursePlan.flattenPlan(plan));
  assert.equal(coursePlan.matchPlanCourse(index, { courseName: '大学英语III(专业认知)' }).id, '105786');
  assert.equal(coursePlan.matchPlanCourse(index, { courseName: '改过名', courseCode: '43B104094' }).id, '105622');
  assert.equal(coursePlan.matchPlanCourse(index, { courseName: '电子商务那些事' }), null);
});

test('学期全部课程：考试在前、考查其次、公选课最后，只查用得到的课程详情', async () => {
  const log = [];
  const wx = createWx();
  const coursePlan = loadCoursePlan(stubApi(log), wx);
  const result = await coursePlan.loadSemesterCourses(auth, '1', '202', { now: 1000 });
  assert.deepEqual(result.courses.map((c) => [c.courseName, c.tagText, c.tagTone]), [
    ['数据库原理', '考试', 'exam'],
    ['马克思主义基本原理', '考试', 'exam'],
    ['大学英语Ⅲ（专业认知）', '考查', 'check'],
    ['电子商务那些事', '公选课', 'elective']
  ]);
  assert.deepEqual(result.counts, { exam: 2, check: 1, other: 0, elective: 1, unknown: 0 });
  assert.equal(result.total, 4);
  assert.equal(result.courses[0].planGroup, '专业课程 · 核心课程组2');
  assert.equal(result.courses[0].credits, '3.5');
  assert.deepEqual(result.courses[0].arrangements, ['星期三[5-6节] 7-17周 F2-307 陈伟', '星期四[5-6节] 1-10周 F2-307 陈伟']);
  assert.equal(result.courses[3].weekText, '1-19周');
  assert.equal(result.courses[3].arranged, false);
  assert.deepEqual(log.slice().sort(), ['detail:101698:major', 'detail:105622:major', 'detail:105786:major', 'lessons:202', 'plan']);

  // 第二次打开：方案和详情都走缓存，只拉学期课程。
  log.length = 0;
  await coursePlan.loadSemesterCourses(auth, '1', '202', { now: 2000 });
  assert.deepEqual(log, ['lessons:202']);
});

test('培养方案拉不到时课程列表照常出，只是不打标签；单门详情失败不影响别的课', async () => {
  const log = [];
  const api = stubApi(log);
  api.getMyPlan = async () => { throw new Error('request:fail timeout'); };
  let coursePlan = loadCoursePlan(api, createWx());
  let result = await coursePlan.loadSemesterCourses(auth, '1', '202');
  assert.equal(result.planLoaded, false);
  assert.equal(result.total, 4);
  assert(result.courses.every((c) => !c.tagText));

  const api2 = stubApi([]);
  api2.getPlanCourseDetail = async (a, id) => {
    if (id === '105622') throw new Error('boom');
    return detail('x', modes[id]);
  };
  coursePlan = loadCoursePlan(api2, createWx());
  result = await coursePlan.loadSemesterCourses(auth, '1', '202');
  const db = result.courses.find((c) => c.courseName === '数据库原理');
  assert.equal(db.tagText, '');
  assert.equal(result.counts.unknown, 1);
  assert.equal(result.counts.exam, 1);
});

test('课程详情页单查一门：离线时只用缓存，过期的方案在线时重新拉', async () => {
  const log = [];
  const wx = createWx();
  const coursePlan = loadCoursePlan(stubApi(log), wx);
  assert.deepEqual(
    await coursePlan.lookupCourseTag(auth, '1', { courseName: '数据库原理', courseCode: '43B104094' }, { now: 1000 }),
    { examMode: '考试', examTone: 'exam', tagText: '考试', tagTone: 'exam', planGroup: '专业课程 · 核心课程组2', credits: '3.5' }
  );
  assert.deepEqual(log, ['plan', 'detail:105622:major']);

  log.length = 0;
  const offline = Object.assign({}, auth, { offline: true });
  const elective = await coursePlan.lookupCourseTag(offline, '1', { courseName: '企业管理概论' });
  assert.equal(elective.tagText, '公选课');
  const unseen = await coursePlan.lookupCourseTag(offline, '1', { courseName: '马克思主义基本原理' });
  assert.equal(unseen.tagText, '', 'Offline and never fetched: no tag rather than a guess');
  assert.deepEqual(log, []);

  await coursePlan.lookupCourseTag(auth, '1', { courseName: '数据库原理' }, { now: 1000 + 8 * 24 * 3600 * 1000 });
  assert.deepEqual(log, ['plan']);
});
