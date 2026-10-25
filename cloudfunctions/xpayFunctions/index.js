const cloud = require('wx-server-sdk');
const C = require('./settings');
const L = require('./logic');
const { createStore } = require('./store');
const { createService } = require('./service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const service = createService(createStore(db));

// 微信推送事件 -> 处理函数
const EVENT_HANDLERS = {
  xpay_goods_deliver_notify: (e) => service.deliver(e),
  xpay_coin_pay_notify: () => ({ ErrCode: 0 }),
  xpay_refund_notify: (e) => service.onRefund(e),
  xpay_complaint_notify: (e) => service.onComplaint(e),
  subscribe_msg_popup_event: () => ({ ErrCode: 0 }),
  subscribe_msg_change_event: () => ({ ErrCode: 0 })
};

// 客户端 action（settleCredits 已改由刷课云函数在服务端结算，不再对客户端开放）
const ACTIONS = {
  createOrder: service.createOrder,
  confirmOrder: service.confirmOrder,
  balance: (openid) => service.balance(openid),
  listOrders: service.listOrders
};

// 运维操作：只接受无 openid 的调用（HTTP API 需 access_token，即持有 AppSecret 的人）
const ADMIN = {
  orders: (e) => service.adminOrders(e),
  adjust: (e) => service.adminAdjust(e),
  refund: (e) => service.adminRefund(e)
};

exports.main = async (event = {}) => {
  const { OPENID: openid, SOURCE: source } = cloud.getWXContext();
  const kind = L.callerKind(openid, source, event);

  // 1) 定时触发：每日对账
  if (kind === 'trigger') {
    try {
      return { success: true, data: await service.reconcile() };
    } catch (e) {
      return { success: false, errMsg: String(e.message || e) };
    }
  }

  // 2) 运维操作
  if (kind === 'admin') {
    const fn = ADMIN[event.adminAction];
    if (!fn) return { success: false, errMsg: '未知运维操作' };
    try {
      return { success: true, data: await fn(event) };
    } catch (e) {
      return { success: false, errMsg: String(e.message || e) };
    }
  }

  // 3) 微信平台推送（必须无 openid —— 客户端伪造的「发货推送」在这里被拦下）
  //    按 Event 分派，未识别的事件也要返回成功，否则平台会重推。
  if (kind === 'event') {
    const handler = EVENT_HANDLERS[event.Event];
    try {
      return handler ? await handler(event) : { ErrCode: 0 };
    } catch (e) {
      // 返回非 0 让平台重推（最多 15 次）；已做幂等，重推安全
      return { ErrCode: -1, ErrMsg: String(e.message || e).slice(0, 200) };
    }
  }

  // 4) 客户端调用
  if (kind !== 'client') return { success: false, errMsg: '请从小程序登录后操作' };
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, event.type)) {
    return { success: false, errMsg: '未知操作' };
  }
  try {
    return { success: true, data: await ACTIONS[event.type](openid, event) };
  } catch (error) {
    const businessError = /^(订单|查询|次数|道具|支付|课程|题库|请先|操作标识|结算|该道具|iOS|未配置|登录态|获取|服务端)/.test(error.message || '');
    return { success: false, errMsg: businessError ? error.message : '支付服务处理失败，请稍后重试' };
  }
};
