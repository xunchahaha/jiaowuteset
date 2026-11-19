// 离线缓存：每次成功拿到教务数据都按"内容粒度"落盘（课表按周、教材/考试按学期……），
// 教务关机时任何打开过的页面都能直接读到。页面统一走 loadWithCache：
// 有缓存先秒开，后台刷新，数据有变动才替换页面并覆盖缓存。
const CACHE_PREFIX = 'page-cache';
const INDEX_KEY = 'page-cache-index';
const MAX_ENTRIES = 200;
const REFRESH_NOTICE_DELAY = 1200;

function getUserCode(auth) {
  if (!auth || !auth.userInfo) {
    return 'anonymous';
  }
  return auth.userInfo.user_code || auth.userInfo.userCode || 'anonymous';
}

function getBizTypeId(auth) {
  return auth && auth.bizTypes && auth.bizTypes[0] ? auth.bizTypes[0].id || '' : '';
}

function buildScopedCacheKey(namespace, auth, extra) {
  const parts = [
    CACHE_PREFIX,
    namespace || 'default',
    getUserCode(auth),
    getBizTypeId(auth)
  ];
  if (extra !== undefined && extra !== null && extra !== '') {
    parts.push(String(extra));
  }
  return parts.join(':');
}

function readIndex() {
  let index;
  try {
    index = wx.getStorageSync(INDEX_KEY);
  } catch (err) {
    return {};
  }
  return index && typeof index === 'object' && !Array.isArray(index) ? index : {};
}

function saveIndex(index) {
  try {
    wx.setStorageSync(INDEX_KEY, index);
  } catch (err) {
    console.warn('save cache index failed', err);
  }
}

// 按写入时间淘汰最旧的条目，只保留 keep 条。
function pruneIndex(index, keep) {
  const keys = Object.keys(index).sort((a, b) => index[a] - index[b]);
  while (keys.length > keep) {
    const key = keys.shift();
    delete index[key];
    try {
      wx.removeStorageSync(key);
    } catch (err) {
      // 删除失败不影响后续写入
    }
  }
}

function readCache(key) {
  let value;
  try {
    value = wx.getStorageSync(key);
  } catch (err) {
    return null;
  }
  if (!value || typeof value !== 'object' || value.payload === undefined || value.payload === null) {
    return null;
  }
  return value;
}

function writeCache(key, payload) {
  const entry = {
    updatedAt: Date.now(),
    payload
  };
  const index = readIndex();
  index[key] = entry.updatedAt;
  pruneIndex(index, MAX_ENTRIES);
  try {
    wx.setStorageSync(key, entry);
  } catch (err) {
    // 存储空间满：丢掉最旧的四分之一再试一次。
    pruneIndex(index, Math.floor(Object.keys(index).length * 0.75));
    index[key] = entry.updatedAt;
    try {
      wx.setStorageSync(key, entry);
    } catch (retryErr) {
      console.warn('write cache failed', key, retryErr);
      delete index[key];
      saveIndex(index);
      return false;
    }
  }
  saveIndex(index);
  return true;
}

function isSamePayload(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (err) {
    return false;
  }
}

function pad(value) {
  return value < 10 ? '0' + value : String(value);
}

function formatCacheTime(timestamp) {
  if (!timestamp) {
    return '';
  }
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) {
    return '';
  }
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

// state: offline（离线模式） / refreshing（正在后台刷新） / failed（刷新失败）
function buildCacheNotice(timestamp, state) {
  const formatted = formatCacheTime(timestamp);
  const time = formatted ? ' · 更新于 ' + formatted : '';
  if (state === 'refreshing') {
    return '当前显示缓存数据' + time + '，正在刷新…';
  }
  if (state === 'failed') {
    return '教务系统暂时连不上，当前显示缓存数据' + time;
  }
  return '离线模式，当前显示缓存数据' + time;
}

/**
 * 通用的"缓存优先 + 后台刷新"加载流程。
 * - key: 缓存 key；writeKey(payload) 可按实际结果改写落盘 key（如课表按真实周次）
 * - offline: 离线模式只读缓存，不发请求
 * - fetch(): 返回新 payload 的 Promise，返回 undefined 表示放弃本次结果
 * - apply(payload, meta): 渲染数据，meta = { fromCache, updatedAt, notice }
 * - setNotice(notice): 只更新缓存提示条（notice 为空表示隐藏）
 * - onError(err): 没有任何缓存可显示时的失败处理
 * - isActive(): 页面已切换到别的请求时返回 false，丢弃过期结果
 */
