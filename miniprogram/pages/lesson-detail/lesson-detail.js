const api = require('../../utils/api');
const { withPageShare } = require('../../utils/share');
const { buildScopedCacheKey, loadWithCache } = require('../../utils/cache');

const LESSON_DETAIL_KEY = 'currentLessonDetail';

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

function normalizeStudents(data) {
  const source = data && data.data ? data.data : data;
  const list = Array.isArray(source)
    ? source
    : (source && (source.students || source.student_list || source.list || source.rows || source.data)) || [];
  const students = (Array.isArray(list) ? list : []).map((item) => ({
    name: item.name || item.student_name || item.std_name || item.user_name || '未命名',
    code: item.code || item.student_code || item.std_code || item.user_code || ''
  }));
  const totalCount = parseInt(source && (source.total_count || source.totalCount || students.length), 10) || students.length;
  return {
    students,
    totalCount
  };
}

function decodeOptionValue(value) {
  if (!value) {
    return '';
  }
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return String(value);
  }
}

Page(withPageShare({
  data: {
    courseName: '',
    place: '',
    unitText: '',
    timeLabel: '',
    teacher: '',
    lessonId: '',
    students: [],
    studentCount: 0,
    showStudents: false,
    studentsLoading: false,
    studentsError: '',
    showCacheBanner: false,
    cacheNotice: ''
  },

  onLoad(options) {
    const detail = wx.getStorageSync(LESSON_DETAIL_KEY) || {};
    const sharedDetail = {
      courseName: decodeOptionValue(options.courseName),
      place: decodeOptionValue(options.place),
      unitText: decodeOptionValue(options.unitText),
      timeLabel: decodeOptionValue(options.timeLabel),
      teacher: decodeOptionValue(options.teacher),
      lessonId: options.lessonId || ''
    };
    const mergedDetail = Object.assign({}, detail);
    Object.keys(sharedDetail).forEach((key) => {
      if (sharedDetail[key]) {
        mergedDetail[key] = sharedDetail[key];
      }
    });
    this.setData({
      courseName: mergedDetail.courseName || '',
      place: mergedDetail.place || '',
      unitText: mergedDetail.unitText || '',
      timeLabel: mergedDetail.timeLabel || '',
      teacher: mergedDetail.teacher || '',
      lessonId: mergedDetail.lessonId || ''
    });
    if (mergedDetail.lessonId) {
      this.loadStudents(false);
    }
  },
  getShareCard() {
    return {
      theme: 'blue',
      eyebrow: '课程详情',
      headline: this.data.courseName || '课程详情',
      rows: [
        { label: '时间', text: this.data.timeLabel || this.data.unitText },
        { label: '地点', text: this.data.place },
        { label: '教师', text: this.data.teacher }
      ]
    };
  },

  getShareOptions() {
    return {
      courseName: this.data.courseName || '',
      place: this.data.place || '',
      unitText: this.data.unitText || '',
      timeLabel: this.data.timeLabel || '',
      teacher: this.data.teacher || '',
      lessonId: this.data.lessonId || ''
    };
  },

  toggleStudents() {
    if (this.data.showStudents) {
      this.setData({
        showStudents: false
      });
      return;
    }
    if (this.data.students.length) {
      this.setData({
        showStudents: true
      });
      return;
    }
    this.loadStudents(true);
  },

  loadStudents(showAfterLoad) {
    const auth = getAuthOrRedirect();
    if (!auth) {
      return;
    }
    if (!this.data.lessonId) {
      this.setData({
        studentsError: '当前课程没有 lesson_id，暂时无法查询同学名单'
      });
      return;
    }
    const lessonId = this.data.lessonId;
    this.setData({
      studentsLoading: true,
      studentsError: '',
      showCacheBanner: false,
      cacheNotice: ''
    });
    return loadWithCache({
      key: buildScopedCacheKey('lesson-students', auth, lessonId),
      offline: !!auth.offline,
      offlineMessage: '离线模式，这门课的同学名单还没有缓存过',
      isActive: () => this.data.lessonId === lessonId,
      fetch: () => api.getLessonStudents(auth, lessonId).then(normalizeStudents),
      apply: (result, meta) => {
        const patch = {
          students: result.students,
          studentCount: result.totalCount,
          studentsLoading: false,
          studentsError: result.students.length ? '' : '暂无同学名单',
          showCacheBanner: !!meta.notice,
          cacheNotice: meta.notice
        };
        // 刷新回来的新名单不改变用户当前的展开/收起状态。
        if (meta.fromCache || !this.data.students.length) {
          patch.showStudents = showAfterLoad !== false;
        }
        this.setData(patch);
      },
      setNotice: (notice) => this.setData({
        studentsLoading: false,
        showCacheBanner: !!notice,
        cacheNotice: notice
      }),
      onError: (err) => this.setData({
        studentsLoading: false,
        studentsError: err.message || '获取同学名单失败'
      })
    });
  }
}));
