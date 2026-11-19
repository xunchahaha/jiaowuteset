/**
 * 刷课进度的展示映射（纯函数，可单测）：服务端报文 -> 页面直接渲染的结构。
 * 对缺字段一律兼容退化，绝不因旧报文白屏。
 */
const study = require('./study');

const TERMINAL = ['done', 'failed', 'cancelled'];

/** tone 对应 study.wxss 里的 .tone-xxx 配色 */
const TASK_STATUS = {
  queued: { text: '排队中', tone: 'muted' },
  running: { text: '刷课中', tone: 'brand' },
  done: { text: '已完成', tone: 'ok' },
  failed: { text: '部分失败', tone: 'danger' },
  cancelled: { text: '已取消', tone: 'muted' },
  paused_tiku: { text: '已暂停', tone: 'warn' }
};

const COURSE_STATUS = {
  queued: { text: '排队中', tone: 'muted' },
  running: { text: '刷课中', tone: 'brand' },
  done: { text: '已完成', tone: 'ok' },
  failed: { text: '失败', tone: 'danger' },
  cancelled: { text: '已取消', tone: 'muted' },
  paused_tiku: { text: '已暂停', tone: 'warn' }
};

/** 每门课最多展示几条「正在处理的章节」 */
const MAX_ACTIVES = 3;

function taskStatus(s) { return TASK_STATUS[s] || TASK_STATUS.queued; }
function courseStatus(s) { return COURSE_STATUS[s] || COURSE_STATUS.queued; }
function isTerminal(s) { return TERMINAL.indexOf(s) >= 0; }

function clampPercent(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** 秒 -> 「3:05」「1:02:09」 */
function clock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = v => String(v).padStart(2, '0');
  return (h ? h + ':' + p(m) : String(m)) + ':' + p(s % 60);
}

/** 一条在跑章节 -> { key, kind, title, detail, percent }（percent<0 表示不画进度条） */
function decorateActive(a, idx) {
  const kind = (a && a.kind) || 'other';
  const chapter = (a && a.chapter) || '';
  const out = { key: kind + ':' + chapter + ':' + idx, kind, title: chapter || '章节', detail: '准备中…', percent: -1 };
  if (kind === 'video') {
    const v = (a && a.video) || {};
    const total = Number(v.total) || 0;
    const played = Number(v.played) || 0;
    out.title = v.name || chapter || '视频';
    out.percent = (v.percent == null || Number(v.percent) < 0)
      ? (total ? clampPercent(played * 100 / total) : 0)
      : clampPercent(v.percent);
    out.detail = '视频 ' + clock(played) + ' / ' + clock(total);
  } else if (kind === 'work') {
    const w = (a && a.work) || {};
    const total = Number(w.total) || 0;
    const answered = Number(w.answered) || 0;
    if (w.submitted) {
      const hasScore = w.score !== undefined && w.score !== null && w.score !== '';
      out.detail = '测验已提交 · ' + answered + '/' + total + ' 题' +
        (hasScore ? ' · ' + Math.round(Number(w.score)) + ' 分' : '');
      out.percent = 100;
    } else {
      out.detail = '正在答题' + (total ? '（共 ' + total + ' 题）' : '…');
      out.percent = total ? clampPercent(answered * 100 / total) : -1;
    }
  }
  return out;
}

function decorateCourse(c) {
  const st = courseStatus(c.status);
  let actives = (Array.isArray(c.actives) ? c.actives : []).map(decorateActive);
  // 旧报文没有 actives：用单值视频字段 / 当前章节退化出一条
  if (!actives.length && c.status === 'running') {
    const vt = Number(c.videoTotal) || 0;
    if (vt > 0) {
      actives = [decorateActive({ kind: 'video', chapter: c.currentChapter,
        video: { name: c.videoName, played: c.videoPlayed, total: vt, percent: c.videoPercent } }, 0)];
    } else if (c.currentChapter) {
      actives = [decorateActive({ kind: 'other', chapter: c.currentChapter }, 0)];
    }
  }
  const total = Number(c.total) || 0;
  const done = Number(c.done) || 0;
  return {
    key: c.courseId + '|' + (c.clazzId || ''),
    title: c.title || '未命名课程',
    teacher: c.teacher || '',
    status: c.status,
    statusText: st.text,
    tone: st.tone,
    percent: c.status === 'done' ? 100 : clampPercent(c.percent != null ? c.percent : (total ? done * 100 / total : 0)),
    progressText: total ? done + '/' + total + ' 章' : '',
    answered: !!c.answered,
    actives: actives.slice(0, MAX_ACTIVES),
    activesMore: Math.max(0, actives.length - MAX_ACTIVES),
    error: c.status === 'failed' ? (c.lastError || '') : ''
  };
}

