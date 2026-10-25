const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createApi, weekRanges, extractLessons, convertLessons, toCsv, compressWeeks } = require('../scripts/lib/wakeup');
const { exportSchedule } = require('../scripts/export-wakeup');
const semester = { id: '202', code: '2026-2027-1', start_date: '2026-09-07', end_date: '2027-01-24' };
const lesson = (date, extra = {}) => ({ course_name: '示例课程', date, start_unit: 1, end_unit: 2,
  teachers: [{ name: '示例教师' }], rooms: [{ name: '101', building: '教学楼' }], ...extra });

test('整学期含跨年共 20 周，非周一开学和周中结束不越界', () => {
  const ranges = weekRanges(semester.start_date, semester.end_date);
  assert.equal(ranges.length, 20);
  assert.deepEqual(ranges[19], ['2027-01-18', '2027-01-24']);
  assert.deepEqual(weekRanges('2026-09-09', '2026-09-15'), [['2026-09-09', '2026-09-13'], ['2026-09-14', '2026-09-15']]);
  assert.throws(() => weekRanges('2026-02-30', '2026-03-02'));
});
test('按实际日期生成周次，去重，保留间断周、调课和教师地点变化', () => {
  const input = [lesson('2026-09-07'), lesson('2026-09-07'), lesson('2026-09-21'),
    lesson('2026-10-05'), lesson('2026-09-12'), lesson('2026-09-14', { rooms: [{ name: '202' }] }),
    lesson('2026-09-28', { teachers: [{ name: '另一个教师' }] })];
  const result = convertLessons(input, semester, 12);
  assert.equal(result.occurrenceCount, 6);
  assert.equal(result.rows.length, 4);
  assert.equal(result.rows.find(row => row[1] === 1 && row[4] === '示例教师' && row[5] === '101')[6], '1、3、5');
  assert.equal(result.rows.find(row => row[1] === 6)[6], '1');
  assert.equal(compressWeeks([4, 2, 1, 2, 7]), '1-2、4、7');
});
test('缺失教师教室填无，CSV BOM/转义，Excel 公式文本防护', () => {
  const result = convertLessons([lesson('2026-09-07', { course_name: '=例子,"测试"', teachers: [], rooms: [] })], semester, 12);
  assert.deepEqual(result.rows[0].slice(4, 6), ['无', '无']);
  assert.equal(result.rows[0][0][0], "'");
  const csv = toCsv(result.rows);
  assert.ok(csv.startsWith('\uFEFF课程名称,星期,开始节数,结束节数,老师,地点,周数\r\n'));
  assert.ok(csv.includes('""测试""'));
});
test('无效节次、越界日期、空课表和未知响应结构必须显式失败', () => {
  for (const data of [[], [lesson('2026-09-06')], [lesson('2026-09-07', { start_unit: 0 })],
    [lesson('2026-09-07', { end_unit: 13 })], [lesson('2026-09-07', { course_name: '' })]]) {
    assert.throws(() => convertLessons(data, semester, 12));
  }
  assert.throws(() => extractLessons({ unexpected: [] }));
  assert.deepEqual(extractLessons({ day_lessons: [{ date: '2026-09-07', lessons: [{ course_name: '示例' }] }] }),
    [{ date: '2026-09-07', course_name: '示例' }]);
});
test('复用原 API 的签名与解码；日志仅输出状态，不泄露凭据', async () => {
  const reports = [], calls = [];
  const api = createApi(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ err_code: '00000',
      business_data: Buffer.from(JSON.stringify({ token: 'FIXTURE_TOKEN', secret: 'FIXTURE_SECRET' })).toString('base64') }) };
  }, event => reports.push(event));
  const auth = await api.login('FIXTURE_USER', 'FIXTURE_PASSWORD');
  assert.equal(auth.token, 'FIXTURE_TOKEN');
  assert.equal(calls[0].options.redirect, 'error');
  assert.match(calls[0].options.body, /&sign=[A-F0-9]{32}/);
  assert.ok(!JSON.stringify(reports).includes('FIXTURE'));
  const bad = createApi(async () => ({ ok: true, status: 200,
    json: async () => ({ err_code: '12345', err_msg: 'FIXTURE_SECRET' }) }));
  await assert.rejects(bad.login('a', 'b'), error => !error.message.includes('FIXTURE_SECRET'));
});
test('整学期串行读取，优先当前学期；失败时不生成部分导出', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wakeup-test-'));
  const selected = { ...semester, end_date: '2026-09-20' };
  const seen = [];
  const api = {
    login: async () => ({ token: 'FIXTURE_TOKEN', secret: 'FIXTURE_SECRET', user_info: { biz_type_infos: [{ id: '1' }] } }),
    getSemesters: async () => ({ cur_semester_id: '202', semesters: [{ ...selected, id: '222' }, selected] }),
    getMaxUnit: async () => ({ max_unit: 12 }),
    getCourseTables: async (_auth, _biz, id, start, end) => { seen.push([id, start, end]); return [lesson(start)]; }
  };
  const result = await exportSchedule({ username: 'FIXTURE_USER', password: 'FIXTURE_PASSWORD', outputRoot: root, api, pauseMs: 0 });
  assert.equal(result.occurrenceCount, 2);
  assert.equal(result.rows[0][6], '1-2');
  assert.deepEqual(seen.map(row => row[0]), ['202', '202']);
  const summary = await fs.readFile(path.join(result.directory, 'export-summary.json'), 'utf8');
  assert.ok(!/FIXTURE_(TOKEN|SECRET|USER|PASSWORD)/.test(summary));
  const before = await fs.readdir(root);
  api.getCourseTables = async () => { throw new Error('fixture network failure'); };
  await assert.rejects(exportSchedule({ username: 'a', password: 'b', outputRoot: root, api, pauseMs: 0 }));
  assert.deepEqual(await fs.readdir(root), before);
  // Deliberately retain this small temp fixture rather than risk broad cleanup.
});
