import sharp from 'sharp';

const DETECT_WIDTH = 900;
const PAPER_THRESHOLD = 175;
const MIN_EDGE = 768;

/**
 * Fractions of the detected paper. Tuned on the Routine B fixture photo.
 * Printed labels stay in-frame so the model can see which table it is looking at.
 */
export const PAPER_REGIONS = {
  header: { left: 0.04, top: 0.035, width: 0.92, height: 0.12 },
  B01: { left: 0.04, top: 0.165, width: 0.40, height: 0.155 },
  B02: { left: 0.42, top: 0.165, width: 0.52, height: 0.155 },
  B03: { left: 0.04, top: 0.31, width: 0.40, height: 0.15 },
  B04: { left: 0.42, top: 0.31, width: 0.52, height: 0.15 },
  B05: { left: 0.04, top: 0.445, width: 0.40, height: 0.13 },
  B06: { left: 0.42, top: 0.445, width: 0.52, height: 0.13 },
  B07: { left: 0.30, top: 0.525, width: 0.48, height: 0.11 },
  note: { left: 0.05, top: 0.635, width: 0.90, height: 0.07 },
};

export async function orientImage(imageBuffer) {
  return sharp(imageBuffer).rotate().jpeg({ quality: 92 }).toBuffer();
}

export async function detectPaperBox(orientedBuffer) {
  const meta = await sharp(orientedBuffer).metadata();
  const width = meta.width;
  const height = meta.height;
  const { data, info } = await sharp(orientedBuffer)
    .resize({ width: DETECT_WIDTH })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = info.width;
  let minY = info.height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[y * info.width + x] < PAPER_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX <= minX || maxY <= minY) {
    return { left: 0, top: 0, width, height, imageWidth: width, imageHeight: height };
  }

  const scaleX = width / info.width;
  const scaleY = height / info.height;
  const pad = Math.round(8 * scaleX);
  const left = Math.max(0, Math.round(minX * scaleX) - pad);
  const top = Math.max(0, Math.round(minY * scaleY) - pad);
  const right = Math.min(width, Math.round((maxX + 1) * scaleX) + pad);
  const bottom = Math.min(height, Math.round((maxY + 1) * scaleY) + pad);
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    imageWidth: width,
    imageHeight: height,
  };
}

export function regionPixels(paper, region) {
  const left = clamp(Math.round(paper.left + region.left * paper.width), 0, paper.imageWidth - 1);
  const top = clamp(Math.round(paper.top + region.top * paper.height), 0, paper.imageHeight - 1);
  const width = clamp(Math.round(region.width * paper.width), 1, paper.imageWidth - left);
  const height = clamp(Math.round(region.height * paper.height), 1, paper.imageHeight - top);
  return { left, top, width, height };
}

export async function cropRegion(orientedBuffer, region, paper) {
  const box = regionPixels(paper, region);
  let pipeline = sharp(orientedBuffer).extract(box);
  if (box.width < MIN_EDGE && box.height < MIN_EDGE) {
    pipeline = pipeline.resize({
      width: Math.max(box.width, MIN_EDGE),
      height: Math.max(box.height, MIN_EDGE),
      fit: 'inside',
      withoutEnlargement: false,
    });
  }
  const buffer = await pipeline.png().toBuffer();
  return { buffer, box };
}

export async function cropAllRegions(imageBuffer) {
  const oriented = await orientImage(imageBuffer);
  const paper = await detectPaperBox(oriented);
  const crops = {};
  for (const [name, region] of Object.entries(PAPER_REGIONS)) {
    crops[name] = await cropRegion(oriented, region, paper);
  }
  return { oriented, paper, crops };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
