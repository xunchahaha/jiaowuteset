const crypto = require('crypto');
const C = require('./settings');

function key(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

function requestId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value)) {
    throw Error('操作标识无效，请重新操作');
  }
  return value;
}

/** 生成业务单号：8~32 位、不以 _ 开头、不可复用 */
function orderId(now) {
  const t = Number(now || Date.now()).toString(36);
  const r = crypto.randomBytes(5).toString('hex');
  return ('CX' + t + r).slice(0, 32);
}

function hmacSha256(secret, message) {
  return crypto.createHmac('sha256', String(secret)).update(String(message), 'utf8').digest('hex');
}

/** 支付签名（服务端用 AppKey） */
function calcPaySig(appKey, uri, signData) {
  return hmacSha256(appKey, uri + '&' + signData);
}

/** 用户态签名（服务端用 sessionKey） */
function calcSignature(sessionKey, signData) {
  return hmacSha256(sessionKey, signData);
}

/**
 * 构造 signData。
 * 字段顺序固定 —— 必须与实际请求体逐字节一致，否则签名校验失败。
 */
function buildSignData({ offerId, productId, goodsPrice, buyQuantity, outTradeNo, attach }) {
  const payload = {
    offerId: String(offerId),
    buyQuantity: Number(buyQuantity || 1),
    env: C.ENV,
    currencyType: C.CURRENCY,
    productId: String(productId),
    goodsPrice: Number(goodsPrice),
    outTradeNo: String(outTradeNo),
    attach: String(attach == null ? '' : attach)
  };
  return JSON.stringify(payload);
}

/** 查商品（不接受客户端传价） */
function product(productKey) {
  const p = C.PRODUCTS[productKey];
  if (!p) throw Error('道具不存在');
  if (p.enabled === false || !p.productId || p.price == null) throw Error('该道具尚未开放');
  return p;
}

/** iOS 单笔最低 1 元校验 */
function checkPlatformPrice(priceCents, platform) {
  if (String(platform).toLowerCase() === 'ios' && Number(priceCents) < C.IOS_MIN_PRICE) {
    throw Error('iOS 单笔最低 1 元，请选择 ¥1 及以上的档位');
  }
  return true;
}

/** 默认账本文档 */
function defaultCredits(openid, now) {
  return {
    openid, balance: 0, tikuBalance: 0,
    grantTotal: 0, spentTotal: 0, tikuGrantTotal: 0, tikuSpentTotal: 0,
    updatedAt: now
  };
}

/** 对外快照（不暴露内部字段） */
function snapshot(c) {
  return {
    balance: c.balance || 0,
    tikuBalance: c.tikuBalance || 0,
    grantTotal: c.grantTotal || 0,
    spentTotal: c.spentTotal || 0
  };
}

/**
 * 调用方分类（入口路由）：
 *   - 小程序端调用**一定带 openid**；
 *   - 微信推送 / HTTP API（需 access_token）/ 定时器**不带 openid**。
 * 推送事件与运维操作只能来自后者 —— 否则用户可在客户端伪造
 * 「发货推送」给自己的未支付订单发次数。
 */
function callerKind(openid, source, event) {
  const e = event || {};
  if (source === 'wx_trigger') return 'trigger';
  if (!openid) {
    if (e.adminAction) return 'admin';
    if (e.MsgType === 'event' && e.Event) return 'event';
    return 'reject';
  }
  return 'client';
}

/** 退款单号：8~32 位字母数字，按 requestId 确定性生成（重试幂等） */
function refundOrderId(reqId) {
  return 'RF' + key('refund|' + reqId).slice(0, 24);
}

module.exports = {
  callerKind, refundOrderId,
  key, requestId, orderId,
  hmacSha256, calcPaySig, calcSignature, buildSignData,
  product, checkPlatformPrice, defaultCredits, snapshot
};
