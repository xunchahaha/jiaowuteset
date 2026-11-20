const assert = require('node:assert/strict');
const { test } = require('node:test');
const view = require('../miniprogram/utils/study-view');

test('进行中：在跑的课排最前，视频 / 测验明细可直接渲染', () => {
  const t = view.decorateTask({
    status: 'running', totalCourses: 3, doneCourses: 1, overallPercent: 42, useTiku: true,
    courses: [
      { courseId: 'a', clazzId: '1', title: '已完成课', status: 'done', total: 10, done: 10 },
      { courseId: 'b', clazzId: '1', title: '在刷课', status: 'running', total: 10, done: 4, percent: 40,
        actives: [
          { kind: 'video', chapter: '1.1', video: { name: 'v.mp4', played: 65, total: 600, percent: 11 } },
          { kind: 'work', chapter: '1.2', work: { total: 10, answered: 8, submitted: true, score: 90 } },
          { kind: 'other', chapter: '1.3' },
          { kind: 'other', chapter: '1.4' }
        ] },
      { courseId: 'c', clazzId: '1', title: '排队课', status: 'queued' }
    ]
  });
  assert.equal(t.headline, '刷课中');
  assert.equal(t.canCancel, true);
  assert.equal(t.costText, '');
  assert.equal(t.courses[0].title, '在刷课');
  const [v, w] = t.courses[0].actives;
  assert.equal(v.detail, '视频 1:05 / 10:00');
  assert.equal(v.percent, 11);
  assert.equal(w.detail, '测验已提交 · 8/10 题 · 90 分');
  assert.equal(t.courses[0].actives.length, 3);
  assert.equal(t.courses[0].activesMore, 1);
});

test('旧报文没有 actives：用单值视频字段退化', () => {
  const c = view.decorateCourse({ courseId: 'a', status: 'running', currentChapter: '第一章',
    videoName: 'x', videoPlayed: 30, videoTotal: 60 });
  assert.equal(c.actives.length, 1);
  assert.equal(c.actives[0].percent, 50);
});

test('终态：写明本单消耗（刷课 + 答题）', () => {
  const t = view.decorateTask({ status: 'done', totalCourses: 2, doneCourses: 2, answeredDoneCourses: 1,
    useTiku: true, courses: [] });
  assert.equal(t.isTerminal, true);
  assert.equal(t.percent, 100);
  assert.equal(t.costText, '本单消耗 3 次（刷课 2 + 答题 1）');
});

test('失败 / 取消：未完成的不扣，文案说清楚', () => {
  const f = view.decorateTask({ status: 'failed', totalCourses: 1, doneCourses: 0, failedCourses: 1,
    error: '超星登录失败: 密码错误', courses: [] });
  assert.equal(f.headline, '刷课失败');
  assert.equal(f.subline, '超星登录失败: 密码错误');
  assert.equal(f.costText, '本单未消耗次数');
  const c = view.decorateTask({ status: 'cancelled', doneCourses: 0, courses: [] });
  assert.match(c.subline, /不扣次数/);
});

test('记录：用课程名而不是 taskId', () => {
  const r = view.decorateRecord({ taskId: 't_1', status: 'done', totalCourses: 3, doneCourses: 3,
    titles: ['数据结构', '操作系统', '计算机网络'], createdAt: Date.now(), useTiku: false });
  assert.equal(r.name, '数据结构、操作系统 等 3 门');
  assert.equal(r.costText, '消耗 3 次');
  assert.equal(r.active, false);
});

test('无需刷的课（0 章节 / 早已完成）：课上标「无需刷」，本单消耗不算它们', () => {
  const t = view.decorateTask({ status: 'done', totalCourses: 3, doneCourses: 3, skippedCourses: 2,
    useTiku: false, courses: [
      { courseId: '1', clazzId: '9', title: '26级高等数学I（A）', status: 'done', total: 0, done: 0,
        skipped: true, skipReason: 'empty', skipText: '平台上这门课没有章节（可能是空壳课或老师还没发布），没刷、不扣次数' },
      { courseId: '2', clazzId: '9', title: '军事理论', status: 'done', total: 45, done: 45,
        skipped: true, skipReason: 'complete', skipText: '这门课的任务点在提交前就已全部完成，没有要刷的，不扣次数' },
      { courseId: '3', clazzId: '9', title: '数据结构', status: 'done', total: 10, done: 10, skipped: false }
    ] });
  assert.equal(t.costText, '本单消耗 1 次');
  assert.equal(t.subline, '1 门课已刷完，2 门不用刷（不扣次数）');
  const byTitle = Object.fromEntries(t.courses.map(c => [c.title, c]));
  assert.equal(byTitle['26级高等数学I（A）'].statusText, '无需刷');
  assert.equal(byTitle['26级高等数学I（A）'].tone, 'muted');
  assert.equal(byTitle['26级高等数学I（A）'].progressText, '0 个章节');
  assert.match(byTitle['26级高等数学I（A）'].note, /没有章节/);
  assert.equal(byTitle['军事理论'].statusText, '无需刷');
  assert.equal(byTitle['数据结构'].statusText, '已完成');
  assert.equal(byTitle['数据结构'].note, '');
});

test('无需刷：全部都不用刷 → 未扣次数，文案说明原因', () => {
  const t = view.decorateTask({ status: 'done', totalCourses: 2, doneCourses: 2, skippedCourses: 2, courses: [] });
  assert.equal(t.costText, '本单未消耗次数');
  assert.match(t.subline, /都不用刷/);
  const r = view.decorateRecord({ taskId: 't_2', status: 'done', totalCourses: 2, doneCourses: 2,
    skippedCourses: 2, titles: ['车辆工程专业概论', '26级高等数学I（A）'], createdAt: Date.now() });
  assert.equal(r.costText, '未扣次数');
});

test('老报文没有 skipped 字段：照旧显示已完成、按 doneCourses 算消耗', () => {
  const t = view.decorateTask({ status: 'done', totalCourses: 1, doneCourses: 1,
    courses: [{ courseId: '1', title: 'A', status: 'done', total: 0, done: 0 }] });
  assert.equal(t.courses[0].statusText, '已完成');
  assert.equal(t.costText, '本单消耗 1 次');
});
