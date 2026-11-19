// /common/get-semester returns newest-first semesters. Follow that order rather
// than the device clock, cur_semester_id, numeric IDs, or the number of records.
async function loadLatestSemesterData(semesters, loadItems, isActive) {
  const active = isActive || (() => true);
  for (let index = 0; index < semesters.length; index += 1) {
    if (!active()) return null;
    // A failed request is not an empty semester: let the page show its error/cache.
    const items = await loadItems(semesters[index]);
    if (!active()) return null;
    if (!Array.isArray(items)) throw new Error('学期数据格式异常');
    if (items.length) return { semesterIndex: index, items };
  }
  return { semesterIndex: semesters.length ? 0 : -1, items: [] };
}

module.exports = { loadLatestSemesterData };
