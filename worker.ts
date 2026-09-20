/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2018 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * This module runs the worker thread that calculates the map data.
 * The world is generated tile by tile (quadtree LOD); each tile gets its
 * own TriangleMesh + Map, generated lazily when the viewport needs it.
 */

import MapGen from "./map.ts";
import Geometry from "./geometry.ts";
import {makeTileMesh} from "./tile-mesh.ts";
import {generateMountainPeaks} from "./generate-points.ts";
import {serializeMesh} from "./mesh-extras.ts";
import type {Mesh} from "./types.d.ts";

// NOTE: Typescript workaround https://github.com/Microsoft/TypeScript/issues/20595
const worker: Worker = self as any;

// worker-side configuration and caches
let worldWidth = 4000, worldHeight = 2000, baseSpacing = 5.5, mountainSpacing = 35, meshSeed = 12345;
let spacingFactor = 2, riverFlowExponent = 2, referenceSpacing = 22;
let localRivers = true;
let mountainPeaks: Float32Array = new Float32Array(0);
// meshKey ("lod|tx|ty") -> {mesh, t_peaks}
const meshes = new globalThis.Map<string, {mesh: Mesh; t_peaks: number[]}>();
// mapKey ("scene|lod|tx|ty") -> Map
const maps = new globalThis.Map<string, MapGen>();

const mapKey = (scene: string, lod: number, tx: number, ty: number) => `${scene}|${lod}|${tx}|${ty}`;

//////////////////////////////////////////////////////////////////////
// World-level reference field
//
// Rivers and rainfall propagate across the whole map, but tiles only
// contain a local window, so per-tile computation breaks both at tile
// seams (rivers stop, biome colors jump). The reference field is a
// coarse whole-world Map (one tile's worth of cells) on which flow and
// rainfall are computed globally; fine tiles then:
//   1. sample rainfall_r from the nearest coarse region (seamless,
//      LOD-independent biome colors), and
//   2. seed the flow of apron triangles with the reference flow at
//      their position, scaled by (refSpacing/spacing)^2 because flow
//      accumulates as 1/spacing^2 — so rivers entering a tile bring
//      their upstream water with them and cross the seam.
// The field is rebuilt only when refVersion (sent with each genTile)
// changes; the main thread keeps the version stable while the brush is
// moving so painting rounds reuse the cached field.

type PointLookup = {
    cell: number;
    width: number;
    buckets: globalThis.Map<number, number[]>;
};

type RefField = {
    version: number;
    spacing: number;
    minFlow: number;   // river visibility threshold at the reference LOD
    // flow lookup over coarse land triangle centroids
    triX: Float32Array; triY: Float32Array; triFlow: Float32Array;
    triLookup: PointLookup;
    // river channel lookup: coarse triangles whose flow makes them
    // visible rivers — used to carve valleys into fine-tile elevation
    // so every LOD routes the trunk rivers along the same course
    chX: Float32Array; chY: Float32Array; chFlow: Float32Array;
    chLookup: PointLookup;
    // rainfall lookup over coarse region positions
    regX: Float32Array; regY: Float32Array; regRain: Float32Array;
    regLookup: PointLookup;
};

const references = new globalThis.Map<string, RefField>();

function buildPointLookup(cell: number, xs: Float32Array, ys: Float32Array): PointLookup {
    const width = Math.ceil(worldWidth / cell) + 2;
    const buckets = new globalThis.Map<number, number[]>();
    for (let i = 0; i < xs.length; i++) {
        const key = Math.floor(ys[i] / cell) * width + Math.floor(xs[i] / cell);
        let arr = buckets.get(key);
        if (!arr) { arr = []; buckets.set(key, arr); }
        arr.push(i);
    }
    return {cell, width, buckets};
}

function nearestIndex(lookup: PointLookup, xs: Float32Array, ys: Float32Array, x: number, y: number): number {
    const cx = Math.floor(x / lookup.cell), cy = Math.floor(y / lookup.cell);
    let best = -1, bestD = Infinity;
    for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
            const arr = lookup.buckets.get((cy + dy) * lookup.width + (cx + dx));
            if (!arr) continue;
            for (const i of arr) {
                const ddx = x - xs[i], ddy = y - ys[i];
                const d = ddx*ddx + ddy*ddy;
                if (d < bestD) { bestD = d; best = i; }
            }
        }
    }
    return best;
}

