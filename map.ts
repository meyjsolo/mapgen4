// @ts-check
/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2018 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * This module has the procedural map generation algorithms (elevations, rivers)
 */

import {createNoise2D} from 'simplex-noise';
import FlatQueue from 'flatqueue';
import {makeRandFloat} from '@redblobgames/prng';
import {clamp} from "./geometry.ts";
import param from "./config.js";
import {TERRAIN_NONE} from "./terrains.ts";
import type {Mesh} from "./types.d.ts";

type PrecalculatedNoise = {
    noise0_t: Float32Array;
    noise1_t: Float32Array;
    noise2_t: Float32Array;
    /* noise3_t wasn't being used */
    noise4_t: Float32Array;
    noise5_t: Float32Array;
    noise6_t: Float32Array;
}

const mountain = {
    slope: 16,
};

/**
 * Mountains are peaks surrounded by steep dropoffs. In the point
 * selection process (mesh.js) we pick the mountain peak locations.
 * Here we calculate a distance field from peaks to all other points.
 *
 * We'll use breadth first search for this because it's simple and
 * fast. Dijkstra's Algorithm would produce a more accurate distance
 * field, but we only need an approximation. For increased
 * interestingness, we add some randomness to the distance field.
 */
function calculateMountainDistance(mesh: Mesh, t_peaks: number[], spacing: number, jaggedness: number, randFloat: () => number, distance_t: Float32Array) {
    distance_t.fill(-1);
    let t_queue = t_peaks.concat([]);
    for (let i = 0; i < t_queue.length; i++) {
        let t_current = t_queue[i];
        for (let j = 0; j < 3; j++) {
            let s = 3 * t_current + j;
            let t_neighbor = mesh.t_outer_s(s);
            if (distance_t[t_neighbor] === -1) {
                let increment = spacing * (1 + jaggedness * (randFloat() - randFloat()));
                distance_t[t_neighbor] = distance_t[t_current] + increment;
                t_queue.push(t_neighbor);
            }
        }
    }
}

/**
 * Save noise values in arrays.
 */
function precalculateNoise(randFloat: () => number, mesh: Mesh): PrecalculatedNoise {
    const noise2D = createNoise2D(randFloat);
    let {numTriangles} = mesh;
    let noise0_t = new Float32Array(numTriangles),
        noise1_t = new Float32Array(numTriangles),
        noise2_t = new Float32Array(numTriangles),
        noise4_t = new Float32Array(numTriangles),
        noise5_t = new Float32Array(numTriangles),
        noise6_t = new Float32Array(numTriangles);
    for (let t = 0; t < numTriangles; t++) {
        let nx = (mesh.x_of_t(t) - param.map.width/2) / (param.map.width/2),
            ny = (mesh.y_of_t(t) - param.map.height/2) / (param.map.height/2);
        noise0_t[t] = noise2D(nx, ny);
        noise1_t[t] = noise2D(2*nx + 5, 2*ny + 5);
        noise2_t[t] = noise2D(4*nx + 7, 4*ny + 7);
        noise4_t[t] = noise2D(16*nx + 15, 16*ny + 15);
        noise5_t[t] = noise2D(32*nx + 31, 32*ny + 31);
        noise6_t[t] = noise2D(64*nx + 67, 64*ny + 67);
    }
    return {noise0_t, noise1_t, noise2_t, noise4_t, noise5_t, noise6_t};
}


export default class Map {
    seed: number = -1;
    spacing: number;
    precomputed: PrecalculatedNoise;
    mountainJaggedness: number = -Infinity;
    windAngleDeg: number = Infinity;
    elevation_t: Float32Array;
    elevation_r: Float32Array;
    humidity_r: Float32Array;
    moisture_t: Float32Array;
    rainfall_r: Float32Array;
    s_downslope_t: Int32Array;
    t_order: Int32Array;
    flow_t: Float32Array;
    flow_s: Float32Array;
    r_wind_order: Int32Array;
    wind_sort_r: Float32Array;
    mountain_distance_t: Float32Array;
    terrain_t: Float32Array;
    terrain_r: Float32Array;
    terrainWeight_t: Float32Array;
    terrainWeight_r: Float32Array;
    terrainOther_t: Float32Array;
    terrainOther_r: Float32Array;
    terrainBlend_t: Float32Array;
    terrainBlend_r: Float32Array;

