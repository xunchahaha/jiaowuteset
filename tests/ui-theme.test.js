const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../miniprogram');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const app = JSON.parse(read('app.json'));
const icons = read('miniprogram_npm/tdesign-miniprogram/icon/icon.wxss');
let page;
const navigations = [];
let auth = { token: 'fixture', offline: true, userInfo: { user_name: '示例同学' } };
vm.runInNewContext(read('pages/home/home.js'), {
  require: (name) => {
    if (name.endsWith('/notices')) return require('../miniprogram/utils/notices');
    if (name.endsWith('/update-notice')) return require('../miniprogram/utils/update-notice');
    if (name.endsWith('/study')) return require('../miniprogram/utils/study');
    return { withPageShare: (definition) => definition };
  },
  Page: (definition) => { page = definition; },
  wx: {
    getStorageSync: () => auth,
    removeStorageSync: () => { auth = null; },
    navigateTo: ({ url }) => navigations.push(url),
    reLaunch: ({ url }) => navigations.push(url)
  }
});
page.setData = (data) => Object.assign(page.data, data);
page.onShow();
assert.equal(page.data.displayName, '示例同学');
assert.equal(page.data.offlineMode, true);
const home = read('pages/home/home.wxml');
assert.equal((home.match(/class="service-entry"/g) || []).length, 7);
assert(!/brand-bar|schedule-entry|profile-entry|<button\b/.test(home));
for (const [handler, target] of Object.entries({
  goGrades: 'grades', goSchedule: 'schedule', goExam: 'exam',
  goTextbook: 'textbook', goMy: 'my', goClassroom: 'classroom'
})) {
  assert(home.includes(`bindtap="${handler}"`), `Missing home entry: ${handler}`);
  page[handler]();
  assert.equal(navigations.pop(), `/pages/${target}/${target}`);
}
// 刷课下单关闭：入口上锁，点击弹「维护中」，「加群退款」跳 QQ 群公告
const modals = [];
global.wx = {
  navigateTo: ({ url }) => navigations.push(url),
  showModal: (o) => { modals.push(o); o.success({ confirm: true }); }
};
assert.equal(page.data.studyLocked, true);
assert(home.includes("studyLocked ? 'lock-on'"));
page.goStudy();
assert.equal(modals[0].title, '刷课服务维护中');
assert.equal(modals[0].confirmText, '加群退款');
assert.equal(navigations.pop(), '/subpackages/announcements/detail/detail?id=study-maintenance-20261022');
assert(require('../miniprogram/utils/notices').getNotice('study-maintenance-20261022').contact);
page.onLogout();
assert.equal(auth, null);
assert.equal(navigations.pop(), '/pages/login/login');
page.onShow();
assert.equal(navigations.pop(), '/pages/login/login');

for (const route of require('../scripts/build-ui-package').getPageRoutes(app)) {
  const css = read(`${route}.wxss`);
  const markup = read(`${route}.wxml`);
  assert(!/gradient\(|#52c41a|#389e0d/i.test(css), `Legacy theme in ${route}`);
  for (const match of markup.matchAll(/<t-icon\b[^>]*\bname="([\w-]+)"/g)) {
    assert(icons.includes(`.t-icon-${match[1]}:before`), `Unknown icon ${match[1]}`);
  }
  for (const match of css.matchAll(/@import\s+["']([^"']+)/g)) {
    assert(fs.existsSync(path.resolve(root, path.dirname(route), match[1])));
  }
}
assert(fs.statSync(path.join(root, 'assets/brand.png')).size > 0);
const timetable = read('styles/timetable.wxss');
// The schedule page shares its week layout (and ROW_HEIGHT) with the login prewarm.
for (const [name, script] of [['schedule', 'utils/schedule-week.js'], ['classroom-detail', 'pages/classroom-detail/classroom-detail.js']]) {
  assert(read(script).includes('const ROW_HEIGHT = 110;'));
  assert(read(`pages/${name}/${name}.wxss`).includes('styles/timetable.wxss'));
}
assert(/\.time-slot\s*\{[^}]*height: 110rpx/.test(timetable));
assert(/\.slot-line\s*\{[^}]*height: 110rpx/.test(timetable));
assert(/\.lesson-roomy \.lesson-teacher\s*\{ display: block/.test(timetable));
assert(read('pages/schedule/schedule.wxml').includes("lesson.height >= 220 ? 'lesson-roomy'"));
for (let i = 1; i <= 8; i++) assert(timetable.includes(`.lesson-block.color-${i}`));
const theme = read('app.wxss');
assert(theme.includes('--td-cell-title-font:'));
assert(theme.includes('--td-cell-description-font:'));
assert.equal(app.window.navigationBarBackgroundColor, '#F7F9FB');
console.log('UI theme regression passed: six routes, offline/logout, main/subpackage page themes, icons, imports, 110rpx geometry and teacher visibility.');
