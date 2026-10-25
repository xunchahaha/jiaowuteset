'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { pickCurrentSemesterItem } = require('../miniprogram/utils/semester');
const { createApi, weekRanges, extractLessons, convertLessons, toCsv, dateNumber } = require('./lib/wakeup');

async function exportSchedule({ username, password, outputRoot, report = () => {}, api = createApi(), pauseMs = 200 }) {
  if (!username || !password) throw new Error('请通过启动脚本输入账号和密码');
  const login = await api.login(username, password);
  const auth = { token: login?.token, secret: login?.secret };
  const biz = login?.user_info?.biz_type_infos?.[0]?.id;
  if (!auth.token || !auth.secret || !biz) throw new Error('登录响应缺少必要字段');
  report('登录成功');
  const semesters = await api.getSemesters(auth, biz);
  const semester = pickCurrentSemesterItem(semesters, new Date());
  if (!semester?.id) throw new Error('未找到当前学期');
  const ranges = weekRanges(semester.start_date, semester.end_date);
  const max = await api.getMaxUnit(auth, biz);
  const maxUnit = Number(max?.max_unit);
  if (!Number.isInteger(maxUnit) || maxUnit < 1) throw new Error('节次接口返回异常');
  const lessons = [];
  for (let i = 0; i < ranges.length; i++) {
    const [start, end] = ranges[i];
    const batch = extractLessons(await api.getCourseTables(auth, biz, semester.id, start, end));
    if (batch.some(row => dateNumber(row.date) < dateNumber(start) || dateNumber(row.date) > dateNumber(end))) {
      throw new Error('课表接口返回查询范围外的日期，停止导出以防漏课');
    }
    lessons.push(...batch);
    report(`读取 ${i + 1}/${ranges.length}：${start} 至 ${end}，${batch.length} 条`);
    if (i + 1 < ranges.length && pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  const result = convertLessons(lessons, semester, maxUnit);
  const root = path.resolve(outputRoot || path.join(__dirname, '../outputs/wakeup'));
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, new Date().toISOString().replace(/[:.]/g, '-') + '-'));
  const code = String(semester.code || semester.id).replace(/[^a-zA-Z0-9_-]/g, '_');
  const stem = 'WakeUp-' + code;
  const csvPath = path.join(directory, stem + '.csv');
  const xlsxPath = path.join(directory, stem + '.xlsx');
  const info = { semester: code, firstMonday: result.firstMonday, endDate: semester.end_date, maxUnit,
    courseCount: result.courseCount, occurrenceCount: result.occurrenceCount, rows: result.rows,
    timeRanges: result.timeRanges, fetchedRows: lessons.length, weeksQueried: ranges.length };
  // Only course data is persisted. Auth responses, account, password and tokens stay in memory.
  await fs.writeFile(csvPath, toCsv(result.rows), { flag: 'wx' });
  await fs.writeFile(path.join(directory, 'export-summary.json'), JSON.stringify(info, null, 2), { flag: 'wx' });
  const notes = [
    `学期：${code}；第 1 周周一：${result.firstMonday}；学期结束：${semester.end_date}。`,
    `共 ${result.courseCount} 门课程、${result.occurrenceCount} 次上课，合并为 ${result.rows.length} 行导入记录。`,
    'WakeUp：导入课表 → Excel/CSV 导入 → 选择本目录 CSV。不要选择树维 HTML 导入。',
    `导入后将开学日期设为 ${result.firstMonday}，每天节数设为 ${maxUnit}。`,
    'CSV 不携带每节上下课时刻，请在 WakeUp 课表设置中核对作息时间；xlsx 的接口时间段表可供参考。',
    '周次、星期按接口的实际上课日期计算；重复记录去重，异地/不同教师和调课日期分别保留。',
    '仅反映导出时教务已发布的安排；以后调课请重新导出。手机端导入效果需在 WakeUp 中确认。',
    '文件包含个人课表和任课教师信息，请勿公开上传。',
    '格式依据：https://wakeup.fun/doc/import_from_csv.html'
  ].join('\r\n');
  await fs.writeFile(path.join(directory, '导入说明.txt'), notes, { flag: 'wx' });
  return { ...info, directory, csvPath, xlsxPath };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const credentials = JSON.parse(input.replace(/^\uFEFF/, ''));
  const result = await exportSchedule({ ...credentials, report: message => console.log(message) });
  const { writeWorkbook } = await import(pathToFileURL(path.join(__dirname, 'wakeup-xlsx.mjs')).href);
  await writeWorkbook(result);
  console.log(JSON.stringify({ directory: result.directory, courseCount: result.courseCount,
    occurrenceCount: result.occurrenceCount, importRows: result.rows.length, csv: result.csvPath, xlsx: result.xlsxPath }));
}

if (require.main === module) main().catch(() => {
  console.error('导出未完整完成。请检查账号密码、教务连接和本机依赖；详细响应已隐藏以保护凭据。');
  process.exitCode = 1;
});
module.exports = { exportSchedule };
