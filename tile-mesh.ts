/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2025 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * Builds a TriangleMesh for a single world tile at a given LOD. Used
 * inside the worker thread; the main thread only receives the serialized
 * mesh (see mesh-extras.ts).
 */

import Delaunator from 'delaunator';
import {TriangleMesh} from "./dual-mesh/index.ts";
import {chooseTilePoints} from "./generate-points.ts";
import {addMeshExtras} from "./mesh-extras.ts";
import type {Mesh} from "./types.d.ts";

export type TileMeshData = {
    mesh: Mesh;
    t_peaks: number[];
    numMountainPoints: number;
}

/**
 * Build the mesh for tile (lod, tx, ty). `rect` is the tile's world
 * rectangle INCLUDING the apron/halo (i.e. the area actually sampled).
 * Mountain peaks from the world-level shared set that fall in `rect`
 * become constrained mesh points so mountains align across LODs/tiles.
 */
export function makeTileMesh(seed: number, spacing: number, mountainSpacing: number,
                             rect: [number, number, number, number],
                             mountainPeaks: Float32Array): TileMeshData {
    const data = chooseTilePoints(seed, spacing, mountainSpacing, rect, mountainPeaks);

    const meshInit = TriangleMesh.addGhostStructure({
        points: data.points,
        delaunator: Delaunator.from(data.points),
        numBoundaryPoints: data.numExteriorBoundaryPoints,
    });
    const mesh = new TriangleMesh(meshInit) as Mesh;
    addMeshExtras(mesh);

    // Mountain peaks are NOT mesh points; map each peak inside the rect to
    // its nearest region (via a coarse bucket index) so the mountain
    // distance field anchors correctly. The anchor is within ~half a cell
    // of the exact peak, keeping mountains aligned across LODs/tiles.
    const [x0, y0, w, h] = rect;
    const bucketSize = spacing * 4;
    const buckets = new Map<number, number[]>();
    const bw = Math.floor(w / bucketSize) + 2;
    for (let r = 0; r < mesh.numRegions; r++) {
        const bx = Math.floor((mesh.x_of_r(r) - x0) / bucketSize);
        const by = Math.floor((mesh.y_of_r(r) - y0) / bucketSize);
        const key = by * bw + bx;
        let arr = buckets.get(key);
        if (!arr) { arr = []; buckets.set(key, arr); }
        arr.push(r);
    }

    const t_peaks: number[] = [];
    for (let i = 0; i < mountainPeaks.length; i += 2) {
        const px = mountainPeaks[i], py = mountainPeaks[i+1];
        if (px < x0 || px >= x0 + w || py < y0 || py >= y0 + h) continue;
        const cx = (px - x0) / bucketSize, cy = (py - y0) / bucketSize;
        const bx = Math.floor(cx), by = Math.floor(cy);
        let bestR = -1, bestD = Infinity;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const arr = buckets.get((by + dy) * bw + (bx + dx));
                if (!arr) continue;
                for (const r of arr) {
                    const ddx = mesh.x_of_r(r) - px, ddy = mesh.y_of_r(r) - py;
                    const d = ddx*ddx + ddy*ddy;
                    if (d < bestD) { bestD = d; bestR = r; }
                }
            }
        }
        if (bestR >= 0) {
            t_peaks.push(mesh.t_inner_s(mesh._s_of_r[bestR]));
        }
    }

    return {mesh, t_peaks, numMountainPoints: data.numMountainPoints};
}