    constructor (public mesh: Mesh, public t_peaks: number[], param: any) {
        this.spacing = param.spacing;
        this.elevation_t         = new Float32Array(mesh.numTriangles);
        this.elevation_r         = new Float32Array(mesh.numRegions);
        this.humidity_r          = new Float32Array(mesh.numRegions);
        this.moisture_t          = new Float32Array(mesh.numTriangles);
        this.rainfall_r          = new Float32Array(mesh.numRegions);
        this.s_downslope_t       = new Int32Array(mesh.numTriangles);
        this.t_order             = new Int32Array(mesh.numTriangles);
        this.flow_t              = new Float32Array(mesh.numTriangles);
        this.flow_s              = new Float32Array(mesh.numSides);
        this.r_wind_order        = new Int32Array(mesh.numRegions);
        this.wind_sort_r         = new Float32Array(mesh.numRegions);
        this.mountain_distance_t = new Float32Array(mesh.numTriangles);
        this.terrain_t           = new Float32Array(mesh.numTriangles);
        this.terrain_r           = new Float32Array(mesh.numRegions);
        this.terrainWeight_t     = new Float32Array(mesh.numTriangles);
        this.terrainWeight_r     = new Float32Array(mesh.numRegions);
        this.terrainOther_t      = new Float32Array(mesh.numTriangles);
        this.terrainOther_r      = new Float32Array(mesh.numRegions);
        this.terrainBlend_t      = new Float32Array(mesh.numTriangles);
        this.terrainBlend_r      = new Float32Array(mesh.numRegions);
    }

    /**
     * Assign the painted terrain type (e.g. snow) and a blend weight.
     * Each region/triangle gets:
     *  - terrain: nearest integer label (0=auto, 1=snow, 2=grass, ...)
     *  - terrainWeight: 0..1, distance to the nearest auto (label 0)
     *    cell, clamped. Only fades at painted→auto boundaries so painted
     *    terrain blends into the natural biome there; painted↔painted
     *    boundaries keep weight 1 and the vertex-shader terrain colors
     *    interpolate directly across the edge (no biome band).
     *
     * The distance is computed on the constraint canvas (cheap), then
     * weights are bilinear-sampled at each region/triangle centroid.
     */
    assignTerrain(terrainGrid: Float32Array, sizeW: number, sizeH: number) {
        let {mesh, terrain_t, terrain_r, terrainWeight_t, terrainWeight_r} = this;
        let {numSolidTriangles} = mesh;

        const BLEND = 3; // transition-band radius in canvas cells

        // 1. label per canvas cell (0..4)
        const label = new Int8Array(sizeW * sizeH);
        for (let p = 0; p < sizeW * sizeH; p++) {
            label[p] = Math.round(terrainGrid[p] / 4);
        }

        // 2. distance to the nearest auto (label 0) cell, via multi-source
        // BFS seeded from every auto cell and propagating through every
        // label. Painted cells far from any auto cell keep weight 1, so
        // painted↔painted boundaries don't fade — the vertex shader
        // interpolates the terrain colors directly across them.
        const dist = new Int16Array(sizeW * sizeH).fill(32767);
        const queue = new Int32Array(sizeW * sizeH);
        let qin = 0, qout = 0;
        for (let p = 0; p < sizeW * sizeH; p++) {
            if (label[p] === 0) { dist[p] = 0; queue[qin++] = p; }
        }
        while (qout < qin) {
            const p = queue[qout++];
            const x = p % sizeW, y = (p / sizeW) | 0;
            const nd = dist[p] + 1;
            if (y > 0)         { const q = p - sizeW; if (dist[q] > nd) { dist[q] = nd; queue[qin++] = q; } }
            if (y < sizeH-1)   { const q = p + sizeW; if (dist[q] > nd) { dist[q] = nd; queue[qin++] = q; } }
            if (x > 0)         { const q = p - 1;     if (dist[q] > nd) { dist[q] = nd; queue[qin++] = q; } }
            if (x < sizeW-1)   { const q = p + 1;     if (dist[q] > nd) { dist[q] = nd; queue[qin++] = q; } }
        }

        // 3. weight per canvas cell, bilinear-sampled at centroids
        const weight = new Float32Array(sizeW * sizeH);
        for (let p = 0; p < sizeW * sizeH; p++) {
            weight[p] = label[p] === 0 ? 0 : Math.min(1, dist[p] / BLEND);
        }

        function sampleLabel(x: number, y: number): number {
            x = clamp((x * sizeW) | 0, 0, sizeW - 1);
            y = clamp((y * sizeH) | 0, 0, sizeH - 1);
            return label[y * sizeW + x];
        }
        function sampleWeight(x: number, y: number): number {
            x = clamp(x * (sizeW-1), 0, sizeW-2);
            y = clamp(y * (sizeH-1), 0, sizeH-2);
            let xi = Math.floor(x), yi = Math.floor(y),
                xf = x - xi, yf = y - yi;
            let p = sizeW * yi + xi;
            let w00 = weight[p], w01 = weight[p + 1],
                w10 = weight[p + sizeW], w11 = weight[p + sizeW + 1];
            return ((w00 * (1 - xf) + w01 * xf) * (1 - yf)
                 + (w10 * (1 - xf) + w11 * xf) * yf);
        }

        for (let t = 0; t < numSolidTriangles; t++) {
            let x = mesh.x_of_t(t) / param.map.width, y = mesh.y_of_t(t) / param.map.height;
            terrain_t[t] = sampleLabel(x, y);
            terrainWeight_t[t] = sampleWeight(x, y);
        }
        for (let r = 0; r < mesh.numRegions; r++) {
            if (mesh.is_ghost_r(r)) { terrain_r[r] = TERRAIN_NONE; terrainWeight_r[r] = 0; continue; }
            let x = mesh.x_of_r(r) / param.map.width, y = mesh.y_of_r(r) / param.map.height;
            terrain_r[r] = sampleLabel(x, y);
            terrainWeight_r[r] = sampleWeight(x, y);
        }
    }

