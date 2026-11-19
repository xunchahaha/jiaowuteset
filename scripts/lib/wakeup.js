'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const csv = require('../../miniprogram/utils/wakeup-csv');

// Reuse the mini-program API verbatim, but isolate its verbose credential logs.
function createApi(fetchImpl = globalThis.fetch, report = () => {}) {
  const filename = path.resolve(__dirname, '../../miniprogram/utils/api.js');
  const module = { exports: {} };
  const wx = {
    request(options) {
      const endpoint = new URL(options.url).pathname.split('/app-service')[1];
      Promise.resolve().then(() => fetchImpl(options.url, {
        method: options.method, headers: options.header, body: options.data,
        signal: AbortSignal.timeout(options.timeout), redirect: 'error'
      })).then(async (response) => {
        if (!response.ok) throw new Error('http');
        const data = await response.json();
        report({ endpoint, status: response.status, code: data.err_code });
        // Do not propagate a server message that might contain account data.
        if (data.err_code !== '00000') {
          data.err_msg = '教务接口返回失败，请检查账号密码或登录状态';
        }
        options.success({ statusCode: response.status, data });
      }).catch(() => options.fail({ errMsg: 'network request failed' }));
    },
    removeStorageSync() {}, showToast() {}, reLaunch() {}
  };
  const context = vm.createContext({
    module, exports: module.exports, require: createRequire(filename), wx,
    console: { log() {}, error() {} }
  });
  new vm.Script(fs.readFileSync(filename, 'utf8'), { filename }).runInContext(context);
  return module.exports;
}

module.exports = { ...csv, createApi };
