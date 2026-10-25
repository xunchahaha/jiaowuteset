const api = require('../../utils/api');
const { withPageShare } = require('../../utils/share');
const { extractSemesterList } = require('../../utils/semester');
const { loadLatestSemesterData } = require('../../utils/semester-data');
const { buildScopedCacheKey, writeCache, loadWithCache } = require('../../utils/cache');
const { normalizeSemester, toSemesterOption, extractExamList } = require('../../utils/exam-data');

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
  return auth && auth.bizTypes && auth.bizTypes.length ? auth.bizTypes[0].id : '';
}

function normalizeDateKey(value) {
  if (!value) {
    return '';
  }
  const text = String(value).trim();
  const match = text.match(/\d{4}-\d{1,2}-\d{1,2}/);
  return match ? match[0] : text;
}

function parseTimeToMinutes(text) {
  const match = String(text || '').match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return null;
  }
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  return isNaN(h) || isNaN(m) ? null : h * 60 + m;
}

function normalizeExam(item) {
  const dateRaw = item.exam_date || item.date || item.task_date || item.lesson_date || item.day_date || item.plan_date || item.examDate || item.start_date || item.exam_date_text || '';
  const dateKey = normalizeDateKey(dateRaw);
  const startTime = item.start_time || item.time_start || item.begin_time || item.startTime || item.exam_start_time || item.start_time_text || item.beginTime || '';
  const endTime = item.end_time || item.time_end || item.finish_time || item.endTime || item.exam_end_time || item.end_time_text || item.finishTime || '';
  const timeText = item.exam_time || item.time_text || item.timeText || (startTime && endTime ? startTime + '-' + endTime : startTime || '');
  const rooms = Array.isArray(item.rooms) ? item.rooms : [];
  const room = rooms[0] || {};
  const place = item.place_name || item.exam_place || item.place || item.classroom || item.room || item.address || item.location || room.name || room.address || '';
  const seat = item.seat_no || item.seat || item.seat_number || item.seatNo || '';
  const courseName = item.course_name || item.courseName || item.lesson_name || item.name || item.course || '未命名课程';
  const examTypeName = item.exam_type_name || item.examTypeName || item.exam_type || item.examType || '';
  const id = item.id || item.task_id || item.exam_task_id || item.exam_taskid || item.examTaskId || item.lesson_id || (courseName + '-' + (dateKey || dateRaw || '') + '-' + timeText);

  let status = 'upcoming';
  if (dateKey && (endTime || startTime)) {
    const now = new Date();
    const examEndDate = new Date(dateKey);
    const endTimeStr = endTime || startTime;
    const endParts = endTimeStr.split(':').map(Number);
    if (!isNaN(endParts[0]) && !isNaN(endParts[1])) {
      examEndDate.setHours(endParts[0], endParts[1], 0, 0);
      if (examEndDate < now) {
        status = 'finished';
      } else if (startTime) {
        const examStartDate = new Date(dateKey);
        const startParts = startTime.split(':').map(Number);
        if (!isNaN(startParts[0]) && !isNaN(startParts[1])) {
          examStartDate.setHours(startParts[0], startParts[1], 0, 0);
          if (examStartDate <= now && now <= examEndDate) {
            status = 'ongoing';
          }
        }
      }
    }
  }

  return {
    id: String(id),
    courseName,
    examTypeName: examTypeName ? String(examTypeName) : '',
    dateKey,
    dateLabel: dateKey || '未知日期',
    timeText,
    place,
    seat: seat ? String(seat) : '',
    sortTime: parseTimeToMinutes(startTime) || parseTimeToMinutes(timeText) || 9999,
    status
  };
}

function buildGroups(list) {
  const map = {};
  list.forEach((item) => {
    const key = item.dateLabel || '未知日期';
    if (!map[key]) {
      map[key] = [];
    }
    map[key].push(item);
  });
  return Object.keys(map).sort((a, b) => {
    if (a === '未知日期') {
      return 1;
    }
    if (b === '未知日期') {
      return -1;
    }
    return a.localeCompare(b);
  }).map((key) => ({
    date: key,
    dateLabel: key,
    items: map[key].slice().sort((a, b) => {
      if (a.sortTime !== b.sortTime) {
        return a.sortTime - b.sortTime;
      }
      return (a.courseName || '').localeCompare(b.courseName || '');
    })
  }));
}

