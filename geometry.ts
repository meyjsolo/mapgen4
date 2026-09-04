/*
 * From http://www.redblobgames.com/maps/magpen4/
 * Copyright 2017 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 */

import Map from "./map.ts";
import {CITY_WATER, CITY_PARK, CITY_RESIDENTIAL, CITY_COMMERCIAL} from "./city.ts";
import {OBJ_ROAD, OBJ_BUILDING, OBJ_TREE, objForced, objForbidden} from "./city.ts";
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
    let {mesh, flow_s, elevation_r, elevation_t, rainfall_r, country_r, country_t, city_r, city_t, object_r, object_t, terrain_r, terrain_t, terrainWeight_r, terrainWeight_t} = map;
    let {numSolidSides, numRegions, numTriangles, is_boundary_t} = mesh;

    if (I.length !== 3 * numSolidSides) { throw "wrong size"; }
    if (P.length !== 7 * (numRegions + numTriangles)) { throw "wrong size"; }

    let p = 0;
    for (let r = 0; r < numRegions; r++) {
        P[p++] = elevation_r[r];
        P[p++] = rainfall_r[r];
        P[p++] = country_r[r];
        P[p++] = city_r[r];
        P[p++] = object_r[r];
        P[p++] = terrain_r[r];
        P[p++] = terrainWeight_r[r];
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
        P[p++] = country_t[t];
        P[p++] = city_t[t];
        P[p++] = object_t[t];
        P[p++] = terrain_t[t];
        P[p++] = terrainWeight_t[t];
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
 * Fill a buffer with country border quads. For each side between two
 * regions with different countries we emit a short thick line crossing
 * the side: a quad from one triangle centroid to the other. Returns
 * the number of border segments; each segment uses 6 vertices (2
 * triangles) of 2 floats each, so P must hold at least 12 floats per
 * segment.
 *
 * a_em is the map geometry array (see setMapGeometry) with country
 * ids stored as the third float per region vertex.
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
        let c1 = a_em[7*r1 + 2], c2 = a_em[7*r2 + 2];
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
 * Fill a buffer with city road quads. A road is placed along any side
 * between two regions where at least one region is developable
 * (residential or commercial) — never across water or through open
 * parkland. Roads are wider near the commercial center. Same geometry
 * as borders: each segment is a quad from one triangle centroid to the
 * other, 6 vertices of 2 floats each.
 *
 * a_em is the map geometry array (see setMapGeometry) with city zone
 * ids stored as the fourth float per region vertex.
 */
function setRoadGeometry(mesh: Mesh, a_em: Float32Array, P: Float32Array): number {
    const {numSolidSides} = mesh;
    const HALF_WIDTH = 3.0; // model units; ~0.3% of the map
    const CENTER_HALF_WIDTH = 4.5; // downtown main roads
    let segments = 0;
    for (let s = 0; s < numSolidSides; s++) {
        let s2 = mesh.s_opposite_s(s);
        if (s2 < 0) continue;
        let r1 = mesh.r_begin_s(s),
            r2 = mesh.r_begin_s(s2);
        let z1 = a_em[7*r1 + 3], z2 = a_em[7*r2 + 3];
        let o1 = a_em[7*r1 + 4], o2 = a_em[7*r2 + 4];
        if (z1 < 0 || z2 < 0) continue;
        // erase forbids the road, painted road forces it, otherwise
        // fall back to the automatic developable-zone placement
        if (objForbidden(o1, OBJ_ROAD) || objForbidden(o2, OBJ_ROAD)) continue;
        const dev1 = z1 === CITY_RESIDENTIAL || z1 === CITY_COMMERCIAL;
        const dev2 = z2 === CITY_RESIDENTIAL || z2 === CITY_COMMERCIAL;
        if (!dev1 && !dev2 && !objForced(o1, OBJ_ROAD) && !objForced(o2, OBJ_ROAD)) continue;
        const HALF = (z1 === CITY_COMMERCIAL || z2 === CITY_COMMERCIAL) ? CENTER_HALF_WIDTH : HALF_WIDTH;

        let t1 = mesh.t_inner_s(s),
            t2 = mesh.t_inner_s(s2);
        let ax = mesh.x_of_t(t1), ay = mesh.y_of_t(t1),
            bx = mesh.x_of_t(t2), by = mesh.y_of_t(t2);
        let dx = bx-ax, dy = by-ay;
        let len = Math.sqrt(dx*dx + dy*dy) || 1;
        let nx = -dy/len * HALF, ny = dx/len * HALF;

        let p = 12 * segments;
        P[p++] = ax+nx; P[p++] = ay+ny; // A + normal
        P[p++] = ax-nx; P[p++] = ay-ny; // A - normal
        P[p++] = bx+nx; P[p++] = by+ny; // B + normal
        P[p++] = ax-nx; P[p++] = ay-ny;
        P[p++] = bx-nx; P[p++] = by-ny; // B - normal
        P[p++] = bx+nx; P[p++] = by+ny;
        segments++;
    }
    return segments;
}

/** Deterministic 0..1 hash from a 2D position. */
function hash01(x: number, y: number): number {
    const h = Math.sin(x * 127.1 + y * 311.7);
    return h - Math.floor(h);
}

/**
 * Fill a buffer with extruded city buildings. Each developable region
 * (residential/commercial) on land that passes a seeded density test
 * gets a 3D box sitting on the terrain, scaled to its Voronoi cell so
 * streets stay visible between buildings. Returns the number of
 * buildings; each uses 30 vertices (5 faces) of 6 floats each
 * (x, y, z, r, g, b) with per-face shading baked in.
 *
 * a_em is the map geometry array (see setMapGeometry): elevation as
 * the first float and city zone as the fourth float per region vertex.
 */
function setBuildingGeometry(mesh: Mesh, a_em: Float32Array, P: Float32Array): number {
    const {numSolidRegions, numSolidTriangles} = mesh;
    const LIGHT = [0.35, 0.3, 1.0]; // fixed light from above-front
    const lightLen = Math.hypot(LIGHT[0], LIGHT[1], LIGHT[2]);
    let count = 0;
    const t_around: number[] = [];
    for (let r = 0; r < numSolidRegions; r++) {
        const zone = a_em[7*r + 3];
        const o = a_em[7*r + 4];
        if (objForbidden(o, OBJ_BUILDING)) continue; // erased: no building
        const forced = objForced(o, OBJ_BUILDING);
        // buildings belong in developable zones, unless explicitly painted
        if (!forced && zone !== CITY_RESIDENTIAL && zone !== CITY_COMMERCIAL) continue;
        const e = a_em[7*r + 0];
        if (e < 0.0) continue; // no buildings on water
        const x = mesh.x_of_r(r), y = mesh.y_of_r(r);
        const n = hash01(x, y);
        const density = zone === CITY_COMMERCIAL ? 0.85 : 0.55;
        if (!forced && n > density) continue;

        // footprint radius: average distance from the region center to
        // its triangle centroids, scaled down to leave street margins
        let sum = 0, cnt = 0;
        mesh.t_around_r(r, t_around);
        for (let t of t_around) {
            if (t >= numSolidTriangles) continue;
            sum += Math.hypot(mesh.x_of_t(t) - x, mesh.y_of_t(t) - y);
            cnt++;
        }
        if (cnt === 0) continue;
        const radius = (sum / cnt) * 0.55;
        if (radius < 0.5) continue;

        const h = zone === CITY_COMMERCIAL ? 5 + 4*n : 2 + 2*n;
        const base = zone === CITY_COMMERCIAL ? [0.55, 0.55, 0.62] : [0.72, 0.64, 0.50];
        const hx = radius, hy = radius;
        const corners = [
            [x-hx, y-hy, e], [x+hx, y-hy, e], [x+hx, y+hy, e], [x-hx, y+hy, e],
            [x-hx, y-hy, e+h], [x+hx, y-hy, e+h], [x+hx, y+hy, e+h], [x-hx, y+hy, e+h],
        ];
        const faces = [
            {q: [4,5,6,7], n: [0,0,1]},  // top
            {q: [0,1,5,4], n: [0,-1,0]}, // -y
            {q: [3,2,6,7], n: [0,1,0]},  // +y
            {q: [0,3,7,4], n: [-1,0,0]}, // -x
            {q: [1,2,6,5], n: [1,0,0]},  // +x
        ];
        let p = 180 * count;
        for (let f of faces) {
            const brightness = 0.45 + 0.55 * Math.max(0, (f.n[0]*LIGHT[0] + f.n[1]*LIGHT[1] + f.n[2]*LIGHT[2]) / lightLen);
            const cr = base[0]*brightness, cg = base[1]*brightness, cb = base[2]*brightness;
            for (let qi of [0,1,2, 0,2,3]) {
                const c = corners[f.q[qi]];
                P[p++] = c[0]; P[p++] = c[1]; P[p++] = c[2];
                P[p++] = cr; P[p++] = cg; P[p++] = cb;
            }
        }
        count++;
    }
    return count;
}

/**
 * Fill a buffer with city trees. Park regions get a dense canopy,
 * residential regions get the occasional yard tree; each tree is a
 * simple cone (6 side triangles) with per-face shading baked in.
 * Returns the number of trees; each uses 18 vertices of 6 floats each
 * (x, y, z, r, g, b). density scales how many regions get a tree.
 */
function setTreeGeometry(mesh: Mesh, a_em: Float32Array, P: Float32Array, density: number): number {
    const {numSolidRegions, numSolidTriangles} = mesh;
    const LIGHT = [0.35, 0.3, 1.0];
    const lightLen = Math.hypot(LIGHT[0], LIGHT[1], LIGHT[2]);
    const base = [0.16, 0.45, 0.20]; // dark green
    const SEG = 6;
    let count = 0;
    const t_around: number[] = [];
    for (let r = 0; r < numSolidRegions; r++) {
        const zone = a_em[7*r + 3];
        const o = a_em[7*r + 4];
        if (objForbidden(o, OBJ_TREE)) continue; // erased: no tree
        const forced = objForced(o, OBJ_TREE);
        // trees belong in parks and yards, unless explicitly painted
        if (!forced) {
            const isPark = zone === CITY_PARK;
            const isRes = zone === CITY_RESIDENTIAL;
            if (!isPark && !isRes) continue;
        }
        const e = a_em[7*r + 0];
        if (e < 0.0) continue;
        const x = mesh.x_of_r(r), y = mesh.y_of_r(r);
        const n = hash01(x, y);
        const isPark = zone === CITY_PARK;
        const threshold = (isPark ? 0.75 : 0.12) * density;
        if (!forced && n > threshold) continue;

        let sum = 0, cnt = 0;
        mesh.t_around_r(r, t_around);
        for (let t of t_around) {
            if (t >= numSolidTriangles) continue;
            sum += Math.hypot(mesh.x_of_t(t) - x, mesh.y_of_t(t) - y);
            cnt++;
        }
        if (cnt === 0) continue;
        const radius = (sum / cnt) * 0.30;
        if (radius < 0.5) continue;
        const h = 3 + 3*n; // tree height in model units

        let p = 108 * count;
        for (let i = 0; i < SEG; i++) {
            const a0 = 2 * Math.PI * i / SEG,
                  a1 = 2 * Math.PI * (i+1) / SEG;
            const b0x = x + radius * Math.cos(a0), b0y = y + radius * Math.sin(a0);
            const b1x = x + radius * Math.cos(a1), b1y = y + radius * Math.sin(a1);
            // face normal ≈ cross(apex→b0, apex→b1)
            const dx0 = b0x - x, dy0 = b0y - y,
                  dx1 = b1x - x, dy1 = b1y - y;
            const nx = h * (dy1 - dy0),
                  ny = h * (dx0 - dx1),
                  nz = dx0 * dy1 - dy0 * dx1;
            const nl = Math.hypot(nx, ny, nz) || 1;
            const brightness = 0.45 + 0.55 * Math.max(0, (nx*LIGHT[0] + ny*LIGHT[1] + nz*LIGHT[2]) / (nl * lightLen));
            const cr = base[0]*brightness, cg = base[1]*brightness, cb = base[2]*brightness;
            for (let c of [[x, y, e+h], [b0x, b0y, e], [b1x, b1y, e]]) {
                P[p++] = c[0]; P[p++] = c[1]; P[p++] = c[2];
                P[p++] = cr; P[p++] = cg; P[p++] = cb;
            }
        }
        count++;
    }
    return count;
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

export default {setMeshGeometry, setMapGeometry, setRiverGeometry, setBorderGeometry, setRoadGeometry, setBuildingGeometry, setTreeGeometry};
