const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { prepareWakeup, shareWakeup } = require('../miniprogram/utils/wakeup-export');
const { convertLessons } = require('../miniprogram/utils/wakeup-csv');
const auth = { token: 'fixture', secret: 'fixture', bizTypes: [{ id: '1' }] };
const semester = { id: '202', code: '2026-2027-1', start_date: '2026-09-07', end_date: '2026-09-20' };
const lesson = date => ({ course_name: '示例课', date, start_unit: 1, end_unit: 2,
  rooms: [{ name: '综合教学楼(F2座) F2-318', building: '综合教学楼(F2座)' }], teachers: [] });
function fakeApi() {
  return { getSemesters: async () => ({ cur_semester_id: '202', semesters: [semester] }),
    getMaxUnit: async () => ({ max_unit: 12 }), getCourseTables: async (a, b, id, start) => [lesson(start)] };
}
function fakeWx(status = 'success') {
  const events = [];
  const wx = { env: { USER_DATA_PATH: 'wxfile://usr' },
    showModal: options => { events.push(['confirm']); options.success({ confirm: true }); },
    getFileSystemManager: () => ({ writeFile: options => {
      events.push(['write', options]);
      status === 'writeError' ? options.fail() : options.success();
    }, unlink: options => events.push(['unlink', options.filePath]) }),
    shareFileMessage: options => { events.push(['share', options]);
      if (status === 'success') options.success();
      else options.fail({ errMsg: status === 'cancel' ? 'shareFileMessage:fail cancel' : 'shareFileMessage:fail system error' });
    } };
  return { wx, events };
}

test('小程序导出整学期，七列 CSV 仅保留教室编号', async () => {
  const progress = [];
  const result = await prepareWakeup(fakeApi(), auth, { progress: (...v) => progress.push(v) });
  assert.equal(result.count, 2);
  assert.equal(result.queriedWeeks, 2);
  assert.equal(result.totalWeeks, 2);
  assert.equal(result.rowCount, 1);
  assert.equal(result.firstMonday, '2026-09-07');
  assert.match(result.csv, /,F2-318,1-2/);
  assert.ok(!result.csv.includes('综合教学楼'));
  assert.equal(progress.length, 2);
  const rows = convertLessons([{ ...lesson('2026-09-07'), rooms: [{ name: 'E5-511' }, { name: 'F2-318' }] }], semester, 12).rows;
  assert.equal(rows[0][5], 'E5-511、F2-318');
});
test('离线、请求中断、日期越界不产出部分 CSV', async () => {
  await assert.rejects(prepareWakeup(fakeApi(), { ...auth, offline: true }));
  const api = fakeApi(); let n = 0;
  api.getCourseTables = async () => { if (++n === 2) throw Error('network'); return [lesson('2026-09-07')]; };
  await assert.rejects(prepareWakeup(api, auth));
  let checks = 0;
  await assert.rejects(prepareWakeup(fakeApi(), auth, { check() { if (++checks === 3) throw Error('cancel'); } }));
  api.getCourseTables = async () => [lesson('2026-09-21')];
  await assert.rejects(prepareWakeup(api, auth));
});
test('写 UTF-8 CSV，交给微信后成功/取消/失败均保留源文件供后台发送', async () => {
  for (const [status, expected] of [['success', 'shared'], ['cancel', 'cancelled']]) {
    const { wx, events } = fakeWx(status);
    assert.equal(await shareWakeup(wx, { csv: '\uFEFF课程名称', fileName: 'WakeUp.csv' }), expected);
    assert.deepEqual(events.map(e => e[0]), ['write', 'confirm', 'share']);
    assert.equal(events[0][1].encoding, 'utf8');
    assert.equal(events[0][1].filePath, events[2][1].filePath);
    assert.equal(events[2][1].fileName, 'WakeUp.csv');
  }
  const { wx, events } = fakeWx('writeError');
  await assert.rejects(shareWakeup(wx, { csv: 'test' }));
  assert.deepEqual(events.map(e => e[0]), ['write', 'unlink']);
  const failed = fakeWx('error');
  await assert.rejects(shareWakeup(failed.wx, { csv: 'test' }), error =>
    error.exportStage === '转发文件' && error.nativeDetail.includes('system error'));
  assert.ok(!failed.events.some(e => e[0] === 'unlink'));
  const cancelledBeforeSharing = fakeWx();
  cancelledBeforeSharing.wx.showModal = o => o.success({ confirm: false });
  await shareWakeup(cancelledBeforeSharing.wx, { csv: 'test' });
  assert.deepEqual(cancelledBeforeSharing.events.map(e => e[0]), ['write', 'unlink']);
});

