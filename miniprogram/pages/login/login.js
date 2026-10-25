const api = require('../../utils/api');
const { withPageShare } = require('../../utils/share');
const { warmEssentialCaches } = require('../../utils/warm-cache');
const study = require('../../utils/study');

const LOGIN_TIMEOUT_MS = 6000;
const LOGIN_PREFS_KEY = 'loginPrefs';

function normalizeLoginPrefs(raw) {
  const accounts = [];
  const seen = {};

  if (raw && Array.isArray(raw.accounts)) {
    raw.accounts.forEach((item) => {
      const username = item && item.username ? String(item.username).trim() : '';
      if (!username || seen[username]) {
        return;
      }
      seen[username] = true;
      accounts.push({
        username,
        password: item && item.password ? String(item.password) : '',
        auth: item && item.auth ? item.auth : null
      });
    });
  }

  if (raw && raw.username) {
    const username = String(raw.username).trim();
    if (username && !seen[username]) {
      accounts.push({
        username,
        password: raw.remember && raw.password ? String(raw.password) : '',
        auth: raw.auth || null
      });
    }
  }

  return {
    accounts,
    lastUsername: raw && raw.lastUsername ? String(raw.lastUsername).trim() : (raw && raw.username ? String(raw.username).trim() : '')
  };
}

function getStoredAccount(accounts, username) {
  const target = username ? String(username).trim() : '';
  if (!target) {
    return null;
  }
  for (let index = 0; index < accounts.length; index += 1) {
    if (accounts[index].username === target) {
      return accounts[index];
    }
  }
  return null;
}

function getAuthUserCode(auth) {
  const userInfo = auth && auth.userInfo ? auth.userInfo : {};
  return String(userInfo.user_code || userInfo.userCode || '').trim();
}

function cloneAuth(auth) {
  if (!auth || typeof auth !== 'object') {
    return null;
  }
  return JSON.parse(JSON.stringify(auth));
}

function markOfflineAuth(auth, reason) {
  const next = cloneAuth(auth);
  if (!next || !next.token || !next.secret) {
    return null;
  }
  next.offline = true;
  next.offlineReason = reason || 'connectivity';
  next.offlineAt = Date.now();
  return next;
}

function clearOfflineAuth(auth) {
  const next = cloneAuth(auth);
  if (!next) {
    return null;
  }
  delete next.offline;
  delete next.offlineReason;
  delete next.offlineAt;
  return next;
}

