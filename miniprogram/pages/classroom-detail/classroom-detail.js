const api = require('../../utils/api');
const { withPageShare } = require('../../utils/share');
const { formatDayLabel } = require('../../utils/share-card');

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

function parseDateValue(value) {
  if (!value) {
    return null;
  }
  const normalized = String(value).replace(/\//g, '-');
  const date = new Date(normalized);
  return isNaN(date.getTime()) ? null : date;
}

function getWeekDayName(index) {
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  return names[index] || '';
}

function buildDateList(start) {
  const list = [];
  for (let index = 0; index < 7; index += 1) {
    const date = addDays(start, index);
    const dateStr = formatDate(date);
    list.push({
      date: dateStr,
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
  return { start, end: isNaN(end) ? start : end };
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
  return {
    start: Math.min(startUnit, endUnit),
    end: Math.max(startUnit, endUnit)
  };
}

function pickLessonTime(raw) {
  if (raw.start_time && raw.end_time) {
    return raw.start_time + '-' + raw.end_time;
  }
  if (raw.section_text) {
    return raw.section_text;
  }
  if (raw.lesson_time) {
    return raw.lesson_time;
  }
  if (raw.start_unit && raw.end_unit) {
    return '第' + raw.start_unit + '-' + raw.end_unit + '节';
  }
  if (raw.unit) {
    return '第' + raw.unit + '节';
  }
  return '';
}

function normalizeMaxUnit(data) {
  const source = data && data.data ? data.data : data;
  let maxUnit = source && (source.max_unit || source.maxUnit || source.unit_count || source.unitCount);
  maxUnit = parseInt(maxUnit, 10);
  const list = source && (source.units || source.unit_list || source.course_units || source.courseUnits || source.courseUnitList);
  const unitList = Array.isArray(list) ? list : [];
  if (!maxUnit || isNaN(maxUnit)) {
    maxUnit = unitList.length || 12;
  }
  return {
    maxUnit,
    unitList: unitList.map((item) => ({
      unit: parseInt(item.unit || item.course_unit || item.section || item.id, 10),
      startTime: item.start_time || item.startTime,
      endTime: item.end_time || item.endTime
    })).filter((item) => item.unit)
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
      label: startTime && endTime ? ('第' + index + '节\n' + startTime + '-' + endTime) : ('第' + index + '节'),
      startTime,
      endTime
    });
  }
  return slots;
}

function arrayFromCandidates(source, candidates) {
  for (let index = 0; index < candidates.length; index += 1) {
    if (Array.isArray(candidates[index])) {
      return candidates[index];
    }
  }
  return Array.isArray(source) ? source : [];
}

function extractLessonList(data) {
  const source = data && data.data ? data.data : data;
  if (Array.isArray(source)) {
    return source;
  }
  return arrayFromCandidates(source, [
    source && source.week_lessons,
    source && source.day_lessons,
    source && source.lesson_tables,
    source && source.course_tables,
    source && source.lesson_list,
    source && source.lessons,
    source && source.data,
    source && source.rows
  ]);
}

function normalizeRoomLesson(raw, timeSlots) {
  const rooms = Array.isArray(raw.rooms) ? raw.rooms : [];
  const room = rooms[0] || {};
  const unitRange = parseUnitRange(raw.section_text || raw.lesson_time || raw.time);
  let startUnit = parseInt(raw.start_unit || raw.startUnit || raw.unit || (unitRange && unitRange.start), 10);
  let endUnit = parseInt(raw.end_unit || raw.endUnit || (unitRange && unitRange.end) || startUnit, 10);
  if ((!startUnit || !endUnit) && timeSlots && timeSlots.length) {
    const timeRange = mapTimeToUnitRange(raw.start_time, raw.end_time, timeSlots);
    if (timeRange) {
      startUnit = timeRange.start;
      endUnit = timeRange.end;
    }
  }
  const teachers = Array.isArray(raw.teachers) ? raw.teachers : [];
  const teacher = raw.teacher_name || raw.teacher || raw.teacherName || teachers.map((item) => item.name || item.teacher_name || item.teacherName).filter(Boolean).join('、');
  const timeLabel = pickLessonTime(raw);
  const unitText = startUnit ? ('第' + startUnit + (endUnit && endUnit !== startUnit ? '-' + endUnit : '') + '节') : '';
  return {
    id: raw.id || raw.lesson_id || raw.course_id || raw.task_id || raw.index || raw.courseName,
    courseName: raw.course_name || raw.courseName || raw.lesson_name || raw.name || '未命名课程',
    place: raw.place || raw.class_room || raw.classroom || raw.room || raw.address || room.name || room.address || '',
    teacher,
    timeLabel,
    unitText,
    weekDay: raw.week_day || raw.weekday || raw.day_of_week || raw.weekDay,
    date: raw.date || raw.lesson_date || raw.day_date || raw.course_date || raw.__date || '',
    startUnit: isNaN(startUnit) ? null : startUnit,
    endUnit: isNaN(endUnit) ? null : endUnit
  };
}

function pickSemesterInfo(data, anchorDateStr) {
  const source = data && data.data ? data.data : data;
  const list = Array.isArray(source) ? source : arrayFromCandidates(source, [
    source && source.semesters,
    source && source.semester_list,
    source && source.list,
    source && source.rows,
    source && source.data
  ]);
  if (!list.length) {
    return { id: '' };
  }
  const current = list.find((item) => item && (item.current || item.is_current || item.isCurrent || item.is_current_semester));
  const target = current || list[0];
  if (anchorDateStr) {
    const anchorDate = parseDateValue(anchorDateStr);
    if (anchorDate) {
      const matched = list.find((item) => {
        const start = parseDateValue(item.start_date || item.begin_date || item.startDate || item.beginDate);
        const end = parseDateValue(item.end_date || item.finish_date || item.endDate || item.finishDate);
        return start && end && anchorDate >= start && anchorDate <= end;
      });
      if (matched) {
        return {
          id: matched.id || matched.semester_id || matched.semesterId || '',
          startDate: parseDateValue(matched.start_date || matched.begin_date || matched.startDate || matched.beginDate),
          endDate: parseDateValue(matched.end_date || matched.finish_date || matched.endDate || matched.finishDate)
        };
      }
    }
  }
  return {
    id: target.id || target.semester_id || target.semesterId || '',
    startDate: parseDateValue(target.start_date || target.begin_date || target.startDate || target.beginDate),
    endDate: parseDateValue(target.end_date || target.finish_date || target.endDate || target.finishDate)
  };
}

function getWeekNumber(semesterStart, weekStart) {
  if (!semesterStart || !weekStart) {
    return 1;
  }
  const startBase = startOfWeek(semesterStart);
  const diffMs = weekStart.getTime() - startBase.getTime();
  const diffWeeks = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
  return Math.max(1, diffWeeks + 1);
}

function getAuthOrRedirect() {
  const auth = wx.getStorageSync('auth');
  if (!auth || !auth.token || !auth.secret) {
    wx.reLaunch({
      url: '/pages/login/login'
    });
    return null;
  }
  return auth;
}

function getBizTypeId(auth) {
  return auth && auth.bizTypes && auth.bizTypes[0] ? auth.bizTypes[0].id : '';
}

Page(withPageShare({
  data: {
    loading: false,
    error: '',
    roomId: '',
    roomName: '',
    weekLabel: '',
    weekDays: [],
    timeSlots: [],
    dayColumns: [],
    gridHeight: ROW_HEIGHT * DEFAULT_TIME_SLOTS.length,
    anchorDate: formatDate(new Date())
  },

  onLoad(options) {
    const roomId = options.roomId || '';
    const roomName = options.roomName ? decodeURIComponent(options.roomName) : '';
    const anchorDate = parseDateValue(options.anchorDate);
    const nextData = {
      roomId,
      roomName
    };
    if (anchorDate) {
      nextData.anchorDate = formatDate(anchorDate);
    }
    this.setData(nextData);
    this.loadRoomTable();
  },
  getShareOptions() {
    return {
      roomId: this.data.roomId || '',
      roomName: this.data.roomName || '',
      anchorDate: this.data.anchorDate || ''
    };
  },

  getShareCard() {
    const now = new Date();
    const today = formatDate(now);
    const column = (this.data.dayColumns || []).find((item) => item && item.date === today);
    const card = {
      theme: 'teal',
      eyebrow: '教室课表',
      headline: this.data.roomName || '教室课表',
      sub: this.data.weekLabel ? this.data.weekLabel + ' · 点开查看整周安排' : '点开查看整周安排'
    };
    if (!column) {
      return card;
    }
    const lessons = (column.lessons || []).slice().sort((a, b) => a.top - b.top);
    card.sub = '今天 ' + formatDayLabel(now).split(' ')[0] + ' · ' + (lessons.length ? lessons.length + ' 节课在这里上' : '全天没有排课');
    card.rows = lessons.map((lesson) => ({
      label: lesson.unitText || lesson.timeLabel || '—',
      text: [lesson.courseName, lesson.teacher].filter(Boolean).join(' · ')
    }));
    card.note = lessons.length ? '' : '今天这间教室全天空闲，适合自习';
    return card;
  },

  onPullDownRefresh() {
    this.loadRoomTable(true);
  },

  prevWeek() {
    this.shiftWeek(-7);
  },

  nextWeek() {
    this.shiftWeek(7);
  },

  shiftWeek(diffDays) {
    const current = parseDateValue(this.data.anchorDate) || new Date();
    const next = addDays(current, diffDays);
    this.setData({
      anchorDate: formatDate(next)
    });
    this.loadRoomTable();
  },

  onTapLesson(e) {
    const dayIndex = parseInt(e.currentTarget.dataset.dayIndex, 10);
    const lessonIndex = parseInt(e.currentTarget.dataset.lessonIndex, 10);
    const day = this.data.dayColumns[dayIndex];
    const lesson = day && day.lessons ? day.lessons[lessonIndex] : null;
    if (!lesson) {
      return;
    }
    const content = [
      '教室:' + (lesson.place || '暂无'),
      '节数:' + (lesson.unitText || '暂无'),
      '时间:' + (lesson.timeLabel || '暂无'),
      '教师:' + (lesson.teacher || '暂无')
    ].join('\n');
    wx.showModal({
      title: lesson.courseName || '课程详情',
      content,
      showCancel: false
    });
  },

  loadRoomTable(fromPullDown) {
    const auth = getAuthOrRedirect();
    if (!auth) {
      return;
    }
    const bizTypeId = getBizTypeId(auth);
    if (!bizTypeId || !this.data.roomId) {
      this.setData({
        error: '缺少教室参数'
      });
      return;
    }

    const anchorDate = parseDateValue(this.data.anchorDate) || new Date();
    this.setData({
      loading: true,
      error: ''
    });

    api.getSemesters(auth, bizTypeId)
      .then((semesterData) => {
        const semesterInfo = pickSemesterInfo(semesterData, this.data.anchorDate);
        if (!semesterInfo.id) {
          throw new Error('未获取到学期信息');
        }
        let anchor = anchorDate;
        if (semesterInfo.startDate && anchor < semesterInfo.startDate) {
          anchor = semesterInfo.startDate;
        }
        if (semesterInfo.endDate && anchor > semesterInfo.endDate) {
          anchor = semesterInfo.endDate;
        }
        const weekStart = startOfWeek(anchor);
        const weekEnd = addDays(weekStart, 6);
        const weekNumber = getWeekNumber(semesterInfo.startDate, weekStart);
        const weekDays = buildDateList(weekStart);
        const weekLabel = '第' + weekNumber + '周';
        this.setData({
          anchorDate: formatDate(anchor),
          weekLabel,
          weekDays
        });
        return api.getMaxUnit(auth, bizTypeId)
          .catch(() => ({}))
          .then((maxData) => {
            const timeSlots = buildTimeSlots(maxData);
            this.setData({
              timeSlots,
              gridHeight: ROW_HEIGHT * timeSlots.length
            });
            return api.getRoomTables(auth, bizTypeId, semesterInfo.id, this.data.roomId, weekNumber, formatDate(weekStart), formatDate(weekEnd))
              .then((roomTableData) => ({ roomTableData, weekDays, timeSlots }));
          });
      })
      .then((payload) => {
        const lessons = extractLessonList(payload.roomTableData).map((raw) => normalizeRoomLesson(raw, payload.timeSlots));
        const dateIndexMap = {};
        const courseColorMap = {};
        payload.weekDays.forEach((item, index) => {
          dateIndexMap[item.date] = index;
        });
        const dayColumns = payload.weekDays.map((item) => ({
          date: item.date,
          lessons: []
        }));
        lessons.forEach((lesson) => {
          const dayIndex = lesson.date && Object.prototype.hasOwnProperty.call(dateIndexMap, lesson.date)
            ? dateIndexMap[lesson.date]
            : (lesson.weekDay ? parseInt(lesson.weekDay, 10) - 1 : -1);
          if (dayIndex < 0 || dayIndex > 6 || !lesson.startUnit || !lesson.endUnit) {
            return;
          }
          if (!courseColorMap[lesson.courseName]) {
            let hash = 0;
            for (let index = 0; index < lesson.courseName.length; index += 1) {
              hash = lesson.courseName.charCodeAt(index) + ((hash << 5) - hash);
            }
            courseColorMap[lesson.courseName] = (Math.abs(hash) % 8) + 1;
          }
          const span = Math.max(1, lesson.endUnit - lesson.startUnit + 1);
          dayColumns[dayIndex].lessons.push({
            id: lesson.id,
            courseName: lesson.courseName,
            meta: lesson.timeLabel || lesson.unitText || '',
            place: lesson.place,
            teacher: lesson.teacher,
            timeLabel: lesson.timeLabel,
            unitText: lesson.unitText,
            top: (lesson.startUnit - 1) * ROW_HEIGHT,
            height: span * ROW_HEIGHT,
            colorIndex: courseColorMap[lesson.courseName]
          });
        });
        this.setData({
          dayColumns
        });
        if (this.refreshShareCard) {
          this.refreshShareCard();
        }
      })
      .catch((err) => {
        this.setData({
          error: err.message || '获取教室课表失败',
          dayColumns: []
        });
      })
      .then(() => {
        this.setData({
          loading: false
        });
        if (fromPullDown) {
          wx.stopPullDownRefresh();
        }
      });
  }
}));
