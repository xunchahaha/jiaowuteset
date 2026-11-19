function parseDateValue(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  const date = new Date(String(value).replace(/\//g, '-'));
  return isNaN(date.getTime()) ? null : date;
}

function extractSemesterList(data) {
  if (!data) {
    return [];
  }
  if (Array.isArray(data)) {
    return data;
  }
  const candidates = [
    data.semesters,
    data.semester_list,
    data.semesterList,
    data.list,
    data.rows,
    data.data
  ];
  for (let index = 0; index < candidates.length; index += 1) {
    if (Array.isArray(candidates[index])) {
      return candidates[index];
    }
  }
  if (data.data && typeof data.data === 'object') {
    return extractSemesterList(data.data);
  }
  return [];
}

function getSemesterId(item) {
  return item && (item.id || item.semester_id || item.semesterId || '');
}

function getCurrentSemesterId(data) {
  if (!data || Array.isArray(data)) {
    return '';
  }
  const id = data.cur_semester_id || data.current_semester_id || data.currentSemesterId;
  if (id) {
    return id;
  }
  return data.data && typeof data.data === 'object' ? getCurrentSemesterId(data.data) : '';
}

function isCurrentSemester(item) {
  const values = item ? [item.current, item.is_current, item.isCurrent, item.is_current_semester] : [];
  return values.some((value) => value === true || value === 1 || value === '1' || value === 'true');
}

function pickCurrentSemesterItem(data, anchorDateValue) {
  const list = extractSemesterList(data);
  if (!list.length) {
    return null;
  }

  const currentId = getCurrentSemesterId(data);
  if (currentId !== '') {
    const byId = list.find((item) => String(getSemesterId(item)) === String(currentId));
    if (byId) {
      return byId;
    }
  }

  const marked = list.find(isCurrentSemester);
  if (marked) {
    return marked;
  }

  const anchorDate = parseDateValue(anchorDateValue);
  if (anchorDate) {
    const byDate = list.find((item) => {
      const startDate = parseDateValue(item.start_date || item.begin_date || item.startDate || item.beginDate || item.from_date || item.fromDate);
      const endDate = parseDateValue(item.end_date || item.finish_date || item.endDate || item.finishDate || item.to_date || item.toDate);
      return startDate && endDate && anchorDate >= startDate && anchorDate <= endDate;
    });
    if (byDate) {
      return byDate;
    }
  }

  return list[0];
}

module.exports = {
  extractSemesterList,
  pickCurrentSemesterItem
};
