import { maintenanceBriefSchema, type MaintenanceBrief, type MaintenanceBriefInput } from '../../shared/companion-bot-maintenance';

/** Anchor common relative periods once, in the calendar used for VCP diary filenames. */
export function freezeMaintenanceBrief(input: MaintenanceBriefInput, requestedBy: MaintenanceBrief['requestedBy'], now = new Date()): MaintenanceBrief {
  const brief = maintenanceBriefSchema.parse(input);
  if (!brief.period || brief.fromDate || brief.toDate) return { ...brief, requestedBy };
  const period = brief.period.trim();
  const dates = /^(\d{4}-\d{2}-\d{2})\s*(?:至|到|~|～|—|to)\s*(\d{4}-\d{2}-\d{2})$/iu.exec(period);
  if (dates) return { ...maintenanceBriefSchema.parse({ ...brief, fromDate: dates[1], toDate: dates[2] }), requestedBy };
  const words: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 六: 6, 十二: 12, one: 1, two: 2, three: 3, six: 6, twelve: 12 };
  const span = /^(?:最近|近|过去)\s*(\d{1,3}|十二|[一两二三六])\s*(?:个)?(月|天|周|年)(?:内)?$/u.exec(period)
    ?? /^(?:last|past)\s+(\d{1,3}|one|two|three|six|twelve)\s+(months?|days?|weeks?|years?)$/iu.exec(period);
  if (!span) return { ...brief, requestedBy };
  const count = words[span[1]!.toLowerCase()] ?? Number(span[1]), unit = span[2]!.toLowerCase();
  if (!count) return { ...brief, requestedBy };
  const toDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const from = new Date(toDate + 'T00:00:00Z');
  if (/^(?:月|month|年|year)/u.test(unit)) {
    const day = from.getUTCDate();
    from.setUTCDate(1);
    from.setUTCMonth(from.getUTCMonth() - count * (/^(?:年|year)/u.test(unit) ? 12 : 1));
    const lastDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0)).getUTCDate();
    from.setUTCDate(Math.min(day, lastDay));
  } else from.setUTCDate(from.getUTCDate() - count * (/^(?:周|week)/u.test(unit) ? 7 : 1) + 1);
  return { ...brief, fromDate: from.toISOString().slice(0, 10), toDate, requestedBy };
}
