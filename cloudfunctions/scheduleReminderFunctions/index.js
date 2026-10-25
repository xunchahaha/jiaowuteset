const cloud = require('wx-server-sdk');
const C = require('./settings');
const { createStore } = require('./store');
const { createService } = require('./service');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const service = createService(createStore(db), data => cloud.openapi.subscribeMessage.send(data));

exports.main = async (event = {}) => {
  const { OPENID: openid, SOURCE: source } = cloud.getWXContext();
  // Only the platform timer dispatches all users. Client OPENID is ignored.
  if (source === 'wx_trigger') {
    return { success: true, data: await service.dispatch() };
  }
  if (!openid) return { success: false, errMsg: '请从小程序登录后操作' };
  const actions = { getStatus: service.status, recordSubscription: service.recordSubscription,
    saveSettings: service.settings, syncPlan: service.sync, sendTest: service.test };
  if (!Object.prototype.hasOwnProperty.call(actions, event.type)) return { success: false, errMsg: '未知操作' };
  try {
    return { success: true, data: await actions[event.type](openid, event) };
  } catch (error) {
    const businessError = /^(操作标识|订阅结果|提醒设置|请先同步|请先增加|请稍后再发送|课程|待同步)/.test(error.message || '');
    return { success: false, errMsg: businessError ? error.message : '提醒服务处理失败，请检查云端配置或稍后重试' };
  }
};
