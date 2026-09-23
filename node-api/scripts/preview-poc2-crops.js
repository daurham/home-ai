import fs from 'node:fs';
import path from 'node:path';
import { loadWorkoutConfig } from '../lib/workout/config.js';
import { cropAllRegions, orientImage } from '../lib/workout/cropRegions.js';

const outDir = process.argv[2] || '/tmp/workout-poc2-crops';
fs.mkdirSync(outDir, { recursive: true });
const imageBuffer = fs.readFileSync(loadWorkoutConfig().fixtureImagePath);
fs.writeFileSync(path.join(outDir, 'oriented.jpg'), await orientImage(imageBuffer));
const { paper, crops } = await cropAllRegions(imageBuffer);
fs.writeFileSync(path.join(outDir, 'paper.json'), JSON.stringify(paper, null, 2));
for (const [name, crop] of Object.entries(crops)) {
  fs.writeFileSync(path.join(outDir, `${name}.png`), crop.buffer);
  console.log(name, crop.box);
}
console.log('paper', paper);
console.log(`wrote ${outDir}`);