    /**
     * Sample the world-level terrain-blend field (computed once per
     * generation round on the paint canvas by the worker, see
     * buildTerrainField) at each region/triangle centroid.
     *
     * For each vertex we store:
     *  - terrainOther: the nearest *different* painted terrain label
     *    (0 when the vertex is auto or deep inside a single terrain)
     *  - terrainBlend: 0..0.5 weight toward that other terrain, already
     *    smoothstepped on the canvas. 0 far from any boundary, ~0.5 at a
     *    boundary. The vertex shader crossfades the two terrain colors by
     *    this factor, so the blend band is world-space wide (not one cell).
     */
    assignTerrainBlend(otherLabel: Int8Array, blendFactor: Float32Array, sizeW: number, sizeH: number) {
        let {mesh, terrainOther_t, terrainOther_r, terrainBlend_t, terrainBlend_r} = this;
        let {numSolidTriangles} = mesh;

        function sampleOther(x: number, y: number): number {
            x = clamp((x * sizeW) | 0, 0, sizeW - 1);
            y = clamp((y * sizeH) | 0, 0, sizeH - 1);
            return otherLabel[y * sizeW + x];
        }
        function sampleBlend(x: number, y: number): number {
            x = clamp(x * (sizeW-1), 0, sizeW-2);
            y = clamp(y * (sizeH-1), 0, sizeH-2);
            let xi = Math.floor(x), yi = Math.floor(y),
                xf = x - xi, yf = y - yi;
            let p = sizeW * yi + xi;
            let b00 = blendFactor[p], b01 = blendFactor[p + 1],
                b10 = blendFactor[p + sizeW], b11 = blendFactor[p + sizeW + 1];
            return ((b00 * (1 - xf) + b01 * xf) * (1 - yf)
                 + (b10 * (1 - xf) + b11 * xf) * yf);
        }

        for (let t = 0; t < numSolidTriangles; t++) {
            let x = mesh.x_of_t(t) / param.map.width, y = mesh.y_of_t(t) / param.map.height;
            terrainOther_t[t] = sampleOther(x, y);
            terrainBlend_t[t] = sampleBlend(x, y);
        }
        for (let r = 0; r < mesh.numRegions; r++) {
            if (mesh.is_ghost_r(r)) { terrainOther_r[r] = 0; terrainBlend_r[r] = 0; continue; }
            let x = mesh.x_of_r(r) / param.map.width, y = mesh.y_of_r(r) / param.map.height;
            terrainOther_r[r] = sampleOther(x, y);
            terrainBlend_r[r] = sampleBlend(x, y);
        }
    }

