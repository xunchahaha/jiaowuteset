const { withPageShare } = require('../../../utils/share');
const task = require('../../../utils/task');
const payment = require('../../../utils/payment');
const study = require('../../../utils/study');

/** 课程超过这个数就折叠，免得把费用区挤到第二屏 */
const COURSE_FOLD = 3;

Page(withPageShare({
  data: {
    ready: false,
    noDraft: false,

    maskedUser: '',
    needPassword: false,      // 没拿到密码（页面被回收 / 没记住）→ 本页补填
    passwordInput: '',

    courses: [],
    courseCount: 0,
    courseFold: COURSE_FOLD,
    coursesExpanded: false,

    answering: false,         // 自动答题（= 服务端 useTiku）
    forceAnswer: false,       // 有「答题解锁」章节 → 强制开启
    answerNotice: study.ANSWER_NOTICE.brief,   // 开关下常驻的效果说明（被强制开启时看不到弹窗，靠它）
    notify: false,

    walletLoaded: false,
    walletError: '',
    available: 0,
    debt: 0,
    reserved: 0,
    products: [],
    pickedKey: '',

    // 结算计划（study.checkoutPlan）
    step: 'submit',
    shortfall: 0,
    estMin: 0,
    estMax: 0,
    product: null,
    times: 0,
    ctaText: '开始刷课',
    ctaSub: '',

    busy: false,
    busyText: '',
    pending: null,            // { outTradeNo } 已支付、还没查到到账
    error: ''
  },

  onLoad() {
    // 刷课不要求登录教务：没登录用游客作用域
    const auth = this._auth = study.currentScope();

    // 草稿是基线（确认页被系统回收也能恢复课程）；eventChannel 是主通道，带内存里的密码
    this.applyDraft(study.loadDraft(auth), (study.loadAccount(auth) || {}).password || '');
    const ch = typeof this.getOpenerEventChannel === 'function' ? this.getOpenerEventChannel() : null;
    if (ch && ch.on) ch.on('studyDraft', d => this.applyDraft(d, d && d.password));
    this.loadWallet();
  },

  onUnload() { this._destroyed = true; },

  getShareConfig() {
    return { title: '刷课服务', path: '/subpackages/study/submit/submit' };
  },

  // ---------- 课程 / 账号 ----------
  applyDraft(d, password) {
    if (!d || !d.courses || !d.courses.length) {
      if (!this.data.courses.length) this.setData({ ready: true, noDraft: true });
      return;
    }
    if (password) this._password = password;
    if (d.username) this._username = d.username;
    const courses = d.courses.map(c => ({
      courseId: String(c.courseId),
      clazzId: String(c.clazzId),
      title: c.title || '未命名课程',
      needUnlock: !!c.needUnlock
    }));
    const forceAnswer = courses.some(c => c.needUnlock);
    this.setData({
      ready: true,
      noDraft: false,
      maskedUser: study.maskPhone(this._username || ''),
      needPassword: !this._password,
      courses,
      courseCount: courses.length,
      forceAnswer,
      answering: forceAnswer || this.data.answering
    });
    this.recompute();
  },

  onToggleCourses() { this.setData({ coursesExpanded: !this.data.coursesExpanded }); },
  onPasswordInput(e) { this.setData({ passwordInput: e.detail.value || '' }); },
  onBack() { wx.navigateBack({ fail: () => wx.redirectTo({ url: '/subpackages/study/submit/submit' }) }); },
  onGoMe() { wx.navigateTo({ url: '/subpackages/study/orders/orders' }); },

  // ---------- 钱包与套餐 ----------
  async loadWallet() {
    try {
      const [w, b] = await Promise.all([task.wallet(), payment.balance()]);
      if (this._destroyed) return false;
      this.setData({
        walletLoaded: true,
        walletError: '',
        available: w.available || 0,
        debt: w.debt || 0,
        reserved: w.reserved || 0,
        products: study.decorateProducts(b.products, { ios: payment.isIOS(), iosMinPrice: b.iosMinPrice, closed: !study.ORDER_OPEN })
      });
      this.recompute();
      return true;
    } catch (e) {
      if (!this._destroyed) this.setData({ walletError: '余额读取失败：' + ((e && e.message) || '请稍后重试') });
      return false;
    }
  },

  onRetryWallet() { this.loadWallet(); },

  recompute() {
    const d = this.data;
    const plan = study.checkoutPlan({
      courseCount: d.courseCount,
      available: d.available,
      debt: d.debt,
      answering: d.answering,
      products: d.products,
      pickedKey: d.pickedKey
    });
    let ctaText = '开始刷课';
    let ctaSub = '';
    if (!study.ORDER_OPEN) {
      plan.step = 'blocked';
      ctaText = '暂不支持下单';
      ctaSub = study.ORDER_CLOSED_TEXT;
    } else if (!d.walletLoaded) {
      ctaSub = d.walletError ? '余额读取失败' : '正在读取余额…';
    } else if (plan.step === 'buy') {
      ctaText = '支付 ¥' + plan.product.priceText + (plan.times > 1 ? ' ×' + plan.times : '');
      ctaSub = '还差 ' + plan.shortfall + ' 次 · 到账后自动开始';
    } else if (plan.step === 'blocked') {
      ctaText = '暂时无法下单';
      ctaSub = '套餐暂不可购买，请联系开发者';
    } else {
      ctaSub = plan.estMax > plan.estMin
        ? '预留 ' + plan.estMax + ' 次，没答题的课退回'
        : '消耗 ' + plan.estMin + ' 次';
    }
    this.setData({
      step: plan.step,
      shortfall: plan.shortfall,
      estMin: plan.estMin,
      estMax: plan.estMax,
      product: plan.product,
      times: plan.times,
      ctaText,
      ctaSub
    });
  },

  onPickProduct(e) {
    const p = this.data.products.find(x => x.key === e.currentTarget.dataset.key);
    if (!p) return;
    if (p.disabled) {
      wx.showToast({ title: study.ORDER_OPEN ? 'iOS 单笔最低 1 元，请选其它档位' : '刷课暂不支持下单', icon: 'none' });
      return;
    }
    this.setData({ pickedKey: p.key });
    this.recompute();
  },

  // ---------- 选项 ----------
  onToggleAnswer(e) {
    if (this.data.forceAnswer) {
      this.setData({ answering: true });
      wx.showToast({ title: '所选课程有答题解锁章节，必须开启', icon: 'none' });
      return;
    }
    if (!e.detail.value || this._answerNoticed) {
      this.setData({ answering: !!e.detail.value });
      this.recompute();
      return;
    }
    // 打开前先说清楚效果预期（不保证全对）；本页确认过一次就不再反复弹
    const n = study.ANSWER_NOTICE;
    wx.showModal({
      title: n.title,
      content: n.content,
      confirmText: n.confirmText,
      cancelText: n.cancelText,
      success: res => {
        this._answerNoticed = !!res.confirm;
        this.setData({ answering: !!res.confirm });
        this.recompute();
      },
      fail: () => this.setData({ answering: false })
    });
  },

  /**
   * 「刷完通知我」：requestSubscribeMessage 必须由点击同步触发，
   * 所以单独做成开关，不和支付弹窗挤在同一次点击里。
   */
  onToggleNotify(e) {
    if (!e.detail.value) { this.setData({ notify: false }); return; }
    this.setData({ notify: true });
    task.grantSubscribe([task.config.templates.progress, task.config.templates.credit])
      .then(r => {
        if (this._destroyed || r.accepted.length) return;
        this.setData({ notify: false });
        wx.showToast({ title: '没有开启通知', icon: 'none' });
      })
      .catch(() => { if (!this._destroyed) this.setData({ notify: false }); });
  },

  // ---------- 支付 ----------
  /** 买一笔并等到账：'delivered' | 'pending' | 'failed'（原因写进 error，页面常驻） */
  async purchase(product) {
    this.setData({ busy: true, busyText: '正在拉起支付', error: '' });
    try {
      const r = await payment.buy(product.key);
      this.setData({ busyText: '正在确认到账' });
      await this.loadWallet();
      if (r.delivered) { this.setData({ pending: null }); return 'delivered'; }
      this.setData({ pending: { outTradeNo: r.outTradeNo } });
      return 'pending';
    } catch (err) {
      const msg = (err && err.message) || '支付未完成';
      if (!/cancel/i.test(msg)) this.setData({ error: '支付未完成：' + msg });   // 用户主动取消不算错
      return 'failed';
    } finally {
      if (!this._destroyed) this.setData({ busy: false, busyText: '' });
    }
  },

  async onRefreshDelivery() {
    const p = this.data.pending;
    if (!p || this.data.busy) return;
    this.setData({ busy: true, busyText: '正在查询到账' });
    const r = await payment.confirmDelivery(p.outTradeNo, { tries: 1 });
    await this.loadWallet();
    if (this._destroyed) return;
    this.setData({ busy: false, busyText: '', pending: r.delivered ? null : p });
    wx.showToast({ title: r.delivered ? '次数已到账' : '还没到账，稍后会自动补发', icon: r.delivered ? 'success' : 'none' });
  },

  // ---------- 主按钮：差多少买多少，够了就提交 ----------
  async onPrimary() {
    if (this.data.busy || !this.data.courses.length) return;
    if (!study.ORDER_OPEN) {
      this.setData({ error: study.ORDER_CLOSED_TEXT });
      return;
    }
    const password = this._password || this.data.passwordInput;
    if (!password) {
      this.setData({ needPassword: true, error: '请先填写学习通密码' });
      return;
    }
    if (!this.data.walletLoaded && !(await this.loadWallet())) return;

    if (this.data.step === 'blocked') {
      this.setData({ error: '套餐暂不可购买，请联系开发者' });
      return;
    }
    if (this.data.step === 'buy') {
      const r = await this.purchase(this.data.product);
      if (r !== 'delivered') return;
      if (this.data.step === 'buy') {
        wx.showToast({ title: '已到账，还差 ' + this.data.shortfall + ' 次', icon: 'none' });
        return;
      }
    }
    await this.submit(password);
  },

  async submit(password) {
    this.setData({ busy: true, busyText: '正在提交', error: '' });
    try {
      const data = await task.submitTask({
        // 超时 / 断网重试复用同一 requestId：服务端可能已建单，幂等返回原任务，不会重复下单
        requestId: this._requestId || (this._requestId = task.newRequestId()),
        username: this._username,
        password,
        courseIds: this.data.courses.map(c => c.courseId),
        useTiku: this.data.answering,
        billing: 'v2',
        speed: 1.0,
        notopenAction: 'retry'
      });
      if (!this._password) {
        // 本页补填的密码按「记住密码」开关回存
        const acc = study.loadAccount(this._auth) || {};
        study.saveAccount(this._auth, { username: this._username, password, remember: acc.remember !== false });
      }
      study.clearDraft(this._auth);
      wx.redirectTo({ url: '/subpackages/study/progress/progress?taskId=' + encodeURIComponent(data.taskId) });
    } catch (err) {
      const msg = (err && err.message) || '提交失败，请稍后重试';
      // 明确被拒（余额、额度、参数）换新 requestId，改完条件能重新提交
      if (!/超时|连接失败/.test(msg)) this._requestId = null;
      if (this._destroyed) return;
      this.setData({ busy: false, busyText: '', error: msg });
      // 被拒往往是余额变了（别处下了单 / 欠款），刷新一下让按钮状态对得上
      this.loadWallet();
    }
  }
}));
