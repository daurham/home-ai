import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_DIR } from './poc6/index.js';
import { DETECT_PY, DETECTOR_CONFIG_PATH } from './poc7/index.js';
import {
  DETECTOR_VERSION,
  FROZEN_DETECTOR_SHA256,
  assertDetectorFrozen,
  sha256File,
} from './poc7b.js';
import {
  DETECT_PY_SHA256,
  NUMERIC_FIELD_KINDS,
  parseNumericLiteral,
  scoreRecognizer,
  writeContactSheet,
} from './poc8.js';
import { POC8B_MODEL, loadPoc8Membership } from './poc8b.js';
import {
  POC8B_VLM_CACHE,
  RESIDUAL_FAMILIES,
  loadPoc8bRows,
} from './poc8c.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const POC8D_ARTIFACT_DIR = path.join(ARTIFACT_DIR, 'poc8d');
export const POC8D_RECOGNIZE_PY = path.join(HERE, 'poc8d', 'recognize.py');
export const INDEPENDENT_MODEL_ID = 'microsoft/trocr-small-handwritten';
export const INDEPENDENT_MODEL_TYPE = 'TrOCR encoder-decoder (DeiT-small + autoregressive decoder), IAM handwritten lines';

export const PREPROCESS = {
  crop: 'frozen POC #8B clean.png; geometry unchanged',
  color: "PIL Image.convert('RGB')",
  model_input: 'official TrOCRProcessor (use_fast=False) resize/normalize to 384×384',
  decode: 'greedy generate, max_new_tokens=16, num_beams=1, do_sample=False',
  no_field_specific_ops: true,
  no_gt_guided_segmentation: true,
};

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function fmtPct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtPrec(n) {
  return `${(n * 100).toFixed(2)}%`;
}

/**
 * Agreement gate. Ground truth is not an input.
 * AUTO_ACCEPT iff both outputs are numeric literals and equal.
 */
export function gateAgreement(graniteRaw, independentRaw) {
  const granite = parseNumericLiteral(graniteRaw).value;
  const independent = parseNumericLiteral(independentRaw).value;
  const bothNumeric = granite !== 'UNKNOWN' && independent !== 'UNKNOWN';
  const agree = bothNumeric && granite === independent;
  if (agree) {
    return {
      state: 'AUTO_ACCEPT',
      value: granite,
      reason: 'agree_numeric',
      granite,
      independent,
    };
  }
  let reason = 'disagreement';
  if (granite === 'UNKNOWN' || independent === 'UNKNOWN') reason = 'unknown';
  return {
    state: 'REVIEW_REQUIRED',
    value: null,
    reason,
    granite,
    independent,
  };
}

export function complementarityBucket(granite, independent, expected) {
  const gExact = granite === expected;
  const bExact = independent === expected;
  const gUnk = granite === 'UNKNOWN';
  const bUnk = independent === 'UNKNOWN';
  const gWrong = !gExact && !gUnk;
  const bWrong = !bExact && !bUnk;
  if (gExact && bExact) return granite === independent ? 'both_correct_agree' : 'both_correct_disagree';
  if (gExact && bWrong) return 'granite_correct_b_wrong';
  if (gWrong && bExact) return 'granite_wrong_b_correct';
  if (gWrong && bWrong && granite === independent) return 'both_wrong_same';
  if (gWrong && bWrong) return 'both_wrong_different';
  if (gUnk && bExact) return 'granite_unknown_b_correct';
  if (gExact && bUnk) return 'granite_correct_b_unknown';
  if (gUnk && bUnk) return 'both_unknown';
  if (gUnk && bWrong) return 'granite_unknown_b_wrong';
  if (gWrong && bUnk) return 'granite_wrong_b_unknown';
  return 'other';
}

export function classifyRows(rows) {
  const counts = {};
  const labeled = rows.map((row) => {
    const granite = row.granite;
    const independent = row.independent;
    const bucket = complementarityBucket(granite, independent, row.expected);
    counts[bucket] = (counts[bucket] || 0) + 1;
    const gate = gateAgreement(granite, independent);
    return { ...row, bucket, gate };
  });
  return { rows: labeled, counts };
}

