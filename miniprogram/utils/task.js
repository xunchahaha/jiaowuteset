const config = require('./task-config');
let initialized = false;

// wx.cloud.callFunction 自身**没有超时**：网络卡住时回调可能永远不触发，
// 调用方（按钮 loading / 轮询）就会无限转圈。这里统一加客户端兜底超时。
const DEFAULT_TIMEOUT_MS = 20000;
// 读课程（扫描）在服务端可能耗时 30~60 秒，单独放宽（页面侧另有 120 秒硬兜底）。
const SCAN_TIMEOUT_MS = 130000;

/**
 * 调用刷课云函数。
 * options.timeoutMs 可覆盖默认客户端超时（毫秒）。
 */
function call(type, params = {}, options = {}) {
  if (!config.cloudEnvId) {
    return Promise.reject(new Error('刷课服务尚未配置云开发环境，请联系开发者完成部署'));
  }
  if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
    return Promise.reject(new Error('请升级微信后再使用刷课服务'));
  }
  if (!initialized) {
    wx.cloud.init({ env: config.cloudEnvId, traceUser: false });
    initialized = true;
  }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    // 超时后主动 reject 一个可读错误；回调晚到时因 settled 已置位而被丢弃，不会二次结算。
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('刷课服务响应超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒），请检查网络后重试'));
    }, timeoutMs);
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    wx.cloud.callFunction({
      name: config.functionName,
      data: Object.assign({}, params, { type }),
      success: response => {
        const result = response.result;
        if (!result || !result.success) {
          done(reject, new Error((result && result.errMsg) || '刷课服务返回异常'));
        } else {
          done(resolve, result.data);
        }
      },
      fail: () => done(reject, new Error('刷课服务连接失败，请检查网络或云函数部署'))
    });
  });
}

function newRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

const submitTask = payload => call('submitTask', payload);
const getProgress = taskId => call('getProgress', { taskId });
const cancelTask = taskId => call('cancelTask', { taskId });
const scanCourses = payload => call('scanCourses', payload, { timeoutMs: SCAN_TIMEOUT_MS });
const listCourses = () => call('listCourses');
const listTasks = () => call('listTasks');
const status = () => call('status');

/**
 * 钱包：{ balance, debt, reserved, available }
 *   debt     上次自动答题未结清的次数（调用时会先用余额自动补扣）
 *   reserved 进行中任务占用的次数
 */
const wallet = () => call('wallet');

/** 服务端保存的超星账号（**只回用户名**，密码密文永不下发） */
const getAccount = () => call('getAccount');

/**
 * 断点续跑：题库次数用尽被暂停的任务，充值后接着刷（同一 taskId、不重复扣刷课次数）。
 * tikuQuota 传充值后的题库余额，服务端据此重新封顶。
 */
const resumeTask = (taskId, tikuQuota) => call('resumeTask', { taskId, tikuQuota });

/**
 * 申请订阅消息额度（一次性订阅：同意一次攒一条）。
 * templateIds 最多 3 个。
 */
function requestSubscription(templateIds) {
  return new Promise((resolve, reject) => {
    if (!wx.requestSubscribeMessage) {
      reject(new Error('当前微信版本不支持订阅消息'));
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: templateIds.slice(0, 3),
      success: resolve,
      fail: err => reject(new Error(err.errMsg || '订阅失败'))
    });
  });
}

/**
 * 申请额度并把「同意」上报云端记账。
 * 返回 { accepted: [templateId...] }
 */
async function grantSubscribe(templateIds) {
  const res = await requestSubscription(templateIds);
  const accepted = [];
  for (const id of templateIds) {
    if (res[id] === 'accept') {
      accepted.push(id);
      // 逐条上报，按 requestId 幂等；失败不阻塞其余
      try {
        await call('recordSubscription', {
          requestId: newRequestId(), templateId: id, accepted: true
        });
      } catch (e) { /* 上报失败不影响用户操作，下次可重试 */ }
    }
  }
  return { accepted };
}

module.exports = {
  call, newRequestId,
  submitTask, getProgress, cancelTask, scanCourses, listCourses, listTasks, status,
  getAccount, resumeTask, wallet,
  requestSubscription, grantSubscribe,
  config
};
