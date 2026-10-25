const C = require('./settings');

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
    task: id => get(db, C.TASK, id),
    tasksByOpenid: async (openid, limit = 20) => {
      const r = await db.collection(C.TASK).where({ openid })
        .orderBy('createdAt', 'desc').limit(limit).get();
      return r.data || [];
    },
    // v2 计费：该用户的刷课扣费回执（计算欠款）
    courseSpendReceipts: async (openid) => {
      const r = await db.collection('xpay_receipts').where({ openid, kind: 'course_spend' })
        .orderBy('createdAt', 'desc').limit(100).get();
      return r.data || [];
    },
    // 定时分发用：未终结或尚未通知的任务
    pendingNotify: async (limit) => {
      const r = await db.collection(C.TASK)
        .where({ notified: db.command.neq(true) })
        .orderBy('updatedAt', 'asc').limit(limit).get();
      return r.data || [];
    }
  };
}

module.exports = { createStore };
