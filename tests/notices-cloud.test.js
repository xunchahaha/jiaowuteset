// 云端公告：小程序拉取 + 缓存兜底、拉到新公告后首页强制弹出、云函数读写。
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../miniprogram');
const NOTICES_PATH = require.resolve('../miniprogram/utils/notices');
const updateNotice = require('../miniprogram/utils/update-notice');
const L = require('../cloudfunctions/noticeFunctions/logic');
const { createService } = require('../cloudfunctions/noticeFunctions/service');

const CLOUD_NOTICE = {
  id: 'cloud-notice-20261101', title: '云端公告', summary: '来自云端', publishedAt: '2026-11-01',
  paragraphs: ['第一段'], pinned: true, forcePopup: true,
  contact: { channel: 'QQ群', name: 'zd教务', qr: 'feedback-group', instructions: '扫码', caption: '', label: '' }
};

// 每个用例一份全新的 notices 模块（模块里有节流状态）+ 假 wx
function freshNotices(callFunction) {
  const storage = {};
  const calls = [];
  global.wx = {
    getStorageSync: k => (k in storage ? storage[k] : ''),
    setStorageSync: (k, v) => { storage[k] = v; },
    cloud: callFunction ? {
      init() {},
      callFunction: o => { calls.push(o.data); callFunction(o); }
    } : undefined
  };
  delete require.cache[NOTICES_PATH];
  return { notices: require(NOTICES_PATH), storage, calls };
}

const reply = data => o => o.success({ result: { success: true, data } });

test('拉到云端公告：写缓存，之后读的都是云端公告；一分钟内不重复拉', async () => {
  const { notices, storage, calls } = freshNotices(reply({ notices: [CLOUD_NOTICE, { id: 'bad' }] }));
  assert.equal(notices.getLatestNotice().id, notices.BUNDLED_NOTICES[0].id, '没拉到之前用内置公告');
  assert.equal(await notices.refreshNotices(), true);
  assert.equal(storage[notices.CACHE_KEY].notices.length, 1, '字段不全的公告被丢掉');
  assert.equal(notices.getLatestNotice().id, CLOUD_NOTICE.id);
  assert.equal(notices.getNotice(CLOUD_NOTICE.id).contact.qr, 'feedback-group');
  assert.equal(notices.getNotices().length, 1);
  assert.equal(await notices.refreshNotices(), false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { type: 'list' });
});

test('云端没配置（notices: null）/ 调用失败 / 超时：保留现有公告，不报错', async () => {
  for (const cf of [reply({ notices: null }), o => o.fail(new Error('net')), o => o.success({ result: { success: false, errMsg: 'x' } })]) {
    const { notices, storage } = freshNotices(cf);
    assert.equal(await notices.refreshNotices(), false);
    assert.equal(storage[notices.CACHE_KEY], undefined);
    assert.equal(notices.getLatestNotice().id, notices.BUNDLED_NOTICES[0].id);
  }
  const { notices } = freshNotices(null);   // 老版本微信没有 wx.cloud
  assert.equal(await notices.refreshNotices(), false);
});

test('云端发了空列表：首页确实不再显示公告', async () => {
  const { notices } = freshNotices(reply({ notices: [] }));
  assert.equal(await notices.refreshNotices(), true);
  assert.equal(notices.getLatestNotice(), null);
});

test('首页：云端拉到新的强弹公告，当场弹一次，同一条不再弹', async () => {
  const storage = {};
  const navigations = [];
  const wx = {
    getStorageSync: k => (k in storage ? storage[k] : ''),
    setStorageSync: (k, v) => { storage[k] = v; },
    removeStorageSync: k => { delete storage[k]; },
    getAccountInfoSync: () => ({ miniProgram: { version: '1.0.0' } }),
    navigateTo: o => { navigations.push(o.url); if (o.success) o.success(); if (o.complete) o.complete(); },
    reLaunch: o => navigations.push(o.url)
  };
  storage.auth = { token: 't', userInfo: {} };
  let latest = { id: 'old', title: '旧', paragraphs: ['x'] };
  let pending = true;
  const fakeNotices = {
    getLatestNotice: () => latest,
    getNotice: id => (id === latest.id ? latest : null),
    refreshNotices: () => {
      const changed = pending;
      if (pending) { latest = CLOUD_NOTICE; pending = false; }
      return Promise.resolve(changed);
    }
  };
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  let app, home;
  const req = name => {
    if (name.endsWith('/notices')) return fakeNotices;
    if (name.endsWith('/update-notice')) return updateNotice;
    if (name.endsWith('/cache')) return { migrateLegacyCache() {} };
    return { withPageShare: d => d };
  };
  vm.runInNewContext(read('app.js'), { App: d => { app = d; }, wx, console, require: req });
  vm.runInNewContext(read('pages/home/home.js'), { Page: d => { home = d; }, wx, require: req, getApp: () => app });
  home.setData = d => Object.assign(home.data, d);

  app.onLaunch();             // 缓存里的旧公告没有 forcePopup：不登记
  home.onShow();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(home.data.notice.id, CLOUD_NOTICE.id);
  assert.deepEqual(navigations, ['/subpackages/announcements/detail/detail?id=' + CLOUD_NOTICE.id]);

  home.onShow();              // 再回首页：已弹过、云端没变化
  await new Promise(r => setTimeout(r, 0));
  assert.equal(navigations.length, 1);
});

