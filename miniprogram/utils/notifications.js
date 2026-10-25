const config = require('./notification-config');
const { pickCurrentSemesterItem } = require('./semester');
const { weekRanges, extractLessons, dateNumber } = require('./wakeup-csv');
const { toPlanLesson } = require('./notification-plan-cache');
let initialized = false;

function call(type, params = {}) {
  if (!config.cloudEnvId) return Promise.reject(new Error('通知中心尚未配置云开发环境，请联系开发者完成部署'));
  if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') return Promise.reject(new Error('请升级微信后再使用通知中心'));
  if (!initialized) { wx.cloud.init({ env: config.cloudEnvId, traceUser: false }); initialized = true; }
  return new Promise((resolve, reject) => wx.cloud.callFunction({ name: config.functionName,
    data: Object.assign({}, params, { type }),
    success: response => {
      const result = response.result;
      if (!result || !result.success) reject(new Error(result && result.errMsg || '通知服务返回异常'));
      else resolve(result.data);
    }, fail: () => reject(new Error('通知服务连接失败，请检查网络或云函数部署'))
  }));
}
function newRequestId() { return `req_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`; }
async function loadSemester(api, auth, check = () => {}) {
  if (!auth || !auth.token || auth.offline) throw Error('请联网登录后同步课表');
  const biz = auth.bizTypes && auth.bizTypes[0] && auth.bizTypes[0].id;
  if (!biz) throw Error('缺少教学业务信息');
  const data = await api.getSemesters(auth, biz); check();
  const semester = pickCurrentSemesterItem(data, new Date());
  if (!semester) throw Error('未找到当前学期');
  return semester;
}
async function collectPlan(api, auth, check = () => {}, progress = () => {}, knownSemester) {
  const semester = knownSemester || await loadSemester(api, auth, check);
  const biz = auth.bizTypes && auth.bizTypes[0] && auth.bizTypes[0].id;
  const ranges = weekRanges(semester.start_date, semester.end_date), lessons = [];
  for (let i = 0; i < ranges.length; i++) {
    check(); progress(i + 1, ranges.length);
    const [start, end] = ranges[i];
    const rows = extractLessons(await api.getCourseTables(auth, biz, semester.id, start, end)); check();
    rows.forEach(row => {
      if (dateNumber(row.date) < dateNumber(start) || dateNumber(row.date) > dateNumber(end)) throw Error('课表日期异常');
      if (!row.start_time) throw Error('课表缺少上课时间，暂不安排提醒');
      lessons.push(toPlanLesson(row));
    });
    if (lessons.length > 1000) throw Error('课表数量超出同步上限');
    if (i + 1 < ranges.length) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!lessons.length) throw Error('当前学期没有排课');
  return lessons;
}
module.exports = { call, newRequestId, loadSemester, collectPlan, config };
