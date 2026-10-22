import type { CompanionLearningGoal } from './companion-learning-goals';

type Schedule = CompanionLearningGoal['schedule'];
/** Earliest real instant inside a user window; advancing UTC minutes handles DST. */
export function nextCompanionLearningGoalAt(schedule: Schedule, earliest: number): number {
  if (!schedule.windows.length) return earliest;
  const format = new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let step = 0; step <= 8 * 1440; step++) {
    const instant = step ? Math.floor(earliest / 60000) * 60000 + step * 60000 : earliest;
    const parts = Object.fromEntries(format.formatToParts(instant).map(part => [part.type, part.value]));
    const minute = Number(parts.hour) * 60 + Number(parts.minute), day = weekdays.indexOf(parts.weekday!);
    if (schedule.windows.some(window => {
      const overnight = window.startMinute > window.endMinute;
      const inTime = window.startMinute === window.endMinute || (overnight ? minute >= window.startMinute || minute < window.endMinute : minute >= window.startMinute && minute < window.endMinute);
      const startDay = overnight && minute < window.endMinute ? (day + 6) % 7 : day;
      return inTime && (!window.days || window.days.includes(startDay));
    })) return instant;
  }
  return earliest + 8 * 86400000;
}