test('公告详情：contact.qr 用分包图片键名或云存储 fileID', () => {
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  let list = [CLOUD_NOTICE, Object.assign({}, CLOUD_NOTICE, { id: 'remote', contact: Object.assign({}, CLOUD_NOTICE.contact, { qr: 'cloud://env/qr.jpg' }) }),
    Object.assign({}, CLOUD_NOTICE, { id: 'unknown', contact: Object.assign({}, CLOUD_NOTICE.contact, { qr: 'nope' }) })];
  const previews = [];
  let page;
  vm.runInNewContext(read('subpackages/announcements/detail/detail.js'), {
    Page: d => { page = d; },
    wx: { previewImage: o => { previews.push(o.current); o.complete(); } },
    require: name => (name.endsWith('/notices')
      ? { getNotice: id => list.find(n => n.id === id) || null, getLatestNotice: () => list[0] }
      : { withPageShare: d => d })
  });
  page.setData = d => Object.assign(page.data, d);
  page.onLoad({ id: CLOUD_NOTICE.id });
  assert.equal(page.data.qrImage, '/subpackages/announcements/assets/feedback-group.jpg');
  page.onLoad({ id: 'remote' });
  assert.equal(page.data.qrImage, 'cloud://env/qr.jpg');
  page.previewQr();
  assert.deepEqual(previews, ['cloud://env/qr.jpg']);
  page.onLoad({ id: 'unknown' });
  assert.equal(page.data.qrImage, '');
});

// ---------- 云函数 ----------
function fakeDb({ missing = false } = {}) {
  const docs = new Map();
  let exists = !missing;
  const notExist = () => Object.assign(new Error('collection not exist'), { errCode: -502005 });
  return {
    docs,
    createCollection: async () => { if (exists) throw new Error('already exists'); exists = true; },
    collection: () => ({
      limit: () => ({ get: async () => { if (!exists) throw notExist(); return { data: [...docs.values()].map(d => structuredClone(d)) }; } }),
      doc: id => ({
        set: async ({ data }) => { if (!exists) throw notExist(); docs.set(id, Object.assign({ _id: id }, data)); },
        remove: async () => { if (!exists) throw notExist(); docs.delete(id); }
      })
    })
  };
}

test('云函数：集合还不存在时 list 返回 null（小程序继续用内置公告）；首次写入自动建集合', async () => {
  const db = fakeDb({ missing: true });
  const s = createService(db, () => 1000);
  assert.deepEqual(await s.list(), { notices: null });
  await s.admin('upsert', { notice: CLOUD_NOTICE });
  const r = await s.list();
  assert.equal(r.notices.length, 1);
  assert.deepEqual(Object.keys(r.notices[0]).sort(), ['contact', 'forcePopup', 'id', 'paragraphs', 'pinned', 'publishedAt', 'summary', 'title']);
});

test('云函数：按发布日期新的在前，隐藏的不下发，可删除', async () => {
  let now = 1;
  const s = createService(fakeDb(), () => now++);
  await s.admin('upsert', { notice: Object.assign({}, CLOUD_NOTICE, { id: 'a', publishedAt: '2026-09-01' }) });
  await s.admin('upsert', { notice: Object.assign({}, CLOUD_NOTICE, { id: 'b', publishedAt: '2026-10-01' }) });
  await s.admin('upsert', { notice: Object.assign({}, CLOUD_NOTICE, { id: 'c', publishedAt: '2026-10-01', published: false }) });
  assert.deepEqual((await s.list()).notices.map(n => n.id), ['b', 'a']);
  assert.deepEqual((await s.admin('list')).notices.map(n => n.id), ['c', 'b', 'a']);
  await s.admin('remove', { id: 'b' });
  assert.deepEqual((await s.list()).notices.map(n => n.id), ['a']);
});

test('云函数：写入校验字段，坏数据报出原因', async () => {
  const s = createService(fakeDb());
  await assert.rejects(s.admin('upsert', { notice: { id: 'x y', title: 't', publishedAt: '2026-01-01', paragraphs: ['p'] } }), /id/);
  await assert.rejects(s.admin('upsert', { notice: { id: 'x', title: 't', publishedAt: '2026/01/01', paragraphs: ['p'] } }), /publishedAt/);
  await assert.rejects(s.admin('upsert', { notice: { id: 'x', title: 't', publishedAt: '2026-01-01', paragraphs: [] } }), /正文/);
  await assert.rejects(s.admin('upsert', { notice: Object.assign({}, CLOUD_NOTICE, { contact: { channel: 'QQ群' } }) }), /contact/);
  await assert.rejects(s.admin('drop', {}), /未知运维操作/);
});

test('内置公告都能通过云函数校验（seed 不会失败）', () => {
  delete require.cache[NOTICES_PATH];
  global.wx = undefined;
  for (const n of require(NOTICES_PATH).BUNDLED_NOTICES) assert.doesNotThrow(() => L.validateNotice(n), n.id);
});
