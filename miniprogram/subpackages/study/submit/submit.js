const { withPageShare } = require('../../../utils/share');
const task = require('../../../utils/task');
const study = require('../../../utils/study');
const inviteView = require('../../../utils/study-invite');

// 扫描没有可信进度回传：只给「分阶段诚实文案 + 已用秒数」，不给假百分比。
// 实测一次扫描常要 30~50 秒，文案不提前承诺「即将完成」。
const SCAN_STAGES = [
  { at: 0, text: '正在登录学习通' },
  { at: 3000, text: '正在读取课程列表' },
  { at: 8000, text: '正在检查各门课的章节' },
  { at: 25000, text: '课程较多，仍在读取' }
];
const SCAN_SOFT_MS = 25000;   // 之后显示「慢但仍在读」的安抚文案
const SCAN_HARD_MS = 120000;  // 与云函数 60 秒超时对齐并留余量，超过就停下让用户重试

function scanErrorMessage(err) {
  const msg = String((err && err.message) || '');
  if (/超时/.test(msg)) return '读取超时，可能是学习通响应慢，请稍后重试';
  if (/登录失败|密码|账号/.test(msg)) return '学习通登录失败：' + msg.replace(/^超星登录失败[:：]\s*/, '');
  if (/连接失败|网络/.test(msg)) return '刷课服务器暂时连不上，请稍后重试';
  if (/繁忙|扫描中/.test(msg)) return msg;
  return msg || '读取课程失败，请重试';
}

/**
 * 读出来就不用刷的课，不让选（引擎即使收到也会记「无需刷」不扣次数，但同名空壳课容易选错真课）：
 * - 平台上 0 个章节：空壳课 / 老师还没发布（例：「26级高等数学I（A）」是空壳，真课是「26级高等数学I」）
 * - 章节全部已完成
 * 只认本次读取到的数据（scanState=ok）；恢复草稿、老服务器没有这些字段时一律可选。
 */
function blockReason(c) {
  if (!c || c.scanState !== 'ok') return '';
  const jobs = Number(c.jobCount);
  if (c.jobCount != null && jobs === 0) return '平台上这门课没有章节，可能是空壳课或老师还没发布，不用刷';
  const finished = Number(c.finishedCount);
  if (jobs > 0 && c.finishedCount != null && finished >= jobs) return '章节已全部完成，不用再刷';
  return '';
}

