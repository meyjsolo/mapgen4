/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2025 Red Blob Games <redblobgames@gmail.com>
 * @license Apache-2.0 <https://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * Shared constants for the independent terrain types painted on the
 * wild map. Each terrain overrides the automatic biome colors for the
 * regions it covers; 0 means "automatic" (use elevation/moisture).
 */

export const TERRAIN_NONE = 0;
export const TERRAIN_SNOW = 1;

export const NUM_TERRAINS = 2;

export const terrainPalette: Array<[number, number, number]> = [
    [0.0, 0.0, 0.0],   // placeholder, unused
    [0.98, 0.98, 1.0], // snow: bright white with a hint of blue
];
