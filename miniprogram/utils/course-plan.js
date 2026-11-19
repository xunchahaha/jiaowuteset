// 培养方案 → 考核方式（考试 / 考查）。
// 教务的「我的培养方案」只给课程列表，考核方式要逐门查「方案课程详情」。
// 方案和详情几乎不变，各自整份缓存：方案 7 天、详情 30 天才重新拉，拉失败继续用旧的。
// 公选课不在培养方案里（方案的公选模块下没有具体课程），匹配不上的统一标成「公选课」。
const api = require('./api');
const { buildScopedCacheKey, readCache, writeCache } = require('./cache');

const PLAN_TTL = 7 * 24 * 3600 * 1000;
const DETAIL_TTL = 30 * 24 * 3600 * 1000;
const DETAIL_CONCURRENCY = 4;

function normalizeCourseName(name) {
  return String(name || '')
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/Ⅰ/g, 'I')
    .replace(/Ⅱ/g, 'II')
    .replace(/Ⅲ/g, 'III')
    .replace(/Ⅳ/g, 'IV')
    .replace(/Ⅴ/g, 'V')
    .replace(/Ⅵ/g, 'VI')
    .replace(/Ⅶ/g, 'VII')
    .replace(/Ⅷ/g, 'VIII')
    .toUpperCase();
}

// my-plan 的课程组是树：plan_course_groups 里套 plan_course_groups，课挂在 plan_courses。
function flattenPlan(data) {
  const source = data && data.data && !data.plan_course_groups ? data.data : data;
  const planType = (source && source.plan_type) || 'major';
  const courses = [];
  (function walk(groups, path) {
    (Array.isArray(groups) ? groups : []).forEach((group) => {
      const groupPath = path.concat(group.name || group.course_type_name || '');
      (group.plan_courses || []).forEach((course) => {
        courses.push({
          id: String(course.id || ''),
          code: course.course_code || '',
          name: course.course_name || '',
          credits: course.credits === undefined || course.credits === null ? '' : String(course.credits),
          compulsory: !!course.compulsory,
          group: groupPath.filter(Boolean).join(' · ')
        });
      });
      walk(group.plan_course_groups, groupPath);
    });
  })(source && source.plan_course_groups, []);
  return {
    name: (source && source.name) || '',
    planType,
    courses: courses.filter((course) => course.id)
  };
}

// course-detail 返回若干分区，每个分区 content 是 {title, content} 列表。
function parsePlanCourseDetail(data) {
  const sections = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
  const fields = {};
  sections.forEach((section) => {
    (Array.isArray(section && section.content) ? section.content : []).forEach((item) => {
      if (item && item.title && fields[item.title] === undefined) {
        fields[item.title] = item.content === undefined || item.content === null ? '' : String(item.content).trim();
      }
    });
  });
  return {
    examMode: fields['考核方式'] || '',
    suggestTerm: fields['建议修读学期'] || '',
    department: fields['开课院系'] || '',
    totalHours: fields['总学时'] || ''
  };
}

function examModeTone(mode) {
  if (!mode) return '';
  if (mode.indexOf('考试') >= 0) return 'exam';
  if (mode.indexOf('考查') >= 0 || mode.indexOf('考察') >= 0) return 'check';
  return 'other';
}

function buildPlanIndex(plan) {
  const byCode = {};
  const byName = {};
  ((plan && plan.courses) || []).forEach((course) => {
    if (course.code && !byCode[course.code]) byCode[course.code] = course;
    const key = normalizeCourseName(course.name);
    if (key && !byName[key]) byName[key] = course;
  });
  return { byCode, byName };
}

function matchPlanCourse(index, lesson) {
  if (!index || !lesson) return null;
  if (lesson.courseCode && index.byCode[lesson.courseCode]) return index.byCode[lesson.courseCode];
  return index.byName[normalizeCourseName(lesson.courseName)] || null;
}