    assignTriangleElevation(elevationParam: { noisy_coastlines: number; mountain_sharpness: number; hill_height: number; ocean_depth: number; },
                            constraints: { constraints: Float32Array; size: any; }) {
        let {mesh, elevation_t, mountain_distance_t, precomputed} = this;
        let {numTriangles, numSolidTriangles} = mesh;

        // Assign elevations to triangles TODO: separate message,
        // store the interpolated values in an array, or maybe for
        // each painted cell store which triangle elevations have to
        // be updated, so that we don't have to recalculate the entire
        // map's interpolated values each time (involves copying 50k
        // floats instead of 16k floats), or maybe send a message with
        // the bounding box of the painted area, or maybe send the
        // drawing positions and parameters and let the painting happen
        // in this thread.
        function constraintAt(x: number, y: number): number {
            // https://en.wikipedia.org/wiki/Bilinear_interpolation
            const C = constraints.constraints, {width, height} = constraints.size;
            // NOTE: there's a tricky "off by one" problem here. Since
            // x can be from 0.000 to 0.999, and I want xInt+1 < size
            // to leave one extra tile for bilinear filtering, that
            // means I want xInt < size-1. So I need to multiply x and
            // y by size-1, not by size.
            x = clamp(x * (width-1), 0, width-2);
            y = clamp(y * (height-1), 0, height-2);
            let xInt = Math.floor(x),
                yInt = Math.floor(y),
                xFrac = x - xInt,
                yFrac = y - yInt;
            let p = width * yInt + xInt;
            let e00 = C[p],
            e01 = C[p + 1],
            e10 = C[p + width],
            e11 = C[p + width + 1];
            return ((e00 * (1 - xFrac) + e01 * xFrac) * (1 - yFrac)
                + (e10 * (1 - xFrac) + e11 * xFrac) * yFrac);
        }
        for (let t = 0; t < numSolidTriangles; t++) {
            let e = constraintAt(mesh.x_of_t(t)/param.map.width, mesh.y_of_t(t)/param.map.height);
            // TODO: e*e*e*e seems too steep for this, as I want this
            // to apply mostly at the original coastlines and not
            // elsewhere
            elevation_t[t] = e + elevationParam.noisy_coastlines * (1 - e*e*e*e) * (precomputed.noise4_t[t] + precomputed.noise5_t[t]/2 + precomputed.noise6_t[t]/4);
        }

        // For land triangles, mix hill and mountain terrain together
        const mountain_slope = mountain.slope,
              mountain_sharpness = Math.pow(2, elevationParam.mountain_sharpness),
              {noise0_t, noise1_t, noise2_t, noise4_t} = precomputed;
        for (let t = 0; t < numTriangles; t++) {
            let e = elevation_t[t];
            if (e > 0) {
                /* Mix two sources of elevation:
                 *
                 * 1. eh: Hills are formed using simplex noise. These
                 *    are very low amplitude, and the main purpose is
                 *    to make the rivers meander. The amplitude
                 *    doesn't make much difference in the river
                 *    meandering. These hills shouldn't be
                 *    particularly visible so I've kept the amplitude
                 *    low.
                 *
                 * 2. em: Mountains are formed using something similar to
                 *    worley noise. These form distinct peaks, with
                 *    varying distance between them.
                 */
                // TODO: precompute eh, em per triangle
                let noisiness = 1.0 - 0.5 * (1 + noise0_t[t]);
                let eh = (1 + noisiness * noise4_t[t] + (1 - noisiness) * noise2_t[t]) * elevationParam.hill_height;
                if (eh < 0.01) { eh = 0.01; }
                let em = 1 - mountain_slope/mountain_sharpness * mountain_distance_t[t];
                if (em < 0.01) { em = 0.01; }
                let weight = e * e;
                e = (1-weight) * eh + weight * em;
            } else {
                /* Add noise to make it more interesting. */
                e *= elevationParam.ocean_depth + noise1_t[t];
            }
            if (e < -1.0) { e = -1.0; }
            if (e > +1.0) { e = +1.0; }
            elevation_t[t] = e;
        }
    }

