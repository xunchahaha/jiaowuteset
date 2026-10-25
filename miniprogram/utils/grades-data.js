// 成绩数据整理：成绩页和登录预热共用，保证缓存格式一致。
const GRADE_BIZ_PREF_KEY = 'gradeBizTypeId';

function normalizeBizTypes(auth) {
  const list = auth && Array.isArray(auth.bizTypes) ? auth.bizTypes : [];
  return list.map((item) => ({
    id: String(item.id || ''),
    name: item.name || item.biz_type_name || item.bizTypeName || ('业务类型 ' + (item.id || ''))
  })).filter((item) => item.id);
}

function pickDefaultBizTypeIndex(options) {
  if (!options.length) {
    return -1;
  }
  const stored = wx.getStorageSync(GRADE_BIZ_PREF_KEY);
  if (stored) {
    const storedIndex = options.findIndex((item) => item.id === String(stored));
    if (storedIndex >= 0) {
      return storedIndex;
    }
  }
  const undergraduateIndex = options.findIndex((item) => String(item.name).indexOf('本科') >= 0);
  if (undergraduateIndex >= 0) {
    return undergraduateIndex;
  }
  return 0;
}

function buildGradesPayload(gradesData, semesterData) {
  const data = gradesData;
  if (!data) {
    return {
      semesters: [],
      totalGp: '-',
      totalCredits: '-'
    };
  }

  const semesterMap = {};
  const semesterList = (semesterData && semesterData.semesters) || [];
  semesterList.forEach((item) => {
    if (item.id && item.year && item.name) {
      const termName = item.name === '1' ? '\u7b2c\u4e00\u5b66\u671f' : (item.name === '2' ? '\u7b2c\u4e8c\u5b66\u671f' : item.name);
      semesterMap[item.id] = `${item.year}\u5b66\u5e74 ${termName}`;
    }
  });

  const semesters = (data.semester_lessons || []).map((semester) => {
    let text = semester.semester_text;
    if (!text || text === semester.id || /^\d+$/.test(text) || text.includes('\u5b66\u671f 1') || text.includes('\u5b66\u671f 2')) {
      if (semesterMap[semester.id]) {
        text = semesterMap[semester.id];
      } else {
        text = semester.semester_text || `\u5b66\u671f ${semester.id}`;
      }
    }
    return {
      id: semester.id,
      text,
      lessons: (semester.lessons || []).map((lesson) => ({
        id: lesson.id,
        courseName: lesson.course_name,
        courseCode: lesson.course_code || '',
        courseCredit: lesson.course_credit,
        courseGp: lesson.course_gp,
        scoreText: lesson.score_text,
        passed: lesson.passed !== 'false',
        expanded: false,
        examGrades: (lesson.exam_grades || []).map((exam) => ({
          type: exam.type,
          scoreText: exam.score_text,
          passed: exam.passed !== 'false'
        }))
      }))
    };
  });

  return {
    semesters,
    totalGp: data.total_gp || '-',
    totalCredits: data.total_credits || '-'
  };
}

function pickGradeBizType(auth) {
  const options = normalizeBizTypes(auth);
  const index = pickDefaultBizTypeIndex(options);
  return index >= 0 ? options[index] : null;
}

module.exports = {
  GRADE_BIZ_PREF_KEY,
  normalizeBizTypes,
  pickDefaultBizTypeIndex,
  pickGradeBizType,
  buildGradesPayload
};
