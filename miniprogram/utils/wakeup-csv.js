'use strict';

const DAY = 86400000;
const HEADERS = ['课程名称', '星期', '开始节数', '结束节数', '老师', '地点', '周数'];

function dateNumber(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('日期应为 YYYY-MM-DD');
  const number = Date.parse(text + 'T00:00:00Z');
  if (!Number.isFinite(number) || new Date(number).toISOString().slice(0, 10) !== text) {
    throw new Error('无效日期');
  }
  return number;
}

function dateText(number) { return new Date(number).toISOString().slice(0, 10); }
function monday(number) { return number - ((new Date(number).getUTCDay() + 6) % 7) * DAY; }

function weekRanges(start, end) {
  const first = dateNumber(start), last = dateNumber(end);
  if (last < first || last - first > DAY * 370) throw new Error('学期日期范围异常');
  const ranges = [];
  for (let cursor = first; cursor <= last;) {
    const until = Math.min(monday(cursor) + DAY * 6, last);
    ranges.push([dateText(cursor), dateText(until)]);
    cursor = until + DAY;
  }
  return ranges;
}

function extractLessons(data) {
  const source = data && data.data ? data.data : data;
  const list = Array.isArray(source) ? source :
    ['week_lessons', 'day_lessons', 'lesson_tables', 'course_tables', 'lesson_list', 'lessons']
      .map(key => source && source[key]).find(Array.isArray);
  if (!list) throw new Error('课表响应结构与已知接口不符，停止导出');
  return [].concat(...list.map((item, index) => {
    const children = item.lessons || item.lesson_list || item.course_tables || item.lesson_tables;
    if (!children) return [item];
    if (!Array.isArray(children)) throw new Error('课表分组格式异常');
    const date = item.date || item.lesson_date || item.day_date || item.course_date || (source.date_list && source.date_list[index]);
    return children.map(child => ({ ...child, date: child.date || date }));
  }));
}

function cleanText(value, fallback = '无') {
  const text = String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim() || fallback;
  // Keep both CSV and Excel safe to open; never turn source text into formulas.
  return /^[=+@-]/.test(text) ? "'" + text : text;
}

function names(value, room = false) {
  if (!Array.isArray(value)) throw new Error('教师或教室数据格式异常');
  return cleanText([...new Set(value.map(item => {
    const name = item.name || '';
    if (!room) return name;
    const match = String(name).match(/[A-Za-z]+\d*-\d+[A-Za-z0-9-]*/);
    return match ? match[0] : (name || item.code || '');
  }).filter(Boolean))].sort().join('、'));
}

function compressWeeks(values) {
  const weeks = [...new Set(values)].sort((a, b) => a - b);
  const result = [];
  for (let i = 0; i < weeks.length; i++) {
    const first = weeks[i];
    while (i + 1 < weeks.length && weeks[i + 1] === weeks[i] + 1) i++;
    result.push(first === weeks[i] ? String(first) : first + '-' + weeks[i]);
  }
  return result.join('、');
}

function convertLessons(lessons, semester, maxUnit) {
  const start = dateNumber(semester.start_date), end = dateNumber(semester.end_date);
  const base = monday(start), groups = new Map(), occurrences = new Set(), times = new Map();
  for (let index = 0; index < lessons.length; index++) {
    const item = lessons[index];
    const date = dateNumber(item.date);
    const from = Number(item.start_unit), to = Number(item.end_unit);
    if (date < start || date > end || !item.course_name || !Number.isInteger(from) ||
        !Number.isInteger(to) || from < 1 || to < from || to > maxUnit) {
      throw new Error('第 ' + (index + 1) + ' 条排课缺少有效课程名、日期或节次，停止导出');
    }
    const week = Math.floor((date - base) / (DAY * 7)) + 1;
    const day = (new Date(date).getUTCDay() + 6) % 7 + 1;
    const row = [cleanText(item.course_name), day, from, to, names(item.teachers || []), names(item.rooms || [], true)];
    // A dated occurrence is authoritative, not the recurring weeks/weekstate hint.
    const key = JSON.stringify(row);
    const occurrence = JSON.stringify([key, item.date]);
    occurrences.add(occurrence);
    if (!groups.has(key)) groups.set(key, { row, weeks: new Set() });
    groups.get(key).weeks.add(week);
    if (item.start_time && item.end_time) {
      const time = [from, to, cleanText(item.start_time), cleanText(item.end_time)];
      times.set(JSON.stringify(time), time);
    }
  }
  if (!groups.size) throw new Error('整学期没有有效排课，未生成空课表');
  const rows = [...groups.values()].map(({ row, weeks }) => [...row, compressWeeks(weeks)]);
  rows.sort((a, b) => a[1] - b[1] || a[2] - b[2] || JSON.stringify(a).localeCompare(JSON.stringify(b), 'zh-CN'));
  return { rows, occurrenceCount: occurrences.size, courseCount: new Set(rows.map(row => row[0])).size,
    firstMonday: dateText(base), timeRanges: [...times.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]) };
}

function toCsv(rows) {
  const quote = value => /[",\r\n]/.test(String(value)) ? '"' + String(value).replace(/"/g, '""') + '"' : String(value);
  return '\uFEFF' + [HEADERS, ...rows].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}

module.exports = { HEADERS, weekRanges, extractLessons, convertLessons, compressWeeks, toCsv, dateNumber, formatNames: names };
