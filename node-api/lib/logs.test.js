import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBookInput, normalizeEntryInput, slugify } from './logs.js';

describe('slugify', () => {
  it('turns a log name into a stable slug', () => {
    assert.equal(slugify('Maintenance'), 'maintenance');
    assert.equal(slugify('  Car / Home  '), 'car-home');
  });
});

describe('normalizeBookInput', () => {
  it('requires a name', () => {
    assert.equal(normalizeBookInput({}).error, 'name is required');
  });

  it('accepts a trimmed name and slug', () => {
    const parsed = normalizeBookInput({ name: '  Vehicles  ' });
    assert.equal(parsed.error, null);
    assert.equal(parsed.value.name, 'Vehicles');
    assert.equal(parsed.value.slug, 'vehicles');
    assert.equal(parsed.value.body, '');
  });

  it('saves a document body without requiring a name on patch', () => {
    const parsed = normalizeBookInput({ body: '9/15/2026\nHVAC filter changed.' }, { partial: true });
    assert.equal(parsed.error, null);
    assert.equal(parsed.value.body, '9/15/2026\nHVAC filter changed.');
    assert.equal(parsed.value.name, undefined);
  });

  it('keeps internal whitespace in a document', () => {
    const parsed = normalizeBookInput({ body: '\nkeep this\n\n' }, { partial: true });
    assert.equal(parsed.error, null);
    assert.equal(parsed.value.body, '\nkeep this\n\n');
  });
});

describe('normalizeEntryInput', () => {
  it('requires a date and a note', () => {
    assert.match(normalizeEntryInput({}).error, /occurredOn/);
    assert.equal(normalizeEntryInput({ occurredOn: '2026-09-15' }).error, 'body is required');
  });

  it('accepts an optional dollar amount', () => {
    const parsed = normalizeEntryInput({
      occurredOn: '2026-09-15',
      body: 'Landscaper sprayed weeds.',
      amount: 50,
    });
    assert.equal(parsed.error, null);
    assert.equal(parsed.value.occurred_on, '2026-09-15');
    assert.equal(parsed.value.body, 'Landscaper sprayed weeds.');
    assert.equal(parsed.value.amount_cents, 5000);
  });

  it('treats a null amount as clearing the cost', () => {
    const parsed = normalizeEntryInput({ amountCents: null }, { partial: true });
    assert.equal(parsed.error, null);
    assert.equal(parsed.value.amount_cents, null);
  });
});
