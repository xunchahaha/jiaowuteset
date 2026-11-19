const { withPageShare } = require('../../../utils/share');
const task = require('../../../utils/task');
const invite = require('../../../utils/study-invite');

// 邀请助力活动页。两种身份：
//   mine   自己的活动：助力位、已领次数、好友列表、分享按钮
//   visit  好友点开分享卡片进来（带 code）：「帮 TA 助力」→ 绑定邀请关系 → 去刷课页登录学习通读课程
// 活动开关、次数、文案都来自云端（inviteStatus），页面不写死。
const CODE_RE = /^[0-9a-f]{16}$/;

Page(withPageShare({
  data: {
    loading: true,
    error: '',
    mode: 'mine',
    v: null,
    notice: '',           // mine 模式顶部提示（如邀请链接无效）

    // visit 模式
    visitBound: false,    // 已接受过这次邀请，还没登录学习通
    visitText: '',        // 不能助力的原因（有值时不显示助力按钮）
    accepting: false
  },

  onLoad(options) {
    const code = String((options && options.code) || '');
    this._code = CODE_RE.test(code) ? code : '';
    this.load();
  },

  // 从刷课页回来时刷新进度（好友刚助力完）
  onShow() {
    if (this._loaded) this.load(true);
  },

  onUnload() { this._destroyed = true; },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh());
  },

  async load(silent) {
    if (!silent) this.setData({ loading: true, error: '' });
    try {
      const res = await task.inviteStatus(this._code);
      if (this._destroyed) return;
      this._loaded = true;
      const v = invite.buildView(res);
      const visiting = res.visiting;
      const patch = { loading: false, error: '', v, notice: '' };
      if (this._code && visiting && visiting.valid && !visiting.self && !this._mine) {
        patch.mode = 'visit';
        const by = res.invitedBy;
        patch.visitBound = !!(by && by.status === 'bound');
        patch.visitText = '';
        if (by && by.status !== 'bound') patch.visitText = '每人只能助力一次，你已经助力过了';
        else if (!v.active) patch.visitText = v.orderOpen ? '活动已结束，下次再来吧' : '刷课服务暂停接单，助力活动暂停';
      } else {
        patch.mode = 'mine';
        if (this._code && visiting && !visiting.valid) patch.notice = '邀请链接无效，请让好友重新分享';
      }
      this.setData(patch);
      if (typeof this.refreshShareCard === 'function') this.refreshShareCard();
    } catch (err) {
      if (this._destroyed) return;
      if (!silent || !this.data.v) this.setData({ loading: false, error: (err && err.message) || '活动加载失败' });
    }
  },

  onRetry() { this.load(); },

  // ---------- visit ----------
  async onAccept() {
    if (this.data.accepting) return;
    if (this.data.visitBound) { this.goLogin(); return; }
    this.setData({ accepting: true });
    try {
      const r = await task.inviteAccept(this._code);
      if (this._destroyed) return;
      if (r && r.status === 'bound') {
        this.setData({ accepting: false, visitBound: true });
        this.goLogin();
        return;
      }
      if (r && r.status === 'self') { this.onSwitchMine(); this.setData({ accepting: false }); return; }
      this.setData({ accepting: false, visitText: invite.acceptText(r && r.status) });
    } catch (err) {
      if (this._destroyed) return;
      this.setData({ accepting: false });
      wx.showToast({ title: (err && err.message) || '助力失败，请重试', icon: 'none' });
    }
  },

  goLogin() {
    wx.navigateTo({ url: '/subpackages/study/submit/submit?from=invite' });
  },

  onSwitchMine() {
    this._mine = true;
    this.setData({ mode: 'mine' });
  },

  // ---------- mine ----------
  onGoStudy() { wx.navigateTo({ url: '/subpackages/study/submit/submit' }); },

  getShareConfig() {
    const v = this.data.v;
    if (!v || !v.code) return { title: '刷课服务', path: '/subpackages/study/submit/submit' };
    return {
      title: v.shareTitle || '帮我助力一下，免费领刷课次数',
      path: '/subpackages/study/invite/invite?code=' + v.code
    };
  },

  getShareCard() {
    const v = this.data.v || {};
    return {
      theme: 'amber',
      eyebrow: '好友助力',
      headline: '帮我助力一下',
      sub: '点开后登录学习通查看课程，就能帮我领 ' + (v.reward || 1) + ' 次刷课次数',
      chips: ['新同学可助力', '登录即完成', '不用付费']
    };
  }
}));
