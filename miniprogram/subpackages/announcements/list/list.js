const { withPageShare } = require('../../../utils/share');
const { getNotices, getNotice, refreshNotices } = require('../../../utils/notices');

Page(withPageShare({
  data: { notices: getNotices() },
  onShow() {
    this.setData({ notices: getNotices() });
    refreshNotices().then(changed => { if (changed) this.setData({ notices: getNotices() }); });
  },
  getShareConfig() { return { title: '教务助手 · 公告中心', path: '/subpackages/announcements/list/list' }; },
  openNotice(event) {
    const id = event.currentTarget.dataset.id;
    if (!getNotice(id)) return;
    wx.navigateTo({ url: '/subpackages/announcements/detail/detail?id=' + encodeURIComponent(id) });
  }
}));
