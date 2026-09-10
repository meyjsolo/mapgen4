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
let worldSize = 4000, baseSpacing = 5.5, mountainSpacing = 35, meshSeed = 12345;
let spacingFactor = 2, riverFlowExponent = 2;
let mountainPeaks: Float32Array = new Float32Array(0);
// meshKey ("lod|tx|ty") -> {mesh, t_peaks}
const meshes = new globalThis.Map<string, {mesh: Mesh; t_peaks: number[]}>();
// mapKey ("scene|lod|tx|ty") -> Map
const maps = new globalThis.Map<string, MapGen>();

const mapKey = (scene: string, lod: number, tx: number, ty: number) => `${scene}|${lod}|${tx}|${ty}`;

function handleInit(event) {
    const d = event.data;
    worldSize = d.world?.size ?? worldSize;
    baseSpacing = d.world?.baseSpacing ?? baseSpacing;
    mountainSpacing = d.world?.mountainSpacing ?? mountainSpacing;
    meshSeed = d.meshSeed ?? meshSeed;
    spacingFactor = d.lod?.spacingFactor ?? spacingFactor;
    riverFlowExponent = d.lod?.riverFlowExponent ?? riverFlowExponent;
    mountainPeaks = generateMountainPeaks(meshSeed, mountainSpacing, worldSize);
    worker.postMessage({type: 'initDone'});
}

function handleGenTile(event) {
    const {key, scene, lod, tx, ty, genRect, param, constraints} = event.data;
    const spacing = baseSpacing * Math.pow(spacingFactor, -lod);

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
    const a_river_xyww = new Float32Array(numRiverVertices * 4);

    const start_time = performance.now();

    map.assignCountries(constraints.country, constraints.size);
    map.assignElevation(param.elevation, constraints);
    map.assignCity(constraints.city, constraints.size);
    map.assignObjects(constraints.objects, constraints.size);
    map.assignTerrain(constraints.terrain, constraints.size);
    map.assignRainfall(param.biomes);

    // River threshold layering: flow accumulates as 1/spacing^2, so the
    // minimum-flow cutoff is scaled per LOD so the same physical rivers
    // stay visible across LODs while fine tributaries only appear zoomed in.
    const riversParam = {...param.rivers,
        lg_min_flow: param.rivers.lg_min_flow + riverFlowExponent * Math.log2(baseSpacing / spacing)};
    map.assignRivers(riversParam);
    Geometry.setMapGeometry(map, param.elevation.mountain_folds, quad_elements, a_quad_em);
    const numRiverTriangles = Geometry.setRiverGeometry(map, spacing, riversParam, a_river_xyww);

    const elapsed = performance.now() - start_time;

    const mesh = serializeMesh(mm.mesh);
    const transferables = [
        quad_elements.buffer,
        a_quad_em.buffer,
        a_river_xyww.buffer,
        // NOTE: mesh arrays are intentionally NOT transferred — they are
        // cached on this side and reused for every regeneration.
    ];
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
