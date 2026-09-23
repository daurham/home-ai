import fs from 'node:fs';
import { loadWorkoutConfig, ollamaModel } from '../lib/workout/config.js';
import { visionDebugImage } from '../lib/workout/ollama.js';

const config = loadWorkoutConfig();
const imageBuffer = fs.readFileSync(config.fixtureImagePath);

console.log(`Model: ${ollamaModel()}`);
console.log(`Fixture: ${config.fixtureImagePath}`);
console.log('Prompt: no schema, no transcription pack, /api/chat only');

const result = await visionDebugImage({ imageBuffer });
console.log(JSON.stringify(result, null, 2));
