const { withPageShare } = require('../../utils/share');

const QUERY_URL = 'https://zs.tsguas.edu.cn/lqcxjg.jsp?wbtreeid=1011';
const EMPTY_RESULT_TEXT = '无该考生录取信息 或 输入查询信息错误，请核对考生姓名和考生号。';

function decodeHtml(text) {
  return String(text || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function stripHtml(html) {
  return decodeHtml(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAdmissionResult(html) {
  const source = String(html || '');
  const pageText = stripHtml(source);
  if (pageText.indexOf('无该考生录取信息') >= 0 || pageText.indexOf('输入查询信息错误') >= 0) {
    return {
      type: 'notFound',
      message: EMPTY_RESULT_TEXT,
      fields: []
    };
  }

  const fieldOrder = ['考生姓名', '考生号', '录取专业', '培养层次', '培养类别'];
  const fieldMap = {};
  const rows = source.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  let message = '';

  rows.forEach((row) => {
    const cells = [];
    const cellPattern = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch = cellPattern.exec(row);
    while (cellMatch) {
      cells.push(stripHtml(cellMatch[1]));
      cellMatch = cellPattern.exec(row);
    }

    if (cells.length === 1 && cells[0].indexOf('恭喜你') >= 0) {
      message = cells[0];
      return;
    }
    if (cells.length < 2) {
      return;
    }

    const label = cells[0].replace(/[：:]\s*$/, '').trim();
    if (fieldOrder.indexOf(label) >= 0) {
      fieldMap[label] = cells[1] || '';
    }
  });

  const hasRecord = message.indexOf('恭喜你') >= 0
    && !!fieldMap['考生姓名']
    && !!fieldMap['考生号']
    && !!fieldMap['录取专业'];
  if (!hasRecord) {
    return {
      type: 'unexpected',
      message: '',
      fields: []
    };
  }

  return {
    type: 'found',
    message,
    fields: fieldOrder.map((label) => ({
      label,
      value: fieldMap[label] || '-'
    }))
  };
}

Page(withPageShare({
  data: {
    name: '',
    candidateNumber: '',
    loading: false,
    resultText: '',
    resultFields: [],
    hasRecord: false
  },

  getShareConfig() {
    return {
      title: '录取查询',
      path: '/pages/admission-query/admission-query'
    };
  },

  getTimelineShareConfig() {
    return this.getShareConfig();
  },

  onNameInput(event) {
    this.setData({
      name: event.detail.value
    });
  },

  onCandidateNumberInput(event) {
    this.setData({
      candidateNumber: event.detail.value
    });
  },

  submitQuery() {
    if (this.data.loading) {
      return;
    }

    const name = String(this.data.name || '').trim();
    const candidateNumber = String(this.data.candidateNumber || '').trim();
    if (!name) {
      wx.showToast({ title: '请输入考生姓名', icon: 'none' });
      return;
    }
    if (!candidateNumber) {
      wx.showToast({ title: '请输入考生号', icon: 'none' });
      return;
    }

    this.setData({
      loading: true,
      resultText: '',
      resultFields: [],
      hasRecord: false
    });

    wx.request({
      url: QUERY_URL,
      method: 'POST',
      data: {
        xm: name,
        ksh: candidateNumber
      },
      header: {
        'content-type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000,
      success: (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          this.showQueryError('招生查询服务返回异常，请稍后重试');
          return;
        }
        const result = extractAdmissionResult(response.data);
        if (result.type === 'unexpected') {
          this.showQueryError('未识别招生网返回内容，请稍后重试');
          return;
        }
        this.setData({
          loading: false,
          resultText: result.message,
          resultFields: result.fields,
          hasRecord: result.type === 'found'
        });
      },
      fail: () => {
        this.showQueryError('招生查询服务连接失败，请检查网络后重试');
      }
    });
  },

  showQueryError(message) {
    this.setData({
      loading: false
    });
    wx.showToast({
      title: message,
      icon: 'none',
      duration: 3000
    });
  }
}));
