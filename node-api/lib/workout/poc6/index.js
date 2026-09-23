import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const POC6_DIR = HERE;
export const V131_CONFIG_DIR = path.resolve(HERE, '../../../config/workout-v1.3.1');
export const TEMPLATE_PATH = path.join(V131_CONFIG_DIR, 'templates', 'B-1.3.1.json');
export const FIXTURE_PHOTO = path.join(V131_CONFIG_DIR, 'fixtures', 'routine-B-v1.3.1.jpg');
export const FIXTURE_PDF = path.join(
  V131_CONFIG_DIR,
  'fixtures',
  'routine-B-machine-readable-prototype-v1.3.1.pdf',
);
export const ARTIFACT_DIR = path.join(V131_CONFIG_DIR, 'artifacts');
export const REGISTER_PY = path.join(HERE, 'register.py');

export const CANONICAL_PAGE_WIDTH = 1700;
export const CANONICAL_PAGE_HEIGHT = 2200;
export const CANONICAL_DPI = 200;
export const REQUIRED_ARUCO_IDS = [10, 11, 12, 13];
export const ARUCO_ROLES = { 10: 'TL', 11: 'TR', 12: 'BR', 13: 'BL' };

const REQUIRED_FIELD_IDS = [
  'header.date', 'header.bodyweight', 'header.duration',
  'header.effort.1', 'header.effort.2', 'header.effort.3', 'header.effort.4', 'header.effort.5',
  'header.pain.0', 'header.pain.1', 'header.pain.2', 'header.pain.3', 'header.pain_area',
  'note.quick_note',
  'B01.S1.load', 'B01.S1.BW', 'B01.S1.reps',
  'B01.S2.load', 'B01.S2.BW', 'B01.S2.reps',
  'B01.S3.load', 'B01.S3.BW', 'B01.S3.reps',
  'B02.S1.load', 'B02.S1.BW', 'B02.S1.reps',
  'B02.S2.load', 'B02.S2.BW', 'B02.S2.reps',
  'B02.S3.load', 'B02.S3.BW', 'B02.S3.reps',
  'B03.S1.load', 'B03.S1.BW', 'B03.S1.reps',
  'B03.S2.load', 'B03.S2.BW', 'B03.S2.reps',
  'B03.S3.load', 'B03.S3.BW', 'B03.S3.reps',
  'B04.S1.load', 'B04.S1.BW', 'B04.S1.reps',
  'B04.S2.load', 'B04.S2.BW', 'B04.S2.reps',
  'B04.S3.load', 'B04.S3.BW', 'B04.S3.reps',
  'B05.S1.load', 'B05.S1.BW', 'B05.S1.left', 'B05.S1.right',
  'B05.S2.load', 'B05.S2.BW', 'B05.S2.left', 'B05.S2.right',
  'B06.S1.load', 'B06.S1.BW', 'B06.S1.reps',
  'B06.S2.load', 'B06.S2.BW', 'B06.S2.reps',
  'B07.S1.load', 'B07.S1.BW', 'B07.S1.left_seconds', 'B07.S1.right_seconds',
  'B07.S2.load', 'B07.S2.BW', 'B07.S2.left_seconds', 'B07.S2.right_seconds',
];

export function loadB131Template(templatePath = TEMPLATE_PATH) {
  return JSON.parse(fs.readFileSync(templatePath, 'utf8'));
}

export function validateB131Template(template = loadB131Template()) {
  const page = template.page || {};
  const errors = [];
  if (page.canonical_width !== CANONICAL_PAGE_WIDTH) errors.push('canonical_width');
  if (page.canonical_height !== CANONICAL_PAGE_HEIGHT) errors.push('canonical_height');
  if (page.canonical_dpi !== CANONICAL_DPI) errors.push('canonical_dpi');
  const ids = new Set((template.fields || []).map((f) => f.id));
  for (const id of REQUIRED_FIELD_IDS) {
    if (!ids.has(id)) errors.push(`missing ${id}`);
  }
  const width = page.canonical_width;
  const height = page.canonical_height;
  for (const field of template.fields || []) {
    const box = field.px;
    if (!box || box.w <= 0 || box.h <= 0) errors.push(`non-positive ${field.id}`);
    if (box.x < 0 || box.y < 0 || box.x + box.w > width || box.y + box.h > height) {
      errors.push(`oob ${field.id}`);
    }
  }
  return { ok: errors.length === 0, errors, requiredFieldCount: REQUIRED_FIELD_IDS.length, fieldCount: ids.size };
}

export function templateCoordinateFingerprint(template = loadB131Template()) {
  const rows = (template.fields || []).map((field) => {
    const b = field.px;
    return `${field.id}:${b.x},${b.y},${b.w},${b.h}`;
  });
  return rows.sort().join('|');
}

async function orientedJpeg(imagePath) {
  return sharp(imagePath).rotate().jpeg({ quality: 95 }).toBuffer();
}

export async function registerV131Photo({
  imagePath = FIXTURE_PHOTO,
  templatePath = TEMPLATE_PATH,
  outDir = ARTIFACT_DIR,
  pythonBin = process.env.POC6_PYTHON || 'python3',
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const oriented = await orientedJpeg(imagePath);
  const tmpPath = path.join(outDir, '.poc6-oriented.jpg');
  fs.writeFileSync(tmpPath, oriented);
  const proc = spawnSync(pythonBin, [
    REGISTER_PY,
    '--image', tmpPath,
    '--template', templatePath,
    '--out', outDir,
  ], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  fs.unlinkSync(tmpPath);
  if (proc.error) throw proc.error;
  if (proc.status !== 0 && !proc.stdout) {
    throw new Error(proc.stderr || `register.py exited ${proc.status}`);
  }
  const result = JSON.parse(proc.stdout);
  result.exit_code = proc.status;
  return result;
}
