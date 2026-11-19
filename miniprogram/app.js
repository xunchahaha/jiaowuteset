const { getLatestNotice, getPopupNotice, reportVisit } = require('./utils/notices');
const { queueUpdateAnnouncement } = require('./utils/update-notice');
const { migrateLegacyCache } = require('./utils/cache');

const LAST_SEEN_VERSION_STORAGE_KEY = 'lastSeenMiniProgramVersion';
const FORCED_NOTICE_STORAGE_KEY = 'lastForcedNoticeId';
const FALLBACK_VERSION = 'dev-build';

App({
  onLaunch: function () {
    // 第一次打开小程序的设备（从没记过版本号）：看板可以指定只给新用户弹的公告
    this.isNewDevice = !wx.getStorageSync(LAST_SEEN_VERSION_STORAGE_KEY);
    this.setupUpdateManager();
    this.prepareUpdateAnnouncement();
    try {
      migrateLegacyCache();
    } catch (err) {
      console.warn('migrate legacy cache failed', err);
    }
  },

  // 每次打开（含从后台切回，30 分钟内只报一次）上报一次访问，管理看板据此看访问人数和用户状态
  onShow: function () {
    let platform = '';
    try {
      const info = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : wx.getSystemInfoSync();
      platform = (info && info.platform) || '';
    } catch (err) { /* 拿不到就报空 */ }
    let jwLogin = false;
    try {
      const auth = wx.getStorageSync('auth');
      jwLogin = !!(auth && auth.token);
    } catch (err) { /* 同上 */ }
    reportVisit({ version: this.getCurrentVersion(), platform, jwLogin });
  },

  setupUpdateManager: function () {
    if (typeof wx.getUpdateManager !== 'function') {
      return;
    }

    const updateManager = wx.getUpdateManager();
    updateManager.onUpdateReady(function () {
      wx.showModal({
        title: '更新提示',
        content: '新版本已经准备好，是否立即重启？',
        confirmText: '立即重启',
        cancelText: '稍后',
        success: function (res) {
          if (res.confirm) {
            updateManager.applyUpdate();
          }
        }
      });
    });

    updateManager.onUpdateFailed(function () {
      wx.showToast({
        title: '新版本下载失败，请稍后重试',
        icon: 'none'
      });
    });
  },

  getCurrentVersion: function () {
    if (typeof wx.getAccountInfoSync !== 'function') {
      return FALLBACK_VERSION;
    }
    try {
      const accountInfo = wx.getAccountInfoSync();
      const miniProgram = accountInfo && accountInfo.miniProgram ? accountInfo.miniProgram : {};
      return miniProgram.version || FALLBACK_VERSION;
    } catch (err) {
      console.warn('读取小程序版本失败', err);
      return FALLBACK_VERSION;
    }
  },

  // 更新完成后必须看一次最新公告：只在版本变化时登记，同一个版本只登记一次，
  // 由首页展示成功后清除，不会每次进入小程序都出现。
  prepareUpdateAnnouncement: function () {
    const currentVersion = this.getCurrentVersion();
    const lastSeenVersion = wx.getStorageSync(LAST_SEEN_VERSION_STORAGE_KEY);

    const latest = getLatestNotice();
    if (lastSeenVersion && lastSeenVersion !== currentVersion) {
      queueUpdateAnnouncement(wx, currentVersion, latest);
    }

    this.checkForcedNotice();

    wx.setStorageSync(LAST_SEEN_VERSION_STORAGE_KEY, currentVersion);
  },

  // 进入时要弹的公告（看板指定的那条；没指定则是带 forcePopup 的首条）：每台设备看一次，按公告 id 记录。
  // 启动时用缓存的公告查一次；首页 / 登录页拉到新的云端公告和配置后会再调一次。
  checkForcedNotice: function () {
    const popup = getPopupNotice(!!this.isNewDevice);
    if (popup && wx.getStorageSync(FORCED_NOTICE_STORAGE_KEY) !== popup.id) {
      queueUpdateAnnouncement(wx, this.getCurrentVersion(), popup);
      wx.setStorageSync(FORCED_NOTICE_STORAGE_KEY, popup.id);
    }
  },
});
