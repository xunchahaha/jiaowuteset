const api = require('../../utils/api');
const { withPageShare } = require('../../utils/share');

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
const DEFAULT_ROOM_KEYWORDS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const ROOM_SEARCH_PAGE_SIZE = 50;
const ROOM_OCCUPANCY_PAGE_SIZE = 100;
const ROW_HEIGHT = 110;
const UNIT_OPTIONS = DEFAULT_TIME_SLOTS.map((item) => '第' + item.unit + '节');

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
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
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
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(start, i);
    const dateStr = formatDate(date);
    list.push({
      date: dateStr,
      name: getWeekDayName(i),
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
  if (endUnit < startUnit) {
    const temp = startUnit;
    startUnit = endUnit;
    endUnit = temp;
  }
  return { start: startUnit, end: endUnit };
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
    source && source.lessons,
    source && source.data,
    source && source.rows
  ];
  for (let index = 0; index < candidates.length; index += 1) {
    if (Array.isArray(candidates[index])) {
      return candidates[index];
    }
  }
  return [];
}

function normalizeRoomLesson(raw, timeSlots) {
  const rooms = Array.isArray(raw.rooms) ? raw.rooms : [];
  const teachers = Array.isArray(raw.teachers) ? raw.teachers : [];
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
  const teacherNames = teachers.map((item) => item.name || item.teacher_name || item.teacherName).filter(Boolean);
  const timeLabel = pickLessonTime(raw);
  return {
    id: raw.id || raw.lesson_id || raw.course_id || raw.task_id || raw.index || raw.courseName,
    courseName: raw.course_name || raw.courseName || raw.lesson_name || raw.name || '未命名课程',
    teacher: raw.teacher_name || raw.teacher || raw.teacherName || teacherNames.join('、'),
    place: raw.place || raw.class_room || raw.classroom || raw.room || raw.address || room.name || room.address || '',
    timeLabel: timeLabel,
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
  const id = target.id || target.semester_id || target.semesterId || '';
  const startDate = parseDateValue(target.start_date || target.begin_date || target.startDate || target.beginDate);
  const endDate = parseDateValue(target.end_date || target.finish_date || target.endDate || target.finishDate);
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
  return { id, startDate, endDate };
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

function getEventValue(e) {
  const detail = e && e.detail;
  if (detail && typeof detail.value !== 'undefined') {
    return detail.value;
  }
  if (typeof detail === 'string') {
    return detail;
  }
  return '';
}

function normalizeRoomSearchKeyword(keyword) {
  return String(keyword || '').trim().toUpperCase();
}

function arrayFromCandidates(source, candidates) {
  for (let index = 0; index < candidates.length; index += 1) {
    const value = candidates[index];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return Array.isArray(source) ? source : [];
}

function normalizeBuilding(raw) {
  return {
    id: raw.id || raw.building_id || raw.buildingId || raw.value || '',
    name: raw.name || raw.building_name || raw.buildingName || raw.building_Name || raw.label || '未命名教学楼',
    campusId: raw.campus_id || raw.campusId || '',
    campusName: raw.campus_name || raw.campusName || raw.parent_name || ''
  };
}

function normalizeRoomCandidate(raw) {
  return {
    id: raw.room_id || raw.roomId || raw.id || '',
    roomName: raw.room_name || raw.roomName || raw.name || raw.room_code || '未命名教室',
    roomCode: raw.room_code || raw.roomCode || raw.code || '',
    buildingName: raw.building_Name || raw.building_name || raw.buildingName || '',
    campusName: raw.campus_name || raw.campusName || '',
    floor: raw.floor || '',
    capacity: raw.capacity || raw.room_capacity || '',
    typeName: raw.type_name || raw.typeName || raw.room_type || raw.type || '',
    occupyUnits: raw.occupy_units || raw.occupyUnits || '',
    raw
  };
}

function extractRoomCandidates(data) {
  const source = data && data.data ? data.data : data;
  return arrayFromCandidates(source, [
    source && source.data,
    source && source.list,
    source && source.rows
  ]).map(normalizeRoomCandidate).filter((item) => item.id);
}

function extractRoomPageMeta(data) {
  const source = data && data.data ? data.data : data;
  const pageNo = parseInt(source && (source.page_no || source.pageNo || 1), 10) || 1;
  const pageSize = parseInt(source && (source.page_size || source.pageSize || 20), 10) || 20;
  const totalCount = parseInt(source && (source.total_count || source.totalCount || 0), 10) || 0;
  const maxPageNo = parseInt(source && (source.max_page_no || source.maxPageNo || Math.ceil(totalCount / pageSize) || 1), 10) || 1;
  return {
    pageNo,
    pageSize,
    totalCount,
    maxPageNo
  };
}

function extractOccupancyDay(data, targetDate) {
  const source = data && data.data ? data.data : data;
  const days = Array.isArray(source) ? source : arrayFromCandidates(source, [
    source && source.list,
    source && source.rows,
    source && source.data
  ]);
  if (!days.length) {
    return null;
  }
  return days.find((item) => item && item.date === targetDate) || days[0];
}

function extractOccupancyRooms(day) {
  const rooms = day && day.rooms ? day.rooms : day;
  const list = arrayFromCandidates(rooms, [
    rooms && rooms.data,
    rooms && rooms.list,
    rooms && rooms.rows
  ]);
  return list.map(normalizeRoomCandidate).filter((item) => item.id);
}

function extractOccupancyPageMeta(day) {
  const rooms = day && day.rooms ? day.rooms : day;
  const pageNo = parseInt(rooms && (rooms.page_no || rooms.pageNo || 1), 10) || 1;
  const pageSize = parseInt(rooms && (rooms.page_size || rooms.pageSize || ROOM_OCCUPANCY_PAGE_SIZE), 10) || ROOM_OCCUPANCY_PAGE_SIZE;
  const totalCount = parseInt(rooms && (rooms.total_count || rooms.totalCount || 0), 10) || 0;
  const maxPageNo = parseInt(rooms && (rooms.max_page_no || rooms.maxPageNo || Math.ceil(totalCount / pageSize) || 1), 10) || 1;
  return {
    pageNo,
    pageSize,
    totalCount,
    maxPageNo
  };
}

function isRoomFreeInRange(raw, startUnit, endUnit) {
  const occupyUnits = String(raw.occupy_units || raw.occupyUnits || raw.occupyUnitsText || '').trim();
  if (!occupyUnits) {
    return true;
  }
  for (let unit = startUnit; unit <= endUnit; unit += 1) {
    if (occupyUnits.charAt(unit - 1) === '1') {
      return false;
    }
  }
  return true;
}

function extractBuildingGroups(data) {
  const source = data && data.data ? data.data : data;
  const campusList = arrayFromCandidates(source, [
    source && source.campus_buildings,
    source && source.campuses,
    source && source.list,
    source && source.rows,
    source && source.data
  ]);

  if (!campusList.length) {
    return [];
  }

  if (campusList.length && !Array.isArray(campusList[0].buildings) && !Array.isArray(campusList[0].building_list) && !Array.isArray(campusList[0].children)) {
    const buildings = campusList.map(normalizeBuilding).filter((item) => item.id);
    return buildings.length ? [{
      campusId: '',
      campusName: '全部校区',
      buildings
    }] : [];
  }

  return campusList.map((campus) => {
    const buildings = arrayFromCandidates(campus, [
      campus && campus.buildings,
      campus && campus.building_list,
      campus && campus.children,
      campus && campus.rooms
    ]).map(normalizeBuilding).filter((item) => item.id);

    return {
      campusId: campus.id || campus.campus_id || campus.campusId || '',
      campusName: campus.name || campus.campus_name || campus.campusName || '默认校区',
      buildings
    };
  }).filter((item) => item.buildings.length);
}

function normalizeScheduleItem(raw) {
  const room = raw.room_name || raw.classroom_name || raw.roomName || raw.name || raw.code || '未命名教室';
  const roomType = raw.room_type_name || raw.type || raw.roomTypeName || '';
  const roomCode = raw.room_code || raw.code || '';
  const lessons = arrayFromCandidates(raw, [
    raw && raw.lessons,
    raw && raw.lesson_list,
    raw && raw.details,
    raw && raw.lessonTables,
    raw && raw.course_tables,
    raw && raw.items
  ]);

  const lessonTags = lessons.map((lesson) => {
    const title = lesson.course_name || lesson.lesson_name || lesson.courseName || lesson.name || '';
    const teacher = lesson.teacher_name || lesson.teacher || lesson.teacherName || '';
    const unit = lesson.section_text || lesson.lesson_time || lesson.time || [lesson.start_unit, lesson.end_unit].filter(Boolean).join('-');
    return [title, teacher, unit].filter(Boolean).join(' / ');
  }).filter(Boolean);

  const occupancy = raw.occupancy_text || raw.borrow_time || raw.time_text || raw.time || raw.schedule_text || lessonTags.join('；');

  return {
    id: raw.id || raw.room_id || raw.roomId || roomCode || room,
    room,
    roomType,
    roomCode,
    occupancy: occupancy || '当前时间段暂无占用信息',
    rawCount: lessons.length
  };
}

function extractSchedules(data) {
  const source = data && data.data ? data.data : data;
  return arrayFromCandidates(source, [
    source && source.list,
    source && source.rows,
    source && source.rooms,
    source && source.room_tables,
    source && source.data
  ]).map(normalizeScheduleItem).filter((item) => item.id);
}

Page(withPageShare({
  data: {
    loading: false,
    queryLoading: false,
    roomLoading: false,
    error: '',
    roomKeyword: '',
    roomSchedules: [],
    roomCandidates: [],
    selectedRoomId: '',
    selectedRoomName: '',
    roomListMode: 'initial',
    roomKeywordCursor: 0,
    roomPageNo: 1,
    roomHasMore: true,
    roomLoadingMore: false,
    roomListTitle: '点击教室直接查看课表',
    freeRoomDate: formatDate(new Date()),
    unitOptions: UNIT_OPTIONS,
    freeStartUnitIndex: 0,
    freeEndUnitIndex: 1,
    freeRoomSummary: '',
    weekLabel: '',
    weekDays: [],
    timeSlots: [],
    dayColumns: [],
    gridHeight: ROW_HEIGHT * DEFAULT_TIME_SLOTS.length,
    anchorDate: ''
  },

  onLoad() {
    this.setData({
      anchorDate: formatDate(new Date())
    });
    this.loadInitialRooms();
  },

  loadInitialRooms() {
    this.setData({
      roomListMode: 'initial',
      roomKeywordCursor: 0,
      roomPageNo: 1,
      roomHasMore: true,
      roomCandidates: [],
      roomListTitle: '点击教室直接查看课表',
      freeRoomSummary: ''
    });
    this.loadMoreRooms(true);
  },

  appendRoomCandidates(nextRooms) {
    const merged = this.data.roomCandidates.slice();
    const seen = {};
    merged.forEach((item) => {
      seen[item.id] = true;
    });
    nextRooms.forEach((item) => {
      if (!item.id || seen[item.id]) {
        return;
      }
      seen[item.id] = true;
      merged.push(item);
    });
    this.setData({
      roomCandidates: merged
    });
    return merged;
  },

  loadMoreRooms(initialLoad) {
    const auth = getAuthOrRedirect();
    if (!auth) {
      return;
    }
    if (this.data.roomLoadingMore || (!initialLoad && !this.data.roomHasMore)) {
      return;
    }
    this.setData({
      loading: !!initialLoad,
      roomLoadingMore: !initialLoad,
      error: ''
    });
    const targetBatchSize = initialLoad ? 20 : 16;
    const fetchNextBatch = (cursor, pageNo, collected) => {
      if (cursor >= DEFAULT_ROOM_KEYWORDS.length) {
        return Promise.resolve({
          nextCursor: cursor,
          nextPageNo: 1,
          rooms: collected,
          hasMore: false
        });
      }
      const keyword = DEFAULT_ROOM_KEYWORDS[cursor];
      return api.searchRoomsByName(auth, keyword, pageNo, ROOM_SEARCH_PAGE_SIZE)
        .then((res) => {
          const rooms = extractRoomCandidates(res);
          const meta = extractRoomPageMeta(res);
          const nextRooms = collected.concat(rooms);
          const hasNextPage = meta.pageNo < meta.maxPageNo;
          if (nextRooms.length >= targetBatchSize) {
            return {
              nextCursor: hasNextPage ? cursor : cursor + 1,
              nextPageNo: hasNextPage ? (meta.pageNo + 1) : 1,
              rooms: nextRooms,
              hasMore: hasNextPage || cursor + 1 < DEFAULT_ROOM_KEYWORDS.length
            };
          }
          if (hasNextPage) {
            return fetchNextBatch(cursor, meta.pageNo + 1, nextRooms);
          }
          return fetchNextBatch(cursor + 1, 1, nextRooms);
        });
    };

    fetchNextBatch(this.data.roomKeywordCursor, this.data.roomPageNo, [])
      .then((result) => {
        const merged = this.appendRoomCandidates(result.rooms);
        this.setData({
          roomKeywordCursor: result.nextCursor,
          roomPageNo: result.nextPageNo,
          roomHasMore: result.hasMore,
          loading: false,
          roomLoadingMore: false,
          error: merged.length ? '' : '暂时没有可查询的教室'
        });
      })
      .catch((err) => {
        this.setData({
          loading: false,
          roomLoadingMore: false,
          error: err.message || '获取教室列表失败'
        });
      });
  },

  onPullDownRefresh() {
    if (this.data.roomKeyword) {
      this.onSearchRoomCandidates();
    } else {
      this.loadInitialRooms();
    }
  },

  onRoomKeywordInput(e) {
    this.setData({
      roomKeyword: String(getEventValue(e) || '').trim(),
      selectedRoomId: '',
      selectedRoomName: '',
      freeRoomSummary: ''
    });
  },

  onFreeRoomDateChange(e) {
    this.setData({
      freeRoomDate: e.detail.value || this.data.freeRoomDate
    });
  },

  onFreeStartUnitChange(e) {
    const startIndex = parseInt(e.detail.value, 10) || 0;
    const nextData = {
      freeStartUnitIndex: startIndex
    };
    if (this.data.freeEndUnitIndex < startIndex) {
      nextData.freeEndUnitIndex = startIndex;
    }
    this.setData(nextData);
  },

  onFreeEndUnitChange(e) {
    const endIndex = parseInt(e.detail.value, 10) || 0;
    const nextData = {
      freeEndUnitIndex: endIndex
    };
    if (endIndex < this.data.freeStartUnitIndex) {
      nextData.freeStartUnitIndex = endIndex;
    }
    this.setData(nextData);
  },

  onSearchRoomCandidates(e) {
    const auth = getAuthOrRedirect();
    if (!auth) {
      return;
    }
    const eventKeyword = String(getEventValue(e) || '').trim();
    const keyword = eventKeyword || this.data.roomKeyword;
    if (!keyword) {
      this.loadInitialRooms();
      return;
    }

    this.setData({
      loading: true,
      error: '',
      roomCandidates: [],
      roomListMode: 'search',
      roomKeyword: keyword,
      roomPageNo: 1,
      roomHasMore: true,
      roomKeywordCursor: 0,
      roomListTitle: '点击教室直接查看课表',
      freeRoomSummary: ''
    });

    api.searchRoomsByName(auth, normalizeRoomSearchKeyword(keyword), 1, ROOM_SEARCH_PAGE_SIZE)
      .then((res) => {
        const roomCandidates = extractRoomCandidates(res);
        const meta = extractRoomPageMeta(res);
        this.setData({
          loading: false,
          roomCandidates,
          roomPageNo: meta.pageNo + 1,
          roomHasMore: meta.pageNo < meta.maxPageNo,
          error: roomCandidates.length ? '' : '未找到匹配教室'
        });
      })
      .catch((err) => {
        this.setData({
          loading: false,
          error: err.message || '搜索教室失败',
          roomCandidates: []
        });
      });
  },

  onSelectRoomCandidate(e) {
    const index = parseInt(e.currentTarget.dataset.index, 10);
    const candidate = this.data.roomCandidates[index];
    if (!candidate) {
      return;
    }
    const anchorPart = this.data.roomListMode === 'free' && this.data.freeRoomDate
      ? '&anchorDate=' + encodeURIComponent(this.data.freeRoomDate)
      : '';
    wx.navigateTo({
      url: '/pages/classroom-detail/classroom-detail?roomId=' + candidate.id + '&roomName=' + encodeURIComponent(candidate.roomName) + anchorPart
    });
  },

  onSearchFreeRooms() {
    const auth = getAuthOrRedirect();
    if (!auth) {
      return;
    }
    const startUnit = this.data.freeStartUnitIndex + 1;
    const endUnit = this.data.freeEndUnitIndex + 1;
    const date = this.data.freeRoomDate || formatDate(new Date());
    const keyword = normalizeRoomSearchKeyword(this.data.roomKeyword);

    this.setData({
      loading: true,
      error: '',
      roomCandidates: [],
      roomListMode: 'free',
      roomPageNo: 1,
      roomHasMore: false,
      roomLoadingMore: false,
      roomListTitle: '空教室查询结果',
      freeRoomSummary: ''
    });

    const fetchKeywordPage = (targetKeyword, pageNo, collected, totalCount) => {
      return api.getRoomOccupancy(auth, date, date, '', targetKeyword, pageNo, ROOM_OCCUPANCY_PAGE_SIZE)
        .then((res) => {
          const day = extractOccupancyDay(res, date);
          const rooms = extractOccupancyRooms(day);
          const meta = extractOccupancyPageMeta(day);
          const freeRooms = rooms.filter((room) => isRoomFreeInRange(room.raw || room, startUnit, endUnit));
          const nextCollected = collected.concat(freeRooms);
          const nextTotalCount = totalCount || meta.totalCount || rooms.length;
          if (meta.pageNo < meta.maxPageNo) {
            return fetchKeywordPage(targetKeyword, meta.pageNo + 1, nextCollected, nextTotalCount);
          }
          return {
            rooms: nextCollected,
            totalCount: nextTotalCount
          };
        });
    };

    const fetchAllKeywords = (index, collected) => {
      if (index >= DEFAULT_ROOM_KEYWORDS.length) {
        return Promise.resolve({
          rooms: collected,
          totalCount: collected.length
        });
      }
      const targetKeyword = DEFAULT_ROOM_KEYWORDS[index];
      return fetchKeywordPage(targetKeyword, 1, [], 0)
        .then((result) => fetchAllKeywords(index + 1, collected.concat(result.rooms)));
    };

    const fetchTask = keyword
      ? fetchKeywordPage(keyword, 1, [], 0)
      : fetchAllKeywords(0, []);

    fetchTask
      .then((result) => {
        const seen = {};
        const rooms = result.rooms.filter((item) => {
          if (!item.id || seen[item.id]) {
            return false;
          }
          seen[item.id] = true;
          return true;
        });
        const rangeText = '第' + startUnit + (endUnit === startUnit ? '' : '-' + endUnit) + '节';
        this.setData({
          loading: false,
          roomCandidates: rooms,
          roomHasMore: false,
          freeRoomSummary: date + ' ' + rangeText + '，空教室 ' + rooms.length + ' 间' + (keyword ? '（关键词：' + keyword + '）' : ''),
          error: rooms.length ? '' : '该时间段没有找到空教室'
        });
      })
      .catch((err) => {
        this.setData({
          loading: false,
          roomCandidates: [],
          freeRoomSummary: '',
          error: err.message || '查询空教室失败'
        });
      });
  },

  onRoomListScrollToLower() {
    const auth = getAuthOrRedirect();
    if (!auth || this.data.roomLoadingMore || !this.data.roomHasMore) {
      return;
    }
    if (this.data.roomListMode === 'search') {
      const keyword = this.data.roomKeyword;
      if (!keyword) {
        return;
      }
      this.setData({
        roomLoadingMore: true,
        error: ''
      });
      api.searchRoomsByName(auth, normalizeRoomSearchKeyword(keyword), this.data.roomPageNo, ROOM_SEARCH_PAGE_SIZE)
        .then((res) => {
          const roomCandidates = extractRoomCandidates(res);
          const meta = extractRoomPageMeta(res);
          this.appendRoomCandidates(roomCandidates);
          this.setData({
            roomLoadingMore: false,
            roomPageNo: meta.pageNo + 1,
            roomHasMore: meta.pageNo < meta.maxPageNo
          });
        })
        .catch((err) => {
          this.setData({
            roomLoadingMore: false,
            error: err.message || '加载更多教室失败'
          });
        });
      return;
    }
    if (this.data.roomListMode === 'free') {
      return;
    }
    this.loadMoreRooms(false);
  }
}));
