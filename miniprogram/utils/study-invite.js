/**
 * 邀请助力活动：展示层（纯函数，可单测）+ 弹窗「看过了」记录。
 * 活动配置、进度、判定全在云端（studyTaskFunctions inviteStatus / inviteAccept，配置在 app_config.invite），
 * 这里只把云端返回的东西变成页面要的样子；本地只记「这一版弹窗看过了」。
 */

const POPUP_SEEN_KEY = 'study:invitePopupSeen';

/** 助力位：要邀请几个人才能拿满（每人送 reward 次，上限 maxRewards 次） */
function slotCount(cfg) {
  const reward = Math.max(1, Number(cfg && cfg.reward) || 1);
  const max = Math.max(1, Number(cfg && cfg.maxRewards) || 1);
  return Math.ceil(max / reward);
}

const HELPER_TEXT = {
  bound: { text: '已接受邀请，待登录学习通', tone: 'warn' },
  done: { text: '助力成功', tone: 'ok' },
  old_user: { text: '用过刷课，不能助力', tone: 'muted' },
  dup_account: { text: '学习通账号已助力过', tone: 'muted' }
};

function pad2(v) { return String(v).padStart(2, '0'); }
function shortTime(ms) {
  const n = Number(ms);
  if (!n) return '';
  const d = new Date(n);
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/**
 * inviteStatus 结果 -> 活动页 / 入口卡片要的数据
 * slots: [{ filled, label }]，按成功助力（有奖励的）先填
 */
function buildView(res) {
  const r = res || {};
  const cfg = r.config || {};
  const me = r.me || {};
  const n = slotCount(cfg);
  const reward = Math.max(1, Number(cfg.reward) || 1);
  const max = Math.max(1, Number(cfg.maxRewards) || 1);
  const rewarded = Math.min(max, Math.max(0, Number(me.rewarded) || 0));
  const filled = Math.min(n, Math.ceil(rewarded / reward));
  const slots = [];
  for (let i = 0; i < n; i += 1) {
    const give = Math.min(reward, max - i * reward);
    slots.push({ filled: i < filled, label: '+' + give + ' 次' });
  }
  const helpers = (me.helpers || []).map((h, i) => {
    const t = HELPER_TEXT[h.status] || { text: '处理中', tone: 'muted' };
    const text = h.status === 'done' ? (h.reward ? '助力成功 +' + h.reward + ' 次' : '助力成功（次数已领满）') : t.text;
    return { key: String(i), text, tone: t.tone, time: shortTime(h.at) };
  });
  return {
    active: !!cfg.active,
    orderOpen: cfg.orderOpen !== false,
    title: cfg.title || '',
    desc: cfg.desc || '',
    popupText: cfg.popupText || '',
    shareTitle: cfg.shareTitle || '',
    rules: cfg.rules || [],
    reward,
    maxRewards: max,
    rewarded,
    left: Math.max(0, max - rewarded),
    full: rewarded >= max,
    needMore: n - filled,
    percent: Math.round(rewarded * 100 / max),
    slots,
    helpers,
    code: me.code || ''
  };
}

/** 进刷课页要不要弹活动弹窗：活动开着、开了弹窗、还没领满、这一版没看过 */
function shouldPopup(res, seenVersion) {
  const cfg = (res && res.config) || {};
  const me = (res && res.me) || {};
  if (!cfg.active || !cfg.popup) return false;
  if (Number(me.rewarded || 0) >= Number(cfg.maxRewards || 0)) return false;
  return String(seenVersion || '') !== String(cfg.version || '');
}

function popupSeen() {
  try { return wx.getStorageSync(POPUP_SEEN_KEY) || ''; } catch (e) { return ''; }
}

function markPopupSeen(version) {
  try { wx.setStorageSync(POPUP_SEEN_KEY, String(version || '')); } catch (e) { /* noop */ }
}

/** 好友点「去助力」后的结果文案；bound 表示绑定成功，去登录学习通 */
const ACCEPT_TEXT = {
  bound: '',
  done: '你已经帮这位好友助力成功了',
  other: '你已经接受过其他好友的邀请，每人只能助力一次',
  self: '这是你自己的邀请，分享给好友让 TA 来助力吧',
  old_user: '你之前用过刷课，助力只限第一次使用刷课的新同学',
  dup_account: '这个学习通账号已经助力过了',
  closed: '活动已结束，下次再来吧',
  invalid: '邀请链接无效，请让好友重新分享'
};

function acceptText(status) {
  return Object.prototype.hasOwnProperty.call(ACCEPT_TEXT, status) ? ACCEPT_TEXT[status] : '助力失败，请稍后重试';
}

/** 读课程后带回的助力结果 -> 给被邀请人的提示（null = 不提示） */
function scanResultNotice(invite) {
  if (!invite || !invite.status) return null;
  switch (invite.status) {
    case 'done': return { tone: 'ok', title: '助力成功', text: '已帮好友完成助力，好友的刷课次数已到账。你也可以邀请好友，免费领次数。' };
    case 'old_user': return { tone: 'muted', title: '', text: '你之前用过刷课，这次没能帮好友助力（助力只限新同学）' };
    case 'dup_account': return { tone: 'muted', title: '', text: '这个学习通账号已经助力过了，这次没能帮好友助力' };
    case 'no_course': return { tone: 'warn', title: '', text: '没读到进行中的课程，助力还没完成；有课程后再读取一次即可' };
    case 'closed': return { tone: 'muted', title: '', text: '活动已结束，这次没能帮好友助力' };
    default: return null;
  }
}

module.exports = {
  POPUP_SEEN_KEY, slotCount, buildView, shouldPopup, popupSeen, markPopupSeen,
  acceptText, scanResultNotice
};
