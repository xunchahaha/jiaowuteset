const config = require('./payment-config');
let initialized = false;

// wx.cloud.callFunction 自身没有超时：网络卡住时回调可能永远不触发，
// 调用方会一直转圈。这里统一加客户端兜底超时（下单/查单/查余额都够快）。
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * 调用支付云函数。
 * options.timeoutMs 可覆盖默认客户端超时（毫秒）。
 */
function call(type, params = {}, options = {}) {
  if (!config.cloudEnvId) {
    return Promise.reject(new Error('支付服务尚未配置云开发环境'));
  }
  if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
    return Promise.reject(new Error('请升级微信后再使用'));
  }
  if (!initialized) {
    wx.cloud.init({ env: config.cloudEnvId, traceUser: false });
    initialized = true;
  }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    // 超时主动 reject；回调晚到时因 settled 已置位被丢弃，不会二次结算。
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('支付服务响应超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒），请稍后重试'));
    }, timeoutMs);
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    wx.cloud.callFunction({
      name: config.functionName,
      data: Object.assign({}, params, { type }),
      success: response => {
        const result = response.result;
        if (!result || !result.success) {
          done(reject, new Error((result && result.errMsg) || '支付服务返回异常'));
        } else {
          done(resolve, result.data);
        }
      },
      fail: () => done(reject, new Error('支付服务连接失败，请检查网络或云函数部署'))
    });
  });
}

function newRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

function isIOS() {
  try {
    return String((wx.getSystemInfoSync().platform) || '').toLowerCase() === 'ios';
  } catch (e) {
    return false;
  }
}

/**
 * iOS 单笔最低 1 元：低于该价的档位不可用。
 * 商品列表以服务端 balance().products 为准（前端不再硬编码价格）。
 */
function canPayProduct(product) {
  if (isIOS() && Number(product.price) < config.iosMinPrice) {
    return { ok: false, reason: 'iOS 单笔最低 1 元，请选择 ¥1 及以上的档位' };
  }
  return { ok: true };
}

/**
 * 下单并拉起支付。
 * ⚠️ success 回调只代表「前端发起成功」，次数到账以发货推送为准。
 */
async function pay(productKey) {
  // 1) 云函数下单，拿双签名
  let code = '';
  try {
    const login = await new Promise((resolve, reject) =>
      wx.login({ success: resolve, fail: reject }));
    code = login && login.code || '';
  } catch (e) { /* 没拿到 code 时服务端会要求重新登录 */ }

  const order = await call('createOrder', {
    productKey, requestId: newRequestId(), platform: isIOS() ? 'ios' : 'android', code
  });

  // 2) 拉起虚拟支付
  await new Promise((resolve, reject) => {
    if (!wx.requestVirtualPayment) {
      reject(new Error('当前微信版本不支持虚拟支付，请升级微信'));
      return;
    }
    wx.requestVirtualPayment({
      signData: order.signData,
      paySig: order.paySig,
      signature: order.signature,
      mode: order.mode,
      env: order.env,
      success: () => resolve(),
      fail: err => reject(new Error((err && err.errMsg) || '支付未完成'))
    });
  });

  return order;
}

/**
 * 支付成功后确认发货。
 *
 * 为什么不只依赖发货推送：推送需要「消息推送 URL」（账号级唯一配置，要公网 HTTPS）。
 * 官方允许「发货推送」与「发货轮询」二选一，这里用小程序的 success 回调
 * 主动触发云函数查单发货（云函数 -> 微信 query_order -> 发货），
 * 因此**不需要配消息推送 URL**。
 *
 * success 回调本身可能丢失（用户异常退出），所以云函数侧还有定时对账兜底。
 */
async function confirmDelivery(outTradeNo, { tries = 3, intervalMs = 1500 } = {}) {
  let lastStatus = '';
  let lastError = '';
  for (let i = 0; i < tries; i++) {
    try {
      const r = await call('confirmOrder', { outTradeNo });
      lastStatus = (r && r.status) || '';
      if (r && r.status === 'paid') return { delivered: true, balance: r.balance };
    } catch (e) {
      lastError = e.message || String(e);
    }
    if (i + 1 < tries) await new Promise(res => setTimeout(res, intervalMs));
  }
  // 把最后一次的状态/错误带回去，便于排障（不再吞掉）
  return { delivered: false, status: lastStatus, error: lastError, outTradeNo };
}

/**
 * 下单 → 拉起支付 → 确认发货 → 返回是否到账。
 */
async function buy(productKey) {
  const order = await pay(productKey);
  const r = await confirmDelivery(order.outTradeNo);
  return Object.assign({}, order, { delivered: r.delivered, balance: r.balance });
}

/**
 * 兼容旧调用：支付成功后轮询余额。
 */
async function waitForCredits(beforeBalance, { tries = 3, intervalMs = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const b = await call('balance');
      if (Number(b.balance) > Number(beforeBalance)) return { arrived: true, balance: b.balance };
    } catch (e) { /* 继续重试 */ }
  }
  return { arrived: false };
}

const balance = () => call('balance');

/**
 * 我的订单（下单时间倒序）。
 * 每项：{ outTradeNo, productKey, title, price, credits, kind, status, attempted, createdAt, paidAt }
 *   status: 'created'(未支付) | 'paid'(已支付)
 *   attempted: 客户端是否发起过查单（true 且 status 仍是 created → 「未到账」，可点刷新到账）
 */
const listOrders = (limit) => call('listOrders', { limit });

module.exports = {
  call, newRequestId, isIOS, canPayProduct,
  pay, buy, confirmDelivery, waitForCredits, balance, listOrders, config
};