Page(withPageShare({
  data: {
    orderOpen: study.isOrderOpen(),
    closedText: study.ORDER_CLOSED_TEXT,
    available: 0,
    runningTaskId: '',

    // 学习通账号
    username: '',
    password: '',
    remember: true,
    showPassword: false,
    maskedUser: '',
    editingAccount: false,

    // 读取课程
    scanning: false,
    scanText: '',
    scanSoft: false,
    scanError: '',
    draftCount: 0,

    // 选课（只有本次读取 / 恢复草稿后才出现）
    scanned: false,
    courses: [],
    selected: {},
    selectedCount: 0,
    allSelected: false,
    blockedCount: 0,
    unlockSelected: 0,

    // 邀请助力（配置与进度都来自云端 inviteStatus；活动关着时 invite 为 null，入口和弹窗都不出）
    invite: null,
    invitePopup: false,
    inviteHelping: false,   // 我接受了好友的邀请，登录学习通读到课程就算助力
    inviteNotice: null      // 读课程后带回的助力结果
  },

  onLoad() {
    this._alive = true;
    // 刷课不要求登录教务：没登录用游客作用域
    const auth = this._auth = study.currentScope();

    const acc = study.loadAccount(auth) || {};
    const draft = study.loadDraft(auth);
    this.setData({
      username: acc.username || '',
      password: acc.password || '',
      remember: acc.remember !== false,
      draftCount: draft && draft.courses ? draft.courses.length : 0
    });
    // 本机没记住账号时，用服务端那份（只回用户名）预填，方便换手机
    if (!acc.username) this.prefillRemoteAccount();
  },

  onShow() {
    this._alive = true;
    // 下单开关可能在看板里被切过（首页 / 登录页拉到新配置后）
    if (this.data.orderOpen !== study.isOrderOpen()) this.setData({ orderOpen: study.isOrderOpen() });
    this.refreshWallet();
    this.checkRunning();
    this.loadInvite();
    // 读取期间页面被隐藏会停计时器；回到前台恢复，「已用 N 秒」和硬超时继续生效
    if (this.data.scanning) this.startScanTimer(this._scanId);
  },

  onHide() { this._alive = false; this.stopScanTimer(); },
  onUnload() { this._alive = false; this._destroyed = true; this.stopScanTimer(); },

  getShareConfig() {
    return { title: '刷课服务', path: '/subpackages/study/submit/submit' };
  },

  // ---------- 顶部 ----------
  async refreshWallet() {
    try {
      const w = await task.wallet();
      if (!this._destroyed) this.setData({ available: w.available || 0 });
    } catch (e) { /* 余额读不到不影响选课 */ }
  },

  async checkRunning() {
    try {
      const r = await task.listTasks();
      if (this._destroyed) return;
      const list = (r && r.tasks) || [];
      const hit = list.find(t => ['queued', 'running', 'paused_tiku'].indexOf(t.status) >= 0);
      this.setData({ runningTaskId: hit ? String(hit.taskId) : '' });
    } catch (e) { /* 忽略 */ }
  },

  async prefillRemoteAccount() {
    try {
      const r = await task.getAccount();
      if (this._destroyed || !r || !r.username || this.data.username) return;
      this.setData({ username: r.username });
    } catch (e) { /* 服务器不可用时静默 */ }
  },

  // ---------- 邀请助力 ----------
  async loadInvite() {
    try {
      const res = await task.inviteStatus();
      if (this._destroyed) return;
      const v = inviteView.buildView(res);
      const helping = v.active && !!(res.invitedBy && res.invitedBy.status === 'bound');
      const patch = { invite: v.active ? v : null, inviteHelping: helping };
      // 进刷课页弹一次（每一版活动每台手机一次）；正在帮好友助力的新同学先别打扰
      if (!this._popupChecked && !helping && inviteView.shouldPopup(res, inviteView.popupSeen())) {
        patch.invitePopup = true;
        inviteView.markPopupSeen(res.config.version);
      }
      this._popupChecked = true;
      this.setData(patch);
    } catch (e) { /* 活动读不到不影响刷课 */ }
  },

  onGoInvite() {
    this.setData({ invitePopup: false });
    wx.navigateTo({ url: '/subpackages/study/invite/invite' });
  },

  onCloseInvitePopup() { this.setData({ invitePopup: false }); },
  onCloseInviteNotice() { this.setData({ inviteNotice: null }); },
  noop() {},

  /** 读课程成功后：有待完成的助力时云端会带回结果 */
  showInviteResult(result) {
    const notice = inviteView.scanResultNotice(result);
    if (!notice) return;
    this.setData({ inviteHelping: false, inviteNotice: notice.tone === 'ok' ? null : notice });
    if (notice.tone === 'ok') {
      wx.showModal({
        title: notice.title,
        content: notice.text,
        confirmText: '我也要领',
        cancelText: '知道了',
        success: res => { if (res.confirm) this.onGoInvite(); }
      });
    }
    this.loadInvite();
  },

  onGoMe() { wx.navigateTo({ url: '/subpackages/study/orders/orders' }); },

  onGoRunning() {
    const id = this.data.runningTaskId;
    if (id) wx.navigateTo({ url: '/subpackages/study/progress/progress?taskId=' + encodeURIComponent(id) });
  },

  // ---------- 账号 ----------
  onUsername(e) { this.setData({ username: String(e.detail.value || '').trim() }); },
  onPassword(e) { this.setData({ password: e.detail.value || '' }); },
  onTogglePassword() { this.setData({ showPassword: !this.data.showPassword }); },
  onToggleRemember(e) {
    const remember = !!e.detail.value;
    this.setData({ remember });
    study.saveAccount(this._auth, { username: this.data.username, password: this.data.password, remember });
  },
  onEditAccount() { this.setData({ editingAccount: true, scanError: '' }); },
  onCollapseAccount() { this.setData({ editingAccount: false, scanError: '' }); },

  // ---------- 读取课程 ----------
  onScan() {
    const { username, password, scanning } = this.data;
    if (scanning || !study.isOrderOpen()) return;
    if (!username || !password) {
      this.setData({ editingAccount: true, scanError: '请填写学习通手机号和密码' });
      return;
    }
    const scanId = this._scanId = (this._scanId || 0) + 1;
    this._scanStartedAt = Date.now();
    this.setData({ scanning: true, scanSoft: false, scanError: '', scanText: SCAN_STAGES[0].text + ' · 0 秒' });
    this.startScanTimer(scanId);

    task.scanCourses({ username, password, force: true })
      .then(data => {
        // 用 _destroyed 而非 _alive：隐藏页 setData 合法，按 _alive 早退会让按钮永远卡在读取中
        if (this._destroyed || scanId !== this._scanId) return;
        this.stopScanTimer();
        study.saveAccount(this._auth, { username, password, remember: this.data.remember });
        this.applyCourses((data && data.courses) || [], {});
        this.setData({ scanning: false, scanText: '', editingAccount: false, maskedUser: study.maskPhone(username) });
        if (data && data.invite) this.showInviteResult(data.invite);
      })
      .catch(err => {
        if (this._destroyed || scanId !== this._scanId) return;
        this.stopScanTimer();
        this.setData({ scanning: false, scanText: '', scanError: scanErrorMessage(err) });
      });
  },

  startScanTimer(scanId) {
    this.stopScanTimer();
    const startedAt = this._scanStartedAt || (this._scanStartedAt = Date.now());
    const tick = () => {
      if (this._destroyed || scanId !== this._scanId) return;
      const elapsed = Date.now() - startedAt;
      if (elapsed >= SCAN_HARD_MS) {
        this._scanId += 1;   // 作废这次读取的回调
        this.setData({ scanning: false, scanText: '', scanSoft: false, scanError: scanErrorMessage(new Error('超时')) });
        return;
      }
      let text = SCAN_STAGES[0].text;
      SCAN_STAGES.forEach(s => { if (elapsed >= s.at) text = s.text; });
      this.setData({ scanText: text + ' · ' + Math.floor(elapsed / 1000) + ' 秒', scanSoft: elapsed >= SCAN_SOFT_MS });
      this._scanTimer = setTimeout(tick, 1000);
    };
    this._scanTimer = setTimeout(tick, 1000);
  },

  stopScanTimer() {
    if (this._scanTimer) { clearTimeout(this._scanTimer); this._scanTimer = null; }
  },

  /** 恢复上次选课：直接勾上上次选的课，省一遍点选 */
  onRestoreDraft() {
    const draft = study.loadDraft(this._auth);
    if (!draft || !draft.courses || !draft.courses.length) return;
    const selected = {};
    draft.courses.forEach(c => { selected[c.courseId + '|' + c.clazzId] = true; });
    this.applyCourses(draft.courses, selected);
    const username = draft.username || this.data.username;
    this.setData({
      username,
      maskedUser: study.maskPhone(username),
      // 没记住密码时展开账号区，让用户补填
      editingAccount: !this.data.password
    });
  },

  // ---------- 选课 ----------
  applyCourses(list, selected) {
    const courses = (list || []).map(c => ({
      key: c.courseId + '|' + c.clazzId,
      courseId: String(c.courseId),
      clazzId: String(c.clazzId),
      title: c.title || '未命名课程',
      teacher: c.teacher || '',
      needUnlock: !!c.needUnlock,
      chapterCount: c.jobCount || 0,
      blockedText: blockReason(c)
    }));
    // 不用刷的课沉到最后，其余保持平台顺序
    const usable = courses.filter(c => !c.blockedText);
    const blocked = courses.filter(c => c.blockedText);
    const picked = Object.assign({}, selected || {});
    blocked.forEach(c => { delete picked[c.key]; });
    this.setData({
      scanned: true,
      courses: usable.concat(blocked),
      blockedCount: blocked.length,
      selected: picked
    });
    this.recount();
  },

  onToggleCourse(e) {
    const key = e.currentTarget.dataset.key;
    const course = this.data.courses.find(c => c.key === key);
    if (course && course.blockedText) {
      wx.showToast({ title: course.blockedText, icon: 'none' });
      return;
    }
    const selected = Object.assign({}, this.data.selected);
    if (selected[key]) delete selected[key]; else selected[key] = true;
    this.setData({ selected });
    this.recount();
  },

  onToggleAll() {
    const selected = {};
    if (!this.data.allSelected) this.data.courses.forEach(c => { if (!c.blockedText) selected[c.key] = true; });
    this.setData({ selected });
    this.recount();
  },

  recount() {
    const picked = this.data.courses.filter(c => this.data.selected[c.key] && !c.blockedText);
    const usable = this.data.courses.filter(c => !c.blockedText).length;
    this.setData({
      selectedCount: picked.length,
      allSelected: picked.length > 0 && picked.length === usable,
      unlockSelected: picked.filter(c => c.needUnlock).length
    });
  },

  // ---------- 下一步 ----------
  onNext() {
    if (!study.isOrderOpen()) return;
    const picked = this.data.courses.filter(c => this.data.selected[c.key] && !c.blockedText);
    if (!picked.length) return;
    if (picked.length > task.config.maxCoursesPerTask) {
      wx.showToast({ title: '单次最多 ' + task.config.maxCoursesPerTask + ' 门课', icon: 'none' });
      return;
    }
    const { username, password } = this.data;
    if (!username || !password) {
      this.setData({ editingAccount: true, scanError: '请填写学习通密码' });
      wx.pageScrollTo({ scrollTop: 0, duration: 200 });
      return;
    }
    const courses = picked.map(c => ({
      courseId: c.courseId, clazzId: c.clazzId, title: c.title, teacher: c.teacher, needUnlock: c.needUnlock
    }));
    // 草稿不含密码，只为确认页被系统回收后能恢复
    study.saveDraft(this._auth, { username, courses });
    wx.navigateTo({
      url: '/subpackages/study/confirm/confirm',
      success: res => res.eventChannel.emit('studyDraft', { username, password, courses }),
      fail: () => wx.showToast({ title: '打开失败，请重试', icon: 'none' })
    });
  }
}));
