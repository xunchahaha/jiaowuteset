// 课表一周的数据整理：课表页和登录预热共用，保证两边写进缓存的数据格式完全一致。
const { pickCurrentSemesterItem } = require('./semester');

const DEFAULT_TIME_SLOTS = [
  { unit: 1, startTime: '08:30', endTime: '09:15' },
  { unit: 2, startTime: '09:20', endTime: '10:05' },
  { unit: 3, startTime: '10:20', endTime: '11:05' },
  { unit: 4, startTime: '11:10', endTime: '11:55' },
  { unit: 5, startTime: '14:00', endTime: '14:45' },
  { unit: 6, startTime: '14:50', endTime: '15:35' },
  { unit: 7, startTime: '15:50', endTime: '16:35' },
  { unit: 8, startTime: '16:40', endTime: '17:25' },
  { unit: 9, startTime: '18:20', endTime: '19:05' },
  { unit: 10, startTime: '19:10', endTime: '19:55' },
  { unit: 11, startTime: '20:00', endTime: '20:45' },
  { unit: 12, startTime: '20:50', endTime: '21:35' }
];
const ROW_HEIGHT = 110;

function pad(value) {
  return value < 10 ? '0' + value : String(value);
}

function formatDate(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function parseDateValue(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  const normalized = String(value).replace(/\//g, '-');
  const date = new Date(normalized);
  return isNaN(date.getTime()) ? null : date;
}

function startOfWeek(date) {
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const start = new Date(date);
  start.setDate(start.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getWeekDayName(index) {
  return ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][index] || '';
}

function buildDateList(start) {
  const list = [];
  for (let index = 0; index < 7; index += 1) {
    const date = addDays(start, index);
    const dateStr = formatDate(date);
    list.push({
      date: dateStr,
      label: getWeekDayName(index) + ' ' + dateStr.slice(5),
      name: getWeekDayName(index),
      dateShort: dateStr.slice(5)
    });
  }
  return list;
}

function parseUnitRange(text) {
  if (!text) {
    return null;
  }
  const matches = String(text).match(/(\d+)/g);
  if (!matches || !matches.length) {
    return null;
  }
  const start = parseInt(matches[0], 10);
  const end = parseInt(matches[1] || matches[0], 10);
  if (isNaN(start)) {
    return null;
  }
  return {
    start,
    end: isNaN(end) ? start : end
  };
}

function timeToMinutes(text) {
  if (!text) {
    return null;
  }
  const parts = String(text).split(':');
  if (parts.length < 2) {
    return null;
  }
  const hour = parseInt(parts[0], 10);
  const minute = parseInt(parts[1], 10);
  if (isNaN(hour) || isNaN(minute)) {
    return null;
  }
  return hour * 60 + minute;
}

function mapTimeToUnitRange(startTime, endTime, timeSlots) {
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);
  if (startMinutes === null || endMinutes === null) {
    return null;
  }

  let startUnit = null;
  let endUnit = null;
  timeSlots.forEach((slot) => {
    const slotStart = timeToMinutes(slot.startTime);
    const slotEnd = timeToMinutes(slot.endTime);
    if (slotStart === null || slotEnd === null) {
      return;
    }
    if (startUnit === null && startMinutes >= slotStart && startMinutes <= slotEnd) {
      startUnit = slot.unit;
    }
    if (endMinutes >= slotStart && endMinutes <= slotEnd) {
      endUnit = slot.unit;
    }
  });

  if (startUnit === null && timeSlots.length) {
    const exactStart = timeSlots.find((slot) => slot.startTime === startTime);
    startUnit = exactStart ? exactStart.unit : null;
  }
  if (endUnit === null && timeSlots.length) {
    const exactEnd = timeSlots.find((slot) => slot.endTime === endTime);
    endUnit = exactEnd ? exactEnd.unit : null;
  }
  if (startUnit === null && endUnit !== null) {
    startUnit = endUnit;
  }
  if (endUnit === null && startUnit !== null) {
    endUnit = startUnit;
  }
  if (startUnit === null || endUnit === null) {
    return null;
  }
  if (endUnit < startUnit) {
    const temp = startUnit;
    startUnit = endUnit;
    endUnit = temp;
  }
  return { start: startUnit, end: endUnit };
}

function pickLessonTime(lesson) {
  if (lesson.start_time && lesson.end_time) {
    return lesson.start_time + '-' + lesson.end_time;
  }
  if (lesson.section_text) {
    return lesson.section_text;
  }
  if (lesson.lesson_time) {
    return lesson.lesson_time;
  }
  if (lesson.start_unit && lesson.end_unit) {
    return `第${lesson.start_unit}-${lesson.end_unit}节`;
  }
  if (lesson.unit) {
    return `第${lesson.unit}节`;
  }
  return '';
}

function normalizeLesson(raw, timeSlots) {
  const rooms = Array.isArray(raw.rooms) ? raw.rooms : [];
  const teachers = Array.isArray(raw.teachers) ? raw.teachers : [];
  const room = rooms[0] || {};
  const teacherNames = teachers.map((item) => item.name || item.teacher_name || item.teacherName).filter(Boolean);
  const unitRange = parseUnitRange(raw.section_text);
  let startUnit = raw.start_unit || raw.startUnit || raw.unit || (unitRange ? unitRange.start : null);
  let endUnit = raw.end_unit || raw.endUnit || (unitRange ? unitRange.end : null) || startUnit;
  if (!startUnit || !endUnit) {
    const timeRange = mapTimeToUnitRange(raw.start_time, raw.end_time, timeSlots);
    if (timeRange) {
      startUnit = timeRange.start;
      endUnit = timeRange.end;
    }
  }
  const unitText = startUnit
    ? (endUnit && endUnit !== startUnit ? `第${startUnit}-${endUnit}节` : `第${startUnit}节`)
    : '';
  const timeText = pickLessonTime(raw);
  const startSlot = startUnit && timeSlots[startUnit - 1] ? timeSlots[startUnit - 1] : null;
  const endSlot = endUnit && timeSlots[endUnit - 1] ? timeSlots[endUnit - 1] : null;
  const place = raw.place || raw.class_room || raw.classroom || raw.room || raw.address || room.name || room.address || '';
  return {
    id: raw.id || raw.lesson_id || raw.course_id || raw.task_id || raw.index || raw.courseName,
    courseName: raw.course_name || raw.courseName || raw.lesson_name || raw.name || '未命名课程',
    place,
    teacher: raw.teacher_name || raw.teacher || raw.teacherName || teacherNames.join('、'),
    timeLabel: timeText || unitText,
    unitText,
    meta: [timeText || unitText, place].filter(Boolean).join(' | '),
    startTime: raw.start_time || raw.startTime || (startSlot ? startSlot.startTime : ''),
    endTime: raw.end_time || raw.endTime || (endSlot ? endSlot.endTime : ''),
    startUnit: startUnit ? parseInt(startUnit, 10) : null,
    endUnit: endUnit ? parseInt(endUnit, 10) : null,
    weekDay: raw.week_day || raw.weekday || raw.day_of_week || raw.weekDay,
    date: raw.date || raw.lesson_date || raw.day_date || raw.course_date || raw.__date
  };
}

function normalizeMaxUnit(data) {
  const source = data && data.data ? data.data : data;
  let maxUnit = source && (source.max_unit || source.maxUnit || source.unit_count || source.unitCount);
  maxUnit = parseInt(maxUnit, 10);
  const list = source && (source.units || source.unit_list || source.course_units || source.course_unit || source.courseUnits || source.courseUnitList);
  const unitList = Array.isArray(list) ? list : [];
  if (!maxUnit || isNaN(maxUnit)) {
    maxUnit = unitList.length || 12;
  }
  return {
    maxUnit,
    unitList: unitList.map((item) => {
      const unit = parseInt(item.unit || item.course_unit || item.section || item.index || item.id, 10);
      return {
        unit: isNaN(unit) ? null : unit,
        startTime: item.start_time || item.startTime,
        endTime: item.end_time || item.endTime
      };
    }).filter((item) => item.unit)
  };
}

function buildTimeSlots(maxData) {
  const parsed = normalizeMaxUnit(maxData || {});
  const byUnit = {};
  parsed.unitList.forEach((item) => {
    byUnit[item.unit] = item;
  });
  const maxUnit = Math.max(parsed.maxUnit || 0, DEFAULT_TIME_SLOTS.length);
  const slots = [];
  for (let index = 1; index <= maxUnit; index += 1) {
    const fallback = DEFAULT_TIME_SLOTS[index - 1] || {};
    const item = byUnit[index] || {};
    const startTime = item.startTime || fallback.startTime || '';
    const endTime = item.endTime || fallback.endTime || '';
    slots.push({
      unit: index,
      label: startTime && endTime ? (`第${index}节\n${startTime}-${endTime}`) : `第${index}节`,
      startTime,
      endTime
    });
  }
  return slots;
}

function extractLessonList(data) {
  const source = data && data.data ? data.data : data;
  if (Array.isArray(source)) {
    return source;
  }
  const candidates = [
    source && source.week_lessons,
    source && source.day_lessons,
    source && source.lesson_tables,
    source && source.course_tables,
    source && source.lesson_list,
    source && source.lessons
  ];
  let list = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (Array.isArray(candidates[index])) {
      list = candidates[index];
      break;
    }
  }
  if (!list.length) {
    return [];
  }
  if (list[0] && (list[0].lessons || list[0].lesson_list || list[0].course_tables || list[0].lesson_tables)) {
    const flat = [];
    list.forEach((dayItem, index) => {
      const lessons = dayItem.lessons || dayItem.lesson_list || dayItem.course_tables || dayItem.lesson_tables || [];
      const dateKey = dayItem.date || dayItem.lesson_date || dayItem.day_date || dayItem.course_date || '';
      lessons.forEach((item) => {
        flat.push(Object.assign({}, item, {
          __date: dateKey || (source.date_list && source.date_list[index]) || ''
        }));
      });
    });
    return flat;
  }
  return list;
}

function pickSemesterInfo(data, anchorDateStr) {
  return toSemesterInfo(pickCurrentSemesterItem(data, anchorDateStr));
}

function toSemesterInfo(item) {
  if (!item) {
    return { id: '' };
  }
  return {
    id: item.id || item.semester_id || item.semesterId || '',
    startDate: parseDateValue(item.start_date || item.begin_date || item.startDate || item.beginDate || item.from_date || item.fromDate),
    endDate: parseDateValue(item.end_date || item.finish_date || item.endDate || item.finishDate || item.to_date || item.toDate)
  };
}

function getWeekNumber(semesterStart, weekStart) {
  if (!semesterStart || !weekStart) {
    return '';
  }
  const startBase = startOfWeek(semesterStart);
  const diffMs = weekStart.getTime() - startBase.getTime();
  return Math.max(1, Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1);
}

// 把锚点日期限制在学期范围内（学期外的日期显示第一周 / 最后一周）。
function clampAnchor(anchor, semesterInfo) {
  const info = semesterInfo || {};
  let result = anchor;
  if (info.startDate && result < info.startDate) {
    result = info.startDate;
  }
  if (info.endDate && result > info.endDate) {
    result = info.endDate;
  }
  return result;
}

function getWeekStartKey(date) {
  return formatDate(startOfWeek(date));
}

function getWeekLabel(semesterStart, weekStart) {
  const weekNumber = getWeekNumber(semesterStart, weekStart);
  return weekNumber ? ('第' + weekNumber + '周') : '本周';
}

function getWeekRange(semesterInfo, anchorValue) {
  const anchor = clampAnchor(parseDateValue(anchorValue) || new Date(), semesterInfo);
  const start = startOfWeek(anchor);
  return {
    anchor,
    start,
    end: addDays(start, 6)
  };
}

function buildWeekPayload(semesterInfo, anchor, maxData, scheduleData) {
  const start = startOfWeek(anchor);
  const timeSlots = buildTimeSlots(maxData);
  const dateList = buildDateList(start);
  const weekDays = dateList.map((item) => ({
    date: item.date,
    name: item.name,
    dateShort: item.dateShort
  }));
  const dayColumns = dateList.map((item) => ({
    date: item.date,
    lessons: []
  }));
  const extraLessons = [];
  const dateIndexMap = {};
  const colorMap = {};

  dateList.forEach((item, index) => {
    dateIndexMap[item.date] = index;
  });

  extractLessonList(scheduleData).forEach((raw) => {
    const lesson = normalizeLesson(raw, timeSlots);
    const dayIndex = lesson.date && Object.prototype.hasOwnProperty.call(dateIndexMap, lesson.date)
      ? dateIndexMap[lesson.date]
      : (lesson.weekDay ? parseInt(lesson.weekDay, 10) - 1 : -1);
    const startUnit = lesson.startUnit ? parseInt(lesson.startUnit, 10) : null;
    const endUnit = lesson.endUnit ? parseInt(lesson.endUnit, 10) : startUnit;

    if (dayIndex < 0 || dayIndex > 6 || !startUnit || !endUnit || !timeSlots[startUnit - 1]) {
      extraLessons.push(lesson);
      return;
    }

    if (!colorMap[lesson.courseName]) {
      let hash = 0;
      for (let index = 0; index < lesson.courseName.length; index += 1) {
        hash = lesson.courseName.charCodeAt(index) + ((hash << 5) - hash);
      }
      colorMap[lesson.courseName] = (Math.abs(hash) % 8) + 1;
    }

    const span = Math.max(1, endUnit - startUnit + 1);
    dayColumns[dayIndex].lessons.push(Object.assign({}, lesson, {
      top: (startUnit - 1) * ROW_HEIGHT,
      height: span * ROW_HEIGHT,
      colorIndex: colorMap[lesson.courseName]
    }));
  });

  return {
    weekLabel: getWeekLabel(semesterInfo && semesterInfo.startDate, start),
    anchorDate: formatDate(anchor),
    weekDays,
    timeSlots,
    dayColumns,
    extraLessons,
    gridHeight: ROW_HEIGHT * timeSlots.length
  };
}

module.exports = {
  DEFAULT_TIME_SLOTS,
  ROW_HEIGHT,
  formatDate,
  parseDateValue,
  addDays,
  toSemesterInfo,
  pickSemesterInfo,
  clampAnchor,
  getWeekStartKey,
  getWeekLabel,
  getWeekRange,
  buildWeekPayload
};
