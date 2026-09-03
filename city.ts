/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2025 Red Blob Games <redblobgames@gmail.com>
 * @license Apache-2.0 <https://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * Shared constants for the city layout feature. A city zone is stored
 * per mesh region/triangle as -1 (not painted) or one of the zone
 * indices below; unpainted regions get an automatic zone from the
 * seeded layout in Map.assignCity().
 */

export const CITY_NONE = -1;
export const CITY_WATER = 0;
export const CITY_PARK = 1;
export const CITY_RESIDENTIAL = 2;
export const CITY_COMMERCIAL = 3;
export const NUM_CITY_ZONES = 4;

/* Object layer: a per-region value painted with dedicated brushes.
 * Bits are packed as (forbidden_bits << 4) | forced_bits. A forced bit
 * makes an object appear regardless of zone; a forbidden bit removes
 * it and stops it reappearing automatically. 0 = fully automatic. */
export const OBJ_NONE = 0;
export const OBJ_ROAD = 1;
export const OBJ_BUILDING = 2;
export const OBJ_TREE = 4;

export function objForced(obj: number, bit: number): boolean {
    return (obj & bit) !== 0;
}
export function objForbidden(obj: number, bit: number): boolean {
    return ((obj >> 4) & bit) !== 0;
}

export const cityPalette: Array<[number, number, number]> = [
    [0.20, 0.45, 0.70], // water
    [0.35, 0.60, 0.32], // park / trees
    [0.74, 0.67, 0.52], // residential
    [0.58, 0.58, 0.62], // commercial
];