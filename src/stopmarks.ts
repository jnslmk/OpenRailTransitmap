/**
 * The pill a station is marked with, drawn as an image and handed to MapLibre.
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
const PILL_STROKE = 1.5;

/** Supersampling. The image is scaled up to 1.6x at z14+, so 4x stays crisp. */
const RESOLUTION = 4;

/** Longest bar we will draw. Germany's largest bundle is around 20 bands. */
const MAX_SPAN = 64;

/** Image ids are `<prefix><span>`, so the style can build one with `concat`. */
export const PILL_IMAGE_PREFIX = 'stop-pill-';

/** Image length in `icon-size` 1 pixels: the bands covered, plus a round end. */
export const pillLength = (span: number) =>
  (Math.max(1, span) - 1) * PILL_PITCH + PILL_THICKNESS;

/**
 * White bar with a dark outline, long axis along +x, at `RESOLUTION` times the
 * size it is nominally drawn at.
 */
function drawPill(span: number): ImageData | null {
  const w = Math.max(1, Math.round(pillLength(span) * RESOLUTION));
  const h = Math.max(1, Math.round(PILL_THICKNESS * RESOLUTION));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const inset = (PILL_STROKE * RESOLUTION) / 2;
  const radius = h / 2 - inset;
  ctx.beginPath();
  // roundRect is in every browser this map already needs for WebGL 2; the arc
  // fallback keeps the mark from disappearing entirely if one turns up without.
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(inset, inset, w - 2 * inset, h - 2 * inset, radius);
  } else {
    ctx.moveTo(inset + radius, inset);
    ctx.lineTo(w - inset - radius, inset);
    ctx.arc(w - inset - radius, h / 2, radius, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(inset + radius, h - inset);
    ctx.arc(inset + radius, h / 2, radius, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
  }
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = PILL_STROKE * RESOLUTION;
  ctx.strokeStyle = '#1a1a1a';
  ctx.stroke();

  return ctx.getImageData(0, 0, w, h);
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
    if (image) map.addImage(e.id, image, { pixelRatio: RESOLUTION });
  });
}
