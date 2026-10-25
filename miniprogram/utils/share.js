const shareCard = require('./share-card');
const study = require('./study');

const APP_SHARE_TITLE = '教务助手';
const PAGE_TITLE_MAP = {
  'pages/login/login': APP_SHARE_TITLE,
  'pages/home/home': APP_SHARE_TITLE,
  'pages/my/my': APP_SHARE_TITLE,
  'pages/classroom/classroom': '空教室',
  'pages/classroom-detail/classroom-detail': '教室课表',
  'pages/lesson-detail/lesson-detail': '课程详情',
  'pages/grades/grades': '成绩',
  'pages/schedule/schedule': '课表',
  'pages/exam/exam': '考试安排',
  'pages/textbook/textbook': '教材',
  'pages/textbook-detail/textbook-detail': '教材详情',
  'subpackages/study/submit/submit': '刷课服务',
  'subpackages/study/confirm/confirm': '确认订单',
  'subpackages/study/orders/orders': '个人中心',
  'subpackages/study/progress/progress': '刷课进度'
};

const APP_CARD = {
  theme: 'blue',
  eyebrow: '校园工具箱',
  headline: '教务助手',
  sub: '课表、成绩、考试，打开就能查',
  chips: ['今日课表', '成绩绩点', '考试安排', '空教室', '教材查询', '上课提醒']
};
// 刷课下单关闭时不再宣传下单，只说已有任务能查进度
const STUDY_CARD = study.ORDER_OPEN ? {
  theme: 'slate',
  eyebrow: '刷课服务',
  headline: '学习通刷课',
  sub: '选课下单，进度随时可查',
  chips: ['自动刷视频', '可选自动答题', '失败不扣次数']
} : {
  theme: 'slate',
  eyebrow: '刷课服务',
  headline: '学习通刷课',
  sub: '暂停接单，已提交的任务进度随时可查'
};
// 页面没有自己的 getShareCard 时用这里的默认卡片
const DEFAULT_CARDS = {
  'pages/login/login': APP_CARD,
  'pages/home/home': APP_CARD,
  'pages/my/my': APP_CARD,
  'pages/classroom/classroom': {
    theme: 'teal',
    eyebrow: '空教室',
    headline: '找间空教室自习',
    sub: '选好日期和节次，空闲教室一目了然',
    chips: ['按节次筛选', '搜索教室', '教室周课表']
  },
  'pages/textbook/textbook': {
    theme: 'plum',
    eyebrow: '教材',
    headline: '本学期教材',
    sub: '每门课用哪本书，一查便知',
    chips: ['教材名称', '作者出版社', 'ISBN']
  },
  'pages/admission-query/admission-query': {
    theme: 'plum',
    eyebrow: '录取查询',
    headline: '录取结果查询',
    sub: '输入姓名和考生号即可查询'
  },
  'subpackages/notifications/center/center': {
    theme: 'blue',
    eyebrow: '上课提醒',
    headline: '上课前提醒我',
    sub: '设置提前时间，微信服务通知准时送达',
    chips: ['自动读取课表', '自定义提前量', '不错过每节课']
  },
  'subpackages/announcements/list/list': {
    theme: 'blue',
    eyebrow: '公告中心',
    headline: '教务助手公告',
    sub: '新功能与重要通知都在这里'
  },
  'subpackages/study/submit/submit': STUDY_CARD,
  'subpackages/study/confirm/confirm': STUDY_CARD,
  'subpackages/study/orders/orders': STUDY_CARD
};

const BLOCKED_QUERY_KEYS = {
  token: true,
  secret: true,
  password: true
};
const SHARE_PROMISE_TIMEOUT = 2500;   // 微信最多等 3 秒，超时就用不带封面的默认分享
const PREWARM_DELAY = 1200;

