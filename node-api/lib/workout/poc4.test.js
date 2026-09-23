import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXPECTED_RAW_ROUTINE_B_LITERAL } from './rawSchema.js';
import { WHOLE_PAGE_PROMPT_POC3 } from './extractPrompts.js';
import {
  candidateCatalog,
  formatShootoutReport,
  preparePoc4Run,
  transcribePoc4,
} from './poc4.js';
import { recommendedDownloadGb, recommendedFirstWave } from './poc4Candidates.js';

describe('POC #4 catalog', () => {
  it('does not recommend a first-wave download over the RAM/size policy', () => {
    const wave = recommendedFirstWave();
    assert.ok(wave.every((c) => c.download_gb <= 8));
    assert.ok(recommendedDownloadGb() < 22);
    assert.equal(candidateCatalog().auto_download, false);
    assert.ok(candidateCatalog().rejected.some((row) => row.tag.includes('90b')));
  });
});

describe('preparePoc4Run', () => {
  it('refuses to pull an uninstalled model', async () => {
    await assert.rejects(
      () => preparePoc4Run({
        model: 'qwen2.5vl:7b',
        env: { OLLAMA_BASE_URL: 'http://ollama.test' },
        get: async () => ({ data: { models: [{ name: 'llama3.2-vision:11b', size: 1 }] } }),
        allowPull: false,
      }),
      /does not auto-pull/,
    );
  });
});

describe('transcribePoc4', () => {
  it('scores frozen POC #3 output without sending pack or expected JSON', async () => {
    const result = await transcribePoc4({
      imageBuffer: Buffer.from('img'),
      model: 'qwen2.5vl:7b',
      sampleMemory: () => ({ memAvailableKb: 25000000, memTotalKb: 28000000, swapFreeKb: 2000000 }),
      get: async () => ({ data: { models: [] } }),
      unloadOthers: false,
      extractWhole: async ({ model }) => {
        assert.equal(model, 'qwen2.5vl:7b');
        return {
          variant: 'whole-page-poc3',
          model,
          elapsed_ms: 12,
          calls: 1,
          rawText: JSON.stringify(EXPECTED_RAW_ROUTINE_B_LITERAL),
          raw: EXPECTED_RAW_ROUTINE_B_LITERAL,
          parseError: null,
          prompt: WHOLE_PAGE_PROMPT_POC3,
          parts: {},
        };
      },
    });
    assert.equal(result.poc, 4);
    assert.equal(result.promptUsedPack, false);
    assert.equal(result.score.rawFieldsCorrect, 45);
    assert.equal(result.canonicalExactMatch, true);
    const report = formatShootoutReport(result, { download_gb: 6.0 });
    assert.equal(report.canonical_exact_match, 'yes');
    assert.equal(report.exercises.B03, 'yes');
    assert.equal(report.difficult_features.bw_recognition, 'pass');
  });
});
