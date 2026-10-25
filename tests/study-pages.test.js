// 刷课分包四个页面的冒烟测试：在假 wx 环境里跑真实页面 JS，走通完整用户流程。
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../miniprogram');
const AUTH = { token: 't', secret: 's', userInfo: { user_code: 'u1' } };
// 下面的流程测试都按「下单开放」跑；关闭态单独测
const study = require(path.join(root, 'utils/study'));
study.ORDER_OPEN = true;

async function withOrderClosed(fn) {
  study.ORDER_OPEN = false;
  try { await fn(); } finally { study.ORDER_OPEN = true; }
}

const tick = () => new Promise(r => setTimeout(r, 0));
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

function makeWx(storage = {}, auth = AUTH) {
  const calls = { navigateTo: [], redirectTo: [], toast: [], modal: [], emitted: [] };
  const wx = {
    calls,
    getStorageSync: k => (k === 'auth' ? auth : storage[k]),
    setStorageSync: (k, v) => { storage[k] = v; },
    removeStorageSync: k => { delete storage[k]; },
    navigateTo: o => {
      calls.navigateTo.push(o.url);
      if (o.success) o.success({ eventChannel: { emit: (n, d) => calls.emitted.push([n, d]) } });
    },
    redirectTo: o => calls.redirectTo.push(o.url),
    navigateBack: () => {},
    reLaunch: o => calls.redirectTo.push(o.url),
    showToast: o => calls.toast.push(o.title),
    showModal: o => { calls.modal.push(o); if (o.success) o.success({ confirm: true }); },
    showLoading: () => {}, hideLoading: () => {},
    stopPullDownRefresh: () => {}, pageScrollTo: () => {}, setClipboardData: () => {},
    getSystemInfoSync: () => ({ platform: 'android' })
  };
  return wx;
}

function loadPage(rel, { wx, task, payment, channel }) {
  let def;
  const real = name => require(path.join(root, 'utils', path.basename(name)));
  const sandboxRequire = name => {
    const base = path.basename(name);
    if (base === 'share') return { withPageShare: d => d };
    if (base === 'task') return task;
    if (base === 'payment') return payment;
    return real(name);
  };
  global.wx = wx;   // utils（study / cache）里直接用全局 wx
  vm.runInNewContext(fs.readFileSync(path.join(root, rel), 'utf8'), {
    require: sandboxRequire, wx, console, setTimeout, clearTimeout, Promise, Date, Math, JSON,
    Page: d => { def = d; }
  });
  const page = Object.assign({}, def);
  page.data = JSON.parse(JSON.stringify(def.data));
  page.setData = patch => Object.assign(page.data, patch);
  page.getOpenerEventChannel = () => ({ on: (n, fn) => { if (channel) fn(channel); } });
  return page;
}

const PRODUCTS = [
  { key: 'course_1', price: 150, credits: 1, kind: 'course' },
  { key: 'course_10', price: 1390, credits: 10, kind: 'course' }
];

function baseTask(over) {
  return Object.assign({
    config: { maxCoursesPerTask: 20, pollIntervalMs: 999999, templates: { progress: 'p', credit: 'c' } },
    newRequestId: () => 'req_test_0000000001',
    wallet: async () => ({ balance: 5, debt: 0, reserved: 0, available: 5 }),
    listTasks: async () => ({ tasks: [] }),
    getAccount: async () => ({ username: '' }),
    grantSubscribe: async () => ({ accepted: ['p'] })
  }, over);
}
const basePayment = over => Object.assign({
  isIOS: () => false,
  balance: async () => ({ balance: 5, tikuBalance: 0, products: PRODUCTS, iosMinPrice: 100 }),
  listOrders: async () => ({ orders: [] })
}, over);

test('选课页：读取课程 → 勾选 → 下一步把密码走内存通道传给确认页', async () => {
  const wx = makeWx({ 'study:account:u1': { username: '13800000000', password: 'pw', remember: true } });
  const task = baseTask({
    scanCourses: async () => ({ courses: [
      { courseId: '1', clazzId: '9', title: '数据结构', teacher: '张', needUnlock: false, jobCount: 12 },
      { courseId: '2', clazzId: '9', title: '操作系统', needUnlock: true, jobCount: 8 }
    ] })
  });
  const page = loadPage('subpackages/study/submit/submit.js', { wx, task, payment: basePayment() });
  page.onLoad(); page.onShow();
  await flush();
  assert.equal(page.data.available, 5);

  page.onScan();
  await flush();
  page.stopScanTimer();
  assert.equal(page.data.scanned, true);
  assert.equal(page.data.scanning, false);
  assert.equal(page.data.maskedUser, '138****0000');
  assert.equal(page.data.courses.length, 2);

  page.onToggleAll();
  assert.equal(page.data.selectedCount, 2);
  assert.equal(page.data.allSelected, true);
  assert.equal(page.data.unlockSelected, 1);

  page.onNext();
  assert.equal(wx.calls.navigateTo[0], '/subpackages/study/confirm/confirm');
  const [name, payload] = wx.calls.emitted[0];
  assert.equal(name, 'studyDraft');
  assert.equal(payload.password, 'pw');
  // 草稿落盘但绝不含密码
  assert.equal(JSON.stringify(wx.getStorageSync('study:draft:u1')).includes('pw'), false);
  page.onUnload();
});

