/*
 * From http://www.redblobgames.com/maps/magpen4/
 * Copyright 2017 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 */

import Map from "./map.ts";
import type {Mesh} from "./types.d.ts";

/**
 * Fill a buffer with data from the mesh.
 */
function setMeshGeometry(mesh: Mesh, P: Float32Array) {
    let {numRegions, numTriangles} = mesh;
    if (P.length !== 2 * (numRegions + numTriangles)) { throw "wrong size"; }

    let p = 0;
    for (let r = 0; r < numRegions; r++) {
        P[p++] = mesh.is_ghost_r(r) ? 0.0 : mesh.x_of_r(r);
        P[p++] = mesh.is_ghost_r(r) ? 0.0 : mesh.y_of_r(r);
    }
    for (let t = 0; t < numTriangles; t++) {
        P[p++] = mesh.x_of_t(t);
        P[p++] = mesh.y_of_t(t);
    }
};

/**
 * Fill an indexed buffer with data from the map.
 */
function setMapGeometry(map: Map, mountain_folds: number, I: Int32Array, P: Float32Array) {
    let {mesh, flow_s, elevation_r, elevation_t, rainfall_r,
         terrain_r, terrain_t, terrainWeight_r, terrainWeight_t,
         terrainOther_r, terrainOther_t, terrainBlend_r, terrainBlend_t,
         country_r, country_t} = map;
    let {numSolidSides, numRegions, numTriangles, is_boundary_t} = mesh;

    if (I.length !== 3 * numSolidSides) { throw "wrong size"; }
    if (P.length !== 7 * (numRegions + numTriangles)) { throw "wrong size"; }

    let p = 0;
    for (let r = 0; r < numRegions; r++) {
        P[p++] = elevation_r[r];
        P[p++] = rainfall_r[r];
        P[p++] = terrain_r[r];
        P[p++] = terrainWeight_r[r];
        P[p++] = terrainOther_r[r];
        P[p++] = terrainBlend_r[r];
        P[p++] = country_r[r];
    }
    for (let t = 0; t < numTriangles; t++) {
        // The quadrilateral's folds can have a lower elevation to
        // make the valleys lower than the ridges. We'll apply it at
        // higher elevations, and not at all at sea level or below. I
        // also tried using slope but liked elevation better.
        P[p++] = (1.0 - mountain_folds * Math.sqrt(Math.max(0, elevation_t[t]))) * elevation_t[t];
        let s0 = 3*t;
        let r1 = mesh.r_begin_s(s0),
            r2 = mesh.r_begin_s(s0+1),
            r3 = mesh.r_begin_s(s0+2);
        P[p++] = 1/3 * (rainfall_r[r1] + rainfall_r[r2] + rainfall_r[r3]);
        P[p++] = terrain_t[t];
        P[p++] = terrainWeight_t[t];
        P[p++] = terrainOther_t[t];
        P[p++] = terrainBlend_t[t];
        P[p++] = country_t[t];
    }

    let i = 0;
    for (let s = 0; s < numSolidSides; s++) {
        let s_opposite = mesh.s_opposite_s(s),
            r1 = mesh.r_begin_s(s),
            r2 = mesh.r_begin_s(s_opposite),
            t1 = mesh.t_inner_s(s),
            t2 = mesh.t_inner_s(s_opposite);
        
        // Each quadrilateral is turned into two triangles, so each
        // half-edge gets turned into one. There are two ways to fold
        // a quadrilateral. This is usually a nuisance but in this
        // case it's a feature. See the explanation here
        // https://www.redblobgames.com/x/1725-procedural-elevation/#rendering
        let is_valley = false;
        if (elevation_r[r1] < 0.0 || elevation_r[r2] < 0.0) is_valley = true;
        if (flow_s[s] > 0 || flow_s[s_opposite] > 0) is_valley = true;
        if (is_boundary_t[t1] || is_boundary_t[t2]) is_valley = false;
        if (is_valley) {
            // It's a coastal or river edge, forming a valley
            I[i++] = r1; I[i++] = numRegions+t2; I[i++] = numRegions+t1;
        } else {
            // It's a ridge
            I[i++] = r1; I[i++] = r2; I[i++] = numRegions+t1;
        }
    }

    if (I.length !== i) { throw "wrong size"; }
    if (P.length !== p) { throw "wrong size"; }
};


export function clamp(x: number, lo: number, hi: number): number {
    if (x < lo) { x = lo; }
    if (x > hi) { x = hi; }
    return x;
}