function buildReference(version: number, param: any, constraints: any): RefField {
    const start = performance.now();
    let mm = meshes.get('ref');
    if (!mm) {
        const r = makeTileMesh(meshSeed, referenceSpacing, mountainSpacing,
                               [0, 0, worldWidth, worldHeight], mountainPeaks);
        mm = {mesh: r.mesh, t_peaks: r.t_peaks};
        meshes.set('ref', mm);
    }
    const {mesh} = mm;
    const refMap = new MapGen(mesh, mm.t_peaks, {...param, spacing: referenceSpacing}, mountainPeaks);
    refMap.assignElevation(param.elevation, constraints);
    if (param.biomes?.constantRainfall == null) {
        refMap.assignRainfall(param.biomes);
    } else {
        /* constant-rainfall mode: skip the wind/rain-shadow simulation and
         * fill the world with one uniform moisture value (see config.js
         * biomes.constantRainfall) */
        refMap.rainfall_r.fill(param.biomes.constantRainfall);
    }
    if (localRivers) refMap.assignRivers(param.rivers);

    /* flow lookup: land triangles only (ocean flow is always 0) */
    const minFlow = Math.exp(param.rivers.lg_min_flow
        + riverFlowExponent * Math.log2(baseSpacing / referenceSpacing));
    const triX = new Float32Array(mesh.numSolidTriangles), triY = new Float32Array(mesh.numSolidTriangles), triFlow = new Float32Array(mesh.numSolidTriangles);
    const chX = new Float32Array(mesh.numSolidTriangles), chY = new Float32Array(mesh.numSolidTriangles), chFlow = new Float32Array(mesh.numSolidTriangles);
    let nt = 0, nc = 0;
    if (localRivers) {
        for (let t = 0; t < mesh.numSolidTriangles; t++) {
            if (refMap.elevation_t[t] < 0.0) continue;
            const x = mesh.x_of_t(t), y = mesh.y_of_t(t), flow = refMap.flow_t[t];
            triX[nt] = x; triY[nt] = y; triFlow[nt] = flow;
            nt++;
            if (flow >= minFlow) {
                chX[nc] = x; chY[nc] = y; chFlow[nc] = flow;
                nc++;
            }
        }
    }
    /* rainfall lookup: solid regions */
    const regX = new Float32Array(mesh.numSolidRegions), regY = new Float32Array(mesh.numSolidRegions), regRain = new Float32Array(mesh.numSolidRegions);
    let nr = 0;
    for (let r = 0; r < mesh.numRegions; r++) {
        if (mesh.is_ghost_r(r)) continue;
        regX[nr] = mesh.x_of_r(r); regY[nr] = mesh.y_of_r(r); regRain[nr] = refMap.rainfall_r[r];
        nr++;
    }
    const cell = 4 * referenceSpacing;
    console.log(`reference field rebuilt (version ${version}) in ${(performance.now() - start).toFixed(0)}ms`);
    return {
        version, spacing: referenceSpacing, minFlow,
        triX: triX.subarray(0, nt), triY: triY.subarray(0, nt), triFlow: triFlow.subarray(0, nt),
        triLookup: buildPointLookup(cell, triX, triY),
        chX: chX.subarray(0, nc), chY: chY.subarray(0, nc), chFlow: chFlow.subarray(0, nc),
        chLookup: buildPointLookup(cell, chX, chY),
        regX: regX.subarray(0, nr), regY: regY.subarray(0, nr), regRain: regRain.subarray(0, nr),
        regLookup: buildPointLookup(cell, regX, regY),
    };
}

/* Carve the reference river channels into the tile's elevation as
 * shallow valleys. Without this, each LOD's own downslope routing can
 * send a trunk river down a completely different course (e.g. N-S
 * zoomed out, E-W zoomed in) wherever the terrain is flat enough that
 * mesh-resolution noise decides the downhill direction. The carve is a
 * pure function of world position, so it is seamless across tiles and
 * stable across LODs; tributaries below the channel threshold stay
 * free-form. */
const CARVE_RADIUS = 1.5;  /* channel half-width, in reference spacings */
const CARVE_DEPTH = 0.06;  /* max elevation drop at the channel center */
const CARVE_FLOOR = 0.005; /* never carve land below the waterline */
const CARVE_MAX_ELEV = 0.3;/* mountains are exempt: the coarse reference
                              misroutes water along ridge crests, and
                              carving/importing that into the fine mesh
                              etches rivers onto the peaks. Above this
                              elevation rivers form locally instead. */
