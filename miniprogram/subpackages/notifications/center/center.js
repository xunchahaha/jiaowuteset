const { withPageShare } = require('../../../utils/share');
const api = require('../../../utils/api');
const notification = require('../../../utils/notifications');
const planCache = require('../../../utils/notification-plan-cache');
const STATUS = { sent: '微信已受理', failed: '发送失败', unknown: '结果待确认', sending: '处理中', skipped: '已跳过' };

Page(withPageShare({
  data: { loading: true, busy: false, subscribing: false, syncingSubscriptions: false, pendingCount: 0, error: '', ready: false, enabled: false, leadMinutes: 30,
    leadOptions: notification.config.leadMinutes, leadIndex: 4, estimatedCredits: null, creditLimit: 200,
    syncedThrough: '', syncedAtText: '', lessonCount: 0, pendingReceipt: false, records: [], showRecords: false,
    progress: '', planStatus: '', syncingSchedule: false, syncError: '', permissionText: '微信服务通知 · 课前提醒' },
  onLoad() { this._alive = true; },
  onUnload() { this._alive = false; },
  async onShow() {
    if (this.data.busy || this.data.subscribing || this._receiptSyncing || this.data.syncingSchedule) return;
    const value = await this.refresh();
    if (!value || !this._alive) return;
    await this.autoSyncSchedule(value);
  },
  getShareConfig() { return { title: '教务助手 · 通知中心' }; },
  applyStatus(value) {
    this._accountKey = value.accountKey;
    const key = 'notificationReceipt:' + value.accountKey;
    this._pending = this.readReceipts(key);
    const records = (value.records || this.data.records || []).map(r => Object.assign({}, r, { statusText: STATUS[r.status] || r.status }));
    this.setData({ ready: true, loading: false, error: '', enabled: value.enabled,
      leadMinutes: value.leadMinutes, leadIndex: notification.config.leadMinutes.indexOf(value.leadMinutes),
      estimatedCredits: value.estimatedCredits, creditLimit: value.creditLimit, lessonCount: value.lessonCount,
      syncedThrough: value.syncedThrough, syncedAtText: value.syncedAt ? new Date(value.syncedAt).toLocaleString() : '',
      pendingReceipt: this._pending.length > 0, pendingCount: this._pending.length, records });
  },
  async refresh() {
    if (this.data.busy || this.data.subscribing || this._receiptSyncing || this.data.syncingSchedule) return;
    const id = this._refreshId = (this._refreshId || 0) + 1;
    const current = () => this._alive && id === this._refreshId;
    this.setData({ loading: true, ready: false, error: '' });
    try { const value = await notification.call('getStatus'); if (current()) { this.applyStatus(value); return value; } }
    catch (error) { if (current()) this.setData({ ready: false, error: error.message }); }
    finally { if (current()) this.setData({ loading: false }); }
  },
  showError(error) { if (this._alive) wx.showModal({ title: '操作未完成', content: error.message || '请稍后重试', showCancel: false }); },
  readReceipts(key) {
    const stored = wx.getStorageSync(key);
    return Array.isArray(stored) ? stored : stored && stored.requestId ? [stored] : [];
  },
  persistReceipts(key, items) {
    if (items.length) wx.setStorageSync(key, items);
    else wx.removeStorageSync(key);
    this._pending = items;
    if (this._alive) this.setData({ pendingReceipt: items.length > 0, pendingCount: items.length });
  },
  onAddSubscription() {
    if (this.data.busy || this.data.subscribing || !this.data.ready) return;
    if (this.data.estimatedCredits + this.data.pendingCount >= this.data.creditLimit) {
      wx.showToast({ title: '已达到本应用记录上限', icon: 'none' }); return;
    }
    if (typeof wx.requestSubscribeMessage !== 'function') { this.showError(Error('请升级微信后订阅')); return; }
    this.setData({ subscribing: true });
    const requestId = notification.newRequestId();
    const key = 'notificationReceipt:' + this._accountKey;
    // Every request remains a direct user tap, never an automatic prompt loop.
    try { wx.requestSubscribeMessage({ tmplIds: [notification.config.templateId],
      success: result => {
        if (this._alive) this.setData({ subscribing: false });
        if (result[notification.config.templateId] === 'accept') {
          const queue = this.readReceipts(key);
          if (!queue.some(item => item.requestId === requestId)) queue.push({ requestId, templateId: notification.config.templateId, accepted: true });
          this.persistReceipts(key, queue);
          if (this._alive) {
            wx.showToast({ title: '已同意，后台同步中', icon: 'none' });
            this.saveReceipt();
          }
        } else {
          this.showError(Error('此次未同意订阅，次数未增加。可在“订阅权限”中检查微信设置。'));
        }
      },
      fail: () => { if (this._alive) this.setData({ subscribing: false }); this.showError(Error('订阅请求失败，请在手机微信中重试并检查模板配置')); }
    }); } catch (error) {
      if (this._alive) this.setData({ subscribing: false });
      this.showError(Error('订阅请求未能发起，请升级微信并重试'));
    }
  },
  onRetrySubscriptions() { if (this.data.ready && !this.data.busy && !this.data.subscribing) this.saveReceipt(); },
  async saveReceipt() {
    if (this._receiptSyncing || !this._pending || !this._pending.length) return;
    this._receiptSyncing = true;
    if (this._alive) this.setData({ syncingSubscriptions: true });
    const key = 'notificationReceipt:' + this._accountKey;
    try {
      while (this._alive) {
        const queue = this.readReceipts(key);
        if (!queue.length) break;
        const receipt = queue[0];
        const value = await notification.call('recordSubscription', receipt);
        // Remove only the acknowledged receipt; preserve taps accepted in flight.
        this.persistReceipts(key, this.readReceipts(key).filter(item => item.requestId !== receipt.requestId));
        // Only apply credit fields: automatic schedule sync may finish in parallel.
        if (this._alive) this.setData({ estimatedCredits: value.estimatedCredits, creditLimit: value.creditLimit });
      }
    } catch (error) {
      if (this._alive) wx.showToast({ title: '订阅已保留，请点同步重试', icon: 'none' });
    } finally {
      this._receiptSyncing = false;
      if (this._alive) this.setData({ syncingSubscriptions: false });
    }
  },
  async retryAutoSync() {
    if (this.data.busy || this.data.subscribing || this._receiptSyncing || this.data.syncingSchedule) return;
    const value = await this.refresh();
    if (value && this._alive) await this.autoSyncSchedule(value, true);
  },
  async autoSyncSchedule(initial, force = false) {
    if (this.data.syncingSchedule || !this._alive || !this.data.ready) return;
    const auth = wx.getStorageSync('auth');
    const setupKey = 'notificationAutoSetup:' + initial.accountKey;
    const explicitlyOff = wx.getStorageSync('notificationReminderChoice:' + initial.accountKey) === false;
    if (explicitlyOff) wx.removeStorageSync(setupKey);
    else if (!initial.syncedAt && !initial.enabled) wx.setStorageSync(setupKey, true);
    const autoEnable = !!wx.getStorageSync(setupKey);
    this.setData({ syncingSchedule: true, syncError: '', progress: '检查课表更新' });
    const check = () => {
      const current = wx.getStorageSync('auth');
      if (!this._alive || !current || !auth || current.token !== auth.token || current.offline) throw Error('请联网登录后重新进入通知中心');
    };
    try {
      const semester = await notification.loadSemester(api, auth, check);
      check();
      const cached = planCache.read(wx, auth, initial.accountKey);
      if (!force && !autoEnable && !planCache.needsCheck(cached, semester, initial)) {
        this.setData({ planStatus: '课表未发现变化，沿用已准备的提醒' });
        return;
      }
      const lessons = await notification.collectPlan(api, auth, check,
        (n, total) => { if (this._alive) this.setData({ progress: `核对课表 ${n}/${total} 周` }); }, semester);
      check();
      const unchanged = planCache.samePlan(cached, semester, initial, lessons);
      let value = unchanged ? initial : await notification.call('syncPlan', { lessons });
      check();
      if (autoEnable && value.lessonCount > 0) {
        value = await notification.call('saveSettings', { enabled: true, leadMinutes: value.leadMinutes });
        check();
        wx.removeStorageSync(setupKey);
      }
      // Keep the independent subscription ledger intact while applying plan state.
      this.setData({ enabled: value.enabled, leadMinutes: value.leadMinutes,
        leadIndex: notification.config.leadMinutes.indexOf(value.leadMinutes), lessonCount: value.lessonCount,
        syncedThrough: value.syncedThrough, syncedAtText: value.syncedAt ? new Date(value.syncedAt).toLocaleString() : '' });
      planCache.save(wx, auth, initial.accountKey, semester, value, lessons, cached);
      this.setData({ planStatus: unchanged ? '课表无变化，无需重复同步' : '课表变化已更新到提醒服务' });
    } catch (error) {
      if (this._alive) this.setData({ syncError: error.message || '课表自动更新失败，请重试' });
    } finally { if (this._alive) this.setData({ syncingSchedule: false, progress: '' }); }
  },
  async changeSettings(enabled, leadMinutes, explicitChoice = false) {
    if (this.data.busy || this.data.subscribing || this._receiptSyncing || this.data.syncingSchedule || !this.data.ready) return;
    this.setData({ busy: true });
    try {
      const value = await notification.call('saveSettings', { enabled, leadMinutes });
      if (explicitChoice) {
        wx.setStorageSync('notificationReminderChoice:' + this._accountKey, enabled);
        if (!enabled) wx.removeStorageSync('notificationAutoSetup:' + this._accountKey);
      }
      if (this._alive) this.applyStatus(value);
    }
    catch (error) { this.showError(error); if (this._alive) this.setData({ enabled: this.data.enabled }); }
    finally { if (this._alive) this.setData({ busy: false }); }
  },
  onToggle(event) {
    if (event.detail.value && !this.data.lessonCount) {
      this.setData({ enabled: this.data.enabled });
      this.showError(Error(this.data.syncError ? '课表自动更新未完成，请点击“重新尝试”' : '当前暂无未来课程，暂不安排提醒')); return;
    }
    this.changeSettings(!!event.detail.value, this.data.leadMinutes, true);
  },
  onLeadChange(event) { this.changeSettings(this.data.enabled, notification.config.leadMinutes[Number(event.detail.value)]); },
  onPermissions() {
    wx.getSetting({ withSubscriptions: true, success: result => {
      const value = result.subscriptionsSetting || {};
      const state = value.itemSettings && value.itemSettings[notification.config.templateId];
      wx.showModal({ title: '订阅权限', confirmText: '去设置',
        content: `服务通知总开关：${value.mainSwitch === false ? '关闭' : '请在设置中确认'}。\n本模板记忆选择：${state || '未记录'}。记忆“允许”不代表无限次数，每次点击仍只申请一次。`,
        success: choice => { if (choice.confirm) wx.openSetting({ withSubscriptions: true }); } });
    }, fail: () => this.showError(Error('读取订阅设置失败')) });
  },
  onTest() {
    if (this.data.busy || this.data.subscribing || this._receiptSyncing || this.data.syncingSchedule || !this.data.ready) return;
    wx.showModal({ title: '发送测试提醒', content: '使用已同步的一节未来课程发送测试，将消耗一次订阅机会，是否继续？',
      success: async choice => {
        if (!choice.confirm || this.data.busy || this.data.subscribing || this._receiptSyncing || this.data.syncingSchedule || !this._alive) return;
        this.setData({ busy: true });
        try {
          const value = await notification.call('sendTest', { requestId: notification.newRequestId() });
          if (this._alive) { this.applyStatus(value); this.setData({ showRecords: true }); }
        } catch (error) { this.showError(error); }
        finally { if (this._alive) this.setData({ busy: false }); }
      } });
  },
  onRecords() { this.setData({ showRecords: !this.data.showRecords }); if (!this.data.busy) this.refresh(); }
}));