export function evaluateAgreementGate(classified) {
  const total = classified.length;
  const auto = classified.filter((r) => r.gate.state === 'AUTO_ACCEPT');
  const review = classified.filter((r) => r.gate.state === 'REVIEW_REQUIRED');
  const autoCorrect = auto.filter((r) => String(r.gate.value) === String(r.expected)).length;
  const autoWrong = auto.filter((r) => String(r.gate.value) !== String(r.expected)).length;
  const graniteExact = classified.filter((r) => r.granite === r.expected);
  const graniteMiss = classified.filter((r) => r.granite !== r.expected);
  return {
    name: 'Granite + B numeric agreement',
    total,
    auto_accepted: {
      count: auto.length,
      pct: total ? auto.length / total : 0,
      correct: autoCorrect,
      wrong: autoWrong,
      precision: auto.length ? autoCorrect / auto.length : 0,
    },
    review_required: {
      count: review.length,
      pct: total ? review.length / total : 0,
      granite_errors_caught: review.filter((r) => r.granite !== r.expected).length,
      correct_granite_unnecessarily_reviewed: review.filter((r) => r.granite === r.expected).length,
    },
    error_capture: {
      granite_non_exact: graniteMiss.length,
      routed_to_review: graniteMiss.filter((r) => r.gate.state === 'REVIEW_REQUIRED').length,
      remain_auto_accept: graniteMiss.filter((r) => r.gate.state === 'AUTO_ACCEPT').length,
    },
    false_review: {
      granite_correct: graniteExact.length,
      unnecessarily_reviewed: graniteExact.filter((r) => r.gate.state === 'REVIEW_REQUIRED').length,
      rate: graniteExact.length
        ? graniteExact.filter((r) => r.gate.state === 'REVIEW_REQUIRED').length / graniteExact.length
        : 0,
    },
  };
}

