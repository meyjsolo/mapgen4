/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2025 Red Blob Games <redblobgames@gmail.com>
 * @license Apache-2.0 <https://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * Shared constants for the country-painting feature: a fixed-size
 * palette of country colors. Region ids on the painting canvas are
 * -1 (no country) or 0..NUM_COUNTRIES-1, matching the palettes.
 */

export const NUM_COUNTRIES = 8;

export const countryPalette: Array<[number, number, number]> = [
    [0.85, 0.25, 0.20], // red
    [0.18, 0.45, 0.90], // blue
    [0.25, 0.75, 0.40], // green
    [0.95, 0.68, 0.20], // orange
    [0.60, 0.30, 0.80], // purple
    [0.95, 0.25, 0.55], // pink
    [0.25, 0.75, 0.78], // teal
    [0.68, 0.62, 0.30], // olive
];