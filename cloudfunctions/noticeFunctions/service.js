const L = require('./logic');

const COLLECTION = 'app_notices';

function exposed(message) {
  const e = new Error(message);
  e.expose = true;
  return e;
}

// 集合不存在（还没写过公告）：-502005 / DATABASE_COLLECTION_NOT_EXIST
function isMissingCollection(e) {
  return /-502005|not exist|COLLECTION_NOT_EXIST/i.test(String((e && (e.errCode || e.message)) || e));
}

function createService(db, clock = Date.now) {
  const col = () => db.collection(COLLECTION);

  async function readAll() {
    try {
      const r = await col().limit(L.MAX_NOTICES * 2).get();
      return r.data || [];
    } catch (e) {
      if (isMissingCollection(e)) return null;
      throw e;
    }
  }

  /**
   * 小程序读公告。notices 为 null 表示云端还没配置（集合不存在），
   * 小程序继续用本地内置公告；空数组表示确实没有公告。
   */
  async function list() {
    const all = await readAll();
    if (!all) return { notices: null };
    const shown = L.sortNotices(all.filter(n => n.published !== false)).slice(0, L.MAX_NOTICES);
    return { notices: shown.map(L.publicNotice) };
  }

  async function upsert(event) {
    const notice = L.validateNotice(event.notice);
    try { await db.createCollection(COLLECTION); } catch (e) { /* 已存在 */ }
    await col().doc(notice.id).set({ data: Object.assign({}, notice, { updatedAt: clock() }) });
    return notice;
  }

  async function remove(event) {
    const id = String(event.id || '');
    if (!id) throw exposed('缺少公告 id');
    try {
      await col().doc(id).remove();
    } catch (e) {
      if (!isMissingCollection(e)) throw e;
    }
    return { id };
  }

  async function adminList() {
    const all = await readAll();
    return { notices: all ? L.sortNotices(all) : null };
  }

  const ADMIN = { upsert, remove, list: adminList };

  async function admin(action, event) {
    if (!Object.prototype.hasOwnProperty.call(ADMIN, action)) throw exposed('未知运维操作');
    return ADMIN[action](event || {});
  }

  return { list, admin };
}

module.exports = { COLLECTION, createService };
