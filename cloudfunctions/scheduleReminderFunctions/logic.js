const crypto = require('crypto');
const C = require('./settings');

function key(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function text(value, limit = 20, fallback = '待定') {
  const chars = Array.from(String(value == null ? '' : value).trim() || fallback);
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('');
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value)) throw Error('操作标识无效，请重新操作');
  return value;
}
function defaultProfile(openid, now) {
  return { openid, enabled: false, leadMinutes: 30, estimatedCredits: 0, grantTotal: 0,
    lessons: [], handled: {}, nextDueAt: 0, syncedAt: 0, syncedThrough: '', lastTestAt: 0, updatedAt: now };
}
function startTimestamp(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Error('课程日期或时间格式错误');
  const utcDate = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(utcDate) || new Date(utcDate).toISOString().slice(0, 10) !== date) throw Error('课程日期无效');
  return Date.parse(`${date}T${time}:00+08:00`);
}
function normalizePlan(items, now) {
  if (!Array.isArray(items) || !items.length || items.length > C.MAX_LESSONS) throw Error('待同步课表为空或课程数量超限');
  const unique = new Map();
  items.forEach(item => {
    const date = String(item.date || ''), startTime = String(item.startTime || '');
    const startAt = startTimestamp(date, startTime);
    if (startAt > now + 366 * 86400000 || !String(item.courseName || '').trim()) throw Error('课程内容或日期范围异常');
    const identity = String(item.lessonId || item.courseName).slice(0, 120);
    const id = key(`${identity}|${date}|${startTime}`);
    if (startAt > now) unique.set(id, { id, date, startTime, startAt,
      courseName: text(item.courseName), teacher: text(item.teacher, 20, '任课老师待定'),
      place: text(item.place, 20, '地点待定') });
  });
  return [...unique.values()].sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id));
}
function nextDue(profile) {
  const pending = profile.lessons.filter(item => !profile.handled[item.id]);
  return pending.length ? Math.min(...pending.map(item => item.startAt - profile.leadMinutes * 60000)) : 0;
}
function snapshot(profile) {
  return { accountKey: key(profile.openid), enabled: profile.enabled, leadMinutes: profile.leadMinutes,
    estimatedCredits: profile.estimatedCredits, creditLimit: C.CREDIT_LIMIT,
    syncedAt: profile.syncedAt, syncedThrough: profile.syncedThrough, lessonCount: profile.lessons.length,
    nextDueAt: profile.nextDueAt, templateId: C.TEMPLATE_ID };
}
function message(openid, lesson, remark) {
  return { touser: openid, templateId: C.TEMPLATE_ID,
    page: `pages/schedule/schedule?anchorDate=${lesson.date}`,
    data: { time1: { value: `${lesson.date} ${lesson.startTime}` }, thing2: { value: text(lesson.courseName) },
      thing5: { value: text(lesson.teacher) }, thing6: { value: text(lesson.place) },
      thing7: { value: text(remark) } } };
}
module.exports = { key, requestId, defaultProfile, normalizePlan, nextDue, snapshot, message };