function applyRiverCarve(map: MapGen, ref: RefField) {
    const {mesh, elevation_t} = map;
    const radius = CARVE_RADIUS * ref.spacing;
    for (let t = 0; t < mesh.numSolidTriangles; t++) {
        let e = elevation_t[t];
        if (e <= 0 || e > CARVE_MAX_ELEV) continue;
        const i = nearestIndex(ref.chLookup, ref.chX, ref.chY, mesh.x_of_t(t), mesh.y_of_t(t));
        if (i < 0) continue;
        const d = Math.hypot(mesh.x_of_t(t) - ref.chX[i], mesh.y_of_t(t) - ref.chY[i]);
        if (d >= radius) continue;
        /* larger rivers carve deeper; weight ramps in smoothly above
         * the visibility threshold. Quadratic falloff keeps the valley
         * narrow so it guides routing without washing out the land. */
        const flowWeight = Math.min(1, Math.log(ref.chFlow[i] / ref.minFlow) / 3);
        const falloff = 1 - d / radius;
        e = Math.max(CARVE_FLOOR, e - CARVE_DEPTH * flowWeight * falloff * falloff);
        elevation_t[t] = e;
    }
    map.assignRegionElevation();
}

/* Fill the tile map's rainfall_r from the reference field (replaces the
 * tile-local assignRainfall). Runs regardless of the local river chain —
 * this is what keeps biome colors seamless across tiles and LODs. */
function applyReferenceRainfall(map: MapGen, ref: RefField) {
    const {mesh} = map;
    for (let r = 0; r < mesh.numRegions; r++) {
        if (mesh.is_ghost_r(r)) { map.rainfall_r[r] = 0; continue; }
        const i = nearestIndex(ref.regLookup, ref.regX, ref.regY, mesh.x_of_r(r), mesh.y_of_r(r));
        map.rainfall_r[r] = i >= 0 ? ref.regRain[i] : 0;
    }
}

/* Build the apron external-flow seed: triangles outside the tile's
 * interior rect start with the reference flow at their position so
 * rivers entering a tile bring their upstream water across the seam. */
function buildExternalFlow(map: MapGen, ref: RefField, spacing: number, rect: number[]): Float32Array {
    const {mesh} = map;
    const flowScale = (ref.spacing / spacing) * (ref.spacing / spacing);
    const externalFlow_t = new Float32Array(mesh.numTriangles);
    const [x0, y0, w, h] = rect;
    for (let t = 0; t < mesh.numSolidTriangles; t++) {
        const x = mesh.x_of_t(t), y = mesh.y_of_t(t);
        if (x >= x0 && x < x0 + w && y >= y0 && y < y0 + h) continue; // interior: local accumulation only
        if (map.elevation_t[t] > CARVE_MAX_ELEV) continue; // mountains: no imported flow (see applyRiverCarve)
        const i = nearestIndex(ref.triLookup, ref.triX, ref.triY, x, y);
        if (i >= 0) externalFlow_t[t] = ref.triFlow[i] * flowScale;
    }
    return externalFlow_t;
}

function handleInit(event) {
    const d = event.data;
    worldWidth = d.world?.width ?? d.world?.size ?? worldWidth;
    worldHeight = d.world?.height ?? d.world?.size ?? worldHeight;
    baseSpacing = d.world?.baseSpacing ?? baseSpacing;
    mountainSpacing = d.world?.mountainSpacing ?? mountainSpacing;
    meshSeed = d.meshSeed ?? meshSeed;
    spacingFactor = d.lod?.spacingFactor ?? spacingFactor;
    riverFlowExponent = d.lod?.riverFlowExponent ?? riverFlowExponent;
    referenceSpacing = d.lod?.referenceSpacing ?? baseSpacing * spacingFactor * spacingFactor;
    localRivers = d.lod?.localRivers ?? true;
    mountainPeaks = generateMountainPeaks(meshSeed, mountainSpacing, worldWidth, worldHeight);
    worker.postMessage({type: 'initDone'});
}

/* The per-tile assign chain: country/elevation/city/object/terrain
 * constraints, reference rainfall, and (when enabled) the local river
 * chain. Returns the LOD-scaled rivers param for river geometry rendering. */
