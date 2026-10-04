/**
 * Generate self-hosted MapLibre glyph ranges.
 *
 * The reference document sets its labels in DB Sans, which is proprietary.
 * Fira Sans is a close free humanist substitute with the same slightly narrow
 * proportions, and covers German diacritics fully.
 *
 * Everything is served from our own Pages site - no runtime font CDN.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import fontnik from 'fontnik';

const OUT = 'public/fonts';

const FONTS = [
  { stack: 'Fira Sans Regular', file: 'pipeline/fonts/FiraSans-Regular.ttf' },
  { stack: 'Fira Sans Medium', file: 'pipeline/fonts/FiraSans-Medium.ttf' },
  { stack: 'Fira Sans Bold', file: 'pipeline/fonts/FiraSans-Bold.ttf' },
];

/**
 * Latin-1 covers German diacritics (ä/ö/ü/ß); Latin Extended-A adds the rest of
 * European spellings; the General Punctuation block carries the en dash used in
 * line names such as "Norddeich – Hannover".
 */
const RANGES: [number, number][] = [
  [0, 255],
  [256, 511],
  [8192, 8447],
];

const range = (font: Buffer, start: number, end: number): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    fontnik.range({ font, start, end }, (err: Error | null, buf: Buffer) =>
      err ? reject(err) : resolve(buf),
    ),
  );

async function main() {
  for (const { stack, file } of FONTS) {
    const dir = `${OUT}/${stack}`;
    if (RANGES.every(([s, e]) => existsSync(`${dir}/${s}-${e}.pbf`))) {
      console.log(`==> ${stack}: cached`);
      continue;
    }
    mkdirSync(dir, { recursive: true });

    const font = readFileSync(file);

    for (const [s, e] of RANGES) {
      writeFileSync(`${dir}/${s}-${e}.pbf`, await range(font, s, e));
    }
    console.log(`==> ${stack}: ${RANGES.length} ranges`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
