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
        /* canvasSize: 2048,    optional: pin the render-target width for all devices.
                                Default: auto-sized to the #map display rect x DPR (capped at 2048)
                                so mobile GPUs render at the screen's actual resolution. */
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
        riverFlowExponent: 2,        // lg_min_flow is adjusted by this per LOD
        localRivers: false,          // tile-local river chain (downslope/moisture/flow accumulation
                                      // + valley carving). false = no rivers and no river valleys;
                                      // biome rainfall still comes from the world reference field
        maxInflight: 12,     /* max tiles in generation flight (across all workers) */
        paintDebounceMs: 30, /* delay before a regeneration round fires while painting */
        paintPreview: false, /* live colored brush overlay (optional; original feel = off) */
        referenceSpacing: 22,/* whole-world reference field resolution (= spacing at minLevel)
                                used for seamless rivers/rainfall across tiles */
    },
    elevation: {
    },
    city: {
        /* Both default to false to strip the automatic city layer and
         * leave only what the user paints:
         *  - autoLayout: unpainted regions get an automatic zone layout
         *    (water on water, commercial near the center, residential
         *    around it, park on the outskirts)
         *  - autoObjects: roads/buildings/trees are placed automatically
         *    from zones (developable zones get roads + buildings, parks
         *    and yards get trees). When false, only explicitly painted
         *    zones and object brushes (force bits) appear. */
        autoLayout: false,
        autoObjects: false,
    },
    biomes: {
        /* When set (0..1), skip the wind/rain-shadow rainfall simulation on
         * the reference field and use this constant moisture everywhere:
         * biome colors collapse to a single hue (elevation white-blend only),
         * green/yellow patches and rain shadow disappear. null = simulate. */
        constantRainfall: 0.5,
    },
    rivers: {
    },
    render: {
    },
    benchmark: {
        enabled: false,     /* off by default: also opt in at runtime via ?bench=1
                               (enables the timing HUD + continuous rendering) */
    },
};
