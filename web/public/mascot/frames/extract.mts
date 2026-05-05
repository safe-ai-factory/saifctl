/**
 * Generic spritesheet extractor.
 *
 * Splits a PNG spritesheet into individual frame files, row-by-row (left to
 * right, top to bottom). Does not know about animation names — every cell is
 * just a numbered frame.
 *
 * Usage:
 *   npx tsx extract.ts <sheet.png> <frameWidth> <frameHeight> [outputDir]
 *
 * Arguments:
 *   sheet.png    Path to the spritesheet (absolute or relative to cwd).
 *   frameWidth   Width of a single frame in pixels.
 *   frameHeight  Height of a single frame in pixels.
 *   outputDir    Optional. Directory where the "frames/" folder is created.
 *                Defaults to the current working directory.
 *
 * Output:
 *   <outputDir>/frames/0000.png, 0001.png, …
 *
 * Exits with an error if the sheet dimensions are not exact multiples of the
 * frame dimensions.
 *
 * Example:
 *   cd web
 *   npx tsx public/mascot/frames/extract.ts public/mascot/mascot-sheet.png 256 256
 */

import fs from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

function usage(): never {
  console.error('Usage: extract.ts <sheet.png> <frameWidth> <frameHeight> [outputDir]');
  process.exit(1);
}

const [, , sheetArg, frameWidthArg, frameHeightArg, outputDirArg] = process.argv;

if (!sheetArg || !frameWidthArg || !frameHeightArg) usage();

const sheetPath = path.resolve(process.cwd(), sheetArg);
const frameWidth = parseInt(frameWidthArg, 10);
const frameHeight = parseInt(frameHeightArg, 10);
const outputDir = outputDirArg ? path.resolve(process.cwd(), outputDirArg) : process.cwd();
const framesDir = path.join(outputDir, 'frames');

if (isNaN(frameWidth) || frameWidth <= 0) {
  console.error(`Invalid frameWidth: ${frameWidthArg}`);
  process.exit(1);
}
if (isNaN(frameHeight) || frameHeight <= 0) {
  console.error(`Invalid frameHeight: ${frameHeightArg}`);
  process.exit(1);
}
if (!fs.existsSync(sheetPath)) {
  console.error(`File not found: ${sheetPath}`);
  process.exit(1);
}

const meta = await sharp(sheetPath).metadata();
const sheetWidth = meta.width!;
const sheetHeight = meta.height!;

if (sheetWidth % frameWidth !== 0) {
  console.error(
    `Sheet width ${sheetWidth} is not a multiple of frame width ${frameWidth} (remainder: ${sheetWidth % frameWidth})`,
  );
  process.exit(1);
}
if (sheetHeight % frameHeight !== 0) {
  console.error(
    `Sheet height ${sheetHeight} is not a multiple of frame height ${frameHeight} (remainder: ${sheetHeight % frameHeight})`,
  );
  process.exit(1);
}

const cols = sheetWidth / frameWidth;
const rows = sheetHeight / frameHeight;
const total = cols * rows;
const pad = String(total - 1).length;

console.log(`Sheet:  ${sheetWidth}×${sheetHeight}`);
console.log(`Frames: ${cols} cols × ${rows} rows = ${total} total`);
console.log(`Output: ${framesDir}\n`);

fs.mkdirSync(framesDir, { recursive: true });

let index = 0;
for (let row = 0; row < rows; row++) {
  for (let col = 0; col < cols; col++) {
    const outFile = path.join(framesDir, `${String(index).padStart(pad, '0')}.png`);
    await sharp(sheetPath)
      .extract({
        left: col * frameWidth,
        top: row * frameHeight,
        width: frameWidth,
        height: frameHeight,
      })
      .png()
      .toFile(outFile);
    process.stdout.write(`\r  ${index + 1}/${total}`);
    index++;
  }
}

console.log('\nDone.');
