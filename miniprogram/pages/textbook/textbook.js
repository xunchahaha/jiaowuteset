const api = require('../../utils/api');
const { withPageShare } = require('../../utils/share');
const { extractSemesterList } = require('../../utils/semester');
const { loadLatestSemesterData } = require('../../utils/semester-data');
const { buildScopedCacheKey, writeCache, loadWithCache } = require('../../utils/cache');

const TEXTBOOK_DETAIL_KEY = 'currentTextbookDetail';

function normalizeSemester(item) {
  const id = item.id || item.semester_id || item.semesterId || '';
  let name = item.name || item.semester_name || item.semester_text || item.text || item.semester;
  const year = item.year || item.academic_year || item.school_year;
  const term = item.term || item.term_name || item.termName;

  if (year && (name || term)) {
    const termName = (name === '1' || term === '1') ? '\u7b2c\u4e00\u5b66\u671f'
      : (name === '2' || term === '2') ? '\u7b2c\u4e8c\u5b66\u671f'
        : (term || name);
    name = `${year}\u5b66\u5e74 ${termName}`;
  }

  let label = name || (year && term ? year + ' ' + term : '') || (year || '');
  if (!label && id) {
    label = '\u5b66\u671f ' + id;
  }

  return {
    id: String(id),
    label,
    current: !!(item.current || item.is_current || item.isCurrent || item.is_current_semester)
  };
}