/**
 * Fill a buffer with country border geometry. A border segment is drawn
 * along any side between two regions with different (valid) country ids.
 * Each vertex stores [x, y, w] where w = signed distance from the
 * centerline (-1 at one edge, +1 at the other); the shader turns this
 * into a soft alpha so the line is thin and smooth.
 *
 * a_em is the map geometry array (see setMapGeometry) with country ids
 * stored as the seventh float per vertex.
 */
function setBorderGeometry(mesh: Mesh, a_em: Float32Array, P: Float32Array): number {
    const {numSolidSides} = mesh;
    const HALF_WIDTH = 1.2; // model units; thin, softened in the shader
    let segments = 0;
    for (let s = 0; s < numSolidSides; s++) {
        let s2 = mesh.s_opposite_s(s);
        if (s2 < 0) continue;
        let r1 = mesh.r_begin_s(s),
            r2 = mesh.r_begin_s(s2);
        let c1 = a_em[7*r1 + 6], c2 = a_em[7*r2 + 6];
        if (c1 < 0 || c2 < 0 || c1 === c2) continue;

        let t1 = mesh.t_inner_s(s),
            t2 = mesh.t_inner_s(s2);
        let ax = mesh.x_of_t(t1), ay = mesh.y_of_t(t1),
            bx = mesh.x_of_t(t2), by = mesh.y_of_t(t2);
        let dx = bx-ax, dy = by-ay;
        let len = Math.sqrt(dx*dx + dy*dy) || 1;
        let nx = -dy/len * HALF_WIDTH, ny = dx/len * HALF_WIDTH;

        // Each vertex stores [x, y, w] where w = signed distance from the
        // centerline (-1 at one edge, +1 at the other). The shader turns
        // this into a soft alpha so the line is thin and smooth.
        let p = 18 * segments;
        P[p++] = ax+nx; P[p++] = ay+ny; P[p++] = 1;  // A + normal
        P[p++] = ax-nx; P[p++] = ay-ny; P[p++] = -1; // A - normal
        P[p++] = bx+nx; P[p++] = by+ny; P[p++] = 1;  // B + normal
        P[p++] = ax-nx; P[p++] = ay-ny; P[p++] = -1;
        P[p++] = bx-nx; P[p++] = by-ny; P[p++] = -1; // B - normal
        P[p++] = bx+nx; P[p++] = by+ny; P[p++] = 1;
        segments++;
    }
    return segments;
}

/**
 * Fill a buffer with river geometry
 */
function setRiverGeometry(map: Map, spacing: number, riversParam: any, P: Float32Array): number {
    const MIN_FLOW = Math.exp(riversParam.lg_min_flow);
    const RIVER_WIDTH = Math.exp(riversParam.lg_river_width);
    let {mesh, s_downslope_t, flow_s} = map;
    let {numSolidTriangles, length_s} = mesh;

    function riverSize(s: number, flow: number): number {
        if (s < 0) { return 1; }
        let width = Math.sqrt(flow - MIN_FLOW) * spacing * RIVER_WIDTH;
        return width / length_s[s];
    }

    let p = 0;
    for (let t = 0; t < numSolidTriangles; t++) {
        let s_out = s_downslope_t[t];
        let outflow = flow_s[s_out];
        if (s_out < 0 || outflow < MIN_FLOW) continue;
        let s_in1 = mesh.s_next_s(s_out);
        let s_in2 = mesh.s_next_s(s_in1);
        let flow_in1 = flow_s[mesh.s_opposite_s(s_in1)];
        let flow_in2 = flow_s[mesh.s_opposite_s(s_in2)];

        function add(s1, s2, s3, width1, width2) { // no flow on side s3
            let r1 = mesh.r_begin_s(s1),
                r2 = mesh.r_begin_s(s2),
                r3 = mesh.r_begin_s(s3);
            P[p++] = mesh.x_of_r(r1);
            P[p++] = mesh.y_of_r(r1);
            P[p++] = width1;
            P[p++] = width2;
            P[p++] = mesh.x_of_r(r2);
            P[p++] = mesh.y_of_r(r2);
            P[p++] = width1;
            P[p++] = width2;
            P[p++] = mesh.x_of_r(r3);
            P[p++] = mesh.y_of_r(r3);
            P[p++] = width1;
            P[p++] = width2;
        }

        if (flow_in1 >= MIN_FLOW) {
            add(s_out, s_in1, s_in2, riverSize(s_out, outflow), riverSize(s_in1, flow_in1));
        }
        if (flow_in2 >= MIN_FLOW) {
            add(s_in2, s_out, s_in1, riverSize(s_in2, flow_in2), riverSize(s_out, outflow));
        }
    }

    return p / 12;
};

export default {setMeshGeometry, setMapGeometry, setRiverGeometry, setBorderGeometry};
