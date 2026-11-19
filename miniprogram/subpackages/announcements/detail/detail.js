const { withPageShare } = require('../../../utils/share');
const { getNotice, getLatestNotice } = require('../../../utils/notices');

// Keep subpackage assets out of the main package's initial dependencies.
// 公告的 contact.qr 填这里的键名（分包内的图片）；云端公告也可以直接填云存储 fileID。
const QR_IMAGES = {
  'feedback-group': '/subpackages/announcements/assets/feedback-group.jpg'
};
const REMOTE_RE = /^(cloud|https):\/\//;

function qrImageOf(notice) {
  const qr = notice && notice.contact && notice.contact.qr;
  if (!qr) return '';
  return REMOTE_RE.test(qr) ? qr : (QR_IMAGES[qr] || '');
}

Page(withPageShare({
  data: { notice: null, qrImage: '', imageError: false, previewing: false },

  onLoad(options) {
    const notice = options && options.id ? getNotice(options.id) : getLatestNotice();
    this.setData({ notice, qrImage: qrImageOf(notice), imageError: false });
  },
  getShareConfig() {
    return {
      title: this.data.notice ? this.data.notice.title : '教务助手公告',
      path: '/subpackages/announcements/detail/detail' + (this.data.notice ? '?id=' + encodeURIComponent(this.data.notice.id) : '')
    };
  },
  getTimelineShareConfig() { return this.getShareConfig(); },
  getShareCard() {
    const notice = this.data.notice;
    if (!notice) return null;
    return {
      theme: 'blue',
      eyebrow: '公告',
      headline: notice.title,
      sub: notice.publishedAt ? '发布于 ' + notice.publishedAt : '',
      note: notice.summary || ''
    };
  },
  getShareOptions() { return this.data.notice ? { id: this.data.notice.id } : {}; },
  onImageError() { this.setData({ imageError: true }); },
  previewQr() {
    if (!this.data.qrImage || this.data.previewing) return;
    this.setData({ previewing: true });
    if (REMOTE_RE.test(this.data.qrImage)) {
      wx.previewImage({
        current: this.data.qrImage,
        urls: [this.data.qrImage],
        fail: () => wx.showToast({ title: '图片打开失败，请重试', icon: 'none' }),
        complete: () => this.setData({ previewing: false })
      });
      return;
    }
    wx.getImageInfo({
      src: this.data.qrImage,
      success: (image) => {
        wx.previewImage({
          current: image.path,
          urls: [image.path],
          fail: () => wx.showToast({ title: '图片打开失败，请重试', icon: 'none' }),
          complete: () => this.setData({ previewing: false })
        });
      },
      fail: () => {
        this.setData({ previewing: false });
        wx.showToast({ title: '图片读取失败，请重新进入公告', icon: 'none' });
      }
    });
  },
  backHome() { wx.reLaunch({ url: '/pages/home/home' }); }
}));
