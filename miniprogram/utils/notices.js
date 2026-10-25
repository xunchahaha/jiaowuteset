// 公告以云端为准（云函数 noticeFunctions 读 app_notices 集合，用 scripts/notice-admin.js 发布），
// 改公告不用发版。拉到的公告存本地缓存，下次启动先用缓存；从没拉到过（新安装且离线 / 云端未配置）
// 才用下面这份内置公告兜底。
// 首页和更新后展示首条公告，列表另按置顶排序；二维码图片放在公告分包内，contact.qr 填图片键名
// （见 announcements/detail/detail.js），也可以填云存储 fileID。
// forcePopup：首条公告带此标记时，每台设备进入首页都会强制看一次（按公告 id 记录，
// 不依赖版本号变化 —— 预览 / 体验版版本号恒为 dev-build，只靠版本号永远弹不出来）。
const config = require('./notification-config');

const FUNCTION_NAME = 'noticeFunctions';
const CACHE_KEY = 'cloudNotices';
const REFRESH_TIMEOUT_MS = 8000;
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

const BUNDLED_NOTICES = [
  {
    id: 'study-maintenance-20261022',
    pinned: true,
    forcePopup: true,
    title: '刷课服务维护中，剩余次数可退款',
    summary: '刷课暂停接新单，已提交的任务会继续刷完。有剩余次数的同学进QQ群联系客服退款。',
    publishedAt: '2026-10-22',
    paragraphs: [
      '刷课服务正在维护，即日起暂停接新单，首页和登录页的「刷课服务」入口暂时关闭。',
      '已经提交的任务不受影响，会继续刷完，并按实际完成情况结算次数，刷完照常发微信通知。',
      '还有剩余次数、想要退款的同学，请加入下方「zd教务」QQ群联系客服处理。请不要在群里发送账号和密码。',
      '恢复时间另行通知，给大家带来不便，敬请谅解。'
    ],
    contact: {
      channel: 'QQ群',
      name: 'zd教务',
      instructions: '长按下方图片保存，再打开 QQ 扫码加入群聊，联系群内客服退款。',
      caption: '点击图片可放大查看',
      label: 'zd教务QQ群二维码，点击放大',
      qr: 'feedback-group'
    }
  },
  {
    id: 'feedback-group-20260906',
    pinned: true,
    title: '反馈交流，欢迎加入QQ群',
    summary: '使用反馈、功能建议与日常交流，欢迎进群。',
    publishedAt: '2026-09-06',
    paragraphs: [
      '教务助手反馈交流群开通啦！使用中遇到问题、有想要的功能，或想和同学交流，都欢迎加入「zd教务」QQ群。',
      '反馈问题时，可以说明出现问题的页面和操作步骤，并附上截图，方便我们定位和改进。请注意遮挡个人信息，不要发送账号密码。'
    ],
    contact: {
      channel: 'QQ群',
      name: 'zd教务',
      instructions: '长按下方图片保存，再打开 QQ 扫码加入群聊。',
      caption: '点击图片可放大查看',
      label: 'zd教务QQ群二维码，点击放大',
      qr: 'feedback-group'
    }
  },
  {
    id: 'open-source-plan-20260920',
    title: '源码开源计划',
    summary: '小程序后续源码将全部开源，待代码审计完成后正式公开。',
    publishedAt: '2026-09-20',
    paragraphs: [
      '教务助手小程序后续源码将全部开源，欢迎大家查看代码、提出建议，一起完善小程序。',
      '源码将在代码审计完成后正式公开，具体开放时间以审计进度为准，请留意后续公告。',
      'GitHub 仓库：https://github.com/xunchahaha/jiaowuteset',
      '感谢大家一直以来的使用与支持！'
    ]
  },
  {
    id: 'class-reminder-20260908',
    title: '现已支持课前提醒',
    summary: '进入通知中心自动准备课表，设置提前时间，让微信服务通知提醒你上课。',
    publishedAt: '2026-09-08',
    paragraphs: [
      '教务助手现已支持课前提醒！从首页底部「通知中心」卡片，或课表底部「课前提醒」进入，即可管理提醒与通知次数。',
      '打开通知中心会自动更新当前学期课表，不用再手动同步。首次准备成功后默认开启提醒；如果你主动关闭过，会保留关闭状态。',
      '提醒时间支持提前 5、10、15、20、30、45、60 分钟。课表准备完成后，云端会按设置检查到期提醒，退出小程序后仍可提醒；网络和微信投递可能带来一定延迟。',
      '请点击「增加通知次数」并允许微信订阅。每次同意后可继续点击，记录在后台同步，待同步次数单独显示；这不会自动循环申请订阅。',
      '页面次数是本应用记录的预计可用次数，不是无限通知权限。次数用完需要再次订阅；微信若记住了你的选择，后续点击可能不再弹窗。',
      '你可以发送一条测试提醒，或查看最近发送记录。测试会消耗一次订阅机会；收不到消息时，请检查订阅权限、微信通知设置和发送记录。',
      '调课、换账号或换学期后，重新进入通知中心即可自动更新课表。仅上传提醒所需的课程、时间、老师和地点，不上传教务密码或登录令牌。',
      '使用中遇到问题或有功能建议，欢迎查看公告列表顶部置顶的QQ群公告，加入「zd教务」交流群反馈。'
    ]
  },
  {
    id: 'wakeup-export-20260908',
    title: '课表支持导出到 WakeUp 啦',
    summary: '整学期课表一键导出 CSV，通过微信会话发送；优化地点显示与文件发送流程。',
    publishedAt: '2026-09-08',
    paragraphs: [
      '新增 WakeUp 课表导出：进入「课表」，点击底部「更多 ··· → 导出 WakeUp CSV」。系统会读取当前学期全部周次，生成文件后点击「选择会话」，发送给微信联系人。',
      '收到文件后，在 WakeUp 中选择「Excel/CSV 导入」，不要选择树维 HTML 导入。请按导出提示核对开学日期、每天节数和上下课时间。',
      '导出地点更简洁：只保留 F2-318、E5-511 这样的教室编号，不再附带完整教学楼名称。',
      '完成弹窗会显示已读取周数、日期范围、上课次数和合并行数。同一课程的重复周次会合并，文件较小不代表漏课。',
      '优化文件发送：交给微信后保留本地源文件，避免过早清理影响后台发送。请在聊天中确认发送完成；之前已过期或发送中断的附件，请重新导出发送。',
      '取消或转发失败后，可在「更多」中选择「重新转发已生成 CSV」，无需重读整学期；课表有更新时，请选择「重新读取并导出」。',
      '文件包含个人课表与任课教师信息，请确认接收人。源文件保存在小程序本地，清除小程序数据时一并清理。'
    ]
  }
];

