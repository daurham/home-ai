import fs from 'node:fs';
import path from 'node:path';
import {
  EXPECTED_BLIND_SHA256,
  scorePoc11,
  verifyBlindChecksum,
  writePhase3Artifacts,
} from '../lib/workout/poc11Score.js';
import { POC11_ARTIFACT_DIR } from '../lib/workout/poc11.js';
import { DETECTOR_CONFIG_PATH } from '../lib/workout/poc7/index.js';
import { FROZEN_DETECTOR_SHA256, sha256File } from '../lib/workout/poc7b.js';

const checksum = verifyBlindChecksum();
if (!checksum.ok) {
  console.error('STOP: Phase 1 blind checksum mismatch', checksum);
  process.exit(2);
}
if (sha256File(DETECTOR_CONFIG_PATH) !== FROZEN_DETECTOR_SHA256) {
  console.error('STOP: detector freeze mismatch');
  process.exit(2);
}

const scored = scorePoc11();
if (scored.status === 'STOP') {
  console.error(scored);
  process.exit(2);
}
if (scored.checksum.fileHash !== EXPECTED_BLIND_SHA256) {
  console.error('STOP: scoring mutated or mismatched blind checksum', scored.checksum);
  process.exit(2);
}

writePhase3Artifacts(scored);
fs.writeFileSync(
  path.join(POC11_ARTIFACT_DIR, '.phase3-score-preview.json'),
  `${JSON.stringify({
    product: scored.product,
    registration: scored.registration,
    silent: scored.discrepancies.silent,
    caught: scored.discrepancies.caught.map((c) => ({
      photo: c.photo, field_id: c.field_id, kind: c.kind, gt: c.physical_gt, blind: c.blind_literal, issues: c.review_issues,
    })),
    false_review: scored.discrepancies.false_review,
    date: scored.date.rows,
    numeric_wrong: scored.numeric.rows.filter((r) => r.status !== 'exact'),
    assembly: scored.assembly.rows.map((r) => ({
      photo_id: r.photo_id,
      matching_sets: r.matching_sets,
      set_pairs: r.set_pairs,
      omitted_unused_rows: r.omitted_unused_rows,
      incorrect_inheritance: r.incorrect_inheritance,
      mismatches: r.mismatches,
    })),
    review_burden: scored.review_burden,
    structural: {
      checkbox: scored.structural.checkboxes,
      blank: {
        total: scored.structural.blank_nonblank.total,
        correct: scored.structural.blank_nonblank.correct,
        false_blank: scored.structural.blank_nonblank.false_blank,
        false_nonblank: scored.structural.blank_nonblank.false_nonblank,
        blank_specificity: scored.structural.blank_nonblank.blank_specificity,
        nonblank_recall: scored.structural.blank_nonblank.nonblank_recall,
      },
    },
    latency: scored.latency,
  }, null, 2)}\n`,
);

console.log(JSON.stringify({
  checksum: scored.checksum.fileHash,
  product: scored.product,
  silent: scored.discrepancies.silent.length,
  caught: scored.discrepancies.caught.length,
}, null, 2));
