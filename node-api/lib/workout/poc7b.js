import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import {
  ARTIFACT_DIR,
  TEMPLATE_PATH,
  V131_CONFIG_DIR,
  loadB131Template,
  registerV131Photo,
  templateCoordinateFingerprint,
} from './poc6/index.js';
import {
  BENCHMARK_TRUTH_PATH,
  BLANK_TEMPLATE_PATH,
  DETECTOR_CONFIG_PATH,
  detectV131Observations,
  loadBenchmarkTruth,
  loadDetectorConfig,
  scoreObservations,
} from './poc7/index.js';

export const PREVIOUS_FROZEN_DETECTOR_SHA256 = 'b8a96560893d1c9906c01d6bc67ea66bd788d3ea411f9f4cd7a0585605f9ea80';
export const FROZEN_DETECTOR_SHA256 = '29efec983066a37008e88b3e778bdd6b8343681b689aa1a3200c28e3075bf0d4';
export const DETECTOR_VERSION = 'poc7-a1c';
export const POC7B_FIXTURES_DIR = path.join(V131_CONFIG_DIR, 'fixtures', 'poc7b');
export const POC7B_ARTIFACT_DIR = path.join(ARTIFACT_DIR, 'poc7b');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function gitCommitIfAvailable(cwd = V131_CONFIG_DIR) {
  const proc = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (proc.status !== 0) return null;
  return (proc.stdout || '').trim() || null;
}

export function snapshotFrozenConfig() {
  return {
    detector_config: DETECTOR_CONFIG_PATH,
    detector_version: DETECTOR_VERSION,
    detector_sha256: sha256File(DETECTOR_CONFIG_PATH),
    template_path: TEMPLATE_PATH,
    template_sha256: sha256File(TEMPLATE_PATH),
    template_coordinate_fingerprint_sha256: createHash('sha256')
      .update(templateCoordinateFingerprint(loadB131Template()))
      .digest('hex'),
    truth_path: BENCHMARK_TRUTH_PATH,
    truth_sha256: sha256File(BENCHMARK_TRUTH_PATH),
    git_commit: gitCommitIfAvailable(path.resolve(V131_CONFIG_DIR, '../../..')),
    captured_at: new Date().toISOString(),
  };
}

export function assertDetectorFrozen(snapshot = snapshotFrozenConfig()) {
  if (snapshot.detector_sha256 !== FROZEN_DETECTOR_SHA256) {
    throw new Error(
      `POC #7 detector is not frozen: ${snapshot.detector_sha256} !== ${FROZEN_DETECTOR_SHA256}`,
    );
  }
  return snapshot;
}

export function discoverPoc7bPhotos(dir = POC7B_FIXTURES_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => IMAGE_EXT.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.join(dir, name));
}

function copyNamed(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.copyFileSync(src, dest);
  return true;
}

function fixtureSlug(imagePath) {
  return path.parse(imagePath).name;
}

export function analyzeMargins(obs, truth = loadBenchmarkTruth()) {
  const checked = [];
  const unchecked = [];
  const nonblank = [];
  const blank = [];
  const confidences = { checkbox: [], field: [] };

  for (const [id, expected] of Object.entries(truth.checkboxes || {})) {
    const rec = obs.checkboxes?.[id];
    if (!rec) continue;
    confidences.checkbox.push({ id, confidence: rec.confidence, score: rec.score, state: rec.state });
    if (rec.state === expected && expected === 'checked') {
      checked.push({ id, score: rec.score, confidence: rec.confidence });
    }
    if (rec.state === expected && expected === 'unchecked') {
      unchecked.push({ id, score: rec.score, confidence: rec.confidence });
    }
  }
  for (const [id, expected] of Object.entries(truth.fields || {})) {
    const rec = obs.fields?.[id];
    if (!rec) continue;
    confidences.field.push({ id, confidence: rec.confidence, score: rec.score, state: rec.state });
    if (rec.state === expected && expected === 'nonblank') {
      nonblank.push({ id, score: rec.score, confidence: rec.confidence });
    }
    if (rec.state === expected && expected === 'blank') {
      blank.push({ id, score: rec.score, confidence: rec.confidence });
    }
  }

  const minBy = (rows, key) => rows.slice().sort((a, b) => a[key] - b[key])[0] || null;
  const maxBy = (rows, key) => rows.slice().sort((a, b) => b[key] - a[key])[0] || null;

  return {
    checkbox: {
      lowest_checked: minBy(checked, 'score'),
      highest_unchecked: maxBy(unchecked, 'score'),
      lowest_confidence: minBy(confidences.checkbox, 'confidence'),
      b04_s2_bw: obs.checkboxes?.['B04.S2.BW'] || null,
    },
    field: {
      lowest_nonblank: minBy(nonblank, 'score'),
      highest_blank: maxBy(blank, 'score'),
      lowest_confidence: minBy(confidences.field, 'confidence'),
    },
  };
}

