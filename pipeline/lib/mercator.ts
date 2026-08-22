/**
 * Inverse spherical Web Mercator, EPSG:3857 -> WGS84.
 *
 * Two upstream sources ship in 3857 rather than in degrees: the pre-assembled
 * coastline polygons (pipeline/coastline.ts) and DB InfraGO's infrastructure
 * restrictions (pipeline/closures.ts). Both are read straight into the
 * pipeline, and four lines of arithmetic here is what keeps GDAL out of CI for
 * a reprojection this shallow.
 */

/** Sphere radius Web Mercator is defined on - not the WGS84 ellipsoid's. */
const R = 6378137;

export function toWgs84(x: number, y: number): [number, number] {
  return [
    (x / R) * (180 / Math.PI),
    (Math.atan(Math.exp(y / R)) * 2 - Math.PI / 2) * (180 / Math.PI),
  ];
}
