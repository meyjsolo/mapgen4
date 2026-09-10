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

    // Mountain peaks were inserted as mesh regions (when accepted). Map
    // each peak that falls inside the rect to its neighboring triangle.
    const index = new Map<string, number>();
    for (let r = 0; r < mesh.numRegions; r++) {
        const key = mesh.x_of_r(r) + ',' + mesh.y_of_r(r);
        if (!index.has(key)) { index.set(key, r); }
    }

    const [x0, y0, w, h] = rect;
    const t_peaks: number[] = [];
    for (let i = 0; i < mountainPeaks.length; i += 2) {
        const px = mountainPeaks[i], py = mountainPeaks[i+1];
        if (px < x0 || px >= x0 + w || py < y0 || py >= y0 + h) continue;
        const r = index.get(px + ',' + py);
        if (r === undefined) continue;
        t_peaks.push(mesh.t_inner_s(mesh._s_of_r[r]));
    }

    return {mesh, t_peaks, numMountainPoints: data.numMountainPoints};
}