/** 进度页整体视图 */
function decorateTask(p) {
  const payload = p || {};
  const status = payload.status || 'queued';
  const st = taskStatus(status);
  const courses = (payload.courses || []).map(decorateCourse);
  // 在跑的排前面，其余保持提交顺序
  const order = { running: 0, paused_tiku: 1, queued: 2, failed: 3, done: 4, cancelled: 5 };
  courses.sort((a, b) => (order[a.status] == null ? 9 : order[a.status]) - (order[b.status] == null ? 9 : order[b.status]));
  const total = Number(payload.totalCourses) || courses.length;
  const done = Number(payload.doneCourses) || 0;
  const failed = Number(payload.failedCourses) || 0;
  const running = courses.filter(c => c.status === 'running').length;

  let headline = st.text;
  let subline = '';
  if (status === 'queued') {
    headline = '排队中';
    subline = '马上开始，可以先退出，刷完会通知你';
  } else if (status === 'running') {
    headline = '刷课中';
    subline = '已完成 ' + done + '/' + total + ' 门' + (running > 1 ? ' · ' + running + ' 门同时在刷' : '');
  } else if (status === 'done') {
    headline = '全部完成';
    subline = total + ' 门课已刷完';
  } else if (status === 'failed') {
    headline = done ? '部分课程失败' : '刷课失败';
    subline = payload.error || ('完成 ' + done + ' 门，失败 ' + failed + ' 门（失败的不扣次数）');
  } else if (status === 'cancelled') {
    headline = '已取消';
    subline = done ? '取消前已完成 ' + done + ' 门' : '未完成的课程不扣次数';
  } else if (status === 'paused_tiku') {
    headline = '已暂停';
    subline = '答题次数达到上限，已刷部分保留';
  }

  const terminal = isTerminal(status);
  const cost = study.taskCost({ doneCourses: done, answeredDoneCourses: payload.answeredDoneCourses, useTiku: payload.useTiku });
  return {
    status,
    statusText: st.text,
    tone: st.tone,
    headline,
    subline,
    percent: status === 'done' ? 100 : clampPercent(payload.overallPercent),
    total,
    done,
    failed,
    useTiku: !!payload.useTiku,
    courses,
    isTerminal: terminal,
    isPaused: status === 'paused_tiku',
    canCancel: !terminal,
    costText: terminal
      ? (cost.total
        ? '本单消耗 ' + cost.total + ' 次' + (cost.answered ? '（刷课 ' + cost.done + ' + 答题 ' + cost.answered + '）' : '')
        : '本单未消耗次数')
      : ''
  };
}

/** 记录列表的一条 */
function decorateRecord(t, now) {
  const st = taskStatus(t.status);
  const titles = (t.titles || []).filter(Boolean);
  const total = Number(t.totalCourses) || titles.length;
  const name = titles.length
    ? titles.slice(0, 2).join('、') + (total > 2 ? ' 等 ' + total + ' 门' : '')
    : total + ' 门课程';
  const cost = study.taskCost(t);
  return {
    taskId: String(t.taskId),
    name,
    statusText: st.text,
    tone: st.tone,
    percent: t.status === 'done' ? 100 : clampPercent(t.overallPercent),
    progressText: (Number(t.doneCourses) || 0) + '/' + total + ' 门',
    timeText: study.formatTime(t.createdAt, now),
    costText: isTerminal(t.status) ? (cost.total ? '消耗 ' + cost.total + ' 次' : '未扣次数') : '',
    active: !isTerminal(t.status)
  };
}

module.exports = {
  TERMINAL,
  taskStatus,
  courseStatus,
  isTerminal,
  clock,
  decorateActive,
  decorateCourse,
  decorateTask,
  decorateRecord
};
