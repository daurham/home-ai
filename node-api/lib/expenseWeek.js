/**
 * Household expense week: Friday 00:00:00.000 → Thursday 23:59:59.999
 * in the household timezone.
 *
 * Default timezone is America/Phoenix (Arizona, no DST).
 *
 * Week assignment for stored expenses uses occurred_on (DATE). That calendar
 * date is interpreted in the household TZ. Month charts use the calendar
 * month of occurred_on, so a Fri–Thu week that crosses months will split
 * across two month buckets (documented, expected).
 */

export const DEFAULT_EXPENSE_TIMEZONE = 'America/Phoenix';

const WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatYmd({ year, month, day }) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function addCalendarDays(year, month, day, days) {
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

export function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const map = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: map.weekday,
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const truncated = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - truncated;
}

export function zonedTimeToUtc(year, month, day, hour, minute, second, ms, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const offset1 = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  const instant = utcGuess - offset1;
  const offset2 = getTimeZoneOffsetMs(new Date(instant), timeZone);
  return new Date(utcGuess - offset2 + ms);
}

export function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseInput(date, timeZone) {
  if (date instanceof Date) return date;
  if (typeof date === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [year, month, day] = date.split('-').map(Number);
      // Noon local avoids DST start/end edges when we only care about the calendar day.
      return zonedTimeToUtc(year, month, day, 12, 0, 0, 0, timeZone);
    }
    return new Date(date);
  }
  throw new TypeError('date must be a Date or ISO/date string');
}

/**
 * @param {Date|string} date
 * @param {string} [timeZone]
 * @returns {{ weekStart: Date, weekEnd: Date, weekKey: string, weekStartDate: string, weekEndDate: string }}
 */
export function getExpenseWeekRange(date, timeZone = DEFAULT_EXPENSE_TIMEZONE) {
  const instant = parseInput(date, timeZone);
  const parts = getZonedParts(instant, timeZone);
  const dow = WEEKDAY_INDEX[parts.weekday];
  if (dow === undefined) {
    throw new Error(`Unexpected weekday: ${parts.weekday}`);
  }
  const daysSinceFriday = (dow - 5 + 7) % 7;
  const start = addCalendarDays(parts.year, parts.month, parts.day, -daysSinceFriday);
  const end = addCalendarDays(start.year, start.month, start.day, 6);

  const weekStart = zonedTimeToUtc(start.year, start.month, start.day, 0, 0, 0, 0, timeZone);
  const weekEnd = zonedTimeToUtc(end.year, end.month, end.day, 23, 59, 59, 999, timeZone);
  const weekKey = formatYmd(start);

  return {
    weekStart,
    weekEnd,
    weekKey,
    weekStartDate: weekKey,
    weekEndDate: formatYmd(end),
  };
}

export function getExpenseMonthRange(date, timeZone = DEFAULT_EXPENSE_TIMEZONE) {
  const instant = parseInput(date, timeZone);
  const parts = getZonedParts(instant, timeZone);
  const last = lastDayOfMonth(parts.year, parts.month);
  const monthStart = zonedTimeToUtc(parts.year, parts.month, 1, 0, 0, 0, 0, timeZone);
  const monthEnd = zonedTimeToUtc(parts.year, parts.month, last, 23, 59, 59, 999, timeZone);
  const monthKey = `${parts.year}-${pad2(parts.month)}`;
  return {
    monthStart,
    monthEnd,
    monthKey,
    monthStartDate: formatYmd({ year: parts.year, month: parts.month, day: 1 }),
    monthEndDate: formatYmd({ year: parts.year, month: parts.month, day: last }),
  };
}

export function todayYmd(timeZone = DEFAULT_EXPENSE_TIMEZONE) {
  const parts = getZonedParts(new Date(), timeZone);
  return formatYmd(parts);
}

export function shiftWeekKey(weekKey, weeks) {
  const [year, month, day] = weekKey.split('-').map(Number);
  return formatYmd(addCalendarDays(year, month, day, weeks * 7));
}

export function iterateWeekKeys(fromYmd, toYmd, timeZone = DEFAULT_EXPENSE_TIMEZONE) {
  const startKey = getExpenseWeekRange(fromYmd, timeZone).weekKey;
  const endKey = getExpenseWeekRange(toYmd, timeZone).weekKey;
  const keys = [];
  let current = startKey;
  while (current <= endKey) {
    keys.push(current);
    current = shiftWeekKey(current, 1);
  }
  return keys;
}

export function iterateMonthKeys(fromYmd, toYmd, timeZone = DEFAULT_EXPENSE_TIMEZONE) {
  const start = getExpenseMonthRange(fromYmd, timeZone);
  const end = getExpenseMonthRange(toYmd, timeZone);
  const keys = [];
  let [year, month] = start.monthKey.split('-').map(Number);
  const [endYear, endMonth] = end.monthKey.split('-').map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${year}-${pad2(month)}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return keys;
}

export function resolveTimeZone(value) {
  const timeZone = value || process.env.EXPENSE_TIMEZONE || DEFAULT_EXPENSE_TIMEZONE;
  try {
    Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_EXPENSE_TIMEZONE;
  }
}
