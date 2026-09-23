import fs from 'node:fs';
import { ARTIFACT_DIR, registerV131Photo, validateB131Template, loadB131Template } from '../lib/workout/poc6/index.js';

const outDir = process.argv[2] || ARTIFACT_DIR;
const imagePath = process.argv[3];

const templateCheck = validateB131Template(loadB131Template());
if (!templateCheck.ok) {
  console.error(templateCheck);
  process.exit(1);
}

const result = await registerV131Photo({ outDir, imagePath });
fs.writeFileSync(`${outDir}/poc6-registration.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  ok: result.ok,
  image: { width: result.image_width, height: result.image_height },
  detected_ids: result.detected_ids,
  all_four: result.all_four_required_detected,
  canonical: [result.canonical_width, result.canonical_height],
  field_count: result.field_count,
  artifacts: result.artifacts,
  error: result.error || null,
}, null, 2));
if (!result.ok) process.exit(2);
