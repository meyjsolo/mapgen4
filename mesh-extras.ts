/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2025 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * Shared helpers for moving TriangleMesh data between the worker and the
 * main thread, and for computing the extra per-mesh fields (is_boundary_t,
 * length_s) that mapgen4 adds on top of the dual-mesh library.
 */

import {TriangleMesh} from "./dual-mesh/index.ts";
import type {Mesh} from "./types.d.ts";

export type SerializedMesh = {
    points: Float32Array;
    triangles: Int32Array;
    halfedges: Int32Array;
    numBoundaryPoints: number;
    numSolidSides: number;
}

/** Pack a TriangleMesh into transferable arrays (worker side). */
export function serializeMesh(mesh: Mesh): SerializedMesh {
    const points = new Float32Array(2 * mesh.numRegions);
    for (let r = 0; r < mesh.numRegions; r++) {
        points[2*r] = mesh.x_of_r(r);
        points[2*r+1] = mesh.y_of_r(r);
    }
    return {
        points,
        triangles: mesh._triangles,
        halfedges: mesh._halfedges,
        numBoundaryPoints: mesh.numBoundaryRegions,
        numSolidSides: mesh.numSolidSides,
    };
}

/** Transferables for a SerializedMesh. */
export function serializeMeshTransferables(mesh: Mesh): ArrayBuffer[] {
    return [mesh._triangles.buffer, mesh._halfedges.buffer];
}

/** Reconstruct a TriangleMesh from a SerializedMesh (main thread side). */
export function deserializeMesh(data: SerializedMesh): Mesh {
    const points: Array<[number, number]> = [];
    for (let i = 0; i < data.points.length; i += 2) {
        points.push([data.points[i], data.points[i+1]]);
    }
    const mesh = new TriangleMesh({
        points,
        delaunator: {triangles: data.triangles, halfedges: data.halfedges},
        numBoundaryPoints: data.numBoundaryPoints,
        numSolidSides: data.numSolidSides,
    }) as Mesh;
    addMeshExtras(mesh);
    return mesh;
}

/**
 * Compute the extra fields mapgen4 uses that are not part of the
 * dual-mesh library: is_boundary_t (triangles touching a boundary
 * region) and length_s (length of each side). Mutates and returns mesh.
 */
export function addMeshExtras(mesh: Mesh): Mesh {
    mesh.is_boundary_t = new Int8Array(mesh.numTriangles);
    for (let t = 0; t < mesh.numTriangles; t++) {
        mesh.is_boundary_t[t] = mesh.r_around_t(t).some(r => mesh.is_boundary_r(r)) ? 1 : 0;
    }
    mesh.length_s = new Float32Array(mesh.numSides);
    for (let s = 0; s < mesh.numSides; s++) {
        let r1 = mesh.r_begin_s(s),
            r2 = mesh.r_end_s(s);
        let dx = mesh.x_of_r(r1) - mesh.x_of_r(r2),
            dy = mesh.y_of_r(r1) - mesh.y_of_r(r2);
        mesh.length_s[s] = Math.sqrt(dx*dx + dy*dy);
    }
    return mesh;
}