function normalizeRoute(route) {
  if (!route) {
    return '';
  }
  return String(route).replace(/^\//, '');
}

function buildSharePath(route, options) {
  const normalizedRoute = normalizeRoute(route);
  const query = buildQueryString(sanitizeOptions(options));
  return '/' + normalizedRoute + (query ? ('?' + query) : '');
}

function sanitizeOptions(options) {
  const source = options && typeof options === 'object' ? options : {};
  const result = {};
  Object.keys(source).forEach((key) => {
    if (BLOCKED_QUERY_KEYS[key]) {
      return;
    }
    const value = source[key];
    if (value === undefined || value === null || value === '') {
      return;
    }
    if (typeof value === 'object' || typeof value === 'function') {
      return;
    }
    result[key] = String(value);
  });
  return result;
}

function buildQueryString(query) {
  return Object.keys(query).map((key) => {
    return encodeURIComponent(key) + '=' + encodeURIComponent(query[key]);
  }).join('&');
}

function splitPath(path) {
  const normalizedPath = path && path.charAt(0) === '/' ? path : '/' + (path || '');
  const index = normalizedPath.indexOf('?');
  if (index < 0) {
    return {
      path: normalizedPath,
      query: ''
    };
  }
  return {
    path: normalizedPath.slice(0, index),
    query: normalizedPath.slice(index + 1)
  };
}

// 只取与页面内容相关的字段；姓名等个人信息不进分享标题
function pickDynamicTitle(page) {
  const data = page && page.data ? page.data : {};
  const dynamicTitle = data.shareTitle || data.roomName || data.courseName;
  if (dynamicTitle) {
    return APP_SHARE_TITLE + ' - ' + dynamicTitle;
  }
  return '';
}

function pageRoute(page) {
  return normalizeRoute((page && page.route) || (page && page.__shareRoute) || 'pages/home/home');
}

function normalizeShareConfig(page, shareConfig) {
  const route = pageRoute(page);
  const config = shareConfig && typeof shareConfig === 'object' ? shareConfig : {};
  const title = config.title || pickDynamicTitle(page) || PAGE_TITLE_MAP[route] || APP_SHARE_TITLE;
  const path = config.path || buildSharePath(route, resolveShareOptions(page));
  return {
    title,
    path,
    imageUrl: config.imageUrl || ''
  };
}

function resolveShareOptions(page) {
  if (page && typeof page.getShareOptions === 'function') {
    return page.getShareOptions() || {};
  }
  return (page && (page.__shareOptions || page.options)) || {};
}

function resolveShareCard(page) {
  let card = null;
  if (page && typeof page.getShareCard === 'function') {
    try {
      card = page.getShareCard();
    } catch (err) {
      card = null;
    }
  }
  return card || DEFAULT_CARDS[pageRoute(page)] || {
    theme: 'blue',
    eyebrow: PAGE_TITLE_MAP[pageRoute(page)] || '',
    headline: APP_SHARE_TITLE,
    sub: '课表、成绩、考试，打开就能查'
  };
}

function ensureShareMenu() {
  if (typeof wx === 'undefined' || typeof wx.showShareMenu !== 'function') {
    return;
  }
  wx.showShareMenu({
    menus: ['shareAppMessage', 'shareTimeline'],
    fail() {
      wx.showShareMenu();
    }
  });
}

function resolveShareConfig(page, methodName, arg) {
  if (!page || typeof page[methodName] !== 'function') {
    return null;
  }
  return page[methodName](arg);
}

function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

// 会话分享：封面已缓存就直接带上；没缓存交给 promise 现画，超时退回默认截图
function buildAppMessagePayload(page, shareConfig) {
  const normalized = normalizeShareConfig(page, shareConfig);
  const payload = {
    title: normalized.title,
    path: normalized.path
  };
  if (normalized.imageUrl) {
    payload.imageUrl = normalized.imageUrl;
    return payload;
  }
  const card = resolveShareCard(page);
  const cached = shareCard.getCachedShareImage('message', card);
  if (cached) {
    payload.imageUrl = cached;
    return payload;
  }
  const base = { title: payload.title, path: payload.path };
  payload.promise = withTimeout(
    shareCard.renderShareImage('message', card).then((imageUrl) => (
      imageUrl ? Object.assign({}, base, { imageUrl }) : base
    )),
    SHARE_PROMISE_TIMEOUT,
    base
  );
  return payload;
}

// 朋友圈分享不支持异步，只能用预先画好的图
function buildTimelinePayload(page, shareConfig) {
  const normalized = normalizeShareConfig(page, shareConfig);
  const pathParts = splitPath(normalized.path);
  const payload = {
    title: normalized.title,
    query: pathParts.query
  };
  const imageUrl = normalized.imageUrl || shareCard.getCachedShareImage('timeline', resolveShareCard(page));
  if (imageUrl) {
    payload.imageUrl = imageUrl;
  }
  return payload;
}

function prewarmShareCard(page) {
  if (!page || page.__shareCardDisposed) {
    return;
  }
  const card = resolveShareCard(page);
  shareCard.renderShareImage('message', card)
    .then(() => shareCard.renderShareImage('timeline', card));
}

function scheduleShareCard(page, delay) {
  clearTimeout(page.__shareCardTimer);
  page.__shareCardTimer = setTimeout(() => prewarmShareCard(page), delay);
}

function withPageShare(pageConfig) {
  const config = pageConfig || {};
  const originalOnLoad = config.onLoad;
  const originalOnShow = config.onShow;
  const originalOnHide = config.onHide;
  const originalOnUnload = config.onUnload;
  const originalOnShareAppMessage = config.onShareAppMessage;
  const originalOnShareTimeline = config.onShareTimeline;

  config.onLoad = function onLoad(options) {
    this.__shareRoute = normalizeRoute(this.route || '');
    this.__shareOptions = sanitizeOptions(options);
    this.__shareCardDisposed = false;
    ensureShareMenu();
    if (typeof originalOnLoad === 'function') {
      return originalOnLoad.call(this, options || {});
    }
  };

  config.onShow = function onShow() {
    this.__shareRoute = normalizeRoute(this.route || this.__shareRoute || '');
    this.__shareCardDisposed = false;
    ensureShareMenu();
    scheduleShareCard(this, PREWARM_DELAY);
    if (typeof originalOnShow === 'function') {
      return originalOnShow.call(this);
    }
  };

  config.onHide = function onHide() {
    clearTimeout(this.__shareCardTimer);
    if (typeof originalOnHide === 'function') {
      return originalOnHide.call(this);
    }
  };

  config.onUnload = function onUnload() {
    clearTimeout(this.__shareCardTimer);
    this.__shareCardDisposed = true;
    if (typeof originalOnUnload === 'function') {
      return originalOnUnload.call(this);
    }
  };

  // 页面数据就绪后调用，提前画好封面（朋友圈分享只能用现成的图）
  config.refreshShareCard = function refreshShareCard() {
    scheduleShareCard(this, 300);
  };

  config.onShareAppMessage = function onShareAppMessage(options) {
    if (typeof originalOnShareAppMessage === 'function') {
      return originalOnShareAppMessage.call(this, options);
    }
    return buildAppMessagePayload(this, resolveShareConfig(this, 'getShareConfig', options));
  };

  config.onShareTimeline = function onShareTimeline() {
    if (typeof originalOnShareTimeline === 'function') {
      return originalOnShareTimeline.call(this);
    }
    return buildTimelinePayload(this, resolveShareConfig(this, 'getTimelineShareConfig'));
  };

  return config;
}

module.exports = {
  DEFAULT_CARDS,
  buildSharePath,
  withPageShare
};
