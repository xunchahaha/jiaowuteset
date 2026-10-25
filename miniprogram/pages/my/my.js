const api = require('../../utils/api');
const { withPageShare } = require('../../utils/share');
const { buildScopedCacheKey, loadWithCache } = require('../../utils/cache');

function getBizTypeId(auth) {
  if (!auth || !Array.isArray(auth.bizTypes) || !auth.bizTypes.length) {
    return '';
  }
  return auth.bizTypes[0].id || '';
}

function normalizeField(field) {
  return {
    title: field && field.title ? field.title : '',
    content: field && field.content ? field.content : '',
    type: field && field.type ? field.type : 'text'
  };
}

function normalizeSection(section) {
  const content = Array.isArray(section && section.content) ? section.content : [];
  const type = section && section.type ? section.type : 'list';
  const fields = content.map(normalizeField);
  const rows = [];

  if (type === 'two-list') {
    for (let index = 0; index < fields.length; index += 2) {
      rows.push(fields.slice(index, index + 2));
    }
  }

  return {
    title: section && section.title ? section.title : '',
    type,
    fields,
    rows
  };
}

function extractSections(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && Array.isArray(data.data)) {
    return data.data;
  }
  if (data && Array.isArray(data.list)) {
    return data.list;
  }
  return [];
}

function buildProfilePayload(sections, auth) {
  const userInfo = auth && auth.userInfo ? auth.userInfo : {};
  return {
    sections,
    profileName: userInfo.user_name || userInfo.userName || '',
    profileCode: userInfo.user_code || userInfo.userCode || '',
    profileDepart: userInfo.depart_name || userInfo.departName || ''
  };
}

Page(withPageShare({
  data: {
    loading: true,
    error: '',
    sections: [],
    profileName: '',
    profileCode: '',
    profileDepart: '',
    showCacheBanner: false,
    cacheNotice: ''
  },

  onLoad() {
    this.loadUserDetail();
  },

  onPullDownRefresh() {
    this.loadUserDetail(true);
  },

  applyProfilePayload(payload, meta) {
    const source = payload || {};
    const notice = meta && meta.notice ? meta.notice : '';
    this.setData({
      loading: false,
      error: '',
      sections: source.sections || [],
      profileName: source.profileName || '',
      profileCode: source.profileCode || '',
      profileDepart: source.profileDepart || '',
      showCacheBanner: !!notice,
      cacheNotice: notice
    });
  },

  loadUserDetail(fromPullDown) {
    const auth = wx.getStorageSync('auth');
    if (!auth || !auth.token || !auth.secret) {
      wx.reLaunch({
        url: '/pages/login/login'
      });
      return;
    }

    const bizTypeId = getBizTypeId(auth);
    if (!bizTypeId) {
      this.setData({
        loading: false,
        error: '\u672a\u627e\u5230\u4e1a\u52a1\u7c7b\u578b\u4fe1\u606f',
        showCacheBanner: false,
        cacheNotice: ''
      });
      if (fromPullDown) {
        wx.stopPullDownRefresh();
      }
      return;
    }

    this.setData({
      loading: true,
      error: '',
      showCacheBanner: false,
      cacheNotice: ''
    });

    const loadId = this._profileLoadId = (this._profileLoadId || 0) + 1;
    return loadWithCache({
      key: buildScopedCacheKey('profile', auth),
      offline: !!auth.offline,
      offlineMessage: '当前离线模式，本机暂无个人信息缓存',
      isActive: () => this._profileLoadId === loadId,
      fetch: () => api.getUserDetail(auth, bizTypeId)
        .then((res) => buildProfilePayload(extractSections(res).map(normalizeSection), auth)),
      apply: (payload, meta) => this.applyProfilePayload(payload, meta),
      setNotice: (notice) => this.setData({
        showCacheBanner: !!notice,
        cacheNotice: notice
      }),
      onError: (err) => this.setData({
        loading: false,
        error: err.message || '获取个人信息失败',
        showCacheBanner: false,
        cacheNotice: ''
      })
    }).then(() => {
      if (fromPullDown) {
        wx.stopPullDownRefresh();
      }
    });
  }
}));
