'use strict';
// DailyNoteManager recognizes both the current and dotted legacy filenames.
// Undated rows use their original timestamp in the desktop diary timezone.
function diaryDateSql(prefix = '') {
  const name = prefix ? prefix + '.' : '';
  return `CASE WHEN substr(${name}note_path,1,20) GLOB 'Companion/[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
    THEN substr(${name}note_path,11,10)
    WHEN substr(${name}note_path,1,20) GLOB 'Companion/[0-9][0-9][0-9][0-9].[0-1][0-9].[0-3][0-9]'
    THEN replace(substr(${name}note_path,11,10),'.','-')
    ELSE COALESCE(strftime('%Y-%m-%d',${name}created_at,'+8 hours'),substr(${name}created_at,1,10),'') END`;
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const ms = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}
function dateRange(fromDate, toDate) {
  if (fromDate !== undefined && !validDate(fromDate) || toDate !== undefined && !validDate(toDate) || fromDate && toDate && fromDate > toDate)
    throw new TypeError('Invalid inclusive diary date range.');
  return fromDate !== undefined || toDate !== undefined;
}
module.exports = { diaryDateSql, validDate, dateRange };
