/**
 * 刷课服务：本地态（超星账号记忆 + 选课草稿）与计费计算（纯函数，可单测）。
 *
 * 作用域：登录了教务按教务账号 userCode 隔离（换账号不串号）；没登录用游客作用域。
 * 刷课本身不要求登录教务 —— 次数与订单按微信身份（openid）记在云端。
 * 安全边界（用户要求「自动保存超星账号密码」，这里做等价但有边界）：
 *   1. 密码只存本机，页面上有可见开关（默认开），关掉即清除；
 *   2. 登出时一并清理；
 *   3. 绝不进分享路径 / query（share.js 的 BLOCKED_QUERY_KEYS 已屏蔽 password）。
 *
 * 计费（v2 统一次数）：
 *   - 每门课 1 次；开启「自动答题」且实际答过题的课再 +1 次；失败的课不扣。
 *   - 下单要求「可用次数 ≥ 预留 + 欠款」：开了自动答题每门课预留 2 次，否则 1 次；
 *     刷完按实际结算，没答题的课只扣 1 次（多预留的那 1 次不扣，等于退回）。
 *   - 欠款只来自改规则之前的老任务（那时答题部分不预留），新任务不会再产生。
 */

/**
 * 自动答题的效果说明：确认页开关旁常驻展示（brief），打开开关前弹窗确认（content）。
 * 答案来自题库互验 + AI，题库之间答案有分歧的题不一定对，所以不承诺满分；
 * 「约 90%」取的是实测正确率的保守值。按钮文案受 wx.showModal 限制，最多 4 个字。
 */
const ANSWER_NOTICE = {
  title: '开启前请注意',
  brief: '无法保证 100% 正确，整体正确率约 90%，接近真人作答的水平。',
  content: '章节测验由题库 + AI 自动作答，无法保证 100% 正确，整体正确率约 90%，接近真人作答的水平。对分数要求高的测验建议自己作答。',
  confirmText: '我已了解',
  cancelText: '暂不开启'
};

/**
 * 刷课下单总开关：关闭后不再接新单（读课程 / 提交 / 购买套餐都显示「暂不支持」），
 * 已在服务器上跑的任务不受影响，进度、取消、续跑照常。云函数 STUDY_ORDER_OPEN 同步拦截。
 */
const ORDER_OPEN = false;
const ORDER_CLOSED_TEXT = '刷课服务暂不支持下单，已提交的任务会继续刷完';
/** 维护期间退款联系方式：维护公告里有 QQ 群二维码 */
const REFUND_NOTICE_ID = 'study-maintenance-20261022';

/** 首页 / 登录页的刷课入口：下单关闭时弹「维护中」，有剩余次数可去公告加 QQ 群退款 */
function openEntry() {
  if (ORDER_OPEN) {
    wx.navigateTo({ url: '/subpackages/study/submit/submit' });
    return;
  }
  wx.showModal({
    title: '刷课服务维护中',
    content: '刷课服务正在维护，暂停接新单，已提交的任务会继续刷完。还有剩余次数的同学，可以加入 QQ 群联系客服退款。',
    confirmText: '加群退款',
    cancelText: '知道了',
    success: res => {
      if (res.confirm) wx.navigateTo({ url: '/subpackages/announcements/detail/detail?id=' + REFUND_NOTICE_ID });
    }
  });
}

/** 未登录教务时的本地作用域：刷课的次数 / 订单本就按微信身份记在云端，教务账号只用于隔离本机数据 */
const GUEST_SCOPE = { userInfo: { user_code: 'guest' } };

/** 当前本地作用域：登录了教务按教务账号隔离，没登录用「游客」——刷课不要求登录教务 */
function currentScope() {
  try {
    const auth = wx.getStorageSync('auth');
    return auth && auth.token ? auth : GUEST_SCOPE;
  } catch (e) {
    return GUEST_SCOPE;
  }
}