Page(withPageShare({
  data: {
    examLoading: false,
    examError: '',
    examSemesterOptions: [],
    examSemesterIndex: 0,
    examSemesterLabel: '选择学期',
    examGroups: [],
    showSemesterMenu: false,
    showCacheBanner: false,
    cacheNotice: ''
  },

  getShareConfig() {
    return {
      title: '考试安排'
    };
  },

  getShareCard() {
    const exams = [];
    (this.data.examGroups || []).forEach((group) => {
      (group.items || []).forEach((item) => exams.push(item));
    });
    const pending = exams.filter((item) => item.status !== 'finished');
    const semesterLabel = this.data.examSemesterIndex >= 0 ? this.data.examSemesterLabel : '';
    let headline = '考试安排';
    let sub = semesterLabel || '考试时间地点，一查便知';
    if (pending.length) {
      headline = '还有 ' + pending.length + ' 场考试';
      sub = (pending[0].dateKey ? '最近一场 ' + pending[0].dateKey : '') + (semesterLabel ? ' · ' + semesterLabel : '');
    } else if (exams.length) {
      headline = '考试全部结束啦';
    }
    return {
      theme: 'amber',
      eyebrow: '考试安排',
      headline,
      sub,
      rows: pending.map((item) => ({
        label: item.dateKey ? item.dateKey.slice(5).replace('-', '/') : '待定',
        text: [item.courseName, item.timeText].filter(Boolean).join(' · ')
      })),
      note: pending.length ? '' : (exams.length ? '本学期 ' + exams.length + ' 场考试已完成，好好放松一下' : '暂时还没有排考，记得常来看看')
    };
  },

  onLoad() {
    this.loadExamSemesters();
  },

  onPullDownRefresh() {
    this.refreshExam();
  },

  refreshExam() {
    if (this.data.examSemesterOptions.length && this._examSemesterId) {
      this.loadExamTasks();
      return;
    }
    this.loadExamSemesters();
  },

  toggleSemesterMenu() {
    this.setData({
      showSemesterMenu: !this.data.showSemesterMenu
    });
  },

  closeSemesterMenu() {
    this.setData({
      showSemesterMenu: false
    });
  },

  onSelectSemester(e) {
    const index = e.currentTarget.dataset.index;
    const options = this.data.examSemesterOptions;
    if (index >= 0 && index < options.length) {
      this.setData({
        examSemesterIndex: index,
        examSemesterLabel: options[index].label,
        showSemesterMenu: false
      });
      this._examSemesterId = options[index].id;
      this.loadExamTasks(options[index].id);
    }
  },

  // 首次进入：学期列表 + 默认学期的考试；每个学期的考试另外单独缓存，离线切换学期也能看。
  getOverviewCacheKey(auth) {
    return buildScopedCacheKey('exam-overview', auth);
  },

  getSemesterCacheKey(auth, semesterId) {
    return buildScopedCacheKey('exam-semester', auth, semesterId);
  },

  setCacheNotice(notice) {
    this.setData({
      showCacheBanner: !!notice,
      cacheNotice: notice
    });
  },

  // 缓存的是接口原始考试列表，状态（已结束/进行中）每次渲染时按当前时间重新计算。
  applyExamOverview(payload, meta) {
    const semesters = payload.semesters || [];
    const semester = semesters[payload.semesterIndex];
    const notice = meta && meta.notice ? meta.notice : '';
    this._examSemesterId = semester ? semester.id : '';
    this.setData({
      examSemesterOptions: semesters,
      examSemesterIndex: semester ? payload.semesterIndex : -1,
      examSemesterLabel: semester ? semester.label : '选择学期',
      examGroups: buildGroups((payload.exams || []).map(normalizeExam)),
      examLoading: false,
      examError: '',
      showCacheBanner: !!notice,
      cacheNotice: notice
    });
    if (this.refreshShareCard) {
      this.refreshShareCard();
    }
  },

  applyExamList(payload, meta) {
    const notice = meta && meta.notice ? meta.notice : '';
    this.setData({
      examGroups: buildGroups((payload.exams || []).map(normalizeExam)),
      examLoading: false,
      examError: '',
      showCacheBanner: !!notice,
      cacheNotice: notice
    });
    if (this.refreshShareCard) {
      this.refreshShareCard();
    }
  },

  showExamError(err, fallback) {
    this.setData({
      examLoading: false,
      examError: err.message || fallback,
      examGroups: [],
      showCacheBanner: false,
      cacheNotice: ''
    });
  },

  loadExamSemesters() {
    const auth = getAuthOrRedirect();
    if (!auth) {
      return;
    }
    const bizTypeId = getBizTypeId(auth);
    if (!bizTypeId) {
      this.setData({
        examLoading: false,
        examError: '未找到可用的业务类型',
        examSemesterOptions: [],
        examGroups: []
      });
      return;
    }
    const loadId = this._examLoadId = (this._examLoadId || 0) + 1;
    const isActive = () => this._examLoadId === loadId;
    let shownFromCache = false;
    this.setData({
      examLoading: true,
      examError: '',
      showCacheBanner: false,
      cacheNotice: ''
    });
    return loadWithCache({
      key: this.getOverviewCacheKey(auth),
      offline: !!auth.offline,
      offlineMessage: '当前离线模式，本机暂无考试安排缓存',
      isActive,
      fetch: () => api.getSemesters(auth, bizTypeId).then((data) => {
        const list = extractSemesterList(data).map(normalizeSemester).filter((item) => item.id);
        if (!list.length) {
          throw new Error('未获取到学期信息');
        }
        const semesters = list.map(toSemesterOption);
        if (isActive() && !shownFromCache) {
          // Keep manual selection available even if a subsequent data request fails.
          this.setData({
            examSemesterOptions: semesters,
            examSemesterIndex: -1,
            examSemesterLabel: '选择学期'
          });
        }
        return loadLatestSemesterData(list, (semester) => {
          return api.getExamTasks(auth, bizTypeId, semester.id, '/student').then(extractExamList);
        }, isActive).then((selected) => {
          if (!selected) return undefined;
          writeCache(this.getSemesterCacheKey(auth, list[selected.semesterIndex].id), { exams: selected.items });
          return {
            semesters,
            semesterIndex: selected.semesterIndex,
            exams: selected.items
          };
        });
      }),
      apply: (payload, meta) => {
        shownFromCache = shownFromCache || meta.fromCache;
        this.applyExamOverview(payload, meta);
      },
      setNotice: (notice) => this.setCacheNotice(notice),
      onError: (err) => this.showExamError(err, '获取学期失败')
    }).then(() => {
      if (isActive()) {
        wx.stopPullDownRefresh();
      }
    });
  },

  loadExamTasks(semesterId) {
    const auth = getAuthOrRedirect();
    if (!auth) {
      return Promise.resolve();
    }
    const bizTypeId = getBizTypeId(auth);
    const targetSemesterId = semesterId || this._examSemesterId;
    if (!bizTypeId || !targetSemesterId) {
      this.setData({
        examLoading: false,
        examError: !bizTypeId ? '未找到可用的业务类型' : '未获取到学期信息',
        examGroups: []
      });
      wx.stopPullDownRefresh();
      return Promise.resolve();
    }
    const loadId = this._examLoadId = (this._examLoadId || 0) + 1;
    const isActive = () => this._examLoadId === loadId;
    this.setData({
      examLoading: true,
      examError: '',
      showCacheBanner: false,
      cacheNotice: ''
    });
    return loadWithCache({
      key: this.getSemesterCacheKey(auth, targetSemesterId),
      offline: !!auth.offline,
      offlineMessage: '离线模式，这个学期的考试安排还没有缓存过',
      isActive,
      fetch: () => api.getExamTasks(auth, bizTypeId, targetSemesterId, '/student')
        .then((data) => ({ exams: extractExamList(data) })),
      apply: (payload, meta) => this.applyExamList(payload, meta),
      setNotice: (notice) => this.setCacheNotice(notice),
      onError: (err) => this.showExamError(err, '获取考试安排失败')
    }).then(() => {
      if (isActive()) {
        wx.stopPullDownRefresh();
      }
    });
  }
}));
