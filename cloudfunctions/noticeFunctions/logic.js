// 公告字段校验（纯函数，可单测）。小程序 utils/notices.js 有同口径的一份，改字段两边一起改。
const MAX_NOTICES = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** 管理端写入：不合规直接报错（带原因），合规返回只含白名单字段的公告 */
function validateNotice(raw) {
  const n = raw || {};
  if (!ID_RE.test(String(n.id || ''))) throw Error('公告 id 只能用字母、数字、- 和 _（≤64 位）');
  const title = str(n.title, 60);
  if (!title) throw Error('公告缺少标题');
  if (!DATE_RE.test(String(n.publishedAt || ''))) throw Error('publishedAt 格式应为 YYYY-MM-DD');
  const paragraphs = Array.isArray(n.paragraphs) ? n.paragraphs.map(p => str(p, 1000)).filter(Boolean) : [];
  if (!paragraphs.length) throw Error('公告正文 paragraphs 不能为空');
  const notice = {
    id: n.id,
    title,
    summary: str(n.summary, 200),
    publishedAt: n.publishedAt,
    paragraphs,
    pinned: n.pinned === true,
    forcePopup: n.forcePopup === true,
    published: n.published !== false
  };
  if (n.contact) {
    const c = n.contact;
    const contact = {
      channel: str(c.channel, 20),
      name: str(c.name, 40),
      instructions: str(c.instructions, 200),
      caption: str(c.caption, 60),
      label: str(c.label, 60),
      qr: str(c.qr, 300)
    };
    if (c.copyLabel) { contact.copyLabel = str(c.copyLabel, 20); contact.copyHint = str(c.copyHint, 100); }
    if (!contact.channel || !contact.name || !contact.qr) throw Error('contact 需要 channel、name、qr');
    notice.contact = contact;
  }
  return notice;
}

/** 下发顺序：发布日期新的在前（首条 = 首页横幅 / 强制弹出），同日按更新时间 */
function sortNotices(list) {
  return list.slice().sort((a, b) =>
    String(b.publishedAt).localeCompare(String(a.publishedAt)) || (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}

/** 给小程序的公开字段：去掉库内字段（_id / published / updatedAt） */
function publicNotice(n) {
  const out = {
    id: n.id, title: n.title, summary: n.summary || '', publishedAt: n.publishedAt,
    paragraphs: n.paragraphs, pinned: !!n.pinned, forcePopup: !!n.forcePopup
  };
  if (n.contact) out.contact = n.contact;
  return out;
}

module.exports = { MAX_NOTICES, validateNotice, sortNotices, publicNotice };
