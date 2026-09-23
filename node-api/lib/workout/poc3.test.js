import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_RAW_ROUTINE_B_LITERAL,
  LITERAL_RAW_TRANSCRIPTION_SCHEMA,
} from './rawSchema.js';
import { WHOLE_PAGE_PROMPT_POC3, mentionsForbiddenDomain } from './extractPrompts.js';
import { compareRawRuns, semanticCellEqual } from './rawCompare.js';
import { coerceLiteralRaw, transcribePoc3, runPoc3Reliability } from './poc3.js';
import { loadWorkoutConfig } from './config.js';
import { normalizeRawTranscription } from './normalizeRaw.js';
import { compareFixture } from './compareFixture.js';

describe('POC #3 prompt and literal schema', () => {
  it('does not send the v1.2 pack or canonical schema language', () => {
    assert.equal(mentionsForbiddenDomain(WHOLE_PAGE_PROMPT_POC3), false);
    assert.equal(mentionsForbiddenDomain(JSON.stringify(LITERAL_RAW_TRANSCRIPTION_SCHEMA)), false);
  });

  it('requires literal string-or-null cells and fixed physical rows', () => {
    assert.match(WHOLE_PAGE_PROMPT_POC3, /literal cell reader/);
    assert.match(WHOLE_PAGE_PROMPT_POC3, /Never inherit weight/);
    assert.match(WHOLE_PAGE_PROMPT_POC3, /Never move values between exercise tables/);
    assert.match(WHOLE_PAGE_PROMPT_POC3, /Never infer planned\/target reps/);
    assert.match(WHOLE_PAGE_PROMPT_POC3, /unreadable/);
    assert.deepEqual(LITERAL_RAW_TRANSCRIPTION_SCHEMA.properties.pain, { type: ['string', 'null'] });
    assert.deepEqual(LITERAL_RAW_TRANSCRIPTION_SCHEMA.properties.B01.minItems, 3);
    assert.deepEqual(LITERAL_RAW_TRANSCRIPTION_SCHEMA.properties.B01.maxItems, 3);
    assert.deepEqual(
      LITERAL_RAW_TRANSCRIPTION_SCHEMA.properties.B01.items.properties.weight,
      { type: ['string', 'null'] },
    );
    assert.equal(EXPECTED_RAW_ROUTINE_B_LITERAL.pain, '1');
    assert.equal(EXPECTED_RAW_ROUTINE_B_LITERAL.B01[0].weight, 'BW');
    assert.equal(EXPECTED_RAW_ROUTINE_B_LITERAL.B01[1].weight, null);
    assert.equal(EXPECTED_RAW_ROUTINE_B_LITERAL.B04[0].reps, '15');
  });
});

describe('literal raw still normalizes with the unchanged JS engine', () => {
  it('matches the expected canonical fixture when cells are perfect strings', () => {
    const workout = normalizeRawTranscription(EXPECTED_RAW_ROUTINE_B_LITERAL);
    const comparison = compareFixture(loadWorkoutConfig().expectedRoutineB, workout);
    assert.equal(comparison.match, true, JSON.stringify(comparison.mismatches, null, 2));
  });
});

describe('coerceLiteralRaw', () => {
  it('maps unreadable tokens to null without changing other strings', () => {
    const coerced = coerceLiteralRaw({
      ...EXPECTED_RAW_ROUTINE_B_LITERAL,
      pain: 'unreadable',
      B02: [
        { weight: '25', reps: '10' },
        { weight: '?', reps: '10' },
        { weight: null, reps: '10' },
      ],
    });
    assert.equal(coerced.pain, null);
    assert.equal(coerced.B02[0].weight, '25');
    assert.equal(coerced.B02[1].weight, null);
  });
});

describe('compareRawRuns', () => {
  it('shows expected vs three runs and flags pain/B01/B02/B04', () => {
    const run1 = EXPECTED_RAW_ROUTINE_B_LITERAL;
    const run2 = {
      ...EXPECTED_RAW_ROUTINE_B_LITERAL,
      pain: '0',
      B01: [
        { weight: 'BW', reps: '10' },
        { weight: '40', reps: '10' },
        { weight: null, reps: '10' },
      ],
    };
    const run3 = {
      ...EXPECTED_RAW_ROUTINE_B_LITERAL,
      B02: [
        { weight: '25', reps: '10' },
        { weight: '10', reps: '10' },
        { weight: '10', reps: '10' },
      ],
      B04: [
        { weight: '15', reps: '15' },
        { weight: '15', reps: '15' },
        { weight: '15', reps: '15' },
      ],
    };
    const comparison = compareRawRuns([run1, run2, run3]);
    assert.equal(comparison.focus.pain.consistent, false);
    assert.equal(comparison.focus.pain.allMatchExpected, false);
    assert.equal(comparison.focus.B01.allMatchExpected, false);
    assert.equal(comparison.focus.B02.allMatchExpected, false);
    assert.equal(comparison.focus.B04.allMatchExpected, false);
    const pain = comparison.fields.find((field) => field.path === 'pain');
    assert.deepEqual(pain.runs, ['1', '0', '1']);
    assert.equal(semanticCellEqual('40', 40), true);
  });
});

describe('transcribePoc3', () => {
  it('normalizes literal extraction without asking the model for canonical JSON', async () => {
    const result = await transcribePoc3({
      imageBuffer: Buffer.from('img'),
      extractWhole: async () => ({
        variant: 'whole-page-poc3',
        model: 'llama3.2-vision:11b',
        elapsed_ms: 10,
        calls: 1,
        rawText: JSON.stringify(EXPECTED_RAW_ROUTINE_B_LITERAL),
        raw: EXPECTED_RAW_ROUTINE_B_LITERAL,
        parseError: null,
        prompt: WHOLE_PAGE_PROMPT_POC3,
        parts: {},
      }),
    });
    assert.equal(result.poc, 3);
    assert.equal(result.promptUsedPack, false);
    assert.equal(result.validation.valid, true);
    assert.equal(result.benchmark.exactMatch, true);
    assert.equal(result.benchmark.b03_exact, true);
  });
});

describe('runPoc3Reliability', () => {
  it('counts canonical exact matches across identical mock runs', async () => {
    const report = await runPoc3Reliability({
      imageBuffer: Buffer.from('img'),
      runs: 3,
      extractWhole: async () => ({
        variant: 'whole-page-poc3',
        model: 'llama3.2-vision:11b',
        elapsed_ms: 1,
        calls: 1,
        rawText: JSON.stringify(EXPECTED_RAW_ROUTINE_B_LITERAL),
        raw: EXPECTED_RAW_ROUTINE_B_LITERAL,
        parseError: null,
        prompt: WHOLE_PAGE_PROMPT_POC3,
        parts: {},
      }),
    });
    assert.equal(report.canonicalExactMatchCount, 3);
    assert.equal(report.comparison.expectedMatchCount, report.comparison.fieldCount);
    assert.equal(report.comparison.focus.B01.allMatchExpected, true);
    assert.equal(report.comparison.focus.pain.consistent, true);
  });
});
