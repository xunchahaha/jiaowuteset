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
      if (/document[^\n]*(not exist|not found)|DATABASE_DOCUMENT_NOT_EXIST/i.test(String(error.errMsg || error.message))) return null;
      throw error;
    }
  }
  return {
    transaction: work => db.runTransaction(tx => work({
      get: (name, id) => get(tx, name, id),
      set: (name, id, data) => tx.collection(name).doc(id).set({ data })
    })),
    due: async (now, limit) => {
      const result = await db.collection(C.PROFILE).where({ enabled: true,
        estimatedCredits: db.command.gt(0), nextDueAt: db.command.gt(0).and(db.command.lte(now)) })
        .orderBy('nextDueAt', 'asc').limit(limit).get();
      return result.data || [];
    },
    records: async (openid, limit) => {
      const result = await db.collection(C.RECORD).where({ openid }).orderBy('createdAt', 'desc').limit(limit).get();
      return result.data || [];
    }
  };
}
module.exports = { createStore };
