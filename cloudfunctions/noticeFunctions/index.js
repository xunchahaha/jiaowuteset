const cloud = require('wx-server-sdk');
const { createService } = require('./service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const service = createService(cloud.database());

exports.main = async (event = {}) => {
  const { OPENID: openid } = cloud.getWXContext();
  try {
    // 公告是公开内容：小程序端不要求登录教务，有微信身份即可读
    if (event.type === 'list') return { success: true, data: await service.list() };
    // 运维写入只接受**没有 openid** 的调用（HTTP API，需管理凭据）；小程序端调用一定带 openid
    if (!openid && event.adminAction) {
      return { success: true, data: await service.admin(event.adminAction, event) };
    }
    return { success: false, errMsg: '未知操作' };
  } catch (error) {
    const business = error.expose === true || /^(公告|publishedAt|contact)/.test(error.message || '');
    if (!business) console.error('[notice]', event.type || event.adminAction, error);
    return { success: false, errMsg: business ? error.message : '公告服务处理失败' };
  }
};
