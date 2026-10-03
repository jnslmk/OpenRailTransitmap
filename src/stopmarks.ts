/**
 * The pill a station is marked with, encoded as a signed-distance image.
 *
 * The mark has to be a bar of arbitrary length, laid at an arbitrary angle, and
 * measured in *pixels* - it spans bands whose spacing is a pixel quantity that
 * changes with zoom, not a distance on the ground. Of MapLibre's three point
 * primitives only a symbol can do that: a circle is round and a line's width is
 * the one dimension it controls. So each distinct span gets its own image, and
 * the layer picks between them with `icon-image`.
 *
 * That leaves one thing to get right, and it is the whole trick:
 *
 *   `icon-offset` is multiplied by `icon-size`, and rotates with `icon-rotate`.
 *
 * So if `icon-size` is set to exactly the factor the bundle spread uses at that
 * zoom, then an offset of `mid * PILL_PITCH` puts the bar's centre on the same
 * band its centre ordinal names, at every zoom, with no expression having to
 * know what the other is doing. Image length is measured in the same unit, so a
 * six-band bar covers six bands. The price is that the bar's *thickness* scales
 * with the spread too, which is why below z11 - where the spread deliberately
 * collapses so national-scale bundles read as one trunk - the marks are drawn
 * as plain dots instead and the pills fade in over the changeover.
 */

import type { Map as MLMap } from 'maplibre-gl';
import { BUNDLE_PITCH_PX } from '../shared/lnvg.ts';

/** Band pitch in image pixels: one image pixel is one pixel at `icon-size` 1. */
export const PILL_PITCH = BUNDLE_PITCH_PX;

/**
 * Bar thickness. Uniform, as on the reference poster - length carries how many
 * lines stop, so thickness must not also mean something. About two and a half
 * times a band's own width, which is where the poster's stop symbols sit.
 */
export const PILL_THICKNESS = 9;

/** Outline weight, in the same units. */
export const PILL_STROKE = 1.5;

/** MapLibre's SDF shader uses an eight-pixel distance range and a 0.75 edge. */
const SDF_RANGE = 8;
const SDF_EDGE = 0.75;
const PADDING = 2;

/** Longest bar we will draw. Germany's largest bundle is around 20 bands. */
const MAX_SPAN = 64;

/** Image ids are `<prefix><span>`, so the style can build one with `concat`. */
export const PILL_IMAGE_PREFIX = 'stop-pill-';

/** Image length in `icon-size` 1 pixels: the bands covered, plus a round end. */
export const pillLength = (span: number) => (Math.max(1, span) - 1) * PILL_PITCH + PILL_THICKNESS;

/**
 * Distance to a capsule's white fill. MapLibre antialiases its contour at the
 * displayed size; a supersampled bitmap aliases when its atlas is minified
 * without mipmaps. The halo supplies the outline, with padding for its AA.
 */
function drawPill(span: number): ImageData {
  const length = pillLength(span);
  const w = Math.ceil(length) + 2 * PADDING;
  const h = PILL_THICKNESS + 2 * PADDING;
  const image = new ImageData(w, h);
  const halfSegment = (length - PILL_THICKNESS) / 2;
  const radius = PILL_THICKNESS / 2 - PILL_STROKE;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.max(0, Math.abs(x + 0.5 - w / 2) - halfSegment);
      const dy = y + 0.5 - h / 2;
      const distance = radius - Math.hypot(dx, dy);
      image.data[(y * w + x) * 4 + 3] = Math.max(
        0,
        Math.min(255, Math.round(255 * (SDF_EDGE + distance / SDF_RANGE))),
      );
    }
  }
  return image;
}

/**
 * Make the pills available to the style, on demand.
 *
 * `styleimagemissing` fires the first time a tile asks for an image the style
 * has not got, and again after every `setStyle` - so registering the handler
 * once covers a session's worth of tiles without keeping a list of what has
 * been added.
 */
export function registerPillImages(map: MLMap): void {
  map.on('styleimagemissing', (e: { id: string }) => {
    const match = new RegExp(`^${PILL_IMAGE_PREFIX}(\\d+)$`).exec(e.id);
    if (!match || map.hasImage(e.id)) return;
    const span = Math.min(MAX_SPAN, Number(match[1]));
    const image = drawPill(span);
    map.addImage(e.id, image, { sdf: true });
  });
}