Page(withPageShare({
  data: {
    studyLocked: !study.ORDER_OPEN,
    username: '',
    password: '',
    loading: false,
    showPassword: false,
    remember: true,
    rememberedAccounts: []
  },
  _pendingId: 0,
  _timeoutId: null,
  loadSavedAccounts() {
    const prefs = normalizeLoginPrefs(wx.getStorageSync(LOGIN_PREFS_KEY));
    const accounts = prefs.accounts;
    const fallbackAccount = accounts[0] || null;
    const pickedAccount = getStoredAccount(accounts, prefs.lastUsername) || fallbackAccount;

    this.setData({
      rememberedAccounts: accounts,
      username: pickedAccount ? pickedAccount.username : (prefs.lastUsername || ''),
      password: pickedAccount && pickedAccount.password ? pickedAccount.password : '',
      remember: !!(pickedAccount && pickedAccount.password)
    });
  },
  saveAccounts(username, password, remember, auth) {
    const prefs = normalizeLoginPrefs(wx.getStorageSync(LOGIN_PREFS_KEY));
    const accounts = prefs.accounts.filter((item) => item.username !== username);

    if (remember) {
      accounts.unshift({
        username,
        password,
        auth: clearOfflineAuth(auth)
      });
    }

    wx.setStorageSync(LOGIN_PREFS_KEY, {
      accounts,
      lastUsername: username
    });
  },
  saveLastUsername(username) {
    const prefs = normalizeLoginPrefs(wx.getStorageSync(LOGIN_PREFS_KEY));
    wx.setStorageSync(LOGIN_PREFS_KEY, {
      accounts: prefs.accounts,
      lastUsername: username
    });
  },
  enterOffline(auth, toastTitle) {
    const offlineAuth = markOfflineAuth(auth);
    if (!offlineAuth) {
      return false;
    }
    this._pendingId += 1;
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    this.setData({
      loading: false
    });
    wx.setStorageSync('auth', offlineAuth);
    wx.showToast({
      title: toastTitle || '已进入离线模式',
      icon: 'none'
    });
    wx.reLaunch({
      url: '/pages/home/home'
    });
    return true;
  },
  tryEnterOfflineByLogin(username, password) {
    const account = getStoredAccount(this.data.rememberedAccounts, username);
    const currentAuth = wx.getStorageSync('auth');
    const candidates = [
      account && account.auth,
      currentAuth && getAuthUserCode(currentAuth) === username ? currentAuth : null
    ].filter(Boolean);
    const passwordMatched = account && account.password && account.password === password;

    if (!passwordMatched) {
      return false;
    }

    for (let index = 0; index < candidates.length; index += 1) {
      if (this.enterOffline(candidates[index], '服务器连接失败，已进入离线模式')) {
        this.saveLastUsername(username);
        return true;
      }
    }
    return false;
  },
  startLoading(showTimeoutToast) {
    this._pendingId += 1;
    const requestId = this._pendingId;
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    this.setData({
      loading: true
    });
    this._timeoutId = setTimeout(() => {
      if (this._pendingId !== requestId) {
        return;
      }
      this._timeoutId = null;
      this.setData({
        loading: false
      });
      if (showTimeoutToast) {
        wx.showToast({
          title: '请求超时，请重试',
          icon: 'none'
        });
      }
    }, LOGIN_TIMEOUT_MS);
    return requestId;
  },
  stopLoading(requestId) {
    if (requestId && this._pendingId !== requestId) {
      return;
    }
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    this.setData({
      loading: false
    });
  },
  onShow() {
    this.loadSavedAccounts();

    // Token 检查逻辑保持不变
    const auth = wx.getStorageSync('auth');
    if (auth && auth.token && auth.secret) {
      const requestId = this.startLoading(false);
      api.checkToken(auth)
        .then(() => {
          if (this._pendingId !== requestId) {
            return;
          }
          console.log('Token check passed');
          const onlineAuth = clearOfflineAuth(auth) || auth;
          wx.setStorageSync('auth', onlineAuth);
          warmEssentialCaches(onlineAuth).catch((err) => {
            console.error('warm cache after token check failed', err);
          });
          wx.reLaunch({
            url: '/pages/home/home'
          });
        })
        .catch((err) => {
          if (this._pendingId !== requestId) {
            return;
          }
          if (api.isConnectivityError(err) && this.enterOffline(auth, '服务器连接失败，已进入离线模式')) {
            return;
          }
          console.log('Token check failed, stay at login', err);
          this.stopLoading(requestId);
        });
    }
  },
  onUsernameInput(e) {
    const username = (e.detail.value || '').trim();
    const remembered = getStoredAccount(this.data.rememberedAccounts, username);
    this.setData({
      username,
      password: remembered ? remembered.password : '',
      remember: remembered ? true : this.data.remember
    });
  },
  onPasswordInput(e) {
    this.setData({
      password: e.detail.value || ''
    });
  },
  clearPassword() {
    this.setData({
      password: ''
    });
  },
  onLogin() {
    const { username, password, loading } = this.data;
    if (loading) {
      return;
    }
    if (!username || !password) {
      wx.showToast({
        title: '请输入账号和密码',
        icon: 'none'
      });
      return;
    }
    const requestId = this.startLoading(true);
    api.login(username, password)
      .then((data) => {
        if (!data) {
          throw new Error('登录失败');
        }
        const userInfo = data.user_info || {};
        const bizTypes = (userInfo.biz_type_infos || []).map((item) => ({
          id: item.id,
          name: item.name,
          campusId: item.campus_id
        }));
        const auth = {
          token: data.token,
          secret: data.secret,
          identity: parseInt(data.cur_identity || '-1', 10),
          userInfo,
          bizTypes
        };
        wx.setStorageSync('auth', auth);
        this.saveAccounts(username, password, this.data.remember, auth);
        // 主动登录（可能换了账号）时不走节流，立即预热。
        warmEssentialCaches(auth, { force: true }).catch((err) => {
          console.error('warm cache after login failed', err);
        });
        wx.reLaunch({
          url: '/pages/home/home'
        });
      })
      .catch((err) => {
        if (this._pendingId !== requestId) {
          return;
        }
        if (api.isConnectivityError(err) && this.tryEnterOfflineByLogin(username, password)) {
          return;
        }
        wx.showToast({
          title: err.message || '登录失败',
          icon: 'none'
        });
      })
      .then(() => {
        this.stopLoading(requestId);
      });
  },
  togglePassword() {
    this.setData({
      showPassword: !this.data.showPassword
    });
  },
  onRememberChange(e) {
    this.setData({
      remember: !!(e.detail && e.detail.value)
    });
  },
  onSelectRememberedAccount(e) {
    const username = e.currentTarget.dataset.username || '';
    const remembered = getStoredAccount(this.data.rememberedAccounts, username);
    if (!remembered) {
      return;
    }
    this.setData({
      username: remembered.username,
      password: remembered.password,
      remember: true
    });
    wx.setStorageSync(LOGIN_PREFS_KEY, {
      accounts: this.data.rememberedAccounts,
      lastUsername: remembered.username
    });
  },
  // 刷课不需要教务账号：次数与订单按微信身份记在云端，直接进
  goStudy() {
    study.openEntry();
  }
}));