    assignRegionElevation() {
        let {mesh, elevation_t, elevation_r} = this;
        let {numRegions, _s_of_r, _halfedges} = mesh;
        for (let r = 0; r < numRegions; r++) {
            let count = 0, e = 0, water = false;
            const s0 = _s_of_r[r];
            let s_incoming = s0;
            do {
                let t = (s_incoming/3) | 0;
                e += elevation_t[t];
                water = water || elevation_t[t] < 0.0;
                let s_outgoing = mesh.s_next_s(s_incoming);
                s_incoming = _halfedges[s_outgoing];
                count++;
            } while (s_incoming !== s0);
            e /= count;
            if (water && e >= 0) { e = -0.001; }
            elevation_r[r] = e;
        }
    }

    assignElevation(elevationParam, constraints) {
        if (this.seed !== elevationParam.seed || this.mountainJaggedness !== elevationParam.mountain_jagged) {
            this.mountainJaggedness = elevationParam.mountain_jagged;
            calculateMountainDistance(
                this.mesh, this.t_peaks, this.spacing,
                this.mountainJaggedness, makeRandFloat(elevationParam.seed),
                this.mountain_distance_t
            );
        }

        if (this.seed !== elevationParam.seed) {
            // TODO: function should reuse existing arrays
            this.seed = elevationParam.seed;
            this.precomputed = precalculateNoise(makeRandFloat(elevationParam.seed), this.mesh);
        }

        this.assignTriangleElevation(elevationParam, constraints);
        this.assignRegionElevation();
    }

    assignRainfall(biomesParam) {
        const {mesh, r_wind_order, wind_sort_r, humidity_r, rainfall_r, elevation_r} = this;
        const {numRegions, _s_of_r, _halfedges} = mesh;

        if (biomesParam.wind_angle_deg != this.windAngleDeg) {
            this.windAngleDeg = biomesParam.wind_angle_deg;
            const windAngleRad = Math.PI / 180 * this.windAngleDeg;
            const windAngleVec = [Math.cos(windAngleRad), Math.sin(windAngleRad)];
            for (let r = 0; r < numRegions; r++) {
                r_wind_order[r] = r;
                wind_sort_r[r] = mesh.x_of_r(r) * windAngleVec[0] + mesh.y_of_r(r) * windAngleVec[1];
            }
            r_wind_order.sort((r1, r2) => wind_sort_r[r1] - wind_sort_r[r2]);
        }

        for (let r of r_wind_order) {
            let count = 0, sum = 0.0;
            let s0 = _s_of_r[r], s_incoming = s0;
            do {
                let r_neighbor = mesh.r_begin_s(s_incoming);
                if (wind_sort_r[r_neighbor] < wind_sort_r[r]) {
                    count++;
                    sum += humidity_r[r_neighbor];
                }
                let s_outgoing = mesh.s_next_s(s_incoming);
                s_incoming = _halfedges[s_outgoing];
            } while (s_incoming !== s0);

            let humidity = 0.0, rainfall = 0.0;
            if (count > 0) {
                humidity = sum / count;
                rainfall += biomesParam.raininess * humidity;
            }
            if (mesh.is_boundary_r(r)) {
                humidity = 1.0;
            }
            if (elevation_r[r] < 0.0) {
                let evaporation = biomesParam.evaporation * -elevation_r[r];
                humidity += evaporation;
            }
            if (humidity > 1.0 - elevation_r[r]) {
                let orographicRainfall = biomesParam.rain_shadow * (humidity - (1.0 - elevation_r[r]));
                rainfall += biomesParam.raininess * orographicRainfall;
                humidity -= orographicRainfall;
            }
            rainfall_r[r] = rainfall;
            humidity_r[r] = humidity;
        }
    }