function pickFirstValue(source, keys) {
  if (!source || typeof source !== 'object') {
    return '';
  }
  for (let index = 0; index < keys.length; index += 1) {
    const value = source[keys[index]];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return '';
}

function normalizeTextbookItem(item) {
  return {
    id: String(pickFirstValue(item, ['id', 'book_id', 'bookId', 'textbook_id', 'textbookId', 'isbn', 'code']) || ''),
    name: pickFirstValue(item, ['name', 'book_name', 'bookName', 'textbook_name', 'textbookName']) || '\u672a\u547d\u540d\u6559\u6750',
    courseName: pickFirstValue(item, ['course_name', 'courseName', 'lesson_name', 'lessonName']),
    author: pickFirstValue(item, ['author', 'author_name', 'authorName']),
    press: pickFirstValue(item, ['press', 'press_name', 'pressName', 'publisher', 'publisher_name']),
    isbn: pickFirstValue(item, ['isbn', 'book_no', 'bookNo', 'code']),
    raw: item
  };
}

function extractTextbookList(res) {
  if (Array.isArray(res)) {
    return res;
  }
  if (res && res.data && Array.isArray(res.data)) {
    return res.data;
  }
  if (res && Array.isArray(res.list)) {
    return res.list;
  }
  return [];
}

Page(withPageShare({
  data: {
    textbooks: [],
    loading: false,
    error: '',
    semesters: [],
    semesterIndex: 0,
    showSemesterMenu: false,
    showCacheBanner: false,
    cacheNotice: ''
  },

  onLoad() {
    this.loadSemestersAndTextbooks();
  },

  applyTextbookPayload(payload, meta) {
    const source = payload || {};
    const notice = meta && meta.notice ? meta.notice : '';
    this.setData({
      textbooks: source.textbooks || [],
      semesters: source.semesters || [],
      semesterIndex: source.semesterIndex || 0,
      loading: false,
      error: '',
      showCacheBanner: !!notice,
      cacheNotice: notice
    });
  },

  setCacheNotice(notice) {
    this.setData({
      showCacheBanner: !!notice,
      cacheNotice: notice
    });
  },

  showLoadError(err) {
    this.setData({
      loading: false,
      error: err.message || '获取教材失败',
      showCacheBanner: false,
      cacheNotice: ''
    });
  },

  // 首次进入：学期列表 + 默认学期的教材；每个学期的教材另外单独缓存，离线切换学期也能看。
  getOverviewCacheKey(auth) {
    return buildScopedCacheKey('textbook-overview', auth);
  },

  getSemesterCacheKey(auth, semesterId) {
    return buildScopedCacheKey('textbook-semester', auth, semesterId);
  },

  onRetry() {
    if (this.data.semesters.length) {
      this.loadTextbooksByIndex(this.data.semesterIndex);
      return;
    }
    this.loadSemestersAndTextbooks();
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
    const index = parseInt(e.currentTarget.dataset.index, 10);
    const semesters = this.data.semesters;
    if (isNaN(index) || index < 0 || index >= semesters.length) {
      return;
    }
    this.setData({
      semesterIndex: index,
      showSemesterMenu: false
    });
    this.loadTextbooksByIndex(index);
  },

  onOpenTextbookDetail(e) {
    const index = parseInt(e.currentTarget.dataset.index, 10);
    const textbook = this.data.textbooks[index];
    if (!textbook) {
      return;
    }
    wx.setStorageSync(TEXTBOOK_DETAIL_KEY, textbook.raw || textbook);
    wx.navigateTo({
      url: '/pages/textbook-detail/textbook-detail?bookId='
        + encodeURIComponent(textbook.id || '')
        + '&name=' + encodeURIComponent(textbook.name || '')
    });
  },

  loadSemestersAndTextbooks() {
    const auth = wx.getStorageSync('auth');
    if (!auth || !auth.token || !auth.secret) {
      wx.reLaunch({
        url: '/pages/login/login'
      });
      return;
    }

    const bizTypeId = auth.bizTypes && auth.bizTypes[0] ? auth.bizTypes[0].id : '';
    if (!bizTypeId) {
      this.setData({
        loading: false,
        error: '请先选择业务类型',
        showCacheBanner: false,
        cacheNotice: ''
      });
      return;
    }

    this.setData({
      loading: true,
      error: '',
      showCacheBanner: false,
      cacheNotice: ''
    });

    const loadId = this._textbookLoadId = (this._textbookLoadId || 0) + 1;
    const isActive = () => this._textbookLoadId === loadId;

    return loadWithCache({
      key: this.getOverviewCacheKey(auth),
      offline: !!auth.offline,
      offlineMessage: '当前离线模式，本机暂无教材缓存',
      isActive,
      fetch: () => api.getTextbookSemesters(auth, bizTypeId).then((res) => {
        const semesters = extractSemesterList(res).map(normalizeSemester).filter((item) => item.id);
        if (!semesters.length) {
          throw new Error('未获取到学期信息');
        }
        return loadLatestSemesterData(semesters, (semester) => {
          return api.getTextbooks(auth, bizTypeId, semester.id).then(extractTextbookList);
        }, isActive).then((selected) => {
          if (!selected) return undefined;
          const textbooks = selected.items.map(normalizeTextbookItem);
          writeCache(this.getSemesterCacheKey(auth, semesters[selected.semesterIndex].id), { textbooks });
          return {
            semesters,
            semesterIndex: selected.semesterIndex,
            textbooks
          };
        });
      }),
      apply: (payload, meta) => this.applyTextbookPayload(payload, meta),
      setNotice: (notice) => this.setCacheNotice(notice),
      onError: (err) => this.showLoadError(err)
    });
  },

  loadTextbooksByIndex(index) {
    const auth = wx.getStorageSync('auth');
    if (!auth || !auth.token || !auth.secret) {
      wx.reLaunch({
        url: '/pages/login/login'
      });
      return;
    }

    const semesters = this.data.semesters || [];
    const semester = semesters[index];
    const bizTypeId = auth.bizTypes && auth.bizTypes[0] ? auth.bizTypes[0].id : '';
    if (!semester || !semester.id || !bizTypeId) {
      return;
    }

    this.setData({
      loading: true,
      error: '',
      showCacheBanner: false,
      cacheNotice: ''
    });

    const loadId = this._textbookLoadId = (this._textbookLoadId || 0) + 1;
    return loadWithCache({
      key: this.getSemesterCacheKey(auth, semester.id),
      offline: !!auth.offline,
      offlineMessage: '离线模式，这个学期的教材还没有缓存过',
      isActive: () => this._textbookLoadId === loadId,
      fetch: () => api.getTextbooks(auth, bizTypeId, semester.id)
        .then((res) => ({ textbooks: extractTextbookList(res).map(normalizeTextbookItem) })),
      apply: (payload, meta) => this.applyTextbookPayload({
        semesters,
        semesterIndex: index,
        textbooks: payload.textbooks
      }, meta),
      setNotice: (notice) => this.setCacheNotice(notice),
      onError: (err) => this.showLoadError(err)
    });
  }
}));
