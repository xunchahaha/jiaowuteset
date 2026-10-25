// 考试数据整理：考试页和登录预热共用，保证缓存格式一致。
function parseDateValue(value) {
  if (!value) {
    return null;
  }
  const normalized = String(value).replace(/\//g, '-');
  const date = new Date(normalized);
  return isNaN(date.getTime()) ? null : date;
}

function normalizeSemester(item) {
  const id = item.id || item.semester_id || item.semesterId || '';
  let name = item.name || item.semester_name || item.semester_text || item.text || item.semester;
  const year = item.year || item.academic_year || item.school_year;
  const term = item.term || item.term_name || item.termName;

  if (year && (name || term)) {
    const termName = (name === '1' || term === '1') ? '第一学期' :
      (name === '2' || term === '2') ? '第二学期' :
        (term || name);
    name = `${year}学年 ${termName}`;
  } else if (item.code) {
    const parts = item.code.split('-');
    if (parts.length === 3) {
      name = `${parts[0]}-${parts[1]}学年 第${parts[2] === '1' ? '一' : '二'}学期`;
    }
  }

  if ((!name || /^\d+$/.test(name) || name === id) && String(id).split('-').length === 3) {
    const parts = String(id).split('-');
    name = `${parts[0]}-${parts[1]}学年 第${parts[2] === '1' ? '一' : '二'}学期`;
  }

  const startDate = parseDateValue(item.start_date || item.begin_date || item.startDate || item.beginDate || item.from_date || item.fromDate);
  const endDate = parseDateValue(item.end_date || item.finish_date || item.endDate || item.finishDate || item.to_date || item.toDate);
  return {
    id: String(id),
    label: name || (id ? '学期 ' + id : ''),
    current: !!(item.current || item.is_current || item.isCurrent || item.is_current_semester),
    startDate,
    endDate
  };
}

function extractExamList(data) {
  const source = data && data.data ? data.data : data;
  if (Array.isArray(source)) {
    return source;
  }
  const candidates = [
    source && source.exam_tasks,
    source && source.exam_task_list,
    source && source.examTasks,
    source && source.task_list,
    source && source.tasks,
    source && source.list,
    source && source.rows,
    source && source.data
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    if (Array.isArray(candidates[i])) {
      return candidates[i];
    }
  }
  return [];
}

// 只缓存学期的 id / 名称，日期对象不进缓存。
function toSemesterOption(semester) {
  return {
    id: semester.id,
    label: semester.label
  };
}

module.exports = {
  normalizeSemester,
  toSemesterOption,
  extractExamList
};
