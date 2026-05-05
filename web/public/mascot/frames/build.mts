/**
 * Assembles individual frame PNGs into mascot-sheet.png.
 *
 * Source of truth: mascot-manifest.json (in src/components/Mascot/).
 * Input:  frames/<sourceDir || animationKey>/<NN>.png  (one file per frame)
 * Output: ../mascot-sheet.png              (consumed by the web app at /mascot/mascot-sheet.png)
 *
 * Renderer-only flags (flipH, reverse) are ignored by this script — they are applied
 * at draw time in useSpriteRenderer.ts and require no extra spritesheet row.
 *
 * Entries that share a row with another entry via `sourceDir` are skipped during
 * compositing (the canonical entry already placed those frames on that row).
 *
 * Usage:
 *   cd web
 *   npx tsx public/mascot/frames/build.mts
 *
 * Or via the package.json script:
 *   pnpm run mascot:sprites:build
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MANIFEST_PATH = path.resolve(
  __dirname,
  '../../../src/components/Mascot/mascot-manifest.json',
);
const FRAMES_DIR = __dirname;
const OUTPUT_PATH = path.resolve(__dirname, '../mascot-sheet.png');

type AnimEntry = {
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
  flipH?: boolean;
  reverse?: boolean;
  sourceDir?: string;
};

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as {
  frameWidth: number;
  frameHeight: number;
  animations: Record<string, AnimEntry>;
};

const { frameWidth, frameHeight, animations } = manifest;
const MAX_COLS = 16;

// Determine which rows are "canonical" (will be composited) vs "alias" (share a row via sourceDir).
// A row is canonical for the first entry that references it; subsequent entries with the same row
// and a sourceDir are aliases and are skipped during compositing.
const canonicalRows = new Set<number>();
const compositeEntries: Array<[string, AnimEntry]> = [];

for (const [key, anim] of Object.entries(animations)) {
  if (anim.sourceDir && canonicalRows.has(anim.row)) {
    // This is a renderer alias — its frames are already on the sheet via the canonical entry.
    console.log(
      `  Skipping alias "${key}" (shares row ${anim.row} with sourceDir "${anim.sourceDir}")`,
    );
    continue;
  }
  canonicalRows.add(anim.row);
  compositeEntries.push([key, anim]);
}

const rows = canonicalRows.size;
const sheetWidth = MAX_COLS * frameWidth;
const sheetHeight = rows * frameHeight;

// Validate all expected frame files exist before doing any work.
const missing: string[] = [];
for (const [key, anim] of compositeEntries) {
  const dir = anim.sourceDir ?? key;
  for (let f = 0; f < anim.frames; f++) {
    const framePath = path.join(FRAMES_DIR, dir, `${String(f).padStart(2, '0')}.png`);
    if (!fs.existsSync(framePath)) {
      missing.push(framePath);
    }
  }
}
if (missing.length > 0) {
  console.error(`\nMissing ${missing.length} frame(s):\n`);
  for (const p of missing) {
    console.error(`  ${path.relative(process.cwd(), p)}`);
  }
  process.exit(1);
}

// Build composite layer list.
const composites: sharp.OverlayOptions[] = [];
for (const [key, anim] of compositeEntries) {
  const dir = anim.sourceDir ?? key;
  for (let f = 0; f < anim.frames; f++) {
    const framePath = path.join(FRAMES_DIR, dir, `${String(f).padStart(2, '0')}.png`);
    composites.push({
      input: framePath,
      left: f * frameWidth,
      top: anim.row * frameHeight,
    });
  }
}

console.log(`Building ${sheetWidth}×${sheetHeight} spritesheet…`);
console.log(`  ${rows} rows, up to ${MAX_COLS} frames each`);
console.log(`  Output: ${path.relative(process.cwd(), OUTPUT_PATH)}\n`);

await sharp({
  create: {
    width: sheetWidth,
    height: sheetHeight,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite(composites)
  .png({ compressionLevel: 9 })
  .toFile(OUTPUT_PATH);

console.log('Done.');