function assignTile(map: MapGen, param: any, constraints: any, ref: RefField, spacing: number, rect: any, genRect: any) {
    map.assignCountries(constraints.country, constraints.sizeW, constraints.sizeH);
    map.assignElevation(param.elevation, constraints);
    if (localRivers) applyRiverCarve(map, ref); // lock trunk rivers to the same course at every LOD
    map.assignCity(constraints.city, constraints.sizeW, constraints.sizeH, param.city?.autoLayout ?? true);
    map.assignObjects(constraints.objects, constraints.sizeW, constraints.sizeH);
    map.assignTerrain(constraints.terrain, constraints.sizeW, constraints.sizeH);
    // Rainfall comes from the world-level reference field (seamless);
    // the tile-local assignRainfall is only used on the reference itself.
    applyReferenceRainfall(map, ref);

    // River threshold layering: flow accumulates as 1/spacing^2, so the
    // minimum-flow cutoff is scaled per LOD so the same physical rivers
    // stay visible across LODs while fine tributaries only appear zoomed in.
    const riversParam = {...param.rivers,
        lg_min_flow: param.rivers.lg_min_flow + riverFlowExponent * Math.log2(baseSpacing / spacing)};
    if (localRivers) {
        const externalFlow_t = buildExternalFlow(map, ref, spacing, rect ?? genRect);
        map.assignRivers(riversParam, externalFlow_t);
    }
    return riversParam;
}

function handleGenTile(event) {
    const {key, scene, lod, tx, ty, rect, genRect, refVersion, param, constraints, needsMesh} = event.data;
    const spacing = baseSpacing * Math.pow(spacingFactor, -lod);

    // Reference field: rebuild only when the main thread bumped the version.
    let ref = references.get(scene);
    if (!ref || ref.version !== refVersion) {
        ref = buildReference(refVersion ?? 0, param, constraints);
        references.set(scene, ref);
    }

    // Build or reuse the tile mesh (shared across scenes).
    const meshKey = `${lod}|${tx}|${ty}`;
    let mm = meshes.get(meshKey);
    if (!mm) {
        const r = makeTileMesh(meshSeed, spacing, mountainSpacing, genRect, mountainPeaks);
        mm = {mesh: r.mesh, t_peaks: r.t_peaks};
        meshes.set(meshKey, mm);
    }

    // Build or reuse the scene's Map for this tile.
    const mk = mapKey(scene, lod, tx, ty);
    let map = maps.get(mk);
    if (!map) {
        map = new MapGen(mm.mesh, mm.t_peaks, {...param, spacing}, mountainPeaks);
        maps.set(mk, map);
    }

    const quad_elements = new Int32Array(3 * mm.mesh.numSolidSides);
    const a_quad_em = new Float32Array(7 * (mm.mesh.numRegions + mm.mesh.numTriangles));
    const numRiverVertices = 1.5 * 3 * mm.mesh.numSolidTriangles;
    const a_river_xyww = new Float32Array(numRiverVertices * 5);

    const start_time = performance.now();

    const riversParam = assignTile(map, param, constraints, ref, spacing, rect, genRect);
    Geometry.setMapGeometry(map, param.elevation.mountain_folds, quad_elements, a_quad_em);
    const numRiverTriangles = localRivers
        ? Geometry.setRiverGeometry(map, spacing, riversParam, a_river_xyww)
        : 0;

    const elapsed = performance.now() - start_time;

    // The mesh for a tile key never changes (cached above by meshKey), so it
    // is serialized back only when the main thread doesn't have it yet;
    // regenerations ship just the map arrays. This keeps painting strokes
    // from paying a ~1.4MB clone + full mesh deserialization per tile per
    // round on the main thread.
    const mesh = needsMesh ? serializeMesh(mm.mesh) : undefined;
    const transferables = [
        quad_elements.buffer,
        a_quad_em.buffer,
        a_river_xyww.buffer,
        // NOTE: mesh triangles/halfedges are intentionally NOT transferred —
        // they are cached on this side and reused for every regeneration.
        // (points IS fresh, so it can go zero-copy.)
    ];
    if (mesh) transferables.push(mesh.points.buffer);
    worker.postMessage({
        type: 'tileReady',
        key, scene, lod, tx, ty,
        mesh,
        quad_elements, a_quad_em, a_river_xyww,
        numRiverTriangles,
        elapsed,
    }, transferables);
}

let handler = (event) => {
    const d = event.data;
    if (d.type === 'init') {
        handleInit(event);
    } else if (d.type === 'genTile') {
        handleGenTile(event);
    }
};

globalThis.onmessage = event => handler(event);
