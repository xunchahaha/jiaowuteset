const { withPageShare } = require('../../../utils/share');
const { buildScopedCacheKey, loadWithCache } = require('../../../utils/cache');
const task = require('../../../utils/task');
const payment = require('../../../utils/payment');
const study = require('../../../utils/study');
const view = require('../../../utils/study-view');

/** 订单状态：已到账 / 已退款 / 部分退款 / 未到账（付了但还没确认）/ 未支付 */
function orderState(o) {
  if (o.status === 'paid') return { text: '已到账', tone: 'ok' };
  if (o.status === 'refunded') return { text: '已退款', tone: 'muted' };
  if (o.status === 'partially_refunded') return { text: '部分退款', tone: 'warn' };
  if (o.attempted) return { text: '未到账', tone: 'danger' };
  return { text: '未支付', tone: 'muted' };
}

Page(withPageShare({
  data: {
    tab: 'records',          // records | orders

    walletLoaded: false,
    available: 0,
    debt: 0,
    reserved: 0,
    products: [],
    buying: '',              // 正在购买的套餐 key

    records: [],
    recordsLoading: true,
    recordsError: '',
    recordsNotice: '',

    orders: [],
    ordersLoading: true,
    ordersError: '',
    unpaidCount: 0,

    showRules: false
  },

  onLoad() {
    // 刷课不要求登录教务：没登录用游客作用域
    this._auth = study.currentScope();
    this._ready = true;
  },

  onShow() {
    if (!this._ready) return;
    this._alive = true;
    this.loadWallet();
    this.loadRecords();
    this.loadOrders();
  },

  onHide() { this._alive = false; },
  onUnload() { this._alive = false; this._destroyed = true; },

  onPullDownRefresh() {
    Promise.all([this.loadWallet(), this.loadRecords(), this.loadOrders()])
      .then(() => wx.stopPullDownRefresh(), () => wx.stopPullDownRefresh());
  },

  getShareConfig() {
    return { title: '刷课服务', path: '/subpackages/study/submit/submit' };
  },

  onSwitchTab(e) { this.setData({ tab: e.currentTarget.dataset.tab }); },
  onToggleRules() { this.setData({ showRules: !this.data.showRules }); },
  onGoSubmit() { wx.navigateTo({ url: '/subpackages/study/submit/submit' }); },

  // ---------- 钱包 / 充值 ----------
  async loadWallet() {
    try {
      const [w, b] = await Promise.all([task.wallet(), payment.balance()]);
      if (this._destroyed) return;
      this.setData({
        walletLoaded: true,
        available: w.available || 0,
        debt: w.debt || 0,
        reserved: w.reserved || 0,
        products: study.decorateProducts(b.products, { ios: payment.isIOS(), iosMinPrice: b.iosMinPrice, closed: !study.ORDER_OPEN })
      });
    } catch (e) { /* 余额读不到不阻塞记录与订单 */ }
  },

  async onBuy(e) {
    const p = this.data.products.find(x => x.key === e.currentTarget.dataset.key);
    if (!p || this.data.buying) return;
    if (p.disabled) {
      wx.showToast({ title: study.ORDER_OPEN ? 'iOS 单笔最低 1 元，请选其它档位' : '刷课暂不支持下单', icon: 'none' });
      return;
    }
    this.setData({ buying: p.key });
    try {
      const r = await payment.buy(p.key);
      await this.loadWallet();
      if (r.delivered) {
        wx.showToast({ title: '已到账 ' + p.credits + ' 次', icon: 'success' });
      } else {
        wx.showModal({
          title: '支付已受理',
          content: '还没查到到账，最迟 24 小时内自动补发。可以在「充值订单」里点「刷新到账」。',
          showCancel: false
        });
      }
    } catch (err) {
      const msg = (err && err.message) || '支付未完成';
      if (!/cancel/i.test(msg)) wx.showModal({ title: '支付未完成', content: msg, showCancel: false });
    } finally {
      if (!this._destroyed) this.setData({ buying: '' });
      this.loadOrders();
    }
  },

  // ---------- 刷课记录（缓存先秒开，服务器连不上也能看上次的） ----------
  loadRecords() {
    const loadId = this._recordsId = (this._recordsId || 0) + 1;
    return loadWithCache({
      key: buildScopedCacheKey('study-tasks', this._auth),
      offline: false,
      isActive: () => !this._destroyed && this._recordsId === loadId,
      fetch: () => task.listTasks(),
      apply: (payload, meta) => {
        const now = Date.now();
        this.setData({
          recordsLoading: false,
          recordsError: '',
          recordsNotice: (meta && meta.notice) || '',
          records: ((payload && payload.tasks) || []).map(t => view.decorateRecord(t, now))
        });
      },
      setNotice: n => this.setData({ recordsNotice: n || '' }),
      onError: err => this.setData({ recordsLoading: false, recordsError: (err && err.message) || '记录读取失败' })
    }).catch(() => {});
  },

  onOpenRecord(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/subpackages/study/progress/progress?taskId=' + encodeURIComponent(id) });
  },

  // ---------- 充值订单（云开发，不缓存） ----------
  async loadOrders() {
    try {
      const r = await payment.listOrders(20);
      if (this._destroyed) return;
      const now = Date.now();
      const orders = ((r && r.orders) || []).map(o => {
        const st = orderState(o);
        return {
          outTradeNo: o.outTradeNo,
          name: o.kind === 'tiku' ? (o.credits + ' 题题库券') : (o.credits + ' 次'),
          priceText: study.yuan(o.price),
          stateText: st.text,
          tone: st.tone,
          timeText: study.formatTime(o.paidAt || o.createdAt, now),
          canRefresh: o.status === 'created' && !!o.attempted
        };
      });
      this.setData({
        ordersLoading: false,
        ordersError: '',
        orders,
        unpaidCount: orders.filter(o => o.canRefresh).length
      });
    } catch (e) {
      if (!this._destroyed) this.setData({ ordersLoading: false, ordersError: (e && e.message) || '订单读取失败' });
    }
  },

  async onRefreshOrder(e) {
    const id = e.currentTarget.dataset.id;
    wx.showLoading({ title: '正在查询' });
    const r = await payment.confirmDelivery(id, { tries: 1 });
    wx.hideLoading();
    wx.showToast({ title: r.delivered ? '已到账' : '还没到账，稍后会自动补发', icon: r.delivered ? 'success' : 'none' });
    this.loadWallet();
    this.loadOrders();
  },

  onCopyOrder(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.setClipboardData({ data: String(id) });
  },

  /** 售后：联系客服（公告里有 QQ 群二维码） */
  onContact() {
    wx.navigateTo({ url: '/subpackages/announcements/detail/detail?id=study-maintenance-20261022' });
  },

  onRetryRecords() { this.setData({ recordsLoading: true }); this.loadRecords(); },
  onRetryOrders() { this.setData({ ordersLoading: true }); this.loadOrders(); }
}));