function str(v) { return typeof v === 'string' ? v : ''; }

// 云端下发的公告逐条校验：字段不全的丢掉，不让一条坏数据弄挂首页
function normalizeNotice(raw) {
  if (!raw || typeof raw !== 'object' || !str(raw.id) || !str(raw.title)) return null;
  const paragraphs = Array.isArray(raw.paragraphs) ? raw.paragraphs.filter(p => typeof p === 'string' && p) : [];
  if (!paragraphs.length) return null;
  const notice = {
    id: raw.id,
    title: raw.title,
    summary: str(raw.summary),
    publishedAt: str(raw.publishedAt),
    paragraphs,
    pinned: raw.pinned === true,
    forcePopup: raw.forcePopup === true
  };
  const c = raw.contact;
  if (c && typeof c === 'object' && str(c.channel) && str(c.name) && str(c.qr)) {
    notice.contact = {
      channel: c.channel, name: c.name, qr: c.qr,
      instructions: str(c.instructions), caption: str(c.caption), label: str(c.label)
    };
    if (str(c.copyLabel)) { notice.contact.copyLabel = c.copyLabel; notice.contact.copyHint = str(c.copyHint); }
  }
  return notice;
}

function storage() {
  return typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function' ? wx : null;
}

function readCache() {
  const w = storage();
  if (!w) return null;
  try {
    const c = w.getStorageSync(CACHE_KEY);
    return c && Array.isArray(c.notices) ? c.notices : null;
  } catch (e) {
    return null;
  }
}

function currentNotices() { return readCache() || BUNDLED_NOTICES; }

function getLatestNotice() { return currentNotices()[0] || null; }
function getNotice(id) { return currentNotices().find((notice) => notice.id === id) || null; }
function getNotices() {
  const list = currentNotices();
  return list.filter(notice => notice.pinned).concat(list.filter(notice => !notice.pinned));
}

let inflight = null;
let lastFetchAt = 0;

function fetchCloud() {
  return new Promise((resolve, reject) => {
    if (!config.cloudEnvId || typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      reject(new Error('云开发不可用'));
      return;
    }
    wx.cloud.init({ env: config.cloudEnvId, traceUser: false });
    // callFunction 自身没有超时，网络卡住时回调可能永远不来
    const timer = setTimeout(() => reject(new Error('公告读取超时')), REFRESH_TIMEOUT_MS);
    wx.cloud.callFunction({
      name: FUNCTION_NAME,
      data: { type: 'list' },
      success: (res) => {
        clearTimeout(timer);
        const r = res && res.result;
        if (r && r.success) resolve(r.data || {});
        else reject(new Error((r && r.errMsg) || '公告服务返回异常'));
      },
      fail: (err) => { clearTimeout(timer); reject(err); }
    });
  });
}

/**
 * 拉云端公告并更新缓存，resolve(true) 表示公告有变化（页面需要重新读）。
 * 失败 / 云端未配置时保留现有公告，resolve(false)；一分钟内重复调用直接跳过。
 */
function refreshNotices() {
  if (inflight) return inflight;
  if (Date.now() - lastFetchAt < MIN_REFRESH_INTERVAL_MS) return Promise.resolve(false);
  inflight = fetchCloud()
    .then((data) => {
      lastFetchAt = Date.now();
      if (!Array.isArray(data.notices)) return false;
      const next = data.notices.map(normalizeNotice).filter(Boolean);
      const w = storage();
      if (!w) return false;
      if (JSON.stringify(next) === JSON.stringify(readCache())) return false;
      w.setStorageSync(CACHE_KEY, { notices: next, fetchedAt: Date.now() });
      return true;
    })
    .catch(() => false)
    .then((changed) => { inflight = null; return changed; });
  return inflight;
}

module.exports = { BUNDLED_NOTICES, CACHE_KEY, normalizeNotice, getLatestNotice, getNotice, getNotices, refreshNotices };
