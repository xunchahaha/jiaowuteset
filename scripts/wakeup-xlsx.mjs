import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import wakeup from './lib/wakeup.js';

export async function writeWorkbook(info) {
  const packages = process.env.CODEX_NODE_MODULES || path.join(os.homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
  await fs.access(path.join(packages, '@oai/artifact-tool/package.json'));
  const runtime = path.join(info.directory, '.runtime');
  await fs.mkdir(runtime, { recursive: true });
  const link = path.join(runtime, 'node_modules');
  try { await fs.symlink(packages, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const resolve = createRequire(path.join(runtime, 'entry.mjs'));
  const { Workbook, SpreadsheetFile } = await import(pathToFileURL(resolve.resolve('@oai/artifact-tool')).href);
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add('课表');
  const matrix = [wakeup.HEADERS, ...info.rows];
  sheet.getRange(`A1:G${matrix.length}`).values = matrix;
  sheet.getRange(`G2:G${matrix.length}`).setNumberFormat('@');
  sheet.getRange(`B2:D${matrix.length}`).setNumberFormat('0');
  sheet.freezePanes.freezeRows(1);
  style(sheet, matrix.length, [35, 9, 12, 12, 24, 42, 30]);
  const notes = workbook.worksheets.add('导入说明');
  const meta = [
    ['项目', '内容'],
    ['学期', info.semester],
    ['第 1 周周一', info.firstMonday],
    ['学期结束', info.endDate],
    ['每天最大节数', info.maxUnit],
    ['课程门数 / 实际上课次数', `${info.courseCount} / ${info.occurrenceCount}`],
    ['导入方式', 'WakeUp → 导入课表 → Excel/CSV 导入 → 选择配套 CSV'],
    ['日期说明', '按实际上课日期生成星期和周次，保留间断周与调课。'],
    ['作息设置', 'CSV 不携带作息时间。下表仅是接口提供的课程时间段，不代表完整逐节作息表。'],
    ['格式依据', 'https://wakeup.fun/doc/import_from_csv.html'],
    ['数据来源', 'https://zdjw.tsguas.edu.cn/app-ws/ws/app-service/student/course/schedule/get-course-tables'],
    ['更新说明', '只包含导出时教务已发布的安排；后续调课需重新导出。'],
    ['文件用途', 'CSV 用于 WakeUp 导入；本工作簿用于 Excel 查看与编辑。'],
    ['隐私提醒', '包含个人课表及教师信息，请勿公开分享。']
  ];
  notes.getRange(`A1:B${meta.length}`).values = meta;
  style(notes, meta.length, [30, 95]);
  const timeMatrix = [['开始节数', '结束节数', '开始时间', '结束时间'], ...info.timeRanges];
  notes.getRange(`A17:D${16 + timeMatrix.length}`).values = timeMatrix;
  notes.getRange('A17:D17').format = { fill: '#E8EDF2', font: { bold: true } };
  notes.getRange(`A17:D${16 + timeMatrix.length}`).format.rowHeight = 25;
  notes.getRange(`C17:D${16 + timeMatrix.length}`).format.columnWidth = 16;
  // Check values without printing personal course/teacher data to the terminal.
  const inspected = await workbook.inspect({ kind: 'table', range: `课表!A1:G${matrix.length}`,
    include: 'values,formulas', tableMaxRows: 5, tableMaxCols: 7 });
  if (!inspected.ndjson) throw new Error('工作簿检查没有返回结果');
  const errors = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',
    options: { useRegex: true, maxResults: 30 }, summary: 'formula error scan' });
  await fs.writeFile(path.join(info.directory, 'workbook-check.json'), JSON.stringify({ inspection: inspected.ndjson, errors: errors.ndjson }));
  for (const [name, range, file] of [['课表', `A1:G${Math.min(matrix.length, 12)}`, '课表预览.png'],
    ['导入说明', `A1:D${16 + timeMatrix.length}`, '说明预览.png']]) {
    const preview = await workbook.render({ sheetName: name, range, scale: 1, format: 'png' });
    await fs.writeFile(path.join(info.directory, file), new Uint8Array(await preview.arrayBuffer()));
  }
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(info.xlsxPath);
}

function style(sheet, rows, widths) {
  const last = String.fromCharCode(64 + widths.length);
  const all = sheet.getRange(`A1:${last}${rows}`);
  all.format.font = { name: 'Arial', size: 11, color: '#202A35' };
  all.format.rowHeight = 36;
  all.format.wrapText = true;
  all.format.verticalAlignment = 'center';
  sheet.getRange(`A1:${last}1`).format = { fill: '#E8EDF2', font: { bold: true } };
  widths.forEach((width, index) => {
    const column = String.fromCharCode(65 + index);
    sheet.getRange(`${column}1:${column}${rows}`).format.columnWidth = width;
  });
  sheet.showGridLines = false;
}
