/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2018 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * This module runs the worker thread that calculates the map data.
 */

import {TriangleMesh} from "./dual-mesh/index.ts";
import Map      from "./map.ts";
import Geometry from "./geometry.ts";
import type {Mesh} from "./types.d.ts";

// Terrain boundary blend field
//
// A world-level field on the paint canvas: for each canvas cell we find
// the nearest *different* painted terrain label and its distance, then
// turn the distance into a smoothstepped blend weight (0 far from any
// boundary, ~0.5 at a boundary). Vertices bilinearly-sample this
// (Map.assignTerrainBlend) so adjacent painted terrains crossfade over
// a world-space band instead of a one-cell hard edge. All-zero when
// blendWidth <= 0 or blending is disabled.

function buildTerrainField(terrainGrid: Float32Array, sizeW: number, sizeH: number, worldWidth: number, blendWidth: number, enabled: boolean): {otherLabel: Int8Array, blendFactor: Float32Array} {
    const N = sizeW * sizeH;
    const otherLabel = new Int8Array(N);
    const blendFactor = new Float32Array(N);

    if (!enabled || blendWidth <= 0) {
        return {otherLabel, blendFactor};
    }

    // label per canvas cell, matching Map.assignTerrain (round(grid/4))
    const label = new Int8Array(N);
    for (let p = 0; p < N; p++) {
        label[p] = Math.round(terrainGrid[p] / 4);
    }

    // world units per canvas cell (paint canvas matches the world aspect)
    const cellW = worldWidth / sizeW;
    const blendCells = blendWidth / cellW;

    // For each painted label (1..5), multi-source BFS its distance to every
    // cell; merge into each cell's nearest *foreign* label.
    const dist = new Int16Array(N);
    const queue = new Int32Array(N);
    const bestDist = new Int16Array(N).fill(32767);
    const bestOther = new Int8Array(N);

    for (let L = 1; L <= 5; L++) {
        dist.fill(32767);
        let qin = 0, qout = 0;
        for (let p = 0; p < N; p++) {
            if (label[p] === L) { dist[p] = 0; queue[qin++] = p; }
        }
        while (qout < qin) {
            const p = queue[qout++];
            const x = p % sizeW, y = (p / sizeW) | 0;
            const nd = dist[p] + 1;
            if (y > 0)       { const q = p - sizeW; if (dist[q] > nd) { dist[q] = nd; queue[qin++] = q; } }
            if (y < sizeH-1) { const q = p + sizeW; if (dist[q] > nd) { dist[q] = nd; queue[qin++] = q; } }
            if (x > 0)       { const q = p - 1;     if (dist[q] > nd) { dist[q] = nd; queue[qin++] = q; } }
            if (x < sizeW-1) { const q = p + 1;     if (dist[q] > nd) { dist[q] = nd; queue[qin++] = q; } }
        }
        for (let p = 0; p < N; p++) {
            if (label[p] === L || label[p] === 0) continue; // own or auto: no foreign blend
            if (dist[p] < bestDist[p]) { bestDist[p] = dist[p]; bestOther[p] = L; }
        }
    }

    // smoothstep the distance into a symmetric 0..0.5 blend weight: 0.5 at
    // a boundary (dist 0), 0 once dist >= blendCells (blendWidth in world).
    for (let p = 0; p < N; p++) {
        if (label[p] === 0 || bestOther[p] === 0) { blendFactor[p] = 0; continue; }
        let t = bestDist[p] / blendCells;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        t = t * t * (3 - 2 * t);
        blendFactor[p] = 0.5 * (1 - t);
    }

    return {otherLabel: bestOther, blendFactor};
}

// NOTE: Typescript workaround https://github.com/Microsoft/TypeScript/issues/20595
const worker: Worker = self as any;

// This handler is for the initial message
let handler = (event) => {
    // NOTE: web worker messages only include the data; to
    // reconstruct the full object I call the constructor again
    // and then copy the data over
    const mesh = new TriangleMesh(event.data.mesh as TriangleMesh);
    const map = new Map(mesh as Mesh, event.data.t_peaks, event.data.param);

    // TODO: placeholder - calculating elevation+biomes takes 35% of
    // the time on my laptop, and seeing the elevation change is the
    // most important thing to do every frame, so it might be worth
    // splitting this work up into multiple frames where
    // elevation+biomes happen every frame but rivers happen every N
    // frames. To do this I could either put the logic on the caller
    // side to decide on partial vs full update, or have the code here
    // decide. The advantage of deciding here is that we have the
    // timing information and can do full updates on faster machines
    // and partial updates on slower machines. But the advantage of
    // deciding in the caller is that it knows whether there's
    // painting going on, and can sneak in river updates while the
    // user has stopped painting.
    const run = {biomes: true, rivers: true};
    
    // This handler is for all subsequent messages
    handler = (event) => {
        let {param, constraints, quad_elements_buffer, a_quad_em_buffer, a_river_xyww_buffer, a_border_xy_buffer} = event.data;

        let numRiverTriangles = 0;
        let numBorderSegments = 0;
        let start_time = performance.now();
        
        if (run.biomes) {
            map.assignElevation(param.elevation, constraints);
            map.assignCountries(constraints.country, constraints.size.width, constraints.size.height);
            const terrainBlend = buildTerrainField(
                constraints.terrain, constraints.size.width, constraints.size.height,
                param.map.width, param.terrain?.blendWidth ?? 0, param.terrain?.blendEnabled ?? true);
            map.assignTerrain(constraints.terrain, constraints.size.width, constraints.size.height);
            map.assignTerrainBlend(terrainBlend.otherLabel, terrainBlend.blendFactor,
                                   constraints.size.width, constraints.size.height);
            map.assignRainfall(param.biomes);
        }
        if (run.rivers) {
            map.assignRivers(param.rivers);
        }
        if (run.biomes || run.rivers) {
            const quad_em = new Float32Array(a_quad_em_buffer);
            Geometry.setMapGeometry(map, param.elevation.mountain_folds, new Int32Array(quad_elements_buffer), quad_em);
            const a_border_xy = new Float32Array(a_border_xy_buffer);
            numBorderSegments = Geometry.setBorderGeometry(mesh, quad_em, a_border_xy);
        }
        if (run.rivers) {
            numRiverTriangles = Geometry.setRiverGeometry(map, param.spacing, param.rivers, new Float32Array(a_river_xyww_buffer));
        }
        let elapsed = performance.now() - start_time;

        worker.postMessage(
            {elapsed,
             numRiverTriangles,
             numBorderSegments,
             quad_elements_buffer,
             a_quad_em_buffer,
             a_river_xyww_buffer,
             a_border_xy_buffer,
            },
            [
                quad_elements_buffer,
                a_quad_em_buffer,
                a_river_xyww_buffer,
                a_border_xy_buffer,
            ]
        );
    };
};


onmessage = event => handler(event);