test('没登录教务也能刷课：不跳登录页，本机数据存游客作用域', async () => {
  const storage = {};
  const wx = makeWx(storage, null);
  const task = baseTask({ scanCourses: async () => ({ courses: [{ courseId: '1', clazzId: '9', title: 'A' }] }) });
  const page = loadPage('subpackages/study/submit/submit.js', { wx, task, payment: basePayment() });
  page.onLoad(); page.onShow();
  page.onUsername({ detail: { value: '13800000000' } });
  page.onPassword({ detail: { value: 'pw' } });
  page.onScan();
  await flush();
  page.stopScanTimer();
  assert.equal(wx.calls.redirectTo.length, 0, '不能被踢回登录页');
  assert.equal(page.data.courses.length, 1);
  assert.equal(storage['study:account:guest'].username, '13800000000');
  page.onToggleAll();
  page.onNext();
  assert.equal(wx.calls.navigateTo[0], '/subpackages/study/confirm/confirm');

  // 确认 / 进度 / 我的 三页同样不拦截
  for (const rel of ['confirm/confirm', 'progress/progress', 'orders/orders']) {
    const w = makeWx({}, null);
    const p = loadPage('subpackages/study/' + rel + '.js', {
      wx: w,
      task: baseTask({ getProgress: async () => ({ status: 'running', courses: [] }) }),
      payment: basePayment()
    });
    p.onLoad({ taskId: 't' });
    if (p.onShow) p.onShow();
    await flush();
    assert.equal(w.calls.redirectTo.length, 0, rel + ' 不能要求登录教务');
    if (p.onUnload) p.onUnload();
  }
  page.onUnload();
});

test('选课页：读取失败显示可读原因，按钮复位', async () => {
  const wx = makeWx({ 'study:account:u1': { username: '138', password: 'x' } });
  const task = baseTask({ scanCourses: async () => { throw new Error('超星登录失败: 密码错误'); } });
  const page = loadPage('subpackages/study/submit/submit.js', { wx, task, payment: basePayment() });
  page.onLoad();
  page.onScan();
  await flush();
  page.stopScanTimer();
  assert.equal(page.data.scanning, false);
  assert.equal(page.data.scanError, '学习通登录失败：密码错误');
  page.onUnload();
});

test('确认页：次数不够 → 支付 → 到账后自动以 v2 计费提交 → 跳进度页', async () => {
  const wx = makeWx({});
  let available = 2;                         // 够刷 2 门，但开了答题要预留 4 次
  const submitted = [];
  const task = baseTask({
    wallet: async () => ({ balance: available, debt: 0, reserved: 0, available }),
    submitTask: async p => { submitted.push(p); return { taskId: 't_new' }; }
  });
  const payment = basePayment({ buy: async key => { available += key === 'course_1' ? 1 : 10; return { delivered: true, outTradeNo: 'o1' }; } });
  const channel = { username: '13800000000', password: 'pw', courses: [
    { courseId: '1', clazzId: '9', title: '数据结构', needUnlock: false },
    { courseId: '2', clazzId: '9', title: '操作系统', needUnlock: true }
  ] };
  const page = loadPage('subpackages/study/confirm/confirm.js', { wx, task, payment, channel });
  page.onLoad();
  await flush();

  assert.equal(page.data.forceAnswer, true);
  assert.equal(page.data.answering, true);
  assert.equal(page.data.step, 'buy');
  assert.equal(page.data.product.key, 'course_1');
  assert.equal(page.data.times, 2);
  assert.equal(page.data.ctaText, '支付 ¥1.5 ×2');

  await page.onPrimary();                    // 第一笔：到账 1 次，仍差 1 次
  assert.equal(submitted.length, 0);
  assert.equal(page.data.shortfall, 1);
  await page.onPrimary();                    // 第二笔：够了，自动提交
  await flush();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].billing, 'v2');
  assert.equal(submitted[0].useTiku, true);
  assert.equal(submitted[0].password, 'pw');
  assert.deepEqual(submitted[0].courseIds, ['1', '2']);
  assert.equal(wx.calls.redirectTo[0], '/subpackages/study/progress/progress?taskId=t_new');
});