    assignRivers(riversParam) {
        let {mesh, moisture_t, rainfall_r, elevation_t, s_downslope_t, t_order, flow_t, flow_s} = this;
        assignDownslope(mesh, elevation_t, s_downslope_t, t_order);
        assignMoisture(mesh, rainfall_r, moisture_t);
        assignFlow(mesh, riversParam, t_order, elevation_t, moisture_t, s_downslope_t, flow_t, flow_s);
    }
}


let queue = new FlatQueue<number>();
/**
 * Use prioritized graph exploration to assign river flow direction
 *
 * t_order will be pre-order in which the graph was traversed, so
 * roots of the tree always get visited before leaves; use reverse to
 * visit leaves before roots
 */
function assignDownslope(mesh: Mesh, elevation_t: Float32Array, /* out */ s_downslope_t: Int32Array, /* out */ t_order: Int32Array) {
    /* Use a priority queue, starting with the ocean triangles and
     * moving upwards using elevation as the priority, to visit all
     * the land triangles */
    let {numTriangles} = mesh,
        queue_in = 0;
    s_downslope_t.fill(-999);
    /* Part 1: non-shallow ocean triangles get downslope assigned to the lowest neighbor */
    for (let t = 0; t < numTriangles; t++) {
        if (elevation_t[t] < -0.1) {
            let s_best = -1, e_best = elevation_t[t];
            for (let j = 0; j < 3; j++) {
                let s = 3 * t + j,
                e = elevation_t[mesh.t_outer_s(s)];
                if (e < e_best) {
                    e_best = e;
                    s_best = s;
                }
            }
            t_order[queue_in++] = t;
            s_downslope_t[t] = s_best;
            queue.push(t, elevation_t[t]);
        }
    }
    /* Part 2: land triangles get visited in elevation priority */
    for (let queue_out = 0; queue_out < numTriangles; queue_out++) {
        let t_current = queue.pop();
        for (let j = 0; j < 3; j++) {
            let s = 3 * t_current + j;
            let t_neighbor = mesh.t_outer_s(s); // uphill from t_current
            if (s_downslope_t[t_neighbor] === -999) {
                s_downslope_t[t_neighbor] = mesh.s_opposite_s(s);
                t_order[queue_in++] = t_neighbor;
                queue.push(t_neighbor, elevation_t[t_neighbor]);
            }
        }
    }
}


function assignMoisture(mesh: Mesh, rainfall_r: Float32Array, /* out */ moisture_t: Float32Array) {
    const {numTriangles} = mesh;
    for (let t = 0; t < numTriangles; t++) {
        let moisture = 0.0;
        for (let i = 0; i < 3; i++) {
            let s = 3 * t + i,
                r = mesh.r_begin_s(s);
            moisture += rainfall_r[r] / 3;
        }
        moisture_t[t] = moisture;
    }
}


function assignFlow(mesh: Mesh, riversParam: any, t_order: Int32Array, elevation_t: Float32Array, moisture_t: Float32Array, s_downslope_t: Int32Array, /* out */ flow_t: Float32Array, /* out */ flow_s: Float32Array) {
    let {numTriangles, _halfedges} = mesh;
    flow_s.fill(0);
    for (let t = 0; t < numTriangles; t++) {
        if (elevation_t[t] >= 0.0) {
            flow_t[t] = riversParam.flow * moisture_t[t] * moisture_t[t];
        } else {
            flow_t[t] = 0;
        }
    }
    for (let i = t_order.length-1; i >= 0; i--) {
        let t_tributary = t_order[i];
        let s_flow = s_downslope_t[t_tributary];
        if (s_flow >= 0) {
            let t_trunk = (_halfedges[s_flow] / 3) | 0;
            flow_t[t_trunk] += flow_t[t_tributary];
            flow_s[s_flow] += flow_t[t_tributary]; // TODO: flow_s[s_downslope_t[t]] === flow_t[t]; redundant?
            if (elevation_t[t_trunk] > elevation_t[t_tributary] && elevation_t[t_tributary] >= 0.0) {
                elevation_t[t_trunk] = elevation_t[t_tributary];
            }
        }
    }
}
