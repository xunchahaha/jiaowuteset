const api = require('../../utils/api');
const { withPageShare } = require('../../utils/share');
const { warmEssentialCaches } = require('../../utils/warm-cache');
const { getLatestNotice, getNotice, refreshNotices } = require('../../utils/notices');
const { peekPendingAnnouncement, clearPendingAnnouncement } = require('../../utils/update-notice');
const payment = require('../../utils/payment');
const study = require('../../utils/study');

Page(withPageShare({
  data: {
    displayName: '',
    offlineMode: false,
    notice: getLatestNotice(),
    studyCredits: 0,
    studyLocked: !study.ORDER_OPEN
  },
  getHomeShareConfig() {
    return {
      title: '教务助手'
    };
  },
  getShareConfig() {
    return this.getHomeShareConfig();
  },
  getTimelineShareConfig() {
    return this.getHomeShareConfig();
  },

  onShow() {
    const auth = wx.getStorageSync('auth');
    if (!auth || !auth.token) {
      wx.reLaunch({
        url: '/pages/login/login'
      });
      return;
    }

    const userInfo = auth.userInfo || {};
    this.setData({
      displayName: userInfo.user_name || userInfo.userName || '',
      offlineMode: !!auth.offline
    });
    this.refreshStudyCredits();
    this.setData({ notice: getLatestNotice() });
    this.openUpdateAnnouncement();
    this.refreshCloudNotices();
  },
  // 云端公告有变化：换横幅；新的首条要强制弹出的话现在就弹
  refreshCloudNotices() {
    refreshNotices().then(changed => {
      if (!changed) return;
      this.setData({ notice: getLatestNotice() });
      const app = typeof getApp === 'function' ? getApp() : null;
      if (app && typeof app.checkForcedNotice === 'function') app.checkForcedNotice();
      this.openUpdateAnnouncement();
    });
  },
  // 刷课剩余次数：云函数未部署或离线时静默失败，不影响首页
  refreshStudyCredits() {
    if (!payment || typeof payment.balance !== 'function') return;
    payment.balance()
      .then(b => { if (b) this.setData({ studyCredits: b.balance || 0 }); })
      .catch(() => {});
  },
  // 更新完成后只强制看一次公告：跳转成功才清除，失败则下次进入首页再试。
  openUpdateAnnouncement() {
    const pendingNoticeId = peekPendingAnnouncement(wx);
    if (!pendingNoticeId || this._openingNotice) {
      return;
    }

    const notice = getNotice(pendingNoticeId) || getLatestNotice();
    if (!notice) {
      clearPendingAnnouncement(wx);
      return;
    }

    // 启动时和云端公告拉回来后都会走到这里，跳转进行中不重复跳
    this._openingNotice = true;
    wx.navigateTo({
      url: '/subpackages/announcements/detail/detail?id=' + encodeURIComponent(notice.id),
      success: () => { this._openingNotice = false; clearPendingAnnouncement(wx); },
      fail: () => { this._openingNotice = false; },
      complete: () => { this._openingNotice = false; }
    });
  },
  // 离线模式下点提示条重新连接教务：成功就退出离线模式并刷新缓存；
  // 登录已失效时 api 会自动跳回登录页。
  retryOnline() {
    const auth = wx.getStorageSync('auth');
    if (this._retryingOnline || !auth || !auth.offline) {
      return;
    }
    this._retryingOnline = true;
    wx.showLoading({ title: '正在连接教务…', mask: true });
    api.checkToken(auth)
      .then(() => {
        const onlineAuth = Object.assign({}, auth);
        delete onlineAuth.offline;
        delete onlineAuth.offlineReason;
        delete onlineAuth.offlineAt;
        wx.setStorageSync('auth', onlineAuth);
        this.setData({ offlineMode: false });
        wx.hideLoading();
        wx.showToast({ title: '已恢复在线', icon: 'success' });
        warmEssentialCaches(onlineAuth, { force: true }).catch((err) => {
          console.error('warm cache after reconnect failed', err);
        });
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({
          title: api.isConnectivityError(err) ? '教务系统仍无法连接' : (err.message || '连接失败'),
          icon: 'none'
        });
      })
      .then(() => {
        this._retryingOnline = false;
      });
  },
  openNotice() {
    if (!this.data.notice) return;
    wx.navigateTo({
      url: '/subpackages/announcements/list/list'
    });
  },
  goNotifications() {
    wx.navigateTo({ url: '/subpackages/notifications/center/center' });
  },
  goGrades() {
    wx.navigateTo({
      url: '/pages/grades/grades'
    });
  },
  goSchedule() {
    wx.navigateTo({
      url: '/pages/schedule/schedule'
    });
  },
  goExam() {
    wx.navigateTo({
      url: '/pages/exam/exam'
    });
  },
  goTextbook() {
    wx.navigateTo({
      url: '/pages/textbook/textbook'
    });
  },
  goMy() {
    wx.navigateTo({
      url: '/pages/my/my'
    });
  },
  goClassroom() {
    wx.navigateTo({
      url: '/pages/classroom/classroom'
    });
  },
  goStudy() {
    study.openEntry();
  },
  onLogout() {
    // 换人登录不能残留刷课凭据（超星账号密码 / 选课草稿）
    try {
      const auth = wx.getStorageSync('auth');
      if (auth) study.clearAll(auth);
    } catch (e) { /* 清理失败不阻塞登出 */ }
    wx.removeStorageSync('auth');
    wx.reLaunch({
      url: '/pages/login/login'
    });
  }
}));
