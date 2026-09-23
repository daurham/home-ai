import { runPoc8c } from '../lib/workout/poc8c.js';

const phaseArg = process.argv.find((a) => a.startsWith('--phase='));
const phase = phaseArg ? phaseArg.slice('--phase='.length) : 'B';

const result = await runPoc8c({
  phase,
  onProgress: ({ recognizer, index, total, cached, recognized, sample_id, run }) => {
    const n = index + 1;
    if (cached && n % 25 !== 0 && n !== total) return;
    const rec = recognized ? ` -> ${recognized}` : cached ? ' cached' : '';
    const runLabel = run == null ? '' : ` run${run + 1}`;
    console.error(`${recognizer} ${n}/${total}${runLabel}${sample_id ? ` ${sample_id}` : ''}${rec}`);
  },
});

if (phase === 'probe-a') {
  console.log(JSON.stringify({
    phase: result.phase,
    crops: result.experimentA?.crops,
    usefulness: result.experimentA?.usefulness,
    detector_sha256: result.frozen?.detector_sha256,
  }, null, 2));
} else {
  console.log(JSON.stringify({
    detector_sha256: result.detector_sha256,
    eligible_crops: result.eligible_crops,
    poc8b_exact: result.poc8b_exact,
    experiment_a_useful: result.experiment_a_useful,
    chosen_policy: result.chosen_policy,
    policies: result.policies,
    report: result.report,
    artifacts: result.artifacts,
  }, null, 2));
}
