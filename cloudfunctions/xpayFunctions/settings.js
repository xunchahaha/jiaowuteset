const local = (() => {
  try { return require('./settings.local.js'); } catch (e) { return {}; }
})();

function pick(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== '') return v;
  }
  for (const n of names) {
    const v = local[n];
    if (v !== undefined && v !== '') return v;
  }
  return '';
}

const ENV_ID = pick('XPAY_ENV') || '0';

module.exports = {
  // 密钥：环境变量优先，其次 settings.local.js
  get SECRETS() {
    return {
      offerId: pick('XPAY_OFFER_ID'),
      appKeyProd: pick('XPAY_APPKEY_PROD'),
      appKeySandbox: pick('XPAY_APPKEY_SANDBOX'),
      appid: pick('WX_APPID'),
      appsecret: pick('WX_APPSECRET')
    };
  },
  get ENV_NUM() { return Number(pick('XPAY_ENV') || '0'); },

  // 集合
  ORDER: 'xpay_orders',
  CREDITS: 'xpay_credits',
  RECEIPT: 'xpay_receipts',
  SESSION: 'xpay_sessions',

  // 虚拟支付固定参数
  ENV: Number(ENV_ID),
  CURRENCY: 'CNY',
  MODE: 'short_series_goods',
  PAY_URI: 'requestVirtualPayment',      // C 端下单签名的 uri
  QUERY_URI: '/xpay/query_order',        // B 端查单签名的 uri（不带参数）
  QUERY_API: 'https://api.weixin.qq.com/xpay/query_order',
  REFUND_URI: '/xpay/refund_order',      // 退款签名 uri
  REFUND_API: 'https://api.weixin.qq.com/xpay/refund_order',
  CODE2SESSION: 'https://api.weixin.qq.com/sns/jscode2session',

  // 道具表 —— productId 必须与 MP 后台「道具管理」完全一致；price 单位为分
  // 价格必须与后台一致，否则 requestVirtualPayment 报错
  PRODUCTS: {
    // 刷课套餐：按次计费。1 次 ¥1.5 / 2 次 ¥2.9 / 5 次 ¥6.9 / 10 次 ¥12.9 / 20 次 ¥24.9
    // productId 与 price(分) 必须和 MP 后台「虚拟支付 → 道具管理」完全一致，否则下单失败。
    // ⚠️ 1 门课 = 150 分，高于 iOS 下限（100 分），iOS 也能买（无需 iosDisabled）
    course_1: { productId: 'yimen', price: 150, credits: 1, kind: 'course', title: '1 门课' },
    course_10: { productId: 'shimen', price: 1290, credits: 10, kind: 'course', title: '10 门课' },
    course_20: { productId: 'ershimen', price: 2490, credits: 20, kind: 'course', title: '20 门课' },
    // 小档：开自动答题后 1 门课要 2 次，绝大多数用户只刷 1~3 门，1 次到 10 次之间需要有档位。
    course_2: { productId: 'liangci', price: 290, credits: 2, kind: 'course', title: '2 次' },
    course_5: { productId: 'wuci', price: 690, credits: 5, kind: 'course', title: '5 次' },

    // 题库券：v2 统一次数计费后**停售**（enabled:false）。保留定义是为了老订单补发 / 对账能查到商品。
    // 题库券：按答题次数预充值，用尽则暂停该课（不退还刷课次数）。
    // productId 必须与 MP 后台「虚拟支付 → 道具管理」完全一致；price(分) 也必须与后台一致。
    // 现行：100 题 ¥2 / 600 题 ¥6 / 3000 题 ¥25（后台 productId 分别为 100 / 600 / 3000）
    tiku_100:  { productId: '100',  price: 200,  credits: 100,  kind: 'tiku', title: '100 题', enabled: false },
    tiku_600:  { productId: '600',  price: 600,  credits: 600,  kind: 'tiku', title: '600 题', enabled: false },
    tiku_3000: { productId: '3000', price: 2500, credits: 3000, kind: 'tiku', title: '3000 题', enabled: false }
  },

  // 微信规定 iOS 单笔最低 1 元
  IOS_MIN_PRICE: 100,

  SESSION_TTL_MS: 30 * 60 * 1000,
  // 订单创建后多久仍未支付则主动查单兜底
  QUERY_FALLBACK_MS: 30 * 1000,
  CREDIT_LIMIT: 10000,

  // 需要 dispatch 的微信推送事件
  EVENTS: ['xpay_goods_deliver_notify', 'xpay_coin_pay_notify',
    'xpay_refund_notify', 'xpay_complaint_notify']
};