test('确认页：服务端拒绝时原因常驻页面、按钮复位、换新 requestId', async () => {
  const wx = makeWx({});
  let n = 0;
  const ids = [];
  const task = baseTask({
    newRequestId: () => 'req_test_' + String(++n).padStart(10, '0'),
    submitTask: async p => { ids.push(p.requestId); throw new Error('单次最多提交 20 门课'); }
  });
  const channel = { username: '138', password: 'pw', courses: [{ courseId: '1', clazzId: '9', title: 'A' }] };
  const page = loadPage('subpackages/study/confirm/confirm.js', { wx, task, payment: basePayment(), channel });
  page.onLoad();
  await flush();
  assert.equal(page.data.step, 'submit');
  await page.onPrimary();
  assert.equal(page.data.busy, false);
  assert.match(page.data.error, /单次最多提交 20 门课/);
  await page.onPrimary();
  assert.notEqual(ids[0], ids[1]);
});

test('确认页：页面被回收没拿到密码 → 本页补填后提交', async () => {
  const wx = makeWx({ 'study:draft:u1': { username: '138', courses: [{ courseId: '1', clazzId: '9', title: 'A' }] } });
  const submitted = [];
  const task = baseTask({ submitTask: async p => { submitted.push(p); return { taskId: 't' }; } });
  const page = loadPage('subpackages/study/confirm/confirm.js', { wx, task, payment: basePayment() });
  page.onLoad();
  await flush();
  assert.equal(page.data.needPassword, true);
  await page.onPrimary();
  assert.match(page.data.error, /密码/);
  page.onPasswordInput({ detail: { value: 'pw2' } });
  await page.onPrimary();
  assert.equal(submitted[0].password, 'pw2');
});

test('进度页：加载 → 取消 → 终态显示消耗', async () => {
  const wx = makeWx({});
  let status = 'running';
  const task = baseTask({
    getProgress: async () => ({ taskId: 't', status, totalCourses: 1, doneCourses: status === 'running' ? 0 : 0,
      overallPercent: 30, courses: [{ courseId: '1', clazzId: '9', title: 'A', status: status === 'running' ? 'running' : 'cancelled' }] }),
    cancelTask: async () => { status = 'cancelled'; return { status }; }
  });
  const page = loadPage('subpackages/study/progress/progress.js', { wx, task, payment: basePayment() });
  page.onLoad({ taskId: 't' });
  await flush();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.t.canCancel, true);

  page.onCancel();                            // showModal 自动确认
  await flush(10);
  assert.equal(page.data.canceling, false);
  assert.equal(page.data.t.status, 'cancelled');
  assert.equal(page.data.t.costText, '本单未消耗次数');
  page.onUnload();
});

test('我的页：钱包、记录、订单都能渲染', async () => {
  const wx = makeWx({});
  const task = baseTask({
    wallet: async () => ({ balance: 3, debt: 1, reserved: 0, available: 3 }),
    listTasks: async () => ({ tasks: [{ taskId: 't1', status: 'done', totalCourses: 1, doneCourses: 1,
      titles: ['数据结构'], createdAt: Date.now() }] })
  });
  const payment = basePayment({ listOrders: async () => ({ orders: [
    { outTradeNo: 'o1', price: 1390, credits: 10, kind: 'course', status: 'paid', createdAt: Date.now() },
    { outTradeNo: 'o2', price: 150, credits: 1, kind: 'course', status: 'created', attempted: true, createdAt: Date.now() }
  ] }) });
  const page = loadPage('subpackages/study/orders/orders.js', { wx, task, payment });
  page.onLoad(); page.onShow();
  await flush();
  assert.equal(page.data.available, 3);
  assert.equal(page.data.debt, 1);
  assert.equal(page.data.products.length, 2);
  assert.equal(page.data.records[0].name, '数据结构');
  assert.equal(page.data.orders[0].name, '10 次');
  assert.equal(page.data.unpaidCount, 1);
});

