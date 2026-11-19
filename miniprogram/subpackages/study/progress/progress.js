const { withPageShare } = require('../../../utils/share');
const { buildScopedCacheKey, loadWithCache, writeCache } = require('../../../utils/cache');
const task = require('../../../utils/task');
const study = require('../../../utils/study');
const payment = require('../../../utils/payment');
const view = require('../../../utils/study-view');

const CANCEL_TIMEOUT_MS = 15000;

/** 给 Promise 加客户端超时（云函数调用本身没有超时，不能无限转圈） */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

Page(withPageShare({
  data: {
    loading: true,
    error: '',
    notice: '',
    t: null,               // study-view.decorateTask 的结果
    canceling: false,
    resuming: false,
    tikuBalance: 0         // 仅老订单（题库券计费）暂停后续跑用
  },

  onLoad(options) {
    // 刷课不要求登录教务：没登录用游客作用域
    this._auth = study.currentScope();
    this._taskId = (options && options.taskId) || '';
    if (!this._taskId) {
      this.setData({ loading: false, error: '缺少任务标识' });
      return;
    }
    this._alive = true;
    this.load();
  },

  onShow() {
    this._alive = true;
    if (this.data.t) this.schedulePoll();
  },

  onHide() { this._alive = false; this.stopPoll(); },
  onUnload() { this._alive = false; this._destroyed = true; this.stopPoll(); },

  getShareConfig() {
    return { title: '刷课进度', path: '/subpackages/study/progress/progress?taskId=' + this._taskId };
  },

  getShareCard() {
    const t = this.data.t;
    if (!t) return null;
    const tone = { danger: 'red', ok: 'green', warn: 'amber' }[t.tone] || 'slate';
    return {
      theme: tone,
      eyebrow: '刷课进度',
      headline: t.headline,
      sub: t.subline,
      progress: t.percent,
      progressLabel: '整体进度'
    };
  },

  cacheKey() { return buildScopedCacheKey('study-progress', this._auth, this._taskId); },

  // ---------- 加载：缓存先秒开，后台刷新 ----------
  load() {
    const loadId = this._loadId = (this._loadId || 0) + 1;
    return loadWithCache({
      key: this.cacheKey(),
      // 刷课服务器与教务无关：教务离线时这里照样请求
      offline: false,
      isActive: () => !this._destroyed && this._loadId === loadId,
      fetch: () => task.getProgress(this._taskId),
      apply: (payload, meta) => {
        this.apply(payload);
        this.setData({ notice: meta.notice || '' });
      },
      setNotice: n => this.setData({ notice: n || '' }),
      onError: err => this.setData({ loading: false, error: (err && err.message) || '获取进度失败' })
    }).then(() => {
      if (!this._destroyed) this.schedulePoll();
    }).catch(() => {});
  },

  apply(payload) {
    if (!payload) return;
    const t = view.decorateTask(payload);
    this.setData({ loading: false, error: '', t });
    if (t.isPaused && !t.useTiku) this.refreshTiku();
  },

  async refreshTiku() {
    try {
      const b = await payment.balance();
      if (!this._destroyed) this.setData({ tikuBalance: b.tikuBalance || 0 });
    } catch (e) { /* 忽略 */ }
  },

  // ---------- 轮询（setTimeout 自递归；终态 / 暂停态不轮询） ----------
  schedulePoll() {
    const t = this.data.t;
    if (this._timer || !this._alive || !t || t.isTerminal || t.isPaused) return;
    this._timer = setTimeout(() => this.poll(), task.config.pollIntervalMs);
  },

  stopPoll() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  },

  async poll() {
    this._timer = null;
    if (!this._alive) return;
    const id = this._pollId = (this._pollId || 0) + 1;
    try {
      const payload = await task.getProgress(this._taskId);
      if (!this._alive || id !== this._pollId) return;
      this.apply(payload);
      this.setData({ notice: '' });
      try { writeCache(this.cacheKey(), payload); } catch (e) { /* 缓存失败不影响 */ }
    } catch (e) { /* 网络抖动：下一轮再试 */ }
    this.schedulePoll();
  },

  onPullDownRefresh() {
    this.stopPoll();
    Promise.resolve(this.load()).then(() => wx.stopPullDownRefresh(), () => wx.stopPullDownRefresh());
  },

  onRetry() {
    this.setData({ loading: true, error: '' });
    this.load();
  },

  // ---------- 取消 ----------
  onCancel() {
    if (this.data.canceling) return;
    wx.showModal({
      title: '取消任务',
      content: '未完成的课程会停止且不扣次数，已完成的保留。确定取消吗？',
      confirmText: '取消任务',
      cancelText: '再想想',
      success: res => { if (res.confirm) this.doCancel(); }
    });
  },

  async doCancel() {
    this._cancelling = true;
    this.setData({ canceling: true });
    this.stopPoll();
    try {
      await withTimeout(task.cancelTask(this._taskId), CANCEL_TIMEOUT_MS, '取消请求超时，任务可能已停止，下拉刷新看看');
      try {
        this.apply(await withTimeout(task.getProgress(this._taskId), 8000, '确认超时'));
      } catch (e) { /* 拿不到最新进度就交给下拉刷新 */ }
      wx.showToast({ title: '已取消', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '取消失败，请稍后重试', icon: 'none', duration: 2500 });
    } finally {
      // 无论成败都必须复位，否则按钮会永久卡在「正在取消」
      this._cancelling = false;
      if (!this._destroyed) this.setData({ canceling: false });
      this.schedulePoll();
    }
  },

  // ---------- 老订单（题库券计费）暂停后续跑 ----------
  async onResume() {
    if (this.data.resuming || this.data.tikuBalance < 1) return;
    this.setData({ resuming: true });
    try {
      await task.resumeTask(this._taskId, Number(this.data.tikuBalance));
      this.apply(await task.getProgress(this._taskId));
      this.schedulePoll();
    } catch (e) {
      wx.showModal({ title: '续跑失败', content: (e && e.message) || '请稍后重试', showCancel: false });
    } finally {
      if (!this._destroyed) this.setData({ resuming: false });
    }
  },

  onGoSubmit() { wx.redirectTo({ url: '/subpackages/study/submit/submit' }); },
  onGoMe() { wx.navigateTo({ url: '/subpackages/study/orders/orders' }); }
}));
