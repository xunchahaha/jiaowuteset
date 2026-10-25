const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../miniprogram');
const realNotices = require('../miniprogram/utils/notices');
const updateNotice = require('../miniprogram/utils/update-notice');
// 版本更新流程用一个不带 forcePopup 的首条公告来测，强制弹出单独在文件末尾测
const plain = realNotices.getNotice('feedback-group-20260906');
const notices = { getLatestNotice: () => plain, getNotice: id => realNotices.getNotice(id), refreshNotices: () => Promise.resolve(false) };
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function createEnv(getVersion) {
  const storage = {};
  const modals = [];
  const navigations = [];
  let applied = 0;
  const wx = {
    getStorageSync: (key) => (key in storage ? storage[key] : ''),
    setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: (key) => { delete storage[key]; },
    getAccountInfoSync: () => ({ miniProgram: { version: getVersion() } }),
    getUpdateManager: () => ({
      onUpdateReady: (fn) => { wx.onReady = fn; },
      onUpdateFailed() {},
      applyUpdate: () => { applied += 1; }
    }),
    showModal: (options) => { modals.push(options); },
    showToast: () => {},
    navigateTo: (options) => {
      navigations.push(options.url);
      if (options.success) options.success();
    },
    reLaunch: (options) => { navigations.push(options.url); }
  };
  return { wx, storage, modals, navigations, applied: () => applied };
}

function loadApp(wx, noticeModule = notices) {
  let app;
  vm.runInNewContext(read('app.js'), {
    App: (definition) => { app = definition; },
    wx,
    console: { log() {}, error() {}, warn() {} },
    require: (name) => {
      if (name.endsWith('/notices')) return noticeModule;
      if (name.endsWith('/cache')) return { migrateLegacyCache() {} };
      return updateNotice;
    }
  });
  return app;
}

function loadHome(wx, noticeModule = notices) {
  let page;
  vm.runInNewContext(read('pages/home/home.js'), {
    Page: (definition) => { page = definition; },
    wx,
    require: (name) => {
      if (name.endsWith('/notices')) return noticeModule;
      if (name.endsWith('/update-notice')) return updateNotice;
      return { withPageShare: (definition) => definition };
    }
  });
  page.setData = (data) => Object.assign(page.data, data);
  return page;
}

let version = '1.0.0';
const env = createEnv(() => version);
env.wx.setStorageSync('auth', { token: 'fixture-token', userInfo: { user_name: '示例同学' } });

const app = loadApp(env.wx);
const home = loadHome(env.wx);
const latest = notices.getLatestNotice();
const detailUrl = '/subpackages/announcements/detail/detail?id=' + latest.id;

// 1) 首次安装：不登记、不弹窗、不跳转
app.onLaunch();
assert.equal(env.storage.pendingAnnouncementView, undefined, 'First install must not queue the announcement');
assert.equal(env.modals.length, 0, 'Launch must not show the retired hardcoded release note');
home.onShow();
assert.deepEqual(env.navigations, [], 'First install must not open the announcement');

// 2) 更新管理器仍可用：新版本下载完成后询问是否重启
env.wx.onReady();
assert.equal(env.modals[0].title, '更新提示');
env.modals[0].success({ confirm: true });
assert.equal(env.applied(), 1, 'Confirming the update prompt must call applyUpdate');

// 3) 更新完成后的第一次启动：登记最新公告，进入首页强制看一次并清除
version = '1.0.1';
app.onLaunch();
assert(env.storage.pendingAnnouncementView, 'A version change must queue the announcement');
assert.equal(env.storage.pendingAnnouncementView.version, '1.0.1');
assert.equal(env.storage.pendingAnnouncementView.noticeId, latest.id);
home.onShow();
assert.deepEqual(env.navigations, [detailUrl], 'Home must open the queued announcement once');
assert.equal(env.storage.pendingAnnouncementView, undefined, 'Opening the announcement must clear the queue');

// 4) 只看一次：重复进入首页、再次冷启动都不再出现
home.onShow();
assert.deepEqual(env.navigations, [detailUrl], 'Returning to home must not reopen the announcement');
app.onLaunch();
home.onShow();
assert.deepEqual(env.navigations, [detailUrl], 'Relaunching the same version must not reopen the announcement');

// 5) 下一次更新后再看一次
version = '1.0.2';
app.onLaunch();
home.onShow();
assert.deepEqual(env.navigations, [detailUrl, detailUrl], 'The next update must queue one more view');

// 6) 未登录时保留待看公告，登录后再补看
version = '1.0.3';
app.onLaunch();
env.storage.auth = null;
home.onShow();
assert.equal(env.navigations[env.navigations.length - 1], '/pages/login/login', 'Logged out home must go to login');
assert(env.storage.pendingAnnouncementView, 'Logged out users must keep the queued announcement');
env.storage.auth = { token: 'fixture-token' };
home.onShow();
assert.equal(env.navigations[env.navigations.length - 1], detailUrl, 'The queued announcement must be shown after login');
assert.equal(env.storage.pendingAnnouncementView, undefined);

// 7) 跳转失败时保留，下一次进入首页重试
version = '1.0.4';
app.onLaunch();
env.wx.navigateTo = (options) => { env.navigations.push('FAILED'); if (options.fail) options.fail(); };
home.onShow();
assert(env.storage.pendingAnnouncementView, 'A failed navigation must keep the announcement queued');
assert.equal(updateNotice.peekPendingAnnouncement(env.wx), latest.id);

// 8) forcePopup：首条公告每台设备强制看一次（含新安装、版本号不变的预览版），按公告 id 记录
{
  const forced = realNotices.getLatestNotice();
  assert.equal(forced.forcePopup, true);
  const e = createEnv(() => 'dev-build');
  e.wx.setStorageSync('auth', { token: 'fixture-token' });
  const a = loadApp(e.wx, realNotices);
  const h = loadHome(e.wx, realNotices);
  a.onLaunch();                                         // 新安装
  h.onShow();
  const forcedUrl = '/subpackages/announcements/detail/detail?id=' + forced.id;
  assert.deepEqual(e.navigations, [forcedUrl], 'A forcePopup notice must open on first entry');
  a.onLaunch(); h.onShow();                             // 同版本再次冷启动
  assert.deepEqual(e.navigations, [forcedUrl], 'A forcePopup notice must only open once per device');
}

console.log('Update announcement regression passed: first install silent, one forced view per version change, cleared after view, retried until shown; forcePopup once per device.');
