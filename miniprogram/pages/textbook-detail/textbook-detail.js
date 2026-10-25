const api = require('../../utils/api');
const { withPageShare } = require('../../utils/share');
const { buildScopedCacheKey, loadWithCache } = require('../../utils/cache');

const TEXTBOOK_DETAIL_KEY = 'currentTextbookDetail';
const DEFAULT_SECTION_TITLE = '教材基本信息';
const TITLE_NAME_MAP = {
  '教材名称': 'name',
  '是否自编': 'isSelfCompiled',
  '作者': 'author',
  'ISBN/编号': 'isbn',
  '出版社': 'publisher',
  '出版年月': 'publishedDate',
  '版本次': 'version',
  '教材类型': 'textbookType',
  '获奖等级': 'awardLevel',
  '教材说明': 'description',
  '备注': 'remark'
};

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

function normalizeLabel(value) {
  return String(value || '').replace(/[：:]\s*$/, '').trim();
}

function normalizeValue(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

function normalizeBooleanText(value) {
  if (value === true || value === 'true' || value === 1 || value === '1' || value === 'Y' || value === 'y' || value === '是') {
    return '是';
  }
  if (value === false || value === 'false' || value === 0 || value === '0' || value === 'N' || value === 'n' || value === '否') {
    return '否';
  }
  return normalizeValue(value);
}

function normalizePublishedDate(value) {
  const text = normalizeValue(value);
  if (!text) {
    return '';
  }
  const match = text.match(/^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?/);
  if (!match) {
    return text;
  }
  return match[1] + '年' + parseInt(match[2], 10) + '月';
}

function normalizeTextbookDetail(source, fallbackName) {
  const name = pickFirstValue(source, ['name', 'book_name', 'bookName', 'textbook_name', 'textbookName']) || fallbackName || '';
  return {
    id: String(pickFirstValue(source, ['id', 'book_id', 'bookId', 'textbook_id', 'textbookId']) || ''),
    name,
    courseName: pickFirstValue(source, ['course_name', 'courseName', 'lesson_name', 'lessonName']),
    isSelfCompiled: normalizeBooleanText(pickFirstValue(source, ['is_self_compile', 'isSelfCompile', 'is_self_compiled', 'isSelfCompiled', 'self_compile', 'selfCompiled', 'is_compile', 'isCompile'])),
    author: pickFirstValue(source, ['author', 'author_name', 'authorName']),
    isbn: pickFirstValue(source, ['isbn', 'book_no', 'bookNo', 'code', 'book_code', 'bookCode']),
    publisher: pickFirstValue(source, ['press_name', 'pressName', 'press', 'publisher', 'publisher_name', 'publisherName']),
    publishedDate: normalizePublishedDate(pickFirstValue(source, ['published_date', 'publishedDate', 'publish_date', 'publishDate'])),
    version: pickFirstValue(source, ['version', 'version_name', 'versionName', 'edition', 'edition_name', 'editionName']),
    textbookType: pickFirstValue(source, ['book_type_name', 'bookTypeName', 'book_type', 'bookType', 'textbook_type', 'textbookType']),
    awardLevel: pickFirstValue(source, ['award_level', 'awardLevel', 'prize_level', 'prizeLevel', 'honor_level', 'honorLevel']),
    description: pickFirstValue(source, ['description', 'book_description', 'bookDescription', 'textbook_description', 'textbookDescription', 'introduction']),
    remark: pickFirstValue(source, ['remark', 'remarks', 'memo', 'note'])
  };
}

function buildDefaultRows(detail) {
  return [
    { label: '教材名称', value: detail.name || '' },
    { label: '是否自编', value: detail.isSelfCompiled || '' },
    { label: '作者', value: detail.author || '' },
    { label: 'ISBN/编号', value: detail.isbn || '' },
    { label: '出版社', value: detail.publisher || '' },
    { label: '出版年月', value: detail.publishedDate || '' },
    { label: '版本次', value: detail.version || '' },
    { label: '教材类型', value: detail.textbookType || '' },
    { label: '获奖等级', value: detail.awardLevel || '' },
    { label: '教材说明', value: detail.description || '' },
    { label: '备注', value: detail.remark || '' }
  ];
}

function parseStructuredDetail(source, fallbackName) {
  const sections = Array.isArray(source)
    ? source
    : (source && Array.isArray(source.data) ? source.data : []);
  const targetSection = sections.find((item) => item && Array.isArray(item.content));
  if (!targetSection) {
    return null;
  }

  const detail = normalizeTextbookDetail({}, fallbackName);
  const rows = targetSection.content.map((item) => {
    const label = normalizeLabel(item && item.title);
    let value = normalizeValue(item && item.content);
    if (label === '是否自编') {
      value = normalizeBooleanText(value);
    }
    if (label === '出版年月') {
      value = normalizePublishedDate(value);
    }
    const detailKey = TITLE_NAME_MAP[label];
    if (detailKey) {
      detail[detailKey] = value;
    }
    return {
      label,
      value,
      type: item && item.type ? item.type : 'text'
    };
  }).filter((item) => item.label);

  if (!detail.name) {
    detail.name = fallbackName || '';
  }

  return {
    sectionTitle: normalizeLabel(targetSection.title) || DEFAULT_SECTION_TITLE,
    detail,
    infoRows: rows
  };
}

Page(withPageShare({
  data: {
    loading: false,
    error: '',
    bookId: '',
    sectionTitle: DEFAULT_SECTION_TITLE,
    detail: {},
    infoRows: [],
    showCacheBanner: false,
    cacheNotice: ''
  },

  onLoad(options) {
    const cached = wx.getStorageSync(TEXTBOOK_DETAIL_KEY) || {};
    const fallbackName = decodeOptionValue(options.name);
    const cachedDetail = normalizeTextbookDetail(cached, fallbackName);
    const bookId = options.bookId || cachedDetail.id || '';
    this.setData({
      bookId,
      detail: cachedDetail,
      infoRows: buildDefaultRows(cachedDetail)
    });
    if (bookId) {
      this.loadTextbookDetail(bookId, fallbackName);
    }
  },

  getShareOptions() {
    return {
      bookId: this.data.bookId || '',
      name: this.data.detail && this.data.detail.name ? this.data.detail.name : ''
    };
  },

  getShareConfig() {
    return {
      title: this.data.detail && this.data.detail.name ? this.data.detail.name : '教材详情'
    };
  },

  getTimelineShareConfig() {
    return this.getShareConfig();
  },

  getShareCard() {
    const detail = this.data.detail || {};
    return {
      theme: 'plum',
      eyebrow: '教材详情',
      headline: detail.name || '教材详情',
      sub: detail.courseName || '',
      rows: (this.data.infoRows || [])
        .filter((row) => row && row.value && row.label !== '教材名称')
        .map((row) => ({ label: row.label, text: row.value }))
    };
  },

  onCopyValue(e) {
    const label = e.currentTarget.dataset.label || '';
    const value = e.currentTarget.dataset.value || '';
    if (!value) {
      wx.showToast({
        title: '当前项无可复制内容',
        icon: 'none'
      });
      return;
    }
    wx.setClipboardData({
      data: String(value),
      success: () => {
        wx.showToast({
          title: label ? ('已复制' + label) : '已复制',
          icon: 'success'
        });
      }
    });
  },

  loadTextbookDetail(bookId, fallbackName) {
    const auth = getAuthOrRedirect();
    if (!auth) {
      return;
    }
    this.setData({
      loading: true,
      error: '',
      showCacheBanner: false,
      cacheNotice: ''
    });
    return loadWithCache({
      key: buildScopedCacheKey('textbook-detail', auth, bookId),
      offline: !!auth.offline,
      isActive: () => this.data.bookId === bookId,
      fetch: () => api.getTextbookDetail(auth, bookId).then((res) => {
        const source = res && res.data ? res.data : res;
        const structured = parseStructuredDetail(source, fallbackName);
        if (structured) {
          return structured;
        }
        const detail = normalizeTextbookDetail(source || {}, fallbackName);
        return {
          sectionTitle: DEFAULT_SECTION_TITLE,
          detail,
          infoRows: buildDefaultRows(detail)
        };
      }),
      apply: (payload, meta) => {
        this.setData({
          sectionTitle: payload.sectionTitle,
          detail: payload.detail,
          infoRows: payload.infoRows,
          loading: false,
          error: '',
          showCacheBanner: !!meta.notice,
          cacheNotice: meta.notice
        });
        if (this.refreshShareCard) {
          this.refreshShareCard();
        }
      },
      setNotice: (notice) => this.setData({
        showCacheBanner: !!notice,
        cacheNotice: notice
      }),
      // 没有详情缓存时仍保留列表页带过来的基础信息，只提示一下。
      onError: (err) => this.setData(auth.offline ? {
        loading: false,
        showCacheBanner: true,
        cacheNotice: '离线模式，暂无这本教材的详情缓存，仅显示列表中的基础信息'
      } : {
        loading: false,
        error: err.message || '获取教材详情失败'
      })
    });
  }
}));
