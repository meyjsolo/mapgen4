/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2018 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * Configuration parameters shared by the point precomputation and the
 * map generator. Some of these objects are empty because they will be
 * filled in by the map generator.
 */

export default {
    spacing: 5.5,
    mountainSpacing: 25,
    map: {
        width: 2000,
        height: 1000,
    },
    terrain: {
        /* Terrain Boundary Color Blending: crossfade adjacent painted
         * terrains (forest<->grass, etc.) over a world-space band instead
         * of the default one-cell hard edge. blendWidth is in world units
         * and extends blendWidth into each side (total 2*blendWidth).
         * blendWidth = 0 (or blendEnabled = false) restores hard edges. */
        blendEnabled: true,
        blendWidth: 120,
    },
    mesh: {
        seed: 12345,
    },
    elevation: {
    },
    biomes: {
    },
    rivers: {
    },
    render: {
    },
};
