const https = require('https');
const C = require('./settings');
const L = require('./logic');

function httpJson(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const u = new URL(url);
    const h = Object.assign({}, headers || {});
    if (data != null) h['Content-Length'] = Buffer.byteLength(data);
    // 自签名证书支持：服务器只有 IP、无域名时用自签证书，此开关跳过校验。
    // 只对「云函数 -> 自建服务器」这条链路生效（客户端是我们自己的代码）。
    const insecure = C.TLS_INSECURE;
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method, headers: h,
      rejectUnauthorized: !insecure
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : {}; } catch (e) { parsed = { raw: buf.slice(0, 300) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

/** 可直接展示给用户的错误（index.js 原样透传 message） */
function exposed(message) {
  const e = new Error(message);
  e.expose = true;
  return e;
}

function createService(store, sendMessage, clock = Date.now, http = httpJson, db = null) {
  const taskDocId = taskId => L.key('task|' + taskId);
  const msgProfileId = openid => L.key('msgprofile|' + openid);
  const msgReceiptId = (openid, reqId) => L.key(openid + '|' + reqId);

  if (!C.SERVER_BASE_URL) {
    // 允许模块加载，但调用时会明确报错
  }

  /**
   * 带 HMAC 的服务器请求。
   *
   * ⚠️ path 必须**不含查询串** —— 服务端签的是 request.url.path。
   * 查询参数走 query 参数单独传，否则签名不匹配（401）。
   */
  async function serverRequest(method, path, payload, query) {
    if (!C.SERVER_BASE_URL) throw Error('未配置 SERVER_BASE_URL，服务端尚未部署');
    if (!C.HMAC_KEY) throw Error('未配置 SERVER_HMAC_KEY');
    const body = payload == null ? '' : JSON.stringify(payload);
    const now = clock();
    const headers = L.signHeaders(method, path, body, now, L.newNonce(now));
    const url = C.SERVER_BASE_URL.replace(/\/$/, '') + path + (query ? '?' + query : '');
    let res;
    try {
      res = await http(method, url, body, headers);
    } catch (e) {
      throw exposed('刷课服务器连接失败（' + (e.code || e.message || '网络错误') + '），请稍后重试');
    }
    const b = res.body || {};
    if (res.status === 401) throw exposed('服务端鉴权失败，请联系开发者检查 SERVER_HMAC_KEY');
    // 服务端 BusinessError 本身就是写给用户看的文案（如「单次最多提交 20 门课」），必须原样透传。
    // ⚠️ 旧实现靠 index.js 的「文案开头白名单」放行，「单次最多…」「以下课程…」等都会被
    //    吞成「刷课服务处理失败」，用户完全不知道为什么提交不了。
    if (b.success === false) throw exposed(b.errMsg || '服务端处理失败');
    if (res.status >= 400) throw exposed('刷课服务器异常（HTTP ' + res.status + '），请稍后重试');
    return b.data;
  }

  // ---------- 任务代理 ----------
  function assertOrderOpen() {
    if (!C.ORDER_OPEN) throw exposed('刷课服务暂不支持下单，已提交的任务会继续刷完');
  }

  async function submitTask(openid, event) {
    assertOrderOpen();
    const reqId = L.requestId(event.requestId);
    const courseIds = Array.isArray(event.courseIds) ? event.courseIds.map(String) : [];
    const v2 = event.billing === 'v2';
    // v2 预留口径：开了自动答题每门课预留 2 次（刷课 1 + 答题 1），否则 1 次。
    // 刷完按实际结算（done + answeredDone），没答题的课那 1 次自然不扣，等于退回。
    // 以前只要求「课程数」，答题那 1 次余额不够就记欠款 —— 用户只买 1 次就能开答题。
    const reserveCount = courseIds.length * (v2 && event.useTiku ? 2 : 1);
    if (v2) await assertCanAfford(openid, reserveCount, !!event.useTiku);
    const data = await serverRequest('POST', '/v1/tasks', {
      openid, requestId: reqId,
      username: event.username, password: event.password,
      courseIds,
      useTiku: !!event.useTiku,
      speed: event.speed || 1.0,
      notopenAction: event.notopenAction || 'retry',
      tikuQuota: v2 || event.tikuQuota == null ? null : Number(event.tikuQuota),
      billing: v2 ? 'v2' : 'v1'
    });
    // 服务器上任务已经建好并开跑：本地记录写失败不能让前端报「提交失败」，
    // 否则用户重点一次就会再起一单。进度页的 getProgress → syncTask 会补建记录。
    try {
      await store.transaction(async tx => {
        const id = taskDocId(data.taskId);
        const existed = await tx.get(C.TASK, id);
        if (existed) return;
        await tx.set(C.TASK, id, {
          openid, taskId: data.taskId, requestId: reqId,
          useTiku: !!event.useTiku, status: 'queued',
          billing: v2 ? 'v2' : 'v1', courseCount: courseIds.length, reserveCount,
          notified: false, createdAt: clock(), updatedAt: clock()
        });
      });
    } catch (e) {
      console.error('[submitTask] 本地任务记录写入失败', data.taskId, e);
    }
    return data;
  }

  async function getProgress(openid, event) {
    const taskId = String(event.taskId || '');
    if (!taskId) throw Error('缺少任务标识');
    const data = await serverRequest('GET', `/v1/tasks/${encodeURIComponent(taskId)}`, null,
      `openid=${encodeURIComponent(openid)}`);
    await syncTask(openid, data);
    // 任务一结束就地结算，不只依赖定时触发器：CLI 部署不会创建 config.json 里的触发器，
    // 曾导致「任务刷完了次数却一直没扣」。结算按回执幂等，与 dispatch 并发也安全。
    const finishedish = C.TERMINAL.indexOf(data && data.status) >= 0 || (data && data.status) === 'paused_tiku';
    if (finishedish) {
      try {
        const doc = await store.task(taskDocId(taskId));
        if (doc && doc.openid === openid && !doc.notified) {
          await finalizeTask(Object.assign({}, doc, { taskId }), data);
        }
      } catch (e) { console.error('[getProgress finalize]', taskId, e); }
    }
    return data;
  }

  async function cancelTask(openid, event) {
    const taskId = String(event.taskId || '');
    if (!taskId) throw Error('缺少任务标识');
    const data = await serverRequest('POST', `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { openid });
    await syncTask(openid, { taskId, status: data.status });
    return data;
  }

  async function scanCourses(openid, event) {
    assertOrderOpen();
    return serverRequest('POST', '/v1/courses/scan', {
      openid, username: event.username, password: event.password, force: !!event.force
    });
  }

  async function listCourses(openid) {
    return serverRequest('GET', '/v1/courses', null, `openid=${encodeURIComponent(openid)}`);
  }

  async function listTasks(openid) {
    return serverRequest('GET', '/v1/tasks', null,
      `openid=${encodeURIComponent(openid)}&limit=20`);
  }

  /** 查询当前 openid 绑定的账号（服务端只回用户名，绝不含密码） */
  async function getAccount(openid) {
    return serverRequest('GET', '/v1/account', null, 'openid=' + encodeURIComponent(openid));
  }

  /**
   * 续跑暂停的任务。成功后把本地记录状态置回 queued、notified=false，
   * 这样任务再次终结时能重新进入通知/结算流程。
   */
  async function resumeTask(openid, event) {
    const taskId = String(event.taskId || '');
    if (!taskId) throw Error('缺少任务标识');
    const data = await serverRequest('POST',
      '/v1/tasks/' + encodeURIComponent(taskId) + '/resume',
      { openid, tikuQuota: event.tikuQuota == null ? null : Number(event.tikuQuota) });
    await store.transaction(async tx => {
      const id = taskDocId(taskId);
      const t = await tx.get(C.TASK, id);
      if (!t) return;
      t.status = 'queued';
      t.notified = false;
      t.updatedAt = clock();
      await tx.set(C.TASK, id, t);
    });
    return data;
  }

  /** 把服务器返回的进度同步到本地任务记录 */
  async function syncTask(openid, data) {
    if (!data || !data.taskId) return;
    await store.transaction(async tx => {
      const id = taskDocId(data.taskId);
      const t = await tx.get(C.TASK, id);
      if (!t) {
        await tx.set(C.TASK, id, {
          openid, taskId: data.taskId, status: data.status || 'queued',
          notified: false, createdAt: clock(), updatedAt: clock()
        });
        return;
      }
      t.status = data.status || t.status;
      t.updatedAt = clock();
      await tx.set(C.TASK, id, t);
    });
  }

  // ---------- 订阅额度账本（照搬 scheduleReminderFunctions 的 receipt 模式） ----------
  async function loadMsgProfile(tx, openid) {
    return (await tx.get(C.MSG_PROFILE, msgProfileId(openid))) || L.defaultMsgProfile(openid, clock());
  }

  async function recordSubscription(openid, event) {
    if (event.templateId !== C.TMPL_PROGRESS && event.templateId !== C.TMPL_CREDIT) {
      throw Error('订阅结果无效');
    }
    if (event.accepted !== true) throw Error('订阅结果无效');
    const reqId = L.requestId(event.requestId);
    const receipt = msgReceiptId(openid, reqId);
    return store.transaction(async tx => {
      const p = await loadMsgProfile(tx, openid);
      if (await tx.get(C.MSG_RECEIPT, receipt)) return L.msgSnapshot(p);
      p.credits = Math.min(C.CREDIT_LIMIT, (p.credits || 0) + 1);
      p.grantTotal = (p.grantTotal || 0) + 1;
      p.updatedAt = clock();
      await tx.set(C.MSG_RECEIPT, receipt, { openid, templateId: event.templateId, createdAt: clock() });
      await tx.set(C.MSG_PROFILE, msgProfileId(openid), p);
      return L.msgSnapshot(p);
    });
  }

  async function status(openid) {
    const p = await store.transaction(async tx => loadMsgProfile(tx, openid));
    const tasks = await store.tasksByOpenid(openid, 10);
    return {
      credits: p.credits || 0,
      grantTotal: p.grantTotal || 0,
      tasks: tasks.map(t => ({ taskId: t.taskId, status: t.status, useTiku: !!t.useTiku,
        createdAt: t.createdAt }))
    };
  }

  // ---------- 通知 ----------
  async function readTikuBalance(openid) {
    if (!db) return 0;
    try {
      const r = await db.collection('xpay_credits').doc(L.key('credits|' + openid)).get();
      const v = r && r.data;
      const doc = Array.isArray(v) ? v[0] : v;
      return (doc && doc.tikuBalance) || 0;
    } catch (e) {
      return 0;
    }
  }

  // ---------- 题库按题计费：用量回写账本 ----------
  // 与 xpayFunctions 同处一个环境、账本文档结构固定，故定时分发时直接扣减，
  // 免去「云函数调云函数拿不到 openid」的问题（HTTP/定时链路没有用户上下文）。
  const XPAY_CREDITS = 'xpay_credits';
  const XPAY_RECEIPT = 'xpay_receipts';

  /**
   * 按 taskId 增量结算账本：每次只扣「本次累计用量 - 上次已扣金额」的差值。
   *
   * 回执里记录 settled = **实际已扣金额**（不是上报的累计用量）。终态任务续跑会
   * 二次进入结算，用差值扣减保证总量恰好等于最终用量（既不漏扣、也不重复扣）。
   *
   * ⚠️ 扣减上限 = min(当前余额, 差值)，永不把余额扣成负数；
   *    余额不足时未扣清的欠款会保留在 settled 之外，用户在续跑前充值后，
   *    下一轮 diff 仍包含该欠款，可继续结清（settled 只增不减）。
   *
   * @param {'tiku'|'course'} kind
   */
  async function settleLedger(kind, openid, taskId, used) {
    if (!db) return null;
    const count = Number(used || 0);
    if (!(count > 0)) return null;
    const isTiku = kind === 'tiku';
    const creditsId = L.key('credits|' + openid);
    const receiptId = L.key((isTiku ? 'tikuspend|' : 'coursespend|') + taskId);
    const balField = isTiku ? 'tikuBalance' : 'balance';
    const spentField = isTiku ? 'tikuSpentTotal' : 'spentTotal';
    return store.transaction(async tx => {
      const receipt = await tx.get(XPAY_RECEIPT, receiptId);
      const settled = Number((receipt && receipt.settled) || 0);
      const diff = count - settled;              // 本次新增用量（含上一轮未扣清的欠款）
      const c = await tx.get(XPAY_CREDITS, creditsId);
      if (!c) return null;                       // 用户还没账本，不结算
      const bal = Number(c[balField] || 0);
      const spend = diff > 0 ? Math.max(0, Math.min(bal, diff)) : 0;
      // settled 记录「实际已扣金额」而非上报用量：余额不足时差额未扣部分不算结清，
      // 下一轮 diff = count - settled 仍包含该欠款，可继续补扣。
      const nextSettled = settled + spend;
      if (spend > 0) {
        c[balField] = bal - spend;
        c[spentField] = Number(c[spentField] || 0) + spend;
        c.updatedAt = clock();
        await tx.set(XPAY_CREDITS, creditsId, c);
      }
      await tx.set(XPAY_RECEIPT, receiptId, {
        openid, kind: isTiku ? 'tiku_spend' : 'course_spend',
        count: spend, settled: nextSettled, target: count, taskId, createdAt: clock()
      });
      return { spent: spend, settled: nextSettled };
    });
  }

  // ---------- v2 统一次数：欠款与可用余额 ----------
  /** 未结清的刷课回执（target > settled 即欠款） */
  async function debtReceipts(openid) {
    if (!db || typeof store.courseSpendReceipts !== 'function') return [];
    const rows = await store.courseSpendReceipts(openid);
    return rows.filter(r => Number(r.target || 0) > Number(r.settled || 0));
  }

  /** 先用当前余额补扣欠款，返回仍未结清的欠款次数 */
  async function settleDebts(openid) {
    let left = 0;
    for (const r of await debtReceipts(openid)) {
      const res = await settleLedger('course', openid, r.taskId, r.target);
      const settled = res ? res.settled : Number(r.settled || 0);
      left += Math.max(0, Number(r.target) - settled);
    }
    return left;
  }

  async function readBalance(openid) {
    if (!db) return null;
    const c = await store.transaction(tx => tx.get(XPAY_CREDITS, L.key('credits|' + openid)));
    return Number((c && c.balance) || 0);
  }

  /** 已提交、还没结算的 v2 任务占用的次数（防止同一笔余额连下多单） */
  async function reservedCount(openid) {
    const tasks = await store.tasksByOpenid(openid, 20);
    return tasks
      .filter(t => t.billing === 'v2' && !t.notified && C.TERMINAL.indexOf(t.status) < 0)
      // reserveCount 是下单时实际预留的次数；老任务没有这个字段，按当时的口径（课程数）算
      .reduce((n, t) => n + Number(t.reserveCount != null ? t.reserveCount : (t.courseCount || 0)), 0);
  }

  async function wallet(openid) {
    const debt = await settleDebts(openid);
    const balance = await readBalance(openid);
    const reserved = await reservedCount(openid);
    return { balance, debt, reserved, available: Math.max(0, (balance || 0) - reserved) };
  }

  async function assertCanAfford(openid, need, answering) {
    if (!db) return;
    const w = await wallet(openid);
    if (w.debt > 0) {
      throw exposed('上次自动答题还差 ' + w.debt + ' 次未结清，充值后即可继续下单');
    }
    if (w.available < need) {
      const hint = w.reserved ? '（进行中的任务已占用 ' + w.reserved + ' 次）' : '';
      const why = answering ? '开启自动答题每门课需预留 2 次，没答题的课刷完退回 1 次。' : '';
      throw exposed('次数不足：' + why + '本次需要 ' + need + ' 次，可用 ' + w.available + ' 次' + hint);
    }
  }

  /** 题库按题计费：增量结算 tikuBalance（paused_tiku 也结算已用部分） */
  async function settleTiku(openid, taskId, used) {
    return settleLedger('tiku', openid, taskId, used);
  }

  /**
   * 刷课按门计费：任务**真正终态**时按已完成课程数增量结算 balance。
   *
   * 只扣「已完成」的课程（failed 自动退次数，故不扣）。
   */
  async function settleCourse(openid, taskId, doneCourses) {
    return settleLedger('course', openid, taskId, doneCourses);
  }

  /**
   * 尝试给一个任务发通知（**发送成功后才扣额度并落回执**，幂等）。
   *
   * ⚠️ 顺序很重要：先发送，成功后再提交「回执 + 扣减」。若发送抛异常或返回非 0，
   *    既不写回执也不扣额度 —— 下一轮 dispatch 会重试，避免「额度白扣 + 通知
   *    永久不达」。返回值区分「放弃」(null) 与「可重试的瞬时失败」：
   *      - null                          -> 已发过 / 没额度，无需再发
   *      - { sent:true }                 -> 发送成功，额度已扣、回执已落
   *      - { sent:false, retryable:true }-> 瞬时失败，未扣额度、未落回执，可重试
   */
  async function maybeNotify(openid, task) {
    const isPaused = task.status === 'paused_tiku';
    const isTerminal = C.TERMINAL.indexOf(task.status) >= 0;
    if (!isPaused && !isTerminal) return null;

    const receipt = L.key('notify|' + task.taskId + '|' + task.status);
    // 幂等 + 额度检查（只读，不占用）：发过就别再发；没额度就发不出去。
    const allowed = await store.transaction(async tx => {
      if (await tx.get(C.MSG_RECEIPT, receipt)) return false;
      const p = await loadMsgProfile(tx, openid);
      return (p.credits || 0) >= 1;
    });
    if (!allowed) return null;

    let payload;
    if (isPaused) {
      const remaining = await readTikuBalance(openid);
      payload = L.creditMessage(openid, { remaining, courseTitle: '' });
    } else {
      payload = L.progressMessage(openid, task);
    }

    let code = 0;
    try {
      const resp = await sendMessage(payload);
      code = Number((resp && (resp.errCode || resp.errcode)) || 0);
    } catch (e) {
      code = Number(e.errCode || 0);
      return { sent: false, retryable: true, code };   // 不落回执、不扣额度
    }
    if (code !== 0) return { sent: false, retryable: true, code };  // 同上，可重试

    // 发送成功，才提交回执 + 扣减（事务内再次确认未并发重复 / 额度仍够）
    await store.transaction(async tx => {
      if (await tx.get(C.MSG_RECEIPT, receipt)) return;
      const p = await loadMsgProfile(tx, openid);
      if ((p.credits || 0) < 1) return;               // 额度被并发消耗，不记账即可
      p.credits -= 1; p.updatedAt = clock();
      await tx.set(C.MSG_RECEIPT, receipt, { openid, taskId: task.taskId, kind: 'notify', createdAt: clock() });
      await tx.set(C.MSG_PROFILE, msgProfileId(openid), p);
    });
    return { sent: true, code };
  }

  /**
   * 结算并通知单个任务（定时 dispatch 与 getProgress 共用）。
   * 全部步骤按回执幂等：两条路径同时处理同一任务也不会重复扣费 / 重复通知。
   * 返回 { sent, settled }。
   */
  async function finalizeTask(t, latest) {
    let sent = 0;
    let settled = 0;
    const useTiku = !!(t.useTiku || latest.useTiku);
    const v2 = t.billing === 'v2';

    // 题库按题计费：任务终结或题库暂停时增量结算（按 taskId 幂等）。
    // 放在通知之前，保证「提示次数不足」时账本已经是扣减后的真实余额。
    const finishedish = C.TERMINAL.indexOf(latest.status) >= 0 || latest.status === 'paused_tiku';
    if (!v2 && useTiku && finishedish && Number(latest.tikuUsed || 0) > 0) {
      try {
        const s = await settleTiku(t.openid, t.taskId, latest.tikuUsed);
        if (s && s.spent) settled += s.spent;
      } catch (e) { console.error('[settleTiku]', t.taskId, e); }
    }

    // 刷课按门计费：只在**真正终态**结算（done/failed/cancelled），
    // paused_tiku 不算结束（用户会续跑），不结算。
    // 只扣「已完成」的 doneCourses —— failed 已自动退次数。
    // v2：开了自动答题时，完成且真正答过题的课多扣 1 次（answeredDoneCourses）。
    const units = Number(latest.doneCourses || 0) +
      (v2 && useTiku ? Number(latest.answeredDoneCourses || 0) : 0);
    if (C.TERMINAL.indexOf(latest.status) >= 0 && units > 0) {
      try {
        const s = await settleCourse(t.openid, t.taskId, units);
        if (s && s.spent) settled += s.spent;
      } catch (e) { console.error('[settleCourse]', t.taskId, e); }
    }

    const r = await maybeNotify(t.openid, latest);
    if (r && r.sent) sent += 1;

    // 终态任务默认从待通知批次退役；但发送「瞬时失败」时保留 notified=false，
    // 让下一轮 dispatch 能重试（额度未扣、回执未落，重试是安全的）。
    const retryable = !!(r && r.retryable);
    if (C.TERMINAL.indexOf(latest.status) >= 0 && !retryable) {
      await store.transaction(async tx => {
        const doc = await tx.get(C.TASK, taskDocId(t.taskId));
        if (!doc) return;
        doc.status = latest.status; doc.notified = true; doc.updatedAt = clock();
        await tx.set(C.TASK, taskDocId(t.taskId), doc);
      });
    }
    return { sent, settled };
  }

  /** 定时分发：扫描未通知的任务 */
  async function dispatch() {
    const rows = await store.pendingNotify(C.DISPATCH_BATCH);
    let sent = 0;
    let settled = 0;
    for (const t of rows) {
      // 用服务器的最新状态（可能已在别处流转）
      let latest = { taskId: t.taskId, status: t.status, updatedAt: t.updatedAt };
      try {
        latest = await serverRequest('GET', `/v1/tasks/${encodeURIComponent(t.taskId)}`, null,
          `openid=${encodeURIComponent(t.openid)}`);
      } catch (e) { /* 服务器不可达时退化用本地状态 */ }
      const r = await finalizeTask(t, latest);
      sent += r.sent;
      settled += r.settled;
    }
    return { scanned: rows.length, sent, settled };
  }

  /** 连通性自检：云函数能否连上自建服务器（部署后第一件事该测这个） */
  async function ping() {
    const base = C.SERVER_BASE_URL;
    if (!base) return { ok: false, reason: '未配置 SERVER_BASE_URL' };
    if (!C.HMAC_KEY) return { ok: false, reason: '未配置 SERVER_HMAC_KEY' };
    const t0 = clock();
    try {
      const res = await http('GET', base.replace(/\/$/, '') + '/healthz', null, {});
      return {
        ok: res.status === 200,
        status: res.status,
        body: res.body,
        tlsInsecure: C.TLS_INSECURE,
        target: base,
        ms: clock() - t0
      };
    } catch (e) {
      return { ok: false, reason: String(e.message || e), target: base, tlsInsecure: C.TLS_INSECURE };
    }
  }

  return { ping, wallet, submitTask, getProgress, cancelTask, scanCourses, listCourses, listTasks,
    getAccount, resumeTask, recordSubscription, status, dispatch, settleTiku, settleCourse };
}

module.exports = { createService, exposed };