function spawnPython(jobPath, outPath, onProgress) {
  return new Promise((resolve, reject) => {
    const pythonBin = process.env.POC8D_PYTHON || process.env.POC7_PYTHON || 'python3';
    const proc = spawn(pythonBin, [POC8D_RECOGNIZE_PY, '--job', jobPath, '--out', outPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (buf) => {
      stdout += buf.toString();
    });
    proc.stderr.on('data', (buf) => {
      const text = buf.toString();
      stderr += text;
      for (const line of text.split('\n')) {
        if (line.trim()) onProgress?.({ line });
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`recognize.py exited ${code}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function runIndependentRecognizer(samples, {
  artifactDir = POC8D_ARTIFACT_DIR,
  onProgress,
} = {}) {
  fs.mkdirSync(artifactDir, { recursive: true });
  const jobPath = path.join(artifactDir, 'job.json');
  const outPath = path.join(artifactDir, 'independent-raw.json');
  const cachePath = path.join(artifactDir, 'independent-cache.json');
  const job = {
    model_id: INDEPENDENT_MODEL_ID,
    cache_path: cachePath,
    samples: samples.map((s) => ({ sample_id: s.sample_id, crop: s.crop_clean || s.crop })),
  };
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));
  await spawnPython(jobPath, outPath, onProgress);
  const raw = loadJson(outPath);
  const parsed = raw.results.map((row) => {
    const parsedLit = parseNumericLiteral(row.raw);
    return {
      ...row,
      recognized: parsedLit.value,
      parse_reason: parsedLit.reason,
    };
  });
  return {
    recognizer: INDEPENDENT_MODEL_ID,
    model_type: INDEPENDENT_MODEL_TYPE,
    preprocess: raw.preprocess || PREPROCESS,
    device: raw.device,
    runtime_ms: raw.runtime_ms,
    results: parsed,
  };
}

function graniteMeanMs() {
  const cache = loadJson(POC8B_VLM_CACHE);
  const vals = Object.values(cache).map((r) => Number(r.latency_ms) || 0).filter((n) => n > 0);
  return mean(vals) || 8850;
}

function confidenceAnalysis(rows) {
  const withConf = rows.filter((r) => r.confidence && r.confidence.geom_mean_token_prob != null);
  const of = (pred) => withConf.filter(pred).map((r) => r.confidence.geom_mean_token_prob);
  const correct = of((r) => r.independent === r.expected);
  const wrong = of((r) => r.independent !== 'UNKNOWN' && r.independent !== r.expected);
  const unknown = of((r) => r.independent === 'UNKNOWN');
  return {
    n_with_confidence: withConf.length,
    correct: { n: correct.length, mean: mean(correct), median: median(correct) },
    wrong: { n: wrong.length, mean: mean(wrong), median: median(wrong) },
    unknown: { n: unknown.length, mean: mean(unknown), median: median(unknown) },
    wrong_lower_than_correct: wrong.length && correct.length ? mean(wrong) < mean(correct) : null,
  };
}

function residualTable(rows) {
  return RESIDUAL_FAMILIES.map((family) => {
    const members = rows.filter((r) => family.match({ ...r, clean: r.granite }));
    return {
      id: family.id,
      label: family.label,
      observations: members.map((r) => ({
        photo_id: r.photo_id,
        field_id: r.field_id,
        expected: r.expected,
        granite: r.granite,
        independent: r.independent,
        independent_raw: r.independent_raw,
        independent_confidence: r.confidence?.geom_mean_token_prob ?? null,
        agree: r.granite === r.independent,
        granite_correct: r.granite === r.expected,
        independent_correct: r.independent === r.expected,
        gate: r.gate.state,
        which_correct: r.granite === r.expected && r.independent === r.expected
          ? 'both'
          : r.granite === r.expected
            ? 'granite'
            : r.independent === r.expected
              ? 'independent'
              : 'neither',
      })),
    };
  });
}

function graniteMissTable(rows) {
  return rows.filter((r) => r.granite !== r.expected).map((r) => ({
    photo_id: r.photo_id,
    field_id: r.field_id,
    expected: r.expected,
    granite: r.granite,
    independent: r.independent,
    independent_raw: r.independent_raw,
    independent_confidence: r.confidence?.geom_mean_token_prob ?? null,
    agree: r.granite === r.independent,
    which_correct: r.granite === r.expected && r.independent === r.expected
      ? 'both'
      : r.granite === r.expected
        ? 'granite'
        : r.independent === r.expected
          ? 'independent'
          : 'neither',
    gate: r.gate.state,
  }));
}

async function maybeSheet(tiles, outPath, title) {
  if (!tiles.length) return { path: null, count: 0, skipped: true };
  await writeContactSheet(tiles, outPath, { title });
  return { path: outPath, count: tiles.length, skipped: false };
}

export function buildReport({
  frozen,
  independentScore,
  graniteExact,
  classified,
  gate,
  residuals,
  graniteMisses,
  confidence,
  latency,
  sheets,
  exploratory,
}) {
  const b = independentScore;
  const inferMs = classified.rows.reduce((s, r) => s + (Number(r.latency_ms) || 0), 0);
  const counts = classified.counts;
  const missCorrect = graniteMisses.filter((r) => r.independent === r.expected).length;
  const sameWrong = classified.rows.filter((r) => r.bucket === 'both_wrong_same').length;
  const familiesResolved = residuals.filter((f) => f.observations.some((o) => o.independent_correct) && f.observations.every((o) => o.granite_correct === false || o.independent_correct));
  const familiesShared = residuals.filter((f) => f.observations.some((o) => o.agree && !o.granite_correct && !o.independent_correct));
  const role = (() => {
    if (b.exact_accuracy > 0.967 + 0.02) return 'replacement recognizer';
    if (gate.auto_accepted.precision >= 0.99 && gate.auto_accepted.pct >= 0.5 && missCorrect > 0) return 'verifier';
    if (latency.independent_mean_ms < latency.granite_mean_ms / 5 && b.exact_accuracy >= 0.8) return 'fallback / future fast-first';
    return 'none';
  })();
  const freeze = gate.auto_accepted.precision >= 0.99 && gate.auto_accepted.wrong === 0;
  const answers = [
    '1. `microsoft/trocr-small-handwritten` (TrOCR/IAM). 2. EasyOCR English CRNN. 3. PaddleOCR PP-OCRv4/v5 rec. Details in `candidate-investigation.md`.',
    `**${INDEPENDENT_MODEL_ID}**. Handwriting-specific, architecturally independent from Granite, CPU-viable, transformers/torch already installed. EasyOCR and PaddleOCR were documented, not benchmarked.`,
    `${b.exact_correct}/${b.total} = ${fmtPct(b.exact_accuracy)} (${b.unknown} UNKNOWN, ${b.wrong} wrong).`,
    `mean ${(latency.independent_mean_ms / 1000).toFixed(3)}s; median ${(latency.independent_median_ms / 1000).toFixed(3)}s; total ${(inferMs / 1000).toFixed(1)}s. Granite mean ${(latency.granite_mean_ms / 1000).toFixed(2)}s; speedup ${latency.speedup.toFixed(1)}×.`,
    `${missCorrect}/17`,
    `${sameWrong} same-wrong numeric predictions (plus both-UNKNOWN if any).`,
    fmtPrec(gate.auto_accepted.precision),
    `${fmtPct(gate.auto_accepted.pct)} (${gate.auto_accepted.count}/519)`,
    `${gate.error_capture.routed_to_review}/17`,
    `${gate.false_review.unnecessarily_reviewed}/502`,
    residuals.filter((f) => f.observations.some((o) => o.independent_correct)).map((f) => f.label).join('; ') || 'none',
    familiesShared.map((f) => f.label).join('; ') || 'none',
    role,
    latency.speedup >= 5 && b.exact_accuracy >= 0.8
      ? `Yes, B is ~${latency.speedup.toFixed(0)}× faster than Granite. A future fast-first + Granite fallback is plausible if B’s accuracy is acceptable; not implemented here.`
      : `No. B is ${latency.speedup.toFixed(1)}× faster than Granite, but ${fmtPct(b.exact_accuracy)} exact is not a credible fast-first recognizer.`,
    freeze
      ? 'Yes: freeze Granite as primary with B agreement as the numeric gate.'
      : 'No. Do not freeze a numeric architecture/policy from #8D alone.',
  ];

  return [
    '# POC #8D — Independent Numeric Handwriting Verifier',
    '',
    'Final planned numeric-recognition POC. Granite self-consistency (#8C) is closed. This POC tests **one** independent handwriting OCR model as a verifier or replacement candidate.',
    '',
    'Ground truth scores policies and is never a policy input. Disagreements are not auto-corrected to B even if B matches paper.',
    '',
    '## Freeze',
    '',
    `- Detector: **${DETECTOR_VERSION}** SHA256 \`${frozen.detector_sha256}\``,
    `- detect.py SHA256 \`${sha256File(DETECT_PY)}\``,
    `- Membership: **519** frozen POC #8B clean crops`,
    `- Frozen Granite #8B exact: **${graniteExact}/519**`,
    `- Independent model: \`${INDEPENDENT_MODEL_ID}\``,
    '',
    'POC #8 / #8B / #8C artifacts are unchanged.',
    '',
    '## Phase 1 — candidate investigation',
    '',
    'See `candidate-investigation.md`. Chosen: TrOCR-small-handwritten. EasyOCR and PaddleOCR were not installed or run.',
    '',
    '## Preprocessing (one pipeline, all 519)',
    '',
    '```',
    JSON.stringify(PREPROCESS, null, 2),
    '```',
    '',
    '## Independent recognizer B — raw results',
    '',
    `- exact: **${b.exact_correct}/${b.total}** (${fmtPct(b.exact_accuracy)})`,
    `- UNKNOWN: **${b.unknown}**`,
    `- wrong: **${b.wrong}**`,
    `- mean latency: **${(latency.independent_mean_ms / 1000).toFixed(3)} s/crop**`,
    `- median latency: **${(latency.independent_median_ms / 1000).toFixed(3)} s/crop**`,
    `- inference total (sum of per-crop): **${(inferMs / 1000).toFixed(1)} s**`,
    '',
    '### Per-field-kind',
    '',
    ...NUMERIC_FIELD_KINDS.filter((k) => b.by_kind?.[k]?.total).map((k) => {
      const s = b.by_kind[k];
      return `- ${k}: ${s.exact_correct}/${s.total} (${fmtPct(s.exact_accuracy)}); UNKNOWN ${s.unknown}; wrong ${s.wrong}`;
    }),
    '',
    '### Unique physical fields',
    '',
    `- unique all-photos-correct: **${b.unique_all_photos_correct} / ${b.unique_physical_fields}**`,
    `- unique consistent: **${b.unique_consistent}**`,
    '',
    'Native token-probability confidence was recorded. No GT-tuned threshold was chosen.',
    '',
    '## Complementarity vs frozen Granite',
    '',
    `- Granite correct / B correct / agree: **${counts.both_correct_agree || 0}**`,
    `- Granite correct / B correct / disagree: **${counts.both_correct_disagree || 0}**`,
    `- Granite correct / B wrong: **${counts.granite_correct_b_wrong || 0}**`,
    `- Granite wrong / B correct: **${counts.granite_wrong_b_correct || 0}**`,
    `- Granite wrong / B wrong same value: **${counts.both_wrong_same || 0}**`,
    `- Granite wrong / B wrong different value: **${counts.both_wrong_different || 0}**`,
    `- Granite UNKNOWN / B correct: **${counts.granite_unknown_b_correct || 0}**`,
    `- Granite correct / B UNKNOWN: **${counts.granite_correct_b_unknown || 0}**`,
    `- both UNKNOWN: **${counts.both_unknown || 0}**`,
    `- Granite UNKNOWN / B wrong: **${counts.granite_unknown_b_wrong || 0}**`,
    `- Granite wrong / B UNKNOWN: **${counts.granite_wrong_b_unknown || 0}**`,
    '',
    '### When Granite is non-exact (17)',
    '',
    ...graniteMisses.map((r) => [
      `${r.photo_id}`,
      `${r.field_id}`,
      `expected: ${r.expected}`,
      `Granite: ${r.granite}`,
      `B: ${r.independent}`,
      `B confidence (geom mean token p): ${r.independent_confidence ?? 'n/a'}`,
      `agreement: ${r.agree}`,
      `which correct: ${r.which_correct}`,
    ].join('\n')),
    '',
    '## Known Granite residual families',
    '',
    ...residuals.flatMap((f) => [
      `### ${f.label}`,
      '',
      ...f.observations.map((o) => [
        `${o.photo_id} ${o.field_id}`,
        `expected ${o.expected}  Granite ${o.granite}  B ${o.independent}  conf ${o.independent_confidence ?? 'n/a'}  agree ${o.agree}  correct ${o.which_correct}  gate ${o.gate}`,
      ].join('\n')),
      '',
    ]),
    '## Agreement gate (predefined)',
    '',
    'AUTO_ACCEPT iff Granite and B are both numeric literals and equal. Else REVIEW_REQUIRED. No majority, no confidence pick, no semantics.',
    '',
    'AUTO_ACCEPT',
    '',
    `- count: **${gate.auto_accepted.count}** / 519 (${fmtPct(gate.auto_accepted.pct)})`,
    `- correct: **${gate.auto_accepted.correct}**`,
    `- wrong: **${gate.auto_accepted.wrong}**`,
    `- precision: **${fmtPrec(gate.auto_accepted.precision)}**`,
    '',
    'REVIEW_REQUIRED',
    '',
    `- count: **${gate.review_required.count}** (${fmtPct(gate.review_required.pct)})`,
    `- Granite errors caught: **${gate.review_required.granite_errors_caught}**`,
    `- correct Granite values unnecessarily reviewed: **${gate.review_required.correct_granite_unnecessarily_reviewed}**`,
    '',
    `- error capture of 17: **${gate.error_capture.routed_to_review}/17** (remain AUTO_ACCEPT ${gate.error_capture.remain_auto_accept})`,
    `- false-review of 502: **${gate.false_review.unnecessarily_reviewed}/502**`,
    '',
    '## Independent-model confidence (exploratory)',
    '',
    `- records: ${confidence.n_with_confidence}`,
    `- geom-mean token p, correct: mean ${confidence.correct.mean?.toFixed?.(3) ?? 'n/a'} median ${confidence.correct.median?.toFixed?.(3) ?? 'n/a'} (n=${confidence.correct.n})`,
    `- geom-mean token p, wrong: mean ${confidence.wrong.mean?.toFixed?.(3) ?? 'n/a'} median ${confidence.wrong.median?.toFixed?.(3) ?? 'n/a'} (n=${confidence.wrong.n})`,
    `- wrong lower than correct (means): **${confidence.wrong_lower_than_correct}**`,
    '',
    'No production threshold was fit to ground truth.',
    '',
    '## Exploratory (not production)',
    '',
    `- If B replaced Granite: exact **${exploratory.b_only_exact}/519** (${fmtPct(exploratory.b_only_exact / 519)}).`,
    `- If disagreements selected B: exact **${exploratory.pick_b_on_disagree_exact}/519**. This would be correction, not verification. Not proposed.`,
    '',
    '## Latency',
    '',
    `- Granite mean: **${(latency.granite_mean_ms / 1000).toFixed(2)} s/crop**`,
    `- B mean: **${(latency.independent_mean_ms / 1000).toFixed(3)} s/crop** (${latency.speedup.toFixed(1)}×)`,
    `- 25 numeric fields: Granite only ~${latency.n25.granite_sec.toFixed(0)}s; B only ~${latency.n25.b_sec.toFixed(0)}s; Granite+B ~${latency.n25.both_sec.toFixed(0)}s.`,
    '',
    latency.speedup >= 5 && b.exact_accuracy >= 0.8
      ? 'A future fast-first architecture (B, Granite only on disagreement or low B confidence) is plausible on speed. Not implemented.'
      : 'Speed alone does not justify inverting the pipeline: B is fast but not an accurate numeric reader.',
    '',
    '## Contact sheets',
    '',
    ...sheets.notes,
    '',
    '## Required questions',
    '',
    ...answers.map((line, i) => `${i + 1}. ${line.replace(/^\d+\.\s/, '')}`),
    '',
    '## Decision',
    '',
    freeze
      ? `Agreement-gate precision ${fmtPrec(gate.auto_accepted.precision)} with ${gate.auto_accepted.wrong} auto-accepted errors. Candidate for a later freeze as a *gate*, not a corrector.`
      : `Do **not** freeze. B exact ${fmtPct(b.exact_accuracy)}; agreement precision ${fmtPrec(gate.auto_accepted.precision)}; ${gate.auto_accepted.wrong} agreed-and-wrong; B reads ${missCorrect}/17 Granite misses correctly. Role: **${role}**.`,
    '',
    '## STOP',
    '',
    'No second candidate, no model hunt, no Granite/prompt/crop/detector changes, no semantic correction, no inheritance, no canonical JSON, no review UI, no POC #9.',
    '',
    '## Artifacts',
    '',
    '- `poc8d/REPORT.md`',
    '- `poc8d/results.json`',
    '- `poc8d/candidate-investigation.md`',
    '- `poc8d/independent-results.json`',
    '- `poc8d/mismatches/`',
  ].join('\n');
}

export async function runPoc8d({ onProgress } = {}) {
  const frozen = assertDetectorFrozen();
  if (frozen.detector_sha256 !== FROZEN_DETECTOR_SHA256) {
    throw new Error('detector SHA mismatch');
  }
  if (sha256File(DETECT_PY) !== DETECT_PY_SHA256) {
    throw new Error(`detect.py is not frozen: ${sha256File(DETECT_PY)}`);
  }
  if (sha256File(DETECTOR_CONFIG_PATH) !== FROZEN_DETECTOR_SHA256) {
    throw new Error('detector config SHA mismatch');
  }
  const membership = loadPoc8Membership();
  if (membership.samples.length !== 519) {
    throw new Error(`membership ${membership.samples.length}`);
  }
  const rows8b = loadPoc8bRows();
  const graniteExact = rows8b.filter((r) => r.clean === r.expected).length;
  if (rows8b.length !== 519 || graniteExact !== 502) {
    throw new Error(`POC #8B drifted: ${graniteExact}/${rows8b.length}`);
  }

  fs.mkdirSync(POC8D_ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(path.join(POC8D_ARTIFACT_DIR, 'mismatches'), { recursive: true });

  const independent = await runIndependentRecognizer(rows8b, { onProgress });
  const byId = new Map(independent.results.map((r) => [r.sample_id, r]));
  const joined = rows8b.map((row) => {
    const rec = byId.get(row.sample_id);
    if (!rec) throw new Error(`independent missing ${row.sample_id}`);
    return {
      sample_id: row.sample_id,
      photo_id: row.photo_id,
      sheet_id: row.sheet_id,
      field_id: row.field_id,
      field_kind: row.field_kind,
      expected: row.expected,
      crop: row.crop_clean || row.crop,
      granite: row.clean,
      independent: rec.recognized,
      independent_raw: rec.raw,
      parse_reason: rec.parse_reason,
      confidence: rec.confidence,
      latency_ms: rec.latency_ms,
      error: rec.error,
    };
  });

  const samplesForScore = joined.map((r) => ({
    ...r,
    recognized: r.independent,
  }));
  const independentScore = scoreRecognizer(samplesForScore, {
    recognizer: INDEPENDENT_MODEL_ID,
    results: independent.results.map((r) => ({
      sample_id: r.sample_id,
      recognized: r.recognized,
      raw: r.raw,
      parse_reason: r.parse_reason,
      confidence: r.confidence?.geom_mean_token_prob ?? null,
      latency_ms: r.latency_ms,
      error: r.error,
    })),
    runtime_ms: independent.runtime_ms,
  });

  const classified = classifyRows(joined);
  const gate = evaluateAgreementGate(classified.rows);
  const residuals = residualTable(classified.rows);
  const graniteMisses = graniteMissTable(classified.rows);
  const confidence = confidenceAnalysis(classified.rows);

  const lats = classified.rows.map((r) => Number(r.latency_ms) || 0).filter((n) => n > 0);
  const gMean = graniteMeanMs();
  const bMean = mean(lats);
  const latency = {
    granite_mean_ms: gMean,
    independent_mean_ms: bMean,
    independent_median_ms: median(lats),
    speedup: bMean ? gMean / bMean : 0,
    n25: {
      granite_sec: (25 * gMean) / 1000,
      b_sec: (25 * bMean) / 1000,
      both_sec: (25 * (gMean + bMean)) / 1000,
    },
  };

  const exploratoryPickB = classified.rows.filter((r) => {
    if (r.granite === r.independent) return r.granite === r.expected;
    return r.independent === r.expected;
  }).length;

  const exploratory = {
    b_only_exact: independentScore.exact_correct,
    pick_b_on_disagree_exact: exploratoryPickB,
  };

  const mismatchDir = path.join(POC8D_ARTIFACT_DIR, 'mismatches');
  const tile = (r, recognized) => ({
    field_id: r.field_id,
    expected: r.expected,
    recognized,
    photo_id: r.photo_id,
    crop_original: r.crop,
    exact: recognized === r.expected,
    unknown: recognized === 'UNKNOWN',
  });
  const sheets = {};
  sheets.agreeWrong = await maybeSheet(
    classified.rows.filter((r) => r.gate.state === 'AUTO_ACCEPT' && r.gate.value !== r.expected).map((r) => tile(r, r.gate.value)),
    path.join(mismatchDir, 'agreement-wrong.png'),
    'POC #8D agreement AUTO_ACCEPT wrong',
  );
  sheets.gWrongBCorrect = await maybeSheet(
    classified.rows.filter((r) => r.bucket === 'granite_wrong_b_correct' || r.bucket === 'granite_unknown_b_correct').map((r) => tile(r, `${r.granite}|${r.independent}`)),
    path.join(mismatchDir, 'granite-wrong-independent-correct.png'),
    'POC #8D Granite miss / B correct',
  );
  sheets.gCorrectBWrong = await maybeSheet(
    classified.rows.filter((r) => r.bucket === 'granite_correct_b_wrong' || r.bucket === 'granite_correct_b_unknown').map((r) => tile(r, `${r.granite}|${r.independent}`)),
    path.join(mismatchDir, 'granite-correct-independent-wrong.png'),
    'POC #8D Granite correct / B miss',
  );
  sheets.notes = [
    sheets.agreeWrong.skipped ? '- `mismatches/agreement-wrong.png`: not written (zero).' : `- \`mismatches/agreement-wrong.png\`: ${sheets.agreeWrong.count} tiles.`,
    sheets.gWrongBCorrect.skipped ? '- `mismatches/granite-wrong-independent-correct.png`: not written (zero).' : `- \`mismatches/granite-wrong-independent-correct.png\`: ${sheets.gWrongBCorrect.count} tiles.`,
    sheets.gCorrectBWrong.skipped ? '- `mismatches/granite-correct-independent-wrong.png`: not written (zero).' : `- \`mismatches/granite-correct-independent-wrong.png\`: ${sheets.gCorrectBWrong.count} tiles.`,
  ];

  const report = buildReport({
    frozen,
    independentScore,
    graniteExact,
    classified,
    gate,
    residuals,
    graniteMisses,
    confidence,
    latency,
    sheets,
    exploratory,
  });

  const independentResults = {
    model_id: INDEPENDENT_MODEL_ID,
    model_type: INDEPENDENT_MODEL_TYPE,
    preprocess: PREPROCESS,
    device: independent.device,
    runtime_ms: independent.runtime_ms,
    rows: classified.rows.map((r) => ({
      sample_id: r.sample_id,
      photo_id: r.photo_id,
      sheet_id: r.sheet_id,
      field_id: r.field_id,
      field_kind: r.field_kind,
      expected: r.expected,
      granite: r.granite,
      independent: r.independent,
      independent_raw: r.independent_raw,
      confidence: r.confidence,
      latency_ms: r.latency_ms,
      bucket: r.bucket,
      gate: r.gate,
    })),
  };

  const results = {
    detector_version: DETECTOR_VERSION,
    detector_sha256: frozen.detector_sha256,
    detect_py_sha256: sha256File(DETECT_PY),
    membership: 519,
    granite_exact: graniteExact,
    independent_model: INDEPENDENT_MODEL_ID,
    independent_score: {
      exact_correct: independentScore.exact_correct,
      total: independentScore.total,
      exact_accuracy: independentScore.exact_accuracy,
      unknown: independentScore.unknown,
      wrong: independentScore.wrong,
      by_kind: independentScore.by_kind,
      unique_physical_fields: independentScore.unique_physical_fields,
      unique_all_photos_correct: independentScore.unique_all_photos_correct,
      unique_consistent: independentScore.unique_consistent,
      runtime_ms: independentScore.runtime_ms,
    },
    complementarity: classified.counts,
    agreement_gate: {
      ...gate,
    },
    granite_misses: graniteMisses,
    residual_families: residuals,
    confidence,
    latency,
    exploratory,
    contact_sheets: sheets.notes,
  };

  fs.writeFileSync(path.join(POC8D_ARTIFACT_DIR, 'REPORT.md'), report);
  fs.writeFileSync(path.join(POC8D_ARTIFACT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(POC8D_ARTIFACT_DIR, 'independent-results.json'), JSON.stringify(independentResults, null, 2));

  return {
    detector_sha256: frozen.detector_sha256,
    eligible_crops: 519,
    granite_exact: graniteExact,
    independent_exact: independentScore.exact_correct,
    agreement_precision: gate.auto_accepted.precision,
    report: path.join(POC8D_ARTIFACT_DIR, 'REPORT.md'),
    artifacts: {
      report: path.join(POC8D_ARTIFACT_DIR, 'REPORT.md'),
      results: path.join(POC8D_ARTIFACT_DIR, 'results.json'),
      independent_results: path.join(POC8D_ARTIFACT_DIR, 'independent-results.json'),
      investigation: path.join(POC8D_ARTIFACT_DIR, 'candidate-investigation.md'),
      mismatches: mismatchDir,
    },
  };
}
