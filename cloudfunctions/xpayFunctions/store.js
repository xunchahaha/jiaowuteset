const C = require('./settings');

/**
 * 数据访问层。全部按确定性文档 ID set()，无 add —— 天然幂等。
 */
function createStore(db) {
  async function get(source, name, id) {
    try {
      const result = await source.collection(name).doc(id).get();
      const data = result && result.data;
      if (!data || (Array.isArray(data) && !data.length)) return null;
      const value = Array.isArray(data) ? data[0] : data;
      if (!value._id && !Object.keys(value).length) return null;
      const { _id, ...rest } = value;
      return rest;
    } catch (error) {
      const msg = String(error.errMsg || error.message || '');
      if (/document[^\n]*(not exist|not found)|DATABASE_DOCUMENT_NOT_EXIST/i.test(msg)) return null;
      throw error;
    }
  }

  return {
    transaction: work => db.runTransaction(tx => work({
      get: (name, id) => get(tx, name, id),
      set: (name, id, data) => tx.collection(name).doc(id).set({ data })
    })),
    order: id => get(db, C.ORDER, id),
    credits: id => get(db, C.CREDITS, id),
    session: id => get(db, C.SESSION, id),
    // 查单回执（confirmCall 探针等）按确定性 ID 读取
    receipt: id => get(db, C.RECEIPT, id),
    // 某用户的订单，按创建时间倒序
    ordersByOpenid: async (openid, limit = 20) => {
      const result = await db.collection(C.ORDER)
        .where({ openid }).orderBy('createdAt', 'desc').limit(limit).get();
      return result.data || [];
    },
    // 未支付且创建超过 fallbackMs 的订单（查单兜底用）
    staleOrders: async (now, fallbackMs, limit) => {
      const result = await db.collection(C.ORDER)
        .where({ status: 'created', createdAt: db.command.lte(now - fallbackMs) })
        .orderBy('createdAt', 'asc').limit(limit).get();
      return result.data || [];
    }
  };
}

module.exports = { createStore };