function loadPage(options = {}) {
  const filename = path.resolve(__dirname, '../miniprogram/pages/schedule/schedule.js');
  const localRequire = createRequire(filename);
  let page, current = { ...auth, offline: options.offline }, prepares = 0;
  const notices = [], modals = [], uiEvents = [];
  const wx = { getStorageSync: () => current, showToast: o => notices.push(o.title),
    shareFileMessage() {}, showLoading() {}, hideLoading() { uiEvents.push('hideLoading'); }, showActionSheet: o => o.success({ tapIndex: 0 }),
    showModal: o => { uiEvents.push('modal'); modals.push(o); if (o.success) o.success({ confirm: options.confirm !== false }); } };
  if (options.unsupported) delete wx.shareFileMessage;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: p => { page = p; }, wx, console, setTimeout, clearTimeout,
    require: name => name.endsWith('/wakeup-export') ? {
      prepareWakeup: async (...args) => { prepares++; return options.prepare ? options.prepare(...args) : { firstMonday: '2026-09-07', maxUnit: 12 }; },
      shareWakeup: async () => { if (options.shareError) throw options.shareError; return options.status || 'shared'; }
    } : name.endsWith('/share') ? { withPageShare: p => p } : localRequire(name)
  });
  page.setData = values => Object.assign(page.data, values);
  return { page, notices, modals, uiEvents, setAuth: a => { current = a; }, prepares: () => prepares };
}
test('页面按钮成功、取消、旧微信、离线与重复点击处理', async () => {
  const good = loadPage(); await good.page.onExportWakeup();
  assert.equal(good.notices[0], '请在聊天确认发送结果'); assert.equal(good.page.data.exportingWakeup, false);
  for (const option of [{ confirm: false }, { unsupported: true }, { offline: true }]) {
    const p = loadPage(option); await p.page.onExportWakeup(); assert.equal(p.prepares(), 0);
  }
  const cancelled = loadPage({ status: 'cancelled' }); await cancelled.page.onExportWakeup();
  assert.equal(cancelled.notices[0], '已取消转发');
  let finish;
  const slow = loadPage({ prepare: () => new Promise(resolve => { finish = resolve; }) });
  const pending = slow.page.onExportWakeup(); await Promise.resolve();
  await slow.page.onExportWakeup(); assert.equal(slow.prepares(), 1);
  slow.page.onUnload(); finish({ firstMonday: '2026-09-07', maxUnit: 12 }); await pending;
  assert.equal(slow.notices.length, 0);
  let finishHidden;
  const hidden = loadPage({ prepare: () => new Promise(resolve => { finishHidden = resolve; }) });
  const hiddenPending = hidden.page.onExportWakeup(); await Promise.resolve();
  hidden.page.onHide(); finishHidden({ firstMonday: '2026-09-07', maxUnit: 12 }); await hiddenPending;
  assert.equal(hidden.notices.length, 0);
  assert.equal(hidden.page.data.exportingWakeup, false);
  const sharing = loadPage(); sharing.page._wakeupRun = { phase: 'sharing' };
  sharing.page.onHide(); assert.ok(sharing.page._wakeupRun);
});

test('转发失败保留具体错误并弹窗；重新转发不重读；不再用hideLoading覆盖结果提示', async () => {
  const p = loadPage({ shareError: { exportStage: '转发文件', nativeDetail: 'shareFileMessage:fail not supported' } });
  await p.page.onExportWakeup();
  assert.match(p.modals.at(-1).content, /not supported/);
  assert.equal(p.uiEvents.at(-1), 'modal');
  await p.page.onExportWakeup(true);
  assert.equal(p.prepares(), 1);
  p.setAuth({ ...auth, token: 'another-account' });
  await p.page.onExportWakeup(true);
  assert.equal(p.prepares(), 2);
});

test('低频导出入口位于课表底部更多菜单，不占用顶部课表区域', () => {
  const markup = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/schedule/schedule.wxml'), 'utf8');
  assert.ok(markup.indexOf('schedule-actions') > markup.indexOf('未分组课程'));
  assert.ok(!markup.includes('wakeup-export-hint'));
  assert.match(markup, /bindtap="onScheduleMore"/);
});

test('取消后的旧请求返回不隐藏新导出的进度', async () => {
  const finishes = [];
  const p = loadPage({ prepare: () => new Promise(resolve => finishes.push(resolve)) });
  const old = p.page.onExportWakeup(); await Promise.resolve();
  p.page.onHide();
  const next = p.page.onExportWakeup(); await Promise.resolve();
  const hidden = p.uiEvents.filter(e => e === 'hideLoading').length;
  finishes[0]({ firstMonday: '2026-09-07', maxUnit: 12 }); await old;
  assert.equal(p.uiEvents.filter(e => e === 'hideLoading').length, hidden);
  assert.equal(p.page.data.exportingWakeup, true);
  finishes[1]({ firstMonday: '2026-09-07', maxUnit: 12 }); await next;
});

test('完整查询20周，包括空的第20周；合并行数不代表只查询一周', async () => {
  const api = fakeApi(), calls = [];
  api.getSemesters = async () => ({ cur_semester_id: '202', semesters: [{ ...semester, end_date: '2027-01-24' }] });
  api.getCourseTables = async (a, b, id, start, end) => {
    calls.push([start, end]);
    return calls.length === 20 ? [] : [lesson(start)];
  };
  const result = await prepareWakeup(api, auth);
  assert.equal(calls.length, 20);
  assert.deepEqual(calls[19], ['2027-01-18', '2027-01-24']);
  assert.equal(result.queriedWeeks, 20);
  assert.equal(result.totalWeeks, 20);
  assert.equal(result.weekCounts[19].count, 0);
  assert.equal(result.count, 19);
  assert.equal(result.rowCount, 1);
  assert.match(result.csv, /,F2-318,1-19/);
});
