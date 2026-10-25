// 版本更新后只强制看一次公告：更新完成时登记待看公告，首页展示成功后清除。
// 与 utils/wakeup-export.js 一致，wx 由调用方显式传入，便于在测试中替换。
const PENDING_ANNOUNCEMENT_KEY = 'pendingAnnouncementView';

function queueUpdateAnnouncement(wx, version, notice) {
  if (!wx || !notice || !notice.id) {
    return false;
  }
  wx.setStorageSync(PENDING_ANNOUNCEMENT_KEY, {
    version: version || '',
    noticeId: notice.id
  });
  return true;
}

function peekPendingAnnouncement(wx) {
  if (!wx) {
    return '';
  }
  const pending = wx.getStorageSync(PENDING_ANNOUNCEMENT_KEY);
  if (!pending || typeof pending !== 'object' || !pending.noticeId) {
    return '';
  }
  return String(pending.noticeId);
}

function clearPendingAnnouncement(wx) {
  if (!wx) {
    return;
  }
  wx.removeStorageSync(PENDING_ANNOUNCEMENT_KEY);
}

module.exports = {
  PENDING_ANNOUNCEMENT_KEY,
  queueUpdateAnnouncement,
  peekPendingAnnouncement,
  clearPendingAnnouncement
};
