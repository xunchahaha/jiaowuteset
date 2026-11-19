const assert = require('assert');
const test = require('node:test');

// 记录绘制调用的假 ctx：measureText 按字符数估宽，够验证截断与流程不报错
function fakeContext() {
  const texts = [];
  const gradient = { addColorStop() {} };
  const ctx = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'left', textBaseline: 'alphabetic',
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
    texts,
    save() {}, restore() {}, scale() {}, beginPath() {}, closePath() {}, moveTo() {}, arcTo() {}, arc() {},
    fill() {}, stroke() {}, clip() {}, fillRect() {}, drawImage() {},
    createLinearGradient: () => gradient,
    measureText(value) {
      const size = Number((/(\d+)px/.exec(ctx.font) || [0, 20])[1]);
      return { width: Array.from(String(value)).length * size };
    },
    fillText(value) { texts.push(String(value)); }
  };
  return ctx;
}

function installWx(options) {
  const opts = options || {};
  const calls = { render: 0 };
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    showShareMenu() {},
    createOffscreenCanvas() {
      calls.render += 1;
      return {
        getContext: () => fakeContext(),
        createImage() {
          const image = {};
          setTimeout(() => image.onload && image.onload(), 0);
          return image;
        }
      };
    },
    canvasToTempFilePath(o) {
      if (opts.hang) return;
      setTimeout(() => (opts.fail ? o.fail({ errMsg: 'fail' }) : o.success({ tempFilePath: 'wxfile://tmp/card-' + calls.render + '.jpg' })), 0);
    }
  };
  return calls;
}

function freshModules() {
  for (const name of ['share', 'share-card']) {
    delete require.cache[require.resolve('../miniprogram/utils/' + name)];
  }
  return {
    share: require('../miniprogram/utils/share'),
    card: require('../miniprogram/utils/share-card')
  };
}

function makePage(config, route, data) {
  const page = Object.assign({}, config, { route, data: data || {} });
  return page;
}

test('normalizeSpec 限制行数、过滤空行并钳制进度', () => {
  const { card } = freshModules();
  const spec = card.normalizeSpec({
    theme: 'nope',
    rows: [{ label: 'a', text: '1' }, { label: 'b', text: '' }, { label: 'c', text: '2' }, { label: 'd', text: '3' }, { label: 'e', text: '4' }],
    progress: 140
  });
  assert.equal(spec.theme, 'blue');
  assert.deepEqual(spec.rows.map((r) => r.text), ['1', '2', '3']);
  assert.equal(spec.progress, 100);
  assert.equal(card.normalizeSpec({}).progress, null);
  assert.equal(card.normalizeSpec({ headline: '' }).headline, '教务助手');
});

test('lessonRowsForDate 按节次排序并去重', () => {
  const { card } = freshModules();
  const rows = card.lessonRowsForDate([
    { date: '2026-10-12', lessons: [
      { courseName: '大学物理', startUnit: 5, startTime: '14:00', place: '教二 201' },
      { courseName: '高等数学', startUnit: 1, startTime: '08:30', place: '教一 101' },
      { courseName: '高等数学', startUnit: 1, startTime: '08:30', place: '教一 101' }
    ] }
  ], '2026-10-12');
  assert.deepEqual(rows, [
    { label: '08:30', text: '高等数学 · 教一 101' },
    { label: '14:00', text: '大学物理 · 教二 201' }
  ]);
  assert.deepEqual(card.lessonRowsForDate([], '2026-10-12'), []);
});

test('所有面板形态都能画出来，长标题会被截断', () => {
  const { card } = freshModules();
  const longTitle = '这是一个特别特别特别特别特别特别特别特别特别特别特别特别长的公告标题';
  const specs = [
    { headline: '今天有 3 节课', rows: [{ label: '08:30', text: '高等数学' }] },
    { headline: '成绩一览', stats: [{ value: '3.62', label: '平均绩点' }] },
    { headline: '刷课中', progress: 42, note: '已完成 1/3 门' },
    { headline: longTitle, note: '摘要文字', chips: ['a', 'b'] },
    { headline: '教务助手', chips: ['今日课表', '成绩绩点', '考试安排'] }
  ];
  for (const spec of specs) {
    for (const kind of ['message', 'timeline']) {
      const ctx = fakeContext();
      card.drawShareCard(ctx, spec, { kind });
      assert(ctx.texts.length > 0);
    }
  }
  const ctx = fakeContext();
  card.drawShareCard(ctx, { headline: longTitle }, { kind: 'message' });
  assert(ctx.texts.some((t) => t.endsWith('…')), 'over-long headline should be ellipsized');
});

test('会话分享：首次用 promise 现画，之后直接命中缓存', async () => {
  const calls = installWx();
  const { share } = freshModules();
  const config = share.withPageShare({
    getShareCard() { return { headline: '今天有 2 节课', eyebrow: '今日课表' }; },
    getShareConfig() { return { title: '今日我有2节课' }; }
  });
  const page = makePage(config, 'pages/schedule/schedule');
  const first = page.onShareAppMessage({});
  assert.equal(first.title, '今日我有2节课');
  assert(first.promise, 'uncached card should be rendered through promise');
  const resolved = await first.promise;
  assert.equal(resolved.title, '今日我有2节课');
  assert.equal(resolved.path, '/pages/schedule/schedule');
  assert.match(resolved.imageUrl, /^wxfile:\/\/tmp\//);
  const second = page.onShareAppMessage({});
  assert.equal(second.imageUrl, resolved.imageUrl);
  assert(!second.promise);
  assert.equal(calls.render, 1);
});

test('画图失败时退回不带封面的分享', async () => {
  installWx({ fail: true });
  global.wx.getFileSystemManager = () => ({ writeFile: (o) => o.fail({ errMsg: 'fail' }) });
  const { share } = freshModules();
  const page = makePage(share.withPageShare({}), 'pages/classroom/classroom');
  const payload = await page.onShareAppMessage({}).promise;
  assert.deepEqual(payload, { title: '空教室', path: '/pages/classroom/classroom' });
});

test('朋友圈分享只用预先画好的图', async () => {
  installWx();
  const { share } = freshModules();
  const page = makePage(share.withPageShare({}), 'pages/home/home');
  assert.equal(page.onShareTimeline().imageUrl, undefined);
  page.onShow();
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.match(page.onShareTimeline().imageUrl || '', /^wxfile:\/\/tmp\//);
  page.onUnload();
});

test('分享标题不带个人姓名', () => {
  installWx();
  const { share } = freshModules();
  const page = makePage(share.withPageShare({}), 'pages/my/my', { profileName: '张三', displayName: '张三' });
  const payload = page.onShareAppMessage({});
  assert(!payload.title.includes('张三'));
  assert(!JSON.stringify(share.DEFAULT_CARDS['pages/my/my']).includes('张三'));
});
