const { pickCurrentSemesterItem } = require('./semester');
const { weekRanges, extractLessons, dateNumber, convertLessons, toCsv } = require('./wakeup-csv');

async function prepareWakeup(api, auth, { check = () => {}, progress = () => {} } = {}) {
  if (!auth || !auth.token || !auth.secret || auth.offline) throw new Error('请联网登录后导出');
  const biz = auth.bizTypes && auth.bizTypes[0] && auth.bizTypes[0].id;
  if (!biz) throw new Error('未获取到教学业务信息');
  check();
  const semesters = await api.getSemesters(auth, biz);
  check();
  const semester = pickCurrentSemesterItem(semesters, new Date());
  if (!semester || !semester.id) throw new Error('未找到当前学期');
  const ranges = weekRanges(semester.start_date, semester.end_date);
  const max = await api.getMaxUnit(auth, biz);
  check();
  const maxUnit = Number(max && max.max_unit);
  if (!Number.isInteger(maxUnit) || maxUnit < 1) throw new Error('节次数据异常');
  const all = [];
  const weekCounts = [];
  for (let i = 0; i < ranges.length; i++) {
    check();
    progress(i + 1, ranges.length);
    const [start, end] = ranges[i];
    const rows = extractLessons(await api.getCourseTables(auth, biz, semester.id, start, end));
    check();
    if (rows.some(row => dateNumber(row.date) < dateNumber(start) || dateNumber(row.date) > dateNumber(end))) {
      throw new Error('课表日期与查询范围不符');
    }
    all.push(...rows);
    weekCounts.push({ start, end, count: rows.length });
    if (i + 1 < ranges.length) await new Promise(resolve => setTimeout(resolve, 100));
  }
  let result;
  try { result = convertLessons(all, semester, maxUnit); }
  catch (error) { error.exportStage = '转换 CSV'; error.nativeDetail = error.message; throw error; }
  const code = String(semester.code || semester.id).replace(/[^a-zA-Z0-9_-]/g, '_');
  return { csv: toCsv(result.rows), fileName: `WakeUp-${code}.csv`, firstMonday: result.firstMonday,
    count: result.occurrenceCount, maxUnit, rowCount: result.rows.length,
    queriedWeeks: weekCounts.length, totalWeeks: ranges.length, weekCounts,
    startDate: semester.start_date, endDate: semester.end_date };
}

async function shareWakeup(wxApi, result, check = () => {}) {
  const fs = wxApi.getFileSystemManager();
  const filePath = `${wxApi.env.USER_DATA_PATH}/wakeup-export-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`;
  let handedToWechat = false;
  try {
    check();
    await new Promise((resolve, reject) => fs.writeFile({ filePath, data: result.csv, encoding: 'utf8',
      success: resolve, fail: error => reject(fileError('保存 CSV', error)) }));
    check();
    // Explicitly confirm the completed file, then invoke native sharing from the
    // confirmation callback rather than silently after twenty network requests.
    return await new Promise((resolve, reject) => wxApi.showModal({
      title: 'CSV 已生成', confirmText: '选择会话', cancelText: '稍后发送',
      content: `${result.fileName}\n已读取 ${result.queriedWeeks}/${result.totalWeeks} 周（${result.startDate} 至 ${result.endDate}）。\n${result.count} 次上课合并为 ${result.rowCount} 行 CSV，重复周次已合并。\n点击“选择会话”转发；请在聊天中确认文件发送完成。`,
      success: response => {
        if (!response.confirm) { resolve('cancelled'); return; }
        try {
          check();
          // The native callback only reports the API outcome, not completion of
          // the chat attachment upload. Its source must survive callback/leave.
          handedToWechat = true;
          wxApi.shareFileMessage({ filePath, fileName: result.fileName,
            success: () => resolve('shared'),
            fail: error => /cancel/i.test(error && error.errMsg || '') ? resolve('cancelled') : reject(fileError('转发文件', error)) });
        } catch (error) { reject(error); }
      },
      fail: error => reject(fileError('显示转发确认', error))
    }));
  } finally {
    // Never delete a file handed to WeChat, including a failed/cancelled API
    // result: the chat may still upload it or let the user retry sending it.
    // USER_DATA_PATH keeps it across page/app restarts until app data is cleared.
    if (!handedToWechat) fs.unlink({ filePath, fail() {} });
  }
}

function fileError(stage, error) {
  const result = new Error('文件操作失败');
  result.exportStage = stage;
  // These are filesystem/share errors only, never an academic API response.
  result.nativeDetail = String(error && error.errMsg || '微信接口未返回具体错误').slice(0, 240);
  return result;
}

module.exports = { prepareWakeup, shareWakeup };
