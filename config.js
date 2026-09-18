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
    /* native (LOD 0) spacing; keep for backwards compat with the
     * offline points-file generator */
    spacing: 5.5,
    mountainSpacing: 35,
    mesh: {
        seed: 12345,
    },
    /* Expanded world + tile pyramid. The world is a square of `size`
     * model units. It is split into tiles; at LOD `level` the tile
     * size and spacing are both divided by spacingFactor^level, so
     * every tile at every level holds about the same number of cells
     * (= native detail scale). Zoom out uses negative levels (coarse),
     * zoom in uses positive levels (fine, real extra detail). */
    world: {
        width: 4000,         /* world width in model units (4x the original) */
        height: 2000,        /* world height (2x the original) — world is 2:1 */
        baseSpacing: 5.5,    /* LOD 0 spacing = native detail scale */
        mountainSpacing: 35,
        baseTilesPerAxis: 4, /* LOD 0 tiles per X axis; LOD L: baseTilesPerAxis*2^L */
        maxTiles: 24,        /* LRU cache size (each tile ~30k cells) */
        maxWorkers: 4,       /* parallel generation workers (tiles are distributed round-robin) */
        paintCanvasSize: 512,/* painting constraint canvas width; the height is derived from the
                                world aspect so brushes keep the same geographic scale */
    },
    lod: {
        minLevel: -2,        /* coarsest spacing (22 at level -2) */
        maxLevel: 4,         /* finest spacing (~0.34 at level 4) */
        spacingFactor: 2,
        apronCells: 2,       /* halo cells around a tile used for seamless seams */
        maxVisibleTriangles: 300000, /* soft budget; coarsen tiles when exceeded */
        targetPixelsPerCell: 11,     /* screen px per cell at native LOD */
        riverFlowExponent: 2,        /* lg_min_flow is adjusted by this per LOD */
        maxInflight: 12,     /* max tiles in generation flight (across all workers) */
        paintDebounceMs: 30, /* delay before a regeneration round fires while painting */
        paintPreview: false, /* live colored brush overlay (optional; original feel = off) */
        referenceSpacing: 22,/* whole-world reference field resolution (= spacing at minLevel)
                                used for seamless rivers/rainfall across tiles */
    },
    elevation: {
    },
    biomes: {
    },
    rivers: {
    },
    render: {
    },
    benchmark: {
        enabled: true,
    },
};
