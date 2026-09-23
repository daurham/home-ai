import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DATE_PARSE, expandTwoDigitYear, parseDateLiteral, TWO_DIGIT_YEAR_EPOCH } from './dateParser.js';

describe('date parser', () => {
  it('parses M-D as partial and does not invent a year', () => {
    const p = parseDateLiteral('9-20');
    assert.equal(p.status, DATE_PARSE.PARTIAL);
    assert.deepEqual(p.parsed, { month: 9, day: 20, year: null });
    assert.equal(p.iso, null);
  });

  it('parses MM-DD as partial', () => {
    const p = parseDateLiteral('09-20');
    assert.equal(p.status, DATE_PARSE.PARTIAL);
    assert.deepEqual(p.parsed, { month: 9, day: 20, year: null });
  });

  it('parses M/D and M.D', () => {
    assert.equal(parseDateLiteral('9/20').status, DATE_PARSE.PARTIAL);
    assert.equal(parseDateLiteral('9.20').status, DATE_PARSE.PARTIAL);
  });

  it('parses M-D-YY with fixed 2000 expansion, not Date.now', () => {
    assert.equal(TWO_DIGIT_YEAR_EPOCH, 2000);
    assert.equal(expandTwoDigitYear(26), 2026);
    const p = parseDateLiteral('9-20-26');
    assert.equal(p.status, DATE_PARSE.COMPLETE);
    assert.equal(p.iso, '2026-09-20');
    assert.equal(p.parsed.year, 2026);
  });

  it('parses MM-DD-YY and M-D-YYYY', () => {
    assert.equal(parseDateLiteral('09-20-26').iso, '2026-09-20');
    assert.equal(parseDateLiteral('9-20-2026').iso, '2026-09-20');
  });

  it('accepts a valid leap day and rejects an invalid leap day', () => {
    assert.equal(parseDateLiteral('2-29-24').iso, '2024-02-29');
    assert.equal(parseDateLiteral('2-29-2024').iso, '2024-02-29');
    assert.equal(parseDateLiteral('2-29-23').status, DATE_PARSE.INVALID);
    assert.equal(parseDateLiteral('2-29-2023').iso, null);
  });

  it('rejects impossible month and day without coercing', () => {
    const month = parseDateLiteral('13-40-26');
    assert.equal(month.status, DATE_PARSE.INVALID);
    assert.equal(month.iso, null);
    assert.equal(month.literal, '13-40-26');
    const day = parseDateLiteral('2-30-26');
    assert.equal(day.status, DATE_PARSE.INVALID);
    assert.equal(day.iso, null);
  });

  it('normalizes whitespace around separators', () => {
    assert.equal(parseDateLiteral(' 9 - 20 - 26 ').iso, '2026-09-20');
    assert.equal(parseDateLiteral('4-12').status, DATE_PARSE.PARTIAL);
  });

  it('treats blank and UNKNOWN as non-dates', () => {
    assert.equal(parseDateLiteral('').status, DATE_PARSE.BLANK);
    assert.equal(parseDateLiteral(null).status, DATE_PARSE.BLANK);
    assert.equal(parseDateLiteral('UNKNOWN').status, DATE_PARSE.UNKNOWN);
    assert.equal(parseDateLiteral('BLANK').status, DATE_PARSE.BLANK);
  });

  it('rejects prose and mixed separators', () => {
    assert.equal(parseDateLiteral('September 20 2026').status, DATE_PARSE.UNPARSED);
    assert.equal(parseDateLiteral('9-20/26').status, DATE_PARSE.UNPARSED);
  });

  it('does not use the current year for a missing year', () => {
    const p = parseDateLiteral('9-20');
    assert.equal(p.parsed.year, null);
    assert.equal(p.iso, null);
    assert.equal(String(p.iso || '').includes(String(new Date().getFullYear())), false);
  });
});
