const crypto = require('crypto');
const C = require('./settings');

function key(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

function hmacSha256(secret, message) {
  return crypto.createHmac('sha256', String(secret)).update(String(message), 'utf8').digest('hex');
}

function requestId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value)) {
    throw Error('操作标识无效，请重新操作');
  }
  return value;
}

/** thing 类型上限 20 字符，超长会被微信拒（47003）——必须服务端截断 */
function text(value, limit = C.THING_LIMIT, fallback = '待定') {
  const s = String(value == null ? '' : value).trim() || fallback;
  const chars = Array.from(s);
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('');
}

/** 东八区时间，确定性（不依赖运行时 TZ） */
function cstParts(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, da: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes()
  };
}

/** time 类型：中文格式，不是 ISO */
function timeText(ms) {
  const p = cstParts(ms);
  const hh = String(p.h).padStart(2, '0'), mm = String(p.mi).padStart(2, '0');
  return `${p.y}年${p.mo}月${p.da}日 ${hh}:${mm}`;
}

/** 服务器代理签名头 */
function signHeaders(method, path, body, now, nonce) {
  const ts = Math.floor(Number(now) / 1000);
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const msg = [method.toUpperCase(), path, bodyHash, ts, nonce].join('\n');
  return {
    'X-Auth-Token': hmacSha256(C.HMAC_KEY, msg),
    'X-Timestamp': String(ts),
    'X-Nonce': nonce,
    'Content-Type': 'application/json'
  };
}

function newNonce(now) {
  return crypto.randomBytes(16).toString('hex') + String(now).slice(-4);
}

/** 任务级状态 -> 展示文案 */
function taskStatusText(status) {
  return ({
    done: '已完成', failed: '部分失败', cancelled: '已取消',
    paused_tiku: '已暂停', running: '进行中', queued: '排队中'
  })[status] || '处理中';
}

/** 模板1：服务进度通知 */
function progressMessage(openid, task, pagePath) {
  const courses = task.courses || [];
  const running = courses.find(c => c.status === 'running') || {};
  return {
    touser: openid,
    templateId: C.TMPL_PROGRESS,
    page: pagePath || 'subpackages/study/progress/progress?taskId=' + task.taskId,
    miniprogramState: 'formal',
    lang: 'zh_CN',
    data: {
      thing4: { value: text(taskStatusText(task.status)) },
      time12: { value: timeText(task.updatedAt || Date.now()) },
      thing15: { value: text(running.currentChapter || running.title || '已结束') },
      thing20: { value: text('刷课') }
    }
  };
}

/** 模板2：卡券次数不足提醒 */
function creditMessage(openid, { remaining, courseTitle }, pagePath) {
  return {
    touser: openid,
    templateId: C.TMPL_CREDIT,
    page: pagePath || 'subpackages/study/submit/submit',
    miniprogramState: 'formal',
    lang: 'zh_CN',
    data: {
      number2: { value: String(Number(remaining) || 0) },
      thing1: { value: text('题库次数') },
      thing4: { value: text(courseTitle ? `${courseTitle} 已暂停` : '充值后可继续') }
    }
  };
}

function defaultMsgProfile(openid, now) {
  return { openid, credits: 0, grantTotal: 0, lastNotifyAt: 0, updatedAt: now };
}

function msgSnapshot(p) {
  return { credits: p.credits || 0, grantTotal: p.grantTotal || 0 };
}

module.exports = {
  key, hmacSha256, requestId, text, timeText, cstParts,
  signHeaders, newNonce, taskStatusText,
  progressMessage, creditMessage, defaultMsgProfile, msgSnapshot
};
