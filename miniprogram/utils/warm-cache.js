// 登录 / token 校验通过后在后台预热常用页面的缓存，教务晚上关机时也能离线查看。
// 写入的数据格式和各页面完全一致（共用 schedule-week / grades-data / exam-data）。
const api = require('./api');
const { buildScopedCacheKey, writeCache } = require('./cache');
const { extractSemesterList } = require('./semester');
const { loadLatestSemesterData } = require('./semester-data');
const { pickGradeBizType, buildGradesPayload } = require('./grades-data');
const examData = require('./exam-data');
const {
  formatDate,
  addDays,
  pickSemesterInfo,
  getWeekRange,
  buildWeekPayload
} = require('./schedule-week');

// 同一账号短时间内反复冷启动时不重复预热，打开页面时各页面仍会自己刷新。
const WARM_INTERVAL_MS = 20 * 60 * 1000;
const WARM_STAMP_KEY = 'page-cache-warmed-at';

function getBizTypeId(auth) {
  return auth && auth.bizTypes && auth.bizTypes[0] ? auth.bizTypes[0].id || '' : '';
}

function normalizeSemester(item) {
  const id = item.id || item.semester_id || item.semesterId || '';
  let name = item.name || item.semester_name || item.semester_text || item.text || item.semester;
  const year = item.year || item.academic_year || item.school_year;
  const term = item.term || item.term_name || item.termName;

  if (year && (name || term)) {
    const termName = (name === '1' || term === '1') ? '\u7b2c\u4e00\u5b66\u671f'
      : (name === '2' || term === '2') ? '\u7b2c\u4e8c\u5b66\u671f'
        : (term || name);
    name = `${year}\u5b66\u5e74 ${termName}`;
  }

  let label = name || (year && term ? year + ' ' + term : '') || (year || '');
  if (!label && id) {
    label = '\u5b66\u671f ' + id;
  }

  return {
    id: String(id),
    label,
    current: !!(item.current || item.is_current || item.isCurrent || item.is_current_semester)
  };
}

function normalizeField(field) {
  return {
    title: field && field.title ? field.title : '',
    content: field && field.content ? field.content : '',
    type: field && field.type ? field.type : 'text'
  };
}

function normalizeSection(section) {
  const content = Array.isArray(section && section.content) ? section.content : [];
  const type = section && section.type ? section.type : 'list';
  const fields = content.map(normalizeField);
  const rows = [];

  if (type === 'two-list') {
    for (let index = 0; index < fields.length; index += 2) {
      rows.push(fields.slice(index, index + 2));
    }
  }

  return {
    title: section && section.title ? section.title : '',
    type,
    fields,
    rows
  };
}

function extractSections(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && Array.isArray(data.data)) {
    return data.data;
  }
  if (data && Array.isArray(data.list)) {
    return data.list;
  }
  return [];
}

function buildProfilePayload(sections, auth) {
  const userInfo = auth && auth.userInfo ? auth.userInfo : {};
  return {
    sections,
    profileName: userInfo.user_name || userInfo.userName || '',
    profileCode: userInfo.user_code || userInfo.userCode || '',
    profileDepart: userInfo.depart_name || userInfo.departName || ''
  };
}

