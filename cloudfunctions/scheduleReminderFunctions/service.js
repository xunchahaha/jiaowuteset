const C = require('./settings');
const L = require('./logic');

function createService(store, sendMessage, clock = Date.now) {
  const profileId = openid => L.key('profile|' + openid);
  const load = async (tx, openid) => (await tx.get(C.PROFILE, profileId(openid))) || L.defaultProfile(openid, clock());
  const save = async (tx, profile) => {
    profile.nextDueAt = L.nextDue(profile); profile.updatedAt = clock();
    await tx.set(C.PROFILE, profileId(profile.openid), profile);
  };
  async function status(openid) {
    const p = await store.transaction(async tx => load(tx, openid));
    const records = await store.records(openid, 20);
    return { ...L.snapshot(p), records: records.map(r => ({ id: r.id, kind: r.kind,
      courseName: r.courseName, date: r.date, startTime: r.startTime, createdAt: r.createdAt,
      status: r.status === 'sending' && clock() - r.createdAt > 120000 ? 'unknown' : r.status,
      reason: r.reason || '' })) };
  }
  async function recordSubscription(openid, event) {
    if (event.templateId !== C.TEMPLATE_ID || event.accepted !== true) throw Error('订阅结果无效');
    const receipt = L.key(`${openid}|${L.requestId(event.requestId)}`);
    return store.transaction(async tx => {
      const p = await load(tx, openid);
      if (await tx.get(C.RECEIPT, receipt)) return L.snapshot(p);
      // Client acceptance estimates a balance; WeChat enforces the actual grant.
      p.estimatedCredits = Math.min(C.CREDIT_LIMIT, p.estimatedCredits + 1);
      p.grantTotal += 1;
      await tx.set(C.RECEIPT, receipt, { openid, createdAt: clock() });
      await save(tx, p);
      return L.snapshot(p);
    });
  }
  async function settings(openid, event) {
    if (typeof event.enabled !== 'boolean' || !C.LEAD_MINUTES.includes(event.leadMinutes)) throw Error('提醒设置无效');
    return store.transaction(async tx => {
      const p = await load(tx, openid);
      if (event.enabled && !p.lessons.length) throw Error('请先同步课表');
      p.enabled = event.enabled; p.leadMinutes = event.leadMinutes;
      await save(tx, p);
      return L.snapshot(p);
    });
  }
  async function sync(openid, event) {
    const lessons = L.normalizePlan(event.lessons, clock());
    return store.transaction(async tx => {
      const p = await load(tx, openid);
      p.lessons = lessons; p.syncedAt = clock();
      p.syncedThrough = lessons.length ? lessons[lessons.length - 1].date : '';
      // Keep handled IDs across re-syncs to prevent duplicate reminders.
      await save(tx, p);
      return L.snapshot(p);
    });
  }
  async function claim(openid, testRequest) {
    return store.transaction(async tx => {
      const now = clock(), p = await load(tx, openid);
      let lesson, id, kind = 'lesson';
      if (testRequest) {
        kind = 'test'; id = L.key(`${openid}|test|${testRequest}`);
        if (await tx.get(C.RECORD, id)) return null;
        if (now - p.lastTestAt < 60000) throw Error('请稍后再发送测试，间隔至少一分钟');
        lesson = p.lessons.find(item => item.startAt > now);
        if (!lesson) throw Error('请先同步至少一节未来课程');
      } else {
        if (!p.enabled) return null;
        lesson = p.lessons.find(item => !p.handled[item.id] && item.startAt - p.leadMinutes * 60000 <= now);
        if (!lesson) return null;
        id = L.key(`${openid}|lesson|${lesson.id}`);
        if (await tx.get(C.RECORD, id)) {
          p.handled[lesson.id] = 'existing'; await save(tx, p); return { skipped: true };
        }
      }
      const late = !testRequest && (lesson.startAt <= now || now - (lesson.startAt - p.leadMinutes * 60000) > C.LATE_WINDOW_MS);
      if (!late && p.estimatedCredits < 1) {
        if (testRequest) throw Error('请先增加通知次数');
        return null;
      }
      const record = { id, openid, kind, courseName: lesson.courseName, date: lesson.date, startTime: lesson.startTime,
        status: late ? 'skipped' : 'sending', reason: late ? '已过提醒时间，未补发' : '',
        createdAt: now, grantTotal: p.grantTotal, lessonId: lesson.id };
      if (kind === 'lesson') p.handled[lesson.id] = record.status;
      if (!late) p.estimatedCredits -= 1;
      if (testRequest) p.lastTestAt = now;
      await tx.set(C.RECORD, id, record);
      await save(tx, p);
      return { record, skipped: late, payload: L.message(openid, lesson,
        testRequest ? '测试提醒，请核对服务通知' : `课程将在${p.leadMinutes}分钟后开始`) };
    });
  }
  async function deliver(claimed) {
    if (!claimed || claimed.skipped) return;
    let outcome = 'sent', code = 0;
    try {
      const response = await sendMessage(claimed.payload);
      code = Number(response && (response.errCode || response.errcode) || 0);
      if (code !== 0) outcome = 'failed';
    } catch (error) {
      code = Number(error && (error.errCode || error.errcode) || 0);
      outcome = code > 0 ? 'failed' : 'unknown';
    }
    // Never repeat sending if final bookkeeping fails: show stale sends unknown.
    await store.transaction(async tx => {
      const record = await tx.get(C.RECORD, claimed.record.id);
      if (!record || record.status !== 'sending') return;
      const p = await load(tx, record.openid);
      record.status = outcome; record.finishedAt = clock();
      record.reason = outcome === 'sent' ? '微信接口已受理，请以服务通知为准' : outcome === 'unknown'
        ? '发送结果待确认，未自动重试以免重复通知' : code === 43101
          ? '微信未允许此次发送，请重新订阅并检查通知权限' : `微信返回错误 ${code}`;
      if (outcome === 'failed') {
        p.estimatedCredits = code === 43101 ? Math.min(p.estimatedCredits, Math.max(0, p.grantTotal - record.grantTotal))
          : Math.min(C.CREDIT_LIMIT, p.estimatedCredits + 1);
      }
      if (record.kind === 'lesson') p.handled[record.lessonId] = outcome;
      await tx.set(C.RECORD, record.id, record);
      await save(tx, p);
    });
  }
  async function test(openid, event) {
    const c = await claim(openid, L.requestId(event.requestId));
    if (!c) return status(openid);
    await deliver(c);
    return status(openid);
  }
  async function dispatch() {
    const profiles = await store.due(clock(), 50);
    let processed = 0;
    for (const p of profiles) {
      for (let i = 0; i < 4; i++) {
        const c = await claim(p.openid);
        if (!c) break;
        await deliver(c); processed++;
      }
    }
    return { processed };
  }
  return { status, recordSubscription, settings, sync, test, dispatch };
}
module.exports = { createService };
