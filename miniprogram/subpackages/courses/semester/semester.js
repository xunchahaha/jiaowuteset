const api = require('../../../utils/api');
const { buildScopedCacheKey, loadWithCache } = require('../../../utils/cache');
const { extractSemesterList, pickCurrentSemesterItem } = require('../../../utils/semester');
const { loadSemesterCourses } = require('../../../utils/course-plan');

const LESSON_DETAIL_KEY = 'currentLessonDetail';
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'exam', label: '考试' },
  { key: 'check', label: '考查' },
  { key: 'other', label: '其他' },
  { key: 'elective', label: '公选课' }
];

function getPrimaryBizTypeId(auth) {
  return auth && auth.bizTypes && auth.bizTypes.length ? auth.bizTypes[0].id : '';
}

function decodeOption(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return String(value);
  }
}

function semesterLabel(item) {
  if (!item) return '';
  if (item.year && item.season) return item.year + ' ' + item.season + '季学期';
  return item.code || item.name || '';
}

function findSemester(data, semesterId) {
  const list = extractSemesterList(data);
  if (semesterId) {
    return list.find((item) => String(item.id || item.semester_id) === String(semesterId)) || null;
  }
  return pickCurrentSemesterItem(data, new Date());
}

Page({
  data: {
    loading: false,
    error: '',
    semesterId: '',
    semesterLabel: '',
    courses: [],
    visibleCourses: [],
    total: 0,
    planLoaded: true,
    filter: 'all',
    filters: [],
    showCacheBanner: false,
    cacheNotice: ''
  },

  onLoad(options) {
    const auth = wx.getStorageSync('auth') || {};
    this.setData({
      semesterId: (options && options.semesterId) || auth.semesterId || '',
      semesterLabel: decodeOption(options && options.semesterLabel)
    });
    this.loadCourses();
  },

  onPullDownRefresh() {
    Promise.resolve(this.loadCourses()).then(() => wx.stopPullDownRefresh());
  },

  // 学期：课表页带过来的为准；没有就按今天挑当前学期。名字顺手从学期列表里取。
  resolveSemester(auth, bizTypeId) {
    const semesterId = this.data.semesterId;
    return api.getSemesters(auth, bizTypeId)
      .then((data) => {
        const item = findSemester(data, semesterId);
        return {
          id: semesterId || (item && (item.id || item.semester_id)) || '',
          label: semesterLabel(item)
        };
      })
      .catch((err) => {
        if (!semesterId) throw err;
        return { id: semesterId, label: '' };
      });
  },

  loadCourses() {
    const auth = wx.getStorageSync('auth');
    if (!auth || !auth.token || !auth.secret) {
      wx.reLaunch({ url: '/pages/login/login' });
      return Promise.resolve();
    }
    const bizTypeId = getPrimaryBizTypeId(auth);
    const loadId = this._loadId = (this._loadId || 0) + 1;
    this.setData({ loading: !this.data.total, error: '', showCacheBanner: false, cacheNotice: '' });
    return loadWithCache({
      key: buildScopedCacheKey('semester-courses', auth, this.data.semesterId || 'current'),
      writeKey: (payload) => buildScopedCacheKey('semester-courses', auth, payload.semesterId || 'current'),
      offline: !!auth.offline,
      offlineMessage: '离线模式，这个学期的课程还没有缓存过',
      isActive: () => this._loadId === loadId,
      fetch: () => this.resolveSemester(auth, bizTypeId).then((semester) => {
        if (!semester.id) throw new Error('未获取到学期信息');
        return loadSemesterCourses(auth, bizTypeId, semester.id).then((result) => Object.assign({
          semesterId: String(semester.id),
          semesterLabel: semester.label || this.data.semesterLabel
        }, result));
      }),
      apply: (payload, meta) => this.applyPayload(payload, meta),
      setNotice: (notice) => this.setData({ showCacheBanner: !!notice, cacheNotice: notice }),
      onError: (err) => this.setData({ loading: false, error: err.message || '课程加载失败' })
    });
  },

  applyPayload(payload, meta) {
    const counts = payload.counts || {};
    const filters = FILTERS
      .map((item) => Object.assign({}, item, { count: item.key === 'all' ? payload.total : (counts[item.key] || 0) }))
      .filter((item) => item.key === 'all' || item.count);
    const filter = filters.some((item) => item.key === this.data.filter) ? this.data.filter : 'all';
    this.setData({
      loading: false,
      error: '',
      semesterId: payload.semesterId || this.data.semesterId,
      semesterLabel: payload.semesterLabel || this.data.semesterLabel,
      courses: payload.courses || [],
      total: payload.total || 0,
      planLoaded: payload.planLoaded !== false,
      filters,
      filter,
      showCacheBanner: !!(meta && meta.notice),
      cacheNotice: (meta && meta.notice) || ''
    });
    this.applyFilter();
  },

  applyFilter() {
    const filter = this.data.filter;
    this.setData({
      visibleCourses: filter === 'all'
        ? this.data.courses
        : this.data.courses.filter((course) => course.tagTone === filter)
    });
  },

  onFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.key || 'all' });
    this.applyFilter();
  },

  onTapCourse(e) {
    const course = this.data.visibleCourses[parseInt(e.currentTarget.dataset.index, 10)];
    if (!course) return;
    wx.setStorageSync(LESSON_DETAIL_KEY, {
      courseName: course.courseName,
      teacher: course.teacher,
      lessonId: course.lessonId,
      arrangements: course.arrangements && course.arrangements.length
        ? course.arrangements
        : (course.weekText ? ['无固定排课 · ' + course.weekText] : []),
      tagText: course.tagText,
      tagTone: course.tagTone
    });
    wx.navigateTo({ url: '/pages/lesson-detail/lesson-detail' });
  }
});