function pickFirstValue(source, keys) {
  if (!source || typeof source !== 'object') {
    return '';
  }
  for (let index = 0; index < keys.length; index += 1) {
    const value = source[keys[index]];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return '';
}

function normalizeTextbookItem(item) {
  return {
    id: String(pickFirstValue(item, ['id', 'book_id', 'bookId', 'textbook_id', 'textbookId', 'isbn', 'code']) || ''),
    name: pickFirstValue(item, ['name', 'book_name', 'bookName', 'textbook_name', 'textbookName']) || '\u672a\u547d\u540d\u6559\u6750',
    courseName: pickFirstValue(item, ['course_name', 'courseName', 'lesson_name', 'lessonName']),
    author: pickFirstValue(item, ['author', 'author_name', 'authorName']),
    press: pickFirstValue(item, ['press', 'press_name', 'pressName', 'publisher', 'publisher_name']),
    isbn: pickFirstValue(item, ['isbn', 'book_no', 'bookNo', 'code']),
    raw: item
  };
}

function extractTextbookList(res) {
  if (Array.isArray(res)) {
    return res;
  }
  if (res && res.data && Array.isArray(res.data)) {
    return res.data;
  }
  if (res && Array.isArray(res.list)) {
    return res.list;
  }
  return [];
}


function warmGrades(auth) {
  const bizType = pickGradeBizType(auth);
  if (!bizType) {
    return Promise.resolve();
  }
  return Promise.all([
    api.getGrades(auth, bizType.id, 'all'),
    api.getSemesters(auth, bizType.id).catch(() => ({ semesters: [] }))
  ]).then(([gradesData, semesterData]) => {
    writeCache(buildScopedCacheKey('grades', auth, bizType.id), buildGradesPayload(gradesData, semesterData));
  });
}

function warmProfile(auth, bizTypeId) {
  return api.getUserDetail(auth, bizTypeId).then((res) => {
    const sections = extractSections(res).map(normalizeSection);
    writeCache(buildScopedCacheKey('profile', auth), buildProfilePayload(sections, auth));
  });
}

function warmTextbooks(auth, bizTypeId) {
  return api.getTextbookSemesters(auth, bizTypeId).then((semesterData) => {
    const semesters = extractSemesterList(semesterData).map(normalizeSemester).filter((item) => item.id);
    if (!semesters.length) {
      return;
    }

    return loadLatestSemesterData(semesters, (semester) => {
      return api.getTextbooks(auth, bizTypeId, semester.id).then(extractTextbookList);
    }).then((selected) => {
      const textbooks = selected.items.map(normalizeTextbookItem);
      writeCache(buildScopedCacheKey('textbook-semester', auth, semesters[selected.semesterIndex].id), { textbooks });
      writeCache(buildScopedCacheKey('textbook-overview', auth), {
        semesters,
        semesterIndex: selected.semesterIndex,
        textbooks
      });
    });
  });
}

function warmExams(auth, bizTypeId, semesterPromise) {
  return semesterPromise.then((semesterData) => {
    const list = extractSemesterList(semesterData).map(examData.normalizeSemester).filter((item) => item.id);
    if (!list.length) {
      return;
    }

    return loadLatestSemesterData(list, (semester) => {
      return api.getExamTasks(auth, bizTypeId, semester.id, '/student').then(examData.extractExamList);
    }).then((selected) => {
      writeCache(buildScopedCacheKey('exam-semester', auth, list[selected.semesterIndex].id), { exams: selected.items });
      writeCache(buildScopedCacheKey('exam-overview', auth), {
        semesters: list.map(examData.toSemesterOption),
        semesterIndex: selected.semesterIndex,
        exams: selected.items
      });
    });
  });
}

// 预热本周和下周：周日晚上教务关机时，第二天的课也能离线看到。
function warmSchedule(auth, bizTypeId, semesterPromise) {
  const now = new Date();
  const today = formatDate(now);

  return semesterPromise.then((semesterData) => {
    const info = pickSemesterInfo(semesterData, today);
    if (!info.id) {
      return;
    }

    const maxPromise = api.getMaxUnit(auth, bizTypeId).catch(() => ({}));
    const weeks = [getWeekRange(info, today)];
    // 和课表页点"下一周"时的锚点一致（今天 + 7 天），缓存内容才会完全相同。
    const nextRange = getWeekRange(info, formatDate(addDays(now, 7)));
    if (formatDate(nextRange.start) !== formatDate(weeks[0].start)) {
      weeks.push(nextRange);
    }

    return Promise.allSettled(weeks.map((range) => Promise.all([
      maxPromise,
      api.getCourseTables(auth, bizTypeId, info.id, formatDate(range.start), formatDate(range.end))
    ]).then(([maxData, scheduleData]) => {
      writeCache(buildScopedCacheKey('schedule-week', auth, formatDate(range.start)), buildWeekPayload(info, range.anchor, maxData, scheduleData));
    })));
  });
}

function shouldWarm(auth) {
  const scope = buildScopedCacheKey('warm', auth);
  let stamp;
  try {
    stamp = wx.getStorageSync(WARM_STAMP_KEY);
  } catch (err) {
    stamp = null;
  }
  const now = Date.now();
  if (stamp && stamp.scope === scope && now - stamp.at < WARM_INTERVAL_MS) {
    return false;
  }
  try {
    wx.setStorageSync(WARM_STAMP_KEY, { scope, at: now });
  } catch (err) {
    // 写不进去就每次都预热
  }
  return true;
}

function warmEssentialCaches(auth, options) {
  const bizTypeId = getBizTypeId(auth);
  if (!auth || !auth.token || !auth.secret || !bizTypeId) {
    return Promise.resolve();
  }
  if (!(options && options.force) && !shouldWarm(auth)) {
    return Promise.resolve();
  }

  const semesterPromise = api.getSemesters(auth, bizTypeId).catch(() => []);
  return Promise.allSettled([
    warmGrades(auth),
    warmProfile(auth, bizTypeId),
    warmTextbooks(auth, bizTypeId),
    warmExams(auth, bizTypeId, semesterPromise),
    warmSchedule(auth, bizTypeId, semesterPromise)
  ]);
}

module.exports = {
  warmEssentialCaches
};
