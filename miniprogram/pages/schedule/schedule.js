const api = require('../../utils/api');
const reminderPlanCache = require('../../utils/notification-plan-cache');
const { prepareWakeup, shareWakeup } = require('../../utils/wakeup-export');
const { withPageShare } = require('../../utils/share');
const { formatDayLabel, lessonRowsForDate } = require('../../utils/share-card');
const { buildScopedCacheKey, loadWithCache } = require('../../utils/cache');
const {
  DEFAULT_TIME_SLOTS,
  ROW_HEIGHT,
  formatDate,
  parseDateValue,
  addDays,
  pickSemesterInfo,
  getWeekStartKey,
  getWeekLabel,
  getWeekRange,
  buildWeekPayload
} = require('../../utils/schedule-week');

const LESSON_DETAIL_KEY = 'currentLessonDetail';
const TIME_COL_WIDTH = 96;

function getPrimaryBizTypeId(auth) {
  return auth && auth.bizTypes && auth.bizTypes.length ? auth.bizTypes[0].id : '';
}

Page(withPageShare({
  data: {
    exportingWakeup: false,
    loading: false,
    error: '',
    weekLabel: '',
    anchorDate: '',
    weekDays: [],
    timeSlots: [],
    dayColumns: [],
    extraLessons: [],
    gridHeight: ROW_HEIGHT * DEFAULT_TIME_SLOTS.length,
    rowHeight: ROW_HEIGHT,
    timeColWidth: TIME_COL_WIDTH,
    showCacheBanner: false,
    cacheNotice: ''
  },

  onScheduleMore() {
    if (this._wakeupRun) return;
    const auth = wx.getStorageSync('auth');
    const ready = this._wakeupReady && auth && this._wakeupReady.token === auth.token;
    if (!ready) this._wakeupReady = null;
    wx.showActionSheet({ itemList: ready ? ['重新转发已生成 CSV', '重新读取并导出', '通知中心 · 课前提醒'] : ['导出 WakeUp CSV', '通知中心 · 课前提醒'], success: res => {
      if (res.tapIndex === (ready ? 2 : 1)) this.openNotifications();
      else if (res.tapIndex === 0 || (ready && res.tapIndex === 1)) this.onExportWakeup(ready && res.tapIndex === 0);
    } });
  },

  openNotifications() {
    wx.navigateTo({ url: '/subpackages/notifications/center/center' });
  },

  async onExportWakeup(reuse = false) {
    if (this._wakeupRun) return;
    if (typeof wx.shareFileMessage !== 'function') {
      wx.showModal({ title: '请升级微信', content: '当前微信版本暂不支持文件转发，请升级后再试。', showCancel: false });
      return;
    }
    const auth = wx.getStorageSync('auth');
    if (!auth || !auth.token || auth.offline) {
      wx.showToast({ title: '请联网登录后导出', icon: 'none' });
      return;
    }
    const run = { phase: 'preparing' };
    this._wakeupRun = run;
    const check = () => {
      const current = wx.getStorageSync('auth');
      if (this._wakeupRun !== run || !current || current.token !== auth.token || current.offline) {
        throw new Error('导出已中止');
      }
    };
    let loading = false;
    const stopLoading = () => {
      if (loading && this._wakeupRun === run) wx.hideLoading();
      loading = false;
    };
    try {
      const cached = reuse === true && this._wakeupReady && this._wakeupReady.token === auth.token ? this._wakeupReady.result : null;
      const confirmed = cached || await new Promise(resolve => wx.showModal({ title: '导出 WakeUp 课表',
        content: '将读取当前学期全部课程并生成 CSV，然后选择微信会话发送。文件包含课程和任课教师信息，请确认接收人。',
        confirmText: '开始导出', success: res => resolve(res.confirm), fail: () => resolve(false) }));
      if (!confirmed) return;
      check();
      this.setData({ exportingWakeup: true });
      if (!cached) this._wakeupReady = null;
      if (!cached) { loading = true; wx.showLoading({ title: '准备导出…', mask: true }); }
      const result = cached || await prepareWakeup(api, auth, { check,
        progress: (index, total) => wx.showLoading({ title: `读取第 ${index}/${total} 周`, mask: true }) });
      check();
      this._wakeupReady = { token: auth.token, result };
      stopLoading();
      run.phase = 'sharing';
      const status = await shareWakeup(wx, result, check);
      check();
      wx.showToast({ title: status === 'shared' ? '请在聊天确认发送结果' : status === 'cancelled' ? '已取消转发' : '转发失败，请重试', icon: 'none' });
      if (status === 'shared') wx.showModal({ title: 'WakeUp 导入说明', showCancel: false,
        content: `请选择 Excel/CSV 导入；开学日期 ${result.firstMonday}，每天 ${result.maxUnit} 节。上下课时间需自行核对。` });
    } catch (error) {
      stopLoading();
      if (this._wakeupRun === run) wx.showModal({ title: '导出未完成', showCancel: false,
        content: `失败阶段：${error.exportStage || (run.phase === 'sharing' ? '写入或转发文件' : '读取课表')}。\n${error.nativeDetail || '请检查网络、课表数据和微信版本。'}\n${this._wakeupReady ? 'CSV 已生成，可在“更多”中重新转发，无需重新读取。' : '本次未生成完整 CSV。'}` });
    } finally {
      if (this._wakeupRun === run) {
        stopLoading();
        this._wakeupRun = null;
        this.setData({ exportingWakeup: false });
      }
    }
  },

  onUnload() {
    this._wakeupReady = null;
    if (this._wakeupRun) wx.hideLoading();
    this._wakeupRun = null;
  },

  onHide() {
    // Sharing opens native UI; only cancel when leaving during data preparation.
    if (this._wakeupRun && this._wakeupRun.phase === 'preparing') {
      this._wakeupRun = null;
      wx.hideLoading();
      this.setData({ exportingWakeup: false });
    }
  },

  getTodayLessonTypeCount() {
    const today = formatDate(new Date());
    const todayColumn = (this.data.dayColumns || []).find((item) => item && item.date === today);
    if (!todayColumn || !Array.isArray(todayColumn.lessons)) {
      return 0;
    }
    const names = {};
    todayColumn.lessons.forEach((lesson) => {
      const courseName = lesson && lesson.courseName ? String(lesson.courseName).trim() : '';
      if (courseName) {
        names[courseName] = true;
      }
    });
    return Object.keys(names).length;
  },

  onLoad(options) {
    if (options && options.anchorDate) {
      const anchorDate = parseDateValue(options.anchorDate);
      if (anchorDate) {
        this.setData({
          anchorDate: formatDate(anchorDate)
        });
      }
    }
  },

  getShareOptions() {
    return {
      anchorDate: this.data.anchorDate || ''
    };
  },

  getScheduleShareConfig() {
    return {
      title: '今日我有' + this.getTodayLessonTypeCount() + '节课'
    };
  },

  getShareConfig() {
    return this.getScheduleShareConfig();
  },

  getShareCard() {
    const now = new Date();
    const today = formatDate(now);
    const columns = this.data.dayColumns || [];
    if (!columns.some((item) => item && item.date === today)) {
      return {
        theme: 'blue',
        eyebrow: '我的课表',
        headline: this.data.weekLabel ? this.data.weekLabel + '课表' : '我的课表',
        sub: '点开查看整周课程安排'
      };
    }
    const count = this.getTodayLessonTypeCount();
    const rows = lessonRowsForDate(columns, today);
    return {
      theme: 'blue',
      eyebrow: '今日课表',
      headline: count ? '今天有 ' + count + ' 节课' : '今天没有课',
      sub: formatDayLabel(now) + (this.data.weekLabel ? ' · ' + this.data.weekLabel : ''),
      rows,
      note: rows.length ? '' : '难得清闲，安排点自己的事吧'
    };
  },

  getTimelineShareConfig() {
    return this.getScheduleShareConfig();
  },

  applySchedulePayload(payload, meta) {
    const source = payload || {};
    const notice = meta && meta.notice ? meta.notice : '';
    this.setData({
      loading: false,
      error: '',
      weekLabel: source.weekLabel || '',
      anchorDate: source.anchorDate || '',
      weekDays: source.weekDays || [],
      timeSlots: source.timeSlots || [],
      dayColumns: source.dayColumns || [],
      extraLessons: source.extraLessons || [],
      gridHeight: source.gridHeight || (ROW_HEIGHT * DEFAULT_TIME_SLOTS.length),
      showCacheBanner: !!notice,
      cacheNotice: notice
    });
    if (this.refreshShareCard) {
      this.refreshShareCard();
    }
  },

  onShow() {
    const anchorDate = this.data.anchorDate || formatDate(new Date());
    if (!this.data.anchorDate) {
      this.setData({
        anchorDate
      });
    }
    this.loadSchedule(anchorDate);
  },

  prevWeek() {
    this.shiftWeek(-7);
  },

  nextWeek() {
    this.shiftWeek(7);
  },

  openLessonDetail(lesson) {
    if (!lesson) {
      return;
    }
    wx.setStorageSync(LESSON_DETAIL_KEY, {
      courseName: lesson.courseName,
      place: lesson.place,
      unitText: lesson.unitText,
      timeLabel: lesson.timeLabel,
      teacher: lesson.teacher,
      lessonId: lesson.id
    });
    wx.navigateTo({
      url: '/pages/lesson-detail/lesson-detail'
    });
  },

  onTapLesson(e) {
    const dayIndex = parseInt(e.currentTarget.dataset.dayIndex, 10);
    const lessonIndex = parseInt(e.currentTarget.dataset.lessonIndex, 10);
    const day = this.data.dayColumns[dayIndex];
    const lesson = day && day.lessons ? day.lessons[lessonIndex] : null;
    this.openLessonDetail(lesson);
  },

  onTapExtraLesson(e) {
    const lessonIndex = parseInt(e.currentTarget.dataset.lessonIndex, 10);
    this.openLessonDetail(this.data.extraLessons[lessonIndex]);
  },

  ensureSemesterInfo(auth, bizTypeId, anchorDateStr) {
    const authCache = auth || {};
    if (this._semesterInfo && String(this._semesterBizTypeId) === String(bizTypeId)) {
      return Promise.resolve(this._semesterInfo);
    }
    return api.getSemesters(authCache, bizTypeId).then((data) => {
      const info = pickSemesterInfo(data, anchorDateStr);
      if (info.id) {
        this._semesterInfo = info;
        this._semesterBizTypeId = bizTypeId;
        authCache.semesterId = info.id;
        authCache.semesterStart = info.startDate ? formatDate(info.startDate) : '';
        authCache.semesterEnd = info.endDate ? formatDate(info.endDate) : '';
        wx.setStorageSync('auth', authCache);
      }
      return info;
    }).catch((err) => {
      const semesterId = authCache.semesterId || (authCache.userInfo && (authCache.userInfo.semester_id || authCache.userInfo.semesterId));
      if (!semesterId) {
        throw err;
      }
      return {
        id: semesterId,
        startDate: parseDateValue(authCache.semesterStart),
        endDate: parseDateValue(authCache.semesterEnd)
      };
    });
  },

  shiftWeek(diffDays) {
    const current = this.data.anchorDate ? new Date(this.data.anchorDate) : new Date();
    const next = addDays(current, diffDays);
    const anchorDate = formatDate(next);
    this.setData({
      anchorDate
    });
    this.loadSchedule(anchorDate);
  },

  // 没联网拿到学期信息时，用上次存下的学期起止日期推算周次。
  getKnownSemesterInfo(auth) {
    if (this._semesterInfo) {
      return this._semesterInfo;
    }
    return {
      id: auth.semesterId || '',
      startDate: parseDateValue(auth.semesterStart),
      endDate: parseDateValue(auth.semesterEnd)
    };
  },

  loadSchedule(anchorDateOverride) {
    const auth = wx.getStorageSync('auth');
    if (!auth || !auth.token || !auth.secret) {
      wx.reLaunch({
        url: '/pages/login/login'
      });
      return;
    }

    const bizTypeId = getPrimaryBizTypeId(auth);
    if (!bizTypeId) {
      this.setData({
        loading: false,
        error: '未找到可用的业务类型',
        dayColumns: [],
        weekDays: [],
        showCacheBanner: false,
        cacheNotice: ''
      });
      return;
    }

    const anchorDateStr = anchorDateOverride || this.data.anchorDate || formatDate(new Date());
    const knownSemester = this.getKnownSemesterInfo(auth);
    const guessRange = getWeekRange(knownSemester, anchorDateStr);
    const weekKey = (weekStart) => buildScopedCacheKey('schedule-week', auth, weekStart);
    const loadId = this._scheduleLoadId = (this._scheduleLoadId || 0) + 1;
    const isActive = () => this._scheduleLoadId === loadId;

    this.setData({
      loading: true,
      error: '',
      showCacheBanner: false,
      cacheNotice: ''
    });

    return loadWithCache({
      key: weekKey(getWeekStartKey(guessRange.anchor)),
      writeKey: (payload) => weekKey(payload.weekDays[0].date),
      offline: !!auth.offline,
      offlineMessage: '离线模式，这一周的课表还没有缓存过',
      isActive,
      fetch: () => this.ensureSemesterInfo(auth, bizTypeId, anchorDateStr).then((semesterInfo) => {
        const info = semesterInfo || { id: '' };
        if (!info.id) {
          throw new Error('未获取到学期信息');
        }
        const range = getWeekRange(info, anchorDateStr);
        return api.getMaxUnit(auth, bizTypeId)
          .catch(() => ({}))
          .then((maxData) => api.getCourseTables(auth, bizTypeId, info.id, formatDate(range.start), formatDate(range.end))
            .then((data) => {
              // A cache/storage issue must never break the visible course page.
              try { reminderPlanCache.observeWeek(wx, auth, info.id, formatDate(range.start), data); } catch (_) {}
              return buildWeekPayload(info, range.anchor, maxData, data);
            }));
      }),
      apply: (payload, meta) => this.applySchedulePayload(payload, meta),
      setNotice: (notice) => this.setData({
        showCacheBanner: !!notice,
        cacheNotice: notice
      }),
      onError: (err) => this.setData({
        loading: false,
        error: err.message || '课表加载失败',
        weekLabel: knownSemester.startDate
          ? getWeekLabel(knownSemester.startDate, guessRange.start)
          : (formatDate(guessRange.start).slice(5) + ' 起'),
        dayColumns: [],
        weekDays: [],
        extraLessons: [],
        showCacheBanner: false,
        cacheNotice: ''
      })
    });
  }
}));
