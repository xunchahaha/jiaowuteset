const https = require('https');
const C = require('./settings');
const L = require('./logic');

/** 极简 JSON POST（避免依赖 axios） */
function httpJson(url, body, method) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const u = new URL(url);
    const headers = { 'Content-Type': 'application/json' };
    if (data != null) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: method || 'POST',
      headers
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(Error('响应非 JSON: ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

function appKey() {
  const s = C.SECRETS;
  const key = String(C.ENV) === '1' ? s.appKeySandbox : s.appKeyProd;
  if (!key) throw Error('未配置虚拟支付 AppKey');
  return key;
}

function offerId() {
  const v = C.SECRETS.offerId;
  if (!v) throw Error('未配置 XPAY_OFFER_ID');
  return v;
}

function createService(store, clock = Date.now, http = httpJson) {
  const orderDocId = outTradeNo => L.key('order|' + outTradeNo);
  const creditsDocId = openid => L.key('credits|' + openid);
  const receiptDocId = kind => L.key(kind);
  const sessionDocId = openid => L.key('sess|' + openid);

  const TOKEN_DOC = () => L.key('accesstoken');

  /**
   * 取小程序全局 access_token（B 端接口必须带，否则报 41001）。
   * 缓存到数据库，避免多实例冷启动互相刷新导致 token 失效抖动。
   *
   * @param {boolean} force 为 true 时忽略缓存强制重新获取。
   *   缓存的 token 随时可能被「外部」刷新而失效（微信同一 appid 只保留最新的
   *   access_token，任何一次外部获取都会让旧 token 变 40001），此时必须强制刷新。
   */
  async function getAccessToken(force = false) {
    if (!force) {
      const cached = await store.session(TOKEN_DOC());
      // 留 10 分钟余量
      if (cached && cached.token && cached.expiresAt > clock() + 600000) return cached.token;
    }
    const { appid, appsecret } = C.SECRETS;
    if (!appid || !appsecret) throw Error('服务端未配置 WX_APPID / WX_APPSECRET');
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${appsecret}`;
    const resp = await http(url, null, 'GET');
    if (!resp || !resp.access_token) {
      throw Error('获取 access_token 失败: ' + JSON.stringify(resp).slice(0, 200));
    }
    await store.transaction(async tx => {
      await tx.set(C.SESSION, TOKEN_DOC(), {
        token: resp.access_token,
        expiresAt: clock() + Number(resp.expires_in || 7200) * 1000
      });
    });
    return resp.access_token;
  }

  async function loadCredits(tx, openid) {
    return (await tx.get(C.CREDITS, creditsDocId(openid))) || L.defaultCredits(openid, clock());
  }

  /** 用 wx.login 的 code 换 sessionKey（用于 signature），并缓存 */
  async function fetchSessionKey(openid, code) {
    const cached = await store.session(sessionDocId(openid));
    if (cached && cached.expiresAt > clock()) return cached.sessionKey;
    if (!code) throw Error('请先在小程序内登录后再支付');

    const appid = C.SECRETS.appid;
    const secret = C.SECRETS.appsecret;
    if (!appid || !secret) throw Error('服务端未配置 WX_APPID / WX_APPSECRET');

    // 微信 jscode2session 必须用 GET
    const resp = await http(
      `${C.CODE2SESSION}?appid=${appid}&secret=${secret}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`,
      null, 'GET');
    if (!resp || !resp.session_key) throw Error('登录态换取失败: ' + (resp && resp.errmsg || '未知'));
    await store.transaction(async tx => {
      await tx.set(C.SESSION, sessionDocId(openid), {
        openid, sessionKey: resp.session_key, expiresAt: clock() + C.SESSION_TTL_MS
      });
    });
    return resp.session_key;
  }

  /** 下单：生成 outTradeNo + signData + paySig + signature */
  async function createOrder(openid, event) {
    const reqId = L.requestId(event.requestId);
    const p = L.product(event.productKey);
    L.checkPlatformPrice(p.price, event.platform);

    const outTradeNo = L.orderId(clock());
    const attach = JSON.stringify({ openid, productKey: event.productKey, credits: p.credits, kind: p.kind });
    const signData = L.buildSignData({
      offerId: offerId(), productId: p.productId, goodsPrice: p.price,
      buyQuantity: 1, outTradeNo, attach
    });

    const order = {
      openid, outTradeNo, productKey: event.productKey, productId: p.productId,
      goodsPrice: p.price, credits: p.credits, kind: p.kind, attach,
      status: 'created', requestId: reqId, createdAt: clock()
    };

    // 幂等：同 requestId 的下单直接复用（避免用户连点产生多张单）
    await store.transaction(async tx => {
      const existedId = L.key('req|' + openid + '|' + reqId);
      const existed = await tx.get(C.RECEIPT, existedId);
      if (existed) { order.outTradeNo = existed.outTradeNo; return; }
      await tx.set(C.ORDER, orderDocId(outTradeNo), order);
      await tx.set(C.RECEIPT, existedId, { openid, kind: 'order', outTradeNo, createdAt: clock() });
    });

    const sessionKey = await fetchSessionKey(openid, event.code);
    return {
      outTradeNo: order.outTradeNo,
      signData, mode: C.MODE, env: C.ENV,
      paySig: L.calcPaySig(appKey(), C.PAY_URI, signData),
      signature: L.calcSignature(sessionKey, signData)
    };
  }

  /**
   * 发货：按 OutTradeNo 幂等发放次数。
   * 以本地订单 + attach 为准，不信任推送里的商品信息。
   * 返回 { ErrCode: 0 } 表示成功；非 0 会让微信重推（最多 15 次）。
   */
  async function deliver(notify) {
    const outTradeNo = notify && notify.OutTradeNo;
    if (!outTradeNo) return { ErrCode: -1, ErrMsg: 'missing OutTradeNo' };
    const receipt = L.key('deliver|' + outTradeNo);

    return store.transaction(async tx => {
      if (await tx.get(C.RECEIPT, receipt)) return { ErrCode: 0, ErrMsg: 'duplicated' };

      const order = await tx.get(C.ORDER, orderDocId(outTradeNo));
      if (!order) return { ErrCode: -1, ErrMsg: 'unknown order: ' + outTradeNo };

      const wxInfo = notify.WeChatPayInfo || {};
      order.status = 'paid';
      order.wxOrderId = wxInfo.MchOrderNo || '';
      order.transactionId = wxInfo.TransactionId || '';
      order.paidAt = wxInfo.PaidTime ? wxInfo.PaidTime * 1000 : clock();

      const credits = await loadCredits(tx, order.openid);
      if (order.kind === 'tiku') {
        credits.tikuBalance = (credits.tikuBalance || 0) + order.credits;
        credits.tikuGrantTotal = (credits.tikuGrantTotal || 0) + order.credits;
      } else {
        credits.balance = (credits.balance || 0) + order.credits;
        credits.grantTotal = (credits.grantTotal || 0) + order.credits;
      }
      credits.updatedAt = clock();

      await tx.set(C.ORDER, orderDocId(outTradeNo), order);
      await tx.set(C.CREDITS, creditsDocId(order.openid), credits);
      await tx.set(C.RECEIPT, receipt, {
        openid: order.openid, kind: 'deliver', outTradeNo,
        credits: order.credits, createdAt: clock()
      });
      return { ErrCode: 0, ErrMsg: 'success' };
    });
  }

  /**
   * 判断 query_order 响应是否表示「已支付」。
   *
   * 真实响应结构（2026-10-11 用一笔真实 50 分订单抓取确认）：
   * {
   *   "errcode": 0, "errmsg": "OK",
   *   "order": {
   *     "order_id": "<outTradeNo>", "status": 3,
   *     "order_fee": 50, "paid_fee": 50, "paid_time": 1791716973,
   *     "wx_order_id": "VPO...", "wxpay_order_id": "4500..."
   *   }
   * }
   *
   * 判定标准：**看「钱到账」的语义字段**，而不是猜 status 枚举
   *   - paid_fee > 0（实付金额大于 0）
   *   - paid_time > 0（有支付时间）
   *   - order_id 与本次查询的单号一致（防止张冠李戴）
   */
  function isPaidResponse(resp, expectOutTradeNo) {
    if (!resp || Number(resp.errcode) !== 0) return false;
    const o = resp.order;
    if (!o) return false;
    if (expectOutTradeNo != null && String(o.order_id) !== String(expectOutTradeNo)) return false;
    const paidFee = Number(o.paid_fee || 0);
    const paidTime = Number(o.paid_time || 0);
    // 只认「钱到账」的语义字段，不猜 status 枚举（未支付时两者都为 0）
    return paidFee > 0 && paidTime > 0;
  }

  /** access_token 失效的典型返回（40001 / 42001），**不代表未支付** */
  function isTokenError(resp) {
    const code = Number(resp && resp.errcode);
    return code === 40001 || code === 42001 ||
      /access_token/i.test(String((resp && resp.errmsg) || ''));
  }

  /**
   * 查单兜底：主动调 /xpay/query_order，已支付则走同一发货逻辑。
   * 请求格式依据官方文档（person.html 5.4.2）：
   *   POST /xpay/query_order?access_token=<t>&pay_sig=<sig>
   *   body: {"openid", "env", "order_id"}  —— 字段顺序固定
   */
  async function postQuery(token, outTradeNo, openid) {
    const body = JSON.stringify({ openid, env: C.ENV, order_id: outTradeNo });
    const sig = L.calcPaySig(appKey(), C.QUERY_URI, body);
    return http(
      `${C.QUERY_API}?access_token=${encodeURIComponent(token)}&pay_sig=${sig}`, body);
  }

  async function queryAndDeliver(outTradeNo, openid) {
    if (!openid) return { paid: false, reason: 'missing openid' };

    let token = await getAccessToken();
    let resp = await postQuery(token, outTradeNo, openid);

    // ⚠️ 缓存的 access_token 可能已被外部刷新而失效（40001）。
    // 这**只说明 token 无效，不代表订单未支付** —— 必须强制刷新后重试一次，
    // 否则会把「已支付」误判成「未支付」，用户付了钱却拿不到次数。
    if (isTokenError(resp)) {
      console.log('[query_order][token-invalid] refresh & retry', outTradeNo,
        JSON.stringify(resp).slice(0, 200));
      token = await getAccessToken(true);
      resp = await postQuery(token, outTradeNo, openid);
    }

    const raw = JSON.stringify(resp).slice(0, 800);
    if (!isPaidResponse(resp, outTradeNo)) {
      console.log('[query_order raw][not-paid]', outTradeNo, raw);
      return { paid: false, raw };
    }
    console.log('[query_order raw][paid]', outTradeNo, raw);

    // 用平台单号 wx_order_id 做幂等（官方要求），并复用与推送相同的发货逻辑
    const o = resp.order || {};
    return {
      paid: true,
      result: await deliver({
        OutTradeNo: outTradeNo,
        WeChatPayInfo: {
          MchOrderNo: o.wx_order_id || '',
          TransactionId: o.wxpay_order_id || '',
          PaidTime: Number(o.paid_time || 0)
        }
      })
    };
  }

  async function balance(openid) {
    const c = await store.credits(creditsDocId(openid));
    const snap = L.snapshot(c || L.defaultCredits(openid, clock()));
    snap.products = Object.keys(C.PRODUCTS)
      .filter(k => C.PRODUCTS[k].enabled !== false && C.PRODUCTS[k].productId)
      .map(k => ({
        key: k, title: C.PRODUCTS[k].title, price: C.PRODUCTS[k].price,
        credits: C.PRODUCTS[k].credits, kind: C.PRODUCTS[k].kind,
        iosDisabled: !!C.PRODUCTS[k].iosDisabled
      }));
    snap.iosMinPrice = C.IOS_MIN_PRICE;
    return snap;
  }

  /** 扣减次数（任务结算用；幂等，按 taskId 去重） */
  async function settleCredits(openid, event) {
    const reqId = L.requestId(event.requestId);
    const count = Number(event.count || 0);
    const kind = event.kind === 'tiku' ? 'tiku' : 'course';
    if (!Number.isFinite(count) || count <= 0) throw Error('结算数量无效');
    const receipt = L.key('spend|' + openid + '|' + reqId);

    return store.transaction(async tx => {
      if (await tx.get(C.RECEIPT, receipt)) {
        const c = await loadCredits(tx, openid);
        return L.snapshot(c);
      }
      const credits = await loadCredits(tx, openid);
      if (kind === 'tiku') {
        if ((credits.tikuBalance || 0) < count) throw Error('题库次数不足');
        credits.tikuBalance -= count;
        credits.tikuSpentTotal = (credits.tikuSpentTotal || 0) + count;
      } else {
        if ((credits.balance || 0) < count) throw Error('刷课次数不足');
        credits.balance -= count;
        credits.spentTotal = (credits.spentTotal || 0) + count;
      }
      credits.updatedAt = clock();
      await tx.set(C.CREDITS, creditsDocId(openid), credits);
      await tx.set(C.RECEIPT, receipt, { openid, kind: kind + '_spend', count, createdAt: clock() });
      return L.snapshot(credits);
    });
  }

  /** 退款通知：记录，不自动回收（人工跟进） */
  async function onRefund(notify) {
    const receipt = L.key('refund|' + (notify.WxRefundId || notify.MchRefundId || clock()));
    await store.transaction(async tx => {
      if (await tx.get(C.RECEIPT, receipt)) return;
      await tx.set(C.RECEIPT, receipt, {
        kind: 'refund', openid: notify.OpenId || '', outTradeNo: notify.MchOrderId || '',
        refundFee: notify.RefundFee || 0, retCode: notify.RetCode, createdAt: clock()
      });
    });
    return { ErrCode: 0 };
  }

  /** 投诉：记录，人工跟进 */
  async function onComplaint(notify) {
    const receipt = L.key('complaint|' + (notify.ComplaintId || clock()));
    await store.transaction(async tx => {
      if (await tx.get(C.RECEIPT, receipt)) return;
      await tx.set(C.RECEIPT, receipt, {
        kind: 'complaint', openid: notify.OpenId || '', complaintId: notify.ComplaintId || '',
        detail: String(notify.ComplaintDetail || '').slice(0, 500), createdAt: clock()
      });
    });
    return { ErrCode: 0 };
  }

  /**
   * 客户端触发的确认发货（B5 免配方案）。
   * 支付 success 回调后由小程序调用：云函数主动查单，已支付则发货。
   *
   * 注意：success 回调本身不可靠（用户异常退出会丢），所以这只是「主路径」之一，
   * 仍需配合 reconcile 定时兜底。
   */
  async function confirmOrder(openid, event) {
    const outTradeNo = String(event.outTradeNo || '');
    if (!outTradeNo) throw Error('缺少订单号');
    // 探针：记录「客户端确实调用了 confirmOrder」（每单号只记一次，便于排障）
    try {
      const callReceipt = L.key('confirmcall|' + outTradeNo);
      await store.transaction(async tx => {
        if (await tx.get(C.RECEIPT, callReceipt)) return;
        await tx.set(C.RECEIPT, callReceipt, {
          openid, kind: 'confirm_call', outTradeNo, createdAt: clock()
        });
      });
    } catch (e) { /* 探针失败不影响主流程 */ }
    const order = await store.order(orderDocId(outTradeNo));
    if (!order || order.openid !== openid) throw Error('订单不存在');
    if (order.status === 'paid') {
      const b = await balance(openid);
      return { outTradeNo, status: 'paid', balance: b.balance };
    }
    const r = await queryAndDeliver(outTradeNo, openid);
    const b = await balance(openid);
    return { outTradeNo, status: r.paid ? 'paid' : 'pending', balance: b.balance };
  }

  /** 订单列表 limit：默认 20，夹在 [1,50] */
  function clampLimit(value) {
    if (value == null || value === '') return 20;
    const n = Number(value);
    if (!Number.isFinite(n)) return 20;
    return Math.min(50, Math.max(1, Math.floor(n)));
  }

  /**
   * 订单列表（供小程序「我的订单」展示）。
   *
   * attempted：该单是否存在 confirm_call 回执 —— 前端用它区分
   *   「待支付」(created 且无回执) 与「未到账」(created 但发起过查单)。
   *
   * 回执读取不做事务：limit ≤ 50，逐条按确定性 ID get；
   * 用 db.command.in 批量查询会受 where 条件与 in 长度限制，
   * 且回执集合本就按 sha256 主键直取，开销可忽略。
   */
  async function listOrders(openid, event = {}) {
    const limit = clampLimit(event && event.limit);
    const rows = await store.ordersByOpenid(openid, limit);
    const receipts = await Promise.all(rows.map(o =>
      store.receipt(L.key('confirmcall|' + o.outTradeNo))));

    const orders = rows.map((order, i) => {
      const p = C.PRODUCTS[order.productKey];
      return {
        outTradeNo: order.outTradeNo,
        productKey: order.productKey,
        title: (p && p.title) || '订单',
        price: order.goodsPrice,
        credits: order.credits,
        kind: order.kind,
        status: order.status,
        attempted: !!receipts[i],
        createdAt: order.createdAt,
        paidAt: order.paidAt
      };
    });
    return { orders };
  }

  // ---------------- 运维 / 售后（仅无 openid 的调用，见 logic.callerKind） ----------------

  /** 带 access_token 的微信接口调用；token 被外部刷新（40001）时强制刷新重试一次 */
  async function callWx(fn) {
    let resp = await fn(await getAccessToken());
    if (isTokenError(resp)) resp = await fn(await getAccessToken(true));
    return resp;
  }

  function publicOrder(o) {
    return {
      outTradeNo: o.outTradeNo, openid: o.openid, productKey: o.productKey, kind: o.kind,
      credits: o.credits, price: o.goodsPrice, status: o.status,
      refundedCredits: o.refundedCredits || 0, refundedFee: o.refundedFee || 0,
      createdAt: o.createdAt, paidAt: o.paidAt || null
    };
  }

  /** 查订单与余额：按订单号（用户从「我的」复制给客服）或 openid */
  async function adminOrders(event) {
    const outTradeNo = String(event.outTradeNo || '');
    let openid = String(event.openid || '');
    let orders;
    if (outTradeNo) {
      const o = await store.order(orderDocId(outTradeNo));
      if (!o) throw Error('订单不存在: ' + outTradeNo);
      openid = o.openid;
      orders = [o];
    } else {
      if (!openid) throw Error('缺少 openid 或 outTradeNo');
      orders = await store.ordersByOpenid(openid, 50);
    }
    const c = (await store.credits(creditsDocId(openid))) || L.defaultCredits(openid, clock());
    return {
      openid,
      credits: Object.assign(L.snapshot(c), {
        adjustTotal: c.adjustTotal || 0, refundRevokedTotal: c.refundRevokedTotal || 0
      }),
      orders: orders.map(publicOrder)
    };
  }

  /**
   * 人工调整刷课次数（补偿 / 测试 / 纠错）。delta 可正可负，余额不会被扣成负数。
   * 按 requestId 幂等并落回执（kind=admin_adjust），可审计。
   */
  async function adminAdjust(event) {
    const openid = String(event.openid || '');
    const reqId = L.requestId(event.requestId);
    const delta = Math.trunc(Number(event.delta));
    const reason = String(event.reason || '').trim().slice(0, 100);
    if (!openid) throw Error('缺少 openid');
    if (!Number.isFinite(delta) || delta === 0) throw Error('调整数量无效');
    if (!reason) throw Error('请填写调整原因（会记入回执）');
    const receipt = L.key('adjust|' + reqId);
    return store.transaction(async tx => {
      const prev = await tx.get(C.RECEIPT, receipt);
      if (prev) return { duplicated: true, before: prev.before, after: prev.after };
      const c = await loadCredits(tx, openid);
      const before = Number(c.balance || 0);
      const after = Math.max(0, before + delta);
      c.balance = after;
      c.adjustTotal = Number(c.adjustTotal || 0) + (after - before);
      c.updatedAt = clock();
      await tx.set(C.CREDITS, creditsDocId(openid), c);
      await tx.set(C.RECEIPT, receipt, {
        openid, kind: 'admin_adjust', delta: after - before, before, after, reason, createdAt: clock()
      });
      return { before, after };
    });
  }

  async function postRefund(token, body) {
    const data = JSON.stringify(body);
    const sig = L.calcPaySig(appKey(), C.REFUND_URI, data);
    return http(`${C.REFUND_API}?access_token=${encodeURIComponent(token)}&pay_sig=${sig}`, data);
  }

  /**
   * 售后退款：回收未用的次数 + 调微信 refund_order 退钱，两步对齐。
   *
   * 顺序：先在事务里扣次数并落「pending」回执 → 再调微信退款 →
   *   成功：订单记 refundedCredits / refundedFee；失败：把次数加回去、回执记 failed。
   * 先扣后退，保证不会出现「钱退了次数还在」。同一 requestId 重试直接返回上次结果，不会重复退。
   *
   * 默认按「剩余未用次数」比例退：回收 min(本单剩余次数, 当前余额)，
   * 退款金额 = 单价 × 回收次数（不超过微信侧剩余可退金额 left_fee）。
   * 可用 credits / refundFee 显式指定（例如协商后全额退）。
   */
  async function adminRefund(event) {
    const outTradeNo = String(event.outTradeNo || '');
    const reqId = L.requestId(event.requestId);
    const reason = String(event.refundReason == null ? '3' : event.refundReason);
    if (!/^[0-5]$/.test(reason)) throw Error('refundReason 只能是 0~5');
    const order = await store.order(orderDocId(outTradeNo));
    if (!order) throw Error('订单不存在: ' + outTradeNo);

    const receiptId = L.key('refundreq|' + reqId);
    const prev = await store.receipt(receiptId);
    if (prev) return Object.assign({ duplicated: true }, prev);
    if (['paid', 'partially_refunded'].indexOf(order.status) < 0) {
      throw Error('订单状态为 ' + order.status + '，不能退款');
    }

    // 1) 查单拿微信侧剩余可退金额（left_fee 不符会报 268490016）
    const q = await callWx(t => postQuery(t, outTradeNo, order.openid));
    if (Number(q && q.errcode) !== 0 || !q.order) throw Error('查单失败: ' + JSON.stringify(q).slice(0, 200));
    const paidFee = Number(q.order.paid_fee || 0);
    const leftFee = q.order.left_fee != null
      ? Number(q.order.left_fee)
      : Math.max(0, paidFee - Number(order.refundedFee || 0));
    if (!(leftFee > 0)) throw Error('该订单已无可退金额');

    const refundId = L.refundOrderId(reqId);
    const balField = order.kind === 'tiku' ? 'tikuBalance' : 'balance';

    // 2) 扣次数 + 落 pending 回执
    const plan = await store.transaction(async tx => {
      if (await tx.get(C.RECEIPT, receiptId)) throw Error('该退款请求正在处理，请勿重复提交');
      const c = await loadCredits(tx, order.openid);
      const bal = Number(c[balField] || 0);
      const remaining = Number(order.credits) - Number(order.refundedCredits || 0);
      const revoke = event.credits != null ? Math.trunc(Number(event.credits)) : Math.min(remaining, bal);
      if (!(revoke >= 0) || revoke > remaining) throw Error('回收次数无效（本单剩余 ' + remaining + ' 次）');
      if (revoke > bal) throw Error('用户余额只有 ' + bal + ' 次，不足以回收 ' + revoke + ' 次；可用 credits 指定实际回收数');
      const fee = event.refundFee != null
        ? Math.trunc(Number(event.refundFee))
        : Math.floor(Number(order.goodsPrice) * revoke / Number(order.credits));
      const refundFee = Math.min(fee, leftFee);
      if (!(refundFee > 0)) throw Error('退款金额为 0：本单次数已用完，如需退款请用 refundFee 指定金额');
      c[balField] = bal - revoke;
      c.refundRevokedTotal = Number(c.refundRevokedTotal || 0) + revoke;
      c.updatedAt = clock();
      await tx.set(C.CREDITS, creditsDocId(order.openid), c);
      const r = {
        openid: order.openid, kind: 'admin_refund', status: 'pending', outTradeNo, refundId,
        revoke, refundFee, leftFee, reason, createdAt: clock()
      };
      await tx.set(C.RECEIPT, receiptId, r);
      return r;
    });

    // 3) 调微信退款
    let resp;
    try {
      resp = await callWx(t => postRefund(t, {
        openid: order.openid,
        order_id: outTradeNo,
        refund_order_id: refundId,
        left_fee: leftFee,
        refund_fee: plan.refundFee,
        biz_meta: JSON.stringify({ revoke: plan.revoke, reqId }).slice(0, 1024),
        refund_reason: reason,
        req_from: '1',              // 人工客服退款
        env: Number(C.ENV)
      }));
    } catch (e) {
      resp = { errcode: -1, errmsg: String(e.message || e) };
    }
    const ok = Number(resp && resp.errcode) === 0;
    console.log('[refund_order]', outTradeNo, refundId, JSON.stringify(resp).slice(0, 300));

    // 4) 结果落库：成功记账；失败把次数加回去
    return store.transaction(async tx => {
      const r = await tx.get(C.RECEIPT, receiptId);
      if (!r || r.status !== 'pending') return r;
      if (ok) {
        const o = await tx.get(C.ORDER, orderDocId(outTradeNo));
        o.refundedCredits = Number(o.refundedCredits || 0) + r.revoke;
        o.refundedFee = Number(o.refundedFee || 0) + r.refundFee;
        o.status = o.refundedFee >= paidFee ? 'refunded' : 'partially_refunded';
        o.updatedAt = clock();
        await tx.set(C.ORDER, orderDocId(outTradeNo), o);
        r.status = 'submitted';
        r.wxRefundId = (resp && resp.refund_wx_order_id) || '';
      } else {
        const c = await loadCredits(tx, r.openid);
        c[balField] = Number(c[balField] || 0) + r.revoke;
        c.refundRevokedTotal = Math.max(0, Number(c.refundRevokedTotal || 0) - r.revoke);
        c.updatedAt = clock();
        await tx.set(C.CREDITS, creditsDocId(r.openid), c);
        r.status = 'failed';
        r.error = JSON.stringify(resp).slice(0, 300);
      }
      r.updatedAt = clock();
      await tx.set(C.RECEIPT, receiptId, r);
      return r;
    });
  }

  /** 每日对账：扫未支付订单主动查单 */
  async function reconcile() {
    const rows = await store.staleOrders(clock(), C.QUERY_FALLBACK_MS, 50);
    let fixed = 0;
    for (const o of rows) {
      try {
        const r = await queryAndDeliver(o.outTradeNo, o.openid);
        if (r.paid) fixed += 1;
      } catch (e) { /* 单条失败不影响其余 */ }
    }
    return { checked: rows.length, delivered: fixed };
  }

  return { createOrder, deliver, queryAndDeliver, confirmOrder, balance, settleCredits,
    onRefund, onComplaint, reconcile, listOrders, adminOrders, adminAdjust, adminRefund };
}

module.exports = { createService };