function mismatchRows(photo, obs, score) {
  const rows = [];
  for (const m of score.checkboxes.mismatches) {
    const rec = obs.checkboxes?.[m.id] || {};
    rows.push({
      field: m.id,
      photo,
      expected: m.expected,
      observed: m.got,
      score: rec.score ?? null,
      confidence: rec.confidence ?? null,
      kind: 'checkbox',
    });
  }
  for (const m of score.fields.mismatches) {
    const rec = obs.fields?.[m.id] || {};
    rows.push({
      field: m.id,
      photo,
      expected: m.expected,
      observed: m.got,
      score: rec.score ?? null,
      confidence: rec.confidence ?? null,
      kind: 'field',
    });
  }
  return rows;
}

export async function runOnePoc7bPhoto({
  imagePath,
  outDir,
  blankPath = BLANK_TEMPLATE_PATH,
  truth = loadBenchmarkTruth(),
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const name = path.basename(imagePath);
  const meta = await sharp(imagePath).metadata();
  const source = {
    filename: name,
    path: imagePath,
    width: meta.width,
    height: meta.height,
    orientation: meta.orientation || 1,
  };

  const registration = await registerV131Photo({ imagePath, outDir });
  copyNamed(path.join(outDir, 'poc6-registration-debug.png'), path.join(outDir, 'registration-debug.png'));
  fs.writeFileSync(path.join(outDir, 'registration.json'), JSON.stringify(registration, null, 2));

  if (!registration.ok || !registration.all_four_required_detected) {
    return {
      source,
      registration: {
        status: 'FAIL',
        detected_ids: registration.detected_ids || [],
        error: registration.error || 'required markers missing',
        rectified_width: null,
        rectified_height: null,
      },
      detection: null,
      score: null,
      margins: null,
      mismatches: [],
      artifacts: {
        registration_debug: path.join(outDir, 'registration-debug.png'),
      },
    };
  }

  copyNamed(path.join(outDir, 'poc6-rectified.png'), path.join(outDir, 'rectified.png'));
  const rectifiedPath = path.join(outDir, 'rectified.png');
  const detection = await detectV131Observations({
    blankPath,
    observedPath: rectifiedPath,
    outDir,
  });
  copyNamed(path.join(outDir, 'poc7-checkbox-debug.png'), path.join(outDir, 'checkbox-debug.png'));
  copyNamed(path.join(outDir, 'poc7-blank-debug.png'), path.join(outDir, 'blank-debug.png'));
  copyNamed(path.join(outDir, 'poc7-difference-debug.png'), path.join(outDir, 'difference-debug.png'));

  const publicObs = {
    template: detection.template,
    source: imagePath,
    blank_template: blankPath,
    canonical: detection.canonical,
    detector_config: detection.detector_config,
    algorithm: detection.algorithm,
    checkboxes: detection.checkboxes,
    fields: detection.fields,
    counts: detection.counts,
  };
  const observationsPath = path.join(outDir, 'observations.json');
  fs.writeFileSync(observationsPath, JSON.stringify(publicObs, null, 2));

  const score = scoreObservations(detection, truth);
  const margins = analyzeMargins(detection, truth);
  return {
    source,
    registration: {
      status: 'PASS',
      detected_ids: registration.detected_ids,
      rectified_width: registration.canonical_width,
      rectified_height: registration.canonical_height,
      error: null,
    },
    detection: publicObs,
    score,
    margins,
    mismatches: mismatchRows(name, detection, score),
    artifacts: {
      registration_debug: path.join(outDir, 'registration-debug.png'),
      rectified: rectifiedPath,
      checkbox_debug: path.join(outDir, 'checkbox-debug.png'),
      blank_debug: path.join(outDir, 'blank-debug.png'),
      difference_debug: path.join(outDir, 'difference-debug.png'),
      observations: observationsPath,
    },
  };
}

function aggregateMargins(results) {
  const passed = results.filter((r) => r.registration.status === 'PASS' && r.margins);
  const pickMin = (rows) => rows.filter(Boolean).sort((a, b) => a.score - b.score)[0] || null;
  const pickMax = (rows) => rows.filter(Boolean).sort((a, b) => b.score - a.score)[0] || null;
  const withPhoto = (row, photo, extra = {}) => (row ? { ...row, photo, ...extra } : null);
  return {
    lowest_checked: pickMin(passed.map((r) => withPhoto(r.margins.checkbox.lowest_checked, r.source.filename))),
    highest_unchecked: pickMax(passed.map((r) => withPhoto(r.margins.checkbox.highest_unchecked, r.source.filename))),
    lowest_nonblank: pickMin(passed.map((r) => withPhoto(r.margins.field.lowest_nonblank, r.source.filename))),
    highest_blank: pickMax(passed.map((r) => withPhoto(r.margins.field.highest_blank, r.source.filename))),
    b04_s2_bw: passed.map((r) => ({
      photo: r.source.filename,
      state: r.margins.checkbox.b04_s2_bw?.state,
      score: r.margins.checkbox.b04_s2_bw?.score,
      confidence: r.margins.checkbox.b04_s2_bw?.confidence,
    })),
  };
}

function aggregate(results) {
  const passed = results.filter((r) => r.registration.status === 'PASS');
  const failed = results.filter((r) => r.registration.status === 'FAIL');
  let checkboxCorrect = 0;
  let checkboxTotal = 0;
  let checkboxUncertain = 0;
  let fieldCorrect = 0;
  let fieldTotal = 0;
  let fieldUncertain = 0;
  const mismatches = [];
  const weak = {};

  for (const r of passed) {
    checkboxCorrect += r.score.checkboxes.correct;
    checkboxTotal += r.score.checkboxes.total;
    checkboxUncertain += r.score.checkboxes.uncertain;
    fieldCorrect += r.score.fields.correct;
    fieldTotal += r.score.fields.total;
    fieldUncertain += r.score.fields.uncertain;
    for (const m of r.mismatches) {
      mismatches.push(m);
      weak[m.field] = (weak[m.field] || 0) + 1;
    }
  }

  const pct = (n, d) => (d ? (100 * n) / d : 0);
  return {
    photos: results.length,
    registration_passed: passed.length,
    registration_failed: failed.length,
    checkboxes: {
      correct: checkboxCorrect,
      total: checkboxTotal,
      percent: pct(checkboxCorrect, checkboxTotal),
      uncertain: checkboxUncertain,
    },
    fields: {
      correct: fieldCorrect,
      total: fieldTotal,
      percent: pct(fieldCorrect, fieldTotal),
      uncertain: fieldUncertain,
    },
    mismatches,
    recurring_weak_fields: Object.entries(weak)
      .sort((a, b) => b[1] - a[1])
      .map(([field, fail_count]) => ({ field, fail_count })),
    margins: aggregateMargins(results),
  };
}

function fmtMargin(row, label) {
  if (!row) return `  ${label}: n/a`;
  const photo = row.photo ? `  [${row.photo}]` : '';
  return `  ${label}: ${row.id} score=${Number(row.score).toFixed(4)} conf=${Number(row.confidence).toFixed(2)}${photo}`;
}

export function formatPoc7bReport(payload) {
  const lines = [];
  lines.push('# POC #7B frozen-detector multi-photo benchmark');
  lines.push('');
  lines.push('Detector configuration was not modified. Truth is the existing POC #7 sheet labels.');
  lines.push('');
  lines.push(`Photos tested: ${payload.aggregate.photos}`);
  lines.push(`Registration: ${payload.aggregate.registration_passed} PASS / ${payload.aggregate.registration_failed} FAIL`);
  lines.push(`Checkboxes: ${payload.aggregate.checkboxes.correct}/${payload.aggregate.checkboxes.total} (${payload.aggregate.checkboxes.percent.toFixed(1)}%) uncertain=${payload.aggregate.checkboxes.uncertain}`);
  lines.push(`Blank/nonblank: ${payload.aggregate.fields.correct}/${payload.aggregate.fields.total} (${payload.aggregate.fields.percent.toFixed(1)}%) uncertain=${payload.aggregate.fields.uncertain}`);
  lines.push('');
  lines.push(`Detector SHA256 before: ${payload.snapshot_before.detector_sha256}`);
  lines.push(`Detector SHA256 after:  ${payload.snapshot_after.detector_sha256}`);
  lines.push(`Frozen expected SHA256: ${FROZEN_DETECTOR_SHA256}`);
  lines.push(`Git commit: ${payload.snapshot_before.git_commit || 'n/a'}`);
  lines.push('');
  const gm = payload.aggregate.margins || {};
  lines.push('## Global score margins (correct classifications only)');
  lines.push(fmtMargin(gm.lowest_checked, 'weakest checked'));
  lines.push(fmtMargin(gm.highest_unchecked, 'strongest unchecked leftover'));
  lines.push(fmtMargin(gm.lowest_nonblank, 'weakest nonblank'));
  lines.push(fmtMargin(gm.highest_blank, 'strongest blank leftover'));
  if (gm.b04_s2_bw) {
    lines.push('B04.S2.BW across photos:');
    for (const row of gm.b04_s2_bw) {
      lines.push(`  ${row.photo}: state=${row.state} score=${Number(row.score).toFixed(4)} conf=${Number(row.confidence).toFixed(2)}`);
    }
  }
  lines.push('');

  for (const r of payload.photos) {
    lines.push(`## ${r.source.filename}`);
    lines.push(`SOURCE: ${r.source.width}×${r.source.height}`);
    lines.push(`REGISTRATION: ${r.registration.status}  ids=${JSON.stringify(r.registration.detected_ids)}  rectified=${r.registration.rectified_width || '-'}x${r.registration.rectified_height || '-'}`);
    if (r.registration.status === 'FAIL') {
      lines.push(`  error: ${r.registration.error}`);
      lines.push('');
      continue;
    }
    const c = r.score.checkboxes;
    const f = r.score.fields;
    lines.push(`CHECKBOXES: ${c.correct}/27 (${c.percent.toFixed(1)}%) uncertain=${c.uncertain}`);
    lines.push(`  checked→unchecked=${c.checked_to_unchecked} unchecked→checked=${c.unchecked_to_checked} checked→uncertain=${c.checked_to_uncertain} unchecked→uncertain=${c.unchecked_to_uncertain}`);
    lines.push(`BLANK/NONBLANK: ${f.correct}/45 (${f.percent.toFixed(1)}%) uncertain=${f.uncertain}`);
    lines.push(`  blank→nonblank=${f.blank_to_nonblank} nonblank→blank=${f.nonblank_to_blank} blank→uncertain=${f.blank_to_uncertain} nonblank→uncertain=${f.nonblank_to_uncertain}`);
    if (r.mismatches.length === 0) lines.push('MISMATCHES: none');
    else {
      lines.push('MISMATCHES:');
      for (const m of r.mismatches) {
        lines.push(`  ${m.field}: expected ${m.expected}, got ${m.observed}  score=${m.score} conf=${m.confidence}`);
      }
    }
    const m = r.margins;
    lines.push('MARGINS:');
    lines.push(fmtMargin(m.checkbox.lowest_checked, 'lowest checked'));
    lines.push(fmtMargin(m.checkbox.highest_unchecked, 'highest unchecked'));
    lines.push(fmtMargin(m.checkbox.lowest_confidence, 'lowest checkbox confidence'));
    if (m.checkbox.b04_s2_bw) {
      const b = m.checkbox.b04_s2_bw;
      lines.push(`  B04.S2.BW: state=${b.state} score=${Number(b.score).toFixed(4)} conf=${Number(b.confidence).toFixed(2)}`);
    }
    lines.push(fmtMargin(m.field.lowest_nonblank, 'lowest nonblank'));
    lines.push(fmtMargin(m.field.highest_blank, 'highest blank'));
    lines.push(fmtMargin(m.field.lowest_confidence, 'lowest field confidence'));
    lines.push('');
  }

  lines.push('## Per-field stability (any fail or uncertain)');
  if (payload.aggregate.mismatches.length === 0) {
    lines.push('none');
  } else {
    for (const m of payload.aggregate.mismatches) {
      lines.push(`- ${m.field}  ${m.photo}  expected ${m.expected}  observed ${m.observed}  score=${m.score}  conf=${m.confidence}`);
    }
  }
  lines.push('');
  lines.push('## Recurring weak fields');
  if (payload.aggregate.recurring_weak_fields.length === 0) {
    lines.push('none');
  } else {
    for (const row of payload.aggregate.recurring_weak_fields) {
      lines.push(`- ${row.field}: ${row.fail_count} photo(s)`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export async function runPoc7bBenchmark({
  photosDir = POC7B_FIXTURES_DIR,
  artifactsDir = POC7B_ARTIFACT_DIR,
  blankPath = BLANK_TEMPLATE_PATH,
} = {}) {
  const snapshotBefore = assertDetectorFrozen();
  const photos = discoverPoc7bPhotos(photosDir);
  if (photos.length === 0) {
    throw new Error(`no POC #7B photographs in ${photosDir}`);
  }
  if (!fs.existsSync(blankPath)) {
    throw new Error(`missing blank template ${blankPath}; run npm run poc7 first`);
  }
  fs.mkdirSync(artifactsDir, { recursive: true });
  const truth = loadBenchmarkTruth();
  const results = [];
  for (const imagePath of photos) {
    const outDir = path.join(artifactsDir, fixtureSlug(imagePath));
    results.push(await runOnePoc7bPhoto({ imagePath, outDir, blankPath, truth }));
  }
  const snapshotAfter = snapshotFrozenConfig();
  if (snapshotAfter.detector_sha256 !== snapshotBefore.detector_sha256) {
    throw new Error('detector configuration changed during POC #7B');
  }
  const payload = {
    snapshot_before: snapshotBefore,
    snapshot_after: snapshotAfter,
    frozen_detector_sha256: FROZEN_DETECTOR_SHA256,
    detector_config: loadDetectorConfig(),
    photos: results.map((r) => ({
      source: r.source,
      registration: r.registration,
      score: r.score,
      margins: r.margins,
      mismatches: r.mismatches,
      artifacts: r.artifacts,
    })),
    aggregate: aggregate(results),
  };
  const report = formatPoc7bReport(payload);
  const jsonPath = path.join(artifactsDir, 'report.json');
  const mdPath = path.join(artifactsDir, 'REPORT.md');
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(mdPath, report);
  payload.report_json = jsonPath;
  payload.report_markdown = mdPath;
  payload.artifact_dir = artifactsDir;
  payload.report = report;
  return payload;
}
