/**
 * Streamed line-delimited GeoJSON output.
 *
 * A single JSON.stringify over the national feature set produces a string well
 * past V8's maximum length and throws `Invalid string length`, so features are
 * serialised one at a time and written with backpressure. tippecanoe reads
 * line-delimited GeoJSON natively, and it also unlocks its parallel reader.
 */

import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

export async function writeFeatures(path: string, features: Iterable<unknown>): Promise<number> {
  const out = createWriteStream(path);
  let count = 0;

  for (const feature of features) {
    count++;
    if (!out.write(JSON.stringify(feature) + '\n')) {
      await once(out, 'drain');
    }
  }

  out.end();
  await once(out, 'finish');
  return count;
}
