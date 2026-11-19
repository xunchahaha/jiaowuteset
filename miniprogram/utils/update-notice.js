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

/**
 * 打开待看公告（版本更新 / 看板指定的进入弹窗都登记在这里）：跳转成功才清除，失败则下次再试。
 * page 用来记「跳转进行中」，启动时和云端公告拉回来后都会走到这里，不重复跳。
 * findNotice(id) 找不到这条（已被隐藏 / 删除）就直接清掉登记。
 */
function openPendingAnnouncement(wx, page, findNotice) {
  const pendingNoticeId = peekPendingAnnouncement(wx);
  if (!pendingNoticeId || page._openingNotice) {
    return false;
  }
  const notice = findNotice(pendingNoticeId);
  if (!notice) {
    clearPendingAnnouncement(wx);
    return false;
  }
  page._openingNotice = true;
  wx.navigateTo({
    url: '/subpackages/announcements/detail/detail?id=' + encodeURIComponent(notice.id),
    success: () => { page._openingNotice = false; clearPendingAnnouncement(wx); },
    fail: () => { page._openingNotice = false; },
    complete: () => { page._openingNotice = false; }
  });
  return true;
}

module.exports = {
  PENDING_ANNOUNCEMENT_KEY,
  queueUpdateAnnouncement,
  peekPendingAnnouncement,
  clearPendingAnnouncement,
  openPendingAnnouncement
};