// 给一门课贴标签：方案里有 → 考核方式；方案里没有 → 公选课。
function describeCourse(planCourse, detail, planLoaded) {
  if (!planCourse) {
    return planLoaded
      ? { examMode: '', examTone: '', tagText: '公选课', tagTone: 'elective', planGroup: '', credits: '' }
      : { examMode: '', examTone: '', tagText: '', tagTone: '', planGroup: '', credits: '' };
  }
  const examMode = detail && detail.examMode ? detail.examMode : '';
  const tone = examModeTone(examMode);
  return {
    examMode,
    examTone: tone,
    tagText: examMode,
    tagTone: tone,
    planGroup: planCourse.group || '',
    credits: planCourse.credits || ''
  };
}

function normalizeSemesterLessons(data) {
  const source = data && data.data && !data.arrange_lessons && !data.unarrange_lessons ? data.data : data;
  const arranged = (source && source.arrange_lessons) || [];
  const unarranged = (source && source.unarrange_lessons) || [];
  const teachersOf = (item) => (Array.isArray(item.teachers) ? item.teachers : [])
    .map((teacher) => (typeof teacher === 'string' ? teacher : (teacher && teacher.name) || ''))
    .filter(Boolean)
    .join('、');
  return arranged.map((item) => ({
    lessonId: item.lesson_id ? String(item.lesson_id) : '',
    courseName: item.course_name || '未命名课程',
    courseCode: item.course_code || '',
    teacher: teachersOf(item),
    stdCount: item.teachclass_std_count || '',
    arrangements: (Array.isArray(item.lesson_arrange) ? item.lesson_arrange : [])
      .map((text) => String(text || '').trim())
      .filter(Boolean),
    weekText: '',
    arranged: true
  })).concat(unarranged.map((item) => ({
    lessonId: item.lesson_id ? String(item.lesson_id) : '',
    courseName: item.course_name || '未命名课程',
    courseCode: item.course_code || '',
    teacher: teachersOf(item),
    stdCount: item.teachclass_std_count || '',
    arrangements: [],
    weekText: item.weekstate ? item.weekstate + '周' : '',
    arranged: false
  })));
}

// 页面数据：课程按「考试 → 考查 → 其他 → 公选课」排，同类保持教务原顺序。
function buildSemesterCourses(lessons, plan, details) {
  const planLoaded = !!(plan && plan.courses && plan.courses.length);
  const index = buildPlanIndex(plan);
  const order = { exam: 0, check: 1, other: 2, '': 3, elective: 4 };
  const courses = (lessons || []).map((lesson, position) => {
    const planCourse = matchPlanCourse(index, lesson);
    const detail = planCourse && details ? details[planCourse.id] : null;
    return Object.assign({ id: lesson.lessonId || ('course-' + position), position }, lesson, describeCourse(planCourse, detail, planLoaded));
  });
  courses.sort((a, b) => (order[a.tagTone] - order[b.tagTone]) || (a.position - b.position));
  const counts = { exam: 0, check: 0, other: 0, elective: 0, unknown: 0 };
  courses.forEach((course) => {
    if (course.tagTone === 'exam') counts.exam += 1;
    else if (course.tagTone === 'check') counts.check += 1;
    else if (course.tagTone === 'other') counts.other += 1;
    else if (course.tagTone === 'elective') counts.elective += 1;
    else counts.unknown += 1;
  });
  return {
    courses: courses.map((course) => {
      const copy = Object.assign({}, course);
      delete copy.position;
      return copy;
    }),
    counts,
    total: courses.length,
    planLoaded
  };
}

function isFresh(entry, ttl, now) {
  const at = entry && entry.payload && entry.payload.fetchedAt;
  return !!(at && now - at >= 0 && now - at < ttl);
}

// 方案：7 天内用缓存；过期或没有就拉，拉失败退回旧缓存。离线只读缓存。
function loadPlan(auth, bizTypeId, options) {
  const opts = options || {};
  const now = opts.now || Date.now();
  const key = buildScopedCacheKey('course-plan', auth);
  const cached = readCache(key);
  if (auth.offline || (!opts.force && isFresh(cached, PLAN_TTL, now))) {
    return Promise.resolve(cached ? cached.payload : null);
  }
  return api.getMyPlan(auth, bizTypeId).then((data) => {
    const plan = Object.assign(flattenPlan(data), { fetchedAt: now });
    if (plan.courses.length) writeCache(key, plan);
    return plan.courses.length ? plan : (cached ? cached.payload : plan);
  }).catch((err) => {
    if (cached) return cached.payload;
    throw err;
  });
}

