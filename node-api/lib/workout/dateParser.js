/**
 * Deterministic date literal parser.
 * Does not use Date.now(), photo metadata, or the current year.
 *
 * Two-digit year policy (fixed, documented):
 *   YY → 2000 + YY  (00–99 → 2000–2099)
 * This is a domain rule for this application's 21st-century paper logs,
 * not an inference from "today".
 *
 * Missing year is never invented. "9-20" stays partial.
 */

export const TWO_DIGIT_YEAR_EPOCH = 2000;

export const DATE_PARSE = {
  BLANK: 'BLANK',
  UNKNOWN: 'UNKNOWN',
  PARTIAL: 'PARTIAL',
  INVALID: 'INVALID',
  COMPLETE: 'COMPLETE',
  UNPARSED: 'UNPARSED',
};

const DATE_FORM = /^(\d{1,2})\s*([./-])\s*(\d{1,2})(?:\s*\2\s*(\d{2}|\d{4}))?$/;

function daysInMonth(year, month) {
  if (month < 1 || month > 12) return 0;
  const leap = year != null && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0);
  const table = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[month];
}

export function expandTwoDigitYear(yy) {
  if (!Number.isInteger(yy) || yy < 0 || yy > 99) return null;
  return TWO_DIGIT_YEAR_EPOCH + yy;
}

export function isValidYmd(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 2000 || year > 2099) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

function iso(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseDateLiteral(raw) {
  if (raw == null) {
    return { status: DATE_PARSE.BLANK, literal: null, parsed: null, iso: null };
  }
  const literal = String(raw).replace(/\u0000/g, '').trim();
  if (!literal) {
    return { status: DATE_PARSE.BLANK, literal: '', parsed: null, iso: null };
  }
  if (/^(blank|unknown)\.?$/i.test(literal)) {
    return {
      status: /^blank/i.test(literal) ? DATE_PARSE.BLANK : DATE_PARSE.UNKNOWN,
      literal,
      parsed: null,
      iso: null,
    };
  }
  const collapsed = literal.replace(/\s+/g, ' ').trim();
  const m = collapsed.match(DATE_FORM);
  if (!m) {
    return { status: DATE_PARSE.UNPARSED, literal: collapsed, parsed: null, iso: null };
  }
  const month = Number(m[1]);
  const day = Number(m[3]);
  const yearToken = m[4];
  if (yearToken == null) {
    const maxDay = daysInMonth(null, month) || 0;
    const feb29 = month === 2 && day === 29;
    if (month < 1 || month > 12 || day < 1 || feb29 || day > maxDay) {
      return {
        status: DATE_PARSE.INVALID,
        literal: collapsed,
        parsed: { month, day, year: null },
        iso: null,
      };
    }
    return {
      status: DATE_PARSE.PARTIAL,
      literal: collapsed,
      parsed: { month, day, year: null },
      iso: null,
    };
  }
  let year;
  if (yearToken.length === 2) {
    year = expandTwoDigitYear(Number(yearToken));
  } else {
    year = Number(yearToken);
  }
  const parsed = { month, day, year };
  if (!isValidYmd(year, month, day)) {
    return { status: DATE_PARSE.INVALID, literal: collapsed, parsed, iso: null };
  }
  return {
    status: DATE_PARSE.COMPLETE,
    literal: collapsed,
    parsed,
    iso: iso(year, month, day),
  };
}