function userCodeOf(auth) {
  const info = (auth && auth.userInfo) || {};
  return info.user_code || info.userCode || 'anonymous';
}

function scopedKey(name, auth) {
  return 'study:' + name + ':' + userCodeOf(auth);
}

const accountKey = auth => scopedKey('account', auth);
const draftKey = auth => scopedKey('draft', auth);

function loadAccount(auth) {
  try {
    return wx.getStorageSync(accountKey(auth)) || null;
  } catch (e) {
    return null;
  }
}

/** 「记住密码」关闭时只留用户名并清掉已存的密码 */
function saveAccount(auth, payload) {
  const src = payload || {};
  const out = {
    username: String(src.username || ''),
    remember: src.remember !== false,
    updatedAt: Date.now()
  };
  if (out.remember) out.password = String(src.password || '');
  try {
    wx.setStorageSync(accountKey(auth), out);
  } catch (e) { /* 存储满时忽略，不影响主流程 */ }
  return out;
}

function clearAccount(auth) {
  try { wx.removeStorageSync(accountKey(auth)); } catch (e) { /* noop */ }
}

function loadDraft(auth) {
  try {
    return wx.getStorageSync(draftKey(auth)) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 选课草稿：只存最小集。**绝不存密码** —— 密码走 navigateTo 的 eventChannel
 * 内存传递，草稿只用于「确认页被系统回收后还能恢复选了哪些课」。
 */
function saveDraft(auth, draft) {
  const src = draft || {};
  const out = {
    username: String(src.username || ''),
    courses: (src.courses || []).map(c => ({
      courseId: String(c.courseId),
      clazzId: String(c.clazzId),
      title: c.title || '',
      teacher: c.teacher || '',
      needUnlock: !!c.needUnlock
    })),
    savedAt: Date.now()
  };
  try {
    wx.setStorageSync(draftKey(auth), out);
  } catch (e) { /* noop */ }
  return out;
}

function clearDraft(auth) {
  try { wx.removeStorageSync(draftKey(auth)); } catch (e) { /* noop */ }
}

/** 登出 / 换教务账号时清掉该账号下的全部刷课本地态 */
function clearAll(auth) {
  clearAccount(auth);
  clearDraft(auth);
}

// ---------------- 展示小工具 ----------------

/** 手机号打码：138****1234 */
function maskPhone(v) {
  const s = String(v || '');
  if (s.length < 7) return s;
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/** 分 -> 「13.9」「1.5」「2」（去掉多余的 0） */
function yuan(fen) {
  return String(Number((Number(fen || 0) / 100).toFixed(2)));
}

function pad2(v) { return String(v).padStart(2, '0'); }

/** 时间戳 -> 「今天 14:05」「10-11 09:30」「2025-12-01」 */
function formatTime(ms, now = Date.now()) {
  const n = Number(ms);
  if (!n) return '';
  const d = new Date(n);
  const t = new Date(now);
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (d.toDateString() === t.toDateString()) return '今天 ' + hm;
  if (d.getFullYear() === t.getFullYear()) return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hm;
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// ---------------- 计费 ----------------

/** 套餐展示字段：以「次」为单位（商品 title 是给后台看的，不直接展示）；closed = 下单已关闭，全部不可选 */
function decorateProducts(list, opts) {
  const o = opts || {};
  return (list || [])
    .filter(p => p && p.kind !== 'tiku')
    .map(p => {
      const credits = Math.max(1, Number(p.credits) || 1);
      return {
        key: p.key,
        credits,
        price: Number(p.price) || 0,
        priceText: yuan(p.price),
        unitText: credits > 1 ? '¥' + yuan(Math.round(p.price / credits)) + '/次' : '体验',
        disabled: !!o.closed || !!p.iosDisabled || (!!o.ios && Number(p.price) < (o.iosMinPrice || 100)),
        disabledText: o.closed ? '暂不支持' : 'iOS 不可用'
      };
    })
    .sort((a, b) => a.price - b.price);
}

/** 同一档最多连买几笔；再多就推更大的档（每笔都要弹一次支付，太折腾） */
const MAX_REPEAT = 3;

/**
 * 推荐套餐：补齐缺口总价最低的一档（虚拟支付一笔只能买一份，缺 2 次就买两次小档，
 * 比直接推大档便宜）。同价取量大的；连买超过 MAX_REPEAT 笔的不推荐，都超过就给最大档。
 * 返回 { product, times } 或 null。disabled 的（如 iOS 低于下限）不参与。
 */
function recommendProduct(products, shortfall) {
  const usable = (products || []).filter(p => !p.disabled && Number(p.credits) > 0);
  if (!usable.length) return null;
  const need = Math.max(1, Number(shortfall) || 0);
  let best = null;
  for (const p of usable) {
    const times = Math.ceil(need / Number(p.credits));
    if (times > MAX_REPEAT) continue;
    const cost = times * Number(p.price);
    if (!best || cost < best.cost || (cost === best.cost && Number(p.credits) > Number(best.product.credits))) {
      best = { product: p, times, cost };
    }
  }
  if (!best) {
    const top = usable.slice().sort((a, b) => Number(b.credits) - Number(a.credits))[0];
    return { product: top, times: Math.ceil(need / Number(top.credits)) };
  }
  return { product: best.product, times: best.times };
}

/**
 * 确认页结算计划（决定主按钮做什么）。
 *
 * 输入 { courseCount, available, debt, answering, products, pickedKey }
 *   available = 余额 - 进行中任务占用（云函数 wallet 已算好）
 * 返回 {
 *   reserve,       本单预留 = 课程数 × (开答题 ? 2 : 1)
 *   need,          下单门槛 = 预留 + 欠款
 *   shortfall,     还差几次
 *   estMin/estMax  本单实际消耗的范围（开答题时上限 = 预留，下限 = 课程数）
 *   step,          'submit' | 'buy' | 'blocked'
 *   product, times 要买的档位与笔数
 * }
 */
function checkoutPlan(input) {
  const o = input || {};
  const courseCount = Math.max(0, Number(o.courseCount) || 0);
  const available = Math.max(0, Number(o.available) || 0);
  const debt = Math.max(0, Number(o.debt) || 0);
  const reserve = courseCount * (o.answering ? 2 : 1);
  const need = reserve + debt;
  const shortfall = Math.max(0, need - available);
  const plan = {
    reserve, need, shortfall, estMin: courseCount, estMax: reserve,
    step: 'submit', product: null, times: 0
  };
  if (shortfall > 0) {
    const products = o.products || [];
    const picked = products.find(p => p.key === o.pickedKey && !p.disabled);
    const rec = picked
      ? { product: picked, times: Math.ceil(shortfall / Math.max(1, Number(picked.credits))) }
      : recommendProduct(products, shortfall);
    if (rec) {
      plan.step = 'buy';
      plan.product = rec.product;
      plan.times = rec.times;
    } else {
      plan.step = 'blocked';
    }
  }
  return plan;
}

/** 已结束任务实际消耗的次数（与云函数结算口径一致） */
function taskCost(t) {
  const done = Number((t && t.doneCourses) || 0);
  const answered = t && t.useTiku ? Number(t.answeredDoneCourses || 0) : 0;
  return { total: done + answered, done, answered };
}

module.exports = {
  ANSWER_NOTICE,
  ORDER_OPEN,
  ORDER_CLOSED_TEXT,
  REFUND_NOTICE_ID,
  openEntry,
  GUEST_SCOPE,
  currentScope,
  userCodeOf,
  scopedKey,
  loadAccount,
  saveAccount,
  clearAccount,
  loadDraft,
  saveDraft,
  clearDraft,
  clearAll,
  maskPhone,
  yuan,
  formatTime,
  decorateProducts,
  recommendProduct,
  checkoutPlan,
  taskCost
};
