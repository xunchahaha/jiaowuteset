const { getLatestNotice } = require('./utils/notices');
const { queueUpdateAnnouncement } = require('./utils/update-notice');
const { migrateLegacyCache } = require('./utils/cache');

const LAST_SEEN_VERSION_STORAGE_KEY = 'lastSeenMiniProgramVersion';
const FORCED_NOTICE_STORAGE_KEY = 'lastForcedNoticeId';
const FALLBACK_VERSION = 'dev-build';

App({
  onLaunch: function () {
    this.setupUpdateManager();
    this.prepareUpdateAnnouncement();
    try {
      migrateLegacyCache();
    } catch (err) {
      console.warn('migrate legacy cache failed', err);
    }
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

  // 首条公告标了 forcePopup：每台设备强制看一次（含新安装），按公告 id 记录。
  // 启动时用缓存的公告查一次；首页拉到新的云端公告后会再调一次。
  checkForcedNotice: function () {
    const latest = getLatestNotice();
    if (latest && latest.forcePopup && wx.getStorageSync(FORCED_NOTICE_STORAGE_KEY) !== latest.id) {
      queueUpdateAnnouncement(wx, this.getCurrentVersion(), latest);
      wx.setStorageSync(FORCED_NOTICE_STORAGE_KEY, latest.id);
    }
  },
});
