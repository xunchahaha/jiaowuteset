const cloud = require('wx-server-sdk');
const C = require('./settings');
const { createStore } = require('./store');
const { createService } = require('./service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const service = createService(
  createStore(db),
  data => cloud.openapi.subscribeMessage.send(data),
  Date.now,
  undefined,
  db
);

const ACTIONS = {
  ping: () => service.ping(),
  wallet: service.wallet,
  submitTask: service.submitTask,
  getProgress: service.getProgress,
  cancelTask: service.cancelTask,
  scanCourses: service.scanCourses,
  listCourses: service.listCourses,
  listTasks: service.listTasks,
  getAccount: service.getAccount,
  resumeTask: service.resumeTask,
  recordSubscription: service.recordSubscription,
  status: service.status
};

exports.main = async (event = {}) => {
  const { OPENID: openid, SOURCE: source } = cloud.getWXContext();

  // 定时触发器：分发通知
  if (source === 'wx_trigger') {
    try {
      return { success: true, data: await service.dispatch() };
    } catch (e) {
      return { success: false, errMsg: String(e.message || e) };
    }
  }

  // ping 是连通性自检，不依赖用户身份（供部署后从控制台/HTTP API 验证）
  if (event.type === 'ping') {
    try {
      return { success: true, data: await service.ping() };
    } catch (e) {
      return { success: false, errMsg: String(e.message || e) };
    }
  }

  // 运维补结算：只接受**没有 openid** 的调用（HTTP API / 同环境云函数，均需管理凭据）；
  // 小程序端调用一定带 openid，走不到这里。
  if (!openid && event.type === 'dispatch') {
    try {
      return { success: true, data: await service.dispatch() };
    } catch (e) {
      return { success: false, errMsg: String(e.message || e) };
    }
  }

  if (!openid) return { success: false, errMsg: '请从小程序登录后操作' };
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, event.type)) {
    return { success: false, errMsg: '未知操作' };
  }
  try {
    return { success: true, data: await ACTIONS[event.type](openid, event) };
  } catch (error) {
    const msg = error.message || '';
    const businessError = error.expose === true ||
      /^(订单|上次|次数|道具|支付|课程|题库|任务|续跑|查询|请先|操作标识|缺少|超星|未配置|服务端|订阅结果|该道具|iOS)/.test(msg);
    if (!businessError) console.error('[studyTask]', event.type, error);
    return { success: false, errMsg: businessError ? msg : '刷课服务处理失败，请稍后重试' };
  }
};
