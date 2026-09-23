import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXPECTED_RAW_ROUTINE_B } from './rawSchema.js';
import { WHOLE_PAGE_PROMPT, WHOLE_PAGE_PROMPT_POC3, mentionsForbiddenDomain, slotPrompt } from './extractPrompts.js';
import { transcribePoc2 } from './poc2.js';

describe('POC #2 prompts', () => {
  it('does not send the v1.2 pack or canonical schema language', () => {
    assert.equal(mentionsForbiddenDomain(WHOLE_PAGE_PROMPT), false);
    assert.equal(mentionsForbiddenDomain(WHOLE_PAGE_PROMPT_POC3), false);
    assert.equal(mentionsForbiddenDomain(slotPrompt('B03')), false);
    assert.match(WHOLE_PAGE_PROMPT, /Do not inherit weights/);
    assert.match(slotPrompt('B03'), /B03/);
  });
});

describe('transcribePoc2', () => {
  it('normalizes a perfect raw extraction without asking the model for canonical JSON', async () => {
    const result = await transcribePoc2({
      imageBuffer: Buffer.from('img'),
      extractWhole: async () => ({
        variant: 'whole-page',
        model: 'llama3.2-vision:11b',
        elapsed_ms: 10,
        calls: 1,
        rawText: JSON.stringify(EXPECTED_RAW_ROUTINE_B),
        raw: EXPECTED_RAW_ROUTINE_B,
        parseError: null,
        parts: {},
      }),
    });
    assert.equal(result.poc, 2);
    assert.equal(result.validation.valid, true);
    assert.equal(result.benchmark.b03_exact, true);
    assert.equal(result.benchmark.exactMatch, true);
    assert.equal(result.workout.workout.exercises.find((ex) => ex.slot_id === 'B02').sets[2].weight_lb, 25);
  });
});
