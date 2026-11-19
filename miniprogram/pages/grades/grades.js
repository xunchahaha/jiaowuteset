const api = require('../../utils/api');
const { withPageShare } = require('../../utils/share');
const { buildScopedCacheKey, loadWithCache } = require('../../utils/cache');
const {
  GRADE_BIZ_PREF_KEY,
  normalizeBizTypes,
  pickDefaultBizTypeIndex,
  buildGradesPayload
} = require('../../utils/grades-data');

Page(withPageShare({
  data: {
    loading: false,
    error: '',
    totalGp: '-',
    totalCredits: '-',
    semesters: [],
    bizTypeOptions: [],
    bizTypeLabels: [],
    bizTypeIndex: 0,
    bizTypeLabel: '业务类型',
    showCacheBanner: false,
    cacheNotice: ''
  },

  getGradesShareConfig() {
    const totalGp = this.data && this.data.totalGp ? String(this.data.totalGp) : '-';
    return {
      title: '\u5e73\u5747\u7ee9\u70b9\u4e3a' + totalGp
    };
  },

  getShareConfig() {
    return this.getGradesShareConfig();
  },

  getShareCard() {
    const semesters = this.data.semesters || [];
    const lessonCount = semesters.reduce((total, item) => total + ((item && item.lessons) || []).length, 0);
    return {
      theme: 'green',
      eyebrow: '我的成绩',
      headline: '成绩一览',
      sub: semesters.length ? '共 ' + semesters.length + ' 个学期 · 数据来自教务系统' : '数据来自教务系统',
      stats: [
        { value: this.data.totalGp || '-', label: '平均绩点' },
        { value: this.data.totalCredits || '-', label: '已获学分' },
        { value: lessonCount || '-', label: '课程数' }
      ]
    };
  },

  getTimelineShareConfig() {
    return this.getGradesShareConfig();
  },

  applyGradesPayload(payload, meta) {
    const source = payload || {};
    const notice = meta && meta.notice ? meta.notice : '';
    this.setData({
      semesters: source.semesters || [],
      totalGp: source.totalGp || '-',
      totalCredits: source.totalCredits || '-',
      loading: false,
      error: '',
      showCacheBanner: !!notice,
      cacheNotice: notice
    });
    if (this.refreshShareCard) {
      this.refreshShareCard();
    }
  },

  onShow() {
    this.loadGrades();
  },

  prepareBizTypeOptions(auth) {
    const options = normalizeBizTypes(auth);
    const index = pickDefaultBizTypeIndex(options);
    const picked = index >= 0 ? options[index] : null;
    this.setData({
      bizTypeOptions: options,
      bizTypeLabels: options.map((item) => item.name),
      bizTypeIndex: index >= 0 ? index : 0,
      bizTypeLabel: picked ? picked.name : '业务类型'
    });
    return picked;
  },

  onBizTypeChange(e) {
    const index = parseInt(e.detail.value, 10);
    const options = this.data.bizTypeOptions || [];
    if (isNaN(index) || index < 0 || index >= options.length) {
      return;
    }
    wx.setStorageSync(GRADE_BIZ_PREF_KEY, options[index].id);
    this.setData({
      bizTypeIndex: index,
      bizTypeLabel: options[index].name,
      semesters: [],
      totalGp: '-',
      totalCredits: '-',
      showCacheBanner: false,
      cacheNotice: ''
    });
    this.loadGrades(options[index].id);
  },

  loadGrades(forcedBizTypeId) {
    const auth = wx.getStorageSync('auth');
    if (!auth || !auth.token || !auth.secret) {
      wx.reLaunch({
        url: '/pages/login/login'
      });
      return;
    }

    const selectedBiz = forcedBizTypeId
      ? { id: String(forcedBizTypeId), name: this.data.bizTypeLabel }
      : this.prepareBizTypeOptions(auth);
    const bizTypeId = selectedBiz ? selectedBiz.id : '';
    if (!bizTypeId) {
      this.setData({
        loading: false,
        error: '\u672a\u627e\u5230\u53ef\u7528\u7684\u4e1a\u52a1\u7c7b\u578b',
        semesters: [],
        totalGp: '-',
        totalCredits: '-',
        showCacheBanner: false,
        cacheNotice: ''
      });
      return;
    }

    wx.setStorageSync(GRADE_BIZ_PREF_KEY, bizTypeId);

    this.setData({
      loading: true,
      error: '',
      showCacheBanner: false,
      cacheNotice: ''
    });

    const loadId = this._gradesLoadId = (this._gradesLoadId || 0) + 1;
    return loadWithCache({
      key: buildScopedCacheKey('grades', auth, bizTypeId),
      offline: !!auth.offline,
      offlineMessage: '当前离线模式，本机暂无成绩缓存',
      isActive: () => this._gradesLoadId === loadId,
      fetch: () => Promise.all([
        api.getGrades(auth, bizTypeId, 'all'),
        api.getSemesters(auth, bizTypeId).catch(() => ({ semesters: [] }))
      ]).then(([gradesData, semesterData]) => buildGradesPayload(gradesData, semesterData)),
      apply: (payload, meta) => this.applyGradesPayload(payload, meta),
      setNotice: (notice) => this.setData({
        showCacheBanner: !!notice,
        cacheNotice: notice
      }),
      onError: (err) => this.setData({
        loading: false,
        error: err.message || '获取成绩失败',
        semesters: [],
        totalGp: '-',
        totalCredits: '-',
        showCacheBanner: false,
        cacheNotice: ''
      })
    });
  },

  toggleLesson(e) {
    const sIndex = parseInt(e.currentTarget.dataset.sindex, 10);
    const lIndex = parseInt(e.currentTarget.dataset.lindex, 10);
    if (isNaN(sIndex) || isNaN(lIndex)) {
      return;
    }
    const semesters = this.data.semesters.slice();
    const lesson = semesters[sIndex] && semesters[sIndex].lessons
      ? semesters[sIndex].lessons[lIndex]
      : null;
    if (!lesson) {
      return;
    }
    lesson.expanded = !lesson.expanded;
    this.setData({
      semesters
    });
  }
}));