function runLimited(items, limit, worker) {
  let cursor = 0;
  const runners = [];
  function next() {
    if (cursor >= items.length) return Promise.resolve();
    const item = items[cursor];
    cursor += 1;
    return Promise.resolve().then(() => worker(item)).catch(() => {}).then(next);
  }
  for (let i = 0; i < Math.min(limit, items.length); i += 1) runners.push(next());
  return Promise.all(runners);
}

// 详情：只查用得到的课，单门失败不影响其他课（那门就不打标签）。
function loadDetails(auth, plan, planCourses, options) {
  const opts = options || {};
  const now = opts.now || Date.now();
  const key = buildScopedCacheKey('course-plan-detail', auth);
  const cached = readCache(key);
  const store = Object.assign({}, cached ? cached.payload : {});
  const wanted = [];
  const seen = {};
  (planCourses || []).forEach((course) => {
    if (!course || seen[course.id]) return;
    seen[course.id] = true;
    const entry = store[course.id];
    const age = entry ? now - (entry.at || 0) : -1;
    if (!entry || !entry.examMode || age < 0 || age >= DETAIL_TTL) wanted.push(course);
  });
  if (auth.offline || !wanted.length) {
    return Promise.resolve(store);
  }
  let changed = false;
  return runLimited(wanted, DETAIL_CONCURRENCY, (course) => api.getPlanCourseDetail(auth, course.id, plan.planType || 'major')
    .then((data) => {
      const detail = parsePlanCourseDetail(data);
      if (detail.examMode) {
        store[course.id] = Object.assign({ at: now }, detail);
        changed = true;
      }
    })).then(() => {
    if (changed) writeCache(key, store);
    return store;
  });
}

// 一组课（课表 / 学期全部课程）连同考核方式一起查好。
function loadExamModes(auth, bizTypeId, lessons, options) {
  return loadPlan(auth, bizTypeId, options).then((plan) => {
    if (!plan || !plan.courses || !plan.courses.length) {
      return { plan: plan || null, details: {} };
    }
    const index = buildPlanIndex(plan);
    const matched = (lessons || []).map((lesson) => matchPlanCourse(index, lesson)).filter(Boolean);
    return loadDetails(auth, plan, matched, options).then((details) => ({ plan, details }));
  });
}

function loadSemesterCourses(auth, bizTypeId, semesterId, options) {
  return api.getSemesterLessons(auth, bizTypeId, semesterId).then((data) => {
    const lessons = normalizeSemesterLessons(data);
    // 方案查不到不影响课程列表本身，只是不打标签。
    return loadExamModes(auth, bizTypeId, lessons, options)
      .catch(() => ({ plan: null, details: {} }))
      .then((result) => buildSemesterCourses(lessons, result.plan, result.details));
  });
}

// 课程详情页用：单门课的考核方式，查不到返回空串，公选课返回「公选课」。
function lookupCourseTag(auth, bizTypeId, lesson, options) {
  return loadExamModes(auth, bizTypeId, [lesson], options).then((result) => {
    const planLoaded = !!(result.plan && result.plan.courses && result.plan.courses.length);
    const planCourse = planLoaded ? matchPlanCourse(buildPlanIndex(result.plan), lesson) : null;
    return describeCourse(planCourse, planCourse ? result.details[planCourse.id] : null, planLoaded);
  });
}

module.exports = {
  normalizeCourseName,
  flattenPlan,
  parsePlanCourseDetail,
  examModeTone,
  buildPlanIndex,
  matchPlanCourse,
  normalizeSemesterLessons,
  buildSemesterCourses,
  loadPlan,
  loadDetails,
  loadExamModes,
  loadSemesterCourses,
  lookupCourseTag
};
