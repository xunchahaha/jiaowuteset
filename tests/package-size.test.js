const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { build, getPageRoutes } = require('../scripts/build-ui-package');
const root = path.resolve(__dirname, '../miniprogram');
const project = require('../project.config.json');
const app = require('../miniprogram/app.json');

const ui = build({ check: true });
assert(ui.bytes < 300000, 'Unused UI dependencies have expanded the runtime package');
assert.equal(ui.components.length, 12);
assert(!ui.components.some((component) => /grid|chat|qrcode/.test(component)));
assert(!fs.existsSync(path.join(root, 'envList.js')));
assert(fs.readFileSync(path.join(root, 'miniprogram_npm/tdesign-miniprogram/LICENSE'), 'utf8').includes('MIT License'));
for (const page of getPageRoutes(app)) {
  const config = JSON.parse(fs.readFileSync(path.join(root, page + '.json'), 'utf8'));
  const registered = { ...app.usingComponents, ...config.usingComponents };
  const markup = fs.readFileSync(path.join(root, page + '.wxml'), 'utf8');
  for (const [, name] of markup.matchAll(/<(t-[\w-]+)\b/g)) assert(registered[name], `${page}: unregistered ${name}`);
}

function excluded(relative) {
  return project.packOptions.ignore.some((rule) => rule.type === 'file' ? relative === rule.value
    : rule.type === 'folder' && (relative === rule.value || relative.startsWith(rule.value + '/')));
}
const subpackages = app.subPackages || app.subpackages || [];
function sourceBytes(dir, main = false) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const file = path.join(dir, entry.name);
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (excluded(relative) || (main && subpackages.some((group) => relative === group.root))) return total;
    return total + (entry.isDirectory() ? sourceBytes(file, main) : fs.statSync(file).size);
  }, 0);
}
const bytes = sourceBytes(root, true);
assert(bytes < 1.5 * 1024 * 1024, 'Pre-compilation main package exceeds the 1.5 MiB budget');
const subpackageBytes = subpackages.map((group) => ({ name: group.name || group.root, bytes: sourceBytes(path.join(root, group.root)) }));
for (const group of subpackageBytes) assert(group.bytes < 1.5 * 1024 * 1024, `${group.name} exceeds the source budget`);

let definition;
let ready;
let modal = null;
const appStorage = {};
const wx = {
  get cloud() { throw new Error('Unused template cloud initialization is still active'); },
  getUpdateManager: () => ({ onUpdateReady: (fn) => { ready = fn; }, onUpdateFailed() {} }),
  getStorageSync: (key) => (key in appStorage ? appStorage[key] : ''),
  setStorageSync: (key, value) => { appStorage[key] = value; },
  removeStorageSync: (key) => { delete appStorage[key]; },
  getAccountInfoSync: () => ({ miniProgram: { version: 'fixture-version' } }),
  showModal: (options) => { modal = options; }
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
  App: (value) => { definition = value; },
  wx,
  console,
  require: (name) => name.endsWith('/notices') ? require('../miniprogram/utils/notices') : require('../miniprogram/utils/update-notice')
});
definition.onLaunch();
assert.equal(typeof ready, 'function', 'Update manager must remain active');
assert.equal(modal, null, 'Launch must not show the retired hardcoded release note');
assert.equal(appStorage.lastSeenMiniProgramVersion, 'fixture-version', 'Current version must be recorded for update detection');
// 首次安装只会弹「forcePopup」公告（按公告 id 一次），版本更新流程见 tests/update-announcement.test.js
const firstNotice = require('../miniprogram/utils/notices').getLatestNotice();
assert.equal((appStorage.pendingAnnouncementView || {}).noticeId, firstNotice.forcePopup ? firstNotice.id : undefined,
  'First install may only queue a forcePopup notice');
console.log(`Package regression passed: ${ui.files} vendor files / ${ui.bytes} bytes; main source ${bytes} bytes; subpackages ${JSON.stringify(subpackageBytes)} (not official compiled sizes).`);