test('确认页：打开自动答题前先弹效果说明，不同意就保持关闭；同意后本页不再反复弹', async () => {
  const wx = makeWx({});
  let agree = false;
  wx.showModal = o => { wx.calls.modal.push(o); o.success({ confirm: agree, cancel: !agree }); };
  const channel = { username: '138', password: 'pw', courses: [{ courseId: '1', clazzId: '9', title: 'A' }] };
  const page = loadPage('subpackages/study/confirm/confirm.js', { wx, task: baseTask(), payment: basePayment(), channel });
  page.onLoad();
  await flush();
  assert.equal(page.data.answering, false);
  assert.match(page.data.answerNotice, /无法保证 100% 正确/);      // 开关下常驻的说明
  assert.match(page.data.answerNotice, /约 90%/);

  page.onToggleAnswer({ detail: { value: true } });               // 点「暂不开启」
  assert.equal(wx.calls.modal.length, 1);
  assert.match(wx.calls.modal[0].content, /无法保证 100% 正确/);
  assert.ok(wx.calls.modal[0].confirmText.length <= 4 && wx.calls.modal[0].cancelText.length <= 4, '按钮文案最多 4 个字');
  assert.equal(page.data.answering, false);

  agree = true;
  page.onToggleAnswer({ detail: { value: true } });               // 点「我已了解」
  assert.equal(wx.calls.modal.length, 2);
  assert.equal(page.data.answering, true);
  assert.equal(page.data.estMax, 2);                              // 费用预估跟着更新（答题最多 +1 次/门）

  page.onToggleAnswer({ detail: { value: false } });              // 关掉不需要确认
  assert.equal(page.data.answering, false);
  page.onToggleAnswer({ detail: { value: true } });               // 再打开：已经确认过，不再弹
  assert.equal(wx.calls.modal.length, 2);
  assert.equal(page.data.answering, true);
});

test('下单关闭：选课页不读课程、仍能看到进行中的任务', () => withOrderClosed(async () => {
  const wx = makeWx({ 'study:account:u1': { username: '13800000000', password: 'pw', remember: true } });
  let scanned = 0;
  const task = baseTask({
    scanCourses: async () => { scanned++; return { courses: [] }; },
    listTasks: async () => ({ tasks: [{ taskId: 't_run', status: 'running' }] })
  });
  const page = loadPage('subpackages/study/submit/submit.js', { wx, task, payment: basePayment() });
  page.onLoad(); page.onShow();
  await flush();
  assert.equal(page.data.orderOpen, false);
  assert.equal(page.data.runningTaskId, 't_run');
  page.onScan();
  await flush();
  assert.equal(scanned, 0);
  page.onGoRunning();
  assert.equal(wx.calls.navigateTo[0], '/subpackages/study/progress/progress?taskId=t_run');
  page.onUnload();
}));

test('下单关闭：确认页按钮显示暂不支持且不提交，套餐都标「暂不支持」', () => withOrderClosed(async () => {
  const wx = makeWx();
  const submitted = [];
  const task = baseTask({ submitTask: async p => { submitted.push(p); return { taskId: 't' }; } });
  const page = loadPage('subpackages/study/confirm/confirm.js', {
    wx, task, payment: basePayment(),
    channel: { username: '13800000000', password: 'pw', courses: [{ courseId: '1', clazzId: '9', title: 'A' }] }
  });
  page.onLoad();
  await flush();
  assert.equal(page.data.step, 'blocked');
  assert.equal(page.data.ctaText, '暂不支持下单');
  assert.ok(page.data.products.every(p => p.disabled && p.disabledText === '暂不支持'));
  await page.onPrimary();
  assert.equal(submitted.length, 0);
  page.onUnload();
}));

test('确认页：WXML 里展示了自动答题的效果说明', () => {
  const wxml = fs.readFileSync(path.join(root, 'subpackages/study/confirm/confirm.wxml'), 'utf8');
  assert.match(wxml, /class="opt-note">\{\{answerNotice\}\}/);
});

test('WXML 标签配对 + 模板引用存在', () => {
  const files = ['submit/submit', 'confirm/confirm', 'progress/progress', 'orders/orders']
    .map(p => 'subpackages/study/' + p + '.wxml').concat(['subpackages/study/common/ui.wxml']);
  const templates = fs.readFileSync(path.join(root, 'subpackages/study/common/ui.wxml'), 'utf8');
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\{\{[\s\S]*?\}\}/g, 'X');
    const stack = [];
    for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
      const [, close, tag, , self] = m;
      if (self || tag === 'import') continue;
      if (close) {
        const top = stack.pop();
        assert.equal(top, tag, rel + ': </' + tag + '> 与 <' + top + '> 不配对');
      } else stack.push(tag);
    }
    assert.deepEqual(stack, [], rel + ': 未闭合 ' + stack.join(','));
    for (const m of fs.readFileSync(path.join(root, rel), 'utf8').matchAll(/<template is="(\w+)"/g)) {
      assert.ok(templates.includes('<template name="' + m[1] + '"'), rel + ' 引用了不存在的模板 ' + m[1]);
    }
  }
});