function loadWithCache(options) {
  const isActive = options.isActive || (() => true);
  const cached = readCache(options.key);
  const updatedAt = cached ? cached.updatedAt : 0;

  if (cached) {
    options.apply(cached.payload, {
      fromCache: true,
      updatedAt,
      notice: options.offline ? buildCacheNotice(updatedAt, 'offline') : ''
    });
  }

  if (options.offline) {
    if (!cached) {
      options.onError(new Error(options.offlineMessage || '当前离线模式，本机暂无缓存'));
    }
    return Promise.resolve();
  }

  const timer = cached
    ? setTimeout(() => {
      if (isActive()) {
        options.setNotice(buildCacheNotice(updatedAt, 'refreshing'));
      }
    }, REFRESH_NOTICE_DELAY)
    : null;

  return Promise.resolve()
    .then(options.fetch)
    .then((payload) => {
      clearTimeout(timer);
      if (!isActive() || payload === undefined) {
        return;
      }
      writeCache(options.writeKey ? options.writeKey(payload) : options.key, payload);
      if (cached && isSamePayload(cached.payload, payload)) {
        options.setNotice('');
        return;
      }
      options.apply(payload, {
        fromCache: false,
        updatedAt: Date.now(),
        notice: ''
      });
    })
    .catch((err) => {
      clearTimeout(timer);
      if (!isActive()) {
        return;
      }
      if (cached) {
        options.setNotice(buildCacheNotice(updatedAt, 'failed'));
        return;
      }
      options.onError(err);
    });
}

// 旧版本的课表缓存按"打开那天的日期"存、教材缓存所有学期共用一条，
// 这里迁移成按周 / 按学期的新格式，并把其余旧条目登记进索引参与淘汰。
function migrateLegacyCache() {
  let keys;
  try {
    keys = wx.getStorageInfoSync().keys || [];
  } catch (err) {
    return;
  }
  const index = readIndex();
  let changed = false;

  keys.forEach((key) => {
    if (key.indexOf(CACHE_PREFIX + ':') !== 0 || index[key]) {
      return;
    }
    try {
      const entry = readCache(key);
      const parts = key.split(':');
      const namespace = parts[1];
      if (entry && namespace === 'schedule') {
        const weekDays = entry.payload.weekDays || [];
        if (weekDays[0] && weekDays[0].date) {
          const nextKey = [CACHE_PREFIX, 'schedule-week', parts[2], parts[3], weekDays[0].date].join(':');
          if (!readCache(nextKey) || readCache(nextKey).updatedAt < entry.updatedAt) {
            wx.setStorageSync(nextKey, entry);
            index[nextKey] = entry.updatedAt;
          }
        }
        wx.removeStorageSync(key);
      } else if (entry && namespace === 'textbooks') {
        const payload = entry.payload;
        const semester = (payload.semesters || [])[payload.semesterIndex || 0];
        const scope = [parts[2], parts[3]];
        const overviewKey = [CACHE_PREFIX, 'textbook-overview'].concat(scope).join(':');
        if (!readCache(overviewKey)) {
          wx.setStorageSync(overviewKey, entry);
          index[overviewKey] = entry.updatedAt;
        }
        if (semester && semester.id) {
          const semesterKey = [CACHE_PREFIX, 'textbook-semester'].concat(scope, [semester.id]).join(':');
          if (!readCache(semesterKey)) {
            wx.setStorageSync(semesterKey, { updatedAt: entry.updatedAt, payload: { textbooks: payload.textbooks || [] } });
            index[semesterKey] = entry.updatedAt;
          }
        }
        wx.removeStorageSync(key);
      } else if (entry) {
        index[key] = entry.updatedAt || Date.now();
      } else {
        wx.removeStorageSync(key);
      }
      changed = true;
    } catch (err) {
      console.warn('migrate cache failed', key, err);
    }
  });

  if (changed) {
    pruneIndex(index, MAX_ENTRIES);
    saveIndex(index);
  }
}

module.exports = {
  buildScopedCacheKey,
  readCache,
  writeCache,
  isSamePayload,
  buildCacheNotice,
  loadWithCache,
  migrateLegacyCache
};
