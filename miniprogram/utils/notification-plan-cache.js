const { md5 } = require('./crypto');
const { extractLessons, formatNames, dateNumber } = require('./wakeup-csv');
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

function cacheKey(auth) {
  if (!auth || !auth.token) return '';
  const user = auth.userInfo || {};
  const identity = user.user_code || user.userCode || auth.token;
  const biz = auth.bizTypes && auth.bizTypes[0] && auth.bizTypes[0].id || '';
  // Only a scope digest is persisted, never a raw login token.
  return 'notification-plan-v1:' + md5(String(identity) + '|' + String(biz));
}
function read(wxApi, auth, owner) {
  const key = cacheKey(auth);
  let value;
  try { value = key && wxApi.getStorageSync(key); } catch (_) { return null; }
  return value && value.version === 1 && value.owner === owner ? value : null;
}
function semesterKey(semester) { return [semester.id, semester.start_date, semester.end_date].join('|'); }
function toPlanLesson(row) {
  return { lessonId: String(row.lesson_id || row.course_code || row.course_name),
    courseName: row.course_name, date: row.date, startTime: row.start_time,
    endTime: row.end_time || '', startUnit: row.start_unit || '', endUnit: row.end_unit || '',
    teacher: formatNames(row.teachers || []), place: formatNames(row.rooms || [], true) };
}
function fingerprint(lessons) {
  const fields = ['lessonId', 'courseName', 'date', 'startTime', 'endTime', 'startUnit', 'endUnit', 'teacher', 'place'];
  const rows = lessons.map(item => JSON.stringify(fields.map(field => String(item[field] == null ? '' : item[field]).trim())));
  return md5(JSON.stringify([...new Set(rows)].sort()));
}
function monday(date) {
  const day = dateNumber(date);
  return new Date(day - ((new Date(day).getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
}
function weekFingerprints(lessons) {
  const weeks = {};
  lessons.forEach(item => { const key = monday(item.date); (weeks[key] || (weeks[key] = [])).push(item); });
  const result = {};
  Object.keys(weeks).forEach(key => { result[key] = fingerprint(weeks[key]); });
  return result;
}
function needsCheck(cache, semester, status, now = Date.now()) {
  return !cache || cache.dirty || cache.semester !== semesterKey(semester) || cache.syncedAt !== status.syncedAt
    || !cache.checkedAt || now < cache.checkedAt || now - cache.checkedAt >= CHECK_INTERVAL_MS;
}
function samePlan(cache, semester, status, lessons) {
  return !!cache && cache.semester === semesterKey(semester) && cache.syncedAt === status.syncedAt && cache.signature === fingerprint(lessons);
}
function save(wxApi, auth, owner, semester, status, lessons, before, now = Date.now()) {
  const key = cacheKey(auth); if (!key) return;
  const current = read(wxApi, auth, owner);
  const generation = current && current.changeVersion || 0;
  try { wxApi.setStorageSync(key, { version: 1, owner, semester: semesterKey(semester), semesterId: String(semester.id),
    signature: fingerprint(lessons), weeks: weekFingerprints(lessons), checkedAt: now, syncedAt: status.syncedAt,
    changeVersion: generation, dirty: generation !== (before && before.changeVersion || 0) }); return true;
  } catch (_) { return false; }
}
function observeWeek(wxApi, auth, semesterId, startDate, data) {
  // Piggyback on the course page's successful request; never add a request here.
  const key = cacheKey(auth), value = key && wxApi.getStorageSync(key);
  if (!value || value.version !== 1) return;
  if (String(semesterId) !== value.semesterId) {
    value.dirty = true; value.changeVersion = (value.changeVersion || 0) + 1;
    wxApi.setStorageSync(key, value); return;
  }
  const signature = fingerprint(extractLessons(data).map(toPlanLesson));
  const week = monday(startDate), old = value.weeks && value.weeks[week] || fingerprint([]);
  if (signature !== old && (!value.observed || value.observed[week] !== signature)) {
    value.dirty = true; value.changeVersion = (value.changeVersion || 0) + 1;
    value.observed = Object.assign({}, value.observed, { [week]: signature });
    wxApi.setStorageSync(key, value);
  }
}
module.exports = { read, semesterKey, toPlanLesson, fingerprint, needsCheck, samePlan, save, observeWeek, CHECK_INTERVAL_MS };
